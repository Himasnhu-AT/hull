//! Spatial focus for ui2 screens: arrows / WASD / D-pad / left stick move to the nearest
//! [`Focusable2`] in that direction, Enter / Space / South activate, Esc / East go back,
//! Q E / PageUp PageDown / shoulder buttons switch tabs, hovering with the mouse focuses and a
//! click activates. A modal narrows focus to its subtree ([`FocusScope`]).

use bevy::input::gamepad::{Gamepad, GamepadButton};
use bevy::picking::hover::Hovered;
use bevy::prelude::*;
use bevy::ui::{ComputedNode, Pressed, UiGlobalTransform};

use super::{Action, Cmd, Ui2Cmds, Ui2Set, UiData, UiEvent, UiEventKind};

/// A focusable, activatable element. Activating emits `UiEvent { id, Activate }` and runs `action`.
#[derive(Component, Clone, Debug, Default)]
pub struct Focusable2 {
    pub id: String,
    pub action: Action,
    pub disabled: bool,
}

#[derive(Resource, Default, Debug)]
pub struct Ui2Focus(pub Option<Entity>);

/// When set, only descendants of this entity can be focused (a modal).
#[derive(Resource, Default, Debug)]
pub struct FocusScope(pub Option<Entity>);

#[derive(Message, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Nav2 {
    Up,
    Down,
    Left,
    Right,
    Accept,
    Back,
    NextTab,
    PrevTab,
}

impl Nav2 {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "up" => Self::Up,
            "down" => Self::Down,
            "left" => Self::Left,
            "right" => Self::Right,
            "accept" | "enter" => Self::Accept,
            "back" | "esc" => Self::Back,
            "next_tab" => Self::NextTab,
            "prev_tab" => Self::PrevTab,
            _ => return None,
        })
    }
}

/// An axis-aligned rectangle in layout space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct R {
    pub min: Vec2,
    pub max: Vec2,
}

impl R {
    pub fn center(&self) -> Vec2 {
        (self.min + self.max) * 0.5
    }
}

/// The best candidate in `dir` (unit axis vector, +y is down) from `cur`. Candidates must lie in
/// the half-plane of the direction; the score prefers close centres and penalises sideways drift
/// (twice), with rows / columns that overlap `cur` favoured.
pub fn pick<T: Copy>(cur: R, cands: &[(T, R)], dir: Vec2) -> Option<T> {
    let c = cur.center();
    let mut best: Option<(f32, T)> = None;
    for (t, r) in cands {
        let d = r.center() - c;
        let along = d.dot(dir);
        if along <= 1.0 {
            continue;
        }
        let across = (d - dir * along).length();
        // Overlap on the cross axis means "same row / column": no drift penalty.
        let overlaps = if dir.x != 0.0 { r.min.y < cur.max.y && r.max.y > cur.min.y } else { r.min.x < cur.max.x && r.max.x > cur.min.x };
        let score = along + across * if overlaps { 0.5 } else { 3.0 };
        if best.is_none_or(|(s, _)| score < s) {
            best = Some((score, *t));
        }
    }
    best.map(|(_, t)| t)
}

pub struct FocusPlugin;

impl Plugin for FocusPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<FocusScope>().add_systems(
            Update,
            (gather_nav, mouse_focus, apply_nav, validate_focus).chain().in_set(Ui2Set::Input),
        );
    }
}

fn gather_nav(
    keys: Option<Res<ButtonInput<KeyCode>>>,
    pads: Query<&Gamepad>,
    mut stick: Local<[bool; 4]>,
    mut out: MessageWriter<Nav2>,
) {
    if let Some(k) = keys {
        for (key, nav) in [
            (KeyCode::ArrowUp, Nav2::Up),
            (KeyCode::KeyW, Nav2::Up),
            (KeyCode::ArrowDown, Nav2::Down),
            (KeyCode::KeyS, Nav2::Down),
            (KeyCode::ArrowLeft, Nav2::Left),
            (KeyCode::KeyA, Nav2::Left),
            (KeyCode::ArrowRight, Nav2::Right),
            (KeyCode::KeyD, Nav2::Right),
            (KeyCode::Enter, Nav2::Accept),
            (KeyCode::Space, Nav2::Accept),
            (KeyCode::Escape, Nav2::Back),
            (KeyCode::KeyQ, Nav2::PrevTab),
            (KeyCode::PageUp, Nav2::PrevTab),
            (KeyCode::KeyE, Nav2::NextTab),
            (KeyCode::PageDown, Nav2::NextTab),
        ] {
            if k.just_pressed(key) {
                out.write(nav);
            }
        }
    }
    for g in &pads {
        for (b, nav) in [
            (GamepadButton::DPadUp, Nav2::Up),
            (GamepadButton::DPadDown, Nav2::Down),
            (GamepadButton::DPadLeft, Nav2::Left),
            (GamepadButton::DPadRight, Nav2::Right),
            (GamepadButton::South, Nav2::Accept),
            (GamepadButton::East, Nav2::Back),
            (GamepadButton::LeftTrigger, Nav2::PrevTab),
            (GamepadButton::RightTrigger, Nav2::NextTab),
        ] {
            if g.just_pressed(b) {
                out.write(nav);
            }
        }
        // Left stick: one nav per push past the threshold.
        let s = g.left_stick();
        let now = [s.y > 0.6, s.y < -0.6, s.x < -0.6, s.x > 0.6];
        for (i, nav) in [Nav2::Up, Nav2::Down, Nav2::Left, Nav2::Right].into_iter().enumerate() {
            if now[i] && !stick[i] {
                out.write(nav);
            }
        }
        *stick = now;
    }
}

type Cands<'w, 's> = Query<'w, 's, (Entity, &'static Focusable2, &'static ComputedNode, &'static UiGlobalTransform, Option<&'static Node>)>;

fn rect_of(c: &ComputedNode, t: &UiGlobalTransform) -> R {
    let half = c.size * 0.5;
    R { min: t.translation - half, max: t.translation + half }
}

fn in_scope(scope: Option<Entity>, e: Entity, parents: &Query<&ChildOf>) -> bool {
    match scope {
        None => true,
        Some(s) => e == s || parents.iter_ancestors(e).any(|a| a == s),
    }
}

/// Hidden (`display: none`) nodes and disabled elements cannot take focus.
fn focusable_now(e: Entity, f: &Focusable2, nodes: &Query<&Node>, parents: &Query<&ChildOf>) -> bool {
    if f.disabled {
        return false;
    }
    let shown = |x: Entity| nodes.get(x).is_ok_and(|n| n.display != Display::None);
    shown(e) && parents.iter_ancestors(e).all(shown)
}

fn mouse_focus(
    mut focus: ResMut<Ui2Focus>,
    scope: Res<FocusScope>,
    hovered: Query<(Entity, &Hovered, &Focusable2), Changed<Hovered>>,
    parents: Query<&ChildOf>,
    nodes: Query<&Node>,
    pressed: Query<(Entity, &Focusable2), Added<Pressed>>,
    mut cmds: ResMut<Ui2Cmds>,
    mut events: MessageWriter<UiEvent>,
) {
    for (e, h, f) in &hovered {
        if h.0 && focusable_now(e, f, &nodes, &parents) && in_scope(scope.0, e, &parents) && focus.0 != Some(e) {
            focus.0 = Some(e);
        }
    }
    for (e, f) in &pressed {
        if focusable_now(e, f, &nodes, &parents) && in_scope(scope.0, e, &parents) {
            focus.0 = Some(e);
            activate(e, f, &mut cmds, &mut events);
        }
    }
}

pub(super) fn activate(e: Entity, f: &Focusable2, cmds: &mut Ui2Cmds, events: &mut MessageWriter<UiEvent>) {
    events.write(UiEvent { id: f.id.clone(), kind: UiEventKind::Activate, entity: e });
    match &f.action {
        Action::None => {}
        Action::Open(n) => cmds.0.push(Cmd::Open(n.clone())),
        Action::Back => cmds.0.push(Cmd::Back),
        Action::SetStr(k, v) => cmds.0.push(Cmd::Set(k.clone(), v.clone().into())),
        Action::SetNum(k, v) => cmds.0.push(Cmd::Set(k.clone(), (*v).into())),
        Action::SetBool(k, v) => cmds.0.push(Cmd::Set(k.clone(), (*v).into())),
    }
}

#[derive(bevy::ecs::system::SystemParam)]
struct NavCtx<'w, 's> {
    cands: Cands<'w, 's>,
    parents: Query<'w, 's, &'static ChildOf>,
    nodes: Query<'w, 's, &'static Node>,
    scope: Res<'w, FocusScope>,
}

fn apply_nav(
    mut nav: MessageReader<Nav2>,
    mut focus: ResMut<Ui2Focus>,
    ctx: NavCtx,
    f2: Query<&Focusable2>,
    mut tabs: Query<(Entity, &mut super::components::TabBar)>,
    sliders: Query<(&super::components::Slider2, &Focusable2)>,
    mut cmds: ResMut<Ui2Cmds>,
    mut events: MessageWriter<UiEvent>,
    mut data: ResMut<UiData>,
) {
    for n in nav.read().copied() {
        match n {
            Nav2::Up | Nav2::Down | Nav2::Left | Nav2::Right => {
                let dir = match n {
                    Nav2::Up => Vec2::NEG_Y,
                    Nav2::Down => Vec2::Y,
                    Nav2::Left => Vec2::NEG_X,
                    _ => Vec2::X,
                };
                // A focused slider takes Left / Right as value steps.
                if matches!(n, Nav2::Left | Nav2::Right)
                    && let Some(e) = focus.0
                    && let Ok((sl, f)) = sliders.get(e)
                {
                    let step = if sl.step > 0.0 { sl.step } else { (sl.max - sl.min) / 20.0 };
                    let cur = data.f64(&sl.key) as f32;
                    let dir = if n == Nav2::Right { 1.0 } else { -1.0 };
                    if let Some(v) = sl.set(&mut data, cur + dir * step) {
                        events.write(UiEvent { id: f.id.clone(), kind: UiEventKind::Slide(v), entity: e });
                    }
                    continue;
                }
                let Some(cur) = focus.0.and_then(|e| ctx.cands.get(e).ok()).map(|(_, _, c, t, _)| rect_of(c, t)) else { continue };
                let list: Vec<(Entity, R)> = ctx
                    .cands
                    .iter()
                    .filter(|(e, f, ..)| Some(*e) != focus.0 && focusable_now(*e, f, &ctx.nodes, &ctx.parents) && in_scope(ctx.scope.0, *e, &ctx.parents))
                    .map(|(e, _, c, t, _)| (e, rect_of(c, t)))
                    .collect();
                if let Some(next) = pick(cur, &list, dir) {
                    focus.0 = Some(next);
                }
            }
            Nav2::Accept => {
                if let Some(e) = focus.0
                    && let Ok(f) = f2.get(e)
                    && !f.disabled
                {
                    activate(e, f, &mut cmds, &mut events);
                }
            }
            Nav2::Back => {
                events.write(UiEvent { id: "back".into(), kind: UiEventKind::Back, entity: focus.0.unwrap_or(Entity::PLACEHOLDER) });
                cmds.0.push(Cmd::Back);
            }
            Nav2::NextTab | Nav2::PrevTab => {
                // The first tab bar inside the scope (the top screen's).
                for (e, mut bar) in &mut tabs {
                    if !in_scope(ctx.scope.0, e, &ctx.parents) || bar.count == 0 {
                        continue;
                    }
                    let i = if n == Nav2::NextTab { (bar.selected + 1) % bar.count } else { (bar.selected + bar.count - 1) % bar.count };
                    bar.selected = i;
                    data.set(&format!("ui.tab.{}", bar.id), i as u64);
                    events.write(UiEvent { id: bar.id.clone(), kind: UiEventKind::Tab(i), entity: e });
                    break;
                }
            }
        }
    }
}

/// Keep focus on a live, visible, in-scope element; default to the top-left one. Emits `Focus`.
fn validate_focus(mut focus: ResMut<Ui2Focus>, ctx: NavCtx, f2: Query<&Focusable2>, tabs: Query<(), With<super::components::TabItem>>, mut last: Local<Option<Entity>>, mut events: MessageWriter<UiEvent>) {
    let ok = |e: Entity| f2.get(e).is_ok_and(|f| focusable_now(e, f, &ctx.nodes, &ctx.parents)) && in_scope(ctx.scope.0, e, &ctx.parents);
    if !focus.0.is_some_and(ok) {
        let first = ctx
            .cands
            .iter()
            .filter(|(e, ..)| ok(*e))
            .min_by(|a, b| {
                let (ra, rb) = (rect_of(a.2, a.3), rect_of(b.2, b.3));
                // Row-major by centre, rows 24 px apart count as the same row.
                // Tabs come last: a screen opens on its first tile / button.
                let key = |e: Entity, r: R| (tabs.contains(e), (r.min.y / 24.0).round() as i32, r.min.x as i32);
                key(a.0, ra).cmp(&key(b.0, rb)).then(a.0.cmp(&b.0))
            })
            .map(|(e, ..)| e);
        if focus.0 != first {
            focus.0 = first;
        }
    }
    if *last != focus.0 {
        *last = focus.0;
        if let Some(e) = focus.0
            && let Ok(f) = f2.get(e)
        {
            events.write(UiEvent { id: f.id.clone(), kind: UiEventKind::Focus, entity: e });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f32, y: f32) -> R {
        R { min: Vec2::new(x, y), max: Vec2::new(x + 100.0, y + 80.0) }
    }

    #[test]
    fn moves_to_the_neighbour_in_the_pressed_direction() {
        // 3 columns x 2 rows.
        let cells: Vec<(u32, R)> = (0..6).map(|i| (i, r((i % 3) as f32 * 120.0, (i / 3) as f32 * 100.0))).collect();
        let at = |i: u32| cells[i as usize].1;
        assert_eq!(pick(at(0), &cells, Vec2::X), Some(1));
        assert_eq!(pick(at(1), &cells, Vec2::Y), Some(4));
        assert_eq!(pick(at(4), &cells, Vec2::NEG_X), Some(3));
        assert_eq!(pick(at(0), &cells, Vec2::NEG_X), None, "nothing to the left of the first column");
        assert_eq!(pick(at(2), &cells, Vec2::NEG_Y), None);
    }

    #[test]
    fn a_wide_tile_is_reachable_from_either_column_below_it() {
        let mut cells = vec![(0u32, r(0.0, 0.0)), (1, r(120.0, 0.0))];
        cells.push((2, R { min: Vec2::new(0.0, 100.0), max: Vec2::new(220.0, 180.0) }));
        assert_eq!(pick(cells[0].1, &cells, Vec2::Y), Some(2));
        assert_eq!(pick(cells[1].1, &cells, Vec2::Y), Some(2));
        assert!(pick(cells[2].1, &cells, Vec2::NEG_Y).is_some());
    }
}
