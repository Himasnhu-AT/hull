//! Client side: connection lifecycle, snapshot apply (entity mapping, per-component stale
//! checks, routing to interpolation / prediction), tick sync and the interpolation clock.
//!
//! Ordering rules that keep a lossy, reordering link consistent with the server's acked view:
//! - each (entity, component) remembers the tick it was last written at; older data is skipped;
//! - a despawn applies only if its tick ≥ the entity's spawn tick; a spawn for an id despawned
//!   at a later tick is ignored (late packet).

use std::collections::VecDeque;

use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::connection::ch;
use super::endpoint::{ClientId, ClientStatus};
use super::registry::{NetId, NetOwner, NetRegistry};
use super::server::{DELTA_WINDOW, KEY_DELTA, KEY_REMOVED};
use super::wire::{Reader, WireResult, byte_undelta};
use super::{Interpolated, NetClient, NetClock, NetConfig, NetEvent, NetState, Predicted, Remote, now};
use crate::flow::AppState;

/// Client replication counters.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct ClientStats {
    pub entities: usize,
    pub parts_received: u64,
    pub entity_updates: u64,
    pub stale_skipped: u64,
    pub spawns: u64,
    pub despawns: u64,
    pub decode_errors: u64,
}

struct RemoteEntity {
    entity: Entity,
    /// Server tick this incarnation became relevant (spawn `since`).
    since: u32,
    comp_ticks: Vec<u32>,
    /// Per component: recent (tick, full encoding) received, baselines for deltas.
    baselines: Vec<VecDeque<(u32, Vec<u8>)>>,
}

impl RemoteEntity {
    fn new(entity: Entity, since: u32, ncomp: usize) -> Self {
        RemoteEntity { entity, since, comp_ticks: vec![0; ncomp], baselines: (0..ncomp).map(|_| VecDeque::new()).collect() }
    }
}

#[derive(Default)]
pub(crate) struct ClientRepl {
    map: HashMap<NetId, RemoteEntity>,
    despawned: HashMap<NetId, u32>,
    latest_tick: Option<u32>,
    latest_recv: f64,
    pub stats: ClientStats,
    was_connected: bool,
    parts: Vec<Vec<u8>>,
    pool: Vec<Vec<u8>>,
    inbox: super::server::Inbox,
    scratch: Vec<u8>,
    pub(crate) keep_baselines: bool,
}

impl ClientRepl {
    pub(crate) fn entity(&self, id: NetId) -> Option<Entity> {
        self.map.get(&id).map(|r| r.entity)
    }
}

/// Despawn every mirrored entity (disconnect).
pub(crate) fn despawn_remotes(world: &mut World, repl: &mut ClientRepl) {
    for (_, r) in repl.map.drain() {
        if let Ok(e) = world.get_entity_mut(r.entity) {
            e.despawn();
        }
    }
}

/// `PreUpdate`: packets in; lifecycle; snapshots applied; messages decoded.
pub(crate) fn receive(world: &mut World) {
    let t = now(world);
    let Some(mut client) = world.remove_resource::<NetClient>() else { return };
    client.endpoint.update(t);
    let drive = world.resource::<NetConfig>().drive_app_state;
    match client.endpoint.status() {
        ClientStatus::Connecting => {}
        ClientStatus::Connected => {
            if client.endpoint.take_just_connected() {
                let id = client.endpoint.id.unwrap();
                info!("net: connected as {id}");
                client.repl.was_connected = true;
                let lead = initial_lead(world, &client);
                let mut clock = world.resource_mut::<NetClock>();
                clock.tick = client.endpoint.accept_tick.wrapping_add(lead);
                clock.server_tick = f64::from(client.endpoint.accept_tick);
                world.write_message(NetEvent::Connected(id));
                world.resource_mut::<NextState<NetState>>().set(NetState::InGame);
                if drive && let Some(mut next) = world.get_resource_mut::<NextState<AppState>>() {
                    next.set(AppState::InGame);
                }
            }
        }
        ClientStatus::Disconnected(reason) => {
            info!("net: disconnected ({reason:?})");
            despawn_remotes(world, &mut client.repl);
            world.write_message(NetEvent::Disconnected(reason));
            world.resource_mut::<NextState<NetState>>().set(NetState::Disconnected);
            *world.resource_mut::<super::NetRole>() = super::NetRole::Offline;
            super::apply_timestep(world);
            if drive && client.repl.was_connected && let Some(mut next) = world.get_resource_mut::<NextState<AppState>>() {
                next.set(AppState::MainMenu);
            }
            return; // NetClient dropped
        }
    }

    let my_id = client.endpoint.id;
    let mut msgs = std::mem::take(&mut client.repl.inbox);
    msgs.clear();
    let mut parts = std::mem::take(&mut client.repl.parts);
    let mut pool = std::mem::take(&mut client.repl.pool);
    if let Some(conn) = client.endpoint.conn.as_mut() {
        conn.drain_received(|c, d| {
            if c == ch::SNAPSHOT {
                let mut b = pool.pop().unwrap_or_default();
                b.clear();
                b.extend_from_slice(d);
                parts.push(b);
            } else {
                msgs.push(ClientId::HOST, c, d);
            }
        });
    }
    let registry = world.remove_resource::<NetRegistry>().unwrap();
    for p in parts.drain(..) {
        match apply_part(world, &registry, &mut client.repl, my_id, &p) {
            Ok(tick) => {
                client.repl.stats.parts_received += 1;
                if client.repl.latest_tick.is_none_or(|l| tick > l) {
                    client.repl.latest_tick = Some(tick);
                    client.repl.latest_recv = t;
                }
            }
            Err(_) => client.repl.stats.decode_errors += 1,
        }
        pool.push(p);
    }
    world.insert_resource(registry);
    client.repl.parts = parts;
    client.repl.pool = pool;
    client.repl.despawned.retain(|_, tk| client.repl.latest_tick.is_none_or(|l| l.saturating_sub(*tk) < 600));
    client.repl.stats.entities = client.repl.map.len();
    sync_clock(world, &client, t);
    world.insert_resource(client);
    for (_, c, d) in msgs.iter() {
        if matches!(c, ch::RELIABLE | ch::UNRELIABLE | ch::SEQUENCED) {
            super::messages::dispatch(world, None, d);
        }
    }
    if let Some(mut c) = world.get_resource_mut::<NetClient>() {
        c.repl.inbox = msgs;
    }
}

fn ticks_of(world: &World, secs: f64) -> f64 {
    secs * world.resource::<NetConfig>().tick_hz
}

fn initial_lead(world: &World, client: &NetClient) -> u32 {
    let cfg = world.resource::<NetConfig>();
    let rtt = client.endpoint.stats().map_or(0.1, |s| f64::from(s.rtt_ms) / 1000.0);
    (ticks_of(world, rtt) + f64::from(cfg.input_lead_ticks)).ceil() as u32
}

/// Estimate the server tick from the newest snapshot; steer the prediction clock (fixed
/// timestep ±10 %) so inputs arrive `input_lead_ticks` early; resync on big jumps.
fn sync_clock(world: &mut World, client: &NetClient, t: f64) {
    let Some(latest) = client.repl.latest_tick else { return };
    let cfg = world.resource::<NetConfig>().clone();
    let rtt = client.endpoint.stats().map_or(0.1, |s| f64::from(s.rtt_ms) / 1000.0);
    let hz = cfg.tick_hz;
    let server_now = f64::from(latest) + (t - client.repl.latest_recv + rtt * 0.5) * hz;
    let overstep = world.resource::<Time<Fixed>>().overstep_fraction_f64();
    let mut clock = world.resource_mut::<NetClock>();
    clock.latest_snapshot = latest;
    // Smooth the server-tick estimate (it jitters with packet arrival).
    let err = server_now - clock.server_tick;
    if clock.server_tick == 0.0 || err.abs() > 10.0 {
        clock.server_tick = server_now;
    } else {
        clock.server_tick += err * 0.1;
    }
    let target = server_now + rtt * 0.5 * hz + f64::from(cfg.input_lead_ticks);
    let predicted = f64::from(clock.tick) + overstep;
    let off = target - predicted;
    let base = 1.0 / hz;
    if off.abs() > 12.0 {
        clock.tick = target.round().max(0.0) as u32;
        clock.resyncs += 1;
        if cfg.set_fixed_timestep {
            world.resource_mut::<Time<Fixed>>().set_timestep_seconds(base);
        }
    } else if cfg.set_fixed_timestep {
        // Behind → shorter ticks (run faster); ahead → longer.
        let k = (off * 0.03).clamp(-0.1, 0.1);
        world.resource_mut::<Time<Fixed>>().set_timestep_seconds(base / (1.0 + k));
    }
}

pub(crate) fn advance_tick(mut clock: ResMut<NetClock>) {
    clock.tick = clock.tick.wrapping_add(1);
}

/// `PostUpdate`: advance the smoothed server tick by frame time; render tick = that − delay.
pub(crate) fn update_render_clock(mut clock: ResMut<NetClock>, time: Res<Time<Real>>, cfg: Res<NetConfig>) {
    if clock.server_tick > 0.0 {
        clock.server_tick += time.delta_secs_f64() * cfg.tick_hz;
    }
    clock.render_tick = clock.server_tick - f64::from(cfg.interpolation_delay_s) * cfg.tick_hz;
}

fn apply_part(world: &mut World, reg: &NetRegistry, repl: &mut ClientRepl, my_id: Option<ClientId>, bytes: &[u8]) -> WireResult<u32> {
    let mut r = Reader::new(bytes);
    let tick = r.var_u32()?;
    let nd = r.var()?;
    for _ in 0..nd {
        let id = NetId(r.var_u32()?);
        let dt = r.var_u32()?;
        if let Some(re) = repl.map.get(&id)
            && dt >= re.since
        {
            let e = re.entity;
            repl.map.remove(&id);
            if let Ok(em) = world.get_entity_mut(e) {
                em.despawn();
            }
            repl.stats.despawns += 1;
        }
        let d = repl.despawned.entry(id).or_insert(dt);
        *d = (*d).max(dt);
    }
    let ncomp = reg.components.len();
    let mut full = std::mem::take(&mut repl.scratch);
    let result = (|| -> WireResult<()> {
        while !r.is_empty() {
            let id = NetId(r.var_u32()?);
            let head = r.var()?;
            let spawn = head & 1 != 0;
            let n = head >> 1;
            let since = if spawn { r.var_u32()? } else { 0 };
            // A spawn with a newer `since` than what we hold is a new incarnation (the entity
            // left relevancy and came back before we saw the despawn): start it fresh.
            if spawn
                && let Some(re) = repl.map.get(&id)
                && since > re.since
            {
                let e = re.entity;
                repl.map.remove(&id);
                if let Ok(em) = world.get_entity_mut(e) {
                    em.despawn();
                }
            }
            let entity = match repl.map.get(&id) {
                Some(re) => Some(re.entity),
                None if spawn && repl.despawned.get(&id).is_none_or(|&dt| since > dt) => {
                    let e = world.spawn((id, Remote, Interpolated)).id();
                    repl.map.insert(id, RemoteEntity::new(e, since, ncomp));
                    repl.stats.spawns += 1;
                    Some(e)
                }
                None => None,
            };
            repl.stats.entity_updates += 1;
            for _ in 0..n {
                let key = r.var()?;
                let idx = (key >> 2) as usize;
                let removed = key & KEY_REMOVED != 0;
                let delta = key & KEY_DELTA != 0;
                let back = if delta { r.var_u32()? } else { 0 };
                let data = if removed { &[][..] } else { r.bytes()? };
                let Some(e) = entity else { continue };
                let Some(rule) = reg.components.get(idx) else { return Err(super::wire::WireError) };
                let re = repl.map.get_mut(&id).unwrap();
                re.comp_ticks.resize(ncomp, 0);
                re.baselines.resize_with(ncomp, VecDeque::new);
                // Full encoding: as sent, or rebuilt from the baseline the server referenced.
                let ring = &mut re.baselines[idx];
                if delta {
                    let base_tick = tick.wrapping_sub(back);
                    let Some((_, b)) = ring.iter().find(|(t, _)| *t == base_tick) else {
                        repl.stats.decode_errors += 1;
                        continue;
                    };
                    byte_undelta(b, data, &mut full)?;
                } else {
                    full.clear();
                    full.extend_from_slice(data);
                }
                if !removed && repl.keep_baselines && !ring.iter().any(|(t, _)| *t == tick) {
                    let newest = ring.back().map_or(tick, |(t, _)| (*t).max(tick));
                    let mut buf = Vec::new();
                    while let Some((t, _)) = ring.front() {
                        if newest.wrapping_sub(*t) > 2 * DELTA_WINDOW || ring.len() >= 128 {
                            buf = ring.pop_front().unwrap().1;
                        } else {
                            break;
                        }
                    }
                    buf.clear();
                    buf.extend_from_slice(&full);
                    let pos = ring.iter().position(|(t, _)| *t > tick).unwrap_or(ring.len());
                    ring.insert(pos, (tick, buf));
                }
                if re.comp_ticks[idx] > tick {
                    repl.stats.stale_skipped += 1;
                    continue;
                }
                re.comp_ticks[idx] = tick;
                let Ok(mut em) = world.get_entity_mut(e) else { continue };
                if removed {
                    (rule.remove)(&mut em);
                    if idx == 0 {
                        em.remove::<Predicted>().insert(Interpolated);
                    }
                    continue;
                }
                let mut cr = Reader::new(&full);
                let predicted = em.contains::<Predicted>();
                if idx == 0 {
                    (rule.apply)(&mut em, &mut cr)?;
                    let mine = my_id.is_some() && em.get::<NetOwner>().map(|o| o.0) == my_id;
                    if mine && !predicted {
                        em.remove::<Interpolated>().insert(Predicted);
                    } else if !mine && predicted {
                        em.remove::<Predicted>().insert(Interpolated);
                    }
                } else if rule.predicted && predicted {
                    (rule.confirm)(&mut em, &mut cr, tick)?;
                } else if rule.interpolated && predicted {
                    // Driven locally by prediction; first value only.
                    if !em.contains_id(rule.component_id) {
                        (rule.apply)(&mut em, &mut cr)?;
                    }
                } else if rule.interpolated {
                    (rule.push_history)(&mut em, &mut cr, tick)?;
                } else {
                    (rule.apply)(&mut em, &mut cr)?;
                }
            }
        }
        Ok(())
    })();
    repl.scratch = full;
    result.map(|_| tick)
}

/// Generic interpolation of `C` on [`Interpolated`] entities at `NetClock::render_tick`.
pub(crate) fn interpolate_system<C: Component<Mutability = bevy::ecs::component::Mutable> + Clone>(
    clock: Res<NetClock>,
    mut q: Query<(&mut C, &super::NetHistory<C>), With<Interpolated>>,
    lerp: fn(&C, &C, f32) -> C,
) {
    let rt = clock.render_tick;
    if rt <= 0.0 {
        return;
    }
    for (mut c, h) in &mut q {
        let s = &h.samples;
        let Some(last) = s.back() else { continue };
        if rt >= f64::from(last.0) || s.len() == 1 {
            // Past the newest sample: hold it (no extrapolation).
            *c = last.1.clone();
            continue;
        }
        let first = s.front().unwrap();
        if rt <= f64::from(first.0) {
            *c = first.1.clone();
            continue;
        }
        // Newest pair bracketing rt.
        let mut i = s.len() - 1;
        while i > 0 && f64::from(s[i - 1].0) > rt {
            i -= 1;
        }
        let (ta, a) = &s[i - 1];
        let (tb, b) = &s[i];
        let f = ((rt - f64::from(*ta)) / f64::from(tb - ta).max(1.0)) as f32;
        *c = lerp(a, b, f.clamp(0.0, 1.0));
    }
}
