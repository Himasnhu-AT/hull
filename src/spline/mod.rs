//! Splines (feature `spline`): a `Spline` component (control points with width, bank, tags and
//! data), centripetal Catmull-Rom (or linear) evaluation, an arc-length table with a grid for
//! fast nearest-point queries, a `SplineChanged` message, gizmo drawing, a generic road ribbon
//! and `spline.*` control commands. Docs: `docs/SPLINES.md`.
//!
//! ```ignore
//! let e = commands.spawn(Spline::new(vec![
//!     SplinePoint::at(Vec3::new(0.0, 0.0, 0.0)),
//!     SplinePoint::at(Vec3::new(50.0, 0.0, 10.0)),
//!     SplinePoint::at(Vec3::new(100.0, 2.0, 0.0)),
//! ])).id();
//! // later, with the entity's `Spline` and `SplineCache` (rebuilt for you after a change):
//! let s = cache.sample_at(&spline, 12.5).unwrap();      // pos, dir, right, up, width, tags, t
//! let (along, sample, dist) = cache.nearest(&spline, car_pos).unwrap();
//! ```

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

mod cache;
#[cfg(feature = "devtools")]
mod control;
mod curve;
mod gizmos;
mod road;
#[cfg(test)]
mod tests;

pub use cache::{SplineCache, SplineSamples};
pub use gizmos::{SplineGizmos, SplineSelection};
pub use road::{SplineRoad, SplineRoadMesh, ribbon_mesh, ribbon_mesh_with};

/// How points are joined.
#[derive(Reflect, Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SplineMode {
    /// Centripetal Catmull-Rom: smooth, passes through every point, no overshoot loops.
    #[default]
    Catmull,
    /// Straight lines between points.
    Linear,
}

/// One control point.
#[derive(Reflect, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[reflect(Default)]
pub struct SplinePoint {
    /// Position in the spline entity's local space.
    pub pos: Vec3,
    /// Full width in metres (a road's edge to edge). Interpolated linearly.
    pub width: f32,
    /// Roll in radians around the travel direction. Positive lowers the right edge (leans into
    /// a right turn). Interpolated linearly.
    pub bank: f32,
    /// Game-defined bits (surface, road kind...). A segment takes the tags of its *start* point.
    pub tags: u32,
    /// Game-defined payload (lane info, names...). Like `tags`, belongs to the segment it starts.
    pub data: Option<String>,
}

impl Default for SplinePoint {
    fn default() -> Self {
        SplinePoint { pos: Vec3::ZERO, width: 4.0, bank: 0.0, tags: 0, data: None }
    }
}

impl SplinePoint {
    /// A point with default width, no bank, no tags.
    pub fn at(pos: Vec3) -> Self {
        SplinePoint { pos, ..default() }
    }
    pub fn with_width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }
    pub fn with_bank(mut self, bank: f32) -> Self {
        self.bank = bank;
        self
    }
    pub fn with_tags(mut self, tags: u32) -> Self {
        self.tags = tags;
        self
    }
    pub fn with_data(mut self, data: impl Into<String>) -> Self {
        self.data = Some(data.into());
        self
    }
}

/// A curve through control points. Saved in levels. The arc-length table lives in
/// [`SplineCache`], rebuilt in `PostUpdate` after any change (then [`SplineChanged`] is sent).
#[derive(Component, Reflect, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[reflect(Component, Default)]
pub struct Spline {
    pub points: Vec<SplinePoint>,
    /// Joins the last point back to the first (needs 3+ points; otherwise treated as open).
    pub closed: bool,
    pub mode: SplineMode,
}

/// A spline's evaluated state at one place.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplineSample {
    pub pos: Vec3,
    /// Unit travel direction.
    pub dir: Vec3,
    /// Unit vector to the right of travel, rolled by the bank.
    pub right: Vec3,
    /// Unit surface normal, rolled by the bank.
    pub up: Vec3,
    /// Full width, interpolated.
    pub width: f32,
    /// Interpolated bank in radians.
    pub bank: f32,
    /// Tags of the segment's start point.
    pub tags: u32,
    /// Curve parameter: index of the segment's start point plus the fraction along it.
    pub t: f32,
}

/// Sent in `PostUpdate` (after [`SplineSet`]) for every spline whose cache was rebuilt, also
/// the first time one appears. Games rebuild meshes from it.
#[derive(Message, Clone, Copy, Debug, PartialEq, Eq)]
pub struct SplineChanged {
    pub entity: Entity,
}

/// `PostUpdate` set that rebuilds caches and sends [`SplineChanged`]; order game systems after it.
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SplineSet;

pub struct SplinePlugin;

impl Plugin for SplinePlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<Spline>()
            .register_type::<SplinePoint>()
            .register_type::<SplineMode>()
            .register_type::<SplineRoad>()
            .init_resource::<SplineGizmos>()
            .init_resource::<SplineSelection>()
            .add_message::<SplineChanged>()
            .configure_sets(PostUpdate, SplineSet.before(TransformSystems::Propagate))
            .add_systems(PostUpdate, (cache::ensure_caches, cache::rebuild_caches).chain().in_set(SplineSet))
            .add_systems(
                PostUpdate,
                (
                    road::sync_roads.run_if(resource_exists::<Assets<Mesh>>),
                    gizmos::draw.run_if(gizmos::draw_enabled).after(TransformSystems::Propagate),
                )
                    .after(SplineSet),
            );
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

impl Spline {
    pub fn new(points: Vec<SplinePoint>) -> Self {
        Spline { points, ..default() }
    }

    /// An open Catmull-Rom spline through `positions`.
    pub fn from_positions(positions: impl IntoIterator<Item = Vec3>) -> Self {
        Spline::new(positions.into_iter().map(SplinePoint::at).collect())
    }

    pub fn closed(mut self) -> Self {
        self.closed = true;
        self
    }

    pub fn linear(mut self) -> Self {
        self.mode = SplineMode::Linear;
        self
    }

    /// True when the last point joins the first.
    pub fn is_loop(&self) -> bool {
        self.closed && self.points.len() >= 3
    }

    /// Number of curve segments between control points.
    pub fn segment_count(&self) -> usize {
        let n = self.points.len();
        if n < 2 {
            0
        } else if self.is_loop() {
            n
        } else {
            n - 1
        }
    }

    /// Inserts a point after `after` (clamped), at `pos`; width and bank are the average of its
    /// neighbours, tags and data come from `after`. Returns the new index.
    pub fn insert_point(&mut self, after: usize, pos: Vec3) -> usize {
        if self.points.is_empty() {
            self.points.push(SplinePoint::at(pos));
            return 0;
        }
        let a = after.min(self.points.len() - 1);
        let next = if a + 1 < self.points.len() {
            Some(a + 1)
        } else if self.is_loop() {
            Some(0)
        } else {
            None
        };
        let (pa, pb) = (&self.points[a], next.map(|n| &self.points[n]).unwrap_or(&self.points[a]));
        let p = SplinePoint { pos, width: (pa.width + pb.width) * 0.5, bank: (pa.bank + pb.bank) * 0.5, tags: pa.tags, data: pa.data.clone() };
        self.points.insert(a + 1, p);
        a + 1
    }

    /// Removes a point; `None` if out of range.
    pub fn remove_point(&mut self, index: usize) -> Option<SplinePoint> {
        (index < self.points.len()).then(|| self.points.remove(index))
    }

    /// Splits an open spline at interior point `index` (1..len-1): `self` keeps `..=index`, the
    /// returned spline gets `index..` (the point is shared). On a closed spline it opens the
    /// loop at `index` instead (starts and ends there) and returns `None`. Also `None` if
    /// `index` is not splittable.
    pub fn split(&mut self, index: usize) -> Option<Spline> {
        let n = self.points.len();
        if self.is_loop() {
            if index >= n {
                return None;
            }
            self.points.rotate_left(index);
            let first = self.points[0].clone();
            self.points.push(first);
            self.closed = false;
            return None;
        }
        if index == 0 || index + 1 >= n {
            return None;
        }
        let tail = self.points.split_off(index);
        let mut head_end = tail[0].clone();
        // The head ends on the shared point, which carries the tail's tags as its own start.
        head_end.tags = self.points[index - 1].tags;
        head_end.data = self.points[index - 1].data.clone();
        self.points.push(head_end);
        Some(Spline { points: tail, closed: false, mode: self.mode })
    }

    /// Reverses the travel direction. Bank flips sign (it is relative to the right side), and
    /// tags/data stay with their segments.
    pub fn reverse(&mut self) {
        let n = self.points.len();
        if n < 2 {
            for p in &mut self.points {
                p.bank = -p.bank;
            }
            return;
        }
        let old = std::mem::take(&mut self.points);
        self.points = (0..n)
            .map(|k| {
                let src = &old[n - 1 - k];
                let seg = &old[(n + n - 2 - k) % n];
                SplinePoint { pos: src.pos, width: src.width, bank: -src.bank, tags: seg.tags, data: seg.data.clone() }
            })
            .collect();
    }
}
