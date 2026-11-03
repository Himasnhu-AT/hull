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
  reflected components; meshes by asset path (`WorldAssetRoot` for glTF scenes, e.g. `library/cars/kenney-car-kit/sedan.glb#Scene0`; Bevy 0.20 has no `SceneRoot`),
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

## World tools (open-world editing; Pacenote first)

Viewport **tools** are implemented on the engine side (`src/editor/tools/`), each with a
settings struct shown in a Tool panel through the same property grid as Details
(`ToolDoc { id, settings: Value, schema: TypeSchema }`). Tools: Select, Move, Rotate, Scale,
Spline, TerrainSculpt, TerrainPaint, Foliage (PCG overrides), Place (palette of placeable
types).

### Terrain (`world::terrain` data)
- Heights live in a heightmap asset next to the level: `levels/<name>/terrain.r16` (u16
  little-endian, row-major) + `terrain.ron` (`size_samples`, `spacing`, `origin`, `height_min`,
  `height_max`) and splat weights `terrain_splat.rgba8` (up to 4 layers, matching
  `TerrainDesc` layers). `WorldDesc` points at it (`HeightSource::Raw16`).
- Runtime API: `TerrainEdit` (engine) applies a height/splat patch to a rectangle and rebuilds
  only the chunks it touches (and their colliders when `physics`); emits
  `TerrainChanged { rect }` so games refresh anything derived (road shaping, PCG cells).
- Brushes: raise, lower, smooth, flatten (to picked height), ramp, noise; paint layer; radius,
  strength, falloff. One stroke = one undo step.
- Undo: `Op::TerrainPatch { layer: Height|Splat, rect, before: BlobId, after: BlobId }`; blobs
  are kept by the engine in an undo blob store (not JSON).

### Splines (`engine::spline`)
- `Spline { points: Vec<SplinePoint>, closed: bool }` component (Reflect):
  `SplinePoint { pos: Vec3, width: f32, bank: f32, tags: u32, data: Option<String> }`
  (`tags`/`data` are game-defined: surface, road kind, lane info). Catmull-Rom by default.
- Sampling helpers (`sample(step)`, `nearest(p)`, `length`), `SplineChanged` message.
- Spline tool: click to add, insert between, delete, drag points/tangent; edits are
  `SetComponent` ops on the `Spline` (undo for free).
- Games build their own meshes/physics from splines (Pacenote's road ribbons, junctions).

### PCG overrides (`engine::pcg`)
- `PcgOverrides` component on a `PcgVolume` (Reflect, saved in the level): `removed` (point
  keys: cell + point seed), `moved` (key → transform), `added` (item + transform),
  `areas` (polygons with a density multiplier, 0 = clear), `seed_offset`.
- Applied when cells spawn (render) and exposed as
  `PcgOverrides::apply(&mut PointSet, cell)` so games that evaluate the same graph elsewhere
  (Pacenote's forest colliders) apply exactly the same edits.
- Foliage tool: click picks a generated instance (ray vs the cell's point set, works on merged
  meshes), delete/move; paint/erase density areas; place items from the catalog.

### Gameplay points
- Game components that derive `Reflect` and register a `Placeable { name, icon, category }`
  appear in the Place palette and in Details. Non-mesh entities get a viewport icon.
- Pacenote: events (route, start/finish markers, splits), spawn point, corner-grade overrides,
  surfaces/width per segment (spline point data), no-tree areas (PCG areas), traffic lanes,
  time of day (`look`).

### Bake (game side)
Games with generated worlds bake once into a level: heightmap files, splines, placed
entities, PCG volumes with empty overrides. After the bake the level is the source of truth.
Pacenote: `pacenote --bake-world levels/open.level.ron`, then `OpenWorld` loads from the level;
ghost replays are keyed by the level's content hash.

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

## Using the editor

Build the game with the engine feature `editor` (the game's own feature, e.g. `dev = ["engine/editor"]`;
the example is `cargo run --example editor_demo --features editor -- --editor`) and start it with
`--editor [--level levels/x.level.ron]`. Without `--editor` the same binary is the game. Default
and ship builds do not contain any of this (`cargo tree` shows no `bevy_egui` without the feature).

**What `--editor` does** (`src/editor/mod.rs`): `engine::app` adds `EditorPlugin` after the engine
plugins. There is no extra `AppState`: the game stays in `AppState::InGame` (so the code that
builds its world on entering the game still runs and shows up as *generated*), with the
`EditorMode` resource present, `Paused(true)` (virtual and physics time frozen; gameplay sets gated
with `not_paused` do not run), `PauseAllowed(false)` (no pause menu on focus loss) and so the
engine's "gameplay" action context off. A game system that ignores `Paused` and reads raw keys
still sees them: gate it. The render scale is forced to 1.

**Layout** (UE5 / Unity style; the plan is `docs/EDITOR_AUDIT.md` section 3):

```
Menu     File  Edit  Window  Tools  Help
Toolbar  [Save][Undo][Redo] | Modes: [Select][Landscape][Foliage][Splines][Place] |  [Play][Pause][Stop]  | [Settings v][Commands][?]
Left     Modes panel        Centre   document tabs: Level (viewport, never closes) | Logic: door | Script: score
Right    Outliner over Details | World Settings                   (Details is always in front when something is selected)
Bottom   Content Drawer: a 30 px strip (Content Drawer ^ | Output | Messages); Cmd+Space opens it; Dock turns it into a dock panel
Status   Mode / Tool | level (* unsaved) | play state | message ........ selection | undo | [Content] [Output]
```

- **Modes** are what a click in the viewport does: *Select* (default; transform tools Select / Move /
  Rotate / Scale are the bar inside the viewport, top left), *Landscape* (Sculpt and Paint),
  *Foliage*, *Splines*, *Place*. A mode is disabled when the game has no tool for it. The Modes
  panel shows the mode's help, its tool settings (the same property grid as Details) and, in
  Select and Place mode, the palette: registered types by category, then **every `.glb` under the
  assets folder** by folder. In Place mode the type is a dropdown, not a text field. Keys 5 to 9
  still arm the world tools; `Mode` is derived from the active tool, so `editor.tool` and the
  buttons always agree.
- **Content Drawer**: closed it is a strip; **Cmd+Space** (or Cmd+J, or the status bar's Content
  and Output buttons) opens it to about a third of the screen (drag the top edge to resize). *Dock*
  moves Content / Output / Messages into the dock under the viewport; Window > "Undock the content
  drawer" (or the command `editor.drawer_dock`) puts them back.
- **Document area**: `EditorUi::open_logic_tab(path)` (double-clicking a Logic asset, the palette,
  `editor.tab {path}`) adds a tab; the viewport is not drawn while a document is in front.
  The tab body is `logic::show` (WP-C).
- **Window menu**: a checkbox per panel, the drawer, **Layouts** (Default, Landscape, Logic: also
  `editor.layout {name}`) and Reset layout. A saved layout from before the Modes panel is dropped
  for the default one. The dock layout is saved to `<data dir>/editor_ui.json`.
- **Settings**: the toolbar's Settings menu opens *World Settings* (a tab beside Details: sun,
  sky, ambient, fog and exposure of the `Look`; terrain detail; streaming), *Project Settings*
  (window: scatter, HLOD and floating-origin budgets) and *Editor Preferences* (window: theme,
  UI scale, fly speed, snap step, grid, scenery fade, control hint). The first two are backend
  groups (`EditorBackend::settings / set_settings`, schema + JSON drawn by the Details property
  grid; engine side `src/editor/settings_backend.rs`, which edits the `Look` and `WorldSettings`
  resources like `look.set` / `world.settings`; fields that toggle a rendering feature are left
  out on purpose). Preferences persist to `<data dir>/editor_prefs.json`
  (`EditorUi::prefs_json / load_prefs`). Script them with `editor.settings {group, value}` and
  `editor.window {name, open}`.
- **Command palette** (Cmd+K): every command (including modes, layouts, windows), then entities
  (select + frame), models (place) and Logic / Script / Level assets (open).
- **Help** (F1): searchable, scrolls, always shows its scroll bar.

**Viewport controls**. No mouse button has to be held, so a trackpad is enough. They work while
the pointer is over the viewport and no text field has the keyboard (Cmd / Ctrl held = a shortcut,
not a move):

| Input | Does |
|---|---|
| W A S D | move the camera (Shift = 3x faster); eases in and out |
| Q / E | down / up |
| Arrow keys | turn |
| Drag on empty space (past 4 px) | look around (yaw / pitch). A click without dragging selects (Shift / Cmd adds, empty space clears; lights are picked by their marker) |
| Drag a gizmo handle | move / rotate / scale; one undo step per drag (a press on a handle never turns the camera) |
| Right-drag | look around too; scroll while looking = fly speed (also set in the overlay) |
| Two-finger scroll, pinch | dolly forward / back |
| Alt + left drag | orbit around the selection (else a point ahead) |
| Middle drag, or Space + left drag | pan |
| Drag a model tile from the Content Browser onto the viewport | place it where the ray under the drop point hits (mesh, else ground plane); one undo step |
| F | frame the selection |
| 1 / 2 / 3 / 4 | Select / Move / Rotate / Scale tool |
| 5 - 9 | the world tools, in toolbar order (Spline, Sculpt, Paint, Foliage, Place) |
| G / L | snap on-off / local-world gizmo axes |
| Cmd+S, Cmd+Z, Cmd+Shift+Z, Cmd+D, Cmd+A, Delete, F2, Cmd+P, Cmd+K, F1 | save, undo, redo, duplicate, select all, delete, rename, play/stop, command palette, the Controls window |

The input rules are the pure `Mouse` state machine in `src/editor/camera.rs` (click vs look
threshold, gizmo priority, typing gate; unit tests). A world tool owns the left button, the camera
keeps right / middle / Alt / Space drags. `editor.camera_drive {wish, seconds, yaw, pitch}` drives
the camera like the keys do, for scripts.

**The window** (all in `crates/editor-ui`): the layout above. The viewport overlay has the
transform tools (Select, Move, Rotate, Scale), camera speed, Snap with its step, Local / World, an
axis gizmo and a one-line control hint you can dismiss. Outliner: entities in folders by kind
(Roads / Splines, Gameplay, Foliage, Lights, Cameras, Meshes, Other, and a Generated folder folded
by default) with a Type column, an eye per row and search matches highlighted. Details: the name,
type and id, a component search and Transform first. Content is a grid of tiles with licence
badges. Tooltips carry the shortcut. Help > Controls (F1) lists every shortcut. Type sizes are
14 px body, 12 px small.

Select: no gizmo. Move: three arrows and three plane squares (world axes; Local in the overlay or `L`).
Rotate: three rings. Scale: three handles with boxes (local axes) and a centre box for uniform
scale. Handles keep a constant size on screen and are picked by screen-space distance.
Generated entities (built by code, no `LevelEntity`) show greyed in the Outliner and get no gizmo.
While the camera is being dragged egui gets no keys.

**Scenery distance fade**: the engine's detail ranges stay on in the editor (big worlds need them), but
the selection and every `SplineRoad` are exempt: their meshes lose the `VisibilityRange` while
selected / present and get it back after (`src/editor/fade.rs`; the flat far twin of a piece is
hidden meanwhile). **View > Show all scenery (no distance fade)** switches `scenery_detail` and
`shadow_trim` off for everything; it is off by default and remembered in
`<data dir>/editor_prefs.json`. Measured with `world_editor_demo -- --editor --uncapped --size 4096
--pcg-all` (4 km terrain at 2 m, ~44 000 entities, trees and rocks over the whole map, camera 1.3 km
out looking at the middle), offscreen 1920x1080, Apple M5 Pro, `perf.stats` frame time after a
20-25 s settle: fade on (default) p50 4.7 ms, p95 7.7 ms; show all p50 7.7 ms, p95 12.0 ms
(+55 %); back to fade on p50 3.9 ms, p95 4.7 ms. On a map that size leave it off and use it to
check how a place looks from afar.

**Play / Stop**: see `src/editor/play.rs`. Play writes the level to
`<data dir>/play/editor_play.level.ron` (the open file is untouched), runs
`memgate -- cargo build --manifest-path <game> (--bin|--example <exe name>) [--features F]`
(plain `cargo` without memgate; output streams into the Output panel with `file:line:col`), then
starts the freshly built executable with `--level <that file> --control 0` and the metrics viewer.
The editor viewport stops drawing while the game runs (the toolbar shows Stop). Stop kills the
game's process group. The game is found through `EditorConfig::manifest`, env
`EDITOR_GAME_MANIFEST`, the parent of `GameInfo::assets_fallback`, the working folder or the
executable's folders. `EditorConfig::play_features` / env `EDITOR_PLAY_FEATURES` give `--features`
(needed when the game's `editor` feature is not a default one); `skip_build` runs the executable
as is.

**Scripting**: every backend call is an `editor.*` control command (`src/editor/control.rs`; the
table is in its module docs and in `engine.commands`). Example, with `scripts/play.py`:

```json
[{"cmd": "editor.select", "params": {"names": ["Crate"]}},
 {"cmd": "editor.apply", "params": {"op": {"SetComponent": {"entity": {"Stable": 3},
   "type_path": "bevy_transform::components::transform::Transform",
   "before": null, "after": {"translation": [2.5, 0.6, 0], "rotation": [0,0,0,1], "scale": [1,1,1]}}}}},
 {"cmd": "editor.command", "params": {"id": "editor.undo"}},
 {"cmd": "editor.save", "params": {"path": "levels/x.level.ron"}},
 {"cmd": "editor.tab", "params": {"tab": "Logic"}},
 {"shot": "editor"}]
```
`editor.apply` records the op on the UI's undo stack (`"undoable": false` to skip). Run it with
`python3 -I scripts/play.py steps.json --example editor_demo --features editor -- --editor`
(offscreen by default: cameras and the whole egui window render into the 1920x1080 image
`screenshot` captures).

**Details panel** (`crates/editor-ui/src/details.rs`, `props.rs`). Header, then `+ Add` /
`+ Add Logic` and a component search, then sections in this order: Transform, Rendering, Physics,
Gameplay, **Logic**, Other. A component's section is its `ComponentDoc.category` (a type's
`#[reflect(@Category("Gameplay"))]`), else a guess from its name. Every field has a label made from
its name (`snap_to_ground` is `Snap to ground`), hover text, an optional unit after numbers and a
reset arrow (a circular arrow in front of the label) when it differs from `Default::default()`
(`ComponentDoc.default`); a section header has the same arrow for the whole component.
Hints come from reflect attributes (`engine::editor::schema`): `#[reflect(@Tip("..."))]`,
`@Unit("m")`, `@DisplayName("...")`, `@Hidden`, `@Choose("rows")` (an integer field picked from the
rows of the sibling list `rows`, shown as a table: the spline tool's point list) and, on the type,
`@Category`, `@Tip`. They travel as `TypeSchema::Field { meta, inner }`; code that reads a schema
calls `.inner()`. Engine types get built-in hints (`Transform`, `BrushSettings`).
`+ Add` lists the registered component types (searchable, sorted, generics stripped).
`+ Add Logic` offers a new graph from a template (`empty`, `basic`, `trigger_zone`, `door`,
`pickup`, `timer`, `action_key`, `event_start`; name defaults to `<Entity>_logic`) or an existing
`.logic.ron`; "Create and attach" calls `logic_create` and sets `Logic { graph }` as one undoable
`SetComponent`, and the Logic section offers "Open graph". The Logic section lists the attached
graph with a status dot (green compiles, red has errors), Open (the Logic tab) and Detach (removes
the component, the file stays). Not offered on generated entities. Gaps: editing several selected
entities at once shows only the first.

**Output / Messages** (`output.rs`): one log of the editor (refused edits, failed places and saves,
every toast), logic (`LogicDiagnostics`: graph and ruspy errors with file, line, column),
build (the Play build's cargo output) and engine (WARN and ERROR from `tracing`, installed through
`LogPlugin::custom_layer` with feature `editor`). Source toggles (Editor / Logic / Build / Engine),
a level filter (Errors / Warnings / Info / Debug), search, Clear, and a count of warnings and errors
on the tab (`Output (3)`). A click selects the line's entity (`Diagnostic.entity`) or opens its
`.logic.ron` in the Logic tab, else copies `file:line:col`. `editor.popup {name: add | logic | close}`
opens a Details popup for scripted screenshots. **History** (`undo.rs`): every undo step; click one
to undo / redo up to it.

**Data shown in Details** (`src/editor/schema.rs`): reflect JSON, with `Handle<A>` as the asset
path string (`""` for a handle made in code), `Color` / `Srgba` / `LinearRgba` as `[r,g,b,a]`,
`Option<T>` as `"None"` / `{"Some": v}`; `TypeSchema` from the type info (`#[reflect(@0.0..=1.0)]`
ranges as `RangeInclusive<f32>` custom attributes become `min`/`max`). Components the UI never
shows: `Name`, `ChildOf`, `Children`, `LevelEntity`, the runtime-only list of `level::RUNTIME_ONLY`
(plus `Mesh3d`/material on a `Primitive`).

**Known gaps**: the 3D view is an image shown by egui (not a window sub-rect: Bevy's atmosphere
breaks in an offset `Camera::viewport`); it is reallocated when the hole's size has held for four
frames, so dragging a divider stretches the old image first. Click picking and gizmo drags use a
window cursor and are covered by unit tests of the math and the headless backend, not by
scripted mouse input (offscreen runs have no cursor). `SetComponent` does not reject a stale
`before`. A handle made in code (no path) shows as `""` and, edited, becomes the default handle.
`Color` variants other than `Srgba` / `LinearRgba` are passed through unconverted. The generated
subtree of a level entity (glTF nodes, LOD children) is not listed in the Outliner. Play does not
close the metrics viewer on Stop. Terrain / spline / foliage tools (World tools) are not built.

### World tools

The toolbar's **Modes** group (a mode is only enabled when the level can use it): **Landscape**
(Sculpt, Paint), **Foliage**, **Splines**, **Place**. Picking one switches the transform gizmo off,
shows the **Modes** panel (left dock: the tool's help line, its settings in the same property grid
as Details, and the Place palette) and gives the tool the left mouse button. **Select** or a
transform tool in the viewport bar goes back to the gizmo. While a tool is active **Delete is the tool's** (a spline
point, a tree), not "delete entity". The UI knows tools only as `ToolDoc { id, label, hint,
settings, schema }` (`EditorBackend::tools / active_tool / set_active_tool / set_tool_settings`);
`src/editor/tools/` implements them. Every edit is an `Op` the engine hands to the UI's undo stack
(`EditorBackend::take_recorded`), so Undo / Redo (Cmd+Z) work the same for all of them.

| Tool | Pointer | Settings | Op |
|---|---|---|---|
| Sculpt | brush ring on the terrain (ray vs `TerrainHeights`); drag dabs 20 times a second (and every quarter radius); `[` `]` radius; Shift inverts Raise / Lower | `BrushSettings`: kind (Raise, Lower, Smooth, Flatten, Ramp, Noise), radius, strength, falloff, target, ... | `TerrainPatch { layer: Height, rect, before, after }` (blob ids in `TerrainPatchStore`; undo = `TerrainEdit::apply_blob`); a Ramp stroke applies on release |
| Paint | same ring; Shift paints layer 0 (erase) | layer 0..3, radius, strength, falloff | `TerrainPatch { layer: Splat }` |
| Spline | select the Spline entity in the Outliner. Click a point selects it (drawn highlighted), dragging it follows the ground (terrain, else y = 0) plus `ground_offset`; Ctrl+click adds a point (into the nearest segment, or appended / prepended past an end); Delete removes the selected point (a spline keeps two) | `ground_offset`, `snap_to_ground`, and the selected point: `point` (change to select another), `width`, `bank`, `tags`, `data` | `SetComponent(Spline)`; a drag is one op from where it started; field edits merge per point |
| Foliage | **Select**: hover highlights what `pcg_pick` finds (works on merged meshes), click picks, drag moves it (applied on release), Delete removes it. **Paint**: drag a capsule-shaped area. **Place**: click adds one catalog item (its Spawn node is found in the graph) | `mode`, `radius`, `density` (0 clears, 0.3 thins), `item` (catalog items), `node`, `random_yaw`, `scale` | `SetComponent(PcgOverrides)` on the chosen volume's entity (added if missing); the volume entity must be a level entity |
| Place | click puts the palette's type at the first mesh under the cursor, else the ground | `type_path` (from `Placeables`) | `Spawn`; the new entity is selected |

Scripting: `editor.tools` lists them; `editor.tool {id, settings}` activates one and merges the
settings (`id` omitted = back to the gizmo tools); `editor.tool_action {action, ...}` does what a
pointer would: sculpt / paint `stroke {points: [[x, z], ...], shift?}` and `sample {at}`;
spline `select {stable | id | name, point?}`, `add {pos}`, `move {point, to}`, `delete`,
`set {width?, bank?, tags?, data?}`; foliage `pick {at}`, `scan {at, radius}` (lists pickable
items), `move {to}`, `delete`, `area {center | from + to, radius, density}`, `place {at, item?, node?}`;
place `place {at, type_path?}`. Example: `examples/world_editor_demo.rs` driven by
`scripts`-style steps (the run in the Stream C report: sculpt, paint, spline, foliage, place, each
with a before / after screenshot and an undo).

**Which volume** (Foliage `volume` setting, a combo of volume names; `Auto` default): a named volume; else the selected entity if it is a volume; else, among the volumes holding the point, the smallest one whose graph has a Spawn/Emit node for the item (Place) or the `node` (Paint with a node filter); else the only volume there. Several left: an error in the Output panel ("several foliage volumes here: pick one in the Tool panel"), never a guess. With a volume chosen the `item` combo lists the items its graph spawns.

Known gaps of the world tools: a PCG volume follows sculpting only with `PcgFollowTerrain`
(docs/PCG.md; the demo's Dressing has it), otherwise its surface is a copy of the heights; a spline point
drags on the ground (no 3D gizmo on a point); the foliage Paint area is a capsule (start to end of
the drag), not a free polygon; Ramp has no live preview; sculpt / paint strokes by mouse are
covered by the math tests and the scripted strokes, not by synthetic mouse events.

**What a click selects** (`src/editor/picking.rs::pick_root_with`, unit-tested): the nearest `LevelEntity`
above the hit; else the nearest ancestor with `GeneratedBy` (the building, not its wall); else the topmost
*named* ancestor that is not engine-internal (`cell 3,4`, `chunk`, `pcg`, `World`...); else the hit itself, so
an unnamed or merged mesh is always selectable. Selection never depends on the Outliner: the UI no longer
drops ids that are missing from the tree, and the backend lists the selected entity (and the way down to
it) in `tree()` even when it is unnamed or sits under an internal node. Such an entity gets a name from its
kind and index (`Mesh 852`), and `TreeNode.origin` says who built it.

**Generated objects** (no `LevelEntity`): selectable and outlined (the orange box), read-only (gizmo off,
edits refused). Add `engine::level::GeneratedBy("my_game::town")` to code-built entities: the Outliner lists
them in the Generated folder with the origin in the type column, picking a part selects the marked root, and
Details shows a banner "Generated by my_game::town" with **Convert to level entity**. Without the marker
the origin is the internal prefix (`pcg`), else the `Name`, else "generated". Convert (`editor.convert {id}`,
`EditorBackend::convert_to_level`) adds a `LevelEntity` with a fresh stable id and a name to the same
entity (undo removes it again); a mesh that is not a `Primitive` is not written to the level file, so
convert helps shapes and entities that carry reflect components.

**Content Browser**: folder tree on the left (collapsible), breadcrumbs, type chips (Models, Audio,
Textures, Levels, Logic, Scripts; folders stay visible), search, Grid / List. The grid is hand-laid:
`cols = floor((width + gap) / (tile + gap))`, one full-width row per `cols` tiles, `show_rows` so only the
visible rows are drawn. Tile actions come from `AssetKind::actions()`: Model = Place, Level / Script /
Folder = Open, Logic = Open + Attach, Audio / Texture = Preview, Material = Assign, Other = none.
Nothing is on the tile itself: select a tile and its actions are buttons in the footer (Preview, Assign
and Attach show disabled until built); double-click runs the primary action; right-click gives the same
actions plus Copy path and Show in Finder (`EditorBackend::reveal_asset`). Only models can be dragged.
`editor.content {dir, view: grid|list, kinds: [..], search, select}` drives the view from scripts.
Toasts: the same message again within 2 s replaces the toast with a counted one ("... (x3)").
`obj` is no longer listed as a model (it loaded as nothing: only glTF has `#Scene0`).

## Changes requested by Stream C (engine adapter)

- `editor-ui`: `EditorUi::show_panel(name)` brings a tab to the front (for `editor.tab` and tests);
  the `snarl` feature is on in the engine's `editor` feature (the Logic tab renders, see below).
- **egui-snarl blank**: not a problem with bevy_egui 0.43.1. Its primary context carries an
  `EguiSchedule` and the pass loop runs `egui::Context::run_ui`, which repeats the pass on
  `request_discard`; the nodes render in the first screenshot of the Logic tab. No `max_passes`
  change is needed. Keep the primary context on `PrimaryEguiContext` (a context without
  `EguiSchedule` runs one pass per frame and would show the discarded one).
- `EditorUi::show` can run several times per frame (that pass loop): it must stay free of side
  effects on the first pass of a discarded pair other than reading input (it is today).
- `Placement::screen = Some([u, v])` (a drop point as fractions of the viewport) places at the ray hit
  and wins over `position` (`editor.place {screen: [u, v]}`).
- `place_asset` with `Placement::position == [0,0,0]` places at the viewport centre (mesh hit,
  else the ground plane, else 8 m ahead); any other position is used as is.
- `SetComponent` values are the UI form of `src/editor/schema.rs` (above); `before` is not checked.
- Tree: unnamed generated entities are skipped unless selected or marked `GeneratedBy` (children attach
  to the nearest shown ancestor), engine internals ("far detail" LOD children, gizmo renderers, FPS counter, perf overlay) and the
  generated subtree of a level entity are not listed.
- Known gaps (WP-A): Preview (audio, texture), Assign (material) and Attach (logic) are disabled in the
  Content footer; models have no thumbnails (painted glyphs); Show in Finder spawns `open -R`
  (macOS) / `explorer /select` / `xdg-open`; the Content panel is still 230 px tall until the layout
  work (WP-B); a drop from the Content Browser works for models only; merged scenery meshes are
  selectable one by one but have no map back to their source entity.
- Not done yet, for a later stream: logic diagnostics in the Output panel, a Tool panel for the
  world tools, Delete of generated entities (refused by design).
