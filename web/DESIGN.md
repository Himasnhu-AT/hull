# DESIGN.md: engine website

## Phase 0: Brief

- **Subject:** `engine`, a code-first Rust engine on Bevy 0.19.1 + avian3d 0.7. It started as a
  game's whole shell (bootstrap, states, settings, menus, pause, UI kit, input, audio, quality
  presets, FPS and chase cameras, MeshKit, render budget, devtools, ship builds) and has since
  grown the systems a game needs after that: look (lighting as data), anim, vfx, ai, sound,
  world, actions + l10n, net (opt-in) and the devkit, each a cargo feature with its own doc and
  measurements, plus scene benchmarks with a regression check (docs/PERF.md).
- **Pitch (owner's words):** "pick this engine, build game fast, without doing re-setup of everything."
- **Audience:** Rust and Bevy developers starting a game, game-jam teams, people who already
  rebuilt the same menu/settings/pause code twice.
- **Job:** explain what it is in 3 seconds, prove it with two shipped-looking games, real captures
  of each system and measured numbers, and get people to `Cargo.toml` + `main.rs`.
- **Assets:** real 1920×1080 captures of Shroud and Courier, plus fresh captures from the engine
  examples (`ui_gallery` in five accents, `render_budget` on/off, `metrics_demo` with run history,
  and for the systems `look_showcase` High and dusk, `anim_demo`, `vfx_gallery`, `ai_crowd`,
  `open_world`; list in README.md).
- **Language:** English. **Constraints:** static, no deploy, port 4401, pnpm, memgate for builds.
- **Assumptions (placeholder: true in `src/data/site.ts`):**
  - Public name: working name **Hull** (the shell a game is built inside). Placeholder.
  - Production URL and studio ("Marl Studio" / "Marl Games" under consideration).
  - Real: the public repo https://github.com/Himasnhu-AT/hull and its `docs/` folder (linked from
    each tab, the footer and the Performance page). License `MIT OR Apache-2.0` (engine Cargo.toml).
    Not on crates.io yet: the Cargo snippet is a git dependency.
  - No stars, users or testimonials.

## Phase 1: Concepts

| | A. One shell, any accent (formal / material) | B. Drawn on a budget (material) | C. Boot, menu, in game (process) |
|---|---|---|---|
| Idea | The site is built from the engine's own UI kit; one accent variable re-brands the whole page, exactly as `Theme::with_accent` re-brands a game | The page behaves like a scene on a render budget: a HUD counts meshes drawn while far content drops detail | The site follows the engine's app states: a Boot loader, a main menu hero, the page is "in game", Esc opens the pause menu |
| Anchor | Shroud and Courier share the same menus, settings and pause screens; Courier differs by one line, `with_accent(srgb(1.0, 0.78, 0.22))` | measured 40,231 → 480 meshes drawn | `AppState` Boot → MainMenu → InGame, the screen stack, Esc pauses |
| Signature | Accent swatches (the engine's swatch widget) recolour the site and swap the hero to the real engine capture rendered in that accent | a scroll-scrubbed before/after of the 40k-prop city | Esc pauses the page: a pause menu slides in over a dimmed page |
| Emotion | "That is a real game menu, and it's mine to colour" | "they measured it" | "this site is a game" |
| Screenshot | hero menu in cyan with the cyan swatch selected | the split frame on the city | the paused site |
| O / F / Fe / P | 4 / 5 / 4 / 1 | 4 / 4 / 4 / 2 | 4 / 5 / 5 / 1 |

**Pick A.** It is the product's actual proof (the shell is shared, the game is yours) and the
re-brand is a real engine feature, captured for real. **Stolen from C:** the menu overlay is the
engine's pause menu (Esc opens it, Back closes it), the loader is the Boot state, and the 404 is
"no screen registered". **From B:** the render budget page's before/after split.

### Concept card

```
Idea:        The site is a game shell: built from the engine's own UI kit, re-brandable with one accent.
Metaphor:    the engine's menu system (selection bar, settings rows, key hints, screen stack).
Signature:   accent swatches: one CSS variable on <html> recolours every bar, rule and number, and the
             hero crossfades to the real ui_gallery capture rendered in that accent (driver: src/motion/accent.ts).
Emotion:     the first 3 s look like a finished game's main menu, then you realise it is a website.
Motion verb: snap to the selection bar. The accent bar slides to what you point at; screens push and pop.
Screenshot:  the hero main menu in a visitor-picked accent, swatch row underneath.
```

## Phase 2: Art direction

### Palette (taken from `src/ui/theme.rs`, Theme::default)

| Role | Hex | Source |
|---|---|---|
| ground | `#090b0f` | `bg` srgb(0.035, 0.043, 0.06) |
| panel | `#12161c` | `panel` srgb(0.07, 0.085, 0.11) |
| raised | `#212630` | `raised` srgb(0.13, 0.15, 0.19) |
| ink | `#edf1f6` | `text` |
| muted | `#949eb0` | `text_muted` (7.4:1 on ground) |
| line | `rgb(255 255 255 / .09)` / strong `.18` | `line` / `line_strong` |
| accent | `var(--accent)`, default `#ffa838` | `accent`; Courier `#ffc738`; swatches cyan `#59d1ff`, green `#61e6b8`, rose `#ff7399` |
| curtain | panel | |
| good / bad | `#61e6b8` / `#ff5c4d` | metrics colours (only in data) |

Near-black with a single warm accent is on the "avoid" list. It stays because it is the engine's
real default theme and the concept is that the accent is not the identity: the visitor changes it.

### Type

- **Barlow Condensed** 600/700 (Google, OFL), the engine's embedded label and display face.
  Display and labels, upper case as in the engine's menus. Display tracking -0.01em (condensed caps need little),
  leading 0.86. Labels +0.06em.
- **Barlow** 500/600, the engine's body face. Body 17–18 px / 1.55.
- **JetBrains Mono** 400 for code and measured numbers in tables only.

Scale: mega `clamp(4.5rem, 1rem + 15vw, 15rem)`, xl `clamp(2.6rem, 1.2rem + 5vw, 6.5rem)`,
l `clamp(1.6rem, 1.2rem + 1.6vw, 2.6rem)`, body `clamp(1.0625rem, 1rem + .2vw, 1.125rem)`, s 0.875, xs 0.75.

### Grid & rhythm

12 columns, gutter `clamp(1rem, .6rem + 1.6vw, 2.5rem)`, margin = the engine's `EDGE` idea
(`clamp(1rem, 5.8vw, 7rem)`, 112 px at 1920 like the menus). Hang lines: col 1 (labels),
col 4 (body), col 8 (media). Rhythm moods: tight (menu rows), normal, airy (statement), full viewport (hero, metrics).

### Shape

Radius 4 px everywhere (the engine's `RADIUS`). Panels are flat fills with a 1 px line, no shadows.

### Motion language

- Eases: engine `soft` (power3.out) for the selection bar and hovers (0.28 s), `out` (expo.out) for reveals,
  `inOut` for screen push/pop (0.8 s each way).
- Selection bar: an accent bar behind the hovered/focused menu item, sliding between items (one bar per list).
- Page transition = screen push: a panel slides in from the right carrying the next screen's title in
  Barlow Condensed with the accent rule; it slides off to the left. Back/forward = pop.
- Reveals: line masks on display text only; settings rows stagger 40 ms.
- Idle: the corner FPS readout is a real measurement of the page's own frame time (the engine's FPS counter),
  updated 4×/s like the metrics window; the accent bar breathes its glow slightly at rest. Off under reduced motion.

### Micro-interaction roles

| Role | Treatment |
|---|---|
| Nav, menu items, CTAs | selection bar: accent fill slides in from the left, text flips to on-accent |
| Project cards / game images | frame tightens: image scales 1.04 inside its clip, accent rule draws under the caption |
| Inline links | accent underline at rest, thickens on hover |
| Utility links | colour |
| Key hint chips | press state (the chip darkens like a key going down) |

### Composition plan

Home (`/`):
```
HERO / poster+split (100svh)
[eyebrow: Game shell for Bevy 0.19]                  [FPS 120  8.3 ms]
HULL                                         +--------------------------+
Your game starts at gameplay.                |  real main menu capture  |
> START       (selection bar)                |  (accent-matched)        |
  INSIDE                                     +--------------------------+
  RENDER BUDGET                              swatches: ■ ■ ■ ■ ■  "Accent: Shroud"
  GAMES
[↑↓ Navigate] [Enter Select] [Esc Menu]

STATEMENT (airy, cols 2-11)
"Menus, settings, pause, input, audio ... are the same in every game. Hull ships them."

INSIDE / settings-screen layout (tabs + rows)       one layout family: tabbed rows
[SHELL] [UI KIT] [RENDER] [DEVTOOLS]
row: label + hint ........................ value chip
                                         side panel "About this setting"

SYSTEMS / same settings-screen layout, second tab set   (added with the subsystems)
pair: look_showcase High | the same yard at dusk, offset like the Shroud/Courier pair,
      caption code `app.insert_resource(Look::dusk())` (the "one line changed" idea again)
[LOOK] [ANIM] [VFX] [AI] [SOUND] [WORLD] [NET]
side panel: real capture, or a measured number from the doc when there is no capture,
            then the cargo feature and a link to the doc

CODE / asymmetric pair
code panel (main.rs, 6 lines) cols 1-7 | text cols 9-12

PROOF / gallery wall of two games
Shroud (big image 8 cols) + numbers 13,467 → 7,833
Courier (big image 8 cols, mirrored) + 3,150 lines, 8.3 ms

PERFORMANCE teaser / data facts (same fact rows as the budget)
open_world p99 48.5 → 5.6 ms, look High 99 → 130 fps, look Ultra crashed → 65 fps   link: Performance

RENDER BUDGET teaser / data facts
40,231 → 480 meshes drawn, 4.54 → 3.07 ms p95, 85–92% → 21–32%   link: Render budget

DEVTOOLS / full-bleed media
metrics window capture edge to edge, caption + chips

FOOTER finale
START.  cargo snippet  links  license
```
Performance (`/performance/`): hero statement (p99 48.5 → 5.6) → open_world capture → 12-scene
table (scene + what it stresses, fps, p50/p95/p99, GPU, memory, entities, vs baseline) → what the
first run caught (the render budget's step cards) → headless CPU benches + the commands → known
limits → links to every doc.
Render budget (`/render-budget/`): hero statement → before/after split (drag) → distance tiers figure
→ measurements table → tried and dropped → zero config.
Games (`/games/shroud/`, `/games/courier/`): title + meta → hero capture → what the engine gave
→ what the game kept → numbers → gallery → next game.
Start (`/start/`): sticky step list (sticky narrative) with Cargo.toml, main.rs, settings, ship build.
404: "No screen registered" + Back.

### Explainer figure

The `anatomy` skill is available. One figure on `/render-budget/`: the distance tiers
(shadow 50 m, small props fade 60 m, far twin 80 m, view 170 m) as a camera with range rings.
If time runs short it ships as an inline SVG diagram drawn by hand instead.

### Genericness test

- "Dark dev tool with an orange accent" is where a generic model lands. Changed: the accent is the visitor's
  and swaps real captures; layout idioms (settings rows, tabs, key-hint bar, selection bar, pause menu)
  come from the engine's own UI, so the site could not belong to another product.
- Generic feature grid of cards: replaced with the settings-screen tab layout. When the engine grew
  nine subsystems, they became a second tab set (Systems) rather than a grid of feature cards;
  the shell tabs kept their place and gained Input and Devkit.
- Generic testimonial/logo row: replaced with two real games and their line counts.

### Idle decisions (Phase 3)

- Home: attract mode, as on a game's title screen. Until the visitor picks an accent, the hero
  cycles through the five real captures; a 4 px countdown rule under the capture fills toward the
  next one. It holds while a picker has focus, stops for the visit on the first click or key
  (Tab excepted), pauses off screen, and is off under reduced motion. Nothing is saved.
- Every page: the corner FPS counter is a real reading of the page's own frame rate (4 Hz).
- Inner pages (render budget aside, whose figure has its own idle tour) are reading pages and
  stay still at rest on purpose: their life is in the selection bar, the screen push and hovers.

### Build notes

- No loader: a product page earns no wait. The hero intro is the Boot to MainMenu moment, and
  the corner state label follows where you are (Main menu, In game, Paused, page names).
- Pause menu = site navigation: Esc or the Menu button, focus trapped, Esc or Resume closes.
- Screen push transition: the next screen's title slides in from the right on the panel colour
  with the accent rail, then leaves to the left.
- Game pages pin their own accent (Shroud orange, Courier yellow), like their real themes.

## QA log (production build on :4401, shoot.mjs + audit.mjs, fresh critic each pass)

| Pass | Critic overall (D / U / C / Ct) | Main fixes that followed |
|---|---|---|
| 1 | 7.1 (7/7/7/8) and 7.4 (7.5/7/7.5/8), two critics | solid header, pause menu after main (home links clickable), compare crop, logo mark that opens, phone code |
| 2 | 7.1 (7/7/7/8) | scroll spy, stacked phone tables, transition uncovers while the intro plays, page-specific closers |
| 3 | 7.25 (7/7.5/7/8) | settings-row selection with a live "About this setting" panel, swatch hover preview, faster intro |
| 4 | 7.4 (7/8/7/8) | code without long lines, game-card title bar, h1 = name only, picture sizing |
| 5 | 7.1 (7/7/7/8) | Start code collapsed by an over-broad nowrap rule (fixed), 404 side capture, per-page closer code |
| 6 | 7.1 (7/7/7/8) | phone overlap on render budget, hint contrast on hovered rows |

| 7 (subsystems update, no critic) | — | Systems tab set, Performance page, new captures; phone bench table clipped long values (fixed); tabs wrap on phones instead of scrolling sideways |

Pass 7 numbers: audit 0 FAIL / 0 WARN, heaviest page `/` ~627 KB by the audit's count (every `<img>`
summed, lazy and hidden-tab ones included; was ~527 KB before the two new sections), throttled
mobile LCP 0.9 to 2.0 s, CLS ≤ 0.003, 0 axe violations, no overflow, nothing hidden in reduced motion.

Every pass: 0 audit FAIL, 0 console errors, 0 serious axe (after pass 1), no overflow, no hidden text
under reduced motion, `noHoverChange` empty, throttled mobile LCP 0.9 to 1.6 s, CLS ≤ 0.003.
The critics agree on the ceiling: the concept frames the pages (menu, states, transition, 404,
accent) more than it lays out the long bodies. Raising Creativity and Design past 8 likely needs
body sections built as engine screens end to end, and a live capture (video) for the hero.
