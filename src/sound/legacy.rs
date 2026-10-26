//! Bridge for the original `engine::audio` API (`audio::play`, `audio::play_loop`): with the
//! `sound` feature those calls become voices on the matching bus (so they get bus volumes,
//! snapshots, ducking, the voice limit and the same renderer). The `AudioSource` handle's
//! path is loaded again as a [`SoundClip`] (decoded once, cached).

use bevy::audio::AudioSource;
use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::bus::BusId;
use super::clip::SoundClip;
use super::cue::Attenuation;
use super::voice::{PlayParams, SoundCtl, VoiceId};
use crate::audio::{AudioCategory, SinkGain};

#[derive(Resource, Default)]
pub(crate) struct LegacyClips(HashMap<AssetId<AudioSource>, Handle<SoundClip>>);

/// On the entity `audio::play_loop` returns: its voice.
#[derive(Component, Clone, Copy, Debug)]
pub struct LegacyLoop(pub VoiceId);

pub fn category_bus(c: AudioCategory) -> BusId {
    match c {
        AudioCategory::Sfx => BusId::SFX,
        AudioCategory::Music => BusId::MUSIC,
        AudioCategory::Ambience => BusId::AMBIENCE,
        AudioCategory::Ui => BusId::UI,
    }
}

fn clip_for(world: &mut World, h: &Handle<AudioSource>) -> Option<Handle<SoundClip>> {
    if let Some(c) = world.resource::<LegacyClips>().0.get(&h.id()) {
        return Some(c.clone());
    }
    let clip = if let Some(path) = h.path() {
        world.resource::<AssetServer>().load::<SoundClip>(path.clone())
    } else {
        let bytes = world.get_resource::<Assets<AudioSource>>()?.get(h)?.bytes.clone();
        let clip = SoundClip::decode(&bytes).ok()?;
        world.resource_mut::<Assets<SoundClip>>().add(clip)
    };
    world.resource_mut::<LegacyClips>().0.insert(h.id(), clip.clone());
    Some(clip)
}

/// One-shot from `audio::play` (gain already includes the caller's volume + jitter).
pub fn play_source(world: &mut World, h: Handle<AudioSource>, category: AudioCategory, gain: f32, speed: f32, at: Option<Vec3>) {
    if !world.contains_resource::<SoundCtl>() {
        return;
    }
    let Some(clip) = clip_for(world, &h) else { return };
    let spatial = at.map(|_| Attenuation { max_distance: 60.0, ..default() });
    world.resource_mut::<SoundCtl>().play_clip(clip, category_bus(category), false, spatial, PlayParams { at, volume: gain, pitch: speed, ..default() });
}

/// Loop from `audio::play_loop`, owned by `entity` (despawn it to stop; change its
/// [`SinkGain`] to re-volume).
pub fn start_loop(world: &mut World, entity: Entity, h: Handle<AudioSource>, category: AudioCategory, volume: f32) {
    if !world.contains_resource::<SoundCtl>() {
        return;
    }
    let Some(clip) = clip_for(world, &h) else { return };
    let id = world.resource_mut::<SoundCtl>().play_clip(clip, category_bus(category), true, None, PlayParams { owner: Some(entity), volume: 1.0, ..default() });
    world.resource_mut::<SoundCtl>().set_volume(id, volume);
    if let Ok(mut e) = world.get_entity_mut(entity) {
        e.insert(LegacyLoop(id));
    }
}

pub(crate) fn sync_loops(q: Query<(&LegacyLoop, &SinkGain), Changed<SinkGain>>, mut ctl: ResMut<SoundCtl>) {
    for (l, g) in &q {
        ctl.set_volume(l.0, g.0);
    }
}
