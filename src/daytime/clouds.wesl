// Cloud dome (`clouds.rs`): a dome centred on the camera, drawn after Bevy's atmosphere in the
// transparent pass (depth-tested, not written), so only sky pixels shade. Each pixel ray-marches
// the cloud shell (base..top altitude over a curved earth) in a few jittered steps (TAA resolves
// the noise); Low draws one sample of a flat layer. Output is premultiplied radiance × exposure.
// Stars are added where the clouds let them through. WESL (Bevy 0.20).
import bevy_pbr::render::{
    mesh_view_bindings::{view, globals},
    view_transformations::position_world_to_clip,
};

struct Clouds {
    // xyz: towards the light (sun or moon); w: 1 = moon
    sun_dir: vec4<f32>,
    // rgb: light illuminance on the clouds; w: daylight 0..1
    sun_rad: vec4<f32>,
    // rgb: sky radiance from above / ground bounce from below
    amb_top: vec4<f32>,
    amb_bot: vec4<f32>,
    // rgb: horizon haze radiance; w: cumulus growth 0..1
    haze: vec4<f32>,
    // coverage, extinction (1/m), base and top altitude (m)
    shape: vec4<f32>,
    // xy: wind offset (m), z: detail offset, w: steps (1 = flat layer)
    wind: vec4<f32>,
    // x: star radiance, y: sky rotation (rad), z: time (s), w: light taps
    stars: vec4<f32>,
    // x: moon's angular radius (rad), y: phase angle (rad, 0 = full), z: moon radiance at
    // full light, w: visible 0..1 (the moon is the light: `sun_dir`)
    moon: vec4<f32>,
    // x: latitude (rad: the celestial pole's height), y: star density (share of cells with a
    // star), z: moon albedo contrast, w: unused
    sky: vec4<f32>,
};

@group(constants::MATERIAL_BIND_GROUP) @binding(100) var<uniform> c: Clouds;
@group(constants::MATERIAL_BIND_GROUP) @binding(101) var weather_tex: texture_2d<f32>;
@group(constants::MATERIAL_BIND_GROUP) @binding(102) var weather_smp: sampler;
@group(constants::MATERIAL_BIND_GROUP) @binding(103) var detail_tex: texture_3d<f32>;
@group(constants::MATERIAL_BIND_GROUP) @binding(104) var detail_smp: sampler;
const DOME_R: f32 = 40000.0;
const EARTH_R: f32 = 6360000.0;
const PI: f32 = 3.14159265;
// Longest stretch of the shell one pixel marches (m): long, grazing paths near the horizon
// would otherwise spread the few steps over tens of kilometres.
const MAX_PATH: f32 = 14000.0;
// Map scales (m per texture tile): macro coverage, shape, detail volume.
const MACRO_TILE: f32 = 60000.0;
const SHAPE_TILE: f32 = 19000.0;
// Distance (m) at which far clouds are half haze.
const HAZE_DIST: f32 = 30000.0;
const DETAIL_TILE: f32 = 1700.0;

struct VOut {
    @builtin(position) position: vec4<f32>,
    @location(0) dir: vec3<f32>,
};

@vertex
fn vertex(@location(0) position: vec3<f32>) -> VOut {
    var out: VOut;
    let wp = view.world_position + position * DOME_R;
    out.position = position_world_to_clip(wp);
    out.dir = position;
    return out;
}

// Distance along `d` from a point at radius `r0` (direction-cosine `mu` with the up vector) to
// the sphere of radius `r` around the earth's centre (the far hit: we are inside it).
fn shell_hit(r0: f32, mu: f32, r: f32) -> f32 {
    let b = r0 * mu;
    let disc = b * b - r0 * r0 + r * r;
    return -b + sqrt(max(disc, 0.0));
}

fn remap(v: f32, lo: f32, hi: f32) -> f32 {
    return clamp((v - lo) / max(hi - lo, 1e-4), 0.0, 1.0);
}

// Cloud density (0..1) at world point `p` (altitude = p.y); `detail` erodes the edges.
fn density(p: vec3<f32>, detail: bool) -> f32 {
    let h = remap(p.y, c.shape.z, c.shape.w);
    let q = p.xz + c.wind.xy;
    let m = textureSampleLevel(weather_tex, weather_smp, q / MACRO_TILE, 0.0);
    let s = textureSampleLevel(weather_tex, weather_smp, q / SHAPE_TILE + vec2<f32>(0.31, 0.17), 0.0);
    // Local coverage: the global value moved by the macro map (clear and cloudy regions).
    let cov = clamp(c.shape.x + (m.r - 0.5) * 0.7, 0.0, 1.0);
    // Height profile: flat-ish bases, rounded tops; denser cells grow taller.
    let tall = mix(0.3, 1.0, s.b) * mix(0.45, 1.0, c.haze.w);
    let profile = remap(h, 0.0, 0.08) * remap(h, tall, tall * 0.55);
    // Puffy cells (B) round the Perlin-Worley lumps (G) into cumulus.
    let base_shape = s.g * 0.75 + s.b * 0.25;
    var d = remap(base_shape, 1.0 - cov * 1.25, 1.05 - cov * 0.4) * profile;
    if detail && d > 0.0 {
        let dp = (p + vec3<f32>(c.wind.z, 0.0, c.wind.y * 0.6)) / DETAIL_TILE;
        let n = textureSampleLevel(detail_tex, detail_smp, dp, 0.0).r;
        // Erode more at the bottom (wisps) than at the tops (cauliflower).
        d = remap(d, n * mix(0.45, 0.25, h), 1.0);
    }
    return d;
}

fn hg(cos_t: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cos_t, 1e-4), 1.5));
}

// Interleaved gradient noise, moved each frame (TAA averages the march jitter).
fn ign(px: vec2<f32>) -> f32 {
    let f = f32(globals.frame_count % 64u) * 5.588238;
    return fract(52.9829189 * fract(0.06711056 * (px.x + f) + 0.00583715 * (px.y + f)));
}

fn hash2(p: vec2<f32>) -> vec2<f32> {
    var q = vec2<f32>(dot(p, vec2<f32>(127.1, 311.7)), dot(p, vec2<f32>(269.5, 183.3)));
    return fract(sin(q) * 43758.5453);
}

// World direction → equatorial (J2000) unit vector: the sky turns about the celestial pole
// (46° up, due north = −Z) by the sky rotation; x = east at rotation 0, z = the pole.
fn equatorial(d: vec3<f32>) -> vec3<f32> {
    let pole = vec3<f32>(0.0, sin(c.sky.x), -cos(c.sky.x));
    let a = c.stars.y;
    let v = d * cos(a) + cross(pole, d) * sin(a) + pole * dot(pole, d) * (1.0 - cos(a));
    let ex = vec3<f32>(1.0, 0.0, 0.0);
    let ey = cross(pole, ex);
    return vec3<f32>(dot(v, ex), dot(v, ey), dot(v, pole));
}

fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash2(i).x;
    let b = hash2(i + vec2<f32>(1.0, 0.0)).x;
    let c0 = hash2(i + vec2<f32>(0.0, 1.0)).x;
    let d = hash2(i + vec2<f32>(1.0, 1.0)).x;
    return mix(mix(a, b, u.x), mix(c0, d, u.x), u.y);
}

// Procedural stars: one candidate per cube-face cell (hash decides if it has a star, where in
// the cell, how bright and what colour), fixed in the equatorial frame; a little twinkle.
fn stars(e: vec3<f32>, px_angle: f32) -> vec3<f32> {
    let av = abs(e);
    var uv: vec2<f32>;
    var face: f32;
    if av.x >= av.y && av.x >= av.z {
        uv = e.yz / av.x;
        face = select(0.0, 1.0, e.x > 0.0);
    } else if av.y >= av.z {
        uv = e.xz / av.y;
        face = select(2.0, 3.0, e.y > 0.0);
    } else {
        uv = e.xy / av.z;
        face = select(4.0, 5.0, e.z > 0.0);
    }
    let n = 160.0;
    let g = (uv * 0.5 + 0.5) * n;
    let cell = min(floor(g), vec2<f32>(n - 1.0));
    let r = hash2(cell + face * 271.0);
    if r.x > c.sky.y {
        return vec3<f32>(0.0);
    }
    let r2 = hash2(cell * 1.7 + face * 91.0 + 13.0);
    let mag = r.y;
    let dist_px = length(g - (cell + r2)) * (2.0 / n) / max(px_angle, 1e-5);
    let width = 1.0 + 0.9 * pow(mag, 8.0);
    let core = exp(-dist_px * dist_px * 1.6 / (width * width));
    // Mostly faint, a few bright ones.
    let flux = mix(0.05, 0.9, pow(mag, 6.0));
    let tint = mix(mix(vec3<f32>(0.72, 0.82, 1.0), vec3<f32>(1.0, 0.97, 0.92), clamp(r2.x * 2.0, 0.0, 1.0)), vec3<f32>(1.0, 0.7, 0.45), clamp(r2.x * 2.0 - 1.0, 0.0, 1.0));
    let tw = 0.82 + 0.18 * sin(c.stars.z * (3.0 + r2.y * 7.0) + r2.x * 40.0);
    return tint * core * flux * tw;
}

// A faint Milky Way band about a tilted great circle, broken into round blotches with noise.
fn milky_way(e: vec3<f32>) -> f32 {
    let axis = normalize(vec3<f32>(-0.87, 0.2, 0.45));
    let b = dot(e, axis);
    let band = exp(-b * b / 0.006);
    let u = normalize(cross(axis, vec3<f32>(0.0, 1.0, 0.0)));
    let l = atan2(dot(e, cross(axis, u)), dot(e, u));
    let n = vnoise(vec2<f32>(l * 14.0, b * 14.0)) * 0.55 + vnoise(vec2<f32>(l * 40.0, b * 40.0)) * 0.45;
    return band * (0.25 + 0.75 * n);
}

// The moon: a disc of the LRO albedo map lit for its phase (light from the west), earthshine on
// the dark side, and a halo in the air around it. rgb: radiance, a: coverage of the disc.
fn moon(d: vec3<f32>, px_angle: f32) -> vec4<f32> {
    let m = c.sun_dir.xyz;
    let cos_a = dot(d, m);
    let ang = acos(clamp(cos_a, -1.0, 1.0));
    let glow = (exp(-ang / 0.03) * 0.03 + exp(-ang / 0.3) * 0.004) * c.moon.z * vec3<f32>(0.72, 0.78, 0.92);
    let rad = c.moon.x;
    if cos_a < 0.99 || ang > rad * 1.5 {
        return vec4<f32>(glow, 0.0);
    }
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), m));
    let up = cross(m, right);
    let p = vec2<f32>(dot(d, right), dot(d, up)) / rad;
    let r = length(p);
    let cover = 1.0 - smoothstep(1.0 - 1.5 * px_angle / rad, 1.0, r);
    if cover <= 0.0 {
        return vec4<f32>(glow, 0.0);
    }
    let z = sqrt(max(1.0 - r * r, 0.0));
    let nrm = vec3<f32>(p.x, p.y, z);
    let ph = c.moon.y;
    let to_sun = normalize(vec3<f32>(sin(ph), 0.12, cos(ph)));
    // The moon is nearly flat-lit (no Lambert falloff to the limb): a soft terminator.
    let lit = smoothstep(-0.03, 0.08, dot(nrm, to_sun));
    let lon = atan2(nrm.x, nrm.z);
    let lat = asin(clamp(nrm.y, -1.0, 1.0));
    let mp = vec2<f32>(lon, lat * 2.0);
    let maria = smoothstep(0.45, 0.62, vnoise(mp * 1.6) * 0.65 + vnoise(mp * 4.0) * 0.35);
    let albedo = vec3<f32>(0.78, 0.76, 0.72) * (1.0 - c.sky.z * 0.55 * maria);
    let surface = albedo * (lit + 0.012) * c.moon.z;
    return vec4<f32>(surface * cover + glow * (1.0 - cover), cover);
}

@fragment
fn fragment(in: VOut) -> @location(0) vec4<f32> {
    let d = normalize(in.dir);
    let cam = view.world_position;
    // Pixel footprint (rad), for star size.
    let px_angle = length(fwidth(d));

    var radiance = vec3<f32>(0.0);
    var trans = 1.0;

    let r0 = EARTH_R + cam.y;
    let mu = d.y;
    let base = c.shape.z;
    let top = c.shape.w;
    // Below the horizon there is no cloud above (and the ground draws there anyway).
    if mu > -0.02 && cam.y < base {
        let t0 = shell_hit(r0, mu, EARTH_R + base);
        let t1 = min(shell_hit(r0, mu, EARTH_R + top), t0 + MAX_PATH);
        let to_l = c.sun_dir.xyz;
        let cos_t = dot(d, to_l);
        // Forward lobe for the silver lining, a weak back lobe.
        let phase = mix(hg(cos_t, 0.65), hg(cos_t, -0.2), 0.35);
        let steps = max(c.wind.w, 1.0);
        let flat = steps < 1.5;
        // Up to the first hit, for the haze.
        var hit_t = t1;
        let jitter = ign(in.position.xy);
        let ds = (t1 - t0) / steps;
        // Extinction at full density; a flat layer stands in for the whole shell's thickness.
        let sigma = c.shape.y;
        for (var i = 0.0; i < steps; i += 1.0) {
            let t = select(t0 + (i + jitter) * ds, mix(t0, t1, 0.5), flat);
            let p = cam + d * t;
            let dens = density(p, !flat);
            if dens <= 0.001 {
                continue;
            }
            hit_t = min(hit_t, t);
            let h = remap(p.y, base, top);
            // Light: optical depth towards the light from 1-2 taps.
            var tau = 0.0;
            if c.stars.w >= 1.0 {
                tau += density(p + to_l * 180.0, false) * 180.0;
            }
            if c.stars.w >= 2.0 {
                tau += density(p + to_l * 650.0, false) * 470.0;
            }
            if flat {
                // A flat layer: thicker clouds are darker underneath.
                tau = dens * 900.0;
            } else {
                tau += dens * 60.0;
            }
            tau *= sigma;
            // Beer with a multiple-scattering floor (light leaks through thick cloud), and
            // the "powder" darkening of edges facing away from the light.
            let beer = max(exp(-tau), 0.3 * exp(-tau * 0.18));
            let powder = 1.0 - 0.6 * exp(-dens * 4.0);
            let sun = c.sun_rad.rgb * beer * mix(powder, 1.0, 0.5 + 0.5 * cos_t) * phase * 4.0;
            let amb = mix(c.amb_bot.rgb, c.amb_top.rgb, clamp(h * 1.3, 0.0, 1.0)) * mix(0.35, 1.0, h);
            let s = sun + amb;
            // Energy-conserving step (Hillaire): what this slab scatters, seen through what's
            // in front of it.
            let len = select(ds, (t1 - t0), flat);
            let st = exp(-dens * sigma * len);
            radiance += trans * s * (1.0 - st);
            trans *= st;
            if trans < 0.02 {
                break;
            }
        }
        // Far clouds melt into the horizon haze, and thin out towards it.
        let f = 1.0 - exp(-hit_t / HAZE_DIST);
        let a = 1.0 - trans;
        radiance = mix(radiance, c.haze.rgb * a, f * 0.85);
        trans = 1.0 - a * (1.0 - f * 0.6);
        // Fade out right at the horizon (the shell is a thin line there).
        let edge = smoothstep(-0.02, 0.04, mu);
        radiance *= edge;
        trans = mix(1.0, trans, edge);
    }

    // The moon, and the stars and Milky Way where it isn't: behind the clouds, dimmed near
    // the horizon (extinction).
    var disc = 0.0;
    if c.moon.w > 0.0 && c.sun_dir.w > 0.5 {
        let mo = moon(d, px_angle);
        radiance += mo.rgb * c.moon.w * trans;
        disc = mo.a;
    }
    if c.stars.x > 0.0 && mu > 0.0 {
        let e = equatorial(d);
        let sky = stars(e, px_angle) + vec3<f32>(1.0, 0.95, 0.86) * milky_way(e) * 0.05;
        radiance += sky * c.stars.x * smoothstep(0.0, 0.25, mu) * trans * (1.0 - disc);
    }

    // The moon's disc is opaque: it hides the atmosphere's own disc for the light behind it.
    return vec4<f32>(radiance * view.exposure, max(1.0 - trans, disc * c.moon.w));
}
