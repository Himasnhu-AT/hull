# Environment: day sky, camera rigs, surface spray, foliage impostors

Four game-agnostic systems extracted from the rally game Pacenote and generalised into skeletons:
plain data in, one plugin each, clear extension points. Each is its own cargo feature and module,
all four are in `default` (a system costs nothing until you insert its resource / spawn its
component). One example shows them together:

```sh
python3 -I scripts/play.py scripts/environment-demo.json --example environment_demo
cargo run --example environment_demo -- --play --day-length 120      # time-lapse, drive the truck
```

| Module (feature) | What | Control commands |
|---|---|---|
| `daytime` | clock, solar sun + moon, stars, cloud dome, cloud shadows, night lights; drives `Look` | `day.get`, `day.set`, `day.clouds` |
| `camera_rigs` | spring-arm chase, mounted, orbit, free/photo, speed feel | `camera.rig` |
| `spray` | dust / sand / mud / snow / smoke / water / chips from any emitter point | `spray.get`, `spray.set` |
| `foliage` | distant plants as impostors + near/far LOD switching | `foliage.get`, `foliage.config` |

Rule of thumb for the look of a game: `daytime` owns the `Look` (sun, fill, exposure, fog) while its
`DayClock` exists; everything else in the `Look` (tonemapping, grading, bloom, lens) comes from
`DayConfig::base`.

---------------------------------------------------------------------------------------------------

## daytime (`engine::daytime`)

### Quick start

```rust
app.insert_resource(DayClock { hours: 17.0, day: 200.0, latitude: 52.0, ..default() }.with_day_length(600.0));
app.insert_resource(DayWeather { overcast: 0.3, ..default() });          // optional
app.insert_resource(DayConfig { moon_follows: true, ..default() });      // optional knobs
commands.spawn((SpotLight::default(), NightLight::lamp(18_000.0)));        // on after dusk
```

Insert [`DayClock`] to turn it on (no clock: no system runs). The clock moves on `Time<Virtual>`
(pause freezes it). A camera with `Look.sky.mode = Atmosphere` (the default) gets the cloud dome.

### What it does

- **`DayClock`**: `hours` (0..24), `day` (of year, moves on at midnight), `rate` (game s per real s,
  `.with_day_length(secs)`), `latitude`, `solar_noon` (clock hour of noon: 12 without a time zone
  or summer time), `new_moon_day` (anchor of the phase cycle).
- **`astro`** (pure functions): `sun(lat, day, hours, noon) -> (azimuth, elevation)`,
  `moon(..) -> MoonState { azimuth, elevation, illumination, phase_angle, age }`, `sidereal(..)`
  (how far the stars have turned), `to_dir(az, el)`. Low precision (~1 degree), seasons and latitude
  work (checked in tests: noon sun 64 degrees at 46 N on 21 May, south hemisphere, new / full moon).
- **`DaySky`** (resource, refreshed when the clock / config changes): sun direction, moon, the
  light (`Light { azimuth, elevation, lux, color, moon }`), `daylight` 0..1, `stars` 0..1,
  `sidereal`. Read it for anything that follows the sun.
- **`DayKeys`** (data, serde): keyframes **by sun elevation** (not by clock hour, so they hold at
  every latitude and season): EV100, haze visibility + colour + sun glow, fill light + colour, cloud
  cover. `DayKeys::default()` is a temperate clear day tuned on Pacenote. Fill light and visibility
  blend in log space, everything eased.
- **Light**: the raw sun (`raw_sun` lux; Bevy's atmosphere reddens it), held at `twilight_el` and
  dimmed a decade per `twilight_decade` degrees below that (the sky's glow through dusk), then the
  moon below `moon_from`: either opposite the sun at 35 degrees (`moon_follows: false`, steady all
  night) or the real moon (`moon_follows: true`, kept at least `moon_min_elevation` up for lighting,
  dimmed with phase and when under the horizon but never below `moon_floor`).
- **`drive_look`**: rewrites `Look` from `DayConfig::base` + keys when the sun has moved
  `quantum_deg` (0.02 degrees, about once a second at 5x). The sky mode never switches in play.
  It stands down while a `LookTimeline` / `LookTransition` exists, or with `drive_look: false`.
  `env_refresh_hz` (default 0.05: once per 20 s) keeps the sky-light refilter cheap; a jump of the clock
  boosts it to 4 Hz for 3 s.
- **`DayWeather { cover: Option<f32>, overcast }`**: overcast adds cloud, dims the direct sun (to
  20 %), shortens visibility, kills the sun disk. Weather systems (rain, storms) write it. With
  feature `weather` and a live `DayClock`, `Weather.params.cloud` is written into `overcast` for you and
  weather no longer dims the sun itself (once, not twice; see docs/WEATHER.md). `DayWeather` has no
  fog or precipitation knobs; weather keeps those.
- **Clouds** (`CloudConfig` in `DayConfig::clouds`): one camera-following dome mesh; the fragment
  shader ray-marches a 1.8-3.2 km shell over a curved earth (Low: one sample of a flat layer; Medium
  4 steps, 1 light tap; High+ 8 steps, 2 taps). Coverage is keyed, wanders slowly and follows
  `DayWeather`; cumulus grow taller in the afternoon. Light: Beer with a multiple-scattering floor,
  dual Henyey-Greenstein (silver lining), sky fill from above, ground bounce. Both noise textures
  (256^2 weather map, 32^3 detail volume) are generated at startup (0.3 MB).
- **Stars / moon**: the same shader draws a procedural star field (cube-face cell hash: density,
  brightness, colour, twinkle, tilted by the latitude and turned by the sidereal angle), a faint
  Milky Way band, and a procedural moon disc (phase, maria, earthshine, halo) where the night light is.
- **Cloud shadows**: `CloudField` (CPU copy of the weather map) samples density the way the shader
  does. The engine dims the sun light as clouds pass over the camera (`CloudConfig::shadows`,
  `shadow_strength`; transmittance eased over ~1 s, written after the look is applied). For shaped
  shadows on the ground, `CloudShadowParams` (resource, updated every frame: wind offset, coverage,
  strength, light direction, mid altitude) is the contract for a material of yours.
- **`NightLight`** component on any `PointLight` / `SpotLight`: `intensity` lumens at
  `dusk_el` and lower, 0 at `dawn_el` and higher, a smooth ramp between (depends only on the sun: no
  flicker); `force: Some(true/false)` is a manual switch.

### Extension points

- `DayKeys` / `DayConfig::base` as data: swap the keys per biome, the base look per art direction.
- `DayConfig::drive_look = false` and read `DaySky` to light a scene yourself.
- `CloudShadowParams` for ground cloud shadows in your terrain material; `CloudField::density` /
  `shadow` for gameplay ("is it cloudy over there").
- Moon texture: the shader's moon albedo is procedural (`moon_contrast`); swapping in a real albedo
  map is one more binding in `clouds.wesl`.

### Control commands

`day.get` (clock, sun, moon, light, weather, cloud state, `look_writes`), `day.set {time, day, rate,
running, latitude, overcast, cover}` (any subset), `day.clouds {on}`.

### Gotchas

- The camera's far plane must be past the farthest thing you draw (Bevy culls beyond `far` even
  though the projection is infinite): `far: 6000` in the demo. The cloud dome itself is exempt.
- A clock jump re-filters the sky light within a second; a running day does it every 20 s.
- With no `Look` resource the module inserts the first one itself; after that it only rewrites it.

---------------------------------------------------------------------------------------------------

## camera_rigs (`engine::camera_rigs`)

```rust
commands.spawn((MainCamera, Camera3d::default(), CameraRig::chase(truck).with_feel(Feel::default())));
rig.set_mode(RigMode::Mounted(Mounted { offset: Vec3::new(0.0, 1.2, -0.3), ..default() }));   // a cut
rig.kick(0.2);                                                                                 // landing
```

One `CameraRig` component on a camera; `RigMode` is `Chase`, `Mounted`, `Orbit` or `Free`. Targets
are any root entity's `Transform` (vehicle, character, drone); speed is derived from how it moves
(smoothed finite difference; a jump over 8 m is a teleport and cuts). Runs in `PostUpdate` before
transform propagation. `active: false` hands the camera back. `engine::chase::ChaseCamera` stays as
the simple one-mode follow camera.

- **`Chase`**: a spring arm (`arm::Arm`): one closed-form damped spring per axis (boom, sideways,
  height, heading, aim point) in the arm's yaw frame, driven by the *acceleration* of the rest pose,
  so speeding up stretches the boom, braking squashes it, a corner swings it out, a steady speed
  leaves it at rest; frame-rate independent. `travel_heading` blends the arm's heading from the
  nose towards the direction of travel (slides show as the target at an angle; reversing keeps the
  nose). Boom and height change with speed (`speed_boom`, `speed_height`, `speed_range`). Pulled in
  front of colliders by a ray (feature `physics` and a physics world; skipped otherwise).
  `ArmTuning` (omega, damping, limits per axis) is the feel.
- **`Mounted`**: fixed at `offset` in the target's frame; the view direction follows the body with
  `lag` (1/s; a low rate keeps suspension shake out of the eye); road buzz scales with the speed feel.
- **`Orbit`**: around `target + Y * height`; yaw / pitch / zoom from `RigInput`, optional `spin`
  turntable, distance and pitch limits.
- **`Free`**: photo camera; WASD + Q/E + Shift + mouse (or write `RigInput` from a gamepad:
  `default_input: false`), eased velocity, optional `fov`.
- **`Feel`** (optional per rig): FOV kick (up to `fov_kick` degrees at full speed feel, `inside_scale`
  for mounted views), chase shake (`shake` metres, only above `shake_from`). `SpeedFeel` (resource,
  0..1 smoothstep over `Feel::range`) is the single number the blur / wind sound / HUD can read.
  `CameraRigSettings { shake, fov }` (resource) scales both: wire it to an accessibility setting;
  0 turns the effect off. The base FOV is `CoreSettings.fov_deg` when present, else the camera's own.
- `frames_since_cut()` says how long ago the last cut was (skip motion blur for a few frames).

Control: `camera.rig {mode, active, cut}` (no params: state of every rig and `speed_feel`).

Extension points: `RigMode` is an enum you can extend by adding a variant and a match arm in
`drive_rigs`; `ArmTuning` and `Feel` are plain data; set `rig.input` for non-keyboard control.
Known limits: no collision for mounted / orbit / free; no per-axis shake frequencies; one `SpeedFeel`
(the first active rig with a `Feel` writes it).

---------------------------------------------------------------------------------------------------

## spray (`engine::spray`, on `vfx`)

```rust
commands.entity(car).with_child((SprayPoint { rear: true, ..default() }, SprayInput::default(),
                                 SprayTracker::default(), Transform::from_xyz(0.9, -0.35, 1.2)));
commands.insert_resource(SurfaceMapRes::from_fn(|p| Some(if mud_at(p) { SurfaceId::MUD } else { SurfaceId::GRAVEL })));   // engine::surface
```

A `SprayPoint` entity (its `Transform` is the contact patch) throws up to seven kinds (`SprayKind`:
Dust, Sand, Chips, Mud, Snow, Smoke, Water) according to the `Surface` under it, its speed and its
slip. Effects are persistent `ParticleEffect` children whose `rate_scale` follows the intensity, so
nothing spawns at rest; a child is created the first time its kind is needed at that point, never
before, and `VfxBudget` caps the total.

- **`SprayInput { surface, speed, slip }`** on the point: write it from your simulation (wheel
  contact, slip ratio and angle) or add **`SprayTracker`**, which derives speed and slip from how the
  entity moves (sideways share of the velocity) and asks the shared **`SurfaceMap`** (`engine::surface`, the same
  one `vehicle` uses; resource `SurfaceMapRes`, `surface_at(pos) -> Option<SurfaceId>`) and converts the
  id with `Surface::from_id`. `None` sprays nothing (airborne). Spray's old own `SurfaceMap` closure
  resource is gone.
- **`SprayRules`** (data): rows of `kind x surface` with `gain`, `roll` / `slip` weights, `slip_from`,
  speed range, ramp `power`, front / rear weights. `intensity()` is a pure function (tested).
  Defaults: dust on gravel / dirt / grass, sand, chips only in a slide, mud, snow, tyre smoke on hard
  ground in a hard slide, water mist on wet ground (needs ~20 km/h, rises with speed squared).
- **`SprayPalette`** (data): the colours of each kind (soil of the map); call
  `register_effects(&mut lib, &palette)` again after changing it (or define your own `spray_*`).
- `SprayPoint { kinds, rear, scale }` restricts, weights or mutes a point.

Control: `spray.get` (points with live rate scales), `spray.set {surface, speed, slip}` (force the
inputs of every point, to see a surface without driving).
Extension: more `SprayKind`s need an effect in `defs.rs`, a variant, and a name. Weather particles
(rain around the camera) are not here: use `vfx` presets.

---------------------------------------------------------------------------------------------------

## foliage (`engine::foliage`)

```rust
let atlas = ImpostorAtlas::new(images.load("trees/oak.png"), ImpostorParams { grid: [4, 2], frames: 8, half_width: 3.0, y1: 8.0, ..default() });
let mut foliage = Foliage::default();
let oak = foliage.add_species(FoliageSpecies::new("oak", atlas).near_at(trunk, bark, Transform::default()).near(crown, leaf));
foliage.scatter(oak, Vec2::ZERO, 1800.0, 5000, 11, |x, z| height(x, z));       // or foliage.add(instance)
app.insert_resource(foliage).insert_resource(FoliageConfig { near: 80.0, fade: 30.0, far: 1800.0, ..default() });
```

Runtime impostor rendering and near / far LOD switching. **Baking is not here**: the runtime API is
independent of how the pictures were made. `ImpostorAtlas { image, params }` with `ImpostorParams`
(serde: a baker writes it as a sidecar) is the whole contract:

- A grid of frames (`grid` columns x rows, `frames` used, row by row from the top-left); **frame i
  shows the plant seen from azimuth `i / frames * 2 pi`, measured from +Z towards +X in the plant's
  own frame** (frame 0 looks at the plant from its +Z side). One frame is a plain billboard; a ring
  of views turns with the camera (nearest view; the vertex shader picks it from the camera azimuth and
  the instance's yaw). `half_width`, `y0`, `y1` place the picture at scale 1; `cutoff` is the alpha mask.
- `ImpostorAtlas::billboard(image, hw, h)` and `procedural_tree(images, px, frames, hw, h)` (a stand-in
  tree with a ring of different views: for tests, demos, placeholders).

How it switches (`FoliageConfig`):

- Instances (`Foliage::instances`: species, base point, yaw, scale, tint) live in a chunk grid
  (`chunk`, 128 m). A refresh (`refresh_hz`, 4 per second) spawns / drops chunks, nearest first,
  `near_per_frame` and `impostors_per_frame` at a time; with hysteresis so nothing flaps.
- **Near**: your meshes (`NearPart`: shared mesh + material + local transform; trunk, crown...),
  one entity per part per instance, with Bevy's `VisibilityRange` ending at `near` .. `near + fade`
  (dithered fade). Bevy batches identical mesh + material into instanced draws.
- **Far**: one mesh per (chunk, species): every instance is a quad turned about the vertical to face the
  camera, in the `ImpostorMat` (`ExtendedMaterial<StandardMaterial, ImpostorExt>`, `impostor.wesl`).
  The shader fades each quad in over the **same** range with the same 4x4 dither and level mapping
  as `VisibilityRange` (same LOD eye, same point: the instance base), so near fading out and far
  fading in cover complementary pixels: no gap, no double draw. Fades out by `far`. No per-instance
  entity and no per-frame work; no shadows; normals are soft (towards the camera / up).
- Tags: near entities and impostor meshes are `Scenery` + `KeepDetail` (this module owns their
  ranges). `thin` keeps every n-th impostor (Low), `impostors: false` shows near models only.
- Headless: index, stats and mesh data run; the GPU material is skipped.

`FoliageStats` (`near_chunks`, `near_entities`, `impostor_chunks`, `impostor_quads`) and
`foliage.get` / `foliage.config {enabled, impostors, near, fade, far, thin}` expose it.

Extension points: feed `Foliage` from PCG cells / a scatter pass (`touch()` after editing);
a `NearPart` list is enough for models, scene-based species are a next step; a baked ring needs no
code change; wind sway (vertex shader) and per-instance tint animation are free in `impostor.wesl`.
Known limits: nearest-view picking (no blending between views), one species per mesh, near models
spawn per chunk (a chunk of 128 m with hundreds of trees is one frame's budget), the near
entities are not merged (use few parts).

---------------------------------------------------------------------------------------------------

## Measurements and checks

`examples/environment_demo.rs` (macOS, offscreen, default quality), 4 994 trees over 3.6 km square:

- foliage: 824 chunks of 128 m; at the ring road 7 near chunks (60 near entities: 2 parts per tree),
  210 impostor chunks holding 1 291 quads (one mesh per chunk and species; the rest of the 4 994
  trees are beyond `far` or thinned by distance). Impostors off: 0 impostor chunks, the near trees
  fade out and the distance is empty (`trees-impostors-off.png`).
- spray: two rear points on a fishtailing truck at 17 m/s on gravel: dust and chips at 0.98 rate
  scale, mud 0 (mud only in the mud quarter); 2 points x 3 effects live.
- camera: chase at 17 m/s sits 2.8 m up, `speed_feel` 0.06 (the FOV kick starts above 40 km/h).
- daytime: the `Look` is written about once per real second at 5x speed (`look_writes` in `day.get`).
- Tests: `memgate -- cargo test -q --lib -- daytime:: camera_rigs:: spray:: foliage::` (astro, keys,
  light, noise, cloud field, springs and arm, rig modes, spray rules and a tracked point, impostor
  quads, ring frame choice, chunk LOD with stats).
- Screenshots: `python3 -I scripts/play.py scripts/environment-demo.json --example environment_demo`
  (chase at morning / noon / overcast / dusk with lights, noon clouds, sunset, night stars,
  impostors on / off, a 6-frame time-lapse).

## Candidates not extracted (Pacenote) and why

- `art/headlights.rs`: car lights are model-specific mounts; the reusable part (on at dusk, auto with
  hysteresis) became `NightLight`. A vehicle light rig with a brake / tail lamp state is a candidate
  once a second game needs it.
- `art/sky.rs` street lamps: nearest-N pooling of real lights over a large set of posts (a fixed
  pool of `PointLight`s moved to the nearest posts twice a second). Candidate: `NightLight` pool.
- `art/conditions.rs`: road-condition decals (potholes, wet tarmac, mud patches) merged per tile;
  depends on Pacenote's road model (`open::furniture`). Candidate for `spline` / `world`.
- `loading.rs`: the staged loading screen (generate on a worker, build, `WarmPipelines`, settle). Very
  reusable but entangled with stage generation; the generic part is a `LoadingStage` state machine plus a
  progress screen in `ui`.
- `telemetry.rs`: consent + crash / perf reporting (`ashlar-trace`); belongs with the `trace` feature.
- `daytime.rs` start-time settings and the wall-clock start (`wall_hours`, libc `localtime_r`): a
  settings row (`Start time`) plus a helper; trivial to add on top of `DayClock`.
- `art/mirror.rs` / `exhaust.rs` / `water.rs`: engine-level but not generic enough to extract blind.
