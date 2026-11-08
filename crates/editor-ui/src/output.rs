//! Output / Messages: one log for everything that goes wrong or is worth saying. Sources:
//! editor (Op refusals, place errors, save errors), logic (graph and script diagnostics), build
//! (the Play build's cargo output) and engine (warnings and errors from the log). Filter by
//! source and level, search, click a line to select its entity or open its file.

use ashlar_ui::tokens::{self, Tokens};
use ashlar_ui::virtual_list::{RowHeights, VirtualList};
use editor_proto::{Diagnostic, Level};
use egui::{Color32, Ui, pos2};

use crate::model::Req;

/// Entries kept; older ones drop.
pub(crate) const MAX_ENTRIES: usize = 5000;

/// The groups the source filter offers.
pub(crate) const SOURCES: [&str; 4] = ["Editor", "Logic", "Build", "Engine"];

/// Which group a diagnostic's `source` belongs to.
pub(crate) fn group_of(source: &str) -> usize {
    let s = source.to_lowercase();
    if s.contains("cargo") || s.contains("build") {
        2
    } else if s.contains("logic") || s.contains("ruspy") || s.contains("script") || s.contains("graph") {
        1
    } else if s.contains("engine") || s.contains("bevy") || s.contains("wgpu") || s.contains("render") || s.contains("asset") {
        3
    } else {
        0
    }
}

pub(crate) struct OutputState {
    pub min_level: Level,
    /// Which of [`SOURCES`] are shown.
    pub sources: [bool; 4],
    pub search: String,
    selected: Option<usize>,
    /// `file:line:col` of the clicked entry, shown under the list.
    pub location: Option<String>,
    follow: bool,
}

impl Default for OutputState {
    fn default() -> Self {
        OutputState {
            min_level: Level::Info,
            sources: [true; 4],
            search: String::new(),
            selected: None,
            location: None,
            follow: true,
        }
    }
}

/// Append to the log, dropping the oldest past [`MAX_ENTRIES`].
pub(crate) fn push(log: &mut Vec<Diagnostic>, d: Diagnostic) {
    log.push(d);
    let over = log.len().saturating_sub(MAX_ENTRIES);
    if over > 0 {
        log.drain(..over);
    }
}

/// Text for the tab badge: errors and warnings in the log (`None` when there are none).
pub(crate) fn badge(log: &[Diagnostic]) -> Option<String> {
    let n = log.iter().filter(|d| d.level >= Level::Warn).count();
    match n {
        0 => None,
        1..=99 => Some(n.to_string()),
        _ => Some("99+".into()),
    }
}

pub(crate) fn location(d: &Diagnostic) -> Option<String> {
    let f = d.file.as_ref()?;
    Some(match (d.line, d.col) {
        (Some(l), Some(c)) => format!("{f}:{l}:{c}"),
        (Some(l), None) => format!("{f}:{l}"),
        _ => f.clone(),
    })
}

fn level_color(l: Level, t: &Tokens) -> Color32 {
    match l {
        Level::Error => t.status.danger,
        Level::Warn => t.status.warning,
        Level::Info => t.text.primary,
        Level::Debug | Level::Trace => t.text.secondary,
    }
}

fn tag(l: Level) -> &'static str {
    match l {
        Level::Error => "ERR",
        Level::Warn => "WRN",
        Level::Info => "INF",
        Level::Debug => "DBG",
        Level::Trace => "TRC",
    }
}

/// Whether `d` passes the filters.
pub(crate) fn passes(st: &OutputState, d: &Diagnostic) -> bool {
    if d.level < st.min_level || !st.sources[group_of(&d.source)] {
        return false;
    }
    let q = st.search.trim().to_lowercase();
    q.is_empty()
        || d.message.to_lowercase().contains(&q)
        || d.source.to_lowercase().contains(&q)
        || d.file.as_ref().is_some_and(|f| f.to_lowercase().contains(&q))
}

/// What a click on an entry does.
pub(crate) fn click_reqs(d: &Diagnostic) -> Vec<Req> {
    let mut out = Vec::new();
    if let Some(e) = d.entity {
        out.push(Req::Select(vec![e]));
    }
    if let Some(f) = &d.file {
        if f.ends_with(".logic.ron") {
            out.push(Req::OpenLogic(f.clone()));
        } else if f.ends_with(".ruspy") && d.line.is_some_and(|l| l > 0) {
            out.push(Req::OpenScriptAt { path: f.clone(), line: d.line.unwrap_or(1) as usize - 1 });
        } else if let Some(loc) = location(d) {
            out.push(Req::Copy(loc));
        }
    }
    out
}

pub(crate) fn show(ui: &mut Ui, st: &mut OutputState, all: &[Diagnostic], clear: &mut bool, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    ui.horizontal_wrapped(|ui| {
        for (l, name) in [(Level::Error, "Errors"), (Level::Warn, "Warnings"), (Level::Info, "Info"), (Level::Debug, "Debug")] {
            if ui.selectable_label(st.min_level == l, name).on_hover_text("Show this level and above").clicked() {
                st.min_level = l;
                st.selected = None;
            }
        }
        ui.separator();
        for (i, name) in SOURCES.iter().enumerate() {
            let n = all.iter().filter(|d| group_of(&d.source) == i && d.level >= Level::Warn).count();
            let text = if n > 0 { format!("{name} ({n})") } else { (*name).to_owned() };
            if ui.selectable_label(st.sources[i], text).on_hover_text("Show or hide this source").clicked() {
                st.sources[i] = !st.sources[i];
                st.selected = None;
            }
        }
        ui.separator();
        let r = ui.add(egui::TextEdit::singleline(&mut st.search).hint_text("Search").desired_width(160.0));
        if r.changed() {
            st.selected = None;
        }
        if ui.button("Clear").clicked() {
            *clear = true;
        }
    });
    let shown: Vec<&Diagnostic> = all.iter().filter(|d| passes(st, d)).collect();
    let n = shown.len();
    let selected = st.selected;
    let label_of = |i: usize| shown.get(i).map_or("", |d| d.message.as_str());
    let footer = if st.location.is_some() { 22.0 } else { 0.0 };
    let max_h = (ui.available_height() - footer).max(40.0);
    if n == 0 {
        ui.add_space(t.space.sm);
        ui.label(egui::RichText::new(if all.is_empty() { "Nothing to report." } else { "Nothing matches the filters." }).color(t.text.disabled));
    }
    let mut list = VirtualList::new("output.list", n, RowHeights::Uniform(t.control_height - 4.0))
        .selected(selected)
        .row_label(&label_of)
        .max_height(max_h);
    if st.follow && n > 0 && selected.is_none() {
        list = list.scroll_to(Some(n - 1));
    }
    let out = list.show(ui, |ui, row| {
        let Some(d) = shown.get(row.index) else { return };
        let src = if d.source.is_empty() { String::new() } else { format!("[{}] ", d.source) };
        crate::model::a11y_row(ui, row.rect, egui::Id::new(("output.row", row.index)), &format!("{src}{}", d.message), row.selected);
        let mid = row.rect.center().y;
        let c = if row.selected { t.selection_text } else { level_color(d.level, &t) };
        let font = Tokens::font(t.type_scale.small);
        ui.painter()
            .text(pos2(row.rect.left() + 4.0, mid), egui::Align2::LEFT_CENTER, tag(d.level), font.clone(), c);
        let mut x = row.rect.left() + 36.0;
        let g = ui.painter().layout_no_wrap(format!("{src}{}", d.message), Tokens::font(t.type_scale.body), c);
        let w = g.size().x;
        ui.painter().galley(pos2(x, mid - g.size().y / 2.0), g, c);
        x += w + 12.0;
        let sec = if row.selected { t.selection_text } else { t.text.secondary };
        if let Some(loc) = location(d) {
            ui.painter().text(pos2(x, mid), egui::Align2::LEFT_CENTER, loc, font.clone(), sec);
        } else if d.entity.is_some() {
            ui.painter().text(pos2(x, mid), egui::Align2::LEFT_CENTER, "(click to select)", font.clone(), sec);
        }
    });
    if let Some(i) = out.clicked {
        st.selected = Some(i);
        st.location = shown.get(i).and_then(|d| location(d));
        if let Some(d) = shown.get(i) {
            reqs.extend(click_reqs(d));
        }
    }
    if let Some(loc) = &st.location {
        let hint = if loc.contains(".logic.ron") { "(opened in Logic)" } else { "(copied)" };
        ui.label(egui::RichText::new(format!("{loc}   {hint}")).monospace().color(t.text.secondary));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn location_text() {
        let mut d = Diagnostic::new(Level::Error, "ruspy", "m").at("a.ruspy", Some(3), Some(7));
        assert_eq!(location(&d).as_deref(), Some("a.ruspy:3:7"));
        d.col = None;
        assert_eq!(location(&d).as_deref(), Some("a.ruspy:3"));
        d.line = None;
        assert_eq!(location(&d).as_deref(), Some("a.ruspy"));
        d.file = None;
        assert_eq!(location(&d), None);
    }

    #[test]
    fn filters_combine() {
        let mut st = OutputState::default();
        let a = Diagnostic::new(Level::Error, "logic", "bad pin on door");
        let b = Diagnostic::new(Level::Info, "cargo", "Compiling game");
        let c = Diagnostic::new(Level::Warn, "editor", "Place failed: not a model");
        assert!(passes(&st, &a) && passes(&st, &b) && passes(&st, &c));
        st.min_level = Level::Warn;
        assert!(passes(&st, &a) && !passes(&st, &b) && passes(&st, &c));
        st.sources[1] = false;
        assert!(!passes(&st, &a) && passes(&st, &c));
        st.search = "PLACE".into();
        assert!(passes(&st, &c));
        st.search = "door".into();
        assert!(!passes(&st, &c));
    }

    #[test]
    fn badge_counts_warnings_and_errors() {
        let mut log = vec![Diagnostic::new(Level::Info, "x", "a")];
        assert_eq!(badge(&log), None);
        log.push(Diagnostic::new(Level::Warn, "x", "b"));
        log.push(Diagnostic::new(Level::Error, "x", "c"));
        assert_eq!(badge(&log).as_deref(), Some("2"));
    }

    #[test]
    fn click_selects_entity_or_opens_logic() {
        let d = Diagnostic::new(Level::Error, "logic", "m").about(7).at("logic/door.logic.ron", Some(1), None);
        let r = click_reqs(&d);
        assert!(matches!(r[0], Req::Select(ref v) if v == &[7]));
        assert!(matches!(r[1], Req::OpenLogic(ref p) if p == "logic/door.logic.ron"));
        let d = Diagnostic::new(Level::Error, "ruspy", "m").at("scripts/a.ruspy", Some(3), Some(2));
        assert!(matches!(click_reqs(&d)[0], Req::OpenScriptAt { ref path, line: 2 } if path == "scripts/a.ruspy"));
        let d = Diagnostic::new(Level::Error, "build", "m").at("src/main.rs", Some(3), Some(2));
        assert!(matches!(click_reqs(&d)[0], Req::Copy(ref s) if s == "src/main.rs:3:2"));
    }
}
