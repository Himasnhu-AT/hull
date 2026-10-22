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
