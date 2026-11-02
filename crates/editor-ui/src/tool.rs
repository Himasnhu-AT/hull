//! Tool panel: the active tool's settings (the same property grid as Details) and the Place
//! palette. Tools are generic ids + schemas from the backend; nothing here knows what a brush is.

use ashlar_ui::tokens;
use editor_proto::{PlaceableDoc, ToolDoc};
use egui::{RichText, Ui};
use serde_json::json;

use crate::model::Req;
use crate::props::{self, Cx, Phase};

pub(crate) struct View<'a> {
    pub tool: Option<&'a ToolDoc>,
    pub placeables: &'a [PlaceableDoc],
}

pub(crate) fn show(ui: &mut Ui, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        match v.tool {
            None => {
                ui.add_space(t.space.md);
                ui.label(RichText::new("No tool selected").color(t.text.disabled));
                ui.label(RichText::new("Pick Spline, Sculpt, Paint, Foliage or Place in the toolbar.").color(t.text.secondary).small());
            }
            Some(tool) => {
                ui.add_space(t.space.sm);
                ui.label(RichText::new(&tool.label).heading());
                if !tool.hint.is_empty() {
                    ui.label(RichText::new(&tool.hint).color(t.text.secondary).small());
                }
                ui.separator();
                let mut working = tool.settings.clone();
                let mut cx = Cx::new(format!("tool.{}", tool.id), false);
                props::component_body(ui, &mut cx, &tool.schema, &mut working);
                if let Some(change) = cx.change
                    && change.phase != Phase::Begin
                    && working != tool.settings
                {
                    reqs.push(Req::ToolSettings { id: tool.id.clone(), settings: working });
                }
            }
        }
        if !v.placeables.is_empty() {
            ui.add_space(t.space.md);
            ui.separator();
            ui.label(RichText::new("Place").strong().color(t.text.primary));
            let mut cats: Vec<&str> = v.placeables.iter().map(|p| p.category.as_str()).collect();
            cats.sort_unstable();
            cats.dedup();
            let current = v.tool.filter(|t| t.id == "place").and_then(|t| t.settings.get("type_path")).and_then(|x| x.as_str());
            for cat in cats {
                ui.label(RichText::new(cat).color(t.text.secondary).small());
                ui.horizontal_wrapped(|ui| {
                    for p in v.placeables.iter().filter(|p| p.category == cat) {
                        let on = current == Some(p.type_path.as_str());
                        if ui.selectable_label(on, &p.name).on_hover_text(&p.type_path).clicked() {
                            reqs.push(Req::ToolSettings { id: "place".into(), settings: json!({"type_path": p.type_path}) });
                            reqs.push(Req::Tool(Some("place".into())));
                        }
                    }
                });
            }
        }
    });
}
