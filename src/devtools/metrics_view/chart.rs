//! Charts of the metrics viewer, drawn with the egui painter: a large interactive line chart
//! (threshold colours and guides, event markers, crosshair tooltip, pan / zoom) and a small
//! sparkline for list rows. Both decimate to at most two points per pixel column (min and max),
//! so a long run costs the same as a short one and spikes stay visible.

use std::collections::VecDeque;

use bevy_egui::egui::{self, Align2, Color32, FontId, Pos2, Rect, Sense, Shape, Stroke, pos2, vec2};

use ashlar_ui::tokens::Tokens;

use super::super::metrics::Threshold;
use super::super::metrics_analysis::{clock, num, with_unit};
use super::super::metrics_viewer::{EventKind, ViewEvent};

pub type Samples = VecDeque<(f32, f32)>;

/// Smallest visible time span when zoomed (seconds).
const MIN_SPAN: f64 = 6.0;

/// Colour of a threshold level (0 fine, 1 amber, 2 red); `None` threshold: the info colour.
pub fn level_color(t: &Tokens, th: Option<Threshold>, level: u8) -> Color32 {
    if th.is_none() { t.status.info } else { status_color(t, level) }
}

/// Colour of a level (0 fine, 1 amber, 2 red).
pub fn status_color(t: &Tokens, level: u8) -> Color32 {
    match level {
        0 => t.status.success,
        1 => t.status.warning,
        _ => t.status.danger,
    }
}

/// The visible time span of one chart: `None` = the whole run.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChartState {
    pub view: Option<(f64, f64)>,
}

impl ChartState {
    pub fn is_zoomed(&self) -> bool {
        self.view.is_some()
    }

    /// Zooms about time `at` by `factor` (> 1 zooms in) within `[0, end]`.
    pub fn zoom(&mut self, at: f64, factor: f64, end: f64) {
        let (a, b) = self.view.unwrap_or((0.0, end));
        let span = ((b - a) / factor).clamp(MIN_SPAN.min(end.max(1.0)), end.max(1.0));
        let frac = if b > a { (at - a) / (b - a) } else { 0.5 };
        self.set(at - span * frac, span, end);
    }

    /// Moves the view by `dt` seconds.
    pub fn pan(&mut self, dt: f64, end: f64) {
        let (a, b) = self.view.unwrap_or((0.0, end));
        self.set(a + dt, b - a, end);
    }

    fn set(&mut self, start: f64, span: f64, end: f64) {
        let start = start.clamp(0.0, (end - span).max(0.0));
        self.view = if span >= end - 1e-6 { None } else { Some((start, start + span)) };
    }
}

/// What a chart needs about the key it draws.
pub struct Series<'a> {
    pub key: &'a str,
    pub samples: &'a Samples,
    pub th: Option<Threshold>,
}

fn y_range(samples: &Samples, i0: usize, i1: usize, th: Option<Threshold>, key: &str) -> (f64, f64) {
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for (_, v) in samples.range(i0..i1) {
        lo = lo.min(*v as f64);
        hi = hi.max(*v as f64);
    }
    if lo > hi {
        return (0.0, 1.0);
    }
    // Rate-like keys with thresholds start at 0 so the guides read; sizes (memory) and keys
    // without thresholds zoom to the data.
    let zoom = th.is_none() || key.starts_with("mem.");
    if !zoom {
        lo = lo.clamp(-1e12, 0.0);
        if let Some(t) = th {
            let guide = t.amber.max(t.red);
            if guide <= hi * 3.0 + 1.0 {
                hi = hi.max(t.amber.min(t.red));
            }
        }
    }
    if zoom {
        let pad = ((hi - lo) * 0.1).max(hi.abs() * 0.01).max(0.5);
        lo = (lo - pad).max(if lo >= 0.0 { 0.0 } else { f64::MIN });
        hi += pad;
    } else {
        hi = (hi * 1.1).max(lo + 1.0);
    }
    (lo, hi)
}

/// Index range of `samples` inside `[a, b]` seconds.
fn visible(samples: &Samples, a: f64, b: f64) -> (usize, usize) {
    let i0 = samples.partition_point(|(t, _)| (*t as f64) < a).saturating_sub(1);
    let i1 = (samples.partition_point(|(t, _)| (*t as f64) <= b) + 1).min(samples.len());
    (i0, i1.max(i0))
}

/// Points of the visible samples, at most two per pixel column: `(x px, value, level)`.
fn decimate(samples: &Samples, i0: usize, i1: usize, x: impl Fn(f64) -> f32, width: f32, th: Option<Threshold>, out: &mut Vec<(f32, f32, u8)>) {
    out.clear();
    let n = i1 - i0;
    let level = |v: f32| th.map_or(0, |t| t.level(v as f64));
    if n <= (width as usize).max(1) * 2 {
        out.extend(samples.range(i0..i1).map(|(t, v)| (x(*t as f64), *v, level(*v))));
        return;
    }
    let mut col = i64::MIN;
    let mut bucket: Vec<(f32, f32)> = Vec::new();
    let flush = |bucket: &mut Vec<(f32, f32)>, out: &mut Vec<(f32, f32, u8)>| {
        if bucket.is_empty() {
            return;
        }
        let (mut lo, mut hi) = (bucket[0], bucket[0]);
        for p in bucket.iter() {
            if p.1 < lo.1 {
                lo = *p;
            }
            if p.1 > hi.1 {
                hi = *p;
            }
        }
        let (a, b) = if lo.0 <= hi.0 { (lo, hi) } else { (hi, lo) };
        out.push((x(a.0 as f64), a.1, level(a.1)));
        if (a.0, a.1) != (b.0, b.1) {
            out.push((x(b.0 as f64), b.1, level(b.1)));
        }
        bucket.clear();
    };
    for (t, v) in samples.range(i0..i1) {
        let c = x(*t as f64).floor() as i64;
        if c != col {
            flush(&mut bucket, out);
            col = c;
        }
        bucket.push((*t, *v));
    }
    flush(&mut bucket, out);
}

/// Pushes the line through `pts` coloured by level (a segment takes the worse end's colour).
fn line_shapes(painter: &egui::Painter, pts: &[(f32, f32, u8)], y: impl Fn(f32) -> f32, t: &Tokens, th: Option<Threshold>, width: f32) {
    if pts.is_empty() {
        return;
    }
    if pts.len() == 1 {
        painter.circle_filled(pos2(pts[0].0, y(pts[0].1)), width + 0.5, level_color(t, th, pts[0].2));
        return;
    }
    let mut cur_level = pts[0].2.max(pts[1].2);
    let mut path: Vec<Pos2> = vec![pos2(pts[0].0, y(pts[0].1))];
    for w in pts.windows(2) {
        let lvl = w[0].2.max(w[1].2);
        let p = pos2(w[1].0, y(w[1].1));
        if lvl != cur_level {
            let last = *path.last().unwrap_or(&p);
            painter.add(Shape::line(std::mem::take(&mut path), Stroke::new(width, level_color(t, th, cur_level))));
            path.push(last);
            cur_level = lvl;
        }
        path.push(p);
    }
    painter.add(Shape::line(path, Stroke::new(width, level_color(t, th, cur_level))));
}

fn nice_step(span: f64, target: usize) -> f64 {
    const STEPS: [f64; 14] = [1.0, 2.0, 5.0, 10.0, 15.0, 30.0, 60.0, 120.0, 300.0, 600.0, 900.0, 1800.0, 3600.0, 7200.0];
    let want = span / target.max(1) as f64;
    STEPS.iter().copied().find(|s| *s >= want).unwrap_or(7200.0)
}

/// The large interactive chart. `end` is the run's length in seconds.
#[allow(clippy::too_many_arguments)]
pub fn big_chart(
    ui: &mut egui::Ui,
    id: &str,
    series: &Series,
    events: &[ViewEvent],
    highlight: Option<f64>,
    end: f64,
    state: &mut ChartState,
    height: f32,
    t: &Tokens,
) {
    let end = end.max(1.0);
    let (resp, painter) = ui.allocate_painter(vec2(ui.available_width(), height), Sense::click_and_drag());
    let rect = resp.rect;
    painter.rect_filled(rect, t.radius.md(), t.surface.sunken);
    let plot = Rect::from_min_max(rect.min + vec2(52.0, 12.0), rect.max - vec2(10.0, 18.0));
    if plot.width() < 30.0 || plot.height() < 20.0 {
        return;
    }
    let small = FontId::proportional(t.type_scale.small);
    let (x0, x1) = state.view.unwrap_or((0.0, end));
    let span = (x1 - x0).max(1e-6);
    let from_x = |px: f32| x0 + ((px - plot.left()) / plot.width()) as f64 * span;

    // Interaction.
    let hover = resp.hover_pos().filter(|p| plot.contains(*p));
    if resp.dragged() {
        let dx = ui.input(|i| i.pointer.delta().x);
        if dx != 0.0 {
            state.pan(-(dx as f64) / plot.width() as f64 * span, end);
        }
    }
    if resp.hovered() {
        let (zoom, sx) = ui.input(|i| (i.zoom_delta(), i.smooth_scroll_delta.x));
        if zoom != 1.0 {
            let at = hover.map_or((x0 + x1) / 2.0, |p| from_x(p.x));
            state.zoom(at, zoom as f64, end);
        }
        if sx != 0.0 {
            state.pan(-(sx as f64) / plot.width() as f64 * span, end);
        }
        ui.ctx().set_cursor_icon(if resp.dragged() { egui::CursorIcon::Grabbing } else { egui::CursorIcon::Crosshair });
    }
    if resp.double_clicked() {
        state.view = None;
    }
    let (x0, x1) = state.view.unwrap_or((0.0, end));
    let span = (x1 - x0).max(1e-6);
    let to_x = |tt: f64| plot.left() + ((tt - x0) / span) as f32 * plot.width();
    let from_x = |px: f32| x0 + ((px - plot.left()) / plot.width()) as f64 * span;

    let (i0, i1) = visible(series.samples, x0, x1);
    let (lo, hi) = y_range(series.samples, i0, i1, series.th, series.key);
    let to_y = |v: f32| plot.bottom() - ((v as f64 - lo) / (hi - lo).max(1e-9)) as f32 * plot.height();

    // Grid, axis labels.
    let grid = Stroke::new(1.0, t.separator);
    for k in 0..=3 {
        let v = lo + (hi - lo) * k as f64 / 3.0;
        let y = to_y(v as f32);
        painter.hline(plot.x_range(), y, grid);
        painter.text(pos2(plot.left() - 6.0, y), Align2::RIGHT_CENTER, num(v), small.clone(), t.text.secondary);
    }
    let step = nice_step(span, (plot.width() / 90.0) as usize);
    let mut tick = (x0 / step).ceil() * step;
    while tick <= x1 + 1e-9 {
        let x = to_x(tick);
        painter.vline(x, plot.y_range(), Stroke::new(1.0, t.separator.gamma_multiply(0.6)));
        painter.text(pos2(x, plot.bottom() + 3.0), Align2::CENTER_TOP, clock(tick), small.clone(), t.text.secondary);
        tick += step;
    }

    // Threshold guides.
    if let Some(th) = series.th {
        for (lim, c) in [(th.amber, t.status.warning), (th.red, t.status.danger)] {
            if lim > lo && lim < hi {
                let y = to_y(lim as f32);
                painter.extend(Shape::dashed_line(&[pos2(plot.left(), y), pos2(plot.right(), y)], Stroke::new(1.0, c.gamma_multiply(0.7)), 5.0, 4.0));
            }
        }
    }

    // Highlighted moment (from the Events tab or an issue).
    if let Some(h) = highlight.filter(|h| *h >= x0 && *h <= x1) {
        let x = to_x(h);
        painter.rect_filled(Rect::from_min_max(pos2(x - 3.0, plot.top()), pos2(x + 3.0, plot.bottom())), 0.0, t.accent.gamma_multiply(0.25));
        painter.vline(x, plot.y_range(), Stroke::new(1.5, t.accent));
    }

    // The line.
    let mut pts = Vec::new();
    decimate(series.samples, i0, i1, to_x, plot.width(), series.th, &mut pts);
    let clipped = painter.with_clip_rect(plot.expand(2.0));
    line_shapes(&clipped, &pts, to_y, t, series.th, 1.6);

    // Event markers: incidents red full height, hitches amber, the rest dim ticks.
    let mut near: Option<(&ViewEvent, f32)> = None;
    for e in events.iter().filter(|e| e.t >= x0 && e.t <= x1) {
        let x = to_x(e.t);
        match e.kind {
            EventKind::Incident => {
                painter.vline(x, plot.y_range(), Stroke::new(1.5, t.status.danger));
                painter.add(Shape::convex_polygon(vec![pos2(x - 4.0, plot.top() - 7.0), pos2(x + 4.0, plot.top() - 7.0), pos2(x, plot.top() - 1.0)], t.status.danger, Stroke::NONE));
            }
            EventKind::Hitch => {
                painter.vline(x, plot.top()..=plot.top() + 12.0, Stroke::new(1.5, t.status.warning));
            }
            EventKind::Quality => {
                painter.vline(x, plot.top()..=plot.top() + 8.0, Stroke::new(1.0, t.status.info));
            }
            _ => {
                painter.vline(x, plot.top()..=plot.top() + 5.0, Stroke::new(1.0, t.text.disabled));
            }
        }
        if let Some(p) = hover {
            let d = (p.x - x).abs();
            if d < 6.0 && p.y < plot.top() + 40.0 && near.is_none_or(|(_, best)| d < best) {
                near = Some((e, d));
            }
        }
    }

    // Hover: crosshair, dot and tooltip.
    if let Some(p) = hover {
        let tt = from_x(p.x);
        painter.vline(p.x, plot.y_range(), Stroke::new(1.0, t.text.secondary.gamma_multiply(0.8)));
        let k = series.samples.partition_point(|(s, _)| (*s as f64) < tt);
        let pick = [k.saturating_sub(1), k.min(series.samples.len().saturating_sub(1))]
            .into_iter()
            .filter_map(|i| series.samples.get(i).copied())
            .min_by(|a, b| (a.0 as f64 - tt).abs().total_cmp(&(b.0 as f64 - tt).abs()));
        if let Some((st, sv)) = pick {
            let c = level_color(t, series.th, series.th.map_or(0, |th| th.level(sv as f64)));
            let dot = pos2(to_x(st as f64), to_y(sv));
            painter.circle(dot, 4.0, c, Stroke::new(1.5, t.surface.sunken));
            let near_ev = near.map(|(e, _)| e);
            egui::Tooltip::for_widget(&resp).at_pointer().gap(12.0).show(|ui| {
                if let Some(e) = near_ev {
                    ui.label(egui::RichText::new(e.name.clone()).strong());
                    ui.label(format!("{} into the run", clock(e.t)));
                    let d = e.detail();
                    if !d.is_empty() {
                        ui.label(d);
                    }
                } else {
                    ui.label(egui::RichText::new(with_unit(series.key, sv as f64)).strong().color(c));
                    ui.label(format!("at {}", clock(st as f64)));
                }
            });
        }
    }

    // Caption: zoom state.
    if state.is_zoomed() {
        painter.text(pos2(plot.right() - 4.0, plot.top() + 2.0), Align2::RIGHT_TOP, "zoomed · double-click to reset", small, t.text.secondary);
    }
    let _ = id;
}

/// A small line over the whole run in `rect`, for list rows. `time` is the span `(from, to)`.
pub fn sparkline(painter: &egui::Painter, rect: Rect, series: &Series, level: u8, time: (f64, f64), t: &Tokens) {
    let inner = rect.shrink2(vec2(1.0, 3.0));
    let (a, b) = (time.0, time.1.max(time.0 + 1.0));
    let (i0, i1) = visible(series.samples, a, b);
    if i1 - i0 < 2 {
        painter.hline(inner.x_range(), inner.center().y, Stroke::new(1.0, t.separator));
        return;
    }
    let (lo, hi) = y_range(series.samples, i0, i1, series.th, series.key);
    let x = |tt: f64| inner.left() + ((tt - a) / (b - a)) as f32 * inner.width();
    let y = |v: f32| inner.bottom() - ((v as f64 - lo) / (hi - lo).max(1e-9)) as f32 * inner.height();
    let mut pts = Vec::new();
    decimate(series.samples, i0, i1, x, inner.width(), None, &mut pts);
    let path: Vec<Pos2> = pts.iter().map(|(px, v, _)| pos2(*px, y(*v))).collect();
    if let Some(th) = series.th {
        for (lim, c) in [(th.amber, t.status.warning), (th.red, t.status.danger)] {
            if lim > lo && lim < hi {
                painter.hline(inner.x_range(), y(lim as f32), Stroke::new(1.0, c.gamma_multiply(0.25)));
            }
        }
    }
    painter.add(Shape::line(path, Stroke::new(1.3, level_color(t, series.th, level))));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(n: usize) -> Samples {
        (0..n).map(|i| (i as f32, (i % 50) as f32)).collect()
    }

    #[test]
    fn zoom_and_pan_stay_inside_the_run() {
        let mut s = ChartState::default();
        s.zoom(50.0, 4.0, 100.0);
        let (a, b) = s.view.unwrap();
        assert!((b - a - 25.0).abs() < 1e-6 && a >= 0.0 && b <= 100.0, "{a} {b}");
        s.pan(1000.0, 100.0);
        assert_eq!(s.view.map(|v| v.1), Some(100.0));
        s.pan(-1000.0, 100.0);
        assert_eq!(s.view.map(|v| v.0), Some(0.0));
        s.zoom(10.0, 0.01, 100.0);
        assert_eq!(s.view, None, "zooming all the way out resets");
    }

    #[test]
    fn decimation_keeps_spikes_and_bounds_points() {
        let mut v: Samples = (0..20_000).map(|i| (i as f32, 1.0)).collect();
        v[12_345].1 = 99.0;
        let mut out = Vec::new();
        decimate(&v, 0, v.len(), |t| (t / 20.0) as f32, 1000.0, None, &mut out);
        assert!(out.len() <= 2100, "{}", out.len());
        assert!(out.iter().any(|p| p.1 == 99.0), "spike kept");
        let s = samples(10);
        decimate(&s, 0, 10, |t| t as f32, 100.0, None, &mut out);
        assert_eq!(out.len(), 10, "short series untouched");
    }

    #[test]
    fn visible_range_and_y_range() {
        let s = samples(100);
        let (i0, i1) = visible(&s, 10.0, 20.0);
        assert!(i0 <= 10 && (21..=22).contains(&i1), "{i0} {i1}");
        let (lo, hi) = y_range(&s, 0, 100, Some(Threshold { amber: 16.7, red: 33.3 }), "frame.ms");
        assert!(lo <= 0.0 && hi >= 49.0, "{lo} {hi}");
        let (lo, hi) = y_range(&s, 0, 0, None, "x");
        assert_eq!((lo, hi), (0.0, 1.0));
    }
}
