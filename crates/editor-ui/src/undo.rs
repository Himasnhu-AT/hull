//! Undo/redo stack of [`Op`]s. Undo applies `op.inverse()`; a drag or scrub that keeps the same
//! merge key folds into one step.
//!
//! This is a journal of ops, not of document snapshots: the document lives in the engine, and the
//! stack only knows how to reverse each edit exactly (`Op::inverse`).

use editor_proto::Op;

/// Edits with the same key closer together than this (seconds) fold into one step.
const MERGE_WINDOW: f64 = 1.5;
/// Steps kept.
const MAX_STEPS: usize = 500;

#[derive(Clone, Debug)]
struct Entry {
    label: String,
    op: Op,
    key: Option<String>,
    at: f64,
}

#[derive(Debug, Default)]
pub struct UndoStack {
    undo: Vec<Entry>,
    redo: Vec<Entry>,
}

impl UndoStack {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an op that has already been applied. With a `key`, folds into the previous step
    /// when that step has the same key, was not sealed and is recent.
    pub fn record(&mut self, label: &str, op: Op, key: Option<String>, now: f64) {
        self.redo.clear();
        if let (Some(k), Some(last)) = (&key, self.undo.last_mut())
            && last.key.as_ref() == Some(k)
            && now - last.at <= MERGE_WINDOW
            && last.op.merge(&op)
        {
            last.at = now;
            if last.op.is_noop() {
                self.undo.pop();
            }
            return;
        }
        if op.is_noop() {
            return;
        }
        self.undo.push(Entry {
            label: label.to_owned(),
            op,
            key,
            at: now,
        });
        if self.undo.len() > MAX_STEPS {
            self.undo.remove(0);
        }
    }

    /// End the current gesture: the next edit starts a new step.
    pub fn seal(&mut self) {
        if let Some(last) = self.undo.last_mut() {
            last.key = None;
        }
    }

    /// The op to apply to undo the last step. The step moves to the redo side.
    pub fn undo(&mut self) -> Option<Op> {
        let mut e = self.undo.pop()?;
        e.key = None;
        let op = e.op.inverse();
        self.redo.push(e);
        Some(op)
    }

    /// The op to apply to redo the last undone step.
    pub fn redo(&mut self) -> Option<Op> {
        let e = self.redo.pop()?;
        let op = e.op.clone();
        self.undo.push(e);
        Some(op)
    }

    /// Put a step back after its inverse failed to apply.
    pub fn restore_undo(&mut self) {
        if let Some(e) = self.redo.pop() {
            self.undo.push(e);
        }
    }

    /// Put a step back after its redo failed to apply.
    pub fn restore_redo(&mut self) {
        if let Some(e) = self.undo.pop() {
            self.redo.push(e);
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
    pub fn undo_label(&self) -> Option<&str> {
        self.undo.last().map(|e| e.label.as_str())
    }
    #[allow(dead_code)]
    pub fn redo_label(&self) -> Option<&str> {
        self.redo.last().map(|e| e.label.as_str())
    }
    pub fn len(&self) -> usize {
        self.undo.len()
    }
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.undo.is_empty()
    }
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }

    /// Labels of every step, oldest first: the applied ones, then the undone ones in the order
    /// redo would replay them. Also how many are applied.
    pub fn history(&self) -> (Vec<&str>, usize) {
        let labels = self.undo.iter().map(|e| e.label.as_str()).chain(self.redo.iter().rev().map(|e| e.label.as_str())).collect();
        (labels, self.undo.len())
    }
}

/// The History panel: every step, the applied ones solid, the undone ones dimmed. Click a row to
/// jump to the state right after it (`Req::HistoryJump`); the first row is the state before any edit.
pub(crate) fn show(ui: &mut egui::Ui, stack: &UndoStack, reqs: &mut Vec<crate::model::Req>) {
    use ashlar_ui::tokens;
    let t = tokens::current(ui.ctx());
    let (labels, applied) = stack.history();
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(format!("{} step(s), {} applied", labels.len(), applied)).small().color(t.text.secondary));
    });
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        let w = ui.available_width();
        let mut row = |ui: &mut egui::Ui, idx: usize, text: String, dim: bool| {
            let color = if dim { t.text.disabled } else { t.text.primary };
            let resp = ui.add(egui::Button::selectable(idx == applied, egui::RichText::new(text).color(color)).min_size(egui::vec2(w, 0.0)));
            if resp.clicked() && idx != applied {
                reqs.push(crate::model::Req::HistoryJump(idx));
            }
        };
        row(ui, 0, "Start".into(), false);
        for (i, l) in labels.iter().enumerate() {
            row(ui, i + 1, format!("{:>3}  {l}", i + 1), i >= applied);
        }
        if labels.is_empty() {
            ui.label(egui::RichText::new("No edits yet.").color(t.text.disabled));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_proto::StableOrId;
    use serde_json::json;

    fn set(before: i32, after: i32) -> Op {
        Op::SetComponent {
            entity: StableOrId::Id(1),
            type_path: "T".into(),
            before: Some(json!(before)),
            after: Some(json!(after)),
        }
    }

    #[test]
    fn scrub_with_one_key_is_one_step() {
        let mut s = UndoStack::new();
        for (i, v) in (1..=10).enumerate() {
            s.record("Move", set(v - 1, v), Some("k".into()), i as f64 * 0.016);
        }
        assert_eq!(s.len(), 1);
        assert_eq!(s.undo(), Some(set(10, 0)));
        assert_eq!(s.redo(), Some(set(0, 10)));
    }

    #[test]
    fn seal_and_different_keys_split_steps() {
        let mut s = UndoStack::new();
        s.record("a", set(0, 1), Some("k".into()), 0.0);
        s.seal();
        s.record("a", set(1, 2), Some("k".into()), 0.1);
        s.record("b", set(2, 3), Some("other".into()), 0.2);
        assert_eq!(s.len(), 3);
        s.record("c", set(3, 4), Some("other".into()), 10.0); // too late to merge
        assert_eq!(s.len(), 4);
    }

    #[test]
    fn history_lists_applied_then_undone() {
        let mut s = UndoStack::new();
        s.record("a", set(0, 1), None, 0.0);
        s.record("b", set(1, 2), None, 1.0);
        s.record("c", set(2, 3), None, 2.0);
        s.undo();
        s.undo();
        let (labels, applied) = s.history();
        assert_eq!(labels, vec!["a", "b", "c"]);
        assert_eq!(applied, 1);
    }

    #[test]
    fn drag_back_to_start_leaves_no_step_and_new_edit_clears_redo() {
        let mut s = UndoStack::new();
        s.record("m", set(5, 6), Some("k".into()), 0.0);
        s.record("m", set(6, 5), Some("k".into()), 0.1);
        assert!(s.is_empty());
        s.record("x", set(0, 1), None, 0.0);
        s.undo();
        assert!(s.can_redo());
        s.record("y", set(0, 2), None, 1.0);
        assert!(!s.can_redo());
    }
}
