//! Node scripts for the editor (the `script_*` methods of
//! [`EditorBackend`](editor_proto::EditorBackend)): what the Details Script section and the
//! Signals panel show about an entity (members, functions, signals, resolved connections),
//! creating a script file, the relative node path of a connection, and the method stub appended
//! to the target's script. Everything reads the script *source* (parse only, nothing runs), so
//! it works in edit mode. The data itself (`Script`, `ScriptProps`, `Groups`, `Connections`) is
//! ordinary reflected components edited with `SetComponent`. UI side: `crates/editor-ui/src/node_script.rs`.

use std::path::PathBuf;

use bevy::prelude::*;
use editor_proto::*;

use super::backend::{WorldBackend, resolve};
use crate::paths::AssetsDir;
use crate::scripting::{Connections, Script, ScriptTimer, key_of, tree};

fn root(world: &World) -> Result<PathBuf, String> {
    world.get_resource::<AssetsDir>().map(|a| a.0.clone()).ok_or_else(|| "no assets folder".to_string())
}

/// The node path from `from` to `to`: `.`, `..`, `../HUD`, `Child/Grand`, or absolute
/// (`/Root/Child`) when they share no ancestor. Errors when a segment has no name or the path
/// would not resolve back to `to` (same-named siblings).
pub fn relative_path(world: &World, from: Entity, to: Entity) -> Result<String, String> {
    let chain = |mut e: Entity| {
        let mut v = vec![e];
        while let Some(p) = world.get::<ChildOf>(e) {
            e = p.parent();
            v.push(e);
            if v.len() > 256 {
                break;
            }
        }
        v.reverse();
        v
    };
    let (a, b) = (chain(from), chain(to));
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let name = |e: Entity| tree::name_of(world, e).map(str::to_string).ok_or_else(|| format!("{e} has no Name, so a path can't go through it"));
    let path = if common == 0 {
        let names: Result<Vec<String>, String> = b.iter().map(|e| name(*e)).collect();
        format!("/{}", names?.join("/"))
    } else {
        let mut parts: Vec<String> = vec!["..".into(); a.len() - common];
        for e in &b[common..] {
            parts.push(name(*e)?);
        }
        if parts.is_empty() { ".".into() } else { parts.join("/") }
    };
    match tree::resolve_path(world, from, &path) {
        Some(e) if e == to => Ok(path),
        _ => Err(format!("`{path}` does not lead back to the target (same-named nodes?); rename one of them")),
    }
}

/// `fn name(a, b) {\n}` stub text (ends with a newline).
pub fn stub_text(method: &str, params: &[String]) -> String {
    format!("\nfn {method}({}) {{\n}}\n", params.join(", "))
}

/// `src` with a stub for `method` appended, or `None` when the script already has the function.
pub fn append_stub(src: &str, method: &str, params: &[String]) -> Option<String> {
    if super::logic_backend::scan_functions(src).iter().any(|(n, _)| n == method) {
        return None;
    }
    let mut out = src.trim_end_matches('\n').to_string();
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&stub_text(method, params));
    Some(out)
}

pub use crate::scripting::meta::scan_defaults;

/// Names given to `signal("name")` anywhere in the source (comments skipped).
pub fn scan_signals(src: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for l in src.lines() {
        let l = l.split("//").next().unwrap_or("");
        let mut rest = l;
        while let Some(i) = rest.find("signal(") {
            rest = &rest[i + 7..];
            let t = rest.trim_start();
            if let Some(q) = t.chars().next().filter(|c| *c == '"' || *c == '\'')
                && let Some(end) = t[1..].find(q)
            {
                let n = t[1..1 + end].to_string();
                if !n.is_empty() && !out.contains(&n) {
                    out.push(n);
                }
            }
        }
    }
    out
}

/// A starter script: header comment, a member, `_ready` and `_process` stubs.
pub fn template_source(template: &str, name: &str) -> Option<String> {
    Some(match template {
        "" | "empty" => format!("// {name}: node script (docs/SCRIPTING.md)\n"),
        "node" | "default" => format!(
            "// {name}: node script (docs/SCRIPTING.md).\n// Top-level variables are members; set them per entity in the Details panel.\n// Declare signals with signal(\"name\"); connect them in the Node dock.\n\nspeed = 1;\n\nfn _ready() {{\n    // runs once, after the children are ready\n}}\n\nfn _process(delta) {{\n    // runs every frame\n}}\n"
        ),
        _ => return None,
    })
}

fn builtin_signals(world: &World, e: Entity) -> Vec<SignalDoc> {
    let s = |name: &str, doc: &str| SignalDoc { name: name.into(), builtin: true, doc: doc.into() };
    let mut v = vec![];
    let er = world.entity(e);
    if er.contains::<bevy::ui_widgets::Button>() {
        v.push(s("pressed", "The button was pressed"));
    }
    if er.contains::<bevy::picking::hover::Hovered>() {
        v.push(s("mouse_entered", "The pointer moved onto this control"));
        v.push(s("mouse_exited", "The pointer left this control"));
    }
    #[cfg(feature = "physics")]
    if er.contains::<avian3d::prelude::Collider>() {
        v.push(s("body_entered", "Another body started touching this one (argument: other)"));
        v.push(s("body_exited", "Another body stopped touching this one (argument: other)"));
    }
    if er.contains::<ScriptTimer>() {
        v.push(s("timeout", "The timer ran out"));
    }
    v
}

fn read_script(world: &World, path: &str) -> Option<String> {
    std::fs::read_to_string(root(world).ok()?.join(key_of(path))).ok()
}

fn member_hint(h: crate::scripting::meta::ExportHint) -> MemberHint {
    use crate::scripting::meta::ExportHint as H;
    match h {
        H::None => MemberHint::None,
        H::Range { min, max, step } => MemberHint::Range { min, max, step },
        H::Enum { options } => MemberHint::Enum { options },
        H::Color => MemberHint::Color,
        H::File { filter } => MemberHint::File { filter },
    }
}

fn fns_of(src: &str) -> Vec<ScriptFn> {
    ruspy::embed::outline(src).fns.into_iter().map(|(name, params)| ScriptFn { name, params }).collect()
}

impl WorldBackend<'_> {
    pub(super) fn script_info_impl(&mut self, id: EntityId) -> ScriptInfo {
        let Ok(e) = resolve(self.world, StableOrId::Id(id)) else { return ScriptInfo::default() };
        let path = self.world.get::<Script>(e).map(|s| s.path.clone()).unwrap_or_default();
        let src = (!path.is_empty()).then(|| read_script(self.world, &path)).flatten();
        let mut info = ScriptInfo { path, found: src.is_some(), signals: builtin_signals(self.world, e), ..default() };
        if let Some(src) = &src {
            let outline = ruspy::embed::outline(src);
            info.members = crate::scripting::meta::scan_props(src, &outline.vars)
                .into_iter()
                .map(|p| ScriptMember { name: p.name, default: p.default, hint: member_hint(p.hint), tooltip: p.tooltip })
                .collect();
            info.fns = fns_of(src);
            let mut declared = scan_signals(src);
            declared.extend(crate::scripting::declared_signals(self.world, e));
            for n in declared {
                if !info.signals.iter().any(|s| s.name == n) {
                    info.signals.push(SignalDoc { name: n, builtin: false, doc: "Declared by the script".into() });
                }
            }
        }
        let conns: Vec<_> = self.world.get::<Connections>(e).map(|c| c.0.clone()).unwrap_or_default();
        info.connections = conns
            .iter()
            .map(|c| {
                let target = tree::resolve_path(self.world, e, &c.target);
                let method_found = target
                    .and_then(|t| self.world.get::<Script>(t).map(|s| s.path.clone()))
                    .and_then(|p| read_script(self.world, &p))
                    .map(|s| fns_of(&s).iter().any(|f| f.name == c.method));
                ConnectionInfo { target_name: target.map(|t| tree::name_of(self.world, t).map(str::to_string).unwrap_or_else(|| format!("{t}"))), method_found }
            })
            .collect();
        info
    }

    pub(super) fn script_create_impl(&mut self, name: &str, template: &str) -> Result<String, String> {
        let stem: String = name.trim().trim_end_matches(".ruspy").chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
        if stem.is_empty() {
            return Err("give the script a name".into());
        }
        let text = template_source(template, &stem).ok_or_else(|| format!("unknown template `{template}`"))?;
        let rel = format!("scripts/{stem}.ruspy");
        let full = root(self.world)?.join(&rel);
        if full.exists() {
            return Err(format!("{rel} already exists"));
        }
        if let Some(dir) = full.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&full, text).map_err(|e| format!("{rel}: {e}"))?;
        Ok(rel)
    }

    pub(super) fn script_node_path_impl(&mut self, from: EntityId, to: EntityId) -> Result<String, String> {
        let a = resolve(self.world, StableOrId::Id(from))?;
        let b = resolve(self.world, StableOrId::Id(to))?;
        relative_path(self.world, a, b)
    }

    pub(super) fn script_add_stub_impl(&mut self, target: EntityId, method: &str, params: &[String]) -> Result<String, String> {
        if method.is_empty() || !method.chars().all(|c| c.is_alphanumeric() || c == '_') || method.starts_with(|c: char| c.is_ascii_digit()) {
            return Err(format!("`{method}` is not a valid function name"));
        }
        let e = resolve(self.world, StableOrId::Id(target))?;
        let path = self.world.get::<Script>(e).map(|s| s.path.clone()).filter(|p| !p.is_empty()).ok_or("the target has no script to add the method to")?;
        let full = root(self.world)?.join(key_of(&path));
        let src = std::fs::read_to_string(&full).map_err(|e| format!("{}: {e}", full.display()))?;
        let Some(out) = append_stub(&src, method, params) else { return Ok(path) };
        std::fs::write(&full, out).map_err(|e| format!("{}: {e}", full.display()))?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(w: &mut World, n: &str, parent: Option<Entity>) -> Entity {
        let e = w.spawn(Name::new(n.to_string())).id();
        if let Some(p) = parent {
            w.entity_mut(e).insert(ChildOf(p));
        }
        e
    }

    #[test]
    fn relative_paths_go_up_then_down() {
        let mut w = World::new();
        let game = named(&mut w, "Game", None);
        let hud = named(&mut w, "HUD", Some(game));
        let score = named(&mut w, "Score", Some(hud));
        let player = named(&mut w, "Player", Some(game));
        let gun = named(&mut w, "Gun", Some(player));
        assert_eq!(relative_path(&w, gun, score).unwrap(), "../../HUD/Score");
        assert_eq!(relative_path(&w, player, hud).unwrap(), "../HUD");
        assert_eq!(relative_path(&w, player, gun).unwrap(), "Gun");
        assert_eq!(relative_path(&w, player, player).unwrap(), ".");
        assert_eq!(relative_path(&w, gun, game).unwrap(), "../..");
        let other = named(&mut w, "Other", None);
        assert_eq!(relative_path(&w, gun, other).unwrap(), "/Other");
        assert_eq!(relative_path(&w, other, gun).unwrap(), "/Game/Player/Gun");
    }

    #[test]
    fn relative_paths_refuse_unnamed_and_ambiguous_nodes() {
        let mut w = World::new();
        let root = named(&mut w, "Root", None);
        let a = named(&mut w, "Same", Some(root));
        let b = named(&mut w, "Same", Some(root));
        let src = named(&mut w, "Src", Some(root));
        assert!(relative_path(&w, src, a).is_ok());
        assert!(relative_path(&w, src, b).is_err(), "second same-named sibling is unreachable by name");
        let anon = w.spawn(ChildOf(root)).id();
        assert!(relative_path(&w, src, anon).is_err());
    }

    #[test]
    fn stubs_are_appended_once() {
        let src = "x = 1;\nfn _ready() {\n}\n";
        let out = append_stub(src, "on_hit", &["who".into(), "dmg".into()]).unwrap();
        assert_eq!(out, "x = 1;\nfn _ready() {\n}\n\nfn on_hit(who, dmg) {\n}\n");
        assert!(append_stub(&out, "on_hit", &[]).is_none(), "an existing function is not duplicated");
        assert_eq!(append_stub("", "f", &[]).unwrap(), "\nfn f() {\n}\n");
    }

    #[test]
    fn defaults_and_signals_are_scanned_from_source() {
        let src = "speed = 5;\nname = \"hi\"; // c\nlist = [1, 2];\nrate = compute();\n  inner = 3;\nsignal(\"died\");\n// signal(\"no\")\nfn f() { signal('hurt'); a == b; }\n";
        let d = scan_defaults(src);
        assert_eq!(d[0], ("speed".into(), "5".into()));
        assert_eq!(d[1], ("name".into(), "\"hi\"".into()));
        assert_eq!(d[2], ("list".into(), "[1, 2]".into()));
        assert_eq!(d[3], ("rate".into(), String::new()));
        assert_eq!(d.len(), 4, "indented and `==` lines are not members");
        assert_eq!(scan_signals(src), vec!["died".to_string(), "hurt".to_string()]);
    }

    #[test]
    fn the_node_template_has_ready_and_process_stubs() {
        let t = template_source("node", "Boss").unwrap();
        assert!(t.starts_with("// Boss"));
        let f: Vec<String> = super::super::logic_backend::scan_functions(&t).into_iter().map(|(n, _)| n).collect();
        assert_eq!(f, vec!["_ready", "_process"]);
        assert!(template_source("nope", "x").is_none());
    }
}
