# AOTT on Hull: the port (M6, phase 1)

AOTT (the game in `../aot`, 27k lines of TypeScript and three.js) now runs on the Hull engine as the project in this
folder. It plays, tunes live, tests headless and builds to one file. This page says what was ported and how, what was
dropped or stubbed, the known gaps, and the work packages phase 2 can run in parallel.

Run it: `pnpm app` (open this folder), or `pnpm project:dev examples/aott`; add `?play=expedition`
to the page address to skip the title (`gate`, `scout`, `training`, `free` also work, as do AOTT's old flags
`notitans`, `noallies`, `nohorses`, `nocivilians`, `allies=N`). Tests: `pnpm test` (the Holdout run is
`src/main.test.ts`). Build: `pnpm project:build examples/aott`, which runs `check` first (types,
config schemas, house rules: all pass).

## 1. How it runs

* **One Hull behaviour is the game.** `src/main.ts` is a `defineGame` (step rate 120, `hull.json` step 120) that spawns the
  node `aott` with `AottHost` (`src/host.ts`). The host is what AOTT's `main.ts` was, minus what Hull owns now.
* **The whole AOTT frame is one fixed step.** `AottHost.fixedUpdate` does input, hit-stop and slow motion, the soldier's
  physics, titans, comrades, horses, civilians, the flow (modes, waves, missions), effects, the world and the camera.
  `game.step(n)` therefore plays exactly n steps of the game: the control port, `play` scripts and the headless
  tests all see the real game. Hit-stop and slow motion scale the game's own time inside the step (the soldier's fixed
  physics runs once per whole unit of scaled time, as it did); they do not use `game.timeScale`.
* **Drawing is Hull's.** The game's own three.js `Scene` (everything the world, titans, soldiers and effects add to
  `game.scene`) hangs under the node `aott` through the new `SceneObject` behaviour. `game.camera` is the Hull `Camera`
  behaviour's camera, so the render bridge draws through it; the host copies fov, near and far to the behaviour each step.
  `mountRender` owns the canvas and the frame loop. The game never creates a `WebGLRenderer`.
* **WebGL2 is pinned** (`hull.json` `render.backend: "webgl2"`) because the world, titans and sky are GLSL
  `ShaderMaterial` and `onBeforeCompile` code. WebGPU parity is a known gap, not done.
* **Headless.** In Node there is no `document`: the HUD, effects, sound, leaderboard and pointer lock are skipped, the
  world, titans, comrades, horses and civilians are built and simulated all the same. Canvas textures are painted on a
  stand-in canvas (`src/canvas.ts`) that keeps no pixels, so geometry and colliders match the browser's.
* **Checksum.** The simulation lives outside Hull's nodes, so `AottHost` declares one state field, `digest`, a hash of game
  time, the soldier, score, wave, every titan and every comrade, recomputed each step. `world.checksum()` therefore
  changes when a run diverges.

## 2. What was ported how

| AOTT | On Hull |
|---|---|
| `main.ts` renderer, loop, game object | `host.ts` (`AottHost`), Hull loop and `mountRender` |
| `boot.ts` (phone and small-window gate), `loading.ts` | dropped: Hull's page starts the game; boot is synchronous inside `ready` |
| `CFG` (`config.ts`) | tunables: `src/tuning.ts` has 20 blocks (`hook`, `reel`, `gas`, `air`, `ground`, `impact`, `wire`, `horse`, `perch`, `wall`, `hang`, `flow`, `kill`, `release`, `aim`, `keys`, `cam`, `combat`, `body`, `titan`); `config.ts` keeps `CFG.hook.range` etc. as live getters over them |
| titan constants (`TITAN_TUNING`, `BREACH`, regrow times) | the `titan` block, read live through `TITAN_TUNING` and `BREACH` getters |
| `keys.ts` ACTIONS, `input.ts` | `config/input-map/play.json` (22 actions plus `look`, `primary`, `secondary`, `confirm`); `input.ts` keeps `act`, `actHit`, `mouseDX` over Hull's input view; `keys.ts` is the HUD's view of the bindings, rebinding goes through Hull's `rebind` and is kept in localStorage |
| `Math.random` (106 calls) | `R.sim` and `R.fx` in `sim.ts`: Hull's named streams `sim` (gameplay) and `cosmetic` (left out of the checksum). A titan's own seeded streams (`rnd`, `rq`) are unchanged and stay separate; titan ids restart at 1 with each game so a seed repeats |
| `setTimeout` in the flow and missions | `afterMs` in `sim.ts` = `world.after` (game time) |
| HUD, audio, music timers | `realtime.ts` (`later`, `every`, `wallMs`): the few real-time browser uses, kept out of the simulation |
| `analytics.ts` (PostHog, Vercel) | no-op with the same exports |
| sky, fog, tone mapping, exposure, IBL, bloom, grade, vignette, grain | `config/look/day.json`, `varn.json`, `dawn.json` (see gaps); `setAtmosphere` switches the look; `installAerialFog` (a global fog-curve patch of three) is kept |
| audio context | `hull/audio`'s `AudioContext` and master bus (new `AudioView.context` and `bus()`); AOTT's synthesis is unchanged |
| leaderboard, civilian markers, HUD | DOM overlays as before |
| `window.game`, `window.stepGame` | kept as dev conveniences in the browser; `window.cfg` is the live `CFG` |

`three` is imported from `hull/three` everywhere (the engine's own copy, including the four addon helpers AOTT uses).

## 3. Engine changes made for this (all additive, tested, documented)

* `hull/three`: re-export of the engine's three, plus `mergeGeometries`, `mergeVertices`, `ImprovedNoise`.
* `SceneObject` (render behaviours): a game-owned `Object3D` under a node. `backendScene(world)`: the scene the backend draws in.
* `hull.json` `render.backend` (`auto|webgl2|webgpu`): the boot page passes it to `mountRender`. Schema, SCHEMAS.md, tests.
* `AudioView.context` and `AudioView.bus(name)`: a game's own Web Audio joins the engine's context and mixer.
* Bug fix in the project server: it crashed on start when files had changed since the history last looked
  (`restart.e2e.test.ts`).

## 4. Dropped or stubbed in phase 1

* **PostFX, SpeedLines, ImpactFrame** (they drew over the raw renderer). Bloom, contrast, saturation, vignette and grain
  are the look's post chain, at AOTT's old values. Speed streaks and the nape-cut impact frame are gone
  (`game.impactFrame` stays null; Hull's look has `speedBlur` but does not draw it yet).
* **Sky light**: AOTT baked an image light from a sky gradient with its own PMREM. The look bakes one from a flat sky
  colour (the fog colour), so metals and cloth see a uniform fill, not a blue zenith over a green ground.
* **The sun and hemisphere light** stay in the game's scene (`world.ts`, with its shadow frustum following the soldier);
  the look's own sun and ambient are set to zero. The look supplies tone mapping, exposure, sky light, post.
* The loading screen, the phone gate, `index.html`, the icons and the web manifest. Analytics.
* Quality changes call `render.setQuality` and the pixel-ratio cap and refit the sun's shadow frustum; the old
  per-quality post setting is the engine's tiers.
* `dev/audio.html` and `dev/run.html` (benches) were not copied; the sound bench belongs to package 1 below.

## 5. Known gaps

* **Not judged by a person**: no sound was heard (the page's audio context stays suspended in the headless browser,
  though the game's synth is attached to Hull's context and its master bus); mouse look with pointer lock, the feel of
  the soldier and of hit-stop, the title screen and the cutscene were not played by hand.
* **Frame cost**: the whole frame now runs per 120 Hz step, with no interpolation between steps. At a 60 Hz screen that
  is two full frames of work per drawn frame; at 144 Hz some frames draw the same state twice. Measured only in
  headless Chrome (about 60 fps at 1280 by 720 on software GL, so not a real GPU figure). A phase-2 split of the cheap
  fixed work from the heavy per-frame work (with camera interpolation) is open.
* **WebGPU**: the custom GLSL has no WebGPU form.
* **Tuning files**: the blocks are code-owned tunables, so the Inspector's edit rewrites the literal in `src/tuning.ts`
  (journalled and recorded in the history, applied to the running game at once, no reload). A `config/tuning/<block>.json`
  file would override per project, but a file holding every key would shadow the literal after a reload, so none ships.
  Lists of numbers (the rope fan angles in `CFG.keys`) are not tunable; bounds on each number are generic (0 to four
  times the value).
* `Game.audio` does not init until the page has Hull's audio (first frame) when a mode starts from the page's address.
* Static titan and world builders still read module state (`let _mat`, texture caches) that survives from one game to
  the next in one process; they do not affect the simulation but would matter for a hot-swapped second world.
* Hull's `render` stats count only the last pass of the post chain (one draw call, one triangle).

## 6. Phase 2: six packages that can run in parallel

Shared rules: the `Game` object (`src/types.ts`) is the contract between packages; add optional fields only, never
rename or retype. `src/host.ts` is the one shared file: each package edits only the block named for it. Every package
keeps `pnpm typecheck`, `pnpm test` (including `main.test.ts`) and `pnpm project:check examples/aott` green. A package that changes what
the Holdout test measures (a new checksum) says so in its commit and updates the test's expectations deliberately.

### P1. Sounds -> `sound` configs and the sound bench

* **Owns**: `src/audio/**`, `config/sound/**`, `config/mixer/**`, the `game.audio` block of `host.ts`.
* **Does**: move AOTT's synthesised sounds (the one-shots in `sfx.ts`, `moves.ts`, `cues.ts`; the loops in `loops.ts`; the score
  in `music.ts`) to `sound` recipes (code generators registered with `registerGenerator` where a recipe cannot say it), mixed
  on `mixer/main` buses, played with `hull.audio.play`.
* **Interface**: `Game.audio` keeps every method name callers use today (`footstep`, `hookFire`, `setReel`, `titanGroan`,
  `setMusic`...), so no caller changes; they become thin maps onto `play(id, { at })`, `setBus` and a continuous-loop
  adapter. Reads `views().audio` as now; headless stays silent.
* **Done when**: every sound has a recipe that renders and measures on the sound bench (peak, no clipping, expected
  length), the game plays only through `hull/audio`, `src/audio/dsp.ts` and the old engine are gone, and a recorded
  Holdout reproduces the same sound-id counts twice.

### P2. People and titans -> `character` and anim configs on the character bench

* **Owns**: `src/player/model.ts`, `src/player/materials.ts`, `src/titans/builder.ts`, `rig.ts`, `ik.ts`, `config/character/**`,
  `config/anim-set/**`, `config/anim-graph/**`, `config/material/**`.
* **Does**: first the soldier, comrades, civilians and horse (`PlayerModel`), then the titan archetypes (`builder.ts` bodies,
  `rig.ts` joints), as `character` configs posed by anim graphs. Hull's characters are rigid parts, not skinned: the
  titans' hit and collider shapes follow joints, so keep that mapping.
* **Interface**: `PlayerModel` keeps `root`, `hookOrigin`, `update(dt, state)` and the pose input the player builds;
  the titan rig keeps joint objects and `hit`/`collider` shapes that `titan.ts` reads. Does not edit `titan.ts` or `player.ts`
  beyond the call that constructs a model.
* **Done when**: the soldier and one titan archetype load from config, show on the character bench with the anim graph
  driven, play in Holdout with no visible difference in pose or hit zones (screenshots compared), and a rebuilt model
  changes live when its config is edited.

### P3. Effects -> `vfx` configs (done)

* **Done**: `Effects` in `src/fx/effects.ts` keeps every call (`impact`, `steam`, `blood`, `sparks`, `gas`, `leaves`, `skidDust`,
  `lightning`, `flare`, `hookBite`, `slashArc`, `impactFrame`...) and plays 21 configs in `config/vfx/`: `steam` and
  `steam-red|black|green|yellow|purple` (flare smoke), `gas`, `blood`, `blood-mist`, `chip-stone|wood|bark|roof|dirt`,
  `dust-stone|dirt`, `sparks`, `spark-flash`, `leaves`, `skid-dust`, `lightning-dust`. The file went from 1445 to about 940 lines:
  the texture atlas, the particle pool and its shader are gone. Random numbers stay on `R.fx` / Hull's cosmetic stream.
* **Engine changes** (`hull/vfx`, additive, tested in `vfx.test.ts`): `vfx.burst(id, at, dir, { count, size, speed, life, spread })`;
  `particle.ground` (`die|bounce|rest`) with `vfx.setGround(fn)`; `particle.flutter`; sprites `chip` and `leaf` (WebGL2 and WebGPU
  shaders). Schema, `schemas/vfx.schema.json` and SCHEMAS.md section 10 updated.
* **Still in code** (a particle emitter cannot say them): ground decals (blood splats, boot scrapes), the blade smear, slash
  arcs, the lightning bolt ribbon, light pillar, ground rings, the screen flash and strike light, and the flare's rising
  streak (a position that moves, calling `steam`). The light pillar is not a `vfx` emitter.
* **Differences from the old look**: the particle sprites are Hull's procedural ones, not AOTT's painted atlas (so steam is noisier,
  chips are squares); a drop that dies no longer leaves a steam wisp and blood does not steam in flight (the stain decal does,
  and is laid down by predicting where a sample drop lands); steam puffs no longer keep their lower edge above the ground by
  their size (`rest` holds them just above it); the old pool recycled its oldest particle when full, vfx skips new ones;
  hit-stop and slow motion do not slow particles (they run on Hull's step); per-particle colour pairs (a chip is stone or
  dark stone) became one start-to-end colour curve. Custom flare colours other than the five named ones play as plain steam.
* **Checked**: typecheck, `pnpm test` (463 tests), `hull check`; in a browser (agent-browser, WebGL2) a throwaway test hook fired
  every call and `vfx.stats()` showed all 15 effects spawning with 0 dropped; screenshots show the steam, flare smoke, gas,
  leaves, dust and blood drops. **Not judged**: no side-by-side against the old effects from the same camera, the look of
  steam and blood against the original, how it feels in play, WebGPU.

### P4. Look, sky and post

* **Owns**: `config/look/**`, `src/core/look.ts`, `src/world/sky.ts`, the `setAtmosphere` and quality blocks of `host.ts`.
* **Does**: bring back what phase 1 dropped or flattened: a gradient sky light, the sun and hemisphere as the look's own
  (retiring the scene's lights and `followSunShadow` in favour of the look's sun), the per-atmosphere looks tuned
  against screenshots, speed streaks and the impact frame as post (engine work: draw `speedBlur`, add an impact pulse,
  additive, tested).
* **Interface**: `world.setAtmosphere(name)` keeps its names; `game.world.sun` and `hemi` may go away only if `world.ts`
  and `titans` stop reading them in the same change.
* **Done when**: day, varn and dawn look the same or better than the standalone game in side-by-side screenshots, no
  light of the game's own remains in the scene, and editing a look in the app changes the page at once.

### P5. Collision -> `hull/physics` where it fits

* **Owns**: `src/core/collision.ts` and its parity test.
* **Does**: find what `hull/physics` can answer (static boxes, cylinders, spheres, the height-field ground, rays, sphere
  sweeps) and move those onto it, leaving titan limbs, `removed` colliders and merged-mesh houses on the game's own code
  if they do not fit.
* **Interface**: `CollisionWorld` keeps `raycast`, `collideSphere`, `querySphere`, `groundHeight`, `add*`, `remove`, `_register`,
  `updateDynamic`, the `material` and `hookable` fields and the `removed` flag.
* **Done when**: a parity test runs 10 000 seeded queries against the old implementation (kept in the test) and agrees
  within epsilon, the Holdout test passes (new expectations only if explained), and a frame-time bench shows no loss.

**P5 status (done).** `src/core/collision.ts` now answers boxes (oriented), spheres and capsules, static and dynamic (titan limbs),
from `hull/physics`: `raycast` is `Physics.raycast`, `querySphere` is `overlapSphere`, `collideSphere`'s push-out is `overlapSphere` plus
`distanceTo` (depth is radius minus signed distance, normal is the direction away). Layer bits say static or dynamic and hookable
or not, so `dynamic: false` and `hookableOnly` are masks. `ignore` sets and "a ray that starts inside a box is not a hit" switch
the shape off for the cast. Colliders are still the game's objects (`material`, `hookable`, `removed`, `userData`, the world-pose fields
`player.ts` reads); each holds its physics shape in `_phys`, and `remove`/`_register` keep it in step (town houses). `new CollisionWorld(world)`
now takes the Hull world (installs physics if the game has none). Left in game code, on purpose: vertical **cylinders** (no cylinder
shape in `hull/physics`; trunks and posts, in a small grid) and the **ground**, which is an analytic function of x and z (a sampled
`heightfield` would change what the soldier stands on). Known difference: a ray that starts inside a capsule is reported at distance 0
(as for a sphere); the old code answered null or the far cap's entry. `collision.parity.test.ts` runs 10 000 seeded queries against the old
implementation (`collision.legacy.ts`, kept for the test only): 0 mismatches; bench of 60 000 queries: 74 ms now, 117 ms before.

### P6. Kits: camera, health with hit zones, pickups, spawner

* **Owns**: the camera section of `src/player/player.ts` (`_camera`, `_cineCamera`), `src/game.ts` waves (`WAVES`, `_nextWave`,
  `_spawnSome`), the supply depots and refill code, the damage entry of `titan.ts` (`applyHit`) and the player's hit points.
  Config: `config/spawner/**`, `config/pickups/**`, `config/health/**`, `config/third-person/**` (names as the kits define them).
* **Does**: map what matches. The follow camera onto `hull/kits` follow-camera (keeping the swoop, kill-cam and cutscene
  shots as overrides); waves onto the spawner kit (waves, caps, trickle, areas); gas and blade supply onto pickups; titan
  parts (nape, eye, ankle, arm, hand, body) and the soldier's hit points onto health with hit zones. Anything the kits
  cannot say stays in code, noted here.
* **Interface**: `titan.applyHit({ part, damage, point, dir })`, `flow.wave`, `flow.waveClear` and the events in the architecture
  catalogue (`titan:killed`, `player:hurt`...) keep their shape. Touches `player.ts` only in the camera and refill regions
  (P2 and P5 do not edit that file).
* **Done when**: each mapped behaviour reads its numbers from kit config shown in the Inspector, Holdout still advances
  its waves on the clock, and the follow camera, depots and hit zones behave as in screenshots and a recorded replay.

**P6 status (done).** Hull's kits are node-based (Spawner makes its own Chaser enemies, Health and Stock sit on nodes), and AOTT's
titans, soldier and camera are not nodes, so the kits could not be dropped in as they are. What matched was taken out of
the kits as pure maths and clocks (additive in `packages/hull/src/kits`, each with a test and README line) and AOTT now
reads every number from tunables shown in the Inspector (`config/tuning/<block>.json` overrides per project):

* **Waves**: `hull/kits` `stepWaves`, `beginWave`, `waveScale` over the `waves` block (clear pause, clock, cap, stragglers,
  first delay, growth, the wave-1 and gate-down spawn boxes) and `wave1`..`wave4` (counts per area, abnormals, sizes).
* **Depots**: `stepDepot`, `fillTo` over the `depot` block (dwell, cooldown, how full gas, blades and bandages get).
* **Hit zones and hit points**: `zoneEffect`, `coveredDamage`, `regenerate` over the `zones` block (shallow line, eye, ankle,
  shin, arm cut depths, nape cover, blind time, soldier regen delay and rate). `titan.applyHit` keeps its shape.
* **Camera**: `followDistance`, `followFov`, `Reach`, `damp` over the extended `cam` block (distance per speed, glide rates,
  bank, lens opening, punch). The swoop lock-on, grab, kill-cam and cutscene shots stay as code overrides in `player.ts`.
* **Left in code**: the banner text of each wave and the Behemoth on wave 3; the orbit camera itself (AOTT's mouse-yaw,
  flight-path follow and pitch rules are not the kit's `FollowCamera`); what a cut limb does to a titan. Defaults equal
  the old literals, so Holdout's clock (wave 2 at 86 s) is unchanged. Not judged by eye: no screenshots or replay were taken.

### Where the packages touch

| File | Package |
|---|---|
| `src/audio/**` | P1 |
| `src/player/model.ts`, `materials.ts`, `src/titans/builder.ts`, `rig.ts`, `ik.ts` | P2 |
| `src/fx/effects.ts` | P3 |
| `src/core/look.ts`, `src/world/sky.ts`, `config/look/**` | P4 |
| `src/core/collision.ts` | P5 |
| `src/player/player.ts` (camera, refill), `src/game.ts` (waves), `src/titans/titan.ts` (`applyHit`) | P6 |
| `src/host.ts` | blocks named above; one change at a time |
