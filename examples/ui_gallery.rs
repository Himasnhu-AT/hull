//! UI kit gallery: the engine's main menu, settings, pause menu, a game-registered setup screen,
//! side panels and toasts, on a bare `App` (no core `app()` needed).
//!
//! ```text
//! cargo run --example ui_gallery                                   # interactive window
//! cargo run --example ui_gallery -- --shot /tmp/s.png --screen settings --tab 2 --nav down,down
//! cargo run --example ui_gallery -- --shot /tmp/p.png --state game --screen pause
//! ```
//! `--shot <png>` renders offscreen (hidden window, camera → 1920×1080 image), saves after
//! `--frames` (default 45) and exits. `--toast` posts two toasts. `--accent r,g,b` re-brands.

use bevy::camera::RenderTarget;
use bevy::prelude::*;
use bevy::render::render_resource::{TextureFormat, TextureUsages};
use bevy::render::view::window::screenshot::{Screenshot, ScreenshotCaptured, save_to_disk};
use bevy::ui::IsDefaultUiCamera;

use engine::app::GameInfo;
use engine::cli::{arg_value, has_flag};
use engine::flow::{AppState, Headless, PauseAllowed};
use engine::gfx::QualityPreset;
use engine::input::Bindings;
use engine::pause::Paused;
use engine::settings::{CoreSettings, FieldDef, FieldKind, GraphicsQuality, RegisterSettings, WindowModeSetting};
use engine::ui::UiKitPlugin;
use engine::ui::menus::{MenuAction, MenuConfig, MenuEvent};
use engine::ui::screens::{RegisterScreen, ScreenRegistry, ScreenRequest};
use engine::ui::settings_screen::RegisterSettingsUi;
use engine::ui::theme::*;
use engine::ui::toast::Toast;
use engine::ui::widgets::{NavInput, NavQueue, UiAction, action_button, card_row};

// ---- demo game settings ----

#[derive(Resource, Clone, Debug)]
struct Demo {
    difficulty: usize,
    map: usize,
    callouts: bool,
    crosshair: usize,
    crosshair_size: f32,
}

impl Default for Demo {
    fn default() -> Self {
        Demo { difficulty: 1, map: 0, callouts: true, crosshair: 0, crosshair_size: 1.0 }
    }
}

const DIFFICULTIES: [(&str, &str); 4] = [
    ("Recruit", "Slow reactions, poor aim. Learn the maps."),
    ("Regular", "A fair fight. The squad adapts as you play."),
    ("Veteran", "Sharp aim, smart flanks."),
    ("Elite", "They punish every mistake."),
];
const MAPS: [(&str, &str); 3] = [
    ("Yard", "Open lanes and shipping containers."),
    ("Depot", "Tight corridors, long sightlines."),
    ("Ridge", "High ground and broken cover."),
];
const CROSSHAIRS: [[f32; 3]; 6] =
    [[0.4, 1.0, 0.6], [0.35, 0.9, 1.0], [1.0, 1.0, 1.0], [1.0, 0.92, 0.3], [1.0, 0.4, 0.95], [1.0, 0.3, 0.3]];
const QUALITIES: [GraphicsQuality; 4] = [GraphicsQuality::Low, GraphicsQuality::Medium, GraphicsQuality::High, GraphicsQuality::Ultra];
const MODES: [WindowModeSetting; 3] = [WindowModeSetting::Windowed, WindowModeSetting::Borderless, WindowModeSetting::Fullscreen];

fn b(v: bool) -> f32 {
    if v { 1.0 } else { 0.0 }
}
fn pct(v: f32) -> String {
    format!("{:.0}%", v * 100.0)
}
fn two(v: f32) -> String {
    format!("{v:.2}")
}
fn deg(v: f32) -> String {
    format!("{v:.0}\u{b0}")
}
fn cs(w: &World) -> &CoreSettings {
    w.resource::<CoreSettings>()
}
fn cs_mut(w: &mut World) -> Mut<'_, CoreSettings> {
    w.resource_mut::<CoreSettings>()
}
fn demo(w: &World) -> &Demo {
    w.resource::<Demo>()
}
fn demo_mut(w: &mut World) -> Mut<'_, Demo> {
    w.resource_mut::<Demo>()
}

fn row(key: &'static str, tab: &'static str, label: &'static str, hint: &'static str, kind: FieldKind, get: fn(&World) -> f32, set: fn(&mut World, f32)) -> FieldDef {
    FieldDef { key, tab, label, hint, kind, get, set }
}

fn register_fields(app: &mut App) {
    let fields = [
        row(
            "difficulty",
            "Gameplay",
            "Difficulty",
            "Applies from the next round.",
            FieldKind::Cards { options: DIFFICULTIES.to_vec() },
            |w| demo(w).difficulty as f32,
            |w, v| demo_mut(w).difficulty = v as usize,
        ),
        row("map", "Gameplay", "Map", "", FieldKind::Cards { options: MAPS.to_vec() }, |w| demo(w).map as f32, |w, v| demo_mut(w).map = v as usize),
        row("show_callouts", "Gameplay", "Squad callouts", "Show enemy radio chatter as subtitles.", FieldKind::Toggle, |w| b(demo(w).callouts), |w, v| {
            demo_mut(w).callouts = v > 0.5
        }),
        row(
            "crosshair_color",
            "Gameplay",
            "Crosshair colour",
            "",
            FieldKind::Swatches { colors: CROSSHAIRS.to_vec() },
            |w| demo(w).crosshair as f32,
            |w, v| demo_mut(w).crosshair = v as usize,
        ),
        row(
            "crosshair_size",
            "Gameplay",
            "Crosshair size",
            "",
            FieldKind::Slider { min: 0.5, max: 2.0, step: 0.1, format: two },
            |w| demo(w).crosshair_size,
            |w, v| demo_mut(w).crosshair_size = v,
        ),
        row(
            "sensitivity",
            "Controls",
            "Mouse sensitivity",
            "",
            FieldKind::Slider { min: 0.1, max: 4.0, step: 0.05, format: two },
            |w| cs(w).sensitivity,
            |w, v| cs_mut(w).sensitivity = v,
        ),
        row("invert_y", "Controls", "Invert look", "Mouse up looks down.", FieldKind::Toggle, |w| b(cs(w).invert_y), |w, v| cs_mut(w).invert_y = v > 0.5),
        row(
            "quality",
            "Video",
            "Graphics quality",
            "Ambient occlusion, anti-aliasing, shadows, bloom.",
            FieldKind::Choice { options: vec!["Low", "Medium", "High", "Ultra"] },
            |w| QUALITIES.iter().position(|q| *q == cs(w).quality).unwrap_or(2) as f32,
            |w, v| cs_mut(w).quality = QUALITIES[v as usize],
        ),
        row(
            "fov",
            "Video",
            "Field of view",
            "Horizontal-ish; wider shows more, smaller targets.",
            FieldKind::Slider { min: 60.0, max: 110.0, step: 1.0, format: deg },
            |w| cs(w).fov_deg,
            |w, v| cs_mut(w).fov_deg = v,
        ),
        row(
            "window_mode",
            "Video",
            "Display mode",
            "",
            FieldKind::Choice { options: vec!["Windowed", "Borderless", "Fullscreen"] },
            |w| MODES.iter().position(|m| *m == cs(w).window_mode).unwrap_or(0) as f32,
            |w, v| cs_mut(w).window_mode = MODES[v as usize],
        ),
        row("vsync", "Video", "V-Sync", "Off for lowest latency; may tear.", FieldKind::Toggle, |w| b(cs(w).vsync), |w, v| cs_mut(w).vsync = v > 0.5),
        row("show_fps", "Video", "FPS counter", "Small counter in the top-right corner.", FieldKind::Toggle, |w| b(cs(w).show_fps), |w, v| {
            cs_mut(w).show_fps = v > 0.5
        }),
        row(
            "ui_scale",
            "Video",
            "Interface size",
            "On top of the automatic size for your window.",
            FieldKind::Slider { min: 0.75, max: 1.5, step: 0.05, format: pct },
            |w| cs(w).ui_scale,
            |w, v| cs_mut(w).ui_scale = v,
        ),
        row("master_volume", "Audio", "Master volume", "", vol(), |w| cs(w).master_volume, |w, v| cs_mut(w).master_volume = v),
        row("sfx_volume", "Audio", "Effects", "Gunfire, footsteps, hits.", vol(), |w| cs(w).sfx_volume, |w, v| cs_mut(w).sfx_volume = v),
        row("music_volume", "Audio", "Music", "", vol(), |w| cs(w).music_volume, |w, v| cs_mut(w).music_volume = v),
        row("ambience_volume", "Audio", "Ambience", "Background bed.", vol(), |w| cs(w).ambience_volume, |w, v| cs_mut(w).ambience_volume = v),
    ];
    for f in fields {
        app.register_setting(f);
    }
    app.set_settings_tabs(&["Gameplay", "Controls", "Video", "Audio"]);
}

fn vol() -> FieldKind {
    FieldKind::Slider { min: 0.0, max: 1.0, step: 0.05, format: pct }
}

// ---- game screens / panels ----

fn build_setup(world: &mut World, root: Entity) {
    let t = world.resource::<Theme>().clone();
    let reg = world.resource::<engine::settings::SettingsRegistry>();
    let (Some(diff), Some(map)) = (reg.field("difficulty").cloned(), reg.field("map").cloned()) else { return };
    world.commands().entity(root).with_children(|p| {
        menu_backdrop(p, &t, 0.0, 1.0);
        p.spawn(menu_column(GAP_M)).with_children(|col| {
            col.spawn(eyebrow("Play", t.accent));
            col.spawn(title("Match setup", SIZE_H1, t.text));
            col.spawn(text("Best of three rounds. Afterwards the squad trains against your ghost.", body(SIZE_BODY), t.text_muted));
            col.spawn(spacer(GAP_L - GAP_M));
            col.spawn(eyebrow("Difficulty", t.text_muted));
            card_row(col, &t, &diff, 1, 272.0);
            col.spawn(spacer(0.0));
            col.spawn(eyebrow("Map", t.text_muted));
            card_row(col, &t, &map, 2, 368.0);
            col.spawn(spacer(GAP_L - GAP_M));
            col.spawn((Node { column_gap: px(GAP_M), align_items: AlignItems::Center, ..default() }, Pickable::IGNORE)).with_children(|r| {
                action_button(r, &t, "Start match", MenuAction::Custom("start_match"), Some(3), true, 320.0);
                action_button(r, &t, "Back", UiAction::Back, Some(4), false, 160.0);
            });
        });
        spawn_footer(p, &t, &[("W / S", "Row"), ("A / D", "Choose"), ("Enter", "Start"), ("Esc", "Back")]);
    });
}

fn stats_panel(world: &mut World, slot: Entity) {
    let t = world.resource::<Theme>().clone();
    world.commands().entity(slot).with_children(|s| {
        s.spawn(accent_panel(&t, t.info, 22.0, GAP_S)).with_children(|p| {
            p.spawn(eyebrow("Enemy brain", t.info));
            p.spawn((Node { align_items: AlignItems::Baseline, column_gap: px(GAP_M), ..default() }, Pickable::IGNORE)).with_children(|r| {
                r.spawn(text("GEN 4", display(52.0), t.text));
                r.spawn(text("2388 sim rounds", body(SIZE_SMALL), t.text_muted));
            });
            p.spawn(rule(t.line));
            p.spawn((Node { column_gap: px(GAP_L), ..default() }, Pickable::IGNORE)).with_children(|r| {
                for (name, v, c) in [("Your wins", "3", t.good), ("Their wins", "2", t.bad), ("Matches", "5", t.text)] {
                    r.spawn((Node { flex_direction: FlexDirection::Column, ..default() }, Pickable::IGNORE)).with_children(|st| {
                        st.spawn(text(v, display(34.0), c));
                        st.spawn(text(name.to_uppercase(), label(SIZE_TINY), t.text_dim));
                    });
                }
            });
            p.spawn(text("Last match: you won 2-1", body(SIZE_SMALL), t.text_muted));
        });
    });
}

fn pause_score(world: &mut World, slot: Entity) {
    let t = world.resource::<Theme>().clone();
    world.commands().entity(slot).with_children(|s| {
        s.spawn((Node { column_gap: px(GAP_M), align_items: AlignItems::Baseline, ..default() }, Pickable::IGNORE)).with_children(|r| {
            r.spawn(text("YOU", label(SIZE_LABEL), t.text_muted));
            r.spawn(text("1", display(34.0), t.good));
            r.spawn(text("\u{2013}", display(34.0), t.text_dim));
            r.spawn(text("0", display(34.0), t.bad));
            r.spawn(text("SQUAD", label(SIZE_LABEL), t.text_muted));
            r.spawn(text("First to 2 \u{b7} Regular \u{b7} Gen 4", body(SIZE_SMALL), t.text_muted));
        });
    });
}

#[derive(Component)]
struct PreviewBar;

fn crosshair_preview(world: &mut World, slot: Entity) {
    let t = world.resource::<Theme>().clone();
    world.commands().entity(slot).with_children(|s| {
        s.spawn(panel(&t, 22.0, GAP_M)).with_children(|card| {
            card.spawn(eyebrow("Crosshair preview", t.text_muted));
            card.spawn((
                Node { width: percent(100), height: px(200), justify_content: JustifyContent::Center, align_items: AlignItems::Center, border_radius: BorderRadius::all(px(3)), ..default() },
                BackgroundGradient::from(LinearGradient::new(
                    std::f32::consts::PI,
                    vec![
                        ColorStop::new(Color::srgb(0.62, 0.66, 0.72), percent(0)),
                        ColorStop::new(Color::srgb(0.46, 0.47, 0.48), percent(50)),
                        ColorStop::new(Color::srgb(0.2, 0.21, 0.22), percent(100)),
                    ],
                )),
                Pickable::IGNORE,
            ))
            .with_children(|bx| {
                for (w, h, x, y) in [(10.0, 2.0, -12.0, 0.0), (10.0, 2.0, 12.0, 0.0), (2.0, 10.0, 0.0, -12.0), (2.0, 10.0, 0.0, 12.0)] {
                    bx.spawn((
                        PreviewBar,
                        Node { position_type: PositionType::Absolute, width: px(w), height: px(h), left: px(x), top: px(y), ..default() },
                        BackgroundColor(Color::WHITE),
                        Pickable::IGNORE,
                    ));
                }
            });
        });
    });
}

/// Live preview: the game keeps its own panel in sync.
fn update_preview(demo: Res<Demo>, mut bars: Query<(&mut BackgroundColor, &mut UiTransform), With<PreviewBar>>) {
    let c = CROSSHAIRS[demo.crosshair.min(CROSSHAIRS.len() - 1)];
    for (mut bg, mut tf) in &mut bars {
        bg.0 = Color::srgb(c[0], c[1], c[2]);
        tf.scale = Vec2::splat(demo.crosshair_size * 2.0);
    }
}

// ---- scene + script ----

#[derive(Resource)]
struct ShotTarget(Handle<Image>);

fn scene(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<StandardMaterial>>, mut images: ResMut<Assets<Image>>) {
    let mut cam = commands.spawn((Camera3d::default(), Transform::from_xyz(-2.0, 1.7, 7.0).looking_at(Vec3::new(1.5, 1.0, 0.0), Vec3::Y)));
    if arg_value("shot").is_some() {
        let mut image = Image::new_target_texture(1920, 1080, TextureFormat::Rgba8UnormSrgb, None);
        image.texture_descriptor.usage |= TextureUsages::COPY_SRC;
        let handle = images.add(image);
        cam.insert((RenderTarget::from(handle.clone()), IsDefaultUiCamera));
        commands.insert_resource(ShotTarget(handle));
    }
    commands.spawn((Mesh3d(meshes.add(Plane3d::default().mesh().size(60.0, 60.0))), MeshMaterial3d(mats.add(Color::srgb(0.36, 0.33, 0.3)))));
    let crate_mat = mats.add(Color::srgb(0.2, 0.32, 0.28));
    let wall_mat = mats.add(Color::srgb(0.62, 0.55, 0.42));
    commands.spawn((Mesh3d(meshes.add(Cuboid::new(2.4, 2.4, 2.4))), MeshMaterial3d(crate_mat), Transform::from_xyz(-0.5, 1.2, -1.0)));
    commands.spawn((Mesh3d(meshes.add(Cuboid::new(14.0, 0.9, 0.8))), MeshMaterial3d(wall_mat.clone()), Transform::from_xyz(5.0, 0.45, -3.0)));
    commands.spawn((Mesh3d(meshes.add(Cuboid::new(30.0, 3.0, 0.6))), MeshMaterial3d(wall_mat), Transform::from_xyz(2.0, 1.5, -12.0)));
    commands.spawn((
        DirectionalLight { illuminance: 9000.0, shadows_enabled: true, ..default() },
        Transform::from_xyz(4.0, 8.0, 3.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
}

fn script(world: &mut World, mut frame: Local<u32>, mut nav: Local<Vec<NavInput>>) {
    *frame += 1;
    let f = *frame;
    if f == 3 {
        if let Some(name) = arg_value("screen") {
            match world.resource::<ScreenRegistry>().id(&name) {
                Some(id) => {
                    world.write_message(ScreenRequest::Push(id));
                }
                None => warn!("gallery: no screen '{name}'"),
            }
        }
        if let Some(t) = arg_value("tab").and_then(|t| t.parse().ok()) {
            world.write_message(ScreenRequest::SetTab(t));
        }
        *nav = arg_value("nav").map(|s| s.split(',').filter_map(NavInput::parse).collect()).unwrap_or_default();
        nav.reverse();
    }
    if f >= 6 && f % 2 == 0
        && let Some(i) = nav.pop()
    {
        world.resource_mut::<NavQueue>().0.push(i);
    }
    if f == 12 && has_flag("toast") {
        world.write_message(Toast::new("Settings saved"));
        let good = world.resource::<Theme>().good;
        world.write_message(Toast::new("Achievement").body("First blood: win a round on Veteran.").color(good).secs(30.0));
    }
    let shoot_at: u32 = arg_value("frames").and_then(|s| s.parse().ok()).unwrap_or(45);
    if f == shoot_at
        && let Some(path) = arg_value("shot")
    {
        let target = world.resource::<ShotTarget>().0.clone();
        world.spawn(Screenshot::image(target)).observe(save_to_disk(path)).observe(|_: On<ScreenshotCaptured>, mut exit: MessageWriter<AppExit>| {
            exit.write(AppExit::Success);
        });
    }
}

fn on_menu_events(mut events: MessageReader<MenuEvent>, mut next: ResMut<NextState<AppState>>, mut toasts: MessageWriter<Toast>) {
    for MenuEvent(id) in events.read() {
        match *id {
            "start_match" => next.set(AppState::InGame),
            other => {
                toasts.write(Toast::new(format!("Menu event: {other}")));
            }
        }
    }
}

fn main() {
    let shot = arg_value("shot").is_some();
    let mut app = App::new();
    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: Some(Window { title: "engine · UI gallery".into(), resolution: (1600u32, 900u32).into(), visible: !shot, ..default() }),
        ..default()
    }));
    let accent = arg_value("accent").and_then(|s| {
        let v: Vec<f32> = s.split(',').filter_map(|x| x.parse().ok()).collect();
        (v.len() == 3).then(|| Color::srgb(v[0], v[1], v[2]))
    });
    app.insert_resource(GameInfo::new("ui_gallery", "Shroud").tagline("They learn from you."))
        .insert_resource(Headless(false))
        .insert_resource(CoreSettings { show_fps: true, ..default() })
        .insert_resource(Demo::default())
        .insert_resource(QualityPreset::default())
        .insert_resource(ClearColor(Color::srgb(0.42, 0.47, 0.55)))
        .insert_resource(Theme::default().with_accent(accent.unwrap_or(Theme::default().accent)))
        .insert_resource(Bindings(vec![
            ("Move", "W A S D"),
            ("Look", "Mouse"),
            ("Fire", "Left mouse"),
            ("Reload", "R"),
            ("Jump", "Space"),
            ("Crouch", "Ctrl / C"),
            ("Sprint", "Shift"),
            ("Pause", "Esc"),
        ]))
        .insert_resource(MenuConfig {
            eyebrow: "Adaptive squad shooter",
            main_items: vec![("Play", MenuAction::Open("setup")), ("Settings", MenuAction::Settings), ("Quit", MenuAction::Quit)],
            pause_items: vec![
                ("Resume", MenuAction::Resume),
                ("Settings", MenuAction::Settings),
                ("Restart match", MenuAction::Custom("restart")),
                ("Main menu", MenuAction::MainMenu),
                ("Quit game", MenuAction::Quit),
            ],
            pause_note: "Restarting or leaving abandons this match; the squad does not train on it.",
            main_panel: Some(stats_panel),
            pause_header: Some(pause_score),
        })
        .init_resource::<Paused>()
        .init_resource::<PauseAllowed>()
        .insert_state(if arg_value("state").as_deref() == Some("game") { AppState::InGame } else { AppState::MainMenu });
    register_fields(&mut app);
    app.add_plugins(UiKitPlugin)
        .register_screen("setup", build_setup)
        .settings_panel("Gameplay", crosshair_preview)
        .settings_defaults::<Demo>()
        .add_systems(Startup, scene)
        .add_systems(Update, (script, on_menu_events, update_preview))
        .run();
}
