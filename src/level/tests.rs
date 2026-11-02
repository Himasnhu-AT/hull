use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use bevy::world_serialization::{WorldAssetRoot, WorldSerializationPlugin};

use super::*;

#[derive(Component, Reflect, Clone, Debug, Default, PartialEq)]
#[reflect(Component, Default)]
struct Health {
    hp: i32,
    tags: Vec<String>,
}

#[derive(Component, Reflect, Clone, Debug, PartialEq)]
#[reflect(Component)]
struct Follows(#[entities] Entity);

impl FromWorld for Follows {
    fn from_world(_: &mut World) -> Self {
        Follows(Entity::PLACEHOLDER)
    }
}

fn app() -> App {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, AssetPlugin::default(), WorldSerializationPlugin))
        .init_asset::<Mesh>()
        .init_asset::<StandardMaterial>()
        .register_type::<Name>()
        .register_type::<Transform>()
        .register_type::<Visibility>()
        .register_type::<ChildOf>()
        .register_type::<PointLight>()
        .register_type::<Health>()
        .register_type::<Follows>()
        .add_plugins(LevelPlugin);
    app.finish();
    app.cleanup();
    app
}

/// `Follows` holds a runtime entity id (checked separately).
fn no_follows(mut v: serde_json::Value) -> serde_json::Value {
    for e in v.as_object_mut().unwrap().values_mut() {
        e.as_object_mut().unwrap().remove("Follows");
    }
    v
}

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("engine-level-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn id(world: &mut World, n: u64) -> Entity {
    world.query::<(Entity, &LevelEntity)>().iter(world).find(|(_, l)| l.id.0 == n).map(|(e, _)| e).unwrap_or_else(|| panic!("no level entity {n}"))
}

/// root(1) ← child(2); light(3); health(4) follows root; primitive(5); asset root(6).
fn build(app: &mut App) {
    let server = app.world().resource::<AssetServer>().clone();
    let w = app.world_mut();
    let root = w.spawn((LevelEntity { id: StableId(1) }, Name::new("root"), Transform::from_xyz(1.0, 2.0, 3.0))).id();
    w.spawn((LevelEntity { id: StableId(2) }, Name::new("child"), Transform::from_xyz(0.0, 1.0, 0.0), ChildOf(root)));
    w.spawn((LevelEntity { id: StableId(3) }, Name::new("lamp"), PointLight { intensity: 1234.0, range: 9.0, ..default() }, Transform::from_xyz(4.0, 5.0, 6.0)));
    w.spawn((LevelEntity { id: StableId(4) }, Name::new("hero"), Health { hp: 7, tags: vec!["a".into(), "b".into()] }, Follows(root)));
    w.spawn((LevelEntity { id: StableId(5) }, Name::new("box"), Primitive::cuboid(Vec3::new(1.0, 2.0, 3.0), Color::srgb(0.2, 0.4, 0.6)), Transform::from_xyz(-3.0, 0.5, 0.0)));
    w.spawn((LevelEntity { id: StableId(6) }, Name::new("car"), WorldAssetRoot(server.load("library/cars/x/car.glb#Scene0"))));
    app.update();
}

#[test]
fn round_trip_is_identical() {
    let d = dir("roundtrip");
    let path = d.join("a.level.ron");
    let mut app = app();
    build(&mut app);
    // Not part of the level: must survive everything.
    let generated = app.world_mut().spawn((Name::new("generated"), Transform::from_xyz(9.0, 9.0, 9.0))).id();
    let before = no_follows(snapshot_json(app.world_mut()));
    let rep = save_level(app.world_mut(), &path).unwrap();
    assert_eq!(rep.entities, 6);
    assert!(rep.skipped.is_empty(), "{:?}", rep.skipped);

    file::despawn_level(app.world_mut());
    assert_eq!(app.world_mut().query::<&LevelEntity>().iter(app.world()).count(), 0);
    assert_eq!(load_level(app.world_mut(), &path).unwrap(), 6);
    app.update();

    let after = no_follows(snapshot_json(app.world_mut()));
    assert_eq!(before, after);
    assert!(app.world().get_entity(generated).is_ok(), "non-level entity was touched");
    assert_eq!(app.world().get::<Transform>(generated).unwrap().translation, Vec3::new(9.0, 9.0, 9.0));

    // Stable ids, hierarchy, entity references, handles by path.
    let w = app.world_mut();
    let (root, child, hero, car, boxe) = (id(w, 1), id(w, 2), id(w, 4), id(w, 6), id(w, 5));
    assert_eq!(w.get::<ChildOf>(child).unwrap().parent(), root);
    assert!(w.get::<Children>(root).unwrap().contains(&child), "Children rebuilt");
    assert_eq!(w.get::<Follows>(hero).unwrap().0, root);
    assert_eq!(w.get::<WorldAssetRoot>(car).unwrap().0.path().unwrap().to_string(), "library/cars/x/car.glb#Scene0");
    assert!(w.get::<Mesh3d>(boxe).is_some(), "primitive rebuilt its mesh");
    assert!(new_stable_id(w).0 > 6);

    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("version: 1"), "{text}");
    assert!(!text.contains("GlobalTransform"), "runtime component leaked");
    assert!(!text.contains("Mesh3d"), "ephemeral mesh handle leaked");
}

#[test]
fn second_save_keeps_backup_and_dirty_tracks_content() {
    let d = dir("bak");
    let path = d.join("a.level.ron");
    let mut app = app();
    build(&mut app);
    save_level(app.world_mut(), &path).unwrap();
    assert!(!level_info(app.world_mut()).dirty);
    let first = std::fs::read_to_string(&path).unwrap();
    let hero = id(app.world_mut(), 4);
    app.world_mut().get_mut::<Health>(hero).unwrap().hp = 99;
    assert!(level_info(app.world_mut()).dirty);
    save_level(app.world_mut(), &path).unwrap();
    assert!(!level_info(app.world_mut()).dirty);
    assert_eq!(std::fs::read_to_string(with_suffix(&path, ".bak")).unwrap(), first);
    assert!(!with_suffix(&path, ".tmp").exists());
    assert_eq!(level_info(app.world_mut()).entities, 6);
}

#[test]
fn corrupt_file_keeps_previous_level() {
    let d = dir("corrupt");
    let good = d.join("good.level.ron");
    let mut app = app();
    build(&mut app);
    save_level(app.world_mut(), &good).unwrap();
    let text = std::fs::read_to_string(&good).unwrap();

    for (name, body) in [
        ("garbage", "this is not ron".to_string()),
        ("truncated", text[..text.len() / 2].to_string()),
        ("unknown_component", text.replace("level::tests::Health", "level::tests::Nope")),
        ("newer", text.replace("version: 1", "version: 42")),
    ] {
        let bad = d.join(format!("{name}.level.ron"));
        std::fs::write(&bad, body).unwrap();
        let err = load_level(app.world_mut(), &bad).unwrap_err();
        assert!(!err.to_string().is_empty(), "{name}");
        assert_eq!(level_info(app.world_mut()).entities, 6, "{name}: previous level must stay");
        assert_eq!(app.world().resource::<LevelState>().path.as_deref(), Some(good.as_path()), "{name}");
    }
    assert!(load_level(app.world_mut(), d.join("missing.level.ron")).is_err());
}

static MIGRATED: AtomicU32 = AtomicU32::new(0);

#[test]
fn migration_hook_runs_for_version_zero() {
    let d = dir("migrate");
    let path = d.join("old.level.ron");
    let mut app = app();
    build(&mut app);
    save_level(app.world_mut(), &path).unwrap();
    // A version-0 file has no `version` field and (in this fake history) called Health `Hp`.
    let old = std::fs::read_to_string(&path).unwrap().replace("version: 1,\n", "").replace("level::tests::Health", "level::tests::Hp");
    std::fs::write(&path, old).unwrap();
    assert!(load_level(app.world_mut(), &path).is_err(), "without a migration the old name is unknown");

    app.world_mut().resource_mut::<LevelMigrations>().add(0, |t| {
        MIGRATED.fetch_add(1, Ordering::SeqCst);
        Ok(t.replace("level::tests::Hp", "level::tests::Health"))
    });
    assert_eq!(load_level(app.world_mut(), &path).unwrap(), 6);
    assert_eq!(MIGRATED.load(Ordering::SeqCst), 1);
    assert_eq!(app.world().resource::<LevelState>().version, 0);
    let hero = id(app.world_mut(), 4);
    assert_eq!(app.world().get::<Health>(hero).unwrap().hp, 7);
}

#[test]
fn load_message_replaces_level_and_reports() {
    let d = dir("message");
    let a = d.join("a.level.ron");
    let b = d.join("b.level.ron");
    let mut app = app();
    build(&mut app);
    save_level(app.world_mut(), &a).unwrap();
    let hero = id(app.world_mut(), 4);
    app.world_mut().entity_mut(hero).despawn();
    save_level(app.world_mut(), &b).unwrap();

    app.world_mut().write_message(LoadLevel(a.clone()));
    app.update();
    assert_eq!(level_info(app.world_mut()).entities, 6);
    app.world_mut().commands().queue(LoadLevel(b.clone()));
    app.update();
    assert_eq!(level_info(app.world_mut()).entities, 5);
    assert_eq!(level_info(app.world_mut()).path, Some(b.display().to_string()));
}

#[test]
fn hot_reload_follows_the_file() {
    let d = dir("hot");
    let a = d.join("a.level.ron");
    let b = d.join("b.level.ron");
    let mut app = app();
    app.world_mut().resource_mut::<LevelConfig>().hot_reload = true;
    app.world_mut().resource_mut::<LevelConfig>().poll_secs = 0.0;
    build(&mut app);
    save_level(app.world_mut(), &a).unwrap();
    let hero = id(app.world_mut(), 4);
    app.world_mut().entity_mut(hero).despawn();
    save_level(app.world_mut(), &b).unwrap(); // 5 entities, path is now b
    save_level(app.world_mut(), &a).unwrap(); // path back to a (5 entities on disk)
    app.update();
    assert_eq!(level_info(app.world_mut()).entities, 5);
    // Another tool rewrites `a` with the 6-entity version.
    let mut other = self::app();
    build(&mut other);
    save_level(other.world_mut(), &a).unwrap();
    app.update();
    assert_eq!(level_info(app.world_mut()).entities, 6, "file change was picked up");
    app.update();
    assert!(!level_info(app.world_mut()).dirty);
}

#[test]
fn tree_lists_named_entities_with_nearest_named_parent() {
    let mut app = app();
    build(&mut app);
    let w = app.world_mut();
    let child = id(w, 2);
    let unnamed = w.spawn(ChildOf(child)).id();
    let deep = w.spawn((Name::new("deep"), ChildOf(unnamed))).id();
    let root = id(w, 1);
    let t = tree(w);
    let entry = |e: Entity| t.iter().find(|(x, _, _)| *x == e).cloned().unwrap();
    assert_eq!(entry(child).1, Some(root));
    assert_eq!(entry(deep).1, Some(child), "unnamed entity skipped");
    assert!(t.iter().position(|(e, _, _)| *e == root) < t.iter().position(|(e, _, _)| *e == child));
    assert!(is_generated(w, unnamed) && !is_generated(w, root));
}

#[test]
fn orphan_parent_becomes_root() {
    let d = dir("orphan");
    let path = d.join("a.level.ron");
    let mut app = app();
    build(&mut app);
    // A level entity under a generated parent: the parent is not saved, so it loads as a root.
    let gen_parent = app.world_mut().spawn(Name::new("gen")).id();
    app.world_mut().spawn((LevelEntity { id: StableId(7) }, Name::new("under_gen"), ChildOf(gen_parent)));
    save_level(app.world_mut(), &path).unwrap();
    file::despawn_level(app.world_mut());
    load_level(app.world_mut(), &path).unwrap();
    let e = id(app.world_mut(), 7);
    assert!(app.world().get::<ChildOf>(e).is_none());
}
