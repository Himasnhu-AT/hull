# AGENTS.md: working on `engine` as an AI agent

`engine` is a code-first game shell on Bevy 0.19.1 + avian3d 0.7. Everything is Rust or small
JSON files: no editor, no binary scene assets. You can read, change, run and verify all of it
from the shell.

## Build and test fast

- **Run every cargo command through `memgate`** (it queues heavy jobs machine-wide and kills
  runaways): `memgate -- cargo check --lib`.
- One shared target dir for the engine, its worktrees and the games
  (`.cargo/config.toml` → `/Users/himanshu/codes/game/shroud/target`), so Bevy is already
  built. "Blocking waiting for file lock" means another build is running; wait. Never run
  `cargo clean`.
- Never change Bevy's feature set in the default build: it recompiles all of Bevy (~5 GB).
  Optional engine features that do so on purpose: `profile` (Tracy), `hot_reload` (asset file
  watcher), `ktx2`, `debug_names`.
- Inner loop, cheapest first:
  1. `memgate -- cargo check --lib` (seconds)
  2. `memgate -- cargo test --lib <module>` (unit tests)
  3. `memgate -- cargo test --test <file>` (one integration binary, ~200 MB each; keep them few)
  4. `memgate -- cargo clippy --lib --tests`
  5. `memgate -- cargo check --no-default-features` (the ship build must still compile)
- Check `df -h /` before big builds.

## Layout

| Path | What |
|---|---|
| `src/app.rs` | `engine::app(GameInfo)` / `app_with(info, EngineOptions)`, `EnginePlugin` wiring |
| `src/devtools/` | control port (TCP + MCP), offscreen capture, perf monitor + overlay, metrics window |
| `src/devkit/` | inspector (`ecs.*`), scenario test kit, replay, golden images, perf budgets, bench JSON, `profile_scope!`, JSON hot reload, saves, asset checks: **docs/DEVKIT.md** |
| `src/settings.rs`, `src/ui/` | persisted settings + generated settings screen, menus, UI kit |
| `src/gfx.rs`, `src/render_budget/` | quality presets, PBR loading, culling / LOD budget |
| `docs/PORTING.md` | conventions, devtools, metrics, ship builds, render budget measurements |
| `tests/*.rs` | headless `App::update()` tests and control-port tests (they spawn an example) |
| `scripts/play.py` | build + launch a game offscreen, run a JSON steps file over the port, save screenshots |
| `scripts/bench.py`, `scripts/cook.py`, `scripts/package.sh` | benches, texture cooking, ship packaging |

## Drive a running game (control port)

```sh
python3 -I scripts/play.py steps.json --example devkit_demo      # offscreen; --headless / --onscreen
```

Steps: `{"cmd": "...", "params": {...}, "expect": {"result.path": value}}`,
`{"shot": "name"}` (→ `<out>/name.png`, then look at it), `{"sleep": s}`,
`{"write": "data/x.json", "json": {...}}`. It exits 1 if any `expect` fails. Run a game
yourself with `--control 0`, which prints `control: port=<n> key=<file>`, and speak the JSON
lines protocol (see `tests/control.rs`); or use `--mcp` for MCP over stdio.

The command catalogue is live: call `engine.commands`. The main ones:

- **Engine:** `engine.state/start/menu/pause/resume/quit`, `time.scale`, `time.step {frames}`
  (while paused), `screenshot {path}`, `perf.stats`, `input.key {key, action}`,
  `input.mouse {dx, dy, button}`, `ui.*`, `settings.get`, `metrics.*`. See the table at the top
  of `src/devtools/commands.rs` and `docs/PORTING.md`.
- **Inspect / edit the world:** `ecs.query {components, with, without, name}`, `ecs.get {id}`,
  `ecs.set {id, component, value}` (merge patch), `ecs.spawn`, `ecs.despawn`, `ecs.remove`,
  `ecs.res.get/set/list`, `ecs.types`, `ecs.systems`.
- **Dev loop:** `devkit.record` / `devkit.replay` (input), `devkit.scopes`, `devkit.reload`,
  `save.list/write/load/delete`, `content.check`.

To make game types visible to the inspector: `#[derive(Component, Reflect)]`,
`#[reflect(Component)]`, then `app.register_type::<T>()`.

## Test a game without a window

```rust
let mut s = Scenario::new(GameInfo::new("id", "Title")).plugin(MyGame).build(); // 60 Hz fixed step
s.step(2); s.press(KeyCode::KeyW); s.run_secs(1.0);
s.wait_until(120, |w| /* predicate on &mut World */ true).unwrap();
s.call("ecs.query", json!({"components": ["Enemy"]}));   // control commands in-process
s.assert_json_snapshot("state", s.resource_json::<Score>().unwrap());
s.assert_budget(&PerfBudget { p95_frame_ms: Some(4.0), ..default() });
```

Snapshots and golden images are re-blessed with `ENGINE_BLESS=1`. For a visual check, take a
screenshot with play.py, look at the PNG, then compare it with
`cargo run --example devkit_cli -- golden a.png golden.png`. See `docs/DEVKIT.md` for record /
replay, allocation budgets (`CountingAlloc`) and benches (`scripts/bench.py run|compare`).

## Conventions

- Config structs implement `Default` and are built with `..default()`; engine structs gain fields.
- Debug tooling sits behind features: `devtools` (port, overlay), `devkit`, `trace`. Games use
  `default-features = false` plus their own `dev` feature; ship builds carry none of it
  (`scripts/package.sh` checks).
- Performance first: no per-frame allocations in hot paths, no cost when a feature is unused,
  budgets in config. Measure (`perf.stats`, scenario budgets, `bench.py`) and write the numbers
  into the docs.
- Prefer writing small code over adding crates. Never add a crate that pulls in a second Bevy or
  wgpu.
- Write docs as you go: a module's purpose, API, control commands, measurements and known limits
  (see `docs/DEVKIT.md` for the shape).
