//! Types a level can place: the editor's Place palette lists them, and placing one spawns a
//! `LevelEntity` with `Name`, `Transform` and the type's default value.
//!
//! ```ignore
//! app.register_type::<EventStart>()
//!     .register_placeable::<EventStart>("Event start", "flag", "Gameplay");
//! ```
//!
//! The component must be `Reflect` (registered, `#[reflect(Component, Default)]`) so the editor
//! can show and edit it in Details and the level file can save it.

use bevy::prelude::*;

use super::{LevelEntity, new_stable_id};

/// One entry of the Place palette.
#[derive(Clone, Debug)]
pub struct Placeable {
    /// Label in the palette, e.g. "Event start".
    pub name: String,
    /// Icon name (the editor maps names to glyphs; unknown names show a generic marker).
    pub icon: String,
    /// Palette group, e.g. "Gameplay", "Lights".
    pub category: String,
    /// Reflect type path of the component (`T::type_path()`).
    pub type_path: &'static str,
    spawn: fn(&mut World, Transform, &str) -> Entity,
}

impl Placeable {
    /// Spawns the type at `at` as a new level entity named `name` and returns it.
    pub fn spawn(&self, world: &mut World, at: Transform, name: &str) -> Entity {
        (self.spawn)(world, at, name)
    }
}

/// Every placeable type the game registered, in registration order.
#[derive(Resource, Default, Clone, Debug)]
pub struct Placeables(pub Vec<Placeable>);

impl Placeables {
    pub fn get(&self, type_path: &str) -> Option<&Placeable> {
        self.0.iter().find(|p| p.type_path == type_path)
    }
}

fn spawn_default<T: Component + Default>(world: &mut World, at: Transform, name: &str) -> Entity {
    let id = new_stable_id(world);
    world.spawn((T::default(), Name::new(name.to_string()), at, Visibility::default(), LevelEntity { id })).id()
}

pub trait RegisterPlaceable {
    /// Lists `T` in the editor's Place palette. Registering the same type twice keeps the
    /// first entry.
    fn register_placeable<T: Component + Default + TypePath>(&mut self, name: &str, icon: &str, category: &str) -> &mut Self;
}

impl RegisterPlaceable for App {
    fn register_placeable<T: Component + Default + TypePath>(&mut self, name: &str, icon: &str, category: &str) -> &mut Self {
        let world = self.world_mut();
        world.init_resource::<Placeables>();
        let mut list = world.resource_mut::<Placeables>();
        if list.get(T::type_path()).is_none() {
            list.0.push(Placeable {
                name: name.to_string(),
                icon: icon.to_string(),
                category: category.to_string(),
                type_path: T::type_path(),
                spawn: spawn_default::<T>,
            });
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Component, Reflect, Default)]
    #[reflect(Component, Default)]
    struct Flag {
        label: String,
    }

    #[test]
    fn registered_types_spawn_as_level_entities() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins).add_plugins(super::super::LevelPlugin);
        app.register_type::<Flag>().register_placeable::<Flag>("Flag", "flag", "Gameplay").register_placeable::<Flag>("Again", "x", "y");
        let list = app.world().resource::<Placeables>().clone();
        assert_eq!(list.0.len(), 1, "registered once");
        let p = list.get(Flag::type_path()).expect("listed");
        assert_eq!((p.name.as_str(), p.category.as_str()), ("Flag", "Gameplay"));
        let e = p.spawn(app.world_mut(), Transform::from_xyz(1.0, 2.0, 3.0), "Start A");
        let w = app.world();
        assert!(w.get::<Flag>(e).is_some());
        assert_eq!(w.get::<Name>(e).map(|n| n.as_str()), Some("Start A"));
        assert_eq!(w.get::<Transform>(e).map(|t| t.translation), Some(Vec3::new(1.0, 2.0, 3.0)));
        let a = w.get::<LevelEntity>(e).map(|l| l.id);
        let e2 = p.spawn(app.world_mut(), Transform::IDENTITY, "Start B");
        assert_ne!(app.world().get::<LevelEntity>(e2).map(|l| l.id), a, "fresh stable ids");
    }
}
