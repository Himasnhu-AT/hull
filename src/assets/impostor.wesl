// Impostor quad of a cooked asset (`src/assets/impostor.rs`): a quad in the asset's local XY plane
// turned about the vertical to face the camera, showing the atlas cell that matches the angle
// between the camera and the asset's own heading. The standard PBR fragment does the rest (alpha
// mask, lighting, Bevy's dithered VisibilityRange fade). WESL (Bevy 0.20).
import bevy_pbr::render::{
    mesh_functions,
    mesh_view_bindings::view,
    forward_io::{Vertex, VertexOutput, decompress_vertex},
    view_transformations::position_world_to_clip,
};

struct Impostor {
    // x: frames, y: atlas columns, z: rows.
    params: vec4<f32>,
};

@group(constants::MATERIAL_BIND_GROUP) @binding(100) var<uniform> imp: Impostor;

const TAU: f32 = 6.28318530718;

@vertex
fn vertex(v_in: Vertex) -> VertexOutput {
    var out: VertexOutput;
    let v = decompress_vertex(v_in, v_in.instance_index);
    let m = mesh_functions::get_world_from_local(v_in.instance_index);
    let base = m[3].xyz;
    let sx = length(m[0].xyz);
    let sy = length(m[1].xyz);

    // Towards the camera that draws, about Y only.
    let to = view.world_position.xz - base.xz;
    let len = length(to);
    let f = select(vec2<f32>(0.0, 1.0), to / max(len, 1e-4), len > 1e-3);
    let right = vec3<f32>(f.y, 0.0, -f.x);
    let wp = base + right * (v.position.x * sx) + vec3<f32>(0.0, v.position.y * sy, 0.0);

    // Which view: the camera's azimuth in the asset's own frame (its local +Z in world gives the yaw).
    let fz = vec2<f32>(m[2].x, m[2].z);
    let fzl = length(fz);
    let heading = select(vec2<f32>(0.0, 1.0), fz / max(fzl, 1e-4), fzl > 1e-4);
    var a = atan2(f.x, f.y) - atan2(heading.x, heading.y);
    a = a - TAU * floor(a / TAU);
    let views = max(imp.params.x, 1.0);
    let cols = max(imp.params.y, 1.0);
    let rows = max(imp.params.z, 1.0);
    var cell = floor(a / TAU * views + 0.5);
    cell = cell - views * floor(cell / views);
    // Frames fill the grid row by row from the top left.
    let row = floor(cell / cols);
    let col = cell - row * cols;
    out.uv = vec2<f32>((col + v.uv.x) / cols, (row + v.uv.y) / rows);

    out.world_position = vec4<f32>(wp, 1.0);
    out.position = position_world_to_clip(wp);
    // Soft normal: towards the camera, a little up.
    out.world_normal = normalize(vec3<f32>(f.x, 0.3, f.y));
@if(VERTEX_OUTPUT_INSTANCE_INDEX)
    out.instance_index = v_in.instance_index;
@if(VISIBILITY_RANGE_DITHER)
    out.visibility_range_dither = mesh_functions::get_visibility_range_dither_level(v_in.instance_index, m[3]);
    return out;
}
