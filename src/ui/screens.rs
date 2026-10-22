//! Screen stack + registry. Owner: ui stream.
//!
//! Built-in ids: "main" (main menu, opened on entering `AppState::MainMenu`), "settings",
//! "pause" (Esc in game). Games register more with [`RegisterScreen::register_screen`].
//! Builders run exclusively: `fn(&mut World, root: Entity)` — spawn children under `root`.
//! The stack is rebuilt (despawn + build) when it changes or `RebuildScreen` is sent.
//!
//! Behaviour:
//! - Esc / Back with an empty stack in `AppState::InGame` and `PauseAllowed(true)` pushes
//!   "pause". While "pause" is on the stack in game, the game is paused ([`PauseCtl`]); when it
//!   leaves the stack the game resumes. [`MenuEvent`] "pause" / "resume" mark both edges.
//! - Back on "pause" resumes, on "main" does nothing, on a sticky screen does nothing (the game
//!   handles [`NavBack`] itself), on anything else pops (leaving "settings" also saves).
//! - Leaving `InGame` clears the stack and unpauses; entering `MainMenu` opens "main";
//!   leaving `MainMenu` clears the stack.
//! - Losing window focus during play pauses (never in test-driven runs).
//!
//! A builder reads what it needs from the world first, then spawns through `world.commands()`;
//! the caller flushes:
//! ```ignore
//! fn build_results(world: &mut World, root: Entity) {
//!     let t = world.resource::<Theme>().clone();
//!     let score = world.resource::<Score>().0;
//!     world.commands().entity(root).with_children(|p| {
//!         menu_backdrop(p, &t, 0.6, 1.0);
//!         p.spawn(menu_column(GAP_M)).with_children(|col| {
//!             col.spawn(title("Results", SIZE_H1, t.text));
//!             col.spawn(text(format!("Score {score}"), body(SIZE_BODY), t.text_muted));
//!             nav_list(col, &t, &[("Continue", MenuAction::Custom("next").into())], 1);
//!         });
//!     });
//! }
//! ```

use bevy::prelude::*;
use bevy::ecs::system::SystemParam;
use bevy::window::WindowFocused;

use super::menus::{MenuAction, MenuEvent};
use super::settings_screen::{PendingReset, settings_tabs};
use super::theme::{Theme, fullscreen};
use super::widgets::{Focus, Focusable, NavBack, UiAction, UiActivated, wrap_tab};
use crate::flow::{AppState, PauseAllowed};
use crate::input::Bindings;
use crate::pause::{PauseCtl, Paused};
use crate::settings::{SaveSettings, SettingsRegistry};

pub type ScreenBuilder = fn(&mut World, Entity);

#[derive(Resource, Clone, Default)]
pub struct ScreenRegistry(pub Vec<(&'static str, ScreenBuilder)>);

impl ScreenRegistry {
    pub fn get(&self, id: &str) -> Option<ScreenBuilder> {
        self.0.iter().find(|(k, _)| *k == id).map(|(_, b)| *b)
    }
    /// The registered `'static` id matching `name` (for ids arriving as runtime strings).
    pub fn id(&self, name: &str) -> Option<&'static str> {
        self.0.iter().find(|(k, _)| *k == name).map(|(k, _)| *k)
    }
}

/// Open screens, top last. Empty = gameplay (HUD only).
#[derive(Resource, Clone, Debug, Default)]
pub struct Screens {
    pub stack: Vec<&'static str>,
    /// Active tab index on the top screen (settings).
    pub tab: usize,
}

impl Screens {
    pub fn top(&self) -> Option<&'static str> {
        self.stack.last().copied()
    }
}

/// Push/pop/replace requests (from buttons, Esc, games, control port).
#[derive(Message, Clone, Debug)]
pub enum ScreenRequest {
    Push(&'static str),
    Pop,
    /// Clear the stack, then push (None = clear only).
    Replace(Option<&'static str>),
    SetTab(usize),
}

/// Force a rebuild of the top screen (e.g. after data it shows changed).
#[derive(Message, Clone, Copy, Debug, Default)]
pub struct RebuildScreen;

/// Screens that ignore Back/Esc (the game reads [`NavBack`] and decides), e.g. a results
/// screen that must be confirmed.
#[derive(Resource, Clone, Debug, Default)]
pub struct StickyScreens(pub Vec<&'static str>);

pub trait RegisterScreen {
    fn register_screen(&mut self, id: &'static str, build: ScreenBuilder) -> &mut Self;
    /// Like `register_screen`, but Back/Esc doesn't close it.
    fn register_sticky_screen(&mut self, id: &'static str, build: ScreenBuilder) -> &mut Self;
}

impl RegisterScreen for App {
    fn register_screen(&mut self, id: &'static str, build: ScreenBuilder) -> &mut Self {
        let mut reg = self.world_mut().get_resource_or_insert_with(ScreenRegistry::default);
        reg.0.retain(|(k, _)| *k != id);
        reg.0.push((id, build));
        self
    }
    fn register_sticky_screen(&mut self, id: &'static str, build: ScreenBuilder) -> &mut Self {
        self.register_screen(id, build);
        let mut sticky = self.world_mut().get_resource_or_insert_with(StickyScreens::default);
        if !sticky.0.contains(&id) {
            sticky.0.push(id);
        }
        self
    }
}

/// Root of the screen currently built (despawned on rebuild).
#[derive(Component, Clone, Copy, Debug)]
pub struct ScreenRoot;

/// Bookkeeping behind the stack.
#[derive(Resource, Default, Debug)]
pub(crate) struct ScreenState {
    /// (top id, tab, depth) of what is built now.
    built: Option<(&'static str, usize, usize)>,
    /// Focus order to restore per stack level when it is on top again.
    memory: Vec<(&'static str, u32)>,
    /// Whether "pause" was on the stack in game last frame.
    had_pause: bool,
    rebuild: bool,
}

// ---- transitions (pure) ----

/// Side effects of a transition, applied by [`screen_logic`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fx {
    Goto(AppState),
    Exit,
    Save,
    Event(&'static str),
    ResetTab(usize),
}

pub(crate) struct Ctx<'a> {
    pub in_game: bool,
    pub in_menu: bool,
    pub pause_allowed: bool,
    pub ntabs: usize,
    pub known: &'a dyn Fn(&str) -> bool,
    pub sticky: &'a [&'static str],
}

fn push(s: &mut Screens, ctx: &Ctx, id: &'static str) {
    if s.top() == Some(id) {
        return;
    }
    if !(ctx.known)(id) {
        warn!("screens: no screen registered as '{id}'");
        return;
    }
    if id == "pause" && !ctx.in_game {
        warn!("screens: 'pause' needs AppState::InGame");
        return;
    }
    if id == "settings" {
        s.tab = 0;
    }
    s.stack.push(id);
}

/// Close "pause" and everything above it (or, in game without it, everything).
fn resume(s: &mut Screens, ctx: &Ctx) {
    match s.stack.iter().position(|x| *x == "pause") {
        Some(i) => s.stack.truncate(i),
        None if ctx.in_game => s.stack.clear(),
        None => {}
    }
}

pub(crate) fn on_back(s: &mut Screens, ctx: &Ctx) -> Vec<Fx> {
    match s.top() {
        None => {
            if ctx.in_game && ctx.pause_allowed {
                push(s, ctx, "pause");
            }
            vec![]
        }
        Some("main") => vec![],
        Some(id) if ctx.sticky.contains(&id) => vec![],
        Some("pause") => {
            resume(s, ctx);
            vec![]
        }
        Some(id) => {
            s.stack.pop();
            if id == "settings" { vec![Fx::Save] } else { vec![] }
        }
    }
}

pub(crate) fn on_action(s: &mut Screens, ctx: &Ctx, a: UiAction) -> Vec<Fx> {
    match a {
        UiAction::Menu(m) => match m {
            MenuAction::Play => vec![Fx::Save, Fx::Goto(AppState::InGame)],
            MenuAction::Open(id) => {
                push(s, ctx, id);
                vec![]
            }
            MenuAction::Settings => {
                push(s, ctx, "settings");
                vec![]
            }
            MenuAction::Resume => {
                resume(s, ctx);
                vec![]
            }
            MenuAction::MainMenu => {
                if ctx.in_menu {
                    s.stack = vec!["main"];
                    vec![]
                } else {
                    vec![Fx::Event("main_menu"), Fx::Goto(AppState::MainMenu)]
                }
            }
            MenuAction::Quit => vec![Fx::Save, Fx::Exit],
            MenuAction::Custom(id) => vec![Fx::Event(id)],
        },
        UiAction::Back => on_back(s, ctx),
        UiAction::Tab(_) | UiAction::NextTab | UiAction::PrevTab => {
            if s.top() == Some("settings") {
                s.tab = wrap_tab(s.tab, a, ctx.ntabs);
            }
            vec![]
        }
        UiAction::ResetTab => {
            if s.top() == Some("settings") {
                vec![Fx::ResetTab(s.tab)]
            } else {
                vec![]
            }
        }
    }
}

pub(crate) fn on_request(s: &mut Screens, ctx: &Ctx, r: &ScreenRequest) -> Vec<Fx> {
    match r {
        ScreenRequest::Push(id) => push(s, ctx, id),
        ScreenRequest::Pop => {
            if s.top() == Some("pause") {
                resume(s, ctx);
            } else if s.top() == Some("settings") {
                s.stack.pop();
                return vec![Fx::Save];
            } else {
                s.stack.pop();
            }
        }
        ScreenRequest::Replace(id) => {
            s.stack.clear();
            if let Some(id) = id {
                push(s, ctx, id);
            }
        }
        ScreenRequest::SetTab(i) => s.tab = (*i).min(ctx.ntabs.saturating_sub(1)),
    }
    vec![]
}

// ---- plugin ----

pub struct ScreensPlugin;

impl Plugin for ScreensPlugin {
    fn build(&self, app: &mut App) {
        use super::UiSet;
        app.init_resource::<Screens>()
            .init_resource::<ScreenRegistry>()
            .init_resource::<StickyScreens>()
            .init_resource::<ScreenState>()
            .init_resource::<super::menus::MenuConfig>()
            .init_resource::<Paused>()
            .init_resource::<PauseAllowed>()
            .init_resource::<SettingsRegistry>()
            .add_message::<ScreenRequest>()
            .add_message::<RebuildScreen>()
            .add_message::<MenuEvent>()
            .add_message::<SaveSettings>()
            .add_systems(OnEnter(AppState::MainMenu), open_main_menu)
            .add_systems(OnExit(AppState::MainMenu), clear_screens)
            .add_systems(OnExit(AppState::InGame), clear_screens)
            .add_systems(
                Update,
                (
                    pause_on_focus_loss.run_if(resource_exists::<Messages<WindowFocused>>),
                    screen_logic,
                    note_rebuilds,
                    super::settings_screen::reset_tab,
                    rebuild.run_if(super::ui_visible),
                )
                    .chain()
                    .in_set(UiSet::Screens),
            );
    }
}

fn open_main_menu(mut screens: ResMut<Screens>, mut st: ResMut<ScreenState>, mut pause: PauseCtl) {
    screens.stack = vec!["main"];
    screens.tab = 0;
    st.memory.clear();
    st.had_pause = false;
    pause.set(false);
}

fn clear_screens(mut screens: ResMut<Screens>, mut st: ResMut<ScreenState>, mut pause: PauseCtl) {
    screens.stack.clear();
    st.memory.clear();
    st.had_pause = false;
    pause.set(false);
}

/// Apply requests, Esc and button actions to the stack, then keep pause in sync with it.
/// Clicking away from the game (alt-tab) pauses a live round. Never in test-driven runs.
fn pause_on_focus_loss(
    mut events: MessageReader<WindowFocused>,
    state: Option<Res<State<AppState>>>,
    allowed: Res<PauseAllowed>,
    screens: Res<Screens>,
    mut out: MessageWriter<ScreenRequest>,
) {
    let lost = events.read().any(|e| !e.focused);
    let in_game = state.is_some_and(|s| *s.get() == AppState::InGame);
    if lost && in_game && allowed.0 && screens.stack.is_empty() && !crate::cli::test_driven() {
        out.write(ScreenRequest::Push("pause"));
    }
}

/// Read-only inputs of [`screen_logic`].
#[derive(SystemParam)]
struct LogicIn<'w, 's> {
    registry: Res<'w, ScreenRegistry>,
    sticky: Res<'w, StickyScreens>,
    settings_reg: Res<'w, SettingsRegistry>,
    bindings: Option<Res<'w, Bindings>>,
    state: Option<Res<'w, State<AppState>>>,
    allowed: Res<'w, PauseAllowed>,
    focus: Res<'w, Focus>,
    focusables: Query<'w, 's, &'static Focusable>,
}

/// Outputs of [`screen_logic`].
#[derive(SystemParam)]
struct LogicOut<'w> {
    next: Option<ResMut<'w, NextState<AppState>>>,
    pending_reset: ResMut<'w, PendingReset>,
    events: MessageWriter<'w, MenuEvent>,
    save: MessageWriter<'w, SaveSettings>,
    exit: MessageWriter<'w, AppExit>,
}

fn screen_logic(
    mut requests: MessageReader<ScreenRequest>,
    mut backs: MessageReader<NavBack>,
    mut actions: MessageReader<UiActivated>,
    mut screens: ResMut<Screens>,
    mut st: ResMut<ScreenState>,
    input: LogicIn,
    mut out: LogicOut,
    mut pause: PauseCtl,
) {
    let LogicIn { registry, sticky, settings_reg, bindings, state, allowed, focus, focusables } = input;
    let cur = state.as_ref().map(|s| *s.get());
    let known = |id: &str| registry.get(id).is_some();
    let ctx = Ctx {
        in_game: cur == Some(AppState::InGame),
        in_menu: cur == Some(AppState::MainMenu),
        pause_allowed: allowed.0,
        ntabs: settings_tabs(Some(&settings_reg), bindings.as_deref()).len(),
        known: &known,
        sticky: &sticky.0,
    };
    let before = screens.stack.clone();
    let mut fx = Vec::new();
    for r in requests.read() {
        fx.extend(on_request(&mut screens, &ctx, r));
    }
    for _ in backs.read() {
        fx.extend(on_back(&mut screens, &ctx));
    }
    for UiActivated(a) in actions.read().copied() {
        fx.extend(on_action(&mut screens, &ctx, a));
    }

    // Remember where focus was on the screen we just covered.
    if screens.stack.len() > before.len() && !before.is_empty() && screens.stack.starts_with(&before) {
        let order = focus.0.and_then(|e| focusables.get(e).ok()).map_or(0, |f| f.order);
        let depth = before.len() - 1;
        st.memory.resize(depth, ("", 0));
        st.memory.push((before[depth], order));
    }

    for f in fx {
        match f {
            Fx::Goto(s) => {
                if let Some(n) = out.next.as_mut() {
                    n.set(s);
                }
            }
            Fx::Exit => {
                out.exit.write(AppExit::Success);
            }
            Fx::Save => {
                out.save.write(SaveSettings);
            }
            Fx::Event(id) => {
                out.events.write(MenuEvent(id));
            }
            Fx::ResetTab(i) => out.pending_reset.0 = Some(i),
        }
    }

    let want_pause = ctx.in_game && screens.stack.contains(&"pause");
    if want_pause != st.had_pause {
        st.had_pause = want_pause;
        pause.set(want_pause);
        out.events.write(MenuEvent(if want_pause { "pause" } else { "resume" }));
    }
}

fn note_rebuilds(mut requests: MessageReader<RebuildScreen>, theme: Res<Theme>, mut st: ResMut<ScreenState>) {
    if requests.read().count() > 0 || (theme.is_changed() && !theme.is_added()) {
        st.rebuild = true;
    }
}

/// Spawn the top screen when it (or the settings tab) changed, or a rebuild was requested.
fn rebuild(world: &mut World) {
    let want = {
        let s = world.resource::<Screens>();
        s.top().map(|id| (id, s.tab, s.stack.len()))
    };
    let (built, force) = {
        let st = world.resource::<ScreenState>();
        (st.built, st.rebuild)
    };
    if want == built && !force {
        return;
    }
    // A forced rebuild of the same screen keeps the focused item.
    let keep = if want == built { focused_order(world) } else { None };

    let roots: Vec<Entity> = world.query_filtered::<Entity, With<ScreenRoot>>().iter(world).collect();
    for e in roots {
        world.despawn(e);
    }
    world.resource_mut::<Focus>().0 = None;
    {
        let mut st = world.resource_mut::<ScreenState>();
        st.built = want;
        st.rebuild = false;
    }
    let Some((id, _, depth)) = want else { return };
    let Some(build) = world.resource::<ScreenRegistry>().get(id) else {
        warn!("screens: no screen registered as '{id}'");
        return;
    };
    let root = world
        .spawn((ScreenRoot, Name::new(format!("Screen {id}")), fullscreen(), GlobalZIndex(20), Pickable::IGNORE))
        .id();
    build(world, root);
    world.flush();

    let restore = keep.or_else(|| {
        let mut st = world.resource_mut::<ScreenState>();
        st.memory.truncate(depth);
        match st.memory.get_mut(depth - 1) {
            Some((mid, order)) if *mid == id && *order > 0 => Some(std::mem::take(order)),
            _ => None,
        }
    });
    if let Some(order) = restore {
        let target = world.query::<(Entity, &Focusable)>().iter(world).find(|(_, f)| f.order == order).map(|(e, _)| e);
        if target.is_some() {
            world.resource_mut::<Focus>().0 = target;
        }
    }
}

fn focused_order(world: &mut World) -> Option<u32> {
    let e = world.resource::<Focus>().0?;
    world.get::<Focusable>(e).map(|f| f.order)
}

/// Control port helper: open a screen by name (`None` closes all but "main"), optionally on a
/// settings tab. Goes through the same request path as buttons.
pub fn open_screen(world: &mut World, name: Option<&str>, tab: Option<usize>) -> Result<(), String> {
    let req = match name {
        None => {
            let in_menu = world.get_resource::<State<AppState>>().is_some_and(|s| *s.get() == AppState::MainMenu);
            ScreenRequest::Replace(in_menu.then_some("main"))
        }
        Some(n) => {
            let id = world.resource::<ScreenRegistry>().id(n).ok_or_else(|| format!("no screen '{n}'"))?;
            if id == "pause" && !world.get_resource::<State<AppState>>().is_some_and(|s| *s.get() == AppState::InGame) {
                return Err("pause needs AppState::InGame".into());
            }
            ScreenRequest::Push(id)
        }
    };
    world.write_message(req);
    if let Some(t) = tab {
        world.write_message(ScreenRequest::SetTab(t));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(in_game: bool, known: &'a dyn Fn(&str) -> bool, sticky: &'a [&'static str]) -> Ctx<'a> {
        Ctx { in_game, in_menu: !in_game, pause_allowed: true, ntabs: 3, known, sticky }
    }

    #[test]
    fn back_rules() {
        let known = |_: &str| true;
        let game = ctx(true, &known, &["results"]);
        let mut s = Screens::default();
        on_back(&mut s, &game);
        assert_eq!(s.stack, ["pause"], "Esc in play pauses");
        on_action(&mut s, &game, MenuAction::Settings.into());
        assert_eq!(s.stack, ["pause", "settings"]);
        assert_eq!(on_back(&mut s, &game), vec![Fx::Save], "leaving settings saves");
        on_back(&mut s, &game);
        assert!(s.stack.is_empty(), "Esc on pause resumes");

        let mut s = Screens { stack: vec!["results"], tab: 0 };
        on_back(&mut s, &game);
        assert_eq!(s.stack, ["results"], "sticky screens ignore Back");

        let no_pause = Ctx { pause_allowed: false, ..ctx(true, &known, &[]) };
        let mut s = Screens::default();
        on_back(&mut s, &no_pause);
        assert!(s.stack.is_empty());

        let menu = ctx(false, &known, &[]);
        let mut s = Screens { stack: vec!["main"], tab: 0 };
        on_back(&mut s, &menu);
        assert_eq!(s.stack, ["main"], "Back on main does nothing");
        on_request(&mut s, &menu, &ScreenRequest::Push("pause"));
        assert_eq!(s.stack, ["main"], "no pause outside the game");
    }

    #[test]
    fn actions_and_tabs() {
        let known = |id: &str| id != "nope";
        let menu = ctx(false, &known, &[]);
        let mut s = Screens { stack: vec!["main"], tab: 2 };
        on_action(&mut s, &menu, MenuAction::Open("nope").into());
        assert_eq!(s.stack, ["main"], "unknown screens are ignored");
        on_action(&mut s, &menu, MenuAction::Settings.into());
        assert_eq!(s.tab, 0, "settings opens on the first tab");
        on_action(&mut s, &menu, UiAction::PrevTab);
        assert_eq!(s.tab, 2);
        on_action(&mut s, &menu, UiAction::NextTab);
        assert_eq!(s.tab, 0);
        assert_eq!(on_action(&mut s, &menu, UiAction::ResetTab), vec![Fx::ResetTab(0)]);
        assert_eq!(on_action(&mut s, &menu, MenuAction::Play.into()), vec![Fx::Save, Fx::Goto(AppState::InGame)]);
        assert_eq!(on_action(&mut s, &menu, MenuAction::Custom("x").into()), vec![Fx::Event("x")]);
        on_action(&mut s, &menu, MenuAction::MainMenu.into());
        assert_eq!(s.stack, ["main"]);
        let game = ctx(true, &known, &[]);
        assert_eq!(on_action(&mut s, &game, MenuAction::MainMenu.into()), vec![Fx::Event("main_menu"), Fx::Goto(AppState::MainMenu)]);
    }
}
