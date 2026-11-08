//! Camera-rig host functions (feature `camera_rigs`). `[rig,]` is an optional leading camera node;
//! without it the first [`CameraRig`] is used.
//!
//! | Function | Does |
//! |---|---|
//! | `camera_rig_set_mode([rig,] mode)` | `"chase"`, `"mounted"`, `"orbit"` or `"free"` (a cut; keeps the tuning when the mode is unchanged) |
//! | `camera_rig_get_mode([rig])` | the current mode name |
//! | `camera_rig_set_target([rig,] node)` | follow this node (null clears it) |
//! | `camera_rig_set_chase([rig,] arm_length, height)` | chase boom length and height (metres); the rig must be in chase mode |

use bevy::prelude::*;
use ruspy::embed::Engine;
use ruspy::value::Value as RV;

use super::api::{ent, f, live, s, world};
use crate::camera_rigs::{CameraRig, Chase, Free, Mounted, Orbit, RigMode};

fn rig<'a>(w: &mut World, a: &'a [RV], n: usize, usage: &str) -> Result<(Entity, &'a [RV]), String> {
    if a.len() == n + 1 {
        return Ok((live(w, ent(&a[0])?)?, &a[1..]));
    }
    if a.len() != n {
        return Err(format!("usage: {usage}"));
    }
    let e = w.query_filtered::<Entity, With<CameraRig>>().iter(w).next().ok_or("no CameraRig in the world")?;
    Ok((e, a))
}

fn get<'w>(w: &'w mut World, e: Entity) -> Result<Mut<'w, CameraRig>, String> {
    w.get_mut::<CameraRig>(e).ok_or_else(|| format!("entity {e} has no CameraRig"))
}

fn name_of(m: &RigMode) -> &'static str {
    match m {
        RigMode::Chase(_) => "chase",
        RigMode::Mounted(_) => "mounted",
        RigMode::Orbit(_) => "orbit",
        RigMode::Free(_) => "free",
    }
}

pub(super) fn register(e: &mut Engine) {
    e.register("camera_rig_set_mode", |c, a| {
        let w = world(c)?;
        let (t, r) = rig(w, a, 1, "camera_rig_set_mode([rig,] mode)")?;
        let mode = s(&r[0], "mode")?;
        let new = match mode {
            "chase" => RigMode::Chase(Chase::default()),
            "mounted" => RigMode::Mounted(Mounted::default()),
            "orbit" => RigMode::Orbit(Orbit::default()),
            "free" => RigMode::Free(Free::default()),
            other => return Err(format!("unknown rig mode `{other}` (chase, mounted, orbit, free)")),
        };
        let mut rg = get(w, t)?;
        if name_of(&rg.mode) != mode {
            rg.set_mode(new);
        }
        Ok(RV::Void)
    });
    e.register("camera_rig_get_mode", |c, a| {
        let w = world(c)?;
        let (t, _) = rig(w, a, 0, "camera_rig_get_mode([rig])")?;
        Ok(RV::Str(name_of(&get(w, t)?.mode).to_string()))
    });
    e.register("camera_rig_set_target", |c, a| {
        let w = world(c)?;
        let (t, r) = rig(w, a, 1, "camera_rig_set_target([rig,] node)")?;
        let target = match &r[0] {
            RV::Null => None,
            v => Some(live(w, ent(v)?)?),
        };
        let mut rg = get(w, t)?;
        rg.target = target;
        rg.cut();
        Ok(RV::Void)
    });
    e.register("camera_rig_set_chase", |c, a| {
        let w = world(c)?;
        let (t, r) = rig(w, a, 2, "camera_rig_set_chase([rig,] arm_length, height)")?;
        let (len, h) = (f(&r[0], "arm_length")?, f(&r[1], "height")?);
        if len <= 0.0 {
            return Err("arm_length must be positive".into());
        }
        match &mut get(w, t)?.mode {
            RigMode::Chase(ch) => {
                ch.boom = len;
                ch.height = h;
                Ok(RV::Void)
            }
            _ => Err("the rig is not in chase mode (camera_rig_set_mode(\"chase\") first)".into()),
        }
    });
}
