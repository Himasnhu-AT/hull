//! `SessionTransport`: one UDP socket that carries relay control packets *and* game packets, so
//! the NAT mapping the relay saw is the one peers punch through. It hides the path from the net
//! layer:
//!
//! - a guest names its host [`VIRT_HOST`]; packets go direct once a punch worked, through the
//!   relay (`RelayUp`) when it did not;
//! - a host sees direct guests under their real address and relayed guests under a virtual
//!   `198.18.x.y` address it maps back to the guest's real address for `RelayTo`.
//!
//! [`SimNat`] wraps any transport to behave like a NAT/firewall (for tests and `net.*` tooling).

use std::collections::{HashSet, VecDeque};
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bevy::platform::collections::HashMap;

use super::proto::{Msg, is_control};
use crate::net::transport::Transport;

/// What a guest calls its host (a reserved documentation address; never on the wire).
pub const VIRT_HOST: SocketAddr = SocketAddr::new(std::net::IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), 9);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Host,
    Guest,
}

/// The guest's current path to its host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// Not known yet: game packets are dropped (the handshake retries).
    Pending,
    Direct(SocketAddr),
    Relayed,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PathStats {
    pub direct_tx: u64,
    pub direct_rx: u64,
    pub relayed_tx: u64,
    pub relayed_rx: u64,
    pub dropped_unrouted: u64,
}

pub struct Shared {
    pub role: Role,
    pub code: String,
    pub route: Route,
    /// Control packets queued by the session driver, sent on the next transport call.
    pub outbox: Vec<(SocketAddr, Vec<u8>)>,
    /// Control messages for the driver, with the sender's address.
    pub inbox: VecDeque<(SocketAddr, Msg)>,
    /// Host: virtual -> real address of relayed guests.
    virt: HashMap<SocketAddr, SocketAddr>,
    real_to_virt: HashMap<SocketAddr, SocketAddr>,
    pub stats: PathStats,
}

pub type SharedRef = Arc<Mutex<Shared>>;

impl Shared {
    pub fn new(role: Role) -> SharedRef {
        Arc::new(Mutex::new(Shared {
            role,
            code: String::new(),
            route: Route::Pending,
            outbox: Vec::new(),
            inbox: VecDeque::new(),
            virt: HashMap::default(),
            real_to_virt: HashMap::default(),
            stats: PathStats::default(),
        }))
    }

    pub fn push(&mut self, to: SocketAddr, m: &Msg) {
        self.outbox.push((to, m.encode()));
    }

    fn virt_for(&mut self, real: SocketAddr) -> SocketAddr {
        if let Some(v) = self.real_to_virt.get(&real) {
            return *v;
        }
        let n = self.virt.len() as u32 + 1;
        let v = SocketAddr::new(std::net::IpAddr::V4(Ipv4Addr::new(198, 18, (n >> 8) as u8, n as u8)), 7);
        self.virt.insert(v, real);
        self.real_to_virt.insert(real, v);
        v
    }

    /// Real addresses of the guests this host serves through the relay.
    pub fn relayed_guests(&self) -> usize {
        self.virt.len()
    }
}

pub struct SessionTransport {
    inner: Box<dyn Transport>,
    relay: SocketAddr,
    shared: SharedRef,
}

impl SessionTransport {
    pub fn new(inner: Box<dyn Transport>, relay: SocketAddr, shared: SharedRef) -> Self {
        SessionTransport { inner, relay, shared }
    }

    fn flush(&mut self) {
        let out = std::mem::take(&mut self.shared.lock().unwrap().outbox);
        for (to, p) in out {
            let _ = self.inner.send(to, &p);
        }
    }
}

impl Transport for SessionTransport {
    fn send(&mut self, to: SocketAddr, packet: &[u8]) -> io::Result<()> {
        self.flush();
        let (dest, wrapped) = {
            let mut sh = self.shared.lock().unwrap();
            match sh.role {
                Role::Guest => {
                    if to != VIRT_HOST {
                        return Err(io::Error::other("guest sends only to its host"));
                    }
                    match sh.route {
                        Route::Pending => {
                            sh.stats.dropped_unrouted += 1;
                            return Ok(());
                        }
                        Route::Direct(a) => {
                            sh.stats.direct_tx += 1;
                            (a, None)
                        }
                        Route::Relayed => {
                            sh.stats.relayed_tx += 1;
                            let m = Msg::RelayUp { code: sh.code.clone(), payload: packet.to_vec() };
                            (self.relay, Some(m.encode()))
                        }
                    }
                }
                Role::Host => match sh.virt.get(&to).copied() {
                    Some(real) => {
                        sh.stats.relayed_tx += 1;
                        let m = Msg::RelayTo { code: sh.code.clone(), to: real, payload: packet.to_vec() };
                        (self.relay, Some(m.encode()))
                    }
                    None => {
                        sh.stats.direct_tx += 1;
                        (to, None)
                    }
                },
            }
        };
        self.inner.send(dest, wrapped.as_deref().unwrap_or(packet))
    }

    fn recv(&mut self, buf: &mut Vec<u8>) -> Option<SocketAddr> {
        self.flush();
        loop {
            let from = self.inner.recv(buf)?;
            if !is_control(buf) {
                let mut sh = self.shared.lock().unwrap();
                match (sh.role, sh.route) {
                    (Role::Host, _) => {
                        sh.stats.direct_rx += 1;
                        return Some(from);
                    }
                    (Role::Guest, Route::Direct(a)) if a == from => {
                        sh.stats.direct_rx += 1;
                        return Some(VIRT_HOST);
                    }
                    _ => continue, // unsolicited
                }
            }
            let Some(m) = Msg::decode(buf) else { continue };
            let mut sh = self.shared.lock().unwrap();
            match m {
                Msg::Relayed { from: origin, payload } if from == self.relay => {
                    sh.stats.relayed_rx += 1;
                    let src = match sh.role {
                        Role::Host => sh.virt_for(origin),
                        Role::Guest if sh.route == Route::Relayed => VIRT_HOST,
                        Role::Guest => continue,
                    };
                    *buf = payload;
                    return Some(src);
                }
                Msg::Punch { nonce, ack: false } => {
                    // Answer at once: the reply also opens our NAT towards `from`.
                    sh.push(from, &Msg::Punch { nonce, ack: true });
                    sh.inbox.push_back((from, Msg::Punch { nonce, ack: false }));
                    drop(sh);
                    self.flush();
                }
                other => sh.inbox.push_back((from, other)),
            }
        }
    }

    fn local_addr(&self) -> SocketAddr {
        self.inner.local_addr()
    }
}

// ---------------------------------------------------------------------------------------------
// NAT simulation

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NatKind {
    /// No filtering.
    Open,
    /// Drops packets from addresses this socket has not sent to (hole punching works).
    PortRestricted,
    /// Only the allowed addresses (the relay) may talk to this socket in either direction:
    /// punching is impossible, the relay path must be used.
    Strict,
}

/// A transport that behaves like a NAT in front of `T`.
pub struct SimNat<T: Transport> {
    inner: T,
    kind: NatKind,
    sent_to: HashSet<SocketAddr>,
    allow: HashSet<SocketAddr>,
    dropped: Arc<AtomicU64>,
}

impl<T: Transport> SimNat<T> {
    pub fn new(inner: T, kind: NatKind) -> Self {
        SimNat { inner, kind, sent_to: HashSet::new(), allow: HashSet::new(), dropped: Arc::new(AtomicU64::new(0)) }
    }

    /// Always reachable (and allowed to send to), e.g. the relay.
    pub fn allow(mut self, a: SocketAddr) -> Self {
        self.allow.insert(a);
        self
    }

    /// Counter of packets this "NAT" dropped (shared; read it after the transport moved).
    pub fn dropped(&self) -> Arc<AtomicU64> {
        self.dropped.clone()
    }
}

impl<T: Transport> Transport for SimNat<T> {
    fn send(&mut self, to: SocketAddr, packet: &[u8]) -> io::Result<()> {
        if self.kind == NatKind::Strict && !self.allow.contains(&to) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        self.sent_to.insert(to);
        self.inner.send(to, packet)
    }

    fn recv(&mut self, buf: &mut Vec<u8>) -> Option<SocketAddr> {
        loop {
            let from = self.inner.recv(buf)?;
            let ok = match self.kind {
                NatKind::Open => true,
                NatKind::PortRestricted => self.sent_to.contains(&from) || self.allow.contains(&from),
                NatKind::Strict => self.allow.contains(&from),
            };
            if ok {
                return Some(from);
            }
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn local_addr(&self) -> SocketAddr {
        self.inner.local_addr()
    }
}
