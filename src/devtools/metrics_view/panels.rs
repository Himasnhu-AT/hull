//! The panels of the metrics view: sidebar, health header, issues, and the four tabs.

use ashlar_ui::content::EmptyState;
use ashlar_ui::controls::{Badge, Button, Segmented, Size, Tone, Variant};
use ashlar_ui::rolling::RollingText;
use ashlar_ui::search::SearchField;
use ashlar_ui::sidebar::{ItemRef, Sidebar, SidebarItem, SidebarSection};
use ashlar_ui::status_bar::{self, StatusBar};
use ashlar_ui::tabs::TabStrip;
use ashlar_ui::tokens::Tokens;
use bevy_egui::egui::{self, Align, Align2, Color32, FontId, Layout, Margin, RichText, ScrollArea, Sense, Stroke, vec2};

use super::chart::{ChartState, Series, big_chart, level_color, sparkline, status_color};
use super::{Cache, Inputs, KINDS, RunRow, ViewerUi, kind_index, previous};
use crate::devtools::metrics::Summary;
use crate::devtools::metrics_analysis::{Analysis, HeadStat, KeyInfo, REGRESSION, Sev, Target, Verdict, age, clock, higher_better, label, num, pct, with_unit};
use crate::devtools::metrics_history::{SessionSummary, delta};
use crate::devtools::metrics_viewer::{EventKind, ViewEvent};

const ROW_H: f32 = 28.0;
const STAT_W: f32 = 64.0;
const SPARK_W: f32 = 130.0;
const EVENT_H: f32 = 24.0;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Text colour of a value: its threshold level, or plain text when the key has no thresholds.
fn value_color(t: &Tokens, th_known: bool, level: u8) -> Color32 {
    if th_known && level > 0 { status_color(t, level) } else { t.text.primary }
}

/// `▲ +12%` / `▼ −8%` with the triangle drawn, coloured by whether it is good or bad.
fn delta_chip(ui: &mut egui::Ui, t: &Tokens, (d, sign): (f64, i8)) {
    let color = match sign {
        1 => t.status.success,
        -1 => t.status.danger,
        _ => t.text.secondary,
    };
    let text = pct(d);
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 3.0;
        let (rect, _) = ui.allocate_exact_size(vec2(9.0, 9.0), Sense::hover());
        if d.abs() >= 0.005 {
            let c = rect.center();
            let pts = if d > 0.0 { vec![egui::pos2(c.x - 4.0, c.y + 3.0), egui::pos2(c.x + 4.0, c.y + 3.0), egui::pos2(c.x, c.y - 4.0)] } else { vec![egui::pos2(c.x - 4.0, c.y - 3.0), egui::pos2(c.x + 4.0, c.y - 3.0), egui::pos2(c.x, c.y + 4.0)] };
            ui.painter().add(egui::Shape::convex_polygon(pts, color, Stroke::NONE));
        }
        ui.label(RichText::new(text).size(t.type_scale.small).color(color));
    });
}

impl ViewerUi {
    // ---- rows of the runs sidebar ----

    pub(super) fn build_rows(&mut self, inp: &Inputs) {
        let key = (inp.st.runs_gen, now_ms() / 15_000);
        if self.rows_key == key && self.rows_at.is_some() {
            return;
        }
        self.rows_key = key;
        self.rows_at = Some(std::time::Instant::now());
        let now = now_ms();
        self.rows.clear();
        for (idx, r) in inp.st.runs.iter().enumerate().rev() {
            let s = inp.past.iter().find(|s| s.id == r.id);
            let meta = inp.st.meta.get(&r.id);
            let game = s.map(|s| s.game.as_str()).or(meta.map(|m| m.game.as_str())).filter(|g| !g.is_empty()).unwrap_or("run");
            let start = s.map(|s| s.start_ts).or(meta.map(|m| m.start_ts)).filter(|t| *t > 0);
            let mode = s.map(|s| s.mode.as_str()).or(meta.map(|m| m.mode.as_str())).unwrap_or("");
            let when = start.map_or(String::new(), |t| age(now.saturating_sub(t) / 1000));
            let who = match s {
                Some(s) if s.commit.is_some() => s.commit_label(),
                _ => game.to_string(),
            };
            let label = if when.is_empty() { who } else { format!("{who} · {when}") };
            let mut detail = Vec::new();
            if let Some(s) = s.filter(|s| s.seconds > 0.0) {
                detail.push(clock(s.seconds));
            }
            if !mode.is_empty() {
                detail.push(mode.to_string());
            }
            let detail = if detail.is_empty() { r.id.clone() } else { detail.join(" · ") };
            let regressed = s.is_some_and(|s| regressed(s, previous(inp.past, &s.id, Some(s))));
            let badge = if r.live {
                Some("LIVE")
            } else if s.is_some_and(|s| matches!(s.ended.as_str(), "killed" | "crash" | "crashed")) {
                Some("KILLED")
            } else if regressed {
                Some("REGRESSED")
            } else {
                None
            };
            self.rows.push(RunRow { idx, id: r.id.clone(), label, detail, badge });
        }
    }

    pub(super) fn sidebar_ui(&mut self, root: &mut egui::Ui, inp: &Inputs, t: &Tokens) -> Option<usize> {
        let mut pick = None;
        let cur = inp.st.current().map(|r| r.id.clone());
        egui::Panel::left("runs")
            .resizable(true)
            .default_size(272.0)
            .size_range(220.0..=420.0)
            .show_separator_line(false)
            .frame(egui::Frame::new().fill(t.surface.panel).inner_margin(Margin::same(8)))
            .show(root, |ui| {
                if self.rows.is_empty() {
                    ui.add_space(8.0);
                    ui.label(RichText::new("No runs logged yet").color(t.text.secondary));
                    return;
                }
                let items: Vec<SidebarItem> = self
                    .rows
                    .iter()
                    .map(|r| {
                        let it = SidebarItem::new(&r.label).detail(&r.detail);
                        match r.badge {
                            Some(b) => it.badge(b),
                            None => it,
                        }
                    })
                    .collect();
                let sections = [SidebarSection::new("Runs · newest first", &items).count(items.len())];
                self.sidebar.selected = cur.and_then(|id| self.rows.iter().position(|r| r.id == id)).map(|item| ItemRef { section: 0, item });
                let out = Sidebar::new("runs", "Runs", &mut self.sidebar, &sections).max_height(ui.available_height()).show(ui);
                if let Some(r) = out.select.or(out.activated)
                    && let Some(row) = self.rows.get(r.item)
                {
                    pick = Some(row.idx);
                }
            });
        pick
    }

    pub(super) fn status_bar(&mut self, root: &mut egui::Ui, inp: &Inputs, c: &Cache) {
        let file = inp.st.file().and_then(|p| p.file_name()).map_or(String::new(), |n| n.to_string_lossy().into_owned());
        let narrow = root.available_width() < 1100.0;
        let folder = if narrow { inp.data.file_name().map_or(String::new(), |n| format!("…/{}", n.to_string_lossy())) } else { inp.data.display().to_string() };
        let fresh = inp.st.last_data.map(|t| t.elapsed().as_secs());
        let live = inp.st.current().is_some_and(|r| r.live);
        let upd = match (live, fresh) {
            (true, Some(s)) => format!("updated {s}s ago"),
            (true, None) => "waiting for data".to_string(),
            (false, _) => "run ended".to_string(),
        };
        let counts = format!("{} keys · {} events", c.analysis.keys.len(), inp.st.events.len());
        let cost = format!("view {:.1} ms", self.cost_ms);
        StatusBar::new("status").show(
            root,
            |ui| {
                status_bar::text(ui, "status.folder", &format!("data: {folder}"));
                if !file.is_empty() && !narrow {
                    status_bar::text(ui, "status.file", &format!("following {file}"));
                }
            },
            |ui| {
                status_bar::text(ui, "status.cost", &cost);
                status_bar::text(ui, "status.counts", &counts);
                status_bar::text(ui, "status.updated", &upd);
            },
        );
    }

    // ---- main column ----

    pub(super) fn main_ui(&mut self, ui: &mut egui::Ui, inp: &Inputs, c: &Cache, t: &Tokens) {
        if inp.st.runs.is_empty() {
            let body = format!("Run the game: its session log appears in {}/logs and shows up here.", inp.data.display());
            EmptyState::new("empty.runs", "No runs logged yet").body(&body).show(ui);
            return;
        }
        if c.analysis.keys.is_empty() {
            let body = if inp.st.current().is_some_and(|r| r.live) { "The run is live; the first per-second values arrive within a second or two." } else { "This run's log has no metrics lines." };
            EmptyState::new("empty.data", "No metrics in this run").body(body).show(ui);
            return;
        }
        self.header(ui, inp, c, t);
        ui.add_space(8.0);
        self.issues_ui(ui, c, t);
        ui.add_space(8.0);
        let labels = [
            "Overview".to_string(),
            format!("All metrics ({})", c.analysis.keys.len()),
            format!("Events ({})", inp.st.events.len()),
            format!("Runs ({})", inp.past.len().min(40) + usize::from(!inp.past.iter().any(|s| s.id == c.summary.id))),
        ];
        TabStrip::new("tabs", &labels, &mut self.tab).label("Views").show(ui);
        ui.add_space(8.0);
        match self.tab {
            0 => self.overview_tab(ui, inp, c, t),
            1 => self.all_tab(ui, inp, c, t),
            2 => self.events_tab(ui, inp, c, t),
            _ => self.runs_tab(ui, inp, c, t),
        }
    }

    fn header(&mut self, ui: &mut egui::Ui, inp: &Inputs, c: &Cache, t: &Tokens) {
        let a = &c.analysis;
        let live = inp.st.current().is_some_and(|r| r.live);
        let (verdict_color, verdict_level) = match a.verdict {
            Verdict::Smooth => (t.status.success, 0),
            Verdict::NoData => (t.text.secondary, 3),
            Verdict::Hitching | Verdict::MemoryGrowing => (t.status.warning, 1),
            _ => {
                if a.head.get(1).is_some_and(|h| h.level == 2) || a.head.first().is_some_and(|h| h.level == 2) { (t.status.danger, 2) } else { (t.status.warning, 1) }
            }
        };
        let _ = verdict_level;
        egui::Frame::new().fill(t.surface.panel).corner_radius(t.radius.lg()).inner_margin(Margin::same(12)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                // Verdict: the one word.
                let (dot, _) = ui.allocate_exact_size(vec2(14.0, 14.0), Sense::hover());
                ui.painter().circle_filled(dot.center(), 6.0, verdict_color);
                ui.label(RichText::new(a.verdict.word()).size(24.0).strong().color(verdict_color));
                ui.add_space(6.0);
                ui.vertical(|ui| {
                    ui.label(RichText::new(&a.reason).color(t.text.primary));
                });
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if live {
                        Badge::new("hdr.live", "LIVE").tone(Tone::Accent).show(ui);
                    }
                    let (red, amber) = a.counts();
                    if amber > 0 {
                        Badge::new("hdr.amber", &format!("{amber} warning{}", if amber == 1 { "" } else { "s" })).tone(Tone::Warning).show(ui);
                    }
                    if red > 0 {
                        Badge::new("hdr.red", &format!("{red} critical")).tone(Tone::Danger).show(ui);
                    }
                });
            });
            {
                let s = &c.summary;
                let mut title = if s.game.is_empty() { "Run".to_string() } else { s.game.clone() };
                if s.commit.is_some() {
                    title += &format!(" · {}", s.commit_label());
                }
                let mut sub = vec![if s.mode.is_empty() { None } else { Some(s.mode.clone()) }, inp.st.quality.clone(), a.prev_id.as_ref().map(|p| format!("compared with {p}"))];
                sub.retain(Option::is_some);
                let line = format!("{title}   {}   ·   {}", sub.into_iter().flatten().collect::<Vec<_>>().join(" · "), if a.live_scope { "last minute of a live run".to_string() } else { format!("whole run, {}", clock(a.span.1)) });
                ui.add(egui::Label::new(RichText::new(line).size(t.type_scale.small).color(t.text.secondary)).truncate());
            }
            ui.add_space(8.0);
            // Headline numbers.
            let n = a.head.len().max(1) as f32;
            let gap = 8.0;
            let w = ((ui.available_width() - gap * (n - 1.0)) / n).floor().max(90.0);
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = gap;
                for h in &a.head {
                    if let Some(target) = self.tile(ui, w, h, t) {
                        self.jump(target);
                    }
                }
            });
        });
    }

    fn tile(&mut self, ui: &mut egui::Ui, w: f32, h: &HeadStat, t: &Tokens) -> Option<Target> {
        let (rect, resp) = ui.allocate_exact_size(vec2(w, 88.0), Sense::click());
        let fill = if resp.hovered() && h.key.is_some() { t.surface.hover } else { t.surface.raised };
        let color = if h.level >= 3 { t.text.secondary } else { value_color(t, true, h.level) };
        let painter = ui.painter();
        painter.rect_filled(rect, t.radius.md(), fill);
        let bar = egui::Rect::from_min_size(rect.min + vec2(0.0, 8.0), vec2(3.0, rect.height() - 16.0));
        painter.rect_filled(bar, 1.5, if h.level >= 3 { t.separator } else { status_color(t, h.level) });
        let inner = rect.shrink2(vec2(12.0, 8.0));
        let mut child = ui.new_child(egui::UiBuilder::new().max_rect(inner).layout(Layout::top_down(Align::Min)));
        child.spacing_mut().item_spacing.y = 1.0;
        child.label(RichText::new(h.title).size(t.type_scale.small).color(t.text.secondary));
        RollingText::new(&format!("tile.{}", h.id), &h.text).value(h.value).font(FontId::proportional(26.0)).color(color).tabular(true).show(&mut child);
        child.shrink_clip_rect(inner);
        child.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            if w >= 170.0 {
                ui.label(RichText::new(&h.sub).size(t.type_scale.small).color(t.text.secondary));
            }
            if let Some(d) = h.delta {
                delta_chip(ui, t, d);
            }
        });
        if let Some(k) = h.key
            && resp.clicked()
        {
            return Some(Target::Key(k));
        }
        None
    }

    fn issues_ui(&mut self, ui: &mut egui::Ui, c: &Cache, t: &Tokens) {
        let a = &c.analysis;
        let mut jump = None;
        egui::Frame::new().fill(t.surface.panel).corner_radius(t.radius.lg()).inner_margin(Margin::symmetric(12, 8)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.label(RichText::new("Issues").size(t.type_scale.heading).strong());
                if a.issues.is_empty() {
                    return;
                }
                let (red, amber) = a.counts();
                if red > 0 {
                    Badge::new("iss.red", &red.to_string()).tone(Tone::Danger).show(ui);
                }
                if amber > 0 {
                    Badge::new("iss.amber", &amber.to_string()).tone(Tone::Warning).show(ui);
                }
                if a.issues.len() > 3 {
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let l = if self.issues_all { "Show fewer".to_string() } else { format!("Show all {}", a.issues.len()) };
                        if Button::new("iss.more", &l).variant(Variant::Ghost).size(Size::Sm).show(ui).clicked() {
                            self.issues_all = !self.issues_all;
                        }
                    });
                }
            });
            if a.issues.is_empty() {
                ui.horizontal(|ui| {
                    let (dot, _) = ui.allocate_exact_size(vec2(14.0, 18.0), Sense::hover());
                    ui.painter().circle_filled(dot.center(), 4.5, t.status.success);
                    ui.label(RichText::new("No issues. Every metric is inside its thresholds and nothing regressed beyond noise.").color(t.text.secondary));
                });
                return;
            }
            let shown = if self.issues_all { a.issues.len() } else { a.issues.len().min(3) };
            let list = |ui: &mut egui::Ui, jump: &mut Option<Target>| {
                for (i, is) in a.issues.iter().take(shown).enumerate() {
                    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 26.0), Sense::click());
                    if resp.hovered() && is.target.is_some() {
                        ui.painter().rect_filled(rect, t.radius.md(), t.surface.hover);
                        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                    }
                    let p = ui.painter_at(rect);
                    let color = match is.sev {
                        Sev::Red => t.status.danger,
                        Sev::Amber => t.status.warning,
                        Sev::Info => t.status.info,
                    };
                    p.circle_filled(egui::pos2(rect.left() + 10.0, rect.center().y), 4.5, color);
                    let title = p.text(egui::pos2(rect.left() + 24.0, rect.center().y), Align2::LEFT_CENTER, &is.title, FontId::proportional(t.type_scale.body), t.text.primary);
                    p.text(egui::pos2(title.right() + 12.0, rect.center().y), Align2::LEFT_CENTER, &is.detail, FontId::proportional(t.type_scale.small + 0.5), t.text.secondary);
                    if is.target.is_some() {
                        let x = rect.right() - 12.0;
                        let y = rect.center().y;
                        p.line(vec![egui::pos2(x - 3.0, y - 4.0), egui::pos2(x + 1.0, y), egui::pos2(x - 3.0, y + 4.0)], Stroke::new(1.5, t.text.secondary));
                    }
                    if resp.clicked() {
                        *jump = is.target;
                    }
                    let _ = i;
                }
            };
            if self.issues_all {
                ScrollArea::vertical().id_salt("issues_scroll").max_height(190.0).auto_shrink([false, true]).show(ui, |ui| list(ui, &mut jump));
            } else {
                list(ui, &mut jump);
            }
        });
        if let Some(target) = jump {
            self.jump(target);
        }
    }

    // ---- Overview ----

    fn overview_keys(&self, inp: &Inputs, a: &Analysis) -> Vec<String> {
        let mut keys: Vec<String> = Vec::new();
        let add = |k: &str, keys: &mut Vec<String>| {
            if a.key(k).is_some() && !keys.iter().any(|x| x == k) {
                keys.push(k.to_string());
            }
        };
        if inp.featured.0.is_empty() {
            for k in ["frame.ms", "frame.fps", "cpu.main_ms", "gpu.frame_ms", "mem.footprint_mb"] {
                add(k, &mut keys);
            }
            if keys.len() < 3 {
                for k in &a.keys {
                    add(k.key, &mut keys);
                    if keys.len() >= 4 {
                        break;
                    }
                }
            }
        } else {
            for k in &inp.featured.0 {
                add(k, &mut keys);
            }
        }
        for k in &self.pinned {
            add(k, &mut keys);
        }
        keys
    }

    fn overview_tab(&mut self, ui: &mut egui::Ui, inp: &Inputs, c: &Cache, t: &Tokens) {
        let keys = self.overview_keys(inp, &c.analysis);
        ScrollArea::vertical().id_salt("overview_scroll").auto_shrink([false, false]).show(ui, |ui| {
            let cols = if ui.available_width() >= 820.0 { 2 } else { 1 };
            let rows = keys.len().div_ceil(cols);
            for r in 0..rows {
                ui.columns(cols, |uis| {
                    for (col, ui) in uis.iter_mut().enumerate() {
                        if let Some(k) = keys.get(r * cols + col) {
                            self.chart_card(ui, inp, c, k, 150.0, t);
                        }
                    }
                });
                ui.add_space(4.0);
            }
            ui.add_space(4.0);
            ui.label(RichText::new("Pin any metric with its Pin button to keep it here.").size(t.type_scale.small).color(t.text.disabled));
        });
    }

    /// A framed chart with its title, current value, stats and pin button.
    fn chart_card(&mut self, ui: &mut egui::Ui, inp: &Inputs, c: &Cache, key: &str, height: f32, t: &Tokens) {
        let Some(k) = c.analysis.key(key) else { return };
        egui::Frame::new().fill(t.surface.panel).corner_radius(t.radius.lg()).inner_margin(Margin::same(10)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.label(RichText::new(&k.label).strong());
                ui.label(RichText::new(with_unit(k.key, k.now)).strong().color(value_color(t, k.th.is_some(), k.now_level)));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    let pinned = self.pinned.iter().any(|p| p == key);
                    if Button::new(&format!("pin.{key}"), if pinned { "Unpin" } else { "Pin" }).variant(Variant::Ghost).size(Size::Sm).show(ui).clicked() {
                        if pinned {
                            self.pinned.retain(|p| p != key);
                        } else {
                            self.pinned.push(key.to_string());
                        }
                    }
                });
            });
            ui.label(RichText::new(stats_line(k)).size(t.type_scale.small).color(t.text.secondary));
            ui.add_space(4.0);
            self.chart_body(ui, inp, key, height, t);
        });
    }

    fn chart_body(&mut self, ui: &mut egui::Ui, inp: &Inputs, key: &str, height: f32, t: &Tokens) {
        let Some(samples) = inp.m.recent_samples(key) else { return };
        let series = Series { key, samples, th: inp.m.threshold(key) };
        let state = self.charts.entry(key.to_string()).or_default();
        big_chart(ui, key, &series, &inp.st.events, self.highlight, inp.m.now().max(inp.st.seconds), state, height, t);
    }

    // ---- All metrics ----

    fn all_tab(&mut self, ui: &mut egui::Ui, inp: &Inputs, c: &Cache, t: &Tokens) {
        let a = &c.analysis;
        ui.horizontal(|ui| {
            let r = SearchField::new("metrics.search", &mut self.search).hint("Search metrics   ( / )").width(280.0).show(ui);
            let _ = r;
            if self.focus_search {
                SearchField::focus(ui, "metrics.search");
                self.focus_search = false;
            }
            let mut sort = usize::from(self.sort_worst);
            if Segmented::new("metrics.sort", "Sort", &["By group", "Worst first"], &mut sort).show(ui).changed() {
                self.sort_worst = sort == 1;
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui.available_width() < 300.0 {
                    return;
                }
                if Button::new("all.collapse", "Collapse all").variant(Variant::Ghost).size(Size::Sm).show(ui).clicked() {
                    self.collapsed = a.keys.iter().map(|k| k.group.clone()).collect();
                }
                if Button::new("all.expand", "Expand all").variant(Variant::Ghost).size(Size::Sm).show(ui).clicked() {
                    self.collapsed.clear();
                }
            });
        });
        ui.add_space(6.0);
        let query = self.search.to_lowercase();
        let tokens: Vec<&str> = query.split_whitespace().collect();
        let matches = |k: &KeyInfo| tokens.iter().all(|w| k.key.to_lowercase().contains(w) || k.label.to_lowercase().contains(w));
        let mut list: Vec<&KeyInfo> = a.keys.iter().filter(|k| matches(k)).collect();
        if list.is_empty() {
            EmptyState::new("all.none", "No metric matches").body("Try a shorter search.").show(ui);
            return;
        }
        if self.sort_worst {
            list.sort_by(|x, y| {
                y.level
                    .cmp(&x.level)
                    .then(y.regression().total_cmp(&x.regression()))
                    .then(y.red_frac.total_cmp(&x.red_frac))
                    .then(y.amber_frac.total_cmp(&x.amber_frac))
            });
        }
        let width = ui.available_width();
        let wide = width >= 640.0;
        let mid = width >= 520.0;
        self.column_titles(ui, t, wide, mid);
        let time = a.span;
        ScrollArea::vertical().id_salt("all_scroll").auto_shrink([false, false]).show(ui, |ui| {
            let searching = !tokens.is_empty();
            let mut last_group: Option<&str> = None;
            for k in list {
                if !self.sort_worst && last_group != Some(k.group.as_str()) {
                    last_group = Some(k.group.as_str());
                    let n = a.keys.iter().filter(|x| x.group == k.group && matches(x)).count();
                    let worst = a.keys.iter().filter(|x| x.group == k.group).map(|x| x.level).max().unwrap_or(0);
                    self.group_header(ui, &k.group, n, worst, searching, t);
                }
                if !self.sort_worst && !searching && self.collapsed.contains(&k.group) {
                    continue;
                }
                self.key_row(ui, inp, c, k, time, (wide, mid), t);
            }
            ui.add_space(20.0);
        });
    }

    fn column_titles(&self, ui: &mut egui::Ui, t: &Tokens, wide: bool, mid: bool) {
        let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width() - 12.0, 18.0), Sense::hover());
        let p = ui.painter_at(rect);
        let f = FontId::proportional(t.type_scale.small);
        let mut x = rect.right();
        for (i, name) in ["max", "p95", "avg", "now"].iter().enumerate() {
            if (*name == "p95" || *name == "avg") && !mid {
                continue;
            }
            p.text(egui::pos2(x - 6.0, rect.center().y), Align2::RIGHT_CENTER, *name, f.clone(), t.text.secondary);
            x -= STAT_W;
            let _ = i;
        }
        if wide {
            p.text(egui::pos2(x - SPARK_W / 2.0 - 6.0, rect.center().y), Align2::CENTER_CENTER, "over the run", f.clone(), t.text.secondary);
        }
        p.text(egui::pos2(rect.left() + 24.0, rect.center().y), Align2::LEFT_CENTER, "Metric", f, t.text.secondary);
    }

    fn group_header(&mut self, ui: &mut egui::Ui, group: &str, n: usize, worst: u8, searching: bool, t: &Tokens) {
        let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width() - 12.0, 26.0), Sense::click());
        let open = searching || !self.collapsed.contains(group);
        if resp.hovered() {
            ui.painter().rect_filled(rect, t.radius.md(), t.surface.hover);
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        let p = ui.painter_at(rect);
        let c = egui::pos2(rect.left() + 12.0, rect.center().y);
        let pts = if open { vec![c + vec2(-4.0, -2.5), c + vec2(4.0, -2.5), c + vec2(0.0, 3.0)] } else { vec![c + vec2(-2.5, -4.0), c + vec2(-2.5, 4.0), c + vec2(3.0, 0.0)] };
        p.add(egui::Shape::convex_polygon(pts, t.text.secondary, Stroke::NONE));
        let name = p.text(egui::pos2(rect.left() + 26.0, rect.center().y), Align2::LEFT_CENTER, group.to_uppercase(), FontId::proportional(t.type_scale.small + 0.5), t.text.primary);
        let cnt = p.text(egui::pos2(name.right() + 8.0, rect.center().y), Align2::LEFT_CENTER, n.to_string(), FontId::proportional(t.type_scale.small), t.text.secondary);
        if worst > 0 {
            p.circle_filled(egui::pos2(cnt.right() + 12.0, rect.center().y), 4.0, status_color(t, worst));
        }
        if resp.clicked() && !searching {
            if open {
                self.collapsed.insert(group.to_string());
            } else {
                self.collapsed.remove(group);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn key_row(&mut self, ui: &mut egui::Ui, inp: &Inputs, c: &Cache, k: &KeyInfo, time: (f64, f64), (wide, mid): (bool, bool), t: &Tokens) {
        let open = self.expanded.iter().any(|e| e == k.key);
        let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width() - 12.0, ROW_H), Sense::click());
        if self.scroll_to.as_deref() == Some(k.key) {
            ui.scroll_to_rect(rect.expand2(vec2(0.0, 60.0)), Some(Align::Center));
            self.scroll_to = None;
        }
        if ui.is_rect_visible(rect) {
            let p = ui.painter_at(rect);
            if open {
                p.rect_filled(rect, t.radius.md(), t.surface.raised);
            } else if resp.hovered() {
                p.rect_filled(rect, t.radius.md(), t.surface.hover);
            }
            let cy = rect.center().y;
            let dot = if k.th.is_none() { t.separator } else { level_color(t, k.th, k.level) };
            p.circle_filled(egui::pos2(rect.left() + 12.0, cy), 3.5, dot);
            let body = FontId::proportional(t.type_scale.body);
            let small = FontId::proportional(t.type_scale.small);
            let mono = FontId::monospace(t.type_scale.mono);
            let mut right = rect.right();
            let lowhigh = higher_better(k.key);
            let cols: [(&str, f64, Option<u8>); 4] = [
                ("max", k.stats.max, Some(k.th.map_or(0, |th| th.level(k.stats.max)))),
                ("p95", if lowhigh { k.stats.p05 } else { k.stats.p95 }, Some(k.level)),
                ("avg", k.stats.avg, Some(k.th.map_or(0, |th| th.level(k.stats.avg)))),
                ("now", k.now, Some(k.now_level)),
            ];
            for (name, v, lvl) in cols {
                if (name == "p95" || name == "avg") && !mid {
                    continue;
                }
                let color = if k.th.is_some() && lvl.unwrap_or(0) > 0 { level_color(t, k.th, lvl.unwrap_or(0)) } else if name == "now" { t.text.primary } else { t.text.secondary };
                p.text(egui::pos2(right - 6.0, cy), Align2::RIGHT_CENTER, num(v), mono.clone(), color);
                right -= STAT_W;
            }
            if wide {
                let sr = egui::Rect::from_min_max(egui::pos2(right - SPARK_W, rect.top()), egui::pos2(right - 4.0, rect.bottom()));
                if let Some(samples) = inp.m.recent_samples(k.key) {
                    sparkline(&p, sr, &Series { key: k.key, samples, th: k.th }, k.level, time, t);
                }
                right -= SPARK_W;
            }
            let label = p.with_clip_rect(egui::Rect::from_min_max(rect.min, egui::pos2(right - 4.0, rect.bottom())));
            let l = label.text(egui::pos2(rect.left() + 24.0, cy), Align2::LEFT_CENTER, &k.label, body, t.text.primary);
            if let Some((d, sign)) = k.delta.filter(|(d, s)| *s != 0 && d.abs() >= REGRESSION) {
                let color = if sign < 0 { t.status.danger } else { t.status.success };
                label.text(egui::pos2(l.right() + 8.0, cy), Align2::LEFT_CENTER, pct(d), small, color);
            }
        }
        if resp.clicked() {
            if open {
                self.expanded.retain(|e| e != k.key);
            } else {
                self.expanded.push(k.key.to_string());
            }
        }
        if open {
            egui::Frame::new().fill(t.surface.raised).corner_radius(t.radius.md()).inner_margin(Margin::same(10)).show(ui, |ui| {
                ui.set_width(ui.available_width() - 12.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new(format!("{} · {}", k.key, stats_line(k))).size(t.type_scale.small).color(t.text.secondary));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if Button::new(&format!("close.{}", k.key), "Close").variant(Variant::Ghost).size(Size::Sm).show(ui).clicked() {
                            self.expanded.retain(|e| e != k.key);
                        }
                        let pinned = self.pinned.iter().any(|p| p == k.key);
                        if Button::new(&format!("pin.{}", k.key), if pinned { "Unpin" } else { "Pin to Overview" }).variant(Variant::Ghost).size(Size::Sm).show(ui).clicked() {
                            if pinned {
                                self.pinned.retain(|p| p != k.key);
                            } else {
                                self.pinned.push(k.key.to_string());
                            }
                        }
                        if self.charts.get(k.key).is_some_and(ChartState::is_zoomed) && Button::new(&format!("reset.{}", k.key), "Reset zoom").variant(Variant::Ghost).size(Size::Sm).show(ui).clicked() {
                            self.charts.remove(k.key);
                        }
                    });
                });
                ui.add_space(4.0);
                self.chart_body(ui, inp, k.key, 230.0, t);
            });
            ui.add_space(6.0);
        }
        let _ = c;
    }

    // ---- Events ----

    fn events_tab(&mut self, ui: &mut egui::Ui, inp: &Inputs, _c: &Cache, t: &Tokens) {
        let events = &inp.st.events;
        if events.is_empty() {
            EmptyState::new("events.none", "No events in this run").body("State changes, hitches, incidents and quality steps show up here.").show(ui);
            return;
        }
        ui.horizontal(|ui| {
            for kind in KINDS {
                let n = events.iter().filter(|e| e.kind == kind).count();
                if n == 0 {
                    continue;
                }
                let on = self.kinds[kind_index(kind)];
                let dot = kind_color(kind, t);
                let text = RichText::new(format!("{} {n}", kind.word())).color(if on { dot } else { t.text.disabled });
                if ui.selectable_label(on, text).clicked() {
                    self.kinds[kind_index(kind)] = !on;
                }
            }
            if self.highlight.is_some() {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if Button::new("events.clear", "Clear marker").variant(Variant::Ghost).size(Size::Sm).show(ui).clicked() {
                        self.highlight = None;
                    }
                });
            }
        });
        ui.add_space(6.0);
        let shown: Vec<&ViewEvent> = events.iter().filter(|e| self.kind_on(e.kind)).collect();
        if shown.is_empty() {
            EmptyState::new("events.filtered", "Every kind is filtered out").body("Turn a kind back on above.").show(ui);
            return;
        }
        let mut sa = ScrollArea::vertical().id_salt("events_scroll").auto_shrink([false, false]);
        if let Some(at) = self.scroll_event.take() {
            let i = shown.iter().position(|e| e.t >= at - 1e-9).unwrap_or(0);
            sa = sa.vertical_scroll_offset((i as f32 * EVENT_H - 3.0 * EVENT_H).max(0.0));
        }
        let mut clicked = None;
        let highlight = self.highlight;
        sa.show_rows(ui, EVENT_H, shown.len(), |ui, range| {
            for e in &shown[range] {
                let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width() - 12.0, EVENT_H), Sense::click());
                let p = ui.painter_at(rect);
                let selected = highlight.is_some_and(|h| (h - e.t).abs() < 1e-6);
                if selected {
                    p.rect_filled(rect, t.radius.md(), t.selection);
                } else if resp.hovered() {
                    p.rect_filled(rect, t.radius.md(), t.surface.hover);
                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                }
                let cy = rect.center().y;
                p.text(egui::pos2(rect.left() + 8.0, cy), Align2::LEFT_CENTER, clock(e.t), FontId::monospace(t.type_scale.mono), t.text.secondary);
                p.circle_filled(egui::pos2(rect.left() + 62.0, cy), 3.5, kind_color(e.kind, t));
                let name = p.text(egui::pos2(rect.left() + 74.0, cy), Align2::LEFT_CENTER, &e.name, FontId::proportional(t.type_scale.body), t.text.primary);
                p.text(egui::pos2(name.right().max(rect.left() + 74.0 + 130.0) + 10.0, cy), Align2::LEFT_CENTER, e.detail(), FontId::proportional(t.type_scale.small + 0.5), t.text.secondary);
                if resp.clicked() {
                    clicked = Some(e.t);
                }
            }
        });
        if let Some(tm) = clicked {
            self.highlight = if self.highlight == Some(tm) { None } else { Some(tm) };
        }
    }

    // ---- Runs ----

    fn runs_tab(&mut self, ui: &mut egui::Ui, inp: &Inputs, c: &Cache, t: &Tokens) {
        // Newest first: the history plus this run when it is not in it yet.
        let mut runs: Vec<&SessionSummary> = inp.past.iter().collect();
        if !runs.iter().any(|s| s.id == c.summary.id) {
            runs.push(&c.summary);
        }
        runs.sort_by(|a, b| b.id.cmp(&a.id));
        runs.truncate(40);
        let this = &c.summary;
        let default_base = previous(inp.past, &this.id, Some(this)).map(|s| s.id.clone());
        let base_id = self.baseline.clone().filter(|b| runs.iter().any(|r| &r.id == b)).or(default_base);
        let base = runs.iter().find(|r| Some(&r.id) == base_id.as_ref()).copied();

        // Columns: the compare list, prefixes expanded over the shown runs.
        let mut cols: Vec<(String, &'static str)> = Vec::new();
        for (k, stat) in &inp.compare.0 {
            if let Some(prefix) = k.strip_suffix('.').map(|p| format!("{p}.")) {
                let mut found: Vec<String> = runs.iter().flat_map(|r| r.keys.keys().filter(|x| x.starts_with(&prefix)).cloned()).collect();
                found.sort();
                found.dedup();
                cols.extend(found.into_iter().map(|x| (x, *stat)));
            } else if runs.iter().any(|r| r.keys.contains_key(k)) {
                cols.push((k.clone(), stat));
            }
        }
        cols.dedup();
        cols.truncate(24);
        if cols.is_empty() {
            EmptyState::new("runs.none", "Nothing to compare yet").body("Finished runs are listed here with their stats.").show(ui);
            return;
        }
        ui.label(
            RichText::new(match base {
                Some(b) => format!("Changes are against {} ({}). Pick another baseline with the radio buttons.", b.commit_label(), b.id),
                None => "No baseline run: pick one with the radio buttons.".to_string(),
            })
            .size(t.type_scale.small)
            .color(t.text.secondary),
        );
        ui.add_space(4.0);
        let selected_id = c.summary.id.clone();
        let mut set_base = None;
        let mut select = None;
        ScrollArea::both().id_salt("runs_scroll").auto_shrink([false, false]).show(ui, |ui| {
            egui::Grid::new("runs_grid").striped(true).min_col_width(60.0).spacing(vec2(14.0, 6.0)).show(ui, |ui| {
                ui.label(RichText::new("Run").size(t.type_scale.small).color(t.text.secondary));
                ui.label(RichText::new("Base").size(t.type_scale.small).color(t.text.secondary));
                for (k, stat) in &cols {
                    ui.label(RichText::new(format!("{} {}", label(k), stat)).size(t.type_scale.small).color(t.text.secondary));
                }
                ui.end_row();
                let now = now_ms();
                for r in &runs {
                    let is_sel = r.id == selected_id;
                    let when = if r.start_ts > 0 { age(now.saturating_sub(r.start_ts) / 1000) } else { r.id.clone() };
                    let name = format!("{} · {}", r.commit_label(), when);
                    let text = RichText::new(name).color(t.text.primary);
                    if ui.selectable_label(is_sel, text).clicked() {
                        select = Some(r.id.clone());
                    }
                    let is_base = Some(&r.id) == base_id.as_ref();
                    if ui.radio(is_base, "").clicked() {
                        set_base = Some(r.id.clone());
                    }
                    for (k, stat) in &cols {
                        let cur = r.keys.get(k).and_then(|s: &Summary| s.get(stat));
                        match (cur, base.and_then(|b| b.keys.get(k)).and_then(|s: &Summary| s.get(stat))) {
                            (Some(v), Some(bv)) if !is_base => {
                                ui.horizontal(|ui| {
                                    ui.spacing_mut().item_spacing.x = 6.0;
                                    ui.label(RichText::new(num(v)).monospace());
                                    if let Some((d, sign)) = delta(k, v, bv) {
                                        let color = match sign {
                                            1 => t.status.success,
                                            -1 => t.status.danger,
                                            _ => t.text.disabled,
                                        };
                                        ui.label(RichText::new(pct(d)).size(t.type_scale.small).color(color));
                                    }
                                });
                            }
                            (Some(v), _) => {
                                ui.label(RichText::new(num(v)).monospace());
                            }
                            _ => {
                                ui.label(RichText::new("—").color(t.text.disabled));
                            }
                        }
                    }
                    ui.end_row();
                }
            });
        });
        if let Some(b) = set_base {
            self.baseline = Some(b);
        }
        if let Some(id) = select
            && let Some(i) = inp.st.runs.iter().position(|r| r.id == id)
        {
            self.pending_pick = Some(i);
        }
    }
}

fn kind_color(kind: EventKind, t: &Tokens) -> Color32 {
    match kind {
        EventKind::Incident => t.status.danger,
        EventKind::Hitch => t.status.warning,
        EventKind::Quality => t.status.info,
        EventKind::State => t.accent_hover,
        EventKind::Other => t.text.secondary,
    }
}

/// `min 5.1 · avg 8.2 · p95 11 · max 31 ms · 118 samples`.
fn stats_line(k: &KeyInfo) -> String {
    let s = &k.stats;
    let u = |v: f64| with_unit(k.key, v);
    let tail = if higher_better(k.key) { format!("low {}", u(s.p05)) } else { format!("p95 {}", u(s.p95)) };
    format!("min {} · avg {} · {tail} · max {} · {} samples", u(s.min), u(s.avg), u(s.max), s.n)
}

/// Whether `s` is worse than `prev` by more than [`REGRESSION`] on a headline key.
pub(super) fn regressed(s: &SessionSummary, prev: Option<&SessionSummary>) -> bool {
    let Some(prev) = prev else { return false };
    [("frame.ms", "p95"), ("cpu.process_pct", "avg"), ("gpu.pct", "avg"), ("mem.footprint_mb", "max")].into_iter().any(|(k, stat)| {
        let (Some(a), Some(b)) = (s.keys.get(k).and_then(|x| x.get(stat)), prev.keys.get(k).and_then(|x| x.get(stat))) else { return false };
        delta(k, a, b).is_some_and(|(d, sign)| sign < 0 && d.abs() >= REGRESSION)
    })
}
