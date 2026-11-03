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
    fn logic_users(&mut self, path: &str) -> Vec<EntityId> {
        self.users.get(path).cloned().unwrap_or_default()
    }
    fn logic_fire(&mut self, entity: EntityId, event: &str) -> Result<LogicTrace, String> {
        self.fired.push((entity, event.to_string()));
        Ok(LogicTrace { nodes: self.trace.clone(), log: vec!["fired".into()] })
    }
}
