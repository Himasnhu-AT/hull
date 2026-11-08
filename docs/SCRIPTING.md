# Node scripting: Godot-style scripts in ruspy (`engine::scripting`, feature `scripting`)

Put a `Script` component on an entity and it gets its own script instance. The file's
top-level variables are that entity's **members**, the functions it defines are called by the
engine (`_ready`, `_process`, ...) and by other scripts, entities talk through **signals** and
**groups**, find each other by **node path**, and build UI from script. Everything is plain
text, hot reloaded, and a broken script is a located diagnostic, never a crash. The model
follows Godot 4 (audit: `docs/audits/godot/SCRIPTING.md`); if you know GDScript you know this.

- `src/scripting/`: `Script`, `ScriptProps`, `Groups`, `Connections`, `ScriptTimer`,
  `Autoloads`, the runtime (`ScriptRuntime`, non-send: ruspy values are `Rc`), host functions
  (`api.rs`), node paths (`tree.rs`), control commands (`devtools.rs`).
- Language: **ruspy** (`/Users/himanshu/codes/ruspy/ruspy.md`): `fn name(a, b) { ... }`,
  `if / else if / else`, `while`, `for x in arr`, arrays `[1, 2]`, `x = 1;`, `//` comments,
  `&& || !`, `null`, `tostr(x)`, `"a" + 3` concatenation, `len`, `is_null`, `floor`, `ceil`,
  `abs`, `min`, `max`, `sqrt`, `pow`, ...
- Example game: **Lantern Keeper**, `examples/script_demo.rs`: almost all logic is in
  `assets/scripts/{game,player,lantern,spawner,hud}.ruspy`.
  `python3 -I scripts/play.py scripts/script-demo.json --example script_demo`.
- Relation to logic graphs: see the last section.

## Godot to engine

| Godot | Here |
|---|---|
| `Node` | an entity (Bevy `Entity`); scripts hold it as an int (`Entity::to_bits`) |
| scene tree | the `ChildOf` / `Children` hierarchy, names from `Name` |
| `Node.set_script`, `.gd` file | `Script { path: "player.ruspy" }` (`scripts/` is implied unless the path has a `/`) |
| `ScriptInstance` | one `Engine` + `Module` per entity (`Instance`); its globals are its members |
| `var hp = 3` (member) | a top-level `hp = 3;` in the file |
| `@export var speed = 5` | a top-level `speed = 5;` plus a `ScriptProps` override on the entity (what the scene stores) |
| `@onready var x = $A/B` | `x = null;` at top level, `x = get_node("A/B");` in `_ready` |
| `signal hit(hp)` | `signal("hit");` at top level (declares; arguments are free) |
| `emit_signal("hit", hp)` | `emit_signal("hit", hp)` |
| `[connection signal="hit" from="." to="../HUD" method="_on_hit"]` | a `Connection` in the `Connections` component (saved in the level file) |
| `a.connect("hit", Callable(b, "_on_hit"))` | `connect(a, "hit", b, "_on_hit")`; `connect("hit", target, "m")` is on `self` |
| `CONNECT_ONE_SHOT`, `CONNECT_DEFERRED` | `Connection.one_shot`, `Connection.deferred` |
| `add_to_group`, `call_group`, `get_nodes_in_group` | same names; `Groups` component, saved |
| Autoload (Project Settings) | `Autoloads` resource: `("Game", "game.ruspy")` becomes a root entity `Game` at startup; `get_node("/Game")` |
| `PackedScene.instantiate()` | `instantiate("levels/lantern.level.ron", parent)` (a `.level.ron` is a scene) |
| `get_tree().change_scene_to_file` | `change_scene(path)` (end of frame) |
| `Timer` node | `ScriptTimer` component, emits `timeout`; `start_timer(secs, method)` for fire-and-forget |
| `Area3D.body_entered` | physics sensor overlap: `body_entered(other)` / `body_exited(other)` signals on both bodies |
| `Button.pressed`, `mouse_entered` | emitted by `ui_button` nodes |
| `Control`, containers, anchors | `ui_panel / ui_vbox / ui_hbox / ui_label / ui_button / ui_progress` + `ui_set(node, "anchor", ...)` |
| `_ready` (children first) | `_ready()`, children first, after the new subtree has its instances |
| `_process(delta)`, `_physics_process(delta)` | same; `_physics_process` runs in `FixedUpdate` |
| `_input(event)`, `_unhandled_input(event)` | `_input(action, pressed)`, `_unhandled_input(action, pressed)` over engine actions |
| `_exit_tree` | `_exit_tree()` |
| `queue_free()`, `call_deferred` | same; end of frame |
| `get_node("../HUD/Score")`, `%Unique`, `/root/X` | same node-path syntax (`/X` and `/root/X` both work) |
| `Input.is_action_pressed("jump")` | `is_action_pressed("jump")` (engine actions, `docs/ACTIONS.md`) |
| `Vector3` | `[x, y, z]` array |
| `Object.get / set` with property paths | `get("Transform.translation.y")`, `set(...)`: reflected component fields |
| editor `@tool` | not needed: scripts run in the editor's Play like in the game |

## Quick start

```rust
app.insert_resource(Autoloads(vec![("Game".into(), "game.ruspy".into())]));   // optional singletons
commands.spawn((Name::new("Player"), Script::new("player.ruspy"),
                ScriptProps::default().with("speed", json!(9.0)),             // override a member
                Connections::default().to("hit", "/HUD", "on_hit")));         // signal -> method
```

`assets/scripts/player.ruspy`:

```
signal("hit");
speed = 7.0;                       // member; ScriptProps may override it
hp = 3;

fn _ready() { add_to_group("player"); }

fn _physics_process(dt) {
    v = get_vector("left", "right", "up", "down");
    translate([v[0] * speed * dt, 0.0, v[1] * speed * dt]);
}

fn damage(n) {
    hp = hp - n;
    emit_signal("hit", hp);        // /HUD.on_hit(hp) runs now (synchronously)
}
```

Levels carry scripts too: `Script`, `ScriptProps`, `Groups`, `Connections`, `ScriptTimer` are
reflect-registered, so `save_level` writes them and the editor can edit them. See
`levels/script_demo.level.ron` and `levels/lantern.level.ron` (regenerate with
`cargo run --example script_demo -- --headless --bake`).

## Lifecycle and ordering

Per frame (each instance follows its `process_mode` while the game is paused, see
[Pause and process mode](#pause-and-process-mode); the editor's edit world runs no scripts):

1. **Attach** (`ScriptSet::Attach`): changed script files are polled (every 0.5 s), new `Script`
   entities get instances (the top level runs, `ScriptProps` are applied), then `_ready` runs for
   every instance that has not been readied: **children before parents** (Godot's order), after
   the whole new subtree has instances, so `_ready` may call into any new node.
2. **Events** (`ScriptSet::Events`): `ScriptTimer`s (`timeout`), physics overlaps
   (`body_entered`, `body_exited`), UI (`pressed`, `mouse_entered`, `mouse_exited`), then input.
3. **Process**: `_process(delta)` by `Script.priority` (lower first), then attach order.
4. **Flush**: deferred calls (`call_deferred`, `deferred` connections; up to 8 rounds so a
   deferred call may defer again), `queue_free` (`_exit_tree` bottom-up, then despawn), then a
   requested `change_scene`.
5. `FixedUpdate`: `_physics_process(delta)`, same ordering rules.

Input goes to `_input(action, pressed)` of every script that defines it, in **reverse** attach
order (latest first) until one calls `set_input_as_handled()`; then to `_unhandled_input`.
A script that defines neither costs nothing for input; likewise for `_process` and
`_physics_process` (hooks are detected from the file's outline).

Signals are **synchronous**: `emit_signal` calls the connected methods before it returns.
Exception: if the target script is currently running (a child emits to its parent while the
parent's `_process` is calling the child), the call is delivered at the end of the frame
instead of failing.
`one_shot` connections are removed before the call; `deferred` ones run in Flush.

## Pause and process mode

`Script.process_mode` (Reflect, saved in levels; Godot `PROCESS_MODE_*`):

| Mode | Runs |
|---|---|
| `Inherit` (default) | the parent's mode; `Pausable` at the root. A node without a `Script` passes it up |
| `Pausable` | only while the game is not paused |
| `WhenPaused` | only while the game is paused (a pause menu) |
| `Always` | paused or not |
| `Disabled` | never |

The scripting systems no longer stop when `Paused` is set; every instance is checked instead
(`effective_mode`). The mode gates `_process`, `_physics_process`, `_input` / `_unhandled_input`,
`ScriptTimer` and `start_timer` countdowns, the built-in UI signals (`pressed`, `mouse_*`) of the
entity that emits them, deferred calls, and `_ready`. Instances are created whatever the pause
state; `_ready` waits until the instance would process (a `Pausable` script spawned in a paused
game is readied on resume). Deferred calls to a node that may not run now are kept until it may
(dropped when it is `Disabled`). Synchronous signal calls and `call()` ignore the mode, as in Godot.

While paused, `delta()` is **real** time (so `Always` / `WhenPaused` scripts and timers still
animate); `time()` stays on game time. Limits: `_physics_process` follows `FixedUpdate`, which
follows virtual time, so it does not tick while paused whatever the mode; gameplay-context actions
are off while paused (the engine ties that context to `Paused`), UI actions still arrive.

Host functions: `get_tree_paused()`, `set_tree_paused(bool)` (through `PauseCtl`: `Paused`,
`Time<Virtual>` and physics time), `set_process_mode([n,] "always")` (also Godot's ints 0..4:
inherit, pausable, when_paused, always, disabled), `get_process_mode([n])`.

Per instance, `set_process([n,] bool)` and `set_physics_process([n,] bool)` turn the hooks off and
on (a script can stop its own `_process`); `is_processing([n])`, `is_physics_processing([n])`
read the toggles (default on). They live in the `ScriptProcessing` component (runtime only).

Editor: the editor keeps its own world paused (`editor::keep_paused` sets `Paused` every frame) and
Play runs the game in another process. Since a pause no longer stops the sets, the scripting
sets and `physics_process` carry a run condition `scripts_active`: with the `editor` feature they
do not run while the `EditorMode` resource exists. So edit-world scripts do not run (not even
`Always` ones, and no instances are created), while a Play process (no `EditorMode`) runs them
normally.

## Members and ScriptProps

Values passed between scripts (`call`, `get_var`, signal arguments) keep int vs float.

Top-level assignments are members, created when the script is attached and readable and
writable from the outside (`get_var(node, "hp")`, `set_var(node, "hp", 5)`, `script.vars`,
`script.set_var`). Rules:

- The top level runs **once per instance**; other top-level statements may call host functions
  (`signal(...)`, `add_to_group(...)`) but cannot assume `_ready` order.
- `ScriptProps { values: [(name, json)] }` overrides members after the top level and before
  `_ready` (Godot's exported properties stored in the scene). JSON `5.0` stays a float, `5` an int. `ScriptProps::default().with("speed", json!(9.0))`.
  Values are JSON: numbers, strings, bools, arrays.
- A member holding a node is just an int; `is_valid(n)` tells whether it still exists.
- **Hot reload keeps member values**; a new top-level variable gets its initial value, a
  removed one is dropped, `_ready` does not run again (it is not re-run on reload).

## Export hints, `extends`, `class_name`

Plain top-level variables are exported (editable on the node as `ScriptProps`); a name starting
with `_` is private and not listed. Comment annotations directly above a variable add editor hints:

```
// @export_range(0, 10, 0.5)
// @tooltip Metres per second
speed = 5;
// @export_enum("easy", "hard")     (a string default stores the text, an int default the index)
mode = "easy";
// @export_color                    ([r, g, b(, a)])
tint = [1, 0, 0];
// @export_file("*.ruspy")
next = "";
```

The editor shows a slider, a combo box, a colour picker, a file field and the tooltip.
`script.props {script | entity}` lists them (`name`, `default`, `hint`, `tooltip`);
`scripting::script_props(world, path)` is the same in Rust.

Inheritance uses header comments (before the first code line): `// extends base.ruspy` and
`// class_name Enemy`. The base file is spliced in before the derived one in the same module:
derived top-level assignments run after the base's, so they override its defaults, and a derived
function replaces the base function of the same name (the base's own calls reach the override).
`super_call("fn", args...)` calls the next version up the chain (resolved when the file loads: the
name must be a string literal). `is_class([node,] "Enemy")` is true for the class and every base;
`attach_script(node, "Enemy")` takes a `class_name` as well as a path. Editing a base reloads its
derived scripts. Error line numbers count from the start of the spliced text (bases first).

## Signals

```
signal("lit");                         // top level: declare (shows up in script.list)
emit_signal("lit", points);            // call every connection with (points, binds...)
connect("lit", "/Game", "add_score");  // self -> /Game.add_score
connect(btn, "pressed", self(), "on_button");   // source, signal, target (node or path), method
connect(btn, "pressed", self(), "on_button", CONNECT_ONE_SHOT());   // + Godot flags
if is_connected(btn, "pressed", self(), "on_button") { }
disconnect(btn, "pressed", self(), "on_button");
```

- Connections live on the **source** entity in `Connections`. `target` is a node path
  resolved from the source (`.`, `..`, `../HUD/Score`, `/Game`, `%Score`) or `#<bits>`
  (what `connect()` stores when you pass an entity).
- `binds` (JSON per entry) are appended after the signal's own arguments; `deferred` runs the
  call in Flush; `one_shot` disconnects before the first call.
- A target that does not define the method (or a path that does not resolve) is a diagnostic, not a crash.
- **Built-in signals**: `timeout` (ScriptTimer), `pressed`, `mouse_entered`, `mouse_exited`
  (UI buttons), `body_entered(other)`, `body_exited(other)` (physics; needs
  `CollisionEventsEnabled` and a dynamic body in the pair, see `docs/GAME_GUIDE.md`). Built-in signals are plain signals: connect them like any other
  (`body_entered -> . _on_body_entered` in `Connections`, as `lantern.level.ron` does); nothing is
  called unless a connection exists.
- Do not read a script's members from inside its own signal's handler on the emitter (the
  emitter is mid-call): pass what the receiver needs as arguments. Lantern Keeper's Game emits
  `state_changed(state, score, best)` for exactly that reason.

## Node paths

| Path | Means |
|---|---|
| `""`, `.` | the entity itself |
| `..` | its parent |
| `Child/Grandchild` | children by `Name`, one level per segment |
| `../Sibling` | segments combine |
| `/Name/Child` (also `/root/Name/...`) | a root entity named `Name`, then down; autoloads are roots |
| `%Name` | the first entity named `Name` under this entity's root, else anywhere |
| `#<bits>` | an entity by id |

`get_node(path)` errors with a located message when missing; `get_node_or_null` returns `null`.
`find(name)` is the first entity with that `Name` anywhere (slow: scans the world; call it in
`_ready`, not every frame). Names are not unique: name things you look up.

## Coroutines

A function containing `await` is a coroutine (GDScript 2 style). Calling it runs to the first
`await` and returns `void`; the engine resumes it later. Awaitables are plain values from host
functions:

```
fn _ready() {
    await wait(1.5);                     # game seconds; follows pause / process mode
    await next_frame();                  # the next frame, not this one
    args = await signal_of(boss, "died"); # the signal's argument (null for none, an array for 2+)
    hp = await signal_of("healed");      # node defaults to self
}
```

- `await` is a whole statement: `await e;`, `x = await e;`, `x: T = await e;`, `return await e;`.
  It can sit in `if`, `while`, `for`, `match` and blocks (`break`/`continue` work across it).
  Not supported: inside a bigger expression (`1 + await e`, call arguments), at file top level,
  `a.f = await e`. These are located compile errors (`E0360`, `E0361`).
- `await some_coroutine()` does not wait for it: the inner one starts detached and the outer
  resumes on the next frame. Use a signal to wait for completion.
- Time and frame waits only advance while the node may process (a paused `Pausable` node
  waits; `Always` / `WhenPaused` keep going). Signal waits wake synchronously inside
  `emit_signal`; if the waiting node is on the call stack then, it resumes next frame.
- Coroutines die with their node (`queue_free`, despawn, `Script` removed) and on hot reload.
  A runtime error after a resume is reported with the script's `file:line:col` and ends it.
- Coroutine files run in the interpreter (automatic). Locals survive suspension; each resume
  gets a fresh step budget. `script.api` lists `wait`, `next_frame`, `signal_of`.

## GDScript-style access

Nodes are **object handles** (`Value::Object`): `get_node`, `self`, `get_parent`, signal and
`call` arguments all give handles. A handle prints as `Node#<id>`, compares by id (`a == b`),
and `is_null(h)` is false for it. Plain int entity ids (older scripts) are still accepted
everywhere a node is. Handles read and write through the object hooks in
`src/scripting/api_obj.rs`:

```
kid = get_node("Kid");
kid.position = [1, 2, 3];          # set_position(kid, ..)
kid.position = [kid.position[0] + 1, 2, 3];
kid.visible = false;               # set_visible
kid.hp -= 1;                       # a script member of kid (get_var / set_var)
kid.get_node("Grandkid");          # get_node(kid, "Grandkid")
kid.queue_free();                  # queue_free(kid)
kid.emit_signal("hit", 3);         # emit_signal(kid, ..): emits from kid
kid.add_to_group("enemies");
kid.connect("hit", self, "on_hit");
kid.take_damage(3);                # kid's script function (like call(kid, "take_damage", 3))
self.hp += 1;                      # own members and functions, see below
```

**Properties** (a table, `api_obj::PROPS`): `position` (`get_position`/`set_position`),
`global_position` (read-only), `rotation`, `scale`, `visible` (`is_visible`/`set_visible`),
`name`, `text` (UI nodes), and read-only `parent`, `children`, `path`. Any other name is the
node's script member; a missing one is a located error. A read-only property assigned is an error.

**Methods** `node.f(args)`: the node's script function `f` if it has one, else the host function
`f` with the node prepended (so every `[n,]` function works as a method). Neither: an error.
A script that is running (on the call stack) can't be entered again: member access to it errors
and methods error like `call` (use `call_deferred`).

**`self`** is a bare name for the running instance's handle (`self()` still works).
`self.x` / `self.x = v` / `self.f()` use the script's own variables and functions directly (no
host call, so they work while the instance is running); `self.position` and the other
properties go through the table. In a function, a local named like a member shadows it, so
`self.hp` is the explicit form.

**Dictionaries**: `d = {"a": 1, "b": [2, 3]}`, `d["a"]`, `d["a"] = 5`, `d.a` (same as `d["a"]`
for string keys), `len(d)`, `d.keys()`, `d.values()`, `d.has(k)`, `d.erase(k)`,
`d.get(k, default)`, `d.clear()`, `for k in d`. Keys are str, int, bool or char; insertion order
is kept; dicts are shared by reference like arrays. They convert to and from JSON objects
(arguments, return values, `ScriptProps`, `get`/`set`, signal arguments): a JSON object arrives
as a dict and a dict leaves as a JSON object (key order is then sorted, since JSON objects are).
The VM does not compile dicts or member assignment: such files run in the interpreter (the
fallback is automatic).

## Language additions: vectors, strings, const / enum / match

Full reference in ruspy's `ruspy.md`; what matters for the engine:

- **Vectors**: `vec2(x, y)`, `vec3(x, y, z)`, `Color(r, g, b [, a])`; `+ - * /`, `==`, `.x .y .z`
  (`.r .g .b .a`), `v[i]`, writes `v.x = 1` / `v.x += 1` on a variable, methods `length()
  normalized() dot() cross() distance_to() lerp() abs()`. Host functions now **return**
  `Vec3` (`get_position`, `get_scale`, ...) and `Vec2` (`get_vector`, mouse positions), and
  **accept** vectors or `[x, y, z]` arrays (positions, scales, colors, tween values, `lerp`).
  `v[0]` on a returned vector still works. To the game, a `Vec3` is `Value::Vec3` and `Vec2` /
  `Color` are JSON arrays; JSON arrays arriving in scripts stay arrays (index them, or wrap with
  `vec3(arr)`).
- **Strings**: `split join strip upper lower replace find contains begins_with ends_with substr
  to_int to_float len`, `s[i]`, `fmt("{} {}", a, b)`, `"%s %d %.2f" % [a, b, c]`.
- **Arrays** add `append insert remove sort reverse has find slice join`.
- **`const NAME = v;`**, **`enum State { A, B = 5 }`** (`State.A`, a read-only dict; it is a
  script member, so it appears in the inspector), **`match x { 1 | 2 => { .. } _ => { .. } }`**.
- Files using these run in the interpreter (the VM falls back automatically).

## Host functions

Nodes are object handles (ints are accepted), vectors are `[x, y, z]`. `[n,]` is an optional leading node; without it the
function acts on `self`. Errors in a host call become a diagnostic with the script's
`file:line:col`.

### Core and tree

| Function | |
|---|---|
| `self()` | this entity |
| `log(...)`, `print(...)` | line in `LogicDiagnostics::log` (the editor's Output) and the game log |
| `get([n,] "Component.field")`, `set([n,] "Component.field", v)` | reflected component fields (`"Transform.translation.y"`) |
| `get_node([n,] path)`, `get_node_or_null([n,] path)`, `find(name)` | look up nodes |
| `get_parent([n])`, `get_children([n])`, `get_name([n])`, `get_path([n])` | tree queries |
| `is_valid(n)` | the entity still exists |
| `queue_free([n])` | despawn at end of frame (`_exit_tree` first, children before parents) |
| `spawn_node(name [, parent])` | new empty node (entity with `Name`, `Transform`) |
| `add_child(parent, child)`, `reparent(child, new_parent)` | tree edits |
| `set_name([n,] name)` | rename |
| `attach_script([n,] path)` | add a `Script` at runtime (its `_ready` runs next frame) |
| `instantiate(scene_path [, parent])` | spawn a `.level.ron` as a subtree; returns its root |
| `change_scene(path)` | load a level at the end of the frame |

### Calls, signals, members

| Function | |
|---|---|
| `signal(name)` | declare a signal (top level) |
| `emit_signal(name, args...)` | emit from `self`; returns the number of calls made |
| `connect([source,] signal, target, method [, flags])`, `disconnect(...)`, `is_connected(...)` | runtime connections; `source` is told apart by being an **int entity** first argument (not by argument count), else `self` |
| `connect_flags.DEFERRED` / `connect_flags.ONE_SHOT` (or `CONNECT_DEFERRED()` / `CONNECT_ONE_SHOT()`) | Godot's flag values 1 and 4; combine with `+` (ruspy has no `|`): `connect("s", t, "m", connect_flags.DEFERRED + connect_flags.ONE_SHOT)`. Other bits are ignored |
| physics: `raycast`, `get_overlapping_bodies`, `set_velocity`, `move_and_slide`, `is_on_floor`, ... | [Physics](#physics) |
| `get_tree_paused()`, `set_tree_paused(b)`, `set_process_mode([n,] m)`, `get_process_mode([n])`, `set_process([n,] b)`, `set_physics_process([n,] b)`, `is_processing([n])` | [pause and process mode](#pause-and-process-mode) |
| `call(node, method, args...)` | synchronous call into another script; returns its value |
| `has_method([n,] method)` | |
| `call_deferred([node,] method, args...)` | at the end of the frame |
| `get_var([n,] name)`, `set_var([n,] name, v)` | another script's member |
| `send_message(name, value)` | broadcast to logic graphs' `Message` nodes (`docs/LOGIC.md`) |
| `command(id, json_text)` | run an instant control command; returns JSON text |

### Transform

`get_position([n])`, `set_position([n,] v)` (local), `get_global_position([n])`,
`translate([n,] v)`, `get_rotation([n])`, `set_rotation([n,] v)` (euler radians),
`rotate_x / rotate_y / rotate_z([n,] rad)`, `look_at([n,] target)`, `get_scale([n])`,
`set_scale([n,] v)`.

### Render

`set_visible([n,] b)`, `is_visible([n])`, `set_color([n,] [r, g, b(, a)])` (the node's
`Primitive` colour: shared meshes and materials are kept, see GAME_GUIDE).

### Groups

`add_to_group([n,] g)`, `remove_from_group([n,] g)`, `is_in_group([n,] g)`,
`get_nodes_in_group(g)` (array), `get_first_node_in_group(g)` (or `null`),
`call_group(g, method, args...)`. A group call skips members that lack the method.

### Input

`is_action_pressed(a)`, `is_action_just_pressed(a)`, `is_action_just_released(a)`,
`get_action_strength(a)`, `get_axis(neg, pos)` (-1..1), `get_vector(neg_x, pos_x, neg_y, pos_y)`
or `get_vector(action2d)` (the value of one 2D action, `ActionState::axis2d`) (`[x, y]`), `is_key_pressed("KeyW")`, `get_mouse_position()`, `set_input_as_handled()`,
`get_mouse_delta()`, `set_mouse_mode("visible" | "hidden" | "captured")`, `get_mouse_mode()`,
`is_mouse_button_pressed("Left")`. Raw events as values: see **Input events** below.
Actions are the engine's (`ActionDef`, rebinding, gamepad: `docs/ACTIONS.md`); prefer them to raw keys.

#### Input events

Besides `_input(action, pressed)`, a script that defines `_input_event(ev)` gets every raw event
(reverse tree order until `set_input_as_handled()`), then `_unhandled_input_event(ev)` for events
the GUI did not consume (`src/scripting/input_events.rs`). `ev` is a dictionary (`ev.type`
or `ev["type"]`):

| `type` | other fields |
|---|---|
| `"key"` | `keycode` (Bevy `KeyCode` name: `"KeyW"`, `"Space"`, `"ArrowLeft"`), `pressed`, `echo` (key repeat) |
| `"mouse_button"` | `button` (`"Left"`, `"Right"`, `"Middle"`, `"Back"`, `"Forward"`), `pressed`, `position` (Vec2, window pixels) |
| `"mouse_motion"` | `position`, `relative` (Vec2) |
| `"mouse_wheel"` | `delta` (Vec2; notches for a wheel, pixels for a trackpad; `dy > 0` is up) |

GUI gets first refusal: while a line edit has focus keyboard events skip `_unhandled_input_event`
(and `_unhandled_input`); while the pointer is over a button or widget (or a `ui_scroll`) mouse
events skip it. `set_mouse_mode("captured")` locks the cursor and turns pointer capture off, so a
free-look camera keeps receiving motion. `_input_event` always sees everything (Godot's `_input`).
Resources: `UiCapture { keyboard, pointer }`, `ScriptMouse { mode, delta }`.

### Time and timers

`delta()`, `physics_delta()`, `time()` (seconds since start), `start_timer(secs, method [, repeat])`
returns an id, `stop_timer(id)`; `timer_start([n] [, secs])`, `timer_stop([n])`,
`timer_left([n])` drive an entity's `ScriptTimer`.

### Physics

Feature `physics` (`src/scripting/api_physics.rs`). Layers and masks are Godot-style int bitmasks.
`[n,]` is the optional leading node.

| Function | |
|---|---|
| `raycast(from, to [, exclude])`, `raycast_dir(from, dir, max_dist [, exclude])` | `null`, or a hit array `[entity, [px,py,pz], [nx,ny,nz], distance]` (ruspy has no maps yet) |
| `get_overlapping_bodies([n])` | entities whose colliders overlap `n`'s collider now (a shape query, so it also works for static sensors; the result is the owning body) |
| `overlap_sphere(center, radius)` | entities inside a sphere |
| `get_velocity([n])`, `set_velocity([n,] v)`, `apply_impulse([n,] v)`, `set_gravity_scale([n,] x)` | `LinearVelocity`, impulse = `v / mass`, `GravityScale` |
| `set_collision_layer([n,] m)`, `set_collision_mask([n,] m)`, `get_collision_layer([n])`, `get_collision_mask([n])` | `CollisionLayers` memberships / filters |
| `move_and_slide([n,] velocity)` | Godot `CharacterBody3D`: sweeps the node's `Collider` by `velocity * physics_delta`, slides up to 4 times, returns the new velocity |
| `is_on_floor([n])`, `is_on_wall([n])`, `is_on_ceiling([n])`, `get_floor_normal([n])` | state of the last `move_and_slide` |

`move_and_slide` adds a `CharacterBody { up, floor_max_angle (45 deg), snap (0.1 m) }` component
(Reflect, editable) and `RigidBody::Kinematic` on first use. Call it from `_physics_process`; it
moves `Transform` directly (use a root node). While not moving up it keeps the body glued to floors
within `snap`:

```
vx = 0.0; vy = 0.0;
fn _physics_process(dt) {
    v = move_and_slide([vx, vy, 0]);
    vx = v[0];
    vy = v[1] - 20.0 * dt;
}
```

Scripted entities with a `Collider` get `CollisionEventsEnabled` automatically, so the built-in
`body_entered` / `body_exited` signals work for sensors (`Sensor`) as well as bodies, including a
static sensor against a kinematic or dynamic body. Static against static never collides (avian).
Not provided: `apply_force` (avian 0.8 has no one-shot force; use `apply_impulse`), per-shape
queries other than ray and sphere.
### Engine subsystems

Bound in `api_engine.rs`; each group needs its cargo feature, and a call into a subsystem the app
did not install is an error ("sound is not set up in this app"). `[n,]` is the optional node.

| Function | Does |
|---|---|
| `play_sound(cue [, [x,y,z]])` -> voice | play a cue (2D, or 3D at a position) |
| `play_sound_at([n,] cue)` -> voice | 3D cue that follows a node |
| `stop_sound(voice_or_cue [, fade])` | stop a voice (int) or every voice of a cue (str) |
| `play_music(name [, fade_in])`, `stop_music([fade])`, `set_music_intensity(x)` | music tracks |
| `set_bus_volume(bus, linear)`, `set_bus_volume_db(bus, db)`, `get_bus_volume(bus)`, `set_bus_mute(bus, b)` | mixer buses |
| `spawn_vfx(preset, [x,y,z])`, `spawn_vfx_at([n,] preset)` | particle effect, returns the entity (null if the budget refuses) |
| `anim_set([n,] param, v)`, `anim_get([n,] param)`, `anim_trigger([n,] param)`, `anim_play([n,] state [, fade])`, `anim_state([n])` | `Animator` parameters and states (layer 0) |
| `toast(text [, body])` | UI toast |
| `get_setting(key)`, `set_setting(key, v)` | registered settings rows (floats; toggles 0/1) |
| `tr(key)` | localized string; the key when unknown |
| `set_time_scale(x)` (0..8), `get_time_scale()`, `get_fps()`, `quit()` | engine |
| `push_error(msg)`, `push_warning(msg)`, `assert(cond [, msg])` | Output panel (file of the running script); a failed assert raises an error |
| `nav_goto([n,] [x,y,z])`, `nav_stop([n])`, `nav_is_done([n])`, `nav_status([n])`, `nav_target([n])` | `NavAgent` control |

A `NavAgent` node emits `navigation_finished` on arrival and `navigation_failed` when no path
exists.

### Tween

Godot's `Tween` (`src/scripting/tween.rs`). A tween is bound to a node (`tween()` is `self`,
`tween(n)` is `n`), dies with it, and follows its process mode: a paused game freezes
pausable tweens, `Always` tweens keep going. Steps run in order; `tween_parallel(id)` makes the
next step run together with the previous one. Defaults like Godot: ease `in_out`, trans `linear`;
`tween_set_ease` / `tween_set_trans` apply to the steps added after them.

| Function | |
|---|---|
| `tween([n])` | new tween id |
| `tween_property(id, [node,] prop, to, secs)` | `prop`: `position`, `rotation` (euler), `scale`, `color` (as `set_color`), `bg`, `text_color`, `alpha`, `member:<name>` (script member), or a reflect path `"Transform.translation.y"` / `"PointLight.intensity"`; `to` is a number, `[x,y,z]` or `[r,g,b(,a)]` |
| `tween_from(id, from)` | start value of the last property step (default: the current value when the step starts) |
| `tween_interval(id, secs)`, `tween_callback(id, method [, args...])` | wait; call a method on the bound node |
| `tween_parallel(id)`, `tween_chain(id)` | next step joins the previous / goes back to sequential |
| `tween_set_ease(id, "in"/"out"/"in_out"/"out_in")`, `tween_set_trans(id, ...)` | `linear sine quad cubic quart quint expo circ back elastic bounce` |
| `tween_set_loops(id, n)` | repeat the whole tween `n` times, `0` = forever |
| `tween_on_finished(id, method)` | sugar: calls `method(id)` when done |
| `tween_pause(id)`, `tween_play(id)`, `tween_kill(id)`, `tween_is_running(id)`, `tween_owner(id)` | control |

When a tween ends it emits `tween_finished(id)` from the bound node:
`connect("tween_finished", self(), "on_done")`. A looping tween never finishes.

```
fn _ready() {
    t = tween();
    tween_set_trans(t, "back"); tween_set_ease(t, "out");
    tween_property(t, "scale", [1.2, 1.2, 1.2], 0.2);
    tween_parallel(t);
    tween_property(t, "color", [1, 0.4, 0.4], 0.2);   // together with the scale
    tween_interval(t, 0.5);
    tween_callback(t, "flash_done");
}
```

Property values at the end of a step are exactly `to`. Each frame costs a few float operations
per active step (reflect paths go through the registry and cost more: use `position`, `scale`,
`color`, `member:` for hot tweens). Callback arguments keep numbers as floats. A step whose
target node was freed is skipped; a property that cannot be read or set goes to the diagnostics.

### Introspection

`script.api` (control command) and `scripting::api_catalogue()` list every host function with
signature and one line of doc (`src/scripting/catalogue.rs`; a test keeps it complete and checks
the docs mention each name). `is_class([node,] class)` and `super_call(name, args...)`: see
"Export hints, `extends`, `class_name`".

### Math

`vec3(x, y, z)`, `vadd`, `vsub`, `vscale(v, k)`, `vlen`, `vnorm`, `vdot`, `vcross`,
`distance(a, b)`, `lerp(a, b, t)`, `randf()` (0..1), `randi_range(a, b)`, `clampf(x, lo, hi)`;
plus ruspy's `abs min max floor ceil round sqrt pow ln exp`.
`randf` uses a seeded generator: runs of the same inputs repeat.

## UI

Nodes are Bevy UI entities, created by function, parented like any node (the first argument is
the parent; none means a root):

```
bar   = ui_hbox();                      ui_set(bar, "anchor", "top");   ui_set(bar, "gap", 28);
label = ui_label(bar, "Score 0");       set_font_size(label, 26);
btn   = ui_button(panel, "Play");       connect(btn, "pressed", self(), "on_play");
bar2  = ui_progress(panel, 0.5);        set_progress(bar2, 0.8);
```

`ui_panel([parent])`, `ui_vbox([parent])`, `ui_hbox([parent])`, `ui_label(parent, text)`,
`ui_button(parent, text)`, `ui_progress(parent, value)`; `set_text([n,] s)`, `get_text([n])`,
`set_font_size([n,] px)`, `set_text_color([n,] color)`, `set_disabled([n,] b)`,
`set_progress([n,] v)`, and `ui_set([n,] prop, value)` for:

| prop | values |
|---|---|
| `width height left top right bottom margin padding gap` | px number, `"50%"`, `"auto"` |
| `anchor` | `top_left top top_right left center right bottom_left bottom bottom_right full` |
| `align` | `start center end` |
| `bg` | colour `[r, g, b(, a)]` or `null` |
| `visible` | bool |

Containers lay out children (vbox: column, hbox: row, `gap` between). Buttons emit `pressed`
(pointer down), `mouse_entered`, `mouse_exited`. UI nodes are ordinary Bevy UI entities (`Node`, `Text`, `Button`), so the usual UI tools see them. Build UI once in
`_ready` and update text only when a value changes (`HUD.on_score`); do not rebuild per frame.

### Widgets

`src/scripting/ui_widgets.rs`. Godot names; each is a Bevy UI entity with a reflected state
component and named children, themed from `Theme`, so it can live in a level file.

| Build | Signal | Read / write |
|---|---|---|
| `ui_checkbox(parent, text [, checked])` | `toggled(pressed)` | `is_checked([n])`, `set_checked([n,] b)` |
| `ui_slider(parent, min, max, value [, step])` | `value_changed(v)` | `get_value([n])`, `set_value([n,] v)` (also drives `ui_progress` bars) |
| `ui_line_edit(parent [, placeholder])` | `text_changed(text)`, `text_submitted(text)` | `get_text`, `set_text` (no signal) |
| `ui_option_button(parent, items)` | `item_selected(index)` | `get_selected([n])`, `select([n,] i)` (no signal) |
| `ui_tabs(parent, titles)` | `tab_changed(i)` | `get_current_tab([n])`, `set_current_tab([n,] i)` |
| `ui_texture_rect(parent, path)` | | an `ImageNode` from an asset path |
| `ui_grid(parent, columns)` | | CSS grid, auto columns |
| `ui_scroll(parent)` | | vertical scroll with the mouse wheel; give it a `height` |
| `ui_margin(parent, px)` | | padding container |

`set_checked` / `set_value` / `set_current_tab` emit their signal when the value changes (Godot
does too), the others do not. Tabs: child 0 of the `ui_tabs` node is the bar, every later child
(`ui_panel(tabs)`, `ui_margin(tabs, 8)` ...) is a page; page `i` shows when tab `i` is selected.
A line edit shows a caret while focused and the placeholder while empty; `get_text` returns the
real text.

**Focus and keyboard.** Buttons and every widget are focusable. A click focuses (clicking
elsewhere clears), Tab / Shift+Tab / Up / Down (gamepad D-pad) move focus in tree order, Left /
Right adjust a slider or option, Enter / Space (gamepad South) activate (button: `pressed`,
checkbox: toggle, option: open), Esc closes a dropdown. Arrows and Enter only act while something
has focus, so games that move with arrows are unaffected. The focused widget gets an accent
outline. `grab_focus([n])`, `release_focus([n])`, `has_focus([n])`; `set_tooltip([n,] text)`
shows a hover bubble after 0.45 s (`""` removes it).

Demo: `examples/script_ui_demo.rs` + `assets/scripts/ui_demo.ruspy` (every widget in a settings
form); `python3 -I scripts/play.py scripts/script-ui-demo.json --example script_ui_demo`.
Known limits: no cursor movement or selection inside a line edit (typing and Backspace only, no
IME composition), no password mode, focus order is tree order (no spatial arrow navigation), one
tooltip at a time without rich content.

## Hot reload

Script files are polled every 0.5 s (`script.reload` forces it). A changed file reloads every
instance of it: new code, **members kept**. A file with errors keeps the previous version
running and reports `file:line:col`. All of `assets/scripts/*.ruspy` is parsed at startup, so
syntax errors show before a script runs. Level files hot reload too (`docs/LEVELS.md`).

## Control commands

| Command | |
|---|---|
| `script.list` | instances: entity, name, file, hooks, ready, declared signals; plus scripts that failed to load |
| `script.vars {entity}` | a script's members (`entity`: bits, `"12v0"` or a `Name`) |
| `script.set_var {entity, name, value}` | set a member |
| `script.call {entity, method, args}` | call a function now; returns its value |
| `script.emit {entity, signal, args}` | emit a signal; returns the number of calls |
| `script.reload` | reload every script from disk (members kept) |
| `script.stats` | call counts and timing (below) |

## Error handling and diagnostics

Script problems go to `LogicDiagnostics` (the same list graphs use; the editor's Output panel,
`logic.diagnostics`): `{severity, file, line, col, message, count}`.

- Syntax errors: located; the old version keeps running on a reload.
- Runtime errors (wrong argument type, missing node, `null` where an entity is needed, step
  limit): located at the call, the function returns, the game goes on. `get_node("Typo")`
  says what path was tried from which node.
- Each call has a step limit of 200 000; `while` loops that never end stop with
  `execution budget exceeded`.
- A missing method on a signal target, a freed target, or a dangling node path is reported
  once per site (`count` grows).

## Performance

One instance per scripted entity (an `Engine` + `Module`, a few KB). Hooks a script does not
define cost nothing. Calls go through the ruspy VM (bytecode) and fall back to the interpreter
for files that use arrays or method calls (`Source::interp`), which is slower; keep per-frame
hot paths in number-only functions when you can, and use `script.stats` to see where time goes.
`find`, `%Name` and `/Root` lookups use `tree::NameIndex` (`Name` → entities, kept by
observers), so they no longer scan the world. The presence of `_process` etc. and the check in
`call`/`has_method` use the function names recorded when the file was loaded (its outline) instead
of building a VM per call.
Host functions that walk the world (`get_nodes_in_group` over many nodes,
`get`/`set` with reflection paths at ~4 us each) are for events, not for every entity every frame.
For hundreds of entities per frame write a Rust system.

Measurements (M-series Mac, `cargo test` dev profile with optimised dependencies, so the
scripting crate code is unoptimised; run
`memgate -- cargo test -q --lib scripting::bench -- --ignored --nocapture --test-threads=1`):

| Case | Before | After |
|---|---|---|
| `_process` on 1 000 scripts (3 member updates, `get_position` + `set_position`), 120 frames | 1210 us/frame, 1.21 us/call | 1206 us/frame, 1.21 us/call (same within noise: the VM call dominates, the old `has_fn` check was cheap) |
| `find(name)` among 10 000 named entities | 73.4 us/lookup (full scan) | 0.20 us/lookup (index) |

Still to measure (release):

| Case | Result |
|---|---|
| `_process` on 1 000 scripts, number-only body | TBD |
| `_process` on 1 000 scripts, array/vector body (interpreter) | TBD |
| `emit_signal` with 3 connections | TBD |
| `call(node, ...)` across scripts | TBD |
| `get` / `set` reflection path | TBD |
| `instantiate` of a 2-entity level | TBD |
| Lantern Keeper frame cost (`script.stats.last_frame_us`) | TBD |
| Hot reload of one script on 100 instances | TBD |

## Known limits

- **`await` is statement-level only** (see Coroutines); awaiting another coroutine does not wait for it.
- **No synchronous re-entrant calls into the same script**: if A calls B and B calls A while A
  is running, the inner call fails with "already running". Pass data in signal arguments, or
  use `call_deferred`.
- **Pause follows `process_mode`** (see above). `_physics_process` does not tick while paused
  in any mode (it rides `FixedUpdate`, which rides virtual time).
- The VM falls back to the interpreter for arrays, dicts, method calls and member assignment (see Performance).
- No closures or classes in ruspy: structured data is arrays and dicts; there is no
  `@export` metadata (types, ranges) yet, so the editor shows members as plain values.
- Node references are handles with no ownership: a stale one is detected with `is_valid`; using one errors with "no longer exists".
- `instantiate` clones a level file: its entities carry `LevelEntity` (the editor will save
  them with the level that holds them); use `change_scene` for whole levels.
- Physics signals need a physics step: `body_entered` arrives a frame after the contact, and
  Avian only reports pairs that include a dynamic body (static sensor plus kinematic player
  does not fire).
- Scripts see only reflected components through `get`/`set`; register your types
  (`#[derive(Reflect)] #[reflect(Component)]`, `app.register_type`).

## Scripts vs logic graphs

| | Node scripts (this doc) | Logic graphs (`docs/LOGIC.md`) |
|---|---|---|
| Shape | an entity's code and state | a graph of events, flow, effects |
| State | members in the script | components (`get`/`set`) |
| Best for | gameplay objects: player, enemies, pickups, HUD, game rules | sparse designer-driven behaviour: doors, triggers, quests |
| Talks to others | signals, groups, node paths | `Message` nodes, `Find` |
| UI | built from script | none |

They coexist. A graph's `Script` node calls a function of a plain `scripts/*.ruspy` file with
no instance (the older model); a node script can fire a graph with `send_message(name, value)`
(a `Message` node), and a graph can call into a node script with `emit` + a connection or
`command("script.call", ...)`. Prefer node scripts for new gameplay code; keep graphs where a
designer needs to see and tweak the wiring.
