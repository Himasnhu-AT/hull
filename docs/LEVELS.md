# Levels (`src/level/`, feature `level`)

A level is the set of entities carrying `LevelEntity { id: StableId }`, stored as RON in
`levels/<name>.level.ron`. The editor writes it, the game plays it (`--level <file>`), and code-built
content keeps working beside it: entities without `LevelEntity` are *generated*, never saved and
never despawned by a load. Contract: `docs/EDITOR.md` ("Level files").

## File format

```ron
(
  version: 1,
  world: None,                              // Some("worlds/valley.world.ron"): a WorldDesc (terrain, scatter)
  look: Some(Preset("clear_day")),          // Preset(name) or Inline(<complete Look>)
  entities: (
    resources: {},
    entities: {
      4294967294: (                          // key: the stable id as an Entity (see below)
        components: {
          "bevy_ecs::name::Name": "Ground",
          "bevy_transform::components::transform::Transform": (translation: (0.0, 0.0, 0.0), ...),
          "engine::level::LevelEntity": (id: (1)),
          "engine::level::primitive::Primitive": (shape: Plane, size: (30.0, 0.0, 30.0), color: Srgba((...)), ...),
        },
      ),
      ...
```

`entities` is Bevy's reflected world format (`DynamicWorld`, what `.scn.ron` uses), so any
`#[derive(Reflect)] #[reflect(Component)]` type registered with `app.register_type` is saved with no
extra code. Entities are sorted by stable id and components by type path, so saves diff cleanly.
The map keys are the stable id encoded as a Bevy `Entity` (index = id, so they look like
`4294967294` for id 1); the readable id is `LevelEntity.id`. Ids must fit in 32 bits.

## What is saved

- Every entity with `LevelEntity`, and every reflected component on it **except** runtime-only
  ones (`file::RUNTIME_ONLY`: `GlobalTransform`, `InheritedVisibility`, `ViewVisibility`,
  `Children`, `Aabb`, light frusta / cascades / bounding `Sphere`, `RenderTarget`, UI computed
  nodes ...; matched by short name on `bevy_*` types). Add your own with `LevelConfig::deny`.
- Hierarchy: `ChildOf` by stable id. `Children` is rebuilt on load (siblings come back ordered by
  stable id). A level entity under a *generated* parent is saved as a root (the parent is not in the file).
- Entity references inside components are written as stable ids **if the field is marked
  `#[entities]`** in the `Component` derive (`struct Follows(#[entities] Entity)`); unmarked `Entity`
  fields keep their runtime id and dangle after a load.
- Asset handles are written **by asset path** (`WorldAssetRoot(Path("library/cars/x/car.glb#Scene0"))`)
  and loaded through the `AssetServer` on load. Strong handles without a path (made with
  `Assets::add`) cannot be saved: for `Mesh3d` / `MeshMaterial3d<StandardMaterial>` they are dropped,
  and `Primitive` (below) is the stand-in. Other material types with ephemeral handles are written as
  default handles (with a warning).
- `Primitive { shape, size, color, metallic, roughness }` (Cuboid, Sphere, Cylinder, Capsule, Plane)
  builds the shared `Mesh3d` + `MeshMaterial3d` whenever it is added or edited; the mesh/material are
  never written for entities that have one.
- A component that cannot be serialised is skipped, named in `SaveReport::skipped` and logged; the
  rest of the save goes through.

## API

```rust
level::save_level(world, "levels/town.level.ron")?;  // atomic (temp + rename), previous file kept as .bak
level::load_level(world, "levels/town.level.ron")?;   // replaces the level; Err leaves the old one untouched
commands.queue(LoadLevel(path.into()));               // same as a Command, or write the LoadLevel message
let id = level::new_stable_id(world);                 // fresh id for a new LevelEntity
let nodes = level::tree(world);                       // [(entity, nearest named ancestor, name)] in hierarchy order
level::is_generated(world, e);                        // no LevelEntity
level::level_info(world);                             // path, entities, version, dirty, world, look
```

- Load order: read, migrate, deserialise and validate **first**; only then despawn the old level and
  spawn the new. Any error (IO, RON, unknown component, newer version, bad `world` file) keeps
  the previous level, and `LevelState.path`.
- Relative paths: as given (project folder), else under the assets folder.
- `LevelEvent::{Loaded, Saved, Failed}` messages report every load / save / hot reload.
- The header (`LevelState.header`: `world`, `look`) is kept from the last load and written by the next
  save. On load the look is inserted as the `Look` resource; the `world` file is spawned with
  `world::spawn_world` (kept if the same file is already spawned, so hot reload does not rebuild terrain).
  `Look` itself is not `Reflect` (about 20 serde-only nested types, edited through `look.*`); the
  header carries it with serde.
- `dirty` compares the content a save would write now with what was last saved or loaded.

### Versions and migration

`version` is `LEVEL_VERSION` (1). A file without `version` is version 0; a newer file is an error.
`LevelMigrations::add(from, f)` registers `fn(&str) -> Result<String, String>` turning the text of
version `from` into version `from + 1`; they run in order. 0 → 1 is built in (no change).

### Hot reload

`LevelConfig { hot_reload, poll_secs }` (default on with `devtools`, 1 s): when the open level's mtime or
size changes the file is loaded again (a half-written file is retried only when it changes again; a
bad file keeps the old level). The editor's own saves update the stamp, so they do not reload.

### `--level <file>`

Devtools builds: loads the file once the game is `InGame` and skips the main menu. `LevelConfig.startup`
holds it. Ship builds ignore the flag.

## Control commands (`devtools`)

| Command | Params | Result |
|---|---|---|
| `level.info` | none | `{path, entities, version, dirty, world, look}` |
| `level.save` | `{path?}` | `{path, entities, skipped}` |
| `level.load` | `{path}` | `{path, entities}` |

## Limits

- No cameras with runtime render targets (`RenderTarget` is not saved); `Camera` carries computed state.
- Reflect JSON of components holding `Handle`s (`devkit::reflect_json`, `ecs.get`) does not work yet
  (no handle processor); the level file path does it right.
- Children of level entities that are not level entities (e.g. a spawned glTF scene's nodes) are
  rebuilt by their component (`WorldAssetRoot`), not saved, and die with their parent on load.
- Game components must derive `Reflect` and `#[reflect(Component)]` and be registered; otherwise they
  are silently not saved (and an unregistered type in a file fails the load).
- Feature `level` is default-on and adds only `ron`; ship builds (`--no-default-features`) have none of it.
- Tests: `memgate -- cargo test --lib level`. Example: `examples/level_demo.rs` (`levels/demo.level.ron`).

## Placeable types (editor Place palette)

```rust
use engine::level::RegisterPlaceable;
app.register_type::<EventStart>().register_placeable::<EventStart>("Event start", "flag", "Gameplay");
```
`Placeables` (resource) lists them in registration order; `Placeable::spawn(world, transform, name)`
spawns `T::default()` with `Name`, `Transform`, `Visibility` and a fresh `LevelEntity`. `T` must be
`Reflect` with `#[reflect(Component, Default)]` and registered, so Details can edit it and levels save it.

## Terrain saved with the level

When the world's terrain comes from files (`HeightSource::TerrainFiles { dir }`), or a game sets
`world::TerrainSaveTarget { dir: Some(..) }` for heights it passed in itself, `save_level` first
writes sculpt/paint edits there (`TerrainEdit::save_if_dirty`), then the level. Nothing is
written when the terrain has no unsaved edits. A terrain write error fails the level save.

Components that aren't `Reflect` (inserted by the game at runtime, e.g. a `PcgVolume` on a level
foliage entity) are skipped silently on save; re-insert them when the level loads.

## Level origin (Play copies)

The editor's Play writes a copy of the level to `<data>/play/editor_play.level.ron` and starts the
game on it. Paths inside a level that are relative to the level's own folder (the `world:` file,
a terrain folder `HeightSource::TerrainFiles { dir }`) would not resolve from there, so Play also
passes the original file: `--level-origin <path>` (devtools builds) or env `EDITOR_LEVEL_ORIGIN`.
`LevelConfig::origin` holds it and `level::origin_dir(world)` returns its folder (else the open
level's). `resolve` looks next to the origin first, and a relative terrain `dir` that exists
there (it must contain `terrain.ron`) is made absolute, so the loaded world also *saves* its
terrain into the original folder. Without an origin the level's own folder is used the same way.

Terrain saving is split: `TerrainSaveTarget { heights_dirty, splat_dirty }` (`dirty()` = either).
A level save writes `terrain.r16` + `terrain.ron` only after a height edit and
`terrain_splat.rgba8` (16 MB at 2048²) only after painting.
