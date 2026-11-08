//! Script metadata read from the source text: `@export_*` / `@tooltip` comment annotations above
//! top-level variables (Godot's `@export_range` and friends), their literal defaults, and the
//! `// extends` / `// class_name` header. Parsed by the engine, not by ruspy: annotations are
//! plain comments so the language needs no change.
//!
//! ```text
//! // @export_range(0, 10, 0.5)
//! // @tooltip Metres per second
//! speed = 5;
//! // @export_enum("easy", "hard")
//! mode = "easy";
//! _cache = 0;            // leading `_`: private, not listed
//! ```

use serde::{Deserialize, Serialize};

/// How an exported variable is edited.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportHint {
    #[default]
    None,
    Range { min: f64, max: f64, step: f64 },
    Enum { options: Vec<String> },
    Color,
    File { filter: String },
}

/// One exported (non-private) top-level variable.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PropInfo {
    pub name: String,
    /// The literal text of the default (`5`, `"easy"`), empty when not a literal.
    pub default: String,
    pub hint: ExportHint,
    pub tooltip: String,
}

/// `name = literal;` lines at the top level: `(name, literal text)`. Non-literal right-hand sides
/// give an empty default.
pub fn scan_defaults(src: &str) -> Vec<(String, String)> {
    src.lines()
        .filter_map(|l| {
            if l.starts_with(char::is_whitespace) || l.starts_with("//") {
                return None;
            }
            let (name, rhs) = l.split_once('=')?;
            let name = name.trim();
            if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') || rhs.starts_with('=') {
                return None;
            }
            let rhs = rhs.split("//").next().unwrap_or("").trim().trim_end_matches(';').trim();
            let literal = rhs.starts_with(|c: char| c.is_ascii_digit() || matches!(c, '-' | '"' | '\'' | '['))
                || matches!(rhs, "true" | "false" | "null" | "nil" | "None");
            Some((name.to_string(), if literal { rhs.to_string() } else { String::new() }))
        })
        .collect()
}

/// Splits `a, "b, c", 3` at top-level commas; strips quotes from strings.
fn split_args(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in s.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => quote = Some(c),
            (None, ',') => out.push(std::mem::take(&mut cur).trim().to_string()),
            (None, c) => cur.push(c),
        }
    }
    if !cur.trim().is_empty() || !out.is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// One annotation line (after `//`): updates the pending hint / tooltip.
fn annotate(text: &str, hint: &mut ExportHint, tip: &mut String) {
    let t = text.trim();
    let Some(a) = t.strip_prefix('@') else { return };
    if let Some(rest) = a.strip_prefix("tooltip") {
        *tip = rest.trim().to_string();
        return;
    }
    let (name, args) = match a.split_once('(') {
        Some((n, r)) => (n.trim(), split_args(r.rsplit_once(')').map_or(r, |x| x.0))),
        None => (a.trim(), vec![]),
    };
    let num = |i: usize, d: f64| args.get(i).and_then(|x| x.parse::<f64>().ok()).unwrap_or(d);
    match name {
        "export_range" => *hint = ExportHint::Range { min: num(0, 0.0), max: num(1, 1.0), step: num(2, 0.0) },
        "export_enum" => *hint = ExportHint::Enum { options: args },
        "export_color" | "export_color_no_alpha" => *hint = ExportHint::Color,
        "export_file" => *hint = ExportHint::File { filter: args.first().cloned().unwrap_or_default() },
        _ => {}
    }
}

/// The exported variables of `src` in declaration order (`vars` from the ruspy outline; `_x` private
/// ones are left out).
pub fn scan_props(src: &str, vars: &[String]) -> Vec<PropInfo> {
    let defaults = scan_defaults(src);
    let mut hints: Vec<(String, ExportHint, String)> = vec![];
    let (mut hint, mut tip) = (ExportHint::None, String::new());
    for l in src.lines() {
        if let Some(c) = l.strip_prefix("//") {
            annotate(c, &mut hint, &mut tip);
            continue;
        }
        if l.trim().is_empty() {
            continue;
        }
        if let Some((name, _)) = l.split_once('=')
            && !l.starts_with(char::is_whitespace)
            && !name.trim().is_empty()
        {
            hints.push((name.trim().to_string(), std::mem::take(&mut hint), std::mem::take(&mut tip)));
        } else {
            hint = ExportHint::None;
            tip.clear();
        }
    }
    vars.iter()
        .filter(|n| !n.starts_with('_'))
        .map(|n| {
            let (h, t) = hints.iter().rev().find(|(x, ..)| x == n).map(|(_, h, t)| (h.clone(), t.clone())).unwrap_or_default();
            PropInfo { name: n.clone(), default: defaults.iter().rev().find(|(d, _)| d == n).map(|(_, v)| v.clone()).unwrap_or_default(), hint: h, tooltip: t }
        })
        .collect()
}

/// `// extends base.ruspy` and `// class_name Foo` header comments.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Header {
    pub extends: Option<String>,
    pub class_name: Option<String>,
}

/// Reads the header: only comment lines before the first code line count.
pub fn scan_header(src: &str) -> Header {
    let mut h = Header::default();
    for l in src.lines() {
        let t = l.trim();
        if t.is_empty() {
            continue;
        }
        let Some(c) = t.strip_prefix("//") else { break };
        let c = c.trim();
        if let Some(r) = c.strip_prefix("extends ") {
            h.extends = Some(r.trim().trim_matches(['"', '\'']).to_string());
        } else if let Some(r) = c.strip_prefix("class_name ") {
            h.class_name = Some(r.trim().to_string());
        }
    }
    h
}

/// A script with its `extends` chain spliced in.
#[derive(Debug, Default)]
pub struct Composed {
    pub text: String,
    /// Derived first: `(key, class_name)` of the script and each base.
    pub chain: Vec<(String, Option<String>)>,
    /// Files the text depends on (the bases) for hot reload.
    pub deps: Vec<String>,
}

/// Renames the col-0 `fn name(` definitions in `names` to `__L<level>_<name>` and resolves
/// `super_call("f", args)` to the nearest lower level's renamed `f`.
fn rewrite(src: &str, level: usize, rename: &[String], lower: &[Vec<String>]) -> String {
    let mut out = String::with_capacity(src.len() + 64);
    for l in src.lines() {
        let mut line = l.to_string();
        if let Some(rest) = l.strip_prefix("fn ") {
            let name: String = rest.trim_start().chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            if rest.trim_start()[name.len()..].trim_start().starts_with('(') && rename.contains(&name) {
                line = format!("fn __L{level}_{name}{}", &rest.trim_start()[name.len()..]);
            }
        }
        while let Some(i) = line.find("super_call(") {
            let after = &line[i + "super_call(".len()..];
            let a = after.trim_start();
            let Some(q) = a.chars().next().filter(|c| matches!(c, '"' | '\'')) else { break };
            let Some(end) = a[1..].find(q) else { break };
            let f = &a[1..1 + end];
            let Some(j) = (0..level).rev().find(|j| lower[*j].iter().any(|n| n == f)) else { break };
            let mut rest = a[end + 2..].trim_start();
            if let Some(r) = rest.strip_prefix(',') {
                rest = r.trim_start();
            }
            line = format!("{}__L{j}_{f}({rest}", &line[..i]);
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// Reads `key` and its `extends` chain through `read` (key → text), base first in the result.
pub fn compose(key: &str, text: &str, read: &dyn Fn(&str) -> Result<String, String>) -> Result<Composed, String> {
    let mut levels: Vec<(String, String)> = vec![(key.to_string(), text.to_string())];
    let mut deps = vec![];
    loop {
        let (k, t) = levels.last().unwrap();
        let Some(base) = scan_header(t).extends else { break };
        let bk = if base.contains('/') { base } else { format!("scripts/{base}") };
        if levels.iter().any(|(x, _)| *x == bk) || levels.len() > 8 {
            return Err(format!("{k}: extends cycle through {bk}"));
        }
        let bt = read(&bk).map_err(|e| format!("{k}: extends {bk}: {e}"))?;
        deps.push(bk.clone());
        levels.push((bk, bt));
    }
    levels.reverse(); // base first
    let chain = levels.iter().rev().map(|(k, t)| (k.clone(), scan_header(t).class_name)).collect();
    if levels.len() == 1 {
        return Ok(Composed { text: levels.pop().unwrap().1, chain, deps });
    }
    let fns: Vec<Vec<String>> = levels.iter().map(|(_, t)| ruspy::embed::outline(t).fns.into_iter().map(|(n, _)| n).collect()).collect();
    let mut text = String::new();
    for (i, (_, t)) in levels.iter().enumerate() {
        let higher: Vec<String> = fns[i + 1..].iter().flatten().cloned().collect();
        let rename: Vec<String> = fns[i].iter().filter(|n| higher.contains(n)).cloned().collect();
        text.push_str(&rewrite(t, i, &rename, &fns));
    }
    Ok(Composed { text, chain, deps })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotations_attach_to_the_next_variable() {
        let src = "// @export_range(0, 10, 0.5)\n// @tooltip Metres per second\nspeed = 5;\n// @export_enum(\"easy\", \"hard, hmm\")\nmode = \"easy\";\n// @export_color\ntint = [1, 0, 0];\n// @export_file(\"*.ruspy\")\nscript = \"\";\n_cache = 0;\nplain = 3; // note\n";
        let vars: Vec<String> = ["speed", "mode", "tint", "script", "_cache", "plain"].iter().map(|s| s.to_string()).collect();
        let p = scan_props(src, &vars);
        assert_eq!(p.len(), 5, "private var is left out");
        assert_eq!(p[0].hint, ExportHint::Range { min: 0.0, max: 10.0, step: 0.5 });
        assert_eq!((p[0].tooltip.as_str(), p[0].default.as_str()), ("Metres per second", "5"));
        assert_eq!(p[1].hint, ExportHint::Enum { options: vec!["easy".into(), "hard, hmm".into()] });
        assert_eq!(p[2].hint, ExportHint::Color);
        assert_eq!(p[3].hint, ExportHint::File { filter: "*.ruspy".into() });
        assert_eq!((p[4].hint.clone(), p[4].tooltip.as_str()), (ExportHint::None, ""));
    }

    #[test]
    fn extends_splices_bases_and_resolves_super_calls() {
        let read = |k: &str| -> Result<String, String> {
            match k {
                "scripts/a.ruspy" => Ok("// class_name A\nhp = 1;\nfn hit() { return 1; }\nfn only_a() { return 5; }\n".into()),
                "scripts/b.ruspy" => Ok("// extends a.ruspy\nhp = 2;\nfn hit() { return super_call(\"hit\") + 10; }\n".into()),
                _ => Err("missing".into()),
            }
        };
        let c = compose("scripts/c.ruspy", "// extends b.ruspy\nfn hit() { return super_call(\"hit\", 1) + 100; }\n", &read).unwrap();
        assert!(c.text.contains("fn __L0_hit("), "{}", c.text);
        assert!(c.text.contains("fn __L1_hit("));
        assert!(c.text.contains("__L1_hit(1) + 100"), "{}", c.text);
        assert!(c.text.contains("__L0_hit() + 10"));
        assert!(c.text.contains("fn only_a("));
        assert_eq!(c.chain.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["scripts/c.ruspy", "scripts/b.ruspy", "scripts/a.ruspy"]);
        assert_eq!(c.chain[2].1.as_deref(), Some("A"));
        assert!(compose("scripts/x.ruspy", "// extends nope.ruspy\n", &read).is_err());
    }

    #[test]
    fn header_comments_name_the_base_and_class() {
        let h = scan_header("// class_name Enemy\n// extends \"base.ruspy\"\n\nx = 1;\n// extends nope\n");
        assert_eq!((h.extends.as_deref(), h.class_name.as_deref()), (Some("base.ruspy"), Some("Enemy")));
    }
}
