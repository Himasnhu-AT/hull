use crate::*;
use serde_json::Value;

/// Implemented by the engine (`src/editor/`) on the Bevy `World`, mocked in `editor-ui` tests.
/// All methods take `&mut self` so a backend can cache and poll.
///
/// Rules: `apply` never records undo (the UI does); no method panics on bad input, errors are
/// returned as text for the UI to show.
pub trait EditorBackend {
    fn tree(&mut self, filter: &TreeFilter) -> Vec<TreeNode>;
    fn components(&mut self, id: EntityId) -> Result<Vec<ComponentDoc>, String>;
    /// Component types that can be added, with their schema (for "Add component").
    fn component_types(&mut self) -> Vec<(String, TypeSchema)>;
    fn apply(&mut self, op: &Op) -> Result<(), String>;
    /// The entity, its components and subtree, to build a `Despawn` op (needs stable ids).
    fn snapshot(&mut self, id: EntityId) -> Result<EntitySnapshot, String>;
    fn selection(&mut self) -> Vec<EntityId>;
    fn set_selection(&mut self, ids: &[EntityId]);
    fn assets(&mut self, dir: &str) -> Vec<AssetEntry>;
    /// Spawns the asset (already applied) and returns the `Spawn` op for the undo stack.
    fn place_asset(&mut self, path: &str, at: Placement) -> Result<Op, String>;
    fn level(&mut self) -> LevelInfo;
    fn save_level(&mut self, path: Option<&str>) -> Result<(), String>;
    fn open_level(&mut self, path: &str) -> Result<(), String>;
    fn play(&mut self) -> Result<(), String>;
    fn stop(&mut self);
    fn play_state(&mut self) -> PlayState;
    /// New diagnostics after cursor `since`; returns the new cursor.
    fn diagnostics(&mut self, since: u64) -> (u64, Vec<Diagnostic>);
    fn viewport(&mut self, cmd: ViewportCmd);

    /// Copies the entities (children included, fresh stable ids), applies the spawn and returns
    /// the `Spawn` op for the undo stack (a `Batch` for several).
    fn duplicate(&mut self, _ids: &[EntityId]) -> Result<Op, String> {
        Err("duplicate is not supported by this backend".into())
    }

    /// Camera speed, space, grid and orientation for the viewport overlay.
    fn view_info(&mut self) -> ViewInfo {
        ViewInfo::default()
    }

    // ---- tools (defaults: none, so a backend without world tools needs nothing) ----------
    /// The tools beyond Move / Rotate / Scale, with their current settings.
    fn tools(&mut self) -> Vec<ToolDoc> {
        Vec::new()
    }
    /// The active tool id, `None` while Move / Rotate / Scale (see `viewport(SetTool)`) is active.
    fn active_tool(&mut self) -> Option<String> {
        None
    }
    /// Activates a tool by id; `None` goes back to the transform gizmo tools.
    fn set_active_tool(&mut self, _id: Option<&str>) {}
    /// Replaces a tool's settings (not undoable; the tool's edits are).
    fn set_tool_settings(&mut self, _id: &str, _settings: Value) -> Result<(), String> {
        Err("no such tool".into())
    }
    /// Ops the engine applied on its own (a terrain stroke, a spline point drag) since the last
    /// call: `(label, op, merge key)`. The UI records them for undo.
    fn take_recorded(&mut self) -> Vec<RecordedOp> {
        Vec::new()
    }
    /// The Place palette.
    fn placeables(&mut self) -> Vec<PlaceableDoc> {
        Vec::new()
    }

    /// Makes a generated (code-built) entity a level entity in place: a stable id and a name, so
    /// it is saved, editable and selectable by id. Returns the op for the undo stack.
    fn convert_to_level(&mut self, _id: EntityId) -> Result<Op, String> {
        Err("convert is not supported by this backend".into())
    }

    /// Shows an asset in the system file manager.
    fn reveal_asset(&mut self, _path: &str) -> Result<(), String> {
        Err("not supported by this backend".into())
    }

    // ---- logic graphs (defaults: not supported) ------------------------------------------
    fn logic_list(&mut self) -> Vec<LogicFile> {
        Vec::new()
    }
    /// The RON text of a `.logic.ron` file.
    fn logic_read(&mut self, _path: &str) -> Result<String, String> {
        Err("logic graphs are not supported by this backend".into())
    }
    /// Validates and writes the RON; returns the graph errors found (empty = valid).
    fn logic_write(&mut self, _path: &str, _ron: &str) -> Result<Vec<GraphErrorDoc>, String> {
        Err("logic graphs are not supported by this backend".into())
    }
    /// Creates a new graph file from a template; returns its path.
    fn logic_create(&mut self, _name: &str, _template: &str) -> Result<String, String> {
        Err("logic graphs are not supported by this backend".into())
    }
    fn logic_palette(&mut self) -> LogicPalette {
        LogicPalette::default()
    }
    /// Entities carrying the graph at `path` (the Test button fires on one of them).
    fn logic_users(&mut self, _path: &str) -> Vec<EntityId> {
        Vec::new()
    }
    /// Attaches the graph at `path` to `entity` (a `Logic` component). Returns the op the
    /// backend applied, so the UI can record it for undo.
    fn logic_attach(&mut self, _entity: EntityId, _path: &str) -> Result<Op, String> {
        Err("logic graphs are not supported by this backend".into())
    }
    fn logic_fire(&mut self, _entity: EntityId, _event: &str) -> Result<LogicTrace, String> {
        Err("logic graphs are not supported by this backend".into())
    }
}
