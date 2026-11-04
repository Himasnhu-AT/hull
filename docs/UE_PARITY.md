# UE5 parity: audit summary and roadmap

Goal (owner, 2026-11-03): replicate Unreal Engine 5's editor UI and capabilities on this engine.
Three audits against the UE 5.8.4 source (`refs/UnrealEngine`) and UE 5.5+ behaviour; full tables
with file refs, priorities, effort and owned files are in `docs/audits/ue/`:

| Report | Rows | Covers |
|---|---|---|
| [EDITOR_VS_UE.md](audits/ue/EDITOR_VS_UE.md) | ~90 | Level editor, viewport, Outliner/Details, Content Browser, Blueprint/asset editors, PIE, Sequencer, landscape/foliage, World Partition UI, scripting, packaging UI |
| [RUNTIME_VS_UE.md](audits/ue/RUNTIME_VS_UE.md) | ~25 areas | Rendering, GI, shadows, upscaling, materials, terrain, water, sky, VFX, animation, physics, audio, streaming |
| [GAMEPLAY_PIPELINE_VS_UE.md](audits/ue/GAMEPLAY_PIPELINE_VS_UE.md) | 48 | Gameplay framework, GAS, input, tags, data, net, AI, cinematics, import/cook/pak, packaging, CI, crash, profiling, mods |

## Where we already beat UE (keep, don't replicate downward)

Agent-driven control port + MCP on every build; headless `Scenario` tests and replay; text-only,
diffable assets (`.level.ron`, `.logic.ron`, `.ruspy`, JSON); located logic/script diagnostics;
reproducible ship builds with a debug-crate leak check; Bevy-free editor UI that survives engine
upgrades. (UE 5.8 is starting to add MCP, so this edge narrows.)

## Not replicated, and the substitute

| UE | Why not | Substitute |
|---|---|---|
| Nanite | Virtual geometry on wgpu/Metal isn't production-ready | Mesh LOD cook + HLOD + imposters; spike Bevy `meshlet` for hero statics |
| Lumen | No practical real-time GI on Metal via wgpu | Baked irradiance probes with time-of-day blend + SSAO/contact shadows; optional Solari spike (M3+ RT) |
| Virtual Shadow Maps / MegaLights | Bevy shadow model | Cascades with static caching, shadowed-light budget per cell |
| Substrate / node material editor | Bevy PBR; pipeline-rebuild rules | Material-as-data presets (ExtendedMaterial), schema-driven editor |
| TSR | — | Own TAA-upsample or MetalFX |
| MetaHuman / Groom | Asset scale | Stylised/VRM characters, hair cards |
| Niagara node editor | — | Code-first `EffectDef` + preset editor, GPU sim later |
| Chaos destruction/cloth/fluids | — | Prefractured chunks, raycast vehicle, spring-bone cloth |
| Blueprint VM, construction scripts | Code-first Rust | Logic graphs + ruspy + prefabs with Spec components |
| Live Coding (C++ hot reload) | Rust | Data hot reload, Simulate, Attach to the running game |
| UObject/Actor hierarchy, full GAS, Mass | Bevy ECS already covers it | Small framework modules (tags, damage, pawn/controller, ability-lite) |
| `.uasset` registry, redirectors, Python, Verse, Gauntlet/Horde/DDC | — | Reference scanner + rename tool, ruspy + `editor.*` protocol, Scenario tests, hash-cached cook |

## Roadmap

Effort is for parallel Sonnet agents in worktrees with their own cloned target dirs, reviewed and
merged by the lead. Each package owns disjoint files (see the reports).

**Phase 0 (≈1 week, blocks the rest)**
- Split `crates/editor-ui/src/lib.rs` (≈1.5k lines), `src/editor/backend.rs`, `control.rs`,
  `editor-proto` into modules; add `DocumentTab` / `Panel` traits so packages stop colliding.
- Refresh docs still saying "Bevy 0.19"; re-measure GPU numbers on an idle M1 and M5.

**Phase 1 (≈3 weeks): biggest visible holes**

| Track | Packages |
|---|---|
| Editor | Viewport bar (view modes, show flags, bookmarks, ortho top) · Edit ops (copy/paste, duplicate, multi-select edit, surface snap, pivot, marquee) · Prefabs / level instances (core) · Simulate, Play-from-here, console |
| Runtime | Water v1 · Terrain materials (triplanar cliffs, per-layer PBR) + foliage wind · Mesh LOD + imposter cook · Upscaler spike + physics audit fixes + montage v1 |
| Gameplay / pipeline | Gameplay tags + damage/health/checkpoint/rules + pawn/controller · Vehicle core extracted from Pacenote · Multi-platform packaging/signing/notarisation + CI matrix (Windows) + native crash capture |

**Phase 2 (≈4–8 weeks): lighting, world, content, framework**
Content Browser v2 (thumbnails, rename with reference fix-up, import dialog + sidecars, reference
viewer, autosave) · World panel (cells, HLOD, budgets) + Attach to running game · Data/Curve
editors on one schema framework · PCG graph editor (reuses the Logic canvas) · Terrain v2
(erosion, >4 layers, heightmap import/export, road deform) · Baked GI · Volumetric clouds + height
fog · Streaming off the main thread + texture streaming · Animation v2 (inertialization, IK,
retargeting) + ragdoll + third-person controller · Audio v2 (HRTF, zone reverb, streaming) ·
Data tables / archetypes · Steam/platform services · UI screen stack + binding · Camera stack +
Timeline v1 · Pak format + unified hash-cached cook · Git panel, Check Level, Build/Package menu.

**Phase 3 (≈3–6 months): scale and spectacle**
GPU particles · Shadow caching · Vehicles + destruction · Motion matching spike · Sequencer-lite ·
Animation state machine and behaviour tree editors · Logic v2 (live debug) · VFX/sound preset
editors · Netcode v2 (prediction smoothing, travel, encryption) · Mods/plugins · Localization
panel · Multi-viewport · Accessibility pass · optional meshlet/Solari spikes.

## Corrections to the reports
- Runtime terrain sculpt/paint already exists (`world::TerrainEdit`, docs/WORLD.md).
- The Unreal reader (`crates/uasset`) is on branch `spike-uasset`, not merged; `tools/ue-import`
  doesn't exist yet. docs/EDITOR.md describes them as planned.
