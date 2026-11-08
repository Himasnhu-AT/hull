//! ui2 demo: an original hub screen (header, tab bar with badges, tile grid with a glowing focused
//! tile, key hints) over a dimmed 3D scene, from `assets/ui/hub.ui.ron`.
//!
//! ```text
//! cargo run --example ui2_demo --features ui2 -- --play
//! python3 -I scripts/play.py scripts/ui2-demo.json --example ui2_demo
//! ```
//! Edit `assets/ui/hub.ui.ron` or `assets/ui/tokens.ron` while it runs: both hot reload.

use engine::prelude::*;
use engine::ui2::{Ui2Cmds, UiData, UiEvent, UiEventKind};

fn main() {
    let mut app = engine::app(GameInfo::new("ui2_demo", "UI2 hub").tagline("A React-style UI on bevy_ui."));
    app.add_systems(Startup, (stage, open_hub)).add_systems(Update, log_events);
    app.run();
}

fn stage(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut materials: ResMut<Assets<StandardMaterial>>, headless: Res<Headless>) {
    if headless.0 {
        return;
    }
    commands.spawn((MainCamera, Camera3d::default(), Transform::from_xyz(0.0, 3.0, 9.0).looking_at(Vec3::new(0.0, 0.6, 0.0), Vec3::Y)));
    commands.spawn((DirectionalLight { illuminance: 14_000.0, shadow_maps_enabled: false, ..default() }, Transform::from_xyz(4.0, 8.0, 5.0).looking_at(Vec3::ZERO, Vec3::Y)));
    commands.spawn((Mesh3d(meshes.add(Plane3d::default().mesh().size(60.0, 60.0))), MeshMaterial3d(materials.add(StandardMaterial { base_color: Color::srgb(0.16, 0.2, 0.28), perceptual_roughness: 0.9, ..default() }))));
    for i in 0..7 {
        let x = (i as f32 - 3.0) * 2.2;
        let hue = i as f32 * 48.0;
        commands.spawn((
            Mesh3d(meshes.add(Cuboid::new(1.4, 1.0 + (i % 3) as f32, 1.4))),
            MeshMaterial3d(materials.add(StandardMaterial { base_color: Color::hsl(hue, 0.7, 0.55), ..default() })),
            Transform::from_xyz(x, 0.5 + (i % 3) as f32 * 0.5, -1.0 - (i % 2) as f32 * 3.0),
        ));
    }
}

fn open_hub(mut data: ResMut<UiData>, mut cmds: ResMut<Ui2Cmds>) {
    data.set("player.level", 27);
    data.set("player.credits", "248,900");
    data.set("player.tokens", 35);
    data.set("n.series", 3);
    data.set("n.garage", 1);
    data.set("n.shop", 12);
    data.set("n.lobby", 4);
    cmds.open("hub");
}

fn log_events(mut ev: MessageReader<UiEvent>) {
    for e in ev.read() {
        if matches!(e.kind, UiEventKind::Activate | UiEventKind::Tab(_)) {
            info!("ui2 event {} {:?}", e.id, e.kind);
        }
    }
}
