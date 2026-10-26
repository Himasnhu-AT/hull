//! Typed game messages / RPCs both ways ([`NetSender`] → `FromClient<M>` / `FromServer<M>`),
//! and the `Last` system that hands everything queued this frame to the connections and
//! flushes them.
//!
//! On a listen server the host's own messages short-circuit: `to_server` arrives as
//! `FromClient { client: ClientId::HOST }`, and `broadcast`/`to_client(HOST)` as `FromServer`.

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::connection::Channel;
use super::endpoint::ClientId;
use super::registry::{FromClient, FromServer, NetRegistry, postcard_decode, postcard_encode};
use super::wire::{Put, Reader, WireResult};
use super::{NetClient, NetRole, NetServer, now};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Server,
    Client(ClientId),
    All,
    AllExcept(ClientId),
}

/// Messages queued this frame (one byte arena, no per-message allocation).
#[derive(Resource, Default)]
pub struct NetOutbox {
    buf: Vec<u8>,
    items: Vec<(Target, Channel, usize, usize)>,
}

type Decoder = fn(&mut World, Option<ClientId>, &mut Reader) -> WireResult<()>;

/// Decoders by message kind (registration order).
#[derive(Resource, Default)]
pub(crate) struct MessageDecoders(pub Vec<Decoder>);

pub(crate) fn decode_into<M: DeserializeOwned + Send + Sync + 'static>(world: &mut World, from: Option<ClientId>, r: &mut Reader) -> WireResult<()> {
    let m: M = postcard_decode(r)?;
    match from {
        Some(client) => {
            world.write_message(FromClient { client, message: m });
        }
        None => {
            world.write_message(FromServer(m));
        }
    }
    Ok(())
}

/// Decode one game-channel payload (`varint kind + body`) into its Bevy message.
pub(crate) fn dispatch(world: &mut World, from: Option<ClientId>, bytes: &[u8]) {
    let mut r = Reader::new(bytes);
    let Ok(kind) = r.var() else { return };
    let dec = world.resource::<MessageDecoders>().0.get(kind as usize).copied();
    match dec {
        Some(d) => {
            if d(world, from, &mut r).is_err() {
                warn!("net: undecodable message kind {kind} from {from:?}");
            }
        }
        None => warn!("net: unknown message kind {kind} from {from:?}"),
    }
}

/// Send registered game messages ([`super::NetAppExt::add_net_message`]).
#[derive(SystemParam)]
pub struct NetSender<'w> {
    outbox: ResMut<'w, NetOutbox>,
    registry: Res<'w, NetRegistry>,
}

impl NetSender<'_> {
    fn push<M: Serialize + 'static>(&mut self, target: Target, msg: &M) {
        let Some(kind) = self.registry.message_kind::<M>() else {
            warn!("net: {} is not registered (add_net_message)", std::any::type_name::<M>());
            return;
        };
        let channel = self.registry.messages[kind as usize].channel;
        let start = self.outbox.buf.len();
        self.outbox.buf.put_var(u64::from(kind));
        postcard_encode(msg, &mut self.outbox.buf);
        let len = self.outbox.buf.len() - start;
        self.outbox.items.push((target, channel, start, len));
    }
    /// Client → server.
    pub fn to_server<M: Serialize + 'static>(&mut self, msg: &M) {
        self.push(Target::Server, msg);
    }
    /// Server → one client.
    pub fn to_client<M: Serialize + 'static>(&mut self, client: ClientId, msg: &M) {
        self.push(Target::Client(client), msg);
    }
    /// Server → every client.
    pub fn broadcast<M: Serialize + 'static>(&mut self, msg: &M) {
        self.push(Target::All, msg);
    }
    pub fn broadcast_except<M: Serialize + 'static>(&mut self, except: ClientId, msg: &M) {
        self.push(Target::AllExcept(except), msg);
    }
}

/// `Last`: queued messages → connections → transport.
pub(crate) fn send(world: &mut World) {
    let t = now(world);
    let mut outbox = std::mem::take(&mut *world.resource_mut::<NetOutbox>());
    let role = *world.resource::<NetRole>();
    let mut local: Vec<(Option<ClientId>, usize, usize)> = Vec::new();
    if let Some(mut s) = world.get_resource_mut::<NetServer>() {
        for &(target, channel, start, len) in &outbox.items {
            let data = &outbox.buf[start..start + len];
            let c = channel.id();
            let r = match target {
                Target::Server => {
                    if role == NetRole::ListenServer {
                        local.push((Some(ClientId::HOST), start, len));
                    }
                    Ok(())
                }
                Target::Client(id) if id == ClientId::HOST => {
                    local.push((None, start, len));
                    Ok(())
                }
                Target::Client(id) => s.endpoint.send(id, c, data),
                Target::All => {
                    s.endpoint.broadcast(c, data);
                    if role == NetRole::ListenServer {
                        local.push((None, start, len));
                    }
                    Ok(())
                }
                Target::AllExcept(x) => {
                    for rc in s.endpoint.clients_mut() {
                        if rc.id != x {
                            let _ = rc.conn.send(c, data);
                        }
                    }
                    if role == NetRole::ListenServer && x != ClientId::HOST {
                        local.push((None, start, len));
                    }
                    Ok(())
                }
            };
            if let Err(e) = r {
                warn!("net: message to {target:?} not sent: {e:?}");
            }
        }
        s.endpoint.flush(t);
    } else if let Some(mut c) = world.get_resource_mut::<NetClient>() {
        for &(target, channel, start, len) in &outbox.items {
            if target == Target::Server
                && let Err(e) = c.endpoint.send(channel.id(), &outbox.buf[start..start + len])
            {
                warn!("net: message to server not sent: {e:?}");
            }
        }
        c.endpoint.flush(t);
    }
    for (from, start, len) in local {
        dispatch(world, from, &outbox.buf[start..start + len]);
    }
    outbox.buf.clear();
    outbox.items.clear();
    *world.resource_mut::<NetOutbox>() = outbox;
}
