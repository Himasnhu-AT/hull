# kits

Ready gameplay pieces, imported as `hull/kits`. A game composes them and talks to them only through their signals,
public methods and tunables. Each folder has a README (its first paragraph is the one line the catalogue below shows),
default config, a bench scene and a test, and ends with "Use it" and "Wiring": the snippet and what must exist for it to work.

Pure helpers (no nodes) for a game that builds its own player or enemies: `spawner/waves` (the wave clock), `pickups/depot`
(a supply zone), `health/zones` (hit zone, cover and regeneration maths) and `follow-camera/glide` (chase-camera maths).
Each is documented in its kit's README and in `docs/ARCHITECTURE.md`.

UI rules every kit shares: the UI layer scales with the window (designed for 1280x720); a kit's HUD is a `KitUi` with `layer` `'hud'`
(default) and is hidden while any menu shows (the title, result and pause screens and game over are `'menu'`); hide one yourself with
`node.get(Hud)!.show(false)`; a menu's first button has focus and Enter, Space and the gamepad's south button press it. Details: docs/SCHEMAS.md section 7.

Shared rules: tunables are `tunables()` blocks (Inspector widgets); no allocation in a step; game time and the world's random
streams only; sound, input and the UI go through `kitIO` so a test can swap them (`hull/kits/testing`).
`templates/fps` and `templates/third-person` are whole games under 30 lines of code each.
Copy a kit's `config/` files into the project's `config/` to use it.
