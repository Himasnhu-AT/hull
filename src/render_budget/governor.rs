//! Quality governor: lower graphics settings while the GPU (or memory) can't keep up, raise
//! them again when there is room. Like Unreal's dynamic resolution and Unity's adaptive
//! performance: render scale first, then the features players notice least.
//!
//! - **Signal.** With a GPU sample ([`GpuLoad::sample`], filled by the `devtools` perf monitor:
//!   this process's GPU time per frame over a 1 s window, flagged `clean` when the window had no
//!   hitch), the governor acts only on new clean samples taken after its cooldown: down after
//!   two over `B × down_at` (two steps at once over `1.4 B`), up after four under `B × up_at`
//!   when the step's measured saving also fits under `0.85 B`. GPU-bound is a hysteresis on the
//!   GPU busy share (in at 85%, out at 70%; unknown never blocks a step down). Without a sample
//!   (ship builds) it steers on frame time (EMA; frames over 250 ms ignored): down on missed
//!   frames (`B × 1.15`), up by trying a step. `B = 1000 / target_fps` ms.
//! - **Bans.** A step that comes back and has to go again within 15 s is banned from coming
//!   back for 60 s, then 120 s, then 600 s.
//! - **Ladder** ([`QualityGovernor::steps`]). By default only levers that leave render
//!   pipelines alone: render scale, sun shadow-map size, and [`GovernorStep::Game`] levels the
//!   game reads from [`GovernorState::game_level`] (Shroud: how many lamps cast shadows). View
//!   features (SSR, SSAO, contact shadows, volumetric fog, shadow filter, bloom, TAA) are
//!   available as steps but off the default ladder: on macOS Bevy compiles pipelines
//!   synchronously, so each toggle stalls the render thread and meshes skip frames while
//!   their new shaders build. When used they stay off at least [`QualityGovernor::costly_hold`].
//!   Steps go on a copy of the game's [`QualityPreset`] (all tiers) and [`super::RenderScale`];
//!   the player's saved quality never changes. Restored in reverse order.
//! - **Memory.** Every 2 s the process footprint is compared with
//!   [`QualityGovernor::memory_budget_mb`] (default 60% of RAM); over it, the next
//!   [`QualityGovernor::memory_steps`] entry applies, for the rest of the session.
//! - Runs only in unpaused `InGame` with a focused window (or a test-driven run); menus pace
//!   reactively and their frame times say nothing. Off by default in test-driven runs
//!   (`--control`, `--offscreen`, `--mcp`) so tests and benchmarks keep their quality, and in
//!   headless apps.
//!
//! Every change sends a [`QualityChanged`] message (with a ready-made [`QualityChanged::text`]
//! for a toast) and updates [`GovernorState`]. Control command (devtools): `render.governor`.

use bevy::light::ShadowFilteringMethod;
use bevy::prelude::*;

use super::scale::{MIN_SCALE, RenderScale};
use crate::flow::AppState;
use crate::gfx::QualityPreset;
use crate::pause::Paused;

/// One rung of the ladder.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GovernorStep {
    /// Render scale at most this (per axis of the window's physical size).
    Scale(f32),
    /// Screen-space reflections off.
    Ssr,
    /// Realtime reflection probes refresh at most every n frames (0 = frozen).
    ProbeRefresh(u32),
    /// SSAO off.
    Ssao,
    /// Contact shadows off.
    ContactShadows,
    /// Temporal shadow filtering → Gaussian.
    ShadowFilter,
    /// Sun shadow map at half size (not below 1024).
    ShadowMapHalf,
    /// Volumetric fog off.
    Volumetric,
    /// Bloom off.
    Bloom,
    /// Scenery detail distances × this.
    Detail(f32),
    /// TAA → FXAA.
    Taa,
    /// A game-defined level (1, 2, …): the game reads [`GovernorState::game_level`], the
    /// highest one applied, and cuts what it knows is expensive (e.g. shadowed lamps).
    Game(u8),
}

impl GovernorStep {
    /// Short name for logs and toasts.
    pub fn label(&self) -> String {
        match self {
            GovernorStep::Scale(s) => format!("render scale {:.0}%", s * 100.0),
            GovernorStep::Ssr => "reflections".into(),
            GovernorStep::ProbeRefresh(0) => "reflection probes frozen".into(),
            GovernorStep::ProbeRefresh(n) => format!("reflection probes every {n} frames"),
            GovernorStep::Ssao => "ambient occlusion".into(),
            GovernorStep::ContactShadows => "contact shadows".into(),
            GovernorStep::ShadowFilter => "soft shadow filtering".into(),
            GovernorStep::ShadowMapHalf => "shadow resolution".into(),
            GovernorStep::Volumetric => "volumetric fog".into(),
            GovernorStep::Bloom => "bloom".into(),
            GovernorStep::Detail(f) => format!("detail distance {:.0}%", f * 100.0),
            GovernorStep::Taa => "temporal anti-aliasing".into(),
            GovernorStep::Game(n) => format!("game detail level {n}"),
        }
    }

    /// Toggling it rebuilds render pipelines (a visible stall).
    pub fn costly(&self) -> bool {
        use GovernorStep::*;
        matches!(self, Ssr | Ssao | ContactShadows | ShadowFilter | Volumetric | Bloom | Taa)
    }

    /// Applies a preset step to every tier (scale steps change nothing here).
    pub fn apply(&self, p: &mut QualityPreset) {
        for i in 0..4 {
            match *self {
                GovernorStep::Scale(_) | GovernorStep::Game(_) => {}
                GovernorStep::Ssr => p.ssr[i] = false,
                GovernorStep::ProbeRefresh(n) => {
                    let r = &mut p.probe_refresh[i];
                    if n == 0 {
                        *r = 0;
                    } else if *r != 0 {
                        *r = (*r).max(n);
                    }
                }
                GovernorStep::Ssao => p.ssao[i] = false,
                GovernorStep::ContactShadows => p.contact_shadows[i] = false,
                GovernorStep::ShadowFilter => {
                    if p.shadow_filter[i] == ShadowFilteringMethod::Temporal {
                        p.shadow_filter[i] = ShadowFilteringMethod::Gaussian;
                    }
                }
                GovernorStep::ShadowMapHalf => p.shadow_map_size[i] = (p.shadow_map_size[i] / 2).max(1024).min(p.shadow_map_size[i]),
                GovernorStep::Volumetric => p.volumetric_fog[i] = false,
                GovernorStep::Bloom => p.bloom[i] = false,
                GovernorStep::Detail(f) => p.detail_scale[i] *= f,
                GovernorStep::Taa => p.taa[i] = false,
            }
        }
    }
}

/// Governor settings. Insert your own (built with `..default()`) to tune or turn it off.
#[derive(Resource, Clone, Debug)]
pub struct QualityGovernor {
    pub enabled: bool,
    /// Frame rate to hold.
    pub target_fps: f32,
    /// Step down when the load stays above `budget × down_at`…
    pub down_at: f32,
    /// …and up when it stays below `budget × up_at`.
    pub up_at: f32,
    /// Seconds over / under before stepping.
    pub down_after: f32,
    pub up_after: f32,
    /// Seconds after any change before judging again (at least the perf monitor's 1 s GPU
    /// sample plus shader warm-up, so the new setting is what gets measured).
    pub cooldown: f32,
    /// Seconds a step that rebuilds pipelines ([`GovernorStep::costly`]: SSR, SSAO, contact
    /// shadows, volumetric fog, shadow filter, bloom, TAA) stays off before it may come back:
    /// each toggle recompiles shaders and stalls.
    pub costly_hold: f32,
    /// Highest render scale the governor uses (a player's render-scale setting goes here).
    pub max_scale: f32,
    /// Degradation order, mildest first.
    pub steps: Vec<GovernorStep>,
    /// Footprint (MB) above which [`QualityGovernor::memory_steps`] apply. `None`: 60% of RAM.
    pub memory_budget_mb: Option<f32>,
    pub memory_steps: Vec<GovernorStep>,
}

impl Default for QualityGovernor {
    fn default() -> Self {
        use GovernorStep::*;
        QualityGovernor {
            enabled: true,
            target_fps: 60.0,
            down_at: 0.95,
            up_at: 0.70,
            down_after: 0.5,
            up_after: 3.0,
            cooldown: 2.5,
            costly_hold: 30.0,
            max_scale: 1.0,
            // Only levers that leave render pipelines alone (see the module docs).
            steps: vec![Scale(0.85), Scale(0.75), ShadowMapHalf, Game(1), Scale(0.65), Game(2), Scale(0.5)],
            memory_budget_mb: None,
            memory_steps: vec![ShadowMapHalf, ProbeRefresh(0), Scale(0.7), Volumetric],
        }
    }
}

/// GPU measurements, when something takes them (the `devtools` perf monitor does).
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct GpuLoad {
    /// Share of wall time the GPU worked for this process (0..1): GPU-bound or not.
    pub busy: Option<f32>,
    /// The last window's GPU time per frame.
    pub sample: Option<GpuSample>,
}

/// One measurement window: this process's GPU ms per frame. `clean`: no hitch in the window.
/// `seq` increases with every window (the governor acts once per new sample).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GpuSample {
    pub ms_per_frame: f32,
    pub clean: bool,
    pub seq: u64,
}

/// Main-thread CPU time and GPU time per frame (ms), when something measures them (the
/// `devtools` perf monitor). The FPS counter shows them.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct FrameCost {
    pub cpu_ms: Option<f32>,
    pub gpu_ms: Option<f32>,
}

/// Why the governor changed something.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GovernorReason {
    /// Frames took too long.
    Gpu,
    /// There was room again.
    Headroom,
    /// The process used more memory than the budget.
    Memory,
    /// Turned off, or the game changed its preset: back to full quality.
    Reset,
}

/// Sent on every governor change.
#[derive(Message, Clone, Debug)]
pub struct QualityChanged {
    pub reason: GovernorReason,
    /// Levels applied now (0 = full quality) of `levels`.
    pub level: usize,
    pub levels: usize,
    /// Memory steps applied now.
    pub memory_level: usize,
    /// The step that was applied (down) or undone (up).
    pub step: Option<GovernorStep>,
    /// Load and budget when it decided (ms).
    pub load_ms: f32,
    pub budget_ms: f32,
    pub scale: f32,
}

impl QualityChanged {
    /// One line for a toast.
    pub fn text(&self, target_fps: f32) -> String {
        let what = self.step.map(|s| s.label()).unwrap_or_default();
        match self.reason {
            GovernorReason::Gpu => format!("Lowered graphics to hold {target_fps:.0} fps ({what})"),
            GovernorReason::Memory => format!("Lowered graphics to save memory ({what})"),
            GovernorReason::Headroom if self.level == 0 && self.memory_level == 0 => "Graphics back to full quality".into(),
            GovernorReason::Headroom => format!("Raised graphics ({what})"),
            GovernorReason::Reset => "Graphics back to full quality".into(),
        }
    }
}

/// What the governor is doing (read-only for games).
#[derive(Resource, Clone, Debug, Default)]
pub struct GovernorState {
    pub level: usize,
    pub memory_level: usize,
    /// Smoothed load (ms): estimated GPU time when [`GpuLoad`] is known, else frame time.
    pub load_ms: f32,
    pub frame_ms: f32,
    pub gpu_bound: Option<bool>,
    /// The next step up is banned until this time (it came back and failed before).
    pub hold_until: f64,
    /// Highest [`GovernorStep::Game`] level applied (0 = none).
    pub game_level: u8,
    pub last_reason: Option<GovernorReason>,
    /// The step applied (down) or undone (up) by the last change.
    pub last_step: Option<GovernorStep>,
    pub changes: u32,
    pub footprint_mb: Option<f32>,
    pub memory_budget_mb: Option<f32>,
    /// Internal: smoothing and timers.
    ema: Option<f32>,
    over_since: Option<f64>,
    under_since: Option<f64>,
    quiet_until: f64,
    /// The last step up: when, and which step (to catch ones that don't hold).
    raised_at: Option<f64>,
    raised_step: Option<usize>,
    /// Per step: times banned, and banned until.
    bans: Vec<u8>,
    ban_until: Vec<f64>,
    /// Sample mode: last sample seen, clean samples over / under in a row.
    last_seq: u64,
    over_n: u8,
    under_n: u8,
    /// Measured GPU-time saving of each ladder step (ms), from the load before and after it.
    cost: Vec<Option<f32>>,
    /// When each step was last dropped (s).
    dropped_at: Vec<f64>,
    /// A drop being measured: (first step, steps, load before, measure at).
    measuring: Option<(usize, usize, f32, f64)>,
    next_mem: f64,
    /// The game's own preset, and what the governor last wrote.
    base: Option<QualityPreset>,
    written: Option<QualityPreset>,
}

pub(super) struct GovernorPlugin;

impl Plugin for GovernorPlugin {
    fn build(&self, app: &mut App) {
        // Tests and benchmarks (control port, offscreen, MCP) keep the quality they asked for;
        // `render.governor {enabled: true}` turns it on there.
        if !app.world().contains_resource::<QualityGovernor>() {
            app.insert_resource(QualityGovernor { enabled: !crate::cli::test_driven(), ..default() });
        }
        app.init_resource::<GovernorState>()
            .init_resource::<GpuLoad>()
            .init_resource::<FrameCost>()
            .add_message::<QualityChanged>()
            .add_systems(Update, govern.run_if(resource_exists::<QualityPreset>).run_if(crate::flow::has_visuals));
    }
}

/// Everything [`govern`] needs to decide, as plain values (unit-testable).
#[derive(Clone, Copy, Debug)]
pub(super) struct Sample {
    pub now: f64,
    pub frame_ms: f32,
    pub gpu_busy: Option<f32>,
    pub gpu: Option<GpuSample>,
    pub active: bool,
}

/// What to do this frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Decision {
    Hold,
    Down(usize),
    Up,
}

/// The control loop (no ECS): updates `st`'s smoothing and timers and returns a decision.
pub(super) fn decide(g: &QualityGovernor, st: &mut GovernorState, s: Sample) -> Decision {
    let levels = g.steps.len();
    if st.cost.len() != levels {
        st.cost = vec![None; levels];
        st.dropped_at = vec![f64::NEG_INFINITY; levels];
        st.bans = vec![0; levels];
        st.ban_until = vec![f64::NEG_INFINITY; levels];
    }
    if !s.active {
        st.ema = None;
        st.over_since = None;
        st.under_since = None;
        st.over_n = 0;
        st.under_n = 0;
        st.quiet_until = st.quiet_until.max(s.now + 1.0);
        return Decision::Hold;
    }
    if s.frame_ms > 0.0 && s.frame_ms <= 250.0 {
        st.frame_ms = if st.frame_ms == 0.0 { s.frame_ms } else { st.frame_ms + 0.1 * (s.frame_ms - st.frame_ms) };
    }
    // GPU-bound, with hysteresis; unknown stays unknown (and never blocks a step down).
    st.gpu_bound = match (s.gpu_busy, st.gpu_bound) {
        (None, _) => None,
        (Some(b), _) if b >= 0.85 => Some(true),
        (Some(b), _) if b < 0.70 => Some(false),
        (Some(_), prev) => prev.or(Some(true)),
    };
    let budget = 1000.0 / g.target_fps.max(1.0);
    let next = st.level.checked_sub(1);
    st.hold_until = next.map_or(0.0, |i| st.ban_until[i]);
    let held = next.is_some_and(|i| {
        s.now < st.ban_until[i] || (g.steps[i].costly() && s.now - st.dropped_at[i] < g.costly_hold as f64)
    });
    match s.gpu {
        Some(sample) => decide_sampled(g, st, s, sample, budget, held),
        None => decide_frames(g, st, s, budget, held),
    }
}

/// Sample mode: one decision per new clean GPU sample.
fn decide_sampled(g: &QualityGovernor, st: &mut GovernorState, s: Sample, sample: GpuSample, budget: f32, held: bool) -> Decision {
    if sample.seq == st.last_seq {
        return Decision::Hold;
    }
    st.last_seq = sample.seq;
    if s.now < st.quiet_until || !sample.clean {
        st.over_n = 0;
        st.under_n = 0;
        return Decision::Hold;
    }
    let load = sample.ms_per_frame;
    st.ema = Some(load);
    st.load_ms = load;
    finish_measuring(st, s.now, load);
    let levels = g.steps.len();
    let may_drop = st.gpu_bound != Some(false) && st.level < levels;
    if may_drop && load > budget * 1.4 {
        st.over_n = 0;
        st.under_n = 0;
        return Decision::Down(2.min(levels - st.level));
    }
    if load > budget * g.down_at {
        st.under_n = 0;
        st.over_n = st.over_n.saturating_add(1);
        if may_drop && st.over_n >= 2 {
            st.over_n = 0;
            return Decision::Down(1);
        }
        return Decision::Hold;
    }
    st.over_n = 0;
    if load < budget * g.up_at {
        st.under_n = st.under_n.saturating_add(1);
        let fits = st.level.checked_sub(1).and_then(|i| st.cost[i]).is_none_or(|c| load + c < budget * 0.85);
        if st.under_n >= 4 && st.level > 0 && fits && !held && st.measuring.is_none() {
            st.under_n = 0;
            return Decision::Up;
        }
    } else {
        st.under_n = 0;
    }
    Decision::Hold
}

/// Frame-time mode (no GPU sample): EMA of frame time, down on missed frames, up by trying.
fn decide_frames(g: &QualityGovernor, st: &mut GovernorState, s: Sample, budget: f32, held: bool) -> Decision {
    if s.frame_ms > 250.0 || s.frame_ms <= 0.0 {
        return Decision::Hold;
    }
    let ema = st.ema.map_or(s.frame_ms, |e| e + 0.1 * (s.frame_ms - e));
    st.ema = Some(ema);
    st.load_ms = ema;
    if s.now < st.quiet_until {
        st.over_since = None;
        st.under_since = None;
        return Decision::Hold;
    }
    finish_measuring(st, s.now, ema);
    let levels = g.steps.len();
    // Frame time can't show headroom below the budget (vsync), only missed frames.
    if ema > budget * g.down_at.max(1.15) && st.gpu_bound != Some(false) {
        st.under_since = None;
        let since = *st.over_since.get_or_insert(s.now);
        if st.level < levels && s.now - since >= g.down_after as f64 {
            let n = if ema > budget * 1.5 { 2 } else { 1 };
            return Decision::Down(n.min(levels - st.level));
        }
        return Decision::Hold;
    }
    st.over_since = None;
    if ema < budget * 1.05 && st.level > 0 && !held {
        let since = *st.under_since.get_or_insert(s.now);
        if s.now - since >= (g.up_after * 2.0) as f64 {
            st.under_since = None;
            return Decision::Up;
        }
    } else {
        st.under_since = None;
    }
    Decision::Hold
}

/// After a drop has settled: what it saved, split over its steps.
fn finish_measuring(st: &mut GovernorState, now: f64, load: f32) {
    if let Some((first, n, before, at)) = st.measuring
        && now >= at
    {
        st.measuring = None;
        let each = ((before - load) / n as f32).max(0.0);
        for c in st.cost.iter_mut().skip(first).take(n) {
            *c = Some(each);
        }
    }
}

/// Moves the levels for a decision and starts the cooldown (and the cost measurement of a
/// drop). Returns the step applied (down) or undone (up).
pub(super) fn step(g: &QualityGovernor, st: &mut GovernorState, d: Decision, now: f64) -> Option<GovernorStep> {
    let wait = g.cooldown as f64;
    let out = match d {
        Decision::Hold => return None,
        Decision::Down(n) => {
            let first = st.level;
            // The step just brought back didn't hold: ban it from coming back for a while.
            if st.raised_step == Some(first) && st.raised_at.is_some_and(|t| now - t < 15.0) && first < st.bans.len() {
                st.bans[first] = st.bans[first].saturating_add(1);
                let secs = [60.0, 120.0, 600.0][(st.bans[first] as usize - 1).min(2)];
                st.ban_until[first] = now + secs;
                info!("quality governor: {} didn't hold, not raised again for {secs:.0} s", g.steps[first].label());
            }
            st.raised_at = None;
            st.raised_step = None;
            st.level = (st.level + n).min(g.steps.len());
            let n = st.level - first;
            if let Some(before) = st.ema {
                st.measuring = Some((first, n, before, now + wait + 1.0));
            }
            for t in st.dropped_at.iter_mut().skip(first).take(n) {
                *t = now;
            }
            g.steps.get(st.level.saturating_sub(1)).copied()
        }
        Decision::Up => {
            st.level -= 1;
            st.raised_at = Some(now);
            st.raised_step = Some(st.level);
            st.measuring = None;
            g.steps.get(st.level).copied()
        }
    };
    st.quiet_until = now + wait;
    st.ema = None;
    out
}

/// The preset and render scale for the current levels.
pub(super) fn target(g: &QualityGovernor, base: &QualityPreset, level: usize, memory_level: usize) -> (QualityPreset, f32) {
    let mut p = base.clone();
    let mut scale = g.max_scale.clamp(MIN_SCALE, 1.0);
    let steps = g.steps.iter().take(level).chain(g.memory_steps.iter().take(memory_level));
    for step in steps {
        match step {
            GovernorStep::Scale(s) => scale = scale.min(*s),
            s => s.apply(&mut p),
        }
    }
    (p, scale)
}

#[allow(clippy::too_many_arguments)]
fn govern(
    g: Res<QualityGovernor>,
    mut st: ResMut<GovernorState>,
    mut preset: ResMut<QualityPreset>,
    mut rs: ResMut<RenderScale>,
    load: Res<GpuLoad>,
    time: Res<Time<Real>>,
    state: Option<Res<State<AppState>>>,
    paused: Option<Res<Paused>>,
    windows: Query<&Window>,
    mut out: MessageWriter<QualityChanged>,
) {
    let st = &mut *st;
    let now = time.elapsed_secs_f64();
    // The game (or a settings screen) changed the preset: that's the new base.
    if preset.is_changed() && st.written.as_ref() != Some(&*preset) {
        st.base = Some(preset.clone());
    }
    let base = st.base.get_or_insert_with(|| preset.clone()).clone();

    if !g.enabled {
        if st.level > 0 || st.memory_level > 0 {
            st.level = 0;
            st.memory_level = 0;
            commit(&g, st, &base, &mut preset, &mut rs, GovernorReason::Reset, None, &mut out);
        }
        return;
    }
    let playing = state.is_some_and(|s| *s.get() == AppState::InGame) && !paused.is_some_and(|p| p.0);
    // Any of our windows focused (the metrics window takes focus while the game still renders).
    let focused = crate::cli::test_driven() || windows.is_empty() || windows.iter().any(|w| w.focused);
    let sample = Sample { now, frame_ms: time.delta_secs() * 1000.0, gpu_busy: load.busy, gpu: load.sample, active: playing && focused };
    let decision = decide(&g, st, sample);

    // Memory, every 2 s.
    if now >= st.next_mem {
        st.next_mem = now + 2.0;
        st.footprint_mb = footprint_mb();
        st.memory_budget_mb = g.memory_budget_mb.or_else(|| ram_mb().map(|r| r * 0.6));
        if let (Some(f), Some(b)) = (st.footprint_mb, st.memory_budget_mb)
            && f > b
            && st.memory_level < g.memory_steps.len()
        {
            st.memory_level += 1;
            let step = g.memory_steps[st.memory_level - 1];
            warn!("quality governor: footprint {f:.0} MB over budget {b:.0} MB, {}", step.label());
            commit(&g, st, &base, &mut preset, &mut rs, GovernorReason::Memory, Some(step), &mut out);
            return;
        }
    }
    let (reason, step) = match decision {
        Decision::Hold => {
            // Keep scale and preset in line with the levels (a game may have reset them).
            if st.level > 0 || st.memory_level > 0 || st.written.is_some() {
                let (want, scale) = target(&g, &base, st.level, st.memory_level);
                if *preset != want {
                    *preset = want.clone();
                }
                st.written = Some(want);
                if (rs.scale - scale).abs() > 1e-4 {
                    rs.scale = scale;
                }
            }
            return;
        }
        d => {
            let reason = if matches!(d, Decision::Up) { GovernorReason::Headroom } else { GovernorReason::Gpu };
            (reason, step(&g, st, d, now))
        }
    };
    info!(
        "quality governor: level {}/{} ({:?} {}), load {:.1} ms, frame {:.1} ms",
        st.level,
        g.steps.len(),
        reason,
        step.map(|s| s.label()).unwrap_or_default(),
        st.load_ms,
        st.frame_ms
    );
    commit(&g, st, &base, &mut preset, &mut rs, reason, step, &mut out);
}

#[allow(clippy::too_many_arguments)]
fn commit(
    g: &QualityGovernor,
    st: &mut GovernorState,
    base: &QualityPreset,
    preset: &mut ResMut<QualityPreset>,
    rs: &mut ResMut<RenderScale>,
    reason: GovernorReason,
    step: Option<GovernorStep>,
    out: &mut MessageWriter<QualityChanged>,
) {
    let (want, scale) = target(g, base, st.level, st.memory_level);
    if **preset != want {
        **preset = want.clone();
    }
    st.written = Some(want);
    if (rs.scale - scale).abs() > 1e-4 {
        rs.scale = scale;
    }
    st.game_level = g
        .steps
        .iter()
        .take(st.level)
        .chain(g.memory_steps.iter().take(st.memory_level))
        .filter_map(|s| if let GovernorStep::Game(n) = s { Some(*n) } else { None })
        .max()
        .unwrap_or(0);
    st.last_reason = Some(reason);
    st.last_step = step;
    st.changes += 1;
    out.write(QualityChanged {
        reason,
        level: st.level,
        levels: g.steps.len(),
        memory_level: st.memory_level,
        step,
        load_ms: st.load_ms,
        budget_ms: 1000.0 / g.target_fps.max(1.0),
        scale,
    });
}

/// This process's memory footprint (MB): `phys_footprint` on macOS (Activity Monitor's
/// "Memory"), resident size on Linux.
pub fn footprint_mb() -> Option<f32> {
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: `info` is a writable rusage_info_v2, matching the RUSAGE_INFO_V2 flavor.
        let rc = unsafe { libc::proc_pid_rusage(libc::getpid(), libc::RUSAGE_INFO_V2, info.as_mut_ptr() as *mut libc::rusage_info_t) };
        if rc != 0 {
            return None;
        }
        // SAFETY: zero-initialised and filled in by a successful proc_pid_rusage.
        let info = unsafe { info.assume_init() };
        Some(info.ri_phys_footprint as f32 / 1048576.0)
    }
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/self/statm").ok()?;
        let pages: f32 = s.split_whitespace().nth(1)?.parse().ok()?;
        Some(pages * 4096.0 / 1048576.0)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// Physical RAM (MB).
pub fn ram_mb() -> Option<f32> {
    #[cfg(target_os = "macos")]
    {
        let mut bytes: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: "hw.memsize" is a u64; `bytes`/`len` describe a writable u64.
        let rc = unsafe { libc::sysctlbyname(c"hw.memsize".as_ptr(), (&mut bytes as *mut u64).cast(), &mut len, std::ptr::null_mut(), 0) };
        (rc == 0).then_some(bytes as f32 / 1048576.0)
    }
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: f32 = s.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb / 1024.0)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frame mode: per-frame frame times, no GPU sample.
    fn frames(g: &QualityGovernor, st: &mut GovernorState, t0: f64, secs: f64, frame_ms: f32) -> Vec<Decision> {
        let mut out = vec![];
        let mut t = t0;
        while t < t0 + secs {
            t += frame_ms as f64 / 1000.0;
            let d = decide(g, st, Sample { now: t, frame_ms, gpu_busy: None, gpu: None, active: true });
            if d != Decision::Hold {
                step(g, st, d, t);
                out.push(d);
            }
        }
        out
    }

    /// Sample mode: one GPU sample per second (`ms`, busy, clean), frames at 60 Hz between.
    fn samples(g: &QualityGovernor, st: &mut GovernorState, t0: f64, list: &[(f32, f32, bool)]) -> Vec<Decision> {
        let mut out = vec![];
        for (k, &(ms, busy, clean)) in list.iter().enumerate() {
            let seq = st.last_seq + 1; // a new sample every second
            let gpu = Some(GpuSample { ms_per_frame: ms, clean, seq });
            for f in 0..60 {
                let t = t0 + k as f64 + f as f64 / 60.0;
                let d = decide(g, st, Sample { now: t, frame_ms: 16.7, gpu_busy: Some(busy), gpu, active: true });
                if d != Decision::Hold {
                    step(g, st, d, t);
                    out.push(d);
                }
            }
        }
        out
    }

    fn fresh(g: &QualityGovernor) -> GovernorState {
        let mut st = GovernorState::default();
        decide(g, &mut st, Sample { now: 0.0, frame_ms: 16.7, gpu_busy: None, gpu: None, active: false });
        st.quiet_until = 0.0;
        st
    }

    #[test]
    fn steps_down_after_two_clean_samples_and_panics_on_one() {
        let g = QualityGovernor::default();
        let mut st = fresh(&g);
        // 18 ms GPU frames (over 0.95 × 16.7): one sample isn't enough, two are.
        let d = samples(&g, &mut st, 10.0, &[(18.0, 0.95, true)]);
        assert!(d.is_empty());
        let d = samples(&g, &mut st, 11.0, &[(18.0, 0.95, true)]);
        assert_eq!(d, vec![Decision::Down(1)]);
        // 25 ms (over 1.4 ×): two steps on the first clean sample after the cooldown.
        let mut st = fresh(&g);
        assert_eq!(samples(&g, &mut st, 10.0, &[(25.0, 0.95, true)]), vec![Decision::Down(2)]);
    }

    #[test]
    fn hitchy_or_cpu_bound_samples_do_nothing() {
        let g = QualityGovernor::default();
        let mut st = fresh(&g);
        // Not clean (a hitch in the window): ignored.
        assert!(samples(&g, &mut st, 10.0, &[(30.0, 0.95, false), (30.0, 0.95, false), (30.0, 0.95, false)]).is_empty());
        // GPU busy only 40%: CPU-bound, the GPU levers stay.
        assert!(samples(&g, &mut st, 20.0, &[(18.0, 0.4, true), (18.0, 0.4, true), (18.0, 0.4, true)]).is_empty());
        assert_eq!(st.level, 0);
    }

    #[test]
    fn up_needs_four_clean_samples_and_a_cost_that_fits() {
        let g = QualityGovernor::default();
        let mut st = fresh(&g);
        st.level = 2;
        st.cost[1] = Some(6.0);
        // 10 ms + 6 ms cost = 16 > 0.85 × 16.7: stays down however long it waits.
        let quiet: Vec<_> = (0..10).map(|_| (10.0, 0.9, true)).collect();
        assert!(samples(&g, &mut st, 10.0, &quiet).is_empty());
        // 7 ms + 6 = 13 fits: up after four clean samples.
        let cheap: Vec<_> = (0..5).map(|_| (7.0, 0.9, true)).collect();
        assert_eq!(samples(&g, &mut st, 30.0, &cheap), vec![Decision::Up]);
        assert_eq!(st.level, 1);
    }

    #[test]
    fn a_step_that_does_not_hold_is_banned_longer_each_time() {
        let g = QualityGovernor::default();
        let mut st = fresh(&g);
        st.level = 1;
        let cheap: Vec<_> = (0..5).map(|_| (7.0, 0.9, true)).collect();
        assert_eq!(samples(&g, &mut st, 10.0, &cheap), vec![Decision::Up]);
        // Right after coming back it's over budget again: down, and banned for 60 s.
        let over: Vec<_> = (0..6).map(|_| (18.0, 0.95, true)).collect();
        assert_eq!(samples(&g, &mut st, 15.0, &over[..3]), vec![Decision::Down(1)]);
        assert!(st.ban_until[0] > 70.0 && st.ban_until[0] < 80.0, "{}", st.ban_until[0]);
        let cheap: Vec<_> = (0..20).map(|_| (7.0, 0.9, true)).collect();
        assert!(samples(&g, &mut st, 30.0, &cheap).is_empty(), "banned");
        // After the ban it may come back (its measured saving is small enough to fit); failing
        // again bans it for 120 s.
        st.cost[0] = Some(2.0);
        assert_eq!(samples(&g, &mut st, 80.0, &cheap[..5]), vec![Decision::Up]);
        assert_eq!(samples(&g, &mut st, 86.0, &over[..3]), vec![Decision::Down(1)]);
        assert!(st.ban_until[0] > 200.0);
    }

    #[test]
    fn frame_mode_steps_on_missed_frames_only() {
        let g = QualityGovernor::default();
        let mut st = fresh(&g);
        // Vsync-locked on target: nothing to do.
        assert!(frames(&g, &mut st, 0.0, 5.0, 16.6).is_empty());
        // Missing frames (33 ms): down.
        let d = frames(&g, &mut st, 5.0, 2.0, 33.3);
        assert!(matches!(d.first(), Some(Decision::Down(_))));
    }

    #[test]
    fn costly_steps_are_held_after_a_drop() {
        let g = QualityGovernor { steps: vec![GovernorStep::Scale(0.85), GovernorStep::Ssr], ..default() };
        let mut st = fresh(&g);
        st.level = 2;
        st.dropped_at[1] = 0.0; // SSR dropped at t = 0
        let cheap: Vec<_> = (0..15).map(|_| (5.0, 0.9, true)).collect();
        assert!(samples(&g, &mut st, 5.0, &cheap).is_empty());
        assert_eq!(samples(&g, &mut st, 31.0, &cheap[..5]), vec![Decision::Up]);
    }

    #[test]
    fn ladder_targets_compose() {
        let g = QualityGovernor::default();
        let base = QualityPreset::default();
        let (p, s) = target(&g, &base, 0, 0);
        assert_eq!(p, base);
        assert_eq!(s, 1.0);
        // The default ladder never touches a view feature (no pipeline rebuilds).
        assert!(g.steps.iter().all(|s| !s.costly()));
        let (p, s) = target(&g, &base, g.steps.len(), 0);
        assert_eq!(s, 0.5);
        assert_eq!((p.ssr, p.ssao, p.taa, p.contact_shadows), (base.ssr, base.ssao, base.taa, base.contact_shadows));
        assert_eq!(p.shadow_map_size[3], 1024);
        // Memory steps: half shadow map, probes frozen.
        let (p, _) = target(&g, &base, 0, 2);
        assert_eq!(p.shadow_map_size[3], 1024);
        assert_eq!(p.probe_refresh[3], 0);
    }
}
