//! Reflection to editor data: [`TypeSchema`] from `bevy_reflect` type info, and the JSON the
//! editor UI sees. Reflect JSON is converted on the way out (`to_ui`) and back in (`from_ui`),
//! guided by the type info, so the UI gets simple shapes:
//!
//! | Rust | UI JSON |
//! |---|---|
//! | `Handle<A>` | the asset path string (`""` for a handle made in code) |
//! | `Color`, `Srgba`, `LinearRgba` | `[r, g, b, a]` (sRGB for `Color`) |
//! | `Option<T>` | `"None"` / `{"Some": v}` (an enum, as the contract says) |
//! | `Vec2/3/4`, `Quat` | arrays (already, from the reflect serializer) |
//!
//! Handles go through Bevy's `HandleSerializeProcessor` / `HandleDeserializeProcessor`, so a
//! component holding one (`WorldAssetRoot`, `Mesh3d`) serialises and loads by path.

use std::any::TypeId;
use std::ops::RangeInclusive;

use bevy::asset::{AssetServer, EphemeralHandleBehavior, HandleDeserializeProcessor, HandleSerializeProcessor, ReflectHandle};
use bevy::reflect::serde::{TypedReflectDeserializer, TypedReflectSerializer};
use bevy::reflect::attributes::CustomAttributes;
use bevy::reflect::{PartialReflect, Type, TypeInfo, TypeRegistration, TypeRegistry};
use bevy::reflect::enums::VariantInfo;
use bevy::reflect::Reflect;
use editor_proto::{FieldMeta, TypeSchema};
use serde::de::DeserializeSeed;
use serde_json::{Map, Value, json};

// ---------------------------------------------------------------------------------------------
// Display hints: `#[reflect(@Tip("..."))]` and friends on fields (and `Category` / `Tip` on a
// component type) become the label, hover text and unit the Details panel shows.

/// Hover text of a field or component.
#[derive(Reflect, Clone, Copy, Debug)]
pub struct Tip(pub &'static str);
/// Unit shown after a number (`m`, `s`, `deg`, `m/s` ...).
#[derive(Reflect, Clone, Copy, Debug)]
pub struct Unit(pub &'static str);
/// Label that replaces the one made from the field name.
#[derive(Reflect, Clone, Copy, Debug)]
pub struct DisplayName(pub &'static str);
/// The field is not shown (its value stays available to siblings).
#[derive(Reflect, Clone, Copy, Debug)]
pub struct Hidden;
/// An integer field picked from the rows of the named sibling list (`@Choose("points")`).
#[derive(Reflect, Clone, Copy, Debug)]
pub struct Choose(pub &'static str);
/// Details section of a component type: `Rendering`, `Physics`, `Gameplay`, `Logic`, `Other`.
#[derive(Reflect, Clone, Copy, Debug)]
pub struct Category(pub &'static str);

/// Display hints from a field's attributes plus the built-in ones for engine types.
fn field_meta(attrs: &CustomAttributes, owner: &str, field: &str) -> Option<FieldMeta> {
    let mut m = FieldMeta {
        label: attrs.get::<DisplayName>().map(|l| l.0.to_owned()),
        tip: attrs.get::<Tip>().map(|t| t.0.to_owned()),
        unit: attrs.get::<Unit>().map(|u| u.0.to_owned()),
        hidden: attrs.get::<Hidden>().is_some(),
        choose: attrs.get::<Choose>().map(|c| c.0.to_owned()),
    };
    if owner.ends_with("::Transform") {
        match field {
            "translation" => {
                m.unit.get_or_insert_with(|| "m".into());
                m.tip.get_or_insert_with(|| "Position relative to the parent, in metres".into());
            }
            "rotation" => {
                m.tip.get_or_insert_with(|| "Rotation as angles in degrees (X pitch, Y yaw, Z roll)".into());
            }
            "scale" => {
                m.tip.get_or_insert_with(|| "Size factor per axis; 1 is the original size".into());
            }
            _ => {}
        }
    }
    if owner.ends_with("::BrushSettings") {
        let (unit, tip) = match field {
            "radius" => (Some("m"), Some("Brush radius")),
            "strength" => (None, Some("How hard each dab pushes; stroke speed scales with it")),
            "target" => (Some("m"), Some("Flatten: the height to reach. Ramp: the height at the far end")),
            "pick_target" => (None, Some("Take the target height from the terrain under the first dab")),
            "noise_scale" => (Some("m"), Some("Size of the noise features")),
            "ramp_end" => (Some("m"), Some("Ramp (single dab): XZ of the far end")),
            _ => (None, None),
        };
        if let Some(u) = unit {
            m.unit.get_or_insert_with(|| u.into());
        }
        if let Some(t) = tip {
            m.tip.get_or_insert_with(|| t.into());
        }
    }
    (m != FieldMeta::default()).then_some(m)
}

/// `(category, tip)` set on a component type with `#[reflect(@Category("Gameplay"), @Tip("..."))]`.
pub fn type_hints(info: &'static TypeInfo) -> (Option<&'static str>, Option<&'static str>) {
    let attrs = match info {
        TypeInfo::Struct(s) => s.custom_attributes(),
        TypeInfo::TupleStruct(t) => t.custom_attributes(),
        TypeInfo::Enum(e) => e.custom_attributes(),
        _ => return (None, None),
    };
    (attrs.get::<Category>().map(|c| c.0), attrs.get::<Tip>().map(|t| t.0))
}

/// Replaces the schema under a field's display hints (the hints stay).
pub fn set_inner(slot: &mut TypeSchema, new: TypeSchema) {
    match slot {
        TypeSchema::Field { inner, .. } => **inner = new,
        other => *other = new,
    }
}

/// Deepest nesting the schema builder follows (recursive types stop here as `Opaque`).
const MAX_DEPTH: usize = 8;

/// Which way a conversion goes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Dir {
    ToUi,
    FromUi,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Special {
    Color,
    Srgba,
    LinearRgba,
    Vec(u8),
    Quat,
    Entity,
    Str,
    Bool,
    Float,
    Int(i64, i64),
    Option,
}

fn special_of(path: &str) -> Option<Special> {
    if path.starts_with("core::option::Option<") {
        return Some(Special::Option);
    }
    Some(match path {
        "bevy_color::color::Color" => Special::Color,
        "bevy_color::srgba::Srgba" => Special::Srgba,
        "bevy_color::linear_rgba::LinearRgba" => Special::LinearRgba,
        "glam::Vec2" => Special::Vec(2),
        "glam::Vec3" | "glam::Vec3A" => Special::Vec(3),
        "glam::Vec4" => Special::Vec(4),
        "glam::Quat" => Special::Quat,
        "bevy_ecs::entity::Entity" => Special::Entity,
        "alloc::string::String" | "alloc::borrow::Cow<str>" | "str" => Special::Str,
        "bool" => Special::Bool,
        "f32" | "f64" => Special::Float,
        "u8" => Special::Int(0, u8::MAX.into()),
        "u16" => Special::Int(0, u16::MAX.into()),
        "u32" => Special::Int(0, u32::MAX.into()),
        "u64" | "usize" => Special::Int(0, i64::MAX),
        "i8" => Special::Int(i8::MIN.into(), i8::MAX.into()),
        "i16" => Special::Int(i16::MIN.into(), i16::MAX.into()),
        "i32" => Special::Int(i32::MIN.into(), i32::MAX.into()),
        "i64" | "isize" => Special::Int(i64::MIN, i64::MAX),
        _ => return None,
    })
}

/// The asset kind (`Mesh`, `Image`, ...) when `ty` is a `Handle<A>`.
fn handle_kind(reg: &TypeRegistry, ty: TypeId) -> Option<String> {
    let reg_entry = reg.get(ty)?;
    let rh = reg_entry.data::<ReflectHandle>()?;
    if let Some(a) = reg.get(rh.asset_type_id()) {
        return Some(a.type_info().type_path_table().ident().unwrap_or("Asset").to_string());
    }
    // Asset type not registered with reflection: the last path segment inside `Handle<...>`.
    let p = reg_entry.type_info().type_path();
    let inner = p.split_once('<').map_or(p, |x| x.1).trim_end_matches('>');
    Some(inner.rsplit("::").next().unwrap_or("Asset").to_string())
}

fn info_of(reg: &TypeRegistry, ty: Type, hint: Option<&'static TypeInfo>) -> Option<&'static TypeInfo> {
    hint.or_else(|| reg.get_type_info(ty.id()))
}

/// Numeric range from `#[reflect(@RangeInclusive<f32>)]`-style custom attributes on a field.
fn field_range(attrs: &CustomAttributes, base: TypeSchema) -> TypeSchema {
    fn range<T: Copy + Into<f64> + bevy::reflect::TypePath + Send + Sync + 'static>(a: &CustomAttributes) -> Option<(f64, f64)> {
        let r = a.get::<RangeInclusive<T>>()?;
        Some(((*r.start()).into(), (*r.end()).into()))
    }
    match base {
        TypeSchema::Float { step, .. } => {
            let r = range::<f32>(attrs).or_else(|| range::<f64>(attrs));
            TypeSchema::Float { min: r.map(|r| r.0), max: r.map(|r| r.1), step }
        }
        TypeSchema::Int { min, max } => {
            let r = range::<i32>(attrs).or_else(|| range::<u32>(attrs)).or_else(|| range::<u8>(attrs)).or_else(|| range::<i16>(attrs)).or_else(|| range::<u16>(attrs));
            match r {
                Some((a, b)) => TypeSchema::Int { min: Some(a as i64), max: Some(b as i64) },
                None => TypeSchema::Int { min, max },
            }
        }
        other => other,
    }
}

/// The editing schema of a type.
pub fn schema_of(reg: &TypeRegistry, info: &'static TypeInfo) -> TypeSchema {
    schema_inner(reg, info, 0)
}

fn schema_inner(reg: &TypeRegistry, info: &'static TypeInfo, depth: usize) -> TypeSchema {
    if depth > MAX_DEPTH {
        return TypeSchema::Opaque;
    }
    if let Some(kind) = handle_kind(reg, info.type_id()) {
        return TypeSchema::AssetPath { kind };
    }
    match special_of(info.type_path()) {
        Some(Special::Color | Special::Srgba | Special::LinearRgba) => return TypeSchema::Color,
        Some(Special::Vec(2)) => return TypeSchema::Vec2,
        Some(Special::Vec(3)) => return TypeSchema::Vec3,
        Some(Special::Vec(_)) => return TypeSchema::Vec4,
        Some(Special::Quat) => return TypeSchema::Quat,
        Some(Special::Entity) => return TypeSchema::Entity,
        Some(Special::Str) => return TypeSchema::String,
        Some(Special::Bool) => return TypeSchema::Bool,
        Some(Special::Float) => return TypeSchema::Float { min: None, max: None, step: None },
        Some(Special::Int(a, b)) => return TypeSchema::Int { min: Some(a), max: Some(b) },
        Some(Special::Option) | None => {}
    }
    let sub = |ty: &Type, hint: Option<&'static TypeInfo>| info_of(reg, *ty, hint).map_or(TypeSchema::Opaque, |i| schema_inner(reg, i, depth + 1));
    match info {
        TypeInfo::Struct(s) => TypeSchema::Struct {
            fields: s
                .iter()
                .map(|f| {
                    let base = field_range(f.custom_attributes(), sub(f.ty(), f.type_info()));
                    let schema = match field_meta(f.custom_attributes(), info.type_path(), f.name()) {
                        Some(meta) => TypeSchema::Field { meta, inner: Box::new(base) },
                        None => base,
                    };
                    (f.name().to_string(), schema)
                })
                .collect(),
        },
        // A one-field tuple struct serialises as its field (`Mesh3d(handle)` is the handle).
        TypeInfo::TupleStruct(t) if t.field_len() == 1 => t.field_at(0).map_or(TypeSchema::Opaque, |f| sub(f.ty(), f.type_info())),
        TypeInfo::TupleStruct(t) => TypeSchema::Struct {
            fields: t.iter().map(|f| (f.index().to_string(), sub(f.ty(), f.type_info()))).collect(),
        },
        TypeInfo::List(l) => TypeSchema::List(Box::new(sub(&l.item_ty(), l.item_info()))),
        TypeInfo::Array(a) => TypeSchema::List(Box::new(sub(&a.item_ty(), a.item_info()))),
        TypeInfo::Set(s) => TypeSchema::List(Box::new(sub(&s.value_ty(), None))),
        TypeInfo::Map(m) => TypeSchema::Map(Box::new(sub(&m.value_ty(), m.value_info()))),
        TypeInfo::Enum(e) => TypeSchema::Enum {
            variants: e
                .iter()
                .map(|v| {
                    let payload = match v {
                        VariantInfo::Unit(_) => None,
                        VariantInfo::Tuple(t) if t.field_len() == 1 => t.field_at(0).map(|f| sub(f.ty(), f.type_info())),
                        VariantInfo::Tuple(_) => Some(TypeSchema::Opaque),
                        VariantInfo::Struct(s) => Some(TypeSchema::Struct {
                            fields: s.iter().map(|f| (f.name().to_string(), sub(f.ty(), f.type_info()))).collect(),
                        }),
                    };
                    (v.name().to_string(), payload)
                })
                .collect(),
        },
        TypeInfo::Tuple(_) | TypeInfo::Opaque(_) => TypeSchema::Opaque,
    }
}

// ---------------------------------------------------------------------------------------------
// JSON conversion

/// Reflect JSON of a value (handles by path) to the UI form.
pub fn to_ui(reg: &TypeRegistry, info: &'static TypeInfo, v: Value) -> Value {
    walk(reg, Some(info), v, Dir::ToUi, 0)
}

/// UI JSON back to the shape the reflect deserializer reads.
pub fn from_ui(reg: &TypeRegistry, info: &'static TypeInfo, v: Value) -> Value {
    walk(reg, Some(info), v, Dir::FromUi, 0)
}

fn rgba(v: &Value, keys: [&str; 4]) -> Option<[f64; 4]> {
    let o = v.as_object()?;
    let mut out = [0.0; 4];
    for (i, k) in keys.iter().enumerate() {
        out[i] = o.get(*k)?.as_f64()?;
    }
    Some(out)
}

fn srgb_encode(c: f64) -> f64 {
    if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

fn obj4(a: [f64; 4]) -> Value {
    json!({"red": a[0], "green": a[1], "blue": a[2], "alpha": a[3]})
}

fn walk(reg: &TypeRegistry, info: Option<&'static TypeInfo>, v: Value, dir: Dir, depth: usize) -> Value {
    let Some(info) = info else { return v };
    if depth > MAX_DEPTH + 4 {
        return v;
    }
    if handle_kind(reg, info.type_id()).is_some() {
        return match dir {
            Dir::ToUi => match v {
                Value::Object(o) => match o.get("Path") {
                    Some(Value::String(p)) => Value::String(p.clone()),
                    _ => Value::String(String::new()),
                },
                Value::String(s) => Value::String(s),
                _ => Value::String(String::new()),
            },
            Dir::FromUi => match v {
                Value::String(s) if !s.is_empty() => json!({"Path": s}),
                _ => json!({"Uuid": default_handle_uuid()}),
            },
        };
    }
    let child = |ty: &Type, hint: Option<&'static TypeInfo>, v: Value| walk(reg, info_of(reg, *ty, hint), v, dir, depth + 1);
    match special_of(info.type_path()) {
        Some(Special::Color) => {
            return match dir {
                Dir::ToUi => {
                    let o = v.as_object();
                    if let Some(a) = o.and_then(|o| o.get("Srgba")).and_then(|c| rgba(c, ["red", "green", "blue", "alpha"])) {
                        json!(a)
                    } else if let Some(a) = o.and_then(|o| o.get("LinearRgba")).and_then(|c| rgba(c, ["red", "green", "blue", "alpha"])) {
                        json!([srgb_encode(a[0]), srgb_encode(a[1]), srgb_encode(a[2]), a[3]])
                    } else {
                        v
                    }
                }
                Dir::FromUi => match color_array(&v) {
                    Some(a) => json!({"Srgba": obj4(a)}),
                    None => v,
                },
            };
        }
        Some(Special::Srgba) => {
            return match dir {
                Dir::ToUi => rgba(&v, ["red", "green", "blue", "alpha"]).map_or(v, |a| json!(a)),
                Dir::FromUi => color_array(&v).map_or(v, obj4),
            };
        }
        Some(Special::LinearRgba) => {
            return match dir {
                Dir::ToUi => rgba(&v, ["red", "green", "blue", "alpha"]).map_or(v, |a| json!(a)),
                Dir::FromUi => color_array(&v).map_or(v, obj4),
            };
        }
        Some(Special::Option) => {
            // Option<T> is `null` / `T` for the reflect serializer, `"None"` / `{"Some": T}` for the UI.
            let inner = match info {
                TypeInfo::Enum(e) => e.variant("Some").and_then(|s| s.as_tuple_variant().ok()).and_then(|t| t.field_at(0)).map(|f| (f.ty(), f.type_info())),
                _ => None,
            };
            return match dir {
                Dir::ToUi => match v {
                    Value::Null => json!("None"),
                    other => match inner {
                        Some((ty, hint)) => json!({"Some": child(ty, hint, other)}),
                        None => json!({"Some": other}),
                    },
                },
                Dir::FromUi => match v {
                    Value::String(s) if s == "None" => Value::Null,
                    Value::Object(mut o) if o.contains_key("Some") => {
                        let payload = o.remove("Some").unwrap_or(Value::Null);
                        match inner {
                            Some((ty, hint)) => child(ty, hint, payload),
                            None => payload,
                        }
                    }
                    other => other,
                },
            };
        }
        Some(_) => return v,
        None => {}
    }
    match (info, v) {
        (TypeInfo::Struct(s), Value::Object(o)) => {
            let mut out = Map::new();
            for (k, val) in o {
                let nv = match s.field(&k) {
                    Some(f) => child(f.ty(), f.type_info(), val),
                    None => val,
                };
                out.insert(k, nv);
            }
            Value::Object(out)
        }
        (TypeInfo::TupleStruct(t), v) if t.field_len() == 1 => match t.field_at(0) {
            Some(f) => child(f.ty(), f.type_info(), v),
            None => v,
        },
        (TypeInfo::List(l), Value::Array(a)) => Value::Array(a.into_iter().map(|x| child(&l.item_ty(), l.item_info(), x)).collect()),
        (TypeInfo::Array(l), Value::Array(a)) => Value::Array(a.into_iter().map(|x| child(&l.item_ty(), l.item_info(), x)).collect()),
        (TypeInfo::Map(m), Value::Object(o)) => Value::Object(o.into_iter().map(|(k, x)| (k, child(&m.value_ty(), m.value_info(), x))).collect()),
        (TypeInfo::Enum(e), Value::Object(o)) if o.len() == 1 => {
            let (name, payload) = o.into_iter().next().unwrap_or_default();
            let nv = match e.variant(&name) {
                Some(VariantInfo::Tuple(t)) if t.field_len() == 1 => t.field_at(0).map_or(payload.clone(), |f| child(f.ty(), f.type_info(), payload.clone())),
                Some(VariantInfo::Struct(s)) => match payload {
                    Value::Object(po) => Value::Object(
                        po.into_iter()
                            .map(|(k, x)| {
                                let nx = s.field(&k).map_or(x.clone(), |f| child(f.ty(), f.type_info(), x));
                                (k, nx)
                            })
                            .collect(),
                    ),
                    other => other,
                },
                _ => payload,
            };
            json!({ name: nv })
        }
        (_, v) => v,
    }
}

fn color_array(v: &Value) -> Option<[f64; 4]> {
    let a = v.as_array()?;
    let f = |i: usize| a.get(i).and_then(Value::as_f64);
    Some([f(0)?, f(1)?, f(2)?, f(3).unwrap_or(1.0)])
}

/// `Handle::default()`'s uuid (what a handle made in code serialises as).
fn default_handle_uuid() -> String {
    bevy::asset::AssetId::<bevy::prelude::Mesh>::DEFAULT_UUID.to_string()
}

/// `value` as reflect JSON, handles by asset path. Handles made in code (no path) come out as
/// the default handle's uuid.
pub fn serialize(reg: &TypeRegistry, value: &dyn PartialReflect) -> Result<Value, String> {
    let proc = HandleSerializeProcessor { ephemeral_handle_behavior: EphemeralHandleBehavior::Silent };
    serde_json::to_value(TypedReflectSerializer::with_processor(value, reg, &proc)).map_err(|e| e.to_string())
}

/// A reflected value of `r`'s type from reflect JSON; asset paths start loading through `server`.
pub fn deserialize(r: &TypeRegistration, json: &Value, reg: &TypeRegistry, server: &AssetServer) -> Result<Box<dyn PartialReflect>, String> {
    let mut loader = server.clone();
    let mut proc = HandleDeserializeProcessor { load_from_path: &mut loader };
    TypedReflectDeserializer::with_processor(r, reg, &mut proc)
        .deserialize(json)
        .map_err(|e| format!("{}: {e}", r.type_info().type_path_table().short_path()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::prelude::*;

    #[derive(Component, Reflect, Default)]
    #[reflect(Component, Default)]
    struct Probe {
        #[reflect(@0.0f32..=10.0f32)]
        speed: f32,
        tint: Color,
        mesh: Handle<Mesh>,
        maybe: Option<f32>,
        count: u8,
        tags: Vec<String>,
        pos: Vec3,
    }

    fn reg() -> TypeRegistry {
        let mut r = TypeRegistry::default();
        r.register::<Probe>();
        r.register::<Vec3>();
        r.register::<Color>();
        r.register::<Srgba>();
        r.register::<LinearRgba>();
        r.register::<Handle<Mesh>>();
        r.register::<Option<f32>>();
        r.register::<Vec<String>>();
        r.register_type_data::<Handle<Mesh>, ReflectHandle>();
        r
    }

    #[test]
    fn schema_has_ranges_handles_and_colors() {
        let r = reg();
        let info = r.get(TypeId::of::<Probe>()).unwrap().type_info();
        let TypeSchema::Struct { fields } = schema_of(&r, info) else { panic!("struct") };
        let get = |n: &str| fields.iter().find(|(k, _)| k == n).unwrap().1.clone();
        assert_eq!(get("speed"), TypeSchema::Float { min: Some(0.0), max: Some(10.0), step: None });
        assert_eq!(get("tint"), TypeSchema::Color);
        assert_eq!(get("mesh"), TypeSchema::AssetPath { kind: "Mesh".into() });
        assert_eq!(get("count"), TypeSchema::Int { min: Some(0), max: Some(255) });
        assert_eq!(get("pos"), TypeSchema::Vec3);
        assert_eq!(get("tags"), TypeSchema::List(Box::new(TypeSchema::String)));
        assert!(matches!(get("maybe"), TypeSchema::Enum { .. }));
    }

    #[test]
    fn json_round_trips_through_ui_form() {
        let r = reg();
        let reg_entry = r.get(TypeId::of::<Probe>()).unwrap();
        let p = Probe { speed: 2.0, tint: Color::srgb(1.0, 0.5, 0.25), maybe: Some(3.0), tags: vec!["a".into()], ..default() };
        let raw = serialize(&r, &p).unwrap();
        let ui = to_ui(&r, reg_entry.type_info(), raw.clone());
        assert_eq!(ui["tint"], json!([1.0, 0.5, 0.25, 1.0]));
        assert_eq!(ui["mesh"], json!(""));
        assert_eq!(ui["maybe"], json!({"Some": 3.0}));
        let back = from_ui(&r, reg_entry.type_info(), ui);
        assert_eq!(back["tint"], raw["tint"]);
        assert_eq!(back["maybe"], raw["maybe"]);
    }

    #[test]
    fn handle_path_shows_as_string() {
        let r = reg();
        let info = r.get(TypeId::of::<Probe>()).unwrap().type_info();
        let mut raw = serialize(&r, &Probe::default()).unwrap();
        raw["mesh"] = json!({"Path": "a/b.glb#Mesh0"});
        let ui = to_ui(&r, info, raw);
        assert_eq!(ui["mesh"], json!("a/b.glb#Mesh0"));
        assert_eq!(from_ui(&r, info, ui)["mesh"], json!({"Path": "a/b.glb#Mesh0"}));
    }

    #[derive(Component, Reflect, Default)]
    #[reflect(Component, Default, @Category("Gameplay"), @Tip("A thing with hints"))]
    struct Hinted {
        #[reflect(@Unit("m/s"), @Tip("How fast"), @DisplayName("Top speed"))]
        speed: f32,
        #[reflect(@Hidden)]
        secret: u8,
        #[reflect(@Choose("rows"))]
        pick: i32,
        rows: Vec<String>,
    }

    #[test]
    fn attributes_become_field_hints() {
        let mut r = reg();
        r.register::<Hinted>();
        let info = r.get(TypeId::of::<Hinted>()).unwrap().type_info();
        let TypeSchema::Struct { fields } = schema_of(&r, info) else { panic!("struct") };
        let get = |n: &str| fields.iter().find(|(k, _)| k == n).unwrap().1.clone();
        let m = get("speed").meta().cloned().expect("speed has hints");
        assert_eq!((m.unit.as_deref(), m.tip.as_deref(), m.label.as_deref()), (Some("m/s"), Some("How fast"), Some("Top speed")));
        assert_eq!(get("speed").inner(), &TypeSchema::Float { min: None, max: None, step: None });
        assert!(get("secret").meta().is_some_and(|m| m.hidden));
        assert_eq!(get("pick").meta().and_then(|m| m.choose.clone()).as_deref(), Some("rows"));
        assert!(get("rows").meta().is_none(), "no attributes, no wrapper");
        assert_eq!(type_hints(info), (Some("Gameplay"), Some("A thing with hints")));
    }

    #[test]
    fn set_inner_keeps_the_hints() {
        let mut s = TypeSchema::Field { meta: FieldMeta { tip: Some("t".into()), ..Default::default() }, inner: Box::new(TypeSchema::String) };
        set_inner(&mut s, TypeSchema::Bool);
        assert_eq!(s.inner(), &TypeSchema::Bool);
        assert!(s.meta().is_some());
        let mut plain = TypeSchema::String;
        set_inner(&mut plain, TypeSchema::Bool);
        assert_eq!(plain, TypeSchema::Bool);
    }
}
