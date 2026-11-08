//! `is_class` and `super_call` (see `meta.rs` for `extends` / `class_name`).

use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{s, split, world};

pub(super) fn register(e: &mut Engine) {
    e.register("is_class", |c, a| {
        let w = world(c)?;
        let (t, r) = split(w, a, 1, "is_class([node,] class)")?;
        Ok(RV::Bool(super::is_class(w, t, s(&r[0], "class")?)))
    });
    // `super_call("f", args)` is rewritten to the base function at load; one that survives
    // has no base version to call.
    e.register("super_call", |_, a| {
        let name = a.first().map(|v| v.to_string()).unwrap_or_default();
        Err(format!("super_call(\"{name}\"): no base version (the script needs `// extends base.ruspy` and the base must define `{name}`; write the name as a string literal)"))
    });
}
