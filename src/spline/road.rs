//! A generic road ribbon for games without their own mesh builder, and [`SplineRoad`], which
//! keeps a child mesh in sync with the spline.

use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;

use super::{Spline, SplineCache, SplineChanged};
use crate::render_budget::Scenery;

/// Ribbon mesh following the spline's width and bank, in the spline's local space.
/// A vertex pair every `step` metres (or fewer on short splines); `v = distance / uv_scale`
/// (`uv_scale` is metres per texture repeat), `u` runs 0..1 from the left to the right edge.
/// Normals are the banked up-vector, tangents point right (increasing `u`). Empty mesh for
/// splines shorter than two points.
pub fn ribbon_mesh(spline: &Spline, step: f32, uv_scale: f32) -> Mesh {
    ribbon_mesh_with(spline, &SplineCache::build(spline), step, uv_scale)
}

/// [`ribbon_mesh`] with an existing cache.
pub fn ribbon_mesh_with(spline: &Spline, cache: &SplineCache, step: f32, uv_scale: f32) -> Mesh {
    let len = cache.length();
    let mut pos = Vec::new();
    let mut nrm = Vec::new();
    let mut uv = Vec::new();
    let mut tan = Vec::new();
    let mut idx = Vec::new();
    if len > 0.0 && spline.points.len() >= 2 {
        let step = if step.is_finite() && step > 0.01 { step } else { 1.0 };
        let n = ((len / step).ceil() as usize).clamp(1, 200_000);
        let tile = if uv_scale.is_finite() && uv_scale > 0.0 { uv_scale } else { 1.0 };
        for i in 0..=n {
            let d = len * i as f32 / n as f32;
            let Some(s) = cache.sample_at(spline, d) else { break };
            let half = s.right * s.width * 0.5;
            let v = d / tile;
            for (side, p) in [(0.0, s.pos - half), (1.0, s.pos + half)] {
                pos.push(p.to_array());
                nrm.push(s.up.to_array());
                uv.push([side, v]);
                tan.push([s.right.x, s.right.y, s.right.z, 1.0]);
            }
        }
        for i in 0..(pos.len() / 2).saturating_sub(1) as u32 {
            let (l0, r0, l1, r1) = (i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 3);
            idx.extend_from_slice(&[l0, r0, l1, r0, r1, l1]);
        }
    }
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, nrm)
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, uv)
        .with_inserted_attribute(Mesh::ATTRIBUTE_TANGENT, tan)
        .with_inserted_indices(Indices::U32(idx))
}

/// Put next to a [`Spline`]: a child entity with the ribbon mesh is created and rebuilt on every
/// [`SplineChanged`] (and when this component changes).
#[derive(Component, Reflect, Clone, Debug, PartialEq)]
#[reflect(Component, Default)]
pub struct SplineRoad {
    /// Metres between cross sections.
    pub step: f32,
    /// Metres of road per texture repeat.
    pub uv_scale: f32,
    pub color: Color,
}

impl Default for SplineRoad {
    fn default() -> Self {
        SplineRoad { step: 2.0, uv_scale: 8.0, color: Color::srgb(0.22, 0.22, 0.24) }
    }
}

/// Runtime link from a [`SplineRoad`] to its generated child (never saved).
#[derive(Component, Clone, Debug)]
pub struct SplineRoadMesh {
    pub child: Entity,
    pub mesh: Handle<Mesh>,
    pub material: Handle<StandardMaterial>,
}

pub(crate) fn sync_roads(
    mut commands: Commands,
    mut changed: MessageReader<SplineChanged>,
    new_roads: Query<Entity, Changed<SplineRoad>>,
    roads: Query<(&Spline, &SplineCache, &SplineRoad, Option<&SplineRoadMesh>)>,
    orphans: Query<(Entity, &SplineRoadMesh), Without<SplineRoad>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: Option<ResMut<Assets<StandardMaterial>>>,
) {
    for (e, link) in &orphans {
        commands.entity(link.child).despawn();
        commands.entity(e).remove::<SplineRoadMesh>();
    }
    let mut todo: Vec<Entity> = changed.read().map(|c| c.entity).chain(new_roads.iter()).collect();
    todo.sort();
    todo.dedup();
    for e in todo {
        let Ok((spline, cache, road, link)) = roads.get(e) else { continue };
        let mesh = ribbon_mesh_with(spline, cache, road.step, road.uv_scale);
        if let Some(link) = link {
            let _ = meshes.insert(link.mesh.id(), mesh);
            if let Some(mats) = mats.as_mut()
                && let Some(mut m) = mats.get_mut(&link.material)
                && m.base_color != road.color
            {
                m.base_color = road.color;
            }
        } else if let Some(mats) = mats.as_mut() {
            let mesh = meshes.add(mesh);
            let material = mats.add(StandardMaterial { base_color: road.color, perceptual_roughness: 0.9, ..default() });
            let child = commands
                .spawn((Name::new("Road mesh"), Mesh3d(mesh.clone()), MeshMaterial3d(material.clone()), Transform::default(), Scenery, ChildOf(e)))
                .id();
            commands.entity(e).insert(SplineRoadMesh { child, mesh, material });
        }
    }
}
