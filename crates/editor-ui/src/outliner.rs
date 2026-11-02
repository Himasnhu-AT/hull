//! Outliner: the entity tree with search, multi-select, inline rename and drag to reparent.

use std::collections::HashSet;

use ashlar_ui::search::SearchField;
use ashlar_ui::tokens::{self, Tokens};
use ashlar_ui::virtual_list::{RowHeights, VirtualList};
use editor_proto::{EntityId, NodeKind, Op, TreeNode};
use egui::{Color32, Key, Rect, Sense, Ui, pos2, vec2};

use crate::model::{Cmd, Nodes, Req};

#[derive(Default)]
pub(crate) struct OutlinerState {
    pub filter: String,
    collapsed: HashSet<EntityId>,
    collapsed_gen: u64,
    rows: Vec<(EntityId, u16)>,
    rows_key: Option<(u64, u64, bool)>,
    pub renaming: Option<Renaming>,
    anchor: Option<EntityId>,
    scroll_to: Option<EntityId>,
}

pub(crate) struct Renaming {
    pub id: EntityId,
    text: String,
    focus_pending: bool,
}

impl OutlinerState {
    pub fn start_rename(&mut self, id: EntityId, current: &str) {
        self.renaming = Some(Renaming {
            id,
            text: current.to_owned(),
            focus_pending: true,
        });
    }
    pub fn scroll_to(&mut self, id: EntityId) {
        self.scroll_to = Some(id);
    }
    /// Ids in visible order (for tests and range selection).
    #[cfg(test)]
    pub fn visible(&self) -> Vec<EntityId> {
        self.rows.iter().map(|r| r.0).collect()
    }

    fn rebuild(&mut self, tree: &[TreeNode], tree_rev: u64) {
        let key = (tree_rev, self.collapsed_gen, self.filter.is_empty());
        if self.rows_key == Some(key) {
            return;
        }
        self.rows.clear();
        let open_all = !self.filter.is_empty();
        let mut stack: Vec<(&[TreeNode], usize, u16)> = vec![(tree, 0, 0)];
        while let Some((nodes, i, depth)) = stack.last_mut() {
            let Some(n) = nodes.get(*i) else {
                stack.pop();
                continue;
            };
            *i += 1;
            let depth = *depth;
            self.rows.push((n.id, depth));
            if !n.children.is_empty() && (open_all || !self.collapsed.contains(&n.id)) && depth < 200 {
                stack.push((&n.children, 0, depth + 1));
            }
        }
        self.rows_key = Some(key);
    }
}

/// Everything the outliner reads.
pub(crate) struct View<'a> {
    pub tree: &'a [TreeNode],
    pub tree_rev: u64,
    pub nodes: &'a Nodes,
    pub selection: &'a [EntityId],
}

fn kind_glyph(k: NodeKind, t: &Tokens) -> (&'static str, Color32) {
    match k {
        NodeKind::Mesh => ("M", t.status.info),
        NodeKind::Light => ("L", t.status.warning),
        NodeKind::Camera => ("C", t.status.success),
        NodeKind::Audio => ("A", t.accent),
        NodeKind::Logic => ("G", t.status.danger),
        NodeKind::Generated => ("#", t.text.disabled),
        NodeKind::Empty => ("o", t.text.secondary),
        NodeKind::Other => ("?", t.text.secondary),
    }
}

pub(crate) fn show(ui: &mut Ui, st: &mut OutlinerState, v: &View<'_>, reqs: &mut Vec<Req>) {
    let t = tokens::current(ui.ctx());
    ui.horizontal(|ui| {
        let r = SearchField::new("outliner.search", &mut st.filter)
            .hint("Search entities")
            .width(ui.available_width())
            .show(ui);
        if r.changed {
            reqs.push(Req::TreeFilterChanged);
        }
    });
    st.rebuild(v.tree, v.tree_rev);

    let row_h = t.control_height - 2.0;
    let indent = t.space.xl;
    let selected: HashSet<EntityId> = v.selection.iter().copied().collect();
    let cursor = v.selection.last().and_then(|s| st.rows.iter().position(|r| r.0 == *s));
    let scroll_row = st.scroll_to.take().and_then(|id| st.rows.iter().position(|r| r.0 == id));

    let rows = &st.rows;
    let collapsed = &mut st.collapsed;
    let collapsed_gen = &mut st.collapsed_gen;
    let renaming = &mut st.renaming;
    let anchor = &mut st.anchor;
    let is_sel = |i: usize| rows.get(i).is_some_and(|r| selected.contains(&r.0));
    let label_of = |i: usize| rows.get(i).and_then(|r| v.nodes.info.get(&r.0)).map_or("", |n| n.name.as_str());
    let mut new_selection: Option<Vec<EntityId>> = None;
    let mut rename_commit: Option<(EntityId, String)> = None;
    let mut cancel_rename = false;
    let mut drop: Option<(EntityId, Option<EntityId>)> = None;

    let list = VirtualList::new("outliner.list", rows.len(), RowHeights::Uniform(row_h))
        .selected(cursor)
        .is_selected(&is_sel)
        .row_label(&label_of)
        .scroll_to(scroll_row);
    let out = list.show(ui, |ui, row| {
        let Some(&(id, depth)) = rows.get(row.index) else { return };
        let Some(info) = v.nodes.info.get(&id) else { return };
        let x0 = row.rect.left() + depth as f32 * indent;
        let resp = ui.interact(row.rect, egui::Id::new(("outliner.row", id)), Sense::click_and_drag());
        if resp.clicked() {
            let m = ui.input(|i| i.modifiers);
            let mut sel: Vec<EntityId> = v.selection.to_vec();
            if m.shift && anchor.is_some() {
                let a = anchor.and_then(|a| rows.iter().position(|r| r.0 == a)).unwrap_or(row.index);
                let (lo, hi) = (a.min(row.index), a.max(row.index));
                sel = rows[lo..=hi].iter().map(|r| r.0).collect();
            } else if m.command {
                if let Some(p) = sel.iter().position(|s| *s == id) {
                    sel.remove(p);
                } else {
                    sel.push(id);
                }
                *anchor = Some(id);
            } else {
                sel = vec![id];
                *anchor = Some(id);
            }
            new_selection = Some(sel);
        }
        resp.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::SelectableLabel, true, row.selected, &info.name));
        if resp.double_clicked() && !info.generated {
            *renaming = Some(Renaming {
                id,
                text: info.name.clone(),
                focus_pending: true,
            });
        }
        if resp.drag_started() && !info.generated {
            resp.dnd_set_drag_payload(id);
        }
        if resp.dragged() {
            ui.ctx().set_cursor_icon(egui::CursorIcon::Grabbing);
        }
        // Drop target: not generated rows, and never onto itself or its own subtree.
        if !info.generated
            && let Some(src) = resp.dnd_hover_payload::<EntityId>()
        {
            let ok = !v.nodes.is_within(id, *src);
            let c = if ok { t.accent } else { t.status.danger };
            ui.painter().rect_stroke(row.rect.shrink(1.0), 2.0, egui::Stroke::new(1.5, c), egui::StrokeKind::Inside);
        }
        if !info.generated
            && let Some(src) = resp.dnd_release_payload::<EntityId>()
            && !v.nodes.is_within(id, *src)
        {
            drop = Some((*src, Some(id)));
        }

        let arrow = Rect::from_min_size(pos2(x0, row.rect.top()), vec2(indent, row.rect.height()));
        let has_children = info.child_count > 0;
        let open = !collapsed.contains(&id) || !has_children;
        if has_children {
            let ar = ui.interact(arrow, egui::Id::new(("outliner.arrow", id)), Sense::click());
            if ar.clicked() {
                if !collapsed.remove(&id) {
                    collapsed.insert(id);
                }
                *collapsed_gen += 1;
            }
            let c = if ar.hovered() { t.text.primary } else { t.text.secondary };
            let ctr = arrow.center();
            let pts = if open {
                vec![pos2(ctr.x - 3.5, ctr.y - 2.0), pos2(ctr.x + 3.5, ctr.y - 2.0), pos2(ctr.x, ctr.y + 3.0)]
            } else {
                vec![pos2(ctr.x - 2.0, ctr.y - 3.5), pos2(ctr.x - 2.0, ctr.y + 3.5), pos2(ctr.x + 3.0, ctr.y)]
            };
            ui.painter().add(egui::Shape::convex_polygon(pts, c, egui::Stroke::NONE));
        }

        let base = if row.selected { t.selection_text } else { t.text.primary };
        let dim = if info.generated {
            t.text.disabled
        } else if info.hidden {
            t.text.secondary
        } else {
            base
        };
        let (glyph, gc) = kind_glyph(if info.generated { NodeKind::Generated } else { info.kind }, &t);
        let gx = arrow.right() + 2.0;
        let font = Tokens::font(t.type_scale.small);
        ui.painter().text(
            pos2(gx + 5.0, row.rect.center().y),
            egui::Align2::CENTER_CENTER,
            glyph,
            font,
            if row.selected { t.selection_text } else { gc },
        );
        let tx = gx + 16.0;
        if renaming.as_ref().is_some_and(|r| r.id == id) {
            if let Some(r) = renaming.as_mut() {
                let rect = Rect::from_min_max(pos2(tx, row.rect.top() + 1.0), pos2(row.rect.right() - 4.0, row.rect.bottom() - 1.0));
                let te = ui.put(rect, egui::TextEdit::singleline(&mut r.text).id(egui::Id::new(("outliner.rename", id))));
                if r.focus_pending {
                    te.request_focus();
                    r.focus_pending = false;
                }
                if ui.input(|i| i.key_pressed(Key::Escape)) {
                    cancel_rename = true;
                } else if te.lost_focus() {
                    rename_commit = Some((id, r.text.clone()));
                }
            }
        } else {
            ui.painter()
                .text(pos2(tx, row.rect.center().y), egui::Align2::LEFT_CENTER, &info.name, Tokens::font(t.type_scale.body), dim);
        }
    });

    // Drop on the empty area below the rows: move to the root.
    if out.response.dnd_hover_payload::<EntityId>().is_some()
        && let Some(src) = out.response.dnd_release_payload::<EntityId>()
        && drop.is_none()
    {
        drop = Some((*src, None));
    }

    if let Some(sel) = new_selection {
        reqs.push(Req::Select(sel));
    }
    if let Some((id, text)) = rename_commit {
        *renaming = None;
        let text = text.trim().to_owned();
        if let Some(info) = v.nodes.info.get(&id)
            && !text.is_empty()
            && text != info.name
        {
            reqs.push(Req::Edit {
                op: Op::Rename {
                    entity: info.reference,
                    before: info.name.clone(),
                    after: text,
                },
                label: "Rename".into(),
                key: None,
                seal: true,
            });
        }
    }
    if cancel_rename {
        *renaming = None;
    }
    if let Some((src, target)) = drop
        && let Some(op) = reparent_op(v.nodes, src, target) {
            reqs.push(Req::Edit {
                op,
                label: "Reparent".into(),
                key: None,
                seal: true,
            });
        }
    // Keyboard on the focused list.
    if out.response.has_focus() && !renaming.is_some()
        && ui.input(|i| i.key_pressed(Key::F2)) {
            reqs.push(Req::Cmd(Cmd::Rename));
        }
    if let Some(i) = out.select
        && let Some(&(id, _)) = rows.get(i)
    {
        // Arrow keys moved the cursor.
        reqs.push(Req::Select(vec![id]));
        *anchor = Some(id);
    }
}

/// The op that moves `src` under `target` (`None` = to the root). `None` when it is not allowed
/// (generated, same parent, into its own subtree).
pub(crate) fn reparent_op(nodes: &Nodes, src: EntityId, target: Option<EntityId>) -> Option<Op> {
    let s = nodes.info.get(&src)?;
    if s.generated {
        return None;
    }
    if let Some(t) = target {
        let ti = nodes.info.get(&t)?;
        if ti.generated || nodes.is_within(t, src) {
            return None;
        }
    }
    if s.parent == target {
        return None;
    }
    let before = s.parent.map(|p| nodes.reference(p));
    let after = target.map(|t| nodes.reference(t));
    Some(Op::Reparent {
        entity: s.reference,
        before,
        after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_proto::StableId;

    fn tree() -> Vec<TreeNode> {
        let mut a = TreeNode::new(1, "A");
        a.stable = Some(StableId(10));
        let mut b = TreeNode::new(2, "B");
        b.stable = Some(StableId(20));
        let mut c = TreeNode::new(3, "C");
        c.generated = true;
        b.children.push(TreeNode::new(4, "B1"));
        vec![a, b, c]
    }

    #[test]
    fn reparent_rules() {
        let nodes = Nodes::build(&tree());
        // A under B: allowed, references use stable ids when present.
        let op = reparent_op(&nodes, 1, Some(2)).expect("allowed");
        assert_eq!(
            op,
            Op::Reparent {
                entity: editor_proto::StableOrId::Stable(StableId(10)),
                before: None,
                after: Some(editor_proto::StableOrId::Stable(StableId(20)))
            }
        );
        // B into its own child, onto a generated node, from a generated node, same parent: refused.
        assert!(reparent_op(&nodes, 2, Some(4)).is_none());
        assert!(reparent_op(&nodes, 1, Some(3)).is_none());
        assert!(reparent_op(&nodes, 3, Some(1)).is_none());
        assert!(reparent_op(&nodes, 1, None).is_none());
        // B1 to the root: allowed.
        assert!(matches!(reparent_op(&nodes, 4, None), Some(Op::Reparent { after: None, .. })));
    }

    #[test]
    fn collapsed_nodes_hide_children() {
        let t = tree();
        let mut st = OutlinerState::default();
        st.rebuild(&t, 1);
        assert_eq!(st.visible(), vec![1, 2, 4, 3]);
        st.collapsed.insert(2);
        st.collapsed_gen += 1;
        st.rebuild(&t, 1);
        assert_eq!(st.visible(), vec![1, 2, 3]);
    }
}
