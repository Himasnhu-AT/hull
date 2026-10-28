//! The metrics window (dev builds with visuals): a second OS window "<title> — metrics" next to
//! the game window, charting every [`Metrics`] key and comparing this run with past runs.
//!
//! - Opens at start in plain dev runs. Never in `--headless`, `--offscreen`, `--control` or
//!   `--mcp` runs ([`crate::cli::test_driven`]) or with `--no-metrics-window`;
//!   `--metrics-window` forces it. [`MetricsWindowKey`] (default F4) or `metrics.window`
//!   toggles it. Closing it never quits the game; closing the game window quits both.
//! - With `--offscreen --metrics-window` the view renders into an image instead of a window
//!   (`metrics.screenshot` saves it), for tests and agents.
//! - Cost: the view redraws at most 4×/s ([`REFRESH`]). Its camera is active only on those
//!   frames; on the others Bevy skips the window entirely (no swap-chain acquire, no draw), so
//!   the window holds its last image. Its present mode is `AutoNoVsync`, so it never waits on
//!   the display. Its own CPU time per redraw is recorded as `perf.metrics_view_ms`.
//! - Layout: header (run info), featured charts ([`MetricsFeatured`]), every key grouped by
//!   prefix (scroll with the wheel), and the runs table ([`MetricsCompare`]): this run and the
//!   last runs' session stats with the change vs the previous comparable run.
//!
//! Input caveat: Bevy's keyboard/mouse state is global, so keys pressed while the metrics
//! window has focus also reach the game.

use std::time::{Duration, Instant};

use bevy::asset::{RenderAssetUsages, uuid_handle};
use bevy::camera::visibility::RenderLayers;
use bevy::camera::{ClearColorConfig, RenderTarget};
use bevy::diagnostic::FrameCount;
use bevy::image::ImageSampler;
use bevy::input::mouse::{MouseScrollUnit, MouseWheel};
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages};
use bevy::text::{Font, Justify, LineBreak, TextLayout};
use bevy::ui::UiTargetCamera;
use bevy::window::{Monitor, PresentMode, PrimaryMonitor, PrimaryWindow, WindowPosition, WindowRef};
use serde_json::{Value, json};

use super::control::{AddControlCommand, PendingReplies, ReplyId, params};
use super::metrics::{Metrics, Summary, Threshold, WINDOW_SECS};
use super::metrics_chart::{self as chart, Canvas, Col, Style};
use super::metrics_history::{MetricsHistory, RunInfo, SessionSummary, current, delta};
use crate::app::GameInfo;
use crate::cli::{dev_flag, test_driven};
use crate::flow::Headless;
use crate::paths::DataDir;
use crate::ui::theme::Theme;

/// Redraw period of the view.
pub const REFRESH: Duration = Duration::from_millis(250);
/// Default logical size of the window / offscreen image.
pub const SIZE: (u32, u32) = (1440, 900);
/// Render layer of the view's camera (sees no game sprites or gizmos).
const LAYER: usize = 29;
/// Width of one runs-table column / the key column, logical px.
const RUN_COL: f32 = 112.0;
const RUN_KEY: f32 = 290.0;
const MAX_RUN_ROWS: usize = 12;
/// Sparkline size, logical px.
const SPARK: (f32, f32) = (150.0, 18.0);
const FEAT_H: f32 = 72.0;
/// Height of a summary tile's chart.
const TILE_H: f32 = 40.0;

const FONT_BODY: Handle<Font> = uuid_handle!("8d0f0c4e-3b7a-4f61-9a43-6b1e2d7c5a01");
const FONT_LABEL: Handle<Font> = uuid_handle!("8d0f0c4e-3b7a-4f61-9a43-6b1e2d7c5a02");

const AMBER: Color = Color::srgb(1.0, 0.76, 0.30);

/// Key that opens / closes the metrics window (default F4).
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MetricsWindowKey(pub KeyCode);

impl Default for MetricsWindowKey {
    fn default() -> Self {
        MetricsWindowKey(KeyCode::F4)
    }
}

/// Extra keys drawn as big charts under the summary tiles (missing keys are skipped). Empty by
/// default: the tiles cover frame, CPU, GPU, memory and quality.
#[derive(Resource, Clone, Debug, Default)]
pub struct MetricsFeatured(pub Vec<&'static str>);

/// Rows of the runs table: `(key, stat)` with stat one of min/avg/p50/p95/max. A key ending
/// in `.` is a prefix (`("span.", "avg")` = every span). Games add theirs:
/// `app.world_mut().resource_mut::<MetricsCompare>().add("ai.think_ms", "avg")`.
#[derive(Resource, Clone, Debug)]
pub struct MetricsCompare(pub Vec<(String, &'static str)>);

impl MetricsCompare {
    pub fn add(&mut self, key: &str, stat: &'static str) -> &mut Self {
        self.0.push((key.to_string(), stat));
        self
    }
}

impl Default for MetricsCompare {
    fn default() -> Self {
        let rows: [(&str, &'static str); 12] = [
            ("frame.ms", "avg"),
            ("frame.ms", "p95"),
            ("frame.ms", "max"),
            ("cpu.process_pct", "avg"),
            ("gpu.pct", "avg"),
            ("mem.footprint_mb", "max"),
            ("ecs.entities", "avg"),
            ("render.meshes_visible", "avg"),
            ("render.culled_frustum", "avg"),
            ("render.lod_far", "avg"),
            ("render.cells_loaded", "avg"),
            ("span.", "avg"),
        ];
        MetricsCompare(rows.iter().map(|(k, s)| (k.to_string(), *s)).collect())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    Window,
    Image,
}

/// State of the view. `open` is what the user / commands want; the systems follow it.
#[derive(Resource)]
pub struct MetricsView {
    pub open: bool,
    /// Also show developer counters (GPU resources, ECS, monitor overhead).
    pub dev: bool,
    target: Target,
    window: Option<Entity>,
    camera: Option<Entity>,
    root: Option<Entity>,
    image: Option<Handle<Image>>,
    plan: Option<Plan>,
    slots: Vec<SlotKind>,
    charts: Vec<ChartInfo>,
    last: Option<Instant>,
    force: bool,
    /// EMA of the CPU time of one redraw, ms.
    pub cost_ms: f32,
    pub redraws: u64,
}

impl MetricsView {
    pub fn json(&self) -> Value {
        json!({
            "open": self.open,
            "dev": self.dev,
            "shown": self.camera.is_some(),
            "target": match self.target { Target::Window => "window", Target::Image => "image" },
            "redraw_ms": (self.cost_ms * 1000.0).round() / 1000.0,
            "redraws": self.redraws,
            "refresh_hz": 1.0 / REFRESH.as_secs_f32(),
        })
    }
}

/// Whether the view opens at start (see the module docs).
pub fn wanted_at_start() -> bool {
    dev_flag("metrics-window") || (!dev_flag("no-metrics-window") && !test_driven())
}

#[derive(Component)]
struct MetricsCamera;

#[derive(Component)]
struct MetricsScroll;

/// Text node filled from `MetricsView.slots[i]`.
#[derive(Component)]
struct Slot(usize);

#[derive(Clone, Debug, PartialEq)]
enum SlotKind {
    Info,
    /// Summary tile line: 0 = big value, 1..=3 = detail lines.
    Tile(Tile, u8),
    FeatValue(&'static str),
    FeatStats(&'static str),
    FeatAxis(usize),
    RowValue(&'static str),
    RowStat(&'static str, &'static str),
    RunHead(usize, u8),
    RunVal(usize, usize),
    RunDelta(usize, usize),
}

/// The summary tiles at the top, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tile {
    Frame,
    Cpu,
    Gpu,
    Limit,
    Mem,
    Quality,
}

impl Tile {
    const ALL: [Tile; 6] = [Tile::Frame, Tile::Cpu, Tile::Gpu, Tile::Limit, Tile::Mem, Tile::Quality];

    fn title(self) -> &'static str {
        match self {
            Tile::Frame => "FRAME",
            Tile::Cpu => "CPU",
            Tile::Gpu => "GPU",
            Tile::Limit => "BOTTLENECK",
            Tile::Mem => "MEMORY",
            Tile::Quality => "QUALITY",
        }
    }

    /// Key charted in the tile (`None`: detail lines instead).
    fn chart(self) -> Option<&'static str> {
        match self {
            Tile::Frame => Some("frame.ms"),
            Tile::Cpu => Some("cpu.machine_pct"),
            Tile::Gpu => Some("gpu.frame_ms"),
            Tile::Limit => None,
            Tile::Mem => Some("mem.footprint_mb"),
            Tile::Quality => Some("render.governor_level"),
        }
    }
}

/// Values the tiles need from outside the metrics store.
#[derive(Default)]
struct Live {
    budget_ms: f32,
    target_fps: f32,
    quality: Option<String>,
    governor_on: bool,
    level: usize,
    levels: usize,
    memory_level: usize,
    scale: f32,
    last: Option<(crate::render_budget::GovernorReason, Option<crate::render_budget::GovernorStep>)>,
}

struct ChartInfo {
    key: &'static str,
    handle: Handle<Image>,
    w: usize,
    h: usize,
    cols: usize,
    /// Axis label value of the last draw (featured charts).
    top: f32,
}

/// What the layout depends on; a change rebuilds the UI.
#[derive(Clone, Debug, PartialEq)]
struct Plan {
    featured: Vec<&'static str>,
    groups: [Vec<(String, Vec<&'static str>)>; 2],
    rows: Vec<(String, &'static str)>,
    run_cols: usize,
    size: (u32, u32),
    scale: u32,
}

pub(super) fn build(app: &mut App) {
    app.init_resource::<MetricsWindowKey>()
        .init_resource::<MetricsFeatured>()
        .init_resource::<MetricsCompare>()
        .add_control_command(
            "metrics.window",
            "Open or close the metrics window (no param: toggle)",
            params(&[
                ("on", "boolean", "open (true) or close (false)"),
                ("scroll", "number", "scroll the key list to this y (px)"),
                ("dev", "boolean", "also show developer counters (GPU resources, ECS, monitor)"),
            ]),
            window_cmd,
        )
        .add_deferred_control_command(
            "metrics.screenshot",
            "Save the metrics view as a PNG (open it first: --metrics-window or metrics.window)",
            params(&[("path", "string", "PNG path (default: <data dir>/screenshots/metrics-<frame>.png)")]),
            screenshot_cmd,
        );
}

pub(super) fn finish(app: &mut App) {
    let headless = app.world().get_resource::<Headless>().is_some_and(|h| h.0);
    let ui = app.is_plugin_added::<bevy::ui::UiPlugin>()
        && app.world().contains_resource::<Assets<Image>>()
        && app.world().contains_resource::<Assets<Font>>();
    if headless || !ui {
        return;
    }
    {
        let mut fonts = app.world_mut().resource_mut::<Assets<Font>>();
        let _ = fonts.insert(FONT_BODY.id(), Font::from_bytes(include_bytes!("../../assets/fonts/Barlow-Medium.ttf").to_vec()));
        let _ = fonts.insert(FONT_LABEL.id(), Font::from_bytes(include_bytes!("../../assets/fonts/BarlowCondensed-SemiBold.ttf").to_vec()));
    }
    app.insert_resource(MetricsView {
        open: wanted_at_start(),
        dev: false,
        target: if super::offscreen::enabled() { Target::Image } else { Target::Window },
        window: None,
        camera: None,
        root: None,
        image: None,
        plan: None,
        slots: Vec::new(),
        charts: Vec::new(),
        last: None,
        force: true,
        cost_ms: 0.0,
        redraws: 0,
    })
    .add_systems(Update, (toggle_key, sync_view, scroll, refresh).chain())
    .add_systems(Last, exit_with_primary);
}

fn toggle_key(keys: Option<Res<ButtonInput<KeyCode>>>, key: Res<MetricsWindowKey>, mut view: ResMut<MetricsView>) {
    if keys.is_some_and(|k| k.just_pressed(key.0)) {
        view.open = !view.open;
    }
}

/// Closing the game window quits even while the metrics window is open (Bevy's default only
/// exits once every window is closed).
fn exit_with_primary(primary: Query<(), With<PrimaryWindow>>, mut seen: Local<bool>, mut exit: MessageWriter<AppExit>) {
    if !primary.is_empty() {
        *seen = true;
    } else if *seen {
        *seen = false;
        exit.write(AppExit::Success);
    }
}

/// Spawns / despawns the window, camera and UI to match `view.open`.
fn sync_view(
    mut commands: Commands,
    mut view: ResMut<MetricsView>,
    mut images: ResMut<Assets<Image>>,
    windows: Query<&Window>,
    primary: Query<&Window, With<PrimaryWindow>>,
    monitors: Query<&Monitor, With<PrimaryMonitor>>,
    info: Option<Res<GameInfo>>,
    theme: Option<Res<Theme>>,
    frames: Res<FrameCount>,
) {
    // The user closed the window: tear down the rest, stay closed until asked again.
    if let Some(w) = view.window
        && windows.get(w).is_err()
    {
        view.window = None;
        view.open = false;
    }
    let shown = view.camera.is_some();
    if view.open == shown && !(shown && view.target == Target::Window && view.window.is_none()) {
        return;
    }
    if !view.open || shown {
        for e in [view.window.take(), view.camera.take(), view.root.take()].into_iter().flatten() {
            commands.entity(e).try_despawn();
        }
        view.plan = None;
        view.slots.clear();
        view.charts.clear();
        return;
    }
    let bg = theme.map_or_else(|| Theme::default().bg, |t| t.bg);
    let target = match view.target {
        Target::Window => {
            // Wait for the game window so the new one can sit next to it.
            let Ok(pw) = primary.single() else { return };
            if frames.0 < 3 {
                return;
            }
            let title = info.map_or("game".to_string(), |i| i.title.to_string());
            let w = commands.spawn((Name::new("Metrics window"), metrics_window(&title, pw, monitors.single().ok()))).id();
            view.window = Some(w);
            RenderTarget::Window(WindowRef::Entity(w))
        }
        Target::Image => {
            let mut image = Image::new_target_texture(SIZE.0, SIZE.1, TextureFormat::Rgba8UnormSrgb, None);
            image.texture_descriptor.usage |= TextureUsages::COPY_SRC;
            let h = images.add(image);
            view.image = Some(h.clone());
            RenderTarget::from(h)
        }
    };
    let cam = commands
        .spawn((
            Name::new("Metrics camera"),
            MetricsCamera,
            Camera2d,
            Camera { order: 100, is_active: false, clear_color: ClearColorConfig::Custom(bg), ..default() },
            target,
            Msaa::Off,
            RenderLayers::layer(LAYER),
        ))
        .id();
    view.camera = Some(cam);
    view.force = true;
}

/// "<title> — metrics", 1440×900 (smaller on small screens), right of the game window when
/// there is room, else at the right edge of the screen; never takes focus.
fn metrics_window(title: &str, game: &Window, monitor: Option<&Monitor>) -> Window {
    let mut size = SIZE;
    let mut position = WindowPosition::Automatic;
    if let Some(m) = monitor {
        let s = m.scale_factor.max(1.0);
        let (mw, mh) = (m.physical_width as f64 / s, m.physical_height as f64 / s);
        size = (size.0.min((mw * 0.92) as u32).max(900), size.1.min((mh * 0.88) as u32).max(600));
        let (pw, ph) = ((size.0 as f64 * s) as i32, (size.1 as f64 * s) as i32);
        let right_edge = m.physical_position.x + m.physical_width as i32;
        let mut x = right_edge - pw - (12.0 * s) as i32;
        let mut y = m.physical_position.y + (40.0 * s) as i32;
        if let WindowPosition::At(p) = game.position {
            let beside = p.x + game.physical_width() as i32 + (12.0 * s) as i32;
            if beside + pw <= right_edge {
                x = beside;
                y = p.y;
            }
        }
        y = y.min(m.physical_position.y + m.physical_height as i32 - ph).max(m.physical_position.y);
        position = WindowPosition::At(IVec2::new(x.max(m.physical_position.x), y));
    }
    Window {
        title: format!("{title} — metrics"),
        resolution: size.into(),
        position,
        focused: false,
        present_mode: PresentMode::AutoNoVsync,
        ..default()
    }
}

fn scroll(mut wheel: MessageReader<MouseWheel>, mut view: ResMut<MetricsView>, mut q: Query<&mut ScrollPosition, With<MetricsScroll>>) {
    let Some(win) = view.window else {
        wheel.clear();
        return;
    };
    let dy: f32 = wheel
        .read()
        .filter(|e| e.window == win)
        .map(|e| match e.unit {
            MouseScrollUnit::Line => e.y * 40.0,
            MouseScrollUnit::Pixel => e.y,
        })
        .sum();
    if dy != 0.0 {
        for mut p in &mut q {
            p.0.y = (p.0.y - dy).max(0.0);
        }
        view.force = true;
    }
}

/// At most every [`REFRESH`]: rebuild the layout if the keys changed, redraw charts and
/// texts, and let the camera render this one frame.
#[allow(clippy::too_many_arguments)]
fn refresh(
    mut commands: Commands,
    mut view: ResMut<MetricsView>,
    mut m: ResMut<Metrics>,
    (history, run, settings): (Option<Res<MetricsHistory>>, Option<Res<RunInfo>>, Option<Res<crate::settings::CoreSettings>>),
    (compare, featured, key): (Res<MetricsCompare>, Res<MetricsFeatured>, Res<MetricsWindowKey>),
    theme: Option<Res<Theme>>,
    windows: Query<&Window>,
    mut cams: Query<&mut Camera, With<MetricsCamera>>,
    mut texts: Query<(&Slot, &mut Text, &mut TextColor)>,
    mut images: ResMut<Assets<Image>>,
    live: LiveParams,
) {
    let Some(cam) = view.camera else { return };
    let Ok(mut camera) = cams.get_mut(cam) else { return };
    let due = view.force || view.last.is_none_or(|t| t.elapsed() >= REFRESH);
    if !due {
        if camera.is_active {
            camera.is_active = false;
        }
        return;
    }
    let t0 = Instant::now();
    let theme = theme.map(|t| t.clone()).unwrap_or_default();
    let (size, scale) = match (view.target, view.window.and_then(|w| windows.get(w).ok())) {
        (Target::Window, Some(w)) => ((w.width() as u32, w.height() as u32), w.scale_factor().clamp(1.0, 2.0)),
        (Target::Window, None) => return,
        (Target::Image, _) => (SIZE, 1.0),
    };
    let past: &[SessionSummary] = history.as_ref().map_or(&[], |h| &h.past);
    let plan = make_plan_dev(&m, past, &compare, &featured, size, scale, view.dev);
    if view.plan.as_ref() != Some(&plan) {
        if let Some(root) = view.root.take() {
            commands.entity(root).try_despawn();
        }
        let (root, slots, charts) = build_ui(&mut commands, &mut images, &plan, &theme, cam, key.0);
        view.root = Some(root);
        view.slots = slots;
        view.charts = charts;
        view.plan = Some(plan);
        // Filled and shown next frame, once the nodes exist.
        view.force = true;
        return;
    }
    let palette = Palette::new(&theme);

    // Charts.
    let now = m.now() as f32;
    let mut tops = Vec::with_capacity(view.charts.len());
    for c in &view.charts {
        let (Some(samples), Some(mut img)) = (m.recent_samples(c.key), images.get_mut(&c.handle)) else {
            tops.push(0.0);
            continue;
        };
        let Some(px) = img.data.as_mut() else { continue };
        let threshold = m.threshold(c.key);
        let cols: Vec<Option<Col>> = chart::columns(samples, now, WINDOW_SECS, c.cols);
        let zoom = threshold.is_none() || c.key.starts_with("mem.");
        let range = chart::y_range(&cols, threshold, zoom);
        let style = palette.chart_style(threshold.is_some(), scale, c.h as f32 >= 40.0 * scale);
        chart::draw(&mut Canvas { px, w: c.w, h: c.h }, &cols, range, threshold, &style);
        tops.push(range.1);
    }
    for (c, top) in view.charts.iter_mut().zip(tops) {
        c.top = top;
    }

    // Runs: this run first, then the past newest first.
    let quality = settings.map(|s| format!("{:?}", s.quality));
    let cur = run.as_ref().map(|r| current(&m, r, quality.clone(), "running"));
    let runs: Vec<&SessionSummary> = cur.iter().chain(past.iter().rev()).collect();
    let rows = view.plan.as_ref().map(|p| p.rows.clone()).unwrap_or_default();
    // One 60 s summary per key per redraw (each sorts up to a minute of samples).
    let recent: std::collections::HashMap<&'static str, Summary> = m.keys().filter_map(|k| m.recent(k).map(|s| (k, s))).collect();
    let live = live.get();
    let ctx = FillCtx { m: &m, recent: &recent, runs: &runs, rows: &rows, palette: &palette, view: &view, live: &live };
    for (slot, mut text, mut color) in &mut texts {
        let Some(kind) = view.slots.get(slot.0) else { continue };
        let (s, c) = ctx.fill(kind);
        if text.0 != s {
            text.0 = s;
        }
        if color.0 != c {
            color.0 = c;
        }
    }

    camera.is_active = true;
    view.last = Some(Instant::now());
    view.force = false;
    let ms = t0.elapsed().as_secs_f32() * 1000.0;
    view.cost_ms = if view.redraws == 0 { ms } else { view.cost_ms + 0.2 * (ms - view.cost_ms) };
    view.redraws += 1;
    m.record("perf.metrics_view_ms", ms as f64);
}

/// Resources behind [`Live`].
#[derive(bevy::ecs::system::SystemParam)]
struct LiveParams<'w> {
    governor: Option<Res<'w, crate::render_budget::QualityGovernor>>,
    state: Option<Res<'w, crate::render_budget::GovernorState>>,
    scale: Option<Res<'w, crate::render_budget::RenderScale>>,
    settings: Option<Res<'w, crate::settings::CoreSettings>>,
}

impl LiveParams<'_> {
    fn get(&self) -> Live {
        let target_fps = self.governor.as_ref().map_or(60.0, |g| g.target_fps).max(1.0);
        let st = self.state.as_deref();
        Live {
            budget_ms: 1000.0 / target_fps,
            target_fps,
            quality: self.settings.as_ref().map(|s| format!("{:?}", s.quality)),
            governor_on: self.governor.as_ref().is_some_and(|g| g.enabled),
            level: st.map_or(0, |s| s.level),
            levels: self.governor.as_ref().map_or(0, |g| g.steps.len()),
            memory_level: st.map_or(0, |s| s.memory_level),
            scale: self.scale.as_ref().map_or(1.0, |s| s.applied),
            last: st.and_then(|s| s.last_reason.map(|r| (r, s.last_step))),
        }
    }
}

/// Logical CPU cores, read once.
fn cores() -> usize {
    static N: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *N.get_or_init(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
}

/// Group order in the body; others follow alphabetically.
const GROUP_ORDER: [&str; 10] = ["frame", "cpu", "gpu", "mem", "render", "span", "resources", "ecs", "perf", "misc"];

/// Row order inside groups: what matters first.
const ROW_ORDER: [&str; 30] = [
    "frame.fps",
    "frame.ms",
    "frame.p50_ms",
    "frame.p95_ms",
    "frame.p99_ms",
    "frame.max_ms",
    "frame.hitches",
    "cpu.machine_pct",
    "cpu.cores",
    "cpu.process_pct",
    "cpu.main_ms",
    "cpu.render_ms",
    "cpu.main_pct",
    "cpu.render_pct",
    "cpu.compute_pool_pct",
    "cpu.async_pool_pct",
    "gpu.process_pct",
    "gpu.frame_ms",
    "gpu.alloc_mb",
    "gpu.alloc_pct",
    "gpu.working_set_mb",
    "gpu.pct",
    "gpu.renderer_pct",
    "gpu.tiler_pct",
    "gpu.mem_mb",
    "mem.system_pct",
    "mem.system_used_mb",
    "mem.footprint_mb",
    "mem.pressure",
    "mem.swap_mb",
];

/// Groups shown only with `metrics.window {dev: true}` (developer counters).
const DEV_GROUPS: [&str; 3] = ["resources", "ecs", "perf"];

fn group_of(key: &str) -> &str {
    match key {
        "gpu.textures" | "gpu.texture_views" | "gpu.buffers" | "gpu.bind_groups" | "gpu.samplers" | "gpu.render_pipelines" | "gpu.compute_pipelines" => "resources",
        _ => key.split_once('.').map_or("misc", |(g, _)| g),
    }
}

/// Plain name for a metric row (units come with the value).
pub fn label(key: &str) -> String {
    let known = match key {
        "frame.fps" => "Frame rate",
        "frame.ms" => "Frame time",
        "frame.p50_ms" => "Frame time, median",
        "frame.p95_ms" => "Frame time, slowest 5%",
        "frame.p99_ms" => "Frame time, slowest 1%",
        "frame.max_ms" => "Slowest frame",
        "frame.hitches" => "Hitches (> 50 ms)",
        "cpu.machine_pct" => "CPU, share of the whole machine",
        "cpu.process_pct" => "CPU, this game (100% = 1 core)",
        "cpu.cores" => "Cores busy",
        "cpu.main_pct" => "Main thread (% of a core)",
        "cpu.render_pct" => "Render thread (% of a core)",
        "cpu.main_ms" => "Main thread per frame",
        "cpu.render_ms" => "Render thread per frame",
        "cpu.compute_pool_pct" => "Compute pool (100% = 1 core)",
        "cpu.async_pool_pct" => "Async pool (100% = 1 core)",
        "cpu.io_pool_pct" => "IO pool (100% = 1 core)",
        "gpu.process_pct" => "GPU busy, this game",
        "gpu.frame_ms" => "GPU time per frame",
        "gpu.pct" => "GPU busy, all apps",
        "gpu.renderer_pct" => "GPU pixel work, all apps",
        "gpu.tiler_pct" => "GPU geometry work, all apps",
        "gpu.alloc_mb" => "GPU memory, this game",
        "gpu.working_set_mb" => "GPU memory limit (Metal working set)",
        "gpu.alloc_pct" => "GPU memory, share of limit",
        "gpu.mem_mb" => "GPU memory, all apps",
        "gpu.passes_ms" => "GPU passes per frame",
        "gpu.textures" => "Textures",
        "gpu.texture_views" => "Texture views",
        "gpu.buffers" => "Buffers",
        "gpu.bind_groups" => "Bind groups",
        "gpu.samplers" => "Samplers",
        "gpu.render_pipelines" => "Render pipelines",
        "gpu.compute_pipelines" => "Compute pipelines",
        "mem.footprint_mb" => "Memory, this game",
        "mem.rss_mb" => "Resident memory, this game",
        "mem.system_used_mb" => "System memory in use",
        "mem.system_total_mb" => "System memory installed",
        "mem.system_pct" => "System memory in use, share",
        "mem.swap_mb" => "Swap in use",
        "mem.pressure" => "Memory pressure",
        "ecs.entities" => "Entities",
        _ => "",
    };
    if !known.is_empty() {
        return known.into();
    }
    // Fallback: the part after the group, without its unit suffix, words spaced.
    let name = key.split_once('.').map_or(key, |(_, n)| n);
    let name = ["_ms", "_pct", "_mb", "_us"].iter().fold(name, |n, suf| n.strip_suffix(suf).unwrap_or(n));
    let mut out = name.replace('_', " ");
    if let Some(c) = out.get(0..1) {
        out = c.to_uppercase() + &out[1..];
    }
    out
}

#[cfg(test)]
fn make_plan(m: &Metrics, past: &[SessionSummary], compare: &MetricsCompare, featured: &MetricsFeatured, size: (u32, u32), scale: f32) -> Plan {
    make_plan_dev(m, past, compare, featured, size, scale, false)
}

fn make_plan_dev(m: &Metrics, past: &[SessionSummary], compare: &MetricsCompare, featured: &MetricsFeatured, size: (u32, u32), scale: f32, dev: bool) -> Plan {
    let keys: Vec<&'static str> = m.keys().filter(|k| dev || !DEV_GROUPS.contains(&group_of(k))).collect();
    let featured: Vec<&'static str> = featured.0.iter().copied().filter(|k| keys.contains(k)).take(4).collect();
    let mut groups: Vec<(String, Vec<&'static str>)> = Vec::new();
    for k in &keys {
        let g = group_of(k);
        match groups.iter_mut().find(|(n, _)| n == g) {
            Some((_, v)) => v.push(k),
            None => groups.push((g.to_string(), vec![k])),
        }
    }
    let rank = |g: &str| GROUP_ORDER.iter().position(|o| *o == g).unwrap_or(GROUP_ORDER.len());
    groups.sort_by(|a, b| rank(&a.0).cmp(&rank(&b.0)).then(a.0.cmp(&b.0)));
    // Within a group: the headline numbers first (ROW_ORDER), the rest alphabetically.
    let row = |k: &str| ROW_ORDER.iter().position(|o| *o == k).unwrap_or(ROW_ORDER.len());
    for (_, keys) in groups.iter_mut() {
        keys.sort_by(|a, b| row(a).cmp(&row(b)).then(a.cmp(b)));
    }
    // Two columns, each group into the shorter one (rows + 2 for the heading).
    let mut cols: [Vec<(String, Vec<&'static str>)>; 2] = [Vec::new(), Vec::new()];
    let mut heights = [0usize; 2];
    for g in groups {
        let i = usize::from(heights[1] < heights[0]);
        heights[i] += g.1.len() + 2;
        cols[i].push(g);
    }
    // Runs rows: keys this run or a past run has.
    let known = |k: &str| keys.contains(&k) || past.iter().any(|s| s.keys.contains_key(k));
    let mut rows: Vec<(String, &'static str)> = Vec::new();
    for (k, stat) in &compare.0 {
        if k.ends_with('.') {
            let mut found: Vec<String> = keys.iter().filter(|x| x.starts_with(k.as_str())).map(|x| x.to_string()).collect();
            for s in past {
                found.extend(s.keys.keys().filter(|x| x.starts_with(k.as_str())).cloned());
            }
            found.sort();
            found.dedup();
            rows.extend(found.into_iter().map(|x| (x, *stat)));
        } else if known(k) {
            rows.push((k.clone(), stat));
        }
    }
    rows.dedup();
    rows.truncate(MAX_RUN_ROWS);
    let fit = ((size.0 as f32 - 32.0 - 20.0 - RUN_KEY) / RUN_COL).floor().max(1.0) as usize;
    Plan { featured, groups: cols, rows, run_cols: fit.min(1 + past.len()).min(10), size, scale: (scale * 100.0) as u32 }
}

// ---- building ----

struct Palette {
    t: Theme,
}

fn rgba(c: Color, a: Option<u8>) -> [u8; 4] {
    let s = c.to_srgba();
    let b = |x: f32| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
    [b(s.red), b(s.green), b(s.blue), a.unwrap_or(b(s.alpha))]
}

impl Palette {
    fn new(t: &Theme) -> Self {
        Palette { t: t.clone() }
    }

    fn level(&self, l: u8) -> Color {
        match l {
            0 => self.t.good,
            1 => AMBER,
            _ => self.t.bad,
        }
    }

    /// Colour of a value of `key` (threshold level), else plain text.
    fn value(&self, th: Option<Threshold>, v: f64) -> Color {
        th.map_or(self.t.text, |t| self.level(t.level(v)))
    }

    fn chart_style(&self, levels: bool, scale: f32, guides: bool) -> Style {
        let lv = if levels {
            [rgba(self.t.good, Some(255)), rgba(AMBER, Some(255)), rgba(self.t.bad, Some(255))]
        } else {
            [rgba(self.t.info, Some(255)); 3]
        };
        Style {
            scale,
            levels: lv,
            guide_amber: rgba(AMBER, Some(110)),
            guide_red: rgba(self.t.bad, Some(110)),
            baseline: rgba(Color::WHITE, Some(40)),
            guides,
        }
    }
}

fn font(handle: &Handle<Font>, size: f32) -> TextFont {
    TextFont::from_font_size(size).with_font(handle.clone())
}

fn text(s: impl Into<String>, f: TextFont, c: Color) -> impl Bundle {
    (Text::new(s), f, TextColor(c), TextLayout::new(Justify::Left, LineBreak::NoWrap))
}

/// Builder state: slot and chart lists filled while spawning.
struct Ui<'a> {
    slots: Vec<SlotKind>,
    charts: Vec<ChartInfo>,
    images: &'a mut Assets<Image>,
    scale: f32,
    t: Theme,
}

impl Ui<'_> {
    fn slot(&mut self, kind: SlotKind) -> Slot {
        self.slots.push(kind);
        Slot(self.slots.len() - 1)
    }

    /// A chart image of `w`×`h` logical px with `cols` time columns.
    fn chart(&mut self, key: &'static str, w: f32, h: f32, cols: usize) -> (Handle<Image>, usize) {
        let (pw, ph) = ((w * self.scale).round().max(1.0) as u32, (h * self.scale).round().max(1.0) as u32);
        let mut img = Image::new_fill(
            Extent3d { width: pw, height: ph, depth_or_array_layers: 1 },
            TextureDimension::D2,
            &[0, 0, 0, 0],
            TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::RENDER_WORLD | RenderAssetUsages::MAIN_WORLD,
        );
        img.sampler = ImageSampler::linear();
        let handle = self.images.add(img);
        self.charts.push(ChartInfo { key, handle: handle.clone(), w: pw as usize, h: ph as usize, cols, top: 0.0 });
        (handle, self.charts.len() - 1)
    }

    /// Right-aligned fixed-width cell holding one slot.
    fn cell(&mut self, p: &mut ChildSpawnerCommands, w: f32, kind: SlotKind, f: TextFont, c: Color) {
        let slot = self.slot(kind);
        p.spawn(Node { width: px(w), justify_content: JustifyContent::FlexEnd, flex_shrink: 0.0, ..default() })
            .with_children(|p| {
                p.spawn((slot, text("", f, c)));
            });
    }

    fn panel(&self) -> (Node, BackgroundColor) {
        (
            Node {
                flex_direction: FlexDirection::Column,
                padding: UiRect::axes(px(12), px(9)),
                row_gap: px(3),
                border_radius: BorderRadius::all(px(6)),
                ..default()
            },
            BackgroundColor(self.t.panel),
        )
    }
}

fn build_ui(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    plan: &Plan,
    theme: &Theme,
    cam: Entity,
    key: KeyCode,
) -> (Entity, Vec<SlotKind>, Vec<ChartInfo>) {
    let t = theme.clone();
    let mut ui = Ui { slots: Vec::new(), charts: Vec::new(), images, scale: plan.scale as f32 / 100.0, t: t.clone() };
    let (w, _) = (plan.size.0 as f32, plan.size.1 as f32);
    let body = &FONT_BODY;
    let label = &FONT_LABEL;
    let root = commands
        .spawn((
            Name::new("Metrics view"),
            Node {
                width: Val::Percent(100.0),
                height: Val::Percent(100.0),
                flex_direction: FlexDirection::Column,
                padding: UiRect::axes(px(16), px(12)),
                row_gap: px(10),
                ..default()
            },
            BackgroundColor(t.bg),
            UiTargetCamera(cam),
        ))
        .id();
    commands.entity(root).with_children(|p| {
        // Header.
        p.spawn(Node { justify_content: JustifyContent::SpaceBetween, align_items: AlignItems::Baseline, column_gap: px(14), ..default() })
            .with_children(|p| {
                p.spawn(Node { align_items: AlignItems::Baseline, column_gap: px(14), ..default() }).with_children(|p| {
                    p.spawn(text("METRICS", font(label, 22.0), t.accent));
                    let s = ui.slot(SlotKind::Info);
                    p.spawn((s, text("", font(body, 14.0), t.text_muted)));
                });
                p.spawn(text(format!("{key:?} hide · wheel scrolls · last {WINDOW_SECS:.0} s"), font(body, 13.0), t.text_dim));
            });

        // Summary tiles.
        {
            let n = Tile::ALL.len() as f32;
            let card_w = ((w - 32.0 - 10.0 * (n - 1.0)) / n).floor();
            let chart_w = (card_w - 24.0).max(60.0);
            p.spawn(Node { column_gap: px(10), ..default() }).with_children(|p| {
                for tile in Tile::ALL {
                    let (mut node, bg) = ui.panel();
                    node.width = px(card_w);
                    node.row_gap = px(3);
                    p.spawn((node, bg)).with_children(|p| {
                        p.spawn(Node { justify_content: JustifyContent::SpaceBetween, align_items: AlignItems::Baseline, ..default() })
                            .with_children(|p| {
                                p.spawn(text(tile.title(), font(label, 14.0), t.text_muted));
                                let s = ui.slot(SlotKind::Tile(tile, 0));
                                p.spawn((s, text("", font(label, 22.0), t.text)));
                            });
                        match tile.chart() {
                            Some(k) => {
                                let (h, _) = ui.chart(k, chart_w, TILE_H, (chart_w / 2.0) as usize);
                                p.spawn((
                                    ImageNode::new(h),
                                    Node { width: px(chart_w), height: px(TILE_H), border_radius: BorderRadius::all(px(3)), ..default() },
                                    BackgroundColor(t.raised),
                                ));
                            }
                            None => {
                                p.spawn(Node { flex_direction: FlexDirection::Column, height: px(TILE_H), justify_content: JustifyContent::Center, ..default() })
                                    .with_children(|p| {
                                        let s = ui.slot(SlotKind::Tile(tile, 3));
                                        p.spawn((s, text("", font(body, 13.0), t.text)));
                                    });
                            }
                        }
                        for line in 1..=2 {
                            let s = ui.slot(SlotKind::Tile(tile, line));
                            p.spawn((s, text("", font(body, 12.0), t.text_muted)));
                        }
                    });
                }
            });
        }

        // Featured charts.
        if !plan.featured.is_empty() {
            let n = plan.featured.len() as f32;
            let card_w = ((w - 32.0 - 12.0 * (n - 1.0)) / n).floor();
            let chart_w = (card_w - 24.0).max(60.0);
            p.spawn(Node { column_gap: px(12), ..default() }).with_children(|p| {
                for &k in &plan.featured {
                    let (mut node, bg) = ui.panel();
                    node.width = px(card_w);
                    node.row_gap = px(5);
                    p.spawn((node, bg)).with_children(|p| {
                        p.spawn(Node { justify_content: JustifyContent::SpaceBetween, align_items: AlignItems::Baseline, ..default() })
                            .with_children(|p| {
                                p.spawn(text(k, font(label, 16.0), t.text_muted));
                                let s = ui.slot(SlotKind::FeatValue(k));
                                p.spawn((s, text("", font(label, 24.0), t.text)));
                            });
                        let (h, idx) = ui.chart(k, chart_w, FEAT_H, (chart_w / 2.0) as usize);
                        p.spawn((
                            Node { width: px(chart_w), height: px(FEAT_H), border_radius: BorderRadius::all(px(3)), ..default() },
                            BackgroundColor(t.raised),
                        ))
                        .with_children(|p| {
                            p.spawn((ImageNode::new(h), Node { width: Val::Percent(100.0), height: Val::Percent(100.0), ..default() }));
                            let s = ui.slot(SlotKind::FeatAxis(idx));
                            p.spawn((
                                s,
                                text("", font(body, 11.0), t.text_dim),
                                Node { position_type: PositionType::Absolute, left: px(4), top: px(1), ..default() },
                            ));
                        });
                        let s = ui.slot(SlotKind::FeatStats(k));
                        p.spawn((s, text("", font(body, 12.0), t.text_muted)));
                    });
                }
            });
        }

        // Every key, grouped, two columns, scrolls.
        p.spawn((
            MetricsScroll,
            Node { flex_grow: 1.0, min_height: px(0), overflow: Overflow::scroll_y(), column_gap: px(12), align_items: AlignItems::FlexStart, ..default() },
            ScrollPosition::default(),
        ))
        .with_children(|p| {
            for col in &plan.groups {
                p.spawn(Node { flex_direction: FlexDirection::Column, flex_grow: 1.0, flex_basis: px(0), row_gap: px(10), ..default() })
                    .with_children(|p| {
                        for (g, keys) in col {
                            let (node, bg) = ui.panel();
                            p.spawn((node, bg)).with_children(|p| {
                                p.spawn(Node { align_items: AlignItems::Center, column_gap: px(8), margin: UiRect::bottom(px(2)), ..default() })
                                    .with_children(|p| {
                                        p.spawn((
                                            text(g.to_uppercase(), font(label, 15.0), t.info),
                                            Node { flex_grow: 1.0, ..default() },
                                        ));
                                        for (wd, h) in [(80.0, "now"), (SPARK.0, ""), (58.0, "avg"), (58.0, "p95"), (58.0, "max")] {
                                            p.spawn(Node { width: px(wd), justify_content: JustifyContent::FlexEnd, flex_shrink: 0.0, ..default() })
                                                .with_children(|p| {
                                                    p.spawn(text(h, font(body, 11.0), t.text_dim));
                                                });
                                        }
                                    });
                                for &k in keys {
                                    let name = self::label(k);
                                    p.spawn(Node { align_items: AlignItems::Center, column_gap: px(8), height: px(20), ..default() })
                                        .with_children(|p| {
                                            p.spawn((
                                                text(name, font(body, 13.0), t.text),
                                                Node { flex_grow: 1.0, min_width: px(0), overflow: Overflow::clip_x(), ..default() },
                                            ));
                                            ui.cell(p, 80.0, SlotKind::RowValue(k), font(body, 13.0), t.text);
                                            let (h, _) = ui.chart(k, SPARK.0, SPARK.1, (SPARK.0 / 1.5) as usize);
                                            p.spawn((
                                                ImageNode::new(h),
                                                Node { width: px(SPARK.0), height: px(SPARK.1), flex_shrink: 0.0, ..default() },
                                                BackgroundColor(t.raised),
                                            ));
                                            for stat in ["avg", "p95", "max"] {
                                                ui.cell(p, 58.0, SlotKind::RowStat(k, stat), font(body, 12.0), t.text_muted);
                                            }
                                        });
                                }
                            });
                        }
                    });
            }
        });

        // Runs table.
        let (node, bg) = ui.panel();
        p.spawn((node, bg)).with_children(|p| {
            p.spawn(Node { align_items: AlignItems::Baseline, column_gap: px(12), margin: UiRect::bottom(px(4)), ..default() })
                .with_children(|p| {
                    p.spawn(text("RUNS", font(label, 15.0), t.info));
                    p.spawn(text(
                        "session stats after warm-up · Δ vs the previous comparable run (same mode, quality, labels; others marked ≠) · green = better, red = worse",
                        font(body, 12.0),
                        t.text_dim,
                    ));
                });
            if plan.rows.is_empty() {
                p.spawn(text("no data yet", font(body, 13.0), t.text_dim));
                return;
            }
            for line in 0..2u8 {
                p.spawn(Node { ..default() }).with_children(|p| {
                    p.spawn(Node { width: px(RUN_KEY), flex_shrink: 0.0, ..default() });
                    for c in 0..plan.run_cols {
                        let (f, col) = if line == 0 { (font(label, 14.0), t.text) } else { (font(body, 11.0), t.text_dim) };
                        ui.cell(p, RUN_COL, SlotKind::RunHead(c, line), f, col);
                    }
                });
            }
            for (r, (k, stat)) in plan.rows.iter().enumerate() {
                p.spawn(Node { height: px(18), align_items: AlignItems::Center, ..default() }).with_children(|p| {
                    let name = if k.ends_with('.') { k.clone() } else { format!("{}, {stat}", self::label(k)) };
                    p.spawn((text(name, font(body, 12.0), t.text), Node { width: px(RUN_KEY), flex_shrink: 0.0, ..default() }));
                    for c in 0..plan.run_cols {
                        p.spawn(Node {
                            width: px(RUN_COL),
                            justify_content: JustifyContent::FlexEnd,
                            align_items: AlignItems::Baseline,
                            column_gap: px(6),
                            flex_shrink: 0.0,
                            ..default()
                        })
                        .with_children(|p| {
                            let s = ui.slot(SlotKind::RunVal(r, c));
                            p.spawn((s, text("", font(body, 12.0), t.text)));
                            let s = ui.slot(SlotKind::RunDelta(r, c));
                            p.spawn((s, text("", font(body, 11.0), t.text_dim), Node { min_width: px(36), ..default() }));
                        });
                    }
                });
            }
        });
    });
    (root, ui.slots, ui.charts)
}

// ---- filling ----

struct FillCtx<'a> {
    m: &'a Metrics,
    recent: &'a std::collections::HashMap<&'static str, Summary>,
    runs: &'a [&'a SessionSummary],
    rows: &'a [(String, &'static str)],
    palette: &'a Palette,
    view: &'a MetricsView,
    live: &'a Live,
}

impl FillCtx<'_> {
    fn fill(&self, kind: &SlotKind) -> (String, Color) {
        let t = &self.palette.t;
        let m = self.m;
        match kind {
            SlotKind::Info => (self.info(), t.text_muted),
            SlotKind::Tile(tile, line) => self.tile(*tile, *line),
            SlotKind::FeatValue(k) | SlotKind::RowValue(k) => match m.latest(k) {
                Some(v) => (with_unit(k, v), self.palette.value(m.threshold(k), v)),
                None => ("—".into(), t.text_dim),
            },
            SlotKind::FeatStats(k) => match self.recent.get(k) {
                Some(s) => (
                    format!("min {}   avg {}   p95 {}   max {}", num(s.min), num(s.avg), num(s.p95), num(s.max)),
                    t.text_muted,
                ),
                None => (String::new(), t.text_dim),
            },
            SlotKind::FeatAxis(i) => (self.view.charts.get(*i).map(|c| num(c.top as f64)).unwrap_or_default(), t.text_dim),
            SlotKind::RowStat(k, stat) => match self.recent.get(k).and_then(|s| s.get(stat)) {
                Some(v) => {
                    let lvl = m.threshold(k).map_or(0, |th| th.level(v));
                    (stat_num(k, v), if lvl == 0 { t.text_muted } else { self.palette.level(lvl) })
                }
                None => (String::new(), t.text_dim),
            },
            SlotKind::RunHead(c, line) => self.run_head(*c, *line),
            SlotKind::RunVal(r, c) => match self.run_value(*r, *c) {
                Some(v) => (num(v), if *c == 0 { t.text } else { t.text_muted }),
                None => ("—".into(), t.text_dim),
            },
            SlotKind::RunDelta(r, c) => self.run_delta(*r, *c),
        }
    }

    fn tile(&self, tile: Tile, line: u8) -> (String, Color) {
        let t = &self.palette.t;
        let m = self.m;
        let l = self.live;
        let get = |k: &str| m.latest(k);
        let avg = |k: &str| self.recent.get(k).map(|s| s.avg);
        let none = (String::new(), t.text_dim);
        let dash = ("—".to_string(), t.text_dim);
        let frame_ms = get("frame.fps").filter(|f| *f > 0.0).map(|f| 1000.0 / f).or_else(|| avg("frame.ms"));
        let gb = |mb: f64| format!("{:.1} GB", mb / 1024.0);
        let size = |mb: f64| if mb >= 1024.0 { format!("{:.1} GB", mb / 1024.0) } else { format!("{mb:.0} MB") };
        match (tile, line) {
            (Tile::Frame, 0) => match get("frame.fps") {
                Some(f) => (format!("{f:.0} fps"), crate::ui::fps_counter::fps_color(t, f as f32)),
                None => dash,
            },
            (Tile::Frame, 1) => match frame_ms {
                Some(ms) => (format!("{ms:.1} ms · p95 {}", get("frame.p95_ms").map_or("—".into(), |v| format!("{v:.1} ms"))), t.text_muted),
                None => none,
            },
            (Tile::Frame, 2) => (format!("budget {:.1} ms ({:.0} fps) · hitches {}", l.budget_ms, l.target_fps, get("frame.hitches").map_or(0.0, |v| v)), t.text_dim),
            (Tile::Cpu, 0) => match get("cpu.machine_pct") {
                Some(p) => (format!("{p:.0}%"), self.palette.value(m.threshold("cpu.machine_pct"), p)),
                None => dash,
            },
            (Tile::Cpu, 1) => match get("cpu.cores") {
                Some(c) => (format!("of the machine · {c:.1} of {} cores busy", cores()), t.text_muted),
                None => none,
            },
            (Tile::Cpu, 2) => match (get("cpu.main_ms"), get("cpu.render_ms")) {
                (Some(a), Some(b)) => (format!("main {a:.1} ms · render {b:.1} ms"), t.text_muted),
                (Some(a), None) => (format!("main {a:.1} ms"), t.text_muted),
                _ => none,
            },
            (Tile::Gpu, 0) => match (get("gpu.process_pct"), get("gpu.frame_ms")) {
                (Some(p), Some(v)) => (format!("{p:.0}% · {v:.1} ms"), self.palette.value(Some(Threshold { amber: l.budget_ms as f64 * 0.8, red: l.budget_ms as f64 }), v)),
                (Some(p), None) => (format!("{p:.0}%"), t.text),
                (None, Some(v)) => (format!("{v:.1} ms"), t.text),
                _ => dash,
            },
            (Tile::Gpu, 1) => match get("gpu.frame_ms") {
                Some(v) => (format!("busy · {v:.1} of {:.1} ms per frame", l.budget_ms), t.text_muted),
                None => ("busy share of this game".into(), t.text_muted),
            },
            (Tile::Gpu, 2) => match (get("gpu.alloc_mb"), get("gpu.working_set_mb")) {
                (Some(a), Some(ws)) => (format!("memory {} of {} ({:.0}%)", size(a), size(ws), a / ws.max(1.0) * 100.0), t.text_dim),
                (Some(a), None) => (format!("memory {}", size(a)), t.text_dim),
                _ => none,
            },
            (Tile::Limit, _) => self.limit(line, frame_ms),
            (Tile::Mem, 0) => match get("mem.system_pct") {
                Some(p) => (format!("{p:.0}%"), self.palette.value(Some(Threshold { amber: 75.0, red: 90.0 }), p)),
                None => match get("mem.footprint_mb") {
                    Some(v) => (size(v), t.text),
                    None => dash,
                },
            },
            (Tile::Mem, 1) => match (get("mem.system_used_mb"), get("mem.system_total_mb"), get("mem.footprint_mb")) {
                (Some(u), Some(tot), Some(me)) => (format!("system {} / {} · this game {}", gb(u), gb(tot), size(me)), t.text_muted),
                (_, _, Some(me)) => (format!("this game {}", size(me)), t.text_muted),
                _ => none,
            },
            (Tile::Mem, 2) => {
                let pressure = match get("mem.pressure").map(|v| v as u8) {
                    Some(2) => Some(("critical", t.bad)),
                    Some(1) => Some(("warning", t.bad)),
                    Some(_) => Some(("normal", t.text_dim)),
                    None => None,
                };
                let swap = get("mem.swap_mb").filter(|v| *v >= 1.0).map(|v| format!(" · swap {}", size(v))).unwrap_or_default();
                match pressure {
                    Some((p, c)) => (format!("pressure {p}{swap}"), c),
                    None => (swap.trim_start_matches(" · ").to_string(), t.text_dim),
                }
            }
            (Tile::Quality, 0) => {
                let q = l.quality.clone().unwrap_or_else(|| "—".into());
                if l.level + l.memory_level == 0 {
                    (q, t.text)
                } else {
                    (format!("{q} −{}", l.level + l.memory_level), t.bad)
                }
            }
            (Tile::Quality, 1) => (
                format!(
                    "{} · {}/{} · scale {:.0}%",
                    if l.governor_on { "governor on" } else { "governor off" },
                    l.level,
                    l.levels,
                    l.scale * 100.0
                ),
                t.text_muted,
            ),
            (Tile::Quality, 2) => match l.last {
                Some((reason, step)) => {
                    use crate::render_budget::GovernorReason as R;
                    let what = step.map(|s| s.label()).unwrap_or_else(|| "all".into());
                    let s = match reason {
                        R::Gpu => format!("last: −{what} (GPU)"),
                        R::Memory => format!("last: −{what} (memory)"),
                        R::Headroom => format!("last: +{what}"),
                        R::Reset => "last: reset to full".into(),
                    };
                    (s, if matches!(reason, R::Gpu | R::Memory) { t.bad } else { t.good })
                }
                None => ("no changes".into(), t.text_dim),
            },
            _ => none,
        }
    }

    /// The bottleneck tile, with the governor's rule: over budget and the GPU busy most of the
    /// time → GPU-bound; else the busiest CPU thread if it fills most of the frame.
    fn limit(&self, line: u8, frame_ms: Option<f64>) -> (String, Color) {
        let t = &self.palette.t;
        let get = |k: &str| self.m.latest(k);
        let budget = self.live.budget_ms as f64;
        let (gpu, main, render) = (get("gpu.frame_ms"), get("cpu.main_ms"), get("cpu.render_ms"));
        match line {
            0 => {
                let Some(frame) = frame_ms else { return ("—".into(), t.text_dim) };
                let busy = get("gpu.process_pct").map(|p| p / 100.0);
                let over = frame > budget * 1.05;
                let worst = [("GPU-bound", gpu), ("CPU-bound (main)", main), ("CPU-bound (render)", render)]
                    .into_iter()
                    .filter_map(|(n, v)| v.map(|v| (n, v)))
                    .max_by(|a, b| a.1.total_cmp(&b.1));
                if !over {
                    let head = worst.map_or(100.0, |w| (1.0 - w.1 / budget) * 100.0).max(0.0);
                    return (format!("OK · {head:.0}% spare"), t.good);
                }
                let label = match (busy, worst) {
                    (Some(b), _) if b > 0.8 => "GPU-bound".to_string(),
                    (_, Some((n, v))) if v >= frame * 0.6 => n.to_string(),
                    _ => "Waiting (vsync / cap)".into(),
                };
                (label, t.bad)
            }
            1 => (format!("frame {} vs budget {budget:.1} ms", frame_ms.map_or("—".into(), |f| format!("{f:.1}"))), t.text_muted),
            2 => (String::new(), t.text_dim),
            _ => {
                let f = |v: Option<f64>| v.map_or("—".into(), |v| format!("{v:.1}"));
                (format!("main {} · render {} · GPU {} ms", f(main), f(render), f(gpu)), t.text)
            }
        }
    }

    fn info(&self) -> String {
        let Some(cur) = self.runs.first() else { return String::new() };
        let secs = self.m.now() as u64;
        let mut s = format!("{} · {} · {} · {}", cur.game, cur.commit_label(), cur.profile, cur.mode);
        if let Some(q) = &cur.quality {
            s += &format!(" · {q}");
        }
        for (k, v) in &cur.labels {
            s += &format!(" · {k}={v}");
        }
        s += &format!(
            " · up {}:{:02} · {} keys · view {:.2} ms/redraw",
            secs / 60,
            secs % 60,
            self.m.keys().count(),
            self.view.cost_ms
        );
        s
    }

    fn run_head(&self, c: usize, line: u8) -> (String, Color) {
        let t = &self.palette.t;
        let Some(s) = self.runs.get(c) else { return (String::new(), t.text_dim) };
        let cur = self.runs[0];
        // A run with another setup (mode, quality, labels) is shown dim with a ≠.
        let same = s.comparable(cur);
        if line == 0 {
            let label = if c == 0 { format!("now {}", s.commit_label()) } else { s.commit_label() };
            let label = if same { label } else { format!("{label} ≠") };
            return (label, if c == 0 { t.accent } else if same { t.text } else { t.text_dim });
        }
        if c == 0 {
            return ("this run".into(), t.text_dim);
        }
        let now_ms = cur.start_ts + (self.m.now() * 1000.0) as u64;
        let mut s2 = format!("{} · {:.0}s", age(now_ms.saturating_sub(s.start_ts) / 1000), s.seconds);
        if s.mode != cur.mode {
            s2 = format!("{} · {}", age(now_ms.saturating_sub(s.start_ts) / 1000), s.mode);
        }
        (s2, t.text_dim)
    }

    fn run_value(&self, r: usize, c: usize) -> Option<f64> {
        let (k, stat) = self.rows.get(r)?;
        self.runs.get(c)?.keys.get(k.as_str()).and_then(|s: &Summary| s.get(stat))
    }

    fn run_delta(&self, r: usize, c: usize) -> (String, Color) {
        let t = &self.palette.t;
        let none = (String::new(), t.text_dim);
        let (Some((k, _)), Some(cur), Some(s)) = (self.rows.get(r), self.run_value(r, c), self.runs.get(c)) else { return none };
        let Some(prev_idx) = (c + 1..self.runs.len()).find(|&j| self.runs[j].comparable(s) && self.run_value(r, j).is_some()) else {
            return none;
        };
        let Some(prev) = self.run_value(r, prev_idx) else { return none };
        let Some((d, sign)) = delta(k, cur, prev) else { return none };
        let pct = d * 100.0;
        let s = if pct.abs() < 0.5 { "±0%".to_string() } else if pct.abs() >= 999.5 { format!("{:+.0}x", d + 1.0) } else { format!("{}{:.0}%", if pct >= 0.0 { "+" } else { "−" }, pct.abs()) };
        let color = match sign {
            1 => t.good,
            -1 => t.bad,
            _ => t.text_dim,
        };
        (s, color)
    }
}

/// `3s`, `12m`, `5h`, `2d`.
fn age(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s ago"),
        60..3600 => format!("{}m ago", secs / 60),
        3600..86_400 => format!("{}h ago", secs / 3600),
        _ => format!("{}d ago", secs / 86_400),
    }
}

/// Compact number: 12345, 123, 12.3, 1.23.
pub fn num(v: f64) -> String {
    let a = v.abs();
    if a >= 100.0 || (v == v.trunc() && a < 1e6) {
        format!("{v:.0}")
    } else if a >= 10.0 {
        format!("{v:.1}")
    } else {
        format!("{v:.2}")
    }
}

/// Value with the unit its key implies (`frame.ms` → `8.31 ms`).
pub fn with_unit(key: &str, v: f64) -> String {
    let n = num(v);
    match key {
        "cpu.process_pct" => return format!("{n}% ({:.1} cores)", v / 100.0),
        "cpu.cores" => return format!("{v:.1} cores"),
        "frame.fps" => return format!("{n} fps"),
        "mem.pressure" => {
            return match v as u8 {
                2 => "critical".into(),
                1 => "warning".into(),
                _ => "normal".into(),
            };
        }
        _ => {}
    }
    if key.ends_with("_mb") && v >= 1024.0 {
        return format!("{:.2} GB", v / 1024.0);
    }
    if key.ends_with("ms") {
        format!("{n} ms")
    } else if key.ends_with("_pct") || key == "gpu.pct" {
        format!("{n}%")
    } else if key.ends_with("_mb") {
        format!("{n} MB")
    } else if key.ends_with("_us") {
        format!("{n} µs")
    } else {
        n
    }
}

/// A stats-column number in the same unit as the row's value (MB rows over 1 GB in GB).
fn stat_num(key: &str, v: f64) -> String {
    if key.ends_with("_mb") && v >= 1024.0 { format!("{:.2} G", v / 1024.0) } else { num(v) }
}

// ---- commands ----

fn window_cmd(world: &mut World, p: Value) -> Result<Value, String> {
    let mut view = world.get_resource_mut::<MetricsView>().ok_or("no metrics view in this run (headless or no UI)")?;
    let keep = p.get("scroll").is_some() || p.get("dev").is_some();
    let on = p.get("on").and_then(Value::as_bool).unwrap_or(if keep { view.open } else { !view.open });
    if let Some(d) = p.get("dev").and_then(Value::as_bool) {
        view.dev = d;
    }
    view.open = on;
    view.force = true;
    let out = view.json();
    if let Some(y) = p.get("scroll").and_then(Value::as_f64) {
        let mut q = world.query_filtered::<&mut ScrollPosition, With<MetricsScroll>>();
        for mut s in q.iter_mut(world) {
            s.0.y = y.max(0.0) as f32;
        }
    }
    Ok(out)
}

fn screenshot_cmd(world: &mut World, p: Value, reply: ReplyId) -> Result<(), String> {
    use bevy::render::view::window::screenshot::{Screenshot, ScreenshotCaptured, save_to_disk};
    let frame = world.get_resource::<FrameCount>().map_or(0, |f| f.0);
    let dir = world.get_resource::<DataDir>().map(|d| d.0.clone()).unwrap_or_else(std::env::temp_dir);
    let mut view = world.get_resource_mut::<MetricsView>().ok_or("no metrics view in this run (headless or no UI)")?;
    let shot = match (view.target, view.window, view.image.clone()) {
        (_, _, _) if view.camera.is_none() || view.redraws == 0 => {
            return Err("metrics view is not shown yet (open it with metrics.window or --metrics-window, then wait a frame)".into());
        }
        (Target::Window, Some(w), _) => Screenshot::window(w),
        (Target::Image, _, Some(h)) => Screenshot::image(h),
        _ => return Err("metrics view has no target".into()),
    };
    view.force = true;
    let path = match p.get("path").and_then(Value::as_str) {
        Some(s) => std::path::PathBuf::from(s),
        None => dir.join("screenshots").join(format!("metrics-{frame}.png")),
    };
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let shown = path.display().to_string();
    world
        .spawn(shot)
        .observe(save_to_disk(path))
        .observe(move |_: On<ScreenshotCaptured>, mut pending: ResMut<PendingReplies>| {
            pending.reply(reply, Ok(json!({"path": shown})));
        });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_units() {
        assert_eq!(num(12345.6), "12346");
        assert_eq!(num(12.34), "12.3");
        assert_eq!(num(1.234), "1.23");
        assert_eq!(num(3.0), "3");
        assert_eq!(with_unit("frame.ms", 8.314), "8.31 ms");
        assert_eq!(with_unit("frame.p95_ms", 20.0), "20 ms");
        assert_eq!(with_unit("gpu.pct", 55.5), "55.5%");
        assert_eq!(with_unit("mem.footprint_mb", 812.0), "812 MB");
        assert_eq!(with_unit("render.meshes_visible", 120.0), "120");
        assert_eq!(age(30), "30s ago");
        assert_eq!(age(7200), "2h ago");
    }

    #[test]
    fn plan_groups_and_rows() {
        let mut m = Metrics::default();
        for k in ["frame.ms", "cpu.process_pct", "render.meshes_visible", "render.lod_far", "span.ai_ms", "ai.think_ms"] {
            m.record(k, 1.0);
        }
        let past = vec![SessionSummary {
            keys: [("span.physics_ms".to_string(), Summary::default())].into_iter().collect(),
            ..default()
        }];
        let p = make_plan(&m, &past, &MetricsCompare::default(), &MetricsFeatured::default(), (1440, 900), 2.0);
        assert!(p.featured.is_empty());
        let extra = MetricsFeatured(vec!["frame.ms", "gpu.pct", "cpu.process_pct"]);
        let p = make_plan(&m, &past, &MetricsCompare::default(), &extra, (1440, 900), 2.0);
        assert_eq!(p.featured, ["frame.ms", "cpu.process_pct"]);
        let groups: Vec<&str> = p.groups.iter().flatten().map(|(g, _)| g.as_str()).collect();
        for g in ["frame", "cpu", "render", "span", "ai"] {
            assert!(groups.contains(&g), "{g} in {groups:?}");
        }
        let rows: Vec<String> = p.rows.iter().map(|(k, s)| format!("{k} {s}")).collect();
        assert!(rows.contains(&"frame.ms p95".to_string()));
        assert!(rows.contains(&"span.ai_ms avg".to_string()));
        assert!(rows.contains(&"span.physics_ms avg".to_string()), "past-only keys are compared too: {rows:?}");
        assert!(!rows.iter().any(|r| r.starts_with("gpu.pct")), "unknown keys are skipped");
        assert_eq!(p.run_cols, 2, "now + one past run");
    }
}
