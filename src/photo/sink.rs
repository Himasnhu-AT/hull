//! Where a finished photo goes. The engine ships a PNG writer; games (or the platform module's
//! user folders) implement [`PhotoSink`] for their own layout.

use std::path::{Path, PathBuf};

use bevy::image::Image;

use super::PhotoTaken;

/// Saves a photo; returns where it went.
pub trait PhotoSink: Send + Sync + 'static {
    fn save(&self, photo: &PhotoTaken) -> Result<PathBuf, String>;
}

/// Writes `photo-<id>.png` into `dir`, with the metadata JSON in a `engine.photo` tEXt chunk.
#[derive(Clone, Debug)]
pub struct PngFileSink {
    pub dir: PathBuf,
    /// File name prefix.
    pub prefix: String,
}

impl PngFileSink {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        PngFileSink { dir: dir.into(), prefix: "photo".into() }
    }
}

impl PhotoSink for PngFileSink {
    fn save(&self, photo: &PhotoTaken) -> Result<PathBuf, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let path = self.dir.join(format!("{}-{:04}.png", self.prefix, photo.metadata.id));
        let json = serde_json::to_string(&photo.metadata).map_err(|e| e.to_string())?;
        write_png(&path, &photo.image, &[("engine.photo", &json)])?;
        Ok(path)
    }
}

/// Writes an 8-bit RGBA(8) image as PNG with tEXt chunks. Handles `Rgba8*` and `Bgra8*` data.
pub fn write_png(path: &Path, image: &Image, text: &[(&str, &str)]) -> Result<(), String> {
    use bevy::render::render_resource::TextureFormat as F;
    let (w, h) = (image.width(), image.height());
    let data = image.data.as_ref().ok_or("image has no CPU data")?;
    if data.len() < (w * h * 4) as usize {
        return Err(format!("unexpected image data: {} bytes for {w}x{h}", data.len()));
    }
    let bgra = matches!(image.texture_descriptor.format, F::Bgra8Unorm | F::Bgra8UnormSrgb);
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    for (k, v) in text {
        enc.add_text_chunk((*k).to_string(), (*v).to_string()).map_err(|e| e.to_string())?;
    }
    let mut writer = enc.write_header().map_err(|e| e.to_string())?;
    // Photos are opaque: write RGB.
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for px in data.chunks_exact(4).take((w * h) as usize) {
        if bgra {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        } else {
            rgb.extend_from_slice(&px[..3]);
        }
    }
    writer.write_image_data(&rgb).map_err(|e| e.to_string())
}

/// Reads a tEXt chunk back (tests, tools).
pub fn read_png_text(path: &Path, key: &str) -> Option<String> {
    let dec = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).ok()?));
    let reader = dec.read_info().ok()?;
    reader.info().uncompressed_latin1_text.iter().find(|c| c.keyword == key).map(|c| c.text.clone())
}
