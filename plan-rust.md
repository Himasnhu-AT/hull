# Hull: the Rust plan

How Rust enters Hull, where it is allowed, and the measured gates each step must pass. Written 23 Nov 2026.
`PLAN.md` stays the plan for the engine; this file is the plan for one track of it, and changes `PLAN.md` only where
section 11 below says so.

**Status: R0 has started (the AOTT baseline is measured). Nothing is ported.**

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
| RQ2 | The thresholds in section 4: 2 ms of the frame to qualify, 1.5 times over flat TypeScript to proceed. | As written. |
| RQ3 | Committed `.wasm`, or cargo required to build Hull. | Committed, with a stamp checked by `pnpm check`. |
| RQ4 | Which machine is the floor. This Mac throttled 4 times stands in for a slow laptop; a real one would be better. | The throttled Mac. |
| RQ5 | Whether to port one kernel regardless of R0's result, as a foundation for larger games. | No: R1 starts only on a candidate R0 names. |

## 11. Changes to other files, each with the phase that earns it

* `PLAN.md` section 9, D2, when R1 passes its gate: "TypeScript for the engine and for games; a measured kernel may
  be Rust compiled to WebAssembly behind its TypeScript API (`plan-rust.md`)". Until then D2 stands as written.
* `PLAN.md` section 6, now: the "Rigid bodies: Rapier (WASM)" row describes something that was never added.
  Physics is Hull's own TypeScript. The row should say so.
* `docs/ARCHITECTURE.md`, with R1: a section on the kernel boundary, loading and fallback.
* `CLAUDE.md`, with R1: the kernel rules in "Rules of the code", and `pnpm kernels:build`.
