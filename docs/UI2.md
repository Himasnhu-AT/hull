# UI2: React-style UI library (`engine::ui2`, feature `ui2`)

A game-agnostic component layer on bevy_ui: **design tokens** as data, **components** with props,
local state and events, **declarative screens** (`assets/ui/*.ui.ron`) with hot reload, **spatial
focus** for pad and keyboard, **transitions**, a **data store** screens bind to, and **ruspy**
bindings. It sits next to `src/ui` (the settings/menu kit) and reuses its fonts and `Theme`
(`Tokens::from_theme`); nothing there changed. Opt-in feature, not in `default`.

Demo: `examples/ui2_demo.rs` with `assets/ui/{hub,options,confirm}.ui.ron`:
`python3 -I scripts/play.py scripts/ui2-demo.json --example ui2_demo --features ui2` (screenshots
`hub`, `hub-focus`, `hub-tab`, `options`, `modal`). All art is original (gradients + shapes).

## Quick start

```rust
app.add_plugins(...);                     // `engine::app` adds Ui2Plugin when the feature is on
// startup:
data.set("player.credits", "248,900");    // ResMut<UiData>
cmds.open("hub");                         // ResMut<Ui2Cmds>: assets/ui/hub.ui.ron
// anywhere:
for e in events.read() { /* UiEvent { id, kind: Activate | Focus | Tab(i) | Toggle(b) | Slide(v) | Back } */ }
```

```ron
Screen(
    root: Column(gap: 22, align: Stretch, children: [
        Header(name: "Nova Vance", subtitle: "Level {player.level}", stats: [Stat(label: "credits", value: "{player.credits}")]),
        TabBar(id: "hub", tabs: [TabSpec(label: "Drive"), TabSpec(label: "Shop", badge: "n.shop")]),
        Grid(columns: 4, row_height: 212, children: [
            Tile(id: "race", title: "Open Roads", subtitle: "Cruise", accent: Tile(0), pattern: Circles, span: (2, 2), tag: "Featured"),
            Tile(id: "garage", title: "Garage", accent: Tile(2), badge: "n.garage", action: Open("garage")),
        ]),
        Spacer(0),
        KeyHints(hints: [Hint(action: "confirm", label: "Select"), Hint(action: "back", label: "Back")]),
    ]),
)
```
RON extensions are on: `Column(gap: 8, ...)` (no double parens), `badge: "n.key"` (no `Some`). Unknown
fields are errors. A screen whose root is `Modal(...)` overlays the screen below and traps focus.

## Parts

| Part | File | What |
|---|---|---|
| Tokens | `tokens.rs` | `Tokens` resource: `colors` (bg, surface, accent, text, tile palette...), `type_scale`, `radius`, `space`, `shadow`, `motion`. `assets/ui/tokens.ron` overrides any field; polled twice a second; a change rebuilds open screens. `Tokens::from_theme(&Theme)` follows the engine theme. `ColorRef`: `Token("accent")`, `Tile(2)`, `Rgb(..)`, `Rgba(..)` |
| Components | `components.rs` | `Tile`, `TabBar`, `Header`, `KeyHints`, `Modal`, `Grid`, `Carousel`, `Column/Row/Stack`, `Text`, `Image`, `Button`, `Toggle`, `Slider`, `Spacer`, `Divider`. Each is a props struct (`Default` + `Deserialize`), built in Rust with `..default()` and `Build::spawn(world, parent, cx)` or used in a screen file via the `El` enum |
| Screens | `screen.rs` | `Ui2Screens` stack. `Open` pushes with a page slide (old page slides out and is rebuilt on `Back`, focus restored by id), `Back` pops (the first page never pops: the game reads `UiEvent::Back`), `Cmd::Show(name, Screen)` for screens built in Rust |
| Focus | `focus.rs` | `Focusable2 { id, action }`; arrows / WASD / D-pad / left stick move to the nearest focusable in that direction (`focus::pick`, tested), Enter / Space / South activate, Esc / East back, Q E (or PageUp PageDown) / LB RB switch tabs, mouse hover focuses and click activates. Left / Right on a focused slider steps it. A screen opens focused on its first tile / button (tabs last) |
| Motion | `anim.rs` | focus scale + glow + ring (`TileFx`), staggered entrance (`Enter`: rise + veil fade), page slide (`PageAnim`). Durations in `tokens.motion`. Runs on real time (menus animate while paused) |
| Backdrop | `backdrop.rs` | `Dim(a)`, `Gradient` (default: dim + vertical fade + accent radial glow), `Image(path)`, `None` |
| Data | `store.rs` | `UiData` key-value store (`set/get/f64/truthy/text/interpolate`). Any text may contain `{key}`; `badge: "key"` shows a count pill hidden at 0; `show: Cond(key, eq)` gates any element (tab pages: `Cond(key: "ui.tab.hub", eq: 1)`). `TabBar` writes `ui.tab.<id>` |
| Glyphs | `glyph.rs` | key caps that show the binding of an `ActionMap` action for the device used last (square keyboard cap, round pad cap); unknown actions fall back to built-in labels (`confirm` Enter/A, `back` Esc/B, `tab_next` E/RB ...) |

State and events: `TabBar { selected }`, `Toggle2`, `Slider2` are components you can read or set; every
interaction also emits `UiEvent` messages (`id` is the component's `id`).

## Extension points

- New component: a props struct with `#[serde(default, deny_unknown_fields)]` + `impl Build`, one
  variant in `El`, one arm in `El::build`. Look systems read `Tokens` and `Ui2Focus`.
- Restyle everything: edit `tokens.ron`, or `insert_resource(Tokens { .. })` before the plugin.
- Backdrop: `Backdrop::Image` for art; a true blurred game view needs a render pass (not built).
- Actions on activation: `Action::{Open, Back, SetStr, SetNum, SetBool}`, plus the `UiEvent`.

## Control commands and ruspy

`ui2.open {name}`, `ui2.back`, `ui2.screens` (stack, focus id, tab state, diagnostics count),
`ui2.data {key, value}`, `ui2.focus {id}`, `ui2.nav {input}`, `ui2.diagnostics {clear}`, `ui2.tokens`.
Scripts: `ui_open(name)`, `ui_back()`, `ui_data_set(key, v)`, `ui_data_get(key)`, `ui_on(event_id, method)`
(`method(kind, arg)`; kinds `activate focus tab toggle slide back`), see docs/SCRIPTING.md.

## Errors

Parse errors carry file, line and column (`ui/hub.ui.ron:3:16 unknown field titel`); unknown colour
tokens, missing files and bad token files are reported with the element path (`Column/Grid/Tile(x)`).
`Ui2Diagnostics` resource, `ui2.diagnostics`, and `warn!` in the log. A broken edit keeps the previous
screen on screen.

## Known limits

- No group opacity in bevy_ui: fades use a veil child painted in the background colour. Entrance and
  page fades therefore only look right over a roughly uniform backdrop.
- No real blur (see Backdrop). Page slides rebuild the screen below on `Back` (state lives in `UiData`).
- Carousel scrolling follows focus; there is no snap or momentum. Images use `AssetServer` paths.
- No per-component golden images yet (the engine's devkit golden compare works on the demo shots).
- Tile titles are upper-cased by design; localisation goes through `{key}` data, not `tr()`.
