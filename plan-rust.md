# Hull: the Rust plan

How Rust enters Hull, where it is allowed, and the measured gates each step must pass. Written 23 Nov 2026.
`PLAN.md` stays the plan for the engine; this file is the plan for one track of it, and changes `PLAN.md` only where
section 11 below says so.

**Status (23 Nov 2026): R2 is done on the owner's call (section 14).** All of `hull/physics` runs as a Rust kernel
compiled to WebAssembly, bit for bit with the TypeScript, which stays as fallback and oracle; AOTT runs on it in
Node, on the dev page and from its built `game.js`. R0 (section 12) and R1 (section 13) are the measurements that
came first: R1's gate closed the kernel, and the owner then asked for the port regardless.

## 1. What this is for

The owner's aim (23 Nov 2026): fast to develop, and as fast to run as an engine written in C++.

Hull keeps the first half by leaving games, kits, config, tools and the Studio in TypeScript. This plan is for the
second half: the few places where a game can ask for more arithmetic than TypeScript delivers, moved to Rust,
compiled to WebAssembly, and hidden behind the TypeScript API the game already calls.

Rust is not for game logic, and a game never sees it. A game that calls `physics.raycast` gets the same answer from
either implementation.

## 2. What was measured first

AOTT on Hull (`examples/aott`), Holdout, wave 2, 6 to 12 titans, about 1.2 M triangles a frame, Apple M5 Pro.

| Measure | Result | How |
|---|---|---|
| The whole simulation, headless | 0.29 ms a step (120 steps a second, so about 0.6 ms of a 16.7 ms frame) | `pnpm perf:aott`, checksum `a45ff85a5ba1346a` at 95 s, seed 11 |
| Main thread while playing at 60 fps | 77% idle | Chrome CPU profile, 10 s |
| All JavaScript together (game, engine, three.js) | about 2 ms a frame | the same profile |
| CPU throttled 4 and 6 times | holds the frame | DevTools protocol throttle; readings were noisy, read as "holds", not as exact numbers |
| 1280 x 720 up to 3840 x 2160 | holds the frame | same |

Where the 0.29 ms goes: three.js updating transform matrices (about 28%), the soldier's pose code in the game's own
`player/model.ts` (about 13%), Hull's physics (about 6%), the rest spread thin.

What this means for the plan:

* AOTT today has no kernel worth porting. A port now would add a toolchain and move no number a player can see.
* The largest cost, transform matrices, lives inside three.js objects. A kernel cannot reach them without copying
  them in and out, which costs more than it saves.
* So the plan starts by finding the load at which the CPU does become the limit (R0), and ports only what that
  measurement names.

## 3. The split

| Layer | Language | Why |
|---|---|---|
| Games, kits, templates | TypeScript | Written by an AI and reviewed by the type checker; tuned live by rewriting literals; hot reload. |
| Engine API, world, nodes, signals, config, input, UI, audio graph, render bridge | TypeScript | They are glue, object graphs and browser calls. WebAssembly cannot call the GPU, the DOM or Web Audio itself. |
| Tools, project server, Studio, agent | TypeScript | Not on the frame. |
| Kernels: batch arithmetic over flat arrays | Rust, as one WebAssembly module, each behind a TypeScript API | The only place a compiled language pays. |

The kernel boundary is the one rule: **flat numbers in, flat numbers out, a handful of calls a step.** No objects,
no callbacks and no strings cross it.

## 4. What makes a kernel

A piece of the engine moves to Rust only when all of these hold.

1. **It is measured.** In a stress scene at a load the owner has named as a target, it costs at least 2 ms of a
   16.7 ms frame. (Proposed threshold; owner's call, section 10.)
2. **It fits the boundary.** Its work is loops over numbers, callable as a batch. A per-object call across the
   boundary, or a JavaScript callback from inside the kernel, disqualifies it.
3. **Its data is Hull's.** Not three.js objects, not DOM, not game objects.
4. **The data layout alone is not enough.** Before any Rust is written, the same flat layout is built in
   TypeScript and timed. Much of what a port gains usually comes from the layout, not the language. Rust goes ahead
   only if it beats the flat TypeScript version by at least 1.5 times on the bench. Otherwise the flat TypeScript
   version is kept and the kernel is closed.
5. **It keeps the engine's rules.** Runs in Node, deterministic, no allocation per frame, fails locally.

## 5. How a kernel is built, loaded and shipped

**One crate, one module.** `crates/hull-kernels`, a Cargo workspace member at the repo root, target
`wasm32-unknown-unknown`, built to one `.wasm`. Plain `extern "C"` exports and no wasm-bindgen: the boundary carries
only numbers and offsets, so generated glue would add size and nothing else. This machine has rustc 1.99.1 with the
wasm target installed; `wasm-opt` is not installed and is pinned when it is added, like every other dependency.

**Memory is shared, not copied.** A kernel's arrays live in the module's linear memory. TypeScript holds typed-array
views over them (`Float64Array` over an offset), so writing a body's position or reading a hit is an array access,
with no call and no copy. Views are re-made when memory grows; the wrapper owns that, and capacity is reserved at
start so it does not grow during a frame.

**The TypeScript API does not change.** `hull/physics` and the others keep their exports and types. The wrapper
picks the kernel or the TypeScript implementation when the subsystem starts.

**The TypeScript implementation stays** as the fallback and as the oracle the kernel is tested against. If the
module fails to compile or start, that is reported once and the TypeScript path runs: the game keeps running. A
kernel can also be forced off (`hull.json`, and a query flag in dev) so the two can be compared in the same build.

**Loading.** The `.wasm` is inlined in the bundle as base64 (the build already inlines every asset into
`game.js`) and instantiated during `startGame`, which is already asynchronous. Only a game that imports a module
with a kernel carries it. The build report gains a line for the kernel's bytes.

**Node.** The same `.wasm` loads in Node, so headless tests, `play` scripts and `pnpm perf:aott` run the kernel
too. `core` and `config` stay free of it.

**Determinism.**

* Simulation kernels compute in `f64`, as JavaScript does, so add, multiply, divide and square root give the same
  bits and the checksum does not move. This is tested, not assumed: each kernel has a parity test of at least
  10,000 seeded cases against the TypeScript implementation, bit for bit (the pattern
  `examples/aott/src/core/collision.parity.test.ts` already uses).
* Sine, cosine and the like are not the same bits in Rust as in a JavaScript engine. A simulation kernel that needs
  them uses one fixed Rust implementation everywhere, the TypeScript fallback is tested against it to a stated
  tolerance, and goldens are regenerated once, in the commit that says so.
* Presentation kernels (skinning, particles: nothing the checksum reads) may use `f32` and SIMD.
* No threads. Shared memory needs cross-origin isolation headers, which a shared one-file game cannot count on.

**Who needs Rust installed.** Only someone changing a kernel. The built `.wasm` is committed beside a stamp of the
source it was built from; `pnpm kernels:build` rebuilds it, and `pnpm check` fails when the stamp and the source
disagree. A person making a game, and the app, never run cargo. (Owner's call, section 10.)

**No capability on one front only.** A kernel adds no tool and no API, so there is nothing to expose three ways.
Bench numbers reach the existing bench and budget reports.

## 6. Phases

Each phase ends on its "done when", and a gate decides whether the next one starts.

| Phase | What | Done when | Gate to the next |
|---|---|---|---|
| **R0 Find the limit** | A stress scene and a subsystem table. AOTT with titans, comrades and civilians scaled 1, 4 and 16 times (`pnpm perf:aott` grows a scale argument), and the engine's own benches at scale: physics queries and rigid bodies, animation graphs, CPU effects. Headless for the step, in the browser for the frame. | A table in this file: ms a step and ms a frame per subsystem at each scale, on this Mac and throttled 4 times, with the load at which the frame is lost and what loses it. | A subsystem passes test 1 of section 4 at a load the owner wants. If none does, the plan stops here and the table is the result. |
| **R1 One kernel, end to end** | The whole pipeline on the smallest real candidate R0 names (expected: batch ray and sphere casts against static shapes, which has a bench and a parity pattern already). Flat layout in TypeScript first, then Rust, then the crate, the build step, inlining, Node and browser loading, fallback, force-off flag, parity test, size report. | Bit-identical results on 10,000 seeded queries; three timings on the bench (today, flat TypeScript, Rust); `game.js` size with and without; the cube and AOTT build and run in the browser and in Node with the kernel on, off, and failing to load; `pnpm check` passes; AOTT's checksum is unchanged. | Rust beats flat TypeScript by 1.5 times or more (test 4). If not: keep the flat TypeScript version, delete the crate, record the numbers here. |
| **R2 Finish that subsystem** | The rest of the subsystem R1 opened, so it has one home: for physics, the broadphase, moving shapes, overlaps and the rigid solver. Filters become bit masks inside the kernel; a filter that is a function runs in TypeScript over the kernel's candidates. | The subsystem's whole test file passes on both implementations; the stress scene from R0 shows the frame gained, in ms, at the target load. | The gain at the target load is one a player would see (the lost frame is held, or the load can rise by a quarter). |
| **R3 Further kernels, one at a time** | Each further candidate from R0's table, in order of cost, through the same steps as R1. | Same as R1, per kernel. | Same as R1, per kernel. |
| **R4 New engine features written kernel-first** | Features Hull does not have yet and that are batch arithmetic by nature (section 7). They are designed around the boundary from the start. They still get a TypeScript implementation when a game's correctness depends on them. | The feature's own milestone in `PLAN.md`. | |

R0 and R1 are small. R2 onward is sized after R1's numbers exist.

## 7. Candidates

| Candidate | Today | Fits the boundary | Evidence so far |
|---|---|---|---|
| Physics queries (ray, sphere and capsule casts, overlaps) | TypeScript: `Shape` objects, a `Map` grid, filters that may be functions | Yes, after a flat layout and mask filters | 1,000 rays on 5,000 boxes in about 1.2 ms; 6% of AOTT's step. Small today. |
| Rigid bodies | TypeScript solver, 8 passes | Yes | No game stresses it yet. |
| Pose evaluation and blending for Hull's animator | TypeScript, per character | Yes, if poses are stored flat | Bodies are rigid parts today, not skinned. AOTT's and its soldier's pose code is the game's own, and stays. |
| Skinning matrices | Not built (no skinned bodies yet) | Yes; presentation only, so `f32` and SIMD | R4: write it kernel-first when skinned bodies land. |
| Crowd steering and pathfinding (navmesh) | Not built | Yes | R4. |
| Culling for thousands of instances | three.js, per object | Only for instances Hull owns as flat arrays | Depends on Hull owning instance data. |
| CPU particle simulation | TypeScript emitters; large effects are already on the GPU | Yes | 0.1% of the AOTT frame. Unlikely. |
| Terrain and mesh generation | Game code at load | Yes, but it is load time, not frame time | Would shorten loading, not raise frame rate. Separate decision. |
| Transform hierarchy | three.js `Object3D` | **No**: the matrices are three.js's | The largest cost in AOTT's step, and out of reach. The cheaper fix is in TypeScript: fewer forced `updateMatrixWorld(true)` calls. |

## 8. What does not move

Game code, kits, templates, config and schemas, the world and its nodes, input, UI, the audio graph, the render
bridge and both backends, three.js itself, the tools, the project server, the Studio, the agent. A native runtime
(the game outside a browser engine) is not part of this plan: it would end "one JavaScript file on the web and the
desktop".

## 9. Risks

| Risk | What I would do about it |
|---|---|
| The port gains nothing a player sees. | The gates in section 6. Every phase can end in "keep TypeScript" with the numbers written down. |
| Two implementations drift apart. | One test file runs against both; bit-for-bit parity where the arithmetic allows, a stated tolerance where it does not; the kernel can be forced off in any build. |
| The checksum moves and replays break. | `f64` in simulation kernels; AOTT's checksum is part of R1's "done when"; any intended change regenerates goldens in its own commit. |
| Calls across the boundary eat the gain. | Batch calls only, data in shared memory; the bench counts calls a step, and a kernel that needs more than a handful is redesigned or dropped. |
| `game.js` grows. | Size is reported per kernel and counted in the budget; a game that does not import the module does not carry it. |
| Contributors and CI need Rust. | The `.wasm` is committed with a source stamp; only kernel changes need cargo. |
| Errors lose their place. | A kernel returns error codes; the TypeScript wrapper raises the error with the caller's file and line, as now. Debug builds keep Rust panics' messages. |
| The Studio's live tuning stops reaching the values. | Tunables stay in TypeScript and are written into the kernel's memory through the wrapper, so a changed number reaches the running game with no reload, as now. |
| An AI writing a game is confused by a second language. | It never sees one: no Rust in a project, in the docs for games, or in a tool's output. |

## 10. Owner's decisions

| # | Question | Assumed until you say otherwise |
|---|---|---|
| RQ1 | The target load: what must Hull hold at 60 frames a second that AOTT does not ask for today? (For example: 100 titans, 500 soldiers, a city four times the size.) | R0 measures 1, 4 and 16 times AOTT and you pick from the table. |
| RQ2 | The thresholds in section 4: 2 ms of the frame to qualify, 1.5 times over flat TypeScript to proceed. | **Decided 23 Nov 2026: not applied to physics** ("complete all. migrate completely and get it working with our aot game"). |
| RQ3 | Committed `.wasm`, or cargo required to build Hull. | Committed, with a stamp checked by `pnpm check`. |
| RQ4 | Which machine is the floor. This Mac throttled 4 times stands in for a slow laptop; a real one would be better. | The throttled Mac. |
| RQ5 | Whether to port one kernel regardless of R0's result, as a foundation for larger games. | **Decided 23 Nov 2026: yes, all of physics** (section 14). |

## 11. Changes to other files, each with the phase that earns it

* `PLAN.md` section 9, D2, when R1 passes its gate: "TypeScript for the engine and for games; a measured kernel may
  be Rust compiled to WebAssembly behind its TypeScript API (`plan-rust.md`)". Until then D2 stands as written.
* `PLAN.md` section 6, now: the "Rigid bodies: Rapier (WASM)" row describes something that was never added.
  Physics is Hull's own TypeScript. The row should say so.
* `docs/ARCHITECTURE.md`, with R1: a section on the kernel boundary, loading and fallback.
* `CLAUDE.md`, with R1: the kernel rules in "Rules of the code", and `pnpm kernels:build`.

All four were made with R2 (23 Nov 2026), on the owner's call rather than R1's gate: D2 now names the physics
kernel, the Rapier row says the solver runs in the kernel, ARCHITECTURE section 11 is the boundary, and CLAUDE.md
has the rule and the build command.

## 12. R0 results: where the limit is

Measured 23 Nov 2026 on the Apple M5 Pro. The scripts are in the repo, so every number can be taken again:
`pnpm perf:aott 95 11 <scale> --profile` (headless step and where it goes), `scripts/perf-frame.ts` (the frame in a
browser, also throttled), `pnpm perf:engine` (Hull's own subsystems away from any game).

The stress scene is AOTT's Holdout with `scale` (`?scale=4` in the page): titans a wave, comrades and civilians are
multiplied by it. Read at 95 s of game time, wave 2, the soldier alive on the wall. At scale 1 the run and its checksum
(`a45ff85a5ba1346a`) are the ones section 2 reports.

### The step, headless (Node)

| Scale | Titans, comrades, civilians | ms a step (mean, p95) | ms a frame (2 steps) |
|---|---|---|---|
| 1 | 11, 2, 7 | 0.30, 0.41 | 0.6 |
| 4 | 48, 8, 28 | 1.07, 1.94 | 2.1 |
| 16 | 164, 32, 111 | 3.93, 9.14 | 7.9 |

Where it goes, ms a frame (2 steps), from V8's sampling profile over the last third of the run:

| Subsystem | 1 | 4 | 16 |
|---|---|---|---|
| Hull physics | 0.05 | 0.45 | **2.84** |
| three.js transform matrices | 0.24 | 0.86 | 2.49 |
| Game: soldier, comrades, horses (pose code) | 0.15 | 0.32 | 1.15 |
| Game: titans | 0.03 | 0.15 | 0.47 |
| three.js, the rest | 0.02 | 0.10 | 0.33 |
| Game: collision wrapper | 0.02 | 0.07 | 0.18 |
| Game: civilians | 0.00 | 0.02 | 0.12 |
| Game: the rest | 0.04 | 0.06 | 0.10 |
| Hull core, kits, vfx, audio | 0.00 | 0.01 | 0.01 |

### The frame, in a browser

The dev page in headless Chrome at 1280 x 720, the game stepped to the same point, then timed: single steps, paused
frames (update and draw, no steps), and 5 s running free. "Needs" is 2 steps and a draw, the main thread's bill for one
60 fps frame. The free-running rate reads 55 to 60 when the frame is held (the harness's own jitter, the same at scale
1 and 4), so it is read as "held" or "lost", not as a number. Once a frame is lost the loop runs catch-up steps and the
rate collapses, which is why "lost" is far below 60.

| Scale | CPU | ms a step | ms a draw | Needs (of 16.7) | Draw calls, triangles | Frame |
|---|---|---|---|---|---|---|
| 1 | as is | 0.38 | 1.32 | 2.1 | 293, 0.98 M | held |
| 4 | as is | 1.27 | 2.21 | 4.7 | 551, 1.36 M | held |
| 16 | as is | 8.74 | 7.67 | 25.1 | 1,926, 3.16 M | **lost** (3.6 a second) |
| 1 | throttled 4 times | 1.66 | 5.18 | 8.5 | | held |
| 4 | throttled 4 times | 4.77 | 7.72 | 17.3 | | **lost** (16.5 a second) |
| 16 | throttled 4 times | 36.6 | 31.5 | 105 | | lost (0.9 a second) |

Where the unthrottled frame goes, ms a frame (2 steps and a draw), from Chrome's profile:

| Subsystem | 1 | 4 | 16 |
|---|---|---|---|
| Hull physics | 0.02 | 0.43 | **8.53** |
| three.js transform matrices | 0.17 | 0.67 | 5.03 |
| Browser and natives (GPU commands, style, no JavaScript frame) | 1.30 | 2.43 | 4.69 |
| three.js draw (render lists, bindings, the rest) | 0.47 | 0.77 | 4.13 |
| Game: titans | 0.02 | 0.11 | 0.97 |
| Game: soldier, comrades, horses | 0.05 | 0.13 | 0.67 |
| Game: civilians | 0.00 | 0.03 | 0.35 |
| Game: collision wrapper | 0.01 | 0.05 | 0.34 |
| Game: the rest, hud, effects | 0.02 | 0.08 | 0.27 |
| Hull vfx, render, core | 0.01 | 0.03 | 0.10 |

The page's step at scale 16 costs more than Node's (8.7 ms against 3.9), nearly all of it in physics. The page runs
code the headless run skips (camera, markers); I did not chase the difference further, because both runs name the same
function.

### Hull's own subsystems (`pnpm perf:engine`), median ms a frame

| Bench, load at scale 1 | 1 | 4 | 16 |
|---|---|---|---|
| Ray casts: 1,000 rays, 5,000 static boxes | 0.46 | 2.8 | 11.9 |
| Ray casts: 1,000 rays, 5,000 boxes times scale | 0.53 | 0.75 | 1.31 |
| Sphere casts: 1,000 casts, radius 0.5, 5,000 boxes | 3.6 | 15.0 | 60.6 |
| Sphere overlaps: 1,000, radius 3, 5,000 boxes | 0.20 | 0.88 | 4.1 |
| Rigid bodies: a pile of 100 (2 steps) | 0.38 | 5.3 | 98 |
| Animation graphs: 10 characters (2 steps and a pose) | 0.04 | 0.15 | 0.67 |
| CPU particles: 2,000 live (2 steps) | 0.03 | 0.12 | 0.50 |

### What the table says

* **The frame is lost between scale 4 and 16 on this Mac, and between 1 and 4 when it is throttled 4 times.**
* **At scale 16 it is Hull's physics that loses it**: 8.5 ms of the 25 the frame needs, and one function,
  `Physics.gather`. The world keeps moving shapes in a list and every query walks all of it: 340 overlap queries and
  53 rays a step against 2,515 moving shapes (a titan is about 15 of them) is about a million box tests a step, for
  fewer than one candidate a query. Static shapes are in a grid and cost almost nothing.
* Throttled at scale 4 nothing of Hull's is the limit: the 17 ms is drawing (three.js and the browser) and the
  transform matrices. A kernel does not reach those (section 7).
* Animation graphs and CPU particles stay under 1 ms at 16 times their load. They are closed as candidates.
* Rigid bodies pass 2 ms at 400 bodies and grow with the square of the count, but no game asks for a pile that size
  yet. The cost is the same walk over the moving list, so R1's fix reaches it; it is measured again after R1.
* A sphere cast costs 8 times a ray on the same scene. That is a TypeScript matter (how many grid cells a short fat
  cast visits), not a language one; it is noted for R2.

**Gate.** Physics passes test 1 of section 4 at scale 16 (8.5 ms of the frame in the page, 2.8 headless) and not at
scale 4 (0.4). Which load Hull must hold is RQ1 and still the owner's. R1 goes ahead on the assumption that scale 16
(about 160 titans, 30 comrades, 110 civilians) is a load the owner wants, because the owner asked on 23 Nov for the
whole plan to be carried out; if the target is scale 4 or less, R1's flat TypeScript layout is still a gain and the
kernel question closes with "not needed".

**The candidate R0 names** is not the one section 6 expected (casts against static shapes, which are cheap). It is
the broadphase over moving shapes: where their bounds live, and how a query finds the few near it.

## 13. R1 results: the broadphase over moving shapes

Measured 23 Nov 2026, same Mac. Section 12 named the work: `Physics.gather` and `Physics.cast` walked every moving
shape for every query. R1 ran the three steps section 4 asks for, in order.

**1. Flat TypeScript** (`packages/hull/src/physics/moving.ts`). The moving shapes' bounds went into one
`Float64Array` with a grid over them that is rebuilt as shapes leave their cells; a query reads the few cells it
covers, plus a short list of wide or loose shapes, and hands its candidates back in the order the shapes were added,
so every answer is the one the old walk gave. `moving.parity.test.ts` checks that bit for bit: 10,000 seeded boxes
against the plain walk (adds, removals, moves, bounds that are not numbers), and 10,000 seeded ray, sphere, capsule
and overlap queries against a world made to walk every shape. AOTT's checksum is unchanged at scales 1, 4 and 16.

**2. Rust.** `crates/hull-kernels`: a `no_std` crate with plain `extern "C"` exports, built to a 4,426-byte module
that imports nothing. The grid's arrays lived in the module's memory and TypeScript read them through typed-array
views; the one call across the boundary was the grid build, about once in 70 steps. The whole pipeline of section 5
was built and run: `pnpm kernels:build`, the module committed as base64 with a stamp of its source that `pnpm check`
compared, loading before `ready` in Node and the browser, `"kernels": false` in hull.json and `?kernels=off|fail` on
the dev page, a failure reported once with the TypeScript path running on, and the module's bytes in the build
report. 3,000 seeded grids built by the module were the same bits as the TypeScript build; 10,000 queries answered
inside the module matched. The cube and AOTT built and ran in the browser and in Node with the kernel on, off and
failing to load; AOTT's checksum was the same in all three; `game.js` carried 4.4 kB more for it (2,794,719 bytes).

**3. The bench** (`pnpm perf:engine 1,4,16 physics.moving`): 10 times scale titans of 15 moving shapes over 4,400
static boxes, each step moving every shape and issuing the overlaps and rays AOTT issues. Median ms a frame (2 steps):

| Broadphase | 1 | 4 | 16 | Calls into the module a step at 16 |
|---|---|---|---|---|
| Before R1: walk every moving shape | 0.066 | 0.53 | 8.19 | |
| Flat TypeScript | 0.046 | 0.21 | 1.20 | |
| Grid built in Rust, read from TypeScript | 0.047 | 0.21 | 1.21 | 0.015 |
| Grid and every query in Rust | 0.045 | 0.20 | 1.10 | 384 |

The grid build alone, the one piece both languages implement, takes 31 µs in TypeScript and 16 µs in Rust for 2,400
shapes (1.9 times), but it runs about once in 70 steps, so it is under half a microsecond a step either way.

**Gate (test 4): not passed.** Rust beats flat TypeScript by 0.99 times on the engine's path and by 1.09 times when
every query crosses the boundary, which section 4 forbids anyway (384 calls a step). The gain was the layout: 6.8
times at scale 16. As section 6 says for this case, the flat TypeScript version is kept and the crate is deleted.
The pipeline is in the history (commits `2f002b4` to `8800698` on 23 Nov 2026) for the day a kernel candidate
passes test 1; it worked end to end and can be restored from there rather than rebuilt.

### What the player sees

The dev page in headless Chrome, 1280 x 720, the CPU as it is, before R1 (commit `c49db6d`) and after. "Held" is the
free-running rate at 55 to 60 frames a second, as in section 12.

| Scale | Before: ms a step, draw, frame | After: ms a step, draw, frame | Hull physics, ms a step, before and after |
|---|---|---|---|
| 8 | 3.43, 3.66, held | 1.92, 4.45, held | 0.85, 0.13 |
| 10 | 5.29, 5.12, **lost** (30 a second) | 2.45, 5.74, **held** | 1.79, 0.15 |
| 12 | 6.42, 6.54, lost (17 a second) | 3.54, 7.59, lost (41 a second) | 2.68, 0.36 |
| 16 | 8.74, 7.67, lost (3.6 a second) | 4.88, 7.15, lost (33 a second) | 4.27, 0.68 |

Throttled 4 times, scale 1 is held and scale 4 is lost both before and after (16.5 frames a second before, 25 after).

A page is stepped from wherever real-time play had left the flow, so titan counts at one scale differ between runs
(at 10: 119 before, 98 after; at 12: 124 before, 137 after). The 12 row, where the run after had more titans and still
ran at more than twice the rate, is the cleaner comparison.

So the frame on this Mac now holds at 10 times AOTT's load (about 100 titans, 20 comrades, 70 civilians), where it
was lost before: the load rose by a quarter, the gate R2 sets for a player-visible gain, reached in TypeScript.

### Hull's subsystems after R1 (`pnpm perf:engine`), median ms a frame

| Bench | 1 | 4 | 16 |
|---|---|---|---|
| Rigid bodies, a pile of 100 times scale | 0.28 (was 0.38) | 1.5 (was 5.3) | 10.4 (was 98) |
| Everything else in section 12's table | unchanged | unchanged | unchanged |

Rigid bodies gather their contacts through the same index, so they gained with it.

### Where this leaves the plan

* **R2** (finish the subsystem in Rust) does not start: its gate is R1's, and R1's Rust did not pass.
* **R3** (further kernels) has no candidate. At scale 16, after R1, Hull's physics is 1.4 ms of the page's frame and
  nothing else of Hull's is above 0.1 ms; what is left is three.js (transform matrices 3.2 ms, drawing 3.7 ms), the
  browser, and the game's own code, none of which a kernel reaches (section 7). Rigid bodies pass 2 ms only in a
  pile of 1,600, which no game asks for; the bench keeps them in view.
* **R4** (new features written kernel-first) stays with each feature's milestone. R1's numbers say to build such a
  feature flat in TypeScript first and to hold it to test 4 like any other kernel.
* **What would move the frame next** is in TypeScript and three.js, not Rust: fewer forced `updateMatrixWorld(true)`
  calls (section 7) and fewer draw calls (1,900 at scale 12), and a sphere cast that costs 8 times a ray.
* `PLAN.md` D2 stands as written (section 11): no kernel passed.

## 14. R2: all of physics in the kernel

The owner's call after reading section 13 (23 Nov 2026): "complete all. migrate completely and get it working with
our aot game". So the kernel came back and took the whole of `hull/physics`, not one piece of it.

**What moved.** The kernel world (`crates/hull-kernels`) holds every shape (the static grid, the short list of wide
shapes, the moving-shape index), answers every query (ray, sphere and capsule casts, sphere and capsule overlaps,
`gather`, `distanceTo`; the slide mover's sweeps go through the same cast) and runs the rigid solver. The narrow
phase is all six shape kinds, meshes with their BVH and height fields included. What stays in TypeScript: the API,
the `Shape` and `RigidBody` objects, a shape's pose (it follows a three.js object; the kernel poses only the bodies
it moves), the slide mover's logic, ropes, and the debug view. `docs/ARCHITECTURE.md` section 11 has the boundary.

**The boundary, as built.** Section 3's rule was "a handful of calls a step". A query is one call here, because game
code asks one question at a time and acts on the answer; nothing else crosses by call. Poses and properties are
written into the module's memory, moved shapes are filed by the kernel before its next query, and a rigid step is
one call with the bodies copied in and out. No objects, callbacks or strings cross: tags and nodes are interned to
numbers, and a tag prefix becomes a bit set over tag ids.

**Same answers.** Every operation in the TypeScript's order, in `f64`; `min` and `max` written to JavaScript's NaN
and signed-zero rules; `sqrt`, `floor` and `ceil` are WebAssembly's own instructions, which Rust still marks
unstable, so the crate builds with `RUSTC_BOOTSTRAP=1` (`pnpm kernels:build` sets it). Checked by:

* `narrow.kernel.test.ts`: 10,000 sweeps and 10,000 closest points per shape kind, and 10,000 box tests, against
  narrow.ts, every number compared with `Object.is` (a tie-rule mutation fails 6 of its tests).
* `world.kernel.test.ts`: a world on the kernel and the same world on TypeScript, 320 shapes of every kind and a
  mesh, a height field and a plane, changed alike (moved, switched off, retagged, removed, added) and asked 20,000
  seeded queries with every filter, plus the slide mover; and 300 rigid bodies stepped 720 steps through settling,
  sleep and an impulse. Every answer and state the same bits. Three failure cases found in review have their own
  tests: more moved shapes
  between two queries than the dirty list holds are all still seen; a shape removed before its rigid body keeps its
  id until the body goes. (A fourth, a first allocation the TypeScript views missed, is covered by every test.)
* `world.kernel.churn.test.ts` (added after the review, see "Review fixes" below): 4,000 static additions and removals
  against TypeScript with every answer and its order compared; mesh and height-field churn with the module's memory
  held flat; and input that is not a finite number, run in a child process with a timeout so a hang fails the test.
* The physics suite on both implementations (`physics.test.ts` on the kernel, `physics.typescript.test.ts` off).
* AOTT's checksum at scales 1, 4 and 16 is the same with the kernel on, off and failing to load
  (`a45ff85a5ba1346a`, `e982040814d9d251`, `6a60322536452045`).

`pnpm check`: 155 files, 1,210 tests.

**How fast** (`pnpm perf:engine 1,4,16` against `--kernels=off`, median ms a frame; same answers in every row):

| Bench | TypeScript 1 / 4 / 16 | Kernel 1 / 4 / 16 | Kernel faster by |
|---|---|---|---|
| Ray casts, 5,000 static boxes | 0.54 / 2.88 / 12.0 | 0.27 / 1.63 / 6.68 | 1.8 to 2.0 times |
| Ray casts, boxes times scale | 0.55 / 0.72 / 1.01 | 0.28 / 0.35 / 0.61 | 1.7 to 2.0 times |
| Sphere casts | 3.65 / 15.1 / 61.0 | 1.80 / 7.45 / 30.8 | 2.0 times |
| Sphere overlaps | 0.20 / 0.91 / 4.40 | 0.16 / 0.71 / 3.37 | 1.2 to 1.3 times |
| Rigid bodies, a pile | 0.26 / 1.42 / 9.22 | 0.20 / 1.10 / 7.38 | 1.25 times |
| Moving shapes (AOTT's mix) | 0.046 / 0.21 / 1.15 | 0.052 / 0.21 / 1.14 | the same |

Casts against the static world, where the time is the narrow phase, are twice as fast. Where the time is shapes
moving, it is TypeScript working out the poses (they follow three.js objects) and writing them across, and the
kernel saves nothing.

**In AOTT.** Headless at scale 16, physics is 0.17 ms a step on TypeScript and 0.19 on the kernel (0.10 of it
TypeScript posing and writing, 0.09 inside the module); the whole step is 2.45 and 2.52 ms, inside the noise. In the
page the kernel does better: at scale 12, 0.42 ms a step against 0.23; at 16, 0.53 against 0.47. The frame at those
scales is decided by three.js and drawing (section 13), so it is still lost at 16 either way. Read plainly: AOTT
runs on the kernel with the same results and about the same speed; games that cast a lot against static worlds
(shooters, many projectiles, line-of-sight checks) get the twofold.

**Review fixes.** An independent review (46,000 fuzzed queries, kernel against TypeScript, no mismatch) found these
and they are fixed:

* *Static churn was slow.* The kernel kept static shapes in a dense grid rebuilt from scratch at the next query after
  any add or remove (one cycle of add a box, cast, remove, cast: 75 us against TypeScript's 4.5 us over 5,000 statics
  across 600 m; 956 us against 1.4 us for 200 statics across 16 km, with a 15 MB grid). It is now a hash map of cell
  to list, appended to and removed from in place like `world.ts`'s `Map`. The same cycles now cost 5.3, 4.0 and 2.4 us
  (TypeScript 4.6, 2.2, 1.2), and the "world too wide" fallback is gone with the grid it guarded.
* *Memory grew without bound on mesh and height-field churn* (3,000 add, cast, remove cycles of a 300-triangle mesh:
  0.5 MB to 333 MB). The allocator now frees (size classes with free lists) and each shape owns its arrays, which go
  back when it is removed. The same loop stays at 0.56 MB; moving-shape and body churn are still 0.69 and 0.31 MB.
* *`overlapCapsule` with a NaN end point* gave shapes on the kernel and none on TypeScript (the kernel's i32 turned
  NaN into 0); and a sample count past 2^31 wrapped. Both now decide in `world.ts` before the kernel is called:
  not a usable count means no shapes.
* *Hangs on input that is not finite*, older than the port: a sphere or capsule cast from an infinite origin (ring
  loops), an overlap with an infinite centre, a static shape with infinite bounds, and `overlapCapsule` or
  `capsulecast` with radius 0. Each now returns at once with no hit, no shapes, or the shape on the short list, the
  same on both implementations (ARCHITECTURE section 11 lists them); finite input is unchanged.
* The Rust compiler is pinned (`rust-toolchain.toml`, 1.99.1, wasm32 target) and its file is part of the source stamp.
* `"kernels": false` keeps the module out of use but not out of `game.js`; SCHEMAS.md says so.

**What it costs.** The module is 74,899 bytes (55 kB at opt-level "s", traded for speed). AOTT's `game.js` is
2,891,100 bytes (800,907 gzip) with it and 2,785,683 (761,289 gzip) without: 105 kB, 40 kB gzipped. Only a game that
imports `hull/physics` carries it.

**Not moved, and why.** Hull's animation graphs (0.66 ms at 160 characters) and CPU particles (0.59 ms at 32,000)
are the other candidates of section 7; neither is used on AOTT's hot path (its bodies and poses are the game's own
code, its large effects run on the GPU), so porting them would change nothing AOTT does. They are the next
candidates if a game needs them. Skinning and navmesh (R4) are not built yet.
