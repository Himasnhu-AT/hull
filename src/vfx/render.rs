//! Drawing: every emitter is one entity and one draw call.
//!
//! Sprite modes (billboard, stretched, ribbon trail, flat) write one [`SpriteInstance`]
//! (52 B) per particle or ribbon segment into the emitter's [`VfxSprites`]; `gpu.rs` draws
//! them instanced. Mesh particles bake lit copies of a small template mesh into one
//! vertex-coloured mesh with a shared `StandardMaterial` (meant for tens to hundreds of debris
//! pieces).
//!
//! Buffers are rewritten in place each frame (no allocation once grown). Emitters outside
//! every camera frustum, culled by distance, idle or empty are not rebuilt and are hidden.

use std::time::Instant;

use bevy::asset::RenderAssetUsages;
use bevy::camera::primitives::{Aabb, Frustum};
use bevy::camera::visibility::NoAutoAabb;
use bevy::math::{Affine3A, Quat, Vec3A, Vec4};
use bevy::mesh::{Indices, PrimitiveTopology, VertexAttributeValues};
use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::curve::{LUT, SrgbEncoder};
use super::def::{EmitterDef, MeshShape, RenderMode};
use super::gpu::{GpuTiming, MODE_BILLBOARD, MODE_FLAT, MODE_RIBBON, MODE_STRETCHED, ParticleUniform, SpriteInstance, SpriteMaterial};
use super::rng::hash32;
use super::sim::{CompiledEmitter, EmitterState, lut};
use super::textures::VfxTextures;
use super::{VfxInstance, VfxSet, VfxStats};

/// Marks an emitter's render entity (owner = the effect entity).
#[derive(Component, Clone, Copy, Debug)]
pub struct VfxRender {
    pub owner: Entity,
    pub emitter: u16,
}

/// Template meshes for mesh particles: `(positions, normals, indices)`.
struct Template {
    pos: Vec<Vec3A>,
    nrm: Vec<Vec3A>,
    idx: Vec<u32>,
}

#[derive(Resource)]
pub struct VfxRenderCache {
    mesh_material: Handle<StandardMaterial>,
    templates: HashMap<MeshShape, Template>,
    encoder: SrgbEncoder,
}

/// One sprite emitter's draw list for this frame (lives in [`VfxInstance`]; buffers keep
/// their capacity, so steady state allocates nothing).
#[derive(Debug, Default)]
pub struct EmitterDraw {
    pub instances: Vec<SpriteInstance>,
    pub material: Option<SpriteMaterial>,
    /// Sort point (bounds centre).
    pub center: Vec3,
    /// Drawn this frame.
    pub visible: bool,
}

/// Per-effect scratch for sorting and ribbons.
#[derive(Debug, Default)]
pub struct Scratch {
    sort: Vec<(u32, u32)>,
    points: Vec<(Vec3A, f32)>,
}

pub(super) fn build(app: &mut App) {
    super::gpu::build(app);
    app.add_systems(Startup, setup).add_systems(PostUpdate, (draw, lights).in_set(VfxSet::Render));
}

fn setup(mut commands: Commands, mut images: ResMut<Assets<Image>>, mut smats: ResMut<Assets<StandardMaterial>>) {
    commands.insert_resource(VfxTextures::generate(&mut images));
    let mut templates = HashMap::default();
    for s in [MeshShape::Cube, MeshShape::Tetra, MeshShape::Shard] {
        templates.insert(s, template(s));
    }
    commands.insert_resource(VfxRenderCache {
        mesh_material: smats.add(StandardMaterial { base_color: Color::WHITE, perceptual_roughness: 0.85, ..default() }),
        templates,
        encoder: SrgbEncoder::default(),
    });
}

/// Flat-shaded template mesh with unit size.
fn template(s: MeshShape) -> Template {
    let mesh: Mesh = match s {
        MeshShape::Cube => Cuboid::new(1.0, 1.0, 1.0).into(),
        MeshShape::Tetra => Tetrahedron::default().into(),
        MeshShape::Shard => {
            // Stretched, slightly irregular octahedron.
            let v = [
                Vec3::new(0.0, 0.7, 0.0),
                Vec3::new(0.0, -0.6, 0.05),
                Vec3::new(0.35, 0.0, 0.1),
                Vec3::new(-0.3, 0.05, 0.15),
                Vec3::new(0.05, 0.1, 0.3),
                Vec3::new(0.0, -0.05, -0.25),
            ];
            let tris = [[0, 4, 2], [0, 3, 4], [0, 5, 3], [0, 2, 5], [1, 2, 4], [1, 4, 3], [1, 3, 5], [1, 5, 2]];
            let pos: Vec<[f32; 3]> = tris.iter().flat_map(|t| t.map(|i| v[i].to_array())).collect();
            Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default()).with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        }
    };
    let mut mesh = mesh.with_duplicated_vertices();
    mesh.remove_indices();
    mesh.compute_flat_normals();
    let pos = match mesh.attribute(Mesh::ATTRIBUTE_POSITION) {
        Some(VertexAttributeValues::Float32x3(v)) => v.iter().map(|p| Vec3A::from_array(*p)).collect(),
        _ => Vec::new(),
    };
    let nrm = match mesh.attribute(Mesh::ATTRIBUTE_NORMAL) {
        Some(VertexAttributeValues::Float32x3(v)) => v.iter().map(|p| Vec3A::from_array(*p)).collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    let idx = (0..pos.len() as u32).collect();
    Template { pos, nrm, idx }
}

/// The GPU material of a sprite emitter.
pub fn sprite_material(textures: &VfxTextures, def: &EmitterDef) -> SpriteMaterial {
    let r = &def.render;
    let (cols, rows, frames, xfade) = match r.flipbook {
        Some(f) => (f.cols.max(1) as f32, f.rows.max(1) as f32, f.frames() as f32, f.blend as u8 as f32),
        None => (1.0, 1.0, 1.0, 0.0),
    };
    SpriteMaterial {
        texture: textures.get(r.texture).id(),
        params: ParticleUniform {
            flipbook: Vec4::new(cols, rows, frames, xfade),
            shading: Vec4::new(r.intensity.max(0.0), r.lit.clamp(0.0, 1.0), r.soft.max(0.0), r.blend.additive_amount()),
        },
    }
}

fn lit_mesh() -> Mesh {
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, Vec::<[f32; 3]>::new())
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, Vec::<[f32; 3]>::new())
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, Vec::<[f32; 4]>::new())
        .with_inserted_indices(Indices::U32(Vec::new()))
}

/// Near-camera handling for sprites (from [`super::VfxBudget::near_fade`] / `max_screen`).
#[derive(Clone, Copy, Debug, Default)]
pub struct NearCam {
    pub fade: Vec2,
    pub max_screen: f32,
}

impl NearCam {
    /// Size capped by distance, and the fade (0..1) for a sprite of that size at `dist`.
    fn apply(&self, size: f32, dist: f32) -> (f32, f32) {
        let size = if self.max_screen > 0.0 { size.min(dist * self.max_screen) } else { size };
        let (a, b) = (self.fade.x, self.fade.y);
        if b <= a {
            return (size, 1.0);
        }
        let edge = dist - size * 0.5;
        let t = ((edge - a) / (b - a)).clamp(0.0, 1.0);
        (size, t * t * (3.0 - 2.0 * t))
    }
}

/// Writes one emitter's sprite instances into `out` (cleared first). Returns the count.
#[allow(clippy::too_many_arguments)]
pub fn fill_sprites(
    out: &mut Vec<SpriteInstance>,
    e: &EmitterState,
    def: &EmitterDef,
    ce: &CompiledEmitter,
    enc: &SrgbEncoder,
    cam: Vec3A,
    near: NearCam,
    sort: &mut Vec<(u32, u32)>,
    points: &mut Vec<(Vec3A, f32)>,
) -> usize {
    out.clear();
    // Fading: alpha always; colour too in proportion to additive blending (no alpha there).
    let additive = def.render.blend.additive_amount();
    let faded = |c: [f32; 4], f: f32| -> [f32; 4] {
        if f >= 1.0 {
            return c;
        }
        let k = 1.0 + (f - 1.0) * additive;
        [c[0] * k, c[1] * k, c[2] * k, c[3] * f]
    };
    let p = &e.p;
    let n = p.len();
    let r = &def.render;
    let frames = r.flipbook.map(|f| f.frames()).unwrap_or(1) as f32;
    let fb = r.flipbook;
    let color = |i: usize, t: f32| -> [f32; 4] {
        let c = lut(&ce.color_lut, t);
        let k = ce.tint_lut[(hash32(p.seed[i]) as usize) % LUT];
        [c[0] * k[0], c[1] * k[1], c[2] * k[2], c[3] * k[3]]
    };
    let frame = |i: usize, t: f32| -> f32 {
        match fb {
            None => 0.0,
            Some(f) => {
                let start = if f.random_start { (hash32(p.seed[i] ^ 0x5bd1_e995) % f.frames()) as f32 } else { 0.0 };
                let x = if f.fps > 0.0 { p.age[i] * f.fps } else { t * (frames - 1.0).max(0.0) };
                (x + start) % frames
            }
        }
    };
    let sorted = r.sort && n > 1 && r.blend.additive_amount() < 1.0;
    if sorted {
        sort.clear();
        sort.extend((0..n).map(|i| ((p.pos[i] - cam).length_squared().to_bits(), i as u32)));
        sort.sort_unstable_by_key(|s| core::cmp::Reverse(s.0));
    }
    let idx = |k: usize, sort: &Vec<(u32, u32)>| if sorted { sort[k].1 as usize } else { k };
    let v4 = |v: Vec3A, w: f32| [v.x, v.y, v.z, w];
    match &r.mode {
        RenderMode::Billboard => {
            out.reserve(n);
            for k in 0..n {
                let i = idx(k, sort);
                let t = p.t(i);
                let (size, f) = near.apply(p.size[i] * lut(&ce.size_lut, t), (p.pos[i] - cam).length());
                if f <= 0.0 {
                    continue;
                }
                out.push(SpriteInstance {
                    a: v4(p.pos[i], size * def.aspect),
                    b: [0.0, 0.0, 0.0, size],
                    c: [p.rot[i], frame(i, t), 1.0, MODE_BILLBOARD],
                    color: enc.rgba(faded(color(i, t), f)),
                });
            }
        }
        RenderMode::Flat { normal } => {
            let nr = Vec3A::from(normal.normalize_or(Vec3::Y));
            for k in 0..n {
                let i = idx(k, sort);
                let t = p.t(i);
                let (size, f) = near.apply(p.size[i] * lut(&ce.size_lut, t), (p.pos[i] - cam).length());
                if f <= 0.0 {
                    continue;
                }
                out.push(SpriteInstance {
                    a: v4(p.pos[i], size * def.aspect),
                    b: v4(nr, size),
                    c: [p.rot[i], frame(i, t), 1.0, MODE_FLAT],
                    color: enc.rgba(faded(color(i, t), f)),
                });
            }
        }
        RenderMode::Stretched { factor } => {
            for k in 0..n {
                let i = idx(k, sort);
                let t = p.t(i);
                // Tracers and sparks: fade near the camera, but keep their width.
                let size = p.size[i] * lut(&ce.size_lut, t);
                let (_, f) = near.apply(size, (p.pos[i] - cam).length());
                if f <= 0.0 {
                    continue;
                }
                let v = p.vel[i];
                let speed = v.length();
                let axis = if speed > 1e-5 { v / speed } else { Vec3A::Y };
                let len = size + speed * factor;
                let w = size * def.aspect;
                out.push(SpriteInstance {
                    a: v4(p.pos[i] - axis * (len * 0.5), w),
                    b: v4(axis * len, w),
                    c: [1.0, frame(i, t), 1.0, MODE_STRETCHED],
                    color: enc.rgba(faded(color(i, t), f)),
                });
            }
        }
        RenderMode::Trail { .. } => {
            let tp = ce.trail_points as usize;
            for k in 0..n {
                let i = idx(k, sort);
                let t = p.t(i);
                let size = p.size[i] * lut(&ce.size_lut, t);
                let c = enc.rgba(color(i, t));
                // Newest first: the particle, then the recorded history.
                points.clear();
                points.push((p.pos[i], 0.0));
                for j in 0..p.trail_len[i] as usize {
                    let q = p.trail[i * tp + (e.trail_head as usize + tp - j) % tp];
                    if (q - points[points.len() - 1].0).length_squared() > 1e-8 {
                        points.push((q, 0.0));
                    }
                }
                let m = points.len();
                if m < 2 {
                    continue;
                }
                for (j, pt) in points.iter_mut().enumerate() {
                    pt.1 = lut(&ce.taper_lut, j as f32 / (m - 1) as f32);
                }
                for j in 0..m - 1 {
                    let ((a, ta), (b, tb)) = (points[j], points[j + 1]);
                    out.push(SpriteInstance { a: v4(a, size * ta), b: v4(b - a, size * tb), c: [ta, 0.0, tb, MODE_RIBBON], color: c });
                }
            }
        }
        RenderMode::Mesh { .. } | RenderMode::None => {}
    }
    out.len()
}

/// Fills a lit mesh-particle mesh. Returns the vertex count.
fn fill_meshes(mesh: &mut Mesh, e: &EmitterState, def: &EmitterDef, ce: &CompiledEmitter, tpl: &Template) -> usize {
    let p = &e.p;
    let (mut pos, mut nrm, mut col) = (None, None, None);
    let Ok(attrs) = mesh.try_attributes_mut() else { return 0 };
    for (attr, values) in attrs {
        let id = attr.id;
        match values {
            VertexAttributeValues::Float32x3(v) => {
                if id == Mesh::ATTRIBUTE_POSITION.id {
                    pos = Some(v);
                } else if id == Mesh::ATTRIBUTE_NORMAL.id {
                    nrm = Some(v);
                }
            }
            VertexAttributeValues::Float32x4(v) if id == Mesh::ATTRIBUTE_COLOR.id => col = Some(v),
            _ => {}
        }
    }
    let (Some(pos), Some(nrm), Some(col)) = (pos, nrm, col) else { return 0 };
    pos.clear();
    nrm.clear();
    col.clear();
    for i in 0..p.len() {
        let t = p.t(i);
        let size = p.size[i] * lut(&ce.size_lut, t);
        let h = hash32(p.seed[i]);
        let axis = Vec3::new((h & 0xff) as f32 - 127.5, ((h >> 8) & 0xff) as f32 - 127.5, ((h >> 16) & 0xff) as f32 - 127.5).normalize_or(Vec3::Y);
        let q = Quat::from_axis_angle(axis, p.rot[i]);
        let c = lut(&ce.color_lut, t);
        let k = ce.tint_lut[(h as usize) % LUT];
        let c = [c[0] * k[0], c[1] * k[1], c[2] * k[2], 1.0];
        let shape = Vec3A::new(size * def.aspect, size, size);
        for (v, n) in tpl.pos.iter().zip(&tpl.nrm) {
            pos.push((p.pos[i] + q * (*v * shape)).to_array());
            nrm.push((q * *n).to_array());
            col.push(c);
        }
    }
    let verts = pos.len();
    if let Some(Indices::U32(idx)) = mesh.indices_mut() {
        let per = tpl.idx.len();
        let want = per * p.len();
        if idx.len() > want {
            idx.truncate(want);
        }
        let tv = tpl.pos.len() as u32;
        let mut k = (idx.len() / per.max(1)) as u32;
        while idx.len() < want {
            idx.extend(tpl.idx.iter().map(|x| x + k * tv));
            k += 1;
        }
    }
    verts
}

/// Pass 1 (serial, cheap): bounds, frustum test, render entities, mesh particles.
/// Pass 2 (parallel over effects): sprite instance lists.
fn draw(
    mut commands: Commands,
    cache: Option<ResMut<VfxRenderCache>>,
    textures: Option<Res<VfxTextures>>,
    timing: Option<Res<GpuTiming>>,
    budget: Res<super::VfxBudget>,
    mut redraw: MessageWriter<bevy::window::RequestRedraw>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut stats: ResMut<VfxStats>,
    cams: Query<(&Camera, &GlobalTransform, &Frustum)>,
    main: Query<&GlobalTransform, With<crate::gfx::MainCamera>>,
    mut effects: Query<(Entity, &mut VfxInstance)>,
    mut lit: Query<(&Mesh3d, &mut Aabb, &mut Visibility), With<VfxRender>>,
) {
    let (Some(mut cache), Some(textures)) = (cache, textures) else { return };
    let t0 = Instant::now();
    let cam = main.iter().next().or_else(|| cams.iter().find(|c| c.0.is_active).map(|c| c.1)).map(|g| Vec3A::from(g.translation())).unwrap_or(Vec3A::ZERO);
    let cache = &mut *cache;
    let (mut drawn, mut drawn_p, mut instances) = (0u32, 0u32, 0u32);
    let mut sprites_pending = false;
    for (owner, mut inst) in &mut effects {
        let inst = &mut *inst;
        let n = inst.state.emitters.len();
        if inst.renders.len() != n {
            inst.renders.resize(n, Entity::PLACEHOLDER);
            inst.draws.resize_with(n, EmitterDraw::default);
        }
        for k in 0..n {
            let def = &inst.fx.def.emitters[k];
            inst.draws[k].visible = false;
            if matches!(def.render.mode, RenderMode::None) {
                continue;
            }
            let e = &inst.state.emitters[k];
            let pad = Vec3A::splat(e.max_size * 0.5 + 1e-3);
            let aabb = Aabb::from_min_max((e.min - pad).into(), (e.max + pad).into());
            let show = !inst.idle
                && !inst.culled
                && !e.p.is_empty()
                && cams.iter().any(|(c, _, f)| c.is_active && f.intersects_obb(&aabb, &Affine3A::IDENTITY, true, true));
            let r = inst.renders[k];
            let is_mesh = matches!(def.render.mode, RenderMode::Mesh { .. });
            if !show {
                if is_mesh
                    && r != Entity::PLACEHOLDER
                    && let Ok((_, _, mut vis)) = lit.get_mut(r)
                {
                    vis.set_if_neq(Visibility::Hidden);
                }
                continue;
            }
            drawn += 1;
            drawn_p += e.p.len() as u32;
            let name = || Name::new(format!("vfx:{}/{}", inst.fx.def.name, def.name));
            if is_mesh {
                let handle = if r == Entity::PLACEHOLDER {
                    let h = meshes.add(lit_mesh());
                    inst.renders[k] = commands
                        .spawn((
                            name(),
                            Mesh3d(h.clone()),
                            MeshMaterial3d(cache.mesh_material.clone()),
                            Transform::IDENTITY,
                            Visibility::Visible,
                            NoAutoAabb,
                            aabb,
                            VfxRender { owner, emitter: k as u16 },
                            crate::render_budget::Actor,
                            // Small, short-lived debris: not worth a pass in every shadow view.
                            bevy::light::NotShadowCaster,
                        ))
                        .id();
                    h
                } else {
                    let Ok((m, mut ab, mut vis)) = lit.get_mut(r) else { continue };
                    vis.set_if_neq(Visibility::Visible);
                    *ab = aabb;
                    m.0.clone()
                };
                let (Some(mut mesh), Some(tpl)) = (meshes.get_mut(&handle), cache.templates.get(&shape_of(def))) else { continue };
                instances += fill_meshes(&mut mesh, e, def, &inst.fx.emitters[k], tpl) as u32;
            } else {
                if r == Entity::PLACEHOLDER {
                    // Identity of the draw (phase item key) and a name for debugging.
                    inst.renders[k] = commands.spawn((name(), VfxRender { owner, emitter: k as u16 })).id();
                }
                let d = &mut inst.draws[k];
                if d.material.is_none() {
                    d.material = Some(sprite_material(&textures, def));
                }
                d.visible = true;
                d.center = Vec3::from((e.min + e.max) * 0.5);
                sprites_pending = true;
            }
        }
    }

    if sprites_pending {
        let enc = &cache.encoder;
        let near = NearCam { fade: budget.near_fade, max_screen: budget.max_screen };
        let build = |inst: &mut VfxInstance| {
            for k in 0..inst.draws.len() {
                if !inst.draws[k].visible {
                    continue;
                }
                let (e, def, ce) = (&inst.state.emitters[k], &inst.fx.def.emitters[k], &inst.fx.emitters[k]);
                let s = &mut inst.scratch;
                fill_sprites(&mut inst.draws[k].instances, e, def, ce, enc, cam, near, &mut s.sort, &mut s.points);
            }
        };
        if budget.parallel {
            effects.par_iter_mut().for_each(|(_, mut inst)| build(&mut inst));
        } else {
            effects.iter_mut().for_each(|(_, mut inst)| build(&mut inst));
        }
        for (_, inst) in &effects {
            instances += inst.draws.iter().filter(|d| d.visible).map(|d| d.instances.len() as u32).sum::<u32>();
        }
    }

    if drawn > 0 {
        // Particles animate: keep `RenderBudget::idle_skip` from skipping these frames.
        redraw.write(bevy::window::RequestRedraw);
    }
    stats.drawn_emitters = drawn;
    stats.drawn_particles = drawn_p;
    stats.instances = instances;
    stats.build_us = t0.elapsed().as_secs_f32() * 1e6;
    stats.upload_us = timing.map(|t| t.upload_us() as f32).unwrap_or(0.0);
}

/// Marks an effect's point light.
#[derive(Component, Clone, Copy, Debug)]
pub struct VfxLight {
    pub owner: Entity,
}

/// Effect lights: the `VfxBudget::max_lights` nearest lit effects get a `PointLight`
/// (no shadows), the rest are hidden.
fn lights(
    mut commands: Commands,
    budget: Res<super::VfxBudget>,
    mut effects: Query<(Entity, &mut VfxInstance, &GlobalTransform)>,
    mut lights: Query<(&mut PointLight, &mut Transform, &mut Visibility), With<VfxLight>>,
    mut nearest: Local<Vec<(f32, Entity, f32)>>,
) {
    nearest.clear();
    for (e, inst, _) in &effects {
        let Some(l) = &inst.fx.def.light else { continue };
        let i = if inst.idle || inst.culled { 0.0 } else { l.intensity_at(inst.state.time, inst.state.seed) };
        if i > 0.0 {
            nearest.push((inst.distance, e, i));
        } else if inst.light != Entity::PLACEHOLDER
            && let Ok((_, _, mut vis)) = lights.get_mut(inst.light)
        {
            vis.set_if_neq(Visibility::Hidden);
        }
    }
    nearest.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    for (rank, &(_, e, intensity)) in nearest.iter().enumerate() {
        let Ok((_, mut inst, g)) = effects.get_mut(e) else { continue };
        let l = inst.fx.def.light.clone().unwrap_or_default();
        let on = rank < budget.max_lights as usize;
        let pos = g.transform_point(l.offset);
        if inst.light == Entity::PLACEHOLDER {
            if !on {
                continue;
            }
            inst.light = commands
                .spawn((
                    Name::new(format!("vfx:{}/light", inst.fx.def.name)),
                    PointLight { color: Color::linear_rgb(l.color[0], l.color[1], l.color[2]), intensity, range: l.range, shadow_maps_enabled: false, ..default() },
                    Transform::from_translation(pos),
                    VfxLight { owner: e },
                ))
                .id();
            continue;
        }
        let Ok((mut pl, mut tf, mut vis)) = lights.get_mut(inst.light) else { continue };
        vis.set_if_neq(if on { Visibility::Inherited } else { Visibility::Hidden });
        if on {
            pl.intensity = intensity;
            tf.translation = pos;
        }
    }
}

fn shape_of(def: &EmitterDef) -> MeshShape {
    match def.render.mode {
        RenderMode::Mesh { shape } => shape,
        _ => MeshShape::Cube,
    }
}

#[cfg(test)]
mod tests {
    use super::super::presets;
    use super::super::sim::{Budget, CompiledEffect, FrameCtx, InstanceState};
    use super::*;

    #[test]
    fn sprites_are_built_for_every_mode() {
        let enc = SrgbEncoder::default();
        for name in ["sparks", "smoke", "explosion", "magic", "rain"] {
            let def = presets::PRESETS.iter().find(|p| p.0 == name).unwrap().1();
            let fx = CompiledEffect::new(def).unwrap();
            let mut st = InstanceState::new(&fx, 4);
            let b = Budget::unlimited();
            for i in 0..30 {
                let pos = Vec3::new(i as f32 * 0.1, 1.0, 0.0);
                st.step(&fx, &FrameCtx { dt: 1.0 / 60.0, ..FrameCtx::at(pos) }, &b);
            }
            for (k, e) in st.emitters.iter().enumerate() {
                let def = &fx.def.emitters[k];
                let (mut out, mut sort, mut pts) = (Vec::new(), Vec::new(), Vec::new());
                let q = fill_sprites(&mut out, e, def, &fx.emitters[k], &enc, Vec3A::new(0.0, 2.0, 8.0), NearCam::default(), &mut sort, &mut pts);
                assert_eq!(q, out.len());
                assert!(out.iter().all(|s| s.a.iter().chain(&s.b).chain(&s.c).all(|x| x.is_finite())), "{name}/{}", def.name);
                match def.render.mode {
                    RenderMode::Billboard | RenderMode::Stretched { .. } | RenderMode::Flat { .. } => assert_eq!(q, e.p.len(), "{name}/{}", def.name),
                    RenderMode::Trail { .. } => assert!(e.p.is_empty() || q > 0, "{name}/{} trail segments", def.name),
                    _ => assert_eq!(q, 0),
                }
                if let RenderMode::Mesh { shape } = def.render.mode {
                    let mut m = lit_mesh();
                    let tpl = template(shape);
                    let v = fill_meshes(&mut m, e, def, &fx.emitters[k], &tpl);
                    assert_eq!(v, e.p.len() * tpl.pos.len());
                    assert_eq!(m.indices().unwrap().len(), e.p.len() * tpl.idx.len());
                }
            }
        }
    }

    #[test]
    fn sprites_fade_and_shrink_at_the_camera() {
        let near = NearCam { fade: Vec2::new(0.1, 1.0), max_screen: 0.9 };
        // Far away: untouched.
        assert_eq!(near.apply(2.0, 20.0), (2.0, 1.0));
        // 0.5 m away, 2 m puff: capped to 0.45 m and fading.
        let (size, f) = near.apply(2.0, 0.5);
        assert!((size - 0.45).abs() < 1e-5);
        assert!(f > 0.0 && f < 1.0, "{f}");
        // At the camera: gone.
        assert_eq!(near.apply(1.0, 0.05).1, 0.0);
        // Off: nothing changes.
        assert_eq!(NearCam::default().apply(2.0, 0.3), (2.0, 1.0));
    }

    #[test]
    fn alpha_emitters_sort_back_to_front() {
        let enc = SrgbEncoder::default();
        let fx = CompiledEffect::new(presets::smoke()).unwrap();
        let mut st = InstanceState::new(&fx, 1);
        let b = Budget::unlimited();
        for _ in 0..120 {
            st.step(&fx, &FrameCtx { dt: 1.0 / 60.0, ..FrameCtx::at(Vec3::ZERO) }, &b);
        }
        let cam = Vec3A::new(0.0, 2.0, 6.0);
        let (mut out, mut sort, mut pts) = (Vec::new(), Vec::new(), Vec::new());
        fill_sprites(&mut out, &st.emitters[0], &fx.def.emitters[0], &fx.emitters[0], &enc, cam, NearCam::default(), &mut sort, &mut pts);
        let d: Vec<f32> = out.iter().map(|s| (Vec3A::new(s.a[0], s.a[1], s.a[2]) - cam).length()).collect();
        assert!(d.len() > 10);
        assert!(d.windows(2).all(|w| w[0] >= w[1]), "farthest first");
    }
}
