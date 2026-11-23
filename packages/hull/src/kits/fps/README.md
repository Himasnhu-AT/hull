# fps kit

A first-person body: capsule on the physics mover, mouse look, WASD relative to the view, sprint, jump with
coyote time, footsteps and landing sounds.

- **Behaviours**: `FirstPerson` (node = feet, child `eye` carries the `Camera`), `Crosshair` (HUD dot).
  `spawnFirstPerson(world, { x, z, yaw, gun })` builds the whole player: body, `Health`, gun (`Weapon` on the eye), health bar, crosshair. `gun: false` leaves out the `Weapon` and the gun mesh (a game where the player does not shoot).
- **Actions it reads**: `move`, `look` (mouse delta), `lookPad` (arrows or right stick), `jump`, `sprint`; the gun reads `fire`.
- **Tunables** (`fps` block): `walkSpeed`, `sprintSpeed`, `accel`, `airControl`, `jumpHeight`, `gravity`, `coyoteTime`,
  `eyeHeight`, `radius`, `height`, `mouseSensitivity`, `padLookSpeed`, `pitchLimit`, `fov`, `strideLength`.
- **Config**: `input-map/fps`, `material/gun`, `sound/footstep`, `sound/thud`, `sound/shot`.
- **Bench**: `bench.ts`. **Test**: `fps.test.ts` (walk, sprint, walls, look, jump, same checksum twice).
- Stops while the pause menu is open. The body is in the `player` and `save` groups.

## Use it

```ts
const level = w.spawn('level').add(ArenaLevel);
spawnFirstPerson(w);   // body, eye camera, gun, health bar, crosshair; node name "player"
spawnFirstPerson(w, { x: 4, z: -2, yaw: 0, gun: false });   // the same without the gun
```

## Wiring

- Spawn the pause menu first, the level before the player (the body stands on its `world` layer).
- Add the kit's config with `kit.add {"kit":"fps"}` (and `kit.add {"kit":"health"}` for the health kit's `ui-theme/hud` and `sound/hit`): `input-map/fps`, `material/gun`, `sound/footstep`, `sound/thud`, `sound/shot`.
- Enemies find the player through the `player` group, which `spawnFirstPerson` sets.
