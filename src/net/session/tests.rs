use super::proto::Msg;
use super::relay::Relay;
use super::route::{NatKind, Role, Route, Shared, SessionTransport, SimNat, VIRT_HOST};
use crate::net::transport::{LoopbackNet, Transport};

fn pump(relay: &mut Relay) {
    relay.poll(0.0);
}

#[test]
fn relayed_game_packets_use_virtual_addresses_both_ways() {
    let net = LoopbackNet::new();
    let mut relay = Relay::new(net.bind(1), 1);
    let ra = relay.local_addr();
    let (hs, gs) = (Shared::new(Role::Host), Shared::new(Role::Guest));
    let mut host = SessionTransport::new(Box::new(net.bind(2)), ra, hs.clone());
    let mut guest = SessionTransport::new(Box::new(net.bind(3)), ra, gs.clone());
    hs.lock().unwrap().code = "ROOM22".into();
    gs.lock().unwrap().code = "ROOM22".into();
    // Register the room (control traffic goes out through the same socket).
    hs.lock().unwrap().push(ra, &Msg::Register { code: Some("ROOM22".into()), token: Some(5) });
    let mut buf = Vec::new();
    host.recv(&mut buf);
    pump(&mut relay);
    // Unrouted: dropped silently. Relayed: wrapped.
    guest.send(VIRT_HOST, b"lost").unwrap();
    assert_eq!(gs.lock().unwrap().stats.dropped_unrouted, 1);
    gs.lock().unwrap().route = Route::Relayed;
    guest.send(VIRT_HOST, b"\x06hello").unwrap();
    pump(&mut relay);
    let src = host.recv(&mut buf).expect("the host receives the relayed packet");
    assert_eq!(buf, b"\x06hello");
    assert_eq!(src.ip().to_string().split('.').next(), Some("198"), "relayed guests get a virtual address: {src}");
    assert_eq!(hs.lock().unwrap().relayed_guests(), 1);
    // The host answers to the virtual address; the guest sees its host as VIRT_HOST.
    host.send(src, b"\x06reply").unwrap();
    pump(&mut relay);
    assert_eq!(guest.recv(&mut buf), Some(VIRT_HOST));
    assert_eq!(buf, b"\x06reply");
    // The same guest keeps the same virtual address.
    guest.send(VIRT_HOST, b"\x06again").unwrap();
    pump(&mut relay);
    assert_eq!(host.recv(&mut buf), Some(src));
}

#[test]
fn punch_is_acked_and_opens_the_direct_route() {
    let net = LoopbackNet::new();
    let relay = net.bind(1).local_addr();
    let (hs, gs) = (Shared::new(Role::Host), Shared::new(Role::Guest));
    let mut host = SessionTransport::new(Box::new(net.bind(2)), relay, hs.clone());
    let mut guest = SessionTransport::new(Box::new(net.bind(3)), relay, gs.clone());
    let (ha, ga) = (host.local_addr(), guest.local_addr());
    gs.lock().unwrap().push(ha, &Msg::Punch { nonce: 9, ack: false });
    let mut buf = Vec::new();
    guest.recv(&mut buf); // flushes the punch
    host.recv(&mut buf); // sees it, answers at once
    assert!(matches!(hs.lock().unwrap().inbox.pop_front(), Some((from, Msg::Punch { nonce: 9, ack: false })) if from == ga));
    guest.recv(&mut buf); // the ack arrives
    assert!(matches!(gs.lock().unwrap().inbox.pop_front(), Some((from, Msg::Punch { nonce: 9, ack: true })) if from == ha));
    // Game packets from the host are accepted only once the route is Direct to that address.
    host.send(ga, b"\x06x").unwrap();
    assert_eq!(guest.recv(&mut buf), None, "unsolicited before the route is known");
    gs.lock().unwrap().route = Route::Direct(ha);
    host.send(ga, b"\x06y").unwrap();
    assert_eq!(guest.recv(&mut buf), Some(VIRT_HOST));
    guest.send(VIRT_HOST, b"\x06z").unwrap();
    assert_eq!(host.recv(&mut buf), Some(ga));
}

#[test]
fn sim_nat_kinds_filter_as_documented() {
    let net = LoopbackNet::new();
    let (relay, peer) = (net.bind(1), net.bind(2));
    let mut buf = Vec::new();
    // Port-restricted: replies from addresses it contacted pass; strangers don't.
    let mut nat = SimNat::new(net.bind(3), NatKind::PortRestricted);
    let (mut peer, mut stranger) = (peer, net.bind(4));
    nat.send(peer.local_addr(), b"out").unwrap();
    peer.send(nat.local_addr(), b"reply").unwrap();
    stranger.send(nat.local_addr(), b"who?").unwrap();
    assert_eq!(nat.recv(&mut buf), Some(peer.local_addr()));
    assert_eq!(nat.recv(&mut buf), None);
    assert_eq!(nat.dropped().load(std::sync::atomic::Ordering::Relaxed), 1);
    // Strict: only the allowed address, both directions.
    let mut strict = SimNat::new(net.bind(5), NatKind::Strict).allow(relay.local_addr());
    strict.send(peer.local_addr(), b"nope").unwrap();
    while peer.recv(&mut buf).is_some() {
        assert_ne!(buf, b"nope", "a strict NAT sends nothing to a stranger");
    }
    stranger.send(strict.local_addr(), b"hi").unwrap();
    assert_eq!(strict.recv(&mut buf), None);
    let mut relay = relay;
    relay.send(strict.local_addr(), b"ok").unwrap();
    assert_eq!(strict.recv(&mut buf), Some(relay.local_addr()));
}
