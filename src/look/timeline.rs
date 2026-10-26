//! Animating a [`Look`]: [`LookTransition`] (A → B over n seconds) and [`LookTimeline`]
//! (keyframed looks over a looping clock, e.g. a day cycle). Both write the `Look` resource;
//! the apply system follows. Time is virtual time, so both pause with the game.

use bevy::prelude::*;

use super::desc::Look;

/// Blend the current look into `to` over `duration` seconds (smoothstep). Removed when done.
#[derive(Resource, Clone, Debug)]
pub struct LookTransition {
    pub from: Look,
    pub to: Look,
    pub duration: f32,
    pub elapsed: f32,
}

impl LookTransition {
    pub fn new(from: Look, to: Look, duration: f32) -> Self {
        LookTransition { from, to, duration: duration.max(0.0), elapsed: 0.0 }
    }

    /// 0..1 progress, eased.
    pub fn t(&self) -> f32 {
        let x = if self.duration <= 0.0 { 1.0 } else { (self.elapsed / self.duration).clamp(0.0, 1.0) };
        x * x * (3.0 - 2.0 * x)
    }
}

/// Keyframed looks on a looping clock: `keys` are `(time, look)` sorted by time in
/// `0..period`. With `period = 24` and `speed = 24.0 / 600.0` a day lasts ten minutes.
#[derive(Resource, Clone, Debug)]
pub struct LookTimeline {
    pub keys: Vec<(f32, Look)>,
    pub time: f32,
    pub period: f32,
    /// Clock units per second (0 = frozen; set `time` yourself).
    pub speed: f32,
}

impl LookTimeline {
    /// A 24 h day: night 0 h, dusk-ish dawn 6 h, day 12 h, dusk 18.5 h.
    pub fn day_cycle(speed: f32) -> Self {
        let mut dawn = Look::dusk();
        dawn.name = "dawn".into();
        dawn.sun.azimuth_deg = 100.0;
        LookTimeline {
            keys: vec![(0.0, Look::night()), (6.0, dawn), (12.0, Look::clear_day()), (18.5, Look::dusk()), (21.0, Look::night())],
            time: 12.0,
            period: 24.0,
            speed,
        }
    }

    /// The look at `time` (wraps; blends between neighbouring keys).
    pub fn sample(&self, time: f32) -> Option<Look> {
        let n = self.keys.len();
        if n == 0 {
            return None;
        }
        if n == 1 {
            return Some(self.keys[0].1.clone());
        }
        let p = self.period.max(1e-3);
        let t = time.rem_euclid(p);
        let i = self.keys.iter().rposition(|(k, _)| *k <= t).unwrap_or(n - 1);
        let j = (i + 1) % n;
        let (a, b) = (self.keys[i].0, self.keys[j].0);
        let span = (b - a).rem_euclid(p);
        let x = if span <= 1e-6 { 0.0 } else { ((t - a).rem_euclid(p) / span).clamp(0.0, 1.0) };
        Some(self.keys[i].1.blend(&self.keys[j].1, x))
    }
}

pub fn advance_transition(mut commands: Commands, time: Res<Time>, tr: Option<ResMut<LookTransition>>, look: Option<ResMut<Look>>) {
    let Some(mut tr) = tr else { return };
    tr.elapsed += time.delta_secs();
    let t = tr.t();
    match look {
        Some(mut l) => *l = tr.from.blend(&tr.to, t),
        None => commands.insert_resource(tr.from.blend(&tr.to, t)),
    }
    if t >= 1.0 {
        commands.remove_resource::<LookTransition>();
    }
}

pub fn advance_timeline(mut commands: Commands, time: Res<Time>, tl: Option<ResMut<LookTimeline>>, look: Option<ResMut<Look>>) {
    let Some(mut tl) = tl else { return };
    let dt = time.delta_secs() * tl.speed;
    if dt == 0.0 && !tl.is_changed() {
        return;
    }
    let p = tl.period.max(1e-3);
    tl.time = (tl.time + dt).rem_euclid(p);
    let Some(next) = tl.sample(tl.time) else { return };
    match look {
        Some(mut l) => {
            if *l != next {
                *l = next;
            }
        }
        None => commands.insert_resource(next),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_wraps_and_blends() {
        let tl = LookTimeline::day_cycle(1.0);
        assert_eq!(tl.sample(12.0).unwrap().name, "clear_day");
        let late = tl.sample(23.0).unwrap();
        let night = Look::night();
        // Between 21 h (night) and 0 h (night): night.
        assert!((late.exposure.ev100 - night.exposure.ev100).abs() < 1e-4);
        let nine = tl.sample(9.0).unwrap();
        let (dawn, day) = (tl.keys[1].1.exposure.ev100, Look::clear_day().exposure.ev100);
        assert!(nine.exposure.ev100 > dawn && nine.exposure.ev100 < day);
        assert_eq!(tl.sample(36.0).unwrap().name, "clear_day");
    }

    #[test]
    fn transition_eases_to_one() {
        let mut tr = LookTransition::new(Look::clear_day(), Look::dusk(), 2.0);
        assert_eq!(tr.t(), 0.0);
        tr.elapsed = 1.0;
        assert!((tr.t() - 0.5).abs() < 1e-6);
        tr.elapsed = 5.0;
        assert_eq!(tr.t(), 1.0);
    }
}
