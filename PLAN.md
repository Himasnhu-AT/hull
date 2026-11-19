# Hull: the plan

Hull is Marl Studio's game engine, in TypeScript, for one way of working: **an AI writes the game, a person
verifies and tunes it.**

This document is the whole plan at one level of detail. The files in `docs/` go deeper on the build
(`ARCHITECTURE.md`), the config files (`SCHEMAS.md`), the daily loop (`WORKFLOW.md`) and the market
(`COMPETITION.md`). Section 9 records the owner's decisions; section 10 lists what is still open.

## 1. Goals

1. **The AI can write a whole game** in TypeScript and JSON, and check its own work without a person: typecheck,
   validate config, run the simulation headless, take screenshots, measure sound.
2. **You can verify every piece separately.** A sound, a character, an animation, a menu, a visual effect each open
   on their own bench in Hull Studio, where you can play, scrub, compare and approve them.
3. **You can tune any of it, and the change lands in the project.** Dragging a slider rewrites the JSON value or
   the TypeScript literal it stands for, live, while the game runs.
4. **Nothing is ever lost.** Hull keeps the history of every change by default, and lets you run several
   experiments side by side and adopt the best one.
5. **The game builds to one plain JavaScript file** that contains the UI, the sound and the logic.
6. **That build runs on a website and natively on macOS, Windows and Linux.**
7. **Hull runs locally on your desktop.** Later the same Studio is served from Marl's servers: customers build
   there, Marl holds the code, and the games they make are free to play and share (section 8).
8. **Any agent can drive it**: a local Claude Code or Codex, any MCP client, or Marl's own AI backend
   (section 3.4).

### Not in the first version

* A visual scene editor (placing objects by hand). The AI builds levels in code and data; you review them.
* Multiplayer, mobile and consoles.

### Planned for later, and designed for now

* **WebGPU**, as a second renderer beside WebGL2 (section 6.1).
* **AI-generated assets**: models, images, voice, music. The first house style is made in code; config already
  accepts imported files, so generated ones slot in.
* **Other 3D engines.** What this means (a Hull game exported to another engine, or Hull's tools driving one) is
  to be pinned down when the track starts.
* **The hosted Studio and Marl's AI backend** (sections 8 and 3.4).

## 2. Principles

| Principle | What it means in practice |
|---|---|
| A project is source and config | `src/` (TypeScript) and `config/` (JSON). Nothing else to learn. Hull's own data sits in a hidden `.hull/` folder, the way git's does. |
| What things *are* is data, what they *do* is code | A sound's recipe, a character's proportions, a jump's height are values with a schema. Code reads them and never buries a number you might want to change. |
| Every piece can be seen alone | Each kind of config has a bench: a tiny harness that shows only that piece. |
| Edits are direct | The Studio writes the real file: the JSON field, or the literal in the `.ts` file. There is no second layer of overrides to reason about. |
| History is on by default | Every change, yours or the AI's, is recorded with who made it. Experiments branch from any point. You never have to remember to save a version. |
| The simulation is deterministic | Fixed time step, seeded random streams, no wall clock in game code. The same inputs give the same run, so tests are exact and bugs replay. |
| The simulation does not need a screen | The game's logic runs in Node with no browser. Thousands of frames run in a second inside a test. |
| Failure is local | A subsystem that fails to start is reported and skipped; the game still runs. A bad config file names the file, the field and the reason. |
| One way to do each thing | Small API with familiar names. Fewer choices means fewer wrong ones for a model to make. |

### A game project

```
mygame/
  hull.json     the manifest
  src/          TypeScript: logic and tunables
  config/       JSON: sounds, characters, animations, screens, levels, numbers
  .hull/        Hull's own data: history, experiments, review notes (hidden)
```

## 3. The three parts

### 3.1 Runtime: the library a game is built on

One package, `hull`, with these modules. A game imports only what it uses; the build drops the rest.

| Module | Does |
|---|---|
| `core` | The loop (fixed step, pause, slow motion, single-step), the world, timers in game time, seeded random, events. No browser APIs: runs in Node. |
| `config` | Loads config files, checks them against schemas, hands typed values to code, and tells code when a value changed (live tuning). Also the `tunables` block for values that live in code. |
| `render` | three.js: renderer setup, the look (sun, sky, fog, exposure, post), cameras, materials, a mesh builder for generated geometry, instancing, particles, debug drawing. |
| `audio` | Web Audio: sounds from recipes (synthesis graphs) or samples, buses and ducking, 3D placement, layered music, offline rendering for measurement. |
| `anim` | Skeletons, clips (keyframes, generated in code, or from glTF), a state graph with blending, layers, IK, events on the timeline. |
| `ui` | Screens and HUD as DOM: design tokens, components, screens described in JSON, keyboard and gamepad focus, menus, a settings screen and a key-binding screen generated from data. |
| `input` | Keyboard, mouse, gamepad, touch mapped to named actions; rebinding. |
| `physics` | Built-in swept collision against simple shapes for characters; an optional rigid-body adapter. |
| `platform` | The differences between a browser and a desktop shell: saves, window, fullscreen, quit, files. |
| `kits` | Ready gameplay pieces the AI composes: controllers, cameras, health, pickups, spawners, menus, save slots. Each ships with its config, a bench and a test. |

### 3.2 Config: files that describe what things are

Every config file is JSON with a `kind`, an id (its path) and a body:

```json
{ "kind": "sound", "bus": "sfx", "level": -6, "source": { "type": "synth", "...": "..." } }
```

Kinds in the first version: `game`, `tuning`, `sound`, `music`, `mixer`, `character`, `anim-set`, `anim-graph`,
`material`, `vfx`, `look`, `ui-theme`, `ui-screen`, `input-map`, `prefab`, `level`, `strings`.

* Schemas are written once in TypeScript and emitted as standard JSON Schema files. The same source gives the
  editor autocomplete, the build its checks, and the Studio its forms.
* A schema carries UI hints (`x-ui`: slider range, step, unit, colour picker, curve, group), so the Studio's form
  is usable without anyone designing it.
* **Values in code** work the same way. A `tunables` block in a `.ts` file declares numbers with ranges; the
  Studio shows them as sliders, changes them in the running game, and rewrites the literal in the source file.

`docs/SCHEMAS.md` has every kind with its schema and an example.

### 3.3 Tools and Hull Studio

**The Hull desktop app is the product.** You make a project in it and work in it, the way you work in Unreal or
Unity: a launcher to create a project from a template or open one, then the editor with the game running inside it,
the Library, the Inspector, the benches, History and the Build button. The project server runs inside the app (its
main process) and speaks the same protocol a remote one will, so the hosted Studio of M8 is the same front end.

**There is no `hull` command line.** It is removed (plan change, M6 wave 2): the app is the product, and a command
line was one more front to keep working and document. Every tool is defined once, in the shared package
`packages/tools` (`@hull/tools`), as a typed function with a JSON Schema, and exposed to the Hull desktop app, over
MCP, and later to Marl AI. The desktop app hosts the MCP server (streamable HTTP on 127.0.0.1) for the open project,
so a local agent (Claude Code, Codex, any MCP client) connects to the app and works on the same project the person
has open; the app shows how to connect. One small stdio launcher (`packages/tools/bin/hull-mcp.js`, MCP only, no
commands) starts the same server when the app is not open. Repo maintainers have dev scripts under `scripts/`
(`pnpm project:check <dir>`, `project:build`, `project:dev`) that call the tools; they never ship.

The tools:

| Tool | Does |
|---|---|
| `new` | A new game from a template (the app's launcher). |
| `dev` | The game in a browser with live reload of code and config. |
| `check` | Types, config against schemas, references between config and code, house rules. |
| `test` | Scenario tests of the simulation in Node. |
| `play` | Runs the real game in a headless browser through a script of inputs, waits and checks; saves screenshots. |
| `bench` | Renders every sound offline and measures it; runs frame-time budgets. |
| `history.*`, `exp.*` | Lists changes, makes checkpoints, starts, compares and adopts experiments. |
| `review.*` | Lists your notes for the AI. |
| `build` | `dist/web/game.js` + `index.html`. |
| `package` | Desktop apps from the same build (Electron; Tauri is experimental). |
| `game.run`, `config.*`, `tunables.*` | The running game's controls and the project's files. |

**Hull Studio** is a desktop app (its own window):

* **Library**: every config file and tunables block, by kind, with its review state.
* **Bench**: the selected piece, alone. Sound: play, loop, new variation, waveform, spectrum, loudness, A/B with
  the last version. Character: turntable, skeleton, every clip, scrub, speed, the state graph with live
  parameters. UI: each screen in each state, at several sizes. VFX, look and level: the same idea.
* **Inspector**: a form built from the schema. A change is written to the file and applied to the running bench
  at once.
* **History**: the timeline of changes (who, what, in plain words: "jump height 2.2 → 2.6"), checkpoints,
  experiments, a side-by-side compare, adopt.
* **Review**: mark a piece approved or needs-change and leave a note. The AI reads the notes as its to-do list.
* **Play**: the whole game with pause, single-step, slow motion and the same inspector.
* **Chat**: a panel beside every view. `@` names a piece, a clip, a value or a history entry; `/` runs a skill
  (fix, recreate, tune, variations, explain, new clip, check, test, checkpoint, undo). The mode (agent, ask, plan)
  and the model sit in the composer. A conversation stays the same across views until you start a new one, and
  each turn ends as one change in the history. Skills are files under `.hull/skills/`, listed by the same tool
  registry as everything else.
* Every panel can be shown or hidden, so a change made from the chat is seen live in whichever bench is open.

### 3.4 Who drives it: three ways

Hull's tools are defined once (check, test, play, bench, files, history, review, the running game's controls) and
reached three ways. The project cannot tell them apart, and the history records which one made each change.

| Way | Who runs the model | How it reaches Hull |
|---|---|---|
| Any agent over MCP | Your own agent outside the app: Claude Code, Codex, any MCP client | The MCP server the app hosts (streamable HTTP on 127.0.0.1), or the stdio launcher when the app is closed. No Hull harness is involved. |
| An external agent inside the app | Your installed Codex, Gemini CLI or other ACP agent, signed in with your own account | The app's agent panel is an ACP (Agent Client Protocol) client; it starts the agent on your machine and hands it Hull's tools over MCP in `session/new`. Claude Code runs as the real, unmodified `claude` in a terminal pane of the app; the Claude ACP adapter is offered only after Anthropic confirms it in writing (D15). |
| Hull's own agent | Your API key, or credits on Marl's gateway `ai.marlstudio.com` | Hull's own harness (D14), an ACP agent running in the app's main process, calling the tools in `@hull/tools` directly. Later the same agent runs next to hosted projects. |

The agent panel looks the same for every ACP agent: streamed messages, plans, tool calls with diffs, and permission
requests that you approve or deny. Every change lands in the history with its author.

## 4. How it works, end to end

```
 you: "make X"            AI                                   you
 ───────────────►  writes src/ + config/
                   check   (types, schemas, refs)
                   test    (simulation, in Node)
                   play    (browser, screenshots)
                   bench   (sound levels, frame time)
                          │
                          ▼
                   pieces show as unreviewed  ──────────►  Hull Studio: bench each piece
                                                           approve / note / drag a slider
                          ▲                                        │
                          │        notes (review)  ◄──────────┤
                          │        your edits, in the files  ◄─────┘
                          │        every change in the history
                          ▼
                   build ──► dist/web/game.js ──► website
                   package ──► .app / .exe / AppImage
```

Three rules keep this loop honest:

1. **The AI does not call a piece done until it has looked at it**: a screenshot it read, a number it measured, a
   test that passed.
2. **The AI does not undo your edits.** The history knows which values you set. `check` reports any change
   that overwrites one, and the AI has to say why.
3. **You never need to open a source file.** If something can only be changed by reading code, that is a gap: the
   value becomes a tunable or moves into config.

## 5. History and experiments

Version control is part of Hull, not something you set up.

* **Every change is recorded** automatically: a Studio edit, an AI turn, a build. Each record has an author (you
  or the AI), a time, and a description in plain words produced by Hull's diff.
* **The diff understands the files.** JSON is compared by path ("`sound/sword/hit` level −6 → −3"), tunables by
  name ("`player.runSpeed` 12.5 → 14"), other code line by line. That is what the timeline shows and what a merge
  works on.
* **Checkpoints** are named points you can return to ("before the new camera").
* **Experiments** are parallel lines of work from any point. Each has its own working copy, so two can run side
  by side in two windows for comparison. **Adopt** makes one the main line; the others stay in the history, so
  nothing is lost by trying.
* **Merging** two experiments is by path: different values changed in the same file combine cleanly; a conflict
  is only the same value changed twice, and the Studio asks which one.
* **Git still works.** Hull's history lives in `.hull/` and does not touch your own `.git`. Commit, branch and
  push the project as usual; `.hull/` is ignored. `history export` writes experiments as git branches when
  you want them there.

`docs/ARCHITECTURE.md` section 7 says how this is stored.

## 6. Tech stack

Rows marked * are what Marl's other TypeScript games already build with; the rest get pinned at kickoff, after
checking the current release.

| Need | Choice | Why |
|---|---|---|
| Language | TypeScript, strict * for the engine and for games | The type checker is the cheapest reviewer of AI-written code; config ids are generated types, so a wrong id does not compile. |
| Package manager, dev server, bundler | pnpm *, Vite * | One config for the game, the Studio and library builds. |
| Rendering | three.js *: WebGL2 first, WebGPU second, behind one bridge | See 6.1. |
| Sound | Web Audio API, own engine | No dependency; recipes render offline for measurement. |
| UI | DOM + CSS, own small kit | Text, focus, accessibility and layout for free. |
| Schemas | TypeBox (the `typebox` package, 1.x; schemas are JSON Schema, types are inferred), Ajv to validate | One source for types, checks and forms. |
| History storage | git objects through isomorphic-git, in a private repository under `.hull/` | A proven store and merge base with no dependency on git being installed; Hull adds the diff that understands JSON and tunables. |
| Source edits | TypeScript 6's compiler API (`typescript@6`) | Rewrites one literal in place without touching the rest of the file. TypeScript 7 is a native compiler whose JavaScript API is still marked unstable, so tools parse with 6 while `check` type-checks with 7's `tsc`. |
| Rigid bodies (optional) | Rapier (WASM, inlined into the bundle) | Fast, deterministic; only loaded by games that ask for it. |
| Tests | Vitest in Node; Playwright with headless Chromium for the browser | Logic without a browser; screenshots with one pinned Chromium. |
| Studio | Electron * app; React + Vite inside | Its own window, direct file access, the same Chromium the games ship in. Only the Studio uses React. |
| Desktop shell for games | Electron * + electron-builder * by default; Tauri as an experimental option | See 6.2. |
| Marl AI backend | A separate service: an agent loop over Hull's tool list, a model list, usage metering | So a customer needs no agent of their own. Providers and models are chosen when it is built. |
| Agent control | A WebSocket control port in dev builds + an MCP server | The agent drives a running game: step, press, read state, screenshot. |

### 6.1 WebGL2 and WebGPU

| | WebGL2 | WebGPU |
|---|---|---|
| What it is | The browser's version of OpenGL ES 3.0, from 2017 | A new API over Metal, Vulkan and Direct3D 12 |
| Where it runs | Every current browser, every desktop web view, Electron | Chromium browsers and Electron; Safari and Firefox arrived later and unevenly, Linux last |
| Draw calls | Each one costs CPU time; a few thousand per frame is the practical ceiling | Much cheaper per call; many more objects before the CPU is the limit |
| Compute on the GPU | No | Yes: particles, skinning, culling, simulation on the GPU |
| Shader compile hitches | Compiles on first use unless warmed | Pipelines are built ahead of time, asynchronously |
| Shading language | GLSL | WGSL (in three.js, written through its node language, TSL) |
| What models write well | Classic three.js and GLSL: a great deal of training data | TSL and WGSL: much less, more mistakes |
| Headless testing | Stable | Needs flags; less settled |

**Decided: WebGL2 first, then WebGPU, behind one bridge so both work.**

* **The bridge** is Hull's own description of what to draw: materials, post effects, particles, instances,
  cameras. Games ask for those through config and Hull's API and never touch the renderer.
* **Two backends, one interface.** `webgl2` is built first, on three.js's WebGL renderer: it runs everywhere and
  is what an AI writes most reliably. `webgpu` is built second, on three.js's WebGPU renderer, and adds what only
  it can do (GPU particles in the hundreds of thousands, very large crowds, compute) as capabilities a game can
  ask for.
* **Chosen at start**: WebGPU where the device supports it, WebGL2 otherwise, with a fall back if one fails. That
  gives the best available path in each place: in a browser whatever it supports, and in the desktop shell
  WebGPU on Metal, Direct3D 12 or Vulkan.
* **Kept in step by tests**: golden images run on both backends.

Two things to check at kickoff, since this section is from memory: the current state of WebGPU in each browser,
and whether three.js's WebGPU renderer with its own WebGL2 fallback is solid enough to be the single path, which
would turn Hull's two backends into one.

### 6.2 Electron and Tauri

Electron ships its own Chromium, so a game behaves on all three systems exactly as it did in testing: WebGL, audio
timing, pointer lock, gamepads. The cost is size (about 100 MB per app). Tauri uses each system's built-in web
view, so an app is a few megabytes, but the game then runs on three different browser engines, and the Linux one
has been the weak one for WebGL games. Hull packages with Electron by default and offers
`package --shell tauri` as experimental for macOS and Windows, where the system web views are good.

## 7. Milestones

Each milestone ends with something you can run, and a check that proves it.

| | Delivers | Done when |
|---|---|---|
| **M0 Skeleton** | Repo, `core`, `config` (load, validate, typed access, tunables), `check`, `test`, `dev`, a spinning-cube template. | A scenario test steps the cube game 10,000 frames in Node in under a second and gets the same end state twice. A wrong config id fails `check` with file and field. |
| **M1 The app, first playable, first bench** | The Hull desktop app: launcher (new project from a template, open, recent), editor with the game running in it (play, pause, step), Library, Inspector writing to JSON and to tunables, sound bench, Build button. The project server inside the app. Engine: `render` basics behind the render bridge (WebGL2 backend), `input`, `audio` with recipes, `ui` basics, the build to one file. | You create an arena project in the app and play it there. You change a sound's pitch and a run speed with the Inspector, hear and see it at once, and the JSON file and the `.ts` literal have changed. Build writes `dist/web/game.js`, and it runs. |
| **M2 History and experiments** | The history store, the diff, checkpoints, experiments with their own working copies, compare, adopt, merge, authorship. | You start two experiments from one point, tune each differently, run them side by side, adopt one, and the other is still in the timeline. An AI change over a value you set is flagged by the check. All of it from the app's History panel. |
| **M3 Characters and the agent loop** | `anim` (generated rigs, clips, state graph, IK), character and animation benches, step scripts with screenshots and golden images, control port, MCP, review notes. | You scrub every animation of a character in the app and leave a note; an agent lists the note over MCP. A step script walks the character and its golden screenshot matches. |
| **M4 Desktop and the look** | `platform`, `package` for the three systems (Electron; Tauri experimental), the look (sky, fog, post), `vfx`, the settings and key-binding screens, saves. | The arena game installs and runs on macOS, Windows and Linux with saves, fullscreen and a gamepad. |
| **M5 Kits and templates** | The first kits (first-person and third-person controllers, follow camera, health, pickups, spawner, pause menu, save slots), three templates, the kit gallery. | A new project from the app plus one prompt gives a playable prototype built only from kits and config. |
| **M6 AOTT on Hull** | AOTT rebuilt on the engine, as the proof and the source of fixes. | It plays the same, its sounds and characters are all on benches, and its build is one file. |
| **M7 WebGPU** | The second render backend behind the bridge; capabilities (`compute`, GPU particles); golden images on both. | AOTT's golden screenshots match on both backends, the game picks the right one by itself on each system, and a bench with 200,000 particles holds 60 frames a second on WebGPU. |
| **M8 Hosted** | Hull Studio served from Marl's servers; projects held there; publish to a share link (section 8). | A customer with only a browser opens a project, tunes it, publishes it, and a second person plays it from the link without an account. No source reaches either machine. |
| **M9 Hull's agent** | The agent panel as an ACP client for every agent (Codex, Gemini CLI, Claude Code in a terminal pane, Hull's own); Hull's own harness (D14) with bring-your-own-key and Marl's gateway `ai.marlstudio.com` as providers; plans, approvals and diffs in the panel; usage shown per run. Can be built alongside M8. | You pick an agent in the app, ask for a change, approve its plan and its risky steps in the panel, and get a checked change in the history; the same request works through Codex, through Hull's own agent on your key, and on Marl credits. A Hull task suite (check plus game-state assertions) scores each agent and model. |

Later tracks, after these: AI-generated assets, and other 3D engines.

### Where each milestone stands (19 Nov 2026)

Checked means run and looked at: a state read back, a screenshot opened, a number measured. Sound was never heard
by the people who built it, only measured.

| | State | How it was checked | Known gaps |
|---|---|---|---|
| M0 | Done | Cube: 2 × 10,000 steps in 3.2 ms, same checksum; a wrong id fails the check with file and field (code and hull.json). | |
| M1 | Done | In the app (web mode) on the arena: run speed and a sound's pitch changed live with no reload, both files changed, Build wrote one `game.js` that runs. The Electron window opened once. | The app's main process runs through tsx; a packaged Studio needs it bundled. |
| M2 | Done | In the app: two experiments tuned apart, compared side by side, one adopted, the other kept; an AI change over yours flagged; a restore is a new change. | Authorship is per value for config and tunables only; the line diff says `+N −M lines`; each commit reads the whole project. |
| M3 | Done | Character bench (turntable, every clip, the live state graph, foot slide), review notes over MCP, a step script whose golden matches and fails on a changed run speed. MCP reaches every project method. | Bodies are rigid parts, not skinned; glTF clips are skipped; goldens come from a software GPU; the control port has step, press, state and screenshot only. |
| M4 | Done on macOS | Dusk look with environment light, snapped shadows, post chain, six effects; saves, settings, fullscreen; physics (1,000 rays on 5,000 boxes in ~1.2 ms, no tunnelling at 100 m/s); the cube packaged as a 244 MB `.app` that launched. | Windows and Linux packages untested; the settings and key screens tested on a fake DOM only; no cascaded shadows or SMAA. |
| M5 | Done | Kits (controllers, follow camera, health with hit zones, pickups, spawner, pause, save slots); the `fps` and `third-person` templates are ~20 lines each and play, save and load deterministically. A project tunes kit values in the Inspector; they are saved to `config/tuning/<block>.json` and survive a reload. | Experiments do not overlay kit values in the app; tuning files hold numbers only. |
| M6 | Done | AOTT runs as `examples/aott`: a seeded headless Holdout repeats its checksum; in the app the look (exposure) and a tunable (hook range) changed the running game with no reload; Build in the app wrote one 2.6 MB file that boots and plays Holdout from a static server. Sounds are 82 `sound` recipes, effects 21 `vfx` configs, looks 3 `look` configs, titans and soldier rigs `character` configs, collision on `hull/physics` (10,000-query parity), waves, depots and hit zones as kit tunables. | WebGL2 only (GLSL materials); nobody has heard the sounds or played it by hand; meshes, decals, slash arcs and the orbit camera stay in code; the 20 `code` sound recipes and the big titans are not yet shown on the Studio's benches (in progress). PORT.md lists the rest. |
| M7 | Done | `auto` picks WebGPU and falls back to WebGL2; the same scene matches across backends (PSNR 47.7 dB at medium); 200,000 GPU particles at 59 fps (720p). | Every build carries both backends (arena: 1.68 MB); GPU timestamps read wrong on Apple GPUs. |
| M8, M9 | Not started | | |

## 8. Hosted: how customers will use Hull

The decision: each game is its own repository. For customers the project lives on Marl's servers and **Marl holds
the code**. A game made on Hull is **free to play, and its maker can share it with as many people as they like**.
The model is FlutterFlow's: build in the hosted tool, publish freely, the source stays on the platform.

Two different things reach people, and they are served differently:

| | Making a game | Playing a shared game |
|---|---|---|
| Who | The customer, in Hull Studio in a browser | Anyone with the link, no account |
| What they get | The Studio's panels, a view of the game, Marl AI in a chat panel | A play page on Marl's hosting |
| What stays on the server | Source, config, history, experiments | Source, config, history, experiments |
| What it must cost Marl | A session per maker | Close to nothing per player, or "share with anyone" cannot be free |

What that asks of the design, from the first milestone:

* **The Studio talks to the project only through one protocol** (files, history, benches, review, run controls,
  over a WebSocket). Locally the other end is on the same machine. Hosted, it is a server. The Studio's interface
  does not change.
* **The game view is one component with several sources**: locally, the game running in the Studio's own window;
  hosted, either a video stream of the game running on a server, or a server-built bundle run in the maker's
  browser. Benches use the same component.
* **The game and the benches run in headless Chromium on Linux**, which they have to for testing anyway.
* **Nothing secret is in the Studio's front end.** Source, config and history stay server-side.
* **Publishing is one step on the server**: `build`, then the result goes to Marl's hosting under a share
  link. Publishing again replaces it.

**How a shared game reaches its players** decides the cost of the whole model. The plan assumes the built
`game.js` is served by Marl and runs in the player's browser. That costs almost nothing per player, so unlimited
sharing can be free, and there is no input lag. The bundle is minified and holds no source, config or history, but
it is the running game, and a determined person could copy the file. The alternative, streaming every player's
session as video, hides everything but needs a GPU for each person playing at the same moment, which does not fit
"free, shared with anyone". This is question Q1 in section 10.

To be measured by a spike before M8: the cost of a maker's session if the game view is streamed, the latency of
that stream for action games (target under about 80 ms from input to picture), and how sessions are isolated.

## 9. Decisions made

| # | Decision | Chosen |
|---|---|---|
| D1 | Name | **Hull**, by Marl Studio. The command is `hull`. |
| D2 | Language | TypeScript for the engine and for games. |
| D3 | Desktop shell | Electron by default; Tauri as an experimental option. |
| D4 | World model | Nodes with behaviours and signals; systems over plain arrays for anything that exists in the hundreds. |
| D5 | Where tuning lives | In the files themselves (JSON and code), with Hull keeping the diff and history, and git supported. |
| D6 | Graphics API | WebGL2 first, WebGPU second, behind one bridge so both work. |
| D7 | Studio | Its own desktop window. |
| D8 | Proving game | AOTT is rebuilt on Hull. |
| D9 | Where games live | Each game in its own repository. For customers: on Marl's servers, Marl holds the code, games are free to play and share. |
| D10 | Visibility | Private. |
| D11 | AI-generated assets | A later track. |
| D12 | Other 3D engines | A later track. |
| D13 | Who runs the AI | Three ways: any agent over MCP, an external agent inside the app over ACP, or Hull's own agent on the user's key or Marl's gateway (section 3.4). |
| D14 | Hull's own agent harness | Written for Hull in TypeScript, in the app's main process, as an ACP agent. OpenCode (MIT) is the reference: its compaction prompt, patch grammar, edit matching and per-model prompts may be copied with attribution in a notices file. Not a fork (it is mid-rewrite, about 300 commits a week) and not a white-labelled sidecar (its name and its own file tools are built in). Chosen 19 Nov 2026 for full control and so writes go through Hull's validated, authored edits. |
| D15 | Claude subscriptions | Hull never offers claude.ai login and never handles Claude credentials (Anthropic's terms). A user's own Claude Code runs unmodified in a terminal pane; the Agent-SDK-based Claude ACP adapter waits for Anthropic's written confirmation. The name shown is the product's own; "Claude Code" is not used in any Hull feature name. |
| D16 | Agent protocol | ACP between the app and every agent, including Hull's own. Hull-specific UI (an editable plan, approval cards with diffs) rides as ACP extensions. |

## 10. Still open

None of these blocks M0 to M7. Each has the assumption the plan is written on.

| # | Question | Assumed until you say otherwise |
|---|---|---|
| Q1 | How a shared game reaches players: the built file run in their browser, or a video stream | The built file, served by Marl. It is what makes free, unlimited sharing affordable; the cost is that the minified file can be copied. |
| Q2 | How a maker sees the game in the hosted Studio | You said streamed. Since the share link serves the same build anyway, a server-built bundle run in the maker's browser would be far cheaper and have no lag. Both are kept as sources of the game view; the spike before M8 picks the default. |
| Q3 | Whether a customer can ever take their code out | Held by Marl by default; export is a paid step (your earlier answer). |
| Q4 | What "support for other 3D engines" means | Not designed yet: either exporting a Hull game to another engine, or Hull's tools and Studio driving one. |
| Q5 | Which models Hull's agent offers on Marl credits | `ai.marlstudio.com` is Marl's own gateway (built separately by the owner), priced by Marl; the list is chosen there. Hull treats it as one OpenAI-compatible provider. |

## 11. Risks

| Risk | What I would do about it |
|---|---|
| "One file" grows large once a game uses models, textures or recordings. | Generated content stays the default and inlines to almost nothing. Today the build inlines every asset into `game.js` and prints its size; writing binary assets beside the file, and acting on `targets.web.singleFile` and `budgets`, are not built yet. |
| JSON cannot express every sound or animation. | Recipes cover the common cases; anything else is a code generator with a schema'd block of knobs, so it still gets a bench and sliders. |
| Rewriting source from the Studio corrupts a file. | Only literals inside a `tunables` block are ever rewritten, by position from the compiler's own parse, and the file is re-parsed and type-checked before the write is kept. |
| The AI and you edit the same value. | Authorship in the history; `check` flags an overwrite; a merge asks. |
| Experiments multiply and confuse. | The Studio shows them as a short list with what differs from the main line in plain words, and offers to archive old ones. |
| Streaming costs or latency make the hosted Studio poor for action games. | The spike before M8 decides. The other source of the game view, a server-built bundle run in the browser, has neither problem. |
| A shared game's file is copied and rehosted. | It holds no source, config or history, so it cannot be edited or rebuilt. If that is still too much exposure, shared games are streamed, at a GPU per player. |
| Two renderers drift apart or double the work. | Games reach both only through the bridge; golden images run on both; an effect one backend lacks fails `check`. |
| Determinism is easy to break by accident. | A lint rule bans `Math.random`, `Date.now` and `setTimeout` in game code; a test replays a recorded run and compares state. |
