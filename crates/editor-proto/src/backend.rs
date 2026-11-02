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
}
