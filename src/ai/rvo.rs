//! ORCA (optimal reciprocal collision avoidance, RVO2) in the XZ plane, plus the uniform grid
//! the crowd uses for neighbour lookups. Pure functions over plain data; no allocation after
//! warm-up (callers pass scratch buffers).

use bevy::math::Vec2;

const EPS: f32 = 1e-5;

#[derive(Clone, Copy, Debug, Default)]
pub struct Line {
    pub point: Vec2,
    pub direction: Vec2,
}

/// One neighbour as seen by the solving agent.
#[derive(Clone, Copy, Debug)]
pub struct Neighbor {
    pub pos: Vec2,
    pub vel: Vec2,
    pub radius: f32,
    /// Share of the avoidance this agent takes: 0.5 = reciprocal, 1.0 = the other won't move.
    pub responsibility: f32,
}

#[inline]
fn det(a: Vec2, b: Vec2) -> f32 {
    a.x * b.y - a.y * b.x
}

/// New velocity for an agent at `pos` with velocity `vel`, wanting `pref`, given neighbours.
/// `lines` and `proj` are scratch.
pub fn orca_velocity(
    pos: Vec2,
    vel: Vec2,
    radius: f32,
    pref: Vec2,
    max_speed: f32,
    neighbors: &[Neighbor],
    time_horizon: f32,
    dt: f32,
    lines: &mut Vec<Line>,
    proj: &mut Vec<Line>,
) -> Vec2 {
    lines.clear();
    let inv_th = 1.0 / time_horizon.max(1e-3);
    for o in neighbors {
        let rel_pos = o.pos - pos;
        let rel_vel = vel - o.vel;
        let dist_sq = rel_pos.length_squared();
        let r = radius + o.radius;
        let r_sq = r * r;
        let (direction, u);
        if dist_sq > r_sq {
            let w = rel_vel - inv_th * rel_pos;
            let w_len_sq = w.length_squared();
            let dot1 = w.dot(rel_pos);
            if dot1 < 0.0 && dot1 * dot1 > r_sq * w_len_sq {
                let w_len = w_len_sq.sqrt();
                let unit_w = w / w_len;
                direction = Vec2::new(unit_w.y, -unit_w.x);
                u = (r * inv_th - w_len) * unit_w;
            } else {
                let leg = (dist_sq - r_sq).sqrt();
                let d = if det(rel_pos, w) > 0.0 {
                    Vec2::new(rel_pos.x * leg - rel_pos.y * r, rel_pos.x * r + rel_pos.y * leg) / dist_sq
                } else {
                    -Vec2::new(rel_pos.x * leg + rel_pos.y * r, -rel_pos.x * r + rel_pos.y * leg) / dist_sq
                };
                direction = d;
                u = rel_vel.dot(d) * d - rel_vel;
            }
        } else {
            // Already overlapping: resolve within one step.
            let inv_dt = 1.0 / dt.max(1e-4);
            let w = rel_vel - inv_dt * rel_pos;
            let w_len = w.length().max(EPS);
            let unit_w = w / w_len;
            direction = Vec2::new(unit_w.y, -unit_w.x);
            u = (r * inv_dt - w_len) * unit_w;
        }
        lines.push(Line { point: vel + o.responsibility * u, direction });
    }
    let mut result = Vec2::ZERO;
    let fail = linear_program2(lines, max_speed, pref, false, &mut result);
    if fail < lines.len() {
        linear_program3(lines, 0, fail, max_speed, &mut result, proj);
    }
    result
}

fn linear_program1(lines: &[Line], no: usize, radius: f32, opt: Vec2, dir_opt: bool, result: &mut Vec2) -> bool {
    let l = lines[no];
    let dot = l.point.dot(l.direction);
    let disc = dot * dot + radius * radius - l.point.length_squared();
    if disc < 0.0 {
        return false;
    }
    let sq = disc.sqrt();
    let mut t_left = -dot - sq;
    let mut t_right = -dot + sq;
    for li in &lines[..no] {
        let denom = det(l.direction, li.direction);
        let numer = det(li.direction, l.point - li.point);
        if denom.abs() <= EPS {
            if numer < 0.0 {
                return false;
            }
            continue;
        }
        let t = numer / denom;
        if denom >= 0.0 {
            t_right = t_right.min(t);
        } else {
            t_left = t_left.max(t);
        }
        if t_left > t_right {
            return false;
        }
    }
    if dir_opt {
        *result = if opt.dot(l.direction) > 0.0 { l.point + t_right * l.direction } else { l.point + t_left * l.direction };
    } else {
        let t = l.direction.dot(opt - l.point);
        *result = l.point + t.clamp(t_left, t_right) * l.direction;
    }
    true
}

fn linear_program2(lines: &[Line], radius: f32, opt: Vec2, dir_opt: bool, result: &mut Vec2) -> usize {
    *result = if dir_opt {
        opt * radius
    } else if opt.length_squared() > radius * radius {
        opt.normalize_or_zero() * radius
    } else {
        opt
    };
    for i in 0..lines.len() {
        if det(lines[i].direction, lines[i].point - *result) > 0.0 {
            let tmp = *result;
            if !linear_program1(lines, i, radius, opt, dir_opt, result) {
                *result = tmp;
                return i;
            }
        }
    }
    lines.len()
}

fn linear_program3(lines: &[Line], num_obst: usize, begin: usize, radius: f32, result: &mut Vec2, proj: &mut Vec<Line>) {
    let mut distance = 0.0f32;
    for i in begin..lines.len() {
        if det(lines[i].direction, lines[i].point - *result) > distance {
            proj.clear();
            proj.extend_from_slice(&lines[..num_obst]);
            for j in num_obst..i {
                let d = det(lines[i].direction, lines[j].direction);
                let point = if d.abs() <= EPS {
                    if lines[i].direction.dot(lines[j].direction) > 0.0 {
                        continue;
                    }
                    0.5 * (lines[i].point + lines[j].point)
                } else {
                    lines[i].point + (det(lines[j].direction, lines[i].point - lines[j].point) / d) * lines[i].direction
                };
                let direction = (lines[j].direction - lines[i].direction).normalize_or_zero();
                proj.push(Line { point, direction });
            }
            let tmp = *result;
            let opt = Vec2::new(-lines[i].direction.y, lines[i].direction.x);
            if linear_program2(proj, radius, opt, true, result) < proj.len() {
                *result = tmp;
            }
            distance = det(lines[i].direction, lines[i].point - *result);
        }
    }
}

/// Uniform grid over XZ built by sorting `(cell key, index)`; rebuilt each frame without
/// allocating once warm.
#[derive(Default)]
pub struct SpatialGrid {
    cell: f32,
    entries: Vec<(u64, u32)>,
}

#[inline]
fn key(cx: i32, cz: i32) -> u64 {
    ((cx as u32 as u64) << 32) | (cz as u32 as u64)
}

impl SpatialGrid {
    pub fn rebuild(&mut self, cell: f32, points: impl Iterator<Item = Vec2>) {
        self.cell = cell.max(0.01);
        self.entries.clear();
        for (i, p) in points.enumerate() {
            let (cx, cz) = ((p.x / self.cell).floor() as i32, (p.y / self.cell).floor() as i32);
            self.entries.push((key(cx, cz), i as u32));
        }
        self.entries.sort_unstable();
    }

    /// Calls `f(index)` for every point in cells overlapping the circle (caller filters by
    /// exact distance).
    #[inline]
    pub fn query(&self, p: Vec2, radius: f32, mut f: impl FnMut(u32)) {
        if self.entries.is_empty() {
            return;
        }
        let x0 = ((p.x - radius) / self.cell).floor() as i32;
        let x1 = ((p.x + radius) / self.cell).floor() as i32;
        let z0 = ((p.y - radius) / self.cell).floor() as i32;
        let z1 = ((p.y + radius) / self.cell).floor() as i32;
        for cx in x0..=x1 {
            // Cells with the same cx and consecutive cz are contiguous in sort order.
            let lo = key(cx, z0);
            let hi = key(cx, z1);
            if z0 < 0 && z1 >= 0 {
                // Negative cz sort after positive ones (two's complement): split the range.
                self.range(key(cx, z0), key(cx, -1), &mut f);
                self.range(key(cx, 0), hi, &mut f);
            } else {
                self.range(lo, hi, &mut f);
            }
        }
    }

    #[inline]
    fn range(&self, lo: u64, hi: u64, f: &mut impl FnMut(u32)) {
        let start = self.entries.partition_point(|e| e.0 < lo);
        for e in &self.entries[start..] {
            if e.0 > hi {
                break;
            }
            f(e.1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_on_agents_sidestep() {
        let (mut lines, mut proj) = (Vec::new(), Vec::new());
        let a = Vec2::new(-2.0, 0.0);
        let b = Vec2::new(2.0, 0.0);
        let v = orca_velocity(
            a,
            Vec2::X,
            0.4,
            Vec2::X,
            1.5,
            &[Neighbor { pos: b, vel: -Vec2::X, radius: 0.4, responsibility: 0.5 }],
            2.0,
            1.0 / 60.0,
            &mut lines,
            &mut proj,
        );
        assert!(v.y.abs() > 0.05, "sidesteps: {v}");
        assert!(v.length() <= 1.5 + 1e-4);
        // No neighbours: preferred velocity unchanged.
        let v = orca_velocity(a, Vec2::ZERO, 0.4, Vec2::new(1.0, 0.5), 2.0, &[], 2.0, 0.016, &mut lines, &mut proj);
        assert!((v - Vec2::new(1.0, 0.5)).length() < 1e-5);
    }

    #[test]
    fn grid_finds_neighbours_across_negative_cells() {
        let pts = [Vec2::new(-0.5, -0.5), Vec2::new(0.5, 0.5), Vec2::new(-0.5, 0.5), Vec2::new(10.0, 10.0)];
        let mut g = SpatialGrid::default();
        g.rebuild(1.0, pts.iter().copied());
        let mut found = Vec::new();
        g.query(Vec2::ZERO, 1.0, |i| found.push(i));
        found.sort();
        assert_eq!(found, vec![0, 1, 2]);
    }
}
