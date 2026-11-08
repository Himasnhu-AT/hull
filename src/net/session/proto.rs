//! The rendezvous / relay wire protocol (tiny, hand-rolled, UDP). Control packets start with the
//! magic `ERLY`; game packets never do (their first byte is a small packet kind).
//!
//! ```text
//! host  -> relay  Register{code?, token?}   relay -> host    Registered{code, token} | Refused
//! guest -> relay  Join{code}                relay -> both    Introduce{code, peer}   | Refused
//! guest -> relay  RelayUp{code, payload}    relay -> host    Relayed{from: guest, payload}
//! host  -> relay  RelayTo{code, to, data}   relay -> guest   Relayed{from: host, payload}
//! peer  <-> peer  Punch{nonce, ack}         (opens both NATs; an ack proves the path)
//! ```

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub const MAGIC: [u8; 4] = *b"ERLY";

/// Why the relay refused a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NoSuchRoom,
    BadToken,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Msg {
    Register { code: Option<String>, token: Option<u64> },
    Registered { code: String, token: u64 },
    Join { code: String },
    Introduce { code: String, peer: SocketAddr },
    Refused { code: String, why: Refusal },
    RelayUp { code: String, payload: Vec<u8> },
    RelayTo { code: String, to: SocketAddr, payload: Vec<u8> },
    Relayed { from: SocketAddr, payload: Vec<u8> },
    Punch { nonce: u64, ack: bool },
}

/// Does this datagram look like a control packet?
pub fn is_control(p: &[u8]) -> bool {
    p.len() > 4 && p[..4] == MAGIC
}

struct W(Vec<u8>);

impl W {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn str(&mut self, s: &str) {
        self.u8(s.len().min(255) as u8);
        self.0.extend_from_slice(&s.as_bytes()[..s.len().min(255)]);
    }
    fn bytes(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
    fn addr(&mut self, a: SocketAddr) {
        match a.ip() {
            IpAddr::V4(i) => {
                self.u8(4);
                self.bytes(&i.octets());
            }
            IpAddr::V6(i) => {
                self.u8(6);
                self.bytes(&i.octets());
            }
        }
        self.bytes(&a.port().to_le_bytes());
    }
}

struct R<'a>(&'a [u8]);

impl R<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        if self.0.len() < n {
            return None;
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Some(a)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u64(&mut self) -> Option<u64> {
        self.take(8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))
    }
    fn str(&mut self) -> Option<String> {
        let n = self.u8()? as usize;
        String::from_utf8(self.take(n)?.to_vec()).ok()
    }
    fn addr(&mut self) -> Option<SocketAddr> {
        let ip = match self.u8()? {
            4 => IpAddr::V4(Ipv4Addr::from(<[u8; 4]>::try_from(self.take(4)?).ok()?)),
            6 => IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(self.take(16)?).ok()?)),
            _ => return None,
        };
        let port = u16::from_le_bytes(self.take(2)?.try_into().ok()?);
        Some(SocketAddr::new(ip, port))
    }
    fn rest(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.0).to_vec()
    }
}

impl Msg {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = W(MAGIC.to_vec());
        match self {
            Msg::Register { code, token } => {
                w.u8(1);
                w.str(code.as_deref().unwrap_or(""));
                w.u8(token.is_some() as u8);
                w.u64(token.unwrap_or(0));
            }
            Msg::Registered { code, token } => {
                w.u8(2);
                w.str(code);
                w.u64(*token);
            }
            Msg::Join { code } => {
                w.u8(3);
                w.str(code);
            }
            Msg::Introduce { code, peer } => {
                w.u8(4);
                w.str(code);
                w.addr(*peer);
            }
            Msg::Refused { code, why } => {
                w.u8(5);
                w.str(code);
                w.u8(*why as u8);
            }
            Msg::RelayUp { code, payload } => {
                w.u8(6);
                w.str(code);
                w.bytes(payload);
            }
            Msg::RelayTo { code, to, payload } => {
                w.u8(7);
                w.str(code);
                w.addr(*to);
                w.bytes(payload);
            }
            Msg::Relayed { from, payload } => {
                w.u8(8);
                w.addr(*from);
                w.bytes(payload);
            }
            Msg::Punch { nonce, ack } => {
                w.u8(9);
                w.u64(*nonce);
                w.u8(*ack as u8);
            }
        }
        w.0
    }

    pub fn decode(p: &[u8]) -> Option<Msg> {
        if !is_control(p) {
            return None;
        }
        let mut r = R(&p[4..]);
        Some(match r.u8()? {
            1 => {
                let code = r.str()?;
                let has = r.u8()? != 0;
                let token = r.u64()?;
                Msg::Register { code: (!code.is_empty()).then_some(code), token: has.then_some(token) }
            }
            2 => Msg::Registered { code: r.str()?, token: r.u64()? },
            3 => Msg::Join { code: r.str()? },
            4 => Msg::Introduce { code: r.str()?, peer: r.addr()? },
            5 => Msg::Refused { code: r.str()?, why: if r.u8()? == 0 { Refusal::NoSuchRoom } else { Refusal::BadToken } },
            6 => Msg::RelayUp { code: r.str()?, payload: r.rest() },
            7 => Msg::RelayTo { code: r.str()?, to: r.addr()?, payload: r.rest() },
            8 => Msg::Relayed { from: r.addr()?, payload: r.rest() },
            9 => Msg::Punch { nonce: r.u64()?, ack: r.u8()? != 0 },
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_message_round_trips() {
        let a: SocketAddr = "10.1.2.3:4567".parse().unwrap();
        let b: SocketAddr = "[::1]:99".parse().unwrap();
        for m in [
            Msg::Register { code: None, token: None },
            Msg::Register { code: Some("ABC234".into()), token: Some(77) },
            Msg::Registered { code: "ABC234".into(), token: u64::MAX },
            Msg::Join { code: "ZZ".into() },
            Msg::Introduce { code: "ABC234".into(), peer: a },
            Msg::Refused { code: "X".into(), why: Refusal::BadToken },
            Msg::RelayUp { code: "C".into(), payload: vec![1, 2, 3] },
            Msg::RelayTo { code: "C".into(), to: b, payload: vec![9; 100] },
            Msg::Relayed { from: a, payload: vec![] },
            Msg::Punch { nonce: 5, ack: true },
        ] {
            assert_eq!(Msg::decode(&m.encode()).as_ref(), Some(&m), "{m:?}");
        }
        assert!(Msg::decode(&[1, 2, 3, 4, 5]).is_none());
        assert!(!is_control(&[6, 0, 0, 0, 0]));
        assert!(Msg::decode(&MAGIC.iter().copied().chain([99]).collect::<Vec<_>>()).is_none());
    }
}
