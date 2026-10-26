//! What replicates: components, game messages and prediction inputs, registered from code with
//! [`NetAppExt`]. Server and client must register the same set in the same order (they do when
//! both run the same game code); the order is hashed into the protocol id, so a mismatched
//! build is refused at the handshake.
//!
//! ```ignore
//! app.replicate_transform()                       // quantised, interpolated
//!    .replicate::<Health>()                       // any serde component (postcard)
//!    .add_net_message::<Chat>(Channel::Reliable)  // FromClient<Chat> / FromServer<Chat>
//!    .predict::<Body, MoveInput>(step_body);      // client prediction + server reconciliation
//! ```

use std::any::TypeId;

use bevy::ecs::component::ComponentId;
use bevy::ecs::world::EntityWorldMut;
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use bevy::ptr::Ptr;
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::connection::Channel;
use super::wire::{Put, Reader, WireError, WireResult, hash64, pack_quat, read_vec3_q, unpack_quat, put_vec3_q};

/// How a type goes on the wire. Implement it on a marker type for custom/quantised encodings.
pub trait Codec<T>: Send + Sync + 'static {
    fn encode(value: &T, out: &mut Vec<u8>);
    fn decode(r: &mut Reader) -> WireResult<T>;
}

/// serde types via postcard (compact varint binary).
pub struct Postcard;

impl<T: Serialize + DeserializeOwned> Codec<T> for Postcard {
    fn encode(value: &T, out: &mut Vec<u8>) {
        postcard_encode(value, out);
    }
    fn decode(r: &mut Reader) -> WireResult<T> {
        postcard_decode(r)
    }
}

/// Append `value` in postcard encoding (no allocation once `out` has capacity).
pub fn postcard_encode<T: Serialize + ?Sized>(value: &T, out: &mut Vec<u8>) {
    let buf = std::mem::take(out);
    *out = postcard::to_extend(value, buf).unwrap_or_default();
}

/// Decode one postcard value and advance the reader past it.
pub fn postcard_decode<T: DeserializeOwned>(r: &mut Reader) -> WireResult<T> {
    let (v, rest) = postcard::take_from_bytes(r.remaining()).map_err(|_| WireError)?;
    r.advance_to(rest);
    Ok(v)
}

/// Position step (metres) of [`TransformCodec`].
pub const POSITION_STEP: f32 = 0.001;

/// `Transform`: position in 1 mm steps (zigzag varints), rotation "smallest three" in 4 bytes
/// (~0.25° max error), scale only when not 1 (3 × f32). Typically 9–13 bytes.
pub struct TransformCodec;

impl Codec<Transform> for TransformCodec {
    fn encode(t: &Transform, out: &mut Vec<u8>) {
        let has_scale = t.scale != Vec3::ONE;
        let has_rot = t.rotation != Quat::IDENTITY;
        out.put_u8(u8::from(has_scale) | (u8::from(has_rot) << 1));
        put_vec3_q(out, t.translation, POSITION_STEP);
        if has_rot {
            out.put_u32(pack_quat(t.rotation));
        }
        if has_scale {
            for c in t.scale.to_array() {
                out.put_f32(c);
            }
        }
    }
    fn decode(r: &mut Reader) -> WireResult<Transform> {
        let flags = r.u8()?;
        let translation = read_vec3_q(r, POSITION_STEP)?;
        let rotation = if flags & 2 != 0 { unpack_quat(r.u32()?) } else { Quat::IDENTITY };
        let scale = if flags & 1 != 0 { Vec3::new(r.f32()?, r.f32()?, r.f32()?) } else { Vec3::ONE };
        Ok(Transform { translation, rotation, scale })
    }
}

/// Server-assigned network id of a replicated entity (same on every peer).
#[derive(Component, Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub struct NetId(pub u32);

/// Type-erased handling of one replicated component.
pub(crate) struct ComponentRule {
    pub name: &'static str,
    pub component_id: ComponentId,
    /// Serialise the component behind `ptr`.
    pub write: unsafe fn(Ptr, &mut Vec<u8>),
    /// Decode and insert/overwrite.
    pub apply: fn(&mut EntityWorldMut, &mut Reader) -> WireResult<()>,
    /// Decode into the entity's `NetHistory<C>` (interpolation).
    pub push_history: fn(&mut EntityWorldMut, &mut Reader, u32) -> WireResult<()>,
    /// Decode into `Confirmed<C>` (prediction).
    pub confirm: fn(&mut EntityWorldMut, &mut Reader, u32) -> WireResult<()>,
    pub remove: fn(&mut EntityWorldMut),
    pub interpolated: bool,
    /// Sent only to the entity's owner (`NetOwner`), e.g. ammo, inventory.
    pub owner_only: bool,
    pub predicted: bool,
}

pub(crate) struct MessageRule {
    pub name: &'static str,
    pub channel: Channel,
}

/// Everything registered for replication, by wire index.
#[derive(Resource, Default)]
pub struct NetRegistry {
    pub(crate) components: Vec<ComponentRule>,
    pub(crate) comp_index: HashMap<TypeId, usize>,
    pub(crate) messages: Vec<MessageRule>,
    pub(crate) msg_index: HashMap<TypeId, u16>,
    pub(crate) inputs: Vec<&'static str>,
    pub(crate) input_index: HashMap<TypeId, u16>,
}

impl NetRegistry {
    /// Hash of the registered names in order + `version`.
    pub fn protocol_id(&self, version: u32) -> u64 {
        let mut s = format!("engine-net/1/{version}/");
        for c in &self.components {
            s.push_str(c.name);
            s.push(if c.interpolated { 'i' } else { '-' });
            s.push(if c.predicted { 'p' } else { '-' });
            s.push(if c.owner_only { 'o' } else { '-' });
            s.push(';');
        }
        s.push('|');
        for m in &self.messages {
            s.push_str(m.name);
            s.push_str(&format!("{:?};", m.channel));
        }
        s.push('|');
        for i in &self.inputs {
            s.push_str(i);
            s.push(';');
        }
        hash64(s.as_bytes())
    }

    pub fn component_names(&self) -> Vec<&'static str> {
        self.components.iter().map(|c| c.name).collect()
    }

    pub(crate) fn index_of<C: 'static>(&self) -> Option<usize> {
        self.comp_index.get(&TypeId::of::<C>()).copied()
    }

    pub(crate) fn message_kind<M: 'static>(&self) -> Option<u16> {
        self.msg_index.get(&TypeId::of::<M>()).copied()
    }

    pub(crate) fn input_kind<I: 'static>(&self) -> Option<u16> {
        self.input_index.get(&TypeId::of::<I>()).copied()
    }
}

/// Owning client of a replicated entity. Replicated itself (always wire index 0) so ownership
/// changes reach clients; the owning client predicts the entity, others interpolate it.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NetOwner(pub super::endpoint::ClientId);

/// Interpolation samples of `C` (client, remote entities), newest last.
#[derive(Component, Debug)]
pub struct NetHistory<C> {
    pub samples: std::collections::VecDeque<(u32, C)>,
}

impl<C> Default for NetHistory<C> {
    fn default() -> Self {
        NetHistory { samples: std::collections::VecDeque::with_capacity(8) }
    }
}

impl<C> NetHistory<C> {
    pub const MAX: usize = 32;
    pub(crate) fn push(&mut self, tick: u32, v: C) {
        // Keep sorted by tick (late packets slot in; duplicates replace).
        let pos = self.samples.iter().rposition(|(t, _)| *t <= tick);
        match pos {
            Some(p) if self.samples[p].0 == tick => self.samples[p].1 = v,
            Some(p) => self.samples.insert(p + 1, (tick, v)),
            None => self.samples.push_front((tick, v)),
        }
        while self.samples.len() > Self::MAX {
            self.samples.pop_front();
        }
    }
}

/// Latest authoritative server value of a predicted component.
#[derive(Component, Debug, Clone)]
pub struct Confirmed<C> {
    pub tick: u32,
    pub value: C,
    pub(crate) fresh: bool,
}

unsafe fn write_erased<C: Component, K: Codec<C>>(ptr: Ptr, out: &mut Vec<u8>) {
    // SAFETY: the caller fetched `ptr` with this rule's ComponentId, which is `C`'s.
    K::encode(unsafe { ptr.deref::<C>() }, out);
}

fn apply_erased<C: Component, K: Codec<C>>(e: &mut EntityWorldMut, r: &mut Reader) -> WireResult<()> {
    e.insert(K::decode(r)?);
    Ok(())
}

fn history_erased<C: Component + Clone, K: Codec<C>>(e: &mut EntityWorldMut, r: &mut Reader, tick: u32) -> WireResult<()> {
    let v = K::decode(r)?;
    if !e.contains::<C>() {
        // First sample: show it right away.
        e.insert(v.clone());
    }
    match e.get_mut::<NetHistory<C>>() {
        Some(mut h) => h.push(tick, v),
        None => {
            let mut h = NetHistory::<C>::default();
            h.push(tick, v);
            e.insert(h);
        }
    }
    Ok(())
}

fn confirm_erased<C: Component + Clone, K: Codec<C>>(e: &mut EntityWorldMut, r: &mut Reader, tick: u32) -> WireResult<()> {
    let v = K::decode(r)?;
    if !e.contains::<C>() {
        e.insert(v.clone());
    }
    match e.get_mut::<Confirmed<C>>() {
        Some(mut c) => {
            if tick >= c.tick {
                *c = Confirmed { tick, value: v, fresh: true };
            }
        }
        None => {
            e.insert(Confirmed { tick, value: v, fresh: true });
        }
    }
    Ok(())
}

fn remove_erased<C: Component>(e: &mut EntityWorldMut) {
    e.remove::<C>();
}

pub(crate) fn registry(app: &mut App) -> Mut<'_, NetRegistry> {
    if !app.world().contains_resource::<NetRegistry>() {
        app.init_resource::<NetRegistry>();
        // NetOwner is always index 0 (clients read it before routing the other components).
        add_rule::<NetOwner, Postcard>(app);
    }
    app.world_mut().resource_mut::<NetRegistry>()
}

fn add_rule<C: Component + Clone, K: Codec<C>>(app: &mut App) -> usize {
    let component_id = app.world_mut().register_component::<C>();
    let mut reg = app.world_mut().resource_mut::<NetRegistry>();
    if let Some(i) = reg.index_of::<C>() {
        return i;
    }
    let i = reg.components.len();
    reg.components.push(ComponentRule {
        name: std::any::type_name::<C>(),
        component_id,
        write: write_erased::<C, K>,
        apply: apply_erased::<C, K>,
        push_history: history_erased::<C, K>,
        confirm: confirm_erased::<C, K>,
        remove: remove_erased::<C>,
        interpolated: false,
        owner_only: false,
        predicted: false,
    });
    reg.comp_index.insert(TypeId::of::<C>(), i);
    i
}

/// A game message a client sent, read on the server with `MessageReader<FromClient<M>>`.
#[derive(Message, Clone, Debug)]
pub struct FromClient<M: Send + Sync + 'static> {
    pub client: super::endpoint::ClientId,
    pub message: M,
}

/// A game message from the server, read on clients with `MessageReader<FromServer<M>>`.
#[derive(Message, Clone, Debug)]
pub struct FromServer<M: Send + Sync + 'static>(pub M);

/// Registration API (see the module docs).
pub trait NetAppExt {
    /// Replicate a serde component (postcard encoding).
    fn replicate<C: Component + Clone + Serialize + DeserializeOwned>(&mut self) -> &mut Self;
    /// Replicate a component with a custom [`Codec`].
    fn replicate_with<C: Component + Clone, K: Codec<C>>(&mut self) -> &mut Self;
    /// Replicate a serde component to its entity's owner only (other clients never see it).
    fn replicate_owner_only<C: Component + Clone + Serialize + DeserializeOwned>(&mut self) -> &mut Self;
    /// `Transform` with [`TransformCodec`], interpolated on clients.
    fn replicate_transform(&mut self) -> &mut Self;
    /// Interpolate `C` on remote entities between snapshots with `lerp(a, b, t)`.
    /// `C` must be replicated.
    fn interpolate<C: Component<Mutability = bevy::ecs::component::Mutable> + Clone>(&mut self, lerp: fn(&C, &C, f32) -> C) -> &mut Self;
    /// A game message type both ways on `channel`.
    fn add_net_message<M: Serialize + DeserializeOwned + Send + Sync + Clone + 'static>(&mut self, channel: Channel) -> &mut Self;
    /// Client-side prediction of `S` driven by input `I`: `step(&mut state, &input, dt)` runs
    /// every fixed tick on the server (owned entities) and the owning client (local entity);
    /// the client rolls back to the server's state and replays its buffered inputs when they
    /// disagree. `S` must be replicated. The game writes [`super::LocalInput<I>`] each frame.
    fn predict<S, I>(&mut self, step: fn(&mut S, &I, f32)) -> &mut Self
    where
        S: Component<Mutability = bevy::ecs::component::Mutable> + Clone,
        I: Serialize + DeserializeOwned + Clone + Default + Send + Sync + 'static;
}

impl NetAppExt for App {
    fn replicate_owner_only<C: Component + Clone + Serialize + DeserializeOwned>(&mut self) -> &mut Self {
        self.replicate::<C>();
        let mut reg = registry(self);
        let i = reg.index_of::<C>().unwrap();
        reg.components[i].owner_only = true;
        self
    }

    fn replicate<C: Component + Clone + Serialize + DeserializeOwned>(&mut self) -> &mut Self {
        self.replicate_with::<C, Postcard>()
    }

    fn replicate_with<C: Component + Clone, K: Codec<C>>(&mut self) -> &mut Self {
        registry(self);
        add_rule::<C, K>(self);
        self
    }

    fn replicate_transform(&mut self) -> &mut Self {
        self.replicate_with::<Transform, TransformCodec>().interpolate::<Transform>(|a, b, t| Transform {
            translation: a.translation.lerp(b.translation, t),
            rotation: a.rotation.slerp(b.rotation, t),
            scale: a.scale.lerp(b.scale, t),
        })
    }

    fn interpolate<C: Component<Mutability = bevy::ecs::component::Mutable> + Clone>(&mut self, lerp: fn(&C, &C, f32) -> C) -> &mut Self {
        let mut reg = registry(self);
        let i = reg.index_of::<C>().unwrap_or_else(|| panic!("interpolate::<{}>: replicate it first", std::any::type_name::<C>()));
        if reg.components[i].interpolated {
            return self;
        }
        reg.components[i].interpolated = true;
        self.add_systems(
            PostUpdate,
            (move |clock: Res<super::NetClock>, q: Query<(&mut C, &NetHistory<C>), With<super::Interpolated>>| {
                super::client::interpolate_system(clock, q, lerp)
            })
            .in_set(super::NetSet::Interpolate),
        );
        self
    }

    fn add_net_message<M: Serialize + DeserializeOwned + Send + Sync + Clone + 'static>(&mut self, channel: Channel) -> &mut Self {
        let mut reg = registry(self);
        if reg.message_kind::<M>().is_some() {
            return self;
        }
        let k = reg.messages.len() as u16;
        reg.messages.push(MessageRule { name: std::any::type_name::<M>(), channel });
        reg.msg_index.insert(TypeId::of::<M>(), k);
        self.add_message::<FromClient<M>>().add_message::<FromServer<M>>();
        self.world_mut().get_resource_or_init::<super::messages::MessageDecoders>().0.push(super::messages::decode_into::<M>);
        self
    }

    fn predict<S, I>(&mut self, step: fn(&mut S, &I, f32)) -> &mut Self
    where
        S: Component<Mutability = bevy::ecs::component::Mutable> + Clone,
        I: Serialize + DeserializeOwned + Clone + Default + Send + Sync + 'static,
    {
        let mut reg = registry(self);
        let i = reg.index_of::<S>().unwrap_or_else(|| panic!("predict::<{}>: replicate it first", std::any::type_name::<S>()));
        reg.components[i].predicted = true;
        let new_input = reg.input_kind::<I>().is_none();
        if new_input {
            let k = reg.inputs.len() as u16;
            reg.inputs.push(std::any::type_name::<I>());
            reg.input_index.insert(TypeId::of::<I>(), k);
        }
        if new_input {
            super::predict::add_input::<I>(self);
        }
        super::predict::add_prediction::<S, I>(self, step);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transform_codec_round_trips_quantised() {
        let t = Transform::from_xyz(12.3456, -0.0004, 1000.25).with_rotation(Quat::from_rotation_y(1.0)).with_scale(Vec3::splat(2.0));
        let mut b = Vec::new();
        TransformCodec::encode(&t, &mut b);
        let u = TransformCodec::decode(&mut Reader::new(&b)).unwrap();
        assert!((u.translation - t.translation).abs().max_element() <= POSITION_STEP * 0.5 + 1e-4);
        assert!(u.rotation.angle_between(t.rotation) < 0.005);
        assert_eq!(u.scale, t.scale);
        let mut b2 = Vec::new();
        TransformCodec::encode(&Transform::from_xyz(1.0, 2.0, 3.0), &mut b2);
        assert!(b2.len() <= 7, "identity rotation + unit scale is tiny: {}", b2.len());
    }

    #[test]
    fn postcard_codec_round_trips() {
        #[derive(Serialize, serde::Deserialize, PartialEq, Debug)]
        struct H {
            hp: u16,
            name: String,
        }
        let mut b = Vec::new();
        Postcard::encode(&H { hp: 300, name: "x".into() }, &mut b);
        b.push(99);
        let mut r = Reader::new(&b);
        let h: H = Postcard::decode(&mut r).unwrap();
        assert_eq!(h, H { hp: 300, name: "x".into() });
        assert_eq!(r.u8().unwrap(), 99, "reader left right after the value");
    }
}
