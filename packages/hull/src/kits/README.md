# kits

Ready gameplay pieces, imported as `hull/kits`. A game composes them and talks to them only through their signals,
public methods and tunables. Each folder has a README, default config, a bench scene and a test.

| Kit | Gives you |
|---|---|
| `level` | a solid arena: floor, walls, crates, free-floor lookup |
| `fps` | first-person body, look, sprint, jump, gun |
| `third-person` | third-person body with run, sprint, boost (gas), character animation, melee |
| `follow-camera` | orbit chase camera with speed effects and wall avoidance |
| `health` | hit points, hit zones, a weapon |
| `pickups` | collectables and named counters (gas, blades, ammo) |
| `spawner` | waves, a stand-in enemy, game over |
| `pause` | pause menu |
| `saves` | save slots |

Four kits also export pure helpers (no nodes) for a game that builds its own player or enemies: `spawner/waves` (the wave
clock), `pickups/depot` (a supply zone), `health/zones` (hit zone, cover and regeneration maths) and `follow-camera/glide`
(chase-camera maths). Each is documented in its kit's README and in `docs/ARCHITECTURE.md`.

Shared rules: tunables are `tunables()` blocks (Inspector widgets); no allocation in a step; game time and the world's random
streams only; sound, input and the UI go through `kitIO` so a test can swap them (`hull/kits/testing`).
`templates/fps` and `templates/third-person` are whole games under 30 lines of code each.
Copy a kit's `config/` files into the project's `config/` to use it.
