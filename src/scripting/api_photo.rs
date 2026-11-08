//! Photo-camera host functions (feature `photo`). `[cam,]` is an optional leading camera node;
//! without it the first [`PhotoCamera`] is used.
//!
//! | Function | Does |
//! |---|---|
//! | `photo_set_lens([cam,] focal_mm, aperture, shutter_s, iso)` | lens settings, clamped to the camera's ranges |
//! | `photo_get_lens([cam])` | dict: `focal_mm aperture shutter_s iso focus_m autofocus fov_deg ev100 dof_near_m dof_far_m` |
//! | `photo_set_focus([cam,] metres)` | manual focus distance (turns autofocus off) |
//! | `photo_get_focus([cam])` | focus distance in metres |
//! | `photo_set_autofocus([cam,] bool)` | autofocus on / off |
//! | `photo_take([cam])` | request a photo; `false` if one is already being captured |
//! | `photo_last()` | metadata of the last photo as a dict (`id position lens subjects path ...`), or null |
//!
//! Signals, emitted from the camera node: `photo_taken(id, path)` and `photo_failed(reason)`.

use bevy::ecs::message::MessageCursor;
use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{b, ent, f, live, world};
use super::{ScriptSet, emit_signal};
use crate::logic::script::rv_of_json;
use crate::photo::{LensState, PhotoCamera, PhotoCapture, PhotoFailed, PhotoRequest, PhotoTaken};
use logic_core::Value;

/// `(camera, rest)`: `rest` has `n` args; one more in front is the camera node.
fn cam<'a>(w: &mut World, a: &'a [RV], n: usize, usage: &str) -> Result<(Entity, &'a [RV]), String> {
    if a.len() == n + 1 {
        return Ok((live(w, ent(&a[0])?)?, &a[1..]));
    }
    if a.len() != n {
        return Err(format!("usage: {usage}"));
    }
    first_camera(w).map(|e| (e, a))
}

fn first_camera(w: &mut World) -> Result<Entity, String> {
    w.query_filtered::<Entity, With<PhotoCamera>>().iter(w).next().ok_or_else(|| "no PhotoCamera in the world".to_string())
}

fn camera<'w>(w: &'w mut World, e: Entity) -> Result<Mut<'w, PhotoCamera>, String> {
    w.get_mut::<PhotoCamera>(e).ok_or_else(|| format!("entity {e} is not a PhotoCamera"))
}

fn dict(j: serde_json::Value) -> RV {
    rv_of_json(&j)
}

pub(super) fn register(e: &mut Engine) {
    e.register("photo_set_lens", |c, a| {
        let w = world(c)?;
        let (t, r) = cam(w, a, 4, "photo_set_lens([cam,] focal_mm, aperture, shutter_s, iso)")?;
        let (fl, ap, sh, iso) = (f(&r[0], "focal_mm")?, f(&r[1], "aperture")?, f(&r[2], "shutter_s")?, f(&r[3], "iso")?);
        if fl <= 0.0 || ap <= 0.0 || sh <= 0.0 || iso <= 0.0 {
            return Err("lens values must be positive".into());
        }
        let mut cm = camera(w, t)?;
        cm.focal_mm = fl.clamp(cm.focal_range.0, cm.focal_range.1);
        cm.aperture = ap.clamp(cm.aperture_range.0, cm.aperture_range.1);
        cm.shutter_s = sh;
        cm.iso = iso;
        Ok(RV::Void)
    });
    e.register("photo_get_lens", |c, a| {
        let w = world(c)?;
        let (t, _) = cam(w, a, 0, "photo_get_lens([cam])")?;
        let cm = camera(w, t)?.clone();
        let st = w.get::<LensState>(t).copied().unwrap_or_default();
        let far = if st.far_m.is_finite() { serde_json::json!(st.far_m) } else { serde_json::Value::Null };
        Ok(dict(serde_json::json!({
            "focal_mm": cm.focal_mm, "aperture": cm.aperture, "shutter_s": cm.shutter_s, "iso": cm.iso,
            "focus_m": cm.focus_m, "autofocus": cm.autofocus, "fov_deg": cm.fov_y().to_degrees(),
            "ev100": st.ev100, "dof_near_m": st.near_m, "dof_far_m": far,
        })))
    });
    e.register("photo_set_focus", |c, a| {
        let w = world(c)?;
        let (t, r) = cam(w, a, 1, "photo_set_focus([cam,] metres)")?;
        let m = f(&r[0], "metres")?;
        let mut cm = camera(w, t)?;
        cm.focus_m = m.max(0.1);
        cm.autofocus = false;
        Ok(RV::Void)
    });
    e.register("photo_get_focus", |c, a| {
        let w = world(c)?;
        let (t, _) = cam(w, a, 0, "photo_get_focus([cam])")?;
        Ok(RV::Float(camera(w, t)?.focus_m as f64))
    });
    e.register("photo_set_autofocus", |c, a| {
        let w = world(c)?;
        let (t, r) = cam(w, a, 1, "photo_set_autofocus([cam,] bool)")?;
        camera(w, t)?.autofocus = b(&r[0], "on")?;
        Ok(RV::Void)
    });
    e.register("photo_take", |c, a| {
        let w = world(c)?;
        let (t, _) = cam(w, a, 0, "photo_take([cam])")?;
        if w.get_resource::<PhotoCapture>().ok_or("the photo module is not set up in this app")?.busy() {
            return Ok(RV::Bool(false));
        }
        w.write_message(PhotoRequest { camera: Some(t), ..default() });
        Ok(RV::Bool(true))
    });
    e.register("photo_last", |c, a| {
        let w = world(c)?;
        if !a.is_empty() {
            return Err("usage: photo_last()".into());
        }
        let Some((meta, path)) = w.get_resource::<PhotoCapture>().and_then(|p| p.last.clone()) else { return Ok(RV::Null) };
        let mut j = serde_json::to_value(&meta).map_err(|e| e.to_string())?;
        j["path"] = path.map_or(serde_json::Value::Null, |p| p.to_string_lossy().into_owned().into());
        Ok(dict(j))
    });
}

#[derive(Default)]
struct Cursors {
    taken: MessageCursor<PhotoTaken>,
    failed: MessageCursor<PhotoFailed>,
}

/// Turns `PhotoTaken` / `PhotoFailed` messages into script signals on the camera node.
fn photo_signals(world: &mut World, mut cur: Local<Cursors>) {
    let mut out: Vec<(&'static str, Vec<Value>)> = vec![];
    if let Some(m) = world.get_resource::<Messages<PhotoTaken>>() {
        for t in cur.taken.read(m) {
            let path = t.path.as_ref().map_or(String::new(), |p| p.to_string_lossy().into_owned());
            out.push(("photo_taken", vec![Value::Num(t.metadata.id as f64), Value::text(&path)]));
        }
    }
    if let Some(m) = world.get_resource::<Messages<PhotoFailed>>() {
        for fl in cur.failed.read(m) {
            out.push(("photo_failed", vec![Value::text(&fl.reason)]));
        }
    }
    if out.is_empty() {
        return;
    }
    let Ok(src) = first_camera(world) else { return };
    for (sig, args) in out {
        emit_signal(world, src, sig, &args);
    }
}

pub(super) fn plugin(app: &mut App) {
    app.add_systems(Update, photo_signals.after(super::timers).in_set(ScriptSet::Events));
}
