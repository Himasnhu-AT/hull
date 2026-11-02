//! Content Browser: folders, search, licence badges, place into the level.

use ashlar_ui::search::SearchField;
use ashlar_ui::tokens::{self, Tokens};
use ashlar_ui::virtual_list::{RowHeights, VirtualList};
use editor_proto::{AssetEntry, AssetKind};
use egui::{Color32, Rect, Sense, Ui, pos2, vec2};

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
        SearchField::new("content.search", &mut st.search).hint("Search assets").width(ui.available_width()).show(ui);
    });
    let list = filtered(entries, &st.search);
    if list.is_empty() {
        ui.add_space(t.space.md);
        ui.label(egui::RichText::new(if entries.is_empty() { "Empty folder" } else { "No matches" }).color(t.text.disabled));
    }
    let selected = st.selected;
    let label_of = |i: usize| list.get(i).map_or("", |e| e.name.as_str());
    let out = VirtualList::new("content.list", list.len(), RowHeights::Uniform(t.control_height + 4.0)).selected(selected).stripes(true).row_label(&label_of).show(ui, |ui, row| {
        let Some(e) = list.get(row.index) else { return };
        crate::model::a11y_row(ui, row.rect, egui::Id::new(("content.row", &e.path)), &e.name, row.selected);
        let mid = row.rect.center().y;
        let color = if row.selected { t.selection_text } else { t.text.primary };
        ui.painter().text(pos2(row.rect.left() + 4.0, mid), egui::Align2::LEFT_CENTER, glyph(e.kind), Tokens::font(t.type_scale.small), if row.selected { t.selection_text } else { t.accent });
        ui.painter().text(pos2(row.rect.left() + 44.0, mid), egui::Align2::LEFT_CENTER, &e.name, Tokens::font(t.type_scale.body), color);
        let mut right = row.rect.right() - 6.0;
        if e.kind != AssetKind::Folder {
            let br = Rect::from_center_size(pos2(right - 24.0, mid), vec2(48.0, t.control_height - 6.0));
            let r = ui.put(br, egui::Button::new("Place").small());
            if r.clicked() {
                reqs.push(Req::Place(e.path.clone()));
            }
            r.on_hover_text("Place at the origin");
            right = br.left() - 6.0;
        }
        if let Some(l) = &e.license {
            let g = ui.painter().layout_no_wrap(l.clone(), Tokens::font(t.type_scale.small), t.text.primary);
            let r = Rect::from_center_size(pos2(right - g.size().x / 2.0 - 6.0, mid), g.size() + vec2(12.0, 4.0));
            let c = licence_color(l, &t);
            ui.painter().rect_filled(r, 8.0, c.gamma_multiply(0.25));
            ui.painter().rect_stroke(r, 8.0, egui::Stroke::new(1.0, c), egui::StrokeKind::Inside);
            ui.painter().galley(r.center() - g.size() / 2.0, g, c);
            let _ = Sense::hover();
        }
    });
    if let Some(i) = out.select.or(out.clicked) {
        st.selected = Some(i);
    }
    if let Some(i) = out.activated.or(out.double_clicked)
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
        AssetEntry { path: name.into(), kind: AssetKind::Model, name: name.into(), thumbnail: None, license: None }
    }

    #[test]
    fn search_is_case_insensitive() {
        let e = [entry("Sedan"), entry("truck"), entry("sedan_old")];
        assert_eq!(filtered(&e, "SEDAN").len(), 2);
        assert_eq!(filtered(&e, "").len(), 3);
        assert!(filtered(&e, "zzz").is_empty());
    }
}
