# Weather (`engine::weather`, feature `weather`)

A seeded weather state machine. Weather is data (`WeatherDef`: parameters, duration, what may
follow); the schedule is a pure function of `(seed, library, time)`, so two machines with the same
seed and clock agree. The blended state drives the look, rain and snow particles, surface wetness
(with a traction multiplier), wind, and the acoustic environment.

## Quick start

```rust
app.insert_resource(Weather::new(seed));                       // default seed 0, clock at 0
app.world_mut().resource_mut::<WeatherLibrary>().load_json("assets/weather.json".as_ref())?; // optional

fn vehicle(surface: SurfaceQuery, wind: Res<Wind>) {
    let grip = surface.traction_at(pos, 1.0);   // 1.0 dry .. WeatherConfig::wet_traction (0.55) soaked
    let push = wind.vector();                    // m/s
}
weather.force(&lib, "storm", 20.0);              // scripted change, blended; weather.release(10.0)
```
`cargo run --example sim_demo -- --play --weather-speed 30` (T = next weather).

## Data

`WeatherParams` (all 0..1 unless noted): `cloud`, `precip`, `fog`, `wind_speed` (m/s),
`gustiness`, `temperature_c` (precipitation at or below 0.5 °C is snow). `WeatherParams::kind()`
labels it `Clear | Overcast | Rain | Fog | Storm | Snow`.

`WeatherDef { name, params, duration: (min, max) secs, blend_secs, next: [(name, weight)] }`.
`WeatherLibrary::presets()` (the default): clear, overcast, rain, fog, storm, a chain that drifts
clear → overcast → rain. `load_json` takes an array of defs (replaces by name):

```json
[{"name": "blizzard", "params": {"cloud": 1.0, "precip": 0.9, "fog": 0.5, "wind_speed": 12.0, "temperature_c": -8.0},
  "duration": [120, 240], "blend_secs": 30, "next": [["overcast", 1.0]]}]
```

## The schedule (deterministic)

`Schedule` walks stretches: the length of stretch *n* and the weather after it come from
`hash(seed, n)`; the last `blend_secs` (capped at half the stretch) smoothstep into the next
weather's parameters. `data::sample_at(seed, lib, t)` answers for any time from scratch;
`Weather` keeps a `Schedule` and advances it (seeking backward replays from the start). Wind is
also a pure function of time: `wind_at(seed, t, params)` (slowly turning mean direction, gusts
from value noise). Multiplayer: share `seed` and set `Weather::time` from the synced clock.
Wetness integrates over local frames, so it can differ by small amounts between machines.

`Weather { seed, time, speed, paused, params, current, next, blend }`. `force(lib, name, secs)` /
`force_params` hold a weather (breaks determinism until `release(secs)`), `set_time`, `name(lib)`,
`kind()`.

## What it drives

- **Look** (`drive_look`, `look_for`): builds on a base `Look`. Weather owns the sun, sky, ambient,
  fog, volumetric and grading groups (exposure too with `drive_exposure`). When someone else rewrites
  one of those (a timeline, a transition) weather takes the result as the new base, so day
  cycles keep working. Other groups (the photo lens, bloom, tonemapping) pass through, so a camera
  writing the lens every frame never makes weather re-apply itself. Cloud lowers sun illuminance, disk and sky brightness, softens shadows,
  greys a *gradient* sky (an Atmosphere sky stays as it is), mutes saturation. Fog density plus
  some rain thickens fog (`visibility` is multiplied by `fog_min_visibility_frac ^ thickness`, 3% at full thickness: a fog-preset day with 2500 m base visibility sees ~125 m), tints it grey,
  boosts volumetric density. `drive_exposure` (off by default) also lowers EV100 under cloud: leave
  it off with a `PhotoCamera` or auto exposure.
- **With `daytime`** (feature on, `DayClock` present, `DayConfig::drive_look`, `WeatherConfig::drive_daytime`):
  weather writes `params.cloud` (rounded to 0.01) into `DayWeather.overcast`, so the cloud dome,
  cloud shadows and the day's own sun / fog dimming use the same value. Weather then stops dimming
  sun, disk, shadow softness and ambient itself (`cloud_dims_look` is bypassed), so the sun is dimmed
  once; sky greying, saturation, fog thickness from `fog` / rain and wind stay weather's. Order:
  `DaySet::Look` runs before `WeatherSet::Apply`, so weather adopts the day's fresh look as its base.
  Without a clock weather dims the sun alone. Test: `weather::tests::daytime_gets_the_cloud_and_the_sun_is_dimmed_once`.
- **Surfaces**: `Wetness` is the shared `crate::surface::Wetness`; `vehicle` reads the same resource
  for its `wet_grip` / `wet_rolling`, so rain slicks the road with no glue. Per-region wetness
  (`SurfaceQuery::wetness_at`) is weather-only; vehicles see the open-ground value.
- **Particles**: `rain` / `snow` presets from `vfx` (camera-local). Effect entities are spawned on
  the first precipitation, then `emitting` and `rate_scale` follow `precip`. Needs the vfx plugin.
- **Wetness**: `Wetness(f32)` for open ground, rising at `wet_rate · precip` (0.02/s) and falling at
  `dry_rate` (0.004/s, ×2 under clear sky). Snow wets at 30%.
- **Regions**: `WeatherRegion { radius, sheltered, wet_mul, dry_mul, floor }` + `RegionWetness`
  (under a canopy: `sheltered`; a bog: `floor: 0.9`; a stream bank: `wet_mul: 2`). The smallest region
  containing a point decides.
- **`SurfaceQuery`** (system param): `wetness_at(pos)`, `traction_at(pos, sensitivity)` where
  `traction_multiplier(wet, sensitivity, wet_traction) = 1 - sensitivity·(1 - wet_traction)·wet`.
  Mud ≈ 1.0, rock ≈ 0.3.
- **Wind**: `Wind { dir, speed }` (`vector()`), for foliage sway, vehicle drag, audio.
- **Acoustics** (feature `ai`): copies wind into `AcousticEnv::wind` and sets
  `ambient_db = 15 + 28·precip + 1.2·wind` (rain masks quiet sounds). `drive_acoustics = false` opts out.

System sets: `WeatherSet::Advance` (clock, params, wind, wetness) then `WeatherSet::Apply` (look,
particles), before the photo lens and `apply_look`.

## Control commands (feature `devtools`)

| Command | Params | Result |
|---|---|---|
| `weather.state` | — | name, kind, blend, params, wind, wetness, forced |
| `weather.list` | — | the library |
| `weather.set` | `name`, `blend?` (5) | forces a weather |
| `weather.release` | `blend?` | back to the schedule |
| `weather.time` | `time?`, `speed?`, `seed?`, `paused?` | the clock |

## Measurements and limits

- Tests (`cargo test --lib weather`): schedule purity (fresh walk = incremental, same for any seed,
  different seeds differ), continuity across stretch boundaries, wind determinism, classification,
  same seed → identical traces over 600 updates at 120× speed, force/release blends, look follows
  and returns without compounding, external look changes become the base, wetting and drying,
  regions and traction, smallest-region lookup.
- Cost: a few float lerps per frame; the look is rebuilt only when parameters moved by more than
  0.001 or someone else changed it; particles cost what the `rain` preset costs (6000 drops max).
- Limits: no lightning or thunder (a seeded flash schedule would fit `WeatherSet::Apply`), no snow
  accumulation, no per-region weather (regions only change wetness), rain doesn't follow wind
  direction, sky greying needs a Gradient sky, no puddle or wet-material shading (read `Wetness`
  and drive your materials).
