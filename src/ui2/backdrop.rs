//! Screen backdrops. A blurred copy of the game view needs a render-graph pass; the cheap, robust
//! version is a flat dim plus a vertical gradient over the live scene, which reads as depth of
//! field without a second render. `Backdrop::Image` is for static art.

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

use super::tokens::Tokens;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum Backdrop {
    /// Nothing: the game view shows through.
    None,
    /// Flat dim of the given alpha.
    Dim(f32),
    /// Dim plus a vertical gradient from `bg` (top, alpha `top`) to `bg` (bottom, alpha `bottom`)
    /// and a soft accent glow from the top-left.
    #[default]
    Gradient,
    Image(String),
}

pub fn spawn(w: &mut World, root: Entity, t: &Tokens, b: &Backdrop) {
    let bg = t.colors.bg.color();
    let fill = || Node { position_type: PositionType::Absolute, left: px(0), right: px(0), top: px(0), bottom: px(0), ..default() };
    match b {
        Backdrop::None => {}
        Backdrop::Dim(a) => {
            w.spawn((Name::new("Backdrop"), fill(), BackgroundColor(bg.with_alpha(*a)), Pickable::IGNORE, ChildOf(root)));
        }
        Backdrop::Gradient => {
            w.spawn((Name::new("Backdrop"), fill(), BackgroundColor(bg.with_alpha(0.55)), Pickable::IGNORE, ChildOf(root)));
            w.spawn((
                Name::new("BackdropFade"),
                fill(),
                BackgroundGradient::from(LinearGradient::new(
                    std::f32::consts::PI,
                    vec![ColorStop::new(bg.with_alpha(0.55), percent(0)), ColorStop::new(bg.with_alpha(0.15), percent(45)), ColorStop::new(bg.with_alpha(0.85), percent(100))],
                )),
                Pickable::IGNORE,
                ChildOf(root),
            ));
            // Glow: a soft accent radial from the top-left corner.
            let glow = t.colors.accent.color();
            w.spawn((
                Name::new("BackdropGlow"),
                fill(),
                BackgroundGradient::from(RadialGradient::new(
                    UiPosition::TOP_LEFT,
                    RadialGradientShape::Circle(px(1100)),
                    vec![ColorStop::new(glow.with_alpha(0.20), percent(0)), ColorStop::new(glow.with_alpha(0.06), percent(45)), ColorStop::new(glow.with_alpha(0.0), percent(100))],
                )),
                Pickable::IGNORE,
                ChildOf(root),
            ));
        }
        Backdrop::Image(path) => {
            let img: Handle<Image> = w.get_resource::<AssetServer>().map(|a| a.load(path.clone())).unwrap_or_default();
            w.spawn((Name::new("Backdrop"), fill(), ImageNode::new(img), Pickable::IGNORE, ChildOf(root)));
            w.spawn((Name::new("BackdropDim"), fill(), BackgroundColor(bg.with_alpha(0.5)), Pickable::IGNORE, ChildOf(root)));
        }
    }
}
