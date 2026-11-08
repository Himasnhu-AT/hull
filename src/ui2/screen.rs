//! Declarative screens: `assets/ui/<name>.ui.ron` is a [`Screen`] (backdrop + a tree of
//! [`El`](super::components::El)). [`Ui2Screens`] is the stack (`open` pushes with a page slide,
//! `Back` pops, a screen whose root is a `Modal` overlays the one below). Files and tokens hot
//! reload; every problem is a located [`Ui2Diag`](super::Ui2Diag).
//!
//! RON conveniences are on: `Column(gap: 8, children: [...])` (no double parentheses) and
//! `badge: "n.key"` (no `Some`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::SystemTime;

use bevy::prelude::*;
use bevy::ui::UiTransform;
use ron::extensions::Extensions;
use serde::{Deserialize, Serialize};

use super::anim::{PageAnim, PageDir, Veil};
use super::backdrop::{self, Backdrop};
use super::components::{Build, Cx, El};
use super::focus::{Focusable2, Ui2Focus};
use super::tokens::Tokens;
use super::{Cmd, Ui2Cmds, Ui2Diagnostics, Ui2Rev, Ui2Set, UiData};
use crate::paths::AssetsDir;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum Transition {
    #[default]
    Slide,
    Fade,
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Screen {
    pub backdrop: Backdrop,
    pub transition: Transition,
    /// Padding of the content; `None` = the `space.edge` token.
    pub pad: Option<f32>,
    pub gap: f32,
    pub root: El,
}

impl Default for Screen {
    fn default() -> Self {
        Screen { backdrop: Backdrop::default(), transition: Transition::Slide, pad: None, gap: 28.0, root: El::Spacer(0.0) }
    }
}

pub fn ron_options() -> ron::Options {
    ron::Options::default().with_default_extension(Extensions::UNWRAP_VARIANT_NEWTYPES | Extensions::IMPLICIT_SOME)
}

impl Screen {
    pub fn from_ron(text: &str) -> Result<Self, (u32, u32, String)> {
        ron_options().from_str(text).map_err(|e| (e.span.start.line as u32, e.span.start.col as u32, e.code.to_string()))
    }
}

#[derive(Component, Clone, Debug)]
pub struct ScreenRoot {
    pub name: String,
}

pub struct Inst {
    pub name: String,
    pub root: Entity,
    pub file: Option<PathBuf>,
    pub modified: Option<SystemTime>,
    pub screen: Screen,
    /// Focus id to restore when this screen is rebuilt.
    pub focus_id: Option<String>,
}

#[derive(Resource, Default)]
pub struct Ui2Screens {
    pub stack: Vec<Inst>,
    poll: f32,
    tokens_mtime: Option<SystemTime>,
}

impl Ui2Screens {
    pub fn top(&self) -> Option<&str> {
        self.stack.last().map(|s| s.name.as_str())
    }
    pub fn names(&self) -> Vec<String> {
        self.stack.iter().map(|s| s.name.clone()).collect()
    }
}

pub struct ScreenPlugin;

impl Plugin for ScreenPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(super::components::ComponentsPlugin)
            .add_systems(Update, (watch_files, run_cmds).chain().in_set(Ui2Set::Screens));
    }
}

fn dir(w: &World) -> PathBuf {
    w.get_resource::<AssetsDir>().map(|a| a.0.clone()).unwrap_or_else(|| PathBuf::from("assets")).join("ui")
}

fn mtime(p: &PathBuf) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Read and parse `ui/<name>.ui.ron`; problems go to the diagnostics.
fn load(w: &mut World, name: &str) -> Option<(Screen, PathBuf)> {
    let path = dir(w).join(format!("{name}.ui.ron"));
    let file = format!("ui/{name}.ui.ron");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            w.resource_mut::<Ui2Diagnostics>().report(&file, 0, 0, format!("can't read screen `{name}`: {e}"));
            return None;
        }
    };
    match Screen::from_ron(&text) {
        Ok(s) => {
            w.resource_mut::<Ui2Diagnostics>().clear_file(&file);
            Some((s, path))
        }
        Err((l, c, m)) => {
            let mut d = w.resource_mut::<Ui2Diagnostics>();
            d.clear_file(&file);
            d.report(&file, l, c, m);
            None
        }
    }
}

fn is_modal(s: &Screen) -> bool {
    matches!(s.root, El::Modal(_))
}

/// Build a screen's entities under a new root. Returns the root.
pub fn build(w: &mut World, name: &str, screen: &Screen, file: &str, animate: bool, slide: f32) -> Entity {
    let tokens = w.resource::<Tokens>().clone();
    let root = w
        .spawn((
            Name::new(format!("Screen {name}")),
            Node { position_type: PositionType::Absolute, left: px(0), right: px(0), top: px(0), bottom: px(0), ..default() },
            UiTransform::default(),
            ScreenRoot { name: name.to_string() },
            GlobalZIndex(10),
        ))
        .id();
    let modal = is_modal(screen);
    if !modal {
        backdrop::spawn(w, root, &tokens, &screen.backdrop);
    }
    let mut cx = Cx::new(&tokens);
    cx.animate = animate;
    if modal {
        screen.root.spawn(w, root, &mut cx);
    } else {
        let pad = screen.pad.unwrap_or(tokens.space.edge);
        let content = w
            .spawn((
                Name::new("Content"),
                Node { flex_direction: FlexDirection::Column, row_gap: px(screen.gap), padding: UiRect::axes(px(pad), px(pad * 0.6)), width: percent(100), height: percent(100), ..default() },
                Pickable::IGNORE,
                ChildOf(root),
            ))
            .id();
        screen.root.spawn(w, content, &mut cx);
    }
    if animate && screen.transition != Transition::None {
        let veil = tokens.colors.bg.color();
        w.spawn((
            Name::new("PageVeil"),
            Veil,
            Node { position_type: PositionType::Absolute, left: px(0), right: px(0), top: px(0), bottom: px(0), ..default() },
            BackgroundColor(veil.with_alpha(if modal { 0.0 } else { 1.0 })),
            GlobalZIndex(1000),
            Pickable::IGNORE,
            ChildOf(root),
        ));
        if !modal {
            let slide = if screen.transition == Transition::Slide { slide } else { 0.0 };
            w.entity_mut(root).insert(PageAnim { t: 0.0, dur: tokens.motion.page, dir: PageDir::In, slide });
        }
    }
    for (path, msg) in cx.errors {
        w.resource_mut::<Ui2Diagnostics>().report(file, 0, 0, format!("{path}: {msg}"));
    }
    root
}

fn current_focus_id(w: &World) -> Option<String> {
    let e = w.resource::<Ui2Focus>().0?;
    w.get::<Focusable2>(e).map(|f| f.id.clone())
}

fn restore_focus(w: &mut World, root: Entity, id: &str) {
    let mut q = w.query::<(Entity, &Focusable2)>();
    let found: Vec<Entity> = q.iter(w).filter(|(_, f)| f.id == id).map(|(e, _)| e).collect();
    let mut kids = vec![];
    collect(w, root, &mut kids);
    if let Some(e) = found.into_iter().find(|e| kids.contains(e)) {
        w.resource_mut::<Ui2Focus>().0 = Some(e);
    }
}

fn collect(w: &World, e: Entity, out: &mut Vec<Entity>) {
    out.push(e);
    if let Some(c) = w.get::<Children>(e) {
        for k in c.iter() {
            collect(w, k, out);
        }
    }
}

fn retire(w: &mut World, root: Entity, slide_out: bool) {
    // Slide the old page away, then it despawns; without a transition just remove it.
    if slide_out && w.get_entity(root).is_ok() {
        let dur = w.resource::<Tokens>().motion.page * 0.8;
        w.entity_mut(root).insert(PageAnim { t: 0.0, dur, dir: PageDir::Out, slide: 8.0 });
        // The old page must not take input while it leaves.
        if let Some(mut n) = w.get_mut::<Node>(root) {
            n.display = Display::Flex;
        }
        let mut kids = vec![];
        collect(w, root, &mut kids);
        for k in kids {
            w.entity_mut(k).remove::<Focusable2>();
        }
    } else if w.get_entity(root).is_ok() {
        w.entity_mut(root).despawn();
    }
}

fn push(w: &mut World, name: &str, screen: Screen, file: Option<PathBuf>) {
    let modal = is_modal(&screen);
    let fid = current_focus_id(w);
    let fname = file.as_ref().map_or(String::new(), |_| format!("ui/{name}.ui.ron"));
    if !modal && let Some(prev) = w.resource_mut::<Ui2Screens>().stack.last_mut() {
        prev.focus_id = fid.clone();
        let root = prev.root;
        retire(w, root, true);
    } else if let Some(prev) = w.resource_mut::<Ui2Screens>().stack.last_mut() {
        prev.focus_id = fid;
    }
    let root = build(w, name, &screen, &fname, true, 6.0);
    // Modals are not "pages": the page below stays. Non-modals replace it.
    let modified = file.as_ref().and_then(mtime);
    w.resource_mut::<Ui2Screens>().stack.push(Inst { name: name.to_string(), root, file, modified, screen, focus_id: None });
    w.resource_mut::<Ui2Focus>().0 = None;
}

fn pop(w: &mut World) {
    let n = w.resource::<Ui2Screens>().stack.len();
    if n == 0 {
        return;
    }
    let top_modal = is_modal(&w.resource::<Ui2Screens>().stack[n - 1].screen);
    // The first page stays: Back there is the game's business (it receives UiEvent::Back).
    if n == 1 && !top_modal {
        return;
    }
    let top = w.resource_mut::<Ui2Screens>().stack.pop().unwrap();
    retire(w, top.root, !top_modal);
    if top_modal {
        if let Some(prev) = w.resource::<Ui2Screens>().stack.last()
            && let Some(id) = prev.focus_id.clone()
        {
            let root = prev.root;
            restore_focus(w, root, &id);
        }
        return;
    }
    // Rebuild the page below (it was retired when this one opened).
    let i = n - 2;
    let (name, screen, file, fid) = {
        let p = &w.resource::<Ui2Screens>().stack[i];
        (p.name.clone(), p.screen.clone(), p.file.clone(), p.focus_id.clone())
    };
    let fname = file.as_ref().map_or(String::new(), |_| format!("ui/{name}.ui.ron"));
    let root = build(w, &name, &screen, &fname, true, -6.0);
    w.resource_mut::<Ui2Screens>().stack[i].root = root;
    w.resource_mut::<Ui2Focus>().0 = None;
    if let Some(id) = fid {
        // Entities exist now, layout does not need to.
        restore_focus(w, root, &id);
    }
}

/// Rebuild every open screen in place (tokens or a file changed). No entrance animation.
fn rebuild_all(w: &mut World) {
    let n = w.resource::<Ui2Screens>().stack.len();
    let fid = current_focus_id(w);
    for i in 0..n {
        let (name, screen, file, old) = {
            let s = &w.resource::<Ui2Screens>().stack[i];
            (s.name.clone(), s.screen.clone(), s.file.clone(), s.root)
        };
        if w.get_entity(old).is_ok() {
            w.entity_mut(old).despawn();
        }
        let fname = file.as_ref().map_or(String::new(), |_| format!("ui/{name}.ui.ron"));
        let root = build(w, &name, &screen, &fname, false, 0.0);
        w.resource_mut::<Ui2Screens>().stack[i].root = root;
    }
    w.resource_mut::<Ui2Focus>().0 = None;
    if let (Some(id), Some(top)) = (fid, w.resource::<Ui2Screens>().stack.last().map(|s| s.root)) {
        restore_focus(w, top, &id);
    }
}

/// Poll `ui/tokens.ron` and the open screens' files twice a second.
fn watch_files(world: &mut World) {
    let dt = world.resource::<Time<Real>>().delta_secs();
    {
        let mut s = world.resource_mut::<Ui2Screens>();
        s.poll -= dt;
        if s.poll > 0.0 {
            return;
        }
        s.poll = 0.5;
    }
    let mut rebuild = false;
    // Tokens.
    let tpath = dir(world).join("tokens.ron");
    let tm = mtime(&tpath);
    if tm != world.resource::<Ui2Screens>().tokens_mtime {
        world.resource_mut::<Ui2Screens>().tokens_mtime = tm;
        if tm.is_some() {
            match std::fs::read_to_string(&tpath).map_err(|e| (0, 0, e.to_string())).and_then(|t| Tokens::from_ron(&t)) {
                Ok(t) => {
                    world.resource_mut::<Ui2Diagnostics>().clear_file("ui/tokens.ron");
                    if *world.resource::<Tokens>() != t {
                        world.insert_resource(t);
                        rebuild = true;
                    }
                }
                Err((l, c, m)) => world.resource_mut::<Ui2Diagnostics>().report("ui/tokens.ron", l, c, m),
            }
        }
    }
    // Screens.
    let files: Vec<(usize, PathBuf, Option<SystemTime>, String)> =
        world.resource::<Ui2Screens>().stack.iter().enumerate().filter_map(|(i, s)| Some((i, s.file.clone()?, s.modified, s.name.clone()))).collect();
    let mut reloaded: HashMap<usize, (Screen, Option<SystemTime>)> = HashMap::new();
    for (i, path, old, name) in files {
        let now = mtime(&path);
        if now != old {
            if let Some((s, _)) = load(world, &name) {
                reloaded.insert(i, (s, now));
            } else if let Some(inst) = world.resource_mut::<Ui2Screens>().stack.get_mut(i) {
                inst.modified = now; // do not re-report the same broken file every poll
            }
        }
    }
    if !reloaded.is_empty() {
        let mut s = world.resource_mut::<Ui2Screens>();
        for (i, (screen, now)) in reloaded {
            s.stack[i].screen = screen;
            s.stack[i].modified = now;
        }
        rebuild = true;
    }
    if rebuild {
        world.resource_mut::<Ui2Rev>().0 += 1;
    }
}

/// Apply queued commands, and rebuild when the revision moved.
pub fn run_cmds(world: &mut World, mut seen: Local<u64>) {
    let rev = world.resource::<Ui2Rev>().0;
    if rev != *seen {
        *seen = rev;
        rebuild_all(world);
    }
    let cmds = std::mem::take(&mut world.resource_mut::<Ui2Cmds>().0);
    for c in cmds {
        match c {
            Cmd::Open(name) => {
                if let Some((s, path)) = load(world, &name) {
                    push(world, &name, s, Some(path));
                }
            }
            Cmd::Show(name, screen) => push(world, &name, *screen, None),
            Cmd::Back => pop(world),
            Cmd::CloseAll => {
                let all = std::mem::take(&mut world.resource_mut::<Ui2Screens>().stack);
                for s in all {
                    retire(world, s.root, false);
                }
                world.resource_mut::<Ui2Focus>().0 = None;
            }
            Cmd::Set(k, v) => world.resource_mut::<UiData>().set(&k, v),
        }
    }
}
