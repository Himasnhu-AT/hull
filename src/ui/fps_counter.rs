//! Small FPS counter in the top-right corner, shown while `CoreSettings.show_fps` is on.
//! Owner: ui stream.

use bevy::prelude::*;

use super::theme::*;
use crate::settings::CoreSettings;

#[derive(Component)]
pub struct FpsCounter;

pub(crate) struct FpsCounterPlugin;

impl Plugin for FpsCounterPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, (spawn_counter, update_counter).chain().run_if(super::ui_visible));
    }
}

fn spawn_counter(mut commands: Commands, q: Query<(), With<FpsCounter>>, mut done: Local<bool>) {
    if *done || !q.is_empty() {
        return;
    }
    *done = true;
    commands.spawn((
        FpsCounter,
        Name::new("FPS counter"),
        text("", body_bold(SIZE_TINY), Color::NONE),
        Node {
            position_type: PositionType::Absolute,
            right: px(12),
            top: px(10),
            padding: UiRect::axes(px(8), px(2)),
            border_radius: BorderRadius::all(px(3)),
            display: Display::None,
            ..default()
        },
        BackgroundColor(Color::srgba(0.03, 0.04, 0.06, 0.6)),
        GlobalZIndex(30),
    ));
}

/// Colour band for a frame rate: good ≥ 55, accent ≥ 30, else bad.
pub fn fps_color(t: &Theme, fps: f32) -> Color {
    if fps >= 55.0 {
        t.good
    } else if fps >= 30.0 {
        t.accent
    } else {
        t.bad
    }
}

/// Smoothed over ~0.5 s of real time, refreshed 4× a second.
fn update_counter(
    settings: Option<Res<CoreSettings>>,
    theme: Res<Theme>,
    time: Res<Time<Real>>,
    mut q: Query<(&mut Text, &mut Node, &mut TextColor), With<FpsCounter>>,
    mut acc: Local<(f32, u32, f32)>,
) {
    let show = settings.is_some_and(|s| s.show_fps);
    for (mut t, mut node, mut color) in &mut q {
        let want = if show { Display::Flex } else { Display::None };
        if node.display != want {
            node.display = want;
        }
        if !show {
            continue;
        }
        acc.0 += time.delta_secs();
        acc.1 += 1;
        if acc.0 >= 0.25 {
            let fps = acc.1 as f32 / acc.0;
            let smooth = if acc.2 == 0.0 { fps } else { acc.2 * 0.5 + fps * 0.5 };
            *acc = (0.0, 0, smooth);
            t.0 = format!("{smooth:.0} FPS");
            color.0 = fps_color(&theme, smooth);
        }
    }
}
