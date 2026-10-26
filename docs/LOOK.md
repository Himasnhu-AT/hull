# Look: rendering & lighting quality (`engine::look`, feature `look`)

How a scene is lit and graded, as **data**. A [`Look`](../src/look/desc.rs) resource describes the
sun (or moon), sky, ambient + image-based light, distance and volumetric fog, exposure (manual or
auto), tonemapping, colour grading, bloom tuning and lens effects. `LookPlugin` (added by
`EnginePlugin`) turns it into Bevy components on the `MainCamera`, a `Sun` light, the atmosphere
and a fog volume. Everything is plain Rust / JSON: an AI agent can read it (`look.get`), diff it,
patch it (`look.set {fields}`), blend it, and test it headless.

What it adds on top of Bevy 0.19, and what Unity/Unreal users will recognise:

| Unity / Unreal | here |
|---|---|
| Volume profile / Post Process Volume | `Look` (one struct, serde, `Lerp`) + `LookTransition` blends |
| Time-of-day / Sky Atmosphere + Directional Light | `LookTimeline::day_cycle`, `SunLook { azimuth_deg, elevation_deg, .. }`, Bevy atmosphere |
| HDRI sky / sky light recapture | procedural gradient cubemap (`SkyMode::Gradient`, built from code, async), atmosphere env light, KTX2 cubemaps |
| Reflection probes (baked / realtime, time-sliced) | `ReflectionProbe`: runtime capture, bake-and-freeze or time-sliced realtime, SH diffuse |
| Light probes / APV | `irradiance_volume_image` (Bevy irradiance volume from a closure) |
| Exposure (manual / auto histogram) | `ExposureLook { ev100, auto, .. }` (+ compensation) |
| Tonemapping, colour grading (WB, lift/gamma/gain) | `ToneMap`, `GradingLook` (global + shadows / midtones / highlights) |
| Bloom, DOF, motion blur, CA, vignette, film grain, lens distortion | `BloomLook`, `LensLook` (film grain is ours: Bevy has none) |
| Exponential height / volumetric fog | `FogLook` (linear / exp / exp² / atmospheric), `VolumetricLook` (fog box + sun shafts) |
| Decals (URP/HDRP decal projector, deferred decals) | forward decals from code-generated textures; clustered decals behind a feature |
| Scalability settings (sg.*) | `QualityPreset` per-tier fields; `look.feature` toggles at runtime |

Not here (Bevy 0.19 has no equivalent, and it's out of scope for this module): Lumen-style dynamic
GI, Nanite, ray tracing, baked lightmap tooling. SSR + probes + SH diffuse are the realistic
substitutes.

## Quick start

```rust
use engine::prelude::*;
use engine::look::{FogLook, Look, LookTimeline, LookTransition, ReflectionProbe};

app.insert_resource(Look::dusk());                                    // a preset
app.insert_resource(Look { fog: FogLook { visibility: 300.0, ..Look::dusk().fog }, ..Look::dusk() });
commands.insert_resource(LookTransition::new(current.clone(), Look::night(), 5.0)); // blend 5 s
app.insert_resource(LookTimeline::day_cycle(24.0 / 600.0));           // a 10-minute day
commands.spawn((ReflectionProbe::default(), Transform::from_xyz(19., 1.75, 0.).with_scale(Vec3::new(10., 3.5, 8.))));
```

Nothing happens until a `Look` resource exists. Removing it leaves the last applied state.

Presets: `clear_day` (default), `overcast`, `dusk`, `night`, `indoor` (`Look::preset(name)`,
`Look::PRESETS`). Build variations with `..Look::dusk()`; config structs all implement `Default`.

### Look fields (all serde, unknown keys rejected)

- `sun`: `enabled, azimuth_deg (0 = towards -Z, 90 = +X), elevation_deg, illuminance (lux),
  color, shadows, shadow_distance, cascades, first_cascade, disk_size_deg, disk_intensity,
  soft_shadow_size`. An existing `gfx::Sun` light (e.g. from `sky_and_sun`) is taken over; else
  one is spawned (`LookSun`). It fades out below the horizon.
- `sky`: `mode` = `atmosphere` (Bevy's physical sky + aerial perspective) | `gradient`
  (procedural cubemap: `zenith/horizon/ground`, `sun_glow`, `stars`, scaled by `brightness`
  cd/m²) | `color` (flat `ClearColor` = `horizon`; env light still from the gradient) |
  `cubemap` (`cubemap`, optional prefiltered `diffuse_map` / `specular_map` KTX2 paths).
- `ambient`: `color, brightness` (`GlobalAmbientLight`), `env_intensity` (multiplier on the sky's
  image-based light; 0 = off).
- `fog`: `mode` = `off|linear|exponential|exponential_squared|atmospheric`, `color, sun_color,
  sun_amount, sun_exponent, start, end, visibility, extinction`.
- `volumetric`: `enabled, density, color, absorption, scattering, asymmetry, light_intensity,
  ambient_intensity, size, center, follow_camera, sun_shafts`.
- `exposure`: `ev100, auto, auto_min, auto_max, speed_brighten, speed_darken, compensation`.
- `tonemapping`: `none|reinhard|reinhard_luminance|aces_fitted|agx|somewhat_boring_display_transform|tony_mc_mapface|blender_filmic|khronos_pbr_neutral`.
- `grading`: `exposure, temperature, tint, hue, post_saturation`, `shadows/midtones/highlights`
  each `{saturation, contrast, gamma, gain, lift}`.
- `bloom`: `intensity, low_frequency_boost(_curvature), high_pass_frequency, threshold,
  threshold_softness, additive` (whether bloom runs at all is the tier's).
- `lens`: `dof {enabled, focal_distance, aperture_f_stops, max_blur_px}`, `motion_blur {enabled,
  shutter_angle, samples}`, `chromatic_aberration`, `vignette {intensity, radius, smoothness,
  color}`, `distortion`, `film_grain` (0 = off for each strength).

Blends: numbers and colours interpolate (colours in linear space; illuminance, sky brightness,
ambient brightness and fog visibility geometrically, so day ↔ night is smooth); the sun azimuth
takes the short way round; flags, enums and paths switch at the midpoint.

## Quality tiers (`gfx::QualityPreset`)

`apply_camera_quality` (gfx) owns the camera-wide features; the look reads the "look tier" fields
to gate what a `Look` asks for. Defaults (Low / Medium / High / Ultra):

| field | Low | Medium | High | Ultra | what |
|---|---|---|---|---|---|
| `ssao` | – | – | ✓ | ✓ (Ultra quality) | gfx |
| `bloom` | – | ✓ | ✓ | ✓ | gfx (tuning from the look) |
| `taa` | FXAA | TAA | TAA | TAA | gfx |
| `shadow_map_size` | 1024 | 2048 | 2048 | 4096 | gfx |
| `shadow_filter` | Hardware2x2 | Gaussian | Gaussian | Temporal | gfx (Temporal → Gaussian without TAA) |
| `contact_shadows` | – | – | ✓ | ✓ | gfx: camera `ContactShadows` + `Sun` lights |
| `ssr` | – | – | – | ✓ | gfx: SSR, opaque materials switched to deferred |
| `env_light` | ✓ | ✓ | ✓ | ✓ | look: image-based light from the sky |
| `env_map_size` | 64 | 128 | 256 | 512 | look: atmosphere env cubemap (fixed once created) |
| `sky_samples` | 8 | 12 | 16 | 24 | look: atmosphere LUT samples / sizes |
| `auto_exposure` | – | ✓ | ✓ | ✓ | look |
| `post_fx` | – | ✓ | ✓ | ✓ | look: vignette, chromatic aberration, distortion, film grain |
| `camera_fx` | – | – | ✓ | ✓ | look: DOF, motion blur |
| `bokeh` | – | – | – | ✓ | look: DOF mode |
| `volumetric_fog` / `volumetric_steps` | – / 16 | – / 24 | ✓ / 32 | ✓ / 64 | look |
| `probe_refresh` | 0 (bake) | 0 (bake) | 4 | 1 | look: frames per probe face update |
| `soft_shadows` | – | – | – | ✓ | look: PCSS, only with cargo feature `look_pcss` |

Nothing expensive runs at Low: no SSAO, bloom, TAA, contact shadows, SSR, volumetrics, post or
camera effects, and probes bake once and freeze. Change the resource (`..default()`) to retune.
`gfx::prune_prepasses` drops depth/normal/deferred prepasses only a removed feature needed (motion
vectors stay, see "Bevy workarounds").

## Image-based light, probes, decals

- **Sky env light** (`ambient.env_intensity`, tier `env_light`): atmosphere skies use Bevy's
  `AtmosphereEnvironmentMapLight`; gradient/colour skies a procedural cubemap
  (`LookConfig::sky_cubemap_size`, 256) filtered on the GPU (`GeneratedEnvironmentMapLight`).
  Bevy refilters these every frame (≈ 1 ms at 256² here); the look **freezes** them after the GPU
  filtered the current sky `LookConfig::freeze_env_after` (4) times and resumes on the next look
  change. The gradient cubemap is rebuilt on a worker thread (≤ `sky_rebuild_hz`, 10 Hz) while a
  look animates, so blends never stall a frame.
- **`ReflectionProbe`** (`src/look/probe.rs`): six 90° cameras (`LookCapture`: sky, fog,
  exposure, no post) render the scene from the probe centre into a cubemap (copied into the cube
  in the render world after submit). Specular: Bevy's GPU filter on a hidden worker entity.
  Diffuse: Bevy's realtime irradiance filter point-samples the cube and is blotchy indoors
  (small bright windows/lamps), so the cube is read back asynchronously and projected onto 9
  spherical harmonics on the CPU instead (16² irradiance cube). Bake mode captures during shader
  warm-up, then freezes (no per-frame cost); it re-bakes 0.5 s after a look change or on
  `look.probe {bake: true}`. Realtime mode updates one face every `refresh` frames. Probe
  captures are stored pre-exposed (`Tonemapping::None`) and rescaled by the capture exposure.
  The probe's box is its `Transform` scale; reflections are parallax-corrected to that box.
- **`irradiance_volume_image(res, |cell, side| light)`** builds Bevy's ambient-cube voxel texture
  from code; `sky_ambient_cube(gradient, side, visibility)` gives sky light for a side. Note
  Bevy 0.19: when a view has any irradiance volume, meshes *outside* it lose env-map diffuse, so
  prefer probes for mixed indoor/outdoor scenes.
- **Decals** (`src/look/decal.rs`): `decal_image(size, |uv| rgba)` makes a texture from a
  closure, `decal_material(base, depth_fade)` + `spawn_decal(..)` a forward decal (unit quad,
  local +Y normal). The look keeps a depth prepass on 3D cameras while decals exist. Clustered
  decals (`ClusteredDecal`) need the `look_clustered_decals` feature (Bevy's
  `pbr_clustered_decals`) and bindless textures, which Bevy 0.19 disables on Metal.

## Control commands (feature `devtools`)

| command | params | does |
|---|---|---|
| `look.get` | – | full `look` JSON, presets, quality, tier, per-feature `{tier, look, active}`, transition / timeline state, apply count + last apply µs, the main camera's rendering components |
| `look.set` | `preset?`, `fields?` (partial Look JSON, merged), `blend?` (s) | swap or blend the look; unknown fields are an error |
| `look.feature` | `name`, `on` (no params: list) | toggles a feature at the current tier: sets the `QualityPreset` flag and the look's enable/strength. Names: `fog, film_grain, bloom, taa, post_fx, env_light, auto_exposure, contact_shadows, ssao, volumetric, dof, motion_blur, ssr, soft_shadows, atmosphere, shadows` (+ `vignette`, `chromatic_aberration`, `camera_fx`) |
| `look.time` | `time?`, `speed?`, `stop?` | day-cycle timeline (starts one if missing) |
| `look.probe` | `bake?`, `refresh?` (-1 = tier) | list probes (captures, GPU copies, filtered frames, SH updates, frozen), re-bake, set refresh |

The showcase adds `showcase.pose {outdoor|metals|indoor|poster|overview}` and
`showcase.quality {low|medium|high|ultra}`.

## Example and screenshots

`examples/look_showcase.rs`: an outdoor yard (gold / chrome / copper / steel / plastic spheres,
pillars, neon strips, a floor decal) and a room with a window, a lamp, a chrome ball and a
reflection probe. Flags: `--look <preset>`, `--pose <name>`, `--quality <tier>`, `--uncapped`,
`--day-cycle <s>`, `--no-probe`, `--probe-debug` (shows the six probe faces on panels).

```sh
python3 -I scripts/play.py scripts/look-shots.json --example look_showcase   # every preset
```

Checked by eye on 1920×1080 offscreen screenshots: all presets (day/overcast/dusk/night/indoor)
outdoors and in the room, every tier, lens effects (DOF + CA + vignette + grain), volumetric fog,
probe bake/realtime and SH diffuse, preset blends and day↔night switches.

## Measurements

Apple M5 Pro, `look_showcase --offscreen --uncapped` (1920×1080, vsync off), outdoor pose,
`clear_day`, High tier, no probe unless stated. GPU ms = this process's GPU time per frame (perf
monitor). Each row is a drift-cancelling A/B: 3–4 repetitions of off / on / off (2 s each), the
cost is the median of `on − mean(off, off')`, range in brackets. **The machine was shared with
other agents' builds and GPU jobs**: rows marked * ran under heavy contention (absolute ms ~2–3×
inflated, deltas likely inflated too); the rest ran on a quiet GPU (High baseline ≈ 3.6 ms).

| feature (on vs off) | Δ GPU ms |
|---|---|
| tier Low → Medium (bloom, TAA, 2048 shadows, post fx, auto exposure allowed) | +0.97 (+0.83..+1.12) |
| tier Medium → High (SSAO, contact shadows, camera fx allowed) | +1.11 (+0.89..+1.31) |
| tier High → Ultra (SSR + deferred, 4096 shadows, SSAO Ultra, temporal shadow filter) | +2.47 (+1.34..+3.29) |
| SSAO (High) | +0.88 (+0.40..+1.08) |
| contact shadows | +0.35 (+0.20..+0.42) |
| TAA instead of FXAA | +0.13 (−0.05..+0.24) |
| bloom | +1.20..+1.83 (two runs) |
| sky env light, **before the fix below**: atmosphere sky, env light on the main camera | ≈ +15 ms frame time (26 → 10.7 ms p50 when turned off) |
| sky env light, gradient sky, refiltered every frame (Bevy default) | +1.05 (+0.93..+1.12) |
| sky env light, any static sky (filtered once on `SkyEnvFilter`, then frozen) | ≈ 0 |
| atmosphere sky instead of the gradient cubemap | +0.11 (−0.02..+0.21) |
| distance fog | +0.09 (+0.04..+0.15) |
| volumetric fog, 32 steps, 80 m box | +3.17 (+2.93..+3.40) |
| auto exposure | +0.01 (−0.03..+0.04) |
| depth of field (gaussian) | +0.11 (+0.10..+0.12) |
| motion blur | +0.04 (+0.02..+0.10) |
| vignette + chromatic aberration | +0.09 (+0.07..+0.13) |
| film grain * | +0.44 (+0.14..+0.57) |
| SSR (deferred opaque) | +0.43 (−0.02..+0.56) |
| reflection probe 128², realtime 1 face / 4 frames vs baked & frozen * | +2.30 (+1.92..+2.63) |
| reflection probe 128², realtime 1 face / frame vs baked & frozen * | +3.63 (+2.05..+4.93) |
| indoor preset volumetric (32 steps, 24 m box), indoor pose * | +4.3 |

CPU (dev build, engine at opt-level 1): `apply_look` 0.18–0.65 ms per apply and runs only when
the look, tier, settings or cameras change (or every frame while a transition / timeline
animates); idle frames cost nothing (every system is behind a run condition). A 256² gradient sky
rebuild takes ≈ 20 ms on a worker thread (the first build, synchronous, happens once). Probe
diffuse: one async 768 KB readback + SH projection of 24 k texels per full capture.

Takeaways: volumetric fog and realtime probes are the expensive pieces (High+ only / bake on
Low–Medium); bloom is the most expensive "cheap-looking" effect at 1080p; freezing static env
maps removes ~1 ms/frame that Bevy spends by default.

**Sky env light fix (integration).** The rows above were measured on the gradient sky. With the
default `clear_day` atmosphere sky, Bevy's `AtmosphereEnvironmentMapLight` on the main camera was
re-rendered and refiltered every frame: `look_showcase` ran at p50 ≈ 26 ms (High) and the
`env_light` toggle alone saved ≈ 15 ms. Now one hidden `SkyEnvFilter` entity
(`apply::SkyEnvWorker`) filters the sky once, hands the filtered maps to every look camera as a
plain `EnvironmentMapLight` and drops its `GeneratedEnvironmentMapLight` (frozen). It refilters
only when the sky changes, at most `LookConfig::env_refresh_hz` (10 Hz) during blends and day
cycles. Probe captures share the same maps. `look.get` reports it under `state.env`.

| `look_showcase`, outdoor, clear_day, 1080p uncapped (frame p50 / p95 ms) | before | after |
|---|---|---|
| High | 26.1 / 31.6 | 10.0 / 11.8 |
| Low | — | 5.0 / 5.6 |
| High, dusk preset | — | 10.6 / 16.3 |
| High, day cycle at 2000× (sky refiltered at 10 Hz) | — | 11.3 / 17.5 |

## Bevy 0.19 workarounds (in `look`/`gfx`)

- **Atmosphere removal** (`src/look/fixes.rs`): Bevy never clears a view's extracted atmosphere
  or its sky-pass uniforms when a camera loses `AtmosphereSettings`; the stale sky keeps
  rendering (white haze at night after a dusk → night switch). The look removes them in the
  render world.
- **Atmosphere env light** is converted by Bevy once into a private marker and then re-rendered
  and refiltered every frame. The look puts it on a hidden `SkyEnvFilter` entity instead of
  the camera, filters on demand, and freezes it (see "Sky env light fix" above).
- **Probe capture cameras** never get the atmosphere (single-frame-active views trip Bevy's
  atmosphere bind groups; per-view LUTs are costly); they see the gradient approximation.
- **Motion-vector prepass is never pruned**: removing it leaves Bevy's cached skybox motion-vector
  pipeline drawing into a pass without that attachment (fatal wgpu validation error).
- **Forward decals** need a depth prepass in *every* view that draws them (probe cameras too).

## Known limits

- PCSS soft shadows (`look_pcss`) and clustered decals (`look_clustered_decals`) forward to
  non-default Bevy features; they are wired but were not built or tested (they recompile Bevy).
- The atmosphere env-map resolution is fixed when first created (later tier changes keep it).
- Volumetric fog in Bevy dims the sun inside the box by the box's radius and darkens what's
  behind the box; use small boxes (rooms, valleys), not the whole sky. Its box edge can show
  against the sky outdoors.
  Shafts are strongest looking towards the sun (forward scattering); side-on they are subtle.
- At dusk (low sun) the atmosphere sky shows a curved band in the upper sky. It was there before
  the env-light fix and stays when volumetric fog is off (it changes shape with distance fog).
  Not yet investigated.
- Gradient skies are CPU-built cubemaps: stars are texel-sized (≈ 0.35° at 256²).
- Reflection probes: no blending between overlapping probes beyond Bevy's, captures see the
  gradient sky approximation, SH diffuse is order 2 (soft), realtime probes cost GPU every frame.
- Auto exposure uses Bevy's histogram metering (the whole screen; no metering mask from the look).
- GPU numbers come from a shared, busy machine; re-measure on your target before tuning tiers.
