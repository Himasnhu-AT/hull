//! Perf overlay ([`PerfOverlayKey`], default F3; `--perf`; or `perf.overlay`): sparklines (last
//! 60 s of frame time, CPU, GPU, RAM) over two columns of labelled, colour-coded rows (green /
//! amber / red), fed by the perf monitor's 1 Hz snapshots, plus the game's [`DebugLines`].
//! Rebuilt at most 4×/s, only while visible and only when a new snapshot arrived or the debug
//! lines changed; text and colours are written only when they change (no relayout otherwise).
//! Sparklines are 60×32 textures rewritten in place. ASCII only (default font).

use std::sync::Arc;
use std::time::{Duration, Instant};

use bevy::asset::RenderAssetUsages;
use bevy::image::ImageSampler;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

use super::perf::{DebugLines, PerfCost, PerfOverlay, PerfOverlayKey, PerfShared, PerfSnapshot, ProcRow, Stat};
use crate::flow::Headless;

const REFRESH: Duration = Duration::from_millis(250);
/// Text rows per column.
const ROWS: usize = 28;
const GW: u32 = 60;
const GH: u32 = 32;

const GREEN: Color = Color::srgb(0.55, 0.92, 0.55);
const AMBER: Color = Color::srgb(1.0, 0.76, 0.30);
const RED: Color = Color::srgb(1.0, 0.42, 0.36);
const PLAIN: Color = Color::srgb(0.86, 0.90, 0.95);
const DIM: Color = Color::srgb(0.60, 0.66, 0.74);
const HEAD: Color = Color::srgb(0.55, 0.78, 1.0);
const ME: Color = Color::srgb(0.45, 0.95, 1.0);

#[derive(Component)]
struct PerfPanel;

#[derive(Component)]
struct Line(usize, usize);

#[derive(Component)]
struct GraphLabel(usize);

#[derive(Resource)]
struct Graphs([Handle<Image>; 4]);

pub struct PerfOverlayPlugin;

impl Plugin for PerfOverlayPlugin {
    fn build(&self, _: &mut App) {}

    fn finish(&self, app: &mut App) {
        // Needs bevy_ui + images; never in --headless / MinimalPlugins apps.
        let ui = app.is_plugin_added::<bevy::ui::UiPlugin>() && app.world().contains_resource::<Assets<Image>>();
        if ui {
            app.add_systems(Startup, spawn.run_if(visuals))
                .add_systems(Update, update.run_if(visuals).run_if(resource_exists::<Graphs>));
        }
    }
}

fn visuals(h: Option<Res<Headless>>) -> bool {
    h.is_none_or(|h| !h.0)
}

fn graph_image() -> Image {
    let mut img = Image::new_fill(
        Extent3d { width: GW, height: GH, depth_or_array_layers: 1 },
        TextureDimension::D2,
        &[0, 0, 0, 0],
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::RENDER_WORLD | RenderAssetUsages::MAIN_WORLD,
    );
    img.sampler = ImageSampler::nearest();
    img
}

fn spawn(mut commands: Commands, mut images: ResMut<Assets<Image>>, key: Res<PerfOverlayKey>) {
    let handles = [(); 4].map(|_| images.add(graph_image()));
    let text = |s: &str, size: f32, c: Color| (Text::new(s), TextFont::from_font_size(size), TextColor(c));
    let panel = commands
        .spawn((
            Name::new("Perf overlay"),
            PerfPanel,
            Node {
                position_type: PositionType::Absolute,
                left: px(16),
                top: px(56),
                padding: UiRect::axes(px(12), px(8)),
                flex_direction: FlexDirection::Column,
                row_gap: px(6),
                ..default()
            },
            BackgroundColor(Color::srgba(0.02, 0.03, 0.05, 0.82)),
            GlobalZIndex(1000),
            Visibility::Hidden,
        ))
        .id();
    let title = commands
        .spawn((Line(9, 0), text(&format!("PERF [{:?}]  waiting for first sample", key.0), 15.0, HEAD)))
        .id();
    let strip = commands.spawn(Node { flex_direction: FlexDirection::Row, column_gap: px(14), ..default() }).id();
    for (i, h) in handles.iter().enumerate() {
        let cell = commands
            .spawn(Node { flex_direction: FlexDirection::Column, row_gap: px(2), ..default() })
            .with_children(|c| {
                c.spawn((GraphLabel(i), text("", 12.0, DIM)));
                c.spawn((
                    ImageNode::new(h.clone()),
                    Node { width: px(170), height: px(34), ..default() },
                    BackgroundColor(Color::srgba(0.10, 0.13, 0.18, 0.9)),
                ));
            })
            .id();
        commands.entity(strip).add_child(cell);
    }
    let cols = commands.spawn(Node { flex_direction: FlexDirection::Row, column_gap: px(22), ..default() }).id();
    for col in 0..2 {
        let c = commands
            .spawn(Node { flex_direction: FlexDirection::Column, min_width: px(360), ..default() })
            .with_children(|c| {
                for row in 0..ROWS {
                    c.spawn((Line(col, row), text("", 13.0, PLAIN)));
                }
            })
            .id();
        commands.entity(cols).add_child(c);
    }
    commands.entity(panel).add_children(&[title, strip, cols]);
    commands.insert_resource(Graphs(handles));
}

fn update(
    keys: Option<Res<ButtonInput<KeyCode>>>,
    key: Res<PerfOverlayKey>,
    mut on: ResMut<PerfOverlay>,
    shared: Res<PerfShared>,
    lines_res: Res<DebugLines>,
    mut cost: ResMut<PerfCost>,
    graphs: Res<Graphs>,
    mut images: ResMut<Assets<Image>>,
    mut panel: Query<&mut Visibility, With<PerfPanel>>,
    mut lines: Query<(&Line, &mut Text, &mut TextColor), Without<GraphLabel>>,
    mut labels: Query<(&GraphLabel, &mut Text), Without<Line>>,
    mut last: Local<Option<(Instant, usize)>>,
    mut lines_dirty: Local<bool>,
) {
    let t0 = Instant::now();
    if keys.is_some_and(|k| k.just_pressed(key.0)) {
        on.0 = !on.0;
    }
    let want = if on.0 { Visibility::Inherited } else { Visibility::Hidden };
    for mut v in &mut panel {
        if *v != want {
            *v = want;
        }
    }
    *lines_dirty |= lines_res.is_changed() || on.is_changed();
    let due = last.is_none_or(|(at, _)| at.elapsed() >= REFRESH);
    if on.0
        && due
        && let Some(s) = shared.latest()
    {
        let id = Arc::as_ptr(&s) as usize;
        if last.is_none_or(|(_, prev)| prev != id) || *lines_dirty {
            *last = Some((Instant::now(), id));
            *lines_dirty = false;
            let cols = [left(&s, &lines_res), right(&s)];
            for (line, mut text, mut color) in &mut lines {
                let (s, c) = match line.0 {
                    9 => (title(&s, key.0, cost.avg_us), HEAD),
                    col => cols[col].get(line.1).cloned().unwrap_or_default(),
                };
                if text.0 != s {
                    text.0 = s;
                }
                if color.0 != c {
                    color.0 = c;
                }
            }
            for (g, mut text) in &mut labels {
                let s = graph_label(&s, g.0);
                if text.0 != s {
                    text.0 = s;
                }
            }
            draw_graphs(&s, &graphs.0, &mut images);
        }
    }
    cost.add(t0.elapsed());
}

/// Green below `amber`, amber below `red`, red above.
fn level(v: f32, amber: f32, red: f32) -> Color {
    if v >= red {
        RED
    } else if v >= amber {
        AMBER
    } else {
        GREEN
    }
}

fn opt(v: Option<f32>, prec: usize) -> String {
    v.map_or_else(|| "n/a".into(), |v| format!("{v:.prec$}"))
}

/// `61 (60s 55-66)`.
fn st(s: &Stat, prec: usize) -> String {
    format!("{:.prec$} (60s {:.prec$}-{:.prec$})", s.ema, s.min, s.max)
}

fn title(s: &PerfSnapshot, key: KeyCode, overhead_us: f32) -> String {
    format!(
        "PERF [{key:?}]   {:.0} fps   {:.1} ms/frame{}   monitor {overhead_us:.0} us/frame",
        s.fps.ema,
        s.frame_avg_ms.ema,
        if s.stalled { "   (stalled)" } else { "" }
    )
}

fn graph_label(s: &PerfSnapshot, i: usize) -> String {
    match i {
        0 => format!("frame ms  {:.1} (max {:.1})", s.frame_avg_ms.ema, s.frame_avg_ms.max),
        1 => format!("cpu % 1 core  {:.0} (max {:.0})", s.cpu.process.ema, s.cpu.process.max),
        2 => format!("gpu % game  {:.0} (max {:.0})", s.gpu.process.ema, s.gpu.process.max),
        _ => format!("ram MiB  {:.0} (max {:.0})", s.ram.footprint_mb.ema, s.ram.footprint_mb.max),
    }
}

type Rows = Vec<(String, Color)>;

fn left(s: &PerfSnapshot, debug: &DebugLines) -> Rows {
    let mut r: Rows = Vec::with_capacity(ROWS);
    let f = &s.frame_ms;
    r.push(("FRAME".into(), HEAD));
    r.push((format!(" fps        {}", st(&s.fps, 0)), level(-s.fps.ema, -90.0, -55.0)));
    r.push((format!(" avg ms     {}", st(&s.frame_avg_ms, 1)), level(s.frame_avg_ms.ema, 11.2, 18.0)));
    r.push((
        format!(" ms  p50 {:.1}  p95 {:.1}  p99 {:.1}  max {:.1}", f.p50, f.p95, f.p99, f.max),
        level(f.p99, 16.7, 33.3),
    ));
    r.push((format!(" hitches >50ms  {}", s.hitches), level(s.hitches as f32, 1.0, 3.0)));
    let c = &s.cpu;
    r.push((format!("CPU  % of one core ({} cores = {}%)", c.cores, c.cores * 100), HEAD));
    r.push((
        format!(" process    {}  = {:.1}% machine", st(&c.process, 0), c.machine_pct),
        level(c.process.ema, 250.0, 500.0),
    ));
    for t in c.threads.iter().take(7) {
        r.push((format!("   {:<20} {:>6.1}", trunc(&t.name, 20), t.cpu_pct), level(t.cpu_pct, 60.0, 85.0)));
    }
    let pools: Vec<String> = c
        .pools
        .iter()
        .filter(|p| p.name.ends_with(" pool"))
        .take(3)
        .map(|p| format!("{} {:.0}", p.name.trim_end_matches(" pool"), p.cpu_pct))
        .collect();
    if !pools.is_empty() {
        r.push((format!("   pools: {}", pools.join("  ")), DIM));
    }
    let m = &s.game;
    r.push(("GAME".into(), HEAD));
    r.push((format!(" {}  {} entities", m.state, m.entities), PLAIN));
    if !m.spans.is_empty() {
        let total: f32 = m.spans.iter().map(|s| s.ms).sum();
        let parts: Vec<String> = m.spans.iter().map(|s| format!("{} {:.2}", s.name, s.ms)).collect();
        r.push((format!(" ms/frame  {}", parts.join("  ")), level(total, 2.0, 4.0)));
    }
    r.push((
        format!(" monitor {:.0} us/frame (max {:.0})  sampler {:.1} ms/s", s.overhead_us, s.overhead_max_us, s.sampler_ms),
        level(s.overhead_us, 150.0, 300.0),
    ));
    for (_, line) in debug.iter() {
        r.push((format!(" {line}"), PLAIN));
    }
    r.truncate(ROWS);
    r
}

fn right(s: &PerfSnapshot) -> Rows {
    let mut r: Rows = Vec::with_capacity(ROWS);
    let g = &s.gpu;
    r.push((format!("GPU  %  (device = all apps, {} reads/s)", g.polls), HEAD));
    r.push((format!(" device     {}", st(&g.device, 0)), level(g.device.ema, 70.0, 90.0)));
    r.push((format!(" renderer {:.0}   tiler {:.0}", g.renderer.ema, g.tiler.ema), level(g.renderer.ema.max(g.tiler.ema), 70.0, 90.0)));
    r.push((format!(" this game  {}", st(&g.process, 0)), level(g.process.ema, 70.0, 90.0)));
    r.push((format!(" game ms/frame  {}", st(&g.frame_ms, 2)), level(g.frame_ms.ema, 8.0, 14.0)));
    r.push((
        format!(" mem MiB  game {}  device {:.0}/{}", opt(g.process_alloc_mb, 0), g.device_in_use_mb.ema, opt(g.device_alloc_mb, 0)),
        PLAIN,
    ));
    if let Some(ms) = g.passes_ms {
        r.push((format!(" passes {ms:.2} ms"), DIM));
    }
    r.push(("RAM  MiB".into(), HEAD));
    r.push((
        format!(" footprint  {}  rss {}", st(&s.ram.footprint_mb, 0), opt(s.ram.rss_mb, 0)),
        level(s.ram.footprint_mb.ema, 2048.0, 4096.0),
    ));
    let p = &s.procs;
    r.push((format!("TOP CPU ({} readable, {:.0}% sum)   cpu%    MiB   gpu%", p.count, p.total_cpu_pct), HEAD));
    for row in &p.by_cpu {
        r.push(proc_line(row));
    }
    r.push(("TOP GPU".into(), HEAD));
    for row in p.by_gpu.iter().filter(|x| x.gpu_pct.unwrap_or(0.0) >= 0.1 || x.me).take(4) {
        r.push(proc_line(row));
    }
    r.push(("TOP RAM".into(), HEAD));
    for row in p.by_mem.iter().take(3) {
        r.push(proc_line(row));
    }
    r.truncate(ROWS);
    r
}

fn proc_line(p: &ProcRow) -> (String, Color) {
    let o = |v: Option<f32>, prec: usize| v.map_or_else(|| "-".to_string(), |v| format!("{v:.prec$}"));
    let s = format!(
        "{}{:<20} {:>6} {:>6} {:>6}",
        if p.me { ">" } else { " " },
        trunc(&p.name, 20),
        o(p.cpu_pct, 1),
        o(p.mem_mb, 0),
        o(p.gpu_pct, 1)
    );
    (s, if p.me { ME } else { PLAIN })
}

fn trunc(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// Bar colour per graph for value `v`.
fn graph_color(i: usize, v: f32) -> Color {
    match i {
        0 => level(v, 11.2, 18.0),
        1 => level(v, 250.0, 500.0),
        2 => level(v, 70.0, 90.0),
        _ => level(v, 2048.0, 4096.0),
    }
}

fn draw_graphs(s: &PerfSnapshot, handles: &[Handle<Image>; 4], images: &mut Assets<Image>) {
    let h = &s.history;
    for (i, series) in [&h.frame_ms, &h.cpu, &h.gpu, &h.ram].into_iter().enumerate() {
        let Some(mut img) = images.get_mut(&handles[i]) else { continue };
        let Some(data) = img.data.as_mut() else { continue };
        let max = series.iter().copied().fold(0.0f32, f32::max);
        let min = series.iter().copied().fold(f32::INFINITY, f32::min);
        // Y range: frame/cpu from 0 with a floor; GPU 0-100; RAM zoomed on its own range.
        let (lo, hi) = match i {
            0 => (0.0, max.max(16.7)),
            1 => (0.0, max.max(100.0)),
            2 => (0.0, 100.0),
            _ => ((min * 0.95).max(0.0), (max * 1.02).max(min * 0.95 + 1.0)),
        };
        data.fill(0);
        let off = GW as usize - series.len().min(GW as usize);
        for (k, &v) in series.iter().rev().take(GW as usize).rev().enumerate() {
            let x = off + k;
            let frac = ((v - lo) / (hi - lo)).clamp(0.0, 1.0);
            let bar = ((frac * GH as f32).round() as u32).max(1);
            let c = graph_color(i, v).to_srgba();
            let px = [(c.red * 255.0) as u8, (c.green * 255.0) as u8, (c.blue * 255.0) as u8, 255];
            for y in (GH - bar)..GH {
                let o = ((y * GW) as usize + x) * 4;
                data[o..o + 4].copy_from_slice(&px);
            }
        }
    }
}
