# Hull

A code-first game engine in Rust, built on [Bevy](https://bevyengine.org) 0.19 and
[avian3d](https://github.com/Jondolf/avian) 0.7.

Hull is the shell around your game: window, settings, main and pause menus, a themed UI kit,
input actions with rebinding, rendering presets and a render budget, plus optional systems for
lighting, animation, particles, AI, sound, large worlds, procedural content and multiplayer.
Everything is Rust or small JSON files. There is no editor and no binary scene format, so a
person or an AI agent can read, change, run and check all of it from the shell.

Website: [hull.himanshuat.com](https://hull.himanshuat.com)

> The crate is still named `engine`, and it isn't on crates.io yet: use it as a git dependency.

## Games on Hull

- **Shroud**: a first-person shooter where the enemy squad learns from how you play.
- **Pacenote**: a two-person rally game; one drives, one reads the road.
- **Courier**: hover-bike parcel delivery across a procedural valley.

## Quick start

```toml
[dependencies.engine]
git = "https://github.com/Himasnhu-AT/hull"
default-features = false
features = [
    "physics", "fps", "look", "anim", "vfx",
    "ai", "sound", "world", "actions", "l10n",
]   # add "net" for multiplayer

[dependencies]
bevy = { version = "=0.19.1", default-features = false }

[features]
# cargo run / cargo test keep every debug tool; ship builds use --no-default-features
default = ["dev"]
dev = ["engine/devtools", "engine/trace", "engine/devkit"]
```

```rust
use engine::GameInfo;

fn main() {
    engine::app(GameInfo::new("mygame", "My Game"))
        .add_plugins(MyGamePlugin)
        .run();
}
```

Try the examples in this repo:

```sh
cargo run --example minimal --features fps   # the smallest game: ground, cube, camera
cargo run --example ui_gallery               # menus, settings screen, widgets
cargo run -- --headless                      # no window, for tests
```

## What's inside

| Area | What you get | Feature | Doc |
|---|---|---|---|
| Shell | App bootstrap, Boot / MainMenu / InGame states, data and asset folders, persisted settings with a generated settings screen, saves | always | [PORTING](docs/PORTING.md) |
| UI kit | Main and pause menus from one `MenuConfig`, screen stack, toasts, widgets; keyboard, mouse and gamepad; one-colour theming | always | [PORTING](docs/PORTING.md) |
| Rendering | Quality presets, render budget (automatic scenery/actor classification, distance detail, streaming), render scale, quality governor, pipeline warm-up | always | [GAME_GUIDE](docs/GAME_GUIDE.md) |
| Look | Sun, sky, fog, exposure, grading, lens, probes, decals as data | `look` | [LOOK](docs/LOOK.md) |
| Animation | State machines, blend spaces, layers, root motion, notifies, IK | `anim` | [ANIM](docs/ANIM.md) |
| VFX | Particles, presets, budgets, near-camera fade | `vfx` | [VFX](docs/VFX.md) |
| AI | Navmesh baking, paths, crowds, behaviour trees, utility AI, perception | `ai` | [AI](docs/AI.md) |
| Sound | Buses, snapshots, ducking, cues, 3D sound, occlusion, music, captions | `sound` | [SOUND](docs/SOUND.md) |
| Worlds | Terrain, scatter, cell streaming, HLOD, floating origin | `world` | [WORLD](docs/WORLD.md) |
| PCG | Bevy-free node graphs evaluated per cell, spawned as scenery | `pcg` | [PCG](docs/PCG.md) |
| Input | Action map, rebinding screen, gamepad, accessibility options | `actions` | [ACTIONS](docs/ACTIONS.md) |
| Localization | `.ftl` string tables, plurals, hot language switch | `l10n` | [L10N](docs/L10N.md) |
| Multiplayer | Transports, channels, replication, prediction | `net` | [NET](docs/NET.md) |
| Physics | avian3d, paused with the game; first-person controller | `physics`, `fps` | [PORTING](docs/PORTING.md) |

## Built for agents and tests

Debug tooling sits behind features that ship builds turn off:

- **Control port and MCP** (`devtools`): drive a running game over TCP or MCP. Start, pause,
  press keys, take screenshots, read frame stats, query and edit the ECS.
- **Offscreen runs**: the game renders into an image with a hidden window, so screenshots work
  without taking over the screen. `scripts/play.py` runs a JSON list of steps and saves the
  screenshots.
- **Devkit** (`devkit`): an ECS inspector, a scenario test kit (`Scenario`, 60 Hz fixed step),
  record and replay, golden images, perf budgets, hot reload and save slots.
  See [DEVKIT](docs/DEVKIT.md).

Start with [AGENTS.md](AGENTS.md) for the build and test loop, and
[docs/GAME_GUIDE.md](docs/GAME_GUIDE.md) for the playbook: what to use when, the performance
rules, and a symptom → fix table.

## Performance

Benchmarks and how they were measured are in [docs/PERF.md](docs/PERF.md). Matched comparisons
against Godot 4.4 on the same machine and scenes are in [docs/COMPARE.md](docs/COMPARE.md).

## Tools

- `tools/cook`: texture cook to KTX2 (BC7/BC5) with mips and an average-colour file.
- `scripts/bench.py`, `scripts/perf_suite.py`: CPU benches and scene benchmarks with a
  regression check.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion
in this work by you, as defined in the Apache-2.0 license, shall be dual licensed as above,
without any additional terms or conditions.
