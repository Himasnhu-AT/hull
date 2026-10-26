//! Control-port commands (feature `devtools`), so agents can drive and inspect the mix:
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `sound.play` | `{cue, pos?: [x,y,z], volume?, pitch?}` | `{voice, outcome}` |
//! | `sound.stop` | `{voice?, cue?, fade?}` (neither: all) | `{}` |
//! | `sound.stats` | — | counters, `voices`, `buses`, `snapshots`, `music`, `listener` |
//! | `sound.bus` | `{name?, volume?, mute?, solo?}` | `{buses}` (core buses persist to settings) |
//! | `sound.snapshot` | `{name?, on?}` (`name: "none"` clears) | `{active, available}` |
//! | `sound.captions` | `{enabled?, size?, directions?}` | `{enabled, size, lines}` |
//! | `sound.music` | `{track?, intensity?, quantize?, fade?, stop?}` | `{track, position, intensity, tracks}` |
//! | `sound.cues` | — | `{cues: [{name, bus, clips, ...}]}` |

use bevy::prelude::*;
use serde_json::{Value, json};

use super::bus::{BusId, Mixer, lin_to_db};
use super::music::{Music, MusicTransition, Quantize};
use super::settings::{CaptionSize, SoundSettings};
use super::voice::{PlayParams, SoundCtl, VoiceId, Voices};
use super::{Captions, SoundBackend, SoundCues, SoundStats, apply_requests};
use crate::devtools::control::{AddControlCommand, params};
use crate::settings::CoreSettings;

pub(crate) fn register(app: &mut App) {
    app.add_control_command(
        "sound.play",
        "Play a sound cue (optionally at a world position)",
        params(&[("cue", "string", "cue name"), ("pos", "array", "[x, y, z] world position (3D cues)"), ("volume", "number", "linear multiplier"), ("pitch", "number", "pitch ratio")]),
        play,
    )
    .add_control_command(
        "sound.stop",
        "Stop a voice, every voice of a cue, or everything",
        params(&[("voice", "integer", "voice id"), ("cue", "string", "cue name"), ("fade", "number", "seconds")]),
        stop,
    )
    .add_control_command("sound.stats", "Voice counts, counters, buses, snapshots, music", params(&[]), stats)
    .add_control_command(
        "sound.bus",
        "List buses or set one's volume / mute / solo",
        params(&[("name", "string", "bus name"), ("volume", "number", "0..1"), ("mute", "boolean", ""), ("solo", "boolean", "")]),
        bus,
    )
    .add_control_command(
        "sound.snapshot",
        "List snapshots or turn one on/off (name \"none\" clears)",
        params(&[("name", "string", "snapshot"), ("on", "boolean", "default true")]),
        snapshot,
    )
    .add_control_command(
        "sound.captions",
        "Caption lines on screen; optionally set captions on/off, size, directions",
        params(&[("enabled", "boolean", ""), ("size", "string", "small | medium | large"), ("directions", "boolean", "")]),
        captions,
    )
    .add_control_command(
        "sound.music",
        "Music state; optionally play a track, set intensity, stop",
        params(&[
            ("track", "string", "track to play"),
            ("intensity", "number", "0..1"),
            ("quantize", "string", "immediate | beat | bar"),
            ("fade", "number", "crossfade seconds"),
            ("stop", "boolean", "fade out"),
        ]),
        music,
    )
    .add_control_command("sound.cues", "Every registered cue", params(&[]), cues);
}

fn f32_of(v: &Value, k: &str) -> Option<f32> {
    v.get(k).and_then(Value::as_f64).map(|x| x as f32)
}

fn vec3_of(v: &Value) -> Option<Vec3> {
    match v {
        Value::Array(a) if a.len() == 3 => Some(Vec3::new(a[0].as_f64()? as f32, a[1].as_f64()? as f32, a[2].as_f64()? as f32)),
        Value::Object(_) => Some(Vec3::new(f32_of(v, "x")?, f32_of(v, "y")?, f32_of(v, "z")?)),
        _ => None,
    }
}

fn play(w: &mut World, p: Value) -> Result<Value, String> {
    let cue = p.get("cue").and_then(Value::as_str).ok_or("missing `cue`")?.to_string();
    let at = match p.get("pos") {
        Some(v) => Some(vec3_of(v).ok_or("`pos` must be [x, y, z]")?),
        None => None,
    };
    let params = PlayParams { at, volume: f32_of(&p, "volume").unwrap_or(1.0), pitch: f32_of(&p, "pitch").unwrap_or(1.0), ..default() };
    let id = w.resource_mut::<SoundCtl>().play_with(cue, params);
    w.run_system_cached(apply_requests).map_err(|e| e.to_string())?;
    let outcome = w.resource::<Voices>().outcome(id).map_or("queued", |o| o.as_str());
    Ok(json!({"voice": id.0, "outcome": outcome}))
}

fn stop(w: &mut World, p: Value) -> Result<Value, String> {
    let fade = f32_of(&p, "fade").unwrap_or(0.1);
    let mut ctl = w.resource_mut::<SoundCtl>();
    if let Some(id) = p.get("voice").and_then(Value::as_u64) {
        ctl.stop(VoiceId(id as u32), fade);
    } else if let Some(cue) = p.get("cue").and_then(Value::as_str) {
        ctl.stop_cue(cue.to_string(), fade);
    } else {
        ctl.stop_all(fade);
    }
    w.run_system_cached(apply_requests).map_err(|e| e.to_string())?;
    Ok(json!({}))
}

fn bus_json(m: &Mixer, meters: &[f32]) -> Value {
    let list: Vec<Value> = m
        .buses()
        .iter()
        .enumerate()
        .map(|(i, b)| {
            json!({
                "name": b.name,
                "parent": b.parent.map(|p| m.buses()[p.0 as usize].name.clone()),
                "volume": b.volume,
                "mute": b.mute,
                "solo": b.solo,
                "effective_db": (lin_to_db(b.effective) * 10.0).round() / 10.0,
                "snapshot_db": (b.snapshot_db * 10.0).round() / 10.0,
                "duck_db": (b.duck_db * 10.0).round() / 10.0,
                "lowpass_hz": b.lowpass_hz.round(),
                "reverb_send": b.reverb_send,
                "peak_db": meters.get(i).map(|p| (lin_to_db(*p) * 10.0).round() / 10.0),
            })
        })
        .collect();
    Value::Array(list)
}

fn music_json(w: &World) -> Value {
    let m = w.resource::<Music>();
    let b = w.resource::<SoundBackend>();
    let pos = m.position(b.clock(), b.rate()).map(|p| json!({"bar": p.bar, "beat": p.beat, "phase": p.phase, "secs": p.secs, "intro": p.in_intro}));
    json!({
        "track": m.current(),
        "pending": m.pending(),
        "position": pos,
        "intensity": m.intensity(),
        "tracks": m.tracks().map(|t| t.name.clone()).collect::<Vec<_>>(),
    })
}

fn stats(w: &mut World, _: Value) -> Result<Value, String> {
    let s = w.resource::<SoundStats>();
    let mut out = serde_json::to_value(s).map_err(|e| e.to_string())?;
    let cues = w.resource::<SoundCues>();
    let mixer = w.resource::<Mixer>();
    let voices = w.resource::<Voices>();
    let list: Vec<Value> = voices
        .iter()
        .take(32)
        .map(|v| {
            json!({
                "id": v.id.0,
                "cue": v.cue.map(|c| cues.by_id(c).name.clone()),
                "bus": mixer.get(v.bus).map(|b| b.name.clone()),
                "state": v.state.as_str(),
                "priority": v.priority,
                "audible_db": (lin_to_db(v.audible) * 10.0).round() / 10.0,
                "distance": (v.distance * 100.0).round() / 100.0,
                "pan": (v.pan * 100.0).round() / 100.0,
                "occlusion": (v.occlusion * 100.0).round() / 100.0,
                "age": (v.age * 100.0).round() / 100.0,
                "looping": v.looping,
            })
        })
        .collect();
    let l = voices.listener();
    out["voices"] = Value::Array(list);
    out["buses"] = bus_json(mixer, &s.meters);
    out["snapshots"] = json!(mixer.active_snapshots().map(|(n, w)| json!({"name": n, "weight": w})).collect::<Vec<_>>());
    out["ducks"] = json!((0..mixer.ducks().len()).map(|i| json!({"trigger": mixer.ducks()[i].trigger, "level": mixer.duck_level(i)})).collect::<Vec<_>>());
    out["listener"] = json!({"pos": [l.pos.x, l.pos.y, l.pos.z], "forward": [l.forward.x, l.forward.y, l.forward.z]});
    out["music"] = music_json(w);
    Ok(out)
}

fn bus(w: &mut World, p: Value) -> Result<Value, String> {
    if let Some(name) = p.get("name").and_then(Value::as_str) {
        let id = w.resource::<Mixer>().bus(name).ok_or_else(|| format!("unknown bus `{name}`"))?;
        if let Some(v) = f32_of(&p, "volume") {
            let v = v.clamp(0.0, 1.0);
            // Core buses go through settings (persisted, settings screen in sync).
            match id {
                BusId::MASTER => w.resource_mut::<CoreSettings>().master_volume = v,
                BusId::MUSIC => w.resource_mut::<CoreSettings>().music_volume = v,
                BusId::SFX => w.resource_mut::<CoreSettings>().sfx_volume = v,
                BusId::AMBIENCE => w.resource_mut::<CoreSettings>().ambience_volume = v,
                BusId::UI => w.resource_mut::<CoreSettings>().ui_volume = v,
                BusId::VOICE => w.resource_mut::<SoundSettings>().voice_volume = v,
                _ => {}
            }
            w.resource_mut::<Mixer>().set_volume(id, v);
        }
        if let Some(m) = p.get("mute").and_then(Value::as_bool) {
            w.resource_mut::<Mixer>().set_mute(id, m);
        }
        if let Some(s) = p.get("solo").and_then(Value::as_bool) {
            w.resource_mut::<Mixer>().set_solo(id, s);
        }
        w.resource_mut::<Mixer>().update(0.0);
    }
    let meters = w.resource::<SoundStats>().meters.clone();
    Ok(json!({"buses": bus_json(w.resource::<Mixer>(), &meters)}))
}

fn snapshot(w: &mut World, p: Value) -> Result<Value, String> {
    let mut m = w.resource_mut::<Mixer>();
    if let Some(name) = p.get("name").and_then(Value::as_str) {
        if name == "none" {
            m.clear_snapshots();
        } else {
            let on = p.get("on").and_then(Value::as_bool).unwrap_or(true);
            if !m.set_snapshot(name, on) {
                return Err(format!("unknown snapshot `{name}`"));
            }
        }
    }
    Ok(json!({
        "active": m.active_snapshots().map(|(n, w)| json!({"name": n, "weight": w})).collect::<Vec<_>>(),
        "available": m.snapshots().map(|s| s.name.clone()).collect::<Vec<_>>(),
    }))
}

fn captions(w: &mut World, p: Value) -> Result<Value, String> {
    {
        let mut s = w.resource_mut::<SoundSettings>();
        if let Some(e) = p.get("enabled").and_then(Value::as_bool) {
            s.captions = e;
        }
        if let Some(sz) = p.get("size").and_then(Value::as_str) {
            s.caption_size = CaptionSize::parse(sz).ok_or("size: small | medium | large")?;
        }
        if let Some(d) = p.get("directions").and_then(Value::as_bool) {
            s.caption_directions = d;
        }
    }
    let s = w.resource::<SoundSettings>();
    let c = w.resource::<Captions>();
    let lines: Vec<Value> = c
        .lines
        .iter()
        .map(|l| json!({"speaker": l.speaker, "text": l.text, "shown": l.display(s.caption_directions), "remaining": l.remaining, "side": l.side()}))
        .collect();
    Ok(json!({"enabled": s.captions, "size": s.caption_size.as_str(), "directions": s.caption_directions, "lines": lines}))
}

fn music(w: &mut World, p: Value) -> Result<Value, String> {
    {
        let mut m = w.resource_mut::<Music>();
        if p.get("stop").and_then(Value::as_bool) == Some(true) {
            m.stop(f32_of(&p, "fade").unwrap_or(1.0));
        }
        if let Some(t) = p.get("track").and_then(Value::as_str) {
            let mut tr = MusicTransition::default();
            if let Some(q) = p.get("quantize").and_then(Value::as_str) {
                tr.quantize = Quantize::parse(q).ok_or("quantize: immediate | beat | bar")?;
            }
            if let Some(f) = f32_of(&p, "fade") {
                tr.fade_out = f;
                tr.fade_in = f.min(tr.fade_in);
            }
            if !m.play(t, tr) {
                return Err(format!("unknown track `{t}`"));
            }
        }
        if let Some(x) = f32_of(&p, "intensity") {
            m.set_intensity(x);
        }
    }
    Ok(music_json(w))
}

fn cues(w: &mut World, _: Value) -> Result<Value, String> {
    let c = w.resource::<SoundCues>();
    let list: Vec<Value> = c
        .iter()
        .map(|q| {
            json!({
                "name": q.name, "bus": q.bus, "clips": q.clips.len(), "pick": format!("{:?}", q.pick),
                "priority": q.priority, "max_instances": q.max_instances, "cooldown": q.cooldown,
                "looping": q.looping, "spatial": q.spatial.is_some(), "captions": q.captions.len(),
            })
        })
        .collect();
    Ok(json!({"cues": list}))
}
