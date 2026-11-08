//! Control commands: `photo.state`, `photo.set`, `photo.subjects`, `photo.shoot`.

use bevy::prelude::*;
use serde_json::{Value as Json, json};

use super::*;
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    app.add_control_command("photo.state", "Photo cameras (lens settings, derived DoF/EV), capture status, last photo metadata", params(&[]), state)
        .add_control_command(
            "photo.set",
            "Change the first PhotoCamera's settings",
            params(&[
                ("focal_mm", "number", "focal length"),
                ("aperture", "number", "f-stops"),
                ("shutter_s", "number", "shutter time in seconds (0.004 = 1/250)"),
                ("iso", "number", "ISO"),
                ("focus_m", "number", "focus distance (turns autofocus off)"),
                ("autofocus", "boolean", "autofocus on/off"),
            ]),
            set,
        )
        .add_control_command("photo.subjects", "Photographables the first PhotoCamera sees now (no capture)", params(&[]), subjects_cmd)
        .add_control_command(
            "photo.shoot",
            "Take a photo (needs a renderer); poll photo.state for `last`",
            params(&[("width", "number", "photo width"), ("height", "number", "photo height"), ("save", "boolean", "save through the sink (default true)")]),
            shoot,
        );
}

fn first_cam(world: &mut World) -> Result<Entity, String> {
    world.query_filtered::<Entity, With<PhotoCamera>>().iter(world).next().ok_or_else(|| "no PhotoCamera".to_string())
}

fn state(world: &mut World, _: Json) -> Result<Json, String> {
    let mut q = world.query::<(Entity, &PhotoCamera, &LensState)>();
    let cams: Vec<Json> = q
        .iter(world)
        .map(|(e, c, l)| {
            json!({
                "entity": e.to_bits(), "focal_mm": c.focal_mm, "aperture": c.aperture, "shutter_s": c.shutter_s, "iso": c.iso,
                "focus_m": c.focus_m, "autofocus": c.autofocus, "fov_deg": l.fov_y.to_degrees(), "ev100": l.ev100,
                "hyperfocal_m": l.hyperfocal_m, "dof_near_m": l.near_m, "dof_far_m": l.far_m.is_finite().then_some(l.far_m),
                "blur_angle": l.blur_angle,
            })
        })
        .collect();
    let cap = world.resource::<PhotoCapture>();
    Ok(json!({
        "cameras": cams,
        "busy": cap.busy(),
        "taken": cap.taken,
        "last": cap.last.as_ref().map(|(m, p)| json!({"metadata": m, "path": p.as_ref().map(|p| p.display().to_string())})),
        "resolution": world.resource::<PhotoConfig>().resolution.to_array(),
    }))
}

fn set(world: &mut World, p: Json) -> Result<Json, String> {
    let cam = first_cam(world)?;
    let mut c = world.get_mut::<PhotoCamera>(cam).unwrap();
    let num = |k: &str| p.get(k).and_then(Json::as_f64).map(|v| v as f32);
    if let Some(v) = num("focal_mm") {
        c.focal_mm = v.clamp(c.focal_range.0, c.focal_range.1);
    }
    if let Some(v) = num("aperture") {
        c.aperture = v.clamp(c.aperture_range.0, c.aperture_range.1);
    }
    if let Some(v) = num("shutter_s") {
        c.shutter_s = v.max(1e-5);
    }
    if let Some(v) = num("iso") {
        c.iso = v.max(1.0);
    }
    if let Some(v) = num("focus_m") {
        c.focus_m = v.max(0.05);
        c.autofocus = false;
    }
    if let Some(v) = p.get("autofocus").and_then(Json::as_bool) {
        c.autofocus = v;
    }
    Ok(json!({"focal_mm": c.focal_mm, "aperture": c.aperture, "shutter_s": c.shutter_s, "iso": c.iso, "focus_m": c.focus_m, "autofocus": c.autofocus}))
}

fn subjects_cmd(world: &mut World, _: Json) -> Result<Json, String> {
    let cam = first_cam(world)?;
    let res = world.resource::<PhotoConfig>().resolution;
    let id = world.resource::<PhotoCapture>().next_id + 1;
    let m = build_metadata(world, cam, id, res).ok_or("camera has no transform")?;
    Ok(json!({"subjects": m.subjects, "extra": m.extra}))
}

fn shoot(world: &mut World, p: Json) -> Result<Json, String> {
    if !can_render(world) {
        return Err("needs a renderer (not --headless)".into());
    }
    let res = match (p.get("width").and_then(Json::as_u64), p.get("height").and_then(Json::as_u64)) {
        (Some(w), Some(h)) => Some(UVec2::new(w as u32, h as u32)),
        _ => None,
    };
    let skip_save = p.get("save").and_then(Json::as_bool) == Some(false);
    world.write_message(PhotoRequest { camera: None, resolution: res, skip_save });
    Ok(json!({"queued": true}))
}
