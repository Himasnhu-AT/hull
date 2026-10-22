//! Metrics registry + debug metrics window. Owner: metrics stream. Contract:
//!
//! Any system records named samples: `metrics.record("render.meshes_visible", n as f64)`.
//! One sample per key per frame (last write wins). Keys are `group.name`; the window groups
//! charts by the part before the dot. History is kept per key (ring buffer) and summarised
//! per session for comparing runs.

use std::collections::BTreeMap;

use bevy::prelude::*;

/// Samples kept per key (about 10 s at 60 fps of raw frames).
pub const HISTORY: usize = 600;

#[derive(Resource, Default, Debug)]
pub struct Metrics {
    series: BTreeMap<&'static str, Vec<f64>>,
}

impl Metrics {
    /// Record this frame's value for `key` (`group.name`).
    pub fn record(&mut self, key: &'static str, value: f64) {
        let s = self.series.entry(key).or_default();
        if s.len() == HISTORY {
            s.remove(0);
        }
        s.push(value);
    }

    /// Every key with its history, oldest first.
    pub fn iter(&self) -> impl Iterator<Item = (&'static str, &[f64])> {
        self.series.iter().map(|(k, v)| (*k, v.as_slice()))
    }

    pub fn latest(&self, key: &str) -> Option<f64> {
        self.series.get(key).and_then(|s| s.last().copied())
    }
}

pub struct MetricsPlugin;

impl Plugin for MetricsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Metrics>();
    }
}
