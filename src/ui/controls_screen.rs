//! The "controls" screen (feature `actions`): every rebindable action with its keyboard/mouse
//! and gamepad binding, press-to-bind, conflicts, reset. Opened from the "Rebind controls"
//! button on the settings "Controls" tab (a side panel that also lists the current bindings).
//!
//! - Focus a row and press Enter/Space (or click the keyboard cap) to rebind keyboard/mouse;
//!   press A on a gamepad (or click the gamepad cap) to rebind the gamepad binding. The next
//!   input binds (see [`crate::actions::rebind`]); Esc cancels.
//! - A binding another action in the same context also uses is shown in the bad colour with
//!   "Also: <action>".
//! - "Reset all" restores every action's defaults. Changes are saved (settings section
//!   `"input"`).
//! - Footers show gamepad prompts when the gamepad was used last.

use bevy::prelude::*;
use bevy::ui::{RelativeCursorPosition, ScrollPosition};

use super::menus::{MenuAction, MenuEvent};
use super::screens::{RebuildScreen, RegisterScreen, ScreenRegistry, Screens};
use super::settings_screen::RegisterSettingsUi;
use super::theme::*;
use super::tl;
use super::toast::Toast;
use super::widgets::{Focus, Focusable, KeepColor, Look, ScrollList, UiAction, action_button};
use crate::actions::rebind::RebindCapture;
use crate::actions::{ActionMap, ActionState, Device, start_rebind};

/// A focusable row for one action.
#[derive(Component, Clone, Copy, Debug)]
pub struct RebindRow(pub &'static str);

/// A clickable binding cap (device column) inside a row.
#[derive(Component, Clone, Copy, Debug)]
pub struct RebindCap {
    pub action: &'static str,
    pub device: Device,
}

const RESET_ALL: &str = "controls.reset_all";

pub(crate) struct ControlsScreenPlugin;

impl Plugin for ControlsScreenPlugin {
    fn build(&self, app: &mut App) {
        if app.world().get_resource::<ScreenRegistry>().is_none_or(|r| r.get("controls").is_none()) {
            app.register_screen("controls", build);
        }
        let has_panel = app.world().get_resource::<super::settings_screen::SettingsPanels>().is_some_and(|p| p.0.iter().any(|(t, _)| *t == "Controls"));
        if !has_panel {
            app.settings_panel("Controls", controls_panel);
        }
        app.add_systems(Update, (start_from_ui, reset_all, refresh).chain().in_set(super::UiSet::Screens));
    }
}

/// Key hints for footers: gamepad names when the gamepad was used last.
pub fn hints<'a>(world: &World, kbm: &[(&'a str, &'a str)], pad: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    let gp = world.get_resource::<ActionState>().is_some_and(|s| s.last_device == Device::Gamepad);
    if gp { pad.to_vec() } else { kbm.to_vec() }
}

fn row_look(t: &Theme) -> Look {
    Look::new(
        [t.panel.with_alpha(0.72), t.raised.with_alpha(0.92), Color::NONE],
        [Color::NONE, t.accent.with_alpha(0.35), Color::NONE],
        [t.text, t.text, t.text],
    )
}

fn cap_look(t: &Theme, conflict: bool) -> Look {
    let text = if conflict { t.bad } else { t.text };
    Look::new(
        [Color::srgba(1.0, 1.0, 1.0, 0.04), Color::srgba(1.0, 1.0, 1.0, 0.10), t.accent.with_alpha(0.92)],
        [if conflict { t.bad } else { t.line_strong }, t.accent, t.accent],
        [text, text, t.on_accent],
    )
}

/// Built-in "controls" screen.
pub fn build(world: &mut World, root: Entity) {
    let t = world.resource::<Theme>().clone();
    let Some(map) = world.get_resource::<ActionMap>().cloned() else { return };
    let capture = world.get_resource::<RebindCapture>().cloned().unwrap_or_default();
    let in_game = world.get_resource::<State<crate::flow::AppState>>().is_some_and(|s| *s.get() == crate::flow::AppState::InGame);
    let footer = hints(
        world,
        &[("W / S", "Select"), ("Enter", "Rebind keyboard"), ("Esc", "Back")],
        &[("D-pad", "Select"), ("A", "Rebind gamepad"), ("B", "Back")],
    );
    let rows: Vec<_> = map.iter().filter(|a| a.def.rebindable).collect();
    world.commands().entity(root).with_children(|p| {
        menu_backdrop(p, &t, if in_game { 0.80 } else { 0.62 }, 0.9);
        p.spawn((
            Node { position_type: PositionType::Absolute, left: px(EDGE), top: px(84), flex_direction: FlexDirection::Column, row_gap: px(GAP_M), ..default() },
            Pickable::IGNORE,
        ))
        .with_children(|col| {
            col.spawn(eyebrow(&tl("Settings"), t.accent));
            col.spawn(title(&tl("Controls"), SIZE_H1, t.text));
            col.spawn((Node { width: px(1100), column_gap: px(GAP_M), padding: UiRect::horizontal(px(22)), ..default() }, Pickable::IGNORE))
                .with_children(|h| {
                    h.spawn((text(tl("Action").to_uppercase(), label(SIZE_LABEL), t.text_muted), Node { width: px(400), ..default() }));
                    h.spawn((text(tl("Keyboard / mouse").to_uppercase(), label(SIZE_LABEL), t.text_muted), Node { width: px(300), ..default() }));
                    h.spawn((text(tl("Gamepad").to_uppercase(), label(SIZE_LABEL), t.text_muted), Node { width: px(300), ..default() }));
                });
            col.spawn((
                ScrollList,
                ScrollPosition::default(),
                RelativeCursorPosition::default(),
                Node { width: px(1100), max_height: px(560), flex_direction: FlexDirection::Column, row_gap: px(6), overflow: Overflow::scroll_y(), ..default() },
            ))
            .with_children(|list| {
                let mut group = "";
                for (i, a) in rows.iter().enumerate() {
                    if a.def.group != group && !a.def.group.is_empty() {
                        group = a.def.group;
                        list.spawn((text(tl(group).to_uppercase(), label(SIZE_LABEL), t.accent), Node { margin: UiRect::new(px(4), px(0), px(GAP_S), px(2)), ..default() }));
                    }
                    let waiting = capture.action == Some(a.def.name);
                    list.spawn((
                        Button,
                        RebindRow(a.def.name),
                        Focusable { order: i as u32 + 1 },
                        row_look(&t),
                        Node {
                            width: percent(100),
                            min_height: px(60),
                            padding: UiRect::axes(px(22), px(8)),
                            align_items: AlignItems::Center,
                            column_gap: px(GAP_M),
                            border: UiRect::left(px(3)),
                            border_radius: BorderRadius::all(px(3)),
                            flex_shrink: 0.0,
                            ..default()
                        },
                        BackgroundColor(Color::NONE),
                        BorderColor::all(Color::NONE),
                    ))
                    .with_children(|row| {
                        row.spawn((Node { width: px(400), flex_direction: FlexDirection::Column, ..default() }, Pickable::IGNORE)).with_children(|l| {
                            l.spawn(text(tl(a.def.display_label()), body_bold(SIZE_BODY), t.text));
                            if waiting {
                                let msg = tl(capture.prompt(a.def.kind));
                                l.spawn((text(format!("{msg}\u{2026} ({})", tl("Esc cancels")), body(SIZE_TINY), t.accent), KeepColor));
                            }
                        });
                        for dev in [Device::KeyboardMouse, Device::Gamepad] {
                            let b = a.def.bindings.iter().find(|b| b.device() == dev);
                            let conflicts = b.map(|b| map.conflicts(a.def.name, b)).unwrap_or_default();
                            let label_s = match b {
                                _ if waiting && capture.device == dev => "\u{2026}".to_string(),
                                Some(b) => b.label(),
                                None => "\u{2014}".into(),
                            };
                            row.spawn((Node { width: px(300), flex_direction: FlexDirection::Column, row_gap: px(2), ..default() }, Pickable::IGNORE)).with_children(|c| {
                                c.spawn((
                                    Button,
                                    RebindCap { action: a.def.name, device: dev },
                                    cap_look(&t, !conflicts.is_empty()),
                                    Node {
                                        min_width: px(120),
                                        align_self: AlignSelf::FlexStart,
                                        padding: UiRect::axes(px(14), px(6)),
                                        border: UiRect::all(px(1)),
                                        border_radius: BorderRadius::all(px(RADIUS)),
                                        justify_content: JustifyContent::Center,
                                        ..default()
                                    },
                                    BackgroundColor(Color::NONE),
                                    BorderColor::all(t.line_strong),
                                    children![text(label_s, label(22.0), t.text)],
                                ));
                                if !conflicts.is_empty() {
                                    let names: Vec<String> = conflicts.iter().map(|n| map.get(n).map_or(n.to_string(), |x| tl(x.def.display_label()).into_owned())).collect();
                                    c.spawn((text(format!("{} {}", tl("Also:"), names.join(", ")), body(SIZE_TINY), t.bad), KeepColor));
                                }
                            });
                        }
                    });
                }
            });
            col.spawn((Node { column_gap: px(GAP_M), margin: UiRect::top(px(GAP_L)), ..default() }, Pickable::IGNORE)).with_children(|b| {
                let n = rows.len() as u32;
                action_button(b, &t, &tl("Back"), UiAction::Back, Some(n + 1), false, 180.0);
                action_button(b, &t, &tl("Reset all"), MenuAction::Custom(RESET_ALL), Some(n + 2), false, 200.0);
            });
        });
        spawn_footer(p, &t, &footer);
    });
}

/// Settings "Controls" tab side panel: the current bindings + a "Rebind controls" button.
pub fn controls_panel(world: &mut World, slot: Entity) {
    let t = world.resource::<Theme>().clone();
    let Some(map) = world.get_resource::<ActionMap>().cloned() else { return };
    let dev = world.get_resource::<ActionState>().map_or(Device::KeyboardMouse, |s| s.last_device);
    world.commands().entity(slot).with_children(|s| {
        s.spawn(panel(&t, 22.0, GAP_S)).with_children(|card| {
            card.spawn(eyebrow(&tl(if dev == Device::Gamepad { "Gamepad" } else { "Key bindings" }), t.text_muted));
            for a in map.iter().filter(|a| a.def.rebindable) {
                card.spawn((Node { justify_content: JustifyContent::SpaceBetween, column_gap: px(GAP_M), padding: UiRect::vertical(px(3)), ..default() }, Pickable::IGNORE))
                    .with_children(|r| {
                        r.spawn(text(tl(a.def.display_label()), body(SIZE_SMALL + 1.0), t.text_muted));
                        r.spawn(text(map.prompt(a.def.name, dev), body_bold(SIZE_SMALL + 1.0), t.text));
                    });
            }
            card.spawn(spacer(GAP_S));
            action_button(card, &t, &tl("Rebind controls"), MenuAction::Open("controls"), None, true, 300.0);
        });
    });
}

/// Enter/Space/A on a focused row, or a click on a row / cap, starts press-to-bind.
fn start_from_ui(world: &mut World) {
    let screens_top = world.get_resource::<Screens>().and_then(Screens::top);
    if screens_top != Some("controls") || world.get_resource::<RebindCapture>().is_some_and(RebindCapture::is_capturing) {
        return;
    }
    let mut target: Option<(&'static str, Device)> = None;
    let mut caps = world.query::<(&Interaction, &RebindCap)>();
    for (i, c) in caps.iter(world) {
        if *i == Interaction::Pressed {
            target = Some((c.action, c.device));
        }
    }
    if target.is_none() {
        let accept = world.get_resource::<ActionState>().and_then(|s| s.get("ui.accept").copied());
        let focus = world.get_resource::<Focus>().and_then(|f| f.0);
        if let (Some(a), Some(f)) = (accept, focus)
            && a.just_pressed
            && let Some(row) = world.get::<RebindRow>(f)
        {
            target = Some((row.0, a.device));
        }
    }
    if target.is_none() {
        let mut rows = world.query::<(&Interaction, &RebindRow)>();
        // A click on the row outside the caps rebinds keyboard/mouse.
        target = rows.iter(world).find(|(i, _)| **i == Interaction::Pressed).map(|(_, r)| (r.0, Device::KeyboardMouse));
        if target.is_some() && !world.get_resource::<ButtonInput<MouseButton>>().is_some_and(|m| m.just_pressed(MouseButton::Left)) {
            target = None;
        }
    }
    if let Some((action, dev)) = target
        && let Err(e) = start_rebind(world, action, dev)
    {
        world.write_message(Toast::new(e));
    }
}

fn reset_all(mut events: MessageReader<MenuEvent>, map: Option<ResMut<ActionMap>>, mut toasts: MessageWriter<Toast>) {
    if events.read().any(|e| e.0 == RESET_ALL)
        && let Some(mut map) = map
    {
        map.reset_all();
        toasts.write(Toast::new(tl("Controls reset to defaults").into_owned()));
    }
}

/// Rebuild the open screen when bindings / capture / the active device change.
fn refresh(
    screens: Res<Screens>,
    map: Option<Res<ActionMap>>,
    capture: Option<Res<RebindCapture>>,
    state: Option<Res<ActionState>>,
    mut last_dev: Local<Device>,
    mut out: MessageWriter<RebuildScreen>,
) {
    let dev = state.map_or(Device::KeyboardMouse, |s| s.last_device);
    let dev_changed = dev != *last_dev;
    *last_dev = dev;
    let Some(top) = screens.top() else { return };
    let changed = map.is_some_and(|m| m.is_changed() && !m.is_added()) || capture.is_some_and(|c| c.is_changed() && !c.is_added());
    if (top == "controls" && changed) || (dev_changed && matches!(top, "controls" | "main" | "pause" | "settings")) {
        out.write(RebuildScreen);
    }
}
