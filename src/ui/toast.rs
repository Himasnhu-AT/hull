//! Toasts: small notifications stacked top-right that slide in and fade out. Owner: ui stream.
//!
//! ```ignore
//! commands.write_message(Toast::new("Achievement unlocked").body("First blood").color(theme.good));
//! ```
//! They run on real time (keep fading while paused) and sit above screens. At most
//! [`MAX_TOASTS`] are shown; the oldest goes first.

use bevy::prelude::*;

use super::theme::*;

#[derive(Message, Clone, Debug)]
pub struct Toast {
    pub title: String,
    pub body: String,
    /// Edge colour; `None` = theme accent.
    pub color: Option<Color>,
    /// How long it stays (seconds, including the fade).
    pub secs: f32,
}

impl Toast {
    pub fn new(title: impl Into<String>) -> Self {
        Toast { title: title.into(), body: String::new(), color: None, secs: 3.0 }
    }
    pub fn body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into();
        self
    }
    pub fn color(mut self, c: Color) -> Self {
        self.color = Some(c);
        self
    }
    pub fn secs(mut self, s: f32) -> Self {
        self.secs = s.max(0.5);
        self
    }
}

pub const MAX_TOASTS: usize = 4;
const FADE_IN: f32 = 0.18;
const FADE_OUT: f32 = 0.4;
const SLIDE: f32 = 28.0;

#[derive(Component)]
struct ToastStack;

#[derive(Component)]
struct ToastCard {
    age: f32,
    life: f32,
    bg: Color,
    edge: Color,
}

/// Base colour of a toast's text, faded with the card.
#[derive(Component)]
struct ToastText(Color);

pub(crate) struct ToastPlugin;

impl Plugin for ToastPlugin {
    fn build(&self, app: &mut App) {
        app.add_message::<Toast>().add_systems(Update, (spawn_toasts, age_toasts).chain().run_if(super::ui_visible));
    }
}

/// Opacity and slide offset (0..1) at `age` for a toast living `life` seconds.
pub fn toast_alpha(age: f32, life: f32) -> (f32, f32) {
    let fin = (age / FADE_IN).clamp(0.0, 1.0);
    let fout = ((life - age) / FADE_OUT).clamp(0.0, 1.0);
    let ease = |x: f32| x * x * (3.0 - 2.0 * x);
    (ease(fin.min(fout)), 1.0 - ease(fin))
}

fn spawn_toasts(
    mut commands: Commands,
    mut msgs: MessageReader<Toast>,
    theme: Res<Theme>,
    stacks: Query<Entity, With<ToastStack>>,
    cards: Query<(Entity, &ToastCard)>,
) {
    let new: Vec<Toast> = msgs.read().cloned().collect();
    if new.is_empty() {
        return;
    }
    let stack = stacks.iter().next().unwrap_or_else(|| {
        commands
            .spawn((
                ToastStack,
                Name::new("Toasts"),
                Node {
                    position_type: PositionType::Absolute,
                    top: px(48),
                    right: px(16),
                    flex_direction: FlexDirection::Column,
                    align_items: AlignItems::FlexEnd,
                    row_gap: px(GAP_S),
                    ..default()
                },
                GlobalZIndex(40),
                Pickable::IGNORE,
            ))
            .id()
    });
    // Drop the oldest so at most MAX_TOASTS remain.
    let mut live: Vec<(Entity, f32)> = cards.iter().map(|(e, c)| (e, c.age)).collect();
    live.sort_by(|a, b| b.1.total_cmp(&a.1));
    let excess = (live.len() + new.len()).saturating_sub(MAX_TOASTS);
    for (e, _) in live.iter().take(excess) {
        commands.entity(*e).despawn();
    }
    let t = &*theme;
    for toast in new.into_iter().rev().take(MAX_TOASTS).rev() {
        let edge = toast.color.unwrap_or(t.accent);
        let bg = t.panel.with_alpha(0.96);
        commands.entity(stack).with_children(|s| {
            s.spawn((
                ToastCard { age: 0.0, life: toast.secs, bg, edge },
                Node {
                    width: px(340),
                    flex_direction: FlexDirection::Column,
                    row_gap: px(2),
                    padding: UiRect::new(px(18), px(18), px(12), px(12)),
                    border: UiRect::left(px(3)),
                    border_radius: BorderRadius::all(px(RADIUS)),
                    left: px(SLIDE),
                    ..default()
                },
                BackgroundColor(bg.with_alpha(0.0)),
                BorderColor::all(edge.with_alpha(0.0)),
                Pickable::IGNORE,
            ))
            .with_children(|c| {
                c.spawn((ToastText(t.text), text(toast.title.to_uppercase(), label(21.0), Color::NONE)));
                if !toast.body.is_empty() {
                    c.spawn((ToastText(t.text_muted), text(toast.body.clone(), body(SIZE_SMALL), Color::NONE)));
                }
            });
        });
    }
}

fn age_toasts(
    mut commands: Commands,
    time: Res<Time<Real>>,
    mut cards: Query<(Entity, &mut ToastCard, &mut Node, &mut BackgroundColor, &mut BorderColor, &Children)>,
    mut texts: Query<(&ToastText, &mut TextColor)>,
) {
    let dt = time.delta_secs();
    for (e, mut card, mut node, mut bg, mut border, kids) in &mut cards {
        card.age += dt;
        if card.age >= card.life {
            commands.entity(e).despawn();
            continue;
        }
        let (a, slide) = toast_alpha(card.age, card.life);
        node.left = px(slide * SLIDE);
        bg.0 = card.bg.with_alpha(card.bg.alpha() * a);
        *border = BorderColor::all(card.edge.with_alpha(a));
        for k in kids.iter() {
            if let Ok((base, mut c)) = texts.get_mut(k) {
                c.0 = base.0.with_alpha(base.0.alpha() * a);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fades_in_and_out() {
        assert_eq!(toast_alpha(0.0, 3.0).0, 0.0);
        assert_eq!(toast_alpha(1.0, 3.0), (1.0, 0.0));
        assert!(toast_alpha(2.9, 3.0).0 < 0.5);
        assert_eq!(toast_alpha(3.0, 3.0).0, 0.0);
        assert!(toast_alpha(0.05, 3.0).1 > 0.5, "starts offset, slides in");
    }
}
