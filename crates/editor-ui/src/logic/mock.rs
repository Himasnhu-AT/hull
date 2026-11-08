//! In-memory logic files over the editor mock, for tests and the standalone example.

use std::collections::BTreeMap;

use editor_proto::*;

use crate::mock::MockBackend;

/// [`MockBackend`] plus logic files (`logic/*.logic.ron`, `scripts/*.ruspy`) in memory.
pub struct LogicMock {
    pub inner: MockBackend,
    pub files: BTreeMap<String, String>,
    pub palette: LogicPalette,
    /// Entities that "run" each graph path.
    pub users: BTreeMap<String, Vec<EntityId>>,
    pub fired: Vec<(EntityId, String)>,
    pub trace: Vec<u32>,
    pub written: Vec<String>,
}

impl LogicMock {
    pub fn new() -> LogicMock {
        let mut files = BTreeMap::new();
        files.insert("scripts/score.ruspy".to_string(), "fn on_open(who) {\n    return who;\n}\n".to_string());
        LogicMock {
            inner: MockBackend::demo(),
            files,
            palette: LogicPalette { functions: vec!["score.ruspy::on_open(who)".into()], ..Default::default() },
            users: BTreeMap::new(),
            fired: Vec::new(),
            trace: Vec::new(),
            written: Vec::new(),
        }
    }
}

impl Default for LogicMock {
    fn default() -> Self {
        Self::new()
    }
}

macro_rules! delegate {
    ($($name:ident($($arg:ident: $ty:ty),*) -> $ret:ty;)*) => {
        $(fn $name(&mut self, $($arg: $ty),*) -> $ret { self.inner.$name($($arg),*) })*
    };
}

impl EditorBackend for LogicMock {
    delegate! {
        tree(filter: &TreeFilter) -> Vec<TreeNode>;
        components(id: EntityId) -> Result<Vec<ComponentDoc>, String>;
        component_types() -> Vec<(String, TypeSchema)>;
        apply(op: &Op) -> Result<(), String>;
        snapshot(id: EntityId) -> Result<EntitySnapshot, String>;
        selection() -> Vec<EntityId>;
        set_selection(ids: &[EntityId]) -> ();
        assets(dir: &str) -> Vec<AssetEntry>;
        place_asset(path: &str, at: Placement) -> Result<Op, String>;
        level() -> LevelInfo;
        save_level(path: Option<&str>) -> Result<(), String>;
        open_level(path: &str) -> Result<(), String>;
        play() -> Result<(), String>;
        stop() -> ();
        play_state() -> PlayState;
        diagnostics(since: u64) -> (u64, Vec<Diagnostic>);
        viewport(cmd: ViewportCmd) -> ();
    }

    fn logic_list(&mut self) -> Vec<LogicFile> {
        self.files.keys().map(|p| LogicFile { path: p.clone(), name: p.rsplit('/').next().unwrap_or(p).split('.').next().unwrap_or("").to_string(), errors: vec![] }).collect()
    }
    fn logic_read(&mut self, path: &str) -> Result<String, String> {
        self.files.get(path).cloned().ok_or_else(|| format!("{path}: not found"))
    }
    fn logic_write(&mut self, path: &str, ron: &str) -> Result<Vec<GraphErrorDoc>, String> {
        if path.ends_with(".logic.ron") {
            logic_core::Graph::from_ron(ron).map_err(|e| e.to_string())?;
        }
        self.files.insert(path.to_string(), ron.to_string());
        self.written.push(path.to_string());
        Ok(vec![])
    }
    fn logic_create(&mut self, name: &str, _template: &str) -> Result<String, String> {
        let path = format!("logic/{name}.logic.ron");
        if self.files.contains_key(&path) {
            return Err(format!("{path} already exists"));
        }
        let g = logic_core::Graph { name: name.into(), ..Default::default() };
        self.files.insert(path.clone(), g.to_ron());
        Ok(path)
    }
    fn logic_palette(&mut self) -> LogicPalette {
        self.palette.clone()
    }
    fn script_api(&mut self) -> Vec<ApiFn> {
        let row = |name: &str, sig: &str, doc: &str| ApiFn { name: name.into(), sig: sig.into(), doc: doc.into() };
        vec![
            row("get_node", "get_node([node,] path)", "Resolve a node path."),
            row("get_name", "get_name([node])", "Name of the node."),
            row("connect", "connect([source,] signal, target, method)", "Connect a signal."),
        ]
    }
    /// Good enough for tests: `fn name(a, b)` lines and `name = ...;` lines at column 0.
    fn script_outline(&mut self, text: &str) -> ScriptOutline {
        let mut o = ScriptOutline::default();
        for l in text.lines() {
            if let Some(rest) = l.strip_prefix("fn ") {
                let (name, params) = rest.split_once('(').unwrap_or((rest, ""));
                let params = params.split(')').next().unwrap_or("");
                o.fns.push(ScriptFn { name: name.trim().into(), params: params.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect() });
            } else if let Some((name, _)) = l.split_once(" = ")
                && !name.is_empty()
                && name.chars().all(|c| c.is_alphanumeric() || c == '_')
                && !o.vars.contains(&name.to_string())
            {
                o.vars.push(name.into());
            }
        }
        o
    }
    fn logic_users(&mut self, path: &str) -> Vec<EntityId> {
        self.users.get(path).cloned().unwrap_or_default()
    }
    fn logic_fire(&mut self, entity: EntityId, event: &str) -> Result<LogicTrace, String> {
        self.fired.push((entity, event.to_string()));
        Ok(LogicTrace { nodes: self.trace.clone(), log: vec!["fired".into()] })
    }
}
