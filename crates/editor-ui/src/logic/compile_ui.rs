//! Compile results: the status chip and the "Compiler Results" strip under the canvas.

use ashlar_ui::tokens;
use egui::{RichText, Ui};
use logic_core::Severity;

use super::state::GraphDoc;

/// `(text, is_error, is_warning)` for the toolbar chip.
pub fn status(doc: &GraphDoc) -> (String, bool, bool) {
    let e = doc.errors.iter().filter(|e| e.severity == Severity::Error).count();
    let w = doc.errors.len() - e;
    if e > 0 {
        (format!("{e} error{}", if e == 1 { "" } else { "s" }), true, false)
    } else if w > 0 {
        (format!("OK, {w} warning{}", if w == 1 { "" } else { "s" }), false, true)
    } else {
        ("OK".to_string(), false, false)
    }
}

/// The results list. Returns a node id to go to.
pub fn strip(ui: &mut Ui, doc: &mut GraphDoc) -> Option<u32> {
    let t = tokens::current(ui.ctx());
    let mut goto = None;
    ui.horizontal(|ui| {
        ui.label(RichText::new("COMPILER RESULTS").strong().color(t.text.secondary).size(11.0));
        let (s, bad, warn) = status(doc);
        ui.label(RichText::new(s).color(if bad { t.status.danger } else if warn { t.status.warning } else { t.status.success }));
    });
    egui::ScrollArea::vertical().max_height(120.0).auto_shrink([false, true]).show(ui, |ui| {
        if doc.errors.is_empty() {
            ui.weak("No problems.");
        }
        for e in doc.errors.clone() {
            ui.horizontal(|ui| {
                let (word, col) = if e.severity == Severity::Error { ("Error", t.status.danger) } else { ("Warning", t.status.warning) };
                ui.label(RichText::new(word).color(col).strong());
                let place = match e.node {
                    Some(n) => {
                        let name = doc.graph.node(n).map_or_else(|| "?".to_string(), |x| logic_core::kind_name(&x.kind));
                        match &e.pin {
                            Some(p) => format!("node {n} {name} pin {p}:"),
                            None => format!("node {n} {name}:"),
                        }
                    }
                    None => "graph:".to_string(),
                };
                ui.label(RichText::new(place).color(t.text.secondary));
                ui.label(&e.message);
                if let Some(n) = e.node
                    && ui.small_button("Go to").clicked()
                {
                    goto = Some(n);
                }
            });
        }
        if let Some(tr) = &doc.trace {
            ui.separator();
            ui.label(RichText::new(format!("Last fire ran {} nodes", tr.nodes.len())).color(t.text.secondary));
            if let Some(err) = &tr.error {
                ui.label(RichText::new(err).color(t.status.danger));
            }
            for l in &tr.log {
                ui.label(RichText::new(l).monospace());
            }
        }
    });
    goto
}
