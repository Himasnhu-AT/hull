//! The scenery distance fade (`RenderBudget::scenery_detail`) keeps big worlds fast, but the
//! things you are working on must not fade: the selection and every road. Their meshes lose the
//! `VisibilityRange` while exempt (kept in [`Exempt`] and put back when they no longer are); the
//! flat far twin of a piece is hidden meanwhile so it does not draw over the real mesh.

use bevy::camera::visibility::VisibilityRange;
use bevy::platform::collections::HashSet;
use bevy::prelude::*;

use super::{EditorMode, EditorState};
use crate::render_budget::DetailTier;
use crate::spline::SplineRoad;

/// What an exempt mesh had before: its fade range and its visibility.
#[derive(Component)]
pub struct Exempt {
    range: Option<VisibilityRange>,
    visibility: Option<Visibility>,
}

fn descendants(world: &World, root: Entity, out: &mut HashSet<Entity>) {
    let mut stack = vec![root];
    while let Some(e) = stack.pop() {
        if out.len() > 4000 || !out.insert(e) {
            continue;
        }
        if let Some(k) = world.get::<Children>(e) {
            stack.extend(k.iter());
        }
    }
}

/// Keeps the selection and roads out of the distance fade.
pub fn exempt(world: &mut World) {
    if world.get_resource::<EditorMode>().is_none() {
        return;
    }
    let all = world.resource::<EditorState>().show_all_scenery;
    let mut want = HashSet::new();
    if !all {
        let sel = world.resource::<EditorState>().selection.clone();
        for e in sel {
            descendants(world, e, &mut want);
        }
        let roads: Vec<Entity> = world.query_filtered::<Entity, With<SplineRoad>>().iter(world).collect();
        for e in roads {
            descendants(world, e, &mut want);
        }
    }
    // Put back what is no longer wanted.
    let held: Vec<Entity> = world.query_filtered::<Entity, With<Exempt>>().iter(world).filter(|e| !want.contains(e)).collect();
    for e in held {
        let Some(old) = world.entity_mut(e).take::<Exempt>() else { continue };
        let mut em = world.entity_mut(e);
        if let Some(r) = old.range {
            em.insert(r);
        }
        match old.visibility {
            Some(v) => {
                em.insert(v);
            }
            None => {
                em.remove::<Visibility>();
            }
        }
    }
    // Take the fade off what is wanted.
    for e in want {
        let Ok(em) = world.get_entity(e) else { continue };
        if em.contains::<Exempt>() {
            continue;
        }
        let Some(range) = em.get::<VisibilityRange>().cloned() else { continue };
        let far = em.get::<DetailTier>().is_some_and(|t| *t == DetailTier::Far);
        let visibility = em.get::<Visibility>().copied();
        let mut em = world.entity_mut(e);
        em.remove::<VisibilityRange>();
        if far {
            em.insert(Visibility::Hidden);
        }
        em.insert(Exempt { range: Some(range), visibility });
    }
}
