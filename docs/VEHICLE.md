# Vehicles (`engine::vehicle`, feature `vehicle`, needs `physics`)

A game-agnostic wheeled-vehicle skeleton on avian3d, tuned for low-speed off-road but
configurable for anything. It is a skeleton: small, readable, data-driven, with the places you
will reshape marked as traits or plain structs.

Code: `src/vehicle/` (`spec.rs` data, `mod.rs` the step, `tyre.rs`, `surface.rs`, `drivetrain.rs`,
`rope.rs`, `visual.rs`, `devtools.rs`, `tests.rs`), ruspy bindings `src/scripting/api_vehicle.rs`,
demo `examples/vehicle_demo.rs` + `scripts/vehicle-demo.json`.

## Quick start

```rust
app.add_plugins(engine::vehicle::VehiclePlugin);        // `engine::app` adds it with the feature
let spec = VehicleSpec::truck();
let truck = commands.spawn(spec.clone().bundle(Transform::from_xyz(0.0, 1.5, 0.0))).id();
spawn_wheel_visuals(&mut commands, truck, &spec, Color::BLACK);   // optional cylinders
// drive: write VehicleInput every frame
input.throttle = 1.0; input.steer = -0.3; input.transfer = 2;     // 4L
```

`bundle()` gives a dynamic rigid body, box collider, mass, inertia, centre of mass and the
[`Vehicle`] component, which pulls in `VehicleInput`, `VehicleTelemetry` and `VehicleState`. The
step runs in `FixedUpdate` (`VehicleSet`), before avian's step, and applies forces with avian's
`Forces`. Use it with the engine's physics pause like any body.

## What is simulated

- **Suspension** (per wheel, `WheelSpec` + `SpringSpec`): a probe from the mount along the chassis'
  down axis (`Probe::Ray`, or `Probe::Sphere` = a wheel-sized sphere swept down: rolls over edges and
  logs), spring rate, separate bump / rebound damping, travel (`min_len`, `max_len`), preload and a
  progressive bump stop. Load = spring force. Wheels are independent; **articulation** is the axle's
  `roll_coupling` (an anti-roll force between the two wheels of an axle): 0 follows bumps freely, a
  large value approximates a solid axle.
- **Tyres** (`TyreModel` trait, default `SlipCircleTyre`): slip speed and slip angle, each divided by
  its peak, one friction curve on the combined slip (a locked or spinning wheel loses side grip),
  load sensitivity, low-speed blend (no jitter at a standstill). The wheel spin is integrated with
  an implicit tyre step (`SUBSTEPS` = 4 per tick), stable at walking pace. Rolling resistance and
  sink drag come from the surface. **Pressure** (`Vehicle::pressure` vs `TyreSpec::pressure`): lower
  pressure grows the patch: more grip and less rolling resistance on soft surfaces, a little less
  grip and more rolling resistance on hard ones (`Surface::softness` decides).
- **Surfaces** (`Surfaces` table, shared `SurfaceMap` trait from `src/surface.rs`, also used by `spray`; `SurfaceId::GRASS` added): grip, rolling, sink drag, softness and wet
  multipliers per `SurfaceId`. The map answers "what is under this wheel" from a `SurfaceQuery`
  (`SurfaceProbe`, alias `SurfaceQuery`: point, normal, optional collider, its `SurfaceTag`); the default reads `SurfaceTag` on the collider, the
  demo samples a mud disc by position. `Wetness` (0..1 resource, shared with `weather`, which writes it) scales grip / rolling by each
  surface's `wet_*`.
- **Drivetrain**: engine torque curve with redline cut and engine braking, gearbox (ratios, reverse,
  final drive, automatic shifting on ground speed, or manual with `VehicleInput::shift`), transfer
  case modes as data (`TransferMode { front, rear, range, centre_lock }`: 2H / 4H / 4L in the truck;
  `range` is the low-range reduction; a locked centre passes torque an axle cannot use to the other),
  differentials per axle (`Diff::Open` equal torque so the weaker wheel limits both, `Locked`,
  `LimitedSlip(k)`), driver lock per axle (`VehicleInput::diff_lock`, for `lockable` axles). Drive
  torque to each wheel is capped by what its tyre can transmit, which gives open-diff behaviour
  (thrust = 2 x the weaker wheel) without simulating the diff's inertia.
- **Brakes**: service brake with front bias, handbrake (axles per `BrakeSpec`), parking brake
  (`VehicleInput::park`) and an optional automatic hold at a standstill (`auto_hold_speed`; it also
  holds a vehicle that is only creeping, so release it on purpose: `park = false`, throttle).
- **Steering**: lock shrinks with speed, rate-limited, per-wheel factor (rear steer, 4-wheel steer).
- **Ropes** (`Rope`, own entity): winch cable and tow strap. A one-sided spring-damper between two
  ends (`RopeEnd::World(point)` or `RopeEnd::Body { entity, local }`), force capped at `max_force`
  (a winch cannot exceed its line pull; the motor stalls), motor `reel` -1..1 at `reel_speed`, optional
  `break_force` (strap snaps: `RopeSnapped`). `Rope::winch(..)` and `Rope::strap(..)` are the presets.
  This is a compliant rope, not an avian joint: it needs no joint solver, so the cap and the motor are
  plain numbers you can read (`tension`, `length`).
- **Aero drag** (`aero_drag`).

## Extension points

| Want | Do |
|---|---|
| another tyre model (brush, table, arcade) | implement `TyreModel`, put an `Arc` in `VehicleSpec::tyre_model` |
| surfaces from terrain layers, splat maps, materials | implement `SurfaceMap`, replace `SurfaceMapRes`; edit `Surfaces` |
| a different vehicle | build a `VehicleSpec` (every number is a field); `truck()` is the template |
| more transfer positions | push a `TransferMode`; select with `VehicleInput::transfer` |
| your own wheel meshes | put `WheelVisual { wheel, angle: 0.0 }` on any child, or read `VehicleTelemetry::wheels` |
| sound / camera shake | read `VehicleEvent` and `VehicleTelemetry` |
| damage, tyre wear, fuel | change `Vehicle::grip_scale`, `pressure`, or the spec between ticks |

## Telemetry and events

`VehicleTelemetry`: `speed` (signed, along forward), `rpm`, `gear`, `throttle`, `engine_load`,
`transfer`, `grounded_wheels`, `bottomed`, `max_slip`, and per wheel `WheelTelemetry` (`grounded`,
`compression` 0..1, `load`, `slip_ratio`, `slip_angle`, `spin`, `steer`, `surface`, `contact`,
`normal`, `drive_torque`, `len`). Events (`MessageReader<VehicleEvent>`): `WheelLanded`,
`BottomedOut`, `RopeStrain` (passes 75 % of the limit), `RopeSnapped`.

## Control commands (feature `devtools`)

`vehicle.list`, `vehicle.state {entity}` (full telemetry), `vehicle.input {entity, throttle, steer,
brake, handbrake, park, transfer, diff_lock: [axle, bool], shift}`, `vehicle.spawn {pos}`.

## ruspy

`vehicle_drive([n,] throttle, steer, brake)`, `vehicle_handbrake`, `vehicle_park`,
`vehicle_set_mode([n,] "4L")`, `vehicle_diff_lock([n,] axle, bool)`, `vehicle_shift`,
`vehicle_set_pressure`, `vehicle_get([n,] "rpm")`, `vehicle_wheel([n,] i, "compression")`,
`winch_attach([n,] local, point_or_node)`, `tow_strap([n,] local, other, other_local, length)`,
`rope_reel(rope, x)`, `rope_tension(rope)`, `rope_length(rope)`, `rope_release(rope)`
(see docs/SCRIPTING.md). Telemetry comes back as numbers by key (ruspy dictionaries are not used yet).

## Tests and measurements

`memgate -- cargo test -q --lib vehicle` (headless, ~1 s): rest height (0.93 m body origin, loads
sum to the weight), 26 degree dirt slope (4L climbs 8+ m in 7 s, 2H stalls under 3 m), split-grip
ice/asphalt (locked rear diff covers over twice the distance of open), a winch pulls a truck out
of mud, wheel-landing events, aired-down tyres on sand, drivetrain unit tests, and the ruspy
bindings (`scripting::tests_vehicle`).

## Known limits

- Single probe per wheel (a ray or sphere); no tyre flex or sidewall, so very sharp edges still jolt.
- Solid axles are approximated by `roll_coupling`; there is no kinematic beam.
- The chassis is one box collider; no damage model, no engine stall or clutch, no turbo or
  fuel. A low gear at standstill simply floors the idle rpm.
- Wheel forces are explicit on the chassis; the passive-friction clamp keeps a standstill steady,
  but extreme spec values (a tiny chassis mass with a huge tyre force) can still jitter.
- Ropes are straight lines: no wrapping around trunks, no sag, no rope mass.
- Handbrake / auto-hold torque is a brake torque, so on a steep slope a hold can slip under a big
  load; raise `handbrake_torque`.
- The demo's surface map is analytic (a disc); a heightfield collider has no per-triangle material.
