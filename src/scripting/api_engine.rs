//! Engine subsystems as host functions: sound, vfx, animation, toasts, settings, l10n, time,
//! diagnostics and navigation. Godot-named where Godot has an equivalent. `[n,]` is the optional
//! leading node (`self` when omitted). Groups are gated on their cargo feature; a call into a
//! subsystem that is not installed in the app is an error naming what is missing.
//!
//! | Function | Does |
//! |---|---|
//! | `play_sound(cue [, [x,y,z]])` -> voice | play a cue (2D, or 3D at a position) |
//! | `play_sound_at([n,] cue)` -> voice | 3D cue following a node |
//! | `stop_sound(voice_or_cue [, fade])` | stop one voice (int) or every voice of a cue (str) |
//! | `play_music(name [, fade_in])`, `stop_music([fade])`, `set_music_intensity(x)` | music tracks |
//! | `set_bus_volume(bus, linear)`, `set_bus_volume_db(bus, db)`, `get_bus_volume(bus)`, `set_bus_mute(bus, bool)` | mixer buses |
//! | `spawn_vfx(preset, [x,y,z])` -> entity, `spawn_vfx_at([n,] preset)` | particle effects |
//! | `anim_set([n,] param, value)`, `anim_get([n,] param)`, `anim_trigger([n,] param)`, `anim_play([n,] state [, fade])`, `anim_state([n])` | animation state machine |
//! | `toast(text [, body])` | UI toast |
//! | `get_setting(key)`, `set_setting(key, value)` | registered settings rows (floats) |
//! | `tr(key)` | localized string (the key when unknown) |
//! | `set_time_scale(x)`, `get_time_scale()`, `get_fps()`, `quit()` | engine |
//! | `push_error(msg)`, `push_warning(msg)`, `assert(cond [, msg])` | diagnostics (the editor's Output panel) |
//! | `nav_goto([n,] [x,y,z])`, `nav_stop([n])`, `nav_is_done([n])`, `nav_status([n])`, `nav_target([n])` | navmesh agent |
//!
//! Built-in signals from a `NavAgent` node: `navigation_finished` (arrived),
//! `navigation_failed` (no path).

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{b, ent, f, live, me, rv3, s, v3, world};
use crate::logic::{LogicDiag, LogicDiagnostics, Severity};

/// `(target, rest)`: a leading int is the target node, else `self`.
fn lead<'a>(w: &World, a: &'a [RV]) -> Result<(Entity, &'a [RV]), String> {
    match a.first() {
        Some(RV::Int(_)) => Ok((live(w, ent(&a[0])?)?, &a[1..])),
        _ => Ok((me(w)?, a)),
    }
}

fn num(v: &RV, what: &str) -> Result<f64, String> {
    f(v, what).map(f64::from)
}

fn missing(what: &str) -> String {
    format!("{what} is not set up in this app")
}

/// File key of the running script, for diagnostics.
fn script_key(w: &World) -> String {
    me(w).ok().and_then(|e| w.get::<super::Script>(e)).map_or_else(|| "script".to_string(), |sc| super::key_of(&sc.path))
}

fn report(w: &mut World, severity: Severity, msg: String) {
    let file = script_key(w);
    match severity {
        Severity::Error => error!("[script] {file}: {msg}"),
        Severity::Warning => warn!("[script] {file}: {msg}"),
    }
    if let Some(mut d) = w.get_resource_mut::<LogicDiagnostics>() {
        d.report(LogicDiag { severity, file, line: 0, col: 0, node: None, message: msg, count: 1 });
    }
}

pub(super) fn register(e: &mut Engine) {
    #[cfg(feature = "sound")]
    sound(e);
    #[cfg(feature = "vfx")]
    vfx(e);
    #[cfg(feature = "anim")]
    anim(e);
    #[cfg(feature = "ai")]
    nav(e);
    ui_and_settings(e);
    engine(e);
    diagnostics(e);
}

// ---------------------------------------------------------------- sound

#[cfg(feature = "sound")]
fn sound(e: &mut Engine) {
    use crate::sound::{Mixer, Music, MusicTransition, SoundCtl};

    fn ctl(w: &mut World) -> Result<Mut<'_, SoundCtl>, String> {
        w.get_resource_mut::<SoundCtl>().ok_or_else(|| missing("sound"))
    }
    e.register("play_sound", |c, a| {
        let w = world(c)?;
        let cue = s(a.first().ok_or("usage: play_sound(cue [, position])")?, "cue")?.to_string();
        let at = a.get(1).map(|p| v3(p, "position")).transpose()?;
        let owned = super::scene_owned(w, None);
        let mut ctl = ctl(w)?;
        let id = match at {
            Some(p) => ctl.play_at(cue, p),
            None => ctl.play(cue),
        };
        if owned {
            w.resource_mut::<super::ScriptQueue>().scene_voices.push(id.0);
        }
        Ok(RV::Int(id.0 as i64))
    });
    e.register("play_sound_at", |c, a| {
        let w = world(c)?;
        let (t, r) = lead(w, a)?;
        let cue = s(r.first().ok_or("usage: play_sound_at([node,] cue)")?, "cue")?.to_string();
        Ok(RV::Int(ctl(w)?.play_on(cue, t).0 as i64))
    });
    e.register("stop_sound", |c, a| {
        let w = world(c)?;
        let fade = a.get(1).map_or(Ok(0.0), |v| f(v, "fade"))?;
        let mut ctl = ctl(w)?;
        match a.first().ok_or("usage: stop_sound(voice_or_cue [, fade])")? {
            RV::Int(i) => ctl.stop(crate::sound::VoiceId(*i as u32), fade),
            RV::Str(cue) => ctl.stop_cue(cue.clone(), fade),
            other => return Err(format!("stop_sound takes a voice (int) or cue (str), got {}", other.type_name())),
        }
        Ok(RV::Void)
    });
    e.register("play_music", |c, a| {
        let w = world(c)?;
        let name = s(a.first().ok_or("usage: play_music(name [, fade_in])")?, "name")?.to_string();
        let mut tr = MusicTransition::default();
        if let Some(v) = a.get(1) {
            tr.fade_in = f(v, "fade_in")?.max(0.0);
        }
        let mut m = w.get_resource_mut::<Music>().ok_or_else(|| missing("music"))?;
        if !m.play(&name, tr) {
            return Err(format!("unknown music track `{name}`"));
        }
        Ok(RV::Void)
    });
    e.register("stop_music", |c, a| {
        let w = world(c)?;
        let fade = a.first().map_or(Ok(1.0), |v| f(v, "fade"))?;
        w.get_resource_mut::<Music>().ok_or_else(|| missing("music"))?.stop(fade);
        Ok(RV::Void)
    });
    e.register("set_music_intensity", |c, a| {
        let w = world(c)?;
        let x = f(a.first().ok_or("usage: set_music_intensity(x)")?, "intensity")?;
        w.get_resource_mut::<Music>().ok_or_else(|| missing("music"))?.set_intensity(x);
        Ok(RV::Void)
    });

    fn bus_arg<'a>(a: &'a [RV], usage: &str) -> Result<&'a str, String> {
        s(a.first().ok_or_else(|| format!("usage: {usage}"))?, "bus")
    }
    fn with_bus<T>(w: &mut World, name: &str, f: impl FnOnce(&mut Mixer, crate::sound::BusId) -> T) -> Result<T, String> {
        let mut m = w.get_resource_mut::<Mixer>().ok_or_else(|| missing("the mixer"))?;
        let id = m.bus(name).ok_or_else(|| format!("unknown bus `{name}`"))?;
        Ok(f(&mut m, id))
    }
    e.register("set_bus_volume", |c, a| {
        let w = world(c)?;
        let bus = bus_arg(a, "set_bus_volume(bus, linear)")?.to_string();
        let v = f(a.get(1).ok_or("usage: set_bus_volume(bus, linear)")?, "volume")?;
        with_bus(w, &bus, |m, id| m.set_volume(id, v))?;
        Ok(RV::Void)
    });
    e.register("set_bus_volume_db", |c, a| {
        let w = world(c)?;
        let bus = bus_arg(a, "set_bus_volume_db(bus, db)")?.to_string();
        let db = f(a.get(1).ok_or("usage: set_bus_volume_db(bus, db)")?, "db")?;
        with_bus(w, &bus, |m, id| m.set_volume(id, crate::sound::db_to_lin(db)))?;
        Ok(RV::Void)
    });
    e.register("get_bus_volume", |c, a| {
        let w = world(c)?;
        let bus = bus_arg(a, "get_bus_volume(bus)")?.to_string();
        let v = with_bus(w, &bus, |m, id| m.get(id).map_or(0.0, |b| b.volume))?;
        Ok(RV::Float(v as f64))
    });
    e.register("set_bus_mute", |c, a| {
        let w = world(c)?;
        let bus = bus_arg(a, "set_bus_mute(bus, bool)")?.to_string();
        let on = b(a.get(1).ok_or("usage: set_bus_mute(bus, bool)")?, "mute")?;
        with_bus(w, &bus, |m, id| m.set_mute(id, on))?;
        Ok(RV::Void)
    });
}

// ---------------------------------------------------------------- vfx

#[cfg(feature = "vfx")]
fn vfx(e: &mut Engine) {
    fn spawn(w: &mut World, preset: &str, at: Transform) -> Result<RV, String> {
        let lib = w.get_resource::<crate::vfx::VfxLibrary>().ok_or_else(|| missing("vfx"))?;
        if !lib.contains(preset) {
            return Err(format!("unknown vfx preset `{preset}`"));
        }
        let id = crate::vfx::play_world(w, preset, at, None);
        if let Some(e) = id
            && super::scene_owned(w, None)
        {
            w.entity_mut(e).insert(super::SceneOwned);
        }
        Ok(super::api::ropt(id))
    }
    e.register("spawn_vfx", |c, a| {
        let w = world(c)?;
        let preset = s(a.first().ok_or("usage: spawn_vfx(preset, position)")?, "preset")?.to_string();
        let p = v3(a.get(1).ok_or("usage: spawn_vfx(preset, position)")?, "position")?;
        spawn(w, &preset, Transform::from_translation(p))
    });
    e.register("spawn_vfx_at", |c, a| {
        let w = world(c)?;
        let (t, r) = lead(w, a)?;
        let preset = s(r.first().ok_or("usage: spawn_vfx_at([node,] preset)")?, "preset")?.to_string();
        let at = w.get::<GlobalTransform>(t).ok_or_else(|| format!("entity {t} has no GlobalTransform"))?.compute_transform();
        spawn(w, &preset, Transform { scale: Vec3::ONE, ..at })
    });
}

// ---------------------------------------------------------------- animation

#[cfg(feature = "anim")]
fn anim(e: &mut Engine) {
    use crate::anim::{Animator, ParamValue};

    fn animator(w: &mut World, t: Entity) -> Result<Mut<'_, Animator>, String> {
        w.get_mut::<Animator>(t).ok_or_else(|| format!("entity {t} has no Animator"))
    }
    e.register("anim_set", |c, a| {
        let w = world(c)?;
        let (t, r) = lead(w, a)?;
        if r.len() != 2 {
            return Err("usage: anim_set([node,] param, value)".into());
        }
        let name = s(&r[0], "param")?.to_string();
        let v = match &r[1] {
            RV::Bool(x) => ParamValue::Bool(*x),
            other => ParamValue::Float(f(other, "value")?),
        };
        let mut an = animator(w, t)?;
        if !an.set(&name, v) {
            let known: Vec<String> = an.params().map(|(n, _)| n.to_string()).collect();
            return Err(format!("unknown animation parameter `{name}` (known: {})", known.join(", ")));
        }
        Ok(RV::Void)
    });
    e.register("anim_trigger", |c, a| {
        let w = world(c)?;
        let (t, r) = lead(w, a)?;
        let name = s(r.first().ok_or("usage: anim_trigger([node,] param)")?, "param")?.to_string();
        if !animator(w, t)?.trigger(&name) {
            return Err(format!("unknown animation parameter `{name}`"));
        }
        Ok(RV::Void)
    });
    e.register("anim_get", |c, a| {
        let w = world(c)?;
        let (t, r) = lead(w, a)?;
        let name = s(r.first().ok_or("usage: anim_get([node,] param)")?, "param")?.to_string();
        let an = animator(w, t)?;
        match an.param(&name) {
            Some(ParamValue::Float(x)) => Ok(RV::Float(x as f64)),
            Some(ParamValue::Bool(x) | ParamValue::Trigger(x)) => Ok(RV::Bool(x)),
            None => Err(format!("unknown animation parameter `{name}`")),
        }
    });
    e.register("anim_play", |c, a| {
        let w = world(c)?;
        let (t, r) = lead(w, a)?;
        let state = s(r.first().ok_or("usage: anim_play([node,] state [, fade])")?, "state")?.to_string();
        let fade = r.get(1).map_or(Ok(0.2), |v| f(v, "fade"))?;
        if !animator(w, t)?.play(0, &state, fade) {
            return Err(format!("no animation state `{state}`"));
        }
        Ok(RV::Void)
    });
    e.register("anim_state", |c, a| {
        let w = world(c)?;
        let (t, _) = lead(w, a)?;
        Ok(RV::Str(animator(w, t)?.current_state(0).into()))
    });
}

// ---------------------------------------------------------------- toast, settings, l10n

fn ui_and_settings(e: &mut Engine) {
    e.register("toast", |c, a| {
        let w = world(c)?;
        let title = a.first().ok_or("usage: toast(text [, body])")?.to_string();
        let mut t = crate::ui::toast::Toast::new(title);
        if let Some(body) = a.get(1) {
            t = t.body(body.to_string());
        }
        if !w.contains_resource::<Messages<crate::ui::toast::Toast>>() {
            return Err(missing("the UI toast"));
        }
        w.write_message(t);
        Ok(RV::Void)
    });
    e.register("get_setting", |c, a| {
        let w = world(c)?;
        let key = s(a.first().ok_or("usage: get_setting(key)")?, "key")?;
        let field = w.get_resource::<crate::settings::SettingsRegistry>().and_then(|r| r.field(key)).cloned().ok_or_else(|| format!("unknown setting `{key}`"))?;
        Ok(RV::Float((field.get)(w) as f64))
    });
    e.register("set_setting", |c, a| {
        let w = world(c)?;
        let key = s(a.first().ok_or("usage: set_setting(key, value)")?, "key")?;
        let v = match a.get(1).ok_or("usage: set_setting(key, value)")? {
            RV::Bool(x) => *x as u8 as f32,
            other => f(other, "value")?,
        };
        let field = w.get_resource::<crate::settings::SettingsRegistry>().and_then(|r| r.field(key)).cloned().ok_or_else(|| format!("unknown setting `{key}`"))?;
        (field.set)(w, v);
        if w.contains_resource::<Messages<crate::settings::SaveSettings>>() {
            w.write_message(crate::settings::SaveSettings);
        }
        Ok(RV::Float((field.get)(w) as f64))
    });
    e.register("tr", |_, a| {
        let key = s(a.first().ok_or("usage: tr(key)")?, "key")?;
        #[cfg(feature = "l10n")]
        return Ok(RV::Str(crate::l10n::tr(key)));
        #[cfg(not(feature = "l10n"))]
        Ok(RV::Str(key.into()))
    });
}

// ---------------------------------------------------------------- engine

fn engine(e: &mut Engine) {
    e.register("set_time_scale", |c, a| {
        let w = world(c)?;
        let x = num(a.first().ok_or("usage: set_time_scale(x)")?, "scale")?;
        if !(0.0..=8.0).contains(&x) {
            return Err("time scale must be in 0..8".into());
        }
        w.resource_mut::<Time<Virtual>>().set_relative_speed_f64(x);
        Ok(RV::Void)
    });
    e.register("get_time_scale", |c, _| Ok(RV::Float(world(c)?.resource::<Time<Virtual>>().relative_speed_f64())));
    e.register("get_fps", |c, _| {
        let dt = world(c)?.resource::<Time<Real>>().delta_secs_f64();
        Ok(RV::Float(if dt > 0.0 { 1.0 / dt } else { 0.0 }))
    });
    e.register("quit", |c, _| {
        let w = world(c)?;
        if w.contains_resource::<Messages<AppExit>>() {
            w.write_message(AppExit::Success);
        }
        Ok(RV::Void)
    });
}

// ---------------------------------------------------------------- diagnostics

fn diagnostics(e: &mut Engine) {
    e.register("push_error", |c, a| {
        let w = world(c)?;
        report(w, Severity::Error, a.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" "));
        Ok(RV::Void)
    });
    e.register("push_warning", |c, a| {
        let w = world(c)?;
        report(w, Severity::Warning, a.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" "));
        Ok(RV::Void)
    });
    e.register("assert", |_, a| {
        let ok = match a.first().ok_or("usage: assert(cond [, msg])")? {
            RV::Bool(x) => *x,
            RV::Null | RV::Void => false,
            RV::Int(i) => *i != 0,
            RV::Float(x) => *x != 0.0,
            _ => true,
        };
        if ok {
            return Ok(RV::Void);
        }
        Err(match a.get(1) {
            Some(m) => format!("assertion failed: {m}"),
            None => "assertion failed".into(),
        })
    });
}

// ---------------------------------------------------------------- navigation

#[cfg(feature = "ai")]
fn nav(e: &mut Engine) {
    use crate::ai::{NavAgentState, NavStatus};

    fn agent(w: &mut World, t: Entity) -> Result<Mut<'_, NavAgentState>, String> {
        w.get_mut::<NavAgentState>(t).ok_or_else(|| format!("entity {t} has no NavAgent"))
    }
    e.register("nav_goto", |c, a| {
        let w = world(c)?;
        let (t, r) = lead(w, a)?;
        let p = v3(r.first().ok_or("usage: nav_goto([node,] position)")?, "target")?;
        agent(w, t)?.set_target(p);
        Ok(RV::Void)
    });
    e.register("nav_stop", |c, a| {
        let w = world(c)?;
        let (t, _) = lead(w, a)?;
        agent(w, t)?.stop();
        Ok(RV::Void)
    });
    e.register("nav_is_done", |c, a| {
        let w = world(c)?;
        let (t, _) = lead(w, a)?;
        let st = agent(w, t)?;
        Ok(RV::Bool(st.target.is_none() || (matches!(st.status, NavStatus::Arrived | NavStatus::Failed) && !st.needs_path)))
    });
    e.register("nav_status", |c, a| {
        let w = world(c)?;
        let (t, _) = lead(w, a)?;
        let name = match agent(w, t)?.status {
            NavStatus::Idle => "idle",
            NavStatus::Pending => "pending",
            NavStatus::Moving => "moving",
            NavStatus::TraversingLink => "link",
            NavStatus::Arrived => "arrived",
            NavStatus::Failed => "failed",
        };
        Ok(RV::Str(name.into()))
    });
    e.register("nav_target", |c, a| {
        let w = world(c)?;
        let (t, _) = lead(w, a)?;
        Ok(agent(w, t)?.target.map_or(RV::Null, rv3))
    });
}

/// Emits `navigation_finished` / `navigation_failed` when a `NavAgent` node's status changes to
/// `Arrived` / `Failed`.
#[cfg(feature = "ai")]
pub(super) fn nav_signals(world: &mut World, mut last: Local<bevy::platform::collections::HashMap<Entity, crate::ai::NavStatus>>) {
    use crate::ai::{NavAgentState, NavStatus};
    let mut out: Vec<(Entity, &'static str)> = vec![];
    let mut q = world.query::<(Entity, &NavAgentState)>();
    let mut seen = vec![];
    for (e, st) in q.iter(world) {
        seen.push(e);
        let prev = last.insert(e, st.status);
        if prev != Some(st.status) {
            match st.status {
                NavStatus::Arrived => out.push((e, "navigation_finished")),
                NavStatus::Failed => out.push((e, "navigation_failed")),
                _ => {}
            }
        }
    }
    last.retain(|e, _| seen.contains(e));
    for (e, sig) in out {
        super::emit_signal(world, e, sig, &[]);
    }
}
