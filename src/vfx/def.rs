//! Effect definitions: plain Rust data (serde, so also JSON over the control port or in a file).
//!
//! An [`EffectDef`] is a list of [`EmitterDef`]s. Every emitter is fully described here: how it
//! spawns (rate, rate per metre, bursts), where (a [`Shape`]), how particles move (velocity,
//! gravity, drag, curl turbulence, attractors, orbit, collision), how they look over their life
//! (size curve, colour gradient, rotation, flipbook) and how they are drawn ([`RenderDef`]).
//! Sub-emitters ([`SubEmitter`]) let one emitter spawn particles of a later emitter when its
//! particles spawn, die or collide (explosions, rain splashes).

use bevy::math::{Vec3, Vec3A};
use serde::{Deserialize, Serialize};

use super::curve::{Curve, Gradient};
use super::rng::Rng;

/// A `(min, max)` range sampled uniformly.
pub type Range = (f32, f32);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EffectDef {
    /// Library key (`vfx.spawn {preset: name}`).
    pub name: String,
    pub emitters: Vec<EmitterDef>,
    /// Seconds the emitters emit (rate and bursts) per cycle. `0` = forever.
    pub duration: f32,
    /// With `duration > 0`: start a new cycle after `duration` (bursts repeat).
    pub looping: bool,
    /// Keep the effect centred on the main camera (rain, snow, ambient dust).
    pub follow_camera: bool,
    /// Beyond this distance from the camera nothing spawns or draws (particles keep simulating).
    pub cull_distance: f32,
    pub lod: Lod,
    /// A point light that follows the effect (muzzle flashes, explosions, fires light the
    /// scene). Only drawn with a renderer; at most `VfxBudget::max_lights`, nearest first.
    pub light: Option<EffectLight>,
}

impl Default for EffectDef {
    fn default() -> Self {
        EffectDef { name: String::new(), emitters: Vec::new(), duration: 0.0, looping: false, follow_camera: false, cull_distance: 250.0, lod: Lod::default(), light: None }
    }
}

impl EffectDef {
    pub fn new(name: impl Into<String>) -> Self {
        EffectDef { name: name.into(), ..Default::default() }
    }
    pub fn with(mut self, e: EmitterDef) -> Self {
        self.emitters.push(e);
        self
    }
    /// One-shot: emits for `secs`, then finishes once every particle is dead.
    pub fn once(mut self, secs: f32) -> Self {
        self.duration = secs.max(1e-3);
        self.looping = false;
        self
    }
}

/// Light emitted by an effect.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EffectLight {
    /// Linear RGB.
    pub color: [f32; 3],
    /// Peak intensity (lumens, like `PointLight::intensity`).
    pub intensity: f32,
    pub range: f32,
    /// Effect-space offset.
    pub offset: Vec3,
    /// Seconds the light lives (0 = as long as the effect plays).
    pub duration: f32,
    /// Intensity multiplier over `duration` (constant at t = 0 when `duration` is 0).
    pub over_time: Curve,
    /// Random flicker amount (0..1), e.g. 0.3 for fire.
    pub flicker: f32,
}

impl Default for EffectLight {
    fn default() -> Self {
        EffectLight { color: [1.0, 0.6, 0.3], intensity: 100_000.0, range: 8.0, offset: Vec3::ZERO, duration: 0.0, over_time: Curve::constant(1.0), flicker: 0.0 }
    }
}

impl EffectLight {
    /// Intensity at effect time `t` (seconds); `seed` decorrelates flicker between instances.
    pub fn intensity_at(&self, t: f32, seed: u64) -> f32 {
        if self.duration > 0.0 && t > self.duration {
            return 0.0;
        }
        let f = if self.duration > 0.0 { t / self.duration } else { 0.0 };
        let mut k = self.over_time.sample(f);
        if self.flicker > 0.0 {
            let s = (seed % 1000) as f32;
            let n = (t * 17.0 + s).sin() * 0.5 + (t * 31.0 + s * 1.7).sin() * 0.3 + (t * 7.3 + s * 0.3).sin() * 0.2;
            k *= 1.0 + self.flicker * n;
        }
        (self.intensity * k).max(0.0)
    }
}

/// Distance level of detail: spawn counts are scaled from 1 at `near` down to `min_scale` at
/// `far` (and beyond).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Lod {
    pub near: f32,
    pub far: f32,
    pub min_scale: f32,
}

impl Default for Lod {
    fn default() -> Self {
        Lod { near: 25.0, far: 120.0, min_scale: 0.2 }
    }
}

impl Lod {
    pub fn scale(&self, dist: f32) -> f32 {
        if dist <= self.near || self.far <= self.near {
            return 1.0;
        }
        let f = ((dist - self.near) / (self.far - self.near)).clamp(0.0, 1.0);
        1.0 + (self.min_scale - 1.0) * f
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EmitterDef {
    /// Name (sub-emitters refer to emitters by name).
    pub name: String,
    /// Most particles alive at once (the per-emitter budget; buffers never grow past it).
    pub capacity: u32,
    /// Particles per second.
    pub rate: f32,
    /// Particles per metre the effect moves (trails behind moving things).
    pub rate_per_meter: f32,
    pub bursts: Vec<Burst>,
    /// Seconds after the cycle start before rate emission begins (bursts add it too).
    pub delay: f32,
    /// Seconds.
    pub lifetime: Range,
    pub shape: Shape,
    /// Shape offset in effect space.
    pub offset: Vec3,
    pub velocity: Velocity,
    /// Fraction of the effect's own velocity given to new particles.
    pub inherit_velocity: f32,
    /// m/s² (world space).
    pub gravity: Vec3,
    /// Linear drag (1/s): `v *= 1 / (1 + drag·dt)`.
    pub drag: f32,
    pub turbulence: Option<Turbulence>,
    pub attractors: Vec<Attractor>,
    pub orbit: Option<Orbit>,
    /// Start size in metres (scaled by the effect's `Transform` scale).
    pub size: Range,
    pub size_over_life: Curve,
    /// Billboard width / height.
    pub aspect: f32,
    pub color_over_life: Gradient,
    /// Each particle multiplies its colour by this gradient sampled at a random point (variety).
    pub start_tint: Gradient,
    /// Start rotation (radians) and spin (radians/s).
    pub rotation: Range,
    pub spin: Range,
    pub render: RenderDef,
    pub collision: Collision,
    pub sub_emitters: Vec<SubEmitter>,
    /// Particles move with the effect (only its translation).
    pub local_space: bool,
}

impl Default for EmitterDef {
    fn default() -> Self {
        EmitterDef {
            name: String::new(),
            capacity: 256,
            rate: 0.0,
            rate_per_meter: 0.0,
            bursts: Vec::new(),
            delay: 0.0,
            lifetime: (1.0, 1.0),
            shape: Shape::Point,
            offset: Vec3::ZERO,
            velocity: Velocity::None,
            inherit_velocity: 0.0,
            gravity: Vec3::ZERO,
            drag: 0.0,
            turbulence: None,
            attractors: Vec::new(),
            orbit: None,
            size: (0.2, 0.2),
            size_over_life: Curve::constant(1.0),
            aspect: 1.0,
            color_over_life: Gradient::default(),
            start_tint: Gradient::default(),
            rotation: (0.0, 0.0),
            spin: (0.0, 0.0),
            render: RenderDef::default(),
            collision: Collision::None,
            sub_emitters: Vec::new(),
            local_space: false,
        }
    }
}

/// `count` particles at `time` seconds into the cycle, repeated `cycles` times every `interval`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Burst {
    pub time: f32,
    pub count: u32,
    pub cycles: u32,
    pub interval: f32,
}

impl Default for Burst {
    fn default() -> Self {
        Burst { time: 0.0, count: 10, cycles: 1, interval: 0.0 }
    }
}

impl Burst {
    pub fn at(time: f32, count: u32) -> Self {
        Burst { time, count, ..Default::default() }
    }
}

/// Where particles start (effect space, before `offset`, rotation and scale).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Shape {
    Point,
    /// Inside the ball (or on its surface).
    Sphere { radius: f32, surface: bool },
    /// Upper half (+Y) of the ball.
    Hemisphere { radius: f32 },
    /// Base disc of `radius` at the apex; particles start on it (the cone opens along +Y,
    /// `angle` is the half-angle used by [`Velocity::Radial`] directions).
    Cone { angle: f32, radius: f32 },
    Box { half: Vec3 },
    /// Filled disc in the XZ plane.
    Disc { radius: f32 },
    /// Circle edge in the XZ plane.
    Ring { radius: f32 },
    /// Segment along X.
    Line { half_length: f32 },
    /// Explicit points (e.g. sampled from a mesh surface with [`Shape::mesh_surface`]).
    Points(Vec<Vec3>),
}

impl Shape {
    /// Samples `count` points on the triangles of `mesh` (area weighted, deterministic).
    pub fn mesh_surface(mesh: &bevy::mesh::Mesh, count: usize, seed: u64) -> Shape {
        use bevy::mesh::{Indices, VertexAttributeValues};
        let Some(VertexAttributeValues::Float32x3(pos)) = mesh.attribute(bevy::mesh::Mesh::ATTRIBUTE_POSITION) else {
            return Shape::Point;
        };
        let tris: Vec<[usize; 3]> = match mesh.indices() {
            Some(Indices::U32(i)) => i.chunks_exact(3).map(|c| [c[0] as usize, c[1] as usize, c[2] as usize]).collect(),
            Some(Indices::U16(i)) => i.chunks_exact(3).map(|c| [c[0] as usize, c[1] as usize, c[2] as usize]).collect(),
            None => (0..pos.len() / 3).map(|t| [t * 3, t * 3 + 1, t * 3 + 2]).collect(),
        };
        let v = |i: usize| Vec3::from(pos[i]);
        let mut cum = Vec::with_capacity(tris.len());
        let mut total = 0.0;
        for t in &tris {
            total += (v(t[1]) - v(t[0])).cross(v(t[2]) - v(t[0])).length() * 0.5;
            cum.push(total);
        }
        if tris.is_empty() || total <= 0.0 {
            return Shape::Point;
        }
        let mut rng = Rng::new(seed);
        let pts = (0..count)
            .map(|_| {
                let x = rng.f01() * total;
                let k = cum.partition_point(|&c| c < x).min(tris.len() - 1);
                let t = tris[k];
                let (mut a, mut b) = (rng.f01(), rng.f01());
                if a + b > 1.0 {
                    (a, b) = (1.0 - a, 1.0 - b);
                }
                v(t[0]) + (v(t[1]) - v(t[0])) * a + (v(t[2]) - v(t[0])) * b
            })
            .collect();
        Shape::Points(pts)
    }

    /// A point of the shape (effect space, unscaled).
    #[inline]
    pub fn sample(&self, rng: &mut Rng) -> Vec3A {
        match self {
            Shape::Point => Vec3A::ZERO,
            Shape::Sphere { radius, surface } => {
                if *surface {
                    rng.unit() * *radius
                } else {
                    rng.in_ball() * *radius
                }
            }
            Shape::Hemisphere { radius } => {
                let p = rng.in_ball() * *radius;
                Vec3A::new(p.x, p.y.abs(), p.z)
            }
            Shape::Cone { radius, .. } | Shape::Disc { radius } => {
                let r = radius * rng.f01().sqrt();
                let a = rng.f01() * core::f32::consts::TAU;
                Vec3A::new(r * a.cos(), 0.0, r * a.sin())
            }
            Shape::Ring { radius } => {
                let a = rng.f01() * core::f32::consts::TAU;
                Vec3A::new(radius * a.cos(), 0.0, radius * a.sin())
            }
            Shape::Box { half } => rng.in_cube() * Vec3A::from(*half),
            Shape::Line { half_length } => Vec3A::new(rng.range(-*half_length, *half_length), 0.0, 0.0),
            Shape::Points(p) => {
                if p.is_empty() {
                    Vec3A::ZERO
                } else {
                    Vec3A::from(p[(rng.next_u32() as usize) % p.len()])
                }
            }
        }
    }
}

/// Start velocity (effect space; rotated by the effect's rotation).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Velocity {
    None,
    /// Away from the shape centre (a random direction at the centre). With a `Cone` shape:
    /// within the cone's half-angle around +Y.
    Radial { speed: Range },
    /// Within `angle` radians of `dir`.
    Cone { dir: Vec3, angle: f32, speed: Range },
    /// `v` plus a random offset in `[-jitter, jitter]` per axis.
    Fixed { v: Vec3, jitter: Vec3 },
}

/// Divergence-free swirl ("curl noise"): `strength` m/s², `frequency` 1/m, `speed` how fast the
/// field drifts.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Turbulence {
    pub strength: f32,
    pub frequency: f32,
    pub speed: f32,
}

impl Default for Turbulence {
    fn default() -> Self {
        Turbulence { strength: 1.0, frequency: 0.5, speed: 0.5 }
    }
}

/// Point attractor at `offset` (effect space): acceleration `strength` m/s² near it, falling off
/// with the square of the distance beyond `radius`; negative repels. Particles closer than
/// `kill_radius` die.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Attractor {
    pub offset: Vec3,
    pub strength: f32,
    pub radius: f32,
    pub kill_radius: f32,
}

impl Default for Attractor {
    fn default() -> Self {
        Attractor { offset: Vec3::ZERO, strength: 5.0, radius: 1.0, kill_radius: 0.0 }
    }
}

/// Particles circle `axis` (through the effect origin) at `speed` rad/s, pushed outward by
/// `radial` m/s² (negative pulls in).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Orbit {
    pub axis: Vec3,
    pub speed: f32,
    pub radial: f32,
}

impl Default for Orbit {
    fn default() -> Self {
        Orbit { axis: Vec3::Y, speed: 1.0, radial: 0.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Collision {
    None,
    /// Horizontal plane at world `height`.
    Plane { height: f32, restitution: f32, friction: f32, die: bool },
    /// Raycasts against avian colliders (feature `physics`; `VfxBudget::collision_rays` per frame).
    Physics { restitution: f32, friction: f32, die: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Trigger {
    Spawn,
    Death,
    Collision,
}

/// When a particle of this emitter hits `on`, spawn `count` particles of the emitter named
/// `emitter` there (it must come later in the effect's list).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SubEmitter {
    pub on: Trigger,
    pub emitter: String,
    pub count: u32,
    /// Fraction of the dying/spawning particle's velocity the new particles get.
    pub inherit_velocity: f32,
    /// Probability per trigger (0..1).
    pub chance: f32,
}

impl Default for SubEmitter {
    fn default() -> Self {
        SubEmitter { on: Trigger::Death, emitter: String::new(), count: 1, inherit_velocity: 0.0, chance: 1.0 }
    }
}

/// How an emitter is drawn. Every emitter is one draw call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RenderDef {
    pub mode: RenderMode,
    pub texture: VfxTexture,
    pub blend: Blend,
    /// HDR multiplier on the colour (values > 1 bloom).
    pub intensity: f32,
    /// 0 = unlit, 1 = lit by the scene's directional lights + ambient (wrap-diffuse).
    pub lit: f32,
    /// Soft-particle fade distance in metres against the depth prepass (0 = off; free when
    /// the camera has a depth prepass, e.g. with SSAO, otherwise ignored).
    pub soft: f32,
    pub flipbook: Option<Flipbook>,
    /// Back-to-front sort within the emitter (alpha-blended emitters with overlap).
    pub sort: bool,
}

impl Default for RenderDef {
    fn default() -> Self {
        RenderDef { mode: RenderMode::Billboard, texture: VfxTexture::Dot, blend: Blend::Additive, intensity: 1.0, lit: 0.0, soft: 0.0, flipbook: None, sort: false }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum RenderMode {
    /// Camera-facing quads (expanded on the GPU).
    Billboard,
    /// Quads lying flat in the plane perpendicular to `normal` (world; shockwave rings on the
    /// ground, ripples), rotated by the particle's rotation.
    Flat { normal: Vec3 },
    /// Quads stretched along the velocity: length = size + speed·`factor`.
    Stretched { factor: f32 },
    /// A ribbon through the particle's last `points` positions (recorded every `interval`
    /// seconds); width = size × `taper` sampled from head (0) to tail (1).
    Trail { points: u8, interval: f32, taper: Curve },
    /// Lit mesh copies (`MeshShape`), tumbling with `spin`.
    Mesh { shape: MeshShape },
    /// Simulated but not drawn (carriers for sub-emitters).
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MeshShape {
    Cube,
    Tetra,
    Shard,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Blend {
    /// Classic alpha blending.
    Alpha,
    /// Adds light (fire, sparks, magic); order-independent.
    Additive,
    /// `0` = alpha … `1` = additive (premultiplied "alpha-add").
    Mix(f32),
}

impl Blend {
    pub fn additive_amount(self) -> f32 {
        match self {
            Blend::Alpha => 0.0,
            Blend::Additive => 1.0,
            Blend::Mix(f) => f.clamp(0.0, 1.0),
        }
    }
}

/// Built-in procedural textures (generated at startup, no image files).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum VfxTexture {
    /// Soft round dot.
    Dot,
    /// Hot core with a long falloff (sparks, embers).
    Spark,
    /// 4×4 flipbook of noisy puffs (smoke, dust, fire with a warm gradient).
    Smoke,
    /// Star flare with rays (muzzle flash, magic).
    Flare,
    /// Thin ring (shockwaves).
    Ring,
    /// Plain white (no texture).
    White,
}

/// Texture-sheet animation: `cols × rows` frames, played over the particle's life
/// (`fps == 0`) or at `fps`; frames crossfade when `blend`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Flipbook {
    pub cols: u8,
    pub rows: u8,
    pub fps: f32,
    pub random_start: bool,
    pub blend: bool,
}

impl Default for Flipbook {
    fn default() -> Self {
        Flipbook { cols: 4, rows: 4, fps: 0.0, random_start: false, blend: true }
    }
}

impl Flipbook {
    pub fn frames(&self) -> u32 {
        (self.cols.max(1) as u32) * (self.rows.max(1) as u32)
    }
}
