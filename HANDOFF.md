# Handoff: where Hull stands and how to carry on

Written 19 Nov 2026, at the end of the session that built the engine. A new session should read this first, then
CLAUDE.md, then PLAN.md §7. Those three files are enough to pick up the work.

## 1. State

- **Branch:** `main`, pushed to `origin` (github.com/Himasnhu-AT/hull) at 9832d8d. It is the only branch and
  there are no worktrees.
- **Checks:** `pnpm check` (TypeScript 7 strict plus Vitest) passes: 449 tests, about 1 minute.
- **Built:** M0–M5 and M7. PLAN.md §7, "Where each milestone stands", lists each milestone's state, how it was
  checked, and its known gaps.
- **Next:** M6, rebuilding AOTT (`../aot`) on Hull. The owner stopped the port the first time and said "we'll port
  it tomorrow". **Wait for the owner to start it.**
- **Not started:** M8 (hosted) and M9 (Marl AI backend).

## 2. What the owner wants (standing instructions)

- **The product is the Hull desktop app** (`packages/studio`), like Unreal's editor:
  - make a project from a template, the game runs inside, tune it in the Inspector, press Build
  - the `hull` CLI is paused: keep it compiling, don't grow its front
  - tools are defined once (`packages/tools`, `@hull/tools`), and the app and MCP reach them; the CLI was removed on 19 Nov 2026
- **The end goal:** AOTT migrated onto Hull, tested in the app with config edits updating the game live, and a
  build performed. Then stop.
- **UI work:** follow the `/apple-design` and `/design-taste-frontend` skills (files in `~/.claude/skills/`) and
  the approved Studio design canvas: https://claude.ai/artifact/CbaaZ9DmhFNohw1ybT1nE8. The plan page is
  https://claude.ai/artifact/Pozqfe5ynJb8b7jTCcy193 and the build design is
  https://claude.ai/artifact/XfDxf7pCnLzzVLhgc69Pid.
- **Session mode:** unmonitored. Don't ask permission; make the safe choice and say so in the commit message.
- **Git:**
  - Work and merge on `main`. Delete each worker's branch and worktree right after merging it.
  - **The owner pushes.** `git push` is denied for the agent.
  - Never delete `main` in a cleanup sweep (it was deleted once by `git branch --merged | xargs`).
- **Never modify `../aot`.** Port by copying into this repo. Never port from `../engine-dep`.
- **memgate:**
  - Heavy commands go through `memgate`: installs, typecheck, tests, builds, browsers. Don't bypass it.
  - Long-lived dev servers under memgate hold one of its 2 slots, so start one only for a check and stop it after.

## 3. How the work was run (and worked well)

- **Roles:** Opus orchestrates; **Sonnet workers** each run in their own worktree (`Agent` with `model: sonnet`,
  `isolation: worktree`), several in parallel.
- **A shared team brief file per wave.** Every worker gets the same file: who owns which files, the signatures
  where they meet, ports, rules and how to report. The last one is
  `/private/tmp/claude-501/-Users-himanshu-codes-game-engine/fc42d9f8-af52-4128-94bf-df192cab6a54/scratchpad/wave3-team.md`.
  The scratchpad may be gone, so rewrite it from this file if needed. Workers message each other by name.
- **Install every dependency up front**, in one commit on `main`, so parallel branches never fight over the
  lockfile. Add a template's lockfile importer by hand and install with
  `pnpm install --frozen-lockfile --offline --config.minimumReleaseAge=0`.
- **Merge:**
  1. Merge the worker's branch with `--no-ff`.
  2. Resolve conflicts. They are almost always `schema/index.ts` kind lists, `packages/hull/package.json`
     exports, or the studio `Editor.tsx` tabs. Keep both sides.
  3. Run `memgate -- pnpm typecheck` and `memgate -- pnpm test`.
  4. `git worktree remove -f -f <path>` and `git branch -d <branch>`.
- **Moving a worktree to a newer base:** `git reset --hard` is denied. Use `git merge --ff-only <commit>`.
- **Worktree cleanup:** a worker that stops with no changes has its worktree removed automatically. To restart it,
  launch a new one; a message won't bring it back.
- **Browser checks:**
  - Use `agent-browser --session <name>` with `timeout`, and close the session afterwards.
  - **Never call it with `execFileSync` from a Node process that also hosts the project server**: it blocks the
    event loop and the page never loads. Use async exec.

## 4. Repository map

```
packages/hull/src/      the runtime a game imports ('hull', 'hull/render', 'hull/audio', ...)
  core/                 loop, world, nodes, behaviours, signals, timers, random, checksum, onBeforeSteps
  config/               registry, validation (file#pointer line:col), tunables, kit overrides from tuning files
  schema/               every kind as TypeBox → /schemas/*.schema.json (HULL_WRITE_SCHEMAS=1 pnpm test regenerates)
  render/               bridge; webgl2.ts and webgpu.ts backends ('auto' tries WebGPU); look, post, environment
  vfx/ audio/ input/ ui/ anim/ physics/ platform/ kits/
  dev/                  protocol.ts (the one protocol), runtime.ts (connectDev, control port)
packages/tools/src/     tools (check, test, build, package, play, new, project methods), mcp/, server/ (project
                        server: WS JSON-RPC + Vite dev page, edits, journal, build), history/, review/, mcp/
packages/studio/        the Hull app: Electron main + preload, React renderer (launcher, editor, Inspector,
                        benches/, history/). `pnpm app` = Electron, `pnpm app:web -- --project <dir>` = browser
shell/electron          the desktop shell games are packaged in
templates/              cube, arena, fps, third-person
```

**Tools to check by hand:**
- `pnpm project:check|build|dev <dir>`, `pnpm project:run <tool> <dir> [json]` (maintainer scripts in `scripts/`), `packages/tools/bin/hull-mcp.js [dir]` (MCP over stdio).
- `pnpm exec tsx <script.mts>` with `createProject` and `startProjectServer` from `packages/tools/src/server/index.ts`
  drives a project over its WebSocket (role `studio`).

## 5. Traps already hit (do not repeat)

- **Engine code reads config with `config.lookup(kind, id)`, never `config.get`.**
  - A game's generated `.hull/gen/ids.ts` narrows `get`, and the engine source is type-checked inside the game.
  - A house-rules test enforces this.
- **Kind names with a dash** are quoted in `ids.ts` (already fixed).
- **The project server works on the real path of the root.** On macOS `/var` is `/private/var`, and a symlinked
  root made every tunable write reload the page. `reload.e2e.test.ts` guards this.
- **Server writes are atomic** (temp file under `.hull/tmp`, then rename). Half-written reads looked like hand
  edits.
- **`shot()` draws the current state before capturing.** WebGPU starts asynchronously, so a paused page may not
  have drawn yet.
- **The dev server does not pre-bundle `three`.** Pre-bundling it gave WebGPU a second copy.
- **TypeBox `Type.Tuple` emits draft-07 `items`, which Ajv 2020 rejects.** Use `prefixItems` (`schema/tuples.ts`).
- **Wall-clock budgets in the shared suite are flaky under load.** The physics budget runs only with
  `HULL_PERF=1`.

## 6. Known gaps (also in PLAN.md §7)

- **Not judged:**
  - No sound was ever heard, only measured.
  - The app was checked mostly in web mode; the Electron window was opened only a few times.
- **Desktop builds:**
  - The Studio's main process runs through tsx. Packaging the app itself needs bundling.
  - Windows and Linux game packages are untested.
- **Characters and animation:** rigid-part bodies (not skinned), glTF clips skipped.
- **Renderer:**
  - Every build ships both backends: the arena is 1.68 MB.
  - GPU timestamps are wrong on Apple GPUs.
- **History:** experiments don't overlay kit values in the app; the line diff is coarse.
- **Control port:** only step, press, release, state and screenshot.
- **Inspector:** arrays of objects (anim-graph transitions) and arrays of enums still fall back to a JSON box.
- **Docs:** ARCHITECTURE.md lags the code for anim, physics, vfx, platform, kits and mcp; workers documented in
  module READMEs and code. SCHEMAS §6 still shows `anim/soldier`; the real ids are `anim-set/…` and
  `anim-graph/…`.

## 7. Next: the AOTT port (M6)

AOTT is 27k lines of TypeScript and three.js, everything generated in code, fixed 120 Hz, with a shared `game`
object and optional-chained subsystems. Read `../aot/ARCHITECTURE.md` (§1 boot and frame, §2 game object, §11
render, fx and sound, §16 traps).

**The plan, already briefed once:**
1. **Phase 1, one lead worker:**
   - Copy `../aot/src` into `examples/aott/`, with `hull.json` step 120.
   - Boot through `defineGame`.
   - Hull loop, render bridge (no own `WebGLRenderer`), look and post, input-map, audio context.
   - `CFG` → `tunables()` blocks; titan constants → tuning.
   - Analytics → a no-op (no posthog).
   - `Math.random` and `setTimeout` → `world.random` and `world.after`.
   - Add an engine escape hatch only if needed (for example a `hull/three` re-export), additively.
   - **Done when:** typecheck passes; a deterministic headless Holdout run passes; it boots and plays in the dev
     page; `tunables.set` changes play live with no reload; the build runs.
   - The lead also writes `examples/aott/PORT.md` with 4–6 parallel phase-2 packages.
2. **Phase 2, a parallel fan-out:**
   - sounds → `sound` configs on the sound bench
   - people and titans → `character` and anim configs on the character bench
   - effects → `vfx` configs
   - look → `look` config
   - collision → `hull/physics` where it fits
   - kits where they match: the follow camera, health with hit zones, pickups (gas and blades), the spawner
3. **Final check (the owner's goal):** open `examples/aott` in the Hull app, change config and tunables, see the
   game update live, and press Build.
