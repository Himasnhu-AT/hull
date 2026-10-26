//! Datagram transports and the link conditioner.
//!
//! - [`Transport`]: unreliable, unordered datagrams to/from `SocketAddr`s. Everything above
//!   (handshake, acks, channels) is transport-agnostic.
//! - [`LoopbackNet`]: in-memory hub for tests — any number of endpoints in one process, no
//!   sockets, no threads, fully deterministic.
//! - [`UdpTransport`]: `std::net::UdpSocket`, nonblocking, polled once per frame.
//! - [`Conditioner`]: latency / jitter / loss / duplication / reordering on the *send* path of
//!   any transport ([`LinkConditioner`] settings, seeded RNG). Set it on both peers to degrade
//!   both directions.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};
use std::io;
use std::net::{SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};

use bevy::platform::collections::HashMap;

use super::wire::Rng;

/// Largest datagram any transport hands up (bigger ones are dropped by the protocol anyway).
pub const MAX_DATAGRAM: usize = 1500;

/// An unreliable datagram socket.
pub trait Transport: Send + Sync + 'static {
    /// Queue one datagram. Errors are reported but the protocol treats them as loss.
    fn send(&mut self, to: SocketAddr, packet: &[u8]) -> io::Result<()>;
    /// Next waiting datagram into `buf` (replacing its contents), or `None`.
    fn recv(&mut self, buf: &mut Vec<u8>) -> Option<SocketAddr>;
    fn local_addr(&self) -> SocketAddr;
}

// ---------------------------------------------------------------------------------------------
// Loopback

#[derive(Default)]
struct Hub {
    inboxes: HashMap<SocketAddr, VecDeque<(SocketAddr, Vec<u8>)>>,
    /// Recycled packet buffers (no allocation per packet once warm).
    pool: Vec<Vec<u8>>,
    next_port: u16,
}

/// In-memory datagram network. Clone it into every app of a test; [`Self::bind`] endpoints.
#[derive(Clone, Default)]
pub struct LoopbackNet(Arc<Mutex<Hub>>);

impl LoopbackNet {
    pub fn new() -> Self {
        Self::default()
    }

    /// An endpoint at `127.0.0.1:<port>` (`0` picks a free port).
    pub fn bind(&self, port: u16) -> LoopbackTransport {
        let mut hub = self.0.lock().unwrap();
        let port = if port == 0 {
            loop {
                hub.next_port = hub.next_port.wrapping_add(1).max(40000);
                let a = SocketAddr::from(([127, 0, 0, 1], hub.next_port));
                if !hub.inboxes.contains_key(&a) {
                    break hub.next_port;
                }
            }
        } else {
            port
        };
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        hub.inboxes.entry(addr).or_default();
        LoopbackTransport { net: self.clone(), addr }
    }

    /// Datagrams waiting in all inboxes.
    pub fn in_flight(&self) -> usize {
        self.0.lock().unwrap().inboxes.values().map(VecDeque::len).sum()
    }
}

/// One endpoint of a [`LoopbackNet`]. Dropping it unbinds the address.
pub struct LoopbackTransport {
    net: LoopbackNet,
    addr: SocketAddr,
}

impl Transport for LoopbackTransport {
    fn send(&mut self, to: SocketAddr, packet: &[u8]) -> io::Result<()> {
        let mut hub = self.net.0.lock().unwrap();
        let mut buf = hub.pool.pop().unwrap_or_default();
        buf.clear();
        buf.extend_from_slice(packet);
        match hub.inboxes.get_mut(&to) {
            Some(q) => q.push_back((self.addr, buf)),
            // Nobody bound there: silently lost, like UDP.
            None => hub.pool.push(buf),
        }
        Ok(())
    }

    fn recv(&mut self, buf: &mut Vec<u8>) -> Option<SocketAddr> {
        let mut hub = self.net.0.lock().unwrap();
        let (from, data) = hub.inboxes.get_mut(&self.addr)?.pop_front()?;
        let old = std::mem::replace(buf, data);
        hub.pool.push(old);
        Some(from)
    }

    fn local_addr(&self) -> SocketAddr {
        self.addr
    }
}

impl Drop for LoopbackTransport {
    fn drop(&mut self) {
        if let Ok(mut hub) = self.net.0.lock() {
            hub.inboxes.remove(&self.addr);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// UDP

/// Nonblocking `std::net` UDP socket.
pub struct UdpTransport {
    socket: UdpSocket,
    addr: SocketAddr,
}

impl UdpTransport {
    /// Bind e.g. `"0.0.0.0:7777"` (server) or `"0.0.0.0:0"` (client).
    pub fn bind(addr: SocketAddr) -> io::Result<Self> {
        let socket = UdpSocket::bind(addr)?;
        socket.set_nonblocking(true)?;
        let addr = socket.local_addr()?;
        Ok(UdpTransport { socket, addr })
    }
}

impl Transport for UdpTransport {
    fn send(&mut self, to: SocketAddr, packet: &[u8]) -> io::Result<()> {
        self.socket.send_to(packet, to).map(|_| ())
    }

    fn recv(&mut self, buf: &mut Vec<u8>) -> Option<SocketAddr> {
        buf.resize(MAX_DATAGRAM, 0);
        loop {
            match self.socket.recv_from(buf) {
                Ok((n, from)) => {
                    buf.truncate(n);
                    return Some(from);
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    buf.clear();
                    return None;
                }
                // ICMP port-unreachable surfaces as ConnectionReset on some OSes: skip it.
                Err(e) if matches!(e.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::Interrupted) => continue,
                Err(_) => {
                    buf.clear();
                    return None;
                }
            }
        }
    }

    fn local_addr(&self) -> SocketAddr {
        self.addr
    }
}

// ---------------------------------------------------------------------------------------------
// Link conditioner

/// Simulated bad network on the send path. All zero = off (packets go straight out).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct LinkConditioner {
    /// One-way added latency.
    pub latency_ms: f32,
    /// Uniform extra delay in `[0, jitter_ms]` (reorders packets when larger than the send interval).
    pub jitter_ms: f32,
    /// Drop probability 0..1.
    pub loss: f32,
    /// Probability a packet is sent twice.
    pub duplicate: f32,
    /// Probability a packet is held back an extra `latency + jitter + 20 ms` (forced reorder).
    pub reorder: f32,
    pub seed: u64,
}

impl Default for LinkConditioner {
    fn default() -> Self {
        LinkConditioner { latency_ms: 0.0, jitter_ms: 0.0, loss: 0.0, duplicate: 0.0, reorder: 0.0, seed: 1 }
    }
}

impl LinkConditioner {
    pub fn is_off(&self) -> bool {
        self.latency_ms <= 0.0 && self.jitter_ms <= 0.0 && self.loss <= 0.0 && self.duplicate <= 0.0 && self.reorder <= 0.0
    }
}

struct Delayed {
    at: f64,
    order: u64,
    to: SocketAddr,
    data: Vec<u8>,
}

impl PartialEq for Delayed {
    fn eq(&self, o: &Self) -> bool {
        self.order == o.order
    }
}
impl Eq for Delayed {}
impl PartialOrd for Delayed {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Delayed {
    // Min-heap on (at, order).
    fn cmp(&self, o: &Self) -> Ordering {
        o.at.total_cmp(&self.at).then(o.order.cmp(&self.order))
    }
}

/// Applies a [`LinkConditioner`] in front of a transport's `send`.
pub struct Conditioner {
    pub settings: LinkConditioner,
    rng: Rng,
    queue: BinaryHeap<Delayed>,
    pool: Vec<Vec<u8>>,
    order: u64,
    /// Packets dropped by simulated loss.
    pub dropped: u64,
    pub duplicated: u64,
}

impl Conditioner {
    pub fn new(settings: LinkConditioner) -> Self {
        Conditioner { settings, rng: Rng::new(settings.seed), queue: BinaryHeap::new(), pool: Vec::new(), order: 0, dropped: 0, duplicated: 0 }
    }

    pub fn set(&mut self, settings: LinkConditioner) {
        if settings.seed != self.settings.seed {
            self.rng = Rng::new(settings.seed);
        }
        self.settings = settings;
    }

    /// Send through the conditioner at time `now` (seconds).
    pub fn send(&mut self, t: &mut dyn Transport, now: f64, to: SocketAddr, packet: &[u8]) {
        let s = self.settings;
        if s.is_off() && self.queue.is_empty() {
            let _ = t.send(to, packet);
            return;
        }
        if self.rng.chance(s.loss) {
            self.dropped += 1;
            return;
        }
        let copies = if self.rng.chance(s.duplicate) {
            self.duplicated += 1;
            2
        } else {
            1
        };
        for _ in 0..copies {
            let mut delay = s.latency_ms + s.jitter_ms * self.rng.next_f32();
            if self.rng.chance(s.reorder) {
                delay += s.latency_ms + s.jitter_ms + 20.0;
            }
            let mut data = self.pool.pop().unwrap_or_default();
            data.clear();
            data.extend_from_slice(packet);
            self.order += 1;
            self.queue.push(Delayed { at: now + f64::from(delay) / 1000.0, order: self.order, to, data });
        }
        self.flush(t, now);
    }

    /// Release packets whose delay has passed. Call every frame.
    pub fn flush(&mut self, t: &mut dyn Transport, now: f64) {
        while self.queue.peek().is_some_and(|d| d.at <= now) {
            let d = self.queue.pop().unwrap();
            let _ = t.send(d.to, &d.data);
            self.pool.push(d.data);
        }
    }

    pub fn queued(&self) -> usize {
        self.queue.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_delivers_and_unbinds() {
        let net = LoopbackNet::new();
        let mut a = net.bind(1);
        let mut b = net.bind(0);
        a.send(b.local_addr(), b"hi").unwrap();
        let mut buf = Vec::new();
        assert_eq!(b.recv(&mut buf), Some(a.local_addr()));
        assert_eq!(buf, b"hi");
        assert_eq!(b.recv(&mut buf), None);
        let to = b.local_addr();
        drop(b);
        a.send(to, b"lost").unwrap();
        assert_eq!(net.in_flight(), 0);
    }

    #[test]
    fn conditioner_delays_drops_and_duplicates_deterministically() {
        let net = LoopbackNet::new();
        let mut a = net.bind(1);
        let mut b = net.bind(2);
        let mut c = Conditioner::new(LinkConditioner { latency_ms: 50.0, loss: 0.2, duplicate: 0.1, seed: 9, ..Default::default() });
        for i in 0..1000u32 {
            c.send(&mut a, 0.0, b.local_addr(), &i.to_le_bytes());
        }
        let mut buf = Vec::new();
        assert!(b.recv(&mut buf).is_none(), "nothing before the latency passed");
        c.flush(&mut a, 0.049);
        assert!(b.recv(&mut buf).is_none());
        c.flush(&mut a, 0.051);
        let mut n = 0;
        while b.recv(&mut buf).is_some() {
            n += 1;
        }
        assert_eq!(n as u64, 1000 - c.dropped + c.duplicated);
        assert!((150..250).contains(&c.dropped), "~20% loss: {}", c.dropped);
        assert!((50..150).contains(&c.duplicated), "~10% dup: {}", c.duplicated);
    }

    #[test]
    fn udp_round_trip() {
        let Ok(mut a) = UdpTransport::bind("127.0.0.1:0".parse().unwrap()) else { return };
        let mut b = UdpTransport::bind("127.0.0.1:0".parse().unwrap()).unwrap();
        a.send(b.local_addr(), b"ping").unwrap();
        let mut buf = Vec::new();
        let t0 = std::time::Instant::now();
        loop {
            if let Some(from) = b.recv(&mut buf) {
                assert_eq!(from, a.local_addr());
                assert_eq!(buf, b"ping");
                break;
            }
            assert!(t0.elapsed().as_secs() < 2, "udp packet never arrived");
            std::thread::yield_now();
        }
    }
}
