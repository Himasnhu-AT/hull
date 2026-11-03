//! The Modes panel (left dock): what the current mode does, its tool settings, and in Select and
//! Place mode the palette of things to place. One place for what used to be the Tool and Place
//! tabs.

use ashlar_ui::tokens;
use editor_proto::{AssetEntry, PlaceableDoc, ToolDoc};
use egui::{RichText, Ui};

use crate::model::{Mode, Req};
use crate::place::{self, PlaceState};
use crate::tool;

pub(crate) struct View<'a> {
    pub mode: Mode,
    pub tools: &'a [ToolDoc],
    pub active_tool: Option<&'a str>,
    pub placeables: &'a [PlaceableDoc],
    pub models: &'a [AssetEntry],
}

pub(crate) fn show(ui: &mut Ui, st: &mut PlaceState, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    ui.add_space(t.space.xs);
    ui.label(RichText::new(v.mode.label()).heading());
    ui.label(RichText::new(v.mode.hint()).color(t.text.secondary).small());
    ui.separator();
    let active_tool = v.active_tool.and_then(|id| v.tools.iter().find(|t| t.id == id));
    // Landscape has two tools: a switch between them.
    if v.mode == Mode::Landscape {
        ui.horizontal(|ui| {
            for id in v.mode.tool_ids() {
                if let Some(doc) = v.tools.iter().find(|t| t.id == *id) {
                    let on = v.active_tool == Some(doc.id.as_str());
                    if ui.selectable_label(on, &doc.label).on_hover_text(&doc.hint).clicked() && !on {
                        reqs.push(Req::Tool(Some(doc.id.clone())));
                    }
                }
            }
        });
        ui.add_space(t.space.xs);
    }
    let active_type = active_tool.filter(|t| t.id == "place").and_then(|t| t.settings.get("type_path")).and_then(|v| v.as_str());
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        match v.mode {
            Mode::Select => place::palette(ui, st, v.placeables, v.models, active_type, reqs),
            Mode::Place => {
                place::type_picker(ui, v.placeables, active_type, reqs);
                if let Some(doc) = active_tool {
                    ui.add_space(t.space.xs);
                    tool::settings(ui, doc, &["type_path"], reqs);
                }
                ui.add_space(t.space.sm);
                ui.separator();
                place::palette(ui, st, v.placeables, v.models, active_type, reqs);
            }
            Mode::Landscape | Mode::Foliage | Mode::Splines => match active_tool {
                Some(doc) => {
                    if !doc.hint.is_empty() {
                        ui.label(RichText::new(&doc.hint).color(t.text.secondary).small());
                        ui.add_space(t.space.xs);
                    }
                    tool::settings(ui, doc, &[], reqs);
                }
                None => {
                    ui.label(RichText::new("This game has no tool for this mode").color(t.text.disabled));
                }
            },
        };
    });
}
