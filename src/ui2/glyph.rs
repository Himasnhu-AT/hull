//! Input glyphs: a key cap (keyboard) or round button (gamepad) showing the binding of an action
//! for the device the player used last. Unknown actions fall back to the given labels, so a
//! screen can say `("tab_next", "E", "RB")` before the game defines that action.

use bevy::prelude::*;

use super::tokens::Tokens;
use super::Ui2Set;
use crate::actions::{ActionMap, ActionState, Device};

#[derive(Component, Clone, Debug)]
pub struct Glyph {
    pub action: String,
    pub kb: String,
    pub pad: String,
}

pub fn label_for(map: Option<&ActionMap>, g: &Glyph, dev: Device) -> String {
    let from_map = map.filter(|m| m.get(&g.action).is_some()).map(|m| m.prompt(&g.action, dev)).filter(|s| s != "\u{2014}");
    from_map.unwrap_or_else(|| if dev == Device::Gamepad { g.pad.clone() } else { g.kb.clone() })
}

/// Spawns a glyph cap under `parent`.
pub fn spawn_cap(w: &mut World, parent: Entity, t: &Tokens, g: Glyph) -> Entity {
    let dev = w.get_resource::<ActionState>().map(|s| s.last_device).unwrap_or_default();
    let label = label_for(w.get_resource::<ActionMap>(), &g, dev);
    let cap = w
        .spawn((
            Name::new("Glyph"),
            Node {
                min_width: px(30),
                height: px(28),
                padding: UiRect::horizontal(px(8)),
                border: UiRect::all(px(1.5)),
                border_radius: BorderRadius::all(px(6)),
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                ..default()
            },
            BackgroundColor(Color::srgba(1.0, 1.0, 1.0, 0.08)),
            BorderColor::all(t.colors.text_muted.color()),
            Pickable::IGNORE,
            g,
            ChildOf(parent),
        ))
        .id();
    w.spawn((
        Name::new("GlyphText"),
        Text::new(label),
        crate::ui::theme::label(t.type_scale.small),
        TextColor(t.colors.text.color()),
        Pickable::IGNORE,
        ChildOf(cap),
    ));
    cap
}

pub struct GlyphPlugin;

impl Plugin for GlyphPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, refresh.in_set(Ui2Set::Paint));
    }
}

fn refresh(
    state: Option<Res<ActionState>>,
    map: Option<Res<ActionMap>>,
    mut last: Local<Option<Device>>,
    new: Query<(), Added<Glyph>>,
    mut caps: Query<(&Glyph, &mut Node, &Children)>,
    mut texts: Query<&mut Text>,
) {
    let dev = state.map(|s| s.last_device).unwrap_or_default();
    let map_changed = map.as_ref().is_some_and(|m| m.is_changed());
    if *last == Some(dev) && new.is_empty() && !map_changed {
        return;
    }
    *last = Some(dev);
    for (g, mut node, kids) in &mut caps {
        let label = label_for(map.as_deref(), g, dev);
        for k in kids {
            if let Ok(mut t) = texts.get_mut(*k)
                && t.0 != label
            {
                t.0 = label.clone();
            }
        }
        let r = if dev == Device::Gamepad { BorderRadius::all(px(14)) } else { BorderRadius::all(px(6)) };
        if node.border_radius != r {
            node.border_radius = r;
        }
    }
}
