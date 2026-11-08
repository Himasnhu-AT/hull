//! glTF 2.0 / GLB reader into a [`Model`]: node transforms are baked in, only triangle
//! primitives are read, textures are loaded as encoded bytes. Sparse accessors and
//! quantisation / Draco extensions are refused with a clear message (export plain glTF).

use std::path::{Path, PathBuf};

use glam::{Mat4, Quat, Vec3};
use serde_json::Value;

use crate::{ImageData, MaterialData, MeshData, Model};

/// What the reader noticed (missing files etc.); stages add their own issues later.
#[derive(Debug, Default)]
pub struct ReadReport {
    pub warnings: Vec<String>,
}

pub fn read_file(path: &Path) -> Result<(Model, ReadReport), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    read_bytes(&bytes, path.parent(), &name)
}

pub fn read_bytes(bytes: &[u8], dir: Option<&Path>, name: &str) -> Result<(Model, ReadReport), String> {
    let (json, glb_bin) = if bytes.starts_with(b"glTF") { split_glb(bytes)? } else { (bytes, None) };
    let j: Value = serde_json::from_slice(json).map_err(|e| format!("glTF json: {e}"))?;
    let mut report = ReadReport::default();
    if let Some(req) = j.get("extensionsRequired").and_then(Value::as_array) {
        let names: Vec<&str> = req.iter().filter_map(Value::as_str).collect();
        if !names.is_empty() {
            return Err(format!("glTF requires unsupported extensions: {}", names.join(", ")));
        }
    }
    let buffers = load_buffers(&j, dir, glb_bin)?;
    let mut model = Model { name: name.to_string(), ..Default::default() };

    // Images and materials first (primitives refer to them by index).
    for (i, img) in arr(&j, "images").iter().enumerate() {
        let iname = img.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("image{i}"));
        let (bytes, mime) = match load_image(&j, img, dir, &buffers) {
            Ok(v) => v,
            Err(e) => {
                report.warnings.push(format!("image {iname}: {e}"));
                (Vec::new(), String::new())
            }
        };
        model.images.push(ImageData { name: iname, bytes, mime });
    }
    let tex_source = |t: Option<&Value>| -> Option<usize> {
        let idx = t?.get("index")?.as_u64()? as usize;
        arr(&j, "textures").get(idx)?.get("source")?.as_u64().map(|s| s as usize)
    };
    for (i, m) in arr(&j, "materials").iter().enumerate() {
        let pbr = m.get("pbrMetallicRoughness");
        let g = |k: &str| pbr.and_then(|p| p.get(k));
        let mut md = MaterialData { name: m.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("material{i}")), ..Default::default() };
        if let Some(c) = g("baseColorFactor").and_then(Value::as_array) {
            for (k, v) in c.iter().take(4).enumerate() {
                md.base_color[k] = v.as_f64().unwrap_or(1.0) as f32;
            }
        }
        md.base_color_tex = tex_source(g("baseColorTexture"));
        md.metal_rough_tex = tex_source(g("metallicRoughnessTexture"));
        md.normal_tex = tex_source(m.get("normalTexture"));
        md.metallic = g("metallicFactor").and_then(Value::as_f64).unwrap_or(1.0) as f32;
        md.roughness = g("roughnessFactor").and_then(Value::as_f64).unwrap_or(1.0) as f32;
        md.double_sided = m.get("doubleSided").and_then(Value::as_bool).unwrap_or(false);
        match m.get("alphaMode").and_then(Value::as_str) {
            Some("MASK") => md.alpha_mask = Some(m.get("alphaCutoff").and_then(Value::as_f64).unwrap_or(0.5) as f32),
            Some("BLEND") => md.alpha_blend = true,
            _ => {}
        }
        model.materials.push(md);
    }
    let default_material = model.materials.len();

    // Nodes: the default scene's roots, else every root node.
    let nodes = arr(&j, "nodes");
    let roots: Vec<usize> = match j.get("scenes").and_then(|s| s.get(j.get("scene").and_then(Value::as_u64).unwrap_or(0) as usize)).and_then(|s| s.get("nodes")).and_then(Value::as_array) {
        Some(r) => r.iter().filter_map(|v| v.as_u64().map(|x| x as usize)).collect(),
        None => {
            let children: Vec<usize> = nodes.iter().flat_map(|n| arr(n, "children").iter().filter_map(|c| c.as_u64().map(|x| x as usize))).collect();
            (0..nodes.len()).filter(|i| !children.contains(i)).collect()
        }
    };
    let mut used_default = false;
    let mut stack: Vec<(usize, Mat4)> = roots.into_iter().rev().map(|r| (r, Mat4::IDENTITY)).collect();
    let mut visited = 0usize;
    while let Some((ni, parent)) = stack.pop() {
        visited += 1;
        if visited > nodes.len() * 4 + 16 {
            return Err("glTF node graph has a cycle".into());
        }
        let n = nodes.get(ni).ok_or_else(|| format!("node {ni} out of range"))?;
        let world = parent * node_matrix(n);
        if let Some(mi) = n.get("mesh").and_then(Value::as_u64) {
            let mesh = arr(&j, "meshes").get(mi as usize).ok_or("mesh out of range")?;
            for (pi, prim) in arr(mesh, "primitives").iter().enumerate() {
                if prim.get("mode").and_then(Value::as_u64).unwrap_or(4) != 4 {
                    report.warnings.push(format!("mesh {mi} primitive {pi}: not a triangle list, skipped"));
                    continue;
                }
                let mut me = read_primitive(&j, &buffers, prim)?;
                me.name = format!("{}.{pi}", mesh.get("name").and_then(Value::as_str).unwrap_or("mesh"));
                me.material = match prim.get("material").and_then(Value::as_u64) {
                    Some(m) => m as usize,
                    None => {
                        used_default = true;
                        default_material
                    }
                };
                let mut one = Model { meshes: vec![me], ..Default::default() };
                one.transform(world);
                model.meshes.append(&mut one.meshes);
            }
        }
        for c in arr(n, "children").iter().rev() {
            if let Some(c) = c.as_u64() {
                stack.push((c as usize, world));
            }
        }
    }
    if used_default {
        model.materials.push(MaterialData::default());
    }
    for me in &mut model.meshes {
        if me.material >= model.materials.len() {
            return Err(format!("mesh {}: material {} out of range", me.name, me.material));
        }
    }
    Ok((model, report))
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn node_matrix(n: &Value) -> Mat4 {
    if let Some(m) = n.get("matrix").and_then(Value::as_array)
        && m.len() == 16
    {
        let mut a = [0f32; 16];
        for (i, v) in m.iter().enumerate() {
            a[i] = v.as_f64().unwrap_or(0.0) as f32;
        }
        return Mat4::from_cols_array(&a);
    }
    let f = |k: &str, d: &[f32]| -> Vec<f32> {
        n.get(k).and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect()).filter(|v: &Vec<f32>| v.len() == d.len()).unwrap_or_else(|| d.to_vec())
    };
    let t = f("translation", &[0.0; 3]);
    let r = f("rotation", &[0.0, 0.0, 0.0, 1.0]);
    let s = f("scale", &[1.0; 3]);
    Mat4::from_scale_rotation_translation(Vec3::new(s[0], s[1], s[2]), Quat::from_xyzw(r[0], r[1], r[2], r[3]).normalize(), Vec3::new(t[0], t[1], t[2]))
}

fn split_glb(b: &[u8]) -> Result<(&[u8], Option<&[u8]>), String> {
    if b.len() < 20 {
        return Err("GLB too short".into());
    }
    let u32_at = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize;
    let (mut json, mut bin) = (None, None);
    let mut off = 12;
    while off + 8 <= b.len() {
        let (len, ty) = (u32_at(off), u32_at(off + 4));
        let end = off + 8 + len;
        if end > b.len() {
            return Err("GLB chunk runs past the file".into());
        }
        match ty {
            0x4E4F534A => json = Some(&b[off + 8..end]),
            0x004E4942 if bin.is_none() => bin = Some(&b[off + 8..end]),
            _ => {}
        }
        off = end;
    }
    Ok((json.ok_or("GLB has no JSON chunk")?, bin))
}

fn load_buffers(j: &Value, dir: Option<&Path>, glb_bin: Option<&[u8]>) -> Result<Vec<Vec<u8>>, String> {
    let mut out = vec![];
    for (i, b) in arr(j, "buffers").iter().enumerate() {
        match b.get("uri").and_then(Value::as_str) {
            Some(uri) => out.push(read_uri(uri, dir).map_err(|e| format!("buffer {i}: {e}"))?),
            None => out.push(glb_bin.ok_or_else(|| format!("buffer {i} has no uri and the file has no GLB chunk"))?.to_vec()),
        }
    }
    Ok(out)
}

fn read_uri(uri: &str, dir: Option<&Path>) -> Result<Vec<u8>, String> {
    if let Some(rest) = uri.strip_prefix("data:") {
        let (_, data) = rest.split_once(";base64,").ok_or("only base64 data URIs are supported")?;
        return base64(data);
    }
    let rel = percent_decode(uri);
    if rel.contains("..") || rel.starts_with('/') {
        return Err(format!("uri `{uri}` leaves the model folder"));
    }
    let p: PathBuf = dir.unwrap_or(Path::new(".")).join(rel);
    std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

pub(crate) fn base64(s: &str) -> Result<Vec<u8>, String> {
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|c| *c != b'=' && !c.is_ascii_whitespace()) {
        acc = (acc << 6) | val(c).ok_or("bad base64")?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

fn load_image(j: &Value, img: &Value, dir: Option<&Path>, buffers: &[Vec<u8>]) -> Result<(Vec<u8>, String), String> {
    let mime_of = |bytes: &[u8]| if bytes.starts_with(&[0x89, b'P']) { "image/png" } else { "image/jpeg" }.to_string();
    if let Some(uri) = img.get("uri").and_then(Value::as_str) {
        let bytes = read_uri(uri, dir)?;
        let m = mime_of(&bytes);
        return Ok((bytes, m));
    }
    let bv = img.get("bufferView").and_then(Value::as_u64).ok_or("image has neither uri nor bufferView")? as usize;
    let v = arr(j, "bufferViews").get(bv).ok_or("bufferView out of range")?;
    let buf = buffers.get(v.get("buffer").and_then(Value::as_u64).unwrap_or(0) as usize).ok_or("buffer out of range")?;
    let off = v.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let len = v.get("byteLength").and_then(Value::as_u64).ok_or("bufferView without byteLength")? as usize;
    let bytes = buf.get(off..off + len).ok_or("image bufferView runs past its buffer")?.to_vec();
    let m = mime_of(&bytes);
    Ok((bytes, m))
}

/// `(values as f32, components)` of an accessor (normalised integers are mapped to 0..1 / -1..1).
fn accessor(j: &Value, buffers: &[Vec<u8>], idx: usize) -> Result<(Vec<f32>, usize), String> {
    let a = arr(j, "accessors").get(idx).ok_or_else(|| format!("accessor {idx} out of range"))?;
    if a.get("sparse").is_some() {
        return Err("sparse accessors are not supported".into());
    }
    let count = a.get("count").and_then(Value::as_u64).ok_or("accessor without count")? as usize;
    let comps = match a.get("type").and_then(Value::as_str) {
        Some("SCALAR") => 1,
        Some("VEC2") => 2,
        Some("VEC3") => 3,
        Some("VEC4") => 4,
        t => return Err(format!("accessor type {t:?} not supported")),
    };
    let ct = a.get("componentType").and_then(Value::as_u64).ok_or("accessor without componentType")?;
    let (size, norm_div): (usize, f32) = match ct {
        5120 => (1, 127.0),
        5121 => (1, 255.0),
        5122 => (2, 32767.0),
        5123 => (2, 65535.0),
        5125 => (4, 1.0),
        5126 => (4, 1.0),
        _ => return Err(format!("componentType {ct} not supported")),
    };
    let normalized = a.get("normalized").and_then(Value::as_bool).unwrap_or(false);
    let Some(bvi) = a.get("bufferView").and_then(Value::as_u64) else { return Ok((vec![0.0; count * comps], comps)) };
    let bv = arr(j, "bufferViews").get(bvi as usize).ok_or("bufferView out of range")?;
    let buf = buffers.get(bv.get("buffer").and_then(Value::as_u64).unwrap_or(0) as usize).ok_or("buffer out of range")?;
    let base = bv.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize + a.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let stride = bv.get("byteStride").and_then(Value::as_u64).map(|s| s as usize).unwrap_or(size * comps);
    let mut out = Vec::with_capacity(count * comps);
    for i in 0..count {
        for c in 0..comps {
            let o = base + i * stride + c * size;
            let b = buf.get(o..o + size).ok_or("accessor runs past its buffer")?;
            let v = match ct {
                5120 => b[0] as i8 as f32,
                5121 => b[0] as f32,
                5122 => i16::from_le_bytes([b[0], b[1]]) as f32,
                5123 => u16::from_le_bytes([b[0], b[1]]) as f32,
                5125 => u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32,
                _ => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            };
            out.push(if normalized { (v / norm_div).max(-1.0) } else { v });
        }
    }
    Ok((out, comps))
}

fn read_primitive(j: &Value, buffers: &[Vec<u8>], prim: &Value) -> Result<MeshData, String> {
    let attrs = prim.get("attributes").ok_or("primitive without attributes")?;
    let get = |k: &str| attrs.get(k).and_then(Value::as_u64).map(|i| i as usize);
    let (pos, pc) = accessor(j, buffers, get("POSITION").ok_or("primitive without POSITION")?)?;
    if pc != 3 {
        return Err("POSITION is not VEC3".into());
    }
    let mut me = MeshData { positions: pos.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect(), ..Default::default() };
    let n = me.positions.len();
    if let Some(i) = get("NORMAL") {
        let (v, _) = accessor(j, buffers, i)?;
        me.normals = v.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    }
    if let Some(i) = get("TEXCOORD_0") {
        let (v, _) = accessor(j, buffers, i)?;
        me.uvs = v.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
    } else {
        me.uvs = vec![[0.0; 2]; n];
    }
    me.indices = match prim.get("indices").and_then(Value::as_u64) {
        Some(i) => accessor(j, buffers, i as usize)?.0.into_iter().map(|v| v as u32).collect(),
        None => (0..n as u32).collect(),
    };
    if me.normals.len() != n {
        me.compute_normals();
    }
    if me.uvs.len() != n {
        me.uvs.resize(n, [0.0; 2]);
    }
    Ok(me)
}
