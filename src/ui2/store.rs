//! [`UiData`]: the key-value store screens bind to. Any text prop may contain `{key}`; it shows
//! the value and updates when the key changes. [`Bind`] also drives badges and visibility.

use std::collections::BTreeMap;

use bevy::prelude::*;
use serde_json::Value;

use super::Ui2Set;

#[derive(Resource, Default, Debug)]
pub struct UiData {
    map: BTreeMap<String, Value>,
}

impl UiData {
    pub fn set(&mut self, key: &str, v: impl Into<Value>) {
        let v = v.into();
        if self.map.get(key) != Some(&v) {
            self.map.insert(key.to_string(), v);
        }
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.map.get(key)
    }
    pub fn f64(&self, key: &str) -> f64 {
        self.map.get(key).and_then(Value::as_f64).unwrap_or(0.0)
    }
    pub fn truthy(&self, key: &str) -> bool {
        match self.map.get(key) {
            None | Some(Value::Null) | Some(Value::Bool(false)) => false,
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
            Some(Value::String(s)) => !s.is_empty(),
            Some(_) => true,
        }
    }
    /// Display text of a value: strings bare, integers without `.0`, thousands untouched.
    pub fn text(&self, key: &str) -> String {
        match self.map.get(key) {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
        }
    }
    /// `"{player.name} ({n})"` with each `{key}` replaced by its text.
    pub fn interpolate(&self, template: &str) -> String {
        let mut out = String::with_capacity(template.len());
        let mut rest = template;
        while let Some(i) = rest.find('{') {
            out.push_str(&rest[..i]);
            match rest[i..].find('}') {
                Some(j) => {
                    out.push_str(&self.text(rest[i + 1..i + j].trim()));
                    rest = &rest[i + j + 1..];
                }
                None => {
                    out.push_str(&rest[i..]);
                    rest = "";
                }
            }
        }
        out.push_str(rest);
        out
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.map.iter()
    }
}

pub fn is_template(s: &str) -> bool {
    s.contains('{') && s.contains('}')
}

#[derive(Clone, Debug, PartialEq)]
pub enum BindTarget {
    /// The entity's `Text` shows the interpolated template.
    Text,
    /// A pill: hidden while the value is 0 / empty, else shows it (child text).
    Badge,
    /// Visible while the key is truthy; with `Some(n)` while the number equals `n`.
    Visible(Option<f64>),
    /// Node width as a percentage of the parent (`{key}` is 0..1).
    Fill,
}

/// Ties an entity to data: `template` is the text (`"{player.credits}"`) or, for `Visible`, a key.
#[derive(Component, Clone, Debug)]
pub struct Bind {
    pub template: String,
    pub target: BindTarget,
}

pub struct StorePlugin;

impl Plugin for StorePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, apply_bindings.in_set(Ui2Set::Paint));
    }
}

fn key_of(template: &str) -> &str {
    let t = template.trim();
    t.strip_prefix('{').and_then(|t| t.strip_suffix('}')).unwrap_or(t).trim()
}

#[allow(clippy::type_complexity)]
fn apply_bindings(
    data: Res<UiData>,
    changed: Query<Entity, Added<Bind>>,
    binds: Query<(Entity, &Bind)>,
    mut texts: Query<&mut Text>,
    mut nodes: Query<&mut Node>,
    kids: Query<&Children>,
) {
    if !data.is_changed() && changed.is_empty() {
        return;
    }
    for (e, b) in &binds {
        match &b.target {
            BindTarget::Text => {
                if let Ok(mut t) = texts.get_mut(e) {
                    let s = data.interpolate(&b.template);
                    if t.0 != s {
                        t.0 = s;
                    }
                }
            }
            BindTarget::Badge => {
                let key = key_of(&b.template);
                let on = data.truthy(key);
                if let Ok(mut n) = nodes.get_mut(e) {
                    let want = if on { Display::Flex } else { Display::None };
                    if n.display != want {
                        n.display = want;
                    }
                }
                for c in kids.iter_descendants(e) {
                    if let Ok(mut t) = texts.get_mut(c) {
                        let s = data.text(key);
                        if t.0 != s {
                            t.0 = s;
                        }
                    }
                }
            }
            BindTarget::Visible(eq) => {
                let key = key_of(&b.template);
                let on = match eq {
                    Some(n) => (data.f64(key) - n).abs() < 1e-6,
                    None => data.truthy(key),
                };
                if let Ok(mut n) = nodes.get_mut(e) {
                    let want = if on { Display::Flex } else { Display::None };
                    if n.display != want {
                        n.display = want;
                    }
                }
            }
            BindTarget::Fill => {
                if let Ok(mut n) = nodes.get_mut(e) {
                    n.width = Val::Percent((data.f64(key_of(&b.template)) as f32).clamp(0.0, 1.0) * 100.0);
                }
            }
        }
    }
}
