//! Surfaces: grip, rolling resistance and drag per ground type, looked up per wheel through a
//! [`SurfaceMap`] the game provides (a physics-material tag, a terrain layer, a splat map ...).

use bevy::prelude::*;

pub use crate::surface::{FnSurfaceMap, SurfaceId, SurfaceMap, SurfaceMapRes, SurfaceProbe, SurfaceTag, TagSurfaceMap, Wetness};

/// Old name of [`SurfaceProbe`].
pub type SurfaceQuery = SurfaceProbe;

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
            Surface::new("grass", 0.85, 0.04, 0.0, 0.3, 0.75, 1.1),
        ])
    }
}

impl Surfaces {
    pub fn get(&self, id: SurfaceId) -> &Surface {
        self.0.get(id.0 as usize).unwrap_or(&self.0[0])
    }
}
