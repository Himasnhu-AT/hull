//! Tool panel: the active tool's settings (the same property grid as Details) and the Place
//! palette. Tools are generic ids + schemas from the backend; nothing here knows what a brush is.

use ashlar_ui::tokens;
use editor_proto::ToolDoc;
use egui::{RichText, Ui};

use crate::model::Req;
use crate::props::{self, Cx, Phase};

pub(crate) struct View<'a> {
    pub tool: Option<&'a ToolDoc>,
}

pub(crate) fn show(ui: &mut Ui, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        match v.tool {
            None => {
                ui.add_space(t.space.md);
                ui.label(RichText::new("No tool selected").color(t.text.disabled));
                ui.label(RichText::new("Pick Spline, Sculpt, Paint, Foliage or Place in the toolbar (keys 5-9).").color(t.text.secondary).small());
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
    });
}
