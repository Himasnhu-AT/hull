use super::*;
use serde_json::json;

fn snap() -> EntitySnapshot {
    EntitySnapshot {
        stable: StableId(7),
        name: "Crate".into(),
        parent: Some(StableId(1)),
        components: vec![("Transform".into(), json!({"translation": [1.0, 2.0, 3.0]}))],
        children: vec![EntitySnapshot {
            stable: StableId(8),
            name: "Lid".into(),
            parent: Some(StableId(7)),
            components: vec![],
            children: vec![],
        }],
    }
}

fn all_ops() -> Vec<Op> {
    let e = StableOrId::Stable(StableId(3));
    vec![
        Op::SetComponent {
            entity: e,
            type_path: "T".into(),
            before: Some(json!(1)),
            after: Some(json!(2)),
        },
        Op::SetComponent {
            entity: StableOrId::Id(9),
            type_path: "T".into(),
            before: None,
            after: Some(json!({"a": 1})),
        },
        Op::Spawn { snapshot: snap() },
        Op::Despawn { snapshot: snap() },
        Op::Reparent {
            entity: e,
            before: None,
            after: Some(StableOrId::Id(4)),
        },
        Op::Rename {
            entity: e,
            before: "a".into(),
            after: "b".into(),
        },
        Op::Batch(vec![
            Op::Rename {
                entity: e,
                before: "a".into(),
                after: "b".into(),
            },
            Op::Reparent {
                entity: e,
                before: Some(StableOrId::Id(1)),
                after: None,
            },
        ]),
    ]
}

#[test]
fn inverse_is_an_involution() {
    for op in all_ops() {
        assert_eq!(op.inverse().inverse(), op, "{op:?}");
    }
}

#[test]
fn inverse_swaps_sides() {
    let e = StableOrId::Id(1);
    let op = Op::SetComponent {
        entity: e,
        type_path: "T".into(),
        before: Some(json!(1)),
        after: None,
    };
    assert_eq!(
        op.inverse(),
        Op::SetComponent {
            entity: e,
            type_path: "T".into(),
            before: None,
            after: Some(json!(1))
        }
    );
    assert!(matches!(Op::Spawn { snapshot: snap() }.inverse(), Op::Despawn { .. }));
}

#[test]
fn batch_inverse_runs_in_reverse() {
    let e = StableOrId::Id(1);
    let a = Op::Rename {
        entity: e,
        before: "a".into(),
        after: "b".into(),
    };
    let b = Op::Rename {
        entity: e,
        before: "b".into(),
        after: "c".into(),
    };
    let inv = Op::Batch(vec![a.clone(), b.clone()]).inverse();
    assert_eq!(inv, Op::Batch(vec![b.inverse(), a.inverse()]));
}

#[test]
fn merge_keeps_first_before_last_after() {
    let e = StableOrId::Id(1);
    let set = |b: i32, a: i32| Op::SetComponent {
        entity: e,
        type_path: "T".into(),
        before: Some(json!(b)),
        after: Some(json!(a)),
    };
    let mut first = set(1, 2);
    assert!(first.merge(&set(2, 5)));
    assert_eq!(first, set(1, 5));
    assert!(!first.merge(&Op::SetComponent {
        entity: StableOrId::Id(2),
        type_path: "T".into(),
        before: None,
        after: None
    }));
    let mut back = set(1, 2);
    back.merge(&set(2, 1));
    assert!(back.is_noop());
}

#[test]
fn json_round_trip_of_every_type() {
    fn rt<T: Serialize + for<'a> Deserialize<'a> + PartialEq + std::fmt::Debug>(v: T) {
        let s = serde_json::to_string(&v).expect("serialize");
        let back: T = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(back, v, "{s}");
    }
    for op in all_ops() {
        rt(op);
    }
    rt(StableId(5));
    rt(StableOrId::Stable(StableId(5)));
    rt(StableOrId::Id(5));
    let mut node = TreeNode::new(1, "Root");
    node.stable = Some(StableId(1));
    node.icon = NodeKind::Light;
    node.children.push(TreeNode::new(2, "Child"));
    rt(node);
    rt(TreeFilter {
        text: "x".into(),
        include_generated: false,
        include_hidden: true,
    });
    let schema = TypeSchema::Struct {
        fields: vec![
            ("a".into(), TypeSchema::Int { min: Some(0), max: None }),
            (
                "b".into(),
                TypeSchema::Float {
                    min: None,
                    max: Some(1.0),
                    step: Some(0.1),
                },
            ),
            (
                "c".into(),
                TypeSchema::Enum {
                    variants: vec![("A".into(), None), ("B".into(), Some(TypeSchema::Vec3))],
                },
            ),
            ("d".into(), TypeSchema::List(Box::new(TypeSchema::Map(Box::new(TypeSchema::String))))),
            ("e".into(), TypeSchema::AssetPath { kind: "mesh".into() }),
        ],
    };
    rt(schema.clone());
    for s in [
        TypeSchema::Bool,
        TypeSchema::Color,
        TypeSchema::Vec2,
        TypeSchema::Vec4,
        TypeSchema::Quat,
        TypeSchema::Entity,
        TypeSchema::Opaque,
    ] {
        rt(s);
    }
    rt(ComponentDoc {
        type_path: "a::B".into(),
        short_name: "B".into(),
        value: json!({"x": [1, 2]}),
        schema,
        editable: true,
    });
    rt(snap());
    for k in [
        AssetKind::Folder,
        AssetKind::Model,
        AssetKind::Texture,
        AssetKind::Audio,
        AssetKind::Level,
        AssetKind::Script,
        AssetKind::Logic,
        AssetKind::Material,
        AssetKind::Other,
    ] {
        rt(k);
    }
    rt(AssetEntry {
        path: "library/x".into(),
        kind: AssetKind::Model,
        name: "x".into(),
        thumbnail: None,
        license: Some("CC0-1.0".into()),
    });
    rt(Placement {
        position: [1.0, 2.0, 3.0],
        parent: Some(StableId(2)),
        screen: Some([0.25, 0.75]),
    });
    rt(LevelInfo {
        path: Some("a.level.ron".into()),
        dirty: true,
    });
    for p in [PlayState::Editing, PlayState::Building, PlayState::Playing] {
        rt(p);
    }
    for l in [Level::Trace, Level::Debug, Level::Info, Level::Warn, Level::Error] {
        rt(Diagnostic {
            level: l,
            source: "ruspy".into(),
            message: "m".into(),
            file: Some("a.ruspy".into()),
            line: Some(3),
            col: None,
        });
    }
    for t in [Tool::Move, Tool::Rotate, Tool::Scale] {
        rt(ViewportCmd::SetTool(t));
    }
    rt(ViewportCmd::FocusSelection);
    rt(ViewportCmd::SetSnap { enabled: true, step: 0.5 });
}

#[test]
fn terrain_patch_swaps_blobs_and_survives_json() {
    let op = Op::TerrainPatch { layer: TerrainKind::Height, rect: [1, 2, 3, 4], before: 7, after: 8 };
    assert_eq!(op.inverse(), Op::TerrainPatch { layer: TerrainKind::Height, rect: [1, 2, 3, 4], before: 8, after: 7 });
    assert_eq!(op.inverse().inverse(), op);
    assert!(!op.is_noop());
    assert!(Op::TerrainPatch { layer: TerrainKind::Splat, rect: [0; 4], before: 5, after: 5 }.is_noop());
    let mut a = op.clone();
    assert!(!a.merge(&op), "strokes never merge");
    let back: Op = serde_json::from_str(&serde_json::to_string(&op).unwrap()).unwrap();
    assert_eq!(back, op);
}

#[test]
fn asset_actions_per_kind() {
    assert_eq!(AssetKind::Model.actions(), &[AssetAction::Place]);
    assert!(AssetKind::Audio.actions().iter().all(|a| *a != AssetAction::Place));
    assert!(AssetKind::Other.actions().is_empty());
}
