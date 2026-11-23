# Writing a game with Hull

Hull is a TypeScript game engine. You write the game in `src/` (TypeScript, strict) and its data in `config/` (JSON); a person
checks it in Hull Studio; it builds to one JavaScript file for the web and the desktop. You verify your own work through
tools: run `check`, run the game, read its state, look at a picture. Start from a template (`templates/arena` is the
smallest complete game) and read `docs.list` for kits, config formats and the API.

## Lifecycle

* `export default defineGame({ ready(game) { ... } })` in `src/main.ts` (named in `hull.json` `entry`). `ready` builds the
  world: `game.world.spawn('name')` makes a node, `node.add(Class, { fields })` attaches a behaviour.
* A behaviour is a class extending `Behaviour` with optional `ready()`, `fixedUpdate(dt)`, `update(dt, alpha)`, `dispose()`.
  `this.node` and `this.world` are set before `ready`, so a constructor cannot use them.
* **`fixedUpdate(dt)`** runs at the manifest `step` rate (60 Hz) and holds all gameplay: movement, rules, timers. It is
  deterministic. **`update(dt, alpha)`** runs once per drawn frame for what only looks: camera smoothing, interpolation
  (`alpha` is the share of the next step). Never put rules in `update`.
* **Spawn order is update order.** Nodes and behaviours step in the order they were spawned and added, so spawn what others
  read first (level, round), then the player, then what reads where the player ended up (camera).
* **Remove a node with `node.destroy()`** (there is no `remove`, `delete` or `dispose` on a node). It takes effect at the end of the
  current step: the node, its children and their behaviours go (each behaviour's `dispose()` runs), signal connections that named it as
  owner end, and `node.destroyed` is true. Do not read a destroyed node later, and drop your own references to it. There is no call that
  removes one behaviour: destroy the node, or keep a flag the behaviour reads.
* Groups: `node.addTo('enemy')`, `world.group('enemy')`. Find a node: `world.find('player')` (a path like `player/model`).
* Signals: `readonly died = signal<[from: Node | null]>()`; `other.died.connect(fn, owner?)`; `died.emit(from)`. A connection
  that names an owner node ends when the owner is destroyed.
* Time and chance come from the world, never the clock: `world.after(seconds, fn)`, `world.every(seconds, fn)`,
  `world.random('name').range(a, b)` (a named stream; the same seed gives the same run). The house rules in `check` refuse
  `Math.random`, `Date.now`, `performance.now`, `setTimeout` and `setInterval` in `src/`.
* No allocation per step in hot code: keep scratch objects in fields.

## State and the checksum

Fields that are gameplay state are listed in `static override state = ['score', 'timeLeft']`. They are in the world checksum
(`world.checksum()`), in saves, and in replays. Anything not listed (caches, meshes, UI) is not state and must not change
what the simulation does. A game that runs twice from one seed and one input recording must give one checksum: that is
the determinism test, and a field you forgot to list is what breaks it.

## Tunables and config

* **Tunables** are numbers one piece of code owns, declared once: `export const player = tunables('player', { runSpeed: num(7, { min: 1, max: 20, unit: 'm/s' }) })`,
  read as `player.runSpeed`. The Inspector turns them live; `tunables.set` rewrites the literal in the file. Block names are unique
  across the game and the kits it imports.
* **Config** is structured data shared between code and tools: sounds, materials, looks, characters, screens, input maps. One
  JSON file per id under `config/<kind>/`; reference it in code by its full id, like `'material/gem'` or `'sound/pickup'`.
  Formats: `docs.read guide/schemas`. `check` reports a bad value as `file#/pointer` and a name in `src/` that no config
  answers to (`"material/playr"`) with the nearest real id. Change values with `config.set` / `tunables.set`, not by hand.
* Rule of thumb: used by one class and nobody else, a tunable; has structure or is read by tools, a config file.
* **Kit config is not in your project until you add it.** A kit's code reads config it ships (`TitleScreen` opens
  `ui-screen/title`, `Spawner` draws with `material/enemy`). `kit.list` shows each kit, its one-line summary and its files;
  `kit.add {"kit":"menu"}` copies the files your project lacks into `config/` (files you already have are kept and listed; it is
  validated and recorded under your name). `check` reports a kit imported without its config at the import's `file:line:col` and
  names the `kit.add` call; without the files the game runs, logs a warning every frame and draws nothing.
* **New config of your own** (a level, a prefab, a material, a screen, any kind): `asset.new {"kind":"level","id":"level/arena"}` writes a
  starter that passes `check` (a level or prefab starter also creates `material/starter` when you have no such material), then
  `config.set` changes its fields. `code.write` only reaches `src/`; `config.set` on a file that does not exist answers with the
  `asset.new` call to make.
* Input and sound go through a small module (`rig.ts` in the arena template) so a test can replace them.

## ui-screens: what the names in a screen mean

A `ui-screen` is a JSON tree (`config/ui-screen/<id>.json`) of widgets: each node has exactly one widget key (`panel`, `stack`, `row`,
`title`, `text`, `bar`, `button`, `image`) and optionally `on` and `children`. Three kinds of name connect it to your code:

* **`bind`** (on `text`, `title`, `bar`) and **`visible`** (any node) name a value in the *view model*: the object you pass as the second
  argument of `ui.screen('ui-screen/title', vm)`. A dotted name walks it (`"bind": "slot.1"` reads `vm.slot['1']`); if the value is a
  function it is called every frame, so put getters in the view model (`vm.score = () => this.points`) and the text follows. A `bar`
  needs `bind` and takes `max` as a number or as another name (`"max": "player.maxHp"`). `format` is a template with `{}` for the value
  (`"Score {}"`); `visible` shows the node while its value is truthy. A name the view model lacks reads as empty or 0, silently.
* **`on.press`** (a button) and **`on.back`** (a panel, for Escape) name an *action*: you register it with `ui.action('title.start', () => ...)`
  where `ui = kitIO.ui()` (null until the page has a UI layer: check it each frame and wire when it appears, as `PauseMenu` does).
* **`@key`** text is looked up through `ui.setStrings`; without it the key itself shows.

Worked example, the pause kit: `config/ui-screen/pause.json` has a `button` with `"on": { "press": "pause.resume" }` and rows whose `text`
has `"bind": "slot.1"`; `PauseMenu` sets `vm.slot = { '1': () => label }` and `vm.message = () => text`, calls
`ui.action('pause.resume', () => this.set(false))`, and opens it with `ui.screen('ui-screen/pause', this.vm)` while paused. `kit.add` puts the
kits' screens in your project: edit the JSON to restyle them, keep the names the kit's README lists (`title.start`, `result.again`,
`stat.N.label`).

## A whole small game

```ts
// src/main.ts: a coin that moves to a random spot when touched; 30 seconds to score.
import { Behaviour, defineGame, num, signal, tunables } from 'hull';
import { Mesh } from 'hull/render';
import { kitIO } from 'hull/kits';

export const coin = tunables('coin', { reach: num(1.2, { min: 0.2, max: 4, unit: 'm' }) });

class Score extends Behaviour {
  static override state = ['points', 'timeLeft'];
  points = 0;
  timeLeft = 30;
  readonly scored = signal<[points: number]>();
  override fixedUpdate(dt: number): void {
    this.timeLeft = Math.max(0, this.timeLeft - dt);
  }
}

class Mover extends Behaviour {
  private v = { x: 0, y: 0 }; // scratch, reused every step
  override fixedUpdate(dt: number): void {
    kitIO.input.vec2('move', this.v);
    this.node.position.x += this.v.x * 6 * dt;
    this.node.position.z += this.v.y * 6 * dt;
  }
}

class Coin extends Behaviour {
  override fixedUpdate(): void {
    const score = this.world.find('score')!.get(Score)!;
    if (score.timeLeft === 0) return;
    const me = this.world.find('player')!.position;
    const p = this.node.position;
    if (Math.hypot(me.x - p.x, me.z - p.z) < coin.reach) {
      score.points += 1;
      score.scored.emit(score.points);
      const r = this.world.random('coins');
      p.set(r.range(-8, 8), 0.5, r.range(-8, 8));
    }
  }
}

export default defineGame({
  ready(game) {
    const w = game.world;
    w.spawn('score').add(Score);
    const me = w.spawn('player');
    me.add(Mesh, { shape: 'box', material: 'material/player' });
    me.add(Mover);
    const c = w.spawn('coin');
    c.position.set(4, 0.5, 4);
    c.add(Mesh, { shape: 'box', material: 'material/gem' });
    c.add(Coin);
  },
});
```

The Mover reads the `move` action through `kitIO.input` (the one door a test can swap); the `input-map/play` config binds it. Read `templates/arena` for the full version with a
camera, a HUD, sound and a test.

## A test (15 lines)

```ts
// src/main.test.ts: runs in Node under `test`; `hull` and `hull/<module>` resolve to the engine.
import { fileURLToPath } from 'node:url';
import { projectSources, startRig } from 'hull/kits/testing';
import { expect, it } from 'vitest';
import game from './main.ts';

const sources = projectSources(fileURLToPath(new URL('..', import.meta.url)));

it('the same seed and input give the same run', async () => {
  const a = await startRig(game, sources, 'play', 5);
  a.step(120, { move: { x: 1 } });
  const b = await startRig(game, sources, 'play', 5);
  b.step(120, { move: { x: 1 } });
  expect(a.g.world.checksum()).toBe(b.g.world.checksum());
  expect(a.g.world.find('player')!.position.x).toBeGreaterThan(5);
});
```

Where each testing helper lives (a wrong path is a type error in `check`, which type-checks test files too):

| Import | From |
|---|---|
| `projectSources`, `kitSources`, `startRig`, `runScenario`, `ALL_KITS`, type `Rig` | `'hull/kits/testing'` (Node only) |
| `InputCore`, `wireInput`, type `StepSnapshot` | `'hull/input'` |
| `config`, `startGame`, `defineGame`, `probe`, types `ConfigSource`, `Game` | `'hull'` |
| `kitIO` and every kit class (`Hud`, `TitleScreen`, `Stock`, ...) | `'hull/kits'` |
| `describe`, `it`, `expect`, `beforeAll` | `'vitest'` |

`kitSources('level', 'menu')` is the default config of those kits (for a test that does not load your project); `projectSources(root)` is
your `hull.json` plus everything in your `config/`. `startRig(game, sources, 'play', seed)` starts the game with a headless input mapped by
`input-map/play` ('' for none); `rig.step(n, { move: { x: 1 } })` holds an input for `n` steps; `runScenario` records one.

`test` reports a failure at your own file and line (the deepest frame inside `src/`) with the assertion's message.

## How to verify

Never say a change works because it compiled. After every change: `check` (types, config, references, house rules; it must
say ok), `test`, then run the game with `game.run` and read what happened. A `game.run` with no app open starts a headless
page for you. Time only moves when you step it, so a script gives the same result every run.

* `{"op":"step","n":120}`: run 120 fixed steps (pauses the game). Answers tick, time, checksum.
* `{"op":"press","key":"KeyW"}` / `{"op":"release","key":"KeyW"}`: hold a key (also `Mouse0`).
* `{"op":"state","nodes":["player","coin"]}`: tick, time, checksum, positions of the named nodes, held keys, probes.
* `{"op":"inspect","node":"player"}`: position, rotation, scale, groups, children, behaviours with their state fields.
* `{"op":"tree","depth":3}`: node paths with their behaviours; repeated siblings are one line (`level/crate x14  [Mesh]`).
* `{"op":"until","when":{"node":"score","field":"Score.points","cmp":">=","value":3},"max":600}`: step until it holds.
* `{"op":"errors"}`: what threw or warned (with file:line:col in `src/`); `{"clear":true}` empties it. A step that throws
  fails with the place, and the world may be part-stepped: `{"op":"restart"}` before trusting state.
* `{"op":"restart"}`: start again from ready, same seed, paused at tick 0.
* `{"op":"perf"}`: step and frame times, node count, and the draw calls and triangles of one frame (the same number whether you time 1 step or 120 on a scene that does not change).
* `{"op":"look","dx":40,"dy":0}`: mouse movement as the game sees it under pointer lock.
* `{"op":"screenshot"}`: a picture of the game, 640x360 headless (the UI is drawn over it; `"ui":false` for the 3D view only).
  `"width"` and `"height"` (whole pixels, up to 1920x1080) render that one picture at that size and put the page back, so the
  UI scales and wraps as it would on that screen; `frames` takes the same two fields.
* `{"op":"ui"}`: what a person could read now: `screens` (ids of the ui-screens showing) and `items` (`text`, `button` with
  `focused`/`disabled`, `bar` with `value` and `max`; each with its `panel` label), top to bottom, hidden things left out, 80 at most.
* `{"op":"click","button":"Start"}`: click the button whose text matches (any case; a unique part of the text works) or the nth
  from 0. It fires what a person's click fires. A miss fails and names the buttons that are showing. `press` / `release` of `Enter`,
  `Space`, `Escape`, `Tab` and the arrow keys also reach the UI: a focused button activates on Enter or Space, Escape goes back.
* `{"op":"frames","count":6,"every":10}`: one picture tiling six moments, to judge motion.
* A game exposes numbers worth watching with `probe('score', () => points)` in `ready`; `state` and `until` read them.

Scripts in one call: the `play` tool runs a list of steps (press, step, until, expect, screenshot, `click`, `expectUi`, `ui`) and fails with the
place of any error the game logged. `{"click":"Start"}` clicks a button, `{"expectUi":{"text":"Victory"}}` fails unless some visible item
contains that text, `{"ui":true}` records the items in the report, and a `screenshot` step takes `width` and `height` too. Effects are
deterministic under stepping: the same script gives byte-identical pictures, so a golden with an effect on screen holds at the
default tolerance. `problems.list` also carries what the running game logged and nobody has read yet (rule `runtime`). `game.recent` lists the sounds and effects of the last seconds, which is how you
check something that cannot be seen. Read `errors` after a run; a clean state is not proof the game did not warn.

When you cannot judge something (how a hit feels, how a sound sounds), say so, and `review.set` the piece
`needs-change` or leave it for the person. Your changes are recorded in `history.list` under your name; a value the person
set is flagged by `check` if you overwrite it.

## Where to read next

`docs.search {query}` finds a section; `docs.read {id, section}` reads it. `kit/index` lists the ready gameplay pieces (fps,
third-person, health, pickups, spawner, combat...): use a kit before writing the same thing, each README ends with a snippet
and what must be wired. `guide/schemas` has every config format. `api/<module>` lists a module's exports.
