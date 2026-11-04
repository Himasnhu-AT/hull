# Engine editor vs Unreal Engine 5.5+ editor: gap analysis and roadmap

Read-only audit of branch `editor` (dd0fe1b, Bevy 0.20.1). I read `docs/EDITOR.md`, `docs/EDITOR_AUDIT.md`
(its P0/P1 items are now implemented), `docs/LEVELS.md`, `docs/LOGIC.md`, `docs/SPLINES.md`, `docs/WORLD.md`,
`docs/PCG.md`, `docs/ASSETS.md`, `docs/COMPARE.md`, `docs/audits/*`, `crates/editor-ui/src`,
`crates/editor-proto/src`, `src/editor`. UE reference: the module list of
`refs/UnrealEngine/Engine/Source/Editor` (UE 5.8.4) and `Engine/Plugins/Editor`, plus my knowledge of UE 5.5-5.8
behaviour. I did not build or run the editor; "we have" is from code and docs. Where I could not confirm
something in code I say "not found".

Scale. Priority is for a solo dev shipping open-world driving/action games (Pacenote, Shroud):
P0 = blocks shipping or is a daily time sink, P1 = clear productivity win, P2 = nice, P3 = skip.
Effort: S = under 2 days, M = 3-7 days, L = 2-3 weeks, XL = over a month.

What we already match well (so the table can be short on them): the dock layout and Content Drawer
(Cmd+Space), Outliner/Details split, schema-driven property grid with reset arrows/units/categories,
Modes (Select/Landscape/Foliage/Splines/Place), undo journal with History panel, Output/Messages with clickable
sources, World/Project/Preferences windows, command palette, saved layouts, a Blueprint-style Logic editor
(typed pins, palette, compile errors on nodes, minimap, fire trace), full `editor.*` scripting over the control
port, and a Play that builds and launches the real game.

## 1. Gap table

### 1.1 Viewport

| Area | UE has | We have | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|
| View modes (Lit/Unlit/Wireframe/Detail lighting/Lighting only/Reflections/Optimization: Light complexity, Shader complexity, Quad overdraw, LOD coloration, Lightmap density, Collision, Nanite viz) | Viewport toolbar "Lit" menu, ~30 modes | Nothing (`ViewportCmd` has tool, snap, speed, local space, grid, show-all-scenery only: `crates/editor-proto/src/lib.rs:514`). Perspective only. | Add: Lit, Unlit, Wireframe, Normals, Albedo/Roughness (debug materials), LOD colour, Overdraw, Collision (avian debug), Scenery-fade distance, Shadow-only, Light count per cluster. Lightmap density does not exist for us (no baked lightmaps): skip. | P1 | M | Bevy debug-material/wireframe features cost a Bevy recompile: use per-view `WireframePlugin` already in Bevy, check feature flag; LOD tint via our `render_budget`. |
| Show flags | Show menu: static meshes, landscape, foliage, lights, splines, volumes, bounds, collision, fog, post process, particles, grid... | `SetShowGrid`, `SetShowAllScenery` only. | A Show menu with per-category toggles (Terrain, Scatter/Foliage, Splines, Lights icons, Gizmos/Helpers, Volumes, Colliders, Fog/Sky, Particles, Water, AI navmesh, PCG volumes). Must be render-layer/visibility toggles, never view-feature toggles (CLAUDE.md rule: pipeline rebuild). | P1 | M | `ViewInfo` growth; engine docs/LOOK.md for what is safe to toggle |
| Camera bookmarks / Spatial bookmarks | Ctrl+1..9 set, 1..9 jump; World Bookmarks (saved in map) | Not found. `editor.camera` sets pose. | Ctrl+N store / N jump, bookmark list in World Settings saved in the level header; jump list in Command palette. | P0 | S | level header (`LevelState.header`) |
| Multiple viewports / layouts (1x1, 2x2, 4-pane ortho) | Up to 4 viewports, ortho Top/Front/Side with grid | One perspective camera as an egui image (`docs/EDITOR.md` known gaps). | Ortho top/front/side with grid and snap, single viewport at a time first. A true 4-up needs 4 render targets: defer. Top-down ortho is the one that matters for road/terrain/spline work. | P1 (ortho) / P2 (4-up) | M / L | camera.rs; viewport image alloc; atmosphere in ortho |
| Camera: speed, FOV, near/far, camera shake, Cinematic viewport, aspect ratio, game view (G) | Camera menu, Game View hides helpers, Immersive mode (F11), Realtime toggle | Speed, F frame; trackpad controls are good. | FOV/near/far in Preferences, Game View toggle (hide icons/gizmos/grid), Realtime off when window unfocused, maximise viewport (F11 / Shift+Space). | P1 | S | |
| Pilot actor / cinematic camera preview | Pilot camera, Eject, Lock viewport to actor | Not found. | "Pilot" a camera or light entity (viewport = that entity's transform, edits move it). Needed for placing cameras/lights/spawn points by eye. | P1 | S | selection + camera.rs |
| Gizmos: translate/rotate/scale, local/world, snap | W/E/R, Q, coordinate system, grid/rotation/scale snap with presets, per-axis, "Absolute" | Move/Rotate/Scale, plane squares, local/world, one snap step (`src/editor/gizmo.rs`). Keys 1-4 (W/E/R aliases not in docs). | Separate snap values for move/rotate/scale with preset lists, W/E/R/Q aliases (cheap), view-plane drag, absolute/relative. | P1 | S | |
| Snapping to surface / actors, Place at cursor, "Snap to floor" (End), Align to surface normal | Surface snapping, Snap to ground, vertex snap (V), Align actors, Move to camera/grid | Place tool puts at ray hit; spline points snap to ground. No snap while dragging a gizmo handle onto geometry. | Ctrl+Shift drag = surface snap with normal align; End = drop to ground/terrain; "Move to camera"; align/distribute actors; vertex snap P2. | P0 | M | picking.rs ray vs mesh/terrain (exists) |
| Pivot editing | Alt+MMB, "Set pivot here", per-actor pivot, "Reset pivot" | Not found (the only "pivot" hits are camera orbit pivot). | Move pivot of a selection for rotate/scale (gizmo pivot mode: Selection centre / Per-object / World origin / Custom). Changing a mesh's origin is a Blender job. | P2 | S | gizmo.rs |
| Measure tool / distance | Measure tool (Shift+MMB), Stats | Not found. | Two-click ruler in metres, shown in viewport + status bar; for roads/driving a "distance along spline" readout. | P2 | S | |
| Viewport stats / Stat commands | `stat fps/unit/gpu`, Show > Stats overlay | `perf.stats` over control port, metrics viewer window on Play; editor overlay has none (not found). | Stats overlay (frame ms, draw calls, triangles, entities, streamed cells, scatter instances) fed by existing `perf.stats`/`world.*` metrics. | P1 | S | `devtools` perf monitor |
| Preview as device / screen percentage / resolution | Device preview, Screen Percentage, Game resolution | Render scale forced to 1 in editor. | Aspect/resolution frame overlay for gameplay camera; screen percentage slider for slow machines. | P2 | S | |
| Light/probe/sky controls in viewport | Atmosphere Light 0 (Ctrl+L to rotate sun), Sky | World Settings: sun, sky, fog, exposure (`settings_backend.rs`). | Ctrl+L-style "rotate sun in viewport", time-of-day slider on toolbar. | P2 | S | |
| Grid | Configurable grid, 10 cm to 10 km; ortho grid | `EditorGrid` gizmo grid (`gizmo.rs:28-46`). | Size/colour/extent in Preferences. | P2 | S | |
| Selection outline, highlight, hover | Orange outline, hover highlight, selection through | Orange AABB box; no real mesh outline (not found). | Silhouette outline pass (stencil/post), also helps picking merged scenery. Watch the pipeline-rebuild rule. | P1 | M | render feature risk |
| Focus, framing, "Go to actor" | F, double-click in Outliner | F frame, Cmd+K entities | Fine. | - | - | |

### 1.2 Level editing

| Area | UE has | We have | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|
| Copy / Cut / Paste actors, Duplicate with offset, Paste here | Ctrl+C/X/V, Alt-drag duplicate, Ctrl+W duplicate, paste at cursor | `Cmd+D` duplicate only (`lib.rs:1353`); no copy/paste (not found). | Clipboard of `EntitySnapshot`s (already exists in proto) as JSON text so paste works across levels, editor restarts and into chat; Alt-drag duplicates; "Paste at cursor"; duplicate with offset / grid step. | P0 | S | `EntitySnapshot`, `Op::Spawn` |
| Multi-select editing | Edit common properties of many actors at once | Details shows the first only (documented gap). | Multi-edit with "multiple values" fields: apply `Batch` of `SetComponent`. | P0 | M | props.rs, Op::Batch |
| Select by type / similar / invert / all children | Select All of Class, Select Mirror, Ctrl+Shift+A | Cmd+A (all), box-select not found. | Marquee select in viewport, select-all-same-type, invert, select children, selection sets (save as named). | P1 | M | picking.rs |
| Grouping | Group actors (Ctrl+G), Locked groups | Not found. | Cheap form: group = an empty `LevelEntity` parent (reparent op exists). Real value comes with prefabs below. | P1 | S | `Op::Reparent` |
| Layers | Layers panel (visibility sets) | Outliner folders by kind only. | Not "Layers": give Outliner **user folders** (stored as `EditorFolder` path component), visibility + lock per folder/entity, drag to reparent/move. Matches UE's folders (which replaced layers for most users). | P0 | M | Outliner; level file component |
| Data Layers | Runtime-toggled sets of actors (day/night, quests) | Not found. | A `DataLayer(name)` component + runtime switch + Outliner filter. Pairs with Logic. | P2 | M | Outliner folders |
| Lock / hide / visibility, Hide in game | Lock actor, eye icon, "Actor hidden in game", Show only selected | Eye per row (hidden flag in `TreeNode`); no lock. | Lock (not pickable, no gizmo), isolate selection, hidden-in-game flag. | P1 | S | |
| Outliner | Folders, type column, search with filters, columns, drag reparent, pin, "Show only selected/hidden", world selector | By-kind folders, type column, eye, search, drag-reparent op (`outliner.rs:437`), Generated folder. | Real hierarchy folders (above), column choices, filter chips (type), rename inline (F2 exists), multi-world n/a. | P0 | M | |
| Details panel | Components tree on actors, search, categories, favourites, advanced toggle, copy/paste property value, property matrix, "Edit Condition" | Sections, labels, tips, units, reset, `@Choose` tables, + Add component, + Add Logic. | Component tree with child components/entities, copy/paste property, "advanced" collapse (`@Advanced` attribute), edit-condition (`@EditIf`), asset picker thumbnails, colour wheel, curve and gradient widgets, array reorder, per-property "overridden" bold (needed for prefabs). | P1 | M-L | props.rs; prefab overrides |
| Placement / Place Actors panel | Recent, Basic, Lights, VFX, Geometry, Volumes, All Classes; drag | Place mode palette: registered types by category + every `.glb`, drag from Content. | Built-in categories (Lights, Camera, Trigger volume, Audio emitter, Spline, PCG volume, Terrain, Water) as `Placeable`s of engine types, Recent, favourites, search. Mostly a registration job. | P0 | S | `level::Placeables` |
| Geometry / BSP / Brushes / Volumes | BSP brushes, Geometry Mode, Volumes (blocking, trigger, post-process) | `Primitive` cuboid/sphere/... | Box trigger / post-process / audio / kill volumes as engine `Placeable`s with box gizmo handles (resize by dragging faces). BSP: skip. | P1 | M | volume gizmo |
| Prefabs / Level Instances / Packed Level Actors / Blueprint Actor classes | Level Instance (sub-level placed with overrides), Packed Level Actor (merged), Blueprint class = actor + components + construction script, nested | Nothing. `LevelEntity` only; a level is flat (`docs/LEVELS.md`). | **The biggest structural gap.** Needs: `*.prefab.ron` (a subtree), `PrefabInstance { path, overrides }` component, instance in Outliner as one row with "open prefab"/"edit in context", override tracking in Details, "unpack", "apply to prefab". Also gives "Blueprint class = components + logic". | P0 | L-XL | file format; Details override UI; hot reload |
| Construction scripts | Run on move/property change to rebuild actor | `GeneratedBy` + spec components (BuildingSpec pattern in EDITOR_AUDIT). | Standardise: a `#[derive(Reflect)] Spec` component + rebuild system, and "Rebuild" shown in Details; see section 2. | P1 | S | |
| Level management: streaming levels, sublevels, World Outliner, Levels panel | Persistent + streaming sublevels, level colours, "current level" | One level per file; world cells separate (`docs/WORLD.md`). | Sublevels = multiple level files loaded together (additive), a Levels panel with "current level" for new placements. For open world this is how teams split work; solo can wait but per-cell files (below) help load/diff. | P1 | L | `src/level` |
| World Partition editor (grid minimap, cell loading, runtime grid settings, data layers, HLOD builder) | World Partition window: minimap of cells, load region, cell state, HLOD build/preview | `src/world` streaming + HLOD exist; editor has no view of them (not found). | A **World** panel: top-down minimap of cells (loaded/pending/HLOD), click-to-load region, stream-source gizmo, streaming and HLOD stats, bake HLOD button. Data is already in `WorldSettings` + `world.*` metrics. | P0 | L | ortho top view; docs/WORLD.md |
| One File Per Actor / per-cell level files | OFPA: every actor its own file; no merge conflicts, partial loading | One RON per level; 44 000 entities in the demo. | Solo: skip OFPA proper, but split a big level into `levels/<name>/cells/x_y.ron` loaded per cell: faster open/save, small diffs, undo scoped. | P1 | L | WORLD.md cells, level save/load |
| Level bounds, Minimap/World Composition, Landscape streaming proxies | Level bounds, world origin rebasing | Floating origin exists (`WORLD.md`). | Show origin/rebase info in World panel. | P2 | S | |
| Autosave / Recovery / Save All / dirty marking / Revert | Autosave, restore, Save All, Revert | Save, `.bak`, dirty `*`; no autosave (not found). | Autosave every N min to `<data>/autosave/` with restore dialog on start; "Revert level". | P0 | S | level save |
| Map Check / Check for errors | Map Check, Validate Assets, Data Validation plugin | `content.check` command, Output panel. | Menu **Tools > Check Level**: missing assets, unsaved handles, overlapping duplicates, scatter out of terrain, logic compile errors, orphan stable ids; results in Messages with click-to-select. | P1 | M | `content.check`, Messages |
| Lighting build / Reflection capture / Light probes / Lightmass | Build Lighting, Build Reflection Captures, Lighting Quality, Swarm, volumetric lightmaps | `docs/LOOK.md` probes/decals (runtime). Editor: nothing. | Bake probe/reflection captures button + status ("probes stale"), Look preview. No lightmaps in Bevy: skip lightmap density etc. | P1 | M | LOOK.md probes |
| Build menu: Build All, navmesh, HLOD, Merge Actors | Build All, Build Paths, Build HLOD, Merge Actors | `ai.*` navmesh bake, HLOD config, Scenery merge at runtime. | One **Build** menu running the bakes (navmesh, HLOD, probes, PCG, terrain export) with progress in toolbar and Output. | P1 | M | each system's command |
| Merge / Replace / Convert actors | Merge Actors, Replace Selected Actors With, Convert to Static Mesh | `editor.convert` (generated -> level entity). | "Replace with..." (swap model, keep transform), convert primitive to .glb export P3. | P2 | S | |
| Terrain-conforming placement ("Snap to landscape"), Drop on terrain | End key, Landscape snap | Spline points follow ground; Place hits first mesh. | Covered by surface snap row. | - | - | |

### 1.3 Tool modes (Landscape, Foliage, Mesh paint, Modeling)

| Area | UE has | We have | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|
| Landscape sculpt/paint | Sculpt (Sculpt, Smooth, Flatten, Ramp, Erosion, Hydro erosion, Noise, Retopologize, Visibility, Mirror, Copy/Paste, Selection), Paint, Manage (New, Resize, Import/Export), Edit layers, Splines | Sculpt (Raise, Lower, Smooth, Flatten, Ramp, Noise), Paint 4 layers, undo via `TerrainPatch` (`src/editor/tools/terrain.rs`, `WORLD.md`). | Missing: **thermal/hydraulic erosion** (huge for realism, can be a compute pass), **terrain layer manager** (more than 4 layers, layer assets with PBR textures, weight blend), **import/export heightmap (r16/png)** and **resize**, mask/selection, copy/paste/stamp, brush alpha textures, tool "preview" for Ramp, landscape holes (visibility), **terrain edit layers** (non-destructive, P2), spline-to-terrain deform (flatten under roads, with falloff), water bodies. | P0 (erosion, layers, import/export, spline deform) | L | `world::edit`, splat format (4 layers max today) |
| Foliage | Foliage mode: paint/erase/select, per-type density, slope, align to normal, scale ranges, cull distances, Procedural Foliage Spawner, instanced foliage actors | PCG overrides: pick/move/delete, paint density areas, place catalog items (`tools/foliage.rs`). Brush is a capsule, not free polygon. | Paint brush with per-type settings (slope/height/align/scale/yaw) writing into overrides; "reapply" ; filter by type; free-form area; the PCG graph is the "procedural spawner": a PCG graph **viewer/editor** (below). | P1 | M | PCG |
| PCG graph editor | PCG editor: node graph, debug, inspection, per-node timings | `crates/pcg-core` graphs in RON, no editor UI (not found). | Reuse the Logic editor canvas for PCG graphs (egui-snarl already integrated): same palette/compile/minimap shape, plus a preview of points in viewport and per-node counts. | P0 | L | logic canvas, pcg-core; docs/PCG.md |
| Splines | Landscape splines, Spline Component with tangents, spline mesh | Spline tool: points on ground, width/bank/tags/data, Ctrl+click add (`tools/spline.rs`). No 3D gizmo on points. | 3D point gizmo (height), tangent handles for Bezier option, insert/split/join/reverse buttons, spline-to-ribbon preview, snap endpoints to another spline (junctions), copy along spline. For Pacenote roads this is core. | P0 | M | gizmo.rs |
| Mesh Paint / Vertex paint | Vertex colour / texture paint | Not found. | Skip. | P3 | - | |
| Modeling tools (Modeling Tools Editor Mode, UV Editor, Geometry scripting) | Extrude, bevel, UVs, boolean, PolyGroups, pivot actions | None. | Skip: use Blender. Offer only a Blender round-trip (re-import glb on change; hot reload of models). | P3 | - | assets hot reload |
| Fracture / Chaos | Fracture mode | `src/props` (topple, debris). | Skip. | P3 | - | |

### 1.4 Assets and Content Browser

| Area | UE has | We have | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|
| Content Browser basics | Tree, tiles/list/columns, filters, search, favourites, collections, breadcrumbs, thumbnails, drag/drop, "Save all", create menu | Tree, breadcrumbs, type chips, search, grid/list, drag models (`content.rs`). Action footer per kind. | Missing: **real thumbnails** (3D render for models, texture previews; cached in `<data>/thumbs`), create menu (New folder/Level/Logic/Material/Data table/Prefab), **rename / move / delete / duplicate** with reference rewrite, favourites + collections (named lists in `editor_prefs.json`/project file), sort, multi-select, asset tags, size column. | P0 | L | thumbnail renderer (offscreen camera, exists for screenshots) |
| Asset Registry / references | Reference Viewer, Size Map, Asset Audit, Find references, Asset search (plugin AssetSearch) | None. | Scan RON/level/logic files for path strings: "Referenced by" and "References" lists in Content footer, unused-assets report, size map of a folder. It is grep with a UI because our assets are plain files. | P1 | M | `scripts/assets.py`-style scanner in Rust |
| Redirectors / rename safety | Redirectors after move; fix-up | None needed if the rename tool rewrites references; stable path = identity. | Rename/move tool that rewrites references in `*.ron` (levels, logic, worlds); no redirectors (see section 2). | P1 | M | reference scanner |
| Import pipeline | Interchange: glTF/FBX/USD/Alembic, import dialog, reimport, texture compression settings, LODs | `scripts/assets.py import` + cook (KTX2). `tools/ue-import` exists on another branch. | Import dialog in editor (drag file in: glb/png/ogg/hdr), runs cook, writes LICENSES.json entry (licence field required), **reimport** on source change, texture settings (sRGB/normal/mip) sidecar `.import.ron`. | P0 | L | `assets.py`, `tools/cook` |
| Asset editors (Static Mesh editor, Texture editor, Skeletal Mesh, Physics Asset, Curve, Sound Cue/MetaSound, Font, Data) | One tab per asset type, preview scene, details | Only Logic and Script tabs. | Document tab framework exists (`open_logic_tab`). Add an `AssetEditor` trait so each kind registers a tab: **Model viewer** (glb preview: materials, LODs, bounds, collider, sockets) P1; **Texture viewer** P2; **Data table / curve** (below) P1; **Material** P1; **Sound** P2. | P1 | M each | doc-tab trait |
| Materials (Material Editor, Instances, functions, parameter collections) | Node graph, instances with overrides, Material Layers | `StandardMaterial` via `gfx::load_pbr`; Content "Assign" disabled. | Not a node graph. **Material asset** (`*.mat.ron`: PBR params, texture slots, tiling, tint) + material-instance style parent/override, preview sphere, assign by drag to mesh. Node-based shaders: P3 (needs WGSL; use `ExtendedMaterial` hand-written in Rust). | P1 | M | doc-tab trait, schema-driven grid |
| Data Assets / Data Tables / Curve tables / Curves / String tables / Gameplay tags | `DataAsset` (typed properties), DataTable (row struct + CSV/JSON import), Curve editor, GameplayTags manager | RON by hand; `l10n` JSON; Details grid can edit any Reflect value. | **Data editor**: open any `*.data.ron` registered with a Reflect type; table view for `Vec<Row>` (the `@Choose` table is the seed); CSV import/export; **Curve editor** (float curve with keys, tangents, preview) used by anim/vfx/audio. Replaces 3 UE editors with one schema-driven one. | P1 | M-L | schema.rs, props.rs table widget |
| Collections / tags / saved filters | Collections, Asset tags | None. | Favourites + collections (simple). | P2 | S | |
| Migrate / Asset Actions / Bulk edit | Migrate to other project, bulk rename, property matrix, "Bulk Edit via Property Matrix" | `assets.py import`. | Migrate = copy folder + its transitive references into another project, with licence entries (reference scanner makes it easy). Bulk rename pattern. | P2 | M | reference scanner |
| Licence tracking | not UE | `LICENSES.json`, `content.check`, licence badges | Ahead of UE. Show missing-licence warnings in Messages and block Package. | P1 | S | |
| Source Control | Perforce/Git/Plastic UI: checkout, submit, diff, history, status icons | None; project is git. | Git panel: status badges on tiles/Outliner rows (modified/new), diff of a level (entity-level summary, since RON sorted by stable id), commit button with message, "Revert asset". Don't wrap every git feature. | P1 | M | git CLI via backend; sorted RON already diffs cleanly |
| Content hot reload | Auto reimport on file change (some) | `hot_reload` feature, level hot reload | Make sure edited glb/png reload in editor viewport. | P1 | S | |

### 1.5 Logic, scripting, animation, audio, VFX, UI editors

| Area | UE has | We have | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|
| Blueprint editor (Kismet) | Event graph, functions, macros, variables, dispatchers, components panel, class defaults, interfaces, compile, debug (breakpoints, watches, stepping), Find in BPs, search | Logic editor: events/flow/data nodes, variables, comments, compile errors, minimap, Fire with path pulse, script tabs (`crates/editor-ui/src/logic`). | Gaps: **functions/macros/subgraphs** (reuse), **live execution highlight and watches while the game plays** (docs/LOGIC.md known gap), breakpoints, auto-layout, entity pickers, **Find in all graphs**, graph diff/copy-paste across graphs, event dispatch to other entities, interfaces. | P1 | L | logic-core; control port to the playing game |
| Blueprint classes = actors with components | Actor BP: components tree, defaults, construction script, inheritance | Entities + reflect components + `Logic`. | Via prefabs (above) + "Add Component" tree. Inheritance: prefab variants (prefab with a base prefab). | P0 | (in prefab) | prefabs |
| Editor scripting | Python, Editor Utility Widgets/Blueprints, Blutility, Scriptable Tools, Commandlets | `editor.*` JSON protocol, `scripts/play.py` steps, ruspy runtime scripts (game side). | Menu **Tools > Scripts**: run `scripts/editor/*.ruspy` or Python/JSON step files with the `editor.*` API; custom menu entries registered by a game (`EditorConfig::menu(...)`); a "Batch" tool (select all of X, apply op). Editor Utility Widgets: a small JSON/RON UI description rendered by editor-ui (labels, buttons, fields bound to commands) P2. | P1 (scripts) / P2 (widgets) | M | ruspy host API gets `editor` module |
| Sequencer (cinematics, level sequences, tracks, keys, camera cuts, subsequences, take recorder) | Full NLE-like timeline, Curve editor, Movie Render Queue | Nothing (not in the engine either). | A **Timeline** asset: tracks (transform, property, event, camera cut, audio, animation clip) over time, keyframes on curves, scrub in viewport, play in game via Logic. Needed for intros, cutscenes, trailers. Start with transform/camera/event tracks. Movie Render Queue: offscreen frame dump already via `screenshot` (batch at fixed step). | P2 | XL | curve editor, runtime `timeline` module |
| Animation editors (Persona, Anim Blueprint, Anim Graph, Blend spaces, montages, IK Rig, Control Rig, retargeting, skeleton/sockets) | Many | Engine has state machines, blend spaces, root motion, IK in code/RON (`docs/ANIM.md`); no editor (not found). | **Animation state machine graph editor** on the Logic canvas (states, transitions with conditions, blend space grid), preview mesh with timeline scrub and notify markers. Retargeting, Control Rig: skip. | P1 (SM) / P3 (rest) | L | logic canvas, curve editor, model viewer |
| Behaviour Tree / Environment Query / Mass / StateTree editors | BT editor, EQS, StateTree | `src/ai` BT + utility AI in code/RON (`docs/AI.md`); no editor. | BT editor on the same canvas (tree layout). Debug view of running tree in Play (Rewind Debugger-lite). | P1 | M | canvas reuse |
| Sound: Sound Cue, MetaSounds, Audio Mixer, Sound Class, Attenuation | Node-based audio assets, waveform editor (plugin), mixer panel | `docs/SOUND.md` cues, mixer, snapshots, 3D, occlusion; Content has Audio kind with disabled Preview | Audio preview in Content (play/stop), **cue editor** (a cue = list of clips + random/pitch/volume/attenuation: schema-driven data editor is enough), mixer/bus meters panel during Play, attenuation radius gizmo in viewport. | P1 | M | data editor, audio preview |
| VFX (Niagara editor, Cascade) | Emitter stack, modules, preview, debugger | `src/vfx` presets/budgets (`docs/VFX.md`); no editor. | **VFX preset editor**: data editor on `VfxPreset` with live preview in a small viewport (spawn at origin, loop), curve editor for size/colour over life. Not a module graph. | P1 | M | data editor, curve editor, preview viewport |
| UI: UMG/Widget Blueprint designer | WYSIWYG widget tree designer, animations, bindings | `src/ui` kit in code (menus, settings). | Skip the designer (code-first, immediate-mode-ish). Offer a live UI preview with hot reload and a theme editor (colours, fonts, spacing as data). | P2 | M | |
| Localization Dashboard | Gather, translate, import/export PO/XLIFF, targets, compile | `docs/L10N.md` JSON tables under `assets/locale`. | **Localization panel**: table of keys x languages with missing/untranslated highlighting, "extract keys from code/logic" scan, CSV/PO import/export, preview language switch in viewport. | P2 | M | data table widget |
| Input mapping editors, Enhanced Input assets | Input mapping contexts | `src/actions` (rebinding, gamepad) | Project Settings > Input page listing actions/contexts and default bindings, with conflict check. | P1 | S | Project Settings window |
| Gameplay tags / data hierarchy | Tag manager | None. | Skip; use enums / strings. | P3 | - | |
| AI debugging (Gameplay Debugger, Visual Logger, Rewind Debugger, EQS) | `'` debugger, logs in 3D, timeline rewind | Control commands `ai.*`, gizmos in code. | Toggle overlays in Show menu: navmesh, paths, perception cones, BT state of selected agent. | P1 | M | Show menu; ai gizmos |

### 1.6 Play, debugging, performance

| Area | UE has | We have | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|
| PIE modes: Selected viewport, New window, Standalone, Mobile preview, multiplayer N clients | Play in viewport, New editor window, Simulate, Standalone, Net mode | Play = save, `cargo build`, launch child process with `--level`, metrics viewer; Stop kills it (`src/editor/play.rs`). | **Simulate** (run the editor world itself; Stop restores a snapshot), **PIE in viewport** (viewport shows the running game: needs shared-memory frame or run game in the editor window), pause/step/speed, **Eject / Possess** (F8: leave the player and fly; the editor camera in a running game), Play From Here (spawn at camera), N-player launch with `--features net`. Standalone is what we have and is a good default (real binary). | P0 (Simulate, Play From Here, Pause/Step) | M | level snapshot round-trip; `time.scale`, `time.step` exist |
| In-editor debugging while playing | Details live-edit in PIE, World Outliner of PIE world, watch | Control port to the game exists (`--control 0`); editor does not connect to it (not found). | **Attach**: editor connects to the playing game's control port: live Outliner/Details of the running game, edit values live ("keep changes" button copies them back into the level), Logic path pulse live, Output streams from game stdout. Uses the same `editor.*` protocol, which the doc already says is a goal ("a future standalone UI"). | P0 | L | game exposes `editor.*` (feature `editor` or a read-only subset) |
| Output Log + Cmd console | Output Log, `~` console, command history, categories/verbosity | Output/Messages with source toggles and levels; no command line (not found). | Console input line in Output: runs any control command (`perf.stats`, `time.scale 0.5`), with autocomplete from `engine.commands`, history. | P0 | S | `engine.commands` |
| Message Log / Map Check | Message log with pages, tokenised links | Messages with click-to-select. | Fine. | - | - | |
| Stats Viewer (Primitive/Lighting/Texture stats), Statistics window | Table of statistics | Metrics window (`docs/PORTING.md`) | **Scene Statistics** panel: entities, meshes, triangles, texture memory by asset, scatter instances, lights and shadowed lights (the CLAUDE.md rule), draw calls; sortable, click selects. | P1 | M | render_budget metrics |
| Insights / profiler | Unreal Insights, Trace, CPU/GPU timeline | `trace` feature, Tracy (`profile`), `devkit.scopes`, metrics viewer | Launch buttons (Tools > Open Tracy / Trace) + show last perf budget result; no timeline UI of our own. | P2 | S | |
| Performance budgets in editor | Visualizers (shader complexity), Stat | `PerfBudget`, governor | Per-level budget badges (shadowed lamps count, texture MB) in World panel: matches GAME_GUIDE rules. | P1 | S | Scene statistics |
| Undo/Redo, Transaction history | Undo History panel, transaction annotation | Op journal + History panel (`undo.rs`); logic tab own stack | Decent. Missing: undo scoped across Landscape/Foliage after save (blob store lifetime), undo for asset operations. | P2 | S | |
| Multi-User Editing / Concert | Live collaboration | None. | Skip (solo). | P3 | - | |

### 1.7 Project, platform, shipping

| Area | UE has | We have | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|
| Project Settings | Hundreds of pages: Maps & Modes, Input, Engine, Rendering, Physics, Platforms, Packaging | Project Settings window: scatter, HLOD, floating origin budgets (`settings_backend.rs`). `src/settings.rs` generated settings screen for players. | Pages: General (name, version, default level), Input, Quality tiers (`docs/LOOK.md`), Physics (substeps, from audits), Audio buses, Localization, Packaging, Plugins/Features. Generate from the same reflect schemas as the game's settings so games register their own. | P1 | M | schema.rs |
| Editor Preferences | Themes, shortcuts editor, autosave, layouts, viewport, "Reset" | Theme, UI scale, fly speed, snap, grid, fade, hint. | Keyboard shortcut editor (rebind editor commands), autosave interval, restore session (reopen last level + tabs), fonts. | P1 | M | `Cmd` enum |
| Plugins browser | Plugin browser, enable/disable, restart | Cargo features. | Do not copy. A **Features** page that lists engine features with docs and the exact `Cargo.toml` line to enable (or edits it with a diff, then rebuild). Never toggles at runtime. | P2 | S | |
| Project Launcher / Packaging / Turnkey / Device manager | Cook, stage, package, deploy, profiles, device list | `scripts/package.sh`, `scripts/cook.py`, ship build with no devtools | Tools > Package: runs the script with a profile (platform, release, features), shows progress and result path, runs asset licence + `content.check` first. | P1 | M | package.sh |
| Cooking / derived data cache | DDC, cook-on-the-fly | Cook step for textures, KTX2 | Texture cook runs automatically on import; cache hash by source file. | P1 | S | import pipeline |
| Platform / device profiles, scalability | Device profiles, scalability groups | Quality tiers + governor. | Scalability preview in viewport (tier selector), no pipeline rebuild during play: use at editor start only. | P2 | S | |
| Source control | see 1.4 | | | | | |
| Help / tutorials / Documentation | Tutorials, Learn tab, Docs | F1 Controls, About | Help > Open docs folder, tips on empty states. | P2 | S | |
| Crash recovery / editor logs | Crash reporter, autosave | none | Autosave covers it. | P0 | in autosave | |
| Remote control / Web Remote | Remote Control API | `editor.*` over TCP and `--mcp` | Ahead of UE for agents. Keep it the single source of truth. | - | - | |
| VR / Mobile / Virtual Production / nDisplay / MetaHuman / Cloth / Chaos / Datasmith | Many | None | Out of scope. | P3 | - | |

## 2. Where copying UE literally is a bad idea

1. **Blueprint classes and construction scripts.** UE actors are class instances with a component tree
   defined in a binary asset and compiled graphs. We are code-first Rust: behaviour belongs in Rust systems and
   `Reflect` components; the level is data. Better: **prefabs of reflect components + `Spec` components that
   rebuild their children** (the `BuildingSpec` pattern), with Logic graphs for authored behaviour. "Class
   defaults" = prefab; "variant" = prefab with a base. No compile step, git-diffable RON, hot reload.
2. **C++ hot reload / Live Coding.** Rust has no safe equivalent and Bevy dylib reload is fragile. Do not build
   it. Better: three fast paths we already have or can finish: (a) data hot reload (levels, worlds, logic, ruspy,
   look, PCG graphs, material and data RON), (b) Simulate with level-snapshot restore, so a rebuild plus relaunch
   comes back to the same camera and selection in a few seconds (`memgate cargo build` is already wired into
   Play), (c) the control-port Attach so a relaunch reconnects. Document that logic-heavy iteration should live in
   Logic/ruspy, structure changes in Rust.
3. **Binary `.uasset` and the Asset Registry database.** Our assets are plain files; identity is the path and
   level entities have stable ids. Redirectors, asset GUIDs, DDC and Perforce-style checkout are not needed:
   use a reference scanner (grep with a UI), a rename tool that rewrites references, and git. This also keeps the
   editor Bevy-free: no editor-side asset objects.
4. **One File Per Actor.** OFPA solves multi-team merge conflicts. For a solo dev, sorted RON already diffs
   well. The real problem is size (44 000 entities in one file): split by **world cell**, not by actor.
5. **Landscape edit layers, spline-landscape blending, Nanite/Lumen debug views.** Heavy UE-internal systems.
   Do the simple version (erosion, layer manager, deform-under-spline stamped into the heightmap) and skip
   non-destructive layer stacks until the owner needs them. Lightmap/Lightmass views do not apply to Bevy.
6. **Material node graph, Niagara module graph, UMG designer, Control Rig, Modeling tools.** Each is a product.
   Instead: material = parameter asset + instance overrides (`ExtendedMaterial` in Rust for specials), VFX =
   preset editor with curves, UI = code + theme data + live reload, rigs from Blender.
7. **Many windows and a docking maze.** UE has hundreds of panels. Keep the current small set; add new tools as
   **document tabs** (Level | Logic | Model | Data | Curve | Material) and one **World** panel. Fewer panels means
   less layout state to persist and to test.
8. **A Python editor API.** UE needs it because C++ is slow to iterate. We already have JSON `editor.*` over the
   control port, MCP, `play.py`, and ruspy. Add an `editor` module to ruspy and a Scripts menu; do not embed
   Python.
9. **Toggling view features from the editor viewport menus (SSAO, TAA, bloom...).** CLAUDE.md says each toggle
   rebuilds every pipeline on macOS. View modes and Show flags must be material/visibility/layer based, or apply
   only at startup (Preferences + restart note). Quality preview = restart-free tiers only.
10. **Play in the same process (PIE).** UE can because the editor is the game. Ours is the game binary with
    `--editor`, so in-process PIE would share one `World` and break the "editor world is clean" property.
    Keep **standalone Play as the default**, add **Simulate** (snapshot/restore) and **Attach** for live inspection.
    This is better than UE for shipping confidence: the real binary is what you test.
11. **UE's heavy reflection UI (property matrix, details customisations).** Keep the schema-driven grid and use
    reflect attributes (`@Category`, `@Tip`, `@Choose`) for customisation; add `@EditIf`, `@Advanced`, `@Slider`,
    `@Curve`, `@AssetKind(...)` rather than per-type customisation classes.
12. **Multi-User, Concert, Datasmith, VR editor, source-control plugin zoo.** Not for a solo dev.

## 3. Roadmap

Rule for parallel agents: **one owner per file**. The hot shared files today are
`crates/editor-ui/src/lib.rs` (1486 lines), `crates/editor-proto/src/lib.rs`, `src/editor/backend.rs` (1115)
and `src/editor/control.rs`. Phase 0 removes that bottleneck.

### Phase 0 (3-4 days, one agent, blocks the rest): make room
- **WP-0 split & extension points.** Move `Cmd` handling, panel registry and `Req` queue out of `lib.rs`
  into `commands.rs`, `panels.rs`, `requests.rs`; add a `DocumentTab` / `AssetEditor` trait (Level, Logic,
  Script implement it) and a `Panel` trait with registration; split `editor-proto/src/lib.rs` into
  `ops.rs`, `view.rs`, `assets.rs`, `logic.rs`, `world.rs`; split `backend.rs` by area (`selection.rs`,
  `assets.rs`, `world_tools.rs`); make `control.rs` register commands per module (each WP adds its own file).
  Owned: all of the above. Acceptance: `cargo test -p editor-ui -p editor-proto`, `cargo tree -p editor-ui`
  has no bevy, `scripts/play.py` smoke (`world_editor_demo`) unchanged screenshots, no behaviour change.

### Phase 1 (about 3 weeks): the daily loop for open-world editing
Independent work packages (start after WP-0; each owns new files plus a small, listed hook in shared ones).

| WP | Scope | Owned files | Acceptance |
|---|---|---|---|
| **P1-A Viewport bar** | View modes (Lit, Unlit, Wireframe, Normals, LOD colour, Collision, Scenery fade), Show menu (Terrain, Foliage, Splines, Lights, Gizmos, Colliders, Navmesh, PCG volumes), camera bookmarks (Ctrl+N/N, saved in level header), Game View (G), stats overlay, W/E/R/Q aliases, ortho Top/Front/Side with grid. | `crates/editor-ui/src/viewport_bar.rs`, `src/editor/viewmodes.rs`, `src/editor/bookmarks.rs`, `crates/editor-proto/src/view.rs` | Screenshots of each mode on `world_editor_demo`; toggling any mode causes no pipeline rebuild (check `perf.stats` frame spike < 50 ms and no shader compile log); bookmarks survive save/load; unit tests for ortho camera math. |
| **P1-B Selection and editing** | Copy/Cut/Paste (JSON clipboard of `EntitySnapshot`), Alt-drag duplicate, paste at cursor, multi-select edit in Details, marquee select, select same type/invert, snap to ground/surface (End, Ctrl+Shift drag), align/distribute, pivot mode (selection centre / per object), lock + isolate. | `crates/editor-ui/src/edit_ops.rs`, `crates/editor-ui/src/multiedit.rs`, `src/editor/snapping.rs`, `src/editor/marquee.rs` | Kittest: paste yields same components with new stable ids, one undo removes all; multi-edit of `Transform.translation.y` on 3 entities is one `Batch`; headless test for snap-to-terrain height; docs updated. |
| **P1-C Outliner folders and groups** | User folders (component `EditorFolder`), drag to move/reparent, lock/hide per folder, group (empty parent), place-actors categories for engine types (Light, Camera, Trigger volume, Audio emitter, Spline, PCG volume), Recent/favourites. | `crates/editor-ui/src/outliner.rs`, `place.rs`, `src/editor/folders.rs`, `src/editor/placeables_builtin.rs` | Level file round-trips folders; Outliner test: drag entity to folder = one `Reparent`/folder op; Place palette shows ≥8 built-in categories. |
| **P1-D Simulate, Play From Here, Pause/Step, console** | Simulate (snapshot level, unpause editor world, Stop restores), Play From Here (spawn at camera: `--spawn x,y,z`), toolbar Pause/Step/speed for Simulate and (via control port) Play, Output console line with autocomplete. | `src/editor/simulate.rs`, `src/editor/play.rs`, `crates/editor-ui/src/output.rs` (console part), `crates/editor-ui/src/toolbar_play.rs` | Headless test: simulate moves a physics box, Stop restores transform exactly; console runs `time.scale 0.5` and shows result; `play.py` run with Simulate then Stop screenshot identical to before. |
| **P1-E Content Browser v2** | Thumbnails (offscreen render, disk cache), create menu, rename/move/delete with reference rewrite, reference scanner ("Referenced by"), favourites, import dialog (glb/png/ogg/hdr -> cook -> LICENSES entry), autosave + restore. | `crates/editor-ui/src/content.rs`, `src/editor/thumbs.rs`, `src/editor/refs.rs`, `src/editor/import.rs`, `src/editor/autosave.rs` | Rename of a glb updates a level that uses it (test); imported file shows thumbnail; autosave file appears after N s and restore dialog test; `assets.py check` still passes. |
| **P1-F Prefab format (design + core)** | `*.prefab.ron` + `PrefabInstance` component + load/save in `src/level`, overrides as diff, Outliner row, "Open prefab" as a document tab, Unpack, Apply. Editor UI minimal (instance row, override bold in Details). Fuller UI in Phase 2. | `src/level/prefab.rs`, `crates/editor-proto/src/prefab.rs`, `crates/editor-ui/src/prefab_tab.rs`, `docs/PREFABS.md` | Place prefab ×3, edit one instance (override), edit prefab (other two change), undo, save/load round-trip, hot reload; spec written first and approved. |
| **P1-G Spline and terrain upgrades** | 3D point gizmo for splines, insert/split/join/reverse, flatten-under-spline (deform terrain along a width/falloff), heightmap import/export (r16/png), terrain layer count > 4 design note. | `src/editor/tools/spline.rs`, `src/editor/tools/terrain.rs`, `src/world/edit.rs` (additions), `crates/editor-ui/src/tools_ui.rs` | `tests/terrain_edit.rs` extended: deform makes road centreline flat within tolerance; export then import is lossless to quantisation; undo of a deform stroke restores heights. |

Phase 1 exit check: build a 1 km road section in `world_editor_demo`: place prefabbed trees by copy/paste,
bookmark three viewpoints, flatten terrain under a spline, Simulate, Stop, rename an asset, kill the editor and
recover from autosave, all without leaving the editor.

### Phase 2 (about 4-6 weeks): data, world, and live inspection
| WP | Scope | Owned files | Acceptance |
|---|---|---|---|
| **P2-A World panel** | Top-down cell minimap, cell states, load region, stream source gizmo, HLOD stats/bake, floating-origin info, per-level budget badges (shadowed lamps, texture MB). | `crates/editor-ui/src/world_panel.rs`, `src/editor/world_view.rs` | On `open_world` demo: minimap matches `world.cells_loaded`; bake HLOD button runs and reports; badge turns red above GAME_GUIDE limits. |
| **P2-B Attach (live inspect)** | Editor connects to a playing game's control port; live Outliner/Details; "Keep changes" copies edits back; game log streaming; Logic path pulse live. | `src/editor/attach.rs`, `crates/editor-ui/src/attach.rs`, `docs/EDITOR.md` section | Run `world_editor_demo` Play, Attach, change a light colour live, see it in the game; Keep writes it to the level. |
| **P2-C Data and Curve editors** | Tab for `*.data.ron` of registered Reflect types, table view for row lists, CSV import/export, Curve editor (keys, tangents), `@Curve`/`@Slider`/`@EditIf`/`@Advanced` attributes in the grid. | `crates/editor-ui/src/data_tab.rs`, `curve.rs`, `props.rs` (attributes), `src/editor/schema.rs` | Edit a VFX or sound preset through it and see the change in `vfx_gallery`; CSV round trip test; curve evaluates equal to runtime. |
| **P2-D PCG graph editor** | PCG graphs on the egui-snarl canvas, point preview in viewport, per-node counts, volume bake/refresh. | `crates/editor-ui/src/pcg_tab.rs` (reusing `logic/canvas.rs` through a shared `graph_canvas` module), `src/editor/pcg_backend.rs` | Open `assets/pcg/*.pcg`, edit a node, viewport updates; compile errors on nodes. |
| **P2-E Material and model viewer** | `*.mat.ron` parameter assets with instances, model viewer tab (materials, bounds, collider, LODs), assign by drag. | `crates/editor-ui/src/material_tab.rs`, `model_tab.rs`, `src/editor/material_assets.rs` | Assign material to a mesh, save, reload level shows it; model viewer lists LODs and collider. |
| **P2-F Terrain v2** | Erosion brushes, layer manager (more layers than 4), brush alpha textures, stamp copy/paste, terrain holes. | `src/world/brush.rs`, `src/world/terrain_data.rs`, `src/editor/tools/terrain.rs` | Golden-image brush tests; erosion benchmark added to `scripts/bench.py`; format migration for `terrain.ron`. |
| **P2-G Prefab UI + Level Instances** | Overrides panel, variants, nested prefabs, "edit in context", sublevels (additive level files), per-cell level files. | `crates/editor-ui/src/prefab_tab.rs`, `src/level/sublevel.rs`, `src/level/cells.rs` | A 20 000-entity level opens/saves in under half the time of the single-file version (measure). |
| **P2-H Git panel, Check Level, Build menu, Package** | Status badges, commit, level diff summary; Check Level; Build menu (navmesh, HLOD, probes); Tools > Package with progress. | `crates/editor-ui/src/git_panel.rs`, `build_menu.rs`, `src/editor/git.rs`, `src/editor/build.rs` | Package a ship build from the menu; Check Level finds an injected missing asset. |
| **P2-I Editor scripting** | `editor` module for ruspy, Tools > Scripts menu, game-registered menu items, optional RON UI widgets. | `src/editor/scripting.rs`, `crates/editor-ui/src/scripts_menu.rs`, `docs/EDITOR.md` | A script selects all trees under a spline and deletes them (undoable). |
| **P2-J Project Settings pages + shortcut editor** | General, Input, Quality, Physics, Audio, Packaging pages from schemas; rebindable editor shortcuts; restore session. | `crates/editor-ui/src/settings.rs`, `src/editor/settings_backend.rs` | Change a shortcut, restart, it persists; Input page shows conflicts. |

### Phase 3 (months 3-5): authored content editors
| WP | Scope | Owned files | Acceptance |
|---|---|---|---|
| **P3-A Timeline (Sequencer-lite)** | Tracks (transform, property, camera cut, event, audio), keys on curves, scrub, play via Logic, frame dump render. | `src/timeline/*`, `crates/editor-ui/src/timeline_tab.rs` | 30 s intro scripted, deterministic frame dump matches golden images. |
| **P3-B Animation state machine editor** | State graph, transitions, blend space grid, preview, notifies. | `crates/editor-ui/src/anim_tab.rs`, `src/editor/anim_backend.rs` | Edit `anim_demo` machine; preview plays. |
| **P3-C Behaviour tree / utility AI editor + AI debug overlays** | Tree layout on canvas, live state in Attach. | `crates/editor-ui/src/ai_tab.rs` | Debug a running agent. |
| **P3-D Logic v2** | Functions/macros, live highlights and watches while playing, breakpoints, Find in all graphs, auto-layout. | `crates/editor-ui/src/logic/*`, `crates/logic-core` | Live pulse in Attach; breakpoint halts via `time.step`. |
| **P3-E VFX and sound preset editors** | Live preview viewport, curve editing, mixer meters. | `crates/editor-ui/src/vfx_tab.rs`, `sound_tab.rs` | Preview matches in-game. |
| **P3-F Localization panel, Features page, Insights launchers, Scene Statistics** | See table. | `crates/editor-ui/src/l10n_tab.rs`, `stats_panel.rs`, `features_page.rs` | Missing translation list matches `l10n` check. |
| **P3-G Multi-viewport, silhouette outline, pilot camera, lighting bake UI** | | `src/editor/viewport_multi.rs`, `outline.rs` | |
| Optional: node-based materials (WGSL), data layers, terrain edit layers, water. | | | |

Dependencies in one line: WP-0 -> everything; P1-F (prefab core) -> P2-G; P1-E (reference scanner) -> P2-H,
Migrate; P2-C (curve/data) -> P3-A/B/E; P2-D uses a shared `graph_canvas` extracted from `logic/canvas.rs`
(owner: P2-D, with Logic frozen during the extraction); P2-B (Attach) -> P3-C, P3-D live debugging.

## 4. Top 15 gaps by value (solo open-world dev)
1. Prefabs / Level Instances (and "Blueprint class" as prefab variants).
2. Copy / paste / duplicate-with-offset / multi-select editing.
3. Surface and ground snapping, align, pivot.
4. Outliner user folders, lock, hide, groups.
5. Simulate + Play From Here + Pause/Step/Eject, console line.
6. Attach: live inspect/edit of the running game.
7. Camera bookmarks, ortho top view, view modes and Show flags.
8. Content Browser v2: thumbnails, rename/move/delete with reference fix-up, import dialog, reference viewer.
9. World panel: cell minimap, HLOD, streaming and budget badges.
10. Spline tool upgrades (3D point gizmo, deform terrain under road).
11. Terrain: erosion, >4 layers, heightmap import/export.
12. PCG graph editor on the existing canvas.
13. Autosave / recovery, Check Level, Build menu, Package.
14. Data / Curve / Material editors (one schema-driven framework).
15. Git panel and editor scripting menu.
