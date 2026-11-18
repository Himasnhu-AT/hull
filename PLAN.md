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

### 3.3 Tools: the command line and Hull Studio

One command, `hull`, made to be run by an agent. Every command prints errors as `file:line: message` and can
print JSON.

| Command | Does |
|---|---|
| `hull new <name> --template <t>` | A new game from a template. |
| `hull dev` | The game in a browser with live reload of code and config. |
| `hull studio` | Opens Hull Studio on the project. |
| `hull check` | Types, config against schemas, references between config and code, house rules. |
| `hull test` | Scenario tests of the simulation in Node. |
| `hull play <steps.json>` | Runs the real game in a headless browser through a script of inputs, waits and checks; saves screenshots. |
| `hull bench sound\|perf` | Renders every sound offline and measures it; runs frame-time budgets. |
| `hull history`, `hull exp` | Lists changes, makes checkpoints, starts, compares and adopts experiments. |
| `hull review` | Lists your notes for the AI. |
| `hull build` | `dist/web/game.js` + `index.html`. |
| `hull package --mac --win --linux` | Desktop apps from the same build (Electron; `--shell tauri` is experimental). |
| `hull mcp` | The same controls as tools an agent can call while the game runs. |

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
| A local agent | You: Claude Code, Codex or any coding agent in a terminal | The `hull` command line |
| MCP | Any MCP client | `hull mcp` |
| Marl AI | Marl's backend, with the models Marl offers | Marl's API: the backend runs the agent loop and calls the same tools on the project |

Marl AI is what a customer of the hosted Studio uses by default, from a chat panel in the Studio. Locally all
three work: the chat panel can call Marl's API, or you keep driving from your own terminal.

## 4. How it works, end to end

```
 you: "make X"            AI                                   you
 ───────────────►  writes src/ + config/
                   hull check   (types, schemas, refs)
                   hull test    (simulation, in Node)
                   hull play    (browser, screenshots)
                   hull bench   (sound levels, frame time)
                          │
                          ▼
                   pieces show as unreviewed  ──────────►  Hull Studio: bench each piece
                                                           approve / note / drag a slider
                          ▲                                        │
                          │        notes (hull review)  ◄──────────┤
                          │        your edits, in the files  ◄─────┘
                          │        every change in the history
                          ▼
                   hull build ──► dist/web/game.js ──► website
                   hull package ──► .app / .exe / AppImage
```

Three rules keep this loop honest:

1. **The AI does not call a piece done until it has looked at it**: a screenshot it read, a number it measured, a
   test that passed.
2. **The AI does not undo your edits.** The history knows which values you set. `hull check` reports any change
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
  push the project as usual; `.hull/` is ignored. `hull history export` writes experiments as git branches when
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
| Source edits | TypeScript 6's compiler API (`typescript@6`) | Rewrites one literal in place without touching the rest of the file. TypeScript 7 is a native compiler whose JavaScript API is still marked unstable, so tools parse with 6 while `hull check` type-checks with 7's `tsc`. |
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
`hull package --shell tauri` as experimental for macOS and Windows, where the system web views are good.

## 7. Milestones

Each milestone ends with something you can run, and a check that proves it.

| | Delivers | Done when |
|---|---|---|
| **M0 Skeleton** | Repo, `core`, `config` (load, validate, typed access, tunables), `hull check`, `hull test`, `hull dev`, a spinning-cube template. | A scenario test steps the cube game 10,000 frames in Node in under a second and gets the same end state twice. A wrong config id fails `hull check` with file and field. |
| **M1 First playable + first bench** | `render` basics behind the render bridge (WebGL2 backend), `input`, `audio` with recipes, `ui` basics, `hull build` to one file, Hull Studio with Library, sound bench and inspector writing to JSON and to tunables. | A small arena game runs from `dist/web/game.js`. In the Studio you change a sound's pitch and a run speed with sliders, hear and see it at once, and the JSON file and the `.ts` literal have changed. |
| **M2 History and experiments** | The history store, the diff, checkpoints, experiments with their own working copies, compare, adopt, merge, authorship. | You start two experiments from one point, tune each differently, run them side by side, adopt one, and the other is still in the timeline. An AI change over a value you set is flagged by `hull check`. |
| **M3 Characters and the agent loop** | `anim` (generated rigs, clips, state graph, IK), character and animation benches, `hull play` with screenshots and golden images, control port, MCP, review notes. | You scrub every animation of a character and leave a note; the AI lists the note from the command line. A step script walks the character and its golden screenshot matches. |
| **M4 Desktop and the look** | `platform`, `hull package` for the three systems (Electron; Tauri experimental), the look (sky, fog, post), `vfx`, the settings and key-binding screens, saves. | The arena game installs and runs on macOS, Windows and Linux with saves, fullscreen and a gamepad. |
| **M5 Kits and templates** | The first kits (first-person and third-person controllers, follow camera, health, pickups, spawner, pause menu, save slots), three templates, the kit gallery. | `hull new` plus one prompt gives a playable prototype built only from kits and config. |
| **M6 AOTT on Hull** | AOTT rebuilt on the engine, as the proof and the source of fixes. | It plays the same, its sounds and characters are all on benches, and its build is one file. |
| **M7 WebGPU** | The second render backend behind the bridge; capabilities (`compute`, GPU particles); golden images on both. | AOTT's golden screenshots match on both backends, the game picks the right one by itself on each system, and a bench with 200,000 particles holds 60 frames a second on WebGPU. |
| **M8 Hosted** | Hull Studio served from Marl's servers; projects held there; publish to a share link (section 8). | A customer with only a browser opens a project, tunes it, publishes it, and a second person plays it from the link without an account. No source reaches either machine. |
| **M9 Marl AI** | The AI backend: an agent loop over Hull's tools, a model list, metering, the Studio's chat panel (section 3.4). Can be built alongside M8. | A customer with no agent of their own types a request in the Studio and gets a checked change in the history, made by a model they picked. |

Later tracks, after these: AI-generated assets, and other 3D engines.

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
* **Publishing is one step on the server**: `hull build`, then the result goes to Marl's hosting under a share
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
| D13 | Who runs the AI | Three ways: a local agent through the command line, any MCP client, or Marl AI through Marl's API and models. |

## 10. Still open

None of these blocks M0 to M7. Each has the assumption the plan is written on.

| # | Question | Assumed until you say otherwise |
|---|---|---|
| Q1 | How a shared game reaches players: the built file run in their browser, or a video stream | The built file, served by Marl. It is what makes free, unlimited sharing affordable; the cost is that the minified file can be copied. |
| Q2 | How a maker sees the game in the hosted Studio | You said streamed. Since the share link serves the same build anyway, a server-built bundle run in the maker's browser would be far cheaper and have no lag. Both are kept as sources of the game view; the spike before M8 picks the default. |
| Q3 | Whether a customer can ever take their code out | Held by Marl by default; export is a paid step (your earlier answer). |
| Q4 | What "support for other 3D engines" means | Not designed yet: either exporting a Hull game to another engine, or Hull's tools and Studio driving one. |
| Q5 | Which providers and models Marl AI offers | Chosen when the backend is built. |

## 11. Risks

| Risk | What I would do about it |
|---|---|
| "One file" grows large once a game uses models, textures or recordings. | Generated content stays the default and inlines to almost nothing. Binary assets go beside the file by default, with `--single-file` to embed them. The build prints a size report against a budget. |
| JSON cannot express every sound or animation. | Recipes cover the common cases; anything else is a code generator with a schema'd block of knobs, so it still gets a bench and sliders. |
| Rewriting source from the Studio corrupts a file. | Only literals inside a `tunables` block are ever rewritten, by position from the compiler's own parse, and the file is re-parsed and type-checked before the write is kept. |
| The AI and you edit the same value. | Authorship in the history; `hull check` flags an overwrite; a merge asks. |
| Experiments multiply and confuse. | The Studio shows them as a short list with what differs from the main line in plain words, and offers to archive old ones. |
| Streaming costs or latency make the hosted Studio poor for action games. | The spike before M8 decides. The other source of the game view, a server-built bundle run in the browser, has neither problem. |
| A shared game's file is copied and rehosted. | It holds no source, config or history, so it cannot be edited or rebuilt. If that is still too much exposure, shared games are streamed, at a GPU per player. |
| Two renderers drift apart or double the work. | Games reach both only through the bridge; golden images run on both; an effect one backend lacks fails `hull check`. |
| Determinism is easy to break by accident. | A lint rule bans `Math.random`, `Date.now` and `setTimeout` in game code; a test replays a recorded run and compares state. |
