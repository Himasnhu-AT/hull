//! Surface spray (feature `spray`): dust, sand, mud, snow, tyre smoke, water mist and flying
//! chips thrown up by wheels or **any emitter point** (a hull, a boot, a paw) according to the
//! surface under it, its speed and its slip. Built on [`crate::vfx`]: persistent
//! `ParticleEffect`s whose `rate_scale` follows the intensity, so nothing spawns at rest.
//! Docs: `docs/ENVIRONMENT.md`.
//!
//! ```ignore
//! // A wheel: a child entity at the contact patch.
//! commands.entity(car).with_child((SprayPoint::default(), SprayInput::default(), SprayTracker::default(), Transform::from_xyz(0.9, -0.35, 1.2)));
//! // Tell the module what is under the wheels (or fill `SprayInput.surface` yourself):
//! commands.insert_resource(SurfaceMapRes::from_fn(|p| Some(if p.x > 0.0 { SurfaceId::MUD } else { SurfaceId::GRAVEL })));
//! ```
//!
//! - [`SprayRules`] (data): which kind sprays on which surface, how much rolling and slip
//!   contribute, the speeds. [`SprayPalette`] (data): the colours (re-register effects with
//!   [`register_effects`] after changing it).
//! - [`SprayInput`] on the emitter says what is happening; [`SprayTracker`] derives speed and slip
//!   from how the entity moves, so a plain moving entity needs no game code.
//! - Effects are created the first time a kind is needed at a point, never before, and are
//!   capped by `VfxBudget`. The vfx near-camera fade keeps a chase camera from whiting out.

mod defs;

#[cfg(feature = "devtools")]
mod control;

use bevy::prelude::*;

pub use defs::{SprayPalette, defs};

use crate::surface::{SurfaceId, SurfaceMapRes};
use crate::vfx::{ParticleEffect, VfxLibrary, VfxSet};

/// What is thrown up.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SprayKind {
    Dust,
    Sand,
    Chips,
    Mud,
    Snow,
    /// Faint tyre smoke on hard ground when sliding hard.
    Smoke,
    /// Water mist off the tyres on a wet road, growing with speed.
    Water,
}

impl SprayKind {
    pub const ALL: [SprayKind; 7] = [SprayKind::Dust, SprayKind::Sand, SprayKind::Chips, SprayKind::Mud, SprayKind::Snow, SprayKind::Smoke, SprayKind::Water];

    /// The vfx effect name.
    pub fn effect(self) -> &'static str {
        match self {
            SprayKind::Dust => "spray_dust",
            SprayKind::Sand => "spray_sand",
            SprayKind::Chips => "spray_chips",
            SprayKind::Mud => "spray_mud",
            SprayKind::Snow => "spray_snow",
            SprayKind::Smoke => "spray_smoke",
            SprayKind::Water => "spray_water",
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// The ground under an emitter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum Surface {
    /// Tarmac, concrete, rock.
    #[default]
    Hard,
    Gravel,
    /// Dry loose soil.
    Dirt,
    Sand,
    Grass,
    Mud,
    Snow,
    /// A wet road or shallow water.
    Wet,
}

impl Surface {
    /// The spray surface for a shared [`SurfaceId`] (unknown ids are `Hard`).
    pub fn from_id(id: SurfaceId) -> Surface {
        match id {
            SurfaceId::GRAVEL => Surface::Gravel,
            SurfaceId::DIRT => Surface::Dirt,
            SurfaceId::SAND => Surface::Sand,
            SurfaceId::MUD => Surface::Mud,
            SurfaceId::SNOW => Surface::Snow,
            SurfaceId::GRASS => Surface::Grass,
            _ => Surface::Hard,
        }
    }
}

/// One row of the spray table: `kind` is thrown up on `surface`.
///
/// `intensity = clamp(gain * (roll * ramp^power * moving * axle + slip_w * slip_term * (0.4 + 0.6 * ramp)))`
/// where `ramp` runs 0..1 from `speed_min` to `speed_full`, `moving` fades in over the first
/// 3 m/s (nothing at a standstill), `axle` is `axle.0` for a front point and `axle.1` for a rear one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SprayRule {
    pub kind: SprayKind,
    pub surface: Surface,
    pub gain: f32,
    /// Weight of the rolling term (speed alone raises it).
    pub roll: f32,
    /// Weight of the slip term.
    pub slip: f32,
    /// Slip (0..1) must pass this before it counts.
    pub slip_from: f32,
    pub speed_min: f32,
    pub speed_full: f32,
    pub power: f32,
    pub axle: (f32, f32),
}

impl SprayRule {
    pub const fn new(kind: SprayKind, surface: Surface) -> Self {
        SprayRule { kind, surface, gain: 1.0, roll: 1.0, slip: 1.0, slip_from: 0.0, speed_min: 0.0, speed_full: 22.0, power: 1.0, axle: (0.35, 0.7) }
    }
    pub const fn gain(mut self, g: f32) -> Self {
        self.gain = g;
        self
    }
    /// Only slip raises it (a skid, not a roll).
    pub const fn slip_only(mut self, gain: f32) -> Self {
        self.roll = 0.0;
        self.gain = gain;
        self
    }
}

/// The spray table (resource, data): defaults for a car on mixed ground.
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct SprayRules(pub Vec<SprayRule>);

impl Default for SprayRules {
    fn default() -> Self {
        use Surface as S;
        use SprayKind as K;
        SprayRules(vec![
            SprayRule::new(K::Dust, S::Gravel),
            SprayRule::new(K::Dust, S::Dirt).gain(0.4),
            SprayRule::new(K::Dust, S::Grass).gain(0.5),
            SprayRule::new(K::Sand, S::Sand),
            SprayRule::new(K::Chips, S::Gravel).slip_only(1.4),
            SprayRule::new(K::Mud, S::Mud),
            SprayRule::new(K::Mud, S::Grass).slip_only(0.5),
            SprayRule::new(K::Snow, S::Snow),
            SprayRule { slip_from: 0.5, ..SprayRule::new(K::Smoke, S::Hard).slip_only(1.0) },
            // Spray needs speed: none at a crawl, a plume by ~100 km/h, more off the rears.
            SprayRule { speed_min: 6.0, speed_full: 28.0, power: 2.0, axle: (0.5, 1.0), slip: 0.3, ..SprayRule::new(K::Water, S::Wet) },
        ])
    }
}

/// How hard `rule` throws its kind: 0..1. `slip` is 0..1 (a slide), `rear` picks the axle weight.
pub fn intensity(rule: &SprayRule, speed: f32, slip: f32, rear: bool) -> f32 {
    let ramp = ((speed - rule.speed_min) / (rule.speed_full - rule.speed_min).max(1e-3)).clamp(0.0, 1.0);
    // Nothing at a standstill (tyres carry a little slip even when held).
    let moving = ((speed - 0.8) / 3.0).clamp(0.0, 1.0);
    let slip_term = ((slip - rule.slip_from) / (1.0 - rule.slip_from).max(1e-3)).clamp(0.0, 1.0) * moving;
    let axle = if rear { rule.axle.1 } else { rule.axle.0 };
    let roll = rule.roll * ramp.powf(rule.power) * moving * axle;
    (rule.gain * (roll + rule.slip * slip_term * (0.4 + 0.6 * ramp))).clamp(0.0, 1.0)
}

/// Intensity of `kind` on `surface` under `rules` (the strongest matching row).
pub fn kind_intensity(rules: &SprayRules, kind: SprayKind, surface: Option<Surface>, speed: f32, slip: f32, rear: bool) -> f32 {
    let Some(s) = surface else { return 0.0 };
    rules.0.iter().filter(|r| r.kind == kind && r.surface == s).map(|r| intensity(r, speed, slip, rear)).fold(0.0, f32::max)
}

/// An emitter point: the entity's `Transform` is where the spray starts (a contact patch).
/// Effects are children, spawned when first needed.
#[derive(Component, Clone, Debug)]
pub struct SprayPoint {
    /// Which kinds this point may throw (`None`: all the rules know).
    pub kinds: Option<Vec<SprayKind>>,
    /// A rear point (wheels behind the centre throw more).
    pub rear: bool,
    /// Scales every intensity (0 mutes the point).
    pub scale: f32,
}

impl Default for SprayPoint {
    fn default() -> Self {
        SprayPoint { kinds: None, rear: false, scale: 1.0 }
    }
}

/// What is happening at a point: write it (from a vehicle sim) or let [`SprayTracker`] derive it.
#[derive(Component, Clone, Copy, Debug, Default, PartialEq)]
pub struct SprayInput {
    /// `None` sprays nothing (airborne / unknown); the shared [`SurfaceMapRes`] fills it when a tracker is on.
    pub surface: Option<Surface>,
    /// Metres per second of the point over the ground.
    pub speed: f32,
    /// 0..1 how hard it slides.
    pub slip: f32,
}

/// Derives [`SprayInput`] speed and slip from how the entity moves (its sideways share of the
/// velocity against its forward `-Z` axis) and the surface from the shared [`SurfaceMapRes`] (`crate::surface`).
#[derive(Component, Clone, Copy, Debug)]
pub struct SprayTracker {
    /// Sideways share of the speed that counts as full slip.
    pub slip_at: f32,
    last: Option<Vec3>,
}

impl Default for SprayTracker {
    fn default() -> Self {
        SprayTracker { slip_at: 0.5, last: None }
    }
}

/// The effect entities of a point, by kind (lazily filled).
#[derive(Component, Default)]
pub struct SprayKids([Option<Entity>; 7]);

pub struct SprayPlugin;

impl Plugin for SprayPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<SprayRules>()
            .init_resource::<SprayPalette>()
            .add_systems(Startup, register_palette)
            .add_systems(PostUpdate, (track, drive).chain().run_if(any_with_component::<SprayPoint>).before(VfxSet::Prepare));
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

/// (Re)registers the spray effects in the library for `palette`.
pub fn register_effects(lib: &mut VfxLibrary, palette: &SprayPalette) {
    for d in defs(palette) {
        if let Err(e) = lib.register(d) {
            error!("spray effect: {e}");
        }
    }
}

fn register_palette(mut lib: Option<ResMut<VfxLibrary>>, palette: Res<SprayPalette>) {
    if let Some(lib) = lib.as_mut() {
        register_effects(lib, &palette);
    }
}

fn track(time: Res<Time>, map: Option<Res<SurfaceMapRes>>, mut q: Query<(&GlobalTransform, &mut SprayTracker, &mut SprayInput)>) {
    let dt = time.delta_secs();
    for (g, mut tr, mut input) in &mut q {
        let pos = g.translation();
        let last = tr.last.replace(pos);
        if dt > 1e-5
            && let Some(last) = last
        {
            let v = (pos - last) / dt;
            let flat = Vec3::new(v.x, 0.0, v.z);
            let speed = flat.length();
            let fwd = g.rotation() * Vec3::NEG_Z;
            let side = g.rotation() * Vec3::X;
            let sideways = if speed > 1.0 { (flat.dot(side).abs() / speed - 0.0).max(0.0) } else { 0.0 };
            let _ = fwd;
            // Smooth: a physics step is not a frame.
            let k = 1.0 - (-14.0 * dt).exp();
            input.speed += (speed.min(120.0) - input.speed) * k;
            let slip = (sideways / tr.slip_at.max(1e-3)).clamp(0.0, 1.0);
            input.slip += (slip - input.slip) * k;
        }
        if let Some(map) = &map {
            let s = map.0.surface_at(pos).map(Surface::from_id);
            if input.surface != s {
                input.surface = s;
            }
        }
    }
}

fn drive(
    mut commands: Commands,
    rules: Res<SprayRules>,
    lib: Option<Res<VfxLibrary>>,
    mut points: Query<(Entity, &SprayPoint, &SprayInput, Option<&mut SprayKids>)>,
    mut fx: Query<&mut ParticleEffect>,
) {
    for (e, p, input, kids) in &mut points {
        let Some(mut kids) = kids else {
            commands.entity(e).insert(SprayKids::default());
            continue;
        };
        for kind in SprayKind::ALL {
            if p.kinds.as_ref().is_some_and(|k| !k.contains(&kind)) {
                continue;
            }
            let k = kind_intensity(&rules, kind, input.surface, input.speed, input.slip, p.rear) * p.scale;
            match kids.0[kind.index()] {
                Some(id) => {
                    if let Ok(mut f) = fx.get_mut(id)
                        && ((f.rate_scale - k).abs() > 0.02 || (k == 0.0 && f.rate_scale != 0.0))
                    {
                        f.rate_scale = k;
                    }
                }
                None if k > 0.0 && lib.as_ref().is_some_and(|l| l.get(kind.effect()).is_some()) => {
                    let mut f = ParticleEffect::new(kind.effect());
                    f.rate_scale = k;
                    let id = commands.spawn((Name::new("spray"), f, Transform::default(), ChildOf(e))).id();
                    kids.0[kind.index()] = Some(id);
                }
                None => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> SprayRules {
        SprayRules::default()
    }
    fn k(kind: SprayKind, s: Option<Surface>, speed: f32, slip: f32, rear: bool) -> f32 {
        kind_intensity(&rules(), kind, s, speed, slip, rear)
    }

    #[test]
    fn spray_needs_speed_or_slip_and_the_right_surface() {
        use Surface as S;
        assert_eq!(k(SprayKind::Dust, Some(S::Gravel), 0.0, 0.0, true), 0.0);
        assert_eq!(k(SprayKind::Dust, Some(S::Gravel), 0.2, 0.3, true), 0.0, "a held tyre carries slip: nothing");
        assert!(k(SprayKind::Dust, Some(S::Gravel), 25.0, 0.0, true) > 0.5);
        assert!(k(SprayKind::Dust, Some(S::Gravel), 25.0, 0.0, false) < k(SprayKind::Dust, Some(S::Gravel), 25.0, 0.0, true));
        assert_eq!(k(SprayKind::Dust, Some(S::Hard), 25.0, 0.3, true), 0.0);
        assert_eq!(k(SprayKind::Smoke, Some(S::Hard), 25.0, 0.0, true), 0.0);
        assert!(k(SprayKind::Smoke, Some(S::Hard), 25.0, 0.8, true) > 0.3);
        assert!(k(SprayKind::Snow, Some(S::Snow), 20.0, 0.1, true) > 0.3);
        assert!(k(SprayKind::Sand, Some(S::Sand), 20.0, 0.1, true) > 0.3);
        assert_eq!(k(SprayKind::Mud, None, 20.0, 0.5, true), 0.0);
        // Wet roads spray with speed, dry tarmac does not; the rear throws more.
        assert_eq!(k(SprayKind::Water, Some(S::Wet), 4.0, 0.0, true), 0.0);
        assert!(k(SprayKind::Water, Some(S::Wet), 30.0, 0.0, true) > 0.8);
        assert!(k(SprayKind::Water, Some(S::Wet), 30.0, 0.0, false) < 0.6);
        assert_eq!(k(SprayKind::Water, Some(S::Hard), 30.0, 0.0, true), 0.0);
        // Chips come from a slide on gravel only.
        assert_eq!(k(SprayKind::Chips, Some(S::Gravel), 25.0, 0.0, true), 0.0);
        assert!(k(SprayKind::Chips, Some(S::Gravel), 25.0, 0.6, true) > 0.3);
    }

    #[test]
    fn rules_are_data_edit_a_row_and_it_changes() {
        let mut r = rules();
        let before = kind_intensity(&r, SprayKind::Dust, Some(Surface::Dirt), 20.0, 0.0, true);
        r.0.iter_mut().find(|x| x.kind == SprayKind::Dust && x.surface == Surface::Dirt).unwrap().gain = 1.0;
        assert!(kind_intensity(&r, SprayKind::Dust, Some(Surface::Dirt), 20.0, 0.0, true) > before * 2.0);
    }

    #[test]
    fn every_effect_compiles() {
        let mut lib = VfxLibrary::default();
        register_effects(&mut lib, &SprayPalette::default());
        for kind in SprayKind::ALL {
            assert!(lib.get(kind.effect()).is_some(), "{kind:?}");
        }
    }

    #[test]
    fn a_moving_tracked_point_sprays_on_loose_ground_and_stays_quiet_on_hard_ground() {
        use bevy::time::TimeUpdateStrategy;
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, TransformPlugin));
        app.init_resource::<VfxLibrary>();
        app.add_plugins(SprayPlugin);
        app.insert_resource(TimeUpdateStrategy::ManualDuration(std::time::Duration::from_secs_f64(1.0 / 60.0)));
        app.insert_resource(SurfaceMapRes::from_fn(|p| Some(if p.x < 100.0 { SurfaceId::GRAVEL } else { SurfaceId::ASPHALT })));
        let e = app.world_mut().spawn((SprayPoint { rear: true, ..default() }, SprayInput::default(), SprayTracker::default(), Transform::default())).id();
        app.update();
        let scale = |app: &mut App| {
            let mut q = app.world_mut().query::<(&ParticleEffect, &ChildOf)>();
            q.iter(app.world()).map(|(f, p)| (f.effect.clone(), f.rate_scale, p.parent())).collect::<Vec<_>>()
        };
        // 20 m/s on gravel.
        for _ in 0..90 {
            app.world_mut().entity_mut(e).get_mut::<Transform>().unwrap().translation.z -= 20.0 / 60.0;
            app.update();
        }
        let on = scale(&mut app);
        let dust = on.iter().find(|(n, ..)| n == "spray_dust").expect("dust effect spawned");
        assert!(dust.1 > 0.5 && dust.2 == e, "{on:?}");
        // Now on hard ground: the dust is switched off (the effect stays).
        for _ in 0..90 {
            {
                let mut t = app.world_mut().entity_mut(e);
                let mut tf = t.get_mut::<Transform>().unwrap();
                tf.translation.x = 200.0;
                tf.translation.z -= 20.0 / 60.0;
            }
            app.update();
        }
        let off = scale(&mut app);
        assert!(off.iter().filter(|(n, ..)| n == "spray_dust").all(|(_, s, _)| *s < 0.01), "{off:?}");
    }
}
