# Runtime vs Unreal Engine 5.8: gap analysis and roadmap

Read-only audit, 2026-11-03, branch `editor`. Engine: Bevy 0.20.1 + avian3d 0.8 (Metal via wgpu 30). UE reference: `refs/UnrealEngine` (5.8 sparse tree: Renderer has `Nanite, Lumen, MegaLights, Substrate, VirtualShadowMaps, Froxel, HeterogeneousVolumes, SparseVolumeTexture, VT, VariableRateShading, OIT, HairStrands`; plugins `FX/Niagara, Animation/{PoseSearch, IKRig, ControlRig, MotionWarping, BlendStack, PhysicsControl}, Experimental/{FullBodyIK, ChaosVehiclesPlugin, ChaosModularVehicle, Fracture, GeometryCollectionPlugin, ChaosMover, Buoyancy, DynamicWind, ImpostorBaker, GPULightmass}, Runtime/{Metasound, HairStrands, ResonanceAudio, Synthesis}, ChaosCloth*`).

Method: read the module docs (LOOK, ANIM, VFX, PROPS, SOUND, WORLD, PCG, PERF, PORTING, GAME_GUIDE, COMPARE, audits/*), grepped `src/` for what exists, listed what Bevy 0.20.1 and avian 0.8 ship in the cargo registry. Numbers are from the docs (Apple M5 Pro, 1080p, offscreen, shared machine) unless marked "est." Several docs still say "Bevy 0.19"; the code is on 0.20.1, so re-verify workarounds listed in LOOK.md "Bevy 0.19 workarounds" (they may be fixed or changed upstream).

Honest framing: UE5 is a 30-year, thousands-of-engineers product. "Replicate UE" is not a goal a solo dev can meet feature by feature. The achievable goal is "UE-grade *results* for stylised-to-realistic open-world games on Apple Silicon", reached by baking, imposters, streaming and good authoring tools instead of Nanite/Lumen-class runtime tech.

Legend. Priority: P0 = blocks shipping a good-looking open-world game, P1 = clear quality/perf win, P2 = nice to have. Effort: S (<3 days), M (1-2 wk), L (3-6 wk), XL (2+ months). Risk: L/M/H (chance it slips or hits a wgpu/Bevy limit).

---

## 1. Gap table by area

### Rendering and lighting

| Area | UE 5.8 | Ours (refs, measured) | Bevy / avian already give us, not exposed | Gap | Pri | Eff | Risk |
|---|---|---|---|---|---|---|---|
| Rendering pipeline | Deferred, Nanite visibility buffer, GPU-driven, VRS, Substrate | Bevy forward+clustered; deferred only switched on for SSR (`gfx.rs`); GPU-driven batching, optional GPU occlusion culling (opt-in: 3-15% slower in `render_budget` tests). 20k cubes: 2.15 ms GPU vs Godot 3.9 (`COMPARE.md`) | `bevy_pbr::meshlet` (needs `TEXTURE_INT64_ATOMIC`, Metal+Vulkan only, offline `meshlet_processor`), deferred prepass, OIT (`bevy_core_pipeline::oit`), `fullscreen_material` | No virtual geometry in use; no VRS; no forward/deferred choice per material tier | P1 (meshlet spike) | M spike, XL to ship | H (Apple GPU 64-bit atomics) |
| GI | Lumen (SW + HW RT, screen traces, radiance cache), baked GPULightmass | Sky env light (frozen), reflection probes with SH-9 diffuse (`look/probe.rs`), irradiance volume from code, no lightmaps, no SSGI. Probe realtime 1 face/frame +3.6 ms | `light_probe` (irradiance volumes, env maps), `lightmap` module (Bevy loads lightmaps, no baker), `bevy_solari` (feature `bevy_solari`; hardware RT path-tracer GI, experimental, crate not fetched here) | No dynamic or baked GI beyond probes/ambient. This is the biggest visual gap vs UE | P0 | L (bake) / XL (dynamic) | M (bake) / H (dynamic) |
| Reflections | Lumen reflections, SSR, planar, probes | SSR (Ultra only, deferred switch, +0.43 ms), probes with box parallax (`look/probe.rs`) | `ssr`, `environment_map`, `light_probe` blending (single probe per fragment in Bevy) | No probe blending, no planar reflection (water), SSR is Ultra-only | P1 | M | L |
| Shadows | Virtual Shadow Maps (16k virtual, per-light caching), distance-field, ray-traced | Sun cascades 1-4, 1024-2048 maps, spot shadows share sun texture (churn 230-900 MB when shadowed spots enter/leave), PCSS opt-in +4 ms, contact shadows +0.35 ms (`GAME_GUIDE 3.4`, `LOOK.md`) | `bevy_light` cascades, point/spot/rect lights, `experimental_pbr_pcss`, light textures (`pbr_light_textures`) | No shadow caching, few shadowed local lights, no VSM. Known texture-churn bug (fixed by capacity rounding in a Bevy patch) | P1 | M (cache + patch), XL (VSM) | M |
| Upscaling / AA | TSR, DLSS/FSR/XeSS plugins, MetalFX (Apple) | FXAA / TAA toggle (`gfx.rs`), render scale + CAS 0.35 bilinear (`render_budget/scale.rs`); no SMAA, no MSAA (Off) | `bevy_anti_alias`: SMAA, TAA, FXAA, CAS, DLSS (NVIDIA only); no MetalFX, no FSR in Bevy | No temporal upscaler on Apple. Bilinear+CAS render scale looks soft at 0.5-0.7 | P0 | M (TAA-based upscaler) / L (MetalFX bridge via objc) | M-H |
| Materials / shader graph | Material editor, Substrate (layered), custom HLSL nodes, MPC, RVT blending | `StandardMaterial` via `gfx::load_pbr` (KTX2 BC7/BC5, `color.avg`), custom WGSL in `terrain.wesl`, `particle.wesl`, `film_grain.wesl`; no graph, no material authoring layer. Editor has no material graph yet | `ExtendedMaterial`, `Material` trait, `pbr_anisotropy_texture`, `pbr_specular_textures`, `pbr_transmission_textures`, `pbr_multi_layer_material_textures` (clearcoat), parallax mapping, `fullscreen_material`, triplanar not built-in | Strong PBR coverage exists but is behind cargo features that recompile Bevy; no data-driven material system, no SSS/hair/cloth/eye shading, no layered materials. Needs a "material as data" layer (JSON/RON param sets + WGSL snippets) | P0 | L | M |
| Post-process | Post-process volumes, LUT, DoF, MB, lens | `LookPlugin`: grading, bloom (+1.2-1.8 ms), DoF gaussian/bokeh (+0.11), motion blur (+0.04), CA/vignette/distortion (+0.09), film grain ours (+0.44), auto exposure (+0.01) | `effect_stack`, `auto_exposure`, `bloom`, `dof`, `motion_blur` | Close to UE for the common set. Missing: local post-process volumes (blend by camera position), lens flare, exposure metering mask, LUT import | P1 | S-M | L |
| Sky / atmosphere / clouds / fog | SkyAtmosphere, volumetric clouds, height fog, Froxel volumetric fog, heterogeneous volumes | Bevy atmosphere (+0.11 ms), gradient cubemap, volumetric fog box (+3.2 ms at 32 steps, 80 m box), distance/atmospheric fog, day-cycle timeline (`look/*`) | `atmosphere`, `volumetric_fog`, `bevy_light::volumetric` | **No volumetric clouds**, no height fog as a volume (fog is distance-based), fog box edge visible, no god-ray clouds shadows | P0 (clouds) | M-L | M |
| Decals | DBuffer decals | Forward decals + clustered decals behind `look_clustered_decals` | `decal` module | OK for roads/blood/bullet holes; no DBuffer normal blending | P2 | S | L |
| Particles (Niagara) | GPU sim, data interfaces, ribbons, mesh, collision (scene depth), events, GPU lights | CPU SoA sim, one instanced draw per emitter, ribbons/trails, flipbooks, soft/lit, 8 point lights, pooling, budgets; 100k particles = 2.2 ms frame / 1.2 ms GPU (`VFX.md`) | `bevy_render` compute (no GPU particle crate in tree), `bluenoise` | No GPU compute sim (cap ~100-300k), no depth-buffer collision, lit only by directional + ambient, no volumetric/flipbook-lit smoke, no VFX graph editor, no events between emitters beyond `pops` | P1 | L (GPU sim) | M |
| Hair / skin / eyes / cloth shading | Strands, Substrate SSS, Groom, MetaHuman | None | Transmission, clearcoat, anisotropy features; no SSS | No character shading beyond PBR | P2 | L per feature | M |
| Water | Water plugin (Gerstner, shorelines, buoyancy), Single-Layer Water | None. `WORLD.md`: "Water ... not part of this module" | transmission, `ssr`, OIT | **No water at all** | P0 for open world | L | M |

### Terrain, world, streaming

| Area | UE 5.8 | Ours | Bevy gives | Gap | Pri | Eff | Risk |
|---|---|---|---|---|---|---|---|
| Landscape / terrain | Landscape (sculpt, layers, holes, splines, Nanite landscape), RVT, Virtual Heightfield Mesh | `Terrain`: heightfield → 128 m chunks, geomipmap by screen error, skirts, 4-layer splat, avian heightfield colliders (`world/terrain.rs`, `terrain.wesl`); editor `terrain_edit` example; **runtime sculpt/paint exists** (`world::TerrainEdit`, brushes, undo, live chunk + collider rebuild, docs/WORLD.md "Editing terrain"; corrected by lead) | `mesh`, `bevy_mesh` compute; no terrain | No holes/caves; no per-layer normal/roughness; no triplanar cliffs; shared UV scale; no RVT; no tessellation/displacement; stitching only by skirts | P0 | M (triplanar + layer PBR) / L (RVT-like blend cache) | M |
| Foliage | HISM, grass, wind (DynamicWind), Nanite foliage | `ScatterRule` merged clusters/batched instances, far tier (`world/scatter.rs`), PCG; sway only for props (`props/sway.rs`) | automatic GPU instancing, `VisibilityRange` | No wind on grass/trees, no GPU-driven grass, no tree imposters (far tier = cheaper mesh), no LOD crossfade for trees beyond dithered range | P0 | M (wind in vertex shader + imposters L) | L-M |
| Streaming (World Partition, HLOD, level streaming) | Grid cells, data layers, HLOD builder, async load, one-file-per-actor | `WorldCells` streaming, `StreamSource`, per-cell HLOD (vertex-clustering in background tasks), floating origin XZ (`world/*`, `render_budget/stream.rs`) | `AssetServer` async | Cell spawn is on the main thread (spikes with thousands of prefabs), cell content not saved, HLOD simplification blobby, no texture streaming/virtual textures, no HLOD for materials (atlas) | P0 | M-L | M |
| LOD / culling | Nanite, auto LOD, imposters, HLOD, instance culling, distance-based | Scenery/Actor tags, dithered `VisibilityRange` crossfade, far twin, small-prop fade, frustum culling in Bevy, optional GPU occlusion; "mesh-LOD cook planned" (`GAME_GUIDE 5.3`). 40k props: 1736 of 32k drawn, p95 3.4 ms (`PORTING`) | `VisibilityRange`, GPU occlusion culling, `meshlet` LOD DAG | **No offline mesh LOD / simplification pipeline**, no imposter baker, 32-camera VisibilityRange cap | P0 | M (meshopt-based LOD cook) + M (imposters) | L |
| Scalability | `sg.*`, device profiles, dynamic res | `QualityPreset` x4 tiers, governor with game levers, render scale, hi-dpi ceilings, TextureCap (`gfx.rs`, `render_budget/governor.rs`) | n/a | Already ahead of UE-lite; missing per-game scalability groups editor and per-device presets file | P2 | S | L |
| Texture streaming | Texture streaming + VT | Tier cap drops top mips at load (`max_texture_size`); mips from KTX2 | `ktx2` | No streaming by distance, no residency budget, no VT. Memory stays high in big worlds (`audits/anim_assets.md`) | P1 | L | M |

### Animation

| Area | UE 5.8 | Ours (`src/anim`, 215+ lines mod; `ANIM.md`) | Bevy gives | Gap | Pri | Eff | Risk |
|---|---|---|---|---|---|---|---|
| State machines / AnimBP | AnimGraph + state machines, sub-graphs, linked layers | `AnimGraphDef` builder: layers, states, transitions with conditions/exit time/fade, any-state, triggers, notifies (`machine.rs`, `def.rs`) | `AnimationGraph`, blend nodes, clip sampling (parallel) | Good. Missing: sub-graphs / linked graphs, state aliases, additive-from-reference, pose cache | P1 | M | L |
| Blend spaces | 1D/2D blend spaces with sync groups | 1D + 2D blend, sync by weighted clip (`blend.rs`) | | Good enough; no analysis/auto-timing | P2 | S | L |
| Montages / slots | Montages, slots, sections, branch points | **None** (state `.once()` + triggers only) | | Needed for combat/interaction: play clip on a slot over base layer, sections, blend out, interrupt | P0 | M | L |
| IK | Control Rig, IK Rig, FullBodyIK, Foot IK | `TwoBoneIk`, `LookAt`, `SpringBone` (no collision), `FootPlacement` (1 ray per foot) (`ik.rs`, `foot.rs`) | | No FABRIK/CCD chains, no full-body IK, no Control Rig graph; foot placement uses 1 ray | P1 | M (FABRIK + hand IK + foot 2-ray) | L |
| Motion matching | PoseSearch, BlendStack | None (doc: "no motion matching") | | Big visual win for locomotion; needs database build + search; inertialization is prerequisite | P1 | XL | H |
| Inertialization | Inertialization node | None ("crossfades blend live clips") | | Cheap quality win for transitions | P1 | M | L |
| Retargeting | IK Retargeter, skeleton compat | None: clips target bone names; VRM / Mixamo-style names tolerated (`ANIM.md`) | | Can't reuse a clip library across rigs; blocks buying/using Fab animation packs freely | P0 | L | M |
| Root motion / motion warping | Root motion, Motion Warping | Root motion (`root_motion.rs`); no warping | | Add warp-to-target for melee/climb/vault | P1 | M | L |
| Ragdoll / physical animation | Chaos ragdoll, Physical Animation, PhysicsControl | None (avian joints exist) | `avian3d::dynamics::joints` (revolute, spherical, prismatic, fixed, distance + motors) | No skeleton→joint ragdoll builder, no blend to ragdoll, no powered ragdoll | P1 | M | M |
| Cost | Animation budget allocator, LOD, URO | Animation LOD (distance/visibility; 0.8 → 0.46-0.55 ms eval), constant-track stripping is an open audit item | | Constant-track strip (7,182 of 8,385 channels constant on Shroud enemy) not done; no GPU skinning crowd (vertex animation textures) | P1 | S (strip) / L (VAT crowds) | L |
| Facial / morph / cloth deformers | MetaHuman, RigLogic, ML Deformer | Morph targets via Bevy only | `morph` | none | P2 | XL | H |

### Physics

| Area | UE 5.8 | Ours | avian 0.8 gives | Gap | Pri | Eff | Risk |
|---|---|---|---|---|---|---|---|
| Rigid bodies | Chaos, async physics, sub-stepping | avian at 64 Hz x 6 substeps; 4,000 boxes hold 60 fps after worker cap (`COMPARE.md`); known issues in `audits/physics.md` (kinematic contacts, `transform_to_position` O(all), per-instance mesh colliders, no manifold reuse) | Soft-step solver, islands, CCD, joints, collider BVH, character controller module (`character_controller`), picking | Fixes listed in audit are mostly unlanded; no physics layers convention, tick/substeps not in `EngineOptions` | P0 | M | L |
| Character movement | CharacterMovementComponent, Mover | `fps.rs` kinematic collide-and-slide, 9 shape casts per controller | `character_controller` | Only FPS controller; no third-person capsule movement with slopes/steps/ledges/ladders/swim/vehicles | P0 | M | L |
| Vehicles | Chaos Vehicles / Modular Vehicles | None in engine (games like Courier do their own) | joints, no vehicle | Raycast-wheel vehicle (suspension, tyre friction curve, gears) as a module | P1 | M | L |
| Destruction | Geometry Collection / Fracture, Field System | `props/topple.rs` (rigid-rod fall) + debris; game decides break | | No fracture (Voronoi) or runtime chunk break; prefractured meshes + debris pool is the realistic substitute | P1 | L | M |
| Cloth | Chaos Cloth (asset editor) | None | none | Skip real cloth; use spring-bone chains + vertex-shader flags/capes | P2 | M (springs) / XL (sim) | M |
| Soft body / fluids | Chaos Flesh, Niagara Fluids | None | none | Out of scope | P2 | XL | H |
| Buoyancy / wind | Buoyancy, DynamicWind | None | | Needs water first | P1 | S after water | L |

### Audio

| Area | UE 5.8 | Ours (`src/sound`, `SOUND.md`) | Bevy / libs | Gap | Pri | Eff | Risk |
|---|---|---|---|---|---|---|---|
| Graph audio (MetaSounds) | Node-graph synth/DSP, procedural | Rust DSP (`dsp.rs`), `synth::blip`, cues with variants/randomisation | rodio 0.22 (one `MixStream` source), symphonia codecs | No graph/procedural audio; fine for shipped games using sample cues | P2 | L | L |
| Attenuation / spatialization | Attenuation curves, occlusion, HRTF, Resonance, 5.1/7.1 | Rolloff, doppler, equal-power pan + rear low-pass, binary raycast occlusion | | **Stereo only, no HRTF**, binary occlusion without transmission/diffraction | P1 | M (HRTF via small crate or SOFA/own HRIR convolution) | M |
| Reverb | Submix reverb, convolution, per-volume | One global reverb, snapshot-blended, zones change character | | No convolution/IR, no per-zone reverb sends | P1 | M | L |
| Concurrency / mixing | Sound concurrency, priority, voice stealing, ducking | Voice limits with stealing, priorities, cooldown, buses, snapshots, ducking, music with quantized transitions, captions (`voice.rs`, `bus.rs`, `music.rs`) | | On par for mid-size games | - | - | - |
| Audio streaming / memory | Streaming, compression (ADPCM/Opus) | Whole-clip decode via Bevy/rodio; resampling linear | | No streaming for long music/ambience, linear resample | P1 | M | L |
| Modulation / synthesis | Audio Modulation, Synthesis | Pitch jitter only | | Parameter modulation buses (RTPC-like) missing | P2 | M | L |

---

## 2. Feasibility: what not to replicate, and the substitute

| UE feature | Realistic? | Why | Substitute (and what it costs) |
|---|---|---|---|
| **Nanite** (virtual geometry, software raster, streaming clusters) | No as a general solution | Bevy's `meshlet` is an experimental reimplementation needing 64-bit image atomics (M-series Metal supports it in recent wgpu, but material limits, no skinning, no alpha mask, offline preprocessing, no streaming of dense worlds). A solo dev will spend months tuning it | **LOD cook (meshoptimizer) + HLOD + imposters + dithered crossfade** (already half there). Optional spike: `meshlet` for hero static photogrammetry only. Achievable in ~6 weeks |
| **Lumen** (dynamic GI + reflections) | No | Needs SDF/surface cache + HW RT or software tracing in the tens of ms. Metal RT is only M3+ (wgpu exposes `EXPERIMENTAL_RAY_QUERY` when `supports_raytracing`); M1 8 GB cannot afford it | **Baked GI**: probe grids (irradiance volumes) + reflection probes + sky env light + SSAO/contact shadows; time-of-day via 2-4 baked states blended. Optionally evaluate `bevy_solari` on M5 only as an Ultra-tier experiment (status unverified; do a 2-day spike, not a plan dependency) |
| **Virtual Shadow Maps** | No | Needs sparse virtual textures + page management | Cascades + shadow caching for static geometry + a small number of shadowed local lights + contact shadows |
| **MegaLights / thousands of shadowed lights** | No | Needs stochastic RT shadows | Light budget per cell + unshadowed clustered lights; baked lamps |
| **Substrate / full layered shading** | Partially | Per-feature extension is feasible; the unified framework is not | `ExtendedMaterial` for SSS-lite, hair cards, cloth sheen, eyes; clearcoat/anisotropy from Bevy features |
| **TSR** | Partially | A TAA-based upscaler is doable; quality equal to TSR is hard | Own TAA upsample (jittered, history reprojection) + CAS; or MetalFX Temporal Upscaler through a native bridge (Apple-only, best quality/effort) |
| **MetaHuman, groom strands, RigLogic, ML Deformer** | No | Asset pipeline + rendering + licensing | Stylised characters, VRM/Mixamo + our anim stack, hair cards; Fab/CC0 humanoids |
| **Niagara editor + data interfaces** | No (editor) | The module system is huge | Keep code-first `EffectDef`; add GPU sim for scale, a few more presets. Editor panel for `EffectDef` is a separate (editor team) concern |
| **Chaos** destruction / cloth / fluids / vehicles (full) | No (full) | Many solvers | Prefractured chunks + debris, raycast vehicle, spring-bone cloth. Avian stays |
| **World Partition one-file-per-actor** | Not needed | Team workflow feature | Level files + cells (exists) |
| **MetaSounds** | Not needed at first | | Cues + DSP chains |
| **Heterogeneous volumes / SVT** | No | | Volumetric fog box + particle smoke |

What is achievable in months (solo): baked GI pipeline, volumetric clouds (raymarched, low-res + temporal), water (Gerstner + planar/SSR + foam + shoreline depth fade), terrain materials/triplanar/wind grass, mesh LOD + imposters, TAA/MetalFX upscaling, montage/IK/inertialization/retargeting, ragdoll, vehicle, HRTF, GPU particles. That set reaches "good-looking UE-lite open world" on M5 Pro High and a stable stylised look on M1 8 GB Low.

---

## 3. Top 15 gaps by value (for this user's target)

1. Baked/probe GI pipeline and time-of-day blending (no GI beyond SH probes today).
2. Water (none).
3. Volumetric clouds + height fog volume.
4. Temporal upscaling for Apple (TAA upsample or MetalFX), replacing bilinear render scale.
5. Terrain material system: triplanar cliffs, per-layer PBR, holes (runtime sculpt already exists).
6. Foliage wind + tree imposters + grass LOD.
7. Mesh LOD cook + imposter baker (`engine::geometry` is only planned).
8. Material-as-data layer (ExtendedMaterial presets, SSS-lite, hair cards) and enabling Bevy PBR features without recompile surprises.
9. Montages/slots, inertialization, sub-graphs.
10. Retargeting (IK-rig-lite) so clip libraries are reusable.
11. Third-person character movement + physics layer convention + audit fixes.
12. Ragdoll builder + blend to ragdoll.
13. Cell streaming off the main thread + texture streaming.
14. HRTF + per-zone reverb + audio streaming.
15. GPU particle sim + depth collision; plus local post-process volumes.

(Vehicles, destruction, motion matching and shadow caching are the next tier.)

---

## 4. Roadmap

Each work package (WP) is independent unless a dependency is listed. Perf budgets: **M1 8 GB Low** = 60 fps at 1080p / 0.7 scale, <=7 ms GPU, <=3.5 GB RSS; **M5 Pro High** = 60 fps at 1440p-native, <=10 ms GPU (look_showcase High baseline 10.0 ms p50 today incl. everything, so new features must fit inside their stated delta). Measure with `scripts/perf_suite.py` (add a scene per WP) and `perf.stats`; governor off.

### Phase 1 (weeks 1-3): remove the visible holes, cheap wins

| WP | Owns | Deliverable | Acceptance | Budget (M1 Low / M5 High) |
|---|---|---|---|---|
| 1A Water v1 | new `src/water/`, `docs/WATER.md`, example | Gerstner/flat plane material, depth fade shore, foam, refraction via transmission or screen copy, SSR/probe reflection, `Buoyancy` helper, underwater fog | Screenshot review (day/dusk), `water.*` control cmds, no pipeline rebuild on toggle | +0.5 ms / +1.2 ms at 1080p |
| 1B Terrain materials | `src/world/terrain.wesl`, `material.rs` | Triplanar on steep slopes, per-layer normal+rough (BC5), per-layer UV scale, height-blend | Cliff screenshot has no stretch; texture memory <= 4 layers x 3 maps x 1.4 MB at Low cap | +0.2 / +0.4 ms |
| 1C Wind | `src/props/sway.rs`, `world/scatter.rs`, new vertex shader | Global wind field (`Look.wind`), vertex-shader sway for scatter grass/trees | Grass sways, no extra draw calls, no CPU cost per instance | ~0 CPU, +0.1 ms |
| 1D Mesh LOD cook | `tools/cook/`, `scripts/cook.py`, `src/render_budget/detail.rs` | meshopt simplification → LOD chain `lodN` in glTF extras/sidecar; auto `VisibilityRange` | 1M-tri scene drawn tris cut >=60% at street pose, no popping (dither) | -20% GPU on heavy scenes |
| 1E Upscaler spike | `src/render_budget/scale.rs`, new `src/gfx/upscale` | Jittered TAA-upsample + CAS at scale 0.5-0.77; evaluate MetalFX Temporal bridge in a 3-day spike | Side-by-side vs bilinear at 0.6 on 3 screenshots; no ghosting on foliage | Saves ~35% GPU at 0.7 scale vs native |
| 1F Physics audit fixes | `src/fps.rs`, `src/physics*`, `world/prefab.rs` | Layers convention, `SubstepCount`/tick in `EngineOptions`, `Changed<GlobalTransform>` sync, shared prefab colliders, capsule trunks | `audits/physics.md` #1,#4,#5,#8,#9 closed; `bench.py` physics numbers improved | -0.3 ms CPU / 10k colliders |
| 1G Anim quick wins | `src/anim/` | Constant-track strip at bind, additive-from-reference, `Montage` v1 (slot over base layer, sections, blend out) | Shroud enemy channels 8,385 → ~1,200; montage test in `tests/anim.rs` | -0.2 ms eval / 300 chars |
| 1H Verify 0.20 | docs | Re-run `look_showcase` shots, check LOOK.md "workarounds" still needed, update docs from "Bevy 0.19" | Doc diff + list of removed fixes | - |

### Phase 2 (weeks 4-10): lighting, world, characters

| WP | Owns | Deliverable | Acceptance | Budget |
|---|---|---|---|---|
| 2A Baked GI | `src/look/bake/`, `docs/GI.md`, CLI `bake` | Offline irradiance-volume + probe grid bake (CPU/GPU path-trace using the scene's own mesh, or capture-based multi-bounce), stored per cell; blend 2-4 time-of-day states | Indoor/outdoor scenes lit without ambient flat look; bake <10 min for 1 km², runtime memory <= 64 MB | ~0.3 ms / 0.5 ms; Low uses SH-only |
| 2B Volumetric clouds + height fog | `src/look/clouds.rs`, `.wesl` | Raymarched cloud layer (low-res + temporal reprojection), cloud shadows on terrain, height-fog volume integrated with atmosphere | Dusk/day shots, sun passes through; no per-toggle pipeline rebuild (warm at load) | 0.8 ms / 1.8 ms (Low: 2D scrolling layer 0.1 ms) |
| 2C Imposters + tree LOD | `src/world/scatter.rs`, `tools/` imposter baker | Octahedral imposter bake from meshes, scatter uses it for far tier | Forest of 20k trees drawn in <=250 draws | -30% far-field GPU |
| 2D Cell streaming v2 | `src/world/cells.rs`, `render_budget/stream.rs` | Off-main-thread build of cell data, N-per-frame spawn budget, texture residency budget | No frame >20 ms while flying across a 4 km world at 30 m/s | spike p99 < 20 ms |
| 2E Character movement | new `src/character/` | Third-person capsule controller (steps, slopes, ladders, swim, vehicle enter), Mover-like movement modes | Test scenarios; works with `anim` root motion | <0.05 ms per character |
| 2F Anim v2 | `src/anim/` | Inertialization, sub-graphs/linked layers, FABRIK, 2-ray foot IK, motion warping, retargeting (bone map + proportions) | Mixamo clip plays on VRM rig with feet planted; transition test shows no foot slide | <+0.1 ms / 100 chars |
| 2G Ragdoll | `src/anim/ragdoll.rs` (feature physics) | Skeleton → avian joints with limits, blend in/out, pooled | Hit → ragdoll → get-up demo; 20 ragdolls <1.5 ms CPU at 64 Hz | |
| 2H Material layer | `src/gfx/material.rs` | `MaterialDef` RON with presets (SSS-lite, cloth, glass, foliage translucency, hair card, clearcoat), uses ExtendedMaterial; Bevy PBR features enabled in one documented feature group | Preset gallery example, golden images | within +0.3 ms for 10 presets |
| 2I Audio v2 | `src/sound/` | HRTF binaural (HRIR convolution, headphone toggle), per-zone reverb sends, long-clip streaming | A/B listen test + DSP bench; CPU <= 3% audio thread at 64 voices | |
| 2J Local post-process volumes + exposure mask | `src/look/` | `LookVolume` blend by camera position, priority | `look.set` test, screenshot | ~0 |

### Phase 3 (months 3-6): scale and spectacle

| WP | Owns | Deliverable | Acceptance |
|---|---|---|---|
| 3A GPU particles | `src/vfx/gpu_sim.rs` | Compute sim path, depth-buffer collision, 1M particles | 1M particles <= 2 ms GPU on M5; same `EffectDef` API |
| 3B Shadow caching + local-light budget | `src/gfx.rs`, `look/` | Static-cascade cache, fixed-capacity spot layer pool (kills texture churn), nearest-K shadowed lamps with hysteresis | No >100 MB allocation spikes when lamps toggle; 10 shadowed lamps stable |
| 3C Vehicle + destruction | `src/vehicle/`, `src/props/fracture.rs` | Raycast-wheel vehicle; prefractured chunk break with debris pool | Drive demo; 50 chunks break <2 ms |
| 3D Motion matching spike | `src/anim/mm/` | Feature database, KD-tree search, inertialization blend | Locomotion quality A/B vs state machine on 30 min of mocap-free clips (Mixamo) |
| 3E Terrain runtime edit + RVT-lite | `src/world/` | Holes/caves, runtime brush, baked low-res blend texture for far terrain | Edit at runtime without respawn; far terrain 1 draw/chunk |
| 3F Meshlet spike (optional) | feature `meshlet` | Hero photogrammetry via `MeshletMesh` | Only if M5 + Metal path validated; decision memo |
| 3G Solari spike (optional, M5 only) | feature `bevy_solari` | 2-day feasibility on Metal RT | Decision memo; do not depend on it |

### Dependencies and ordering
1A needs 1E-independent; 2A needs 1H; 2C needs 1D; 2G needs 1F; 3B should come before adding many lamps (2A reduces lamp need); everything that adds a view feature must be warm-loaded (`WarmPipelines`) and never toggled in play (CLAUDE.md rules).

### Risks to watch
- Any new cargo feature forwarded to Bevy recompiles all of Bevy (~5 GB, minutes); group them into one "render_plus" feature.
- Metal RT / 64-bit atomics availability varies by chip: M1 has neither, so every Ultra-only feature needs a Low/Medium fallback and `QualityPreset` gating.
- Docs say Bevy 0.19 in places; verify before trusting any listed upstream bug.
- All GPU numbers in the docs came from a shared machine; re-measure on idle M1 and M5 before locking budgets.
