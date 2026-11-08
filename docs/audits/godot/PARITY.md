# Godot parity gap analysis for the engine's scripting, UI and script-to-engine layer

Scope: what a Godot 4 developer reaches for in scripts and does not find (or finds awkward) on
branch `scripting`. Sources read: `docs/SCRIPTING.md`, `src/scripting/*.rs`, the Lantern Keeper demo,
`docs/audits/godot/SCRIPTING.md`, and the ruspy repo (`/Users/himanshu/codes/ruspy`: `ruspy.md`,
`src/ast.rs`, `src/value.rs`, `src/interpreter/mod.rs`, `RUSPY_TODO.md`). Godot citations use the
audit's checkout (`/Users/himanshu/codes/game/godot`).

Tags: **[E]** engine-only (this repo), **[R]** needs a change in the ruspy repo, **[E+R]** both.
Sizes: S (under 1 day), M (1 to 3 days), L (a week or more).

## 0. Where it stands

Done well (this is a real Godot-shaped core, not a toy): per-entity script instances with members
and hot reload that keeps them; `_ready` children-first, `_process`/`_physics_process` by priority,
`_input`/`_unhandled_input`, `_exit_tree`; synchronous signals with `one_shot`/`deferred`/binds
saved in level files; groups; node paths (`..`, `/Autoload`, `%Unique`); `call_deferred`,
`queue_free`; timers; `instantiate`/`change_scene`; autoloads; a script-built UI of six node kinds;
control commands `script.*`; located diagnostics; per-call step limit.

Where a Godot developer hits a wall in the first hour, in order:

1. The language has no `match`, no maps/dictionaries, no lambdas, no classes, no string methods,
   no `await`. Every GDScript idiom they know for data and async is missing.
2. Nodes are bare ints and every operation is a global function (`set_position(n, v)` instead of
   `n.position = v`, `n.get_node("A")`). Bevy components that are not Transform/Visibility/Name
   are reachable only through string-path reflection `get("Comp.field")`.
3. UI has 6 widgets. No LineEdit, CheckBox, Slider, TextureRect, ScrollContainer, Grid, Tab,
   OptionButton, no themes, no focus/keyboard navigation from script, no tooltips, no rich text.
4. No physics queries (raycast, overlap list, CharacterBody `move_and_slide`), no audio, no
   animation, no tween, no particles, no nav agents from script, although every one of those
   subsystems exists in Rust (section 4).
5. No `@export` metadata, so the editor shows members as bare values; no typed members.
6. No input events as objects (mouse motion/clicks, touch, key events) and no InputMap editing.
7. No 2D at all (see 2D below).

## 1. Script language ergonomics

Facts about ruspy today (`/Users/himanshu/codes/ruspy/src/ast.rs`, `value.rs`): values are
`Int Float Bool Str Char Array Struct Void Null`. Statements: `Var Assign IndexAssign FieldAssign
Struct Print Expr Block If Fn Return While For Break Continue Import`. Expressions: literals,
unary/binary, `&&`/`||`, `Call(name, args)` (free function by name only), `Member`, `Range`, `Array`,
`Index`, `Method` (arrays only: `len push pop first last clear contains sum min max`),
`StructLit`. Optional type annotations on vars and params (`a: int = 1`), gradual typing, a static
checker. Four engines (interpreter, VM, Cranelift, protected). Imports (`import "utils.ruspy"`)
are spliced by the loader.

| GDScript feature | Here today | Gap / how a Godot dev feels | Proposed design |
|---|---|---|---|
| `class_name`, `extends`, inheritance | none; one file = one instance, no base-class dispatch | Cannot share behaviour between `enemy.ruspy` and `boss.ruspy` except by copy or by `call`ing a helper node. Painful | **[E]** cheap form: `extends = "enemy.ruspy";` top-level declaration, resolved by the engine: the instance loads base module first, derived functions shadow base ones, `super_call("_ready")` host function walks up. Members merge. No ruspy change (engine builds the chain over several `Module`s). Later **[R]**: real `extends` keyword |
| Inner classes, `class_name` global types | none | Cannot declare `class_name Player`, no `is Player` checks, no typed node refs | **[E]** `class_name = "Player";` top-level registers the file in a global registry; host `is_class(n, "Player")`, `get_nodes_of_class(name)`. Pairs with `extends` |
| Typed vars (`var hp: int = 3`) | ruspy accepts `hp: int = 3` and checks; the engine's `ScriptProps`/JSON path does not carry the type; hot reload and editor ignore it | Types exist in the language but the engine never uses them for the inspector | **[E]** read declared types from the outline; surface them in `script.vars` and the editor; coerce `ScriptProps` JSON by declared type |
| `@export` with hints (`@export_range(0,10)`, enum, file, color, multiline) | a plain top-level assign plus `ScriptProps`; no metadata (documented as known limit) | Editor shows raw numbers; no sliders, colour pickers, enum dropdowns | **[E]** comment-annotation convention parsed by the engine, no language change: `speed = 5.0; // @export range(0, 20, 0.5)`. Also `// @export enum(Idle, Run)`, `// @export color`, `// @export file(*.ron)`. Outline gives the line; engine parses the trailing comment. Editor-ui renders from `ExportInfo`. **[R]** later: first-class `@export` attribute with spans |
| `@onready var x = $A/B` | `x = null;` plus assign in `_ready` | Works, a little verbose; `$A/B` shorthand missing | **[R]** `$Path` / `%Name` lexer sugar to `get_node("Path")`. Low value alone; **[E]** alternative: `// @onready A/B` annotation that the engine resolves before `_ready` (member pre-filled). **[E]** S |
| Setters/getters (`set(v):`) | none | Cannot react to `hp` changes without a manual function | **[E]** convention `fn set_hp(v)` / `fn get_hp()` invoked by `set_var`/`get_var` and inspector writes when defined. Does not intercept in-script assignment (same as Godot, where in-class writes bypass setters unless `self.` is used). S |
| `enum`, `const` | none; use top-level numbers | Magic numbers and strings (`state == "playing"` in demo) | **[R]** `const NAME = expr;` (checker-enforced) and `enum State { Idle, Run }` lowering to consts. **[E]** nothing. S in ruspy |
| `match` | only `if/else if` chains | Long state machines are verbose | **[R]** `match x { 1 => {...}, "a" | "b" => {...}, _ => {...} }` desugared to if-chain in parser. M |
| Dictionary / `{}` | no maps. Structured data = arrays or JSON text | The single biggest ergonomic hole: inventories, stat blocks, save data, signal payloads | **[R]** a `Value::Map` with literal `{ "a": 1 }`, `m["k"]`, `.keys() .values() .has(k) .erase(k) .size()`, `for k in m`. Host boundary: map to/from JSON object (already how `ScriptProps` and `call` args cross). M. Structs exist and are close; a struct literal can serve as a stopgap now (`Item { name: "x", n: 2 }`), but they are nominal and not iterable |
| Array/String methods | arrays: 9 methods. strings: concat only | No `split join substr find replace to_upper begins_with format %`, no `sort`, `map`, `filter`, `slice`, `insert`, `remove_at`, `append_array`, `size` alias | **[R]** a string and array method pack (pure functions, easy and testable, all four engines). **[E]** stopgap: register `str_*` host functions, but they cost the VM fallback and are not worth doing if [R] is planned. M |
| String formatting (`"%d items" % n`, `"{}".format`) | `"a" + 3` concatenation only (documented) | `"Score " + score` works for demo; padding, floats (`%.2f`) impossible | **[R]** `fmt("{} / {:.1}", a, b)` builtin plus `%` operator on str. S in ruspy; **[E]** stopgap: `format(fmt, args...)` host function. S |
| Lambdas / Callables (`Callable`, `.bind()`, `func(x): ...`) | none; handlers are named methods connected by string name | Cannot write `button.pressed.connect(func(): start())`; cannot pass callbacks (`sort_custom`, tween callbacks, timers) | **[R]** first-class function values `fn(x) { ... }` (closures over module globals only is enough: members are already module-level so capture-by-reference of globals is free). Then host `connect(btn, "pressed", fn_value)`. L for full closures; **[E]** stopgap that covers 80%: `callable(node, "method", binds...)` returning a struct `Callable{ node, method, binds }` accepted everywhere a (target, method) pair is. M |
| `await` / coroutines / `yield` | none (documented). `start_timer(secs, method)` or a state member | Without `await get_tree().create_timer(1).timeout` and `await signal`, every delay is a split function. Sequences (cutscenes, tutorials, menu flows) become state machines | **[E+R]** the design that fits ruspy: `await_signal(node, "name")`, `await_time(secs)` as ordinary host calls that **suspend the VM frame** (needs ruspy to expose resumable execution: the bytecode VM has register frames so a yielding call is feasible, interpreter fallback is harder). Engine stores the suspended frame with a wake condition (timer or signal) and resumes it in Events. Without ruspy support, a **[E]**-only CPS stopgap: `after(secs, "method")` plus signal `connect(..., one_shot)`. L (ruspy suspend) + M (engine scheduler) |
| `static func`, `static var` | every top-level function is callable by `call(node, ...)` only on an instance | No utility libraries without an autoload node | **[E]** `import "util.ruspy"` already splices files; document it as the "static" mechanism, and make `call("/Game", ...)` documented as the autoload pattern. S |
| `preload("res://x.tscn")` / `load()` | `instantiate("path")` loads on call; no resource objects | Cannot hold a loaded scene/texture/sound in a member | **[E]** host `load("path")` returning a resource handle (int into a `ScriptResources` table keyed by path, refcounted per instance) usable by `instantiate`, `set_texture`, `play`. M |
| `print`, `push_error`, `push_warning`, `assert`, `printerr` | `log`, `print` only; ruspy `print expr;` statement | No levels, no `assert`, no stack trace on a script error (just `file:line:col`) | **[E]** `push_error`, `push_warning`, `assert(cond, msg)` mapping to diagnostic severities. S |
| `is_instance_valid`, `weakref`, typed node refs | `is_valid(n)` only | Node refs are raw ints with no generation safety visible to scripts (Entity bits do include generation, so stale refs are detected correctly) | fine; add `is_instance_valid` alias. S |
| `Vector2/3`, `Color`, `Basis`, `Quaternion`, `Transform3D` | `[x,y,z]` arrays and 12 `v*` functions; no operators on vectors (`a + b` is array concat or error) | The most visible math friction. `v * speed * dt` is `vscale(v, speed*dt)` | **[R]** `Vec2/Vec3/Color` as built-in struct-like values with `+ - *` operator overloading, `.x .y .z`, `.length() .normalized() .dot() .cross() .lerp() .distance_to()`, so `pos += dir * speed * dt` works. This is the highest-value language change after Dictionary. M-L. **[E]** stopgap: more functions (`vlerp`, `vdist`, `vdir`, `quat_*`, `color_lerp`, `deg_to_rad`, `rad_to_deg`, `move_toward`, `sign`, `wrap`, `smoothstep`, `snapped`, `lerp_angle`, `randf_range`, `randi`, `pick_random`, `shuffle`, `seed`) S |

Language items that do **not** need to exist: `@tool` (documented, play-in-editor model), `super()`
init chains, `_init` with args, `signal` typed params (see Signals).

## 2. Node API breadth

Exists (`api.rs`, `api_node.rs`): self/get/set/get_node(_or_null)/find/get_parent/get_children/
get_name/get_path/is_valid/queue_free/spawn_node/add_child/reparent/set_name/attach_script/
instantiate/change_scene; position/rotation/scale get/set, translate, rotate_x/y/z, look_at;
visible get/set; set_color. No method on a node reference (`n.position`): everything is a global
function taking the node first.

Missing, by how often a Godot dev types it:

- **Properties as members**: `node.position = v`, `node.global_position`, `node.rotation`,
  `node.scale`, `node.visible`, `node.name`, `node.modulate`, `node.text`. **[E+R]** Make a node a
  `Value::Struct("Node", {id})` (or a dedicated `Value::Object(id)`) and let the host resolve
  `Member`/`FieldAssign`/`Method` on it (the AST already has `Member`, `Method`, `FieldAssign`, all
  documented as "resolved by the host"). Then `n.position = v`, `n.get_node("A")`, `n.queue_free()`,
  `n.emit_signal(...)`, `n.connect(...)` become possible with one host dispatch table that reuses
  the existing function registry (`n.foo(a)` calls registered `foo(n, a)`). **That single change
  delivers "usable like Godot" for the whole API at once** and is mostly in `ruspy::interpreter`
  (host call-method hook) plus an engine dispatcher. Cost to the VM fallback: method calls already
  force the interpreter (documented), so this lands there first. M.
- Global transforms: `get_global_position` exists; missing `set_global_position`, `global_rotation`,
  `to_local`, `to_global`, `global_transform`, `get_transform/set_transform`, `basis`, `forward()`
  (`-Z`), `right()`, `up()`, `rotate_object_local`, `translate_object_local`, `look_at_from_position`,
  `set_rotation_degrees`, `rotation_degrees`, quaternion get/set. **[E]** S-M, plain host functions
  on `Transform`/`GlobalTransform`.
- Tree: `get_child(i)`, `get_child_count()`, `has_node(path)`, `remove_child`, `is_ancestor_of`,
  `get_owner/set_owner`, `move_child`, `get_index`, `get_tree().reload_current_scene()`,
  `get_tree().quit()`, `get_tree().paused`, `find_children(pattern)`, `duplicate()`,
  `is_inside_tree()`, `is_queued_for_deletion()`, `get_node_count_in_group`, `set_process(b)`,
  `set_physics_process(b)`, `set_process_input(b)`, `process_mode` (documented missing), signals
  `ready`, `tree_entered`, `tree_exiting`, `child_entered_tree`, `child_exiting_tree`, and
  notifications (`_notification(what)`). **[E]** M. `set_process` is important: the hook-detection
  is by outline, so a Godot dev cannot switch `_process` off for an idle enemy.
- Render: only `set_visible` and `set_color`. Missing `set_material`, `set_mesh`, `set_texture`,
  `modulate`, `set_emission`, `set_light_energy`, `set_light_color`, `set_shadow`, `set_layer`,
  `show()/hide()`, `get_aabb`, `set_cast_shadow`. **[E]** S each; wire through `Primitive`, the
  `gfx::load_pbr` path and `Handle<StandardMaterial>` tables. Honour the Scenery/Actor and
  shared-material rules in `docs/GAME_GUIDE.md` (do not clone a material per call).
- Spawning primitives: `spawn_node` makes an empty node. No `spawn_mesh("cube")`,
  `spawn_light`, `spawn_camera`, `spawn_collider`, so a script cannot build a prop. **[E]** M:
  `spawn(kind, parent)` with kinds `cube sphere plane cylinder capsule point_light spot_light
  camera collider_box collider_sphere` reusing `meshkit`.
- Camera: `make_current`, `set_fov`, `project_position`, `unproject_position`, `get_viewport().
  get_mouse_position()`, `shake`. **[E]** S-M.
- Generic component access beyond reflection: `get("Comp.field")` ~4 us each and requires
  `#[reflect(Component)]`; no `has_component`, `add_component(name, json)`, `remove_component`.
  The inspector (`ecs.spawn/set`) already does this; **[E]** S to expose.

## 3. Signals

Exists: declare (`signal("x")`), emit, connect/disconnect by (source, signal, target, method),
`one_shot`, `deferred`, binds (JSON, saved), built-ins `timeout pressed mouse_entered mouse_exited
body_entered body_exited`, synchronous delivery, re-entrancy deferral, located diagnostics.

Gaps vs Godot:

- **No typed signal params and no introspection.** `signal("hit")` takes no argument list, so the
  editor Node dock (signals tab, "connect to method" dialog) cannot show `hit(hp: int)`. **[E]**
  accept `signal("hit", "hp", "attacker")` (names only, optional) and expose in `script.list`;
  used by the editor to show the signature. S.
- `is_connected(src, sig, tgt, method)`, `get_signal_connection_list`, `has_signal`,
  `get_signal_list`, `disconnect_all(node, sig)`, `connect` flags as arguments
  (`connect(a, "x", b, "m", ONE_SHOT | DEFERRED)`; today only via component or separate keywords).
  **[E]** S.
- Signal as a value: `button.pressed.connect(fn)`, `sig.emit(...)`, `await sig`. Needs lambdas and
  coroutines (language table above). Until then expose `connect(src, sig, callable_struct)` (see
  `callable()` stopgap).
- Built-in signal catalogue is small. Add: `ready`, `tree_entered`, `tree_exiting`,
  `child_entered_tree`, `child_exiting_tree`, `visibility_changed`, UI `toggled(on)`,
  `value_changed(v)`, `text_changed(s)`, `text_submitted(s)`, `item_selected(i)`, `gui_input`,
  `focus_entered/exited`, `resized`, `button_down/up`, animation `animation_finished(name)`,
  `anim_notify(name)`, nav `target_reached`, `navigation_finished`, sound `finished`, timer
  `timeout`, VFX `finished`, physics `area_entered/exited` (same as body today), `input_event`.
  Most are one-line emitters next to the existing event pump. **[E]** M total.
- `CONNECT_APPEND_SOURCE_OBJECT` and `CONNECT_REFERENCE_COUNTED`: skip.
- Physics signals fire only when a dynamic body is in the pair (documented). A Godot dev with a
  static Area3D and a kinematic player gets silence. **[E]** M: add our own overlap pass for
  sensors (`SpatialQuery::shape_intersections` once per physics tick per sensor with a script)
  and emit regardless of body type; this also gives `get_overlapping_bodies()`.

## 4. Subsystems that exist in Rust and only need bindings (cheap wins)

Each of these is a registry entry or two in `src/scripting/api_*.rs` calling an existing
component, resource or control command. Verified in this tree.

| Subsystem (file) | Existing Rust surface | Proposed script functions | Size |
|---|---|---|---|
| Sound (`src/sound/voice.rs`, `cue.rs`, `music.rs`) | `SoundCtl::play/play_at/play_on/play_with/stop/stop_cue/stop_all/set_volume`, `Voices::get/outcome`, `Music::play/stop/set_intensity`, buses, snapshots, captions | `play_sound(cue)`, `play_sound_at(cue, pos)`, `play_sound_on(cue [,n])` returns voice id; `stop_sound(voice [,fade])`, `set_sound_volume(voice, v)`, `play_music(name [,fade])`, `stop_music([fade])`, `set_music_intensity(x)`, `set_bus_volume(bus, db)`, `snapshot(name)`; signal `finished` per voice. Godot's `AudioStreamPlayer.play()` shape: `play_sound(cue)` on a node = `play_sound_on`. **[E]** | S-M |
| Animation (`src/anim/machine.rs`, `commands.rs`) | `Animator::set(param, ParamValue)`, `param`, state, `anim.play`, `anim.param`, notifies (`AnimNotify`, `FiredNotify`) | `anim_set([n,] param, v)`, `anim_get`, `anim_play([n,] state)`, `anim_state([n])`, signal `anim_notify(name)`, `animation_finished(state)`. Exactly the `AnimationTree` `set("parameters/x", v)` workflow. **[E]** | S-M |
| VFX (`src/vfx/mod.rs`) | `Vfx::play(effect, Transform) -> Option<Entity>`, `ParticleEffect`, presets, `VfxLibrary::names` | `spawn_vfx(name [, pos [, parent]])` returns entity, `vfx_names()`, `stop_vfx(n)`. Cheaper than Godot's GPUParticles3D setup. **[E]** | S |
| AI / nav (`src/ai/agent.rs`, `control.rs`) | `NavAgent`, `NavAgentState::set_target/stop/remaining`, `NavStatus`, nav raycast/nearest/path commands, behaviour trees, perception | `nav_goto([n,] pos)`, `nav_stop`, `nav_remaining`, `nav_status`, `nav_set_speed`, `nav_nearest(pos)`, `nav_path(a, b)` (array of points), `nav_raycast(a, b)`; signal `target_reached`; `sense_can_see(a, b)` | M |
| Actions (`src/actions/`) | rebind, context, rumble, state commands | `rumble(strength, secs)`, `rebind(action, key)`, `set_action_context(name)`, `get_actions()`, `is_action_just_pressed` exists | S |
| Props (`src/props/`) | topple, debris, sway | `break_prop([n])`, `topple([n], dir)` | S |
| Physics (avian3d, `chase.rs` uses `SpatialQuery`, `SpatialQueryFilter`) | `SpatialQuery::cast_ray/cast_shape/shape_intersections/point_intersections`, `RigidBody`, `LinearVelocity`, `Collider`, `CollisionLayers`, `ExternalForce`, `Sensor` | `raycast(from, to [, mask])` returns `[hit_bool, point, normal, node]` or `null`, `raycast_dir(from, dir, len)`, `shape_overlaps_sphere(pos, r [, mask])` array of nodes, `get_overlapping_bodies([n])`, `set_velocity([n], v)`, `get_velocity`, `apply_impulse([n], v)`, `apply_force`, `set_collision_layer/mask([n], bits)`, `set_layer_bit`, `set_body_type([n], "static\|kinematic\|dynamic")`, `set_gravity_scale`, `move_and_slide([n], velocity)` (see below). Behind feature `physics` (already feature-gated). **[E]** | M |
| UI toast (`src/ui/toast.rs`) | `Toast::new().body().color().secs()` | `toast(title [, body])` | S |
| Settings (`src/settings.rs`, `ui::widgets::get_field/set_field`) | named fields with get/set | `get_setting(key)`, `set_setting(key, v)` | S |
| Save/load (`src/devkit` saves, `save.write/load`) | `save.list/write/load/delete` | `save_data(slot, map_or_json)`, `load_data(slot)`; with Dictionary this becomes `FileAccess`/`ConfigFile` substitute | S (needs JSON text until maps exist) |
| L10N (`src/l10n/`) | translation lookup | `tr(key [, args])`, `set_locale(name)` | S |
| Level data (`src/level/`) | save/load level, `level.*` | `save_scene`, `pack_scene(node, path)` (PackedScene.pack) | M |
| Logic bridge | `send_message` exists | fine | n/a |

**CharacterBody (move_and_slide).** Not in the engine as a script-facing thing; `chase.rs` and
`fps.rs` do their own. Godot developers write `velocity = ...; move_and_slide()` for every player
and enemy. Add a `CharacterMotor { velocity, up, floor_max_angle, snap }` component (kinematic body,
shape-cast slide with up to 4 iterations, floor detection) plus host `move_and_slide([n])`,
`is_on_floor([n])`, `is_on_wall`, `get_floor_normal`, `get_slide_collision`, member-style
`get_velocity/set_velocity`. **[E]** M-L (the one non-trivial engine feature on this list; a
`bevy_tnua`-style controller is the alternative but adds a crate).

## 5. Scene system and resources

Exists: a `.level.ron` is a scene; `instantiate(path [, parent])` clones it as a subtree and
returns its root; `change_scene`; autoloads; `Script`/`Connections`/`Groups` saved in the level;
hot reload of levels; editor edits `ScriptProps`.

| Godot | Gap | Proposal |
|---|---|---|
| `PackedScene` as a value (`var s = preload("x.tscn"); s.instantiate()`) | path string only, every call re-reads/clones the file | `load(path)` resource handle (section 1), cache parsed scene; `instantiate(handle)`. Makes spawners cheap. **[E]** M |
| Instanced child scenes inside a scene, editable children, scene inheritance | levels cannot nest another level file as a node; no inheritance | A `LevelRef { path, overrides: Vec<(node_path, component, json)> }` component that instantiates at load and applies overrides (this is what Godot stores for an instanced scene with edited children). Inheritance = a level whose root is a `LevelRef`. **[E]** L; needs the level/editor owners |
| `owner` | none; `LevelEntity` marks level membership but scripts cannot query it | `get_owner([n])` = root of the instantiate that created it (store `SceneOwner(Entity)` at instantiate). **[E]** S |
| `duplicate()` | none | `duplicate([n])` deep-copies reflected components of the subtree (the editor backend already does copy/paste: reuse) **[E]** M |
| Custom `Resource` scripts (`class_name Item extends Resource`), `.tres` | none; structured data is JSON text | With Dictionary: `load_json("data/items.json")` returns a map; a `Resource` file type is a `.res.ron`/`.json` with a script path for behaviour. Recommend **not** copying `.tres`; JSON + maps + struct is the Rust-first answer. **[E+R]** after maps, M |
| Scene-tree-wide queries | `get_nodes_in_group`, `find` | `get_tree()` pseudo-object (`tree_pause()`, `tree_quit()`, `reload_current_scene()`, `get_node_count()`), `get_root()`. **[E]** S |
| Unique names / `%` | present | n/a |

## 6. Input

Exists: actions (pressed, just pressed/released, strength, axis, vector), `is_key_pressed`,
mouse position, `_input(action, pressed)` over engine actions, `set_input_as_handled`.

Gaps:

- **`_input(event)` receives `(action, pressed)`, not an event.** Godot developers write
  `if event is InputEventMouseButton and event.pressed:` or `event.relative` for look. Missing:
  mouse button events with position, mouse motion with `relative`/`velocity`, mouse wheel, raw key
  events with `keycode`, touch (`InputEventScreenTouch/Drag`), gamepad button/axis events, text
  input. **[E+R]** deliver `_input(event)` where `event` is a struct `{ type: "mouse_button",
  button: 1, pressed: true, position: [x, y] }` (struct values are available today), keep the old
  `(action, pressed)` signature as `_action_input(action, pressed)` or detect arity from the outline.
  With maps this is a dictionary. Engine-only if using struct literals built on the Rust side:
  **[E]** M (build `Value::Struct` per event; ruspy `Struct` values already exist). Plus
  `event_is_action(event, "jump")`.
- `Input.mouse_mode` (capture/visible/hidden/confined), `warp_mouse`, `set_cursor_shape`,
  `get_last_mouse_velocity`, `get_mouse_delta()` (look controls are impossible without it).
  `src/fps.rs` already captures the mouse; **[E]** S: `set_mouse_mode(mode)`, `get_mouse_delta()`.
- InputMap editing at runtime: `InputMap.add_action/action_add_event/action_erase_events`. The
  engine has `actions.bind/rebind`; **[E]** S: `bind_action(action, "KeyQ" | "Pad:South" |
  "Mouse:Left")`, `unbind_action`, `rebind` wraps what `controls_screen.rs` already does.
- `Input.is_mouse_button_pressed`, `is_joy_button_pressed`, `get_joy_axis`, `vibrate`: via actions
  preferred; add `is_mouse_button_pressed(b)`. **[E]** S.
- Pointer picking: `input_event` on a 3D body (click on object) and `mouse_entered/exited` for 3D
  nodes (only UI buttons have it). **[E]** M: cast a ray from the camera on click, emit
  `input_event(button, pos)` / `clicked` on bodies with a script; the editor already has
  `src/editor/picking.rs` to crib from.

## 7. UI

Exists (`src/scripting/ui.rs`, 397 lines): `ui_panel/vbox/hbox/label/button/progress`, `set_text`,
`get_text`, `set_font_size`, `set_text_color`, `set_disabled`, `set_progress`, `ui_set` props
(`width height left top right bottom margin padding gap anchor align bg visible`), signals
`pressed mouse_entered mouse_exited`. These are plain Bevy UI entities. The engine UI kit (not yet
bound) has `Focusable`/`Focus`/`NavQueue` keyboard-gamepad navigation, `Segment` tabs/`TabButton`,
`ToggleSwitch`, `SliderTrack`, `FieldRow`, `ScrollList`, `Theme`, `Look`, `Toast`, colourblind and
accessibility modes (`src/ui/widgets.rs`, `theme.rs`, `toast.rs`).

Catalogue vs Godot:

| Godot Control | Here | Proposal (engine unless noted) | Size |
|---|---|---|---|
| Label | yes | add `autowrap`, `align`, `valign`, `max_lines`, outline, `font` | S |
| Button | yes (pressed, no toggled) | `toggle_mode`, `button_pressed`, `toggled(on)`, `button_down/up`, `icon`, `flat`, hotkey shortcut | S |
| CheckBox / CheckButton | no | `ui_checkbox(parent, text, on)`, signal `toggled(on)`; reuse `ToggleSwitch` look | S |
| HSlider / VSlider | no | `ui_slider(parent, min, max, value, step)`, `value_changed(v)`, `get_value/set_value`; reuse `SliderTrack` + `step_value` | M |
| ProgressBar | yes | add `fill_color`, `show_percentage` | S |
| LineEdit | no | `ui_line_edit(parent, text, placeholder)`, `text_changed`, `text_submitted`, `secret`, `max_length`, caret/IME. Needs a text-input component; check `bevy_ui_text_input`-style crate vs own (own is small for single line). The editor links `bevy_egui` already, but game UI must not use egui | M-L |
| TextEdit / CodeEdit | no | multi-line variant of LineEdit | L |
| RichTextLabel (BBCode) | no | `ui_rich_label(parent, "[b]bold[/b] [color=red]x[/color]")` building styled `TextSpan` children (Bevy 0.20 supports multi-span text); `meta_clicked` for links | M |
| TextureRect / NinePatchRect / icons | no | `ui_image(parent, path)` using `ImageNode`; `set_texture([n,] path)`; `stretch_mode`; nine-slice via `ImageNode` slicer | S-M |
| ColorRect | partial (`ui_panel` + `bg`) | add `ui_color_rect` alias | S |
| OptionButton / MenuButton / PopupMenu | no | `ui_option(parent, ["a", "b"])`, `item_selected(i)`, `get_selected`; settings screen already has a `Segment`/cycle widget | M |
| ItemList / Tree | no | `ui_list(parent, items)`, `item_selected`, `item_activated`, `add_item`, `clear` | M |
| SpinBox / ColorPicker / FileDialog | no | defer | L |
| BoxContainer | vbox/hbox | add `separation` alias of `gap`, `alignment` | S |
| GridContainer | no | `ui_grid(parent, columns)` (Bevy `Display::Grid` is available) | S |
| MarginContainer | via `padding` | add `ui_margin` alias | S |
| ScrollContainer | no (`ScrollList` marker exists in widgets) | `ui_scroll(parent)` with wheel/drag, scroll bars, `scroll_vertical` | M |
| TabContainer | no (settings screen has tabs) | `ui_tabs(parent)` + children as pages, `tab_changed(i)` | M |
| HSplit/VSplit, FlowContainer, CenterContainer, AspectRatioContainer, PanelContainer | no | `ui_center`, `ui_flow` (flex-wrap), `ui_aspect` | S each |
| Popup / Window / AcceptDialog / ConfirmationDialog | no | `ui_dialog(title, text, ["OK", "Cancel"])` modal with signal `confirmed`/`canceled` built from panel+buttons | M |
| Tooltip (`tooltip_text`) | no | `set_tooltip([n,] s)` with a hover timer and one shared tooltip entity | M |
| Theme (`theme`, `add_theme_*_override`) | engine has `ui::theme::Theme` (Rust) | `set_theme_color([n,] name, c)`, `set_theme_font_size`, `set_theme_stylebox_flat(bg, border, radius)`; apply `ui_set(n, "border_radius"/"border"/"border_color")`; global `ui_set_theme("dark")` over `ui::Theme` presets | M |
| Anchors/size flags/min size (`custom_minimum_size`, `size_flags_horizontal = EXPAND_FILL`) | `anchor`+`width/height`+`align` | `ui_set(n, "min_width"/"min_height")`, `ui_set(n, "grow", 1.0)` (Bevy `flex_grow`), `"fill"`, `"expand"`, `z_index`, `clip` | S |
| Focus & keyboard navigation (`grab_focus()`, `focus_next`, `focus_mode`, `ui_accept`) | `ui::widgets::Focusable/Focus/NavQueue` exist for engine screens; script buttons are not `Focusable` | Make `ui_button` and the new widgets `Focusable` automatically, add `grab_focus([n])`, `has_focus`, `ui_set(n, "focus_neighbor_left", other)`, `focus_entered/exited`; gamepad `ui_accept` already flows through `UiAction` | M |
| Input handling (`mouse_filter`, `gui_input`, `_gui_input`, drag and drop) | none | `ui_set(n, "mouse_filter", "stop\|pass\|ignore")` (Bevy `Pickable`), `gui_input(event)` signal, `set_drag_preview`, `can_drop` | M-L |
| Animation of UI (Tween on modulate/position) | none | see Tween below | n/a |
| CanvasLayer | n/a: Bevy UI is already screen-space; z-order via `GlobalZIndex` | `ui_set(n, "layer", 5)` | S |
| In-world UI (`Label3D`, `SubViewport` UI) | none | `spawn_label3d(text)` using the engine's world-text if any (billboarded `Text2d` quad); defer | M |
| `ui_label` text with localisation | none | `set_text` accepts keys when prefixed `tr:`; or call `tr()` | S |
| `queue_free` on a UI node | works (despawn recursive?) | verify children freed (subtree), and `_exit_tree` | S |

Usability notes: the UI is imperative only. Godot's strength is that the UI is a **scene** built in
the editor. Plan for **declarative UI**: `ui_build(spec)` taking a nested array/map once maps exist
(`["vbox", {gap: 8}, ["label", "Hi"], ["button", "Play", "pressed", "on_play"]]`) or a `.ui.ron`
file loaded by `instantiate_ui(path)`. This dramatically cuts boilerplate such as `hud.ruspy`
(68 lines for four labels and a panel). **[E]** M, bigger with the editor-ui. Also expose the
engine's menu/screens and settings screen (`engine.menu`, `settings`) so a script game can open
the existing settings UI instead of rebuilding it: `open_settings()`, `open_pause_menu()`.

## 8. 2D

Does the engine support 2D? **No.** A grep for `Camera2d`, `Sprite`, `Text2d` finds only the UI
fallback camera, VFX/overlay internals and editor/metrics windows; no 2D game path, no tilemaps,
no 2D physics (avian3d only; no `avian2d`), no 2D lighting. A Godot developer who makes 2D games
(roughly the largest share of Godot users) finds nothing: no `Sprite2D`, `AnimatedSprite2D`,
`Node2D`, `Camera2D`, `TileMap`, `CollisionShape2D`, `ParallaxBackground`, `Line2D`, `CanvasLayer`,
`y_sort`.

Proposal (large, treat as its own milestone, not part of the 15 below except where marked):
a `Node2D` convention = an entity with `Transform` where scripts use `position2d`/`rotation2d`
(z kept for draw order) and `Camera2d` with `Projection::Orthographic`; `Sprite2D` = Bevy `Sprite`
with `set_texture`, `region`, `flip_h`, `modulate`; `AnimatedSprite2D` = sprite sheet clip player
(can reuse `anim` clip machinery or be a 40-line atlas stepper); `Camera2D` with `zoom`, `limit_*`,
smoothing, shake; tilemap = `TileMap` component with an atlas and a `.tilemap.ron` plus
`set_cell(x, y, id)`; 2D physics via `avian2d` behind a feature (it is the same Avian 0.8 family
and does not pull a second Bevy). Script API mirrors 3D: `position`/`rotation` as `[x, y]` values
(needs `Vec2` in the language). **[E+R]** L. Recommend deciding product direction first: this
engine's identity (docs and Shroud) is 3D, so a thin "2.5D via ortho camera + sprites on the 3D
transform" path (S-M) gives most of the benefit without avian2d.

## 9. Animation and Tween

Tween is the most-used Godot script feature the engine lacks:
`create_tween().tween_property(node, "position", target, 0.5).set_trans(...).set_ease(...)`,
`.parallel()`, `.chain()`, `tween_callback`, `tween_interval`, `finished`.

Proposal **[E]**: a `Tweens` resource of small structs `{ target, property_path, from, to, secs,
ease, delay, loop, on_done_method }` advanced in `ScriptSet::Process` (no allocation per frame;
property paths resolved by the same reflection as `get/set`, with a fast path for
`position`/`scale`/`rotation`/`modulate`/UI `bg`/`text_color`/`progress`). Script API without
lambdas: `tween(node, "position", [0,2,0], 0.4)` returns a tween id; options set after:
`tween_ease(id, "out_cubic")`, `tween_delay(id, 0.2)`, `tween_loop(id, 3)`,
`tween_then(id, "method")` (or `tween_then(id, target, "method")`), `tween_kill(id)`;
signal `tween_finished(id)`. `tween_sequence([ ... ])` and `tween_parallel` combinators take arrays
of tween ids once chain semantics are defined. Ease set = Bevy's `EaseFunction` (all 30 curves).
Size: M, engine-only; huge perceived value (UI juice: panels sliding in, score pops, door lerps).

AnimationPlayer (keyframe a property on a timeline): not present as an authored asset; engine has
a skeletal `anim` module (state machines, blend spaces). Two distinct things: bind `anim` (section
4) and add a small **property animation** asset (`.anim.json`: tracks of
`(node_path, property, [(t, v, ease)])`, `play("open_door")`, `animation_finished`) built on the
same Tween core. **[E]** M-L, after Tween.

Timers are covered (`start_timer`, `ScriptTimer`); `await` ergonomics need coroutines (section 1).

## 10. Tooling

| Godot | Here | Gap and proposal |
|---|---|---|
| Script editor: syntax highlighting, completion, signature help, go to definition | none in-engine; scripts are text files edited externally | **[E]** (+ **[R]** for the symbol table): an LSP-lite over the ruspy `check` manifest. ruspy has a typed host manifest used to check calls ("unknown host fn = compile error"); generate it from the registered host functions plus signatures so editors get completion and arity errors. Ship a VS Code/Zed TextMate grammar and a JSON schema of host functions (`script.api` control command dumps names, params, docs). S-M for `script.api` and docs generation; L for an LSP |
| Docs in editor (F1 class reference) | `docs/SCRIPTING.md` only | generate the host function table from registration (`e.register(name, ..)` + a doc string) so docs cannot drift: add a `doc` argument to the registry. S |
| Debugger: breakpoints, step, variables, call stack | none. Located diagnostics only | **[R]** needs a debug hook in the ruspy VM/interpreter (per-statement callback with line + a pause flag) and **[E]** the control-port commands `script.break {file, line}`, `script.continue`, `script.step`, `script.stack`, `script.locals`. Interpreter-only first (VM fallback exists). L |
| Stack traces on error | `file:line:col` of the failing call only | **[R]** return a call stack (`Vec<Frame{fn, line}>`) in the error type and print it. S-M |
| Error navigation (click error, jump to line) | diagnostics carry file/line/col in `LogicDiagnostics`; the editor Output panel shows them | **[E]** open-in-external-editor action (`$EDITOR file:line` or `code -g`). S |
| Remote scene tree / inspector while running | `ecs.query/get/set`, `script.vars`, `script.list`, `level.tree` exist over the control port | Already ahead of Godot for headless; a `script.tree` returning the node tree with script file and members per node would be a single command. S |
| Profiler | `script.stats` (call counts/time per script), `profile_scope!`, perf monitor | Add per-function self time and a `script.stats {reset}`; surface in the metrics window. S-M. The doc's measurement table is all TBD: fill it |
| Print/Output panel with filtering and severity | `LogicDiagnostics::log` | add severity levels via `push_error/push_warning` (section 1). S |
| Hot reload with state | yes (members kept) | already better than Godot's; add `_on_reload()` hook so a script can rebuild derived state. S |
| Live script editing in editor | `@tool` documented as not needed | OK |
| Unit testing | Rust `Scenario` kit; `scripting/tests*.rs` | expose a script-side test runner: `assets/scripts/tests/*.ruspy` with `fn test_x()` and `assert(cond)`; command `script.test`. M |

## 11. Project, autoload, settings

Exists: `Autoloads` resource (name, file) as root entities, input actions as `ActionDef`s, settings
UI, levels, `change_scene`.

Gaps: autoloads are registered in Rust, not a project file. Godot's `project.godot` lets a designer
add one in the UI. **[E]** S: read `project.ron` (`autoloads`, `main_scene`, `actions`, `window`,
`physics_fps`, `layers: ["player", "enemy", "world"]`) at startup so a scripts-only project needs no
Rust. Layer names also give script-side `layer("enemy")` bit lookups (`set_collision_mask`). Other
missing items: `ProjectSettings.get_setting`, `OS.get_ticks_msec`, `OS.get_name`,
`Engine.time_scale` (`time.scale` command exists: expose `set_time_scale`), `Engine.get_frames_per_
second`, `get_viewport().size`, `DisplayServer.window_set_mode` (fullscreen), `Time.get_datetime`.
**[E]** S as a batch (`get_fps()`, `set_time_scale(x)`, `get_viewport_size()`, `set_fullscreen(b)`,
`os_name()`, `unix_time()`, `quit()`, `pause_game()/resume_game()`, process_mode per node).
Per-node `process_mode` (when paused / always) is needed for pause menus driven from script (the
HUD cannot run while the game is paused today, because every scripting set is skipped).
**[E]** M: `Script.process_mode: Inherit | Pausable | Always | WhenPaused` honoured by the
pump; strongly recommended since script-built pause menus cannot work without it.

Also missing and cheap: `FileAccess`-like read/write of `user://` text (`read_text(path)`,
`write_text(path, s)` in the save dir), `ConfigFile` (use JSON), `HTTPRequest` (skip), `OS.execute`
(skip, security), `Engine.is_editor_hint()` as `is_editor()` (S).

## 12. Ruspy repo changes (collected)

Ordered by payoff for the Godot-feel goal; all other items in this report are engine-only.

1. Host-dispatched method calls and member access on node values: `n.position`, `n.get_node(..)`,
   `n.position = v` (`Method`/`Member`/`FieldAssign` exist in the AST; need a host callback
   `host.call_method(recv, name, args)` and `host.get_member/set_member`). M.
2. `Value::Map` with literal syntax and methods; JSON round trip. M.
3. `Vec2/Vec3/Color` value types with operators and swizzles. M-L.
4. String and array method packs; `fmt`/`%`. M.
5. `match`, `const`, `enum` (parser desugars). S-M.
6. First-class function values (non-capturing + global capture) and `callable`. L.
7. Suspendable frames (`await`). L. Needs a design decision between VM-only vs both paths.
8. Debug hooks and call-stack in errors. M-L.
9. Optional: `extends`/`class_name` keywords (the engine can fake them with top-level
   declarations), `@export` attribute syntax, `$Path` sugar. S each.

## 13. Ranked roadmap: 15 items by value / effort

Ordering favours things that unlock many Godot habits at once for little cost. Cheap bindings come
first because they turn existing engine power into script power with no language work.

| # | Item | Size | Tag | Why |
|---|---|---|---|---|
| 1 | **Bind existing subsystems**: sound (`play_sound*`, music), VFX (`spawn_vfx`), anim params, toast, settings, l10n `tr`, time scale/fps/quit, `push_error/assert` | S-M | engine-only | Section 4: each is a few lines over an existing API; makes a script-only game feel complete (audio, particles, animation) |
| 2 | **Physics queries**: `raycast`, `get_overlapping_bodies`, overlap sphere, velocity/impulse/layers; static-sensor overlap emitter for `body_entered` | M | engine-only | Almost every 3D game script needs a ray or an overlap; avian is already linked |
| 3 | **Tween** (`tween(node, prop, to, secs)` + ease/delay/loop/then) | M | engine-only | Most used Godot script feature; unlocks UI juice and procedural motion |
| 4 | **Method/member syntax on node values** (`n.position = v`, `n.get_node(..)`, `n.queue_free()`) over the existing registry | M | needs-ruspy (+ engine dispatcher) | One change that makes the entire API read like GDScript |
| 5 | **Dictionary (`{}`)** in ruspy with JSON round trip, then use it for events, save data, `ScriptProps`, `ui_build` | M | needs-ruspy | Removes the biggest data-modelling hole; many other features (events as dicts, resources, declarative UI) depend on it |
| 6 | **UI widget pack part 1**: checkbox, slider, line edit (single line), texture rect, grid, scroll container, option button, `toggled/value_changed/text_submitted` signals, `grab_focus` and keyboard/gamepad focus for script buttons | M-L | engine-only | Section 7: unlocks settings screens, menus, inventories; reuses `Focusable`, `SliderTrack`, `ToggleSwitch`, `ScrollList` |
| 7 | **`process_mode` and `set_process(b)`** per node (pausable, always, when_paused) | S-M | engine-only | Required for script pause menus; also lets idle enemies stop costing |
| 8 | **Input events as values** (`_input(event)` with mouse button/motion/wheel/key/touch struct, `get_mouse_delta`, `set_mouse_mode`, `bind_action`) | M | engine-only (uses ruspy structs) | Needed for mouse look, click-to-select, rebinding UIs |
| 9 | **`@export` metadata** via comment annotations (range, enum, color, file, multiline) + typed `signal("hit", "hp")` + `script.api` dump of host functions for editors | S-M | engine-only | Makes the editor feel like Godot's inspector; cheap, no language change |
| 10 | **`extends` / `class_name`** (top-level declaration, base module chain, `super_call`) | M | engine-only | Enables reuse between enemy types without copy-paste |
| 11 | **`await_time` / `await_signal`** coroutines (engine scheduler + ruspy resumable frames) | L | needs-ruspy | Biggest async ergonomics win; start with `after(secs, "method")` as the engine-only stopgap (S) |
| 12 | **Vec2/Vec3/Color value types with operators** | M-L | needs-ruspy | `pos += dir * speed * dt`; removes the `vadd/vscale` noise from every script |
| 13 | **String/array method pack, `fmt`, `match`, `const`, `enum`** | M | needs-ruspy | Many small daily-use pains; parser sugar plus pure functions |
| 14 | **CharacterBody `move_and_slide`** + `is_on_floor` (`CharacterMotor` component) | M-L | engine-only | Every player controller in Godot uses it; today scripts can only teleport or fight Avian |
| 15 | **Navigation + AI bindings** (`nav_goto`, `target_reached`, `nav_path`) and **declarative UI** (`ui_build(spec)` / `.ui.ron`) | M each (do nav first) | engine-only (ui_build after maps) | Nav is a 20-line binding over `NavAgentState`; declarative UI is the real "scene for UI" |

Also worth scheduling next (just outside the top 15): debugger/breakpoints and stack traces
(L, needs-ruspy), PackedScene resources plus scene instancing with overrides (L, engine-only),
tooltips/themes/rich text (M), 2D support (L, needs product decision), script-side unit-test runner
(M), `project.ron` for autoloads/layers/actions (S).

## 14. Quick wins list (under a day each, engine-only)

`push_error`, `push_warning`, `assert`, `quit`, `get_fps`, `set_time_scale`, `toast`, `tr`,
`play_sound`, `spawn_vfx`, `anim_set`, `get_child(i)`, `get_child_count`, `has_node`,
`is_connected`, `ui_checkbox`, `ui_grid`, `ui_set` additions (`min_width`, `grow`, `border`,
`radius`, `layer`), `is_mouse_button_pressed`, `deg_to_rad`, `rad_to_deg`, `move_toward`, `sign`,
`wrap`, `randf_range`, `pick_random`, `shuffle`, `vlerp`, `vdist`, `format`, `get_owner`,
`forward()`, `set_global_position`, `show`/`hide`, `_on_reload` hook, `script.api` command.

## 15. Risks and notes for implementers

- Every new host function that walks the world or reflects is ~4 us; keep per-frame use out of
  scripts and keep the registry O(1) (the `find`, group, and reflection paths already warn).
- Method syntax on node values (item 4) pushes more scripts onto the interpreter fallback. Measure
  with `script.stats` before and after; consider teaching the VM method dispatch before shipping.
- Bevy feature set must not change for scripting features (`CLAUDE.md`): UI widgets above use
  existing Bevy UI; `LineEdit` must not add a crate that pulls a second Bevy/wgpu. Prefer our own
  single-line text input (caret, selection, clipboard via `arboard` only if already present).
- Never toggle view features at runtime from script APIs (`set_ssao`, `set_bloom`): expose
  `set_quality_level` through the governor instead (GAME_GUIDE rules).
- Tween and physics bindings run in different sets (Process vs FixedUpdate): keep tweens of
  physics bodies in `FixedUpdate` or tween a visual child.
- Determinism: `randf` is seeded; keep new random helpers on the same generator; seeds in saves.
