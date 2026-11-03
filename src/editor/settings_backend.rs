//! World and project settings for the editor's World Settings tab and Project Settings window:
//! a curated set of fields of the `Look` and `WorldSettings` resources, as groups with a schema.
//! Edits go through the same paths as the `look.set` / `world.settings` control commands.
//!
//! Fields that toggle a rendering feature (bloom, shadows, volumetric fog ...) are left out on
//! purpose: toggling them rebuilds every pipeline (see docs/GAME_GUIDE.md).

use bevy::prelude::*;
use editor_proto::{SettingsGroup, SettingsPage, TypeSchema};
use serde_json::{Value, json};

use crate::world::{StreamMode, WorldSettings};

fn float(min: f64, max: f64, step: f64) -> TypeSchema {
    TypeSchema::Float { min: Some(min), max: Some(max), step: Some(step) }
}

fn choice(names: &[&str]) -> TypeSchema {
    TypeSchema::Enum { variants: names.iter().map(|n| ((*n).to_owned(), None)).collect() }
}

fn structure(fields: Vec<(&str, TypeSchema)>) -> TypeSchema {
    TypeSchema::Struct { fields: fields.into_iter().map(|(n, s)| (n.to_owned(), s)).collect() }
}

fn group(id: &str, label: &str, page: SettingsPage, hint: &str, schema: TypeSchema, value: Value) -> SettingsGroup {
    SettingsGroup { id: id.into(), label: label.into(), page, hint: hint.into(), schema, value }
}

/// Every settings group the editor shows.
pub fn groups(world: &World) -> Vec<SettingsGroup> {
    let mut out = Vec::new();
    #[cfg(feature = "look")]
    if let Some(look) = world.get_resource::<crate::look::Look>() {
        out.push(look_group(look));
    }
    let Some(s) = world.get_resource::<WorldSettings>() else { return out };
    out.push(group(
        "terrain",
        "Terrain",
        SettingsPage::World,
        "Terrain detail. Lower pixel error means more triangles.",
        structure(vec![("pixel_error", float(0.05, 16.0, 0.05)), ("lod_distance", float(0.0, 4000.0, 1.0)), ("max_lod", TypeSchema::Int { min: Some(0), max: Some(8) })]),
        json!({"pixel_error": s.terrain.pixel_error, "lod_distance": s.terrain.lod_distance, "max_lod": s.terrain.max_lod}),
    ));
    out.push(group(
        "streaming",
        "Streaming",
        SettingsPage::World,
        "Resident keeps every cell loaded; Streamed loads cells near the camera.",
        structure(vec![("mode", choice(&["Resident", "Streamed"])), ("load_radius", float(0.0, 5000.0, 1.0)), ("unload_radius", float(0.0, 6000.0, 1.0))]),
        json!({"mode": format!("{:?}", s.streaming.mode), "load_radius": s.streaming.load_radius, "unload_radius": s.streaming.unload_radius}),
    ));
    out.push(group(
        "scatter",
        "Foliage and scatter",
        SettingsPage::Project,
        "Distance scale multiplies every scatter rule's distances.",
        structure(vec![("enabled", TypeSchema::Bool), ("distance_scale", float(0.0, 8.0, 0.05)), ("follow_quality", TypeSchema::Bool), ("max_items_per_frame", TypeSchema::Int { min: Some(1), max: Some(20000) })]),
        json!({"enabled": s.scatter.enabled, "distance_scale": s.scatter.distance_scale, "follow_quality": s.scatter.follow_quality, "max_items_per_frame": s.scatter.max_items_per_frame}),
    ));
    out.push(group(
        "hlod",
        "Distant detail (HLOD)",
        SettingsPage::Project,
        "Beyond `distance` a cell draws one merged proxy instead of its props.",
        structure(vec![("enabled", TypeSchema::Bool), ("distance", float(0.0, 4000.0, 1.0)), ("view", float(0.0, 20000.0, 10.0))]),
        json!({"enabled": s.hlod.enabled, "distance": s.hlod.distance, "view": s.hlod.view}),
    ));
    out.push(group(
        "origin",
        "Floating origin",
        SettingsPage::Project,
        "Keeps coordinates small on very large maps.",
        structure(vec![("enabled", TypeSchema::Bool), ("threshold", float(64.0, 20000.0, 16.0)), ("snap", float(1.0, 4096.0, 1.0))]),
        json!({"enabled": s.origin.enabled, "threshold": s.origin.threshold, "snap": s.origin.snap}),
    ));
    out
}

#[cfg(feature = "look")]
fn look_group(look: &crate::look::Look) -> SettingsGroup {
    let v = serde_json::to_value(look).unwrap_or(Value::Null);
    let pick = |path: &[&str]| path.iter().try_fold(&v, |cur, k| cur.get(*k)).cloned().unwrap_or(Value::Null);
    group(
        "look",
        "Look (sun, sky, fog, exposure)",
        SettingsPage::World,
        "How the scene is lit. Changes apply at once.",
        structure(vec![
            ("sun", structure(vec![("enabled", TypeSchema::Bool), ("azimuth_deg", float(0.0, 360.0, 1.0)), ("elevation_deg", float(-20.0, 90.0, 0.5)), ("illuminance", float(0.0, 150_000.0, 500.0))])),
            ("sky", structure(vec![("mode", choice(&["atmosphere", "gradient", "color", "cubemap"])), ("brightness", float(0.0, 20_000.0, 50.0))])),
            ("ambient", structure(vec![("brightness", float(0.0, 5000.0, 5.0)), ("env_intensity", float(0.0, 4.0, 0.05))])),
            ("fog", structure(vec![("mode", choice(&["off", "linear", "exponential", "exponential_squared", "atmospheric"])), ("visibility", float(1.0, 20_000.0, 10.0))])),
            ("exposure", structure(vec![("ev100", float(-4.0, 20.0, 0.1)), ("auto", TypeSchema::Bool), ("compensation", float(-4.0, 4.0, 0.1))])),
        ]),
        json!({
            "sun": {"enabled": pick(&["sun", "enabled"]), "azimuth_deg": pick(&["sun", "azimuth_deg"]), "elevation_deg": pick(&["sun", "elevation_deg"]), "illuminance": pick(&["sun", "illuminance"])},
            "sky": {"mode": pick(&["sky", "mode"]), "brightness": pick(&["sky", "brightness"])},
            "ambient": {"brightness": pick(&["ambient", "brightness"]), "env_intensity": pick(&["ambient", "env_intensity"])},
            "fog": {"mode": pick(&["fog", "mode"]), "visibility": pick(&["fog", "visibility"])},
            "exposure": {"ev100": pick(&["exposure", "ev100"]), "auto": pick(&["exposure", "auto"]), "compensation": pick(&["exposure", "compensation"])},
        }),
    )
}

fn f(v: &Value, k: &str) -> Option<f32> {
    v.get(k).and_then(Value::as_f64).map(|x| x as f32)
}

fn b(v: &Value, k: &str) -> Option<bool> {
    v.get(k).and_then(Value::as_bool)
}

/// Applies one group's (partial) value.
pub fn set(world: &mut World, group: &str, value: &Value) -> Result<(), String> {
    match group {
        #[cfg(feature = "look")]
        "look" => {
            use crate::look::{Look, LookTimeline, LookTransition};
            let current = world.get_resource::<Look>().cloned().ok_or("no Look resource")?;
            let target = current.patched(value)?;
            if target != current {
                world.remove_resource::<LookTimeline>();
                world.remove_resource::<LookTransition>();
                world.insert_resource(target);
            }
            Ok(())
        }
        "terrain" | "streaming" | "scatter" | "hlod" | "origin" => {
            let mut s = world.get_resource_mut::<WorldSettings>().ok_or("no world settings")?;
            match group {
                "terrain" => {
                    if let Some(x) = f(value, "pixel_error") {
                        s.terrain.pixel_error = x.max(0.05);
                    }
                    if let Some(x) = f(value, "lod_distance") {
                        s.terrain.lod_distance = x.max(0.0);
                    }
                    if let Some(x) = value.get("max_lod").and_then(Value::as_u64) {
                        s.terrain.max_lod = x.min(8) as u8;
                    }
                }
                "streaming" => {
                    match value.get("mode").and_then(Value::as_str) {
                        Some("Resident") => s.streaming.mode = StreamMode::Resident,
                        Some("Streamed") => s.streaming.mode = StreamMode::Streamed,
                        Some(other) => return Err(format!("unknown streaming mode `{other}`")),
                        None => {}
                    }
                    if let Some(x) = f(value, "load_radius") {
                        s.streaming.load_radius = x.max(0.0);
                    }
                    if let Some(x) = f(value, "unload_radius") {
                        s.streaming.unload_radius = x.max(0.0);
                    }
                    s.streaming.unload_radius = s.streaming.unload_radius.max(s.streaming.load_radius);
                }
                "scatter" => {
                    if let Some(x) = b(value, "enabled") {
                        s.scatter.enabled = x;
                    }
                    if let Some(x) = f(value, "distance_scale") {
                        s.scatter.distance_scale = x.max(0.0);
                    }
                    if let Some(x) = b(value, "follow_quality") {
                        s.scatter.follow_quality = x;
                    }
                    if let Some(x) = value.get("max_items_per_frame").and_then(Value::as_u64) {
                        s.scatter.max_items_per_frame = (x as usize).max(1);
                    }
                }
                "hlod" => {
                    if let Some(x) = b(value, "enabled") {
                        s.hlod.enabled = x;
                    }
                    if let Some(x) = f(value, "distance") {
                        s.hlod.distance = x.max(0.0);
                    }
                    if let Some(x) = f(value, "view") {
                        s.hlod.view = x.max(0.0);
                    }
                }
                _ => {
                    if let Some(x) = b(value, "enabled") {
                        s.origin.enabled = x;
                    }
                    if let Some(x) = f(value, "threshold") {
                        s.origin.threshold = x.max(1.0);
                    }
                    if let Some(x) = f(value, "snap") {
                        s.origin.snap = x.max(1.0);
                    }
                }
            }
            Ok(())
        }
        other => Err(format!("no settings group `{other}`")),
    }
}
