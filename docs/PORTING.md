# Porting a game onto `engine` (notes from the core stream)

## Settings
- Core settings (Controls/Video/Audio rows) are always loaded/saved by `EnginePlugin`.
- Game settings: `#[derive(Resource, Serialize, Deserialize, Default, Clone, PartialEq)] #[serde(default)] struct MySettings {..}`
  then `engine::app(GameInfo::new("id","Title")).add_plugins((engine::settings::SettingsPlugin::<MySettings>::default(), MyPlugin)).run();`
  (added after `app()`). File `<DataDir>/settings.json` = `{"core":{..},"game":{..}}`; a flat legacy file is read into both sections.
- Saves 0.6 s after the last change, on `SaveSettings`, and on `AppExit`. Corrupt file → `settings.json.corrupt` + defaults.
- Rows: `app.register_setting(FieldDef { key, tab, label, hint, kind, get: |w| .., set: |w, v| .. })`; tab order with `app.set_settings_tabs(&["Gameplay","Controls","Video","Audio"])`.
- Tests: `engine::app_with(info, EngineOptions::headless_test(dir))` → headless, starts InGame, data dir = `dir`, no devtools/trace; `app.finish(); app.cleanup();` then loop `app.update()`; `TimeUpdateStrategy::ManualDuration` for determinism (see tests/headless.rs).

## Shroud specifics
- Player: `FpsController { walk 5, sprint 8, crouch_height 1.2, jump 6.5, eye 1.65 / crouch eye 1.0, .. }.bundle(center)`, camera child tagged `MainCamera`. Map PlayerIntent/ExternalControl → `FpsInput`/`ExternalInput`; PlayerLook/ViewKick/PlayerMotor → `FpsLook`/`FpsViewKick`/`FpsMotor`. Weapon systems `.after(FpsSet::Move)`. Re-add the game's "y < -5 → reset" safety net.
- Look: engine does quality, MSAA, FOV only. Shroud keeps Exposure ev100 13, AgX, DistanceFog, AtmosphereSettings + AtmosphereEnvironmentMapLight on its camera, FxAssets. `engine::gfx::sky_and_sun()` = Shroud's default sun/atmosphere/ambient; use `engine::gfx::Sun` in map::look.
- Audio: `Sfx` → `SoundLibrary::load_variants(server, dir, name, "audio/<name>", n)`; play/play_at → `engine::audio::play(.., AudioCategory::Sfx, vol, at)`; ambient bed → `play_loop(.., AudioCategory::Ambience, ~0.58)`. Muting automatic.
- Settings: difficulty, map, crosshair_color, crosshair_size, show_callouts → `ShroudSettings` (game section); FieldDefs on "Gameplay"/"HUD"; `set_settings_tabs` Gameplay first.
- `ops::data_dir`/`assets::assets_dir` → `DataDir`/`AssetsDir` resources (SHROUD_DATA_DIR / SHROUD_ASSETS still work). `GameInfo::assets_fallback(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets"))`.
- `GameState` → `AppState::InGame` + Shroud sub-states (Playing/Evolving/Debrief) with `#[source(AppState = AppState::InGame)]`. `GameSeed`, `Paused`, `not_paused`, `has_visuals` from engine.
- Control-port look: `LookInput` follows injected mouse motion in InGame while unpaused.

## Devtools
Control port, offscreen capture, perf monitor + overlay, session log and trace now live in the engine (`engine::devtools`, `engine::trace`). `EnginePlugin` adds `DevtoolsPlugin` and `TracePlugin` (features `devtools`/`trace`, `EngineOptions.devtools/trace`).

What Shroud's port must change:
1. **Delete Shroud's copies** of `ops/control.rs`, `ops/offscreen.rs`, `ops/perf.rs`, `ops/perf_stats.rs`, `ops/perf_sys.rs`, `ops/session_log.rs`, `ui/perf_overlay.rs` and the generic half of `ops/commands.rs`. Import from `engine::devtools` instead: `AddControlCommand` (alias `ControlAppExt`), `params`, `PendingReplies`, `ReplyId`, `SessionLog`, `DebugLines`, `PerfAppExt`, `PerfOverlay`, `PerfOverlayKey`. `add_control_command` / `add_deferred_control_command` keep the same signatures, so registration calls only change their imports.
2. **Keep Shroud's game commands** (`game.state` with player data, `player.*`, `debug.overlay`, `enemy.*`, `ai.*`, `sim.*`) in Shroud. Map old generic names onto the engine's with `app.alias_control_command(old, new)`: `game.quit`→`engine.quit`, `game.pause`→`engine.pause`, `game.resume`→`engine.resume`, `game.menu`→`engine.menu`, `capture.screenshot`→`screenshot`. Keep Shroud's own `game.start` if it must also reset the match; otherwise alias it to `engine.start`. `time.scale` / `time.step` / `perf.stats` / `perf.overlay` / `perf.report` are already engine commands. `time.step` now steps through `Paused` (`PauseCtl`), so gameplay sets must be gated with `not_paused` (not by `Time<Virtual>` alone).
3. **Perf**:
   - Replace the hard-coded AI/weapons timings with `app.perf_span(Update, EnemySet, "ai")` and `app.perf_span(Update, WeaponSet, "weapons")`; physics (`StepSimulation`) is timed automatically with the `physics` feature.
   - Move the match/round/evolve/AI-reset lines of the old `watch_events` into a Shroud system calling `Res<SessionLog>.event(name, json!({..}))`. The engine logs `AppState` changes and pause/resume itself.
   - Insert `PerfOverlayKey(KeyCode::F2)` to keep the overlay on F2 (engine default F3; Shroud's enemy debug uses F3).
   - Game rows on the overlay / in `perf.stats`: `ResMut<DebugLines>.set("squad", ..)`.
   - Env names follow the game id: `SHROUD_PERF=off`, `SHROUD_PERF_TOP=<n>` (unchanged).
4. **Trace**:
   - Drop `ops/trace.rs` (its `GameEvent` enum and `TracePlugin`): `EnginePlugin` adds the engine's `TracePlugin`.
   - Declare event names once: `app.declare_trace_events(&["match.start", "match.end", "round.end", "player.died", "ai.evolved", "ai.reset"])` (in a plugin `build`), then record with `engine::trace::trace_event(world_or_res, "ai.evolved", &[("generation", Prop::Int(g))])`. Undeclared names are sent without props.
   - `perf.hitch`, hang detection (armed on the first `AppState::InGame` frame), the panic hook, `--crash-test` and `notice_shown` (on entering `MainMenu`) are built in.
   - `SHROUD_TRACE_ENDPOINT` / `SHROUD_TRACE_KEY` keep working (from `GameInfo.id`).
5. **Data dir and flags**: `SHROUD_DATA_DIR` works through core's `<ID>_DATA_DIR`. `--seed` feeds core's `GameSeed`, so Shroud's own `GameSeed` goes. `--control`, `--mcp`, `--offscreen`, `--perf`, `--gpu-passes` behave as before; the `control: port=<n> key=<file>` stdout line is unchanged and the key file stays in the data dir.
6. **`--offscreen`** retargets every camera that draws to the window (not only `PlayerCamera`) into one 1920x1080 image, including cameras spawned later. The UI camera stays the one marked `IsDefaultUiCamera`, else the `MainCamera`.
7. **`scripts/play.py`**: Shroud can use the engine's `scripts/play.py` from its repo root with `--package game` (or `--bin shroud`). Its old CLI keeps working (positional steps file, `--headless`, `--onscreen`, `--out`, `--seed`, `--no-build`). It waits for `engine.state` = `InGame`; against a binary without engine commands it falls back to `game.state` = `Playing`, `capture.screenshot` and `game.quit`. If Shroud keeps its own script instead, update its command names (`engine.state`, `screenshot`, `engine.quit`).
8. **Input injection** for tests needs no game commands: `input.key {key, action: tap|down|up}` and `input.mouse {dx, dy, button, action}` send real Bevy input messages. Headless `app()` has no Bevy `InputPlugin`; add `bevy::input::InputPlugin` in headless test runs that inject input (as `examples/devtools_probe.rs` does).
9. **Tests**: Shroud's `tests/*.rs` parse the same `control:` line and need no change beyond renamed commands (none if the aliases from item 2 are registered). `ui.screen` / `ui.nav` only work in windowed runs (headless has no UI kit).

## Metrics window

Dev builds (feature `devtools`) chart every metric in a second window and keep a history of runs, so a code change can be judged against the runs before it.

- **Window**: `"<title> — metrics"` opens next to the game window in plain dev runs. It never opens in `--headless`, `--offscreen`, `--control` or `--mcp` runs, or with `--no-metrics-window`. `--metrics-window` forces it on. F4 (`MetricsWindowKey`) or `metrics.window {on?, scroll?}` toggles it. Closing it doesn't quit the game; closing the game window quits both. It never takes focus. Clicking it doesn't grab the game's cursor (`input.rs` only counts clicks while the game window has focus). Keys pressed while it has focus still reach the game, because Bevy's input is global.
- **Layout**: a header (game, commit + `*` if dirty, profile, mode, quality, labels, uptime), six summary tiles, then optional big charts for `MetricsFeatured` (empty by default), then every key grouped by prefix with now / sparkline / avg / p95 / max over the last 60 s (scroll with the wheel). At the bottom is the **runs table**: this run plus the last runs' session stats for `MetricsCompare` rows, each with its change vs the previous *comparable* run (same mode, quality, labels; others are marked ≠). Green means better, red worse, dim means within 3 %. Colours follow thresholds: frame ms green < 16.7, amber < 33.3, red above.
- **Summary tiles** (top row): **Frame** (fps, ms, p95, budget at the governor's `target_fps`);
  **CPU** (process share of the whole machine, "N of M cores", main and render thread ms per
  frame = thread busy share × frame time, new keys `cpu.main_ms`, `cpu.render_ms`, `cpu.cores`);
  **GPU** (this process's GPU ms per frame, busy %, device % and Metal allocation);
  **Bottleneck** (within budget with % spare; else GPU-bound when the GPU is busy > 80%, else the
  CPU thread filling ≥ 60% of the frame, else "Waiting (vsync / cap)"); **Memory** (footprint,
  % of RAM, GPU allocation, governor memory budget); **Quality** (preset, governor level and
  render scale, last step taken and why). The in-game FPS counter (`show_fps`) reads
  `62 FPS · CPU 9 ms · GPU 14 ms · RAM 3.5 GB` (CPU/GPU in devtools builds, from `FrameCost`).
- **Readable rows**: every row has a plain label with units ("CPU, this game (100% = 1 core)
  125% (1.3 cores)", "GPU memory, this game 255 MB", "System memory in use 16.8 GB"), headline
  rows first in each section, sections ordered Frame → CPU → GPU → Memory → Render → Spans. New
  keys: `gpu.working_set_mb` (Metal `recommendedMaxWorkingSetSize`), `gpu.alloc_pct`,
  `mem.system_used_mb` / `mem.system_total_mb` / `mem.system_pct` (Activity Monitor's "Memory
  Used"), `mem.swap_mb`, `mem.pressure` (0 normal, 1 warning, 2 critical). The GPU tile reads
  "busy % · ms" and memory vs the working set; the Memory tile shows system RAM, this game,
  pressure and swap. Developer counters (GPU resource counts, ECS, monitor overhead) are hidden
  unless `metrics.window {dev: true}`.
- **Cost**: it redraws at 4 Hz. Between redraws its camera is inactive, so Bevy doesn't touch the window at all, and it presents without vsync. A redraw takes ~0.4–1 ms of main-thread time in a dev build (`perf.metrics_view_ms`, also shown in the header). Measured on an M-series Mac, vsync off: frame p50 5.8 → 6.0–6.3 ms and p95 6.2 → 8.3 ms with it open. Close it (F4) for clean perf numbers.
- **Engine keys** (from the perf monitor, no extra sampling): `frame.ms` (every frame), `frame.fps/p50_ms/p95_ms/p99_ms/max_ms/hitches`, `cpu.process_pct/machine_pct/main_pct/render_pct/<pool>_pct`, `gpu.pct/renderer_pct/tiler_pct/process_pct/frame_ms/mem_mb/alloc_mb/passes_ms`, `mem.footprint_mb/rss_mb`, `ecs.entities`, `span.<perf_span label>_ms`, `perf.overhead_us`. The render stream adds `render.*` (every `RenderStats` field).
- **Game keys**: one line, one sample per key per frame (last write wins), behind the game's `dev` feature:
  ```rust
  #[cfg(feature = "dev")]
  app.add_systems(Update, |mut m: ResMut<engine::devtools::Metrics>, q: Query<(), With<Enemy>>| m.record("enemies.alive", q.iter().count() as f64));
  ```
  For keys built at runtime use `m.record_dyn(&format!(..), v)`. Optional extras: colour levels with `m.set_threshold("ai.think_ms", 2.0, 4.0)`, run labels with `m.set_label("map", "warehouse")` (or `metrics.label {key, value}`), runs-table rows with `resource_mut::<MetricsCompare>().add("ai.think_ms", "avg")`, and big charts with `MetricsFeatured`. Samples from the first `Metrics.warmup` seconds (default 3) are left out of session stats.
- **History**: `<data dir>/metrics/sessions.jsonl` gets one JSON line per run on exit: id, game, version, commit, dirty (`git rev-parse --short HEAD` / `git status` of the working dir, probed on a thread at startup), profile, mode, quality, labels, args, and per key `{n, min, avg, p50, p95, max}`. A checkpoint `unfinished-<pid>.json` is rewritten every 30 s, so a killed run is appended with `"ended": "killed"` by the next start. The session log also gets a `metrics.summary` line.
- **Control commands**: `metrics.dump {prefix?}` (now / last-60 s / session stats per key, run info, view state), `metrics.sessions {n?}` (this run + last n), `metrics.label`, `metrics.window`, `metrics.screenshot {path?}`. With `--offscreen --metrics-window` the view renders into an image that `metrics.screenshot` saves, e.g. `python3 -I scripts/play.py scripts/metrics-window.json --example metrics_demo -- --metrics-window`. Steps can use `{"shot": "name", "cmd": "metrics.screenshot"}`.

## Ship builds (release)

Debug tooling never ships. The engine's debug features are `devtools` (control port, MCP,
offscreen capture, perf overlay, and the engine CLI flags `--control --mcp --offscreen
--headless --play --quit-after --seed --mute --sound --volume --crash-test`) and `trace`
(ashlar-trace crash/perf reporting, which only reports when an endpoint env var is set, so it
does nothing on a player's machine). Without `devtools`, `cli::dev_flag`/`dev_value` ignore
the command line, so none of those flags work in a shipped game. `has_flag`/`arg_value`
stay available for a game's own player-facing flags.

A game wires it like this:

```toml
[dependencies]
engine = { path = "../engine", default-features = false, features = ["physics", "fps"] }

[features]
default = ["dev"]                        # cargo run / cargo test keep every debug tool
dev = ["engine/devtools", "engine/trace"]

[profile.release]                        # workspace root Cargo.toml
strip = true
debug = false
lto = "thin"
codegen-units = 1
```

Package with `scripts/package.sh --manifest <Cargo.toml> --package <pkg> --bin <bin>
--features "<ship features>" --assets <assets dir>`. It builds with `--no-default-features`,
fails if any `ashlar-*` crate (control, command, mcp, docs, trace) is still in the dependency tree or the binary,
and copies only the binary and `assets/` into `dist/<bin>/` (no docs, scripts, tests,
examples). Check without a release build: `cargo tree -p <pkg> --no-default-features
--features "<ship features>" -e normal | grep ashlar` must print nothing.

## Render budget

Every game on the engine gets this with **zero code**: `EnginePlugin` adds
`render_budget::RenderBudgetPlugin`, and untagged meshes are classified automatically.
Module docs: `src/render_budget/{mod,detail,stream,pacing,stats}.rs`.

What runs by default:
- **Classification.** Explicit tags win: `Actor` (player, enemies, pickups, anything that moves)
  or `Scenery` (static map pieces) on a mesh or any ancestor. Untagged meshes: under a camera,
  skinned/morphed, or under a non-static avian `RigidBody` → actor at once; otherwise watched for
  `RenderBudget::settle_frames` (60) frames and made scenery if they didn't move, an actor as soon
  as they move. Auto scenery that moves later goes back to an actor (full detail, shadows back).
  Actors are never changed: full detail, always cast shadows.
- **Distance detail** for scenery (dithered `VisibilityRange` crossfades, no popping): pieces whose
  largest side is < `small_size` (1.5 m) fade out beyond `small_props` (60 m) and stop casting
  shadows beyond `shadow` (50 m); bigger pieces switch at `far` (80 m) to a far twin (the
  game's `FarLook`, else the same mesh with a flat untextured material tinted with the texture's
  average colour, no shadows) and vanish beyond `view` (170 m). Distances are `SceneryRanges`
  (metres at High) × `QualityPreset::detail_scale` (Low 0.6, Medium 0.8, High 1.0, Ultra 1.5).
  Set `view` to where your fog is opaque so the edge is never seen. `KeepDetail` opts a piece out.
  Bevy 0.19 applies these ranges for the first 32 cameras only (active or not): keep the camera
  count under that (`render.stats` → `cameras`; the engine warns once past 32).
- **Render scale** (`RenderScale`, `render_budget/scale.rs`). `scale < 1` renders the main
  camera (with its post effects) into an image of `scale ×` the window's physical size; a Camera2d
  (order main+1, render layer 30, `IsDefaultUiCamera`) upscales it bilinearly with CAS 0.35, so
  UI stays native. Sizes round to 8 px and scales to 0.05; at 1 it all goes away (no cost).
  Bevy's `MainPassResolutionOverride` is no substitute: post passes ignore it (DLSS only).
  While scaled, `world_to_viewport` on the main camera is in scaled-image pixels. Township Ultra
  offscreen: GPU 13.8 ms at 1.0, 10.6 ms at 0.5 (fixed costs: 4096 sun cascades, probes).
- **Quality governor** (`QualityGovernor`, `render_budget/governor.rs`). Holds `target_fps`
  (60, budget B = 1000/fps ms).
  - *Signal.* In devtools builds: `GpuLoad::sample`, this process's GPU time per frame over a
    1 s window (Δ IOKit `accumulatedGPUTime` / frames; not busy % × frame time, which counts
    stalls and vsync), flagged `clean` when the window had no hitch. It acts once per new clean
    sample taken after its 2.5 s cooldown: down after 2 over 0.95 B (two steps on one over
    1.4 B), up after 4 under 0.70 B and only if the step's measured saving also fits under
    0.85 B. GPU-bound = busy share with hysteresis (in at 85%, out at 70%); unknown never blocks
    a step down. Ship builds (no sample): frame-time EMA, down on missed frames (1.15 B), up by
    trying a step.
  - *Bans.* A step that comes back and has to go again within 15 s is banned for 60 s, then
    120 s, then 600 s.
  - *Ladder.* Default: only levers that leave render pipelines alone: scale 85% → 75% → half sun
    shadow map → `Game(1)` → scale 65% → `Game(2)` → scale 50%. `GovernorStep::Game(n)` is the
    game's own lever: it reads `GovernorState::game_level` (Shroud: fewer shadowed lamps). View
    features (SSR, SSAO, contact shadows, volumetric, shadow filter, bloom, TAA) exist as steps
    but stay off the default ladder: on macOS Bevy 0.19 compiles pipelines synchronously
    (`pipeline_cache.rs`, `block_on`), so each toggle stalls the render thread, and meshes skip
    frames until their new shaders exist. (This was Shroud's repeating 0.8–2.4 s hitches and
    part of its flicker.) Used, they stay off at least `costly_hold` (30 s).
  - *Memory.* Footprint over `memory_budget_mb` (default 60% of RAM) applies `memory_steps`
    (half shadow map, probes frozen, scale 70%, volumetric) for the session.
  - Steps go on a copy of the game's `QualityPreset` (all tiers) and `RenderScale`: the saved
    quality never changes. `apply_camera_quality` only inserts camera components that are
    missing or different, so TAA history survives preset changes.
  - Active in unpaused `InGame` while any of the app's windows is focused (the metrics window
    counts); off by default in `--control`/`--offscreen`/`--mcp` runs (tests and benchmarks keep
    their quality). Each change sends `QualityChanged` (`.text(fps)` for a toast), updates
    `GovernorState` and (devtools) writes a `quality` event to the session log. Devtools:
    `render.governor {enabled, target_fps, max_scale, scale}`, metrics `render.scale`,
    `render.governor_level`, `render.governor_load_ms`.
- **wgpu indirect validation** is off in debug builds too (Bevy drops it only in release):
  it adds a compute pass before every indirect render pass (Township Ultra 11.6 → 11.2 ms GPU).
  `WGPU_VALIDATION_INDIRECT_CALL=1` turns it back on.
- **Pipeline warm-up** (`render_budget/warmup.rs`). Bevy builds a render pipeline the first
  time a (mesh layout, material, view) combination is drawn, synchronously on macOS: the first
  muzzle flash or impact in a round stalls a frame and meshes waiting for pipelines skip frames.
  After loading a level (behind its loading screen) send `WarmPipelines`: for
  `PipelineWarmup::frames` (3) frames every loaded `StandardMaterial` is drawn on a tiny quad
  0.5 m in front of the `MainCamera` (casting shadows, so shadow pipelines compile too), plus
  each `PipelineWarmup::extra` mesh/material pair (skinned or morphed meshes, other vertex
  layouts). Devtools: `render.warmup`.
- **Main view guard.** Each frame the main camera's aspect ratio is checked against its viewport
  and its `Frustum` against projection × transform; a mismatch is repaired, counted in
  `render.stats` → `view_fixes` and warned about once. Bevy only recomputes these on change and
  window events, and a Shroud window opened behind a fullscreen app in another macOS Space once
  culled nearly all scenery for a round. `render.stats` also reports `eye`, `eye_forward`,
  `aspect` and `viewport`.
- **Frame pacing.** Menus, pause and boot update reactively (30 Hz when focused, 8 Hz unfocused;
  30 Hz in control-port/offscreen runs) so the GPU idles; unpaused gameplay is continuous.
- **CPU frustum culling** (Bevy, always on) is counted; `RenderStats` is filled every frame and
  recorded into `Metrics` as `render.<field>` in dev builds (plus `render.cpu_us`, the budget
  systems' own cost). Control commands: `render.stats`, `render.budget {occlusion, detail,
  shadow_trim, streaming, stream_spawned, idle_skip, detailed_stats}` (toggle at runtime).

Opt-in (measured below):
- `RenderBudget::occlusion_culling = true`: GPU occlusion culling (+ depth prepass) on the main
  camera, where the GPU supports it (`RenderStats::occlusion_supported`). Slower on every scene
  measured here; try it only for heavy indoor overdraw and measure. Re-measured on Shroud's
  Township (Ultra, 3 views, real per-frame GPU samples, 2026-10-28): 11.1 / 9.7 / 16.6 ms off vs
  11.1 / 9.7 / 16.2 ms on, within noise. Still off.
- **Light clusters** (`render.clusters {total, z_slices}`, devtools): Bevy 0.19 caps a view at
  4096 clusters (it asserts beyond), so only the split between screen tiles and depth slices can
  change. On Township (37 lamps + 18 probes) 4096 × 24 (default), × 12, × 6, × 32 and 1024 × 24
  all measured within noise: keep the default.
- `RenderBudget::idle_skip = true`: frames where nothing visible changed (no mesh/camera/light/UI
  change, no removal, no asset change, no resize, no `RequestRedraw`, no pending screenshot) are
  simulated but not drawn; at least one frame in 30 is drawn. Needs pipelined rendering (the
  desktop default). Shaders animated by time, custom material assets and gizmos must send
  `RequestRedraw` while they animate. `RenderStats::redraw_reason` says why a frame was drawn.
- **Streaming** (`SceneryStream`): for big maps, register scenery as data:
  `stream.add(pos, move |c: &mut Commands| c.spawn((Mesh3d(m.clone()), MeshMaterial3d(mat.clone()), tf)).id())`.
  Cells (sized from the scene's extent unless `cell_size` is set) within `view + buffer` of the
  camera are spawned, nearest first, 64 per frame; cells beyond `+ hysteresis` are despawned.
  `RenderBudget::stream_spawned_scenery` instead hides spawned `Scenery` roots by cell (no gain
  measured over distance detail, so off).
- **COLLIDERS ARE NEVER STREAMED.** Streaming closures spawn visuals only; spawn colliders once,
  separately (a collider on a streamed visual logs a warning). Physics, AI raycasts and
  navigation always see the whole map. Detail tiers and hide mode only touch visibility.

Turn things off with the resource, e.g. `app.world_mut().resource_mut::<RenderBudget>().scenery_detail = false;`
(or `auto_classify`, `shadow_trim`, `streaming`), `FramePacing { enabled: false, .. }`.

### Measurements

`examples/render_budget.rs`: 300×300 m city (100 ground tiles, ~170 buildings and ~120 yard
walls that occlude, 4 000 props, 20 walking actors), driven over the control port with
`--offscreen --uncapped` (vsync off), High quality, 1920×1080, Apple M5 Pro. Each row: 7 s at a
fixed camera pose (`walk` = camera walking a loop), optimisations toggled at runtime.
GPU ms = process GPU time per frame. "drawn" = meshes the camera drew / meshes in the world.

| pose | config | fps | p50 ms | p95 ms | GPU ms | drawn |
|---|---|---|---|---|---|---|
| street | all off | 315 | 3.04 | 4.23 | 2.73 | 3484 / 4644 |
| street | occlusion only | 303 | 3.29 | 3.61 | 3.02 | 3484 / 4644 |
| street | detail only | 337 | 2.94 | 3.36 | 2.82 | 351 / 4644 |
| street | streaming only | 333 | 2.97 | 3.39 | 2.84 | 2638 / 3732 |
| street | **default** (detail + trim + streaming) | 332 | 2.97 | 3.38 | 2.82 | 351 / 3732 |
| overview | all off | 344 | 2.86 | 3.28 | 2.54 | 4334 / 4644 |
| overview | occlusion only | 314 | 3.18 | 3.44 | 2.73 | 4334 / 4644 |
| overview | **default** | 345 | 2.87 | 3.27 | 2.45 | 160 / 2254 |
| yard | all off | 332 | 2.95 | 3.43 | 2.77 | 3442 / 4644 |
| yard | occlusion only | 301 | 3.29 | 3.70 | 2.96 | 3442 / 4644 |
| yard | **default** | 342 | 2.91 | 3.25 | 2.72 | 262 / 2765 |
| walk | all off | 336 | 2.94 | 3.39 | 2.76 | 1344 / 4644 |
| walk | occlusion only | 287 | 3.34 | 4.26 | 2.91 | 596 / 4644 |
| walk | **default** | 340 | 2.92 | 3.18 | 2.64 | 189 / 4021 |

Same city with 40 000 props (`--props 40000`):

| pose | config | fps | p50 ms | p95 ms | GPU ms | drawn | entities |
|---|---|---|---|---|---|---|---|
| street | all off | 259 | 3.74 | 4.97 | 3.76 | 32238 / 40644 | 41 469 |
| street | **default** | 323 | 3.07 | 3.42 | 2.95 | 1736 / 32172 | 32 997 |
| overview | all off | 268 | 3.64 | 4.54 | 3.51 | 40231 / 40644 | 41 469 |
| overview | **default** | 350 | 2.84 | 3.07 | 2.58 | 480 / 19315 | 20 140 |
| walk | all off | 279 | 3.51 | 4.15 | 3.14 | 9570 / 40644 | 41 469 |
| walk | **default** | 308 | 3.20 | 3.63 | 2.89 | 1620 / 35605 | 36 430 |

Other results:
- **Pause / menus** (reactive pacing): GPU busy 85–92 % → 21–32 %, steady 30 Hz.
- **Idle skip** (static street view, no actors): GPU busy 79 % → 2 %; 342 of ~350 frames skipped
  over 6 s; the loop runs at ~55–60 Hz while skipping. Screenshots taken while skipping are correct.
- **Zero config**: the same city with no `Actor`/`Scenery` tags at all (`--stream none
  --untagged`) gives identical counts (drawn, far, culled) and frame times as the tagged one.
- **Cost**: the budget's own systems take ~30 µs/frame at 4.6 k meshes and ~200–320 µs at 40 k
  (mostly the dev-only per-mesh counters; `RenderBudget::detailed_stats` is off in ship builds).
- The empty city still costs ~2.5–3.5 ms GPU at High: full-screen passes (SSAO, TAA, bloom, 3
  shadow cascades at 1080p) dominate, so culling shows most where geometry is heavy (40 k
  props: up to −0.9 ms GPU and −1.5 ms p95) and on weaker GPUs.

Tried and dropped (or left opt-in):
- GPU occlusion culling by default: 3–15 % slower in every pose (walk p95 3.39 → 4.26 ms);
  the depth prepass + two-phase culling cost more than the draws it saves with GPU-driven
  batching. Opt-in.
- Trimming shadows of big scenery at 50 m: a building's shadow vanishing at mid range is
  visible (screenshot check). Only small props lose shadows; big pieces keep them until their
  far twin takes over.
- Hide-mode streaming of spawned scenery: no measurable gain over distance detail (which already
  stops drawing it); kept as an option.
- View-direction bias for streaming: an FPS turns 180° in ~0.1 s and frustum culling already
  skips what's behind; not worth the pop-in risk.

### Shroud
Nothing is required. Recommended:
- Tag the player and enemy roots `Actor` (otherwise an enemy standing still for its first second
  is briefly treated as scenery until it moves), and the map root `Scenery`.
- Shroud's arenas are small: at High nothing is far enough to change. On Low (×0.6) props fade
  beyond 36 m and big blocks go flat beyond 48 m. If that's too aggressive for an arena, raise
  `SceneryRanges` or give hero props `KeepDetail`.
- Set `SceneryRanges::view` to the fog's end distance.
- Weapon viewmodels under the camera, pickups that bob, doors that open are actors automatically.
- Don't use `SceneryStream` for arena maps (they're small; colliders stay as they are).

## Second game: Courier (what a non-FPS game needed)

`~/codes/game/courier` is a third-person hover-bike delivery game on a 1.28 km procedural map,
built to check the engine works for something unlike Shroud. It uses the engine's app shell,
settings (own `CourierSettings` section, "Gameplay"/"Camera" tabs), menus (`MenuConfig`,
`register_screen`, a sticky results screen), UI kit (HUD), quality presets, `SceneryStream`
(~9 000 props streamed by cell, colliders spawned once), metrics, control port and trace.
Engine additions it needed (branch `game-support`), all generic:

- **A new game's Cargo.toml** names bevy itself, with no features: `bevy = { version = "=0.19.1",
  default-features = false }` next to `engine = { path = .., default-features = false }`. Bevy's
  derives (`Component`, `Resource`, `Message`, `SystemSet`) expand to `bevy::ecs::..` paths found
  through the game's own manifest, so `engine::bevy` alone fails with "cannot find `bevy_ecs`".
  The engine still picks every feature.
- **`SpatialQuery` reads `Position`/`Rotation`**: a system with both it and
  `Query<&mut Position>` panics at startup (B0001). Use a `ParamSet` (probe, then write), as
  Courier's `bike::drive` does.

- **`engine::chase::ChaseCamera`** (`ChasePlugin`, added by `EnginePlugin`): third-person
  follow camera for any root entity: trails the target's heading, looks ahead, orbits with
  `LookInput` and recenters when the mouse rests, and with `physics` pulls in front of
  colliders between the target and the camera. `active: false` hands the camera back to the
  game (menu flyovers); `snap = true` after teleports. The FPS controller was the only camera
  before.
- **`engine::meshkit::MeshKit`**: build low-poly meshes from Bevy primitives (or raw
  triangles/quads) with a transform and a colour each, as one vertex-coloured mesh, smooth or
  flat-shaded; `meshkit::displace` for noisy rocks. Games without models (prototypes, jams)
  need this immediately; one mesh + one white material per object type batches well.
- **`DataDir::load_json` / `save_json`** (+ `paths::load_json/save_json/write_atomic`): save
  games / records next to settings.json with the same guarantees (atomic write, a corrupt file
  moved to `<name>.corrupt` instead of crashing or being overwritten). Settings now share
  `write_atomic`.
- **`gfx::SunSetup` + `sky_and_sun_with`**: `sky_and_sun` hard-coded Shroud's arena sun
  (shadows to 90 m, 3 cascades). Open maps need shadows to ~300 m with 4 cascades, another sun
  angle and ambient; `sky_and_sun()` is unchanged (`SunSetup::default()`).
- **`Toast` is registered by `EnginePlugin`** even without the UI kit, so gameplay systems can
  post toasts in `--headless` runs (writing an unregistered message panics).

## API stability for games
Engine config structs (`MenuConfig`, `QualityPreset`, `SceneryRanges`, `RenderBudget`,
`EngineOptions`, `SunSetup`) gain fields over time. Build them with `..default()` so a new engine
field doesn't break a game: `MenuConfig { eyebrow: "…", main_items: vec![…], ..default() }`.
