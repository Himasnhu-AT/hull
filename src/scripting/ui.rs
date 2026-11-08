//! UI from scripts (Godot `Control`). Buttons emit `pressed`, `mouse_entered`, `mouse_exited`
//! (see `ui_signals` in `mod.rs`).
//!
//! Building: `ui_panel`, `ui_vbox`, `ui_hbox`, `ui_label`, `ui_button`, `ui_progress`.
//! Driving: `set_text`, `get_text`, `set_font_size`, `set_text_color`, `set_disabled`,
//! `set_progress`, `ui_set(prop, value)`. Colours are `[r, g, b]` or `[r, g, b, a]` (0..1).
//! All of them also work on UI built in Rust or in level files.

use bevy::picking::hover::Hovered;
use bevy::prelude::*;
use bevy::ui::{InteractionDisabled, Pressed, UiTransform, Val2};
use bevy::ui_widgets::Button;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{self, b, f, rent, s, split, world};
use crate::ui::theme::{self, GAP_M, GAP_S, GAP_XS, RADIUS, REM_PX, SIZE_BODY, Theme};

/// A script-built (or any) button's colours. [`button_look`] applies them from hover / press /
/// disabled state.
#[derive(Component, Reflect, Clone, Debug)]
#[reflect(Component)]
pub struct UiButton {
    pub idle: Color,
    pub hot: Color,
    pub down: Color,
    pub text: Color,
    pub text_disabled: Color,
}

impl UiButton {
    pub(super) fn themed(t: &Theme) -> Self {
        UiButton { idle: t.raised, hot: t.line_strong.mix(&t.raised, 0.6), down: t.accent, text: t.text, text_disabled: t.text_dim }
    }
}

/// A progress bar: `value` 0..1 drawn by a [`UiProgressFill`] child.
#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiProgress {
    pub value: f32,
}

#[derive(Component, Reflect, Clone, Debug, Default)]
#[reflect(Component)]
pub struct UiProgressFill;

pub(super) fn plugin(app: &mut App) {
    app.register_type::<UiButton>().register_type::<UiProgress>().register_type::<UiProgressFill>();
    app.add_systems(Update, button_look.in_set(super::ScriptSet::Events));
}

type LookQuery<'w, 's> =
    Query<'w, 's, (&'static UiButton, &'static mut BackgroundColor, Option<&'static Hovered>, Has<Pressed>, Has<InteractionDisabled>, Option<&'static Children>)>;

/// Hover / press / disabled feedback for [`UiButton`]s. Writes only when a value changes.
fn button_look(mut buttons: LookQuery, mut texts: Query<&mut TextColor, Without<UiButton>>) {
    for (look, mut bg, hovered, pressed, disabled, children) in &mut buttons {
        let (fill, text) = if disabled {
            (look.idle.with_alpha(look.idle.alpha() * 0.4), look.text_disabled)
        } else if pressed {
            (look.down, look.text)
        } else if hovered.is_some_and(|h| h.0) {
            (look.hot, look.text)
        } else {
            (look.idle, look.text)
        };
        if bg.0 != fill {
            bg.0 = fill;
        }
        for c in children.into_iter().flatten() {
            if let Ok(mut tc) = texts.get_mut(*c)
                && tc.0 != text
            {
                tc.0 = text;
            }
        }
    }
}

// ---------------------------------------------------------------- helpers

pub(super) fn theme_of(w: &World) -> Theme {
    w.get_resource::<Theme>().cloned().unwrap_or_default()
}

pub(super) fn color(v: &RV, what: &str) -> Result<Color, String> {
    let norm = super::api::arr_of(v);
    let v = norm.as_ref().unwrap_or(v);
    if let RV::Array(a) = v {
        let a = a.borrow();
        if a.len() == 3 || a.len() == 4 {
            let al = if a.len() == 4 { f(&a[3], what)? } else { 1.0 };
            return Ok(Color::srgba(f(&a[0], what)?, f(&a[1], what)?, f(&a[2], what)?, al));
        }
    }
    Err(format!("{what} must be [r, g, b] or [r, g, b, a], got {}", v.type_name()))
}

/// `12` = px, `"50%"` = percent, `"auto"`.
fn val(v: &RV, what: &str) -> Result<Val, String> {
    match v {
        RV::Int(_) | RV::Float(_) => Ok(Val::Px(f(v, what)?)),
        RV::Str(t) => {
            let t = t.trim();
            if t == "auto" {
                Ok(Val::Auto)
            } else if let Some(p) = t.strip_suffix('%') {
                p.trim().parse::<f32>().map(Val::Percent).map_err(|_| format!("{what}: bad percent `{t}`"))
            } else if let Some(p) = t.strip_suffix("px") {
                p.trim().parse::<f32>().map(Val::Px).map_err(|_| format!("{what}: bad size `{t}`"))
            } else {
                Err(format!("{what}: expected a number, \"50%\" or \"auto\", got `{t}`"))
            }
        }
        other => Err(format!("{what} must be a number, \"50%\" or \"auto\", got {}", other.type_name())),
    }
}

/// Spawns `bundle` under `parent` (an entity) or as an absolutely positioned root (null).
pub(super) fn spawn_node(w: &mut World, parent: Option<&RV>, name: &str, bundle: impl Bundle) -> Result<Entity, String> {
    let parent = match parent {
        None | Some(RV::Null) => None,
        Some(p) => Some(api::live(w, api::ent(p)?)?),
    };
    let e = w.spawn((Name::new(name.to_string()), bundle)).id();
    match parent {
        Some(p) => {
            w.entity_mut(e).insert(ChildOf(p));
        }
        None => {
            if let Some(mut n) = w.get_mut::<Node>(e) {
                n.position_type = PositionType::Absolute;
                n.left = Val::Px(0.0);
                n.top = Val::Px(0.0);
            }
        }
    }
    Ok(e)
}

pub(super) fn flex(dir: FlexDirection, gap: f32) -> Node {
    Node { flex_direction: dir, row_gap: Val::Px(gap), column_gap: Val::Px(gap), ..default() }
}

/// The entity holding the `Text`: `e` itself, else the first descendant that has one.
fn text_entity(w: &World, e: Entity) -> Option<Entity> {
    if w.get::<Text>(e).is_some() {
        return Some(e);
    }
    w.get::<Children>(e)?.iter().find_map(|c| text_entity(w, c))
}

fn need_text(w: &World, e: Entity) -> Result<Entity, String> {
    text_entity(w, e).ok_or_else(|| format!("{e} has no text (use a label or a button)"))
}

fn set_val(n: &mut Node, prop: &str, v: Val) -> Result<(), String> {
    match prop {
        "width" => n.width = v,
        "height" => n.height = v,
        "left" => n.left = v,
        "top" => n.top = v,
        "right" => n.right = v,
        "bottom" => n.bottom = v,
        "margin" => n.margin = UiRect::all(v),
        "padding" => n.padding = UiRect::all(v),
        "gap" => {
            n.row_gap = v;
            n.column_gap = v;
        }
        _ => return Err(format!("unknown ui property `{prop}` (width, height, left, top, right, bottom, margin, padding, gap, anchor, align, bg, visible)")),
    }
    Ok(())
}

/// Godot anchor presets as (horizontal, vertical): 0 start, 1 center, 2 end, 3 stretch.
fn anchor_of(name: &str) -> Result<(u8, u8), String> {
    Ok(match name {
        "top_left" => (0, 0),
        "top" => (1, 0),
        "top_right" => (2, 0),
        "left" => (0, 1),
        "center" => (1, 1),
        "right" => (2, 1),
        "bottom_left" => (0, 2),
        "bottom" => (1, 2),
        "bottom_right" => (2, 2),
        "full" => (3, 3),
        other => return Err(format!("unknown anchor `{other}` (top_left, top, top_right, left, center, right, bottom_left, bottom, bottom_right, full)")),
    })
}

/// One axis of an anchor: sets (near, far) offsets, returns the self-translation.
fn axis(k: u8) -> (Val, Val, Val) {
    match k {
        0 => (Val::Px(0.0), Val::Auto, Val::Px(0.0)),
        1 => (Val::Percent(50.0), Val::Auto, Val::Percent(-50.0)),
        2 => (Val::Auto, Val::Px(0.0), Val::Px(0.0)),
        _ => (Val::Px(0.0), Val::Px(0.0), Val::Px(0.0)),
    }
}

fn apply_anchor(w: &mut World, e: Entity, name: &str) -> Result<(), String> {
    let (h, v) = anchor_of(name)?;
    let (l, r, tx) = axis(h);
    let (t, bt, ty) = axis(v);
    {
        let mut n = w.get_mut::<Node>(e).ok_or("anchor needs a UI node")?;
        n.position_type = PositionType::Absolute;
        n.margin = UiRect::ZERO;
        (n.left, n.right, n.top, n.bottom) = (l, r, t, bt);
    }
    w.entity_mut(e).insert(UiTransform::from_translation(Val2::new(tx, ty)));
    Ok(())
}

fn align_of(name: &str) -> Result<(AlignItems, JustifyContent), String> {
    Ok(match name {
        "start" => (AlignItems::FlexStart, JustifyContent::FlexStart),
        "center" => (AlignItems::Center, JustifyContent::Center),
        "end" => (AlignItems::FlexEnd, JustifyContent::FlexEnd),
        other => return Err(format!("unknown align `{other}` (start, center, end)")),
    })
}

fn ui_set(w: &mut World, e: Entity, prop: &str, v: &RV) -> Result<(), String> {
    match prop {
        "anchor" => apply_anchor(w, e, s(v, "anchor")?),
        "align" => {
            let (ai, jc) = align_of(s(v, "align")?)?;
            let mut n = w.get_mut::<Node>(e).ok_or("align needs a UI node")?;
            n.align_items = ai;
            n.justify_content = jc;
            Ok(())
        }
        "bg" => {
            let c = if matches!(v, RV::Null) { None } else { Some(color(v, "bg")?) };
            if let Some(mut bt) = w.get_mut::<UiButton>(e) {
                bt.idle = c.unwrap_or(Color::NONE);
            } else if let Some(c) = c {
                w.entity_mut(e).insert(BackgroundColor(c));
            } else {
                w.entity_mut(e).remove::<BackgroundColor>();
            }
            Ok(())
        }
        "visible" => {
            let on = b(v, "visible")?;
            w.get_mut::<Node>(e).ok_or("visible needs a UI node")?.display = if on { Display::Flex } else { Display::None };
            w.entity_mut(e).insert(if on { Visibility::Inherited } else { Visibility::Hidden });
            Ok(())
        }
        _ => {
            let val = val(v, prop)?;
            let mut n = w.get_mut::<Node>(e).ok_or_else(|| format!("{e} is not a UI node"))?;
            set_val(&mut n, prop, val)
        }
    }
}

pub(super) fn set_fill(w: &mut World, e: Entity, value: f32) -> Result<(), String> {
    let value = value.clamp(0.0, 1.0);
    let kids: Vec<Entity> = w.get::<Children>(e).map(|c| c.iter().collect()).unwrap_or_default();
    let fill = kids.into_iter().find(|k| w.get::<UiProgressFill>(*k).is_some()).ok_or_else(|| format!("{e} is not a progress bar (ui_progress)"))?;
    if let Some(mut n) = w.get_mut::<Node>(fill) {
        n.width = Val::Percent(value * 100.0);
    }
    w.entity_mut(e).insert(UiProgress { value });
    Ok(())
}

// ---------------------------------------------------------------- registration

pub(super) fn register(e: &mut Engine) {
    e.register("ui_panel", |c, a| {
        let w = world(c)?;
        let t = theme_of(w);
        Ok(rent(spawn_node(w, a.first(), "Panel", theme::panel(&t, GAP_M, GAP_S))?))
    });
    e.register("ui_vbox", |c, a| {
        let w = world(c)?;
        Ok(rent(spawn_node(w, a.first(), "VBox", (flex(FlexDirection::Column, GAP_S), Pickable::IGNORE))?))
    });
    e.register("ui_hbox", |c, a| {
        let w = world(c)?;
        Ok(rent(spawn_node(w, a.first(), "HBox", (flex(FlexDirection::Row, GAP_S), Pickable::IGNORE))?))
    });
    e.register("ui_label", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: ui_label(parent, text)".into());
        }
        let t = theme_of(w);
        let text = a[1].to_string();
        Ok(rent(spawn_node(w, a.first(), "Label", (Text::new(text), theme::body(SIZE_BODY), TextColor(t.text), Pickable::IGNORE))?))
    });
    e.register("ui_button", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: ui_button(parent, text)".into());
        }
        let t = theme_of(w);
        let look = UiButton::themed(&t);
        let node = Node {
            padding: UiRect::axes(Val::Px(GAP_M), Val::Px(GAP_S)),
            justify_content: JustifyContent::Center,
            align_items: AlignItems::Center,
            border_radius: BorderRadius::all(Val::Px(RADIUS)),
            ..default()
        };
        let e = spawn_node(w, a.first(), "Button", (node, BackgroundColor(look.idle), Button, Hovered::default(), super::ui_widgets::UiFocusable, look))?;
        let text = a[1].to_string();
        w.spawn((Name::new("Label"), Text::new(text), theme::label(SIZE_BODY), TextColor(t.text), Pickable::IGNORE, ChildOf(e)));
        Ok(rent(e))
    });
    e.register("ui_progress", |c, a| {
        let w = world(c)?;
        if a.len() != 2 {
            return Err("usage: ui_progress(parent, value)".into());
        }
        let t = theme_of(w);
        let node = Node {
            width: Val::Px(200.0),
            height: Val::Px(GAP_M - GAP_XS),
            border_radius: BorderRadius::all(Val::Px(RADIUS)),
            overflow: Overflow::clip(),
            ..default()
        };
        let e = spawn_node(w, a.first(), "Progress", (node, BackgroundColor(t.raised), UiProgress::default(), Pickable::IGNORE))?;
        let fill = Node { height: Val::Percent(100.0), ..default() };
        w.spawn((Name::new("Fill"), fill, BackgroundColor(t.accent), UiProgressFill, Pickable::IGNORE, ChildOf(e)));
        set_fill(w, e, f(&a[1], "value")?)?;
        Ok(rent(e))
    });

    e.register("set_text", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_text([node,] text)")?;
        if super::ui_widgets::set_line_edit_text(w, t, r[0].to_string()) {
            return Ok(RV::Void);
        }
        let te = need_text(w, t)?;
        let new = r[0].to_string();
        if let Some(mut x) = w.get_mut::<Text>(te)
            && x.0 != new
        {
            x.0 = new;
        }
        Ok(RV::Void)
    });
    e.register("get_text", |c, a| {
        let w = world(c)?;
        let (t, _) = split(w, a, 0, "get_text([node])")?;
        if let Some(text) = super::ui_widgets::line_edit_text(w, t) {
            return Ok(RV::Str(text));
        }
        let te = need_text(w, t)?;
        Ok(RV::Str(w.get::<Text>(te).map(|x| x.0.clone()).unwrap_or_default()))
    });
    e.register("set_font_size", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_font_size([node,] px)")?;
        let te = need_text(w, t)?;
        let px = f(&r[0], "px")?;
        if let Some(mut tf) = w.get_mut::<TextFont>(te) {
            tf.font_size = bevy::text::FontSize::Rem(px / REM_PX);
        }
        Ok(RV::Void)
    });
    e.register("set_text_color", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_text_color([node,] color)")?;
        let te = need_text(w, t)?;
        let col = color(&r[0], "color")?;
        w.entity_mut(te).insert(TextColor(col));
        // A button restores its label colour from `UiButton`: keep them in step.
        if let Some(mut bt) = w.get_mut::<UiButton>(t) {
            bt.text = col;
        }
        Ok(RV::Void)
    });
    e.register("set_disabled", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_disabled([node,] bool)")?;
        if b(&r[0], "disabled")? {
            w.entity_mut(t).insert(InteractionDisabled);
        } else {
            w.entity_mut(t).remove::<InteractionDisabled>();
        }
        Ok(RV::Void)
    });
    e.register("set_progress", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "set_progress([node,] value)")?;
        set_fill(w, t, f(&r[0], "value")?)?;
        Ok(RV::Void)
    });
    e.register("ui_set", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 2, "ui_set([node,] prop, value)")?;
        ui_set(w, t, s(&r[0], "prop")?, &r[1])?;
        Ok(RV::Void)
    });
}
