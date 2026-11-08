//! Design tokens as data: colours, type scale, radii, spacing, shadows and motion durations.
//! [`Tokens`] is a resource; `assets/ui/tokens.ron` overrides any field (the rest keeps its
//! default) and is hot reloaded. Components read the tokens when they are built, so a token
//! change rebuilds the open screens ([`super::Ui2Rev`]).

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

/// An sRGB colour in data: `(r, g, b, a)` 0..1.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rgba(pub f32, pub f32, pub f32, pub f32);

impl Rgba {
    pub const fn rgb(r: f32, g: f32, b: f32) -> Self {
        Rgba(r, g, b, 1.0)
    }
    pub fn color(self) -> Color {
        Color::srgba(self.0, self.1, self.2, self.3)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Palette {
    /// Screen background and scrim base.
    pub bg: Rgba,
    pub surface: Rgba,
    pub surface_raised: Rgba,
    pub line: Rgba,
    pub text: Rgba,
    pub text_muted: Rgba,
    pub accent: Rgba,
    /// Text drawn on `accent`.
    pub on_accent: Rgba,
    pub good: Rgba,
    pub bad: Rgba,
    pub warn: Rgba,
    /// Named tile / chip colours: `ColorRef::Token("tile.0")` ...
    pub tiles: Vec<Rgba>,
}

impl Default for Palette {
    fn default() -> Self {
        Palette {
            bg: Rgba::rgb(0.035, 0.043, 0.07),
            surface: Rgba(0.075, 0.09, 0.13, 0.92),
            surface_raised: Rgba(0.13, 0.15, 0.21, 0.96),
            line: Rgba(1.0, 1.0, 1.0, 0.10),
            text: Rgba::rgb(0.95, 0.96, 0.98),
            text_muted: Rgba::rgb(0.62, 0.66, 0.75),
            accent: Rgba::rgb(1.0, 0.78, 0.16),
            on_accent: Rgba::rgb(0.06, 0.06, 0.09),
            good: Rgba::rgb(0.36, 0.9, 0.62),
            bad: Rgba::rgb(1.0, 0.36, 0.34),
            warn: Rgba::rgb(1.0, 0.62, 0.2),
            tiles: vec![
                Rgba::rgb(0.95, 0.32, 0.18), // ember
                Rgba::rgb(0.13, 0.5, 0.95),  // azure
                Rgba::rgb(0.58, 0.28, 0.9),  // violet
                Rgba::rgb(0.1, 0.72, 0.55),  // jade
                Rgba::rgb(0.95, 0.68, 0.1),  // amber
                Rgba::rgb(0.9, 0.22, 0.55),  // rose
            ],
        }
    }
}

/// Font sizes in px at the 1080p reference.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TypeScale {
    pub display: f32,
    pub title: f32,
    pub heading: f32,
    pub body: f32,
    pub small: f32,
    pub tiny: f32,
}

impl Default for TypeScale {
    fn default() -> Self {
        TypeScale { display: 54.0, title: 34.0, heading: 26.0, body: 20.0, small: 16.0, tiny: 13.0 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Radii {
    pub small: f32,
    pub medium: f32,
    pub large: f32,
}

impl Default for Radii {
    fn default() -> Self {
        Radii { small: 4.0, medium: 10.0, large: 18.0 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Spacing {
    pub xs: f32,
    pub s: f32,
    pub m: f32,
    pub l: f32,
    pub xl: f32,
    /// Safe-area margin of full screens.
    pub edge: f32,
}

impl Default for Spacing {
    fn default() -> Self {
        Spacing { xs: 4.0, s: 8.0, m: 16.0, l: 28.0, xl: 48.0, edge: 72.0 }
    }
}

/// One drop shadow / glow.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Shadow {
    pub color: Rgba,
    pub blur: f32,
    pub spread: f32,
    pub dy: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Shadows {
    /// Resting card shadow.
    pub card: Shadow,
    /// Glow of the focused tile (colour is replaced by the tile accent).
    pub glow: Shadow,
}

impl Default for Shadows {
    fn default() -> Self {
        Shadows {
            card: Shadow { color: Rgba(0.0, 0.0, 0.0, 0.45), blur: 22.0, spread: 0.0, dy: 8.0 },
            glow: Shadow { color: Rgba(1.0, 1.0, 1.0, 0.55), blur: 34.0, spread: 3.0, dy: 0.0 },
        }
    }
}

/// Durations in seconds and focus scale.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Motion {
    pub focus: f32,
    pub focus_scale: f32,
    pub enter: f32,
    /// Delay between siblings of a staggered entrance.
    pub stagger: f32,
    pub page: f32,
}

impl Default for Motion {
    fn default() -> Self {
        Motion { focus: 0.14, focus_scale: 1.045, enter: 0.38, stagger: 0.045, page: 0.32 }
    }
}

#[derive(Resource, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Tokens {
    pub colors: Palette,
    pub type_scale: TypeScale,
    pub radius: Radii,
    pub space: Spacing,
    pub shadow: Shadows,
    pub motion: Motion,
}

impl Tokens {
    /// Tokens whose accent, text and surfaces follow the engine UI [`Theme`](crate::ui::theme::Theme).
    pub fn from_theme(t: &crate::ui::theme::Theme) -> Self {
        let rgba = |c: Color| {
            let s = c.to_srgba();
            Rgba(s.red, s.green, s.blue, s.alpha)
        };
        let mut k = Tokens::default();
        k.colors.bg = rgba(t.bg);
        k.colors.surface = rgba(t.panel);
        k.colors.surface_raised = rgba(t.raised);
        k.colors.line = rgba(t.line);
        k.colors.text = rgba(t.text);
        k.colors.text_muted = rgba(t.text_muted);
        k.colors.accent = rgba(t.accent);
        k.colors.on_accent = rgba(t.on_accent);
        k.colors.good = rgba(t.good);
        k.colors.bad = rgba(t.bad);
        k
    }

    pub fn from_ron(text: &str) -> Result<Self, (u32, u32, String)> {
        super::screen::ron_options().from_str(text).map_err(|e| (e.span.start.line as u32, e.span.start.col as u32, e.code.to_string()))
    }

    /// Resolve a colour name: palette fields (`accent`, `text`, `bg` ...) or `tile.N`.
    pub fn named(&self, name: &str) -> Option<Color> {
        let c = &self.colors;
        let v = match name {
            "bg" => c.bg,
            "surface" => c.surface,
            "surface_raised" | "raised" => c.surface_raised,
            "line" => c.line,
            "text" => c.text,
            "text_muted" | "muted" => c.text_muted,
            "accent" => c.accent,
            "on_accent" => c.on_accent,
            "good" => c.good,
            "bad" => c.bad,
            "warn" => c.warn,
            _ => {
                let i: usize = name.strip_prefix("tile.")?.parse().ok()?;
                *c.tiles.get(i % c.tiles.len().max(1))?
            }
        };
        Some(v.color())
    }
}

/// A colour in a screen file: `Token("accent")`, `Tile(2)`, `Rgb(1, 0.5, 0)` or `Rgba(...)`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ColorRef {
    Token(String),
    Tile(usize),
    Rgb(f32, f32, f32),
    Rgba(f32, f32, f32, f32),
}

impl Default for ColorRef {
    fn default() -> Self {
        ColorRef::Token("accent".into())
    }
}

impl ColorRef {
    pub fn resolve(&self, t: &Tokens) -> Result<Color, String> {
        match self {
            ColorRef::Token(n) => t.named(n).ok_or_else(|| format!("unknown colour token `{n}` (accent, bg, surface, text, muted, good, bad, warn, tile.N ...)")),
            ColorRef::Tile(i) => Ok(t.colors.tiles.get(i % t.colors.tiles.len().max(1)).copied().unwrap_or(t.colors.accent).color()),
            ColorRef::Rgb(r, g, b) => Ok(Color::srgb(*r, *g, *b)),
            ColorRef::Rgba(r, g, b, a) => Ok(Color::srgba(*r, *g, *b, *a)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_ron_overrides_only_what_it_names() {
        let t = Tokens::from_ron("(colors: (accent: (1.0, 0.0, 0.0, 1.0)), motion: (focus: 0.5))").unwrap();
        assert_eq!(t.colors.accent, Rgba(1.0, 0.0, 0.0, 1.0));
        assert_eq!(t.motion.focus, 0.5);
        assert_eq!(t.motion.page, Motion::default().page, "untouched fields keep defaults");
        assert_eq!(t.colors.bg, Palette::default().bg);
    }

    #[test]
    fn bad_ron_reports_line_and_column() {
        let (line, col, msg) = Tokens::from_ron("(\n  colors: (accent: oops),\n)").unwrap_err();
        assert_eq!(line, 2);
        assert!(col > 0 && !msg.is_empty());
    }

    #[test]
    fn colour_refs_resolve_or_explain() {
        let t = Tokens::default();
        assert!(ColorRef::Token("accent".into()).resolve(&t).is_ok());
        assert!(ColorRef::Token("tile.9".into()).resolve(&t).is_ok(), "tile index wraps");
        assert!(ColorRef::Token("nope".into()).resolve(&t).unwrap_err().contains("unknown colour token"));
        assert_eq!(ColorRef::Rgb(1.0, 0.0, 0.0).resolve(&t).unwrap(), Color::srgb(1.0, 0.0, 0.0));
    }
}
