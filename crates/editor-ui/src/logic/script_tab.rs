//! The ruspy script tab: a text editor with line numbers, light syntax colouring, a function
//! list, and the errors the engine reported (line and column) marked on their lines.

use ashlar_ui::tokens;
use egui::text::{LayoutJob, TextFormat};
use egui::{Color32, FontId, RichText, Ui};

use super::state::ScriptDoc;

const KEYWORDS: &[&str] = &["fn", "return", "if", "else", "while", "for", "in", "break", "continue", "true", "false", "null", "let", "struct"];

/// Colours one line.
fn highlight_line(job: &mut LayoutJob, line: &str, font: &FontId) {
    let fmt = |c: Color32| TextFormat { font_id: font.clone(), color: c, ..Default::default() };
    let plain = Color32::from_gray(215);
    let b: Vec<char> = line.chars().collect();
    let mut i = 0;
    let push = |job: &mut LayoutJob, s: String, c: Color32| job.append(&s, 0.0, fmt(c));
    while i < b.len() {
        let c = b[i];
        if c == '/' && b.get(i + 1) == Some(&'/') {
            push(job, b[i..].iter().collect(), Color32::from_rgb(110, 160, 110));
            return;
        }
        if c == '"' {
            let mut j = i + 1;
            while j < b.len() && b[j] != '"' {
                j += if b[j] == '\\' { 2 } else { 1 };
            }
            let end = (j + 1).min(b.len());
            push(job, b[i..end].iter().collect(), Color32::from_rgb(225, 160, 100));
            i = end;
        } else if c.is_ascii_digit() {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_digit() || b[j] == '.') {
                j += 1;
            }
            push(job, b[i..j].iter().collect(), Color32::from_rgb(130, 190, 240));
            i = j;
        } else if c.is_alphabetic() || c == '_' {
            let mut j = i;
            while j < b.len() && (b[j].is_alphanumeric() || b[j] == '_') {
                j += 1;
            }
            let w: String = b[i..j].iter().collect();
            let col = if KEYWORDS.contains(&w.as_str()) { Color32::from_rgb(200, 130, 220) } else { plain };
            push(job, w, col);
            i = j;
        } else {
            let mut j = i + 1;
            while j < b.len() && !(b[j].is_alphanumeric() || b[j] == '_' || b[j] == '"' || b[j] == '/') {
                j += 1;
            }
            push(job, b[i..j].iter().collect(), plain);
            i = j;
        }
    }
}

fn layouter(ui: &Ui, text: &str, font: &FontId) -> std::sync::Arc<egui::Galley> {
    let mut job = LayoutJob::default();
    let lines: Vec<&str> = text.split('\n').collect();
    for (n, l) in lines.iter().enumerate() {
        highlight_line(&mut job, l, font);
        if n + 1 < lines.len() {
            job.append("\n", 0.0, TextFormat { font_id: font.clone(), color: Color32::GRAY, ..Default::default() });
        }
    }
    job.wrap.max_width = f32::INFINITY;
    ui.ctx().fonts_mut(|f| f.layout_job(job))
}

/// `fn name(args)` lines: `(line index, name)`.
pub fn functions(text: &str) -> Vec<(usize, String)> {
    text.lines()
        .enumerate()
        .filter_map(|(i, l)| {
            let rest = l.trim_start().strip_prefix("fn ")?;
            let name = rest.split('(').next()?.trim();
            (!name.is_empty()).then(|| (i, name.to_string()))
        })
        .collect()
}

#[derive(Default)]
pub struct Out {
    pub save: bool,
    pub revert: bool,
    pub reload: bool,
}

pub fn show(ui: &mut Ui, doc: &mut ScriptDoc) -> Out {
    let t = tokens::current(ui.ctx());
    let mut out = Out::default();
    ui.horizontal(|ui| {
        if ui.add_enabled(doc.dirty(), egui::Button::new("Save")).on_hover_text("Cmd+S. The game reloads the script by itself.").clicked() {
            out.save = true;
        }
        if ui.add_enabled(doc.dirty(), egui::Button::new("Revert")).clicked() {
            out.revert = true;
        }
        ui.label(RichText::new(&doc.path).color(t.text.secondary));
        if doc.dirty() {
            ui.label(RichText::new("modified").color(t.status.warning));
        }
        let errs = doc.errors.iter().filter(|e| !e.warning).count();
        if errs > 0 {
            ui.label(RichText::new(format!("{errs} error{}", if errs == 1 { "" } else { "s" })).color(t.status.danger));
        } else {
            ui.label(RichText::new("OK").color(t.status.success));
        }
    });
    if doc.changed_on_disk {
        ui.horizontal(|ui| {
            ui.label(RichText::new("The file changed on disk.").color(t.status.warning));
            if ui.button("Reload").clicked() {
                out.reload = true;
            }
        });
    }
    ui.separator();
    let funcs = functions(&doc.text);
    egui::Panel::left(egui::Id::new(("script.fns", &doc.path))).resizable(true).default_size(150.0).show(ui, |ui| {
        ui.label(RichText::new("Functions").strong());
        for (line, name) in &funcs {
            if ui.selectable_label(false, name).clicked() {
                doc.jump_to = Some(*line);
            }
        }
        if funcs.is_empty() {
            ui.weak("none");
        }
    });
    if !doc.errors.is_empty() {
        egui::Panel::bottom(egui::Id::new(("script.errors", &doc.path))).resizable(false).show(ui, |ui| {
            ui.label(RichText::new("ERRORS").strong().color(t.text.secondary).size(11.0));
            for e in &doc.errors {
                ui.horizontal(|ui| {
                    let col = if e.warning { t.status.warning } else { t.status.danger };
                    let pos = if e.line > 0 { format!("{}:{}", e.line, e.col) } else { "file".to_string() };
                    if ui.link(RichText::new(pos).color(col)).clicked() && e.line > 0 {
                        doc.jump_to = Some(e.line as usize - 1);
                    }
                    ui.label(&e.message);
                });
            }
        });
    }
    let font = FontId::monospace(13.0);
    let row_h = ui.fonts_mut(|f| f.row_height(&font));
    egui::CentralPanel::default().frame(egui::Frame::NONE).show(ui, |ui| {
        let mut scroll = egui::ScrollArea::both().auto_shrink([false, false]);
        if let Some(line) = doc.jump_to.take() {
            scroll = scroll.vertical_scroll_offset((line as f32 * row_h - 60.0).max(0.0));
        }
        scroll.show(ui, |ui| {
            let bg = ui.painter().add(egui::Shape::Noop);
            let gutter = 46.0;
            let resp = egui::Frame::NONE.inner_margin(egui::Margin { left: gutter as i8, ..Default::default() }).show(ui, |ui| {
                let f = font.clone();
                let mut lay = |ui: &Ui, s: &dyn egui::TextBuffer, _w: f32| layouter(ui, s.as_str(), &f);
                egui::TextEdit::multiline(&mut doc.text).font(font.clone()).desired_width(f32::INFINITY).desired_rows(30).lock_focus(true).layouter(&mut lay).frame(egui::Frame::NONE).show(ui)
            });
            let o = resp.inner;
            let origin = o.galley_pos;
            let painter = ui.painter();
            let mut shapes = Vec::new();
            for (i, row) in o.galley.rows.iter().enumerate() {
                let y = origin.y + row.pos.y;
                let lineno = (i + 1) as u32;
                let bad = doc.errors.iter().any(|e| e.line == lineno);
                let col = if bad { t.status.danger } else { t.text.disabled };
                painter.text(egui::pos2(origin.x - 8.0, y), egui::Align2::RIGHT_TOP, lineno.to_string(), font.clone(), col);
                if bad {
                    let r = egui::Rect::from_min_size(egui::pos2(origin.x - gutter, y), egui::vec2(resp.response.rect.width() + gutter, row_h));
                    shapes.push(egui::Shape::rect_filled(r, 0.0, Color32::from_rgba_unmultiplied(220, 60, 60, 40)));
                }
            }
            painter.set(bg, egui::Shape::Vec(shapes));
        });
    });
    out
}
