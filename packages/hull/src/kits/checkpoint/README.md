# checkpoint kit

Places that remember where the player restarts, and a Respawn that brings a dead player back there after a delay with full health.

- **Behaviours**: `Checkpoint` (`id`, `radius`, `height`; signal `touched(by)`; the node's yaw is the facing on return),
  `Respawn` on the player (`delay`, `sound`; `set(x, y, z, yaw, id)`; signal `respawned`; state: the point, `id`, `deaths`, the wait).
- **Rules**: a node in the `player` group inside a checkpoint tells its `Respawn` the point. When the `Health` dies, Respawn waits `delay`
  seconds of game time, then revives the Health (full hit points, short invulnerability), moves the node there, and zeroes the
  walker's velocity (`FirstPerson` and `ThirdPerson` are handled). Before any checkpoint the point is where the player started.
- **Save**: both join the `save` group; the point and the wait are in the save kit's slots, so a loaded game respawns at the same place.
- **Tunables** (`checkpoint` block): `delay`, `invuln`, `radius`.
- **Config**: `sound/checkpoint`.
- **Wiring**: a `Health` on the player (above or on the Respawn's node); the SaveSlots kit for saving.
- **Bench**: `bench.ts`. **Test**: `checkpoint.test.ts`.

## Use it

```ts
const me = spawnFirstPerson(world);
me.add(Respawn, { delay: 2 });
const flag = world.spawn('flag');
flag.position.set(0, 0, -20);
flag.add(Checkpoint, { radius: 2.5 }).touched.connect((by) => { by.get(Respawn)!.delay = 1; });
```
