//! Shared ground-surface lookup: what is under a point, and how wet the open ground is.
//!
//! Always compiled (tiny, no deps beyond Bevy). `vehicle` (per-wheel grip), `spray` (what is
//! thrown up) and `weather` (writes [`Wetness`]) all speak these types, so a game implements
//! [`SurfaceMap`] once (a physics-material tag, a terrain layer, a splat map ...) and inserts it as
//! [`SurfaceMapRes`].

use bevy::prelude::*;

/// A kind of ground, an index into the game's surface table (`vehicle::Surfaces`).
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
    pub const GRASS: SurfaceId = SurfaceId(7);
}

/// 0 dry .. 1 soaked open ground. `weather` writes it; `vehicle` reads it (`Surface::wet_*`).
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct Wetness(pub f32);

/// Put on a collider entity to give it a surface (the default [`SurfaceMap`] reads it).
#[derive(Component, Clone, Copy, Debug, Default, Reflect)]
#[reflect(Component)]
pub struct SurfaceTag(pub SurfaceId);

/// What is asked about: a point, optionally with the contact it came from.
#[derive(Clone, Copy, Debug)]
pub struct SurfaceProbe {
    pub point: Vec3,
    pub normal: Vec3,
    pub collider: Option<Entity>,
    /// The [`SurfaceTag`] on the collider, if any.
    pub tag: Option<SurfaceId>,
}

impl SurfaceProbe {
    /// A bare position (no contact info).
    pub fn at(point: Vec3) -> Self {
        SurfaceProbe { point, normal: Vec3::Y, collider: None, tag: None }
    }
}

/// The game's answer to "what is under here". Called per grounded wheel per tick and per spray
/// point per frame, so keep it cheap (a splat-map sample, a table lookup).
pub trait SurfaceMap: Send + Sync + 'static {
    fn surface(&self, q: &SurfaceProbe) -> SurfaceId;

    /// The surface at a bare position; `None` means unknown / airborne (spray emits nothing).
    fn surface_at(&self, point: Vec3) -> Option<SurfaceId> {
        Some(self.surface(&SurfaceProbe::at(point)))
    }
}

/// Default: the collider's [`SurfaceTag`], asphalt without one.
pub struct TagSurfaceMap;

impl SurfaceMap for TagSurfaceMap {
    fn surface(&self, q: &SurfaceProbe) -> SurfaceId {
        q.tag.unwrap_or_default()
    }
}

/// A map from a position function (analytic terrain, a noise field).
pub struct FnSurfaceMap<F>(pub F);

impl<F: Fn(Vec3) -> Option<SurfaceId> + Send + Sync + 'static> SurfaceMap for FnSurfaceMap<F> {
    fn surface(&self, q: &SurfaceProbe) -> SurfaceId {
        (self.0)(q.point).unwrap_or_default()
    }
    fn surface_at(&self, point: Vec3) -> Option<SurfaceId> {
        (self.0)(point)
    }
}

/// The active map; replace the box to change how surfaces are found.
#[derive(Resource)]
pub struct SurfaceMapRes(pub Box<dyn SurfaceMap>);

impl SurfaceMapRes {
    pub fn from_fn(f: impl Fn(Vec3) -> Option<SurfaceId> + Send + Sync + 'static) -> Self {
        SurfaceMapRes(Box::new(FnSurfaceMap(f)))
    }
}

impl Default for SurfaceMapRes {
    fn default() -> Self {
        SurfaceMapRes(Box::new(TagSurfaceMap))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fn_map_answers_both_ways() {
        let m = SurfaceMapRes::from_fn(|p| (p.x > 0.0).then_some(SurfaceId::MUD));
        assert_eq!(m.0.surface_at(Vec3::X), Some(SurfaceId::MUD));
        assert_eq!(m.0.surface_at(-Vec3::X), None);
        assert_eq!(m.0.surface(&SurfaceProbe::at(-Vec3::X)), SurfaceId::ASPHALT);
    }

    #[test]
    fn default_reads_the_tag() {
        let q = SurfaceProbe { tag: Some(SurfaceId::ICE), ..SurfaceProbe::at(Vec3::ZERO) };
        assert_eq!(SurfaceMapRes::default().0.surface(&q), SurfaceId::ICE);
    }
}
