# Hull

Marl Studio's game engine, in TypeScript, where an AI writes the game and a person checks and tunes it.

**Status: plan only.** Nothing is built yet. This folder holds the design.

## The idea in five lines

1. **The AI writes the game** as TypeScript (logic) and JSON (config: sounds, characters, animations, UI, numbers).
2. **You check each piece on its own** in Hull Studio: play a sound, turn a character round, run an animation,
   open a menu. You approve it, leave a note for the AI, or drag a slider.
3. **A slider edits the real file**: the JSON value, or the literal in the TypeScript, live while the game runs.
4. **Nothing is lost.** Hull records every change by default. You run experiments side by side and adopt the best.
5. **One command builds one JavaScript file** that is the whole game. It runs on a website, and wrapped in a
   desktop shell it runs natively on macOS, Windows and Linux.

## What is in this folder

| File | What it answers |
|---|---|
| [`PLAN.md`](PLAN.md) | Goals, the parts, history and experiments, the tech stack, milestones, the hosted model, decisions made and still open. **Start here.** |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the runtime, config, tunables, build, history, Studio and test tools are built. |
| [`docs/SCHEMAS.md`](docs/SCHEMAS.md) | Every kind of config file, with its JSON Schema and an example. |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | The day-to-day loop: what the AI runs, what you do in the Studio, experiments, building and packaging. |
| [`docs/COMPETITION.md`](docs/COMPETITION.md) | Summer Engine, and where Hull differs. |
| [`CLAUDE.md`](CLAUDE.md) | The working guide for the agent that builds this. |

## The parts

```
            writes                         checks, tunes
   AI ─────────────────►  GAME PROJECT  ◄───────────────── you
                          src/      logic and tunables (TypeScript)
                          config/   what things are (JSON)
                          .hull/    history, experiments, notes (Hull's own, hidden)
                               │
        ┌──────────────────────┼───────────────────────┐
        ▼                      ▼                       ▼
     RUNTIME                TOOLS                 HULL STUDIO
  the library the       check · test · play      a desktop app:
  game runs on:         bench · history · exp    a bench for every
  loop, world,          build · package          kind of piece,
  render, sound,        (one command line,       sliders from the
  animation, UI,        made for an agent        schemas, the
  input, saves          to drive)                timeline, review
        │
        ▼
   dist/game.js  ──►  website
                 ──►  desktop shell  ──►  macOS · Windows · Linux
                 ──►  Marl's hosting ──►  a link, free to play and share (later)
```

## The old engine

The earlier Rust engine is archived in `../engine-dep`. This is a new design, not a port.
