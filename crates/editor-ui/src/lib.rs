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

mod chrome;
mod content;
mod details;
mod docs;
mod logic;
mod model;
mod modes;
mod outliner;
mod output;
mod place;
mod props;
mod settings;
mod tool;
mod toast;
mod undo;

pub mod mock;

pub use settings::{Prefs, Theme};

use std::collections::HashSet;

use ashlar_command::shortcut::Platform;
use ashlar_command::{CommandInfo, Keymap};
use ashlar_ui::commands::{CommandPalette, dispatch};
use ashlar_ui::docking::{Action, DockArea, DockStyle, Layout, Node, Permissions};
use ashlar_ui::layout::{SplitAxis, SplitSize};
use ashlar_ui::toasts::Toasts;
use ashlar_ui::tokens::{self, ThemeMode, Tokens};
use editor_proto::{AssetEntry, ComponentDoc, Diagnostic, EditorBackend, EntityId, Op, PlaceableDoc, PlayState, SettingsGroup, Tool, ToolDoc, TreeFilter, TreeNode, TypeSchema, ViewInfo, ViewportCmd};
use egui::{Context, Key, Ui};
use serde::{Deserialize, Serialize};

use model::{COMMANDS, Cmd, Mode, Nodes, Req};
use undo::UndoStack;

pub use model::Cmd as Command;

/// The dockable panels. The viewport is the transparent hole the host draws the 3D view into
/// (the first document tab); Content, Output and Messages normally live in the drawer and are
/// only panels of the dock while it is docked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Panel {
    Viewport,
    Outliner,
    Details,
    Content,
    Output,
    /// Editor, logic and build messages. Stub until WP-D.
    Messages,
    /// Mode palettes (Select, Landscape, Foliage, Splines, Place): tool settings and the Place
    /// palette.
    Modes,
    /// Look, terrain, streaming: a tab beside Details.
    WorldSettings,
}

impl Panel {
    pub const ALL: [Panel; 8] = [Panel::Viewport, Panel::Outliner, Panel::Details, Panel::Content, Panel::Output, Panel::Messages, Panel::Modes, Panel::WorldSettings];
    pub fn title(self) -> &'static str {
        match self {
            Panel::Viewport => "Viewport",
            Panel::Outliner => "Outliner",
            Panel::Details => "Details",
            Panel::Content => "Content",
            Panel::Output => "Output",
            Panel::Messages => "Messages",
            Panel::Modes => "Modes",
            Panel::WorldSettings => "World Settings",
        }
    }
}

/// A named arrangement of the dock (Window > Layouts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayoutPreset {
    /// Modes left, viewport centre, Outliner over Details / World Settings right, drawer closed.
    Default,
    /// A wide Modes panel for sculpting and painting, World Settings in front.
    Landscape,
    /// A narrow Outliner, a wide centre for Logic tabs, the drawer open for dragging assets.
    Logic,
}

impl LayoutPreset {
    pub const ALL: [LayoutPreset; 3] = [LayoutPreset::Default, LayoutPreset::Landscape, LayoutPreset::Logic];
    pub fn label(self) -> &'static str {
        match self {
            LayoutPreset::Default => "Default",
            LayoutPreset::Landscape => "Landscape",
            LayoutPreset::Logic => "Logic",
        }
    }
    pub fn from_name(name: &str) -> Option<LayoutPreset> {
        LayoutPreset::ALL.into_iter().find(|p| p.label().eq_ignore_ascii_case(name))
    }
    pub fn build(self) -> Layout<Panel> {
        let tabs = |panels: Vec<Panel>, active: usize| Node::Tabs { panels, active };
        let split = |axis, size, a, b| Node::Split { axis, size, first: Box::new(a), second: Box::new(b) };
        let view = tabs(vec![Panel::Viewport], 0);
        let root = match self {
            LayoutPreset::Default => {
                let right = split(SplitAxis::Vertical, SplitSize::Ratio(0.42), tabs(vec![Panel::Outliner], 0), tabs(vec![Panel::Details, Panel::WorldSettings], 0));
                split(SplitAxis::Horizontal, SplitSize::FixedFirst(280.0), tabs(vec![Panel::Modes], 0), split(SplitAxis::Horizontal, SplitSize::FixedSecond(340.0), view, right))
            }
            LayoutPreset::Landscape => {
                let right = split(SplitAxis::Vertical, SplitSize::Ratio(0.25), tabs(vec![Panel::Outliner], 0), tabs(vec![Panel::Details, Panel::WorldSettings], 1));
                split(SplitAxis::Horizontal, SplitSize::FixedFirst(340.0), tabs(vec![Panel::Modes], 0), split(SplitAxis::Horizontal, SplitSize::FixedSecond(340.0), view, right))
            }
            LayoutPreset::Logic => {
                let right = tabs(vec![Panel::Details, Panel::WorldSettings], 0);
                split(SplitAxis::Horizontal, SplitSize::FixedFirst(240.0), tabs(vec![Panel::Outliner, Panel::Modes], 0), split(SplitAxis::Horizontal, SplitSize::FixedSecond(340.0), view, right))
            }
        };
        Layout { root: Some(root), floating: vec![] }
    }
}

/// The default arrangement (see [`LayoutPreset::Default`]).
pub fn default_layout() -> Layout<Panel> {
    LayoutPreset::Default.build()
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
    /// 2 since the Modes / drawer layout; older saves are dropped for the default layout.
    #[serde(default)]
    version: u32,
    layout: Layout<Panel>,
    tool: Tool,
    snap: bool,
    #[serde(default)]
    recent: Vec<String>,
}

const STATE_VERSION: u32 = 2;

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

/// Most entities the command palette lists.
const MAX_PALETTE_ENTITIES: usize = 2000;

/// Seconds between polls of the backend (tree, selection, diagnostics) when nothing was edited.
const POLL_SECS: f64 = 0.25;

pub struct EditorUi {
    layout: Layout<Panel>,
    undo: UndoStack,
    keymap: Keymap,
    palette: CommandPalette,
    toasts: Toasts,
    dedupe: toast::Dedupe,
    tool: Tool,
    snap: bool,
    snap_step: f32,
    dialog: Option<Dialog>,

    // Cached backend state.
    tree: Vec<TreeNode>,
    display: Vec<TreeNode>,
    grouped: bool,
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
    view: ViewInfo,
    help_open: bool,
    about_open: bool,
    hint_open: bool,
    recent: Vec<String>,
    last_msg: Option<String>,
    models: Vec<AssetEntry>,
    tools: Vec<ToolDoc>,
    active_tool: Option<String>,
    placeables: Vec<PlaceableDoc>,
    /// World and project settings groups, refreshed while a settings surface is open.
    groups: Vec<SettingsGroup>,
    landscape_tool: String,
    drawer: chrome::Drawer,
    docs: docs::Docs,
    windows: settings::SettingsWindows,
    prefs: Prefs,
    /// Prefs were loaded from disk and still have to reach the backend (camera speed, grid).
    prefs_pending: bool,
    prefs_changed: Option<settings::PrefsChange>,
    help_filter: String,
    themed_for: Option<Theme>,

    // Panel state.
    outliner: outliner::OutlinerState,
    details: details::DetailsState,
    content: content::ContentState,
    output: output::OutputState,
    logic: logic::LogicState,
    place: place::PlaceState,

    // Refresh bookkeeping.
    last_viewport: Option<egui::Rect>,
    dirty_tree: bool,
    dirty_components: bool,
    dirty_assets: bool,
    last_poll: f64,
    now: f64,
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
            palette: CommandPalette::new().hint("Type a command, entity or asset"),
            toasts: Toasts::new(),
            dedupe: toast::Dedupe::default(),
            tool: Tool::Select,
            snap: false,
            snap_step: 0.5,
            dialog: None,
            tree: Vec::new(),
            display: Vec::new(),
            grouped: false,
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
            view: ViewInfo::default(),
            help_open: false,
            about_open: false,
            hint_open: true,
            recent: Vec::new(),
            last_msg: None,
            models: Vec::new(),
            tools: Vec::new(),
            active_tool: None,
            placeables: Vec::new(),
            groups: Vec::new(),
            landscape_tool: "sculpt".into(),
            drawer: Default::default(),
            docs: Default::default(),
            windows: Default::default(),
            prefs: Prefs::default(),
            prefs_pending: false,
            prefs_changed: None,
            help_filter: String::new(),
            themed_for: None,
            outliner: Default::default(),
            details: Default::default(),
            content: content::ContentState {
                dir_changed: true,
                ..Default::default()
            },
            output: Default::default(),
            logic: Default::default(),
            place: Default::default(),
            last_viewport: None,
            dirty_tree: true,
            dirty_components: true,
            dirty_assets: true,
            last_poll: f64::NEG_INFINITY,
            now: 0.0,
        }
    }

    /// Persisted layout and tool settings as JSON.
    pub fn save_state(&self) -> String {
        serde_json::to_string(&Persisted { version: STATE_VERSION, layout: self.layout.clone(), tool: self.tool, snap: self.snap, recent: self.recent.clone() }).unwrap_or_default()
    }

    /// Editor preferences (`editor_prefs.json`) as JSON: look and feel and viewport defaults.
    pub fn prefs_json(&self) -> String {
        let mut p = self.prefs.clone();
        p.snap_step = self.snap_step;
        p.show_hint = self.hint_open;
        if !self.prefs_pending {
            p.camera_speed = self.view.camera_speed;
            p.show_grid = self.view.show_grid;
            p.show_all_scenery = self.view.show_all_scenery;
        }
        serde_json::to_string_pretty(&p).unwrap_or_default()
    }

    /// Restore `prefs_json` output; values are clamped into range. Camera speed and the grid
    /// reach the backend on the next frame.
    pub fn load_prefs(&mut self, json: &str) -> Result<(), String> {
        let p: Prefs = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let p = p.sanitized();
        self.snap_step = p.snap_step;
        self.hint_open = p.show_hint;
        self.prefs = p;
        self.prefs_pending = true;
        Ok(())
    }

    /// Restore `save_state` output. A layout that is invalid or lacks the viewport is rejected
    /// (the current one stays) and the reason returned.
    pub fn load_state(&mut self, json: &str) -> Result<(), String> {
        let p: Persisted = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if p.version < STATE_VERSION {
            return Err("saved by an older editor (before the Modes layout); using the default layout".into());
        }
        p.layout.validate().map_err(|e| e.to_string())?;
        if !p.layout.contains(&Panel::Viewport) {
            return Err("layout has no viewport".into());
        }
        self.layout = p.layout;
        self.recent = p.recent;
        self.tool = p.tool;
        self.snap = p.snap;
        Ok(())
    }

    /// Set the Content Browser view: folder, grid or list (`None` keeps it), type filter (empty =
    /// all types), search text and the selected tile's path. For scripts and tests.
    pub fn content_show(&mut self, dir: &str, list: Option<bool>, kinds: &[editor_proto::AssetKind], search: &str, select: Option<&str>) {
        self.content.set_dir(dir);
        if let Some(l) = list {
            self.content.list = l;
        }
        self.content.kinds = kinds.iter().copied().collect();
        self.content.search = search.to_owned();
        self.content.selected = select.map(str::to_owned);
    }

    /// Open a Logic (`.logic.ron`) or Script tab in the document area and bring it to the front.
    /// The tab body is the Logic editor's (`logic::show`).
    pub fn open_logic_tab(&mut self, path: &str) {
        self.docs.open(path);
    }

    /// Paths of the open document tabs (not the Level tab), in tab order.
    pub fn open_tabs(&self) -> Vec<String> {
        self.docs.tabs.iter().map(|t| t.path.clone()).collect()
    }

    /// Brings the Level viewport tab to the front.
    pub fn show_level_tab(&mut self) {
        self.docs.active = 0;
    }

    pub fn layout(&self) -> &Layout<Panel> {
        &self.layout
    }
    pub fn reset_layout(&mut self) {
        self.apply_preset(LayoutPreset::Default);
    }

    /// Switch to a named layout. The document tabs stay; the drawer opens for Logic.
    pub fn apply_preset(&mut self, preset: LayoutPreset) {
        self.layout = preset.build();
        self.drawer.open = preset == LayoutPreset::Logic;
        self.drawer.tab = Panel::Content;
    }

    /// Switch layout by name (`default`, `landscape`, `logic`). For scripts.
    pub fn apply_layout_name(&mut self, name: &str) -> Result<(), String> {
        let p = LayoutPreset::from_name(name).ok_or_else(|| format!("no layout `{name}` (have Default, Landscape, Logic)"))?;
        self.apply_preset(p);
        Ok(())
    }

    /// Open or close a window by name: `help`, `about`, `project settings`, `preferences`,
    /// `palette`. For scripts.
    pub fn set_window(&mut self, name: &str, open: bool) -> Result<(), String> {
        match name.to_ascii_lowercase().replace(['_', '-'], " ").as_str() {
            "help" | "controls" => self.help_open = open,
            "about" => self.about_open = open,
            "project settings" | "project" => self.windows.project = open,
            "preferences" | "editor preferences" | "prefs" => self.windows.prefs = open,
            "palette" | "commands" => {
                if open != self.palette.is_open() {
                    self.palette.toggle();
                }
            }
            other => return Err(format!("no window `{other}` (help, about, project settings, preferences, palette)")),
        }
        Ok(())
    }

    /// Bring a panel's tab to the front (opening it when closed). `name` is the panel title,
    /// case-insensitive (`"Details"`, `"World Settings"`). `Content`, `Output` and `Messages`
    /// open the drawer (or the docked panel); `Logic` brings the first Logic tab forward. For
    /// scripts and tests.
    pub fn show_panel(&mut self, name: &str) -> Result<(), String> {
        let lower = name.to_ascii_lowercase();
        match lower.as_str() {
            "logic" => {
                let i = self.docs.tabs.iter().position(|t| t.kind == docs::DocKind::Logic).ok_or("no Logic tab is open (open a .logic.ron from the Content drawer)")?;
                self.docs.active = i + 1;
                return Ok(());
            }
            "level" => {
                self.docs.active = 0;
                return Ok(());
            }
            "tool" | "place" => return self.show_panel("Modes"),
            "world" => return self.show_panel("World Settings"),
            _ => {}
        }
        let panel = Panel::ALL.into_iter().find(|p| p.title().eq_ignore_ascii_case(name)).ok_or_else(|| format!("no panel `{name}`"))?;
        if chrome::DRAWER_TABS.contains(&panel) && !self.drawer_docked() {
            self.drawer.open = true;
            self.drawer.tab = panel;
            return Ok(());
        }
        if self.layout.apply(Action::Activate { panel }).is_ok() {
            return Ok(());
        }
        self.layout.apply(Action::Open { panel, anchor: None }).map_err(|e| format!("{e:?}"))
    }

    /// Dock the drawer panels into the layout (`true`) or move them back to the drawer.
    pub fn dock_content_drawer(&mut self, dock: bool) {
        self.dock_drawer(dock);
    }
    /// Open or close the drawer (no effect while docked).
    pub fn set_drawer_open(&mut self, open: bool) {
        if !self.drawer_docked() {
            self.drawer.open = open;
        }
    }
    /// Whether the content drawer is docked into the layout.
    pub fn drawer_docked(&self) -> bool {
        chrome::DRAWER_TABS.iter().any(|p| self.layout.contains(p))
    }

    /// Whether the content drawer is open (always false while docked).
    pub fn drawer_open(&self) -> bool {
        self.drawer.open && !self.drawer_docked()
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
        if self.themed_for != Some(self.prefs.theme) {
            // Readable sizes: the stock scale is 12 px body.
            let big = |mut t: Tokens| {
                t.type_scale.small = 12.0;
                t.type_scale.body = 14.0;
                t.type_scale.button = 14.0;
                t.type_scale.heading = 18.0;
                t.control_height = 26.0;
                t
            };
            let mode = if self.prefs.theme == Theme::Light { ThemeMode::Light } else { ThemeMode::Dark };
            tokens::install(ctx, &big(Tokens::light()), &big(Tokens::dark()), mode);
            self.themed_for = Some(self.prefs.theme);
        }
        if (ctx.zoom_factor() - self.prefs.ui_scale).abs() > 0.001 {
            ctx.set_zoom_factor(self.prefs.ui_scale);
        }
        self.now = ctx.input(|i| i.time);
        self.apply_prefs(backend);
        self.poll(backend);

        let mut reqs: Vec<Req> = Vec::new();
        // 5-9: the world tools, in toolbar order (not while typing).
        if !ctx.egui_wants_keyboard_input() {
            for (i, key) in [Key::Num5, Key::Num6, Key::Num7, Key::Num8, Key::Num9].into_iter().enumerate() {
                if ctx.input(|inp| inp.key_pressed(key) && !inp.modifiers.any())
                    && let Some(tool) = self.tools.get(i)
                {
                    let on = self.active_tool.as_deref() == Some(tool.id.as_str());
                    reqs.push(Req::Tool((!on).then(|| tool.id.clone())));
                }
            }
        }
        for _ in 0..4 {
            match dispatch(ctx, &self.keymap).as_deref().and_then(Cmd::from_id) {
                Some(c) => reqs.push(Req::Cmd(c)),
                None => break,
            }
        }

        let mut root = Ui::new(
            ctx.clone(),
            "editor_root".into(),
            egui::UiBuilder::new().layer_id(egui::LayerId::background()).max_rect(ctx.content_rect()),
        );
        // Behind the dock: fill everything except the viewport (the host draws the 3D view
        // there), so the gaps between panels are not the host's clear colour.
        {
            let screen = ctx.content_rect();
            let app = tokens::current(ctx).surface.app;
            let p = root.painter();
            match self.last_viewport.filter(|r| screen.contains_rect(*r)) {
                Some(v) => {
                    p.rect_filled(egui::Rect::from_min_max(screen.min, egui::pos2(screen.right(), v.top())), 0.0, app);
                    p.rect_filled(egui::Rect::from_min_max(egui::pos2(screen.left(), v.bottom()), screen.max), 0.0, app);
                    p.rect_filled(egui::Rect::from_min_max(egui::pos2(screen.left(), v.top()), egui::pos2(v.left(), v.bottom())), 0.0, app);
                    p.rect_filled(egui::Rect::from_min_max(egui::pos2(v.right(), v.top()), egui::pos2(screen.right(), v.bottom())), 0.0, app);
                }
                None => {
                    p.rect_filled(screen, 0.0, app);
                }
            }
        }
        self.menu_bar(&mut root, &mut reqs);
        self.toolbar(&mut root, &mut reqs);
        self.status_bar(&mut root);
        let mut clear_output = false;
        self.drawer_ui(&mut root, &mut reqs, &mut clear_output);

        // The dock: panels fill their own background; the viewport body stays transparent.
        let mut viewport = None;
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
                        Panel::Viewport => {
                            // The document area: a tab strip, then the viewport hole or a document.
                            let r = ui.max_rect();
                            let strip = egui::Rect::from_min_size(r.min, egui::vec2(r.width(), docs::STRIP_H));
                            let body = egui::Rect::from_min_max(egui::pos2(r.left(), strip.bottom()), r.max);
                            let level_title = match &self.level.path {
                                Some(p) => format!("Level: {}{}", p.rsplit('/').next().unwrap_or(p).trim_end_matches(".level.ron"), if self.level.dirty { " *" } else { "" }),
                                None => format!("Level: unsaved{}", if self.level.dirty { " *" } else { "" }),
                            };
                            let out = docs::strip(ui, strip, &level_title, &self.docs);
                            if let Some(i) = out.activate {
                                self.docs.active = i;
                            }
                            if let Some(i) = out.close {
                                self.docs.close(i);
                            }
                            match self.docs.active_tab().cloned() {
                                None => viewport = Some(body),
                                Some(tab) => {
                                    ui.painter().rect_filled(body, 0.0, panel_fill);
                                    ui.scope_builder(egui::UiBuilder::new().max_rect(body), |ui| {
                                        ui.label(egui::RichText::new(&tab.path).weak().small());
                                        logic::show(ui, &mut self.logic);
                                    });
                                }
                            }
                        }
                        Panel::Outliner => {
                            let v = outliner::View {
                                tree: &self.display,
                                tree_rev: self.tree_rev,
                                nodes: &self.nodes,
                                selection: &self.selection,
                            };
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
                        Panel::Content | Panel::Output | Panel::Messages => self.drawer_body(ui, *panel, &mut reqs, &mut clear_output),
                        Panel::Modes => {
                            let v = modes::View { mode: Mode::of_tool(self.active_tool.as_deref()), tools: &self.tools, active_tool: self.active_tool.as_deref(), placeables: &self.placeables, models: &self.models };
                            modes::show(ui, &mut self.place, &v, &mut reqs);
                        }
                        Panel::WorldSettings => settings::world_tab(ui, &self.groups, &mut reqs),
                    }
                },
            );
            actions = out.actions;
        }
        self.layout = layout;
        for a in actions {
            let _ = self.layout.apply(a);
        }
        self.last_viewport = viewport;
        content::handle_drop(ctx, viewport, &mut reqs);
        if clear_output {
            self.diagnostics.clear();
        }

        // Overlays.
        if let Some(v) = viewport {
            self.viewport_overlay(ctx, v, backend, &mut reqs);
        }
        self.help_windows(ctx, &mut reqs);
        let infos = self.palette.is_open().then(|| self.command_infos());
        if let Some(infos) = &infos
            && let Some(id) = self.palette.show(ctx, infos, self.palette_revision(), Platform::current())
        {
            if let Some(c) = Cmd::from_id(&id) {
                reqs.push(Req::Cmd(c));
            } else if let Some(path) = id.strip_prefix("place:") {
                reqs.push(Req::Place(path.to_owned()));
            } else if let Some(path) = id.strip_prefix("open:") {
                if path.ends_with(".level.ron") {
                    reqs.push(Req::OpenPath(path.to_owned()));
                } else {
                    self.open_logic_tab(path);
                }
            } else if let Some(n) = id.strip_prefix("entity:").and_then(|n| n.parse::<EntityId>().ok()) {
                reqs.push(Req::RevealEntity(n));
            }
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
        self.view = backend.view_info();
        // Ops the engine applied itself (tool strokes, drags) go on the undo stack.
        for r in backend.take_recorded() {
            if !matches!(r.op, Op::SetComponent { .. } | Op::TerrainPatch { .. }) {
                self.dirty_tree = true;
            }
            self.undo.record(&r.label, r.op, r.key, self.now);
            self.dirty_components = true;
            self.level.dirty = true;
        }
        let due = self.now - self.last_poll >= POLL_SECS;
        if !(due || self.dirty_tree || self.dirty_components || self.dirty_assets) {
            return;
        }
        if due || self.dirty_tree {
            let filter = TreeFilter {
                text: self.outliner.filter.clone(),
                ..Default::default()
            };
            let tree = backend.tree(&filter);
            let grouped = filter.text.is_empty();
            if tree != self.tree || grouped != self.grouped {
                // Without a search the roots sit in folders by kind; a search shows the plain tree.
                self.display = if grouped { outliner::group(&tree) } else { tree.clone() };
                self.nodes = Nodes::build(&self.display);
                self.tree = tree;
                self.grouped = grouped;
                self.tree_rev += 1;
            }
            self.dirty_tree = false;
        }
        if due {
            let sel = backend.selection();
            if sel != self.selection {
                // A new selection brings Details forward (it may sit behind World Settings).
                if !sel.is_empty() {
                    let _ = self.layout.apply(Action::Activate { panel: Panel::Details });
                }
                self.selection = sel;
                self.dirty_components = true;
                // The backend lists a selected generated entity in the tree: refetch.
                self.dirty_tree = true;
            }
            self.level = backend.level();
            if let Some(p) = self.level.path.clone()
                && self.recent.first() != Some(&p)
            {
                self.remember(&p);
            }
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
            self.tools = backend.tools();
            self.active_tool = backend.active_tool();
            if self.placeables.is_empty() {
                self.placeables = backend.placeables();
            }
            if self.layout.contains(&Panel::WorldSettings) || self.windows.project {
                self.groups = backend.settings();
            }
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
        if (due && self.models.is_empty() && self.now > 1.0) || self.dirty_assets {
            self.models = place::scan_models(backend);
        }
        if due || self.dirty_assets || self.content.dir_changed {
            if self.content.tree_dirty || self.dirty_assets || self.content.subdirs.is_empty() {
                content::refresh_tree(&mut self.content, backend);
            }
            self.assets = backend.assets(&self.content.dir);
            self.dirty_assets = false;
            self.content.dir_changed = false;
        }
        if due {
            self.last_poll = self.now;
        }
    }

    // ---- chrome ----------------------------------------------------------------------------

    /// Changes whenever the palette's entries or their enabled state change (the ranking cache
    /// key; entries are also counted by the palette itself).
    fn palette_revision(&self) -> u64 {
        let mut h = self.tree_rev;
        h = h.wrapping_mul(31).wrapping_add(self.models.len() as u64);
        h = h.wrapping_mul(31).wrapping_add(self.assets.len() as u64);
        h = h.wrapping_mul(31).wrapping_add(u64::from(self.undo.can_undo()) + 2 * u64::from(self.undo.can_redo()) + 4 * u64::from(!self.selection.is_empty()));
        h
    }

    /// Everything the palette can run: commands, then entities, models, logic graphs and levels.
    fn command_infos(&self) -> Vec<CommandInfo> {
        let mut out: Vec<CommandInfo> = COMMANDS
            .iter()
            .map(|c| {
                let (enabled, why) = match c.cmd {
                    Cmd::Undo if !self.undo.can_undo() => (false, Some("nothing to undo")),
                    Cmd::Redo if !self.undo.can_redo() => (false, Some("nothing to redo")),
                    Cmd::Delete | Cmd::Rename | Cmd::Focus if self.selection.is_empty() => (false, Some("nothing selected")),
                    Cmd::ModeLandscape if !self.mode_available(Mode::Landscape) => (false, Some("this game has no landscape tool")),
                    Cmd::ModeFoliage if !self.mode_available(Mode::Foliage) => (false, Some("this game has no foliage tool")),
                    Cmd::ModeSplines if !self.mode_available(Mode::Splines) => (false, Some("this game has no spline tool")),
                    Cmd::ModePlace if !self.mode_available(Mode::Place) => (false, Some("this game has no place tool")),
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
            .collect();
        let entry = |id: String, label: String, menu: &str| CommandInfo { id, label, menu: vec![menu.to_owned()], shortcut: None, params_schema: serde_json::Value::Null, params_text: None, enabled: true, disabled_reason: None, mutates: false };
        // Entities in the Outliner (folders are not entities), then assets.
        for id in self.nodes.order.iter().copied().filter(|id| !model::is_folder(*id)).take(MAX_PALETTE_ENTITIES) {
            if let Some(n) = self.nodes.info.get(&id) {
                out.push(entry(format!("entity:{id}"), n.name.clone(), "Select"));
            }
        }
        for m in &self.models {
            out.push(entry(format!("place:{}", m.path), m.name.clone(), "Place model"));
        }
        for a in &self.assets {
            match a.kind {
                editor_proto::AssetKind::Logic | editor_proto::AssetKind::Script => out.push(entry(format!("open:{}", a.path), a.name.clone(), "Open")),
                editor_proto::AssetKind::Level => out.push(entry(format!("open:{}", a.path), a.name.clone(), "Open level")),
                _ => {}
            }
        }
        out
    }

    /// The drawer / docked body of Content, Output and Messages.
    fn drawer_body(&mut self, ui: &mut Ui, panel: Panel, reqs: &mut Vec<Req>, clear_output: &mut bool) {
        match panel {
            Panel::Content => content::show(ui, &mut self.content, &self.assets, reqs),
            Panel::Output => output::show(ui, &mut self.output, &self.diagnostics, clear_output, reqs),
            _ => {
                ui.weak("Messages: coming with the message log");
            }
        }
    }

    /// Applies loaded preferences to the backend once (camera speed, grid, scenery, snap step),
    /// and settings-window edits as they happen.
    fn apply_prefs(&mut self, backend: &mut dyn EditorBackend) {
        if std::mem::take(&mut self.prefs_pending) {
            backend.viewport(ViewportCmd::SetCameraSpeed(self.prefs.camera_speed));
            backend.viewport(ViewportCmd::SetShowGrid(self.prefs.show_grid));
            backend.viewport(ViewportCmd::SetShowAllScenery(self.prefs.show_all_scenery));
            backend.viewport(ViewportCmd::SetSnap { enabled: self.snap, step: self.snap_step });
        }
        if let Some(ch) = self.prefs_changed.take() {
            if ch.camera_speed {
                backend.viewport(ViewportCmd::SetCameraSpeed(self.prefs.camera_speed));
            }
            if ch.grid {
                backend.viewport(ViewportCmd::SetShowGrid(self.prefs.show_grid));
            }
            if ch.scenery {
                backend.viewport(ViewportCmd::SetShowAllScenery(self.prefs.show_all_scenery));
            }
            // The window edits the pref copy; the snap step lives in `snap_step`.
            if ch.snap {
                self.snap_step = self.prefs.snap_step;
                backend.viewport(ViewportCmd::SetSnap { enabled: self.snap, step: self.snap_step });
            }
        }
    }

    fn dialog_ui(&mut self, ctx: &Context, backend: &mut dyn EditorBackend) {
        let Some(d) = self.dialog.as_mut() else { return };
        let title = if d.kind == DialogKind::Open { "Open level" } else { "Save level as" };
        let mut action: Option<bool> = None;
        egui::Window::new(title)
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, egui::Vec2::ZERO)
            .show(ctx, |ui| {
                ui.label("Path relative to the game folder (e.g. levels/valley.level.ron)");
                let r = ui.add(egui::TextEdit::singleline(&mut d.text).desired_width(360.0).id(egui::Id::new("editor.dialog.path")));
                if d.focus_pending {
                    r.request_focus();
                    d.focus_pending = false;
                }
                let enter = r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
                ui.horizontal(|ui| {
                    let ok = ui
                        .add_enabled(!d.text.trim().is_empty(), egui::Button::new(if d.kind == DialogKind::Open { "Open" } else { "Save" }))
                        .clicked();
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
                            self.say_success(format!("Opened {path}"));
                        }
                        Err(e) => {
                            self.say_error(format!("Open failed: {e}"));
                        }
                    },
                    DialogKind::SaveAs => self.save(backend, Some(&path)),
                }
            }
            Some(false) => self.dialog = None,
            None => {}
        }
    }

    fn say(&mut self, msg: String) -> String {
        self.last_msg = Some(msg.clone());
        msg
    }
    /// Shows a toast; the same message again within two seconds replaces the old one with a count.
    fn toast(&mut self, level: ashlar_ui::toasts::ToastLevel, m: String) {
        let m = self.say(m);
        let (dismiss, text) = self.dedupe.next(&m, self.now);
        if let Some(id) = dismiss {
            self.toasts.dismiss(id);
        }
        let id = self.toasts.push(ashlar_ui::toasts::Toast::new(level, text));
        self.dedupe.shown(id);
    }
    fn say_success(&mut self, m: impl Into<String>) {
        self.toast(ashlar_ui::toasts::ToastLevel::Success, m.into());
    }
    fn say_error(&mut self, m: impl Into<String>) {
        self.toast(ashlar_ui::toasts::ToastLevel::Error, m.into());
    }
    fn say_info(&mut self, m: impl Into<String>) {
        self.toast(ashlar_ui::toasts::ToastLevel::Info, m.into());
    }
    fn say_warning(&mut self, m: impl Into<String>) {
        self.toast(ashlar_ui::toasts::ToastLevel::Warning, m.into());
    }

    // ---- requests --------------------------------------------------------------------------

    fn process(&mut self, ctx: &Context, backend: &mut dyn EditorBackend, reqs: Vec<Req>) {
        for r in reqs {
            match r {
                Req::Edit { op, label, key, seal } => self.edit(backend, op, &label, key, seal),
                Req::Select(ids) => {
                    if !ids.is_empty() {
                        let _ = self.layout.apply(Action::Activate { panel: Panel::Details });
                    }
                    self.selection = ids;
                    backend.set_selection(&self.selection);
                    self.dirty_components = true;
                }
                Req::Mode(m) => self.set_mode(backend, m),
                Req::Settings { group, value } => {
                    if let Err(e) = backend.set_settings(&group, value) {
                        self.say_error(format!("Settings: {e}"));
                    }
                    // Show the applied values next frame.
                    self.last_poll = f64::NEG_INFINITY;
                    self.level.dirty = true;
                }
                Req::RevealEntity(id) => {
                    self.selection = vec![id];
                    backend.set_selection(&self.selection);
                    self.dirty_components = true;
                    backend.viewport(ViewportCmd::FocusSelection);
                    let _ = self.layout.apply(Action::Activate { panel: Panel::Details });
                }
                Req::PlaceAt(path, uv) => match backend.place_asset(&path, editor_proto::Placement { screen: Some(uv), ..Default::default() }) {
                    Ok(op) => {
                        self.undo.record("Place asset", op, None, self.now);
                        self.dirty_tree = true;
                        self.say_info(format!("Placed {path}"));
                    }
                    Err(e) => self.say_error(format!("Place failed: {e}")),
                },
                Req::OpenAsset(path, kind) => match kind {
                    editor_proto::AssetKind::Level => self.process(ctx, backend, vec![Req::OpenPath(path)]),
                    editor_proto::AssetKind::Logic => {
                        self.open_logic_tab(&path);
                        self.say_info(format!("Opening {path} in the Logic editor"));
                    }
                    _ => {
                        ctx.copy_text(path.clone());
                        self.say_info(format!("No editor for {path} yet; the path is copied"));
                    }
                },
                Req::Reveal(path) => {
                    if let Err(e) = backend.reveal_asset(&path) {
                        self.say_error(format!("Show in Finder: {e}"));
                    }
                }
                Req::Convert(id) => match backend.convert_to_level(id) {
                    Ok(op) => {
                        self.undo.record("Convert to level entity", op, None, self.now);
                        self.dirty_tree = true;
                        self.dirty_components = true;
                        self.level.dirty = true;
                        self.say_success("Converted to a level entity");
                    }
                    Err(e) => self.say_error(format!("Convert failed: {e}")),
                },
                Req::Place(path) => match backend.place_asset(&path, editor_proto::Placement::default()) {
                    Ok(op) => {
                        self.undo.record("Place asset", op, None, self.now);
                        self.dirty_tree = true;
                        self.say_info(format!("Placed {path}"));
                    }
                    Err(e) => {
                        self.say_error(format!("Place failed: {e}"));
                    }
                },
                Req::Cmd(c) => self.command(ctx, backend, c),
                Req::Tool(id) => self.activate_tool(backend, id),
                Req::OpenPath(path) => match backend.open_level(&path) {
                    Ok(()) => {
                        self.undo.clear();
                        self.selection.clear();
                        self.refresh();
                        self.say_success(format!("Opened {path}"));
                    }
                    Err(e) => self.say_error(format!("Open failed: {e}")),
                },
                Req::ToolSettings { id, settings } => {
                    if let Err(e) = backend.set_tool_settings(&id, settings) {
                        self.say_error(format!("Tool settings: {e}"));
                    }
                    // Show the new values next frame.
                    self.last_poll = f64::NEG_INFINITY;
                }
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
                self.say_error(format!("{label}: {e}"));
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
                self.say_warning("Generated entities can't be deleted");
            }
            return;
        }
        let mut ops = Vec::new();
        for id in &roots {
            match backend.snapshot(*id) {
                Ok(snapshot) => ops.push(Op::Despawn { snapshot }),
                Err(e) => {
                    self.say_error(format!("Delete failed: {e}"));
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
                self.say_success("Level saved");
            }
            Err(e) => {
                self.say_error(format!("Save failed: {e}"));
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
                    self.dialog = Some(Dialog {
                        kind: DialogKind::SaveAs,
                        text: "levels/new.level.ron".into(),
                        focus_pending: true,
                    });
                }
            }
            Cmd::SaveAs => {
                let text = backend.level().path.unwrap_or_else(|| "levels/new.level.ron".into());
                self.dialog = Some(Dialog {
                    kind: DialogKind::SaveAs,
                    text,
                    focus_pending: true,
                });
            }
            Cmd::Open => {
                let text = backend.level().path.unwrap_or_else(|| "levels/".into());
                self.dialog = Some(Dialog {
                    kind: DialogKind::Open,
                    text,
                    focus_pending: true,
                });
            }
            Cmd::Undo => if let Some(op) = self.undo.undo() { match backend.apply(&op) {
                Ok(()) => self.after_history(),
                Err(e) => {
                    self.undo.restore_undo();
                    self.say_error(format!("Undo failed: {e}"));
                }
            } },
            Cmd::Redo => if let Some(op) = self.undo.redo() { match backend.apply(&op) {
                Ok(()) => self.after_history(),
                Err(e) => {
                    self.undo.restore_redo();
                    self.say_error(format!("Redo failed: {e}"));
                }
            } },
            Cmd::PlayStop => match backend.play_state() {
                PlayState::Editing => {
                    if let Err(e) = backend.play() {
                        self.say_error(format!("Play failed: {e}"));
                    }
                }
                PlayState::Building | PlayState::Playing => backend.stop(),
            },
            Cmd::ToolSelect => self.set_tool(backend, Tool::Select),
            Cmd::ToolMove => self.set_tool(backend, Tool::Move),
            Cmd::ToolRotate => self.set_tool(backend, Tool::Rotate),
            Cmd::ToolScale => self.set_tool(backend, Tool::Scale),
            Cmd::ToggleSnap => {
                self.snap = !self.snap;
                backend.viewport(ViewportCmd::SetSnap {
                    enabled: self.snap,
                    step: self.snap_step,
                });
            }
            Cmd::ToggleLocalSpace => {
                self.view.local_space = !self.view.local_space;
                backend.viewport(ViewportCmd::SetLocalSpace(self.view.local_space));
            }
            Cmd::ToggleGrid => {
                self.view.show_grid = !self.view.show_grid;
                backend.viewport(ViewportCmd::SetShowGrid(self.view.show_grid));
            }
            Cmd::ToggleAllScenery => {
                self.view.show_all_scenery = !self.view.show_all_scenery;
                backend.viewport(ViewportCmd::SetShowAllScenery(self.view.show_all_scenery));
            }
            Cmd::Help => self.help_open = !self.help_open,
            Cmd::ResetLayout | Cmd::LayoutDefault => self.apply_preset(LayoutPreset::Default),
            Cmd::LayoutLandscape => self.apply_preset(LayoutPreset::Landscape),
            Cmd::LayoutLogic => self.apply_preset(LayoutPreset::Logic),
            Cmd::ToggleDrawer => self.toggle_drawer(),
            Cmd::DockDrawer => {
                let dock = !self.drawer_docked();
                self.dock_drawer(dock);
            }
            Cmd::ModeSelect => self.set_mode(backend, Mode::Select),
            Cmd::ModeLandscape => self.set_mode(backend, Mode::Landscape),
            Cmd::ModeFoliage => self.set_mode(backend, Mode::Foliage),
            Cmd::ModeSplines => self.set_mode(backend, Mode::Splines),
            Cmd::ModePlace => self.set_mode(backend, Mode::Place),
            Cmd::OpenWorldSettings => {
                let _ = self.show_panel("World Settings");
            }
            Cmd::OpenProjectSettings => self.windows.project = true,
            Cmd::OpenPreferences => self.windows.prefs = true,
            Cmd::SelectAll => {
                let ids: Vec<EntityId> = self.nodes.order.iter().copied().filter(|id| self.nodes.info.get(id).is_some_and(|n| !n.generated && !model::is_folder(*id))).collect();
                self.selection = ids;
                backend.set_selection(&self.selection);
                self.dirty_components = true;
            }
            Cmd::Duplicate => {
                let ids: Vec<EntityId> = self.selection.iter().copied().filter(|id| self.nodes.info.get(id).is_some_and(|n| !n.generated)).collect();
                if ids.is_empty() {
                    self.say_warning("Select something to duplicate (generated entities can't be)");
                } else {
                    match backend.duplicate(&ids) {
                        Ok(op) => {
                            self.undo.record("Duplicate", op, None, self.now);
                            self.undo.seal();
                            self.dirty_tree = true;
                            self.selection = backend.selection();
                            self.dirty_components = true;
                            self.say_info("Duplicated");
                        }
                        Err(e) => self.say_error(format!("Duplicate failed: {e}")),
                    }
                }
            }
            Cmd::Focus => backend.viewport(ViewportCmd::FocusSelection),
            // While a tool is active, Delete is the tool's (a spline point, a tree).
            Cmd::Delete if self.active_tool.is_some() => {}
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

    fn activate_tool(&mut self, backend: &mut dyn EditorBackend, id: Option<String>) {
        backend.set_active_tool(id.as_deref());
        self.active_tool = id;
        if let Some(id) = &self.active_tool {
            if Mode::Landscape.tool_ids().contains(&id.as_str()) {
                self.landscape_tool = id.clone();
            }
            // The settings live in the Modes panel (Details stays where it is).
            if !self.layout.contains(&Panel::Modes) {
                self.toggle_panel(Panel::Modes);
            }
        }
        self.last_poll = f64::NEG_INFINITY;
    }

    /// Switch mode: Select goes back to the transform tools; the others arm their world tool
    /// (Landscape remembers Sculpt or Paint).
    fn set_mode(&mut self, backend: &mut dyn EditorBackend, mode: Mode) {
        if mode == Mode::Select {
            self.activate_tool(backend, None);
            return;
        }
        let id = if mode == Mode::Landscape && self.tools.iter().any(|t| t.id == self.landscape_tool) { Some(self.landscape_tool.clone()) } else { mode.tool_ids().iter().find(|id| self.tools.iter().any(|t| t.id == **id)).map(|s| (*s).to_owned()) };
        match id {
            Some(id) => self.activate_tool(backend, Some(id)),
            None => self.say_warning(format!("This game has no {} tool", mode.label())),
        }
    }

    fn set_tool(&mut self, backend: &mut dyn EditorBackend, tool: Tool) {
        if self.active_tool.take().is_some() {
            backend.set_active_tool(None);
        }
        self.tool = tool;
        backend.viewport(ViewportCmd::SetTool(tool));
    }

    fn after_history(&mut self) {
        self.dirty_tree = true;
        self.dirty_components = true;
        self.level.dirty = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::MockBackend;

    fn harness() -> egui_kittest::Harness<'static, (EditorUi, MockBackend)> {
        let mut h = egui_kittest::Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_ui_state(
            |ui, (e, b): &mut (EditorUi, MockBackend)| {
                let ctx = ui.ctx().clone();
                e.show(&ctx, b);
            },
            (EditorUi::new(), MockBackend::demo()),
        );
        h.run_steps(4);
        h
    }

    #[test]
    fn the_palette_lists_commands_entities_models_and_logic() {
        let h = harness();
        let infos = h.state().0.command_infos();
        let ids: Vec<&str> = infos.iter().map(|i| i.id.as_str()).collect();
        for c in COMMANDS {
            assert!(ids.contains(&c.id), "{} is listed", c.id);
        }
        assert!(infos.iter().any(|i| i.id.starts_with("entity:") && i.label == "Crate"), "entities are listed");
        assert!(infos.iter().any(|i| i.id.starts_with("place:") && i.label.contains("crate")), "models from every folder are listed");
        // Not-yet-possible commands say why.
        let landscape = infos.iter().find(|i| i.id == "editor.mode_landscape").expect("listed");
        assert!(!landscape.enabled && landscape.disabled_reason.is_some());
    }

    #[test]
    fn the_default_layout_validates_and_every_preset_has_a_viewport() {
        for p in LayoutPreset::ALL {
            let l = p.build();
            assert!(l.validate().is_ok(), "{p:?}");
            assert!(l.contains(&Panel::Viewport) && l.contains(&Panel::Details), "{p:?}");
        }
    }

    #[test]
    fn modes_follow_the_active_tool() {
        assert_eq!(Mode::of_tool(None), Mode::Select);
        assert_eq!(Mode::of_tool(Some("paint")), Mode::Landscape);
        assert_eq!(Mode::of_tool(Some("sculpt")), Mode::Landscape);
        assert_eq!(Mode::of_tool(Some("spline")), Mode::Splines);
        assert_eq!(Mode::of_tool(Some("other")), Mode::Select);
    }
}
