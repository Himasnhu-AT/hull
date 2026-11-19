# Architecture

How each part of Hull is built. `PLAN.md` says what and why; this says how. Config file formats are in
`SCHEMAS.md`.

## 1. Repository layout

One repository, three packages (pnpm workspace). The runtime is one package so imports stay obvious
(`from 'hull'`, `from 'hull/audio'`) and the bundler drops what a game does not use.

```
hull/
  packages/
    hull/                the runtime (what a game imports)
      src/
        core/            loop, world, timers, random, events                               (no browser APIs)
        config/          registry, loader, live updates, tunables                          (no browser APIs)
        schema/          every config kind as a TypeBox schema; emits schemas/*.schema.json
        render/          the render bridge; backend/webgl2 and backend/webgpu behind it
        audio/           Web Audio engine
        anim/            skeletons, clips, graphs, IK
        ui/              DOM UI kit
        input/           devices to actions
        physics/         swept collision; optional rigid bodies
        platform/        browser and desktop shell differences
        kits/            reusable gameplay pieces
        dev/             control API, benches, scenario runner, golden images, budgets (not in ship builds)
    tools/               @hull/tools: every tool, defined once; the app, MCP and Marl AI call them (no command line)
      src/tools/         the tool list (typed function + JSON Schema each)
      src/mcp/           the MCP server library: stdio and streamable HTTP
      src/server/        the project server the Studio talks to
      src/history/       the history store, the diff, experiments, merge
      src/edit/          writes to JSON and to TypeScript literals
      bin/hull-mcp.js    stdio launcher, MCP only
    studio/              Hull Studio (Electron app, React inside)
  schemas/               generated JSON Schema files
  templates/             starting points for the `new` tool
  shell/                 desktop shells for games: electron/ (default), tauri/ (experimental)
  examples/              small games used as tests of the engine itself
  docs/
```

A game is its own repository and holds two things:

```
mygame/
  hull.json        the manifest: title, entry, targets, budgets
  src/             TypeScript: logic, tunables, tests
  config/          JSON: sound/ character/ anim/ ui/ look/ vfx/ level/ ...
  assets/          only if the game uses binary files (models, images, recordings)
  .hull/           Hull's own: history, experiments, review notes, generated types (hidden, git-ignored)
  dist/            build output (git-ignored)
```

Rules between the engine's folders:

* `core` and `config` must run in Node: no `window`, `document`, `AudioContext` or WebGL. A lint rule and a test
  that imports them in Node enforce it.
* Nothing imports `dev/` except through one guarded entry, so a ship build contains none of it.
* `studio/` talks to a project only through the project server's protocol (section 8). It never reads the disk
  itself. That is what lets the same Studio run against a remote project later.

## 2. The loop and time

```
frame(realDt):
  scaled = realDt * timeScale            (0 while paused; slow motion; a single step in dev)
  accumulator += scaled
  input.sample()                         once per frame
  while accumulator >= STEP:             STEP = 1/60 s by default, set in the game manifest
    world.fixedUpdate(STEP)              all gameplay state changes happen here
    accumulator -= STEP
  world.update(scaled, alpha)            alpha = accumulator / STEP, for drawing between steps
  render, audio, ui                      read state, never change gameplay state
```

* **Game time** is `world.time`, advanced only by fixed steps. Timers are `world.after(seconds, fn)` and
  `world.every(seconds, fn)`; tweens run on the same clock. `setTimeout`, `Date.now` and `performance.now` are
  not allowed in game code.
* **Random** is `world.random('name')`: a seeded stream per name, so adding a new use does not shift the others.
  `Math.random` is not allowed in game code. Cosmetic randomness uses a `cosmetic` stream that is left out of the
  state checksum.
* **Stepping from outside**: `game.step(n)` runs exactly `n` fixed steps with no real time involved. Tests, the
  control port and the Studio's single-step button all use it.
* **State checksum**: `world.checksum()` hashes the gameplay state. The determinism test runs a recording twice
  and compares checksums every second.

## 3. The world

**Decided: nodes with behaviours and signals.** The comparison with a strict entity-component-system (ECS) is
kept here as the record of why.

### What each looks like

Nodes with behaviours:

```ts
const health = tunables('health', { max: num(100, { min: 1, max: 500 }) });

class Health extends Behaviour {
  hp = 0;
  died = signal();
  ready() { this.hp = health.max; }
  damage(n: number) { this.hp -= n; if (this.hp <= 0) this.died.emit(); }
}
enemy.add(Health).died.connect(() => score.add(100));
```

Strict ECS:

```ts
const Health = component({ hp: f32, max: f32 });
const Dead = tag();
system('damage', query(Health, DamageEvent), (e, h, d) => {
  h.hp -= d.amount;
  if (h.hp <= 0) world.add(e, Dead);
});
system('score', query(added(Dead), Enemy), () => score.add(100));
```

### Pros and cons

| | Nodes with behaviours and signals | Strict ECS |
|---|---|---|
| How well models write it | Very well. It is the shape of Unity and Godot scripts, which is most of what models have seen. | Less well. Fewer examples; models tend to drift back to objects and mix the two styles. |
| Reading one thing's logic | In one place: the behaviour class. | Spread over several systems; you follow a component through them. |
| Logic across many things | Needs a system or manager on top; easy to end up with objects reaching into each other. | Natural: a system over a query is the model. |
| Order of execution | Per-node lifecycle plus named systems; some order is implicit. | Explicit: systems run in a declared order, nothing else runs. |
| Determinism and replay | Good if the rules are followed; state lives in class fields that must be marked. | Easier: all state is plain component data, so checksum, save and replay are mechanical. |
| Save games | Each behaviour says what to save. | The world serialises itself. |
| Performance with thousands of things | Fine to a few thousand; beyond that, per-object calls and scattered memory cost frames. Hull routes crowds through instancing and plain systems anyway. | Strong: tightly packed arrays, cheap iteration, easy to move to workers. |
| Showing one piece on a bench | Natural: spawn the node and its behaviours. | Fine, but a piece's behaviour is the systems that happen to match it, so the bench must run the right ones. |
| Tuning and the inspector | A behaviour owns its tuning block; the Studio can show "this enemy's settings" as one form. | Components are the forms; equally good. |
| Fit with three.js | Direct: a node is an `Object3D`, the scene graph is the world. | Needs a sync step between component data and the scene graph. |
| Hierarchies (a blade in a hand on an arm) | Native. | Awkward: parent links are components and transforms need a propagation system. |
| Kits a model can compose | "Add this behaviour, connect its signal" is one line. | "Add these components and enable these systems"; more to get wrong. |
| Cost of being wrong later | Moving a hot path to data-oriented code is local work. | Moving off ECS is a rewrite. |

### Decision

Nodes with behaviours and signals, **with systems and plain data arrays as the sanctioned way to handle anything
that exists in the hundreds** (crowds, projectiles, particles, debris). That takes the first model's strengths for
the AI and for benches, and borrows the second's where it matters, which is bulk. A strict ECS is the better
choice only if Hull's main games will simulate tens of thousands of active things, or if lock-step networking
becomes a first-version goal.

### The model as planned

* **Node**: a thing in the scene. It wraps a three.js `Object3D` for its transform and parent/child links, so the
  scene graph is the render graph. In Node tests the same objects exist; only the renderer is missing.
* **Behaviour**: a class attached to a node. Lifecycle: `ready()`, `fixedUpdate(dt)`, `update(dt, alpha)`,
  `dispose()`. A behaviour with no `fixedUpdate` costs nothing per step. Fields that are gameplay state are
  declared with `state()` so the checksum and saves find them.
* **Signal**: a typed event a behaviour exposes (`died = signal<[by: Node]>()`), connected with
  `other.died.connect(fn)`. Connections end with the node.
* **Group**: a named set (`node.addTo('enemies')`, `world.group('enemies')`), kept as an array for fast loops.
* **System**: logic over many nodes or over plain arrays, registered once:
  `world.system('waves', { fixedUpdate(dt) { ... } })`. Order is the order in the manifest.
* **Events**: `world.events.emit('gate:breached', payload)` for things with no single owner. Every event name is
  declared with its payload type in one file, so a typo does not compile.
* **Prefab**: a config file that says "a node with these children, these behaviours, these values".

Rules built into the model:

* No allocation in `fixedUpdate` or `update`: pooled scratch vectors are provided, and a dev-build counter fails a
  budget test when allocations per frame rise.
* Many identical things go through `render.instances(...)` and a system, not one node each.

## 4. Config and tunables

### Config files

```
config/**/*.json  ──►  validate (schema)  ──►  resolve references  ──►  registry  ──►  typed values in code
                            │                        │
                      file + field +           "sound/x not found,
                      reason on failure        used by prefab/y"
```

* The id of a file is its path under `config/` without the extension: `config/sound/sword/hit.json` is
  `sound/sword/hit`. The first folder is the kind, repeated in the file's `kind` field.
* Files carry no `$schema` line. `check` and the Studio know the schema from the kind, and Hull writes the
  editor mapping (`.vscode/settings.json`) so autocomplete works.
* A reference is a string id in a field the schema marks as a reference (`x-ref: "sound"`). `check` resolves
  every one, in config and in code.
* **Typed access**: `check` and `dev` write `.hull/gen/ids.ts`, a list of every id per kind. So
  `config.sound('sword/hit')` autocompletes and a missing id is a compile error.
* **In dev**, files are loaded and validated at start, and the project server pushes changes: the registry
  replaces the value and calls the subscribers, so a slider in the Studio is heard or seen on the next frame.
* **In a build**, config is validated, stripped of defaults and inlined into the bundle. The shipped game has no
  validator and reads no files.

### Tunables: values that live in code

```ts
// src/player/tuning.ts
import { tunables, num, bool, color } from 'hull';

export const player = tunables('player', {
  runSpeed:   num(12.5, { min: 0, max: 30, unit: 'm/s' }),
  jumpHeight: num(2.2,  { min: 0.5, max: 8, unit: 'm', step: 0.1 }),
  coyote:     num(0.12, { min: 0, max: 0.4, unit: 's', step: 0.01 }),
  doubleJump: bool(false),
  trail:      color('#f0a43a'),
});

// anywhere: player.runSpeed is always the current value
```

* A `tunables` block is the code twin of a `tuning` config file: same widgets, same bench (the running game),
  same history.
* **Live**: the object's properties are getters over a cell the dev runtime can set. The Studio sends
  `set player.runSpeed 14`; the next frame uses it. No reload.
* **Written back**: the project server finds the literal with the TypeScript compiler's parse of that file,
  replaces exactly those characters, re-parses and type-checks the file, and only then keeps the write. Only
  literals that are direct arguments of `num`, `bool`, `color`, `vec`, `choice`, `range` and `curve` inside a
  `tunables` call are ever rewritten.
* **Kit blocks** are declared in engine source, which a project must never rewrite (it would change every game).
  A block takes its values from `config/tuning/<block>.json` (block name in kebab case: `thirdPerson` is
  `third-person.json`) when that file exists; keys the file lacks keep the code value, a value the tunable's options
  refuse is a problem at `file#/key` and the code value stays. The override is applied on load and on each live
  change of the file, never per frame. The server finds a game's kit blocks by reading which names it imports from
  `hull/kits` (and the kits those import), so it works with no game running; `tunables.list` marks them
  `source: 'kit'`, and `tunables.set` on one writes only that key into the file (a value equal to the kit's own
  removes the key). Tuning files hold numbers, so only `num` kit tunables can be saved this way.
* **In a build**, a project's own block compiles to constants; kit blocks stay live cells (with the file's values).
* When to use which: values that belong to one piece of code and nobody else reads go in `tunables`; things with
  structure, or shared between code and tools (a sound, a character, a screen), are config files.

### Code-backed config

When JSON cannot describe something (a complex synthesised sound, a generated creature), the config file names a
generator registered in code and carries its knobs. It still appears in the Library, on a bench, with sliders.

## 5. Modules

### render

* **The render bridge.** Games never touch the renderer. They ask for materials, post effects, particles,
  instances and cameras through Hull's API and config; that description is the bridge. Behind it sit two backends
  with one interface:
  * `backend/webgl2`, built first, on three.js's WebGL renderer.
  * `backend/webgpu`, built second, on three.js's WebGPU renderer. What only it can do (GPU particles,
    compute-driven crowds) is a capability a game asks for: `render.can('compute')`.
* **Chosen at start**: WebGPU where the device supports it and the manifest allows it, WebGL2 otherwise. If one
  fails to start, the other is tried. In the desktop shell WebGPU runs on Metal, Direct3D 12 or Vulkan, which is
  the native fast path.
* **Custom effects** are written once in a form both backends accept (three.js's node language where it serves
  both; otherwise a pair of shaders registered under one name). `check` fails on an effect only one backend
  has.
* **Golden images run on both backends** with a small tolerance, so they cannot drift apart unnoticed.
* To settle at kickoff, by a spike: whether three.js's WebGPU renderer with its own WebGL2 fallback is solid
  enough to be the single path, which would make the two backends one.
* Owns resizing, quality levels (render scale, shadows, post on or off) and a governor that
  steps quality down when frames run long.
* **Look** (`look` config): sun, sky, fog, exposure, tone mapping, post chain (bloom, grade, vignette, speed blur).
* **Materials** (`material` config): PBR values, generated textures by recipe, or image files. Games do not write
  raw shaders; they ask for a material or a post effect, so the renderer underneath can change (WebGPU later).
* **Mesh builder**: geometry made in code (boxes, tubes, lathes, extrusions, merged by material).
* **Cameras**: follow, orbit, first-person and a cutscene director (set shots, letterbox), driven by config.
* **VFX** (`vfx` config): pooled particle emitters and decals with budgets.
* **Debug draw**: lines, shapes and labels for dev builds and benches.
* Rendering never changes gameplay state. It reads node transforms, interpolated by `alpha`.

### audio

```
sound (recipe or sample) ─► voice ─► bus (sfx / ui / voice / music ...) ─► master: compressor ─► limiter ─► out
                                        └─ send ─► reverb
```

* A **recipe** is a small graph: sources (oscillator, noise, sample), shapers (filter, envelope, gain, drive,
  delay), and random ranges per play.
* **Limits per sound**: minimum gap, maximum voices, what to do when over.
* **Buses and snapshots** (`mixer` config): levels, ducking rules, named snapshots the game switches between.
* **Music** (`music` config): layers on a shared clock with an intensity value the game sets.
* **3D**: a listener on the camera; distance roll-off, pan and a low-pass with distance.
* **Offline**: the same graph renders into an `OfflineAudioContext`, so what is measured is what plays.
* Every call is safe before the first user gesture and when audio is unavailable.

### anim

* A **skeleton** is a tree of named joints. A body is generated (a recipe of segments and proportions) or loaded
  from glTF.
* A **clip** is keyframes (JSON tracks), a glTF clip, or generated (a function of time with a schema'd block of
  knobs: stride length, arm swing, lean).
* An **anim graph** has parameters, states that play a clip or a blend, transitions with conditions and blend
  times, layers, and IK targets.
* **Events** on a clip's timeline (`footstep`, `hit-frame`) are signals.
* Everything advances on game time.

### ui

* DOM over the canvas. **Tokens** (`ui-theme`) are CSS variables.
* **Components** are small functions that make DOM (button, bar, list, keycap, panel, toast, dialog).
* A **screen** (`ui-screen`) is a tree of components with bindings to a view-model the game exposes, and named
  actions. The UI reads the view-model once per frame and writes only what changed.
* Focus moves by keyboard and gamepad on every screen.
* The settings and key-binding screens are generated from the settings schema and the input map.

### input

* Devices map to **actions** (`input-map`). Code reads actions, never keys.
* Input is sampled once per frame; edges last exactly one fixed step.
* In tests, over the control port and in hosted play, actions are set directly.

### physics

* Built in: a swept sphere or capsule against boxes, cylinders, capsules, spheres and a height field in a uniform
  grid. Nothing tunnels at speed.
* Optional: rigid bodies through an adapter, loaded only by games that ask for it.

### platform

One interface, chosen at build time.

| | Browser | Desktop shell |
|---|---|---|
| Saves | IndexedDB | Files in the user's app-data folder |
| Settings | localStorage | A JSON file |
| Window | Fullscreen API | Window size, fullscreen, display choice |
| Quit | (none) | Closes the app |

Saves are versioned JSON with migrations.

### kits

A kit is a folder: behaviours, their tunables, default config, a bench scene, a test and a short README. The game
composes kits and talks to them only through their signals, public methods and tuning.

## 6. Build and output

```
src/ + config/ + hull  ──►  build
   1. check (types, schemas, references, rules)
   2. inline config (defaults stripped) and tunables (as constants)
   3. bundle the game and the engine modules it uses; drop dev/; minify
   4. write dist/web/game.js, index.html, assets/ (if any), build.json (sizes, hashes)
```

* `game.js` is one ES module with no imports. It exports `start(element, options)` and starts itself when loaded
  by the generated `index.html`.
* Binary assets are copied to `assets/` with hashed names; `--single-file` embeds them instead.
* `build.json` lists what took the space, so the AI can act on a size budget.

**Desktop**: `package` copies `dist/web` into a shell.

* `shell/electron` (default): one window, the game served from a private scheme, a preload exposing only the
  `platform` interface. Targets: macOS (`dmg`, `zip`; arm64 and x64), Windows (`nsis`, portable), Linux
  (`AppImage`, `deb`).
* `shell/tauri` (experimental, `--shell tauri`): the same `platform` interface over Tauri commands. Offered for
  macOS and Windows. A check in `package` runs the game's own step script inside the built app, because the
  web view is not the Chromium the game was tested in.
* Signing and notarisation are configured in the manifest and done in CI on each system.

## 7. History and experiments

### What is stored

Hull keeps a private git repository at `.hull/history/` whose work tree is the project (`src/`, `config/`,
`assets/`, `hull.json`). It is written through isomorphic-git, so no git install is needed, and it is separate
from any `.git` the project has. `.hull/` is in the project's `.gitignore`.

* A **change** is a commit there, made automatically: after a burst of Studio edits (about two seconds of quiet),
  after each AI turn that passes `check`, and before anything destructive. Its message is generated:
  author (`you` or `ai`), and the plain-words diff.
* A **checkpoint** is a tag.
* An **experiment** is a branch with its own working copy under `.hull/exp/<name>/`, so two experiments can be
  open and running at the same moment. The main line's working copy is the project folder itself.

### The diff

Git stores and merges lines. Hull adds a layer that understands the files, used for what is shown and for merges:

| File | Compared by | Shown as |
|---|---|---|
| `config/**/*.json` | JSON path | `sound/sword/hit: level −6 → −3` |
| `tunables` blocks in `.ts` | Tunable name | `player.runSpeed: 12.5 → 14` |
| Other source | Lines, grouped by function or class | `src/player/grapple.ts: reelIn() changed (+12 −4)` |
| `assets/` | Content hash | `assets/rock.glb replaced (1.2 MB → 0.9 MB)` |

**Authorship per value**: because config and tunables are compared by path, Hull knows who last set each value.
`check` lists AI changes that overwrite a value you set.

### Operations

| | Tool | In the Studio |
|---|---|---|
| See what changed | `history.list` | Timeline |
| Name this point | `history.checkpoint {name: "before new camera"}` | Checkpoint button |
| Go back | `history.restore {id}` (itself a new change, so it can be undone) | Restore |
| Try something | `exp.start {name: "heavier-jump"}` | New experiment |
| Compare | `exp.compare {a, b}` | Two game views side by side, differences listed |
| Keep it | `exp.adopt {name: "heavier-jump"}` | Adopt |
| Combine two | `exp.adopt` into the other line | Merge; asks only when both changed the same value |
| To git | `history.export` | (tool only) |

Merges work by path for config and tunables (three-way: base, ours, theirs) and fall back to git's line merge for
other code.

## 8. Hull Studio and the project server

```
Hull Studio (Electron window)          project server (inside the app)             the project
  Library, Inspector, History,  ◄─ WebSocket ─►  files: read, write JSON, rewrite tunables  ◄──►  src/ config/
  Review, Play                                    history: changes, experiments, diff              .hull/
  GameView  ◄──── local: a web view of the dev game with a bench loaded
            ◄──── hosted: a video stream + input channel
```

* **Benches** are part of the runtime (`hull/dev/benches`): a function that, given one id, builds the smallest
  scene that shows it and returns the controls it offers. The Studio hosts benches; it does not know how to draw
  a character itself. A game can register benches for its own kinds.
* The **Inspector** renders a form from the JSON Schema and its `x-ui` hints, or from a `tunables` block. Editing a
  field sends one `set` to the project server, which writes the file and pushes the new value to the running game.
* **Review** state per id (`unreviewed`, `approved`, `needs-change`, a note, the content hash) lives in
  `.hull/review.json`. When a piece changes, its state returns to `unreviewed`.
* **Measurements** come from the same tool code the MCP server calls, so the Studio and the AI see the same numbers.
* **Hosted** (PLAN section 8): the project server runs on Marl's machines and holds the code; the Studio's front
  end is served to the customer's browser; `GameView` switches to a remote source (a video stream, or a
  server-built bundle run in the browser). The protocol and the panels are the same. A chat panel talks to
  Marl AI. Publishing builds on the server and puts the result on Marl's hosting under a share link.

## 9. Tools for the agent

Every tool is defined once, in `packages/tools/src/tools/` (`@hull/tools`), as a typed function with a JSON Schema for
its input. There is no command line: the app is the product, so one front less to keep. Three fronts expose the list:

| Front | For | Notes |
|---|---|---|
| The Hull desktop app | The person | Calls the tool functions directly. |
| MCP | A local agent (Claude Code, Codex, any MCP client) | `createMcpServer(projectRoot)` in `@hull/tools`. The app hosts it over streamable HTTP on 127.0.0.1 for the open project and shows how to connect; `bin/hull-mcp.js` serves it over stdio when the app is closed. |
| Marl AI | Customers of the hosted Studio, and the Studio's chat panel | A separate backend service. It runs the agent loop with a model from Marl's list, calls the tools on the project server, streams text and changes back, and meters usage. One turn ends as one change in the history. |

The author of a change records the front and the model (`you`, `ai:local`, `ai:mcp`, `ai:marl/<model>`), so the
timeline shows who and what made it. Marl AI holds the provider keys: none is ever in a project or in the Studio's
front end. Its providers and models are chosen when it is built, from their documentation at that time.

What the tools give an agent:

* **Errors are located.** `path:line:col: message` for code, `path#/json/pointer: message` for config, and
  every tool returns the same problems as data.
* **Scenario tests** (Node): `const game = await testGame(); game.press('jump'); game.step(30);
  expect(game.find('player').position.y).toBeGreaterThan(1)`.
* **Step scripts** (browser): a JSON list of `press`, `step`, `waitUntil`, `expect`, `shot`. A `shot` with a golden
  image fails on a perceptual difference and writes the diff.
* **Control port**: in a dev build the game listens on a local WebSocket: `step`, `press`, `release`, `state`,
  `set`, `spawn`, `teleport`, `shot`, `errors`, `perf`. The MCP server exposes the same list as MCP tools.
* **As built (M3).** The control port is the project server's `game.run` method: the server sends `game.rpc` to a
  connected game and the game answers `game.result` (`dev/protocol.ts`, `dev/runtime.ts`). Ops so far: `step`, `press`,
  `release`, `state`, `screenshot`. A page opened with `?hull-paused&hull-client=<id>` starts frozen at tick 0 and
  can be aimed at by id, so a script starts from the same state every time. The `play` tool takes a JSON script of
  `step`, `press`, `release`, `hold`, `read`, `check` and `screenshot` steps, runs it in a headless browser
  (agent-browser) and compares each screenshot with `tests/golden/<name>.png` per channel and per pixel (default: 8
  of 255 per channel, 0 pixels allowed). A missing golden is written; the `update` input rewrites them; a mismatch stops the
  script and leaves `.hull/play/<name>.actual.png` and `.diff.png`. The MCP server speaks JSON-RPC (initialize, tools/list, tools/call) over stdio (newline-delimited) and over
  streamable HTTP, and serves the registry without `dev` and `new`. Not yet: `set`, `spawn`, `teleport`, `errors`,
  `perf`, `waitUntil` and perceptual (not per-pixel) compare. The project methods (`config.set`, `history.*`, `game.run`)
  are MCP tools too.
* **Budgets**: a test can assert frame time at the 95th percentile, draw calls, node count and allocations per
  frame.
* **Sound bench**: peak, loudness, length, spectral centre per sound; a rule file states the expected order and
  fails when it is broken.

## 10. Rules the engine enforces

| Rule | How |
|---|---|
| No wall clock or unseeded random in game code | Lint rule; the engine's versions are the only ones exported |
| `core` and `config` run without a browser | Import test in Node |
| Config matches its schema; references resolve | `check` |
| A write from the Studio leaves the file valid | Re-validate (JSON) or re-parse and type-check (TypeScript) before keeping it |
| An AI change over a value the person set is visible | `check` lists it |
| A subsystem that throws at start does not stop the game | Each module is started in a guard; the error is reported once |
| No allocations per frame in engine code | Budget test in the examples |
| Dev tools are not in ship builds | Build test greps the bundle |
