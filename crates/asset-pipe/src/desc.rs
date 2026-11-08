//! The sidecar a cooked asset ships with (`<name>.asset.ron`): LOD files and switch distances, the
//! collider, the impostor atlas, tags. Written by the `Emit` stage, read by the engine's
//! `assets` module. All file names are relative to the sidecar's folder.

use serde::{Deserialize, Serialize};

pub const DESC_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AssetDesc {
    pub version: u32,
    pub name: String,
    /// Local-space bounds of the cooked model: `[min, max]`.
    pub bounds: ([f32; 3], [f32; 3]),
    pub lods: Vec<LodDesc>,
    pub collider: ColliderDesc,
    pub impostor: Option<ImpostorDesc>,
    /// Free-form labels the game reads (`"actor"` makes the spawn an `Actor`, the rest are yours).
    pub tags: Vec<String>,
    /// Folder (relative) with KTX2 textures from `tools/cook`, when the cook stage ran.
    pub cooked_textures: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LodDesc {
    /// A `.glb` next to the sidecar.
    pub mesh: String,
    /// Metres (at High quality) where this level hands over to the next one (the impostor after
    /// the last level, or nothing).
    pub distance: f32,
    pub triangles: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ColliderDesc {
    None,
    Box { center: [f32; 3], half: [f32; 3] },
    Sphere { center: [f32; 3], radius: f32 },
    /// Y-axis capsule: `half_height` is the straight part.
    Capsule { center: [f32; 3], radius: f32, half_height: f32 },
    /// Convex hull of these points (a few dozen extreme points of the mesh).
    Convex { points: Vec<[f32; 3]> },
    /// Triangle mesh of LOD `lod` (the runtime builds it from that level's mesh).
    Trimesh { lod: usize },
}

/// An impostor atlas: the fields mirror the engine's `foliage::ImpostorParams` (so a cooked asset
/// converts to a runtime `ImpostorAtlas` field by field) plus the atlas file and a draw limit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImpostorDesc {
    /// Atlas PNG next to the sidecar.
    pub atlas: String,
    /// Atlas grid (columns, rows); frames fill it row by row from the top left.
    pub grid: [u32; 2],
    /// Views in the ring: frame `i` is the model seen from azimuth `i / frames` of a turn, from
    /// +Z towards +X in the model's own frame (frame 0 from the +Z side).
    pub frames: u32,
    /// Half width of a frame in metres at scale 1, and its bottom / top above the origin.
    pub half_width: f32,
    pub y0: f32,
    pub y1: f32,
    /// Alpha cutoff of the pictures.
    pub cutoff: f32,
    /// Farthest distance the impostor is drawn (None: the render budget's view distance).
    pub max_distance: Option<f32>,
}

impl AssetDesc {
    pub fn to_ron(&self) -> Result<String, String> {
        ron::ser::to_string_pretty(self, ron::ser::PrettyConfig::default().indentor(String::from("  ")).new_line(String::from("\n"))).map_err(|e| e.to_string())
    }

    pub fn from_ron(s: &str) -> Result<AssetDesc, String> {
        let d: AssetDesc = ron::de::from_str(s).map_err(|e| e.to_string())?;
        if d.version != DESC_VERSION {
            return Err(format!("asset desc version {} (expected {DESC_VERSION})", d.version));
        }
        Ok(d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desc_round_trips_through_ron() {
        let d = AssetDesc {
            version: DESC_VERSION,
            name: "pine".into(),
            bounds: ([-1.0, 0.0, -1.0], [1.0, 6.0, 1.0]),
            lods: vec![LodDesc { mesh: "pine.lod0.glb".into(), distance: 30.0, triangles: 900 }],
            collider: ColliderDesc::Capsule { center: [0.0, 3.0, 0.0], radius: 1.0, half_height: 2.0 },
            impostor: Some(ImpostorDesc { atlas: "pine.impostor.png".into(), grid: [8, 1], frames: 8, half_width: 1.0, y0: 0.0, y1: 6.0, cutoff: 0.5, max_distance: None }),
            tags: vec!["tree".into()],
            cooked_textures: None,
        };
        assert_eq!(AssetDesc::from_ron(&d.to_ron().unwrap()).unwrap(), d);
        assert!(AssetDesc::from_ron("(version: 99)").is_err());
    }
}
