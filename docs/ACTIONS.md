# Actions, gamepad, accessibility (`engine::actions`, feature `actions`)

The engine's answer to Unreal Enhanced Input / Unity's Input System, plus the accessibility
options a shipped game needs. Everything is defined in Rust, saved as one-line text, and
drivable from the control port. Feature `actions` is on by default; `EnginePlugin` adds
`ActionsPlugin` (headless too: actions are evaluated headless, so `App::update()` tests work).

## Defining actions

```rust
use engine::prelude::*;                       // ActionDef, Binding, Stick, Trigger, AddAction…
use engine::bevy::input::gamepad::GamepadButton;

app.add_action(ActionDef::button("interact").label("Interact").group("Gameplay")
        .bind(Binding::key(KeyCode::KeyF))
        .bind(Binding::pad(GamepadButton::West)))
   .add_action(ActionDef::button("heavy").bind(Binding::mouse(MouseButton::Left))
        .trigger(Trigger::Hold { secs: 0.4 }))
   .add_action(ActionDef::button("save").context("global").fixed()
        .bind(Binding::key(KeyCode::KeyS).with(engine::actions::Button::Key(KeyCode::ControlLeft))))
   .add_input_context("vehicle", 10, false)
   .add_action(ActionDef::axis2d("steer").context("vehicle")
        .bind(Binding::wasd())
        .bind(Binding::stick(Stick::Left).deadzone(0.15)));

fn play(actions: Res<ActionState>, mut ctx: ResMut<InputContexts>) {
    if actions.just_pressed("interact") { ctx.push("vehicle"); }
    let steer: Vec2 = actions.axis2d("steer");
}
```

- **Kinds**: `button` (value.x 0..1), `axis1d`, `axis2d`.
- **Bindings** (several per action): `key`, `mouse`, `pad` button, `pad_axis`, `stick`,
  `mouse_motion`, `mouse_wheel`, `keys4` / `wasd` / `arrows`, `key_axis`, `dpad`. Chords:
  `.with(Button::Key(ControlLeft))` (Ctrl+S). A chorded binding *shadows* plain bindings on the
  same key while its chord is held (Shift+Tab doesn't also fire Tab).
- **Modifiers** (per binding, or per action with `ActionDef::modifier`): `Deadzone {lower,
  upper}` (radial for 2D), `Invert {x, y}`, `Scale` (sensitivity), `PerSecond` (× real dt,
  for sticks driving a per-frame delta), `Swizzle`, `Exponent` (response curve). Plus a user
  `sensitivity` per action (persisted).
- **Triggers**: `Down` (default), `Pressed`, `Released`, `Hold {secs}`, `Tap {max_secs}`,
  `DoubleTap {window}`, `Toggle`; `requires("aim")` makes a chorded action.
- **Contexts** ([`InputContexts`]): higher priority first. An active *exclusive* context hides
  every lower one; otherwise an active action *consumes* its inputs from lower contexts
  (`passthrough()` opts out). Engine contexts: `rebind` (2000, exclusive, while press-to-bind
  waits), `global` (1000, always on), `menu` (100, exclusive, on while any UI screen is open),
  `gameplay` (0, on in `AppState::InGame` with no screen open and not paused). `menu`/`gameplay`
  follow the game automatically (`set_auto(name, false)` to drive them yourself); games
  `push`/`pop` their own.
- A **button** whose context comes on while it is already held waits for a release (the Esc
  that opened the pause menu doesn't also close it); **axes** resume at once (hold W while
  getting into a vehicle and it drives). After a rebind the new key is ignored until released.
- `ActionState::last_device` / `last_gamepad`: what the player used last (button prompts,
  rumble target). `ActionMap::prompt("jump", Device::Gamepad)` → `"A"`.

Engine actions: `look` (mouse + right stick, gameplay), `pause` (Esc / Menu button,
gameplay), and the fixed menu set `ui.navigate` (arrows / WASD / d-pad / left stick, with
auto-repeat 0.38 s then every 0.11 s), `ui.accept` (Enter / Space / A), `ui.back` (Esc /
Backspace / B / Menu), `ui.next_tab` (E / Tab / RB), `ui.prev_tab` (Q / Shift+Tab / LB). With
`fps`: `move` (WASD + left stick), `sprint` (Shift / LS, toggleable), `jump` (Space / A),
`crouch` (Ctrl / C / B, toggleable).

### Engine consumers migrated

- `LookInput` (`input.rs`) = the `look` action × `CoreSettings.sensitivity` / invert Y; mouse
  look still needs the captured cursor (or a test-driven run), the stick works whenever
  gameplay is live. `look_from_motion` is unchanged.
- `FpsController` input (`fps.rs`) reads `move`/`sprint`/`jump`/`crouch`. `FpsKeys` still
  works: a game that changes it before startup gets those keys as the actions' keyboard
  defaults.
- `ChaseCamera` orbits from `LookInput`, so it gets the gamepad stick for free.
- UI navigation (`ui/widgets.rs`) reads the menu actions; footers switch to gamepad prompts
  when the gamepad was used last. Without an `ActionState` (UI tests) it falls back to fixed
  keys.

## Rebinding and persistence

- Code: `ActionMap::rebind(action, binding)` replaces the first binding of the binding's
  device family (keyboard/mouse or gamepad), `set_bindings`, `clear_device`, `reset`,
  `reset_all`, `conflicts(action, &binding)` (same-context overlaps).
- Press-to-bind: `actions::start_rebind(world, "jump", Device::Gamepad)`; the next input binds
  (keys with Ctrl/Shift/Alt held become chords; 2D keyboard actions take four presses, 1D two;
  a mouse sweep binds mouse motion; a deflected stick binds that stick). Esc or 6 s cancels.
  Modifiers of the replaced binding carry over when the input kind matches.
- UI: settings "Controls" tab → side panel with the current bindings (keyboard or gamepad,
  following the last device) and **Rebind controls** → the `controls` screen: one row per
  rebindable action, keyboard and gamepad columns, Enter (or a click on the keyboard cap)
  rebinds keyboard, A (or a click on the pad cap) rebinds gamepad, conflicts in the bad colour
  with "Also: …", **Reset all**.
- Saved in settings.json section `"input"` — only actions that differ from their defaults:
  `{"bindings": {"jump": ["key:KeyF", "pad:North"]}, "sensitivity": {"look": 1.4}}`. Unknown
  actions in the file are kept (another mode may define them).

Binding text form: `key:KeyW`, `mouse:Left`, `pad:South` (also `pad:a`, `pad:rb`…),
`padaxis:LeftStickX` (`lx`), `stick:Right`, `mouse:Motion`, `mouse:Wheel`, `dpad`,
`keys:KeyW/KeyS/KeyA/KeyD` (up/down/left/right), `keyaxis:KeyA/KeyD`; chords
`key:ControlLeft+key:KeyS`; modifiers `|deadzone(0.15,1)|scale(3,2)|invert(y)|persec|swizzle|exp(1.6)`.

## Gamepad

- Bevy 0.19 gamepads (gilrs in the default build): every connected pad is read; the strongest
  input wins. `actions::virtual_pad::{connect, button, tap, axis, disconnect}` drive a software
  pad through Bevy's real `RawGamepadEvent` path (deadzones from `GamepadSettings` apply) — used
  by tests and `input.gamepad`.
- **Rumble**: `world.write_message(Rumble::new(strong, weak, secs))` → the last used pad (or
  `gamepad: Some(e)`, else all), scaled by the accessibility `rumble` setting; 0 = off.

## Accessibility (`actions::Accessibility`, section `"accessibility"`)

| setting | row (tab) | applied by the engine |
|---|---|---|
| `text_scale` 0.8–1.6 | Text size (Interface) | Bevy `RemSize`; the UI kit's fonts are rem-based (`theme::REM_PX` = 20), so all themed text scales |
| `high_contrast` | High contrast (Interface) | swaps in `Theme::high_contrast()` (black panels, white text, yellow focus); the game's theme is restored when off |
| `colorblind` Off/Protanopia/Deuteranopia/Tritanopia, `colorblind_strength` | Colour filter, Filter strength (Interface) | full-screen pass on 3D cameras, after the UI pass (HUD and menus are filtered too) |
| `colorblind_simulate` | control port only (`ui.setting colorblind_simulate 1`) | shows what a colour-blind player sees (palette checks) |
| `reduce_motion`, `camera_shake` | Reduce motion, Camera shake (Interface) | games read `Accessibility::shake_scale()` / `motion_scale()` |
| `toggle` (+ `toggle_overrides`) | Sprint and crouch: Hold / Toggle (Controls) | `Trigger::Toggle` for every `toggleable` action |
| `rumble` 0–1 | Controller vibration (Controls) | scales `Rumble` |

Colour filter: one 3×3 matrix on linear RGB in a `FullscreenMaterial` pass
(`ui/colorblind.rs`). Correct = Machado 2009 simulation `S` + Fidaner error shift:
`c + k·E·(c − S·c)`; simulate = `mix(c, S·c, k)`. The component is removed while `Off`, so it
costs nothing then. Only 3D cameras are filtered (2D-only UI cameras aren't).

## Control commands (feature `devtools`)

| command | params | does |
|---|---|---|
| `actions.list` | – | every action (kind, context, group, trigger, bindings, labels, defaults, sensitivity) + contexts |
| `actions.state` | `action?`, `active?` | values / active / just_pressed / device, live contexts, last device, pad count |
| `actions.bind` | `action`, `binding` \| `bindings[]` \| `device` (clear) \| `reset` \| `sensitivity` | rebind (returns conflicts); saved |
| `actions.context` | `name`, `on?`, `auto?` | push/pop a context |
| `actions.rebind` | `action?`, `device?`, `cancel?` | start press-to-bind / poll the result |
| `actions.rumble` | `strong`, `weak`, `secs` | rumble (scaled) |
| `input.gamepad` | `button` + `action` tap/down/up \| `axis` + `value` \| `disconnect` | drive the virtual pad |

Accessibility rows go through the generic `ui.setting {key, value}` / `settings.get`
(`text_scale`, `high_contrast`, `colorblind`, `colorblind_strength`, `colorblind_simulate`,
`reduce_motion`, `camera_shake`, `toggle_actions`, `rumble`).

Example (`scripts/play.py` steps): `{"cmd": "input.gamepad", "params": {"button": "down"}}`,
`{"cmd": "actions.state", "params": {"active": true}}`.

## Tests

- `cargo test --lib actions` — evaluation on hand-built devices: edges, deadzones, all
  triggers, contexts (priority, consume, exclusive, held-across-switch), chords/shadowing,
  `requires`, rebind/conflicts/persist round trip, toggle mode; binding text round trip;
  colour matrices.
- `cargo test --test actions` — the real headless engine app: keyboard + virtual gamepad →
  actions, vehicle context, pause, press-to-bind (incl. held key), persistence across runs,
  reset, accessibility rows → toggle/rumble/saved, every control command; plus localization.

## Measurements (Apple M5 Pro, dev profile)

- Action evaluation (`cargo test --lib actions::tests::eval_cost -- --ignored --nocapture`,
  2 bindings per action, a third in an inactive context): **0.52 µs/frame for 16 actions,
  2.1 µs for 64, 8.0 µs for 256**. No allocation per frame (scratch vectors reused; the layout
  is rebuilt only when the map or the context list changes).
- Colour filter, `ui_gallery` in game at 1920×1080 offscreen, vsync off: GPU frame p50 3.98 ms
  off vs 3.85 ms with deuteranopia correction (difference below the noise of the GPU sampler;
  the pass is one full-screen triangle with one texture tap). Off = no pass at all.
- Text scale: a `RemSize` change re-lays out the text once; nothing per frame.

## Known limits

- Rebinding columns are keyboard/mouse + gamepad (first binding of each family); extra
  bindings are edited in code or with `actions.bind {bindings: [...]}`.
- Text scale grows text, not fixed-size boxes: at 140 %+ with long translations some segmented
  controls overflow (the pseudo-locale shows where). Layouts with `min_height` grow.
- Multiplayer device assignment (pad N → player N) is not built; all pads drive the one
  `ActionState`.
- Touch / gyro / adaptive triggers are out of scope (desktop only).
- Colour filter: 3D cameras only; 2D-only cameras are not filtered.
