//! HLOD: each cell's prefabs merged per material into one mesh, simplified by vertex clustering
//! (positions snapped to a `voxel` grid, split by dominant normal direction so hard edges
//! survive), built in background tasks right after the world spawns. Beyond
//! [`super::HlodSettings::distance`] a cell's prefabs are hidden and its proxies drawn (one draw
//! per material instead of one per part); in streamed mode the proxies stay when the cell's
//! prefabs unload, so far towns stay on the horizon at a few KB each.
//!
//! [`merge_meshes`] and [`simplify_clustered`] are plain functions games can use for their own
//! merged meshes (scatter clusters use [`merge_meshes`] too).

use std::sync::Arc;

use bevy::asset::RenderAssetUsages;
use bevy::camera::primitives::{Aabb, MeshAabb};
use bevy::camera::visibility::NoAutoAabb;
use bevy::light::NotShadowCaster;
use bevy::math::Affine3A;
use bevy::mesh::{Indices, PrimitiveTopology, VertexAttributeValues};
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use bevy::tasks::{AsyncComputeTaskPool, Task, futures::check_ready};

use super::cells::{CellState, WorldCells};
use super::{WorldCpu, WorldOrigin, WorldRoot, WorldSettings, WorldStats, WorldSystems};
use crate::gfx::MainCamera;
use crate::render_budget::{KeepDetail, Scenery};

fn positions(m: &Mesh) -> Option<&Vec<[f32; 3]>> {
    match m.attribute(Mesh::ATTRIBUTE_POSITION) {
        Some(VertexAttributeValues::Float32x3(p)) => Some(p),
        _ => None,
    }
}

/// Merges triangle-list meshes, each with a transform and an RGBA tint (multiplied into its
/// vertex colours, white if it has none), into one mesh with positions, normals, colours and
/// (when every part has them) UVs.
pub fn merge_meshes<'a>(parts: impl IntoIterator<Item = (&'a Mesh, Affine3A, [f32; 4])>) -> Mesh {
    let mut pos: Vec<[f32; 3]> = Vec::new();
    let mut nrm: Vec<[f32; 3]> = Vec::new();
    let mut col: Vec<[f32; 4]> = Vec::new();
    let mut uv: Vec<[f32; 2]> = Vec::new();
    let mut all_uv = true;
    let mut idx: Vec<u32> = Vec::new();
    for (m, tf, tint) in parts {
        if m.primitive_topology() != PrimitiveTopology::TriangleList {
            continue;
        }
        let Some(p) = positions(m) else { continue };
        let base = pos.len() as u32;
        let nm = Mat3::from(tf.matrix3).inverse().transpose();
        pos.extend(p.iter().map(|v| tf.transform_point3(Vec3::from(*v)).to_array()));
        match m.attribute(Mesh::ATTRIBUTE_NORMAL) {
            Some(VertexAttributeValues::Float32x3(n)) => nrm.extend(n.iter().map(|v| (nm * Vec3::from(*v)).normalize_or(Vec3::Y).to_array())),
            _ => nrm.extend(std::iter::repeat_n([0.0, 1.0, 0.0], p.len())),
        }
        match m.attribute(Mesh::ATTRIBUTE_COLOR) {
            Some(VertexAttributeValues::Float32x4(c)) => col.extend(c.iter().map(|c| [c[0] * tint[0], c[1] * tint[1], c[2] * tint[2], c[3] * tint[3]])),
            _ => col.extend(std::iter::repeat_n(tint, p.len())),
        }
        match m.attribute(Mesh::ATTRIBUTE_UV_0) {
            Some(VertexAttributeValues::Float32x2(u)) if all_uv => uv.extend_from_slice(u),
            _ => all_uv = false,
        }
        match m.indices() {
            Some(Indices::U16(ix)) => idx.extend(ix.iter().map(|&i| base + i as u32)),
            Some(Indices::U32(ix)) => idx.extend(ix.iter().map(|&i| base + i)),
            None => idx.extend(base..base + p.len() as u32),
        }
    }
    let mut out = Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, nrm)
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, col);
    if all_uv && !uv.is_empty() {
        out.insert_attribute(Mesh::ATTRIBUTE_UV_0, uv);
    }
    out.with_inserted_indices(Indices::U32(idx))
}

/// Vertex-clustering simplification: vertices in the same `voxel`-sized cell that face the
/// same dominant axis direction collapse into one (averaged), degenerate triangles are dropped.
/// Cheap (one pass), robust on any triangle soup, keeps hard edges of boxy shapes.
pub fn simplify_clustered(mesh: &Mesh, voxel: f32) -> Mesh {
    let Some(p) = positions(mesh) else { return mesh.clone() };
    let n: Vec<Vec3> = match mesh.attribute(Mesh::ATTRIBUTE_NORMAL) {
        Some(VertexAttributeValues::Float32x3(n)) => n.iter().map(|v| Vec3::from(*v)).collect(),
        _ => vec![Vec3::Y; p.len()],
    };
    let c: Vec<[f32; 4]> = match mesh.attribute(Mesh::ATTRIBUTE_COLOR) {
        Some(VertexAttributeValues::Float32x4(c)) => c.clone(),
        _ => vec![[1.0; 4]; p.len()],
    };
    let idx: Vec<u32> = match mesh.indices() {
        Some(Indices::U16(ix)) => ix.iter().map(|&i| i as u32).collect(),
        Some(Indices::U32(ix)) => ix.clone(),
        None => (0..p.len() as u32).collect(),
    };
    let inv = 1.0 / voxel.max(1e-4);
    let bucket = |n: Vec3| -> u8 {
        let a = n.abs();
        if a.x >= a.y && a.x >= a.z {
            (n.x < 0.0) as u8
        } else if a.y >= a.z {
            2 + (n.y < 0.0) as u8
        } else {
            4 + (n.z < 0.0) as u8
        }
    };
    let mut map: HashMap<(IVec3, u8), u32> = HashMap::default();
    let mut remap = vec![0u32; p.len()];
    // Accumulators per cluster: position sum, normal sum, colour sum, count.
    let mut acc: Vec<(Vec3, Vec3, Vec4, f32)> = Vec::new();
    for (i, v) in p.iter().enumerate() {
        let v = Vec3::from(*v);
        let key = ((v * inv).floor().as_ivec3(), bucket(n[i]));
        let id = *map.entry(key).or_insert_with(|| {
            acc.push((Vec3::ZERO, Vec3::ZERO, Vec4::ZERO, 0.0));
            acc.len() as u32 - 1
        });
        let a = &mut acc[id as usize];
        a.0 += v;
        a.1 += n[i];
        a.2 += Vec4::from(c[i]);
        a.3 += 1.0;
        remap[i] = id;
    }
    let mut out_idx = Vec::with_capacity(idx.len());
    for t in idx.chunks_exact(3) {
        let (a, b, cc) = (remap[t[0] as usize], remap[t[1] as usize], remap[t[2] as usize]);
        if a != b && b != cc && a != cc {
            out_idx.extend_from_slice(&[a, b, cc]);
        }
    }
    let pos: Vec<[f32; 3]> = acc.iter().map(|a| (a.0 / a.3).to_array()).collect();
    let nrm: Vec<[f32; 3]> = acc.iter().map(|a| a.1.normalize_or(Vec3::Y).to_array()).collect();
    let col: Vec<[f32; 4]> = acc.iter().map(|a| (a.2 / a.3).to_array()).collect();
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, nrm)
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, col)
        .with_inserted_indices(Indices::U32(out_idx))
}

/// One cell's HLOD input: (material key, part mesh, transform relative to the cell corner).
pub(crate) type HlodInput = Vec<(String, Arc<Mesh>, Affine3A)>;

/// Built proxies of a cell: (material key, mesh, source vertices).
type HlodOutput = Vec<(String, Mesh, usize)>;

/// Merges and simplifies one cell's parts per material.
pub fn build_cell_hlod(parts: &[(String, Arc<Mesh>, Affine3A)], voxel: f32) -> Vec<(String, Mesh, usize)> {
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, (k, _, _)) in parts.iter().enumerate() {
        match groups.iter_mut().find(|g| &g.0 == k) {
            Some(g) => g.1.push(i),
            None => groups.push((k.clone(), vec![i])),
        }
    }
    groups
        .into_iter()
        .map(|(k, ids)| {
            let merged = merge_meshes(ids.iter().map(|&i| (&*parts[i].1, parts[i].2, [1.0; 4])));
            let src = merged.count_vertices();
            (k, simplify_clustered(&merged, voxel), src)
        })
        .collect()
}

enum CellHlod {
    Pending(Task<HlodOutput>),
    /// Proxy entities (spawned when rendering), vertex counts.
    Ready { entities: Vec<Entity>, verts: usize, src: usize, far: bool },
}

/// Runtime HLOD state per cell.
#[derive(Resource, Default)]
pub struct HlodState {
    cells: HashMap<IVec2, CellHlod>,
    /// Built meshes kept for inspection/tests: (cell, material key, vertices).
    pub built: Vec<(IVec2, String, usize)>,
}

impl HlodState {
    /// Starts background builds for `inputs` (cell → parts).
    pub(crate) fn start(&mut self, inputs: Vec<(IVec2, HlodInput)>, voxel: f32) {
        let pool = AsyncComputeTaskPool::get();
        for (cell, parts) in inputs {
            if parts.is_empty() {
                continue;
            }
            self.cells.insert(cell, CellHlod::Pending(pool.spawn(async move { build_cell_hlod(&parts, voxel) })));
        }
    }
    pub fn pending(&self) -> usize {
        self.cells.values().filter(|c| matches!(c, CellHlod::Pending(_))).count()
    }
    /// Cell has proxies and they are showing.
    pub fn is_far(&self, cell: IVec2) -> bool {
        matches!(self.cells.get(&cell), Some(CellHlod::Ready { far: true, .. }))
    }
    pub fn has_proxy(&self, cell: IVec2) -> bool {
        matches!(self.cells.get(&cell), Some(CellHlod::Ready { .. }))
    }
}

pub(super) struct HlodPlugin;

impl Plugin for HlodPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<HlodState>().add_systems(PostUpdate, (finish_builds, switch_tiers).chain().in_set(WorldSystems::Hlod));
    }
}

fn finish_builds(
    mut commands: Commands,
    mut state: ResMut<HlodState>,
    cells: Option<Res<WorldCells>>,
    roots: Query<Entity, With<WorldRoot>>,
    mut assets: ResMut<super::WorldAssets>,
    mut meshes: Option<ResMut<Assets<Mesh>>>,
    mut mats: Option<ResMut<Assets<StandardMaterial>>>,
    cpu: Res<WorldCpu>,
) {
    let _t = cpu.time();
    let Some(cells) = cells else { return };
    let root = roots.iter().next();
    let state = &mut *state;
    for (cell, h) in state.cells.iter_mut() {
        let CellHlod::Pending(task) = h else { continue };
        let Some(out) = check_ready(task) else { continue };
        let mut entities = Vec::new();
        let (mut verts, mut src) = (0, 0);
        for (key, mesh, s) in out {
            verts += mesh.count_vertices();
            src += s;
            state.built.push((*cell, key.clone(), mesh.count_vertices()));
            if let (Some(meshes), Some(mats), Some(root)) = (meshes.as_mut(), mats.as_mut(), root) {
                let aabb = mesh.compute_aabb();
                let mut mesh = mesh;
                mesh.asset_usage = RenderAssetUsages::RENDER_WORLD;
                let corner = cells.cell_min(*cell);
                let mut e = commands.spawn((
                    Name::new(format!("hlod {} {} {key}", cell.x, cell.y)),
                    Mesh3d(meshes.add(mesh)),
                    MeshMaterial3d(assets.material(&key, mats)),
                    Transform::from_xyz(corner.x, 0.0, corner.y),
                    Visibility::Hidden,
                    NotShadowCaster,
                    Scenery,
                    KeepDetail,
                    ChildOf(root),
                ));
                if let Some(a) = aabb {
                    e.insert((a, NoAutoAabb));
                } else {
                    e.insert(Aabb::default());
                }
                entities.push(e.id());
            }
        }
        *h = CellHlod::Ready { entities, verts, src, far: false };
    }
}

/// Near cells show their prefabs, far ones their proxies (hysteresis band in between).
fn switch_tiers(
    settings: Res<WorldSettings>,
    mut state: ResMut<HlodState>,
    cells: Option<Res<WorldCells>>,
    origin: Res<WorldOrigin>,
    cams: Query<&GlobalTransform, With<MainCamera>>,
    mut vis: Query<&mut Visibility>,
    mut stats: ResMut<WorldStats>,
    cpu: Res<WorldCpu>,
) {
    let _t = cpu.time();
    let Some(cells) = cells else { return };
    let s = &settings.hlod;
    let eye = super::camera_abs(&cams, &origin);
    let (mut proxies, mut far_cells, mut verts, mut src) = (0, 0, 0u64, 0u64);
    for (cell, h) in state.cells.iter_mut() {
        let CellHlod::Ready { entities, verts: v, src: sv, far } = h else { continue };
        proxies += entities.len() as u32;
        verts += *v as u64;
        src += *sv as u64;
        let Some(eye) = eye else { continue };
        let d = cells.distance(*cell, eye.xz());
        let want_far = s.enabled && if *far { d > s.distance - s.hysteresis } else { d > s.distance };
        let show_proxy = want_far && d < s.view;
        if want_far != *far || entities.first().and_then(|e| vis.get(*e).ok()).is_some_and(|v| (*v != Visibility::Hidden) != show_proxy) {
            *far = want_far;
            for &e in entities.iter() {
                if let Ok(mut v) = vis.get_mut(e) {
                    v.set_if_neq(if show_proxy { Visibility::Inherited } else { Visibility::Hidden });
                }
            }
        }
        if let CellState::Loaded(root) = cells.state(*cell)
            && let Ok(mut v) = vis.get_mut(root)
        {
            v.set_if_neq(if *far { Visibility::Hidden } else { Visibility::Inherited });
        }
        far_cells += *far as u32;
    }
    stats.hlod_proxies = proxies;
    stats.hlod_pending = state.pending() as u32;
    stats.hlod_vertices = verts;
    stats.hlod_source_vertices = src;
    stats.hlod_cells_far = far_cells;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_every_vertex_and_transforms() {
        let cube: Mesh = Cuboid::new(1.0, 1.0, 1.0).into();
        let n = cube.count_vertices();
        let m = merge_meshes([
            (&cube, Affine3A::from_translation(Vec3::new(10.0, 0.0, 0.0)), [1.0; 4]),
            (&cube, Affine3A::from_scale(Vec3::splat(2.0)), [0.5, 0.5, 0.5, 1.0]),
        ]);
        assert_eq!(m.count_vertices(), 2 * n);
        assert_eq!(m.indices().unwrap().len(), 2 * cube.indices().unwrap().len());
        let p = positions(&m).unwrap();
        assert!(p[..n].iter().all(|v| (9.5..=10.5).contains(&v[0])));
        assert!(p[n..].iter().all(|v| v[0].abs() <= 1.0 + 1e-6));
        let Some(VertexAttributeValues::Float32x4(c)) = m.attribute(Mesh::ATTRIBUTE_COLOR) else { panic!() };
        assert_eq!(c[n], [0.5, 0.5, 0.5, 1.0]);
        assert!(m.attribute(Mesh::ATTRIBUTE_UV_0).is_some());
    }

    #[test]
    fn clustering_reduces_dense_meshes_and_keeps_boxes() {
        let sphere = Sphere::new(1.0).mesh().ico(8).unwrap();
        let before = sphere.count_vertices();
        let s = simplify_clustered(&sphere, 0.5);
        assert!(s.count_vertices() * 4 < before, "{} → {}", before, s.count_vertices());
        assert!(!s.indices().unwrap().is_empty());
        // A 4 m box with 1 m voxels keeps its 24 corner vertices (6 faces × 4) and 12 triangles.
        let cube: Mesh = Cuboid::new(4.0, 4.0, 4.0).into();
        let b = simplify_clustered(&cube, 1.0);
        assert_eq!(b.count_vertices(), 24);
        assert_eq!(b.indices().unwrap().len(), 36);
    }
}
