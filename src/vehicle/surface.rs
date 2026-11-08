//! Surfaces: grip, rolling resistance and drag per ground type, looked up per wheel through a
//! [`SurfaceMap`] the game provides (a physics-material tag, a terrain layer, a splat map ...).

use bevy::prelude::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Reflect)]
pub struct SurfaceId(pub u8);

impl SurfaceId {
    pub const ASPHALT: SurfaceId = SurfaceId(0);
    pub const GRAVEL: SurfaceId = SurfaceId(1);
    pub const DIRT: SurfaceId = SurfaceId(2);
    pub const SAND: SurfaceId = SurfaceId(3);
    pub const MUD: SurfaceId = SurfaceId(4);
    pub const SNOW: SurfaceId = SurfaceId(5);
    pub const ICE: SurfaceId = SurfaceId(6);
}

#[derive(Clone, Debug)]
pub struct Surface {
    pub name: String,
    /// Friction multiplier (1 = the tyre's reference).
    pub grip: f32,
    /// Rolling resistance multiplier.
    pub rolling: f32,
    /// Sink drag per wheel, N per m/s (mud, deep sand).
    pub drag: f32,
    /// 0 hard .. 1 soft: how much a lower tyre pressure helps (bigger patch) or hurts.
    pub softness: f32,
    /// Grip and rolling multipliers at wetness 1 (`Wetness` resource, 0 dry).
    pub wet_grip: f32,
    pub wet_rolling: f32,
}

impl Surface {
    pub fn new(name: &str, grip: f32, rolling: f32, drag: f32, softness: f32, wet_grip: f32, wet_rolling: f32) -> Self {
        Surface { name: name.into(), grip, rolling, drag, softness, wet_grip, wet_rolling }
    }
}

/// The surface table, indexed by [`SurfaceId`]. Replace or extend it freely.
#[derive(Resource, Clone, Debug)]
pub struct Surfaces(pub Vec<Surface>);

impl Default for Surfaces {
    fn default() -> Self {
        Surfaces(vec![
            Surface::new("asphalt", 1.0, 0.012, 0.0, 0.0, 0.7, 1.0),
            Surface::new("gravel", 0.8, 0.03, 0.0, 0.3, 0.85, 1.0),
            Surface::new("dirt", 0.75, 0.035, 0.0, 0.4, 0.6, 1.3),
            Surface::new("sand", 0.55, 0.08, 120.0, 1.0, 1.1, 0.8),
            Surface::new("mud", 0.4, 0.09, 350.0, 0.8, 0.8, 1.2),
            Surface::new("snow", 0.3, 0.05, 80.0, 0.7, 0.9, 1.0),
            Surface::new("ice", 0.1, 0.015, 0.0, 0.0, 0.7, 1.0),
        ])
    }
}

impl Surfaces {
    pub fn get(&self, id: SurfaceId) -> &Surface {
        self.0.get(id.0 as usize).unwrap_or(&self.0[0])
    }
}

/// 0 dry .. 1 soaked; weather writes it, `Surface::wet_*` decide the effect.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct Wetness(pub f32);

/// Put on a collider entity to give it a surface (the default [`SurfaceMap`] reads it).
#[derive(Component, Clone, Copy, Debug, Default, Reflect)]
#[reflect(Component)]
pub struct SurfaceTag(pub SurfaceId);

/// What a wheel touches.
#[derive(Clone, Copy, Debug)]
pub struct SurfaceQuery {
    pub point: Vec3,
    pub normal: Vec3,
    pub collider: Entity,
    /// The `SurfaceTag` on the collider, if any.
    pub tag: Option<SurfaceId>,
}

/// The game's answer to "what is under this wheel". Runs once per grounded wheel per tick, so
/// keep it cheap (a splat-map sample, a table lookup).
pub trait SurfaceMap: Send + Sync + 'static {
    fn surface(&self, q: &SurfaceQuery) -> SurfaceId;
}

/// Default: the collider's [`SurfaceTag`], asphalt without one.
pub struct TagSurfaceMap;

impl SurfaceMap for TagSurfaceMap {
    fn surface(&self, q: &SurfaceQuery) -> SurfaceId {
        q.tag.unwrap_or_default()
    }
}

/// The active map; replace the box to change how surfaces are found.
#[derive(Resource)]
pub struct SurfaceMapRes(pub Box<dyn SurfaceMap>);

impl Default for SurfaceMapRes {
    fn default() -> Self {
        SurfaceMapRes(Box::new(TagSurfaceMap))
    }
}
