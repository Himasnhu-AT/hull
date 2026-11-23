# level kit

Two levels for the other kits to stand on: `Level`, built from a `config/level` file (ground, blocks and ramps, prefab things, named markers, seeded scatter), and `ArenaLevel`, a square arena made in code.

- **Behaviours**: `Level` (`built.ts`), `ArenaLevel` (`level.ts`). Both satisfy `LevelLike` (`kits/common.ts`): `half`, `bounds`, `hits(x, z, hx, hz)`,
  `freeSpot(out, margin, stream, awayX, awayZ, awayFrom)`, `marker(name)`, `markers(prefix)`, `things(prefab)`. The pickups and spawner kits take a `LevelLike`.
- **`Level` extras**: `level` (the config id, set when adding), `look` (the look id the file names), `blocks` (floor boxes of everything solid).
- **Checkers**: `checkLevel(def, at)`, `checkPrefab(def, at)` (`check.ts`): strings that name their place, `level/yard#/things/0/at: ...`.
- **Tunables**: `ArenaLevel` only (`level` block, read once at start): `size`, `wallHeight`, `crateCount`, `crateMin`, `crateMax`, `clearRadius`. `Level` takes everything from its file.
- **Config** (`config/`): `level/yard` (a ramp up to a platform, a pillar, crates, lamps, markers, rocks scattered), `prefab/crate|lamp|rock`, `material/floor|wall|crate|stone|lamp`, `look/day`. Format: docs/SCHEMAS.md section 11b.
- **Random streams**: `ArenaLevel` uses `level`; `Level` uses the `stream` of each scatter rule, and whatever stream `freeSpot` is given.
- **Wiring**: nothing else is needed; physics is installed if the game has not.
- **Bench**: `bench.ts` (default: the arena; `yard`: the config level). **Tests**: `level.test.ts` (arena), `built.test.ts` (kinds, references, same seed same checksum, markers and things, no allocation per step, and a game built from a level file with the pickups and spawner kits).

## Use it

```ts
usePhysics(g.world);
const level = g.world.spawn('level').add(Level, { level: 'yard' });
const start = level.marker('start')!;
spawnFirstPerson(g.world, { x: start.x, z: start.z, yaw: start.yaw });
scatterPickups(g.world, level, 'health', 4);
g.world.spawn('spawner').add(Spawner, { level });
for (const crate of level.things('prefab/crate')) crate.add(Breakable); // game code adds behaviours to what the level built
```

## Wiring

- Spawn it before everything that stands on it. It installs physics itself.
- Both: `kit.add {"kit":"level"}` copies `level/yard` (the example level), the prefabs it names, their materials and `look/day`. `Level` reads a level file (make your own with `asset.new {"kind":"level","id":"level/mine"}` and edit it with `config.set`); `ArenaLevel` needs `material/floor`, `material/wall`, `material/crate` and `look/day`.
- Behaviours are not named in a level file: game code adds them to `level.things(prefab)` and places actors at `level.marker(name)`.
