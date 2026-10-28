//! Graphs: nodes with an op and named inputs, as serde data (RON files and the Rust builder
//! make the same thing).

use std::collections::{BTreeMap, BTreeSet};

use glam::Vec3;
use serde::{Deserialize, Serialize};

/// Which side of an edge [`Op::EdgeSample`] places points on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    /// Away from the rect's centre (polylines: left).
    #[default]
    Out,
    /// Towards the rect's centre (polylines: right).
    In,
    /// Polylines: left / right of the direction of travel.
    Left,
    Right,
    /// On the edge itself.
    On,
}

/// How much of the output to keep at lower quality (see [`crate::keep_for_tier`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    /// Gameplay-relevant: never thinned.
    Essential,
    #[default]
    Normal,
    /// Pure detail: thinned first.
    Fine,
}

/// What a spawn node makes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SpawnKind {
    #[default]
    Mesh,
    Decal,
    Light,
}

/// A spawn node's settings. `items` are names the game maps to assets.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SpawnDef {
    #[serde(default)]
    pub kind: SpawnKind,
    /// `(name, weight)`: each point picks one by its seed.
    pub items: Vec<(String, f32)>,
    /// Pick by a float attribute instead (index into `items`, floored and clamped).
    #[serde(default)]
    pub by_attr: Option<String>,
    #[serde(default)]
    pub tier: Tier,
    /// Meshes: give them colliders (the catalog's shape).
    #[serde(default)]
    pub collider: bool,
    /// Meshes: cast shadows.
    #[serde(default = "yes")]
    pub shadows: bool,
}

fn yes() -> bool {
    true
}

/// A node's operation. Distances in metres, angles in degrees.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Op {
    /// A named input set: its shapes (for samplers) and points.
    Input { name: String },
    /// World-anchored jittered grid inside the input's rects.
    GridSample { spacing: f32, #[serde(default)] jitter: f32 },
    /// Blue-noise-ish points `radius` apart inside the input's rects (candidates on a world grid,
    /// each dropped if a higher-priority candidate is within `radius`).
    PoissonSample { radius: f32 },
    /// Points every `spacing` along rect edges and polylines, `offset` to one `side`, facing
    /// away from the edge (rects: outward).
    EdgeSample { spacing: f32, #[serde(default)] offset: f32, #[serde(default)] side: Side },
    /// One point per rect, at its centre, with its size and yaw (decals, room props).
    RectFill,
    /// Multiplies density by value noise remapped from `[lo, hi]` to `[0, 1]`.
    DensityNoise { scale: f32, #[serde(default = "one_u32")] octaves: u32, #[serde(default)] lo: f32, #[serde(default = "one_f32")] hi: f32 },
    /// Keeps points with `lo ≤ density ≤ hi`.
    DensityFilter { #[serde(default)] lo: f32, #[serde(default = "one_f32")] hi: f32 },
    /// Keeps each point with probability `density × fraction` (by its seed).
    Keep { #[serde(default = "one_f32")] fraction: f32 },
    /// Removes points inside `against`'s rects / point bounds, grown by `pad`.
    Difference { against: String, #[serde(default)] pad: f32 },
    /// Keeps only points inside `with`'s rects / point bounds, grown by `pad`.
    Intersect { with: String, #[serde(default)] pad: f32 },
    /// Removes points with a higher-priority point (density, then seed) within `radius`.
    SelfPrune { radius: f32 },
    /// Keeps points whose tag is (or, with `keep: false`, isn't) one of `tags`.
    ByTag { tags: Vec<String>, #[serde(default = "yes")] keep: bool },
    /// Offsets (local frame), random extra yaw and uniform scale, XZ jitter.
    Transform {
        #[serde(default)]
        offset: Vec3,
        #[serde(default)]
        yaw: (f32, f32),
        #[serde(default = "unit_range")]
        scale: (f32, f32),
        #[serde(default)]
        jitter: f32,
    },
    /// Puts points on the surface (+ `offset` up); `align` tilts them to its normal.
    Project { #[serde(default)] offset: f32, #[serde(default)] align: bool },
    /// Places a copy of the second input's points (a template around the origin) at each
    /// point of the first.
    Copy,
    /// All inputs' points together.
    Union,
    /// Makes meshes, decals or lights (the game's catalog maps item names to assets).
    Spawn(SpawnDef),
    /// Hands the points back to game code under `port`.
    Emit { port: String },
}

fn one_u32() -> u32 {
    1
}
fn one_f32() -> f32 {
    1.0
}
fn unit_range() -> (f32, f32) {
    (1.0, 1.0)
}

impl Op {
    /// How far outside an evaluated area this op can look (or move points from).
    pub fn reach(&self) -> f32 {
        match self {
            Op::PoissonSample { radius } | Op::SelfPrune { radius } => *radius,
            Op::Transform { offset, jitter, .. } => offset.length() + jitter,
            _ => 0.0,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Op::Input { .. } => "Input",
            Op::GridSample { .. } => "GridSample",
            Op::PoissonSample { .. } => "PoissonSample",
            Op::EdgeSample { .. } => "EdgeSample",
            Op::RectFill => "RectFill",
            Op::DensityNoise { .. } => "DensityNoise",
            Op::DensityFilter { .. } => "DensityFilter",
            Op::Keep { .. } => "Keep",
            Op::Difference { .. } => "Difference",
            Op::Intersect { .. } => "Intersect",
            Op::SelfPrune { .. } => "SelfPrune",
            Op::ByTag { .. } => "ByTag",
            Op::Transform { .. } => "Transform",
            Op::Project { .. } => "Project",
            Op::Copy => "Copy",
            Op::Union => "Union",
            Op::Spawn(_) => "Spawn",
            Op::Emit { .. } => "Emit",
        }
    }

    /// Inputs it needs: exactly, or at least (`Union`).
    fn arity(&self) -> (usize, bool) {
        match self {
            Op::Input { .. } => (0, false),
            Op::Copy => (2, false),
            Op::Union => (1, true),
            _ => (1, false),
        }
    }
}

/// One node.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub op: Op,
    #[serde(default)]
    pub inputs: Vec<String>,
    /// Seed for this node's random choices (default: hash of the id).
    #[serde(default)]
    pub seed: Option<u64>,
}

/// A graph: nodes evaluated in dependency order.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Graph {
    #[serde(default)]
    pub seed: u64,
    pub nodes: Vec<Node>,
}

/// A problem in a graph or during evaluation, with the node it's about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PcgError {
    pub node: String,
    pub msg: String,
}

impl std::fmt::Display for PcgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.node.is_empty() { write!(f, "{}", self.msg) } else { write!(f, "node `{}`: {}", self.node, self.msg) }
    }
}

impl std::error::Error for PcgError {}

fn err(node: &str, msg: impl Into<String>) -> PcgError {
    PcgError { node: node.into(), msg: msg.into() }
}

impl Graph {
    /// Parses RON.
    pub fn from_ron(s: &str) -> Result<Graph, PcgError> {
        let g: Graph = ron::from_str(s).map_err(|e| err("", format!("RON: {e}")))?;
        g.validate()?;
        Ok(g)
    }

    pub fn to_ron(&self) -> String {
        ron::ser::to_string_pretty(self, ron::ser::PrettyConfig::default()).unwrap_or_default()
    }

    /// A Rust builder (linear chains; `.node()` for anything else).
    pub fn build(seed: u64) -> Builder {
        Builder { g: Graph { seed, nodes: Vec::new() }, last: None }
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// Unknown inputs, duplicate ids, wrong input counts, cycles, bad parameters.
    pub fn validate(&self) -> Result<(), PcgError> {
        let mut ids = BTreeSet::new();
        for n in &self.nodes {
            if n.id.is_empty() {
                return Err(err("", "a node has an empty id"));
            }
            if !ids.insert(n.id.as_str()) {
                return Err(err(&n.id, "duplicate id"));
            }
        }
        for n in &self.nodes {
            let (k, more) = n.op.arity();
            if n.inputs.len() < k || (!more && n.inputs.len() != k) {
                return Err(err(&n.id, format!("{} takes {}{} input(s), has {}", n.op.name(), k, if more { "+" } else { "" }, n.inputs.len())));
            }
            for i in n.inputs.iter().chain(match &n.op {
                Op::Difference { against, .. } => Some(against),
                Op::Intersect { with, .. } => Some(with),
                _ => None,
            }) {
                if !ids.contains(i.as_str()) {
                    return Err(err(&n.id, format!("unknown input `{i}`")));
                }
            }
            let positive = |v: f32, what: &str| if v > 0.0 && v.is_finite() { Ok(()) } else { Err(err(&n.id, format!("{what} must be > 0"))) };
            match &n.op {
                Op::GridSample { spacing, .. } | Op::EdgeSample { spacing, .. } => positive(*spacing, "spacing")?,
                Op::PoissonSample { radius } | Op::SelfPrune { radius } => positive(*radius, "radius")?,
                Op::DensityNoise { scale, .. } => positive(*scale, "scale")?,
                Op::Spawn(s) if s.items.is_empty() => return Err(err(&n.id, "spawn has no items")),
                _ => {}
            }
        }
        self.order().map(|_| ())
    }

    /// Node indices in dependency order.
    pub fn order(&self) -> Result<Vec<usize>, PcgError> {
        let index: BTreeMap<&str, usize> = self.nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
        let deps = |n: &Node| -> Vec<usize> {
            let extra = match &n.op {
                Op::Difference { against, .. } => Some(against),
                Op::Intersect { with, .. } => Some(with),
                _ => None,
            };
            n.inputs.iter().chain(extra).filter_map(|i| index.get(i.as_str()).copied()).collect()
        };
        // 0 = unseen, 1 = visiting, 2 = done.
        let mut state = vec![0u8; self.nodes.len()];
        let mut out = Vec::with_capacity(self.nodes.len());
        fn visit(i: usize, g: &Graph, deps: &dyn Fn(&Node) -> Vec<usize>, state: &mut [u8], out: &mut Vec<usize>) -> Result<(), PcgError> {
            match state[i] {
                2 => return Ok(()),
                1 => return Err(err(&g.nodes[i].id, "cycle")),
                _ => {}
            }
            state[i] = 1;
            for d in deps(&g.nodes[i]) {
                visit(d, g, deps, state, out)?;
            }
            state[i] = 2;
            out.push(i);
            Ok(())
        }
        for i in 0..self.nodes.len() {
            visit(i, self, &deps, &mut state, &mut out)?;
        }
        Ok(out)
    }

    /// How far beyond an area evaluation must look so results inside it don't depend on where
    /// the area's edges are: the sum of every node's reach.
    pub fn halo(&self, inputs: &crate::Inputs) -> f32 {
        let mut h: f32 = self.nodes.iter().map(|n| n.op.reach()).sum();
        // Copies can land up to the template's extent away from their anchor.
        for n in &self.nodes {
            if let Op::Copy = n.op
                && let Some(t) = n.inputs.get(1)
                && let Some(Op::Input { name }) = self.node(t).map(|t| &t.op)
                && let Some(s) = inputs.sets.get(name)
            {
                h += s.points.pos.iter().map(|p| p.length()).fold(0.0, f32::max);
            }
        }
        h
    }

    /// A hash of the whole graph (cache key part).
    pub fn hash(&self) -> u64 {
        crate::str_hash(&ron::to_string(self).unwrap_or_default())
    }
}

/// Builds linear chains: each call adds a node fed by the previous one.
pub struct Builder {
    g: Graph,
    last: Option<String>,
}

impl Builder {
    fn push(mut self, op: Op) -> Builder {
        let id = format!("{}{}", op.name().to_lowercase(), self.g.nodes.len());
        let inputs = self.last.iter().cloned().collect();
        self.g.nodes.push(Node { id: id.clone(), op, inputs, seed: None });
        self.last = Some(id);
        self
    }

    /// Adds a node with explicit inputs (for DAGs); it becomes "last".
    pub fn node(mut self, id: &str, op: Op, inputs: &[&str]) -> Builder {
        self.g.nodes.push(Node { id: id.into(), op, inputs: inputs.iter().map(|s| s.to_string()).collect(), seed: None });
        self.last = Some(id.into());
        self
    }

    /// Renames the last node.
    pub fn id(mut self, id: &str) -> Builder {
        if let Some(last) = self.last.take() {
            for n in self.g.nodes.iter_mut() {
                if n.id == last {
                    n.id = id.into();
                }
                for i in n.inputs.iter_mut() {
                    if *i == last {
                        *i = id.into();
                    }
                }
            }
        }
        self.last = Some(id.into());
        self
    }

    /// Continues from an existing node.
    pub fn from(mut self, id: &str) -> Builder {
        self.last = Some(id.into());
        self
    }

    pub fn input(mut self, name: &str) -> Builder {
        self.last = None;
        self.push(Op::Input { name: name.into() }).id(name)
    }
    pub fn grid(self, spacing: f32, jitter: f32) -> Builder {
        self.push(Op::GridSample { spacing, jitter })
    }
    pub fn poisson(self, radius: f32) -> Builder {
        self.push(Op::PoissonSample { radius })
    }
    pub fn edges(self, spacing: f32, offset: f32, side: Side) -> Builder {
        self.push(Op::EdgeSample { spacing, offset, side })
    }
    pub fn rect_fill(self) -> Builder {
        self.push(Op::RectFill)
    }
    pub fn noise(self, scale: f32, lo: f32, hi: f32) -> Builder {
        self.push(Op::DensityNoise { scale, octaves: 3, lo, hi })
    }
    pub fn density(self, lo: f32, hi: f32) -> Builder {
        self.push(Op::DensityFilter { lo, hi })
    }
    pub fn keep(self, fraction: f32) -> Builder {
        self.push(Op::Keep { fraction })
    }
    pub fn difference(self, against: &str, pad: f32) -> Builder {
        self.push(Op::Difference { against: against.into(), pad })
    }
    pub fn intersect(self, with: &str, pad: f32) -> Builder {
        self.push(Op::Intersect { with: with.into(), pad })
    }
    pub fn prune(self, radius: f32) -> Builder {
        self.push(Op::SelfPrune { radius })
    }
    pub fn tags(self, tags: &[&str]) -> Builder {
        self.push(Op::ByTag { tags: tags.iter().map(|s| s.to_string()).collect(), keep: true })
    }
    pub fn transform(self, offset: Vec3, yaw: (f32, f32), scale: (f32, f32), jitter: f32) -> Builder {
        self.push(Op::Transform { offset, yaw, scale, jitter })
    }
    pub fn project(self, offset: f32, align: bool) -> Builder {
        self.push(Op::Project { offset, align })
    }
    pub fn spawn(self, items: &[(&str, f32)], tier: Tier) -> Builder {
        self.push(Op::Spawn(SpawnDef { items: items.iter().map(|(n, w)| (n.to_string(), *w)).collect(), tier, shadows: true, ..Default::default() }))
    }
    pub fn spawn_with(self, def: SpawnDef) -> Builder {
        self.push(Op::Spawn(def))
    }
    pub fn emit(self, port: &str) -> Builder {
        self.push(Op::Emit { port: port.into() })
    }

    pub fn finish(self) -> Result<Graph, PcgError> {
        self.g.validate()?;
        Ok(self.g)
    }
}
