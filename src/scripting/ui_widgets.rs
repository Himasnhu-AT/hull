//! Widget pack for script UI (Godot `CheckBox`, `HSlider`, `LineEdit`, `OptionButton`,
//! `TextureRect`, `GridContainer`, `ScrollContainer`, `MarginContainer`, `TabContainer`), plus
//! focus / keyboard navigation and tooltips.
//!
//! | Build | Signal | Read / write |
//! |---|---|---|
//! | `ui_checkbox(parent, text [, checked])` | `toggled(pressed)` | `is_checked([n])`, `set_checked([n,] b)` |
//! | `ui_slider(parent, min, max, value [, step])` | `value_changed(v)` | `get_value([n])`, `set_value([n,] v)` (progress bars too) |
//! | `ui_line_edit(parent [, placeholder])` | `text_changed(text)`, `text_submitted(text)` | `get_text`, `set_text` |
//! | `ui_option_button(parent, items)` | `item_selected(index)` | `get_selected([n])`, `select([n,] i)` |
//! | `ui_tabs(parent, titles)` | `tab_changed(i)` | `get_current_tab([n])`, `set_current_tab([n,] i)` |
//! | `ui_texture_rect(parent, path)`, `ui_grid(parent, columns)`, `ui_scroll(parent)`, `ui_margin(parent, px)` | | |
//! | focus | | `grab_focus([n])`, `release_focus([n])`, `has_focus([n])`, `set_tooltip([n,] text)` |
//!
//! Tabs: the first child of the `ui_tabs` node is the tab bar, every later child is a page
//! (`ui_panel(tabs)` ...); page `i` is shown when tab `i` is selected.
//!
//! Every widget is a normal Bevy UI entity with a reflected state component ([`UiCheckbox`],
//! [`UiSlider`], [`UiLineEdit`], [`UiOption`], [`UiTabs`]) and named children, so it can be saved
//! in a level file; the look is rebuilt from the state component. Colours and fonts come from the
//! UI [`Theme`].
//!
//! Focus: every button and widget is a [`UiFocusable`]. Click focuses; Tab / Shift+Tab / Up / Down
//! (or the gamepad D-pad) move focus in tree order, Left / Right adjust a slider or option,
//! Enter / Space (gamepad South) activate. Arrow and Enter keys only act while something has
//! focus, so a game that uses them for movement is not affected. While a line edit has focus it
//! takes the keyboard ([`UiCapture`]).

use bevy::input::ButtonState;
use bevy::input::gamepad::{Gamepad, GamepadButton};
use bevy::input::keyboard::{Key, KeyboardInput};
use bevy::input::mouse::{MouseScrollUnit, MouseWheel};
use bevy::picking::hover::Hovered;
use bevy::prelude::*;
use bevy::ui::{InteractionDisabled, Pressed, RelativeCursorPosition, RepeatedGridTrack, ScrollPosition, UiTransform, Val2};
use bevy::ui_widgets::Button;
use bevy::window::PrimaryWindow;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{b, f, rent, s, split, world};
use super::ui::{UiButton, UiProgress, set_fill, spawn_node, theme_of};
use crate::ui::theme::{self, GAP_M, GAP_S, GAP_XS, RADIUS, SIZE_BODY, SIZE_SMALL, Theme};

// ---------------------------------------------------------------- components

/// A check box: `checked`; the `Mark` child shows it.
#[derive(Component, Reflect, Clone, Debug, Default, PartialEq)]
#[reflect(Component, Default)]
pub struct UiCheckbox {
    pub checked: bool,
}

/// A slider: `value` in `min..=max`, snapped to `step` when it is above zero.
#[derive(Component, Reflect, Clone, Debug, PartialEq)]
#[reflect(Component, Default)]
pub struct UiSlider {
    pub min: f32,
    pub max: f32,
    pub value: f32,
    pub step: f32,
}

impl Default for UiSlider {
    fn default() -> Self {
        UiSlider { min: 0.0, max: 1.0, value: 0.0, step: 0.0 }
    }
}

impl UiSlider {
    fn snap(&self, v: f32) -> f32 {
        let v = v.clamp(self.min.min(self.max), self.max.max(self.min));
        if self.step > 0.0 { (self.min + ((v - self.min) / self.step).round() * self.step).clamp(self.min, self.max) } else { v }
    }

    fn fraction(&self) -> f32 {
        if self.max > self.min { ((self.value - self.min) / (self.max - self.min)).clamp(0.0, 1.0) } else { 0.0 }
    }

    /// Sets the value; true when it changed.
    fn set(&mut self, v: f32) -> bool {
        let v = self.snap(v);
        let changed = (v - self.value).abs() > f32::EPSILON;
        self.value = v;
        changed
    }
}

#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiCheckMark;

#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiSliderFill;

#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiSliderHandle;

/// Single-line text entry. `text` is the real value; the child `Text` shows it (or the
/// placeholder, or a caret while focused).
#[derive(Component, Reflect, Clone, Debug, Default, PartialEq)]
#[reflect(Component, Default)]
pub struct UiLineEdit {
    pub text: String,
    pub placeholder: String,
}

/// A drop-down: the selected item shows in the button, a click opens the list.
#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component, Default)]
pub struct UiOption {
    pub items: Vec<String>,
    pub selected: usize,
    /// Runtime: the list is open.
    #[reflect(ignore)]
    pub open: bool,
}

#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiOptionItem {
    pub index: usize,
}

#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiDropdown;

/// A tab container: child 0 is the bar, children 1.. are the pages.
#[derive(Component, Reflect, Clone, Debug, Default, PartialEq)]
#[reflect(Component, Default)]
pub struct UiTabs {
    pub selected: usize,
}

#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiTabButton {
    pub index: usize,
}

/// Part of the script focus order.
#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiFocusable;

/// A vertically scrolling container (mouse wheel while hovered).
#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiScroll;

/// Hover tooltip text.
#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiTooltip(pub String);

#[derive(Component)]
struct UiTooltipBubble;

/// The script-focused widget.
#[derive(Resource, Default, Debug)]
pub struct UiFocus(pub Option<Entity>);

/// What the GUI is consuming this frame. Scripts' `_unhandled_*` input is skipped for it.
#[derive(Resource, Default, Debug, Clone, Copy)]
pub struct UiCapture {
    pub keyboard: bool,
    pub pointer: bool,
}

#[derive(Resource, Default)]
struct UiDrag(Option<Entity>);

enum Arg {
    None,
    Bool(bool),
    Float(f32),
    Int(usize),
    Str(String),
}

impl Arg {
    fn rv(self) -> Vec<RV> {
        match self {
            Arg::None => vec![],
            Arg::Bool(x) => vec![RV::Bool(x)],
            Arg::Float(x) => vec![RV::Float(x as f64)],
            Arg::Int(x) => vec![RV::Int(x as i64)],
            Arg::Str(x) => vec![RV::Str(x)],
        }
    }
}

/// Signals queued by the widget systems, emitted by [`emit_pending`] (emitting needs `&mut World`).
#[derive(Resource, Default)]
struct UiPending(Vec<(Entity, &'static str, Arg)>);

#[derive(Resource, Default)]
struct TooltipState {
    target: Option<Entity>,
    bubble: Option<Entity>,
    secs: f32,
}

const TOOLTIP_DELAY: f32 = 0.45;
const HIT_H: f32 = 28.0;

pub(super) fn plugin(app: &mut App) {
    app.register_type::<UiCheckbox>()
        .register_type::<UiSlider>()
        .register_type::<UiCheckMark>()
        .register_type::<UiSliderFill>()
        .register_type::<UiSliderHandle>()
        .register_type::<UiLineEdit>()
        .register_type::<UiOption>()
        .register_type::<UiOptionItem>()
        .register_type::<UiDropdown>()
        .register_type::<UiTabs>()
        .register_type::<UiTabButton>()
        .register_type::<UiFocusable>()
        .register_type::<UiScroll>()
        .register_type::<UiTooltip>()
        .init_resource::<UiFocus>()
        .init_resource::<UiCapture>()
        .init_resource::<UiDrag>()
        .init_resource::<UiPending>()
        .init_resource::<TooltipState>();
    if !app.world().contains_resource::<Messages<KeyboardInput>>() {
        app.add_message::<KeyboardInput>();
    }
    if !app.world().contains_resource::<Messages<MouseWheel>>() {
        app.add_message::<MouseWheel>();
    }
    app.add_systems(
        Update,
        (click_focus, press_widgets, drag_slider, type_text, nav_keys, scroll_wheel, capture_state, emit_pending)
            .chain()
            .before(super::ui_signals)
            .in_set(super::ScriptSet::Events),
    )
    .add_systems(
        Update,
        (checkbox_look, slider_look, line_edit_look, option_look, tabs_look, focus_look, tooltip).in_set(super::ScriptSet::Flush),
    );
}

// ---------------------------------------------------------------- interaction systems

fn mouse_pressed(m: &Option<Res<ButtonInput<MouseButton>>>) -> bool {
    m.as_ref().is_some_and(|m| m.just_pressed(MouseButton::Left))
}

/// Clicking a widget focuses it; clicking elsewhere clears focus.
fn click_focus(
    mut focus: ResMut<UiFocus>,
    pressed: Query<Entity, (With<UiFocusable>, Added<Pressed>, Without<InteractionDisabled>)>,
    focusables: Query<&Hovered, With<UiFocusable>>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
) {
    if let Some(e) = pressed.iter().last() {
        if focus.0 != Some(e) {
            focus.0 = Some(e);
        }
    } else if mouse_pressed(&mouse) && focus.0.is_some() && !focusables.iter().any(|h| h.0) {
        focus.0 = None;
    }
}

#[derive(bevy::ecs::system::SystemParam)]
struct Presses<'w, 's> {
    boxes: Query<'w, 's, (Entity, &'static mut UiCheckbox), (Added<Pressed>, Without<InteractionDisabled>)>,
    sliders: Query<'w, 's, Entity, (With<UiSlider>, Added<Pressed>, Without<InteractionDisabled>)>,
    options: Query<'w, 's, (Entity, &'static mut UiOption, &'static Hovered), Without<InteractionDisabled>>,
    option_pressed: Query<'w, 's, Entity, (With<UiOption>, Added<Pressed>)>,
    items: Query<'w, 's, (&'static UiOptionItem, &'static ChildOf), Added<Pressed>>,
    parents: Query<'w, 's, &'static ChildOf>,
    tab_buttons: Query<'w, 's, (&'static UiTabButton, &'static ChildOf), Added<Pressed>>,
    tabs: Query<'w, 's, &'static mut UiTabs>,
}

fn press_widgets(
    mut p: Presses,
    mut drag: ResMut<UiDrag>,
    mut pending: ResMut<UiPending>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
) {
    for (e, mut c) in &mut p.boxes {
        c.checked = !c.checked;
        pending.0.push((e, "toggled", Arg::Bool(c.checked)));
    }
    if let Some(e) = p.sliders.iter().last() {
        drag.0 = Some(e);
    }
    // Option buttons: a press on the button toggles the list, on an item picks it, anywhere
    // else closes it.
    let opened: Vec<Entity> = p.option_pressed.iter().collect();
    let mut picks: Vec<(Entity, usize)> = vec![];
    for (item, parent) in &p.items {
        // item -> dropdown -> option
        if let Ok(opt) = p.parents.get(parent.parent()) {
            picks.push((opt.parent(), item.index));
        }
    }
    let click = mouse_pressed(&mouse);
    for (e, mut o, hovered) in &mut p.options {
        if let Some((_, i)) = picks.iter().find(|(t, _)| *t == e) {
            if *i < o.items.len() && o.selected != *i {
                o.selected = *i;
                pending.0.push((e, "item_selected", Arg::Int(*i)));
            }
            o.open = false;
        } else if opened.contains(&e) {
            o.open = !o.open;
        } else if o.open && click && !hovered.0 {
            o.open = false;
        }
    }
    for (tb, parent) in &p.tab_buttons {
        // button -> bar -> tabs
        let Ok(bar) = p.parents.get(parent.parent()) else { continue };
        if let Ok(mut t) = p.tabs.get_mut(bar.parent())
            && t.selected != tb.index
        {
            t.selected = tb.index;
            pending.0.push((bar.parent(), "tab_changed", Arg::Int(tb.index)));
        }
    }
}

fn drag_slider(
    mut drag: ResMut<UiDrag>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
    mut sliders: Query<(&mut UiSlider, &RelativeCursorPosition)>,
    mut pending: ResMut<UiPending>,
) {
    let Some(e) = drag.0 else { return };
    if !mouse.is_some_and(|m| m.pressed(MouseButton::Left)) {
        drag.0 = None;
        return;
    }
    let Ok((mut s, pos)) = sliders.get_mut(e) else {
        drag.0 = None;
        return;
    };
    let Some(n) = pos.normalized else { return };
    // `normalized` is centred on the node: -0.5..0.5.
    let v = s.min + (s.max - s.min) * (n.x + 0.5).clamp(0.0, 1.0);
    if s.set(v) {
        pending.0.push((e, "value_changed", Arg::Float(s.value)));
    }
}

fn type_text(
    mut keys: MessageReader<KeyboardInput>,
    mut focus: ResMut<UiFocus>,
    mut edits: Query<&mut UiLineEdit>,
    mut pending: ResMut<UiPending>,
) {
    let Some(e) = focus.0 else {
        keys.clear();
        return;
    };
    let Ok(mut edit) = edits.get_mut(e) else {
        keys.clear();
        return;
    };
    for k in keys.read() {
        if k.state != ButtonState::Pressed {
            continue;
        }
        match &k.logical_key {
            Key::Backspace => {
                if edit.text.pop().is_some() {
                    pending.0.push((e, "text_changed", Arg::Str(edit.text.clone())));
                }
            }
            Key::Enter => pending.0.push((e, "text_submitted", Arg::Str(edit.text.clone()))),
            Key::Escape => focus.0 = None,
            Key::Space => {
                edit.text.push(' ');
                pending.0.push((e, "text_changed", Arg::Str(edit.text.clone())));
            }
            Key::Character(c) => {
                let before = edit.text.len();
                edit.text.extend(c.chars().filter(|ch| !ch.is_control()));
                if edit.text.len() != before {
                    pending.0.push((e, "text_changed", Arg::Str(edit.text.clone())));
                }
            }
            _ => {}
        }
    }
}

/// Is `e` and every ancestor displayed?
fn shown(e: Entity, nodes: &Query<&Node>, parents: &Query<&ChildOf>) -> bool {
    let mut cur = Some(e);
    while let Some(c) = cur {
        if nodes.get(c).is_ok_and(|n| n.display == Display::None) {
            return false;
        }
        cur = parents.get(c).ok().map(|p| p.parent());
    }
    true
}

enum Nav {
    Next,
    Prev,
    Left,
    Right,
    Accept,
    Close,
}

#[derive(bevy::ecs::system::SystemParam)]
struct NavParams<'w, 's> {
    keys: Option<Res<'w, ButtonInput<KeyCode>>>,
    pads: Query<'w, 's, &'static Gamepad>,
    focusables: Query<'w, 's, Entity, (With<UiFocusable>, Without<InteractionDisabled>)>,
    kids: Query<'w, 's, &'static Children>,
    nodes: Query<'w, 's, &'static Node>,
    parents: Query<'w, 's, &'static ChildOf>,
    boxes: Query<'w, 's, &'static mut UiCheckbox>,
    sliders: Query<'w, 's, &'static mut UiSlider>,
    options: Query<'w, 's, &'static mut UiOption>,
    edits: Query<'w, 's, (), With<UiLineEdit>>,
    buttons: Query<'w, 's, (), With<Button>>,
}

fn nav_keys(mut p: NavParams, mut focus: ResMut<UiFocus>, mut pending: ResMut<UiPending>) {
    let mut moves: Vec<Nav> = vec![];
    if let Some(k) = &p.keys {
        let shift = k.pressed(KeyCode::ShiftLeft) || k.pressed(KeyCode::ShiftRight);
        if k.just_pressed(KeyCode::Tab) {
            moves.push(if shift { Nav::Prev } else { Nav::Next });
        }
        if k.just_pressed(KeyCode::ArrowDown) {
            moves.push(Nav::Next);
        }
        if k.just_pressed(KeyCode::ArrowUp) {
            moves.push(Nav::Prev);
        }
        if k.just_pressed(KeyCode::ArrowLeft) {
            moves.push(Nav::Left);
        }
        if k.just_pressed(KeyCode::ArrowRight) {
            moves.push(Nav::Right);
        }
        if k.just_pressed(KeyCode::Enter) || k.just_pressed(KeyCode::NumpadEnter) || k.just_pressed(KeyCode::Space) {
            moves.push(Nav::Accept);
        }
        if k.just_pressed(KeyCode::Escape) {
            moves.push(Nav::Close);
        }
    }
    for g in &p.pads {
        if g.just_pressed(GamepadButton::DPadDown) {
            moves.push(Nav::Next);
        }
        if g.just_pressed(GamepadButton::DPadUp) {
            moves.push(Nav::Prev);
        }
        if g.just_pressed(GamepadButton::DPadLeft) {
            moves.push(Nav::Left);
        }
        if g.just_pressed(GamepadButton::DPadRight) {
            moves.push(Nav::Right);
        }
        if g.just_pressed(GamepadButton::South) {
            moves.push(Nav::Accept);
        }
        if g.just_pressed(GamepadButton::East) {
            moves.push(Nav::Close);
        }
    }
    if moves.is_empty() {
        return;
    }
    // Tree order (like Godot's Tab order): the path of child indices from the root.
    let order = |p: &NavParams| -> Vec<Entity> {
        let mut v: Vec<(Vec<usize>, Entity)> = p
            .focusables
            .iter()
            .filter(|e| shown(*e, &p.nodes, &p.parents))
            .map(|e| {
                let mut path = vec![];
                let mut cur = e;
                while let Ok(par) = p.parents.get(cur) {
                    path.push(p.kids.get(par.parent()).ok().and_then(|k| k.iter().position(|c| c == cur)).unwrap_or(0));
                    cur = par.parent();
                }
                path.push(cur.to_bits() as usize);
                path.reverse();
                (path, e)
            })
            .collect();
        v.sort();
        v.into_iter().map(|(_, e)| e).collect()
    };
    for m in moves {
        let cur = focus.0;
        let in_edit = cur.is_some_and(|c| p.edits.contains(c));
        let open_option = cur.is_some_and(|c| p.options.get(c).is_ok_and(|o| o.open));
        match m {
            Nav::Next | Nav::Prev => {
                let next = matches!(m, Nav::Next);
                if open_option && let Some(c) = cur {
                    if let Ok(mut o) = p.options.get_mut(c)
                        && !o.items.is_empty()
                    {
                        let n = o.items.len();
                        o.selected = if next { (o.selected + 1) % n } else { (o.selected + n - 1) % n };
                        pending.0.push((c, "item_selected", Arg::Int(o.selected)));
                    }
                    continue;
                }
                // Up / Down without focus belong to the game.
                let tab = matches!((&p.keys, in_edit), (Some(k), _) if k.just_pressed(KeyCode::Tab));
                if cur.is_none() && !tab {
                    continue;
                }
                let list = order(&p);
                if list.is_empty() {
                    continue;
                }
                let at = cur.and_then(|c| list.iter().position(|x| *x == c));
                let n = list.len();
                let i = match (at, next) {
                    (Some(i), true) => (i + 1) % n,
                    (Some(i), false) => (i + n - 1) % n,
                    (None, true) => 0,
                    (None, false) => n - 1,
                };
                focus.0 = Some(list[i]);
            }
            Nav::Left | Nav::Right => {
                let Some(c) = cur else { continue };
                let dir = if matches!(m, Nav::Right) { 1.0 } else { -1.0 };
                if let Ok(mut s) = p.sliders.get_mut(c) {
                    let step = if s.step > 0.0 { s.step } else { (s.max - s.min) / 20.0 };
                    let v = s.value + dir * step;
                    if s.set(v) {
                        pending.0.push((c, "value_changed", Arg::Float(s.value)));
                    }
                } else if let Ok(mut o) = p.options.get_mut(c)
                    && !o.items.is_empty()
                {
                    let n = o.items.len() as i32;
                    o.selected = (o.selected as i32 + dir as i32).rem_euclid(n) as usize;
                    pending.0.push((c, "item_selected", Arg::Int(o.selected)));
                }
            }
            Nav::Accept => {
                let Some(c) = cur else { continue };
                if in_edit {
                    continue; // typing handles Enter, Space is a character
                }
                if let Ok(mut bx) = p.boxes.get_mut(c) {
                    bx.checked = !bx.checked;
                    pending.0.push((c, "toggled", Arg::Bool(bx.checked)));
                } else if let Ok(mut o) = p.options.get_mut(c) {
                    o.open = !o.open;
                } else if p.buttons.contains(c) {
                    pending.0.push((c, "pressed", Arg::None));
                }
            }
            Nav::Close => {
                let Some(c) = cur else { continue };
                if let Ok(mut o) = p.options.get_mut(c)
                    && o.open
                {
                    o.open = false;
                }
            }
        }
    }
}

/// Mouse wheel scrolls the hovered [`UiScroll`].
fn scroll_wheel(mut wheel: MessageReader<MouseWheel>, mut lists: Query<(&mut ScrollPosition, &RelativeCursorPosition), With<UiScroll>>) {
    let mut dy = 0.0;
    for w in wheel.read() {
        dy += match w.unit {
            MouseScrollUnit::Line => w.y * 48.0,
            MouseScrollUnit::Pixel => w.y,
        };
    }
    if dy == 0.0 {
        return;
    }
    for (mut pos, cursor) in &mut lists {
        if cursor.cursor_over {
            pos.y = (pos.y - dy).max(0.0);
        }
    }
}

fn capture_state(
    mut cap: ResMut<UiCapture>,
    focus: Res<UiFocus>,
    edits: Query<(), With<UiLineEdit>>,
    hovered: Query<&Hovered, Or<(With<Button>, With<UiFocusable>)>>,
    scrolls: Query<&RelativeCursorPosition, With<UiScroll>>,
    mouse: Option<Res<super::input_events::ScriptMouse>>,
) {
    let keyboard = focus.0.is_some_and(|e| edits.contains(e));
    let free_look = mouse.is_some_and(|m| m.mode == super::input_events::MouseMode::Captured);
    let pointer = !free_look && (hovered.iter().any(|h| h.0) || scrolls.iter().any(|r| r.cursor_over));
    if cap.keyboard != keyboard || cap.pointer != pointer {
        *cap = UiCapture { keyboard, pointer };
    }
}

fn emit_pending(world: &mut World) {
    let list = std::mem::take(&mut world.resource_mut::<UiPending>().0);
    if list.is_empty() {
        return;
    }
    let paused = super::tree_paused(world);
    for (e, sig, arg) in list {
        if world.get_entity(e).is_ok() && super::runs_now(world, e, paused) {
            super::emit_signal_rv(world, e, sig, arg.rv());
        }
    }
}

// ---------------------------------------------------------------- visual sync

fn checkbox_look(boxes: Query<(&UiCheckbox, &Children), Changed<UiCheckbox>>, boxes_inner: Query<&Children>, mut marks: Query<&mut Node, With<UiCheckMark>>) {
    for (c, kids) in &boxes {
        for k in kids {
            let inner = boxes_inner.get(*k).ok();
            for m in std::iter::once(k).chain(inner.into_iter().flatten()) {
                if let Ok(mut n) = marks.get_mut(*m) {
                    let want = if c.checked { Display::Flex } else { Display::None };
                    if n.display != want {
                        n.display = want;
                    }
                }
            }
        }
    }
}

fn slider_look(
    sliders: Query<(&UiSlider, &Children), Changed<UiSlider>>,
    mut fills: Query<&mut Node, (With<UiSliderFill>, Without<UiSliderHandle>)>,
    mut handles: Query<&mut Node, With<UiSliderHandle>>,
) {
    for (s, kids) in &sliders {
        let pct = s.fraction() * 100.0;
        for k in kids {
            if let Ok(mut n) = fills.get_mut(*k) {
                n.width = Val::Percent(pct);
            }
            if let Ok(mut n) = handles.get_mut(*k) {
                n.left = Val::Percent(pct);
            }
        }
    }
}

fn line_edit_look(
    focus: Res<UiFocus>,
    theme: Option<Res<Theme>>,
    mut edits: Query<(Entity, &UiLineEdit, &Children, &mut BorderColor)>,
    mut texts: Query<(&mut Text, &mut TextColor)>,
) {
    let t = theme.map(|t| t.clone()).unwrap_or_default();
    for (e, edit, kids, mut border) in &mut edits {
        let focused = focus.0 == Some(e);
        let (shown, col) = if focused {
            (format!("{}|", edit.text), t.text)
        } else if edit.text.is_empty() {
            (edit.placeholder.clone(), t.text_dim)
        } else {
            (edit.text.clone(), t.text)
        };
        for k in kids {
            if let Ok((mut text, mut tc)) = texts.get_mut(*k) {
                if text.0 != shown {
                    text.0 = shown.clone();
                }
                if tc.0 != col {
                    tc.0 = col;
                }
            }
        }
        let want = BorderColor::all(if focused { t.accent } else { t.line_strong });
        if *border != want {
            *border = want;
        }
    }
}

fn option_look(
    mut commands: Commands,
    theme: Option<Res<Theme>>,
    options: Query<(Entity, Ref<UiOption>, &Children)>,
    mut texts: Query<&mut Text>,
    dropdowns: Query<(), With<UiDropdown>>,
) {
    let t = theme.map(|t| t.clone()).unwrap_or_default();
    for (e, o, kids) in &options {
        if !o.is_changed() {
            continue;
        }
        let shown = o.items.get(o.selected).cloned().unwrap_or_default();
        // The first text child is the selected item (the arrow comes after it).
        let first = kids.iter().find(|k| !dropdowns.contains(*k) && texts.contains(*k));
        if let Some(k) = first
            && let Ok(mut text) = texts.get_mut(k)
            && text.0 != shown
        {
            text.0 = shown;
        }
        for k in kids {
            if dropdowns.contains(*k) {
                commands.entity(*k).despawn();
            }
        }
        if o.open {
            let list = commands
                .spawn((
                    Name::new("Dropdown"),
                    UiDropdown,
                    Node {
                        position_type: PositionType::Absolute,
                        top: Val::Percent(100.0),
                        left: Val::Px(0.0),
                        min_width: Val::Percent(100.0),
                        flex_direction: FlexDirection::Column,
                        padding: UiRect::all(Val::Px(GAP_XS)),
                        border: UiRect::all(Val::Px(1.0)),
                        border_radius: BorderRadius::all(Val::Px(RADIUS)),
                        ..default()
                    },
                    BackgroundColor(t.bg),
                    BorderColor::all(t.line_strong),
                    GlobalZIndex(100),
                    ChildOf(e),
                ))
                .id();
            for (i, item) in o.items.iter().enumerate() {
                let mut look = UiButton::themed(&t);
                if i == o.selected {
                    look.idle = t.accent.with_alpha(0.35);
                } else {
                    look.idle = Color::NONE;
                }
                commands
                    .spawn((
                        Name::new("Item"),
                        UiOptionItem { index: i },
                        Node { padding: UiRect::axes(Val::Px(GAP_S), Val::Px(GAP_XS + 2.0)), border_radius: BorderRadius::all(Val::Px(RADIUS)), ..default() },
                        BackgroundColor(look.idle),
                        Button,
                        Hovered::default(),
                        look,
                        ChildOf(list),
                    ))
                    .with_children(|c| {
                        c.spawn((Name::new("Label"), Text::new(item.clone()), theme::label(SIZE_BODY), TextColor(t.text), Pickable::IGNORE));
                    });
            }
        }
    }
}

fn tabs_look(
    theme: Option<Res<Theme>>,
    tabs: Query<(Ref<UiTabs>, &Children)>,
    changed_children: Query<(), Changed<Children>>,
    kids_of: Query<&Children>,
    mut nodes: Query<&mut Node>,
    mut buttons: Query<(&UiTabButton, &mut UiButton)>,
) {
    let t = theme.map(|t| t.clone()).unwrap_or_default();
    for (tab, kids) in &tabs {
        let Some(&bar) = kids.first() else { continue };
        let dirty = tab.is_changed() || changed_children.contains(bar) || kids.iter().any(|k| changed_children.contains(k));
        if !dirty {
            continue;
        }
        for (i, page) in kids.iter().skip(1).enumerate() {
            if let Ok(mut n) = nodes.get_mut(page) {
                let want = if i == tab.selected { Display::Flex } else { Display::None };
                if n.display != want {
                    n.display = want;
                }
            }
        }
        for btn in kids_of.get(bar).into_iter().flatten() {
            if let Ok((tb, mut look)) = buttons.get_mut(*btn) {
                let (idle, text) = if tb.index == tab.selected { (t.accent, t.on_accent) } else { (t.raised, t.text) };
                if look.idle != idle {
                    look.idle = idle;
                    look.text = text;
                }
            }
        }
    }
}

fn focus_look(mut commands: Commands, focus: Res<UiFocus>, theme: Option<Res<Theme>>, q: Query<(Entity, Has<Outline>), With<UiFocusable>>) {
    let t = theme.map(|t| t.clone()).unwrap_or_default();
    for (e, has) in &q {
        let on = focus.0 == Some(e);
        if on && !has {
            commands.entity(e).insert(Outline { width: Val::Px(2.0), offset: Val::Px(2.0), color: t.accent });
        } else if !on && has {
            commands.entity(e).remove::<Outline>();
        }
    }
}

fn tooltip(
    mut commands: Commands,
    mut st: ResMut<TooltipState>,
    time: Res<Time>,
    theme: Option<Res<Theme>>,
    scale: Option<Res<UiScale>>,
    tips: Query<(Entity, &UiTooltip, &Hovered)>,
    window: Query<&Window, With<PrimaryWindow>>,
    mut bubbles: Query<&mut Node, With<UiTooltipBubble>>,
) {
    let hot = tips.iter().find(|(_, _, h)| h.0).map(|(e, t, _)| (e, t.0.clone()));
    if hot.as_ref().map(|h| h.0) != st.target {
        st.target = hot.as_ref().map(|h| h.0);
        st.secs = 0.0;
        if let Some(b) = st.bubble.take() {
            commands.entity(b).despawn();
        }
    }
    let Some((_, text)) = hot else { return };
    st.secs += time.delta_secs();
    if st.secs < TOOLTIP_DELAY {
        return;
    }
    let cur = window.iter().next().and_then(|w| w.cursor_position()).unwrap_or(Vec2::ZERO);
    let k = scale.map_or(1.0, |s| s.0).max(0.01);
    let (left, top) = (Val::Px(cur.x / k + 14.0), Val::Px(cur.y / k + 20.0));
    if let Some(b) = st.bubble {
        if let Ok(mut n) = bubbles.get_mut(b) {
            n.left = left;
            n.top = top;
        }
        return;
    }
    let t = theme.map(|t| t.clone()).unwrap_or_default();
    let id = commands
        .spawn((
            Name::new("Tooltip"),
            UiTooltipBubble,
            Node {
                position_type: PositionType::Absolute,
                left,
                top,
                padding: UiRect::axes(Val::Px(GAP_S + 2.0), Val::Px(GAP_XS + 2.0)),
                border: UiRect::all(Val::Px(1.0)),
                border_radius: BorderRadius::all(Val::Px(RADIUS)),
                ..default()
            },
            BackgroundColor(t.bg.with_alpha(0.96)),
            BorderColor::all(t.line_strong),
            GlobalZIndex(1000),
            Pickable::IGNORE,
        ))
        .with_children(|c| {
            c.spawn((Text::new(text), theme::body(SIZE_SMALL), TextColor(t.text), Pickable::IGNORE));
        })
        .id();
    st.bubble = Some(id);
}

// ---------------------------------------------------------------- script access

/// The edit's real text (the child `Text` also shows a caret / placeholder).
pub(super) fn line_edit_text(w: &World, e: Entity) -> Option<String> {
    w.get::<UiLineEdit>(e).map(|l| l.text.clone())
}

/// `set_text` on a line edit: true when `e` is one. No signal (like Godot).
pub(super) fn set_line_edit_text(w: &mut World, e: Entity, text: String) -> bool {
    match w.get_mut::<UiLineEdit>(e) {
        Some(mut l) => {
            if l.text != text {
                l.text = text;
            }
            true
        }
        None => false,
    }
}

fn emit(w: &mut World, e: Entity, sig: &'static str, arg: Arg) {
    super::emit_signal_rv(w, e, sig, arg.rv());
}

fn set_slider(w: &mut World, e: Entity, v: f32) -> Result<(), String> {
    if let Some(mut s) = w.get_mut::<UiSlider>(e) {
        if s.set(v) {
            let v = s.value;
            emit(w, e, "value_changed", Arg::Float(v));
        }
        Ok(())
    } else if w.get::<UiProgress>(e).is_some() {
        set_fill(w, e, v)
    } else {
        Err(format!("{e} is not a slider or progress bar"))
    }
}

pub(super) fn set_checked(w: &mut World, e: Entity, on: bool) -> Result<(), String> {
    let mut c = w.get_mut::<UiCheckbox>(e).ok_or_else(|| format!("{e} is not a check box (ui_checkbox)"))?;
    if c.checked != on {
        c.checked = on;
        emit(w, e, "toggled", Arg::Bool(on));
    }
    Ok(())
}

fn strings(v: &RV, what: &str) -> Result<Vec<String>, String> {
    match v {
        RV::Array(a) => Ok(a.borrow().iter().map(|x| x.to_string()).collect()),
        other => Err(format!("{what} must be an array of strings, got {}", other.type_name())),
    }
}

fn ix(v: &RV, what: &str) -> Result<usize, String> {
    let n = f(v, what)?;
    if n < 0.0 { Err(format!("{what} must be >= 0")) } else { Ok(n as usize) }
}

fn hit_node() -> Node {
    Node { align_items: AlignItems::Center, column_gap: Val::Px(GAP_S), min_height: Val::Px(HIT_H), justify_self: JustifySelf::Start, ..default() }
}

fn bordered(t: &Theme) -> (BorderColor, BackgroundColor) {
    (BorderColor::all(t.line_strong), BackgroundColor(t.raised))
}

pub(super) fn register(e: &mut Engine) {
    e.register("ui_checkbox", |c, a| {
        let w = world(c)?;
        if !(2..=3).contains(&a.len()) {
            return Err("usage: ui_checkbox(parent, text [, checked])".into());
        }
        let t = theme_of(w);
        let checked = a.get(2).map(|v| b(v, "checked")).transpose()?.unwrap_or(false);
        let e = spawn_node(w, a.first(), "CheckBox", (hit_node(), Button, Hovered::default(), UiFocusable, UiCheckbox { checked }))?;
        let boxn = Node {
            width: Val::Px(20.0),
            height: Val::Px(20.0),
            border: UiRect::all(Val::Px(1.0)),
            border_radius: BorderRadius::all(Val::Px(RADIUS)),
            align_items: AlignItems::Center,
            justify_content: JustifyContent::Center,
            flex_shrink: 0.0,
            ..default()
        };
        let bx = w.spawn((Name::new("Box"), boxn, bordered(&t), Pickable::IGNORE, ChildOf(e))).id();
        let mark = Node {
            width: Val::Px(12.0),
            height: Val::Px(12.0),
            border_radius: BorderRadius::all(Val::Px(2.0)),
            display: if checked { Display::Flex } else { Display::None },
            ..default()
        };
        w.spawn((Name::new("Mark"), UiCheckMark, mark, BackgroundColor(t.accent), Pickable::IGNORE, ChildOf(bx)));
        w.spawn((Name::new("Label"), Text::new(a[1].to_string()), theme::body(SIZE_BODY), TextColor(t.text), Pickable::IGNORE, ChildOf(e)));
        Ok(rent(e))
    });
    e.register("is_checked", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "is_checked([node])")?;
        Ok(RV::Bool(w.get::<UiCheckbox>(t).ok_or_else(|| format!("{t} is not a check box"))?.checked))
    });
    e.register("set_checked", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_checked([node,] bool)")?;
        set_checked(w, t, b(&r[0], "checked")?)?;
        Ok(RV::Void)
    });

    e.register("ui_slider", |c, a| {
        let w = world(c)?;
        if !(4..=5).contains(&a.len()) {
            return Err("usage: ui_slider(parent, min, max, value [, step])".into());
        }
        let t = theme_of(w);
        let mut s = UiSlider { min: f(&a[1], "min")?, max: f(&a[2], "max")?, value: 0.0, step: a.get(4).map(|v| f(v, "step")).transpose()?.unwrap_or(0.0) };
        if s.max < s.min {
            return Err("ui_slider: max must be >= min".into());
        }
        s.value = s.snap(f(&a[3], "value")?);
        let pct = s.fraction() * 100.0;
        let track = Node {
            width: Val::Px(220.0),
            height: Val::Px(8.0),
            margin: UiRect::axes(Val::Px(8.0), Val::Px(10.0)),
            border_radius: BorderRadius::all(Val::Px(RADIUS)),
            flex_shrink: 0.0,
            ..default()
        };
        let e = spawn_node(
            w,
            a.first(),
            "Slider",
            (track, BackgroundColor(t.raised), Button, Hovered::default(), RelativeCursorPosition::default(), UiFocusable, s),
        )?;
        let fill = Node { height: Val::Percent(100.0), width: Val::Percent(pct), border_radius: BorderRadius::all(Val::Px(RADIUS)), ..default() };
        w.spawn((Name::new("Fill"), UiSliderFill, fill, BackgroundColor(t.accent), Pickable::IGNORE, ChildOf(e)));
        let handle = Node {
            position_type: PositionType::Absolute,
            left: Val::Percent(pct),
            top: Val::Px(-5.0),
            width: Val::Px(18.0),
            height: Val::Px(18.0),
            border: UiRect::all(Val::Px(2.0)),
            border_radius: BorderRadius::all(Val::Px(9.0)),
            ..default()
        };
        w.spawn((
            Name::new("Handle"),
            UiSliderHandle,
            handle,
            BackgroundColor(t.text),
            BorderColor::all(t.accent),
            UiTransform::from_translation(Val2::new(Val::Px(-9.0), Val::Px(0.0))),
            Pickable::IGNORE,
            ChildOf(e),
        ));
        Ok(rent(e))
    });
    e.register("get_value", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_value([node])")?;
        if let Some(s) = w.get::<UiSlider>(t) {
            Ok(RV::Float(s.value as f64))
        } else if let Some(p) = w.get::<UiProgress>(t) {
            Ok(RV::Float(p.value as f64))
        } else {
            Err(format!("{t} is not a slider or progress bar"))
        }
    });
    e.register("set_value", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_value([node,] v)")?;
        set_slider(w, t, f(&r[0], "value")?)?;
        Ok(RV::Void)
    });

    e.register("ui_line_edit", |c, a| {
        let w = world(c)?;
        if !(1..=2).contains(&a.len()) {
            return Err("usage: ui_line_edit(parent [, placeholder])".into());
        }
        let t = theme_of(w);
        let placeholder = a.get(1).map(|v| v.to_string()).unwrap_or_default();
        let node = Node {
            width: Val::Px(240.0),
            min_height: Val::Px(HIT_H + 6.0),
            padding: UiRect::axes(Val::Px(GAP_S + 2.0), Val::Px(GAP_XS)),
            border: UiRect::all(Val::Px(1.0)),
            border_radius: BorderRadius::all(Val::Px(RADIUS)),
            align_items: AlignItems::Center,
            overflow: Overflow::clip(),
            ..default()
        };
        let e = spawn_node(
            w,
            a.first(),
            "LineEdit",
            (node, bordered(&t), Button, Hovered::default(), UiFocusable, UiLineEdit { text: String::new(), placeholder: placeholder.clone() }),
        )?;
        w.spawn((Name::new("Text"), Text::new(placeholder), theme::body(SIZE_BODY), TextColor(t.text_dim), Pickable::IGNORE, ChildOf(e)));
        Ok(rent(e))
    });

    e.register("ui_option_button", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: ui_option_button(parent, items)".into());
        }
        let t = theme_of(w);
        let items = strings(&a[1], "items")?;
        let first = items.first().cloned().unwrap_or_default();
        let look = UiButton::themed(&t);
        let node = Node {
            min_width: Val::Px(180.0),
            min_height: Val::Px(HIT_H + 6.0),
            padding: UiRect::axes(Val::Px(GAP_S + 2.0), Val::Px(GAP_XS)),
            align_items: AlignItems::Center,
            justify_content: JustifyContent::SpaceBetween,
            column_gap: Val::Px(GAP_M),
            border_radius: BorderRadius::all(Val::Px(RADIUS)),
            ..default()
        };
        let e = spawn_node(
            w,
            a.first(),
            "OptionButton",
            (node, BackgroundColor(look.idle), Button, Hovered::default(), UiFocusable, UiOption { items, selected: 0, open: false }, look),
        )?;
        w.spawn((Name::new("Text"), Text::new(first), theme::body(SIZE_BODY), TextColor(t.text), Pickable::IGNORE, ChildOf(e)));
        w.spawn((Name::new("Arrow"), Text::new("v"), theme::label(SIZE_SMALL), TextColor(t.text_muted), Pickable::IGNORE, ChildOf(e)));
        Ok(rent(e))
    });
    e.register("get_selected", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_selected([node])")?;
        Ok(RV::Int(w.get::<UiOption>(t).ok_or_else(|| format!("{t} is not an option button"))?.selected as i64))
    });
    e.register("select", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "select([node,] index)")?;
        let i = ix(&r[0], "index")?;
        let mut o = w.get_mut::<UiOption>(t).ok_or_else(|| format!("{t} is not an option button"))?;
        if i >= o.items.len() {
            return Err(format!("select: index {i} out of range ({} items)", o.items.len()));
        }
        o.selected = i;
        Ok(RV::Void)
    });

    e.register("ui_tabs", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: ui_tabs(parent, titles)".into());
        }
        let t = theme_of(w);
        let titles = strings(&a[1], "titles")?;
        let col = Node { flex_direction: FlexDirection::Column, row_gap: Val::Px(GAP_S), ..default() };
        let e = spawn_node(w, a.first(), "Tabs", (col, UiTabs::default(), Pickable::IGNORE))?;
        let bar = w.spawn((Name::new("TabBar"), Node { column_gap: Val::Px(GAP_XS), ..default() }, Pickable::IGNORE, ChildOf(e))).id();
        for (i, title) in titles.iter().enumerate() {
            let mut look = UiButton::themed(&t);
            if i == 0 {
                look.idle = t.accent;
                look.text = t.on_accent;
            }
            let node = Node {
                padding: UiRect::axes(Val::Px(GAP_M), Val::Px(GAP_S)),
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                border_radius: BorderRadius::all(Val::Px(RADIUS)),
                ..default()
            };
            let btn = w
                .spawn((Name::new("Tab"), node, BackgroundColor(look.idle), Button, Hovered::default(), UiFocusable, UiTabButton { index: i }, look, ChildOf(bar)))
                .id();
            let col = if i == 0 { t.on_accent } else { t.text };
            w.spawn((Name::new("Label"), Text::new(title.clone()), theme::label(SIZE_BODY), TextColor(col), Pickable::IGNORE, ChildOf(btn)));
        }
        Ok(rent(e))
    });
    e.register("get_current_tab", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_current_tab([node])")?;
        Ok(RV::Int(w.get::<UiTabs>(t).ok_or_else(|| format!("{t} is not a tab container"))?.selected as i64))
    });
    e.register("set_current_tab", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_current_tab([node,] index)")?;
        let i = ix(&r[0], "index")?;
        let mut tabs = w.get_mut::<UiTabs>(t).ok_or_else(|| format!("{t} is not a tab container"))?;
        if tabs.selected != i {
            tabs.selected = i;
            emit(w, t, "tab_changed", Arg::Int(i));
        }
        Ok(RV::Void)
    });

    e.register("ui_texture_rect", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: ui_texture_rect(parent, image_path)".into());
        }
        let path = s(&a[1], "image_path")?.to_string();
        let image: Handle<Image> = w.get_resource::<AssetServer>().ok_or("ui_texture_rect needs the asset server")?.load(path);
        Ok(rent(spawn_node(w, a.first(), "TextureRect", (Node::default(), ImageNode::new(image), Pickable::IGNORE))?))
    });
    e.register("ui_grid", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: ui_grid(parent, columns)".into());
        }
        let cols = f(&a[1], "columns")?.max(1.0) as u16;
        let node = Node {
            display: Display::Grid,
            grid_template_columns: RepeatedGridTrack::auto(cols),
            row_gap: Val::Px(GAP_S),
            column_gap: Val::Px(GAP_M),
            align_items: AlignItems::Center,
            ..default()
        };
        Ok(rent(spawn_node(w, a.first(), "Grid", (node, Pickable::IGNORE))?))
    });
    e.register("ui_scroll", |c, a| {
        let w = world(c)?;
        if a.len() != 1 {
            return Err("usage: ui_scroll(parent)".into());
        }
        let node = Node {
            flex_direction: FlexDirection::Column,
            row_gap: Val::Px(GAP_S),
            overflow: Overflow::scroll_y(),
            min_height: Val::Px(0.0),
            ..default()
        };
        Ok(rent(spawn_node(w, a.first(), "Scroll", (node, ScrollPosition::default(), RelativeCursorPosition::default(), UiScroll))?))
    });
    e.register("ui_margin", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: ui_margin(parent, px)".into());
        }
        let px = f(&a[1], "px")?;
        let node = Node { padding: UiRect::all(Val::Px(px)), flex_direction: FlexDirection::Column, ..default() };
        Ok(rent(spawn_node(w, a.first(), "Margin", (node, Pickable::IGNORE))?))
    });

    e.register("grab_focus", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "grab_focus([node])")?;
        if w.get::<UiFocusable>(t).is_none() {
            return Err(format!("{t} cannot take focus (buttons and input widgets can)"));
        }
        w.resource_mut::<UiFocus>().0 = Some(t);
        Ok(RV::Void)
    });
    e.register("release_focus", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "release_focus([node])")?;
        let mut f = w.resource_mut::<UiFocus>();
        if f.0 == Some(t) {
            f.0 = None;
        }
        Ok(RV::Void)
    });
    e.register("has_focus", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "has_focus([node])")?;
        Ok(RV::Bool(w.resource::<UiFocus>().0 == Some(t)))
    });
    e.register("set_tooltip", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_tooltip([node,] text)")?;
        let text = r[0].to_string();
        let mut em = w.entity_mut(t);
        if text.is_empty() {
            em.remove::<UiTooltip>();
        } else {
            // Hover needs a pickable node; containers built by `ui_vbox` etc. ignore the pointer.
            em.insert((UiTooltip(text), Hovered::default(), Pickable { should_block_lower: false, is_hoverable: true }));
        }
        Ok(RV::Void)
    });
}
