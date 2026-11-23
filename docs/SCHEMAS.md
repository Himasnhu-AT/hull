# Config schemas

Every config file in a Hull game, what it may contain, and an example. Field names and ranges can still
move, but the shape (a kind, an id from the path, references by id, UI hints, direct edits recorded in the history) is
the design. Kinds that are described here but have no schema yet are marked "not built".

The schemas are written once in TypeScript (TypeBox) under `packages/hull/src/schema/` and emitted as JSON Schema
(draft 2020-12) files into `schemas/`. The JSON below is the shape of what gets emitted (abridged: the files in `schemas/` are the whole truth, one per kind:
`game`, `tuning`, `sound`, `mixer`, `character`, `anim-set`, `anim-graph`, `ui-theme`, `ui-screen`, `input-map`, `look`, `vfx`, `material`).

## 1. Conventions

### A file

```json
{
  "kind": "sound",
  "note": "Blade on armour. Short and bright."
}
```

| Field | Rule |
|---|---|
| `kind` | One of the kinds below. It matches the first folder under `config/`. |
| id | Not written in the file. It is the path under `config/` without `.json`: `config/sound/sword/hit.json` is `sound/sword/hit`. |
| `note` | Optional. One line for the person reviewing it. Shown in the Studio. |

Files carry no `$schema` line. Hull knows the schema from the kind; the emitted files in `schemas/` can be mapped
in an editor by hand.

### Units and types

* Seconds, metres, radians (degrees only where a field name ends in `Deg`), decibels for levels, hertz for
  frequency. A field's unit is in its `x-ui.unit`.
* Colours are `"#rrggbb"` strings. Vectors are arrays: `[x, y, z]`.
* A **range** is `[min, max]`: a value is drawn from it each time, from the seeded random stream.
* A **curve** is a list of `[t, value]` points with `t` from 0 to 1, interpolated smoothly.

### References

A field that points at another config file is a string id, and its schema says which kind:

```json
{ "type": "string", "x-ref": "sound" }
```

`check` fails on an id that does not exist, and the generated id list makes the same mistake a compile error
in code.

### UI hints (`x-ui`)

Standard JSON Schema says what is valid. `x-ui` says how to edit it in the Studio.

| Hint | Meaning |
|---|---|
| `widget` | `slider`, `dial`, `number`, `toggle`, `select`, `segments`, `color`, `curve`, `vec3`, `range`, `ref`, `text`, `keys`, `bindings` (a map of input actions as a table with key chips; `input-map` only) |
| `unit` | Shown after the value: `m`, `s`, `dB`, `Hz`, `°`, `%` |
| `step` | Slider and arrow-key step |
| `group`, `order` | Section and position in the form |
| `help` | One sentence under the field |
| `live` | `false` if a change needs the bench restarted (default `true`) |
| `advanced` | Hidden until "show all" |

### Edits and history

The Studio writes your change into the file itself, keeping its formatting and key order. Hull records the change
in its history with you as the author, described by path:

```
you   sound/sword/hit   level −6 → −3
ai    sound/sword/hit   source.layers.ring.then[0].freq 2400 → 2600
```

Lists that you tune item by item are written as objects keyed by name rather than arrays, so a change to one item
is one path and two experiments that touch different items merge cleanly.

### Values in code

A value that belongs to one piece of code can live there instead, in a `tunables` block (see `ARCHITECTURE.md`
section 4). It gets the same hints, the same sliders and the same history:

```ts
export const player = tunables('player', {
  runSpeed: num(12.5, { min: 0, max: 30, unit: 'm/s' }),
});
```

### Versions

Schemas have no version field yet and there is no migration tool. When a kind changes shape, the files in the
repository's templates and kits are rewritten with it.

## 2. The game manifest (`hull.json`)

```json
{
  "kind": "game",
  "id": "mygame",
  "title": "My Game",
  "version": "0.1.0",
  "entry": "src/main.ts",
  "generators": "src/audio/generators.ts",
  "models": "src/bench/models.ts",
  "step": 60,
  "features": ["audio", "anim", "ui", "vfx"],
  "render": { "backend": "auto" },
  "start": { "screen": "ui-screen/title", "level": "level/yard" },
  "systems": ["waves", "score"],
  "targets": {
    "web": { "singleFile": false },
    "desktop": { "appId": "com.example.mygame", "systems": ["mac", "win", "linux"], "window": { "width": 1280, "height": 720 } }
  },
  "budgets": { "bundleKb": 900, "frameMsP95": 14, "drawCalls": 600 }
}
```

Schema (abridged):

```json
{
  "$id": "urn:hull:schema:game",
  "type": "object",
  "required": ["kind", "id", "title", "entry"],
  "properties": {
    "kind": { "const": "game" },
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$" },
    "title": { "type": "string" },
    "version": { "type": "string" },
    "entry": { "type": "string" },
    "generators": { "type": "string", "x-ui": { "help": "A module that registers the game's code sound generators; its default export is called once. The Studio's sound bench loads it, so sounds with a code source render there too." } },
    "models": { "type": "string", "x-ui": { "help": "A module that registers the bodies the game builds in code for its characters (a builder per character id, or per prefix such as \"titan-*\"): its default export is called once with register(match, build). The Studio's character bench draws those bodies, and plays the character's clips and state graph on them, instead of its rigid stand-ins." } },
    "step": { "enum": [30, 60, 120], "default": 60, "x-ui": { "unit": "Hz", "help": "Fixed simulation rate." } },
    "features": { "type": "array", "items": { "enum": ["audio", "anim", "ui", "vfx", "physics", "saves"] } },
    "render": { "type": "object", "properties": { "backend": { "enum": ["auto", "webgl2", "webgpu"], "default": "auto", "x-ui": { "widget": "select", "help": "Which renderer draws the game. auto tries WebGPU and falls back to WebGL2. A game with GLSL shader code of its own pins webgl2." } } } },
    "start": { "type": "object", "properties": { "screen": { "type": "string", "x-ref": "ui-screen" }, "level": { "type": "string", "x-ref": "level" } } },
    "systems": { "type": "array", "items": { "type": "string" } },
    "targets": { "type": "object" },
    "budgets": { "type": "object", "properties": { "bundleKb": { "type": "number" }, "frameMsP95": { "type": "number" }, "drawCalls": { "type": "number" } } }
  }
}
```

## 3. `tuning`: a block of numbers owned by code

A block of numbers kept as a file, for values that are shared (several pieces of code, a level, a tool) or that vary by file (one per enemy type, one per difficulty). The file schema says only "`kind`, an optional `note`, and numbers": the names and ranges come from a `tunables` block of the same name in code. A kit's block is overridden by `config/tuning/<block>.json` (block name in kebab case; `thirdPerson` is `third-person.json`): keys the file lacks keep the code value. A key the block does not know, or a value its options refuse, is a problem at `file#/key`. Numbers used by one piece of code alone and not shared go in a `tunables` block with no file.

```json
{
  "kind": "tuning",
  "height": 2.4,
  "coyote": 0.1
}
```

The emitted file schema is just `{ "kind": "tuning", "note"?: string, <any key>: number }`. A block's own widgets (below) come from the code:

```json
{
  "type": "object",
  "properties": {
    "height": { "type": "number", "default": 2.2, "minimum": 0.5, "maximum": 8, "x-ui": { "unit": "m", "step": 0.1 } },
    "coyote": { "type": "number", "default": 0.12, "minimum": 0, "maximum": 0.4, "x-ui": { "unit": "s", "step": 0.01, "help": "How long after leaving a ledge a jump still counts." } },
    "airControl": { "type": "number", "default": 0.6, "minimum": 0, "maximum": 1, "x-ui": { "widget": "slider" } }
  }
}
```

## 4. `sound`

One thing you can hear: a hit, a step, a loop.

```json
{
  "kind": "sound",
  "note": "Blade on armour. Short and bright.",
  "bus": "sfx",
  "level": -6,
  "pitch": [0.95, 1.05],
  "limit": { "minGap": 0.06, "voices": 4, "over": "steal-oldest" },
  "spatial": { "ref": 4, "max": 60, "airLowpass": true },
  "source": {
    "type": "synth",
    "length": 0.5,
    "layers": {
      "ring": {
        "from": { "osc": "triangle", "freq": [1800, 2300], "glideTo": 0.7, "glideTime": 0.12 },
        "then": [
          { "filter": "bandpass", "freq": 2400, "q": 6 },
          { "envelope": { "attack": 0.002, "decay": 0.28, "curve": "exp" } },
          { "gain": -4 }
        ]
      },
      "clack": {
        "from": { "noise": "white" },
        "then": [
          { "filter": "highpass", "freq": 3000 },
          { "envelope": { "attack": 0.001, "decay": 0.04 } },
          { "gain": -8 }
        ]
      }
    },
    "reverb": 0.15
  }
}
```

`source.type` is one of:

| Type | Body |
|---|---|
| `synth` | `layers`: named chains, each a source (`osc`, `noise`) followed by shapers (`filter`, `envelope`, `gain`, `drive`, `delay`, `pan`). Any number can be a range. |
| `sample` | `file` (in `assets/`), `start`, `end`, `loop` |
| `pick` | `from`: a list of other sound ids, one chosen per play (`random`, `shuffle`, `sequence`) |
| `code` | `generator`: a function registered in code; `knobs`: values for its own schema |

Schema (abridged):

```json
{
  "$id": "urn:hull:schema:sound",
  "type": "object",
  "required": ["kind", "source"],
  "properties": {
    "kind": { "const": "sound" },
    "bus": { "type": "string", "default": "sfx", "x-ref": "bus" },
    "level": { "type": "number", "default": 0, "minimum": -60, "maximum": 12, "x-ui": { "widget": "slider", "unit": "dB", "step": 0.5, "group": "Mix" } },
    "pitch": { "$ref": "#/$defs/numberOrRange", "default": 1, "x-ui": { "widget": "range", "min": 0.25, "max": 4, "group": "Mix" } },
    "loop": { "type": "boolean", "default": false },
    "limit": {
      "type": "object",
      "properties": {
        "minGap": { "type": "number", "default": 0, "x-ui": { "unit": "s" } },
        "voices": { "type": "integer", "default": 8, "minimum": 1, "maximum": 32 },
        "over": { "enum": ["steal-oldest", "skip"], "default": "steal-oldest" }
      }
    },
    "spatial": {
      "type": "object",
      "properties": {
        "ref": { "type": "number", "default": 5, "x-ui": { "unit": "m", "help": "Full level inside this distance." } },
        "max": { "type": "number", "default": 80, "x-ui": { "unit": "m" } },
        "airLowpass": { "type": "boolean", "default": true }
      }
    },
    "source": { "oneOf": [ { "$ref": "#/$defs/synth" }, { "$ref": "#/$defs/sample" }, { "$ref": "#/$defs/pick" }, { "$ref": "#/$defs/code" } ] }
  },
  "$defs": {
    "numberOrRange": { "oneOf": [ { "type": "number" }, { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 } ] }
  }
}
```

### Added while building the engine (M1)

What AOTT's sounds needed and the first draft above could not say:

| Field | Meaning |
|---|---|
| layer `at` | Start the layer this many seconds after the sound starts. |
| layer `repeat: { count, every, falloff }` | Play the layer again `count` times, `every` seconds apart, each quieter by `falloff` (ratchets, debris). |
| layer `from: { modes, decay, tilt }` | A bank of decaying sine partials, up to 16 frequencies (each a number or range) with one `decay` and a `tilt` toward the low ones: struck metal, bells, blades. |
| noise `color` | `white`, `pink` or `brown`. |
| oscillator `detune` | In cents. |
| filter `glideTo`, `glideTime` | Sweep the cutoff to this multiple of its start over `glideTime` seconds. |
| filter `gain` | For `peaking` filters, in dB. |
| envelope `hold` | Seconds held at full level between attack and decay. |
| `pick.mode` | How a variation is chosen: `random`, `shuffle` or `sequence`. |
| `bus` | A bus name inside the mixer file, so it is not an `x-ref`. |

For a game that drives sound from state (AOTT): `play(id, { params, spatial })` hands numbers to a `code` generator (`call.params`) and
overrides the recipe's distance range for one play; `registerLiveGenerator` makes a sound that is built once and fed by `handle.set({...})`
and a per-frame `tick` (a winch, a score); `view.duck(bus, db, hold, release)` and `view.setBusLowpass(bus, hz)` are the mixer moves
a game makes at runtime (ARCHITECTURE, audio).

`sample` sources are accepted by the schema and reported as not supported yet. `code` sources call a generator the
game registers with `registerGenerator`. The mixer has buses and a master compressor and limiter.

## 5. `mixer`

```json
{
  "kind": "mixer",
  "buses": {
    "master": { "level": 0 },
    "sfx": { "to": "master", "level": 0 },
    "ui": { "to": "master", "level": -4 },
    "voice": { "to": "master", "level": 0 },
    "music": { "to": "master", "level": -10 }
  },
  "master": { "compressor": { "threshold": -14, "ratio": 3 }, "limiter": -1 }
}
```

A bus has a `level` in dB (-60 to 12) and `to`, the bus it feeds. `master.compressor` is `threshold` (dB) and `ratio`;
`master.limiter` is a ceiling in dB. A bus may also have its own `compressor` (`threshold`, `ratio`, and optional `attack`, `release` in
seconds), placed after the bus's gain and low-pass: it tames that bus alone, so the loud sounds on it (a clash, a deflect) can be
turned up without the whole mix clipping. Without a mixer file, `defaultMixer` applies.

Not built: ducking rules and snapshots in the file (a game calls `duck` and `setBusLowpass` at run time) and the `music` kind
(layers that come in on an intensity value).

## 6. `character`, `anim-set`, `anim-graph`

A character is a body, what it is made of, where things attach, and which animations it uses.

```json
{
  "kind": "character",
  "note": "Player and squad. Cloak, twin blades.",
  "body": {
    "type": "generated",
    "recipe": "humanoid",
    "proportions": { "height": 1.78, "shoulders": 0.44, "legs": 0.52, "head": 0.23 }
  },
  "materials": { "skin": "material/skin/fair", "cloth": "material/cloth/green", "metal": "material/steel" },
  "sockets": { "handR": { "joint": "handR", "offset": [0, -0.05, 0.02] }, "back": { "joint": "spine", "offset": [0, 0.2, -0.15] } },
  "collider": { "shape": "capsule", "radius": 0.35, "height": 1.7 },
  "animSet": "anim-set/soldier",
  "animGraph": "anim-graph/soldier"
}
```

`animSet` and `animGraph` are ids of `anim-set` and `anim-graph` files (`config/anim-set/soldier.json`,
`config/anim-graph/soldier.json`). `body.type` is `generated` or `gltf` (`file`, and a `joints` map from the engine's joint
names to the model's); glTF bodies are in the schema but the Animator reports them as not supported yet. A generated body
has a `recipe` (`humanoid`, with `proportions`: `height`, `shoulders`, `legs`, `head`, `arms`, `build`; or `custom`, with a `bones`
list of `{ name, parent, offset }` and a `parts` list of `limb`, `box` and `sphere` shapes on bones) and a `scale`.

`hits` (optional) lists hit and collider shapes that follow bones, in the bone's own space and the body's unscaled
units: `{ "bone": "head", "shape": "sphere", "part": "head", "group": "body", "c": [0, 1.2, 0.1], "r": 0.9 }`. A `capsule`
has `a`, `b`, `r`; a `sphere` has `c`, `r`; a `box` has `c` and `h` (half extents). `part` and `group` are the game's own
words for what it hit; `collide: false` marks a shape used for hit tests only. `characterHits(def)` (`hull/anim`)
checks them against the body and returns each with its bone index.

```json
{
  "kind": "anim-set",
  "clips": {
    "idle": { "type": "generated", "generator": "humanoid/idle", "loop": true, "knobs": { "breath": 0.02, "sway": 0.015 } },
    "run": {
      "type": "generated", "generator": "humanoid/run", "loop": true,
      "knobs": { "stride": 1.35, "armSwing": 0.8, "lean": 0.12, "bounce": 0.05 },
      "events": { "footL": 0.0, "footR": 0.5 }
    },
    "slash": {
      "type": "keyframes", "length": 0.3, "loop": false,
      "tracks": { "armR": { "rotation": [[0, [0, 0, 0]], [0.12, [-1.9, 0.2, 0.4]], [0.3, [0.3, 0, 0]]] } },
      "events": { "hit": 0.14 }
    },
    "wave": { "type": "gltf", "clip": "Wave", "loop": false, "speed": 1 }
  }
}
```

Clip `events` map a name to a time, or a list of times (0 to 1 for loops, seconds otherwise), at which the Animator's `events`
signal fires. A clip also has `speed`, `travel` (ground speed in m/s, for stride matching) and `curve` (`smooth` or `linear`
between keyframes). A `generated` clip's `knobs` are numbers only. Keyframe tracks hold `rotation` (Euler radians) and `offset`.

A key may carry a third item, the **ease** of the curve from it to the next key: `[0.2, [1.2, 0, 0], "in"]`
(`smooth` the default Catmull-Rom, `linear`, `in`, `out`, `inOut`, `snap`, `hold`). `windows` maps a name to `[start, end]` or a list of
them (0 to 1 of the loop for looping clips, seconds otherwise): `"windows": { "trace": [0.18, 0.34], "cancel": [0.4, 0.62] }`; the game reads
`animator.inWindow("trace")` and the `windows` signal. `rootMotion` is `true` or `{ "bone": "hips", "axes": "xz" | "xyz" | "y", "turn": false }`: that bone's
travel leaves the pose and moves the node when the Animator has `applyRootMotion`. A humanoid `body` may list `bones` (extra bones: a ponytail, a sash)
that parts and springs can use. `packages/hull/src/anim/examples/config` has a swordswoman with draw, light 1-3, heavy, deflect, dodge and hit
reaction clips (`character/swordswoman`, `anim-set/sword`, `anim-graph/sword`).

```json
{
  "kind": "anim-graph",
  "params": {
    "speed": { "type": "number", "default": 0, "min": 0, "max": 12 },
    "grounded": { "type": "boolean", "default": true },
    "attack": { "type": "trigger" }
  },
  "layers": {
    "base": {
      "start": "idle",
      "states": {
        "idle": { "clip": "idle" },
        "move": { "blend": { "by": "speed", "points": { "0.5": "walk", "6": "run" } }, "speedFrom": "speed" },
        "air": { "clip": "fall" }
      },
      "transitions": [
        { "from": "idle", "to": "move", "when": "speed > 0.3", "blend": 0.15 },
        { "from": "move", "to": "idle", "when": "speed < 0.2", "blend": 0.2 },
        { "from": "*", "to": "air", "when": "!grounded", "blend": 0.1 },
        { "from": "air", "to": "idle", "when": "grounded", "blend": 0.12 }
      ]
    },
    "upper": {
      "mask": ["spine", "armL", "armR", "head"],
      "start": "none",
      "states": { "none": {}, "slash": { "clip": "slash", "exit": "none" } },
      "transitions": [ { "from": "*", "to": "slash", "when": "attack", "blend": 0.04 } ]
    }
  },
  "ik": { "feet": { "enabled": true, "maxStep": 0.35 } }
}
```

`when` is a small expression over the parameters: comparisons, `!`, `&&`, `||`. Nothing else. A transition may also have `after`
(seconds in the state). A state has `clip` or `blend`, `speed`, `speedFrom` (a parameter that scales it) and `exit` (the state to go
to when a non-looping clip ends, with `exitBlend`). A layer has `mask`, `additive` and `weight`. `ik` has `feet` and `look`
(`enabled`, `weights`, `yawDeg`, `pitchDeg`, `speed`).

## 6b. `move-set` and `enemy` (combat kit)

A `move-set` is what a fighter can do with its weapon; an `enemy` is stats plus patterns that use a move-set. Schemas:
`schemas/move-set.schema.json`, `schemas/enemy.schema.json`. Defaults and examples:
`packages/hull/src/kits/combat/config/move-set/duelist.json` and `.../enemy/duelist.json`. Behaviour: the kit's README.

`move-set`: `weapon` is `{ socket, base, tip, radius }`, a line in a character socket's space that the trace sweeps. `stances`
lists the stances (the first starts). `moves` maps a name to:

| Field | Meaning |
|---|---|
| `length` | Seconds the move lasts. Required. |
| `damage`, `posture` | Hit points and posture a clean hit takes; a block takes the posture only. |
| `input`, `start`, `stance` | The button it answers, whether it can start from rest (default true), the stance it needs. |
| `clip`, `trigger` | The animation clip, and the animator trigger that starts it (default the clip, default the move name). |
| `reach` | Metres the blade can land, for the enemy brain and a finisher's range. |
| `windows` | Named `[from, to]` ranges in seconds (or a list of them): `trace` (blade live), `telegraph` (the tell), `cancel`, `iframe`. |
| `windowsFrom` | `move-set` (default) or `clip` (`animator.inWindow`). |
| `cancelsInto` | Moves reachable in the cancel window; `input` picks which. |
| `unblockable` | Red flash: only a dodge avoids it. |
| `guardBreak` | Posture multiplier against a guard (a charged heavy). |
| `finisher` | Only starts, and only hurts, a broken fighter; takes `finisherDamage` of its full health. |
| `stagger`, `knockback`, `hitStop` | Feel of a clean hit; defaults come from the `combat` tunables. |
| `lunge` | `{ distance, from, to }`: steps forward over that part of the move. |
| `sound` | A `sound` id played when the move starts. |

`enemy`: `moveSet`, `character`, `health`, `posture` (`max`, `recover`, `fightRecover` (slower, while an enemy is near), `delay`, `broken`), `weakTo` (the stance that costs it
extra posture), `resists` (the stance that costs it less), `finisherDamage`, `speed` (`walk`, `circle`, `turn`), `spacing` (`min`, `max`), `think`, `phases` (health fractions where a
new phase starts) and `patterns`: each `{ name, weight, steps, recover, token, when }`. A step is `{ move, telegraph, gap, feint,
unblockable }`. `when` limits a pattern by `distance`, `health` (0 to 1), `phase` and `streak` (patterns started in a row since a pattern with `rest: true`). `checkMoveSet` and `checkEnemy`
(`hull/kits`) check cancels, windows and pattern moves against the move-set, naming the pointer.

Added for Ironleaf (M10): a step may leave out `move` and carry `travel: { by | to, speed }` (the enemy runs that far toward or away from the
target after the tell: a dash in, a back-step, a retreat; the animator's `speed` is set while it runs). `when` also takes `stance` (the target's
stances that allow the pattern) and `clear` (metres: no friend of the enemy that close to the target). A pattern's `answers` is a weight
multiplier by the target's stance. `spacing.wait` is the band to circle at while other enemies hold the attack places; `speed.run` is the
approach speed when far. A move's `shoot: { at, speed, socket, range, radius }` fires a projectile at `at` seconds instead of a blade
trace; a deflect or perfect deflect sends it back at the shooter. `EnemyBrain.dormant` keeps an enemy still until `wake()`.

More on the graph (M10): a state may be `"blend2d": { "x": "moveX", "y": "moveY", "points": [{ "x": 0, "y": 1, "clip": "walk" }, ...] }`
(clips weighted by inverse distance); a transition may have `"sync": true` (the new state starts at the same cycle phase); a layer may have
`"weightFrom": "param"`. `ik.grips` maps a hand bone to a character socket it grips (`{ "handL": { "socket": "hiltL", "weightFrom": "twoHand" } }`).
`springs` is `{ "ponytail": { "chain": ["pony1", "pony2", "pony3"], "stiffness": 90, "damping": 6, "drive": 0.06, "falloff": 0.8, "limitDeg": 70 } }`:
the chain swings from the root bone's acceleration. `hitReact` (`bones`, `angle`, `shift`, `stiffness`, `damping`) shapes `animator.hitReact(dir, strength)`.

## 7. `ui-theme` and `ui-screen`

```json
{
  "kind": "ui-theme",
  "color": { "panel": "#0e1012", "text": "#e6e1d6", "muted": "#9a968c", "accent": "#f0a43a", "danger": "#c4372b", "good": "#6bbf59", "line": "#2a2d31" },
  "type": { "family": "system-ui", "size": 14, "labelTracking": 0.2 },
  "space": { "gutter": 20, "radius": 2 }
}
```

```json
{
  "kind": "ui-screen",
  "pausesGame": true,
  "root": {
    "panel": { "align": "center", "width": 420 },
    "children": [
      { "title": { "text": "@pause.title" } },
      { "button": { "text": "@pause.resume", "primary": true }, "on": { "press": "game.resume" } },
      { "button": { "text": "@menu.settings" }, "on": { "press": "ui.open:ui-screen/settings" } },
      { "button": { "text": "@pause.quit" }, "on": { "press": "game.toTitle" } }
    ]
  },
  "states": { "default": {}, "with-save": { "mock": { "save.exists": true } } }
}
```

* A node is one widget (`panel`, `stack`, `row`, `title`, `text`, `bar`, `button` or `image`) with its options, plus `on` and
  `children` (only `panel`, `stack` and `row` take children). Options: `text`, `bind`, `max`, `format`, `primary`, `align`, `width`,
  `gap`, `src`, `alt`, `label`, `menu`, `visible`.
* Text beginning with `@` is a key the game resolves with `ui.setStrings(fn)`; without it the key itself is shown.
* `bind` reads a value from the game's view-model: `{ "bar": { "bind": "player.hp", "max": "player.maxHp" } }`.
* `on` names an action the game or the UI kit registered.
* `states` are the versions the Studio's bench shows (with mock data), so every state can be reviewed.

## 8. `input-map`

An action is a `button`, an `axis` or an `axis2`. `keys` is a list (button, axis) or an object of `up`/`down`/`left`/`right` lists (axis2).
`mouse` is `delta`, `deltaX`, `deltaY` or `wheel`; `pad` names a button or stick (a list for several). Also `deadzone`
(default 0.15), `sensitivity`, `invertY` and `rebind` (default true). `groups` only orders the key-binding screen.

```json
{
  "kind": "input-map",
  "actions": {
    "move": { "type": "axis2", "keys": { "up": ["W", "ArrowUp"], "down": ["S", "ArrowDown"], "left": ["A"], "right": ["D"] }, "pad": "stickL" },
    "look": { "type": "axis2", "mouse": "delta", "pad": "stickR" },
    "jump": { "type": "button", "keys": ["Space"], "pad": "south" },
    "fire": { "type": "button", "keys": ["Mouse0", "K"], "pad": "triggerR" },
    "pause": { "type": "button", "keys": ["Escape", "P"], "pad": "start", "rebind": false }
  },
  "groups": { "Move": ["move", "jump"], "Fight": ["fire"], "Other": ["pause"] }
}
```

## 9. `look`

```json
{
  "kind": "look",
  "sun": { "color": "#ffeddb", "strength": 3.2, "elevationDeg": 48, "azimuthDeg": 210, "shadows": true, "shadowRange": 75, "shadowLead": 0.45, "shadowSoftness": 3, "shadowNormalBias": 0.06 },
  "sky": { "horizon": "#a9c6dc", "mid": "#8fb2d6", "zenith": "#3d6aa8" },
  "fog": { "color": "#a9c6dc", "near": 140, "far": 1500 },
  "ambient": { "color": "#ffffff", "intensity": 0.6, "ground": "#3a3631" },
  "environment": { "intensity": 0.4 },
  "exposure": 1.0,
  "toneMapping": "aces",
  "post": { "bloom": 0.6, "contrast": 1.07, "saturation": 1.1, "vignette": 0.22, "grain": 0.02, "speedBlur": 1 }
}
```

Other fields: `sky.color` is a flat sky instead of the gradient; `fog` is linear (`near`, `far`) or by `density`, with `skyBlend`;
`ambient.ground` makes the ambient light a hemisphere; `environment.intensity` bakes the sky into reflections;
`toneMapping` is `none`, `linear`, `reinhard`, `cineon`, `aces`, `agx` or `neutral`; `post` also has `bloomThreshold`, `lift`, `gamma`,
`gain` (a colour triple each) and `aa` (`none` or `fxaa`).

`speedBlur` is the most the speed cue draws: a radial blur, a closing vignette and faint streaks near the border. The
game reports how fast the player moves with `render.setSpeed(0..1)` and the cue eases in and out by itself. A hit pulse
(colour drains, a chromatic punch, a vignette on the cut) is started with `render.impact(worldPosition, strength)` and
lasts about 0.22 s of real time, so a hit-stop does not freeze it; it draws even when the look has no `post`. Both need
the post chain, so the `low` quality tier shows neither. `sun.shadowLead` pushes the shadowed area ahead along the camera's
view (a fraction of `shadowRange`), `shadowSoftness` blurs the edge and `shadowNormalBias` fights acne.

## 10. `vfx`

```json
{
  "kind": "vfx",
  "emit": { "count": [8, 14], "over": 0.05, "shape": { "disc": 0.4 } },
  "particle": {
    "life": [0.5, 1.1],
    "speed": [0.8, 2.4],
    "direction": { "cone": [0, 1, 0], "angleDeg": 55 },
    "gravity": -0.6, "drag": 2.2,
    "size": [[0, 0.2], [1, 1.1]],
    "color": [[0, "#cfc6b6"], [1, "#8f887c"]],
    "alpha": [[0, 0.7], [1, 0]],
    "sprite": "smoke"
  },
  "budget": { "max": 400, "fadeNear": 1.5 }
}
```

Fields beyond the sample: `emit.rate` (particles a second, for a trail); `emit.shape` is `point`, `{ sphere }`, `{ disc }` or `{ box }`;
`particle.direction` is a `cone` or `{ "outward": true }`; `sizeScale` (a range applied to the size curve), `glow`, and `blend`
(`alpha` or `additive`); `particle.sprite` is `soft`, `smoke`, `hard`, `spark`, `chip` (a hard-edged flake that turns with the particle) or `leaf` (a pointed oval). `particle.ground` (`none`, `die`, `bounce`, `rest`) says what a particle does at the ground height the game gives `vfx.setGround(fn)`: die on touch, bounce and roll, or slide along it. `particle.flutter` (m/s) is a sideways wobble per particle, for a falling leaf. `ground` and `flutter` run on the CPU pool only (effects with a budget of 2048 or more on WebGPU ignore them).

The dev page and the build mount vfx for you when `hull.json` lists `"vfx"` or the project has any `vfx` config; a game that calls `mountVfx(game)` itself gets the same view back, not a second system.

A call can change one burst without a second config: `vfx.burst(id, at, dir, { count, size, speed, life, spread })` sets the exact count and multiplies size, start speed, life and the emit shape's reach. The count draw still happens, so the random stream stays in step.

## 11. `material`

```json
{ "kind": "material", "color": "#9aa0a8", "roughness": 0.35, "metalness": 1, "texture": { "recipe": "brushed", "scale": 2 } }
```

## 11b. `prefab` and `level`

A prefab is a small thing made of shapes; a level places blocks, prefab things and named points on a ground. Both are built by the
`Level` behaviour of the level kit (`node.add(Level, { level: 'yard' })` reads `config/level/yard.json`). A prefab names no
behaviours: game code attaches them to what the level built (`level.things('prefab/crate')`, `level.marker('start')`).
Units are metres, and degrees where a field ends in `Deg`. Everything solid is static and on physics layer `world`.

```json
{
  "kind": "prefab",
  "parts": [{ "name": "box", "shape": "box", "at": [0, 0.6, 0], "size": [1.2, 1.2, 1.2], "material": "material/crate" }],
  "collider": { "shape": "box", "at": [0, 0.6, 0], "size": [1.2, 1.2, 1.2] },
  "tags": ["crate"]
}
```

`parts`: `shape` is `box`, `sphere`, `cylinder` or `capsule`; `at` is the part's centre from the prefab origin (on the floor under it), `size` its full
extent, `rotDeg` an optional turn about x, y, z; `material` is a `material` id. `collider` is optional (`box`, `sphere` or `capsule`; a sphere
takes its diameter from `size[0]`, a capsule its diameter from `size[0]` and its height from `size[1]`). `tags` are groups the thing joins.

```json
{
  "kind": "level",
  "look": "look/day",
  "ground": { "size": [40, 40], "material": "material/floor" },
  "walls": { "height": 2.5, "material": "material/wall" },
  "blocks": [
    { "name": "ramp", "at": [-6, 0.62, 8], "size": [6, 0.4, 4], "rotDeg": [0, 0, 12], "material": "material/crate" },
    { "name": "pillar", "shape": "cylinder", "at": [8, 1.5, -6], "size": [2, 3, 2], "material": "material/wall" }
  ],
  "things": [{ "prefab": "prefab/crate", "at": [5, 0, 4], "yawDeg": 30 }],
  "markers": { "start": { "at": [0, 0, 14] }, "spawn/north": { "at": [-12, 0, -14], "yawDeg": 0 } },
  "scatter": [{ "prefab": "prefab/rock", "count": 6, "area": { "at": [0, 0], "size": [34, 34] }, "stream": "level-rocks", "gap": 1.5 }]
}
```

* `ground`: `size` is width and depth, centred on the origin; `walls` (optional) puts four solid walls just outside it.
* `blocks`: `at` is the block's centre, `size` its full width, height and depth before the turn, `rotDeg` the turn. A ramp is a box turned about x or z.
  `shape` is `box` (default) or `cylinder` (a 12-sided prism for the collider; `size` holds the two diameters and the height). `solid: false` draws it only.
* `things`: a prefab at a point, with `yawDeg` and a uniform `scale`. `markers`: named points with `yawDeg`; a name with a slash (`spawn/north`) is found by `markers('spawn/')`.
* `scatter`: `count` copies of a prefab in a rectangle, drawn from the world random stream `stream` (so a seed gives one layout), at least `gap` metres from everything
  solid and `avoidMarkers` metres (default 3) from every marker, with a random yaw unless `randomYaw` is false. Give each rule its own stream.
* `look` is read back as `level.look`; the game (or manifest) applies it.

The references check covers every `prefab`, `material` and `look` id at `file#/pointer` (`level/yard#/things/1/prefab`). The checkers `checkLevel` and `checkPrefab`
(`hull/kits`) add what a schema cannot say: a block or prefab with no volume, a thing, marker or scatter area off the ground, two scatter rules on one stream.

The kits ask a level only for `LevelLike` (`kits/common.ts`): `half`, `bounds`, `hits(x, z, hx, hz)`, `freeSpot(out, margin, stream, awayX, awayZ, awayFrom)`,
`marker(name)`, `markers(prefix)` and `things(prefab)`. `ArenaLevel` (a code-built arena) and `Level` (a config file) both satisfy it, so the pickups and spawner kits work on either.

## 12. `strings` (not built)

No `strings` kind exists. A game gives `ui.setStrings(fn)` a lookup of its own; this is the planned file.

```json
{ "kind": "strings", "lang": "en", "text": { "pause.title": "Paused", "pause.resume": "Resume", "pause.quit": "Quit to title", "menu.settings": "Settings" } }
```

## 13. Review notes (`.hull/review.json`, written by the Studio)

Not config: the record of what you have checked. It lives with Hull's own data, not in the project's folders.

```json
{
  "items": {
    "sound/sword/hit": { "state": "approved", "at": "2026-11-20T10:12:00Z", "by": "you", "hash": "9c1f0a" },
    "anim-set/soldier#run": { "state": "needs-change", "note": "Arms swing too wide; feet slide on the turn.", "at": "2026-11-20T10:15:00Z", "hash": "44b7e2" },
    "ui-screen/pause": { "state": "unreviewed", "hash": "a03d51" }
  }
}
```

* A key is a config id, a tunables block name, or `explain:<id>` (an explain document, section 14), optionally with `#part` (one clip of a set, one state of a
  screen).
* `hash` is the content hash at review time. When the piece changes, the state falls back to `unreviewed` and the
  old note is kept beside it until you clear it.
* `by` is who wrote the entry (`you`, `ai:<agent>`). A key must name a piece that exists; the write is refused otherwise.
* The `review.list`, `review.set` and `review.note` tools (and project methods of the same names) read and write the notes; `review.list` with `open: true` gives the open ones to the AI.
* `hash` is six hex digits of a SHA-1 of the file text (config), of the block's keys and values (tunables), or of the explain document without its `by` and `at`, so saving the same drawing again keeps its approval. A `#part` key hashes the whole piece.

## 14. The idea-to-play files (`GAME.md`, `.hull/explain/`, `.hull/create.json`)

Written by the builder through tools (`brief.write`, `explain.write`, `create.set`), never by hand. Types are in
`packages/hull/src/dev/protocol.ts`, section "M11"; the plan is `docs/IDEA-TO-PLAY.md`.

### The brief: `GAME.md` (project root)

```markdown
# Ashblade

## Premise
A monk and a talking blade settle a debt in a burning shrine.

## What you do
Duel one rival at a time ...
```

* `# Title` first, then these `## ` sections in this order: Premise, What you do, Controls, Cast, World, Rules,
  Look and sound, First playable, Not in the first version. A section's id is its title in kebab case
  (`what-you-do`). A section the file does not have yet is added in that order; a section Hull does not know (the
  owner's own) is kept where it is.
* `brief.read` returns the file split into sections. `brief.write` takes the whole `text` or one `section`
  (`{ id, text }`, without the heading). The write is atomic, recorded in the history under its author (GAME.md is a
  tracked file, with `src/`, `config/`, `assets/` and `hull.json`), and pushed to the app as `brief.changed`. An edit made on
  disk is recorded as `disk` and pushed the same way.

### An explain document: `.hull/explain/<id>.json` (schema `explain.schema.json`)

The drawing for a piece the person cannot judge by looking or listening: rules, enemy behaviour, the layout of the
world, balance. Not a config kind (it is not under `config/` and is not in the registry), but validated the same way
before it is kept.

```json
{
  "id": "enemy-guard-behaviour",
  "title": "How a guard fights",
  "stage": "rules",
  "why": "The guard waits, closes in when it sees you, and backs off to heal when hurt.",
  "body": {
    "type": "flow",
    "nodes": [{ "id": "idle", "text": "Stands watch" }, { "id": "see", "text": "Sees the player?", "kind": "ask" }],
    "edges": [{ "from": "idle", "to": "see" }]
  },
  "covers": ["enemy/guard"]
}
```

* `id`: lower-case letters, digits and dashes. `stage`: `world`, `actors`, `animations`, `rules`, `sounds`,
  `effects` or `screens`. `why`: one or two plain sentences. `covers`: config ids and `src/` files it explains.
  `by` and `at` are filled in by the server on write.
* `body.type` is one of `flow` (nodes with an id, text and an optional `kind` of `step`, `ask` or `end`; edges
  `from` and `to` node ids with an optional `label`), `map` (a PNG, JPEG or WebP data URL with its `width` and
  `height`, and `marks` of `x`, `y` in 0 to 1 and a `label`), `table` (`columns` and `rows` of text or numbers) or
  `image` (a data URL with `width` and `height`).
* A write is refused, with the pointer, when the schema is not met, when two nodes share an id, or when an edge names a node the flow
  does not have (`.hull/explain/enemy-guard-behaviour.json#/body/edges/2/to`).
* Examples, one per body type, are in `packages/hull/src/schema/examples/explain/`; each is checked by
  `packages/hull/test/explain.test.ts`.
* Reviewed under the review key `explain:<id>` (section 13).

### Flow state: `.hull/create.json`

```json
{ "idea": "a duel in a burning shrine", "step": "build", "briefApproved": true,
  "stages": [{ "id": "world", "status": "ready", "summary": "A shrine yard.", "checkpoint": "world-ready", "pieces": ["look/dusk", "explain:world-layout"] }] }
```

* `step` is `idea`, `brief`, `build` or `play`. The seven stages always exist, in order; `status` is `waiting`,
  `building`, `ready` or `failed`; `pieces` are review keys.
* A project without the file is at step `play` with seven `waiting` stages. `create.set` merges a `patch` (idea, step,
  briefApproved) and one `stage`, and pushes `create.changed`.

### Docs and the "Just now" feed

`docs.list` / `docs.read` serve every kit README (`kit/<name>`, `kit/index`), `guide/schemas`, `guide/workflow` and a
generated `api/<module>` per public entry of the hull package (`api/core` is `hull`: core and config). They are found from
the hull package's own folder, so a project made anywhere gets them. `game.recent` and `game.moment` are described in
ARCHITECTURE section 8.
