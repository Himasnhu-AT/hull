//! [`ActionState`]: every action's value this frame, and the evaluation that fills it.
//!
//! Per frame (PreUpdate, after Bevy's input systems): contexts from the highest priority down;
//! an active exclusive context hides the ones below; inside a live context each action takes
//! the strongest of its bindings (skipping inputs a higher context consumed and plain bindings
//! shadowed by a held chord, e.g. `Tab` while `Shift+Tab` is down), applies modifiers, then its
//! trigger. No allocation after the first frame (scratch vectors are reused).

use bevy::input::gamepad::{Gamepad, GamepadAxis, GamepadButton};
use bevy::input::mouse::{AccumulatedMouseMotion, AccumulatedMouseScroll, MouseScrollUnit};
use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::binding::{Binding, Button, Device, Input, Source, Stick, apply_modifiers};
use super::map::{ActionId, ActionKind, ActionMap, InputContexts, Trigger};

/// One action's state this frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ActionData {
    /// Buttons: x = 1 while active. Axes: the (modified) value while active.
    pub value: Vec2,
    pub active: bool,
    pub just_pressed: bool,
    pub just_released: bool,
    /// Seconds (real time) it has been active.
    pub active_secs: f32,
    /// Device of the binding that drove it last.
    pub device: Device,
    // trigger machine
    raw: bool,
    hold: f32,
    last_hold: f32,
    last_press: f32,
    toggled: bool,
    wait_release: bool,
    live: bool,
    offline_held: bool,
}

#[derive(Clone, Debug, Default)]
struct BindingLayout {
    sources: Vec<Source>,
    /// Indices into `Layout::chords` whose held chord shadows this (chord-less) binding.
    shadows: Vec<usize>,
}

#[derive(Clone, Debug, Default)]
struct Layout {
    /// Action indices per context (index into `InputContexts::list`).
    by_context: Vec<Vec<usize>>,
    bindings: Vec<Vec<BindingLayout>>,
    chords: Vec<Vec<Button>>,
    required: Vec<Option<usize>>,
    generation: u32,
}

/// Values of every action this frame. Read it anywhere (`Res<ActionState>`):
/// `state.just_pressed("jump")`, `state.axis2d("move")`.
#[derive(Resource, Clone, Debug, Default)]
pub struct ActionState {
    data: Vec<ActionData>,
    names: HashMap<&'static str, usize>,
    layout: Layout,
    consumed: Vec<Source>,
    pending: Vec<Source>,
    /// What the player used last (button prompts).
    pub last_device: Device,
    /// The gamepad that sent input last (rumble target).
    pub last_gamepad: Option<Entity>,
    time: f32,
}

impl ActionState {
    pub fn get(&self, name: &str) -> Option<&ActionData> {
        self.names.get(name).and_then(|i| self.data.get(*i))
    }
    pub fn data(&self, id: ActionId) -> Option<&ActionData> {
        self.data.get(id.0)
    }
    /// Active now.
    pub fn pressed(&self, name: &str) -> bool {
        self.get(name).is_some_and(|d| d.active)
    }
    pub fn just_pressed(&self, name: &str) -> bool {
        self.get(name).is_some_and(|d| d.just_pressed)
    }
    pub fn just_released(&self, name: &str) -> bool {
        self.get(name).is_some_and(|d| d.just_released)
    }
    /// x of the value (buttons 0/1, 1D axes).
    pub fn value(&self, name: &str) -> f32 {
        self.get(name).map_or(0.0, |d| d.value.x)
    }
    pub fn axis2d(&self, name: &str) -> Vec2 {
        self.get(name).map_or(Vec2::ZERO, |d| d.value)
    }
    /// Ignore `action` until its input is released (after a rebind with the key still down).
    pub fn wait_for_release(&mut self, action: &str) {
        if let Some(d) = self.names.get(action).and_then(|i| self.data.get_mut(*i)) {
            d.wait_release = true;
        }
    }
    pub fn iter<'a>(&'a self, map: &'a ActionMap) -> impl Iterator<Item = (&'a str, &'a ActionData)> {
        map.iter().zip(self.data.iter()).map(|(a, d)| (a.def.name, d))
    }
}

/// Read access to every device for one frame.
pub struct Devices<'a> {
    pub keys: Option<&'a ButtonInput<KeyCode>>,
    pub mouse: Option<&'a ButtonInput<MouseButton>>,
    pub motion: Vec2,
    pub wheel: Vec2,
    pub pads: Pads<'a>,
}

/// The connected gamepads (a slice in tests, the ECS query in the app).
#[derive(Clone, Copy)]
pub enum Pads<'a> {
    None,
    Slice(&'a [(Entity, &'a Gamepad)]),
    Query(&'a Query<'a, 'a, (Entity, &'static Gamepad)>),
}

impl<'a> Pads<'a> {
    pub fn iter(self) -> impl Iterator<Item = (Entity, &'a Gamepad)> {
        let (a, b) = match self {
            Pads::None => (None, None),
            Pads::Slice(s) => (Some(s.iter().map(|(e, g)| (*e, *g))), None),
            Pads::Query(q) => (None, Some(q.iter())),
        };
        a.into_iter().flatten().chain(b.into_iter().flatten())
    }
}

impl Devices<'_> {
    pub fn held(&self, b: Button) -> bool {
        self.button(b) >= 0.5
    }
    pub fn button(&self, b: Button) -> f32 {
        match b {
            Button::Key(k) => self.keys.is_some_and(|i| i.pressed(k)) as u8 as f32,
            Button::Mouse(m) => self.mouse.is_some_and(|i| i.pressed(m)) as u8 as f32,
            Button::Pad(p) => self.pads.iter().map(|(_, g)| pad_button(g, p)).fold(0.0, f32::max),
        }
    }
    fn key(&self, k: KeyCode) -> f32 {
        self.button(Button::Key(k))
    }
    pub fn axis(&self, a: GamepadAxis) -> f32 {
        self.pads.iter().map(|(_, g)| g.get(a).unwrap_or(0.0)).fold(0.0, |m: f32, v| if v.abs() > m.abs() { v } else { m })
    }
    pub fn stick(&self, s: Stick) -> Vec2 {
        self.pads
            .iter()
            .map(|(_, g)| if s == Stick::Left { g.left_stick() } else { g.right_stick() })
            .fold(Vec2::ZERO, |m, v| if v.length_squared() > m.length_squared() { v } else { m })
    }
    pub fn read(&self, input: Input) -> Vec2 {
        match input {
            Input::Button(b) => Vec2::new(self.button(b), 0.0),
            Input::PadAxis(a) => Vec2::new(self.axis(a), 0.0),
            Input::Stick(s) => self.stick(s),
            Input::MouseMotion => self.motion,
            Input::MouseWheel => self.wheel,
            Input::Keys4 { up, down, left, right } => {
                Vec2::new(self.key(right) - self.key(left), self.key(up) - self.key(down)).clamp_length_max(1.0)
            }
            Input::KeyAxis { neg, pos } => Vec2::new(self.key(pos) - self.key(neg), 0.0),
            Input::DPad => {
                let b = |p| self.button(Button::Pad(p));
                Vec2::new(b(GamepadButton::DPadRight) - b(GamepadButton::DPadLeft), b(GamepadButton::DPadUp) - b(GamepadButton::DPadDown))
                    .clamp_length_max(1.0)
            }
        }
    }
}

fn pad_button(g: &Gamepad, p: GamepadButton) -> f32 {
    // Analog value when the pad reports one (triggers), at least 1 while digitally pressed.
    let digital = g.pressed(p) as u8 as f32;
    g.get(p).map_or(digital, |v| v.max(digital))
}

impl ActionState {
    fn rebuild(&mut self, map: &ActionMap, contexts: &InputContexts) {
        // New entries start "live" so a key held at startup isn't treated as a context switch.
        self.data.resize(map.len(), ActionData { live: true, last_press: f32::NEG_INFINITY, ..default() });
        self.names = map.by_name.clone();
        let l = &mut self.layout;
        l.by_context = vec![Vec::new(); contexts.list.len()];
        l.bindings.clear();
        l.chords.clear();
        l.required.clear();
        // Chorded bindings shadow plain bindings on the same input.
        let mut chorded: Vec<(Vec<Source>, usize)> = Vec::new();
        for a in map.iter() {
            for b in a.def.bindings.iter().filter(|b| !b.chord.is_empty()) {
                let mut s = Vec::new();
                b.sources(&mut s);
                l.chords.push(b.chord.clone());
                chorded.push((s, l.chords.len() - 1));
            }
        }
        for (i, a) in map.iter().enumerate() {
            if let Some(ci) = contexts.index(a.def.context) {
                l.by_context[ci].push(i);
            }
            l.required.push(a.def.requires.and_then(|r| map.by_name.get(r).copied()));
            let layouts = a
                .def
                .bindings
                .iter()
                .map(|b: &Binding| {
                    let mut sources = Vec::new();
                    b.sources(&mut sources);
                    let shadows = if b.chord.is_empty() {
                        chorded.iter().filter(|(s, _)| s.iter().any(|x| sources.contains(x))).map(|(_, k)| *k).collect()
                    } else {
                        Vec::new()
                    };
                    BindingLayout { sources, shadows }
                })
                .collect();
            l.bindings.push(layouts);
        }
        l.generation = contexts.generation;
    }

    /// Evaluate every action for one frame. `dt` = real seconds since the last frame.
    pub fn evaluate(&mut self, map: &ActionMap, contexts: &InputContexts, dev: &Devices, dt: f32, map_changed: bool) {
        if map_changed || self.layout.generation != contexts.generation || self.data.len() != map.len() {
            self.rebuild(map, contexts);
        }
        self.time += dt;
        let now = self.time;
        self.consumed.clear();
        let mut blocked = false;
        for (ci, ctx) in contexts.list.iter().enumerate() {
            let live = ctx.active && !blocked;
            self.pending.clear();
            let n = self.layout.by_context.get(ci).map_or(0, Vec::len);
            for k in 0..n {
                let ai = self.layout.by_context[ci][k];
                self.eval_action(map, ai, live, dev, dt, now);
            }
            self.consumed.extend_from_slice(&self.pending);
            if ctx.active && ctx.exclusive {
                blocked = true;
            }
        }
        // Chorded actions, then edges.
        for i in 0..self.data.len() {
            if let Some(r) = self.layout.required[i]
                && !self.data[r].active
            {
                self.data[i].active = false;
                self.data[i].value = Vec2::ZERO;
            }
        }
        for d in &mut self.data {
            let was = d.active_secs > 0.0;
            d.just_pressed = d.active && !was;
            d.just_released = !d.active && was;
            d.active_secs = if d.active { d.active_secs + dt.max(1e-6) } else { 0.0 };
        }
        // Last device: any key/button press, mouse motion or a deflected stick.
        if dev.keys.is_some_and(|k| k.get_just_pressed().next().is_some()) || dev.mouse.is_some_and(|m| m.get_just_pressed().next().is_some()) || dev.motion.length_squared() > 4.0 {
            self.last_device = Device::KeyboardMouse;
        }
        for (e, g) in dev.pads.iter() {
            if g.get_just_pressed().next().is_some() || g.left_stick().length() > 0.4 || g.right_stick().length() > 0.4 {
                self.last_device = Device::Gamepad;
                self.last_gamepad = Some(e);
            }
        }
    }

    fn eval_action(&mut self, map: &ActionMap, ai: usize, live: bool, dev: &Devices, dt: f32, now: f32) {
        let a = &map.actions[ai];
        let two_d = a.def.kind == ActionKind::Axis2d;
        let mut best = Vec2::ZERO;
        let mut best_mag = 0.0;
        let mut winner = None;
        let mut device = self.data[ai].device;
        // Inactive contexts are read too (cheap), only to know whether a button was already
        // held when its context comes on.
        {
            for (bi, b) in a.def.bindings.iter().enumerate() {
                let bl = &self.layout.bindings[ai][bi];
                if live && bl.sources.iter().any(|s| self.consumed.contains(s)) {
                    continue;
                }
                if !b.chord.iter().all(|c| dev.held(*c)) {
                    continue;
                }
                if bl.shadows.iter().any(|&k| self.layout.chords[k].iter().all(|c| dev.held(*c))) {
                    continue;
                }
                let v = apply_modifiers(dev.read(b.input), &b.modifiers, dt, two_d);
                let m = v.length();
                if m > best_mag {
                    best = v;
                    best_mag = m;
                    winner = Some(bi);
                    device = b.device();
                }
            }
            best = apply_modifiers(best, &a.def.modifiers, dt, two_d);
            if a.def.kind != ActionKind::Button {
                best *= a.sensitivity;
            }
            if a.def.kind == ActionKind::Axis1d {
                best.y = 0.0;
            }
        }
        let trigger = a.trigger();
        let d = &mut self.data[ai];
        let input_on = best.length() >= a.def.actuation;
        if !live {
            d.offline_held = input_on;
            best = Vec2::ZERO;
            winner = None;
        } else {
            d.device = device;
        }
        let mut raw = live && input_on;
        if live && !d.live && raw && d.offline_held && a.def.kind == ActionKind::Button {
            // Context just came on with the button already held (Esc that opened the menu):
            // wait for a release so it doesn't fire again here. Axes resume at once (hold W
            // while getting into a vehicle and it drives).
            d.wait_release = true;
        }
        if d.wait_release {
            if raw {
                raw = false;
            } else {
                d.wait_release = false;
            }
        }
        if !live {
            d.toggled = false;
        }
        d.live = live;
        let prev = d.raw;
        d.raw = raw;
        let pressed = raw && !prev;
        let released = !raw && prev;
        if raw {
            d.hold += dt;
        } else if prev {
            d.last_hold = d.hold;
            d.hold = 0.0;
        }
        let active = match trigger {
            Trigger::Down => raw,
            Trigger::Pressed => pressed,
            Trigger::Released => released,
            Trigger::Hold { secs } => raw && d.hold >= secs,
            Trigger::Tap { max_secs } => released && d.last_hold <= max_secs,
            Trigger::DoubleTap { window } => {
                let hit = pressed && now - d.last_press <= window;
                if hit {
                    d.last_press = f32::NEG_INFINITY;
                } else if pressed {
                    d.last_press = now;
                }
                hit
            }
            Trigger::Toggle => {
                if pressed {
                    d.toggled = !d.toggled;
                }
                d.toggled
            }
        };
        d.active = active;
        d.value = if !active {
            Vec2::ZERO
        } else if matches!(trigger, Trigger::Down | Trigger::Hold { .. }) {
            best
        } else {
            Vec2::X
        };
        if raw
            && a.def.consume
            && let Some(bi) = winner
        {
            self.pending.extend_from_slice(&self.layout.bindings[ai][bi].sources);
        }
    }
}

/// PreUpdate: devices → [`ActionState`].
pub(crate) fn update_actions(
    keys: Option<Res<ButtonInput<KeyCode>>>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
    motion: Option<Res<AccumulatedMouseMotion>>,
    wheel: Option<Res<AccumulatedMouseScroll>>,
    pads: Query<(Entity, &'static Gamepad)>,
    time: Res<Time<Real>>,
    map: Res<ActionMap>,
    contexts: Res<InputContexts>,
    mut state: ResMut<ActionState>,
) {
    let wheel = wheel.map_or(Vec2::ZERO, |w| match w.unit {
        MouseScrollUnit::Line => w.delta,
        MouseScrollUnit::Pixel => w.delta / 16.0,
    });
    let dev = Devices { keys: keys.as_deref(), mouse: mouse.as_deref(), motion: motion.map_or(Vec2::ZERO, |m| m.delta), wheel, pads: Pads::Query(&pads) };
    let changed = map.is_changed();
    state.evaluate(&map, &contexts, &dev, time.delta_secs(), changed);
}
