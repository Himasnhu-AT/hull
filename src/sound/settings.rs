//! [`SoundSettings`]: what the core settings don't cover — dialogue volume and captions. Rows
//! on the settings screen's "Audio" tab (`voice_volume`, `captions`, `caption_size`,
//! `caption_directions`), persisted to `<data>/sound.json` (debounced, and on exit).
//! The other bus volumes come from [`crate::settings::CoreSettings`] through
//! [`crate::audio::Volumes`].

use std::path::PathBuf;

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

use crate::paths::DataDir;
use crate::settings::{FieldDef, FieldKind, RegisterSettings, format_percent};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum CaptionSize {
    Small,
    #[default]
    Medium,
    Large,
}

impl CaptionSize {
    pub const ALL: [CaptionSize; 3] = [Self::Small, Self::Medium, Self::Large];
    pub fn from_index(i: usize) -> Self {
        Self::ALL[i.min(2)]
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "small" | "s" | "0" => Some(Self::Small),
            "medium" | "m" | "1" => Some(Self::Medium),
            "large" | "l" | "2" => Some(Self::Large),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
        }
    }
}

#[derive(Resource, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SoundSettings {
    /// Linear 0..1, the "voice" bus.
    pub voice_volume: f32,
    pub captions: bool,
    pub caption_size: CaptionSize,
    /// "‹" / "›" hints on captions of 3D sounds.
    pub caption_directions: bool,
}

impl Default for SoundSettings {
    fn default() -> Self {
        SoundSettings { voice_volume: 1.0, captions: false, caption_size: CaptionSize::Medium, caption_directions: true }
    }
}

/// Where [`SoundSettings`] live and the pending save.
#[derive(Resource, Debug)]
pub(crate) struct SoundSettingsFile {
    path: Option<PathBuf>,
    pending: Option<f32>,
    /// What the file holds (a save is due when the resource differs).
    saved: SoundSettings,
}

fn s(w: &World) -> &SoundSettings {
    w.resource::<SoundSettings>()
}
fn s_mut(w: &mut World) -> Mut<'_, SoundSettings> {
    w.resource_mut::<SoundSettings>()
}

pub(crate) fn build(app: &mut App) {
    let path = app.world().get_resource::<DataDir>().map(|d| d.0.join("sound.json"));
    let settings: SoundSettings = path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| {
            serde_json::from_str(&t).map_err(|e| warn!("sound: sound.json invalid ({e}); using defaults")).ok()
        })
        .unwrap_or_default();
    app.insert_resource(settings.clone())
        .insert_resource(SoundSettingsFile { path, pending: None, saved: settings })
        .add_systems(Last, save_when_due);
    app.register_setting(FieldDef {
        key: "voice_volume",
        tab: "Audio",
        label: "Dialogue",
        hint: "Character voices and radio chatter.",
        kind: FieldKind::Slider { min: 0.0, max: 1.0, step: 0.05, format: format_percent },
        get: |w| s(w).voice_volume,
        set: |w, v| s_mut(w).voice_volume = v.clamp(0.0, 1.0),
    })
    .register_setting(FieldDef {
        key: "captions",
        tab: "Audio",
        label: "Subtitles",
        hint: "Show dialogue and important sounds as text.",
        kind: FieldKind::Toggle,
        get: |w| s(w).captions as u8 as f32,
        set: |w, v| s_mut(w).captions = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "caption_size",
        tab: "Audio",
        label: "Subtitle size",
        hint: "Text size of subtitles.",
        kind: FieldKind::Choice { options: vec!["Small", "Medium", "Large"] },
        get: |w| s(w).caption_size as u8 as f32,
        set: |w, v| s_mut(w).caption_size = CaptionSize::from_index(v.round().max(0.0) as usize),
    })
    .register_setting(FieldDef {
        key: "caption_directions",
        tab: "Audio",
        label: "Sound direction",
        hint: "Arrows on subtitles of sounds to your left or right.",
        kind: FieldKind::Toggle,
        get: |w| s(w).caption_directions as u8 as f32,
        set: |w, v| s_mut(w).caption_directions = v > 0.5,
    });
}

fn save_when_due(
    settings: Res<SoundSettings>,
    mut file: ResMut<SoundSettingsFile>,
    time: Res<Time<Real>>,
    mut exit: MessageReader<AppExit>,
) {
    if settings.is_changed() && *settings != file.saved {
        file.pending = Some(crate::settings::SAVE_DEBOUNCE_SECS);
        file.saved = settings.clone();
    }
    let exiting = exit.read().count() > 0;
    let Some(t) = file.pending.as_mut() else { return };
    *t -= time.delta_secs();
    if *t > 0.0 && !exiting {
        return;
    }
    file.pending = None;
    if let Some(p) = &file.path
        && let Ok(text) = serde_json::to_string_pretty(&*settings)
        && let Err(e) = crate::paths::write_atomic(p, &text)
    {
        warn!("sound: could not save {}: {e}", p.display());
    }
}
