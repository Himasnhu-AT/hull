//! Rendezvous / relay server for co-op sessions (docs/NET.md, "Sessions"):
//! `cargo run --features net --bin relay -- [bind-addr]` (default `0.0.0.0:7788`).
//! One UDP socket, no threads, a few KB per room. Run it anywhere both players can reach.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use engine::net::session::DEFAULT_RELAY_PORT;
use engine::net::session::relay::Relay;
use engine::net::{Transport, UdpTransport};

fn main() {
    let bind: SocketAddr = std::env::args()
        .nth(1)
        .map(|a| a.parse().unwrap_or_else(|_| panic!("bad address `{a}` (expected ip:port)")))
        .unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], DEFAULT_RELAY_PORT)));
    let socket = UdpTransport::bind(bind).unwrap_or_else(|e| panic!("can't bind {bind}: {e}"));
    println!("relay: listening on {}", socket.local_addr());
    let mut relay = Relay::new(socket, rand::random());
    let start = Instant::now();
    let mut last_report = 0.0;
    loop {
        let now = start.elapsed().as_secs_f64();
        relay.poll(now);
        if now - last_report >= 30.0 {
            last_report = now;
            let s = relay.stats();
            println!(
                "relay: {} rooms, {} introductions, {} relayed packets ({} KB), {} refused",
                s.rooms,
                s.introductions,
                s.relayed_packets,
                s.relayed_bytes / 1024,
                s.refused
            );
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}
