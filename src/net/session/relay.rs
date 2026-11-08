//! The rendezvous / relay server core: a few hundred lines, std UDP, no threads of its own.
//! `Relay::poll` handles every waiting datagram; the `relay` binary calls it in a loop, tests
//! call it between app updates.
//!
//! It never sees game state except when it forwards packets of peers that could not punch a
//! hole (`RelayUp` / `RelayTo`). Rooms are keyed by a short invite code; a host proves it owns a
//! room with a secret token (also what lets a successor host take a room over after migration).
//! There is no authentication, rate limit or encryption: put it behind your own limits for
//! public use.

use std::net::SocketAddr;

use bevy::platform::collections::HashMap;

use super::proto::{Msg, Refusal};
use crate::net::transport::Transport;
use crate::net::wire::Rng;

/// Invite codes avoid look-alike characters (no 0/O, 1/I).
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const CODE_LEN: usize = 6;

struct Room {
    host: SocketAddr,
    token: u64,
    last_seen: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RelayStats {
    pub rooms: usize,
    pub introductions: u64,
    pub relayed_packets: u64,
    pub relayed_bytes: u64,
    pub refused: u64,
}

pub struct Relay {
    transport: Box<dyn Transport>,
    rooms: HashMap<String, Room>,
    rng: Rng,
    /// A room whose host has been silent this long is dropped (hosts re-register every ~5 s).
    pub room_ttl_s: f64,
    stats: RelayStats,
    buf: Vec<u8>,
}

impl Relay {
    pub fn new(transport: impl Transport, seed: u64) -> Self {
        Relay { transport: Box::new(transport), rooms: HashMap::default(), rng: Rng::new(seed), room_ttl_s: 30.0, stats: RelayStats::default(), buf: Vec::new() }
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.transport.local_addr()
    }

    pub fn stats(&self) -> RelayStats {
        RelayStats { rooms: self.rooms.len(), ..self.stats }
    }

    fn new_code(&mut self) -> String {
        loop {
            let c: String = (0..CODE_LEN).map(|_| ALPHABET[(self.rng.next_u64() % ALPHABET.len() as u64) as usize] as char).collect();
            if !self.rooms.contains_key(&c) {
                return c;
            }
        }
    }

    fn send(&mut self, to: SocketAddr, m: &Msg) {
        let _ = self.transport.send(to, &m.encode());
    }

    /// Handle everything that arrived; `now` is any monotonic clock in seconds.
    pub fn poll(&mut self, now: f64) {
        let mut buf = std::mem::take(&mut self.buf);
        while let Some(from) = self.transport.recv(&mut buf) {
            if let Some(m) = Msg::decode(&buf) {
                self.handle(now, from, m);
            }
        }
        self.buf = buf;
        let ttl = self.room_ttl_s;
        self.rooms.retain(|_, r| now - r.last_seen <= ttl);
    }

    fn handle(&mut self, now: f64, from: SocketAddr, m: Msg) {
        match m {
            Msg::Register { code, token } => {
                let (code, token) = match (code, token) {
                    (Some(c), Some(t)) => match self.rooms.get(&c) {
                        Some(r) if r.token != t => {
                            self.stats.refused += 1;
                            return self.send(from, &Msg::Refused { code: c, why: Refusal::BadToken });
                        }
                        _ => (c, t), // refresh, takeover by the token holder, or recreate after a restart
                    },
                    (Some(c), None) if self.rooms.contains_key(&c) => {
                        self.stats.refused += 1;
                        return self.send(from, &Msg::Refused { code: c, why: Refusal::BadToken });
                    }
                    (Some(c), None) => {
                        let t = self.rng.next_u64();
                        (c, t)
                    }
                    (None, _) => (self.new_code(), self.rng.next_u64()),
                };
                self.rooms.insert(code.clone(), Room { host: from, token, last_seen: now });
                self.send(from, &Msg::Registered { code, token });
            }
            Msg::Join { code } => match self.rooms.get(&code) {
                Some(r) => {
                    let host = r.host;
                    self.stats.introductions += 1;
                    self.send(from, &Msg::Introduce { code: code.clone(), peer: host });
                    self.send(host, &Msg::Introduce { code, peer: from });
                }
                None => {
                    self.stats.refused += 1;
                    self.send(from, &Msg::Refused { code, why: Refusal::NoSuchRoom });
                }
            },
            Msg::RelayUp { code, payload } => {
                if let Some(host) = self.rooms.get(&code).map(|r| r.host) {
                    self.forward(host, from, payload);
                }
            }
            Msg::RelayTo { code, to, payload } if self.rooms.get(&code).is_some_and(|r| r.host == from) => {
                self.forward(to, from, payload);
            }
            _ => {}
        }
    }

    fn forward(&mut self, to: SocketAddr, from: SocketAddr, payload: Vec<u8>) {
        self.stats.relayed_packets += 1;
        self.stats.relayed_bytes += payload.len() as u64;
        self.send(to, &Msg::Relayed { from, payload });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::transport::LoopbackNet;

    fn recv_msg(t: &mut crate::net::transport::LoopbackTransport) -> Option<Msg> {
        let mut b = Vec::new();
        t.recv(&mut b).and_then(|_| Msg::decode(&b))
    }

    #[test]
    fn rooms_introductions_relay_and_takeover() {
        let net = LoopbackNet::new();
        let mut relay = Relay::new(net.bind(1), 7);
        let (mut host, mut guest, mut heir) = (net.bind(2), net.bind(3), net.bind(4));
        let ra = relay.local_addr();
        host.send(ra, &Msg::Register { code: None, token: None }.encode()).unwrap();
        relay.poll(0.0);
        let Some(Msg::Registered { code, token }) = recv_msg(&mut host) else { panic!("no registration") };
        assert_eq!(code.len(), CODE_LEN);
        // Join: both sides are told about each other.
        guest.send(ra, &Msg::Join { code: code.clone() }.encode()).unwrap();
        relay.poll(1.0);
        assert_eq!(recv_msg(&mut guest), Some(Msg::Introduce { code: code.clone(), peer: host.local_addr() }));
        assert_eq!(recv_msg(&mut host), Some(Msg::Introduce { code: code.clone(), peer: guest.local_addr() }));
        // Relay both ways; only the host may use RelayTo.
        guest.send(ra, &Msg::RelayUp { code: code.clone(), payload: vec![1, 2] }.encode()).unwrap();
        relay.poll(1.1);
        assert_eq!(recv_msg(&mut host), Some(Msg::Relayed { from: guest.local_addr(), payload: vec![1, 2] }));
        host.send(ra, &Msg::RelayTo { code: code.clone(), to: guest.local_addr(), payload: vec![3] }.encode()).unwrap();
        guest.send(ra, &Msg::RelayTo { code: code.clone(), to: host.local_addr(), payload: vec![4] }.encode()).unwrap();
        relay.poll(1.2);
        assert_eq!(recv_msg(&mut guest), Some(Msg::Relayed { from: host.local_addr(), payload: vec![3] }));
        assert!(recv_msg(&mut host).is_none(), "a guest can't inject as the host");
        // Unknown room; wrong token; takeover with the right token.
        guest.send(ra, &Msg::Join { code: "NOPE22".into() }.encode()).unwrap();
        heir.send(ra, &Msg::Register { code: Some(code.clone()), token: Some(token ^ 1) }.encode()).unwrap();
        relay.poll(2.0);
        assert!(matches!(recv_msg(&mut guest), Some(Msg::Refused { why: Refusal::NoSuchRoom, .. })));
        assert!(matches!(recv_msg(&mut heir), Some(Msg::Refused { why: Refusal::BadToken, .. })));
        heir.send(ra, &Msg::Register { code: Some(code.clone()), token: Some(token) }.encode()).unwrap();
        relay.poll(2.1);
        assert!(matches!(recv_msg(&mut heir), Some(Msg::Registered { .. })));
        guest.send(ra, &Msg::Join { code: code.clone() }.encode()).unwrap();
        relay.poll(2.2);
        assert_eq!(recv_msg(&mut guest), Some(Msg::Introduce { code: code.clone(), peer: heir.local_addr() }));
        // Silent rooms expire.
        relay.poll(100.0);
        assert_eq!(relay.stats().rooms, 0);
    }
}
