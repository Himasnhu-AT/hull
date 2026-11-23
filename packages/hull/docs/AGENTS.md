# Working on this Hull game

Hull is a TypeScript game engine. You write the game in `src/` (strict TypeScript) and its data in `config/` (JSON). A person
checks it in Hull Studio. You verify your own work with the Hull tools (MCP server `hull`, or the app's agent). The full
guide is `docs.read guide/engine`; `docs.search` finds a section; `kit/index` lists ready gameplay pieces. Use a kit before writing the same thing.

## Rules of the code
* A game is `export default defineGame({ ready(game) {...} })`: `game.world.spawn('name').add(Behaviour, {fields})`.
* Gameplay lives in `fixedUpdate(dt)` (60 Hz, deterministic); `update(dt, alpha)` is for what only looks. Spawn order is update order.
* Game time only: no `Math.random`, `Date.now`, `performance.now`, `setTimeout`, `setInterval` in `src/`. Use `world.after`, `world.every`,
  `world.random('stream')`. `check` refuses the others.
* Gameplay fields go in `static override state = ['score']`: they are in the checksum, saves and replays.
* Do not allocate per step; keep scratch objects in fields.
* Numbers one class owns are `tunables('block', { x: num(1, { min, max, unit }) })`. Shared or structured data (sounds, materials,
  looks, characters, screens, input maps) is a config file: `config/<kind>/<id>.json`, named in code as `'<kind>/<id>'`.
* Change values with `config.set` / `tunables.set`, code with `code.edit`; they validate and record your name in the history.
* Games never touch the renderer or three.js directly: use `hull/render`. Input and sound go through a small module so tests can swap them.

## Before you say it works
1. `check` says ok (types, config, references, house rules; a name like `"material/playr"` with no config is a problem).
2. `test` passes (`src/**/*.test.ts`, run in Node; a failure names your file and line).
3. Run it: `game.run` with `{"op":"step","n":120}`, then `{"op":"state","nodes":["player"]}` or `{"op":"inspect","node":"player"}`,
   then `{"op":"errors"}` (what threw or warned, with file:line:col) and `{"op":"screenshot"}` (a picture you can look at).
   `until` steps to a condition, `restart` starts over, `perf` measures, `frames` tiles several moments in one picture.
4. Say plainly what you could not judge (how it feels, how it sounds).

## Where things are
* `src/main.ts` the game; `src/*.test.ts` its tests; `config/` its data; `hull.json` its manifest (`config.read` id `game`).
* `GAME.md` the brief, if the person wrote one (`brief.read`). `.hull/` is Hull's own: do not edit it.
* `docs.list` shows every document; the config formats are `guide/schemas`; a module's exports are `api/<module>`.
