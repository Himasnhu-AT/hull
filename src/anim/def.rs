//! Animation graph *definitions*: parameters, layers, states, motions (clip / blend space),
//! transitions and conditions, all plain Rust data built with chained constructors.
//!
//! A definition is immutable and shared (`Arc<AnimGraphDef>`) by every character that uses it;
//! per-character state lives in [`super::Animator`]. Names are resolved to indices once in
//! [`AnimGraphBuilder::build`], so nothing is looked up by string per frame.
//!
//! ```ignore
//! let def = AnimGraphDef::builder("humanoid")
//!     .float("speed", 0.0)
//!     .trigger("hit")
//!     .root_bone("Hips")
//!     .layer(
//!         AnimLayer::new("base")
//!             .state(AnimState::new("idle", Motion::clip(idle)).on(Transition::to("move").when(Cond::gt("speed", 0.1))))
//!             .state(AnimState::new("move", Motion::blend1d("speed", [(1.5, walk), (4.0, run)]))
//!                 .on(Transition::to("idle").when(Cond::lt("speed", 0.1)).fade(0.25)))
//!             .state(AnimState::new("hit", Motion::clip(hit)).once().on(Transition::to("idle").exit_time(0.9)))
//!             .any(Transition::to("hit").when(Cond::trigger("hit")).fade(0.08)),
//!     )
//!     .build()?;
//! ```

use std::borrow::Cow;
use std::sync::Arc;

use bevy::animation::AnimationClip;
use bevy::math::curve::EaseFunction;
use bevy::prelude::*;

/// Index of a parameter in [`AnimGraphDef::params`].
pub type ParamId = u16;
/// Index of a state within its layer.
pub type StateId = u16;

const UNRESOLVED: u16 = u16::MAX;

type Str = Cow<'static, str>;

/// A parameter's current value. Triggers are bools that a firing transition resets.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParamValue {
    Float(f32),
    Bool(bool),
    Trigger(bool),
}

impl ParamValue {
    /// Numeric view: floats as is, bools/triggers as 0/1.
    pub fn as_f32(self) -> f32 {
        match self {
            ParamValue::Float(v) => v,
            ParamValue::Bool(b) | ParamValue::Trigger(b) => b as u8 as f32,
        }
    }
    pub fn as_bool(self) -> bool {
        match self {
            ParamValue::Float(v) => v != 0.0,
            ParamValue::Bool(b) | ParamValue::Trigger(b) => b,
        }
    }
    pub fn kind(self) -> &'static str {
        match self {
            ParamValue::Float(_) => "float",
            ParamValue::Bool(_) => "bool",
            ParamValue::Trigger(_) => "trigger",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ParamDef {
    pub name: Str,
    pub default: ParamValue,
}

/// A condition on a parameter. Build with [`Cond::gt`], [`Cond::lt`], [`Cond::is`],
/// [`Cond::trigger`] or [`Cond::func`].
#[derive(Clone, Debug)]
pub struct Cond {
    pub param: Str,
    pub op: CondOp,
    pub(crate) id: ParamId,
}

#[derive(Clone, Copy, Debug)]
pub enum CondOp {
    /// `param > v`
    Gt(f32),
    /// `param < v`
    Lt(f32),
    /// `param == b` (bool params)
    Is(bool),
    /// trigger set (consumed when the transition fires)
    Trigger,
    /// Any test over all params (indexed like [`AnimGraphDef::params`]); `param` is ignored.
    Func(fn(&[ParamValue]) -> bool),
}

impl Cond {
    pub fn gt(param: impl Into<Str>, v: f32) -> Self {
        Cond { param: param.into(), op: CondOp::Gt(v), id: UNRESOLVED }
    }
    pub fn lt(param: impl Into<Str>, v: f32) -> Self {
        Cond { param: param.into(), op: CondOp::Lt(v), id: UNRESOLVED }
    }
    pub fn is(param: impl Into<Str>, b: bool) -> Self {
        Cond { param: param.into(), op: CondOp::Is(b), id: UNRESOLVED }
    }
    pub fn trigger(param: impl Into<Str>) -> Self {
        Cond { param: param.into(), op: CondOp::Trigger, id: UNRESOLVED }
    }
    pub fn func(f: fn(&[ParamValue]) -> bool) -> Self {
        Cond { param: Cow::Borrowed(""), op: CondOp::Func(f), id: 0 }
    }

    pub(crate) fn eval(&self, params: &[ParamValue]) -> bool {
        match self.op {
            CondOp::Func(f) => f(params),
            CondOp::Gt(v) => params[self.id as usize].as_f32() > v,
            CondOp::Lt(v) => params[self.id as usize].as_f32() < v,
            CondOp::Is(b) => params[self.id as usize].as_bool() == b,
            CondOp::Trigger => params[self.id as usize].as_bool(),
        }
    }
}

/// A transition to another state of the same layer.
#[derive(Clone, Debug)]
pub struct Transition {
    pub to: Str,
    /// All must hold.
    pub conds: Vec<Cond>,
    /// Normalized time of the source state (1.0 = one clip length) at which the transition may
    /// fire. Looping states with `exit_time < 1` check it once per loop. `None`: any time.
    pub exit_time: Option<f32>,
    /// Crossfade seconds (0 = cut).
    pub duration: f32,
    pub ease: EaseFunction,
    /// Normalized time the destination starts at.
    pub offset: f32,
    /// While this transition fades, the destination's own transitions may fire.
    pub interruptible: bool,
    /// Any-state only: may restart the state that is already current.
    pub can_self: bool,
    pub(crate) to_id: StateId,
}

impl Transition {
    pub fn to(state: impl Into<Str>) -> Self {
        Transition {
            to: state.into(),
            conds: Vec::new(),
            exit_time: None,
            duration: 0.2,
            ease: EaseFunction::SmoothStep,
            offset: 0.0,
            interruptible: false,
            can_self: false,
            to_id: UNRESOLVED,
        }
    }
    pub fn when(mut self, c: Cond) -> Self {
        self.conds.push(c);
        self
    }
    pub fn exit_time(mut self, t: f32) -> Self {
        self.exit_time = Some(t);
        self
    }
    pub fn fade(mut self, secs: f32) -> Self {
        self.duration = secs.max(0.0);
        self
    }
    pub fn ease(mut self, e: EaseFunction) -> Self {
        self.ease = e;
        self
    }
    pub fn offset(mut self, t: f32) -> Self {
        self.offset = t;
        self
    }
    pub fn interruptible(mut self) -> Self {
        self.interruptible = true;
        self
    }
    pub fn can_self(mut self) -> Self {
        self.can_self = true;
        self
    }
}

/// When a [`Notify`] fires.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NotifyTime {
    Secs(f32),
    /// Fraction of the clip (0..1).
    Norm(f32),
}

/// A named marker on a clip ("footstep_l", "hit"), delivered as [`super::AnimNotify`].
#[derive(Clone, Debug)]
pub struct Notify {
    pub at: NotifyTime,
    pub name: Arc<str>,
}

/// An animation clip handle plus its notifies.
#[derive(Clone, Debug)]
pub struct Clip {
    pub handle: Handle<AnimationClip>,
    pub notifies: Vec<Notify>,
}

impl Clip {
    pub fn new(handle: Handle<AnimationClip>) -> Self {
        Clip { handle, notifies: Vec::new() }
    }
    /// A notify `secs` into the clip.
    pub fn notify(mut self, secs: f32, name: &str) -> Self {
        self.notifies.push(Notify { at: NotifyTime::Secs(secs), name: name.into() });
        self
    }
    /// A notify at a fraction (0..1) of the clip.
    pub fn notify_norm(mut self, t: f32, name: &str) -> Self {
        self.notifies.push(Notify { at: NotifyTime::Norm(t), name: name.into() });
        self
    }
}

impl From<Handle<AnimationClip>> for Clip {
    fn from(h: Handle<AnimationClip>) -> Self {
        Clip::new(h)
    }
}

/// How a 2D blend space weighs its samples.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Blend2dMode {
    /// Gradient-band interpolation in plain x/y (good for any layout).
    #[default]
    Cartesian,
    /// Gradient bands in polar space: blends by direction first, then speed (locomotion with
    /// samples on rings around an idle at the origin).
    Directional,
}

/// What a state plays.
#[derive(Clone, Debug)]
pub enum Motion {
    Clip(Clip),
    /// Samples along one parameter (sorted at build).
    Blend1d { param: Str, points: Vec<(f32, Clip)>, id: ParamId },
    /// Samples in a 2D parameter space.
    Blend2d { x: Str, y: Str, mode: Blend2dMode, points: Vec<(Vec2, Clip)>, ids: [ParamId; 2] },
}

impl Motion {
    pub fn clip(c: impl Into<Clip>) -> Self {
        Motion::Clip(c.into())
    }
    pub fn blend1d<C: Into<Clip>>(param: impl Into<Str>, points: impl IntoIterator<Item = (f32, C)>) -> Self {
        Motion::Blend1d { param: param.into(), points: points.into_iter().map(|(v, c)| (v, c.into())).collect(), id: UNRESOLVED }
    }
    pub fn blend2d<C: Into<Clip>>(x: impl Into<Str>, y: impl Into<Str>, points: impl IntoIterator<Item = (Vec2, C)>) -> Self {
        Motion::Blend2d {
            x: x.into(),
            y: y.into(),
            mode: Blend2dMode::Cartesian,
            points: points.into_iter().map(|(v, c)| (v, c.into())).collect(),
            ids: [UNRESOLVED; 2],
        }
    }
    /// [`Self::blend2d`] with [`Blend2dMode::Directional`].
    pub fn blend2d_directional<C: Into<Clip>>(x: impl Into<Str>, y: impl Into<Str>, points: impl IntoIterator<Item = (Vec2, C)>) -> Self {
        match Self::blend2d(x, y, points) {
            Motion::Blend2d { x, y, points, ids, .. } => Motion::Blend2d { x, y, mode: Blend2dMode::Directional, points, ids },
            _ => unreachable!(),
        }
    }

    pub fn clips(&self) -> impl Iterator<Item = &Clip> {
        let (one, many1, many2) = match self {
            Motion::Clip(c) => (Some(c), None, None),
            Motion::Blend1d { points, .. } => (None, Some(points.iter().map(|(_, c)| c)), None),
            Motion::Blend2d { points, .. } => (None, None, Some(points.iter().map(|(_, c)| c))),
        };
        one.into_iter().chain(many1.into_iter().flatten()).chain(many2.into_iter().flatten())
    }

    pub fn clip_count(&self) -> usize {
        match self {
            Motion::Clip(_) => 1,
            Motion::Blend1d { points, .. } => points.len(),
            Motion::Blend2d { points, .. } => points.len(),
        }
    }
}

/// A state of a layer's state machine.
#[derive(Clone, Debug)]
pub struct AnimState {
    pub name: Str,
    pub motion: Motion,
    pub speed: f32,
    /// Multiplies `speed` by this float parameter.
    pub speed_param: Option<Str>,
    pub looping: bool,
    pub transitions: Vec<Transition>,
    pub(crate) speed_id: Option<ParamId>,
    /// First slot of this state in the layer's flat clip-slot list.
    pub(crate) slot0: u16,
}

impl AnimState {
    pub fn new(name: impl Into<Str>, motion: Motion) -> Self {
        AnimState {
            name: name.into(),
            motion,
            speed: 1.0,
            speed_param: None,
            looping: true,
            transitions: Vec::new(),
            speed_id: None,
            slot0: 0,
        }
    }
    /// Plays once and holds the last frame (normalized time stops at 1).
    pub fn once(mut self) -> Self {
        self.looping = false;
        self
    }
    pub fn speed(mut self, s: f32) -> Self {
        self.speed = s;
        self
    }
    pub fn speed_param(mut self, p: impl Into<Str>) -> Self {
        self.speed_param = Some(p.into());
        self
    }
    pub fn on(mut self, t: Transition) -> Self {
        self.transitions.push(t);
        self
    }
}

/// Bones a layer affects: whole subtrees and single bones, minus excluded subtrees.
#[derive(Clone, Debug, Default)]
pub struct BoneMask {
    pub subtrees: Vec<Str>,
    pub bones: Vec<Str>,
    pub without: Vec<Str>,
}

impl BoneMask {
    /// `root` and everything below it.
    pub fn subtree(root: impl Into<Str>) -> Self {
        BoneMask { subtrees: vec![root.into()], ..default() }
    }
    pub fn and_subtree(mut self, root: impl Into<Str>) -> Self {
        self.subtrees.push(root.into());
        self
    }
    pub fn and_bone(mut self, b: impl Into<Str>) -> Self {
        self.bones.push(b.into());
        self
    }
    /// Removes `root` and everything below it.
    pub fn without(mut self, root: impl Into<Str>) -> Self {
        self.without.push(root.into());
        self
    }
}

/// How a layer combines with the layers below it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum LayerMode {
    /// Replaces the pose below by `weight` (per masked bone).
    #[default]
    Override,
    /// Adds its clips (which must hold deltas from a reference pose) times `weight`.
    Additive,
}

/// One state machine; layer 0 is the base pose, later layers override or add on top.
#[derive(Clone, Debug)]
pub struct AnimLayer {
    pub name: Str,
    pub mode: LayerMode,
    pub weight: f32,
    pub weight_param: Option<Str>,
    pub mask: Option<BoneMask>,
    pub states: Vec<AnimState>,
    /// Transitions checked from every state (before the state's own).
    pub any: Vec<Transition>,
    pub entry: Option<Str>,
    pub(crate) weight_id: Option<ParamId>,
    pub(crate) entry_id: StateId,
    pub(crate) slots: u16,
}

impl AnimLayer {
    pub fn new(name: impl Into<Str>) -> Self {
        AnimLayer {
            name: name.into(),
            mode: LayerMode::Override,
            weight: 1.0,
            weight_param: None,
            mask: None,
            states: Vec::new(),
            any: Vec::new(),
            entry: None,
            weight_id: None,
            entry_id: 0,
            slots: 0,
        }
    }
    pub fn additive(mut self) -> Self {
        self.mode = LayerMode::Additive;
        self
    }
    pub fn weight(mut self, w: f32) -> Self {
        self.weight = w;
        self
    }
    /// AnimLayer weight read from a float parameter every frame (clamped to 0..1).
    pub fn weight_param(mut self, p: impl Into<Str>) -> Self {
        self.weight_param = Some(p.into());
        self
    }
    pub fn mask(mut self, m: BoneMask) -> Self {
        self.mask = Some(m);
        self
    }
    pub fn state(mut self, s: AnimState) -> Self {
        self.states.push(s);
        self
    }
    pub fn any(mut self, t: Transition) -> Self {
        self.any.push(t);
        self
    }
    /// Starting state (default: the first one added).
    pub fn entry(mut self, s: impl Into<Str>) -> Self {
        self.entry = Some(s.into());
        self
    }

    pub fn state_id(&self, name: &str) -> Option<StateId> {
        self.states.iter().position(|s| s.name == name).map(|i| i as StateId)
    }
    pub fn slot_count(&self) -> usize {
        self.slots as usize
    }
}

/// A complete, validated animation graph. Share it with `Arc` between characters.
#[derive(Clone, Debug)]
pub struct AnimGraphDef {
    pub name: Str,
    pub params: Vec<ParamDef>,
    pub layers: Vec<AnimLayer>,
    /// Bone whose motion becomes root motion (see [`super::RootMotion`]).
    pub root_bone: Option<Str>,
}

impl AnimGraphDef {
    pub fn builder(name: impl Into<Str>) -> AnimGraphBuilder {
        AnimGraphBuilder { def: AnimGraphDef { name: name.into(), params: Vec::new(), layers: Vec::new(), root_bone: None } }
    }
    pub fn param_id(&self, name: &str) -> Option<ParamId> {
        self.params.iter().position(|p| p.name == name).map(|i| i as ParamId)
    }
    pub fn layer_id(&self, name: &str) -> Option<usize> {
        self.layers.iter().position(|l| l.name == name)
    }
    /// Every distinct clip handle, in slot order.
    pub fn clip_handles(&self) -> impl Iterator<Item = &Handle<AnimationClip>> {
        self.layers.iter().flat_map(|l| l.states.iter().flat_map(|s| s.motion.clips().map(|c| &c.handle)))
    }
}

/// Builds an [`AnimGraphDef`]; [`Self::build`] resolves and checks every name.
pub struct AnimGraphBuilder {
    def: AnimGraphDef,
}

impl AnimGraphBuilder {
    pub fn float(self, name: impl Into<Str>, default: f32) -> Self {
        self.param(name, ParamValue::Float(default))
    }
    pub fn bool(self, name: impl Into<Str>, default: bool) -> Self {
        self.param(name, ParamValue::Bool(default))
    }
    pub fn trigger(self, name: impl Into<Str>) -> Self {
        self.param(name, ParamValue::Trigger(false))
    }
    pub fn param(mut self, name: impl Into<Str>, default: ParamValue) -> Self {
        self.def.params.push(ParamDef { name: name.into(), default });
        self
    }
    pub fn layer(mut self, l: AnimLayer) -> Self {
        self.def.layers.push(l);
        self
    }
    pub fn root_bone(mut self, bone: impl Into<Str>) -> Self {
        self.def.root_bone = Some(bone.into());
        self
    }

    pub fn build(self) -> Result<Arc<AnimGraphDef>, String> {
        let mut def = self.def;
        let gname = def.name.clone();
        let wrap = |m: String| format!("anim graph `{gname}`: {m}");
        if def.layers.is_empty() {
            return Err(wrap("no layers".into()));
        }
        if def.layers.len() > 63 {
            return Err(wrap("at most 63 layers".into()));
        }
        for (i, p) in def.params.iter().enumerate() {
            if def.params[..i].iter().any(|q| q.name == p.name) {
                return Err(wrap(format!("parameter `{}` defined twice", p.name)));
            }
        }
        if def.layers[0].mode == LayerMode::Additive {
            return Err(wrap("layer 0 is the base pose and can't be additive".into()));
        }
        let params = def.params.clone();
        let pid = |n: &str| -> Result<ParamId, String> {
            params
                .iter()
                .position(|p| p.name == n)
                .map(|i| i as ParamId)
                .ok_or_else(|| format!("unknown parameter `{n}` (known: {})", params.iter().map(|p| &*p.name).collect::<Vec<_>>().join(", ")))
        };
        for layer in &mut def.layers {
            let lname = layer.name.clone();
            if layer.states.is_empty() {
                return Err(wrap(format!("layer `{lname}` has no states")));
            }
            let names: Vec<Str> = layer.states.iter().map(|s| s.name.clone()).collect();
            for (i, n) in names.iter().enumerate() {
                if names[..i].contains(n) {
                    return Err(wrap(format!("layer `{lname}`: state `{n}` defined twice")));
                }
            }
            let sid = |n: &str| -> Result<StateId, String> {
                names
                    .iter()
                    .position(|s| s == n)
                    .map(|i| i as StateId)
                    .ok_or_else(|| format!("layer `{lname}`: unknown state `{n}` (known: {})", names.join(", ")))
            };
            let resolve_t = |t: &mut Transition| -> Result<(), String> {
                t.to_id = sid(&t.to)?;
                for c in &mut t.conds {
                    if !matches!(c.op, CondOp::Func(_)) {
                        c.id = pid(&c.param)?;
                        if matches!(c.op, CondOp::Trigger) && !matches!(params[c.id as usize].default, ParamValue::Trigger(_)) {
                            return Err(format!("`{}` is used as a trigger but isn't one", c.param));
                        }
                    }
                }
                Ok(())
            };
            layer.entry_id = match &layer.entry {
                Some(e) => sid(e).map_err(&wrap)?,
                None => 0,
            };
            layer.weight_id = match &layer.weight_param {
                Some(p) => Some(pid(p).map_err(&wrap)?),
                None => None,
            };
            for t in &mut layer.any {
                resolve_t(t).map_err(&wrap)?;
            }
            let mut slot = 0u16;
            for st in &mut layer.states {
                st.slot0 = slot;
                let n = st.motion.clip_count();
                if n == 0 {
                    return Err(wrap(format!("state `{}` has an empty blend space", st.name)));
                }
                slot += n as u16;
                st.speed_id = match &st.speed_param {
                    Some(p) => Some(pid(p).map_err(&wrap)?),
                    None => None,
                };
                match &mut st.motion {
                    Motion::Clip(_) => {}
                    Motion::Blend1d { param, points, id } => {
                        *id = pid(param).map_err(&wrap)?;
                        points.sort_by(|a, b| a.0.total_cmp(&b.0));
                    }
                    Motion::Blend2d { x, y, ids, .. } => {
                        *ids = [pid(x).map_err(&wrap)?, pid(y).map_err(&wrap)?];
                    }
                }
                for t in &mut st.transitions {
                    resolve_t(t).map_err(&wrap)?;
                }
            }
            layer.slots = slot;
        }
        Ok(Arc::new(def))
    }
}
