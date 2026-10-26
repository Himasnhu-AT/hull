//! Captions / subtitles: cues with a [`Caption`] push a line when they start. The queue always
//! runs (so tests and `sound.captions` can inspect it); the on-screen panel (bottom centre,
//! engine UI kit) shows when [`SoundSettings::captions`] is on, sized by `caption_size`, with
//! optional direction hints ("‹" / "›") for 3D sounds.

use std::borrow::Cow;
use std::collections::VecDeque;

use bevy::prelude::*;

use super::cue::{Caption, CaptionKind};
use super::settings::{CaptionSize, SoundSettings};
use super::voice::{VoiceId, Voices};

/// One line on screen.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptionLine {
    pub text: Cow<'static, str>,
    pub speaker: Option<Cow<'static, str>>,
    pub kind: CaptionKind,
    /// Seconds left.
    pub remaining: f32,
    pub voice: Option<VoiceId>,
    /// −1 left .. 1 right for 3D sources.
    pub pan: Option<f32>,
}

impl CaptionLine {
    /// −1 / 0 / 1: which side indicator to show.
    pub fn side(&self) -> i8 {
        match self.pan {
            Some(p) if p < -0.35 => -1,
            Some(p) if p > 0.35 => 1,
            _ => 0,
        }
    }

    /// The text as shown (without the speaker label).
    pub fn display(&self, directions: bool) -> String {
        let body = match self.kind {
            CaptionKind::Speech => self.text.to_string(),
            CaptionKind::Sound => format!("[{}]", self.text),
        };
        match (directions, self.side()) {
            (true, -1) => format!("\u{2039} {body}"),
            (true, 1) => format!("{body} \u{203a}"),
            _ => body,
        }
    }
}

/// The caption queue (newest last).
#[derive(Resource, Debug)]
pub struct Captions {
    pub lines: VecDeque<CaptionLine>,
    pub max_lines: usize,
    /// Bumped whenever what's shown changes (the UI rebuilds only then).
    pub generation: u64,
}

impl Default for Captions {
    fn default() -> Self {
        Captions { lines: VecDeque::with_capacity(4), max_lines: 3, generation: 0 }
    }
}

impl Captions {
    /// Show a caption for `secs`. The same text already on screen is refreshed, not repeated;
    /// beyond `max_lines` the oldest goes.
    pub fn push(&mut self, c: &Caption, voice: Option<VoiceId>, secs: f32, pan: Option<f32>) {
        self.generation += 1;
        if let Some(l) = self.lines.iter_mut().find(|l| l.text == c.text && l.speaker == c.speaker) {
            l.remaining = l.remaining.max(secs);
            l.voice = voice;
            l.pan = pan;
            return;
        }
        while self.lines.len() >= self.max_lines.max(1) {
            self.lines.pop_front();
        }
        self.lines.push_back(CaptionLine { text: c.text.clone(), speaker: c.speaker.clone(), kind: c.kind, remaining: secs, voice, pan });
    }

    /// Age lines by `dt`, drop expired ones, follow 3D sources' direction.
    pub fn tick(&mut self, dt: f32, pan_of: impl Fn(VoiceId) -> Option<f32>) {
        if self.lines.is_empty() {
            return;
        }
        let before = self.lines.len();
        let mut moved = false;
        for l in &mut self.lines {
            l.remaining -= dt;
            if let (Some(v), Some(_)) = (l.voice, l.pan)
                && let Some(p) = pan_of(v)
            {
                let side = l.side();
                l.pan = Some(p);
                moved |= l.side() != side;
            }
        }
        self.lines.retain(|l| l.remaining > 0.0);
        if moved || self.lines.len() != before {
            self.generation += 1;
        }
    }

    pub fn clear(&mut self) {
        if !self.lines.is_empty() {
            self.lines.clear();
            self.generation += 1;
        }
    }
}

pub(crate) fn tick_captions(time: Res<Time<Real>>, voices: Res<Voices>, mut captions: ResMut<Captions>) {
    if captions.lines.is_empty() {
        return;
    }
    captions.tick(time.delta_secs(), |v| voices.pan_of(v));
}

#[derive(Component)]
pub(crate) struct CaptionRoot;

/// Rebuilds the caption panel when the queue or the settings change.
pub(crate) fn captions_ui(
    mut commands: Commands,
    captions: Res<Captions>,
    settings: Res<SoundSettings>,
    theme: Res<crate::ui::theme::Theme>,
    roots: Query<Entity, With<CaptionRoot>>,
    mut shown: Local<Option<u64>>,
) {
    let key = captions.generation ^ ((settings.captions as u64) << 62) ^ ((settings.caption_size as u64) << 58) ^ ((settings.caption_directions as u64) << 56);
    if *shown == Some(key) && !settings.is_changed() {
        return;
    }
    *shown = Some(key);
    for e in &roots {
        commands.entity(e).despawn();
    }
    if !settings.captions || captions.lines.is_empty() {
        return;
    }
    use crate::ui::theme::{body, body_bold, text};
    let size = match settings.caption_size {
        CaptionSize::Small => 20.0,
        CaptionSize::Medium => 26.0,
        CaptionSize::Large => 34.0,
    };
    let t = &*theme;
    commands
        .spawn((
            CaptionRoot,
            Name::new("Captions"),
            Node {
                position_type: PositionType::Absolute,
                bottom: percent(7),
                left: percent(10),
                width: percent(80),
                flex_direction: FlexDirection::Column,
                align_items: AlignItems::Center,
                row_gap: px(6),
                ..default()
            },
            GlobalZIndex(30),
            Pickable::IGNORE,
        ))
        .with_children(|root| {
            for l in &captions.lines {
                root.spawn((
                    Node {
                        column_gap: px(10),
                        padding: UiRect::new(px(16), px(16), px(6), px(6)),
                        border_radius: BorderRadius::all(px(6)),
                        align_items: AlignItems::Baseline,
                        ..default()
                    },
                    BackgroundColor(Color::srgba(0.0, 0.0, 0.0, 0.62)),
                    Pickable::IGNORE,
                ))
                .with_children(|row| {
                    if let Some(s) = &l.speaker {
                        row.spawn(text(format!("{}:", s.to_uppercase()), body_bold(size * 0.85), t.accent));
                    }
                    let color = if l.kind == CaptionKind::Sound { t.text_muted } else { t.text };
                    row.spawn(text(l.display(settings.caption_directions), body(size), color));
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_limits_dedupes_and_expires() {
        let mut c = Captions::default();
        for i in 0..5 {
            c.push(&Caption::speech("A", format!("line {i}")), None, 2.0, None);
        }
        assert_eq!(c.lines.len(), 3);
        assert_eq!(c.lines[0].text, "line 2", "oldest dropped");
        let g = c.generation;
        c.push(&Caption::speech("A", "line 4"), None, 5.0, None);
        assert_eq!(c.lines.len(), 3, "same text refreshed, not repeated");
        assert_eq!(c.lines[2].remaining, 5.0);
        assert!(c.generation > g);
        c.tick(2.5, |_| None);
        assert_eq!(c.lines.len(), 1);
        c.tick(3.0, |_| None);
        assert!(c.lines.is_empty());
    }

    #[test]
    fn direction_hint_follows_the_source() {
        let mut c = Captions::default();
        c.push(&Caption::sound("Footsteps"), Some(VoiceId(9)), 3.0, Some(0.0));
        assert_eq!(c.lines[0].display(true), "[Footsteps]");
        let g = c.generation;
        c.tick(0.1, |_| Some(-0.9));
        assert_eq!(c.lines[0].display(true), "\u{2039} [Footsteps]");
        assert_eq!(c.lines[0].display(false), "[Footsteps]");
        assert!(c.generation > g, "side change rebuilds the UI");
    }
}
