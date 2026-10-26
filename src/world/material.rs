//! Terrain splat material: `ExtendedMaterial<StandardMaterial, TerrainExt>`, up to 4 layers
//! blended per pixel by an RGBA splat map covering the whole terrain. The splat map comes from
//! rules ([`SplatLayer`]: height band, slope band, noise) or from an image the game provides.
//! Layers are a colour, a roughness and an optional tiling texture.

use bevy::asset::RenderAssetUsages;
use bevy::image::{ImageAddressMode, ImageSampler, ImageSamplerDescriptor};
use bevy::pbr::{ExtendedMaterial, MaterialExtension, MaterialPlugin};
use bevy::prelude::*;
use bevy::render::render_resource::{AsBindGroup, Extent3d, ShaderType, TextureDimension, TextureFormat};
use bevy::shader::ShaderRef;
use serde::{Deserialize, Serialize};

use super::heightfield::{Heightfield, par_rows};
use super::noise::Fbm;
use super::origin::{OriginShifted, WorldOrigin};

/// The terrain material.
pub type TerrainMaterial = ExtendedMaterial<StandardMaterial, TerrainExt>;

/// Uniform block of [`TerrainExt`] (see `terrain.wgsl`).
#[derive(ShaderType, Reflect, Clone, Debug, Default)]
pub struct TerrainParams {
    pub colors: [Vec4; 4],
    /// x: 1 / tiling metres, y: roughness, z: texture strength, w: unused.
    pub layers: [Vec4; 4],
    /// xy: Bevy-space XZ of the terrain's min corner, zw: 1 / size.
    pub extent: Vec4,
    /// x: macro variation strength, y: its frequency (1/m).
    pub variation: Vec4,
}

/// Splat extension: the splat map and up to 4 layer textures (missing = white).
#[derive(Asset, AsBindGroup, Reflect, Debug, Clone, Default)]
pub struct TerrainExt {
    #[uniform(100)]
    pub params: TerrainParams,
    #[texture(101)]
    #[sampler(102)]
    pub splat: Option<Handle<Image>>,
    #[texture(103)]
    #[sampler(104)]
    pub layer0: Option<Handle<Image>>,
    #[texture(105)]
    #[sampler(106)]
    pub layer1: Option<Handle<Image>>,
    #[texture(107)]
    #[sampler(108)]
    pub layer2: Option<Handle<Image>>,
    #[texture(109)]
    #[sampler(110)]
    pub layer3: Option<Handle<Image>>,
}

impl MaterialExtension for TerrainExt {
    fn fragment_shader() -> ShaderRef {
        "embedded://engine/world/terrain.wgsl".into()
    }
}

/// One terrain layer and the rule that paints it (when the splat map is generated).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SplatLayer {
    pub name: String,
    /// sRGB colour (multiplied by the texture, if any).
    pub color: [f32; 3],
    pub roughness: f32,
    /// Asset path of a tiling albedo texture (optional).
    pub texture: Option<String>,
    /// Metres per texture repeat.
    pub tiling: f32,
    /// Height band (absolute metres) where the layer appears...
    pub height: [f32; 2],
    /// ...and slope band in degrees.
    pub slope: [f32; 2],
    /// Softness of both bands (metres for height, degrees for slope).
    pub blend: f32,
    /// 0..1: how much noise modulates the weight (patches).
    pub noise: f32,
    /// Base weight (layers later in the list paint over earlier ones by having more).
    pub weight: f32,
}

impl Default for SplatLayer {
    fn default() -> Self {
        SplatLayer {
            name: String::new(),
            color: [0.5, 0.5, 0.5],
            roughness: 0.9,
            texture: None,
            tiling: 8.0,
            height: [-1e6, 1e6],
            slope: [0.0, 90.0],
            blend: 4.0,
            noise: 0.0,
            weight: 1.0,
        }
    }
}

impl SplatLayer {
    /// Unnormalised weight at a height / slope / noise value (0..1).
    pub fn weight_at(&self, h: f32, slope: f32, n: f32) -> f32 {
        let band = |v: f32, lo: f32, hi: f32, soft: f32| {
            let soft = soft.max(1e-3);
            let a = ((v - lo) / soft + 0.5).clamp(0.0, 1.0);
            let b = ((hi - v) / soft + 0.5).clamp(0.0, 1.0);
            a.min(b)
        };
        let w = band(h, self.height[0], self.height[1], self.blend) * band(slope, self.slope[0], self.slope[1], self.blend);
        let m = 1.0 - self.noise + self.noise * 2.0 * n;
        (w * m * self.weight).max(0.0)
    }
}

/// Default layers: grass, rock on slopes, sand low, snow high (heights for ~0..250 m terrain).
pub fn default_layers() -> Vec<SplatLayer> {
    vec![
        SplatLayer { name: "grass".into(), color: [0.30, 0.42, 0.16], roughness: 0.95, noise: 0.4, ..default() },
        SplatLayer { name: "rock".into(), color: [0.42, 0.40, 0.37], roughness: 0.8, slope: [28.0, 90.0], blend: 8.0, weight: 3.0, ..default() },
        SplatLayer { name: "sand".into(), color: [0.70, 0.63, 0.46], roughness: 0.9, height: [-1e6, 6.0], blend: 3.0, weight: 2.0, ..default() },
        SplatLayer { name: "snow".into(), color: [0.92, 0.94, 0.97], roughness: 0.5, height: [170.0, 1e6], slope: [0.0, 40.0], blend: 20.0, weight: 4.0, ..default() },
    ]
}

/// Generates an RGBA8 splat map (`res × res` over the heightfield) from up to 4 layers.
/// Byte `i` of a texel is layer `i`'s weight; weights sum to ~255. Returns the raw bytes.
pub fn generate_splat(hf: &Heightfield, layers: &[SplatLayer], res: u32, seed: u64) -> Vec<u8> {
    let res = res.max(2);
    let size = hf.size();
    let origin = hf.origin();
    let noise = Fbm { seed: seed ^ 0x5911_7a7a, frequency: 0.02, octaves: 3, ..default() };
    let px: Vec<[u8; 4]> = par_rows(res as usize, res as usize, |row, out: &mut [[u8; 4]]| {
        let z = origin.y + (row as f32 + 0.5) / res as f32 * size.y;
        for (col, texel) in out.iter_mut().enumerate() {
            let x = origin.x + (col as f32 + 0.5) / res as f32 * size.x;
            let h = hf.height_at(x, z);
            let slope = hf.slope_deg(x, z);
            let n = noise.sample01(Vec2::new(x, z));
            let mut w = [0.0f32; 4];
            for (i, l) in layers.iter().take(4).enumerate() {
                w[i] = l.weight_at(h, slope, n);
            }
            let sum: f32 = w.iter().sum();
            *texel = if sum <= 1e-6 {
                [255, 0, 0, 0]
            } else {
                w.map(|v| (v / sum * 255.0).round() as u8)
            };
        }
    });
    px.into_iter().flatten().collect()
}

/// An RGBA8 (linear) image from splat bytes, clamped and linearly filtered.
pub fn splat_image(bytes: Vec<u8>, res: u32) -> Image {
    let mut img = Image::new(
        Extent3d { width: res, height: res, depth_or_array_layers: 1 },
        TextureDimension::D2,
        bytes,
        TextureFormat::Rgba8Unorm,
        RenderAssetUsages::RENDER_WORLD,
    );
    img.sampler = ImageSampler::Descriptor(ImageSamplerDescriptor::linear());
    img
}

/// Repeat-wrapped, mipmapped sampler settings for layer textures loaded from assets.
pub fn repeat_sampler() -> ImageSampler {
    ImageSampler::Descriptor(ImageSamplerDescriptor {
        address_mode_u: ImageAddressMode::Repeat,
        address_mode_v: ImageAddressMode::Repeat,
        anisotropy_clamp: 8,
        ..ImageSamplerDescriptor::linear()
    })
}

/// Builds the material params (layers + extent for the current origin).
pub fn terrain_params(layers: &[SplatLayer], hf: &Heightfield, origin: &WorldOrigin, has_texture: [bool; 4]) -> TerrainParams {
    let mut p = TerrainParams::default();
    for (i, tex) in has_texture.into_iter().enumerate() {
        let l = layers.get(i).cloned().unwrap_or(SplatLayer { weight: 0.0, ..default() });
        let c = Color::srgb(l.color[0], l.color[1], l.color[2]).to_linear();
        p.colors[i] = Vec4::new(c.red, c.green, c.blue, 1.0);
        p.layers[i] = Vec4::new(1.0 / l.tiling.max(0.01), l.roughness, if tex { 1.0 } else { 0.0 }, 0.0);
    }
    p.extent = extent(hf, origin);
    p.variation = Vec4::new(0.18, 0.02, 0.0, 0.0);
    p
}

fn extent(hf: &Heightfield, origin: &WorldOrigin) -> Vec4 {
    let o = origin.to_local(Vec3::new(hf.origin().x, 0.0, hf.origin().y));
    let s = hf.size();
    Vec4::new(o.x, o.z, 1.0 / s.x, 1.0 / s.y)
}

/// Keeps the material's world-space extent in step with the floating origin.
fn follow_origin(
    mut shifted: MessageReader<OriginShifted>,
    look: Option<Res<super::terrain::TerrainLook>>,
    terrain: Option<Res<super::Terrain>>,
    origin: Res<WorldOrigin>,
    mut mats: ResMut<Assets<TerrainMaterial>>,
) {
    if shifted.read().count() == 0 {
        return;
    }
    let (Some(look), Some(t)) = (look, terrain) else { return };
    if let super::terrain::TerrainLook::Splat(h) = &*look
        && let Some(mut m) = mats.get_mut(h)
    {
        m.extension.params.extent = extent(t.heightfield(), &origin);
    }
}

pub(super) struct TerrainMaterialPlugin;

impl Plugin for TerrainMaterialPlugin {
    fn build(&self, app: &mut App) {
        if !app.is_plugin_added::<bevy::pbr::PbrPlugin>() {
            return;
        }
        bevy::asset::embedded_asset!(app, "terrain.wgsl");
        app.add_plugins(MaterialPlugin::<TerrainMaterial>::default()).add_systems(PostUpdate, follow_origin.in_set(super::WorldSystems::Terrain));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splat_rules_pick_layers() {
        let hf = Heightfield::from_fn(65, 65, 4.0, Vec2::ZERO, |x, _| if x < 100.0 { 2.0 } else if x < 200.0 { 2.0 + (x - 100.0) * 2.0 } else { 300.0 });
        let px = generate_splat(&hf, &default_layers(), 64, 1);
        let at = |col: usize| &px[(32 * 64 + col) * 4..(32 * 64 + col) * 4 + 4];
        let top = |t: &[u8]| (0..4).max_by_key(|i| t[*i]).unwrap();
        assert_eq!(top(at(5)), 2, "low & flat → sand: {:?}", at(5));
        assert_eq!(top(at(37)), 1, "steep → rock: {:?}", at(37));
        assert_eq!(top(at(60)), 3, "high & flat → snow: {:?}", at(60));
        assert_eq!(at(60)[1], 0, "no rock on flat ground");
        // Weights sum to ~255 everywhere.
        assert!(px.chunks(4).all(|t| (250..=260).contains(&t.iter().map(|v| *v as u32).sum::<u32>())));
    }
}
