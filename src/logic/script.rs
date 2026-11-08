//! ruspy scripts: `assets/scripts/*.ruspy`, hot-reloaded by polling file times.
//!
//! Host functions a script can call: `self()`, `get(path)` / `get(entity, path)`,
//! `set(path, v)` / `set(entity, path, v)`, `command(id, json_text)`, `emit(name, v)`,
//! `log(text)`, `find(name)`. Entities are ints (`Entity::to_bits`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Instant, SystemTime};

use bevy::prelude::*;
use logic_core::Value;
use ruspy::embed::{Backend, Ctx, Engine, Module};
use ruspy::value::Value as RV;

use super::{LogicCtx, LogicDiagnostics, LogicOutbox, LogicStats, access, run_command};
use crate::paths::AssetsDir;

/// Prefix of a graph-level error message whose cause was already reported with its own
/// file/line/col (so it isn't listed twice).
pub(super) const REPORTED: &str = "\u{1}";

struct ModEntry {
    module: Option<Module>,
    mtime: Option<SystemTime>,
    path: PathBuf,
}

/// The script engine (non-send: ruspy values are `Rc`-based).
pub struct ScriptHost {
    engine: Engine,
    modules: HashMap<String, ModEntry>,
    last_poll: Option<Instant>,
}

impl ScriptHost {
    pub fn new() -> ScriptHost {
        let mut engine = Engine::new(Backend::Vm);
        engine.step_limit = 200_000;
        register(&mut engine);
        ScriptHost { engine, modules: HashMap::new(), last_poll: None }
    }
}

impl Default for ScriptHost {
    fn default() -> Self {
        Self::new()
    }
}

/// `score.ruspy` and `scripts/score.ruspy` both mean `<assets>/scripts/score.ruspy`.
fn key_of(file: &str) -> String {
    if file.contains('/') { file.to_string() } else { format!("scripts/{file}") }
}

pub(crate) fn rv_of(v: &Value) -> RV {
    match v {
        Value::Null => RV::Null,
        Value::Bool(b) => RV::Bool(*b),
        Value::Num(n) => num(*n),
        Value::Str(s) => RV::Str(s.to_string()),
        Value::Vec3(a) => RV::array(a.iter().map(|x| RV::Float(*x as f64)).collect()),
        Value::Entity(e) => RV::Int(*e as i64),
        Value::Json(j) => rv_of_json(j),
    }
}

fn num(n: f64) -> RV {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { RV::Int(n as i64) } else { RV::Float(n) }
}

fn rv_of_json(j: &serde_json::Value) -> RV {
    use serde_json::Value as J;
    match j {
        J::Null => RV::Null,
        J::Bool(b) => RV::Bool(*b),
        J::Number(n) => num(n.as_f64().unwrap_or(0.0)),
        J::String(s) => RV::Str(s.clone()),
        J::Array(a) => RV::array(a.iter().map(rv_of_json).collect()),
        J::Object(_) => RV::Str(j.to_string()),
    }
}

pub(crate) fn json_of_rv(v: &RV) -> Result<serde_json::Value, String> {
    use serde_json::Value as J;
    Ok(match v {
        RV::Int(i) => J::from(*i),
        RV::Float(f) => serde_json::Number::from_f64(*f).map_or(J::Null, J::Number),
        RV::Bool(b) => J::Bool(*b),
        RV::Str(s) => J::String(s.clone()),
        RV::Char(c) => J::String(c.to_string()),
        RV::Null | RV::Void => J::Null,
        RV::Array(a) => J::Array(a.borrow().iter().map(json_of_rv).collect::<Result<_, _>>()?),
        RV::Struct(..) => return Err("structs can't be passed to the game".into()),
    })
}

pub(crate) fn value_of_rv(v: &RV) -> Result<Value, String> {
    Ok(match v {
        RV::Int(i) => Value::Num(*i as f64),
        RV::Float(f) => Value::Num(*f),
        RV::Bool(b) => Value::Bool(*b),
        RV::Str(s) => Value::text(s),
        RV::Null | RV::Void => Value::Null,
        other => Value::from_json(&json_of_rv(other)?),
    })
}

fn world<'a>(c: &'a mut Ctx) -> Result<&'a mut World, String> {
    c.state::<World>().ok_or_else(|| "no world".to_string())
}

fn entity_arg(v: &RV) -> Result<Entity, String> {
    match v {
        RV::Int(i) => Entity::try_from_bits(*i as u64).ok_or_else(|| format!("bad entity {i}")),
        RV::Null => Err("entity is null (no entity)".into()),
        other => Err(format!("expected an entity (int), got {}", other.type_name())),
    }
}

fn str_arg<'a>(a: &'a [RV], i: usize, what: &str) -> Result<&'a str, String> {
    match a.get(i) {
        Some(RV::Str(s)) => Ok(s),
        _ => Err(format!("{what} must be a str")),
    }
}

/// The entity named `name` (first match).
pub(crate) fn find_named(w: &mut World, name: &str) -> Option<Entity> {
    let mut q = w.query::<(Entity, &Name)>();
    q.iter(w).find(|(_, n)| n.as_str() == name).map(|(e, _)| e)
}

fn me(w: &World) -> Entity {
    w.resource::<LogicCtx>().me
}

fn register(e: &mut Engine) {
    e.register("self", |c, _| Ok(RV::Int(me(world(c)?).to_bits() as i64)));
    e.register("get", |c, a| {
        let w = world(c)?;
        let (ent, path) = match a {
            [_] => (me(w), str_arg(a, 0, "path")?),
            [e, _] => (entity_arg(e)?, str_arg(a, 1, "path")?),
            _ => return Err("get(path) or get(entity, path)".into()),
        };
        Ok(rv_of(&access::get_path(w, ent, path)?))
    });
    e.register("set", |c, a| {
        let w = world(c)?;
        let (ent, path, v) = match a {
            [_, v] => (me(w), str_arg(a, 0, "path")?, v),
            [e, _, v] => (entity_arg(e)?, str_arg(a, 1, "path")?, v),
            _ => return Err("set(path, value) or set(entity, path, value)".into()),
        };
        access::set_path(w, ent, path, &value_of_rv(v)?)?;
        Ok(RV::Void)
    });
    e.register("command", |c, a| {
        let w = world(c)?;
        let id = str_arg(a, 0, "id")?.to_string();
        let params: serde_json::Value = match a.get(1) {
            None | Some(RV::Null) => serde_json::json!({}),
            Some(RV::Str(s)) => serde_json::from_str(s).map_err(|e| format!("params aren't JSON: {e}"))?,
            Some(other) => json_of_rv(other)?,
        };
        let r = run_command(w, &id, &params)?;
        Ok(RV::Str(r.to_string()))
    });
    e.register("emit", |c, a| {
        let w = world(c)?;
        let name = str_arg(a, 0, "name")?.to_string();
        let v = a.get(1).map(value_of_rv).transpose()?.unwrap_or(Value::Null);
        w.resource_mut::<LogicOutbox>().0.push((name, v));
        Ok(RV::Void)
    });
    e.register("log", |c, a| {
        let w = world(c)?;
        let text = a.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" ");
        info!("[script] {text}");
        w.resource_mut::<LogicDiagnostics>().log(text);
        Ok(RV::Void)
    });
    e.register("find", |c, a| {
        let w = world(c)?;
        let name = str_arg(a, 0, "name")?;
        Ok(find_named(w, name).map_or(RV::Null, |e| RV::Int(e.to_bits() as i64)))
    });
}

/// Runs `f` with the script host taken out of the world (it needs `&mut World` itself).
fn with_host<R>(world: &mut World, f: impl FnOnce(&mut ScriptHost, &mut World) -> R) -> Result<R, String> {
    let Some(mut host) = world.remove_non_send::<ScriptHost>() else {
        return Err("script engine is busy (a script ran a command that ran a script)".into());
    };
    let r = f(&mut host, world);
    world.insert_non_send(host);
    Ok(r)
}

/// (Re)loads `key` from disk; load errors become diagnostics and keep the old module.
fn load(host: &mut ScriptHost, world: &mut World, key: &str) {
    let root = world.get_resource::<AssetsDir>().map(|a| a.0.clone()).unwrap_or_else(|| PathBuf::from("assets"));
    let path = root.join(key);
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let entry = host.modules.entry(key.to_string()).or_insert(ModEntry { module: None, mtime: None, path: path.clone() });
    entry.mtime = mtime;
    entry.path = path.clone();
    let src = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            world.resource_mut::<LogicDiagnostics>().error(key, 0, 0, None, format!("can't read {}: {e}", path.display()));
            return;
        }
    };
    host.engine.backend = Backend::Vm;
    let mut r = host.engine.load(key, &src, world);
    if matches!(&r, Err(errs) if errs.iter().any(|e| e.code == "E0900")) {
        host.engine.backend = Backend::Interpreter;
        r = host.engine.load(key, &src, world);
    }
    let mut diags = world.resource_mut::<LogicDiagnostics>();
    diags.clear_file(key);
    match r {
        Ok(m) => {
            if let Some(entry) = host.modules.get_mut(key) {
                entry.module = Some(m);
            }
        }
        Err(errs) => {
            for e in errs {
                diags.error(key, e.line as u32, e.col as u32, None, format!("[{}] {}", e.code, e.message));
            }
        }
    }
}

/// Calls `function` in `file` with `args`.
pub(super) fn call(world: &mut World, file: &str, function: &str, args: &[Value]) -> Result<Value, String> {
    let key = key_of(file);
    with_host(world, |host, world| {
        if !host.modules.contains_key(&key) {
            load(host, world, &key);
        }
        let Some(m) = host.modules.get(&key).and_then(|e| e.module) else {
            return Err(format!("{REPORTED}script {key} isn't loaded (see diagnostics)"));
        };
        if !host.engine.has_fn(m, function) {
            return Err(format!("script {key} has no function `{function}`"));
        }
        let started = Instant::now();
        let r = host.engine.call(m, function, args.iter().map(rv_of).collect(), world);
        let us = started.elapsed().as_secs_f64() * 1e6;
        let mut stats = world.resource_mut::<LogicStats>();
        stats.script_calls += 1;
        stats.script_us += us;
        match r {
            Ok(v) => value_of_rv(&v),
            Err(e) => {
                let msg = format!("[{}] {}", e.code, e.message);
                world.resource_mut::<LogicDiagnostics>().error(&key, e.line as u32, e.col as u32, None, msg);
                Err(format!("{REPORTED}{key}:{}:{}: {}", e.line, e.col, e.message))
            }
        }
    })?
}

/// Loads new and changed scripts (twice a second, wall clock).
pub(super) fn poll_scripts(world: &mut World) {
    let Some(host) = world.get_non_send::<ScriptHost>() else { return };
    if host.last_poll.is_some_and(|t| t.elapsed().as_secs_f32() < 0.5) {
        return;
    }
    let root = world.get_resource::<AssetsDir>().map(|a| a.0.clone()).unwrap_or_else(|| PathBuf::from("assets"));
    let mut stale: Vec<String> = Vec::new();
    {
        let host = world.non_send::<ScriptHost>();
        if let Ok(dir) = std::fs::read_dir(root.join("scripts")) {
            for f in dir.flatten() {
                let p = f.path();
                if p.extension().is_none_or(|x| x != "ruspy") {
                    continue;
                }
                let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
                let key = format!("scripts/{name}");
                let mtime = f.metadata().and_then(|m| m.modified()).ok();
                if host.modules.get(&key).is_none_or(|e| e.mtime != mtime) {
                    stale.push(key);
                }
            }
        }
    }
    let _ = with_host(world, |host, world| {
        host.last_poll = Some(Instant::now());
        for key in &stale {
            load(host, world, key);
        }
    });
}

/// Forgets nothing but forces a reload of every script on the next poll.
pub(super) fn reload_all(world: &mut World) -> usize {
    let mut n = 0;
    let _ = with_host(world, |host, world| {
        let keys: Vec<String> = host.modules.keys().cloned().collect();
        n = keys.len();
        for k in keys {
            load(host, world, &k);
        }
        host.last_poll = None;
    });
    n
}

/// Reloads one script from disk now (its errors land in the diagnostics). For the editor.
#[cfg(feature = "editor")]
pub(crate) fn reload_script(world: &mut World, key: &str) {
    let key = key_of(key);
    let _ = with_host(world, |host, world| load(host, world, &key));
}
