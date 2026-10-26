//! A software gamepad for tests and the control port (`input.gamepad`). It goes through Bevy's
//! real path: `RawGamepadEvent` → `gamepad_event_processing_system` → `Gamepad`, so everything
//! downstream (actions, deadzones from `GamepadSettings`) behaves as with a real pad.
//!
//! ```ignore
//! let pad = virtual_pad::connect(app.world_mut());
//! virtual_pad::button(app.world_mut(), GamepadButton::South, 1.0);
//! virtual_pad::axis(app.world_mut(), GamepadAxis::LeftStickY, 0.8);
//! app.update();
//! ```

use bevy::input::gamepad::{
    Gamepad, GamepadAxis, GamepadButton, GamepadConnection, GamepadConnectionEvent, RawGamepadAxisChangedEvent,
    RawGamepadButtonChangedEvent, RawGamepadEvent,
};
use bevy::prelude::*;

/// The virtual pad's entity, once connected; and buttons to release next frame (`tap`).
#[derive(Resource, Default, Debug)]
pub struct VirtualPad {
    pub entity: Option<Entity>,
    taps: Vec<GamepadButton>,
}

/// Connect the virtual pad (idempotent). Usable in the same frame.
pub fn connect(world: &mut World) -> Entity {
    if let Some(e) = world.get_resource::<VirtualPad>().and_then(|v| v.entity)
        && world.get::<Gamepad>(e).is_some()
    {
        return e;
    }
    let e = world.spawn((Name::new("Virtual gamepad"), Gamepad::default())).id();
    world.get_resource_or_init::<VirtualPad>().entity = Some(e);
    if world.contains_resource::<Messages<GamepadConnectionEvent>>() {
        world.write_message(GamepadConnectionEvent::new(
            e,
            GamepadConnection::Connected { name: "Virtual gamepad".into(), vendor_id: None, product_id: None },
        ));
    }
    e
}

/// Disconnect (removes `Gamepad`, keeps the entity like Bevy does).
pub fn disconnect(world: &mut World) {
    if let Some(e) = world.get_resource::<VirtualPad>().and_then(|v| v.entity) {
        world.entity_mut(e).remove::<Gamepad>();
        if world.contains_resource::<Messages<GamepadConnectionEvent>>() {
            world.write_message(GamepadConnectionEvent::new(e, GamepadConnection::Disconnected));
        }
    }
}

fn raw(world: &mut World, ev: RawGamepadEvent) -> Result<(), String> {
    if !world.contains_resource::<Messages<RawGamepadEvent>>() {
        return Err("no gamepad input in this app (bevy InputPlugin missing)".into());
    }
    world.write_message(ev);
    Ok(())
}

/// Set a button's analog value (0 = released, 1 = fully pressed).
pub fn button(world: &mut World, b: GamepadButton, value: f32) -> Result<Entity, String> {
    let e = connect(world);
    raw(world, RawGamepadEvent::Button(RawGamepadButtonChangedEvent::new(e, b, value.clamp(0.0, 1.0))))?;
    Ok(e)
}

/// Press now, release next frame.
pub fn tap(world: &mut World, b: GamepadButton) -> Result<Entity, String> {
    let e = button(world, b, 1.0)?;
    world.resource_mut::<VirtualPad>().taps.push(b);
    Ok(e)
}

/// Set an axis (-1..1).
pub fn axis(world: &mut World, a: GamepadAxis, value: f32) -> Result<Entity, String> {
    let e = connect(world);
    raw(world, RawGamepadEvent::Axis(RawGamepadAxisChangedEvent::new(e, a, value.clamp(-1.0, 1.0))))?;
    Ok(e)
}

/// `First`: release what `tap` pressed last frame.
pub(crate) fn release_taps(world: &mut World) {
    let taps = std::mem::take(&mut world.resource_mut::<VirtualPad>().taps);
    for b in taps {
        let _ = button(world, b, 0.0);
    }
}
