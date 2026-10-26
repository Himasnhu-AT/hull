//! Utility AI: options scored from considerations (input → normalized → response curve),
//! multiplied with Dave Mark's compensation factor, best option picked with hysteresis.
//!
//! ```ignore
//! let ai = UtilityAi::new([
//!     UtilityOption::new("eat").consider(Consideration::new("hunger", |w, e, _| hunger(w, e), 0.0, 100.0, Curve::Power(2.0))),
//!     UtilityOption::new("sleep").weight(0.8).consider(..),
//! ]);
//! commands.spawn((ai, Blackboard::default()));   // writes bb["utility"] = "eat" / "sleep"
//! ```
//! Use [`UtilityOption::score`] inside a `Bt::utility` scorer to combine with behaviour trees.

use std::borrow::Cow;
use std::sync::Arc;

use bevy::prelude::*;
use serde_json::{Value, json};

use super::blackboard::Blackboard;

/// Response curve over a normalized input in `[0, 1]`; output clamped to `[0, 1]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Curve {
    /// `slope * x + offset`.
    Linear { slope: f32, offset: f32 },
    /// `x ^ exp`.
    Power(f32),
    /// `1 / (1 + e^(-steepness (x - mid)))`.
    Logistic { steepness: f32, mid: f32 },
    /// 1 above the threshold, else 0.
    Step(f32),
    /// `1 - x`.
    Inverse,
}

impl Curve {
    pub fn eval(&self, x: f32) -> f32 {
        let x = x.clamp(0.0, 1.0);
        let y = match *self {
            Curve::Linear { slope, offset } => slope * x + offset,
            Curve::Power(e) => x.powf(e),
            Curve::Logistic { steepness, mid } => 1.0 / (1.0 + (-steepness * (x - mid)).exp()),
            Curve::Step(t) => {
                if x >= t {
                    1.0
                } else {
                    0.0
                }
            }
            Curve::Inverse => 1.0 - x,
        };
        y.clamp(0.0, 1.0)
    }
}

pub type InputFn = Arc<dyn Fn(&World, Entity, &Blackboard) -> f32 + Send + Sync>;

/// One input to an option's score.
#[derive(Clone)]
pub struct Consideration {
    pub name: Cow<'static, str>,
    pub input: InputFn,
    pub min: f32,
    pub max: f32,
    pub curve: Curve,
}

impl Consideration {
    pub fn new(
        name: impl Into<Cow<'static, str>>,
        input: impl Fn(&World, Entity, &Blackboard) -> f32 + Send + Sync + 'static,
        min: f32,
        max: f32,
        curve: Curve,
    ) -> Self {
        Consideration { name: name.into(), input: Arc::new(input), min, max, curve }
    }

    /// Reads a blackboard float.
    pub fn blackboard(key: &'static str, min: f32, max: f32, curve: Curve) -> Self {
        Self::new(key, move |_, _, bb| bb.float(key).unwrap_or(min), min, max, curve)
    }

    pub fn eval(&self, w: &World, e: Entity, bb: &Blackboard) -> f32 {
        let raw = (self.input)(w, e, bb);
        let x = if self.max != self.min { (raw - self.min) / (self.max - self.min) } else { 0.0 };
        self.curve.eval(x)
    }
}

#[derive(Clone)]
pub struct UtilityOption {
    pub name: Cow<'static, str>,
    pub weight: f32,
    pub considerations: Vec<Consideration>,
}

impl UtilityOption {
    pub fn new(name: impl Into<Cow<'static, str>>) -> Self {
        UtilityOption { name: name.into(), weight: 1.0, considerations: Vec::new() }
    }
    pub fn weight(mut self, w: f32) -> Self {
        self.weight = w;
        self
    }
    pub fn consider(mut self, c: Consideration) -> Self {
        self.considerations.push(c);
        self
    }
    /// Product of considerations with compensation for their count, times the weight.
    pub fn score(&self, w: &World, e: Entity, bb: &Blackboard) -> f32 {
        let n = self.considerations.len();
        if n == 0 {
            return self.weight;
        }
        let modf = 1.0 - 1.0 / n as f32;
        let mut total = 1.0f32;
        for c in &self.considerations {
            let s = c.eval(w, e, bb);
            let make_up = (1.0 - s) * modf;
            total *= s + make_up * s;
            if total <= 0.0 {
                break;
            }
        }
        total * self.weight
    }
}

/// Picks the best [`UtilityOption`] every `interval` seconds; writes its name to the
/// blackboard key (default `"utility"`).
#[derive(Component, Clone)]
#[require(Blackboard)]
pub struct UtilityAi {
    pub options: Vec<UtilityOption>,
    /// Bonus the current option keeps (avoids flip-flopping).
    pub hysteresis: f32,
    pub interval: f32,
    pub bb_key: &'static str,
    pub current: Option<usize>,
    pub scores: Vec<f32>,
    pub(crate) next_eval: f64,
}

impl UtilityAi {
    pub fn new(options: impl IntoIterator<Item = UtilityOption>) -> Self {
        let options: Vec<_> = options.into_iter().collect();
        let n = options.len();
        UtilityAi { options, hysteresis: 0.1, interval: 0.0, bb_key: "utility", current: None, scores: vec![0.0; n], next_eval: f64::MIN }
    }

    pub fn current_name(&self) -> Option<&str> {
        self.current.map(|i| self.options[i].name.as_ref())
    }

    /// Scores all options and picks one (with hysteresis); returns the pick.
    pub fn evaluate(&mut self, w: &World, e: Entity, bb: &Blackboard) -> Option<usize> {
        self.scores.resize(self.options.len(), 0.0);
        let mut best = None;
        let mut best_s = 0.0f32;
        for (i, o) in self.options.iter().enumerate() {
            let mut s = o.score(w, e, bb);
            self.scores[i] = s;
            if Some(i) == self.current {
                s += self.hysteresis;
            }
            if s > best_s {
                best_s = s;
                best = Some(i);
            }
        }
        self.current = best;
        best
    }

    pub fn to_json(&self) -> Value {
        json!({
            "current": self.current_name(),
            "options": self.options.iter().zip(&self.scores).map(|(o, s)| json!({"name": o.name, "score": s})).collect::<Vec<_>>(),
        })
    }
}

/// Evaluates every due [`UtilityAi`] (called from the think step).
pub(crate) fn evaluate_all(world: &mut World, now: f64) {
    let mut q = world.query::<(Entity, &UtilityAi)>();
    let due: Vec<Entity> = q.iter(world).filter(|(_, u)| now >= u.next_eval).map(|(e, _)| e).collect();
    for e in due {
        let Some(mut u) = world.get_mut::<UtilityAi>(e).map(|mut u| std::mem::replace(&mut *u, UtilityAi::new([]))) else { continue };
        u.next_eval = now + u.interval as f64;
        let bb = world.get::<Blackboard>(e).cloned().unwrap_or_default();
        let pick = u.evaluate(world, e, &bb);
        let key = u.bb_key;
        let name = pick.map(|i| u.options[i].name.clone());
        if let Some(mut slot) = world.get_mut::<UtilityAi>(e) {
            *slot = u;
        }
        if let Some(mut b) = world.get_mut::<Blackboard>(e) {
            match name {
                Some(n) => b.set(key, super::blackboard::BbValue::Text(n)),
                None => {
                    b.remove(key);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curves_and_pick_with_hysteresis() {
        assert_eq!(Curve::Inverse.eval(0.25), 0.75);
        assert!((Curve::Power(2.0).eval(0.5) - 0.25).abs() < 1e-6);
        assert!(Curve::Logistic { steepness: 10.0, mid: 0.5 }.eval(0.9) > 0.95);
        let mut w = World::new();
        let e = w.spawn_empty().id();
        let mut ai = UtilityAi::new([
            UtilityOption::new("eat").consider(Consideration::blackboard("hunger", 0.0, 100.0, Curve::Linear { slope: 1.0, offset: 0.0 })),
            UtilityOption::new("rest").consider(Consideration::blackboard("tired", 0.0, 1.0, Curve::Linear { slope: 1.0, offset: 0.0 })),
        ]);
        let mut bb = Blackboard::default();
        bb.set("hunger", 70.0f32);
        bb.set("tired", 0.5f32);
        assert_eq!(ai.evaluate(&w, e, &bb), Some(0));
        bb.set("tired", 0.75f32); // 0.75 < 0.7 + 0.1
        assert_eq!(ai.evaluate(&w, e, &bb), Some(0));
        bb.set("tired", 0.85f32);
        assert_eq!(ai.evaluate(&w, e, &bb), Some(1));
        assert_eq!(ai.to_json()["current"], "rest");
    }
}
