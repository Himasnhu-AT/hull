//! OS integration from script (`src/platform`): user folders, file browser, clipboard,
//! notifications, button glyphs, screenshots with metadata, window and cursor mode, text fields.
//!
//! `user_dir(name)` / `game_dir(name)` (`pictures`, `documents`, `saved_games`, ...),
//! `open_path(path)`, `open_url(url)`, `clipboard_get()`, `clipboard_set(text)`,
//! `notify(title, body)`, `get_glyph(action)`, `get_glyph_icon(action)`,
//! `hint_bar([[action, label], ...])`, `save_screenshot(name [, [k, v, k, v, ...]])`,
//! `set_window_mode(name)`, `get_window_mode()`, `set_cursor_mode(name)`,
//! `text_get([n])`, `text_set([n,] s)`, `text_focus([n])`.

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{s, split, world};
use crate::platform::{GameFolders, Platform, SaveScreenshot, TextFocus, TextInput, UserDir, WindowSettings};

fn dir_arg(a: &[RV], usage: &str) -> Result<UserDir, String> {
    let n = s(a.first().ok_or_else(|| format!("usage: {usage}"))?, "folder")?;
    UserDir::parse(n).ok_or_else(|| format!("unknown folder `{n}` (home, desktop, pictures, documents, videos, saved_games)"))
}

fn path_str(p: std::path::PathBuf) -> RV {
    RV::Str(p.display().to_string())
}

fn platform(w: &World) -> Result<&Platform, String> {
    w.get_resource::<Platform>().ok_or_else(|| "the platform module is not set up in this app".to_string())
}

pub(super) fn register(e: &mut Engine) {
    e.register("user_dir", |c, a| {
        let w = world(c)?;
        let d = dir_arg(a, "user_dir(name)")?;
        Ok(path_str(w.get_resource::<GameFolders>().ok_or("platform folders are not set up")?.user(d)))
    });
    e.register("game_dir", |c, a| {
        let w = world(c)?;
        let d = dir_arg(a, "game_dir(name)")?;
        let f = w.get_resource::<GameFolders>().ok_or("platform folders are not set up")?;
        Ok(path_str(f.ensure(d).map_err(|e| e.to_string())?))
    });
    e.register("open_path", |c, a| {
        let w = world(c)?;
        let p = s(a.first().ok_or("usage: open_path(path)")?, "path")?;
        platform(w)?.open_path(std::path::Path::new(p))?;
        Ok(RV::Void)
    });
    e.register("open_url", |c, a| {
        let w = world(c)?;
        platform(w)?.open_url(s(a.first().ok_or("usage: open_url(url)")?, "url")?)?;
        Ok(RV::Void)
    });
    e.register("clipboard_get", |c, _| Ok(RV::Str(platform(world(c)?)?.clipboard_get()?)));
    e.register("clipboard_set", |c, a| {
        let w = world(c)?;
        platform(w)?.clipboard_set(&a.first().ok_or("usage: clipboard_set(text)")?.to_string())?;
        Ok(RV::Void)
    });
    e.register("notify", |c, a| {
        let w = world(c)?;
        let title = a.first().ok_or("usage: notify(title [, body])")?.to_string();
        let body = a.get(1).map(|v| v.to_string()).unwrap_or_default();
        platform(w)?.notify(&title, &body)?;
        Ok(RV::Void)
    });
    #[cfg(feature = "actions")]
    glyphs(e);
    e.register("save_screenshot", |c, a| {
        let w = world(c)?;
        let mut shot = SaveScreenshot::new(s(a.first().ok_or("usage: save_screenshot(name [, [k, v, ...]])")?, "name")?);
        if let Some(RV::Array(kv)) = a.get(1) {
            for pair in kv.borrow().chunks(2) {
                if let [k, v] = pair {
                    shot = shot.meta(k.to_string(), v.to_string());
                }
            }
        }
        if !w.contains_resource::<Messages<SaveScreenshot>>() {
            return Err("the platform module is not set up in this app".into());
        }
        w.write_message(shot);
        Ok(RV::Void)
    });
    e.register("set_window_mode", |c, a| {
        let w = world(c)?;
        let name = s(a.first().ok_or("usage: set_window_mode(name)")?, "mode")?;
        let mode = match name {
            "windowed" => crate::settings::WindowModeSetting::Windowed,
            "borderless" => crate::settings::WindowModeSetting::Borderless,
            "fullscreen" => crate::settings::WindowModeSetting::Fullscreen,
            other => return Err(format!("unknown window mode `{other}` (windowed, borderless, fullscreen)")),
        };
        let mut ws = w.get_resource_mut::<WindowSettings>().ok_or("the platform module is not set up in this app")?;
        ws.override_core = true;
        ws.mode = mode;
        Ok(RV::Void)
    });
    e.register("get_window_mode", |c, _| {
        let w = world(c)?;
        let ws = w.get_resource::<WindowSettings>().ok_or("the platform module is not set up in this app")?;
        let mode = if ws.override_core { ws.mode } else { w.get_resource::<crate::settings::CoreSettings>().map_or(ws.mode, |c| c.window_mode) };
        Ok(RV::Str(format!("{mode:?}").to_lowercase()))
    });
    e.register("set_cursor_mode", |c, a| {
        let w = world(c)?;
        let name = s(a.first().ok_or("usage: set_cursor_mode(name)")?, "mode")?;
        let m = crate::platform::CursorMode::parse(name).ok_or_else(|| format!("unknown cursor mode `{name}` (auto, free, hidden, locked, confined)"))?;
        w.get_resource_mut::<WindowSettings>().ok_or("the platform module is not set up in this app")?.cursor = m;
        Ok(RV::Void)
    });
    e.register("text_get", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "text_get([node])")?;
        Ok(RV::Str(w.get::<TextInput>(t).ok_or_else(|| format!("entity {t} has no TextInput"))?.text.clone()))
    });
    e.register("text_set", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "text_set([node,] text)")?;
        w.get_mut::<TextInput>(t).ok_or_else(|| format!("entity {t} has no TextInput"))?.set_text(r[0].to_string());
        Ok(RV::Void)
    });
    e.register("text_focus", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "text_focus([node])")?;
        w.get_resource_mut::<TextFocus>().ok_or("the platform module is not set up in this app")?.set(t);
        Ok(RV::Void)
    });
}

#[cfg(feature = "actions")]
fn glyphs(e: &mut Engine) {
    use crate::actions::binding::Device;
    use crate::platform::glyphs::{PadStyle, glyph, hint_bar};

    fn ctx(w: &World) -> Result<(&crate::actions::ActionMap, Device, crate::platform::glyphs::PadFamily), String> {
        let map = w.get_resource::<crate::actions::ActionMap>().ok_or("actions are not set up in this app")?;
        let dev = w.get_resource::<crate::actions::ActionState>().map_or(Device::KeyboardMouse, |s| s.last_device);
        Ok((map, dev, w.get_resource::<PadStyle>().map_or_else(Default::default, |p| p.0)))
    }
    e.register("get_glyph", |c, a| {
        let w = world(c)?;
        let (m, d, f) = ctx(w)?;
        Ok(RV::Str(glyph(m, s(a.first().ok_or("usage: get_glyph(action)")?, "action")?, d, f).text))
    });
    e.register("get_glyph_icon", |c, a| {
        let w = world(c)?;
        let (m, d, f) = ctx(w)?;
        Ok(RV::Str(glyph(m, s(a.first().ok_or("usage: get_glyph_icon(action)")?, "action")?, d, f).icon))
    });
    e.register("hint_bar", |c, a| {
        let w = world(c)?;
        let (m, d, f) = ctx(w)?;
        let Some(RV::Array(items)) = a.first() else { return Err("usage: hint_bar([[action, label], ...])".into()) };
        let mut pairs: Vec<(String, String)> = vec![];
        for it in items.borrow().iter() {
            let RV::Array(p) = it else { return Err("hint_bar items are [action, label] pairs".into()) };
            let p = p.borrow();
            let (Some(RV::Str(act)), Some(l)) = (p.first(), p.get(1)) else { return Err("hint_bar items are [action, label] pairs".into()) };
            pairs.push((act.clone(), l.to_string()));
        }
        let refs: Vec<(&str, &str)> = pairs.iter().map(|(a, l)| (a.as_str(), l.as_str())).collect();
        Ok(RV::Str(hint_bar(m, d, f, &refs)))
    });
}
