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
        self.undo.push(Entry { label: label.to_owned(), op, key, at: now });
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_proto::StableOrId;
    use serde_json::json;

    fn set(before: i32, after: i32) -> Op {
        Op::SetComponent { entity: StableOrId::Id(1), type_path: "T".into(), before: Some(json!(before)), after: Some(json!(after)) }
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
