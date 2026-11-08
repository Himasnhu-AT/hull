//! Physics host functions (feature `physics`): queries, rigid-body helpers and a Godot
//! `CharacterBody3D`-style kinematic mover. `[n,]` is the optional leading node (`self` when omitted).
//! Layers and masks are Godot-style integer bitmasks.
//!
//! | Function | Does |
//! |---|---|
//! | `raycast(from, to [, exclude])` | `null` or a hit `[entity, [px,py,pz], [nx,ny,nz], distance]` |
//! | `raycast_dir(from, dir, max_dist [, exclude])` | same, along a direction |
//! | `get_overlapping_bodies([n])` | entities whose colliders overlap `n`'s collider now (needs a physics step) |
//! | `overlap_sphere(center, radius)` | entities inside a sphere |
//! | `get_velocity([n])`, `set_velocity([n,] v)` | `LinearVelocity` |
//! | `apply_impulse([n,] v)` | velocity change of `v / mass` |
//! | `set_gravity_scale([n,] x)` | `GravityScale` |
//! | `set_collision_layer([n,] mask)`, `set_collision_mask([n,] mask)`, `get_collision_layer([n])`, `get_collision_mask([n])` | `CollisionLayers` |
//! | `move_and_slide([n,] velocity)` | slide a [`CharacterBody`] by `velocity * physics_delta`; returns the new velocity |
//! | `is_on_floor([n])`, `is_on_wall([n])`, `is_on_ceiling([n])`, `get_floor_normal([n])` | state after the last `move_and_slide` |

use avian3d::prelude::*;
use bevy::ecs::system::SystemState;
use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::ScriptCtx;
use super::api::{f, rent, rv3, split, v3, world, ent};

/// Kinematic character mover driven by `move_and_slide` (Godot `CharacterBody3D`). Added on first
/// use; the entity needs a `Collider`. Moves `Transform` directly, so use it on a root node.
#[derive(Component, Reflect, Clone, Debug)]
#[reflect(Component)]
pub struct CharacterBody {
    /// Up direction (floor normals are measured against it).
    pub up: Vec3,
    /// Steepest slope (radians) that still counts as floor.
    pub floor_max_angle: f32,
    /// Distance to stick to the floor when walking off a ledge or down a slope (0 = off).
    pub snap: f32,
    pub on_floor: bool,
    pub on_wall: bool,
    pub on_ceiling: bool,
    pub floor_normal: Vec3,
}

impl Default for CharacterBody {
    fn default() -> Self {
        CharacterBody { up: Vec3::Y, floor_max_angle: std::f32::consts::FRAC_PI_4, snap: 0.1, on_floor: false, on_wall: false, on_ceiling: false, floor_normal: Vec3::ZERO }
    }
}

const SKIN: f32 = 0.02;

enum Kind {
    Floor,
    Ceiling,
    Wall,
}

fn classify(n: Vec3, cb: &CharacterBody) -> Kind {
    let cos = n.dot(cb.up);
    if cos >= cb.floor_max_angle.cos() - 1e-4 {
        Kind::Floor
    } else if cos <= -(cb.floor_max_angle.cos() - 1e-4) {
        Kind::Ceiling
    } else {
        Kind::Wall
    }
}

fn dir_of(v: Vec3) -> Option<Dir3> {
    Dir3::new(v).ok()
}

fn hit_value(h: RayHitData, origin: Vec3, dir: Vec3) -> RV {
    RV::array(vec![rent(h.entity), rv3(origin + dir * h.distance), rv3(h.normal), RV::Float(h.distance as f64)])
}

fn ray(w: &mut World, from: Vec3, dir: Vec3, max: f32, exclude: Option<Entity>) -> Result<RV, String> {
    let Some(d) = dir_of(dir) else { return Ok(RV::Null) };
    let mut st = SystemState::<SpatialQuery>::new(w);
    let q = st.get(w).map_err(|e| e.to_string())?;
    let filter = SpatialQueryFilter::from_excluded_entities(exclude);
    Ok(q.cast_ray(from, d, max, true, &filter).map_or(RV::Null, |h| hit_value(h, from, *d)))
}

fn body_of(w: &World, e: Entity) -> Entity {
    w.get::<ColliderOf>(e).map_or(e, |c| c.body)
}

fn overlaps(w: &mut World, shape: &Collider, pos: Vec3, rot: Quat, exclude: Option<Entity>) -> Result<RV, String> {
    let mut st = SystemState::<SpatialQuery>::new(w);
    let q = st.get(w).map_err(|e| e.to_string())?;
    let filter = SpatialQueryFilter::from_excluded_entities(exclude);
    let found = q.shape_intersections(shape, pos, rot, &filter);
    let mut out: Vec<Entity> = vec![];
    for e in found {
        let b = body_of(w, e);
        if Some(b) != exclude && !out.contains(&b) {
            out.push(b);
        }
    }
    Ok(RV::array(out.into_iter().map(rent).collect()))
}

fn layers_of(w: &World, e: Entity) -> CollisionLayers {
    w.get::<CollisionLayers>(e).copied().unwrap_or_default()
}

fn mask_arg(v: &RV) -> Result<u32, String> {
    match v {
        RV::Int(i) => Ok(*i as u32),
        RV::Float(x) => Ok(*x as u32),
        o => Err(format!("mask must be an int, got {}", o.type_name())),
    }
}

fn opt_exclude(a: Option<&RV>) -> Result<Option<Entity>, String> {
    match a {
        None | Some(RV::Null) => Ok(None),
        Some(x) => Ok(Some(ent(x)?)),
    }
}

/// Moves `e` by `vel * dt`, sliding. Returns the new velocity.
fn slide(w: &mut World, e: Entity, vel: Vec3, dt: f32) -> Result<Vec3, String> {
    let shape = w.get::<Collider>(e).cloned().ok_or("move_and_slide: node has no Collider")?;
    if !w.entity(e).contains::<CharacterBody>() {
        w.entity_mut(e).insert(CharacterBody::default());
    }
    if !w.entity(e).contains::<RigidBody>() {
        w.entity_mut(e).insert(RigidBody::Kinematic);
    }
    let mut cb = w.get::<CharacterBody>(e).cloned().unwrap();
    let tf = *w.get::<Transform>(e).ok_or("move_and_slide: node has no Transform")?;
    let filter = SpatialQueryFilter::from_mask(layers_of(w, e).filters).with_excluded_entities([e]);
    let was_floor = cb.on_floor;
    let (mut pos, rot) = (tf.translation, tf.rotation);
    let mut vel = vel;
    let (mut floor, mut wall, mut ceil) = (false, false, false);
    cb.floor_normal = Vec3::ZERO;
    let mut st = SystemState::<SpatialQuery>::new(w);
    let q = st.get(w).map_err(|e| e.to_string())?;
    let mut remaining = vel * dt;
    for _ in 0..4 {
        let len = remaining.length();
        let Some(dir) = dir_of(remaining) else { break };
        if len < 1e-6 {
            break;
        }
        let cfg = ShapeCastConfig { max_distance: len + SKIN, target_distance: 0.0, compute_contact_on_penetration: true, ignore_origin_penetration: false };
        let Some(hit) = q.cast_shape(&shape, pos, rot, dir, &cfg, &filter) else {
            pos += remaining;
            break;
        };
        let n = hit.normal1.normalize_or_zero();
        let travel = (hit.distance - SKIN).clamp(0.0, len);
        pos += *dir * travel;
        if n == Vec3::ZERO {
            break;
        }
        if hit.distance <= 0.0 {
            pos += n * SKIN;
        }
        match classify(n, &cb) {
            Kind::Floor => {
                floor = true;
                cb.floor_normal = n;
            }
            Kind::Ceiling => ceil = true,
            Kind::Wall => wall = true,
        }
        remaining = *dir * (len - travel);
        let into = remaining.dot(n);
        if into < 0.0 {
            remaining -= n * into;
        }
        let vi = vel.dot(n);
        if vi < 0.0 {
            vel -= n * vi;
        }
    }
    // Floor probe / snap: stay on the floor over small drops and slopes while not moving up.
    if !floor && cb.snap > 0.0 && vel.dot(cb.up) <= 0.0 {
        let probe = cb.snap.max(SKIN * 2.0);
        let cfg = ShapeCastConfig { max_distance: probe + SKIN, target_distance: 0.0, compute_contact_on_penetration: true, ignore_origin_penetration: false };
        if let Some(hit) = q.cast_shape(&shape, pos, rot, -Dir3::new(cb.up).unwrap_or(Dir3::Y), &cfg, &filter) {
            let n = hit.normal1.normalize_or_zero();
            if matches!(classify(n, &cb), Kind::Floor) {
                floor = true;
                cb.floor_normal = n;
                // Only pull down when we were on the floor before (not mid-air landing).
                if was_floor {
                    pos -= cb.up * (hit.distance - SKIN).max(0.0);
                }
            }
        }
    }
    cb.on_floor = floor;
    cb.on_wall = wall;
    cb.on_ceiling = ceil;
    w.entity_mut(e).insert(cb);
    w.get_mut::<Transform>(e).unwrap().translation = pos;
    Ok(vel)
}

fn state<T>(w: &World, a: &[RV], usage: &str, get: impl Fn(&CharacterBody) -> T) -> Result<T, String> {
    let (t, _) = split(w, a, 0, usage)?;
    Ok(w.get::<CharacterBody>(t).map(&get).unwrap_or_else(|| get(&CharacterBody::default())))
}

pub(super) fn register(e: &mut Engine) {
    e.register("raycast", |c, a| {
        let w = world(c)?;
        if a.len() < 2 || a.len() > 3 {
            return Err("usage: raycast(from, to [, exclude])".into());
        }
        let (from, to) = (v3(&a[0], "from")?, v3(&a[1], "to")?);
        ray(w, from, to - from, (to - from).length(), opt_exclude(a.get(2))?)
    });
    e.register("raycast_dir", |c, a| {
        let w = world(c)?;
        if a.len() < 3 || a.len() > 4 {
            return Err("usage: raycast_dir(from, dir, max_dist [, exclude])".into());
        }
        ray(w, v3(&a[0], "from")?, v3(&a[1], "dir")?, f(&a[2], "max_dist")?, opt_exclude(a.get(3))?)
    });
    e.register("get_overlapping_bodies", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_overlapping_bodies([n])")?;
        let shape = w.get::<Collider>(t).cloned().ok_or("get_overlapping_bodies: node has no Collider")?;
        let g = w.get::<GlobalTransform>(t).map(|g| g.compute_transform()).or_else(|| w.get::<Transform>(t).copied()).unwrap_or_default();
        overlaps(w, &shape, g.translation, g.rotation, Some(t))
    });
    e.register("overlap_sphere", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: overlap_sphere(center, radius)".into());
        }
        overlaps(w, &Collider::sphere(f(&a[1], "radius")?), v3(&a[0], "center")?, Quat::IDENTITY, None)
    });
    e.register("get_velocity", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_velocity([n])")?;
        Ok(rv3(w.get::<LinearVelocity>(t).map_or(Vec3::ZERO, |v| v.0)))
    });
    e.register("set_velocity", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_velocity([n,] v)")?;
        let v = v3(&r[0], "v")?;
        w.entity_mut(t).insert(LinearVelocity(v));
        Ok(RV::Null)
    });
    e.register("apply_impulse", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "apply_impulse([n,] v)")?;
        let imp = v3(&r[0], "v")?;
        let inv = w.get::<ComputedMass>(t).map_or(1.0, |m| m.inverse());
        let mut em = w.entity_mut(t);
        let cur = em.get::<LinearVelocity>().map_or(Vec3::ZERO, |v| v.0);
        em.insert(LinearVelocity(cur + imp * inv));
        Ok(RV::Null)
    });
    e.register("set_gravity_scale", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_gravity_scale([n,] x)")?;
        w.entity_mut(t).insert(GravityScale(f(&r[0], "x")?));
        Ok(RV::Null)
    });
    e.register("set_collision_layer", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_collision_layer([n,] mask)")?;
        let mut l = layers_of(w, t);
        l.memberships = LayerMask(mask_arg(&r[0])?);
        w.entity_mut(t).insert(l);
        Ok(RV::Null)
    });
    e.register("set_collision_mask", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_collision_mask([n,] mask)")?;
        let mut l = layers_of(w, t);
        l.filters = LayerMask(mask_arg(&r[0])?);
        w.entity_mut(t).insert(l);
        Ok(RV::Null)
    });
    e.register("get_collision_layer", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_collision_layer([n])")?;
        Ok(RV::Int(layers_of(w, t).memberships.0 as i64))
    });
    e.register("get_collision_mask", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_collision_mask([n])")?;
        Ok(RV::Int(layers_of(w, t).filters.0 as i64))
    });
    e.register("move_and_slide", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "move_and_slide([n,] velocity)")?;
        let v = v3(&r[0], "velocity")?;
        let mut dt = w.resource::<ScriptCtx>().physics_delta;
        if dt <= 0.0 {
            dt = w.resource::<Time<Fixed>>().delta_secs();
        }
        Ok(rv3(slide(w, t, v, dt)?))
    });
    e.register("is_on_floor", |c, a| {
        let w = world(c)?;
        Ok(RV::Bool(state(w, a, "is_on_floor([n])", |c| c.on_floor)?))
    });
    e.register("is_on_wall", |c, a| {
        let w = world(c)?;
        Ok(RV::Bool(state(w, a, "is_on_wall([n])", |c| c.on_wall)?))
    });
    e.register("is_on_ceiling", |c, a| {
        let w = world(c)?;
        Ok(RV::Bool(state(w, a, "is_on_ceiling([n])", |c| c.on_ceiling)?))
    });
    e.register("get_floor_normal", |c, a| {
        let w = world(c)?;
        Ok(rv3(state(w, a, "get_floor_normal([n])", |c| c.floor_normal)?))
    });
}
