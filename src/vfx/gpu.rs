//! Instanced sprite renderer: every sprite emitter is one draw call of `4 × n` vertices
//! (a triangle strip per instance) out of one shared instance buffer.
//!
//! ```text
//! main world  PostUpdate  render::draw → VfxSprites { instances: Vec<SpriteInstance> } (52 B each)
//! ExtractSchedule          extract     → SpriteBuffers (memcpy into one RawBufferVec, ranges)
//! Render  Prepare          upload      → one queue.write_buffer, material bind groups (cached)
//! Render  Queue            queue       → one Transparent3d item per emitter (sorted by centre)
//! draw                     DrawSprites → set_vertex_buffer + draw(0..4, range)
//! ```
//!
//! The pipeline reuses Bevy's mesh view bind group (view, lights, fog, depth prepass,
//! tonemapping LUT), so lit and soft particles work like PBR materials do.

use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use bevy::asset::AssetId;
use bevy::core_pipeline::core_3d::{CORE_3D_DEPTH_FORMAT, Transparent3d, TransparentSortingInfo3d};
use bevy::ecs::query::ROQueryItem;
use bevy::ecs::system::SystemParamItem;
use bevy::ecs::system::lifetimeless::SRes;
use bevy::math::Vec4;
use bevy::mesh::VertexBufferLayout;
use bevy::pbr::{
    MeshPipeline, MeshPipelineKey, MeshPipelineSystems, SetMeshViewBindGroup, SetMeshViewBindingArrayBindGroup, TONEMAPPING_LUT_SAMPLER_BINDING_INDEX,
    TONEMAPPING_LUT_TEXTURE_BINDING_INDEX, ViewKeyCache,
};
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use bevy::render::render_asset::RenderAssets;
use bevy::render::render_phase::{
    AddRenderCommand, DrawFunctions, PhaseItem, PhaseItemExtraIndex, RenderCommand, RenderCommandResult, SetItemPipeline, TrackedRenderPass, ViewSortedRenderPhases,
};
use bevy::render::render_resource::binding_types::{sampler, texture_2d, uniform_buffer};
use bevy::render::render_resource::*;
use bevy::render::renderer::{RenderDevice, RenderQueue};
use bevy::render::sync_world::MainEntity;
use bevy::render::texture::GpuImage;
use bevy::render::view::ExtractedView;
use bevy::render::{Extract, ExtractSchedule, GpuResourceAppExt, Render, RenderApp, RenderStartup, RenderSystems};
use bevy::shader::{Shader, ShaderDefVal};
use bytemuck::{Pod, Zeroable};

use super::VfxInstance;

/// One particle (or ribbon segment) as the GPU sees it. 52 bytes.
///
/// `c.w` is the mode: 0 camera-facing billboard (`a.xyz` centre, `a.w`×`b.w` size, `c.x`
/// rotation); 1 stretched / 2 ribbon segment (from `a.xyz` to `a.xyz + b.xyz`, widths `a.w` →
/// `b.w`, alpha × `c.x` → `c.z`; ribbons sample the texture's cross profile); 3 flat (centre
/// `a.xyz`, plane normal `b.xyz`, size `a.w`×`b.w`... rotation in `c.x`). `c.y` = flipbook
/// frame. `color` is sRGB RGBA8.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct SpriteInstance {
    pub a: [f32; 4],
    pub b: [f32; 4],
    pub c: [f32; 4],
    pub color: [u8; 4],
}

pub const MODE_BILLBOARD: f32 = 0.0;
pub const MODE_STRETCHED: f32 = 1.0;
pub const MODE_RIBBON: f32 = 2.0;
pub const MODE_FLAT: f32 = 3.0;

#[derive(ShaderType, Clone, Copy, Debug, Default, PartialEq)]
pub struct ParticleUniform {
    /// cols, rows, frames, crossfade.
    pub flipbook: Vec4,
    /// intensity, lit, soft distance, additive.
    pub shading: Vec4,
}

/// The look shared by all particles of a draw.
#[derive(Clone, Debug, PartialEq)]
pub struct SpriteMaterial {
    pub texture: AssetId<Image>,
    pub params: ParticleUniform,
}

/// Render-world cost of the last extract + upload (µs), readable from the main world.
#[derive(Resource, Clone, Default, Debug)]
pub struct GpuTiming(pub Arc<AtomicU32>);

impl GpuTiming {
    pub fn upload_us(&self) -> u32 {
        self.0.load(Ordering::Relaxed)
    }
}

pub const SHADER: Handle<Shader> = bevy::asset::uuid_handle!("0f6c3b2e-7a51-4d0e-9c1f-5e2a8b4d7c11");

pub(super) fn build(app: &mut App) {
    let _ = app
        .world_mut()
        .resource_mut::<Assets<Shader>>()
        .insert(SHADER.id(), Shader::from_wgsl(include_str!("particle.wgsl"), "engine/vfx/particle.wgsl"));
    let timing = GpuTiming::default();
    app.insert_resource(timing.clone());
    let Some(render_app) = app.get_sub_app_mut(RenderApp) else { return };
    render_app
        .insert_resource(timing)
        .init_resource::<SpriteBuffers>()
        .init_resource::<SpriteMaterials>()
        .init_gpu_resource::<SpecializedRenderPipelines<SpritePipeline>>()
        .add_render_command::<Transparent3d, DrawParticles>()
        .add_systems(RenderStartup, init_pipeline.after(MeshPipelineSystems))
        .add_systems(ExtractSchedule, extract)
        .add_systems(Render, (upload.in_set(RenderSystems::PrepareResources), bind_materials.in_set(RenderSystems::PrepareBindGroups), queue.in_set(RenderSystems::Queue)));
}

struct Batch {
    main: MainEntity,
    range: Range<u32>,
    center: Vec3,
    material: usize,
}

#[derive(Resource)]
struct SpriteBuffers {
    instances: RawBufferVec<SpriteInstance>,
    batches: Vec<Batch>,
    by_entity: HashMap<MainEntity, usize>,
    extract_us: f32,
}

impl Default for SpriteBuffers {
    fn default() -> Self {
        let mut instances = RawBufferVec::new(BufferUsages::VERTEX);
        instances.set_label(Some("vfx sprite instances"));
        SpriteBuffers { instances, batches: Vec::new(), by_entity: HashMap::default(), extract_us: 0.0 }
    }
}

#[derive(Resource, Default)]
struct SpriteMaterials {
    keys: Vec<SpriteMaterial>,
    bind_groups: Vec<Option<BindGroup>>,
}

#[derive(Resource)]
pub struct SpritePipeline {
    mesh_pipeline: MeshPipeline,
    layout: BindGroupLayoutDescriptor,
}

fn init_pipeline(mut commands: Commands, mesh_pipeline: Res<MeshPipeline>) {
    let layout = BindGroupLayoutDescriptor::new(
        "vfx sprite material",
        &BindGroupLayoutEntries::sequential(
            ShaderStages::VERTEX_FRAGMENT,
            (uniform_buffer::<ParticleUniform>(false), texture_2d(TextureSampleType::Float { filterable: true }), sampler(SamplerBindingType::Filtering)),
        ),
    );
    commands.insert_resource(SpritePipeline { mesh_pipeline: mesh_pipeline.clone(), layout });
}

impl SpecializedRenderPipeline for SpritePipeline {
    type Key = MeshPipelineKey;

    fn specialize(&self, key: Self::Key) -> RenderPipelineDescriptor {
        let mut defs: Vec<ShaderDefVal> = Vec::new();
        if key.msaa_samples() > 1 {
            defs.push("MULTISAMPLED".into());
        }
        if key.contains(MeshPipelineKey::DEPTH_PREPASS) {
            defs.push("DEPTH_PREPASS".into());
        }
        if key.contains(MeshPipelineKey::DISTANCE_FOG) {
            defs.push("DISTANCE_FOG".into());
        }
        if key.contains(MeshPipelineKey::TONEMAP_IN_SHADER) {
            defs.push("TONEMAP_IN_SHADER".into());
            defs.push(ShaderDefVal::UInt("TONEMAPPING_LUT_TEXTURE_BINDING_INDEX".into(), TONEMAPPING_LUT_TEXTURE_BINDING_INDEX));
            defs.push(ShaderDefVal::UInt("TONEMAPPING_LUT_SAMPLER_BINDING_INDEX".into(), TONEMAPPING_LUT_SAMPLER_BINDING_INDEX));
            let method = key.intersection(MeshPipelineKey::TONEMAP_METHOD_RESERVED_BITS);
            let name = [
                (MeshPipelineKey::TONEMAP_METHOD_NONE, "TONEMAP_METHOD_NONE"),
                (MeshPipelineKey::TONEMAP_METHOD_REINHARD, "TONEMAP_METHOD_REINHARD"),
                (MeshPipelineKey::TONEMAP_METHOD_REINHARD_LUMINANCE, "TONEMAP_METHOD_REINHARD_LUMINANCE"),
                (MeshPipelineKey::TONEMAP_METHOD_ACES_FITTED, "TONEMAP_METHOD_ACES_FITTED"),
                (MeshPipelineKey::TONEMAP_METHOD_AGX, "TONEMAP_METHOD_AGX"),
                (MeshPipelineKey::TONEMAP_METHOD_SOMEWHAT_BORING_DISPLAY_TRANSFORM, "TONEMAP_METHOD_SOMEWHAT_BORING_DISPLAY_TRANSFORM"),
                (MeshPipelineKey::TONEMAP_METHOD_TONY_MC_MAPFACE, "TONEMAP_METHOD_TONY_MC_MAPFACE"),
                (MeshPipelineKey::TONEMAP_METHOD_BLENDER_FILMIC, "TONEMAP_METHOD_BLENDER_FILMIC"),
                (MeshPipelineKey::TONEMAP_METHOD_PBR_NEUTRAL, "TONEMAP_METHOD_PBR_NEUTRAL"),
            ]
            .into_iter()
            .find(|(k, _)| *k == method)
            .map(|(_, n)| n);
            if let Some(n) = name {
                defs.push(n.into());
            }
        }
        let view_layout = self.mesh_pipeline.get_view_layout(key.into());
        let f4 = VertexFormat::Float32x4;
        RenderPipelineDescriptor {
            label: Some("vfx sprites".into()),
            layout: vec![view_layout.main_layout.clone(), view_layout.binding_array_layout.clone(), self.layout.clone()],
            vertex: VertexState {
                shader: SHADER,
                shader_defs: defs.clone(),
                entry_point: Some("vertex".into()),
                buffers: vec![VertexBufferLayout {
                    array_stride: core::mem::size_of::<SpriteInstance>() as u64,
                    step_mode: VertexStepMode::Instance,
                    attributes: vec![
                        VertexAttribute { format: f4, offset: 0, shader_location: 0 },
                        VertexAttribute { format: f4, offset: 16, shader_location: 1 },
                        VertexAttribute { format: f4, offset: 32, shader_location: 2 },
                        VertexAttribute { format: VertexFormat::Unorm8x4, offset: 48, shader_location: 3 },
                    ],
                }],
            },
            fragment: Some(FragmentState {
                shader: SHADER,
                shader_defs: defs,
                entry_point: Some("fragment".into()),
                targets: vec![Some(ColorTargetState { format: key.target_format(), blend: Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: ColorWrites::ALL })],
            }),
            primitive: PrimitiveState { topology: PrimitiveTopology::TriangleStrip, cull_mode: None, ..default() },
            depth_stencil: Some(DepthStencilState {
                format: CORE_3D_DEPTH_FORMAT,
                depth_write_enabled: Some(false),
                depth_compare: Some(CompareFunction::GreaterEqual),
                stencil: StencilState::default(),
                bias: DepthBiasState::default(),
            }),
            multisample: MultisampleState { count: key.msaa_samples(), mask: !0, alpha_to_coverage_enabled: false },
            ..default()
        }
    }
}

fn extract(mut buffers: ResMut<SpriteBuffers>, mut mats: ResMut<SpriteMaterials>, q: Extract<Query<&VfxInstance>>) {
    let t0 = Instant::now();
    let b = &mut *buffers;
    b.instances.clear();
    b.batches.clear();
    b.by_entity.clear();
    for inst in &q {
        for (d, &e) in inst.draws.iter().zip(&inst.renders) {
            let Some(mat) = d.material.as_ref().filter(|_| d.visible && !d.instances.is_empty() && e != Entity::PLACEHOLDER) else { continue };
            let material = match mats.keys.iter().position(|k| k == mat) {
                Some(i) => i,
                None => {
                    mats.keys.push(mat.clone());
                    mats.bind_groups.push(None);
                    mats.keys.len() - 1
                }
            };
            let start = b.instances.len() as u32;
            b.instances.values_mut().extend_from_slice(&d.instances);
            let main = MainEntity::from(e);
            b.by_entity.insert(main, b.batches.len());
            b.batches.push(Batch { main, range: start..b.instances.len() as u32, center: d.center, material });
        }
    }
    b.extract_us = t0.elapsed().as_secs_f32() * 1e6;
}

fn upload(mut buffers: ResMut<SpriteBuffers>, device: Res<RenderDevice>, queue: Res<RenderQueue>, timing: Res<GpuTiming>) {
    let t0 = Instant::now();
    if !buffers.instances.is_empty() {
        buffers.instances.write_buffer(&device, &queue);
    }
    let us = buffers.extract_us + t0.elapsed().as_secs_f32() * 1e6;
    timing.0.store(us as u32, Ordering::Relaxed);
}

fn bind_materials(
    mut mats: ResMut<SpriteMaterials>,
    pipeline: Option<Res<SpritePipeline>>,
    cache: Res<PipelineCache>,
    device: Res<RenderDevice>,
    queue: Res<RenderQueue>,
    images: Res<RenderAssets<GpuImage>>,
) {
    let Some(pipeline) = pipeline else { return };
    let mats = &mut *mats;
    for (key, bg) in mats.keys.iter().zip(mats.bind_groups.iter_mut()) {
        if bg.is_some() {
            continue;
        }
        let Some(image) = images.get(key.texture) else { continue };
        let mut uniform = UniformBuffer::from(key.params);
        uniform.write_buffer(&device, &queue);
        let Some(binding) = uniform.binding() else { continue };
        *bg = Some(device.create_bind_group(
            "vfx sprite material",
            &cache.get_bind_group_layout(&pipeline.layout),
            &BindGroupEntries::sequential((binding, &image.texture_view, &image.sampler)),
        ));
    }
}

fn queue(
    draw_functions: Res<DrawFunctions<Transparent3d>>,
    pipeline: Option<Res<SpritePipeline>>,
    mut pipelines: ResMut<SpecializedRenderPipelines<SpritePipeline>>,
    cache: Res<PipelineCache>,
    buffers: Res<SpriteBuffers>,
    mats: Res<SpriteMaterials>,
    mut phases: ResMut<ViewSortedRenderPhases<Transparent3d>>,
    views: Query<&ExtractedView>,
    view_keys: Res<ViewKeyCache>,
) {
    let Some(pipeline) = pipeline else { return };
    if buffers.batches.is_empty() {
        return;
    }
    let Some(draw) = draw_functions.read().get_id::<DrawParticles>() else { return };
    for view in &views {
        let Some(phase) = phases.get_mut(&view.retained_view_entity) else { continue };
        let Some(&view_key) = view_keys.get(&view.retained_view_entity) else { continue };
        let id = pipelines.specialize(&cache, &pipeline, view_key);
        for b in &buffers.batches {
            if mats.bind_groups.get(b.material).and_then(|x| x.as_ref()).is_none() {
                continue;
            }
            phase.add_transient(Transparent3d {
                sorting_info: TransparentSortingInfo3d::Sorted { mesh_center: b.center, depth_bias: 0.0 },
                distance: 0.0,
                pipeline: id,
                entity: (Entity::PLACEHOLDER, b.main),
                draw_function: draw,
                batch_range: 0..1,
                extra_index: PhaseItemExtraIndex::None,
                indexed: false,
            });
        }
    }
}

type DrawParticles = (SetItemPipeline, SetMeshViewBindGroup<0>, SetMeshViewBindingArrayBindGroup<1>, DrawSprites);

struct DrawSprites;

impl<P: PhaseItem> RenderCommand<P> for DrawSprites {
    type Param = (SRes<SpriteBuffers>, SRes<SpriteMaterials>);
    type ViewQuery = ();
    type ItemQuery = ();

    fn render<'w>(
        item: &P,
        _view: ROQueryItem<'w, '_, Self::ViewQuery>,
        _entity: Option<ROQueryItem<'w, '_, Self::ItemQuery>>,
        (buffers, mats): SystemParamItem<'w, '_, Self::Param>,
        pass: &mut TrackedRenderPass<'w>,
    ) -> RenderCommandResult {
        let (buffers, mats) = (buffers.into_inner(), mats.into_inner());
        let Some(&i) = buffers.by_entity.get(&item.main_entity()) else { return RenderCommandResult::Skip };
        let b = &buffers.batches[i];
        let (Some(buffer), Some(Some(bg))) = (buffers.instances.buffer(), mats.bind_groups.get(b.material)) else {
            return RenderCommandResult::Skip;
        };
        pass.set_bind_group(2, bg, &[]);
        pass.set_vertex_buffer(0, buffer.slice(..));
        pass.draw(0..4, b.range.clone());
        RenderCommandResult::Success
    }
}
