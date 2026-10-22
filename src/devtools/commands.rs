//! The engine's game-agnostic control commands. Games add their own with
//! [`super::control::AddControlCommand`].
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `engine.state` | — | `{state, paused, time_scale, frame, fps, screens, tab, headless, seed}` |
//! | `engine.start` / `engine.menu` | — | `{}` (→ `AppState::InGame` / `MainMenu`, unpaused) |
//! | `engine.pause` / `engine.resume` | — | `{paused}` (through `PauseCtl`, no menu) |
//! | `engine.quit` | — | `{}` (exits 3 frames later, after the reply) |
//! | `time.scale` | `{factor}` 0..8 | `{}` |
//! | `time.step` | `{frames}` (while paused) | `{frame}` after stepping |
//! | `screenshot` | `{path?}` | `{path}` once saved (windowed / `--offscreen` only) |
//! | `perf.stats` | — | `{fps, frame_ms, entities, perf}` |
//! | `ui.screen` | `{screen, tab?, replace?}` | `{stack}` |
//! | `ui.nav` | `{input}` | `{}` |
//! | `ui.setting` | `{key, value}` (none: list) | `{key, value}` |
//! | `settings.get` | — | `{key: value}` for every registered field |
//! | `input.key` | `{key, action: tap/down/up}` | `{key}` |
//! | `input.mouse` | `{dx, dy, button?, action?}` | `{}` |

use std::collections::VecDeque;

use bevy::diagnostic::FrameCount;
use bevy::ecs::message::Messages;
use bevy::ecs::system::SystemState;
use bevy::input::ButtonState;
use bevy::input::keyboard::{Key, KeyboardInput, NativeKey};
use bevy::input::mouse::{MouseButtonInput, MouseMotion};
use bevy::prelude::*;
use bevy::reflect::FromReflect;
use bevy::reflect::enums::{DynamicEnum, DynamicVariant};
use bevy::window::PrimaryWindow;
use serde_json::{Value, json};

use super::control::{AddControlCommand, ControlDrain, PendingReplies, ReplyId, params};
use crate::cli::GameSeed;
use crate::flow::{AppState, Headless};
use crate::paths::DataDir;
use crate::pause::{PauseCtl, Paused};
use crate::settings::{SaveSettings, SettingsRegistry};
use crate::ui::screens::{ScreenRegistry, ScreenRequest, Screens};
use crate::ui::widgets::{NavInput, NavQueue};

/// Built-in screen ids (the ui stream's), accepted even before they are registered.
const BUILTIN_SCREENS: [&str; 3] = ["main", "settings", "pause"];

#[derive(Resource, Default)]
struct StepJob(Option<Step>);

struct Step {
    reply: ReplyId,
    left: u32,
    /// Unpaused (in `First` of the frame after the request).
    started: bool,
}

/// Frames left before `engine.quit` exits (so the reply reaches the client first).
#[derive(Resource, Default)]
struct QuitIn(Option<u32>);

/// Input releases queued by `tap` actions, sent on the next frame.
#[derive(Resource, Default)]
struct InjectedUps {
    keys: Vec<KeyboardInput>,
    buttons: Vec<MouseButtonInput>,
}

/// Recent real frame times, for `perf.stats` and `engine.state`.
#[derive(Resource, Default)]
pub struct FrameStats {
    times: VecDeque<f32>,
}

impl FrameStats {
    const LEN: usize = 600;

    /// `(fps, p50, p95, p99)` in milliseconds over the last ~10 s.
    pub fn summary(&self) -> (f32, f32, f32, f32) {
        if self.times.is_empty() {
            return (0.0, 0.0, 0.0, 0.0);
        }
        let mut v: Vec<f32> = self.times.iter().copied().collect();
        v.sort_by(f32::total_cmp);
        let pct = |p: f32| v[((v.len() - 1) as f32 * p).round() as usize] * 1000.0;
        let mean = v.iter().sum::<f32>() / v.len() as f32;
        let fps = if mean > 0.0 { 1.0 / mean } else { 0.0 };
        (fps, pct(0.5), pct(0.95), pct(0.99))
    }
}

pub(super) fn register(app: &mut App) {
    app.init_resource::<StepJob>()
        .init_resource::<QuitIn>()
        .init_resource::<FrameStats>()
        .init_resource::<InjectedUps>()
        .add_systems(PreUpdate, release_taps.before(ControlDrain))
        .add_systems(First, begin_step.before(bevy::time::TimeSystems))
        .add_systems(Update, quit_countdown)
        .add_systems(Last, (step_frames, record_frame));

    let none = params(&[]);
    app.add_control_command("engine.state", "App state, pause, screens, fps", none.clone(), engine_state)
        .add_control_command("engine.start", "Enter the game (AppState::InGame)", none.clone(), engine_start)
        .add_control_command("engine.menu", "Go to the main menu", none.clone(), engine_menu)
        .add_control_command("engine.pause", "Pause game time (no menu)", none.clone(), engine_pause)
        .add_control_command("engine.resume", "Resume game time", none.clone(), engine_resume)
        .add_control_command("engine.quit", "Quit", none.clone(), engine_quit)
        .add_control_command("time.scale", "Set game speed", params(&[("factor", "number", "0..8, 1 = normal")]), time_scale)
        .add_deferred_control_command(
            "time.step",
            "Run N frames while paused",
            params(&[("frames", "integer", "frames to run (default 1)")]),
            time_step,
        )
        .add_deferred_control_command(
            "screenshot",
            "Save a screenshot (windowed or --offscreen)",
            params(&[("path", "string", "PNG path (default: <data dir>/screenshots/shot-<frame>.png)")]),
            screenshot,
        )
        .add_control_command("perf.stats", "Frame-time statistics and the perf monitor's snapshot", none.clone(), perf_stats)
        .add_control_command(
            "ui.screen",
            "Open a screen (none = close all)",
            params(&[
                ("screen", "string", "main|settings|pause|<game screen>|none"),
                ("tab", "integer", "tab index on the screen"),
                ("replace", "boolean", "clear the stack first (default: true for main)"),
            ]),
            ui_screen,
        )
        .add_control_command(
            "ui.nav",
            "Send a menu input",
            params(&[("input", "string", "up|down|left|right|accept|back|next_tab|prev_tab")]),
            ui_nav,
        )
        .add_control_command(
            "ui.setting",
            "Change a setting (no params: list them)",
            params(&[("key", "string", "field key, see settings.get"), ("value", "number", "index for choices, 0/1 toggles")]),
            ui_setting,
        )
        .add_control_command("settings.get", "Every registered setting: key -> value", none.clone(), settings_get)
        .add_control_command(
            "input.key",
            "Press a key like the keyboard would",
            params(&[
                ("key", "string", "KeyCode name (KeyW, Space, Escape, F3) or short (w, space, esc, up, 1)"),
                ("action", "string", "tap (default: press now, release next frame) | down | up"),
            ]),
            input_key,
        )
        .add_control_command(
            "input.mouse",
            "Move the mouse / press a button like the mouse would",
            params(&[
                ("dx", "number", "motion x (pixels)"),
                ("dy", "number", "motion y (pixels, + = down)"),
                ("button", "string", "left|right|middle|back|forward"),
                ("action", "string", "tap (default) | down | up"),
            ]),
            input_mouse,
        );
}

// ---- params ----

fn num(p: &Value, k: &str) -> Option<f64> {
    p.get(k).and_then(Value::as_f64)
}

fn need(p: &Value, k: &str) -> Result<f64, String> {
    num(p, k).ok_or_else(|| format!("`{k}` (number) is required"))
}

fn str_param<'a>(p: &'a Value, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str)
}

fn frame(world: &World) -> u32 {
    world.get_resource::<FrameCount>().map_or(0, |f| f.0)
}

fn headless(world: &World) -> bool {
    world.get_resource::<Headless>().is_some_and(|h| h.0)
}

// ---- pause plumbing ----

fn is_paused(world: &World) -> bool {
    match world.get_resource::<Paused>() {
        Some(p) => p.0,
        None => world.resource::<Time<Virtual>>().is_paused(),
    }
}

/// Through [`PauseCtl`] when the engine's pause is set up (keeps physics time in step), else
/// `Time<Virtual>` alone.
fn set_paused(world: &mut World, on: bool) {
    if world.contains_resource::<Paused>() {
        let mut st = SystemState::<PauseCtl>::new(world);
        if let Ok(mut ctl) = st.get_mut(world) {
            ctl.set(on);
        }
    } else if on {
        world.resource_mut::<Time<Virtual>>().pause();
    } else {
        world.resource_mut::<Time<Virtual>>().unpause();
    }
}

// ---- engine / time ----

fn engine_state(world: &mut World, _: Value) -> Result<Value, String> {
    let state = world.get_resource::<State<AppState>>().map(|s| format!("{:?}", s.get()));
    let screens = world.get_resource::<Screens>();
    let time = world.resource::<Time<Virtual>>();
    let (fps, ..) = world.get_resource::<FrameStats>().map(FrameStats::summary).unwrap_or_default();
    Ok(json!({
        "state": state,
        "paused": is_paused(world),
        "time_paused": time.is_paused(),
        "time_scale": time.relative_speed(),
        "frame": world.get_resource::<FrameCount>().map(|f| f.0),
        "fps": fps,
        "screens": screens.map(|s| s.stack.clone()),
        "tab": screens.map(|s| s.tab),
        "headless": headless(world),
        "seed": world.get_resource::<GameSeed>().map(|s| s.0),
    }))
}

fn set_app_state(world: &mut World, s: AppState) -> Result<(), String> {
    let mut next = world
        .get_resource_mut::<NextState<AppState>>()
        .ok_or("no AppState (engine flow not set up)")?;
    next.set(s);
    Ok(())
}

fn engine_start(world: &mut World, _: Value) -> Result<Value, String> {
    set_app_state(world, AppState::InGame)?;
    set_paused(world, false);
    Ok(json!({}))
}

fn engine_menu(world: &mut World, _: Value) -> Result<Value, String> {
    set_app_state(world, AppState::MainMenu)?;
    set_paused(world, false);
    Ok(json!({}))
}

fn engine_pause(world: &mut World, _: Value) -> Result<Value, String> {
    set_paused(world, true);
    Ok(json!({"paused": true}))
}

fn engine_resume(world: &mut World, _: Value) -> Result<Value, String> {
    if world.resource::<StepJob>().0.is_some() {
        return Err("a time.step is running".into());
    }
    set_paused(world, false);
    Ok(json!({"paused": false}))
}

fn engine_quit(world: &mut World, _: Value) -> Result<Value, String> {
    world.resource_mut::<QuitIn>().0 = Some(3);
    Ok(json!({}))
}

fn quit_countdown(mut quit: ResMut<QuitIn>, mut exit: MessageWriter<AppExit>) {
    if let Some(n) = quit.0 {
        if n == 0 {
            exit.write(AppExit::Success);
            quit.0 = None;
        } else {
            quit.0 = Some(n - 1);
        }
    }
}

fn time_scale(world: &mut World, p: Value) -> Result<Value, String> {
    let f = need(&p, "factor")?;
    if !(0.0..=8.0).contains(&f) {
        return Err("`factor` must be in 0..8".into());
    }
    world.resource_mut::<Time<Virtual>>().set_relative_speed_f64(f);
    Ok(json!({}))
}

fn time_step(world: &mut World, p: Value, reply: ReplyId) -> Result<(), String> {
    let frames = p.get("frames").and_then(Value::as_u64).unwrap_or(1).clamp(1, 100_000) as u32;
    if !is_paused(world) {
        return Err("time.step needs a paused game (engine.pause first)".into());
    }
    if world.resource::<StepJob>().0.is_some() {
        return Err("a time.step is already running".into());
    }
    world.resource_mut::<StepJob>().0 = Some(Step { reply, left: frames, started: false });
    Ok(())
}

/// First, before time advances: unpause for a requested step, so every stepped frame gets a
/// real time delta (unpausing at the request, in `PreUpdate`, would run one extra frame with a
/// zero delta).
fn begin_step(world: &mut World) {
    let start = world.resource::<StepJob>().0.as_ref().is_some_and(|s| !s.started);
    if start {
        set_paused(world, false);
        if let Some(s) = world.resource_mut::<StepJob>().0.as_mut() {
            s.started = true;
        }
    }
}

/// Last: count stepped frames and pause again when done.
fn step_frames(world: &mut World) {
    let now = frame(world);
    let done = {
        let mut job = world.resource_mut::<StepJob>();
        let Some(step) = job.0.as_mut() else { return };
        if !step.started {
            return;
        }
        step.left -= 1;
        if step.left > 0 {
            return;
        }
        job.0.take().map(|s| s.reply)
    };
    set_paused(world, true);
    if let Some(reply) = done {
        world.resource_mut::<PendingReplies>().reply(reply, Ok(json!({"frame": now})));
    }
}

fn record_frame(time: Res<Time<Real>>, mut stats: ResMut<FrameStats>) {
    let dt = time.delta_secs();
    if dt > 0.0 {
        if stats.times.len() == FrameStats::LEN {
            stats.times.pop_front();
        }
        stats.times.push_back(dt);
    }
}

// ---- screenshot / perf ----

fn screenshot(world: &mut World, p: Value, reply: ReplyId) -> Result<(), String> {
    use bevy::render::view::window::screenshot::{Screenshot, ScreenshotCaptured, save_to_disk};
    if headless(world) || !world.contains_resource::<Assets<Image>>() {
        return Err("screenshot needs a renderer (not --headless)".into());
    }
    let path = match str_param(&p, "path") {
        Some(s) => std::path::PathBuf::from(s),
        None => {
            let dir = world
                .get_resource::<DataDir>()
                .map(|d| d.0.clone())
                .unwrap_or_else(std::env::temp_dir);
            dir.join("screenshots").join(format!("shot-{}.png", frame(world)))
        }
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let shown = path.display().to_string();
    let shot = match world.get_resource::<super::offscreen::OffscreenTarget>() {
        Some(t) => Screenshot::image(t.0.clone()),
        None => Screenshot::primary_window(),
    };
    world
        .spawn(shot)
        .observe(save_to_disk(path))
        .observe(move |_: On<ScreenshotCaptured>, mut pending: ResMut<PendingReplies>| {
            pending.reply(reply, Ok(json!({"path": shown})));
        });
    Ok(())
}

fn perf_stats(world: &mut World, _: Value) -> Result<Value, String> {
    let (fps, p50, p95, p99) = world.resource::<FrameStats>().summary();
    Ok(json!({
        "fps": fps,
        "frame_ms": {"p50": p50, "p95": p95, "p99": p99},
        "entities": world.entities().count_spawned(),
        "perf": super::perf::stats_json(world),
    }))
}

// ---- ui / settings ----

fn send<M: Message>(world: &mut World, m: M) -> Result<(), String> {
    if !world.contains_resource::<Messages<M>>() {
        return Err(format!("{} is not set up (no UI?)", std::any::type_name::<M>()));
    }
    world.write_message(m);
    Ok(())
}

/// `&'static` id for a screen name: a registered screen or a built-in.
fn screen_id(world: &World, name: &str) -> Option<&'static str> {
    world
        .get_resource::<ScreenRegistry>()
        .and_then(|r| r.0.iter().map(|(id, _)| *id).find(|id| *id == name))
        .or_else(|| BUILTIN_SCREENS.into_iter().find(|id| *id == name))
}

fn ui_screen(world: &mut World, p: Value) -> Result<Value, String> {
    let name = str_param(&p, "screen").unwrap_or("none");
    if name == "none" {
        send(world, ScreenRequest::Replace(None))?;
    } else {
        let id = screen_id(world, name).ok_or_else(|| format!("unknown screen `{name}`"))?;
        if id == "pause" {
            set_paused(world, true);
        }
        let replace = p.get("replace").and_then(Value::as_bool).unwrap_or(id == "main");
        send(world, if replace { ScreenRequest::Replace(Some(id)) } else { ScreenRequest::Push(id) })?;
    }
    if let Some(t) = p.get("tab").and_then(Value::as_u64) {
        send(world, ScreenRequest::SetTab(t as usize))?;
    }
    Ok(json!({}))
}

pub fn parse_nav(s: &str) -> Option<NavInput> {
    Some(match s.to_ascii_lowercase().as_str() {
        "up" => NavInput::Up,
        "down" => NavInput::Down,
        "left" => NavInput::Left,
        "right" => NavInput::Right,
        "accept" | "enter" => NavInput::Accept,
        "back" | "esc" => NavInput::Back,
        "next_tab" => NavInput::NextTab,
        "prev_tab" => NavInput::PrevTab,
        _ => return None,
    })
}

fn ui_nav(world: &mut World, p: Value) -> Result<Value, String> {
    let s = str_param(&p, "input").ok_or("`input` (string) is required")?;
    let n = parse_nav(s).ok_or_else(|| format!("unknown input `{s}`"))?;
    world.get_resource_or_init::<NavQueue>().0.push(n);
    Ok(json!({}))
}

fn ui_setting(world: &mut World, p: Value) -> Result<Value, String> {
    let Some(key) = str_param(&p, "key") else {
        return settings_get(world, p);
    };
    let field = world
        .get_resource::<SettingsRegistry>()
        .and_then(|r| r.field(key))
        .cloned()
        .ok_or_else(|| format!("unknown setting `{key}` (see settings.get)"))?;
    let v = need(&p, "value")? as f32;
    (field.set)(world, v);
    if world.contains_resource::<Messages<SaveSettings>>() {
        world.write_message(SaveSettings);
    }
    Ok(json!({"key": field.key, "value": (field.get)(world)}))
}

fn settings_get(world: &mut World, _: Value) -> Result<Value, String> {
    let fields = world.get_resource::<SettingsRegistry>().map(|r| r.fields.clone()).unwrap_or_default();
    let map: serde_json::Map<String, Value> = fields.iter().map(|f| (f.key.to_string(), json!((f.get)(world)))).collect();
    Ok(Value::Object(map))
}

// ---- input injection ----

/// Action param: `tap` (default), `down` or `up`.
fn action(p: &Value) -> Result<&str, String> {
    match str_param(p, "action").unwrap_or("tap") {
        a @ ("tap" | "down" | "up") => Ok(a),
        a => Err(format!("unknown action `{a}` (tap|down|up)")),
    }
}

fn unit_variant<T: FromReflect>(name: &str) -> Option<T> {
    T::from_reflect(&DynamicEnum::new(name, DynamicVariant::Unit))
}

/// `KeyW`, `w`, `W` → `KeyW`; `1` → `Digit1`; `esc` → `Escape`; `f3` → `F3`; …
pub fn parse_key(s: &str) -> Option<KeyCode> {
    let lower = s.to_ascii_lowercase();
    let alias = match lower.as_str() {
        "esc" => Some("Escape"),
        "return" => Some("Enter"),
        "shift" => Some("ShiftLeft"),
        "ctrl" | "control" => Some("ControlLeft"),
        "alt" | "option" => Some("AltLeft"),
        "cmd" | "super" | "meta" => Some("SuperLeft"),
        "up" => Some("ArrowUp"),
        "down" => Some("ArrowDown"),
        "left" => Some("ArrowLeft"),
        "right" => Some("ArrowRight"),
        _ => None,
    };
    let mut names: Vec<String> = alias.map(String::from).into_iter().collect();
    names.push(s.to_string());
    let mut chars = s.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            names.push(format!("Key{}", c.to_ascii_uppercase()));
        } else if c.is_ascii_digit() {
            names.push(format!("Digit{c}"));
        }
    }
    // `space` → `Space`, `f3` → `F3`, `backspace` → `Backspace`.
    let mut cap = lower.clone();
    if let Some(f) = cap.get_mut(0..1) {
        f.make_ascii_uppercase();
    }
    names.push(cap);
    names.iter().find_map(|n| unit_variant::<KeyCode>(n))
}

/// The logical key a US layout would report for `code`.
fn logical_key(code: KeyCode) -> Key {
    let name = format!("{code:?}");
    if let Some(c) = name.strip_prefix("Key").filter(|c| c.len() == 1) {
        return Key::Character(c.to_ascii_lowercase().as_str().into());
    }
    if let Some(d) = name.strip_prefix("Digit") {
        return Key::Character(d.into());
    }
    let named = match code {
        KeyCode::ShiftLeft | KeyCode::ShiftRight => Some(Key::Shift),
        KeyCode::ControlLeft | KeyCode::ControlRight => Some(Key::Control),
        KeyCode::AltLeft | KeyCode::AltRight => Some(Key::Alt),
        KeyCode::SuperLeft | KeyCode::SuperRight => Some(Key::Super),
        _ => None,
    };
    named
        .or_else(|| unit_variant::<Key>(&name))
        .unwrap_or(Key::Unidentified(NativeKey::Unidentified))
}

fn window(world: &mut World) -> Entity {
    world
        .query_filtered::<Entity, With<PrimaryWindow>>()
        .iter(world)
        .next()
        .unwrap_or(Entity::PLACEHOLDER)
}

fn input_key(world: &mut World, p: Value) -> Result<Value, String> {
    let s = str_param(&p, "key").ok_or("`key` (string) is required")?;
    let code = parse_key(s).ok_or_else(|| format!("unknown key `{s}`"))?;
    let action = action(&p)?;
    if !world.contains_resource::<Messages<KeyboardInput>>() {
        return Err("no keyboard input in this app (--headless?)".into());
    }
    let logical = logical_key(code);
    let text = match &logical {
        Key::Character(c) => Some(c.clone()),
        _ => None,
    };
    let window = window(world);
    let ev = |state| KeyboardInput { key_code: code, logical_key: logical.clone(), state, text: text.clone(), repeat: false, window };
    if action != "up" {
        world.write_message(ev(ButtonState::Pressed));
    }
    match action {
        "up" => {
            world.write_message(ev(ButtonState::Released));
        }
        "tap" => world.resource_mut::<InjectedUps>().keys.push(ev(ButtonState::Released)),
        _ => {}
    }
    Ok(json!({"key": format!("{code:?}")}))
}

fn input_mouse(world: &mut World, p: Value) -> Result<Value, String> {
    let delta = Vec2::new(num(&p, "dx").unwrap_or(0.0) as f32, num(&p, "dy").unwrap_or(0.0) as f32);
    let button = match str_param(&p, "button") {
        None => None,
        Some(b) => Some(match b.to_ascii_lowercase().as_str() {
            "left" => MouseButton::Left,
            "right" => MouseButton::Right,
            "middle" => MouseButton::Middle,
            "back" => MouseButton::Back,
            "forward" => MouseButton::Forward,
            _ => return Err(format!("unknown button `{b}`")),
        }),
    };
    let action = action(&p)?;
    if !world.contains_resource::<Messages<MouseMotion>>() {
        return Err("no mouse input in this app (--headless?)".into());
    }
    if delta != Vec2::ZERO {
        world.write_message(MouseMotion { delta });
    }
    if let Some(button) = button {
        let window = window(world);
        let ev = |state| MouseButtonInput { button, state, window };
        if action != "up" {
            world.write_message(ev(ButtonState::Pressed));
        }
        match action {
            "up" => {
                world.write_message(ev(ButtonState::Released));
            }
            "tap" => world.resource_mut::<InjectedUps>().buttons.push(ev(ButtonState::Released)),
            _ => {}
        }
    }
    Ok(json!({}))
}

/// PreUpdate, before the requests of this frame: release what `tap` pressed last frame.
fn release_taps(world: &mut World) {
    let ups = std::mem::take(&mut *world.resource_mut::<InjectedUps>());
    for k in ups.keys {
        world.write_message(k);
    }
    for b in ups.buttons {
        world.write_message(b);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_parse() {
        assert_eq!(parse_key("KeyW"), Some(KeyCode::KeyW));
        assert_eq!(parse_key("w"), Some(KeyCode::KeyW));
        assert_eq!(parse_key("W"), Some(KeyCode::KeyW));
        assert_eq!(parse_key("1"), Some(KeyCode::Digit1));
        assert_eq!(parse_key("esc"), Some(KeyCode::Escape));
        assert_eq!(parse_key("Escape"), Some(KeyCode::Escape));
        assert_eq!(parse_key("space"), Some(KeyCode::Space));
        assert_eq!(parse_key("f3"), Some(KeyCode::F3));
        assert_eq!(parse_key("up"), Some(KeyCode::ArrowUp));
        assert_eq!(parse_key("shift"), Some(KeyCode::ShiftLeft));
        assert_eq!(parse_key("nope"), None);
    }

    #[test]
    fn logical_keys() {
        assert_eq!(logical_key(KeyCode::KeyW), Key::Character("w".into()));
        assert_eq!(logical_key(KeyCode::Digit3), Key::Character("3".into()));
        assert_eq!(logical_key(KeyCode::Space), Key::Space);
        assert_eq!(logical_key(KeyCode::Escape), Key::Escape);
        assert_eq!(logical_key(KeyCode::ShiftLeft), Key::Shift);
    }

    #[test]
    fn nav_parse() {
        assert_eq!(parse_nav("next_tab"), Some(NavInput::NextTab));
        assert_eq!(parse_nav("Accept"), Some(NavInput::Accept));
        assert_eq!(parse_nav("sideways"), None);
    }
}
