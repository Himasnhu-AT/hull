//! Sculpt and Paint: brush strokes on the terrain.
//!
//! The brush circle follows the ground under the cursor (ray vs `TerrainHeights`). Left drag
//! dabs at a fixed rate (20 per second, and every quarter radius when moving fast) between
//! `TerrainEdit::begin_stroke` and `end_stroke`; the stroke's before / after blobs become one
//! `Op::TerrainPatch` for undo (`TerrainEdit::apply_blob` writes either side back). A Ramp
//! stroke is applied on release (it grades the strip between its first and last point).

use bevy::prelude::*;
use editor_proto::{Op, TerrainKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Pointer, ToolState, ok, xz};
use crate::editor::EditorState;
use crate::world::{BrushKind, BrushSettings, Falloff, StrokeBlobs, TerrainEdit, TerrainHeights, TerrainLayer};

/// Sculpt uses the engine's brush settings as they are.
pub type SculptSettings = BrushSettings;

/// Paint: the splat layer and a round brush.
#[derive(Reflect, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PaintSettings {
    /// Splat layer (0..=3) to paint.
    #[reflect(@0u8..=3u8)]
    pub layer: u8,
    /// Metres.
    #[reflect(@super::super::schema::Unit("m"), @super::super::schema::Tip("Brush radius"))]
    pub radius: f32,
    /// 0..1 blend toward the layer per dab.
    #[reflect(@super::super::schema::Tip("How far each dab blends toward the layer (0 to 1)"))]
    pub strength: f32,
    pub falloff: Falloff,
}

impl Default for PaintSettings {
    fn default() -> Self {
        PaintSettings { layer: 1, radius: 20.0, strength: 0.35, falloff: Falloff::Smooth }
    }
}

#[derive(Default)]
pub(crate) struct StrokeState {
    pub open: bool,
    since: f32,
    last: Vec2,
    /// Ramp strokes keep their points until release.
    points: Vec<Vec2>,
    /// The brush that started the stroke (Shift may change mid-stroke; one stroke, one brush).
    brush: Option<BrushSettings>,
    label: &'static str,
}

/// Ray vs the heightfield: march with a step that grows with distance, then bisect the crossing.
pub fn ray_terrain(h: &TerrainHeights, ray: Ray3d) -> Option<Vec3> {
    let spacing = h.heightfield().spacing().max(0.5);
    let dir = *ray.direction;
    let above = |t: f32| {
        let p = ray.origin + dir * t;
        (h.contains(p.x, p.z)).then(|| p.y - h.height_at(p.x, p.z))
    };
    let mut t = 0.0f32;
    let mut prev: Option<f32> = None;
    while t < 12_000.0 {
        match above(t) {
            Some(d) if d <= 0.0 => {
                let t0 = prev?;
                // Crossed between t0 and t.
                let (mut lo, mut hi) = (t0, t);
                for _ in 0..20 {
                    let mid = (lo + hi) * 0.5;
                    match above(mid) {
                        Some(d) if d > 0.0 => lo = mid,
                        _ => hi = mid,
                    }
                }
                let p = ray.origin + dir * hi;
                return Some(Vec3::new(p.x, h.height_at(p.x, p.z), p.z));
            }
            Some(_) => prev = Some(t),
            None => prev = None,
        }
        t += (t * 0.01).clamp(spacing, 25.0);
    }
    None
}

fn brush_for(ts: &ToolState, id: &str, invert: bool) -> BrushSettings {
    if id == "paint" {
        let p = &ts.paint;
        return BrushSettings { kind: BrushKind::Paint, layer: if invert { 0 } else { p.layer.min(3) }, radius: p.radius, strength: p.strength, falloff: p.falloff, ..default() };
    }
    let mut s = ts.sculpt.clone();
    s.kind = match (s.kind, invert) {
        (BrushKind::Paint, _) => BrushKind::Raise,
        (BrushKind::Raise, true) => BrushKind::Lower,
        (BrushKind::Lower, true) => BrushKind::Raise,
        (k, _) => k,
    };
    s
}

fn label_of(id: &str) -> &'static str {
    if id == "paint" { "Paint terrain" } else { "Sculpt terrain" }
}

/// Records a finished stroke as one undo step.
pub fn record(world: &mut World, blobs: StrokeBlobs, label: &str) {
    let r = blobs.rect;
    let layer = match blobs.layer {
        TerrainLayer::Height => TerrainKind::Height,
        TerrainLayer::Splat => TerrainKind::Splat,
    };
    let op = Op::TerrainPatch { layer, rect: [r.x0, r.z0, r.w, r.h], before: blobs.before.0, after: blobs.after.0 };
    world.resource_mut::<EditorState>().record(label, op, None);
}

/// Ends an open stroke (also when the tool is switched mid-drag).
pub fn finish_stroke(world: &mut World, ts: &mut ToolState) {
    if !ts.terrain.open {
        return;
    }
    ts.terrain.open = false;
    let label = ts.terrain.label;
    let brush = ts.terrain.brush.take();
    let points = std::mem::take(&mut ts.terrain.points);
    let blobs = match brush {
        Some(b) if b.kind == BrushKind::Ramp => TerrainEdit::stroke(world, &b, &points).ok().flatten(),
        _ => TerrainEdit::end_stroke(world),
    };
    if let Some(b) = blobs {
        record(world, b, label);
    }
}

fn ring(h: &TerrainHeights, c: Vec3, r: f32) -> Vec<Vec3> {
    (0..=64)
        .map(|i| {
            let a = i as f32 / 64.0 * std::f32::consts::TAU;
            let (x, z) = (c.x + a.cos() * r, c.z + a.sin() * r);
            Vec3::new(x, if h.contains(x, z) { h.height_at(x, z) } else { c.y } + 0.3, z)
        })
        .collect()
}

/// Pointer handling for Sculpt / Paint.
pub fn interact(world: &mut World, ts: &mut ToolState, p: &Pointer, id: &str) {
    let Some(heights) = world.get_resource::<TerrainHeights>().cloned() else { return };
    if p.bracket != 0 {
        let k = 1.15f32.powi(p.bracket);
        if id == "paint" {
            ts.paint.radius = (ts.paint.radius * k).clamp(1.0, 500.0);
        } else {
            ts.sculpt.radius = (ts.sculpt.radius * k).clamp(1.0, 500.0);
        }
    }
    let brush = brush_for(ts, id, p.shift);
    let hit = p.ray.and_then(|r| ray_terrain(&heights, r));
    let hovering = hit.filter(|_| p.over || ts.terrain.open);
    if let Some(c) = hovering {
        let colour = if p.shift { Color::srgb(0.3, 0.7, 1.0) } else if id == "paint" { Color::srgb(0.4, 1.0, 0.4) } else { Color::srgb(1.0, 0.6, 0.1) };
        ts.overlay.lines.push((ring(&heights, c, brush.radius), colour));
        ts.overlay.lines.push((ring(&heights, c, brush.radius * 0.5), colour.with_alpha(0.5)));
    }
    if p.pressed
        && !ts.terrain.open
        && let Some(c) = hit
    {
        TerrainEdit::begin_stroke(world);
        ts.terrain = StrokeState { open: true, since: f32::INFINITY, last: Vec2::new(c.x, c.z), points: Vec::new(), brush: Some(brush.clone()), label: label_of(id) };
    }
    if !ts.terrain.open {
        return;
    }
    if !p.down {
        finish_stroke(world, ts);
        return;
    }
    let Some(c) = hit else { return };
    let at = Vec2::new(c.x, c.z);
    let b = ts.terrain.brush.clone().unwrap_or(brush);
    ts.terrain.since += p.dt;
    if b.kind == BrushKind::Ramp {
        if ts.terrain.points.last().is_none_or(|l| l.distance(at) > 1.0) {
            ts.terrain.points.push(at);
        }
        return;
    }
    if ts.terrain.since >= 0.05 || ts.terrain.last.distance(at) >= b.radius * 0.25 {
        if let Err(e) = TerrainEdit::dab(world, &b, at) {
            warn!("sculpt: {e}");
        }
        ts.terrain.since = 0.0;
        ts.terrain.last = at;
    }
}

/// Scripted actions: `stroke {points: [[x, z], ...], shift?}`, `sample {at: [x, z]}`.
pub fn action(world: &mut World, id: &str, act: &str, p: &Value) -> Result<Value, String> {
    match act {
        "stroke" => {
            let pts: Vec<Vec2> = p.get("points").and_then(Value::as_array).ok_or("`points` is required")?.iter().filter_map(xz).collect();
            if pts.is_empty() {
                return Err("`points` has no [x, z] pairs".into());
            }
            let shift = p.get("shift").and_then(Value::as_bool).unwrap_or(false);
            let brush = brush_for(world.resource::<ToolState>(), id, shift);
            let blobs = TerrainEdit::stroke(world, &brush, &pts).map_err(|e| e.to_string())?;
            match blobs {
                Some(b) => {
                    let rect = b.rect;
                    record(world, b, label_of(id));
                    Ok(json!({"ok": true, "rect": [rect.x0, rect.z0, rect.w, rect.h]}))
                }
                None => Ok(json!({"ok": true, "rect": null, "note": "nothing changed"})),
            }
        }
        "sample" => {
            let at = p.get("at").and_then(xz).ok_or("`at` [x, z] is required")?;
            let h = world.get_resource::<TerrainHeights>().ok_or("no terrain")?;
            Ok(json!({"height": h.height_at(at.x, at.y)}))
        }
        _ => ok().and_then(|_| Err(format!("{id}: unknown action `{act}` (stroke, sample)"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rays_find_flat_ground_and_miss_the_sky() {
        let hf = crate::world::Heightfield::flat(101, 101, 2.0, Vec2::ZERO, 10.0);
        let h = TerrainHeights::new(std::sync::Arc::new(hf));
        let hit = ray_terrain(&h, Ray3d::new(Vec3::new(50.0, 60.0, 50.0), Dir3::NEG_Y)).unwrap();
        assert!((hit.y - 10.0).abs() < 0.01 && (hit.x - 50.0).abs() < 0.01, "{hit}");
        let slant = ray_terrain(&h, Ray3d::new(Vec3::new(20.0, 30.0, 100.0), Dir3::new(Vec3::new(0.3, -1.0, -0.5)).unwrap())).unwrap();
        assert!((slant.y - 10.0).abs() < 0.01);
        assert!(ray_terrain(&h, Ray3d::new(Vec3::new(50.0, 60.0, 50.0), Dir3::Y)).is_none());
        assert!(ray_terrain(&h, Ray3d::new(Vec3::new(500.0, 60.0, 500.0), Dir3::NEG_Y)).is_none(), "off the grid");
    }
}
