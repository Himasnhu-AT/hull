//! Optional wheel visuals: cylinders that follow the suspension, steering and spin.
//! `spawn_wheel_visuals` makes one child per wheel; replace it with your own meshes by putting
//! [`WheelVisual`] on any child entity.

use bevy::prelude::*;

use super::{Rope, RopeEnd, Vehicle, VehicleSpec, VehicleTelemetry};
use crate::level::{Primitive, PrimitiveShape};

/// A child of a [`Vehicle`] that is placed and turned from wheel `wheel`'s telemetry.
#[derive(Component, Clone, Copy, Debug)]
pub struct WheelVisual {
    pub wheel: usize,
    /// Accumulated spin, radians (written by the sync).
    pub angle: f32,
}

/// One simple cylinder child per wheel of `spec`.
pub fn spawn_wheel_visuals(commands: &mut Commands, vehicle: Entity, spec: &VehicleSpec, color: Color) {
    for (i, w) in spec.wheels.iter().enumerate() {
        let width = 0.3;
        commands.spawn((
            Name::new(format!("Wheel {i}")),
            WheelVisual { wheel: i, angle: 0.0 },
            Transform::from_translation(w.pos - Vec3::Y * w.spring.max_len),
            Visibility::default(),
            ChildOf(vehicle),
            children![(
                Primitive { shape: PrimitiveShape::Cylinder, size: Vec3::new(w.radius * 2.0, width, w.radius * 2.0), color, ..default() },
                Transform::from_rotation(Quat::from_rotation_z(std::f32::consts::FRAC_PI_2)),
            )],
        ));
    }
}

pub(super) fn sync_wheels(time: Res<Time>, vehicles: Query<(&Vehicle, &VehicleTelemetry)>, mut wheels: Query<(&mut WheelVisual, &mut Transform, &ChildOf)>) {
    let dt = time.delta_secs();
    for (mut v, mut tf, parent) in &mut wheels {
        let Ok((veh, tel)) = vehicles.get(parent.parent()) else { continue };
        let (Some(w), Some(t)) = (veh.spec.wheels.get(v.wheel), tel.wheels.get(v.wheel)) else { continue };
        v.angle = (v.angle - t.spin * dt).rem_euclid(std::f32::consts::TAU);
        tf.translation = w.pos - Vec3::Y * t.len.max(w.spring.min_len * 0.5);
        tf.rotation = Quat::from_rotation_y(-t.steer) * Quat::from_rotation_x(v.angle);
    }
}

/// Put on a [`Rope`] entity to opt out of the default cable visual.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct NoRopeVisual;

/// The drawn cable of rope `.0`: a thin cylinder stretched between the rope's ends.
#[derive(Component, Clone, Copy, Debug)]
pub struct RopeLine(pub Entity);

/// One shared mesh (unit-height cylinder along Y) and material for every rope line.
#[derive(Resource, Clone)]
pub struct RopeVisualAssets {
    pub mesh: Handle<Mesh>,
    pub material: Handle<StandardMaterial>,
    /// Cable radius, m.
    pub radius: f32,
}

fn end_point(end: RopeEnd, bodies: &Query<&Transform, Without<RopeLine>>) -> Option<Vec3> {
    match end {
        RopeEnd::World(p) => Some(p),
        RopeEnd::Body { entity, local } => bodies.get(entity).ok().map(|t| t.transform_point(local)),
    }
}

/// Gives every new [`Rope`] a [`RopeLine`] (once), and removes lines whose rope is gone.
pub(super) fn spawn_rope_lines(
    mut commands: Commands,
    new: Query<Entity, (Added<Rope>, Without<NoRopeVisual>)>,
    lines: Query<(Entity, &RopeLine)>,
    ropes: Query<(), With<Rope>>,
    assets: Option<Res<RopeVisualAssets>>,
    meshes: Option<ResMut<Assets<Mesh>>>,
    materials: Option<ResMut<Assets<StandardMaterial>>>,
) {
    for (line, r) in &lines {
        if !ropes.contains(r.0) {
            commands.entity(line).despawn();
        }
    }
    if new.is_empty() {
        return;
    }
    let assets = match assets {
        Some(a) => a.clone(),
        None => {
            // Headless apps have no mesh storage: no visual, no error.
            let (Some(mut meshes), Some(mut materials)) = (meshes, materials) else { return };
            let a = RopeVisualAssets {
                mesh: meshes.add(Cylinder::new(1.0, 1.0)),
                material: materials.add(StandardMaterial { base_color: Color::srgb(0.9, 0.72, 0.12), perceptual_roughness: 0.8, ..default() }),
                radius: 0.04,
            };
            commands.insert_resource(a.clone());
            a
        }
    };
    for rope in &new {
        commands.spawn((
            Name::new("Rope line"),
            RopeLine(rope),
            Mesh3d(assets.mesh.clone()),
            MeshMaterial3d(assets.material.clone()),
            Transform::default(),
            Visibility::Hidden,
        ));
    }
}

/// Stretches each rope line between its rope's two ends.
pub(super) fn sync_rope_lines(
    assets: Option<Res<RopeVisualAssets>>,
    ropes: Query<&Rope>,
    bodies: Query<&Transform, Without<RopeLine>>,
    mut lines: Query<(&RopeLine, &mut Transform, &mut Visibility)>,
) {
    let Some(assets) = assets else { return };
    for (line, mut tf, mut vis) in &mut lines {
        let ends = ropes.get(line.0).ok().and_then(|r| Some((end_point(r.a, &bodies)?, end_point(r.b, &bodies)?)));
        let Some((a, b)) = ends.filter(|(a, b)| a.distance_squared(*b) > 1e-6) else {
            *vis = Visibility::Hidden;
            continue;
        };
        let d = b - a;
        let len = d.length();
        tf.translation = (a + b) * 0.5;
        tf.rotation = Quat::from_rotation_arc(Vec3::Y, d / len);
        tf.scale = Vec3::new(assets.radius, len, assets.radius);
        *vis = Visibility::Inherited;
    }
}
