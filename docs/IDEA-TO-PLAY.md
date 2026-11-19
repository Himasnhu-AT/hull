# Idea to play: the migration plan (M11)

How the Hull app changes from an editor you tune in to a place where you describe a game, watch it get built,
play it and say what is off. Decided by the owner on 19 Nov 2026. Branch: `engine-4c`.

The design is the interactive mock in `docs/design/idea-to-play.html` (open the file in a browser; also at
https://claude.ai/artifact/MNv9s7HZC4kEa9s2uXruSC). Where this file and the mock disagree on wording or layout,
the mock wins. Where they disagree on a type or a method name, this file and `hull/dev/protocol.ts` win.

## 1. Why

The Studio was built as "a dense desktop tool for people who know Unity and Unreal". The person who uses Hull
does not edit: the AI writes the game and the person plays it. What blocked that person on 19 Nov 2026:

| They want to | What the app did |
|---|---|
| Start from an idea | Asked for a template, a name and a folder |
| Talk to the builder | Hid the agent in a closed floating panel behind an agent picker; the key came from the shell's environment |
| Get a brief | Nothing wrote `GAME.md`; the agent's file tools reach `src/` only |
| Have it built | One prompt was one run of at most 60 model calls, with a prompt written for small edits |
| See what was made | A tree of file kinds and six bench tabs with every field |
| Fix what feels wrong | Find the piece by name, then find the field |

An animation timeline, curve editors and the like are out (D18): a sentence to the builder does that job.

## 2. The flow

| Step | Screen | The person | The builder |
|---|---|---|---|
| 1 Idea | One text box | Types what they want to play | Picks the closest template and creates the project |
| 2 Brief | A chat | Answers two or three questions by clicking, reads the brief as it is written, asks for changes, approves | Streams its text, asks with cards, writes `GAME.md` part by part |
| 3 Build | Stages on the left, pieces on the right | Plays each piece they can judge and approves it or says what to change; reads the drawing of each piece they cannot see | Runs one stage at a time, checks it, saves a point, hands over its pieces |
| 4 Play and fix | The game, a "Just now" strip, the builder column | Plays. Presses "Something is off" (N), says it in their own words. Keeps a change or puts it back | Gets the note with a screenshot, the game time and what just played; changes the piece; the game carries on |
| 5 Share | One button | Builds | Nothing: this is the `build` tool |

**Two kinds of piece in Build** (owner, 19 Nov 2026):

* **Look and listen**: characters, animations, sounds, effects, looks, screens. The person can judge these, so each
  is a card with a live preview and Approve / Change. Approval is the existing review state (`approved`,
  `needs-change` with the note).
* **Explained**: rules, enemy behaviour, the layout of the world, balance. The person cannot see these directly, so
  the builder writes an *explain document*: a flowchart, a map with marks, a table or an image, with a plain
  sentence on what it decided. It has Looks right / Change, reviewed the same way under the key `explain:<id>`.

**Stages**, in order: `world`, `actors`, `animations`, `rules`, `sounds`, `effects`, `screens`. The person may play once
`world`, `actors` and `animations` are ready; nothing has to be approved first.

## 3. What moves where

| Today | After |
|---|---|
| Launcher: template picker first | Idea box first. "Start from a template", Community and Recent stay beside it |
| Game: one of six view tabs | The screen (step 4) |
| Agent panel: floating, closed, agent picker | Builder column, always there, Hull's agent started with the project. Other agents and the Claude Code terminal move behind Advanced |
| Library tree, Content Browser, Sound / Character / VFX / Look benches | **Everything**: cards by kind. The benches draw the card previews |
| Changes and History tabs | **Changes**: one list in plain words with Keep and Put back (`history.revert`) |
| Build button | **Share** |
| Inspector, console, step and speed controls, launch options, experiments, Compare | Unchanged, behind an **Advanced** switch that shows today's editor |

Nothing is deleted. `Editor.tsx` and its panels stay as the Advanced view.

## 4. Contracts

The types are in `packages/hull/src/dev/protocol.ts`, section "M11". Read them there; this is the summary.

### 4.1 Files

| File | What | Written by |
|---|---|---|
| `GAME.md` | The brief. `# Title`, then these `## ` sections in this order: Premise, What you do, Controls, Cast, World, Rules, Look and sound, First playable, Not in the first version. A section id is its title in kebab case | `brief.write` |
| `.hull/explain/<id>.json` | One explain document (`ExplainDoc`), validated against its schema before it is kept | `explain.write` |
| `.hull/create.json` | Where the project is in the flow (`CreateState`): idea, step, stage states and the pieces each stage made | `create.set` |
| `.hull/review.json` | Existing. Gains keys of the form `explain:<id>` | `review.set` |

### 4.2 Methods (project server, and the same names as tools over MCP)

| Method | Does |
|---|---|
| `brief.read` | `GAME.md` split into sections |
| `brief.write` | Writes the whole text or one section; recorded in the history with its author; pushes `brief.changed` |
| `docs.list`, `docs.read` | The kit READMEs (`packages/hull/src/kits/*/README.md`), the kit catalogue, `docs/SCHEMAS.md` and a generated summary of the engine's public API, so an agent learns Hull without leaving its tools |
| `explain.list`, `explain.write` | Explain documents; pushes `explain.changed` |
| `create.get`, `create.set` | The flow state; pushes `create.changed` |
| `game.recent` | What the running game did in the last few seconds (`RecentEvent[]`); also pushed to studios as `game.recent`, at most ten times a second |
| `game.moment` | Pauses the game and returns a screenshot, tick, time and the recent events (`GameMoment`) |

Rules that already hold and still hold: a tool is defined once in `@hull/tools`; a write is validated and recorded with
its author; the Studio never touches the disk; errors name the place.

### 4.3 The "Just now" feed (runtime)

* `packages/hull/src/core/trace.ts`: `trace(kind, id, node?)` and `setTraceSink(fn | null)`. With no sink it returns at once:
  no allocation, nothing in a ship build but the call.
* `audio` calls it when a sound starts, `anim` when a clip starts or a graph changes state, `vfx` when an effect is
  spawned, and a character when it first comes within view of the camera (`actor`).
* `dev/runtime.ts` installs the sink: a fixed ring of 64 events stamped with game time, sent to the server in
  batches. Labels come from the config's `title` or the last part of the id.

### 4.4 The conversation (agent to app)

ACP stays the protocol (D16). Hull's additions ride in `_meta`, shaped after AG-UI (text deltas, tool calls that
render interface, state sent whole and then by part, a run that pauses for the person):

| What | On the wire | In the app |
|---|---|---|
| Streamed text | `agent_message_chunk` per delta (the providers stream) | Text that grows; a caret while it runs |
| A card that does not wait (`brief`, `stages`, `pieces`, `explain`, `change`) | `agent_message_chunk` with empty text and `_meta["hull.ui"] = UiBlock`; sent again with the same `id` to update it | `AgentEvent` `{ type: "ui", sid, block }`, replaced in place by id |
| A card that waits (`ask`, `approve`) | `session/request_permission` with `toolCall._meta["hull.ui"] = UiBlock` and one option per choice | The card with buttons. Typing instead cancels the request and sends the text as the next prompt |
| What kind of run | `session/prompt` with `_meta["hull.mode"]` = `brief`, `build`, `fix` (default `fix`), and for `build` an optional `_meta["hull.stage"]` | The app sets it from the step the person is on |
| A frozen moment | The prompt carries an image block (the screenshot) and a text block listing time, tick and recent events | Chips on the note |

An agent that knows none of this (Codex, Gemini CLI) still works: it gets plain prompts and answers in text.

The agent's own tools for this are `ui_ask` (blocks, returns the answer) and `ui_show` (does not block), next to
`update_plan` in the loop. They are conversation, not project tools, so they are not in `@hull/tools`.

### 4.5 The agent's three modes

| Mode | Prompt | Tools | Ends when |
|---|---|---|---|
| `brief` | Interview: at most three `ui_ask` questions, then write the brief one section at a time, showing the `brief` card after each | `ui_*`, `brief.*`, `docs.*`, `project.info`, `library.list`. No code or config writes | `approve` is answered; yes sets `briefApproved` |
| `build` | A runner, not one run: for each stage, a fresh history seeded with the brief, the docs index and the earlier stages' summaries | Everything | Per stage: `check` passes, `test` passes, one screenshot read, `history.checkpoint`, explain documents written for what cannot be seen, `create.set` with the pieces |
| `fix` | Today's loop, plus: the note comes with a moment; answer with a `change` card naming the piece and the values | Everything | The check gate, as today |

Also: both providers stream; Anthropic requests cache the system prompt and the tool list; the step limit is per
stage (default 80); the key comes from the app's settings (stored with Electron `safeStorage`, passed to the agent
in its environment, never logged), and from the environment in web mode.

## 5. Work packages

Workers run in their own worktrees and are merged into `engine-4c`. Nobody edits `pnpm-lock.yaml` or adds a
dependency; nobody edits another package's files.

| | Package | Owns | Wave |
|---|---|---|---|
| A | Tools and runtime | `packages/hull/src/core/trace.ts`, the `trace` calls in `audio`, `anim`, `vfx`, `dev/runtime.ts`, `dev/protocol.ts` (folds `CreateMethods` into `Methods`), `packages/hull/src/schema` (explain), all of `packages/tools`, `docs/SCHEMAS.md` and `docs/ARCHITECTURE.md` sections 8 and 9 | 1 |
| B | Studio: shell and shelves | `packages/studio/src/renderer/create/**` (new), `App.tsx`, `launcher/Launcher.tsx`, `styles.css` (new section only). Screens: Idea, Everything, Changes, Share, the Advanced switch, and the shell with the five-step rail. Uses only methods that exist today | 1 |
| C | Agent | All of `packages/agent`: streaming, caching, `ui_ask` / `ui_show`, the three modes, the stage runner, the fake provider's support for all of it | 2 |
| D | Studio: brief, build, play | `packages/studio/src/main/**`, `shared/**`, `web/**`, `renderer/lib/webShim.ts`, and under `renderer/create/` the Brief chat, the Build screen, Play and fix (Just now strip, freeze and note, builder column), the settings sheet for the key | 2 |

## 6. Done when

1. `pnpm check` passes, with tests for: the brief split and write, docs list and read, the explain schema, the
   trace ring and the recent feed end to end, `game.moment`, each agent mode against the scripted model (streamed),
   the stage runner on a template, and the pure view models of the new screens.
2. In the app (web mode, scripted model): an idea typed in the launcher opens a project; the brief streams, a
   question card is answered by a click, the brief card fills, a change marks one section, approve starts the
   build; stages go ready one by one; a sound card plays and is approved; an explain card shows a flowchart;
   Play opens the game with a moving Just now strip; N freezes and a note returns a change card; Put back
   reverts it; Share builds `dist/web/game.js`.
3. Advanced shows today's editor, unchanged.
4. Stated plainly in HANDOFF.md: what no one could judge (how it looks to a person, sound, and every run with a
   real model, since none has been made).

## 7. Not in this milestone

A run with a live model and the eval suite (M9's open items); hosted projects (M8); a timeline or curve editor;
removing the editor; AI-generated meshes or textures (D11).
