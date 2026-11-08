//! Text input plumbing for text fields: keyboard characters, IME composition and commit, caret
//! editing, focus. One component, [`TextInput`], that `src/ui` (and any other UI) can put on a
//! node; the engine edits it and tells you through messages.
//!
//! ```ignore
//! let field = commands.spawn((Text::new(""), TextInput::new().placeholder("Name").max_chars(24))).id();
//! // click it (needs `Interaction` on the node) or `focus.set(field)`; read `TextInputSubmitted`.
//! ```
//! If the entity has a `Text`, [`sync_text`] writes `before | preedit | caret | after` into it
//! (the placeholder when empty and unfocused). Keyboard actions keep firing while you type: gate
//! gameplay on [`typing`] (`.run_if(not(typing))`) or push an exclusive input context.
//!
//! IME: while a field has focus the window's IME is on and its candidate box is placed at the
//! node (`ime_position`); `Ime::Preedit` fills [`TextInput::preedit`] (shown, not committed),
//! `Ime::Commit` inserts at the caret. Cursor positions are `char` indices.

use bevy::input::ButtonState;
use bevy::input::keyboard::{Key, KeyboardInput};
use bevy::picking::events::PointerPress;
use bevy::prelude::*;
use bevy::window::{Ime, PrimaryWindow};

#[derive(Component, Clone, Debug, Default)]
pub struct TextInput {
    pub text: String,
    /// Caret as a `char` index into `text`.
    pub cursor: usize,
    /// IME composition in progress (not part of `text` yet).
    pub preedit: String,
    /// 0 = unlimited.
    pub max_chars: usize,
    pub multiline: bool,
    pub password: bool,
    pub placeholder: String,
}

impl TextInput {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn text(mut self, t: impl Into<String>) -> Self {
        self.set_text(t);
        self
    }
    pub fn placeholder(mut self, p: impl Into<String>) -> Self {
        self.placeholder = p.into();
        self
    }
    pub fn max_chars(mut self, n: usize) -> Self {
        self.max_chars = n;
        self
    }
    pub fn multiline(mut self) -> Self {
        self.multiline = true;
        self
    }
    pub fn password(mut self) -> Self {
        self.password = true;
        self
    }

    pub fn len_chars(&self) -> usize {
        self.text.chars().count()
    }

    fn byte(&self, char_idx: usize) -> usize {
        self.text.char_indices().nth(char_idx).map_or(self.text.len(), |(i, _)| i)
    }

    pub fn set_text(&mut self, t: impl Into<String>) {
        self.text = t.into();
        self.cursor = self.len_chars();
        self.preedit.clear();
    }

    /// Inserts at the caret (control characters dropped, newlines only when `multiline`, capped
    /// by `max_chars`). Returns whether the text changed.
    pub fn insert(&mut self, s: &str) -> bool {
        let mut changed = false;
        for c in s.chars() {
            if c == '\n' && !self.multiline || c.is_control() && c != '\n' {
                continue;
            }
            if self.max_chars > 0 && self.len_chars() >= self.max_chars {
                break;
            }
            let at = self.byte(self.cursor);
            self.text.insert(at, c);
            self.cursor += 1;
            changed = true;
        }
        changed
    }

    pub fn backspace(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        let at = self.byte(self.cursor - 1);
        self.text.remove(at);
        self.cursor -= 1;
        true
    }

    pub fn delete(&mut self) -> bool {
        if self.cursor >= self.len_chars() {
            return false;
        }
        let at = self.byte(self.cursor);
        self.text.remove(at);
        true
    }

    pub fn move_cursor(&mut self, by: i32) {
        self.cursor = (self.cursor as i64 + by as i64).clamp(0, self.len_chars() as i64) as usize;
    }

    /// What a `Text` node should show.
    pub fn display(&self, focused: bool) -> String {
        if self.text.is_empty() && self.preedit.is_empty() && !focused {
            return self.placeholder.clone();
        }
        let shown: String = if self.password { self.text.chars().map(|_| '\u{2022}').collect() } else { self.text.clone() };
        if !focused {
            return shown;
        }
        let split = shown.char_indices().nth(self.cursor).map_or(shown.len(), |(i, _)| i);
        format!("{}{}|{}", &shown[..split], self.preedit, &shown[split..])
    }
}

/// The field that receives typing (`None` = nobody).
#[derive(Resource, Default, Debug)]
pub struct TextFocus(pub Option<Entity>);

impl TextFocus {
    pub fn set(&mut self, e: Entity) {
        self.0 = Some(e);
    }
    pub fn clear(&mut self) {
        self.0 = None;
    }
}

/// Run condition: a text field has focus.
pub fn typing(focus: Res<TextFocus>) -> bool {
    focus.0.is_some()
}

#[derive(Message, Clone, Copy, Debug)]
pub struct TextInputChanged(pub Entity);

/// Enter on a single-line field (focus is released).
#[derive(Message, Clone, Copy, Debug)]
pub struct TextInputSubmitted(pub Entity);

/// Pressing a `TextInput` (or anything inside it) gives it focus.
pub(super) fn focus_on_press(ev: On<PointerPress>, fields: Query<(), With<TextInput>>, mut focus: ResMut<TextFocus>) {
    let e = ev.entity;
    if fields.contains(e) && focus.0 != Some(e) {
        focus.0 = Some(e);
    }
}

pub(super) fn edit(
    mut focus: ResMut<TextFocus>,
    mut keys: MessageReader<KeyboardInput>,
    mut ime: MessageReader<Ime>,
    mut fields: Query<&mut TextInput>,
    mut changed: MessageWriter<TextInputChanged>,
    mut submitted: MessageWriter<TextInputSubmitted>,
) {
    let Some(e) = focus.0 else {
        keys.clear();
        ime.clear();
        return;
    };
    let Ok(mut f) = fields.get_mut(e) else {
        focus.0 = None;
        return;
    };
    let mut dirty = false;
    for ev in ime.read() {
        match ev {
            Ime::Preedit { value, .. } => {
                f.preedit = value.clone();
                dirty = true;
            }
            Ime::Commit { value, .. } => {
                f.preedit.clear();
                f.insert(value);
                dirty = true;
            }
            _ => {}
        }
    }
    let mut text_changed = dirty;
    for ev in keys.read() {
        if ev.state != ButtonState::Pressed {
            continue;
        }
        match &ev.logical_key {
            Key::Backspace => text_changed |= f.backspace(),
            Key::Delete => text_changed |= f.delete(),
            Key::ArrowLeft => f.move_cursor(-1),
            Key::ArrowRight => f.move_cursor(1),
            Key::Home => f.cursor = 0,
            Key::End => f.cursor = f.len_chars(),
            Key::Escape => focus.0 = None,
            Key::Enter if !f.multiline => {
                submitted.write(TextInputSubmitted(e));
                focus.0 = None;
            }
            _ => {
                // While an IME composes, the committed text arrives as Ime::Commit, not here.
                if f.preedit.is_empty()
                    && let Some(t) = &ev.text
                {
                    text_changed |= f.insert(t);
                }
            }
        }
        if focus.0.is_none() {
            break;
        }
    }
    if text_changed {
        changed.write(TextInputChanged(e));
    }
}

/// IME on while a field has focus; the candidate window sits at the field.
pub(super) fn window_ime(
    focus: Res<TextFocus>,
    nodes: Query<&bevy::ui::UiGlobalTransform>,
    mut windows: Query<&mut Window, With<PrimaryWindow>>,
) {
    let Ok(mut w) = windows.single_mut() else { return };
    let on = focus.0.is_some();
    if w.ime_enabled != on {
        w.ime_enabled = on;
    }
    if let Some(e) = focus.0
        && let Ok(t) = nodes.get(e)
    {
        let p = t.translation;
        let scale = w.resolution.scale_factor();
        let pos = Vec2::new(p.x, p.y) / scale;
        if w.ime_position != pos {
            w.ime_position = pos;
        }
    }
}

pub(super) fn sync_text(focus: Res<TextFocus>, mut q: Query<(Entity, Ref<TextInput>, &mut Text)>, mut last: Local<Option<Entity>>) {
    let focus_changed = focus.is_changed() || *last != focus.0;
    *last = focus.0;
    for (e, f, mut t) in &mut q {
        if focus_changed || f.is_changed() {
            let s = f.display(focus.0 == Some(e));
            if t.0 != s {
                t.0 = s;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editing_is_char_based() {
        let mut f = TextInput::new().max_chars(6);
        assert!(f.insert("héllo"));
        f.move_cursor(-2);
        f.insert("X");
        assert_eq!(f.text, "hélXlo");
        assert!(!f.insert("more"), "capped at max_chars");
        assert!(f.backspace());
        assert_eq!((f.text.as_str(), f.cursor), ("héllo", 3));
        f.cursor = 0;
        assert!(f.delete() && !f.backspace());
        assert_eq!(f.text, "éllo");
        f.move_cursor(99);
        assert_eq!(f.cursor, 4);
    }

    #[test]
    fn control_chars_and_newlines() {
        let mut f = TextInput::new();
        f.insert("a\nb\u{7}");
        assert_eq!(f.text, "ab");
        let mut m = TextInput::new().multiline();
        m.insert("a\nb");
        assert_eq!(m.text, "a\nb");
    }

    #[test]
    fn display_shows_caret_preedit_placeholder_and_masks() {
        let mut f = TextInput::new().placeholder("Name");
        assert_eq!(f.display(false), "Name");
        assert_eq!(f.display(true), "|");
        f.insert("ab");
        f.move_cursor(-1);
        f.preedit = "か".into();
        assert_eq!(f.display(true), "aか|b");
        assert_eq!(f.display(false), "ab");
        let p = TextInput::new().password().text("abc");
        assert_eq!(p.display(false), "\u{2022}\u{2022}\u{2022}");
    }

    #[test]
    fn ime_and_keys_edit_the_focused_field() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .init_resource::<TextFocus>()
            .add_message::<KeyboardInput>()
            .add_message::<Ime>()
            .add_message::<TextInputChanged>()
            .add_message::<TextInputSubmitted>()
            .add_systems(Update, edit);
        let e = app.world_mut().spawn(TextInput::new()).id();
        let win = app.world_mut().spawn_empty().id();
        app.world_mut().resource_mut::<TextFocus>().set(e);
        app.world_mut().write_message(Ime::Preedit { window: win, value: "ni".into(), cursor: None });
        app.update();
        assert_eq!(app.world().get::<TextInput>(e).unwrap().preedit, "ni");
        app.world_mut().write_message(Ime::Commit { window: win, value: "你".into() });
        app.update();
        let f = app.world().get::<TextInput>(e).unwrap();
        assert_eq!((f.text.as_str(), f.preedit.as_str()), ("你", ""));
        let key = |logical: Key, text: Option<&str>| KeyboardInput {
            key_code: KeyCode::KeyA,
            logical_key: logical,
            state: ButtonState::Pressed,
            text: text.map(Into::into),
            repeat: false,
            window: win,
        };
        app.world_mut().write_message(key(Key::Character("a".into()), Some("a")));
        app.update();
        assert_eq!(app.world().get::<TextInput>(e).unwrap().text, "你a");
        app.world_mut().write_message(key(Key::Backspace, None));
        app.world_mut().write_message(key(Key::Enter, None));
        app.update();
        assert_eq!(app.world().get::<TextInput>(e).unwrap().text, "你");
        assert_eq!(app.world().resource::<TextFocus>().0, None, "enter submits and releases focus");
    }
}
