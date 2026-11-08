//! Godot-style `Tween` for scripts. A tween is a list of steps run in order (a step marked
//! `tween_parallel` joins the previous one's group): property tweens, intervals and callbacks.
//! Tweens are bound to a node (killed when it is freed) and follow its process mode, so a
//! paused game freezes pausable tweens. Nothing allocates per frame except the (usually empty)
//! event list. The catalogue is in `docs/SCRIPTING.md`, section "Tween".

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{ent, f, live, me, rent, rv3, s, world};
use super::{ScriptSet, defer, diag, emit_signal_rv, frame_dt, is_busy, call_rv, runs_now, tree_paused};
use crate::logic::access;
use crate::logic::script::{rv_of, value_of_rv};
use logic_core::Value;

// ---------------------------------------------------------------- values and easing

/// A tweenable value: 1 (number), 3 (vector) or 4 (color) components.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Val {
    n: u8,
    v: [f32; 4],
}

impl Val {
    fn num(x: f32) -> Val {
        Val { n: 1, v: [x, 0.0, 0.0, 0.0] }
    }
    fn vec3(v: Vec3) -> Val {
        Val { n: 3, v: [v.x, v.y, v.z, 0.0] }
    }
    fn color(c: Color) -> Val {
        let c = c.to_srgba();
        Val { n: 4, v: [c.red, c.green, c.blue, c.alpha] }
    }
    fn to_color(self) -> Color {
        Color::srgba(self.v[0], self.v[1], self.v[2], if self.n == 4 { self.v[3] } else { 1.0 })
    }
    fn of_rv(v: &RV, what: &str) -> Result<Val, String> {
        match v {
            RV::Int(_) | RV::Float(_) => Ok(Val::num(f(v, what)?)),
            RV::Array(a) => {
                let a = a.borrow();
                if a.len() != 3 && a.len() != 4 {
                    return Err(format!("{what} must be a number, [x, y, z] or [r, g, b, a]"));
                }
                let mut o = Val { n: a.len() as u8, v: [0.0; 4] };
                for (i, x) in a.iter().enumerate() {
                    o.v[i] = f(x, what)?;
                }
                Ok(o)
            }
            other => Err(format!("{what} must be a number or an array, got {}", other.type_name())),
        }
    }
    fn of_value(v: &Value) -> Result<Val, String> {
        match v {
            Value::Num(x) => Ok(Val::num(*x as f32)),
            Value::Vec3(a) => Ok(Val { n: 3, v: [a[0], a[1], a[2], 0.0] }),
            Value::Json(j) => match j.as_array() {
                Some(a) if a.len() == 3 || a.len() == 4 => {
                    let mut o = Val { n: a.len() as u8, v: [0.0; 4] };
                    for (i, x) in a.iter().enumerate() {
                        o.v[i] = x.as_f64().ok_or("not a numeric array")? as f32;
                    }
                    Ok(o)
                }
                _ => Err("property is not a number or numeric array".into()),
            },
            _ => Err("property is not a number or numeric array".into()),
        }
    }
    fn to_value(self) -> Value {
        match self.n {
            1 => Value::Num(self.v[0] as f64),
            3 => Value::Vec3([self.v[0], self.v[1], self.v[2]]),
            _ => Value::Json(std::sync::Arc::new(serde_json::json!([self.v[0], self.v[1], self.v[2], self.v[3]]))),
        }
    }
    fn to_rv(self) -> RV {
        match self.n {
            1 => RV::Float(self.v[0] as f64),
            3 => rv3(Vec3::new(self.v[0], self.v[1], self.v[2])),
            _ => RV::array(self.v.iter().map(|x| RV::Float(*x as f64)).collect()),
        }
    }
    fn lerp(a: Val, b: Val, k: f32) -> Val {
        let mut o = b;
        for i in 0..b.n as usize {
            o.v[i] = a.v[i] + (b.v[i] - a.v[i]) * k;
        }
        o
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Ease {
    In,
    Out,
    InOut,
    OutIn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Trans {
    Linear,
    Sine,
    Quad,
    Cubic,
    Quart,
    Quint,
    Expo,
    Circ,
    Back,
    Elastic,
    Bounce,
}

fn bounce_out(mut t: f32) -> f32 {
    if t < 1.0 / 2.75 {
        7.5625 * t * t
    } else if t < 2.0 / 2.75 {
        t -= 1.5 / 2.75;
        7.5625 * t * t + 0.75
    } else if t < 2.5 / 2.75 {
        t -= 2.25 / 2.75;
        7.5625 * t * t + 0.9375
    } else {
        t -= 2.625 / 2.75;
        7.5625 * t * t + 0.984375
    }
}

/// The "ease in" curve of each transition, `f(0) = 0`, `f(1) = 1`.
fn ease_in(tr: Trans, t: f32) -> f32 {
    use std::f32::consts::{FRAC_PI_2, PI};
    match tr {
        Trans::Linear => t,
        Trans::Sine => 1.0 - (t * FRAC_PI_2).cos(),
        Trans::Quad => t * t,
        Trans::Cubic => t * t * t,
        Trans::Quart => t * t * t * t,
        Trans::Quint => t * t * t * t * t,
        Trans::Expo => 2f32.powf(10.0 * (t - 1.0)),
        Trans::Circ => 1.0 - (1.0 - t * t).max(0.0).sqrt(),
        Trans::Back => {
            let c = 1.70158;
            (c + 1.0) * t * t * t - c * t * t
        }
        Trans::Elastic => -(2f32.powf(10.0 * t - 10.0)) * ((t * 10.0 - 10.75) * (2.0 * PI / 3.0)).sin(),
        Trans::Bounce => 1.0 - bounce_out(1.0 - t),
    }
}

/// Eased progress for `t` in 0..1; exactly 0 and 1 at the ends.
pub(super) fn ease(tr: Trans, mode: Ease, t: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    match mode {
        Ease::In => ease_in(tr, t),
        Ease::Out => 1.0 - ease_in(tr, 1.0 - t),
        Ease::InOut => {
            if t < 0.5 {
                ease_in(tr, 2.0 * t) / 2.0
            } else {
                1.0 - ease_in(tr, 2.0 - 2.0 * t) / 2.0
            }
        }
        Ease::OutIn => {
            if t < 0.5 {
                (1.0 - ease_in(tr, 1.0 - 2.0 * t)) / 2.0
            } else {
                (1.0 + ease_in(tr, 2.0 * t - 1.0)) / 2.0
            }
        }
    }
}

#[cfg(test)]
pub(super) use ease as test_ease;
#[cfg(test)]
pub(super) const ALL_EASES: [Ease; 4] = [Ease::In, Ease::Out, Ease::InOut, Ease::OutIn];
#[cfg(test)]
pub(super) const ALL_TRANS: [Trans; 11] = [
    Trans::Linear,
    Trans::Sine,
    Trans::Quad,
    Trans::Cubic,
    Trans::Quart,
    Trans::Quint,
    Trans::Expo,
    Trans::Circ,
    Trans::Back,
    Trans::Elastic,
    Trans::Bounce,
];

// ---------------------------------------------------------------- properties

#[derive(Clone, Debug)]
enum Prop {
    Position,
    Rotation,
    Scale,
    /// `set_color` semantics (Primitive, material, UI background).
    Color,
    /// UI `BackgroundColor` directly.
    Bg,
    TextColor,
    /// Alpha of the `Color` target.
    Alpha,
    Member(String),
    Path(String),
}

impl Prop {
    fn parse(p: &str) -> Result<Prop, String> {
        Ok(match p {
            "position" => Prop::Position,
            "rotation" => Prop::Rotation,
            "scale" => Prop::Scale,
            "color" => Prop::Color,
            "bg" => Prop::Bg,
            "text_color" => Prop::TextColor,
            "alpha" => Prop::Alpha,
            _ => {
                if let Some(m) = p.strip_prefix("member:") {
                    Prop::Member(m.to_string())
                } else if p.contains('.') {
                    Prop::Path(p.to_string())
                } else {
                    return Err(format!("unknown tween property `{p}` (position, rotation, scale, color, bg, text_color, alpha, member:<name>, or \"Component.field\")"));
                }
            }
        })
    }
    fn is_color(&self) -> bool {
        matches!(self, Prop::Color | Prop::Bg | Prop::TextColor)
    }

    fn get(&self, w: &World, e: Entity) -> Result<Val, String> {
        let no = |what: &str| format!("entity {e} has no {what}");
        match self {
            Prop::Position => w.get::<Transform>(e).map(|t| Val::vec3(t.translation)).ok_or_else(|| no("Transform")),
            Prop::Scale => w.get::<Transform>(e).map(|t| Val::vec3(t.scale)).ok_or_else(|| no("Transform")),
            Prop::Rotation => {
                w.get::<Transform>(e).map(|t| Val::vec3(Vec3::from(t.rotation.to_euler(EulerRot::XYZ)))).ok_or_else(|| no("Transform"))
            }
            Prop::Color => super::api_node::read_color(w, e).map(Val::color).ok_or_else(|| no("color (Primitive, material or BackgroundColor)")),
            Prop::Alpha => {
                super::api_node::read_color(w, e).map(|c| Val::num(c.to_srgba().alpha)).ok_or_else(|| no("color (Primitive, material or BackgroundColor)"))
            }
            Prop::Bg => w.get::<BackgroundColor>(e).map(|b| Val::color(b.0)).ok_or_else(|| no("BackgroundColor")),
            Prop::TextColor => w.get::<TextColor>(e).map(|b| Val::color(b.0)).ok_or_else(|| no("TextColor")),
            Prop::Member(m) => Val::of_rv(&super::get_member_rv(w, e, m)?, m),
            Prop::Path(p) => Val::of_value(&access::get_path(w, e, p)?),
        }
    }

    fn set(&self, w: &mut World, e: Entity, v: Val) -> Result<(), String> {
        let no = |what: &str| format!("entity {e} has no {what}");
        match self {
            Prop::Position => w.get_mut::<Transform>(e).ok_or_else(|| no("Transform"))?.translation = Vec3::new(v.v[0], v.v[1], v.v[2]),
            Prop::Scale => w.get_mut::<Transform>(e).ok_or_else(|| no("Transform"))?.scale = Vec3::new(v.v[0], v.v[1], v.v[2]),
            Prop::Rotation => {
                w.get_mut::<Transform>(e).ok_or_else(|| no("Transform"))?.rotation = Quat::from_euler(EulerRot::XYZ, v.v[0], v.v[1], v.v[2])
            }
            Prop::Color => super::api_node::apply_color(w, e, v.to_color())?,
            Prop::Alpha => {
                let c = super::api_node::read_color(w, e).ok_or_else(|| no("color"))?;
                super::api_node::apply_color(w, e, c.with_alpha(v.v[0]))?
            }
            Prop::Bg => w.get_mut::<BackgroundColor>(e).ok_or_else(|| no("BackgroundColor"))?.0 = v.to_color(),
            Prop::TextColor => w.get_mut::<TextColor>(e).ok_or_else(|| no("TextColor"))?.0 = v.to_color(),
            Prop::Member(m) => super::set_member_rv(w, e, m, v.to_rv())?,
            Prop::Path(p) => access::set_path(w, e, p, &v.to_value())?,
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- tween data

enum Kind {
    Prop { target: Entity, prop: Prop, from: Option<Val>, start: Val, to: Val },
    Interval,
    Callback { method: String, args: Vec<Value> },
}

struct Step {
    kind: Kind,
    dur: f32,
    ease: Ease,
    trans: Trans,
    done: bool,
}

pub(super) struct Tween {
    pub(super) id: u64,
    owner: Entity,
    groups: Vec<Vec<Step>>,
    /// Current group, seconds into it, and whether it has started.
    gi: usize,
    t: f32,
    started: bool,
    ease: Ease,
    trans: Trans,
    next_parallel: bool,
    /// 0 = forever.
    loops: u32,
    loops_done: u32,
    on_finished: Option<String>,
    paused: bool,
    killed: bool,
    finished: bool,
}

/// All live tweens.
#[derive(Resource, Default)]
pub struct Tweens {
    pub(super) list: Vec<Tween>,
    next: u64,
}

enum Event {
    Callback { owner: Entity, method: String, args: Vec<Value> },
    Finished { id: u64, owner: Entity, method: Option<String> },
    Diag(String),
}

impl Tween {
    fn push(&mut self, kind: Kind, dur: f32) {
        let step = Step { kind, dur: dur.max(0.0), ease: self.ease, trans: self.trans, done: false };
        if self.next_parallel && !self.groups.is_empty() {
            self.groups.last_mut().unwrap().push(step);
        } else {
            self.groups.push(vec![step]);
        }
        self.next_parallel = false;
    }

    fn start_group(&mut self, w: &World, ev: &mut Vec<Event>) {
        let owner = self.owner;
        for st in &mut self.groups[self.gi] {
            match &mut st.kind {
                Kind::Callback { method, args } => {
                    ev.push(Event::Callback { owner, method: method.clone(), args: args.clone() });
                    st.done = true;
                }
                Kind::Prop { target, prop, from, start, to } => {
                    if w.get_entity(*target).is_err() {
                        st.done = true;
                        continue;
                    }
                    let begin = match from {
                        Some(v) => Ok(*v),
                        None => prop.get(w, *target),
                    };
                    match begin {
                        Ok(mut b) => {
                            if prop.is_color() {
                                // A 3-component color keeps the current alpha.
                                if b.n == 4 && to.n == 3 {
                                    to.v[3] = b.v[3];
                                    to.n = 4;
                                }
                                if b.n == 3 && to.n == 4 {
                                    b.v[3] = 1.0;
                                    b.n = 4;
                                }
                            }
                            if b.n != to.n {
                                ev.push(Event::Diag(format!("tween {}: {prop:?} has {} component(s), target has {}", self.id, b.n, to.n)));
                                st.done = true;
                            }
                            *start = b;
                        }
                        Err(e) => {
                            ev.push(Event::Diag(format!("tween {}: {e}", self.id)));
                            st.done = true;
                        }
                    }
                }
                Kind::Interval => {}
            }
        }
        self.started = true;
        self.t = 0.0;
    }

    fn advance(&mut self, world: &mut World, mut dt: f32, ev: &mut Vec<Event>) {
        for _ in 0..1000 {
            if self.gi >= self.groups.len() {
                if self.loops == 0 || self.loops_done + 1 < self.loops {
                    if self.groups.is_empty() {
                        break;
                    }
                    self.loops_done += 1;
                    self.gi = 0;
                    self.started = false;
                    for st in self.groups.iter_mut().flatten() {
                        st.done = false;
                    }
                    continue;
                }
                self.finished = true;
                ev.push(Event::Finished { id: self.id, owner: self.owner, method: self.on_finished.clone() });
                return;
            }
            if !self.started {
                self.start_group(world, ev);
            }
            self.t += dt;
            let t = self.t;
            let mut gdur = 0f32;
            for st in &mut self.groups[self.gi] {
                gdur = gdur.max(st.dur);
                if st.done {
                    continue;
                }
                let Kind::Prop { target, prop, start, to, .. } = &st.kind else { continue };
                let p = if st.dur <= 0.0 { 1.0 } else { t / st.dur };
                let v = if p >= 1.0 { *to } else { Val::lerp(*start, *to, ease(st.trans, st.ease, p)) };
                if p >= 1.0 {
                    st.done = true;
                }
                if world.get_entity(*target).is_err() {
                    st.done = true;
                } else if let Err(e) = prop.set(world, *target, v) {
                    ev.push(Event::Diag(format!("tween {}: {e}", self.id)));
                    st.done = true;
                }
            }
            if self.t >= gdur {
                dt = self.t - gdur;
                self.gi += 1;
                self.started = false;
                self.t = 0.0;
            } else {
                return;
            }
        }
    }
}

// ---------------------------------------------------------------- system

pub(super) fn plugin(app: &mut App) {
    app.init_resource::<Tweens>().add_systems(Update, tweens.after(super::process).in_set(ScriptSet::Process));
}

fn tweens(world: &mut World) {
    if world.resource::<Tweens>().list.is_empty() {
        return;
    }
    let paused = tree_paused(world);
    let dt = frame_dt(world, paused);
    let mut events: Vec<Event> = Vec::new();
    world.resource_scope(|world, mut tw: Mut<Tweens>| {
        for t in tw.list.iter_mut() {
            if t.killed || t.finished || t.paused {
                continue;
            }
            if world.get_entity(t.owner).is_err() {
                t.killed = true;
                continue;
            }
            if !runs_now(world, t.owner, paused) {
                continue;
            }
            t.advance(world, dt, &mut events);
        }
        tw.list.retain(|t| !t.killed && !t.finished);
    });
    for ev in events {
        match ev {
            Event::Diag(m) => diag(world, "tween", 0, 0, m),
            Event::Callback { owner, method, args } => run(world, owner, &method, args.iter().map(rv_of).collect()),
            Event::Finished { id, owner, method } => {
                emit_signal_rv(world, owner, "tween_finished", vec![RV::Int(id as i64)]);
                if let Some(m) = method {
                    run(world, owner, &m, vec![RV::Int(id as i64)]);
                }
            }
        }
    }
}

fn run(world: &mut World, e: Entity, method: &str, args: Vec<RV>) {
    if world.get_entity(e).is_err() {
        return;
    }
    if is_busy(world, e) {
        defer(world, e, method.to_string(), args);
    } else if let Err(err) = call_rv(world, e, method, args)
        && !err.contains(".ruspy:")
    {
        diag(world, "tween", 0, 0, format!("{e}.{method}: {err}"));
    }
}

// ---------------------------------------------------------------- host functions

fn id_of(v: &RV) -> Result<u64, String> {
    match v {
        RV::Int(i) if *i > 0 => Ok(*i as u64),
        _ => Err("expected a tween id (from tween())".into()),
    }
}

fn with<R>(w: &mut World, a: &[RV], usage: &str, n: usize, body: impl FnOnce(&mut Tween, &[RV]) -> Result<R, String>) -> Result<R, String> {
    if a.len() < n {
        return Err(format!("usage: {usage}"));
    }
    let id = id_of(&a[0])?;
    let mut tw = w.resource_mut::<Tweens>();
    let t = tw.list.iter_mut().find(|t| t.id == id && !t.killed).ok_or_else(|| format!("tween {id} is finished or killed"))?;
    body(t, &a[1..])
}

pub(super) fn register(e: &mut Engine) {
    e.register("tween", |c, a| {
        let w = world(c)?;
        let owner = match a {
            [] => me(w)?,
            [x] => live(w, ent(x)?)?,
            _ => return Err("usage: tween([node])".into()),
        };
        let mut tw = w.resource_mut::<Tweens>();
        tw.next += 1;
        let id = tw.next;
        tw.list.push(Tween {
            id,
            owner,
            groups: vec![],
            gi: 0,
            t: 0.0,
            started: false,
            ease: Ease::InOut,
            trans: Trans::Linear,
            next_parallel: false,
            loops: 1,
            loops_done: 0,
            on_finished: None,
            paused: false,
            killed: false,
            finished: false,
        });
        Ok(RV::Int(id as i64))
    });
    e.register("tween_property", |c, a| {
        let w = world(c)?;
        let usage = "tween_property(id, [node,] prop, to, secs)";
        if a.len() != 4 && a.len() != 5 {
            return Err(format!("usage: {usage}"));
        }
        let id = id_of(&a[0])?;
        let owner = w.resource::<Tweens>().list.iter().find(|t| t.id == id && !t.killed).map(|t| t.owner).ok_or_else(|| format!("tween {id} is finished or killed"))?;
        let (target, r) = if a.len() == 5 { (live(w, ent(&a[1])?)?, &a[2..]) } else { (owner, &a[1..]) };
        let prop = Prop::parse(s(&r[0], "prop")?)?;
        let to = Val::of_rv(&r[1], "to")?;
        let dur = f(&r[2], "secs")?;
        with(w, a, usage, 1, |t, _| {
            t.push(Kind::Prop { target, prop, from: None, start: to, to }, dur);
            Ok(RV::Void)
        })
    });
    e.register("tween_from", |c, a| {
        let w = world(c)?;
        let from = Val::of_rv(a.get(1).ok_or("usage: tween_from(id, from)")?, "from")?;
        with(w, a, "tween_from(id, from)", 2, |t, _| {
            let st = t.groups.iter_mut().flatten().next_back().ok_or("tween_from: no step yet")?;
            match &mut st.kind {
                Kind::Prop { from: f, .. } => *f = Some(from),
                _ => return Err("tween_from: the last step is not a property tween".into()),
            }
            Ok(RV::Void)
        })
    });
    e.register("tween_interval", |c, a| {
        let w = world(c)?;
        let secs = f(a.get(1).ok_or("usage: tween_interval(id, secs)")?, "secs")?;
        with(w, a, "tween_interval(id, secs)", 2, |t, _| {
            t.push(Kind::Interval, secs);
            Ok(RV::Void)
        })
    });
    e.register("tween_callback", |c, a| {
        let w = world(c)?;
        let method = s(a.get(1).ok_or("usage: tween_callback(id, method [, args...])")?, "method")?.to_string();
        let args = a[2..].iter().map(value_of_rv).collect::<Result<Vec<_>, _>>()?;
        with(w, a, "tween_callback(id, method [, args...])", 2, |t, _| {
            t.push(Kind::Callback { method, args }, 0.0);
            Ok(RV::Void)
        })
    });
    e.register("tween_parallel", |c, a| {
        with(world(c)?, a, "tween_parallel(id)", 1, |t, _| {
            t.next_parallel = true;
            Ok(RV::Void)
        })
    });
    e.register("tween_chain", |c, a| {
        with(world(c)?, a, "tween_chain(id)", 1, |t, _| {
            t.next_parallel = false;
            Ok(RV::Void)
        })
    });
    e.register("tween_set_ease", |c, a| {
        let mode = match s(a.get(1).ok_or("usage: tween_set_ease(id, \"in\"|\"out\"|\"in_out\"|\"out_in\")")?, "ease")? {
            "in" => Ease::In,
            "out" => Ease::Out,
            "in_out" => Ease::InOut,
            "out_in" => Ease::OutIn,
            o => return Err(format!("unknown ease `{o}` (in, out, in_out, out_in)")),
        };
        with(world(c)?, a, "tween_set_ease(id, ease)", 2, |t, _| {
            t.ease = mode;
            Ok(RV::Void)
        })
    });
    e.register("tween_set_trans", |c, a| {
        let tr = match s(a.get(1).ok_or("usage: tween_set_trans(id, trans)")?, "trans")? {
            "linear" => Trans::Linear,
            "sine" => Trans::Sine,
            "quad" => Trans::Quad,
            "cubic" => Trans::Cubic,
            "quart" => Trans::Quart,
            "quint" => Trans::Quint,
            "expo" => Trans::Expo,
            "circ" => Trans::Circ,
            "back" => Trans::Back,
            "elastic" => Trans::Elastic,
            "bounce" => Trans::Bounce,
            o => return Err(format!("unknown transition `{o}` (linear, sine, quad, cubic, quart, quint, expo, circ, back, elastic, bounce)")),
        };
        with(world(c)?, a, "tween_set_trans(id, trans)", 2, |t, _| {
            t.trans = tr;
            Ok(RV::Void)
        })
    });
    e.register("tween_set_loops", |c, a| {
        let n = f(a.get(1).ok_or("usage: tween_set_loops(id, n)  (0 = forever)")?, "n")?;
        with(world(c)?, a, "tween_set_loops(id, n)", 2, |t, _| {
            t.loops = n.max(0.0) as u32;
            Ok(RV::Void)
        })
    });
    e.register("tween_on_finished", |c, a| {
        let m = s(a.get(1).ok_or("usage: tween_on_finished(id, method)")?, "method")?.to_string();
        with(world(c)?, a, "tween_on_finished(id, method)", 2, |t, _| {
            t.on_finished = Some(m);
            Ok(RV::Void)
        })
    });
    e.register("tween_pause", |c, a| {
        with(world(c)?, a, "tween_pause(id)", 1, |t, _| {
            t.paused = true;
            Ok(RV::Void)
        })
    });
    e.register("tween_play", |c, a| {
        with(world(c)?, a, "tween_play(id)", 1, |t, _| {
            t.paused = false;
            Ok(RV::Void)
        })
    });
    e.register("tween_kill", |c, a| {
        let w = world(c)?;
        if let Some(id) = a.first().and_then(|v| id_of(v).ok())
            && let Some(t) = w.resource_mut::<Tweens>().list.iter_mut().find(|t| t.id == id)
        {
            t.killed = true;
        }
        Ok(RV::Void)
    });
    e.register("tween_is_running", |c, a| {
        let w = world(c)?;
        let id = id_of(a.first().ok_or("usage: tween_is_running(id)")?)?;
        Ok(RV::Bool(w.resource::<Tweens>().list.iter().any(|t| t.id == id && !t.killed && !t.finished && !t.paused)))
    });
    e.register("tween_owner", |c, a| {
        let w = world(c)?;
        let id = id_of(a.first().ok_or("usage: tween_owner(id)")?)?;
        Ok(w.resource::<Tweens>().list.iter().find(|t| t.id == id).map_or(RV::Null, |t| rent(t.owner)))
    });
}
