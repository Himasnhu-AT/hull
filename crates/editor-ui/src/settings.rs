//! Settings surfaces: the World Settings tab (a dock panel), the Project Settings window and the
//! Editor Preferences window. World and project values come from the backend as schema + JSON
//! groups and are drawn with the same property grid as Details; editor preferences live in
//! `editor_prefs.json` (see `EditorUi::prefs_json`).

use ashlar_ui::tokens;
use editor_proto::{SettingsGroup, SettingsPage};
use egui::{Align2, Context, RichText, Ui, vec2};
use serde::{Deserialize, Serialize};

use crate::model::Req;
use crate::props::{self, Cx, Phase};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

/// What `editor_prefs.json` holds: look and feel and viewport defaults, not level data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub theme: Theme,
    /// egui zoom factor (0.75 to 1.75).
    pub ui_scale: f32,
    /// Fly speed in m/s.
    pub camera_speed: f32,
    /// Snap step in metres (degrees for rotation).
    pub snap_step: f32,
    pub show_hint: bool,
    pub show_grid: bool,
    pub show_all_scenery: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { theme: Theme::Dark, ui_scale: 1.0, camera_speed: 8.0, snap_step: 0.5, show_hint: true, show_grid: true, show_all_scenery: false }
    }
}

impl Prefs {
    /// Clamps every value into its valid range (a hand-edited file must not break the UI).
    pub fn sanitized(mut self) -> Prefs {
        let fin = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        self.ui_scale = fin(self.ui_scale, 0.75, 1.75, 1.0);
        self.camera_speed = fin(self.camera_speed, 0.2, 400.0, 8.0);
        self.snap_step = fin(self.snap_step, 0.01, 100.0, 0.5);
        self
    }
}

/// Which settings window pages are open.
#[derive(Default)]
pub(crate) struct SettingsWindows {
    pub project: bool,
    pub prefs: bool,
}

/// The World Settings dock panel: one collapsible section per world-page group.
pub(crate) fn world_tab(ui: &mut Ui, groups: &[SettingsGroup], reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        let mut any = false;
        for (i, g) in groups.iter().filter(|g| g.page == SettingsPage::World).enumerate() {
            any = true;
            section(ui, g, i == 0, reqs);
        }
        if !any {
            ui.add_space(t.space.md);
            ui.label(RichText::new("No world settings in this game").color(t.text.disabled));
            ui.label(RichText::new("Sun, sky and fog need the `look` feature; terrain needs a spawned world.").color(t.text.secondary).small());
        }
    });
}

fn section(ui: &mut Ui, g: &SettingsGroup, open: bool, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    egui::CollapsingHeader::new(RichText::new(&g.label).strong()).id_salt(("settings.group", &g.id)).default_open(open).show(ui, |ui| {
        if !g.hint.is_empty() {
            ui.label(RichText::new(&g.hint).color(t.text.secondary).small());
        }
        let mut working = g.value.clone();
        let mut cx = Cx::new(format!("settings.{}", g.id), false);
        props::component_body(ui, &mut cx, &g.schema, &mut working);
        if let Some(c) = cx.change
            && c.phase != Phase::Begin
            && working != g.value
        {
            reqs.push(Req::Settings { group: g.id.clone(), value: working });
        }
    });
}

/// The Project Settings window: project-wide budgets and switches.
pub(crate) fn project_window(ctx: &Context, open: &mut bool, groups: &[SettingsGroup], level: Option<&str>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ctx);
    egui::Window::new("Project Settings").open(open).collapsible(false).resizable(true).default_size([460.0, 460.0]).anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0)).show(ctx, |ui| {
        ui.label(RichText::new("Applies to the whole game, not one level. Changes take effect at once in the editor and in Play.").color(t.text.secondary).small());
        ui.horizontal(|ui| {
            ui.label(RichText::new("Open level").color(t.text.secondary));
            ui.label(level.unwrap_or("(unsaved)"));
        });
        ui.separator();
        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            let mut any = false;
            for g in groups.iter().filter(|g| g.page == SettingsPage::Project) {
                any = true;
                section(ui, g, true, reqs);
            }
            if !any {
                ui.label(RichText::new("No project settings in this game").color(t.text.disabled));
            }
        });
    });
}

/// What the Editor Preferences window changed this frame.
#[derive(Default)]
pub(crate) struct PrefsChange {
    pub theme: bool,
    pub scale: bool,
    pub camera_speed: bool,
    pub grid: bool,
    pub scenery: bool,
    pub snap: bool,
}

/// The Editor Preferences window.
pub(crate) fn prefs_window(ctx: &Context, open: &mut bool, p: &mut Prefs, hint: &mut bool, reset_layout: &mut bool) -> PrefsChange {
    let t = tokens::current(ctx);
    let mut ch = PrefsChange::default();
    egui::Window::new("Editor Preferences").open(open).collapsible(false).resizable(true).default_size([420.0, 380.0]).anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0)).show(ctx, |ui| {
        ui.label(RichText::new("Saved to editor_prefs.json next to the layout.").color(t.text.secondary).small());
        ui.add_space(t.space.sm);
        egui::Grid::new("prefs.grid").num_columns(2).spacing([16.0, 8.0]).show(ui, |ui| {
            ui.label("Theme");
            ui.horizontal(|ui| {
                ch.theme |= ui.selectable_value(&mut p.theme, Theme::Dark, "Dark").changed();
                ch.theme |= ui.selectable_value(&mut p.theme, Theme::Light, "Light").changed();
            });
            ui.end_row();
            ui.label("UI scale");
            ch.scale |= ui.add(egui::Slider::new(&mut p.ui_scale, 0.75..=1.75).step_by(0.05)).changed();
            ui.end_row();
            ui.label("Fly speed");
            ch.camera_speed |= ui.add(egui::DragValue::new(&mut p.camera_speed).speed(0.2).range(0.2..=400.0).suffix(" m/s")).changed();
            ui.end_row();
            ui.label("Snap step");
            ch.snap |= ui.add(egui::DragValue::new(&mut p.snap_step).speed(0.05).range(0.01..=100.0)).changed();
            ui.end_row();
            ui.label("Ground grid");
            ch.grid |= ui.checkbox(&mut p.show_grid, "Show").changed();
            ui.end_row();
            ui.label("Scenery");
            ch.scenery |= ui.checkbox(&mut p.show_all_scenery, "Show all (no distance fade)").changed();
            ui.end_row();
            ui.label("Control hint");
            ui.checkbox(hint, "Show in the viewport");
            ui.end_row();
        });
        ui.add_space(t.space.md);
        if ui.button("Reset panel layout").clicked() {
            *reset_layout = true;
        }
    });
    ch
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_roundtrip_and_clamp() {
        let p = Prefs { camera_speed: f32::NAN, ui_scale: 9.0, ..Default::default() }.sanitized();
        assert_eq!(p.camera_speed, 8.0);
        assert_eq!(p.ui_scale, 1.75);
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(serde_json::from_str::<Prefs>(&json).unwrap(), p);
        // Missing keys fall back to defaults.
        assert_eq!(serde_json::from_str::<Prefs>("{}").unwrap(), Prefs::default());
    }
}
