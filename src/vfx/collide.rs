//! `Collision::Physics`: particles raycast their last step against avian colliders. A global
//! cap (`VfxBudget::collision_rays`) bounds the cost; emitters are served round robin, so with
//! more particles than rays some are checked every other frame (fast particles may then pass
//! through thin geometry).

use bevy::math::Vec3A;
use bevy::prelude::*;

use avian3d::prelude::{SpatialQuery, SpatialQueryFilter};

use super::def::Collision;
use super::{VfxBudget, VfxInstance, VfxSet, VfxStats};

pub(super) fn build(app: &mut App) {
    app.add_systems(PostUpdate, collide.in_set(VfxSet::Collide));
}

fn collide(time: Res<Time>, budget: Res<VfxBudget>, mut stats: ResMut<VfxStats>, spatial: Option<SpatialQuery>, mut q: Query<&mut VfxInstance>) {
    let Some(spatial) = spatial else { return };
    let dt = time.delta_secs().min(budget.max_dt);
    if dt <= 0.0 {
        stats.collision_rays = 0;
        return;
    }
    let filter = SpatialQueryFilter::default();
    let mut rays = budget.collision_rays;
    let total = rays;
    for mut inst in &mut q {
        if inst.idle || rays == 0 {
            continue;
        }
        let inst = &mut *inst;
        for k in 0..inst.state.emitters.len() {
            let Collision::Physics { restitution, friction, die } = inst.fx.def.emitters[k].collision else { continue };
            let ce = &inst.fx.emitters[k];
            let (head, children) = inst.state.emitters.split_at_mut(k + 1);
            let e = &mut head[k];
            let n = e.p.len();
            if n == 0 {
                continue;
            }
            let count = (n as u32).min(rays) as usize;
            rays -= count as u32;
            let mut i = e.collide_cursor % n;
            let mut done = 0;
            while done < count && !e.p.is_empty() {
                if i >= e.p.len() {
                    i = 0;
                }
                done += 1;
                let (p, v) = (e.p.pos[i], e.p.vel[i]);
                let step = v * dt;
                let len = step.length();
                let Ok(dir) = Dir3::new(Vec3::from(step)) else {
                    i += 1;
                    continue;
                };
                // Cast from where the particle was to where it is now.
                let from = p - step;
                let Some(hit) = spatial.cast_ray(Vec3::from(from), dir, len, true, &filter) else {
                    i += 1;
                    continue;
                };
                let point = from + Vec3A::from(*dir) * hit.distance;
                if !e.bounce(i, point, Vec3A::from(hit.normal), restitution, friction, die, ce, children, k + 1) {
                    i += 1;
                }
            }
            e.collide_cursor = i;
        }
    }
    stats.collision_rays = total - rays;
}
