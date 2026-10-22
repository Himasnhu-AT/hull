//! Data + asset folders. Owner: core stream (port `ops::data_dir` and `assets::assets_dir`
//! from Shroud, keyed by [`crate::GameInfo::id`]).

use bevy::prelude::*;
use std::path::PathBuf;

/// The game's writable data folder (settings.json, saves, logs). `<ID>_DATA_DIR` overrides.
#[derive(Resource, Clone, Debug)]
pub struct DataDir(pub PathBuf);

/// Absolute assets root. [`AssetsDir::has`] lets games fall back when optional assets are missing.
#[derive(Resource, Clone, Debug)]
pub struct AssetsDir(pub PathBuf);

impl AssetsDir {
    pub fn has(&self, rel: &str) -> bool {
        self.0.join(rel).is_file()
    }
}

impl DataDir {
    pub fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

/// Resolve (and create) the data folder for `info`.
pub fn data_dir(info: &crate::GameInfo) -> PathBuf {
    let _ = info;
    todo!("core stream")
}

/// Resolve the assets folder for `info`: `<ID>_ASSETS`, macOS bundle `Contents/Resources/assets`,
/// `./assets`, then `info.assets_fallback`.
pub fn assets_dir(info: &crate::GameInfo) -> PathBuf {
    let _ = info;
    todo!("core stream")
}
