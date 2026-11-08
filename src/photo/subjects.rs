//! What is in the frame: [`Photographable`] entities projected through the camera, with how big
//! they are on screen, how much of them is inside the frame and how much is unoccluded.
//! Games replace the finder by implementing [`SubjectQuery`].

use avian3d::prelude::{SpatialQuery, SpatialQueryFilter};
use bevy::ecs::system::SystemState;
use bevy::prelude::*;
use serde::Serialize;

/// Marks something worth photographing. Games add their own components next to it and read
/// them from [`PhotoMetadata`](super::PhotoMetadata) hooks (species, rarity, behaviour...).
#[derive(Component, Clone, Debug, Reflect)]
pub struct Photographable {
    /// Free-form tag (`"deer"`, `"landmark"`); copied into the subject.
    pub kind: String,
    /// Bounding sphere radius (m) around the entity origin plus `centre_offset`.
    pub radius: f32,
    /// Offset of the sphere centre from the origin, in world space (e.g. up half a body).
    pub centre_offset: Vec3,
    /// Games' own scoring weight (rarity...); carried through untouched.
    pub weight: f32,
}

impl Default for Photographable {
    fn default() -> Self {
        Photographable { kind: String::new(), radius: 0.5, centre_offset: Vec3::ZERO, weight: 1.0 }
    }
}

/// A camera pose and projection, detached from ECS so finders are testable.
#[derive(Clone, Copy, Debug)]
pub struct CameraView {
    pub pos: Vec3,
    pub rot: Quat,
    /// Vertical field of view (radians).
    pub fov_y: f32,
    pub aspect: f32,
    pub near: f32,
    pub far: f32,
}

impl CameraView {
    /// Camera-space `(right, up, depth)`; depth is positive in front.
    pub fn to_view(&self, p: Vec3) -> Vec3 {
        let v = self.rot.inverse() * (p - self.pos);
        Vec3::new(v.x, v.y, -v.z)
    }

    /// Normalised device coordinates (x right, y up, both -1..1 inside the frame) and depth.
    pub fn ndc(&self, p: Vec3) -> Option<(Vec2, f32)> {
        let v = self.to_view(p);
        if v.z <= self.near {
            return None;
        }
        let t = (self.fov_y * 0.5).tan();
        Some((Vec2::new(v.x / (v.z * t * self.aspect), v.y / (v.z * t)), v.z))
    }
}

/// One photographable seen by a camera.
#[derive(Clone, Debug, Serialize)]
pub struct Subject {
    #[serde(serialize_with = "ser_entity")]
    pub entity: Entity,
    pub kind: String,
    pub name: Option<String>,
    pub weight: f32,
    /// Metres from the camera.
    pub distance: f32,
    /// Centre in the frame, 0..1 (x right, y down, like an image).
    pub uv: [f32; 2],
    /// Subject diameter as a fraction of the frame height.
    pub screen_size: f32,
    /// Fraction of the subject's bounding square inside the frame (1 = fully framed).
    pub in_frame: f32,
    /// Fraction of sample points with a clear line to the camera (1 = unoccluded).
    pub visible: f32,
    /// Normalised distance of the centre from the frame centre (0 = dead centre).
    pub off_centre: f32,
}

fn ser_entity<S: serde::Serializer>(e: &Entity, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_u64(e.to_bits())
}

/// Finds the subjects a camera sees. The default is [`FrustumSubjects`].
pub trait SubjectQuery: Send + Sync + 'static {
    fn find(&self, world: &mut World, view: &CameraView) -> Vec<Subject>;
}

/// Frustum test over [`Photographable`] plus optional line-of-sight sampling.
#[derive(Clone, Debug)]
pub struct FrustumSubjects {
    /// Sample points per subject for occlusion (0 = skip, `visible` = 1; 1 = centre only;
    /// 5 = centre and four around it).
    pub occlusion_samples: u32,
    /// Subjects further than this are ignored (m).
    pub max_distance: f32,
    /// Drop subjects with less than this much inside the frame.
    pub min_in_frame: f32,
}

impl Default for FrustumSubjects {
    fn default() -> Self {
        FrustumSubjects { occlusion_samples: 5, max_distance: 400.0, min_in_frame: 0.05 }
    }
}

/// Fraction of the square `centre ± half` (NDC) that lies inside the -1..1 frame.
pub fn frame_overlap(centre: Vec2, half: Vec2) -> f32 {
    let half = half.max(Vec2::splat(1e-4));
    let lo = (centre - half).max(Vec2::splat(-1.0));
    let hi = (centre + half).min(Vec2::splat(1.0));
    let inside = (hi - lo).max(Vec2::ZERO);
    (inside.x * inside.y) / (4.0 * half.x * half.y)
}

impl SubjectQuery for FrustumSubjects {
    fn find(&self, world: &mut World, view: &CameraView) -> Vec<Subject> {
        let mut found: Vec<Subject> = Vec::new();
        let mut q = world.query::<(Entity, &Photographable, &GlobalTransform, Option<&Name>)>();
        let t = (view.fov_y * 0.5).tan();
        for (entity, ph, gt, name) in q.iter(world) {
            let centre = gt.translation() + ph.centre_offset;
            let Some((ndc, depth)) = view.ndc(centre) else { continue };
            if depth > self.max_distance.min(view.far) {
                continue;
            }
            // Bounding square half size in NDC.
            let half = Vec2::new(ph.radius / (depth * t * view.aspect), ph.radius / (depth * t));
            let in_frame = frame_overlap(ndc, half);
            if in_frame < self.min_in_frame {
                continue;
            }
            found.push(Subject {
                entity,
                kind: ph.kind.clone(),
                name: name.map(|n| n.as_str().to_string()),
                weight: ph.weight,
                distance: depth,
                uv: [ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5],
                screen_size: ph.radius / (depth * t),
                in_frame,
                visible: 1.0,
                off_centre: ndc.length() / std::f32::consts::SQRT_2,
            });
        }
        found.sort_by(|a, b| a.distance.total_cmp(&b.distance));
        if self.occlusion_samples > 0 && world.contains_resource::<avian3d::collider_tree::ColliderTrees>() {
            self.occlude(world, view, &mut found);
        }
        found
    }
}

impl FrustumSubjects {
    fn occlude(&self, world: &mut World, view: &CameraView, found: &mut [Subject]) {
        let mut state: SystemState<(SpatialQuery, Query<&ChildOf>, Query<(&Photographable, &GlobalTransform)>)> = SystemState::new(world);
        let Ok((spatial, parents, subjects)) = state.get(world) else { return };
        let right = view.rot * Vec3::X;
        let up = view.rot * Vec3::Y;
        let filter = SpatialQueryFilter::default();
        for s in found.iter_mut() {
            let Ok((ph, gt)) = subjects.get(s.entity) else { continue };
            let c = gt.translation() + ph.centre_offset;
            let r = ph.radius * 0.7;
            let pts = [c, c + right * r, c - right * r, c + up * r, c - up * r];
            let n = (self.occlusion_samples as usize).clamp(1, pts.len());
            let subject = s.entity;
            let own = |e: Entity| e == subject || parents.get(e).is_ok_and(|p| p.parent() == subject);
            let mut clear = 0;
            for p in &pts[..n] {
                let d = *p - view.pos;
                let dist = d.length();
                let Ok(dir) = Dir3::new(d / dist.max(1e-4)) else { continue };
                if spatial.cast_ray_predicate(view.pos, dir, dist, true, &filter, &|e| !own(e)).is_none() {
                    clear += 1;
                }
            }
            s.visible = clear as f32 / n as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view() -> CameraView {
        CameraView { pos: Vec3::ZERO, rot: Quat::IDENTITY, fov_y: 60f32.to_radians(), aspect: 16.0 / 9.0, near: 0.1, far: 1000.0 }
    }

    #[test]
    fn projection_centres_things_ahead() {
        let (ndc, depth) = view().ndc(Vec3::new(0.0, 0.0, -10.0)).unwrap();
        assert!(ndc.length() < 1e-5 && (depth - 10.0).abs() < 1e-5);
        assert!(view().ndc(Vec3::new(0.0, 0.0, 10.0)).is_none(), "behind the camera");
        // Top of the frame at 10 m is tan(30°) * 10 up.
        let (ndc, _) = view().ndc(Vec3::new(0.0, 5.7735, -10.0)).unwrap();
        assert!((ndc.y - 1.0).abs() < 1e-3);
    }

    #[test]
    fn overlap_is_the_framed_fraction() {
        assert_eq!(frame_overlap(Vec2::ZERO, Vec2::splat(0.2)), 1.0);
        assert!((frame_overlap(Vec2::new(1.0, 0.0), Vec2::splat(0.2)) - 0.5).abs() < 1e-5);
        assert_eq!(frame_overlap(Vec2::new(3.0, 0.0), Vec2::splat(0.2)), 0.0);
    }

    #[test]
    fn frustum_finder_sorts_and_filters() {
        let mut world = World::new();
        let mk = |w: &mut World, name: &str, p: Vec3, r: f32| {
            w.spawn((Name::new(name.to_string()), Photographable { kind: "animal".into(), radius: r, ..default() }, GlobalTransform::from(Transform::from_translation(p))));
        };
        mk(&mut world, "far", Vec3::new(0.0, 0.0, -40.0), 1.0);
        mk(&mut world, "near", Vec3::new(1.0, 0.0, -8.0), 1.0);
        mk(&mut world, "behind", Vec3::new(0.0, 0.0, 8.0), 1.0);
        mk(&mut world, "aside", Vec3::new(60.0, 0.0, -10.0), 1.0);
        let found = FrustumSubjects::default().find(&mut world, &view());
        let names: Vec<_> = found.iter().map(|s| s.name.clone().unwrap()).collect();
        assert_eq!(names, ["near", "far"]);
        // Diameter over frame height = r / (d · tan(fov/2)).
        assert!((found[0].screen_size - 1.0 / (8.0 * 30f32.to_radians().tan())).abs() < 1e-4);
        assert_eq!(found[0].in_frame, 1.0);
        assert!(found[0].uv[0] > 0.5, "right of centre");
    }
}
