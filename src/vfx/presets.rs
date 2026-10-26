//! Ready-made effects, registered in [`super::VfxLibrary`] by name. Each is an ordinary
//! [`EffectDef`] built in code: copy one and change it, or read it over the control port
//! (`vfx.get {preset}`) and send a modified one back (`vfx.define`).
//!
//! Effects face -Z (Bevy's forward) where they have a direction (muzzle flash) and +Y otherwise.

use bevy::math::Vec3;

use super::curve::{Curve, Gradient};
use super::def::*;

/// Every preset: `(name, constructor)`.
pub const PRESETS: &[(&str, fn() -> EffectDef)] = &[
    ("sparks", sparks),
    ("smoke", smoke),
    ("fire", fire),
    ("muzzle_flash", muzzle_flash),
    ("explosion", explosion),
    ("dust_puff", dust_puff),
    ("magic", magic),
    ("rain", rain),
    ("snow", snow),
    ("stress", || stress(10_000)),
];

const G: Vec3 = Vec3::new(0.0, -9.81, 0.0);

fn hot_gradient() -> Gradient {
    Gradient::srgb(&[(0.0, [1.0, 0.95, 0.8], 1.0), (0.25, [1.0, 0.65, 0.2], 1.0), (0.7, [0.9, 0.25, 0.05], 0.8), (1.0, [0.4, 0.08, 0.02], 0.0)])
}

fn fade(rgb: [f32; 3], peak: f32, rise: f32) -> Gradient {
    Gradient::srgb(&[(0.0, rgb, 0.0), (rise, rgb, peak), (1.0, rgb, 0.0)])
}

fn smoke_book() -> Option<Flipbook> {
    Some(Flipbook { random_start: true, ..Default::default() })
}

/// Grinder / welding sparks: stretched, bouncing on the ground (y = 0), with a glow at the source.
pub fn sparks() -> EffectDef {
    EffectDef {
        light: Some(EffectLight { color: [1.0, 0.55, 0.2], intensity: 30_000.0, range: 3.0, offset: Vec3::new(0.0, 0.2, 0.0), flicker: 0.6, ..Default::default() }),
        ..EffectDef::new("sparks")
    }
        .with(EmitterDef {
            name: "sparks".into(),
            capacity: 512,
            rate: 90.0,
            lifetime: (0.4, 1.1),
            velocity: Velocity::Cone { dir: Vec3::Y, angle: 0.7, speed: (3.5, 8.0) },
            gravity: G,
            drag: 0.4,
            size: (0.025, 0.045),
            color_over_life: hot_gradient(),
            render: RenderDef { mode: RenderMode::Stretched { factor: 0.035 }, texture: VfxTexture::Spark, intensity: 8.0, ..Default::default() },
            collision: Collision::Plane { height: 0.0, restitution: 0.35, friction: 0.3, die: false },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "glow".into(),
            capacity: 32,
            rate: 25.0,
            lifetime: (0.08, 0.16),
            size: (0.35, 0.55),
            color_over_life: fade([1.0, 0.6, 0.25], 0.6, 0.2),
            render: RenderDef { intensity: 3.0, ..Default::default() },
            ..Default::default()
        })
}

/// A lit, soft, sorted smoke column.
pub fn smoke() -> EffectDef {
    EffectDef::new("smoke").with(EmitterDef {
        name: "smoke".into(),
        capacity: 160,
        rate: 14.0,
        lifetime: (3.0, 5.0),
        shape: Shape::Disc { radius: 0.4 },
        velocity: Velocity::Fixed { v: Vec3::new(0.0, 1.1, 0.0), jitter: Vec3::new(0.3, 0.2, 0.3) },
        gravity: Vec3::new(0.15, 0.2, 0.0),
        drag: 0.3,
        turbulence: Some(Turbulence { strength: 0.6, frequency: 0.6, speed: 0.3 }),
        size: (0.8, 1.2),
        size_over_life: Curve::linear(0.6, 3.0),
        color_over_life: Gradient::srgb(&[(0.0, [0.45, 0.45, 0.47], 0.0), (0.15, [0.5, 0.5, 0.52], 0.6), (1.0, [0.6, 0.6, 0.62], 0.0)]),
        rotation: (0.0, core::f32::consts::TAU),
        spin: (-0.3, 0.3),
        render: RenderDef { texture: VfxTexture::Smoke, blend: Blend::Alpha, lit: 0.85, soft: 0.6, flipbook: smoke_book(), sort: true, ..Default::default() },
        ..Default::default()
    })
}

/// Campfire: crossfading flame flipbook, embers, smoke on top.
pub fn fire() -> EffectDef {
    EffectDef {
        light: Some(EffectLight { color: [1.0, 0.45, 0.12], intensity: 120_000.0, range: 7.0, offset: Vec3::new(0.0, 0.6, 0.0), flicker: 0.35, ..Default::default() }),
        ..EffectDef::new("fire")
    }
        .with(EmitterDef {
            name: "flames".into(),
            capacity: 128,
            rate: 42.0,
            lifetime: (0.55, 0.95),
            shape: Shape::Disc { radius: 0.35 },
            velocity: Velocity::Fixed { v: Vec3::new(0.0, 1.6, 0.0), jitter: Vec3::new(0.25, 0.4, 0.25) },
            gravity: Vec3::new(0.0, 1.6, 0.0),
            drag: 0.6,
            turbulence: Some(Turbulence { strength: 1.6, frequency: 1.3, speed: 1.2 }),
            size: (0.5, 0.8),
            size_over_life: Curve::keys(&[(0.0, 0.6), (0.3, 1.0), (1.0, 0.25)]),
            color_over_life: hot_gradient(),
            rotation: (0.0, core::f32::consts::TAU),
            spin: (-1.0, 1.0),
            render: RenderDef { texture: VfxTexture::Smoke, blend: Blend::Mix(0.85), intensity: 3.5, soft: 0.3, flipbook: smoke_book(), ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "embers".into(),
            capacity: 64,
            rate: 9.0,
            lifetime: (1.0, 2.2),
            shape: Shape::Disc { radius: 0.3 },
            velocity: Velocity::Fixed { v: Vec3::new(0.0, 1.5, 0.0), jitter: Vec3::new(0.4, 0.6, 0.4) },
            gravity: Vec3::new(0.0, 0.6, 0.0),
            drag: 0.4,
            turbulence: Some(Turbulence { strength: 2.5, frequency: 0.9, speed: 0.8 }),
            size: (0.025, 0.045),
            color_over_life: hot_gradient(),
            render: RenderDef { texture: VfxTexture::Spark, intensity: 10.0, ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "smoke".into(),
            capacity: 48,
            rate: 5.0,
            lifetime: (2.5, 3.5),
            offset: Vec3::new(0.0, 1.1, 0.0),
            shape: Shape::Disc { radius: 0.25 },
            velocity: Velocity::Fixed { v: Vec3::new(0.0, 1.0, 0.0), jitter: Vec3::new(0.2, 0.2, 0.2) },
            drag: 0.2,
            turbulence: Some(Turbulence { strength: 0.5, frequency: 0.5, speed: 0.3 }),
            size: (0.6, 0.9),
            size_over_life: Curve::linear(0.8, 2.5),
            color_over_life: Gradient::srgb(&[(0.0, [0.2, 0.18, 0.17], 0.0), (0.2, [0.25, 0.24, 0.24], 0.35), (1.0, [0.4, 0.4, 0.4], 0.0)]),
            rotation: (0.0, core::f32::consts::TAU),
            render: RenderDef { texture: VfxTexture::Smoke, blend: Blend::Alpha, lit: 0.7, soft: 0.5, flipbook: smoke_book(), sort: true, ..Default::default() },
            ..Default::default()
        })
}

/// One-shot gun muzzle flash along -Z: flare, flame cone, sparks, a wisp of smoke.
pub fn muzzle_flash() -> EffectDef {
    let fwd = Vec3::NEG_Z;
    EffectDef {
        cull_distance: 120.0,
        light: Some(EffectLight { color: [1.0, 0.7, 0.35], intensity: 250_000.0, range: 6.0, duration: 0.06, over_time: Curve::linear(1.0, 0.0), ..Default::default() }),
        ..EffectDef::new("muzzle_flash")
    }
        .once(0.02)
        .with(EmitterDef {
            name: "flare".into(),
            capacity: 2,
            bursts: vec![Burst::at(0.0, 1)],
            lifetime: (0.05, 0.07),
            size: (0.45, 0.6),
            size_over_life: Curve::linear(1.0, 0.6),
            color_over_life: Gradient::srgb(&[(0.0, [1.0, 0.9, 0.7], 1.0), (1.0, [1.0, 0.6, 0.2], 0.0)]),
            rotation: (0.0, core::f32::consts::TAU),
            render: RenderDef { texture: VfxTexture::Flare, intensity: 12.0, ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "flame".into(),
            capacity: 16,
            bursts: vec![Burst::at(0.0, 7)],
            lifetime: (0.04, 0.08),
            velocity: Velocity::Cone { dir: fwd, angle: 0.18, speed: (6.0, 12.0) },
            size: (0.1, 0.16),
            color_over_life: hot_gradient(),
            render: RenderDef { mode: RenderMode::Stretched { factor: 0.03 }, texture: VfxTexture::Dot, intensity: 8.0, ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "sparks".into(),
            capacity: 16,
            bursts: vec![Burst::at(0.0, 8)],
            lifetime: (0.1, 0.25),
            velocity: Velocity::Cone { dir: fwd, angle: 0.45, speed: (10.0, 22.0) },
            gravity: G,
            size: (0.015, 0.025),
            color_over_life: hot_gradient(),
            render: RenderDef { mode: RenderMode::Stretched { factor: 0.02 }, texture: VfxTexture::Spark, intensity: 10.0, ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "smoke".into(),
            capacity: 8,
            bursts: vec![Burst::at(0.0, 3)],
            lifetime: (0.6, 1.0),
            velocity: Velocity::Cone { dir: fwd, angle: 0.3, speed: (0.8, 1.6) },
            gravity: Vec3::new(0.0, 0.3, 0.0),
            drag: 2.0,
            size: (0.15, 0.25),
            size_over_life: Curve::linear(0.8, 3.0),
            color_over_life: fade([0.6, 0.6, 0.6], 0.3, 0.1),
            rotation: (0.0, core::f32::consts::TAU),
            render: RenderDef { texture: VfxTexture::Smoke, blend: Blend::Alpha, lit: 0.6, flipbook: smoke_book(), ..Default::default() },
            ..Default::default()
        })
}

/// One-shot explosion: flash, fireball, shockwave ring, trailing streaks that pop on death
/// (sub-emitter), tumbling lit debris bouncing on y = 0, lingering lit smoke.
pub fn explosion() -> EffectDef {
    EffectDef {
        light: Some(EffectLight {
            color: [1.0, 0.55, 0.2],
            intensity: 2_500_000.0,
            range: 20.0,
            offset: Vec3::new(0.0, 1.0, 0.0),
            duration: 0.8,
            over_time: Curve::keys(&[(0.0, 1.0), (0.15, 0.55), (1.0, 0.0)]),
            flicker: 0.2,
        }),
        ..EffectDef::new("explosion")
    }
        .once(0.1)
        .with(EmitterDef {
            name: "flash".into(),
            capacity: 2,
            bursts: vec![Burst::at(0.0, 1)],
            lifetime: (0.14, 0.14),
            size: (4.5, 4.5),
            size_over_life: Curve::linear(0.6, 1.2),
            color_over_life: Gradient::srgb(&[(0.0, [1.0, 0.9, 0.7], 1.0), (1.0, [1.0, 0.5, 0.2], 0.0)]),
            render: RenderDef { texture: VfxTexture::Flare, intensity: 10.0, ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "fireball".into(),
            capacity: 40,
            bursts: vec![Burst::at(0.0, 32)],
            lifetime: (0.6, 1.1),
            shape: Shape::Hemisphere { radius: 0.8 },
            velocity: Velocity::Radial { speed: (3.0, 8.0) },
            gravity: Vec3::new(0.0, 2.0, 0.0),
            drag: 3.0,
            size: (1.6, 2.6),
            size_over_life: Curve::keys(&[(0.0, 0.5), (0.3, 1.2), (1.0, 1.6)]),
            color_over_life: hot_gradient(),
            rotation: (0.0, core::f32::consts::TAU),
            spin: (-1.5, 1.5),
            render: RenderDef { texture: VfxTexture::Smoke, blend: Blend::Mix(0.75), intensity: 4.0, soft: 0.5, flipbook: smoke_book(), ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "shockwave".into(),
            capacity: 2,
            bursts: vec![Burst::at(0.0, 1)],
            lifetime: (0.5, 0.5),
            offset: Vec3::new(0.0, 0.05, 0.0),
            size: (11.0, 11.0),
            size_over_life: Curve::keys(&[(0.0, 0.05), (1.0, 1.0)]),
            color_over_life: Gradient::srgb(&[(0.0, [1.0, 0.85, 0.6], 0.9), (1.0, [1.0, 0.7, 0.4], 0.0)]),
            render: RenderDef { mode: RenderMode::Flat { normal: Vec3::Y }, texture: VfxTexture::Ring, intensity: 4.0, ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "streaks".into(),
            capacity: 32,
            bursts: vec![Burst::at(0.0, 14)],
            lifetime: (0.7, 1.3),
            shape: Shape::Sphere { radius: 0.3, surface: false },
            velocity: Velocity::Cone { dir: Vec3::Y, angle: 1.3, speed: (8.0, 15.0) },
            gravity: G,
            drag: 0.8,
            size: (0.12, 0.16),
            color_over_life: hot_gradient(),
            render: RenderDef {
                mode: RenderMode::Trail { points: 14, interval: 1.0 / 60.0, taper: Curve::linear(1.0, 0.0) },
                texture: VfxTexture::Dot,
                intensity: 6.0,
                ..Default::default()
            },
            sub_emitters: vec![SubEmitter { on: Trigger::Death, emitter: "pops".into(), count: 4, inherit_velocity: 0.2, chance: 1.0 }],
            ..Default::default()
        })
        .with(EmitterDef {
            name: "debris".into(),
            capacity: 24,
            bursts: vec![Burst::at(0.0, 12)],
            lifetime: (2.5, 3.5),
            shape: Shape::Hemisphere { radius: 0.5 },
            velocity: Velocity::Cone { dir: Vec3::Y, angle: 0.9, speed: (4.0, 9.0) },
            gravity: G,
            drag: 0.2,
            size: (0.15, 0.35),
            size_over_life: Curve::keys(&[(0.0, 1.0), (0.85, 1.0), (1.0, 0.0)]),
            color_over_life: Gradient::srgb(&[(0.0, [0.25, 0.22, 0.2], 1.0)]),
            rotation: (0.0, core::f32::consts::TAU),
            spin: (-9.0, 9.0),
            render: RenderDef { mode: RenderMode::Mesh { shape: MeshShape::Shard }, lit: 1.0, ..Default::default() },
            collision: Collision::Plane { height: 0.0, restitution: 0.3, friction: 0.5, die: false },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "smoke".into(),
            capacity: 32,
            bursts: vec![Burst::at(0.05, 16)],
            lifetime: (2.5, 4.0),
            shape: Shape::Hemisphere { radius: 1.0 },
            velocity: Velocity::Radial { speed: (0.5, 2.0) },
            gravity: Vec3::new(0.0, 0.7, 0.0),
            drag: 1.0,
            turbulence: Some(Turbulence { strength: 0.4, frequency: 0.4, speed: 0.3 }),
            size: (2.0, 3.0),
            size_over_life: Curve::linear(0.8, 2.2),
            color_over_life: Gradient::srgb(&[(0.0, [0.15, 0.13, 0.12], 0.0), (0.1, [0.22, 0.2, 0.19], 0.85), (0.6, [0.35, 0.34, 0.33], 0.5), (1.0, [0.45, 0.45, 0.45], 0.0)]),
            rotation: (0.0, core::f32::consts::TAU),
            spin: (-0.4, 0.4),
            render: RenderDef { texture: VfxTexture::Smoke, blend: Blend::Alpha, lit: 0.9, soft: 0.8, flipbook: smoke_book(), sort: true, ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "pops".into(),
            capacity: 128,
            lifetime: (0.15, 0.3),
            velocity: Velocity::Radial { speed: (1.0, 3.0) },
            size: (0.04, 0.08),
            color_over_life: hot_gradient(),
            render: RenderDef { texture: VfxTexture::Spark, intensity: 8.0, ..Default::default() },
            ..Default::default()
        })
}

/// One-shot dust puff (footsteps, landings, bullet hits on dirt).
pub fn dust_puff() -> EffectDef {
    EffectDef::new("dust_puff").once(0.05).with(EmitterDef {
        name: "dust".into(),
        capacity: 32,
        bursts: vec![Burst::at(0.0, 16)],
        lifetime: (0.8, 1.5),
        shape: Shape::Disc { radius: 0.25 },
        velocity: Velocity::Radial { speed: (1.0, 3.0) },
        gravity: Vec3::new(0.0, 0.3, 0.0),
        drag: 2.5,
        size: (0.35, 0.6),
        size_over_life: Curve::linear(0.6, 2.4),
        color_over_life: Gradient::srgb(&[(0.0, [0.62, 0.55, 0.45], 0.6), (1.0, [0.7, 0.64, 0.55], 0.0)]),
        rotation: (0.0, core::f32::consts::TAU),
        spin: (-0.8, 0.8),
        render: RenderDef { texture: VfxTexture::Smoke, blend: Blend::Alpha, lit: 1.0, soft: 0.3, flipbook: smoke_book(), sort: true, ..Default::default() },
        ..Default::default()
    })
}

/// Magic orb: orbiting ribbon wisps, motes sucked into the core (attractor), and sparkles left
/// behind when the effect moves (rate per metre).
pub fn magic() -> EffectDef {
    let tint = Gradient::srgb(&[(0.0, [0.3, 0.8, 1.0], 1.0), (1.0, [0.75, 0.35, 1.0], 1.0)]);
    EffectDef {
        light: Some(EffectLight { color: [0.45, 0.4, 1.0], intensity: 50_000.0, range: 5.0, flicker: 0.15, ..Default::default() }),
        ..EffectDef::new("magic")
    }
    .with(EmitterDef {
            name: "core".into(),
            capacity: 32,
            rate: 30.0,
            lifetime: (0.25, 0.4),
            size: (0.5, 0.7),
            color_over_life: fade([0.6, 0.6, 1.0], 0.8, 0.3),
            start_tint: tint.clone(),
            rotation: (0.0, core::f32::consts::TAU),
            render: RenderDef { texture: VfxTexture::Flare, intensity: 4.0, ..Default::default() },
            ..Default::default()
        })
        .with(EmitterDef {
            name: "wisps".into(),
            capacity: 48,
            rate: 14.0,
            lifetime: (1.0, 1.6),
            shape: Shape::Sphere { radius: 0.8, surface: true },
            velocity: Velocity::Fixed { v: Vec3::new(0.0, 0.5, 0.0), jitter: Vec3::splat(0.3) },
            orbit: Some(Orbit { axis: Vec3::Y, speed: 3.5, radial: -0.6 }),
            turbulence: Some(Turbulence { strength: 1.0, frequency: 1.0, speed: 1.0 }),
            size: (0.06, 0.1),
            color_over_life: fade([1.0, 1.0, 1.0], 1.0, 0.15),
            start_tint: tint.clone(),
            render: RenderDef {
                mode: RenderMode::Trail { points: 24, interval: 1.0 / 60.0, taper: Curve::linear(1.0, 0.0) },
                intensity: 5.0,
                ..Default::default()
            },
            local_space: true,
            ..Default::default()
        })
        .with(EmitterDef {
            name: "motes".into(),
            capacity: 128,
            rate: 50.0,
            lifetime: (1.2, 1.8),
            shape: Shape::Sphere { radius: 1.4, surface: true },
            attractors: vec![Attractor { offset: Vec3::ZERO, strength: 4.0, radius: 0.4, kill_radius: 0.12 }],
            drag: 0.8,
            size: (0.03, 0.05),
            color_over_life: fade([1.0, 1.0, 1.0], 1.0, 0.3),
            start_tint: tint.clone(),
            render: RenderDef { texture: VfxTexture::Spark, intensity: 6.0, ..Default::default() },
            local_space: true,
            ..Default::default()
        })
        .with(EmitterDef {
            name: "trail".into(),
            capacity: 256,
            rate_per_meter: 25.0,
            lifetime: (0.5, 0.9),
            shape: Shape::Sphere { radius: 0.15, surface: false },
            gravity: Vec3::new(0.0, -0.6, 0.0),
            turbulence: Some(Turbulence { strength: 1.2, frequency: 1.5, speed: 1.0 }),
            size: (0.04, 0.08),
            size_over_life: Curve::linear(1.0, 0.0),
            start_tint: tint,
            render: RenderDef { texture: VfxTexture::Spark, intensity: 6.0, ..Default::default() },
            ..Default::default()
        })
}

/// Camera-local rain: stretched drops over 36×36 m that die on y = 0 with splashes.
pub fn rain() -> EffectDef {
    EffectDef { follow_camera: true, cull_distance: f32::MAX, ..EffectDef::new("rain") }
        .with(EmitterDef {
            name: "drops".into(),
            capacity: 6000,
            rate: 3500.0,
            lifetime: (1.4, 1.6),
            shape: Shape::Box { half: Vec3::new(18.0, 0.5, 18.0) },
            offset: Vec3::new(0.0, 12.0, 0.0),
            velocity: Velocity::Fixed { v: Vec3::new(0.6, -14.0, 0.0), jitter: Vec3::new(0.1, 1.0, 0.1) },
            size: (0.016, 0.024),
            color_over_life: Gradient::srgb(&[(0.0, [0.75, 0.82, 0.9], 0.55)]),
            render: RenderDef { mode: RenderMode::Stretched { factor: 0.035 }, texture: VfxTexture::Spark, blend: Blend::Mix(0.5), intensity: 1.6, ..Default::default() },
            collision: Collision::Plane { height: 0.0, restitution: 0.0, friction: 0.0, die: true },
            sub_emitters: vec![SubEmitter { on: Trigger::Collision, emitter: "splash".into(), count: 2, inherit_velocity: 0.0, chance: 0.25 }],
            ..Default::default()
        })
        .with(EmitterDef {
            name: "splash".into(),
            capacity: 2000,
            lifetime: (0.15, 0.3),
            velocity: Velocity::Cone { dir: Vec3::Y, angle: 0.8, speed: (0.8, 1.8) },
            gravity: G,
            size: (0.012, 0.02),
            color_over_life: Gradient::srgb(&[(0.0, [0.8, 0.85, 0.92], 0.5), (1.0, [0.8, 0.85, 0.92], 0.0)]),
            render: RenderDef { blend: Blend::Mix(0.5), ..Default::default() },
            ..Default::default()
        })
}

/// Camera-local snow drifting in a curl field, settling on y = 0.
pub fn snow() -> EffectDef {
    EffectDef { follow_camera: true, cull_distance: f32::MAX, ..EffectDef::new("snow") }.with(EmitterDef {
        name: "flakes".into(),
        capacity: 4000,
        rate: 450.0,
        lifetime: (7.0, 8.0),
        shape: Shape::Box { half: Vec3::new(16.0, 0.5, 16.0) },
        offset: Vec3::new(0.0, 8.0, 0.0),
        velocity: Velocity::Fixed { v: Vec3::new(0.2, -1.1, 0.0), jitter: Vec3::splat(0.3) },
        turbulence: Some(Turbulence { strength: 0.9, frequency: 0.45, speed: 0.4 }),
        drag: 0.5,
        gravity: Vec3::new(0.0, -0.4, 0.0),
        size: (0.03, 0.06),
        size_over_life: Curve::keys(&[(0.0, 1.0), (0.9, 1.0), (1.0, 0.0)]),
        color_over_life: Gradient::srgb(&[(0.0, [0.95, 0.97, 1.0], 0.0), (0.05, [0.95, 0.97, 1.0], 0.9)]),
        render: RenderDef { blend: Blend::Mix(0.2), intensity: 1.2, ..Default::default() },
        collision: Collision::Plane { height: 0.02, restitution: 0.0, friction: 1.0, die: false },
        ..Default::default()
    })
}

/// Benchmark load: `count` small additive dots alive at steady state in a 5 m ball.
pub fn stress(count: u32) -> EffectDef {
    EffectDef { cull_distance: f32::MAX, ..EffectDef::new("stress") }.with(EmitterDef {
        name: "dots".into(),
        capacity: count.max(1),
        rate: count as f32 / 2.0,
        lifetime: (1.9, 2.0),
        shape: Shape::Sphere { radius: 5.0, surface: false },
        velocity: Velocity::Radial { speed: (0.2, 1.0) },
        gravity: Vec3::new(0.0, -0.5, 0.0),
        size: (0.05, 0.08),
        color_over_life: Gradient::srgb(&[(0.0, [0.4, 0.8, 1.0], 0.0), (0.2, [0.4, 0.8, 1.0], 0.8), (1.0, [1.0, 0.4, 0.8], 0.0)]),
        render: RenderDef { intensity: 2.0, ..Default::default() },
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::super::sim::CompiledEffect;
    use super::*;

    #[test]
    fn effect_lights_fade_and_flicker() {
        let l = explosion().light.unwrap();
        let (a, b, c) = (l.intensity_at(0.0, 1), l.intensity_at(0.4, 1), l.intensity_at(0.9, 1));
        assert!(a > b && b > 0.0 && c == 0.0, "{a} {b} {c}");
        let fire = fire().light.unwrap();
        let v: Vec<f32> = (0..20).map(|i| fire.intensity_at(i as f32 * 0.05, 3)).collect();
        assert!(v.iter().all(|x| *x > 0.0));
        assert!(v.windows(2).any(|w| (w[0] - w[1]).abs() > 1.0), "flickers");
    }

    #[test]
    fn every_preset_compiles_and_round_trips_json() {
        for (name, f) in PRESETS {
            let def = f();
            assert_eq!(def.name, *name);
            CompiledEffect::new(def.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            let json = serde_json::to_string(&def).unwrap();
            let back: EffectDef = serde_json::from_str(&json).unwrap();
            assert_eq!(back, def, "{name}");
        }
    }
}
