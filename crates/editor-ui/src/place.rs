//! Place panel: the types and library models you can put into the level. Click one: a type arms
//! the Place tool (then click in the viewport), a model is placed at the middle of the view.

use ashlar_ui::search::SearchField;
use ashlar_ui::tokens;
use editor_proto::{AssetEntry, AssetKind, EditorBackend, PlaceableDoc};
use egui::{RichText, Ui};
use serde_json::json;

use crate::model::Req;

#[derive(Default)]
pub(crate) struct PlaceState {
    pub filter: String,
}

/// Models under `library/` (a few levels deep, capped), for the panel.
pub(crate) fn scan_models(b: &mut dyn EditorBackend) -> Vec<AssetEntry> {
    let mut out = Vec::new();
    let mut dirs = vec!["library".to_owned()];
    let mut visited = 0;
    while let Some(d) = dirs.pop() {
        visited += 1;
        if visited > 80 || out.len() > 800 {
            break;
        }
        for e in b.assets(&d) {
            match e.kind {
                AssetKind::Folder => dirs.push(e.path),
                AssetKind::Model => out.push(e),
                _ => {}
            }
        }
    }
    out.sort_by(|a, c| a.path.cmp(&c.path));
    out
}

fn folder_of(path: &str) -> String {
    let p = path.rsplit_once('/').map_or("", |x| x.0);
    p.strip_prefix("library/").unwrap_or(p).to_owned()
}

pub(crate) fn show(ui: &mut Ui, st: &mut PlaceState, placeables: &[PlaceableDoc], models: &[AssetEntry], active_type: Option<&str>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    SearchField::new("place.search", &mut st.filter).hint("Search types and models").width(ui.available_width()).show(ui);
    let f = st.filter.to_lowercase();
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        if placeables.is_empty() && models.is_empty() {
            ui.add_space(t.space.md);
            ui.label(RichText::new("Nothing to place yet").color(t.text.disabled));
            ui.label(RichText::new("Games register types with register_placeable; models come from assets/library.").color(t.text.secondary).small());
        }
        let mut cats: Vec<&str> = placeables.iter().map(|p| p.category.as_str()).collect();
        cats.sort_unstable();
        cats.dedup();
        for cat in cats {
            let items: Vec<&PlaceableDoc> = placeables.iter().filter(|p| p.category == cat && (f.is_empty() || p.name.to_lowercase().contains(&f))).collect();
            if items.is_empty() {
                continue;
            }
            egui::CollapsingHeader::new(RichText::new(format!("{cat} ({})", items.len())).strong()).default_open(true).show(ui, |ui| {
                for p in items {
                    let on = active_type == Some(p.type_path.as_str());
                    if ui.selectable_label(on, &p.name).on_hover_text(format!("{}\nClick, then click in the viewport", p.type_path)).clicked() {
                        reqs.push(Req::ToolSettings { id: "place".into(), settings: json!({"type_path": p.type_path}) });
                        reqs.push(Req::Tool(Some("place".into())));
                    }
                }
            });
        }
        let mut folders: Vec<String> = models.iter().map(|m| folder_of(&m.path)).collect();
        folders.dedup();
        folders.sort();
        folders.dedup();
        if !models.is_empty() {
            ui.add_space(t.space.sm);
            ui.label(RichText::new("Library models").strong().color(t.text.primary));
        }
        for folder in folders {
            let items: Vec<&AssetEntry> = models.iter().filter(|m| folder_of(&m.path) == folder && (f.is_empty() || m.name.to_lowercase().contains(&f))).collect();
            if items.is_empty() {
                continue;
            }
            let lic = items.iter().find_map(|m| m.license.clone());
            let title = match lic {
                Some(l) => format!("{folder} ({}) [{l}]", items.len()),
                None => format!("{folder} ({})", items.len()),
            };
            egui::CollapsingHeader::new(title).default_open(!f.is_empty()).id_salt(("place.folder", &folder)).show(ui, |ui| {
                for m in items {
                    if ui.selectable_label(false, m.name.trim_end_matches(".glb").trim_end_matches(".gltf")).on_hover_text(format!("{}\nClick to place at the middle of the view", m.path)).clicked() {
                        reqs.push(Req::Place(m.path.clone()));
                    }
                }
            });
        }
    });
}
