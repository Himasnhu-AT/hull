# Audit: animation, skinning, asset loading vs Unreal 5.8 / Godot

Read-only. Nothing was built or run. The numbers come from code, from `docs/ANIM.md` measurements (309 mannequins, M5 Pro) and from a python parse of `shroud/assets/models/enemy.glb`: 65 joints, 8.5k verts, 43 clips, 195 channels per clip.

## Ranked findings

### 1. Most of the enemy's animation data does nothing, and Bevy still samples all of it every frame
- **Us/Bevy:** 7,182 of 8,385 channels in enemy.glb are constant. All scale channels, 99 % of translation channels and 58 % of rotation channels never change. 143 of the 195 node/path tracks sit at the rest pose in every clip. That is 5.6 MB of the 6.9 MB of key data. Shroud uses 14 of the 43 clips (`shroud/crates/game/src/enemy/animation.rs:31-44`); those 14 hold 1.6 MB. The glTF loader collapses a curve only when it has exactly one key (`bevy_gltf-0.19.1/src/loader/mod.rs:342,399,455`). Every other channel becomes an `UnevenSampleAutoCurve` with its own copy of the timestamps (26 distinct input accessors become 8,385 time arrays). At runtime each bone pays a dyn dispatch, a binary search and a lerp/slerp per curve (`bevy_animation-0.19.1/src/lib.rs:1236-1266`).
- **Unreal:** strips trivial keys and tracks before encoding (`Engine/Private/Animation/AnimCompress_RemoveTrivialKeys.cpp`, `AnimCompress_RemoveLinearKeys.cpp`), then uses quantized per-track codecs with ISPC decode (`AnimEncoding_PerTrackCompression.cpp/.ispc`). **Godot:** `Animation::compress` (`scene/resources/animation.cpp:5046`) stores tracks as bit-packed, cache-sized pages.
- **Impact:** curves per clip drop from 195 to 52 (3.75× fewer samples). Memory drops from 6.9 MB to about 0.4 MB (used clips, rest tracks removed). 6 enemies: about 0.1 ms of worker-thread time. 100 enemies: about 2 ms of thread time, roughly 0.3–0.5 ms wall.
- **Fix:** an engine pass at bind time (`anim/systems.rs` BindCache) that removes a target's curve only when it is constant and at rest in **every** clip of the graph. Removing a curve from some clips but not others would change Bevy's per-bone weight normalisation. Turn other constant curves into `ConstantCurve`. Add a GLB cook step in `tools/cook` that also drops unused clips per game (shroud) and stores shared timestamps.
- **Risk:** low if the "at rest in all clips" rule holds. Cover it with a golden-pose test.

### 2. Skinned pipelines are probably not warmed in Shroud (load hitch)
- **Us:** `PipelineWarmup::extra` exists to cover skinned layouts (`engine/src/render_budget/warmup.rs:27-29`). Shroud only sends `WarmPipelines` (`shroud/crates/game/src/gfx.rs:176-184`) and never registers the enemy mesh and material. The SKINNED main, prepass (with motion vectors) and shadow variants are therefore likely to compile synchronously the first time an enemy is drawn. Shroud's own comment puts that at "100s of ms each" on macOS.
- **Unreal:** PSO precaching per component and material. **Godot:** an ubershader plus background specialisation.
- **Impact:** possibly a 100–500 ms one-off stall each map. Confirm with the `perf.stats` hitch counter.
- **Fix (shroud):** once the Gltf loads, push the enemy primitives' `(Handle<Mesh>, Handle<StandardMaterial>)` into `PipelineWarmup.extra`. **Risk:** none.

### 3. Characters skipped by LOD still cost about 45 % of a posed one
- **Us:** a skipped animator swaps to `IdleGraph` (`anim/systems.rs:212-242`). Bevy's `animate_targets` still visits every bone entity: player lookup, graph lookup, threaded-graph HashMap, mask HashMap (`bevy_animation lib.rs:1082-1130`). The measurements in ANIM.md (0.80 ms with 309 posed vs 0.46 ms with 60 posed) give about 2.6 µs per posed character and about 1.2 µs per skipped one. Skipped frames also hold the old pose, so the 15–35 m tier (interval 2) animates at 30 Hz.
- **Unreal:** URO skips evaluation for the whole component and interpolates the skipped frames (`Engine/Private/Animation/AnimInstanceProxy.cpp:773-783`; `ShouldInterpolateSkippedFrames`). **Godot:** has no automatic skipping, so on this point we are ahead of Godot.
- **Impact:** at 100 characters, about 70 % off-screen, roughly 0.1 ms wall is wasted. More important, a per-player evaluator could also cache key cursors and drop the per-bone graph walk, worth an estimated 2–4× on posed characters.
- **Fix:** (a) engine: an Animator-owned sampler. It evaluates per player over `Skeleton`'s ordered bone list, keeps a key cursor per slot, and writes Transforms. Bones then lose `AnimatedBy` so Bevy iterates nothing. Optionally lerp between the last two poses on skipped frames. (b) shroud, now: 6 enemies gain nothing from distance tiers, so set `AnimLod.distances` to about `[40,80,150]` and keep the off-screen skip.
- **Risk:** (a) is medium-high: it reimplements sampling, and Bevy clip events and morph curves would need ports. (b) is low.

### 4. GPU skinning repeats in every pass and view
- **Bevy:** skinning runs in the vertex shader of each pass (`bevy_pbr-0.19.1/src/render/mesh.wgsl:48`, `prepass/prepass.wgsl:79`). The prepass skins twice, once for the previous frame's motion vectors (`prepass.wgsl:153`). It skins again in every shadow view, and Shroud has up to about 25 (`map/look.rs:301-302`).
- **Godot:** skins once per frame in a compute pass (`servers/rendering/renderer_rd/shaders/skeleton.glsl`, pipeline at `storage_rd/mesh_storage.cpp:169-173`) and reuses the result in every pass. **Unreal:** the GPU Skin Cache (compute) also keeps previous positions for velocity.
- **Impact:** with 8.5k verts and roughly 1 + 2 + 6 skinning passes, 6 enemies cost under 0.05 ms GPU and 100 cost an estimated 0.5–1 ms.
- **Fix:** short term (engine `render_budget`): skinned meshes cast shadows only into sun cascades, not into lamp cubemaps. Long term: a compute pre-skin into per-instance vertex buffers, which needs a Bevy change or a custom mesh pipeline.
- **Risk:** low for the shadow rule, high for compute skinning.

### 5. Joint upload
- **Bevy:** `extract_skins` (`bevy_pbr/src/render/skin.rs:272-417`) runs serially during extract, does a random `GlobalTransform` lookup per joint, stores a 64-byte `Mat4` per joint, and re-uploads the whole staging buffer every frame (`skin.rs:235-240`). LOD does not reduce GPU skinning (ANIM.md, Known limits).
- **Unreal:** uploads 3×4 bone matrices (48 B) only for visible LODs, and drops bones per skeletal-mesh LOD.
- **Impact:** at 100×65 joints, about 0.1–0.2 ms of extract (which stalls the main world) and 416 KB per frame. 6 enemies: negligible.
- **Fix:** Bevy change (parallel extract, 3×4 matrices). Low priority.

### 6. No texture streaming, no mip drop, no upload throttle
- **Us:** Shroud's cooked path is good. It ships 48 KTX2 files (BC7 sRGB / BC5, 11 mips, zstd) loaded `RENDER_WORLD`-only (`engine/src/gfx.rs:631-659`), so there is no CPU copy. Every mip stays resident (about 67 MB GPU). `RenderAssetBytesPerFrame` is set nowhere, so a map load uploads everything in one frame. zstd only reaches 1.45× on BC data (46 MB on disk), and `zstd_rust` decodes slowly.
- **Unreal:** works out wanted mips from per-view screen size (`Engine/Private/Streaming/AsyncTextureStreaming.cpp:83-107`) under a pool budget (`StreamingManagerTexture.cpp:173`). **Godot 4.4:** no streaming; we match it here.
- **Impact:** dropping the top mip on the Low tier takes GPU memory from 67 to 17 MB and cuts upload and decode 4× (load-time win). A per-frame upload cap removes spikes from cell streaming.
- **Fix (engine):** a `TextureQuality` setting that skips the top N KTX2 levels at load; a `RenderAssetBytesPerFrame` budget in gameplay; consider `zstd_c` (about 3× faster decode). The `ktx2` feature already recompiles Bevy, so this costs nothing extra. Mip residency by screen size for `world/` comes later.
- **Risk:** low.

### 7. Main-thread mip building in the JPG fallback
- **Us:** `generate_mips` and `build_mips` (`gfx.rs:700-766`, copied at `shroud/crates/game/src/gfx.rs:~160`) run in `Update`, call `powf` per channel, clone the base image, and keep the default MAIN_WORLD copy. Rough maps are stored as 4-channel RGBA8.
- **Unreal:** builds offline into the DDC (`Engine/Private/TextureDerivedData.cpp`). **Godot:** compresses to VRAM formats at import.
- **Impact:** an estimated 30–80 ms stall per 2K sRGB texture, plus 2× RAM. This affects dev and uncooked runs only.
- **Fix (engine):** do it in an async task or a loader `process` step, use a 4096-entry linear-to-sRGB LUT, load RENDER_WORLD.
- **Risk:** low.

### 8. Mesh data duplicated and uncompressed
- **Bevy:** the default `GltfLoaderSettings` keeps MAIN_WORLD mesh copies (`bevy_gltf loader/mod.rs:221-224`). Vertices are all f32 at about 64 B each, and the enemy carries an unused-looking `TEXCOORD_1`. `KHR_mesh_quantization` is unsupported (`bevy_gltf lib.rs:116`).
- **Unreal and Godot:** pack to about 32 B per vertex (octahedral or packed normals, 16-bit UVs, 8-bit weights).
- **Impact:** small for Shroud (0.55 MB). Matters for vertex fetch at 100 characters times many passes.
- **Fix:** strip unused attributes in the GLB cook (shroud). Try `load_meshes: RENDER_WORLD` (check dynamic skinned bounds first). Packed formats need a Bevy change.
- **Risk:** low to medium.

IK and root motion: walking ancestors in `world_of` (`anim/ik.rs:189-204`) is O(depth) per call and single-threaded. ANIM.md measures it at 150 µs per 309 characters. Not a priority.

## Matched benchmarks (engine vs Godot 4.4)

**A. `anim_glb_N`: N skinned characters.** Use Shroud's enemy.glb (Quaternius, CC0, so the Godot project can ship it too) with N = 6, 100 and 500 on a 2 m grid and a fixed camera. Each character runs a base 1D blend (Walk/Jog/Sprint, speed driven by a sine) plus an upper-body override aim blend (Down/Neutral/Up) masked at `spine_01`. Sun with 4 cascades, 1080p, uncapped.
- Engine: add `--glb <path>` to `examples/anim_demo.rs` and a perf_suite scene `anim_glb` with variants `lod=on/off` and `cam=crowd/lineup`. Record `anim.eval`, `anim.advance_us`, `anim.post_us`, `gpu.frame_ms`, `mem.footprint_mb`.
- Godot: one AnimationTree per character (BlendSpace1D, plus a Blend2 with a bone filter), the same camera and lights. Record `Performance.TIME_PROCESS`, the profiler's AnimationTree time, GPU time from the Metal frame capture, and static memory.
- Report µs per character for CPU and ms for GPU at each N.

**B. `cold_load_M`: cold load of M textures.** Use 16 PBR sets (48 textures: BC7/BC5 1K KTX2 on our side, VRAM-compressed `.ctex` imports in Godot) plus enemy.glb. Purge the OS cache with `sudo purge`, then launch.
- Measure: time to the first frame with every material resident, the worst frame in the first 5 s, peak RSS, and GPU allocated.
- Engine: `play.py` steps `{"sleep":…}` then `perf.stats` and `metrics.*`. Run variants with the top mip dropped and with `RenderAssetBytesPerFrame` set.
- Godot: `--print-fps` plus `OS.get_ticks_msec()` at `_ready` and on the first drawn frame.
