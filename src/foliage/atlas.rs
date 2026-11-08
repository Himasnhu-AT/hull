//! The runtime impostor description, independent of how the pictures were made: an image holding
//! a grid of views of one plant plus the numbers to place them. A baker (offline tool, editor) or
//! [`ImpostorAtlas::billboard`] / [`ImpostorAtlas::procedural_tree`] produce one; the renderer only
//! reads this.

use bevy::asset::RenderAssetUsages;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};
use serde::{Deserialize, Serialize};

/// The numbers of an impostor atlas (also the sidecar file a baker writes: serde, JSON / RON).
///
/// View `i` of `frames` is the plant seen from azimuth `i / frames * 2pi`, measured from `+Z`
/// towards `+X` in the plant's own frame (frame 0 looks at the plant from its `+Z` side); frames
/// fill the grid row by row from the top-left. One frame = a plain camera-facing billboard.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ImpostorParams {
    /// Grid of the atlas (columns, rows).
    pub grid: [u32; 2],
    /// Views in the ring (at most columns x rows).
    pub frames: u32,
    /// Half width of a frame in the world (m, at scale 1).
    pub half_width: f32,
    /// Bottom and top of a frame above the plant's base (m, at scale 1).
    pub y0: f32,
    pub y1: f32,
    /// Alpha cutoff of the pictures.
    pub cutoff: f32,
}

impl Default for ImpostorParams {
    fn default() -> Self {
        ImpostorParams { grid: [1, 1], frames: 1, half_width: 2.0, y0: 0.0, y1: 6.0, cutoff: 0.5 }
    }
}

/// An impostor picture set: image + [`ImpostorParams`].
#[derive(Clone, Debug)]
pub struct ImpostorAtlas {
    pub image: Handle<Image>,
    pub params: ImpostorParams,
}

impl ImpostorAtlas {
    pub fn new(image: Handle<Image>, params: ImpostorParams) -> Self {
        ImpostorAtlas { image, params }
    }

    /// A single-picture billboard from `image` (the whole image is the frame).
    pub fn billboard(image: Handle<Image>, half_width: f32, height: f32) -> Self {
        ImpostorAtlas { image, params: ImpostorParams { half_width, y1: height, ..default() } }
    }

    /// A procedural stand-in tree (trunk and a round crown with alpha) at `size` px, drawn
    /// as `frames` views in a ring: good for tests, demos and placeholders. The views differ
    /// slightly (the crown's lobes turn) so the ring is visible.
    pub fn procedural_tree(images: &mut Assets<Image>, size: u32, frames: u32, half_width: f32, height: f32) -> Self {
        let frames = frames.max(1);
        let cols = (frames as f32).sqrt().ceil() as u32;
        let rows = frames.div_ceil(cols);
        let (w, h) = (size * cols, size * rows);
        let mut px = vec![0u8; (w * h * 4) as usize];
        for f in 0..frames {
            let (ox, oy) = ((f % cols) * size, (f / cols) * size);
            let turn = f as f32 / frames as f32 * std::f32::consts::TAU;
            for y in 0..size {
                for x in 0..size {
                    let (u, v) = (x as f32 / size as f32 * 2.0 - 1.0, 1.0 - y as f32 / size as f32);
                    // World-proportioned (u spans 2 half-widths, v the height): a thin trunk up to
                    // 45 % of the height and a round crown of lobes around 68 %.
                    let trunk = u.abs() * half_width < 0.25 && v < 0.45;
                    let (cu, cv) = (u * half_width / height, v - 0.68);
                    let ang = cv.atan2(cu);
                    let r = 0.3 + 0.03 * (ang * 5.0 + turn).sin() + 0.02 * (ang * 9.0 - turn * 2.0).cos();
                    let crown = (cu * cu + cv * cv).sqrt() < r;
                    let i = (((oy + y) * w + ox + x) * 4) as usize;
                    if crown {
                        let shade = 0.55 + 0.45 * (cv * 0.5 + 0.5) + 0.06 * ((u * 23.0 + v * 17.0 + turn).sin());
                        px[i..i + 4].copy_from_slice(&[(46.0 * shade) as u8, (112.0 * shade) as u8, (38.0 * shade) as u8, 255]);
                    } else if trunk {
                        px[i..i + 4].copy_from_slice(&[84, 62, 44, 255]);
                    } else {
                        // Transparent, with the neighbour colour so mips do not bleed black.
                        px[i..i + 4].copy_from_slice(&[46, 112, 38, 0]);
                    }
                }
            }
        }
        let mut img = Image::new(Extent3d { width: w, height: h, depth_or_array_layers: 1 }, TextureDimension::D2, px, TextureFormat::Rgba8UnormSrgb, RenderAssetUsages::RENDER_WORLD | RenderAssetUsages::MAIN_WORLD);
        img.sampler = bevy::image::ImageSampler::linear();
        ImpostorAtlas { image: images.add(img), params: ImpostorParams { grid: [cols, rows], frames, half_width, y0: 0.0, y1: height, cutoff: 0.5 } }
    }

    /// UV rectangle (min, max) of frame `i` in the atlas (frame cells fill the grid row by row).
    pub fn frame_uv(&self, i: u32) -> (Vec2, Vec2) {
        let [c, r] = self.params.grid;
        let i = i % self.params.frames.max(1);
        let cell = Vec2::new((i % c.max(1)) as f32, (i / c.max(1)) as f32);
        let size = Vec2::new(1.0 / c.max(1) as f32, 1.0 / r.max(1) as f32);
        (cell * size, (cell + 1.0) * size)
    }

    /// Which frame the ring shows for a camera at azimuth `cam_az` (rad, `atan2(x, z)` of the
    /// direction from the plant to the camera, world) when the plant is turned by `yaw` (a rotation about +Y; it turns the picture the other way round the ring).
    pub fn frame_for(&self, cam_az: f32, yaw: f32) -> u32 {
        let n = self.params.frames.max(1) as f32;
        let a = (cam_az - yaw) / std::f32::consts::TAU + 0.5 / n;
        ((a - a.floor()) * n).floor() as u32 % self.params.frames.max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atlas(frames: u32) -> ImpostorAtlas {
        let mut images = Assets::<Image>::default();
        ImpostorAtlas::procedural_tree(&mut images, 8, frames, 2.0, 6.0)
    }

    #[test]
    fn grid_holds_every_frame_and_uvs_tile_the_image() {
        let a = atlas(8);
        let [c, r] = a.params.grid;
        assert!(c * r >= 8 && a.params.frames == 8);
        let (lo, hi) = a.frame_uv(7);
        assert!(hi.x <= 1.0 + 1e-5 && hi.y <= 1.0 + 1e-5 && lo.x >= 0.0 && hi.x > lo.x);
        // Frame 0 is top-left, and indices wrap.
        assert_eq!(a.frame_uv(0).0, Vec2::ZERO);
        assert_eq!(a.frame_uv(8), a.frame_uv(0));
    }

    #[test]
    fn the_ring_picks_the_view_nearest_the_camera_azimuth() {
        let a = atlas(8);
        assert_eq!(a.frame_for(0.0, 0.0), 0);
        let step = std::f32::consts::TAU / 8.0;
        assert_eq!(a.frame_for(step * 3.0, 0.0), 3);
        assert_eq!(a.frame_for(step * 3.4, 0.0), 3);
        assert_eq!(a.frame_for(step * 3.6, 0.0), 4);
        // Turning the plant turns the view the other way round the ring.
        assert_eq!(a.frame_for(0.0, step * 2.0), 6);
        assert_eq!(atlas(1).frame_for(2.0, 1.0), 0);
    }

    #[test]
    fn params_round_trip_as_data() {
        let p = ImpostorParams { grid: [4, 2], frames: 8, ..default() };
        let back: ImpostorParams = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(back, p);
        // Missing fields take defaults (a sidecar can be short).
        let short: ImpostorParams = serde_json::from_str(r#"{"frames": 4, "grid": [2, 2]}"#).unwrap();
        assert_eq!(short.half_width, ImpostorParams::default().half_width);
    }

    #[test]
    fn the_procedural_tree_has_a_crown_and_clear_corners() {
        let mut images = Assets::<Image>::default();
        let a = ImpostorAtlas::procedural_tree(&mut images, 32, 1, 2.0, 6.0);
        let img = images.get(&a.image).unwrap();
        let d = img.data.as_ref().unwrap();
        let alpha = |x: usize, y: usize| d[(y * 32 + x) * 4 + 3];
        assert_eq!(alpha(0, 0), 0);
        assert_eq!(alpha(16, 9), 255, "crown centre");
        assert_eq!(alpha(16, 28), 255, "trunk");
    }
}
