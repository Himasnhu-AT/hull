//! The impostor material and quad: see `impostor.wesl`.

use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::pbr::{ExtendedMaterial, MaterialExtension};
use bevy::prelude::*;
use bevy::render::render_resource::AsBindGroup;
use bevy::shader::ShaderRef;
use bevy::asset::RenderAssetUsages;
use bevy::camera::primitives::Aabb;

use asset_pipe::desc::ImpostorDesc;

use crate::foliage::{ImpostorAtlas, ImpostorParams};

pub type ImpostorMat = ExtendedMaterial<StandardMaterial, ImpostorExt>;

#[derive(Asset, AsBindGroup, Reflect, Debug, Clone, Default)]
pub struct ImpostorExt {
    /// `x`: frames, `y`: atlas columns, `z`: rows.
    #[uniform(100)]
    pub params: Vec4,
}

impl MaterialExtension for ImpostorExt {
    fn vertex_shader() -> ShaderRef {
        "embedded://engine/assets/impostor.wesl".into()
    }
    fn fragment_shader() -> ShaderRef {
        "embedded://engine/assets/impostor.wesl".into()
    }
    // The prepass and shadow passes would draw an unturned quad: the impostor is neither.
    fn enable_prepass() -> bool {
        false
    }
    fn enable_shadows() -> bool {
        false
    }
}

/// The runtime contract of `foliage`: a cooked impostor is an [`ImpostorAtlas`] (image + params).
pub fn atlas_of(d: &ImpostorDesc, image: Handle<Image>) -> ImpostorAtlas {
    ImpostorAtlas::new(image, ImpostorParams { grid: d.grid, frames: d.frames, half_width: d.half_width, y0: d.y0, y1: d.y1, cutoff: d.cutoff })
}

pub(super) fn material(atlas: &ImpostorAtlas) -> ImpostorMat {
    let p = &atlas.params;
    ImpostorMat {
        base: StandardMaterial {
            base_color_texture: Some(atlas.image.clone()),
            alpha_mode: AlphaMode::Mask(p.cutoff),
            perceptual_roughness: 1.0,
            reflectance: 0.0,
            // Both faces draw (no culling) but never flip the normal: the quad is turned in the shader, so
            // its winding says nothing about which side faces the camera.
            double_sided: false,
            cull_mode: None,
            ..default()
        },
        extension: ImpostorExt { params: Vec4::new(p.frames as f32, p.grid[0] as f32, p.grid[1] as f32, 0.0) },
    }
}

/// A quad in local XY, from the atlas's `y0` to `y1`, and a bounding box that holds it whichever
/// way the shader turns it.
pub(super) fn quad(atlas: &ImpostorAtlas) -> (Mesh, Aabb) {
    let p = &atlas.params;
    let (hw, y0, y1) = (p.half_width, p.y0, p.y1);
    let mut m = Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default());
    m.insert_attribute(Mesh::ATTRIBUTE_POSITION, vec![[-hw, y0, 0.0], [hw, y0, 0.0], [hw, y1, 0.0], [-hw, y1, 0.0]]);
    m.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; 4]);
    m.insert_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]]);
    m.insert_indices(Indices::U32(vec![0, 1, 2, 0, 2, 3]));
    (m, Aabb { center: Vec3A::new(0.0, (y0 + y1) / 2.0, 0.0), half_extents: Vec3A::new(hw, (y1 - y0) / 2.0, hw) })
}
