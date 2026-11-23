# Workflow

Who does what, in what order, with which command. This is the loop Hull is designed around.

## 1. The two roles

| | The AI | You |
|---|---|---|
| Writes | `src/` (logic, tunables, tests), `config/` (what things are) | Nothing by hand |
| Changes values | In the files | In Hull Studio, which writes the same files |
| Checks | Types, schemas, simulation tests, screenshots, sound measurements, budgets | Each piece on its bench; the game by playing it |
| Says what is wrong | In its report: what it checked and what it could not | In the Studio: `needs-change` plus a note |
| Must not | Undo a value you set without saying why | Open a source file (you never need to) |

"The AI" is whichever agent you use: a local Claude Code or Codex running against the app's MCP server, any MCP client,
or Marl AI from the Studio's chat panel. All three use the same tools and land in the same
history.

## 2. Making something new

1. You ask for it ("add a grapple hook with a reel sound").
2. The AI reads `docs.read guide/engine` (every new project's `AGENTS.md` is its short form), writes the logic and the config, then runs, cheapest first:

   | Step | Tool | Catches |
   |---|---|---|
   | 1 | `check` | Type errors, config that does not match its schema, ids that do not exist, banned calls, values of yours it overwrote |
   | 2 | `test` | Wrong behaviour in the simulation: it runs in Node, thousands of frames per second |
   | 3 | `play` (file `tests/grapple.steps.json`) | What is actually on screen, HUD and menus included (the UI layer is painted over the canvas; `game.run {op:"screenshot", ui:false}` gives the canvas alone): screenshots the AI reads, golden images that must match |
   | 4 | Sound measurement (`measureSound`, `checkSound` in `hull/audio`; no tool yet) | Levels and lengths: nothing clips, the new sound sits where it should among the others |
   | 5 | Frame time and draw calls (`render` stats; no tool or budget check yet) | Cost against the budgets in the manifest |

3. The AI reports what it made, what each check showed, and what it could not judge (how a sound *feels*, whether
   an animation *reads*). Those pieces show to you as `unreviewed`.

Each AI turn that passes `check` becomes one change in the history, so every step can be undone.

## 3. Verifying and tuning

The Hull app opens a project in Hull Studio.

1. **Library** shows everything by kind. A filter shows only what is `unreviewed` or changed since you last looked.
2. Pick a piece: its **bench** shows it alone.

   | Kind | The bench shows | You can |
   |---|---|---|
   | Sound | Waveform, spectrum, peak, loudness, length | Play, loop, hear variations, compare with the last version, hear it at distance |
   | Character | The body on a turntable, skeleton, sockets, collider | Change proportions and materials |
   | Animation | One clip, or the whole state graph | Scrub, slow down, set speed and other parameters, see timeline events and foot slide |
   | UI screen | Each declared state at phone, laptop and desktop size | Step focus by keyboard, switch language |
   | Tuning | The game, or a kit's demo scene | Drag any value while it runs |
   | VFX, look, level | The effect on a loop, a fixed test scene, a fly-through | Change counts, colours, sun, fog, post; toggle colliders and spawn points |

3. **Inspector**: every field of the piece as a form. Change one and the bench updates at once. The change is
   written into the JSON file, or into the literal in the TypeScript file, and recorded in the history as yours.
4. **Review**: set `approved`, or `needs-change` with a note in your own words.
5. **Play**: the whole game with pause, single-step and slow motion, the inspector still attached.

## 4. Experiments

When you are not sure which way is better, do not choose yet.

1. **New experiment** (or the `exp.start` tool) branches from where you are. It has its own copy of the
   project, so the main line is untouched.
2. Tune it, or ask the AI to work in it ("in heavier-jump, make the landing heavier too").
3. Start another from the same point, or from the first.
4. **Compare** puts two of them side by side, both running, with what differs listed in plain words:

   ```
   heavier-jump  vs  main
     player.jumpHeight     2.2 → 2.6
     player.coyote         0.12 → 0.15
     sound/land/thud       level −8 → −5, length 0.3 → 0.45
   ```
5. **Adopt** makes the one you like the main line. The others stay in the timeline; you can return to any of them,
   or **merge** the good half of one into another.

## 5. Closing the loop

The AI starts its next turn with `review.list` and `history.list`:

```
needs-change  anim/soldier#run      "Arms swing too wide; feet slide on the turn."
needs-change  sound/reel/whine      "Too shrill above half speed."
you           player.jumpHeight     2.2 → 2.6
you           sound/land/thud       level −8 → −5
```

* For a note: it changes the config or the code, re-runs the checks, and the piece returns to `unreviewed`.
* For a value you set: nothing to do. It is already in the file. If the AI thinks it hides a bug (a value pinned
  at the edge of its range), it says so; it does not change it back.

## 6. Building and shipping

The Build button (the `build` tool) and the `package` tool:

```
build                         dist/web/game.js + index.html + build.json (assets are inlined: one .js)
package {targets: ["mac"]}    an Electron app for the system it runs on; the others are reported as skipped
```

* **Website**: upload `dist/web/` to any static host.
* **Desktop**: the app lands in `dist/desktop/` (`<Title>.app` on macOS). It is unsigned, for testing on your machine; installers
  and signing are not built.
* The build prints the size of `game.js` and fails if dev code reached it. A size budget from the manifest is not enforced yet.

## 7. What "done" means

For the AI, a change is done when all of these hold, and it says so item by item:

1. `check`, `test` and `build` pass.
2. It ran the thing and looked: a screenshot it read, a state it queried, a measurement it took.
3. Every new or changed piece opens on its bench without errors.
4. No value you set was changed without a stated reason.
5. It states what only a person can judge, so you know what to open in the Studio.

For you, a piece is done when it is `approved`.
