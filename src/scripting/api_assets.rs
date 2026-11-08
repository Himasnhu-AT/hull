//! `spawn_asset`: cooked 3D assets from scripts (`src/assets`, docs/ASSETS.md).

use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{rent, s, v3, world};

pub(super) fn register(e: &mut Engine) {
    e.register("spawn_asset", |c, a| {
        let w = world(c)?;
        let usage = "spawn_asset(path [, position [, parent]])";
        let path = s(a.first().ok_or(usage)?, "path")?.to_string();
        let pos = match a.get(1) {
            Some(RV::Null) | None => bevy::prelude::Vec3::ZERO,
            Some(v) => v3(v, "position")?,
        };
        #[cfg(feature = "assets")]
        {
            use bevy::prelude::*;
            let id = crate::assets::spawn_world(w, &path, Transform::from_translation(pos))?;
            if let Some(p) = a.get(2).filter(|v| !matches!(v, RV::Null)) {
                let parent = super::api::live(w, super::api::ent(p)?)?;
                w.entity_mut(id).insert(ChildOf(parent));
            }
            Ok(rent(id))
        }
        #[cfg(not(feature = "assets"))]
        {
            let _ = (w, path, pos, rent);
            Err("spawn_asset needs the `assets` feature".into())
        }
    });
}
