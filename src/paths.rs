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

/// Assets shipped with the executable `exe`: inside a macOS app bundle
/// (`Game.app/Contents/MacOS/<bin>` → `Contents/Resources/assets`), else an `assets` folder next
/// to the executable (Windows / Linux ship layout, whatever the working folder is).
pub fn shipped_assets(exe: &std::path::Path) -> Option<PathBuf> {
    let bin_dir = exe.parent()?;
    if let Some(contents) = bin_dir.parent() {
        let p = contents.join("Resources/assets");
        if p.is_dir() {
            return Some(p);
        }
    }
    let p = bin_dir.join("assets");
    p.is_dir().then_some(p)
}

/// Resolve the assets folder for `info`: `<ID>_ASSETS`, macOS bundle `Contents/Resources/assets`,
/// `assets` next to the executable,
/// `info.assets_fallback` when that folder exists (a game's own source folder, usually
/// `concat!(env!("CARGO_MANIFEST_DIR"), "/assets")`; absent on players' machines), `./assets`,
/// then `assets` (relative; may not exist). The fallback comes before `./assets` so a game run
/// from another project's folder (the engine's scripts) doesn't pick up that project's assets.
pub fn assets_dir(info: &crate::GameInfo) -> PathBuf {
    if let Some(dir) = std::env::var_os(format!("{}_ASSETS", env_prefix(info))) {
        return PathBuf::from(dir);
    }
    if let Some(p) = std::env::current_exe().ok().and_then(|exe| shipped_assets(&exe)) {
        return p;
    }
    if let Some(p) = info.assets_fallback.map(PathBuf::from)
        && p.is_dir()
    {
        return p;
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
    fn game_folder_beats_the_working_directory() {
        let dir = std::env::temp_dir().join(format!("assets-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p: &'static str = Box::leak(dir.to_string_lossy().into_owned().into_boxed_str());
        let info = crate::GameInfo::new("assets-test-game", "X").assets_fallback(p);
        assert_eq!(assets_dir(&info), dir);
        // A fallback that doesn't exist (a dev path on a player's machine) is skipped.
        let gone = crate::GameInfo::new("assets-test-game", "X").assets_fallback("/nonexistent/assets");
        // (cargo runs tests from the crate root, which has an assets/ folder).
        assert_eq!(assets_dir(&gone), std::env::current_dir().unwrap().join("assets"));
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn assets_next_to_the_executable_are_found() {
        let root = std::env::temp_dir().join(format!("exe-assets-test-{}", std::process::id()));
        // Windows / Linux layout: <dir>/game.exe + <dir>/assets.
        let flat = root.join("flat");
        std::fs::create_dir_all(flat.join("assets")).unwrap();
        assert_eq!(shipped_assets(&flat.join("game.exe")), Some(flat.join("assets")));
        // macOS bundle wins over a sibling folder.
        let bundle = root.join("Game.app/Contents");
        std::fs::create_dir_all(bundle.join("Resources/assets")).unwrap();
        std::fs::create_dir_all(bundle.join("MacOS/assets")).unwrap();
        assert_eq!(shipped_assets(&bundle.join("MacOS/game")), Some(bundle.join("Resources/assets")));
        // Nothing shipped (a dev build in target/debug): fall through to the other rules.
        let bare = root.join("bare/debug");
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(shipped_assets(&bare.join("game")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn env_prefix_uppercases_and_sanitises() {
        assert_eq!(env_prefix(&crate::GameInfo::new("my-game2", "X")), "MY_GAME2");
    }
}
