//! The built-in "settings" screen. Owner: ui stream.
//!
//! - Tabs = `SettingsRegistry.tabs` (plus "Controls" when [`Bindings`] exist but no field is on
//!   that tab). Rows are generated from each tab's [`FieldDef`]s; changes apply live and are
//!   saved (debounced) by the settings store via [`crate::settings::SaveSettings`].
//! - Right-hand column, top to bottom: the tab's registered side panel ([`SettingsPanels`];
//!   built in: "Video" → quality presets), the key-bindings card on "Controls", and an
//!   "About this setting" card that follows keyboard/mouse focus.
//! - "Reset tab" builds a scratch world from [`SettingsDefaults`] and copies each field's
//!   default value (read with its own `get`) into the real settings.

use std::panic::{AssertUnwindSafe, catch_unwind};

use bevy::prelude::*;
use bevy::ui::{RelativeCursorPosition, ScrollPosition};

use super::menus::PanelBuilder;
use super::theme::*;
use super::toast::Toast;
use super::widgets::{Focus, FieldRow, FieldValues, ScrollList, UiAction, action_button, field_row, format_value, normalize, tab_button};
use crate::flow::AppState;
use crate::gfx::QualityPreset;
use crate::input::Bindings;
use crate::settings::{CoreSettings, FieldDef, FieldKind, SaveSettings, SettingsRegistry};

pub const ROWS_W: f32 = 1000.0;
pub const SIDE_W: f32 = 380.0;
/// Visible height of the rows list before it scrolls.
pub const ROWS_MAX_H: f32 = 560.0;

/// Per-tab side panels (exclusive builders spawning under the given column entity).
/// One per tab; registering again replaces. Default: "Video" → quality presets card.
#[derive(Resource, Clone)]
pub struct SettingsPanels(pub Vec<(&'static str, PanelBuilder)>);

impl Default for SettingsPanels {
    fn default() -> Self {
        SettingsPanels(vec![("Video", quality_presets_panel)])
    }
}

/// How to build a world holding default settings resources, for "Reset tab". The UI kit
/// registers `CoreSettings`; a game adds its own with
/// [`RegisterSettingsUi::settings_defaults`]. Without any, "Reset tab" is hidden.
#[derive(Resource, Clone)]
pub struct SettingsDefaults(pub Vec<fn(&mut World)>);

impl Default for SettingsDefaults {
    fn default() -> Self {
        SettingsDefaults(vec![insert_default::<CoreSettings>])
    }
}

/// `fn(&mut World)` that inserts `R::default()`.
pub fn insert_default<R: Resource + Default>(world: &mut World) {
    world.insert_resource(R::default());
}

pub trait RegisterSettingsUi {
    /// Side panel for a settings tab (e.g. a crosshair preview on "Gameplay").
    fn settings_panel(&mut self, tab: &'static str, build: PanelBuilder) -> &mut Self;
    /// Make `R::default()` available to "Reset tab" (for fields whose `get` reads `R`).
    fn settings_defaults<R: Resource + Default>(&mut self) -> &mut Self;
}

impl RegisterSettingsUi for App {
    fn settings_panel(&mut self, tab: &'static str, build: PanelBuilder) -> &mut Self {
        let mut p = self.world_mut().get_resource_or_insert_with(SettingsPanels::default);
        p.0.retain(|(t, _)| *t != tab);
        p.0.push((tab, build));
        self
    }
    fn settings_defaults<R: Resource + Default>(&mut self) -> &mut Self {
        let mut d = self.world_mut().get_resource_or_insert_with(SettingsDefaults::default);
        let f: fn(&mut World) = insert_default::<R>;
        if !d.0.iter().any(|g| std::ptr::fn_addr_eq(*g, f)) {
            d.0.push(f);
        }
        self
    }
}

/// Tab index whose fields should be reset (set by `screen_logic`, done by [`reset_tab`]).
#[derive(Resource, Default, Debug)]
pub struct PendingReset(pub Option<usize>);

pub(crate) struct SettingsScreenPlugin;

impl Plugin for SettingsScreenPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<SettingsPanels>()
            .init_resource::<SettingsDefaults>()
            .init_resource::<PendingReset>()
            .add_systems(Update, update_about_card.after(super::UiSet::Paint).run_if(super::ui_visible));
    }
}

/// Tabs shown on the settings screen.
pub fn settings_tabs(reg: Option<&SettingsRegistry>, bindings: Option<&Bindings>) -> Vec<&'static str> {
    let mut tabs = reg.map(|r| r.tabs.clone()).unwrap_or_default();
    if bindings.is_some_and(|b| !b.0.is_empty()) && !tabs.contains(&"Controls") {
        tabs.push("Controls");
    }
    tabs
}

#[derive(Component)]
struct AboutTitle;
#[derive(Component)]
struct AboutBody;
#[derive(Component)]
struct AboutDetail;

/// Built-in "settings" screen.
pub fn build(world: &mut World, root: Entity) {
    let t = world.resource::<Theme>().clone();
    let reg = world.get_resource::<SettingsRegistry>().cloned().unwrap_or_default();
    let bindings = world.get_resource::<Bindings>().cloned().unwrap_or_default();
    let tabs = settings_tabs(Some(&reg), Some(&bindings));
    let tab_i = world.resource::<super::screens::Screens>().tab.min(tabs.len().saturating_sub(1));
    let tab = tabs.get(tab_i).copied();
    let fields: Vec<FieldDef> = tab.map(|tb| reg.tab_fields(tb).cloned().collect()).unwrap_or_default();
    let in_game = world.get_resource::<State<AppState>>().is_some_and(|s| *s.get() == AppState::InGame);
    let can_reset = !fields.is_empty() && world.get_resource::<SettingsDefaults>().is_some_and(|d| !d.0.is_empty());
    // With actions, the "Controls" panel (current bindings + "Rebind controls") replaces the
    // read-only list.
    #[cfg(feature = "actions")]
    let has_actions = world.contains_resource::<crate::actions::ActionMap>();
    #[cfg(not(feature = "actions"))]
    let has_actions = false;
    let show_bindings = tab == Some("Controls") && !bindings.0.is_empty() && !has_actions;
    let tab_panel = tab.and_then(|tb| world.get_resource::<SettingsPanels>()?.0.iter().find(|(k, _)| *k == tb).map(|p| p.1));

    let pad = super::device_hints(world, &[("k", "")], &[("p", "")])[0].0 == "p";
    let mut side = None;
    world.commands().entity(root).with_children(|p| {
        // Stronger dim than the main menu: this is a reading screen.
        menu_backdrop(p, &t, if in_game { 0.80 } else { 0.62 }, 0.9);
        p.spawn((
            Node { position_type: PositionType::Absolute, left: px(EDGE), top: px(84), flex_direction: FlexDirection::Column, row_gap: px(GAP_M), ..default() },
            Pickable::IGNORE,
        ))
        .with_children(|col| {
            col.spawn(eyebrow(if in_game { "Paused" } else { "Options" }, t.accent));
            col.spawn(title("Settings", SIZE_H1, t.text));
            col.spawn((Node { column_gap: px(GAP_XS), margin: UiRect::new(px(-22), px(0), px(GAP_S), px(0)), ..default() }, Pickable::IGNORE))
                .with_children(|strip| {
                    for (i, name) in tabs.iter().enumerate() {
                        tab_button(strip, &t, name, i, i == tab_i);
                    }
                });
            col.spawn((Node { width: px(ROWS_W + GAP_XL + SIDE_W), ..default() }, Pickable::IGNORE)).with_child(rule(t.line));

            col.spawn((Node { column_gap: px(GAP_XL), margin: UiRect::top(px(GAP_M)), align_items: AlignItems::FlexStart, ..default() }, Pickable::IGNORE))
                .with_children(|body_row| {
                    body_row
                        .spawn((Node { width: px(ROWS_W), flex_direction: FlexDirection::Column, ..default() }, Pickable::IGNORE))
                        .with_children(|rows| {
                            rows.spawn((
                                ScrollList,
                                ScrollPosition::default(),
                                RelativeCursorPosition::default(),
                                Node {
                                    width: percent(100),
                                    max_height: px(ROWS_MAX_H),
                                    flex_direction: FlexDirection::Column,
                                    row_gap: px(6),
                                    overflow: Overflow::scroll_y(),
                                    ..default()
                                },
                            ))
                            .with_children(|list| {
                                for (i, f) in fields.iter().enumerate() {
                                    field_row(list, &t, f, i as u32 + 1);
                                }
                                if fields.is_empty() {
                                    let msg = if show_bindings { "Key bindings are listed on the right." } else { "Nothing to adjust on this tab." };
                                    list.spawn((text(msg, body(SIZE_BODY), t.text_muted), Node { margin: UiRect::vertical(px(GAP_M)), ..default() }));
                                }
                            });
                            rows.spawn((Node { column_gap: px(GAP_M), margin: UiRect::top(px(GAP_L)), ..default() }, Pickable::IGNORE))
                                .with_children(|b| {
                                    let n = fields.len() as u32;
                                    action_button(b, &t, "Back", UiAction::Back, Some(n + 1), false, 180.0);
                                    if can_reset {
                                        action_button(b, &t, "Reset tab", UiAction::ResetTab, Some(n + 2), false, 180.0);
                                    }
                                });
                        });
                    side = Some(
                        body_row
                            .spawn((Node { width: px(SIDE_W), flex_direction: FlexDirection::Column, row_gap: px(GAP_M), ..default() }, Pickable::IGNORE))
                            .id(),
                    );
                });
        });
        let mut hints: Vec<(&str, &str)> = Vec::new();
        if tabs.len() > 1 {
            hints.push((if pad { "LB / RB" } else { "Q / E" }, "Switch tab"));
        }
        if pad {
            hints.extend([("D-pad", "Select"), ("A", "Adjust"), ("B", "Back")]);
        } else {
            hints.extend([("W / S", "Select"), ("A / D", "Adjust"), ("Esc", "Back")]);
        }
        spawn_footer(p, &t, &hints);
    });
    world.flush();
    let Some(side) = side else { return };
    if let Some(build) = tab_panel {
        build(world, side);
    }
    world.commands().entity(side).with_children(|s| {
        if show_bindings {
            s.spawn(panel(&t, 22.0, GAP_S)).with_children(|card| {
                card.spawn(eyebrow("Key bindings", t.text_muted));
                for (action, keys) in &bindings.0 {
                    card.spawn((Node { justify_content: JustifyContent::SpaceBetween, column_gap: px(GAP_M), padding: UiRect::vertical(px(4)), ..default() }, Pickable::IGNORE))
                        .with_children(|r| {
                            r.spawn(text(*action, body(SIZE_SMALL + 1.0), t.text_muted));
                            r.spawn(text(*keys, body_bold(SIZE_SMALL + 1.0), t.text));
                        });
                }
            });
        }
        if !fields.is_empty() {
            s.spawn(panel(&t, 22.0, GAP_S)).with_children(|card| {
                card.spawn(eyebrow("About this setting", t.text_muted));
                card.spawn((AboutTitle, text("", label(26.0), t.text)));
                card.spawn((AboutBody, text("", body(SIZE_SMALL + 1.0), t.text_muted)));
                card.spawn((AboutDetail, text("", body(SIZE_TINY + 1.0), t.text_dim)));
            });
        }
    });
}

/// What the "About" card says for a field: (title, body, detail).
pub fn describe(def: &FieldDef, value: f32) -> (String, String, String) {
    let detail = match &def.kind {
        FieldKind::Toggle => super::tl("Enter toggles it; D turns it on, A off.").into_owned(),
        FieldKind::Slider { min, max, format, .. } => super::tl_fmt("settings-slider-help", &[("min", format(*min)), ("max", format(*max))], || {
            format!("{} to {}. A / D steps, or drag the bar.", format(*min), format(*max))
        }),
        FieldKind::Choice { options } => {
            let list = options.iter().map(|o| super::tl(o).into_owned()).collect::<Vec<_>>().join(" \u{b7} ");
            super::tl_fmt("settings-choice-help", &[("options", list.clone())], || format!("{list}. A / D to choose."))
        }
        FieldKind::Cards { options } => {
            let i = normalize(&def.kind, value) as usize;
            options.get(i).map_or_else(String::new, |(name, blurb)| {
                let (name, blurb) = (super::tl(name), super::tl(blurb));
                if blurb.is_empty() { name.into_owned() } else { format!("{name}: {blurb}") }
            })
        }
        FieldKind::Swatches { colors } => {
            super::tl_fmt("settings-swatch-help", &[("n", colors.len().to_string())], || format!("{} colours. A / D to pick.", colors.len()))
        }
    };
    let body = match (&def.kind, def.hint.is_empty()) {
        (_, false) => super::tl(def.hint).into_owned(),
        // "#3" says nothing; the swatch row already shows the colour.
        (FieldKind::Swatches { .. }, true) => String::new(),
        (_, true) => {
            let v = format_value(&def.kind, value);
            super::tl_fmt("settings-currently", &[("value", v.clone())], || format!("Currently {v}."))
        }
    };
    (super::tl(def.label).to_uppercase(), body, detail)
}

/// Keep the "About this setting" card on the focused row.
fn update_about_card(
    focus: Res<Focus>,
    rows: Query<&FieldRow>,
    reg: Option<Res<SettingsRegistry>>,
    values: Res<FieldValues>,
    mut titles: Query<&mut Text, (With<AboutTitle>, Without<AboutBody>, Without<AboutDetail>)>,
    mut bodies: Query<&mut Text, (With<AboutBody>, Without<AboutTitle>, Without<AboutDetail>)>,
    mut details: Query<&mut Text, (With<AboutDetail>, Without<AboutTitle>, Without<AboutBody>)>,
) {
    if titles.is_empty() {
        return;
    }
    let def = focus.0.and_then(|e| rows.get(e).ok()).and_then(|r| reg.as_deref()?.field(r.0));
    let (a, b, c) = match def {
        Some(d) => describe(d, values.get(d.key)),
        None => (super::tl("Settings").to_uppercase(), super::tl("Changes apply right away and are saved automatically.").into_owned(), String::new()),
    };
    set_texts(titles.iter_mut(), &a);
    set_texts(bodies.iter_mut(), &b);
    set_texts(details.iter_mut(), &c);
}

fn set_texts<'a>(texts: impl Iterator<Item = Mut<'a, Text>>, s: &str) {
    for mut t in texts {
        if t.0 != s {
            t.0 = s.to_string();
        }
    }
}

/// Built-in "Video" panel: what each quality preset turns on (from [`QualityPreset`]).
pub fn quality_presets_panel(world: &mut World, slot: Entity) {
    let Some(q) = world.get_resource::<QualityPreset>().cloned() else { return };
    let t = world.resource::<Theme>().clone();
    world.commands().entity(slot).with_children(|s| {
        s.spawn(panel(&t, 22.0, GAP_S)).with_children(|card| {
            card.spawn(eyebrow("Quality presets", t.text_muted));
            for (i, name) in ["Low", "Medium", "High", "Ultra"].iter().enumerate() {
                card.spawn((Node { flex_direction: FlexDirection::Column, padding: UiRect::vertical(px(3)), ..default() }, Pickable::IGNORE))
                    .with_children(|r| {
                        r.spawn(text(super::tl(name).to_uppercase(), label(SIZE_LABEL), t.text));
                        r.spawn(text(preset_summary(&q, i), body(SIZE_TINY + 1.0), t.text_muted));
                    });
            }
        });
    });
}

/// One line per preset: "Temporal AA, ambient occlusion, bloom, 2048 px shadows."
pub fn preset_summary(q: &QualityPreset, i: usize) -> String {
    let aa = super::tl(if q.taa[i] { "Temporal AA" } else { "FXAA" });
    let ao = super::tl(if q.ssao[i] { "ambient occlusion" } else { "no ambient occlusion" });
    let bloom = super::tl(if q.bloom[i] { "bloom" } else { "no bloom" });
    let px = q.shadow_map_size[i].to_string();
    super::tl_fmt("quality-summary", &[("aa", aa.to_string()), ("ao", ao.to_string()), ("bloom", bloom.to_string()), ("px", px.clone())], || {
        format!("{aa}, {ao}, {bloom}, {px} px shadows.")
    })
}

/// Apply a pending "Reset tab": defaults come from a scratch world built by [`SettingsDefaults`].
pub(crate) fn reset_tab(world: &mut World) {
    let Some(i) = world.resource_mut::<PendingReset>().0.take() else { return };
    let reg = world.get_resource::<SettingsRegistry>().cloned().unwrap_or_default();
    let tabs = settings_tabs(Some(&reg), world.get_resource::<Bindings>());
    let Some(tab) = tabs.get(i).copied() else { return };
    let mut scratch = World::new();
    for insert in world.get_resource::<SettingsDefaults>().map(|d| d.0.clone()).unwrap_or_default() {
        insert(&mut scratch);
    }
    for def in reg.tab_fields(tab) {
        match catch_unwind(AssertUnwindSafe(|| (def.get)(&scratch))) {
            Ok(v) => (def.set)(world, normalize(&def.kind, v)),
            Err(_) => warn!("settings: no default for '{}' (register its resource with settings_defaults)", def.key),
        }
    }
    world.write_message(SaveSettings);
    let shown = super::tl(tab).into_owned();
    world.write_message(Toast::new(super::tl_fmt("settings-tab-reset", &[("tab", shown.clone())], || format!("{shown} reset to defaults"))));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controls_tab_appears_for_bindings() {
        let mut reg = SettingsRegistry { tabs: vec!["Video", "Audio"], ..Default::default() };
        assert_eq!(settings_tabs(Some(&reg), None), ["Video", "Audio"]);
        let b = Bindings(vec![("Move", "W A S D")]);
        assert_eq!(settings_tabs(Some(&reg), Some(&b)), ["Video", "Audio", "Controls"]);
        reg.tabs.insert(0, "Controls");
        assert_eq!(settings_tabs(Some(&reg), Some(&b)), ["Controls", "Video", "Audio"]);
    }

    #[test]
    fn about_text() {
        let def = FieldDef {
            key: "fov",
            tab: "Video",
            label: "Field of view",
            hint: "",
            kind: FieldKind::Slider { min: 60.0, max: 110.0, step: 1.0, format: |v| format!("{v:.0}\u{b0}") },
            get: |_| 80.0,
            set: |_, _| {},
        };
        let (title, body, detail) = describe(&def, 80.0);
        assert_eq!(title, "FIELD OF VIEW");
        assert_eq!(body, "Currently 80\u{b0}.");
        assert!(detail.starts_with("60\u{b0} to 110\u{b0}"));
        let q = QualityPreset::default();
        assert!(preset_summary(&q, 0).starts_with("FXAA, no ambient occlusion"));
    }
}
