//! Script editor assists: completion candidates, call signatures and hover docs. Pure text and
//! catalogue logic (the egui side is in `script_tab`), so it is unit tested without a window.

use editor_proto::{ApiFn, ScriptOutline};

use super::script_tab::KEYWORDS;

/// One completion row.
#[derive(Clone, Debug, PartialEq)]
pub struct Cand {
    pub label: String,
    /// Text put in the editor (functions get their `(`).
    pub insert: String,
    /// Right-hand hint: the signature, `fn`, `var`, `keyword`.
    pub detail: String,
    pub doc: String,
}

pub const MAX_CANDS: usize = 10;

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The identifier being typed ending at char index `cursor`: `(start, prefix)`.
pub fn word_before(text: &str, cursor: usize) -> (usize, String) {
    let chars: Vec<char> = text.chars().collect();
    let end = cursor.min(chars.len());
    let mut start = end;
    while start > 0 && is_word(chars[start - 1]) {
        start -= 1;
    }
    (start, chars[start..end].iter().collect())
}

/// The whole identifier around char index `at`, if any.
pub fn word_at(text: &str, at: usize) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let at = at.min(chars.len());
    let mut a = at;
    while a > 0 && is_word(chars[a - 1]) {
        a -= 1;
    }
    let mut b = at;
    while b < chars.len() && is_word(chars[b]) {
        b += 1;
    }
    (b > a && !chars[a].is_ascii_digit()).then(|| chars[a..b].iter().collect())
}

fn sig_of_fn(name: &str, outline: &ScriptOutline) -> Option<String> {
    outline.fns.iter().find(|f| f.name == name).map(|f| format!("fn {}({})", f.name, f.params.join(", ")))
}

/// Candidates for `prefix`: the script's own functions and variables, then host functions, then
/// keywords. Case-insensitive prefix match, then substring matches; an empty prefix lists everything.
pub fn candidates(prefix: &str, api: &[ApiFn], outline: &ScriptOutline) -> Vec<Cand> {
    let p = prefix.to_lowercase();
    let mut all: Vec<Cand> = vec![];
    for f in &outline.fns {
        all.push(Cand { label: f.name.clone(), insert: format!("{}(", f.name), detail: sig_of_fn(&f.name, outline).unwrap_or_default(), doc: "Defined in this script".into() });
    }
    for v in &outline.vars {
        all.push(Cand { label: v.clone(), insert: v.clone(), detail: "var".into(), doc: "Member of this script".into() });
    }
    for a in api.iter().filter(|a| !a.name.contains('.')) {
        let call = a.sig.starts_with(&format!("{}(", a.name));
        all.push(Cand { label: a.name.clone(), insert: if call { format!("{}(", a.name) } else { a.name.clone() }, detail: a.sig.clone(), doc: a.doc.clone() });
    }
    for k in KEYWORDS {
        all.push(Cand { label: (*k).into(), insert: (*k).into(), detail: "keyword".into(), doc: String::new() });
    }
    let mut seen = std::collections::HashSet::new();
    all.retain(|c| seen.insert(c.label.clone()));
    let starts: Vec<Cand> = all.iter().filter(|c| c.label.to_lowercase().starts_with(&p)).cloned().collect();
    let mut out = starts;
    if !p.is_empty() {
        out.extend(all.iter().filter(|c| !c.label.to_lowercase().starts_with(&p) && c.label.to_lowercase().contains(&p)).cloned());
        // Typing a finished name needs no popup.
        if out.len() == 1 && out[0].label.to_lowercase() == p {
            out.clear();
        }
    }
    out.truncate(MAX_CANDS);
    out
}

/// The call the cursor is inside: `(function name, index of the argument being typed)`.
pub fn call_context(text: &str, cursor: usize) -> Option<(String, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let end = cursor.min(chars.len());
    let (mut depth, mut commas) = (0usize, 0usize);
    let mut i = end;
    let mut in_str = false;
    // Walk back to the unmatched `(`; strings are not tracked backwards precisely, so skip quotes in pairs.
    while i > 0 {
        i -= 1;
        match chars[i] {
            '"' => in_str = !in_str,
            _ if in_str => {}
            ')' | ']' => depth += 1,
            '[' if depth > 0 => depth -= 1,
            '(' if depth > 0 => depth -= 1,
            '(' => {
                let mut a = i;
                while a > 0 && is_word(chars[a - 1]) {
                    a -= 1;
                }
                return (a < i).then(|| (chars[a..i].iter().collect(), commas));
            }
            ',' if depth == 0 => commas += 1,
            ';' | '{' | '}' if depth == 0 => return None,
            _ => {}
        }
    }
    None
}

/// Signature and doc for a name: the script's own function, or a host function.
pub fn describe(name: &str, api: &[ApiFn], outline: &ScriptOutline) -> Option<(String, String)> {
    if let Some(sig) = sig_of_fn(name, outline) {
        return Some((sig, "Defined in this script".into()));
    }
    if outline.vars.iter().any(|v| v == name) {
        return Some((format!("var {name}"), "Member of this script".into()));
    }
    api.iter().find(|a| a.name == name).map(|a| (a.sig.clone(), a.doc.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_proto::ScriptFn;

    fn api() -> Vec<ApiFn> {
        vec![
            ApiFn { name: "get_node".into(), sig: "get_node([node,] path)".into(), doc: "Resolve a path.".into() },
            ApiFn { name: "get_name".into(), sig: "get_name([node])".into(), doc: "Name.".into() },
            ApiFn { name: "CONNECT_DEFERRED".into(), sig: "CONNECT_DEFERRED".into(), doc: "Flag.".into() },
        ]
    }
    fn outline() -> ScriptOutline {
        ScriptOutline { vars: vec!["speed".into()], fns: vec![ScriptFn { name: "get_speed".into(), params: vec!["scale".into()] }] }
    }

    #[test]
    fn prefix_lists_own_names_first_then_host_functions() {
        let c = candidates("get_", &api(), &outline());
        let labels: Vec<_> = c.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["get_speed", "get_node", "get_name"]);
        assert_eq!(c[0].insert, "get_speed(");
        assert_eq!(c[0].detail, "fn get_speed(scale)");
        assert_eq!(c[1].detail, "get_node([node,] path)");
        assert!(candidates("spe", &api(), &outline()).iter().any(|c| c.label == "speed" && c.insert == "speed"));
        assert_eq!(candidates("CONNECT_D", &api(), &outline())[0].insert, "CONNECT_DEFERRED", "constants take no paren");
        assert!(candidates("ret", &api(), &outline()).iter().any(|c| c.detail == "keyword"));
    }

    #[test]
    fn exact_names_and_unknown_prefixes_show_nothing() {
        assert!(candidates("get_node", &api(), &outline()).len() <= 1 && candidates("get_node", &api(), &outline()).iter().all(|c| c.label != "get_node"));
        assert!(candidates("zzz", &api(), &outline()).is_empty());
    }

    #[test]
    fn word_before_and_at() {
        let t = "x = get_na(1);";
        assert_eq!(word_before(t, 10), (4, "get_na".into()));
        assert_eq!(word_before(t, 3), (3, String::new()));
        assert_eq!(word_at(t, 6).as_deref(), Some("get_na"));
        assert_eq!(word_at(t, 2), None);
    }

    #[test]
    fn call_context_finds_function_and_argument() {
        let t = "fn f() { connect(btn, \"pressed\", sel";
        assert_eq!(call_context(t, t.chars().count()), Some(("connect".into(), 2)));
        let t = "foo(bar(1, 2), 3, ";
        assert_eq!(call_context(t, t.len()), Some(("foo".into(), 2)));
        let t = "x = [1, 2], ";
        assert_eq!(call_context(t, t.len()), None);
        assert_eq!(call_context("log(1); ", 8), None);
    }

    #[test]
    fn describe_prefers_the_scripts_own_definition() {
        assert_eq!(describe("get_speed", &api(), &outline()).unwrap().0, "fn get_speed(scale)");
        assert_eq!(describe("get_node", &api(), &outline()).unwrap().1, "Resolve a path.");
        assert!(describe("nope", &api(), &outline()).is_none());
    }
}
