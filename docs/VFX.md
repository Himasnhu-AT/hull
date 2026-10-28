# VFX / particles (`engine::vfx`, feature `vfx`)

Code-first particle effects: the Niagara / VFX Graph feature set that games actually use,
defined as plain Rust data (or JSON), simulated deterministically on the CPU in
structure-of-arrays buffers, drawn with one instanced draw call per emitter. No editor, no
binary assets: textures are generated procedurally at startup, effects are `EffectDef` values
you can read, diff, test and send over the control port.

`EnginePlugin` adds `VfxPlugin` when the feature is on (it is in `default`). Headless runs get
the simulation, pooling, budgets and control commands; the renderer is added only when Bevy's
PBR plugin exists.

## Quick start

```rust
use engine::prelude::*;
use engine::vfx::{Burst, ParticleEffect, Shape, Velocity};

// One-shot, pooled (finished instances are recycled, no spawn churn):
fn on_hit(mut vfx: Vfx) {
    vfx.play("explosion", Transform::from_xyz(0.0, 0.0, -8.0));
}

// Persistent and attached to something (follows the parent, even if it moved this frame):
commands.spawn((ParticleEffect::new("fire"), Transform::from_xyz(0.0, 0.2, 0.0), ChildOf(campfire)));

// Your own effect, in Rust:
app.world_mut().resource_mut::<VfxLibrary>().register(
    EffectDef::new("puff").once(0.05).with(EmitterDef {
        bursts: vec![Burst::at(0.0, 12)],
        shape: Shape::Sphere { radius: 0.1, surface: false },
        velocity: Velocity::Radial { speed: (1.0, 2.0) },
        ..default()
    }),
)?;
```

Stop an endless effect with `ParticleEffect::emitting = false` (its particles live out their
life, then `OnFinish` applies: `Despawn` (default), `Pool` (what `Vfx::play` uses) or `Keep`).
Restart one by inserting `VfxRestart`. `ParticleEffect::seed` makes a replay bit-identical;
without it seeds come from a counter that starts at `GameSeed` (so `--seed` runs replay).

## Effect definitions (`src/vfx/def.rs`)

`EffectDef { name, emitters, duration, looping, follow_camera, cull_distance, lod, light }`.
`duration > 0 && !looping` = one-shot (finished when emission is over and every particle is
dead); `duration > 0 && looping` repeats bursts every cycle; `duration == 0` emits forever.

Each `EmitterDef` (all fields have defaults, build with `..default()`):

| area | fields |
|---|---|
| spawning | `capacity` (per-emitter budget, buffers never grow past it), `rate` (/s), `rate_per_meter` (trails behind moving effects; spawns are spread along the path and pre-aged), `bursts` (`time, count, cycles, interval`), `delay` |
| shape | `Point`, `Sphere{radius, surface}`, `Hemisphere`, `Cone{angle, radius}`, `Box{half}`, `Disc`, `Ring`, `Line`, `Points(Vec<Vec3>)` (`Shape::mesh_surface(&mesh, n, seed)` samples a mesh's triangles, area-weighted), `offset` |
| velocity | `Radial{speed}` (out of the shape; cone half-angle for `Cone`), `Cone{dir, angle, speed}`, `Fixed{v, jitter}`, `inherit_velocity` |
| forces | `gravity`, `drag`, `turbulence` (divergence-free curl field: `strength, frequency, speed`), `attractors` (`offset, strength, radius, kill_radius`; negative repels), `orbit` (`axis, speed, radial`), `local_space` |
| look over life | `size` + `size_over_life: Curve`, `aspect`, `color_over_life: Gradient` (linear RGBA, `Gradient::srgb` for picker colours), `start_tint` (random per particle), `rotation`, `spin` |
| collision | `Plane{height, restitution, friction, die}`, `Physics{restitution, friction, die}` (avian raycasts, feature `physics`) |
| sub-emitters | `SubEmitter{on: Spawn/Death/Collision, emitter: "<later emitter's name>", count, inherit_velocity, chance}` |
| rendering | `RenderDef{mode, texture, blend, intensity, lit, soft, flipbook, sort}` |

Render modes: `Billboard` (camera-facing, rotated), `Stretched{factor}` (along velocity:
sparks, rain), `Trail{points, interval, taper}` (ribbon through each particle's recent
positions: magic wisps, explosion streaks), `Flat{normal}` (quads in a plane: shockwave rings,
ripples), `Mesh{shape: Cube/Tetra/Shard}` (lit tumbling debris, `StandardMaterial`), `None`
(simulation only, e.g. a carrier for sub-emitters). Blending: `Alpha`, `Additive`, or
`Mix(f)` (premultiplied alpha-add, one pipeline for all). `intensity > 1` is HDR (blooms).
`lit` (0..1) = wrap-diffuse from the scene's directional lights + ambient with a rounded sprite
normal. `soft` = soft-particle fade distance against the depth prepass (free when the camera
already has one, e.g. SSAO at High/Ultra; ignored otherwise). `flipbook` = texture-sheet
animation (`cols, rows, fps` or over life, `random_start`, crossfaded frames). `sort` =
back-to-front within the emitter (alpha emitters; additive needs none).

Textures (`VfxTexture`): `Dot`, `Spark`, `Smoke` (4×4 flipbook of an evolving noise puff),
`Flare`, `Ring`, `White`, all generated in `textures.rs` (~ms at startup, with mips).

`EffectLight{color, intensity, range, offset, duration, over_time, flicker}` gives an effect a
point light (no shadows); the `VfxBudget::max_lights` (8) nearest lit effects get one.

Validation happens once in `CompiledEffect::new` (`VfxLibrary::register`): emitter capacity,
lifetimes, sub-emitter names (must refer to a later emitter), flipbook and trail sizes. Curves
and gradients are baked into 64-entry tables then.

### Data files

`EffectDef` is serde: `VfxLibrary::load_json(path)` registers one effect or an array of them.
The easiest way to author one is to start from a preset: `vfx.get {preset: "smoke"}`, edit the
JSON, `vfx.define {def}`; playing instances restart with the new definition.

## Presets (`src/vfx/presets.rs`)

`sparks` (stretched, bouncing, glow + light), `smoke` (lit, soft, sorted flipbook column with
curl turbulence), `fire` (crossfading flame flipbook, embers, smoke, flickering light),
`muzzle_flash` (one-shot along -Z: flare, flame cone, sparks, smoke wisp, 60 ms light),
`explosion` (one-shot: flash, fireball, flat shockwave ring, ribbon streaks that fire `pops` on
death, tumbling lit debris bouncing on y = 0, lingering lit smoke, fading light), `dust_puff`,
`magic` (orbiting ribbon wisps, motes falling into an attractor, per-metre sparkle trail when
it moves), `rain` / `snow` (`follow_camera`: 36×36 m / 32×32 m around the camera; rain dies on
y = 0 with splash sub-emitters, snow drifts in a curl field and settles), `stress` (benchmark
load).

## Runtime (`src/vfx/mod.rs`)

- Systems run in `PostUpdate` (`VfxSet`): `Prepare` (quality → LOD scale, resolve/restart
  instances, follow camera) → `Simulate` (parallel over effects) → `Collide` (physics) before
  transform propagation; `Render` after frusta, before visibility.
- **Pause**: the simulation uses `Time<Virtual>`, so `Paused`, `time.scale` and `time.step`
  apply. `VfxBudget::pause_with_game = false` uses real time instead.
- **Budgets** (`VfxBudget`): `max_particles` (200 000, global; spawns beyond it are dropped and
  counted), per-emitter `capacity`, `max_effects` (`Vfx::play` refuses beyond), `pool_per_effect`
  (16), `collision_rays` per frame (2048, round robin), `max_dt` (0.1 s, a hitch never explodes
  the simulation), `max_lights`, `parallel`.
- **Near the camera** (`VfxBudget::near_fade`, `max_screen`): sprites fade out as their edge
  comes within `near_fade` of the camera (gone at 0.1 m, untouched beyond 1 m; colour fades too
  in proportion to additive blending), and a sprite is at most `max_screen` (0.9) × its distance
  wide. A muzzle or impact puff at 0.5–2 m otherwise covers the screen: tens of millions of
  blended pixels (2–5 ms at Retina) and a white-out. Trails are untouched. Mesh particles
  (debris) cast no shadows.
- **LOD / culling**: spawn counts scale from 1 at `lod.near` (25 m) to `lod.min_scale` (0.2) at
  `lod.far` (120 m); beyond `cull_distance` (250 m) nothing spawns or draws. All distances ×
  `VfxBudget::distance_scale`, which follows `QualityPreset::detail_scale` (Low 0.6 … Ultra 1.5)
  unless `follow_quality = false`. Emitters outside every camera frustum aren't rebuilt.
- **Pooling**: `Vfx::play` reuses an idle instance of the same effect: same entity, same
  buffers (capacity kept), new seed and position. No spawn, no allocation in steady state.
- **Stats**: `VfxStats` (effects, active, pooled, culled, emitters, particles, peak, spawned,
  dropped, refused, drawn emitters/particles, GPU instances, `sim_us`, `build_us`,
  `upload_us`, collision rays). Dev builds record `vfx.particles`, `vfx.effects`,
  `vfx.drawn_emitters`, `vfx.sim_us`, `vfx.build_us`, `vfx.upload_us`, `vfx.dropped` into
  `Metrics` (metrics window, `metrics.dump {prefix: "vfx."}`).

## Simulation (`src/vfx/sim.rs`)

Pure and deterministic, no ECS: `CompiledEffect` + `InstanceState::step(&fx, &FrameCtx, &Budget)`.
Particles are SoA (`Vec<Vec3A>` positions/velocities, `f32` age/life/size/rotation/spin, `u32`
seed, trail rings), allocated once at capacity, killed by swap-remove. Forces are separate
tight loops, each skipped when unused (curl turbulence uses a fast sine). Sub-emitter triggers
are delivered to later emitters in the same frame. Same seed + same `dt` sequence = identical
particles: headless tests assert exact positions (`tests/vfx.rs`, unit tests in each module).

## Rendering (`src/vfx/render.rs`, `src/vfx/gpu.rs`, `src/vfx/particle.wgsl`)

```text
PostUpdate  draw: per emitter frustum test, then (parallel over effects) one 52-byte
            SpriteInstance per particle / ribbon segment into the effect's draw list
Extract     memcpy every visible list into one RawBufferVec + ranges
Prepare     one queue.write_buffer; material bind groups cached per (texture, params)
Queue       one Transparent3d item per emitter, sorted by its bounds centre
Draw        set_vertex_buffer + draw(0..4, range)  (triangle strip per instance)
```

The pipeline reuses Bevy's mesh view bind group (view, lights, fog, depth prepass,
tonemapping LUT), so lit, soft and fogged particles behave like PBR materials (additive ones
fade in fog instead of taking its colour). Output is premultiplied, so alpha, additive and
alpha-add share one pipeline per view. Mesh particles are baked into one vertex-coloured mesh
per emitter with a shared `StandardMaterial` (lit, shadowed); tag-free for `render_budget`
(they are `Actor`s). While particles are drawn the system sends `RequestRedraw`, so
`RenderBudget::idle_skip` never freezes them.

## Control commands

| command | params | does |
|---|---|---|
| `vfx.spawn` | `preset`, `pos: [x,y,z]` (or `x,y,z`), `seed`, `persistent` | play an effect (pooled one-shot, or a persistent `ParticleEffect`) → `{entity, effect, pos}` |
| `vfx.stats` | | `VfxStats`, `VfxBudget`, and up to 64 effects (alive per emitter, time, idle, culled, distance, lod, pos) |
| `vfx.clear` | | despawn every effect, empty the pool |
| `vfx.list` | | registered effects (emitters, capacity, duration, looping) |
| `vfx.get` | `preset` | an effect's `EffectDef` as JSON |
| `vfx.define` | `def` | register / replace an effect from JSON; playing instances restart |
| `vfx.budget` | `max_particles`, `max_effects`, `collision_rays`, `parallel`, `pause_with_game`, `distance_scale` | read / change `VfxBudget` |

The gallery adds `gallery.focus {preset}`, `gallery.stress {count}`, `gallery.camera {pos, look, orbit}`.

## Example

`examples/vfx_gallery.rs`: every preset on one ground (one-shots replay every 2.5 s, the magic
orb flies a circle). `--preset <name>` frames one, `--weather rain|snow` adds weather,
`--stress <n>` runs `n` particles, `--many <n>` runs `n` looping effects on a grid,
`--uncapped` turns vsync off. Screenshots of every preset:
`python3 -I scripts/play.py steps.json --example vfx_gallery` with steps like
`{"cmd": "gallery.focus", "params": {"preset": "explosion"}}, {"sleep": 0.3}, {"shot": "explosion"}`.

## Measurements

Apple M5 Pro, dev profile (engine crate `opt-level = 1`, dependencies 3), `--offscreen
--uncapped --perf`, 1920×1080, High quality (SSAO, TAA, bloom), one process per row, 10 s,
`metrics.dump` session p50 (p95) after the 3 s warm-up. The machine was shared with other
builds/benchmarks, so frame times carry a few ms of noise; the `vfx.*` timings are this
module's own work.

`--stress n`: one emitter, small additive dots in a 5 m ball, steady state.

| particles | frame ms | GPU ms | sim µs | build µs | extract+upload µs |
|---|---|---|---|---|---|
| ~0 (baseline) | 3.37 (4.49) | 2.60 | 15 | 2 | 9 |
| 1 000 | 3.43 (4.49) | 2.60 | 21 | 5 | 35 |
| 10 000 | 3.72 (4.77) | 2.71 | 44 | 41 | 104 |
| 100 000 | 5.59 (6.37) | 3.79 | 282 | 483 | 834 |

- 100k particles cost ~2.2 ms of frame time and ~1.2 ms GPU (overdraw of 100k sprites).
  Simulation is ~2.8 ns/particle/frame, instance building ~4.8 ns; extract + upload runs on the
  render thread (pipelined), not the main thread.
- First version drew through a per-emitter Bevy `Mesh` (4 vertices × 32 B per particle,
  re-uploaded as a mesh asset): 100k particles → frame 10.16 (11.45) ms, build 988 µs. The
  instanced path (52 B per particle, one shared buffer, no mesh re-extraction) halved the
  frame time at 100k and replaced it.
- `--many 200` (200 looping effects: fire/smoke/sparks/magic, 441 emitters, ~14k particles,
  machine under load): simulation 149 µs and build 172 µs in parallel vs 321 µs / 344 µs with
  `vfx.budget {parallel: false}`; GPU 3.6 ms.
- Startup: procedural textures (5 sprites + 512² smoke flipbook with mips) are generated once in
  `Startup`; headless runs skip them.
- Headless: `tests/vfx.rs` (9 tests, ~2 000 simulated frames in total) runs in ~0.5 s.

## Known limits

- CPU simulation only (no GPU compute path): fine to a few 100k particles; beyond that a GPU
  sim would be needed. A single emitter is simulated and built on one thread (effects run in
  parallel with each other).
- Particles ignore `RenderLayers` (queued to every 3D view) and are not drawn into shadow maps
  or reflection probes; `lit` uses directional lights + ambient only (no point/spot lights or
  shadows on particles).
- Ribbons are camera-facing segments per particle history (no ribbon connecting separate
  particles, no UV tiling along the length; joints of sharp turns can show small gaps).
- `local_space` follows the effect's translation only (not rotation).
- Physics collision raycasts each particle's last step (fast particles beyond the per-frame ray
  budget may tunnel through thin geometry for a frame); plane collision is exact.
- Soft particles need a depth prepass on the camera and are skipped with MSAA.
- No visual editor by design; effects are code/JSON (`vfx.get` / `vfx.define` for live tweaks).
