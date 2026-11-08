//! Script UI widget pack on show: a settings form built entirely from `assets/scripts/ui_demo.ruspy`
//! (checkbox, slider, line edit, option button, tabs, grid, scroll, margin, texture rect, tooltip).
//!
//! ```text
//! cargo run --example script_ui_demo -- --play
//! python3 -I scripts/play.py scripts/script-ui-demo.json --example script_ui_demo
//! ```

use engine::prelude::*;
use engine::scripting::Script;

fn main() {
    let mut app = engine::app(GameInfo::new("script_ui_demo", "Script UI").tagline("Every widget, from script."));
    app.add_systems(Startup, setup);
    app.run();
}

fn setup(mut commands: Commands, headless: Res<Headless>) {
    if !headless.0 {
        commands.spawn((MainCamera, Camera2d));
    }
    commands.spawn((Name::new("Form"), Node { width: Val::Percent(100.0), height: Val::Percent(100.0), ..default() }, Script::new("ui_demo.ruspy")));
}
