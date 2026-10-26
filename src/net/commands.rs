//! `net.*` control commands (feature `devtools`).
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `net.status` | — | `{role, state, tick, server_tick, render_tick, addr, client_id?, link?, server?, client?, prediction, conditioner}` |
//! | `net.clients` | — | `{clients: [{id, addr, rtt_ms, loss, send_bps, recv_bps, known_entities, ...}]}` (server) |
//! | `net.conditioner` | `{latency_ms?, jitter_ms?, loss?, duplicate?, reorder?, seed?}` | the settings now in force (omitted = unchanged) |
//! | `net.host` | `{port?, listen?}` | `{addr}` (UDP) |
//! | `net.connect` | `{addr}` | `{}` (UDP; poll `net.status` for `state`) |
//! | `net.disconnect` | — | `{}` |

use bevy::prelude::*;
use serde_json::{Value, json};

use super::{NetClient, NetClock, NetConfig, NetRole, NetServer, NetSet, NetState, PredictionStats};
use crate::devtools::control::{AddControlCommand, params};
use crate::devtools::{Metrics, PerfAppExt};

pub(super) fn register(app: &mut App) {
    // Cost rows in the perf overlay / `perf.stats`, and `net.*` keys in the metrics window.
    app.perf_span(PreUpdate, NetSet::Receive, "net.recv")
        .perf_span(FixedLast, NetSet::Snapshot, "net.snapshot")
        .perf_span(Last, NetSet::Send, "net.send")
        .add_systems(Last, record_metrics.after(NetSet::Send).run_if(|r: Res<NetRole>| *r != NetRole::Offline));
    app.add_control_command("net.status", "Network role, state, ticks, link and replication stats", params(&[]), status)
        .add_control_command("net.clients", "Server: connected clients with RTT, loss, bandwidth", params(&[]), clients)
        .add_control_command(
            "net.conditioner",
            "Simulate a bad network on this peer's outgoing packets (omitted fields unchanged)",
            params(&[
                ("latency_ms", "number", "one-way added latency"),
                ("jitter_ms", "number", "extra random delay 0..jitter"),
                ("loss", "number", "drop probability 0..1"),
                ("duplicate", "number", "duplicate probability 0..1"),
                ("reorder", "number", "forced-reorder probability 0..1"),
                ("seed", "integer", "RNG seed"),
            ]),
            conditioner,
        )
        .add_control_command(
            "net.host",
            "Start a UDP server",
            params(&[("port", "integer", "UDP port (default 7777, 0 = any)"), ("listen", "boolean", "with a local player (default true)")]),
            host,
        )
        .add_control_command("net.connect", "Connect to a UDP server", params(&[("addr", "string", "host:port")]), connect)
        .add_control_command("net.disconnect", "Leave / stop the server", params(&[]), disconnect);
}

/// One sample per frame: link health and replication load.
fn record_metrics(m: Option<ResMut<Metrics>>, server: Option<Res<NetServer>>, client: Option<Res<NetClient>>, pred: Res<PredictionStats>) {
    let Some(mut m) = m else { return };
    if let Some(s) = server {
        let st = s.stats();
        m.record("net.clients", st.clients as f64);
        m.record("net.entities", st.replicated_entities as f64);
        m.record("net.snapshot_us", f64::from(st.snapshot_us));
        m.record("net.snapshot_bytes", st.snapshot_bytes as f64);
        let (up, rtt) = s.endpoint.clients().fold((0.0, 0.0f32), |(b, r), c| {
            let cs = c.conn.stats();
            (b + f64::from(cs.send_bytes_per_sec), r.max(cs.rtt_ms))
        });
        m.record("net.up_kbps", up * 8.0 / 1000.0);
        m.record("net.rtt_max_ms", f64::from(rtt));
    }
    if let Some(c) = client
        && let Some(st) = c.endpoint.stats()
    {
        m.record("net.rtt_ms", f64::from(st.rtt_ms));
        m.record("net.down_kbps", f64::from(st.recv_bytes_per_sec) * 8.0 / 1000.0);
        m.record("net.up_kbps", f64::from(st.send_bytes_per_sec) * 8.0 / 1000.0);
        m.record("net.loss_pct", f64::from(st.loss) * 100.0);
        m.record("net.entities", c.stats().entities as f64);
        m.record("net.rollbacks", pred.rollbacks as f64);
    }
}

fn status(world: &mut World, _: Value) -> Result<Value, String> {
    let role = *world.resource::<NetRole>();
    let state = world.get_resource::<State<NetState>>().map(|s| format!("{:?}", s.get()));
    let clock = *world.resource::<NetClock>();
    let cond = world.resource::<NetConfig>().conditioner;
    let mut out = json!({
        "role": format!("{role:?}"),
        "state": state,
        "tick": clock.tick,
        "server_tick": clock.server_tick,
        "render_tick": clock.render_tick,
        "latest_snapshot": clock.latest_snapshot,
        "resyncs": clock.resyncs,
        "prediction": serde_json::to_value(*world.resource::<PredictionStats>()).unwrap_or_default(),
        "conditioner": serde_json::to_value(cond).unwrap_or_default(),
    });
    if let Some(s) = world.get_resource::<NetServer>() {
        out["addr"] = json!(s.endpoint.local_addr().to_string());
        out["server"] = serde_json::to_value(s.stats()).unwrap_or_default();
    }
    if let Some(c) = world.get_resource::<NetClient>() {
        out["addr"] = json!(c.endpoint.local_addr().to_string());
        out["server_addr"] = json!(c.endpoint.server.to_string());
        out["client_id"] = json!(c.endpoint.id.map(|i| i.0));
        out["status"] = json!(format!("{:?}", c.endpoint.status()));
        out["link"] = serde_json::to_value(c.endpoint.stats()).unwrap_or_default();
        out["client"] = serde_json::to_value(c.stats()).unwrap_or_default();
    }
    Ok(out)
}

fn clients(world: &mut World, _: Value) -> Result<Value, String> {
    let Some(s) = world.get_resource::<NetServer>() else { return Err("not a server".into()) };
    let list: Vec<Value> = s
        .endpoint
        .clients()
        .map(|c| {
            let st = c.conn.stats();
            json!({
                "id": c.id.0,
                "addr": c.addr.to_string(),
                "rtt_ms": st.rtt_ms,
                "loss": st.loss,
                "send_bytes_per_sec": st.send_bytes_per_sec,
                "recv_bytes_per_sec": st.recv_bytes_per_sec,
                "packets_lost": st.packets_lost,
                "reliable_in_flight": st.reliable_in_flight,
                "known_entities": s.entities_known_by(c.id),
            })
        })
        .collect();
    Ok(json!({"clients": list}))
}

fn conditioner(world: &mut World, p: Value) -> Result<Value, String> {
    let mut c = world.resource::<NetConfig>().conditioner;
    let f = |k: &str| p.get(k).and_then(Value::as_f64).map(|v| v as f32);
    if let Some(v) = f("latency_ms") {
        c.latency_ms = v.max(0.0);
    }
    if let Some(v) = f("jitter_ms") {
        c.jitter_ms = v.max(0.0);
    }
    for (k, slot) in [("loss", &mut c.loss), ("duplicate", &mut c.duplicate), ("reorder", &mut c.reorder)] {
        if let Some(v) = f(k) {
            *slot = v.clamp(0.0, 1.0);
        }
    }
    if let Some(s) = p.get("seed").and_then(Value::as_u64) {
        c.seed = s;
    }
    super::set_conditioner(world, c);
    Ok(serde_json::to_value(c).unwrap_or_default())
}

fn host(world: &mut World, p: Value) -> Result<Value, String> {
    let port = p.get("port").and_then(Value::as_u64).unwrap_or(super::DEFAULT_PORT as u64) as u16;
    let listen = p.get("listen").and_then(Value::as_bool).unwrap_or(true);
    let a = super::host_udp(world, port, listen).map_err(|e| e.to_string())?;
    Ok(json!({"addr": a.to_string()}))
}

fn connect(world: &mut World, p: Value) -> Result<Value, String> {
    let a = p.get("addr").and_then(Value::as_str).ok_or("`addr` (string) is required")?;
    let addr = super::parse_addr(a).ok_or_else(|| format!("bad address {a}"))?;
    super::connect_udp(world, addr).map_err(|e| e.to_string())?;
    Ok(json!({}))
}

fn disconnect(world: &mut World, _: Value) -> Result<Value, String> {
    super::disconnect(world);
    Ok(json!({}))
}
