//! Texture cook: turns each `assets/textures/<set>/` PBR set (color/normal/rough/ao JPGs) into
//! GPU-compressed KTX2 files the engine loads straight into VRAM, with no CPU copy or CPU mips:
//!
//! - `color.ktx2`  BC7 sRGB; mips filtered in linear light (gamma-space averaging darkens
//!   distant surfaces).
//! - `normal.ktx2` BC5 (RG; the shader rebuilds Z); mips renormalised (averaged normals get
//!   short and shade flat/sparkly).
//! - `orm.ktx2`    BC5: R = ambient occlusion (white if the set has none), G = roughness. Used
//!   for both the occlusion and metallic-roughness slots (metallic is 0, so B is unused).
//! - `color.avg`   the colour map's average in linear light ("r g b"), for far-detail tints.
//!
//! Alpha (foliage cards, leaves, grass): taken from the colour map's own alpha, or from a
//! separate `alpha.jpg/png` (grey, white = opaque) when the set has one. A set with any alpha
//! < 255 is encoded with BC7's alpha mode, and each mip's alpha is rescaled so the share of
//! texels at or above the 0.5 cutoff matches the base level (plain averaging thins cutout
//! foliage until it vanishes in the distance). `color.avg` then averages only opaque-ish texels.
//!
//! Every level is zstd-supercompressed. About 4x less VRAM and texture bandwidth than RGBA8,
//! and loading skips JPEG decode + CPU mip generation.
//!
//!   memgate -- cargo run --manifest-path <engine>/tools/cook/Cargo.toml -- assets/textures [--only SET] [--force]
//!
//! Unchanged sets (outputs newer than every source) are skipped unless `--force`.

use std::path::{Path, PathBuf};

use image::{GrayImage, RgbImage, RgbaImage};
use intel_tex_2::{RgSurface, RgbaSurface, bc5, bc7};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(root) = args.first().map(PathBuf::from) else {
        eprintln!("usage: cook <assets/textures> [--only SET] [--force]");
        std::process::exit(2);
    };
    let only = args.iter().position(|a| a == "--only").and_then(|i| args.get(i + 1)).cloned();
    let force = args.iter().any(|a| a == "--force");
    let mut sets: Vec<PathBuf> = std::fs::read_dir(&root)
        .expect("read texture root")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("color.jpg").exists() || p.join("color.png").exists())
        .collect();
    sets.sort();
    let (mut cooked, mut skipped) = (0, 0);
    for set in sets {
        let name = set.file_name().unwrap().to_string_lossy().to_string();
        if only.as_ref().is_some_and(|o| *o != name) {
            continue;
        }
        if !force && up_to_date(&set) {
            skipped += 1;
            continue;
        }
        let t = std::time::Instant::now();
        let bytes = cook_set(&set);
        cooked += 1;
        println!("{name}: {:.1} MB in {:.1} s", bytes as f64 / 1e6, t.elapsed().as_secs_f32());
    }
    println!("cooked {cooked}, up to date {skipped}");
}

fn source(set: &Path, map: &str) -> Option<PathBuf> {
    ["jpg", "png"].iter().map(|e| set.join(format!("{map}.{e}"))).find(|p| p.exists())
}

fn up_to_date(set: &Path) -> bool {
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let newest_src = ["color", "alpha", "normal", "rough", "ao"].iter().filter_map(|m| source(set, m)).filter_map(|p| mtime(&p)).max();
    let outs = ["color.ktx2", "normal.ktx2", "orm.ktx2", "color.avg"];
    let oldest_out = outs.iter().map(|m| mtime(&set.join(m))).collect::<Option<Vec<_>>>().and_then(|v| v.into_iter().min());
    matches!((newest_src, oldest_out), (Some(s), Some(o)) if o >= s)
}

/// Cooks one set; returns bytes written.
fn cook_set(set: &Path) -> usize {
    let mut total = 0;
    let mut color = image::open(source(set, "color").unwrap()).expect("color").to_rgba8();
    if let Some(p) = source(set, "alpha") {
        let (w, h) = color.dimensions();
        let a = image::open(p).expect("alpha").to_luma8();
        let a = if a.dimensions() == (w, h) { a } else { image::imageops::resize(&a, w, h, image::imageops::FilterType::Triangle) };
        for (x, y, px) in color.enumerate_pixels_mut() {
            px[3] = a.get_pixel(x, y)[0];
        }
    }
    let has_alpha = color.pixels().any(|p| p[3] < 255);
    let mut levels = color_mips(&color);
    if has_alpha {
        preserve_coverage(&mut levels, ALPHA_CUTOFF);
    }
    total += write_ktx2(&set.join("color.ktx2"), VK_BC7_SRGB, &levels, |img| encode_bc7(img, has_alpha));
    // Linear-light average colour: the engine tints far-detail versions with it (BC7 has no CPU
    // pixels to average at load).
    let avg = average_linear(&color);
    std::fs::write(set.join("color.avg"), format!("{:.4} {:.4} {:.4}\n", avg[0], avg[1], avg[2])).expect("write color.avg");

    if let Some(p) = source(set, "normal") {
        let n = image::open(p).expect("normal").to_rgb8();
        let levels = normal_mips(&n);
        total += write_ktx2(&set.join("normal.ktx2"), VK_BC5_UNORM, &levels, encode_bc5);
    }

    let (w, h) = color.dimensions();
    let gray = |map: &str, fill: u8| -> GrayImage {
        match source(set, map) {
            Some(p) => {
                let g = image::open(p).expect(map).to_luma8();
                if g.dimensions() == (w, h) { g } else { image::imageops::resize(&g, w, h, image::imageops::FilterType::Triangle) }
            }
            None => GrayImage::from_pixel(w, h, image::Luma([fill])),
        }
    };
    let (ao, rough) = (gray("ao", 255), gray("rough", 200));
    let mut orm = RgbaImage::new(w, h);
    for (x, y, px) in orm.enumerate_pixels_mut() {
        *px = image::Rgba([ao.get_pixel(x, y)[0], rough.get_pixel(x, y)[0], 0, 255]);
    }
    let levels = linear_mips(&orm);
    total += write_ktx2(&set.join("orm.ktx2"), VK_BC5_UNORM, &levels, encode_bc5);
    total
}

// ---------------------------------------------------------------- mips

fn srgb_to_linear(c: u8) -> f32 {
    let c = c as f32 / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(c: f32) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let s = if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0 + 0.5) as u8
}

/// Halve an RGBA float image with a 2x2 box (dimensions at least 1).
fn halve(src: &[[f32; 4]], w: u32, h: u32) -> (Vec<[f32; 4]>, u32, u32) {
    let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
    let mut out = vec![[0.0; 4]; (nw * nh) as usize];
    for y in 0..nh {
        for x in 0..nw {
            let mut acc = [0.0; 4];
            let mut n = 0.0;
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let (sx, sy) = ((x * 2 + dx).min(w - 1), (y * 2 + dy).min(h - 1));
                let p = src[(sy * w + sx) as usize];
                for c in 0..4 {
                    acc[c] += p[c];
                }
                n += 1.0;
            }
            out[(y * nw + x) as usize] = acc.map(|v| v / n);
        }
    }
    (out, nw, nh)
}

/// Generic chain: `decode` turns a pixel into the space to average in, `fix` adjusts the averaged
/// value (e.g. renormalise), `encode` turns it back into RGBA8.
fn chain(w: u32, h: u32, base: Vec<[f32; 4]>, fix: impl Fn([f32; 4]) -> [f32; 4], encode: impl Fn([f32; 4]) -> [u8; 4]) -> Vec<RgbaImage> {
    let mut levels = Vec::new();
    let (mut cur, mut cw, mut ch) = (base, w, h);
    loop {
        let mut img = RgbaImage::new(cw, ch);
        for (i, px) in img.pixels_mut().enumerate() {
            *px = image::Rgba(encode(cur[i]));
        }
        levels.push(img);
        if cw == 1 && ch == 1 {
            break;
        }
        let (n, nw, nh) = halve(&cur, cw, ch);
        cur = n.into_iter().map(&fix).collect();
        (cw, ch) = (nw, nh);
    }
    levels
}

/// Alpha-weighted, so the transparent part of a foliage card doesn't tint the average.
fn average_linear(img: &RgbaImage) -> [f32; 3] {
    let (mut acc, mut n) = ([0.0f64; 3], 0.0f64);
    for p in img.pixels() {
        let a = p[3] as f64 / 255.0;
        for c in 0..3 {
            acc[c] += srgb_to_linear(p[c]) as f64 * a;
        }
        n += a;
    }
    acc.map(|v| (v / n.max(1e-6)) as f32)
}

/// Bevy's default `AlphaMode::Mask` cutoff.
const ALPHA_CUTOFF: f32 = 0.5;

fn coverage(img: &RgbaImage, cutoff: u8, scale: f32) -> f32 {
    let n = img.pixels().filter(|p| (p[3] as f32 * scale).min(255.0) >= cutoff as f32).count();
    n as f32 / (img.width() * img.height()).max(1) as f32
}

/// Rescales each mip's alpha so its alpha-test coverage matches the base level's.
fn preserve_coverage(levels: &mut [RgbaImage], cutoff: f32) {
    let cut = (cutoff * 255.0).round() as u8;
    let target = coverage(&levels[0], cut, 1.0);
    for img in levels.iter_mut().skip(1) {
        let (mut lo, mut hi) = (0.0f32, 16.0f32);
        for _ in 0..20 {
            let mid = 0.5 * (lo + hi);
            if coverage(img, cut, mid) < target { lo = mid } else { hi = mid }
        }
        let s = hi;
        for p in img.pixels_mut() {
            p[3] = (p[3] as f32 * s).min(255.0).round() as u8;
        }
    }
}

fn color_mips(img: &RgbaImage) -> Vec<RgbaImage> {
    let (w, h) = img.dimensions();
    let base = img.pixels().map(|p| [srgb_to_linear(p[0]), srgb_to_linear(p[1]), srgb_to_linear(p[2]), p[3] as f32 / 255.0]).collect();
    chain(w, h, base, |v| v, |v| [linear_to_srgb(v[0]), linear_to_srgb(v[1]), linear_to_srgb(v[2]), (v[3] * 255.0 + 0.5) as u8])
}

fn normal_mips(img: &RgbImage) -> Vec<RgbaImage> {
    let (w, h) = img.dimensions();
    let unit = |v: [f32; 4]| {
        let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-6);
        [v[0] / l, v[1] / l, v[2] / l, 1.0]
    };
    let base = img.pixels().map(|p| unit([p[0] as f32 / 127.5 - 1.0, p[1] as f32 / 127.5 - 1.0, p[2] as f32 / 127.5 - 1.0, 1.0])).collect();
    let enc = |v: f32| ((v * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    chain(w, h, base, unit, |v| [enc(v[0]), enc(v[1]), enc(v[2]), 255])
}

fn linear_mips(img: &RgbaImage) -> Vec<RgbaImage> {
    let (w, h) = img.dimensions();
    let base = img.pixels().map(|p| p.0.map(|c| c as f32 / 255.0)).collect();
    chain(w, h, base, |v| v, |v| v.map(|c| (c.clamp(0.0, 1.0) * 255.0 + 0.5) as u8))
}

// ---------------------------------------------------------------- BC encode

/// BC encoders work on whole 4x4 blocks: pad small or odd levels by clamping to the edge.
fn padded(img: &RgbaImage) -> RgbaImage {
    let (w, h) = img.dimensions();
    let (pw, ph) = (w.div_ceil(4) * 4, h.div_ceil(4) * 4);
    if (pw, ph) == (w, h) {
        return img.clone();
    }
    RgbaImage::from_fn(pw, ph, |x, y| *img.get_pixel(x.min(w - 1), y.min(h - 1)))
}

fn encode_bc7(img: &RgbaImage, alpha: bool) -> Vec<u8> {
    let p = padded(img);
    let surf = RgbaSurface { data: p.as_raw(), width: p.width(), height: p.height(), stride: p.width() * 4 };
    let settings = if alpha { bc7::alpha_basic_settings() } else { bc7::opaque_basic_settings() };
    bc7::compress_blocks(&settings, &surf)
}

fn encode_bc5(img: &RgbaImage) -> Vec<u8> {
    let p = padded(img);
    let rg: Vec<u8> = p.pixels().flat_map(|px| [px[0], px[1]]).collect();
    let surf = RgSurface { data: &rg, width: p.width(), height: p.height(), stride: p.width() * 2 };
    bc5::compress_blocks(&surf)
}

// ---------------------------------------------------------------- KTX2

const VK_BC5_UNORM: u32 = 141;
const VK_BC7_SRGB: u32 = 146;
const ZSTD: u32 = 2;

/// Basic data format descriptor for a BC5 (two 64-bit channels) or BC7 (one 128-bit) block.
fn dfd(vk: u32) -> Vec<u8> {
    // (colour model, transfer function, samples as (bit offset, bit length - 1, channel))
    let (model, transfer, samples): (u8, u8, &[(u16, u8, u8)]) = match vk {
        VK_BC7_SRGB => (134, 2, &[(0, 127, 0)]),
        _ => (132, 1, &[(0, 63, 0), (64, 63, 1)]),
    };
    let block = 24 + 16 * samples.len() as u32;
    let mut d = Vec::new();
    d.extend((4 + block).to_le_bytes()); // dfdTotalSize
    d.extend(0u32.to_le_bytes()); // vendorId 0 (Khronos), descriptorType 0 (basic)
    d.extend((2u32 | (block << 16)).to_le_bytes()); // versionNumber 2, descriptorBlockSize
    d.extend([model, 1, transfer, 0]); // model, BT.709 primaries, transfer, flags
    d.extend([3, 3, 0, 0]); // 4x4x1x1 texel block (stored minus one)
    d.extend([16, 0, 0, 0, 0, 0, 0, 0]); // bytes per plane
    for &(offset, len, channel) in samples {
        d.extend(offset.to_le_bytes());
        d.extend([len, channel]);
        d.extend([0, 0, 0, 0]); // sample position
        d.extend(0u32.to_le_bytes()); // lower
        d.extend(u32::MAX.to_le_bytes()); // upper
    }
    d
}

/// Writes a 2D KTX2 with every level zstd-supercompressed; returns the file size.
fn write_ktx2(path: &Path, vk: u32, levels: &[RgbaImage], encode: impl Fn(&RgbaImage) -> Vec<u8>) -> usize {
    let raw: Vec<Vec<u8>> = levels.iter().map(&encode).collect();
    let packed: Vec<Vec<u8>> = raw.iter().map(|r| zstd::bulk::compress(r, 19).expect("zstd")).collect();
    let n = levels.len() as u32;
    let dfd = dfd(vk);
    let header_len = 80 + 24 * n as usize;
    let dfd_off = header_len;
    let data_off = dfd_off + dfd.len();
    let mut out = Vec::new();
    out.extend([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]);
    let (w, h) = levels[0].dimensions();
    for v in [vk, 1, w, h, 0, 0, 1, n, ZSTD] {
        out.extend(v.to_le_bytes());
    }
    out.extend((dfd_off as u32).to_le_bytes());
    out.extend((dfd.len() as u32).to_le_bytes());
    out.extend(0u32.to_le_bytes()); // kvd offset
    out.extend(0u32.to_le_bytes()); // kvd length
    out.extend(0u64.to_le_bytes()); // sgd offset
    out.extend(0u64.to_le_bytes()); // sgd length
    // Level data is stored smallest first; the index lists level 0 first.
    let mut offsets = vec![0usize; levels.len()];
    let mut at = data_off;
    for i in (0..levels.len()).rev() {
        offsets[i] = at;
        at += packed[i].len();
    }
    for i in 0..levels.len() {
        out.extend((offsets[i] as u64).to_le_bytes());
        out.extend((packed[i].len() as u64).to_le_bytes());
        out.extend((raw[i].len() as u64).to_le_bytes());
    }
    out.extend(&dfd);
    for p in packed.iter().rev() {
        out.extend(p);
    }
    std::fs::write(path, &out).expect("write ktx2");
    out.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mip_chain_reaches_one_pixel_and_normals_stay_unit() {
        let img = RgbImage::from_fn(8, 4, |x, _| if x % 2 == 0 { image::Rgb([255, 128, 128]) } else { image::Rgb([0, 128, 128]) });
        let levels = normal_mips(&img);
        assert_eq!(levels.len(), 4); // 8x4, 4x2, 2x1, 1x1
        assert_eq!(levels.last().unwrap().dimensions(), (1, 1));
        // +X and -X average to zero length; renormalising must not leave a near-zero vector.
        let p = levels[1].get_pixel(0, 0);
        let v = [p[0], p[1], p[2]].map(|c| c as f32 / 127.5 - 1.0);
        let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        assert!(len > 0.9, "{v:?}");
    }

    #[test]
    fn color_mips_average_in_linear_light() {
        // Black and white average to linear 0.5 = sRGB ~188, not the gamma-space 128.
        let img = RgbaImage::from_fn(2, 1, |x, _| if x == 0 { image::Rgba([0, 0, 0, 255]) } else { image::Rgba([255, 255, 255, 255]) });
        let levels = color_mips(&img);
        assert!((185..=190).contains(&levels[1].get_pixel(0, 0)[0]));
    }

    #[test]
    fn mip_coverage_matches_the_base_level() {
        // A sparse cutout: 1 texel in 4 opaque. Plain averaging gives 0.25 alpha at level 1,
        // which would test away entirely.
        let img = RgbaImage::from_fn(16, 16, |x, y| image::Rgba([40, 120, 30, if x % 2 == 0 && y % 2 == 0 { 255 } else { 0 }]));
        let mut levels = color_mips(&img);
        assert!(coverage(&levels[1], 128, 1.0) < 0.01);
        preserve_coverage(&mut levels, 0.5);
        for l in &levels[1..levels.len() - 1] {
            let c = coverage(l, 128, 1.0);
            assert!(c >= 0.25 - 0.01, "coverage {c}");
        }
    }

    #[test]
    fn alpha_survives_bc7() {
        let img = RgbaImage::from_fn(8, 8, |x, _| image::Rgba([200, 200, 200, if x < 4 { 0 } else { 255 }]));
        let blocks = encode_bc7(&img, true);
        let opaque = encode_bc7(&img, false);
        assert_ne!(blocks, opaque);
    }

    #[test]
    fn ktx2_header_and_level_index_are_consistent() {
        let levels = linear_mips(&RgbaImage::from_pixel(8, 8, image::Rgba([10, 200, 0, 255])));
        let dir = std::env::temp_dir().join(format!("cook-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.ktx2");
        write_ktx2(&path, VK_BC5_UNORM, &levels, encode_bc5);
        let b = std::fs::read(&path).unwrap();
        let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let u64_at = |o: usize| u64::from_le_bytes(b[o..o + 8].try_into().unwrap()) as usize;
        assert_eq!(&b[..12], &[0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(u32_at(12), VK_BC5_UNORM);
        assert_eq!(u32_at(40), 4); // 8, 4, 2, 1
        for i in 0..4 {
            let (off, len, raw) = (u64_at(80 + 24 * i), u64_at(88 + 24 * i), u64_at(96 + 24 * i));
            let dec = zstd::bulk::decompress(&b[off..off + len], raw).unwrap();
            let blocks = ((8 >> i).max(1usize).div_ceil(4)).pow(2);
            assert_eq!(dec.len(), blocks * 16, "level {i}");
        }
        std::fs::remove_dir_all(dir).ok();
    }
}
