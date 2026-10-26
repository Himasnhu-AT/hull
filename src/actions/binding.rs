//! Bindings: which physical input drives an action, plus per-binding modifiers.
//!
//! Every binding has a one-line text form (used by settings.json, the control port and tests),
//! e.g. `key:KeyW`, `mouse:Left`, `pad:South`, `padaxis:LeftStickX`, `stick:Right`,
//! `mouse:Motion`, `mouse:Wheel`, `dpad`, `keys:KeyW/KeyS/KeyA/KeyD` (up/down/left/right),
//! `keyaxis:KeyA/KeyD` (negative/positive). A chord (modifier keys that must also be held)
//! goes in front with `+`: `key:ControlLeft+key:KeyS`. Modifiers follow with `|`:
//! `stick:Right|deadzone(0.15,1)|scale(3,3)|persec`.

use std::fmt;

use bevy::input::gamepad::{GamepadAxis, GamepadButton};
use bevy::prelude::*;
use bevy::reflect::FromReflect;
use bevy::reflect::enums::{DynamicEnum, DynamicVariant};

/// A digital input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Button {
    Key(KeyCode),
    Mouse(MouseButton),
    Pad(GamepadButton),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Stick {
    Left,
    Right,
}

/// What a binding reads. Values are `Vec2`: digital inputs give `x` in 0..1 (pad triggers are
/// analog), 1D axes give `x` in -1..1, 2D inputs give both.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Input {
    Button(Button),
    PadAxis(GamepadAxis),
    Stick(Stick),
    /// Raw mouse counts this frame (y down).
    MouseMotion,
    /// Wheel this frame (lines; pixel scroll ÷ 16).
    MouseWheel,
    /// Four keys as a 2D axis (y up).
    Keys4 { up: KeyCode, down: KeyCode, left: KeyCode, right: KeyCode },
    /// Two keys as a 1D axis.
    KeyAxis { neg: KeyCode, pos: KeyCode },
    /// D-pad as a 2D axis (y up).
    DPad,
}

/// Per-binding (or per-action) value transform, applied in order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Modifier {
    /// Radial deadzone for 2D values (per-axis for 1D): magnitudes below `lower` → 0, above
    /// `upper` → 1, remapped linearly in between.
    Deadzone { lower: f32, upper: f32 },
    /// Flip the sign of x and/or y.
    Invert { x: bool, y: bool },
    /// Multiply (sensitivity).
    Scale(Vec2),
    /// Multiply by the frame's real delta seconds (turns a stick's -1..1 into a per-frame step).
    PerSecond,
    /// Swap x and y (a 1D key axis feeding the y of a 2D action).
    Swizzle,
    /// Response curve: magnitude^p (keeps the direction).
    Exponent(f32),
}

/// One way to trigger an action.
#[derive(Clone, Debug, PartialEq)]
pub struct Binding {
    pub input: Input,
    /// Buttons that must be held too (Ctrl in Ctrl+S).
    pub chord: Vec<Button>,
    pub modifiers: Vec<Modifier>,
}

/// Which device family a binding belongs to (settings columns, button prompts).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum Device {
    #[default]
    KeyboardMouse,
    Gamepad,
}

impl Device {
    pub fn name(self) -> &'static str {
        match self {
            Device::KeyboardMouse => "kbm",
            Device::Gamepad => "pad",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "kbm" | "keyboard" | "mouse" => Some(Device::KeyboardMouse),
            "pad" | "gamepad" => Some(Device::Gamepad),
            _ => None,
        }
    }
}

/// What a binding "occupies" for context consumption and conflict checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    Button(Button),
    PadAxis(GamepadAxis),
    Stick(Stick),
    MouseMotion,
    MouseWheel,
}

impl Binding {
    pub fn new(input: Input) -> Self {
        Binding { input, chord: Vec::new(), modifiers: Vec::new() }
    }
    pub fn key(k: KeyCode) -> Self {
        Self::new(Input::Button(Button::Key(k)))
    }
    pub fn mouse(b: MouseButton) -> Self {
        Self::new(Input::Button(Button::Mouse(b)))
    }
    pub fn pad(b: GamepadButton) -> Self {
        Self::new(Input::Button(Button::Pad(b)))
    }
    pub fn pad_axis(a: GamepadAxis) -> Self {
        Self::new(Input::PadAxis(a))
    }
    pub fn stick(s: Stick) -> Self {
        Self::new(Input::Stick(s))
    }
    pub fn keys4(up: KeyCode, down: KeyCode, left: KeyCode, right: KeyCode) -> Self {
        Self::new(Input::Keys4 { up, down, left, right })
    }
    pub fn wasd() -> Self {
        Self::keys4(KeyCode::KeyW, KeyCode::KeyS, KeyCode::KeyA, KeyCode::KeyD)
    }
    pub fn arrows() -> Self {
        Self::keys4(KeyCode::ArrowUp, KeyCode::ArrowDown, KeyCode::ArrowLeft, KeyCode::ArrowRight)
    }
    pub fn key_axis(neg: KeyCode, pos: KeyCode) -> Self {
        Self::new(Input::KeyAxis { neg, pos })
    }
    pub fn mouse_motion() -> Self {
        Self::new(Input::MouseMotion)
    }
    pub fn mouse_wheel() -> Self {
        Self::new(Input::MouseWheel)
    }
    pub fn dpad() -> Self {
        Self::new(Input::DPad)
    }
    /// Require `b` to be held as well (chord).
    pub fn with(mut self, b: Button) -> Self {
        self.chord.push(b);
        self
    }
    pub fn modifier(mut self, m: Modifier) -> Self {
        self.modifiers.push(m);
        self
    }
    pub fn deadzone(self, lower: f32) -> Self {
        self.modifier(Modifier::Deadzone { lower, upper: 1.0 })
    }
    pub fn scale(self, x: f32, y: f32) -> Self {
        self.modifier(Modifier::Scale(Vec2::new(x, y)))
    }
    pub fn per_second(self) -> Self {
        self.modifier(Modifier::PerSecond)
    }
    pub fn invert(self, x: bool, y: bool) -> Self {
        self.modifier(Modifier::Invert { x, y })
    }

    pub fn device(&self) -> Device {
        match self.input {
            Input::Button(Button::Pad(_)) | Input::PadAxis(_) | Input::Stick(_) | Input::DPad => Device::Gamepad,
            _ => Device::KeyboardMouse,
        }
    }

    /// The physical inputs this binding reads (chord buttons excluded), appended to `out`.
    pub fn sources(&self, out: &mut Vec<Source>) {
        match self.input {
            Input::Button(b) => out.push(Source::Button(b)),
            Input::PadAxis(a) => out.push(Source::PadAxis(a)),
            Input::Stick(s) => out.push(Source::Stick(s)),
            Input::MouseMotion => out.push(Source::MouseMotion),
            Input::MouseWheel => out.push(Source::MouseWheel),
            Input::Keys4 { up, down, left, right } => {
                out.extend([up, down, left, right].map(|k| Source::Button(Button::Key(k))));
            }
            Input::KeyAxis { neg, pos } => out.extend([neg, pos].map(|k| Source::Button(Button::Key(k)))),
            Input::DPad => out.extend(
                [GamepadButton::DPadUp, GamepadButton::DPadDown, GamepadButton::DPadLeft, GamepadButton::DPadRight]
                    .map(|b| Source::Button(Button::Pad(b))),
            ),
        }
    }

    /// Whether two bindings read any of the same physical input.
    pub fn overlaps(&self, other: &Binding) -> bool {
        let (mut a, mut b) = (Vec::new(), Vec::new());
        self.sources(&mut a);
        other.sources(&mut b);
        self.chord == other.chord && a.iter().any(|s| b.contains(s))
    }

    /// Short label for menus and prompts ("W A S D", "Ctrl + S", "Right stick", "A").
    pub fn label(&self) -> String {
        let main = match self.input {
            Input::Button(b) => button_label(b).to_string(),
            Input::PadAxis(a) => axis_label(a).to_string(),
            Input::Stick(Stick::Left) => "Left stick".into(),
            Input::Stick(Stick::Right) => "Right stick".into(),
            Input::MouseMotion => "Mouse".into(),
            Input::MouseWheel => "Mouse wheel".into(),
            Input::Keys4 { up, down, left, right } => {
                if [up, down, left, right] == [KeyCode::ArrowUp, KeyCode::ArrowDown, KeyCode::ArrowLeft, KeyCode::ArrowRight] {
                    "Arrows".into()
                } else {
                    [up, left, down, right].map(key_label).join(" ")
                }
            }
            Input::KeyAxis { neg, pos } => format!("{} / {}", key_label(neg), key_label(pos)),
            Input::DPad => "D-pad".into(),
        };
        if self.chord.is_empty() {
            main
        } else {
            let mut s: Vec<String> = self.chord.iter().map(|b| button_label(*b).to_string()).collect();
            s.push(main);
            s.join(" + ")
        }
    }
}

// ---------------------------------------------------------------- labels

/// "W", "Space", "Shift", "Mouse 1"…
pub fn key_label(k: KeyCode) -> String {
    let n = format!("{k:?}");
    if let Some(c) = n.strip_prefix("Key").filter(|c| c.len() == 1) {
        return c.to_string();
    }
    if let Some(d) = n.strip_prefix("Digit") {
        return d.to_string();
    }
    match k {
        KeyCode::ShiftLeft | KeyCode::ShiftRight => "Shift".into(),
        KeyCode::ControlLeft | KeyCode::ControlRight => "Ctrl".into(),
        KeyCode::AltLeft | KeyCode::AltRight => "Alt".into(),
        KeyCode::SuperLeft | KeyCode::SuperRight => "Cmd".into(),
        KeyCode::Escape => "Esc".into(),
        KeyCode::ArrowUp => "Up".into(),
        KeyCode::ArrowDown => "Down".into(),
        KeyCode::ArrowLeft => "Left".into(),
        KeyCode::ArrowRight => "Right".into(),
        KeyCode::Backspace => "Backspace".into(),
        KeyCode::NumpadEnter => "Enter".into(),
        _ => n,
    }
}

fn button_label(b: Button) -> String {
    match b {
        Button::Key(k) => key_label(k),
        Button::Mouse(MouseButton::Left) => "Mouse 1".into(),
        Button::Mouse(MouseButton::Right) => "Mouse 2".into(),
        Button::Mouse(MouseButton::Middle) => "Mouse 3".into(),
        Button::Mouse(MouseButton::Back) => "Mouse 4".into(),
        Button::Mouse(MouseButton::Forward) => "Mouse 5".into(),
        Button::Mouse(MouseButton::Other(n)) => format!("Mouse {}", n + 1),
        Button::Pad(p) => pad_label(p).into(),
    }
}

/// Xbox-style names (the most common layout on desktop).
pub fn pad_label(p: GamepadButton) -> &'static str {
    use GamepadButton::*;
    match p {
        South => "A",
        East => "B",
        West => "X",
        North => "Y",
        LeftTrigger => "LB",
        RightTrigger => "RB",
        LeftTrigger2 => "LT",
        RightTrigger2 => "RT",
        Select => "View",
        Start => "Menu",
        Mode => "Guide",
        LeftThumb => "LS",
        RightThumb => "RS",
        DPadUp => "D-pad up",
        DPadDown => "D-pad down",
        DPadLeft => "D-pad left",
        DPadRight => "D-pad right",
        C => "C",
        Z => "Z",
        Other(_) => "Pad ?",
    }
}

fn axis_label(a: GamepadAxis) -> &'static str {
    match a {
        GamepadAxis::LeftStickX => "Left stick X",
        GamepadAxis::LeftStickY => "Left stick Y",
        GamepadAxis::RightStickX => "Right stick X",
        GamepadAxis::RightStickY => "Right stick Y",
        GamepadAxis::LeftZ => "LT axis",
        GamepadAxis::RightZ => "RT axis",
        GamepadAxis::Other(_) => "Pad axis",
    }
}

// ---------------------------------------------------------------- text form

fn unit_variant<T: FromReflect>(name: &str) -> Option<T> {
    T::from_reflect(&DynamicEnum::new(name, DynamicVariant::Unit))
}

/// `KeyW`, `w`, `W`, `esc`, `space`, `shift`, `1`, `f3` → a `KeyCode`.
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
    if let Some(k) = alias.and_then(unit_variant::<KeyCode>) {
        return Some(k);
    }
    if let Some(k) = unit_variant::<KeyCode>(s) {
        return Some(k);
    }
    let mut chars = s.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return unit_variant(&format!("Key{}", c.to_ascii_uppercase()));
        } else if c.is_ascii_digit() {
            return unit_variant(&format!("Digit{c}"));
        }
    }
    let mut cap = lower;
    if let Some(f) = cap.get_mut(0..1) {
        f.make_ascii_uppercase();
    }
    unit_variant(&cap)
}

fn parse_mouse(s: &str) -> Option<MouseButton> {
    match s.to_ascii_lowercase().as_str() {
        "left" => Some(MouseButton::Left),
        "right" => Some(MouseButton::Right),
        "middle" => Some(MouseButton::Middle),
        "back" => Some(MouseButton::Back),
        "forward" => Some(MouseButton::Forward),
        other => other.strip_prefix("other(")?.strip_suffix(')')?.parse().ok().map(MouseButton::Other),
    }
}

/// `South`, `south`, `a` (Xbox names too: a b x y lb rb lt rt start view) → a pad button.
pub fn parse_pad_button(s: &str) -> Option<GamepadButton> {
    use GamepadButton::*;
    let l = s.to_ascii_lowercase();
    let alias = match l.as_str() {
        "a" | "cross" => Some(South),
        "b" | "circle" => Some(East),
        "x" | "square" => Some(West),
        "y" | "triangle" => Some(North),
        "lb" | "l1" => Some(LeftTrigger),
        "rb" | "r1" => Some(RightTrigger),
        "lt" | "l2" => Some(LeftTrigger2),
        "rt" | "r2" => Some(RightTrigger2),
        "start" | "menu" | "options" => Some(Start),
        "select" | "view" | "back" | "share" => Some(Select),
        "ls" | "l3" => Some(LeftThumb),
        "rs" | "r3" => Some(RightThumb),
        "up" | "dpad_up" => Some(DPadUp),
        "down" | "dpad_down" => Some(DPadDown),
        "left" | "dpad_left" => Some(DPadLeft),
        "right" | "dpad_right" => Some(DPadRight),
        _ => None,
    };
    alias.or_else(|| unit_variant(s)).or_else(|| {
        let mut cap = l.clone();
        cap.get_mut(0..1)?.make_ascii_uppercase();
        unit_variant(&cap)
    })
}

/// `LeftStickX`, `left_x`, `rx`, `lt`… → a pad axis.
pub fn parse_pad_axis(s: &str) -> Option<GamepadAxis> {
    use GamepadAxis::*;
    match s.to_ascii_lowercase().replace('_', "").as_str() {
        "leftstickx" | "leftx" | "lx" => Some(LeftStickX),
        "leftsticky" | "lefty" | "ly" => Some(LeftStickY),
        "rightstickx" | "rightx" | "rx" => Some(RightStickX),
        "rightsticky" | "righty" | "ry" => Some(RightStickY),
        "leftz" | "lz" => Some(LeftZ),
        "rightz" | "rz" => Some(RightZ),
        _ => None,
    }
}

fn button_text(b: Button) -> String {
    match b {
        Button::Key(k) => format!("key:{k:?}"),
        Button::Mouse(m) => format!("mouse:{m:?}"),
        Button::Pad(p) => format!("pad:{p:?}"),
    }
}

fn parse_button(s: &str) -> Result<Button, String> {
    let (kind, name) = s.split_once(':').ok_or_else(|| format!("`{s}`: expected key:/mouse:/pad:"))?;
    match kind {
        "key" => parse_key(name).map(Button::Key).ok_or_else(|| format!("unknown key `{name}`")),
        "mouse" => parse_mouse(name).map(Button::Mouse).ok_or_else(|| format!("unknown mouse button `{name}`")),
        "pad" => parse_pad_button(name).map(Button::Pad).ok_or_else(|| format!("unknown pad button `{name}`")),
        _ => Err(format!("`{s}` is not a button")),
    }
}

fn parse_floats(args: &str) -> Result<Vec<f32>, String> {
    args.split(',').map(|a| a.trim().parse::<f32>().map_err(|e| format!("`{a}`: {e}"))).collect()
}

impl fmt::Display for Modifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Modifier::Deadzone { lower, upper } => write!(f, "deadzone({lower},{upper})"),
            Modifier::Invert { x, y } => write!(f, "invert({}{})", if *x { "x" } else { "" }, if *y { "y" } else { "" }),
            Modifier::Scale(v) => write!(f, "scale({},{})", v.x, v.y),
            Modifier::PerSecond => write!(f, "persec"),
            Modifier::Swizzle => write!(f, "swizzle"),
            Modifier::Exponent(p) => write!(f, "exp({p})"),
        }
    }
}

impl std::str::FromStr for Modifier {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (name, args) = match s.split_once('(') {
            Some((n, rest)) => (n, rest.strip_suffix(')').ok_or_else(|| format!("`{s}`: missing `)`"))?),
            None => (s, ""),
        };
        Ok(match name {
            "deadzone" => {
                let v = parse_floats(args)?;
                Modifier::Deadzone { lower: *v.first().unwrap_or(&0.1), upper: *v.get(1).unwrap_or(&1.0) }
            }
            "invert" => Modifier::Invert { x: args.contains('x'), y: args.contains('y') },
            "scale" => {
                let v = parse_floats(args)?;
                let x = *v.first().ok_or("scale needs a value")?;
                Modifier::Scale(Vec2::new(x, *v.get(1).unwrap_or(&x)))
            }
            "persec" => Modifier::PerSecond,
            "swizzle" => Modifier::Swizzle,
            "exp" => Modifier::Exponent(*parse_floats(args)?.first().ok_or("exp needs a value")?),
            _ => return Err(format!("unknown modifier `{name}`")),
        })
    }
}

impl fmt::Display for Binding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for c in &self.chord {
            write!(f, "{}+", button_text(*c))?;
        }
        match self.input {
            Input::Button(b) => write!(f, "{}", button_text(b))?,
            Input::PadAxis(a) => write!(f, "padaxis:{a:?}")?,
            Input::Stick(s) => write!(f, "stick:{s:?}")?,
            Input::MouseMotion => write!(f, "mouse:Motion")?,
            Input::MouseWheel => write!(f, "mouse:Wheel")?,
            Input::Keys4 { up, down, left, right } => write!(f, "keys:{up:?}/{down:?}/{left:?}/{right:?}")?,
            Input::KeyAxis { neg, pos } => write!(f, "keyaxis:{neg:?}/{pos:?}")?,
            Input::DPad => write!(f, "dpad")?,
        }
        for m in &self.modifiers {
            write!(f, "|{m}")?;
        }
        Ok(())
    }
}

impl std::str::FromStr for Binding {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let mut parts = s.split('|');
        let head = parts.next().unwrap_or("").trim();
        let modifiers = parts.map(str::parse).collect::<Result<Vec<Modifier>, String>>()?;
        let mut pieces: Vec<&str> = head.split('+').map(str::trim).collect();
        let main = pieces.pop().filter(|m| !m.is_empty()).ok_or("empty binding")?;
        let chord = pieces.into_iter().map(parse_button).collect::<Result<Vec<_>, _>>()?;
        let keys = |list: &str, n: usize| -> Result<Vec<KeyCode>, String> {
            let ks: Vec<KeyCode> = list.split('/').map(|k| parse_key(k).ok_or_else(|| format!("unknown key `{k}`"))).collect::<Result<_, _>>()?;
            if ks.len() != n {
                return Err(format!("`{list}`: expected {n} keys separated by /"));
            }
            Ok(ks)
        };
        let input = match main.split_once(':') {
            None if main == "dpad" => Input::DPad,
            Some(("mouse", m)) if m.eq_ignore_ascii_case("motion") => Input::MouseMotion,
            Some(("mouse", m)) if m.eq_ignore_ascii_case("wheel") => Input::MouseWheel,
            Some(("padaxis", a)) => Input::PadAxis(parse_pad_axis(a).ok_or_else(|| format!("unknown pad axis `{a}`"))?),
            Some(("stick", st)) => Input::Stick(match st.to_ascii_lowercase().as_str() {
                "left" | "l" => Stick::Left,
                "right" | "r" => Stick::Right,
                _ => return Err(format!("unknown stick `{st}`")),
            }),
            Some(("keys", list)) => {
                let k = keys(list, 4)?;
                Input::Keys4 { up: k[0], down: k[1], left: k[2], right: k[3] }
            }
            Some(("keyaxis", list)) => {
                let k = keys(list, 2)?;
                Input::KeyAxis { neg: k[0], pos: k[1] }
            }
            _ => Input::Button(parse_button(main)?),
        };
        Ok(Binding { input, chord, modifiers })
    }
}

// ---------------------------------------------------------------- modifiers

/// Apply `mods` to `v` (2D values use a radial deadzone).
pub fn apply_modifiers(mut v: Vec2, mods: &[Modifier], dt: f32, two_d: bool) -> Vec2 {
    for m in mods {
        v = match *m {
            Modifier::Deadzone { lower, upper } => {
                let remap = |mag: f32| {
                    if mag <= lower {
                        0.0
                    } else if mag >= upper {
                        1.0
                    } else {
                        (mag - lower) / (upper - lower).max(1e-6)
                    }
                };
                if two_d {
                    let mag = v.length();
                    if mag <= 1e-6 { Vec2::ZERO } else { v / mag * remap(mag) }
                } else {
                    Vec2::new(v.x.signum() * remap(v.x.abs()), v.y.signum() * remap(v.y.abs()))
                }
            }
            Modifier::Invert { x, y } => Vec2::new(if x { -v.x } else { v.x }, if y { -v.y } else { v.y }),
            Modifier::Scale(s) => v * s,
            Modifier::PerSecond => v * dt,
            Modifier::Swizzle => Vec2::new(v.y, v.x),
            Modifier::Exponent(p) => {
                let mag = v.length();
                if mag <= 1e-6 { v } else { v / mag * mag.powf(p) }
            }
        };
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_round_trip() {
        for s in [
            "key:KeyW",
            "mouse:Left",
            "pad:South",
            "padaxis:LeftStickX",
            "stick:Right|deadzone(0.15,1)|scale(3,3)|persec",
            "mouse:Motion|scale(0.0022,0.0022)",
            "mouse:Wheel",
            "keys:KeyW/KeyS/KeyA/KeyD",
            "keyaxis:KeyA/KeyD|swizzle",
            "dpad",
            "key:ControlLeft+key:KeyS",
            "pad:LeftTrigger+pad:South|invert(xy)|exp(2)",
        ] {
            let b: Binding = s.parse().unwrap_or_else(|e| panic!("{s}: {e}"));
            assert_eq!(b.to_string(), s);
        }
        let b: Binding = "key:w".parse().unwrap();
        assert_eq!(b, Binding::key(KeyCode::KeyW));
        assert_eq!("pad:a".parse::<Binding>().unwrap(), Binding::pad(GamepadButton::South));
        assert!("key:nope".parse::<Binding>().is_err());
        assert!("keys:w/s".parse::<Binding>().is_err());
        assert!("stick:left|wobble".parse::<Binding>().is_err());
    }

    #[test]
    fn labels() {
        assert_eq!(Binding::wasd().label(), "W A S D");
        assert_eq!(Binding::key(KeyCode::KeyS).with(Button::Key(KeyCode::ControlLeft)).label(), "Ctrl + S");
        assert_eq!(Binding::pad(GamepadButton::South).label(), "A");
        assert_eq!(Binding::arrows().label(), "Arrows");
        assert_eq!(Binding::stick(Stick::Left).device(), Device::Gamepad);
        assert_eq!(Binding::mouse_motion().device(), Device::KeyboardMouse);
    }

    #[test]
    fn modifier_math() {
        let dz = [Modifier::Deadzone { lower: 0.2, upper: 1.0 }];
        assert_eq!(apply_modifiers(Vec2::new(0.1, 0.1), &dz, 0.0, true), Vec2::ZERO);
        let v = apply_modifiers(Vec2::new(0.6, 0.0), &dz, 0.0, true);
        assert!((v.x - 0.5).abs() < 1e-5, "{v}");
        let v = apply_modifiers(Vec2::new(-0.6, 0.1), &dz, 0.0, false);
        assert!((v.x + 0.5).abs() < 1e-5 && v.y == 0.0);
        let v = apply_modifiers(Vec2::new(1.0, 2.0), &[Modifier::Invert { x: false, y: true }, Modifier::Scale(Vec2::splat(2.0)), Modifier::PerSecond], 0.5, true);
        assert_eq!(v, Vec2::new(1.0, -2.0));
        assert_eq!(apply_modifiers(Vec2::new(1.0, 0.0), &[Modifier::Swizzle], 0.0, true), Vec2::new(0.0, 1.0));
        let v = apply_modifiers(Vec2::new(0.5, 0.0), &[Modifier::Exponent(2.0)], 0.0, true);
        assert!((v.x - 0.25).abs() < 1e-6);
    }

    #[test]
    fn overlap() {
        assert!(Binding::wasd().overlaps(&Binding::key(KeyCode::KeyW)));
        assert!(!Binding::wasd().overlaps(&Binding::key(KeyCode::KeyW).with(Button::Key(KeyCode::ControlLeft))));
        assert!(!Binding::wasd().overlaps(&Binding::arrows()));
    }
}
