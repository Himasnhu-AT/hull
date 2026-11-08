//! Components: props structs with builders. Each implements [`Spawn`] (`spawn(world, parent, cx)`),
//! derives `Deserialize` (so screen files can use it) and `Default` (so Rust can write
//! `Tile { title: "Race".into(), ..default() }`). Local state lives in small components
//! ([`TabBar`], [`Toggle2`], [`Slider2`]); events are [`UiEvent`](super::UiEvent) messages.

use bevy::ecs::message::MessageCursor;
use bevy::picking::hover::Hovered;
use bevy::prelude::*;
use bevy::ui::{GridPlacement, GridTrack, RelativeCursorPosition, ScrollPosition, UiTransform};
use bevy::ui_widgets::Button as BevyButton;
use serde::{Deserialize, Serialize};

use super::anim::{Enter, TileFx, Veil};
use super::focus::{FocusScope, Focusable2, Ui2Focus};
use super::glyph::{self, Glyph};
use super::store::{Bind, BindTarget, UiData, is_template};
use super::tokens::{ColorRef, Tokens};
use super::{Action, Ui2Set, UiEvent, UiEventKind};
use crate::ui::theme;

/// Build context: tokens, entrance stagger counter, problems found while building.
pub struct Cx<'a> {
    pub t: &'a Tokens,
    /// `(element path, message)`.
    pub errors: Vec<(String, String)>,
    pub path: Vec<String>,
    pub stagger: u32,
    /// Staggered entrances on? (off for hot reloads and tests).
    pub animate: bool,
}

impl<'a> Cx<'a> {
    pub fn new(t: &'a Tokens) -> Self {
        Cx { t, errors: vec![], path: vec![], stagger: 0, animate: true }
    }
    pub fn err(&mut self, msg: impl Into<String>) {
        self.errors.push((self.path.join("/"), msg.into()));
    }
    pub fn color(&mut self, c: &ColorRef) -> Color {
        c.resolve(self.t).unwrap_or_else(|e| {
            self.err(e);
            self.t.colors.accent.color()
        })
    }
    fn next_enter(&mut self) -> Option<Enter> {
        if !self.animate {
            return None;
        }
        let delay = self.stagger as f32 * self.t.motion.stagger;
        self.stagger += 1;
        Some(Enter { delay, t: 0.0, dur: self.t.motion.enter, rise: 26.0 })
    }
}

pub trait Build {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity;
}

/// One element of a screen tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum El {
    Column(Container),
    Row(Container),
    Stack(Container),
    Grid(Grid),
    Carousel(Container),
    Text(TextEl),
    Image(ImageEl),
    Spacer(f32),
    Divider,
    Header(Header),
    TabBar(TabBarEl),
    Tile(Tile),
    Button(ButtonEl),
    Toggle(ToggleEl),
    Slider(SliderEl),
    KeyHints(KeyHints),
    Modal(Modal),
}

impl Build for El {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let name = match self {
            El::Column(_) => "Column",
            El::Row(_) => "Row",
            El::Stack(_) => "Stack",
            El::Grid(_) => "Grid",
            El::Carousel(_) => "Carousel",
            El::Text(_) => "Text",
            El::Image(_) => "Image",
            El::Spacer(_) => "Spacer",
            El::Divider => "Divider",
            El::Header(_) => "Header",
            El::TabBar(_) => "TabBar",
            El::Tile(t) => return with_path(cx, &format!("Tile({})", t.id), |cx| t.spawn(w, parent, cx)),
            El::Button(b) => return with_path(cx, &format!("Button({})", b.id), |cx| b.spawn(w, parent, cx)),
            El::Toggle(_) => "Toggle",
            El::Slider(_) => "Slider",
            El::KeyHints(_) => "KeyHints",
            El::Modal(_) => "Modal",
        };
        with_path(cx, name, |cx| match self {
            El::Column(c) => c.spawn_as(w, parent, cx, FlexDirection::Column, "Column"),
            El::Row(c) => c.spawn_as(w, parent, cx, FlexDirection::Row, "Row"),
            El::Stack(c) => c.spawn_stack(w, parent, cx),
            El::Carousel(c) => c.spawn_carousel(w, parent, cx),
            El::Grid(g) => g.spawn(w, parent, cx),
            El::Text(t) => t.spawn(w, parent, cx),
            El::Image(i) => i.spawn(w, parent, cx),
            El::Spacer(n) => spacer(w, parent, *n),
            El::Divider => w.spawn((Name::new("Divider"), Node { height: px(1), width: percent(100), flex_shrink: 0.0, ..default() }, BackgroundColor(cx.t.colors.line.color()), Pickable::IGNORE, ChildOf(parent))).id(),
            El::Header(h) => h.spawn(w, parent, cx),
            El::TabBar(t) => t.spawn(w, parent, cx),
            El::Toggle(t) => t.spawn(w, parent, cx),
            El::Slider(s) => s.spawn(w, parent, cx),
            El::KeyHints(k) => k.spawn(w, parent, cx),
            El::Modal(m) => m.spawn(w, parent, cx),
            El::Tile(_) | El::Button(_) => unreachable!(),
        })
    }
}

fn with_path<R>(cx: &mut Cx, seg: &str, f: impl FnOnce(&mut Cx) -> R) -> R {
    cx.path.push(seg.to_string());
    let r = f(cx);
    cx.path.pop();
    r
}

fn spacer(w: &mut World, parent: Entity, n: f32) -> Entity {
    // `0` = flexible (pushes siblings apart), else a fixed gap.
    let node = if n <= 0.0 { Node { flex_grow: 1.0, ..default() } } else { Node { width: px(n), height: px(n), flex_shrink: 0.0, ..default() } };
    w.spawn((Name::new("Spacer"), node, Pickable::IGNORE, ChildOf(parent))).id()
}

/// Spawn a text node; `{key}` templates are bound to [`UiData`].
pub fn text_node(w: &mut World, parent: Entity, s: &str, font: TextFont, color: Color) -> Entity {
    let shown = w.get_resource::<UiData>().map_or_else(|| s.to_string(), |d| d.interpolate(s));
    let e = w.spawn((Name::new("Text"), Text::new(shown), font, TextColor(color), Pickable::IGNORE, ChildOf(parent))).id();
    if is_template(s) {
        w.entity_mut(e).insert(Bind { template: s.to_string(), target: BindTarget::Text });
    }
    e
}

/// Show only while `cond` holds (bound to [`UiData`]).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Cond {
    pub key: String,
    pub eq: Option<f64>,
}

fn apply_show(w: &mut World, e: Entity, show: &Option<Cond>) {
    if let Some(c) = show {
        w.entity_mut(e).insert(Bind { template: c.key.clone(), target: BindTarget::Visible(c.eq) });
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum Align {
    #[default]
    Start,
    Center,
    End,
    Stretch,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum Justify {
    #[default]
    Start,
    Center,
    End,
    Between,
}

/// Column / Row / Stack / Carousel props.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Container {
    pub gap: f32,
    pub pad: f32,
    pub align: Align,
    pub justify: Justify,
    pub grow: f32,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub show: Option<Cond>,
    pub children: Vec<El>,
}

impl Default for Container {
    fn default() -> Self {
        Container { gap: 16.0, pad: 0.0, align: Align::Start, justify: Justify::Start, grow: 0.0, width: None, height: None, show: None, children: vec![] }
    }
}

fn dim(v: Option<f32>) -> Val {
    v.map_or(Val::Auto, Val::Px)
}

impl Container {
    fn node(&self, dir: FlexDirection) -> Node {
        Node {
            flex_direction: dir,
            row_gap: px(self.gap),
            column_gap: px(self.gap),
            padding: UiRect::all(px(self.pad)),
            align_items: match self.align {
                Align::Start => AlignItems::FlexStart,
                Align::Center => AlignItems::Center,
                Align::End => AlignItems::FlexEnd,
                Align::Stretch => AlignItems::Stretch,
            },
            justify_content: match self.justify {
                Justify::Start => JustifyContent::FlexStart,
                Justify::Center => JustifyContent::Center,
                Justify::End => JustifyContent::FlexEnd,
                Justify::Between => JustifyContent::SpaceBetween,
            },
            flex_grow: self.grow,
            width: dim(self.width),
            height: dim(self.height),
            ..default()
        }
    }

    fn spawn_as(&self, w: &mut World, parent: Entity, cx: &mut Cx, dir: FlexDirection, name: &str) -> Entity {
        let e = w.spawn((Name::new(name.to_string()), self.node(dir), Pickable::IGNORE, ChildOf(parent))).id();
        apply_show(w, e, &self.show);
        for (i, c) in self.children.iter().enumerate() {
            with_path(cx, &format!("[{i}]"), |cx| c.spawn(w, e, cx));
        }
        e
    }

    fn spawn_stack(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let e = self.spawn_as(w, parent, cx, FlexDirection::Column, "Stack");
        // Children overlap: all but the first are absolute.
        let kids: Vec<Entity> = w.get::<Children>(e).map(|c| c.iter().collect()).unwrap_or_default();
        for k in kids.into_iter().skip(1) {
            if let Some(mut n) = w.get_mut::<Node>(k) {
                n.position_type = PositionType::Absolute;
            }
        }
        e
    }

    fn spawn_carousel(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let mut node = self.node(FlexDirection::Row);
        node.overflow = Overflow::scroll_x();
        node.padding = UiRect::axes(px(self.pad.max(14.0)), px(self.pad.max(18.0)));
        let e = w.spawn((Name::new("Carousel"), node, ScrollPosition::default(), Carousel, Pickable::IGNORE, ChildOf(parent))).id();
        apply_show(w, e, &self.show);
        for (i, c) in self.children.iter().enumerate() {
            let k = with_path(cx, &format!("[{i}]"), |cx| c.spawn(w, e, cx));
            if let Some(mut n) = w.get_mut::<Node>(k) {
                n.flex_shrink = 0.0;
            }
        }
        e
    }
}

/// Marker: a horizontally scrolling row that keeps the focused child in view.
#[derive(Component, Clone, Debug, Default)]
pub struct Carousel;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Grid {
    pub columns: u16,
    pub gap: f32,
    pub row_height: f32,
    pub grow: f32,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub show: Option<Cond>,
    pub children: Vec<El>,
}

impl Default for Grid {
    fn default() -> Self {
        Grid { columns: 3, gap: 20.0, row_height: 200.0, grow: 0.0, width: None, height: None, show: None, children: vec![] }
    }
}

impl Build for Grid {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let node = Node {
            display: Display::Grid,
            grid_template_columns: RepeatedGridTrack::flex(self.columns.max(1), 1.0),
            grid_auto_rows: vec![GridTrack::px(self.row_height)],
            row_gap: px(self.gap),
            column_gap: px(self.gap),
            flex_grow: self.grow,
            width: self.width.map_or(percent(100), Val::Px),
            height: dim(self.height),
            ..default()
        };
        let e = w.spawn((Name::new("Grid"), node, Pickable::IGNORE, ChildOf(parent))).id();
        apply_show(w, e, &self.show);
        for (i, c) in self.children.iter().enumerate() {
            with_path(cx, &format!("[{i}]"), |cx| c.spawn(w, e, cx));
        }
        e
    }
}

// ---------------------------------------------------------------- text and image

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum TextSize {
    Display,
    Title,
    Heading,
    #[default]
    Body,
    Small,
    Tiny,
}

impl TextSize {
    pub fn px(self, t: &Tokens) -> f32 {
        match self {
            TextSize::Display => t.type_scale.display,
            TextSize::Title => t.type_scale.title,
            TextSize::Heading => t.type_scale.heading,
            TextSize::Body => t.type_scale.body,
            TextSize::Small => t.type_scale.small,
            TextSize::Tiny => t.type_scale.tiny,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TextEl {
    pub text: String,
    pub size: TextSize,
    pub color: Option<ColorRef>,
    pub bold: bool,
    pub upper: bool,
    pub show: Option<Cond>,
}

impl Default for TextEl {
    fn default() -> Self {
        TextEl { text: String::new(), size: TextSize::Body, color: None, bold: false, upper: false, show: None }
    }
}

impl Build for TextEl {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let color = self.color.as_ref().map_or(cx.t.colors.text.color(), |c| cx.color(c));
        let size = self.size.px(cx.t);
        let font = match (self.bold, self.size) {
            (_, TextSize::Display | TextSize::Title) => theme::display(size),
            (true, _) => theme::body_bold(size),
            (false, TextSize::Tiny | TextSize::Small) => theme::label(size),
            _ => theme::body(size),
        };
        let s = if self.upper { self.text.to_uppercase() } else { self.text.clone() };
        let e = text_node(w, parent, &s, font, color);
        apply_show(w, e, &self.show);
        e
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ImageEl {
    pub path: String,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub radius: f32,
}

impl Build for ImageEl {
    fn spawn(&self, w: &mut World, parent: Entity, _cx: &mut Cx) -> Entity {
        let img: Handle<Image> = w.get_resource::<AssetServer>().map(|a| a.load(self.path.clone())).unwrap_or_default();
        w.spawn((
            Name::new("Image"),
            Node { width: dim(self.width), height: dim(self.height), border_radius: BorderRadius::all(px(self.radius)), ..default() },
            ImageNode::new(img),
            Pickable::IGNORE,
            ChildOf(parent),
        ))
        .id()
    }
}

// ---------------------------------------------------------------- pills

/// A small rounded label: badge counts, tags.
pub fn pill(w: &mut World, parent: Entity, cx: &mut Cx, s: &str, bg: Color, fg: Color) -> Entity {
    let e = w
        .spawn((
            Name::new("Pill"),
            Node {
                min_width: px(24),
                height: px(24),
                padding: UiRect::horizontal(px(8)),
                border_radius: BorderRadius::all(px(12)),
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                ..default()
            },
            BackgroundColor(bg),
            Pickable::IGNORE,
            ChildOf(parent),
        ))
        .id();
    text_node(w, e, s, theme::display(cx.t.type_scale.small), fg);
    e
}

/// A count badge bound to a data key: hidden while the value is 0.
pub fn badge(w: &mut World, parent: Entity, cx: &mut Cx, key: &str) -> Entity {
    let key = key.trim().trim_start_matches('{').trim_end_matches('}').to_string();
    let e = pill(w, parent, cx, "", cx.t.colors.bad.color(), Color::WHITE);
    let shown = w.get_resource::<UiData>().map(|d| (d.truthy(&key), d.text(&key)));
    if let Some((on, text)) = shown {
        if let Some(mut n) = w.get_mut::<Node>(e) {
            n.display = if on { Display::Flex } else { Display::None };
        }
        if let Some(c) = w.get::<Children>(e).and_then(|c| c.first().copied())
            && let Some(mut t) = w.get_mut::<Text>(c)
        {
            t.0 = text;
        }
    }
    w.entity_mut(e).insert(Bind { template: format!("{{{key}}}"), target: BindTarget::Badge });
    // The inner text must not be overwritten as a Text template.
    if let Some(c) = w.get::<Children>(e).and_then(|c| c.first().copied()) {
        w.entity_mut(c).remove::<Bind>();
    }
    e
}

// ---------------------------------------------------------------- Tile

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum Pattern {
    None,
    #[default]
    Circles,
    Stripes,
    Rings,
    Diamonds,
}

/// A big selectable card: gradient art (or an image), title, subtitle, optional tag and count badge.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Tile {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub accent: ColorRef,
    pub image: Option<String>,
    pub pattern: Pattern,
    /// Data key of a count badge (`"n.garage"`), hidden while 0.
    pub badge: Option<String>,
    /// Small chip in the top-left corner ("NEW").
    pub tag: Option<String>,
    /// Grid cells spanned (columns, rows).
    pub span: (u16, u16),
    pub action: Action,
}

impl Default for Tile {
    fn default() -> Self {
        Tile {
            id: String::new(),
            title: String::new(),
            subtitle: String::new(),
            accent: ColorRef::Tile(0),
            image: None,
            pattern: Pattern::Circles,
            badge: None,
            tag: None,
            span: (1, 1),
            action: Action::None,
        }
    }
}

fn fill() -> Node {
    Node { position_type: PositionType::Absolute, left: px(0), right: px(0), top: px(0), bottom: px(0), ..default() }
}

fn mix(a: Color, b: Color, t: f32) -> Color {
    let (a, b) = (a.to_srgba(), b.to_srgba());
    Color::srgba(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t, 1.0)
}

impl Build for Tile {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let t = cx.t;
        let accent = cx.color(&self.accent);
        let radius = BorderRadius::all(px(t.radius.large));
        let big = self.span.0 > 1 || self.span.1 > 1;
        let root = w
            .spawn((
                Name::new(format!("Tile {}", self.id)),
                Node {
                    grid_column: GridPlacement::span(self.span.0.max(1)),
                    grid_row: GridPlacement::span(self.span.1.max(1)),
                    border_radius: radius,
                    min_height: px(0),
                    ..default()
                },
                BevyButton,
                Hovered::default(),
                Focusable2 { id: self.id.clone(), action: self.action.clone(), disabled: false },
                TileFx { focus: 0.0, accent },
                UiTransform::default(),
                Outline::new(px(0), px(3), Color::NONE),
                BoxShadow::default(),
                ZIndex(0),
                ChildOf(parent),
            ))
            .id();
        if let Some(en) = cx.next_enter() {
            w.entity_mut(root).insert(en);
        }
        // Art: clipped, rounded gradient with decor.
        let art = w
            .spawn((
                Name::new("Art"),
                Node { overflow: Overflow::clip(), border_radius: radius, ..fill() },
                BackgroundGradient::from(LinearGradient::new(
                    std::f32::consts::FRAC_PI_2 * 1.5,
                    vec![ColorStop::new(mix(accent, Color::WHITE, 0.18), percent(0)), ColorStop::new(accent, percent(45)), ColorStop::new(mix(accent, t.colors.bg.color(), 0.62), percent(100))],
                )),
                Pickable::IGNORE,
                ChildOf(root),
            ))
            .id();
        if let Some(path) = &self.image {
            let img: Handle<Image> = w.get_resource::<AssetServer>().map(|a| a.load(path.clone())).unwrap_or_default();
            w.spawn((Name::new("Image"), Node { width: percent(100), height: percent(100), ..fill() }, ImageNode::new(img), Pickable::IGNORE, ChildOf(art)));
        } else {
            decor(w, art, self.pattern, big);
        }
        // Reading scrim at the bottom.
        w.spawn((
            Name::new("Scrim"),
            Node { height: percent(70), top: Val::Auto, ..fill() },
            BackgroundGradient::from(LinearGradient::new(
                0.0,
                vec![ColorStop::new(t.colors.bg.color().with_alpha(0.82), percent(0)), ColorStop::new(t.colors.bg.color().with_alpha(0.0), percent(100))],
            )),
            Pickable::IGNORE,
            ChildOf(art),
        ));
        // Text.
        let pad = if big { 26.0 } else { 20.0 };
        let content = w
            .spawn((
                Name::new("Content"),
                Node { flex_direction: FlexDirection::Column, justify_content: JustifyContent::FlexEnd, padding: UiRect::all(px(pad)), row_gap: px(2), ..fill() },
                Pickable::IGNORE,
                ChildOf(root),
            ))
            .id();
        let title_px = if big { t.type_scale.title + 6.0 } else { t.type_scale.heading };
        text_node(w, content, &self.title.to_uppercase(), theme::display(title_px), Color::WHITE);
        if !self.subtitle.is_empty() {
            text_node(w, content, &self.subtitle, theme::body(t.type_scale.small), Color::srgba(1.0, 1.0, 1.0, 0.78));
        }
        // Top row: tag left, badge right.
        let top = w
            .spawn((
                Name::new("Top"),
                Node { justify_content: JustifyContent::SpaceBetween, align_items: AlignItems::FlexStart, padding: UiRect::all(px(14)), bottom: Val::Auto, ..fill() },
                Pickable::IGNORE,
                ChildOf(root),
            ))
            .id();
        match &self.tag {
            Some(tag) => {
                pill(w, top, cx, &tag.to_uppercase(), Color::srgba(1.0, 1.0, 1.0, 0.9), cx.t.colors.on_accent.color());
            }
            None => {
                spacer(w, top, 0.0);
            }
        }
        if let Some(key) = &self.badge {
            badge(w, top, cx, key);
        }
        // Entrance veil on top of everything.
        w.spawn((Name::new("Veil"), Veil, Node { border_radius: radius, ..fill() }, BackgroundColor(t.colors.bg.color().with_alpha(0.0)), Pickable::IGNORE, ChildOf(root)));
        root
    }
}

/// Original decorative shapes (no borrowed art): circles, stripes, rings, diamonds.
fn decor(w: &mut World, art: Entity, p: Pattern, big: bool) {
    let white = |a: f32| Color::srgba(1.0, 1.0, 1.0, a);
    let k = if big { 1.5 } else { 1.0 };
    let abs = |l: Val, t: Val, r: Val, b: Val, wd: f32, h: f32| Node { position_type: PositionType::Absolute, left: l, top: t, right: r, bottom: b, width: px(wd), height: px(h), ..default() };
    match p {
        Pattern::None => {}
        Pattern::Circles => {
            w.spawn((Node { border_radius: BorderRadius::MAX, ..abs(Val::Auto, px(-70.0 * k), px(-60.0 * k), Val::Auto, 250.0 * k, 250.0 * k) }, BackgroundColor(white(0.13)), Pickable::IGNORE, ChildOf(art)));
            w.spawn((Node { border_radius: BorderRadius::MAX, ..abs(px(-40.0 * k), Val::Auto, Val::Auto, px(40.0 * k), 160.0 * k, 160.0 * k) }, BackgroundColor(white(0.08)), Pickable::IGNORE, ChildOf(art)));
        }
        Pattern::Stripes => {
            for (i, a) in [0.14, 0.09, 0.05].into_iter().enumerate() {
                w.spawn((
                    abs(Val::Auto, px(-30.0), px((20.0 + i as f32 * 62.0) * k), Val::Auto, 34.0 * k, 520.0),
                    BackgroundColor(white(a)),
                    UiTransform::from_rotation(Rot2::degrees(24.0)),
                    Pickable::IGNORE,
                    ChildOf(art),
                ));
            }
        }
        Pattern::Rings => {
            for (i, s) in [260.0, 180.0, 100.0].into_iter().enumerate() {
                let s = s * k;
                w.spawn((
                    Node { border: UiRect::all(px(3)), border_radius: BorderRadius::MAX, ..abs(Val::Auto, px(-40.0 * k + i as f32 * 40.0 * k), px(-40.0 * k + i as f32 * 40.0 * k), Val::Auto, s, s) },
                    BorderColor::all(white(0.22 - i as f32 * 0.05)),
                    Pickable::IGNORE,
                    ChildOf(art),
                ));
            }
        }
        Pattern::Diamonds => {
            for (i, s) in [150.0, 90.0].into_iter().enumerate() {
                let s = s * k;
                w.spawn((
                    Node { border: UiRect::all(px(3)), border_radius: BorderRadius::all(px(10)), ..abs(Val::Auto, px(20.0 + i as f32 * 40.0), px(30.0 + i as f32 * 50.0), Val::Auto, s, s) },
                    BorderColor::all(white(0.24 - i as f32 * 0.08)),
                    BackgroundColor(white(0.05)),
                    UiTransform::from_rotation(Rot2::degrees(45.0)),
                    Pickable::IGNORE,
                    ChildOf(art),
                ));
            }
        }
    }
}

// ---------------------------------------------------------------- TabBar

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TabSpec {
    pub label: String,
    /// Data key of a count badge.
    pub badge: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TabBarEl {
    pub id: String,
    pub tabs: Vec<TabSpec>,
    pub selected: usize,
    /// Show the previous / next tab glyphs at the ends.
    pub hints: bool,
}

impl Default for TabBarEl {
    fn default() -> Self {
        TabBarEl { id: "tabs".into(), tabs: vec![], selected: 0, hints: true }
    }
}

/// The state of a tab bar. Changing `selected` (any system) updates the look and `ui.tab.<id>`.
#[derive(Component, Clone, Debug)]
pub struct TabBar {
    pub id: String,
    pub selected: usize,
    pub count: usize,
}

#[derive(Component, Clone, Debug)]
pub struct TabItem {
    pub bar: Entity,
    pub index: usize,
}

#[derive(Component, Clone, Debug)]
pub struct TabLook {
    pub underline: Entity,
    pub label: Entity,
}

impl Build for TabBarEl {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let t = cx.t;
        let bar = w
            .spawn((
                Name::new("TabBar"),
                Node { align_items: AlignItems::Center, column_gap: px(10), padding: UiRect::bottom(px(2)), ..default() },
                TabBar { id: self.id.clone(), selected: self.selected.min(self.tabs.len().saturating_sub(1)), count: self.tabs.len() },
                Pickable::IGNORE,
                ChildOf(parent),
            ))
            .id();
        if let Some(mut d) = w.get_resource_mut::<UiData>() {
            d.set(&format!("ui.tab.{}", self.id), self.selected as u64);
        }
        if let Some(en) = cx.next_enter() {
            w.entity_mut(bar).insert(en);
        }
        if self.hints {
            glyph::spawn_cap(w, bar, t, Glyph { action: "tab_prev".into(), kb: "Q".into(), pad: "LB".into() });
        }
        for (i, tab) in self.tabs.iter().enumerate() {
            let item = w
                .spawn((
                    Name::new(format!("Tab {}", tab.label)),
                    Node { padding: UiRect::axes(px(18), px(10)), column_gap: px(10), align_items: AlignItems::Center, border_radius: BorderRadius::all(px(t.radius.small)), ..default() },
                    BevyButton,
                    Hovered::default(),
                    Focusable2 { id: format!("{}:{}", self.id, i), ..default() },
                    TabItem { bar, index: i },
                    ChildOf(bar),
                ))
                .id();
            let label = text_node(w, item, &tab.label.to_uppercase(), theme::display(t.type_scale.heading), t.colors.text_muted.color());
            if let Some(key) = &tab.badge {
                badge(w, item, cx, key);
            }
            let underline = w
                .spawn((Name::new("Underline"), Node { position_type: PositionType::Absolute, left: px(14), right: px(14), bottom: px(0), height: px(4), border_radius: BorderRadius::all(px(2)), ..default() }, BackgroundColor(Color::NONE), Pickable::IGNORE, ChildOf(item)))
                .id();
            w.entity_mut(item).insert(TabLook { underline, label });
        }
        if self.hints {
            glyph::spawn_cap(w, bar, t, Glyph { action: "tab_next".into(), kb: "E".into(), pad: "RB".into() });
        }
        bar
    }
}

// ---------------------------------------------------------------- KeyHints

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Hint {
    /// Action name looked up in the `ActionMap` for the device glyph.
    pub action: String,
    pub label: String,
    /// Fallback glyph text when the action is not defined.
    pub kb: Option<String>,
    pub pad: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct KeyHints {
    pub hints: Vec<Hint>,
}

fn default_glyph(action: &str) -> (String, String) {
    let (k, p) = match action {
        "confirm" | "accept" | "select" => ("Enter", "A"),
        "back" | "cancel" => ("Esc", "B"),
        "tab_next" => ("E", "RB"),
        "tab_prev" => ("Q", "LB"),
        "navigate" | "move" => ("Arrows", "D-pad"),
        "menu" => ("Tab", "Menu"),
        "option" | "extra" => ("F", "X"),
        "alt" => ("R", "Y"),
        other => return (other.to_uppercase(), other.to_uppercase()),
    };
    (k.into(), p.into())
}

impl Build for KeyHints {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let t = cx.t;
        let row = w
            .spawn((Name::new("KeyHints"), Node { column_gap: px(28), align_items: AlignItems::Center, justify_content: JustifyContent::FlexEnd, ..default() }, Pickable::IGNORE, ChildOf(parent)))
            .id();
        for h in &self.hints {
            let (kb, pad) = default_glyph(&h.action);
            let item = w.spawn((Name::new("Hint"), Node { column_gap: px(10), align_items: AlignItems::Center, ..default() }, Pickable::IGNORE, ChildOf(row))).id();
            glyph::spawn_cap(w, item, t, Glyph { action: h.action.clone(), kb: h.kb.clone().unwrap_or(kb), pad: h.pad.clone().unwrap_or(pad) });
            text_node(w, item, &h.label, theme::label(t.type_scale.body), t.colors.text.color());
        }
        row
    }
}

// ---------------------------------------------------------------- Header

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Stat {
    pub label: String,
    /// Template, e.g. `"{player.credits}"`.
    pub value: String,
    pub color: Option<ColorRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Header {
    pub name: String,
    pub subtitle: String,
    pub initials: Option<String>,
    pub avatar: ColorRef,
    pub stats: Vec<Stat>,
}

impl Default for Header {
    fn default() -> Self {
        Header { name: String::new(), subtitle: String::new(), initials: None, avatar: ColorRef::Tile(1), stats: vec![] }
    }
}

impl Build for Header {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let t = cx.t;
        let accent = cx.color(&self.avatar);
        let row = w
            .spawn((Name::new("Header"), Node { width: percent(100), align_items: AlignItems::Center, column_gap: px(16), ..default() }, Pickable::IGNORE, ChildOf(parent)))
            .id();
        if let Some(en) = cx.next_enter() {
            w.entity_mut(row).insert(en);
        }
        let initials = self.initials.clone().unwrap_or_else(|| self.name.chars().filter(|c| c.is_alphanumeric()).take(2).collect::<String>().to_uppercase());
        let av = w
            .spawn((
                Name::new("Avatar"),
                Node { width: px(64), height: px(64), border: UiRect::all(px(3)), border_radius: BorderRadius::MAX, justify_content: JustifyContent::Center, align_items: AlignItems::Center, flex_shrink: 0.0, ..default() },
                BackgroundGradient::from(LinearGradient::new(std::f32::consts::FRAC_PI_2 * 1.5, vec![ColorStop::new(mix(accent, Color::WHITE, 0.25), percent(0)), ColorStop::new(mix(accent, t.colors.bg.color(), 0.5), percent(100))])),
                BorderColor::all(t.colors.text.color()),
                Pickable::IGNORE,
                ChildOf(row),
            ))
            .id();
        text_node(w, av, &initials, theme::display(t.type_scale.heading), Color::WHITE);
        let who = w.spawn((Name::new("Who"), Node { flex_direction: FlexDirection::Column, ..default() }, Pickable::IGNORE, ChildOf(row))).id();
        text_node(w, who, &self.name, theme::display(t.type_scale.title), t.colors.text.color());
        if !self.subtitle.is_empty() {
            text_node(w, who, &self.subtitle, theme::label(t.type_scale.small), t.colors.text_muted.color());
        }
        spacer(w, row, 0.0);
        for s in &self.stats {
            let col = s.color.as_ref().map_or(t.colors.accent.color(), |c| cx.color(c));
            let chip = w
                .spawn((
                    Name::new("Stat"),
                    Node { padding: UiRect::axes(px(16), px(8)), column_gap: px(12), align_items: AlignItems::Center, border: UiRect::all(px(1)), border_radius: BorderRadius::all(px(20)), ..default() },
                    BackgroundColor(t.colors.surface.color()),
                    BorderColor::all(t.colors.line.color()),
                    Pickable::IGNORE,
                    ChildOf(row),
                ))
                .id();
            w.spawn((Node { width: px(12), height: px(12), border_radius: BorderRadius::MAX, ..default() }, BackgroundColor(col), Pickable::IGNORE, ChildOf(chip)));
            text_node(w, chip, &s.value, theme::display(t.type_scale.heading), t.colors.text.color());
            text_node(w, chip, &s.label.to_uppercase(), theme::label(t.type_scale.tiny), t.colors.text_muted.color());
        }
        row
    }
}

// ---------------------------------------------------------------- Button / Toggle / Slider

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ButtonEl {
    pub id: String,
    pub label: String,
    pub primary: bool,
    pub action: Action,
    pub width: Option<f32>,
    pub show: Option<Cond>,
}

#[derive(Component, Clone, Debug)]
pub struct BtnLook {
    pub primary: bool,
    pub label: Entity,
}

impl Build for ButtonEl {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let t = cx.t;
        let e = w
            .spawn((
                Name::new(format!("Button {}", self.id)),
                Node {
                    padding: UiRect::axes(px(26), px(12)),
                    min_width: dim(self.width),
                    justify_content: JustifyContent::Center,
                    align_items: AlignItems::Center,
                    border: UiRect::all(px(2)),
                    border_radius: BorderRadius::all(px(t.radius.medium)),
                    ..default()
                },
                BackgroundColor(Color::NONE),
                BorderColor::all(Color::NONE),
                BevyButton,
                Hovered::default(),
                Focusable2 { id: self.id.clone(), action: self.action.clone(), disabled: false },
                ChildOf(parent),
            ))
            .id();
        let label = text_node(w, e, &self.label.to_uppercase(), theme::display(t.type_scale.heading), t.colors.text.color());
        w.entity_mut(e).insert(BtnLook { primary: self.primary, label });
        apply_show(w, e, &self.show);
        if let Some(en) = cx.next_enter() {
            w.entity_mut(e).insert(en);
        }
        e
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ToggleEl {
    pub id: String,
    pub label: String,
    /// Data key holding the bool.
    pub key: String,
    pub initial: bool,
}

#[derive(Component, Clone, Debug)]
pub struct Toggle2 {
    pub key: String,
    pub knob: Entity,
    pub track: Entity,
}

impl Build for ToggleEl {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let t = cx.t;
        if let Some(mut d) = w.get_resource_mut::<UiData>()
            && d.get(&self.key).is_none()
        {
            d.set(&self.key, self.initial);
        }
        let row = w
            .spawn((
                Name::new(format!("Toggle {}", self.id)),
                Node { padding: UiRect::axes(px(14), px(10)), column_gap: px(16), align_items: AlignItems::Center, justify_content: JustifyContent::SpaceBetween, border: UiRect::all(px(2)), border_radius: BorderRadius::all(px(t.radius.medium)), min_width: px(360), ..default() },
                BackgroundColor(t.colors.surface.color()),
                BorderColor::all(Color::NONE),
                BevyButton,
                Hovered::default(),
                Focusable2 { id: self.id.clone(), ..default() },
                ChildOf(parent),
            ))
            .id();
        text_node(w, row, &self.label, theme::body(t.type_scale.body), t.colors.text.color());
        let track = w
            .spawn((Node { width: px(54), height: px(28), border_radius: BorderRadius::MAX, padding: UiRect::all(px(3)), ..default() }, BackgroundColor(t.colors.surface_raised.color()), Pickable::IGNORE, ChildOf(row)))
            .id();
        let knob = w.spawn((Node { width: px(22), height: px(22), border_radius: BorderRadius::MAX, ..default() }, BackgroundColor(Color::WHITE), Pickable::IGNORE, ChildOf(track))).id();
        w.entity_mut(row).insert(Toggle2 { key: self.key.clone(), knob, track });
        row
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SliderEl {
    pub id: String,
    pub label: String,
    pub key: String,
    pub min: f32,
    pub max: f32,
    pub step: f32,
    pub initial: f32,
}

impl Default for SliderEl {
    fn default() -> Self {
        SliderEl { id: String::new(), label: String::new(), key: String::new(), min: 0.0, max: 1.0, step: 0.05, initial: 0.5 }
    }
}

/// A slider row: Left / Right adjust while focused, a drag on the track sets it.
#[derive(Component, Clone, Debug)]
pub struct Slider2 {
    pub key: String,
    pub min: f32,
    pub max: f32,
    pub step: f32,
    pub fill: Entity,
    pub track: Entity,
}

impl Slider2 {
    pub fn set(&self, data: &mut UiData, v: f32) -> Option<f32> {
        let s = if self.step > 0.0 { self.min + ((v - self.min) / self.step).round() * self.step } else { v };
        let s = s.clamp(self.min, self.max);
        let changed = (data.f64(&self.key) as f32 - s).abs() > 1e-6 || data.get(&self.key).is_none();
        data.set(&self.key, s as f64);
        changed.then_some(s)
    }
}

impl Build for SliderEl {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let t = cx.t;
        if let Some(mut d) = w.get_resource_mut::<UiData>()
            && d.get(&self.key).is_none()
        {
            d.set(&self.key, self.initial as f64);
        }
        let row = w
            .spawn((
                Name::new(format!("Slider {}", self.id)),
                Node { padding: UiRect::axes(px(14), px(10)), column_gap: px(16), align_items: AlignItems::Center, justify_content: JustifyContent::SpaceBetween, border: UiRect::all(px(2)), border_radius: BorderRadius::all(px(t.radius.medium)), min_width: px(360), ..default() },
                BackgroundColor(t.colors.surface.color()),
                BorderColor::all(Color::NONE),
                BevyButton,
                Hovered::default(),
                Focusable2 { id: self.id.clone(), ..default() },
                ChildOf(parent),
            ))
            .id();
        text_node(w, row, &self.label, theme::body(t.type_scale.body), t.colors.text.color());
        let track = w
            .spawn((
                Node { width: px(180), height: px(8), border_radius: BorderRadius::MAX, ..default() },
                BackgroundColor(t.colors.surface_raised.color()),
                RelativeCursorPosition::default(),
                Pickable::IGNORE,
                ChildOf(row),
            ))
            .id();
        let fill = w.spawn((Node { height: percent(100), width: percent(0), border_radius: BorderRadius::MAX, ..default() }, BackgroundColor(t.colors.accent.color()), Pickable::IGNORE, ChildOf(track))).id();
        w.entity_mut(row).insert((Slider2 { key: self.key.clone(), min: self.min, max: self.max, step: self.step, fill, track }, RelativeCursorPosition::default()));
        row
    }
}

// ---------------------------------------------------------------- Modal

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ModalButton {
    pub id: String,
    pub label: String,
    pub primary: bool,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Modal {
    pub id: String,
    pub title: String,
    pub body: String,
    pub buttons: Vec<ModalButton>,
}

impl Default for Modal {
    fn default() -> Self {
        Modal { id: "modal".into(), title: String::new(), body: String::new(), buttons: vec![ModalButton { id: "ok".into(), label: "OK".into(), primary: true, action: Action::Back }] }
    }
}

/// Marks a modal overlay (focus is scoped to it).
#[derive(Component, Clone, Debug, Default)]
pub struct ModalRoot;

impl Build for Modal {
    fn spawn(&self, w: &mut World, parent: Entity, cx: &mut Cx) -> Entity {
        let t = cx.t;
        let overlay = w
            .spawn((
                Name::new(format!("Modal {}", self.id)),
                Node { justify_content: JustifyContent::Center, align_items: AlignItems::Center, ..fill() },
                BackgroundColor(t.colors.bg.color().with_alpha(0.72)),
                GlobalZIndex(100),
                ModalRoot,
                ChildOf(parent),
            ))
            .id();
        let card = w
            .spawn((
                Name::new("Card"),
                Node { flex_direction: FlexDirection::Column, row_gap: px(18), padding: UiRect::all(px(34)), min_width: px(520), max_width: px(720), border: UiRect::all(px(1)), border_radius: BorderRadius::all(px(t.radius.large)), ..default() },
                BackgroundColor(t.colors.surface_raised.color()),
                BorderColor::all(t.colors.line.color()),
                BoxShadow::new(Color::BLACK.with_alpha(0.6), px(0), px(16), px(0), px(48)),
                UiTransform::default(),
                Pickable::default(),
                ChildOf(overlay),
            ))
            .id();
        if cx.animate {
            w.entity_mut(card).insert(Enter { delay: 0.0, t: 0.0, dur: t.motion.enter * 0.7, rise: 22.0 });
            w.spawn((Name::new("Veil"), Veil, Node { border_radius: BorderRadius::all(px(t.radius.large)), ..fill() }, BackgroundColor(t.colors.bg.color().with_alpha(1.0)), Pickable::IGNORE, ChildOf(card)));
        }
        text_node(w, card, &self.title.to_uppercase(), theme::display(t.type_scale.title), t.colors.text.color());
        if !self.body.is_empty() {
            text_node(w, card, &self.body, theme::body(t.type_scale.body), t.colors.text_muted.color());
        }
        let row = w.spawn((Name::new("Buttons"), Node { column_gap: px(14), justify_content: JustifyContent::FlexEnd, margin: UiRect::top(px(10)), ..default() }, Pickable::IGNORE, ChildOf(card))).id();
        for b in &self.buttons {
            let el = ButtonEl { id: b.id.clone(), label: b.label.clone(), primary: b.primary, action: b.action.clone(), ..default() };
            with_path(cx, &format!("Button({})", b.id), |cx| {
                let was = cx.animate;
                cx.animate = false;
                el.spawn(w, row, cx);
                cx.animate = was;
            });
        }
        overlay
    }
}

// ---------------------------------------------------------------- systems

pub struct ComponentsPlugin;

impl Plugin for ComponentsPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, (tab_select, slider_input).chain().in_set(Ui2Set::Screens)).add_systems(
            Update,
            (tab_look, button_look, toggle_look, slider_look, carousel_follow, modal_scope).in_set(Ui2Set::Paint),
        );
    }
}

/// Activating or focusing a tab selects it.
fn tab_select(
    mut events: ResMut<Messages<UiEvent>>,
    mut cursor: Local<MessageCursor<UiEvent>>,
    items: Query<&TabItem>,
    mut bars: Query<&mut TabBar>,
    mut data: ResMut<UiData>,
) {
    let seen: Vec<UiEvent> = cursor.read(&events).cloned().collect();
    for e in &seen {
        if !matches!(e.kind, UiEventKind::Activate | UiEventKind::Focus) {
            continue;
        }
        let Ok(it) = items.get(e.entity) else { continue };
        if let Ok(mut bar) = bars.get_mut(it.bar)
            && bar.selected != it.index
        {
            bar.selected = it.index;
            data.set(&format!("ui.tab.{}", bar.id), it.index as u64);
            events.write(UiEvent { id: bar.id.clone(), kind: UiEventKind::Tab(it.index), entity: it.bar });
        }
    }
}

/// Toggles flip on Activate; sliders follow the drag.
fn slider_input(
    mut out: ResMut<Messages<UiEvent>>,
    mut cursor: Local<MessageCursor<UiEvent>>,
    toggles: Query<&Toggle2>,
    ids: Query<&Focusable2>,
    sliders: Query<(Entity, &Slider2, &RelativeCursorPosition, Has<bevy::ui::Pressed>)>,
    mut data: ResMut<UiData>,
) {
    let seen: Vec<UiEvent> = cursor.read(&out).cloned().collect();
    for e in &seen {
        if e.kind == UiEventKind::Activate
            && let Ok(t) = toggles.get(e.entity)
        {
            let on = !data.truthy(&t.key);
            data.set(&t.key, on);
            out.write(UiEvent { id: e.id.clone(), kind: UiEventKind::Toggle(on), entity: e.entity });
        }
    }
    for (e, s, rel, pressed) in &sliders {
        if !pressed {
            continue;
        }
        if let Some(n) = rel.normalized {
            let v = s.min + (s.max - s.min) * (n.x + 0.5).clamp(0.0, 1.0);
            if let Some(v) = s.set(&mut data, v) {
                out.write(UiEvent { id: ids.get(e).map(|f| f.id.clone()).unwrap_or_default(), kind: UiEventKind::Slide(v), entity: e });
            }
        }
    }
}

fn tab_look(
    tk: Res<Tokens>,
    focus: Res<Ui2Focus>,
    bars: Query<&TabBar>,
    items: Query<(Entity, &TabItem, &TabLook, &mut BackgroundColor)>,
    mut colors: Query<&mut BackgroundColor, Without<TabItem>>,
    mut texts: Query<&mut TextColor>,
) {
    let mut items = items;
    for (e, it, look, mut bg) in &mut items {
        let Ok(bar) = bars.get(it.bar) else { continue };
        let on = bar.selected == it.index;
        let focused = focus.0 == Some(e);
        let (ul, tx) = if on { (tk.colors.accent.color(), tk.colors.text.color()) } else { (Color::NONE, if focused { tk.colors.text.color() } else { tk.colors.text_muted.color() }) };
        let fill = if focused { Color::srgba(1.0, 1.0, 1.0, 0.10) } else { Color::NONE };
        if bg.0 != fill {
            bg.0 = fill;
        }
        if let Ok(mut c) = colors.get_mut(look.underline)
            && c.0 != ul
        {
            c.0 = ul;
        }
        if let Ok(mut c) = texts.get_mut(look.label)
            && c.0 != tx
        {
            c.0 = tx;
        }
    }
}

#[allow(clippy::type_complexity)]
fn button_look(
    tk: Res<Tokens>,
    focus: Res<Ui2Focus>,
    mut q: Query<(Entity, &BtnLook, &mut BackgroundColor, &mut BorderColor)>,
    mut texts: Query<&mut TextColor>,
) {
    for (e, look, mut bg, mut border) in &mut q {
        let focused = focus.0 == Some(e);
        let c = &tk.colors;
        let (fill, txt) = match (look.primary, focused) {
            (true, true) => (mix(c.accent.color(), Color::WHITE, 0.2), c.on_accent.color()),
            (true, false) => (c.accent.color(), c.on_accent.color()),
            (false, true) => (c.surface_raised.color(), c.text.color()),
            (false, false) => (c.surface.color(), c.text.color()),
        };
        let ring = BorderColor::all(if focused { c.text.color() } else { Color::NONE });
        if bg.0 != fill {
            bg.0 = fill;
        }
        if *border != ring {
            *border = ring;
        }
        if let Ok(mut t) = texts.get_mut(look.label)
            && t.0 != txt
        {
            t.0 = txt;
        }
    }
}

fn toggle_look(
    tk: Res<Tokens>,
    data: Res<UiData>,
    focus: Res<Ui2Focus>,
    mut rows: Query<(Entity, &Toggle2, &mut BorderColor)>,
    mut track: Query<&mut BackgroundColor>,
    mut nodes: Query<&mut Node>,
) {
    for (e, t, mut border) in &mut rows {
        let on = data.truthy(&t.key);
        if let Ok(mut c) = track.get_mut(t.track) {
            let want = if on { tk.colors.accent.color() } else { tk.colors.surface_raised.color() };
            if c.0 != want {
                c.0 = want;
            }
        }
        if let Ok(mut n) = nodes.get_mut(t.track) {
            let want = if on { JustifyContent::FlexEnd } else { JustifyContent::FlexStart };
            if n.justify_content != want {
                n.justify_content = want;
            }
        }
        let ring = BorderColor::all(if focus.0 == Some(e) { tk.colors.text.color() } else { Color::NONE });
        if *border != ring {
            *border = ring;
        }
    }
}

fn slider_look(tk: Res<Tokens>, data: Res<UiData>, focus: Res<Ui2Focus>, mut rows: Query<(Entity, &Slider2, &mut BorderColor)>, mut nodes: Query<&mut Node>) {
    for (e, s, mut border) in &mut rows {
        let f = if s.max > s.min { ((data.f64(&s.key) as f32 - s.min) / (s.max - s.min)).clamp(0.0, 1.0) } else { 0.0 };
        if let Ok(mut n) = nodes.get_mut(s.fill) {
            let want = Val::Percent(f * 100.0);
            if n.width != want {
                n.width = want;
            }
        }
        let ring = BorderColor::all(if focus.0 == Some(e) { tk.colors.text.color() } else { Color::NONE });
        if *border != ring {
            *border = ring;
        }
    }
}

/// Scroll a carousel so its focused child is fully visible.
fn carousel_follow(
    focus: Res<Ui2Focus>,
    parents: Query<&ChildOf>,
    nodes: Query<(&ComputedNode, &bevy::ui::UiGlobalTransform)>,
    mut lists: Query<&mut ScrollPosition, With<Carousel>>,
) {
    let Some(f) = focus.0 else { return };
    // The carousel child that contains the focus.
    let Some((list, child)) = std::iter::once(f).chain(parents.iter_ancestors(f)).find_map(|a| {
        let p = parents.get(a).ok()?.parent();
        lists.contains(p).then_some((p, a))
    }) else {
        return;
    };
    let (Ok((item, it)), Ok((view, vt))) = (nodes.get(child), nodes.get(list)) else { return };
    let inv = view.inverse_scale_factor;
    let (l, r) = (it.translation.x - item.size.x * 0.5, it.translation.x + item.size.x * 0.5);
    let (vl, vr) = (vt.translation.x - view.size.x * 0.5, vt.translation.x + view.size.x * 0.5);
    let margin = 24.0 / inv.max(1e-3);
    let Ok(mut pos) = lists.get_mut(list) else { return };
    if r + margin > vr {
        pos.x += (r + margin - vr) * inv;
    } else if l - margin < vl {
        pos.x = (pos.x - (vl - l + margin) * inv).max(0.0);
    }
}

use bevy::ui::ComputedNode;

/// Focus is scoped to the topmost modal while one exists.
fn modal_scope(mut scope: ResMut<FocusScope>, modals: Query<Entity, With<ModalRoot>>) {
    let top = modals.iter().max();
    if scope.0 != top {
        scope.0 = top;
    }
}
