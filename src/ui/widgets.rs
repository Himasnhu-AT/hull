//! Widgets + focus/navigation. Owner: ui stream.
//! Keyboard: arrows/WASD move focus, Enter/Space activate, A/D or ←/→ adjust, Q/E/Tab switch
//! tabs, Esc/Backspace back. Mouse: hover focuses, click activates, drag sliders, wheel scrolls.
//!
//! - [`Focusable`] entities form one vertical list (by `order`); Up/Down moves focus, the mouse
//!   focuses whatever it hovers.
//! - Buttons carry a [`UiAction`]; activating one writes a [`UiActivated`] message that
//!   `ui::screens` handles. Esc/Backspace writes [`NavBack`].
//! - Field rows edit a [`FieldDef`] from the [`SettingsRegistry`]. Values are read with the
//!   def's `get` into [`FieldValues`] once a frame (exclusive system) and written back with its
//!   `set` after input (also exclusive), followed by a [`SaveSettings`] message.
//! - Colours come from [`Look`]: idle / hot (hovered or focused) / on (selected).

use std::collections::HashMap;

use bevy::input::mouse::{AccumulatedMouseMotion, AccumulatedMouseScroll, MouseScrollUnit};
use bevy::prelude::*;
use bevy::ui::{ComputedNode, RelativeCursorPosition, ScrollPosition, UiGlobalTransform};

use super::menus::MenuAction;
use super::theme::*;
use crate::settings::{FieldDef, FieldKind, SaveSettings, SettingsRegistry};

// ---- input ----

/// Navigation input (also injectable by the control port: `ui.nav {input}`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavInput {
    Up,
    Down,
    Left,
    Right,
    Accept,
    Back,
    NextTab,
    PrevTab,
}

impl NavInput {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "up" => Self::Up,
            "down" => Self::Down,
            "left" => Self::Left,
            "right" => Self::Right,
            "accept" | "enter" => Self::Accept,
            "back" | "esc" => Self::Back,
            "next_tab" => Self::NextTab,
            "prev_tab" => Self::PrevTab,
            _ => return None,
        })
    }
}

/// Queue of nav inputs processed this frame (keyboard + injected).
#[derive(Resource, Clone, Debug, Default)]
pub struct NavQueue(pub Vec<NavInput>);

/// What a button does. Handled in `ui::screens`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiAction {
    Menu(MenuAction),
    /// Same as Esc on the current screen.
    Back,
    /// Settings tab by index.
    Tab(usize),
    NextTab,
    PrevTab,
    /// Reset the open settings tab to defaults.
    ResetTab,
}

impl From<MenuAction> for UiAction {
    fn from(a: MenuAction) -> Self {
        UiAction::Menu(a)
    }
}

#[derive(Message, Clone, Copy, Debug, PartialEq, Eq)]
pub struct UiActivated(pub UiAction);

/// Esc / Backspace (or `ui.nav back`). `ui::screens` decides what it means; games may also
/// read it (e.g. on a sticky screen).
#[derive(Message, Clone, Copy, Debug, Default)]
pub struct NavBack;

/// Part of the focus list. Lower `order` is higher on screen.
#[derive(Component, Clone, Copy, Debug)]
pub struct Focusable {
    pub order: u32,
}

/// The focused entity (one of the [`Focusable`]s).
#[derive(Resource, Default, Debug)]
pub struct Focus(pub Option<Entity>);

#[derive(Component, Clone, Copy, Debug)]
pub struct ActionButton(pub UiAction);

/// Colours for idle / hot (hovered or focused) / on (selected) states.
/// `bg`/`border` apply to the entity itself; `text` to text in its subtree (not crossing
/// another `Look`).
#[derive(Component, Clone, Copy, Debug)]
pub struct Look {
    pub bg: [Color; 3],
    pub border: [Color; 3],
    pub text: [Color; 3],
}

impl Look {
    pub const fn new(bg: [Color; 3], border: [Color; 3], text: [Color; 3]) -> Self {
        Self { bg, border, text }
    }
}

/// A child whose background follows the nearest `Look` owner's state (e.g. a focus bar).
#[derive(Component, Clone, Copy, Debug)]
pub struct LookBg(pub [Color; 3]);

/// Text inside a `Look` subtree that keeps its own colour.
#[derive(Component, Clone, Copy, Debug)]
pub struct KeepColor;

/// Tab strip button (painted "on" when active).
#[derive(Component, Clone, Copy, Debug)]
pub struct TabButton {
    pub active: bool,
}

// ---- field values ----

/// Number of options of a choice-like kind (choice, cards, swatches).
pub fn option_count(kind: &FieldKind) -> Option<usize> {
    match kind {
        FieldKind::Choice { options } => Some(options.len()),
        FieldKind::Cards { options } => Some(options.len()),
        FieldKind::Swatches { colors } => Some(colors.len()),
        FieldKind::Toggle | FieldKind::Slider { .. } => None,
    }
}

/// Snap/clamp a value to what the kind allows: sliders to `min + k·step` within range,
/// toggles to 0/1, choices to a valid index.
pub fn normalize(kind: &FieldKind, v: f32) -> f32 {
    match kind {
        FieldKind::Toggle => {
            if v > 0.5 {
                1.0
            } else {
                0.0
            }
        }
        FieldKind::Slider { min, max, step, .. } => {
            if !v.is_finite() {
                return *min;
            }
            let s = if *step > 0.0 { ((v - min) / step).round() * step + min } else { v };
            // Trim float noise from the multiply (0.1 * 3 → 0.30000001).
            let s = (s * 1e5).round() / 1e5;
            s.clamp(*min, *max)
        }
        _ => {
            let n = option_count(kind).unwrap_or(1).max(1);
            if !v.is_finite() {
                return 0.0;
            }
            v.round().clamp(0.0, (n - 1) as f32)
        }
    }
}

/// Left/Right adjustment (`dir` = -1 or +1). Sliders move one step, toggles go off/on,
/// choices move one option without wrapping.
pub fn step_value(kind: &FieldKind, v: f32, dir: f32) -> f32 {
    match kind {
        FieldKind::Slider { step, .. } => normalize(kind, v + step * dir),
        FieldKind::Toggle => normalize(kind, if dir > 0.0 { 1.0 } else { 0.0 }),
        _ => normalize(kind, v + dir),
    }
}

/// Enter on a row: toggles flip, choices advance and wrap, sliders stay.
pub fn cycle_value(kind: &FieldKind, v: f32) -> f32 {
    match kind {
        FieldKind::Toggle => normalize(kind, 1.0 - v),
        FieldKind::Slider { .. } => v,
        _ => {
            let n = option_count(kind).unwrap_or(1).max(1);
            ((normalize(kind, v) as usize + 1) % n) as f32
        }
    }
}

/// Display text for a value ("ON", "80°", "High").
pub fn format_value(kind: &FieldKind, v: f32) -> String {
    let i = normalize(kind, v) as usize;
    match kind {
        FieldKind::Toggle => if v > 0.5 { "ON" } else { "OFF" }.to_string(),
        FieldKind::Slider { format, .. } => format(v),
        FieldKind::Choice { options } => options.get(i).map_or_else(String::new, |s| s.to_string()),
        FieldKind::Cards { options } => options.get(i).map_or_else(String::new, |s| s.0.to_string()),
        FieldKind::Swatches { .. } => format!("#{}", i + 1),
    }
}

/// Where a value sits on a slider, 0..1 (0 for other kinds).
pub fn slider_fraction(kind: &FieldKind, v: f32) -> f32 {
    match kind {
        FieldKind::Slider { min, max, .. } if max > min => ((v - min) / (max - min)).clamp(0.0, 1.0),
        _ => 0.0,
    }
}

/// Latest value of every field with a live widget (refreshed from `FieldDef::get` each frame).
#[derive(Resource, Default, Debug, Clone)]
pub struct FieldValues(pub HashMap<&'static str, f32>);

impl FieldValues {
    pub fn get(&self, key: &str) -> f32 {
        self.0.get(key).copied().unwrap_or(0.0)
    }
}

/// Edits made by widgets this frame, applied with `FieldDef::set` by an exclusive system.
#[derive(Resource, Default, Debug, Clone)]
pub struct FieldEdits(pub Vec<(&'static str, f32)>);

fn edit(values: &mut FieldValues, edits: &mut FieldEdits, def: &FieldDef, v: f32) {
    let v = normalize(&def.kind, v);
    if values.0.get(def.key) != Some(&v) {
        values.0.insert(def.key, v);
        edits.0.push((def.key, v));
    }
}

/// Current value of a registered field (`None` if unknown).
pub fn get_field(world: &World, key: &str) -> Option<f32> {
    let get = world.get_resource::<SettingsRegistry>()?.field(key)?.get;
    Some(get(world))
}

/// Set a registered field from code or the control port: snaps/clamps like the widgets do,
/// applies it, and asks for a save. Returns the value actually set.
pub fn set_field(world: &mut World, key: &str, v: f32) -> Result<f32, String> {
    let def = world
        .get_resource::<SettingsRegistry>()
        .and_then(|r| r.field(key).cloned())
        .ok_or_else(|| format!("unknown setting '{key}'"))?;
    let v = normalize(&def.kind, v);
    (def.set)(world, v);
    if let Some(mut vals) = world.get_resource_mut::<FieldValues>() {
        vals.0.insert(def.key, v);
    }
    world.write_message(SaveSettings);
    Ok(v)
}

// ---- field widgets ----

/// A row that edits the field with this key (focusable).
#[derive(Component, Clone, Copy, Debug)]
pub struct FieldRow(pub &'static str);

/// One option of a choice-like field (segment, card or swatch); clicking selects it.
#[derive(Component, Clone, Copy, Debug)]
pub struct Segment {
    pub key: &'static str,
    pub index: usize,
}

/// Toggle switch (clickable).
#[derive(Component, Clone, Copy, Debug)]
pub struct ToggleSwitch(pub &'static str);
#[derive(Component)]
struct ToggleKnob;

/// Slider track (click/drag), its fill and knob, and the value label.
#[derive(Component, Clone, Copy, Debug)]
pub struct SliderTrack(pub &'static str);
#[derive(Component)]
struct SliderFill;
#[derive(Component)]
struct SliderKnob;
/// Text showing a field's formatted value.
#[derive(Component, Clone, Copy, Debug)]
pub struct FieldValue(pub &'static str);

/// A vertically scrolling list: mouse wheel scrolls it and keyboard focus is kept in view.
/// Give the node a fixed or max height and `overflow: Overflow::scroll_y()`.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct ScrollList;

/// The slider being dragged with the mouse.
#[derive(Resource, Default)]
struct Dragging(Option<Entity>);

// ---- looks ----

const CLEAR: Color = Color::NONE;

/// Linear mix in sRGB (a→b by `f`), alpha from `a`.
pub fn mix(a: Color, b: Color, f: f32) -> Color {
    let (x, y) = (a.to_srgba(), b.to_srgba());
    Color::srgba(x.red + (y.red - x.red) * f, x.green + (y.green - x.green) * f, x.blue + (y.blue - x.blue) * f, x.alpha)
}

/// Big menu item: transparent, accent bar + tint when hot.
pub fn nav_look(t: &Theme) -> Look {
    Look::new([CLEAR, t.accent.with_alpha(0.10), CLEAR], [CLEAR; 3], [t.text_muted, t.text, t.text])
}

/// Filled accent button.
pub fn primary_look(t: &Theme) -> Look {
    Look::new([t.accent.with_alpha(0.88), t.accent, t.accent], [CLEAR, t.accent_light(), CLEAR], [t.on_accent; 3])
}

/// Outlined button.
pub fn secondary_look(t: &Theme) -> Look {
    Look::new(
        [Color::srgba(1.0, 1.0, 1.0, 0.04), Color::srgba(1.0, 1.0, 1.0, 0.10), t.raised],
        [t.line_strong, t.accent.with_alpha(0.8), t.line_strong],
        [t.text_muted, t.text, t.text],
    )
}

fn row_look(t: &Theme) -> Look {
    Look::new(
        [t.panel.with_alpha(0.72), t.raised.with_alpha(0.92), CLEAR],
        [CLEAR, t.accent.with_alpha(0.35), CLEAR],
        [t.text, t.text, t.text],
    )
}

fn segment_look(t: &Theme) -> Look {
    Look::new(
        [Color::srgba(1.0, 1.0, 1.0, 0.04), Color::srgba(1.0, 1.0, 1.0, 0.10), t.accent.with_alpha(0.92)],
        [t.line, t.line_strong, t.accent],
        [t.text_muted, t.text, t.on_accent],
    )
}

fn swatch_look(t: &Theme) -> Look {
    Look::new(
        [Color::srgba(1.0, 1.0, 1.0, 0.04), Color::srgba(1.0, 1.0, 1.0, 0.10), Color::srgba(1.0, 1.0, 1.0, 0.10)],
        [t.line, t.line_strong, t.accent],
        [t.text_muted, t.text, t.text],
    )
}

fn card_look(t: &Theme) -> Look {
    let base = t.panel.with_alpha(0.95);
    Look::new(
        [t.panel, mix(base, t.text, 0.05), mix(base, t.accent, 0.12)],
        [t.line, t.line_strong, t.accent],
        [t.text_muted, t.text, t.text],
    )
}

fn tab_look(t: &Theme) -> Look {
    Look::new([CLEAR, Color::srgba(1.0, 1.0, 1.0, 0.06), CLEAR], [CLEAR; 3], [t.text_dim, t.text, t.text])
}

// ---- spawning ----

/// Main-menu style nav item: accent bar + big condensed label.
pub fn nav_button(p: &mut ChildSpawnerCommands, t: &Theme, label_text: &str, action: impl Into<UiAction>, order: u32) {
    p.spawn((
        Button,
        ActionButton(action.into()),
        Focusable { order },
        nav_look(t),
        Node { width: px(420), height: px(62), align_items: AlignItems::Center, padding: UiRect::left(px(26)), ..default() },
        BackgroundColor(CLEAR),
    ))
    .with_children(|b| {
        b.spawn((
            LookBg([CLEAR, t.accent, CLEAR]),
            Node { position_type: PositionType::Absolute, left: px(0), top: px(12), bottom: px(12), width: px(4), ..default() },
            BackgroundColor(CLEAR),
            Pickable::IGNORE,
        ));
        b.spawn(text(label_text.to_uppercase(), label(SIZE_NAV), t.text_muted));
    });
}

/// Column of nav buttons (orders `first..`), offset so labels align with the column edge.
pub fn nav_list(p: &mut ChildSpawnerCommands, t: &Theme, items: &[(&str, UiAction)], first: u32) {
    p.spawn((Node { flex_direction: FlexDirection::Column, row_gap: px(4), margin: UiRect::left(px(-26)), ..default() }, Pickable::IGNORE))
        .with_children(|nav| {
            for (i, (name, action)) in items.iter().enumerate() {
                nav_button(nav, t, name, *action, first + i as u32);
            }
        });
}

/// Filled (primary) or outlined button with a label. `order: None` = mouse only.
pub fn action_button(
    p: &mut ChildSpawnerCommands,
    t: &Theme,
    label_text: &str,
    action: impl Into<UiAction>,
    order: Option<u32>,
    primary: bool,
    width: f32,
) {
    let mut e = p.spawn((
        Button,
        ActionButton(action.into()),
        if primary { primary_look(t) } else { secondary_look(t) },
        Node {
            width: px(width),
            height: px(if primary { 64.0 } else { 52.0 }),
            justify_content: JustifyContent::Center,
            align_items: AlignItems::Center,
            border: UiRect::all(px(1)),
            border_radius: BorderRadius::all(px(RADIUS)),
            flex_shrink: 0.0,
            ..default()
        },
        BackgroundColor(CLEAR),
        BorderColor::all(CLEAR),
        children![text(label_text.to_uppercase(), label(if primary { 28.0 } else { 22.0 }), t.text)],
    ));
    if let Some(order) = order {
        e.insert(Focusable { order });
    }
}

/// Tab strip button.
pub fn tab_button(p: &mut ChildSpawnerCommands, t: &Theme, label_text: &str, index: usize, active: bool) {
    p.spawn((
        Button,
        ActionButton(UiAction::Tab(index)),
        TabButton { active },
        tab_look(t),
        Node {
            padding: UiRect::axes(px(22), px(10)),
            flex_direction: FlexDirection::Column,
            align_items: AlignItems::Center,
            row_gap: px(8),
            ..default()
        },
        BackgroundColor(CLEAR),
    ))
    .with_children(|b| {
        b.spawn(text(label_text.to_uppercase(), label(26.0), if active { t.text } else { t.text_dim }));
        b.spawn((
            Node { width: percent(100), height: px(3), ..default() },
            BackgroundColor(if active { t.accent } else { CLEAR }),
            Pickable::IGNORE,
        ));
    });
}

/// A settings row: label (+ hint) on the left, the control on the right.
pub fn field_row(p: &mut ChildSpawnerCommands, t: &Theme, def: &FieldDef, order: u32) {
    p.spawn((
        Button,
        FieldRow(def.key),
        Focusable { order },
        row_look(t),
        Node {
            width: percent(100),
            min_height: px(68),
            padding: UiRect::axes(px(22), px(10)),
            align_items: AlignItems::Center,
            justify_content: JustifyContent::SpaceBetween,
            column_gap: px(GAP_L),
            border: UiRect::left(px(3)),
            border_radius: BorderRadius::all(px(3)),
            flex_shrink: 0.0,
            ..default()
        },
        BackgroundColor(CLEAR),
        BorderColor::all(CLEAR),
    ))
    .with_children(|row| {
        row.spawn((Node { flex_direction: FlexDirection::Column, row_gap: px(2), flex_shrink: 1.0, ..default() }, Pickable::IGNORE))
            .with_children(|l| {
                l.spawn(text(def.label, body_bold(SIZE_BODY), t.text));
                if !def.hint.is_empty() {
                    l.spawn((text(def.hint, body(SIZE_TINY), t.text_muted), KeepColor));
                }
            });
        row.spawn((Node { width: px(460), flex_shrink: 0.0, justify_content: JustifyContent::FlexEnd, ..default() }, Pickable::IGNORE))
            .with_children(|c| match &def.kind {
                FieldKind::Toggle => spawn_toggle(c, t, def.key),
                FieldKind::Slider { .. } => spawn_slider(c, t, def.key),
                FieldKind::Choice { options } => spawn_segments(c, t, def.key, options),
                FieldKind::Cards { options } => {
                    let titles: Vec<&str> = options.iter().map(|o| o.0).collect();
                    spawn_segments(c, t, def.key, &titles);
                }
                FieldKind::Swatches { colors } => spawn_swatches(c, t, def.key, colors),
            });
    });
}

fn spawn_toggle(p: &mut ChildSpawnerCommands, t: &Theme, key: &'static str) {
    p.spawn((Node { align_items: AlignItems::Center, column_gap: px(GAP_M), ..default() }, Pickable::IGNORE))
        .with_children(|r| {
            r.spawn((FieldValue(key), text("", label(20.0), t.text_muted), KeepColor, Node { width: px(40), ..default() }));
            r.spawn((
                Button,
                ToggleSwitch(key),
                Node {
                    width: px(60),
                    height: px(30),
                    padding: UiRect::all(px(4)),
                    border_radius: BorderRadius::all(px(15)),
                    align_items: AlignItems::Center,
                    ..default()
                },
                BackgroundColor(t.raised),
            ))
            .with_child((
                ToggleKnob,
                Node { width: px(22), height: px(22), border_radius: BorderRadius::all(px(11)), ..default() },
                BackgroundColor(t.text),
                Pickable::IGNORE,
            ));
        });
}

fn segment_node() -> Node {
    Node {
        flex_grow: 1.0,
        flex_basis: px(0),
        height: px(40),
        justify_content: JustifyContent::Center,
        align_items: AlignItems::Center,
        column_gap: px(6),
        border: UiRect::all(px(1)),
        border_radius: BorderRadius::all(px(3)),
        ..default()
    }
}

fn spawn_segments(p: &mut ChildSpawnerCommands, t: &Theme, key: &'static str, options: &[&str]) {
    p.spawn((Node { width: percent(100), column_gap: px(4), ..default() }, Pickable::IGNORE)).with_children(|r| {
        for (i, o) in options.iter().enumerate() {
            r.spawn((Button, Segment { key, index: i }, segment_look(t), segment_node(), BackgroundColor(CLEAR), BorderColor::all(CLEAR)))
                .with_child(text(o.to_uppercase(), label(19.0), t.text_muted));
        }
    });
}

fn spawn_swatches(p: &mut ChildSpawnerCommands, t: &Theme, key: &'static str, colors: &[[f32; 3]]) {
    p.spawn((Node { width: percent(100), column_gap: px(4), ..default() }, Pickable::IGNORE)).with_children(|r| {
        for (i, c) in colors.iter().enumerate() {
            r.spawn((Button, Segment { key, index: i }, swatch_look(t), segment_node(), BackgroundColor(CLEAR), BorderColor::all(CLEAR)))
                .with_child((
                    Node { width: px(20), height: px(20), border_radius: BorderRadius::all(px(10)), ..default() },
                    BackgroundColor(Color::srgb(c[0], c[1], c[2])),
                    Pickable::IGNORE,
                ));
        }
    });
}

fn spawn_slider(p: &mut ChildSpawnerCommands, t: &Theme, key: &'static str) {
    p.spawn((Node { align_items: AlignItems::Center, column_gap: px(GAP_M), ..default() }, Pickable::IGNORE))
        .with_children(|r| {
            r.spawn((
                Button,
                SliderTrack(key),
                RelativeCursorPosition::default(),
                // Tall invisible hit area around a thin track.
                Node { width: px(340), height: px(30), align_items: AlignItems::Center, ..default() },
            ))
            .with_children(|tr| {
                tr.spawn((
                    Node { width: percent(100), height: px(6), border_radius: BorderRadius::all(px(3)), ..default() },
                    BackgroundColor(t.raised),
                    Pickable::IGNORE,
                ))
                .with_child((
                    SliderFill,
                    Node { width: percent(0), height: percent(100), border_radius: BorderRadius::all(px(3)), ..default() },
                    BackgroundColor(t.accent),
                    Pickable::IGNORE,
                ));
                tr.spawn((
                    SliderKnob,
                    Node {
                        position_type: PositionType::Absolute,
                        left: percent(0),
                        width: px(18),
                        height: px(18),
                        margin: UiRect::left(px(-9)),
                        border_radius: BorderRadius::all(px(9)),
                        border: UiRect::all(px(2)),
                        ..default()
                    },
                    BackgroundColor(t.text),
                    BorderColor::all(t.accent),
                    Pickable::IGNORE,
                ));
            });
            r.spawn((
                FieldValue(key),
                text("", body_bold(SIZE_BODY), t.text),
                KeepColor,
                TextLayout::justify(Justify::Right),
                Node { width: px(64), ..default() },
            ));
        });
}

/// Large selectable cards for a choice-like field (match setup, mode pickers): title + blurb.
/// Works for `Cards` (blurbs shown) and `Choice` (titles only). Left/Right moves the selection.
pub fn card_row(p: &mut ChildSpawnerCommands, t: &Theme, def: &FieldDef, order: u32, card_w: f32) {
    let cards: Vec<(&str, &str)> = match &def.kind {
        FieldKind::Cards { options } => options.clone(),
        FieldKind::Choice { options } => options.iter().map(|o| (*o, "")).collect(),
        _ => {
            warn!("card_row: '{}' is not a choice/cards field", def.key);
            return;
        }
    };
    p.spawn((
        Button,
        FieldRow(def.key),
        Focusable { order },
        Look::new([CLEAR; 3], [CLEAR; 3], [t.text; 3]),
        Node { column_gap: px(GAP_M), ..default() },
        BackgroundColor(CLEAR),
    ))
    .with_children(|r| {
        for (i, (title_text, blurb)) in cards.iter().enumerate() {
            r.spawn((
                Button,
                Segment { key: def.key, index: i },
                card_look(t),
                Node {
                    width: px(card_w),
                    min_height: px(132),
                    flex_direction: FlexDirection::Column,
                    row_gap: px(GAP_S),
                    padding: UiRect::new(px(20), px(20), px(18), px(18)),
                    border: UiRect::all(px(1)),
                    border_radius: BorderRadius::all(px(RADIUS)),
                    ..default()
                },
                BackgroundColor(CLEAR),
                BorderColor::all(CLEAR),
            ))
            .with_children(|c| {
                c.spawn((
                    LookBg([t.line, t.line_strong, t.accent]),
                    Node { width: px(28), height: px(3), margin: UiRect::bottom(px(4)), ..default() },
                    BackgroundColor(t.line),
                    Pickable::IGNORE,
                ));
                c.spawn(text(title_text.to_uppercase(), display(32.0), t.text_muted));
                if !blurb.is_empty() {
                    c.spawn((text(*blurb, body(SIZE_SMALL), t.text_muted), KeepColor));
                }
            });
        }
    });
}

// ---- plugin ----

pub struct WidgetsPlugin;

impl Plugin for WidgetsPlugin {
    fn build(&self, app: &mut App) {
        use super::UiSet;
        app.init_resource::<NavQueue>()
            .init_resource::<Focus>()
            .init_resource::<Dragging>()
            .init_resource::<FieldValues>()
            .init_resource::<FieldEdits>()
            .add_message::<UiActivated>()
            .add_message::<NavBack>()
            .add_message::<SaveSettings>()
            .add_systems(PreUpdate, keyboard_nav.run_if(super::ui_visible).after(bevy::input::InputSystems))
            .add_systems(
                Update,
                (
                    refresh_field_values,
                    (mouse_focus, press_widgets, drag_sliders, validate_focus, apply_nav, scroll_lists).chain(),
                    apply_field_edits,
                )
                    .chain()
                    .in_set(UiSet::Input),
            )
            .add_systems(
                Update,
                (refresh_field_values, validate_focus, refresh_fields, keep_focus_visible, paint).chain().in_set(UiSet::Paint),
            );
    }
}

fn keyboard_nav(keys: Option<Res<ButtonInput<KeyCode>>>, mut q: ResMut<NavQueue>) {
    let Some(keys) = keys else { return };
    let map = [
        (KeyCode::ArrowUp, NavInput::Up),
        (KeyCode::KeyW, NavInput::Up),
        (KeyCode::ArrowDown, NavInput::Down),
        (KeyCode::KeyS, NavInput::Down),
        (KeyCode::ArrowLeft, NavInput::Left),
        (KeyCode::KeyA, NavInput::Left),
        (KeyCode::ArrowRight, NavInput::Right),
        (KeyCode::KeyD, NavInput::Right),
        (KeyCode::Enter, NavInput::Accept),
        (KeyCode::NumpadEnter, NavInput::Accept),
        (KeyCode::Space, NavInput::Accept),
        (KeyCode::Escape, NavInput::Back),
        (KeyCode::Backspace, NavInput::Back),
        (KeyCode::KeyE, NavInput::NextTab),
        (KeyCode::KeyQ, NavInput::PrevTab),
    ];
    for (k, n) in map {
        if keys.just_pressed(k) {
            q.0.push(n);
        }
    }
    if keys.just_pressed(KeyCode::Tab) {
        let shift = keys.any_pressed([KeyCode::ShiftLeft, KeyCode::ShiftRight]);
        q.0.push(if shift { NavInput::PrevTab } else { NavInput::NextTab });
    }
}

/// Read the current value of every field that has a live row.
fn refresh_field_values(world: &mut World, rows: &mut QueryState<&'static FieldRow>) {
    let keys: Vec<&'static str> = rows.iter(world).map(|r| r.0).collect();
    if keys.is_empty() {
        return;
    }
    let Some(reg) = world.get_resource::<SettingsRegistry>() else { return };
    let gets: Vec<(&'static str, fn(&World) -> f32)> = keys.iter().filter_map(|k| reg.field(k).map(|d| (d.key, d.get))).collect();
    let vals: Vec<(&'static str, f32)> = gets.into_iter().map(|(k, get)| (k, get(world))).collect();
    let mut fv = world.resource_mut::<FieldValues>();
    for (k, v) in vals {
        if fv.0.get(k) != Some(&v) {
            fv.0.insert(k, v);
        }
    }
}

/// Write this frame's widget edits back with each field's `set`, then ask for a save.
fn apply_field_edits(world: &mut World) {
    let edits = std::mem::take(&mut world.resource_mut::<FieldEdits>().0);
    if edits.is_empty() {
        return;
    }
    let Some(reg) = world.get_resource::<SettingsRegistry>() else { return };
    let sets: Vec<(fn(&mut World, f32), f32)> = edits.iter().filter_map(|(k, v)| reg.field(k).map(|d| (d.set, *v))).collect();
    for (set, v) in sets {
        set(world, v);
    }
    world.write_message(SaveSettings);
}

/// Nearest `Focusable` at or above `e`.
fn focus_owner(e: Entity, focusables: &Query<&Focusable>, parents: &Query<&ChildOf>) -> Option<Entity> {
    let mut cur = e;
    for _ in 0..8 {
        if focusables.contains(cur) {
            return Some(cur);
        }
        cur = parents.get(cur).ok()?.parent();
    }
    None
}

/// Hovering a widget focuses it (only when the mouse actually moved, so a resting cursor
/// doesn't fight the keyboard).
fn mouse_focus(
    motion: Option<Res<AccumulatedMouseMotion>>,
    hovered: Query<(Entity, &Interaction), Changed<Interaction>>,
    all: Query<(Entity, &Interaction)>,
    focusables: Query<&Focusable>,
    parents: Query<&ChildOf>,
    mut focus: ResMut<Focus>,
) {
    let moved = motion.is_some_and(|m| m.delta != Vec2::ZERO);
    let pick = |e: Entity, i: &Interaction| (*i != Interaction::None).then(|| focus_owner(e, &focusables, &parents)).flatten();
    let mut target = hovered.iter().find_map(|(e, i)| pick(e, i));
    if target.is_none() && moved {
        target = all.iter().find_map(|(e, i)| pick(e, i));
    }
    if let Some(t) = target
        && focus.0 != Some(t)
    {
        focus.0 = Some(t);
    }
}

fn press_widgets(
    buttons: Query<(&Interaction, &ActionButton), Changed<Interaction>>,
    segments: Query<(&Interaction, &Segment), Changed<Interaction>>,
    toggles: Query<(&Interaction, &ToggleSwitch), Changed<Interaction>>,
    tracks: Query<(Entity, &Interaction), (With<SliderTrack>, Changed<Interaction>)>,
    reg: Option<Res<SettingsRegistry>>,
    mut values: ResMut<FieldValues>,
    mut edits: ResMut<FieldEdits>,
    mut dragging: ResMut<Dragging>,
    mut out: MessageWriter<UiActivated>,
) {
    for (i, b) in &buttons {
        if *i == Interaction::Pressed {
            out.write(UiActivated(b.0));
        }
    }
    let Some(reg) = reg else { return };
    for (i, s) in &segments {
        if *i == Interaction::Pressed
            && let Some(def) = reg.field(s.key)
        {
            edit(&mut values, &mut edits, def, s.index as f32);
        }
    }
    for (i, t) in &toggles {
        if *i == Interaction::Pressed
            && let Some(def) = reg.field(t.0)
        {
            let v = cycle_value(&def.kind, values.get(def.key));
            edit(&mut values, &mut edits, def, v);
        }
    }
    for (e, i) in &tracks {
        if *i == Interaction::Pressed {
            dragging.0 = Some(e);
        }
    }
}

fn drag_sliders(
    mouse: Option<Res<ButtonInput<MouseButton>>>,
    mut dragging: ResMut<Dragging>,
    tracks: Query<(&SliderTrack, &RelativeCursorPosition)>,
    reg: Option<Res<SettingsRegistry>>,
    mut values: ResMut<FieldValues>,
    mut edits: ResMut<FieldEdits>,
) {
    let Some(e) = dragging.0 else { return };
    if !mouse.is_some_and(|m| m.pressed(MouseButton::Left)) {
        dragging.0 = None;
        return;
    }
    let (Ok((track, pos)), Some(reg)) = (tracks.get(e), reg) else {
        dragging.0 = None;
        return;
    };
    let Some(n) = pos.normalized else { return };
    if let Some(def) = reg.field(track.0)
        && let FieldKind::Slider { min, max, .. } = def.kind
    {
        // `normalized` is centred on the node: -0.5..0.5.
        let f = (n.x + 0.5).clamp(0.0, 1.0);
        edit(&mut values, &mut edits, def, min + (max - min) * f);
    }
}

/// Keep focus on a live entity; default to the first item.
fn validate_focus(mut focus: ResMut<Focus>, q: Query<(Entity, &Focusable)>) {
    if focus.0.is_some_and(|e| q.contains(e)) {
        return;
    }
    let first = q.iter().min_by_key(|(_, f)| f.order).map(|(e, _)| e);
    if focus.0 != first {
        focus.0 = first;
    }
}

/// The focusable after (`down`) or before `order`, by order.
pub fn next_in_order(orders: impl Iterator<Item = (Entity, u32)>, order: u32, down: bool) -> Option<Entity> {
    let it = orders.filter(|(_, o)| if down { *o > order } else { *o < order });
    if down { it.min_by_key(|(_, o)| *o) } else { it.max_by_key(|(_, o)| *o) }.map(|(e, _)| e)
}

/// Move focus / adjust fields / activate buttons. Back and tab switching become messages.
fn apply_nav(
    mut queue: ResMut<NavQueue>,
    mut focus: ResMut<Focus>,
    focusables: Query<(Entity, &Focusable)>,
    buttons: Query<&ActionButton>,
    rows: Query<&FieldRow>,
    reg: Option<Res<SettingsRegistry>>,
    mut values: ResMut<FieldValues>,
    mut edits: ResMut<FieldEdits>,
    mut out: MessageWriter<UiActivated>,
    mut back: MessageWriter<NavBack>,
) {
    let inputs: Vec<NavInput> = queue.0.drain(..).collect();
    for input in inputs {
        let cur = focus.0.and_then(|e| focusables.get(e).ok());
        let row_def = cur.and_then(|(e, _)| rows.get(e).ok()).and_then(|r| reg.as_deref()?.field(r.0));
        match input {
            NavInput::Up | NavInput::Down => {
                let Some((_, f)) = cur else { continue };
                if let Some(e) = next_in_order(focusables.iter().map(|(e, f)| (e, f.order)), f.order, input == NavInput::Down) {
                    focus.0 = Some(e);
                }
            }
            NavInput::Left | NavInput::Right => {
                if let Some(def) = row_def {
                    let dir = if input == NavInput::Right { 1.0 } else { -1.0 };
                    let v = step_value(&def.kind, values.get(def.key), dir);
                    edit(&mut values, &mut edits, def, v);
                }
            }
            NavInput::Accept => {
                let Some((e, _)) = cur else { continue };
                if let Ok(b) = buttons.get(e) {
                    out.write(UiActivated(b.0));
                } else if let Some(def) = row_def {
                    let v = cycle_value(&def.kind, values.get(def.key));
                    edit(&mut values, &mut edits, def, v);
                }
            }
            NavInput::Back => {
                back.write(NavBack);
            }
            NavInput::NextTab => {
                out.write(UiActivated(UiAction::NextTab));
            }
            NavInput::PrevTab => {
                out.write(UiActivated(UiAction::PrevTab));
            }
        }
    }
}

/// Mouse wheel scrolls the hovered [`ScrollList`].
fn scroll_lists(
    wheel: Option<Res<AccumulatedMouseScroll>>,
    mut lists: Query<(&mut ScrollPosition, &RelativeCursorPosition), With<ScrollList>>,
) {
    let Some(wheel) = wheel else { return };
    if wheel.delta.y == 0.0 {
        return;
    }
    let dy = match wheel.unit {
        MouseScrollUnit::Line => wheel.delta.y * 48.0,
        MouseScrollUnit::Pixel => wheel.delta.y,
    };
    for (mut pos, cursor) in &mut lists {
        if cursor.cursor_over {
            pos.y = (pos.y - dy).max(0.0);
        }
    }
}

/// Scroll the focused widget's [`ScrollList`] so it is fully visible.
fn keep_focus_visible(
    focus: Res<Focus>,
    parents: Query<&ChildOf>,
    nodes: Query<(&ComputedNode, &UiGlobalTransform)>,
    mut lists: Query<&mut ScrollPosition, With<ScrollList>>,
) {
    let Some(f) = focus.0 else { return };
    let Some(list) = ancestors(f, &parents).find(|a| lists.contains(*a)) else { return };
    let (Ok((item, item_tf)), Ok((view, view_tf))) = (nodes.get(f), nodes.get(list)) else { return };
    // Centres and sizes are in physical px; ScrollPosition is logical.
    let inv = view.inverse_scale_factor;
    let item_top = item_tf.translation.y - item.size.y * 0.5;
    let item_bottom = item_tf.translation.y + item.size.y * 0.5;
    let view_top = view_tf.translation.y - view.size.y * 0.5;
    let view_bottom = view_tf.translation.y + view.size.y * 0.5;
    let Ok(mut pos) = lists.get_mut(list) else { return };
    let margin = 8.0 / inv.max(1e-3);
    if item_bottom + margin > view_bottom {
        pos.y += (item_bottom + margin - view_bottom) * inv;
    } else if item_top - margin < view_top {
        pos.y = (pos.y - (view_top - item_top + margin) * inv).max(0.0);
    }
}

/// Sync field widgets with [`FieldValues`] (cheap; runs every frame while widgets exist).
fn refresh_fields(
    theme: Res<super::theme::Theme>,
    values: Res<FieldValues>,
    reg: Option<Res<SettingsRegistry>>,
    mut toggles: Query<(&ToggleSwitch, &mut Node, &mut BackgroundColor), Without<SliderKnob>>,
    tracks: Query<(&SliderTrack, &Children)>,
    mut fills: Query<&mut Node, (With<SliderFill>, Without<ToggleSwitch>, Without<SliderKnob>)>,
    mut knob_nodes: Query<&mut Node, (With<SliderKnob>, Without<ToggleSwitch>, Without<SliderFill>)>,
    children: Query<&Children>,
    mut texts: Query<(&FieldValue, &mut Text)>,
) {
    let Some(reg) = reg else { return };
    for (t, mut node, mut bg) in &mut toggles {
        let on = values.get(t.0) > 0.5;
        let j = if on { JustifyContent::FlexEnd } else { JustifyContent::FlexStart };
        if node.justify_content != j {
            node.justify_content = j;
        }
        let c = if on { theme.accent } else { theme.raised };
        if bg.0 != c {
            bg.0 = c;
        }
    }
    for (track, kids) in &tracks {
        let Some(def) = reg.field(track.0) else { continue };
        let pct = percent(slider_fraction(&def.kind, values.get(def.key)) * 100.0);
        for k in kids.iter() {
            if let Ok(mut n) = knob_nodes.get_mut(k)
                && n.left != pct
            {
                n.left = pct;
            }
            for g in children.iter_descendants(k) {
                if let Ok(mut n) = fills.get_mut(g)
                    && n.width != pct
                {
                    n.width = pct;
                }
            }
        }
    }
    for (f, mut text) in &mut texts {
        let Some(def) = reg.field(f.0) else { continue };
        let s = format_value(&def.kind, values.get(def.key));
        if text.0 != s {
            text.0 = s;
        }
    }
}

/// Apply [`Look`] colours from hover/focus/selection.
fn paint(
    focus: Res<Focus>,
    values: Res<FieldValues>,
    looks: Query<(Entity, &Look, Option<&Interaction>, Option<&Segment>, Option<&TabButton>)>,
    rows: Query<&FieldRow>,
    parents: Query<&ChildOf>,
    children: Query<&Children>,
    has_look: Query<(), With<Look>>,
    mut bgs: Query<&mut BackgroundColor>,
    mut borders: Query<&mut BorderColor>,
    mut texts: Query<&mut TextColor, Without<KeepColor>>,
    look_bgs: Query<&LookBg>,
) {
    for (e, look, interaction, segment, tab) in &looks {
        let hovered = interaction.is_some_and(|i| *i != Interaction::None);
        let mut hot = hovered || focus.0 == Some(e);
        let on = match (segment, tab) {
            (Some(s), _) => values.0.get(s.key).is_some_and(|v| v.round() as usize == s.index),
            (_, Some(t)) => t.active,
            _ => false,
        };
        // The selected option of a focused row counts as hot (keyboard focus indicator).
        if let Some(s) = segment
            && on
        {
            hot |= ancestors(e, &parents).any(|a| focus.0 == Some(a) && rows.get(a).is_ok_and(|r| r.0 == s.key));
        }
        let idx = if on {
            2
        } else if hot {
            1
        } else {
            0
        };
        if let Ok(mut bg) = bgs.get_mut(e)
            && bg.0 != look.bg[idx]
        {
            bg.0 = look.bg[idx];
        }
        // Selected but not focused: a softer outline.
        let border = if on && !hot { look.border[2].with_alpha(look.border[2].alpha() * 0.5) } else { look.border[idx] };
        if let Ok(mut b) = borders.get_mut(e)
            && b.top != border
        {
            *b = BorderColor::all(border);
        }
        // Subtree (stop at nested Looks).
        let mut stack: Vec<Entity> = children.get(e).map(|c| c.iter().collect()).unwrap_or_default();
        while let Some(c) = stack.pop() {
            if has_look.contains(c) {
                continue;
            }
            if let Ok(mut t) = texts.get_mut(c)
                && t.0 != look.text[idx]
            {
                t.0 = look.text[idx];
            }
            if let Ok(lb) = look_bgs.get(c)
                && let Ok(mut bg) = bgs.get_mut(c)
                && bg.0 != lb.0[idx]
            {
                bg.0 = lb.0[idx];
            }
            if let Ok(cc) = children.get(c) {
                stack.extend(cc.iter());
            }
        }
    }
}

pub(crate) fn ancestors<'a>(e: Entity, parents: &'a Query<&ChildOf>) -> impl Iterator<Item = Entity> + 'a {
    let mut cur = Some(e);
    std::iter::from_fn(move || {
        let p = parents.get(cur?).ok()?.parent();
        cur = Some(p);
        Some(p)
    })
}

/// Tab index after a tab action: `next`/`prev` wrap, an index clamps. `n == 0` → 0.
pub fn wrap_tab(cur: usize, action: UiAction, n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    match action {
        UiAction::NextTab => (cur + 1) % n,
        UiAction::PrevTab => (cur + n - 1) % n,
        UiAction::Tab(i) => i.min(n - 1),
        _ => cur.min(n - 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pct(v: f32) -> String {
        format!("{:.0}%", v * 100.0)
    }

    fn slider() -> FieldKind {
        FieldKind::Slider { min: 0.0, max: 1.0, step: 0.05, format: pct }
    }

    #[test]
    fn slider_snaps_clamps_and_steps() {
        let k = slider();
        assert_eq!(normalize(&k, 0.333), 0.35);
        assert_eq!(normalize(&k, 7.0), 1.0);
        assert_eq!(normalize(&k, -1.0), 0.0);
        assert_eq!(normalize(&k, f32::NAN), 0.0);
        assert!((step_value(&k, 0.8, -1.0) - 0.75).abs() < 1e-6);
        assert_eq!(step_value(&k, 1.0, 1.0), 1.0);
        assert_eq!(cycle_value(&k, 0.4), 0.4, "Enter leaves sliders alone");
        assert_eq!(format_value(&k, 0.75), "75%");
        assert!((slider_fraction(&k, 0.25) - 0.25).abs() < 1e-6);
        let fov = FieldKind::Slider { min: 60.0, max: 110.0, step: 1.0, format: |v| format!("{v:.0}\u{b0}") };
        assert_eq!(normalize(&fov, 80.4), 80.0);
        assert_eq!(format_value(&fov, 80.0), "80\u{b0}");
    }

    #[test]
    fn toggles_and_choices() {
        let t = FieldKind::Toggle;
        assert_eq!(step_value(&t, 0.0, 1.0), 1.0);
        assert_eq!(step_value(&t, 1.0, 1.0), 1.0, "Right = on, never flips back");
        assert_eq!(step_value(&t, 1.0, -1.0), 0.0);
        assert_eq!(cycle_value(&t, 1.0), 0.0);
        assert_eq!(format_value(&t, 1.0), "ON");

        let c = FieldKind::Choice { options: vec!["Low", "Medium", "High"] };
        assert_eq!(step_value(&c, 2.0, 1.0), 2.0, "arrows don't wrap");
        assert_eq!(step_value(&c, 0.0, -1.0), 0.0);
        assert_eq!(cycle_value(&c, 2.0), 0.0, "Enter wraps");
        assert_eq!(normalize(&c, 9.0), 2.0);
        assert_eq!(format_value(&c, 1.0), "Medium");

        let cards = FieldKind::Cards { options: vec![("Easy", "a"), ("Hard", "b")] };
        assert_eq!(option_count(&cards), Some(2));
        assert_eq!(format_value(&cards, 1.0), "Hard");
        let sw = FieldKind::Swatches { colors: vec![[1.0; 3]; 4] };
        assert_eq!(cycle_value(&sw, 3.0), 0.0);
    }

    #[test]
    fn tabs_wrap() {
        assert_eq!(wrap_tab(3, UiAction::NextTab, 4), 0);
        assert_eq!(wrap_tab(0, UiAction::PrevTab, 4), 3);
        assert_eq!(wrap_tab(0, UiAction::Tab(2), 4), 2);
        assert_eq!(wrap_tab(0, UiAction::Tab(9), 4), 3);
        assert_eq!(wrap_tab(5, UiAction::NextTab, 0), 0);
    }

    #[test]
    fn nav_order_skips_gaps() {
        let mut w = World::new();
        let a = w.spawn_empty().id();
        let b = w.spawn_empty().id();
        let c = w.spawn_empty().id();
        let items = [(a, 1), (b, 5), (c, 3)];
        assert_eq!(next_in_order(items.iter().copied(), 1, true), Some(c));
        assert_eq!(next_in_order(items.iter().copied(), 3, true), Some(b));
        assert_eq!(next_in_order(items.iter().copied(), 5, true), None);
        assert_eq!(next_in_order(items.iter().copied(), 5, false), Some(c));
        assert_eq!(NavInput::parse("esc"), Some(NavInput::Back));
    }
}
