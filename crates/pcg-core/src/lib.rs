//! Procedural content generation core (no Bevy): **points → filters → spawn**, Unreal-PCG style.
//!
//! - [`Inputs`]: named sets of tagged [`Rect`]s, [`Polyline`]s and points, plus a ground
//!   [`Surface`].
//! - [`Graph`]: nodes with an [`Op`] and named inputs, as serde data: load RON
//!   ([`Graph::from_ron`]) or build in Rust ([`Graph::build`]). [`Graph::validate`] names the
//!   node at fault.
//! - [`evaluate`] runs it over an [`Area`] (a cell) or everywhere, returning [`Output`]: what
//!   each `Spawn` node places (item picked per point) and the points each `Emit` hands back.
//! - **Deterministic and partition-independent**: every choice hashes the graph seed, the node
//!   seed and the point's world position ([`seed_at`]); samplers use world-anchored grids;
//!   cells are evaluated with a halo ([`Graph::halo`]) and clipped. Splitting a map into
//!   8 m, 16 m or 64 m cells gives the same points as evaluating it whole.
//! - [`keep_for_tier`]: deterministic thinning by detail tier (lower quality ⊂ higher).
//!
//! The Bevy side (spawning, caching per cell, scalability, control commands) is `engine::pcg`;
//! game-logic crates that must know generated gameplay objects (cover, props) before baking
//! navigation use this crate directly.

mod eval;
mod graph;
mod points;

pub use eval::{Output, Spawned, evaluate, keep_for_tier};
pub use graph::{Builder, Graph, Node, Op, PcgError, Side, SpawnDef, SpawnKind, Tier};
pub use points::{Area, Inputs, Point, PointSet, Polyline, Rect, Shapes, Surface, mix64, seed_at, str_hash, tag_id, unit};

pub use glam;

#[cfg(test)]
mod tests {
    use glam::{Vec2, Vec3};

    use super::*;

    fn town() -> Inputs {
        Inputs::default()
            .rects(
                "lots",
                vec![
                    Rect::new(Vec2::new(0.0, 0.0), Vec2::new(30.0, 20.0)).tagged("park"),
                    Rect { yaw: 0.4, ..Rect::new(Vec2::new(55.0, 10.0), Vec2::new(12.0, 18.0)).tagged("yard") },
                ],
            )
            .rects("blocks", vec![Rect::new(Vec2::new(5.0, 5.0), Vec2::new(6.0, 4.0)).tagged("house")])
            .lines("streets", vec![Polyline { points: vec![Vec3::new(-40.0, 0.0, -25.0), Vec3::new(80.0, 0.0, -25.0), Vec3::new(80.0, 0.0, 40.0)], closed: false, tag: "street".into() }])
            .surface(Surface::Plane(0.0))
    }

    fn trees() -> Graph {
        Graph::build(7)
            .input("lots")
            .poisson(2.5)
            .noise(9.0, 0.2, 0.8)
            .density(0.1, 1.0)
            .difference("blocks", 1.0)
            .node("blocks", Op::Input { name: "blocks".into() }, &[])
            .from("difference4")
            .transform(Vec3::ZERO, (0.0, 360.0), (0.8, 1.2), 0.0)
            .project(0.0, false)
            .spawn(&[("oak", 2.0), ("pine", 1.0)], Tier::Normal)
            .id("trees")
            .input("streets")
            .edges(6.0, 3.0, Side::Left)
            .prune(4.0)
            .spawn(&[("lamp", 1.0)], Tier::Essential)
            .id("lamps")
            .finish()
            .unwrap()
    }

    fn spawned(o: &Output, node: &str) -> PointSet {
        o.spawns.iter().filter(|s| s.node == node).fold(PointSet::default(), |mut a, s| {
            a.extend(&s.points);
            a
        })
    }

    #[test]
    fn same_inputs_same_points() {
        let (g, i) = (trees(), town());
        let a = evaluate(&g, &i, None).unwrap();
        let b = evaluate(&g, &i, None).unwrap();
        assert_eq!(a, b);
        assert!(spawned(&a, "trees").len() > 50, "{}", spawned(&a, "trees").len());
        assert!(spawned(&a, "lamps").len() > 10);
        // A different graph seed reshuffles.
        let mut g2 = g.clone();
        g2.seed = 8;
        assert_ne!(evaluate(&g2, &i, None).unwrap().spawns, a.spawns);
    }

    #[test]
    fn cells_add_up_to_the_whole_at_any_size() {
        let (g, i) = (trees(), town());
        let whole = evaluate(&g, &i, None).unwrap();
        for size in [8.0, 16.0, 64.0] {
            for node in ["trees", "lamps"] {
                let mut union = PointSet::default();
                // Cells covering the whole town (-64..128 × -64..64 m).
                let (x0, x1, z0, z1) = ((-64.0 / size) as i32, (128.0 / size) as i32, (-64.0 / size) as i32, (64.0 / size) as i32);
                for z in z0..z1 {
                    for x in x0..x1 {
                        let o = evaluate(&g, &i, Some(Area::cell(x, z, size))).unwrap();
                        union.extend(&spawned(&o, node));
                    }
                }
                let (u, w) = (union.canonical(), spawned(&whole, node).canonical());
                assert_eq!(u.len(), w.len(), "{node} at {size} m cells");
                assert_eq!(u.pos, w.pos, "{node} at {size} m cells");
                assert_eq!(u.seed, w.seed);
            }
        }
    }

    #[test]
    fn lower_tiers_are_subsets() {
        let o = evaluate(&trees(), &town(), None).unwrap();
        let t = spawned(&o, "trees");
        let kept = |f: f32| -> Vec<u64> { (0..t.len()).filter(|&k| keep_for_tier(t.seed[k], Tier::Normal, f, f)).map(|k| t.seed[k]).collect() };
        let (hi, mid, lo) = (kept(1.0), kept(0.6), kept(0.3));
        assert_eq!(hi.len(), t.len());
        assert!(mid.iter().all(|s| hi.contains(s)) && lo.iter().all(|s| mid.contains(s)));
        assert!(lo.len() < mid.len() && mid.len() < hi.len());
        assert!(keep_for_tier(t.seed[0], Tier::Essential, 0.0, 0.0));
    }

    #[test]
    fn difference_and_tags_filter() {
        let o = evaluate(&trees(), &town(), None).unwrap();
        let t = spawned(&o, "trees");
        let house = Rect::new(Vec2::new(5.0, 5.0), Vec2::new(6.0, 4.0));
        assert!(t.pos.iter().all(|p| !house.contains(Vec2::new(p.x, p.z), 1.0)));
        // Lamps are tagged by the street they came from.
        assert!(spawned(&o, "lamps").tag.iter().all(|t| *t == tag_id("street")));
        let only_yard = Graph::build(1).input("lots").grid(2.0, 0.5).tags(&["yard"]).spawn(&[("x", 1.0)], Tier::Fine).finish().unwrap();
        let y = evaluate(&only_yard, &town(), None).unwrap();
        assert!(y.spawned() > 0 && y.spawns[0].points.tag.iter().all(|t| *t == tag_id("yard")));
    }

    #[test]
    fn editing_one_rect_only_changes_cells_near_it() {
        let i = town();
        let mut j = i.clone();
        j.sets.get_mut("blocks").unwrap().rects[0].half.x += 1.0;
        let near = Area::cell(0, 0, 16.0);
        let far = Area::cell(4, 2, 16.0);
        assert_ne!(i.hash_in(near), j.hash_in(near));
        assert_eq!(i.hash_in(far), j.hash_in(far));
    }

    #[test]
    fn ron_round_trip_and_validation() {
        let g = trees();
        let back = Graph::from_ron(&g.to_ron()).unwrap();
        assert_eq!(back, g);
        assert_eq!(back.hash(), g.hash());
        let bad = Graph::from_ron(r#"(nodes: [(id: "a", op: Input(name: "x")), (id: "b", op: SelfPrune(radius: 1.0), inputs: ["nope"])])"#).unwrap_err();
        assert_eq!(bad.node, "b");
        let cycle = Graph::from_ron(r#"(nodes: [(id: "a", op: Union, inputs: ["b"]), (id: "b", op: Union, inputs: ["a"])])"#).unwrap_err();
        assert!(cycle.msg.contains("cycle"), "{cycle}");
        let zero = Graph::from_ron(r#"(nodes: [(id: "a", op: Input(name: "x")), (id: "b", op: GridSample(spacing: 0.0), inputs: ["a"])])"#).unwrap_err();
        assert!(zero.msg.contains("spacing"));
    }

    #[test]
    fn copy_places_templates_on_points() {
        let mut tpl = PointSet::default();
        for x in [-1.0, 1.0] {
            tpl.push(Point { pos: Vec3::new(x, 0.0, 0.0), ..Default::default() });
        }
        let i = town().points("pair", tpl);
        let g = Graph::build(3)
            .input("lots")
            .grid(10.0, 0.0)
            .id("anchors")
            .input("pair")
            .node("copies", Op::Copy, &["anchors", "pair"])
            .spawn(&[("chair", 1.0)], Tier::Fine)
            .finish()
            .unwrap();
        let o = evaluate(&g, &i, None).unwrap();
        let anchors = o.counts.iter().find(|(n, _)| n == "anchors").unwrap().1;
        assert_eq!(o.spawned(), anchors * 2);
    }

    #[test]
    fn heightfield_projection() {
        let i = town().surface(Surface::Heightfield { origin: Vec2::new(-50.0, -50.0), cell: 10.0, width: 20, heights: (0..400).map(|k| (k % 20) as f32).collect() });
        let g = Graph::build(1).input("lots").grid(5.0, 0.0).project(0.5, true).emit("pts").finish().unwrap();
        let o = evaluate(&g, &i, None).unwrap();
        let p = &o.emits["pts"];
        assert!(!p.is_empty());
        for k in 0..p.len() {
            let want = i.surface.as_ref().unwrap().height(Vec2::new(p.pos[k].x, p.pos[k].z)) + 0.5;
            assert!((p.pos[k].y - want).abs() < 1e-4);
        }
    }
}
