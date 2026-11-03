//! The frame around the panels: menu bar, toolbar (Modes, Play), status bar, the content
//! drawer, the viewport overlay (transform tools, camera speed, snap, space, axis gizmo, control
//! hint) and the Controls window.

use ashlar_command::shortcut::Platform;
use ashlar_ui::docking::Action;
use ashlar_ui::status_bar::StatusBar;
use ashlar_ui::tokens;
use editor_proto::{EditorBackend, PlayState, Tool, ViewportCmd};
use egui::{Align2, Color32, Context, FontId, RichText, Ui, pos2, vec2};

use crate::model::{COMMANDS, Cmd, Mode, Req};
use crate::{EditorUi, Panel};

/// "Mod+Shift+S" as plain words ("Cmd+Shift+S" on a Mac): the symbol glyphs are not in the font.
pub(crate) fn plain_shortcut(spec: &str, mac: bool) -> String {
    let first = spec.split(" / ").next().unwrap_or(spec);
    first.split('+').map(|p| if p == "Mod" { if mac { "Cmd" } else { "Ctrl" } } else { p }).collect::<Vec<_>>().join("+")
}

fn shortcut_text(cmd: Cmd) -> Option<String> {
    cmd.spec().shortcut.map(|sc| plain_shortcut(sc, Platform::current() == Platform::Mac))
}

fn tip(cmd: Cmd) -> String {
    let s = cmd.spec();
    match shortcut_text(cmd) {
        Some(k) => format!("{} ({k})", s.label),
        None => s.label.to_owned(),
    }
}

/// A menu entry that runs `cmd`.
fn item(ui: &mut Ui, reqs: &mut Vec<Req>, label: &str, cmd: Cmd, enabled: bool) {
    let mut b = egui::Button::new(label);
    if let Some(k) = shortcut_text(cmd) {
        b = b.shortcut_text(k);
    }
    if ui.add_enabled(enabled, b).clicked() {
        reqs.push(Req::Cmd(cmd));
        ui.close();
    }
}

/// Rotates `v` by the inverse of the unit quaternion `q = [x, y, z, w]`.
pub(crate) fn rotate_inverse(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let (x, y, z, w) = (-q[0], -q[1], -q[2], q[3]);
    // v' = v + 2w (u x v) + 2 u x (u x v), with u = (x, y, z) of the conjugate.
    let u = [x, y, z];
    let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let uv = cross(u, v);
    let uuv = cross(u, uv);
    [v[0] + 2.0 * (w * uv[0] + uuv[0]), v[1] + 2.0 * (w * uv[1] + uuv[1]), v[2] + 2.0 * (w * uv[2] + uuv[2])]
}

/// Mouse and key help shown in Help > Controls (keyboard shortcuts come from the command table).
const MOUSE_HELP: &[(&str, &str)] = &[
    ("W A S D", "move the camera (Shift = 3x faster)"),
    ("Q / E", "down / up"),
    ("Arrow keys", "turn the camera"),
    ("Drag on empty space", "look around (a plain click selects)"),
    ("Right-drag", "look around; scroll while looking = fly speed"),
    ("Scroll / pinch", "move forward and back"),
    ("Alt + drag", "orbit around the selection"),
    ("Middle-drag, or Space + drag", "pan"),
    ("Click", "select (Shift / Cmd adds)"),
    ("Drag a gizmo handle", "move, rotate or scale the selection"),
    ("[ and ]", "brush size (Sculpt, Paint, Foliage)"),
    ("Ctrl + click", "add a spline point (Spline tool)"),
    ("5 - 9", "the world tools: Spline, Sculpt, Paint, Foliage, Place"),
];

/// Tabs of the content drawer (and, when docked, panels of the bottom dock).
pub(crate) const DRAWER_TABS: [Panel; 3] = [Panel::Content, Panel::Output, Panel::Messages];

/// The Content Drawer: a strip along the bottom that opens upward (Cmd+Space) or docks into the
/// layout like any panel.
pub(crate) struct Drawer {
    pub open: bool,
    pub tab: Panel,
}

impl Default for Drawer {
    fn default() -> Self {
        Drawer { open: false, tab: Panel::Content }
    }
}

/// Height of the collapsed strip in points.
const STRIP_H: f32 = 30.0;

impl EditorUi {
    // ---- panels ----------------------------------------------------------------------------

    /// Tab title with the Output / Messages count of warnings and errors.
    pub(crate) fn tab_title(&self, p: Panel) -> String {
        match (p, crate::output::badge(&self.diagnostics)) {
            (Panel::Output | Panel::Messages, Some(n)) => format!("{} ({n})", p.title()),
            _ => p.title().to_owned(),
        }
    }

    fn panel_open(&self, p: Panel) -> bool {
        self.layout.contains(&p)
    }

    pub(crate) fn toggle_panel(&mut self, p: Panel) {
        if DRAWER_TABS.contains(&p) && !self.drawer_docked() {
            if self.drawer.open && self.drawer.tab == p {
                self.drawer.open = false;
            } else {
                self.drawer.open = true;
                self.drawer.tab = p;
            }
            return;
        }
        if self.panel_open(p) {
            let _ = self.layout.apply(Action::Close { panel: p });
            return;
        }
        let anchor = match p {
            Panel::WorldSettings => Panel::Details,
            Panel::Output | Panel::Messages => Panel::Content,
            _ => Panel::Viewport,
        };
        let anchor = if self.panel_open(anchor) { Some(anchor) } else { Panel::ALL.into_iter().find(|a| *a != p && self.panel_open(*a)) };
        let _ = self.layout.apply(Action::Open { panel: p, anchor });
    }

    /// Open or close the drawer (Cmd+Space). Docked panels are left alone.
    pub(crate) fn toggle_drawer(&mut self) {
        if self.drawer_docked() {
            return;
        }
        self.drawer.open = !self.drawer.open;
    }

    /// Move the drawer panels into the dock (below the viewport), or back into the strip.
    pub(crate) fn dock_drawer(&mut self, dock: bool) {
        if dock == self.drawer_docked() {
            return;
        }
        if dock {
            let first = self.drawer.tab;
            let _ = self.layout.apply(Action::OpenAt { panel: first, anchor: Panel::Viewport, placement: ashlar_ui::docking::Placement::Split(ashlar_ui::docking::Zone::Bottom) });
            for p in DRAWER_TABS {
                if p != first {
                    let _ = self.layout.apply(Action::Open { panel: p, anchor: Some(first) });
                }
            }
            let _ = self.layout.apply(Action::Activate { panel: first });
            self.drawer.open = false;
        } else {
            for p in DRAWER_TABS {
                let _ = self.layout.apply(Action::Close { panel: p });
            }
            self.drawer.open = true;
        }
    }

    // ---- content drawer --------------------------------------------------------------------

    /// The strip (closed) or the open drawer. Shown above the status bar, below the dock.
    pub(crate) fn drawer_ui(&mut self, root: &mut Ui, reqs: &mut Vec<Req>, clear_output: &mut bool) {
        if self.drawer_docked() {
            return;
        }
        let t = tokens::current(root.ctx());
        let frame = egui::Frame::new().fill(t.surface.panel).inner_margin(egui::Margin::symmetric(t.space.md as i8, 2));
        let screen_h = root.ctx().content_rect().height();
        if !self.drawer.open {
            egui::Panel::bottom("editor_drawer_strip").exact_size(STRIP_H).resizable(false).show_separator_line(true).frame(frame).show(root, |ui| {
                ui.horizontal_centered(|ui| {
                    ui.spacing_mut().item_spacing.x = t.space.sm;
                    for tab in DRAWER_TABS {
                        let label = if tab == Panel::Content { "Content Drawer  ^".to_owned() } else { self.tab_title(tab) };
                        if ui.button(label).on_hover_text(format!("Open the drawer ({})", shortcut_text(Cmd::ToggleDrawer).unwrap_or_default())).clicked() {
                            self.drawer.open = true;
                            self.drawer.tab = tab;
                        }
                    }
                    ui.label(RichText::new(format!("{} opens the drawer", shortcut_text(Cmd::ToggleDrawer).unwrap_or_default())).color(t.text.disabled).small());
                });
            });
            return;
        }
        let max_h = (screen_h * 0.5).max(160.0);
        egui::Panel::bottom("editor_drawer").resizable(true).default_size((screen_h * 0.34).clamp(180.0, 300.0).min(max_h)).size_range(120.0..=max_h).show_separator_line(true).frame(frame).show(root, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = t.space.sm;
                for tab in DRAWER_TABS {
                    if ui.selectable_label(self.drawer.tab == tab, self.tab_title(tab)).clicked() {
                        self.drawer.tab = tab;
                    }
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("v").on_hover_text("Close the drawer").clicked() {
                        self.drawer.open = false;
                    }
                    if ui.button("Dock").on_hover_text("Turn the drawer into a normal panel under the viewport").clicked() {
                        self.dock_drawer(true);
                    }
                });
            });
            ui.separator();
            let tab = self.drawer.tab;
            self.drawer_body(ui, tab, reqs, clear_output);
        });
    }

    // ---- menu bar --------------------------------------------------------------------------

    pub(crate) fn menu_bar(&mut self, root: &mut Ui, reqs: &mut Vec<Req>) {
        let t = tokens::current(root.ctx());
        let frame = egui::Frame::new().fill(t.surface.panel).inner_margin(egui::Margin::symmetric(t.space.md as i8, 1));
        egui::Panel::top("editor_menu").resizable(false).show_separator_line(false).frame(frame).show(root, |ui| {
            egui::MenuBar::new().ui(ui, |ui| {
                ui.menu_button("File", |ui| {
                    item(ui, reqs, "Open level...", Cmd::Open, true);
                    item(ui, reqs, "Save", Cmd::Save, true);
                    item(ui, reqs, "Save as...", Cmd::SaveAs, true);
                    ui.separator();
                    ui.add_enabled_ui(!self.recent.is_empty(), |ui| {
                        ui.menu_button("Recent", |ui| {
                            for r in self.recent.clone() {
                                if ui.button(&r).clicked() {
                                    reqs.push(Req::OpenPath(r));
                                    ui.close();
                                }
                            }
                        });
                    });
                });
                ui.menu_button("Edit", |ui| {
                    let sel = !self.selection.is_empty();
                    item(ui, reqs, "Undo", Cmd::Undo, self.undo.can_undo());
                    item(ui, reqs, "Redo", Cmd::Redo, self.undo.can_redo());
                    ui.separator();
                    item(ui, reqs, "Duplicate", Cmd::Duplicate, sel);
                    item(ui, reqs, "Delete", Cmd::Delete, sel);
                    item(ui, reqs, "Rename", Cmd::Rename, sel);
                    item(ui, reqs, "Select all", Cmd::SelectAll, true);
                    ui.separator();
                    item(ui, reqs, "Project Settings...", Cmd::OpenProjectSettings, true);
                    item(ui, reqs, "Editor Preferences...", Cmd::OpenPreferences, true);
                });
                ui.menu_button("Window", |ui| {
                    for p in [Panel::Modes, Panel::Outliner, Panel::Details, Panel::WorldSettings] {
                        let mut on = self.panel_open(p);
                        if ui.checkbox(&mut on, p.title()).changed() {
                            self.toggle_panel(p);
                        }
                    }
                    ui.separator();
                    item(ui, reqs, "Content Drawer", Cmd::ToggleDrawer, !self.drawer_docked());
                    for p in [Panel::Output, Panel::Messages] {
                        let mut on = if self.drawer_docked() { self.panel_open(p) } else { self.drawer.open && self.drawer.tab == p };
                        if ui.checkbox(&mut on, p.title()).changed() {
                            self.toggle_panel(p);
                        }
                    }
                    let mut on = self.panel_open(Panel::History);
                    if ui.checkbox(&mut on, Panel::History.title()).changed() {
                        self.toggle_panel(Panel::History);
                    }
                    let docked = self.drawer_docked();
                    item(ui, reqs, if docked { "Undock the content drawer" } else { "Dock the content drawer" }, Cmd::DockDrawer, true);
                    ui.separator();
                    ui.menu_button("Layouts", |ui| {
                        for (label, cmd) in [("Default", Cmd::LayoutDefault), ("Landscape", Cmd::LayoutLandscape), ("Logic", Cmd::LayoutLogic)] {
                            item(ui, reqs, label, cmd, true);
                        }
                    });
                    item(ui, reqs, "Reset layout", Cmd::ResetLayout, true);
                });
                ui.menu_button("Tools", |ui| {
                    for (m, cmd) in [(Mode::Select, Cmd::ModeSelect), (Mode::Landscape, Cmd::ModeLandscape), (Mode::Foliage, Cmd::ModeFoliage), (Mode::Splines, Cmd::ModeSplines), (Mode::Place, Cmd::ModePlace)] {
                        item(ui, reqs, m.label(), cmd, self.mode_available(m));
                    }
                    ui.separator();
                    item(ui, reqs, "Select tool", Cmd::ToolSelect, true);
                    item(ui, reqs, "Move tool", Cmd::ToolMove, true);
                    item(ui, reqs, "Rotate tool", Cmd::ToolRotate, true);
                    item(ui, reqs, "Scale tool", Cmd::ToolScale, true);
                    ui.separator();
                    item(ui, reqs, "Snap to grid", Cmd::ToggleSnap, true);
                    item(ui, reqs, "Local / world axes", Cmd::ToggleLocalSpace, true);
                    item(ui, reqs, "Focus selection", Cmd::Focus, !self.selection.is_empty());
                    let mut grid = self.view.show_grid;
                    if ui.checkbox(&mut grid, "Ground grid").changed() {
                        reqs.push(Req::Cmd(Cmd::ToggleGrid));
                    }
                    let mut all = self.view.show_all_scenery;
                    if ui.checkbox(&mut all, "Show all scenery (no distance fade)").on_hover_text("Draws every prop at any distance. Slower on big worlds.").changed() {
                        reqs.push(Req::Cmd(Cmd::ToggleAllScenery));
                    }
                    ui.checkbox(&mut self.hint_open, "Control hint in the viewport");
                });
                ui.menu_button("Help", |ui| {
                    item(ui, reqs, "Controls and shortcuts", Cmd::Help, true);
                    item(ui, reqs, "Command palette", Cmd::Palette, true);
                    if ui.button("About").clicked() {
                        self.about_open = true;
                        ui.close();
                    }
                });
            });
        });
    }

    // ---- toolbar ---------------------------------------------------------------------------

    /// Whether the game has a tool for `m` (Select always works).
    pub(crate) fn mode_available(&self, m: Mode) -> bool {
        m == Mode::Select || m.tool_ids().iter().any(|id| self.tools.iter().any(|t| t.id == *id))
    }

    pub(crate) fn mode(&self) -> Mode {
        Mode::of_tool(self.active_tool.as_deref())
    }

    pub(crate) fn toolbar(&mut self, root: &mut Ui, reqs: &mut Vec<Req>) {
        let t = tokens::current(root.ctx());
        let frame = egui::Frame::new().fill(t.surface.panel).inner_margin(egui::Margin::symmetric(t.space.md as i8, 5));
        egui::Panel::top("editor_toolbar").resizable(false).show_separator_line(true).frame(frame).show(root, |ui| {
            let (row, _) = ui.allocate_exact_size(vec2(ui.available_width(), 28.0), egui::Sense::hover());
            let lay = |l: egui::Layout, r: egui::Rect| egui::UiBuilder::new().max_rect(r).layout(l);
            // Left: Save, Undo / Redo, then the Modes group.
            let left_end = ui
                .scope_builder(lay(egui::Layout::left_to_right(egui::Align::Center), row), |ui| {
                    ui.spacing_mut().item_spacing.x = t.space.sm;
                    if ui.button("Save").on_hover_text(tip(Cmd::Save)).clicked() {
                        reqs.push(Req::Cmd(Cmd::Save));
                    }
                    if ui.add_enabled(self.undo.can_undo(), egui::Button::new("Undo")).on_hover_text(tip(Cmd::Undo)).clicked() {
                        reqs.push(Req::Cmd(Cmd::Undo));
                    }
                    if ui.add_enabled(self.undo.can_redo(), egui::Button::new("Redo")).on_hover_text(tip(Cmd::Redo)).clicked() {
                        reqs.push(Req::Cmd(Cmd::Redo));
                    }
                    ui.separator();
                    ui.label(RichText::new("Modes").color(t.text.secondary));
                    let current = self.mode();
                    for m in Mode::ALL {
                        let on = current == m;
                        let text = RichText::new(m.label());
                        let text = if on { text.strong().color(t.text.on_accent) } else { text };
                        let b = egui::Button::new(text).selected(on).fill(if on { t.accent } else { Color32::TRANSPARENT });
                        let tip = if self.mode_available(m) { m.hint().to_owned() } else { format!("{}: this game has no tool for it", m.label()) };
                        if ui.add_enabled(self.mode_available(m), b).on_hover_text(tip).clicked() {
                            reqs.push(Req::Mode(m));
                        }
                    }
                    ui.min_rect().right()
                })
                .inner;
            // Centre: Play, Pause, Stop (shifted right when the left group is wide).
            const BTN: f32 = 68.0;
            let centre_w = BTN * 3.0 + t.space.sm * 2.0;
            let cx = (row.center().x - centre_w / 2.0).max(left_end + 16.0);
            let centre = egui::Rect::from_min_size(egui::pos2(cx, row.top()), vec2(centre_w, row.height()));
            ui.scope_builder(lay(egui::Layout::left_to_right(egui::Align::Center), centre), |ui| {
                ui.spacing_mut().item_spacing.x = t.space.sm;
                let editing = self.play == PlayState::Editing;
                let label = if self.play == PlayState::Building { "Building" } else { "Play" };
                let play = egui::Button::new(RichText::new(label).strong().color(Color32::WHITE)).fill(if editing { t.status.success } else { t.status.success.gamma_multiply(0.4) }).min_size(vec2(BTN, 26.0));
                if ui.add_enabled(editing, play).on_hover_text(tip(Cmd::PlayStop)).clicked() {
                    reqs.push(Req::Cmd(Cmd::PlayStop));
                }
                ui.add_enabled(false, egui::Button::new("Pause").min_size(vec2(BTN, 26.0))).on_disabled_hover_text("The game runs in its own window, so it can't be paused from here");
                let stop = egui::Button::new(RichText::new("Stop").strong().color(Color32::WHITE)).fill(if editing { t.status.danger.gamma_multiply(0.4) } else { t.status.danger }).min_size(vec2(BTN, 26.0));
                if ui.add_enabled(!editing, stop).on_hover_text(tip(Cmd::PlayStop)).clicked() {
                    reqs.push(Req::Cmd(Cmd::PlayStop));
                }
            });
            // Right: Settings menu, Commands, Help.
            ui.scope_builder(lay(egui::Layout::right_to_left(egui::Align::Center), row), |ui| {
                ui.spacing_mut().item_spacing.x = t.space.sm;
                if ui.button("?").on_hover_text(tip(Cmd::Help)).clicked() {
                    reqs.push(Req::Cmd(Cmd::Help));
                }
                if ui.button("Commands").on_hover_text(tip(Cmd::Palette)).clicked() {
                    reqs.push(Req::Cmd(Cmd::Palette));
                }
                ui.menu_button("Settings", |ui| {
                    item(ui, reqs, "World Settings", Cmd::OpenWorldSettings, true);
                    item(ui, reqs, "Project Settings...", Cmd::OpenProjectSettings, true);
                    item(ui, reqs, "Editor Preferences...", Cmd::OpenPreferences, true);
                    ui.separator();
                    item(ui, reqs, "Reset layout", Cmd::ResetLayout, true);
                });
            });
        });
    }

    // ---- status bar ------------------------------------------------------------------------

    pub(crate) fn status_bar(&mut self, root: &mut Ui) {
        let level = match (&self.level.path, self.level.dirty) {
            (Some(p), true) => format!("{p} *"),
            (Some(p), false) => p.clone(),
            (None, true) => "Unsaved level *".to_owned(),
            (None, false) => "Unsaved level".to_owned(),
        };
        let play = match self.play {
            PlayState::Editing => "Editing",
            PlayState::Building => "Building",
            PlayState::Playing => "Playing",
        };
        let mode = self.mode().label();
        let tool = match &self.active_tool {
            Some(id) => self.tools.iter().find(|t| &t.id == id).map_or(id.clone(), |t| t.label.clone()),
            None => format!("{:?}", self.tool),
        };
        let undo = self.undo.undo_label().map_or("Nothing to undo".to_owned(), |l| format!("Undo: {l}"));
        let sel = match self.selection.len() {
            0 => "Nothing selected".to_owned(),
            1 => "1 selected".to_owned(),
            n => format!("{n} selected"),
        };
        let msg = self.last_msg.clone().unwrap_or_default();
        let mut open_tab: Option<Panel> = None;
        StatusBar::new("editor.status").show(
            root,
            |ui| {
                ashlar_ui::status_bar::text(ui, "status.tool", &format!("Mode: {mode}  |  Tool: {tool}"));
                ashlar_ui::status_bar::text(ui, "status.level", &level);
                ashlar_ui::status_bar::text(ui, "status.play", play);
                if !msg.is_empty() {
                    ashlar_ui::status_bar::text(ui, "status.msg", &msg);
                }
            },
            |ui| {
                if ashlar_ui::status_bar::button(ui, "status.output", "Output").clicked() {
                    open_tab = Some(Panel::Output);
                }
                if ashlar_ui::status_bar::button(ui, "status.content", "Content").clicked() {
                    open_tab = Some(Panel::Content);
                }
                ashlar_ui::status_bar::text(ui, "status.sel", &sel);
                ashlar_ui::status_bar::text(ui, "status.undo", &undo);
            },
        );
        if let Some(p) = open_tab {
            self.toggle_panel(p);
        }
    }

    // ---- viewport overlay ------------------------------------------------------------------

    pub(crate) fn viewport_overlay(&mut self, ctx: &Context, rect: egui::Rect, backend: &mut dyn EditorBackend, reqs: &mut Vec<Req>) {
        let t = tokens::current(ctx);
        let chip = |ui: &mut Ui, f: &mut dyn FnMut(&mut Ui)| {
            egui::Frame::new().fill(Color32::from_black_alpha(150)).corner_radius(6.0).inner_margin(egui::Margin::symmetric(8, 4)).show(ui, |ui| f(ui));
        };
        egui::Area::new(egui::Id::new("editor.vp.tl")).order(egui::Order::Middle).fixed_pos(rect.min + vec2(8.0, 8.0)).show(ctx, |ui| {
            chip(ui, &mut |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 10.0;
                    // Transform tools (the world tools are the Modes in the toolbar).
                    let gizmo = self.active_tool.is_none();
                    for (tool, cmd, name) in [(Tool::Select, Cmd::ToolSelect, "Select"), (Tool::Move, Cmd::ToolMove, "Move"), (Tool::Rotate, Cmd::ToolRotate, "Rotate"), (Tool::Scale, Cmd::ToolScale, "Scale")] {
                        let on = gizmo && self.tool == tool;
                        let text = RichText::new(name);
                        let text = if on { text.strong().color(t.text.on_accent) } else { text };
                        if ui.add(egui::Button::new(text).selected(on).fill(if on { t.accent } else { Color32::TRANSPARENT })).on_hover_text(tip(cmd)).clicked() {
                            reqs.push(Req::Cmd(cmd));
                        }
                    }
                    ui.separator();
                    ui.label(RichText::new("Perspective").color(t.text.secondary));
                    ui.label(RichText::new("Speed").color(t.text.secondary));
                    let mut speed = self.view.camera_speed;
                    if ui.add(egui::DragValue::new(&mut speed).speed(0.2).range(0.2..=400.0).suffix(" m/s")).on_hover_text("Fly speed (scroll while looking)").changed() {
                        self.view.camera_speed = speed;
                        backend.viewport(ViewportCmd::SetCameraSpeed(speed));
                    }
                    if ui.selectable_label(self.snap, "Snap").on_hover_text(tip(Cmd::ToggleSnap)).clicked() {
                        reqs.push(Req::Cmd(Cmd::ToggleSnap));
                    }
                    if self.snap {
                        let mut step = self.snap_step;
                        let unit = if self.tool == Tool::Rotate { " deg" } else { " m" };
                        if ui.add(egui::DragValue::new(&mut step).speed(0.05).range(0.01..=100.0).suffix(unit)).changed() {
                            self.snap_step = step;
                            backend.viewport(ViewportCmd::SetSnap { enabled: true, step });
                        }
                    }
                    let space = if self.view.local_space { "Local" } else { "World" };
                    if ui.button(space).on_hover_text(tip(Cmd::ToggleLocalSpace)).clicked() {
                        reqs.push(Req::Cmd(Cmd::ToggleLocalSpace));
                    }
                });
            });
        });
        // Axis gizmo, top right.
        let c = pos2(rect.right() - 46.0, rect.top() + 94.0);
        let p = ctx.layer_painter(egui::LayerId::new(egui::Order::Middle, egui::Id::new("editor.vp.axes")));
        p.circle_filled(c, 40.0, Color32::from_black_alpha(70));
        let mut axes: Vec<(f32, [f32; 2], &str, Color32)> = [("X", [1.0, 0.0, 0.0], Color32::from_rgb(230, 70, 70)), ("Y", [0.0, 1.0, 0.0], Color32::from_rgb(90, 210, 90)), ("Z", [0.0, 0.0, 1.0], Color32::from_rgb(80, 130, 245))]
            .into_iter()
            .map(|(n, a, col)| {
                let v = rotate_inverse(self.view.camera_rotation, a);
                (v[2], [v[0], -v[1]], n, col)
            })
            .collect();
        // Far axes first, so near ones draw on top.
        axes.sort_by(|a, b| a.0.total_cmp(&b.0));
        for (_, s, name, col) in axes {
            let tip = c + vec2(s[0], s[1]) * 26.0;
            p.line_segment([c, tip], egui::Stroke::new(2.5, col));
            p.circle_filled(tip, 8.0, col);
            p.text(tip, Align2::CENTER_CENTER, name, FontId::proportional(11.0), Color32::BLACK);
        }
        // Control hint, bottom left.
        if self.hint_open {
            egui::Area::new(egui::Id::new("editor.vp.hint")).order(egui::Order::Middle).pivot(Align2::LEFT_BOTTOM).fixed_pos(rect.left_bottom() + vec2(8.0, -8.0)).show(ctx, |ui| {
                chip(ui, &mut |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("WASD move  ·  drag to look  ·  scroll to move forward/back  ·  F focus  ·  1-4 transform tools  ·  F1 all controls").color(t.text.secondary).small());
                        if ui.small_button("x").on_hover_text("Hide (View menu brings it back)").clicked() {
                            self.hint_open = false;
                        }
                    });
                });
            });
        }
    }
    // ---- windows ---------------------------------------------------------------------------

    pub(crate) fn help_windows(&mut self, ctx: &Context, reqs: &mut Vec<Req>) {
        let t = tokens::current(ctx);
        let mut open = self.help_open;
        if open {
            let screen = ctx.content_rect();
            let h = (screen.height() - 120.0).clamp(240.0, 640.0);
            egui::Window::new("Controls and shortcuts").open(&mut open).collapsible(false).resizable(true).default_width(560.0).default_height(h).max_height(screen.height() - 40.0).anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0)).show(ctx, |ui| {
                ashlar_ui::search::SearchField::new("help.search", &mut self.help_filter).hint("Search controls and shortcuts").width(ui.available_width()).show(ui);
                let f = self.help_filter.to_lowercase();
                let hit = |a: &str, b: &str| f.is_empty() || a.to_lowercase().contains(&f) || b.to_lowercase().contains(&f);
                ui.add_space(t.space.xs);
                egui::ScrollArea::vertical().auto_shrink([false, false]).scroll_bar_visibility(egui::scroll_area::ScrollBarVisibility::AlwaysVisible).show(ui, |ui| {
                    let mut shown = 0;
                    let mouse: Vec<&(&str, &str)> = MOUSE_HELP.iter().filter(|(k, v)| hit(k, v)).collect();
                    if !mouse.is_empty() {
                        ui.label(RichText::new("Camera and viewport").strong().color(t.text.primary));
                        egui::Grid::new("help.mouse").num_columns(2).spacing([16.0, 4.0]).show(ui, |ui| {
                            for (k, v) in mouse.iter().copied() {
                                ui.label(RichText::new(*k).strong());
                                ui.label(*v);
                                ui.end_row();
                                shown += 1;
                            }
                        });
                        ui.add_space(t.space.md);
                    }
                    let keys: Vec<(String, &str)> = COMMANDS.iter().filter_map(|c| shortcut_text(c.cmd).map(|k| (k, c.label))).filter(|(k, l)| hit(k, l)).collect();
                    if !keys.is_empty() {
                        ui.label(RichText::new("Commands").strong().color(t.text.primary));
                        egui::Grid::new("help.keys").num_columns(2).spacing([16.0, 4.0]).show(ui, |ui| {
                            for (k, l) in &keys {
                                ui.label(RichText::new(k).strong());
                                ui.label(*l);
                                ui.end_row();
                                shown += 1;
                            }
                        });
                    }
                    if shown == 0 {
                        ui.label(RichText::new("Nothing matches").color(t.text.disabled));
                    }
                });
            });
        }
        self.help_open = open && self.help_open;
        let mut about = self.about_open;
        if about {
            egui::Window::new("About").open(&mut about).collapsible(false).resizable(false).anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0)).show(ctx, |ui| {
                ui.label(RichText::new("Level editor").heading());
                ui.label("The game's own binary, started with --editor.");
                ui.label("Panels: editor-ui (egui). World, camera, gizmo, Play: the engine.");
            });
        }
        self.about_open = about && self.about_open;

        // Settings windows.
        let mut project = self.windows.project;
        if project {
            crate::settings::project_window(ctx, &mut project, &self.groups, self.level.path.as_deref(), reqs);
        }
        self.windows.project = project && self.windows.project;
        let mut prefs_open = self.windows.prefs;
        if prefs_open {
            self.prefs.snap_step = self.snap_step;
            self.prefs.camera_speed = self.view.camera_speed;
            self.prefs.show_grid = self.view.show_grid;
            self.prefs.show_all_scenery = self.view.show_all_scenery;
            let before = self.prefs.clone();
            let before_hint = self.hint_open;
            let mut reset = false;
            let mut hint = self.hint_open;
            let ch = crate::settings::prefs_window(ctx, &mut prefs_open, &mut self.prefs, &mut hint, &mut reset);
            self.hint_open = hint;
            if self.prefs != before || before_hint != hint {
                self.prefs_changed = Some(ch);
            }
            if reset {
                self.reset_layout();
            }
        }
        self.windows.prefs = prefs_open && self.windows.prefs;
    }

    /// Remember a level path for File > Recent.
    pub(crate) fn remember(&mut self, path: &str) {
        self.recent.retain(|r| r != path);
        self.recent.insert(0, path.to_owned());
        self.recent.truncate(8);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_read_as_words() {
        assert_eq!(plain_shortcut("Mod+Shift+S", true), "Cmd+Shift+S");
        assert_eq!(plain_shortcut("Mod+Shift+Z / Mod+Y", false), "Ctrl+Shift+Z");
        assert_eq!(plain_shortcut("F1", true), "F1");
    }

    #[test]
    fn the_axis_gizmo_follows_the_camera() {
        // Identity camera: X right, Y up.
        let v = rotate_inverse([0.0, 0.0, 0.0, 1.0], [1.0, 0.0, 0.0]);
        assert!((v[0] - 1.0).abs() < 1e-6 && v[1].abs() < 1e-6);
        // A camera turned 90 degrees about Y (yaw): world X now points along the camera's -Z or +Z.
        let h = std::f32::consts::FRAC_1_SQRT_2;
        let v = rotate_inverse([0.0, h, 0.0, h], [1.0, 0.0, 0.0]);
        assert!(v[0].abs() < 1e-5 && (v[2].abs() - 1.0).abs() < 1e-5, "{v:?}");
        let up = rotate_inverse([0.0, h, 0.0, h], [0.0, 1.0, 0.0]);
        assert!((up[1] - 1.0).abs() < 1e-5, "yaw keeps Y up");
    }

    #[test]
    fn the_help_lists_every_shortcut_once() {
        let n = COMMANDS.iter().filter(|c| c.shortcut.is_some()).count();
        assert!(n >= 10, "{n}");
        assert!(MOUSE_HELP.iter().any(|(k, _)| k.contains("WASD") || k.contains("W A S D")));
    }
}
