//! First-person controller (feature `fps`). Owner: core stream (port the generic parts of
//! Shroud `player.rs`: kinematic capsule with collide-and-slide against avian colliders, walk /
//! sprint / crouch / jump, head bob hook, mouse look from [`crate::input::LookInput`], gated by
//! `not_paused`). Games spawn [`FpsController`] + their camera as a child tagged `MainCamera`.

use bevy::prelude::*;

#[derive(Component, Clone, Debug)]
pub struct FpsController {
    pub walk_speed: f32,
    pub sprint_speed: f32,
    pub crouch_speed: f32,
    pub height: f32,
    pub crouch_height: f32,
    pub radius: f32,
    pub jump_speed: f32,
}

impl Default for FpsController {
    fn default() -> Self {
        FpsController { walk_speed: 5.0, sprint_speed: 7.5, crouch_speed: 2.5, height: 1.8, crouch_height: 1.1, radius: 0.35, jump_speed: 5.0 }
    }
}

pub struct FpsPlugin;

impl Plugin for FpsPlugin {
    fn build(&self, app: &mut App) {
        let _ = app;
        todo!("core stream")
    }
}
