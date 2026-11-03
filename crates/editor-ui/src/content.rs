//! Content Browser: folder tree, type filters, grid / list, tile actions, drag to the viewport.
//!
//! The grid is laid out by hand: `cols = floor((width + gap) / (tile + gap))`, one full-width row
//! per `cols` tiles, so rows stay aligned and only the visible rows are drawn (`show_rows`).

use std::collections::{HashMap, HashSet};

use ashlar_ui::search::SearchField;
use ashlar_ui::tokens::{self, Tokens};
use editor_proto::{AssetAction, AssetEntry, AssetKind, EditorBackend};
use egui::{Color32, Pos2, Rect, Sense, Ui, vec2};

use crate::model::Req;

const TILE: egui::Vec2 = egui::vec2(104.0, 96.0);
const GAP: f32 = 8.0;
const LIST_ROW: f32 = 24.0;

/// Dragged from a tile: a model that can be dropped on the viewport.
#[derive(Clone, Debug)]
pub(crate) struct AssetDrag {
    pub path: String,
    pub name: String,
}

#[derive(Default)]
pub(crate) struct ContentState {
    /// Directory shown, `""` = asset root.
    pub dir: String,
    pub search: String,
    /// Path of the selected tile.
    pub(crate) selected: Option<String>,
    pub dir_changed: bool,
    /// Type chips switched on; empty = every type.
    pub kinds: HashSet<AssetKind>,
    pub list: bool,
    /// Folders open in the tree (paths, `""` is always open).
    pub expanded: HashSet<String>,
    /// Sub-folders `(path, name)` of each open folder, filled by [`refresh_tree`].
    pub subdirs: HashMap<String, Vec<(String, String)>>,
    pub tree_dirty: bool,
}

impl ContentState {
    pub fn set_dir(&mut self, dir: &str) {
        self.dir = dir.trim_matches('/').to_owned();
        self.selected = None;
        self.dir_changed = true;
        // Keep the way down to the folder open in the tree.
        let mut acc = String::new();
        for part in self.dir.split('/').filter(|p| !p.is_empty()) {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            if acc != self.dir {
                self.expanded.insert(acc.clone());
            }
        }
        self.tree_dirty = true;
    }
}

/// Loads the sub-folders of the root and of every open folder (for the tree).
pub(crate) fn refresh_tree(st: &mut ContentState, backend: &mut dyn EditorBackend) {
    let mut dirs: Vec<String> = vec![String::new()];
    dirs.extend(st.expanded.iter().cloned());
    st.subdirs.retain(|k, _| dirs.contains(k));
    for d in dirs {
        let subs = backend.assets(&d).into_iter().filter(|e| e.kind == AssetKind::Folder).map(|e| (e.path, e.name)).collect();
        st.subdirs.insert(d, subs);
    }
    st.tree_dirty = false;
}

/// Columns of a grid `avail_w` wide: as many `tile`-wide tiles with `gap` between as fit, at least 1.
pub(crate) fn grid_cols(avail_w: f32, tile_w: f32, gap: f32) -> usize {
    if !avail_w.is_finite() || avail_w <= 0.0 {
        return 1;
    }
    (((avail_w + gap) / (tile_w + gap)).floor() as usize).max(1)
}

/// Number of rows for `n` items in `cols` columns.
pub(crate) fn grid_rows(n: usize, cols: usize) -> usize {
    n.div_ceil(cols.max(1))
}

/// Top-left of tile `index` in a grid whose first tile starts at `origin`.
pub(crate) fn tile_pos(origin: Pos2, index: usize, cols: usize, tile: egui::Vec2, gap: f32) -> Pos2 {
    let (r, c) = (index / cols.max(1), index % cols.max(1));
    origin + vec2(c as f32 * (tile.x + gap), r as f32 * (tile.y + gap))
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

/// Search and type chips together. Folders stay visible under a type filter (to move around).
pub(crate) fn visible<'a>(entries: &'a [AssetEntry], search: &str, kinds: &HashSet<AssetKind>) -> Vec<&'a AssetEntry> {
    filtered(entries, search).into_iter().filter(|e| kinds.is_empty() || e.kind == AssetKind::Folder || kinds.contains(&e.kind)).collect()
}

const CHIPS: &[(&str, AssetKind)] = &[
    ("Models", AssetKind::Model),
    ("Audio", AssetKind::Audio),
    ("Textures", AssetKind::Texture),
    ("Levels", AssetKind::Level),
    ("Logic", AssetKind::Logic),
    ("Scripts", AssetKind::Script),
];

/// Why an action is not available yet (it is shown disabled).
fn unavailable(a: AssetAction) -> Option<&'static str> {
    match a {
        AssetAction::Preview => Some("Preview is not built yet"),
        AssetAction::Assign => Some("Assigning materials is not built yet"),
        AssetAction::Attach => Some("Attaching logic is not built yet (use Open)"),
        _ => None,
    }
}

/// What running `action` on `e` asks the editor to do.
fn request(action: AssetAction, e: &AssetEntry) -> Option<Req> {
    if unavailable(action).is_some() {
        return None;
    }
    Some(match (action, e.kind) {
        (AssetAction::Place, _) => Req::Place(e.path.clone()),
        (AssetAction::Open, _) => Req::OpenAsset(e.path.clone(), e.kind),
        _ => return None,
    })
}

fn kind_color(k: AssetKind, t: &Tokens) -> Color32 {
    match k {
        AssetKind::Folder => t.status.warning,
        AssetKind::Model => t.status.info,
        AssetKind::Texture => t.status.success,
        _ => t.accent,
    }
}

fn display_name(e: &AssetEntry) -> &str {
    e.name.trim_end_matches(".glb").trim_end_matches(".gltf")
}

enum Act {
    Goto(String),
    Run(AssetAction, usize),
    Copy(String),
    Reveal(String),
}

pub(crate) fn show(ui: &mut Ui, st: &mut ContentState, entries: &[AssetEntry], reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    let mut act: Option<Act> = None;
    // Row 1: breadcrumbs and the grid / list switch.
    ui.horizontal(|ui| {
        if ui.link("assets").clicked() {
            act = Some(Act::Goto(String::new()));
        }
        let mut acc = String::new();
        for part in st.dir.split('/').filter(|p| !p.is_empty()) {
            ui.label(egui::RichText::new("/").color(t.text.secondary));
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            if ui.link(part).clicked() {
                act = Some(Act::Goto(acc.clone()));
            }
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.selectable_label(st.list, "List").clicked() {
                st.list = true;
            }
            if ui.selectable_label(!st.list, "Grid").clicked() {
                st.list = false;
            }
        });
    });
    // Row 2: type chips and search.
    ui.horizontal_wrapped(|ui| {
        if ui.selectable_label(st.kinds.is_empty(), "All").clicked() {
            st.kinds.clear();
        }
        for (label, kind) in CHIPS {
            let on = st.kinds.contains(kind);
            if ui.selectable_label(on, *label).clicked() && !st.kinds.remove(kind) {
                st.kinds.insert(*kind);
            }
        }
    });
    SearchField::new("content.search", &mut st.search).hint("Search assets").width(ui.available_width()).show(ui);

    let list = visible(entries, &st.search, &st.kinds);

    // Left: the folder tree.
    egui::Panel::left("content.tree").resizable(true).default_size(150.0).size_range(90.0..=320.0).show(ui, |ui| {
        egui::ScrollArea::both().auto_shrink([false, false]).show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            tree_row(ui, st, "", "assets", 0, &mut act);
        });
    });
    // Bottom: the selected tile's actions.
    let sel_entry: Option<&AssetEntry> = st.selected.as_ref().and_then(|p| entries.iter().find(|e| &e.path == p));
    egui::Panel::bottom("content.footer").exact_size(30.0).show_separator_line(true).show(ui, |ui| {
        ui.horizontal_centered(|ui| match sel_entry {
            Some(e) => {
                ui.label(egui::RichText::new(display_name(e)).strong());
                if let Some(l) = &e.license {
                    ui.label(egui::RichText::new(l).small().color(licence_color(l, &t)));
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if let Some(i) = list.iter().position(|x| x.path == e.path) {
                        for a in e.kind.actions().iter().rev() {
                            let why = unavailable(*a);
                            let r = ui.add_enabled(why.is_none(), egui::Button::new(a.label()));
                            let r = match (why, *a) {
                                (Some(w), _) => r.on_disabled_hover_text(w),
                                (None, AssetAction::Place) => r.on_hover_text("Place at the middle of the view (or drag the tile into the viewport)"),
                                _ => r,
                            };
                            if r.clicked() {
                                act = Some(Act::Run(*a, i));
                            }
                        }
                    }
                });
            }
            None => {
                ui.label(egui::RichText::new("Select an asset. Drag a model into the viewport to place it.").color(t.text.disabled));
            }
        });
    });

    if list.is_empty() {
        ui.add_space(t.space.md);
        ui.label(egui::RichText::new(if entries.is_empty() { "Empty folder" } else { "No matches" }).color(t.text.disabled));
    }
    let mut click: Option<usize> = None;
    let mut activate: Option<usize> = None;
    let avail = ui.available_width();
    if st.list {
        egui::ScrollArea::vertical().auto_shrink([false, false]).show_rows(ui, LIST_ROW, list.len(), |ui, range| {
            for i in range {
                let e = list[i];
                let (rect, resp) = ui.allocate_exact_size(vec2(avail.max(40.0), LIST_ROW - ui.spacing().item_spacing.y), Sense::click_and_drag());
                let selected = st.selected.as_deref() == Some(e.path.as_str());
                let bg = if selected { t.selection } else if resp.hovered() { t.surface.raised } else { Color32::TRANSPARENT };
                ui.painter().rect_filled(rect, 4.0, bg);
                crate::model::a11y_row(ui, rect, egui::Id::new(("content.row", &e.path)), &e.name, selected);
                let icon = Rect::from_min_size(rect.min + vec2(4.0, 1.0), vec2(22.0, rect.height() - 2.0));
                paint_icon(ui.painter(), icon, e.kind, kind_color(e.kind, &t));
                let fg = if selected { t.selection_text } else { t.text.primary };
                ui.painter().text(rect.min + vec2(32.0, rect.height() / 2.0), egui::Align2::LEFT_CENTER, display_name(e), Tokens::font(t.type_scale.body), fg);
                ui.painter().text(rect.right_center() - vec2(8.0, 0.0), egui::Align2::RIGHT_CENTER, format!("{:?}{}", e.kind, e.license.as_deref().map(|l| format!("  {l}")).unwrap_or_default()), Tokens::font(t.type_scale.small), t.text.secondary);
                tile_interaction(&resp, e, i, &mut click, &mut activate, &mut act);
            }
        });
    } else {
        let cols = grid_cols(avail, TILE.x, GAP);
        let rows = grid_rows(list.len(), cols);
        egui::ScrollArea::vertical().auto_shrink([false, false]).show_rows(ui, TILE.y + GAP, rows, |ui, range| {
            ui.spacing_mut().item_spacing.y = GAP;
            for row in range {
                let (row_rect, _) = ui.allocate_exact_size(vec2(avail, TILE.y), Sense::hover());
                for c in 0..cols {
                    let i = row * cols + c;
                    let Some(e) = list.get(i).copied() else { break };
                    let rect = Rect::from_min_size(tile_pos(row_rect.min, c, cols, TILE, GAP), TILE);
                    let resp = ui.interact(rect, egui::Id::new(("content.tile", &e.path)), Sense::click_and_drag());
                    let selected = st.selected.as_deref() == Some(e.path.as_str());
                    crate::model::a11y_row(ui, rect, egui::Id::new(("content.row", &e.path)), &e.name, selected);
                    let bg = if selected { t.selection } else if resp.hovered() { t.surface.raised } else { t.surface.panel };
                    ui.painter().rect_filled(rect, 6.0, bg);
                    ui.painter().rect_stroke(rect, 6.0, egui::Stroke::new(1.0, if selected { t.accent } else { t.text.disabled }), egui::StrokeKind::Inside);
                    let icon = Rect::from_min_size(rect.min + vec2(8.0, 8.0), vec2(TILE.x - 16.0, 48.0));
                    let kc = kind_color(e.kind, &t);
                    ui.painter().rect_filled(icon, 4.0, kc.gamma_multiply(0.18));
                    paint_icon(ui.painter(), icon, e.kind, kc);
                    let g = ui.painter().layout(display_name(e).to_owned(), Tokens::font(t.type_scale.small), if selected { t.selection_text } else { t.text.primary }, TILE.x - 10.0);
                    ui.painter().with_clip_rect(Rect::from_min_size(rect.min + vec2(5.0, 60.0), vec2(TILE.x - 10.0, 18.0))).galley(rect.min + vec2(5.0, 61.0), g, t.text.primary);
                    if let Some(l) = &e.license {
                        ui.painter().text(rect.min + vec2(6.0, TILE.y - 10.0), egui::Align2::LEFT_CENTER, l, Tokens::font(t.type_scale.small), licence_color(l, &t));
                    }
                    tile_interaction(&resp, e, i, &mut click, &mut activate, &mut act);
                }
            }
        });
    }

    if let Some(i) = click {
        let e = list[i];
        st.selected = Some(e.path.clone());
        // A folder opens on a single click.
        if e.kind == AssetKind::Folder {
            act = Some(Act::Goto(e.path.clone()));
        }
    }
    if let Some(i) = activate {
        let e = list[i];
        match e.kind.actions().first() {
            Some(AssetAction::Open) if e.kind == AssetKind::Folder => act = Some(Act::Goto(e.path.clone())),
            Some(a) => act = Some(Act::Run(*a, i)),
            None => {}
        }
    }
    match act {
        Some(Act::Goto(d)) => {
            st.set_dir(&d);
            st.search.clear();
        }
        Some(Act::Run(a, i)) => {
            if let Some(e) = list.get(i) {
                if e.kind == AssetKind::Folder && a == AssetAction::Open {
                    let d = e.path.clone();
                    st.set_dir(&d);
                    st.search.clear();
                } else if let Some(r) = request(a, e) {
                    reqs.push(r);
                }
            }
        }
        Some(Act::Copy(p)) => reqs.push(Req::Copy(p)),
        Some(Act::Reveal(p)) => reqs.push(Req::Reveal(p)),
        None => {}
    }
}

/// Hover text, drag payload, clicks and the right-click menu of one tile / row.
fn tile_interaction(resp: &egui::Response, e: &AssetEntry, i: usize, click: &mut Option<usize>, activate: &mut Option<usize>, act: &mut Option<Act>) {
    resp.clone().on_hover_text(&e.path);
    if e.kind == AssetKind::Model && resp.drag_started() {
        resp.dnd_set_drag_payload(AssetDrag { path: e.path.clone(), name: display_name(e).to_owned() });
    }
    if resp.double_clicked() {
        *activate = Some(i);
    } else if resp.clicked() {
        *click = Some(i);
    }
    resp.context_menu(|ui| {
        for a in e.kind.actions() {
            let why = unavailable(*a);
            let label = if e.kind == AssetKind::Folder { "Open folder" } else { a.label() };
            let r = ui.add_enabled(why.is_none(), egui::Button::new(label));
            let r = if let Some(w) = why { r.on_disabled_hover_text(w) } else { r };
            if r.clicked() {
                *act = Some(Act::Run(*a, i));
                ui.close();
            }
        }
        if ui.button("Copy path").clicked() {
            *act = Some(Act::Copy(e.path.clone()));
            ui.close();
        }
        if ui.button("Show in Finder").clicked() {
            *act = Some(Act::Reveal(e.path.clone()));
            ui.close();
        }
    });
}

/// One folder of the tree and, when open, its children.
fn tree_row(ui: &mut Ui, st: &mut ContentState, path: &str, name: &str, depth: usize, act: &mut Option<Act>) {
    if depth > 24 {
        return;
    }
    let open = path.is_empty() || st.expanded.contains(path);
    let subs = st.subdirs.get(path).cloned().unwrap_or_default();
    ui.horizontal(|ui| {
        ui.add_space(depth as f32 * 12.0);
        let has_kids = !path.is_empty() && !st.subdirs.contains_key(path) || !subs.is_empty();
        if path.is_empty() {
            ui.add_space(14.0);
        } else if has_kids {
            if ui.add(egui::Button::new(if open { "v" } else { ">" }).small().frame(false)).clicked() {
                if open {
                    st.expanded.remove(path);
                } else {
                    st.expanded.insert(path.to_owned());
                }
                st.tree_dirty = true;
            }
        } else {
            ui.add_space(14.0);
        }
        if ui.selectable_label(st.dir == path, name).clicked() {
            *act = Some(Act::Goto(path.to_owned()));
        }
    });
    if open {
        for (p, n) in &subs {
            tree_row(ui, st, p, n, depth + 1, act);
        }
    }
}

/// While a model tile is dragged, shows its name at the pointer; on release over the viewport asks
/// for the placement at that point (a fraction of the viewport rect, for the backend's ray).
pub(crate) fn handle_drop(ctx: &egui::Context, viewport: Option<Rect>, reqs: &mut Vec<Req>) {
    let Some(drag) = egui::DragAndDrop::payload::<AssetDrag>(ctx) else { return };
    let Some(pos) = ctx.pointer_latest_pos() else { return };
    let over = viewport.filter(|v| v.contains(pos));
    if ctx.input(|i| i.pointer.any_released()) {
        egui::DragAndDrop::clear_payload(ctx);
        if let Some(v) = over {
            let uv = [((pos.x - v.min.x) / v.width().max(1.0)).clamp(0.0, 1.0), ((pos.y - v.min.y) / v.height().max(1.0)).clamp(0.0, 1.0)];
            reqs.push(Req::PlaceAt(drag.path.clone(), uv));
        }
        return;
    }
    egui::Area::new(egui::Id::new("content.drag_ghost")).order(egui::Order::Tooltip).fixed_pos(pos + vec2(14.0, 14.0)).interactable(false).show(ctx, |ui| {
        egui::Frame::popup(ui.style()).show(ui, |ui| {
            ui.label(if over.is_some() { format!("Drop to place {}", drag.name) } else { drag.name.clone() });
        });
    });
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

    #[test]
    fn grid_columns_fill_the_width() {
        // 104 + 8 gap: 3 tiles need 328, 4 need 440.
        assert_eq!(grid_cols(328.0, 104.0, 8.0), 3);
        assert_eq!(grid_cols(327.0, 104.0, 8.0), 2);
        assert_eq!(grid_cols(440.0, 104.0, 8.0), 4);
        assert_eq!(grid_cols(10.0, 104.0, 8.0), 1);
        assert_eq!(grid_cols(0.0, 104.0, 8.0), 1);
        assert_eq!(grid_cols(f32::NAN, 104.0, 8.0), 1);
    }

    #[test]
    fn grid_rows_round_up() {
        assert_eq!(grid_rows(0, 3), 0);
        assert_eq!(grid_rows(3, 3), 1);
        assert_eq!(grid_rows(4, 3), 2);
        assert_eq!(grid_rows(5, 0), 5);
    }

    #[test]
    fn tiles_align_in_rows_and_columns() {
        let o = Pos2::new(10.0, 20.0);
        let t = vec2(100.0, 90.0);
        let p = |i| tile_pos(o, i, 3, t, 8.0);
        assert_eq!(p(0), o);
        // Same row: same y. Same column: same x, one row lower.
        assert_eq!(p(1).y, p(0).y);
        assert_eq!(p(2).y, p(0).y);
        assert_eq!(p(3).x, p(0).x);
        assert_eq!(p(3).y, 20.0 + 98.0);
        assert_eq!(p(4).x, 10.0 + 108.0);
    }

    #[test]
    fn type_chips_keep_folders() {
        let mut m = entry("m.glb");
        m.kind = AssetKind::Model;
        let mut a = entry("a.ogg");
        a.kind = AssetKind::Audio;
        let mut f = entry("sub");
        f.kind = AssetKind::Folder;
        let e = [m, a, f];
        let none = HashSet::new();
        assert_eq!(visible(&e, "", &none).len(), 3);
        let only_audio = HashSet::from([AssetKind::Audio]);
        let names: Vec<&str> = visible(&e, "", &only_audio).iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["a.ogg", "sub"]);
    }

    #[test]
    fn only_models_can_be_placed() {
        for k in [AssetKind::Audio, AssetKind::Texture, AssetKind::Level, AssetKind::Logic, AssetKind::Script, AssetKind::Other, AssetKind::Folder] {
            let mut e = entry("x");
            e.kind = k;
            assert!(!k.actions().contains(&AssetAction::Place), "{k:?}");
        }
        let m = entry("x.glb");
        assert!(matches!(request(AssetAction::Place, &m), Some(Req::Place(_))));
    }
}
