//! UI side of the accessibility settings (feature `actions`): high-contrast theme swap.
//! Text size is applied through `RemSize` by `crate::actions::accessibility`; the colour
//! filter lives in [`super::colorblind`].

use bevy::prelude::*;

use super::theme::Theme;
use crate::actions::Accessibility;

/// The game's own theme while high contrast is on (restored when it's turned off).
#[derive(Resource, Clone, Debug)]
pub struct SavedTheme(pub Theme);

pub(crate) struct A11yUiPlugin;

impl Plugin for A11yUiPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, high_contrast.run_if(resource_exists::<Accessibility>));
    }
}

fn high_contrast(mut commands: Commands, a: Res<Accessibility>, saved: Option<Res<SavedTheme>>, mut theme: ResMut<Theme>) {
    if !a.is_changed() {
        return;
    }
    match (a.high_contrast, saved) {
        (true, None) => {
            commands.insert_resource(SavedTheme(theme.clone()));
            *theme = Theme::high_contrast();
        }
        (false, Some(s)) => {
            *theme = s.0.clone();
            commands.remove_resource::<SavedTheme>();
        }
        _ => {}
    }
}
