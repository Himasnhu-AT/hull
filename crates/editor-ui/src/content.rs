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

/// Draws the kind's icon in `r` with the painter (no icon font needed).
fn paint_icon(p: &egui::Painter, r: Rect, k: AssetKind, c: Color32) {
    use egui::{Shape, Stroke, pos2};
    let ctr = r.center();
    let u = r.height().min(r.width()) * 0.5 - 6.0; // half size of the drawing
    let st = Stroke::new(2.0, c);
    let fill = c.gamma_multiply(0.35);
    let seg = |a: egui::Pos2, b: egui::Pos2| p.line_segment([a, b], st);
    match k {
        AssetKind::Folder => {
            let body = Rect::from_center_size(ctr + vec2(0.0, 3.0), vec2(u * 2.2, u * 1.4));
            p.rect_filled(body, 3.0, fill);
            p.rect_stroke(body, 3.0, st, egui::StrokeKind::Inside);
            let tab = Rect::from_min_size(body.left_top() - vec2(0.0, 5.0), vec2(u * 0.9, 6.0));
            p.rect_filled(tab, 2.0, c);
        }
        AssetKind::Model => {
            // An isometric cube.
            let (t, bl, br, b) = (pos2(ctr.x, ctr.y - u), pos2(ctr.x - u * 0.9, ctr.y - u * 0.45), pos2(ctr.x + u * 0.9, ctr.y - u * 0.45), pos2(ctr.x, ctr.y));
            let (bl2, br2, b2) = (pos2(bl.x, bl.y + u * 1.1), pos2(br.x, br.y + u * 1.1), pos2(b.x, b.y + u * 1.1));
            p.add(Shape::convex_polygon(vec![t, br, b, bl], fill, st));
            p.add(Shape::convex_polygon(vec![bl, b, b2, bl2], c.gamma_multiply(0.2), st));
            p.add(Shape::convex_polygon(vec![b, br, br2, b2], c.gamma_multiply(0.5), st));
        }
        AssetKind::Texture => {
            let img = Rect::from_center_size(ctr, vec2(u * 2.2, u * 1.6));
            p.rect_filled(img, 3.0, fill);
            p.rect_stroke(img, 3.0, st, egui::StrokeKind::Inside);
            p.add(Shape::convex_polygon(vec![img.left_bottom() + vec2(3.0, -3.0), pos2(ctr.x - u * 0.2, img.top() + u * 0.55), pos2(ctr.x + u * 0.3, img.bottom() - 3.0)], c, Stroke::NONE));
            p.circle_filled(pos2(img.right() - u * 0.5, img.top() + u * 0.4), u * 0.18, c);
        }
        AssetKind::Audio => {
            p.add(Shape::convex_polygon(vec![pos2(ctr.x - u * 0.9, ctr.y - u * 0.3), pos2(ctr.x - u * 0.4, ctr.y - u * 0.3), pos2(ctr.x + u * 0.1, ctr.y - u * 0.8), pos2(ctr.x + u * 0.1, ctr.y + u * 0.8), pos2(ctr.x - u * 0.4, ctr.y + u * 0.3), pos2(ctr.x - u * 0.9, ctr.y + u * 0.3)], fill, st));
            for (i, rr) in [0.45f32, 0.85].into_iter().enumerate() {
                let pts: Vec<egui::Pos2> = (-4..=4).map(|a| {
                    let ang = a as f32 / 4.0 * 0.9;
                    pos2(ctr.x + u * 0.15 + (u * rr) * ang.cos(), ctr.y + (u * rr) * ang.sin())
                }).collect();
                p.add(Shape::line(pts, Stroke::new(1.6, c.gamma_multiply(1.0 - i as f32 * 0.25))));
            }
        }
        AssetKind::Level => {
            // A map with a flag.
            let m = Rect::from_center_size(ctr, vec2(u * 2.0, u * 1.6));
            p.rect_filled(m, 3.0, fill);
            p.rect_stroke(m, 3.0, st, egui::StrokeKind::Inside);
            seg(pos2(ctr.x - u * 0.2, ctr.y + u * 0.6), pos2(ctr.x - u * 0.2, ctr.y - u * 0.6));
            p.add(Shape::convex_polygon(vec![pos2(ctr.x - u * 0.2, ctr.y - u * 0.6), pos2(ctr.x + u * 0.6, ctr.y - u * 0.3), pos2(ctr.x - u * 0.2, ctr.y)], c, Stroke::NONE));
        }
        AssetKind::Logic => {
            // Two nodes and a wire.
            let (a, b) = (Rect::from_center_size(ctr + vec2(-u * 0.7, -u * 0.35), vec2(u * 0.9, u * 0.6)), Rect::from_center_size(ctr + vec2(u * 0.7, u * 0.35), vec2(u * 0.9, u * 0.6)));
            for n in [a, b] {
                p.rect_filled(n, 2.0, fill);
                p.rect_stroke(n, 2.0, st, egui::StrokeKind::Inside);
            }
            p.add(Shape::line(vec![a.right_center(), pos2(ctr.x, a.center().y), pos2(ctr.x, b.center().y), b.left_center()], st));
        }
        AssetKind::Script => {
            // </>
            seg(pos2(ctr.x - u * 0.35, ctr.y - u * 0.6), pos2(ctr.x - u * 0.95, ctr.y));
            seg(pos2(ctr.x - u * 0.95, ctr.y), pos2(ctr.x - u * 0.35, ctr.y + u * 0.6));
            seg(pos2(ctr.x + u * 0.35, ctr.y - u * 0.6), pos2(ctr.x + u * 0.95, ctr.y));
            seg(pos2(ctr.x + u * 0.95, ctr.y), pos2(ctr.x + u * 0.35, ctr.y + u * 0.6));
            seg(pos2(ctr.x + u * 0.15, ctr.y - u * 0.7), pos2(ctr.x - u * 0.15, ctr.y + u * 0.7));
        }
        AssetKind::Material => {
            p.circle_filled(ctr, u * 0.9, fill);
            p.circle_stroke(ctr, u * 0.9, st);
            p.circle_filled(ctr + vec2(-u * 0.3, -u * 0.3), u * 0.25, c.gamma_multiply(0.8));
        }
        AssetKind::Other => {
            let page = Rect::from_center_size(ctr, vec2(u * 1.5, u * 1.9));
            p.rect_filled(page, 2.0, fill);
            p.rect_stroke(page, 2.0, st, egui::StrokeKind::Inside);
            for i in 0..3 {
                let y = page.top() + u * (0.5 + i as f32 * 0.45);
                seg(pos2(page.left() + 5.0, y), pos2(page.right() - 5.0, y));
            }
        }
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
                paint_icon(ui.painter(), icon, e.kind, kc);
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
