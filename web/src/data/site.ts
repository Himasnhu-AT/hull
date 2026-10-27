// All site content. Every fact here comes from the engine repo (Cargo.toml, src/, docs/*.md:
// PORTING, LOOK, ANIM, VFX, AI, SOUND, WORLD, ACTIONS, L10N, NET, DEVKIT, PERF) or from the
// Shroud and Courier repos.
//
// Assumptions / placeholders (placeholder: true), mirrored in the hand-off message:
//  - name: "Hull" is a working name. The crate is called `engine`.
//  - url: production URL unknown (used for canonical, OG, sitemap).
//  - crates.io: not published. The Cargo snippet uses the git repo.
//  - studio: "Marl Studio" / "Marl Games" are under consideration; shown nowhere until decided.
// Real: the repo (github.com/Himasnhu-AT/hull), license MIT OR Apache-2.0, Bevy =0.19.1,
// avian3d =0.7.0, every number below.

import type { ImageMetadata } from 'astro';
import menuOrange from '../assets/shots/menu-orange.webp';
import menuYellow from '../assets/shots/menu-yellow.webp';
import menuCyan from '../assets/shots/menu-cyan.webp';
import menuGreen from '../assets/shots/menu-green.webp';
import menuRose from '../assets/shots/menu-rose.webp';

export const site = {
  name: 'Hull',
  namePlaceholder: true,
  crate: 'engine',
  role: 'Code-first game engine on Bevy',
  url: 'https://hull.marl.studio', // placeholder: true
  urlPlaceholder: true,
  description:
    'Hull is a code-first Rust engine on Bevy 0.19: menus, settings and pause, plus lighting, animation, particles, AI, sound, big worlds and multiplayer.',
  license: 'MIT OR Apache-2.0',
  bevy: '0.19.1',
  avian: '0.7.0',
  repo: 'https://github.com/Himasnhu-AT/hull' as string | null,
  docs: 'https://github.com/Himasnhu-AT/hull/tree/main/docs' as string | null,
  studio: null as string | null, // placeholder: true ("Marl Studio" under consideration)
};

/** A file in the repo's docs/ folder on GitHub. */
export const doc = (file: string) => `https://github.com/Himasnhu-AT/hull/blob/main/docs/${file}`;

export const nav = [
  { href: '/', label: 'Home' },
  { href: '/#inside', label: 'Inside' },
  { href: '/#systems', label: 'Systems' },
  { href: '/performance/', label: 'Performance' },
  { href: '/render-budget/', label: 'Render budget' },
  { href: '/games/shroud/', label: 'Shroud' },
  { href: '/games/courier/', label: 'Courier' },
  { href: '/start/', label: 'Start' },
];

export type Accent = { id: string; name: string; hex: string; flag: string; img: ImageMetadata; owner?: string };
// Each image is the engine's ui_gallery example, same build, captured with `--accent r,g,b`.
export const accents: Accent[] = [
  { id: 'shroud', name: 'Orange', hex: '#ffa838', flag: 'default', img: menuOrange, owner: 'Shroud' },
  { id: 'courier', name: 'Yellow', hex: '#ffc738', flag: '1.0,0.78,0.22', img: menuYellow, owner: 'Courier' },
  { id: 'cyan', name: 'Cyan', hex: '#59d1ff', flag: '0.35,0.82,1.0', img: menuCyan },
  { id: 'green', name: 'Green', hex: '#61e6b8', flag: '0.38,0.9,0.72', img: menuGreen },
  { id: 'rose', name: 'Rose', hex: '#ff7399', flag: '1.0,0.45,0.6', img: menuRose },
];

export type Row = { label: string; hint: string; value: string; code?: string };
export type Stat = { value: string; label: string };
export type Tab = { id: string; label: string; title: string; about: string; rows: Row[]; stat?: Stat; doc?: string; feature?: string };

// The shell: what every game gets before its first line of gameplay.
export const inside: Tab[] = [
  {
    id: 'shell',
    label: 'Shell',
    title: 'The app around your game',
    about: 'One call builds the window, the states and the data folders. Your plugin adds the game.',
    doc: 'PORTING.md',
    rows: [
      { label: 'App bootstrap', hint: 'Window or headless, CLI flags, data and asset folders.', value: 'One call', code: 'engine::app(GameInfo::new(id, title))' },
      { label: 'App states', hint: 'Boot, MainMenu, InGame. Games hang their own sub-states under InGame.', value: 'Built in' },
      { label: 'Settings', hint: 'Core settings plus a typed section for your game. Saved as JSON with atomic writes; a corrupt file is set aside, not fatal.', value: 'Persisted' },
      { label: 'Settings screen', hint: 'Each FieldDef becomes a row: toggle, slider, choice, cards or swatches. Reset tab restores defaults.', value: 'Generated' },
      { label: 'Graphics quality', hint: 'Low, Medium, High and Ultra presets for AA, ambient occlusion, bloom, shadows, fog and probes.', value: '4 presets' },
      { label: 'Saves', hint: 'DataDir JSON helpers with the same atomic writes as settings. The devkit adds versioned save slots.', value: 'Built in' },
    ],
  },
  {
    id: 'ui',
    label: 'UI kit',
    title: 'Menus that already work',
    about: 'Every screen works with keyboard, mouse and gamepad. The theme is one accent colour and the embedded Barlow fonts.',
    rows: [
      { label: 'Theme', hint: 'Re-brand the whole kit with one accent colour. Barlow and Barlow Condensed are embedded.', value: 'with_accent', code: 'Theme::default().with_accent(Color::srgb(1.0, 0.78, 0.22))' },
      { label: 'Widgets', hint: 'Toggle, slider, choice, cards and swatches.', value: '5 kinds' },
      { label: 'Screen stack', hint: 'Esc pauses, Back pops. The game pauses when the window loses focus.', value: 'Built in' },
      { label: 'Main and pause menus', hint: 'Items, a side panel and a pause header, all from one MenuConfig.', value: 'MenuConfig' },
      { label: 'Toasts and FPS counter', hint: 'Post a toast from any system, even in headless runs.', value: 'Built in' },
    ],
  },
  {
    id: 'input',
    label: 'Input',
    title: 'Actions, not keys',
    about: 'Gameplay reads named actions. Players rebind them, and the menus translate themselves.',
    doc: 'ACTIONS.md',
    feature: 'actions, l10n',
    stat: { value: '0.52 µs', label: 'per frame to evaluate 16 actions' },
    rows: [
      { label: 'Action map', hint: 'Buttons, 1D and 2D axes bound to keys, mouse, gamepad buttons and sticks, with chords, deadzones and input contexts.', value: 'ActionDef', code: 'actions.axis2d("steer")' },
      { label: 'Rebinding', hint: 'A Controls screen with keyboard and gamepad columns, press to bind, conflicts flagged, reset all. Only changed bindings are saved.', value: 'Generated' },
      { label: 'Gamepad', hint: 'Every connected pad is read, rumble is scaled by a setting, and a virtual pad drives tests.', value: 'Built in' },
      { label: 'Accessibility', hint: 'Text size, high contrast, colour-blind filter, reduce motion, camera shake, hold or toggle, vibration.', value: 'Built in' },
      { label: 'Localization', hint: 'String tables in .ftl files with plurals, hot language switch and a pseudo-locale. Engine screens ship in English, German and French.', value: 'tr("key")' },
    ],
  },
  {
    id: 'play',
    label: 'Play',
    title: 'Cameras and meshes',
    about: 'The parts a prototype needs in its first hour.',
    rows: [
      { label: 'FPS controller', hint: 'Kinematic collide-and-slide, mouse look, crouch, sprint, jump.', value: 'feature fps' },
      { label: 'Chase camera', hint: 'Third-person follow for any entity. Looks ahead, orbits, pulls in front of walls.', value: 'ChaseCamera' },
      { label: 'MeshKit', hint: 'Low-poly vertex-coloured meshes from Bevy primitives. One mesh per object type.', value: 'MeshKit' },
      { label: 'Physics', hint: 'avian3d 0.7, paused with the game. Re-exported as engine::avian3d.', value: 'feature physics' },
    ],
  },
  {
    id: 'render',
    label: 'Render',
    title: 'A render budget with zero code',
    about: 'On by default in every game. Untagged meshes are classified for you.',
    stat: { value: '40,231 → 480', label: 'meshes drawn in a 40k-prop city' },
    rows: [
      { label: 'Classification', hint: 'Anything that moves, has physics or animates is an actor at full detail. The rest becomes scenery.', value: 'Automatic' },
      { label: 'Distance detail', hint: 'Small props lose shadows, then fade. Big pieces cross-fade to a flat far copy.', value: 'On' },
      { label: 'Streaming', hint: 'Scenery cells spawn around the camera with hysteresis. Colliders are never streamed.', value: 'SceneryStream' },
      { label: 'Frame pacing', hint: 'Menus and pause redraw at 30 Hz, 8 Hz unfocused, so the GPU idles.', value: 'On' },
      { label: 'Idle skip', hint: 'A frame where nothing visible changed is simulated but not drawn.', value: 'Opt-in' },
    ],
  },
  {
    id: 'dev',
    label: 'Devtools',
    title: 'Tools that never ship',
    about: 'Dev builds only. A ship build with --no-default-features carries none of it.',
    doc: 'PORTING.md',
    rows: [
      { label: 'Control port and MCP', hint: 'Tests and AI agents drive the game: keys, mouse, state, screenshots.', value: 'Dev only' },
      { label: 'Offscreen screenshots', hint: 'A hidden window renders to an image, so captures work behind a fullscreen app.', value: 'Dev only' },
      { label: 'Perf overlay and session log', hint: 'CPU, GPU, memory and frame times per span, plus a log of state changes.', value: 'Dev only' },
      { label: 'Metrics window', hint: 'F4 opens a second window with live charts and run history tied to git commits.', value: 'F4' },
      { label: 'Ship check', hint: 'package.sh refuses to package if any of the ashlar debug crates behind the devtools is still in the tree.', value: 'Enforced' },
    ],
  },
  {
    id: 'devkit',
    label: 'Devkit',
    title: 'Test it without a window',
    about: 'Everything is code or plain data, so a person or an agent can read, change, run and check it from the shell.',
    doc: 'DEVKIT.md',
    feature: 'devkit',
    stat: { value: '0.30 to 0.46 ms', label: 'p50 headless engine frame, toy game' },
    rows: [
      { label: 'Inspector', hint: 'Query, read, patch, spawn and despawn entities and resources over the control port.', value: 'ecs.*', code: 'ecs.set {id, component, value}' },
      { label: 'Scenario tests', hint: 'A 60 Hz fixed-step app with scripted input, wait_until and JSON snapshots.', value: 'Scenario' },
      { label: 'Record and replay', hint: 'Record input in one run and play it back in another.', value: 'Built in' },
      { label: 'Golden images', hint: 'Perceptual diff of screenshots; a failing compare writes a diff PNG with the changed pixels in red.', value: 'Perceptual' },
      { label: 'Perf budgets and benches', hint: 'Assert p95 frame time, entity count and allocations per frame; compare bench runs and fail on a regression.', value: 'PerfBudget' },
      { label: 'Hot reload and saves', hint: 'JSON data, tuning and settings reload while the game runs. Versioned save slots with migrations, backups and autosave.', value: 'Built in' },
    ],
  },
];

// The systems a game grows into. Each is a cargo feature, on in the default (dev) build except net,
// and costs nothing until something uses it.
export const systems: Tab[] = [
  {
    id: 'look',
    label: 'Look',
    title: 'Lighting as data',
    about: 'Sun, sky, fog, exposure, grading and lens effects in one serde struct. Blend two looks, run a day cycle, patch fields over the control port.',
    doc: 'LOOK.md',
    feature: 'look',
    stat: { value: '+1.1 ms', label: 'GPU from Medium to High tier' },
    rows: [
      { label: 'Look presets', hint: 'clear_day, overcast, dusk, night and indoor. Build variations with ..Look::dusk().', value: '5 presets', code: 'app.insert_resource(Look::dusk())' },
      { label: 'Sky and sun', hint: 'Bevy’s physical atmosphere, a procedural gradient sky or a cubemap. The sky is filtered once into image-based light, not every frame.', value: 'SkyMode' },
      { label: 'Fog and volumetrics', hint: 'Linear, exponential or atmospheric fog, plus a volumetric fog box with sun shafts on High and Ultra.', value: 'FogLook' },
      { label: 'Grading and lens', hint: 'Exposure (manual or auto), tonemapping, lift, gamma and gain, bloom, depth of field, motion blur, vignette, film grain.', value: 'GradingLook' },
      { label: 'Reflection probes', hint: 'Captured at runtime: baked and frozen, or realtime one face every few frames.', value: 'ReflectionProbe' },
      { label: 'Decals and soft shadows', hint: 'Forward decals from generated textures. PCSS soft shadows on Ultra behind the look_pcss feature.', value: 'Ultra' },
    ],
  },
  {
    id: 'anim',
    label: 'Anim',
    title: 'Animation graphs in Rust',
    about: 'The job of an animation blueprint, as a value you build in code over Bevy’s AnimationPlayer. build() returns an error that names any unknown state, parameter or bone.',
    doc: 'ANIM.md',
    feature: 'anim',
    stat: { value: '~0.15 µs', label: 'per character per frame for the graph logic' },
    rows: [
      { label: 'State machines', hint: 'States, crossfades, conditions on float, bool and trigger parameters, exit times and any-state transitions.', value: 'AnimGraphDef' },
      { label: 'Blend spaces', hint: '1D and 2D blends, for example speed by direction for locomotion.', value: '1D, 2D' },
      { label: 'Layers and masks', hint: 'Override layers on a bone mask (wave with the upper body) and additive layers (lean into turns).', value: 'Built in' },
      { label: 'Root motion and notifies', hint: 'Root bone motion moves the entity; notifies fire messages such as footsteps at points in a clip.', value: 'Built in' },
      { label: 'IK and springs', hint: 'Two-bone IK, look-at, spring bones and foot placement on uneven ground.', value: 'TwoBoneIk' },
      { label: 'LOD', hint: 'Far characters are posed every 2, 4 or 8 frames; off-screen ones not at all. Logic still runs every frame.', value: 'By distance' },
    ],
  },
  {
    id: 'vfx',
    label: 'VFX',
    title: 'Particles without an editor',
    about: 'Effects are Rust or JSON values, simulated on the CPU and drawn with one instanced draw call per emitter. Seeded effects replay bit for bit.',
    doc: 'VFX.md',
    feature: 'vfx',
    stat: { value: '~2.2 ms', label: 'frame cost of 100,000 particles' },
    rows: [
      { label: 'Presets', hint: 'sparks, smoke, fire, muzzle_flash, explosion, dust_puff, magic, rain and snow.', value: '9 presets', code: 'vfx.play("explosion", transform)' },
      { label: 'Emitters', hint: 'Rates, bursts, trails per metre, shapes from points to mesh surfaces, curl turbulence, attractors, orbits.', value: 'EmitterDef' },
      { label: 'Collision and sub-emitters', hint: 'Particles bounce on a plane or on avian colliders and can spawn other emitters on death or impact.', value: 'Built in' },
      { label: 'Rendering', hint: 'Flipbooks, soft and lit particles, sorting, additive or alpha blend. Textures are generated at startup.', value: 'Instanced' },
      { label: 'Budgets and pooling', hint: 'Per-emitter capacity, culling distance, LOD and pooled one-shots: no spawn churn.', value: 'Built in' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    title: 'Navigation and decisions',
    about: 'A level made of avian colliders gets a navmesh, baked in the background. Agents path-find and avoid each other; trees and scorers decide what they do.',
    doc: 'AI.md',
    feature: 'ai',
    stat: { value: '< 0.1 ms', label: 'all AI systems, 100 agents in game' },
    rows: [
      { label: 'Navmesh baking', hint: 'Recast-style tiles baked off the main thread. Moving one crate rebakes 1 to 4 tiles.', value: 'Automatic' },
      { label: 'Paths and crowds', hint: 'A* over polygons with a funnel, then separation and ORCA avoidance. Off-mesh links, for example a ladder.', value: 'NavAgent' },
      { label: 'Behaviour trees', hint: 'Sequences, selectors, reactive and parallel nodes, decorators, built from Rust functions. Ticks are deterministic.', value: 'BehaviorTree' },
      { label: 'Utility AI', hint: 'Scored options with response curves and hysteresis, alone or inside a tree.', value: 'UtilityAi' },
      { label: 'Perception', hint: 'Sight cones with a budget of line-of-sight rays per frame, hearing from noise events, and memory.', value: 'Perceiver' },
    ],
  },
  {
    id: 'sound',
    label: 'Sound',
    title: 'A mixer, defined in Rust',
    about: 'Buses, snapshots and ducking, 3D voices with occlusion, layered music and captions. No new dependencies: the DSP is the engine’s own, so tests render the same audio offline.',
    doc: 'SOUND.md',
    feature: 'sound',
    stat: { value: '0.97%', label: 'of one core: 48 3D voices, 6 buses, reverb' },
    rows: [
      { label: 'Mixer', hint: 'A bus tree with mix snapshots and sidechain ducking: music drops while someone speaks.', value: 'Mixer' },
      { label: 'Cues and voices', hint: 'Variants, randomisation, cooldowns, instance and voice limits with stealing, virtual voices.', value: 'SoundCue' },
      { label: '3D and occlusion', hint: 'Rolloff, panning, doppler, rear darkening. Raycasts muffle sounds behind walls.', value: 'Built in' },
      { label: 'Zones', hint: 'Sphere or box zones that blend a reverb snapshot and an ambience loop.', value: 'SoundZone' },
      { label: 'Music', hint: 'Stems that fade in by intensity, transitions on the next beat or bar, a beat message for gameplay.', value: 'Music' },
      { label: 'Captions', hint: 'Speaker lines and [sound effects] on screen when the voice really starts, with a direction mark for 3D sources.', value: 'Built in' },
    ],
  },
  {
    id: 'world',
    label: 'World',
    title: 'Large worlds as data',
    about: 'Terrain, foliage, streaming and far detail from one WorldDesc, written in Rust or RON. Nothing runs until a world is spawned.',
    doc: 'WORLD.md',
    feature: 'world',
    stat: { value: '~7×', label: 'fewer entities streamed, 2.7 to 3.3× shorter frames' },
    rows: [
      { label: 'Terrain', hint: 'Heightfields from noise, 16-bit PNG or raw files, in 128 m chunks with LOD, a 4-layer splat material and colliders.', value: 'Terrain' },
      { label: 'Scatter', hint: 'Grass, trees and rocks placed by seeded rules: density, height, slope, noise masks, exclusions.', value: 'ScatterRule' },
      { label: 'Cell streaming', hint: 'Gameplay data and colliders load in cells around the camera; a coarse collider is always there.', value: 'WorldCells' },
      { label: 'HLOD', hint: 'Far cells become merged, simplified proxies built in background tasks.', value: 'Built in' },
      { label: 'Floating origin', hint: 'Rebases the world around the camera so far coordinates stay precise.', value: 'Opt-in' },
    ],
  },
  {
    id: 'net',
    label: 'Net',
    title: 'Server-authoritative multiplayer',
    about: 'Off by default: most games are single-player. Turn on the net feature and a few lines of Rust choose what replicates. Tested headless on a deterministic loopback network.',
    doc: 'NET.md',
    feature: 'net (opt-in)',
    stat: { value: '−42%', label: 'bytes with delta compression' },
    rows: [
      { label: 'Transports and channels', hint: 'UDP or in-memory, reliable and unreliable channels, typed messages both ways.', value: 'UDP' },
      { label: 'Replication', hint: 'Delta-compressed snapshots with interest management and a bandwidth budget per client.', value: 'Built in' },
      { label: 'Prediction', hint: 'Client-side prediction with rollback and replay, plus interpolation for everything else.', value: 'Built in' },
      { label: 'Lag compensation', hint: 'The server checks hits against where players saw their targets.', value: 'Built in' },
      { label: 'Zero cost when off', hint: 'Without host or connect every net system is skipped; without the feature nothing is compiled.', value: 'Opt-in' },
    ],
  },
];

export const code = {
  main: `use engine::prelude::*;

fn main() {
    engine::app(
        GameInfo::new("orbs", "Orbs").tagline("Collect them all."),
    )
    .add_plugins(MyGamePlugin)
    .run();
}`,
  cargo: `[dependencies.engine]
git = "https://github.com/Himasnhu-AT/hull"
default-features = false
features = [
    "physics", "fps", "look", "anim", "vfx",
    "ai", "sound", "world", "actions", "l10n",
]   # add "net" for multiplayer

[dependencies]
bevy = { version = "=0.19.1", default-features = false }

[features]
# cargo run / cargo test keep every debug tool
default = ["dev"]
dev = ["engine/devtools", "engine/trace", "engine/devkit"]`,
  setting: `app.register_setting(FieldDef {
    key: "assist",
    tab: "Gameplay",
    label: "Steering assist",
    hint: "More grip and calmer steering at speed. Off: the bike slides and drifts.",
    kind: FieldKind::Toggle,
    get: |w| b(s(w).assist),
    set: |w, v| s_mut(w).assist = v > 0.5,
})`,
  menu: `.insert_resource(Theme::default().with_accent(Color::srgb(1.0, 0.78, 0.22)))
.insert_resource(MenuConfig {
    eyebrow: "Hover-bike parcel delivery",
    main_items: vec![
        ("Start shift", MenuAction::Open("shift")),
        ("Records", MenuAction::Open("records")),
        ("Settings", MenuAction::Settings),
        ("Quit", MenuAction::Quit),
    ],
    ..default()
})`,
  ship: `cargo tree -p <pkg> --no-default-features --features "<ship features>" -e normal | grep ashlar
# prints nothing`,
};

export const budget = {
  headline: [
    { from: '40,231', to: '480', unit: 'meshes drawn', note: '40k-prop city, overview' },
    { from: '4.54', to: '3.07', unit: 'ms p95 frame', note: 'same view' },
    { from: '85 to 92%', to: '21 to 32%', unit: 'GPU busy in menus', note: 'frame pacing' },
  ],
  rig: 'Apple M5 Pro, 1920×1080, High quality, vsync off',
};

export type Game = {
  slug: 'shroud' | 'courier';
  title: string;
  kind: string;
  accent: string;
  tagline: string;
  summary: string;
  facts: { value: string; label: string }[];
};

export const games: Game[] = [
  {
    slug: 'shroud',
    title: 'Shroud',
    kind: 'Indoor FPS',
    accent: '#ffa838',
    tagline: 'They learn from you.',
    summary: 'An indoor shooter whose AI squad evolves from your past matches. Porting it moved its whole shell into the engine.',
    facts: [
      { value: '13,467', label: 'lines of game code before the port' },
      { value: '7,833', label: 'lines after' },
    ],
  },
  {
    slug: 'courier',
    title: 'Courier',
    kind: 'Third-person driving',
    accent: '#ffc738',
    tagline: 'Every parcel, on time, across the valley.',
    summary: 'Hover-bike parcel delivery across a 1.28 km procedural valley, built to see whether the engine fits a game unlike Shroud.',
    facts: [
      { value: '~3,150', label: 'lines of game code' },
      { value: '8.3 ms', label: 'average frame' },
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// BENCHMARKS: every number on /performance/ and in the home teaser comes from this block
// (docs/PERF.md). After a new `scripts/perf_suite.py run`, update `commit`, the `after` values of
// each scene (and `benches` if `bench.py run` was re-run). Headlines, deltas, captions and counts
// are computed from it; the pages hold no numbers of their own.
// Scene values: fps, frame p50/p95/p99 ms (last ~600 frames), GPU ms per frame, process memory MB
// (footprint, Metal included), entities. `base: null` = the scene did not run at the baseline.
// ---------------------------------------------------------------------------------------------
type SceneNums = { fps: number; p50: number; p95: number; p99: number; gpu: number; mem: number };
export type BenchScene = { scene: string; what: string; after: SceneNums & { ent: number }; base: SceneNums | null; baseNote?: string };
export type SceneKey = keyof SceneNums;

export const bench = {
  commit: 'c8532d9',
  baseCommit: '2327039',
  // Commit of the headless CPU bench column.
  benchCommit: 'c8532d9',
  machine: 'frame times on a quiet machine (load under 7.5); Mem MB for look_high, look_dusk and look_ultra from 617d3e5, after the offscreen frame-pacing fix (memory does not depend on load: three runs agreed within 5 %)',
  rig: '1920×1080 offscreen, vsync off, dev profile (opt-level 3 + debuginfo), M-series MacBook Pro with 15 cores, 20 s window after an 8 s warm-up',
  scenes: [
    { scene: 'look_low', what: 'Lighting, Low tier', after: { fps: 229, p50: 4.3, p95: 4.8, p99: 5.1, gpu: 3.8, mem: 819, ent: 797 }, base: { fps: 192, p50: 4.4, p95: 5.1, p99: 6.0, gpu: 4.2, mem: 872 } },
    { scene: 'look_high', what: 'Lighting, High tier', after: { fps: 130, p50: 7.2, p95: 10.4, p99: 11.8, gpu: 7.5, mem: 1015, ent: 799 }, base: { fps: 99, p50: 10.2, p95: 12.8, p99: 13.7, gpu: 9.1, mem: 3933 } },
    { scene: 'look_dusk', what: 'Low sun, volumetrics, grading', after: { fps: 127, p50: 7.5, p95: 11.2, p99: 12.4, gpu: 7.6, mem: 1050, ent: 799 }, base: { fps: 95, p50: 10.7, p95: 13.5, p99: 14.7, gpu: 9.3, mem: 4097 } },
    { scene: 'look_ultra', what: 'SSR, realtime probe every frame', after: { fps: 65, p50: 15.4, p95: 16.8, p99: 17.4, gpu: 14.9, mem: 1437, ent: 799 }, base: null, baseNote: 'crashed at start' },
    { scene: 'open_world', what: '4 × 4 km terrain, 100k scatter, flying', after: { fps: 238, p50: 4.1, p95: 4.7, p99: 5.6, gpu: 3.7, mem: 1102, ent: 34835 }, base: { fps: 116, p50: 7.2, p95: 9.4, p99: 48.5, gpu: 4.5, mem: 1385 } },
    { scene: 'render_budget', what: '4,000-prop town', after: { fps: 328, p50: 3.0, p95: 3.6, p99: 3.9, gpu: 2.8, mem: 678, ent: 5005 }, base: { fps: 249, p50: 3.3, p95: 4.0, p99: 4.4, gpu: 3.2, mem: 689 } },
    { scene: 'ai_crowd', what: '200 agents: navmesh, crowds, trees, perception', after: { fps: 328, p50: 2.9, p95: 3.2, p99: 3.4, gpu: 2.6, mem: 710, ent: 1161 }, base: { fps: 293, p50: 4.6, p95: 5.1, p99: 5.4, gpu: 2.6, mem: 708 } },
    { scene: 'anim_demo', what: 'State machines, IK, LOD', after: { fps: 318, p50: 3.1, p95: 4.0, p99: 4.8, gpu: 3.0, mem: 756, ent: 937 }, base: { fps: 309, p50: 3.5, p95: 4.6, p99: 4.9, gpu: 3.0, mem: 785 } },
    { scene: 'vfx_gallery', what: 'Every particle preset', after: { fps: 288, p50: 3.4, p95: 3.8, p99: 4.0, gpu: 2.9, mem: 728, ent: 759 }, base: { fps: 186, p50: 5.6, p95: 6.3, p99: 6.6, gpu: 3.5, mem: 693 } },
    { scene: 'vfx_stress', what: '100k CPU particles', after: { fps: 262, p50: 3.7, p95: 4.3, p99: 4.7, gpu: 3.1, mem: 805, ent: 727 }, base: { fps: 169, p50: 5.8, p95: 6.4, p99: 6.8, gpu: 3.9, mem: 771 } },
    { scene: 'sound_demo', what: 'Mixer, 3D voices, occlusion, music', after: { fps: 368, p50: 2.7, p95: 3.2, p99: 3.9, gpu: 2.5, mem: 634, ent: 738 }, base: { fps: 217, p50: 3.0, p95: 3.7, p99: 4.6, gpu: 3.2, mem: 605 } },
    { scene: 'ui_gallery', what: 'UI kit screens', after: { fps: 318, p50: 3.0, p95: 3.4, p99: 3.7, gpu: 2.8, mem: 698, ent: 740 }, base: { fps: 303, p50: 3.0, p95: 3.9, p99: 4.3, gpu: 2.7, mem: 684 } },
  ] as BenchScene[],
  // Home teaser and page hero: which scene value to show before → after. The first one is the hero.
  headline: [
    { scene: 'open_world', key: 'p99', unit: 'ms p99 frame, open world', note: 'Flying over 4 × 4 km of streamed terrain' },
    { scene: 'look_high', key: 'fps', unit: 'fps, look at High', note: 'Realtime probe filtered once per face cycle', also: 'look_dusk' },
    { scene: 'look_ultra', key: 'fps', unit: 'fps, look at Ultra', note: 'SSR now sees deferred materials' },
  ] as { scene: string; key: SceneKey; unit: string; note: string; also?: string }[],
  // What the first run caught. `show` = scene values rendered before → after next to the story.
  fixed: [
    { tag: 'Crash', finding: 'look_ultra crashed at start, and leaving Ultra crashed', cause: 'SSR switches materials to deferred by touching them with Assets::get_mut, which in Bevy 0.19 is not a change unless written through, and probe capture views had no deferred prepass.', fix: 'Materials are marked changed and side views get a deferred prepass while SSR is on. Every tier switch works.', show: [{ scene: 'look_ultra', key: 'fps' }] },
    { tag: 'Stall', finding: 'open_world stalled 10.5 s after loading, then hitched every second while flying', cause: 'The AI plugin triangulated every streamed terrain collider on the main thread and re-baked navmesh tiles, in a demo with no agents.', fix: 'Navmesh work starts only when a NavAgent or NavSource exists. 36 hitches per run became 7, with no stall.', show: [{ scene: 'open_world', key: 'p99' }, { scene: 'open_world', key: 'fps' }] },
    { tag: 'Probe', finding: 'High and dusk spent their frame on the reflection probe', cause: 'The realtime reflection probe ran Bevy’s environment-map filter every frame, re-creating bind groups and buffers each time.', fix: 'The filter runs once per full cycle of fresh faces: about 100 filters per second became about 28.', show: [{ scene: 'look_high', key: 'fps' }, { scene: 'look_dusk', key: 'fps' }] },
    { tag: 'Memory', finding: 'High, dusk and Ultra used four to five times the memory of Low', cause: 'Offscreen runs had no frame pacing. With no swapchain, nothing made the CPU wait for the GPU, so in GPU-bound scenes frames queued without limit and the Metal driver held tens of thousands of command buffers. wgpu itself held about 200 buffers, which ruled out a leak in the engine.', fix: 'Offscreen rendering now waits like a swapchain, with at most two frames in flight. Frame time is unchanged when the GPU keeps up.', show: [{ scene: 'look_high', key: 'mem' }, { scene: 'look_dusk', key: 'mem' }] },
    { tag: 'Misleading', finding: 'Render budget spans read 1 to 3 ms per frame', cause: 'The span’s wall-time window took in Bevy’s visibility systems.', fix: 'Spans removed; render.cpu_us is the real cost, 0.3 ms in open_world.', show: [] },
  ] as { tag: string; finding: string; cause: string; fix: string; show: { scene: string; key: SceneKey }[] }[],
  // Headless CPU benches (`scripts/bench.py run`), baseline vs after, as written in PERF.md.
  benchNote: 'No bench code changed between the two columns, so most of the difference is the baseline machine’s load.',
  benches: [
    { bench: 'Anim crowd, 500 characters', before: '2.5 ms per frame (1.8 with LOD)', after: '1.7 ms (1.3 with LOD)' },
    { bench: 'Navmesh bake, 300 × 300 m, 600 crates', before: '109 ms wall, path query 0.13 ms', after: '89 ms wall, path 0.11 ms' },
    { bench: 'Behaviour trees + perception, 500 agents', before: '0.06 + 1.0 ms per frame', after: '0.06 + 0.93 ms' },
    { bench: 'Sound DSP, 48 voices, 6 buses, reverb', before: '1.0% of one core', after: '0.97%' },
    { bench: 'Net server, 64 clients × 500 entities', before: '3.6 ms per frame (1.2 with relevancy)', after: '2.1 ms (1.2 with relevancy)' },
    { bench: 'Save 10k entities', before: 'write 6.4 ms, read 3.2 ms', after: 'write 4.5 ms, read 2.3 ms' },
    { bench: 'Inspector ecs.query, 10k entities to JSON', before: '35 ms (0.27 ms with limit 10)', after: '28 ms (0.14 ms)' },
  ],
  // Notes under the scene table and known limits: prose without numbers; numbers stay in the table.
  sceneNote: 'Scenes the fixes did not touch (render budget, VFX, UI) also got faster, which suggests the baseline machine was not fully idle; the look and open world gains are the fixes.',
  limits: [
    'A realtime reflection probe still costs more memory than a baked one (its six face targets): compare Mem MB for look_low with look_high. Bake probes when nothing in the room moves.',
    'open_world had no long frames in the bench window. Over a longer flight a few long frames remain when new scatter streams in; scatter now spawns at most 1000 items per frame, but spawning still runs on the main thread.',
    'This Mac is shared with other projects’ builds. The suite records the load for every scene; numbers from busy runs are not published here.',
    'The numbers are a dev profile on one machine. Ship builds (release, no devtools) are faster.',
  ],
};

// Helpers for the pages: find a scene, format a value, describe a change.
export const scene = (id: string) => {
  const s = bench.scenes.find((x) => x.scene === id);
  if (!s) throw new Error(`bench: no scene ${id}`);
  return s;
};
const dec: Record<SceneKey | 'ent', number> = { fps: 0, p50: 1, p95: 1, p99: 1, gpu: 1, mem: 0, ent: 0 };
export const fmt = (key: SceneKey | 'ent', v: number) => v.toLocaleString('en-US', { minimumFractionDigits: dec[key], maximumFractionDigits: dec[key] });
/** "+31%" / "−18%" (rounded), or null within ±3%. */
export const pct = (from: number, to: number) => {
  const d = Math.round(((to - from) / from) * 100);
  return Math.abs(d) < 3 ? null : `${d > 0 ? '+' : '−'}${Math.abs(d)}%`;
};
/** The "vs baseline" cell: fps and p95 changes, or the base note. */
export const vsBase = (s: BenchScene) => {
  if (!s.base) return `baseline ${s.baseNote ?? "missing"}`;
  const parts = [['fps', pct(s.base.fps, s.after.fps)], ['p95', pct(s.base.p95, s.after.p95)], ['p99', pct(s.base.p99, s.after.p99)]]
    .filter(([, v]) => v).slice(0, 2).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(', ') : '≈';
};
/** Before → after of one scene value, for headlines and the fixes list. */
export const change = (id: string, key: SceneKey) => {
  const s = scene(id);
  return { from: s.base ? fmt(key, s.base[key]) : s.baseNote ? 'Crashed' : '—', to: fmt(key, s.after[key]), pct: s.base ? pct(s.base[key], s.after[key]) : null };
};
