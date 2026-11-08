//! Closed-form damped springs and the spring arm the chase rig hangs on.

use bevy::prelude::*;

/// A damped spring on one axis, stepped in closed form (exact for a target held over the step,
/// so the feel does not change with the frame rate).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Spring {
    /// Offset from the target.
    pub x: f32,
    pub v: f32,
}

impl Spring {
    /// Steps `dt` seconds towards 0 with natural frequency `omega` (rad/s) and damping ratio
    /// `zeta` (at most 1).
    pub fn step(&mut self, omega: f32, zeta: f32, dt: f32) {
        let (w, z, t) = (omega.max(0.01), zeta.clamp(0.05, 1.0), dt.max(0.0));
        let (y0, v0) = (self.x, self.v);
        if z > 0.999 {
            let e = (-w * t).exp();
            let b = v0 + w * y0;
            self.x = (y0 + b * t) * e;
            self.v = (v0 - w * b * t) * e;
        } else {
            let a = z * w;
            let wd = w * (1.0 - z * z).sqrt();
            let e = (-a * t).exp();
            let (s, c) = (wd * t).sin_cos();
            let b = (v0 + a * y0) / wd;
            self.x = e * (y0 * c + b * s);
            self.v = e * (v0 * c - (a * v0 + w * w * y0) / wd * s);
        }
    }

    /// Keeps the offset within `lo..=hi` (stops the motion into the limit).
    pub fn clamp(&mut self, lo: f32, hi: f32) {
        if self.x < lo {
            self.x = lo;
            self.v = self.v.max(0.0);
        } else if self.x > hi {
            self.x = hi;
            self.v = self.v.min(0.0);
        }
    }
}

/// One axis of the arm: natural frequency (rad/s), damping ratio, limits (m or rad).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Axis {
    pub omega: f32,
    pub zeta: f32,
    pub lo: f32,
    pub hi: f32,
}

/// Spring tuning of a chase arm. Defaults suit a car: speeding up stretches the boom, braking
/// squashes it, cornering swings it sideways.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArmTuning {
    /// Boom length (positive: stretched away from the target).
    pub long: Axis,
    pub lat: Axis,
    pub vert: Axis,
    /// Heading of the arm (rad), limited around the target's nose.
    pub heading: Axis,
    /// The point looked at.
    pub aim_omega: f32,
    pub aim_limit: f32,
}

impl Default for ArmTuning {
    fn default() -> Self {
        ArmTuning {
            long: Axis { omega: 5.0, zeta: 0.8, lo: -1.0, hi: 1.6 },
            lat: Axis { omega: 4.0, zeta: 0.9, lo: -1.2, hi: 1.2 },
            vert: Axis { omega: 7.0, zeta: 1.0, lo: -0.4, hi: 0.6 },
            heading: Axis { omega: 3.5, zeta: 1.0, lo: -0.436, hi: 0.436 },
            aim_omega: 9.0,
            aim_limit: 3.0,
        }
    }
}

/// Shortest signed angle (radians) equivalent to `a`.
pub fn wrap(a: f32) -> f32 {
    (a + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI
}

/// Flat forward (XZ) of a heading `h` = `atan2(x, z)` of that forward.
pub fn heading_dir(h: f32) -> Vec3 {
    Vec3::new(h.sin(), 0.0, h.cos())
}

/// The chase camera's spring arm, in the arm's yaw frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct Arm {
    /// Eye offset from its rest pose: along the boom (+ = further back), right, up.
    pub long: Spring,
    pub lat: Spring,
    pub vert: Spring,
    /// Arm heading offset from where it wants to point (rad).
    pub yaw: Spring,
    /// The arm's heading (rad).
    pub heading: f32,
    /// Aim point offset from its target (world x, y, z).
    pub aim: [Spring; 3],
    rest_eye: Vec3,
    rest_aim: Vec3,
    vel: Option<(Vec3, Vec3)>,
}

/// Where the arm rests: `boom` metres behind and `height` above `at`, aiming `ahead` metres in
/// front at `aim_height`, for an arm heading `h`.
pub fn rest_pose(at: Vec3, h: f32, boom: f32, height: f32, ahead: f32, aim_height: f32) -> (Vec3, Vec3) {
    let f = heading_dir(h);
    (at - f * boom + Vec3::Y * height, at + f * ahead + Vec3::Y * aim_height)
}

impl Arm {
    /// Starts at rest.
    pub fn new(at: Vec3, heading: f32, eye: Vec3, aim: Vec3) -> Self {
        let _ = at;
        Arm { heading, rest_eye: eye, rest_aim: aim, ..default() }
    }

    /// Kicks the vertical spring down by about `m` metres at its deepest (a landing).
    pub fn kick(&mut self, m: f32, stiffness: f32, tuning: &ArmTuning) {
        self.vert.v -= m * tuning.vert.omega * stiffness * std::f32::consts::E;
    }

    /// One step. The target sits at `at` with its nose at `nose` (rad) and wants the arm at
    /// `want` (rad); `rest` is the rest (eye, aim) this frame. Returns (eye, aim).
    pub fn step(&mut self, nose: f32, want: f32, rest: (Vec3, Vec3), tuning: &ArmTuning, stiffness: f32, dt: f32) -> (Vec3, Vec3) {
        let k = stiffness.clamp(0.5, 1.5);
        // Heading: a spring on the error to where it wants to point, limited around the nose.
        self.yaw.x = wrap(self.heading - want);
        self.yaw.step(tuning.heading.omega * k, tuning.heading.zeta, dt);
        let off = wrap(want + self.yaw.x - nose).clamp(tuning.heading.lo, tuning.heading.hi);
        self.heading = wrap(nose + off);
        let f = heading_dir(self.heading);
        let right = Vec3::new(-f.z, 0.0, f.x);
        let (rest_eye, rest_aim) = rest;
        // The camera is a mass on springs to its rest pose: only the rest pose's acceleration
        // moves it off (y'' = -w^2 y - 2 z w y' - a).
        if dt > 1e-5 {
            let v = ((rest_eye - self.rest_eye) / dt, (rest_aim - self.rest_aim) / dt);
            if let Some((ve, va)) = self.vel {
                // Teleports and cuts reset the arm; clamp what is left of a hitch.
                let de = (v.0 - ve).clamp_length_max(20.0);
                let da = (v.1 - va).clamp_length_max(20.0);
                self.long.v += de.dot(f);
                self.lat.v -= de.dot(right);
                self.vert.v -= de.y;
                for (s, c) in self.aim.iter_mut().zip([da.x, da.y, da.z]) {
                    s.v -= c;
                }
            }
            self.vel = Some(v);
        }
        self.rest_eye = rest_eye;
        self.rest_aim = rest_aim;
        for (s, a) in [(&mut self.long, tuning.long), (&mut self.lat, tuning.lat), (&mut self.vert, tuning.vert)] {
            s.step(a.omega * k, a.zeta, dt);
            s.clamp(a.lo, a.hi);
        }
        for s in &mut self.aim {
            s.step(tuning.aim_omega * k, 1.0, dt);
            s.clamp(-tuning.aim_limit, tuning.aim_limit);
        }
        let eye = rest_eye - f * self.long.x + right * self.lat.x + Vec3::Y * self.vert.x;
        let aim = rest_aim + Vec3::new(self.aim[0].x, self.aim[1].x, self.aim[2].x);
        (eye, aim)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spring_settles_without_overshoot_when_critically_damped() {
        let mut s = Spring { x: 1.0, v: 0.0 };
        let mut min = 1.0f32;
        for _ in 0..600 {
            s.step(6.0, 1.0, 1.0 / 60.0);
            min = min.min(s.x);
        }
        assert!(min >= -1e-4 && s.x.abs() < 1e-3, "{min} {}", s.x);
    }

    #[test]
    fn spring_is_frame_rate_independent() {
        let run = |dt: f32| {
            let mut s = Spring { x: 1.0, v: 2.0 };
            let n = (1.0 / dt).round() as usize;
            for _ in 0..n {
                s.step(5.0, 0.6, dt);
            }
            s
        };
        let (a, b) = (run(1.0 / 30.0), run(1.0 / 240.0));
        assert!((a.x - b.x).abs() < 1e-3 && (a.v - b.v).abs() < 1e-2, "{a:?} {b:?}");
    }

    #[test]
    fn spring_clamp_stops_motion_into_the_limit() {
        let mut s = Spring { x: 2.0, v: 5.0 };
        s.clamp(-1.0, 1.0);
        assert_eq!((s.x, s.v), (1.0, 0.0));
    }

    #[test]
    fn arm_rests_at_a_steady_speed_and_stretches_when_the_target_accelerates() {
        let t = ArmTuning::default();
        let rest = |at: Vec3| rest_pose(at, 0.0, 6.8, 2.3, 4.0, 0.9);
        let mut arm = Arm::new(Vec3::ZERO, 0.0, rest(Vec3::ZERO).0, rest(Vec3::ZERO).1);
        let dt = 1.0 / 60.0;
        let mut at = Vec3::ZERO;
        let mut v = 10.0;
        let mut eye = Vec3::ZERO;
        // Constant speed along +Z (heading 0): the arm sits at rest.
        for _ in 0..180 {
            at.z += v * dt;
            eye = arm.step(0.0, 0.0, rest(at), &t, 1.0, dt).0;
        }
        assert!((eye - rest(at).0).length() < 0.05, "steady: {}", (eye - rest(at).0).length());
        // Hard acceleration pulls the eye back along the boom.
        let mut peak = 0.0f32;
        for _ in 0..40 {
            v += 15.0 * dt;
            at.z += v * dt;
            let e = arm.step(0.0, 0.0, rest(at), &t, 1.0, dt).0;
            peak = peak.max((rest(at).0 - e).z);
        }
        assert!(peak > 0.2, "boom stretch {peak}");
    }

    #[test]
    fn heading_is_limited_around_the_nose() {
        let t = ArmTuning::default();
        let rest = rest_pose(Vec3::ZERO, 1.0, 6.8, 2.3, 4.0, 0.9);
        let mut arm = Arm::new(Vec3::ZERO, 0.0, rest.0, rest.1);
        for _ in 0..300 {
            arm.step(0.0, 1.5, rest, &t, 1.0, 1.0 / 60.0);
        }
        assert!(arm.heading.abs() <= t.heading.hi + 1e-3, "{}", arm.heading);
    }
}
