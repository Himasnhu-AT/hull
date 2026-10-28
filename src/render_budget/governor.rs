//! Quality governor: lower graphics settings while the GPU (or memory) can't keep up, raise
//! them again when there is room. Like Unreal's dynamic resolution and Unity's adaptive
//! performance: render scale first, then the features players notice least.
//!
//! - **Signal.** Frame time (EMA, α 0.1; frames over 250 ms are hitches and ignored), and when
//!   known, the share of time the GPU spends on this process ([`GpuLoad`], filled by the
//!   `devtools` perf monitor). With the share, the governor steers on estimated GPU time and
//!   leaves a CPU-bound game alone; without it (ship builds) it steers on frame time and finds
//!   headroom by trying a step up (undone, with a doubling back-off, if it doesn't hold).
//! - **Budget** `B = 1000 / target_fps` ms. Down when the load stays above `B × down_at` (`B × 1.15` on frame time alone) for
//!   `down_after` s (two steps at once when it's above `1.5 B`); up when below `B × up_at` for
//!   `up_after` s. After any change it waits `cooldown` s and starts its average over.
//! - **Ladder** ([`QualityGovernor::steps`]): each level applies one more step: render scale
//!   ([`super::RenderScale`]) or a [`QualityPreset`] change made on a copy of the game's preset
//!   (all tiers), so every system that follows the preset follows the governor. The player's
//!   saved quality never changes. Restored in reverse order.
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
        }
    }

    /// Applies a preset step to every tier (scale steps change nothing here).
    pub fn apply(&self, p: &mut QualityPreset) {
        for i in 0..4 {
            match *self {
                GovernorStep::Scale(_) => {}
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
    /// Seconds after any change before judging again.
    pub cooldown: f32,
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
            up_at: 0.65,
            down_after: 0.5,
            up_after: 3.0,
            cooldown: 1.5,
            max_scale: 1.0,
            steps: vec![
                Scale(0.85),
                Scale(0.7),
                Ssr,
                ProbeRefresh(8),
                Ssao,
                ContactShadows,
                ShadowFilter,
                ShadowMapHalf,
                Scale(0.6),
                Scale(0.5),
                Volumetric,
                Bloom,
                Detail(0.75),
                Taa,
            ],
            memory_budget_mb: None,
            memory_steps: vec![ShadowMapHalf, ProbeRefresh(0), Scale(0.7), Volumetric],
        }
    }
}

/// Share of wall time the GPU worked for this process (0..1), when something measures it
/// (the `devtools` perf monitor does). Lets the governor tell GPU-bound from CPU-bound.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct GpuLoad(pub Option<f32>);

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
    /// Steps up undone because they didn't hold; while this is in the future no step up is tried.
    pub hold_until: f64,
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
    /// Time of the last step up (to catch ones that don't hold) and the back-off.
    raised_at: Option<f64>,
    backoff: f64,
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
    if !s.active {
        st.ema = None;
        st.over_since = None;
        st.under_since = None;
        st.quiet_until = st.quiet_until.max(s.now + 1.0);
        return Decision::Hold;
    }
    if s.frame_ms > 250.0 || s.frame_ms <= 0.0 {
        return Decision::Hold;
    }
    let load = s.gpu_busy.map_or(s.frame_ms, |b| b.clamp(0.0, 1.0) * s.frame_ms);
    let ema = st.ema.map_or(load, |e| e + 0.1 * (load - e));
    st.ema = Some(ema);
    st.load_ms = ema;
    st.frame_ms = st.frame_ms + 0.1 * (s.frame_ms - st.frame_ms);
    // GPU-bound unless the GPU is clearly idle part of the frame.
    st.gpu_bound = s.gpu_busy.map(|b| b > 0.8);
    if s.now < st.quiet_until {
        st.over_since = None;
        st.under_since = None;
        return Decision::Hold;
    }
    let budget = 1000.0 / g.target_fps.max(1.0);
    let levels = g.steps.len();
    // Frame time alone can't show headroom below the budget (vsync), only missed frames.
    let down_at = if s.gpu_busy.is_some() { g.down_at } else { g.down_at.max(1.15) };
    if ema > budget * down_at && st.gpu_bound != Some(false) {
        st.under_since = None;
        let since = *st.over_since.get_or_insert(s.now);
        if st.level < levels && s.now - since >= g.down_after as f64 {
            // A step up that didn't hold: back off before trying again.
            if st.raised_at.is_some_and(|t| s.now - t < 5.0) {
                st.backoff = (st.backoff * 2.0).clamp(10.0, 120.0);
                st.hold_until = s.now + st.backoff;
            }
            st.raised_at = None;
            let n = if ema > budget * 1.5 { 2 } else { 1 };
            return Decision::Down(n.min(levels - st.level));
        }
        return Decision::Hold;
    }
    st.over_since = None;
    // Without a GPU-time estimate, frame time can't show headroom under vsync: try a step up
    // whenever frames are on target (the back-off catches steps that don't hold).
    let room = match s.gpu_busy {
        Some(_) => ema < budget * g.up_at,
        None => ema < budget * 1.05,
    };
    if room && st.level > 0 && s.now >= st.hold_until {
        let since = *st.under_since.get_or_insert(s.now);
        let wait = if s.gpu_busy.is_some() { g.up_after } else { g.up_after * 2.0 } as f64;
        if s.now - since >= wait {
            st.under_since = None;
            return Decision::Up;
        }
    } else {
        st.under_since = None;
    }
    // Stable for a while: forget the back-off.
    if st.raised_at.is_some_and(|t| s.now - t > 30.0) {
        st.raised_at = None;
        st.backoff = 0.0;
    }
    Decision::Hold
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
    windows: Query<&Window, With<bevy::window::PrimaryWindow>>,
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
    let focused = crate::cli::test_driven() || windows.iter().next().is_none_or(|w| w.focused);
    let sample = Sample { now, frame_ms: time.delta_secs() * 1000.0, gpu_busy: load.0, active: playing && focused };
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
        Decision::Down(n) => {
            st.level = (st.level + n).min(g.steps.len());
            (GovernorReason::Gpu, g.steps.get(st.level - 1).copied())
        }
        Decision::Up => {
            st.level -= 1;
            st.raised_at = Some(now);
            (GovernorReason::Headroom, g.steps.get(st.level).copied())
        }
    };
    st.quiet_until = now + g.cooldown as f64;
    st.ema = None;
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

    fn run(g: &QualityGovernor, st: &mut GovernorState, t0: f64, secs: f64, frame_ms: f32, busy: Option<f32>) -> Vec<Decision> {
        let mut out = vec![];
        let mut t = t0;
        while t < t0 + secs {
            t += frame_ms as f64 / 1000.0;
            let d = decide(g, st, Sample { now: t, frame_ms, gpu_busy: busy, active: true });
            match d {
                Decision::Hold => {}
                Decision::Down(n) => {
                    st.level += n;
                    st.quiet_until = t + g.cooldown as f64;
                    st.ema = None;
                    out.push(d);
                }
                Decision::Up => {
                    st.level -= 1;
                    st.raised_at = Some(t);
                    st.quiet_until = t + g.cooldown as f64;
                    st.ema = None;
                    out.push(d);
                }
            }
        }
        out
    }

    #[test]
    fn steps_down_fast_and_up_slowly() {
        let g = QualityGovernor::default();
        let mut st = GovernorState::default();
        // 35 ms GPU-bound frames against a 16.7 ms budget: panic (2 steps) within a second.
        let d = run(&g, &mut st, 0.0, 1.0, 35.0, Some(0.98));
        assert_eq!(d.first(), Some(&Decision::Down(2)));
        // Fast frames with lots of GPU headroom: one step up per up_after + cooldown, not sooner.
        let lvl = st.level;
        let d = run(&g, &mut st, 10.0, 3.5, 8.0, Some(0.5));
        assert!(d.is_empty() || d == vec![Decision::Up], "{d:?}");
        let d = run(&g, &mut st, 13.5, 20.0, 8.0, Some(0.5));
        assert!(d.iter().all(|x| *x == Decision::Up) && st.level < lvl);
    }

    #[test]
    fn cpu_bound_frames_leave_the_gpu_alone() {
        let g = QualityGovernor::default();
        let mut st = GovernorState::default();
        // 30 ms frames but the GPU is busy only 40% of the time: not a GPU problem.
        assert!(run(&g, &mut st, 0.0, 5.0, 30.0, Some(0.4)).is_empty());
        assert_eq!(st.level, 0);
    }

    #[test]
    fn a_step_up_that_does_not_hold_backs_off() {
        let g = QualityGovernor::default();
        let mut st = GovernorState { level: 3, ..default() };
        // Vsync-locked on target, no GPU signal: it tries a step up…
        let d = run(&g, &mut st, 0.0, 10.0, 16.6, None);
        assert_eq!(d.first(), Some(&Decision::Up));
        // …which immediately misses the budget: back down, and no new try for a while.
        run(&g, &mut st, 10.0, 3.0, 33.3, None);
        assert!(st.hold_until > 12.0, "hold_until {}", st.hold_until);
    }

    #[test]
    fn ladder_targets_compose() {
        let g = QualityGovernor::default();
        let base = QualityPreset::default();
        let (p, s) = target(&g, &base, 0, 0);
        assert_eq!(p, base);
        assert_eq!(s, 1.0);
        let (p, s) = target(&g, &base, 4, 0);
        assert_eq!(s, 0.7);
        assert!(!p.ssr[3] && p.probe_refresh[3] == 8 && p.ssao[3]);
        let (p, _) = target(&g, &base, 0, 2);
        assert_eq!(p.shadow_map_size[3], 2048);
        assert_eq!(p.probe_refresh[3], 0);
        let (_, s) = target(&g, &base, g.steps.len(), 0);
        assert_eq!(s, 0.5);
    }
}
