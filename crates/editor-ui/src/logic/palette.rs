//! The node palette: searchable, grouped, and context sensitive. Entries come from three
//! sources: logic-core's node kinds (so the palette and the validator agree), the engine's
//! control commands, and the functions found in ruspy scripts. Variables add Get / Set entries.

use logic_core::{NodeKind, Var};

use super::state::{Library, PinLayout, PinTy};

#[derive(Clone, Debug)]
pub struct Entry {
    pub label: String,
    pub category: String,
    pub doc: String,
    pub kind: NodeKind,
    pub layout: PinLayout,
}

impl Entry {
    pub fn new(kind: NodeKind, category: &str, doc: &str, vars: &[Var]) -> Entry {
        Entry { label: logic_core::label(&kind), category: category.into(), doc: doc.into(), layout: PinLayout::of(vars, &kind), kind }
    }
}

/// Kinds + commands + script functions (variables are added per graph).
pub fn base_entries(lib: &Library) -> Vec<Entry> {
    let mut v: Vec<Entry> = logic_core::templates().into_iter().map(|t| Entry::new(t.kind.clone(), t.category, logic_core::docs(&t.kind), &[])).collect();
    for n in &lib.palette.nodes {
        if n.category != "Commands" && n.category != "Scripts" {
            continue;
        }
        if let Ok(kind) = serde_json::from_value::<NodeKind>(n.kind_json.clone()) {
            v.push(Entry::new(kind, &n.category, &n.doc, &[]));
        }
    }
    v
}

/// Variable entries for a graph.
pub fn var_entries(vars: &[Var]) -> Vec<Entry> {
    let mut v = Vec::new();
    for var in vars {
        v.push(Entry::new(NodeKind::GetVar(var.name.clone()), "Variables", logic_core::docs(&NodeKind::GetVar(String::new())), vars));
        v.push(Entry::new(NodeKind::SetVar(var.name.clone()), "Variables", logic_core::docs(&NodeKind::SetVar(String::new())), vars));
    }
    v
}

/// What the palette was opened from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Filter {
    None,
    /// Dragged off an output pin of this type: nodes with an input it can feed.
    FromOut(PinTy),
    /// Dragged off an input pin: nodes with an output that can feed it.
    FromIn(PinTy),
}

impl Filter {
    pub fn accepts(self, e: &Entry) -> bool {
        match self {
            Filter::None => true,
            Filter::FromOut(t) => e.layout.ins.iter().any(|p| t.feeds(p.ty)),
            Filter::FromIn(t) => e.layout.outs.iter().any(|p| p.ty.feeds(t)),
        }
    }
    /// The pin of `e` a wire from the dragged pin should land on: the first compatible one.
    pub fn target_pin(self, e: &Entry) -> Option<usize> {
        match self {
            Filter::None => None,
            Filter::FromOut(t) => e.layout.ins.iter().position(|p| t.feeds(p.ty)),
            Filter::FromIn(t) => e.layout.outs.iter().position(|p| p.ty.feeds(t)),
        }
    }
}

pub enum Picked {
    Node(Entry),
    Comment,
}

pub fn matches(e: &Entry, q: &str) -> bool {
    if q.is_empty() {
        return true;
    }
    let q = q.to_lowercase();
    e.label.to_lowercase().contains(&q) || e.category.to_lowercase().contains(&q) || e.doc.to_lowercase().contains(&q)
}

const ORDER: &[&str] = &["Events", "Flow", "World", "Variables", "Math", "Vec3", "Effects", "Commands", "Scripts"];

/// Category colour used for node headers and palette headings.
pub fn category_color(cat: &str) -> egui::Color32 {
    match cat {
        "Events" => egui::Color32::from_rgb(170, 50, 50),
        "Flow" => egui::Color32::from_rgb(90, 90, 100),
        "World" => egui::Color32::from_rgb(50, 110, 160),
        "Variables" => egui::Color32::from_rgb(60, 130, 120),
        "Math" => egui::Color32::from_rgb(60, 130, 70),
        "Vec3" => egui::Color32::from_rgb(150, 125, 40),
        "Effects" => egui::Color32::from_rgb(140, 70, 150),
        "Commands" => egui::Color32::from_rgb(190, 110, 40),
        "Scripts" => egui::Color32::from_rgb(60, 100, 170),
        _ => egui::Color32::from_rgb(80, 80, 90),
    }
}

/// The palette popup body. Returns what was picked.
pub fn menu(ui: &mut egui::Ui, entries: &[Entry], vars: &[Var], filter: Filter, search: &mut String) -> Option<Picked> {
    let mut picked = None;
    ui.set_min_width(260.0);
    ui.horizontal(|ui| {
        let r = ui.add(egui::TextEdit::singleline(search).hint_text("Search nodes").desired_width(180.0));
        if !r.has_focus() && search.is_empty() {
            r.request_focus();
        }
        if filter != Filter::None {
            ui.weak("filtered by pin");
        }
    });
    ui.separator();
    let var_entries = var_entries(vars);
    let all: Vec<&Entry> = entries.iter().chain(var_entries.iter()).filter(|e| filter.accepts(e) && matches(e, search)).collect();
    egui::ScrollArea::vertical().max_height(360.0).auto_shrink([true, true]).show(ui, |ui| {
        if all.is_empty() {
            ui.weak("No node matches.");
        }
        let searching = !search.is_empty();
        let mut cats: Vec<&str> = ORDER.iter().copied().filter(|c| all.iter().any(|e| e.category == *c)).collect();
        for e in &all {
            if !cats.contains(&e.category.as_str()) {
                cats.push(&e.category);
            }
        }
        for cat in cats {
            let items: Vec<&&Entry> = all.iter().filter(|e| e.category == cat).collect();
            let body = |ui: &mut egui::Ui| {
                for e in items {
                    let r = ui.add(egui::Button::new(&e.label).frame(false).min_size(egui::vec2(220.0, 0.0)));
                    let r = if e.doc.is_empty() { r } else { r.on_hover_text(&e.doc) };
                    if r.clicked() {
                        picked = Some(Picked::Node((*e).clone()));
                        ui.close();
                    }
                }
            };
            let title = egui::RichText::new(format!("{cat} ({})", items_len(&all, cat))).color(category_color(cat)).strong();
            if searching {
                ui.label(title);
                body(ui);
            } else {
                egui::CollapsingHeader::new(title).id_salt(("palette", cat)).default_open(cat == "Flow" || cat == "Events").show(ui, body);
            }
        }
    });
    if filter == Filter::None {
        ui.separator();
        if ui.button("Add comment").clicked() {
            picked = Some(Picked::Comment);
            ui.close();
        }
    }
    picked
}

fn items_len(all: &[&Entry], cat: &str) -> usize {
    all.iter().filter(|e| e.category == cat).count()
}
