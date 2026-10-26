//! Asset checks: walk the assets folder and the game's sources, report problems as data.
//!
//! - **missing_ref** (error): a string literal in a source / data file names an asset path
//!   (`"textures/wall.png"`) that doesn't exist, or a glTF's `uri` points nowhere.
//! - **oversized** (error): a texture side above `max_texture_px`.
//! - **npot** (warning): a texture side that isn't a power of two (no mips on old paths,
//!   wasted memory when padded; fine for UI).
//! - **no_mips** (info): PNG/JPEG carry no mip chain; the engine builds one on the CPU at load
//!   (`gfx::PendingMips`). Cook to KTX2 (`scripts/cook.py`) to skip that work.
//! - **large_file** (warning): any asset above `max_file_mb`.
//! - **unreadable** (error): a texture whose header can't be parsed.
//! - **unreferenced** (info): files no scanned source mentions (paths built at runtime show up
//!   here too, so it's only a hint).
//!
//! Texture sizes come from file headers (PNG, JPEG, KTX2, DDS); nothing is decoded.
//! Runs as `cargo run --example asset_check -- <assets> [--src <dir>]...` (prints JSON, exits 1
//! on errors) and over the control port as `content.check {assets?, src?}`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

const TEXTURE_EXT: [&str; 5] = ["png", "jpg", "jpeg", "ktx2", "dds"];
const ASSET_EXT: [&str; 18] = [
    "png", "jpg", "jpeg", "ktx2", "dds", "hdr", "exr", "gltf", "glb", "ogg", "wav", "mp3", "flac", "ron", "json", "wgsl", "ttf", "otf",
];
const SOURCE_EXT: [&str; 6] = ["rs", "ron", "json", "toml", "gltf", "scn"];

#[derive(Clone, Debug)]
pub struct AssetCheckConfig {
    pub max_texture_px: u32,
    pub max_file_mb: f64,
    /// Report NPOT textures (warning).
    pub check_pot: bool,
    /// Folders scanned for asset references (relative to the cwd or absolute).
    pub sources: Vec<PathBuf>,
    /// Report unreferenced files (info).
    pub report_unreferenced: bool,
}

impl Default for AssetCheckConfig {
    fn default() -> Self {
        AssetCheckConfig { max_texture_px: 4096, max_file_mb: 64.0, check_pot: true, sources: vec![PathBuf::from("src")], report_unreferenced: true }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct AssetIssue {
    pub severity: Severity,
    pub kind: &'static str,
    /// Asset path relative to the assets folder.
    pub path: String,
    pub message: String,
    /// Where it was referenced (`src/game.rs:42`), for missing refs.
    pub at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TextureInfo {
    pub path: String,
    pub format: &'static str,
    pub width: u32,
    pub height: u32,
    pub mips: u32,
    pub bytes: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct AssetReport {
    pub assets_dir: String,
    pub files: usize,
    pub bytes: u64,
    pub textures: Vec<TextureInfo>,
    pub references: usize,
    pub issues: Vec<AssetIssue>,
    pub errors: usize,
    pub warnings: usize,
}

impl AssetReport {
    pub fn ok(&self) -> bool {
        self.errors == 0
    }
}

/// `(width, height, mips, format)` from a texture's header.
pub fn texture_header(bytes: &[u8]) -> Option<(u32, u32, u32, &'static str)> {
    let be32 = |o: usize| bytes.get(o..o + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let le32 = |o: usize| bytes.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((be32(16)?, be32(20)?, 1, "png"));
    }
    if bytes.starts_with(&[0xAB, b'K', b'T', b'X', b' ', b'2', b'0', 0xBB]) {
        return Some((le32(20)?, le32(24)?.max(1), le32(40)?.max(1), "ktx2"));
    }
    if bytes.starts_with(b"DDS ") {
        return Some((le32(16)?, le32(12)?, le32(28)?.max(1), "dds"));
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        // Walk JPEG segments to the first SOFn.
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let m = bytes[i + 1];
            if m == 0xD8 || m == 0x01 || (0xD0..=0xD7).contains(&m) || m == 0xFF {
                i += if m == 0xFF { 1 } else { 2 };
                continue;
            }
            let len = usize::from(u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]));
            if matches!(m, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
                let h = u32::from(u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]));
                let w = u32::from(u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]));
                return Some((w, h, 1, "jpeg"));
            }
            i += 2 + len;
        }
        return None;
    }
    None
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase()
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if name.starts_with('.') || name == "target" {
            continue;
        }
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// String literals in `text` that look like asset paths: `(line, path)`.
pub fn asset_refs(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for (ln, line) in text.lines().enumerate() {
        let mut rest = line;
        while let Some(start) = rest.find('"') {
            let after = &rest[start + 1..];
            let Some(end) = after.find('"') else { break };
            let lit = &after[..end];
            rest = &after[end + 1..];
            if lit.is_empty() || lit.len() > 256 || lit.contains(['{', '}', ' ', '*', '\\']) || lit.starts_with("http") {
                continue;
            }
            let lit = lit.strip_prefix("embedded://").unwrap_or(lit);
            // `path#Label` (glTF sub-assets).
            let lit = lit.split('#').next().unwrap_or(lit);
            let ext = Path::new(lit).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
            if ASSET_EXT.contains(&ext.as_str()) && (lit.contains('/') || ext != "json") {
                out.push((ln + 1, lit.to_string()));
            }
        }
    }
    out
}

/// Runs every check (see the module docs).
pub fn check_assets(assets: &Path, cfg: &AssetCheckConfig) -> AssetReport {
    let mut r = AssetReport { assets_dir: assets.display().to_string(), ..Default::default() };
    let mut files = Vec::new();
    walk(assets, &mut files);
    r.files = files.len();
    let issue = |r: &mut AssetReport, severity, kind, path: String, message: String, at: Option<String>| {
        r.issues.push(AssetIssue { severity, kind, path, message, at });
    };
    let present: BTreeSet<String> = files.iter().map(|p| rel(assets, p)).collect();
    let mut referenced: BTreeSet<String> = BTreeSet::new();

    for p in &files {
        let path = rel(assets, p);
        let bytes = std::fs::metadata(p).map_or(0, |m| m.len());
        r.bytes += bytes;
        if bytes as f64 > cfg.max_file_mb * 1024.0 * 1024.0 {
            issue(&mut r, Severity::Warning, "large_file", path.clone(), format!("{:.1} MB > {} MB", bytes as f64 / 1048576.0, cfg.max_file_mb), None);
        }
        let ext = ext_of(p);
        if TEXTURE_EXT.contains(&ext.as_str()) {
            let head = read_head(p, 64 * 1024);
            match texture_header(&head) {
                Some((w, h, mips, format)) => {
                    if w.max(h) > cfg.max_texture_px {
                        issue(&mut r, Severity::Error, "oversized", path.clone(), format!("{w}x{h} > {} px", cfg.max_texture_px), None);
                    }
                    if cfg.check_pot && (!w.is_power_of_two() || !h.is_power_of_two()) {
                        issue(&mut r, Severity::Warning, "npot", path.clone(), format!("{w}x{h} is not a power of two"), None);
                    }
                    let full = 32 - w.max(h).max(1).leading_zeros();
                    if mips < full && w.max(h) > 64 {
                        let note = if matches!(format, "png" | "jpeg") { "built on the CPU at load; cook to KTX2" } else { "incomplete mip chain" };
                        issue(&mut r, Severity::Info, "no_mips", path.clone(), format!("{mips}/{full} mips ({note})"), None);
                    }
                    r.textures.push(TextureInfo { path: path.clone(), format, width: w, height: h, mips, bytes });
                }
                None => issue(&mut r, Severity::Error, "unreadable", path.clone(), "unrecognised texture header".into(), None),
            }
        }
        if ext == "gltf"
            && let Ok(text) = std::fs::read_to_string(p)
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
        {
            let base = Path::new(&path).parent().unwrap_or(Path::new(""));
            for key in ["images", "buffers"] {
                for item in v.get(key).and_then(|a| a.as_array()).into_iter().flatten() {
                    let Some(uri) = item.get("uri").and_then(|u| u.as_str()) else { continue };
                    if uri.starts_with("data:") {
                        continue;
                    }
                    let target = rel(Path::new(""), &base.join(uri));
                    referenced.insert(target.clone());
                    if !present.contains(&target) {
                        issue(&mut r, Severity::Error, "missing_ref", target, format!("{key} uri `{uri}`"), Some(path.clone()));
                    }
                }
            }
        }
    }

    // Source / data references.
    let mut sources = Vec::new();
    for s in &cfg.sources {
        if s.is_file() {
            sources.push(s.clone());
        } else {
            walk(s, &mut sources);
        }
    }
    // Asset files that are themselves data (json/ron scenes) reference other assets too.
    sources.extend(files.iter().filter(|p| matches!(ext_of(p).as_str(), "ron" | "json" | "scn")).cloned());
    for src in sources.iter().filter(|p| SOURCE_EXT.contains(&ext_of(p).as_str())) {
        let Ok(text) = std::fs::read_to_string(src) else { continue };
        for (line, lit) in asset_refs(&text) {
            r.references += 1;
            let lit = lit.trim_start_matches("./").to_string();
            referenced.insert(lit.clone());
            if !present.contains(&lit) {
                issue(&mut r, Severity::Error, "missing_ref", lit.clone(), "referenced but not in the assets folder".into(), Some(format!("{}:{line}", src.display())));
            }
        }
    }
    if cfg.report_unreferenced {
        for p in &present {
            let in_gltf_dir = p.ends_with(".bin");
            if !referenced.contains(p) && !in_gltf_dir && ASSET_EXT.iter().any(|e| p.to_ascii_lowercase().ends_with(&format!(".{e}"))) {
                issue(&mut r, Severity::Info, "unreferenced", p.clone(), "no scanned source names this file".into(), None);
            }
        }
    }
    r.issues.sort_by(|a, b| b.severity.cmp(&a.severity).then_with(|| a.path.cmp(&b.path)));
    r.errors = r.issues.iter().filter(|i| i.severity == Severity::Error).count();
    r.warnings = r.issues.iter().filter(|i| i.severity == Severity::Warning).count();
    r
}

fn read_head(p: &Path, n: usize) -> Vec<u8> {
    use std::io::Read;
    let mut buf = Vec::with_capacity(n.min(4096));
    if let Ok(f) = std::fs::File::open(p) {
        let _ = f.take(n as u64).read_to_end(&mut buf);
    }
    buf
}

#[cfg(feature = "devtools")]
pub(super) fn register(app: &mut bevy::prelude::App) {
    use crate::devtools::{AddControlCommand, params};
    app.add_control_command(
        "content.check",
        "Validate assets: missing refs, oversized / NPOT textures, mips, big files",
        params(&[
            ("assets", "string", "assets folder (default: the game's AssetsDir)"),
            ("src", "array", "folders scanned for references (default [\"src\"])"),
            ("max_texture_px", "integer", "default 4096"),
            ("info", "boolean", "include info-level issues (default false)"),
        ]),
        |w, p| {
            let assets = match p.get("assets").and_then(|v| v.as_str()) {
                Some(a) => PathBuf::from(a),
                None => w.get_resource::<crate::paths::AssetsDir>().map(|a| a.0.clone()).ok_or("no AssetsDir; pass `assets`")?,
            };
            let mut cfg = AssetCheckConfig::default();
            if let Some(src) = p.get("src").and_then(|v| v.as_array()) {
                cfg.sources = src.iter().filter_map(|s| s.as_str()).map(PathBuf::from).collect();
            }
            if let Some(m) = p.get("max_texture_px").and_then(|v| v.as_u64()) {
                cfg.max_texture_px = m as u32;
            }
            let mut r = check_assets(&assets, &cfg);
            if p.get("info").and_then(|v| v.as_bool()) != Some(true) {
                r.issues.retain(|i| i.severity != Severity::Info);
            }
            serde_json::to_value(&r).map_err(|e| e.to_string())
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_jpeg_ktx2_headers() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&300u32.to_be_bytes());
        png.extend_from_slice(&256u32.to_be_bytes());
        assert_eq!(texture_header(&png), Some((300, 256, 1, "png")));
        // JPEG: SOI, APP0 (len 4), SOF0 h=64 w=128.
        let jpg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 17, 8, 0, 64, 0, 128, 3, 0, 0, 0, 0];
        assert_eq!(texture_header(&jpg), Some((128, 64, 1, "jpeg")));
        let mut ktx = vec![0xAB, b'K', b'T', b'X', b' ', b'2', b'0', 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
        ktx.resize(48, 0);
        ktx[20..24].copy_from_slice(&512u32.to_le_bytes());
        ktx[24..28].copy_from_slice(&512u32.to_le_bytes());
        ktx[40..44].copy_from_slice(&10u32.to_le_bytes());
        assert_eq!(texture_header(&ktx), Some((512, 512, 10, "ktx2")));
        assert_eq!(texture_header(b"nope"), None);
    }

    #[test]
    fn refs_in_source() {
        let src = r#"let a = server.load("textures/wall.png"); let b = "scene.gltf#Scene0"; let c = format!("{x}.png"); let d = "Cargo.json";"#;
        let refs: Vec<String> = asset_refs(src).into_iter().map(|(_, s)| s).collect();
        assert_eq!(refs, vec!["textures/wall.png", "scene.gltf"]);
    }
}
