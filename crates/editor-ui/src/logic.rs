//! Logic panel: placeholder until the graph editor lands (docs/EDITOR.md, "Logic graphs").

use ashlar_ui::tokens;
use egui::Ui;

pub(crate) fn show(ui: &mut Ui) {
    let t = tokens::current(ui.ctx());
    ui.add_space(t.space.md);
    ui.label(egui::RichText::new("Logic graphs").color(t.text.primary).strong());
    ui.label(egui::RichText::new("The node graph editor comes with the logic runtime.").color(t.text.secondary));
}
