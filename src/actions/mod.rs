//! Action mapping (feature `actions`): the engine's Enhanced-Input / Input-System equivalent,
//! defined in Rust, persisted as text, driven and inspected from the control port.
//! Docs: `docs/ACTIONS.md`.
//!
//! ```ignore
//! use engine::actions::*;
//! app.add_action(ActionDef::button("interact").label("Interact").group("Gameplay")
//!         .bind(Binding::key(KeyCode::KeyF)).bind(Binding::pad(GamepadButton::West)));
//! app.add_action(ActionDef::axis2d("steer").context("vehicle")
//!         .bind(Binding::wasd()).bind(Binding::stick(Stick::Left).deadzone(0.15)));
//! fn play(actions: Res<ActionState>, mut ctx: ResMut<InputContexts>) {
//!     if actions.just_pressed("interact") { ctx.push("vehicle"); }
//!     let steer = actions.axis2d("steer");
//! }
//! ```
//!
//! - [`ActionDef`]: name, kind (button / axis1d / axis2d), context, bindings (keyboard, mouse,
//!   gamepad; several per action; chords like Ctrl+S), modifiers (deadzone, invert, scale /
//!   sensitivity, per-second, swizzle, response curve) and a trigger (down, pressed, released,
//!   hold, tap, double-tap, toggle; `requires` for chorded actions).
//! - [`InputContexts`]: prioritized contexts, pushed/popped at runtime. The engine drives
//!   "menu" (any screen open) and "gameplay" (`InGame`, no screen, not paused).
//! - [`ActionState`]: the values, every frame in `PreUpdate` ([`ActionsSet`]) — before
//!   [`crate::input::InputSet`] (`LookInput`), the FPS controller and UI navigation, which all
//!   read actions.
//! - Rebinding: [`ActionMap::rebind`], press-to-bind with [`start_rebind`] (the "controls"
//!   screen), overrides saved in settings.json section `"input"` ([`InputSettings`]).
//! - [`Rumble`]: gamepad rumble scaled by the accessibility setting.
//! - [`accessibility`]: text scale, hold/toggle, reduce motion + camera shake, high contrast,
//!   colorblind filter, rumble strength (section `"accessibility"`).

pub mod accessibility;
pub mod binding;
#[cfg(feature = "devtools")]
mod commands;
pub mod map;
pub mod rebind;
pub mod state;
pub mod virtual_pad;

use std::collections::BTreeMap;
use std::time::Duration;

use bevy::input::gamepad::{GamepadAxis, GamepadButton, GamepadRumbleIntensity, GamepadRumbleRequest};
use bevy::prelude::*;
use serde::{Deserialize, Serialize};

pub use accessibility::{Accessibility, ColorblindMode};
pub use binding::{Binding, Button, Device, Input, Modifier, Stick};
pub use map::{Action, ActionDef, ActionId, ActionKind, ActionMap, InputContext, InputContexts, Trigger};
pub use rebind::{RebindCapture, start_rebind};
pub use state::{ActionData, ActionState};

use crate::flow::AppState;
use crate::input::BASE_MOUSE_SENSITIVITY;
use crate::pause::Paused;

/// `PreUpdate`, after Bevy's input systems: contexts + devices → [`ActionState`].
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ActionsSet;

/// `app.add_action(def)` / `app.add_input_context(name, priority, exclusive)`.
pub trait AddAction {
    fn add_action(&mut self, def: ActionDef) -> &mut Self;
    fn add_input_context(&mut self, name: &'static str, priority: i32, exclusive: bool) -> &mut Self;
}

impl AddAction for App {
    fn add_action(&mut self, def: ActionDef) -> &mut Self {
        let ctx = def.context;
        let mut contexts = self.world_mut().get_resource_or_init::<InputContexts>();
        if contexts.index(ctx).is_none() {
            contexts.define(ctx, 0, false);
        }
        self.world_mut().get_resource_or_init::<ActionMap>().add(def);
        self
    }
    fn add_input_context(&mut self, name: &'static str, priority: i32, exclusive: bool) -> &mut Self {
        self.world_mut().get_resource_or_init::<InputContexts>().define(name, priority, exclusive);
        self
    }
}

/// Binding overrides (only actions that differ from their defaults), section `"input"` of
/// settings.json: `{"bindings": {"jump": ["key:KeyF", "pad:South"]}, "sensitivity": {"look": 1.4}}`.
#[derive(Resource, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct InputSettings {
    pub bindings: BTreeMap<String, Vec<String>>,
    pub sensitivity: BTreeMap<String, f32>,
}

impl InputSettings {
    /// What would be saved for `map`.
    pub fn from_map(map: &ActionMap) -> Self {
        let mut s = InputSettings::default();
        for a in map.iter() {
            if a.def.bindings != a.defaults {
                s.bindings.insert(a.def.name.to_string(), a.def.bindings.iter().map(|b| b.to_string()).collect());
            }
            if (a.sensitivity - 1.0).abs() > 1e-4 {
                s.sensitivity.insert(a.def.name.to_string(), a.sensitivity);
            }
        }
        s
    }
    /// Apply to `map`; unknown actions / unparsable bindings are skipped with a warning.
    pub fn apply(&self, map: &mut ActionMap) {
        for (name, list) in &self.bindings {
            let parsed: Result<Vec<Binding>, String> = list.iter().map(|s| s.parse()).collect();
            match (parsed, map.get_mut(name)) {
                (Ok(b), Some(a)) => a.def.bindings = b,
                (Err(e), _) => warn!("input settings: action `{name}`: {e}"),
                (_, None) => warn!("input settings: unknown action `{name}` (kept in the file)"),
            }
        }
        for (name, v) in &self.sensitivity {
            if let Some(a) = map.get_mut(name) {
                a.sensitivity = v.clamp(0.05, 10.0);
            }
        }
    }
}

/// Rumble the gamepad the player used last (or `gamepad`), scaled by
/// [`Accessibility::rumble`] (0 = off). `app.world_mut().write_message(Rumble::new(0.6, 0.3, 0.25))`.
#[derive(Message, Clone, Copy, Debug, PartialEq)]
pub struct Rumble {
    pub strong: f32,
    pub weak: f32,
    pub secs: f32,
    /// `None`: the last used gamepad, else every connected one.
    pub gamepad: Option<Entity>,
}

impl Rumble {
    pub fn new(strong: f32, weak: f32, secs: f32) -> Self {
        Rumble { strong, weak, secs, gamepad: None }
    }
}

/// Engine actions. gameplay: `look` (mouse + right stick), `pause` (Esc / Menu);
/// menu (fixed): `ui.navigate`, `ui.accept`, `ui.back`, `ui.next_tab`, `ui.prev_tab`.
/// The FPS controller adds `move`, `sprint`, `jump`, `crouch`.
pub fn engine_actions() -> Vec<ActionDef> {
    use GamepadButton as P;
    let k = Binding::key;
    let shift_tab = |s| Binding::key(KeyCode::Tab).with(Button::Key(s));
    vec![
        ActionDef::axis2d("look")
            .label("Look")
            .group("Movement")
            .bind(Binding::mouse_motion().scale(BASE_MOUSE_SENSITIVITY, -BASE_MOUSE_SENSITIVITY))
            .bind(Binding::stick(Stick::Right).deadzone(0.12).modifier(Modifier::Exponent(1.6)).scale(3.2, 2.2).per_second()),
        ActionDef::button("pause").label("Pause").group("Interface").bind(k(KeyCode::Escape)).bind(Binding::pad(P::Start)),
        ActionDef::axis2d("ui.navigate")
            .context("menu")
            .fixed()
            .bind(Binding::arrows())
            .bind(Binding::wasd())
            .bind(Binding::dpad())
            .bind(Binding::stick(Stick::Left).deadzone(0.5))
            .actuation(0.5),
        ActionDef::button("ui.accept")
            .context("menu")
            .fixed()
            .bind(k(KeyCode::Enter))
            .bind(k(KeyCode::NumpadEnter))
            .bind(k(KeyCode::Space))
            .bind(Binding::pad(P::South)),
        ActionDef::button("ui.back")
            .context("menu")
            .fixed()
            .bind(k(KeyCode::Escape))
            .bind(k(KeyCode::Backspace))
            .bind(Binding::pad(P::East))
            .bind(Binding::pad(P::Start)),
        ActionDef::button("ui.next_tab").context("menu").fixed().bind(k(KeyCode::KeyE)).bind(k(KeyCode::Tab)).bind(Binding::pad(P::RightTrigger)),
        ActionDef::button("ui.prev_tab")
            .context("menu")
            .fixed()
            .bind(k(KeyCode::KeyQ))
            .bind(shift_tab(KeyCode::ShiftLeft))
            .bind(shift_tab(KeyCode::ShiftRight))
            .bind(Binding::pad(P::LeftTrigger)),
    ]
}

/// Bindings the FPS controller's actions get (also used to rebuild them from `FpsKeys`).
pub fn fps_actions() -> Vec<ActionDef> {
    use GamepadButton as P;
    let k = Binding::key;
    vec![
        ActionDef::axis2d("move")
            .label("Move")
            .group("Movement")
            .bind(Binding::wasd())
            .bind(Binding::stick(Stick::Left).deadzone(0.18)),
        ActionDef::button("sprint")
            .label("Sprint")
            .group("Movement")
            .toggleable()
            .bind(k(KeyCode::ShiftLeft))
            .bind(k(KeyCode::ShiftRight))
            .bind(Binding::pad(P::LeftThumb)),
        ActionDef::button("jump").label("Jump").group("Movement").bind(k(KeyCode::Space)).bind(Binding::pad(P::South)),
        ActionDef::button("crouch")
            .label("Crouch")
            .group("Movement")
            .toggleable()
            .bind(k(KeyCode::ControlLeft))
            .bind(k(KeyCode::ControlRight))
            .bind(k(KeyCode::KeyC))
            .bind(Binding::pad(P::East)),
    ]
}

pub struct ActionsPlugin;

impl Plugin for ActionsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<InputContexts>()
            .init_resource::<ActionMap>()
            .init_resource::<ActionState>()
            .init_resource::<RebindCapture>()
            .init_resource::<virtual_pad::VirtualPad>()
            .add_message::<Rumble>()
            .configure_sets(
                PreUpdate,
                (ActionsSet.after(bevy::input::InputSystems), crate::input::InputSet.after(ActionsSet), crate::ui::widgets::NavInputSet.after(ActionsSet)),
            )
            .add_systems(First, virtual_pad::release_taps)
            .add_systems(PreUpdate, (auto_contexts, state::update_actions).chain().in_set(ActionsSet))
            .add_systems(PostStartup, apply_input_settings)
            .add_systems(Update, (rebind::capture_rebind, send_rumble))
            .add_systems(PostUpdate, sync_input_settings.before(crate::settings::SettingsSet::Track));
        for def in engine_actions() {
            app.add_action(def);
        }
        crate::settings::add_settings_section::<InputSettings>(app, "input");
        accessibility::build(app);
        #[cfg(feature = "devtools")]
        commands::register(app);
    }
}

/// Engine contexts follow the UI and the game state.
fn auto_contexts(
    state: Option<Res<State<AppState>>>,
    paused: Option<Res<Paused>>,
    screens: Option<Res<crate::ui::screens::Screens>>,
    capture: Res<RebindCapture>,
    mut contexts: ResMut<InputContexts>,
) {
    let menu = screens.is_some_and(|s| !s.stack.is_empty());
    let in_game = state.is_some_and(|s| *s.get() == AppState::InGame);
    let gameplay = in_game && !menu && !paused.is_some_and(|p| p.0);
    let rebind = capture.is_capturing();
    let want = |c: &InputContext| match c.name {
        "menu" if c.auto => Some(menu),
        "gameplay" if c.auto => Some(gameplay),
        "rebind" => Some(rebind),
        _ => None,
    };
    if contexts.list.iter().any(|c| want(c).is_some_and(|w| w != c.active)) {
        for c in &mut contexts.list {
            if let Some(w) = want(c) {
                c.active = w;
            }
        }
    }
}

fn apply_input_settings(settings: Res<InputSettings>, mut map: ResMut<ActionMap>) {
    settings.apply(&mut map);
}

/// Keep the saved overrides in step with the map (rebinds from the UI, control port, code).
fn sync_input_settings(map: Res<ActionMap>, mut settings: ResMut<InputSettings>) {
    if !map.is_changed() {
        return;
    }
    let now = InputSettings::from_map(&map);
    // Keep entries for actions this build doesn't define (another mode / DLC may).
    let mut merged = now.clone();
    for (k, v) in &settings.bindings {
        if map.get(k).is_none() {
            merged.bindings.insert(k.clone(), v.clone());
        }
    }
    if *settings != merged {
        *settings = merged;
    }
}

fn send_rumble(
    mut msgs: MessageReader<Rumble>,
    access: Res<Accessibility>,
    state: Res<ActionState>,
    pads: Query<Entity, With<bevy::input::gamepad::Gamepad>>,
    mut out: MessageWriter<GamepadRumbleRequest>,
) {
    for r in msgs.read() {
        let k = access.rumble.clamp(0.0, 1.0);
        if k <= 0.0 || r.secs <= 0.0 {
            continue;
        }
        let intensity = GamepadRumbleIntensity { strong_motor: (r.strong * k).clamp(0.0, 1.0), weak_motor: (r.weak * k).clamp(0.0, 1.0) };
        let duration = Duration::from_secs_f32(r.secs);
        let target = r.gamepad.or(state.last_gamepad).filter(|e| pads.contains(*e));
        match target {
            Some(gamepad) => {
                out.write(GamepadRumbleRequest::Add { duration, intensity, gamepad });
            }
            None => {
                for gamepad in &pads {
                    out.write(GamepadRumbleRequest::Add { duration, intensity, gamepad });
                }
            }
        }
    }
}

/// Every [`GamepadAxis`] and [`GamepadButton`] the engine knows by name (control port help).
pub fn pad_names() -> (Vec<String>, Vec<String>) {
    (
        GamepadButton::all().iter().map(|b| format!("{b:?}")).collect(),
        GamepadAxis::all().iter().map(|a| format!("{a:?}")).collect(),
    )
}

#[cfg(test)]
mod tests;
