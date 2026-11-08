//! Drivetrain maths as pure functions (unit-tested without a world): engine torque, gear ratios,
//! automatic shifting and the three differentials.

use super::spec::{Diff, EngineSpec, GearboxSpec};

/// Linear interpolation on `(rpm, Nm)` points.
pub fn curve(points: &[(f32, f32)], rpm: f32) -> f32 {
    match points {
        [] => 0.0,
        [(_, t)] => *t,
        _ => {
            if rpm <= points[0].0 {
                return points[0].1;
            }
            for w in points.windows(2) {
                if rpm <= w[1].0 {
                    let k = (rpm - w[0].0) / (w[1].0 - w[0].0).max(1e-3);
                    return w[0].1 + (w[1].1 - w[0].1) * k;
                }
            }
            points[points.len() - 1].1
        }
    }
}

/// Engine torque at the crank. Open throttle follows the curve (cut at the redline), closed
/// throttle is engine braking (negative, growing with rpm).
pub fn engine_torque(e: &EngineSpec, rpm: f32, throttle: f32) -> f32 {
    let drive = if rpm >= e.redline_rpm { 0.0 } else { curve(&e.torque, rpm) * throttle.clamp(0.0, 1.0) };
    let brake = e.engine_brake * (rpm / e.redline_rpm).clamp(0.0, 1.2) * (1.0 - throttle.clamp(0.0, 1.0));
    drive - brake
}

/// Signed overall ratio crank → wheels (negative in reverse, 0 in neutral), before the range.
pub fn gear_ratio(g: &GearboxSpec, gear: i32) -> f32 {
    match gear {
        0 => 0.0,
        -1 => -g.reverse * g.final_drive,
        n => g.ratios.get((n - 1) as usize).copied().unwrap_or(1.0) * g.final_drive,
    }
}

/// Wheel rad/s → engine rpm through `ratio` (absolute value).
pub fn rpm_of(omega: f32, ratio: f32) -> f32 {
    omega.abs() * ratio.abs() * 60.0 / std::f32::consts::TAU
}

/// Automatic gear choice. `speed` is the signed forward speed, `throttle` the signed pedal
/// (negative = reverse request), `rpm_in(gear)` the engine rpm the driven wheels would give in
/// that gear. Returns the new gear.
pub fn auto_gear(g: &GearboxSpec, gear: i32, speed: f32, throttle: f32, can_shift: bool, rpm_in: impl Fn(i32) -> f32) -> i32 {
    if throttle < -0.05 && speed < 1.0 {
        return -1;
    }
    if gear <= 0 {
        return if throttle > 0.05 && speed > -1.0 { 1 } else { gear };
    }
    if !can_shift {
        return gear;
    }
    let top = g.ratios.len() as i32;
    if gear < top && rpm_in(gear) > g.shift_up_rpm {
        return gear + 1;
    }
    if gear > 1 && rpm_in(gear) < g.shift_down_rpm {
        return gear - 1;
    }
    gear
}

/// Split an axle's drive torque `t` between its wheels given what each can transmit
/// (`cap_*`, N·m, from load and grip). Returns the torque delivered to each wheel.
///
/// - `Open`: equal torque, so the weaker wheel limits both (thrust = 2 × the weaker cap).
/// - `Locked`: the axle moves as one, each wheel gets up to its own cap (thrust = sum of caps).
/// - `LimitedSlip(k)`: blend between the two.
pub fn diff_split(diff: Diff, t: f32, cap_l: f32, cap_r: f32) -> (f32, f32) {
    let a = t.abs();
    let s = t.signum();
    let open = {
        let each = (a * 0.5).min(cap_l.min(cap_r) * 1.02);
        (each, each)
    };
    let locked = {
        let total = a.min(cap_l + cap_r);
        let sum = (cap_l + cap_r).max(1e-3);
        (total * cap_l / sum, total * cap_r / sum)
    };
    let k = match diff {
        Diff::Open => 0.0,
        Diff::Locked => 1.0,
        Diff::LimitedSlip(k) => k.clamp(0.0, 1.0),
    };
    ((open.0 + (locked.0 - open.0) * k) * s, (open.1 + (locked.1 - open.1) * k) * s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_diff_is_limited_by_the_weak_wheel_locked_is_not() {
        let (l, r) = diff_split(Diff::Open, 4000.0, 300.0, 1500.0);
        assert!((l - 306.0).abs() < 1.0 && (r - 306.0).abs() < 1.0, "{l} {r}");
        let (l, r) = diff_split(Diff::Locked, 4000.0, 300.0, 1500.0);
        assert!((l + r - 1800.0).abs() < 1.0 && r > l * 4.0, "{l} {r}");
        let (l, r) = diff_split(Diff::LimitedSlip(0.5), 4000.0, 300.0, 1500.0);
        assert!(l + r > 612.0 && l + r < 1800.0);
        // Reverse torque keeps its sign.
        assert!(diff_split(Diff::Locked, -100.0, 300.0, 300.0).0 < 0.0);
    }

    #[test]
    fn engine_curve_cuts_at_redline_and_brakes_when_closed() {
        let e = super::super::VehicleSpec::truck().engine;
        assert!(engine_torque(&e, 2500.0, 1.0) > 300.0);
        assert_eq!(engine_torque(&e, 6000.0, 1.0), -e.engine_brake * (6000.0 / e.redline_rpm).clamp(0.0, 1.2) * 0.0);
        assert!(engine_torque(&e, 3000.0, 0.0) < 0.0);
    }

    #[test]
    fn automatic_gearbox_shifts_with_rpm_and_reverses_from_a_stop() {
        let g = super::super::VehicleSpec::truck().gearbox;
        assert_eq!(auto_gear(&g, 1, 8.0, 1.0, true, |_| 4500.0), 2);
        assert_eq!(auto_gear(&g, 3, 8.0, 1.0, true, |_| 1000.0), 2);
        assert_eq!(auto_gear(&g, 1, 0.1, -1.0, true, |_| 900.0), -1);
        assert_eq!(auto_gear(&g, -1, 0.0, 0.5, true, |_| 900.0), 1);
    }
}
