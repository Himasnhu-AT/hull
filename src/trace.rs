//! Crash, hang and performance reporting through `ashlar-trace` (feature `trace`).
//!
//! - The tracer is built from `<ID>_TRACE_ENDPOINT` and `<ID>_TRACE_KEY` (`<ID>` = `GameInfo.id`
//!   uppercased, `-` → `_`); without both it is a no-op tracer (never fails, never blocks).
//! - Hang detection: a turn runs from `First` to `Last`, armed only after the first
//!   `AppState::InGame` frame (so shader compiles and asset loads at startup are not hangs).
//! - `frame()` every frame (real time), gauges every second, `perf.hitch` for slow frames.
//! - The tracer (and its panic hook) starts in `TracePlugin::finish`, after every plugin's
//!   `build`, so it wraps Bevy's panic hook: ours reports first, then chains to Bevy's.
//! - Envelope: app name = `GameInfo.id`, version = `GameInfo.version`, build =
//!   `GameInfo.build` (packaged builds only), process = GUI.
//! - Nothing is sent until the player has seen the privacy notice (`notice_shown`). By default
//!   the engine counts the main menu as that; a game that shows its own notice inserts
//!   [`GameShowsTraceNotice`] and calls `notice_shown` itself when the player closes it.
//! - `<ID>_TRACE_INSPECT=1`: also write everything accepted for sending to
//!   `<data>/trace/tracer/outbox.jsonl` (to check what leaves the machine).
//! - On `AppExit` the session is ended and sent with at most [`SHUTDOWN_WAIT`] of waiting.
//! - [`trace_handled`] reports an error the game caught and survived.
//! - [`TraceQuiet`]: present while the game does expected long work (loading): no hang
//!   watchdog turns and no `perf.hitch`.
//! - `DO_NOT_TRACK` / `TRACER_DISABLED` (non-empty, not `0`/`false`) turn the SDK off.
//! - `--crash-test` panics on purpose 2 s after start.
//!
//! Games report events with [`trace_event`]; names declared with
//! [`TraceAppExt::declare_trace_events`] carry their props, others are sent as bare ids.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

pub use ashlar_trace::Prop;
use ashlar_trace::{Event, Gauge, Tracer};
use bevy::prelude::*;

use crate::app::GameInfo;
use crate::cli::dev_flag;
use crate::flow::{AppState, Headless};
use crate::paths::DataDir;

ashlar_trace::events! {
    pub enum TraceCategory { Game = "game", Perf = "perf" }
    pub enum EngineEvent {
        Hitch = "perf.hitch" in Perf,
    }
}

/// A game event by name, filed under [`TraceCategory::Game`].
#[derive(Clone, Copy, Debug)]
struct Named(&'static str);

impl Event for Named {
    type Category = TraceCategory;
    const ALL: &'static [Self] = &[];

    fn name(self) -> &'static str {
        self.0
    }

    fn category(self) -> TraceCategory {
        TraceCategory::Game
    }
}

/// A frame longer than this (after the first in-game frame) is reported as `perf.hitch`.
const HITCH: Duration = Duration::from_millis(250);

/// Longest the app waits at exit for the last send.
pub const SHUTDOWN_WAIT: Duration = Duration::from_millis(1500);

/// While this resource exists (a loading screen, a level build), long frames are expected: the
/// engine opens no hang-watchdog turns and reports no `perf.hitch`. Insert it before the long
/// work and remove it after.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct TraceQuiet;

/// Inserted by a game that shows its own privacy notice: the engine then doesn't count the
/// main menu as the notice, and the game calls `GameTracer.0.notice_shown()` itself.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct GameShowsTraceNotice;

/// Reports an error the game caught and survived (`context`: a fixed label such as
/// `"ghost.save"`, never user text).
pub fn trace_handled(src: &(impl TraceSource + ?Sized), error: &dyn std::fmt::Display, context: &'static str) {
    if let Some(t) = src.game_tracer() {
        t.0.report_handled(error, Some(context));
    }
}

/// The app's tracer. Cheap to clone; every call is a no-op when tracing is off.
#[derive(Resource, Clone)]
pub struct GameTracer(pub Tracer, Arc<HashSet<&'static str>>);

impl GameTracer {
    pub fn disabled() -> Self {
        GameTracer(Tracer::disabled(), Arc::default())
    }
}

/// Anything [`trace_event`] can find the tracer through.
pub trait TraceSource {
    fn game_tracer(&self) -> Option<&GameTracer>;
}

impl TraceSource for World {
    fn game_tracer(&self) -> Option<&GameTracer> {
        self.get_resource::<GameTracer>()
    }
}

impl TraceSource for GameTracer {
    fn game_tracer(&self) -> Option<&GameTracer> {
        Some(self)
    }
}

impl TraceSource for Res<'_, GameTracer> {
    fn game_tracer(&self) -> Option<&GameTracer> {
        Some(&**self)
    }
}

/// Records a game event: `trace_event(world, "match.start", &[("round", Prop::Int(3))])` with a
/// `&World`, `&Res<GameTracer>` or `&GameTracer`. Names are lower-case, dotted
/// (`area.what`), at most 64 bytes. Props are only sent for names declared with
/// [`TraceAppExt::declare_trace_events`]; undeclared names are sent without them.
pub fn trace_event(src: &(impl TraceSource + ?Sized), name: &'static str, props: &[(&'static str, Prop)]) {
    let Some(t) = src.game_tracer() else { return };
    if t.1.contains(name) {
        t.0.track_with(Named(name), props);
    } else {
        t.0.track_id(TraceCategory::Game, name);
    }
}

/// Event names games declare (sent as the tracer's catalog).
#[derive(Resource, Default, Clone)]
pub struct TraceCatalog(pub Vec<&'static str>);

pub trait TraceAppExt {
    /// Declares game event names (in a plugin's `build`, before the tracer starts).
    fn declare_trace_events(&mut self, names: &[&'static str]) -> &mut Self;
}

impl TraceAppExt for App {
    fn declare_trace_events(&mut self, names: &[&'static str]) -> &mut Self {
        let mut c = self.world_mut().get_resource_or_init::<TraceCatalog>();
        for n in names {
            if !c.0.contains(n) {
                c.0.push(n);
            }
        }
        self
    }
}

#[derive(Resource, Default)]
struct TraceState {
    /// Hang detection runs (set after the first in-game frame).
    armed: bool,
    in_turn: bool,
    started: bool,
    next_gauges: Duration,
    gauges: Option<Gauges>,
}

struct Gauges {
    entities: Gauge,
    fps: Gauge,
}

#[derive(Resource)]
struct CrashTest;

/// Add after `DefaultPlugins` (core's `EnginePlugin` does).
pub struct TracePlugin;

impl Plugin for TracePlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(GameTracer::disabled())
            .init_resource::<TraceCatalog>()
            .init_resource::<TraceState>()
            .add_systems(First, begin_turn)
            .add_systems(Last, end_frame)
            .add_systems(OnEnter(AppState::MainMenu), notice_shown.run_if(visuals).run_if(not(resource_exists::<GameShowsTraceNotice>)))
            .add_systems(Last, shutdown_on_exit);
        if dev_flag("crash-test") {
            app.insert_resource(CrashTest)
                .add_systems(Update, crash_test.run_if(resource_exists::<CrashTest>));
        }
    }

    fn finish(&self, app: &mut App) {
        let world = app.world();
        let (id, version, build) = world
            .get_resource::<GameInfo>()
            .map_or(("game", env!("CARGO_PKG_VERSION"), None), |g| (g.id, g.version, g.build));
        let dir = world
            .get_resource::<DataDir>()
            .map(|d| d.0.join("trace"))
            .unwrap_or_else(|| std::env::temp_dir().join(format!("{id}-trace")));
        let names = world.get_resource::<TraceCatalog>().cloned().unwrap_or_default().0;
        let tracer = make_tracer(id, version, build, dir, &names);
        let gauges = tracer.is_enabled().then(|| Gauges { entities: tracer.gauge("entities"), fps: tracer.gauge("fps") });
        app.insert_resource(GameTracer(tracer, Arc::new(names.into_iter().collect())));
        app.world_mut().resource_mut::<TraceState>().gauges = gauges;
    }
}

fn visuals(h: Option<Res<Headless>>) -> bool {
    h.is_none_or(|h| !h.0)
}

fn env_prefix(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
        .collect()
}

fn make_tracer(id: &'static str, version: &'static str, build: Option<&'static str>, dir: std::path::PathBuf, names: &[&'static str]) -> Tracer {
    let prefix = env_prefix(id);
    let var = |k: &str| std::env::var(format!("{prefix}_{k}")).ok().filter(|v| !v.trim().is_empty());
    match (var("TRACE_ENDPOINT"), var("TRACE_KEY")) {
        (Some(endpoint), Some(key)) => {
            let names = names.to_vec();
            let inspect = var("TRACE_INSPECT").is_some_and(|v| v != "0" && !v.eq_ignore_ascii_case("false"));
            let mut b = Tracer::builder(&key, id, version);
            if let Some(build) = build {
                b = b.build(build);
            }
            b.data_dir(dir)
                .endpoint(endpoint)
                .process(ashlar_trace::ProcessKind::Gui)
                .inspect(inspect)
                .listen(TraceCategory::Game)
                .listen(TraceCategory::Perf)
                .configure(move |c| {
                    for n in names {
                        if !c.catalog.events.iter().any(|e| e.name == n) {
                            c.catalog.events.push(ashlar_trace::proto::CatalogEvent {
                                name: n.to_string(),
                                category: "game".to_string(),
                            });
                        }
                    }
                })
                .init()
        }
        _ => Tracer::disabled(),
    }
}

fn begin_turn(tracer: Res<GameTracer>, quiet: Option<Res<TraceQuiet>>, mut st: ResMut<TraceState>) {
    if st.armed && !st.in_turn && quiet.is_none() {
        tracer.0.begin_turn();
        st.in_turn = true;
    }
}

fn end_frame(world: &mut World) {
    let tracer = world.resource::<GameTracer>().0.clone();
    if !tracer.is_enabled() {
        return;
    }
    let real = *world.resource::<Time<Real>>();
    let in_game = world
        .get_resource::<State<AppState>>()
        .is_some_and(|s| *s.get() == AppState::InGame);
    let entities = world.entities().count_spawned();
    let quiet = world.contains_resource::<TraceQuiet>();
    let mut st = world.resource_mut::<TraceState>();

    let dt = real.delta();
    tracer.frame(dt);
    if !st.started {
        tracer.first_frame();
        st.started = true;
    }
    if st.in_turn {
        tracer.end_turn();
        st.in_turn = false;
        if dt > HITCH && !quiet {
            tracer.track_with(EngineEvent::Hitch, &[("ms", Prop::Int(dt.as_millis() as i64))]);
        }
    }
    if !st.armed && in_game {
        st.armed = true;
    }
    if real.elapsed() >= st.next_gauges {
        st.next_gauges = real.elapsed() + Duration::from_secs(1);
        if let Some(g) = &st.gauges {
            g.entities.set(entities as f64);
            if dt > Duration::ZERO {
                g.fps.set(1.0 / dt.as_secs_f64());
            }
        }
    }
}

fn notice_shown(tracer: Res<GameTracer>) {
    tracer.0.notice_shown();
}

/// Ends the session and sends what's waiting, without holding the exit up for long.
fn shutdown_on_exit(mut exits: MessageReader<AppExit>, tracer: Res<GameTracer>) {
    if exits.read().next().is_some() && tracer.0.is_enabled() {
        tracer.0.shutdown_within(SHUTDOWN_WAIT);
    }
}

fn crash_test(time: Res<Time<Real>>) {
    if time.elapsed() > Duration::from_secs(2) {
        panic!("--crash-test: deliberate panic to test crash reporting");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_tracer_accepts_events() {
        let t = GameTracer::disabled();
        trace_event(&t, "match.start", &[("round", Prop::Int(1))]);
        let mut w = World::new();
        trace_event(&w, "nothing.here", &[]);
        w.insert_resource(t);
        trace_event(&w, "match.end", &[]);
    }

    #[test]
    fn env_names_follow_the_game_id() {
        assert_eq!(env_prefix("shroud"), "SHROUD");
        assert_eq!(env_prefix("my-game"), "MY_GAME");
    }
}
