//! The sound middleware headless, through `App::update()`: cue rules, voice limits and
//! stealing, culling/virtual voices, the offline renderer (real samples), ducking, snapshots,
//! zones, music scheduling, captions, occlusion, the legacy `audio::play` bridge and the
//! control commands. `examples/sound_demo.rs` is run headless too.
#![cfg(feature = "sound")]

#[path = "../examples/sound_demo.rs"]
#[allow(dead_code)]
mod demo;

use std::path::{Path, PathBuf};
use std::time::Duration;

use bevy::ecs::system::RunSystemOnce;
use engine::prelude::*;
use engine::sound::{Outcome, SoundBackend, VoiceState, Voices, synth};

const STEP: Duration = Duration::from_nanos(16_666_667);

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-sound-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn build(dir: &Path, cfg: SoundConfig) -> App {
    build_with(dir, cfg, |_| {})
}

fn build_with(dir: &Path, cfg: SoundConfig, extra: impl FnOnce(&mut App)) -> App {
    let mut app = engine::app_with(GameInfo::new("engine-sound-test", "Sound test"), EngineOptions::headless_test(dir));
    extra(&mut app);
    app.insert_resource(cfg).insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(STEP));
    app.finish();
    app.cleanup();
    app
}

fn offline() -> SoundConfig {
    SoundConfig { offline: true, capture_secs: 4.0, ..default() }
}

fn run(app: &mut App, frames: usize) {
    for _ in 0..frames {
        app.update();
    }
}

fn add_clip(app: &mut App, c: SoundClip) -> Handle<SoundClip> {
    app.world_mut().resource_mut::<Assets<SoundClip>>().add(c)
}

fn add_cue(app: &mut App, cue: SoundCue) {
    app.world_mut().resource_mut::<SoundCues>().add(cue);
}

fn play(app: &mut App, cue: &'static str, at: Option<Vec3>) -> VoiceId {
    let id = app.world_mut().resource_mut::<SoundCtl>().play_with(cue, PlayParams { at, ..default() });
    app.update();
    id
}

fn outcome(app: &App, id: VoiceId) -> Outcome {
    app.world().resource::<Voices>().outcome(id).expect("request resolved")
}

fn stats(app: &App) -> SoundStats {
    app.world().resource::<SoundStats>().clone()
}

fn camera(app: &mut App, at: Vec3) -> Entity {
    app.world_mut().spawn((MainCamera, Transform::from_translation(at).looking_to(Vec3::NEG_Z, Vec3::Y))).id()
}

fn energy(s: &[f32]) -> f32 {
    s.iter().map(|x| x * x).sum::<f32>() / s.len().max(1) as f32
}

#[test]
fn cue_rules_cooldown_instances_and_selection() {
    let dir = temp_dir("cues");
    let mut app = build(&dir, offline());
    run(&mut app, 2);
    let a = add_clip(&mut app, synth::blip(800.0, 0.5));
    let b = add_clip(&mut app, synth::blip(900.0, 0.5));
    add_cue(&mut app, SoundCue::new("click").clips([a.clone(), b]).cooldown(0.1));
    add_cue(&mut app, SoundCue::new("step").clip(a.clone()).max_instances(2, Steal::Oldest));
    add_cue(&mut app, SoundCue::new("only2").clip(a).max_instances(2, Steal::Reject));

    let first = play(&mut app, "click", None);
    assert_eq!(outcome(&app, first), Outcome::Playing);
    let again = play(&mut app, "click", None);
    assert_eq!(outcome(&app, again), Outcome::Cooldown, "within 0.1 s");
    run(&mut app, 8);
    let later = play(&mut app, "click", None);
    assert_eq!(outcome(&app, later), Outcome::Playing, "cooldown over");

    let s1 = play(&mut app, "step", None);
    let _s2 = play(&mut app, "step", None);
    let s3 = play(&mut app, "step", None);
    assert_eq!(outcome(&app, s3), Outcome::Playing);
    let v = app.world().resource::<Voices>();
    assert!(v.get(s1).is_none_or(|i| i.state == VoiceState::Stopping), "oldest instance stolen");
    let r1 = play(&mut app, "only2", None);
    let _r2 = play(&mut app, "only2", None);
    let r3 = play(&mut app, "only2", None);
    assert_eq!((outcome(&app, r1), outcome(&app, r3)), (Outcome::Playing, Outcome::MaxInstances));
    let unknown = play(&mut app, "nope", None);
    assert_eq!(outcome(&app, unknown), Outcome::UnknownCue);
    let st = stats(&app);
    assert_eq!((st.rejected_cooldown, st.rejected_instances), (1, 1));
    assert!(st.stolen >= 1);
    // One-shots end by themselves (renderer reports them done).
    run(&mut app, 60);
    assert_eq!(app.world().resource::<Voices>().len(), 0, "all finished");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn voice_limit_priority_stealing_culling_and_virtual_voices() {
    let dir = temp_dir("limits");
    let mut app = build(&dir, SoundConfig { max_voices: 4, ..offline() });
    let cam = camera(&mut app, Vec3::ZERO);
    run(&mut app, 2);
    let loop_clip = add_clip(&mut app, synth::drone(220.0, 1.0));
    let near = Attenuation { min_distance: 1.0, max_distance: 30.0, occlusion: false, ..default() };
    add_cue(&mut app, SoundCue::new("bed").clip(loop_clip.clone()).looping().priority(50).spatial(near.clone()));
    add_cue(&mut app, SoundCue::new("vip").clip(loop_clip.clone()).looping().priority(250));
    add_cue(&mut app, SoundCue::new("far").clip(loop_clip.clone()).spatial(near.clone()));
    add_cue(&mut app, SoundCue::new("quiet").clip(loop_clip.clone()).priority(10).spatial(near.clone()));

    let beds: Vec<VoiceId> = (0..4).map(|i| play(&mut app, "bed", Some(Vec3::new(0.0, 0.0, -2.0 - i as f32 * 4.0)))).collect();
    assert!(beds.iter().all(|b| outcome(&app, *b) == Outcome::Playing));
    // A fifth, high-priority voice steals the lowest-scored one: the farthest bed.
    let vip = play(&mut app, "vip", None);
    assert_eq!(outcome(&app, vip), Outcome::Playing);
    let v = app.world().resource::<Voices>();
    assert_eq!(v.get(beds[3]).unwrap().state, VoiceState::Virtual, "farthest bed virtualised (keeps its clock)");
    assert_eq!(v.get(beds[0]).unwrap().state, VoiceState::Playing);
    assert_eq!(stats(&app).active, 4);
    // An inaudible one-shot is never started.
    let far = play(&mut app, "far", Some(Vec3::new(0.0, 0.0, -100.0)));
    assert_eq!(outcome(&app, far), Outcome::Culled);
    // Low priority one-shot while the limit is full of higher-scored voices → dropped.
    let quiet = play(&mut app, "quiet", Some(Vec3::new(0.0, 0.0, -3.0)));
    assert_eq!(outcome(&app, quiet), Outcome::VoiceLimit);
    assert_eq!(stats(&app).voice_limited, 1);
    // Stop the VIP: the virtual bed comes back.
    let vip_id = vip;
    app.world_mut().resource_mut::<SoundCtl>().stop(vip_id, 0.0);
    run(&mut app, 5);
    let v = app.world().resource::<Voices>();
    assert_eq!(v.get(beds[3]).unwrap().state, VoiceState::Playing, "revived when a slot freed");
    assert!(stats(&app).revived >= 1);
    // Walk away: every bed goes virtual (no render work), come back: they play again.
    app.world_mut().entity_mut(cam).insert(Transform::from_xyz(0.0, 0.0, 500.0));
    run(&mut app, 3);
    let st = stats(&app);
    assert_eq!((st.active, st.virtual_voices), (0, 4), "{st:?}");
    run(&mut app, 3);
    assert_eq!(app.world().resource::<SoundBackend>().capture().len() % 2, 0);
    app.world_mut().entity_mut(cam).insert(Transform::from_xyz(0.0, 0.0, 0.0));
    run(&mut app, 3);
    assert_eq!(stats(&app).active, 4);
    let meters = stats(&app).meters;
    assert!(meters[BusId::SFX.0 as usize] > 0.01, "beds render on the sfx bus: {meters:?}");
    assert_eq!(meters[BusId::MUSIC.0 as usize], 0.0, "nothing on music");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn offline_render_ducking_captions_and_bus_volumes() {
    let dir = temp_dir("duck");
    let mut app = build(&dir, offline());
    run(&mut app, 2);
    let bed = add_clip(&mut app, synth::drone(220.0, 1.0));
    let line = add_clip(&mut app, synth::babble(1.0, 150.0));
    add_cue(&mut app, SoundCue::new("music.bed").clip(bed).looping().bus("music"));
    add_cue(&mut app, SoundCue::new("line").clip(line).bus("voice").caption(Caption::speech("Ada", "Hold the door.")));
    play(&mut app, "music.bed", None);
    run(&mut app, 20);
    {
        let mut b = app.world_mut().resource_mut::<SoundBackend>();
        assert!(energy(b.capture()) > 1e-3, "the renderer produced sound");
        b.clear_capture();
    }
    run(&mut app, 30);
    let before = energy(app.world().resource::<SoundBackend>().capture());
    app.world_mut().resource_mut::<SoundBackend>().clear_capture();
    play(&mut app, "line", None);
    run(&mut app, 30);
    let mixer = app.world().resource::<Mixer>();
    assert!((mixer.get(BusId::MUSIC).unwrap().duck_db + 9.0).abs() < 0.01, "voice ducks music by 9 dB");
    let caps = app.world().resource::<engine::sound::Captions>();
    assert_eq!(caps.lines.len(), 1);
    assert_eq!(caps.lines[0].speaker.as_deref(), Some("Ada"));
    // Release after the line ends (1 s + hold 0.25 + release 0.7).
    run(&mut app, 150);
    assert_eq!(app.world().resource::<Mixer>().get(BusId::MUSIC).unwrap().duck_db, 0.0);
    // Settings drive bus volume: music at 0 → silent music bus → the loop goes virtual.
    app.world_mut().resource_mut::<SoundBackend>().clear_capture();
    app.world_mut().resource_mut::<engine::settings::CoreSettings>().music_volume = 0.0;
    run(&mut app, 30);
    app.world_mut().resource_mut::<SoundBackend>().clear_capture();
    run(&mut app, 10);
    let after = energy(app.world().resource::<SoundBackend>().capture());
    assert!(after < before * 1e-4, "music muted through settings: {after} vs {before}");
    assert_eq!(stats(&app).virtual_voices, 1, "inaudible loop is virtual, not rendered");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn pause_snapshot_zones_and_reverb() {
    let dir = temp_dir("snap");
    let mut app = build(&dir, offline());
    camera(&mut app, Vec3::ZERO);
    run(&mut app, 2);
    let drip = add_clip(&mut app, synth::drone(55.0, 1.0));
    add_cue(&mut app, SoundCue::new("amb.cave").clip(drip).looping().bus("ambience"));
    app.world_mut().run_system_cached(|mut p: PauseCtl| p.set(true)).unwrap();
    run(&mut app, 30);
    let m = app.world().resource::<Mixer>();
    assert_eq!(m.snapshot_weight("paused"), 1.0);
    assert!((m.get(BusId::SFX).unwrap().lowpass_hz - 900.0).abs() < 1.0, "paused: sfx muffled");
    app.world_mut().run_system_cached(|mut p: PauseCtl| p.set(false)).unwrap();
    run(&mut app, 60);
    assert_eq!(app.world().resource::<Mixer>().snapshot_weight("paused"), 0.0);

    let zone = app.world_mut().spawn((Transform::from_xyz(0.0, 0.0, 0.0), SoundZone::sphere(5.0).snapshot("cave").ambience("amb.cave"))).id();
    run(&mut app, 60);
    let m = app.world().resource::<Mixer>();
    assert_eq!(m.snapshot_weight("cave"), 1.0, "listener inside the cave");
    assert!(m.get(BusId::SFX).unwrap().reverb_send > 0.4);
    let st = stats(&app);
    assert_eq!(st.active, 1, "cave ambience playing");
    app.world_mut().despawn(zone);
    run(&mut app, 30);
    assert_eq!(app.world().resource::<Mixer>().snapshot_weight("cave"), 0.0);
    assert_eq!(stats(&app).active, 0, "ambience stopped with its zone");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn music_layers_and_quantized_transitions() {
    let dir = temp_dir("music");
    let mut app = build(&dir, offline());
    app.init_resource::<Beats>().add_systems(Update, count_beats);
    run(&mut app, 2);
    let mk = |app: &mut App, k| add_clip(app, synth::music_stem(k, 120.0, 1, 55.0));
    let (pad, drums) = (mk(&mut app, synth::Stem::Pad), mk(&mut app, synth::Stem::Drums));
    let lead = mk(&mut app, synth::Stem::Lead);
    {
        let mut m = app.world_mut().resource_mut::<Music>();
        m.add_track(MusicTrack::new("a", 120.0).stem(MusicStem::always(pad.clone())).stem(MusicStem::at(drums, 0.5)));
        m.add_track(MusicTrack::new("b", 120.0).stem(MusicStem::always(lead)));
        m.play("a", MusicTransition { quantize: Quantize::Immediate, ..default() });
    }
    run(&mut app, 3);
    let origin_a = app.world().resource::<Music>().origin().expect("started");
    run(&mut app, 70); // > 1 s → beats 0..2 at 120 bpm
    assert!(app.world().resource::<Beats>().0 >= 2, "MusicBeat messages fire");
    assert_eq!(stats(&app).music_voices, 2);
    app.world_mut().resource_mut::<Music>().play("b", MusicTransition::default());
    run(&mut app, 2);
    let m = app.world().resource::<Music>();
    assert_eq!(m.current(), Some("b"));
    let origin_b = m.origin().unwrap();
    let bar = 48_000 * 2; // 4 beats at 120 bpm
    assert_eq!((origin_b - origin_a) % bar, 0, "transition lands on a bar line");
    assert!(origin_b > app.world().resource::<SoundBackend>().clock() - 48_000, "scheduled ahead");
    let _ = std::fs::remove_dir_all(dir);
}

#[derive(Resource, Default)]
struct Beats(u32);

fn count_beats(mut r: MessageReader<MusicBeat>, mut b: ResMut<Beats>) {
    b.0 += r.read().count() as u32;
}

#[cfg(feature = "physics")]
#[test]
fn occlusion_raycast_muffles_through_walls() {
    use engine::avian3d::prelude::*;
    let dir = temp_dir("occl");
    let mut app = build(&dir, offline());
    camera(&mut app, Vec3::new(0.0, 1.0, 0.0));
    let wall = app.world_mut().spawn((Transform::from_xyz(0.0, 1.0, -5.0), RigidBody::Static, Collider::cuboid(6.0, 4.0, 0.5))).id();
    run(&mut app, 5);
    let clip = add_clip(&mut app, synth::drone(330.0, 1.0));
    add_cue(&mut app, SoundCue::new("radio").clip(clip).looping().spatial(Attenuation { max_distance: 50.0, ..default() }));
    let id = play(&mut app, "radio", Some(Vec3::new(0.0, 1.0, -10.0)));
    run(&mut app, 60);
    let v = app.world().resource::<Voices>().get(id).unwrap();
    assert!(v.occlusion > 0.9, "behind the wall: {v:?}");
    app.world_mut().despawn(wall);
    run(&mut app, 60);
    let v = app.world().resource::<Voices>().get(id).unwrap();
    assert!(v.occlusion < 0.1, "wall gone: {v:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn legacy_audio_play_routes_into_the_mixer() {
    let dir = temp_dir("legacy");
    let mut app = build(&dir, offline());
    app.init_asset::<bevy::audio::AudioSource>();
    run(&mut app, 2);
    app.world_mut().resource_mut::<Volumes>().muted = false;
    let bytes = synth::tone(440.0, 0.5, 0.5).to_wav();
    let h = app.world_mut().resource_mut::<Assets<bevy::audio::AudioSource>>().add(bevy::audio::AudioSource { bytes: bytes.into() });
    app.world_mut().resource_mut::<SoundLibrary>().0.insert("beep", vec![h.clone()]);
    app.world_mut()
        .run_system_cached(|mut c: Commands, lib: Res<SoundLibrary>, vol: Res<Volumes>| engine::audio::play(&mut c, &lib, &vol, "beep", AudioCategory::Ui, 1.0, None))
        .unwrap();
    run(&mut app, 2);
    let v: Vec<_> = app.world().resource::<Voices>().iter().collect();
    assert_eq!(v.len(), 1);
    assert_eq!((v[0].bus, v[0].state), (BusId::UI, VoiceState::Playing));
    let e = app
        .world_mut()
        .run_system_once(move |mut c: Commands, vol: Res<Volumes>| engine::audio::play_loop(&mut c, &vol, h.clone(), AudioCategory::Music, 0.5))
        .unwrap()
        .expect("loop entity");
    run(&mut app, 2);
    assert_eq!(app.world().resource::<Voices>().iter().filter(|v| v.looping && v.bus == BusId::MUSIC).count(), 1);
    app.world_mut().despawn(e);
    run(&mut app, 10);
    assert_eq!(app.world().resource::<Voices>().iter().filter(|v| v.looping).count(), 0, "despawning the entity stops the loop");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn demo_runs_headless_and_settings_persist() {
    let dir = temp_dir("demo");
    let mut app = build_with(&dir, offline(), |a| {
        a.add_plugins(demo::SoundDemo);
    });
    run(&mut app, 120);
    let st = stats(&app);
    assert_eq!(st.backend, "offline");
    assert!(st.active >= 2, "drone + radio playing: {st:?}");
    // Started on the very first frame (before the bus topology reached the renderer).
    assert!(st.meters[BusId::SFX.0 as usize] > 1e-3, "first-frame voices land on their bus: {:?}", st.meters);
    assert_eq!(app.world().resource::<Music>().current(), Some("explore"));
    let drone_pan = app.world().resource::<Voices>().iter().find(|v| v.looping && v.distance > 1.0 && v.bus == BusId::SFX).map(|v| v.pan);
    assert!(drone_pan.is_some());
    // Demo turned captions on → sound.json written after the debounce.
    run(&mut app, 60);
    let saved = std::fs::read_to_string(dir.join("sound.json")).expect("sound.json");
    assert!(saved.contains("\"captions\": true"), "{saved}");
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(feature = "devtools")]
#[test]
fn control_commands_drive_and_report() {
    use engine::devtools::control::{ControlRegistry, Handler};
    use serde_json::{Value, json};
    let dir = temp_dir("ctl");
    let mut app = build_with(&dir, offline(), |a| {
        a.add_plugins(demo::SoundDemo);
    });
    run(&mut app, 10);
    let call = |app: &mut App, id: &str, p: Value| -> Value {
        let cmd = app.world().resource::<ControlRegistry>().get(id).unwrap_or_else(|| panic!("{id} registered")).clone();
        let Handler::Instant(f) = cmd.handler else { panic!("instant") };
        f(app.world_mut(), p).unwrap_or_else(|e| panic!("{id}: {e}"))
    };
    let r = call(&mut app, "sound.play", json!({"cue": "guard.alert"}));
    assert_eq!(r["outcome"], "playing");
    let r = call(&mut app, "sound.play", json!({"cue": "boom", "pos": [0.0, 0.0, -500.0]}));
    assert_eq!(r["outcome"], "culled");
    run(&mut app, 5);
    let s = call(&mut app, "sound.stats", json!({}));
    assert!(s["active"].as_u64().unwrap() >= 3, "{s}");
    assert!(s["buses"].as_array().unwrap().iter().any(|b| b["name"] == "voice"));
    let c = call(&mut app, "sound.captions", json!({"size": "large"}));
    assert_eq!(c["lines"][0]["speaker"], "Guard");
    assert_eq!(c["size"], "large");
    let b = call(&mut app, "sound.bus", json!({"name": "music", "volume": 0.25}));
    assert!(b["buses"].as_array().unwrap().iter().any(|b| b["name"] == "music" && b["volume"] == 0.25));
    assert_eq!(app.world().resource::<engine::settings::CoreSettings>().music_volume, 0.25, "persisted through settings");
    let sn = call(&mut app, "sound.snapshot", json!({"name": "underwater"}));
    assert!(sn["available"].as_array().unwrap().len() >= 3);
    run(&mut app, 40);
    assert_eq!(app.world().resource::<Mixer>().snapshot_weight("underwater"), 1.0);
    let m = call(&mut app, "sound.music", json!({"track": "combat", "intensity": 1.0, "quantize": "beat"}));
    assert_eq!(m["pending"], "combat");
    run(&mut app, 30);
    let m = call(&mut app, "sound.music", json!({}));
    assert_eq!(m["track"], "combat");
    assert!(call(&mut app, "sound.cues", json!({}))["cues"].as_array().unwrap().len() >= 6);
    call(&mut app, "sound.stop", json!({}));
    run(&mut app, 10);
    assert_eq!(stats(&app).active, 0);
    let _ = std::fs::remove_dir_all(dir);
}

/// `cargo test --test sound -- --ignored --nocapture bench`: DSP and logic cost (numbers in
/// docs/SOUND.md). Dev profile: the engine crate builds at opt-level 1. Writes the `sound` bench
/// report.
#[test]
#[ignore]
fn bench_dsp_and_logic() {
    use std::time::Instant;
    // DSP: 48 voices (half low-passed, panned), 6 buses, reverb on, 10 s of audio.
    let dir = temp_dir("bench");
    let mut app = build(&dir, SoundConfig { max_voices: 48, ..offline() });
    camera(&mut app, Vec3::ZERO);
    run(&mut app, 2);
    let clip = add_clip(&mut app, synth::drone(220.0, 1.0));
    add_cue(&mut app, SoundCue::new("v").clip(clip.clone()).looping().spatial(Attenuation { max_distance: 400.0, occlusion: false, ..default() }));
    add_cue(&mut app, SoundCue::new("virt").clip(clip).looping().priority(0).spatial(Attenuation { max_distance: 400.0, occlusion: false, ..default() }));
    for i in 0..48 {
        let a = i as f32 * 0.4;
        app.world_mut().resource_mut::<SoundCtl>().play_at("v", Vec3::new(a.cos() * (2.0 + i as f32), 0.0, a.sin() * (2.0 + i as f32)));
    }
    app.world_mut().resource_mut::<Mixer>().set_snapshot("cave", true);
    app.world_mut().resource_mut::<Mixer>().set_snapshot("underwater", true);
    run(&mut app, 60);
    let rate = 48_000usize;
    let t = Instant::now();
    app.world_mut().resource_mut::<SoundBackend>().render_offline(rate * 10);
    let dsp = t.elapsed().as_secs_f64();
    println!("dsp: 48 voices + 6 buses + reverb: {:.2} ms per 10 s of audio = {:.3}% of one core", dsp * 1e3, dsp / 10.0 * 100.0);

    // Logic only (no renderer): 48 real + 200 virtual voices vs the same app idle.
    let mut logic = build(&dir, SoundConfig { max_voices: 48, ..default() });
    camera(&mut logic, Vec3::ZERO);
    run(&mut logic, 2);
    let clip = add_clip(&mut logic, synth::drone(220.0, 1.0));
    let att = Attenuation { max_distance: 400.0, ..default() };
    add_cue(&mut logic, SoundCue::new("v").clip(clip).looping().spatial(att));
    run(&mut logic, 30);
    let frame = |app: &mut App| {
        let t = Instant::now();
        run(app, 600);
        t.elapsed().as_secs_f64() / 600.0 * 1e3
    };
    let idle = frame(&mut logic);
    for i in 0..2048 {
        let a = i as f32 * 0.4;
        // The far ones (beyond the voice limit, quieter) stay virtual.
        logic.world_mut().resource_mut::<SoundCtl>().play_at("v", Vec3::new(a.cos() * (2.0 + i as f32 * 0.15), 1.0, a.sin() * (2.0 + i as f32 * 0.15)));
    }
    run(&mut logic, 30);
    let st = stats(&logic);
    let busy = frame(&mut logic);
    println!("logic: active {} virtual {} (occlusion rays 8/frame): {:.3} ms/frame vs {:.3} idle → {:.3} ms", st.active, st.virtual_voices, busy, idle, busy - idle);
    engine::devkit::BenchReport::new("sound")
        .value("dsp.48voices.core_pct", dsp / 10.0 * 100.0)
        .value("logic.busy_ms", busy)
        .value("logic.idle_ms", idle)
        .value("logic.delta_ms", busy - idle)
        .write()
        .unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
