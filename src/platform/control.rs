//! `platform.*` control commands.
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `platform.info` | none | os, implementation, folders, window settings + info, focus policy, text focus, last screenshot |
//! | `platform.clipboard` | `{text?}` (set) | `{text}` |
//! | `platform.open` | `{path}` or `{dir}` (a user folder name) | `{}` |
//! | `platform.notify` | `{title, body?}` | `{}` |
//! | `platform.window` | merge-patch of `WindowSettings` (`{mode, cursor, ...}`) | the settings |
//! | `platform.glyph` | `{action, device?: kbm/pad, family?: xbox/ps/switch}` | `{text, icon}` |
//! | `platform.screenshot` | `{name?, meta?: {k: v}}` | `{}` (saved a frame later; see `platform.info`) |

use bevy::prelude::{App, Messages, World};
use serde_json::{Value, json};

use super::*;
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    app.add_control_command("platform.info", "OS integration state: folders, window, focus, screenshots", params(&[]), info)
        .add_control_command("platform.clipboard", "Read (or set with `text`) the clipboard", params(&[("text", "string", "set the clipboard to this")]), clipboard)
        .add_control_command("platform.open", "Open a path or user folder in the OS file browser", params(&[("path", "string", "file or folder"), ("dir", "string", "pictures, documents, saved_games, ...")]), open)
        .add_control_command("platform.notify", "Show an OS notification", params(&[("title", "string", ""), ("body", "string", "")]), notify)
        .add_control_command("platform.window", "Merge a change into WindowSettings (mode, monitor, size, scale_override, vsync, cursor, override_core)", params(&[]), window)
        .add_control_command(
            "platform.glyph",
            "Prompt glyph of an action",
            params(&[("action", "string", ""), ("device", "string", "kbm | pad (default: the one in use)"), ("family", "string", "xbox | ps | switch")]),
            glyph,
        )
        .add_control_command("platform.screenshot", "Save a screenshot to Pictures/<game> with metadata", params(&[("name", "string", ""), ("meta", "object", "extra key/values")]), screenshot);
}

fn info(world: &mut World, _: Value) -> Result<Value, String> {
    let f = world.get_resource::<GameFolders>().ok_or("platform is not set up")?.clone();
    let folders: serde_json::Map<String, Value> = UserDir::ALL.iter().map(|d| (d.name().to_string(), json!(f.path(*d).display().to_string()))).collect();
    let ws = world.resource::<WindowSettings>().clone();
    let wi = world.resource::<WindowInfo>().clone();
    let shots = world.resource::<shots::ShotStatus>();
    #[cfg(feature = "actions")]
    let glyph_device = world.get_resource::<crate::actions::ActionState>().map(|s| s.last_device.name());
    #[cfg(not(feature = "actions"))]
    let glyph_device: Option<&str> = None;
    Ok(json!({
        "os": format!("{:?}", OsKind::current()),
        "implementation": world.resource::<Platform>().name(),
        "game_folder_name": f.game,
        "root_override": f.root.as_ref().map(|r| r.display().to_string()),
        "folders": folders,
        "window_settings": serde_json::to_value(&ws).map_err(|e| e.to_string())?,
        "window": {"scale_factor": wi.scale_factor, "physical": [wi.physical.x, wi.physical.y], "focused": wi.focused, "monitors": wi.monitors},
        "focus_policy": {"pause_on_focus_loss": world.resource::<FocusPolicy>().pause_on_focus_loss, "resume_on_focus": world.resource::<FocusPolicy>().resume_on_focus},
        "text_focus": world.resource::<TextFocus>().0.map(|e| e.to_bits()),
        "single_instance": world.contains_resource::<InstanceGuard>(),
        "glyph_device": glyph_device,
        "screenshots": {"count": shots.count, "last": shots.last.as_ref().map(|p| p.display().to_string()), "error": shots.error},
    }))
}

fn clipboard(world: &mut World, p: Value) -> Result<Value, String> {
    let os = world.get_resource::<Platform>().ok_or("platform is not set up")?;
    if let Some(t) = p.get("text").and_then(Value::as_str) {
        os.clipboard_set(t)?;
    }
    Ok(json!({"text": os.clipboard_get()?}))
}

fn open(world: &mut World, p: Value) -> Result<Value, String> {
    let path = match (p.get("path").and_then(Value::as_str), p.get("dir").and_then(Value::as_str)) {
        (Some(path), _) => std::path::PathBuf::from(path),
        (None, Some(d)) => {
            let d = UserDir::parse(d).ok_or_else(|| format!("unknown folder `{d}`"))?;
            world.get_resource::<GameFolders>().ok_or("platform is not set up")?.ensure(d).map_err(|e| e.to_string())?
        }
        _ => return Err("give `path` or `dir`".into()),
    };
    world.get_resource::<Platform>().ok_or("platform is not set up")?.open_path(&path)?;
    Ok(json!({"path": path.display().to_string()}))
}

fn notify(world: &mut World, p: Value) -> Result<Value, String> {
    let title = p.get("title").and_then(Value::as_str).ok_or("`title` is required")?;
    let body = p.get("body").and_then(Value::as_str).unwrap_or("");
    world.get_resource::<Platform>().ok_or("platform is not set up")?.notify(title, body)?;
    Ok(json!({}))
}

fn window(world: &mut World, p: Value) -> Result<Value, String> {
    let mut ws = world.get_resource_mut::<WindowSettings>().ok_or("platform is not set up")?;
    let mut cur = serde_json::to_value(&*ws).map_err(|e| e.to_string())?;
    if let (Some(c), Some(patch)) = (cur.as_object_mut(), p.as_object()) {
        for (k, v) in patch {
            c.insert(k.clone(), v.clone());
        }
        // Changing the mode only makes sense if it is not overridden by CoreSettings.
        if patch.contains_key("mode") || patch.contains_key("vsync") {
            c.entry("override_core").or_insert(json!(true));
            if !patch.contains_key("override_core") {
                c.insert("override_core".into(), json!(true));
            }
        }
    }
    *ws = serde_json::from_value(cur).map_err(|e| format!("bad window settings: {e}"))?;
    serde_json::to_value(&*ws).map_err(|e| e.to_string())
}

#[cfg(feature = "actions")]
fn glyph(world: &mut World, p: Value) -> Result<Value, String> {
    use crate::actions::binding::Device;
    use crate::platform::glyphs::{PadFamily, PadStyle};
    let action = p.get("action").and_then(Value::as_str).ok_or("`action` is required")?;
    let map = world.get_resource::<crate::actions::ActionMap>().ok_or("actions are not set up")?;
    let dev = match p.get("device").and_then(Value::as_str) {
        Some(d) => Device::parse(d).ok_or("device is kbm or pad")?,
        None => world.get_resource::<crate::actions::ActionState>().map_or(Device::KeyboardMouse, |s| s.last_device),
    };
    let fam = match p.get("family").and_then(Value::as_str) {
        Some("xbox") => PadFamily::Xbox,
        Some("ps") => PadFamily::PlayStation,
        Some("switch") => PadFamily::Switch,
        Some(_) => PadFamily::Generic,
        None => world.get_resource::<PadStyle>().map_or_else(Default::default, |s| s.0),
    };
    let g = crate::platform::glyphs::glyph(map, action, dev, fam);
    Ok(json!({"text": g.text, "icon": g.icon, "device": dev.name()}))
}

#[cfg(not(feature = "actions"))]
fn glyph(_: &mut World, _: Value) -> Result<Value, String> {
    Err("needs feature `actions`".into())
}

fn screenshot(world: &mut World, p: Value) -> Result<Value, String> {
    if !world.contains_resource::<Messages<SaveScreenshot>>() {
        return Err("platform is not set up".into());
    }
    let mut s = SaveScreenshot::new(p.get("name").and_then(Value::as_str).unwrap_or("screenshot"));
    if let Some(m) = p.get("meta").and_then(Value::as_object) {
        for (k, v) in m {
            s = s.meta(k.clone(), v.as_str().map_or_else(|| v.to_string(), str::to_string));
        }
    }
    world.write_message(s);
    Ok(json!({}))
}
