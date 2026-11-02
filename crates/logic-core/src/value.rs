//! Values flowing along data pins.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Pin type. `Any` accepts every value; `Json` accepts every value and converts on use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ty {
    Bool,
    Number,
    String,
    Vec3,
    Entity,
    Json,
    Any,
}

impl Ty {
    /// Can an output of type `self` feed an input of type `to`? `Json` and `Any` are dynamic:
    /// the value is checked when it arrives.
    pub fn feeds(self, to: Ty) -> bool {
        self == to || matches!(self, Ty::Json | Ty::Any) || matches!(to, Ty::Json | Ty::Any)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum Value {
    /// No value / no entity.
    #[default]
    Null,
    Bool(bool),
    Num(f64),
    Str(Arc<str>),
    Vec3([f32; 3]),
    /// An entity id (`Entity::to_bits` on the engine side).
    Entity(u64),
    Json(Arc<serde_json::Value>),
}

impl Value {
    pub fn text(s: &str) -> Value {
        Value::Str(Arc::from(s))
    }

    /// The natural pin type of this value (`Null` is `Entity`: "no entity").
    pub fn ty(&self) -> Ty {
        match self {
            Value::Null => Ty::Entity,
            Value::Bool(_) => Ty::Bool,
            Value::Num(_) => Ty::Number,
            Value::Str(_) => Ty::String,
            Value::Vec3(_) => Ty::Vec3,
            Value::Entity(_) => Ty::Entity,
            Value::Json(_) => Ty::Json,
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::Value as J;
        match self {
            Value::Null => J::Null,
            Value::Bool(b) => J::Bool(*b),
            Value::Num(n) => serde_json::Number::from_f64(*n).map_or(J::Null, J::Number),
            Value::Str(s) => J::String(s.to_string()),
            Value::Vec3(v) => J::Array(v.iter().map(|x| serde_json::Number::from_f64(*x as f64).map_or(J::Null, J::Number)).collect()),
            Value::Entity(e) => J::Number((*e).into()),
            Value::Json(j) => (**j).clone(),
        }
    }

    /// JSON → value. Arrays of exactly three numbers become `Vec3`.
    pub fn from_json(j: &serde_json::Value) -> Value {
        use serde_json::Value as J;
        match j {
            J::Null => Value::Null,
            J::Bool(b) => Value::Bool(*b),
            J::Number(n) => Value::Num(n.as_f64().unwrap_or(0.0)),
            J::String(s) => Value::text(s),
            J::Array(a) if a.len() == 3 && a.iter().all(|x| x.is_number()) => {
                Value::Vec3([a[0].as_f64().unwrap_or(0.0) as f32, a[1].as_f64().unwrap_or(0.0) as f32, a[2].as_f64().unwrap_or(0.0) as f32])
            }
            other => Value::Json(Arc::new(other.clone())),
        }
    }

    /// Converts to `ty` or says why not. `Any` and matching types pass through unchanged.
    pub fn coerce(&self, ty: Ty) -> Result<Value, String> {
        let bad = || format!("expected {ty:?}, got {:?}", self.kind_name());
        Ok(match (ty, self) {
            (Ty::Any, v) => v.clone(),
            (Ty::Json, Value::Json(_)) => self.clone(),
            (Ty::Json, v) => Value::Json(Arc::new(v.to_json())),
            (Ty::Bool, Value::Bool(_)) | (Ty::Number, Value::Num(_)) | (Ty::String, Value::Str(_)) => self.clone(),
            (Ty::Vec3, Value::Vec3(_)) | (Ty::Entity, Value::Entity(_) | Value::Null) => self.clone(),
            (Ty::Bool, Value::Num(n)) => Value::Bool(*n != 0.0),
            (Ty::Bool, Value::Json(j)) => Value::Bool(j.as_bool().ok_or_else(bad)?),
            (Ty::Number, Value::Json(j)) => Value::Num(j.as_f64().ok_or_else(bad)?),
            (Ty::Number, Value::Bool(b)) => Value::Num(*b as u8 as f64),
            (Ty::String, Value::Json(j)) => Value::text(j.as_str().ok_or_else(bad)?),
            (Ty::String, Value::Num(n)) => Value::text(&fmt_num(*n)),
            (Ty::String, Value::Bool(b)) => Value::text(if *b { "true" } else { "false" }),
            (Ty::String, Value::Entity(e)) => Value::text(&format!("entity:{e}")),
            (Ty::String, Value::Vec3(v)) => Value::text(&format!("({}, {}, {})", fmt_num(v[0] as f64), fmt_num(v[1] as f64), fmt_num(v[2] as f64))),
            (Ty::String, Value::Null) => Value::text("null"),
            (Ty::Vec3, Value::Json(_)) => match Value::from_json(&self.to_json()) {
                v @ Value::Vec3(_) => v,
                _ => return Err(bad()),
            },
            (Ty::Entity, Value::Num(n)) if *n >= 0.0 => Value::Entity(*n as u64),
            (Ty::Entity, Value::Json(j)) => match j.as_u64() {
                Some(e) => Value::Entity(e),
                None if j.is_null() => Value::Null,
                None => return Err(bad()),
            },
            _ => return Err(bad()),
        })
    }

    pub fn kind_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Num(_) => "number",
            Value::Str(_) => "string",
            Value::Vec3(_) => "vec3",
            Value::Entity(_) => "entity",
            Value::Json(_) => "json",
        }
    }

    /// Text for logs (strings without quotes).
    pub fn display(&self) -> String {
        match self {
            Value::Str(s) => s.to_string(),
            Value::Json(j) => j.to_string(),
            other => other.coerce(Ty::String).map(|v| if let Value::Str(s) = v { s.to_string() } else { String::new() }).unwrap_or_default(),
        }
    }
}

fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 { format!("{}", n as i64) } else { format!("{n}") }
}
