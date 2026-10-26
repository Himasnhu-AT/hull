//! Floating origin (opt-in, [`super::OriginSettings`]): for worlds beyond ~8 km, f32 positions
//! far from Bevy's origin lose precision (jittery physics, shimmering vertices). When the main
//! camera gets farther than `threshold` from the origin, the whole scene is moved back by a
//! snapped delta so the camera is near (0, 0) again:
//!
//! - every root entity's `Transform` (and every `GlobalTransform`, so this frame stays
//!   consistent) moves by `-delta`; the [`super::WorldRoot`] is set to `-offset` exactly;
//! - avian picks the move up from `GlobalTransform` (static and dynamic bodies keep their
//!   velocities; nothing is re-created);
//! - [`OriginShifted`] is written with the delta.
//!
//! What games must do: store long-lived positions (save games, quest targets, AI memory,
//! network state) in **absolute** coordinates (`WorldOrigin::to_abs`), or re-base them on
//! [`OriginShifted`]. Positions held only in `Transform`s are handled. Shaders that use world
//! position (the terrain material) are updated by the engine. Only XZ shifts; height stays.

use bevy::math::DVec2;
use bevy::prelude::*;

use super::{WorldRoot, WorldSettings};
use crate::gfx::MainCamera;

/// Absolute position of Bevy's origin (XZ, metres, f64). Zero unless the floating origin moved.
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq)]
pub struct WorldOrigin {
    pub offset: DVec2,
    /// Rebases so far.
    pub shifts: u32,
}

impl WorldOrigin {
    /// Bevy-space position → absolute.
    #[inline]
    pub fn to_abs(&self, local: Vec3) -> Vec3 {
        Vec3::new((local.x as f64 + self.offset.x) as f32, local.y, (local.z as f64 + self.offset.y) as f32)
    }
    /// Absolute position → Bevy space.
    #[inline]
    pub fn to_local(&self, abs: Vec3) -> Vec3 {
        Vec3::new((abs.x as f64 - self.offset.x) as f32, abs.y, (abs.z as f64 - self.offset.y) as f32)
    }
    /// The world root's translation.
    pub fn root_translation(&self) -> Vec3 {
        Vec3::new(-self.offset.x as f32, 0.0, -self.offset.y as f32)
    }
}

/// The scene moved by `-delta` (XZ); `offset` is the new [`WorldOrigin::offset`].
#[derive(Message, Clone, Copy, Debug)]
pub struct OriginShifted {
    pub delta: Vec3,
    pub offset: DVec2,
}

pub(super) struct OriginPlugin;

impl Plugin for OriginPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(First, rebase.after(bevy::time::TimeSystems));
    }
}

fn rebase(
    settings: Res<WorldSettings>,
    mut origin: ResMut<WorldOrigin>,
    mut roots: Query<(&mut Transform, Has<WorldRoot>), Without<ChildOf>>,
    mut globals: ParamSet<(Query<&GlobalTransform, With<MainCamera>>, Query<&mut GlobalTransform>)>,
    mut out: MessageWriter<OriginShifted>,
) {
    let s = &settings.origin;
    if !s.enabled {
        return;
    }
    let Some(cam) = globals.p0().iter().next().map(|g| g.translation()) else { return };
    if cam.xz().length() < s.threshold {
        return;
    }
    let snap = s.snap.max(1.0) as f64;
    let d = DVec2::new((cam.x as f64 / snap).round() * snap, (cam.z as f64 / snap).round() * snap);
    if d == DVec2::ZERO {
        return;
    }
    shift(&mut origin, d, &mut roots, &mut globals.p1());
    out.write(OriginShifted { delta: Vec3::new(d.x as f32, 0.0, d.y as f32), offset: origin.offset });
}

/// Moves the scene by `-d` and the origin by `+d`.
pub(crate) fn shift(
    origin: &mut WorldOrigin,
    d: DVec2,
    roots: &mut Query<(&mut Transform, Has<WorldRoot>), Without<ChildOf>>,
    globals: &mut Query<&mut GlobalTransform>,
) {
    origin.offset += d;
    origin.shifts += 1;
    let dv = Vec3::new(d.x as f32, 0.0, d.y as f32);
    for (mut tf, is_root) in roots.iter_mut() {
        if is_root {
            tf.translation = origin.root_translation();
        } else {
            tf.translation -= dv;
        }
    }
    for mut g in globals.iter_mut() {
        let mut a = g.affine();
        a.translation -= bevy::math::Vec3A::from(dv);
        *g = GlobalTransform::from(a);
    }
}

/// Moves the origin to absolute `abs_xz` right now (e.g. before teleporting 20 km away).
pub fn rebase_to(world: &mut World, abs_xz: Vec2) {
    let cur = world.resource::<WorldOrigin>().offset;
    let d = DVec2::new(abs_xz.x as f64, abs_xz.y as f64) - cur;
    if d == DVec2::ZERO {
        return;
    }
    let mut state: bevy::ecs::system::SystemState<(
        ResMut<WorldOrigin>,
        Query<(&mut Transform, Has<WorldRoot>), Without<ChildOf>>,
        Query<&mut GlobalTransform>,
        MessageWriter<OriginShifted>,
    )> = bevy::ecs::system::SystemState::new(world);
    let Ok((mut origin, mut roots, mut globals, mut out)) = state.get_mut(world) else { return };
    shift(&mut origin, d, &mut roots, &mut globals);
    out.write(OriginShifted { delta: Vec3::new(d.x as f32, 0.0, d.y as f32), offset: origin.offset });
    state.apply(world);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abs_local_round_trip() {
        let o = WorldOrigin { offset: DVec2::new(10_240.0, -4096.0), shifts: 1 };
        let p = Vec3::new(1.25, 7.0, -3.5);
        let a = o.to_abs(p);
        assert_eq!(a, Vec3::new(10_241.25, 7.0, -4099.5));
        assert_eq!(o.to_local(a), p);
    }

    #[test]
    fn rebases_roots_and_keeps_children_relative() {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, TransformPlugin))
            .insert_resource(WorldSettings { origin: super::super::OriginSettings { enabled: true, threshold: 1000.0, snap: 100.0 }, ..default() })
            .init_resource::<WorldOrigin>()
            .add_message::<OriginShifted>()
            .add_plugins(OriginPlugin);
        let root = app.world_mut().spawn((WorldRoot, Transform::default())).id();
        let child = app.world_mut().spawn((Transform::from_xyz(1500.0, 3.0, 20.0), ChildOf(root))).id();
        let cam = app.world_mut().spawn((MainCamera, Transform::from_xyz(1490.0, 2.0, 30.0))).id();
        app.update();
        app.update();
        let o = *app.world().resource::<WorldOrigin>();
        assert_eq!(o.offset, DVec2::new(1500.0, 0.0));
        assert_eq!(o.shifts, 1);
        let cam_t = app.world().get::<Transform>(cam).unwrap().translation;
        assert_eq!(cam_t, Vec3::new(-10.0, 2.0, 30.0));
        let g = app.world().get::<GlobalTransform>(child).unwrap().translation();
        assert!((g - Vec3::new(0.0, 3.0, 20.0)).length() < 1e-3, "{g}");
        // Absolute position of the child is unchanged.
        assert!((o.to_abs(g) - Vec3::new(1500.0, 3.0, 20.0)).length() < 1e-3);
        // Camera now near the origin: no more shifts.
        app.update();
        assert_eq!(app.world().resource::<WorldOrigin>().shifts, 1);
    }
}
