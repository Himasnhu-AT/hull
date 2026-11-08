//! The document area: the centre tab strip. The first tab is always the Level viewport (it
//! cannot be closed); Logic graphs and scripts open as further tabs.

use ashlar_ui::tokens;
use egui::{Align2, FontId, Rect, Sense, Ui, pos2, vec2};

/// Height of the tab strip in points.
pub(crate) const STRIP_H: f32 = 28.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DocKind {
    Logic,
    Script,
}

/// An open document tab (not the Level tab).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DocTab {
    pub kind: DocKind,
    /// Path of the file under the assets folder.
    pub path: String,
}

impl DocTab {
    /// `door.logic.ron` becomes "Logic: door", `score.ruspy` "Script: score".
    pub fn for_path(path: &str) -> DocTab {
        let kind = if path.ends_with(".logic.ron") { DocKind::Logic } else { DocKind::Script };
        DocTab { kind, path: path.to_owned() }
    }
    pub fn title(&self) -> String {
        let file = self.path.rsplit('/').next().unwrap_or(&self.path);
        let stem = file.strip_suffix(".logic.ron").or_else(|| file.rsplit_once('.').map(|x| x.0)).unwrap_or(file);
        match self.kind {
            DocKind::Logic => format!("Logic: {stem}"),
            DocKind::Script => format!("Script: {stem}"),
        }
    }
}

#[derive(Default)]
pub(crate) struct Docs {
    pub tabs: Vec<DocTab>,
    /// 0 is the Level tab; `n` is `tabs[n - 1]`.
    pub active: usize,
}

impl Docs {
    /// Opens (or switches to) the tab for `path`.
    pub fn open(&mut self, path: &str) {
        let tab = DocTab::for_path(path);
        let i = match self.tabs.iter().position(|t| *t == tab) {
            Some(i) => i,
            None => {
                self.tabs.push(tab);
                self.tabs.len() - 1
            }
        };
        self.active = i + 1;
    }
    pub fn close(&mut self, index: usize) {
        if index == 0 || index > self.tabs.len() {
            return;
        }
        self.tabs.remove(index - 1);
        if self.active >= index {
            self.active = self.active.saturating_sub(1).min(self.tabs.len());
        }
    }
    pub fn active_tab(&self) -> Option<&DocTab> {
        self.active.checked_sub(1).and_then(|i| self.tabs.get(i))
    }
}

/// What the strip asks for.
#[derive(Default)]
pub(crate) struct StripOut {
    pub activate: Option<usize>,
    pub close: Option<usize>,
}

/// Draws the strip in `rect`: `level` first (no close button), then every document tab.
pub(crate) fn strip(ui: &mut Ui, rect: Rect, level: &str, docs: &Docs) -> StripOut {
    let t = tokens::current(ui.ctx());
    let mut out = StripOut::default();
    ui.painter().rect_filled(rect, 0.0, t.surface.app);
    let font = FontId::proportional(14.0);
    let mut x = rect.left() + 4.0;
    let titles: Vec<String> = std::iter::once(level.to_owned()).chain(docs.tabs.iter().map(DocTab::title)).collect();
    for (i, title) in titles.iter().enumerate() {
        let closable = i > 0;
        let galley = ui.painter().layout_no_wrap(title.clone(), font.clone(), t.text.primary);
        let w = galley.size().x + 24.0 + if closable { 20.0 } else { 0.0 };
        let r = Rect::from_min_size(pos2(x, rect.top() + 3.0), vec2(w, STRIP_H - 3.0));
        let on = docs.active == i;
        let resp = ui.interact(r, egui::Id::new(("editor.doc", i, title)), Sense::click());
        let fill = if on { t.surface.panel } else if resp.hovered() { t.surface.raised } else { egui::Color32::TRANSPARENT };
        ui.painter().rect_filled(r, egui::CornerRadius { nw: 5, ne: 5, sw: 0, se: 0 }, fill);
        if on {
            ui.painter().rect_filled(Rect::from_min_size(r.min, vec2(r.width(), 2.0)), 0.0, t.accent);
        }
        let color = if on { t.text.primary } else { t.text.secondary };
        ui.painter().text(pos2(r.left() + 12.0, r.center().y + 1.0), Align2::LEFT_CENTER, title, font.clone(), color);
        resp.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::SelectableLabel, true, on, title.clone()));
        if resp.clicked() {
            out.activate = Some(i);
        }
        if closable {
            let c = Rect::from_center_size(pos2(r.right() - 12.0, r.center().y + 1.0), vec2(16.0, 16.0));
            let cr = ui.interact(c, egui::Id::new(("editor.doc.close", i, title)), Sense::click());
            if cr.hovered() {
                ui.painter().rect_filled(c, 3.0, t.surface.raised);
            }
            ui.painter().text(c.center(), Align2::CENTER_CENTER, "x", FontId::proportional(12.0), t.text.secondary);
            cr.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, format!("Close {title}")));
            if cr.clicked() {
                out.close = Some(i);
            }
        }
        x += w + 2.0;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_read_like_documents() {
        assert_eq!(DocTab::for_path("logic/door.logic.ron").title(), "Logic: door");
        assert_eq!(DocTab::for_path("scripts/score.ruspy").title(), "Script: score");
    }

    #[test]
    fn opening_twice_reuses_the_tab_and_the_level_tab_cannot_close() {
        let mut d = Docs::default();
        d.open("logic/a.logic.ron");
        d.open("logic/b.logic.ron");
        d.open("logic/a.logic.ron");
        assert_eq!(d.tabs.len(), 2);
        assert_eq!(d.active, 1);
        d.close(0);
        assert_eq!(d.tabs.len(), 2);
        d.close(1);
        assert_eq!(d.tabs.len(), 1);
        assert!(d.active <= d.tabs.len());
    }
}
