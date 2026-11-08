//! The staged cook. An [`Asset`] (the model plus everything derived from it) travels through a
//! list of [`Stage`]s; each reads and rewrites it and may add [`Issue`]s. The standard order is
//! `validate, normalize, textures, lods, collider, impostor, emit`. To add a stage (say, a
//! lightmap UV unwrap or a material remap) implement [`Stage`] and call
//! [`Pipeline::push`] / [`Pipeline::insert_after`]; to replace one (a quadric simplifier, a
//! different emit format) call [`Pipeline::replace`].

use std::path::{Path, PathBuf};

use glam::{Mat4, Vec3};

use crate::collider::{self, ColliderChoice};
use crate::desc::{AssetDesc, ColliderDesc, DESC_VERSION, ImpostorDesc, LodDesc};
use crate::glb_out::write_glb;
use crate::impostor::{self, BakeConfig, Impostor};
use crate::simplify::{Clustering, Simplifier};
use crate::Model;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug)]
pub struct Issue {
    pub severity: Severity,
    pub stage: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum UpAxis {
    #[default]
    Y,
    /// The source is Z-up (Blender export without "+Y up", most CAD): rotated to Y-up.
    Z,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Pivot {
    /// Leave the model where it is.
    Keep,
    /// Origin at the middle of the bottom (trees, props that stand on the ground).
    #[default]
    BottomCenter,
    Center,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub name: String,
    /// Multiplies every position (cm to m: 0.01).
    pub scale: f32,
    pub up_axis: UpAxis,
    pub pivot: Pivot,
    /// Rescale so the model is this tall (after `scale`).
    pub target_height: Option<f32>,
    pub max_texture_size: Option<u32>,
    /// Share of the triangles each extra LOD keeps (LOD0 is the full model).
    pub lod_ratios: Vec<f32>,
    /// Metres where each LOD hands over to the next (len = `lod_ratios.len() + 1`); empty: derived
    /// from the model's size.
    pub lod_distances: Vec<f32>,
    pub collider: ColliderChoice,
    /// `None`: no impostor.
    pub impostor: Option<BakeConfig>,
    pub impostor_max_distance: Option<f32>,
    pub tags: Vec<String>,
    /// Emit even when validation found errors.
    pub force: bool,
    /// A built `tools/cook` binary: when set, textures are also cooked to KTX2 (BC7/BC5).
    pub cook: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            name: "asset".into(),
            scale: 1.0,
            up_axis: UpAxis::Y,
            pivot: Pivot::BottomCenter,
            target_height: None,
            max_texture_size: None,
            lod_ratios: vec![0.4, 0.15],
            lod_distances: vec![],
            collider: ColliderChoice::Auto,
            impostor: Some(BakeConfig::default()),
            impostor_max_distance: None,
            tags: vec![],
            force: false,
            cook: None,
        }
    }
}

/// The model plus everything the stages derived from it.
pub struct Asset {
    pub name: String,
    /// LOD0, the full model.
    pub model: Model,
    /// Reduced levels (LOD1..), filled by `lods`.
    pub reduced: Vec<Model>,
    pub lod_distances: Vec<f32>,
    pub collider: ColliderDesc,
    pub impostor: Option<Impostor>,
    pub tags: Vec<String>,
    pub issues: Vec<Issue>,
    /// Files `emit` wrote (relative names).
    pub outputs: Vec<String>,
    pub cooked_textures: Option<String>,
    pub desc: Option<AssetDesc>,
}

impl Asset {
    pub fn new(model: Model) -> Asset {
        Asset {
            name: model.name.clone(),
            model,
            reduced: vec![],
            lod_distances: vec![],
            collider: ColliderDesc::None,
            impostor: None,
            tags: vec![],
            issues: vec![],
            outputs: vec![],
            cooked_textures: None,
            desc: None,
        }
    }

    pub fn issue(&mut self, severity: Severity, stage: &str, message: impl Into<String>) {
        self.issues.push(Issue { severity, stage: stage.into(), message: message.into() });
    }

    pub fn errors(&self) -> impl Iterator<Item = &Issue> {
        self.issues.iter().filter(|i| i.severity == Severity::Error)
    }

    /// Every LOD, full first.
    pub fn lods(&self) -> impl Iterator<Item = &Model> {
        std::iter::once(&self.model).chain(self.reduced.iter())
    }
}

pub struct Ctx<'a> {
    pub config: &'a Config,
    pub out_dir: &'a Path,
}

pub trait Stage {
    fn name(&self) -> &'static str;
    fn run(&mut self, asset: &mut Asset, ctx: &Ctx) -> Result<(), String>;
}

pub struct Pipeline {
    stages: Vec<Box<dyn Stage>>,
}

impl Pipeline {
    pub fn empty() -> Pipeline {
        Pipeline { stages: vec![] }
    }

    pub fn standard() -> Pipeline {
        let mut p = Pipeline::empty();
        p.push(Validate);
        p.push(Normalize);
        p.push(Textures);
        p.push(Lods::new(Clustering));
        p.push(Collider);
        p.push(Impostors);
        p.push(Emit);
        p
    }

    pub fn push(&mut self, s: impl Stage + 'static) -> &mut Self {
        self.stages.push(Box::new(s));
        self
    }

    pub fn insert_after(&mut self, after: &str, s: impl Stage + 'static) -> &mut Self {
        let i = self.stages.iter().position(|x| x.name() == after).map_or(self.stages.len(), |i| i + 1);
        self.stages.insert(i, Box::new(s));
        self
    }

    pub fn replace(&mut self, name: &str, s: impl Stage + 'static) -> &mut Self {
        if let Some(i) = self.stages.iter().position(|x| x.name() == name) {
            self.stages[i] = Box::new(s);
        }
        self
    }

    pub fn stage_names(&self) -> Vec<&'static str> {
        self.stages.iter().map(|s| s.name()).collect()
    }

    /// Runs every stage. Stops after a stage that left errors (unless `config.force`).
    #[allow(clippy::result_large_err)]
    pub fn run(&mut self, model: Model, config: &Config, out_dir: &Path) -> Result<Asset, (Asset, String)> {
        let mut asset = Asset::new(model);
        asset.name = config.name.clone();
        asset.tags = config.tags.clone();
        let ctx = Ctx { config, out_dir };
        for s in &mut self.stages {
            if let Err(e) = s.run(&mut asset, &ctx) {
                asset.issue(Severity::Error, s.name(), e.clone());
                return Err((asset, format!("stage `{}`: {e}", s.name())));
            }
            if !config.force && s.name() == "validate" && asset.errors().next().is_some() {
                let msg = asset.errors().map(|i| i.message.clone()).collect::<Vec<_>>().join("; ");
                return Err((asset, format!("validation failed: {msg}")));
            }
        }
        Ok(asset)
    }
}

// ---------------------------------------------------------------- validate

/// Checks the model is sane (no writes): empty or non-finite geometry, bad indices, degenerate
/// triangles, missing or undecodable textures, suspicious size and up axis.
pub struct Validate;

impl Stage for Validate {
    fn name(&self) -> &'static str {
        "validate"
    }

    fn run(&mut self, a: &mut Asset, ctx: &Ctx) -> Result<(), String> {
        let m = &a.model;
        let mut out: Vec<(Severity, String)> = vec![];
        if m.triangle_count() == 0 {
            out.push((Severity::Error, "model has no triangles".into()));
        }
        for me in &m.meshes {
            if me.positions.iter().flatten().any(|v| !v.is_finite()) {
                out.push((Severity::Error, format!("mesh {}: non-finite positions", me.name)));
            }
            if me.indices.iter().any(|i| *i as usize >= me.positions.len()) {
                out.push((Severity::Error, format!("mesh {}: index out of range", me.name)));
            }
            if me.indices.len() % 3 != 0 {
                out.push((Severity::Error, format!("mesh {}: index count is not a multiple of 3", me.name)));
            }
        }
        let degenerate: usize = m
            .meshes
            .iter()
            .filter(|me| me.indices.iter().all(|i| (*i as usize) < me.positions.len()))
            .map(|me| (0..me.triangles()).filter(|t| {
                let [p, q, r] = me.tri(*t);
                (q - p).cross(r - p).length_squared() < 1e-14
            }).count())
            .sum();
        if degenerate > 0 {
            out.push((Severity::Warning, format!("{degenerate} degenerate triangles")));
        }
        for (i, mat) in m.materials.iter().enumerate() {
            for (what, t) in [("base color", mat.base_color_tex), ("normal", mat.normal_tex), ("metal-rough", mat.metal_rough_tex)] {
                match t.and_then(|t| m.images.get(t)) {
                    Some(img) if img.bytes.is_empty() => out.push((Severity::Warning, format!("material {} ({i}): {what} texture `{}` is missing", mat.name, img.name))),
                    Some(img) if image::load_from_memory(&img.bytes).is_err() => out.push((Severity::Warning, format!("texture `{}` cannot be decoded", img.name))),
                    None if t.is_some() => out.push((Severity::Error, format!("material {}: {what} texture index out of range", mat.name))),
                    _ => {}
                }
            }
        }
        if let Some((lo, hi)) = m.bounds().filter(|_| out.iter().all(|(s, _)| *s != Severity::Error)) {
            let e = (hi - lo) * ctx.config.scale;
            let big = e.max_element();
            if big < 0.05 {
                out.push((Severity::Warning, format!("model is {big:.3} m across: units look like millimetres or centimetres (try scale 0.001 / 0.01)")));
            } else if big > 300.0 {
                out.push((Severity::Warning, format!("model is {big:.0} m across: units look like centimetres (try scale 0.01)")));
            }
            if ctx.config.up_axis == UpAxis::Y && e.z > e.y * 1.5 && e.z > e.x * 0.8 {
                out.push((Severity::Warning, format!("extent z ({:.2}) dwarfs y ({:.2}): the model may be Z-up (up_axis z)", e.z, e.y)));
            }
        }
        for (s, msg) in out {
            a.issue(s, "validate", msg);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- normalize

/// Applies the config: up axis, scale, target height, pivot. After this the model is Y-up, in
/// metres, standing on (or centred at) the origin.
pub struct Normalize;

impl Stage for Normalize {
    fn name(&self) -> &'static str {
        "normalize"
    }

    fn run(&mut self, a: &mut Asset, ctx: &Ctx) -> Result<(), String> {
        let c = ctx.config;
        let mut m = Mat4::from_scale(Vec3::splat(c.scale));
        if c.up_axis == UpAxis::Z {
            // Z-up to Y-up: rotate -90 degrees about X.
            m = Mat4::from_rotation_x(-std::f32::consts::FRAC_PI_2) * m;
        }
        a.model.transform(m);
        if let (Some(h), Some((lo, hi))) = (c.target_height, a.model.bounds()) {
            let k = h / (hi.y - lo.y).max(1e-6);
            a.model.transform(Mat4::from_scale(Vec3::splat(k)));
        }
        if let Some((lo, hi)) = a.model.bounds() {
            let center = (lo + hi) * 0.5;
            let shift = match c.pivot {
                Pivot::Keep => Vec3::ZERO,
                Pivot::BottomCenter => Vec3::new(center.x, lo.y, center.z),
                Pivot::Center => center,
            };
            a.model.transform(Mat4::from_translation(-shift));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- textures

/// Decodes every texture (undecodable ones are dropped from their materials), downsizes to
/// `max_texture_size`, and optionally runs `tools/cook` for KTX2.
pub struct Textures;

impl Stage for Textures {
    fn name(&self) -> &'static str {
        "textures"
    }

    fn run(&mut self, a: &mut Asset, ctx: &Ctx) -> Result<(), String> {
        let max = ctx.config.max_texture_size;
        let mut notes = vec![];
        for img in &mut a.model.images {
            if img.bytes.is_empty() {
                continue;
            }
            let Ok(d) = image::load_from_memory(&img.bytes) else { continue };
            if let Some(max) = max
                && (d.width() > max || d.height() > max)
            {
                let r = d.resize(max, max, image::imageops::FilterType::Triangle);
                let mut out = std::io::Cursor::new(Vec::new());
                r.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
                notes.push(format!("{}: {}x{} to {}x{}", img.name, d.width(), d.height(), r.width(), r.height()));
                img.bytes = out.into_inner();
                img.mime = "image/png".into();
            }
        }
        for n in notes {
            a.issue(Severity::Info, "textures", n);
        }
        if let Some(cook) = &ctx.config.cook {
            let dir = cook_textures(a, ctx, cook)?;
            a.cooked_textures = Some(dir);
        }
        Ok(())
    }
}

/// Writes each material's base color / normal / roughness as a PBR set under `<out>/<name>.tex/`
/// and runs `cook` on it (one KTX2 set per material).
fn cook_textures(a: &mut Asset, ctx: &Ctx, cook: &Path) -> Result<String, String> {
    let rel = format!("{}.tex", a.name);
    let root = ctx.out_dir.join(&rel);
    let mut any = false;
    for (i, mat) in a.model.materials.iter().enumerate() {
        let Some(color) = mat.base_color_tex.and_then(|t| a.model.images.get(t)).filter(|im| !im.bytes.is_empty()) else { continue };
        let set = root.join(format!("{}_{i}", mat.name.replace(['/', ' '], "_")));
        std::fs::create_dir_all(&set).map_err(|e| e.to_string())?;
        std::fs::write(set.join("color.png"), reencode_png(&color.bytes)?).map_err(|e| e.to_string())?;
        if let Some(n) = mat.normal_tex.and_then(|t| a.model.images.get(t)).filter(|im| !im.bytes.is_empty()) {
            std::fs::write(set.join("normal.png"), reencode_png(&n.bytes)?).map_err(|e| e.to_string())?;
        }
        if let Some(mr) = mat.metal_rough_tex.and_then(|t| a.model.images.get(t)).filter(|im| !im.bytes.is_empty()) {
            // glTF keeps roughness in G: cook wants it as a grey `rough.png`.
            let d = image::load_from_memory(&mr.bytes).map_err(|e| e.to_string())?.to_rgba8();
            let g = image::GrayImage::from_fn(d.width(), d.height(), |x, y| image::Luma([d.get_pixel(x, y)[1]]));
            g.save(set.join("rough.png")).map_err(|e| e.to_string())?;
        }
        any = true;
    }
    if !any {
        return Err("cook: no base color textures to cook".into());
    }
    let out = std::process::Command::new(cook).arg(&root).arg("--force").output().map_err(|e| format!("cook {}: {e}", cook.display()))?;
    if !out.status.success() {
        return Err(format!("cook failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(rel)
}

fn reencode_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let d = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let mut out = std::io::Cursor::new(Vec::new());
    d.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

// ---------------------------------------------------------------- lods

/// Builds the reduced levels with a [`Simplifier`] and decides the switch distances.
pub struct Lods {
    simplifier: Box<dyn Simplifier>,
}

impl Lods {
    pub fn new(s: impl Simplifier + 'static) -> Lods {
        Lods { simplifier: Box::new(s) }
    }
}

impl Stage for Lods {
    fn name(&self) -> &'static str {
        "lods"
    }

    fn run(&mut self, a: &mut Asset, ctx: &Ctx) -> Result<(), String> {
        let ratios = &ctx.config.lod_ratios;
        let mut prev = a.model.triangle_count();
        for (i, r) in ratios.iter().enumerate() {
            let mut m = self.simplifier.simplify(&a.model, *r);
            m.name = format!("{}.lod{}", a.name, i + 1);
            let t = m.triangle_count();
            if t >= prev {
                a.issue(Severity::Info, "lods", format!("LOD{} would not be cheaper ({t} >= {prev} triangles): dropped", i + 1));
                break;
            }
            prev = t;
            a.reduced.push(m);
        }
        let n = a.reduced.len() + 1;
        a.lod_distances = if ctx.config.lod_distances.len() == n {
            ctx.config.lod_distances.clone()
        } else {
            // Size-based default: the first switch where the model spans ~6 degrees... roughly 8x
            // its largest side, then x2.5 per level.
            let size = a.model.bounds().map_or(1.0, |(lo, hi)| (hi - lo).max_element());
            (0..n).map(|i| size * 8.0 * 2.5f32.powi(i as i32)).collect()
        };
        Ok(())
    }
}

// ---------------------------------------------------------------- collider

pub struct Collider;

impl Stage for Collider {
    fn name(&self) -> &'static str {
        "collider"
    }

    fn run(&mut self, a: &mut Asset, ctx: &Ctx) -> Result<(), String> {
        // Trimesh colliders use the cheapest level that still has real shape.
        let lod = a.reduced.len().min(1);
        a.collider = collider::generate(&a.model, ctx.config.collider, lod);
        Ok(())
    }
}

// ---------------------------------------------------------------- impostor

pub struct Impostors;

impl Stage for Impostors {
    fn name(&self) -> &'static str {
        "impostor"
    }

    fn run(&mut self, a: &mut Asset, ctx: &Ctx) -> Result<(), String> {
        if let Some(cfg) = ctx.config.impostor {
            a.impostor = Some(impostor::bake(&a.model, cfg)?);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- emit

/// Writes `<name>.lod<i>.glb`, `<name>.impostor.png` and `<name>.asset.ron` into the output
/// folder and fills [`Asset::desc`].
pub struct Emit;

impl Stage for Emit {
    fn name(&self) -> &'static str {
        "emit"
    }

    fn run(&mut self, a: &mut Asset, ctx: &Ctx) -> Result<(), String> {
        std::fs::create_dir_all(ctx.out_dir).map_err(|e| format!("{}: {e}", ctx.out_dir.display()))?;
        let write = |name: String, bytes: Vec<u8>, outputs: &mut Vec<String>| -> Result<String, String> {
            std::fs::write(ctx.out_dir.join(&name), bytes).map_err(|e| format!("{name}: {e}"))?;
            outputs.push(name.clone());
            Ok(name)
        };
        let mut outputs = vec![];
        let mut lods = vec![];
        for (i, m) in a.lods().enumerate() {
            let file = write(format!("{}.lod{i}.glb", a.name), write_glb(m), &mut outputs)?;
            lods.push(LodDesc { mesh: file, distance: a.lod_distances.get(i).copied().unwrap_or(f32::MAX), triangles: m.triangle_count() as u32 });
        }
        let impostor = match &a.impostor {
            Some(imp) => {
                let atlas = write(format!("{}.impostor.png", a.name), impostor::encode_png(imp)?, &mut outputs)?;
                Some(ImpostorDesc { atlas, views: imp.views, width: imp.quad_w, height: imp.quad_h, y_min: imp.y_min, max_distance: ctx.config.impostor_max_distance })
            }
            None => None,
        };
        let (lo, hi) = a.model.bounds().ok_or("empty model")?;
        let desc = AssetDesc {
            version: DESC_VERSION,
            name: a.name.clone(),
            bounds: (lo.to_array(), hi.to_array()),
            lods,
            collider: a.collider.clone(),
            impostor,
            tags: a.tags.clone(),
            cooked_textures: a.cooked_textures.clone(),
        };
        write(format!("{}.asset.ron", a.name), desc.to_ron()?.into_bytes(), &mut outputs)?;
        a.outputs = outputs;
        a.desc = Some(desc);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{fixtures, glb_out, gltf_in};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("asset-pipe-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn glb_round_trips_through_the_reader() {
        let tree = fixtures::tree();
        let (back, rep) = gltf_in::read_bytes(&glb_out::write_glb(&tree), None, "pine").unwrap();
        assert!(rep.warnings.is_empty(), "{:?}", rep.warnings);
        assert_eq!(back.meshes.len(), tree.meshes.len());
        assert_eq!(back.triangle_count(), tree.triangle_count());
        assert_eq!(back.materials.len(), 2);
        assert_eq!(back.images.len(), 2);
        assert!(back.materials[1].double_sided && back.materials[1].base_color_tex.is_some());
        let (a, b) = (tree.bounds().unwrap(), back.bounds().unwrap());
        assert!((a.1 - b.1).length() < 1e-4);
    }

    #[test]
    fn validate_flags_units_axis_and_missing_textures_and_stops_on_errors() {
        // Centimetre tree standing along Z, one texture missing.
        let mut m = fixtures::tree();
        m.transform(Mat4::from_rotation_x(std::f32::consts::FRAC_PI_2) * Mat4::from_scale(Vec3::splat(100.0)));
        m.images[0].bytes.clear();
        let dir = tmp("validate");
        let cfg = Config { name: "pine".into(), ..Default::default() };
        let mut a = Asset::new(m);
        Validate.run(&mut a, &Ctx { config: &cfg, out_dir: &dir }).unwrap();
        let text = a.issues.iter().map(|i| i.message.clone()).collect::<Vec<_>>().join("\n");
        assert!(text.contains("centimetres"), "{text}");
        assert!(text.contains("Z-up"), "{text}");
        assert!(text.contains("missing"), "{text}");
        // A model with no triangles is an error and stops the pipeline.
        let err = Pipeline::standard().run(Model::default(), &cfg, &dir).err().expect("fails");
        assert!(err.1.contains("no triangles"), "{}", err.1);
    }

    #[test]
    fn normalize_fixes_axis_scale_and_pivot() {
        let mut m = fixtures::tree();
        m.transform(Mat4::from_rotation_x(std::f32::consts::FRAC_PI_2) * Mat4::from_scale(Vec3::splat(100.0)) * Mat4::from_translation(Vec3::new(5.0, 0.0, 5.0)));
        let cfg = Config { scale: 0.01, up_axis: UpAxis::Z, target_height: Some(3.0), ..Default::default() };
        let mut a = Asset::new(m);
        Normalize.run(&mut a, &Ctx { config: &cfg, out_dir: Path::new(".") }).unwrap();
        let (lo, hi) = a.model.bounds().unwrap();
        assert!(lo.y.abs() < 1e-3 && (hi.y - 3.0).abs() < 1e-2, "{lo} {hi}");
        assert!(((lo.x + hi.x) / 2.0).abs() < 1e-2 && ((lo.z + hi.z) / 2.0).abs() < 1e-2);
    }

    #[test]
    fn standard_pipeline_cooks_lods_collider_impostor_and_sidecar() {
        let dir = tmp("full");
        let cfg = Config { name: "pine".into(), tags: vec!["tree".into()], impostor: Some(BakeConfig { views: 4, cell: 64, supersample: 1 }), ..Default::default() };
        let a = Pipeline::standard().run(fixtures::tree(), &cfg, &dir).map_err(|e| e.1).unwrap();
        let d = a.desc.as_ref().unwrap();
        assert_eq!(d.lods.len(), 3);
        assert!(d.lods[0].triangles > d.lods[1].triangles && d.lods[1].triangles > d.lods[2].triangles, "{:?}", d.lods);
        assert!(d.lods[0].distance < d.lods[1].distance && d.lods[1].distance < d.lods[2].distance);
        assert!(matches!(d.collider, ColliderDesc::Convex { .. }));
        assert_eq!(d.impostor.as_ref().unwrap().views, 4);
        for f in ["pine.lod0.glb", "pine.lod1.glb", "pine.lod2.glb", "pine.impostor.png", "pine.asset.ron"] {
            assert!(dir.join(f).exists(), "{f}");
        }
        // The sidecar parses back and each LOD file loads.
        let back = AssetDesc::from_ron(&std::fs::read_to_string(dir.join("pine.asset.ron")).unwrap()).unwrap();
        assert_eq!(&back, d);
        let (lod2, _) = gltf_in::read_file(&dir.join("pine.lod2.glb")).unwrap();
        assert_eq!(lod2.triangle_count() as u32, d.lods[2].triangles);
        assert_eq!(Pipeline::standard().stage_names(), ["validate", "normalize", "textures", "lods", "collider", "impostor", "emit"]);
    }

    #[test]
    fn custom_stages_slot_in_anywhere() {
        struct Tag;
        impl Stage for Tag {
            fn name(&self) -> &'static str {
                "tag"
            }
            fn run(&mut self, a: &mut Asset, _: &Ctx) -> Result<(), String> {
                a.tags.push("custom".into());
                Ok(())
            }
        }
        let mut p = Pipeline::standard();
        p.insert_after("collider", Tag);
        assert_eq!(p.stage_names()[4..6], ["collider", "tag"]);
        let dir = tmp("custom");
        let cfg = Config { name: "cube".into(), impostor: None, lod_ratios: vec![], ..Default::default() };
        let a = p.run(fixtures::cube(1.0), &cfg, &dir).map_err(|e| e.1).unwrap();
        assert_eq!(a.desc.unwrap().tags, vec!["custom".to_string()]);
    }
}
