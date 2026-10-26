//! A small Fluent subset: what string tables for a game UI need, nothing more.
//!
//! ```text
//! # comment
//! menu-play = Play
//! hud-score = Score: { $score }          # `{ $n }` and `{n}` are both arguments
//! items = { $n ->
//!     [0] No items
//!     [one] One item
//!    *[other] { $n } items
//! }
//! long = First line
//!     second line (indented lines continue the value)
//! brace = Literal {"{"} brace
//! ```
//! Selectors match an exact number (`[0]`), then the language's plural category (`zero`,
//! `one`, `two`, `few`, `many`, `other`), then a string (`[male]`), else the `*` default.
//! Variants go one per line. Not supported: terms (`-brand`), message references,
//! attributes, functions.

use std::fmt::Write as _;

/// A runtime argument.
#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Int(i64),
    Float(f64),
    Str(String),
}

impl Arg {
    fn number(&self) -> Option<f64> {
        match self {
            Arg::Int(i) => Some(*i as f64),
            Arg::Float(f) => Some(*f),
            Arg::Str(s) => s.parse().ok(),
        }
    }
}

impl std::fmt::Display for Arg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Arg::Int(i) => write!(f, "{i}"),
            Arg::Float(x) => write!(f, "{x}"),
            Arg::Str(s) => f.write_str(s),
        }
    }
}

macro_rules! arg_from {
    ($($t:ty => $v:ident),*) => {$(impl From<$t> for Arg { fn from(x: $t) -> Self { Arg::$v(x as _) } })*};
}
arg_from!(i8 => Int, i16 => Int, i32 => Int, i64 => Int, u8 => Int, u16 => Int, u32 => Int, u64 => Int, usize => Int, isize => Int, f32 => Float, f64 => Float);
impl From<&str> for Arg {
    fn from(s: &str) -> Self {
        Arg::Str(s.to_string())
    }
}
impl From<String> for Arg {
    fn from(s: String) -> Self {
        Arg::Str(s)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plural {
    Zero,
    One,
    Two,
    Few,
    Many,
    Other,
}

impl Plural {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "zero" => Plural::Zero,
            "one" => Plural::One,
            "two" => Plural::Two,
            "few" => Plural::Few,
            "many" => Plural::Many,
            "other" => Plural::Other,
            _ => return None,
        })
    }
}

/// CLDR cardinal plural category (integers; fractions are `Other` except where noted) for the
/// languages a desktop game usually ships. Unknown languages use the English rule.
pub fn plural_category(lang: &str, n: f64) -> Plural {
    let base = lang.split(['-', '_']).next().unwrap_or(lang);
    let int = n.fract() == 0.0;
    let i = n.abs().trunc() as u64;
    let (m10, m100) = (i % 10, i % 100);
    match base {
        "ja" | "zh" | "ko" | "th" | "vi" | "id" | "ms" | "tr" => Plural::Other,
        "fr" | "pt" if lang != "pt-PT" => {
            if i <= 1 { Plural::One } else { Plural::Other }
        }
        "ru" | "uk" | "be" => {
            if !int {
                Plural::Other
            } else if m10 == 1 && m100 != 11 {
                Plural::One
            } else if (2..=4).contains(&m10) && !(12..=14).contains(&m100) {
                Plural::Few
            } else {
                Plural::Many
            }
        }
        "pl" => {
            if !int {
                Plural::Other
            } else if i == 1 {
                Plural::One
            } else if (2..=4).contains(&m10) && !(12..=14).contains(&m100) {
                Plural::Few
            } else {
                Plural::Many
            }
        }
        "cs" | "sk" => {
            if !int {
                Plural::Many
            } else if i == 1 {
                Plural::One
            } else if (2..=4).contains(&i) {
                Plural::Few
            } else {
                Plural::Other
            }
        }
        "ar" => match (int, i, m100) {
            (false, _, _) => Plural::Other,
            (_, 0, _) => Plural::Zero,
            (_, 1, _) => Plural::One,
            (_, 2, _) => Plural::Two,
            (_, _, 3..=10) => Plural::Few,
            (_, _, 11..=99) => Plural::Many,
            _ => Plural::Other,
        },
        _ => {
            if int && i == 1 { Plural::One } else { Plural::Other }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum VariantKey {
    Number(f64),
    Category(Plural),
    Str(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Segment {
    Text(String),
    Arg(String),
    Select { arg: String, variants: Vec<(VariantKey, Vec<Segment>)>, default: usize },
}

/// A parsed message value.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Message(pub Vec<Segment>);

impl Message {
    /// Plain text (no placeables)?
    pub fn as_plain(&self) -> Option<&str> {
        match self.0.as_slice() {
            [] => Some(""),
            [Segment::Text(t)] => Some(t),
            _ => None,
        }
    }

    /// Render with `args`; a missing argument renders as `{$name}`.
    pub fn format(&self, lang: &str, args: &[(&str, Arg)], out: &mut String) {
        format_segments(&self.0, lang, args, out);
    }

    /// Map every text segment (pseudo-localization).
    pub fn map_text(&self, f: &impl Fn(&str) -> String) -> Message {
        fn go(s: &[Segment], f: &impl Fn(&str) -> String) -> Vec<Segment> {
            s.iter()
                .map(|x| match x {
                    Segment::Text(t) => Segment::Text(f(t)),
                    Segment::Arg(a) => Segment::Arg(a.clone()),
                    Segment::Select { arg, variants, default } => Segment::Select {
                        arg: arg.clone(),
                        variants: variants.iter().map(|(k, v)| (k.clone(), go(v, f))).collect(),
                        default: *default,
                    },
                })
                .collect()
        }
        Message(go(&self.0, f))
    }

    /// Argument names used.
    pub fn args(&self) -> Vec<&str> {
        fn go<'a>(s: &'a [Segment], out: &mut Vec<&'a str>) {
            for x in s {
                match x {
                    Segment::Text(_) => {}
                    Segment::Arg(a) => out.push(a),
                    Segment::Select { arg, variants, .. } => {
                        out.push(arg);
                        for (_, v) in variants {
                            go(v, out);
                        }
                    }
                }
            }
        }
        let mut v = Vec::new();
        go(&self.0, &mut v);
        v.sort_unstable();
        v.dedup();
        v
    }
}

fn format_segments(segs: &[Segment], lang: &str, args: &[(&str, Arg)], out: &mut String) {
    let get = |name: &str| args.iter().find(|(k, _)| *k == name).map(|(_, v)| v);
    for s in segs {
        match s {
            Segment::Text(t) => out.push_str(t),
            Segment::Arg(a) => match get(a) {
                Some(v) => {
                    let _ = write!(out, "{v}");
                }
                None => {
                    let _ = write!(out, "{{${a}}}");
                }
            },
            Segment::Select { arg, variants, default } => {
                let v = get(arg);
                let num = v.and_then(Arg::number);
                let cat = num.map(|n| plural_category(lang, n));
                let pick = variants
                    .iter()
                    .position(|(k, _)| matches!(k, VariantKey::Number(x) if Some(*x) == num))
                    .or_else(|| variants.iter().position(|(k, _)| matches!(k, VariantKey::Category(c) if Some(*c) == cat)))
                    .or_else(|| match v {
                        Some(Arg::Str(s)) => variants.iter().position(|(k, _)| matches!(k, VariantKey::Str(x) if x == s)),
                        _ => None,
                    })
                    .unwrap_or(*default);
                if let Some((_, segs)) = variants.get(pick) {
                    format_segments(segs, lang, args, out);
                }
            }
        }
    }
}

/// A parse problem (line is 1-based).
#[derive(Clone, Debug, PartialEq)]
pub struct ParseError {
    pub line: usize,
    pub message: String,
}

/// Parse a whole file: messages in file order, and any errors (bad entries are skipped).
pub fn parse(src: &str) -> (Vec<(String, Message)>, Vec<ParseError>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    let lines: Vec<&str> = src.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            i += 1;
            continue;
        }
        if line.starts_with([' ', '\t']) {
            errors.push(ParseError { line: i + 1, message: "indented line outside a message".into() });
            i += 1;
            continue;
        }
        let Some((key, first)) = line.split_once('=') else {
            errors.push(ParseError { line: i + 1, message: format!("expected `key = value`, got `{t}`") });
            i += 1;
            continue;
        };
        let key = key.trim();
        let start = i;
        let mut value = first.trim_start().to_string();
        i += 1;
        // Continuation: indented lines, or a lone `}` closing a select.
        while i < lines.len() {
            let l = lines[i];
            let lt = l.trim();
            let indented = l.starts_with([' ', '\t']) && !lt.is_empty();
            if indented || lt == "}" {
                if !value.is_empty() {
                    value.push('\n');
                }
                value.push_str(lt);
                i += 1;
            } else if lt.is_empty() && lines.get(i + 1).is_some_and(|n| n.starts_with([' ', '\t']) && !n.trim().is_empty()) {
                value.push('\n');
                i += 1;
            } else {
                break;
            }
        }
        if !valid_key(key) {
            errors.push(ParseError { line: start + 1, message: format!("invalid key `{key}`") });
            continue;
        }
        match parse_pattern(&value) {
            Ok(m) => out.push((key.to_string(), m)),
            Err(e) => errors.push(ParseError { line: start + 1, message: format!("`{key}`: {e}") }),
        }
    }
    (out, errors)
}

fn valid_key(k: &str) -> bool {
    let mut c = k.chars();
    c.next().is_some_and(|f| f.is_ascii_alphabetic()) && c.all(|x| x.is_ascii_alphanumeric() || matches!(x, '-' | '_' | '.'))
}

/// Parse one value (may contain newlines).
pub fn parse_pattern(src: &str) -> Result<Message, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut pos = 0;
    let segs = pattern(&chars, &mut pos, false)?;
    if pos < chars.len() {
        return Err(format!("unexpected `{}`", chars[pos]));
    }
    Ok(Message(segs))
}

/// Text + placeables until the end, or (in a variant) until the end of the line / a `}`.
fn pattern(c: &[char], pos: &mut usize, variant: bool) -> Result<Vec<Segment>, String> {
    let mut segs = Vec::new();
    let mut text = String::new();
    while *pos < c.len() {
        let ch = c[*pos];
        if variant && (ch == '\n' || ch == '}') {
            break;
        }
        if ch == '{' {
            *pos += 1;
            if !text.is_empty() {
                segs.push(Segment::Text(std::mem::take(&mut text)));
            }
            segs.push(placeable(c, pos)?);
        } else if ch == '}' {
            return Err("unmatched `}`".into());
        } else {
            text.push(ch);
            *pos += 1;
        }
    }
    if variant {
        let trimmed = text.trim_end().len();
        text.truncate(trimmed);
    }
    if !text.is_empty() {
        segs.push(Segment::Text(text));
    }
    Ok(segs)
}

fn skip_ws(c: &[char], pos: &mut usize) {
    while *pos < c.len() && c[*pos].is_whitespace() {
        *pos += 1;
    }
}

fn ident(c: &[char], pos: &mut usize) -> String {
    let mut s = String::new();
    while *pos < c.len() && (c[*pos].is_alphanumeric() || matches!(c[*pos], '_' | '-' | '.')) {
        s.push(c[*pos]);
        *pos += 1;
    }
    s
}

/// After `{`.
fn placeable(c: &[char], pos: &mut usize) -> Result<Segment, String> {
    skip_ws(c, pos);
    let seg = if c.get(*pos) == Some(&'"') {
        *pos += 1;
        let mut s = String::new();
        loop {
            match c.get(*pos) {
                None => return Err("unterminated string literal".into()),
                Some('"') => {
                    *pos += 1;
                    break;
                }
                Some('\\') => {
                    if let Some(n) = c.get(*pos + 1) {
                        s.push(*n);
                    }
                    *pos += 2;
                }
                Some(ch) => {
                    s.push(*ch);
                    *pos += 1;
                }
            }
        }
        Segment::Text(s)
    } else {
        if c.get(*pos) == Some(&'$') {
            *pos += 1;
        }
        let name = ident(c, pos);
        if name.is_empty() {
            return Err("empty placeable".into());
        }
        skip_ws(c, pos);
        if c.get(*pos) == Some(&'-') && c.get(*pos + 1) == Some(&'>') {
            *pos += 2;
            return select(c, pos, name);
        }
        Segment::Arg(name)
    };
    skip_ws(c, pos);
    if c.get(*pos) != Some(&'}') {
        return Err("expected `}`".into());
    }
    *pos += 1;
    Ok(seg)
}

/// After `->`; consumes the closing `}`.
fn select(c: &[char], pos: &mut usize, arg: String) -> Result<Segment, String> {
    let mut variants = Vec::new();
    let mut default = None;
    loop {
        skip_ws(c, pos);
        match c.get(*pos) {
            None => return Err("unterminated select (missing `}`)".into()),
            Some('}') => {
                *pos += 1;
                break;
            }
            _ => {}
        }
        let is_default = c.get(*pos) == Some(&'*');
        if is_default {
            *pos += 1;
        }
        if c.get(*pos) != Some(&'[') {
            return Err("expected `[variant]`".into());
        }
        *pos += 1;
        skip_ws(c, pos);
        let mut key = String::new();
        while *pos < c.len() && c[*pos] != ']' {
            key.push(c[*pos]);
            *pos += 1;
        }
        if c.get(*pos) != Some(&']') {
            return Err("unterminated `[variant`".into());
        }
        *pos += 1;
        let key = key.trim();
        let vk = if let Ok(n) = key.parse::<f64>() {
            VariantKey::Number(n)
        } else if let Some(p) = Plural::parse(key) {
            VariantKey::Category(p)
        } else {
            VariantKey::Str(key.to_string())
        };
        while c.get(*pos).is_some_and(|x| *x == ' ' || *x == '\t') {
            *pos += 1;
        }
        let value = pattern(c, pos, true)?;
        if is_default {
            if default.is_some() {
                return Err("two `*` defaults".into());
            }
            default = Some(variants.len());
        }
        variants.push((vk, value));
    }
    let default = default.ok_or("select needs a `*[default]` variant")?;
    Ok(Segment::Select { arg, variants, default })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(m: &Message, lang: &str, args: &[(&str, Arg)]) -> String {
        let mut s = String::new();
        m.format(lang, args, &mut s);
        s
    }

    #[test]
    fn parses_messages_args_and_selects() {
        let src = "# header\nhello = Hello, { $name }!\nshort = Hi {name}\n\nitems = { $n ->\n    [0] No items\n    [one] One item\n   *[other] { $n } items\n}\nlong = First\n    second\nbrace = a {\"{\"} b\nbad line\n  stray\n9bad = x\n";
        let (msgs, errs) = parse(src);
        let get = |k: &str| msgs.iter().find(|(x, _)| x == k).map(|(_, m)| m).unwrap();
        assert_eq!(fmt(get("hello"), "en", &[("name", "Ana".into())]), "Hello, Ana!");
        assert_eq!(fmt(get("short"), "en", &[("name", "Bo".into())]), "Hi Bo");
        let items = get("items");
        assert_eq!(fmt(items, "en", &[("n", 0.into())]), "No items");
        assert_eq!(fmt(items, "en", &[("n", 1.into())]), "One item");
        assert_eq!(fmt(items, "en", &[("n", 7.into())]), "7 items");
        assert_eq!(fmt(items, "en", &[]), "{$n} items", "missing arg → default variant, placeholder");
        assert_eq!(fmt(get("long"), "en", &[]), "First\nsecond");
        assert_eq!(fmt(get("brace"), "en", &[]), "a { b");
        assert_eq!(items.args(), vec!["n"]);
        assert_eq!(errs.len(), 3, "{errs:?}");
        assert!(get("hello").as_plain().is_none());
    }

    #[test]
    fn select_errors() {
        assert!(parse_pattern("{ $n -> [one] x }").is_err(), "needs a default");
        assert!(parse_pattern("{ $n ").is_err());
        assert!(parse_pattern("a } b").is_err());
        let m = parse_pattern("{ $g -> [male] He\n *[other] They\n}").unwrap();
        assert_eq!(fmt(&m, "en", &[("g", "male".into())]), "He");
        assert_eq!(fmt(&m, "en", &[("g", "x".into())]), "They");
    }

    #[test]
    fn plural_rules() {
        assert_eq!(plural_category("en", 1.0), Plural::One);
        assert_eq!(plural_category("en", 0.0), Plural::Other);
        assert_eq!(plural_category("en", 1.5), Plural::Other);
        assert_eq!(plural_category("fr", 0.0), Plural::One);
        assert_eq!(plural_category("fr", 1.7), Plural::One);
        assert_eq!(plural_category("ru", 21.0), Plural::One);
        assert_eq!(plural_category("ru", 22.0), Plural::Few);
        assert_eq!(plural_category("ru", 12.0), Plural::Many);
        assert_eq!(plural_category("pl", 5.0), Plural::Many);
        assert_eq!(plural_category("ja", 1.0), Plural::Other);
        assert_eq!(plural_category("ar", 2.0), Plural::Two);
        assert_eq!(plural_category("de-AT", 1.0), Plural::One);
    }
}
