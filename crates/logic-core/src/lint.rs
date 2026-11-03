//! `Graph::check`: everything the editor shows as errors. [`Graph::compile`] plus checks
//! against what exists in the game (script functions, control commands), which the core
//! can't know and the editor gets from the engine.

use crate::compile::{GraphError, Severity};
use crate::graph::{Graph, NodeKind};

/// A function found in a ruspy script.
#[derive(Clone, Debug, PartialEq)]
pub struct ScriptFn {
    /// File name, e.g. `score.ruspy`.
    pub file: String,
    pub function: String,
    pub args: Vec<String>,
}

/// What exists in the game.
#[derive(Clone, Debug, Default)]
pub struct Catalog {
    pub scripts: Vec<ScriptFn>,
    pub commands: Vec<String>,
}

fn base(file: &str) -> &str {
    file.rsplit('/').next().unwrap_or(file)
}

impl Graph {
    /// Compile errors and warnings, plus (with a catalog) missing script files / functions and
    /// unknown commands. Every entry names its node.
    pub fn check(&self, catalog: Option<&Catalog>) -> Vec<GraphError> {
        let mut out: Vec<GraphError> = match self.compile() {
            Ok(c) => c.warnings,
            Err(e) => e,
        };
        let Some(cat) = catalog else { return out };
        let err = |node: u32, message: String, severity| GraphError { severity, node: Some(node), pin: None, message };
        for n in &self.nodes {
            match &n.kind {
                NodeKind::Script { file, function, args } => {
                    let in_file: Vec<&ScriptFn> = cat.scripts.iter().filter(|s| s.file == base(file)).collect();
                    if !cat.scripts.iter().any(|s| s.file == base(file)) {
                        out.push(err(n.id, format!("script file `{file}` was not found in scripts/"), Severity::Error));
                    } else if let Some(f) = in_file.iter().find(|s| s.function == *function) {
                        if f.args.len() != args.len() {
                            out.push(err(n.id, format!("`{function}` takes {} argument(s), the node passes {}", f.args.len(), args.len()), Severity::Warning));
                        }
                    } else {
                        out.push(err(n.id, format!("file `{file}` has no function `{function}`"), Severity::Error));
                    }
                }
                NodeKind::Command { id, .. } if !cat.commands.is_empty() && !cat.commands.iter().any(|c| c == id) => {
                    out.push(err(n.id, format!("unknown command `{id}`"), Severity::Error));
                }
                _ => {}
            }
        }
        out
    }
}
