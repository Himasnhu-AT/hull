//! Input, groups, time, math and misc host functions. `[n,]` is the optional leading node.
//!
//! | Group | Functions |
//! |---|---|
//! | Input | `is_action_pressed/just_pressed/just_released(a)`, `get_action_strength(a)`, `get_axis(neg, pos)`, `get_vector(action2d)` / `get_vector(nx, px, ny, py)`, `is_key_pressed("KeyW")`, `get_mouse_position()`, `set_input_as_handled()` |
//! | Groups | `add_to_group/remove_from_group/is_in_group([n,] g)`, `get_nodes_in_group(g)`, `get_first_node_in_group(g)`, `call_group(g, method, args...)` |
//! | Time | `delta()`, `physics_delta()`, `time()`, `start_timer(secs, method [, repeat])`, `stop_timer(id)`, `timer_start([n] [, secs])`, `timer_stop([n])`, `timer_left([n])` |
//! | Math | `vec3`, `vadd`, `vsub`, `vscale`, `vlen`, `vnorm`, `vdot`, `vcross`, `distance`, `lerp`, `randf`, `randi_range`, `clampf` |
//! | Misc | `send_message(name, value)`, `command(id, json_text)` |

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{ent, f, live, rent, rv3, s, split, v3, world};
use super::{CallTimer, Groups, ScriptCtx, ScriptQueue, ScriptTimer};
use crate::logic::script::value_of_rv;

pub(super) fn register(e: &mut Engine) {
    input(e);
    groups(e);
    time(e);
    math(e);
    misc(e);
}

// ---------------------------------------------------------------- input

fn action_name<'a>(a: &'a [RV], usage: &str) -> Result<&'a str, String> {
    s(a.first().ok_or_else(|| format!("usage: {usage}"))?, "action")
}

#[cfg(feature = "actions")]
fn strength(w: &World, name: &str) -> f32 {
    w.get_resource::<crate::actions::ActionState>().map_or(0.0, |st| st.value(name))
}
#[cfg(not(feature = "actions"))]
fn strength(_: &World, _: &str) -> f32 {
    0.0
}

#[cfg(feature = "actions")]
fn axis2d(w: &World, name: &str) -> Vec2 {
    w.get_resource::<crate::actions::ActionState>().map_or(Vec2::ZERO, |st| st.axis2d(name))
}
#[cfg(not(feature = "actions"))]
fn axis2d(_: &World, _: &str) -> Vec2 {
    Vec2::ZERO
}

#[cfg(feature = "actions")]
fn flag(w: &World, name: &str, which: u8) -> bool {
    // Inside `_physics_process` edges come from the latch: each is seen by exactly one fixed step.
    if which > 0
        && let Some(e) = w.get_resource::<super::api_actions::PhysicsEdges>()
        && e.active
    {
        let list = if which == 1 { &e.pressed } else { &e.released };
        return list.iter().any(|n| n == name);
    }
    w.get_resource::<crate::actions::ActionState>().is_some_and(|st| match which {
        0 => st.pressed(name),
        1 => st.just_pressed(name),
        _ => st.just_released(name),
    })
}
#[cfg(not(feature = "actions"))]
fn flag(_: &World, _: &str, _: u8) -> bool {
    false
}

fn input(e: &mut Engine) {
    e.register("is_action_pressed", |c, a| {
        let n = action_name(a, "is_action_pressed(action)")?;
        Ok(RV::Bool(flag(world(c)?, n, 0)))
    });
    e.register("is_action_just_pressed", |c, a| {
        let n = action_name(a, "is_action_just_pressed(action)")?;
        Ok(RV::Bool(flag(world(c)?, n, 1)))
    });
    e.register("is_action_just_released", |c, a| {
        let n = action_name(a, "is_action_just_released(action)")?;
        Ok(RV::Bool(flag(world(c)?, n, 2)))
    });
    e.register("get_action_strength", |c, a| {
        let n = action_name(a, "get_action_strength(action)")?;
        Ok(RV::Float(strength(world(c)?, n) as f64))
    });
    e.register("get_axis", |c, a| {
        if a.len() != 2 {
            return Err("usage: get_axis(negative_action, positive_action)".into());
        }
        let w = world(c)?;
        Ok(RV::Float((strength(w, s(&a[1], "action")?) - strength(w, s(&a[0], "action")?)) as f64))
    });
    // get_vector(neg_x, pos_x, neg_y, pos_y) from four actions, or get_vector(action2d): the
    // value of one 2D action (`ActionState::axis2d`).
    e.register("get_vector", |c, a| {
        let w = world(c)?;
        let v = match a.len() {
            1 => axis2d(w, s(&a[0], "action")?),
            4 => {
                let x = strength(w, s(&a[1], "action")?) - strength(w, s(&a[0], "action")?);
                let y = strength(w, s(&a[3], "action")?) - strength(w, s(&a[2], "action")?);
                Vec2::new(x, y).clamp_length_max(1.0)
            }
            _ => return Err("usage: get_vector(action2d) or get_vector(neg_x, pos_x, neg_y, pos_y)".into()),
        };
        Ok(RV::Vec2([v.x as f64, v.y as f64]))
    });
    e.register("is_key_pressed", |c, a| {
        let n = s(a.first().ok_or("usage: is_key_pressed(\"KeyW\")")?, "key")?;
        let w = world(c)?;
        #[cfg(feature = "actions")]
        {
            let key = crate::actions::binding::parse_key(n).ok_or_else(|| format!("unknown key `{n}` (use names like KeyW, Space, ArrowLeft)"))?;
            Ok(RV::Bool(w.get_resource::<ButtonInput<KeyCode>>().is_some_and(|k| k.pressed(key))))
        }
        #[cfg(not(feature = "actions"))]
        {
            let _ = (w, n);
            Ok(RV::Bool(false))
        }
    });
    e.register("get_mouse_position", |c, _| {
        let w = world(c)?;
        let mut q = w.query_filtered::<&Window, With<bevy::window::PrimaryWindow>>();
        Ok(match q.iter(w).next().and_then(|win| win.cursor_position()) {
            Some(p) => RV::Vec2([p.x as f64, p.y as f64]),
            None => RV::Null,
        })
    });
    e.register("set_input_as_handled", |c, _| {
        world(c)?.resource_mut::<ScriptCtx>().handled = true;
        Ok(RV::Void)
    });
}

// ---------------------------------------------------------------- groups

fn group_members(w: &mut World, g: &str) -> Vec<Entity> {
    let mut q = w.query::<(Entity, &Groups)>();
    q.iter(w).filter(|(_, gs)| gs.0.iter().any(|x| x == g)).map(|(e, _)| e).collect()
}

fn groups(e: &mut Engine) {
    e.register("add_to_group", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "add_to_group([node,] group)")?;
        let g = s(&r[0], "group")?;
        let mut em = w.entity_mut(t);
        match em.get_mut::<Groups>() {
            Some(mut gs) => {
                if !gs.0.iter().any(|x| x == g) {
                    gs.0.push(g.to_string());
                }
            }
            None => {
                em.insert(Groups(vec![g.to_string()]));
            }
        }
        Ok(RV::Void)
    });
    e.register("remove_from_group", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "remove_from_group([node,] group)")?;
        let g = s(&r[0], "group")?;
        if let Some(mut gs) = w.get_mut::<Groups>(t) {
            gs.0.retain(|x| x != g);
        }
        Ok(RV::Void)
    });
    e.register("is_in_group", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "is_in_group([node,] group)")?;
        let g = s(&r[0], "group")?;
        Ok(RV::Bool(w.get::<Groups>(t).is_some_and(|gs| gs.0.iter().any(|x| x == g))))
    });
    e.register("get_nodes_in_group", |c, a| {
        let w = world(c)?;
        let g = s(a.first().ok_or("usage: get_nodes_in_group(group)")?, "group")?;
        Ok(RV::array(group_members(w, g).into_iter().map(rent).collect()))
    });
    e.register("get_first_node_in_group", |c, a| {
        let w = world(c)?;
        let g = s(a.first().ok_or("usage: get_first_node_in_group(group)")?, "group")?;
        Ok(group_members(w, g).first().map_or(RV::Null, |e| rent(*e)))
    });
    e.register("call_group", |c, a| {
        let w = world(c)?;
        if a.len() < 2 {
            return Err("usage: call_group(group, method, args...)".into());
        }
        let (g, m) = (s(&a[0], "group")?, s(&a[1], "method")?);
        let mut n = 0;
        for t in group_members(w, g) {
            if !super::can_call(w, t, m) {
                continue;
            }
            if super::is_busy(w, t) {
                // Running right now (e.g. the caller itself): call at the end of the frame.
                super::defer(w, t, m.to_string(), a[2..].to_vec());
                n += 1;
            } else if super::call_rv(w, t, m, a[2..].to_vec()).is_ok() {
                n += 1;
            }
        }
        Ok(RV::Int(n))
    });
}

// ---------------------------------------------------------------- time

fn live_entity(w: &World, bits: i64) -> Option<Entity> {
    Entity::try_from_bits(bits as u64).filter(|e| w.get_entity(*e).is_ok())
}

/// A lone int/float argument is a node if it is the id of a live entity (small numbers never
/// are: a valid id has a non-zero generation), else a number of seconds.
fn timer_args(w: &World, a: &[RV]) -> Result<(Entity, Option<f32>), String> {
    match a {
        [] => Ok((super::api::me(w)?, None)),
        [RV::Object(i)] if live_entity(w, *i as i64).is_some() => Ok((live_entity(w, *i as i64).unwrap_or(Entity::PLACEHOLDER), None)),
        [RV::Int(i)] if live_entity(w, *i).is_some() => Ok((live_entity(w, *i).unwrap_or(Entity::PLACEHOLDER), None)),
        // The VM may hand ints over as floats.
        [RV::Float(x)] if x.fract() == 0.0 && live_entity(w, *x as i64).is_some() => {
            Ok((live_entity(w, *x as i64).unwrap_or(Entity::PLACEHOLDER), None))
        }
        [x] => Ok((super::api::me(w)?, Some(f(x, "seconds")?))),
        [n, x] => Ok((live(w, ent(n)?)?, Some(f(x, "seconds")?))),
        _ => Err("usage: timer_start([node] [, seconds])".into()),
    }
}

fn time(e: &mut Engine) {
    e.register("delta", |c, _| Ok(RV::Float(world(c)?.resource::<ScriptCtx>().delta as f64)));
    e.register("physics_delta", |c, _| Ok(RV::Float(world(c)?.resource::<ScriptCtx>().physics_delta as f64)));
    e.register("time", |c, _| Ok(RV::Float(world(c)?.resource::<ScriptCtx>().elapsed)));
    e.register("start_timer", |c, a| {
        let w = world(c)?;
        if a.len() < 2 || a.len() > 3 {
            return Err("usage: start_timer(seconds, method [, repeat])".into());
        }
        let secs = f(&a[0], "seconds")?.max(0.0);
        let method = s(&a[1], "method")?.to_string();
        let repeat = match a.get(2) {
            Some(x) => super::api::b(x, "repeat")?,
            None => false,
        };
        let entity = super::api::me(w)?;
        let mut q = w.resource_mut::<ScriptQueue>();
        q.next_timer += 1;
        let id = q.next_timer;
        q.timers.push(CallTimer { id, entity, method, left: secs, interval: secs, repeat });
        Ok(RV::Int(id as i64))
    });
    e.register("stop_timer", |c, a| {
        let w = world(c)?;
        let id = match a.first() {
            Some(RV::Int(i)) => *i as u64,
            _ => return Err("usage: stop_timer(id)".into()),
        };
        w.resource_mut::<ScriptQueue>().timers.retain(|t| t.id != id);
        Ok(RV::Void)
    });
    e.register("timer_start", |c, a| {
        let w = world(c)?;
        let (t, secs) = timer_args(w, a)?;
        let mut tm = w.get_mut::<ScriptTimer>(t).ok_or_else(|| format!("entity {t} has no ScriptTimer"))?;
        tm.started = true;
        tm.left = Some(secs.unwrap_or(tm.wait_time));
        Ok(RV::Void)
    });
    e.register("timer_stop", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "timer_stop([node])")?;
        let mut tm = w.get_mut::<ScriptTimer>(t).ok_or_else(|| format!("entity {t} has no ScriptTimer"))?;
        tm.started = true;
        tm.left = None;
        Ok(RV::Void)
    });
    e.register("timer_left", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "timer_left([node])")?;
        let tm = w.get::<ScriptTimer>(t).ok_or_else(|| format!("entity {t} has no ScriptTimer"))?;
        Ok(RV::Float(tm.left.unwrap_or(0.0).max(0.0) as f64))
    });
}

// ---------------------------------------------------------------- math

fn two_vecs(a: &[RV], usage: &str) -> Result<(Vec3, Vec3), String> {
    if a.len() != 2 {
        return Err(format!("usage: {usage}"));
    }
    Ok((v3(&a[0], "a")?, v3(&a[1], "b")?))
}

fn next_rand(w: &mut World) -> u64 {
    let mut c = w.resource_mut::<ScriptCtx>();
    let mut x = if c.rng == 0 { 0x9E37_79B9_7F4A_7C15 } else { c.rng };
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    c.rng = x;
    x
}

fn math(e: &mut Engine) {
    e.register("vec3", |_, a| {
        if a.len() != 3 {
            return Err("usage: vec3(x, y, z)".into());
        }
        Ok(rv3(Vec3::new(f(&a[0], "x")?, f(&a[1], "y")?, f(&a[2], "z")?)))
    });
    e.register("vadd", |_, a| {
        let (x, y) = two_vecs(a, "vadd(a, b)")?;
        Ok(rv3(x + y))
    });
    e.register("vsub", |_, a| {
        let (x, y) = two_vecs(a, "vsub(a, b)")?;
        Ok(rv3(x - y))
    });
    e.register("vscale", |_, a| {
        if a.len() != 2 {
            return Err("usage: vscale(v, s)".into());
        }
        Ok(rv3(v3(&a[0], "v")? * f(&a[1], "s")?))
    });
    e.register("vlen", |_, a| Ok(RV::Float(v3(a.first().ok_or("usage: vlen(v)")?, "v")?.length() as f64)));
    e.register("vnorm", |_, a| Ok(rv3(v3(a.first().ok_or("usage: vnorm(v)")?, "v")?.normalize_or_zero())));
    e.register("vdot", |_, a| {
        let (x, y) = two_vecs(a, "vdot(a, b)")?;
        Ok(RV::Float(x.dot(y) as f64))
    });
    e.register("vcross", |_, a| {
        let (x, y) = two_vecs(a, "vcross(a, b)")?;
        Ok(rv3(x.cross(y)))
    });
    e.register("distance", |_, a| {
        let (x, y) = two_vecs(a, "distance(a, b)")?;
        Ok(RV::Float(x.distance(y) as f64))
    });
    e.register("lerp", |_, a| {
        if a.len() != 3 {
            return Err("usage: lerp(a, b, t)".into());
        }
        let t = f(&a[2], "t")?;
        if matches!(a[0], RV::Array(_) | RV::Vec3(_)) {
            Ok(rv3(v3(&a[0], "a")?.lerp(v3(&a[1], "b")?, t)))
        } else {
            let (x, y) = (f(&a[0], "a")?, f(&a[1], "b")?);
            Ok(RV::Float((x + (y - x) * t) as f64))
        }
    });
    e.register("randf", |c, _| {
        let x = next_rand(world(c)?);
        Ok(RV::Float((x >> 11) as f64 / (1u64 << 53) as f64))
    });
    e.register("randi_range", |c, a| {
        if a.len() != 2 {
            return Err("usage: randi_range(a, b)".into());
        }
        let (x, y) = (f(&a[0], "a")? as i64, f(&a[1], "b")? as i64);
        let (lo, hi) = (x.min(y), x.max(y));
        let span = (hi - lo + 1) as u64;
        let r = next_rand(world(c)?);
        Ok(RV::Int(lo + (r % span) as i64))
    });
    e.register("clampf", |_, a| {
        if a.len() != 3 {
            return Err("usage: clampf(x, lo, hi)".into());
        }
        let (x, lo, hi) = (f(&a[0], "x")?, f(&a[1], "lo")?, f(&a[2], "hi")?);
        Ok(RV::Float(x.max(lo).min(hi.max(lo)) as f64))
    });
}

// ---------------------------------------------------------------- misc

fn misc(e: &mut Engine) {
    e.register("send_message", |c, a| {
        let w = world(c)?;
        let name = s(a.first().ok_or("usage: send_message(name, value)")?, "name")?.to_string();
        let value = a.get(1).map(value_of_rv).transpose()?.unwrap_or(logic_core::Value::Null);
        match w.get_resource_mut::<Messages<crate::logic::LogicMessage>>() {
            Some(mut m) => {
                m.write(crate::logic::LogicMessage { name, value });
                Ok(RV::Void)
            }
            None => Err("send_message: the logic plugin is not running".into()),
        }
    });
    e.register("command", |c, a| {
        let w = world(c)?;
        let id = s(a.first().ok_or("usage: command(id, json_text)")?, "id")?;
        let params = match a.get(1) {
            Some(RV::Str(t)) if !t.trim().is_empty() => serde_json::from_str(t).map_err(|e| format!("command: bad JSON: {e}"))?,
            Some(RV::Str(_)) | None => serde_json::Value::Null,
            Some(other) => return Err(format!("command params must be JSON text (str), got {}", other.type_name())),
        };
        let out = crate::logic::run_command(w, id, &params)?;
        Ok(RV::Str(out.to_string()))
    });
}
