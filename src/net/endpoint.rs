//! Server and client endpoints: the connection handshake on top of a [`Transport`], then one
//! [`Connection`] per peer. Plain structs (no ECS) so they can be driven from tests, tools or
//! the Bevy plugin alike.
//!
//! Handshake (every step resent every 100 ms until answered; `timeout_s` overall):
//! ```text
//! client ── CONNECT_REQUEST {protocol u64, client_salt u64} ──▶ server
//!        ◀── CHALLENGE {client_salt, server_salt}  (or DENY {client_salt, reason})
//!        ── CHALLENGE_RESPONSE {client_salt, server_salt} ──▶   (proves the address is real)
//!        ◀── ACCEPT {client_salt, client_id, tick, tick_hz}
//! payload packets then carry session = (client_salt ^ server_salt) as u32.
//! ```
//! Replies are never larger than requests (no amplification). A protocol id mismatch is denied
//! with [`DisconnectReason::ProtocolMismatch`]; a full server with `ServerFull`.

use std::net::SocketAddr;

use bevy::platform::collections::HashMap;

use super::connection::{ConnStats, Connection, ConnectionConfig, DisconnectReason, SendError, kind};
use super::transport::{Conditioner, LinkConditioner, Transport};
use super::wire::{Put, Reader, Rng, WireResult};

/// Server-assigned client id. `ClientId::HOST` (0) is a listen server's own player.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub struct ClientId(pub u32);

impl ClientId {
    pub const HOST: ClientId = ClientId(0);
}

impl std::fmt::Display for ClientId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "client#{}", self.0)
    }
}

const RESEND: f64 = 0.1;

fn session(c: u64, s: u64) -> u32 {
    let x = c ^ s;
    (x as u32) ^ ((x >> 32) as u32)
}

/// Lifecycle events, drained with `drain_events`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerEvent {
    Connected(ClientId),
    Disconnected(ClientId, DisconnectReason),
}

struct Pending {
    client_salt: u64,
    server_salt: u64,
    born: f64,
}

pub struct RemoteClient {
    pub id: ClientId,
    pub addr: SocketAddr,
    pub conn: Connection,
    client_salt: u64,
    server_salt: u64,
}

/// Accepts clients on one transport.
pub struct ServerEndpoint {
    transport: Box<dyn Transport>,
    pub conditioner: Conditioner,
    cfg: ConnectionConfig,
    protocol: u64,
    pub max_clients: usize,
    clients: Vec<RemoteClient>,
    by_addr: HashMap<SocketAddr, ClientId>,
    pending: HashMap<SocketAddr, Pending>,
    next_id: u32,
    rng: Rng,
    events: Vec<ServerEvent>,
    buf: Vec<u8>,
    out: Vec<u8>,
    /// Handshake-tick to report in ACCEPT.
    pub tick: u32,
    pub tick_hz: u16,
}

impl ServerEndpoint {
    pub fn new(transport: Box<dyn Transport>, cfg: ConnectionConfig, protocol: u64, max_clients: usize, seed: u64) -> Self {
        ServerEndpoint {
            transport,
            conditioner: Conditioner::new(LinkConditioner::default()),
            cfg,
            protocol,
            max_clients,
            clients: Vec::new(),
            by_addr: HashMap::default(),
            pending: HashMap::default(),
            next_id: 1,
            rng: Rng::new(seed),
            events: Vec::new(),
            buf: Vec::with_capacity(1500),
            out: Vec::with_capacity(64),
            tick: 0,
            tick_hz: 60,
        }
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.transport.local_addr()
    }

    pub fn clients(&self) -> impl Iterator<Item = &RemoteClient> {
        self.clients.iter()
    }

    pub fn clients_mut(&mut self) -> impl Iterator<Item = &mut RemoteClient> {
        self.clients.iter_mut()
    }

    pub fn client(&self, id: ClientId) -> Option<&RemoteClient> {
        self.clients.iter().find(|c| c.id == id)
    }

    pub fn client_mut(&mut self, id: ClientId) -> Option<&mut RemoteClient> {
        self.clients.iter_mut().find(|c| c.id == id)
    }

    pub fn len(&self) -> usize {
        self.clients.len()
    }

    pub fn is_empty(&self) -> bool {
        self.clients.is_empty()
    }

    pub fn drain_events(&mut self) -> std::vec::Drain<'_, ServerEvent> {
        self.events.drain(..)
    }

    fn raw_send(&mut self, now: f64, to: SocketAddr) {
        let out = std::mem::take(&mut self.out);
        self.conditioner.send(self.transport.as_mut(), now, to, &out);
        self.out = out;
    }

    /// Receive everything waiting, run handshakes and timeouts.
    pub fn update(&mut self, now: f64) {
        self.conditioner.flush(self.transport.as_mut(), now);
        let mut buf = std::mem::take(&mut self.buf);
        while let Some(from) = self.transport.recv(&mut buf) {
            if buf.is_empty() {
                continue;
            }
            let _ = self.handle(now, from, &buf);
        }
        self.buf = buf;
        self.pending.retain(|_, p| now - p.born < 10.0);
        // Timeouts / protocol errors.
        let mut i = 0;
        while i < self.clients.len() {
            let c = &self.clients[i];
            let reason = if c.conn.error {
                Some(DisconnectReason::ProtocolError)
            } else if c.conn.timed_out(now) {
                Some(DisconnectReason::Timeout)
            } else {
                None
            };
            match reason {
                Some(r) => self.drop_client(now, i, r, r != DisconnectReason::Timeout),
                None => i += 1,
            }
        }
    }

    fn handle(&mut self, now: f64, from: SocketAddr, p: &[u8]) -> WireResult<()> {
        let mut r = Reader::new(p);
        match r.u8()? {
            kind::PAYLOAD => {
                let s = r.u32()?;
                if let Some(id) = self.by_addr.get(&from).copied()
                    && let Some(c) = self.clients.iter_mut().find(|c| c.id == id)
                    && c.conn.session == s
                    && c.conn.receive(now, p).is_err()
                {
                    c.conn.error = true;
                }
            }
            kind::CONNECT_REQUEST => {
                let proto = r.u64()?;
                let cs = r.u64()?;
                if self.by_addr.contains_key(&from) {
                    return Ok(()); // already connected; the ACCEPT resend path handles it
                }
                self.out.clear();
                if proto != self.protocol {
                    self.out.put_u8(kind::DENY);
                    self.out.put_u64(cs);
                    self.out.put_u8(DisconnectReason::ProtocolMismatch.code());
                } else if self.clients.len() >= self.max_clients {
                    self.out.put_u8(kind::DENY);
                    self.out.put_u64(cs);
                    self.out.put_u8(DisconnectReason::ServerFull.code());
                } else {
                    if self.pending.len() >= 256 && !self.pending.contains_key(&from) {
                        return Ok(());
                    }
                    let ss = match self.pending.get(&from) {
                        Some(pd) if pd.client_salt == cs => pd.server_salt,
                        _ => self.rng.next_u64(),
                    };
                    self.pending.insert(from, Pending { client_salt: cs, server_salt: ss, born: now });
                    self.out.put_u8(kind::CHALLENGE);
                    self.out.put_u64(cs);
                    self.out.put_u64(ss);
                }
                self.raw_send(now, from);
            }
            kind::CHALLENGE_RESPONSE => {
                let cs = r.u64()?;
                let ss = r.u64()?;
                if let Some(id) = self.by_addr.get(&from).copied() {
                    // Our ACCEPT was lost: resend it.
                    if let Some(c) = self.clients.iter().find(|c| c.id == id)
                        && c.client_salt == cs
                        && c.server_salt == ss
                    {
                        self.write_accept(cs, id);
                        self.raw_send(now, from);
                    }
                    return Ok(());
                }
                let Some(pd) = self.pending.get(&from) else { return Ok(()) };
                if pd.client_salt != cs || pd.server_salt != ss {
                    return Ok(());
                }
                self.pending.remove(&from);
                if self.clients.len() >= self.max_clients {
                    self.out.clear();
                    self.out.put_u8(kind::DENY);
                    self.out.put_u64(cs);
                    self.out.put_u8(DisconnectReason::ServerFull.code());
                    self.raw_send(now, from);
                    return Ok(());
                }
                let id = ClientId(self.next_id);
                self.next_id += 1;
                let conn = Connection::new(session(cs, ss), self.cfg, now);
                self.clients.push(RemoteClient { id, addr: from, conn, client_salt: cs, server_salt: ss });
                self.by_addr.insert(from, id);
                self.events.push(ServerEvent::Connected(id));
                self.write_accept(cs, id);
                self.raw_send(now, from);
            }
            kind::DISCONNECT => {
                let s = r.u32()?;
                if let Some(id) = self.by_addr.get(&from).copied()
                    && let Some(i) = self.clients.iter().position(|c| c.id == id && c.conn.session == s)
                {
                    self.drop_client(now, i, DisconnectReason::RemoteClosed, false);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn write_accept(&mut self, cs: u64, id: ClientId) {
        self.out.clear();
        self.out.put_u8(kind::ACCEPT);
        self.out.put_u64(cs);
        self.out.put_u32(id.0);
        self.out.put_u32(self.tick);
        self.out.put_u16(self.tick_hz);
    }

    fn drop_client(&mut self, now: f64, i: usize, reason: DisconnectReason, notify: bool) {
        let c = self.clients.swap_remove(i);
        self.by_addr.remove(&c.addr);
        if notify {
            self.out.clear();
            self.out.put_u8(kind::DISCONNECT);
            self.out.put_u32(c.conn.session);
            self.out.put_u8(reason.code());
            for _ in 0..3 {
                self.raw_send(now, c.addr);
            }
        }
        self.events.push(ServerEvent::Disconnected(c.id, reason));
    }

    /// Drop a client (it is told why).
    pub fn disconnect(&mut self, now: f64, id: ClientId, reason: DisconnectReason) {
        if let Some(i) = self.clients.iter().position(|c| c.id == id) {
            self.drop_client(now, i, reason, true);
        }
    }

    /// Disconnect everyone (`ServerShutdown`).
    pub fn shutdown(&mut self, now: f64) {
        while !self.clients.is_empty() {
            self.drop_client(now, 0, DisconnectReason::ServerShutdown, true);
        }
    }

    pub fn send(&mut self, id: ClientId, channel: u8, data: &[u8]) -> Result<(), SendError> {
        match self.clients.iter_mut().find(|c| c.id == id) {
            Some(c) => c.conn.send(channel, data),
            None => Ok(()),
        }
    }

    pub fn broadcast(&mut self, channel: u8, data: &[u8]) {
        for c in &mut self.clients {
            let _ = c.conn.send(channel, data);
        }
    }

    /// Send every connection's queued data.
    pub fn flush(&mut self, now: f64) {
        let transport = self.transport.as_mut();
        let cond = &mut self.conditioner;
        for c in &mut self.clients {
            let addr = c.addr;
            c.conn.flush(now, &mut |p| cond.send(transport, now, addr, p));
        }
        cond.flush(transport, now);
    }
}

/// Client connection state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientStatus {
    Connecting,
    Connected,
    Disconnected(DisconnectReason),
}

enum Phase {
    Request,
    Challenge { server_salt: u64 },
    Connected,
    Done(DisconnectReason),
}

/// Connects to one server.
pub struct ClientEndpoint {
    transport: Box<dyn Transport>,
    pub conditioner: Conditioner,
    pub server: SocketAddr,
    cfg: ConnectionConfig,
    protocol: u64,
    salt: u64,
    phase: Phase,
    started: f64,
    last_try: f64,
    pub conn: Option<Connection>,
    pub id: Option<ClientId>,
    /// Server tick and rate from ACCEPT.
    pub accept_tick: u32,
    pub tick_hz: u16,
    buf: Vec<u8>,
    out: Vec<u8>,
    just_connected: bool,
}

impl ClientEndpoint {
    pub fn new(transport: Box<dyn Transport>, server: SocketAddr, cfg: ConnectionConfig, protocol: u64, seed: u64, now: f64) -> Self {
        let mut rng = Rng::new(seed ^ 0x00c1_1e47);
        ClientEndpoint {
            transport,
            conditioner: Conditioner::new(LinkConditioner::default()),
            server,
            cfg,
            protocol,
            salt: rng.next_u64() | 1,
            phase: Phase::Request,
            started: now,
            last_try: f64::NEG_INFINITY,
            conn: None,
            id: None,
            accept_tick: 0,
            tick_hz: 60,
            buf: Vec::with_capacity(1500),
            out: Vec::with_capacity(64),
            just_connected: false,
        }
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.transport.local_addr()
    }

    pub fn status(&self) -> ClientStatus {
        match self.phase {
            Phase::Request | Phase::Challenge { .. } => ClientStatus::Connecting,
            Phase::Connected => ClientStatus::Connected,
            Phase::Done(r) => ClientStatus::Disconnected(r),
        }
    }

    /// True once, on the update the ACCEPT arrived.
    pub fn take_just_connected(&mut self) -> bool {
        std::mem::take(&mut self.just_connected)
    }

    fn raw_send(&mut self, now: f64) {
        let out = std::mem::take(&mut self.out);
        self.conditioner.send(self.transport.as_mut(), now, self.server, &out);
        self.out = out;
    }

    pub fn update(&mut self, now: f64) {
        self.conditioner.flush(self.transport.as_mut(), now);
        let mut buf = std::mem::take(&mut self.buf);
        while let Some(from) = self.transport.recv(&mut buf) {
            if from == self.server && !buf.is_empty() {
                let _ = self.handle(now, &buf);
            }
        }
        self.buf = buf;
        match self.phase {
            Phase::Request | Phase::Challenge { .. } => {
                if now - self.started > f64::from(self.cfg.timeout_s) {
                    self.phase = Phase::Done(DisconnectReason::ConnectTimeout);
                } else if now - self.last_try >= RESEND {
                    self.last_try = now;
                    self.out.clear();
                    match self.phase {
                        Phase::Request => {
                            self.out.put_u8(kind::CONNECT_REQUEST);
                            self.out.put_u64(self.protocol);
                            self.out.put_u64(self.salt);
                        }
                        Phase::Challenge { server_salt } => {
                            self.out.put_u8(kind::CHALLENGE_RESPONSE);
                            self.out.put_u64(self.salt);
                            self.out.put_u64(server_salt);
                        }
                        _ => {}
                    }
                    self.raw_send(now);
                }
            }
            Phase::Connected => {
                let conn = self.conn.as_ref().unwrap();
                if conn.error {
                    self.close(now, DisconnectReason::ProtocolError);
                } else if conn.timed_out(now) {
                    self.phase = Phase::Done(DisconnectReason::Timeout);
                    self.conn = None;
                }
            }
            Phase::Done(_) => {}
        }
    }

    fn handle(&mut self, now: f64, p: &[u8]) -> WireResult<()> {
        let mut r = Reader::new(p);
        match (r.u8()?, &self.phase) {
            (kind::PAYLOAD, Phase::Connected) => {
                let s = r.u32()?;
                let conn = self.conn.as_mut().unwrap();
                if s == conn.session && conn.receive(now, p).is_err() {
                    conn.error = true;
                }
            }
            (kind::CHALLENGE, Phase::Request) => {
                let cs = r.u64()?;
                let ss = r.u64()?;
                if cs == self.salt {
                    self.phase = Phase::Challenge { server_salt: ss };
                    self.last_try = f64::NEG_INFINITY;
                }
            }
            (kind::ACCEPT, Phase::Challenge { server_salt }) => {
                let ss = *server_salt;
                let cs = r.u64()?;
                if cs != self.salt {
                    return Ok(());
                }
                self.id = Some(ClientId(r.u32()?));
                self.accept_tick = r.u32()?;
                self.tick_hz = r.u16()?;
                self.conn = Some(Connection::new(session(cs, ss), self.cfg, now));
                self.phase = Phase::Connected;
                self.just_connected = true;
            }
            (kind::DENY, Phase::Request | Phase::Challenge { .. }) => {
                if r.u64()? == self.salt {
                    self.phase = Phase::Done(DisconnectReason::from_code(r.u8()?));
                }
            }
            (kind::DISCONNECT, Phase::Connected) => {
                let s = r.u32()?;
                let reason = r.u8()?;
                if self.conn.as_ref().is_some_and(|c| c.session == s) {
                    let reason = DisconnectReason::from_code(reason);
                    self.phase = Phase::Done(if reason == DisconnectReason::Requested { DisconnectReason::Kicked } else { reason });
                    self.conn = None;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Leave (the server is told) — status becomes `Disconnected(reason)`.
    pub fn close(&mut self, now: f64, reason: DisconnectReason) {
        if let Some(c) = self.conn.take() {
            self.out.clear();
            self.out.put_u8(kind::DISCONNECT);
            self.out.put_u32(c.session);
            self.out.put_u8(reason.code());
            for _ in 0..3 {
                self.raw_send(now);
            }
            self.conditioner.flush(self.transport.as_mut(), f64::INFINITY);
        }
        if !matches!(self.phase, Phase::Done(_)) {
            self.phase = Phase::Done(reason);
        }
    }

    pub fn send(&mut self, channel: u8, data: &[u8]) -> Result<(), SendError> {
        match &mut self.conn {
            Some(c) => c.send(channel, data),
            None => Ok(()),
        }
    }

    pub fn flush(&mut self, now: f64) {
        let transport = self.transport.as_mut();
        let cond = &mut self.conditioner;
        if let Some(c) = &mut self.conn {
            let addr = self.server;
            c.conn_flush(now, transport, cond, addr);
        }
        cond.flush(transport, now);
    }

    pub fn stats(&self) -> Option<ConnStats> {
        self.conn.as_ref().map(Connection::stats)
    }
}

impl Connection {
    fn conn_flush(&mut self, now: f64, t: &mut dyn Transport, cond: &mut Conditioner, addr: SocketAddr) {
        self.flush(now, &mut |p| cond.send(t, now, addr, p));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::connection::ch;
    use crate::net::transport::LoopbackNet;

    fn pump(s: &mut ServerEndpoint, cs: &mut [&mut ClientEndpoint], now: f64) {
        s.update(now);
        for c in cs.iter_mut() {
            c.update(now);
        }
        s.flush(now);
        for c in cs.iter_mut() {
            c.flush(now);
        }
    }

    #[test]
    fn handshake_messages_disconnect_and_deny() {
        let net = LoopbackNet::new();
        let cfg = ConnectionConfig::default();
        let mut s = ServerEndpoint::new(Box::new(net.bind(7777)), cfg, 42, 1, 1);
        let mut a = ClientEndpoint::new(Box::new(net.bind(0)), s.local_addr(), cfg, 42, 2, 0.0);
        let mut bad = ClientEndpoint::new(Box::new(net.bind(0)), s.local_addr(), cfg, 41, 3, 0.0);
        let mut now = 0.0;
        for _ in 0..10 {
            now += 1.0 / 60.0;
            pump(&mut s, &mut [&mut a, &mut bad], now);
        }
        assert_eq!(a.status(), ClientStatus::Connected);
        assert_eq!(bad.status(), ClientStatus::Disconnected(DisconnectReason::ProtocolMismatch));
        assert_eq!(s.drain_events().collect::<Vec<_>>(), vec![ServerEvent::Connected(ClientId(1))]);

        // Full: a second good client is denied.
        let mut c = ClientEndpoint::new(Box::new(net.bind(0)), s.local_addr(), cfg, 42, 4, now);
        a.send(ch::RELIABLE, b"hello").unwrap();
        for _ in 0..10 {
            now += 1.0 / 60.0;
            pump(&mut s, &mut [&mut a, &mut c], now);
        }
        assert_eq!(c.status(), ClientStatus::Disconnected(DisconnectReason::ServerFull));
        let mut got = Vec::new();
        s.client_mut(ClientId(1)).unwrap().conn.drain_received(|_, d| got.push(d.to_vec()));
        assert_eq!(got, vec![b"hello".to_vec()]);

        // Client leaves → server sees RemoteClosed.
        a.close(now, DisconnectReason::Requested);
        now += 0.02;
        pump(&mut s, &mut [], now);
        assert_eq!(s.drain_events().collect::<Vec<_>>(), vec![ServerEvent::Disconnected(ClientId(1), DisconnectReason::RemoteClosed)]);
        assert!(s.is_empty());
    }

    #[test]
    fn timeout_and_kick() {
        let net = LoopbackNet::new();
        let cfg = ConnectionConfig { timeout_s: 1.0, ..Default::default() };
        let mut s = ServerEndpoint::new(Box::new(net.bind(1)), cfg, 1, 8, 1);
        let mut a = ClientEndpoint::new(Box::new(net.bind(0)), s.local_addr(), cfg, 1, 2, 0.0);
        let mut b = ClientEndpoint::new(Box::new(net.bind(0)), s.local_addr(), cfg, 1, 3, 0.0);
        let mut now = 0.0;
        for _ in 0..10 {
            now += 1.0 / 60.0;
            pump(&mut s, &mut [&mut a, &mut b], now);
        }
        assert_eq!(s.len(), 2);
        s.drain_events().for_each(drop);
        let bid = b.id.unwrap();
        s.disconnect(now, bid, DisconnectReason::Kicked);
        // a goes silent: only the server runs.
        for _ in 0..90 {
            now += 1.0 / 60.0;
            s.update(now);
            s.flush(now);
            b.update(now);
        }
        assert_eq!(b.status(), ClientStatus::Disconnected(DisconnectReason::Kicked));
        let ev: Vec<_> = s.drain_events().collect();
        assert!(ev.contains(&ServerEvent::Disconnected(a.id.unwrap(), DisconnectReason::Timeout)), "{ev:?}");
        // a wakes up: drains what queued meanwhile, then hears nothing more.
        for k in 1..=90 {
            a.update(now + f64::from(k) / 60.0);
        }
        assert_eq!(a.status(), ClientStatus::Disconnected(DisconnectReason::Timeout));
    }

    #[test]
    fn connect_timeout_when_no_server() {
        let net = LoopbackNet::new();
        let cfg = ConnectionConfig { timeout_s: 0.5, ..Default::default() };
        let mut a = ClientEndpoint::new(Box::new(net.bind(0)), "127.0.0.1:9".parse().unwrap(), cfg, 1, 2, 0.0);
        let mut now = 0.0;
        while now < 0.6 {
            now += 0.05;
            a.update(now);
        }
        assert_eq!(a.status(), ClientStatus::Disconnected(DisconnectReason::ConnectTimeout));
    }
}
