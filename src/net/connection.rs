//! One peer-to-peer link after the handshake: packet sequence numbers + ack bitfields, RTT,
//! channels (reliable-ordered with resend/window/fragmentation, unreliable with fragmentation,
//! unreliable-sequenced), a token-bucket bandwidth limit and stats.
//!
//! Payload packet:
//! ```text
//! u8 kind=PAYLOAD | u32 session | u16 seq | u16 ack | u32 ack_bits | entry*
//! entry: u8 tag (channel in bits 0-3, FRAG = bit 4)
//!        reliable:   u16 msg id [, varint fragments_left]
//!        sequenced:  u16 seq
//!        unreliable: [u16 group, u8 index, u8 count]   (FRAG only)
//!        varint len, bytes
//! ```
//! Reliable messages larger than [`FRAGMENT_SIZE`] become consecutive message ids marked with
//! how many fragments follow; ordered delivery makes reassembly trivial. Unreliable messages
//! larger than a packet are split into a fragment group that is dropped if any part is lost.
//!
//! Steady state allocates nothing: packet buffers, per-packet ack records, reliable message
//! buffers and the receive arena are all recycled.

use std::collections::VecDeque;

use super::wire::{Put, Reader, WireError, WireResult, seq_diff, seq_gt, var_len};

/// Packet kinds (first byte of every datagram).
pub(crate) mod kind {
    pub const CONNECT_REQUEST: u8 = 1;
    pub const CHALLENGE: u8 = 2;
    pub const CHALLENGE_RESPONSE: u8 = 3;
    pub const ACCEPT: u8 = 4;
    pub const DENY: u8 = 5;
    pub const PAYLOAD: u8 = 6;
    pub const DISCONNECT: u8 = 7;
}

/// Wire channel ids. Games use [`Channel`]; 3 and 4 are internal.
pub(crate) mod ch {
    pub const RELIABLE: u8 = 0;
    pub const UNRELIABLE: u8 = 1;
    pub const SEQUENCED: u8 = 2;
    /// Replication snapshots (unreliable, ack-tracked).
    pub const SNAPSHOT: u8 = 3;
    /// Client inputs (unreliable, redundant).
    pub const INPUT: u8 = 4;
    pub const COUNT: u8 = 5;
}

/// Delivery guarantee for game messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum Channel {
    /// Arrives exactly once, in send order; any size up to `max_message_size` (fragmented).
    Reliable,
    /// May be lost or reordered; large messages are fragmented (all parts or nothing).
    Unreliable,
    /// May be lost; older-than-newest arrivals are dropped. Must fit one packet.
    Sequenced,
}

impl Channel {
    pub(crate) fn id(self) -> u8 {
        match self {
            Channel::Reliable => ch::RELIABLE,
            Channel::Unreliable => ch::UNRELIABLE,
            Channel::Sequenced => ch::SEQUENCED,
        }
    }
}

const FRAG: u8 = 0x10;
/// Payload bytes per reliable fragment.
pub const FRAGMENT_SIZE: usize = 1024;
/// `kind + session + seq + ack + ack_bits`.
pub const PACKET_HEADER: usize = 1 + 4 + 2 + 2 + 4;
const ACK_RING: usize = 1024;

/// Per-link settings (part of [`super::NetConfig`]).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ConnectionConfig {
    /// Largest datagram sent (bytes). 1200 stays under every real-world path MTU.
    pub mtu: usize,
    /// No packet for this long → disconnect ([`DisconnectReason::Timeout`]).
    pub timeout_s: f32,
    /// Send an empty packet when idle this long.
    pub keepalive_s: f32,
    /// Outgoing bandwidth cap (token bucket; bytes per second). Reliable data waits, unreliable
    /// data over budget is dropped, acks always go out.
    pub bytes_per_sec: u32,
    /// Reliable messages in flight (unacked) at once.
    pub reliable_window: u16,
    /// Reliable messages queued (incl. in flight) before the link is dropped as overloaded.
    pub max_reliable_queue: usize,
    /// Largest single message (bytes, after fragment reassembly).
    pub max_message_size: usize,
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        ConnectionConfig {
            mtu: 1200,
            timeout_s: 5.0,
            keepalive_s: 0.25,
            bytes_per_sec: 128 * 1024,
            reliable_window: 256,
            max_reliable_queue: 8192,
            max_message_size: 1 << 20,
        }
    }
}

/// Why a link ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum DisconnectReason {
    /// The local side called disconnect.
    Requested,
    /// The remote side said goodbye.
    RemoteClosed,
    Timeout,
    /// Handshake did not finish within `timeout_s`.
    ConnectTimeout,
    /// Different game build / registered replication set.
    ProtocolMismatch,
    ServerFull,
    Kicked,
    ServerShutdown,
    /// The peer sent garbage or overflowed the reliable queue.
    ProtocolError,
}

impl DisconnectReason {
    pub(crate) fn code(self) -> u8 {
        self as u8
    }
    pub(crate) fn from_code(c: u8) -> Self {
        use DisconnectReason::*;
        [Requested, RemoteClosed, Timeout, ConnectTimeout, ProtocolMismatch, ServerFull, Kicked, ServerShutdown, ProtocolError]
            .get(c as usize)
            .copied()
            .unwrap_or(ProtocolError)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendError {
    TooLarge,
    /// Reliable queue full (the link will be dropped).
    QueueFull,
}

/// Link counters. Rates are over the last full second.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct ConnStats {
    pub rtt_ms: f32,
    pub rtt_var_ms: f32,
    pub packets_sent: u64,
    pub packets_recv: u64,
    pub packets_lost: u64,
    pub packets_dup: u64,
    pub bytes_sent: u64,
    pub bytes_recv: u64,
    pub send_bytes_per_sec: f32,
    pub recv_bytes_per_sec: f32,
    /// Lost / sent over the last second (0..1).
    pub loss: f32,
    pub reliable_resent: u64,
    pub reliable_in_flight: usize,
    /// Unreliable messages dropped because the bandwidth budget was spent.
    pub dropped_over_budget: u64,
}

#[derive(Default)]
struct SentPacket {
    seq: u16,
    live: bool,
    acked: bool,
    time: f64,
    reliable: Vec<u16>,
    tokens: Vec<u32>,
}

struct RelOut {
    id: u16,
    data: Vec<u8>,
    frags_left: u32,
    last_sent: f64,
    acked: bool,
}

struct UnrelOut {
    ch: u8,
    start: usize,
    len: usize,
    token: Option<u32>,
}

struct FragIn {
    group: u16,
    count: u8,
    have: u8,
    born: f64,
    parts: Vec<Option<(usize, usize)>>,
    buf: Vec<u8>,
}

pub struct Connection {
    pub session: u32,
    cfg: ConnectionConfig,
    // acks
    local_seq: u16,
    sent: Vec<SentPacket>,
    recv_ring: Vec<u32>,
    remote_seq: u16,
    have_remote: bool,
    loss_cursor: u16,
    newest_ack: Option<u16>,
    ack_pending: bool,
    // reliable out
    rel_out: VecDeque<RelOut>,
    rel_next_id: u16,
    rel_pool: Vec<Vec<u8>>,
    // reliable in
    rel_expect: u16,
    rel_slots: Vec<Option<(Vec<u8>, u32)>>,
    rel_assembling: Vec<u8>,
    // unreliable out (arena, cleared each flush)
    un_buf: Vec<u8>,
    un_out: Vec<UnrelOut>,
    seq_out: u16,
    seq_in: Option<u16>,
    frag_group: u16,
    frags_in: Vec<FragIn>,
    next_token: u32,
    /// Fragmented tracked messages: token → packets still unacked.
    frag_tokens: bevy::platform::collections::HashMap<u32, u32>,
    // delivered (arena, cleared by drain)
    in_buf: Vec<u8>,
    in_msgs: Vec<(u8, usize, usize)>,
    acked_tokens: Vec<u32>,
    // timing / budget
    pub(crate) last_recv: f64,
    last_send: f64,
    budget: f64,
    last_flush: Option<f64>,
    srtt: f64,
    rttvar: f64,
    pkt: Vec<u8>,
    // stats
    stats: ConnStats,
    window_start: f64,
    win_sent_bytes: u64,
    win_recv_bytes: u64,
    win_sent_pkts: u64,
    win_lost_pkts: u64,
    pub(crate) error: bool,
}

impl Connection {
    pub fn new(session: u32, cfg: ConnectionConfig, now: f64) -> Self {
        let window = cfg.reliable_window.clamp(8, 4096) as usize;
        Connection {
            session,
            cfg,
            local_seq: 0,
            sent: (0..ACK_RING).map(|_| SentPacket::default()).collect(),
            recv_ring: vec![u32::MAX; ACK_RING],
            remote_seq: 0,
            have_remote: false,
            loss_cursor: 0,
            newest_ack: None,
            ack_pending: false,
            rel_out: VecDeque::new(),
            rel_next_id: 0,
            rel_pool: Vec::new(),
            rel_expect: 0,
            rel_slots: (0..window).map(|_| None).collect(),
            rel_assembling: Vec::new(),
            un_buf: Vec::new(),
            un_out: Vec::new(),
            seq_out: 0,
            seq_in: None,
            frag_group: 0,
            frags_in: Vec::new(),
            next_token: 0,
            frag_tokens: Default::default(),
            in_buf: Vec::new(),
            in_msgs: Vec::new(),
            acked_tokens: Vec::new(),
            last_recv: now,
            last_send: f64::NEG_INFINITY,
            budget: cfg.bytes_per_sec as f64 * 0.05,
            last_flush: None,
            srtt: 0.1,
            rttvar: 0.025,
            pkt: Vec::with_capacity(cfg.mtu),
            stats: ConnStats::default(),
            window_start: now,
            win_sent_bytes: 0,
            win_recv_bytes: 0,
            win_sent_pkts: 0,
            win_lost_pkts: 0,
            error: false,
        }
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.cfg
    }

    pub fn set_bandwidth(&mut self, bytes_per_sec: u32) {
        self.cfg.bytes_per_sec = bytes_per_sec;
    }

    pub fn stats(&self) -> ConnStats {
        let mut s = self.stats;
        s.rtt_ms = (self.srtt * 1000.0) as f32;
        s.rtt_var_ms = (self.rttvar * 1000.0) as f32;
        s.reliable_in_flight = self.rel_out.len();
        s
    }

    /// Smoothed round-trip time (seconds).
    pub fn rtt(&self) -> f64 {
        self.srtt
    }

    /// Bytes the bandwidth budget allows in the next flush (minus what is already queued).
    pub fn budget_hint(&self, now: f64) -> usize {
        let dt = self.last_flush.map_or(0.0, |t| (now - t).max(0.0));
        let b = (self.budget + dt * self.cfg.bytes_per_sec as f64).min(self.burst());
        (b.max(0.0) as usize).saturating_sub(self.un_buf.len())
    }

    fn burst(&self) -> f64 {
        (self.cfg.bytes_per_sec as f64 * 0.1).max(self.cfg.mtu as f64 * 2.0)
    }

    /// Largest unfragmented payload that fits one packet.
    pub fn max_single(&self) -> usize {
        self.cfg.mtu - PACKET_HEADER - 1 - 2 - var_len(self.cfg.mtu as u64)
    }

    // ---- sending ----

    pub fn send(&mut self, channel: u8, data: &[u8]) -> Result<(), SendError> {
        if data.len() > self.cfg.max_message_size {
            return Err(SendError::TooLarge);
        }
        match channel {
            ch::RELIABLE => self.send_reliable(data),
            ch::SEQUENCED => {
                if data.len() > self.max_single() {
                    return Err(SendError::TooLarge);
                }
                self.queue_unreliable(channel, data, None);
                Ok(())
            }
            _ => {
                if data.len() > 255 * self.max_single() {
                    return Err(SendError::TooLarge);
                }
                self.queue_unreliable(channel, data, None);
                Ok(())
            }
        }
    }

    /// Unreliable send whose delivery is reported: the token shows up in
    /// [`Self::drain_acked_tokens`] once a packet carrying it was acked.
    pub fn send_tracked(&mut self, channel: u8, data: &[u8]) -> u32 {
        let t = self.next_token;
        self.next_token = self.next_token.wrapping_add(1);
        self.queue_unreliable(channel, data, Some(t));
        t
    }

    fn queue_unreliable(&mut self, ch: u8, data: &[u8], token: Option<u32>) {
        let start = self.un_buf.len();
        self.un_buf.extend_from_slice(data);
        self.un_out.push(UnrelOut { ch, start, len: data.len(), token });
    }

    fn send_reliable(&mut self, data: &[u8]) -> Result<(), SendError> {
        let n = data.len().div_ceil(FRAGMENT_SIZE).max(1);
        if self.rel_out.len() + n > self.cfg.max_reliable_queue {
            self.error = true;
            return Err(SendError::QueueFull);
        }
        for (i, chunk) in data.chunks(FRAGMENT_SIZE).chain(data.is_empty().then_some(&[][..])).enumerate() {
            let mut buf = self.rel_pool.pop().unwrap_or_default();
            buf.clear();
            buf.extend_from_slice(chunk);
            let id = self.rel_next_id;
            self.rel_next_id = id.wrapping_add(1);
            self.rel_out.push_back(RelOut { id, data: buf, frags_left: (n - 1 - i) as u32, last_sent: f64::NEG_INFINITY, acked: false });
        }
        Ok(())
    }

    fn rto(&self) -> f64 {
        (self.srtt + 4.0 * self.rttvar).clamp(0.03, 1.0)
    }

    fn begin_packet(&mut self, now: f64) {
        let seq = self.local_seq;
        let slot = &mut self.sent[seq as usize % ACK_RING];
        slot.seq = seq;
        slot.live = true;
        slot.acked = false;
        slot.time = now;
        slot.reliable.clear();
        slot.tokens.clear();
        self.pkt.clear();
        self.pkt.put_u8(kind::PAYLOAD);
        self.pkt.put_u32(self.session);
        self.pkt.put_u16(seq);
        let (ack, bits) = self.ack_fields();
        self.pkt.put_u16(ack);
        self.pkt.put_u32(bits);
    }

    fn finish_packet(&mut self, now: f64, out: &mut dyn FnMut(&[u8])) {
        out(&self.pkt);
        let n = self.pkt.len() as u64;
        self.local_seq = self.local_seq.wrapping_add(1);
        self.stats.packets_sent += 1;
        self.stats.bytes_sent += n;
        self.win_sent_bytes += n;
        self.win_sent_pkts += 1;
        self.budget -= n as f64;
        self.last_send = now;
        self.ack_pending = false;
    }

    fn ack_fields(&self) -> (u16, u32) {
        if !self.have_remote {
            return (0, 0);
        }
        let ack = self.remote_seq;
        let mut bits = 0u32;
        for i in 1..=32u16 {
            let s = ack.wrapping_sub(i);
            if self.recv_ring[s as usize % ACK_RING] == u32::from(s) {
                bits |= 1 << (i - 1);
            }
        }
        (ack, bits)
    }

    /// Room left in the current packet.
    fn room(&self) -> usize {
        self.cfg.mtu.saturating_sub(self.pkt.len())
    }

    /// Build and hand packets to `out`: reliable (new + due resends), then this frame's
    /// unreliable messages, then an ack/keepalive packet if nothing else went out.
    pub fn flush(&mut self, now: f64, out: &mut dyn FnMut(&[u8])) {
        let dt = self.last_flush.map_or(0.0, |t| (now - t).max(0.0));
        self.last_flush = Some(now);
        self.budget = (self.budget + dt * self.cfg.bytes_per_sec as f64).min(self.burst());
        self.roll_stats(now);

        let mut open = false;
        // Reliable.
        let rto = self.rto();
        let window = self.cfg.reliable_window.clamp(8, 4096) as usize;
        let mut i = 0;
        while i < self.rel_out.len().min(window) {
            let m = &self.rel_out[i];
            if m.acked || now - m.last_sent < rto {
                i += 1;
                continue;
            }
            let entry = 1 + 2 + if m.frags_left > 0 { var_len(m.frags_left as u64) } else { 0 } + var_len(m.data.len() as u64) + m.data.len();
            if !open || self.room() < entry {
                if open {
                    self.finish_packet(now, out);
                }
                if self.budget <= 0.0 {
                    open = false;
                    break;
                }
                self.begin_packet(now);
                open = true;
            }
            let m = &mut self.rel_out[i];
            if m.last_sent.is_finite() {
                self.stats.reliable_resent += 1;
            }
            m.last_sent = now;
            let tag = ch::RELIABLE | if m.frags_left > 0 { FRAG } else { 0 };
            self.pkt.put_u8(tag);
            self.pkt.put_u16(m.id);
            if m.frags_left > 0 {
                self.pkt.put_var(m.frags_left as u64);
            }
            self.pkt.put_bytes(&m.data);
            let seq = self.local_seq;
            self.sent[seq as usize % ACK_RING].reliable.push(m.id);
            i += 1;
        }

        // Unreliable / sequenced / snapshot / input.
        let single = self.max_single();
        let msgs = std::mem::take(&mut self.un_out);
        for m in &msgs {
            let data_start = m.start;
            if self.budget - if open { (self.cfg.mtu - self.room()) as f64 } else { 0.0 } < m.len as f64 {
                self.stats.dropped_over_budget += 1;
                continue;
            }
            if m.len <= single || m.ch == ch::SEQUENCED {
                let mut entry = 1 + var_len(m.len as u64) + m.len;
                if m.ch == ch::SEQUENCED {
                    entry += 2;
                }
                if !open || self.room() < entry {
                    if open {
                        self.finish_packet(now, out);
                    }
                    self.begin_packet(now);
                    open = true;
                }
                self.pkt.put_u8(m.ch);
                if m.ch == ch::SEQUENCED {
                    self.pkt.put_u16(self.seq_out);
                    self.seq_out = self.seq_out.wrapping_add(1);
                }
                self.pkt.put_bytes(&self.un_buf[data_start..data_start + m.len]);
            } else {
                let part = single - 4;
                let count = m.len.div_ceil(part);
                let group = self.frag_group;
                self.frag_group = self.frag_group.wrapping_add(1);
                for (idx, s) in (0..m.len).step_by(part).enumerate() {
                    let e = (s + part).min(m.len);
                    let entry = 1 + 4 + var_len((e - s) as u64) + (e - s);
                    if !open || self.room() < entry {
                        if open {
                            self.finish_packet(now, out);
                        }
                        self.begin_packet(now);
                        open = true;
                    }
                    self.pkt.put_u8(m.ch | FRAG);
                    self.pkt.put_u16(group);
                    self.pkt.put_u8(idx as u8);
                    self.pkt.put_u8(count as u8);
                    self.pkt.put_bytes(&self.un_buf[data_start + s..data_start + e]);
                    // A tracked fragmented message is acked when every packet carrying a part is.
                    if let Some(t) = m.token
                        && idx + 1 < count
                    {
                        let seq = self.local_seq;
                        self.sent[seq as usize % ACK_RING].tokens.push(t);
                        *self.frag_tokens.entry(t).or_insert(0) += 1;
                    }
                }
                if let Some(t) = m.token {
                    *self.frag_tokens.entry(t).or_insert(0) += 1;
                    if self.frag_tokens.len() > 4096 {
                        self.frag_tokens.clear(); // stale entries of never-acked groups
                    }
                }
            }
            if let Some(t) = m.token {
                let seq = self.local_seq;
                self.sent[seq as usize % ACK_RING].tokens.push(t);
            }
        }
        self.un_out = msgs;
        self.un_out.clear();
        self.un_buf.clear();

        if open {
            self.finish_packet(now, out);
        } else if self.ack_pending || now - self.last_send >= f64::from(self.cfg.keepalive_s) {
            self.begin_packet(now);
            self.finish_packet(now, out);
        }
    }

    fn roll_stats(&mut self, now: f64) {
        let span = now - self.window_start;
        if span >= 1.0 {
            self.stats.send_bytes_per_sec = (self.win_sent_bytes as f64 / span) as f32;
            self.stats.recv_bytes_per_sec = (self.win_recv_bytes as f64 / span) as f32;
            self.stats.loss = if self.win_sent_pkts > 0 { self.win_lost_pkts as f32 / self.win_sent_pkts as f32 } else { 0.0 };
            self.window_start = now;
            self.win_sent_bytes = 0;
            self.win_recv_bytes = 0;
            self.win_sent_pkts = 0;
            self.win_lost_pkts = 0;
        }
    }

    // ---- receiving ----

    /// Handle a payload datagram (`kind` + `session` already checked by the endpoint).
    pub fn receive(&mut self, now: f64, packet: &[u8]) -> WireResult<()> {
        let mut r = Reader::new(packet);
        r.skip(5)?;
        let seq = r.u16()?;
        let ack = r.u16()?;
        let bits = r.u32()?;
        // Validate the whole packet before touching any state.
        let body = r;
        Self::validate(body)?;
        if self.have_remote && seq_diff(self.remote_seq, seq) >= ACK_RING as i32 - 32 {
            return Ok(()); // ancient
        }
        if self.recv_ring[seq as usize % ACK_RING] == u32::from(seq) {
            self.stats.packets_dup += 1;
            self.last_recv = now;
            self.ack_pending = true;
            return Ok(());
        }
        self.recv_ring[seq as usize % ACK_RING] = u32::from(seq);
        if !self.have_remote || seq_gt(seq, self.remote_seq) {
            self.remote_seq = seq;
            self.have_remote = true;
        }
        self.last_recv = now;
        self.ack_pending = true;
        self.stats.packets_recv += 1;
        self.stats.bytes_recv += packet.len() as u64;
        self.win_recv_bytes += packet.len() as u64;
        self.process_acks(now, ack, bits);
        self.read_entries(now, body)
    }

    fn validate(mut r: Reader) -> WireResult<()> {
        while !r.is_empty() {
            let tag = r.u8()?;
            let c = tag & 0x0f;
            if c >= ch::COUNT {
                return Err(WireError);
            }
            match c {
                ch::RELIABLE => {
                    r.u16()?;
                    if tag & FRAG != 0 {
                        r.var()?;
                    }
                }
                ch::SEQUENCED => {
                    r.u16()?;
                }
                _ => {
                    if tag & FRAG != 0 {
                        r.u16()?;
                        let i = r.u8()?;
                        let n = r.u8()?;
                        if i >= n {
                            return Err(WireError);
                        }
                    }
                }
            }
            r.bytes()?;
        }
        Ok(())
    }

    fn process_acks(&mut self, now: f64, ack: u16, bits: u32) {
        // Ignore ack fields until we have sent something they could refer to.
        // `ack 0, no bits` is what a peer that has received nothing yet sends.
        if (self.local_seq == 0 && !self.sent[0].live) || (ack == 0 && bits == 0) {
            return;
        }
        for i in 0..=32u16 {
            if i > 0 && bits & (1 << (i - 1)) == 0 {
                continue;
            }
            let s = ack.wrapping_sub(i);
            let slot_i = s as usize % ACK_RING;
            let slot = &mut self.sent[slot_i];
            if !slot.live || slot.seq != s || slot.acked {
                continue;
            }
            slot.acked = true;
            if i == 0 {
                let sample = (now - slot.time).max(0.0);
                let err = (sample - self.srtt).abs();
                self.srtt += (sample - self.srtt) * 0.125;
                self.rttvar += (err - self.rttvar) * 0.25;
            }
            let base = self.rel_out.front().map(|m| m.id);
            for &id in &self.sent[slot_i].reliable {
                if let Some(b) = base {
                    let off = seq_diff(id, b);
                    if off >= 0 && (off as usize) < self.rel_out.len() {
                        self.rel_out[off as usize].acked = true;
                    }
                }
            }
            for &t in &self.sent[slot_i].tokens {
                match self.frag_tokens.get_mut(&t) {
                    Some(n) if *n > 1 => *n -= 1,
                    Some(_) => {
                        self.frag_tokens.remove(&t);
                        self.acked_tokens.push(t);
                    }
                    None => self.acked_tokens.push(t),
                }
            }
        }
        while self.rel_out.front().is_some_and(|m| m.acked) {
            let m = self.rel_out.pop_front().unwrap();
            self.rel_pool.push(m.data);
        }
        // Loss accounting: a packet 33+ behind the newest ack that wasn't acked is lost.
        if self.newest_ack.is_none_or(|n| seq_gt(ack, n)) {
            self.newest_ack = Some(ack);
        }
        let newest = self.newest_ack.unwrap();
        while seq_diff(newest, self.loss_cursor) > 32 {
            let slot = &self.sent[self.loss_cursor as usize % ACK_RING];
            if slot.live && slot.seq == self.loss_cursor && !slot.acked {
                self.stats.packets_lost += 1;
                self.win_lost_pkts += 1;
            }
            self.loss_cursor = self.loss_cursor.wrapping_add(1);
        }
    }

    fn read_entries(&mut self, now: f64, mut r: Reader) -> WireResult<()> {
        let window = self.rel_slots.len();
        while !r.is_empty() {
            let tag = r.u8()?;
            let c = tag & 0x0f;
            match c {
                ch::RELIABLE => {
                    let id = r.u16()?;
                    let left = if tag & FRAG != 0 { r.var_u32()? } else { 0 };
                    let data = r.bytes()?;
                    let d = seq_diff(id, self.rel_expect);
                    if d < 0 || d as usize >= window {
                        continue; // duplicate, or beyond our window (sender misbehaving)
                    }
                    let slot = &mut self.rel_slots[id as usize % window];
                    if slot.is_none() {
                        let mut b = self.rel_pool.pop().unwrap_or_default();
                        b.clear();
                        b.extend_from_slice(data);
                        *slot = Some((b, left));
                    }
                    self.drain_reliable()?;
                }
                ch::SEQUENCED => {
                    let s = r.u16()?;
                    let data = r.bytes()?;
                    if self.seq_in.is_none_or(|last| seq_gt(s, last)) {
                        self.seq_in = Some(s);
                        self.deliver(c, data);
                    }
                }
                _ => {
                    if tag & FRAG != 0 {
                        let group = r.u16()?;
                        let idx = r.u8()?;
                        let count = r.u8()?;
                        let data = r.bytes()?;
                        self.fragment_in(now, c, group, idx, count, data);
                    } else {
                        let data = r.bytes()?;
                        self.deliver(c, data);
                    }
                }
            }
        }
        Ok(())
    }

    fn drain_reliable(&mut self) -> WireResult<()> {
        let window = self.rel_slots.len();
        while let Some((buf, left)) = self.rel_slots[self.rel_expect as usize % window].take() {
            self.rel_expect = self.rel_expect.wrapping_add(1);
            if left > 0 || !self.rel_assembling.is_empty() {
                self.rel_assembling.extend_from_slice(&buf);
                if self.rel_assembling.len() > self.cfg.max_message_size {
                    self.error = true;
                    return Err(WireError);
                }
                if left == 0 {
                    let msg = std::mem::take(&mut self.rel_assembling);
                    self.deliver(ch::RELIABLE, &msg);
                    self.rel_assembling = msg;
                    self.rel_assembling.clear();
                }
            } else {
                self.deliver(ch::RELIABLE, &buf);
            }
            self.rel_pool.push(buf);
        }
        Ok(())
    }

    fn fragment_in(&mut self, now: f64, c: u8, group: u16, idx: u8, count: u8, data: &[u8]) {
        self.frags_in.retain(|f| now - f.born < 1.0);
        let pos = match self.frags_in.iter().position(|f| f.group == group) {
            Some(p) => p,
            None => {
                if self.frags_in.len() >= 16 {
                    self.frags_in.remove(0);
                }
                self.frags_in.push(FragIn { group, count, have: 0, born: now, parts: vec![None; count as usize], buf: Vec::new() });
                self.frags_in.len() - 1
            }
        };
        let f = &mut self.frags_in[pos];
        if f.count != count || f.parts[idx as usize].is_some() {
            return;
        }
        let s = f.buf.len();
        f.buf.extend_from_slice(data);
        f.parts[idx as usize] = Some((s, data.len()));
        f.have += 1;
        if f.have == f.count {
            let f = self.frags_in.swap_remove(pos);
            let start = self.in_buf.len();
            for (s, n) in f.parts.iter().flatten() {
                self.in_buf.extend_from_slice(&f.buf[*s..*s + *n]);
            }
            self.in_msgs.push((c, start, self.in_buf.len() - start));
        }
    }

    fn deliver(&mut self, c: u8, data: &[u8]) {
        let start = self.in_buf.len();
        self.in_buf.extend_from_slice(data);
        self.in_msgs.push((c, start, data.len()));
    }

    /// Hand every message received since the last call to `f(channel, bytes)`.
    pub fn drain_received(&mut self, mut f: impl FnMut(u8, &[u8])) {
        for &(c, s, n) in &self.in_msgs {
            f(c, &self.in_buf[s..s + n]);
        }
        self.in_msgs.clear();
        self.in_buf.clear();
    }

    pub fn has_received(&self) -> bool {
        !self.in_msgs.is_empty()
    }

    /// Tokens of [`Self::send_tracked`] messages whose packet was acked since the last call.
    pub fn drain_acked_tokens(&mut self, out: &mut Vec<u32>) {
        out.append(&mut self.acked_tokens);
    }

    pub fn timed_out(&self, now: f64) -> bool {
        now - self.last_recv > f64::from(self.cfg.timeout_s)
    }

    pub fn reliable_pending(&self) -> usize {
        self.rel_out.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::wire::Rng;

    /// Two connections wired back to back through a lossy, reordering, duplicating "network".
    struct Pair {
        a: Connection,
        b: Connection,
        rng: Rng,
        loss: f32,
        /// (deliver_at, to_b, bytes)
        wire: Vec<(f64, bool, Vec<u8>)>,
        now: f64,
    }

    impl Pair {
        fn new(loss: f32, seed: u64) -> Self {
            let cfg = ConnectionConfig::default();
            Pair { a: Connection::new(7, cfg, 0.0), b: Connection::new(7, cfg, 0.0), rng: Rng::new(seed), loss, wire: Vec::new(), now: 0.0 }
        }
        fn step(&mut self, mut on_b: impl FnMut(u8, &[u8]), mut on_a: impl FnMut(u8, &[u8])) {
            self.now += 1.0 / 60.0;
            let now = self.now;
            for to_b in [true, false] {
                let conn = if to_b { &mut self.a } else { &mut self.b };
                let rng = &mut self.rng;
                let wire = &mut self.wire;
                let loss = self.loss;
                conn.flush(now, &mut |p| {
                    if rng.chance(loss) {
                        return;
                    }
                    let delay = 0.03 + 0.03 * rng.next_f32() as f64;
                    wire.push((now + delay, to_b, p.to_vec()));
                    if rng.chance(0.05) {
                        wire.push((now + delay + 0.01, to_b, p.to_vec()));
                    }
                });
            }
            let mut i = 0;
            while i < self.wire.len() {
                if self.wire[i].0 <= now {
                    let (_, to_b, p) = self.wire.swap_remove(i);
                    let conn = if to_b { &mut self.b } else { &mut self.a };
                    conn.receive(now, &p).unwrap();
                } else {
                    i += 1;
                }
            }
            self.b.drain_received(&mut on_b);
            self.a.drain_received(&mut on_a);
        }
    }

    #[test]
    fn reliable_ordered_survives_20pct_loss_reorder_and_duplication() {
        let mut p = Pair::new(0.2, 42);
        let mut got = Vec::new();
        let mut sent = 0u32;
        for frame in 0..600 {
            if frame < 300 {
                for _ in 0..3 {
                    // Mix of small and fragmented (3 KB) messages.
                    let mut m = sent.to_le_bytes().to_vec();
                    if sent.is_multiple_of(10) {
                        m.resize(3000, (sent % 251) as u8);
                    }
                    p.a.send(ch::RELIABLE, &m).unwrap();
                    sent += 1;
                }
            }
            p.step(
                |c, d| {
                    assert_eq!(c, ch::RELIABLE);
                    got.push(d.to_vec());
                },
                |_, _| {},
            );
        }
        assert_eq!(got.len() as u32, sent, "every reliable message arrived exactly once");
        for (i, m) in got.iter().enumerate() {
            assert_eq!(u32::from_le_bytes(m[..4].try_into().unwrap()), i as u32, "in order");
            if i % 10 == 0 {
                assert_eq!(m.len(), 3000, "fragmented message reassembled");
                assert!(m[4..].iter().all(|&b| b == (i % 251) as u8));
            }
        }
        let s = p.a.stats();
        assert!(s.reliable_resent > 0 && s.packets_lost > 0, "{s:?}");
        assert!(s.loss > 0.05, "loss measured: {s:?}");
        assert_eq!(p.a.reliable_pending(), 0);
    }

    #[test]
    fn sequenced_drops_stale_and_unreliable_fragments_reassemble() {
        let mut p = Pair::new(0.0, 3);
        let mut seqd = Vec::new();
        let mut big = Vec::new();
        for i in 0..120u32 {
            p.a.send(ch::SEQUENCED, &i.to_le_bytes()).unwrap();
            if i % 30 == 0 {
                p.a.send(ch::UNRELIABLE, &vec![i as u8; 5000]).unwrap();
            }
            p.step(
                |c, d| match c {
                    ch::SEQUENCED => seqd.push(u32::from_le_bytes(d.try_into().unwrap())),
                    ch::UNRELIABLE => big.push(d.to_vec()),
                    _ => {}
                },
                |_, _| {},
            );
        }
        assert!(seqd.windows(2).all(|w| w[1] > w[0]), "sequenced never goes backwards");
        assert!(seqd.len() > 60);
        assert_eq!(big.len(), 4);
        assert!(big.iter().all(|m| m.len() == 5000));
        assert!(p.b.receive(0.0, &[kind::PAYLOAD, 7, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0x0f]).is_err(), "bad channel rejected");
        assert!(p.b.receive(0.0, &[kind::PAYLOAD, 7, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 50]).is_err(), "truncated rejected");
    }

    #[test]
    fn bandwidth_cap_holds() {
        let mut cfg = ConnectionConfig { bytes_per_sec: 20_000, ..Default::default() };
        cfg.keepalive_s = 1.0;
        let mut c = Connection::new(1, cfg, 0.0);
        let mut total = 0usize;
        let mut now = 0.0;
        for _ in 0..600 {
            now += 1.0 / 60.0;
            for _ in 0..10 {
                let _ = c.send(ch::UNRELIABLE, &[0u8; 500]);
            }
            c.flush(now, &mut |p| total += p.len());
        }
        let rate = total as f64 / now;
        assert!(rate < 22_000.0 && rate > 15_000.0, "rate {rate}");
        assert!(c.stats().dropped_over_budget > 0);
    }

    #[test]
    fn tracked_tokens_report_acks() {
        let mut p = Pair::new(0.0, 5);
        let t = p.a.send_tracked(ch::SNAPSHOT, b"snap");
        for _ in 0..20 {
            p.step(|_, _| {}, |_, _| {});
        }
        let mut acked = Vec::new();
        p.a.drain_acked_tokens(&mut acked);
        assert_eq!(acked, vec![t]);
    }
}
