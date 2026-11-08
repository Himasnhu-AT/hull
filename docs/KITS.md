# Kits: reusable gameplay packages (`assets/kits/`)

A **kit** is a drop-in piece of gameplay written as a node script (`docs/SCRIPTING.md`): a player
controller, a camera rig, health, a pause menu. Games are built by composing kits and writing only
what is specific to the game. An AI building a game reads this file first, picks kits, configures
their knobs, connects their signals, and writes the rest.

## The catalogue

<!-- KITS:BEGIN (generated from assets/kits/*/kit.ron; `ENGINE_BLESS=1 cargo test --lib kits` rewrites it) -->
_No kits yet._
<!-- KITS:END -->

## Shape of a kit

```
assets/kits/<kit>/
  kit.ron          manifest (below)
  <kit>.ruspy      the main script: knobs are `// @export...` top-level vars, `signal("...")` declares signals
  <kit>.scene.ron  optional: a node subtree (made with save_scene or a bake), used with instantiate()
  demo.level.ron   a tiny scene that shows the kit working (for the kit gallery and its screenshot check)
  README.md        5-20 lines: what it does, knobs, signals, a usage snippet, limits
```

`kit.ron`:

```ron
(
    name: "health",
    summary: "Hit points, damage, healing, invulnerability frames, death.",
    category: "gameplay",            // controller | camera | gameplay | ai | ui | system
    script: "health.ruspy",
    scene: None,                     // Some("health.scene.ron") when the kit is a subtree
    signals: ["damaged(amount, hp)", "healed(amount, hp)", "died()"],
    requires: [],                    // other kits it needs
    usage: "attach_script(player, \"kits/health/health.ruspy\", {\"max_hp\": 5})",
)
```

Knobs are not repeated in the manifest: they are the script's exported members (`// @export_range`
etc.), read with `script.props`.

## Rules

- **Use from a game**: `attach_script(node, "kits/<kit>/<kit>.ruspy", {knobs})` for behaviour on an
  existing node, or `instantiate("kits/<kit>/<kit>.scene.ron", parent)` for a subtree. Talk to a kit
  only through its **signals**, its **public functions** (documented in README) and its knobs; never
  reach into its children by name from outside.
- **Self-contained**: a kit finds what it needs through knobs (node paths like `target = "../Player"`),
  groups, or autoloads it documents; no hard-coded names of game nodes.
- **No Rust per kit**: kits are scripts + data. If a kit needs an engine feature, add a host function
  (with a catalogue row and test) instead.
- **Godot-shaped names**: functions and signals named like Godot's equivalents where one exists
  (`damaged`, `died`, `body_entered`, `move_and_slide`), so models reuse what they know.
- **Tested**: every kit has a headless test (`src/scripting/tests_kits_<group>.rs`, using
  `tests::repo_app()` which loads the real `assets/`), covering its knobs and signals. Kits with
  visuals also have a gallery screenshot check (see "Kit gallery").
- **Cheap**: no per-frame work when idle (`set_process(false)` when there is nothing to do).

## Kit gallery

`examples/kit_gallery.rs -- --kit <name>` loads `assets/kits/<name>/demo.level.ron`;
`scripts/kits/<name>.json` is its play.py steps file (expects + screenshots).

## New game from a template

`python3 -I scripts/new_game.py <name> --template <platformer|topdown|arena>` writes a game that
composes kits, with its play.py steps file wired. See "Templates" (filled in when the generator lands).
