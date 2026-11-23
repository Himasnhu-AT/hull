# third-person kit

A third-person body with three gears: run, sprint, and boost (fast; it spends the stock `gas` if the node has one).

- **Behaviours**: `ThirdPerson` (node = feet; child `model` holds the character and its `Animator`), `AimFollow`.
  `spawnThirdPerson(world, at, character)` builds the player: body, `Health`, `Stock` (gas), the camera, a melee `Weapon`
  on the `attack` action, health and gas HUD.
- **Animator parameters it feeds**: `speed`, `grounded`, `dead`, triggers `jump`, `hit`, `attack` (the graph in
  `config/anim-graph/locomotion`). With `character = ''` the body is a capsule.
- **Actions**: `move` (relative to the camera's `yaw`), `jump`, `sprint`, `boost`, `attack`.
- **Tunables** (`thirdPerson` block): `runSpeed`, `sprintSpeed`, `boostSpeed`, `boostDrain`, `accel`, `boostAccel`,
  `airControl`, `jumpHeight`, `gravity`, `coyoteTime`, `turnRate`, `radius`, `height`, `modelYaw`, `strideLength`.
- **Config**: `input-map/third-person`, `character/soldier`, `anim-set/humanoid`, `anim-graph/locomotion`, materials, sounds.
- **Bench**: `bench.ts`. **Test**: `third-person.test.ts`.

## Use it

```ts
const level = w.spawn('level').add(ArenaLevel);
spawnThirdPerson(w);   // body, Health, gas Stock, follow camera, melee, HUD; node name "player"
```

## Wiring

- Spawn the pause menu first and the level before the player.
- Add the kit's config with `kit.add {"kit":"third-person"}` (and `kit.add {"kit":"health"}` for `ui-theme/hud`): `input-map/third-person`, `character/soldier`, `anim-set/humanoid`, `anim-graph/locomotion`, materials and sounds.
- Gas pickups (`scatterPickups(..., 'gas', ...)`) fill the `gas` Stock this body makes.
