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
    /// Activate a tool by id (`None`: back to the transform gizmo tools).
    Tool(Option<String>),
    ToolSettings { id: String, settings: serde_json::Value },
    Cmd(Cmd),
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
    ToolMove,
    ToolRotate,
    ToolScale,
    ToggleSnap,
    Focus,
    Delete,
    Rename,
    Palette,
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
        label: "Tool: Move",
        shortcut: Some("W"),
        menu: "Tools",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToolRotate,
        id: "editor.tool_rotate",
        label: "Tool: Rotate",
        shortcut: Some("E"),
        menu: "Tools",
        mutates: false,
    },
    CmdSpec {
        cmd: Cmd::ToolScale,
        id: "editor.tool_scale",
        label: "Tool: Scale",
        shortcut: Some("R"),
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
