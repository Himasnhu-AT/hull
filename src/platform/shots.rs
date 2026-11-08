//! Saving screenshots (or any RGBA image) to the user's Pictures folder with embedded metadata.
//!
//! * [`save_png`] writes pixels you have, with extra key/values, into `Pictures/<game>/`.
//! * `SaveScreenshot` (message) captures the window (or the offscreen target) and does the same;
//!   `ScreenshotSaved` reports the path. The default metadata is `Software`, `game`, `version`
//!   and `captured_unix`; yours are added after (a later duplicate key wins when read back).

use std::path::PathBuf;

use bevy::prelude::*;
use bevy::render::view::window::screenshot::{Screenshot, ScreenshotCaptured};

use super::dirs::{GameFolders, UserDir};
use super::imgmeta;

/// Writes `rgba` (`w * h * 4` bytes) as `<dir>/<game>/<name>[-n].png` with `meta` embedded.
pub fn save_png(folders: &GameFolders, dir: UserDir, name: &str, rgba: &[u8], w: u32, h: u32, meta: &[(&str, &str)]) -> Result<PathBuf, String> {
    let png = imgmeta::png_add_text(&imgmeta::encode_png(rgba, w, h)?, meta)?;
    let path = folders.unique_file(dir, name, "png").map_err(|e| e.to_string())?;
    std::fs::write(&path, png).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

/// Capture the window and save it to Pictures.
#[derive(Message, Clone, Debug, Default)]
pub struct SaveScreenshot {
    /// File name stem (default `screenshot`).
    pub name: String,
    pub meta: Vec<(String, String)>,
    /// Where to save (default `Pictures`).
    pub dir: Option<UserDir>,
}

impl SaveScreenshot {
    pub fn new(name: impl Into<String>) -> Self {
        SaveScreenshot { name: name.into(), ..default() }
    }
    pub fn meta(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.meta.push((k.into(), v.into()));
        self
    }
}

#[derive(Message, Clone, Debug)]
pub struct ScreenshotSaved(pub Result<PathBuf, String>);

/// The last result, for UIs and `platform.info`.
#[derive(Resource, Default, Debug)]
pub struct ShotStatus {
    pub last: Option<PathBuf>,
    pub error: Option<String>,
    pub count: u32,
}

pub(super) fn request(mut commands: Commands, mut reqs: MessageReader<SaveScreenshot>, offscreen: Option<Res<OffscreenHandle>>) {
    for r in reqs.read() {
        let r = r.clone();
        let shot = match &offscreen {
            Some(t) => Screenshot::image(t.0.clone()),
            None => Screenshot::primary_window(),
        };
        commands.spawn(shot).observe(
            move |ev: On<ScreenshotCaptured>,
                  folders: Res<GameFolders>,
                  info: Res<crate::GameInfo>,
                  mut out: MessageWriter<ScreenshotSaved>,
                  mut status: ResMut<ShotStatus>| {
                let result = ev.image.clone().try_into_dynamic().map_err(|e| e.to_string()).and_then(|d| {
                    let rgba = d.to_rgba8();
                    let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()).to_string();
                    let software = format!("{} {}", info.id, info.version);
                    let mut meta: Vec<(&str, &str)> = vec![("Software", &software), ("game", info.title), ("version", info.version), ("captured_unix", &unix)];
                    meta.extend(r.meta.iter().map(|(k, v)| (k.as_str(), v.as_str())));
                    let name = if r.name.is_empty() { "screenshot" } else { &r.name };
                    save_png(&folders, r.dir.unwrap_or(UserDir::Pictures), name, rgba.as_raw(), rgba.width(), rgba.height(), &meta)
                });
                match &result {
                    Ok(p) => {
                        status.last = Some(p.clone());
                        status.error = None;
                        status.count += 1;
                    }
                    Err(e) => status.error = Some(e.clone()),
                }
                out.write(ScreenshotSaved(result));
            },
        );
    }
}

/// The offscreen render target when devtools made one (so offscreen runs can screenshot).
#[derive(Resource, Clone)]
pub struct OffscreenHandle(pub Handle<Image>);

#[cfg(feature = "devtools")]
pub(super) fn track_offscreen(mut commands: Commands, t: Option<Res<crate::devtools::offscreen::OffscreenTarget>>, have: Option<Res<OffscreenHandle>>) {
    if have.is_none()
        && let Some(t) = t
    {
        commands.insert_resource(OffscreenHandle(t.0.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::dirs::{OsKind, UserDirs};

    #[test]
    fn saved_png_carries_its_metadata_in_the_game_folder() {
        let tmp = std::env::temp_dir().join(format!("platform-shots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let folders = GameFolders::new("Demo", UserDirs::new(OsKind::Linux, "/h")).with_root(&tmp);
        let px = vec![200u8; 4 * 3 * 2];
        let p = save_png(&folders, UserDir::Pictures, "view", &px, 3, 2, &[("seed", "7"), ("place", "ridge")]).unwrap();
        assert_eq!(p, tmp.join("pictures/Demo/view.png"));
        let bytes = std::fs::read(&p).unwrap();
        assert_eq!(imgmeta::png_read_text(&bytes), vec![("seed".to_string(), "7".to_string()), ("place".to_string(), "ridge".to_string())]);
        assert!(save_png(&folders, UserDir::Pictures, "view", &px[..5], 3, 2, &[]).is_err());
        let p2 = save_png(&folders, UserDir::Pictures, "view", &px, 3, 2, &[]).unwrap();
        assert!(p2.ends_with("view-2.png"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
