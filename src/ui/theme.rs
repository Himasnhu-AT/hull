//! Palette, type scale, spacing, fonts. Owner: ui stream.

use bevy::prelude::*;

/// Re-brandable look. Defaults = Shroud's dark tactical theme (orange accent).
#[derive(Resource, Clone, Debug)]
pub struct Theme {
    pub bg: Color,
    pub panel: Color,
    pub raised: Color,
    pub line: Color,
    pub text: Color,
    pub text_muted: Color,
    pub text_dim: Color,
    pub accent: Color,
    pub good: Color,
    pub bad: Color,
    pub info: Color,
}

impl Default for Theme {
    fn default() -> Self {
        Theme {
            bg: Color::srgb(0.035, 0.043, 0.06),
            panel: Color::srgba(0.07, 0.085, 0.11, 0.88),
            raised: Color::srgba(0.13, 0.15, 0.19, 0.95),
            line: Color::srgba(1.0, 1.0, 1.0, 0.09),
            text: Color::srgb(0.93, 0.945, 0.965),
            text_muted: Color::srgb(0.58, 0.62, 0.69),
            text_dim: Color::srgb(0.38, 0.42, 0.49),
            accent: Color::srgb(1.0, 0.66, 0.22),
            good: Color::srgb(0.38, 0.9, 0.72),
            bad: Color::srgb(1.0, 0.36, 0.3),
            info: Color::srgb(0.5, 0.78, 1.0),
        }
    }
}
