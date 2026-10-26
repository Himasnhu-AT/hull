//! Accessibility settings (section `"accessibility"` of settings.json), readable by any system
//! as `Res<Accessibility>`. Rows: "Interface" tab (text size, high contrast, colour filter,
//! filter strength, reduce motion, camera shake) and "Controls" (hold or toggle, rumble).
//!
//! Applied by the engine:
//! - `text_scale` → Bevy's `RemSize` (the UI kit's fonts are rem-based, so every engine and
//!   game text made with `ui::theme::{body, label, display}` scales; layout boxes stay).
//! - `toggle` → [`super::Action::toggle_mode`] of every `toggleable` action (sprint, crouch…),
//!   with per-action exceptions in `toggle_overrides`.
//! - `rumble` → [`super::Rumble`] strength (0 = off).
//! - `high_contrast` → the UI kit swaps in [`crate::ui::theme::Theme::high_contrast`].
//! - `colorblind` → a full-screen colour filter after the UI pass ([`crate::ui::colorblind`]),
//!   zero cost while `Off` (the component is removed).
//!
//! For game systems: [`Accessibility::shake_scale`] (0 with reduce motion) and
//! [`Accessibility::motion_scale`] (head bob, camera sway, screen-space motion effects).

use std::collections::BTreeMap;

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

use super::map::ActionMap;
use crate::settings::{FieldDef, FieldKind, RegisterSettings, format_percent};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ColorblindMode {
    #[default]
    Off,
    /// Red-weak / red-blind.
    Protanopia,
    /// Green-weak / green-blind (most common).
    Deuteranopia,
    /// Blue-yellow.
    Tritanopia,
}

impl ColorblindMode {
    pub const ALL: [ColorblindMode; 4] = [Self::Off, Self::Protanopia, Self::Deuteranopia, Self::Tritanopia];
    pub fn index(self) -> usize {
        self as usize
    }
    pub fn from_index(i: usize) -> Self {
        Self::ALL[i.min(3)]
    }
}

#[derive(Resource, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Accessibility {
    /// Text size multiplier (0.8..1.6).
    pub text_scale: f32,
    pub high_contrast: bool,
    pub colorblind: ColorblindMode,
    /// 0..1 strength of the colour filter.
    pub colorblind_strength: f32,
    /// Show what the mode looks like to a colour-blind player instead of correcting for it
    /// (for developers checking their palette; control port `ui.setting colorblind_simulate`).
    pub colorblind_simulate: bool,
    /// Turn off camera shake, head bob and other big screen motion.
    pub reduce_motion: bool,
    /// 0..1 camera shake strength.
    pub camera_shake: f32,
    /// `toggleable` actions (sprint, crouch…) toggle instead of hold.
    pub toggle: bool,
    /// Per-action exceptions to `toggle` (action name → toggle?).
    pub toggle_overrides: BTreeMap<String, bool>,
    /// 0..1 gamepad rumble strength.
    pub rumble: f32,
}

impl Default for Accessibility {
    fn default() -> Self {
        Accessibility {
            text_scale: 1.0,
            high_contrast: false,
            colorblind: ColorblindMode::Off,
            colorblind_strength: 1.0,
            colorblind_simulate: false,
            reduce_motion: false,
            camera_shake: 1.0,
            toggle: false,
            toggle_overrides: BTreeMap::new(),
            rumble: 1.0,
        }
    }
}

impl Accessibility {
    /// Multiply camera shake by this (0 when reduce motion is on).
    pub fn shake_scale(&self) -> f32 {
        if self.reduce_motion { 0.0 } else { self.camera_shake.clamp(0.0, 1.0) }
    }
    /// Multiply head bob / sway / motion effects by this.
    pub fn motion_scale(&self) -> f32 {
        if self.reduce_motion { 0.0 } else { 1.0 }
    }
    /// Whether a `toggleable` action toggles.
    pub fn toggles(&self, action: &str) -> bool {
        self.toggle_overrides.get(action).copied().unwrap_or(self.toggle)
    }
}

/// Reference rem size (Bevy's default `RemSize`), at text scale 1.
pub const BASE_REM: f32 = 20.0;

pub(super) fn build(app: &mut App) {
    crate::settings::add_settings_section::<Accessibility>(app, "accessibility");
    crate::ui::settings_screen::RegisterSettingsUi::settings_defaults::<Accessibility>(app);
    app.add_systems(PostStartup, apply_toggles)
        .add_systems(Update, (apply_toggles.run_if(toggles_dirty), apply_text_scale));
    register_rows(app);
    let headless = app.world().get_resource::<crate::flow::Headless>().is_some_and(|h| h.0);
    if !headless {
        app.add_plugins(crate::ui::colorblind::ColorblindPlugin);
    }
}

fn toggles_dirty(a: Res<Accessibility>, map: Res<ActionMap>) -> bool {
    a.is_changed() || map.is_changed()
}

fn apply_toggles(a: Res<Accessibility>, mut map: ResMut<ActionMap>) {
    let want: Vec<bool> = map.iter().map(|x| x.def.toggleable && a.toggles(x.def.name)).collect();
    if map.iter().zip(&want).any(|(x, w)| x.toggle_mode != *w) {
        for (x, w) in map.actions.iter_mut().zip(want) {
            x.toggle_mode = w;
        }
    }
}

fn apply_text_scale(a: Res<Accessibility>, rem: Option<ResMut<bevy::text::RemSize>>) {
    let Some(mut rem) = rem else { return };
    let want = BASE_REM * a.text_scale.clamp(0.8, 1.6);
    if (rem.0 - want).abs() > 1e-3 {
        rem.0 = want;
    }
}

fn acc(w: &World) -> &Accessibility {
    w.resource::<Accessibility>()
}
fn acc_mut(w: &mut World) -> Mut<'_, Accessibility> {
    w.resource_mut::<Accessibility>()
}

fn register_rows(app: &mut App) {
    app.register_setting(FieldDef {
        key: "text_scale",
        tab: "Interface",
        label: "Text size",
        hint: "Size of all menu and HUD text.",
        kind: FieldKind::Slider { min: 0.8, max: 1.6, step: 0.1, format: format_percent },
        get: |w| acc(w).text_scale,
        set: |w, v| acc_mut(w).text_scale = v.clamp(0.8, 1.6),
    })
    .register_setting(FieldDef {
        key: "high_contrast",
        tab: "Interface",
        label: "High contrast",
        hint: "Solid panels, brighter text and a stronger focus colour.",
        kind: FieldKind::Toggle,
        get: |w| acc(w).high_contrast as u8 as f32,
        set: |w, v| acc_mut(w).high_contrast = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "colorblind",
        tab: "Interface",
        label: "Colour filter",
        hint: "Shifts colours that are hard to tell apart for colour-blind players.",
        kind: FieldKind::Choice { options: vec!["Off", "Protanopia", "Deuteranopia", "Tritanopia"] },
        get: |w| acc(w).colorblind.index() as f32,
        set: |w, v| acc_mut(w).colorblind = ColorblindMode::from_index(v.round().max(0.0) as usize),
    })
    .register_setting(FieldDef {
        key: "colorblind_strength",
        tab: "Interface",
        label: "Filter strength",
        hint: "How strongly the colour filter is applied.",
        kind: FieldKind::Slider { min: 0.0, max: 1.0, step: 0.1, format: format_percent },
        get: |w| acc(w).colorblind_strength,
        set: |w, v| acc_mut(w).colorblind_strength = v.clamp(0.0, 1.0),
    })
    .register_setting(FieldDef {
        key: "colorblind_simulate",
        tab: "",
        label: "Simulate colour blindness",
        hint: "",
        kind: FieldKind::Toggle,
        get: |w| acc(w).colorblind_simulate as u8 as f32,
        set: |w, v| acc_mut(w).colorblind_simulate = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "reduce_motion",
        tab: "Interface",
        label: "Reduce motion",
        hint: "Turns off camera shake, head bob and other strong screen motion.",
        kind: FieldKind::Toggle,
        get: |w| acc(w).reduce_motion as u8 as f32,
        set: |w, v| acc_mut(w).reduce_motion = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "camera_shake",
        tab: "Interface",
        label: "Camera shake",
        hint: "Strength of camera shake from explosions and impacts.",
        kind: FieldKind::Slider { min: 0.0, max: 1.0, step: 0.1, format: format_percent },
        get: |w| acc(w).camera_shake,
        set: |w, v| acc_mut(w).camera_shake = v.clamp(0.0, 1.0),
    })
    .register_setting(FieldDef {
        key: "toggle_actions",
        tab: "Controls",
        label: "Sprint and crouch",
        hint: "Hold the button, or press once to turn on and again to turn off.",
        kind: FieldKind::Choice { options: vec!["Hold", "Toggle"] },
        get: |w| acc(w).toggle as u8 as f32,
        set: |w, v| acc_mut(w).toggle = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "rumble",
        tab: "Controls",
        label: "Controller vibration",
        hint: "Strength of gamepad rumble. 0% turns it off.",
        kind: FieldKind::Slider { min: 0.0, max: 1.0, step: 0.1, format: format_percent },
        get: |w| acc(w).rumble,
        set: |w, v| acc_mut(w).rumble = v.clamp(0.0, 1.0),
    });
}
