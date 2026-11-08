//! Image files with embedded metadata, no extra crates.
//!
//! PNG: `tEXt` chunks (arbitrary key/value, Latin-1 keys up to 79 chars; values are written as
//! UTF-8 inside an `iTXt` chunk so any text survives). JPEG: `COM` comment segments holding
//! `key=value` lines. Both are added to bytes you already have ([`png_add_text`],
//! [`jpeg_add_comments`]) and read back ([`png_read_text`], [`jpeg_read_comments`]). Encoding a
//! PNG from RGBA pixels is [`encode_png`] (the `image` crate, already built).

use std::io::Cursor;

const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 12);
    out.extend((body.len() as u32).to_be_bytes());
    out.extend(kind);
    out.extend(body);
    let mut crc_in = kind.to_vec();
    crc_in.extend(body);
    out.extend(crc32(&crc_in).to_be_bytes());
    out
}

/// Encodes `rgba` (8 bit, `w * h * 4` bytes) as a PNG.
pub fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec()).ok_or("pixel buffer does not match the size")?;
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Inserts one `iTXt` chunk per pair right after `IHDR`. Keys must be 1..=79 chars without NUL.
pub fn png_add_text(png: &[u8], meta: &[(&str, &str)]) -> Result<Vec<u8>, String> {
    if png.len() < 33 || png[..8] != PNG_SIG || &png[12..16] != b"IHDR" {
        return Err("not a PNG".into());
    }
    let ihdr_end = 8 + 12 + u32::from_be_bytes(png[8..12].try_into().unwrap()) as usize;
    if png.len() < ihdr_end {
        return Err("truncated PNG".into());
    }
    let mut out = png[..ihdr_end].to_vec();
    for (k, v) in meta {
        if k.is_empty() || k.len() > 79 || k.contains('\0') {
            return Err(format!("bad metadata key `{k}`"));
        }
        // keyword NUL, compression flag 0, method 0, language "" NUL, translated keyword "" NUL, text
        let mut body = k.as_bytes().to_vec();
        body.extend([0, 0, 0, 0, 0]);
        body.extend(v.as_bytes());
        out.extend(chunk(b"iTXt", &body));
    }
    out.extend(&png[ihdr_end..]);
    Ok(out)
}

/// Every `tEXt` / uncompressed `iTXt` pair, in file order.
pub fn png_read_text(png: &[u8]) -> Vec<(String, String)> {
    let mut out = vec![];
    if png.len() < 8 || png[..8] != PNG_SIG {
        return out;
    }
    let mut i = 8;
    while i + 12 <= png.len() {
        let len = u32::from_be_bytes(png[i..i + 4].try_into().unwrap()) as usize;
        let kind = &png[i + 4..i + 8];
        let Some(body) = png.get(i + 8..i + 8 + len) else { break };
        if kind == b"tEXt" {
            if let Some(z) = body.iter().position(|&b| b == 0) {
                out.push((body[..z].iter().map(|&b| b as char).collect(), body[z + 1..].iter().map(|&b| b as char).collect()));
            }
        } else if kind == b"iTXt"
            && let Some(z) = body.iter().position(|&b| b == 0)
        {
            // flag, method, then language and translated keyword (both NUL-terminated)
            let rest = &body[z + 1..];
            if rest.len() >= 4 && rest[0] == 0 {
                let after_lang = rest[2..].iter().position(|&b| b == 0).map(|p| p + 3);
                let after_tk = after_lang.and_then(|a| rest[a..].iter().position(|&b| b == 0).map(|p| a + p + 1));
                if let Some(t) = after_tk {
                    out.push((String::from_utf8_lossy(&body[..z]).into(), String::from_utf8_lossy(&rest[t..]).into()));
                }
            }
        }
        if kind == b"IEND" {
            break;
        }
        i += 12 + len;
    }
    out
}

/// Inserts one `COM` segment per pair (`key=value`) right after `SOI`.
pub fn jpeg_add_comments(jpeg: &[u8], meta: &[(&str, &str)]) -> Result<Vec<u8>, String> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return Err("not a JPEG".into());
    }
    let mut out = vec![0xFF, 0xD8];
    for (k, v) in meta {
        if k.contains('=') || k.is_empty() {
            return Err(format!("bad metadata key `{k}`"));
        }
        let text = format!("{k}={v}");
        if text.len() > 65_533 {
            return Err("metadata value too long".into());
        }
        out.extend([0xFF, 0xFE]);
        out.extend((text.len() as u16 + 2).to_be_bytes());
        out.extend(text.as_bytes());
    }
    out.extend(&jpeg[2..]);
    Ok(out)
}

/// `COM` segments that look like `key=value`, in file order.
pub fn jpeg_read_comments(jpeg: &[u8]) -> Vec<(String, String)> {
    let mut out = vec![];
    let mut i = 2;
    while i + 4 <= jpeg.len() && jpeg[i] == 0xFF {
        let marker = jpeg[i + 1];
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if len < 2 || i + 2 + len > jpeg.len() {
            break;
        }
        if marker == 0xFE {
            let s = String::from_utf8_lossy(&jpeg[i + 4..i + 2 + len]).into_owned();
            if let Some((k, v)) = s.split_once('=') {
                out.push((k.to_string(), v.to_string()));
            }
        }
        i += 2 + len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> Vec<u8> {
        encode_png(&[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255], 2, 2).unwrap()
    }

    #[test]
    fn png_metadata_round_trips_and_still_decodes() {
        let meta = [("Title", "Dusk at the pass"), ("seed", "42"), ("note", "ünïcode ✓ \"quotes\"")];
        let png = png_add_text(&tiny(), &meta).unwrap();
        let back = png_read_text(&png);
        assert_eq!(back, meta.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>());
        let img = image::load_from_memory(&png).expect("still a valid PNG").to_rgba8();
        assert_eq!((img.width(), img.height()), (2, 2));
        assert_eq!(img.get_pixel(1, 0).0, [0, 255, 0, 255]);
        assert!(png_add_text(&tiny(), &[("", "x")]).is_err());
        assert!(png_add_text(b"nope", &[]).is_err());
    }

    #[test]
    fn reads_plain_text_chunks() {
        let base = tiny();
        let mut png = base[..33].to_vec();
        png.extend(chunk(b"tEXt", b"Author\0me"));
        png.extend(&base[33..]);
        assert_eq!(png_read_text(&png), vec![("Author".to_string(), "me".to_string())]);
    }

    #[test]
    fn jpeg_comments_round_trip() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0xFF, 0xD9];
        let out = jpeg_add_comments(&jpeg, &[("lens", "85mm"), ("iso", "200")]).unwrap();
        assert_eq!(jpeg_read_comments(&out), vec![("lens".to_string(), "85mm".to_string()), ("iso".to_string(), "200".to_string())]);
        assert_eq!(&out[out.len() - 6..], &jpeg[2..]);
    }
}
