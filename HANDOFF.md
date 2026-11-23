# Handoff: where Hull stands and how to carry on

Written 19 Nov 2026, at the end of the session that built the engine. A new session should read this first, then
CLAUDE.md, then PLAN.md §7. Those three files are enough to pick up the work.

## 1. State

- **Updated:** 19 Nov 2026, end of the session that finished M6.
- **Branch:** `main`. No other branches or worktrees. The owner pushes; nothing from this session is pushed yet.
- **Checks:** `pnpm check` passes: 517 tests. `pnpm project:check examples/aott` passes.
- **Built:** M0–M7. M6 (AOTT on Hull, `examples/aott`) was checked in the app: look and tunable edits changed the running game with no reload, and Build wrote one 2.6 MB file that boots and plays Holdout. `examples/aott/PORT.md` says what was ported how and what stays in code.
- **The `hull` command line is gone.** Tools, MCP and the project server are in `packages/tools` (`@hull/tools`); the app hosts MCP over HTTP on 127.0.0.1; `packages/tools/bin/hull-mcp.js` serves MCP over stdio. Maintainer scripts: `pnpm project:check|build|dev <dir>`, `pnpm project:run <tool> <dir> [json]`.
- **Next:** M9, the agent panel and Hull's own harness, as decided in PLAN.md §3.4 and D13–D16. The research and the decision are on https://claude.ai/artifact/ByfyFGHAAE2PgKkRyskJtG. Order: ACP client in the app → Hull's agent (loop, tools in-process, user key and ai.marlstudio.com) → edit/patch, compaction, plan mode, subagents, evals → notices file.
- **Since then (19 Nov 2026, later):** M9 core and M10 are on `main`. The app's agent panel is an ACP client (Hull's own agent in `packages/agent`, external ACP agents, Claude Code in a terminal pane); agents can edit `src/` through Hull's code tools. Ironleaf (`examples/ironleaf`, GAME.md) is playable: combat kit (`hull/kits` combat: move-set and enemy configs), layered keyed animation with windows, five enemy types and a duel, camp balance checked by scripted bots over 20 seeds. Studio gained the Content Browser, readable Changes diffs, launch options, the Community tab, input bindings table. Dev commands run without memgate (owner's instruction).
- **Not started:** M8 (hosted). Next for M9: a live-model run and an eval suite; for M10: someone plays it by hand and listens.

- **Updated 23 Nov 2026 (M12, agent sight and reach):** an audit drove a fresh project over MCP, and its findings were fixed and merged on `main` (nothing pushed). `pnpm check`: 149 files, 1,143 tests. What is new:
  - **Over MCP** a screenshot is a picture, tool inputs are checked against their schemas, results are small, and the control port (`game.run`) has `inspect`, `tree`, `until`, `errors` (file:line:col through source maps), `restart`, `perf` (per frame), `look`, `frames`, `ui`, `click`, sized screenshots, and `teleport` / `set` for arranging a test; games expose values with `probe(name, read)`. Play scripts have `until`, `expect`, `click`, `expectUi`, and fail on a logged error.
  - **check** also runs the kits' own rules (`hull/kits/checks`), flags a `"kind/id"` literal with no config, a kit imported without its config (fix: `kit.add`), and type-checks tests. `asset.new` makes every kind; `kit.list` / `kit.add` copy kit config in.
  - **Docs for agents:** `packages/hull/docs/ENGINE.md` (`docs.read guide/engine`), API pages with class members, and an `AGENTS.md` + `CLAUDE.md` in every new project.
  - **Engine:** kinds `level` and `prefab` (a part can be a glTF model), kits `nav`, `hud`, `menu`, `objectives`, `interact`, `projectile`, `checkpoint`, `inventory`, glTF models and skinned glTF bodies, emissive materials, a UI that scales with the window and menus that hide the HUD, the `yard` template (a whole game on kits and a level file).
  - **Safety:** tokens on the project socket and on MCP over HTTP, game sockets that can only report, `.hull/` not served to the game page, an IPC guard in the app, per-user budgets and a model allowlist in `backend/`, atomic history writes.
  - **Hull's agent:** retries with backoff, cut answers handled, thinking blocks kept and replayed, effort per mode, refusals, a stage that fails is retried once. Still never run against a live model.
  - Section 8 says how to try the engine as an agent would.

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

## 6. Known gaps

- **Not judged by a person:** no sound has been heard; AOTT has not been played by hand (mouse look, hit-stop, the feel of the soldier); dawn's look was captured but not compared by eye.
- **AOTT:** WebGL2 only (its materials are GLSL); meshes, decals, slash arcs, the light pillar and the orbit camera stay in code; the whole frame runs per 120 Hz step with no interpolation (PORT.md §5).
- **Benches:** code sound recipes render for a fixed 3 s, so their length is not measured.
- **Desktop builds:** the Studio's main process runs through tsx; packaging the app needs bundling. Windows and Linux game packages are untested.
- **Renderer:** every build ships both backends; GPU timestamps are wrong on Apple GPUs.
- **Build:** assets are inlined into `game.js`; `targets.web.singleFile` and `budgets` are not acted on.
- **Worktrees:** `agent-browser eval` is refused inside agent worktrees, so workers read page state with `agent-browser wait --fn` or by URL.
- **Browser checks:** use one `agent-browser --session <name>` per worker and close it; wait for servers with one command (a small Python poll script), never a loop of curl calls.

## 7. Done: the AOTT port (M6)

Phase 1 (one lead) and phase 2 (sound, characters, effects, look, collision, kits in parallel) are merged. `examples/aott/PORT.md` is the record.

## 8. Trying it as an agent would (M12)

The honest test of the tools is an agent that has nothing else. Two were run on 23 Nov 2026, each told to touch the
project only through MCP tool calls and to log every point of friction:

| Run | Game | Result | Friction |
|---|---|---|---|
| 1 | Emberwatch (third person, keep a fire fed while shades hunt you), from `arena` | 249 lines of its own code on the kits, 5 tests, build 1.95 MB | About 35 of 120 calls wasted: no UI click, no way to create a level file, kit config silently missing, cumulative perf numbers, HUD over the menus |
| 2 | Vault Run (first person, a level file of three rooms, switches, turrets, checkpoints), from `fps` | 284 lines of its own code, 4 tests, a level and a door prefab made with the tools, play golden matching at 0 pixels, build 1.94 MB | About 35 of 330 calls wasted, plus about 200 spent steering the player by hand. Fixed afterwards: `kit.add` kept a stale input map with no `interact` action (it now merges missing actions and `check` flags the gap), the test tool swallowed `console.log`, `frames` ignored its size, no way to place the player (`teleport`, `set`, `until near`), and facts the guide left out (key names, snapshot format, mesh size, yaw). Left: no preview while tuning a look, bloom blows out small emissive shapes, error stacks show engine frames |

How to repeat it:

```
pnpm project:run new <parent dir> '{"dir":"mygame","template":"yard"}'
node scripts/mcp-client.mjs <parent dir>/mygame 5599 <dir for pictures>     # one MCP session, kept open
node scripts/mcp-call.mjs --tools                                           # what the agent sees
node scripts/mcp-call.mjs game.run '{"control":{"op":"ui"}}'                 # one tool call
curl -s http://127.0.0.1:5599/stop                                          # ends it and its headless page
```

Give a worker agent only `mcp-call.mjs`, forbid every other way to the project, and ask for a friction log (the exact
call, the reply, what it expected, what it cost). Do not edit engine source while it runs: a save reloads its game page.

**Still open after M12:**
- No run with a live model, and no scored task suite. The root `.env` has a key for `backend/`; a run spends credits, so the owner starts it.
- The Electron app was not opened in this work; the Studio has no bench for `level` or `prefab` beyond the kit's bench scene.
- AOTT and Ironleaf do not use the new kinds and kits yet (their worlds and HUDs are still code).
- glTF: no IK on glTF bodies, clips only from the body's own file, textured files untested.
- Goldens are from this Mac's headless GPU. Sound was measured, never heard.
