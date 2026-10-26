//! Visual effects / particles (feature `vfx`): code-first emitters, deterministic CPU simulation,
//! one instanced-style draw per emitter. Docs: `docs/VFX.md`.
//!
//! ```ignore
//! use engine::prelude::*;
//! // One-shot, pooled (recycled when finished):
//! fn boom(mut vfx: Vfx) { vfx.play("explosion", Transform::from_xyz(0.0, 0.0, -5.0)); }
//! // Persistent, attached to something (follows its parent):
//! commands.spawn((ParticleEffect::new("fire"), Transform::from_xyz(2.0, 0.0, 0.0)));
//! // Your own effect, defined in Rust (or JSON over `vfx.define`):
//! app.world_mut().resource_mut::<VfxLibrary>().register(EffectDef::new("puff").once(0.05).with(EmitterDef {
//!     bursts: vec![Burst::at(0.0, 12)], velocity: Velocity::Radial { speed: (1.0, 2.0) }, ..default()
//! })).unwrap();
//! ```
//!
//! Layout:
//! - [`def`]: the data ([`EffectDef`], [`EmitterDef`], shapes, forces, render settings).
//! - [`sim`]: SoA buffers + `step` (pure, deterministic; headless tests step it directly).
//! - this module: ECS glue — [`VfxLibrary`], [`ParticleEffect`], [`Vfx`], pooling, budgets,
//!   LOD/culling, pause, [`VfxStats`].
//! - `render` + `gpu`: per-emitter instance lists drawn instanced (one draw per emitter),
//!   mesh particles through `StandardMaterial` (only with a renderer).
//! - `control` (devtools): `vfx.spawn`, `vfx.stats`, `vfx.clear`, `vfx.list`, `vfx.get`,
//!   `vfx.define`, `vfx.budget`.

pub mod curve;
pub mod def;
pub mod gpu;
pub mod presets;
pub mod render;
pub mod rng;
pub mod sim;
pub mod textures;

#[cfg(feature = "physics")]
mod collide;
#[cfg(feature = "devtools")]
mod control;

use std::sync::Arc;
use std::time::Instant;

use bevy::ecs::system::SystemParam;
use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use serde::Serialize;

pub use curve::{Curve, Gradient};
pub use def::{
    Attractor, Blend, Burst, Collision, EffectDef, EffectLight, EmitterDef, Flipbook, Lod, MeshShape, Orbit, RenderDef, RenderMode, Shape, SubEmitter, Trigger, Turbulence, Velocity,
    VfxTexture,
};
pub use sim::{Budget, CompiledEffect, FrameCtx, InstanceState};

use crate::gfx::MainCamera;

/// Ordering inside `PostUpdate`: `Prepare → Simulate → Collide` run before transform
/// propagation; `Render` after frusta are updated and before visibility is checked.
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VfxSet {
    Prepare,
    Simulate,
    Collide,
    Render,
}

/// Global limits. Change at runtime (`vfx.budget`) or insert before `app.run()`.
#[derive(Resource, Clone, Debug, Serialize)]
pub struct VfxBudget {
    /// Particles alive across every effect; spawns beyond it are dropped (`VfxStats::dropped`).
    pub max_particles: u32,
    /// Playing effects; [`Vfx::play`] refuses more.
    pub max_effects: u32,
    /// Idle instances kept per effect name for reuse.
    pub pool_per_effect: u32,
    /// Raycasts per frame for `Collision::Physics` emitters (round robin; feature `physics`).
    pub collision_rays: u32,
    /// Longest simulated step (s): a hitch never explodes the simulation.
    pub max_dt: f32,
    /// Simulate effects in parallel on the compute pool.
    pub parallel: bool,
    /// Freeze with the game (`Paused` / `Time<Virtual>`); false = real time.
    pub pause_with_game: bool,
    /// Multiplier on every LOD/cull distance.
    pub distance_scale: f32,
    /// Keep `distance_scale` at `QualityPreset::detail_scale` for the current graphics quality
    /// (Low 0.6 … Ultra 1.5).
    pub follow_quality: bool,
    /// Effect point lights on at once (nearest to the camera win).
    pub max_lights: u32,
}

impl Default for VfxBudget {
    fn default() -> Self {
        VfxBudget {
            max_particles: 200_000,
            max_effects: 1024,
            pool_per_effect: 16,
            collision_rays: 2048,
            max_dt: 0.1,
            parallel: true,
            pause_with_game: true,
            distance_scale: 1.0,
            follow_quality: true,
            max_lights: 8,
        }
    }
}

/// Counters for the last frame (also `vfx.stats` and, in dev builds, `vfx.*` metrics).
#[derive(Resource, Clone, Debug, Default, Serialize)]
pub struct VfxStats {
    /// Effect entities (playing + idle).
    pub effects: u32,
    pub active: u32,
    /// Finished instances waiting in the pool.
    pub pooled: u32,
    /// Active effects beyond their cull distance.
    pub culled: u32,
    pub emitters: u32,
    pub particles: u32,
    pub peak_particles: u32,
    pub spawned: u32,
    /// Spawns refused by budgets this frame.
    pub dropped: u32,
    /// [`Vfx::play`] calls refused (unknown effect, `max_effects`).
    pub refused: u32,
    pub drawn_emitters: u32,
    pub drawn_particles: u32,
    /// GPU instances written (particles + ribbon segments) + mesh-particle vertices.
    pub instances: u32,
    pub collision_rays: u32,
    /// Simulation wall time (µs) of the last frame.
    pub sim_us: f32,
    /// Instance/mesh building wall time (µs, main world).
    pub build_us: f32,
    /// Render world: extract copy + GPU upload of the instance buffer (µs, previous frame).
    pub upload_us: f32,
}

/// Registered effects by name, compiled once. The presets are registered at startup.
#[derive(Resource, Default)]
pub struct VfxLibrary {
    effects: HashMap<String, Arc<CompiledEffect>>,
}

impl VfxLibrary {
    pub fn with_presets() -> Self {
        let mut lib = VfxLibrary::default();
        for (_, f) in presets::PRESETS {
            lib.register(f()).expect("presets compile");
        }
        lib
    }

    /// Adds or replaces an effect (running instances switch to it on their next restart).
    pub fn register(&mut self, def: EffectDef) -> Result<Arc<CompiledEffect>, String> {
        if def.name.is_empty() {
            return Err("effect needs a name".into());
        }
        let name = def.name.clone();
        let fx = CompiledEffect::shared(def)?;
        self.effects.insert(name, fx.clone());
        Ok(fx)
    }

    /// Registers every effect of a JSON file (one `EffectDef` or an array of them).
    pub fn load_json(&mut self, path: &std::path::Path) -> Result<usize, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let defs: Vec<EffectDef> = if v.is_array() { serde_json::from_value(v) } else { serde_json::from_value(v).map(|d| vec![d]) }.map_err(|e| e.to_string())?;
        let n = defs.len();
        for d in defs {
            self.register(d)?;
        }
        Ok(n)
    }

    pub fn get(&self, name: &str) -> Option<&Arc<CompiledEffect>> {
        self.effects.get(name)
    }

    pub fn contains(&self, name: &str) -> bool {
        self.effects.contains_key(name)
    }

    pub fn names(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.effects.keys().map(|s| s.as_str()).collect();
        v.sort_unstable();
        v
    }
}

/// What an effect entity does when it has finished (emission over, every particle dead).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub enum OnFinish {
    #[default]
    Despawn,
    /// Go idle into [`VfxPool`] for [`Vfx::play`] to reuse (no allocation, no spawn).
    Pool,
    /// Stay idle (restart it by inserting [`VfxRestart`]).
    Keep,
}

/// Plays the library effect `effect` at this entity's transform (parents are followed).
/// Effects with `duration > 0` that aren't looping finish by themselves; others play until
/// `emitting = false` and their last particle dies (then [`OnFinish`]).
#[derive(Component, Clone, Debug)]
#[require(Transform)]
pub struct ParticleEffect {
    pub effect: String,
    /// RNG seed (deterministic replays); `None` = next from [`VfxSeeds`].
    pub seed: Option<u64>,
    /// False: no new particles from rate/bursts (existing ones live out their life).
    pub emitting: bool,
    /// Multiplier on rate and burst counts.
    pub rate_scale: f32,
    pub on_finish: OnFinish,
}

impl ParticleEffect {
    pub fn new(effect: impl Into<String>) -> Self {
        ParticleEffect { effect: effect.into(), seed: None, emitting: true, rate_scale: 1.0, on_finish: OnFinish::Despawn }
    }
    pub fn seeded(mut self, seed: u64) -> Self {
        self.seed = Some(seed);
        self
    }
    pub fn on_finish(mut self, f: OnFinish) -> Self {
        self.on_finish = f;
        self
    }
}

/// Insert to restart an effect from time 0 (consumed the same frame).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct VfxRestart;

/// Runtime state of a [`ParticleEffect`] (added automatically).
#[derive(Component, Debug)]
pub struct VfxInstance {
    pub fx: Arc<CompiledEffect>,
    pub state: InstanceState,
    /// Finished and waiting (pool / keep): not simulated, not drawn.
    pub idle: bool,
    /// Beyond `cull_distance` from the camera.
    pub culled: bool,
    pub distance: f32,
    /// LOD spawn multiplier last frame.
    pub lod: f32,
    last_pos: Option<Vec3>,
    /// One render entity per emitter (`Entity::PLACEHOLDER` until first drawn).
    pub(crate) renders: Vec<Entity>,
    /// Per-emitter GPU instance lists (built in parallel, copied out at extraction).
    pub(crate) draws: Vec<render::EmitterDraw>,
    pub(crate) scratch: render::Scratch,
    /// The effect's point light entity (`EffectDef::light`), `PLACEHOLDER` until needed.
    pub(crate) light: Entity,
}

impl VfxInstance {
    fn new(fx: Arc<CompiledEffect>, seed: u64) -> Self {
        let state = InstanceState::new(&fx, seed);
        VfxInstance { fx, state, idle: false, culled: false, distance: 0.0, lod: 1.0, last_pos: None, renders: Vec::new(), draws: Vec::new(), scratch: Default::default(), light: Entity::PLACEHOLDER }
    }
}

/// Seeds for effects without an explicit one: a counter starting at the run's `GameSeed`, so a
/// `--seed` run replays the same particles.
#[derive(Resource, Clone, Copy, Debug)]
pub struct VfxSeeds(pub u64);

impl VfxSeeds {
    pub fn next_seed(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        self.0
    }
}

/// Idle instances by effect name.
#[derive(Resource, Default, Debug)]
pub struct VfxPool {
    pub free: HashMap<String, Vec<Entity>>,
}

/// Plays effects. `play` reuses a pooled instance when one is free (no spawn, no allocation).
#[derive(SystemParam)]
pub struct Vfx<'w, 's> {
    commands: Commands<'w, 's>,
    pool: ResMut<'w, VfxPool>,
    library: Res<'w, VfxLibrary>,
    seeds: ResMut<'w, VfxSeeds>,
    budget: Res<'w, VfxBudget>,
    stats: ResMut<'w, VfxStats>,
}

impl Vfx<'_, '_> {
    /// One-shot at `at`; recycled into the pool when finished. `None` if the effect is unknown
    /// or `VfxBudget::max_effects` are playing.
    pub fn play(&mut self, effect: &str, at: Transform) -> Option<Entity> {
        let seed = self.seeds.next_seed();
        self.play_seeded(effect, at, seed)
    }

    pub fn play_seeded(&mut self, effect: &str, at: Transform, seed: u64) -> Option<Entity> {
        if !self.library.contains(effect) {
            warn!("vfx: unknown effect `{effect}`");
            self.stats.refused += 1;
            return None;
        }
        if self.stats.active >= self.budget.max_effects {
            self.stats.refused += 1;
            return None;
        }
        // Counted now so several plays in one frame respect the cap.
        self.stats.active += 1;
        let pe = ParticleEffect { seed: Some(seed), on_finish: OnFinish::Pool, ..ParticleEffect::new(effect) };
        if let Some(e) = self.pool.free.get_mut(effect).and_then(|v| v.pop()) {
            self.commands.entity(e).try_insert((at, pe, VfxRestart));
            return Some(e);
        }
        Some(self.commands.spawn((Name::new(format!("vfx:{effect}")), at, pe)).id())
    }

    /// Persistent effect (despawns when finished, or never for endless ones).
    pub fn spawn(&mut self, effect: &str, at: Transform) -> Entity {
        self.commands.spawn((Name::new(format!("vfx:{effect}")), at, ParticleEffect::new(effect))).id()
    }

    pub fn library(&self) -> &VfxLibrary {
        &self.library
    }
}

pub struct VfxPlugin;

impl Plugin for VfxPlugin {
    fn build(&self, app: &mut App) {
        let seed = app.world().get_resource::<crate::cli::GameSeed>().map(|s| s.0).unwrap_or(0);
        app.insert_resource(VfxLibrary::with_presets())
            .insert_resource(VfxSeeds(seed))
            .init_resource::<VfxBudget>()
            .init_resource::<VfxStats>()
            .init_resource::<VfxPool>()
            .configure_sets(
                PostUpdate,
                (VfxSet::Prepare, VfxSet::Simulate, VfxSet::Collide).chain().before(bevy::transform::TransformSystems::Propagate),
            )
            .configure_sets(
                PostUpdate,
                VfxSet::Render
                    .after(bevy::camera::visibility::VisibilitySystems::UpdateFrusta)
                    .after(VfxSet::Collide)
                    .before(bevy::camera::visibility::VisibilitySystems::CheckVisibility),
            )
            .add_systems(PostUpdate, (follow_quality, resolve, follow_camera).chain().in_set(VfxSet::Prepare))
            .add_systems(PostUpdate, (simulate, finish).chain().in_set(VfxSet::Simulate))
            .add_observer(on_instance_removed);

        let headless = app.world().get_resource::<crate::flow::Headless>().is_some_and(|h| h.0);
        if !headless && app.is_plugin_added::<bevy::pbr::PbrPlugin>() {
            render::build(app);
        }
        #[cfg(feature = "physics")]
        collide::build(app);
        #[cfg(feature = "devtools")]
        control::build(app);
    }
}

fn follow_quality(settings: Option<Res<crate::settings::CoreSettings>>, preset: Option<Res<crate::gfx::QualityPreset>>, mut budget: ResMut<VfxBudget>) {
    let (Some(s), Some(p)) = (settings, preset) else { return };
    if budget.follow_quality && (s.is_changed() || p.is_changed() || budget.is_changed()) {
        let v = p.detail_scale[s.quality.index()];
        if budget.distance_scale != v {
            budget.distance_scale = v;
        }
    }
}

/// Creates / restarts instances for new or changed [`ParticleEffect`]s.
fn resolve(
    mut commands: Commands,
    library: Res<VfxLibrary>,
    mut seeds: ResMut<VfxSeeds>,
    mut q: Query<(Entity, &ParticleEffect, Option<&mut VfxInstance>, Has<VfxRestart>), Or<(Changed<ParticleEffect>, With<VfxRestart>)>>,
) {
    for (e, pe, inst, restart) in &mut q {
        if restart {
            commands.entity(e).remove::<VfxRestart>();
        }
        let Some(fx) = library.get(&pe.effect) else {
            warn!("vfx: unknown effect `{}` on {e}", pe.effect);
            continue;
        };
        let seed = pe.seed.unwrap_or_else(|| seeds.next_seed());
        match inst {
            Some(mut inst) if Arc::ptr_eq(&inst.fx, fx) => {
                if restart || inst.idle {
                    inst.state.restart(seed);
                    inst.idle = false;
                    inst.last_pos = None;
                }
            }
            Some(mut inst) => {
                let light = inst.light;
                for r in inst.renders.drain(..).chain([light]) {
                    if r != Entity::PLACEHOLDER {
                        commands.entity(r).try_despawn();
                    }
                }
                *inst = VfxInstance::new(fx.clone(), seed);
            }
            None => {
                commands.entity(e).insert(VfxInstance::new(fx.clone(), seed));
            }
        }
    }
}

/// World position of the camera effects are measured from (the `MainCamera`, else any camera).
fn camera_pos(main: &Query<&GlobalTransform, With<MainCamera>>, any: &Query<&GlobalTransform, With<Camera>>) -> Option<Vec3> {
    main.iter().next().or_else(|| any.iter().next()).map(|g| g.translation())
}

fn follow_camera(
    main: Query<&GlobalTransform, With<MainCamera>>,
    any: Query<&GlobalTransform, With<Camera>>,
    mut q: Query<(&VfxInstance, &mut Transform), Without<ChildOf>>,
) {
    let Some(cam) = camera_pos(&main, &any) else { return };
    for (inst, mut tf) in &mut q {
        if inst.fx.def.follow_camera && !inst.idle {
            tf.translation = cam;
        }
    }
}

fn simulate(
    time: Res<Time>,
    real: Res<Time<Real>>,
    budget: Res<VfxBudget>,
    mut stats: ResMut<VfxStats>,
    main: Query<&GlobalTransform, With<MainCamera>>,
    any: Query<&GlobalTransform, With<Camera>>,
    parents: Query<(&Transform, Option<&ChildOf>)>,
    mut q: Query<(&ParticleEffect, &Transform, Option<&ChildOf>, &mut VfxInstance)>,
) {
    let t0 = Instant::now();
    let env = StepEnv {
        dt: if budget.pause_with_game { time.delta_secs() } else { real.delta_secs() }.min(budget.max_dt),
        cam: camera_pos(&main, &any),
        headroom: Budget::new(budget.max_particles as i64 - stats.particles as i64),
        ds: budget.distance_scale.max(0.0),
    };
    if budget.parallel {
        q.par_iter_mut().for_each(|(pe, tf, parent, mut inst)| {
            step_instance(&env, pe, world_transform(tf, parent, &parents), &mut inst);
        });
    } else {
        for (pe, tf, parent, mut inst) in &mut q {
            step_instance(&env, pe, world_transform(tf, parent, &parents), &mut inst);
        }
    }

    let mut s = VfxStats { peak_particles: stats.peak_particles, refused: stats.refused, ..Default::default() };
    for (_, _, _, inst) in &q {
        s.effects += 1;
        if inst.idle {
            s.pooled += 1;
            continue;
        }
        s.active += 1;
        s.culled += inst.culled as u32;
        s.emitters += inst.state.emitters.len() as u32;
        for e in &inst.state.emitters {
            s.particles += e.p.len() as u32;
            s.spawned += e.spawned_frame;
            s.dropped += e.dropped;
        }
    }
    s.peak_particles = s.peak_particles.max(s.particles);
    s.sim_us = t0.elapsed().as_secs_f32() * 1e6;
    *stats = s;
}

/// This frame's world transform from the `Transform` chain (`GlobalTransform` is propagated
/// after us, so a parent spawned or moved this frame would be one frame stale).
fn world_transform(tf: &Transform, parent: Option<&ChildOf>, q: &Query<(&Transform, Option<&ChildOf>)>) -> GlobalTransform {
    let mut g = GlobalTransform::from(*tf);
    let mut cur = parent.map(|c| c.parent());
    for _ in 0..16 {
        let Some(p) = cur else { break };
        let Ok((ptf, pp)) = q.get(p) else { break };
        g = GlobalTransform::from(*ptf) * g;
        cur = pp.map(|c| c.parent());
    }
    g
}

struct StepEnv {
    dt: f32,
    cam: Option<Vec3>,
    headroom: Budget,
    ds: f32,
}

fn step_instance(env: &StepEnv, pe: &ParticleEffect, world: GlobalTransform, inst: &mut VfxInstance) {
    if inst.idle {
        return;
    }
    let dt = env.dt;
    let (scale, rot, pos) = world.to_scale_rotation_translation();
    let (vel, moved) = match inst.last_pos {
        Some(lp) if dt > 0.0 => ((pos - lp) / dt, pos.distance(lp)),
        _ => (Vec3::ZERO, 0.0),
    };
    let def = &inst.fx.def;
    let dist = env.cam.map(|c| c.distance(pos)).unwrap_or(0.0);
    let culled = !def.follow_camera && dist > def.cull_distance * env.ds;
    let lod = if def.follow_camera || env.ds == 0.0 { 1.0 } else { def.lod.scale(dist / env.ds) };
    let ctx = FrameCtx { dt, pos, rot, scale: scale.max_element(), vel, moved, spawn_scale: lod * pe.rate_scale.max(0.0), emitting: pe.emitting && !culled };
    if dt > 0.0 {
        inst.state.step(&inst.fx, &ctx, &env.headroom);
        inst.last_pos = Some(pos);
    }
    inst.distance = dist;
    inst.culled = culled;
    inst.lod = lod;
}

/// Finished instances: despawn, pool or keep.
fn finish(mut commands: Commands, budget: Res<VfxBudget>, mut pool: ResMut<VfxPool>, mut q: Query<(Entity, &ParticleEffect, &mut VfxInstance)>) {
    for (e, pe, mut inst) in &mut q {
        if inst.idle {
            continue;
        }
        let over = inst.state.emission_over(&inst.fx) || !pe.emitting;
        let done = over && inst.state.emitters.iter().all(|x| x.p.is_empty() && x.incoming.is_empty());
        if !done {
            continue;
        }
        match pe.on_finish {
            OnFinish::Despawn => {
                commands.entity(e).despawn();
            }
            OnFinish::Pool => {
                let list = pool.free.entry(pe.effect.clone()).or_default();
                if list.len() < budget.pool_per_effect as usize {
                    inst.idle = true;
                    list.push(e);
                } else {
                    commands.entity(e).despawn();
                }
            }
            OnFinish::Keep => inst.idle = true,
        }
    }
}

/// Render entities go with their effect.
fn on_instance_removed(ev: On<Remove, VfxInstance>, q: Query<&VfxInstance>, mut pool: ResMut<VfxPool>, mut commands: Commands) {
    let Ok(inst) = q.get(ev.entity) else { return };
    for &r in inst.renders.iter().chain([&inst.light]) {
        if r != Entity::PLACEHOLDER {
            commands.entity(r).try_despawn();
        }
    }
    if let Some(list) = pool.free.get_mut(&inst.fx.def.name) {
        list.retain(|&x| x != ev.entity);
    }
}

/// Despawns every effect and empties the pool (`vfx.clear`).
pub fn clear_all(world: &mut World) -> usize {
    let ids: Vec<Entity> = world.query_filtered::<Entity, With<ParticleEffect>>().iter(world).collect();
    for &e in &ids {
        world.despawn(e);
    }
    world.resource_mut::<VfxPool>().free.clear();
    ids.len()
}

/// Plays an effect from exclusive code (control commands, tests). Applied immediately.
pub fn play_world(world: &mut World, effect: &str, at: Transform, seed: Option<u64>) -> Option<Entity> {
    let r = world.run_system_cached_with(
        |In((name, at, seed)): In<(String, Transform, Option<u64>)>, mut vfx: Vfx| match seed {
            Some(s) => vfx.play_seeded(&name, at, s),
            None => vfx.play(&name, at),
        },
        (effect.to_string(), at, seed),
    );
    r.ok().flatten()
}
