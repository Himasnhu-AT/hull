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
        render/          the render bridge; webgl2 and webgpu backends behind it; golden/ compares images
        vfx/             particle effects (CPU pool, GPU simulation on WebGPU)
        audio/           Web Audio engine, sound bench pieces, pure DSP helpers
        anim/            skeletons, clips, graphs, IK, the Animator
        ui/              DOM UI kit
        input/           devices to actions
        physics/         swept collision, queries, rope, rigid bodies
        platform/        saves, settings, fullscreen; browser and desktop shell differences
        kits/            reusable gameplay pieces, each with config, bench, test and README
        dev/             the game side of the project protocol (connectDev; not in ship builds)
        three.ts         `hull/three`: the engine's own copy of three.js, for games that build three.js objects
    tools/               @hull/tools: every tool, defined once; the app, MCP and Marl AI call them (no command line)
      src/tools/         the tool list (typed function + JSON Schema each) and the project methods
      src/mcp/           the MCP server library: stdio and streamable HTTP
      src/server/        the project server the Studio talks to; build, templates, tunable rewriting
      src/history/       the history store, the diff, experiments, merge, authorship
      src/review/        review notes (`.hull/review.json`)
      src/play/          step scripts: run in a headless browser, golden image compare, PNG codec
      src/control/       a client for the project server's protocol
      bin/hull-mcp.js    stdio launcher, MCP only
    studio/              Hull Studio (Electron app, React inside); benches live in src/renderer/benches
  schemas/               generated JSON Schema files
  templates/             starting points for the `new` tool: cube, arena, fps, third-person, yard (the worked example: a game on kits and a level file)
  shell/                 desktop shells for games: electron/ (used by `package`), tauri/ (a placeholder)
  examples/              games used as tests of the engine itself (aott)
  scripts/               maintainer scripts (`pnpm project:*`); never ship
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

* `core` and `config` must run in Node: no `window`, `document`, `AudioContext` or WebGL. A test that imports them in
  Node enforces it. `physics` and the pure parts of `audio`, `vfx`, `anim` and `kits` run in Node too.
* Nothing imports `dev/` except the dev page, so a ship build contains none of it (the build fails if `dev/runtime` or
  `connectDev` reach `game.js`).
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
  listed in a static `state` array so the checksum and saves find them.
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
* Files carry no `$schema` line. `check` and the Studio know the schema from the kind; the emitted files are in
  `schemas/` for an editor that wants them.
* A reference is a string id in a field the schema marks as a reference (`x-ref: "sound"`). `check` resolves
  every one, in config and in code.
* **Typed access**: `check` writes `.hull/gen/ids.ts`, a list of every id per kind. So
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
* **Escape hatch for game-built three.js content.** A game that already is procedural three.js (AOTT: ShaderMaterial,
  `onBeforeCompile`, merged meshes) does not have to be rewritten into `Mesh` and `shape`. It imports three from
  `hull/three` (the engine's own copy, so `instanceof` holds), builds an `Object3D`, and adds it to a node with the
  `SceneObject` behaviour; the object follows the node and is drawn by the running backend. The game still never
  creates a renderer or owns the frame loop. `backendScene(world)` returns the scene the backend draws in, for scene-level
  state a game owns (a fog colour that follows the player). Such a game's GLSL only runs on WebGL2, so it pins the
  backend in `hull.json` `render.backend`; `mountRender` is then given that backend instead of choosing.
* **The interface** (`render/backend.ts`): `init`, `can(cap)`, `sync(world, alpha)`, `draw(cameraNode)`, `setLook`,
  `setFx`, `setQuality`, `resize`, `stats`, `shot`, `dispose`. Capabilities are `shadows`, `instancing`, `post`,
  `compute`, `msaa`. `render/pick.ts` chooses the order (`backendOrder`) and refuses a WebGPU adapter that is software or
  short of storage buffers (`webgpuRefusal`).
* **`mountRender(game, el, opts)`** picks the backend, owns the canvas and the animation-frame loop, and keeps the look in
  step with its config file. `opts.backend` is `auto` (default), `webgl2` or `webgpu`; a page can force one for a test with
  `?hullBackend=`. The view it returns has `backend`, `ready`, `stats()`, `shot()`, `setLook`, `setQuality`,
  `setPixelRatioCap`, `can(cap)`, and the post cues below. A backend that fails to start is reported once and skipped; with
  none the game runs without a picture.
* **Behaviours**: `Mesh`, `Camera`, `Light`, `SceneObject`, and `instances(parent, opts)` for crowds. `activeCamera(root)`
  finds the camera node. `debug.line(a, b, color)` draws for one frame in dev.
* **Post cues** (both on `RenderView`, drawn by the post chain, so the `low` tier shows neither): `setSpeed(0..1)` drives the
  look's `post.speedBlur` and eases in and out by itself. `impact(at, strength)` starts a hit pulse (colour drain, chromatic
  punch, vignette) that lasts `IMPACT_SECONDS` (0.22) of real time, so a hit-stop does not freeze it. `cancelImpact()` ends it;
  `holdImpact(k)` freezes it for screenshots. State and envelope are in `render/postfx.ts`; they never touch the simulation.
* **Custom effects** are written once in a form both backends accept (three.js's node language where it serves
  both; otherwise a pair of shaders registered under one name). `check` does not yet fail on an effect only one backend
  has.
* **Golden images run on both backends** with a small tolerance (`render/golden/`: 5% of pixels over 24/255, mean under
  4/255), so they cannot drift apart unnoticed.
* Owns resizing, quality levels (`low` drops post and shadows; `high` adds grain and FXAA) and the device pixel ratio cap
  that the platform's quality preset sets. There is no automatic governor yet.
* **Look** (`look` config): sun and its shadows, sky, fog, ambient, environment light, exposure, tone mapping, post chain
  (bloom, grade, vignette, grain, FXAA, speed blur). `render/look.ts` resolves the file to plain values (`resolveLook`).
* **Materials** (`material` config): colour, roughness, metalness and a named texture recipe. Meshes with the same
  spec share one material, released when the last user goes. Games do not write raw shaders for them; they ask for a
  material, so the renderer underneath can change.
* **Mesh**: a unit `box`, `sphere`, `plane`, `capsule` or `cylinder`, scaled by its node and shared by shape. Anything
  else a game builds in code goes through `SceneObject`. (A general mesh builder is not built.)
* **Cameras**: the `Camera` behaviour (perspective: `fov`, `near`, `far`, `active`). The follow camera is a kit. An orbit
  camera and a cutscene director are not built.
* **Debug draw**: lines for dev builds and benches (`debug`).
* Rendering never changes gameplay state. It reads node transforms, interpolated by `alpha`.

### vfx

* A game calls `mountVfx(game)` once (the dev page does it), then `vfx.burst(id, at, dir?, opts?)` for a one-shot and
  `vfx.trail(id, node)` for a stream that follows a node until its handle's `stop()` or the node is destroyed. Before
  `mountVfx` every call does nothing and says so once. `vfx.stats()` and `vfx.clear()` read and reset the pools;
  `previewVfx` loops one effect for a bench.
* Particles are simulated in the fixed step, so the same seed gives the same effect, and drawn by `mountRender`. An effect is a
  `vfx` config file (SCHEMAS section 10); `compile` turns it into flat arrays and a pool, so a burst allocates nothing.
* **Burst options** (`BurstOptions`): `count` (exact), and multipliers `size`, `speed`, `life` and `spread` (reach of the
  emit shape). The config stays the baseline, so one effect serves a small and a large hit.
* **Ground**: `vfx.setGround((x, z) => height)` gives effects with `particle.ground` a floor: `die`, `bounce` or `rest`.
  `null` removes it.
* **Flutter** is a sideways wobble per particle (a falling leaf). **Sprites**: `soft`, `smoke`, `hard`, `spark`, `chip`, `leaf`.
  Ground and flutter run on the CPU pool only.
* **Two paths**: an effect with a budget under 2048 runs on the CPU pool on both backends; at 2048 or more it runs wholly on
  the GPU when the backend can compute (WebGPU). The WebGPU particle code is loaded only by the WebGPU backend, so a WebGL2
  game does not ship it. Where an effect is near the camera it fades out (`budget.fadeNear`).

### audio

```
sound (recipe, code or sample) ─► voice ─► bus (sfx / ui / voice / music ...) ─► master: compressor ─► limiter ─► out
                                              └─ send ─► reverb
```

* A **recipe** is a small graph: sources (oscillator, noise, modes), shapers (filter, envelope, gain, drive, delay, pan),
  and random ranges per play. `planSynth` turns it into a plan that both the live engine and the offline bench build from.
  `sample` sources are in the schema but report as not supported yet.
* **Limits per sound**: minimum gap, maximum voices, what to do when over.
* **Buses** (`mixer` config): levels and a master compressor and limiter (`planMixer`, `defaultMixer`). Ducking rules and
  snapshots in the config are not built; a game ducks at run time (below).
* **`mountAudio(game, opts)`** returns an `AudioView`: `play(id, opts)`, `setBus(bus, db)`, `duck(bus, db, hold, release)`,
  `setBusLowpass(bus, hz | null, seconds?)`, `setListener(pos, forward?)`, `state`, `context`, `bus(name?)`, `dispose()`.
* **Play options**: `volume`, `pitch`, `at` (a world position: distance roll-off, pan and a low-pass with distance, against
  the listener), `params` (numbers for a code sound) and `spatial: { ref, max }` (this play's distance range).
* **Code sounds.** `registerGenerator(name, fn)` builds nodes once into `call.out` and returns the length. The call carries
  `ctx`, `t0`, a seeded `rng` (never `Math.random`), `knobs`, `pitch`, `params` and `reverbIn`. **Live generators**
  (`registerLiveGenerator`) return a `LiveVoice` with `set(params)`, a per-frame `tick(now)`, `stop()` and anything the game
  reads back; `play` hands back a handle whose `set` reaches it. That is how a winch whine or a score follows game state.
* **Offline**: the same plan renders into an `OfflineAudioContext` (`renderSound`, `measureSound`, `checkSound`), so what is
  measured is what plays. `measureChannels` and `fft` give peak, loudness and spectral centre.
* Every call is safe before the first user gesture and when audio is unavailable (`mountAudio` then returns a no-op view).
* **A game's own Web Audio.** A game that synthesises sound itself (AOTT) takes the engine's `AudioContext` from
  `view.context` and joins a mixer bus with `view.bus('sfx')`, so there is one context, one clock and one
  resume-on-gesture. Both are null/undefined when Web Audio is unavailable.
* Not built: the `music` layers on an intensity clock.

### anim

* A **skeleton** (`Skeleton`, `Pose`) is a tree of named joints. A body is generated by `buildBody` (a humanoid recipe from
  `proportions`, or a custom `bones` and `parts` list) and drawn as rigid shaped parts, one per bone, not skinned. glTF
  bodies are in the schema but not loaded yet.
* A **clip** is keyframes (JSON tracks of rotation and offset), or generated: `registerGenerator(name, factory)` takes the
  skeleton and a block of numeric knobs and returns a function of phase. The engine ships `humanoid/idle`, `walk`, `run`
  and two additive helpers. Lengths and strides scale with the skeleton's height, so a giant takes slow, long steps.
* An **anim graph** (`Graph`) has parameters (number, boolean, trigger), layers with masks, states that play a clip or a
  blend over a parameter, transitions with a `when` expression (`compileCondition`) and blend times, and IK settings.
* **Animator** is the behaviour that runs it on game time. `character` names a `character/*` file; `set(name, value)`,
  `trigger(name)`, `get`, `stateOf(layer)`, `weights(layer)`; `look(target)` and `reach(endBone, target, weight)` for IK
  (`twoBone`, `lookAt` in `anim/ik.ts`); `ground` gives foot placement a height function. `socket(name)` and `bone(name)`
  return the Object3D for a blade or an effect.
* **Events** on a clip's timeline fire the `events` signal on the fixed step with the event, clip and layer.
* **Cutting**: `detach(bone)` takes a bone and everything under it off the body and returns a node the game can throw; the
  `cut` signal fires with it. `Limb` frees the shared geometry when that node is destroyed.
* **Hits**: a character's `hits` list gives hit and collider shapes in bone space; `characterHits(def)` resolves each to a bone
  index so the game can follow it with the bone's transform (it feeds `physics` colliders).
* **Authoring moves (M10)**: a keyframe may name an `ease` (`in`, `out`, `inOut`, `snap`, `linear`, `hold`, `smooth`) for the segment
  it starts. A clip has named **windows** (`trace`, `parry`, `iframe`, `cancel`...) read with `animator.inWindow(name, layer?)` and
  fired as the `windows` signal (name, entering, clip, layer) on the fixed step, from the clip time the layer's newest state is
  at. **Root motion** (`rootMotion` on a keyframe clip) takes the root bone's x/z (or y, and yaw) out of the pose; the
  graph blends the travel like the pose (`animator.rootMotion`, per fixed step) and `applyRootMotion` moves the node by it. A
  state may be a **2D blend space** (`blend2d`, inverse distance), a transition may `sync` the cycle phase, a layer may take
  its weight from a parameter (`weightFrom`). `animator.timeScale` and `hitStop(seconds)` slow or hold one character on game
  time (a trigger set meanwhile waits). Presentation-only extras on frame time (`secondary.ts`): `springs` (chains of bones that
  trail the body's acceleration: hair, sash), `hitReact` and `animator.hitReact(dir, strength)` (additive flinch), and
  `ik.grips` (the off-hand two-bone IK to a socket, last in the IK order). A `when` may name a parameter with dashes (`stone-1 && !broken`), so a trigger can carry its clip's name. A humanoid body may list extra `bones`.
  Everything on the fixed step allocates nothing (a test measures the heap).
* `previewClip`, `previewGraph` and `stopPreview` are for benches. Everything advances on game time.

### ui

* DOM over the canvas. **Tokens** (`ui-theme`) are CSS variables set by `mountUi(game, el, theme?)`.
* **Widgets** are small classes (`UiPanel`, `UiText`, `UiBar`, `UiButton`, `UiImage`) styled by those variables; values
  update each frame and touch the DOM only when they changed. `ui.root` is the full-size layer to add them to.
* A **screen** (`ui-screen`) is a tree of widgets with bindings (`bind`, `max`, `format`, `visible`) to a view-model the game
  passes to `ui.screen(id, vm, { state })`, and named `on` actions registered with `ui.action(name, fn)` (`ui.open:<id>` and
  `ui.close` are built in). A rebuild after a file edit keeps the focused button.
* `focusMove(delta)` moves focus through the top screen's buttons for keyboard and gamepad. `setStrings(fn)` resolves `@key` text.
* The settings and key-binding screens are in `platform/screens`, built from the settings and the input map.

### input

* Devices map to **actions** (`input-map`, compiled by `compileMap`). Code reads actions, never keys.
* `mountInput` wires the DOM; `InputCore` is the same logic with no DOM, for tests and the control port. Input is sampled once
  per frame; edges last exactly one fixed step.
* Players can rebind (`Overrides`, saved by the platform's settings); an action may set `rebind: false`.
* In tests, over the control port and in hosted play, actions are set directly (`press` goes through real key events).

### physics

* `usePhysics(world, opts)` makes a `Physics` world (a broadphase grid; `cell`, `gravity`, `iterations`); `physicsOf(world)`
  finds it. Shapes: sphere, capsule, box, static triangle mesh (with a bounding-volume tree), infinite plane and height field.
  Layers are bits with a mask; a shape can carry a `tag` (queries match it exactly or by prefix) and can be a trigger.
* **Queries**: `raycast`, `spherecast`, `capsulecast`, `overlapSphere`, `overlapCapsule`, `distanceTo`. They fill a `Hit` the
  world owns and reuses, so they allocate nothing.
* **Movement**: `slideMove` (a swept sphere or capsule that slides along surfaces and fills a `MoveResult`: contacts with a walkable flag, grounded, stepped up)
  is the character mover; nothing tunnels at speed. `Rope` is a distance constraint for grapple wires (`Rope.fromRay`).
* **Behaviours**: `Collider` puts a shape on a node (static, or following the node or a bone); `Body` is a rigid body that
  falls, tumbles and settles. Rigid bodies are small on purpose (spheres and boxes for debris and severed limbs; no joints, no
  tall stacks) and deterministic: same inputs, same states.
* `debugShapes` draws shapes through `debug`.

### platform

`createPlatform({ id, ... })` gives one object whether the game runs in a browser or in the desktop shell (`detectKind` looks
for `window.hullShell`, which the Electron preload exposes).

| | Browser | Desktop shell |
|---|---|---|
| Saves | localStorage (`hull:<id>:saves:<slot>`); in memory if the browser refuses it | Files in the user's app-data folder |
| Settings | localStorage | A JSON file |
| Window | Fullscreen API | Window fullscreen |
| Quit | (none) | Closes the app |

* **Saves** (`createSaves`): versioned JSON `{ hull: 'save', version, savedAt, data }` with `migrations[n]` from version n to n + 1.
  A corrupt or newer file is reported once and skipped. `write`, `read`, `list`, `delete`.
* **Settings** (`createSettings`): per-bus volume, quality (`low`, `medium`, `high`, with a pixel-ratio cap), fullscreen,
  `invertY`, `sensitivity` and key bindings. `set` clamps, `apply(targets)` pushes them to audio, render and input, `look()`
  turns a mouse or stick delta into a rotation without allocating.
* **Pointer lock** by policy: `click`, `manual` or `never`; released while a menu is open (`setMenuOpen`) or the page is hidden.
* **Embedded in an iframe** (the Studio's Game view): a click takes key focus for the game itself, because a bound mouse button cancels the browser's own focus move; losing the pointer lock (Esc) hands the keyboard back to the page around it. A key event with an empty `code` is named from its `key`. `game.run` `state` returns `held`, the keys the game holds down.
* **Screens**: `openSettingsScreen`, `openBindingsScreen` and `attachPadNav` (gamepad focus navigation).

### kits

A kit is a folder under `packages/hull/src/kits/`: behaviours, their tunables, default config, a bench scene, a test and a
short README. The game composes kits and talks to them only through their signals, public methods and tuning. Sound, input,
saves and the UI layer go through `kitIO`, so a test swaps them (`hull/kits/testing`). A tuning file in `config/tuning/`
overrides a kit's tunables (section 4).

| Kit | Behaviours and helpers |
|---|---|
| `level` | `ArenaLevel`: floor, walls, crates |
| `fps`, `third-person` | `FirstPerson`, `ThirdPerson`, `AimFollow`, spawn helpers; the shared walker (`walk`, `footsteps`) |
| `follow-camera` | `FollowCamera` |
| `health` | `Health`, `HealthHud`, `Weapon` |
| `pickups` | `Pickup`, `Stock`, `StockHud`, `scatterPickups` |
| `spawner` | `Spawner`, `Chaser`, `WaveHud`, `GameOver` |
| `combat` | `Combatant`, `EnemyBrain`, `FighterInput`, `LockOn`, `Standoff`, weapon traces (`Blade`, `HurtShapes`), `combatHub`, `CombatDebug`; config kinds `move-set` and `enemy` |
| `pause`, `saves` | `PauseMenu`, `SaveSlots` |

**Pure helpers.** For a game that builds its own player or enemies, four kits also export plain functions and small state
objects with no nodes in them. They allocate nothing per step and are tested in Node:

* `spawner/waves`: `newWaveState`, `stepWaves(state, dt, alive, queued, hold, rules)`, `beginWave`, `resetWaves`, `waveCap`,
  `waveClock`, `waveScale`. The clock of an endless wave run (when the next wave starts, when a cleared wave is announced,
  when a straggler walks in); what a wave contains stays the game's. The result is one of `WAVE_NONE`, `WAVE_NEXT`,
  `WAVE_CLEARED`, `WAVE_TRICKLE`.
* `pickups/depot`: `newDepotState`, `stepDepot(state, dt, inside, needs, { dwell, cooldown })`, `fillTo`. A supply zone you stand
  in until it resupplies you, for a player that is not a node.
* `health/zones`: `zoneEffect(damage, cutAt, shallowAt)` returns `ZONE_NONE`, `ZONE_SHALLOW` or `ZONE_CUT`;
  `coveredDamage`, `regenerate`. What a hit on a body part does, as numbers.
* `follow-camera/glide`: `damp`, `followDistance`, `followFov`, `smoothstep` and `Reach` (a wall-avoidance distance that glides in
  and out). The chase camera's maths without the behaviour.

## 6. Build and output

```
src/ + config/ + hull  ──►  build
   1. check (types, schemas, references, rules); the `build` tool's `skipCheck` skips it
   2. strip `note` fields and inline config; tunables of the project become constants (kit blocks stay live cells)
   3. bundle the game and the engine modules it uses with Vite; drop dev/; minify
   4. write dist/web/game.js, index.html and build.json (sizes, gzip size, whether dev code reached the bundle)
```

* `game.js` is one ES module with no imports, config inside. It exports `start(element)` and starts itself when the
  generated `index.html` has an `#app` element.
* Binary assets are inlined into `game.js` (nothing is written to `assets/` yet); the one-file output is always on.
  `hull.json` `targets.web.singleFile` and a size-budget failure are in the manifest schema but not acted on yet.
* `build.json` lists the files with their sizes, and the build fails if `dev/` code reached `game.js`.

**Desktop**: the `package` tool builds `dist/web`, copies it and `shell/electron` into an Electron runtime and writes
`dist/desktop/<Title>.app` on macOS. Only the system it runs on can be built; the others come back as skipped. `smoke: true`
launches the packaged app once and saves a screenshot.

* `shell/electron`: one window, the game served from a private scheme, a preload (`window.hullShell`) exposing only the
  `platform` interface (read, write, list, remove, fullscreen, quit).
* `shell/tauri` is a placeholder README: there is no Tauri shell yet.
* Installers (`dmg`, `nsis`, `AppImage`), signing and notarisation are not built; they belong in CI per system.

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

* **Benches**: the smallest scene that shows one id, with the controls it offers. Per-kind benches (sound, character and
  animation, vfx, look) are in `packages/studio/src/renderer/benches`; each kit has a `bench.ts` scene. They draw with
  the runtime's own modules, so a bench shows what the game would.
* The **Inspector** renders a form from the JSON Schema and its `x-ui` hints, or from a `tunables` block. Editing a
  field sends one `set` to the project server, which writes the file and pushes the new value to the running game.
* **Review** state per id (`unreviewed`, `approved`, `needs-change`, a note, the content hash) lives in
  `.hull/review.json`. When a piece changes, its state returns to `unreviewed`.
* The **brief and the build's state** are three more project files, read and written only through tools: `GAME.md` at the
  root (the history tracks it), `.hull/explain/<id>.json` (the drawings for what a person cannot judge by looking or
  listening) and `.hull/create.json` (the flow's step and the seven stages). Formats are in SCHEMAS section 14.
* **The "Just now" feed.** The engine calls `trace(kind, id, node?)` (`core/trace.ts`) where a sound starts
  (`audio/engine.ts` `play`), a vfx burst or trail is spawned (`vfx/system.ts`), an animation graph changes state
  (`anim/graph.ts`, decided by the graph, once per change) and a character's animator first builds its body (`actor`, in
  `anim/animator.ts` `build`; chosen because it runs once per character, so nothing is added per frame; a state with no clip is not reported, and the same event at the same game time is kept once). With no listener
  the call returns at once and allocates nothing; call sites that build an id with a template check `isTracing()` first. Only
  `dev/runtime.ts` installs a listener: a ring of 64 slots (`dev/recent.ts`, reused, no allocation per event) stamped with
  game time, flushed to the server in one `game.events` message at most ten times a second and not at all when empty. The
  server keeps the last 256 per game and answers `game.recent` (the last N game-seconds, newest first); each batch is also
  pushed to studios as `game.recent`. Characters built before a studio connected are announced again on every socket open (one walk of the
  tree that asks each `Animator` to `announceActor()`; never per frame), and a restart reloads the page, which builds them anew. `game.moment` pauses its own game (not others), reads its state and a screenshot through the control
  port, and returns them with the recent events; the runtime flushes the ring before answering `state`, `screenshot` and `step`, and
  reports `paused` at once after any `game.control`, so a later `game.control { paused: false }` resumes it and the studio sees both. A game that reconnects starts a fresh feed.
  **Which game.** Every game connection has a client id: the page's `?hull-client=<id>` (the app puts one on its Play frame), else a random one. `game.run`, `game.recent`, `game.moment` and `game.control` take an optional `client`; without one the server picks the first game of the project's own that is not headless, and a headless page (one a tool opened with `?hull-headless` because no app was around; the runtime adds `headless=1` to its socket) only when nothing else is connected. A headless page opens once per link, is reused by later calls and closed with the link; it is never preferred to a game in a frame. The `game.recent` push carries the `client` that did it, so a studio keeps only its own frame's events. **Keys from the frame.** The frame is another origin and keeps the keys while the person plays, so when embedded the runtime posts `{ hull: 'note' }` (N, no modifier, not in a text field) and `{ hull: 'resume' }` (Escape) to `window.parent`; the Play screen accepts them only from its own frame. This is dev code and never reaches a build (the build checks for `hull-client`). Labels are made by one pure function (`dev/labels.ts`): a config `title` when it has one (no schema has one yet),
  else the id in words ('vfx/clash-sparks' is 'Clash sparks', 'sound/sword/hit' is 'Sword hit', an anim state 'light-attack' is
  'Light attack', a character is its id's last part, or its node's name when inline).
* **Who may connect.** The server makes one random token per run and writes it to `.hull/server.json` (mode 0600, written
  by temp file and rename). A `role=studio` socket must present it (`?token=`) or the upgrade is refused with 403, whatever
  its Origin; the Origin must also be absent, `file:`/`app:` or loopback, and Origin `null` has no special standing. The
  url the server hands out (`ProjectServer.url`, `OpenedProject.url`, `findServer`) already carries the token, so `connectProject`
  and the renderer's `studioUrl` need nothing more. A `role=game` socket presents a second token (`?gt=`) that only the dev
  page's boot module holds; it may send only the game's notifications (`game.report`, `game.events`, `game.result`, `log`) and
  never a method call. MCP over HTTP needs `Authorization: Bearer <token>` (its own token, `McpHttp.token`, shown in the app's
  connect lines and passed to ACP agents) on top of the loopback Origin check; stdio needs none. In the Electron app every
  IPC handler checks that the caller is the window's top frame and the app's own page (`main/ipcGuard.ts`), `openProject`
  accepts only a folder from Recent or the folder dialog, the window cannot navigate away from the app, and links open in
  the browser only as http(s). Web mode's `/__hull` API answers only its own Host and Origin.
* **Measurements** come from the same tool code the MCP server calls, so the Studio and the AI see the same numbers.
* **Hosted** (PLAN section 8): the project server runs on Marl's machines and holds the code; the Studio's front
  end is served to the customer's browser; `GameView` switches to a remote source (a video stream, or a
  server-built bundle run in the browser). The protocol and the panels are the same. A chat panel talks to
  Marl AI. Publishing builds on the server and puts the result on Marl's hosting under a share link.

## 9. Tools for the agent

Every tool is defined once, in `packages/tools/src/tools/` (`@hull/tools`), as a typed function with a JSON Schema for
its input and output (`defineTool`, `ToolDef`). There is no command line: the app is the product, so one front less to keep.
Three fronts expose the list:

| Front | For | Notes |
|---|---|---|
| The Hull desktop app | The person | Calls the tool functions directly. |
| MCP | A local agent (Claude Code, Codex, any MCP client) | `createMcpServer(projectRoot)` in `@hull/tools`. The app hosts it over streamable HTTP on 127.0.0.1 for the open project and shows how to connect; `bin/hull-mcp.js [dir]` serves it over stdio when the app is closed. |
| Marl AI | Customers of the hosted Studio, and the Studio's chat panel | A separate backend service. It runs the agent loop with a model from Marl's list, calls the tools on the project server, streams text and changes back, and meters usage. One turn ends as one change in the history. Not built here. |

The author of a change records the front and the model (`you`, `ai:<agent>`, `marl:<model>`), so the timeline shows who
and what made it. Marl AI holds the provider keys: none is ever in a project or in the Studio's front end.

### The tools

The registry (`tools`) holds files-and-processes tools. Each takes a project root and returns problems as data.

| Tool | Does |
|---|---|
| `check` | Types, config against schemas, references, what each kit knows about its own kinds (`hull/kits/checks`, run by `tools/meaning.ts` on every file that passed its schema: a level, a prefab, a move-set, an enemy against its move-set, a glTF file missing from `assets/`; rule `meaning`, at `file#/pointer` with line and column), house rules (no `Math.random`, `Date.now`, `performance.now` in game code), and `"<kind>/<id>"` string literals in `src/` that no config answers to (`tools/refCheck.ts`: reported at `file:line:col` with the nearest real id; a literal that continues into an expression, ends in a separator, or is the argument of `has(` / `watch(` is not flagged); writes `.hull/gen/ids.ts` |
| `test` | Runs the project's `src/**/*.test.ts` in Node (Vitest) and reports each failure at the deepest frame inside the project's `src/` (else the test's own line), with the assertion's message |
| `build` | `dist/web/game.js`, `index.html`, `build.json` (section 6) |
| `package` | Builds, then an Electron app in `dist/desktop/` (`targets`, `smoke`) |
| `dev` | Serves the game in a browser, reloading on change. Hidden from MCP: it never returns |
| `new` | Makes a game from a template. Hidden from MCP |
| `play` | Runs a step script in a headless browser (below) |
| `review.list`, `review.set`, `review.note` | Review notes |

The **project methods** (`projectTools`) go through the project's server, so an open app hears them: `project.info`,
`library.list`, `config.read`, `config.set`, `tunables.list`, `tunables.set`, `journal.list`, `history.list`, `history.diff`,
`history.restore`, `history.checkpoint`, `exp.start`, `exp.list`, `exp.compare`, `exp.adopt`, `exp.discard`, `game.control`,
`game.run`, `problems.list`, the review methods, the idea-to-play methods (`brief.read`, `brief.write`, `docs.list`, `docs.read`,
`docs.search`, `explain.list`, `explain.write`, `create.get`, `create.set`, `game.recent`, `game.moment`), and the code methods below. `openProject` attaches to the server the app started (it writes
`.hull/server.json`) or starts one in process, so two servers never fight over one project. `allTools` is the union;
where a name is in both lists the method wins.

**MCP** (`mcp/`) is JSON-RPC 2.0 written by hand: `initialize`, `tools/list`, `tools/call`, `ping`, over newline-delimited stdio
(`serveMcpStdio`) or streamable HTTP bound to loopback only (`startMcpHttp`). The package has no MCP SDK dependency.

**What a tool call returns over MCP** (`mcp/server.ts`):

* Every input is checked against the tool's own input schema before the tool runs, on every front (`validate.ts`, used by the MCP
  server and by `runTool`; Hull's agent goes through the MCP server). A hand-written checker (type, required, properties,
  additionalProperties, enum, const, oneOf, items): `config.set: unknown field "path" (fields: id, pointer, value, author, exp)`,
  `config.set: "pointer" is required`.
* A picture is a field named `png` (or a `data:image/...;base64` string). The result has one `{type:"image", data, mimeType}` block
  per picture, and the text and `structuredContent` carry the output with each replaced by `"[image]"`. Text is compact JSON; a
  document (`docs.read`) is the document.
* `tools/list` carries no `outputSchema`; a tool says what it returns in its description when that is not obvious.
* `config.read` leaves the JSON Schema out unless `schema: true` (it was 45 KB next to a 1 KB sound). The project server's own
  answer still has it, so the app is unchanged.
* **Docs**: `docs.list` puts `guide/engine` (`packages/hull/docs/ENGINE.md`) first and names the config kinds that
  docs/SCHEMAS.md describes but that have no schema (`notBuilt`). `docs.read {id, section?}` returns one section by heading;
  `docs.search {query}` finds sections. `kit/index` is generated from the kit folders (name from the folder, one sentence from
  the first paragraph of its README), so a kit cannot be left out. `api/three` is a short note on when to use `hull/three`.
  Every new project gets `AGENTS.md` (`packages/hull/docs/AGENTS.md`, the short cut of the guide) and a `CLAUDE.md` holding `@AGENTS.md`.

**Maintainer scripts** (`scripts/project.ts`, never shipped) call a tool as a function: `pnpm project:check|build|dev <dir>`, and
`pnpm project:run <tool> <dir> [json]`. `pnpm mcp [dir]` starts the stdio server.

### Code tools

`code.list`, `code.read`, `code.search`, `code.edit`, `code.write` and `code.delete` are project methods (so the app, MCP and
`@hull/agent` get the same six) that let an agent change the game's behaviour in `src/`, where `config.set` and `tunables.set` only change
values. Their rules, in `server/code.ts` (pure, unit-tested) and the project server:

* **Confined to `src/`.** A path must be `src/...` with forward slashes: no `..`, absolute path, hidden or `node_modules` folder, and no
  symlink that resolves outside `src/` (the deepest existing part of the path is resolved with `realpath`). `config/` goes through the
  config and asset tools. Files are text (`.ts .tsx .js .mjs .json .css .glsl .wgsl .txt .md`), at most 512 KB.
* **`code.edit` is an exact-string replace that must match once.** `old` that is missing, empty, equal to `new` or found several times is
  refused with the reason (and the line numbers of the copies); `all: true` replaces every copy. A CRLF file takes an LF `old`.
* **Atomic and recorded.** A write goes to `.hull/tmp` and is renamed into place like every other server write, then `hist.touch(author)`
  records it as a change by that author (`ai:Hull agent`, `ai:<MCP client>`). It is not dropped from HMR as a tunable write is: it is code,
  so the open game reloads and the Studio hears `source.changed`.
* **Type problems come back, the write stays.** After `code.edit` and `code.write` the project is type-checked with tsc (incremental,
  build info in `.hull/cache`; `typecheck: false` skips it for the first of several related edits) and the problems in the written file return as
  `file:line:col`; the count in other files is `elsewhere`. The result has `written: true` and `ok: false`, so a caller can tell a kept write
  with problems from a refusal (`written: false`). The agent fixes it with another edit; the check gate in `@hull/agent` still runs `check`
  and stops the run from ending while it fails.
* **`code.delete` refuses while the file is in use**: every importer in `src/` (relative `import`, `export ... from`, `import()`, `require`) is
  listed as `file:line:col`, and so is `hull.json` if it names the file. The agent asks the person first (`risky`).
* Not built: edits inside an experiment (`exp`), only the project; whole-program impact beyond the written file's own problems.

### What the tools give an agent

* **Errors are located.** `path:line:col: message` for code, `path#/json/pointer: message` for config, and every tool
  returns the same problems as data (`formatProblem`). A failing test is placed at the deepest frame of its stack inside `src/`; a wrong
  tool input names the field (see "What a tool call returns over MCP").
* **Scenario tests** (Node): `hull/kits/testing` starts a game with a headless input and counted sounds
  (`startRig` gives a `Rig` with `g`, `core`, `sounds` and `step(n)`; `runScenario` records and replays a run). This is the harness the kits' own tests use.
* **Control port.** In a dev build the game connects to the project server (`connectDev`, `dev/protocol.ts`). The server sends
  `game.rpc` and the game answers `game.result`; the `game.run` method is the way in. A page opened with
  `?hull-paused&hull-client=<id>` starts frozen at tick 0 and can be aimed at by id (the tool's page also says `hull-headless`),
  so a script starts from the same state every time. Time moves only by `step`, `until`, `perf` and `frames`. Ops:
  * `step`, `press`, `release` (keys, and `Mouse0`..`Mouse2` for buttons), `look` (mouse movement as under pointer lock),
    `screenshot`, and `frames` (several screenshots tiled into one PNG with the tick written on each).
  * `state` (tick, time, checksum, named nodes, held keys, **probes**, unread error count), `inspect` (one node: transform, groups,
    children, each behaviour's state), `tree`, `until` (step a tick at a time until a condition on a node field, a probe or a
    trace event holds), `perf` (ms per step and per frame, draw calls, triangles, nodes), `restart` (ready again, same seed,
    paused at tick 0; the page reloads and the server waits for it to come back).
  * `errors`: a ring of 50 (repeats counted) of what the page raised: an exception in a step or a frame, `window.onerror`,
    unhandled rejections, `console.error` and `console.warn`. `dev/capture.ts` installs the capture when the dev module loads,
    before `ready`, so a warning printed while the game is built (a material that does not exist) is kept. The page sends the
    browser's own stack text; the project server maps it through the inline source maps Vite serves (`server/stackmap.ts`,
    `node:module` `SourceMap`) to `file:line:col` in the original TypeScript, project-relative (`src/player.ts`) or
    engine-relative, at most six frames, the control port's own frames cut.
  * A step or `until` in which game code throws fails with `src/player.ts:40:5: Error: boom`, the mapped stack and the line
    "The world may be part-stepped: run {op:"restart"} before trusting state."; the error is also in the ring.
  * **Probes**: `probe(name, read)` (`core/probes.ts`) names a reading a game cares about (`score`, `gemsLeft`). They show in
    `state` and can be waited on by `until`. In a ship build nothing reads them: one Map entry each.
  * The sounds a game asks for are traced even when the audio context cannot run (a headless page never gets the gesture that
    starts audio), so `game.recent` and `until {event}` work there.
  * The headless page a tool opens closes when the process that opened it ends for any reason (stdin end, SIGTERM, SIGINT, SIGHUP,
    exit); a session left by a dead pid (`hull-link-<pid>`, `hull-play<pid>x<n>`) is closed on the next start (`play/session.ts`).
    Not built: `set`, `spawn`, `teleport`.
* **Step scripts** (`play`): a JSON list of steps run in a headless browser (agent-browser): `step`, `press`, `release`, `hold`,
  `read`, `check`, `screenshot`, and `until {when, max}` (fails when the condition does not hold in time), `expect {node, field |
  probe, cmp, value}`, `look [dx, dy]`, `inspect "node"`. A script fails when the game logs an error while it runs (a throw,
  `console.error`, a rejection), naming `file:line:col`, unless it says `"allowErrors": true`; warnings do not fail it and are listed
  in the report. Each screenshot is compared with `tests/golden/<name>.png` per channel and per pixel
  (default: 8 of 255 per channel, 0 pixels allowed). A missing golden is written; `update` rewrites them; a mismatch stops the
  script and leaves `.hull/play/<name>.actual.png` and `.diff.png`. Not built: a perceptual compare.
* **Sound measurement**: `renderSound`, `measureSound` and `checkSound` in `hull/audio` give peak, loudness, length and spectral
  centre. They are library functions for benches; there is no `bench` tool yet.
* **Budgets**: `hull.json` `budgets` is in the schema, and `render` and `vfx` report draw calls and frame time; the check that
  fails a build or test on them is not built.

### Hull's own agent (`packages/agent`, `@hull/agent`)

An ACP agent (D14, D16) that runs on the user's key: `startHullAgent({ projectRoot, provider })` speaks ACP over a pair of streams, and
`bin/hull-agent.js [dir] [--fake script.json | folder]` does the same on stdio for the app to start as a child process. It handles
`initialize`, `session/new`, `session/prompt`, `session/cancel` and `session/close`, and streams `agent_message_chunk` (one per text delta), `plan`, `tool_call` and
`tool_call_update` (with `diff` content for config and tunable edits), `usage_update` and `compaction_update`, and asks with
`session/request_permission`. The conversation additions of M11 (docs/IDEA-TO-PLAY.md 4.4) ride in `_meta`:

| What | Wire |
|---|---|
| Kind of run | `session/prompt` `_meta["hull.mode"]` = `brief` \| `build` \| `fix` (default `fix`); `build` may carry `_meta["hull.stage"]` and then the prompt text is the person's note on that stage |
| A card that does not wait | `agent_message_chunk` with empty text and `_meta["hull.ui"]` = a `UiBlock`; sent again with the same `id` it replaces itself |
| A card that waits | `session/request_permission` with `toolCall` `{ toolCallId: block.id, title: question, kind: "other", _meta["hull.ui"] }`; `ask`: one `allow_once` option per choice (id = index); `approve`: `yes` (`allow_once`) and `no` (`reject_once`). Outcome `cancelled` = the person answers in their own words: the turn ends and their next prompt is the answer |
| A frozen moment | The prompt's blocks: the note, an image block (PNG), a text block with the time, tick and what just played. Image blocks reach the model as images |

* **Tools**: called in-process through `createMcpServer` from `@hull/tools`, opened as client "Hull agent", so the history author is
  `ai:Hull agent`. The agent has no file or shell tools: every write is a validated Hull edit. `session/new`'s `mcpServers` is not used.
  Code in `src/` is changed with the code tools above (`code_edit`, `code_write`; `code_delete` is risky); the system prompt tells the model to prefer config and tunables for a value and code for behaviour.
  `brief_write`, `explain_write` and `create_set` are writes that never ask and do not count as a change to the game (no check gate, no change card).
* **Conversation tools** (`src/modes.ts`, answered by the loop, not project tools): `update_plan { entries }`; `ui_show { block }` shows a card at once (kinds `brief`, `stages`, `pieces`, `explain`, `change`);
  `ui_ask { question, options[2..4] }` and `ui_approve { question, detail?, yes, no }` wait and return the chosen text, or "(the person will answer in their own words)", after which the loop ends the turn.
* **Models**: Anthropic's Messages API (`ANTHROPIC_API_KEY`, default `claude-opus-5-5`, override with `HULL_AGENT_MODEL`) or any
  OpenAI-compatible chat endpoint (`HULL_AGENT_BASE_URL` + `HULL_AGENT_API_KEY`, which is how `ai.marlstudio.com` plugs in). Plain fetch,
  no vendor SDK. Both **stream** (`stream: true`): the server-sent events are parsed by pure classes in `src/stream.ts` (tested on recorded streams) and each text delta goes to the app as it arrives
  (`CompleteRequest.onDelta`); a gateway that ignores `stream` and answers in JSON still works. Anthropic requests mark the system prompt, the last tool and the last message block for prompt caching
  (the tool list is fixed per mode, so the prefix repeats on every step of a run). Keys are never logged or put in an error.
  * **Errors** (`src/providers.ts`): a request is tried up to 5 times on 408, 409, 429, any 5xx (529 is Anthropic's overloaded) and a connection that fails before an answer, waiting 1 s, 2 s, 4 s, 8 s (doubling, the lower half jittered away) or what `Retry-After` says, at most 60 s. A stream that breaks after the answer began (dropped connection, an error event, or no stop reason) is started again once; text already shown is not shown twice. Waits go through `ProviderConfig.sleep`, so tests never sleep.
  * **Models** (`src/models.ts`): a table by model-name prefix (ids have no date suffix) keeps what a model *can* do apart from what the agent *asks*. A row has the real context window and max output (1M and 128K for the Fable, Mythos, Opus 5/5.5, Sonnet 5/5.5, Haiku 5.5 and the 4.6 to 4.8 Opus/Sonnet models; 200K and 64K for `claude-haiku-4-5`), `thinking` (`always` | `default-on` | `opt-in` | `none`) and `effort` (whether it takes `output_config.effort`; true only for the 5-series rows). The agent works within **300 000 tokens of history** (compaction starts at 70% of that) and sends **max_tokens 64 000** (streamed); `HULL_AGENT_CONTEXT` and `HULL_AGENT_MAX_TOKENS` change these up to the row's real limits. An unknown Anthropic model gets 200K / 16 000 and no effort, an unknown OpenAI-compatible one 128K / 8 192.
  * **Effort**: rows with `effort: true` get `output_config: { effort }`: `medium` for the brief (and summaries), `high` for build and fix, `HULL_AGENT_EFFORT` (`low` to `max`) over both. No `thinking` field is sent (`disabled` and `budget_tokens` are a 400 on the always-on models), and no temperature, top_p or top_k.
  * **Thinking blocks** (`Part` type `thinking`): `thinking` and `redacted_thinking` blocks are kept exactly as the API sent them, signature included, in their place among the text and tool calls, and sent back unchanged on every request (`AnthropicStream` reads `thinking_delta`/`signature_delta`; the whole-JSON path reads them too). They are never shown; the OpenAI-compatible path drops them. The signature binds a block to the system prompt, the tools and every earlier message, so **whenever the history is rewritten the thinking parts are removed from the turns that are kept**: `prune` (when it cut anything) and a compaction (on the retained tail) do it, and so does a new prompt whose system prompt differs from the last one (GAME.md or AGENTS.md changed). The tool list is fixed per mode and a change of mode starts a new history, so nothing else edits the prefix inside a session.
  * **Cut answers**: an answer that stops for `max_tokens` is not the end of the turn: a cut tool call is answered with an error result that says it was cut and to write the file in smaller parts (it is not run); a cut text gets a "continue" turn; five cuts in a row stop the run.
  * **Refusal**: `stop_reason: "refusal"` ends the turn at once (no retry, no check gate), tells the person the model declined with the category and explanation from `stop_details`, and is returned as ACP stop reason `refusal`; in the build a refusal fails its stage without the one retry.
* **Modes** (`src/prompt.ts`, `src/modes.ts`): each has its own system prompt and tool list, and a conversation does not carry from one mode into another.
  * `brief`: an interview of at most three `ui_ask` questions, then `GAME.md` written section by section with `brief_write` and the `brief` card after each; ends with `ui_approve` "Build from this brief?", and yes sets `briefApproved`/`step: build`. Tools: reads, `brief_*`, `docs_*`, `create_*`, `ui_*`. No code or config writes. A later prompt edits only the sections it names and marks them `changed`.
  * `build`: a runner (`src/stages.ts`), not one run. For each stage not yet `ready` (or only `hull.stage`): `create_set` building, then a fresh history seeded with the brief, the docs index and the earlier stages' summaries, run with a per-stage step limit (80, `HULL_AGENT_STAGE_STEPS`), then the gates: `check` (the loop's own gate), the explain documents the stage owes (world: a `map`; rules: a `flow`), `test` (a project whose tests cannot load here is not failed for it), one screenshot read by the model, and `history_checkpoint` `stage-<id>`. Pieces are the config ids and `tunables:<block>` read back from the history's details, new library ids, and `explain:<id>` for each document written. A stage that fails a gate after the fix rounds is tried once more with a fresh history seeded with the failure text and the first attempt's summary; if it fails again it is set `failed` with the reason. The stages that do not build on the others (sounds, effects, screens) still run after a failure, the dependent ones wait, and the failures are reported together (`_meta.failures`); the next build prompt starts at the first stage that is not ready. The stage's screenshot is taken after `step 60`. When all seven are ready the step becomes `play`. No `ui_ask` here: the person reviews the pieces afterwards.
  * `fix`: the loop below. A run that changed the game ends with a `change` card (plain title, the piece, a line per value or "+N -M lines" for code, and the newest history change id for Keep and Put back).
* **Prompt**: teaches the loop (look, plan, small edit, check, test, step, read state or screenshot, report what could not be judged), a short "How to verify" part (the control-port ops of C1, `game_recent`, `game_moment`; after any change check, then test, then step and read errors before a screenshot) and
  appends the project's `AGENTS.md` (and `GAME.md` for a fix; the brief and the build read it through `brief_read` and the task).
* **Parallel reads**: tool calls of one model turn that only read (`HullTools.isReadOnly`: list, read, diff, patch, refs, code search) run side by side; a write, a game step, `check` or a question to the person waits for the calls before it, and results go back in the order of the calls.
* **Gates**: destructive tools (rename, move, delete, `code_delete`, restore, revert, adopt) ask first (`HULL_AGENT_PERMISSIONS`: `risky` default,
  `writes`, `none`); after edits the loop runs `check` itself and the run cannot end while it fails, for at most three fix rounds,
  then stops and says so (`_meta.checkFailed`); an edited run ends with a history checkpoint `hull-agent-run-N`.
* **Compaction**: past 70% of the model's window (measured from the input tokens the provider reported at its last call plus a guess for what came after; the 4-characters guess alone when it reports none) old tool results are cut, a failed compaction is not tried again for the next 5 model calls, then everything but the recent tail becomes OpenCode's
  structured summary (MIT, see `packages/agent/NOTICES`). `HULL_AGENT_CONTEXT` sets the working budget (see Models).
* **No key needed to check the flow**: `fakeProvider` plays a script (streaming its text in pieces). `HULL_AGENT_FAKE` / `--fake` names one JSON file (every mode) or a folder with `brief.json`, `build.json` (one list per stage id) and `fix.json`;
  `packages/agent/fixtures/arena/` is such a folder for a project made from `templates/arena`. A step may carry `when` (play only if that text is in the last two user messages), and a tool input may use `"$screenshot"`, `"$screenshot.width"` and `"$screenshot.height"`.
* **Tests**: `stream.test.ts` (parsers and providers on recorded streams), `modes.test.ts` (tool lists, card checks, reading changes back), `agent.e2e.test.ts` (prompt, tool calls, edit, check, done, a failing-check
  gate, a permission denial, cancel and compaction over ACP against the arena project; the wire shapes of cards and asks; the change card), `stages.e2e.test.ts` (brief, change, approval and the whole build on a copy of the arena template with the fixtures, a failed stage and its resume).

### The agent panel (ACP client, `packages/studio`)

The app's main process is an ACP client (`src/main/agents.ts`, official `@agentclientprotocol/sdk`). It finds agents on this Mac (Hull agent, `codex-acp`, Gemini CLI, `opencode acp`, plus any in `HULL_ACP_AGENTS`), starts the chosen one as a child process in the project folder, and hands it Hull's MCP server in `session/new` (HTTP with an `x-hull-author` header naming the agent, or the stdio launcher with `HULL_MCP_AUTHOR` when the agent has no HTTP MCP). The MCP server records every change as `ai:<agent name>` in the history. `session/update`, permission requests and the end of a run reach the renderer as plain events (`shared/agentApi.ts`): Electron sends them with `webContents.send`, the web dev mode as a server-sent stream. The panel draws the plan as a checklist, tool calls with line diffs and permission requests as approve or deny cards (`editor/agentView.ts` holds the testable part). Missing agents are listed with the command that installs them.

Claude Code is never started through an SDK. The panel's Claude Code tab runs the person's own `claude` in a pseudo-terminal (`node-pty`, drawn with xterm.js) in the project folder, with their own environment, and shows the `claude mcp add` line to run once. Hull does not offer claude.ai login and never reads or stores Claude credentials (PLAN D15). `src/main/fixtures/fake-acp-agent.mjs` is a scripted ACP agent for tests.

### Settings (`renderer/settings/`, `src/main/accounts.ts`)

One sheet, opened from the launcher, both title bars, the builder's "Add a key" and Cmd+,. **Builder**: the provider in use (the Hull account, Anthropic, or any OpenAI-compatible endpoint; the account signs in through the browser with OAuth code + PKCE on a loopback redirect, `src/main/account.ts`, and its token is used as an Anthropic key against `backend/`), the model, and one key per provider, encrypted with `safeStorage` (`agentSettings.ts`; a file from before keeps working, its single key read as its provider's). **Claude Code** and **Codex**: installed, signed in and connected, asked of the programs themselves (`claude auth status`, `codex login status`, `… mcp get hull`); only "how" ("Claude Max", "ChatGPT", "API key") reaches the page, never an email or key fragment. Connect runs the program's own `mcp add` (Claude Code: HTTP, local scope of the project folder; Codex: the stdio launcher, so it works with the app closed). Codex signs in with its own `codex login` (ChatGPT in the browser) in a terminal pane; terminals run only a fixed list of programs named by the page, never a command line from it. Claude Code gets no sign-in or sign-out button (D15): Settings only reports what it says. **MCP**: the open project's address and config lines for other clients (`settings/mcpLines.ts`, shared with the agent panel).

## 10. Rules the engine enforces

| Rule | How |
|---|---|
| No wall clock or unseeded random in game code | `check` house rules (a source scan); the engine's versions are the ones to use |
| `core` and `config` run without a browser | A test imports them in Node |
| Config matches its schema; references resolve | `check` |
| A write from the Studio leaves the file valid | Re-validate (JSON) or re-parse and type-check (TypeScript) before keeping it |
| An AI change over a value the person set is visible | `check` lists it |
| A subsystem that throws at start does not stop the game | `mountRender` and `mountAudio` report once and carry on without a picture or sound |
| No allocations per frame in engine code | Convention for now; the physics tests check queries and the mover allocate nothing |
| Dev tools are not in ship builds | `build` scans the bundle and fails if dev code reached it |
