# Game logic: node graphs + ruspy scripts (`engine::logic`, feature `logic`; `crates/logic-core`)

Gameplay as data. A **graph** wires events (overlap, key press, timer, tick, message) to flow
(branch, sequence, delay, for-each) and effects (set a field, run a control command, call a
script). A **script** is a small ruspy function for what a graph is clumsy at. Both are plain
text files, hot-reloaded, and never crash the game: every problem is a located diagnostic.

- **`crates/logic-core`** (no Bevy): graph types (RON), validation, interpreter. All world
  access and side effects go through the `Host` trait.
- **`engine::logic`**: `Logic` component, graph asset loader, event sources, the ECS host,
  the ruspy script host, `LogicDiagnostics`, control commands.
- Example: `python3 -I scripts/play.py scripts/logic-demo.json --example logic_demo`
  (door: `assets/logic/door.logic.ron`, `assets/scripts/score.ruspy`; `scripts/logic-break.json`
  breaks the script on purpose and checks the diagnostics).

## Quick start

```rust
app.register_type::<Door>();                       // components graphs read/write: Reflect
commands.spawn((Door::default(), Logic::new("logic/door.logic.ron"),
                Collider::cuboid(2.0, 3.0, 0.8), Sensor, CollisionEventsEnabled));
```

`assets/logic/door.logic.ron` (shortened):

```ron
Graph(
    nodes: [
        (id: 1, kind: OverlapEnter),
        (id: 2, kind: Delay(secs: 0.5)),
        (id: 3, kind: Set(path: "Door.open"), defaults: [("value", Bool(true))]),
        (id: 4, kind: Script(file: "score.ruspy", function: "on_open", args: ["who"])),
    ],
    flow: [ (from: (1, "then"), to: (2, "in")), (from: (2, "then"), to: (3, "in")),
            (from: (3, "then"), to: (4, "in")) ],
    data: [ (from: (1, "other"), to: (4, "who")) ],
)
```

## Graph format

`Graph(name, nodes, flow, data)`:

- `nodes`: `(id: u32, kind: <NodeKind>, defaults: [(pin, Value)], pos: (x, y))`. Ids are yours
  (stable, referenced by links and by diagnostics); `pos` is the editor canvas position.
- `flow`: exec links `(from: (node, "pin"), to: (node, "in"))`. Execution pins are `then` (most
  nodes), `true`/`false` (Branch), `0..n-1` (Sequence), `body`/`done` (ForEach).
- `data`: data links `(from: (node, "out pin"), to: (node, "in pin"))`.
- `defaults`: the value of a data input nothing is connected to (`Num(4.0)`, `Bool(true)`,
  `Str("x")`, `Vec3((0.0, 1.0, 0.0))`, `Json([1, 2])`, `Entity(bits)`, `Null`).

Values: `Null`, `Bool`, `Num` (f64), `Str`, `Vec3`, `Entity` (`Entity::to_bits`), `Json`. Pin
types are `Bool, Number, String, Vec3, Entity, Json, Any`; `Json`/`Any` are dynamic (checked
when the value arrives), everything else must match at link time. Numbers convert to
`String` for `Log`, `Json` arrays of three numbers become `Vec3`.

Rules checked by `Graph::compile()` (errors carry the node id and pin):
duplicate ids; links to missing nodes/pins; exec output linked twice (use `Sequence`); data
input linked twice; type mismatch; required input with nothing connected and no default; cycles
in data links; data chains deeper than 64. Unreached exec nodes are warnings.

### Nodes

| Kind | Exec in / out | Data in | Data out |
|---|---|---|---|
| `Start` | - / `then` | | `self` |
| `Tick` | - / `then` | | `self`, `dt` |
| `OverlapEnter`, `OverlapExit` | - / `then` | | `self`, `other` (entity) |
| `Action("name")` | - / `then` | | `self`, `value` |
| `Timer(secs, repeat)` | - / `then` | | `self` |
| `Message("name")` | - / `then` | | `self`, `value` |
| `Branch` | in / `true`, `false` | `cond` bool | |
| `Sequence(n)` | in / `0`..`n-1` (1..=16) | | |
| `Delay(secs)` | in / `then` (after `secs`) | | |
| `ForEach` | in / `body`, `done` | `list` json array | `item`, `index` |
| `Find("name")` | | | `entity` (the entity with that `Name`, or null) |
| `Get(path)` | | `entity` (default: self) | `value` |
| `Set(path)` | in / `then` | `entity` (default: self), `value` | |
| `Const(Value)` | | | `value` |
| `Math(Add/Sub/Mul/Div/Min/Max)` | | `a`, `b` | `result` |
| `Clamp` | | `value`, `min`, `max` | `result` |
| `Compare(Eq/Ne/Lt/Le/Gt/Ge)` | | `a`, `b` | `result` bool |
| `And`, `Or`, `Not` | | `a`, `b` | `result` |
| `Vec3Make`, `Vec3Split`, `Vec3Add`, `Vec3Scale` | | `x y z` / `v` / `a b` / `v s` | `v` / `x y z` |
| `Command(id, params)` | in / `then` | one per `"$name"` in `params` | `result` (json) |
| `Script(file, function, args)` | in / `then` | one per name in `args` | `result` |
| `Emit("name")` | in / `then` | `value` (optional) | |
| `Log` | in / `then` | `text` | |

- **Events**: the node's `then` starts a flow. `self` is the entity carrying `Logic`.
- **Get/Set paths**: `Component.field.sub` through reflection, e.g. `Transform.translation.y`,
  `Door.open`. Component names match the registered short type name (case-insensitive).
  Whole numbers write into integer fields. A missing component/field is an error.
- **Command**: `params` is JSON; a string equal to `"$name"` is replaced by the value of data
  pin `name`: `Command(id: "ecs.set", params: {"id": "$target", "component": "Transform", "value": {"translation": "$pos"}})`.
  Only instant commands (see `engine.commands`); needs feature `devtools`.
- **Data nodes** are pure and evaluated lazily when read; results are cached until the next
  side effect. Exec-node outputs (`Script.result`, `Command.result`, ForEach `item`/`index`)
  can be read by later nodes of the same event but not after a `Delay` (it starts a new run).
- **Delay** uses game time (pauses with the game). The pending flow keeps the event's
  `self`/`other`/`value`/`dt`.

### Interpreter limits

Each event run has a step budget (10 000 nodes executed + data nodes evaluated); a graph that
loops forever stops with an error naming the node. `Message` delivery rounds are capped at 4
per frame, so two graphs can't ping-pong forever. Division by zero, wrong types and missing
entities are node errors, not panics.

## Events and sources

| Event | Source |
|---|---|
| `Start` | once per entity, when its graph is loaded (not again on hot reload) |
| `Tick` | every frame (not while paused); `dt` = frame delta |
| `Timer` | per entity, from the time its graph loaded; repeating timers keep their phase |
| `OverlapEnter/Exit` | avian `CollisionStart/End` for an entity with `Logic` (+ `CollisionEventsEnabled`; use `Sensor` for triggers). `other` = the other body. Feature `physics` |
| `Action(name)` | `ActionState::just_pressed(name)`; `value` = the action's value. Feature `actions` |
| `Message(name)` | `LogicMessage` (Rust), `Emit` nodes, script `emit(name, v)`; delivered to every graph with that `Message` node |

Avian puts resting bodies to sleep, which ends their overlaps: add `SleepingDisabled` to
anything whose overlap must persist while it stands still.

## Scripts

`assets/scripts/<name>.ruspy`, called by `Script` nodes (`file: "score.ruspy"` means
`scripts/score.ruspy`). Language: `docs` of ruspy (`fn`, `if`, `while`, `for`, arrays, `str`
`+` number concatenation, `null`, `tostr(x)`, `is_null(x)`, `len`, math builtins). Variables
set at top level run once when the file loads; keep state in components (`get`/`set`), not in
script globals: a reload resets globals.

| Host function | |
|---|---|
| `self()` | the entity whose graph is running (an int) |
| `get(path)`, `get(entity, path)` | read a component field (numbers, strings, bools; vec3 as `[x, y, z]`; `null` for none) |
| `set(path, v)`, `set(entity, path, v)` | write one |
| `command(id, json_text)` | run an instant control command; returns the result as JSON text |
| `emit(name, v)` | send a message |
| `log(text...)` | line in `LogicDiagnostics::log` and the game log |
| `find(name)` | entity with that `Name`, or `null` |

Each call has a step limit (200 000 interpreter steps); runaway loops stop with
`E0307 execution budget exceeded`. Scripts are polled every 0.5 s: a changed file reloads, a
file with errors keeps the previous version running and reports line:col. All of
`assets/scripts/*.ruspy` is loaded at startup, so syntax errors show before the script runs.
A script that runs a command that runs another script gets "script engine is busy" (no
re-entrancy).

## Diagnostics (`LogicDiagnostics`)

One list for graph and script problems: `{severity, file, line, col, node, message, count}`.
Graph problems name the `node`; script problems have `line`/`col`. Repeats collapse into
`count`. A clean reload of a file clears its entries. `log` holds the last 200 lines of
`log()` output. The editor's Output panel reads this resource.

A graph file with errors does not replace the running graph: the last good version keeps
running while the error is listed.

## Control commands

| Command | |
|---|---|
| `logic.list` | entities with `Logic`: graph, loaded, event nodes, `started`; plus timing stats |
| `logic.fire {entity, event, other?, value?, dt?}` | run an event now: `start`, `tick`, `overlap_enter`, `overlap_exit`, `action:<name>`, `message:<name>`, `timer:<node id>` |
| `logic.diagnostics {clear?}` | `{errors: [...], log: [...]}` |
| `logic.reload` | reload every graph and script from disk |

Hot reload of graph files needs the `hot_reload` feature (Bevy's file watcher; it
recompiles Bevy); `logic.reload` does the same on demand. Scripts always hot reload.

## Performance

Measured on an M-series Mac (dev profile: engine opt-level 1, deps 3), `LogicStats`:

- logic-core, 10-node graph (compare, branch, get, mul, add, clamp, set), mock host, release:
  **0.18 µs per event** (7 nodes run). Nothing allocates in the steady state for number/bool/vec3
  graphs (scratch buffers are reused; strings/json clone an `Arc` or allocate).
- Door graph on the ECS (`Tick` → Get bool → Branch → Get y, Math ×3, Set y: reflection
  access, ~12 nodes): **~20 µs per tick event** averaged over 1 400 events in `logic_demo` (most of it is the
  four reflection accesses, ~4 µs each: type lookup, path walk, JSON round trip; max seen 125 µs).
- Script call (`on_open`: 1 get, 1 set, `log`, string building): **~65 µs per call** (2 calls measured: 1 get, 1 set,
  `log`, string building; includes entering the script host).
- Cost when unused: `Logic`-less worlds pay one empty query per frame; a graph without a
  `Tick` node costs nothing per frame beyond its timers.

For per-frame logic on hundreds of entities prefer Rust systems; graphs are for sparse,
designer-driven behaviour (triggers, doors, quests, scripted sequences).

## Known limits

- Graph files hot reload only with the `hot_reload` feature (or `logic.reload`).
- `ruspy` is a path dependency while the `embed` branch is unmerged; ruspy has no maps or
  closures yet, so structured values reach scripts as arrays or JSON text.
- Events are delivered to the entity that carries `Logic`; there is no "broadcast to entities
  with tag" yet (use `Message`).
- Overlap events need a physics step: they arrive a frame after the contact.
