//! Graph data: what a `.logic.ron` file holds.

use serde::{Deserialize, Serialize};

use crate::value::Value;

/// `(node id, pin name)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin(pub u32, pub String);

/// Connects an output pin to an input pin.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub from: Pin,
    pub to: Pin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MathOp {
    Add,
    Sub,
    Mul,
    Div,
    Min,
    Max,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CmpOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

/// What a node does. Pins per kind: see [`crate::pins`] and `docs/LOGIC.md`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum NodeKind {
    // Events (flow starts here).
    Start,
    Tick,
    OverlapEnter,
    OverlapExit,
    Action(String),
    Timer { secs: f32, repeat: bool },
    Message(String),
    // Flow.
    Branch,
    Sequence { n: u8 },
    Delay { secs: f32 },
    ForEach,
    // World access.
    Get { path: String },
    Set { path: String },
    // Data.
    Const(Value),
    Math(MathOp),
    Clamp,
    Compare(CmpOp),
    And,
    Or,
    Not,
    Vec3Make,
    Vec3Split,
    Vec3Add,
    Vec3Scale,
    // Effects.
    /// Runs a control command. Strings in `params` of the form `"$name"` become data input
    /// pins `name`; the pin's value replaces the string.
    Command { id: String, params: serde_json::Value },
    /// Calls a ruspy function; `args` names the data input pins, in call order.
    Script { file: String, function: String, args: Vec<String> },
    /// Sends a message (`Message(name)` events receive it).
    Emit(String),
    Log,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: u32,
    pub kind: NodeKind,
    /// Values for data pins nothing is connected to.
    #[serde(default)]
    pub defaults: Vec<(String, Value)>,
    /// Editor canvas position.
    #[serde(default)]
    pub pos: [f32; 2],
}

impl Node {
    pub fn new(id: u32, kind: NodeKind) -> Node {
        Node { id, kind, defaults: vec![], pos: [0.0, 0.0] }
    }
    pub fn with(mut self, pin: &str, v: Value) -> Node {
        self.defaults.push((pin.into(), v));
        self
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Graph {
    #[serde(default)]
    pub name: String,
    pub nodes: Vec<Node>,
    /// Exec links (flow).
    #[serde(default)]
    pub flow: Vec<Link>,
    /// Data links.
    #[serde(default)]
    pub data: Vec<Link>,
}

/// A RON syntax or shape error with its location.
#[derive(Clone, Debug, PartialEq)]
pub struct ParseError {
    pub line: usize,
    pub col: usize,
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.col, self.message)
    }
}

impl Graph {
    pub fn from_ron(src: &str) -> Result<Graph, ParseError> {
        ron::from_str(src).map_err(|e: ron::error::SpannedError| ParseError { line: e.span.start.line, col: e.span.start.col, message: e.code.to_string() })
    }

    pub fn to_ron(&self) -> String {
        ron::ser::to_string_pretty(self, ron::ser::PrettyConfig::default()).unwrap_or_default()
    }

    pub fn node(&self, id: u32) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// Link `from` → `to` in `flow` (convenience for building graphs in code).
    pub fn flow_link(&mut self, from: (u32, &str), to: u32) -> &mut Self {
        self.flow.push(Link { from: Pin(from.0, from.1.into()), to: Pin(to, "in".into()) });
        self
    }
    pub fn data_link(&mut self, from: (u32, &str), to: (u32, &str)) -> &mut Self {
        self.data.push(Link { from: Pin(from.0, from.1.into()), to: Pin(to.0, to.1.into()) });
        self
    }
}
