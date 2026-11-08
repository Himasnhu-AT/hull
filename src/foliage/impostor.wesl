// Foliage impostors (`foliage/mod.rs`): one quad per instance, merged per chunk, turned about the
// vertical to face the camera (a cylindrical billboard: never seen edge-on, unlike crossed
// cards). The atlas holds `frames` pictures of the plant seen from evenly spaced azimuths (frame
// i from azimuth i/frames * 2pi, measured from +Z towards +X in the plant's own frame); one frame
// is a plain billboard. Every vertex of an instance carries the instance's base point
// (POSITION), the corner in the frame (UV_0, 0..1; the instance's yaw is packed in as
// `u + 2 * q`, q = yaw in 256ths of a turn), the corner offset in metres (UV_1: x across, y up)
// and the tint (COLOR).
//
// Each instance fades in by itself at the near LOD's range end and out at the view distance with
// the same 4x4 dither and level mapping as Bevy's `VisibilityRange` (measured from the same LOD
// eye to the same point, the instance's base), so the near entity fading out and this quad fading
// in cover complementary pixels: no gap, no double draw. WESL (Bevy 0.20).
import bevy_pbr::render::{
    mesh_functions,
    mesh_view_bindings::view,
    forward_io::{Vertex, VertexOutput, FragmentOutput, decompress_vertex},
    view_transformations::position_world_to_clip,
    pbr_fragment::pbr_input_from_standard_material,
    pbr_functions::{alpha_discard, apply_pbr_lighting, main_pass_post_lighting_processing},
};

struct Impostor {
    // Bevy `VisibilityRange` layout: fade in from x to y, fade out from z to w (metres).
    range: vec4<f32>,
    // x: columns, y: rows, z: frames in the ring, w: unused
    grid: vec4<f32>,
};

@group(constants::MATERIAL_BIND_GROUP) @binding(100) var<uniform> imp: Impostor;

const TAU: f32 = 6.2831853;

// Same mapping as `mesh_functions::get_visibility_range_dither_level`.
fn dither_level(d: f32) -> i32 {
    let r = imp.range;
    let offset = select(-16, 0, d >= r.z);
    let bounds = select(r.xy, r.zw, d >= r.z);
    let level = i32(round((d - bounds.x) / max(bounds.y - bounds.x, 1e-3) * 16.0));
    return offset + clamp(level, 0, 16);
}

@vertex
fn vertex(v_in: Vertex) -> VertexOutput {
    var out: VertexOutput;
    let v = decompress_vertex(v_in, v_in.instance_index);
    let world_from_local = mesh_functions::get_world_from_local(v_in.instance_index);
    let base = mesh_functions::mesh_position_local_to_world(world_from_local, vec4<f32>(v.position, 1.0)).xyz;
    let level = dither_level(length(view.lod_view_world_position.xyz - base));
    out.uv_b = vec2<f32>(f32(level), 0.0);
@if(VERTEX_COLORS)
    out.color = v.color;
    if level <= -16 || level >= 16 {
        // Out of range: all four corners on one point, nothing rasterised.
        out.uv = v.uv;
        out.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
        out.world_position = vec4<f32>(base, 1.0);
        out.world_normal = vec3<f32>(0.0, 1.0, 0.0);
        return out;
    }
    // Face the camera that draws (its own position), turning about Y only.
    let to = view.world_position.xz - base.xz;
    let len = length(to);
    let f = select(vec2<f32>(0.0, 1.0), to / max(len, 1e-4), len > 1e-3);
    let right = vec3<f32>(f.y, 0.0, -f.x);
    let toward = vec3<f32>(f.x, 0.0, f.y);
    let off = v.uv_b;
    let wp = base + right * off.x + vec3<f32>(0.0, off.y, 0.0);
    out.world_position = vec4<f32>(wp, 1.0);
    out.position = position_world_to_clip(wp);
    // Which picture of the ring: the camera's azimuth in the plant's own frame.
    let q = floor(v.uv.x / 2.0);
    let corner = vec2<f32>(v.uv.x - 2.0 * q, v.uv.y);
    let yaw = q / 256.0 * TAU;
    let frames = max(imp.grid.z, 1.0);
    let az = atan2(f.x, f.y) - yaw;
    let idx = floor(fract(az / TAU + 0.5 / frames) * frames);
    let cell = vec2<f32>(idx % imp.grid.x, floor(idx / imp.grid.x));
    out.uv = (cell + corner) / imp.grid.xy;
    // Soft foliage normal: the average over the camera-facing half of a crown. Nearly level, so a
    // high sun lights it like the near model's mix of lit tops and shaded sides, not like a flat top.
    let side = select(-1.0, 1.0, off.x >= 0.0);
    out.world_normal = normalize(toward * 0.8 + right * side * 0.4 + vec3<f32>(0.0, 0.05, 0.0));
    return out;
}

// Bevy's `visibility_range_dither` (4x4 ordered dither).
const DITHER: vec4<u32> = vec4<u32>(0x0a020800u, 0x060e040cu, 0x09010b03u, 0x050d070fu);

fn dither(frag_coord: vec4<f32>, level: i32) {
    if level == 0 {
        return;
    }
    if level <= -16 || level >= 16 {
        discard;
    }
    let c = vec2<u32>(floor(frag_coord.xy)) % 4u;
    let t = i32((DITHER[c.y] >> (c.x * 8u)) & 0xffu);
    if (level >= 0 && level + t >= 16) || (level < 0 && 1 + level + t <= 0) {
        discard;
    }
}

@fragment
fn fragment(vertex_output: VertexOutput, @builtin(front_facing) is_front: bool) -> FragmentOutput {
    var in = vertex_output;
    dither(in.position, i32(round(in.uv_b.x)));
    var pbr_input = pbr_input_from_standard_material(in, is_front);
    // The impostor has no prepass, so with SSAO / deferred normals on, Bevy would read the normal and
    // occlusion of whatever the prepass drew behind this pixel (the ground: lit like a floor, hence
    // brighter than the near model). Use the quad's own.
    pbr_input.N = normalize(pbr_input.world_normal);
    pbr_input.diffuse_occlusion = vec3<f32>(1.0);
    pbr_input.specular_occlusion = 1.0;
    pbr_input.material.base_color = alpha_discard(pbr_input.material.flags, pbr_input.material.alpha_cutoff, pbr_input.material.base_color);
    var out: FragmentOutput;
    out.color = apply_pbr_lighting(pbr_input);
    out.color = main_pass_post_lighting_processing(pbr_input, out.color);
    return out;
}
