# projectile kit

Shots that fly through the world, sweep each step so they never tunnel, hurt a Health once, and are reused from a pool.

- **API**: `fire(world, origin, dir, { speed, gravity, damage, radius, life, from, mask, hitSound })` returns the shot's node.
  `Launcher` fires along its node's forward on an input action (`action`, `rate`, `muzzle`, `speed`, `damage`, ...; signal `fired`).
  `projectilesOf(world)` is the pool: `live`, and signal `hit(target | null, x, y, z, applied)` for every shot that ended on something.
- **Rules**: each fixed step a ball of `radius` is swept from the shot's position along its velocity (`physics.spherecast`), so
  200 m/s does not pass a 0.2 m wall. The first shape on `mask` ends it; the Health there (or above it) is hurt once with the zone tag
  of the collider. The shooter's own Health (`from`) never stops or hurts its shot. A shot that hits nothing frees itself after `life`.
- **Pool**: nodes are made on first use (`projectile0`, ...) and reused; after warm-up a shot allocates nothing. Pass the same
  options object every time in hot code.
- **Tunables** (`projectile` block): `speed`, `damage`, `radius`, `life`, `gravity`.
- **Config**: `material/projectile`, `sound/projectile-hit`.
- **Wiring**: physics in the world; targets need a `Health` and a collider on a layer in `mask` (default world, player, enemy).
- **Bench**: `bench.ts`. **Test**: `projectile.test.ts` (no tunnelling, one hit, allocation, replay).

## Use it

```ts
const me = spawnFirstPerson(world);
me.get(FirstPerson)!.eye.add(Launcher, { action: 'fire', speed: 200, damage: 20, rate: 6 });
// or from code:
fire(world, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, { speed: 80, from: me });
projectilesOf(world).hit.connect((target, x, y, z) => { /* spark at (x, y, z) */ });
```
