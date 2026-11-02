//! Terrain data files: what an edited terrain is saved as and loaded from.
//!
//! ```text
//! <dir>/terrain.ron          TerrainMeta: size_samples, spacing, origin, height_min, height_max, splat_resolution
//! <dir>/terrain.r16          u16 little-endian, row-major (X fastest): 0 = height_min, 65535 = height_max
//! <dir>/terrain_splat.rgba8  optional, splat_resolution² RGBA8 texels (byte i = layer i), row-major
//! ```
//!
//! The splat map covers the terrain as it is laid out in memory, i.e. padded to whole chunks
//! (`chunk_quads`, 64 by default), the same extent the generated splat map uses; keep the
//! chunk size when loading a saved splat map.
//!
//! Writes are atomic per file (temp file + rename); `terrain.ron` is written last, so a crash
//! never leaves metadata describing data that is not there. Loading never panics on bad data:
//! sizes are checked against the file lengths.

use std::path::{Path, PathBuf};

use bevy::math::Vec2;
use serde::{Deserialize, Serialize};

use super::heightfield::Heightfield;

pub const META_FILE: &str = "terrain.ron";
pub const HEIGHTS_FILE: &str = "terrain.r16";
pub const SPLAT_FILE: &str = "terrain_splat.rgba8";

/// Most samples one terrain file may hold (guards allocation from a bad `terrain.ron`).
const MAX_SAMPLES: u64 = 1 << 28;

/// `terrain.ron`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TerrainMeta {
    /// Samples along X and Z.
    pub size_samples: [u32; 2],
    /// Metres between samples.
    pub spacing: f32,
    /// Absolute XZ of sample (0, 0).
    pub origin: [f32; 2],
    pub height_min: f32,
    pub height_max: f32,
    /// Side of the square splat map in texels (0 = no `terrain_splat.rgba8`).
    pub splat_resolution: u32,
}

impl Default for TerrainMeta {
    fn default() -> Self {
        TerrainMeta { size_samples: [2, 2], spacing: 1.0, origin: [0.0; 2], height_min: 0.0, height_max: 0.0, splat_resolution: 0 }
    }
}

/// Why terrain data could not be read or written.
#[derive(Debug, Clone, PartialEq)]
pub enum TerrainDataError {
    Io(String),
    Format(String),
}

impl std::fmt::Display for TerrainDataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TerrainDataError::Io(e) => write!(f, "terrain data io: {e}"),
            TerrainDataError::Format(e) => write!(f, "terrain data format: {e}"),
        }
    }
}

impl std::error::Error for TerrainDataError {}

/// Quantised heights, metadata and the optional splat map, in memory.
#[derive(Clone, Debug, PartialEq)]
pub struct TerrainData {
    pub meta: TerrainMeta,
    /// `size_samples[0] * size_samples[1]` quantised heights, row-major.
    pub heights: Vec<u16>,
    /// `splat_resolution² * 4` bytes.
    pub splat: Option<Vec<u8>>,
}

impl TerrainData {
    /// Quantises the first `size[0] × size[1]` samples of `hf` (drops chunk padding). The height
    /// range is the exact min/max of those samples, so the worst error is `(max-min)/65535/2`.
    pub fn from_heightfield(hf: &Heightfield, size: [u32; 2], splat: Option<(u32, Vec<u8>)>) -> Self {
        let (nx, nz) = (size[0].clamp(2, hf.nx()), size[1].clamp(2, hf.nz()));
        let mut lo = f32::MAX;
        let mut hi = f32::MIN;
        for iz in 0..nz as i64 {
            for ix in 0..nx as i64 {
                let h = hf.get(ix, iz);
                lo = lo.min(h);
                hi = hi.max(h);
            }
        }
        let range = hi - lo;
        let mut heights = Vec::with_capacity((nx * nz) as usize);
        for iz in 0..nz as i64 {
            for ix in 0..nx as i64 {
                let h = hf.get(ix, iz);
                heights.push(if range > 0.0 { ((h - lo) / range * 65535.0).round().clamp(0.0, 65535.0) as u16 } else { 0 });
            }
        }
        let (res, splat) = match splat {
            Some((res, bytes)) if res > 0 && bytes.len() == (res as usize).pow(2) * 4 => (res, Some(bytes)),
            _ => (0, None),
        };
        TerrainData {
            meta: TerrainMeta { size_samples: [nx, nz], spacing: hf.spacing(), origin: hf.origin().to_array(), height_min: lo, height_max: hi, splat_resolution: res },
            heights,
            splat,
        }
    }

    /// Checks sizes: sample count, finite spacing/origin/range, splat length.
    pub fn validate(&self) -> Result<(), TerrainDataError> {
        let m = &self.meta;
        let [nx, nz] = m.size_samples;
        if nx < 2 || nz < 2 || (nx as u64) * (nz as u64) > MAX_SAMPLES {
            return Err(TerrainDataError::Format(format!("size_samples {nx}×{nz} out of range")));
        }
        if !(m.spacing.is_finite() && m.spacing > 0.0) || !m.origin.iter().all(|v| v.is_finite()) || !(m.height_min.is_finite() && m.height_max.is_finite()) || m.height_max < m.height_min {
            return Err(TerrainDataError::Format("spacing, origin or height range invalid".into()));
        }
        if self.heights.len() != (nx * nz) as usize {
            return Err(TerrainDataError::Format(format!("expected {} heights for {nx}×{nz}, got {}", nx * nz, self.heights.len())));
        }
        match (&self.splat, m.splat_resolution) {
            (None, _) => {}
            (Some(s), r) if r > 0 && s.len() as u64 == (r as u64) * (r as u64) * 4 => {}
            (Some(s), r) => return Err(TerrainDataError::Format(format!("splat has {} bytes for resolution {r}", s.len()))),
        }
        Ok(())
    }

    /// The f32 heightfield (heights are `min + v / 65535 * (max - min)`).
    pub fn to_heightfield(&self) -> Result<Heightfield, TerrainDataError> {
        self.validate()?;
        let m = &self.meta;
        let range = m.height_max - m.height_min;
        let heights = self.heights.iter().map(|v| m.height_min + *v as f32 / 65535.0 * range).collect();
        Ok(Heightfield::from_heights(m.size_samples[0], m.size_samples[1], m.spacing, Vec2::from(m.origin), heights))
    }

    /// Reads `<dir>/terrain.ron`, `terrain.r16` and `terrain_splat.rgba8` (when `splat_resolution` > 0).
    pub fn load(dir: &Path) -> Result<Self, TerrainDataError> {
        let read = |name: &str| std::fs::read(dir.join(name)).map_err(|e| TerrainDataError::Io(format!("{}: {e}", dir.join(name).display())));
        let text = String::from_utf8(read(META_FILE)?).map_err(|e| TerrainDataError::Format(format!("{META_FILE}: {e}")))?;
        let meta: TerrainMeta = ron::from_str(&text).map_err(|e| TerrainDataError::Format(format!("{META_FILE}: {e}")))?;
        let [nx, nz] = meta.size_samples;
        if nx < 2 || nz < 2 || (nx as u64) * (nz as u64) > MAX_SAMPLES {
            return Err(TerrainDataError::Format(format!("size_samples {nx}×{nz} out of range")));
        }
        let raw = read(HEIGHTS_FILE)?;
        if raw.len() as u64 != (nx as u64) * (nz as u64) * 2 {
            return Err(TerrainDataError::Format(format!("{HEIGHTS_FILE}: expected {} bytes for {nx}×{nz}, got {}", (nx as u64) * (nz as u64) * 2, raw.len())));
        }
        let heights = raw.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        let splat = if meta.splat_resolution > 0 { Some(read(SPLAT_FILE)?) } else { None };
        let d = TerrainData { meta, heights, splat };
        d.validate()?;
        Ok(d)
    }

    /// Only the splat map of the data in `dir`: `(resolution, RGBA8 bytes)`; `None` when there is
    /// none or it does not match its metadata.
    pub fn load_splat(dir: &Path) -> Option<(u32, Vec<u8>)> {
        let text = std::fs::read_to_string(dir.join(META_FILE)).ok()?;
        let meta: TerrainMeta = ron::from_str(&text).ok()?;
        let res = meta.splat_resolution;
        if res == 0 || res > 16384 {
            return None;
        }
        let bytes = std::fs::read(dir.join(SPLAT_FILE)).ok()?;
        (bytes.len() as u64 == (res as u64) * (res as u64) * 4).then_some((res, bytes))
    }

    /// Writes the files into `dir` (created if missing). If there is no splat map, an old
    /// `terrain_splat.rgba8` is removed so it cannot go stale.
    pub fn save(&self, dir: &Path) -> Result<(), TerrainDataError> {
        self.validate()?;
        std::fs::create_dir_all(dir).map_err(|e| TerrainDataError::Io(format!("{}: {e}", dir.display())))?;
        let mut raw = Vec::with_capacity(self.heights.len() * 2);
        for h in &self.heights {
            raw.extend_from_slice(&h.to_le_bytes());
        }
        write_atomic(&dir.join(HEIGHTS_FILE), &raw)?;
        match &self.splat {
            Some(s) => write_atomic(&dir.join(SPLAT_FILE), s)?,
            None => {
                let _ = std::fs::remove_file(dir.join(SPLAT_FILE));
            }
        }
        let text = ron::ser::to_string_pretty(&self.meta, ron::ser::PrettyConfig::default()).map_err(|e| TerrainDataError::Format(e.to_string()))?;
        write_atomic(&dir.join(META_FILE), text.as_bytes())
    }
}

/// Write to `<path>.tmp`, then rename over `path`.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), TerrainDataError> {
    let mut tmp: PathBuf = path.to_path_buf();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    tmp.set_file_name(format!("{name}.tmp"));
    let io = |e: std::io::Error| TerrainDataError::Io(format!("{}: {e}", path.display()));
    std::fs::write(&tmp, bytes).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("engine-terrain-data-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn hills() -> Heightfield {
        Heightfield::from_fn(70, 50, 2.5, Vec2::new(-100.0, 40.0), |x, z| 30.0 + (x * 0.07).sin() * 25.0 + (z * 0.11).cos() * 12.0)
    }

    #[test]
    fn round_trip_within_one_quantisation_step() {
        let hf = hills();
        let dir = tmp("rt");
        let splat: Vec<u8> = (0..16 * 16 * 4).map(|i| (i % 251) as u8).collect();
        let data = TerrainData::from_heightfield(&hf, [70, 50], Some((16, splat.clone())));
        data.save(&dir).unwrap();
        assert_eq!(std::fs::metadata(dir.join(HEIGHTS_FILE)).unwrap().len(), 70 * 50 * 2);
        assert!(std::fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        let back = TerrainData::load(&dir).unwrap();
        assert_eq!(back, data);
        assert_eq!(back.splat.as_deref(), Some(&splat[..]));
        let hf2 = back.to_heightfield().unwrap();
        assert_eq!((hf2.nx(), hf2.nz(), hf2.spacing(), hf2.origin()), (70, 50, 2.5, Vec2::new(-100.0, 40.0)));
        let step = (hf.max_height() - hf.min_height()) / 65535.0;
        for (a, b) in hf.heights().iter().zip(hf2.heights()) {
            assert!((a - b).abs() <= step, "{a} vs {b}, step {step}");
        }
        // A second save of the loaded data is bit-identical (no drift).
        let again = TerrainData::from_heightfield(&hf2, [70, 50], None);
        assert_eq!(again.heights, data.heights);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn crops_padding_and_handles_flat_terrain() {
        let hf = Heightfield::flat(40, 40, 1.0, Vec2::ZERO, 7.0);
        let d = TerrainData::from_heightfield(&hf, [33, 20], None);
        assert_eq!((d.meta.size_samples, d.heights.len()), ([33, 20], 660));
        let back = d.to_heightfield().unwrap();
        assert!(back.heights().iter().all(|h| *h == 7.0));
    }

    #[test]
    fn bad_files_are_errors_not_panics() {
        let dir = tmp("bad");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(matches!(TerrainData::load(&dir), Err(TerrainDataError::Io(_))));
        std::fs::write(dir.join(META_FILE), "(size_samples: (4, 4), spacing: 1.0)").unwrap();
        std::fs::write(dir.join(HEIGHTS_FILE), [0u8; 10]).unwrap();
        assert!(matches!(TerrainData::load(&dir), Err(TerrainDataError::Format(_))));
        std::fs::write(dir.join(META_FILE), "(size_samples: (65535, 65535))").unwrap();
        assert!(matches!(TerrainData::load(&dir), Err(TerrainDataError::Format(_))));
        std::fs::write(dir.join(META_FILE), "nonsense").unwrap();
        assert!(TerrainData::load(&dir).is_err());
        std::fs::write(dir.join(META_FILE), "(size_samples: (2, 2), spacing: 0.0)").unwrap();
        std::fs::write(dir.join(HEIGHTS_FILE), [0u8; 8]).unwrap();
        assert!(TerrainData::load(&dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
