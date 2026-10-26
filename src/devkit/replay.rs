//! Frame-stamped input: record what the player (or the control port) pressed, save it as JSON,
//! replay it later frame for frame. With a fixed timestep and the same `--seed`, a replay
//! reproduces the run (deterministic repro for bugs).
//!
//! - [`InputRecorder`]: `start()` / `stop() -> InputLog`. Records keyboard, mouse buttons and
//!   mouse motion after Bevy's input systems (PreUpdate).
//! - [`InputReplay`]: `play(log)`; injects each event at its frame (relative to the start),
//!   before Bevy's input systems, so `ButtonInput<KeyCode>` sees it that same frame.
//! - Control port (`devtools`): `devkit.record {action: start|stop|status, path?}`,
//!   `devkit.replay {path | log}`.
//! - [`super::testing::Scenario::play`] uses the same replay path.

use bevy::diagnostic::FrameCount;
use bevy::input::ButtonState;
use bevy::input::InputSystems;
use bevy::input::keyboard::{Key, KeyboardInput, NativeKey};
use bevy::input::mouse::{MouseButtonInput, MouseMotion};
use bevy::prelude::*;
use bevy::reflect::FromReflect;
use bevy::reflect::enums::{DynamicEnum, DynamicVariant};
use serde::{Deserialize, Serialize};

/// One input event. Keys and buttons by name (`KeyW`, `Space`, `Left`), so logs are readable
/// and stable across engine versions.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum InputEvent {
    Key { key: String, down: bool },
    Button { button: String, down: bool },
    Motion { dx: f32, dy: f32 },
}

impl InputEvent {
    pub fn key(code: KeyCode, down: bool) -> Self {
        InputEvent::Key { key: format!("{code:?}"), down }
    }
    pub fn button(b: MouseButton, down: bool) -> Self {
        InputEvent::Button { button: format!("{b:?}"), down }
    }
}

/// `{frame, event}`: `frame` counts from the start of the log (0 = first frame).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimedInput {
    pub frame: u32,
    #[serde(flatten)]
    pub event: InputEvent,
}

/// A recorded or scripted input sequence. JSON: `{"version":1,"seed":7,"events":[{"frame":3,
/// "t":"key","key":"KeyW","down":true}, ...]}`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InputLog {
    pub version: u32,
    /// `GameSeed` of the recorded run (replay with the same `--seed`).
    pub seed: Option<u64>,
    /// Frames the recording lasted.
    pub frames: u32,
    pub events: Vec<TimedInput>,
}

impl InputLog {
    pub fn new() -> Self {
        InputLog { version: 1, ..default() }
    }
    /// Adds an event at `frame` (keeps events sorted by frame, stable).
    pub fn at(mut self, frame: u32, event: InputEvent) -> Self {
        self.push(frame, event);
        self
    }
    pub fn push(&mut self, frame: u32, event: InputEvent) {
        let i = self.events.partition_point(|e| e.frame <= frame);
        self.events.insert(i, TimedInput { frame, event });
        self.frames = self.frames.max(frame + 1);
    }
    /// Key held from `frame` for `frames` frames.
    pub fn hold(self, code: KeyCode, frame: u32, frames: u32) -> Self {
        self.at(frame, InputEvent::key(code, true)).at(frame + frames.max(1), InputEvent::key(code, false))
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }
    pub fn from_json(text: &str) -> Result<Self, String> {
        serde_json::from_str(text).map_err(|e| e.to_string())
    }
}

/// Records input while `active`. `start()` clears, `stop()` returns the log.
#[derive(Resource, Default)]
pub struct InputRecorder {
    active: bool,
    start_frame: u32,
    log: InputLog,
}

impl InputRecorder {
    pub fn start(&mut self, frame: u32, seed: Option<u64>) {
        self.active = true;
        self.start_frame = frame;
        self.log = InputLog { seed, ..InputLog::new() };
    }
    pub fn stop(&mut self, frame: u32) -> InputLog {
        self.active = false;
        let mut log = std::mem::take(&mut self.log);
        log.frames = log.frames.max(frame.saturating_sub(self.start_frame));
        log
    }
    pub fn is_active(&self) -> bool {
        self.active
    }
    pub fn events(&self) -> usize {
        self.log.events.len()
    }
}

/// Replays an [`InputLog`].
#[derive(Resource, Default)]
pub struct InputReplay {
    log: Option<InputLog>,
    start_frame: u32,
    next: usize,
}

impl InputReplay {
    /// Starts `log` at frame `frame` (event frame 0 fires in that frame).
    pub fn play(&mut self, log: InputLog, frame: u32) {
        self.log = Some(log);
        self.start_frame = frame;
        self.next = 0;
    }
    pub fn is_playing(&self) -> bool {
        self.log.is_some()
    }
    pub fn stop(&mut self) {
        self.log = None;
    }
    /// `(events sent, total)`.
    pub fn progress(&self) -> (usize, usize) {
        (self.next, self.log.as_ref().map_or(0, |l| l.events.len()))
    }
}

pub(super) struct ReplayPlugin;

impl Plugin for ReplayPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<InputRecorder>()
            .init_resource::<InputReplay>()
            .add_systems(PreUpdate, replay_input.before(InputSystems).run_if(|r: Res<InputReplay>| r.is_playing()))
            .add_systems(PreUpdate, record_input.after(InputSystems).run_if(|r: Res<InputRecorder>| r.active));
        #[cfg(feature = "devtools")]
        register_commands(app);
    }
}

fn frame_of(world: &World) -> u32 {
    world.get_resource::<FrameCount>().map_or(0, |f| f.0)
}

/// `KeyCode` by its variant name (`KeyW`, `Space`, `F3`).
pub fn key_code(name: &str) -> Option<KeyCode> {
    unit_variant(name)
}

/// `MouseButton` by name (`Left`, `Right`, `Middle`, `Back`, `Forward`).
pub fn mouse_button(name: &str) -> Option<MouseButton> {
    unit_variant(name)
}

fn unit_variant<T: FromReflect>(name: &str) -> Option<T> {
    T::from_reflect(&DynamicEnum::new(name, DynamicVariant::Unit))
}

fn logical_key(code: KeyCode) -> Key {
    let name = format!("{code:?}");
    if let Some(c) = name.strip_prefix("Key").filter(|c| c.len() == 1) {
        return Key::Character(c.to_ascii_lowercase().as_str().into());
    }
    if let Some(d) = name.strip_prefix("Digit") {
        return Key::Character(d.into());
    }
    match code {
        KeyCode::Space => Key::Space,
        KeyCode::Enter => Key::Enter,
        KeyCode::Escape => Key::Escape,
        KeyCode::Tab => Key::Tab,
        KeyCode::Backspace => Key::Backspace,
        KeyCode::ArrowUp => Key::ArrowUp,
        KeyCode::ArrowDown => Key::ArrowDown,
        KeyCode::ArrowLeft => Key::ArrowLeft,
        KeyCode::ArrowRight => Key::ArrowRight,
        KeyCode::ShiftLeft | KeyCode::ShiftRight => Key::Shift,
        KeyCode::ControlLeft | KeyCode::ControlRight => Key::Control,
        KeyCode::AltLeft | KeyCode::AltRight => Key::Alt,
        _ => Key::Unidentified(NativeKey::Unidentified),
    }
}

fn window_entity(world: &mut World) -> Entity {
    let mut q = world.query_filtered::<Entity, With<bevy::window::PrimaryWindow>>();
    q.iter(world).next().unwrap_or(Entity::PLACEHOLDER)
}

/// Writes `ev` as the Bevy input message it stands for. `Err` for unknown names or an app
/// without input.
pub fn inject(world: &mut World, ev: &InputEvent) -> Result<(), String> {
    let state = |down: bool| if down { ButtonState::Pressed } else { ButtonState::Released };
    match ev {
        InputEvent::Key { key, down } => {
            let code = key_code(key).ok_or_else(|| format!("unknown key `{key}`"))?;
            let logical = logical_key(code);
            let text = match &logical {
                Key::Character(c) if *down => Some(c.clone()),
                _ => None,
            };
            let window = window_entity(world);
            world
                .write_message(KeyboardInput { key_code: code, logical_key: logical, state: state(*down), text, repeat: false, window })
                .ok_or("no keyboard input in this app (add bevy::input::InputPlugin)")?;
        }
        InputEvent::Button { button, down } => {
            let button = mouse_button(button).ok_or_else(|| format!("unknown mouse button `{button}`"))?;
            let window = window_entity(world);
            world
                .write_message(MouseButtonInput { button, state: state(*down), window })
                .ok_or("no mouse input in this app")?;
        }
        InputEvent::Motion { dx, dy } => {
            world.write_message(MouseMotion { delta: Vec2::new(*dx, *dy) }).ok_or("no mouse input in this app")?;
        }
    }
    Ok(())
}

fn replay_input(world: &mut World) {
    let frame = frame_of(world);
    let mut due = Vec::new();
    {
        let mut r = world.resource_mut::<InputReplay>();
        let rel = frame.saturating_sub(r.start_frame);
        let Some(log) = r.log.as_ref() else { return };
        let mut next = r.next;
        while let Some(e) = log.events.get(next).filter(|e| e.frame <= rel) {
            due.push(e.event.clone());
            next += 1;
        }
        let done = next >= log.events.len();
        r.next = next;
        if done {
            r.log = None;
        }
    }
    for ev in &due {
        if let Err(e) = inject(world, ev) {
            warn!("replay: {e}");
        }
    }
}

fn record_input(
    frame: Res<FrameCount>,
    mut rec: ResMut<InputRecorder>,
    mut keys: MessageReader<KeyboardInput>,
    mut buttons: MessageReader<MouseButtonInput>,
    mut motion: MessageReader<MouseMotion>,
) {
    let rel = frame.0.saturating_sub(rec.start_frame);
    for k in keys.read().filter(|k| !k.repeat) {
        rec.log.push(rel, InputEvent::key(k.key_code, k.state == ButtonState::Pressed));
    }
    for b in buttons.read() {
        rec.log.push(rel, InputEvent::button(b.button, b.state == ButtonState::Pressed));
    }
    let d: Vec2 = motion.read().map(|m| m.delta).sum();
    if d != Vec2::ZERO {
        rec.log.push(rel, InputEvent::Motion { dx: d.x, dy: d.y });
    }
}

#[cfg(feature = "devtools")]
fn register_commands(app: &mut App) {
    use crate::devtools::{AddControlCommand, params};
    app.add_control_command(
        "devkit.record",
        "Record input (start | stop → log, saved to `path` if given | status)",
        params(&[("action", "string", "start|stop|status (default status)"), ("path", "string", "stop: write the log here (JSON)")]),
        cmd_record,
    )
    .add_control_command(
        "devkit.replay",
        "Replay an input log from `path` or inline `log`; `stop` cancels",
        params(&[("path", "string", "log file"), ("log", "object", "inline log"), ("stop", "boolean", "cancel the replay")]),
        cmd_replay,
    );
}

#[cfg(feature = "devtools")]
fn cmd_record(world: &mut World, p: serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::json;
    let frame = frame_of(world);
    let seed = world.get_resource::<crate::cli::GameSeed>().map(|s| s.0);
    match p.get("action").and_then(|v| v.as_str()).unwrap_or("status") {
        "start" => {
            world.resource_mut::<InputRecorder>().start(frame, seed);
            Ok(json!({"recording": true, "frame": frame}))
        }
        "stop" => {
            let log = world.resource_mut::<InputRecorder>().stop(frame);
            if let Some(path) = p.get("path").and_then(|v| v.as_str()) {
                crate::paths::write_atomic(std::path::Path::new(path), &log.to_json()).map_err(|e| e.to_string())?;
            }
            Ok(json!({"recording": false, "frames": log.frames, "events": log.events.len(), "log": log}))
        }
        "status" => {
            let r = world.resource::<InputRecorder>();
            Ok(json!({"recording": r.is_active(), "events": r.events()}))
        }
        other => Err(format!("unknown action `{other}`")),
    }
}

#[cfg(feature = "devtools")]
fn cmd_replay(world: &mut World, p: serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::json;
    if p.get("stop").and_then(|v| v.as_bool()) == Some(true) {
        world.resource_mut::<InputReplay>().stop();
        return Ok(json!({"playing": false}));
    }
    let log = if let Some(path) = p.get("path").and_then(|v| v.as_str()) {
        InputLog::from_json(&std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?)?
    } else if let Some(l) = p.get("log") {
        serde_json::from_value(l.clone()).map_err(|e| e.to_string())?
    } else {
        let (sent, total) = world.resource::<InputReplay>().progress();
        return Ok(json!({"playing": world.resource::<InputReplay>().is_playing(), "sent": sent, "total": total}));
    };
    for e in &log.events {
        if let InputEvent::Key { key, .. } = &e.event
            && key_code(key).is_none()
        {
            return Err(format!("unknown key `{key}` at frame {}", e.frame));
        }
    }
    // Starts next frame (this command runs in PreUpdate, after the replay system).
    let frame = frame_of(world) + 1;
    let n = log.events.len();
    world.resource_mut::<InputReplay>().play(log, frame);
    Ok(json!({"playing": true, "events": n, "start_frame": frame}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_json_round_trip_and_order() {
        let log = InputLog::new().at(5, InputEvent::key(KeyCode::KeyW, false)).at(1, InputEvent::key(KeyCode::KeyW, true)).at(
            1,
            InputEvent::Motion { dx: 2.0, dy: -1.0 },
        );
        assert_eq!(log.events.iter().map(|e| e.frame).collect::<Vec<_>>(), vec![1, 1, 5]);
        let back = InputLog::from_json(&log.to_json()).unwrap();
        assert_eq!(back, log);
        assert!(log.to_json().contains("\"t\": \"key\""));
    }

    #[test]
    fn names_parse() {
        assert_eq!(key_code("KeyW"), Some(KeyCode::KeyW));
        assert_eq!(key_code("Space"), Some(KeyCode::Space));
        assert_eq!(mouse_button("Left"), Some(MouseButton::Left));
        assert_eq!(key_code("nope"), None);
    }
}
