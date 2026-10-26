//! Server side: receive, `NetId` assignment, and per-client delta snapshots.
//!
//! Each snapshot tick the server re-serialises the replicated components that changed (Bevy
//! change ticks; the bytes are shared by all clients) and bumps a per-component version when
//! the bytes differ. Per client it remembers the newest version the client *acked* (snapshot
//! parts are ack-tracked unreliable messages), and sends only components whose version
//! differs: unchanged state costs nothing, lost packets are healed by the next snapshot,
//! nothing waits on resends.
//!
//! Then per client: relevancy (radius around the client's viewpoint, hysteresis 10 %),
//! priority accumulation (weight × distance falloff, reset when sent) and a byte budget
//! (`snapshot_bytes_per_tick` and the link's bandwidth). Parts are ≤ one packet so a loss only
//! costs the entities in it.
//!
//! Changed components are sent as a byte delta against the client's newest acked value of
//! that component when that is ≤ `DELTA_WINDOW` ticks old (`NetConfig::delta_compression`);
//! both sides keep those baselines.
//!
//! Data layout: replicated entities live in stable slots (free list); each client keeps a dense
//! `Vec<Option<PerEntity>>` by slot, so the per-client pass does no hashing.
//!
//! Snapshot part (channel SNAPSHOT):
//! ```text
//! varint tick | varint n_despawns {varint net_id, varint tick} |
//! entity* { varint net_id | varint n_comps<<1 | spawn [, varint since (spawn)] |
//!           comp* { varint idx<<2 | delta<<1 | removed  [, varint ticks_back (delta)] [, varint len, bytes] } }
//! ```

use std::collections::VecDeque;
use std::time::Instant;

use bevy::ecs::change_detection::Tick;
use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::connection::ch;
use super::endpoint::{ClientId, ServerEvent};
use super::registry::{NetId, NetOwner, NetRegistry};
use super::wire::{Put, Reader, byte_delta, var_len};
use super::{AlwaysRelevant, NetClock, NetConfig, NetEvent, NetPriority, NetServer, NetViewer, Replicated, now};

const SENT_RING: usize = 512;
pub(crate) const KEY_REMOVED: u64 = 1;
pub(crate) const KEY_DELTA: u64 = 2;
/// Baselines older than this many ticks are not used (clients keep 2× that).
pub(crate) const DELTA_WINDOW: u32 = 60;
/// Versions kept per component for delta baselines.
const HISTORY: usize = 64;

/// Server replication counters.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct ServerStats {
    pub replicated_entities: usize,
    pub clients: usize,
    /// Wall time of the last snapshot pass (all clients), microseconds.
    pub snapshot_us: f32,
    /// Bytes of snapshot payload written in the last pass (all clients).
    pub snapshot_bytes: usize,
    /// Entity updates written in the last pass (all clients).
    pub entity_updates: usize,
    pub parts: usize,
    /// Components re-serialised because Bevy saw them change (last pass).
    pub serialized_components: usize,
    /// …of which really changed bytes (new versions).
    pub changed_components: usize,
}

struct CompCache {
    present: bool,
    version: u32,
    bytes: Vec<u8>,
    /// Recent (version, bytes), baselines for delta encoding (buffers recycled).
    history: VecDeque<(u32, Vec<u8>)>,
}

impl CompCache {
    fn new() -> Self {
        CompCache { present: false, version: 0, bytes: Vec::new(), history: VecDeque::new() }
    }
}

struct Cached {
    net_id: NetId,
    pos: Vec3,
    owner: Option<ClientId>,
    priority: f32,
    always: bool,
    viewer: bool,
    seen: bool,
    comps: Vec<CompCache>,
}

struct PerEntity {
    net_id: NetId,
    since: u32,
    spawn_acked: bool,
    /// Per component: newest acked (version, tick of the part that carried it).
    acked: Vec<(u32, u32)>,
    accum: f32,
}

#[derive(Default)]
struct SentEntity {
    net_id: NetId,
    slot: u32,
    spawn: bool,
    first: u32,
    count: u32,
}

#[derive(Default)]
struct SentPart {
    token: Option<u32>,
    tick: u32,
    entities: Vec<SentEntity>,
    comps: Vec<(u16, u32)>,
    despawns: Vec<NetId>,
}

pub(crate) struct ClientView {
    /// By cache slot.
    entities: Vec<Option<PerEntity>>,
    despawns: Vec<(NetId, u32)>,
    sent: Vec<SentPart>,
    viewpoint: Option<Vec3>,
    viewpoint_override: Option<Vec3>,
}

impl ClientView {
    fn new() -> Self {
        ClientView {
            entities: Vec::new(),
            despawns: Vec::new(),
            sent: (0..SENT_RING).map(|_| SentPart::default()).collect(),
            viewpoint: None,
            viewpoint_override: None,
        }
    }
}

pub(crate) struct ServerRepl {
    next_id: u32,
    ncomp: usize,
    /// Stable slots; `None` = free.
    cache: Vec<Option<Cached>>,
    free: Vec<u32>,
    index: HashMap<NetId, u32>,
    clients: HashMap<ClientId, ClientView>,
    scratch: Vec<u8>,
    ent: Vec<u8>,
    part: Vec<u8>,
    candidates: Vec<(f32, u32)>,
    owner_only: Vec<bool>,
    tokens: Vec<u32>,
    inbox: Inbox,
    client_ids: Vec<ClientId>,
    /// World change tick at the end of the previous pass (change detection).
    last_tick: Option<Tick>,
    pub stats: ServerStats,
}

impl ServerRepl {
    pub(crate) fn new(ncomp: usize) -> Self {
        ServerRepl {
            next_id: 1,
            ncomp,
            cache: Vec::new(),
            free: Vec::new(),
            index: HashMap::default(),
            clients: HashMap::default(),
            scratch: Vec::new(),
            ent: Vec::new(),
            part: Vec::new(),
            candidates: Vec::new(),
            owner_only: Vec::new(),
            tokens: Vec::new(),
            inbox: Inbox::default(),
            client_ids: Vec::new(),
            last_tick: None,
            stats: ServerStats::default(),
        }
    }

    pub(crate) fn set_viewpoint(&mut self, client: ClientId, at: Option<Vec3>) {
        if let Some(v) = self.clients.get_mut(&client) {
            v.viewpoint_override = at;
        }
    }

    pub(crate) fn known_by(&self, client: ClientId) -> usize {
        self.clients.get(&client).map_or(0, |v| v.entities.iter().flatten().filter(|e| e.spawn_acked).count())
    }

    fn ack(&mut self, client: ClientId, token: u32) {
        let Some(view) = self.clients.get_mut(&client) else { return };
        let part = &view.sent[token as usize % SENT_RING];
        if part.token != Some(token) {
            return;
        }
        for d in &part.despawns {
            view.despawns.retain(|(id, _)| id != d);
        }
        for e in &part.entities {
            let Some(Some(pe)) = view.entities.get_mut(e.slot as usize) else { continue };
            if pe.net_id != e.net_id || part.tick < pe.since {
                continue; // slot reused, or an ack for a previous incarnation (left and re-entered relevancy)
            }
            if e.spawn {
                pe.spawn_acked = true;
            }
            for &(i, v) in &part.comps[e.first as usize..(e.first + e.count) as usize] {
                let a = &mut pe.acked[i as usize];
                if v > a.0 {
                    *a = (v, part.tick);
                }
            }
        }
    }
}

/// Give new `Replicated` entities a [`NetId`].
pub(crate) fn assign_ids(mut commands: Commands, mut server: ResMut<NetServer>, q: Query<Entity, (With<Replicated>, Without<NetId>)>) {
    for e in &q {
        let id = NetId(server.repl.next_id);
        server.repl.next_id += 1;
        commands.entity(e).insert(id);
    }
}

pub(crate) fn advance_tick(mut clock: ResMut<NetClock>, mut server: ResMut<NetServer>) {
    clock.tick = clock.tick.wrapping_add(1);
    server.endpoint.tick = clock.tick;
}

/// `PreUpdate`: packets in, handshakes, events, messages, inputs, snapshot acks.
pub(crate) fn receive(world: &mut World) {
    let t = now(world);
    let Some(mut server) = world.remove_resource::<NetServer>() else { return };
    server.endpoint.update(t);
    let events: Vec<ServerEvent> = server.endpoint.drain_events().collect();
    for ev in events {
        match ev {
            ServerEvent::Connected(id) => {
                server.repl.clients.insert(id, ClientView::new());
                info!("net: {id} connected");
                world.write_message(NetEvent::ClientConnected(id));
            }
            ServerEvent::Disconnected(id, r) => {
                server.repl.clients.remove(&id);
                info!("net: {id} disconnected ({r:?})");
                world.write_message(NetEvent::ClientDisconnected(id, r));
            }
        }
    }
    // Messages: collect into a reused arena first (decoding needs the world).
    let mut inbox = std::mem::take(&mut server.repl.inbox);
    inbox.clear();
    let mut tokens = std::mem::take(&mut server.repl.tokens);
    let NetServer { endpoint, repl } = &mut server;
    for c in endpoint.clients_mut() {
        if c.conn.has_received() {
            let id = c.id;
            c.conn.drain_received(|chn, d| inbox.push(id, chn, d));
        }
        tokens.clear();
        c.conn.drain_acked_tokens(&mut tokens);
        for &tk in &tokens {
            repl.ack(c.id, tk);
        }
    }
    server.repl.tokens = tokens;
    server.repl.stats.clients = server.endpoint.len();
    world.insert_resource(server);
    for (id, chn, data) in inbox.iter() {
        match chn {
            ch::INPUT => super::predict::dispatch_input(world, id, data),
            ch::RELIABLE | ch::UNRELIABLE | ch::SEQUENCED => super::messages::dispatch(world, Some(id), data),
            _ => {}
        }
    }
    if let Some(mut s) = world.get_resource_mut::<NetServer>() {
        s.repl.inbox = inbox;
    }
}

/// Received messages of one frame: one byte arena, no allocation per message.
#[derive(Default)]
pub(crate) struct Inbox {
    buf: Vec<u8>,
    items: Vec<(ClientId, u8, usize, usize)>,
}

impl Inbox {
    pub(crate) fn clear(&mut self) {
        self.buf.clear();
        self.items.clear();
    }
    pub(crate) fn push(&mut self, from: ClientId, chn: u8, d: &[u8]) {
        let s = self.buf.len();
        self.buf.extend_from_slice(d);
        self.items.push((from, chn, s, d.len()));
    }
    pub(crate) fn iter(&self) -> impl Iterator<Item = (ClientId, u8, &[u8])> {
        self.items.iter().map(|&(f, c, s, n)| (f, c, &self.buf[s..s + n]))
    }
}

type ReplQuery = (
    Entity,
    &'static NetId,
    Option<&'static Transform>,
    Option<&'static NetOwner>,
    Option<&'static NetPriority>,
    Has<AlwaysRelevant>,
    Has<NetViewer>,
);

/// `FixedLast`: build and queue snapshots (every `send_interval` ticks).
pub(crate) fn snapshot(world: &mut World, q: &mut QueryState<ReplQuery, With<Replicated>>) {
    let clock = *world.resource::<NetClock>();
    let cfg = world.resource::<NetConfig>().clone();
    if !clock.tick.is_multiple_of(cfg.send_interval.max(1)) {
        return;
    }
    let started = Instant::now();
    let t = now(world);
    let this_tick = world.change_tick();
    let Some(mut server) = world.remove_resource::<NetServer>() else { return };
    let registry = world.resource::<NetRegistry>();
    let NetServer { endpoint, repl } = &mut server;
    let ncomp = registry.components.len();
    repl.ncomp = ncomp;
    repl.owner_only.clear();
    repl.owner_only.extend(registry.components.iter().map(|r| r.owner_only));
    let any_owner_only = repl.owner_only.iter().any(|&o| o);
    let last_tick = repl.last_tick;

    // 1. Serialise what changed (once for all clients); bump versions where bytes differ.
    for c in repl.cache.iter_mut().flatten() {
        c.seen = false;
    }
    let (mut serialized, mut changed) = (0, 0);
    for (entity, &net_id, tf, owner, prio, always, viewer) in q.iter(world) {
        let slot = match repl.index.get(&net_id) {
            Some(&s) => s as usize,
            None => {
                let c = Cached {
                    net_id,
                    pos: Vec3::ZERO,
                    owner: None,
                    priority: 1.0,
                    always: false,
                    viewer: false,
                    seen: true,
                    comps: (0..ncomp).map(|_| CompCache::new()).collect(),
                };
                let s = match repl.free.pop() {
                    Some(s) => {
                        repl.cache[s as usize] = Some(c);
                        s
                    }
                    None => {
                        repl.cache.push(Some(c));
                        repl.cache.len() as u32 - 1
                    }
                };
                repl.index.insert(net_id, s);
                s as usize
            }
        };
        let c = repl.cache[slot].as_mut().unwrap();
        let fresh = c.comps.iter().all(|cc| cc.version == 0);
        c.seen = true;
        c.pos = tf.map_or(Vec3::ZERO, |t| t.translation);
        c.owner = owner.map(|o| o.0);
        c.priority = prio.map_or(1.0, |p| p.0);
        c.always = always;
        c.viewer = viewer;
        c.comps.resize_with(ncomp, CompCache::new);
        let Ok(er) = world.get_entity(entity) else { continue };
        for (i, rule) in registry.components.iter().enumerate() {
            let cc = &mut c.comps[i];
            match er.get_by_id(rule.component_id) {
                Ok(ptr) => {
                    // Unchanged since the last pass (Bevy change ticks): nothing to do.
                    if cc.present
                        && !fresh
                        && let Some(lt) = last_tick
                        && er.get_change_ticks_by_id(rule.component_id).is_some_and(|tk| !tk.is_changed(lt, this_tick))
                    {
                        continue;
                    }
                    serialized += 1;
                    repl.scratch.clear();
                    // SAFETY: ptr was fetched with this rule's component id.
                    unsafe { (rule.write)(ptr, &mut repl.scratch) };
                    if !cc.present || cc.bytes != repl.scratch {
                        cc.present = true;
                        cc.version += 1;
                        std::mem::swap(&mut cc.bytes, &mut repl.scratch);
                        changed += 1;
                        if cfg.delta_compression {
                            let mut b = if cc.history.len() >= HISTORY { cc.history.pop_front().unwrap().1 } else { Vec::new() };
                            b.clear();
                            b.extend_from_slice(&cc.bytes);
                            cc.history.push_back((cc.version, b));
                        }
                    }
                }
                Err(_) => {
                    if cc.present {
                        cc.present = false;
                        cc.version += 1;
                        cc.bytes.clear();
                    }
                }
            }
        }
    }
    repl.last_tick = Some(this_tick);
    // Despawned (or no longer Replicated): free the slot, queue despawns.
    for slot in 0..repl.cache.len() {
        let Some(c) = &repl.cache[slot] else { continue };
        if c.seen {
            continue;
        }
        let id = c.net_id;
        repl.cache[slot] = None;
        repl.free.push(slot as u32);
        repl.index.remove(&id);
        for view in repl.clients.values_mut() {
            if let Some(e) = view.entities.get_mut(slot)
                && e.take().is_some()
            {
                view.despawns.push((id, clock.tick));
            }
        }
    }

    // 2. Viewpoints.
    for view in repl.clients.values_mut() {
        view.viewpoint = view.viewpoint_override;
    }
    for c in repl.cache.iter().flatten() {
        if let Some(o) = c.owner
            && let Some(view) = repl.clients.get_mut(&o)
            && view.viewpoint_override.is_none()
            && (view.viewpoint.is_none() || c.viewer)
        {
            view.viewpoint = Some(c.pos);
        }
    }

    // 3. Per client: relevancy, priority, budgeted delta parts.
    let mut total_bytes = 0;
    let mut updates = 0;
    let mut parts = 0;
    repl.client_ids.clear();
    repl.client_ids.extend(repl.clients.keys().copied());
    let radius2 = cfg.relevancy_radius.map(|r| (r * r, r * r * 1.21));
    let nslots = repl.cache.len();
    for &cid in &repl.client_ids {
        let Some(rc) = endpoint.client_mut(cid) else { continue };
        let conn = &mut rc.conn;
        let view = repl.clients.get_mut(&cid).unwrap();
        view.entities.resize_with(nslots, || None);
        let max_part = conn.max_single();
        let mut budget = conn.budget_hint(t).min(cfg.snapshot_bytes_per_tick);
        let owner_only = &repl.owner_only;

        repl.candidates.clear();
        for (slot, c) in repl.cache.iter().enumerate() {
            let Some(c) = c else { continue };
            let dist = view.viewpoint.map_or(0.0, |v| v.distance(c.pos));
            let mine = c.owner == Some(cid);
            let pe_slot = &mut view.entities[slot];
            let relevant = mine
                || c.always
                || match (radius2, view.viewpoint) {
                    (Some((enter, leave)), Some(_)) => dist * dist <= if pe_slot.is_some() { leave } else { enter },
                    _ => true,
                };
            if !relevant {
                if pe_slot.take().is_some() {
                    view.despawns.push((c.net_id, clock.tick));
                }
                continue;
            }
            if pe_slot.is_none() {
                *pe_slot = Some(PerEntity { net_id: c.net_id, since: clock.tick, spawn_acked: false, acked: vec![(0, 0); ncomp], accum: 0.0 });
                if !view.despawns.is_empty() {
                    view.despawns.retain(|(id, _)| *id != c.net_id);
                }
            }
            let pe = view.entities[slot].as_mut().unwrap();
            pe.acked.resize(ncomp, (0, 0));
            let visible = |i: usize| mine || !any_owner_only || !owner_only[i];
            let dirty = !pe.spawn_acked || c.comps.iter().zip(&pe.acked).enumerate().any(|(i, (cc, a))| cc.version != a.0 && visible(i));
            if !dirty {
                pe.accum = 0.0;
                continue;
            }
            let w = c.priority * if mine { 4.0 } else { 1.0 } / (1.0 + dist / cfg.priority_falloff.max(0.01));
            pe.accum += w.max(1e-4);
            repl.candidates.push((pe.accum, slot as u32));
        }
        repl.candidates.sort_unstable_by(|a, b| b.0.total_cmp(&a.0));

        // Parts.
        let mut part_open = false;
        let begin_part = |part: &mut Vec<u8>, despawns: &[(NetId, u32)], sent: &mut SentPart| {
            part.clear();
            part.put_var(u64::from(clock.tick));
            let n = despawns.len().min(128);
            part.put_var(n as u64);
            sent.token = None;
            sent.tick = clock.tick;
            sent.entities.clear();
            sent.comps.clear();
            sent.despawns.clear();
            for &(id, tk) in &despawns[..n] {
                part.put_var(u64::from(id.0));
                part.put_var(u64::from(tk));
                sent.despawns.push(id);
            }
        };
        let mut cur = SentPart::default();
        if !view.despawns.is_empty() {
            begin_part(&mut repl.part, &view.despawns, &mut cur);
            part_open = true;
        }
        for &(_, slot) in &repl.candidates {
            let c = repl.cache[slot as usize].as_ref().unwrap();
            let pe = view.entities[slot as usize].as_mut().unwrap();
            let mine = c.owner == Some(cid);
            let visible = |i: usize| mine || !any_owner_only || !owner_only[i];
            // Encode the entity's delta.
            repl.ent.clear();
            repl.ent.put_var(u64::from(c.net_id.0));
            let spawn = !pe.spawn_acked;
            let n = c.comps.iter().zip(&pe.acked).enumerate().filter(|(i, (cc, a))| cc.version != a.0 && visible(*i)).count() as u64;
            repl.ent.put_var((n << 1) | u64::from(spawn));
            if spawn {
                repl.ent.put_var(u64::from(pe.since));
            }
            for (i, (cc, &(av, at))) in c.comps.iter().zip(&pe.acked).enumerate() {
                if cc.version == av || !visible(i) {
                    continue;
                }
                if !cc.present {
                    repl.ent.put_var(((i as u64) << 2) | KEY_REMOVED);
                    continue;
                }
                // Delta against the newest state this client acked, if it is recent enough
                // that the client still holds it as a baseline.
                let back = clock.tick.wrapping_sub(at);
                let base = (cfg.delta_compression && av > 0 && back <= DELTA_WINDOW)
                    .then(|| cc.history.iter().rev().find(|(v, _)| *v == av))
                    .flatten()
                    .filter(|(_, b)| b.len() == cc.bytes.len());
                let mut wrote = false;
                if let Some((_, b)) = base {
                    repl.scratch.clear();
                    byte_delta(b, &cc.bytes, &mut repl.scratch);
                    if repl.scratch.len() + var_len(u64::from(back)) < cc.bytes.len() {
                        repl.ent.put_var(((i as u64) << 2) | KEY_DELTA);
                        repl.ent.put_var(u64::from(back));
                        repl.ent.put_bytes(&repl.scratch);
                        wrote = true;
                    }
                }
                if !wrote {
                    repl.ent.put_var((i as u64) << 2);
                    repl.ent.put_bytes(&cc.bytes);
                }
            }
            let size = repl.ent.len();
            // Out of budget: this one (and lower priorities) wait, accumulating priority. An
            // entity bigger than a part goes alone (fragmented) once a part's worth is free.
            if size > budget && !(size > max_part && budget >= max_part) {
                break;
            }
            if !part_open || repl.part.len() + size > max_part {
                if part_open {
                    let tok = conn.send_tracked(ch::SNAPSHOT, &repl.part);
                    total_bytes += repl.part.len();
                    parts += 1;
                    cur.token = Some(tok);
                    std::mem::swap(&mut view.sent[tok as usize % SENT_RING], &mut cur);
                }
                begin_part(&mut repl.part, &[], &mut cur);
                part_open = true;
            }
            repl.part.extend_from_slice(&repl.ent);
            budget = budget.saturating_sub(size);
            let first = cur.comps.len() as u32;
            for (i, (cc, a)) in c.comps.iter().zip(&pe.acked).enumerate() {
                if cc.version != a.0 && visible(i) {
                    cur.comps.push((i as u16, cc.version));
                }
            }
            cur.entities.push(SentEntity { net_id: c.net_id, slot, spawn, first, count: cur.comps.len() as u32 - first });
            pe.accum = 0.0;
            updates += 1;
        }
        if part_open && (!cur.entities.is_empty() || !cur.despawns.is_empty()) {
            let tok = conn.send_tracked(ch::SNAPSHOT, &repl.part);
            total_bytes += repl.part.len();
            parts += 1;
            cur.token = Some(tok);
            std::mem::swap(&mut view.sent[tok as usize % SENT_RING], &mut cur);
        }
    }
    repl.stats.replicated_entities = repl.index.len();
    repl.stats.snapshot_bytes = total_bytes;
    repl.stats.entity_updates = updates;
    repl.stats.parts = parts;
    repl.stats.serialized_components = serialized;
    repl.stats.changed_components = changed;
    repl.stats.snapshot_us = started.elapsed().as_secs_f32() * 1e6;
    world.insert_resource(server);
}

/// Server stopped: replicated entities keep their `NetId` (a new server reassigns from 1, so drop them).
pub(crate) fn despawn_all_tracking(world: &mut World) {
    let ids: Vec<Entity> = world.query_filtered::<Entity, With<NetId>>().iter(world).collect();
    for e in ids {
        if let Ok(mut em) = world.get_entity_mut(e) {
            em.remove::<NetId>();
        }
    }
}

/// Decode a snapshot part's header (tests / tools).
pub fn part_tick(bytes: &[u8]) -> Option<u32> {
    Reader::new(bytes).var_u32().ok()
}
