# Gameplay framework, data and pipeline: engine vs Unreal Engine 5.8

Read-only audit. Date 2026-11-03. Engine: `/Users/himanshu/codes/game/engine` (branch `editor`, Bevy 0.20.1 + avian3d 0.8). UE reference: the sparse 5.8.4 tree at `/Users/himanshu/codes/game/refs/UnrealEngine`, checked with `git ls-tree` (module and plugin existence, class lists). UE behaviour descriptions come from knowledge, not from reading UE source line by line. Builds on `docs/COMPARE.md` and `docs/audits/{ai,anim_assets,physics,scheduling}.md`, which cover rendering, physics, perf, nav and animation internals; this document does not repeat them.

Target user: a solo dev shipping open-world driving and action games on macOS and Windows (Shroud, Courier, Pacenote exist as test cases). Priority is scored for that user, not for a generic studio.

Scale: Effort S = days, M = 1-2 weeks, L = 3-6 weeks, XL = 2+ months. Priority P0 = blocks shipping or repeated game rework, P1 = clear productivity or quality win, P2 = nice to have, P3 = skip.

## 0. Summary position

- The engine is strong where UE is weakest for a solo, agent-driven workflow: control port + MCP over everything (`ecs.*`, `engine.commands`), headless `Scenario` tests, JSON replay, golden images, perf budgets, readable JSON saves, text-only levels/graphs/scripts that diff in git. UE 5.8 has started to close part of that gap (`Engine/Plugins/Experimental/ModelContextProtocol`, `ToolsetRegistry`, `AIAssistant` exist in the tree) but it is editor-centric and Experimental.
- The engine has no gameplay *framework*. There is no GameMode/GameState/PlayerController/Pawn/PlayerState/HUD layer, no damage/health/ability model, no tags, no data-table/curve layer, no spawn/respawn/checkpoint/session rules. Each game (Shroud `Health`, Pacenote `Damage` in `src/vehicle.rs`, Courier bike) reinvents them. This is the largest gap that costs a solo dev real time, and the cheapest to fix in Bevy-idiomatic form.
- Next largest: vehicles/character movement as engine modules (only `fps.rs` and `chase.rs` exist; Pacenote's car sim lives in the game), cinematics/sequencer, UI binding and screen stack, localization depth, content cooking/packaging as an engine feature (Pacenote has per-game `packaging/`), and runtime asset import.
- Do NOT replicate: Blueprints VM, UObject reflection/GC, the Actor/Component class hierarchy, Slate/UMG visual designer, Gauntlet, Horde, DDC server, Verse, Live Coding, Python scripting in-editor. See §1 "Better than UE, don't copy down".

## 1. Gap table by area

Ours = file refs and commands. "Gap" is what UE has that we lack and a game would plausibly need.

### 1.1 Gameplay framework

| # | Area | UE 5.8 | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 1 | Game rules (GameMode/GameModeBase, GameState, match states, `GameSession`) | `Engine/Classes/GameFramework/GameMode.h`, `GameState.h`: match state machine (WaitingToStart, InProgress, ...), spawn rules, rules replicated through GameState | `flow.rs`: `AppState` Boot/MainMenu/InGame, `PauseAllowed`; games define their own `SubStates` (flow.rs header). No rules object | No standard "round/stage/match" state machine, no spawn-point selection, no rules resource replicated to clients | P1 | S | none. Thin `GameRules` resource + `MatchState` SubStates + `PlayerStart` marker; replicates via existing `net` |
| 2 | Player/pawn model (PlayerController, Pawn, PlayerState, possession, local players) | `Controller.h`, `PlayerController.h`, `Pawn.h`, `PlayerState.h`, `PlayerStart.h`, `SpectatorPawn.h`; possess/unpossess, per-player state, split-screen | `fps.rs` FPS controller, `chase.rs` chase camera; `net::NetOwner(ClientId)`; `LocalInput<I>`; actions are one global `ActionState` (docs/ACTIONS.md "Multiplayer device assignment not built") | No Possession (controller entity drives a pawn entity, swap vehicle/on-foot), no per-player action state, no `PlayerState` (score, name, ping), no local split-screen | P1 | M | actions; fits as components `Controller{pawn}` / `Possessed{by}`. Split-screen P3 |
| 3 | Character movement | `Character.h` + `CharacterMovementComponent` (walk/fall/swim, networked prediction), Mover plugin (`Experimental/Mover`, ChaosMover) | `fps.rs`: kinematic collide-and-slide + mouse look. Nothing for third-person characters | No third-person character controller (slopes, steps, coyote time, jump, crouch, ledge), no movement-mode machine, no root-motion-driven mode (`anim::root_motion` exists) | P1 | M | physics, anim, optional net `predict` |
| 4 | Vehicles | `Experimental/ChaosVehiclesPlugin`, `ChaosModularVehicle`, Mover | None in engine. Pacenote has a full sim in `pacenote/src/vehicle.rs` (raycast suspension, Pacejka, ABS, gearbox, `Damage`); Courier has `bike::drive` | Driving games are the stated target and the vehicle layer is per-game. Needs an engine `vehicle` module: wheel raycast, tyre model trait, drivetrain, damage hooks, replay-safe determinism | P0 | L | physics; extract from Pacenote, keep pure/deterministic like it is now; `net::predict` needs pure step (already how Pacenote is written) |
| 5 | Subsystems (World/GameInstance/LocalPlayer/Engine subsystem lifecycle) | `USubsystem` families with automatic init/deinit | Bevy `Plugin` + `Resource` + `States`. Equivalent and simpler | None. Do not replicate | - | - | - |
| 6 | HUD / camera manager | `HUD.h`, `PlayerCameraManager`, `Cameras/GameplayCameras` plugin (camera rigs, blends, shake) | `chase.rs` `ChaseCamera`; UI kit HUD per game; `look` lens/exposure | No camera stack (priority-blended virtual cameras: chase -> cutscene -> photo mode), no camera shake/modifiers, no FOV-by-speed standard rig | P1 | M | `chase.rs`; also unlocks cinematics (#25) |
| 7 | Damage, health, death, respawn, checkpoints | `DamageType.h`, `TakeDamage` pipeline, `KillZVolume`, `PainCausingVolume`, `PlayerStart` | Ad hoc per game. grep: only `fps.rs` / `net/registry.rs` mention Health | No shared `Health`/`DamageEvent`/`Died` messages, no kill volumes, no respawn/checkpoint resource, no hit-reaction hook into anim/vfx/sound | P0 | S | none. Small module `gameplay::damage`, `gameplay::checkpoint`; hooks via Bevy messages |
| 8 | Gameplay Ability System | `Runtime/GameplayAbilities`: abilities, effects (duration/periodic/stacking), attribute sets, cues, prediction keys, tags, replication | None | A full GAS is a huge UE feature. A solo racing/action dev needs ~20% of it: attributes with modifiers, timed effects (buff/debuff, DoT, cooldown), and cues (vfx/sound) | P2 (lite P1 for action games) | L for lite (M for attribute+effect core) | tags (#8), damage (#7), vfx/sound cues exist (`sound::SoundCue`, `vfx::Vfx::play`). Do NOT clone the full GAS |
| 9 | Gameplay Tags | `Source/Runtime/GameplayTags`: hierarchical `A.B.C` tags, containers, queries, data-driven registry, replication by index | None (grep: only `PlacementTag`-style, `world/prefab.rs`, spline tags) | No hierarchical tag type; strings or enums everywhere. Tags are the glue for abilities, AI, interaction, logic graphs | P1 | S | none. `Tag(u32)` interned from `a.b.c` strings, `TagSet`, `matches(parent)`; JSON/RON registry; reflect + logic-core `Value::Tag` |
| 10 | Interaction / pickups / triggers | `GameplayBehaviors`, `InteractionInterface`, volumes | `logic` `OverlapEnter/Exit` + `Set`/`Command`; avian sensors | Works for data-driven doors. No "interact prompt" standard (focus target, hold-to-use) | P2 | S | actions, ui toast |
| 11 | Spawn / pooling / prefabs | Actor spawn, `LightWeightInstances`, `InstancedActors`, Blueprint classes as templates | `world/prefab.rs` (scenery prefabs), `level` placeables, `pcg` | No generic data-driven "archetype" asset (spawn this bundle by name with overrides) outside world prefabs; no object pool API (GAME_GUIDE tells games to pool by hand) | P1 | M | level reflect format; `Archetype` RON = list of reflected components, `spawn_archetype("car/sedan")` |

### 1.2 Input

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 12 | Enhanced Input | `Plugins/EnhancedInput`: input actions as assets, mapping contexts with priorities, triggers (hold, tap, chorded, pulse), modifiers (dead zone, scale, swizzle, smoothing), per-player | `src/actions/` (map, binding, rebind, state, virtual_pad; docs/ACTIONS.md): contexts, gamepad, rebinding persisted, accessibility, `actions.*` commands, tests | Close to parity. Missing: trigger types beyond press/release (hold/tap/double/chord), per-player assignment, gyro/touch (out of scope), force feedback / haptics API, input-device property handles (light bar), glyphs per device for prompts | P1 (triggers, rumble, glyphs) | M | actions. Add `Trigger` enum + modifier chain, `Rumble` effect, device-glyph table for UI |

### 1.3 Data, saves, config

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 13 | Data Assets / Data Tables / Curve Tables / Data Registry | `DataAsset`, `DataTable` (CSV/JSON import, row structs), `CurveTable`, `Plugins/Runtime/DataRegistry` | JSON resources with hot reload: `hot_reload_json::<T>(WatchPath, ...)` (docs/DEVKIT.md); RON levels/graphs; `PcgCatalog` | No typed table asset with row-keyed lookup, schema check and import from CSV/spreadsheet; no `Curve` asset (engine RPM curve, difficulty scaling) with editor curve widget; no cross-file reference validation beyond `content.check` string refs | P1 | M | devkit `content.check`; `Table<T>` (RON/JSON/CSV) + `CurveAsset` (piecewise/ Hermite), reflect-registered so Details edit it, editor curve widget in editor-ui |
| 14 | SaveGame | `SaveGame.h`, `AsyncActionHandleSaveGame`, slots, platform cloud saves | `devkit/save.rs` (`SavePlugin<T>`, versioned migrations, atomic write, .bak, checksum, thumbnails, autosave; `save.*` commands) | Better than UE for integrity and diffability. Gaps: world-state snapshot (entities + `LevelEntity` reflect round-trip into a save, not only a game struct), cloud sync (Steam Cloud/iCloud) | P1 (world snapshot), P2 (cloud) | M | `level` reflect serialiser; Steam via game side |
| 15 | Config / project settings / device profiles | `GameUserSettings`, ini layering, `*DeviceProfileSelector` plugins, scalability groups | `settings.rs` + generated settings screen; quality presets + governor (`render_budget`) | Good for solo. Missing: device-class presets by GPU/CPU detection (e.g. Apple M1 vs M5 Pro, Windows iGPU) on first launch | P2 | S | `gfx::QualityPreset`, `perf_sys` |

### 1.4 UI

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 16 | UMG / Common UI / MVVM | UMG widgets, `CommonUI` (activatable widget stack, input routing, action bar), `ModelViewViewModel` (field-notify bindings) | `src/ui/`: theme, widgets, menus, `Focusable` nav, toasts, settings screen generated from `FieldDef`, `register_screen`, a11y (high contrast, colour filter, text scale), gamepad nav `NavQueue` | No screen *stack* with back/modal semantics and input-context switching per screen (games hand-roll), no data binding (HUD text from resource changes), no layout primitives for HUD (anchors, safe zone), no UI animation/transition tween, no virtualised list, no UI test helper beyond `ui/tests.rs` | P1 | M | actions (context per screen), l10n. Do not build a visual designer; ship `bevy_ui` + small binding macros |

### 1.5 Networking

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 17 | Replication core (Actor replication, `ReplicationGraph`, Iris, push model, dormancy, relevancy, priority) | `Experimental/Iris`, `Runtime/ReplicationGraph`, `Source/Runtime/Net` | `src/net/` ~5k lines: delta-compressed snapshots, relevancy radius + hysteresis, priority/bandwidth budgets, `AlwaysRelevant`, owner-only, protocol hash. Benchmarked: 64 clients x 500 entities in 3.5 ms (docs/NET.md) | Strong for scale it targets. Missing: hierarchy (`ChildOf`) replication, entity refs inside components, dormancy (static worlds already cheap), per-property conditions beyond owner-only (SkipOwner, InitialOnly), multi-threaded snapshot, spatial grid for relevancy (radius test is O(clients x entities)) | P2 | M | net |
| 18 | RPCs, prediction, rollback | RPCs (Server/Client/Multicast, reliable flags), CMC prediction, `NetworkPrediction`/`Mover` plugin, Network Prediction Insights | `add_net_message::<M>(Channel)`, `predict::<S,I>(step)` with rollback/replay, snapshot interpolation, lag compensation (`lagcomp.rs`) | Prediction requires a pure step function; **physics is not rolled back** (docs/NET.md "Known limits"). For driving games with avian bodies that is the real hole: predicted car sim must be pure (Pacenote's is). No visual error smoothing on correction | P1 (smoothing S, physics rollback L) | S / L | avian determinism; `predict` already generic |
| 19 | Dedicated server, listen server, travel, seamless travel | `-server`, `ServerTravel`, session flow | `--server`, `--host`, `--connect`; `net.host/connect`; headless boot | Missing: map change while connected (server `level.load` + clients follow), reconnect, server browser/matchmaking/relay/NAT punch (NET.md known limits), no auth/encryption (DTLS) | P1 (travel, encryption), P2 (matchmaking) | M | level, net |
| 20 | Online Subsystem / EOS / Steam | `Plugins/Online/*`: `OnlineSubsystemSteam`, `OnlineServicesEOS`, voice chat, `EOSShared`, auth, friends, achievements, lobbies | None in engine; Pacenote rolls own `net_session.rs` + `voice/` (cpal ADPCM) + `docs/STEAM.md` packaging | No platform services layer: achievements, stats, rich presence, cloud saves, lobbies/invites, leaderboards, entitlements (demo vs full). Steam is the only store that matters for macOS+Windows solo | P0 for a Steam release, otherwise P1 | M | `steamworks` crate (see §2); `Platform` trait with `Null` impl for tests |
| 21 | Replay system | `NetworkReplayStreaming` (demo recording, kismet replay) | `devkit` input replay (QA), Pacenote `ghost.rs` | No server-side demo recorder (record snapshots to file, play back with scrub). Ghost and input replay cover racing | P2 | L | net |

### 1.6 AI

Existing audit `docs/audits/ai.md` covers navmesh/crowd internals. Feature gaps:

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 22 | Behavior Trees + Blackboard | `AIModule` BT with decorators, services, observers, event-driven aborts | `ai/bt.rs`, `ai/blackboard.rs`: Rust-value trees with closures, `reactive_*`, `guard` | No blackboard observers/event aborts, no `on_halt`, no tree asset file (RON) editable in editor, no BT debugger view. docs/AI.md "Known limits" | P2 | M | editor graph canvas is reusable (Logic tab, `crates/editor-ui`) |
| 23 | StateTree | `Runtime/StateTree`, `GameplayStateTree`, property binding | `ai/utility.rs` (utility), `logic` graphs, Bevy `States` | A hierarchical state machine asset with transitions on events would unify AI + gameplay + anim state; we have 3 partial ones. Not urgent | P2 | L | logic-core |
| 24 | EQS (Environment Query) | `EnvironmentQueryEditor`, generators + tests + contexts | None. `NavQuery::random_point_around`, perception LOS rays | Cover/flank point selection, "find best spot" queries | P2 | M | nav, perception; implement as budgeted scored point sampler |
| 25 | Mass / MassEntity / MassAI / MassCrowd / ZoneGraph | `Source/Runtime/MassEntity`, `Plugins/AI/MassAI`, `MassCrowd`, `ZoneGraph` | Bevy ECS is already data-oriented; `ai/rvo.rs` ORCA crowds; `world` streaming | Not needed: Bevy ECS is Mass. Gap is *content*: lane graphs for ambient traffic and pedestrians on splines (Pacenote has traffic lanes, `spline` module has tags) | P1 for open-world driving (traffic on splines) | M | `spline`, `ai::NavAgent` `Manual` motion. Skip ZoneGraph clone: use spline + lane tags |
| 26 | Smart Objects | `Plugins/Runtime/SmartObjects`, `GameplayBehaviorSmartObjects` | None | Claimable world slots (bench, pump, charging pad) for NPC behaviours | P3 | M | tags |
| 27 | Navigation extras | NavMesh (Recast), nav areas/costs, dynamic obstacles, nav links, hierarchical pathfinding, `NavCorridor` | Own tiled Recast-style (rect polys), off-mesh links, incremental rebake | No area types/costs (road vs mud), no query filters, no HPA* for 10 km worlds. Known limits in docs/AI.md | P1 (areas for roads), P2 (HPA) | M | ai/nav |
| 28 | Perception | `AIPerception` (sight, hearing, damage, touch, team) | `ai/perception.rs` cone + LOS rays + noise memory | Missing vision falloff, team attitudes, damage/touch senses | P2 | S | tags/teams |
| 29 | Gameplay Debugger | `Source/Runtime/GameplayDebugger` | `ai/debug.rs`, `ai.*` commands, `ecs.*` | Equivalent in agent form. OK | - | - | - |

### 1.7 Cinematics, animation hooks

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 30 | Sequencer / Level Sequence / cinematic camera / Movie Render Queue | `MovieScene`, `LevelSequence`, `CinematicCamera`, `Plugins/MovieScene`, `MovieSceneCapture`, Take Recorder | Nothing. `ChaseCamera.active=false` "hands camera back (cutscenes)". `logic` `Delay` + `Set` could script a poor cutscene | No timeline asset (tracks: transform, property, camera cut, audio cue, vfx trigger, anim state, event), no scrubbing in editor, no offline render at fixed frame rate. Needed for intros, race replays, trailers (Steam page needs trailers) | P1 | L | camera stack (#6), `offscreen` capture exists (`devtools/offscreen.rs`), editor timeline panel. `Timeline` RON: tracks of keyed `Reflect` paths, reuse `Get/Set` path syntax from logic-core |
| 31 | Animation graph, Control Rig, IK, retarget, motion matching, UAF | `AnimGraphRuntime`, `ControlRig`, `FullBodyIK`, `UAF`, Pose Search | `src/anim/` state machines, blend spaces, layers, root motion, notifies, 2-bone + aim IK | See `docs/audits/anim_assets.md`, `docs/ANIM.md` limits (no retarget, no inertialization, no motion matching) | P2 | L+ | out of scope for this document |

### 1.8 Localization and accessibility

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 32 | Localization | `FText`, string tables, gather text, `.po`/XLIFF/CSV export-import, plural/gender, ICU formatting, `SubtitlesAndClosedCaptions`, CJK/RTL via HarfBuzz/ICU | `src/l10n/`: Fluent `.ftl` tables, `tr()/tr_args()`, pseudo-locale, `l10n.*`; English/German/French; Barlow Latin-only font | No CJK/RTL/shaping (HarfBuzz/ICU `ThirdParty` in UE), no locale-aware number/date/unit formatting, no export to translation vendors (XLIFF/CSV), no missing-key report in `content.check`, no font fallback chain. Fluent already handles plurals | P1 for CJK launch (China/Japan/Korea are big Steam markets for racing), else P2 | M | `cosmic-text` ships in Bevy already (shaping, bidi). Check Bevy 0.20 text stack for fallback fonts first. `fluent-bundle` formatting; `icu4x` for number/date (optional) |
| 33 | Accessibility | Screen reader (`ScreenReader`, `SlateScreenReader` experimental), `TextToSpeech`, subtitles/captions, colour-blind simulation, remappable input | Text scale, high contrast, colour filter (`ui/colorblind.rs`), captions (`sound`), rebinding, reduced motion options (verify), Pacenote TTS (`codriver/speech.rs`) | Missing: screen-reader/TTS for menus (AccessKit via `bevy_a11y` exists in Bevy; check wiring), hold-to-toggle options, one-handed presets, caption direction (front/back, SOUND.md limit) | P2 | S-M | `bevy_a11y`/AccessKit already in Bevy (verify wiring) |

### 1.9 Asset pipeline

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 34 | Import (FBX, glTF, USD, Interchange) | `Plugins/Interchange` (774 files in Runtime), `USDCore` (2489 files), Datasmith, Alembic | glTF/GLB via Bevy; `assets.py import` unpacks zips and keeps glTF/images; FBX/OBJ only if `FBX2glTF`/`obj2gltf` on PATH; `crates/uasset` reader spike on branch `spike-uasset` (placement, textures; meshes need an Oodle decoder), not merged | No import-settings sidecars (scale, axis, material remap, LOD generation, collision generation, pivot), no re-import with change detection, no FBX/USD reader. glTF-only is a fair stance for a solo dev: Blender exports glTF | P1 (sidecar `.import.ron`: scale/collider/LOD/material map; automatic LOD + collision generation), P3 (FBX/USD native) | M | `meshkit`, HLOD vertex clustering in `world`. `meshopt` crate for LOD |
| 35 | Cook (textures, meshes, shaders, audio), DDC | Cooker, Derived Data Cache (local/shared/cloud), shader compile cache, Oodle | `tools/cook` BC7/BC5 KTX2 with skip-if-newer; `scripts/cook.py`; `cook-manifest.json` sha256; Pacenote `tools/audio/cook_car.py` | Texture-only cooker. No: mesh cooking (meshlet/simplified collision/LOD), audio transcode (Opus/Vorbis), ASTC for Apple (docs say BC on desktop; macOS GPUs support BC but iOS needs ASTC), a content-hash cache shared between worktrees (agents running parallel worktrees re-cook), one `cook` command for all kinds. Shader precompile cache is Bevy/wgpu side | P1 (unified `cook` with hash cache keyed by content + settings) | M | `tools/cook`, ktx2 feature. Hash cache dir shared across worktrees via config |
| 36 | Pak / IoStore / chunking / patching / DLC / mod mount | `PakFile`, IoStore containers (Zen), `ChunkDownloader`, `HTTPChunkInstaller`, `PlatformDLC`, `GameFeatures`, Oodle compression, signing | Loose `assets/` folder copied by `package.sh`, `MANIFEST.sha256`, reproducible `tar.gz`. Steam does delta patching (SteamPipe) | No archive format: loose files hurt cold-start I/O on Windows (Defender scan per file) and allow trivial asset tampering. No mounting of additional content roots (DLC, mods, language packs) | P1 (single-file pack with index, mmap, zstd per asset; Bevy `AssetSource`) | M | Bevy `AssetSource` registration (`bevy_asset` supports custom sources). Own `.pak`: a manifest + zstd blobs, 400 lines |
| 37 | Hot reload / live edit | Hot reload, Live Coding (C++ patch), asset reload, PIE | JSON + scripts hot reload, `devkit.reload`, optional `hot_reload` (Bevy watcher), editor Play/Stop | Rust code requires rebuild+restart (Rust has no stable live-code story). Mitigate with `ruspy` logic for tuning + scenario tests | P3 (accept) | - | - |
| 38 | Asset registry / references / validation | `AssetRegistry`, reference viewer, redirectors, size map, audit | `content.check` string-literal refs, `unreferenced` info, licence ledger `LICENSES.json` | Our licence ledger is ahead of UE for solo legal hygiene. Missing: a real dependency graph (who uses this texture), rename-with-fix-up | P2 | M | `content.check`, editor asset browser |

### 1.10 Packaging, distribution, platforms

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 39 | Per-platform packaging (macOS/Windows/Linux/iOS/consoles), signing, notarization, installers | UAT `BuildCookRun`, `-package`, Mac `.app` + codesign + notarize, Windows `.exe` + signtool, installers, console SDKs under NDA | `scripts/package.sh` (host build, strip, thin LTO, reproducible tarball, `MANIFEST.sha256`, ashlar leak check). **Pacenote** `packaging/{macos,windows,steam}`: universal `.app`, Developer ID + notarization, cargo-xwin cross-compile from Mac, VDF upload | Works but lives in the game repo, copy-pasted per game. Missing in engine: `package.sh --platform {mac,win}`, universal binary step, `Info.plist`/entitlements templates, Windows icon+version resource, Authenticode signing hook, MSIX/installer (optional), crash symbol archive (dSYM/PDB) upload, Linux/Steam Deck target | P0 (lift Pacenote's scripts into `engine/scripts/` parametrised by manifest) | M | Pacenote scripts; `cargo-xwin`, `codesign`, `notarytool`; Windows signing needs a cert (budget) |
| 40 | Steam / store integration | `OnlineSubsystemSteam`, Steam Input, overlay | Pacenote `docs/STEAM.md` is process-only, no SDK code seen | See row 20 | P0 | M | row 20 |
| 41 | Build farm / CI / distributed builds | Horde, UBA, FASTBuild controllers | `memgate` queueing; local builds | Solo dev: GitHub Actions on `macos-latest` + `windows-latest` running `check --no-default-features`, tests, `package.sh --dry-run`. A matrix is missing (Windows builds are only cross-compiled from Mac, never executed) | P0 (Windows run-test on real Windows CI) | S | GitHub Actions; headless tests need no GPU |

### 1.11 Testing, profiling, diagnostics

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 42 | Automation / functional tests / Gauntlet / screenshot comparison | `AutomationTest`, `AutomationController`, Functional Tests in-level, `Experimental/Gauntlet`, Screenshot Comparison, `PerfCounters`, `AutomatedPerfTesting` | `Scenario` (headless, 60 Hz fixed), `assert_json_snapshot`, golden images (`ENGINE_BLESS=1`), `PerfBudget`, `play.py`, `net_play.py`, `perf_suite.py`, `bench.py` | **Better than UE for a solo dev** (see §1 note below). Gaps: no soak/leak test harness (run 30 min, assert RSS slope), no input-fuzz ("monkey") runner on top of replay, no CI wiring for GPU golden images (macOS runners have Metal) | P2 | S | `devkit` |
| 43 | Profiling (Insights, `stat`, memory reports, CSV profiler, GPU visualizer, LLM) | Unreal Insights (`TraceLog`), `stat unit/gpu`, `memreport`, CSV Profiler, `ChaosInsights`, `IoStoreInsights`, `WorldStreamingInsights`, LLM memory tags | `perf.stats`, metrics window + history + runs table, F3 overlay, `profile_scope!`, Tracy via `profile` feature, GPU pass timings, session logs jsonl, `CountingAlloc`, `bench.py compare` | Excellent for frame time. Missing: memory attribution by tag (LLM equivalent: textures vs meshes vs audio vs nav), per-system timings in dev builds without Tracy (known limit), asset-level GPU memory report, hitch attribution (which system/stream) | P1 | M | `devkit::profile`, Bevy diagnostics; custom alloc tag counters on top of `CountingAlloc` |
| 44 | Crash reporting | `CrashReportClient`, minidumps, Crash Reporter backend, symbol server | `trace.rs` via `ashlar-trace`: panic hook report, hang watchdog, hitch events, privacy-notice gate, `--crash-test` | Panics and hangs only; **native crashes (segfault/GPU driver/abort)** produce no report; no minidump/symbolication (needs dSYM/PDB archive); no breadcrumbs of last N log lines/game state attached | P1 | M | `crash-handler`+`minidumper` crates (§2), symbol upload in packaging |
| 45 | Analytics / telemetry | `Analytics` module, `StudioTelemetry`, `RuntimeTelemetry` | `trace_event` + `declare_trace_events`; Pacenote `telemetry.rs` + analysis scripts + server (MarlStudio) | Already workable. Missing: sampling/consent UI standard component (Settings > Privacy done per-game), offline queue persistence | P2 | S | trace |

### 1.12 Scripting, modding, extension

| # | Area | UE | Ours | Gap | Pri | Eff | Deps |
|---|---|---|---|---|---|---|---|
| 46 | Blueprints VM / Verse / Python | Blueprint VM (bytecode, debugger, 300+ node categories), Verse (new, `VerseCompiler`), `PythonScriptPlugin` (editor only) | `logic-core` graphs: typed pins, compile errors on nodes, vars, fire trace, minidiagram, `ruspy` scripts (step budget 200k, hot reload, diagnostics) | **Better in the ways that matter** for agent workflows: text RON graphs, located diagnostics, `logic.fire trace:true`, no crash on error. Gaps are scope: no functions/subgraphs (macros), no custom events with args, no struct/array/map types beyond JSON, no latent nodes besides `Delay` (e.g. WaitForEvent, MoveTo), no debugger breakpoints, ruspy has no module imports | P1 (subgraphs/functions + latent `Wait` nodes), P2 (breakpoints) | M | logic-core |
| 47 | Plugins / Game Features / modding | `.uplugin`, `GameFeatures` (runtime-activated modules), `ModularGameplay`, Mod.io/UGC | Rust crates + Cargo features | No data-mod loading: external content roots, JSON/RON/ruspy mods without recompiling (ruspy + logic graphs + archetypes are exactly the safe-mod surface). Sandboxed because ruspy has step limits. This is a differentiator opportunity | P2 (P1 if modding is a goal) | M | pak mount (#36), archetypes (#11), tags, `Table<T>` (#13) |
| 48 | Live Coding | Windows only C++ patching | None | Don't replicate | P3 | - | - |

### 1.13 Editor-adjacent (covered by other audit, listed for completeness)

Level editor, world tools and details panel are in `docs/EDITOR.md`, `docs/EDITOR_AUDIT.md`. Not repeated here.

## 2. Where our design is already better; do not "replicate" downward

1. **Agent-drivable everything.** Control port + MCP expose `ecs.*`, `engine.commands`, screenshots, `time.step`, `input.*`, per-module commands. UE needs editor + Python remote execution or the new Experimental MCP plugin for part of it. Keep investing; make every new module (tags, damage, vehicle, timeline) expose `*.list/get/set` commands and a headless test.
2. **Headless deterministic tests.** `Scenario` at fixed 60 Hz with JSON snapshots and loopback net beats UE Automation for setup cost. Don't build a Gauntlet or a test-controller service; add a soak mode and CI.
3. **Text-only assets.** Levels `.level.ron`, graphs `.logic.ron`, `.ruspy`, save JSON with checksum, `LICENSES.json` ledger: all diffable, mergeable and reviewable by an agent. UE `.uasset/.umap` binaries need the editor to diff. Keep new assets (tags, tables, timelines, archetypes) text-first; compile to binary only in the pak (cook) step.
4. **Logic diagnostics.** Graph/script errors never crash and are located by node id / line:col. Blueprint compile errors are in-editor only.
5. **Net stack cost and testing.** 5k lines, protocol hash handshake, conditioner, deterministic tests. UE netcode is far bigger; match features selectively (see rows 17-19), not architecture.
6. **Perf budgets and governor.** Real-GPU-sample governor with game levers and `QualityChanged` toasts, plus governors for streaming. UE has scalability groups but no closed loop by default.
7. **Reproducible ship builds + leak check.** `package.sh` refuses builds that contain `ashlar-*` (debug port). UE shipping config strips cheats but there is no equivalent hard check.
8. **No UObject/GC/Blueprint class hierarchy.** Bevy components + messages + states replace Actor/Component/GameMode inheritance. The gameplay layer proposed here must stay as small ECS modules and resources, not a class hierarchy.

## 3. Bevy/ecosystem crates versus writing our own

Rules from AGENTS.md: prefer small own code; never a second Bevy or wgpu. **Compatibility with Bevy 0.20 is unverified for every crate below**: my web search found no source confirming 0.20 support for any of them (Lightyear's docs.rs page pairs 0.30 with Bevy 0.19; see https://docs.rs/crate/lightyear/0.30.0). Check each crate's `Cargo.toml` `bevy` requirement and `cargo tree -d` for a duplicate `bevy` before adopting. Licences are from memory; re-check at adoption.

| Need | Candidate | Licence (verify) | Bevy 0.20 | Quality / note | Recommendation |
|---|---|---|---|---|---|
| Input triggers/modifiers | `bevy_enhanced_input` | MIT/Apache | unverified | Mature API modelled on UE Enhanced Input; but `src/actions/` already owns rebinding, persistence, a11y, tests | Own: add triggers to `actions` (S-M). Study the crate's trigger set only |
| Input alt | `leafwing-input-manager` | MIT/Apache | unverified | Popular; overlaps with `actions` | Skip |
| Replication | `bevy_replicon`, `lightyear` | MIT/Apache | lightyear tracks Bevy 0.19 as of docs.rs 0.30 | Large, general; we already have a tested 5k-line stack with budgets and prediction | Skip; reuse ideas (entity refs remap) |
| Transport encryption | `quinn` (QUIC) or `snow`/`chacha20poly1305` | MIT/Apache | n/a (not Bevy) | QUIC gives encryption + reliability, but pulls tokio-free rustls stack; `snow` Noise on the existing UDP is smaller | Own: Noise-IK over existing channels via `snow` (S-M) |
| Platform services | `steamworks` (steamworks-rs) | MIT/Apache | n/a (not Bevy) | Wraps Valve SDK (redistributable DLL/dylib needed, Steamworks SDK terms apply). macOS+Windows supported | Use, behind an engine `Platform` trait, Null impl default |
| Crash handling | `crash-handler` + `minidumper` (Embark) | MIT/Apache | n/a | Out-of-process minidump writer; works on macOS and Windows | Use inside `trace` (M); needs symbol archive step |
| Archive/pack | `zstd` (already via Bevy `zstd_rust` feature), own container | n/a | n/a | Own format is ~400 lines; avoid `zip` | Own |
| Mesh LOD/collision gen | `meshopt` (meshopt-rs), `parry3d` convex hulls via avian `Collider::convex_decomposition` (VHACD) | MIT | n/a | `meshopt` is the standard simplifier; engine HLOD uses own vertex clustering | Use `meshopt` in cook step only (not in game binary) |
| Texture cook | existing `tools/cook` with ISPC | - | - | Done | Keep; add ASTC via `astc-encoder` only if iOS ever matters |
| Audio | Bevy audio / rodio via `sound` module; `kira`, `bevy_seedling` (Firewheel) | MIT/Apache | unverified | `src/sound/` has buses, ducking, cues, captions already | Keep own; revisit only if HRTF/5.1 needed (SOUND.md limits) |
| Text shaping / CJK / RTL | `cosmic-text` (in Bevy), `fluent`, `icu4x` | MIT/Apache, Unicode | via Bevy | Shaping/bidi come with Bevy text; the missing piece is fonts and fallback | Use Bevy's; add Noto CJK as an optional cooked font pack; `icu_decimal`/`icu_datetime` for formatting |
| Accessibility | `accesskit` via `bevy_a11y` | MIT/Apache | in Bevy | Screen reader on macOS (VoiceOver) and Windows (Narrator) | Use Bevy's; wire menu nodes |
| Tags | `bevy_gameplay_tags`-style crates (several small, low adoption) | various | unverified | Low maintenance risk is high; the feature is ~300 lines | Own |
| Abilities | community GAS-like crates (immature) | - | - | Skip | Own, lite |
| Timeline | `bevy_animation` curves (in Bevy) | MIT/Apache | in Bevy | Bevy `AnimatableCurve` and `AnimationClip` can animate component fields; reuse for property tracks | Own `Timeline` asset on top of Bevy curve types |
| Vehicle | avian3d raycasts (existing); `bevy_rapier` has a vehicle controller but is a second physics engine | - | - | Do not add Rapier | Own, extracted from Pacenote |
| Behaviour trees | `bevy_behave`, `beet` | MIT/Apache | unverified | Own BT exists | Skip |
| Navmesh | `oxidized_navigation`, `vleue_navigator` | MIT/Apache | unverified | Own Recast-style bake exists and is benchmarked | Skip |
| Scripting | `ruspy` (own), `rhai`, `mlua` | - | - | ruspy is the owner's language | Keep |
| Windows signing/installer | `cargo-xwin`, `osslsigncode`, `cargo-wix`, `cargo-bundle`, `create-dmg` | various | n/a | Packaging tools, not linked | Use in scripts |
| CI | GitHub Actions `macos-14`, `windows-latest` | - | - | Free minutes limited for private repos; Bevy builds are long, use `sccache`/cache | Use |

## 4. Phased roadmap

Each work package (WP) lists owned files so agents in separate worktrees do not collide. All WPs follow AGENTS.md: feature-gated, config structs with `Default`, control commands under a module prefix, unit + scenario tests, doc in `docs/`, `cargo check --no-default-features` stays green. Registration of types for the inspector and level files is part of every WP.

### Phase 1 (2-3 weeks): shared gameplay core and a shippable pipeline

| WP | Content | Owned paths | Acceptance checks |
|---|---|---|---|
| P1-A `gameplay::tags` (#9) | `Tag`, `TagSet`, hierarchical match, registry file `assets/tags.ron`, reflect + serde, `logic-core` `Value::Tag` (optional), `tags.list` | `src/gameplay/tags.rs`, `docs/GAMEPLAY.md` (new), `tests/gameplay.rs` | Unit: parent match `Vehicle.Car` matches `Vehicle`; unknown tag in file -> located diagnostic; round-trip in a level file; `cargo check --no-default-features` passes |
| P1-B `gameplay::damage` + `checkpoint` + `respawn` (#7, #1) | `Health`, `DamageEvent`, `Died`, kill volumes, `PlayerStart`, `Checkpoint`, `Respawn` with fade/toast, `GameRules`/`MatchState` SubStates | `src/gameplay/{damage,spawn,rules}.rs` | Scenario: damage -> died message -> respawn at last checkpoint, state snapshot; Pacenote's `Damage` can be rebased on it later without regression (its tests still pass) |
| P1-C Pawn/controller split (#2) | `Controller{pawn}`, `Possess` command, per-controller input (single local player first), `PlayerState` component | `src/gameplay/controller.rs`, hook in `src/actions/state.rs` | Scenario: possess car, drive, exit, possess character; `net` replicates `PlayerState` |
| P1-D `package.sh` multi-platform (#39, #41) | Lift Pacenote `packaging/{macos,windows}` into `engine/scripts/package/`, parametrise by manifest/package/bin; universal `.app`, notarize hook, Windows icon+version, symbol archive (dSYM/PDB), `--platform` | `scripts/package.sh`, `scripts/package/**` | Dry-run prints plan on both; Pacenote builds via engine scripts and output hash equals prior build (reproducibility); notarization verified on a real build |
| P1-E CI matrix (#41) | GitHub Actions: macOS + Windows run `cargo check --no-default-features`, `cargo test --lib`, headless `Scenario` tests, `package.sh --dry-run` | `.github/workflows/ci.yml` | A deliberate Windows-only break (path separator) fails CI |
| P1-F Native crash capture (#44) | `crash-handler`+`minidumper` in `trace`, last-N-log-lines breadcrumbs, dump upload via ashlar-trace, symbol upload in P1-D | `src/trace.rs`, `src/crash.rs` | `--crash-test=segv` produces a minidump on macOS and Windows; symbolicated stack names the crash function |
| P1-G Vehicle module extraction, step 1 (#4) | Pure `vehicle` core crate (`crates/vehicle-core`, Bevy-free): wheel raycast suspension trait, tyre model trait (Pacejka impl), drivetrain, ABS/TCS; engine adapter `src/vehicle/` | `crates/vehicle-core`, `src/vehicle/`, `docs/VEHICLE.md` | Pacenote's `handling_tests.rs` pass against the extracted core with identical numbers (golden snapshot); deterministic replay identical across two runs |

### Phase 2 (about 4-6 weeks): data layer, UI, platform services, tooling

| WP | Content | Owned paths | Acceptance checks |
|---|---|---|---|
| P2-A Data tables and curves (#13) | `Table<T>` RON/JSON/CSV with row keys, schema errors with file:line, `CurveAsset`, hot reload, `content.check` cross-ref validation, editor curve widget | `src/data/`, `crates/editor-ui/src/curve.rs` | Edit a CSV row while the game runs -> value changes next frame; bad row key reported by `content.check` |
| P2-B Archetypes (#11) | `*.archetype.ron` = reflected component list + children + tags; `spawn_archetype`; pooling API; Place palette integration | `src/archetype/`, `src/level/placeable.rs` | Spawn from file with overrides; level save/load round-trip; pool reuse shows 0 allocations in `CountingAlloc` budget |
| P2-C `Platform` trait + Steam (#20, #40) | achievements, stats, rich presence, cloud save hook, entitlements (demo/full), overlay-safe; `Null` impl for tests; `steamworks` behind feature `steam` | `src/platform/` | Null: scenario unlocks achievement; Steam: manual checklist on macOS and Windows |
| P2-D UI screen stack and binding (#16) | `ScreenStack` (push/pop/modal, input context per screen), `Bind<T>` for HUD text/visibility from resources, safe zone anchors, UI tween | `src/ui/stack.rs`, `src/ui/bind.rs` | Pause menu opens settings and back works with pad and keyboard in scenario; binding updates only on change (system run counts in `ecs.systems`) |
| P2-E Input upgrades (#12) | Triggers (hold/tap/double/chord), rumble, device glyphs, per-player action state | `src/actions/` | Hold trigger test at 60 Hz; glyph table switches on gamepad detect |
| P2-F Camera stack and Timeline v1 (#6, #30) | Virtual camera stack with priority blends and shake; `*.timeline.ron` with camera-cut, transform/property, cue, event tracks; play/pause/scrub commands; fixed-fps offscreen render to PNG sequence | `src/camera/`, `src/timeline/`, `docs/TIMELINE.md` | A 10 s intro plays and scrubbing to t=5 s equals frame 300 of normal play (golden image); render-to-PNG deterministic |
| P2-G Pak format (#36) | `.pak` writer in `tools/cook` flow, Bevy `AssetSource` reader (mmap, zstd), extra mount roots, signature check optional | `src/pak/`, `tools/cook` | Game runs from pak with loose assets removed; cold start not slower; tampered pak refused |
| P2-H Unified cook and import settings (#34, #35) | `engine cook` command: textures, meshes (LOD via `meshopt`, collision), audio, content-hash cache shared across worktrees; `*.import.ron` sidecars | `tools/cook`, `scripts/cook.py` | Second cook is a no-op; changing the sidecar re-cooks one asset |
| P2-I Memory tags and hitch attribution (#43) | Tagged allocation counters (textures, meshes, audio, nav, ecs), per-system hitch log in dev builds, `mem.report` command | `src/devkit/profile.rs`, `src/devtools/metrics*.rs` | `mem.report` totals within 5% of RSS in a known scene; hitch event names the system |
| P2-J Logic upgrades (#46) | Subgraph/function nodes, custom events with args, latent `WaitFor(Message)`, breakpoints in `logic.fire` | `crates/logic-core`, `src/logic/` | Existing graphs load unchanged; recursion limit diagnostic |
| P2-K Nav areas, traffic lanes (#27, #25) | Area types/costs in navmesh; `TrafficLane` on splines with spawn/despawn around the player and lane-following agents | `src/ai/nav/`, `src/ai/traffic.rs` | Agents prefer road over mud in test; 200 cars on lanes within budget, `ai.agents` shows them |

### Phase 3 (quarter): depth and reach

| WP | Content | Acceptance |
|---|---|---|
| P3-A Ability lite (#8) | `Attributes` with modifier stack, `Effect` (duration/period/stack), `Cue` mapped to sound/vfx, tag-gated; net replicate | Scenario: buff stacks, expires, replicated; no per-frame allocation |
| P3-B Netcode: travel, encryption, smoothing, physics-aware prediction (#18, #19) | `net.travel`, Noise handshake, visual error smoothing, rollback helper for avian bodies via stored state snapshot | Two-client loopback test with 100 ms and 5% loss shows no desync over 60 s with cars |
| P3-C CJK and locale formatting (#32) | Font fallback chain, optional Noto pack, number/date formatting, XLIFF/CSV export, missing-key `content.check` | Pseudo CJK locale renders in settings screen golden image |
| P3-D BT/StateTree/EQS (#22-24) | Blackboard observers, tree assets, EQS sampler | Cover-point query returns same top-3 in deterministic test |
| P3-E World-state saves, cloud saves (#14) | Reflect snapshot of `LevelEntity` set into save slots | Load restores positions, health, tags in scenario |
| P3-F Mod loading (#47) | Mount external content roots, validate against schema, ruspy sandbox limits, mod list UI | Sample mod adds a car archetype and a script without a rebuild |
| P3-G Soak/fuzz/CI GPU goldens (#42) | 30-minute soak with RSS slope assertion; replay-fuzz runner | Soak on `open_world` shows slope < threshold |
| P3-H Accessibility pass (#33) | AccessKit menus, TTS for menu navigation, caption direction | VoiceOver reads main menu on macOS |

Dependencies: P1-G feeds P2-K traffic and P3-B; P1-A feeds P2-B, P3-A, P3-F; P2-G before P3-F; P2-F needs P2-D only for UI skip prompts; P1-D and P1-E are independent of everything.

## 5. Top 15 gaps by value for this user

1. Vehicle layer as an engine module (#4).
2. Damage/health/respawn/checkpoint/rules (#7, #1).
3. Multi-platform packaging, signing, notarization, symbols in the engine (#39).
4. Steam/platform services layer (#20, #40).
5. Windows CI (real Windows execution) (#41).
6. Native crash capture with minidumps (#44).
7. Gameplay Tags (#9).
8. Pawn/controller possession and PlayerState (#2).
9. Pak container and content mounting (#36).
10. Cinematics/Timeline plus camera stack (#30, #6).
11. Data tables, curves, archetypes (#13, #11).
12. UI screen stack and data binding (#16).
13. Unified cook with hash cache and import sidecars (#34, #35).
14. Input triggers, rumble, glyphs (#12).
15. Netcode: physics-aware prediction, smoothing, travel, encryption (#18, #19).

## 6. Caveats

- UE claims are from knowledge plus tree structure; I did not read UE source for behaviour details. I read the engine docs fully for NET, LOGIC, ASSETS, DEVKIT packaging/save/content sections, AI (first 120 lines plus limits), and sampled source heads (`flow.rs`, `trace.rs`, `chase.rs`, `package.sh`). Rows that say "verify" (reduced motion, AccessKit wiring) were not checked in code.
- Crate Bevy-0.20 compatibility is unknown; Pacenote's HANDOFF says Bevy 0.19.1, so the games are one version behind the engine's 0.20.1 and ecosystem crates may be as well.
- No code, tests or builds were run.

Sources: [Lightyear 0.30.0 on docs.rs](https://docs.rs/crate/lightyear/0.30.0)
