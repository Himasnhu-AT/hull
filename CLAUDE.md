# CLAUDE.md: building on `engine`

@AGENTS.md

## Read first

Before writing or changing a game on this engine (new game, new map, rendering, assets, perf),
read **[docs/GAME_GUIDE.md](docs/GAME_GUIDE.md)** and follow it. It is the playbook: what to use
when, the new-game checklist, the performance rules (each one cost us frames or memory on
Shroud), look recipes, the asset pipeline, how to measure, and a symptom → cause → fix table.
Then read the module doc for what you're touching.

The rules that matter most, so you don't skip them:
- Tag meshes `Scenery` (static) or `Actor` (moving or pooled). Share meshes and materials;
  merge static geometry per material.
- Never toggle view features (SSR, SSAO, contact shadows, shadow filter, volumetric, bloom, TAA)
  during play: each toggle rebuilds every pipeline on macOS. Send `WarmPipelines` after loads.
- Keep shadowed lamps in view steady and few (spot shadows share the sun's texture in Bevy 0.19).
- Give the quality governor game levers (`GovernorStep::Game(n)`, `GovernorState::game_level`)
  and show `QualityChanged` as a toast.
- Cook textures to KTX2 (BC7/BC5 + `color.avg`) and load them with `gfx::load_pbr`.
- Measure with real GPU samples, same binary, governor off; look at every screenshot you take.

## Which doc covers what

| Doc | Covers |
|---|---|
| docs/GAME_GUIDE.md | The playbook (start here) |
| AGENTS.md | Build/test loop, layout, control port, conventions |
| docs/PORTING.md | Settings, devtools, metrics window, ship builds, render budget, governor, render scale, warm-up |
| docs/LOOK.md | Sun, sky, fog, exposure, grading, lens, probes, decals, quality tiers |
| docs/PERF.md | Benchmarks, perf suite, monitoring keys |
| docs/DEVKIT.md | Inspector, scenario tests, replay, golden images, saves, hot reload, content pipeline |
| docs/VFX.md | Particles, budgets, near-camera fade |
| docs/ANIM.md | Animation state machines, blend spaces, root motion, IK |
| docs/AI.md | Navmesh, agents, behaviour trees, utility AI, perception |
| docs/SOUND.md | Cues, mixer, 3D sound, music, captions |
| docs/ACTIONS.md | Input actions, rebinding, gamepad, accessibility |
| docs/L10N.md | Localization |
| docs/WORLD.md | Terrain, scatter, cell streaming, HLOD, floating origin |
| docs/NET.md | Multiplayer (feature `net`) |
