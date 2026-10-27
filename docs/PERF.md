# PERF: benchmarking and monitoring the engine

Two kinds of benchmarks, one report format, one compare tool.

| what | tool | measures |
|---|---|---|
| **Scene benchmarks** | `scripts/perf_suite.py` | example scenes offscreen at full speed: frame time (p50/p95/p99), GPU time per frame, CPU per thread, memory, hitches, entities, plus every `metrics.dump` key |
| **Headless CPU benches** | `scripts/bench.py run` | `#[ignore]` `bench*` tests: anim crowds, navmesh bake / paths / perception, inspector and save costs, DSP and sound logic, net server / client |

Both write `BenchReport` JSON (`{name, metrics: {key: {n,min,avg,p50,p95,p99,max}}, values}`)
under `target-bench/` (gitignored); `scripts/bench.py compare BASE NEW` diffs any two runs
(every key is lower-is-better) and exits 1 when a p95 got worse than `--threshold` percent.

## Run

```sh
python3 -I scripts/perf_suite.py list                        # the scenes
python3 -I scripts/perf_suite.py run                         # all scenes, ~10 min; compares with the previous run
python3 -I scripts/perf_suite.py run --scenes look_high,open_world --secs 30
python3 -I scripts/perf_suite.py run --direct                # no memgate, no waiting for a quiet machine
python3 -I scripts/bench.py run --test anim                  # also: ai, devkit, sound, net (--features net)
python3 -I scripts/bench.py compare target-bench/<old> target-bench/<new> --keys frame.ms,gpu.frame_ms
```

`perf_suite.py run` builds the examples once, then per scene launches the binary with
`--control 0 --offscreen --uncapped --play --mute --seed 1`, waits until in game, waits
`--warmup` s (default 8), and reads `metrics.dump` once a second for `--secs` s (default 20).
Each key's 1 s samples become one stat; `frame.ring_ms` holds the last ~600 frames' percentiles
from `perf.stats`. Reports land in `target-bench/<commit>[-dirty]-<time>/scene.<name>.json`
(logs and data dirs under `runs/<scene>/`). At the end it prints a table and compares with
`--base` (default: the newest earlier run) on `frame.ms`, `frame.p95_ms`, `frame.p99_ms`,
`gpu.frame_ms`, `cpu.main_pct`, `cpu.render_pct`, `mem.footprint_mb`; exit 1 = regression over
`--threshold` (default 15 %).

`--uncapped` is an engine flag (devtools builds): no vsync and no unfocused frame pacing, never
saved to settings, so any game can be measured the same way.

### Monitoring

- **Before merging perf-sensitive work**: `perf_suite.py run` (or the scenes it touches). A
  non-zero exit names the scene and key that regressed.
- **Shared machine**: before each scene the suite waits (up to `--max-wait`, default 600 s)
  until the 1-minute load average is under `--max-load` (default half the cores), stores the
  load in the report (`machine`), and prints a WARNING for scenes that ran on a busy machine.
  `--direct` skips memgate and the wait (load is still recorded and warned about).
  A run during another project's release build (load ≈ 45–90 on 15 cores, outside memgate) read
  4–20× slower frames with 70 % *less* game CPU: starvation, not a regression. Re-run first.
- **In a running game**: `perf.stats`, `metrics.dump {prefix}`, the perf overlay (F3) and
  `metrics.sessions` (history across runs, `data/metrics/sessions.jsonl`).
- **In tests**: `Scenario::assert_budget(&PerfBudget { p95_frame_ms, max_entities,
  p95_allocs_per_frame, .. })` (see DEVKIT.md). Frame-time budgets in tests are sensitive to
  machine load. `CountingAlloc` counts the whole process, so a test binary with allocation
  budgets runs its tests one at a time (see `tests/devkit.rs`).

### Reading the keys

| key | meaning |
|---|---|
| `frame.ms` | mean frame time over each 1 s sample |
| `frame.p95_ms` / `frame.p99_ms` | per-second percentiles (p99 catches hitches) |
| `frame.ring_ms` | p50/p95/p99 over the last ~600 frames (end of the window) |
| `frame.hitches` | frames over 50 ms per second (`perf.hitch` events in the session log have each one's time and length) |
| `gpu.frame_ms` | this process's GPU busy time per frame |
| `gpu.alloc_mb` | this process's Metal allocations |
| `gpu.mem_mb` | **device-wide** GPU memory in use (all apps): don't compare across runs |
| `gpu.buffers`, `gpu.textures`, `gpu.texture_views`, `gpu.bind_groups`, `gpu.render_pipelines`, `gpu.compute_pipelines`, `gpu.samplers` | live wgpu objects (≈1 Hz): a leak or per-frame churn of GPU objects shows here first |
| `mem.footprint_mb` | phys_footprint (Activity Monitor "Memory"; includes Metal memory) |
| `cpu.main_pct` / `cpu.render_pct` | main / render thread, % of one core |
| `render.cpu_us`, `world.cpu_us`, `ai.*_ms`, `anim.*`, `sound.*` | subsystems' own measured CPU time |
| `span.*_ms` | wall time from just before to just after a system set: an **upper bound** (unrelated systems running in parallel are included) |

## Scenes

| scene | example | what it stresses |
|---|---|---|
| `look_low` / `look_high` / `look_ultra` | `look_showcase --quality …` | lighting tiers (Ultra: SSR, realtime probe every frame) |
| `look_dusk` | `look_showcase --look dusk` | low sun, volumetrics, grading |
| `open_world` | `open_world --pose fly` | 4×4 km terrain, 100k scatter instances, streaming while flying |
| `render_budget` | `render_budget` | 4000-prop town, culling / LOD budget |
| `ai_crowd` | `ai_crowd` | 200 agents: navmesh, crowds, behaviour trees, perception |
| `anim_demo` | `anim_demo` | animated characters: state machines, IK, LOD |
| `vfx_gallery` / `vfx_stress` | `vfx_gallery [--stress 100000]` | every particle preset; 100k CPU particles |
| `sound_demo` | `sound_demo` | mixer, 3D voices, occlusion, music |
| `ui_gallery` | `ui_gallery` | UI kit screens |

## Baseline (commit 2327039, before the fixes below)

1920×1080 offscreen, dev profile (opt-level 3 + debuginfo), M-series MacBook Pro (15 cores), 20 s
window after 8 s warm-up. Frame p50/p95/p99 from the last ~600 frames.

| scene | fps | frame p50 | p95 | p99 | GPU ms | main % | mem MB | entities |
|---|---|---|---|---|---|---|---|---|
| look_low | 192 | 4.4 | 5.1 | 6.0 | 4.2 | 24 | 872 | 796 |
| look_high | 99 | 10.2 | 12.8 | 13.7 | 9.1 | 15 | 3933 | 798 |
| look_dusk | 95 | 10.7 | 13.5 | 14.7 | 9.3 | 15 | 4097 | 798 |
| look_ultra | — | — | — | — | — | — | — | crashed at start |
| open_world | 116 | 7.2 | 9.4 | **48.5** | 4.5 | 20 | 1385 | 34 905 |
| render_budget | 249 | 3.3 | 4.0 | 4.4 | 3.2 | 28 | 689 | 4 984 |
| ai_crowd | 293 | 4.6 | 5.1 | 5.4 | 2.6 | 29 | 708 | 1 159 |
| anim_demo | 309 | 3.5 | 4.6 | 4.9 | 3.0 | 28 | 785 | 936 |
| vfx_gallery | 186 | 5.6 | 6.3 | 6.6 | 3.5 | 25 | 693 | 758 |
| vfx_stress (100k) | 169 | 5.8 | 6.4 | 6.8 | 3.9 | 24 | 771 | 726 |
| sound_demo | 217 | 3.0 | 3.7 | 4.6 | 3.2 | 30 | 605 | 737 |
| ui_gallery | 303 | 3.0 | 3.9 | 4.3 | 2.7 | 30 | 684 | 738 |

Headless CPU benches (dev profile; no CPU-bench code changed between the two columns, so the
difference is mostly the baseline machine's load):

| bench | baseline (2327039) | after (c8532d9, quiet machine) |
|---|---|---|
| anim crowd, 500 characters | 2.5 ms/frame (1.8 with anim LOD); anim step 86 µs, post 93 µs | 1.7 ms (1.3 with LOD); step 67 µs, post 43 µs |
| navmesh bake 300×300 m, 600 crates | 109 ms wall (412 ms CPU, multi-threaded); path query 0.13 ms | 89 ms wall (335 ms CPU); path 0.11 ms |
| behaviour trees + perception, 500 agents | 0.06 ms + 1.0 ms per frame; crowd steering 0.2 ms | 0.06 + 0.93 ms; steering 0.18 ms |
| sound DSP, 48 voices + 6 buses + reverb | 1.0 % of one core | 0.97 % |
| net server, 64 clients × 500 entities | 3.6 ms/frame capped (1.2 ms with relevancy), 128 kB/s per client | 2.1 ms capped (1.2 with relevancy), 128 kB/s |
| save 10k entities | write 6.4 ms, read 3.2 ms | write 4.5 ms, read 2.3 ms |
| inspector `ecs.query` 10k entities → JSON | 35 ms (0.27 ms with `limit 10`) | 28 ms (0.14 ms) |
| `profile_scope!` | 36 ns | 41 ns |

## After the fixes (commit c8532d9)

Same setup, machine quiet (load under 7.5 for every scene; `--direct`, no memgate).

| scene | fps | frame p50 | p95 | p99 | GPU ms | main % | mem MB | entities | vs baseline |
|---|---|---|---|---|---|---|---|---|---|
| look_low | 229 | 4.3 | 4.8 | 5.1 | 3.8 | 25 | 819 | 797 | p99 −43 % |
| look_high | 130 | 7.2 | 10.4 | 11.8 | 7.5 | 16 | 1015 ¹ | 799 | fps +31 %, GPU −18 % |
| look_dusk | 127 | 7.5 | 11.2 | 12.4 | 7.6 | 16 | 1050 ¹ | 799 | fps +34 %, GPU −19 % |
| look_ultra | 65 | 15.4 | 16.8 | 17.4 | 14.9 | 10 | 1437 ¹ | 799 | runs (crashed before) |
| open_world | 238 | 4.1 | 4.7 | **5.6** | 3.7 | 23 | 1102 | 34 835 | fps ×2, p99 48.5 → 5.6, 0 hitches |
| render_budget | 328 | 3.0 | 3.6 | 3.9 | 2.8 | 27 | 678 | 5 005 | p95 −35 % |
| ai_crowd | 328 | 2.9 | 3.2 | 3.4 | 2.6 | 30 | 710 | 1 161 | p95 −20 % |
| anim_demo | 318 | 3.1 | 4.0 | 4.8 | 3.0 | 28 | 756 | 937 | ≈ |
| vfx_gallery | 288 | 3.4 | 3.8 | 4.0 | 2.9 | 26 | 728 | 759 | p95 −39 % |
| vfx_stress (100k) | 262 | 3.7 | 4.3 | 4.7 | 3.1 | 23 | 805 | 727 | p95 −32 % |
| sound_demo | 368 | 2.7 | 3.2 | 3.9 | 2.5 | 32 | 634 | 738 | p95 −13 % |
| ui_gallery | 318 | 3.0 | 3.4 | 3.7 | 2.8 | 30 | 698 | 740 | p95 −13 % |

¹ Memory from commit 617d3e5 (offscreen frame pacing). Three later runs on a busy machine
(load 11–26, other projects' builds) agreed within 5 % on memory; their frame times are not
comparable and are not shown. A quiet full re-run of the suite is still to do.

`bench.py compare` flags `open_world` `cpu.render_pct` +17 %: the render thread runs twice as
many frames per second; its cost per frame fell. Gains in scenes the fixes didn't touch
(render_budget, vfx, ui) suggest the baseline machine wasn't fully idle either; the look and
open_world gains are the fixes. One busy run showed `anim_demo` at 2.5 GB; the quiet re-run
was 756 MB: GPU contention plus the missing offscreen frame pacing (fixed below).

## Found and fixed by the benchmarks

| finding | cause | fix | effect |
|---|---|---|---|
| `look_ultra` crashed at start; leaving Ultra crashed | SSR switches materials to deferred by "touching" every material with `Assets::get_mut`, which in Bevy 0.19 is **not** a change unless written through: materials kept their old render method; probe capture views had no deferred prepass | mark materials changed (`into_inner`); side 3D views get a deferred prepass while SSR is on; every view keeps it 10 frames after leaving | all tier switches work; SSR actually sees deferred materials when Ultra is entered at runtime |
| `open_world`: a 10.5 s stall after loading, hitches of 50–160 ms every second while flying, 4 cores busy | the AI plugin (on by default) triangulated every streamed terrain collider on the main thread and re-baked navmesh tiles, in a demo with no agents | navmesh tracking/baking start only when a `NavAgent` / `NavSource` exists (or `AiConfig::bake_without_agents`) | 36 → 7 hitches per run, no stall |
| `look_high` spent its frame on the reflection probe | the realtime probe ran Bevy's env-map filter every frame (bind groups, buffers and placeholder textures re-created each time) | filter once per full cycle of fresh faces | ~100 → ~28 filters/s, ~100 → ~130 fps |
| `look_high` / `look_dusk` / `look_ultra` at 4.0–4.4 GB vs 0.8 GB on Low | **offscreen runs had no frame pacing**: with no swapchain nothing made the CPU wait for the GPU, so in GPU-bound scenes frames queued without limit and the Metal driver held ~35 000 command-buffer regions (`footprint`: `IOAccelerator (graphics)`), swinging 0.4 ↔ 2.3 GB as it purged. wgpu itself held only ~200 buffers (`gpu.buffers`). Offscreen frame times in GPU-bound scenes measured submission, not rendering | `--offscreen` waits like a swapchain (2 frames in flight, `devtools/offscreen.rs`) | High 4.0 → 1.05 GB, dusk 4.1 → 1.06 GB, Ultra 4.4 → 1.5 GB; same frame time when not GPU-bound (render_budget 3.23 ms both) |
| `perf_budget_with_counting_allocator` flaky | `CountingAlloc` counts the whole process: parallel tests' allocations landed in its per-frame budget | tests in `tests/devkit.rs` run one at a time | 0 failures in 6 runs (binary 4.7 s → 0.4 s) |
| `open_world` 50–90 ms hitches while flying | render-world stalls in specialize / mesh prepare the frame after scatter spawned up to 3000 entities, or any number of big merged grass meshes (each counted as one item) | `max_items_per_frame` 3000 → 1000, merged clusters cost one per 500 vertices | at most 1000 new mesh entities per frame; see limits |
| `span.budget.*` read 1–3 ms per frame | the span's wall-time window took in Bevy's visibility systems | spans removed; `render.cpu_us` is the real cost (0.3 ms in `open_world`) | no phantom costs in reports |

## Known limits

- A realtime reflection probe still costs ~250 MB over a baked one (six face targets and their
  per-view textures): High 1.05 GB vs Low 0.8 GB.
- `open_world`: none in the 20 s bench window. Over a 60 s flight a few 40–90 ms frames remain
  when flying into new scatter; on a loaded machine they couldn't be told apart from
  contention, so the effect of the spawn budget is unmeasured. Spawning stays on the main
  thread (see WORLD.md).
- Benchmarks on this Mac share it with other projects' release builds. `--direct` skips the
  wait for a quiet machine: re-run any scene the suite flags as busy before trusting it.
- Numbers are dev profile on one machine; ship builds (`--release`, no devtools) are faster.
