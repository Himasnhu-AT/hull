//! Engine warnings and errors for the Output panel. A `tracing` layer (installed through
//! `LogPlugin::custom_layer`, see `app.rs`) queues WARN and ERROR events; a system moves them
//! into the editor's diagnostics with source `engine`.

use std::collections::VecDeque;
use std::fmt::Debug;
use std::sync::Mutex;

use bevy::log::tracing::field::{Field, Visit};
use bevy::log::tracing::{Event, Level as TLevel, Subscriber};
use bevy::log::tracing_subscriber::Layer;
use bevy::log::tracing_subscriber::layer::Context;
use bevy::log::BoxedLayer;
use bevy::prelude::*;
use editor_proto::{Diagnostic, Level};

use super::EditorState;

/// Events waiting for the next frame. Bounded: nothing drains it outside the editor.
static QUEUE: Mutex<VecDeque<Diagnostic>> = Mutex::new(VecDeque::new());
const MAX_QUEUED: usize = 500;

struct Message(String);

impl Visit for Message {
    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0 = value.to_owned();
        }
    }
}

struct EngineLog;

impl<S: Subscriber> Layer<S> for EngineLog {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        let meta = event.metadata();
        let level = match *meta.level() {
            TLevel::ERROR => Level::Error,
            TLevel::WARN => Level::Warn,
            _ => return,
        };
        // The editor's own messages already reach the panel directly.
        if meta.target().starts_with("engine::editor") {
            return;
        }
        let mut m = Message(String::new());
        event.record(&mut m);
        if m.0.is_empty() {
            return;
        }
        let target = meta.target().rsplit("::").next().unwrap_or(meta.target());
        let d = Diagnostic::new(level, "engine", format!("{target}: {}", m.0));
        if let Ok(mut q) = QUEUE.lock() {
            if q.len() >= MAX_QUEUED {
                q.pop_front();
            }
            q.push_back(d);
        }
    }
}

/// For `LogPlugin::custom_layer`.
pub fn layer(_: &mut App) -> Option<BoxedLayer> {
    Some(Box::new(EngineLog))
}

/// Moves queued engine events into the editor's diagnostics.
pub(super) fn drain(mut st: ResMut<EditorState>) {
    let Ok(mut q) = QUEUE.try_lock() else { return };
    while let Some(d) = q.pop_front() {
        st.push_diag(d);
    }
}
