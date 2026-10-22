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
