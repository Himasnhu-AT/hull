//! OS integration demo: platform info, a text field (IME), and buttons to save a screenshot to
//! Pictures with metadata, open that folder, and copy the field's text to the clipboard.
//!
//! `cargo run --example platform_demo -- --play` (add `--platform-root <dir>` to keep the files
//! out of your real Pictures folder). Drive it: `python3 -I scripts/play.py scripts/platform-demo.json
//! --example platform_demo -- --platform-root /tmp/platform-demo`. Offscreen runs use the null OS
//! (no Finder window); set `PLATFORM_NATIVE=1` to use the real one.

use engine::platform::{GameFolders, Platform, SaveScreenshot, ScreenshotSaved, ShotStatus, TextFocus, TextInput, UserDir, WindowInfo, WindowSettings, glyphs::Glyphs};
use bevy::picking::events::PointerClick;
use engine::prelude::*;
use engine::ui::theme::*;

#[derive(Message, Component, Clone, Copy)]
enum Act {
    Screenshot,
    OpenFolder,
    Copy,
}

#[derive(Component)]
struct InfoText;

#[derive(Component)]
struct StatusText;

#[derive(Component)]
struct Field;

fn main() {
    let mut app = engine::app(GameInfo::new("platform-demo", "Platform Demo").tagline("Talk to the OS."));
    app.add_message::<Act>().add_systems(Startup, build_ui).add_systems(Update, (press, refresh, report));
    app.run();
}

fn text(s: impl Into<String>, size: f32, color: Color) -> impl Bundle {
    (Text::new(s), body(size), TextColor(color))
}

fn build_ui(mut commands: Commands, theme: Res<Theme>) {
    let t = theme.clone();
    commands
        .spawn(Node { width: percent(100), height: percent(100), justify_content: JustifyContent::Center, align_items: AlignItems::Center, ..default() })
        .with_children(|root| {
            root.spawn((
                Node { flex_direction: FlexDirection::Column, row_gap: px(GAP_M), padding: UiRect::all(px(GAP_L)), width: px(900), border_radius: BorderRadius::all(px(RADIUS)), ..default() },
                BackgroundColor(t.panel),
            ))
            .with_children(|p| {
                p.spawn(text("Platform", SIZE_H2, t.accent));
                p.spawn((InfoText, text("", SIZE_SMALL, t.text_muted)));
                p.spawn(text("Text field (click, type, IME works):", SIZE_LABEL, t.text));
                p.spawn((
                    Field,
                    TextInput::new().placeholder("type something...").max_chars(60),
                    Node { padding: UiRect::all(px(GAP_S)), border: UiRect::all(px(1)), ..default() },
                    BorderColor::all(t.line_strong),
                    BackgroundColor(t.raised),
                    text("", SIZE_BODY, t.text),
                ));
                p.spawn(Node { column_gap: px(GAP_M), ..default() }).with_children(|row| {
                    for (label, act) in [("Save screenshot to Pictures", Act::Screenshot), ("Open game folder", Act::OpenFolder), ("Copy text", Act::Copy)] {
                        row.spawn((act, Node { padding: UiRect::axes(px(GAP_M), px(GAP_S)), border_radius: BorderRadius::all(px(RADIUS)), ..default() }, BackgroundColor(t.accent)))
                            .observe(move |_: On<PointerClick>, mut acts: MessageWriter<Act>| {
                                acts.write(act);
                            })
                            .with_child(text(label, SIZE_LABEL, t.on_accent));
                    }
                });
                p.spawn((StatusText, text("", SIZE_SMALL, t.info)));
            });
        });
}

fn press(
    mut acts: MessageReader<Act>,
    field: Query<&TextInput, With<Field>>,
    mut shots: MessageWriter<SaveScreenshot>,
    folders: Res<GameFolders>,
    os: Res<Platform>,
    mut status: Query<&mut Text, With<StatusText>>,
) {
    for act in acts.read() {
        let msg = match act {
            Act::Screenshot => {
                shots.write(SaveScreenshot::new("platform-demo").meta("note", field.single().map(|f| f.text.clone()).unwrap_or_default()).meta("source", "platform_demo"));
                "capturing...".to_string()
            }
            Act::OpenFolder => match folders.ensure(UserDir::Pictures).map_err(|e| e.to_string()).and_then(|p| os.open_path(&p).map(|_| format!("opened {}", p.display()))) {
                Ok(m) | Err(m) => m,
            },
            Act::Copy => {
                let t = field.single().map(|f| f.text.clone()).unwrap_or_default();
                match os.clipboard_set(&t) {
                    Ok(()) => format!("copied {} chars; clipboard now: {:?}", t.chars().count(), os.clipboard_get().unwrap_or_default()),
                    Err(e) => e,
                }
            }
        };
        for mut s in &mut status {
            s.0 = msg.clone();
        }
    }
}

fn report(mut saved: MessageReader<ScreenshotSaved>, mut status: Query<&mut Text, With<StatusText>>) {
    for ScreenshotSaved(r) in saved.read() {
        for mut s in &mut status {
            s.0 = match r {
                Ok(p) => format!("saved {}", p.display()),
                Err(e) => format!("screenshot failed: {e}"),
            };
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn refresh(
    mut info: Query<&mut Text, (With<InfoText>, Without<StatusText>)>,
    folders: Res<GameFolders>,
    os: Res<Platform>,
    ws: Res<WindowSettings>,
    wi: Res<WindowInfo>,
    shots: Res<ShotStatus>,
    focus: Res<TextFocus>,
    glyphs: Glyphs,
) {
    let Ok(mut t) = info.single_mut() else { return };
    let s = format!(
        "OS layer: {}\nPictures: {}\nSaved games: {}\nWindow: {:?} scale {:.2} {}x{} focused {}\nCursor: {:?}   typing: {}\nPrompts ({}): {}\nScreenshots saved: {}",
        os.name(),
        folders.path(UserDir::Pictures).display(),
        folders.path(UserDir::SavedGames).display(),
        ws.mode,
        wi.scale_factor,
        wi.physical.x,
        wi.physical.y,
        wi.focused,
        ws.cursor,
        focus.0.is_some(),
        glyphs.device().name(),
        glyphs.bar(&[("pause", "Pause"), ("jump", "Jump")]),
        shots.count,
    );
    if t.0 != s {
        t.0 = s;
    }
}
