//! Content Browser: folders, search, licence badges, place into the level.

use ashlar_ui::search::SearchField;
use ashlar_ui::tokens::{self, Tokens};
use editor_proto::{AssetEntry, AssetKind};
use egui::{Color32, Rect, Sense, Ui, vec2};

use crate::model::Req;

#[derive(Default)]
pub(crate) struct ContentState {
    /// Directory shown, `""` = asset root.
    pub dir: String,
    pub search: String,
    pub(crate) selected: Option<usize>,
    pub dir_changed: bool,
}

impl ContentState {
    pub fn set_dir(&mut self, dir: &str) {
        self.dir = dir.trim_matches('/').to_owned();
        self.selected = None;
        self.dir_changed = true;
    }
}

fn glyph(k: AssetKind) -> &'static str {
    match k {
        AssetKind::Folder => "[+]",
        AssetKind::Model => "3D",
        AssetKind::Texture => "IMG",
        AssetKind::Audio => "SND",
        AssetKind::Level => "LVL",
        AssetKind::Script => "SCR",
        AssetKind::Logic => "LOG",
        AssetKind::Material => "MAT",
        AssetKind::Other => "...",
    }
}

fn licence_color(l: &str, t: &Tokens) -> Color32 {
    let up = l.to_uppercase();
    if up.starts_with("CC0") || up == "MIT" || up.starts_with("APACHE") || up == "PUBLIC-DOMAIN" {
        t.status.success
    } else if up.contains("UE-ONLY") || up.contains("REFERENCE") || up.contains("EPIC") {
        t.status.danger
    } else {
        t.status.warning
    }
}

/// Entries matching the search text (case-insensitive name match).
pub(crate) fn filtered<'a>(entries: &'a [AssetEntry], search: &str) -> Vec<&'a AssetEntry> {
    let s = search.to_lowercase();
    entries.iter().filter(|e| s.is_empty() || e.name.to_lowercase().contains(&s)).collect()
}

pub(crate) fn show(ui: &mut Ui, st: &mut ContentState, entries: &[AssetEntry], reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    // Breadcrumbs.
    let mut goto: Option<String> = None;
    ui.horizontal_wrapped(|ui| {
        if ui.link("assets").clicked() {
            goto = Some(String::new());
        }
        let mut acc = String::new();
        for part in st.dir.split('/').filter(|p| !p.is_empty()) {
            ui.label(RichText_secondary("/", &t));
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            if ui.link(part).clicked() {
                goto = Some(acc.clone());
            }
        }
    });
    ui.horizontal(|ui| {
        SearchField::new("content.search", &mut st.search)
            .hint("Search assets")
            .width(ui.available_width())
            .show(ui);
    });
    let list = filtered(entries, &st.search);
    if list.is_empty() {
        ui.add_space(t.space.md);
        ui.label(egui::RichText::new(if entries.is_empty() { "Empty folder" } else { "No matches" }).color(t.text.disabled));
    }
    // A grid of tiles: a big glyph (a thumbnail when the backend has one), the name, the licence.
    let tile = vec2(104.0, 98.0);
    let mut activate: Option<usize> = None;
    let mut click: Option<usize> = None;
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = vec2(8.0, 8.0);
            for (i, e) in list.iter().enumerate() {
                let (rect, resp) = ui.allocate_exact_size(tile, Sense::click());
                let selected = st.selected == Some(i);
                crate::model::a11y_row(ui, rect, egui::Id::new(("content.row", &e.path)), &e.name, selected);
                let bg = if selected { t.selection } else if resp.hovered() { t.surface.raised } else { t.surface.panel };
                ui.painter().rect_filled(rect, 6.0, bg);
                ui.painter().rect_stroke(rect, 6.0, egui::Stroke::new(1.0, if selected { t.accent } else { t.text.disabled }), egui::StrokeKind::Inside);
                let icon = Rect::from_min_size(rect.min + vec2(8.0, 8.0), vec2(tile.x - 16.0, 48.0));
                let kc = match e.kind {
                    AssetKind::Folder => t.status.warning,
                    AssetKind::Model => t.status.info,
                    AssetKind::Texture => t.status.success,
                    _ => t.accent,
                };
                ui.painter().rect_filled(icon, 4.0, kc.gamma_multiply(0.18));
                ui.painter().text(icon.center(), egui::Align2::CENTER_CENTER, glyph(e.kind), Tokens::font(t.type_scale.heading), kc);
                let name = e.name.trim_end_matches(".glb").trim_end_matches(".gltf");
                let g = ui.painter().layout(name.to_owned(), Tokens::font(t.type_scale.small), if selected { t.selection_text } else { t.text.primary }, tile.x - 10.0);
                ui.painter().with_clip_rect(Rect::from_min_size(rect.min + vec2(5.0, 60.0), vec2(tile.x - 10.0, 18.0))).galley(rect.min + vec2(5.0, 61.0), g, t.text.primary);
                if let Some(l) = &e.license {
                    let c = licence_color(l, &t);
                    ui.painter().text(rect.min + vec2(6.0, tile.y - 12.0), egui::Align2::LEFT_CENTER, l, Tokens::font(t.type_scale.small), c);
                }
                if e.kind != AssetKind::Folder {
                    let br = Rect::from_min_size(rect.right_bottom() - vec2(54.0, 22.0), vec2(50.0, 18.0));
                    let r = ui.put(br, egui::Button::new(egui::RichText::new("Place").small()).small().wrap_mode(egui::TextWrapMode::Extend));
                    if r.clicked() {
                        reqs.push(Req::Place(e.path.clone()));
                    }
                    r.on_hover_text("Place at the middle of the view");
                }
                resp.clone().on_hover_text(&e.path);
                if resp.double_clicked() {
                    activate = Some(i);
                } else if resp.clicked() {
                    click = Some(i);
                }
            }
        });
    });
    if let Some(i) = click {
        st.selected = Some(i);
        // A folder opens on a single click; files select (double-click or Place puts them in).
        if let Some(e) = list.get(i).filter(|e| e.kind == AssetKind::Folder) {
            goto = Some(e.path.clone());
        }
    }
    if let Some(i) = activate
        && let Some(e) = list.get(i)
    {
        if e.kind == AssetKind::Folder {
            goto = Some(e.path.clone());
        } else {
            reqs.push(Req::Place(e.path.clone()));
        }
    }
    if let Some(d) = goto {
        st.set_dir(&d);
        st.search.clear();
    }
}

#[allow(non_snake_case)]
fn RichText_secondary(s: &str, t: &Tokens) -> egui::RichText {
    egui::RichText::new(s).color(t.text.secondary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> AssetEntry {
        AssetEntry {
            path: name.into(),
            kind: AssetKind::Model,
            name: name.into(),
            thumbnail: None,
            license: None,
        }
    }

    #[test]
    fn search_is_case_insensitive() {
        let e = [entry("Sedan"), entry("truck"), entry("sedan_old")];
        assert_eq!(filtered(&e, "SEDAN").len(), 2);
        assert_eq!(filtered(&e, "").len(), 3);
        assert!(filtered(&e, "zzz").is_empty());
    }
}
