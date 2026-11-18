# follow-camera kit

An orbiting chase camera that copes with speed and walls.

- **Behaviour**: `FollowCamera` on a node with a `Camera`; finds its target by `targetName` (default `player`).
  `yaw` is public so a controller can move relative to the view.
- **Look input**: `look` (mouse) and `lookPad` (arrows, right stick). Mouse up looks up.
- **Speed**: the target's speed (smoothed) widens the field of view (`fovPerSpeed`, `fovMaxExtra`) and pulls the
  camera back (`distancePerSpeed`, `distanceMaxExtra`).
- **Walls**: a sphere cast from the target to the wanted spot (layer `world`). The camera jumps in at once when a wall comes
  between, and eases back out at `recover` per second.
- **Tunables** (`followCamera` block): `distance`, `height`, `shoulder`, `pitch`, `pitchMin`, `pitchMax`,
  `mouseSensitivity`, `padLookSpeed`, `follow`, `fov`, `fovPerSpeed`, `fovMaxExtra`, `distancePerSpeed`,
  `distanceMaxExtra`, `speedSmoothing`, `collisionRadius`, `recover`.
- **Bench**: `bench.ts`. **Test**: `follow-camera.test.ts` (rest distance, speed effects, wall pull-in and recovery).
- Spawn it after the target and after the target's controller, so it follows where the target ended up this step.
