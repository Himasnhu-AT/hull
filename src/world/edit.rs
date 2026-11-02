//! Editable terrain: apply height / splat patches and brush strokes to the live terrain, rebuild
//! only what they touch, and keep undo blobs. Docs: `docs/WORLD.md` ("Editing terrain").
//!
//! ```ignore
//! TerrainEdit::begin_stroke(world);
//! TerrainEdit::dab(world, &BrushSettings { kind: BrushKind::Raise, ..default() }, Vec2::new(10.0, 20.0))?;
//! let blobs = TerrainEdit::end_stroke(world);          // before / after BlobIds for undo
//! TerrainEdit::apply_blob(world, blobs.unwrap().before)?;
//! ```
//!
//! What one edit does (`TerrainEdit::set_heights`, a dab, or a blob):
//! 1. writes the new heights into the shared `Heightfield` in place (`Arc::make_mut`; the other
//!    holders, scatter and [`TerrainHeights`], let go first, so it only copies when a background
//!    mesh build still holds the old grid),
//! 2. recomputes LOD errors and skirts of the touched chunks,
//! 3. rebuilds their meshes at the LOD they show now (same mesh handle) and their colliders,
//!    normals included for the 1-sample border around the rectangle (so seams stay smooth),
//! 4. writes a [`TerrainChanged`] message.
//!
//! A dab on an idle terrain costs microseconds to a few hundred (see `docs/WORLD.md`); no
//! per-frame cost exists without edits.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, OnceLock};

use bevy::math::Rect;
use bevy::prelude::*;
use serde::{Deserialize, Serialize};

use super::brush::{self, BrushKind, BrushSettings, SampleRect};
use super::heightfield::Heightfield;
use super::scatter::Scatter;
use super::terrain::{Terrain, rebuild_chunks};
use super::terrain_data::{TerrainData, TerrainDataError};

/// Default memory cap of the undo blob store.
pub const DEFAULT_PATCH_STORE_BYTES: usize = 256 << 20;

/// Which data a patch changes.
#[derive(Reflect, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerrainLayer {
    Height,
    Splat,
}

/// Fired after every terrain edit. Games refresh what they derived from the terrain (road
/// shaping, PCG cells, navmesh).
#[derive(Message, Clone, Copy, Debug)]
pub struct TerrainChanged {
    pub layer: TerrainLayer,
    /// Changed samples (Height) or texels (Splat).
    pub rect: SampleRect,
    /// The same area in absolute metres (XZ), padded by one sample for Height (normals).
    pub rect_world: Rect,
}

/// Why an edit was refused.
#[derive(Debug, Clone, PartialEq)]
pub enum EditError {
    NoTerrain,
    NoSplat,
    /// The rectangle leaves the grid or the value count does not match it.
    BadRect(String),
    NoBlob(u64),
    Data(TerrainDataError),
}

impl std::fmt::Display for EditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EditError::NoTerrain => write!(f, "no terrain spawned"),
            EditError::NoSplat => write!(f, "the terrain has no splat map"),
            EditError::BadRect(e) => write!(f, "bad patch: {e}"),
            EditError::NoBlob(id) => write!(f, "no undo blob {id} (dropped by the memory cap?)"),
            EditError::Data(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for EditError {}

impl From<TerrainDataError> for EditError {
    fn from(e: TerrainDataError) -> Self {
        EditError::Data(e)
    }
}

/// The authoritative heights, for gameplay sampling (road shaping, placement, AI). Updated by
/// every edit; cheap to clone (shared grid).
#[derive(Resource, Clone)]
pub struct TerrainHeights(pub(crate) Arc<Heightfield>);

impl TerrainHeights {
    pub(crate) fn new(hf: Arc<Heightfield>) -> Self {
        TerrainHeights(hf)
    }
    pub fn heightfield(&self) -> &Heightfield {
        &self.0
    }
    /// Height at absolute `(x, z)` (same triangles as the mesh and the collider).
    pub fn height_at(&self, x: f32, z: f32) -> f32 {
        self.0.height_at(x, z)
    }
    pub fn normal_at(&self, x: f32, z: f32) -> Vec3 {
        self.0.smooth_normal_at(x, z)
    }
    pub fn slope_deg(&self, x: f32, z: f32) -> f32 {
        self.0.slope_deg(x, z)
    }
    pub fn contains(&self, x: f32, z: f32) -> bool {
        self.0.contains(x, z)
    }
}

/// The CPU copy of the splat map (RGBA8, `res × res` over the whole terrain, byte `i` = layer
/// `i`'s weight, weights sum to 255), plus the GPU image to keep in step (None headless).
#[derive(Resource)]
pub struct TerrainSplat {
    pub res: u32,
    pub bytes: Vec<u8>,
    pub(crate) image: Option<Handle<Image>>,
}

impl TerrainSplat {
    /// A splat map from bytes (`res² * 4`); `None` if the length is wrong.
    pub fn new(res: u32, bytes: Vec<u8>, image: Option<Handle<Image>>) -> Option<Self> {
        (res > 0 && bytes.len() == (res as usize).pow(2) * 4).then_some(TerrainSplat { res, bytes, image })
    }
}

/// Edit counters (`terrain.info`).
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct TerrainEditStats {
    pub dabs: u64,
    pub patches: u64,
    pub chunks_rebuilt: u64,
    /// Chunks touched by the last height edit.
    pub last_chunks: u32,
    /// Wall time of the last height edit's mesh / collider / chunk-info work (µs).
    pub last_rebuild_us: f32,
    /// Wall time of the last height edit overall (µs).
    pub last_total_us: f32,
}

/// Id of an undo blob in the [`TerrainPatchStore`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BlobId(pub u64);

#[derive(Clone, Debug, PartialEq)]
pub enum BlobData {
    Heights(Vec<f32>),
    /// RGBA8 texels of the rectangle.
    Splat(Vec<u8>),
}

/// The touched rectangle of one layer, as it was (before) or became (after).
#[derive(Clone, Debug, PartialEq)]
pub struct Blob {
    pub layer: TerrainLayer,
    pub rect: SampleRect,
    pub data: BlobData,
}

impl Blob {
    pub fn bytes(&self) -> usize {
        match &self.data {
            BlobData::Heights(v) => v.len() * 4,
            BlobData::Splat(v) => v.len(),
        }
    }
}

/// Undo storage: before / after blobs of strokes, oldest dropped when over `max_bytes` (the blob
/// just stored is never dropped).
#[derive(Resource)]
pub struct TerrainPatchStore {
    pub max_bytes: usize,
    next: u64,
    blobs: HashMap<u64, Blob>,
    order: VecDeque<u64>,
    bytes: usize,
}

impl Default for TerrainPatchStore {
    fn default() -> Self {
        TerrainPatchStore { max_bytes: DEFAULT_PATCH_STORE_BYTES, next: 1, blobs: HashMap::new(), order: VecDeque::new(), bytes: 0 }
    }
}

impl TerrainPatchStore {
    pub fn with_cap(max_bytes: usize) -> Self {
        TerrainPatchStore { max_bytes, ..default() }
    }
    pub fn insert(&mut self, blob: Blob) -> BlobId {
        let id = self.next;
        self.next += 1;
        self.bytes += blob.bytes();
        self.blobs.insert(id, blob);
        self.order.push_back(id);
        while self.bytes > self.max_bytes && self.order.len() > 1 {
            if let Some(old) = self.order.pop_front()
                && let Some(b) = self.blobs.remove(&old)
            {
                self.bytes -= b.bytes();
            }
        }
        BlobId(id)
    }
    pub fn get(&self, id: BlobId) -> Option<&Blob> {
        self.blobs.get(&id.0)
    }
    pub fn remove(&mut self, id: BlobId) -> Option<Blob> {
        let b = self.blobs.remove(&id.0)?;
        self.bytes -= b.bytes();
        self.order.retain(|i| *i != id.0);
        Some(b)
    }
    pub fn len(&self) -> usize {
        self.blobs.len()
    }
    pub fn is_empty(&self) -> bool {
        self.blobs.is_empty()
    }
    /// Bytes held.
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

/// What a finished stroke leaves for undo.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrokeBlobs {
    pub layer: TerrainLayer,
    pub rect: SampleRect,
    pub before: BlobId,
    pub after: BlobId,
}

/// One open stroke: the rectangle its dabs touched so far and what was in it before.
#[derive(Default)]
struct StrokeRec {
    layer: Option<TerrainLayer>,
    rect: SampleRect,
    before_h: Vec<f32>,
    before_s: Vec<u8>,
    /// Flatten `pick_target`: the height under the first dab.
    target: Option<f32>,
}

#[derive(Resource, Default)]
pub(crate) struct TerrainEditState {
    scratch: Vec<f32>,
    stroke: Option<StrokeRec>,
    stats: TerrainEditStats,
    /// Real time (s) of the last height edit not yet reflected in the streamed-mode coarse collider.
    coarse_dirty: Option<f64>,
}

/// The coarse fallback collider (streamed mode) is rebuilt this long after the last edit.
#[cfg(feature = "physics")]
const COARSE_REFRESH_SECS: f64 = 0.75;

fn placeholder() -> Arc<Heightfield> {
    static P: OnceLock<Arc<Heightfield>> = OnceLock::new();
    P.get_or_init(|| Arc::new(Heightfield::flat(2, 2, 1.0, Vec2::ZERO, 0.0))).clone()
}

/// Grows `rect`/`before` (elements of `stride` per cell) to also cover `new`, filling the new
/// area from the live data (`fetch`), keeping what was captured earlier.
fn grow_capture<T: Copy + Default>(rect: &mut SampleRect, before: &mut Vec<T>, stride: usize, new: SampleRect, fetch: impl Fn(SampleRect, &mut Vec<T>)) {
    if rect.is_empty() {
        *rect = new;
        fetch(new, before);
        return;
    }
    if rect.contains_rect(&new) {
        return;
    }
    let u = rect.union(&new);
    let mut grown = Vec::new();
    fetch(u, &mut grown);
    let row = rect.w as usize * stride;
    for j in 0..rect.h as usize {
        let dst = ((rect.z0 - u.z0) as usize + j) * u.w as usize * stride + (rect.x0 - u.x0) as usize * stride;
        grown[dst..dst + row].copy_from_slice(&before[j * row..(j + 1) * row]);
    }
    *rect = u;
    *before = grown;
}

fn fetch_heights(hf: &Heightfield) -> impl Fn(SampleRect, &mut Vec<f32>) + '_ {
    move |r, out| hf.copy_rect(r.x0, r.z0, r.w, r.h, out)
}

fn fetch_splat(sp: &TerrainSplat) -> impl Fn(SampleRect, &mut Vec<u8>) + '_ {
    move |r, out| {
        out.clear();
        for z in r.z0..r.z1() {
            let i = (z as usize * sp.res as usize + r.x0 as usize) * 4;
            out.extend_from_slice(&sp.bytes[i..i + r.w as usize * 4]);
        }
    }
}

/// Edits and queries on the live terrain. All functions take the `World` (call them from
/// exclusive systems, commands or control handlers).
pub struct TerrainEdit;

impl TerrainEdit {
    /// Replaces heights in `rect` (`rect.w * rect.h` values, row-major) and rebuilds what they
    /// touch. Returns the changed area in absolute metres.
    pub fn set_heights(world: &mut World, rect: SampleRect, values: &[f32]) -> Result<Rect, EditError> {
        let t0 = std::time::Instant::now();
        write_heights(world, rect, values)?;
        Ok(finish_heights(world, rect, t0))
    }

    /// Replaces splat texels in `rect` (`rect.w * rect.h * 4` bytes; weights should sum to 255).
    pub fn set_splat(world: &mut World, rect: SampleRect, texels: &[u8]) -> Result<Rect, EditError> {
        write_splat(world, rect, texels)?;
        Ok(finish_splat(world, rect))
    }

    /// One dab at `pos` (absolute XZ) with immediate rebuild. Joins the open stroke, if any.
    /// Ramp: from `pos` to `settings.ramp_end`. Returns the changed area (None: off the grid).
    pub fn dab(world: &mut World, s: &BrushSettings, pos: Vec2) -> Result<Option<Rect>, EditError> {
        let t0 = std::time::Instant::now();
        let r = dab_inner(world, s, pos)?;
        world.resource_mut::<TerrainEditState>().stats.dabs += 1;
        Ok(r.map(|(layer, rect)| finish(world, layer, rect, t0)))
    }

    /// Starts recording dabs for one undo step (a stroke already open is ended and dropped).
    pub fn begin_stroke(world: &mut World) {
        world.resource_mut::<TerrainEditState>().stroke = Some(StrokeRec::default());
    }

    pub fn stroke_open(world: &World) -> bool {
        world.get_resource::<TerrainEditState>().is_some_and(|s| s.stroke.is_some())
    }

    /// Ends the stroke and stores before / after blobs of the area it touched. `None` if nothing
    /// was touched or nothing changed.
    pub fn end_stroke(world: &mut World) -> Option<StrokeBlobs> {
        let rec = world.resource_mut::<TerrainEditState>().stroke.take()?;
        let layer = rec.layer?;
        if rec.rect.is_empty() {
            return None;
        }
        let (before, after) = match layer {
            TerrainLayer::Height => {
                let mut after = Vec::new();
                world.get_resource::<Terrain>()?.heightfield().copy_rect(rec.rect.x0, rec.rect.z0, rec.rect.w, rec.rect.h, &mut after);
                (BlobData::Heights(rec.before_h), BlobData::Heights(after))
            }
            TerrainLayer::Splat => {
                let mut after = Vec::new();
                fetch_splat(world.get_resource::<TerrainSplat>()?)(rec.rect, &mut after);
                (BlobData::Splat(rec.before_s), BlobData::Splat(after))
            }
        };
        if before == after {
            return None;
        }
        let mut store = world.get_resource_mut::<TerrainPatchStore>()?;
        let b = store.insert(Blob { layer, rect: rec.rect, data: before });
        let a = store.insert(Blob { layer, rect: rec.rect, data: after });
        Some(StrokeBlobs { layer, rect: rec.rect, before: b, after: a })
    }

    /// A whole stroke along `points` (absolute XZ): dabs every quarter radius (at least one
    /// sample spacing), one rebuild at the end, one undo step. Ramp grades the strip from the
    /// first to the last point.
    pub fn stroke(world: &mut World, s: &BrushSettings, points: &[Vec2]) -> Result<Option<StrokeBlobs>, EditError> {
        let Some(&first) = points.first() else { return Ok(None) };
        let t0 = std::time::Instant::now();
        let spacing = world.get_resource::<Terrain>().ok_or(EditError::NoTerrain)?.heightfield().spacing();
        let nested = Self::stroke_open(world);
        if !nested {
            Self::begin_stroke(world);
        }
        let mut dirty: Option<(TerrainLayer, SampleRect)> = None;
        let mut merge = |layer: TerrainLayer, r: SampleRect| {
            dirty = Some(match dirty {
                Some((l, d)) if l == layer => (layer, d.union(&r)),
                _ => (layer, r),
            });
        };
        let result = (|| -> Result<(), EditError> {
            if s.kind == BrushKind::Ramp {
                let last = *points.last().unwrap_or(&first);
                if let Some((l, r)) = ramp_inner(world, s, first, last)? {
                    merge(l, r);
                }
                return Ok(());
            }
            let step = (s.radius * 0.25).max(spacing).max(0.01);
            let mut at_distance = 0.0f32; // distance along the polyline of the last dab
            let mut walked = 0.0f32;
            let mut dab = |world: &mut World, p: Vec2| -> Result<(), EditError> {
                if let Some((l, r)) = dab_inner(world, s, p)? {
                    merge(l, r);
                }
                world.resource_mut::<TerrainEditState>().stats.dabs += 1;
                Ok(())
            };
            dab(world, first)?;
            for w in points.windows(2) {
                let (a, b) = (w[0], w[1]);
                let len = a.distance(b);
                if !len.is_finite() || len <= 0.0 {
                    continue;
                }
                while at_distance + step <= walked + len {
                    at_distance += step;
                    dab(world, a.lerp(b, (at_distance - walked) / len))?;
                }
                walked += len;
            }
            Ok(())
        })();
        if let Some((layer, rect)) = dirty {
            finish(world, layer, rect, t0);
        }
        if nested {
            result?;
            return Ok(None);
        }
        let blobs = Self::end_stroke(world);
        result?;
        Ok(blobs)
    }

    /// Writes a stored blob back into the terrain (undo: the `before` blob, redo: `after`).
    pub fn apply_blob(world: &mut World, id: BlobId) -> Result<(TerrainLayer, SampleRect, Rect), EditError> {
        let blob = world.get_resource::<TerrainPatchStore>().and_then(|s| s.get(id)).cloned().ok_or(EditError::NoBlob(id.0))?;
        let rect_world = match &blob.data {
            BlobData::Heights(v) => Self::set_heights(world, blob.rect, v)?,
            BlobData::Splat(v) => Self::set_splat(world, blob.rect, v)?,
        };
        Ok((blob.layer, blob.rect, rect_world))
    }

    /// Writes `terrain.ron`, `terrain.r16` (and `terrain_splat.rgba8` when there is a splat
    /// map) into `dir`. A relative `dir` is under the assets folder when one is set.
    pub fn save(world: &World, dir: &std::path::Path) -> Result<(), EditError> {
        let t = world.get_resource::<Terrain>().ok_or(EditError::NoTerrain)?;
        let splat = world.get_resource::<TerrainSplat>().map(|s| (s.res, s.bytes.clone()));
        let data = TerrainData::from_heightfield(t.heightfield(), t.source_samples().to_array(), splat);
        data.save(&resolve_dir(world, dir))?;
        Ok(())
    }
}

/// Where this world's terrain files live and whether edits since the last save are unsaved.
/// `spawn_world` fills `dir` for `HeightSource::TerrainFiles`; games that pass their own
/// heights set it themselves. Saving a level (`level::save_level`) writes the terrain there
/// when `dirty`.
#[derive(Resource, Clone, Debug, Default)]
pub struct TerrainSaveTarget {
    /// Folder for `terrain.ron` / `terrain.r16` / `terrain_splat.rgba8` (relative = under the
    /// assets folder). `None`: the terrain isn't saved with the level.
    pub dir: Option<std::path::PathBuf>,
    /// Heights or splat changed since the terrain was loaded or last saved.
    pub dirty: bool,
}

impl TerrainEdit {
    /// Writes the terrain to `TerrainSaveTarget::dir` if it has unsaved edits. Returns whether
    /// it wrote.
    pub fn save_if_dirty(world: &mut World) -> Result<bool, EditError> {
        let Some(t) = world.get_resource::<TerrainSaveTarget>() else { return Ok(false) };
        let Some(dir) = t.dir.clone().filter(|_| t.dirty) else { return Ok(false) };
        TerrainEdit::save(world, &dir)?;
        if let Some(mut t) = world.get_resource_mut::<TerrainSaveTarget>() {
            t.dirty = false;
        }
        Ok(true)
    }
}

fn mark_dirty(world: &mut World) {
    if let Some(mut t) = world.get_resource_mut::<TerrainSaveTarget>() {
        t.dirty = true;
    } else {
        world.insert_resource(TerrainSaveTarget { dir: None, dirty: true });
    }
}

/// `dir` as a path on disk: absolute stays, relative goes under the assets folder.
pub fn resolve_dir(world: &World, dir: &std::path::Path) -> std::path::PathBuf {
    match world.get_resource::<crate::paths::AssetsDir>() {
        Some(a) if dir.is_relative() => a.0.join(dir),
        _ => dir.to_path_buf(),
    }
}

/// Resolves the Flatten height for a dab: the explicit target, or the height under the stroke's
/// first dab with `pick_target`.
fn flatten_target(hf: &Heightfield, s: &BrushSettings, pos: Vec2, rec: Option<&mut StrokeRec>) -> f32 {
    if !s.pick_target {
        return s.target;
    }
    let here = hf.height_at(pos.x, pos.y);
    match rec {
        Some(r) => *r.target.get_or_insert(here),
        None => here,
    }
}

/// One dab, applied to the data (no chunk rebuild). Returns what changed.
fn dab_inner(world: &mut World, s: &BrushSettings, pos: Vec2) -> Result<Option<(TerrainLayer, SampleRect)>, EditError> {
    if !(pos.is_finite() && s.radius.is_finite()) {
        return Ok(None);
    }
    if s.kind == BrushKind::Ramp {
        let r = ramp_inner(world, s, pos, Vec2::from(s.ramp_end))?;
        return Ok(r);
    }
    if s.kind == BrushKind::Paint {
        return paint_inner(world, s, pos);
    }
    let mut scratch = std::mem::take(&mut world.resource_mut::<TerrainEditState>().scratch);
    let mut stroke = world.resource_mut::<TerrainEditState>().stroke.take();
    let res = (|| {
        let t = world.get_resource::<Terrain>().ok_or(EditError::NoTerrain)?;
        let hf = t.heightfield();
        let target = if s.kind == BrushKind::Flatten { flatten_target(hf, s, pos, stroke.as_mut()) } else { 0.0 };
        let Some(rect) = brush::dab_heights(hf, pos, s, target, &mut scratch) else { return Ok(None) };
        if let Some(rec) = stroke.as_mut() {
            rec.layer = Some(TerrainLayer::Height);
            grow_capture(&mut rec.rect, &mut rec.before_h, 1, rect, fetch_heights(hf));
        }
        write_heights(world, rect, &scratch)?;
        Ok(Some((TerrainLayer::Height, rect)))
    })();
    let mut st = world.resource_mut::<TerrainEditState>();
    st.scratch = scratch;
    st.stroke = stroke;
    res
}

fn ramp_inner(world: &mut World, s: &BrushSettings, a: Vec2, b: Vec2) -> Result<Option<(TerrainLayer, SampleRect)>, EditError> {
    if !(a.is_finite() && b.is_finite()) {
        return Ok(None);
    }
    let mut scratch = std::mem::take(&mut world.resource_mut::<TerrainEditState>().scratch);
    let mut stroke = world.resource_mut::<TerrainEditState>().stroke.take();
    let res = (|| {
        let t = world.get_resource::<Terrain>().ok_or(EditError::NoTerrain)?;
        let hf = t.heightfield();
        let ha = hf.height_at(a.x, a.y);
        let hb = if s.pick_target { hf.height_at(b.x, b.y) } else { s.target };
        let Some(rect) = brush::ramp_heights(hf, a, ha, b, hb, s, &mut scratch) else { return Ok(None) };
        if let Some(rec) = stroke.as_mut() {
            rec.layer = Some(TerrainLayer::Height);
            grow_capture(&mut rec.rect, &mut rec.before_h, 1, rect, fetch_heights(hf));
        }
        write_heights(world, rect, &scratch)?;
        Ok(Some((TerrainLayer::Height, rect)))
    })();
    let mut st = world.resource_mut::<TerrainEditState>();
    st.scratch = scratch;
    st.stroke = stroke;
    res
}

fn paint_inner(world: &mut World, s: &BrushSettings, pos: Vec2) -> Result<Option<(TerrainLayer, SampleRect)>, EditError> {
    let (origin, size) = {
        let hf = world.get_resource::<Terrain>().ok_or(EditError::NoTerrain)?.heightfield();
        (hf.origin(), hf.size())
    };
    let mut stroke = world.resource_mut::<TerrainEditState>().stroke.take();
    let res = (|| {
        let sp = world.get_resource::<TerrainSplat>().ok_or(EditError::NoSplat)?;
        let Some(rect) = brush::splat_rect(sp.res, origin, size, pos, s.radius) else { return Ok(None) };
        if let Some(rec) = stroke.as_mut() {
            rec.layer = Some(TerrainLayer::Splat);
            grow_capture(&mut rec.rect, &mut rec.before_s, 4, rect, fetch_splat(sp));
        }
        let mut sp = world.get_resource_mut::<TerrainSplat>().ok_or(EditError::NoSplat)?;
        let res = sp.res;
        brush::paint_texels(&mut sp.bytes, res, rect, origin, size, pos, s);
        sync_splat_image(world, rect);
        Ok(Some((TerrainLayer::Splat, rect)))
    })();
    world.resource_mut::<TerrainEditState>().stroke = stroke;
    res
}

/// Copies `rect` of the CPU splat map into the GPU image's main-world data.
fn sync_splat_image(world: &mut World, rect: SampleRect) {
    let Some(sp) = world.get_resource::<TerrainSplat>() else { return };
    let Some(handle) = sp.image.clone() else { return };
    let res = sp.res as usize;
    // Rows of the CPU copy, taken out so the image can be borrowed mutably.
    let rows: Vec<(usize, Vec<u8>)> = (rect.z0..rect.z1()).map(|z| ((z as usize * res + rect.x0 as usize) * 4, sp.bytes[(z as usize * res + rect.x0 as usize) * 4..][..rect.w as usize * 4].to_vec())).collect();
    let Some(mut images) = world.get_resource_mut::<Assets<Image>>() else { return };
    if let Some(mut img) = images.get_mut(&handle)
        && let Some(data) = img.data.as_mut()
    {
        for (off, row) in rows {
            if let Some(dst) = data.get_mut(off..off + row.len()) {
                dst.copy_from_slice(&row);
            }
        }
    }
}

fn write_heights(world: &mut World, rect: SampleRect, values: &[f32]) -> Result<(), EditError> {
    let r = write_heights_inner(world, rect, values);
    if r.is_ok() {
        mark_dirty(world);
    }
    r
}

fn write_heights_inner(world: &mut World, rect: SampleRect, values: &[f32]) -> Result<(), EditError> {
    world.resource_scope(|world, mut t: Mut<Terrain>| {
        let (nx, nz) = (t.heightfield().nx(), t.heightfield().nz());
        if rect.is_empty() || rect.x1() > nx || rect.z1() > nz || values.len() != rect.len() {
            return Err(EditError::BadRect(format!("{}×{} at ({}, {}) with {} values on a {nx}×{nz} grid", rect.w, rect.h, rect.x0, rect.z0, values.len())));
        }
        // Let go of the shared grid so the write is in place.
        if let Some(mut sc) = world.get_resource_mut::<Scatter>() {
            sc.hf = placeholder();
        }
        if let Some(mut th) = world.get_resource_mut::<TerrainHeights>() {
            th.0 = placeholder();
        }
        t.heightfield_mut().patch(rect.x0, rect.z0, rect.w, rect.h, values);
        let arc = t.heightfield_arc();
        if let Some(mut sc) = world.get_resource_mut::<Scatter>() {
            sc.hf = arc.clone();
        }
        if let Some(mut th) = world.get_resource_mut::<TerrainHeights>() {
            th.0 = arc;
        }
        Ok(())
    })
}

fn write_splat(world: &mut World, rect: SampleRect, texels: &[u8]) -> Result<(), EditError> {
    let r = write_splat_inner(world, rect, texels);
    if r.is_ok() {
        mark_dirty(world);
    }
    r
}

fn write_splat_inner(world: &mut World, rect: SampleRect, texels: &[u8]) -> Result<(), EditError> {
    let mut sp = world.get_resource_mut::<TerrainSplat>().ok_or(EditError::NoSplat)?;
    if rect.is_empty() || rect.x1() > sp.res || rect.z1() > sp.res || texels.len() != rect.len() * 4 {
        return Err(EditError::BadRect(format!("{}×{} at ({}, {}) with {} bytes on a {}² splat map", rect.w, rect.h, rect.x0, rect.z0, texels.len(), sp.res)));
    }
    let res = sp.res as usize;
    for (j, row) in texels.chunks_exact(rect.w as usize * 4).enumerate() {
        let off = ((rect.z0 as usize + j) * res + rect.x0 as usize) * 4;
        sp.bytes[off..off + row.len()].copy_from_slice(row);
    }
    sync_splat_image(world, rect);
    Ok(())
}

fn finish(world: &mut World, layer: TerrainLayer, rect: SampleRect, t0: std::time::Instant) -> Rect {
    match layer {
        TerrainLayer::Height => finish_heights(world, rect, t0),
        TerrainLayer::Splat => finish_splat(world, rect),
    }
}

fn finish_splat(world: &mut World, rect: SampleRect) -> Rect {
    let (origin, size) = world.get_resource::<Terrain>().map_or((Vec2::ZERO, Vec2::ONE), |t| (t.heightfield().origin(), t.heightfield().size()));
    let res = world.get_resource::<TerrainSplat>().map_or(1, |s| s.res.max(1)) as f32;
    let min = origin + Vec2::new(rect.x0 as f32, rect.z0 as f32) / res * size;
    let max = origin + Vec2::new(rect.x1() as f32, rect.z1() as f32) / res * size;
    let r = Rect::from_corners(min, max);
    world.resource_mut::<TerrainEditState>().stats.patches += 1;
    world.write_message(TerrainChanged { layer: TerrainLayer::Splat, rect, rect_world: r });
    r
}

/// After heights changed in `rect`: chunk infos, meshes, colliders, message.
fn finish_heights(world: &mut World, rect: SampleRect, t0: std::time::Instant) -> Rect {
    let t1 = std::time::Instant::now();
    let mut cs: Vec<UVec2> = Vec::new();
    let rect_world = world.resource_scope(|_, mut t: Mut<Terrain>| {
        let q = t.chunk_quads();
        let n = t.chunks();
        // Normals read one sample beyond the rectangle, so chunks touching that border change too.
        let (lo_x, lo_z) = (rect.x0.saturating_sub(1), rect.z0.saturating_sub(1));
        let (hi_x, hi_z) = (rect.x1(), rect.z1());
        let range = |lo: u32, hi: u32, count: u32| lo.div_ceil(q).saturating_sub(1)..=(hi / q).min(count - 1);
        for cz in range(lo_z, hi_z, n.y) {
            for cx in range(lo_x, hi_x, n.x) {
                let c = UVec2::new(cx, cz);
                let (cx0, cz0) = (cx * q, cz * q);
                // LOD errors / skirts depend on the chunk's own samples only.
                if rect.x0 <= cx0 + q && rect.x1() > cx0 && rect.z0 <= cz0 + q && rect.z1() > cz0 {
                    t.refresh_chunk_info(c);
                }
                cs.push(c);
            }
        }
        let hf = t.heightfield();
        let s = hf.spacing();
        let a = hf.sample_pos(rect.x0, rect.z0) - Vec2::splat(s);
        let b = hf.sample_pos(rect.x1().saturating_sub(1), rect.z1().saturating_sub(1)) + Vec2::splat(s);
        Rect::from_corners(a, b)
    });
    let rebuilt = rebuild_chunks(world, &cs);
    let now = world.get_resource::<Time<Real>>().map(|t| t.elapsed_secs_f64());
    let mut st = world.resource_mut::<TerrainEditState>();
    st.stats.patches += 1;
    st.stats.chunks_rebuilt += rebuilt as u64;
    st.stats.last_chunks = cs.len() as u32;
    st.stats.last_rebuild_us = t1.elapsed().as_secs_f32() * 1e6;
    st.stats.last_total_us = t0.elapsed().as_secs_f32() * 1e6;
    st.coarse_dirty = now.or(Some(0.0));
    world.write_message(TerrainChanged { layer: TerrainLayer::Height, rect, rect_world });
    rect_world
}

/// Edit counters and the timing of the last height edit.
pub fn edit_stats(world: &World) -> TerrainEditStats {
    world.get_resource::<TerrainEditState>().map(|s| s.stats).unwrap_or_default()
}

/// Streamed mode keeps one coarse collider under the whole map; after edits it is dropped (the
/// cells plugin rebuilds it) once the terrain has been quiet for a moment.
#[cfg(feature = "physics")]
fn refresh_coarse(mut commands: Commands, time: Res<Time<Real>>, mut st: ResMut<TerrainEditState>, coarse: Query<Entity, With<super::cells::CoarseCollider>>) {
    let Some(at) = st.coarse_dirty else { return };
    if time.elapsed_secs_f64() - at < COARSE_REFRESH_SECS {
        return;
    }
    st.coarse_dirty = None;
    for e in &coarse {
        commands.entity(e).try_despawn();
    }
}

pub(super) struct EditPlugin;

impl Plugin for EditPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<TerrainEditState>()
            .init_resource::<TerrainPatchStore>()
            .add_message::<TerrainChanged>()
            .register_type::<BrushSettings>()
            .register_type::<BrushKind>()
            .register_type::<brush::Falloff>()
            .register_type::<brush::SmoothKernel>()
            .register_type::<SampleRect>()
            .register_type::<TerrainLayer>();
        #[cfg(feature = "physics")]
        app.add_systems(PostUpdate, refresh_coarse.in_set(super::WorldSystems::Cells));
        #[cfg(feature = "devtools")]
        super::edit_control::register(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_blob(n: usize) -> Blob {
        Blob { layer: TerrainLayer::Height, rect: SampleRect::new(0, 0, n as u32, 1), data: BlobData::Heights(vec![1.0; n]) }
    }

    #[test]
    fn patch_store_caps_memory_and_drops_oldest() {
        let mut s = TerrainPatchStore::with_cap(1000);
        let ids: Vec<BlobId> = (0..10).map(|_| s.insert(store_blob(50))).collect(); // 200 B each
        assert!(s.bytes() <= 1000, "{}", s.bytes());
        assert_eq!(s.len(), 5);
        assert!(s.get(ids[0]).is_none() && s.get(ids[4]).is_none());
        assert!(s.get(ids[5]).is_some() && s.get(ids[9]).is_some());
        // A single blob over the cap is still kept (never drop what was just stored).
        let big = s.insert(store_blob(1000));
        assert!(s.get(big).is_some());
        assert_eq!(s.len(), 1);
        assert_eq!(s.bytes(), 4000);
        assert!(s.remove(big).is_some() && s.is_empty() && s.bytes() == 0);
    }

    #[test]
    fn grow_capture_keeps_earlier_before_data() {
        // "Live" grid where the first capture happened, then we mutate, then grow.
        let mut grid: Vec<f32> = (0..100).map(|i| i as f32).collect(); // 10×10
        let fetch = |g: &Vec<f32>| {
            let g = g.clone();
            move |r: SampleRect, out: &mut Vec<f32>| {
                out.clear();
                for z in r.z0..r.z1() {
                    for x in r.x0..r.x1() {
                        out.push(g[(z * 10 + x) as usize]);
                    }
                }
            }
        };
        let (mut rect, mut before) = (SampleRect::default(), Vec::new());
        grow_capture(&mut rect, &mut before, 1, SampleRect::new(2, 2, 3, 3), fetch(&grid));
        assert_eq!(before, vec![22.0, 23.0, 24.0, 32.0, 33.0, 34.0, 42.0, 43.0, 44.0]);
        for z in 2..5 {
            for x in 2..5 {
                grid[z * 10 + x] = -1.0; // an edit inside the first rect
            }
        }
        grow_capture(&mut rect, &mut before, 1, SampleRect::new(4, 1, 3, 3), fetch(&grid));
        assert_eq!(rect, SampleRect::new(2, 1, 5, 4));
        // Row z=1: x 2..7 untouched live values; z=2..4: original values for the old rect, live for the rest.
        assert_eq!(&before[0..5], &[12.0, 13.0, 14.0, 15.0, 16.0]);
        assert_eq!(&before[5..10], &[22.0, 23.0, 24.0, 25.0, 26.0]);
        assert_eq!(&before[15..20], &[42.0, 43.0, 44.0, 45.0, 46.0]);
        // Contained rect: no change.
        let snapshot = before.clone();
        grow_capture(&mut rect, &mut before, 1, SampleRect::new(3, 2, 2, 2), fetch(&grid));
        assert_eq!(before, snapshot);
    }
}
