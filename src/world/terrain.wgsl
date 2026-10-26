// Terrain splat material: StandardMaterial lighting with up to 4 layers blended by an RGBA
// splat map over the terrain's extent. Each layer: colour × optional tiling texture (sampled
// with world XZ), roughness. A low-frequency value noise breaks up flat colours.
#import bevy_pbr::{
    pbr_fragment::pbr_input_from_standard_material,
    pbr_functions::alpha_discard,
    forward_io::{VertexOutput, FragmentOutput},
    pbr_functions::{apply_pbr_lighting, main_pass_post_lighting_processing},
}
#ifdef VISIBILITY_RANGE_DITHER
#import bevy_pbr::pbr_functions::visibility_range_dither;
#endif

struct TerrainParams {
    // sRGB-linear colours per layer (a unused)
    colors: array<vec4<f32>, 4>,
    // x: 1 / tiling metres, y: roughness, z: texture strength (0 = none), w: unused
    layers: array<vec4<f32>, 4>,
    // xy: Bevy-space XZ of the terrain's min corner, zw: 1 / size
    extent: vec4<f32>,
    // x: macro variation strength, y: macro frequency (1/m)
    variation: vec4<f32>,
};

@group(#{MATERIAL_BIND_GROUP}) @binding(100) var<uniform> terrain: TerrainParams;
@group(#{MATERIAL_BIND_GROUP}) @binding(101) var splat_tex: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(102) var splat_smp: sampler;
@group(#{MATERIAL_BIND_GROUP}) @binding(103) var l0_tex: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(104) var l0_smp: sampler;
@group(#{MATERIAL_BIND_GROUP}) @binding(105) var l1_tex: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(106) var l1_smp: sampler;
@group(#{MATERIAL_BIND_GROUP}) @binding(107) var l2_tex: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(108) var l2_smp: sampler;
@group(#{MATERIAL_BIND_GROUP}) @binding(109) var l3_tex: texture_2d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(110) var l3_smp: sampler;

fn hash21(p: vec2<f32>) -> f32 {
    let q = fract(p * vec2<f32>(123.34, 456.21));
    let r = q + dot(q, q + 45.32);
    return fract(r.x * r.y);
}

fn value_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash21(i);
    let b = hash21(i + vec2<f32>(1.0, 0.0));
    let c = hash21(i + vec2<f32>(0.0, 1.0));
    let d = hash21(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn layer(i: u32, tex: vec3<f32>) -> vec3<f32> {
    let strength = terrain.layers[i].z;
    return terrain.colors[i].rgb * mix(vec3<f32>(1.0), tex * 2.0, strength);
}

@fragment
fn fragment(vertex_output: VertexOutput, @builtin(front_facing) is_front: bool) -> FragmentOutput {
    var in = vertex_output;
#ifdef VISIBILITY_RANGE_DITHER
    visibility_range_dither(in.position, in.visibility_range_dither);
#endif
    var pbr_input = pbr_input_from_standard_material(in, is_front);

    let wp = in.world_position.xz;
    let suv = (wp - terrain.extent.xy) * terrain.extent.zw;
    var w = textureSample(splat_tex, splat_smp, suv);
    w = w / max(w.r + w.g + w.b + w.a, 1e-4);

    // Layer textures are always sampled (uniform control flow); a missing one is white.
    let t0 = textureSample(l0_tex, l0_smp, wp * terrain.layers[0].x).rgb;
    let t1 = textureSample(l1_tex, l1_smp, wp * terrain.layers[1].x).rgb;
    let t2 = textureSample(l2_tex, l2_smp, wp * terrain.layers[2].x).rgb;
    let t3 = textureSample(l3_tex, l3_smp, wp * terrain.layers[3].x).rgb;
    var col = layer(0u, t0) * w.r + layer(1u, t1) * w.g + layer(2u, t2) * w.b + layer(3u, t3) * w.a;
    let rough = terrain.layers[0].y * w.r + terrain.layers[1].y * w.g + terrain.layers[2].y * w.b + terrain.layers[3].y * w.a;

    let freq = terrain.variation.y;
    let n = value_noise(wp * freq) * 0.6 + value_noise(wp * freq * 4.7) * 0.4;
    col = col * (1.0 + terrain.variation.x * (n - 0.5));

    pbr_input.material.base_color = vec4<f32>(col, 1.0);
    pbr_input.material.perceptual_roughness = clamp(rough, 0.04, 1.0);
    pbr_input.material.base_color = alpha_discard(pbr_input.material, pbr_input.material.base_color);

    var out: FragmentOutput;
    out.color = apply_pbr_lighting(pbr_input);
    out.color = main_pass_post_lighting_processing(pbr_input, out.color);
    return out;
}
