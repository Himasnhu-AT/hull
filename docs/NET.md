# Multiplayer networking (`engine::net`, feature `net`)

Server-authoritative multiplayer in ~5 k lines of engine code (incl. unit tests) plus `postcard` (serde binary
format; pulls only `cobs`): UDP or in-memory transports, reliable/unreliable channels,
delta-compressed snapshot replication with interest management and bandwidth budgets,
client-side prediction with rollback/replay, snapshot interpolation, lag compensation, typed
messages both ways. No replication graph assets, no GUI: what replicates is a few lines of
Rust, everything is inspectable over the control port, and every behaviour is tested headless
on a deterministic loopback network.

`net` is **not** in `default` (most games are single-player):
`engine = { path = .., features = ["net"] }`, tests with `cargo test --features net --test net`.

## Quick start

```rust
use engine::prelude::*;            // NetAppExt, Replicated, NetOwner, LocalInput, NetSender, ...
use engine::net::{self, Channel};

#[derive(Component, Clone, Default, Serialize, Deserialize, PartialEq)]
struct Body { x: f32, z: f32, vx: f32, vz: f32 }
#[derive(Clone, Default, Serialize, Deserialize)]
struct Move { x: i8, z: i8 }

fn step(b: &mut Body, i: &Move, dt: f32) { /* pure: same on server and client */ }

app.replicate_transform()                    // quantised, interpolated on clients
   .replicate::<Health>()                    // any serde component
   .replicate_owner_only::<Ammo>()           // only the owning client sees it
   .add_net_message::<Chat>(Channel::Reliable)
   .predict::<Body, Move>(step);             // prediction + reconciliation

// server: spawn what replicates
commands.spawn((Replicated, NetOwner(client), NetViewer, Body::default(), Transform::default()));
// client: feed input every frame
input.0 = Move { x: .., z: .. };             // ResMut<LocalInput<Move>>
```

Start a session from code, the command line, or the control port:

| How | Server | Client |
|---|---|---|
| code | `net::host(world, transport, listen)`, `net::host_udp(world, port, listen)` | `net::connect(world, transport, addr)`, `net::connect_udp(world, addr)` |
| CLI | `--server [port]` (dedicated, **headless**), `--host [port]` (listen server) | `--connect host[:port]` |
| control port | `net.host {port, listen}` | `net.connect {addr}` |

`net::disconnect(world)` / `net.disconnect` leaves (clients) or shuts down (server). The CLI
flags are player-facing (they work in ship builds — dedicated servers ship); `--server` makes
`EngineOptions::from_args` boot headless. `examples/net_demo.rs` is a runnable reference
(orbiting balls + one predicted cube per client).

## Concepts and API

**Roles and states.** `NetRole` (`Offline`, `Server`, `ListenServer`, `Client`) and the Bevy
state `NetState` (`Offline`, `Connecting`, `InGame`, `Disconnected`). With
`NetConfig::drive_app_state` (default on) a client entering `InGame` sets `AppState::InGame`,
and a disconnect after that returns to `AppState::MainMenu`. `MessageReader<NetEvent>` gets
`ClientConnected(id)`, `ClientDisconnected(id, reason)`, `Connected(id)`, `Disconnected(reason)`.
Disconnect reasons: `Requested`, `RemoteClosed`, `Timeout`, `ConnectTimeout`,
`ProtocolMismatch`, `ServerFull`, `Kicked`, `ServerShutdown`, `ProtocolError`.

**Ticks.** The network runs on Bevy's fixed timestep (`NetConfig::tick_hz`, default 60; the
engine sets `Time<Fixed>` unless `set_fixed_timestep = false`). `NetClock::tick` is the
server's authoritative tick, or on a client the *predicted* tick (ahead of the server by
≈ RTT + `input_lead_ticks`). Clients steer their fixed timestep ±10 % to hold that lead and
resync on jumps > 12 ticks. `NetClock::render_tick` is the server tick remote entities are drawn
at (`server_tick − interpolation_delay_s`).

**Replication.** Mark server entities `Replicated`; they get a `NetId` (same id on all peers).
Register components with `replicate::<C>()` (serde/postcard), `replicate_with::<C, MyCodec>()`
(custom `Codec`), `replicate_transform()` (1 mm positions as zigzag varints + 32-bit
smallest-three rotation + scale only when ≠ 1: 6–13 bytes) and `replicate_owner_only::<C>()`.
Clients spawn mirrors with `NetId`, `Remote` and either `Interpolated` or (owned by this
client) `Predicted`; `NetClient::entity(net_id)` maps ids to local entities (use `NetId` in your
own components to reference other entities). Component insert / change / remove and entity
despawn all replicate. Server and client must register the same set in the same order; the
list (plus `protocol_version` and wire options) is hashed into the protocol id, and a mismatched
build is refused at the handshake (`ProtocolMismatch`).

**Snapshots and deltas.** Every `send_interval` ticks the server re-serialises components Bevy
saw change (once for all clients), versions them, and per client sends only components whose
version differs from the newest one that client acked — as a byte delta against that acked
value when it is ≤ 60 ticks old. Snapshot parts are unreliable, ≤ 1 packet, ack-tracked: a
loss costs nothing but a resend of whatever is still unacked next tick. Out-of-order and
duplicated packets are handled per (entity, component) by tick; relevancy flapping by an
incarnation tick (`since`).

**Interest management and bandwidth.** `relevancy_radius: Some(r)` sends an entity to a client
only within `r` of that client's viewpoint (its `NetViewer` entity, else the first entity it
owns, else `NetServer::set_viewpoint`), with 10 % hysteresis; leaving despawns it on that
client. `AlwaysRelevant` and the client's own entities ignore the radius. Each tick, dirty
entities accumulate priority `NetPriority × 1/(1 + d/priority_falloff)` (×4 for owned) and the
highest are written until `snapshot_bytes_per_tick` or the link's token bucket
(`ConnectionConfig::bytes_per_sec`, default 128 KB/s) runs out; the rest keep accumulating, so
far/low-priority entities update less often but never starve.

**Interpolation.** Interpolated components (Transform by default; `interpolate::<C>(lerp)` for
your own) are buffered per entity (`NetHistory<C>`) and drawn at `render_tick` in `PostUpdate`
before transform propagation. Non-interpolated components apply on arrival.

**Prediction and reconciliation.** `predict::<S, I>(step)`: every fixed tick the client stamps
`LocalInput<I>` with its tick, puts it in `NetInput<I>` on its `Predicted` entity, runs `step`
and records `PredictionHistory<S>`; inputs go to the server unreliably with the last
`input_redundancy` (4) inputs repeated. The server applies each client's input for exactly that
tick to entities with `NetOwner(client)` (repeating the last one if it is missing) and runs the
same `step`. When the server's `S` for tick T arrives, the client compares it with its history
(in wire encoding, so quantisation can't cause false alarms), and on a mismatch resets to the
server state and replays its buffered inputs T+1..now. `PredictionStats` counts checks,
rollbacks, replayed ticks, late and missing inputs. A listen server's own player
(`NetOwner(ClientId::HOST)`) reads `LocalInput` directly. Interpolated components of a predicted
entity are applied once (on spawn), then left to the game (derive them from `S`).

**Messages / RPCs.** `add_net_message::<M>(Channel)`; send with the `NetSender` system param
(`to_server`, `to_client`, `broadcast`, `broadcast_except`); read
`MessageReader<FromClient<M>>` (server) / `MessageReader<FromServer<M>>` (client). On a listen
server the host's own messages are delivered locally. Messages sent before the handshake
completes are dropped.

**Lag compensation.** With `lag_compensation_ticks > 0` the server records transforms of
`LagCompensated` entities per tick, and every input carries the client's render tick:
`LagCompensation::view_tick(client)`, `transform_at(entity, tick)` and
`ray_cast(origin, dir, max, tick, radius_of)` rewind hit tests to what the shooter saw.

**Link conditioner.** `NetConfig::conditioner` / `net::set_conditioner` / `net.conditioner`
add latency, jitter, loss, duplication and forced reordering to this peer's outgoing packets
(seeded, deterministic). Set it on both peers to degrade both directions.

### Lower layers (usable without the plugin)

- `wire`: varints, zigzag, u16 sequence math, quantisation, byte deltas, FNV hash, splitmix RNG.
- `transport`: `Transport` trait; `LoopbackNet` (in-memory hub, no sockets/threads, pooled
  buffers), `UdpTransport` (nonblocking `std::net`), `Conditioner`.
- `connection::Connection`: packet seq/ack/32-bit ack field, RTT (srtt/rttvar), channels
  `Reliable` (ordered; resend after `srtt + 4·rttvar`, 256-message window, 1 KB fragments up to
  `max_message_size` 1 MB), `Unreliable` (fragment groups up to 255 packets, all-or-nothing),
  `Sequenced` (drops older-than-newest), ack-tracked unreliable sends, token-bucket bandwidth
  cap, stats (RTT, loss, bytes/s, resends, drops). No allocation per packet once warm.
- `endpoint`: `ServerEndpoint` / `ClientEndpoint` — challenge handshake (spoofed source
  addresses can't connect; replies are never larger than requests), protocol id check, server
  full, keepalive (0.25 s), timeout (5 s), disconnect reasons (sent 3× on close).

## Control commands (feature `devtools`)

| Command | Params | Result |
|---|---|---|
| `net.status` | — | `{role, state, tick, server_tick, render_tick, latest_snapshot, resyncs, addr, prediction, conditioner, server?: ServerStats, client?: ClientStats, client_id?, status?, link?: ConnStats}` |
| `net.clients` | — | server: `{clients: [{id, addr, rtt_ms, loss, send_bytes_per_sec, recv_bytes_per_sec, packets_lost, reliable_in_flight, known_entities}]}` |
| `net.conditioner` | `{latency_ms?, jitter_ms?, loss?, duplicate?, reorder?, seed?}` | settings now in force (omitted = unchanged) |
| `net.host` | `{port?, listen?}` | `{addr}` |
| `net.connect` | `{addr}` | `{}` (poll `net.status` → `state: InGame`) |
| `net.disconnect` | — | `{}` |

Dev builds also add perf rows `net.recv`, `net.snapshot`, `net.send` (overlay / `perf.stats`)
and metrics keys `net.rtt_ms`, `net.down_kbps`, `net.up_kbps`, `net.loss_pct`, `net.entities`,
`net.rollbacks`, `net.clients`, `net.snapshot_us`, `net.snapshot_bytes`, `net.rtt_max_ms`.

`scripts/net_play.py steps.json --example net_demo --features net --clients 1` builds once,
starts a dedicated server and N offscreen clients (each with its own control port), runs steps
addressed to `server` / `client0` / … / `all` (`cmd`, `shot`, `sleep`, `wait` until a status
field matches) and writes `client0-<name>.png` screenshots. Every process takes a memgate slot
(2 by default), so keep `--clients 1` unless the queue is empty.

## Tests

`tests/net.rs` (≈2 s, 13 tests, deterministic seeds): handshake / disconnect / shutdown
reasons; protocol mismatch; replication convergence (61 entities, inserts / changes / removes /
despawns) under 40 ms + 20 ms jitter, 20 % loss, 5 % duplication, 2 % reordering both ways;
reliable messages in order both ways under the same link; prediction runs ahead, matches the
server with zero rollbacks when nothing disagrees, and reconciles exactly after a server-side
correction under 50 ms / 10 % loss (a one-tick input survives via redundancy); interest
management with hysteresis and `AlwaysRelevant`; bandwidth cap respected with no starvation
(500 movers through 24 KB/s); delta compression saves ≥ 20 % and converges; owner-only
components; lag compensation rewinds to exactly what the client displayed; interpolation is
smooth at 20 Hz snapshots; UDP end to end; the `net.*` commands. Unit tests (`cargo test --lib
--features net net::`) cover varints, quaternion packing, byte deltas, the conditioner,
reliable delivery under 20 % loss with reorder + duplication + fragmentation, sequenced and
fragmented unreliable delivery, the bandwidth cap, ack-tracked sends, and the handshake,
timeout, kick, deny and connect-timeout paths.

## Measurements

Apple M5 Pro, dev profile (engine crate at `opt-level = 1`, dependencies at 3 — a release build
is several times faster), loopback, one thread, other builds running on the machine (±20 %).
`cargo test --features net --test net -- --ignored --nocapture --test-threads 1 bench`.

**Server: 64 clients × 500 moving entities** (+64 player entities; Transform + Health each;
clients are raw endpoints that ack). "frame" = the whole server `App::update` (receive 64
clients, snapshot, send); "updates" = entity updates written in one pass across all clients.

| scenario | server frame | snapshot pass | per-client down | total out | updates / pass |
|---|---|---|---|---|---|
| moving, 128 KB/s per client (default cap) | 3.5 ms | 2.2 ms | 128 KB/s | 8.0 MB/s | 20 233 |
| …same, delta compression off | 2.2 ms | 1.1 ms | 128 KB/s | 8.0 MB/s | 10 182 |
| moving, uncapped (every entity every tick) | 4.0 ms | 2.6 ms | 285 KB/s | 17.8 MB/s | 32 000 |
| …same, delta compression off | 3.3 ms | 1.7 ms | 495 KB/s | 30.9 MB/s | 32 000 |
| moving, 60 m relevancy, 128 KB/s | 2.1 ms | 0.9 ms | 71 KB/s | 4.5 MB/s | 7 725 |
| static (nothing changes) | 1.1 ms | 0.3 ms | 0.8 KB/s | 0.05 MB/s | 0 |

- Delta compression: −42 % bytes for the same updates (≈ 9.7 B vs 16.9 B on the wire per moving-entity
  update incl. packet headers), i.e. 2× the update rate under a bandwidth cap, for ~1 ms more CPU at
  64 × 500.
- Static worlds cost almost nothing: change detection skips serialisation, clean entities are
  skipped per client with no hashing; what remains is acks/keepalives (0.8 KB/s per client).
- **Client** (1 client App, 500 moving entities at full rate + 1 predicted player, 50 ms
  each way): 1.0 ms per frame for receive + apply + interpolation + prediction (snapshot
  apply ~260 KB/s down), 1.7 KB/s up (inputs at 60 Hz with 4× redundancy); 1 rollback in 416
  checks (the initial sync).
- `net_demo` over real UDP (server headless + 1 offscreen client, 24 balls + 1 player): link
  17 KB/s down, rtt 16–20 ms on localhost; with `net.conditioner {latency_ms: 80, jitter_ms: 10,
  loss: 0.1}` on both sides prediction keeps the cube responsive (rtt 200 ms), 34 rollbacks
  in 182 checks while the client clock re-synced to the new latency.
- Unused: zero cost — without `host`/`connect` every net system is skipped by a resource check;
  without the `net` feature nothing is compiled.

## Known limits

- Entity references inside replicated components are not remapped automatically: store
  `NetId`s and map them with `NetClient::entity`. Hierarchies (`ChildOf`) don't replicate; spawn
  children locally from replicated data.
- Prediction corrections snap (no visual error smoothing); the game can smooth its own
  visuals. Prediction covers one state component per `predict` call per entity; physics engines
  are not rolled back (the step must be a pure function).
- Generic components apply on arrival (only `interpolate::<C>` ones are delayed and blended).
- Lag compensation rewinds `Transform` only (sphere ray tests built in; other shapes via
  `transform_at`).
- Owner-only components already on a client are not cleared when ownership moves away.
- No encryption or authentication beyond the address-proving challenge; no NAT punch-through,
  relays, matchmaking or host migration.
- The server is single-threaded (the snapshot pass costs ~9 ns per clean and ~100 ns per
  written entity×client in dev builds); one `ServerEndpoint` per process.
