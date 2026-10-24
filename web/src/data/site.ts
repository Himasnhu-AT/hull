// All site content. Every fact here comes from the engine repo (Cargo.toml, src/, docs/PORTING.md)
// or from the Shroud and Courier repos.
//
// Assumptions / placeholders (placeholder: true), mirrored in the hand-off message:
//  - name: "Hull" is a working name. The crate is called `engine`.
//  - url: production URL unknown (used for canonical, OG, sitemap).
//  - repo, docs, crates.io: not public yet. The site says so instead of linking nowhere.
//  - studio: "Marl Studio" / "Marl Games" are under consideration; shown nowhere until decided.
// Real: license MIT OR Apache-2.0, Bevy =0.19.1, avian3d =0.7.0, every number below.

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
  role: 'Game shell for Bevy',
  url: 'https://hull.marl.studio', // placeholder: true
  urlPlaceholder: true,
  description:
    'Hull is a Rust crate on Bevy 0.19 that gives your game its menus, settings, pause, UI kit, cameras, render budget and dev tools, so day one is gameplay.',
  license: 'MIT OR Apache-2.0',
  bevy: '0.19.1',
  avian: '0.7.0',
  repo: null as string | null, // placeholder: true (not public yet)
  docs: null as string | null, // placeholder: true
  studio: null as string | null, // placeholder: true ("Marl Studio" under consideration)
};

export const nav = [
  { href: '/', label: 'Home' },
  { href: '/#inside', label: 'Inside' },
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
export type Tab = { id: string; label: string; title: string; about: string; rows: Row[] };

export const inside: Tab[] = [
  {
    id: 'shell',
    label: 'Shell',
    title: 'The app around your game',
    about: 'One call builds the window, the states and the data folders. Your plugin adds the game.',
    rows: [
      { label: 'App bootstrap', hint: 'Window or headless, CLI flags, data and asset folders.', value: 'One call', code: 'engine::app(GameInfo::new(id, title))' },
      { label: 'App states', hint: 'Boot, MainMenu, InGame. Games hang their own sub-states under InGame.', value: 'Built in' },
      { label: 'Settings', hint: 'Core settings plus a typed section for your game. Saved as JSON with atomic writes; a corrupt file is set aside, not fatal.', value: 'Persisted' },
      { label: 'Settings screen', hint: 'Each FieldDef becomes a row: toggle, slider, choice, cards or swatches. Reset tab restores defaults.', value: 'Generated' },
      { label: 'Input and cursor', hint: 'Bindings, mouse look, cursor capture that lets go on menus.', value: 'Built in' },
      { label: 'Audio', hint: 'SoundLibrary with variants, volume categories, muting for test runs.', value: 'Built in' },
      { label: 'Graphics quality', hint: 'Low, Medium, High and Ultra presets for AA, ambient occlusion, bloom and shadows.', value: '4 presets' },
      { label: 'Saves', hint: 'DataDir JSON helpers with the same atomic writes as settings.', value: 'Built in' },
    ],
  },
  {
    id: 'ui',
    label: 'UI kit',
    title: 'Menus that already work',
    about: 'Every screen works with keyboard and mouse. The theme is one accent colour and the embedded Barlow fonts.',
    rows: [
      { label: 'Theme', hint: 'Re-brand the whole kit with one accent colour. Barlow and Barlow Condensed are embedded.', value: 'with_accent', code: 'Theme::default().with_accent(Color::srgb(1.0, 0.78, 0.22))' },
      { label: 'Widgets', hint: 'Toggle, slider, choice, cards and swatches. Keyboard and mouse.', value: '5 kinds' },
      { label: 'Screen stack', hint: 'Esc pauses, Back pops. The game pauses when the window loses focus.', value: 'Built in' },
      { label: 'Main and pause menus', hint: 'Items, a side panel and a pause header, all from one MenuConfig.', value: 'MenuConfig' },
      { label: 'Toasts and FPS counter', hint: 'Post a toast from any system, even in headless runs.', value: 'Built in' },
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
      { label: 'Sun and shadows', hint: 'SunSetup: sun angle, shadow distance and cascades for arenas or open maps.', value: 'SunSetup' },
    ],
  },
  {
    id: 'render',
    label: 'Render',
    title: 'A render budget with zero code',
    about: 'On by default in every game. Untagged meshes are classified for you.',
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
    rows: [
      { label: 'Control port and MCP', hint: 'Tests and AI agents drive the game: keys, mouse, state, screenshots.', value: 'Dev only' },
      { label: 'Offscreen screenshots', hint: 'A hidden window renders to an image, so captures work behind a fullscreen app.', value: 'Dev only' },
      { label: 'Perf overlay and session log', hint: 'CPU, GPU, memory and frame times per span, plus a log of state changes.', value: 'Dev only' },
      { label: 'Metrics window', hint: 'F4 opens a second window with live charts and run history tied to git commits.', value: 'F4' },
      { label: 'Ship check', hint: 'package.sh refuses to package if any ashlar debug crate is still in the tree.', value: 'Enforced' },
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
path = "../engine"
default-features = false
features = ["physics", "fps"]

[dependencies]
bevy = { version = "=0.19.1", default-features = false }

[features]
# cargo run / cargo test keep every debug tool
default = ["dev"]
dev = ["engine/devtools", "engine/trace"]`,
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
