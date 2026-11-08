//! The spray effect definitions (`spray_dust`, `spray_sand`, `spray_mud`, ...), coloured by a [`SprayPalette`].

use std::f32::consts::TAU;

use bevy::prelude::*;

use super::SprayKind;
use crate::vfx::{Blend, Curve, EffectDef, EmitterDef, Flipbook, Gradient, MeshShape, RenderDef, RenderMode, Shape, Velocity, VfxTexture};

/// Colours (sRGB) of each kind of spray: the soil of the map, as data.
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct SprayPalette {
    pub dust: [f32; 3],
    pub sand: [f32; 3],
    pub mud: [f32; 3],
    pub snow: [f32; 3],
    pub smoke: [f32; 3],
    pub water: [f32; 3],
    pub chips: [f32; 3],
    /// Dust opacity (lower it in the rain).
    pub dust_alpha: f32,
}

impl Default for SprayPalette {
    fn default() -> Self {
        SprayPalette {
            dust: [0.6, 0.53, 0.43],
            sand: [0.82, 0.7, 0.48],
            mud: [0.2, 0.15, 0.1],
            snow: [0.93, 0.95, 1.0],
            smoke: [0.75, 0.75, 0.76],
            water: [0.8, 0.83, 0.86],
            chips: [0.42, 0.37, 0.32],
            dust_alpha: 0.32,
        }
    }
}

/// An alpha-blended soft puff that billows up and grows.
fn puff(name: &str, color: [f32; 3], alpha: f32, size: (f32, f32), grow: f32, life: (f32, f32), cap: u32) -> EffectDef {
    EffectDef { cull_distance: 160.0, ..EffectDef::new(name) }.with(EmitterDef {
        name: "puff".into(),
        capacity: cap,
        rate: 28.0,
        lifetime: life,
        shape: Shape::Sphere { radius: 0.15, surface: false },
        velocity: Velocity::Cone { dir: Vec3::Y, angle: 1.0, speed: (0.6, 2.0) },
        gravity: Vec3::new(0.0, 0.25, 0.0),
        drag: 1.6,
        size,
        size_over_life: Curve::linear(0.7, grow),
        color_over_life: Gradient::srgb(&[(0.0, color, 0.0), (0.08, color, alpha), (1.0, color, 0.0)]),
        rotation: (0.0, TAU),
        spin: (-0.5, 0.5),
        render: RenderDef { texture: VfxTexture::Smoke, blend: Blend::Alpha, lit: 0.9, soft: 0.6, flipbook: Some(Flipbook { random_start: true, ..default() }), sort: true, ..default() },
        ..default()
    })
}

/// Every spray effect for `p`, named by [`SprayKind::effect`].
pub fn defs(p: &SprayPalette) -> Vec<EffectDef> {
    vec![
        puff(SprayKind::Dust.effect(), p.dust, p.dust_alpha, (0.6, 1.0), 4.5, (1.6, 2.8), 160),
        puff(SprayKind::Sand.effect(), p.sand, p.dust_alpha * 1.1, (0.5, 0.9), 4.0, (1.2, 2.2), 160),
        puff(SprayKind::Snow.effect(), p.snow, 0.45, (0.4, 0.8), 3.5, (0.8, 1.6), 120),
        puff(SprayKind::Smoke.effect(), p.smoke, 0.22, (0.5, 0.8), 4.0, (1.2, 2.0), 80),
        // A fine mist thrown back and up, short-lived, fast.
        EffectDef { cull_distance: 140.0, ..EffectDef::new(SprayKind::Water.effect()) }.with(EmitterDef {
            name: "mist".into(),
            capacity: 140,
            rate: 45.0,
            lifetime: (0.5, 0.9),
            shape: Shape::Sphere { radius: 0.18, surface: false },
            velocity: Velocity::Cone { dir: Vec3::new(0.0, 0.6, 0.0), angle: 0.9, speed: (1.5, 3.5) },
            gravity: Vec3::new(0.0, -2.0, 0.0),
            drag: 2.2,
            size: (0.35, 0.6),
            size_over_life: Curve::linear(0.6, 3.0),
            color_over_life: Gradient::srgb(&[(0.0, p.water, 0.0), (0.1, p.water, 0.28), (1.0, p.water, 0.0)]),
            rotation: (0.0, TAU),
            render: RenderDef { texture: VfxTexture::Smoke, blend: Blend::Alpha, lit: 0.8, soft: 0.6, flipbook: Some(Flipbook { random_start: true, ..default() }), sort: true, ..default() },
            ..default()
        }),
        // Flying stones: lit mesh chips.
        EffectDef { cull_distance: 120.0, ..EffectDef::new(SprayKind::Chips.effect()) }.with(EmitterDef {
            name: "chips".into(),
            capacity: 120,
            rate: 60.0,
            lifetime: (0.5, 0.9),
            shape: Shape::Sphere { radius: 0.1, surface: false },
            velocity: Velocity::Cone { dir: Vec3::new(0.0, 0.7, 0.0), angle: 0.9, speed: (2.0, 5.0) },
            gravity: Vec3::new(0.0, -9.81, 0.0),
            size: (0.025, 0.05),
            color_over_life: Gradient::srgb(&[(0.0, p.chips, 1.0)]),
            spin: (-12.0, 12.0),
            render: RenderDef { mode: RenderMode::Mesh { shape: MeshShape::Shard }, ..default() },
            ..default()
        }),
        // Mud clods: dark stretched dots.
        EffectDef { cull_distance: 120.0, ..EffectDef::new(SprayKind::Mud.effect()) }.with(EmitterDef {
            name: "clods".into(),
            capacity: 160,
            rate: 70.0,
            lifetime: (0.5, 0.9),
            shape: Shape::Sphere { radius: 0.12, surface: false },
            velocity: Velocity::Cone { dir: Vec3::new(0.0, 0.8, 0.0), angle: 0.8, speed: (2.0, 5.5) },
            gravity: Vec3::new(0.0, -9.81, 0.0),
            size: (0.05, 0.11),
            color_over_life: Gradient::srgb(&[(0.0, p.mud, 1.0)]),
            render: RenderDef { mode: RenderMode::Stretched { factor: 0.02 }, texture: VfxTexture::Dot, blend: Blend::Alpha, lit: 1.0, ..default() },
            ..default()
        }),
    ]
}
