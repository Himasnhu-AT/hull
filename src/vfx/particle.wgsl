// Instanced particle sprites: one instance per particle (or ribbon segment), 4 strip vertices
// each, the corner from `vertex_index`. Modes (c.w): 0 camera-facing billboard, 1 stretched,
// 2 ribbon segment, 3 flat (plane given by a normal). See `gpu.rs::SpriteInstance`.
// Output is premultiplied: shading.w = 0 alpha-blends, 1 adds.

#import bevy_pbr::{
    mesh_view_bindings::{view, lights},
    view_transformations::{position_world_to_clip, depth_ndc_to_view_z},
}
#ifdef DEPTH_PREPASS
#import bevy_pbr::prepass_utils
#endif
#ifdef TONEMAP_IN_SHADER
#import bevy_core_pipeline::tonemapping::tone_mapping
#endif
#ifdef DISTANCE_FOG
#import bevy_pbr::{mesh_view_bindings::fog, mesh_view_types}
#endif

struct ParticleUniform {
    // cols, rows, frames, crossfade (0/1)
    flipbook: vec4<f32>,
    // intensity, lit, soft distance, additive
    shading: vec4<f32>,
};

@group(2) @binding(0) var<uniform> material: ParticleUniform;
@group(2) @binding(1) var tex: texture_2d<f32>;
@group(2) @binding(2) var tex_sampler: sampler;

struct Instance {
    @location(0) a: vec4<f32>,
    @location(1) b: vec4<f32>,
    @location(2) c: vec4<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) world: vec3<f32>,
    @location(3) normal: vec3<f32>,
    @location(4) @interpolate(flat) frame: f32,
};

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + 0.055) / 1.055, vec3(2.4));
    return select(hi, lo, c <= vec3(0.04045));
}

@vertex
fn vertex(@builtin(vertex_index) vi: u32, i: Instance) -> VertexOutput {
    var out: VertexOutput;
    let corner = vec2<f32>(f32(vi & 1u), f32(vi >> 1u));
    let mode = u32(i.c.w + 0.5);
    var world: vec3<f32>;
    var alpha = 1.0;
    var uv = vec2(corner.x, 1.0 - corner.y);
    if mode == 0u {
        let right = view.world_from_view[0].xyz;
        let up = view.world_from_view[1].xyz;
        let o = (corner - 0.5) * vec2(i.a.w, i.b.w);
        let c = cos(i.c.x);
        let s = sin(i.c.x);
        let r = vec2(o.x * c - o.y * s, o.x * s + o.y * c);
        world = i.a.xyz + right * r.x + up * r.y;
        let to_cam = normalize(view.world_position - i.a.xyz);
        // Rounded normal: bends toward the edges so lit sprites read as volumes.
        out.normal = normalize(to_cam + (right * (corner.x - 0.5) + up * (corner.y - 0.5)) * 1.2);
    } else if mode == 3u {
        let n = normalize(i.b.xyz);
        var t = cross(vec3(0.0, 1.0, 0.0), n);
        if dot(t, t) < 1e-4 {
            t = cross(vec3(1.0, 0.0, 0.0), n);
        }
        t = normalize(t);
        let bt = cross(n, t);
        let c = cos(i.c.x);
        let s = sin(i.c.x);
        let u = (t * c + bt * s) * i.a.w;
        let v = (bt * c - t * s) * i.b.w;
        world = i.a.xyz + u * (corner.x - 0.5) + v * (corner.y - 0.5);
        out.normal = n;
    } else {
        let p = i.a.xyz + i.b.xyz * corner.y;
        let half = mix(i.a.w, i.b.w, corner.y) * 0.5;
        let to_cam = view.world_position - p;
        var side = cross(i.b.xyz, to_cam);
        let l = length(side);
        side = select(vec3(0.0), side / l, l > 1e-8);
        world = p + side * half * (corner.x * 2.0 - 1.0);
        alpha = mix(i.c.x, i.c.z, corner.y);
        if mode == 2u {
            uv = vec2(corner.x, 0.5);
        } else {
            uv = vec2(corner.x, corner.y);
        }
        out.normal = normalize(to_cam);
    }
    out.uv = uv;
    out.world = world;
    out.clip = position_world_to_clip(world);
    out.color = vec4(srgb_to_linear(i.color.rgb), i.color.a * alpha);
    out.frame = i.c.y;
    return out;
}

fn sample_frame(uv: vec2<f32>, frame: f32) -> vec4<f32> {
    let grid = material.flipbook.xy;
    let f = u32(frame) % u32(max(material.flipbook.z, 1.0));
    let cell = vec2(f32(f % u32(grid.x)), f32(f / u32(grid.x)));
    return textureSample(tex, tex_sampler, (cell + uv) / grid);
}

#ifdef DISTANCE_FOG
// Fog amount 0..1 at `d` metres (Bevy's formulas, no light scattering).
fn fog_amount(d: f32) -> f32 {
    if fog.mode == mesh_view_types::FOG_MODE_LINEAR {
        return 1.0 - clamp((fog.be.y - d) / (fog.be.y - fog.be.x), 0.0, 1.0);
    } else if fog.mode == mesh_view_types::FOG_MODE_EXPONENTIAL {
        return 1.0 - 1.0 / exp(d * fog.be.x);
    } else if fog.mode == mesh_view_types::FOG_MODE_EXPONENTIAL_SQUARED {
        let k = d * fog.be.x;
        return 1.0 - 1.0 / exp(k * k);
    } else if fog.mode == mesh_view_types::FOG_MODE_ATMOSPHERIC {
        let e = 1.0 - 1.0 / exp(d * fog.be);
        return (e.x + e.y + e.z) / 3.0;
    }
    return 0.0;
}
#endif

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    var t: vec4<f32>;
    if material.flipbook.z > 1.0 {
        let f0 = floor(in.frame);
        t = sample_frame(in.uv, f0);
        if material.flipbook.w > 0.5 {
            t = mix(t, sample_frame(in.uv, f0 + 1.0), in.frame - f0);
        }
    } else {
        t = textureSample(tex, tex_sampler, in.uv);
    }
    let color = t * in.color;
    var rgb = color.rgb * material.shading.x;

    let lit = material.shading.y;
    if lit > 0.0 {
        var light = lights.ambient_color.rgb;
        let n = normalize(in.normal);
        for (var k = 0u; k < lights.n_directional_lights; k = k + 1u) {
            let l = lights.directional_lights[k];
            let wrap = clamp((dot(n, l.direction_to_light) + 0.5) / 1.5, 0.0, 1.0);
            light = light + l.color.rgb * wrap * 0.318;
        }
        rgb = mix(rgb, rgb * light * view.exposure, lit);
    }

    var alpha = color.a;
#ifdef DEPTH_PREPASS
#ifndef MULTISAMPLED
    let soft = material.shading.z;
    if soft > 0.0 {
        let scene = depth_ndc_to_view_z(prepass_utils::prepass_depth(in.clip, 0u));
        let here = depth_ndc_to_view_z(in.clip.z);
        alpha = alpha * clamp((here - scene) / soft, 0.0, 1.0);
    }
#endif
#endif

    let add = material.shading.w;
#ifdef DISTANCE_FOG
    let f = fog_amount(length(in.world - view.world_position)) * fog.base_color.a;
    // Blended particles take the fog colour; additive ones fade out.
    rgb = mix(mix(rgb, fog.base_color.rgb, f), rgb * (1.0 - f), add);
#endif
    var out = vec4(rgb, alpha);
#ifdef TONEMAP_IN_SHADER
    out = tone_mapping(out, view.color_grading);
#endif
    // Premultiplied: alpha blend keeps alpha, additive writes 0 alpha.
    return vec4(out.rgb * out.a, out.a * (1.0 - add));
}
