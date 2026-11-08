# Dogfood audit: `examples/script_platformer.rs`

A side-scrolling platformer (Glimmer Run) written almost entirely in ruspy: Rust sets up the
input actions, a camera, the ground and the level load (about 60 lines); everything else is
`assets/scripts/platformer/*.ruspy` (11 files) and `levels/platformer.level.ron`.
Steps file: `scripts/script-platformer.json` (`python3 -I scripts/play.py scripts/script-platformer.json --example script_platformer`,
all expects pass, no script errors). APIs exercised: `CharacterBody` (`move_and_slide`,
`is_on_floor`, `is_on_ceiling`), `raycast` / `raycast_dir` (floor probe, ledge and wall checks),
`get_overlapping_bodies`, sensors (`body_entered`), collision layers, tweens (looping bob and
moving platforms, `tween_callback`), groups and `call_group`, signals connected in `_ready` and in
the level file, an autoload, `extends` / `class_name` / `super_call` (Enemy, Walker, Runner),
`@export_*` hints, `ScriptProps` from the level, dictionaries, `self.hp`-style access, handles
(`pl.ground == self`, `b.take_hit()`), a script-built HUD with slider, checkbox and buttons,
`process_mode "always"`, `set_tree_paused`, `change_scene`, `spawn_vfx`, `play_sound`.

Ranked: **fixed** items have a commit on `physics`; the rest are open.

## Fixed

1. **No way to give a script node a body or a look** (`script_demo` needed a Rust `PhysicsBox`
   component). Added `add_body([n,] kind, shape, size)` and `add_primitive([n,] shape, size, color)`.
   Without them a game could not be "all script" at all.
2. **UI roots created by a script leaked across `change_scene` / node death.** `main.ruspy`'s
   restart reloaded the level but the old HUD (`hud.ruspy:23 bar = ui_hbox()`) and its end panel
   stayed on screen on top of the new one. Root UI nodes now carry `UiOwner(script node)` and are
   despawned with it. (Parenting UI under the script node does not work: a non-UI parent makes the
   whole HUD invisible, no error. See open item 7.)
3. **Stale connections spammed errors.** `hud.ruspy:49 game.connect("score_changed", self, "on_score")`
   (HUD connects to the autoload); after the HUD died every emit reported
   ``target `#4294966422` not found``. Runtime (`#entity`) connections to freed nodes are now dropped
   silently, like Godot.
4. **`tween_callback(t, "queue_free")` failed** (`shard.ruspy:30`, `enemy.ruspy:48`):
   "scripts/platformer/shard.ruspy has no function `queue_free`". The callback only reached script
   functions. `queue_free` now falls back to the host function (only that one; see open item 3).
5. Physics catalogue rows duplicated after merging two branches (test caught it).

## Open, ranked

1. **Collision layers are mandatory knowledge for a kinematic player vs kinematic enemy.** With
   default layers the player is blocked by the enemy (shape cast keeps a 0.02 skin), so
   `get_overlapping_bodies()` on the enemy never sees it and contact damage silently never fires
   (took a failing steps run to see: `enemy.ruspy` contact test). Fix in script: `set_collision_mask(1)`
   on the player, `set_collision_layer(2)` on enemies (now in the platformer scripts). Suggest:
   document in the Physics section, or let `get_overlapping_bodies` use a slightly inflated shape.
2. **Actions cannot be defined from script and custom input contexts start inactive.** The pause key
   must keep working while paused; a new action context (`ActionDef::context("pf_ui")`) is created
   inactive, so `is_action_just_pressed("pf_pause")` stayed false until Rust called
   `InputContexts::push("pf_ui")` (`script_platformer.rs:38`). No script function for either.
   Suggest `define_action(name, keys)` and `push_input_context(name)`, or an "always" context default.
3. **Host functions are not callable as callbacks / signal targets.** Only script functions are:
   `tween_callback(t, "queue_free")`, `connect(btn, "pressed", n, "queue_free")`, `call_deferred`
   with a host name all fail with "has no function". Godot code does this constantly
   (`tween.tween_callback(queue_free)`). Needs a host-call fallback in `call_rv` (needs a `Ctx`).
4. **`set_process_mode(n, ...)` on a node without a script errors** ("entity 926v0 has no Script",
   `main.ruspy` first draft). Every Godot node has a process mode; here it lives on `Script`.
   The error also prints the raw entity id, not the node name.
5. **Nodes made by `spawn_node` are not level entities**, so `change_scene` does not remove them:
   restart doubled the shards (`total` went 12 to 24) until `main.ruspy` parented them to itself
   (`spawn_node("Shard", self)`). Easy to get wrong; consider parenting new nodes to the current
   scene root by default, or documenting it next to `change_scene`.
6. **Integer division truncates silently**: `set_progress(bar, hp / max_hp)` with ints showed an empty
   health bar at 2 of 3 (`hud.ruspy:on_hp`, now `1.0 * hp / max_hp`). GDScript warns; ruspy could
   warn once per call site, or `/` on two ints could be float (breaking).
7. **UI under a non-UI parent is invisible without any message.** `ui_panel(self)` where `self` is a
   plain node produced a game with no HUD. A diagnostic ("parent has no Node") would save the hunt.
8. **`attach_script` cannot pass properties**: the new instance exists next frame, so `set_var` right
   after attaching fails and `call_deferred` of a setup method is too early. Shards had to read their
   own position in `_ready` instead of taking a parameter. Suggest `attach_script(n, path, {props})`
   now that dictionaries exist.
9. **`spawn_vfx` effects are not level entities either**: after a restart the sparks of the previous
   run were still in the air. Also `unknown vfx preset sparkle` does not list the valid names.
10. **Level files are hostile to hand-writing**: `ScriptProps` values are JSON text inside RON
    (`value: "[23.0, 1.2, 0.0]"`), every entity needs a `LevelEntity` id and a fake Entity key. I
    generated `platformer.level.ron` with a script. A `ruspy`-readable scene format or an editor
    export-only note would help.
11. Untested, worth a check: `is_action_just_pressed` inside `_physics_process` when the fixed step
    runs twice in one frame (the jump tap worked in the steps file, offscreen at 60 fps).
12. `vx = v[0]` style array reads and `n.position = [..]` work well; `if !flag` and `a != null`
    worked first time; dictionary `stats.stomps += 1` and `stats["shards"] += 1` both fine.

## What worked well

Handles with dot access (`b.take_hit(x)`, `pl.ground == self`, `get_node("/Game").on_stomp()`),
`super_call`, `@export_range` hints, dictionaries in `script.vars` (`expect result.stats.stomps`),
the diagnostics list with counts (183 repeats of one camera error collapsed into one row), and
`script.call` for test hooks (`debug_teleport`, `freeze_at`).

## Environment note

`play.py` builds into the shared target dir; a concurrent change to the local ruspy checkout broke
the engine build mid-session (non-exhaustive match on new `Value` variants) until `scripting` was
merged. Not an engine bug, but a build that "Finished" in 0.2 s ran a stale binary once.
