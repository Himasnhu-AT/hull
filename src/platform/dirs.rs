//! User folders (Pictures, Documents, Saved Games) with a per-game subfolder.
//!
//! [`UserDirs`] knows where the OS keeps them (pure: build one with [`UserDirs::new`] in tests);
//! [`GameFolders`] adds the game's own subfolder and an optional redirect root (tests, portable
//! installs: `--platform-root <dir>` or env `PLATFORM_ROOT`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use bevy::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UserDir {
    Home,
    Desktop,
    Pictures,
    Documents,
    Videos,
    /// Where a game keeps its save games (Windows "Saved Games"; elsewhere an app-data folder).
    SavedGames,
}

impl UserDir {
    pub const ALL: [UserDir; 6] = [Self::Home, Self::Desktop, Self::Pictures, Self::Documents, Self::Videos, Self::SavedGames];

    pub fn name(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Desktop => "desktop",
            Self::Pictures => "pictures",
            Self::Documents => "documents",
            Self::Videos => "videos",
            Self::SavedGames => "saved_games",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        let s = s.to_ascii_lowercase().replace([' ', '-'], "_");
        Self::ALL.into_iter().find(|d| d.name() == s)
    }

    /// The XDG key (`XDG_PICTURES_DIR`) when there is one.
    fn xdg_key(self) -> Option<&'static str> {
        Some(match self {
            Self::Desktop => "DESKTOP",
            Self::Pictures => "PICTURES",
            Self::Documents => "DOCUMENTS",
            Self::Videos => "VIDEOS",
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OsKind {
    MacOs,
    Windows,
    Linux,
}

impl OsKind {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// Where the OS keeps the user's folders.
#[derive(Clone, Debug)]
pub struct UserDirs {
    pub os: OsKind,
    pub home: PathBuf,
    /// Linux: `~/.config/user-dirs.dirs` entries (`PICTURES` → path), plus `XDG_DATA_HOME`.
    pub xdg: HashMap<String, PathBuf>,
}

impl UserDirs {
    pub fn new(os: OsKind, home: impl Into<PathBuf>) -> Self {
        UserDirs { os, home: home.into(), xdg: HashMap::new() }
    }

    /// From the environment (`HOME` / `USERPROFILE`, and `user-dirs.dirs` on Linux).
    pub fn detect() -> Self {
        let os = OsKind::current();
        let var = if os == OsKind::Windows { "USERPROFILE" } else { "HOME" };
        let home = std::env::var_os(var).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let mut d = UserDirs::new(os, home);
        if os == OsKind::Linux {
            let cfg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| d.home.join(".config"));
            if let Ok(text) = std::fs::read_to_string(cfg.join("user-dirs.dirs")) {
                d.xdg = parse_user_dirs(&text, &d.home);
            }
            if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
                d.xdg.insert("DATA_HOME".into(), PathBuf::from(x));
            }
        }
        d
    }

    pub fn get(&self, dir: UserDir) -> PathBuf {
        let h = &self.home;
        match (dir, self.os) {
            (UserDir::Home, _) => h.clone(),
            (UserDir::SavedGames, OsKind::Windows) => h.join("Saved Games"),
            (UserDir::SavedGames, OsKind::MacOs) => h.join("Library/Application Support"),
            (UserDir::SavedGames, OsKind::Linux) => self.xdg.get("DATA_HOME").cloned().unwrap_or_else(|| h.join(".local/share")),
            (d, OsKind::Linux) => d.xdg_key().and_then(|k| self.xdg.get(k)).cloned().unwrap_or_else(|| h.join(plain_name(d))),
            (d, _) => h.join(plain_name(d)),
        }
    }
}

fn plain_name(d: UserDir) -> &'static str {
    match d {
        UserDir::Desktop => "Desktop",
        UserDir::Pictures => "Pictures",
        UserDir::Documents => "Documents",
        UserDir::Videos => if cfg!(target_os = "macos") { "Movies" } else { "Videos" },
        _ => "",
    }
}

/// `XDG_PICTURES_DIR="$HOME/Bilder"` lines → `PICTURES` → path.
pub fn parse_user_dirs(text: &str, home: &Path) -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("XDG_") else { continue };
        let Some((key, val)) = rest.split_once("_DIR=") else { continue };
        let val = val.trim().trim_matches('"');
        let path = match val.strip_prefix("$HOME") {
            Some(r) => home.join(r.trim_start_matches('/')),
            None => PathBuf::from(val),
        };
        out.insert(key.to_string(), path);
    }
    out
}

/// A folder name that is safe on every OS.
pub fn sanitize(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') { c } else { '_' }).collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "game".into() } else { s }
}

/// The game's folders: `<user dir>/<game title>`. With `root` set, every folder lives under
/// `<root>/<dir name>/<game title>` instead (tests, portable installs).
#[derive(Resource, Clone, Debug)]
pub struct GameFolders {
    pub game: String,
    pub dirs: UserDirs,
    pub root: Option<PathBuf>,
}

impl GameFolders {
    pub fn new(game_title: &str, dirs: UserDirs) -> Self {
        GameFolders { game: sanitize(game_title), dirs, root: None }
    }

    pub fn with_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.root = Some(root.into());
        self
    }

    /// The OS folder itself (`~/Pictures`), without the game subfolder.
    pub fn user(&self, dir: UserDir) -> PathBuf {
        match &self.root {
            Some(r) => r.join(dir.name()),
            None => self.dirs.get(dir),
        }
    }

    /// The game's subfolder (not created).
    pub fn path(&self, dir: UserDir) -> PathBuf {
        match dir {
            UserDir::Home => self.user(dir),
            _ => self.user(dir).join(&self.game),
        }
    }

    /// [`Self::path`], created.
    pub fn ensure(&self, dir: UserDir) -> std::io::Result<PathBuf> {
        let p = self.path(dir);
        std::fs::create_dir_all(&p)?;
        Ok(p)
    }

    /// A free file name in `dir`'s game folder: `stem.ext`, then `stem-2.ext`, ...
    pub fn unique_file(&self, dir: UserDir, stem: &str, ext: &str) -> std::io::Result<PathBuf> {
        let base = self.ensure(dir)?;
        let stem = sanitize(stem);
        let mut p = base.join(format!("{stem}.{ext}"));
        let mut n = 2;
        while p.exists() {
            p = base.join(format!("{stem}-{n}.{ext}"));
            n += 1;
        }
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_os_layout() {
        let mac = UserDirs::new(OsKind::MacOs, "/Users/a");
        assert_eq!(mac.get(UserDir::Pictures), PathBuf::from("/Users/a/Pictures"));
        assert_eq!(mac.get(UserDir::Videos), PathBuf::from("/Users/a/Movies"));
        assert_eq!(mac.get(UserDir::SavedGames), PathBuf::from("/Users/a/Library/Application Support"));
        let win = UserDirs::new(OsKind::Windows, "C:/Users/a");
        assert_eq!(win.get(UserDir::SavedGames), PathBuf::from("C:/Users/a/Saved Games"));
        let mut lin = UserDirs::new(OsKind::Linux, "/home/a");
        assert_eq!(lin.get(UserDir::Documents), PathBuf::from("/home/a/Documents"));
        lin.xdg = parse_user_dirs("# c\nXDG_PICTURES_DIR=\"$HOME/Bilder\"\nXDG_DOCUMENTS_DIR=\"/data/docs\"\n", &lin.home);
        assert_eq!(lin.get(UserDir::Pictures), PathBuf::from("/home/a/Bilder"));
        assert_eq!(lin.get(UserDir::Documents), PathBuf::from("/data/docs"));
        assert_eq!(lin.get(UserDir::SavedGames), PathBuf::from("/home/a/.local/share"));
    }

    #[test]
    fn game_subfolder_root_override_and_unique_names() {
        let tmp = std::env::temp_dir().join(format!("platform-dirs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let f = GameFolders::new("My: Game/1", UserDirs::new(OsKind::Linux, "/home/a"));
        assert_eq!(f.path(UserDir::Pictures), PathBuf::from("/home/a/Pictures/My_ Game_1"));
        let f = f.with_root(&tmp);
        assert_eq!(f.path(UserDir::Pictures), tmp.join("pictures/My_ Game_1"));
        let a = f.unique_file(UserDir::Pictures, "shot", "png").unwrap();
        std::fs::write(&a, b"x").unwrap();
        let b = f.unique_file(UserDir::Pictures, "shot", "png").unwrap();
        assert_ne!(a, b);
        assert!(b.ends_with("shot-2.png"));
        assert_eq!(UserDir::parse("Saved Games"), Some(UserDir::SavedGames));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
