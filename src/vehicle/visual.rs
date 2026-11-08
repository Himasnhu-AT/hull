//! Optional wheel visuals: cylinders that follow the suspension, steering and spin.
//! `spawn_wheel_visuals` makes one child per wheel; replace it with your own meshes by putting
//! [`WheelVisual`] on any child entity.

use bevy::prelude::*;

use super::{Vehicle, VehicleSpec, VehicleTelemetry};
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
