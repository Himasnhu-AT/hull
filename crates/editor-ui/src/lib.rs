//! Editor UI: egui panels over [`EditorBackend`]. No Bevy.
//!
//! ```ignore
//! let mut ui = EditorUi::new();
//! // every frame, inside the egui pass:
//! let out = ui.show(&ctx, &mut backend);
//! place_3d_camera(out.viewport);
//! ```
//!
//! The UI owns undo (a journal of [`Op`]s), layout and view state. The backend owns the world:
//! every edit is an `Op` handed to `EditorBackend::apply`. See the README for hosting.

mod content;
mod details;
mod logic;
mod model;
mod outliner;
mod output;
mod props;
mod undo;

pub mod mock;

use std::collections::HashSet;

use ashlar_command::shortcut::Platform;
use ashlar_command::{CommandInfo, Keymap};
use ashlar_ui::commands::{CommandPalette, dispatch};
use ashlar_ui::docking::{DockArea, DockStyle, Layout, Node, Permissions};
use ashlar_ui::layout::{SplitAxis, SplitSize};
use ashlar_ui::status_bar::StatusBar;
use ashlar_ui::toasts::Toasts;
use ashlar_ui::tokens::{self, ThemeMode, Tokens};
use editor_proto::{AssetEntry, ComponentDoc, Diagnostic, EditorBackend, EntityId, Op, PlayState, Tool, TreeFilter, TreeNode, TypeSchema, ViewportCmd};
use egui::{Context, Key, Ui};
use serde::{Deserialize, Serialize};

use model::{COMMANDS, Cmd, Nodes, Req};
use undo::UndoStack;

pub use model::Cmd as Command;

/// The dockable panels. The viewport is the transparent hole the host draws the 3D view into.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Panel {
    Viewport,
    Outliner,
    Details,
    Content,
    Output,
    Logic,
}

impl Panel {
    pub const ALL: [Panel; 6] = [Panel::Viewport, Panel::Outliner, Panel::Details, Panel::Content, Panel::Output, Panel::Logic];
    pub fn title(self) -> &'static str {
        match self {
            Panel::Viewport => "Viewport",
            Panel::Outliner => "Outliner",
            Panel::Details => "Details",
            Panel::Content => "Content",
            Panel::Output => "Output",
            Panel::Logic => "Logic",
        }
    }
}

/// The default arrangement: Outliner left, Details right, Content/Output/Logic tabs under the
/// viewport.
pub fn default_layout() -> Layout<Panel> {
    let tabs = |panels: Vec<Panel>| Node::Tabs { panels, active: 0 };
    let split = |axis, size, a, b| Node::Split { axis, size, first: Box::new(a), second: Box::new(b) };
    let centre = split(SplitAxis::Vertical, SplitSize::FixedSecond(230.0), tabs(vec![Panel::Viewport]), tabs(vec![Panel::Content, Panel::Output, Panel::Logic]));
    let right = split(SplitAxis::Horizontal, SplitSize::FixedSecond(320.0), centre, tabs(vec![Panel::Details]));
    Layout { root: Some(split(SplitAxis::Horizontal, SplitSize::FixedFirst(250.0), tabs(vec![Panel::Outliner]), right)), floating: vec![] }
}

/// What the host needs after a frame.
#[derive(Clone, Debug, Default)]
pub struct UiOutput {
    /// The free viewport rect in egui points. Place the 3D camera here. `None` when the viewport
    /// panel is hidden (a tab that is not active, or closed).
    pub viewport: Option<egui::Rect>,
    /// egui is using the pointer (a drag in a panel, a popup under it): don't pick in the scene.
    pub wants_pointer: bool,
    /// A text field has the keyboard: don't feed keys to the game.
    pub wants_keyboard: bool,
    /// The pointer is over the viewport and nothing from egui is above it.
    pub pointer_over_viewport: bool,
    pub tool: Tool,
    pub snap: bool,
    pub snap_step: f32,
}

/// What is persisted between sessions (`save_state` / `load_state`).
#[derive(Serialize, Deserialize)]
struct Persisted {
    layout: Layout<Panel>,
    tool: Tool,
    snap: bool,
    snap_step: f32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DialogKind {
    Open,
    SaveAs,
}

struct Dialog {
    kind: DialogKind,
    text: String,
    focus_pending: bool,
}

/// Seconds between polls of the backend (tree, selection, diagnostics) when nothing was edited.
const POLL_SECS: f64 = 0.25;

pub struct EditorUi {
    layout: Layout<Panel>,
    undo: UndoStack,
    keymap: Keymap,
    palette: CommandPalette,
    toasts: Toasts,
    tool: Tool,
    snap: bool,
    snap_step: f32,
    dialog: Option<Dialog>,

    // Cached backend state.
    tree: Vec<TreeNode>,
    tree_rev: u64,
    nodes: Nodes,
    selection: Vec<EntityId>,
    components: Result<Vec<ComponentDoc>, String>,
    comp_for: Option<EntityId>,
    types: Vec<(String, TypeSchema)>,
    assets: Vec<AssetEntry>,
    diagnostics: Vec<Diagnostic>,
    diag_cursor: u64,
    level: editor_proto::LevelInfo,
    play: PlayState,

    // Panel state.
    outliner: outliner::OutlinerState,
    details: details::DetailsState,
    content: content::ContentState,
    output: output::OutputState,

    // Refresh bookkeeping.
    dirty_tree: bool,
    dirty_components: bool,
    dirty_assets: bool,
    last_poll: f64,
    now: f64,
    themed: bool,
}

impl Default for EditorUi {
    fn default() -> Self {
        Self::new()
    }
}

impl EditorUi {
    pub fn new() -> Self {
        EditorUi {
            layout: default_layout(),
            undo: UndoStack::new(),
            keymap: Keymap::new(Platform::current(), COMMANDS.iter().map(|c| (c.id, c.shortcut))),
            palette: CommandPalette::new().hint("Type a command"),
            toasts: Toasts::new(),
            tool: Tool::Move,
            snap: false,
            snap_step: 0.5,
            dialog: None,
            tree: Vec::new(),
            tree_rev: 0,
            nodes: Nodes::default(),
            selection: Vec::new(),
            components: Ok(Vec::new()),
            comp_for: None,
            types: Vec::new(),
            assets: Vec::new(),
            diagnostics: Vec::new(),
            diag_cursor: 0,
            level: Default::default(),
            play: PlayState::Editing,
            outliner: Default::default(),
            details: Default::default(),
            content: content::ContentState { dir_changed: true, ..Default::default() },
            output: Default::default(),
            dirty_tree: true,
            dirty_components: true,
            dirty_assets: true,
            last_poll: f64::NEG_INFINITY,
            now: 0.0,
            themed: false,
        }
    }

    /// Persisted layout and tool settings as JSON.
    pub fn save_state(&self) -> String {
        serde_json::to_string(&Persisted { layout: self.layout.clone(), tool: self.tool, snap: self.snap, snap_step: self.snap_step }).unwrap_or_default()
    }

    /// Restore `save_state` output. A layout that is invalid or lacks the viewport is rejected
    /// (the current one stays) and the reason returned.
    pub fn load_state(&mut self, json: &str) -> Result<(), String> {
        let p: Persisted = serde_json::from_str(json).map_err(|e| e.to_string())?;
        p.layout.validate().map_err(|e| e.to_string())?;
        if !p.layout.contains(&Panel::Viewport) {
            return Err("layout has no viewport".into());
        }
        self.layout = p.layout;
        self.tool = p.tool;
        self.snap = p.snap;
        if p.snap_step.is_finite() && p.snap_step > 0.0 {
            self.snap_step = p.snap_step;
        }
        Ok(())
    }

    pub fn layout(&self) -> &Layout<Panel> {
        &self.layout
    }
    pub fn reset_layout(&mut self) {
        self.layout = default_layout();
    }

    pub fn can_undo(&self) -> bool {
        self.undo.can_undo()
    }
    pub fn can_redo(&self) -> bool {
        self.undo.can_redo()
    }
    pub fn undo_depth(&self) -> usize {
        self.undo.len()
    }
    pub fn selection(&self) -> &[EntityId] {
        &self.selection
    }
    pub fn tool(&self) -> Tool {
        self.tool
    }
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// Run a command (what the toolbar, palette and shortcuts do). Applies on the next `show`.
    pub fn run(&mut self, ctx: &Context, backend: &mut dyn EditorBackend, cmd: Cmd) {
        self.process(ctx, backend, vec![Req::Cmd(cmd)]);
    }

    /// Record an op the backend already applied (a viewport gizmo drag, a placed asset). `key`
    /// merges consecutive drags of the same thing; call [`EditorUi::seal_undo`] on release.
    pub fn record_applied(&mut self, label: &str, op: Op, key: Option<String>) {
        self.undo.record(label, op, key, self.now);
        self.dirty_components = true;
        self.dirty_tree = true;
    }
    /// End the current drag so the next edit starts a new undo step.
    pub fn seal_undo(&mut self) {
        self.undo.seal();
    }

    /// Re-read everything from the backend on the next frame.
    pub fn refresh(&mut self) {
        self.dirty_tree = true;
        self.dirty_components = true;
        self.dirty_assets = true;
        self.last_poll = f64::NEG_INFINITY;
    }

    /// Draw the editor over the whole egui screen. Call once per egui pass.
    pub fn show(&mut self, ctx: &Context, backend: &mut dyn EditorBackend) -> UiOutput {
        if !self.themed {
            tokens::install(ctx, &Tokens::light(), &Tokens::dark(), ThemeMode::Dark);
            self.themed = true;
        }
        self.now = ctx.input(|i| i.time);
        self.poll(backend);

        let mut reqs: Vec<Req> = Vec::new();
        for _ in 0..4 {
            match dispatch(ctx, &self.keymap).as_deref().and_then(Cmd::from_id) {
                Some(c) => reqs.push(Req::Cmd(c)),
                None => break,
            }
        }

        let mut root = Ui::new(ctx.clone(), "editor_root".into(), egui::UiBuilder::new().layer_id(egui::LayerId::background()).max_rect(ctx.content_rect()));
        self.toolbar(&mut root, &mut reqs);
        self.status_bar(&mut root);

        // The dock: panels fill their own background; the viewport body stays transparent.
        let mut viewport = None;
        let mut clear_output = false;
        let layout = std::mem::take(&mut self.layout);
        let actions;
        {
            let ui = &mut root;
            let mut style = DockStyle::from_ui(ui);
            style.background = egui::Color32::TRANSPARENT;
            let panel_fill = tokens::current(ctx).surface.panel;
            let out = DockArea::new(egui::Id::new("editor_dock")).show(
                ui,
                &layout,
                &style,
                |p| p.title().to_owned(),
                |p| if *p == Panel::Viewport { Permissions::PROTECTED } else { Permissions::default() },
                |ui, panel| {
                    if *panel != Panel::Viewport {
                        ui.painter().rect_filled(ui.max_rect(), 0.0, panel_fill);
                    }
                    match panel {
                        Panel::Viewport => viewport = Some(ui.max_rect()),
                        Panel::Outliner => {
                            let v = outliner::View { tree: &self.tree, tree_rev: self.tree_rev, nodes: &self.nodes, selection: &self.selection };
                            outliner::show(ui, &mut self.outliner, &v, &mut reqs);
                        }
                        Panel::Details => {
                            let id = self.selection.first().copied();
                            let v = details::View {
                                id,
                                info: id.and_then(|i| self.nodes.info.get(&i)),
                                extra_selected: self.selection.len().saturating_sub(1),
                                components: &self.components,
                                types: &self.types,
                            };
                            details::show(ui, &mut self.details, &v, &mut reqs);
                        }
                        Panel::Content => content::show(ui, &mut self.content, &self.assets, &mut reqs),
                        Panel::Output => output::show(ui, &mut self.output, &self.diagnostics, &mut clear_output, &mut reqs),
                        Panel::Logic => logic::show(ui),
                    }
                },
            );
            actions = out.actions;
        }
        self.layout = layout;
        for a in actions {
            let _ = self.layout.apply(a);
        }
        if clear_output {
            self.diagnostics.clear();
        }

        // Overlays.
        let infos = self.palette.is_open().then(|| self.command_infos());
        if let Some(infos) = &infos
            && let Some(id) = self.palette.show(ctx, infos, 0, Platform::current())
            && let Some(c) = Cmd::from_id(&id)
        {
            reqs.push(Req::Cmd(c));
        }
        self.dialog_ui(ctx, backend);
        self.toasts.show(ctx);

        if !reqs.is_empty() {
            ctx.request_repaint();
        }
        self.process(ctx, backend, reqs);
        ctx.request_repaint_after(std::time::Duration::from_secs_f64(POLL_SECS));

        let pointer = ctx.input(|i| i.pointer.hover_pos());
        let pointer_over_viewport = match (pointer, viewport) {
            (Some(p), Some(r)) => r.contains(p) && ctx.layer_id_at(p).is_none_or(|l| l.order == egui::Order::Background),
            _ => false,
        };
        UiOutput {
            viewport,
            wants_pointer: ctx.egui_wants_pointer_input() && !pointer_over_viewport,
            wants_keyboard: ctx.egui_wants_keyboard_input(),
            pointer_over_viewport,
            tool: self.tool,
            snap: self.snap,
            snap_step: self.snap_step,
        }
    }

    // ---- polling -------------------------------------------------------------------------

    fn poll(&mut self, backend: &mut dyn EditorBackend) {
        let due = self.now - self.last_poll >= POLL_SECS;
        if !(due || self.dirty_tree || self.dirty_components || self.dirty_assets) {
            return;
        }
        if due || self.dirty_tree {
            let filter = TreeFilter { text: self.outliner.filter.clone(), ..Default::default() };
            let tree = backend.tree(&filter);
            if tree != self.tree {
                self.nodes = Nodes::build(&tree);
                self.tree = tree;
                self.tree_rev += 1;
            }
            self.dirty_tree = false;
        }
        if due {
            let sel = backend.selection();
            if sel != self.selection {
                self.selection = sel;
                self.dirty_components = true;
            }
            self.level = backend.level();
            self.play = backend.play_state();
            let (next, new) = backend.diagnostics(self.diag_cursor);
            self.diag_cursor = next;
            if !new.is_empty() {
                self.diagnostics.extend(new);
                let over = self.diagnostics.len().saturating_sub(output::MAX_ENTRIES);
                self.diagnostics.drain(..over);
            }
            if self.types.is_empty() {
                self.types = backend.component_types();
            }
        }
        // Drop selected ids that no longer exist (undo of a spawn, a reload).
        let before = self.selection.len();
        let nodes = &self.nodes;
        self.selection.retain(|id| nodes.info.contains_key(id));
        if self.selection.len() != before {
            backend.set_selection(&self.selection);
            self.dirty_components = true;
        }
        if due || self.dirty_components {
            let first = self.selection.first().copied();
            if first != self.comp_for || self.dirty_components || due {
                self.components = match first {
                    Some(id) => backend.components(id),
                    None => Ok(Vec::new()),
                };
                self.comp_for = first;
            }
            self.dirty_components = false;
        }
        if due || self.dirty_assets || self.content.dir_changed {
            self.assets = backend.assets(&self.content.dir);
            self.dirty_assets = false;
            self.content.dir_changed = false;
        }
        if due {
            self.last_poll = self.now;
        }
    }

    // ---- chrome ----------------------------------------------------------------------------

    fn toolbar(&mut self, root: &mut Ui, reqs: &mut Vec<Req>) {
        let t = tokens::current(root.ctx());
        let frame = egui::Frame::new().fill(t.surface.panel).inner_margin(egui::Margin::symmetric(t.space.md as i8, 4));
        egui::Panel::top("editor_toolbar").resizable(false).show_separator_line(true).frame(frame).show(root, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = t.space.sm;
                let playing = self.play != PlayState::Editing;
                let label = match self.play {
                    PlayState::Editing => "Play",
                    PlayState::Building => "Building... (Stop)",
                    PlayState::Playing => "Stop",
                };
                let btn = egui::Button::new(egui::RichText::new(label).color(t.text.on_accent)).fill(if playing { t.status.danger } else { t.accent });
                if ui.add(btn).on_hover_text(tip(Cmd::PlayStop)).clicked() {
                    reqs.push(Req::Cmd(Cmd::PlayStop));
                }
                ui.separator();
                if ui.button("Save").on_hover_text(tip(Cmd::Save)).clicked() {
                    reqs.push(Req::Cmd(Cmd::Save));
                }
                if ui.button("Open").on_hover_text(tip(Cmd::Open)).clicked() {
                    reqs.push(Req::Cmd(Cmd::Open));
                }
                ui.separator();
                if ui.add_enabled(self.undo.can_undo(), egui::Button::new("Undo")).on_hover_text(tip(Cmd::Undo)).clicked() {
                    reqs.push(Req::Cmd(Cmd::Undo));
                }
                if ui.add_enabled(self.undo.can_redo(), egui::Button::new("Redo")).on_hover_text(tip(Cmd::Redo)).clicked() {
                    reqs.push(Req::Cmd(Cmd::Redo));
                }
                ui.separator();
                for (tool, cmd, name) in [(Tool::Move, Cmd::ToolMove, "Move"), (Tool::Rotate, Cmd::ToolRotate, "Rotate"), (Tool::Scale, Cmd::ToolScale, "Scale")] {
                    if ui.selectable_label(self.tool == tool, name).on_hover_text(tip(cmd)).clicked() {
                        reqs.push(Req::Cmd(cmd));
                    }
                }
                ui.separator();
                if ui.selectable_label(self.snap, "Snap").on_hover_text(tip(Cmd::ToggleSnap)).clicked() {
                    reqs.push(Req::Cmd(Cmd::ToggleSnap));
                }
                if self.snap {
                    let mut step = self.snap_step;
                    if ui.add(egui::DragValue::new(&mut step).speed(0.05).range(0.01..=100.0)).changed() {
                        self.snap_step = step;
                        reqs.push(Req::Cmd(Cmd::ToggleSnap));
                        reqs.push(Req::Cmd(Cmd::ToggleSnap));
                    }
                }
                ui.separator();
                if ui.button("Commands").on_hover_text(tip(Cmd::Palette)).clicked() {
                    reqs.push(Req::Cmd(Cmd::Palette));
                }
            });
        });
    }

    fn status_bar(&mut self, root: &mut Ui) {
        let level = match (&self.level.path, self.level.dirty) {
            (Some(p), true) => format!("{p} *"),
            (Some(p), false) => p.clone(),
            (None, _) => "Unsaved level".to_owned(),
        };
        let play = match self.play {
            PlayState::Editing => "Editing",
            PlayState::Building => "Building",
            PlayState::Playing => "Playing",
        };
        let undo = self.undo.undo_label().map_or("Nothing to undo".to_owned(), |l| format!("Undo: {l}"));
        let sel = format!("{} selected", self.selection.len());
        StatusBar::new("editor.status").show(
            root,
            |ui| {
                ashlar_ui::status_bar::text(ui, "status.level", &level);
                ashlar_ui::status_bar::text(ui, "status.play", play);
            },
            |ui| {
                ashlar_ui::status_bar::text(ui, "status.sel", &sel);
                ashlar_ui::status_bar::text(ui, "status.undo", &undo);
            },
        );
    }

    fn command_infos(&self) -> Vec<CommandInfo> {
        COMMANDS
            .iter()
            .map(|c| {
                let (enabled, why) = match c.cmd {
                    Cmd::Undo if !self.undo.can_undo() => (false, Some("nothing to undo")),
                    Cmd::Redo if !self.undo.can_redo() => (false, Some("nothing to redo")),
                    Cmd::Delete | Cmd::Rename | Cmd::Focus if self.selection.is_empty() => (false, Some("nothing selected")),
                    _ => (true, None),
                };
                CommandInfo {
                    id: c.id.to_owned(),
                    label: c.label.to_owned(),
                    menu: vec![c.menu.to_owned()],
                    shortcut: c.shortcut.map(str::to_owned),
                    params_schema: serde_json::Value::Null,
                    params_text: None,
                    enabled,
                    disabled_reason: why.map(str::to_owned),
                    mutates: c.mutates,
                }
            })
            .collect()
    }

    fn dialog_ui(&mut self, ctx: &Context, backend: &mut dyn EditorBackend) {
        let Some(d) = self.dialog.as_mut() else { return };
        let title = if d.kind == DialogKind::Open { "Open level" } else { "Save level as" };
        let mut action: Option<bool> = None;
        egui::Window::new(title).collapsible(false).resizable(false).anchor(egui::Align2::CENTER_CENTER, egui::Vec2::ZERO).show(ctx, |ui| {
            ui.label("Path relative to the game folder (e.g. levels/valley.level.ron)");
            let r = ui.add(egui::TextEdit::singleline(&mut d.text).desired_width(360.0).id(egui::Id::new("editor.dialog.path")));
            if d.focus_pending {
                r.request_focus();
                d.focus_pending = false;
            }
            let enter = r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
            ui.horizontal(|ui| {
                let ok = ui.add_enabled(!d.text.trim().is_empty(), egui::Button::new(if d.kind == DialogKind::Open { "Open" } else { "Save" })).clicked();
                if ok || (enter && !d.text.trim().is_empty()) {
                    action = Some(true);
                }
                if ui.button("Cancel").clicked() || ui.input(|i| i.key_pressed(Key::Escape)) {
                    action = Some(false);
                }
            });
        });
        match action {
            Some(true) => {
                let (kind, path) = (d.kind, d.text.trim().to_owned());
                self.dialog = None;
                match kind {
                    DialogKind::Open => match backend.open_level(&path) {
                        Ok(()) => {
                            self.undo.clear();
                            self.selection.clear();
                            self.refresh();
                            self.toasts.success(format!("Opened {path}"));
                        }
                        Err(e) => {
                            self.toasts.error(format!("Open failed: {e}"));
                        }
                    },
                    DialogKind::SaveAs => self.save(backend, Some(&path)),
                }
            }
            Some(false) => self.dialog = None,
            None => {}
        }
    }

    // ---- requests --------------------------------------------------------------------------

    fn process(&mut self, ctx: &Context, backend: &mut dyn EditorBackend, reqs: Vec<Req>) {
        for r in reqs {
            match r {
                Req::Edit { op, label, key, seal } => self.edit(backend, op, &label, key, seal),
                Req::Select(ids) => {
                    self.selection = ids;
                    backend.set_selection(&self.selection);
                    self.dirty_components = true;
                }
                Req::Place(path) => match backend.place_asset(&path, editor_proto::Placement::default()) {
                    Ok(op) => {
                        self.undo.record("Place asset", op, None, self.now);
                        self.dirty_tree = true;
                        self.toasts.info(format!("Placed {path}"));
                    }
                    Err(e) => {
                        self.toasts.error(format!("Place failed: {e}"));
                    }
                },
                Req::Cmd(c) => self.command(ctx, backend, c),
                Req::TreeFilterChanged => self.dirty_tree = true,
                Req::Copy(text) => ctx.copy_text(text),
            }
        }
    }

    fn edit(&mut self, backend: &mut dyn EditorBackend, op: Op, label: &str, key: Option<String>, seal: bool) {
        match backend.apply(&op) {
            Ok(()) => {
                if !matches!(op, Op::SetComponent { .. }) {
                    self.dirty_tree = true;
                }
                self.dirty_components = true;
                self.level.dirty = true;
                self.undo.record(label, op, key, self.now);
                if seal {
                    self.undo.seal();
                }
            }
            Err(e) => {
                self.toasts.error(format!("{label}: {e}"));
            }
        }
    }

    fn delete(&mut self, backend: &mut dyn EditorBackend, ids: &[EntityId]) {
        // Drop ids below another selected id (their snapshot is part of the parent's) and
        // generated entities.
        let set: HashSet<EntityId> = ids.iter().copied().collect();
        let roots: Vec<EntityId> = ids
            .iter()
            .copied()
            .filter(|id| self.nodes.info.get(id).is_some_and(|n| !n.generated))
            .filter(|id| {
                let mut cur = self.nodes.info.get(id).and_then(|n| n.parent);
                while let Some(p) = cur {
                    if set.contains(&p) {
                        return false;
                    }
                    cur = self.nodes.info.get(&p).and_then(|n| n.parent);
                }
                true
            })
            .collect();
        if roots.is_empty() {
            if !ids.is_empty() {
                self.toasts.warning("Generated entities can't be deleted");
            }
            return;
        }
        let mut ops = Vec::new();
        for id in &roots {
            match backend.snapshot(*id) {
                Ok(snapshot) => ops.push(Op::Despawn { snapshot }),
                Err(e) => {
                    self.toasts.error(format!("Delete failed: {e}"));
                    return;
                }
            }
        }
        let op = if ops.len() == 1 { ops.remove(0) } else { Op::Batch(ops) };
        self.edit(backend, op, "Delete", None, true);
        self.selection.clear();
        backend.set_selection(&[]);
    }

    fn save(&mut self, backend: &mut dyn EditorBackend, path: Option<&str>) {
        match backend.save_level(path) {
            Ok(()) => {
                self.level = backend.level();
                self.toasts.success("Level saved");
            }
            Err(e) => {
                self.toasts.error(format!("Save failed: {e}"));
            }
        }
    }

    fn command(&mut self, ctx: &Context, backend: &mut dyn EditorBackend, cmd: Cmd) {
        match cmd {
            Cmd::Save => {
                self.level = backend.level();
                if self.level.path.is_some() {
                    self.save(backend, None);
                } else {
                    self.dialog = Some(Dialog { kind: DialogKind::SaveAs, text: "levels/new.level.ron".into(), focus_pending: true });
                }
            }
            Cmd::SaveAs => {
                let text = backend.level().path.unwrap_or_else(|| "levels/new.level.ron".into());
                self.dialog = Some(Dialog { kind: DialogKind::SaveAs, text, focus_pending: true });
            }
            Cmd::Open => {
                let text = backend.level().path.unwrap_or_else(|| "levels/".into());
                self.dialog = Some(Dialog { kind: DialogKind::Open, text, focus_pending: true });
            }
            Cmd::Undo => match self.undo.undo() {
                Some(op) => match backend.apply(&op) {
                    Ok(()) => self.after_history(),
                    Err(e) => {
                        self.undo.restore_undo();
                        self.toasts.error(format!("Undo failed: {e}"));
                    }
                },
                None => {}
            },
            Cmd::Redo => match self.undo.redo() {
                Some(op) => match backend.apply(&op) {
                    Ok(()) => self.after_history(),
                    Err(e) => {
                        self.undo.restore_redo();
                        self.toasts.error(format!("Redo failed: {e}"));
                    }
                },
                None => {}
            },
            Cmd::PlayStop => match backend.play_state() {
                PlayState::Editing => {
                    if let Err(e) = backend.play() {
                        self.toasts.error(format!("Play failed: {e}"));
                    }
                }
                PlayState::Building | PlayState::Playing => backend.stop(),
            },
            Cmd::ToolMove => self.set_tool(backend, Tool::Move),
            Cmd::ToolRotate => self.set_tool(backend, Tool::Rotate),
            Cmd::ToolScale => self.set_tool(backend, Tool::Scale),
            Cmd::ToggleSnap => {
                self.snap = !self.snap;
                backend.viewport(ViewportCmd::SetSnap { enabled: self.snap, step: self.snap_step });
            }
            Cmd::Focus => backend.viewport(ViewportCmd::FocusSelection),
            Cmd::Delete => {
                let ids = self.selection.clone();
                self.delete(backend, &ids);
            }
            Cmd::Rename => {
                if let Some(id) = self.selection.last().copied()
                    && let Some(info) = self.nodes.info.get(&id)
                    && !info.generated
                {
                    let name = info.name.clone();
                    self.outliner.start_rename(id, &name);
                    self.outliner.scroll_to(id);
                }
            }
            Cmd::Palette => self.palette.toggle(),
        }
        ctx.request_repaint();
    }

    fn set_tool(&mut self, backend: &mut dyn EditorBackend, tool: Tool) {
        self.tool = tool;
        backend.viewport(ViewportCmd::SetTool(tool));
    }

    fn after_history(&mut self) {
        self.dirty_tree = true;
        self.dirty_components = true;
        self.level.dirty = true;
    }
}

fn tip(cmd: Cmd) -> String {
    let s = cmd.spec();
    match s.shortcut.and_then(|sc| ashlar_command::shortcut::display(sc, Platform::current())) {
        Some(k) => format!("{} ({k})", s.label),
        None => s.label.to_owned(),
    }
}
