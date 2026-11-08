//! Button prompts: action name -> glyph text / icon id for the device in use, for key-hint bars
//! ("[Space] Jump   [E] Use"). Reads the live [`ActionMap`] (so rebinding shows up) and
//! `ActionState::last_device` (so the bar flips when the player picks up a pad).
//!
//! `text` is always readable ("Space", "Cross", "Right stick"); `icon` is a stable id
//! (`key.space`, `mouse.left`, `pad.ps.cross`, `pad.xbox.a`, `stick.right`) that a game maps to
//! sprites; unknown ids fall back to the text.

use bevy::input::gamepad::GamepadButton;
use bevy::prelude::*;

use crate::actions::binding::{Binding, Button, Device, Input, Stick, key_label};
use crate::actions::map::ActionMap;
use crate::actions::state::ActionState;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum PadFamily {
    #[default]
    Xbox,
    PlayStation,
    Switch,
    Generic,
}

impl PadFamily {
    pub fn id(self) -> &'static str {
        match self {
            Self::Xbox => "xbox",
            Self::PlayStation => "ps",
            Self::Switch => "switch",
            Self::Generic => "pad",
        }
    }

    /// Guess from a controller's reported name ("DualSense Wireless Controller").
    pub fn from_name(name: &str) -> Self {
        let n = name.to_ascii_lowercase();
        if n.contains("dualsense") || n.contains("dualshock") || n.contains("playstation") || n.contains("ps4") || n.contains("ps5") || n.contains("sony") {
            Self::PlayStation
        } else if n.contains("xbox") || n.contains("xinput") || n.contains("microsoft") {
            Self::Xbox
        } else if n.contains("nintendo") || n.contains("switch") || n.contains("joy-con") || n.contains("pro controller") {
            Self::Switch
        } else {
            Self::Generic
        }
    }
}

/// The family used for pad prompts. Set it from the connected controller's name
/// (see `detect_pad_family`) or from a game setting.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct PadStyle(pub PadFamily);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Glyph {
    pub text: String,
    pub icon: String,
}

impl Glyph {
    fn new(text: impl Into<String>, icon: impl Into<String>) -> Self {
        Glyph { text: text.into(), icon: icon.into() }
    }
    /// Shown when the action has no binding on the device.
    pub fn unbound() -> Self {
        Glyph::new("\u{2014}", "none")
    }
}

fn pad_button(b: GamepadButton, fam: PadFamily) -> (&'static str, &'static str) {
    use GamepadButton::*;
    use PadFamily::*;
    // (label, icon suffix)
    match (b, fam) {
        (South, PlayStation) => ("Cross", "cross"),
        (East, PlayStation) => ("Circle", "circle"),
        (West, PlayStation) => ("Square", "square"),
        (North, PlayStation) => ("Triangle", "triangle"),
        (South, Switch) => ("B", "b"),
        (East, Switch) => ("A", "a"),
        (West, Switch) => ("Y", "y"),
        (North, Switch) => ("X", "x"),
        (South, _) => ("A", "a"),
        (East, _) => ("B", "b"),
        (West, _) => ("X", "x"),
        (North, _) => ("Y", "y"),
        (LeftTrigger, PlayStation) => ("L1", "l1"),
        (RightTrigger, PlayStation) => ("R1", "r1"),
        (LeftTrigger2, PlayStation) => ("L2", "l2"),
        (RightTrigger2, PlayStation) => ("R2", "r2"),
        (LeftTrigger, Switch) => ("L", "l"),
        (RightTrigger, Switch) => ("R", "r"),
        (LeftTrigger2, Switch) => ("ZL", "zl"),
        (RightTrigger2, Switch) => ("ZR", "zr"),
        (LeftTrigger, _) => ("LB", "lb"),
        (RightTrigger, _) => ("RB", "rb"),
        (LeftTrigger2, _) => ("LT", "lt"),
        (RightTrigger2, _) => ("RT", "rt"),
        (Start, PlayStation) => ("Options", "start"),
        (Select, PlayStation) => ("Share", "select"),
        (Start, Switch) => ("+", "start"),
        (Select, Switch) => ("-", "select"),
        (Start, _) => ("Menu", "start"),
        (Select, _) => ("View", "select"),
        (LeftThumb, _) => ("L3", "l3"),
        (RightThumb, _) => ("R3", "r3"),
        (DPadUp, _) => ("D-pad up", "dpad_up"),
        (DPadDown, _) => ("D-pad down", "dpad_down"),
        (DPadLeft, _) => ("D-pad left", "dpad_left"),
        (DPadRight, _) => ("D-pad right", "dpad_right"),
        (Mode, _) => ("Guide", "guide"),
        _ => ("Button", "other"),
    }
}

fn button_glyph(b: Button, fam: PadFamily) -> Glyph {
    match b {
        Button::Key(k) => Glyph::new(key_label(k), format!("key.{}", key_label(k).to_ascii_lowercase().replace(' ', "_"))),
        Button::Mouse(m) => {
            let id = match m {
                MouseButton::Left => "left",
                MouseButton::Right => "right",
                MouseButton::Middle => "middle",
                MouseButton::Back => "back",
                MouseButton::Forward => "forward",
                MouseButton::Other(_) => "other",
            };
            Glyph::new(Binding::new(Input::Button(b)).label(), format!("mouse.{id}"))
        }
        Button::Pad(p) => {
            let (label, icon) = pad_button(p, fam);
            Glyph::new(label, format!("pad.{}.{icon}", fam.id()))
        }
    }
}

/// The glyph of one binding. A chord shows as `Ctrl + S` (icon: the main input's).
pub fn binding_glyph(b: &Binding, fam: PadFamily) -> Glyph {
    let main = match b.input {
        Input::Button(btn) => button_glyph(btn, fam),
        Input::Stick(Stick::Left) => Glyph::new("Left stick", "stick.left"),
        Input::Stick(Stick::Right) => Glyph::new("Right stick", "stick.right"),
        Input::DPad => Glyph::new("D-pad", "dpad"),
        Input::MouseMotion => Glyph::new("Mouse", "mouse.move"),
        Input::MouseWheel => Glyph::new("Mouse wheel", "mouse.wheel"),
        _ => Glyph::new(b.label(), format!("key.{}", b.label().to_ascii_lowercase().replace([' ', '/'], "_"))),
    };
    if b.chord.is_empty() {
        return main;
    }
    let mut text: Vec<String> = b.chord.iter().map(|c| button_glyph(*c, fam).text).collect();
    text.push(main.text);
    Glyph::new(text.join(" + "), main.icon)
}

/// The glyph of `action` on `dev`; [`Glyph::unbound`] when it has no binding there.
pub fn glyph(map: &ActionMap, action: &str, dev: Device, fam: PadFamily) -> Glyph {
    map.binding_for(action, dev).map_or_else(Glyph::unbound, |b| binding_glyph(b, fam))
}

/// `[Space] Jump   [E] Use` for `(action, label)` pairs.
pub fn hint_bar(map: &ActionMap, dev: Device, fam: PadFamily, items: &[(&str, &str)]) -> String {
    items.iter().map(|(a, l)| format!("[{}] {}", glyph(map, a, dev, fam).text, l)).collect::<Vec<_>>().join("   ")
}

/// Glyphs for the device the player is using now. `Res<Glyphs>` in a system.
#[derive(bevy::ecs::system::SystemParam)]
pub struct Glyphs<'w> {
    map: Res<'w, ActionMap>,
    state: Option<Res<'w, ActionState>>,
    style: Option<Res<'w, PadStyle>>,
}

impl Glyphs<'_> {
    pub fn device(&self) -> Device {
        self.state.as_ref().map_or(Device::KeyboardMouse, |s| s.last_device)
    }
    pub fn family(&self) -> PadFamily {
        self.style.as_ref().map_or_else(PadFamily::default, |s| s.0)
    }
    pub fn get(&self, action: &str) -> Glyph {
        glyph(&self.map, action, self.device(), self.family())
    }
    pub fn bar(&self, items: &[(&str, &str)]) -> String {
        hint_bar(&self.map, self.device(), self.family(), items)
    }
}

/// Picks the [`PadStyle`] from the first connected controller's name.
pub(super) fn detect_pad_family(pads: Query<&Gamepad, Added<Gamepad>>, mut style: ResMut<PadStyle>) {
    if let Some(g) = pads.iter().next() {
        let fam = g.vendor_id().zip(g.product_id()).map_or(PadFamily::Generic, |(v, _)| match v {
            0x054c => PadFamily::PlayStation,
            0x045e => PadFamily::Xbox,
            0x057e => PadFamily::Switch,
            _ => PadFamily::Generic,
        });
        if fam != PadFamily::Generic {
            style.0 = fam;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::map::ActionDef;

    fn map() -> ActionMap {
        let mut m = ActionMap::default();
        m.add(ActionDef::button("jump").bind(Binding::key(KeyCode::Space)).bind(Binding::pad(GamepadButton::South)));
        m.add(ActionDef::button("use").bind(Binding::key(KeyCode::KeyE)).bind(Binding::pad(GamepadButton::West)));
        m.add(ActionDef::axis2d("look").bind(Binding::mouse_motion()).bind(Binding::stick(Stick::Right)));
        let mut save = Binding::key(KeyCode::KeyS);
        save.chord.push(Button::Key(KeyCode::ControlLeft));
        m.add(ActionDef::button("save").bind(save));
        m
    }

    #[test]
    fn keys_get_readable_labels() {
        let mut m = ActionMap::default();
        for (name, k) in [("a", KeyCode::Space), ("b", KeyCode::Enter), ("c", KeyCode::Tab), ("d", KeyCode::ShiftLeft), ("e", KeyCode::Escape), ("f", KeyCode::ArrowUp)] {
            m.add(ActionDef::button(name).bind(Binding::key(k)));
        }
        let items = [("a", "Jump"), ("b", "OK"), ("c", "Swap"), ("d", "Run"), ("e", "Pause"), ("f", "Up")];
        assert_eq!(hint_bar(&m, Device::KeyboardMouse, PadFamily::Xbox, &items), "[Space] Jump   [Enter] OK   [Tab] Swap   [Shift] Run   [Esc] Pause   [Up] Up");
        // An action nobody registered shows the unbound dash, not a key.
        assert_eq!(hint_bar(&m, Device::KeyboardMouse, PadFamily::Xbox, &[("missing", "X")]), "[\u{2014}] X");
    }

    #[test]
    fn keyboard_and_pad_glyphs() {
        let m = map();
        let g = glyph(&m, "jump", Device::KeyboardMouse, PadFamily::Xbox);
        assert_eq!((g.text.as_str(), g.icon.as_str()), ("Space", "key.space"));
        let g = glyph(&m, "jump", Device::Gamepad, PadFamily::PlayStation);
        assert_eq!((g.text.as_str(), g.icon.as_str()), ("Cross", "pad.ps.cross"));
        assert_eq!(glyph(&m, "jump", Device::Gamepad, PadFamily::Switch).text, "B");
        assert_eq!(glyph(&m, "look", Device::Gamepad, PadFamily::Xbox).icon, "stick.right");
        assert_eq!(glyph(&m, "look", Device::KeyboardMouse, PadFamily::Xbox).icon, "mouse.move");
        assert_eq!(glyph(&m, "save", Device::KeyboardMouse, PadFamily::Xbox).text, "Ctrl + S");
        assert_eq!(glyph(&m, "nope", Device::KeyboardMouse, PadFamily::Xbox), Glyph::unbound());
    }

    #[test]
    fn hint_bar_follows_rebinding_and_device() {
        let mut m = map();
        let items = [("jump", "Jump"), ("use", "Use")];
        assert_eq!(hint_bar(&m, Device::KeyboardMouse, PadFamily::Xbox, &items), "[Space] Jump   [E] Use");
        assert_eq!(hint_bar(&m, Device::Gamepad, PadFamily::PlayStation, &items), "[Cross] Jump   [Square] Use");
        m.rebind("jump", Binding::key(KeyCode::KeyF)).unwrap();
        assert!(hint_bar(&m, Device::KeyboardMouse, PadFamily::Xbox, &items).starts_with("[F] Jump"));
    }

    #[test]
    fn family_from_controller_name() {
        assert_eq!(PadFamily::from_name("DualSense Wireless Controller"), PadFamily::PlayStation);
        assert_eq!(PadFamily::from_name("Xbox Series X Controller"), PadFamily::Xbox);
        assert_eq!(PadFamily::from_name("Nintendo Switch Pro Controller"), PadFamily::Switch);
        assert_eq!(PadFamily::from_name("Generic USB Joystick"), PadFamily::Generic);
    }
}
