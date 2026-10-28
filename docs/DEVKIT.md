# Devkit: the AI-friendly dev loop (`engine::devkit`, feature `devkit`)

The devkit is what makes the engine quick to build and test, by people or by agents. Everything
is code or plain data (Rust, JSON), can be driven headless or over the control port, and is
checked by tests:

| Piece | Module | What it replaces in Unity / Unreal |
|---|---|---|
| Reflection inspector over the control port (`ecs.*`) | `devkit::inspect` | Inspector / Details panel, Outliner |
| Scenario test kit (fixed step, scripted input, `wait_until`, snapshots) | `devkit::testing` | Play Mode tests / Automation (Gauntlet) |
| Input record / replay | `devkit::replay` | Input recorder / demo playback |
| Golden images (perceptual diff, diff PNG) | `devkit::golden` | Graphics test framework / screenshot comparison |
| Perf budgets (p95 frame, entities, allocations per frame) | `devkit::perf_assert` | Performance Testing extension / CSV profiler |
| Bench JSON + `scripts/bench.py compare` | `devkit::bench` | Perf regression dashboards |
| `profile_scope!` CPU timers (+ Tracy) | `devkit::profile` | Profiler markers / `SCOPE_CYCLE_COUNTER` + Insights |
| JSON hot reload (data, tuning, settings) | `devkit::reload` | Live Coding of data assets / ScriptableObject edits |
| Versioned save slots (migrations, backup, autosave, thumbnails) | `devkit::save` | SaveGame / PlayerPrefs (+ the plugin everyone writes) |
| Asset checks, KTX2 cook plan, reproducible packaging | `devkit::content`, `scripts/cook.py`, `scripts/package.sh` | Asset validation, cook, Project Launcher |

No GUI, no binary assets, no editor: an agent can read, change, run and verify all of it.
`DevkitPlugin` is added by `EnginePlugin`. When nothing uses it, each of its systems returns at
once (no watched files, no scopes, no recording or replay).

## Inspector (control port, feature `devtools`)

Types are looked up by full path, short path (`Transform`) or case-insensitive short path.
Values are reflect-serde JSON: `Vec3` = `[x, y, z]`, `Quat` = `[x, y, z, w]`, `Name` = `"text"`,
enums `"Variant"` / `{"Variant": ...}`. Entity ids are `to_bits()` numbers (the `id` field)
or `"12v0"` strings (`entity`). A game type shows up once it is
`#[derive(Component, Reflect)] #[reflect(Component)]` and `app.register_type::<T>()`
(resources: `#[reflect(Resource)]`).

| Command | Params | Result |
|---|---|---|
| `ecs.query` | `{components?, with?, without?, name?, limit? = 100}` | `{count, returned, entities: [{id, entity, name, components: {T: value}}]}` |
| `ecs.get` | `{id}` | `{id, entity, components, opaque: [non-reflected], children}` |
| `ecs.set` | `{id, component, value, replace?}` | `{value}`: an RFC 7386 merge patch over the current value (`{"translation": [0, 2, 0]}` is enough); inserts the component if it is missing |
| `ecs.remove` | `{id, component}` | `{}` |
| `ecs.spawn` | `{components: {T: value}}` | `{id, entity}`; every value is checked before anything is spawned |
| `ecs.despawn` | `{id}` | `{}` |
| `ecs.res.list` / `ecs.res.get {name}` / `ecs.res.set {name, value, replace?}` | | reflected resources |
| `ecs.types` | `{filter?, kind?: component/resource}` | `{count, types: [{name, path, component, resource}]}` |
| `ecs.systems` | `{schedule?, filter?}` | `{schedules: [{schedule, count, systems}], names, note}` |

`ecs.systems` gets system names only with the optional engine feature `debug_names` (`bevy/debug`;
it recompiles Bevy, so it's off by default). Without it you get counts per schedule and a `note`.
Schedules that are running at that moment (`Main`, `PreUpdate`, where the port drains) are
not listed. Per-system timing: wrap a system set with `PerfAppExt::perf_span` or use
`profile_scope!`, or build with `profile` and use Tracy.

Other devkit commands:

| Command | Params | Result |
|---|---|---|
| `devkit.record` | `{action: start/stop/status, path?}` | stop → `{frames, events, log}` (written to `path` too) |
| `devkit.replay` | `{path}` / `{log}` / `{stop: true}` / `{}` (status) | `{playing, events, start_frame}` |
| `devkit.scopes` | — | `{rows: [{name, ms, last_ms, max_ms, max_call_ms, calls}]}` |
| `devkit.reload` | `{force?}` | `{enabled, changed, watches: [{type, path, pointer, reloads, last}]}` |
| `save.list` | — | `{dir, version, playtime_secs, slots: [{slot, version, bytes, meta, error}]}` |
| `save.write` | `{slot, label?}` | `{queued}` (done in this frame's `Update`) |
| `save.load` / `save.delete` | `{slot}` | `{queued}` / `{deleted}` |
| `content.check` | `{assets?, src?, max_texture_px?, info?}` | the asset report (below) |

`scripts/play.py` steps can write files and check replies, so a JSON steps file works as a test:

```json
[
  {"cmd": "ecs.query", "params": {"components": ["Spinner"]}, "expect": {"result.count": 25}},
  {"write": "data/tuning.json", "json": {"speed": 4.0}},
  {"sleep": 1.0},
  {"cmd": "ecs.res.get", "params": {"name": "Tuning"}, "expect": {"result.value.speed": 4.0}},
  {"shot": "after"}
]
```

`python3 -I scripts/play.py scripts/devkit-demo.json --example devkit_demo` runs the full demo
(inspector, hot reload, scopes, a save with a thumbnail, screenshots) and exits 1 if any
`expect` fails.

## Scenario tests (`engine::devkit::testing::Scenario`)

```rust
use engine::prelude::*;
use engine::devkit::{InputLog, PerfBudget};

#[test]
fn player_walks() {
    let mut s = Scenario::new(GameInfo::new("orbs", "Orbs")).plugin(OrbsPlugin).build();
    s.step(2);                                   // Startup ran, InGame
    s.press(KeyCode::KeyW);
    s.run_secs(1.0);                             // 60 fixed steps
    s.release(KeyCode::KeyW);
    let frames = s.wait_until(120, |w| player_z(w) < -3.0).expect("reached the door");
    s.play_all(InputLog::new().hold(KeyCode::Space, 0, 10), 5);   // scripted input
    assert_eq!(s.call("ecs.query", json!({"components": ["Enemy"]})).unwrap()["count"], 3);
    s.assert_json_snapshot("score", s.resource_json::<Score>().unwrap());  // tests/snapshots/score.json
    s.assert_budget(&PerfBudget { p95_frame_ms: Some(4.0), max_entities: Some(2_000), ..default() });
}
```

- The builder: `.hz(30.0)`, `.plugin(p)`, `.setup(|app| ..)`, `.menu()` (start in the main
  menu), `.devtools(true)` (adds `DevtoolsPlugin`, so engine commands like `engine.state` can
  be called too; the `ecs.*` / `devkit.*` / `save.*` commands work without it), `.data_dir(dir)`,
  `.keep_dir()`. Each scenario gets its own temp data dir; it is removed on drop unless the
  test panicked.
- Time is `TimeUpdateStrategy::ManualDuration(1/hz)`: each `update()` is exactly one step,
  whatever the wall clock does. Together with `--seed` / `GameSeed`, runs are deterministic: the
  record → JSON → replay test in `tests/devkit.rs` ends at the same `f32` position.
- Input: `press`, `release`, `tap`, `mouse_move`, `click`, `input(InputEvent)`, `play(InputLog)`,
  `play_all(log, extra_frames)`. These write real Bevy input messages, so `ButtonInput<KeyCode>`,
  `MouseMotion` and so on behave as they would with a real keyboard and mouse.
- World access: `world()`, `world_mut()`, `res::<R>()`, `res_mut::<R>()`, `count::<F>()`,
  `single::<C>()`, `collect::<C>()`, `query::<D, _>(|iter| ..)`.
- Snapshots: `resource_json::<R>()`, `components_json::<C>()` (reflection),
  `assert_json_snapshot(name, value)`. On a mismatch it writes `<name>.new.json` and panics with
  both values. `ENGINE_BLESS=1` rewrites snapshots and golden images.
- In-process control: `call(cmd, params)` runs any instant command the way the TCP port would.
  Deferred commands (`time.step`, `screenshot`) still need the port.

### Record / replay

`InputLog` is JSON: `{"version":1,"seed":7,"frames":120,"events":[{"frame":3,"t":"key","key":"KeyW","down":true}, {"frame":9,"t":"motion","dx":4.0,"dy":0.0}, ...]}`.
Keys and buttons are stored by variant name. Record live play with `devkit.record start`, then
`devkit.record stop {path}`. Replay it in a game (`devkit.replay {path}`) or in a test
(`Scenario::play`). The recorder runs after Bevy's input systems; the replayer runs before
them, so the replayed events land in the same frame as the recorded ones.

## Golden images

```rust
use engine::devkit::golden::{assert_golden, GoldenOptions};
assert_golden("out/menu.png", "tests/golden/menu.png", &GoldenOptions::default());
```

Each pixel's difference is a YIQ distance from 0 to 1 (luma weighted about 2× chroma, as in
pixelmatch). A pixel counts as different above `pixel_threshold` (default 0.1). The image fails
when more than `max_diff_ratio` of its pixels differ (default 0.2 %). A missing golden is written
on the first run (`bless_missing`). A failing compare writes `<actual>.diff.png`: the golden
faded to grey, with the differing pixels in red. From the shell:
`cargo run --example devkit_cli -- golden actual.png golden.png` prints JSON and exits 1 on a
mismatch.

## Perf assertions and benches

- Every `Scenario::update()` is timed. Install the counting allocator in the test binary to
  also count allocations per frame (process-wide, all threads):
  `#[global_allocator] static A: engine::devkit::CountingAlloc = engine::devkit::CountingAlloc;`
- `PerfBudget { p95_frame_ms, max_frame_ms, max_entities, p95_allocs_per_frame, warmup_frames }`;
  `assert_budget` panics and lists every exceeded budget.
- `bench_report(name).write()` writes `$ENGINE_BENCH_DIR/<name>.json` with `frame.ms`,
  `alloc.per_frame` and `ecs.entities`, plus the commit, the dirty flag and the profile. Stats
  have the same shape as the metrics history (`{n, min, avg, p50, p95, p99, max}`).
- `python3 -I scripts/bench.py run` runs every `#[ignore]` `bench*` test (default
  `--test devkit`; `--manifest/--package/--test` for a game) into `target-bench/<commit>/`.
  `bench.py compare BASE NEW` prints p50 / p95 changes and exits 1 when a p95 regresses by more
  than `--threshold` (10 %). It also reads a game's `metrics/sessions.jsonl` (`FILE@<session id>`),
  so a dev session can be compared against a bench.

## Profiling

- `engine::profile_scope!("ai.think");` times the rest of the block. It costs about 36 ns per
  scope (two `Instant::now()` + three relaxed atomics) and never allocates after the first call.
  Scopes show as a `scopes` row in the F3 overlay and in `perf.stats` (`perf.debug_lines.scopes`),
  as `span.<name>_ms` metrics in the metrics window and history, and in `devkit.scopes`. The
  counters are process-global, so two apps in one process (parallel tests) share them.
- Optional feature `profile` = `bevy/trace_tracy`: every `profile_scope!` also becomes a Tracy
  span, alongside Bevy's own per-system and render spans. Run the Tracy client and connect. It
  recompiles Bevy, so build it on demand: `cargo run --features profile --example devkit_demo`.
- GPU pass timings come from Bevy's `RenderDiagnosticsPlugin` (timestamp queries). They're
  already in `perf.stats` → `perf.monitor.gpu.passes` / `passes_ms` and in the overlay. On macOS
  they need `--gpu-passes`.
- System sets: `app.perf_span(Update, MySet, "ai")` (devtools).

## Hot reload

```rust
app.init_resource::<Tuning>()
   .hot_reload_json::<Tuning>(WatchPath::assets("tuning.json"), None)
   .hot_reload_json::<CoreSettings>(WatchPath::data("settings.json"), Some("/core"));
```

The watcher polls each file's mtime and size every `HotReloadConfig.interval_secs` (0.5 s). One
poll costs about 1.5 µs per watched file and needs no watcher threads. The first poll loads the
file if it exists. After that, a change reloads it. The resource is replaced only when the new
value differs (`PartialEq`), so a game that writes the file itself (settings) doesn't loop. Bad
JSON keeps the old value; each attempt sends a `Reloaded {path, result}` message. Hot reload is
on in devtools builds and off otherwise (`HotReloadConfig { enabled: true, .. }` turns it on).

Textures, meshes and scenes reload through Bevy's own file watcher: the optional feature
`hot_reload` = `bevy/file_watcher` (it recompiles Bevy once).

## Saves

```rust
app.add_plugins(SavePlugin::<Progress>::new(SaveConfig { version: 2, autosave_secs: Some(120.0), ..default() })
    .migration(1, |mut v| { v["coins"] = v["gold"].take(); Ok(v) }));
commands.write_message(SaveRequest::save("slot1"));      // or SaveRequest::load / Delete
fn on_save(mut ev: MessageReader<SaveEvent>) { .. }       // Saved / Loaded / Deleted / Failed
```

- File: `<data>/saves/<slot>.save.json` =
  `{"format":"engine-save","version":2,"checksum":"fnv1a64:…","meta":{slot,label,saved_at,playtime_secs,game_version,thumbnail,extra},"data":{…}}`.
  It is plain JSON, so you can diff it, edit it, or fix a corrupt save by hand.
- Writes are atomic (`paths::write_atomic`). The previous good file is kept as `.bak`; an
  unreadable one never replaces a good backup.
- Corruption (bad JSON, wrong format, checksum mismatch) moves the file to `.corrupt` and
  restores the backup (`recovered_from_backup`). With no backup, the read fails with `Corrupt`.
- Migrations run from version N to N+1 over the raw data JSON. A missing step gives
  `Migration { from }`; a file from a newer game gives `FutureVersion`.
- `Playtime` counts unpaused `InGame` time; it is saved and restored. Autosave is based on
  playtime. Thumbnails: a 320×180 PNG (`<slot>.png`) of the next frame, resized off the main
  thread; windowed and `--offscreen` runs only.
- `SaveStore` is the same thing without ECS (`write`, `read::<T>`, `read_value`, `list`,
  `delete`, `migrate`), for tools and unit tests.

## Content pipeline

- **Check:** `cargo run --example devkit_cli -- assets <assets> --src <src dir> [--info]`, or
  `content.check` over the port. It reports `missing_ref` (string literals in sources / RON /
  JSON / glTF `uri`s that point nowhere, with `file:line`), `oversized` (> 4096 px), `npot`,
  `unreadable`, `large_file`, plus `no_mips` and `unreferenced` at info level. Sizes come from
  the PNG, JPEG, KTX2 and DDS headers; nothing is decoded. It exits 1 on errors.
- **Cook:** `python3 -I scripts/cook.py <assets> [--apply] [--small]` turns PNG/JPEG into KTX2
  with a full mip chain: UASTC + zstd, or ETC1S with `--small`. sRGB vs linear is chosen from
  the file name (normal, rough, metal, ao, ...), and normal maps get `--normal_mode`. The default
  is a dry-run plan. `--apply` needs `toktx` from KTX-Software 4.x (not installed here) and writes
  `assets-cooked/` plus a sorted `cook-manifest.json` with sha256 values; unchanged sources are
  skipped. Loading `.ktx2` needs the optional feature `ktx2` (`bevy/ktx2` + `bevy/zstd_rust`).
  Without cooking, the engine builds mips on the CPU at load (`gfx::PendingMips`), filtering
  sRGB colour in linear light.
  **Caveat:** Bevy 0.19 can't load this script's output. UASTC needs `bevy/basis-universal`, and
  ETC1S/BasisLZ isn't supported (`bevy_image ktx2.rs`). Native block formats in KTX2 (BC7/BC5 on
  desktop, ASTC on Apple) load fine: use `tools/cook` below.
- **`tools/cook`** (standalone crate, links ISPC texture kernels; not part of the engine build):
  `memgate -- cargo run --manifest-path tools/cook/Cargo.toml -- <assets>/textures
  [--only SET] [--force]`. Per set: `color.ktx2` (BC7 sRGB, linear-light mips), `normal.ktx2`
  (BC5, renormalised mips), `orm.ktx2` (BC5: R = AO, white without `ao`, G = roughness),
  `color.avg` (linear average colour); zstd per level. Sets whose outputs are newer than every
  source are skipped. Asphalt (1024², 4 maps): 3.7 MB in 1.3 s. Moved from Shroud (identical
  output).
- **`gfx::load_pbr` and cooked sets.** With feature `ktx2`, if `textures/<name>/color.ktx2`
  exists it loads `color.ktx2` (sRGB), `normal.ktx2` (RG, e.g. BC5: Bevy rebuilds Z) and
  `orm.ktx2` (R = AO, G = roughness, used for both occlusion and metallic-roughness),
  GPU-only (`RenderAssetUsages::RENDER_WORLD`: no CPU copy, no CPU mips). `color.avg` holds the
  colour map's average as three linear floats, for automatic far-detail materials (without it
  they keep the material tint). Otherwise the `.jpg` set loads as before.
- **Package:** `scripts/package.sh ... [--dry-run] [--archive] [--check-assets]`. On top of the
  ship checks it already had (no `ashlar-*` crates in the graph or the binary), the build is now
  reproducible and lean whatever the game's profile says:
  - `CARGO_PROFILE_RELEASE_{STRIP=symbols, DEBUG=false, LTO=thin, CODEGEN_UNITS=1, INCREMENTAL=false}`
  - `--remap-path-prefix=$HOME=~`
  - `SOURCE_DATE_EPOCH` set from the last commit
  - `--locked`
  - assets copied without dotfiles
  - `MANIFEST.sha256`
  - with `--archive`, a byte-for-byte reproducible `tar.gz` (sorted entries, fixed mtime, uid/gid 0)

  `--dry-run` prints the plan without building.

## Measurements

Apple M5 Pro, dev profile (engine opt-level 1, deps opt-level 3), measured 2026-10-26 with
`cargo test --test devkit bench_devkit -- --ignored --nocapture` and the perf test:

| What | Cost |
|---|---|
| `profile_scope!` enter + exit | 35.7 ns |
| Idle devkit per frame (nothing watched / recorded / scoped) | 4 systems, each skipped by its run condition or returning at once |
| Headless engine frame (toy game, 235 entities incl. resource entities) | p50 0.30–0.46 ms, p95 0.41–1.34 ms |
| Allocations per frame, same app (all threads, `CountingAlloc`) | p50 308–551, p95 446–1436 (Bevy + engine; a baseline to track) |
| `ecs.query` 10 k entities × 2 components → JSON | 28.3 ms (agent-side tool, not per frame) |
| `ecs.query` 10 k matches, 10 returned | 0.22 ms |
| Save write / read+verify, 10 k records (532 KB JSON) | 4.9 ms / 2.3 ms |
| Hot-reload poll | 1.45 µs per watched file per poll (default 2 polls/s) |
| Golden compare, 1920×1080 PNG pair (decode both + diff) | ~50 ms process total (`devkit_cli golden`) |
| Asset check, Shroud's assets (79 files, 44 textures, 45 MB) | 54 ms process total |

Golden-image check on the real offscreen renderer (`scripts/devkit-demo.json`): two screenshots
of the paused demo 0.5 s apart differ by TAA noise only (max delta 0.07, 0 pixels over the
threshold, pass). The scene before vs after a hot-reloaded colour change fails with 2.4 % of
pixels different, and the diff image marks exactly the cubes.

## Known limits

- Per-system timings: none from `ecs.systems`. Use `perf_span`, `profile_scope!` or the
  `profile` feature (Tracy). System names need `debug_names`.
- `Scenario::call` runs instant commands only; deferred ones need the TCP port.
- Thumbnails need a renderer (not `--headless`); there are none in headless tests.
- KTX2 cooking needs an external `toktx`. The engine doesn't build or ship it, and the default
  build can't load KTX2 (feature `ktx2`).
- Hot reload covers JSON resources. Rust code changes still need a rebuild; keep the edit, build,
  test loop short with `cargo check` and targeted tests (see `AGENTS.md`).
- `profile_scope!` counters are process-global. In a test binary running several apps in
  parallel, the scope numbers mix across apps.
