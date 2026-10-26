// Film grain for the look (`LensLook::film_grain`): luminance-weighted animated noise, applied
// in HDR before tonemapping. Bevy's FullscreenMaterial binds: 0 = scene, 1 = sampler, 2 = settings.

#import bevy_core_pipeline::fullscreen_vertex_shader::FullscreenVertexOutput

@group(0) @binding(0) var screen_texture: texture_2d<f32>;
@group(0) @binding(1) var texture_sampler: sampler;

struct FilmGrain {
    intensity: f32,
    time: f32,
    size: f32,
    _pad: f32,
}
@group(0) @binding(2) var<uniform> settings: FilmGrain;

fn hash(p: vec2<f32>) -> f32 {
    let q = fract(p * vec2(0.1031, 0.1030));
    let r = q + dot(q, q.yx + 33.33);
    return fract((r.x + r.y) * r.x);
}

@fragment
fn fragment(in: FullscreenVertexOutput) -> @location(0) vec4<f32> {
    let c = textureSample(screen_texture, texture_sampler, in.uv);
    let dims = vec2<f32>(textureDimensions(screen_texture));
    let cell = floor(in.uv * dims / max(settings.size, 1.0));
    // A new pattern 24 times a second (film frame rate).
    let frame = floor(settings.time * 24.0);
    let n = hash(cell + vec2(frame * 17.0, frame * 31.0)) - 0.5;
    // Strongest in the mid-tones, like real grain; never negative.
    let lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    let w = settings.intensity * 2.0 * (1.0 - abs(1.0 - min(lum, 2.0)) * 0.5);
    return vec4(max(c.rgb * (1.0 + n * w), vec3(0.0)), c.a);
}
