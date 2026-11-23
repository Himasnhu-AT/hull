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
* Input and sound go through a small module (`rig.ts` in the arena template) so a test can replace them.

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

`test` reports a failure at your own file and line (the deepest frame inside `src/`) with the assertion's message.

## How to verify

Never say a change works because it compiled. After every change: `check` (types, config, references, house rules; it must
say ok), `test`, then run the game with `game.run` and read what happened. A `game.run` with no app open starts a headless
page for you. Time only moves when you step it, so a script gives the same result every run.

* `{"op":"step","n":120}`: run 120 fixed steps (pauses the game). Answers tick, time, checksum.
* `{"op":"press","key":"KeyW"}` / `{"op":"release","key":"KeyW"}`: hold a key (also `Mouse0`).
* `{"op":"state","nodes":["player","coin"]}`: tick, time, checksum, positions of the named nodes, held keys, probes.
* `{"op":"inspect","node":"player"}`: position, rotation, scale, groups, children, behaviours with their state fields.
* `{"op":"tree","depth":3}`: node paths with their behaviours.
* `{"op":"until","when":{"node":"score","field":"Score.points","cmp":">=","value":3},"max":600}`: step until it holds.
* `{"op":"errors"}`: what threw or warned (with file:line:col in `src/`); `{"clear":true}` empties it. A step that throws
  fails with the place, and the world may be part-stepped: `{"op":"restart"}` before trusting state.
* `{"op":"restart"}`: start again from ready, same seed, paused at tick 0.
* `{"op":"perf"}`: step and frame times, draw calls, triangles, node count.
* `{"op":"look","dx":40,"dy":0}`: mouse movement as the game sees it under pointer lock.
* `{"op":"screenshot"}`: a picture of the game (the UI is drawn over it; `"ui":false` for the 3D view only).
* `{"op":"frames","count":6,"every":10}`: one picture tiling six moments, to judge motion.
* A game exposes numbers worth watching with `probe('score', () => points)` in `ready`; `state` and `until` read them.

Scripts in one call: the `play` tool runs a list of steps (press, step, until, expect, screenshot) and fails with the
place of any error the game logged. `game.recent` lists the sounds and effects of the last seconds, which is how you
check something that cannot be seen. Read `errors` after a run; a clean state is not proof the game did not warn.

When you cannot judge something (how a hit feels, how a sound sounds), say so, and `review.set` the piece
`needs-change` or leave it for the person. Your changes are recorded in `history.list` under your name; a value the person
set is flagged by `check` if you overwrite it.

## Where to read next

`docs.search {query}` finds a section; `docs.read {id, section}` reads it. `kit/index` lists the ready gameplay pieces (fps,
third-person, health, pickups, spawner, combat...): use a kit before writing the same thing, each README ends with a snippet
and what must be wired. `guide/schemas` has every config format. `api/<module>` lists a module's exports.
