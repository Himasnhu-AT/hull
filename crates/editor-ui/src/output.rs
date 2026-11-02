//! Output: diagnostics from the engine, scripts and builds, filtered by level.

use ashlar_ui::tokens::{self, Tokens};
use ashlar_ui::virtual_list::{RowHeights, VirtualList};
use editor_proto::{Diagnostic, Level};
use egui::{Color32, Ui, pos2};

use crate::model::Req;

/// Entries kept; older ones drop.
pub(crate) const MAX_ENTRIES: usize = 5000;

pub(crate) struct OutputState {
    pub min_level: Level,
    selected: Option<usize>,
    /// `file:line:col` of the clicked entry, shown under the list.
    pub location: Option<String>,
    follow: bool,
}

impl Default for OutputState {
    fn default() -> Self {
        OutputState {
            min_level: Level::Info,
            selected: None,
            location: None,
            follow: true,
        }
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

pub(crate) fn show(ui: &mut Ui, st: &mut OutputState, all: &[Diagnostic], clear: &mut bool, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    ui.horizontal(|ui| {
        for (l, name) in [(Level::Error, "Errors"), (Level::Warn, "Warnings"), (Level::Info, "Info"), (Level::Debug, "Debug")] {
            if ui.selectable_label(st.min_level == l, name).on_hover_text("Show this level and above").clicked() {
                st.min_level = l;
                st.selected = None;
            }
        }
        if ui.button("Clear").clicked() {
            *clear = true;
        }
    });
    let shown: Vec<&Diagnostic> = all.iter().filter(|d| d.level >= st.min_level).collect();
    let n = shown.len();
    let selected = st.selected;
    let label_of = |i: usize| shown.get(i).map_or("", |d| d.message.as_str());
    let footer = if st.location.is_some() { 22.0 } else { 0.0 };
    let max_h = (ui.available_height() - footer).max(40.0);
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
        if let Some(loc) = location(d) {
            let sec = if row.selected { t.selection_text } else { t.text.secondary };
            ui.painter().text(pos2(x, mid), egui::Align2::LEFT_CENTER, loc, font, sec);
        }
    });
    if let Some(i) = out.clicked {
        st.selected = Some(i);
        st.location = shown.get(i).and_then(|d| location(d));
        if let Some(loc) = &st.location {
            reqs.push(Req::Copy(loc.clone()));
        }
    }
    if let Some(loc) = &st.location {
        ui.label(egui::RichText::new(format!("{loc}   (copied)")).monospace().color(t.text.secondary));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn location_text() {
        let mut d = Diagnostic {
            level: Level::Error,
            source: "ruspy".into(),
            message: "m".into(),
            file: Some("a.ruspy".into()),
            line: Some(3),
            col: Some(7),
        };
        assert_eq!(location(&d).as_deref(), Some("a.ruspy:3:7"));
        d.col = None;
        assert_eq!(location(&d).as_deref(), Some("a.ruspy:3"));
        d.line = None;
        assert_eq!(location(&d).as_deref(), Some("a.ruspy"));
        d.file = None;
        assert_eq!(location(&d), None);
    }
}
