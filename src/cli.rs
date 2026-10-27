//! Command-line helpers shared by engine and games. Owner: core stream.
//! Engine flags: `--headless`, `--offscreen`, `--control <port>`, `--play` (skip the menu),
//! `--quit-after <s>`, `--seed <n>`, `--mute`, `--sound`, `--volume <0..1>`, `--crash-test`,
//! `--uncapped` (vsync off and full speed while unfocused: frame-time benchmarks in hidden
//! `--offscreen` windows; never saved to settings).
//!
//! Those engine flags are test/debug tools: they are read through [`dev_flag`] / [`dev_value`],
//! which only see the command line when the `devtools` feature is on. A ship build
//! (`--no-default-features`) ignores them, so players can't open a control port, skip the menu,
//! hide the window or crash the game from the command line. [`has_flag`] / [`arg_value`] stay
//! available for a game's own player-facing flags.

use bevy::prelude::*;

/// Value of `--<name> <value>` or `--<name>=<value>`.
pub fn arg_value(name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let mut args = std::env::args();
    while let Some(a) = args.next() {
        if a == flag {
            return args.next();
        }
        if let Some(v) = a.strip_prefix(&format!("{flag}=")) {
            return Some(v.to_string());
        }
    }
    None
}

/// Whether `--<name>` is on the command line.
pub fn has_flag(name: &str) -> bool {
    let flag = format!("--{name}");
    std::env::args().any(|a| a == flag)
}

/// [`has_flag`] for engine debug flags: always `false` without the `devtools` feature.
pub fn dev_flag(name: &str) -> bool {
    cfg!(feature = "devtools") && has_flag(name)
}

/// [`arg_value`] for engine debug flags: always `None` without the `devtools` feature.
pub fn dev_value(name: &str) -> Option<String> {
    if cfg!(feature = "devtools") { arg_value(name) } else { None }
}

/// Runs driven by the control port / MCP / offscreen tests: never grab the mouse, never
/// change window mode, never play sound unless `--sound`. Always `false` in ship builds.
pub fn test_driven() -> bool {
    dev_flag("control") || dev_flag("offscreen") || dev_flag("mcp")
}

/// `--uncapped` (devtools builds): no vsync, no frame pacing while unfocused, for benchmarks.
pub fn uncapped() -> bool {
    dev_flag("uncapped")
}

/// RNG seed for the run: `--seed <n>` for deterministic tests (devtools builds), otherwise random.
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub struct GameSeed(pub u64);

impl GameSeed {
    pub fn from_args() -> Self {
        GameSeed(dev_value("seed").and_then(|s| s.parse().ok()).unwrap_or_else(rand::random))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The test binary has no engine flags, so these are off either way; in a ship build
    /// (`--no-default-features`) they must be off even if a player passes the flag.
    #[test]
    fn debug_flags_need_devtools() {
        assert!(!test_driven());
        #[cfg(not(feature = "devtools"))]
        {
            assert!(!dev_flag("control"));
            assert!(dev_value("quit-after").is_none());
        }
    }
}
