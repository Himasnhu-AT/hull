//! Acoustic perception: noises with a loudness in dB (not a radius), spherical falloff, air
//! absorption, wind bias (downwind carries further), occlusion, and ambient masking. Listeners
//! ([`Hearing`]) get [`Heard`] messages (and a `Sense::Hearing` percept when they also have a
//! [`Perception`]). Scent drifts on the wind ([`ScentSource`] / [`Smell`] → [`Smelled`]).
//! [`Startle`] is a small alert → flee behaviour for animal-like agents.
//!
//! ```ignore
//! noises.write(NoiseEvent { pos, loudness_db: 95.0, kind: NoiseKind::Horn, source: Some(truck) });
//! commands.spawn((Hearing::default(), Startle::default(), NavAgent::default(), Transform::..));
//! commands.spawn((ScentSource { strength: 60.0, kind: 1 }, Transform::..));
//! for h in heard.read() { h.listener; h.level_db; h.direction }
//! ```
//! `loudness_db` is the level at 1 m. Typical: whisper 30, talking 60, footstep 45, shutter 55,
//! engine idle 65 to flat out 90, horn 105, gunshot 150. A listener's threshold defaults to 25 dB.

use avian3d::prelude::{SpatialQuery, SpatialQueryFilter};
use bevy::prelude::*;
use serde::Serialize;

use super::agent::{NavAgent, NavAgentState};
use super::perception::{Perception, Sense};

/// What made a noise (games add their own through `Other`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Reflect)]
pub enum NoiseKind {
    Engine,
    Horn,
    Footstep,
    Shutter,
    Voice,
    Impact,
    Other(u16),
}

/// A sound at `pos`. Anything can emit one (engines by rpm, horns, footsteps, shutter clicks).
#[derive(Message, Clone, Copy, Debug)]
pub struct NoiseEvent {
    pub pos: Vec3,
    /// Level at 1 m (dB).
    pub loudness_db: f32,
    pub kind: NoiseKind,
    /// Not heard by itself.
    pub source: Option<Entity>,
}

/// Can hear. The ear sits `ear_height` above the transform origin.
#[derive(Component, Clone, Copy, Debug, Reflect)]
pub struct Hearing {
    /// Quietest level heard (dB); lower = sharper ears. The ambient level masks below it.
    pub threshold_db: f32,
    /// Extra gain (dB) for this listener (a long-eared animal, a deaf one with a big negative).
    pub gain_db: f32,
    pub ear_height: f32,
}

impl Default for Hearing {
    fn default() -> Self {
        Hearing { threshold_db: 25.0, gain_db: 0.0, ear_height: 0.5 }
    }
}

/// A noise reached a listener.
#[derive(Message, Clone, Copy, Debug)]
pub struct Heard {
    pub listener: Entity,
    pub source: Option<Entity>,
    pub kind: NoiseKind,
    /// Where it really came from (add error with `uncertainty_m` if the listener shouldn't know).
    pub pos: Vec3,
    /// Level at the ear after falloff, wind and occlusion.
    pub level_db: f32,
    /// How far above the (masked) threshold.
    pub margin_db: f32,
    /// Unit vector from the listener toward the source.
    pub direction: Vec3,
    /// Suggested error radius for locating it (m): bigger when far and barely audible.
    pub uncertainty_m: f32,
}

/// Air and ground conditions for sound and scent. The weather module feeds `wind` and
/// `ambient_db`; games can set them directly.
#[derive(Resource)]
pub struct AcousticEnv {
    /// Air velocity (m/s).
    pub wind: Vec3,
    /// dB gained per m/s of wind blowing from source toward listener (lost when against it).
    pub wind_gain_db_per_mps: f32,
    /// dB lost per 100 m on top of spherical spreading.
    pub air_absorption_db_per_100m: f32,
    /// dB lost when a ray from source to listener hits geometry (one hit, avian colliders).
    pub occlusion_db: f32,
    /// Background level (dB): rain, wind, rivers. Listeners hear nothing below it.
    pub ambient_db: f32,
    /// Extra losses (dB) between two points: foliage, weather, a game's own zones.
    pub losses: Vec<Box<dyn Fn(Vec3, Vec3) -> f32 + Send + Sync>>,
    /// Seconds between scent checks.
    pub scent_interval: f32,
}

impl Default for AcousticEnv {
    fn default() -> Self {
        AcousticEnv {
            wind: Vec3::ZERO,
            wind_gain_db_per_mps: 0.7,
            air_absorption_db_per_100m: 1.0,
            occlusion_db: 14.0,
            ambient_db: 15.0,
            losses: Vec::new(),
            scent_interval: 0.5,
        }
    }
}

/// Level (dB) at the listener, before occlusion and extra losses.
pub fn received_db(loudness_db: f32, dist: f32, source_to_listener: Vec3, env: &AcousticEnv) -> f32 {
    let spread = 20.0 * dist.max(1.0).log10();
    let absorb = env.air_absorption_db_per_100m * dist / 100.0;
    let dir = Vec3::new(source_to_listener.x, 0.0, source_to_listener.z).normalize_or_zero();
    let bias = env.wind_gain_db_per_mps * env.wind.dot(dir);
    loudness_db - spread - absorb + bias
}

/// An upper bound on how far a noise can be heard (ignores absorption, uses the best wind case):
/// the cheap prefilter before per-listener work.
pub fn max_audible_distance(loudness_db: f32, threshold_db: f32, env: &AcousticEnv) -> f32 {
    let headroom = loudness_db - threshold_db + env.wind_gain_db_per_mps * env.wind.length();
    if headroom <= 0.0 { 1.0 } else { 10f32.powf(headroom / 20.0) }
}

/// Engine loudness from a 0..1 rpm fraction: idle level to full-throttle level.
pub fn engine_noise_db(rpm01: f32, idle_db: f32, full_db: f32) -> f32 {
    idle_db + (full_db - idle_db) * rpm01.clamp(0.0, 1.0)
}

/// Emits [`NoiseEvent`]s on its own entity's position every `interval` seconds while `enabled`
/// (engines, a crackling fire, music). Update `loudness_db` from game state (e.g. rpm).
#[derive(Component, Clone, Debug)]
pub struct NoiseEmitter {
    pub kind: NoiseKind,
    pub loudness_db: f32,
    pub interval: f32,
    pub enabled: bool,
    timer: f32,
}

impl NoiseEmitter {
    pub fn new(kind: NoiseKind, loudness_db: f32, interval: f32) -> Self {
        NoiseEmitter { kind, loudness_db, interval, enabled: true, timer: 0.0 }
    }
}

fn emit_continuous(time: Res<Time>, mut emitters: Query<(Entity, &mut NoiseEmitter, &GlobalTransform)>, mut out: MessageWriter<NoiseEvent>) {
    for (e, mut n, gt) in &mut emitters {
        if !n.enabled {
            continue;
        }
        n.timer -= time.delta_secs();
        if n.timer <= 0.0 {
            n.timer = n.interval.max(0.02);
            out.write(NoiseEvent { pos: gt.translation(), loudness_db: n.loudness_db, kind: n.kind, source: Some(e) });
        }
    }
}

pub(crate) fn propagate_noise(
    mut events: MessageReader<NoiseEvent>,
    env: Res<AcousticEnv>,
    time: Res<Time>,
    spatial: SpatialQuery,
    mut listeners: Query<(Entity, &Hearing, &GlobalTransform, Option<&mut Perception>)>,
    mut heard: MessageWriter<Heard>,
) {
    let now = time.elapsed_secs_f64();
    let filter = SpatialQueryFilter::default();
    for ev in events.read() {
        for (le, h, gt, mut perception) in &mut listeners {
            if ev.source == Some(le) {
                continue;
            }
            let ear = gt.translation() + Vec3::Y * h.ear_height;
            let to_src = ev.pos - ear;
            let dist = to_src.length();
            let threshold = (h.threshold_db - h.gain_db).max(env.ambient_db);
            if dist > max_audible_distance(ev.loudness_db, threshold, &env) {
                continue;
            }
            let dir_ls = (ear - ev.pos).normalize_or_zero();
            let mut level = received_db(ev.loudness_db, dist, dir_ls, &env);
            if level < threshold {
                continue;
            }
            // Occlusion only costs a ray for noises that could be heard without it.
            if env.occlusion_db > 0.0
                && dist > 0.5
                && let Ok(dir) = Dir3::new(dir_ls)
                && spatial.cast_ray_predicate(ev.pos, dir, dist, true, &filter, &|e| e != le && Some(e) != ev.source).is_some()
            {
                level -= env.occlusion_db;
            }
            for f in &env.losses {
                level -= f(ev.pos, ear);
            }
            if level < threshold {
                continue;
            }
            let margin = level - threshold;
            heard.write(Heard {
                listener: le,
                source: ev.source,
                kind: ev.kind,
                pos: ev.pos,
                level_db: level,
                margin_db: margin,
                direction: -dir_ls,
                uncertainty_m: dist * (0.3 - margin * 0.01).clamp(0.02, 0.3),
            });
            if let Some(p) = perception.as_mut() {
                let e = p.entry(ev.source, Sense::Hearing);
                e.last_pos = ev.pos;
                e.last_time = now;
                if !e.visible {
                    e.sense = Sense::Hearing;
                }
            }
        }
    }
}

// ---- scent ----

/// Gives off a smell that drifts downwind.
#[derive(Component, Clone, Copy, Debug, Reflect)]
pub struct ScentSource {
    /// How far downwind it carries in a steady breeze (m).
    pub strength: f32,
    /// Game-defined id (prey, predator, food...).
    pub kind: u16,
}

/// Can smell.
#[derive(Component, Clone, Copy, Debug, Reflect)]
pub struct Smell {
    /// Multiplies the reach of scents (1 = normal).
    pub sensitivity: f32,
}

impl Default for Smell {
    fn default() -> Self {
        Smell { sensitivity: 1.0 }
    }
}

/// A listener smelled a source (repeats every `AcousticEnv::scent_interval` while it persists).
#[derive(Message, Clone, Copy, Debug)]
pub struct Smelled {
    pub listener: Entity,
    pub source: Entity,
    pub kind: u16,
    /// 0..1: 1 = right on top of it.
    pub intensity: f32,
    pub pos: Vec3,
}

/// Scent strength 0..1 at `dist` for a listener whose bearing from the source is `along`
/// (cosine between the wind direction and source → listener: 1 = directly downwind).
/// Still air: a small round cloud (a fifth of `strength`). A steady wind (3+ m/s) stretches
/// the cloud downwind to the full `strength` and pushes it away from upwind listeners.
pub fn scent_intensity(strength: f32, sensitivity: f32, dist: f32, along: f32, wind_speed: f32) -> f32 {
    let w = (wind_speed / 3.0).clamp(0.0, 1.0);
    let lobe = if along >= 0.0 { 0.2 + 0.8 * along * w } else { 0.2 * (1.0 - w * -along) };
    let reach = strength * sensitivity * lobe;
    if reach <= 0.0 { 0.0 } else { (1.0 - dist / reach).clamp(0.0, 1.0) }
}

pub(crate) fn smell_scents(
    time: Res<Time>,
    env: Res<AcousticEnv>,
    mut acc: Local<f32>,
    sources: Query<(Entity, &ScentSource, &GlobalTransform)>,
    smellers: Query<(Entity, &Smell, &GlobalTransform)>,
    mut perceptions: Query<&mut Perception>,
    mut out: MessageWriter<Smelled>,
) {
    *acc += time.delta_secs();
    if *acc < env.scent_interval {
        return;
    }
    *acc = 0.0;
    let now = time.elapsed_secs_f64();
    let wind_dir = Vec3::new(env.wind.x, 0.0, env.wind.z).normalize_or_zero();
    let wind_speed = Vec2::new(env.wind.x, env.wind.z).length();
    for (le, sm, lg) in &smellers {
        for (se, ss, sg) in &sources {
            if se == le {
                continue;
            }
            let d = lg.translation() - sg.translation();
            let dist = d.length();
            if dist > ss.strength * sm.sensitivity {
                continue;
            }
            let along = if dist < 1e-3 { 1.0 } else { wind_dir.dot(d / dist) };
            let i = scent_intensity(ss.strength, sm.sensitivity, dist, along, wind_speed);
            if i <= 0.0 {
                continue;
            }
            out.write(Smelled { listener: le, source: se, kind: ss.kind, intensity: i, pos: sg.translation() });
            if let Ok(mut p) = perceptions.get_mut(le) {
                let e = p.entry(Some(se), Sense::Smell);
                e.last_pos = sg.translation();
                e.last_time = now;
                if !e.visible {
                    e.sense = Sense::Smell;
                }
            }
        }
    }
}

// ---- startle ----

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Reflect, Serialize)]
pub enum StartleState {
    #[default]
    Calm,
    /// Heard or smelled something: head up, watching the threat.
    Alert,
    Fleeing,
}

/// Alert → flee for animal-like agents. Put it on an entity with [`Hearing`] (and optionally
/// [`Smell`]). With a [`NavAgent`] it paths away (needs a navmesh); without one it runs straight
/// away at `flee_speed`. Read `state` from behaviour trees / utility AI, or listen for
/// [`StartleChanged`].
#[derive(Component, Clone, Debug, Reflect)]
pub struct Startle {
    pub state: StartleState,
    /// `Heard::margin_db` that makes it alert.
    pub alert_margin_db: f32,
    /// Margin that makes it bolt at once.
    pub flee_margin_db: f32,
    /// Seconds it stays alert; a second stimulus in that time makes it flee.
    pub alert_secs: f32,
    /// Seconds it keeps running after the last stimulus.
    pub flee_secs: f32,
    pub flee_distance: f32,
    pub flee_speed: f32,
    /// Smell intensity that makes it alert.
    pub smell_alert: f32,
    /// Last threat position (world), if any.
    pub threat: Option<Vec3>,
    pub timer: f32,
    /// Walking speed saved while fleeing with a `NavAgent` (internal).
    pub base_speed: Option<f32>,
}

impl Default for Startle {
    fn default() -> Self {
        Startle {
            state: StartleState::Calm,
            alert_margin_db: 4.0,
            flee_margin_db: 25.0,
            alert_secs: 4.0,
            flee_secs: 6.0,
            flee_distance: 40.0,
            flee_speed: 7.0,
            smell_alert: 0.3,
            threat: None,
            timer: 0.0,
            base_speed: None,
        }
    }
}

#[derive(Message, Clone, Copy, Debug)]
pub struct StartleChanged {
    pub entity: Entity,
    pub from: StartleState,
    pub to: StartleState,
    pub threat: Option<Vec3>,
}

/// Next state from a stimulus (pure; tested). `strength` is a margin in dB for sound; smell is
/// pre-mapped by the caller to a margin that is `alert_margin_db` (a smell never makes it bolt).
pub fn startle_transition(s: &Startle, margin_db: f32) -> StartleState {
    match s.state {
        _ if margin_db >= s.flee_margin_db => StartleState::Fleeing,
        StartleState::Calm if margin_db >= s.alert_margin_db => StartleState::Alert,
        StartleState::Alert if margin_db >= s.alert_margin_db => StartleState::Fleeing,
        other => other,
    }
}

pub(crate) fn startle_react(
    time: Res<Time>,
    mut heard: MessageReader<Heard>,
    mut smelled: MessageReader<Smelled>,
    mut q: Query<(Entity, &mut Startle, &GlobalTransform, Option<&mut NavAgent>, Option<&mut NavAgentState>)>,
    mut changed: MessageWriter<StartleChanged>,
) {
    let dt = time.delta_secs();
    // Strongest stimulus per listener this frame: (margin, threat pos).
    let mut stim: Vec<(Entity, f32, Vec3)> = Vec::new();
    let mut note = |e: Entity, m: f32, p: Vec3| match stim.iter_mut().find(|s| s.0 == e) {
        Some(s) if m > s.1 => (s.1, s.2) = (m, p),
        Some(_) => {}
        None => stim.push((e, m, p)),
    };
    for h in heard.read() {
        note(h.listener, h.margin_db, h.pos);
    }
    for s in smelled.read() {
        if let Ok((_, st, ..)) = q.get(s.listener)
            && s.intensity >= st.smell_alert
        {
            note(s.listener, st.alert_margin_db, s.pos);
        }
    }
    for (e, mut st, gt, agent, nav) in &mut q {
        let pos = gt.translation();
        let from = st.state;
        if let Some(&(_, margin, tp)) = stim.iter().find(|s| s.0 == e) {
            let to = startle_transition(&st, margin);
            st.threat = Some(tp);
            match to {
                StartleState::Alert if from != StartleState::Alert => st.timer = st.alert_secs,
                StartleState::Fleeing => st.timer = st.flee_secs,
                _ => {}
            }
            st.state = to;
        } else if st.state != StartleState::Calm {
            st.timer -= dt;
            if st.timer <= 0.0 {
                st.state = StartleState::Calm;
            }
        }
        let to = st.state;
        let flee_dir = st.threat.map(|t| Vec3::new(pos.x - t.x, 0.0, pos.z - t.z).normalize_or_zero()).filter(|d| *d != Vec3::ZERO).unwrap_or(Vec3::X);
        if to != from {
            changed.write(StartleChanged { entity: e, from, to, threat: st.threat });
        }
        // Movement is applied in `startle_move` (no NavAgent) or through the agent (here).
        if let (Some(mut agent), Some(mut nav)) = (agent, nav) {
            if to == StartleState::Fleeing {
                if from != StartleState::Fleeing {
                    st.base_speed = Some(agent.max_speed);
                    agent.max_speed = st.flee_speed;
                }
                // Re-target on entering and while the target is stale (> half the distance away).
                if from != StartleState::Fleeing || nav.target.is_none() {
                    nav.set_target(pos + flee_dir * st.flee_distance);
                }
            } else if from == StartleState::Fleeing {
                if let Some(b) = st.base_speed.take() {
                    agent.max_speed = b;
                }
                nav.stop();
            }
        }
    }
}

/// Straight-line flight for startled agents that have no [`NavAgent`].
pub(crate) fn startle_move(time: Res<Time>, mut q: Query<(&Startle, &mut Transform), Without<NavAgent>>) {
    for (s, mut t) in &mut q {
        let Some(threat) = s.threat else { continue };
        match s.state {
            StartleState::Fleeing => {
                let d = Vec3::new(t.translation.x - threat.x, 0.0, t.translation.z - threat.z).normalize_or_zero();
                if d != Vec3::ZERO {
                    t.translation += d * s.flee_speed * time.delta_secs();
                    t.look_to(d, Vec3::Y);
                }
            }
            StartleState::Alert => {
                let d = Vec3::new(threat.x - t.translation.x, 0.0, threat.z - t.translation.z).normalize_or_zero();
                if d != Vec3::ZERO {
                    t.look_to(d, Vec3::Y);
                }
            }
            StartleState::Calm => {}
        }
    }
}

pub(crate) fn plugin(app: &mut App) {
    use super::{AiSet, perception::update_perception};
    app.init_resource::<AcousticEnv>()
        .add_message::<NoiseEvent>()
        .add_message::<Heard>()
        .add_message::<Smelled>()
        .add_message::<StartleChanged>()
        .register_type::<NoiseKind>()
        .register_type::<Hearing>()
        .register_type::<ScentSource>()
        .register_type::<Smell>()
        .register_type::<Startle>()
        .add_systems(
            Update,
            (
                (emit_continuous.run_if(any_with_component::<NoiseEmitter>), propagate_noise.after(update_perception), smell_scents.run_if(any_with_component::<ScentSource>))
                    .chain()
                    .in_set(AiSet::Sense),
                (startle_react, startle_move).chain().in_set(AiSet::Think).run_if(any_with_component::<Startle>),
            ),
        );
}

#[cfg(feature = "devtools")]
pub(crate) fn register_control(app: &mut App) {
    use crate::devtools::{AddControlCommand, params};
    use serde_json::{Value, json};
    app.add_control_command(
        "ai.acoustic.noise",
        "Emit a NoiseEvent (dB model: falloff, wind, occlusion) and return who heard it",
        params(&[("pos", "array", "[x, y, z]"), ("loudness_db", "number", "level at 1 m (default 90)"), ("kind", "string", "engine|horn|footstep|shutter|voice|impact")]),
        |world: &mut World, p: Value| {
            let a = p.get("pos").and_then(Value::as_array).ok_or("`pos` must be [x, y, z]")?;
            let f = |i: usize| a.get(i).and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let kind = match p.get("kind").and_then(Value::as_str).unwrap_or("horn") {
                "engine" => NoiseKind::Engine,
                "footstep" => NoiseKind::Footstep,
                "shutter" => NoiseKind::Shutter,
                "voice" => NoiseKind::Voice,
                "impact" => NoiseKind::Impact,
                _ => NoiseKind::Horn,
            };
            let ev = NoiseEvent { pos: Vec3::new(f(0), f(1), f(2)), loudness_db: p.get("loudness_db").and_then(Value::as_f64).unwrap_or(90.0) as f32, kind, source: None };
            world.write_message(ev);
            Ok(json!({"queued": true, "max_audible_m": max_audible_distance(ev.loudness_db, 25.0, world.resource::<AcousticEnv>())}))
        },
    )
    .add_control_command("ai.acoustic.state", "AcousticEnv and every Startle / Hearing entity", params(&[]), |world: &mut World, _| {
        let env = world.resource::<AcousticEnv>();
        let env_j = json!({"wind": [env.wind.x, env.wind.y, env.wind.z], "ambient_db": env.ambient_db, "wind_gain_db_per_mps": env.wind_gain_db_per_mps,
                           "air_absorption_db_per_100m": env.air_absorption_db_per_100m, "occlusion_db": env.occlusion_db});
        let mut q = world.query::<(Entity, &Hearing, Option<&Startle>, &GlobalTransform)>();
        let ents: Vec<Value> = q
            .iter(world)
            .map(|(e, h, s, gt)| {
                let t = gt.translation();
                json!({"entity": e.to_bits(), "pos": [t.x, t.y, t.z], "threshold_db": h.threshold_db,
                       "startle": s.map(|s| json!({"state": s.state, "timer": s.timer, "threat": s.threat.map(|t| [t.x, t.y, t.z])}))})
            })
            .collect();
        Ok(json!({"env": env_j, "listeners": ents}))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> AcousticEnv {
        AcousticEnv::default()
    }

    #[test]
    fn falloff_is_6db_per_doubling() {
        let e = env();
        let a = received_db(100.0, 10.0, Vec3::X, &e);
        let b = received_db(100.0, 20.0, Vec3::X, &e);
        assert!((a - b - 6.02).abs() < 0.2, "{a} {b}");
        assert_eq!(received_db(100.0, 0.2, Vec3::X, &e), 100.0 - 0.0 - e.air_absorption_db_per_100m * 0.002, "inside 1 m: no gain");
    }

    #[test]
    fn wind_helps_downwind_and_hurts_upwind() {
        let e = AcousticEnv { wind: Vec3::new(8.0, 0.0, 0.0), ..env() };
        let calm = received_db(100.0, 50.0, Vec3::X, &env());
        let down = received_db(100.0, 50.0, Vec3::X, &e); // source → listener along the wind
        let up = received_db(100.0, 50.0, -Vec3::X, &e);
        let cross = received_db(100.0, 50.0, Vec3::Z, &e);
        assert!(down > calm + 4.0 && up < calm - 4.0, "{down} {calm} {up}");
        assert!((cross - calm).abs() < 1e-4);
        assert!(max_audible_distance(100.0, 25.0, &e) > max_audible_distance(100.0, 25.0, &env()));
    }

    #[test]
    fn scent_follows_the_wind() {
        // 3 m/s breeze: downwind carries to 60 m, upwind barely smells.
        let down = scent_intensity(60.0, 1.0, 30.0, 1.0, 3.0);
        let up = scent_intensity(60.0, 1.0, 5.0, -1.0, 3.0);
        let side = scent_intensity(60.0, 1.0, 5.0, 0.0, 3.0);
        assert!((down - 0.5).abs() < 1e-5);
        assert_eq!(up, 0.0, "reach is 0 straight upwind in a steady wind");
        assert!(side > 0.5 && side < 1.0);
        assert_eq!(scent_intensity(60.0, 1.0, 40.0, 0.0, 0.0), 0.0, "still air: small cloud of 12 m");
        assert!(scent_intensity(60.0, 1.0, 6.0, 0.3, 0.0) > 0.0);
        assert!(scent_intensity(60.0, 2.0, 70.0, 1.0, 3.0) > 0.0, "keen noses reach further");
    }

    #[test]
    fn startle_escalates() {
        let s = Startle::default();
        assert_eq!(startle_transition(&s, 1.0), StartleState::Calm);
        assert_eq!(startle_transition(&s, 10.0), StartleState::Alert);
        assert_eq!(startle_transition(&s, 30.0), StartleState::Fleeing);
        let alert = Startle { state: StartleState::Alert, ..s.clone() };
        assert_eq!(startle_transition(&alert, 10.0), StartleState::Fleeing, "a second stimulus while alert");
        assert_eq!(startle_transition(&alert, 1.0), StartleState::Alert);
    }

    #[test]
    fn engine_loudness_interpolates() {
        assert_eq!(engine_noise_db(0.0, 65.0, 90.0), 65.0);
        assert_eq!(engine_noise_db(0.5, 65.0, 90.0), 77.5);
        assert_eq!(engine_noise_db(3.0, 65.0, 90.0), 90.0);
    }

    // ---- systems, in the real engine app (headless, with physics) ----

    use bevy::time::TimeUpdateStrategy;
    use std::time::Duration;

    fn engine_app() -> App {
        let dir = std::env::temp_dir().join(format!("engine-acoustic-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut app = crate::app_with(crate::GameInfo::new("acoustic", "Acoustic"), crate::EngineOptions::headless_test(dir));
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_nanos(16_666_667)));
        app.finish();
        app.cleanup();
        // The weather would overwrite wind and ambient level every frame.
        #[cfg(feature = "weather")]
        {
            app.world_mut().resource_mut::<crate::weather::WeatherConfig>().drive_acoustics = false;
        }
        app.update();
        app
    }

    fn listener(app: &mut App, pos: Vec3, threshold_db: f32) -> Entity {
        app.world_mut().spawn((Hearing { threshold_db, ear_height: 0.0, ..default() }, Startle::default(), Transform::from_translation(pos), GlobalTransform::from_translation(pos))).id()
    }

    fn drain_heard(app: &mut App) -> Vec<Heard> {
        app.world_mut().resource_mut::<Messages<Heard>>().drain().collect()
    }

    #[test]
    fn thresholds_and_distance_decide_who_hears() {
        let mut app = engine_app();
        let near = listener(&mut app, Vec3::new(20.0, 0.0, 0.0), 25.0);
        let far = listener(&mut app, Vec3::new(2000.0, 0.0, 0.0), 25.0);
        let deaf = listener(&mut app, Vec3::new(20.0, 0.0, 5.0), 80.0);
        app.world_mut().write_message(NoiseEvent { pos: Vec3::ZERO, loudness_db: 90.0, kind: NoiseKind::Horn, source: None });
        app.update();
        let heard = drain_heard(&mut app);
        assert!(heard.iter().any(|h| h.listener == near && h.margin_db > 30.0), "{heard:?}");
        assert!(!heard.iter().any(|h| h.listener == far), "2 km away: 90 - 66 - 20 absorption < 25");
        assert!(!heard.iter().any(|h| h.listener == deaf), "threshold 80 dB");
        let h = heard.iter().find(|h| h.listener == near).unwrap();
        assert!(h.direction.x < -0.9, "the source is toward -X from the listener");
    }

    #[test]
    fn wind_extends_the_range_downwind_and_shortens_it_upwind() {
        let mut app = engine_app();
        let east = listener(&mut app, Vec3::new(300.0, 0.0, 0.0), 25.0);
        let west = listener(&mut app, Vec3::new(-300.0, 0.0, 0.0), 25.0);
        let ev = NoiseEvent { pos: Vec3::ZERO, loudness_db: 78.0, kind: NoiseKind::Engine, source: None };
        // Calm: 78 - 49.5 - 3 = 25.5: just heard both sides.
        app.world_mut().write_message(ev);
        app.update();
        let calm: Vec<_> = drain_heard(&mut app).iter().map(|h| h.listener).collect();
        assert!(calm.contains(&east) && calm.contains(&west), "{calm:?}");
        // Wind toward +X at 10 m/s: east gains 7 dB, west loses 7 dB.
        app.world_mut().resource_mut::<AcousticEnv>().wind = Vec3::new(10.0, 0.0, 0.0);
        app.world_mut().write_message(ev);
        app.update();
        let windy: Vec<_> = drain_heard(&mut app).iter().map(|h| h.listener).collect();
        assert!(windy.contains(&east) && !windy.contains(&west), "{windy:?}");
    }

    #[test]
    fn a_wall_between_costs_decibels() {
        use avian3d::prelude::*;
        let mut app = engine_app();
        // Right at the edge of audibility in the open: 78 - 40 - 0.4 = 37.6; a 14 dB wall leaves 23.6.
        let a = listener(&mut app, Vec3::new(100.0, 0.0, 0.0), 25.0);
        app.world_mut().write_message(NoiseEvent { pos: Vec3::ZERO, loudness_db: 78.0, kind: NoiseKind::Engine, source: None });
        app.update();
        assert!(drain_heard(&mut app).iter().any(|h| h.listener == a));
        app.world_mut().spawn((RigidBody::Static, Collider::cuboid(1.0, 20.0, 20.0), Transform::from_xyz(50.0, 0.0, 0.0)));
        for _ in 0..3 {
            app.update();
        }
        app.world_mut().write_message(NoiseEvent { pos: Vec3::ZERO, loudness_db: 78.0, kind: NoiseKind::Engine, source: None });
        app.update();
        assert!(!drain_heard(&mut app).iter().any(|h| h.listener == a), "the wall muffles it below the threshold");
    }

    #[test]
    fn a_loud_noise_alerts_then_a_second_one_makes_deer_flee_away() {
        let mut app = engine_app();
        let deer = listener(&mut app, Vec3::new(0.0, 0.0, -30.0), 22.0);
        // 105 dB horn at the origin: 105 - 29.5 = 75 dB at the deer: margin 53 -> bolts at once.
        app.world_mut().write_message(NoiseEvent { pos: Vec3::ZERO, loudness_db: 105.0, kind: NoiseKind::Horn, source: None });
        for _ in 0..5 {
            app.update();
        }
        let s = app.world().get::<Startle>(deer).unwrap();
        assert_eq!(s.state, StartleState::Fleeing);
        let z0 = app.world().get::<Transform>(deer).unwrap().translation.z;
        for _ in 0..60 {
            app.update();
        }
        let z1 = app.world().get::<Transform>(deer).unwrap().translation.z;
        assert!(z1 < z0 - 5.0, "ran away from the horn (toward -Z): {z0} -> {z1}");
        // Calms down after flee_secs without new stimuli.
        for _ in 0..(7 * 60) {
            app.update();
        }
        assert_eq!(app.world().get::<Startle>(deer).unwrap().state, StartleState::Calm);

        // A moderate noise: alert first, a repeat while alert: flee.
        let deer2 = listener(&mut app, Vec3::new(0.0, 0.0, 40.0), 22.0);
        let quiet = NoiseEvent { pos: Vec3::new(0.0, 0.0, 20.0), loudness_db: 55.0, kind: NoiseKind::Shutter, source: None };
        app.world_mut().write_message(quiet);
        app.update();
        app.update();
        assert_eq!(app.world().get::<Startle>(deer2).unwrap().state, StartleState::Alert);
        app.world_mut().write_message(quiet);
        app.update();
        app.update();
        assert_eq!(app.world().get::<Startle>(deer2).unwrap().state, StartleState::Fleeing);
    }

    #[test]
    fn scent_reaches_downwind_noses_only() {
        let mut app = engine_app();
        app.world_mut().resource_mut::<AcousticEnv>().wind = Vec3::new(4.0, 0.0, 0.0);
        let spawn = |app: &mut App, p: Vec3| app.world_mut().spawn((Smell::default(), Transform::from_translation(p), GlobalTransform::from_translation(p))).id();
        let down = spawn(&mut app, Vec3::new(30.0, 0.0, 0.0));
        let up = spawn(&mut app, Vec3::new(-30.0, 0.0, 0.0));
        app.world_mut().spawn((ScentSource { strength: 50.0, kind: 3 }, Transform::default(), GlobalTransform::default()));
        let mut got = Vec::new();
        for _ in 0..40 {
            app.update();
            got.extend(app.world_mut().resource_mut::<Messages<Smelled>>().drain().map(|m| m.listener));
        }
        assert!(got.contains(&down) && !got.contains(&up), "{got:?}");
    }
}
