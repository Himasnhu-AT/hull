# Editor: the contract

The engine's editor is one Unreal-style window: viewport in the middle, Outliner, Details,
Content Browser, Logic and Script panels around it. This file is the contract every part is
built against. Change it first, in its own commit, when an interface has to move.

Branch: `editor` (merged to `main` only when the owner says).

## Layers

```
crates/editor-proto   serde types only. No Bevy, no egui.
crates/editor-ui      egui 0.36 + ashlar-ui + ashlar-store. No Bevy. Talks to `EditorBackend`.
src/editor/           engine feature `editor`: hosts editor-ui through bevy_egui, implements
                      EditorBackend on the World, viewport camera, picking, gizmo, Play/Stop,
                      `editor.*` control commands (the same protocol over TCP).
src/level/            engine: level files (load, save, hot reload, `--level`).
crates/logic-core     Bevy-free logic graphs: types, validation, interpreter.
src/logic/            engine: Logic component, events, runs graphs and ruspy scripts.
crates/uasset         standalone tool crate: reads Unreal packages. Never an engine dependency.
tools/ue-import       CLI: Unreal project/map → level + library assets + report.
assets/library/       imported/downloaded assets + LICENSES.json.
```

Rules for every layer:
- `editor-proto` and `editor-ui` must build without Bevy: `cargo tree -p editor-ui` has no
  `bevy`. That is what keeps the editor UI safe from Bevy upgrades; only `src/editor/` moves.
- No panics on data (files, scripts, protocol input): return errors, show them in the editor.
- Feature `editor` is off by default; default and ship builds don't change.
- All cargo commands through memgate; docs written with the code.

## Starting the editor

The game's own binary is the editor (so all its component types, assets and plugins exist):
`cargo run --features dev -- --editor [--level levels/x.level.ron]`. `engine::app` intercepts
`--editor` (like `--metrics-viewer`) and adds `EditorPlugin`: `AppState::Editing`, virtual
time paused, game input actions disabled while the editor has focus.

**Play** saves the level, runs `memgate -- cargo build` for the game (output in the Output
panel), starts `<game> --level <file> --control 0` plus the metrics viewer, and stops
rendering the editor viewport (reactive mode). **Stop** ends that process group.

## editor-proto types

```rust
pub type EntityId = u64;                 // Entity::to_bits()
pub struct StableId(pub u64);            // persisted in level files (LevelEntity)

pub struct TreeNode {
    pub id: EntityId, pub stable: Option<StableId>, pub name: String,
    pub icon: NodeKind,                  // Mesh, Light, Camera, Empty, Audio, Logic, Generated, ...
    pub children: Vec<TreeNode>,
    pub generated: bool,                 // built by code, read-only in the editor
    pub hidden: bool,
}

pub struct ComponentDoc {
    pub type_path: String, pub short_name: String,
    pub value: serde_json::Value,        // reflect JSON (Vec3 = [x,y,z], Quat = [x,y,z,w])
    pub schema: TypeSchema,              // for building the property grid
    pub editable: bool,                  // false when not Reflect-deserializable
}

pub enum TypeSchema {                    // derived from bevy_reflect TypeInfo, engine-side
    Bool, Int { min: Option<i64>, max: Option<i64> }, Float { min: Option<f64>, max: Option<f64>, step: Option<f64> },
    String, Color, Vec2, Vec3, Vec4, Quat, AssetPath { kind: String },
    Enum { variants: Vec<(String, Option<TypeSchema>)> },
    Struct { fields: Vec<(String, TypeSchema)> }, List(Box<TypeSchema>), Map(Box<TypeSchema>),
    Entity, Opaque,
}

pub enum Op {                            // every edit; each has an exact inverse
    SetComponent { entity: StableOrId, type_path: String, before: Option<Value>, after: Option<Value> },
    Spawn { snapshot: EntitySnapshot },  // inverse: Despawn
    Despawn { snapshot: EntitySnapshot },// inverse: Spawn (same stable id, children included)
    Reparent { entity: StableOrId, before: Option<StableOrId>, after: Option<StableOrId> },
    Rename { entity: StableOrId, before: String, after: String },
    Batch(Vec<Op>),
}

pub struct EntitySnapshot { pub stable: StableId, pub name: String, pub parent: Option<StableId>,
                            pub components: Vec<(String, Value)>, pub children: Vec<EntitySnapshot> }

pub struct AssetEntry { pub path: String, pub kind: AssetKind, pub name: String,
                        pub thumbnail: Option<String>, pub license: Option<String> }

pub struct Diagnostic { pub level: Level, pub source: String, pub message: String,
                        pub file: Option<String>, pub line: Option<u32>, pub col: Option<u32> }
```

## EditorBackend (implemented by `src/editor/`, mocked in editor-ui tests)

```rust
pub trait EditorBackend {
    fn tree(&mut self, filter: &TreeFilter) -> Vec<TreeNode>;
    fn components(&mut self, id: EntityId) -> Result<Vec<ComponentDoc>, String>;
    fn component_types(&mut self) -> Vec<(String, TypeSchema)>;     // for "Add component"
    fn apply(&mut self, op: &Op) -> Result<(), String>;              // engine never records undo
    fn selection(&mut self) -> Vec<EntityId>;                        // viewport picks
    fn set_selection(&mut self, ids: &[EntityId]);
    fn assets(&mut self, dir: &str) -> Vec<AssetEntry>;
    fn place_asset(&mut self, path: &str, at: Placement) -> Result<Op, String>; // returns the Spawn op
    fn level(&mut self) -> LevelInfo;                                // path, dirty
    fn save_level(&mut self, path: Option<&str>) -> Result<(), String>;
    fn open_level(&mut self, path: &str) -> Result<(), String>;
    fn play(&mut self) -> Result<(), String>;  fn stop(&mut self);  fn play_state(&mut self) -> PlayState;
    fn diagnostics(&mut self, since: u64) -> (u64, Vec<Diagnostic>);
    fn viewport(&mut self, cmd: ViewportCmd);                         // focus selection, tool, snap, camera
}
```

Undo lives in editor-ui: every `Op` goes through an `ashlar-store` History with merge keys
(a gizmo drag or a slider scrub is one step). Viewport gizmo drags produce `Op`s via the
backend's selection/transform events so they undo the same way.

The same calls are control commands `editor.tree`, `editor.components`, `editor.apply`, ...
(params/results = the proto types as JSON), so agents and a future standalone UI use the same
protocol.

## Level files (`src/level/`)

`levels/<name>.level.ron`:

```ron
(
  version: 1,
  world: Some("worlds/valley.world.ron"),       // optional WorldDesc (terrain, scatter)
  look: Some("clear_day"),                      // look preset name or inline Look
  entities: [ /* Bevy DynamicScene RON of entities marked LevelEntity */ ],
)
```
- Entities carry `LevelEntity { id: StableId }`, `Name`, `Transform`, `ChildOf`, and their
  reflected components; meshes by asset path (`SceneRoot("library/cars/x/car.glb#Scene0")`,
  materials by path). Runtime-only components are skipped (a skip list + `#[reflect(skip)]`).
- Save: atomic write + `.bak`; load: migrate old versions; hot reload when the file changes.
- `--level <file>` plays it; code-built content keeps working and shows as `generated`.

## Logic graphs (`crates/logic-core`, `src/logic/`)

`logic/<name>.logic.ron`, attached with `Logic { graph: "logic/door.logic.ron" }`:
- Nodes: events (`Start`, `Tick`, `OverlapEnter/Exit`, `Action(name)`, `Timer`, `Message(name)`),
  flow (`Branch`, `Sequence`, `Delay`, `ForEach`), data (`Get(path)`, `Set(path)`, math,
  compare, literals), `Command { id, params }` (any engine control command; the node palette
  is generated from `engine.commands` schemas), `Script { file, function }` (ruspy).
- Exec pins (flow) + data pins (typed: bool, number, string, vec3, entity, json).
- Interpreter: per event, fixed step budget, no allocation per tick; errors → diagnostics.

## ruspy scripts

`scripts/<name>.ruspy`, called from graphs or bound to events directly. Host API (exact
syntax fixed after the ruspy spike): `self()`, `get(path)`, `set(path, value)`,
`command(id, params)`, `emit(message, value)`, `log(text)`. Step limit per call; syntax and
runtime errors → diagnostics with line/col; hot reload.

## Unreal import

`tools/ue-import <project.uproject> <Map> --out <dir>` (reads files with `crates/uasset`, no
Unreal install). Output: `levels/<map>.level.ron`, assets under
`assets/library/unreal/<project>/`, `import-report.json` (what was converted, approximated,
skipped). Stages: U1 placement + textures, U2 static meshes, U3 landscape + splines, U4
materials (approximate PBR). Blueprints are listed, not converted. Unreal is Z-up,
left-handed, centimetres; we are Y-up, right-handed, metres: one conversion function,
tested.

Epic sample/template content and Fab "UE-Only"/"Reference Only" content is for local testing
only and never committed or shipped.

## Asset library

`assets/library/<kind>/<name>/` (glTF/GLB + KTX2 textures) and
`assets/library/LICENSES.json`:

```json
{ "cars/sedan": { "source": "kenney", "url": "...", "author": "Kenney", "license": "CC0-1.0",
                  "fetched": "2026-11-02" } }
```
`content.check` fails on library assets with no entry or a forbidden licence
(`ue-only`, `reference-only`, `epic-sample`). `scripts/assets.py fetch|import|list`.

## Changes requested by Stream B (editor-ui)

- `EditorBackend::snapshot(id) -> Result<EntitySnapshot, String>` added: the UI needs it to build
  `Op::Despawn` (with children) for Delete. Required for undo of delete.
- `TreeFilter { text, include_generated, include_hidden }`, `Placement { position, parent }`,
  `Tool { Move, Rotate, Scale }`, `ViewportCmd::{FocusSelection, SetTool, SetSnap{enabled, step}}`
  fixed as concrete shapes. `NodeKind` = Mesh, Light, Camera, Empty, Audio, Logic, Generated, Other.
  `StableOrId` serialises externally tagged (`{"Stable": 5}` / `{"Id": 5}`).
- `Op::merge` and `Op::is_noop` are in editor-proto (drag merging in the UI's undo stack).
- Undo is an own journal of `Op`s in editor-ui, not `ashlar-store`: the document is in the engine,
  so snapshot history does not fit; `Op::inverse` is the undo.
- Backend rules the UI relies on: `apply` of `SetComponent` carries the whole component value
  (`before` = value the UI last saw); the backend may reject a stale `before`. `place_asset` applies
  the spawn itself and returns the op (UI only records it). Selection ids that disappear from
  `tree()` are dropped by the UI. Ops should address entities by `StableId` whenever the node has
  one, because a session `EntityId` changes when undo respawns an entity.
- `EditorUi::show` takes the whole screen; the host places the 3D camera at `UiOutput.viewport`.
- **egui-snarl blank (not reproduced outside Bevy)**: snarl renders correctly in an eframe/kittest
  host at 700x170 and 700x400, 1x and 2x (`examples/snarl_probe.rs`, and inside the dock). The
  spike's blank graph (re-run: background draws, nodes missing) is host-specific. egui-snarl calls
  `request_discard("NodeState initialization")` / `("Initial placing")` and its nodes are drawn
  after the request; egui draws nothing after a discard request in that pass. bevy_egui's primary
  context runs begin_pass/end_pass once per frame (no multi-pass loop; the loop only runs for
  contexts with `EguiSchedule`), so the discarded pass is what reaches the screen. Untested fix to
  try first: `ctx.options_mut(|o| o.max_passes = NonZeroUsize::new(1).unwrap())` in the host (makes
  egui ignore `request_discard`), or give the egui context an `EguiSchedule` so it gets the pass
  loop. Until verified in Bevy, feature `snarl` is off by default.
