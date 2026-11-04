//! Collapses identical toasts: the same message again within [`WINDOW`] replaces the visible
//! toast with one that carries a count ("Place failed: ... (x3)").

/// Seconds within which a repeat of the last message counts as the same one.
pub(crate) const WINDOW: f64 = 2.0;

#[derive(Default)]
pub(crate) struct Dedupe {
    last: Option<Last>,
}

struct Last {
    msg: String,
    at: f64,
    count: u32,
    id: u64,
}

impl Dedupe {
    /// Call for every toast. Returns the id of the toast to dismiss (the previous copy) and the
    /// text to show now.
    pub fn next(&mut self, msg: &str, now: f64) -> (Option<u64>, String) {
        match &mut self.last {
            Some(l) if l.msg == msg && now - l.at <= WINDOW && now >= l.at => {
                l.count += 1;
                l.at = now;
                (Some(l.id), format!("{msg} (x{})", l.count))
            }
            _ => {
                self.last = Some(Last { msg: msg.to_owned(), at: now, count: 1, id: 0 });
                (None, msg.to_owned())
            }
        }
    }
    /// Remember the id the toast got, so a repeat can dismiss it.
    pub fn shown(&mut self, id: u64) {
        if let Some(l) = &mut self.last {
            l.id = id;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_within_the_window_collapse_with_a_count() {
        let mut d = Dedupe::default();
        assert_eq!(d.next("boom", 10.0), (None, "boom".into()));
        d.shown(7);
        assert_eq!(d.next("boom", 10.5), (Some(7), "boom (x2)".into()));
        d.shown(8);
        assert_eq!(d.next("boom", 11.9), (Some(8), "boom (x3)".into()));
    }

    #[test]
    fn a_different_message_or_a_late_repeat_is_new() {
        let mut d = Dedupe::default();
        d.next("a", 0.0);
        d.shown(1);
        assert_eq!(d.next("b", 0.1).0, None);
        d.shown(2);
        assert_eq!(d.next("b", 5.0), (None, "b".into()));
    }
}
