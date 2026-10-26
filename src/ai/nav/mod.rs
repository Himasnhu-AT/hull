//! Navigation meshes: baking ([`bake`]), the tiled mesh ([`mesh`]), queries ([`query`]) and the
//! ECS side (sources, background baking, path queue: [`sources`], [`paths`]).

pub mod bake;
pub mod geometry;
pub mod mesh;
pub mod paths;
pub mod query;
pub mod sources;

pub use bake::{BakeStats, bake_mesh, bake_tiles};
pub use geometry::NavGeometry;
pub use mesh::{Link, NavMesh, NavTile, OffMeshLink, Poly, PolyRef};
pub use query::{NavPath, NavQuery, NavRayHit, PathError, PathPoint, move_along_surface, random_point, random_point_around, raycast};

/// Bake parameters for one agent type (Recast's `rcConfig`, in metres and degrees).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct NavMeshSettings {
    /// Name shown in debug output.
    pub name: String,
    /// Voxel size in XZ. ~radius / 2 is a good start.
    pub cell_size: f32,
    /// Voxel size in Y.
    pub cell_height: f32,
    pub agent_radius: f32,
    pub agent_height: f32,
    /// Highest step an agent walks up.
    pub agent_climb: f32,
    pub max_slope_deg: f32,
    /// Tile edge in cells. Smaller tiles rebake faster; bigger ones give fewer polys.
    pub tile_size: u32,
    /// Height error allowed when merging cells into one poly.
    pub flatness: f32,
    /// Max poly edge in cells (0 = up to the tile size).
    pub max_poly_cells: u32,
    pub filter_ledges: bool,
    pub filter_low_hanging: bool,
}

impl Default for NavMeshSettings {
    fn default() -> Self {
        NavMeshSettings {
            name: "default".into(),
            cell_size: 0.2,
            cell_height: 0.1,
            agent_radius: 0.4,
            agent_height: 1.8,
            agent_climb: 0.4,
            max_slope_deg: 45.0,
            tile_size: 48,
            flatness: 0.25,
            max_poly_cells: 0,
            filter_ledges: true,
            filter_low_hanging: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::math::{Vec2, Vec3};

    fn floor(size: f32) -> NavGeometry {
        let mut g = NavGeometry::new();
        g.push_box(Vec3::new(0.0, -0.5, 0.0), Vec3::new(size, 0.5, size));
        g
    }

    #[test]
    fn flat_floor_bakes_few_polys_and_eroded_bounds() {
        let mut g = floor(10.0);
        let s = NavMeshSettings::default();
        let (mesh, stats) = bake_mesh(&s, &mut g);
        assert!(mesh.poly_count() > 0, "{stats:?}");
        // 20 x 20 m minus the radius border on every side (ledge + erosion).
        let (lo, hi) = mesh.bounds().unwrap();
        assert!((lo.y - 0.0).abs() < 0.15 && (hi.y - 0.0).abs() < 0.15, "floor height {lo} {hi}");
        assert!(lo.x > -10.0 && lo.x < -9.0 && hi.x < 10.0 && hi.x > 9.0, "eroded x {lo} {hi}");
        let area = mesh.area();
        assert!(area > 17.0 * 17.0 && area < 20.0 * 20.0, "area {area}");
        // Flat floor: polys are tile-sized rectangles (≈ one per tile).
        assert!(mesh.poly_count() <= mesh.tile_count() * 2, "{} polys in {} tiles", mesh.poly_count(), mesh.tile_count());
    }

    #[test]
    fn path_across_tiles_is_straight() {
        let mut g = floor(20.0);
        let s = NavMeshSettings::default();
        let (mesh, _) = bake_mesh(&s, &mut g);
        assert!(mesh.tile_count() > 4);
        let mut q = NavQuery::new();
        let p = q.find_path(&mesh, Vec3::new(-15.0, 0.0, -15.0), Vec3::new(15.0, 0.0, 15.0), Vec3::new(2.0, 2.0, 2.0), 4096).unwrap();
        assert!(p.complete);
        let straight = (30.0f32 * 30.0 * 2.0).sqrt();
        assert!((p.length() - straight).abs() < 0.05, "len {} vs {}", p.length(), straight);
        assert_eq!(p.points.len(), 2, "{:?}", p.points);
    }

    #[test]
    fn path_goes_around_wall() {
        let mut g = floor(20.0);
        // Wall along x = 0 from z = -20 to z = 10 (gap at z > 10).
        g.push_box(Vec3::new(0.0, 1.0, -5.0), Vec3::new(0.25, 1.0, 15.0));
        let s = NavMeshSettings::default();
        let (mesh, _) = bake_mesh(&s, &mut g);
        let mut q = NavQuery::new();
        let a = Vec3::new(-5.0, 0.0, 0.0);
        let b = Vec3::new(5.0, 0.0, 0.0);
        let p = q.find_path(&mesh, a, b, Vec3::splat(2.0), 8192).unwrap();
        assert!(p.complete);
        // Around the wall end at z ≈ 10 + radius: two straight legs.
        let corner = Vec3::new(0.0, 0.0, 10.65);
        let expect = a.distance(corner) + corner.distance(b);
        assert!(p.length() > 20.0 && (p.length() - expect).abs() < 0.8, "len {} expect {expect} pts {:?}", p.length(), p.points);
        // Raycast straight through is blocked by the wall.
        let (sr, sp) = mesh.nearest_poly(a, Vec3::splat(1.0)).unwrap();
        let hit = raycast(&mesh, sr, sp, b);
        assert!(hit.hit && hit.point.x < 0.0 && hit.point.x > -1.0, "{hit:?}");
        assert!(hit.normal.x < 0.0);
        // Raycast along the open side is clear.
        let c = Vec3::new(-5.0, 0.0, 12.0);
        let (cr, cp) = mesh.nearest_poly(c, Vec3::splat(1.0)).unwrap();
        let h2 = raycast(&mesh, cr, cp, Vec3::new(5.0, 0.0, 12.0));
        assert!(!h2.hit, "{h2:?}");
        // Sliding into the wall stops at it.
        let (_, slid) = move_along_surface(&mesh, sr, sp, Vec3::new(1.0, 0.0, 0.5));
        assert!(slid.x < -0.5 && (slid.z - 0.5).abs() < 0.05, "slid {slid}");
    }

    #[test]
    fn unreachable_gives_partial_path() {
        let mut g = NavGeometry::new();
        g.push_box(Vec3::new(-10.0, -0.5, 0.0), Vec3::new(5.0, 0.5, 5.0));
        g.push_box(Vec3::new(10.0, -0.5, 0.0), Vec3::new(5.0, 0.5, 5.0));
        let s = NavMeshSettings::default();
        let (mesh, _) = bake_mesh(&s, &mut g);
        let mut q = NavQuery::new();
        let p = q.find_path(&mesh, Vec3::new(-10.0, 0.0, 0.0), Vec3::new(10.0, 0.0, 0.0), Vec3::splat(2.0), 4096).unwrap();
        assert!(!p.complete);
        assert!(p.end().unwrap().x < -5.0 + 0.01, "{:?}", p.end());
        // An off-mesh link (jump) joins the islands.
        let mut mesh = mesh;
        mesh.add_offmesh_link(OffMeshLink { start: Vec3::new(-5.8, 0.0, 0.0), end: Vec3::new(5.8, 0.0, 0.0), ..Default::default() });
        let p = q.find_path(&mesh, Vec3::new(-10.0, 0.0, 0.0), Vec3::new(10.0, 0.0, 0.0), Vec3::splat(2.0), 4096).unwrap();
        assert!(p.complete, "{:?}", p.points);
        assert!(p.points.iter().any(|pt| pt.offmesh == Some(0)), "{:?}", p.points);
        assert!((p.length() - 20.0).abs() < 0.2, "{}", p.length());
    }

    #[test]
    fn ramp_and_platform_reachable() {
        let mut g = floor(20.0);
        // Platform 2 m high at x in [6, 14], ramp from x = 0 to 6 rising 0 → 2.
        g.push_box(Vec3::new(10.0, 1.0, 0.0), Vec3::new(4.0, 1.0, 4.0));
        let ang = (2.0f32).atan2(6.0);
        let len = (36.0f32 + 4.0).sqrt();
        g.push_oriented_box(Vec3::new(3.0, 1.0 - 0.1, 0.0), Vec3::new(len * 0.5, 0.1, 2.0), bevy::math::Quat::from_rotation_z(ang));
        let s = NavMeshSettings::default();
        let (mesh, _) = bake_mesh(&s, &mut g);
        let top = Vec3::new(11.0, 2.0, 0.0);
        let (r, p) = mesh.nearest_poly(top, Vec3::new(1.0, 0.5, 1.0)).expect("platform top on mesh");
        assert!((p.y - 2.0).abs() < 0.2, "{p}");
        let mut q = NavQuery::new();
        let path = q.find_path(&mesh, Vec3::new(-5.0, 0.0, 0.0), top, Vec3::new(1.0, 0.5, 1.0), 8192).unwrap();
        assert!(path.complete, "{:?}", path.points);
        assert_eq!(*path.polys.last().unwrap(), r);
        // Random points are on the mesh.
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        use rand::SeedableRng;
        for _ in 0..50 {
            let (r, p) = random_point(&mesh, &mut rng).unwrap();
            assert!(mesh.poly(r).unwrap().contains_xz(p.x, p.z));
        }
        let _ = Vec2::ZERO;
    }

    #[test]
    fn rebake_tile_after_obstacle() {
        let mut g = floor(10.0);
        let s = NavMeshSettings::default();
        let (mut mesh, _) = bake_mesh(&s, &mut g);
        let area0 = mesh.area();
        // A 2 x 2 m crate appears: rebake only the tiles it touches.
        let mut g2 = g.clone();
        g2.push_box(Vec3::new(1.0, 1.0, 1.0), Vec3::new(1.0, 1.0, 1.0));
        g2.build_index(&s);
        let coords = geometry::tiles_in(&s, Vec2::new(0.0, 0.0), Vec2::new(2.0, 2.0));
        let out = bake_tiles(&s, mesh.origin_y, &g2, &coords);
        assert_eq!(out.stats.tiles as usize, coords.len());
        mesh.insert_tiles(out.tiles, &out.empty);
        let area1 = mesh.area();
        // Lost ≈ (2 + 2r)² of floor; the crate top is ≤ 2 m² walkable after erosion.
        assert!(area0 - area1 > 4.0, "{area0} -> {area1}");
        let mut q = NavQuery::new();
        let p = q.find_path(&mesh, Vec3::new(-3.0, 0.0, 1.0), Vec3::new(5.0, 0.0, 1.0), Vec3::splat(1.0), 4096).unwrap();
        assert!(p.complete && p.length() > 8.1, "{}", p.length());
    }
}
