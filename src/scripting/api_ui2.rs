//! ui2 from script (feature `ui2`): open screens, set / read the data store screens bind to, and
//! react to component events.
//!
//! `ui_open(name)`, `ui_back()`, `ui_data_set(key, value)`, `ui_data_get(key)`,
//! `ui_on(event_id, method)`: calls `method(kind, arg)` on this node's script when the component
//! with that `id` fires (`"*"` = every id). `kind` is `"activate"`, `"focus"`, `"tab"` (arg = index),
//! `"toggle"` (arg = bool), `"slide"` (arg = value) or `"back"`.

#[cfg(feature = "ui2")]
mod imp {
    use super::super::api::{me, s, world};
    use bevy::ecs::message::MessageCursor;
    use bevy::prelude::*;
    use ruspy::embed::Engine;
    use ruspy::value::Value as RV;

    use super::super::{ScriptSet, call_rv, rv_of_json_exact, runs_now, tree_paused};
    use crate::ui2::{Ui2Cmds, UiData, UiEvent, UiEventKind};

    /// `(event id, script entity, method)` registered by `ui_on`.
    #[derive(Resource, Default)]
    pub struct Ui2Handlers(pub Vec<(String, Entity, String)>);

    pub(in crate::scripting) fn plugin(app: &mut App) {
        app.init_resource::<Ui2Handlers>().add_systems(Update, dispatch.after(crate::ui2::Ui2Set::Screens).in_set(ScriptSet::Events));
    }

    fn dispatch(world: &mut World, mut cursor: Local<MessageCursor<UiEvent>>) {
        let events: Vec<UiEvent> = match world.get_resource::<Messages<UiEvent>>() {
            Some(m) => cursor.read(m).cloned().collect(),
            None => return,
        };
        if events.is_empty() {
            return;
        }
        let handlers = world.resource::<Ui2Handlers>().0.clone();
        let paused = tree_paused(world);
        for ev in events {
            let (kind, arg) = match &ev.kind {
                UiEventKind::Activate => ("activate", RV::Null),
                UiEventKind::Focus => ("focus", RV::Null),
                UiEventKind::Back => ("back", RV::Null),
                UiEventKind::Tab(i) => ("tab", RV::Int(*i as i64)),
                UiEventKind::Toggle(b) => ("toggle", RV::Bool(*b)),
                UiEventKind::Slide(v) => ("slide", RV::Float(*v as f64)),
            };
            for (id, e, method) in &handlers {
                if (id == "*" || *id == ev.id) && world.get_entity(*e).is_ok() && runs_now(world, *e, paused) {
                    let _ = call_rv(world, *e, method, vec![RV::Str(kind.into()), arg.clone()]);
                }
            }
        }
    }

    fn json_of(v: &RV) -> Result<serde_json::Value, String> {
        Ok(match v {
            RV::Int(i) => (*i).into(),
            RV::Float(f) => (*f).into(),
            RV::Bool(b) => (*b).into(),
            RV::Str(t) => t.clone().into(),
            RV::Null | RV::Void => serde_json::Value::Null,
            other => return Err(format!("ui_data_set takes a number, bool, str or null, got {}", other.type_name())),
        })
    }

    pub(in crate::scripting) fn register(e: &mut Engine) {
        e.register("ui_open", |c, a| {
            let name = s(a.first().ok_or("usage: ui_open(name)")?, "name")?.to_string();
            world(c)?.resource_mut::<Ui2Cmds>().open(&name);
            Ok(RV::Void)
        });
        e.register("ui_back", |c, _| {
            world(c)?.resource_mut::<Ui2Cmds>().back();
            Ok(RV::Void)
        });
        e.register("ui_data_set", |c, a| {
            if a.len() != 2 {
                return Err("usage: ui_data_set(key, value)".into());
            }
            let v = json_of(&a[1])?;
            world(c)?.resource_mut::<UiData>().set(s(&a[0], "key")?, v);
            Ok(RV::Void)
        });
        e.register("ui_data_get", |c, a| {
            let key = s(a.first().ok_or("usage: ui_data_get(key)")?, "key")?;
            Ok(world(c)?.resource::<UiData>().get(key).map_or(RV::Null, rv_of_json_exact))
        });
        e.register("ui_on", |c, a| {
            if a.len() != 2 {
                return Err("usage: ui_on(event_id, method)".into());
            }
            let w = world(c)?;
            let e = me(w)?;
            let (id, m) = (s(&a[0], "event_id")?.to_string(), s(&a[1], "method")?.to_string());
            let mut h = w.resource_mut::<Ui2Handlers>();
            if !h.0.iter().any(|x| x.0 == id && x.1 == e && x.2 == m) {
                h.0.push((id, e, m));
            }
            Ok(RV::Void)
        });
    }
}

#[cfg(feature = "ui2")]
pub(super) use imp::{plugin, register};

#[cfg(not(feature = "ui2"))]
pub(super) fn register(e: &mut ruspy::embed::Engine) {
    for name in ["ui_open", "ui_back", "ui_data_set", "ui_data_get", "ui_on"] {
        e.register(name, |_, _| Err("ui2 needs the `ui2` feature".into()));
    }
}
