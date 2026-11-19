# Config schemas

Every config file in a Hull game, what it may contain, and an example. These are drafts for review: field names
and ranges will move during the first milestones, but the shape (a kind, an id from the path, references by id, UI
hints, direct edits recorded in the history) is the design.

The schemas are written once in TypeScript (TypeBox) under `packages/hull/src/schema/` and emitted as JSON Schema
(draft 2020-12) files into `schemas/`. The JSON below is what gets emitted.

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

Files carry no `$schema` line. Hull knows the schema from the kind, and writes the editor mapping so
autocomplete works.

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

`hull check` fails on an id that does not exist, and the generated id list makes the same mistake a compile error
in code.

### UI hints (`x-ui`)

Standard JSON Schema says what is valid. `x-ui` says how to edit it in the Studio.

| Hint | Meaning |
|---|---|
| `widget` | `slider`, `dial`, `number`, `toggle`, `select`, `segments`, `color`, `curve`, `vec3`, `range`, `ref`, `text`, `keys` |
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

A schema has a `version`. When a kind changes shape, Hull ships a migration, and `hull migrate` rewrites the
files (as one recorded change).

## 2. The game manifest (`hull.json`)

```json
{
  "kind": "game",
  "id": "mygame",
  "title": "My Game",
  "version": "0.1.0",
  "entry": "src/main.ts",
  "step": 60,
  "features": ["audio", "anim", "ui", "vfx"],
  "render": { "backend": "auto" },
  "start": { "screen": "ui/title", "level": "level/yard" },
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

A block of numbers kept as a file, for values that are shared (several pieces of code, a level, a tool) or that vary by file (one per enemy type, one per difficulty). The game declares the block's shape once in code with `tuningKind('jump', { height: num(2.2, ...) })`; each file holds values. Numbers used by one piece of code alone go in a `tunables` block instead.

```json
{
  "kind": "tuning",
  "height": 2.4,
  "coyote": 0.1
}
```

Emitted schema for that block:

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
| source `modes` | A bank of decaying sine partials (`freq`, `gain`, `decay` each): struck metal, bells, blades. |
| noise `color` | `white`, `pink` or `brown`. |
| oscillator `detune` | In cents. |
| filter `glideTo`, `glideTime` | Sweep the cutoff to this multiple of its start over `glideTime` seconds. |
| filter `gain` | For `peaking` filters, in dB. |
| envelope `hold` | Seconds held at full level between attack and decay. |
| `pick.mode` | How a variation is chosen: `random` or `cycle`. |
| `bus` | A bus name inside the mixer file, so it is not an `x-ref`. |

For a game that drives sound from state (AOTT): `play(id, { params, spatial })` hands numbers to a `code` generator (`call.params`) and
overrides the recipe's distance range for one play; `registerLiveGenerator` makes a sound that is built once and fed by `handle.set({...})`
and a per-frame `tick` (a winch, a score); `view.duck(bus, db, hold, release)` and `view.setBusLowpass(bus, hz)` are the mixer moves
a game makes at runtime.

`sample` sources are accepted by the schema and reported as not supported yet. `code` sources call a generator the
game registers with `registerGenerator`. The mixer has buses and a master compressor and limiter; ducking and
snapshots come later.

## 5. `mixer` and `music`

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
  "ducks": { "voice-over-music": { "when": "voice", "lower": "music", "by": 8, "attack": 0.15, "release": 0.8 } },
  "snapshots": {
    "paused": { "sfx": -18, "music": -6, "lowpass": 900 },
    "low-health": { "sfx": -3, "lowpass": 3000 }
  },
  "master": { "compressor": { "threshold": -14, "ratio": 3 }, "limiter": -1 }
}
```

```json
{
  "kind": "music",
  "tempo": 96,
  "key": "D minor",
  "bars": 8,
  "layers": {
    "pad":   { "sound": "music/parts/pad",   "from": 0.0 },
    "pulse": { "sound": "music/parts/pulse", "from": 0.3 },
    "drums": { "sound": "music/parts/drums", "from": 0.55 },
    "brass": { "sound": "music/parts/brass", "from": 0.8 }
  },
  "intensity": { "rise": 0.7, "fall": 2.2 }
}
```

`from` is the intensity (0 to 1) at which a layer comes in. The game sets one number; the music follows.

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
  "animSet": "anim/soldier",
  "animGraph": "anim/soldier.graph"
}
```

`body.type` is `generated` (a recipe registered in code plus proportions) or `gltf` (`file`, and a `joints` map
from the engine's joint names to the model's).

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

Clip `events` are times (0 to 1 for loops, seconds otherwise) at which a named signal fires.

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

`when` is a small expression over the parameters: comparisons, `!`, `&&`, `||`. Nothing else.

## 7. `ui-theme` and `ui-screen`

```json
{
  "kind": "ui-theme",
  "color": { "panel": "#0e1012", "text": "#e6e1d6", "muted": "#9a968c", "accent": "#f0a43a", "danger": "#c4372b" },
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
      { "button": { "text": "@menu.settings" }, "on": { "press": "ui.open:ui/settings" } },
      { "button": { "text": "@pause.quit" }, "on": { "press": "game.toTitle" } }
    ]
  },
  "states": { "default": {}, "with-save": { "mock": { "save.exists": true } } }
}
```

* Text beginning with `@` is a key in the `strings` file.
* `bind` reads a value from the game's view-model: `{ "bar": { "bind": "player.hp", "max": "player.maxHp" } }`.
* `on` names an action the game or the UI kit registered.
* `states` are the versions the Studio's bench shows (with mock data), so every state can be reviewed.

## 8. `input-map`

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
  "sun": { "color": "#ffeddb", "strength": 3.2, "elevationDeg": 48, "azimuthDeg": 210, "shadows": true },
  "sky": { "horizon": "#a9c6dc", "mid": "#8fb2d6", "zenith": "#3d6aa8" },
  "fog": { "color": "#a9c6dc", "near": 140, "far": 1500 },
  "exposure": 1.0,
  "post": { "bloom": 0.6, "contrast": 1.07, "saturation": 1.1, "vignette": 0.22, "grain": 0.02, "speedBlur": 0.085 }
}
```

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

## 11. `material`, `prefab`, `level`

```json
{ "kind": "material", "color": "#9aa0a8", "roughness": 0.35, "metalness": 1, "texture": { "recipe": "brushed", "scale": 2 } }
```

```json
{
  "kind": "prefab",
  "character": "character/grunt",
  "groups": ["enemies"],
  "behaviours": {
    "Health": { "tuning": "tuning/grunt.health" },
    "Chase": { "tuning": "tuning/grunt.chase" }
  },
  "children": { "blade": { "socket": "handR", "prefab": "prefab/blade" } }
}
```

```json
{
  "kind": "level",
  "look": "look/day",
  "music": "music/battle",
  "build": { "generator": "yard", "seed": 7, "knobs": { "size": 80, "walls": 4 } },
  "place": {
    "player": { "prefab": "prefab/player", "at": [0, 0, 0], "yawDeg": 0 },
    "g1": { "prefab": "prefab/grunt", "at": [12, 0, 6] },
    "g2": { "prefab": "prefab/grunt", "at": [-9, 0, 14] }
  }
}
```

A level is mostly made by a generator in code (with a seed and knobs); `place` adds or overrides single things.

## 12. `strings`

```json
{ "kind": "strings", "lang": "en", "text": { "pause.title": "Paused", "pause.resume": "Resume", "pause.quit": "Quit to title", "menu.settings": "Settings" } }
```

## 13. Review notes (`.hull/review.json`, written by the Studio)

Not config: the record of what you have checked. It lives with Hull's own data, not in the project's folders.

```json
{
  "items": {
    "sound/sword/hit": { "state": "approved", "at": "2026-11-20T10:12:00Z", "by": "you", "hash": "9c1f0a" },
    "anim/soldier#run": { "state": "needs-change", "note": "Arms swing too wide; feet slide on the turn.", "at": "2026-11-20T10:15:00Z", "hash": "44b7e2" },
    "ui/pause": { "state": "unreviewed", "hash": "a03d51" }
  }
}
```

* A key is a config id or a tunables block name, optionally with `#part` (one clip of a set, one state of a
  screen).
* `hash` is the content hash at review time. When the piece changes, the state falls back to `unreviewed` and the
  old note is kept beside it until you clear it.
* `by` is who wrote the entry (`you`, `ai:<agent>`). A key must name a piece that exists; the write is refused otherwise.
* `hull review list` prints the open notes; `hull review list --json` gives them to the AI. Also `hull review set <key> <state> [--note]` and `hull review note <key> <text>`; the project server has the same as `review.list`, `review.set`, `review.note`.
* `hash` is six hex digits of a SHA-1 of the file text (config) or of the block's keys and values (tunables). A `#part` key hashes the whole piece.
