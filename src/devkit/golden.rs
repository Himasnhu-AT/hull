//! Golden images: compare a screenshot against a blessed PNG with a perceptual tolerance.
//!
//! Per pixel the difference is measured in YIQ space (luma weighted ~2× chroma, the same idea
//! as pixelmatch), normalised to 0..1. A pixel "differs" above `pixel_threshold`; the image
//! fails when more than `max_diff_ratio` of its pixels differ (anti-aliasing / TAA jitter
//! noise stays under it). On failure a diff PNG is written next to the actual image: the
//! golden in grey, differing pixels in red.
//!
//! ```ignore
//! let shot = take_offscreen_screenshot(..);              // e.g. via scripts/play.py
//! let r = assert_golden(&shot, "tests/golden/menu.png", &GoldenOptions::default());
//! ```
//!
//! `ENGINE_BLESS=1` (or a missing golden) writes the actual image as the new golden.

use std::path::{Path, PathBuf};

use image::{Rgba, RgbaImage};
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct GoldenOptions {
    /// Per-pixel YIQ distance (0..1) above which a pixel counts as different.
    pub pixel_threshold: f32,
    /// Fraction of differing pixels allowed (0.002 = 0.2 %).
    pub max_diff_ratio: f32,
    /// Write `<actual>.diff.png` on failure.
    pub write_diff: bool,
    /// Missing golden → write it and pass (first run). Default true.
    pub bless_missing: bool,
}

impl Default for GoldenOptions {
    fn default() -> Self {
        GoldenOptions { pixel_threshold: 0.1, max_diff_ratio: 0.002, write_diff: true, bless_missing: true }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GoldenResult {
    pub pass: bool,
    pub width: u32,
    pub height: u32,
    pub diff_pixels: u64,
    pub diff_ratio: f32,
    /// Largest per-pixel distance (0..1).
    pub max_delta: f32,
    pub diff_image: Option<PathBuf>,
    /// The golden was (re)written from the actual image.
    pub blessed: bool,
    pub note: String,
}

/// YIQ distance between two RGB pixels, 0..1.
pub fn pixel_delta(a: [u8; 4], b: [u8; 4]) -> f32 {
    // Blend alpha onto white so transparent pixels compare sensibly.
    let blend = |p: [u8; 4]| {
        let a = f32::from(p[3]) / 255.0;
        [0, 1, 2].map(|i| 255.0 + (f32::from(p[i]) - 255.0) * a)
    };
    let (pa, pb) = (blend(a), blend(b));
    let yiq = |p: [f32; 3]| {
        (
            p[0] * 0.298_895_3 + p[1] * 0.586_622_5 + p[2] * 0.114_482_2,
            p[0] * 0.595_977_9 - p[1] * 0.274_176_3 - p[2] * 0.321_801_6,
            p[0] * 0.211_470_2 - p[1] * 0.522_617_4 + p[2] * 0.311_147_2,
        )
    };
    let (y1, i1, q1) = yiq(pa);
    let (y2, i2, q2) = yiq(pb);
    let (dy, di, dq) = (y1 - y2, i1 - i2, q1 - q2);
    let d = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
    // 35215 = max possible d (black vs white).
    (d / 35215.0).sqrt().min(1.0)
}

/// Compares two images in memory. Sizes must match.
pub fn compare_images(actual: &RgbaImage, golden: &RgbaImage, opts: &GoldenOptions) -> (GoldenResult, Option<RgbaImage>) {
    let (w, h) = actual.dimensions();
    if golden.dimensions() != (w, h) {
        let r = GoldenResult {
            pass: false,
            width: w,
            height: h,
            diff_pixels: u64::from(w) * u64::from(h),
            diff_ratio: 1.0,
            max_delta: 1.0,
            diff_image: None,
            blessed: false,
            note: format!("size {w}x{h} != golden {}x{}", golden.width(), golden.height()),
        };
        return (r, None);
    }
    let mut diff = opts.write_diff.then(|| RgbaImage::new(w, h));
    let mut n = 0u64;
    let mut max_delta = 0f32;
    for (x, y, pa) in actual.enumerate_pixels() {
        let pg = golden.get_pixel(x, y);
        let d = if pa == pg { 0.0 } else { pixel_delta(pa.0, pg.0) };
        max_delta = max_delta.max(d);
        let over = d > opts.pixel_threshold;
        n += u64::from(over);
        if let Some(img) = diff.as_mut() {
            let px = if over {
                Rgba([255, 0, 0, 255])
            } else {
                let l = (f32::from(pg.0[0]) * 0.3 + f32::from(pg.0[1]) * 0.59 + f32::from(pg.0[2]) * 0.11) as u8;
                let l = 128 + l / 2; // faded
                Rgba([l, l, l, 255])
            };
            img.put_pixel(x, y, px);
        }
    }
    let total = (u64::from(w) * u64::from(h)).max(1);
    let ratio = n as f32 / total as f32;
    let pass = ratio <= opts.max_diff_ratio;
    let r = GoldenResult { pass, width: w, height: h, diff_pixels: n, diff_ratio: ratio, max_delta, diff_image: None, blessed: false, note: String::new() };
    (r, if pass { None } else { diff })
}

fn load(path: &Path) -> Result<RgbaImage, String> {
    image::open(path).map(|i| i.to_rgba8()).map_err(|e| format!("{}: {e}", path.display()))
}

fn bless_env() -> bool {
    std::env::var_os("ENGINE_BLESS").is_some_and(|v| v != "0" && !v.is_empty())
}

/// Compares the PNG at `actual` with the golden at `golden` (see the module docs).
pub fn check_golden(actual: &Path, golden: &Path, opts: &GoldenOptions) -> Result<GoldenResult, String> {
    let img = load(actual)?;
    if bless_env() || (opts.bless_missing && !golden.exists()) {
        if let Some(d) = golden.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        img.save(golden).map_err(|e| e.to_string())?;
        let (w, h) = img.dimensions();
        return Ok(GoldenResult {
            pass: true,
            width: w,
            height: h,
            diff_pixels: 0,
            diff_ratio: 0.0,
            max_delta: 0.0,
            diff_image: None,
            blessed: true,
            note: format!("wrote golden {}", golden.display()),
        });
    }
    let (mut r, diff) = compare_images(&img, &load(golden)?, opts);
    if let Some(d) = diff {
        let mut p = actual.as_os_str().to_owned();
        p.push(".diff.png");
        let p = PathBuf::from(p);
        d.save(&p).map_err(|e| e.to_string())?;
        r.diff_image = Some(p);
    }
    Ok(r)
}

/// [`check_golden`] that panics with a readable message (for `#[test]`s).
pub fn assert_golden(actual: impl AsRef<Path>, golden: impl AsRef<Path>, opts: &GoldenOptions) -> GoldenResult {
    let (a, g) = (actual.as_ref(), golden.as_ref());
    let r = check_golden(a, g, opts).unwrap_or_else(|e| panic!("golden {}: {e}", g.display()));
    assert!(
        r.pass,
        "{} differs from golden {}: {} px ({:.3} % > {:.3} %), max delta {:.2}{}; diff: {:?}. Re-bless with ENGINE_BLESS=1.",
        a.display(),
        g.display(),
        r.diff_pixels,
        r.diff_ratio * 100.0,
        opts.max_diff_ratio * 100.0,
        r.max_delta,
        if r.note.is_empty() { String::new() } else { format!(" ({})", r.note) },
        r.diff_image,
    );
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba(f(x, y)))
    }

    #[test]
    fn delta_bounds() {
        assert_eq!(pixel_delta([10, 20, 30, 255], [10, 20, 30, 255]), 0.0);
        assert!(pixel_delta([0, 0, 0, 255], [255, 255, 255, 255]) > 0.9);
        assert!(pixel_delta([100, 100, 100, 255], [102, 101, 100, 255]) < 0.02, "tiny change is tiny");
    }

    #[test]
    fn tolerance_and_diff_image() {
        let g = img(100, 100, |x, _| [(x * 2) as u8, 50, 90, 255]);
        // Noise: ±2 on every pixel → passes.
        let noisy = img(100, 100, |x, y| [(x * 2) as u8 + ((x + y) % 3) as u8, 50, 90, 255]);
        let (r, d) = compare_images(&noisy, &g, &GoldenOptions::default());
        assert!(r.pass && d.is_none(), "{r:?}");
        // A 10×10 white square (1 %) → fails, diff marks exactly those pixels.
        let broken = img(100, 100, |x, y| if x < 10 && y < 10 { [255; 4] } else { [(x * 2) as u8, 50, 90, 255] });
        let (r, d) = compare_images(&broken, &g, &GoldenOptions::default());
        assert!(!r.pass);
        assert_eq!(r.diff_pixels, 100);
        let d = d.expect("diff image");
        assert_eq!(d.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_ne!(d.get_pixel(50, 50).0, [255, 0, 0, 255]);
        // Size mismatch fails.
        assert!(!compare_images(&img(10, 10, |_, _| [0; 4]), &g, &GoldenOptions::default()).0.pass);
    }

    #[test]
    fn files_bless_then_compare() {
        let dir = std::env::temp_dir().join(format!("engine-golden-unit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.png");
        img(8, 8, |_, _| [10, 200, 30, 255]).save(&a).unwrap();
        let g = dir.join("golden/a.png");
        let r = check_golden(&a, &g, &GoldenOptions::default()).unwrap();
        assert!(r.blessed && g.exists());
        img(8, 8, |_, _| [250, 0, 0, 255]).save(&a).unwrap();
        let r = check_golden(&a, &g, &GoldenOptions::default()).unwrap();
        assert!(!r.pass);
        assert!(r.diff_image.as_ref().is_some_and(|p| p.exists()));
        let _ = std::fs::remove_dir_all(dir);
    }
}
