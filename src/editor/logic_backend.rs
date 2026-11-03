//! Logic graphs for the editor (`editor.logic.*`, the `logic_*` methods of
//! [`EditorBackend`](editor_proto::EditorBackend)): list / read / validate / write / create graph
//! files, the node catalogue (logic-core kinds + control commands + ruspy functions), attach to
//! an entity, fire an event with an execution trace. Files live under the assets folder:
//! `logic/*.logic.ron` and `scripts/*.ruspy`. UI side: `crates/editor-ui/src/logic/`.

use std::path::{Path, PathBuf};

use bevy::prelude::*;
use editor_proto::*;
use serde_json::{Value, json};

use super::backend::{WorldBackend, read_component, resolve};
use crate::logic::logic_core as lc;
use crate::paths::AssetsDir;

fn root(world: &World) -> Result<PathBuf, String> {
    world.get_resource::<AssetsDir>().map(|a| a.0.clone()).ok_or_else(|| "no assets folder".to_string())
}

/// `door.logic.ron` / `logic/door.logic.ron` and `score.ruspy` / `scripts/score.ruspy` → the
/// asset path; anything else (absolute, `..`, other extensions) is refused.
pub fn asset_path(path: &str) -> Result<String, String> {
    if path.starts_with('/') || path.contains("..") || path.contains('\\') {
        return Err(format!("`{path}` is not an assets-relative path"));
    }
    if path.ends_with(".logic.ron") {
        Ok(if path.starts_with("logic/") { path.into() } else { format!("logic/{path}") })
    } else if path.ends_with(".ruspy") {
        Ok(if path.starts_with("scripts/") { path.into() } else { format!("scripts/{path}") })
    } else {
        Err(format!("`{path}`: only .logic.ron and .ruspy files can be edited here"))
    }
}

fn walk(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, ext, out);
        } else if p.to_string_lossy().ends_with(ext) {
            out.push(p);
        }
    }
}

/// `fn name(a, b)` declarations of a ruspy source: `(name, args)`.
pub fn scan_functions(src: &str) -> Vec<(String, Vec<String>)> {
    src.lines()
        .filter_map(|l| {
            let l = l.trim_start().strip_prefix("fn ")?;
            let (name, rest) = l.split_once('(')?;
            let (args, _) = rest.split_once(')')?;
            let name = name.trim();
            if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                return None;
            }
            Some((name.to_string(), args.split(',').map(|a| a.trim().split([':', ' ']).next().unwrap_or("").to_string()).filter(|a| !a.is_empty()).collect()))
        })
        .collect()
}

fn catalog(world: &World) -> lc::Catalog {
    let mut cat = lc::Catalog::default();
    if let Ok(root) = root(world) {
        let mut files = Vec::new();
        walk(&root.join("scripts"), ".ruspy", &mut files);
        files.sort();
        for f in files {
            let file = f.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let fns = std::fs::read_to_string(&f).map(|s| scan_functions(&s)).unwrap_or_default();
            if fns.is_empty() {
                cat.scripts.push(lc::ScriptFn { file: file.clone(), function: String::new(), args: vec![] });
            }
            cat.scripts.extend(fns.into_iter().map(|(function, args)| lc::ScriptFn { file: file.clone(), function, args }));
        }
    }
    cat.commands = commands(world).into_iter().map(|c| c.name).collect();
    cat
}

fn schema_of_json(ty: &str) -> TypeSchema {
    match ty {
        "string" => TypeSchema::String,
        "number" => TypeSchema::Float { min: None, max: None, step: None },
        "integer" => TypeSchema::Int { min: None, max: None },
        "boolean" => TypeSchema::Bool,
        _ => TypeSchema::Opaque,
    }
}

/// Instant control commands a graph can run (editor commands excluded).
fn commands(world: &World) -> Vec<CommandDoc> {
    use crate::devtools::control::Handler;
    let Some(reg) = world.get_resource::<crate::devtools::ControlRegistry>() else { return Vec::new() };
    reg.iter()
        .filter(|c| !c.id.starts_with("editor.") && matches!(c.handler, Handler::Instant(_)))
        .map(|c| {
            let props = c.params_schema.get("properties").and_then(Value::as_object);
            let fields: Vec<(String, TypeSchema)> = props.map(|p| p.iter().map(|(k, v)| (k.clone(), schema_of_json(v.get("type").and_then(Value::as_str).unwrap_or("")))).collect()).unwrap_or_default();
            let about: Vec<String> = props
                .map(|p| p.iter().map(|(k, v)| format!("{k}: {}", v.get("description").and_then(Value::as_str).unwrap_or(""))).collect())
                .unwrap_or_default();
            let doc = if about.is_empty() { c.label.to_string() } else { format!("{}\n{}", c.label, about.join("\n")) };
            CommandDoc { name: c.id.to_string(), doc, schema: (!fields.is_empty()).then_some(TypeSchema::Struct { fields }) }
        })
        .collect()
}

fn ty_name(t: lc::Ty) -> &'static str {
    match t {
        lc::Ty::Bool => "bool",
        lc::Ty::Number => "number",
        lc::Ty::String => "string",
        lc::Ty::Vec3 => "vec3",
        lc::Ty::Entity => "entity",
        lc::Ty::Json => "json",
        lc::Ty::Any => "any",
    }
}

/// Pin table of a kind for the palette: exec pins are typed `flow`.
pub fn pin_docs(kind: &lc::NodeKind) -> Vec<PinDoc> {
    let s = lc::pins(kind);
    let mut v = Vec::new();
    if s.exec_in {
        v.push(PinDoc { name: "in".into(), ty: "flow".into(), input: true });
    }
    v.extend(s.data_in.iter().map(|d| PinDoc { name: d.name.clone(), ty: ty_name(d.ty).into(), input: true }));
    v.extend(s.exec_out.iter().map(|n| PinDoc { name: n.clone(), ty: "flow".into(), input: false }));
    v.extend(s.data_out.iter().map(|(n, t)| PinDoc { name: n.clone(), ty: ty_name(*t).into(), input: false }));
    v
}

fn doc_of(e: &lc::GraphError) -> GraphErrorDoc {
    GraphErrorDoc { node: e.node, pin: e.pin.clone(), message: e.message.clone(), warning: e.severity == lc::Severity::Warning, line: 0, col: 0 }
}

/// Parse + check; the errors a graph file has.
fn check_ron(world: &World, src: &str) -> Vec<GraphErrorDoc> {
    match lc::Graph::from_ron(src) {
        Err(e) => vec![GraphErrorDoc { node: None, pin: None, message: e.message, warning: false, line: e.line as u32, col: e.col as u32 }],
        Ok(g) => g.check(Some(&catalog(world))).iter().map(doc_of).collect(),
    }
}

fn script_errors(world: &World, key: &str) -> Vec<GraphErrorDoc> {
    world
        .resource::<crate::logic::LogicDiagnostics>()
        .items
        .iter()
        .filter(|d| d.file == key && d.node.is_none())
        .map(|d| GraphErrorDoc { node: None, pin: None, message: d.message.clone(), warning: d.severity == crate::logic::Severity::Warning, line: d.line, col: d.col })
        .collect()
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp-write");
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Starter nodes of a template, laid out left to right.
fn template_nodes(template: &str) -> Option<Vec<lc::Node>> {
    use lc::NodeKind as K;
    let n = |id: u32, kind: K| {
        let mut x = lc::Node::new(id, kind);
        x.pos = [(id as f32 - 1.0) * 280.0, 0.0];
        x
    };
    let log = |id: u32, text: &str| n(id, K::Log).with("text", lc::Value::text(text));
    Some(match template {
        "" | "empty" => vec![],
        "basic" | "event_start" => vec![n(1, K::Start), log(2, "hello")],
        "trigger_zone" => vec![n(1, K::OverlapEnter), log(2, "entered")],
        "door" => vec![n(1, K::OverlapEnter), n(2, K::Delay { secs: 0.5 }), n(3, K::Set { path: "Transform.translation.y".into() }).with("value", lc::Value::Num(3.0))],
        "pickup" => vec![n(1, K::OverlapEnter), n(2, K::Emit("picked_up".into())), log(3, "picked up")],
        "timer" => vec![n(1, K::Timer { secs: 1.0, repeat: true }), log(2, "tick")],
        "action_key" => vec![n(1, K::Action("interact".into())), log(2, "interact pressed")],
        _ => return None,
    })
}

/// Templates whose nodes run one after another.
fn template_chain(template: &str) -> bool {
    !matches!(template, "" | "empty")
}

/// The last `logic_list` answer and what it was computed from.
#[derive(Resource)]
struct ListCache {
    stamp: (Vec<(PathBuf, Option<std::time::SystemTime>, u64)>, usize),
    files: Vec<LogicFile>,
}

/// Puts check results in the Output panel (source `Logic`, file = the graph, so a click opens its tab).
fn report(world: &mut World, rel: &str, errs: &[GraphErrorDoc]) {
    for e in errs {
        let level = if e.warning { Level::Warn } else { Level::Error };
        let msg = match (e.node, &e.pin) {
            (Some(n), Some(p)) => format!("node {n} pin {p}: {}", e.message),
            (Some(n), None) => format!("node {n}: {}", e.message),
            _ => e.message.clone(),
        };
        let line = (e.line > 0).then_some(e.line);
        let col = (e.col > 0).then_some(e.col);
        if let Some(mut st) = world.get_resource_mut::<super::EditorState>() {
            st.push_diag(Diagnostic::new(level, "Logic", msg).at(rel, line, col));
        }
    }
}

const HEADER: &str = "// Edited with the Logic editor (comments in this file are not kept).\n";

impl WorldBackend<'_> {
    pub(super) fn logic_list_impl(&mut self) -> Vec<LogicFile> {
        let Ok(root) = root(self.world) else { return Vec::new() };
        let mut files = Vec::new();
        walk(&root.join("logic"), ".logic.ron", &mut files);
        walk(&root.join("scripts"), ".ruspy", &mut files);
        files.sort();
        // Callers poll this a few times a second: reuse the answer while no file changed
        // (diagnostics of scripts can change without a file change, so they are part of the stamp).
        let diag_stamp = self.world.resource::<crate::logic::LogicDiagnostics>().items.len();
        let stamp: Vec<(PathBuf, Option<std::time::SystemTime>, u64)> = files.iter().map(|f| std::fs::metadata(f).map_or((f.clone(), None, 0), |m| (f.clone(), m.modified().ok(), m.len()))).collect();
        let stamp = (stamp, diag_stamp);
        if let Some(c) = self.world.get_resource::<ListCache>()
            && c.stamp == stamp
        {
            return c.files.clone();
        }
        let cat = catalog(self.world);
        let out: Vec<LogicFile> = files
            .into_iter()
            .filter_map(|f| {
                let rel = f.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/");
                let name = f.file_name()?.to_string_lossy().trim_end_matches(".logic.ron").trim_end_matches(".ruspy").to_string();
                let errors = if rel.ends_with(".ruspy") {
                    script_errors(self.world, &rel)
                } else {
                    match std::fs::read_to_string(&f) {
                        Ok(src) => match lc::Graph::from_ron(&src) {
                            Err(e) => vec![GraphErrorDoc { message: e.message, line: e.line as u32, col: e.col as u32, ..Default::default() }],
                            Ok(g) => g.check(Some(&cat)).iter().map(doc_of).collect(),
                        },
                        Err(e) => vec![GraphErrorDoc { message: e.to_string(), ..Default::default() }],
                    }
                };
                Some(LogicFile { path: rel, name, errors })
            })
            .collect();
        self.world.insert_resource(ListCache { stamp, files: out.clone() });
        out
    }

    pub(super) fn logic_read_impl(&mut self, path: &str) -> Result<String, String> {
        let rel = asset_path(path)?;
        let full = root(self.world)?.join(&rel);
        std::fs::read_to_string(&full).map_err(|e| format!("{rel}: {e}"))
    }

    /// Validates `ron` without writing.
    pub fn logic_validate(&mut self, ron: &str) -> Vec<GraphErrorDoc> {
        check_ron(self.world, ron)
    }

    pub(super) fn logic_write_impl(&mut self, path: &str, text: &str) -> Result<Vec<GraphErrorDoc>, String> {
        let rel = asset_path(path)?;
        let full = root(self.world)?.join(&rel);
        if rel.ends_with(".ruspy") {
            write_atomic(&full, text)?;
            crate::logic::reload_script(self.world, &rel);
            let errs = script_errors(self.world, &rel);
            report(self.world, &rel, &errs);
            return Ok(errs);
        }
        let g = lc::Graph::from_ron(text).map_err(|e| format!("{rel}:{e}"))?;
        write_atomic(&full, &format!("{HEADER}{text}"))?;
        crate::logic::reload_graph(self.world, &rel);
        let errs: Vec<GraphErrorDoc> = g.check(Some(&catalog(self.world))).iter().map(doc_of).collect();
        report(self.world, &rel, &errs);
        Ok(errs)
    }

    pub(super) fn logic_create_impl(&mut self, name: &str, template: &str) -> Result<String, String> {
        let stem: String = name.trim().trim_end_matches(".logic.ron").chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
        if stem.is_empty() {
            return Err("give the graph a name".into());
        }
        let rel = format!("logic/{stem}.logic.ron");
        let full = root(self.world)?.join(&rel);
        if full.exists() {
            return Err(format!("{rel} already exists"));
        }
        let mut g = lc::Graph { name: stem.clone(), ..Default::default() };
        g.nodes = template_nodes(template).ok_or_else(|| format!("unknown template `{template}`"))?;
        for i in 1..g.nodes.len() {
            let (from, to) = (g.nodes[i - 1].id, g.nodes[i].id);
            if template_chain(template) {
                g.flow_link((from, "then"), to);
            }
        }
        write_atomic(&full, &format!("{HEADER}{}", g.to_ron()))?;
        Ok(rel)
    }

    pub(super) fn logic_palette_impl(&mut self) -> LogicPalette {
        let mut nodes: Vec<NodeTemplate> = lc::templates()
            .into_iter()
            .map(|t| NodeTemplate {
                kind_json: serde_json::to_value(&t.kind).unwrap_or(Value::Null),
                pins: pin_docs(&t.kind),
                doc: lc::docs(&t.kind).to_string(),
                kind_label: t.label,
                category: t.category.to_string(),
            })
            .collect();
        let commands = commands(self.world);
        for c in &commands {
            let params: serde_json::Map<String, Value> = match &c.schema {
                Some(TypeSchema::Struct { fields }) => fields.iter().map(|(k, _)| (k.clone(), Value::String(format!("${k}")))).collect(),
                _ => Default::default(),
            };
            let kind = lc::NodeKind::Command { id: c.name.clone(), params: Value::Object(params) };
            nodes.push(NodeTemplate { kind_label: lc::label(&kind), category: "Commands".into(), kind_json: serde_json::to_value(&kind).unwrap_or(Value::Null), pins: pin_docs(&kind), doc: c.doc.clone() });
        }
        let mut functions = Vec::new();
        for s in catalog(self.world).scripts.into_iter().filter(|s| !s.function.is_empty()) {
            let kind = lc::NodeKind::Script { file: s.file.clone(), function: s.function.clone(), args: s.args.clone() };
            functions.push(format!("{}::{}({})", s.file, s.function, s.args.join(", ")));
            nodes.push(NodeTemplate { kind_label: lc::label(&kind), category: "Scripts".into(), kind_json: serde_json::to_value(&kind).unwrap_or(Value::Null), pins: pin_docs(&kind), doc: lc::docs(&kind).to_string() });
        }
        LogicPalette { nodes, commands, functions }
    }

    pub(super) fn logic_users_impl(&mut self, path: &str) -> Vec<EntityId> {
        let want = asset_path(path).unwrap_or_else(|_| path.to_string());
        self.world.query::<(Entity, &crate::logic::Logic)>().iter(self.world).filter(|(_, l)| l.graph == want || l.graph == path).map(|(e, _)| e.to_bits()).collect()
    }

    pub(super) fn logic_attach_impl(&mut self, entity: EntityId, path: &str) -> Result<Op, String> {
        let rel = asset_path(path)?;
        let e = resolve(self.world, StableOrId::Id(entity))?;
        let type_path = <crate::logic::Logic as bevy::reflect::TypePath>::type_path().to_string();
        let before = read_component(self.world, e, &type_path);
        let reference = match super::backend::stable_of(self.world, e) {
            Some(s) => StableOrId::Stable(s),
            None => StableOrId::Id(entity),
        };
        let op = Op::SetComponent { entity: reference, type_path, before, after: Some(json!({ "graph": rel })) };
        self.apply(&op)?;
        Ok(op)
    }

    pub(super) fn logic_fire_impl(&mut self, entity: EntityId, event: &str) -> Result<LogicTrace, String> {
        let p = json!({"entity": entity, "event": event, "other": entity, "trace": true});
        let r = crate::logic::fire_event(self.world, p)?;
        let nodes = r.get("trace").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect()).unwrap_or_default();
        let mut log: Vec<String> = r.get("log").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        if let Some(errs) = r.get("new_errors").and_then(Value::as_array) {
            log.extend(errs.iter().filter_map(|v| v.as_str()).map(|s| format!("error: {s}")));
        }
        Ok(LogicTrace { nodes, log })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_paths_are_confined_to_logic_and_scripts() {
        assert_eq!(asset_path("door.logic.ron").unwrap(), "logic/door.logic.ron");
        assert_eq!(asset_path("logic/a/b.logic.ron").unwrap(), "logic/a/b.logic.ron");
        assert_eq!(asset_path("score.ruspy").unwrap(), "scripts/score.ruspy");
        for bad in ["../x.logic.ron", "/etc/passwd.ruspy", "logic/x.txt", "a\\b.ruspy"] {
            assert!(asset_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn functions_are_found_with_their_arguments() {
        let src = "// fn commented()\nfn on_open(who) {\n}\n  fn add(a, b) { return a + b; }\nfn bad name() {}\n";
        assert_eq!(scan_functions(src), vec![("on_open".to_string(), vec!["who".to_string()]), ("add".to_string(), vec!["a".to_string(), "b".to_string()])]);
    }

    #[test]
    fn palette_pin_docs_mark_flow_pins() {
        let pins = pin_docs(&lc::NodeKind::Branch);
        assert!(pins.iter().any(|p| p.name == "in" && p.ty == "flow" && p.input));
        assert!(pins.iter().any(|p| p.name == "true" && p.ty == "flow" && !p.input));
        assert!(pins.iter().any(|p| p.name == "cond" && p.ty == "bool"));
    }
}
