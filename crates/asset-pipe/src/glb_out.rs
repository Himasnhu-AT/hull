//! [`Model`] to a single `.glb` (one node per mesh, textures embedded). Bevy's glTF loader reads
//! it like any other model, so cooked LODs load through the normal asset path.

use serde_json::{Value, json};

use crate::Model;

struct Bin(Vec<u8>);

impl Bin {
    fn align(&mut self) {
        while !self.0.len().is_multiple_of(4) {
            self.0.push(0);
        }
    }
    fn view(&mut self, bytes: &[u8], target: Option<u32>, views: &mut Vec<Value>) -> usize {
        self.align();
        let mut v = json!({"buffer": 0, "byteOffset": self.0.len(), "byteLength": bytes.len()});
        if let Some(t) = target {
            v["target"] = t.into();
        }
        self.0.extend_from_slice(bytes);
        views.push(v);
        views.len() - 1
    }
}

fn f32s(v: impl Iterator<Item = f32>) -> Vec<u8> {
    v.flat_map(f32::to_le_bytes).collect()
}

pub fn write_glb(model: &Model) -> Vec<u8> {
    let mut bin = Bin(Vec::new());
    let (mut views, mut accessors, mut meshes, mut nodes) = (vec![], vec![], vec![], vec![]);
    for me in &model.meshes {
        if me.positions.is_empty() || me.indices.is_empty() {
            continue;
        }
        let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
        for p in &me.positions {
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        let mut acc = |bin: &mut Bin, bytes: Vec<u8>, target: u32, ct: u32, count: usize, ty: &str, minmax: Option<([f32; 3], [f32; 3])>| {
            let bv = bin.view(&bytes, Some(target), &mut views);
            let mut a = json!({"bufferView": bv, "componentType": ct, "count": count, "type": ty});
            if let Some((lo, hi)) = minmax {
                a["min"] = json!(lo);
                a["max"] = json!(hi);
            }
            accessors.push(a);
            accessors.len() - 1
        };
        let n = me.positions.len();
        let p = acc(&mut bin, f32s(me.positions.iter().flatten().copied()), 34962, 5126, n, "VEC3", Some((lo, hi)));
        let nrm = acc(&mut bin, f32s(me.normals.iter().flatten().copied()), 34962, 5126, n, "VEC3", None);
        let uv = acc(&mut bin, f32s(me.uvs.iter().flatten().copied()), 34962, 5126, n, "VEC2", None);
        let ix = acc(&mut bin, me.indices.iter().flat_map(|i| i.to_le_bytes()).collect(), 34963, 5125, me.indices.len(), "SCALAR", None);
        meshes.push(json!({"name": me.name, "primitives": [{"attributes": {"POSITION": p, "NORMAL": nrm, "TEXCOORD_0": uv}, "indices": ix, "material": me.material}]}));
        nodes.push(json!({"name": me.name, "mesh": meshes.len() - 1}));
    }
    // Images: embedded; a missing one (empty bytes) is left out and its textures dropped.
    let mut images = vec![];
    let mut image_index = vec![None; model.images.len()];
    for (i, im) in model.images.iter().enumerate() {
        if im.bytes.is_empty() {
            continue;
        }
        let bv = bin.view(&im.bytes, None, &mut views);
        images.push(json!({"name": im.name, "bufferView": bv, "mimeType": im.mime}));
        image_index[i] = Some(images.len() - 1);
    }
    let textures: Vec<Value> = (0..images.len()).map(|i| json!({"source": i})).collect();
    let tex = |t: Option<usize>| t.and_then(|i| image_index[i]).map(|s| json!({"index": s}));
    let materials: Vec<Value> = model
        .materials
        .iter()
        .map(|m| {
            let mut pbr = json!({"baseColorFactor": m.base_color, "metallicFactor": m.metallic, "roughnessFactor": m.roughness});
            if let Some(t) = tex(m.base_color_tex) {
                pbr["baseColorTexture"] = t;
            }
            if let Some(t) = tex(m.metal_rough_tex) {
                pbr["metallicRoughnessTexture"] = t;
            }
            let mut v = json!({"name": m.name, "pbrMetallicRoughness": pbr, "doubleSided": m.double_sided});
            if let Some(t) = tex(m.normal_tex) {
                v["normalTexture"] = t;
            }
            if let Some(c) = m.alpha_mask {
                v["alphaMode"] = "MASK".into();
                v["alphaCutoff"] = c.into();
            } else if m.alpha_blend {
                v["alphaMode"] = "BLEND".into();
            }
            v
        })
        .collect();
    bin.align();
    let mut root = json!({
        "asset": {"version": "2.0", "generator": "asset-pipe"},
        "scene": 0,
        "scenes": [{"nodes": (0..nodes.len()).collect::<Vec<_>>()}],
        "nodes": nodes, "meshes": meshes, "materials": materials,
        "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": bin.0.len()}],
    });
    if !images.is_empty() {
        root["images"] = images.into();
        root["textures"] = textures.into();
    }
    let mut json_bytes = serde_json::to_vec(&root).expect("json");
    while !json_bytes.len().is_multiple_of(4) {
        json_bytes.push(b' ');
    }
    let total = 12 + 8 + json_bytes.len() + 8 + bin.0.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&0x4E4F534Au32.to_le_bytes());
    out.extend_from_slice(&json_bytes);
    out.extend_from_slice(&(bin.0.len() as u32).to_le_bytes());
    out.extend_from_slice(&0x004E4942u32.to_le_bytes());
    out.extend_from_slice(&bin.0);
    out
}
