//! Game logic as node graphs (no Bevy): **events → flow → effects**, with typed data pins.
//!
//! - [`Graph`]: serde data (RON): nodes, exec links (flow), data links. [`Graph::compile`]
//!   validates it (types, dangling pins, double links, data cycles, depth) with errors located
//!   at node ids, and builds a [`Compiled`] graph.
//! - [`Runner`]: runs one event through a compiled graph. Flow is executed with an explicit
//!   stack, data is evaluated lazily and cached, a step budget stops loops. World access and
//!   side effects go through the [`Host`] trait, so the core knows nothing about the engine.
//!
//! The engine side (components, event sources, host over the ECS, scripts) is `engine::logic`.

mod compile;
mod docs;
mod graph;
mod run;
mod value;

pub use compile::{Compiled, DataIn, Dflt, GraphError, PinSpec, Severity, TimerDef, Trigger, MAX_DATA_DEPTH, kind_name, param_names, pins};
pub use docs::{Template, category, cmp_symbol, docs, label, templates};
pub use graph::{CmpOp, Comment, Graph, Link, MathOp, Node, NodeKind, ParseError, Pin, Var};
pub use run::{Entry, Host, Payload, RunError, Runner};
pub use value::{Ty, Value};

#[cfg(test)]
mod tests;
