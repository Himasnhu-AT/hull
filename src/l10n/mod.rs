//! Localization (feature `l10n`). Docs: `docs/L10N.md`.
//!
//! - String tables are small text files, one per language: the engine's own (embedded,
//!   `assets/locale/*.ftl` of this crate) and the game's `<assets>/locale/<lang>.ftl` (read at
//!   startup; the game's keys win). Format: a Fluent subset ([`ftl`]): `key = value`,
//!   `{ $n }` / `{n}` arguments, plural / exact-number / string selects.
//! - [`Locale`] holds every table, the current language and the fallback ("en"). Missing in the
//!   current language → the fallback's text; missing everywhere → the key itself. Every miss is
//!   recorded ([`Locale::missing`], control `l10n.missing`).
//! - `pseudo`: a generated language (accented, ~30 % longer, bracketed) to find untranslated
//!   strings and layouts that overflow.
//! - Switch any time: [`Locale::set`], the "Language" row (settings "Interface" tab), `--lang
//!   <code>`, or control `l10n.set {lang}`. Saved in settings.json section `"locale"`.
//!
//! API: [`tr`]`("key")`, [`tr_args`]`("key", &[("n", 3)])`, [`tr_with`] for mixed argument
//! types, and the [`Tr`] component (with a `Text`) that re-localizes when the language
//! changes. Engine screens translate their literals ([`tr_literal`]: fallback text → key →
//! current language) and are rebuilt on a switch.

pub mod ftl;

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

use bevy::platform::collections::HashMap;
use bevy::prelude::*;
use serde::{Deserialize, Serialize};

pub use ftl::{Arg, Message, ParseError};

use crate::settings::{FieldDef, FieldKind, RegisterSettings};

/// The engine's own tables (menus, settings, pause, controls, accessibility).
pub const ENGINE_TABLES: &[(&str, &str)] = &[
    ("en", include_str!("../../assets/locale/en.ftl")),
    ("de", include_str!("../../assets/locale/de.ftl")),
    ("fr", include_str!("../../assets/locale/fr.ftl")),
];

/// The generated test language.
pub const PSEUDO: &str = "pseudo";

/// One language's messages.
#[derive(Clone, Debug, Default)]
pub struct Bundle {
    pub lang: String,
    pub messages: HashMap<String, Message>,
}

/// All tables + the current language. `Res<Locale>` for reading; mutate through its methods
/// (they keep [`tr`]'s global view in sync).
#[derive(Resource, Debug)]
pub struct Locale {
    lang: String,
    fallback: String,
    bundles: BTreeMap<String, Arc<Bundle>>,
    /// Parse problems: "de.ftl:12: ...".
    pub errors: Vec<String>,
    generation: u32,
    /// This is the locale [`tr`] reads (the plugin's). Other instances (tests, tools) don't
    /// touch the global view.
    global: bool,
}

/// Language saved in settings.json (`"locale": {"lang": "de"}`); empty = the system language.
#[derive(Resource, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LocaleSettings {
    pub lang: String,
}

struct Snapshot {
    lang: String,
    current: Arc<Bundle>,
    fallback: Arc<Bundle>,
    /// Fallback plain text → key (for [`tr_literal`]).
    literal: HashMap<String, String>,
}

static CURRENT: RwLock<Option<Arc<Snapshot>>> = RwLock::new(None);
static MISSING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn snapshot() -> Option<Arc<Snapshot>> {
    CURRENT.read().ok().and_then(|g| g.clone())
}

fn note_missing(lang: &str, key: &str) {
    if let Ok(mut m) = MISSING.lock()
        && m.len() < 4096
    {
        m.insert(format!("{lang}:{key}"));
    }
}

impl Default for Locale {
    fn default() -> Self {
        Locale { lang: "en".into(), fallback: "en".into(), bundles: BTreeMap::new(), errors: Vec::new(), generation: 0, global: false }
    }
}

impl Locale {
    /// Empty locale with `fallback` as the fallback and current language.
    pub fn new(fallback: &str) -> Self {
        Locale { lang: fallback.into(), fallback: fallback.into(), ..default() }
    }

    /// Engine tables + every `<dir>/<lang>.ftl` (the game's win), plus `pseudo`.
    pub fn load(fallback: &str, dir: Option<&Path>) -> Self {
        let mut l = Locale::new(fallback);
        for (lang, src) in ENGINE_TABLES {
            l.add_table(lang, src, &format!("engine:{lang}.ftl"));
        }
        if let Some(dir) = dir {
            l.load_dir(dir);
        }
        l.rebuild_pseudo();
        l
    }

    /// Read `<dir>/*.ftl` (file stem = language code).
    pub fn load_dir(&mut self, dir: &Path) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut files: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "ftl")).collect();
        files.sort();
        for p in files {
            let Some(lang) = p.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
            match std::fs::read_to_string(&p) {
                Ok(src) => self.add_table(&lang, &src, &p.display().to_string()),
                Err(e) => self.errors.push(format!("{}: {e}", p.display())),
            }
        }
    }

    /// Merge a table (later tables override earlier keys). `origin` names it in errors.
    pub fn add_table(&mut self, lang: &str, src: &str, origin: &str) {
        let (msgs, errs) = ftl::parse(src);
        for e in errs {
            self.errors.push(format!("{origin}:{}: {}", e.line, e.message));
        }
        let b = self.bundles.entry(lang.to_string()).or_insert_with(|| Arc::new(Bundle { lang: lang.into(), messages: HashMap::new() }));
        let b = Arc::make_mut(b);
        for (k, m) in msgs {
            b.messages.insert(k, m);
        }
        if lang == self.fallback {
            self.rebuild_pseudo();
        }
        self.publish();
    }

    fn rebuild_pseudo(&mut self) {
        let Some(fb) = self.bundles.get(&self.fallback).cloned() else { return };
        let messages = fb.messages.iter().map(|(k, m)| (k.clone(), pseudo_message(m))).collect();
        self.bundles.insert(PSEUDO.into(), Arc::new(Bundle { lang: PSEUDO.into(), messages }));
    }

    pub fn lang(&self) -> &str {
        &self.lang
    }
    pub fn fallback(&self) -> &str {
        &self.fallback
    }
    /// Bumped on every language or table change.
    pub fn generation(&self) -> u32 {
        self.generation
    }
    /// Language codes with a table (sorted, `pseudo` last).
    pub fn languages(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.bundles.keys().map(String::as_str).filter(|l| *l != PSEUDO).collect();
        if self.bundles.contains_key(PSEUDO) {
            v.push(PSEUDO);
        }
        v
    }
    /// "Deutsch" (the table's `language-name`), else the code.
    pub fn language_name(&self, lang: &str) -> String {
        if lang == PSEUDO {
            return "Pseudo".into();
        }
        self.bundles.get(lang).and_then(|b| b.messages.get("language-name")).and_then(|m| m.as_plain()).map_or_else(|| lang.to_string(), str::to_string)
    }

    /// Switch language. Unknown codes are an error ("de-AT" falls back to "de").
    pub fn set(&mut self, lang: &str) -> Result<(), String> {
        let code = if self.bundles.contains_key(lang) {
            lang.to_string()
        } else {
            let base = lang.split(['-', '_']).next().unwrap_or(lang).to_ascii_lowercase();
            if self.bundles.contains_key(&base) {
                base
            } else {
                return Err(format!("no table for `{lang}` (have: {})", self.languages().join(", ")));
            }
        };
        if code != self.lang {
            self.lang = code;
            self.publish();
        }
        Ok(())
    }

    /// Reload the game's tables from `dir` (engine tables stay), keeping the language.
    pub fn reload(&mut self, dir: Option<&Path>) {
        let lang = self.lang.clone();
        *self = Locale { generation: self.generation, global: self.global, ..Locale::load(&self.fallback, dir) };
        let _ = self.set(&lang);
        self.publish();
    }

    fn bundle(&self, lang: &str) -> Option<&Bundle> {
        self.bundles.get(lang).map(|b| &**b)
    }

    pub fn has(&self, key: &str) -> bool {
        self.bundle(&self.lang).is_some_and(|b| b.messages.contains_key(key)) || self.bundle(&self.fallback).is_some_and(|b| b.messages.contains_key(key))
    }

    /// Translate `key` in the current language (→ fallback → the key).
    pub fn tr(&self, key: &str) -> String {
        self.tr_with(key, &[])
    }
    pub fn tr_with(&self, key: &str, args: &[(&str, Arg)]) -> String {
        render(&self.lang, self.bundle(&self.lang), self.bundle(&self.fallback), key, args)
    }

    /// Keys used at runtime but missing ("lang:key"), keys of the fallback each language lacks,
    /// keys a language has that the fallback doesn't, and parse errors.
    pub fn missing(&self) -> MissingReport {
        let runtime = MISSING.lock().map(|m| m.iter().cloned().collect()).unwrap_or_default();
        let mut untranslated = BTreeMap::new();
        let mut orphans = BTreeMap::new();
        if let Some(fb) = self.bundle(&self.fallback) {
            for (lang, b) in &self.bundles {
                if *lang == self.fallback || lang == PSEUDO {
                    continue;
                }
                let mut miss: Vec<String> = fb.messages.keys().filter(|k| !b.messages.contains_key(*k) && *k != "language-name").cloned().collect();
                miss.sort();
                let mut extra: Vec<String> = b.messages.keys().filter(|k| !fb.messages.contains_key(*k) && *k != "language-name").cloned().collect();
                extra.sort();
                untranslated.insert(lang.clone(), miss);
                if !extra.is_empty() {
                    orphans.insert(lang.clone(), extra);
                }
            }
        }
        MissingReport { runtime, untranslated, orphans, errors: self.errors.clone() }
    }

    /// Forget the runtime misses recorded so far.
    pub fn clear_missing() {
        if let Ok(mut m) = MISSING.lock() {
            m.clear();
        }
    }

    /// Make this the locale [`tr`] / [`tr_literal`] read (the plugin does this).
    pub fn make_global(&mut self) {
        self.global = true;
        self.publish();
    }

    fn publish(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if !self.global {
            return;
        }
        let empty = || Arc::new(Bundle::default());
        let fallback = self.bundles.get(&self.fallback).cloned().unwrap_or_else(empty);
        let current = self.bundles.get(&self.lang).cloned().unwrap_or_else(|| fallback.clone());
        let mut literal = HashMap::new();
        for (k, m) in &fallback.messages {
            if let Some(t) = m.as_plain()
                && !t.is_empty()
            {
                // Several keys with the same English text translate the same; keep the first.
                literal.entry(t.to_string()).or_insert_with(|| k.clone());
            }
        }
        let snap = Snapshot { lang: self.lang.clone(), current, fallback, literal };
        if let Ok(mut g) = CURRENT.write() {
            *g = Some(Arc::new(snap));
        }
    }
}

/// What `l10n.missing` reports.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MissingReport {
    pub runtime: Vec<String>,
    pub untranslated: BTreeMap<String, Vec<String>>,
    pub orphans: BTreeMap<String, Vec<String>>,
    pub errors: Vec<String>,
}

fn render(lang: &str, current: Option<&Bundle>, fallback: Option<&Bundle>, key: &str, args: &[(&str, Arg)]) -> String {
    let (msg, used) = match current.and_then(|b| b.messages.get(key)) {
        Some(m) => (Some(m), lang),
        None => {
            note_missing(lang, key);
            (fallback.and_then(|b| b.messages.get(key)), fallback.map_or(lang, |b| b.lang.as_str()))
        }
    };
    match msg {
        Some(m) => {
            if args.is_empty()
                && let Some(t) = m.as_plain()
            {
                return t.to_string();
            }
            let mut s = String::new();
            m.format(used, args, &mut s);
            s
        }
        None => key.to_string(),
    }
}

/// Translate `key` in the current language (fallback, then the key itself).
pub fn tr(key: &str) -> String {
    tr_with(key, &[])
}

/// With arguments of one type: `tr_args("items", &[("n", 3)])`.
pub fn tr_args<V: Into<Arg> + Clone>(key: &str, args: &[(&str, V)]) -> String {
    let args: Vec<(&str, Arg)> = args.iter().map(|(k, v)| (*k, v.clone().into())).collect();
    tr_with(key, &args)
}

/// With mixed arguments: `tr_with("greet", &[("name", "Ana".into()), ("n", 2.into())])`.
pub fn tr_with(key: &str, args: &[(&str, Arg)]) -> String {
    match snapshot() {
        Some(s) => render(&s.lang, Some(&s.current), Some(&s.fallback), key, args),
        None => key.to_string(),
    }
}

/// Translate a fallback-language literal ("Settings") to the current language: finds the
/// key whose fallback text is `s`. Unknown text and the fallback language return `s` as is
/// (borrowed, no allocation).
pub fn tr_literal(s: &str) -> Cow<'_, str> {
    let Some(snap) = snapshot() else { return Cow::Borrowed(s) };
    if Arc::ptr_eq(&snap.current, &snap.fallback) {
        return Cow::Borrowed(s);
    }
    let Some(key) = snap.literal.get(s) else { return Cow::Borrowed(s) };
    match snap.current.messages.get(key) {
        Some(m) => match m.as_plain() {
            Some(t) => Cow::Owned(t.to_string()),
            None => {
                let mut out = String::new();
                m.format(&snap.lang, &[], &mut out);
                Cow::Owned(out)
            }
        },
        None => {
            note_missing(&snap.lang, key);
            Cow::Borrowed(s)
        }
    }
}

/// Whether the global locale has `key` (current or fallback language).
pub fn has_key(key: &str) -> bool {
    snapshot().is_some_and(|s| s.current.messages.contains_key(key) || s.fallback.messages.contains_key(key))
}

/// Current language code (`"en"` before the plugin loaded).
pub fn current_lang() -> String {
    snapshot().map_or_else(|| "en".into(), |s| s.lang.clone())
}

// ---------------------------------------------------------------- pseudo-locale

fn accent(c: char) -> char {
    match c {
        'a' => 'á',
        'c' => 'ç',
        'd' => 'đ',
        'e' => 'é',
        'g' => 'ĝ',
        'h' => 'ĥ',
        'i' => 'î',
        'j' => 'ĵ',
        'k' => 'ķ',
        'l' => 'ļ',
        'n' => 'ñ',
        'o' => 'ö',
        'r' => 'ŕ',
        's' => 'š',
        't' => 'ţ',
        'u' => 'û',
        'w' => 'ŵ',
        'y' => 'ý',
        'z' => 'ž',
        'A' => 'Å',
        'C' => 'Ç',
        'D' => 'Đ',
        'E' => 'É',
        'G' => 'Ĝ',
        'I' => 'Î',
        'L' => 'Ļ',
        'N' => 'Ñ',
        'O' => 'Ö',
        'R' => 'Ŕ',
        'S' => 'Š',
        'T' => 'Ţ',
        'U' => 'Û',
        'Y' => 'Ý',
        'Z' => 'Ž',
        _ => c,
    }
}

/// Accented and ~30 % longer (vowels doubled until the target length), e.g.
/// "Settings" → "Šéétţîîñĝš". Whitespace, digits and punctuation are kept.
pub fn pseudo_text(s: &str) -> String {
    let n = s.chars().count();
    let mut extra = (n as f32 * 0.3).ceil() as usize;
    let mut out = String::with_capacity(s.len() * 2 + 4);
    for c in s.chars() {
        let a = accent(c);
        out.push(a);
        if extra > 0 && "aeiouyAEIOUY".contains(c) {
            out.push(a);
            extra -= 1;
        }
    }
    // Words without vowels: pad at the end.
    for _ in 0..extra {
        out.push('~');
    }
    out
}

fn pseudo_message(m: &Message) -> Message {
    let mut p = m.map_text(&|t: &str| pseudo_text(t));
    // Brackets show where a string was cut off.
    match p.0.first_mut() {
        Some(ftl::Segment::Text(t)) => t.insert(0, '['),
        _ => p.0.insert(0, ftl::Segment::Text("[".into())),
    }
    match p.0.last_mut() {
        Some(ftl::Segment::Text(t)) => t.push(']'),
        _ => p.0.push(ftl::Segment::Text("]".into())),
    }
    p
}

// ---------------------------------------------------------------- Tr component

/// A `Text` that shows a translated key and updates when the language changes:
/// `commands.spawn((Text::default(), Tr::new("hud-score").arg("score", 10)))`.
#[derive(Component, Clone, Debug, Default, PartialEq)]
pub struct Tr {
    pub key: Cow<'static, str>,
    pub args: Vec<(Cow<'static, str>, Arg)>,
    /// Upper-case the result (labels, titles).
    pub upper: bool,
}

impl Tr {
    pub fn new(key: impl Into<Cow<'static, str>>) -> Self {
        Tr { key: key.into(), args: Vec::new(), upper: false }
    }
    /// Add or replace an argument.
    pub fn arg(mut self, name: impl Into<Cow<'static, str>>, v: impl Into<Arg>) -> Self {
        self.set_arg(name, v);
        self
    }
    pub fn set_arg(&mut self, name: impl Into<Cow<'static, str>>, v: impl Into<Arg>) {
        let name = name.into();
        let v = v.into();
        match self.args.iter_mut().find(|(k, _)| *k == name) {
            Some(a) => a.1 = v,
            None => self.args.push((name, v)),
        }
    }
    pub fn upper(mut self) -> Self {
        self.upper = true;
        self
    }
    pub fn render(&self) -> String {
        let args: Vec<(&str, Arg)> = self.args.iter().map(|(k, v)| (k.as_ref(), v.clone())).collect();
        let s = tr_with(&self.key, &args);
        if self.upper { s.to_uppercase() } else { s }
    }
}

/// `app.add_locale_table("en", include_str!("../assets/locale/en.ftl"))`: tables defined in
/// code (merged over files; later calls win).
pub trait AddLocaleTable {
    fn add_locale_table(&mut self, lang: &str, ftl: &str) -> &mut Self;
}

impl AddLocaleTable for App {
    fn add_locale_table(&mut self, lang: &str, ftl: &str) -> &mut Self {
        match self.world_mut().get_resource_mut::<Locale>() {
            Some(mut l) => l.add_table(lang, ftl, &format!("code:{lang}")),
            None => warn!("l10n: add_locale_table before L10nPlugin (EnginePlugin) — ignored"),
        }
        self
    }
}

// ---------------------------------------------------------------- plugin

pub struct L10nPlugin;

impl Plugin for L10nPlugin {
    fn build(&self, app: &mut App) {
        let dir = app.world().get_resource::<crate::paths::AssetsDir>().map(|a| a.0.join("locale"));
        let mut locale = Locale::load("en", dir.as_deref());
        for e in &locale.errors {
            warn!("l10n: {e}");
        }
        crate::settings::add_settings_section::<LocaleSettings>(app, "locale");
        let saved = app.world().resource::<LocaleSettings>().lang.clone();
        let want = crate::cli::dev_value("lang").or_else(|| (!saved.is_empty()).then_some(saved)).or_else(system_language);
        if let Some(w) = want
            && let Err(e) = locale.set(&w)
        {
            info!("l10n: {e}; using {}", locale.lang());
        }
        locale.make_global();
        // The "Language" row's options are fixed at startup (the languages found now).
        let names: Vec<&'static str> = locale.languages().iter().map(|l| &*Box::leak(locale.language_name(l).into_boxed_str())).collect();
        app.insert_resource(locale)
            .add_systems(Update, (on_language_change, localize_texts).chain())
            .register_setting(FieldDef {
                key: "language",
                tab: "Interface",
                label: "Language",
                hint: "Menus and text. Pseudo is for testing translations.",
                kind: FieldKind::Choice { options: names },
                get: |w| {
                    let l = w.resource::<Locale>();
                    l.languages().iter().position(|x| *x == l.lang()).unwrap_or(0) as f32
                },
                set: |w, v| {
                    let mut l = w.resource_mut::<Locale>();
                    let code = l.languages().get(v.round().max(0.0) as usize).map(|s| s.to_string());
                    if let Some(c) = code {
                        let _ = l.set(&c);
                    }
                },
            });
        #[cfg(feature = "devtools")]
        commands::register(app);
    }
}

/// `$LC_ALL` / `$LANG` ("de_DE.UTF-8" → "de_DE").
pub fn system_language() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.is_empty() && v != "C" && v != "POSIX")
        .map(|v| v.split('.').next().unwrap_or(&v).to_string())
}

/// Language changed: save it, rebuild the open screen.
fn on_language_change(
    locale: Res<Locale>,
    mut settings: ResMut<LocaleSettings>,
    mut last: Local<Option<String>>,
    mut rebuild: MessageWriter<crate::ui::screens::RebuildScreen>,
) {
    if !locale.is_changed() {
        return;
    }
    if last.as_deref() == Some(locale.lang()) {
        return;
    }
    let first = last.is_none();
    *last = Some(locale.lang().to_string());
    if first {
        return;
    }
    if settings.lang != locale.lang() {
        settings.lang = locale.lang().to_string();
    }
    rebuild.write(crate::ui::screens::RebuildScreen);
}

/// [`Tr`] texts: new / changed ones, and all of them after a language or table change.
fn localize_texts(
    locale: Res<Locale>,
    mut seen: Local<u32>,
    mut q: ParamSet<(Query<(&Tr, &mut Text), Changed<Tr>>, Query<(&Tr, &mut Text)>)>,
) {
    let set = |tr: &Tr, text: &mut Text| {
        let s = tr.render();
        if text.0 != s {
            text.0 = s;
        }
    };
    if *seen != locale.generation() {
        *seen = locale.generation();
        for (tr, mut text) in &mut q.p1() {
            set(tr, &mut text);
        }
    } else {
        for (tr, mut text) in &mut q.p0() {
            set(tr, &mut text);
        }
    }
}

#[cfg(feature = "devtools")]
mod commands {
    use bevy::prelude::*;
    use serde_json::{Value, json};

    use super::{Arg, Locale};
    use crate::devtools::{AddControlCommand, params};

    pub(super) fn register(app: &mut App) {
        app.add_control_command("l10n.set", "Switch language (hot)", params(&[("lang", "string", "code, e.g. en, de, fr, pseudo")]), set)
            .add_control_command("l10n.list", "Languages, current, fallback", params(&[]), list)
            .add_control_command("l10n.missing", "Missing / untranslated keys and parse errors", params(&[("clear", "boolean", "forget runtime misses after reporting")]), missing)
            .add_control_command(
                "l10n.tr",
                "Translate a key in the current language",
                params(&[("key", "string", "message key"), ("args", "object", "arguments, e.g. {\"n\": 3}")]),
                tr,
            )
            .add_control_command("l10n.reload", "Re-read the game's <assets>/locale/*.ftl", params(&[]), reload);
    }

    fn set(world: &mut World, p: Value) -> Result<Value, String> {
        let lang = p.get("lang").and_then(Value::as_str).ok_or("`lang` is required")?;
        let mut l = world.resource_mut::<Locale>();
        l.set(lang)?;
        Ok(json!({"lang": l.lang()}))
    }

    fn list(world: &mut World, _: Value) -> Result<Value, String> {
        let l = world.resource::<Locale>();
        let langs: Vec<Value> = l.languages().iter().map(|c| json!({"code": c, "name": l.language_name(c)})).collect();
        Ok(json!({"lang": l.lang(), "fallback": l.fallback(), "languages": langs}))
    }

    fn missing(world: &mut World, p: Value) -> Result<Value, String> {
        let r = world.resource::<Locale>().missing();
        if p.get("clear").and_then(Value::as_bool).unwrap_or(false) {
            Locale::clear_missing();
        }
        serde_json::to_value(r).map_err(|e| e.to_string())
    }

    fn tr(world: &mut World, p: Value) -> Result<Value, String> {
        let key = p.get("key").and_then(Value::as_str).ok_or("`key` is required")?;
        let args: Vec<(String, Arg)> = p
            .get("args")
            .and_then(Value::as_object)
            .map(|o| {
                o.iter()
                    .map(|(k, v)| {
                        let a = match v {
                            Value::Number(n) if n.is_i64() => Arg::Int(n.as_i64().unwrap_or(0)),
                            Value::Number(n) => Arg::Float(n.as_f64().unwrap_or(0.0)),
                            Value::String(s) => Arg::Str(s.clone()),
                            other => Arg::Str(other.to_string()),
                        };
                        (k.clone(), a)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let refs: Vec<(&str, Arg)> = args.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        let l = world.resource::<Locale>();
        Ok(json!({"lang": l.lang(), "key": key, "text": l.tr_with(key, &refs), "found": l.has(key)}))
    }

    fn reload(world: &mut World, _: Value) -> Result<Value, String> {
        let dir = world.get_resource::<crate::paths::AssetsDir>().map(|a| a.0.join("locale"));
        let mut l = world.resource_mut::<Locale>();
        l.reload(dir.as_deref());
        Ok(json!({"lang": l.lang(), "errors": l.errors}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locale() -> Locale {
        let mut l = Locale::new("en");
        l.add_table("en", "language-name = English\nhello = Hello\nitems = { $n ->\n    [one] One item\n   *[other] { $n } items\n}\nonly-en = Only English\n", "t");
        l.add_table("de", "language-name = Deutsch\nhello = Hallo\nitems = { $n ->\n    [one] Ein Ding\n   *[other] { $n } Dinge\n}\nextra = Nur hier\n", "t");
        l.rebuild_pseudo();
        l
    }

    #[test]
    fn fallback_plurals_and_missing() {
        let mut l = locale();
        assert_eq!(l.tr("hello"), "Hello");
        l.set("de").unwrap();
        assert_eq!(l.tr("hello"), "Hallo");
        assert_eq!(l.tr_with("items", &[("n", 1.into())]), "Ein Ding");
        assert_eq!(l.tr_with("items", &[("n", 4.into())]), "4 Dinge");
        assert_eq!(l.tr("only-en"), "Only English", "falls back");
        assert_eq!(l.tr("nope"), "nope", "missing everywhere → key");
        l.set("de-CH").unwrap();
        assert_eq!(l.lang(), "de");
        assert!(l.set("xx").is_err());
        let r = l.missing();
        assert_eq!(r.untranslated["de"], vec!["only-en".to_string()]);
        assert_eq!(r.orphans["de"], vec!["extra".to_string()]);
        assert!(r.runtime.iter().any(|m| m == "de:only-en"));
        assert_eq!(l.language_name("de"), "Deutsch");
        assert_eq!(l.languages(), vec!["de", "en", "pseudo"]);
    }

    #[test]
    fn pseudo_is_accented_longer_and_keeps_args() {
        let mut l = locale();
        l.set(PSEUDO).unwrap();
        let s = l.tr("hello");
        assert!(s.starts_with('[') && s.ends_with(']'), "{s}");
        assert!(s.contains('Ĥ') || s.contains('é'), "{s}");
        assert!(s.chars().count() as f32 >= "Hello".len() as f32 * 1.3, "{s}");
        let s = l.tr_with("items", &[("n", 3.into())]);
        assert!(s.contains('3'), "argument kept: {s}");
        assert_eq!(pseudo_text("ab"), "ááb");
        assert_eq!(pseudo_text("Settings, 3"), "Šééţţîîñĝš, 3~~");
    }

    #[test]
    fn engine_tables_parse_cleanly() {
        let l = Locale::load("en", None);
        assert!(l.errors.is_empty(), "{:?}", l.errors);
        let r = l.missing();
        for (lang, miss) in &r.untranslated {
            assert!(miss.is_empty(), "{lang} lacks {miss:?}");
        }
        assert!(r.orphans.is_empty(), "{:?}", r.orphans);
    }
}
