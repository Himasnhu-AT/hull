//! `await` for node scripts: a function with `await` is a ruspy coroutine. The awaitables are
//! plain values from host functions (`wait`, `next_frame`, `signal_of`); the runtime keeps the
//! suspended coroutines per instance and resumes them from the frame loop or from a signal.

use bevy::prelude::*;
use ruspy::embed::{Engine, Outcome};
use ruspy::value::Value as RV;

use super::api::{ent, f, live, me, rent, s, world};
use super::{ScriptCtx, ScriptRuntime, diag, effective_mode, tree_paused};

/// What a coroutine is waiting for.
pub(crate) enum Wait {
    Time(f32),
    /// Resume on the next frame's coroutine tick.
    Frame,
    Signal { src: Entity, name: String },
}

pub(crate) struct Co {
    pub entity: Entity,
    pub token: u64,
    pub wait: Wait,
    /// Frames to skip before a `Frame`/`Time` wait counts (so `next_frame` is really the next).
    fresh: bool,
    /// Resume value kept when the instance was busy at wake-up time.
    value: Option<RV>,
}

/// An awaited value as a wait; non-awaitable values resume on the next frame.
fn wait_of(v: &RV) -> Result<Wait, String> {
    let RV::Dict(d) = v else { return Ok(Wait::Frame) };
    let d = d.borrow();
    match d.get_str("await") {
        Some(RV::Str(k)) if k == "wait" => Ok(Wait::Time(f(d.get_str("secs").ok_or("wait: no seconds")?, "seconds")?.max(0.0))),
        Some(RV::Str(k)) if k == "frame" => Ok(Wait::Frame),
        Some(RV::Str(k)) if k == "signal" => {
            let src = ent(d.get_str("node").ok_or("signal_of: no node")?)?;
            let name = s(d.get_str("name").ok_or("signal_of: no name")?, "signal name")?.to_string();
            Ok(Wait::Signal { src, name })
        }
        _ => Ok(Wait::Frame),
    }
}

/// Registers the coroutines an instance's engine just suspended.
pub(crate) fn register_suspended(world: &mut World, e: Entity, key: &str, sus: Vec<(u64, RV)>) {
    for (token, awaiting) in sus {
        match wait_of(&awaiting) {
            Ok(wait) => world.non_send_mut::<ScriptRuntime>().coroutines.push(Co { entity: e, token, wait, fresh: true, value: None }),
            Err(m) => diag(world, key, 0, 0, format!("await on {e}: {m}")),
        }
    }
}

/// Drops every coroutine of `e` (it was freed or its script reloaded).
pub(crate) fn drop_for(world: &mut World, e: Entity) {
    if let Some(mut rt) = world.get_non_send_mut::<ScriptRuntime>() {
        rt.coroutines.retain(|c| c.entity != e);
    }
}

/// Resumes one coroutine now. If its instance is busy (on the call stack) it is retried on the
/// next tick with the same value.
fn resume(world: &mut World, mut co: Co, value: RV) {
    let e = co.entity;
    let Some(inst) = world.get_non_send::<ScriptRuntime>().and_then(|rt| rt.instances.get(&e).cloned()) else { return };
    let Ok(mut i) = inst.try_borrow_mut() else {
        co.wait = Wait::Frame;
        co.fresh = true;
        co.value = Some(value);
        world.non_send_mut::<ScriptRuntime>().coroutines.push(co);
        return;
    };
    world.resource_mut::<ScriptCtx>().stack.push(e);
    let m = i.module;
    let r = i.engine.resume(m, co.token, value, world);
    world.resource_mut::<ScriptCtx>().stack.pop();
    let more = i.engine.take_suspended(m);
    let key = i.key.clone();
    drop(i);
    match r {
        Ok(Outcome::Suspended(a)) => match wait_of(&a) {
            Ok(wait) => world.non_send_mut::<ScriptRuntime>().coroutines.push(Co { entity: e, token: co.token, wait, fresh: true, value: None }),
            Err(msg) => diag(world, &key, 0, 0, format!("await on {e}: {msg}")),
        },
        Ok(Outcome::Done(_)) => {}
        Err(x) => {
            let trace = x.trace_text();
            let tail = if trace.is_empty() { String::new() } else { format!("\n{trace}") };
            diag(world, &key, x.line, x.col, format!("[{}] {}{tail}", x.code, x.message));
            world.non_send_mut::<ScriptRuntime>().last_errors.insert(e, format!("{key}:{}:{}: {}{tail}", x.line, x.col, x.message));
        }
    }
    register_suspended(world, e, &key, more);
}

/// Wakes coroutines awaiting `signal` of `src`; the awaited value is the signal's argument(s).
pub(crate) fn wake_signal(world: &mut World, src: Entity, signal: &str, args: &[RV]) {
    let Some(mut rt) = world.get_non_send_mut::<ScriptRuntime>() else { return };
    if rt.coroutines.is_empty() {
        return;
    }
    let (hit, rest): (Vec<Co>, Vec<Co>) = std::mem::take(&mut rt.coroutines)
        .into_iter()
        .partition(|c| matches!(&c.wait, Wait::Signal { src: s2, name } if *s2 == src && name == signal));
    rt.coroutines = rest;
    for co in hit {
        let v = match args {
            [] => RV::Null,
            [one] => one.clone(),
            many => RV::array(many.to_vec()),
        };
        resume(world, co, v);
    }
}

/// Once per frame (after `_process`): advances timers and next-frame waits of the coroutines
/// whose node may run now (process mode, pause), dropping those of freed nodes.
pub(super) fn tick(world: &mut World) {
    let list = std::mem::take(&mut world.non_send_mut::<ScriptRuntime>().coroutines);
    if list.is_empty() {
        return;
    }
    let paused = tree_paused(world);
    let dt = world.resource::<ScriptCtx>().delta;
    let mut keep = Vec::with_capacity(list.len());
    for mut co in list {
        if world.get_entity(co.entity).is_err() {
            continue;
        }
        if !effective_mode(world, co.entity).runs(paused) {
            keep.push(co);
            continue;
        }
        if co.fresh {
            co.fresh = false;
            keep.push(co);
            continue;
        }
        let due = match &mut co.wait {
            Wait::Time(t) => {
                *t -= dt;
                *t <= 0.0
            }
            Wait::Frame => true,
            Wait::Signal { .. } => false,
        };
        if due {
            let v = co.value.take().unwrap_or(RV::Null);
            resume(world, co, v);
        } else {
            keep.push(co);
        }
    }
    world.non_send_mut::<ScriptRuntime>().coroutines.extend(keep);
}

fn awaitable(kind: &str, extra: Vec<(&str, RV)>) -> RV {
    let mut v = vec![(RV::Str("await".into()), RV::Str(kind.into()))];
    v.extend(extra.into_iter().map(|(k, x)| (RV::Str(k.into()), x)));
    RV::dict(v)
}

pub(super) fn register(e: &mut Engine) {
    e.register("wait", |_, a| {
        let secs = f(a.first().ok_or("usage: wait(seconds)")?, "seconds")?;
        Ok(awaitable("wait", vec![("secs", RV::Float(secs as f64))]))
    });
    e.register("next_frame", |_, _| Ok(awaitable("frame", vec![])));
    e.register("signal_of", |c, a| {
        let w = world(c)?;
        let (node, name) = match a {
            [n, name] => (live(w, ent(n)?)?, s(name, "signal name")?),
            [name] => (me(w)?, s(name, "signal name")?),
            _ => return Err("usage: signal_of([node,] \"signal\")".into()),
        };
        Ok(awaitable("signal", vec![("node", rent(node)), ("name", RV::Str(name.to_string()))]))
    });
}
