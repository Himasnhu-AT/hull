//! Palette, type scale, spacing, fonts and small bundle helpers. Owner: ui stream.
//!
//! - Colours live in the [`Theme`] resource so a game can re-brand (insert its own `Theme`
//!   before or after `UiKitPlugin`; open screens rebuild when it changes). Helpers that need
//!   palette colours take `&Theme`.
//! - Sizes and spacing are module constants in px at the 1080 px reference height; the whole UI
//!   is scaled with [`UiScale`] = viewport height / 1080 × `CoreSettings.ui_scale`.
//! - Fonts (Barlow / Barlow Condensed, OFL) are embedded in the binary and inserted behind fixed
//!   handles, so [`body`], [`label`], … work anywhere with no font files on disk. A game can swap
//!   a face with [`override_font`].

use bevy::asset::uuid_handle;
use bevy::prelude::*;
use bevy::text::Font;
use bevy::ui::IsDefaultUiCamera;
use bevy::window::PrimaryWindow;

use crate::settings::CoreSettings;

// ---- palette ----

/// Re-brandable look. Defaults = Shroud's dark tactical theme (orange accent).
#[derive(Resource, Clone, Debug)]
pub struct Theme {
    /// Near-black used behind menus (scrims).
    pub bg: Color,
    /// Panels and cards.
    pub panel: Color,
    /// Raised surface (hovered card, slider track, toggle off).
    pub raised: Color,
    /// Hairlines and idle borders.
    pub line: Color,
    /// Stronger outline (hovered segments, key caps).
    pub line_strong: Color,
    pub text: Color,
    pub text_muted: Color,
    pub text_dim: Color,
    /// Selection / focus / primary action.
    pub accent: Color,
    /// Text drawn on top of `accent` fills.
    pub on_accent: Color,
    /// Positive (player side, good FPS).
    pub good: Color,
    /// Negative (enemy side, damage, bad FPS).
    pub bad: Color,
    /// Secondary info.
    pub info: Color,
}

impl Default for Theme {
    fn default() -> Self {
        Theme {
            bg: Color::srgb(0.035, 0.043, 0.06),
            panel: Color::srgba(0.07, 0.085, 0.11, 0.88),
            raised: Color::srgba(0.13, 0.15, 0.19, 0.95),
            line: Color::srgba(1.0, 1.0, 1.0, 0.09),
            line_strong: Color::srgba(1.0, 1.0, 1.0, 0.18),
            text: Color::srgb(0.93, 0.945, 0.965),
            text_muted: Color::srgb(0.58, 0.62, 0.69),
            text_dim: Color::srgb(0.38, 0.42, 0.49),
            accent: Color::srgb(1.0, 0.66, 0.22),
            on_accent: Color::srgb(0.035, 0.043, 0.06),
            good: Color::srgb(0.38, 0.9, 0.72),
            bad: Color::srgb(1.0, 0.36, 0.3),
            info: Color::srgb(0.5, 0.78, 1.0),
        }
    }
}

impl Theme {
    /// Same theme with another accent (keeps everything else).
    pub fn with_accent(mut self, accent: Color) -> Self {
        self.accent = accent;
        self
    }
    /// Accent mixed halfway toward white (hover outlines).
    pub fn accent_light(&self) -> Color {
        let a = self.accent.to_srgba();
        Color::srgb(a.red + (1.0 - a.red) * 0.5, a.green + (1.0 - a.green) * 0.5, a.blue + (1.0 - a.blue) * 0.5)
    }
}

pub fn with_alpha(c: Color, a: f32) -> Color {
    c.with_alpha(a)
}

// ---- type scale (px at the 1080 reference height) ----

pub const SIZE_HERO: f32 = 132.0;
pub const SIZE_H1: f32 = 64.0;
pub const SIZE_H2: f32 = 40.0;
pub const SIZE_NAV: f32 = 34.0;
pub const SIZE_LABEL: f32 = 18.0;
pub const SIZE_BODY: f32 = 20.0;
pub const SIZE_SMALL: f32 = 16.0;
pub const SIZE_TINY: f32 = 14.0;

// ---- spacing ----

pub const GAP_XS: f32 = 4.0;
pub const GAP_S: f32 = 8.0;
pub const GAP_M: f32 = 16.0;
pub const GAP_L: f32 = 28.0;
pub const GAP_XL: f32 = 48.0;
/// Distance from the screen edge for menus.
pub const EDGE: f32 = 112.0;
/// Distance of the footer (and bottom-pinned panels) from the bottom edge.
pub const FOOTER_BOTTOM: f32 = 44.0;
pub const RADIUS: f32 = 4.0;

// ---- fonts ----

/// Barlow Medium: body copy.
pub const FONT_BODY: Handle<Font> = uuid_handle!("5c2a3a90-6a77-4a8e-9f3e-2d1b8c4b0a01");
/// Barlow SemiBold: emphasised body, values.
pub const FONT_BODY_BOLD: Handle<Font> = uuid_handle!("5c2a3a90-6a77-4a8e-9f3e-2d1b8c4b0a02");
/// Barlow Condensed SemiBold: labels, nav, buttons (usually upper case).
pub const FONT_LABEL: Handle<Font> = uuid_handle!("5c2a3a90-6a77-4a8e-9f3e-2d1b8c4b0a03");
/// Barlow Condensed Bold: titles and big numbers.
pub const FONT_DISPLAY: Handle<Font> = uuid_handle!("5c2a3a90-6a77-4a8e-9f3e-2d1b8c4b0a04");

/// Which face [`override_font`] replaces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FontRole {
    Body,
    BodyBold,
    Label,
    Display,
}

impl FontRole {
    pub fn handle(self) -> Handle<Font> {
        match self {
            FontRole::Body => FONT_BODY,
            FontRole::BodyBold => FONT_BODY_BOLD,
            FontRole::Label => FONT_LABEL,
            FontRole::Display => FONT_DISPLAY,
        }
    }
}

const EMBEDDED_FONTS: [(FontRole, &[u8]); 4] = [
    (FontRole::Body, include_bytes!("../../assets/fonts/Barlow-Medium.ttf")),
    (FontRole::BodyBold, include_bytes!("../../assets/fonts/Barlow-SemiBold.ttf")),
    (FontRole::Label, include_bytes!("../../assets/fonts/BarlowCondensed-SemiBold.ttf")),
    (FontRole::Display, include_bytes!("../../assets/fonts/BarlowCondensed-Bold.ttf")),
];

/// Replace one of the theme faces (e.g. a game's display font). Every existing and future
/// text using that role picks it up. No-op without `Assets<Font>` (headless).
pub fn override_font(world: &mut World, role: FontRole, ttf: Vec<u8>) {
    if let Some(mut fonts) = world.get_resource_mut::<Assets<Font>>() {
        let _ = fonts.insert(role.handle().id(), Font::from_bytes(ttf));
    }
}

fn font(handle: Handle<Font>, size: f32) -> TextFont {
    TextFont::from_font_size(size).with_font(handle)
}

pub fn body(size: f32) -> TextFont {
    font(FONT_BODY, size)
}
pub fn body_bold(size: f32) -> TextFont {
    font(FONT_BODY_BOLD, size)
}
pub fn label(size: f32) -> TextFont {
    font(FONT_LABEL, size)
}
pub fn display(size: f32) -> TextFont {
    font(FONT_DISPLAY, size)
}

// ---- bundles ----

/// A text node: `(Text, TextFont, TextColor)`, ignored by picking.
pub fn text(s: impl Into<String>, font: TextFont, color: Color) -> impl Bundle {
    (Text::new(s), font, TextColor(color), Pickable::IGNORE)
}

/// Small upper-case section label ("DIFFICULTY").
pub fn eyebrow(s: &str, color: Color) -> impl Bundle {
    text(s.to_uppercase(), label(SIZE_LABEL), color)
}

/// Eyebrow with a short accent bar in front (brand lines, screen kickers).
pub fn eyebrow_bar(p: &mut ChildSpawnerCommands, s: &str, color: Color) {
    p.spawn((Node { column_gap: px(GAP_S + 4.0), align_items: AlignItems::Center, ..default() }, Pickable::IGNORE))
        .with_children(|r| {
            r.spawn((Node { width: px(36), height: px(3), ..default() }, BackgroundColor(color), Pickable::IGNORE));
            r.spawn(eyebrow(s, color));
        });
}

/// Bordered panel column.
pub fn panel(t: &Theme, padding: f32, gap: f32) -> impl Bundle {
    (
        Node {
            flex_direction: FlexDirection::Column,
            row_gap: px(gap),
            padding: UiRect::all(px(padding)),
            border: UiRect::all(px(1)),
            border_radius: BorderRadius::all(px(RADIUS)),
            ..default()
        },
        BackgroundColor(t.panel),
        BorderColor::all(t.line),
        Pickable::IGNORE,
    )
}

/// Panel with a coloured left edge (feature cards like Shroud's "Enemy brain").
pub fn accent_panel(t: &Theme, edge: Color, padding: f32, gap: f32) -> impl Bundle {
    (
        Node {
            flex_direction: FlexDirection::Column,
            row_gap: px(gap),
            padding: UiRect::all(px(padding)),
            border: UiRect::left(px(3)),
            border_radius: BorderRadius::all(px(RADIUS)),
            ..default()
        },
        BackgroundColor(t.panel),
        BorderColor::all(edge),
        Pickable::IGNORE,
    )
}

/// Full-screen absolute root for a screen or overlay.
pub fn fullscreen() -> Node {
    Node { position_type: PositionType::Absolute, width: percent(100), height: percent(100), ..default() }
}

/// Left-heavy darkening over the live 3D scene (menus).
pub fn menu_scrim(t: &Theme, strength: f32) -> BackgroundGradient {
    BackgroundGradient::from(LinearGradient::new(
        std::f32::consts::FRAC_PI_2,
        vec![
            ColorStop::new(t.bg.with_alpha(0.97 * strength), percent(0)),
            ColorStop::new(t.bg.with_alpha(0.86 * strength), percent(38)),
            ColorStop::new(t.bg.with_alpha(0.45 * strength), percent(100)),
        ],
    ))
}

/// Standard menu backdrop: an optional flat dim (`dim` alpha, 0 = none), the left-heavy scrim
/// and a bottom fade so the footer reads. Spawn as the first children of a screen root.
pub fn menu_backdrop(p: &mut ChildSpawnerCommands, t: &Theme, dim: f32, scrim: f32) {
    if dim > 0.0 {
        p.spawn((fullscreen(), BackgroundColor(t.bg.with_alpha(dim)), Pickable::IGNORE));
    }
    p.spawn((fullscreen(), menu_scrim(t, scrim), Pickable::IGNORE));
    p.spawn((
        Node { position_type: PositionType::Absolute, left: px(0), right: px(0), bottom: px(0), height: percent(30), ..default() },
        BackgroundGradient::from(LinearGradient::new(
            0.0,
            vec![ColorStop::new(t.bg.with_alpha(0.85), percent(0)), ColorStop::new(t.bg.with_alpha(0.0), percent(100))],
        )),
        Pickable::IGNORE,
    ));
}

/// The standard left menu column (vertically centred, `EDGE` from the left).
pub fn menu_column(row_gap: f32) -> impl Bundle {
    (
        Node {
            position_type: PositionType::Absolute,
            left: px(EDGE),
            top: px(0),
            bottom: px(0),
            flex_direction: FlexDirection::Column,
            justify_content: JustifyContent::Center,
            row_gap: px(row_gap),
            ..default()
        },
        Pickable::IGNORE,
    )
}

/// Big display title with the tight margins display type needs ("SETTINGS", "PAUSED").
pub fn title(s: &str, size: f32, color: Color) -> impl Bundle {
    (
        text(s.to_uppercase(), display(size), color),
        Node { margin: UiRect::new(px(-size * 0.04), px(0), px(-size * 0.1), px(-size * 0.08)), ..default() },
    )
}

/// Fixed-height vertical gap.
pub fn spacer(h: f32) -> impl Bundle {
    (Node { height: px(h), flex_shrink: 0.0, ..default() }, Pickable::IGNORE)
}

/// A thin horizontal rule.
pub fn rule(color: Color) -> impl Bundle {
    (Node { height: px(1), width: percent(100), flex_shrink: 0.0, ..default() }, BackgroundColor(color), Pickable::IGNORE)
}

/// Just the key cap ("ESC").
pub fn key_cap(t: &Theme, key: &str) -> impl Bundle {
    (
        Node {
            padding: UiRect::axes(px(7), px(2)),
            border: UiRect::all(px(1)),
            border_radius: BorderRadius::all(px(3)),
            min_width: px(28),
            justify_content: JustifyContent::Center,
            ..default()
        },
        BorderColor::all(t.line_strong),
        BackgroundColor(Color::srgba(1.0, 1.0, 1.0, 0.04)),
        Pickable::IGNORE,
        children![text(key.to_uppercase(), label(SIZE_TINY), t.text)],
    )
}

/// A key cap followed by what it does, for footers.
pub fn key_hint(parent: &mut ChildSpawnerCommands, t: &Theme, key: &str, action: &str) {
    parent
        .spawn((Node { column_gap: px(GAP_S), align_items: AlignItems::Center, ..default() }, Pickable::IGNORE))
        .with_children(|row| {
            row.spawn(key_cap(t, key));
            row.spawn(text(action, body(SIZE_SMALL), t.text_muted));
        });
}

/// Footer row of key hints, pinned bottom-left.
pub fn spawn_footer(parent: &mut ChildSpawnerCommands, t: &Theme, hints: &[(&str, &str)]) {
    parent
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                left: px(EDGE),
                bottom: px(FOOTER_BOTTOM),
                column_gap: px(GAP_L),
                ..default()
            },
            Pickable::IGNORE,
        ))
        .with_children(|row| {
            for (k, a) in hints {
                key_hint(row, t, k, a);
            }
        });
}

// ---- plugin ----

pub struct ThemePlugin;

impl Plugin for ThemePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Theme>();
        if let Some(mut fonts) = app.world_mut().get_resource_mut::<Assets<Font>>() {
            for (role, bytes) in EMBEDDED_FONTS {
                let _ = fonts.insert(role.handle().id(), Font::from_bytes(bytes.to_vec()));
            }
        }
        app.add_systems(Update, scale_ui.run_if(super::ui_visible));
    }
}

/// Reference height the layout is authored for.
pub const REF_HEIGHT: f32 = 1080.0;

/// UI scale for a viewport `height` (logical px) and the user's multiplier.
pub fn ui_scale_for(height: f32, user: f32) -> f32 {
    (height / REF_HEIGHT).clamp(0.72, 2.0) * user.clamp(0.5, 2.0)
}

/// Scale with the height of what the UI renders into: the default UI camera's target when one
/// is tagged (offscreen captures render to a fixed-size image), else the primary window.
fn scale_ui(
    ui_cams: Query<&Camera, With<IsDefaultUiCamera>>,
    windows: Query<&Window, With<PrimaryWindow>>,
    core: Option<Res<CoreSettings>>,
    scale: Option<ResMut<UiScale>>,
) {
    let Some(mut scale) = scale else { return };
    let h = ui_cams
        .iter()
        .find_map(|c| c.logical_target_size())
        .map(|s| s.y)
        .or_else(|| windows.iter().next().map(|w| w.height()));
    let Some(h) = h.filter(|h| *h > 1.0) else { return };
    let s = ui_scale_for(h, core.map_or(1.0, |c| c.ui_scale));
    if (scale.0 - s).abs() > 0.005 {
        scale.0 = s;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_follows_height_and_user_factor() {
        assert!((ui_scale_for(1080.0, 1.0) - 1.0).abs() < 1e-6);
        assert!((ui_scale_for(2160.0, 1.0) - 2.0).abs() < 1e-6);
        assert!((ui_scale_for(400.0, 1.0) - 0.72).abs() < 1e-6, "small windows stay readable");
        assert!((ui_scale_for(1080.0, 1.25) - 1.25).abs() < 1e-6);
        assert!((ui_scale_for(1080.0, 9.0) - 2.0).abs() < 1e-6, "user factor is clamped");
    }

    #[test]
    fn accent_light_is_lighter() {
        let t = Theme::default();
        let a = t.accent.to_srgba();
        let l = t.accent_light().to_srgba();
        assert!(l.blue > a.blue && l.green >= a.green);
    }
}
