//! Node paths over the `ChildOf` hierarchy and `Name` (Godot `NodePath` / `get_node`).
//!
//! | Path | Means |
//! |---|---|
//! | `""`, `.` | the entity itself |
//! | `..` | its parent |
//! | `Child/Grandchild` | children by `Name`, one level per segment |
//! | `../Sibling` | segments combine |
//! | `/Name/Child` | a root entity (no parent) named `Name`, then down |
//! | `%Name` | the first entity named `Name` under this entity's root (Godot scene-unique name), else anywhere |
//! | `#<bits>` | an entity by id (`Entity::to_bits`), what `connect()` stores for runtime targets |

use bevy::prelude::*;

/// Resolves `path` from `from`; `None` if any segment is missing.
pub fn resolve_path(world: &World, from: Entity, path: &str) -> Option<Entity> {
    let path = path.trim();
    if let Some(bits) = path.strip_prefix('#') {
        let e = Entity::try_from_bits(bits.parse().ok()?)?;
        return world.get_entity(e).is_ok().then_some(e);
    }
    if let Some(name) = path.strip_prefix('%') {
        let root = root_of(world, from);
        let mut sub = vec![];
        descendants(world, root, &mut sub);
        if let Some(e) = sub.into_iter().find(|e| name_of(world, *e) == Some(name)) {
            return Some(e);
        }
        return find_named(world, name);
    }
    let (mut cur, rest) = match path.strip_prefix('/') {
        Some(rest) => {
            let (first, rest) = rest.split_once('/').unwrap_or((rest, ""));
            let first = if first == "root" && !rest.is_empty() {
                // `/root/Name/...` (Godot spelling) == `/Name/...`
                let (f2, r2) = rest.split_once('/').unwrap_or((rest, ""));
                return find_root(world, f2).and_then(|r| walk(world, r, r2));
            } else {
                first
            };
            (find_root(world, first)?, rest)
        }
        None => (from, path),
    };
    if world.get_entity(cur).is_err() {
        return None;
    }
    cur = walk(world, cur, rest)?;
    Some(cur)
}

fn walk(world: &World, mut cur: Entity, rest: &str) -> Option<Entity> {
    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => cur = world.get::<ChildOf>(cur)?.parent(),
            name => cur = child_named(world, cur, name)?,
        }
    }
    Some(cur)
}

/// `get_node` with a readable error.
pub fn get_node(world: &World, from: Entity, path: &str) -> Result<Entity, String> {
    resolve_path(world, from, path).ok_or_else(|| format!("node `{path}` not found from {}", describe(world, from)))
}

pub fn name_of(world: &World, e: Entity) -> Option<&str> {
    world.get::<Name>(e).map(|n| n.as_str())
}

pub fn describe(world: &World, e: Entity) -> String {
    match name_of(world, e) {
        Some(n) => format!("`{n}` ({e})"),
        None => format!("{e}"),
    }
}

pub fn child_named(world: &World, parent: Entity, name: &str) -> Option<Entity> {
    world.get::<Children>(parent)?.iter().find(|c| name_of(world, *c) == Some(name))
}

pub fn root_of(world: &World, mut e: Entity) -> Entity {
    let mut n = 0;
    while let Some(p) = world.get::<ChildOf>(e) {
        e = p.parent();
        n += 1;
        if n > 256 {
            break;
        }
    }
    e
}

fn find_root(world: &World, name: &str) -> Option<Entity> {
    let mut found = None;
    for e in world.iter_entities() {
        if e.get::<Name>().is_some_and(|n| n.as_str() == name) {
            if !e.contains::<ChildOf>() {
                return Some(e.id());
            }
            found.get_or_insert(e.id());
        }
    }
    found
}

/// The first entity named `name` anywhere.
pub fn find_named(world: &World, name: &str) -> Option<Entity> {
    world.iter_entities().find(|e| e.get::<Name>().is_some_and(|n| n.as_str() == name)).map(|e| e.id())
}

/// Every descendant of `e`, parents before children (pre-order).
pub fn descendants(world: &World, e: Entity, out: &mut Vec<Entity>) {
    if let Some(ch) = world.get::<Children>(e) {
        for c in ch.iter() {
            out.push(c);
            descendants(world, c, out);
        }
    }
}

/// The path of `e` from the top: `/Root/Child/e` (unnamed segments as `#bits`).
pub fn path_of(world: &World, e: Entity) -> String {
    let mut parts = vec![];
    let mut cur = Some(e);
    while let Some(c) = cur {
        parts.push(name_of(world, c).map(str::to_string).unwrap_or_else(|| format!("#{}", c.to_bits())));
        cur = world.get::<ChildOf>(c).map(|p| p.parent());
        if parts.len() > 256 {
            break;
        }
    }
    parts.reverse();
    format!("/{}", parts.join("/"))
}
