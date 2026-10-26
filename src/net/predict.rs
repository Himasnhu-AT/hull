//! Client-side prediction and server reconciliation (registered with
//! [`super::NetAppExt::predict`]).
//!
//! ```text
//! client tick T:  LocalInput<I> → InputBuffer[T] → NetInput<I> on Predicted entity → step(S) → history[T]
//!                 send inputs T, T-1, … (redundant, unreliable)
//! server tick T:  inputs[client][T] (or repeat last) → NetInput<I> on owned entities → step(S) → snapshot S_T
//! client, on S_T: history[T] == S_T (compared in wire encoding)? nothing to do :
//!                 S = S_T, replay step(S, input[t]) for t in T+1..=now, rewrite history
//! ```
//! `step` must be a pure function of (state, input, dt) for replays to match; it runs with the
//! nominal tick `dt` on both sides.

use std::collections::VecDeque;

use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use bevy::ptr::Ptr;
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::connection::ch;
use super::endpoint::ClientId;
use super::registry::{Confirmed, NetOwner, NetRegistry, postcard_decode, postcard_encode};
use super::wire::{Put, Reader, WireResult};
use super::{NetClient, NetClock, NetConfig, NetRole, NetServer, NetSet, Predicted};

/// The local player's input for the current tick. The game writes it (e.g. in `Update`); the
/// engine stamps it with the tick, buffers it, predicts with it and sends it to the server.
#[derive(Resource, Clone, Debug, Default)]
pub struct LocalInput<I>(pub I);

/// The input an entity simulates with this tick (server: its owner's; client: the local one).
#[derive(Component, Clone, Debug, Default)]
pub struct NetInput<I>(pub I);

/// Predicted states by tick (client, `Predicted` entities).
#[derive(Component, Debug)]
pub struct PredictionHistory<S> {
    pub states: VecDeque<(u32, S)>,
}

impl<S> Default for PredictionHistory<S> {
    fn default() -> Self {
        PredictionHistory { states: VecDeque::with_capacity(64) }
    }
}

/// Prediction counters (client) and input health (server).
#[derive(Resource, Clone, Copy, Debug, Default, serde::Serialize)]
pub struct PredictionStats {
    /// Server states checked against history.
    pub checks: u64,
    /// Mismatches → rollback + replay.
    pub rollbacks: u64,
    pub replayed_ticks: u64,
    /// Server: inputs that arrived after their tick was simulated.
    pub inputs_late: u64,
    /// Server: ticks simulated without that tick's input (last input repeated).
    pub inputs_missing: u64,
}

/// Client: inputs by tick (newest last).
#[derive(Resource)]
pub struct InputBuffer<I> {
    pub inputs: VecDeque<(u32, I)>,
}

impl<I> Default for InputBuffer<I> {
    fn default() -> Self {
        InputBuffer { inputs: VecDeque::with_capacity(256) }
    }
}

impl<I: Clone + Default> InputBuffer<I> {
    /// Input of `tick`, else the newest one before it.
    pub fn get(&self, tick: u32) -> I {
        self.inputs.iter().rev().find(|(t, _)| *t <= tick).map(|(_, i)| i.clone()).unwrap_or_default()
    }
}

struct ClientInputs<I> {
    queue: VecDeque<(u32, I)>,
    current: I,
}

/// Server: per-client input queues.
#[derive(Resource)]
pub(crate) struct ServerInputs<I> {
    clients: HashMap<ClientId, ClientInputs<I>>,
}

impl<I> Default for ServerInputs<I> {
    fn default() -> Self {
        ServerInputs { clients: HashMap::default() }
    }
}

type InputDecoder = fn(&mut World, ClientId, &mut Reader) -> WireResult<()>;

#[derive(Resource, Default)]
pub(crate) struct InputDecoders(pub Vec<InputDecoder>);

pub(crate) fn dispatch_input(world: &mut World, from: ClientId, bytes: &[u8]) {
    let mut r = Reader::new(bytes);
    let Ok(kind) = r.var() else { return };
    let Some(d) = world.resource::<InputDecoders>().0.get(kind as usize).copied() else { return };
    let _ = d(world, from, &mut r);
}

fn decode_input<I: DeserializeOwned + Clone + Default + Send + Sync + 'static>(world: &mut World, from: ClientId, r: &mut Reader) -> WireResult<()> {
    let newest = r.var_u32()?;
    let view = r.var()? as f64 / 16.0;
    world.resource_mut::<super::LagCompensation>().set_view(from, view);
    let n = r.var()?.min(64);
    let server_tick = world.resource::<NetClock>().tick;
    let mut late = 0;
    let mut si = world.resource_mut::<ServerInputs<I>>();
    let ci = si.clients.entry(from).or_insert_with(|| ClientInputs { queue: VecDeque::new(), current: I::default() });
    for k in 0..n as u32 {
        let input: I = postcard_decode(r)?;
        let Some(tick) = newest.checked_sub(k) else { break };
        if tick <= server_tick {
            if k == 0 {
                late += 1;
            }
            continue; // already simulated
        }
        // Keep the queue sorted and unique.
        match ci.queue.iter().position(|(t, _)| *t >= tick) {
            Some(p) if ci.queue[p].0 == tick => {}
            Some(p) => ci.queue.insert(p, (tick, input)),
            None => ci.queue.push_back((tick, input)),
        }
    }
    while ci.queue.len() > 128 {
        ci.queue.pop_front();
    }
    world.resource_mut::<PredictionStats>().inputs_late += late;
    Ok(())
}

pub(crate) fn add_input<I: Serialize + DeserializeOwned + Clone + Default + Send + Sync + 'static>(app: &mut App) {
    app.init_resource::<LocalInput<I>>()
        .init_resource::<InputBuffer<I>>()
        .init_resource::<ServerInputs<I>>()
        .add_systems(
            FixedPreUpdate,
            (client_input::<I>.run_if(resource_exists::<NetClient>), server_input::<I>.run_if(resource_exists::<NetServer>)).in_set(NetSet::Input),
        );
    app.world_mut().get_resource_or_init::<InputDecoders>().0.push(decode_input::<I>);
}

fn client_input<I: Serialize + Clone + Default + Send + Sync + 'static>(
    mut commands: Commands,
    clock: Res<NetClock>,
    cfg: Res<NetConfig>,
    local: Res<LocalInput<I>>,
    mut buf: ResMut<InputBuffer<I>>,
    reg: Res<NetRegistry>,
    mut client: ResMut<NetClient>,
    mut q: Query<(Entity, Option<&mut NetInput<I>>), With<Predicted>>,
    mut scratch: Local<Vec<u8>>,
) {
    if client.endpoint.conn.is_none() {
        return;
    }
    let tick = clock.tick;
    while buf.inputs.back().is_some_and(|(t, _)| *t >= tick) {
        buf.inputs.pop_back(); // clock resynced backwards
    }
    buf.inputs.push_back((tick, local.0.clone()));
    while buf.inputs.len() > 256 {
        buf.inputs.pop_front();
    }
    for (e, ni) in &mut q {
        match ni {
            Some(mut ni) => ni.0 = local.0.clone(),
            None => {
                commands.entity(e).insert(NetInput(local.0.clone()));
            }
        }
    }
    let Some(kind) = reg.input_kind::<I>() else { return };
    scratch.clear();
    scratch.put_var(u64::from(kind));
    scratch.put_var(u64::from(tick));
    // What we are showing of remote entities, for the server's lag compensation (1/16 tick).
    scratch.put_var((clock.render_tick.max(0.0) * 16.0) as u64);
    let n = (cfg.input_redundancy.max(1) as usize).min(buf.inputs.len());
    scratch.put_var(n as u64);
    for (_, i) in buf.inputs.iter().rev().take(n) {
        postcard_encode(i, &mut scratch);
    }
    let _ = client.endpoint.send(ch::INPUT, &scratch);
}

fn server_input<I: Clone + Default + Send + Sync + 'static>(
    mut commands: Commands,
    clock: Res<NetClock>,
    role: Res<NetRole>,
    local: Option<Res<LocalInput<I>>>,
    server: Res<NetServer>,
    mut si: ResMut<ServerInputs<I>>,
    mut stats: ResMut<PredictionStats>,
    mut q: Query<(Entity, &NetOwner, Option<&mut NetInput<I>>)>,
) {
    let tick = clock.tick;
    si.clients.retain(|id, _| server.endpoint.client(*id).is_some());
    for ci in si.clients.values_mut() {
        while ci.queue.front().is_some_and(|(t, _)| *t < tick) {
            ci.queue.pop_front();
        }
        if ci.queue.front().is_some_and(|(t, _)| *t == tick) {
            ci.current = ci.queue.pop_front().unwrap().1;
        } else {
            stats.inputs_missing += 1;
        }
    }
    for (e, owner, ni) in &mut q {
        let input = if owner.0 == ClientId::HOST {
            if *role != NetRole::ListenServer {
                continue;
            }
            local.as_ref().map(|l| l.0.clone()).unwrap_or_default()
        } else {
            match si.clients.get(&owner.0) {
                Some(ci) => ci.current.clone(),
                None => continue,
            }
        };
        match ni {
            Some(mut ni) => ni.0 = input,
            None => {
                commands.entity(e).insert(NetInput(input));
            }
        }
    }
}

pub(crate) fn add_prediction<S, I>(app: &mut App, step: fn(&mut S, &I, f32))
where
    S: Component<Mutability = bevy::ecs::component::Mutable> + Clone,
    I: Clone + Default + Send + Sync + 'static,
{
    app.add_systems(
        FixedUpdate,
        (
            (move |clock: Res<NetClock>, q: Query<(&mut S, &NetInput<I>), With<NetOwner>>| server_step(clock, q, step))
                .run_if(resource_exists::<NetServer>),
            (move |commands: Commands, clock: Res<NetClock>, q: Query<(Entity, &mut S, &NetInput<I>, Option<&mut PredictionHistory<S>>), With<Predicted>>| {
                client_step(commands, clock, q, step)
            })
            .run_if(resource_exists::<NetClient>),
        )
            .in_set(NetSet::Predict),
    )
    .add_systems(
        PreUpdate,
        (move |clock: Res<NetClock>,
               reg: Res<NetRegistry>,
               inputs: Res<InputBuffer<I>>,
               stats: ResMut<PredictionStats>,
               q: Query<(&mut S, &mut Confirmed<S>, Option<&mut PredictionHistory<S>>), With<Predicted>>,
               scratch: Local<(Vec<u8>, Vec<u8>)>| reconcile(clock, reg, inputs, stats, q, scratch, step))
        .run_if(resource_exists::<NetClient>)
        .in_set(NetSet::Reconcile),
    );
}

fn server_step<S: Component<Mutability = bevy::ecs::component::Mutable>, I: Send + Sync + 'static>(
    clock: Res<NetClock>,
    mut q: Query<(&mut S, &NetInput<I>), With<NetOwner>>,
    step: fn(&mut S, &I, f32),
) {
    for (mut s, i) in &mut q {
        step(&mut s, &i.0, clock.tick_dt);
    }
}

fn client_step<S: Component<Mutability = bevy::ecs::component::Mutable> + Clone, I: Send + Sync + 'static>(
    mut commands: Commands,
    clock: Res<NetClock>,
    mut q: Query<(Entity, &mut S, &NetInput<I>, Option<&mut PredictionHistory<S>>), With<Predicted>>,
    step: fn(&mut S, &I, f32),
) {
    for (e, mut s, i, h) in &mut q {
        step(&mut s, &i.0, clock.tick_dt);
        match h {
            Some(mut h) => {
                while h.states.back().is_some_and(|(t, _)| *t >= clock.tick) {
                    h.states.pop_back();
                }
                h.states.push_back((clock.tick, s.clone()));
                while h.states.len() > 256 {
                    h.states.pop_front();
                }
            }
            None => {
                let mut h = PredictionHistory::default();
                h.states.push_back((clock.tick, s.clone()));
                commands.entity(e).insert(h);
            }
        }
    }
}

fn encode_with<S: Component>(reg: &NetRegistry, v: &S, out: &mut Vec<u8>) {
    out.clear();
    if let Some(i) = reg.index_of::<S>() {
        // SAFETY: rule i's write fn is the one registered for `S`.
        unsafe { (reg.components[i].write)(Ptr::from(v), out) };
    }
}

fn reconcile<S: Component<Mutability = bevy::ecs::component::Mutable> + Clone, I: Clone + Default + Send + Sync + 'static>(
    clock: Res<NetClock>,
    reg: Res<NetRegistry>,
    inputs: Res<InputBuffer<I>>,
    mut stats: ResMut<PredictionStats>,
    mut q: Query<(&mut S, &mut Confirmed<S>, Option<&mut PredictionHistory<S>>), With<Predicted>>,
    mut scratch: Local<(Vec<u8>, Vec<u8>)>,
    step: fn(&mut S, &I, f32),
) {
    let (a, b) = &mut *scratch;
    for (mut s, mut conf, h) in &mut q {
        if !conf.fresh {
            continue;
        }
        conf.fresh = false;
        let Some(mut h) = h else {
            *s = conf.value.clone();
            continue;
        };
        let t = conf.tick;
        // Forget states the server has confirmed past.
        while h.states.front().is_some_and(|(ht, _)| *ht < t) {
            h.states.pop_front();
        }
        stats.checks += 1;
        let matches = match h.states.front() {
            Some((ht, hv)) if *ht == t => {
                encode_with(&reg, hv, a);
                encode_with(&reg, &conf.value, b);
                a == b
            }
            // No prediction for that tick (newer than our history, or history started later).
            _ => false,
        };
        if matches {
            continue;
        }
        stats.rollbacks += 1;
        let mut state = conf.value.clone();
        let newest = h.states.back().map_or(t, |(ht, _)| *ht).max(t);
        h.states.clear();
        h.states.push_back((t, state.clone()));
        let mut tick = t;
        while tick < newest.min(clock.tick) {
            tick += 1;
            step(&mut state, &inputs.get(tick), clock.tick_dt);
            h.states.push_back((tick, state.clone()));
            stats.replayed_ticks += 1;
        }
        *s = state;
    }
}

/// Encode an input the way the client sends it (tests / tools).
pub fn encode_input<I: Serialize>(v: &I, out: &mut Vec<u8>) {
    postcard_encode(v, out);
}
