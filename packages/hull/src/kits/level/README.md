# level kit

A square arena: floor, four walls and random crates, all solid to the physics (layer `world`).

- **Behaviour**: `ArenaLevel` (`level.ts`). Fields `half`, `blocks`; methods `hits(x, z, hx, hz)` and
  `freeSpot(out, margin, stream, awayX, awayZ, awayFrom)`, which the pickups and spawner kits use to find empty floor.
- **Tunables** (`level` block, read once at start): `size`, `wallHeight`, `crateCount`, `crateMin`, `crateMax`, `clearRadius`.
- **Config** (`config/`): `material/floor`, `material/wall`, `material/crate`, `look/day`. Set `floorMaterial`,
  `wallMaterial`, `crateMaterial` to use others.
- **Bench**: `bench.ts`. **Test**: `level.test.ts` (same seed gives the same layout; free spots are free).
- Random stream: `level`. Needs nothing else; installs physics itself if the game has not.

For AOTT: replace it with a level of your own; every other kit only asks it for `half` and `freeSpot`, and for
colliders on the `world` layer.
