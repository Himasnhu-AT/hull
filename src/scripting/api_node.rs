//! Tree, spawn, transform and render host functions. `[n,]` is the optional leading node
//! (`self` when omitted).
//!
//! | Function | Does |
//! |---|---|
//! | `spawn_node(name [, parent])` | new entity with `Name`, `Transform`, `Visibility` |
//! | `add_child(parent, child)`, `reparent(child, parent)` | change the parent (`null` = make a root) |
//! | `set_name([n,] name)`, `attach_script([n,] path)` | rename; add a `Script` |
//! | `instantiate(scene [, parent])` | spawn a `.level.ron` as new entities, returns its first root |
//! | `change_scene(path)` | load a level at frame end |
//! | `get_position/set_position/translate`, `get_global_position` | local / world position |
//! | `get_rotation/set_rotation` | euler XYZ radians; `rotate_x/y/z([n,] rad)`, `look_at([n,] target)` |
//! | `get_scale/set_scale` | local scale |
//! | `set_visible([n,] bool)`, `is_visible([n])` | `Visibility` |
//! | `set_color([n,] [r,g,b(,a)])` | `Primitive` color, own copy of the material, or UI `BackgroundColor` |

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{b, ent, f, live, rent, rv3, s, split, v3, world};
use super::{Script, ScriptQueue};

/// Marks entities whose `StandardMaterial` was cloned for them by `set_color`.
#[derive(Component)]
struct OwnMaterial;

fn opt_ent(v: Option<&RV>) -> Result<Option<Entity>, String> {
    match v {
        None | Some(RV::Null) => Ok(None),
        Some(x) => Ok(Some(ent(x)?)),
    }
}

fn is_ancestor(w: &World, anc: Entity, mut e: Entity) -> bool {
    for _ in 0..256 {
        if e == anc {
            return true;
        }
        match w.get::<ChildOf>(e) {
            Some(p) => e = p.parent(),
            None => return false,
        }
    }
    true
}

fn reparent(w: &mut World, child: Entity, parent: Option<Entity>) -> Result<(), String> {
    match parent {
        Some(p) => {
            if is_ancestor(w, child, p) {
                return Err("reparent: a node cannot become its own descendant".into());
            }
            w.entity_mut(child).insert(ChildOf(p));
        }
        None => {
            w.entity_mut(child).remove::<ChildOf>();
        }
    }
    Ok(())
}

fn tf(w: &World, e: Entity) -> Result<&Transform, String> {
    w.get::<Transform>(e).ok_or_else(|| format!("entity {e} has no Transform"))
}

fn tf_mut(w: &mut World, e: Entity) -> Result<Mut<'_, Transform>, String> {
    w.get_mut::<Transform>(e).ok_or_else(|| format!("entity {e} has no Transform"))
}

fn color_of(v: &RV) -> Result<Color, String> {
    if let RV::Array(a) = v {
        let a = a.borrow();
        if a.len() == 3 || a.len() == 4 {
            let al = if a.len() == 4 { f(&a[3], "alpha")? } else { 1.0 };
            return Ok(Color::srgba(f(&a[0], "r")?, f(&a[1], "g")?, f(&a[2], "b")?, al));
        }
    }
    Err("color must be [r, g, b] or [r, g, b, a] (0..1)".into())
}

#[cfg(feature = "level")]
fn instantiate(w: &mut World, path: &str, parent: Option<Entity>) -> Result<Option<Entity>, String> {
    use crate::level::file;
    let p = crate::level::resolve(w, std::path::Path::new(path));
    let text = std::fs::read_to_string(&p).map_err(|e| format!("instantiate: {}: {e}", p.display()))?;
    let mut server = w.get_resource::<AssetServer>().cloned().ok_or("instantiate: no AssetServer")?;
    let registry = w.resource::<AppTypeRegistry>().clone();
    let parsed = {
        let migrations = w.resource::<crate::level::LevelMigrations>();
        file::parse(&text, &registry.read(), &mut server, migrations).map_err(|e| format!("instantiate {path}: {e}"))?
    };
    let spawned = file::spawn_instance(w, &parsed, parent).map_err(|e| format!("instantiate {path}: {e}"))?;
    Ok(spawned.into_iter().find(|e| w.get::<ChildOf>(*e).map(|c| c.parent()) == parent))
}

pub(super) fn register(e: &mut Engine) {
    tree(e);
    transform(e);
    render(e);
}

fn tree(e: &mut Engine) {
    e.register("spawn_node", |c, a| {
        let w = world(c)?;
        let name = s(a.first().ok_or("usage: spawn_node(name [, parent])")?, "name")?.to_string();
        let parent = opt_ent(a.get(1))?;
        if let Some(p) = parent {
            live(w, p)?;
        }
        let id = w.spawn((Name::new(name), Transform::default(), Visibility::default())).id();
        if let Some(p) = parent {
            w.entity_mut(id).insert(ChildOf(p));
        }
        Ok(rent(id))
    });
    e.register("add_child", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: add_child(parent, child)".into());
        }
        let (p, ch) = (live(w, ent(&a[0])?)?, live(w, ent(&a[1])?)?);
        reparent(w, ch, Some(p))?;
        Ok(RV::Void)
    });
    e.register("reparent", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: reparent(child, new_parent)".into());
        }
        let ch = live(w, ent(&a[0])?)?;
        let p = opt_ent(a.get(1))?.map(|p| live(w, p)).transpose()?;
        reparent(w, ch, p)?;
        Ok(RV::Void)
    });
    e.register("set_name", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_name([node,] name)")?;
        w.entity_mut(t).insert(Name::new(s(&r[0], "name")?.to_string()));
        Ok(RV::Void)
    });
    e.register("attach_script", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "attach_script([node,] path)")?;
        let p = s(&r[0], "path")?;
        // A `class_name` instead of a path.
        let path = if !p.contains(['/', '.']) { super::resolve_class(w, p).ok_or_else(|| format!("attach_script: no class_name `{p}`"))? } else { p.to_string() };
        w.entity_mut(t).insert(Script::new(path));
        Ok(RV::Void)
    });
    e.register("instantiate", |c, a| {
        let w = world(c)?;
        let path = s(a.first().ok_or("usage: instantiate(scene_path [, parent])")?, "scene_path")?.to_string();
        let parent = opt_ent(a.get(1))?.map(|p| live(w, p)).transpose()?;
        #[cfg(feature = "level")]
        {
            Ok(super::api::ropt(instantiate(w, &path, parent)?))
        }
        #[cfg(not(feature = "level"))]
        {
            let _ = (w, path, parent);
            Err("instantiate needs the `level` feature".into())
        }
    });
    e.register("change_scene", |c, a| {
        let w = world(c)?;
        let path = s(a.first().ok_or("usage: change_scene(path)")?, "path")?.to_string();
        w.resource_mut::<ScriptQueue>().change_scene = Some(path);
        Ok(RV::Void)
    });
}

fn transform(e: &mut Engine) {
    e.register("get_position", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_position([node])")?;
        Ok(rv3(tf(w, t)?.translation))
    });
    e.register("set_position", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_position([node,] v)")?;
        let v = v3(&r[0], "position")?;
        tf_mut(w, t)?.translation = v;
        Ok(RV::Void)
    });
    e.register("get_global_position", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_global_position([node])")?;
        let g = w.get::<GlobalTransform>(t).ok_or_else(|| format!("entity {t} has no GlobalTransform"))?;
        Ok(rv3(g.translation()))
    });
    e.register("translate", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "translate([node,] v)")?;
        let v = v3(&r[0], "offset")?;
        tf_mut(w, t)?.translation += v;
        Ok(RV::Void)
    });
    e.register("get_rotation", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_rotation([node])")?;
        let (x, y, z) = tf(w, t)?.rotation.to_euler(EulerRot::XYZ);
        Ok(rv3(Vec3::new(x, y, z)))
    });
    e.register("set_rotation", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_rotation([node,] [x, y, z])")?;
        let v = v3(&r[0], "rotation")?;
        tf_mut(w, t)?.rotation = Quat::from_euler(EulerRot::XYZ, v.x, v.y, v.z);
        Ok(RV::Void)
    });
    e.register("rotate_x", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "rotate_x([node,] radians)")?;
        let x = f(&r[0], "angle")?;
        tf_mut(w, t)?.rotate_x(x);
        Ok(RV::Void)
    });
    e.register("rotate_y", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "rotate_y([node,] radians)")?;
        let x = f(&r[0], "angle")?;
        tf_mut(w, t)?.rotate_y(x);
        Ok(RV::Void)
    });
    e.register("rotate_z", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "rotate_z([node,] radians)")?;
        let x = f(&r[0], "angle")?;
        tf_mut(w, t)?.rotate_z(x);
        Ok(RV::Void)
    });
    e.register("look_at", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "look_at([node,] target)")?;
        let target = v3(&r[0], "target")?;
        tf_mut(w, t)?.look_at(target, Vec3::Y);
        Ok(RV::Void)
    });
    e.register("get_scale", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_scale([node])")?;
        Ok(rv3(tf(w, t)?.scale))
    });
    e.register("set_scale", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_scale([node,] v)")?;
        let v = v3(&r[0], "scale")?;
        tf_mut(w, t)?.scale = v;
        Ok(RV::Void)
    });
}

fn render(e: &mut Engine) {
    e.register("set_visible", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_visible([node,] bool)")?;
        let on = b(&r[0], "visible")?;
        w.entity_mut(t).insert(if on { Visibility::Inherited } else { Visibility::Hidden });
        Ok(RV::Void)
    });
    e.register("is_visible", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "is_visible([node])")?;
        Ok(RV::Bool(w.get::<Visibility>(t).is_none_or(|v| *v != Visibility::Hidden)))
    });
    e.register("set_color", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_color([node,] [r, g, b(, a)])")?;
        let col = color_of(&r[0])?;
        apply_color(w, t, col)?;
        Ok(RV::Void)
    });
}

/// `set_color` semantics for any caller (tweens): Primitive, own material copy, or UI background.
pub(super) fn apply_color(w: &mut World, t: Entity, col: Color) -> Result<(), String> {
    #[cfg(feature = "level")]
    if let Some(mut p) = w.get_mut::<crate::level::Primitive>(t) {
        p.color = col;
        return Ok(());
    }
    if let Some(h) = w.get::<MeshMaterial3d<StandardMaterial>>(t).map(|m| m.0.clone()) {
        let own = w.entity(t).contains::<OwnMaterial>();
        let mut assets = w.get_resource_mut::<Assets<StandardMaterial>>().ok_or("set_color: no material assets")?;
        if own {
            if let Some(mut m) = assets.get_mut(&h) {
                m.base_color = col;
            }
        } else {
            let mut m = assets.get(&h).cloned().ok_or("set_color: material not loaded")?;
            m.base_color = col;
            let nh = assets.add(m);
            w.entity_mut(t).insert((MeshMaterial3d(nh), OwnMaterial));
        }
        return Ok(());
    }
    if let Some(mut bg) = w.get_mut::<BackgroundColor>(t) {
        bg.0 = col;
        return Ok(());
    }
    Err(format!("set_color: entity {t} has no Primitive, StandardMaterial or BackgroundColor"))
}

/// The color `apply_color` would change.
pub(super) fn read_color(w: &World, t: Entity) -> Option<Color> {
    #[cfg(feature = "level")]
    if let Some(p) = w.get::<crate::level::Primitive>(t) {
        return Some(p.color);
    }
    if let Some(h) = w.get::<MeshMaterial3d<StandardMaterial>>(t) {
        return w.get_resource::<Assets<StandardMaterial>>()?.get(&h.0).map(|m| m.base_color);
    }
    w.get::<BackgroundColor>(t).map(|b| b.0)
}
