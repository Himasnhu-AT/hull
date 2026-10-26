//! The per-character runtime: [`Animator`] holds parameter values and, per layer, the playing
//! states with their normalized times and crossfade weights. [`Animator::step`] is pure math
//! over the shared [`AnimGraphDef`] and the bound clip data ([`Binding`]), so it is unit-tested
//! without an `App`.
//!
//! Crossfades stack: a transition that starts while another is fading keeps the old states
//! fading out (at most [`MAX_FADING`] at once, the weakest is dropped) and the new state fades
//! in. Re-entering a state that is still fading out continues its time and weight, so
//! A → B → A never pops.

use std::sync::Arc;

use bevy::animation::graph::{AnimationGraph, AnimationNodeIndex};
use bevy::math::Vec2;
use bevy::prelude::*;

use super::blend;
use super::def::{AnimGraphDef, AnimLayer, CondOp, LayerMode, Motion, ParamId, ParamValue, StateId, Transition};
use super::root_motion::RootTrack;
use crate::render_budget::Actor;

/// Most states blended at once in one layer (current + fading out).
pub const MAX_FADING: usize = 4;

/// One clip of one state, resolved against loaded assets.
#[derive(Clone, Debug)]
pub struct SlotInfo {
    pub node: AnimationNodeIndex,
    pub duration: f32,
    /// (clip fraction 0..1, name), sorted by fraction.
    pub notifies: Vec<(f32, Arc<str>)>,
    /// Baked root-bone track (base layer, when the graph names a root bone).
    pub track: Option<Arc<RootTrack>>,
}

/// A definition bound to a skeleton: the Bevy `AnimationGraph` built for it and per-layer clip
/// slots. Shared by every character with the same definition and skeleton.
#[derive(Debug)]
pub struct Binding {
    pub graph: Handle<AnimationGraph>,
    pub layers: Vec<Vec<SlotInfo>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Entry {
    pub state: StateId,
    /// Normalized time in cycles (1.0 = one pass of the motion).
    pub time: f32,
    pub prev: f32,
    /// Share of the outgoing weight when this entry started fading out.
    pub w0: f32,
    pub weight: f32,
    /// Entered this frame or the last: notifies at the very start fire.
    pub fresh: bool,
}

#[derive(Clone, Copy, Debug)]
struct Fade {
    elapsed: f32,
    duration: f32,
    /// Weight the incoming state already had.
    c0: f32,
    ease: bevy::math::curve::EaseFunction,
    interruptible: bool,
}

/// One layer's runtime.
#[derive(Clone, Debug)]
pub struct LayerRt {
    /// Playing states; the last one is current.
    pub(crate) entries: Vec<Entry>,
    fade: Option<Fade>,
    /// Effective layer weight this frame (0..1).
    pub weight: f32,
    /// Per-slot weight (motion weight × state weight, sums to 1 over the layer) and local clip
    /// time in seconds, valid after a step.
    pub(crate) slot_w: Vec<f32>,
    pub(crate) slot_t: Vec<f32>,
    /// Per-slot motion weight (within its state's blend space).
    slot_mw: Vec<f32>,
    pub transitions: u32,
    pub last_transition: Option<(StateId, StateId)>,
}

/// A notify that fired during a step.
#[derive(Clone, Debug, PartialEq)]
pub struct FiredNotify {
    pub layer: u16,
    pub state: StateId,
    pub name: Arc<str>,
    /// Clip seconds the notify sits at.
    pub clip_time: f32,
    pub weight: f32,
}

/// Outputs of one [`Animator::step`].
#[derive(Clone, Debug, Default)]
pub struct StepOut {
    pub notifies: Vec<FiredNotify>,
    /// Root motion of this step in the root bone's parent space (yaw-relative when extracting
    /// yaw).
    pub root_delta: Vec3,
    pub root_yaw: f32,
    /// Blended offset of the root bone from its clip-start pose (taken out of the pose).
    pub pose_offset: Vec3,
    pub pose_yaw: f32,
    pub has_root: bool,
}

/// Notify delivery.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NotifyMode {
    /// Only the most weighted state of a layer, and in a blend space its most weighted clip,
    /// fires (no doubled footsteps while blending walk and run).
    Dominant,
    /// Every playing clip whose layer-relative weight is at least `min_weight` fires.
    All { min_weight: f32 },
}

/// Drives a character from an [`AnimGraphDef`]. Put it on the entity with the
/// `AnimationPlayer` (bones carry `AnimationTargetId` + `AnimatedBy` pointing at it; glTF
/// scenes and [`super::RigDef::spawn`] set that up). Requires `AnimationPlayer` and marks the
/// entity an [`Actor`] for the render budget.
#[derive(Component, Clone, Debug)]
#[require(AnimationPlayer, Actor)]
pub struct Animator {
    def: Arc<AnimGraphDef>,
    params: Vec<ParamValue>,
    layers: Vec<LayerRt>,
    /// Global playback speed multiplier.
    pub speed: f32,
    /// Freezes time (pose stays, no notifies, no root motion).
    pub paused: bool,
    pub(crate) binding: Option<Arc<Binding>>,
    pub(crate) out: StepOut,
    /// Pose every `lod_interval` frames (set by the LOD system).
    pub(crate) lod_interval: u8,
    pub(crate) lod_phase: u8,
    /// The pose was written this frame.
    pub(crate) posed: bool,
    pub(crate) root_bone: Option<Entity>,
    pub(crate) root_yaw: bool,
    pub(crate) root_vertical: bool,
    /// Steps taken (state machines run every frame, LOD only skips poses).
    pub(crate) frames: u64,
}

impl Animator {
    pub fn new(def: Arc<AnimGraphDef>) -> Self {
        let params = def.params.iter().map(|p| p.default).collect();
        let layers = def
            .layers
            .iter()
            .map(|l| {
                let n = l.slot_count();
                LayerRt {
                    entries: {
                        let mut v = Vec::with_capacity(MAX_FADING + 1);
                        v.push(Entry { state: l.entry_id, time: 0.0, prev: 0.0, w0: 1.0, weight: 1.0, fresh: true });
                        v
                    },
                    fade: None,
                    weight: l.weight,
                    slot_w: vec![0.0; n],
                    slot_t: vec![0.0; n],
                    slot_mw: vec![0.0; n],
                    transitions: 0,
                    last_transition: None,
                }
            })
            .collect();
        Animator {
            def,
            params,
            layers,
            speed: 1.0,
            paused: false,
            binding: None,
            out: StepOut { notifies: Vec::with_capacity(8), ..default() },
            lod_interval: 1,
            lod_phase: 0,
            posed: false,
            root_bone: None,
            root_yaw: false,
            root_vertical: false,
            frames: 0,
        }
    }

    pub fn def(&self) -> &Arc<AnimGraphDef> {
        &self.def
    }
    pub fn is_bound(&self) -> bool {
        self.binding.is_some()
    }
    pub fn binding(&self) -> Option<&Arc<Binding>> {
        self.binding.as_ref()
    }
    /// Pose update interval chosen by LOD (1 = every frame).
    pub fn lod_interval(&self) -> u8 {
        self.lod_interval
    }
    /// The pose was written this frame (false on LOD-skipped frames).
    pub fn posed_this_frame(&self) -> bool {
        self.posed
    }
    pub fn last_step(&self) -> &StepOut {
        &self.out
    }

    // ---- parameters ----

    pub fn param_id(&self, name: &str) -> Option<ParamId> {
        self.def.param_id(name)
    }
    pub fn param(&self, name: &str) -> Option<ParamValue> {
        self.param_id(name).map(|i| self.params[i as usize])
    }
    pub fn params(&self) -> impl Iterator<Item = (&str, ParamValue)> {
        self.def.params.iter().zip(&self.params).map(|(d, v)| (&*d.name, *v))
    }
    pub fn param_values(&self) -> &[ParamValue] {
        &self.params
    }
    /// Sets a parameter, coerced to its declared kind. False if unknown.
    pub fn set(&mut self, name: &str, v: ParamValue) -> bool {
        match self.param_id(name) {
            Some(i) => {
                self.set_id(i, v);
                true
            }
            None => false,
        }
    }
    pub fn set_id(&mut self, id: ParamId, v: ParamValue) {
        let slot = &mut self.params[id as usize];
        *slot = match *slot {
            ParamValue::Float(_) => ParamValue::Float(v.as_f32()),
            ParamValue::Bool(_) => ParamValue::Bool(v.as_bool()),
            ParamValue::Trigger(_) => ParamValue::Trigger(v.as_bool()),
        };
    }
    pub fn set_float(&mut self, name: &str, v: f32) -> bool {
        self.set(name, ParamValue::Float(v))
    }
    pub fn set_bool(&mut self, name: &str, v: bool) -> bool {
        self.set(name, ParamValue::Bool(v))
    }
    /// Sets a trigger; it stays set until a transition consumes it.
    pub fn trigger(&mut self, name: &str) -> bool {
        self.set(name, ParamValue::Trigger(true))
    }
    pub fn float(&self, name: &str) -> f32 {
        self.param(name).map(ParamValue::as_f32).unwrap_or(0.0)
    }

    // ---- inspection ----

    pub fn layer_count(&self) -> usize {
        self.layers.len()
    }
    pub fn layer(&self, i: usize) -> &LayerRt {
        &self.layers[i]
    }
    /// Current (target) state of layer `layer`.
    pub fn current_state(&self, layer: usize) -> &str {
        let e = self.layers[layer].entries.last().expect("layer has a state");
        &self.def.layers[layer].states[e.state as usize].name
    }
    pub fn current_state_id(&self, layer: usize) -> StateId {
        self.layers[layer].entries.last().map(|e| e.state).unwrap_or(0)
    }
    /// Normalized time of the current state (cycles).
    pub fn state_time(&self, layer: usize) -> f32 {
        self.layers[layer].entries.last().map(|e| e.time).unwrap_or(0.0)
    }
    pub fn in_transition(&self, layer: usize) -> bool {
        self.layers[layer].fade.is_some()
    }
    /// `(state name, weight, normalized time)` of every playing state, current last.
    pub fn playing(&self, layer: usize) -> impl Iterator<Item = (&str, f32, f32)> {
        let l = &self.def.layers[layer];
        self.layers[layer].entries.iter().map(move |e| (&*l.states[e.state as usize].name, e.weight, e.time))
    }
    /// Layer-relative weight and clip time of every slot (valid after a step).
    pub fn slot_weights(&self, layer: usize) -> (&[f32], &[f32]) {
        (&self.layers[layer].slot_w, &self.layers[layer].slot_t)
    }

    // ---- control ----

    /// Crossfades layer `layer` to `state` now, ignoring conditions. False if unknown.
    pub fn play(&mut self, layer: usize, state: &str, fade: f32) -> bool {
        let Some(lr) = self.def.layers.get(layer) else { return false };
        let Some(to) = lr.state_id(state) else { return false };
        let mut t = Transition::to(lr.states[to as usize].name.clone()).fade(fade);
        t.to_id = to;
        let def = self.def.clone();
        let cur = self.current_state_id(layer);
        let rt = &mut self.layers[layer];
        compute_entry_weights(rt);
        start_transition(rt, &def.layers[layer], &t, cur == to);
        compute_entry_weights(rt);
        true
    }

    /// Advances every layer by `dt` seconds: times, transitions, weights, notifies, root motion.
    /// Needs a binding (clip durations); a no-op before.
    pub fn step(&mut self, dt: f32, notify_mode: NotifyMode) {
        let Some(binding) = self.binding.clone() else { return };
        self.step_with(&binding, dt, notify_mode);
    }

    pub(crate) fn step_with(&mut self, binding: &Binding, dt: f32, notify_mode: NotifyMode) {
        self.out.notifies.clear();
        self.out.root_delta = Vec3::ZERO;
        self.out.root_yaw = 0.0;
        self.out.pose_offset = Vec3::ZERO;
        self.out.pose_yaw = 0.0;
        self.out.has_root = false;
        let dt = if self.paused { 0.0 } else { dt * self.speed };
        let def = self.def.clone();
        for (li, ldef) in def.layers.iter().enumerate() {
            let slots = &binding.layers[li];
            let rt = &mut self.layers[li];
            rt.weight = match ldef.weight_id {
                Some(p) => self.params[p as usize].as_f32().clamp(0.0, 1.0),
                None => ldef.weight.clamp(0.0, 1.0),
            };

            // 1. Motion weights + time advance of every playing state.
            for e in rt.entries.iter_mut() {
                let st = &ldef.states[e.state as usize];
                let s0 = st.slot0 as usize;
                let n = st.motion.clip_count();
                motion_weights(&st.motion, &self.params, &mut rt.slot_mw[s0..s0 + n]);
                let mut eff = 0.0;
                for k in 0..n {
                    eff += rt.slot_mw[s0 + k] * slots[s0 + k].duration;
                }
                let eff = eff.max(1e-4);
                let speed = st.speed * st.speed_id.map(|p| self.params[p as usize].as_f32()).unwrap_or(1.0);
                e.prev = if e.fresh { e.time - 1e-5 } else { e.time };
                e.fresh = false;
                e.time += dt * speed / eff;
                if !st.looping {
                    e.time = e.time.clamp(0.0, 1.0);
                }
            }

            // 2. Fade progress.
            if let Some(f) = &mut rt.fade {
                f.elapsed += dt;
                if f.elapsed >= f.duration {
                    rt.fade = None;
                    let last = rt.entries.len() - 1;
                    rt.entries.drain(..last);
                }
            }

            // 3. At most one transition per layer per frame: any-state first, then the
            // current state's own (unless a non-interruptible fade is running).
            let cur = *rt.entries.last().expect("current state");
            let cst = &ldef.states[cur.state as usize];
            let may_leave = rt.fade.is_none_or(|f| f.interruptible);
            let fired = ldef
                .any
                .iter()
                .find(|t| (t.to_id != cur.state || t.can_self) && ready(t, &self.params, cur, cst.looping))
                .or_else(|| {
                    if may_leave { cst.transitions.iter().find(|t| ready(t, &self.params, cur, cst.looping)) } else { None }
                });
            if let Some(t) = fired {
                for c in &t.conds {
                    if matches!(c.op, CondOp::Trigger) {
                        self.params[c.id as usize] = ParamValue::Trigger(false);
                    }
                }
                compute_entry_weights(rt);
                start_transition(rt, ldef, t, t.to_id == cur.state);
                // A newly entered state needs its motion weights for this frame's outputs.
                let st = &ldef.states[t.to_id as usize];
                let s0 = st.slot0 as usize;
                motion_weights(&st.motion, &self.params, &mut rt.slot_mw[s0..s0 + st.motion.clip_count()]);
            }

            // 4. State weights.
            compute_entry_weights(rt);

            // 5. Slot outputs, notifies, root motion.
            rt.slot_w.fill(0.0);
            let dominant = rt
                .entries
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.weight.total_cmp(&b.1.weight))
                .map(|(i, _)| i)
                .unwrap_or(0);
            let base_root = li == 0 && ldef.mode == LayerMode::Override;
            for (ei, e) in rt.entries.iter().enumerate() {
                let st = &ldef.states[e.state as usize];
                let s0 = st.slot0 as usize;
                let n = st.motion.clip_count();
                let phase = if st.looping { e.time.rem_euclid(1.0) } else { e.time.clamp(0.0, 1.0) };
                let mut best = s0;
                #[allow(clippy::needless_range_loop)]
                for s in s0..s0 + n {
                    let w = e.weight * rt.slot_mw[s];
                    rt.slot_w[s] = w;
                    rt.slot_t[s] = phase * slots[s].duration;
                    if rt.slot_mw[s] > rt.slot_mw[best] {
                        best = s;
                    }
                    if base_root
                        && w > 0.0
                        && let Some(tr) = &slots[s].track
                    {
                            let (d, y) = tr.delta(e.prev, e.time, st.looping, self.root_yaw);
                            let (o, oy) = tr.offset(phase);
                            self.out.root_delta += d * w;
                            self.out.root_yaw += y * w;
                            self.out.pose_offset += o * w;
                            self.out.pose_yaw += oy * w;
                            self.out.has_root = true;
                    }
                }
                if e.time == e.prev {
                    continue;
                }
                let fire = |s: usize, w: f32, out: &mut Vec<FiredNotify>| {
                    for (p, name) in &slots[s].notifies {
                        if crossed(e.prev, e.time, *p, st.looping) {
                            out.push(FiredNotify {
                                layer: li as u16,
                                state: e.state,
                                name: name.clone(),
                                clip_time: p * slots[s].duration,
                                weight: w,
                            });
                        }
                    }
                };
                match notify_mode {
                    NotifyMode::Dominant => {
                        if ei == dominant && e.weight > 0.0 {
                            fire(best, e.weight * rt.slot_mw[best], &mut self.out.notifies);
                        }
                    }
                    NotifyMode::All { min_weight } => {
                        for s in s0..s0 + n {
                            let w = rt.slot_w[s];
                            if w > 0.0 && w >= min_weight {
                                fire(s, w, &mut self.out.notifies);
                            }
                        }
                    }
                }
            }
        }
        if !self.root_vertical {
            self.out.root_delta.y = 0.0;
            self.out.pose_offset.y = 0.0;
        }
        if !self.root_yaw {
            self.out.root_yaw = 0.0;
            self.out.pose_yaw = 0.0;
        }
        self.frames += 1;
    }
}

/// Did normalized time move across clip fraction `p` (0..1) going from `prev` to `now`?
fn crossed(prev: f32, now: f32, p: f32, looping: bool) -> bool {
    if looping {
        (now - p).floor() != (prev - p).floor()
    } else if now >= prev {
        prev < p && p <= now
    } else {
        now < p && p <= prev
    }
}

fn ready(t: &Transition, params: &[ParamValue], cur: Entry, looping: bool) -> bool {
    if let Some(e) = t.exit_time {
        let ok = if looping && e < 1.0 { crossed(cur.prev, cur.time, e, true) } else { cur.time >= e };
        if !ok {
            return false;
        }
    }
    t.conds.iter().all(|c| c.eval(params))
}

fn motion_weights(m: &Motion, params: &[ParamValue], out: &mut [f32]) {
    match m {
        Motion::Clip(_) => out[0] = 1.0,
        Motion::Blend1d { points, id, .. } => {
            let v = params[*id as usize].as_f32();
            // ≤ 16 samples on the stack; larger spaces fall back to a linear scan.
            let mut xs = [0.0f32; 16];
            if points.len() <= 16 {
                for (i, (x, _)) in points.iter().enumerate() {
                    xs[i] = *x;
                }
                blend::weights_1d(&xs[..points.len()], v, out);
            } else {
                let xs: Vec<f32> = points.iter().map(|p| p.0).collect();
                blend::weights_1d(&xs, v, out);
            }
        }
        Motion::Blend2d { points, ids, mode, .. } => {
            let p = Vec2::new(params[ids[0] as usize].as_f32(), params[ids[1] as usize].as_f32());
            let mut xs = [Vec2::ZERO; 16];
            if points.len() <= 16 {
                for (i, (x, _)) in points.iter().enumerate() {
                    xs[i] = *x;
                }
                blend::weights_2d(&xs[..points.len()], p, *mode, out);
            } else {
                let xs: Vec<Vec2> = points.iter().map(|p| p.0).collect();
                blend::weights_2d(&xs, p, *mode, out);
            }
        }
    }
}

fn compute_entry_weights(rt: &mut LayerRt) {
    let n = rt.entries.len();
    match rt.fade {
        Some(f) => {
            let x = if f.duration > 0.0 { (f.elapsed / f.duration).clamp(0.0, 1.0) } else { 1.0 };
            let c = f.c0 + (1.0 - f.c0) * bevy::math::curve::Curve::sample_clamped(&f.ease, x);
            for (i, e) in rt.entries.iter_mut().enumerate() {
                e.weight = if i + 1 == n { c } else { (1.0 - c) * e.w0 };
            }
        }
        None => {
            for (i, e) in rt.entries.iter_mut().enumerate() {
                e.weight = if i + 1 == n { 1.0 } else { 0.0 };
            }
        }
    }
}

fn start_transition(rt: &mut LayerRt, ldef: &AnimLayer, t: &Transition, to_self: bool) {
    let to = t.to_id;
    let looping = ldef.states[to as usize].looping;
    let start = if looping { t.offset } else { t.offset.clamp(0.0, 1.0) };
    let fresh = Entry { state: to, time: start, prev: start, w0: 0.0, weight: 0.0, fresh: true };
    rt.transitions += 1;
    rt.last_transition = Some((rt.entries.last().map(|e| e.state).unwrap_or(0), to));
    if to_self || t.duration <= 0.0 {
        rt.entries.clear();
        rt.entries.push(Entry { weight: 1.0, w0: 1.0, ..fresh });
        rt.fade = None;
        return;
    }
    let (incoming, c0) = match rt.entries.iter().position(|e| e.state == to) {
        Some(i) => {
            let e = rt.entries.remove(i);
            (e, e.weight)
        }
        None => (fresh, 0.0),
    };
    let sum: f32 = rt.entries.iter().map(|e| e.weight).sum();
    let n = rt.entries.len().max(1) as f32;
    for e in rt.entries.iter_mut() {
        e.w0 = if sum > 1e-6 { e.weight / sum } else { 1.0 / n };
    }
    rt.entries.retain(|e| e.w0 > 1e-4);
    while rt.entries.len() >= MAX_FADING {
        let (i, _) = rt.entries.iter().enumerate().min_by(|a, b| a.1.w0.total_cmp(&b.1.w0)).expect("nonempty");
        rt.entries.remove(i);
        let s: f32 = rt.entries.iter().map(|e| e.w0).sum();
        for e in rt.entries.iter_mut() {
            e.w0 /= s.max(1e-6);
        }
    }
    rt.entries.push(incoming);
    rt.fade = if rt.entries.len() == 1 || c0 >= 0.999 {
        rt.entries.drain(..rt.entries.len() - 1);
        None
    } else {
        Some(Fade { elapsed: 0.0, duration: t.duration, c0, ease: t.ease, interruptible: t.interruptible })
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anim::def::{AnimLayer, AnimState, Clip, Cond, Motion, Transition};

    fn clip() -> Clip {
        Clip::new(Handle::default())
    }

    /// Binding with fake durations: every clip of layer l lasts `durs[l][slot]`.
    fn bind(a: &mut Animator, durs: &[&[f32]]) {
        let layers = durs
            .iter()
            .map(|d| d.iter().map(|&duration| SlotInfo { node: AnimationNodeIndex::new(0), duration, notifies: vec![], track: None }).collect())
            .collect();
        a.binding = Some(Arc::new(Binding { graph: Handle::default(), layers }));
    }

    const DT: f32 = 1.0 / 60.0;

    fn run(a: &mut Animator, secs: f32) {
        for _ in 0..(secs / DT).round() as usize {
            a.step(DT, NotifyMode::Dominant);
        }
    }

    fn locomotion() -> Arc<AnimGraphDef> {
        AnimGraphDef::builder("t")
            .float("speed", 0.0)
            .trigger("hit")
            .bool("dead", false)
            .layer(
                AnimLayer::new("base")
                    .state(AnimState::new("idle", Motion::clip(clip())).on(Transition::to("move").when(Cond::gt("speed", 0.1)).fade(0.2)))
                    .state(
                        AnimState::new("move", Motion::blend1d("speed", [(1.5, clip()), (4.0, clip())]))
                            .on(Transition::to("idle").when(Cond::lt("speed", 0.1)).fade(0.25)),
                    )
                    .state(AnimState::new("hit", Motion::clip(clip())).once().on(Transition::to("idle").exit_time(0.9).fade(0.1)))
                    .state(AnimState::new("dead", Motion::clip(clip())).once())
                    .any(Transition::to("hit").when(Cond::trigger("hit")).fade(0.05))
                    .any(Transition::to("dead").when(Cond::is("dead", true)).fade(0.3)),
            )
            .build()
            .unwrap()
    }

    #[test]
    fn build_reports_unknown_names() {
        let e = AnimGraphDef::builder("x")
            .layer(AnimLayer::new("l").state(AnimState::new("a", Motion::clip(clip())).on(Transition::to("b"))))
            .build()
            .unwrap_err();
        assert!(e.contains("unknown state `b`"), "{e}");
        let e = AnimGraphDef::builder("x")
            .layer(AnimLayer::new("l").state(AnimState::new("a", Motion::clip(clip())).on(Transition::to("a").when(Cond::gt("nope", 1.0)))))
            .build()
            .unwrap_err();
        assert!(e.contains("unknown parameter `nope`"), "{e}");
    }

    #[test]
    fn transitions_crossfade_and_triggers() {
        let mut a = Animator::new(locomotion());
        bind(&mut a, &[&[2.0, 1.0, 0.7, 0.5, 1.0]]);
        run(&mut a, 0.5);
        assert_eq!(a.current_state(0), "idle");
        assert!((a.state_time(0) - 0.25).abs() < 1e-3, "idle 2 s long: {}", a.state_time(0));

        a.set_float("speed", 2.75);
        a.step(DT, NotifyMode::Dominant);
        assert_eq!(a.current_state(0), "move");
        assert!(a.in_transition(0));
        run(&mut a, 0.1);
        let w: Vec<f32> = a.playing(0).map(|p| p.1).collect();
        assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-4 && w[0] > 0.0 && w[1] > 0.0, "{w:?}");
        run(&mut a, 0.15);
        assert!(!a.in_transition(0));
        // Blend space: halfway between walk and run.
        let (sw, _) = a.slot_weights(0);
        assert!((sw[1] - 0.5).abs() < 1e-4 && (sw[2] - 0.5).abs() < 1e-4, "{sw:?}");

        // Trigger from any state, consumed on firing; exit time brings us back to idle.
        a.trigger("hit");
        a.step(DT, NotifyMode::Dominant);
        assert_eq!(a.current_state(0), "hit");
        assert_eq!(a.param("hit"), Some(ParamValue::Trigger(false)));
        a.set_float("speed", 0.0);
        run(&mut a, 0.40);
        assert_eq!(a.current_state(0), "hit", "exit at 0.9 of 0.5 s");
        run(&mut a, 0.1);
        assert_eq!(a.current_state(0), "idle");

        // Bool any-state doesn't refire into itself.
        a.set_bool("dead", true);
        run(&mut a, 1.0);
        assert_eq!(a.current_state(0), "dead");
        assert_eq!(a.layer(0).transitions, 4, "idle→move→hit→idle→dead");
    }

    #[test]
    fn reentering_a_fading_state_keeps_weight() {
        let mut a = Animator::new(locomotion());
        bind(&mut a, &[&[2.0, 1.0, 0.7, 0.5, 1.0]]);
        a.set_float("speed", 2.0);
        run(&mut a, 0.1); // halfway into idle → move (0.2 s)
        let before: f32 = a.playing(0).find(|p| p.0 == "idle").unwrap().1;
        assert!(before > 0.2 && before < 0.8, "{before}");
        a.set_float("speed", 0.0);
        a.layers[0].fade.as_mut().unwrap().interruptible = true;
        a.step(DT, NotifyMode::Dominant);
        assert_eq!(a.current_state(0), "idle");
        let after: f32 = a.playing(0).find(|p| p.0 == "idle").unwrap().1;
        // One frame of a 0.2 s smoothstep fade moves the weight ≤ 1.5 × dt / 0.2 ≈ 0.125.
        assert!((after - before).abs() < 0.13, "no pop: {before} → {after}");
        assert_eq!(a.playing(0).count(), 2);
    }

    #[test]
    fn notifies_fire_once_per_loop_at_their_time() {
        let def = AnimGraphDef::builder("n")
            .layer(AnimLayer::new("base").state(AnimState::new("walk", Motion::clip(clip().notify(0.25, "l").notify(0.75, "r")))))
            .build()
            .unwrap();
        let mut a = Animator::new(def);
        bind(&mut a, &[&[1.0]]);
        let b = a.binding.clone().unwrap();
        let mut layers = b.layers.clone();
        layers[0][0].notifies = vec![(0.25, "l".into()), (0.75, "r".into())];
        a.binding = Some(Arc::new(Binding { graph: Handle::default(), layers }));
        let mut fired = Vec::new();
        for f in 0..180 {
            a.step(DT, NotifyMode::Dominant);
            for n in &a.out.notifies {
                fired.push((f, n.name.to_string()));
            }
        }
        let names: Vec<&str> = fired.iter().map(|f| f.1.as_str()).collect();
        assert_eq!(names, ["l", "r", "l", "r", "l", "r"], "{fired:?}");
        // 0.25 s ≈ step 15 (0-based 14; float accumulation may land one step later).
        assert!((14..=15).contains(&fired[0].0), "{fired:?}");
        assert!((44..=45).contains(&fired[1].0), "{fired:?}");
    }
}
