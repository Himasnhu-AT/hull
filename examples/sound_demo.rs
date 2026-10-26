//! Sound middleware demo: generated sounds only (no assets). A drone circles the camera (3D,
//! doppler), a wall occludes a radio, a cave zone adds reverb + a drip bed, dialogue ducks the
//! music and shows captions, and layered music reacts to an intensity.
//!
//! `cargo run --example sound_demo -- --play` (add `--sound` with `--control`, which mutes by
//! default). Keys: 1 click, 2 dialogue, 3 explosion, 4 footsteps, M intensity, T track, C cave,
//! P pause snapshot. Drive it from the control port with `sound.*` (see docs/SOUND.md).
//! `tests/sound.rs` runs it headless.

use engine::prelude::*;
use engine::sound::synth::{self, Stem};
use engine::sound::{Caption, ZoneShape};

pub fn info() -> GameInfo {
    GameInfo::new("engine-sound-demo", "Sound demo").tagline("Buses, cues, 3D, music, captions.")
}

pub struct SoundDemo;

impl Plugin for SoundDemo {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, (setup_sounds, spawn_world)).add_systems(Update, (orbit, keys));
    }
}

/// The circling emitter.
#[derive(Component)]
pub struct Drone;

/// The radio behind the wall.
#[derive(Component)]
pub struct Radio;

pub fn setup_sounds(mut cues: ResMut<SoundCues>, mut clips: ResMut<Assets<SoundClip>>, mut music: ResMut<Music>, mut settings: ResMut<SoundSettings>) {
    let mut add = |c: SoundClip| clips.add(c);
    cues.add(SoundCue::new("ui.click").clip(add(synth::blip(1_200.0, 0.06))).bus("ui").cooldown(0.03));
    let steps: Vec<_> = (1..=4).map(|s| add(synth::noise_burst(0.12, s * 7919))).collect();
    cues.add(
        SoundCue::new("step")
            .clips(steps)
            .pick(Pick::Shuffle)
            .pitch_jitter(1.5)
            .volume_jitter(2.0)
            .max_instances(4, Steal::Oldest)
            .spatial(Attenuation { max_distance: 25.0, ..default() })
            .caption(Caption::sound("Footsteps")),
    );
    cues.add(
        SoundCue::new("boom")
            .clip(add(synth::noise_burst(0.9, 3)))
            .priority(200)
            .spatial(Attenuation { min_distance: 3.0, max_distance: 80.0, ..default() })
            .caption(Caption::sound("Explosion")),
    );
    cues.add(
        SoundCue::new("guard.alert")
            .clips([add(synth::babble(1.4, 140.0)), add(synth::babble(1.2, 160.0))])
            .pick(Pick::Sequence)
            .bus("voice")
            .priority(220)
            .caption(Caption::speech("Guard", "Who's there?"))
            .caption(Caption::speech("Guard", "Show yourself!")),
    );
    cues.add(
        SoundCue::new("drone")
            .clip(add(synth::drone(110.0, 2.0)))
            .looping()
            .fade_in(0.5)
            .spatial(Attenuation { min_distance: 2.0, max_distance: 30.0, ..default() }),
    );
    cues.add(
        SoundCue::new("radio")
            .clip(add(synth::babble(3.0, 220.0)))
            .looping()
            .volume(-6.0)
            .spatial(Attenuation { min_distance: 1.0, max_distance: 20.0, ..default() }),
    );
    cues.add(SoundCue::new("amb.cave").clip(add(synth::drone(55.0, 4.0))).looping().bus("ambience").volume(-4.0));

    let s = |k: Stem, bpm: f32| synth::music_stem(k, bpm, 2, 55.0);
    let (pad, bass, drums, lead) = (add(s(Stem::Pad, 100.0)), add(s(Stem::Bass, 100.0)), add(s(Stem::Drums, 100.0)), add(s(Stem::Lead, 100.0)));
    music.add_track(
        MusicTrack::new("explore", 100.0)
            .stem(MusicStem::always(pad))
            .stem(MusicStem::at(bass, 0.25))
            .stem(MusicStem::at(drums, 0.5))
            .stem(MusicStem::at(lead, 0.75))
            .volume(-4.0),
    );
    let s2 = |k: Stem| synth::music_stem(k, 140.0, 2, 73.4);
    music.add_track(
        MusicTrack::new("combat", 140.0)
            .intro(add(synth::chirp(200.0, 800.0, 60.0 / 140.0 * 4.0)))
            .stem(MusicStem::always(add(s2(Stem::Drums))))
            .stem(MusicStem::always(add(s2(Stem::Bass))))
            .stem(MusicStem::at(add(s2(Stem::Lead)), 0.5))
            .volume(-4.0),
    );
    music.snap_intensity(0.3);
    music.play("explore", MusicTransition { quantize: Quantize::Immediate, ..default() });
    settings.captions = true;
}

fn spawn_world(mut commands: Commands, headless: Res<Headless>, mut meshes: Option<ResMut<Assets<Mesh>>>, mut mats: Option<ResMut<Assets<StandardMaterial>>>, mut ctl: ResMut<SoundCtl>) {
    let mut look = |mesh: Mesh, color: Color| match (meshes.as_mut(), mats.as_mut()) {
        (Some(m), Some(s)) => Some((Mesh3d(m.add(mesh)), MeshMaterial3d(s.add(StandardMaterial { base_color: color, perceptual_roughness: 0.8, ..default() })))),
        _ => None,
    };
    let mut ground = commands.spawn((Name::new("Ground"), Transform::from_xyz(0.0, -0.1, 0.0)));
    if let Some(l) = look(Cuboid::new(60.0, 0.2, 60.0).into(), Color::srgb(0.3, 0.33, 0.3)) {
        ground.insert(l);
    }
    // A wall between the camera and the radio: occludes it (feature physics).
    let mut wall = commands.spawn((Name::new("Wall"), Transform::from_xyz(0.0, 1.5, -6.0)));
    if let Some(l) = look(Cuboid::new(6.0, 3.0, 0.4).into(), Color::srgb(0.55, 0.5, 0.45)) {
        wall.insert(l);
    }
    #[cfg(feature = "physics")]
    wall.insert((engine::avian3d::prelude::RigidBody::Static, engine::avian3d::prelude::Collider::cuboid(6.0, 3.0, 0.4)));
    let radio = commands.spawn((Name::new("Radio"), Radio, Transform::from_xyz(0.0, 1.0, -10.0))).id();
    if let Some(l) = look(Cuboid::new(0.6, 0.4, 0.3).into(), Color::srgb(0.2, 0.7, 0.4)) {
        commands.entity(radio).insert(l);
    }
    ctl.play_on("radio", radio);
    let drone = commands.spawn((Name::new("Drone"), Drone, Transform::from_xyz(8.0, 1.5, 0.0))).id();
    if let Some(l) = look(Sphere::new(0.4).into(), Color::srgb(0.9, 0.4, 0.2)) {
        commands.entity(drone).insert(l);
    }
    ctl.play_on("drone", drone);
    // A cave 20 m to the right: reverb snapshot + drip bed while the listener is inside.
    commands.spawn((Name::new("Cave"), Transform::from_xyz(20.0, 0.0, 0.0), SoundZone { shape: ZoneShape::Sphere(6.0), ..SoundZone::default() }.snapshot("cave").ambience("amb.cave")));
    if !headless.0 {
        commands.spawn((DirectionalLight { illuminance: 9_000.0, ..default() }, Transform::from_xyz(4.0, 8.0, 2.0).looking_at(Vec3::ZERO, Vec3::Y)));
        commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 1.6, 4.0).looking_at(Vec3::new(0.0, 1.0, -6.0), Vec3::Y)));
    } else {
        commands.spawn((MainCamera, Transform::from_xyz(0.0, 1.6, 4.0).looking_at(Vec3::new(0.0, 1.0, -6.0), Vec3::Y)));
    }
}

fn orbit(time: Res<Time>, mut q: Query<&mut Transform, With<Drone>>) {
    let t = time.elapsed_secs() * 0.6;
    for mut tf in &mut q {
        tf.translation = Vec3::new(t.cos() * 8.0, 1.5, t.sin() * 8.0 + 4.0);
    }
}

fn keys(keys: Option<Res<ButtonInput<KeyCode>>>, mut ctl: ResMut<SoundCtl>, mut music: ResMut<Music>, mut mixer: ResMut<Mixer>, mut n: Local<u32>) {
    let Some(keys) = keys else { return };
    if keys.just_pressed(KeyCode::Digit1) {
        ctl.play("ui.click");
    }
    if keys.just_pressed(KeyCode::Digit2) {
        ctl.play("guard.alert");
    }
    if keys.just_pressed(KeyCode::Digit3) {
        *n += 1;
        ctl.play_at("boom", Vec3::new((*n as f32 * 2.3).sin() * 15.0, 0.0, -12.0));
    }
    if keys.just_pressed(KeyCode::Digit4) {
        ctl.play_at("step", Vec3::new(2.0, 0.0, 1.0));
    }
    if keys.just_pressed(KeyCode::KeyM) {
        let x = music.intensity();
        music.set_intensity(if x >= 0.95 { 0.0 } else { x + 0.25 });
    }
    if keys.just_pressed(KeyCode::KeyT) {
        let next = if music.current() == Some("explore") { "combat" } else { "explore" };
        music.play(next, MusicTransition::default());
    }
    if keys.just_pressed(KeyCode::KeyC) {
        let on = mixer.snapshot_weight("underwater") < 0.5;
        mixer.set_snapshot("underwater", on);
    }
}

#[allow(dead_code)]
fn main() {
    engine::app(info()).add_plugins(SoundDemo).run();
}
