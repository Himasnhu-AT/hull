# Platform: the game talking to the local PC

`src/platform/`, feature `platform` (default on; only std and the `image` crate that devkit already
builds, nothing runs unless used). A skeleton: every piece is small, standalone and swappable.
macOS is the tested path; Windows and Linux are compiled and best effort.

| Piece | File | What | Swap / extend |
|---|---|---|---|
| User folders | `dirs.rs` | `GameFolders`: Pictures, Documents, Videos, Desktop, Saved Games, each with a `<game title>` subfolder | `UserDirs::new(os, home)`; `--platform-root <dir>` / env `PLATFORM_ROOT` redirects all of them |
| Image metadata | `imgmeta.rs` | PNG `iTXt` chunks and JPEG `COM` segments: add + read arbitrary key/values | add EXIF/XMP by writing another segment here |
| Screenshots | `shots.rs` | `save_png(...)`, message `SaveScreenshot` -> `ScreenshotSaved` | change the default keys |
| OS services | `os.rs` | `Platform` resource (`OsServices` trait): open in file browser, open URL, clipboard, notification, file open/save dialog | `Platform::set(MyOs)`; `NullOs` for tests |
| Window | `window.rs` | `WindowSettings` (persisted, section `window`): mode, monitor, size, DPI scale override, vsync, cursor | set `override_core` for your own display menu |
| Text input | `text.rs` | `TextInput`, `TextFocus`, IME preedit / commit, `typing` run condition | render with any UI |
| Prompts | `glyphs.rs` | `Glyphs` / `glyph` / `hint_bar`: action -> text and icon id for the device in use | map icon ids to sprites |
| Lifecycle | `lifecycle.rs` | `FocusPolicy` + `AppFocusChanged`, `SingleInstance` | `platform::single_instance(&mut app)` |

## Quick start

```rust
fn save_view(folders: Res<GameFolders>, mut shots: MessageWriter<SaveScreenshot>) {
    // Pictures/<Game>/view.png with the key/values embedded (readable with imgmeta::png_read_text)
    shots.write(SaveScreenshot::new("view").meta("seed", "42").meta("place", "ridge"));
    let _dir = folders.path(UserDir::SavedGames); // <app data>/<Game>
}
fn copy(os: Res<Platform>) { os.clipboard_set("hello").ok(); os.open_path(&folders.ensure(UserDir::Pictures).unwrap()).ok(); }
```

Example: `examples/platform_demo.rs` (UI with the info, a text field, three buttons);
`python3 -I scripts/play.py scripts/platform-demo.json --example platform_demo -- --platform-root /tmp/platform-demo`.

## Folders

`GameFolders::path(dir)` is `<OS folder>/<sanitised game title>`; `ensure` creates it; `unique_file`
picks `name.png`, `name-2.png`, ... Layout per OS: macOS `~/Pictures`, `~/Documents`, `~/Movies`,
Saved Games = `~/Library/Application Support`; Windows `%USERPROFILE%\Pictures`..., `Saved Games`;
Linux reads `~/.config/user-dirs.dirs` (`XDG_PICTURES_DIR`...), Saved Games = `$XDG_DATA_HOME`
(or `~/.local/share`). The engine's own data dir (settings, saves) is unchanged (`DataDir`).

## Metadata

PNG values are stored as UTF-8 `iTXt`, so any text survives; keys are 1..79 chars. Readers that
only know `tEXt` still see none of it, tools that read iTXt (exiftool, ImageMagick `identify -verbose`)
see all of it. JPEG: one `COM` segment per `key=value`. Encoding JPEG pixels is not included (the
`image` jpeg feature would add a decoder): encode yourself and call `jpeg_add_comments`.
Default screenshot keys: `Software`, `game`, `version`, `captured_unix`, then yours.

## OS services

No crates: each OS implementation shells out. macOS: `open` (`-R` reveals a file), `pbcopy` /
`pbpaste`, `osascript` (notifications and the native open / save dialogs). Windows: `explorer`,
`clip`, PowerShell (clipboard read, balloon notification, WinForms dialogs). Linux: `xdg-open`,
`wl-copy` / `xclip`, `notify-send`, `zenity`. `pick_file` / `save_file` return `Ok(None)` when the
user cancels and block until the dialog closes (a frozen frame; run it in an `AsyncComputeTaskPool`
task if that matters). A crate-backed implementation (`arboard`, `rfd`, `notify-rust`) is a drop-in
`OsServices` impl. Headless and `--offscreen` runs get `NullOs` (an in-memory clipboard, an action
log) so scripted runs never open Finder windows; `PLATFORM_NATIVE=1` forces the real one.

## Window

`WindowSettings` is persisted in `settings.json` (`"window"`). Until `override_core` is true the mode
and vsync come from `CoreSettings` (the stock settings screen). `monitor` picks the monitor for
borderless / fullscreen, `size` the windowed size (logical px), `scale_override` forces the DPI
factor, `cursor` is `Auto` (game decides), `Free`, `Hidden`, `Locked` (mouse look) or `Confined`
(not on macOS). Applied when it changes. `WindowInfo` has the live scale, physical size, focus and
monitor names. Test-driven runs (`--offscreen`, `--headless`) never change window mode.

## Text input and IME

Put `TextInput` on a UI node (pressing it takes focus) or call
`TextFocus::set(entity)`. Characters, Backspace/Delete, arrows, Home/End, Enter (submit, single
line), Escape (blur) and IME preedit / commit are handled; messages `TextInputChanged` and
`TextInputSubmitted`. With a `Text` on the same entity the caret and composition are drawn into it
(`before` + preedit + `|` + `after`). While focused the window's IME is enabled and its candidate
box is placed at the node. Gameplay actions still fire while typing: use `.run_if(not(typing))`.
`src/ui` widgets can read `TextInput::text` directly; there is no styled text-field widget yet.

## Prompts

`glyph(map, "jump", Device::Gamepad, PadFamily::PlayStation)` -> `Glyph { text: "Cross", icon:
"pad.ps.cross" }`. `Glyphs` (a `SystemParam`) uses `ActionState::last_device` and `PadStyle` (set
from the controller's vendor id, or by hand). Icon ids: `key.<name>`, `mouse.left`, `mouse.move`,
`pad.<xbox|ps|switch>.<button>`, `stick.left|right`, `dpad`. `hint_bar` joins `[Space] Jump   [E] Use`.

## Lifecycle

`FocusPolicy { pause_on_focus_loss: true, resume_on_focus: false }` pauses (only `InGame`, only if
it was not paused already) when the window loses focus; `AppFocusChanged(bool)` is sent either way
for muting, saving, releasing the cursor. `SingleInstance::acquire(dir, id)` takes an exclusive
file lock (`std::fs::File::try_lock`, released by the OS if the process dies);
`platform::single_instance(&mut app)` (call right after `engine::app(..)`) takes it for the game
and exits with a message if another copy runs (`--allow-multiple` skips it).

## Control commands

`platform.info`, `platform.clipboard {text?}`, `platform.open {path | dir}`, `platform.notify
{title, body?}`, `platform.window {merge patch}`, `platform.glyph {action, device?, family?}`,
`platform.screenshot {name?, meta?}`.

## Scripts (ruspy)

`user_dir`, `game_dir`, `open_path`, `open_url`, `clipboard_get`, `clipboard_set`, `notify`,
`get_glyph`, `get_glyph_icon`, `hint_bar`, `save_screenshot`, `set_window_mode`, `get_window_mode`,
`set_cursor_mode`, `text_get`, `text_set`, `text_focus` (docs/SCRIPTING.md, "OS integration").

## Tests

`cargo test --lib platform` (folders per OS and root override, PNG / JPEG metadata round trip and
validity, null OS, window mode resolution and serde, glyph lookup and rebinding, text editing and
IME messages, focus pause policy, single-instance lock). Settings persistence goes through the
generic `add_settings_section` path (`settings::tests`).

## Known limits

macOS-only verified; Windows / Linux commands are untested. Dialogs and `pbpaste` block. Cursor
`Confined` is a no-op on macOS. IME candidate placement uses the node's UI position at the
window's scale, not tested with a real IME. No clipboard images, no drag-and-drop, no
URL-scheme / file-association registration, no joystick hot-plug notifications beyond Bevy's.
