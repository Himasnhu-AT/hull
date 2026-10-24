//! Data + asset folders, keyed by [`crate::GameInfo::id`]. Owner: core stream.
//!
//! Env overrides use the id uppercased with non-alphanumerics as `_`: id `"orbs"` →
//! `ORBS_DATA_DIR`, `ORBS_ASSETS`.

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

    /// Reads `<data>/<name>` as JSON (save games, records, unlocks). Missing → `T::default()`;
    /// unreadable or corrupt → default + warning, and a corrupt file is moved aside to
    /// `<name>.corrupt` so the next save doesn't silently destroy it. Put `#[serde(default)]` on
    /// `T` so files from older versions still load.
    pub fn load_json<T: serde::de::DeserializeOwned + Default>(&self, name: &str) -> T {
        load_json(&self.file(name))
    }

    /// Writes `value` to `<data>/<name>` as pretty JSON, atomically (temp file + rename).
    pub fn save_json<T: serde::Serialize>(&self, name: &str, value: &T) -> std::io::Result<()> {
        save_json(&self.file(name), value)
    }
}

/// [`DataDir::load_json`] for any path.
pub fn load_json<T: serde::de::DeserializeOwned + Default>(path: &std::path::Path) -> T {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return T::default(),
        Err(e) => {
            warn!("could not read {}: {e}; using defaults", path.display());
            return T::default();
        }
    };
    serde_json::from_str(&text).unwrap_or_else(|e| {
        let mut aside = path.as_os_str().to_owned();
        aside.push(".corrupt");
        warn!("{} is corrupt ({e}); using defaults (moved to {})", path.display(), aside.to_string_lossy());
        let _ = std::fs::rename(path, &aside);
        T::default()
    })
}

/// [`DataDir::save_json`] for any path.
pub fn save_json<T: serde::Serialize>(path: &std::path::Path, value: &T) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    write_atomic(path, &text)
}

/// Writes `text` to a temp file next to `path`, then renames it over `path` (creating folders).
pub fn write_atomic(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// `"my-game"` → `"MY_GAME"`: prefix for this game's env overrides.
pub fn env_prefix(info: &crate::GameInfo) -> String {
    info.id.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect()
}

/// Resolve (and create) the data folder for `info`: `<ID>_DATA_DIR`, else the platform data
/// folder (`~/Library/Application Support/<id>`, `~/.local/share/<id>`,
/// `%APPDATA%\<id>\data`), else `./<id>-data`.
pub fn data_dir(info: &crate::GameInfo) -> PathBuf {
    let dir = match std::env::var_os(format!("{}_DATA_DIR", env_prefix(info))) {
        Some(d) => PathBuf::from(d),
        None => directories::ProjectDirs::from("", "", info.id)
            .map(|d| d.data_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from(format!("{}-data", info.id))),
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        warn!("data dir {}: {e}", dir.display());
    }
    dir
}

/// Resolve the assets folder for `info`: `<ID>_ASSETS`, macOS bundle `Contents/Resources/assets`,
/// `./assets`, then `info.assets_fallback`, then `assets` (relative; may not exist).
pub fn assets_dir(info: &crate::GameInfo) -> PathBuf {
    if let Some(dir) = std::env::var_os(format!("{}_ASSETS", env_prefix(info))) {
        return PathBuf::from(dir);
    }
    // Inside a macOS app bundle: Game.app/Contents/MacOS/<bin> -> Contents/Resources/assets.
    if let Ok(exe) = std::env::current_exe()
        && let Some(contents) = exe.parent().and_then(|p| p.parent())
    {
        let p = contents.join("Resources/assets");
        if p.is_dir() {
            return p;
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("assets");
        if p.is_dir() {
            return p;
        }
    }
    match info.assets_fallback {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from("assets"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_prefix_uppercases_and_sanitises() {
        assert_eq!(env_prefix(&crate::GameInfo::new("my-game2", "X")), "MY_GAME2");
    }
}
