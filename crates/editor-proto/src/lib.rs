//! Editor protocol: the serde types the editor UI and its backends exchange, and the
//! [`EditorBackend`] trait. No Bevy, no egui: the engine implements the trait on its `World`
//! (`src/editor/`), the UI mocks it in tests, and the same types travel as JSON over the control
//! port (`editor.*` commands).

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod backend;
pub use backend::EditorBackend;

/// `Entity::to_bits()`. Valid for one session only.
pub type EntityId = u64;

/// Identity persisted in level files (`LevelEntity`); survives save/load and undo/redo.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct StableId(pub u64);

/// An entity by stable id when it has one, else by session id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum StableOrId {
    Stable(StableId),
    Id(EntityId),
}

impl From<StableId> for StableOrId {
    fn from(s: StableId) -> Self {
        StableOrId::Stable(s)
    }
}

/// What an outliner row looks like.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NodeKind {
    Mesh,
    Light,
    Camera,
    #[default]
    Empty,
    Audio,
    Logic,
    Generated,
    Other,
    /// A `Spline` (roads).
    Spline,
    /// A foliage / PCG volume.
    Foliage,
    /// A registered placeable (gameplay markers, events).
    Gameplay,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TreeNode {
    pub id: EntityId,
    pub stable: Option<StableId>,
    pub name: String,
    pub icon: NodeKind,
    pub children: Vec<TreeNode>,
    /// Built by code, read-only in the editor.
    pub generated: bool,
    pub hidden: bool,
}

impl TreeNode {
    pub fn new(id: EntityId, name: impl Into<String>) -> Self {
        TreeNode {
            id,
            stable: None,
            name: name.into(),
            icon: NodeKind::Empty,
            children: Vec::new(),
            generated: false,
            hidden: false,
        }
    }
    /// The entity reference an `Op` should use for this node.
    pub fn reference(&self) -> StableOrId {
        self.stable.map_or(StableOrId::Id(self.id), StableOrId::Stable)
    }
}

/// What `EditorBackend::tree` should include.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TreeFilter {
    /// Case-insensitive name filter; empty = everything. A match keeps its ancestors.
    pub text: String,
    pub include_generated: bool,
    pub include_hidden: bool,
}

impl Default for TreeFilter {
    fn default() -> Self {
        TreeFilter {
            text: String::new(),
            include_generated: true,
            include_hidden: true,
        }
    }
}

/// How to edit a value, derived from the reflected type on the engine side.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum TypeSchema {
    Bool,
    Int {
        min: Option<i64>,
        max: Option<i64>,
    },
    Float {
        min: Option<f64>,
        max: Option<f64>,
        step: Option<f64>,
    },
    String,
    /// `[r, g, b, a]` floats (3 or 4 numbers).
    Color,
    Vec2,
    Vec3,
    Vec4,
    /// `[x, y, z, w]`; shown as euler degrees.
    Quat,
    AssetPath {
        kind: String,
    },
    /// A unit variant is a JSON string, a variant with data is `{ "Name": payload }`.
    Enum {
        variants: Vec<(String, Option<TypeSchema>)>,
    },
    Struct {
        fields: Vec<(String, TypeSchema)>,
    },
    List(Box<TypeSchema>),
    Map(Box<TypeSchema>),
    Entity,
    /// Not editable; shown as text.
    Opaque,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ComponentDoc {
    pub type_path: String,
    pub short_name: String,
    /// Reflect JSON (Vec3 = `[x,y,z]`, Quat = `[x,y,z,w]`).
    pub value: Value,
    pub schema: TypeSchema,
    /// False when the component is not Reflect-deserializable.
    pub editable: bool,
}

/// An entity with its components and subtree: enough to spawn it again.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntitySnapshot {
    pub stable: StableId,
    pub name: String,
    pub parent: Option<StableId>,
    pub components: Vec<(String, Value)>,
    pub children: Vec<EntitySnapshot>,
}

/// Every edit. Each has an exact inverse, so undo is "apply the inverse".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Op {
    /// `before`/`after` of `None` = component absent (add / remove).
    SetComponent {
        entity: StableOrId,
        type_path: String,
        before: Option<Value>,
        after: Option<Value>,
    },
    Spawn {
        snapshot: EntitySnapshot,
    },
    Despawn {
        snapshot: EntitySnapshot,
    },
    Reparent {
        entity: StableOrId,
        before: Option<StableOrId>,
        after: Option<StableOrId>,
    },
    Rename {
        entity: StableOrId,
        before: String,
        after: String,
    },
    /// A terrain edit (a sculpt or paint stroke). The data lives in the engine's undo blob
    /// store, `before` / `after` are blob ids (not JSON): applying the op writes `after` back,
    /// its inverse writes `before`.
    TerrainPatch {
        layer: TerrainKind,
        /// `[x0, z0, w, h]` in samples (height) or texels (splat).
        rect: [u32; 4],
        before: u64,
        after: u64,
    },
    Batch(Vec<Op>),
}

/// Which terrain data a [`Op::TerrainPatch`] changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TerrainKind {
    Height,
    Splat,
}

impl Op {
    /// The op that exactly undoes this one.
    pub fn inverse(&self) -> Op {
        match self {
            Op::SetComponent { entity, type_path, before, after } => Op::SetComponent {
                entity: *entity,
                type_path: type_path.clone(),
                before: after.clone(),
                after: before.clone(),
            },
            Op::Spawn { snapshot } => Op::Despawn { snapshot: snapshot.clone() },
            Op::Despawn { snapshot } => Op::Spawn { snapshot: snapshot.clone() },
            Op::Reparent { entity, before, after } => Op::Reparent {
                entity: *entity,
                before: *after,
                after: *before,
            },
            Op::Rename { entity, before, after } => Op::Rename {
                entity: *entity,
                before: after.clone(),
                after: before.clone(),
            },
            Op::TerrainPatch { layer, rect, before, after } => Op::TerrainPatch { layer: *layer, rect: *rect, before: *after, after: *before },
            Op::Batch(ops) => Op::Batch(ops.iter().rev().map(Op::inverse).collect()),
        }
    }

    /// Fold `next` into `self` when both set the same component of the same entity (a drag or
    /// scrub becomes one step). Keeps the first `before` and the last `after`. Returns false (and
    /// leaves `self` alone) when they can't merge.
    pub fn merge(&mut self, next: &Op) -> bool {
        match (self, next) {
            (
                Op::SetComponent {
                    entity: e1,
                    type_path: t1,
                    after: a1,
                    ..
                },
                Op::SetComponent {
                    entity: e2,
                    type_path: t2,
                    after: a2,
                    ..
                },
            ) if e1 == e2 && t1 == t2 => {
                *a1 = a2.clone();
                true
            }
            (Op::Rename { entity: e1, after: a1, .. }, Op::Rename { entity: e2, after: a2, .. }) if e1 == e2 => {
                *a1 = a2.clone();
                true
            }
            _ => false,
        }
    }

    /// True when applying the op changes nothing (a merged drag that ended where it began).
    pub fn is_noop(&self) -> bool {
        match self {
            Op::SetComponent { before, after, .. } => before == after,
            Op::Reparent { before, after, .. } => before == after,
            Op::Rename { before, after, .. } => before == after,
            Op::TerrainPatch { before, after, .. } => before == after,
            Op::Batch(ops) => ops.iter().all(Op::is_noop),
            Op::Spawn { .. } | Op::Despawn { .. } => false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AssetKind {
    Folder,
    Model,
    Texture,
    Audio,
    Level,
    Script,
    Logic,
    Material,
    #[default]
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AssetEntry {
    /// Path relative to the asset root.
    pub path: String,
    pub kind: AssetKind,
    pub name: String,
    pub thumbnail: Option<String>,
    /// SPDX id from `LICENSES.json` for library assets.
    pub license: Option<String>,
}

/// Where a placed asset goes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub position: [f32; 3],
    pub parent: Option<StableId>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LevelInfo {
    pub path: Option<String>,
    pub dirty: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlayState {
    #[default]
    Editing,
    /// `cargo build` of the game is running.
    Building,
    Playing,
}

/// An editor tool beyond Move / Rotate / Scale (Spline, Sculpt, Paint, Foliage, Place ...): the
/// engine implements it, the UI shows a toolbar button and a settings panel built from `schema`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDoc {
    pub id: String,
    pub label: String,
    /// One line of help (keys, what a click does).
    pub hint: String,
    /// The tool's settings as JSON (same value forms as component values).
    pub settings: Value,
    pub schema: TypeSchema,
}

/// An op the engine applied itself (tool strokes, drags); the UI records it for undo.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecordedOp {
    pub label: String,
    pub op: Op,
    /// Consecutive ops with the same key within a short time fold into one step.
    pub key: Option<String>,
}

/// A type the Place palette lists.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlaceableDoc {
    pub name: String,
    pub icon: String,
    pub category: String,
    pub type_path: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Level {
    Trace,
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub level: Level,
    pub source: String,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub col: Option<u32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Tool {
    /// No gizmo: clicking selects.
    Select,
    #[default]
    Move,
    Rotate,
    Scale,
}

/// Viewport commands from the UI to the 3D view.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ViewportCmd {
    FocusSelection,
    SetTool(Tool),
    /// Snap on/off with its step (metres for move/scale, degrees for rotate).
    SetSnap {
        enabled: bool,
        step: f32,
    },
    /// Fly speed in metres per second.
    SetCameraSpeed(f32),
    /// Gizmo axes: the entity's own (true) or the world's.
    SetLocalSpace(bool),
    /// The faint ground grid.
    SetShowGrid(bool),
}

/// What the viewport overlay shows, read every frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewInfo {
    pub camera_speed: f32,
    pub local_space: bool,
    pub show_grid: bool,
    /// Camera rotation as `[x, y, z, w]` (for the axis gizmo).
    pub camera_rotation: [f32; 4],
}

impl Default for ViewInfo {
    fn default() -> Self {
        ViewInfo { camera_speed: 8.0, local_space: false, show_grid: true, camera_rotation: [0.0, 0.0, 0.0, 1.0] }
    }
}

#[cfg(test)]
mod tests;
