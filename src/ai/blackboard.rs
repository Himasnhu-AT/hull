//! Per-entity key/value memory shared by behaviour trees, utility AI and game systems.

use std::borrow::Cow;

use bevy::prelude::*;
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq)]
pub enum BbValue {
    Bool(bool),
    Int(i64),
    Float(f32),
    Vec3(Vec3),
    Entity(Entity),
    Text(Cow<'static, str>),
}

impl BbValue {
    pub fn to_json(&self) -> Value {
        match self {
            BbValue::Bool(b) => json!(b),
            BbValue::Int(i) => json!(i),
            BbValue::Float(f) => json!(f),
            BbValue::Vec3(v) => json!([v.x, v.y, v.z]),
            BbValue::Entity(e) => json!({"entity": e.to_bits()}),
            BbValue::Text(s) => json!(s),
        }
    }
}

impl From<bool> for BbValue {
    fn from(v: bool) -> Self {
        BbValue::Bool(v)
    }
}
impl From<i64> for BbValue {
    fn from(v: i64) -> Self {
        BbValue::Int(v)
    }
}
impl From<i32> for BbValue {
    fn from(v: i32) -> Self {
        BbValue::Int(v as i64)
    }
}
impl From<f32> for BbValue {
    fn from(v: f32) -> Self {
        BbValue::Float(v)
    }
}
impl From<Vec3> for BbValue {
    fn from(v: Vec3) -> Self {
        BbValue::Vec3(v)
    }
}
impl From<Entity> for BbValue {
    fn from(v: Entity) -> Self {
        BbValue::Entity(v)
    }
}
impl From<&'static str> for BbValue {
    fn from(v: &'static str) -> Self {
        BbValue::Text(Cow::Borrowed(v))
    }
}
impl From<String> for BbValue {
    fn from(v: String) -> Self {
        BbValue::Text(Cow::Owned(v))
    }
}

/// Small ordered map (linear search: blackboards hold a handful of keys).
#[derive(Component, Clone, Debug, Default, PartialEq)]
pub struct Blackboard {
    entries: Vec<(Cow<'static, str>, BbValue)>,
}

impl Blackboard {
    pub fn set(&mut self, key: impl Into<Cow<'static, str>>, v: impl Into<BbValue>) {
        let key = key.into();
        let v = v.into();
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some(e) => e.1 = v,
            None => self.entries.push((key, v)),
        }
    }
    pub fn get(&self, key: &str) -> Option<&BbValue> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn remove(&mut self, key: &str) -> Option<BbValue> {
        let i = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(i).1)
    }
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn bool(&self, key: &str) -> bool {
        matches!(self.get(key), Some(BbValue::Bool(true)))
    }
    pub fn int(&self, key: &str) -> Option<i64> {
        match self.get(key)? {
            BbValue::Int(i) => Some(*i),
            _ => None,
        }
    }
    pub fn float(&self, key: &str) -> Option<f32> {
        match self.get(key)? {
            BbValue::Float(f) => Some(*f),
            BbValue::Int(i) => Some(*i as f32),
            _ => None,
        }
    }
    pub fn vec3(&self, key: &str) -> Option<Vec3> {
        match self.get(key)? {
            BbValue::Vec3(v) => Some(*v),
            _ => None,
        }
    }
    pub fn entity(&self, key: &str) -> Option<Entity> {
        match self.get(key)? {
            BbValue::Entity(e) => Some(*e),
            _ => None,
        }
    }
    pub fn text(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            BbValue::Text(s) => Some(s),
            _ => None,
        }
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &BbValue)> {
        self.entries.iter().map(|(k, v)| (k.as_ref(), v))
    }
    pub fn to_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        for (k, v) in &self.entries {
            m.insert(k.to_string(), v.to_json());
        }
        Value::Object(m)
    }
}
