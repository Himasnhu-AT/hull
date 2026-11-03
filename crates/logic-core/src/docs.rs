//! Documentation and palette data for node kinds: one table the editor palette, the node
//! inspector and the tests share, so what the palette offers is what the validator accepts.

use crate::graph::{CmpOp, MathOp, NodeKind};
use crate::value::Value;

/// A node the palette can add: a ready-made kind plus its place in the menu.
#[derive(Clone, Debug, PartialEq)]
pub struct Template {
    pub label: String,
    pub category: &'static str,
    pub kind: NodeKind,
}

/// Palette group of a kind.
pub fn category(kind: &NodeKind) -> &'static str {
    use NodeKind::*;
    match kind {
        Start | Tick | OverlapEnter | OverlapExit | Action(_) | Timer { .. } | Message(_) => "Events",
        Branch | Sequence { .. } | Delay { .. } | ForEach => "Flow",
        Find { .. } | Get { .. } | Set { .. } | GetVar(_) | SetVar(_) => "World",
        Const(_) | Math(_) | Clamp | Compare(_) | And | Or | Not => "Math",
        Vec3Make | Vec3Split | Vec3Add | Vec3Scale => "Vec3",
        Command { .. } => "Commands",
        Script { .. } => "Scripts",
        Emit(_) | Log => "Effects",
    }
}

/// What the node does, in a sentence or two (inspector and palette tooltip).
pub fn docs(kind: &NodeKind) -> &'static str {
    use NodeKind::*;
    match kind {
        Start => "Runs once, when the graph is loaded on the entity.",
        Tick => "Runs every frame. `dt` is the frame time in seconds.",
        OverlapEnter => "Runs when another body starts touching this entity's sensor. `other` is that entity.",
        OverlapExit => "Runs when another body stops touching this entity's sensor.",
        Action(_) => "Runs when the input action is pressed. `value` is the action value.",
        Timer { .. } => "Runs after `secs` seconds, once or repeatedly.",
        Message(_) => "Runs when a message with this name is sent (Emit node, script, or Rust).",
        Branch => "Follows `true` or `false` depending on `cond`.",
        Sequence { .. } => "Runs its outputs one after another, 0 first.",
        Delay { .. } => "Waits `secs` seconds, then continues. Data from nodes before it is not available after.",
        ForEach => "Runs `body` for each item of the JSON array `list`, then `done`.",
        Find { .. } => "The entity with this Name, or no entity.",
        Get { .. } => "Reads a component field of `entity` by path, e.g. Transform.translation.y.",
        Set { .. } => "Writes a component field of `entity` by path.",
        Const(_) => "A fixed value.",
        Math(_) => "Arithmetic on two numbers.",
        Clamp => "Limits `value` to the range min..max.",
        Compare(_) => "Compares two values; the result is a bool.",
        And => "True when both inputs are true.",
        Or => "True when either input is true.",
        Not => "Flips a bool.",
        Vec3Make => "Builds a vec3 from x, y, z.",
        Vec3Split => "Splits a vec3 into x, y, z.",
        Vec3Add => "Adds two vec3.",
        Vec3Scale => "Multiplies a vec3 by a number.",
        Command { .. } => "Runs an engine control command. Parameters written as \"$name\" become input pins.",
        Script { .. } => "Calls a function of a ruspy script file. Its return value is `result`.",
        Emit(_) => "Sends a message to every graph's Message events.",
        Log => "Writes `text` to the logic log (Output panel).",
        GetVar(_) => "Reads a graph variable of this entity.",
        SetVar(_) => "Writes a graph variable of this entity.",
    }
}

/// Title shown on a node.
pub fn label(kind: &NodeKind) -> String {
    use NodeKind::*;
    match kind {
        Action(n) => format!("Action {n}"),
        Message(n) => format!("Message {n}"),
        Timer { secs, repeat } => format!("Timer {secs}s{}", if *repeat { " (repeat)" } else { "" }),
        Delay { secs } => format!("Delay {secs}s"),
        Sequence { n } => format!("Sequence x{n}"),
        Find { name } => format!("Find {name}"),
        Get { path } => format!("Get {path}"),
        Set { path } => format!("Set {path}"),
        Const(v) => format!("Const {}", v.display()),
        Math(op) => format!("{op:?}"),
        Compare(op) => format!("Compare {}", cmp_symbol(*op)),
        Command { id, .. } => format!("Command {id}"),
        Script { file, function, .. } => format!("{}::{function}", file.trim_end_matches(".ruspy")),
        Emit(n) => format!("Emit {n}"),
        GetVar(n) => format!("Get {n}"),
        SetVar(n) => format!("Set {n}"),
        Vec3Make => "Make Vec3".into(),
        Vec3Split => "Split Vec3".into(),
        Vec3Add => "Add Vec3".into(),
        Vec3Scale => "Scale Vec3".into(),
        other => crate::kind_name(other),
    }
}

pub fn cmp_symbol(op: CmpOp) -> &'static str {
    match op {
        CmpOp::Eq => "==",
        CmpOp::Ne => "!=",
        CmpOp::Lt => "<",
        CmpOp::Le => "<=",
        CmpOp::Gt => ">",
        CmpOp::Ge => ">=",
    }
}

/// Every kind with sensible default parameters, for the palette. Commands, scripts and
/// variables are added by the editor from the engine's lists.
pub fn templates() -> Vec<Template> {
    use NodeKind::*;
    let mut v: Vec<NodeKind> = vec![
        Start,
        Tick,
        OverlapEnter,
        OverlapExit,
        Action("action".into()),
        Timer { secs: 1.0, repeat: false },
        Message("message".into()),
        Branch,
        Sequence { n: 2 },
        Delay { secs: 0.5 },
        ForEach,
        Find { name: "Name".into() },
        Get { path: "Transform.translation.y".into() },
        Set { path: "Transform.translation.y".into() },
        Const(Value::Num(0.0)),
        Const(Value::Bool(true)),
        Const(Value::text("text")),
        Clamp,
        And,
        Or,
        Not,
        Vec3Make,
        Vec3Split,
        Vec3Add,
        Vec3Scale,
        Emit("message".into()),
        Log,
    ];
    for op in [MathOp::Add, MathOp::Sub, MathOp::Mul, MathOp::Div, MathOp::Min, MathOp::Max] {
        v.push(Math(op));
    }
    for op in [CmpOp::Eq, CmpOp::Ne, CmpOp::Lt, CmpOp::Le, CmpOp::Gt, CmpOp::Ge] {
        v.push(Compare(op));
    }
    v.into_iter().map(|kind| Template { label: label(&kind), category: category(&kind), kind }).collect()
}
