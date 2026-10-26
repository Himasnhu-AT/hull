//! Control commands (feature `devtools`): `actions.list`, `actions.state`, `actions.bind`,
//! `actions.context`, `actions.rebind`, `actions.rumble`, `input.gamepad`.

use bevy::input::gamepad::{GamepadAxis, GamepadButton};
use bevy::prelude::*;
use serde_json::{Value, json};

use super::binding::{Binding, Device, parse_pad_axis, parse_pad_button};
use super::map::{ActionMap, InputContexts, Trigger};
use super::rebind::{RebindCapture, RebindResult, start_rebind};
use super::state::ActionState;
use super::{Rumble, virtual_pad};
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    app.add_control_command("actions.list", "Every action: kind, context, bindings, defaults; and the contexts", params(&[]), list)
        .add_control_command(
            "actions.state",
            "Action values this frame, live contexts, last device",
            params(&[("action", "string", "one action (default: all)"), ("active", "boolean", "only active actions")]),
            state,
        )
        .add_control_command(
            "actions.bind",
            "Rebind an action (saved to settings)",
            params(&[
                ("action", "string", "action name"),
                ("binding", "string", "e.g. key:KeyF, pad:South, stick:Left|deadzone(0.2,1), key:ControlLeft+key:KeyS"),
                ("bindings", "array", "replace every binding with these strings"),
                ("device", "string", "kbm|pad: with no binding, clears that device's bindings"),
                ("reset", "boolean", "back to defaults (all actions if no action given)"),
                ("sensitivity", "number", "user multiplier for axis actions"),
            ]),
            bind,
        )
        .add_control_command(
            "actions.context",
            "Push/pop an input context",
            params(&[("name", "string", "context"), ("on", "boolean", "push (true, default) or pop"), ("auto", "boolean", "let the engine drive it")]),
            context,
        )
        .add_control_command(
            "actions.rebind",
            "Start press-to-bind (the next input on the device binds); poll actions.rebind {} for the result",
            params(&[("action", "string", "action (omit: report status)"), ("device", "string", "kbm|pad (default kbm)"), ("cancel", "boolean", "stop waiting")]),
            rebind,
        )
        .add_control_command(
            "actions.rumble",
            "Rumble the gamepad (scaled by the accessibility setting)",
            params(&[("strong", "number", "0..1"), ("weak", "number", "0..1"), ("secs", "number", "duration")]),
            rumble,
        )
        .add_control_command(
            "input.gamepad",
            "Drive the virtual gamepad: a button or an axis",
            params(&[
                ("button", "string", "South|East|North|West|a|b|x|y|lb|rb|lt|rt|start|select|up|down|left|right|…"),
                ("axis", "string", "LeftStickX|LeftStickY|RightStickX|RightStickY|LeftZ|RightZ (lx, ly, rx, ry)"),
                ("value", "number", "axis -1..1, button 0..1 (default 1)"),
                ("action", "string", "buttons: tap (default) | down | up"),
                ("disconnect", "boolean", "unplug the virtual pad"),
            ]),
            gamepad,
        );
}

fn str_param<'a>(p: &'a Value, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str)
}

fn trigger_name(t: Trigger) -> String {
    match t {
        Trigger::Down => "down".into(),
        Trigger::Pressed => "pressed".into(),
        Trigger::Released => "released".into(),
        Trigger::Hold { secs } => format!("hold({secs})"),
        Trigger::Tap { max_secs } => format!("tap({max_secs})"),
        Trigger::DoubleTap { window } => format!("double_tap({window})"),
        Trigger::Toggle => "toggle".into(),
    }
}

fn contexts_json(c: &InputContexts) -> Value {
    Value::Array(
        c.iter()
            .map(|x| json!({"name": x.name, "priority": x.priority, "exclusive": x.exclusive, "active": x.active, "live": c.is_live(x.name), "auto": x.auto}))
            .collect(),
    )
}

fn list(world: &mut World, _: Value) -> Result<Value, String> {
    let map = world.resource::<ActionMap>();
    let actions: Vec<Value> = map
        .iter()
        .map(|a| {
            json!({
                "name": a.def.name,
                "label": a.def.display_label(),
                "kind": a.def.kind.name(),
                "context": a.def.context,
                "group": a.def.group,
                "trigger": trigger_name(a.trigger()),
                "requires": a.def.requires,
                "rebindable": a.def.rebindable,
                "toggleable": a.def.toggleable,
                "sensitivity": a.sensitivity,
                "bindings": a.def.bindings.iter().map(|b| b.to_string()).collect::<Vec<_>>(),
                "labels": a.def.bindings.iter().map(Binding::label).collect::<Vec<_>>(),
                "defaults": a.defaults.iter().map(|b| b.to_string()).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({"actions": actions, "contexts": contexts_json(world.resource::<InputContexts>())}))
}

fn state(world: &mut World, p: Value) -> Result<Value, String> {
    let map = world.resource::<ActionMap>();
    let st = world.resource::<ActionState>();
    let only = str_param(&p, "action");
    let active_only = p.get("active").and_then(Value::as_bool).unwrap_or(false);
    if let Some(a) = only
        && map.get(a).is_none()
    {
        return Err(format!("unknown action `{a}`"));
    }
    let mut out = serde_json::Map::new();
    for (name, d) in st.iter(map) {
        if only.is_some_and(|o| o != name) || (active_only && !d.active) {
            continue;
        }
        out.insert(
            name.to_string(),
            json!({"value": [d.value.x, d.value.y], "active": d.active, "just_pressed": d.just_pressed, "just_released": d.just_released, "secs": d.active_secs, "device": d.device.name()}),
        );
    }
    let c = world.resource::<InputContexts>();
    let live: Vec<&str> = c.iter().filter(|x| c.is_live(x.name)).map(|x| x.name).collect();
    Ok(json!({"actions": out, "live_contexts": live, "last_device": st.last_device.name(), "gamepads": world.query_filtered::<(), With<bevy::input::gamepad::Gamepad>>().iter(world).count()}))
}

fn bind(world: &mut World, p: Value) -> Result<Value, String> {
    let action = str_param(&p, "action");
    let mut map = world.resource_mut::<ActionMap>();
    if p.get("reset").and_then(Value::as_bool).unwrap_or(false) {
        match action {
            Some(a) => map.reset(a)?,
            None => map.reset_all(),
        }
        return Ok(json!({"reset": action.unwrap_or("all")}));
    }
    let action = action.ok_or("`action` is required")?;
    if let Some(s) = p.get("sensitivity").and_then(Value::as_f64) {
        map.get_mut(action).ok_or_else(|| format!("unknown action `{action}`"))?.sensitivity = (s as f32).clamp(0.05, 10.0);
    }
    if let Some(list) = p.get("bindings").and_then(Value::as_array) {
        let parsed = list.iter().map(|v| v.as_str().ok_or("bindings must be strings".to_string()).and_then(|s| s.parse::<Binding>())).collect::<Result<Vec<_>, _>>()?;
        map.set_bindings(action, parsed)?;
    } else if let Some(b) = str_param(&p, "binding") {
        let b: Binding = b.parse()?;
        let conflicts = map.conflicts(action, &b);
        map.rebind(action, b)?;
        let a = map.get(action).unwrap();
        return Ok(json!({"action": action, "bindings": a.def.bindings.iter().map(|b| b.to_string()).collect::<Vec<_>>(), "conflicts": conflicts}));
    } else if let Some(d) = str_param(&p, "device") {
        map.clear_device(action, Device::parse(d).ok_or_else(|| format!("unknown device `{d}` (kbm|pad)"))?)?;
    }
    let a = map.get(action).ok_or_else(|| format!("unknown action `{action}`"))?;
    Ok(json!({"action": action, "bindings": a.def.bindings.iter().map(|b| b.to_string()).collect::<Vec<_>>(), "sensitivity": a.sensitivity}))
}

fn context(world: &mut World, p: Value) -> Result<Value, String> {
    let name = str_param(&p, "name").ok_or("`name` is required")?;
    let mut c = world.resource_mut::<InputContexts>();
    let idx = c.index(name).ok_or_else(|| format!("unknown context `{name}`"))?;
    let static_name = c.list[idx].name;
    if let Some(auto) = p.get("auto").and_then(Value::as_bool) {
        c.set_auto(static_name, auto);
    }
    if p.get("on").is_some() || p.get("auto").is_none() {
        let on = p.get("on").and_then(Value::as_bool).unwrap_or(true);
        c.set_auto(static_name, false);
        c.set_active(static_name, on);
    }
    Ok(json!({"contexts": contexts_json(&c)}))
}

fn rebind(world: &mut World, p: Value) -> Result<Value, String> {
    if p.get("cancel").and_then(Value::as_bool).unwrap_or(false) {
        super::rebind::cancel_rebind(world);
    } else if let Some(a) = str_param(&p, "action") {
        let dev = match str_param(&p, "device") {
            None => Device::KeyboardMouse,
            Some(d) => Device::parse(d).ok_or_else(|| format!("unknown device `{d}`"))?,
        };
        start_rebind(world, a, dev)?;
    }
    let c = world.resource::<RebindCapture>();
    let last = match &c.last {
        None => Value::Null,
        Some(RebindResult::Bound { action, binding, conflicts }) => json!({"bound": action, "binding": binding, "conflicts": conflicts}),
        Some(RebindResult::Cancelled { action }) => json!({"cancelled": action}),
    };
    Ok(json!({"waiting": c.action, "device": c.device.name(), "keys_so_far": c.keys.len(), "last": last}))
}

fn rumble(world: &mut World, p: Value) -> Result<Value, String> {
    let f = |k: &str, d: f64| p.get(k).and_then(Value::as_f64).unwrap_or(d) as f32;
    let r = Rumble::new(f("strong", 0.6), f("weak", 0.4), f("secs", 0.3));
    world.write_message(r);
    Ok(json!({"strong": r.strong, "weak": r.weak, "secs": r.secs}))
}

fn gamepad(world: &mut World, p: Value) -> Result<Value, String> {
    if p.get("disconnect").and_then(Value::as_bool).unwrap_or(false) {
        virtual_pad::disconnect(world);
        return Ok(json!({"connected": false}));
    }
    let value = p.get("value").and_then(Value::as_f64).map(|v| v as f32);
    if let Some(b) = str_param(&p, "button") {
        let button: GamepadButton = parse_pad_button(b).ok_or_else(|| format!("unknown button `{b}`"))?;
        let action = str_param(&p, "action").unwrap_or("tap");
        let e = match action {
            "tap" => virtual_pad::tap(world, button)?,
            "down" => virtual_pad::button(world, button, value.unwrap_or(1.0))?,
            "up" => virtual_pad::button(world, button, 0.0)?,
            a => return Err(format!("unknown action `{a}` (tap|down|up)")),
        };
        return Ok(json!({"gamepad": e.to_bits(), "button": format!("{button:?}"), "action": action}));
    }
    if let Some(a) = str_param(&p, "axis") {
        let axis: GamepadAxis = parse_pad_axis(a).ok_or_else(|| format!("unknown axis `{a}`"))?;
        let v = value.ok_or("`value` is required for an axis")?;
        let e = virtual_pad::axis(world, axis, v)?;
        return Ok(json!({"gamepad": e.to_bits(), "axis": format!("{axis:?}"), "value": v}));
    }
    let e = virtual_pad::connect(world);
    let (buttons, axes) = super::pad_names();
    Ok(json!({"gamepad": e.to_bits(), "connected": true, "buttons": buttons, "axes": axes}))
}
