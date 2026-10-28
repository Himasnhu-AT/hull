# Engine vs Godot (and Unreal): matched benchmarks and audits

Where this engine stands against Godot 4.4 on the same machine and scenes, why, and what to fix.
Unreal 5.8 is compared by source audit only: the install on this Mac (`/Users/Shared/Epic
Games/UE_5.8`, 241 MB) has no editor or runtime, so it can't run scenes.

## Method (`scripts/compare.py`)

- Scenes are built in code, identically: `examples/bench_compare.rs` (ours) and
  `bench/godot/main.gd` (Godot 4.4.1, Metal, Forward+, Jolt physics):
  - `cubes`: 20 000 static cubes in 8 materials, one shadowed sun.
  - `lights`: 4 000 cubes, 256 unshadowed point lights.
  - `physics`: 4 000 dynamic boxes dropped onto a floor.
- 1920×1080 window at scale factor 1, no MSAA, no post effects (no SSAO, TAA, bloom, SSR), plain
  shadow filtering, both held at **60 fps** (`--fps 60` / `--max-fps 60`). macOS holds a
  window to the display rate whatever the app asks, so frame rate alone isn't comparable: we
  compare the **work per frame** at the same rate.
- Ours is built like a shipped game: `--release --no-default-features --features physics`
  (no devtools: no perf sampler, no control port). Godot is its official release build.
- Measured from outside, the same way for both: CPU cores busy (`ps` cputime / wall), GPU time
  per frame (IOKit per-process `accumulatedGPUTime`), peak RSS, launch → first frame.

```sh
python3 -I scripts/compare.py --release --fps 60 [--scenes cubes,lights,physics] [--secs 8]
```

## Results (Apple M5 Pro, 2026-10-28)

Before the worker-thread cap (Bevy's default pools, one worker per core):

| Scene | Engine | CPU cores busy | GPU ms/frame | RSS MB | Holds 60 fps |
|---|---|---|---|---|---|
| cubes | ours | 0.76 | **2.16** | 302 | yes (p95 19 ms) |
| cubes | Godot | **0.32** | 3.85 | 282 | yes |
| lights | ours | 0.63 | 4.95 | 229 | yes (p95 19 ms) |
| lights | Godot | **0.11** | **3.34** | 179 | yes |
| physics | ours | 1.35 | 3.36 | 209 | **no** (avg 26–54 ms) |
| physics | Godot | **0.75** | 3.42 | 193 | yes |

After capping workers at 6 (`EngineOptions::worker_threads`, `DEFAULT_WORKER_THREADS`) and
setting thread priorities (`engine::threads`: main/render `UserInteractive`, compute
`UserInitiated`, async/IO `Utility`):

| Scene | Engine | CPU cores busy | GPU ms/frame | RSS MB | Holds 60 fps |
|---|---|---|---|---|---|
| cubes | ours | 0.47 | **2.15** | **352** | yes (p95 21 ms) |
| cubes | Godot | **0.34** | 3.91 | 357 | yes |
| lights | ours | 0.24–0.45 | 4.95–6.09 | 246 | yes (one run at 30 fps under load) |
| lights | Godot | **0.13** | **3.62** | **236** | yes |
| physics | ours | 0.71 | **3.27** | 264 | **yes** (p95 19 ms; was 54 ms avg) |
| physics | Godot | **0.53** | 3.49 | **223** | yes |

Thread cap alone (A/B, same build): physics 54 ms avg / 126 ms p95 → 16.7 / 18.8 ms; cubes 0.76
→ 0.49 cores; lights 0.70 → 0.45 cores (2 workers: 0.37). QoS on vs off: no difference at
these loads (lights 16.67 ms both).

**Noise:** these runs shared the Mac with other projects' builds (load average 12–17), equally
for both engines. Rerun on an idle machine before quoting small differences.

Where we win: GPU time on many static meshes (45% less than Godot: Bevy's GPU-driven
batching) and now physics GPU time; memory is level on cubes. Where we lose: CPU per frame
(1.3–2× after the fixes, up to 3× with many lights), GPU with many lights, frame pacing (p95
19–21 ms vs Godot's flat 16.7 ms), and startup with 20 000 entities (3.9 s vs 1.0 s).

## Why (profiles and audits)

- **Thread wake-ups, not work.** `sample` on the static lights scene shows ~0.09 cores inside
  functions but `ps` 0.63 cores: the rest is the kernel parking and waking ~15 workers for
  each of hundreds of systems per frame (Bevy's multi-threaded executor). Capping workers is
  the first fix (done); fewer systems per frame and set-level run conditions are next
  (`audits/scheduling.md` #5–6).
- **Clustered lights on the CPU.** Bevy assigns lights to clusters on the main thread every
  frame; Godot does it on the GPU. 256 lights cost us CPU and GPU.
- **Physics catch-up and oversubscription.** avian at 64 Hz × 6 substeps with no catch-up cap,
  and workers competing with the main thread (`audits/physics.md`, `audits/scheduling.md` #2).

Full audits (ranked findings with file:line, what Unreal/Godot do, impact, fix, risk):
- `audits/physics.md`: avian vs Chaos/Jolt. Keep avian; skip kinematic contacts, cap catch-up,
  sync only changed colliders, cache prefab colliders.
- `audits/ai.md`: our navmesh/crowd vs Recast/Detour/Godot. Already fast per query; parallelise
  avoidance/perception, denser A* nodes, tile-cache rebakes, path corridors.
- `audits/anim_assets.md`: animation and loading vs Unreal/Godot. Strip constant tracks (Shroud's
  enemy: 7 182 of 8 385 channels constant), skinned warm-up, texture mip budget and upload cap.
- `audits/scheduling.md`: executor, threads, QoS, streaming vs TaskGraph/WorldPartition/Godot
  WorkerThreadPool. Thread QoS, fewer sync points, async cell loading.
- Earlier rendering audits (shadows, governor, textures, Metal): fixed in commits 1246162,
  2c3d53a, 74984c1 (see GAME_GUIDE.md §3).

## Next fixes, by expected gain

1. ~~Worker cap and thread QoS~~ (done).
2. Physics: cap `Time<Virtual>` max delta (~50 ms), expose substeps, skip kinematic contacts.
3. Fewer per-frame systems and sync points in the engine's own plugins (`scheduling.md` #5–7).
4. Lights: measure Bevy's CPU cluster assignment at 256 lights; budget or cull lights by
   distance (render budget) before they reach clustering.
5. Animation: strip constant tracks at bind time; skinned pipeline warm-up.
6. AI: parallel ORCA and perception; dense A* node pools.
7. Startup: batch-spawn large scenes (20 000 entities: 3.8 s).

Rerun `scripts/compare.py --release --fps 60` after each and update the tables above.
