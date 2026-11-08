//! Control commands: `ui2.open`, `ui2.back`, `ui2.screens`, `ui2.data`, `ui2.focus`, `ui2.nav`,
//! `ui2.diagnostics`, `ui2.tokens`.

use bevy::prelude::*;
use serde_json::{Value as Json, json};

use super::*;
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    app.add_control_command("ui2.open", "Push a ui2 screen (assets/ui/<name>.ui.ron)", params(&[("name", "string", "screen name")]), open)
        .add_control_command("ui2.back", "Pop the top ui2 screen", params(&[]), back)
        .add_control_command("ui2.screens", "The ui2 screen stack, focus and open diagnostics count", params(&[]), screens)
        .add_control_command(
            "ui2.data",
            "Read or write the UiData store: with `value` sets `key`, without reads it, with neither lists everything",
            params(&[("key", "string", "data key"), ("value", "any", "new value")]),
            data,
        )
        .add_control_command("ui2.focus", "Focused element (id, entity); with `id` focuses that element", params(&[("id", "string", "element id to focus")]), focus)
        .add_control_command("ui2.nav", "Inject navigation: up down left right accept back next_tab prev_tab", params(&[("input", "string", "nav input")]), nav)
        .add_control_command("ui2.diagnostics", "Located problems in screen and token files", params(&[("clear", "boolean", "forget them after reading")]), diagnostics)
        .add_control_command("ui2.tokens", "The active design tokens", params(&[]), tokens);
}

fn open(w: &mut World, p: Json) -> Result<Json, String> {
    let name = p.get("name").and_then(Json::as_str).ok_or("name required")?.to_string();
    w.resource_mut::<Ui2Cmds>().open(&name);
    Ok(json!({"queued": name}))
}

fn back(w: &mut World, _: Json) -> Result<Json, String> {
    w.resource_mut::<Ui2Cmds>().back();
    Ok(json!({"queued": "back"}))
}

fn focus_id(w: &World) -> Option<String> {
    let e = w.resource::<Ui2Focus>().0?;
    w.get::<Focusable2>(e).map(|f| f.id.clone())
}

fn screens(w: &mut World, _: Json) -> Result<Json, String> {
    let names = w.resource::<Ui2Screens>().names();
    let mut tabs = w.query::<&TabBar>();
    let tabs: Vec<Json> = tabs.iter(w).map(|t| json!({"id": t.id, "selected": t.selected, "count": t.count})).collect();
    Ok(json!({"stack": names, "focus": focus_id(w), "tabs": tabs, "diagnostics": w.resource::<Ui2Diagnostics>().0.len()}))
}

fn data(w: &mut World, p: Json) -> Result<Json, String> {
    let key = p.get("key").and_then(Json::as_str);
    let mut d = w.resource_mut::<UiData>();
    match (key, p.get("value")) {
        (Some(k), Some(v)) => {
            d.set(k, v.clone());
            Ok(json!({k: v}))
        }
        (Some(k), None) => Ok(json!({k: d.get(k)})),
        _ => Ok(Json::Object(d.iter().map(|(k, v)| (k.clone(), v.clone())).collect())),
    }
}

fn focus(w: &mut World, p: Json) -> Result<Json, String> {
    if let Some(id) = p.get("id").and_then(Json::as_str) {
        let mut q = w.query::<(Entity, &Focusable2)>();
        let found = q.iter(w).find(|(_, f)| f.id == id).map(|(e, _)| e).ok_or_else(|| format!("no focusable `{id}`"))?;
        w.resource_mut::<Ui2Focus>().0 = Some(found);
    }
    Ok(json!({"focus": focus_id(w)}))
}

fn nav(w: &mut World, p: Json) -> Result<Json, String> {
    let s = p.get("input").and_then(Json::as_str).ok_or("input required")?;
    let n = Nav2::parse(s).ok_or_else(|| format!("unknown nav input `{s}`"))?;
    w.write_message(n);
    Ok(json!({"queued": s}))
}

fn diagnostics(w: &mut World, p: Json) -> Result<Json, String> {
    let mut d = w.resource_mut::<Ui2Diagnostics>();
    let out: Vec<Json> = d.0.iter().map(|x| json!({"file": x.file, "line": x.line, "col": x.col, "message": x.message})).collect();
    if p.get("clear").and_then(Json::as_bool).unwrap_or(false) {
        d.0.clear();
    }
    Ok(json!({"items": out}))
}

fn tokens(w: &mut World, _: Json) -> Result<Json, String> {
    let t = w.resource::<Tokens>();
    let ron = screen::ron_options().to_string_pretty(t, ron::ser::PrettyConfig::default()).map_err(|e| e.to_string())?;
    Ok(json!({"ron": ron}))
}
