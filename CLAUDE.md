# Building Hull

Hull is Marl Studio's TypeScript game engine for one workflow: an AI writes the game, a person verifies and tunes
it in Hull Studio, and the game builds to one JavaScript file that runs on the web and on the desktop.

**Status: M0–M5 and M7 are built and merged on `main`; M6 (AOTT on Hull) is next.** `pnpm check` runs types and
every test; `pnpm app` opens the Hull app. Maintainer scripts that call the tools on a project: `pnpm project:check <dir>`, `pnpm project:build <dir>`, `pnpm project:dev <dir>`, `pnpm project:run <tool> <dir> [json]` (they never ship). PLAN.md §7 has each milestone's state and its known gaps. The design is in
these files. Read them in this order before changing code:

1. `PLAN.md`: goals, the parts, history and experiments, the tech stack, milestones, decisions made (section 9)
   and still open (section 10).
2. `docs/ARCHITECTURE.md`: how each part is built and the rules between them.
3. `docs/SCHEMAS.md`: every config file format.
4. `docs/WORKFLOW.md`: the loop the engine exists to serve.
5. `docs/COMPETITION.md`: what the main competitor offers and where Hull must be visibly better.

`../engine-dep` is an older, unrelated engine. Do not port from it or model this one on it.
`../aot` is AOTT, the game that will be rebuilt on Hull (milestone M6). It is the best picture of what a real game
needs: read its `ARCHITECTURE.md` when designing an engine module, and expect to match what it does.

## How to work here

* **Follow the plan, milestone by milestone.** Start at M0 in `PLAN.md`. A milestone is finished when its "done
  when" check passes, not when the code exists.
* **If the plan is wrong, change the plan first**, in its own commit, and say why. Do not quietly build something
  else.
* **Decisions in `PLAN.md` section 9 are made.** Those in section 10 are the owner's and still open: build on the
  stated assumption, and ask if one blocks you.
* **Work on a branch.** Commit when asked.
* **Pin every dependency version when you add it**, after checking its current release and that it does what the
  plan assumes. The plan names choices, not versions.
* **Run heavy commands through `memgate`** (installs, builds, test suites, browsers).

## Rules of the code

* TypeScript, strict, for the engine and for games.
* `core` and `config` run in Node: no `window`, `document`, `AudioContext` or WebGL in them.
* Game time only: no `setTimeout`, `Date.now`, `performance.now` or `Math.random` in the simulation. Use the
  loop's clock, `world.after`, and `world.random(name)`.
* No allocation per frame in engine code. Reuse scratch objects.
* Every config kind has a schema, an example, a bench and a test before it counts as supported.
* A project is `src/` and `config/`. Anything Hull keeps for itself goes under `.hull/`.
* The Studio never touches the disk: it talks to the project server over one protocol, so it can run against a
  remote project later.
* Games never touch the renderer: everything goes through the render bridge, so the WebGL2 and WebGPU backends
  both work.
* A tool is defined once, in `packages/tools` (`@hull/tools`), and exposed to the app, as an MCP tool and to Marl AI. There is no command line. Do not add a capability to one
  front only.
* A write to a user's file (JSON or a TypeScript literal) is validated before it is kept, and recorded in the
  history with its author.
* Errors name the place: `file:line:col` for code, `file#/json/pointer` for config.
* A subsystem that fails to start is reported once and skipped; the game keeps running.
* Dev tools live in `dev/` and never reach a ship build.
* Small API, familiar names (`ready`, `update`, `fixedUpdate`, signals, groups). One way to do each thing.
* Comments say why, in plain sentences. Docs are written with the code, in the same change.

## Before you say something works

1. Types, tests and the build pass.
2. You ran it and looked: a state you read back, a screenshot you opened, a number you measured.
3. For anything on screen or in the speakers, say plainly what you could not judge.

## Testing in a browser

* Drive the game by stepping it (`game.step(n)`), not by waiting on real time.
* Use one browser session, wrap calls in a timeout, and close the session when done: leftover sessions keep
  rendering and starve the GPU.
* Saving a source file reloads every open dev page; do not edit while a browser test is running.
