//! Line charts drawn on the CPU into RGBA8 pixels for the metrics window (no Bevy).
//!
//! Time runs left → right over a fixed span ending now. Each column shows the min..max band of
//! the samples that fell in it (faint) and a line through their averages; columns with no
//! sample are bridged, so 1 Hz keys draw as a line too. Line colour follows the key's
//! threshold level (green / amber / red); dashed guides mark the amber and red levels.

use std::collections::VecDeque;

use super::metrics::Threshold;

/// Samples that fell into one column.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Col {
    pub min: f32,
    pub max: f32,
    pub avg: f32,
}

/// Bins `(t, v)` samples (sorted by t) into `n` columns covering `[t_end - span, t_end]`.
pub fn columns(samples: &VecDeque<(f32, f32)>, t_end: f32, span: f32, n: usize) -> Vec<Option<Col>> {
    let mut acc: Vec<(f32, f32, f32, u32)> = vec![(f32::INFINITY, f32::NEG_INFINITY, 0.0, 0); n];
    let t0 = t_end - span;
    let start = samples.partition_point(|&(t, _)| t < t0);
    for &(t, v) in samples.range(start..) {
        let i = (((t - t0) / span) * n as f32) as usize;
        let a = &mut acc[i.min(n - 1)];
        a.0 = a.0.min(v);
        a.1 = a.1.max(v);
        a.2 += v;
        a.3 += 1;
    }
    acc.into_iter()
        .map(|(lo, hi, sum, c)| (c > 0).then(|| Col { min: lo, max: hi, avg: sum / c as f32 }))
        .collect()
}

/// Y range for the chart: from 0 for timings and loads (so the amber line keeps its meaning),
/// zoomed to the data for everything else (memory, counts) so drifts and leaks show.
pub fn y_range(cols: &[Option<Col>], threshold: Option<Threshold>, zoom: bool) -> (f32, f32) {
    let (lo, hi) = cols
        .iter()
        .flatten()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), c| (lo.min(c.min), hi.max(c.max)));
    if !lo.is_finite() {
        return (0.0, 1.0);
    }
    if zoom {
        let pad = ((hi - lo) * 0.15).max(hi.abs() * 0.02).max(0.5);
        let lo = if lo >= 0.0 { (lo - pad).max(0.0) } else { lo - pad };
        return (lo, hi + pad);
    }
    let lo = lo.min(0.0);
    // Robust top: the highest average, or the 90th percentile of column peaks. A lone spike
    // (shader compile, a hitch) is clipped at the top edge instead of flattening the chart.
    let mut peaks: Vec<f32> = cols.iter().flatten().map(|c| c.max).collect();
    peaks.sort_unstable_by(f32::total_cmp);
    let p90 = peaks[((peaks.len() - 1) as f32 * 0.9).round() as usize];
    let avg_top = cols.iter().flatten().map(|c| c.avg).fold(f32::NEG_INFINITY, f32::max);
    let hi = p90.max(avg_top);
    let mut top = hi * 1.15;
    // Keep the amber guide in view when the data is near it (but don't flatten a quiet chart).
    if let Some(t) = threshold {
        let a = t.amber.min(t.red) as f32;
        if a > hi && a < hi * 2.5 {
            top = a * 1.1;
        }
    }
    if top <= lo {
        top = lo + 1.0;
    }
    (lo, top)
}

/// Pixel buffer to draw into (RGBA8, row-major, `w * h * 4` bytes).
pub struct Canvas<'a> {
    pub px: &'a mut [u8],
    pub w: usize,
    pub h: usize,
}

impl Canvas<'_> {
    pub fn clear(&mut self) {
        self.px.fill(0);
    }

    fn put(&mut self, x: usize, y: usize, c: [u8; 4]) {
        if x < self.w && y < self.h {
            let o = (y * self.w + x) * 4;
            self.px[o..o + 4].copy_from_slice(&c);
        }
    }

    /// Vertical run `[y0, y1]` (any order) at column x.
    fn vline(&mut self, x: usize, y0: f32, y1: f32, c: [u8; 4]) {
        let (a, b) = if y0 <= y1 { (y0, y1) } else { (y1, y0) };
        let a = a.floor().max(0.0) as usize;
        let b = (b.ceil() as usize).min(self.h.saturating_sub(1));
        for y in a..=b {
            self.put(x, y, c);
        }
    }

    fn dashed_hline(&mut self, y: f32, c: [u8; 4], dash: usize) {
        let y = y.round() as usize;
        for x in 0..self.w {
            if (x / dash).is_multiple_of(2) {
                self.put(x, y, c);
            }
        }
    }
}

/// How to draw one chart.
pub struct Style {
    /// Pixels per logical pixel (2 on a Retina screen).
    pub scale: f32,
    /// Colour of the line at threshold level 0 / 1 / 2 (or neutral keys: index 0).
    pub levels: [[u8; 4]; 3],
    pub guide_amber: [u8; 4],
    pub guide_red: [u8; 4],
    pub baseline: [u8; 4],
    /// Dashed amber / red level lines (off for sparklines).
    pub guides: bool,
}

/// Draws the columns (one column = `w / cols.len()` pixels) into `cv`.
pub fn draw(cv: &mut Canvas, cols: &[Option<Col>], range: (f32, f32), threshold: Option<Threshold>, s: &Style) {
    cv.clear();
    let (lo, hi) = range;
    let h = cv.h as f32;
    let y_of = |v: f32| (h - 1.0) - ((v - lo) / (hi - lo)).clamp(0.0, 1.0) * (h - 1.0);
    let level = |v: f32| threshold.map_or(0, |t| t.level(v as f64)) as usize;
    let dash = ((4.0 * s.scale) as usize).max(1);
    if lo < 0.0 && hi > 0.0 {
        cv.dashed_hline(y_of(0.0), s.baseline, dash);
    } else {
        cv.dashed_hline(h - 1.0, s.baseline, dash.max(1) * 64);
    }
    if let Some(t) = threshold.filter(|_| s.guides) {
        for (v, c) in [(t.amber, s.guide_amber), (t.red, s.guide_red)] {
            let v = v as f32;
            if v > lo && v < hi {
                cv.dashed_hline(y_of(v), c, dash);
            }
        }
    }
    let n = cols.len().max(1);
    let cw = cv.w as f32 / n as f32;
    let thick = (1.0 * s.scale).max(1.0);
    // Band.
    for (i, c) in cols.iter().enumerate() {
        let Some(c) = c else { continue };
        if c.max <= c.min {
            continue;
        }
        let mut band = s.levels[level(c.avg)];
        band[3] = 70;
        let (x0, x1) = ((i as f32 * cw) as usize, (((i + 1) as f32 * cw) as usize).max((i as f32 * cw) as usize + 1));
        for x in x0..x1.min(cv.w) {
            cv.vline(x, y_of(c.min), y_of(c.max), band);
        }
    }
    // Average line, bridging empty columns.
    let mut prev: Option<(f32, f32)> = None;
    for (i, c) in cols.iter().enumerate() {
        let Some(c) = c else { continue };
        let x = (i as f32 + 0.5) * cw;
        let y = y_of(c.avg);
        let color = s.levels[level(c.avg)];
        let (px, py) = prev.unwrap_or((x - cw * 0.5, y));
        let x_start = px.floor().max(0.0) as usize;
        let x_end = (x.ceil() as usize).min(cv.w.saturating_sub(1));
        for xi in x_start..=x_end {
            let f = if x > px { ((xi as f32 - px) / (x - px)).clamp(0.0, 1.0) } else { 1.0 };
            let f_next = if x > px { ((xi as f32 + 1.0 - px) / (x - px)).clamp(0.0, 1.0) } else { 1.0 };
            let ya = py + (y - py) * f;
            let yb = py + (y - py) * f_next;
            cv.vline(xi, ya - thick * 0.5, yb + thick * 0.5, color);
        }
        prev = Some((x, y));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style() -> Style {
        Style {
            scale: 1.0,
            levels: [[0, 255, 0, 255], [255, 200, 0, 255], [255, 0, 0, 255]],
            guide_amber: [255, 200, 0, 120],
            guide_red: [255, 0, 0, 120],
            baseline: [255, 255, 255, 30],
            guides: true,
        }
    }

    #[test]
    fn columns_bin_by_time() {
        let s: VecDeque<(f32, f32)> = [(0.5, 1.0), (9.1, 2.0), (9.6, 4.0), (10.0, 6.0)].into_iter().collect();
        let c = columns(&s, 10.0, 10.0, 10);
        assert_eq!(c[0], Some(Col { min: 1.0, max: 1.0, avg: 1.0 }));
        assert!(c[1..9].iter().all(Option::is_none));
        assert_eq!(c[9], Some(Col { min: 2.0, max: 6.0, avg: 4.0 }));
        // Samples older than the span are skipped.
        assert!(columns(&s, 30.0, 10.0, 5).iter().all(Option::is_none));
    }

    #[test]
    fn ranges() {
        let c = vec![Some(Col { min: 8.0, max: 12.0, avg: 10.0 })];
        let t = Threshold { amber: 16.7, red: 33.3 };
        assert_eq!(y_range(&c, Some(t), false).0, 0.0);
        assert!((y_range(&c, Some(t), false).1 - 16.7 * 1.1).abs() < 1e-3, "amber guide pulled into view");
        let (lo, hi) = y_range(&[Some(Col { min: 500.0, max: 510.0, avg: 505.0 })], None, true);
        assert!(lo > 400.0 && hi < 600.0, "zoomed: {lo}..{hi}");
        assert_eq!(y_range(&[None], None, false), (0.0, 1.0));
        // One spike among many quiet columns does not set the scale.
        let mut c = vec![Some(Col { min: 4.0, max: 6.0, avg: 5.0 }); 50];
        c[3] = Some(Col { min: 5.0, max: 700.0, avg: 300.0 });
        assert!(y_range(&c, None, false).1 < 400.0);
    }

    #[test]
    fn draws_line_in_level_colour() {
        let (w, h) = (20, 10);
        let mut px = vec![0u8; w * h * 4];
        let cols = vec![Some(Col { min: 5.0, max: 5.0, avg: 5.0 }); 4];
        let t = Threshold { amber: 16.7, red: 33.3 };
        draw(&mut Canvas { px: &mut px, w, h }, &cols, (0.0, 10.0), Some(t), &style());
        // A flat line at mid height, green.
        let at = |px: &[u8], x: usize, y: usize| px[(y * w + x) * 4..(y * w + x) * 4 + 4].to_vec();
        assert!((3..=5).any(|y| at(&px, 10, y) == [0, 255, 0, 255]), "green line near the middle");
        let red = vec![Some(Col { min: 40.0, max: 40.0, avg: 40.0 }); 4];
        draw(&mut Canvas { px: &mut px, w, h }, &red, (0.0, 50.0), Some(t), &style());
        assert!((0..h).any(|y| at(&px, 10, y) == [255, 0, 0, 255]), "red above the red level");
    }
}
