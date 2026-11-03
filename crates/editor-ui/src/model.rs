//! Shared model types: the node index, requests panels send up, and the command table.

use std::collections::HashMap;

use editor_proto::{EntityId, NodeKind, Op, StableOrId, TreeNode};

/// What a panel knows about one entity, for every entity in the tree (collapsed or not).
#[derive(Clone, Debug)]
pub(crate) struct NodeInfo {
    pub name: String,
    pub reference: StableOrId,
    pub generated: bool,
    pub hidden: bool,
    pub origin: Option<String>,
    pub kind: NodeKind,
    pub parent: Option<EntityId>,
    pub child_count: usize,
}

#[derive(Default)]
pub(crate) struct Nodes {
    pub info: HashMap<EntityId, NodeInfo>,
    /// Depth-first order of every node.
    pub order: Vec<EntityId>,
}

impl Nodes {
    pub fn build(tree: &[TreeNode]) -> Nodes {
        let mut n = Nodes::default();
        n.add(tree, None, false, 0);
        n
    }
    fn add(&mut self, nodes: &[TreeNode], parent: Option<EntityId>, parent_generated: bool, depth: usize) {
        if depth > 256 {
            return;
        }
        for node in nodes {
            // Children of generated nodes are generated too.
            let generated = node.generated || parent_generated;
            self.info.insert(
                node.id,
                NodeInfo {
                    name: node.name.clone(),
                    reference: node.reference(),
                    generated,
                    hidden: node.hidden,
                    origin: node.origin.clone(),
                    kind: node.icon,
                    parent,
                    child_count: node.children.len(),
                },
            );
            self.order.push(node.id);
            self.add(&node.children, Some(node.id), generated, depth + 1);
        }
    }
    /// Whether `id` is `ancestor` or below it.
    pub fn is_within(&self, id: EntityId, ancestor: EntityId) -> bool {
        let mut cur = Some(id);
        for _ in 0..512 {
            match cur {
                Some(c) if c == ancestor => return true,
                Some(c) => cur = self.info.get(&c).and_then(|n| n.parent),
                None => return false,
            }
        }
        false
    }
    pub fn reference(&self, id: EntityId) -> StableOrId {
        self.info.get(&id).map_or(StableOrId::Id(id), |n| n.reference)
    }
}

/// Expose a painted row to accessibility (and to tests) as a selectable label. Hover-only: clicks
/// still go to the list under it.
pub(crate) fn a11y_row(ui: &egui::Ui, rect: egui::Rect, id: egui::Id, label: &str, selected: bool) {
    let r = ui.interact(rect, id, egui::Sense::hover());
    r.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::SelectableLabel, true, selected, label));
}

/// What panels ask the editor to do. Processed after the frame's panels are drawn, so panels only
/// read state and never touch the backend.
pub(crate) enum Req {
    /// Apply `op`, record it for undo. `key` merges drags; `seal` ends the gesture.
    Edit {
        op: Op,
        label: String,
        key: Option<String>,
        seal: bool,
    },
    Select(Vec<EntityId>),
    Place(String),
    /// Place a model at a viewport point (a drop): path and `[u, v]` fractions of the viewport.
    PlaceAt(String, [f32; 2]),
    /// Open an asset by kind (level, logic tab, folder).
    OpenAsset(String, editor_proto::AssetKind),
    /// Show the asset in the file manager.
    Reveal(String),
    /// Make a generated entity a level entity.
    Convert(EntityId),
    /// Activate a tool by id (`None`: back to the transform gizmo tools).
    Tool(Option<String>),
    /// Open a level by path (File > Recent).
    OpenPath(String),
    ToolSettings { id: String, settings: serde_json::Value },
    Cmd(Cmd),
    /// Switch mode (Select, Landscape, Foliage, Splines, Place).
    Mode(Mode),
    /// Change one settings group (World Settings tab, Project Settings window).
    Settings { group: String, value: serde_json::Value },
    /// Select an entity from the command palette and bring it into view.
    RevealEntity(EntityId),
    /// Refetch the tree (the outliner search text changed).
    TreeFilterChanged,
    Copy(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmd {
    Save,
    SaveAs,
    Open,
    Undo,
    Redo,
    PlayStop,
    ToolSelect,
    ToolMove,
    ToolRotate,
    ToolScale,
    ToggleSnap,
    ToggleLocalSpace,
    ToggleGrid,
    ToggleAllScenery,
    Focus,
    Delete,
    Duplicate,
    SelectAll,
    Rename,
    Palette,
    Help,
    ResetLayout,
    ToggleDrawer,
    DockDrawer,
    ModeSelect,
    ModeLandscape,
    ModeFoliage,
    ModeSplines,
    ModePlace,
    OpenWorldSettings,
    OpenProjectSettings,
    OpenPreferences,
    LayoutDefault,
    LayoutLandscape,
    LayoutLogic,
}

/// The editor's modes: what a click in the viewport does and which tool settings the left panel
/// shows. Select is the default; the others each arm one world tool (Landscape has two).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mode {
    Select,
    Landscape,
    Foliage,
    Splines,
    Place,
}

impl Mode {
    pub const ALL: [Mode; 5] = [Mode::Select, Mode::Landscape, Mode::Foliage, Mode::Splines, Mode::Place];
    pub fn label(self) -> &'static str {
        match self {
            Mode::Select => "Select",
            Mode::Landscape => "Landscape",
            Mode::Foliage => "Foliage",
            Mode::Splines => "Splines",
            Mode::Place => "Place",
        }
    }
    /// Ids of the world tools (`ToolDoc::id`) this mode uses; the first is the default.
    pub fn tool_ids(self) -> &'static [&'static str] {
        match self {
            Mode::Select => &[],
            Mode::Landscape => &["sculpt", "paint"],
            Mode::Foliage => &["foliage"],
            Mode::Splines => &["spline"],
            Mode::Place => &["place"],
        }
    }
    pub fn hint(self) -> &'static str {
        match self {
            Mode::Select => "Click an object to select it. Pick a type or model below to place it.",
            Mode::Landscape => "Sculpt and paint the terrain.",
            Mode::Foliage => "Paint, erase and move trees, rocks and plants.",
            Mode::Splines => "Edit roads and other splines. Ctrl+click adds a point.",
            Mode::Place => "Click in the viewport to drop the chosen type.",
        }
    }
    /// The mode a world tool belongs to (`None`: the transform tools, i.e. Select).
    pub fn of_tool(id: Option<&str>) -> Mode {
        match id {
            None => Mode::Select,
            Some(t) => Mode::ALL.into_iter().find(|m| m.tool_ids().contains(&t)).unwrap_or(Mode::Select),
        }
    }
}

pub(crate) struct CmdSpec {
    pub cmd: Cmd,
    pub id: &'static str,
    pub label: &'static str,
    pub shortcut: Option<&'static str>,
    pub menu: &'static str,
    pub mutates: bool,
}

/// Every toolbar action is a command with an id, a label and (mostly) a shortcut.
pub(crate) const COMMANDS: &[CmdSpec] = &[
    CmdSpec {
        cmd: Cmd::Save,
        id: "editor.save",
        label: "Save level",
        shortcut: Some("Mod+S"),
        menu: "File",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::SaveAs,
        id: "editor.save_as",
        label: "Save level as...",
        shortcut: Some("Mod+Shift+S"),
        menu: "File",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::Open,
        id: "editor.open",
        label: "Open level...",
        shortcut: Some("Mod+O"),
        menu: "File",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::Undo,
        id: "editor.undo",
        label: "Undo",
        shortcut: Some("Mod+Z"),
        menu: "Edit",
        mutates: true,
    },
    CmdSpec {
        cmd: Cmd::Redo,
        id: "editor.redo",
        label: "Redo",
        shortcut: Some("Mod+Shift+Z / Mod+Y"),
        menu: "Edit",
        mutates: true,
    },
    CmdSpec {
        cmd: Cmd::Delete,
        id: "editor.delete",
        label: "Delete selection",
        shortcut: Some("Delete / Backspace"),
        menu: "Edit",
        mutates: true,
    },
    CmdSpec {
        cmd: Cmd::Rename,
        id: "editor.rename",
        label: "Rename selection",
        shortcut: Some("F2"),
        menu: "Edit",
        mutates: true,
    },
    CmdSpec {
        cmd: Cmd::PlayStop,
        id: "editor.play",
        label: "Play / Stop",
        shortcut: Some("Mod+P"),
        menu: "Game",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToolMove,
        id: "editor.tool_move",
        label: "Move tool",
        shortcut: Some("2"),
        menu: "Tools",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToolRotate,
        id: "editor.tool_rotate",
        label: "Rotate tool",
        shortcut: Some("3"),
        menu: "Tools",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToolScale,
        id: "editor.tool_scale",
        label: "Scale tool",
        shortcut: Some("4"),
        menu: "Tools",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToggleSnap,
        id: "editor.snap",
        label: "Toggle snapping",
        shortcut: Some("G"),
        menu: "Tools",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::Focus,
        id: "editor.focus",
        label: "Focus selection",
        shortcut: Some("F"),
        menu: "View",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::Palette,
        id: "editor.palette",
        label: "Command palette",
        shortcut: Some("Mod+K / Mod+Shift+P"),
        menu: "View",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToolSelect,
        id: "editor.tool_select",
        label: "Select tool",
        shortcut: Some("1"),
        menu: "Tools",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToggleLocalSpace,
        id: "editor.local_space",
        label: "Local / world gizmo",
        shortcut: Some("L"),
        menu: "Tools",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToggleGrid,
        id: "editor.grid",
        label: "Show grid",
        shortcut: None,
        menu: "View",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToggleAllScenery,
        id: "editor.show_all_scenery",
        label: "Show all scenery (no distance fade)",
        shortcut: None,
        menu: "View",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::Duplicate,
        id: "editor.duplicate",
        label: "Duplicate",
        shortcut: Some("Mod+D"),
        menu: "Edit",
        mutates: true,
    },
    CmdSpec {
        cmd: Cmd::SelectAll,
        id: "editor.select_all",
        label: "Select all",
        shortcut: Some("Mod+A"),
        menu: "Edit",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::Help,
        id: "editor.help",
        label: "Controls and shortcuts",
        shortcut: Some("F1"),
        menu: "Help",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ResetLayout,
        id: "editor.reset_layout",
        label: "Reset panel layout",
        shortcut: None,
        menu: "Window",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToggleDrawer,
        id: "editor.drawer",
        label: "Content drawer: open / close",
        shortcut: Some("Mod+Space / Mod+J"),
        menu: "Window",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::DockDrawer,
        id: "editor.drawer_dock",
        label: "Content drawer: dock / undock",
        shortcut: None,
        menu: "Window",
        mutates: false,
    },
    CmdSpec { cmd: Cmd::ModeSelect, id: "editor.mode_select", label: "Mode: Select", shortcut: None, menu: "Tools", mutates: false },
    CmdSpec { cmd: Cmd::ModeLandscape, id: "editor.mode_landscape", label: "Mode: Landscape (sculpt, paint)", shortcut: None, menu: "Tools", mutates: false },
    CmdSpec { cmd: Cmd::ModeFoliage, id: "editor.mode_foliage", label: "Mode: Foliage", shortcut: None, menu: "Tools", mutates: false },
    CmdSpec { cmd: Cmd::ModeSplines, id: "editor.mode_splines", label: "Mode: Splines", shortcut: None, menu: "Tools", mutates: false },
    CmdSpec { cmd: Cmd::ModePlace, id: "editor.mode_place", label: "Mode: Place", shortcut: None, menu: "Tools", mutates: false },
    CmdSpec { cmd: Cmd::OpenWorldSettings, id: "editor.world_settings", label: "World Settings (look, terrain, streaming)", shortcut: None, menu: "Window", mutates: false },
    CmdSpec { cmd: Cmd::OpenProjectSettings, id: "editor.project_settings", label: "Project Settings...", shortcut: None, menu: "Edit", mutates: false },
    CmdSpec { cmd: Cmd::OpenPreferences, id: "editor.preferences", label: "Editor Preferences...", shortcut: None, menu: "Edit", mutates: false },
    CmdSpec { cmd: Cmd::LayoutDefault, id: "editor.layout_default", label: "Layout: Default", shortcut: None, menu: "Window", mutates: false },
    CmdSpec { cmd: Cmd::LayoutLandscape, id: "editor.layout_landscape", label: "Layout: Landscape", shortcut: None, menu: "Window", mutates: false },
    CmdSpec { cmd: Cmd::LayoutLogic, id: "editor.layout_logic", label: "Layout: Logic", shortcut: None, menu: "Window", mutates: false },
];

impl Cmd {
    pub fn from_id(id: &str) -> Option<Cmd> {
        COMMANDS.iter().find(|c| c.id == id).map(|c| c.cmd)
    }
    pub(crate) fn spec(self) -> &'static CmdSpec {
        // Every variant is in the table (checked by a test), so the fallback is never used.
        COMMANDS.iter().find(|c| c.cmd == self).unwrap_or(&COMMANDS[0])
    }
}

/// Outliner folders are not entities: they get ids counted down from the top of the range.
pub const FOLDER_BASE: u64 = u64::MAX - 64;

pub fn is_folder(id: EntityId) -> bool {
    id >= FOLDER_BASE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_is_registered_once() {
        for c in COMMANDS {
            assert_eq!(c.cmd.spec().id, c.id);
            assert_eq!(COMMANDS.iter().filter(|o| o.id == c.id).count(), 1);
        }
        assert_eq!(Cmd::from_id("editor.undo"), Some(Cmd::Undo));
        assert_eq!(Cmd::from_id("nope"), None);
    }

    #[test]
    fn shortcuts_parse() {
        let keymap = ashlar_command::Keymap::new(ashlar_command::shortcut::Platform::Mac, COMMANDS.iter().map(|c| (c.id, c.shortcut)));
        assert!(keymap.invalid_defaults().is_empty(), "{:?}", keymap.invalid_defaults());
        assert!(keymap.conflicts().is_empty());
    }
}
