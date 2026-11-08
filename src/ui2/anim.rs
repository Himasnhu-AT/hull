//! Small eased animations (no tween crate): focus scale + glow on tiles, staggered entrances and
//! page slides. Durations come from [`Tokens::motion`](super::tokens::Motion). Everything runs on
//! real time, so menus still animate while the game is paused.
//!
//! Group opacity does not exist in bevy_ui, so fades use a *veil*: a child node painted in the
//! background colour whose alpha goes 1 → 0 (enter) over the element.

use bevy::prelude::*;
use bevy::ui::{UiTransform, Val2};

use super::focus::Ui2Focus;
use super::tokens::Tokens;
use super::Ui2Set;

pub fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

pub fn ease_in_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 { 4.0 * t * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(3) / 2.0 }
}

/// Focus feedback of a tile: `focus` eases 0..1 toward "is focused".
#[derive(Component, Clone, Debug)]
pub struct TileFx {
    pub focus: f32,
    pub accent: Color,
}

/// Staggered entrance: waits `delay`, then rises `rise` px while its [`Veil`] fades out.
#[derive(Component, Clone, Debug)]
pub struct Enter {
    pub delay: f32,
    pub t: f32,
    pub dur: f32,
    pub rise: f32,
}

/// Fade cover painted in `BackgroundColor` (its alpha is animated).
#[derive(Component, Clone, Debug, Default)]
pub struct Veil;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PageDir {
    In,
    Out,
}

/// A screen root sliding in or out. `Out` roots despawn when done.
#[derive(Component, Clone, Debug)]
pub struct PageAnim {
    pub t: f32,
    pub dur: f32,
    pub dir: PageDir,
    /// Slide distance in percent of the width (sign = direction of travel when entering).
    pub slide: f32,
}

pub struct AnimPlugin;

impl Plugin for AnimPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, (tile_fx, enter_only, page_anim).in_set(Ui2Set::Paint));
    }
}

fn set_veil(kids: Option<&Children>, veils: &mut Query<&mut BackgroundColor, With<Veil>>, alpha: f32) {
    for k in kids.into_iter().flatten() {
        if let Ok(mut bg) = veils.get_mut(*k) {
            let c = bg.0.with_alpha(alpha);
            if bg.0 != c {
                bg.0 = c;
            }
        }
    }
}

#[allow(clippy::type_complexity)]
fn tile_fx(
    time: Res<Time<Real>>,
    focus: Res<Ui2Focus>,
    tk: Res<Tokens>,
    mut q: Query<(Entity, &mut TileFx, Option<&mut Enter>, &mut UiTransform, &mut Outline, &mut BoxShadow, &mut ZIndex, Option<&Children>)>,
    mut veils: Query<&mut BackgroundColor, With<Veil>>,
    mut commands: Commands,
) {
    let dt = time.delta_secs();
    let tau = (tk.motion.focus / 3.0).max(0.001);
    let k = 1.0 - (-dt / tau).exp();
    for (e, mut fx, enter, mut tf, mut ring, mut shadow, mut z, kids) in &mut q {
        let target = if focus.0 == Some(e) { 1.0 } else { 0.0 };
        fx.focus += (target - fx.focus) * k;
        if (fx.focus - target).abs() < 0.002 {
            fx.focus = target;
        }
        let f = fx.focus;
        let mut dy;
        let veil;
        if let Some(mut en) = enter {
            if en.delay > 0.0 {
                en.delay -= dt;
                dy = en.rise;
                veil = 1.0;
            } else {
                en.t += dt;
                let p = ease_out_cubic(en.t / en.dur.max(0.001));
                dy = en.rise * (1.0 - p);
                veil = 1.0 - p;
            }
            if en.t >= en.dur {
                commands.entity(e).remove::<Enter>();
                dy = 0.0;
            }
            set_veil(kids, &mut veils, if en.t >= en.dur { 0.0 } else { veil });
        } else {
            dy = 0.0;
        }
        let s = 1.0 + (tk.motion.focus_scale - 1.0) * f;
        tf.scale = Vec2::splat(s);
        tf.translation = Val2::new(Val::Px(0.0), Val::Px(dy));
        let want_z = ZIndex(if f > 0.01 { 5 } else { 0 });
        if *z != want_z {
            *z = want_z;
        }
        ring.width = Val::Px(3.0 * f.min(1.0));
        ring.offset = Val::Px(3.0);
        ring.color = tk.colors.text.color().with_alpha(f);
        let card = tk.shadow.card;
        let glow = tk.shadow.glow;
        let mk = |c: Color, blur: f32, spread: f32, dy: f32| ShadowStyle { color: c, x_offset: Val::Px(0.0), y_offset: Val::Px(dy), spread_radius: Val::Px(spread), blur_radius: Val::Px(blur) };
        shadow.0 = vec![
            mk(card.color.color(), card.blur, card.spread, card.dy),
            mk(fx.accent.with_alpha(glow.color.3 * f), glow.blur * (0.6 + 0.4 * f), glow.spread * f, glow.dy),
        ];
    }
}

fn enter_only(
    time: Res<Time<Real>>,
    mut q: Query<(Entity, &mut Enter, &mut UiTransform, Option<&Children>), Without<TileFx>>,
    mut veils: Query<&mut BackgroundColor, With<Veil>>,
    mut commands: Commands,
) {
    let dt = time.delta_secs();
    for (e, mut en, mut tf, kids) in &mut q {
        let (dy, veil);
        if en.delay > 0.0 {
            en.delay -= dt;
            dy = en.rise;
            veil = 1.0;
        } else {
            en.t += dt;
            let p = ease_out_cubic(en.t / en.dur.max(0.001));
            dy = en.rise * (1.0 - p);
            veil = 1.0 - p;
            if en.t >= en.dur {
                commands.entity(e).remove::<Enter>();
            }
        }
        tf.translation = Val2::new(Val::Px(0.0), Val::Px(if en.t >= en.dur { 0.0 } else { dy }));
        set_veil(kids, &mut veils, if en.t >= en.dur { 0.0 } else { veil });
    }
}

fn page_anim(
    time: Res<Time<Real>>,
    mut q: Query<(Entity, &mut PageAnim, &mut UiTransform, Option<&Children>)>,
    mut veils: Query<&mut BackgroundColor, With<Veil>>,
    mut commands: Commands,
) {
    let dt = time.delta_secs();
    for (e, mut a, mut tf, kids) in &mut q {
        a.t += dt;
        let p = ease_in_out(a.t / a.dur.max(0.001));
        let (x, veil) = match a.dir {
            PageDir::In => (a.slide * (1.0 - p), 1.0 - p),
            PageDir::Out => (-a.slide * 0.4 * p, p),
        };
        tf.translation = Val2::new(Val::Percent(x), Val::Px(0.0));
        set_veil(kids, &mut veils, veil);
        if a.t >= a.dur {
            match a.dir {
                PageDir::In => {
                    tf.translation = Val2::ZERO;
                    set_veil(kids, &mut veils, 0.0);
                    commands.entity(e).remove::<PageAnim>();
                }
                PageDir::Out => commands.entity(e).despawn(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn easing_hits_its_endpoints_and_is_monotonic() {
        for f in [ease_out_cubic, ease_in_out] {
            assert_eq!(f(0.0), 0.0);
            assert!((f(1.0) - 1.0).abs() < 1e-6);
            let mut last = 0.0;
            for i in 1..=20 {
                let v = f(i as f32 / 20.0);
                assert!(v >= last);
                last = v;
            }
        }
    }
}
