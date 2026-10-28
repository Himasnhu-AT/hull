# Building a game on `engine`: the playbook

Read this before writing a new game on the engine, or before changing how an existing one
renders, loads or measures. It collects what the engine expects from a game and what we
learned the hard way shipping Shroud (an FPS) and Courier on it: every rule here exists because
breaking it cost frames, memory or a day of debugging. Module details live in the per-module
docs; this file tells you which to use when, and how not to hurt yourself.

Contents: [1 Architecture](#1-architecture-what-to-use-when) ·
[2 New game checklist](#2-new-game-checklist) · [3 Performance rules](#3-performance-rules) ·
[4 Look and lighting](#4-look-and-lighting-recipes) · [5 Assets](#5-asset-pipeline) ·
[6 Gameplay modules](#6-gameplay-modules-audio-ai-ui-input) · [7 Dev loop](#7-dev-loop-control-port-metrics-tests) ·
[8 Measuring](#8-measuring-correctly) · [9 Pitfalls](#9-pitfalls-symptom--cause--fix)

---

## 1. Architecture: what to use when

The engine is a code-first shell on Bevy 0.19.1 + avian3d 0.7. Everything is Rust or small
JSON/RON files; no editor, no binary scenes. `engine::app(GameInfo)` builds the app with Bevy's
plugins and `EnginePlugin` (flow states, settings, pause, input, audio, gfx, UI kit, render
budget, devtools when enabled). Your game is a `Plugin` added on top.

| Need | Use | Doc |
|---|---|---|
| App, states (Boot → MainMenu → InGame), pause, settings screen, menus, toasts | `engine::app`, `flow::AppState`, `settings::CoreSettings`, `ui::*` | AGENTS.md, PORTING.md |
| Quality presets, PBR textures, sun, fog | `gfx::QualityPreset`, `gfx::load_pbr`, `look::Look` | LOOK.md |
| Culling, distance detail, streaming, frame pacing, quality governor, render scale, pipeline warm-up | `render_budget::*` (always on) | PORTING.md "Render budget" |
| Sky, fog, exposure, grading, lens, reflection probes, decals, time of day | `look` | LOOK.md |
| Particles | `vfx` (`Vfx::play`, presets, `VfxBudget`) | VFX.md |
| Characters | `anim` (state machines, blend spaces, root motion, IK) | ANIM.md |
| Navigation, crowds, behaviour trees, utility AI, perception | `ai` | AI.md |
| Sound, music, mixer, captions | `sound` | SOUND.md |
| Input actions, rebinding, gamepad, accessibility | `actions` | ACTIONS.md |
| Text in several languages | `l10n` | L10N.md |
| Big outdoor worlds: terrain, scatter, cell streaming, HLOD, floating origin | `world` | WORLD.md |
| Dressing maps from data (foliage, clutter, lamps, props) with deterministic node graphs | `pcg` + `crates/pcg-core` | PCG.md |
| Multiplayer | `net` (feature, off by default) | NET.md |
| Inspector, scenario tests, replays, golden images, saves, hot reload, asset checks | `devkit` | DEVKIT.md |
| Benchmarks and regression checks | `scripts/perf_suite.py`, `scripts/bench.py` | PERF.md |

Depend on the engine with `default-features = false` and list what you use; put `devtools` /
`trace` behind your own `dev` feature so ship builds carry none of it (PORTING.md "Ship
builds"). Never change Bevy's feature set casually: features that forward to Bevy (`ktx2`,
`profile`, `hot_reload`, `look_pcss`, ...) recompile all of Bevy (~5 GB, minutes).

---

## 2. New game checklist

1. **Crate.** `engine = { path = "...", default-features = false, features = [...] }`, a `dev`
   feature for `engine/devtools` + `engine/trace`, and the shared target dir in
   `.cargo/config.toml` (AGENTS.md). Run every cargo command through `memgate`.
2. **Skeleton.** `fn main() { engine::app(GameInfo::new("id", "Title")).add_plugins(MyGame).run(); }`
   (`examples/minimal.rs`). Exactly one `MainCamera` (with `Camera3d` when not headless). Make
   rendering optional: spawn meshes only when `Assets<Mesh>` exists so headless tests work.
3. **Tag what you spawn** (section 3.2): `Scenery` for the static world, `Actor` for anything that
   moves or is pooled. Untagged meshes are auto-classified, which is slower and can be wrong.
4. **Set `SceneryRanges`** to your map (view ≈ where fog is opaque). Hero props get `KeepDetail`.
5. **Pick a `Look`** (LOOK.md presets) and set shadow distance / cascades per tier.
6. **Lights.** Budget shadow-casting lamps per tier: shadowed spots cost as much as a sun
   cascade (section 3.4). Keep the number steady and cut it through `GovernorStep::Game(n)`.
7. **Materials.** Share them. Load textured sets with `gfx::load_pbr`; cook them to KTX2 (5.1).
8. **Loading.** After a level loads, send `render_budget::WarmPipelines` (3.6). Register skinned
   meshes in `PipelineWarmup::extra`.
9. **Governor.** It's on by default (60 fps target). React to `QualityChanged` with a toast
   (`ev.text(fps)`), and give it game levers via `GovernorStep::Game(n)` (3.7).
10. **Devtools.** Register game control commands for state you'll want to drive in tests
    (teleport, freeze enemies, load map). Derive `Reflect` on components the inspector should see.
11. **Tests.** A `Scenario` test that boots the game headless and steps a round; a `play.py`
    steps file that loads each map offscreen and screenshots it (section 7).
12. **Measure** a baseline with real GPU samples before optimising (section 8), and write the
    numbers into your docs.

---

## 3. Performance rules

### 3.1 Draw calls: share and merge
- **Share meshes and materials.** Every distinct `Handle<Mesh>` × `Handle<StandardMaterial>`
  pair is its own draw; identical handles batch. Create a material once per look, not per entity.
- **Merge static geometry per material.** Shroud's level blocks were unique meshes (world-space
  UVs per block): merging plain blocks per material took Township from 1118 to 753 meshes and
  533 to 379 visible, same picture, mostly a CPU win. `gfx::world_uv_cuboid` makes tiling
  blocks; merge them per material once the layout is final.
- Use `world` scatter / HLOD (WORLD.md) or `Mesh` merging for repeated props, not thousands of
  entities.

### 3.2 Scenery vs Actor (render budget)
- `Scenery`: static world geometry and dressing. Gets distance detail (`VisibilityRange`),
  far versions, shadow trimming and optional streaming.
- `Actor`: anything that moves, is animated, or is **pooled** (casings, tracers, bullet holes,
  FX pools, grenades, glass shards). Always full detail.
- Untagged meshes are auto-classified: they sit as "settling" for `settle_frames`, then become
  scenery; if they move later they're demoted again. Pooled objects that rest then move flip
  between classes: their ranges and shadows change and they flicker. **Tag explicitly.**
- `KeepDetail` opts a piece out of distance detail; `FarLook` gives a custom far version.
- Bevy 0.19 applies `VisibilityRange` for the first 32 cameras only (active or not): keep the
  camera count low (`render.stats` → `cameras`; the engine warns past 32). Reflection probes
  share one 6-camera rig for this reason.

### 3.3 Never toggle view features mid-play
On macOS Bevy compiles render pipelines **synchronously** on the render thread. SSR, SSAO,
contact shadows, the shadow filter, volumetric fog, bloom and TAA are part of every material's
pipeline key: toggling one rebuilds every material pipeline (a stall of up to ~1 s in debug
builds) and meshes waiting for pipelines skip frames (flicker). SSR additionally flips all
opaque materials between forward and deferred. So:
- Change these only on an explicit quality change or level load, never from gameplay code.
- The governor's default ladder avoids them (3.7).
- `apply_camera_quality` inserts camera components only when missing or different; don't
  re-insert `TemporalAntiAliasing::default()` yourself (it resets TAA history: one aliased frame).

### 3.4 Shadows
- **Bevy 0.19 quirk:** spot-light shadows are layers of the *sun's* shadow texture, at the sun's
  resolution, and the layer count follows how many shadowed spots are visible. At 4096 with 10
  spots that's ~900 MB, rebuilt every time a lamp enters or leaves view (memory pulses, hitches).
  Engine defaults: sun/spot map 2048 on High and Ultra, point-light cubes 512.
- Keep the number of shadowed lamps **in view** steady: Shroud casts from the nearest K lamps
  within 25 m with hysteresis, re-ranked every 0.25 s (K: Ultra 6 + 1 cube, High 4, Medium 2,
  Low 0), and cuts K through `GovernorStep::Game(n)`.
- Point-light shadows cost six renders each: one or two at most, Ultra only.
- Use Gaussian filtering. Temporal filtering and PCSS lean on TAA history and crawl or sparkle
  at low or uneven fps (both off by default).
- Shadow distance and cascades belong to the look; `QualityPreset::max_cascades` caps them per
  tier. Short distances (40–90 m) are plenty for street-level games.
- Small, short-lived things (debris, casings, particles) should not cast shadows.

### 3.5 Particles and overdraw
- Fill rate is the cost: a smoke puff 0.5 m from the camera covers the screen and blends tens
  of millions of pixels (2–5 ms at Retina). The engine fades sprites near the camera and caps
  sprite size per metre of distance (`VfxBudget::near_fade`, `max_screen`); keep puff counts and
  sizes modest anyway, especially indoors.
- Prefer additive sparks and small flipbooks over big alpha clouds. Use `VfxBudget` and LOD.

### 3.6 Pipeline warm-up
Bevy builds a pipeline the first time a (mesh layout, material, view) is drawn. Without a
warm-up the first muzzle flash or enemy of a round hitches. After a level loads (behind a
loading or round-start screen) send `WarmPipelines`; register skinned/morphed meshes and other
vertex layouts in `PipelineWarmup::extra`. In Shroud this removed a 3.2 s map-load hitch and the
first-shot stalls. Send it immediately after the load, not a second later.

### 3.7 Quality governor and render scale
- `QualityGovernor` (on by default, off in test-driven runs) holds `target_fps`: it lowers
  render scale, sun shadow size and your `Game(n)` levels when the GPU can't keep up, and raises
  them when there's measured room. It never changes the player's saved quality.
- **Give it your levers:** put `GovernorStep::Game(1)`, `Game(2)` in its `steps` (the default
  ladder already has them) and read `GovernorState::game_level` to cut what you know is costly
  (shadowed lamps, decal counts, crowd size).
- Show `QualityChanged::text(fps)` as a toast, rate-limited.
- `RenderScale` (also usable directly as a player setting through `QualityGovernor::max_scale`)
  draws the 3D view at fewer pixels and upscales it with UI at native resolution.
- Retina note: the window has 4× the pixels of its logical size. Expect render scale to matter
  there more than on a 1× display.

### 3.8 Memory
- Textures dominate: uncompressed RGBA8 with CPU mips keeps two copies (GPU + CPU). Cook to KTX2
  (5.1): Shroud's footprint fell 2850 → 2373 MB and RSS 1423 → 842 MB.
- Shadow textures (3.4) and render targets are next. Watch `mem.footprint_mb`, `gpu.alloc_mb`
  and sudden square pulses (= a big texture being rebuilt).
- The governor's memory steps start when footprint passes 60% of RAM.

### 3.9 Threads
- The engine caps Bevy's task pools at `DEFAULT_WORKER_THREADS` (6) workers and sets thread
  priorities (`engine::threads`): one worker per core made 4 000 physics boxes drop from 60 to
  ~19 fps and kept cores busy waking threads. Override with `EngineOptions::worker_threads` or
  `ENGINE_THREADS=n`; measure before raising it.
- Your own background threads (AI training, simulation, baking) go at
  `threads::set_current(Qos::Utility)` or `Background`, few of them, and are cancelled without
  blocking the main thread.

### 3.10 Frame pacing and hitches
- Menus and pause pace reactively; gameplay is continuous. `RenderBudget::idle_skip` can skip
  drawing unchanged frames (send `RequestRedraw` from time-animated shaders).
- Hitch sources seen so far: pipeline compiles (3.3, 3.6), shadow texture rebuilds (3.4),
  synchronous asset work on the main thread, and the background work of the game itself
  (Shroud's AI trainer at 600% CPU during a match: throttle such work while playing).

---

## 4. Look and lighting recipes

All in LOOK.md; the short version:
- Author the scene's `Look` as data (sun, sky, fog, exposure, grading, lens). Start from a preset
  (`look.preset`) and tweak live over the control port (`look.set`, `look.get`).
- **Sky:** atmosphere sky looks best and drives image-based light; gradient or cubemap skies are
  cheaper. Fog `end` should match `SceneryRanges::view` so the edge is never seen.
- **Indoors:** place `ReflectionProbe`s per room/building, baked (`refresh: Some(0)`). Realtime
  probes cost captures every frame and pop at low fps.
- **Lamps:** see 3.4. Lamps without shadows are cheap; light clusters handle ~40 lamps fine
  (cluster tuning measured no gain on Township).
- **Exposure:** manual `ev100` for predictable interiors; auto exposure for outdoor day cycles.
- **Decals:** `ForwardDecal` needs a depth prepass (free when TAA is on); keep them off
  coplanar quads (Z-fighting) and offset 1–5 mm.
- Ultra is opt-in quality, not the default on large Retina displays: High plus render scale
  ~0.75 is the sensible default there.

---

## 5. Asset pipeline

### 5.1 Textures
- Source sets live in `assets/textures/<name>/` as `color.jpg`, `normal.jpg`, `rough.jpg`,
  optional `ao.jpg`, loaded by `gfx::load_pbr` with 16× anisotropy and CPU-built mips (sRGB
  filtered in linear light).
- **Cook them.** Write `color.ktx2` (BC7 sRGB), `normal.ktx2` (BC5, RG: Bevy rebuilds Z),
  `orm.ktx2` (BC5: R = AO, G = roughness) with full mip chains filtered in linear light and
  normals renormalised, plus `color.avg` (three linear floats: the average colour, used for
  far-detail materials). With the engine feature `ktx2`, `load_pbr` prefers them and loads them
  GPU-only. The engine's cook does exactly this:
  `memgate -- cargo run --manifest-path <engine>/tools/cook/Cargo.toml -- assets/textures [--only SET] [--force]`
  (standalone crate, not part of the engine build; skips sets whose outputs are newer). Bevy
  0.19 can't load UASTC/ETC1S from `scripts/cook.py` (DEVKIT.md "Content pipeline").
- Keep textures ≤ 2048 px; 1024 is plenty for tiling materials.

### 5.2 Models (glTF)
- Make sure GLB textures have mips (or are cooked); uncompressed GLB textures without mips
  shimmer at distance and cost memory.
- Skinned characters: animation LOD (`AnimConfig::lod`) and, for crowds, fewer bones far away.
- Register skinned meshes for pipeline warm-up (3.6).

### 5.3 LOD
- Scenery gets distance detail automatically (render budget). For dense meshes, author LOD
  levels or use `world` HLOD for far clusters. A mesh-LOD cook is planned (`engine::geometry`).

### 5.4 Checks
`content.check` / `devkit::content` validates references, sizes, mips and unused files
(DEVKIT.md). Run it in CI.

---

## 6. Gameplay modules: audio, AI, UI, input

- **Audio** (SOUND.md): play through cues and buses, not raw clips; set voice limits; use
  snapshots for pause/menus; captions for accessibility. Mute with `--mute` in automated runs.
- **AI** (AI.md): bake navmeshes from colliders at load (in a worker), agents through
  `NavAgent`; behaviour trees or utility AI for decisions; perception with budgets. Anything
  gameplay-relevant that's generated (cover, props) must exist **before** the nav bake.
- **UI**: use the engine's UI kit and screens (theme scales with `UiScale`); the settings screen
  is generated from registered settings. Game HUD on the default UI camera.
- **Input** (ACTIONS.md): define actions, never read keys directly in gameplay code; this gives
  rebinding, gamepad and accessibility for free.
- **Saves, hot reload, replays**: DEVKIT.md.

---

## 7. Dev loop: control port, metrics, tests

- **Drive the running game, don't guess.** `python3 -I scripts/play.py steps.json` (engine
  examples) or the game's own play script launches the game offscreen with the control port,
  runs commands and saves screenshots. Look at every screenshot you take. `engine.commands`
  lists what's available; `render.stats`, `render.governor`, `perf.stats`, `look.*`, `vfx.*`,
  `ai.*`, `ecs.*` (devkit) are the workhorses.
- **Metrics window** (`--metrics-window`, F4; `metrics.screenshot` offscreen): six summary tiles
  (frame, CPU, GPU, bottleneck, memory, quality) then every metric with sparklines and a runs
  table comparing sessions. The bottleneck tile tells you whether to optimise GPU work, the
  main thread or the render thread.
- **Session logs**: `<data dir>/logs/session-*.jsonl` record per-second perf, `perf.hitch`
  events and governor `quality` events. Correlate hitches with what happened.
- **Tests**: `Scenario` (headless, fixed 60 Hz) for game logic; golden images for look;
  `PerfBudget` assertions; `bench.py` for CPU benches. Keep integration test binaries few (each
  links Bevy, ~200 MB).
- **Checks before you commit**: `cargo check --lib`, the relevant tests, `cargo clippy --lib
  --tests`, `cargo check --no-default-features` (the ship build). All through `memgate`.

---

## 8. Measuring correctly

- **GPU time = `gpu.frame_ms` / `GpuLoad::sample`**: this process's GPU time per frame from the
  OS (Δ accumulated GPU time / frames). It is *not* busy % × frame time (that counts stalls and
  vsync). Per-pass timings are unavailable on Apple GPUs (no timestamps inside passes); for a
  per-pass breakdown use Xcode Instruments' Metal System Trace (`xctrace`).
- **Same-binary A/B.** Compare by toggling at runtime (`look.feature`, `render.budget`,
  `render.governor {scale}`, `render.clusters`) or by swapping assets for the same binary. A
  different binary changes too many things at once.
- **Debug builds are CPU-heavy.** A debug run can be CPU-bound where release is GPU-bound;
  check the bottleneck tile before concluding anything about the GPU. Apple GPUs also downclock
  when they have slack, so GPU ms rises when the frame is easy.
- **Turn the governor off** when measuring (`render.governor {enabled: false}`; it's off by
  default in `--control`/`--offscreen` runs) and freeze the gameplay (Shroud: `enemy.freeze`).
- **Offscreen vs on-screen**: offscreen renders 1920×1080 by default; a Retina window renders
  far more pixels. Re-check on-screen before trusting pixel-bound numbers.
- **Write numbers down** with the commit, the scene, the view and the quality.
- Memory: `mem.footprint_mb` (what Activity Monitor shows) and `gpu.alloc_mb`; RSS undercounts.

---

## 9. Pitfalls: symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| All scenery vanishes after a look change; actors still draw | > 32 cameras: Bevy drops the main camera from `VisibilityRange` | Fewer cameras (`render.stats.cameras`); probes share a rig; despawn unused cameras |
| Empty map on-screen (walls gone, sky/enemies fine) | Main camera frustum stale or wrong aspect after a window opened occluded | Engine guard repairs it (`render.stats.view_fixes`); check the warning in the log |
| Hitches of 0.5–2.5 s every few seconds | View features toggled at runtime (pipeline rebuilds) | Don't toggle them in play; use the default governor ladder |
| Hitch on first shot / first enemy | Pipelines compiled on first draw | `WarmPipelines` after load; `PipelineWarmup::extra` for skinned meshes |
| Memory jumps by hundreds of MB in square pulses | Shadow texture rebuilt as shadowed lamps enter/leave view | Steady shadowed-lamp count; 2048 shadow maps |
| Objects flicker at distance or when pushed | Auto-classified pooled objects flipping Scenery/Actor | Tag `Actor` / `Scenery` explicitly |
| One aliased frame on quality changes | TAA re-inserted (history reset) | Insert camera features only when changed (engine does) |
| Shadows sparkle or crawl at low fps | Temporal shadow filter / PCSS without stable TAA history | Gaussian filter (default) |
| Screen whites out in smoke | Particles at the camera | `VfxBudget::near_fade` / `max_screen` (default on); smaller puffs |
| Distant textures darker than close ones | Mips averaged in sRGB | Engine filters in linear light; cook with linear-light mips |
| Governor raises quality while slow | Stale busy-% signal | Fixed: steers on real GPU samples, measured step costs, bans |
| Governor frozen while the game is slow | Another window (metrics) focused | Fixed: any app window counts |
| `perf.stats` passes empty | Apple GPUs: no timestamps inside passes | Use `xctrace` |
| Numbers changed but nothing should have | Different binary / assets / governor on | Same-binary A/B, governor off |
