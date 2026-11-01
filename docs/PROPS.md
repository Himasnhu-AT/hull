# Props: things that break and things that bend (`src/props`, feature `props`)

Roadside props for driving and action games: posts, signs and saplings that topple when hit,
wood chips flung from the break, and shrubs or tall grass that bend when something drives
through them and spring back. The module only does the visuals and needs no physics engine
(it works without the `physics` feature).

**The game decides whether something breaks.** Your sim (car physics, damage rules, netcode)
detects the hit and sends a `Knock`. The engine never decides on its own that a prop breaks, so
a deterministic or networked sim stays the only source of truth.

```rust
use engine::prelude::*;

app.add_plugins(PropsPlugin)
    .insert_resource(PropGround::new(move |x, z| terrain.height(x, z)));

// A 1 m post, origin at its base:
commands.spawn((Breakable::new(1.0, 0.06), Scenery, Mesh3d(post), MeshMaterial3d(wood), tf));
// In the sim, when the car hits it:
knocks.write(Knock { entity: post, velocity: car_vel_at_contact, point: contact });
// On `Toppled`: splinters, a crack sound, and a few debris pieces:
vfx.play("splinters", Transform::from_translation(t.base));
spawn_debris(&mut commands, &chips, t.base, t.velocity, t.entity.to_bits());

// A shrub, and the car that pushes through shrubs:
commands.spawn((Sway::new(0.6, 0.9), Scenery, Mesh3d(shrub), MeshMaterial3d(leaves), tf));
commands.entity(car).insert(SwayPusher { half_extents: Vec2::new(0.9, 2.1) });
// On `Brushed`: vfx.play("leaves", ...) and a rustle scaled by `speed`.
```

## Toppling (`topple.rs`)

- `Breakable { height, radius, fallen }`: the entity's `Transform` origin is the base, the
  pivot it falls about. `radius` is its thickness (how far the lying tip stays above ground).
  `Breakable::new(h, r)` sinks 6 s after landing.
- `Knock { entity, velocity, point }`: knocks are ignored for entities without `Breakable` or
  already toppling (two knocks in one frame count once).
- The prop falls away from the hitter as a rigid rod pivoting at its base
  (`θ'' = 3g/(2h)·sin θ`). Initial spin = hit speed along the fall / `0.6·h`, capped at
  `9/√h` rad/s. The base slides with `0.35/h` of the hit speed (clamped 3–40 %) and slows at
  `0.5·g`. A 60 km/h hit flings a 1 m post ~3.5 m; a 4 m sapling slides ~0.2 m and tips over.
  It lands when the tip (plus `radius`) reaches `PropGround`, bounces once (20 % of its tip
  speed), and rests (≈ 90° minus the slope). A small per-entity random yaw and roll keep falls
  from looking scripted; the same entity always falls the same way.
- `Fallen::Stay` (stays, stops being simulated), `Sink { after }` (waits, sinks over 1.5 s,
  despawns with children), `Despawn { after }`.
- Messages: `Toppled { entity, base, velocity }` when it starts falling, `Landed { entity,
  point, speed }` on its first ground contact (tip speed, for a thud).
- `Toppling { state, fallen, still, sunk }` is on falling props; `ToppleState` is the pure,
  ECS-free math (`new`, `step(dt, ground)`, `pose`), unit tested on flat ground, slopes, dt
  spikes and NaN dt.
- A knocked child is detached from its parent (keeps its world pose).
- Without a `PropGround`, props land at their base's own height (flat ground).

## Debris (`debris.rs`)

`spawn_debris(&mut commands, &DebrisSpec { mesh, material, count, size, speed, life }, at,
push, seed)` spawns `count` mesh pieces. `push` is the hitter's velocity: each piece gets
20–60 % of it plus an upward spray of `speed`. Pieces fall, tumble, bounce and slide on
`PropGround` (or at `at.y` without one), shrink out over the last 20 % of their life, then
despawn. They don't collide with each other or with walls. Share one mesh and material per
kind of debris. For lots of small chips a particle preset (`splinters`) is cheaper: debris
entities are for a handful of bigger pieces.

## Sway (`sway.rs`)

- `Sway::new(radius, height)`: origin at the base. Defaults: `stiffness` 36 (ω = 6 rad/s),
  `damping` 7 (ζ ≈ 0.6, ~10 % overshoot, visually back in ~1 s, fully at rest in ~2 s),
  `max_bend` 1.1 rad, `flatten` 0.35. All fields are public; tune with
  `Sway { stiffness: 60.0, ..Sway::new(0.5, 1.0) }`.
- `SwayPusher { half_extents }`: an oriented box (half width on local X, half length on local
  Z) centred on the entity. Its velocity comes from its `GlobalTransform` between frames.
- Plants overlapping a pusher's box bend away from it (along its motion plus out of the box),
  harder with speed and overlap, and flatten while pressed; a spring-damper brings them back.
  Pushers more than 2 m above or below a plant are ignored (bridges).
- The rest pose is captured into `SwayRest` the first frame; the system writes rotation and
  scale relative to it, so plants can have any yaw and scale. If the game moves a plant,
  update `SwayRest`. Plants' parents should not be rotated (the bend is in world axes).
- `Brushed { plant, pusher, speed, point }`: the first frame a pusher touches a plant.
- `Sway::step(dt, push, press)` is the pure spring (tested for return, bounds, dt 1/30, spikes).

## Tagging for the render budget

- Tag `Breakable` and `Sway` props **`Scenery`** at spawn: they stand still almost always, and
  scenery gets distance fades, shadow trimming and (opt-in) hide-mode streaming.
- On `Knock` the engine turns the prop into an **`Actor`**: `Scenery` comes off the prop and
  its children, mesh classifications are redone (far twins despawned, engine ranges and
  trimmed shadows undone), and it leaves hide-mode streaming. A moving prop never keeps a
  stale static classification. Fallen props stay actors.
- Swaying plants keep `Scenery`: bending in place doesn't need actor treatment. Don't leave
  plants untagged: auto-classified scenery that moves becomes an actor for good.
- Debris pieces are tagged `Actor` by `spawn_debris`.

## Ordering and pause

Everything runs in `PostUpdate` in `PropsSet`, before transform propagation, and skips while
`Paused`. Send `Knock`s and move pushers in `Update` or `FixedUpdate`. Times use `Time`
(virtual), so `time.scale` applies; steps are clamped to 0.1 s.

Pushers and plants use last frame's `GlobalTransform`, so the bend lags the pusher by one frame.

## Performance

Idle plants cost one distance check per pusher per frame and their `Transform` is never written
(no change detection, no transform propagation). Measured (`cargo test --lib props::sway --
--ignored --nocapture`, dev profile, M-series Mac): `step_sway` takes **~10 µs** per frame for
2000 plants and 2 pushers driving through them. No spatial grid is needed at that scale.
Toppling props and debris are only simulated while they move or sink.

## Limits

- Props don't hit each other, walls or the car again once toppling; debris doesn't collide
  except with the ground.
- A prop is a rod: wide props (signs) land on their centreline plus `radius`, so give a sign
  board's half depth as `radius`.
- Sway uses one pusher's contact for `Brushed`: two pushers in the same plant at once send one.
