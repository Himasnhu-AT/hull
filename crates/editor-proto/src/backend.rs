use crate::*;

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
}
