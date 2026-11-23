// Shared contracts between subsystems. Owned by the core agent; other agents may ADD optional fields at the end of
// the block they belong to, but must not rename or retype existing ones (other worktrees depend on them).
import type * as THREE from 'hull/three';
import type { CollisionWorld } from './core/collision';
import type { Player } from './player/player';
import type { TitanManager } from './titans/titans';
import type { TrainingCourse } from './titans/dummies';
import type { Game as HullGame } from 'hull';
import type { Effects } from './fx/effects';
import type { Audio } from './audio/audio';
import type { Hud } from './ui/hud';
import type { Input } from './input';
import type { Game as Flow } from './game';
import type { Ally } from './player/ally';
import type { Herd } from './player/horse';
import type { Carrier } from './titans/carrier';
import type { Hint } from './game';
import type { Civilians } from './npc/civilians';
import type { Board } from './ui/board';

export type Vec3 = THREE.Vector3;
export type { Collider, ShapeCollider, BoxCollider, CylinderCollider, CapsuleCollider, SphereCollider, GroundCollider, RayHit, Contact, SphereContact } from './core/collision';
export type { Hint } from './game';

/** Collider surface material: drives sparks and sounds. */
export type SurfaceMaterial = 'stone' | 'wood' | 'bark' | 'roof' | 'flesh' | 'metal' | 'ground';

/** Mode ids. Player-facing names: expedition = Holdout, gate = Seal the Breach, scout = The Twelfth Sortie. */
export type GameMode = 'menu' | 'expedition' | 'gate' | 'scout' | 'training' | 'free';

export type HitPart = 'nape' | 'eye' | 'ankle' | 'arm' | 'hand' | 'body' | 'leg';

export interface HitResult {
  killed: boolean;
  effect: 'kill' | 'shallow' | 'blind' | 'cripple' | 'sever' | 'none' | string;
  [k: string]: unknown;
}

/** Anything the player can cut: titans, the Huntress, training dummies. */
export interface Cuttable {
  kind: string;
  alive: boolean;
  height: number;
  position: THREE.Vector3;
  velocity?: THREE.Vector3;
  root: THREE.Object3D;
  threat?: number;
  napeWorld(): { center: THREE.Vector3; normal?: THREE.Vector3; [k: string]: unknown } | null;
  applyHit(hit: { part: string; damage: number; point: THREE.Vector3; dir: THREE.Vector3; [k: string]: unknown }): HitResult | unknown;
  anchors?(out: THREE.Vector3[]): THREE.Vector3[];
}

export interface HitTestHit { titan: Cuttable; part: string; point: THREE.Vector3 }

export interface GameEvents {
  on(name: string, fn: (payload?: any) => void): void;
  off(name: string, fn: (payload?: any) => void): void;
  emit(name: string, payload?: unknown): void;
}

export interface WorldHandle {
  playerSpawn: { position: THREE.Vector3; yaw: number };
  supplyDepots: { position: THREE.Vector3; radius: number }[];
  titanSpawns: { center: THREE.Vector3; radius: number; area: 'field' | 'forest' | 'town' | string }[];
  /** Direction from the scene towards the sun (the look's sun points the same way; the wire's glint reads it). */
  sunDirection?: THREE.Vector3;
  /** The current horizon (fog) colour. */
  fogColor?: THREE.Color;
  /** Name of the current atmosphere (set by setAtmosphere). */
  atmosphere?: string | null;
  update(dt: number, cameraPosition: THREE.Vector3): void;
  /** 'day' (default), 'varn' (smoke over the gate town, Seal the Breach), 'dawn'. */
  setAtmosphere?(kind: 'day' | 'varn' | 'dawn' | string): void;
  setFoliageFocus?(p: THREE.Vector3 | null): void;
  /** Bring down the houses within `radius` of a point (a titan fell there, or went through); returns how many.
   *  rebuildTown stands them all up again. */
  smash?(at: THREE.Vector3, radius: number): number;
  rebuildTown?(): void;
  /** The Ashwall's gate: true = breached (open), false = shut. gateOpen reads it back. */
  setGate?(open: boolean, burst?: boolean): void;
  readonly gateOpen?: boolean;
  /** Is this point inside foliage (canopy clusters)? */
  inFoliage?(p: THREE.Vector3): boolean;
  [k: string]: unknown;
}

/** A mission's director (cinematic camera). */
export interface Cine {
  shot?: { pos(out: THREE.Vector3): THREE.Vector3; look(out: THREE.Vector3): THREE.Vector3; fov?: number; roll?: number } | null;
  focus?: ((out: THREE.Vector3) => THREE.Vector3) | null;
  bars?: boolean;
  [k: string]: unknown;
}

/** The nape-cut camera: t / dur seconds, the nape, the side it was cut from, the camera-to-nape direction, titan size. */
export interface KillCam { t: number; dur: number; nape: THREE.Vector3; side: THREE.Vector3; toN: THREE.Vector3; size: number; [k: string]: unknown }

/** A titan waiting to be built (Game._spawnQ, one every 50 ms; missions push these too). `then` gets the titan. */
export interface SpawnRequest {
  kind: 'normal' | 'abnormal' | 'behemoth';
  height?: number;
  position: THREE.Vector3;
  yaw?: number;
  crawler?: boolean;
  /** the Behemoth only: it has come to kick the gate in, and goes once that is done */
  breach?: boolean;
  then?: (titan: any) => void;
}

/** Screen-space markers the HUD draws (pixels from the top-left). */
export interface NapeMarker { x: number; y: number; visible: boolean; distance: number }
export interface HookTargetMarker { x: number; y: number; visible: boolean; valid: boolean; attached: boolean }
/** An off-screen titan: angle 0 = straight ahead (up on the radar), danger when it's close or reaching for you. */
export interface ThreatMarker { angle: number; danger: boolean; distance: number }

/** Everything the HUD shows, built by host.ts every frame and passed to Hud.update. */
export interface HudState {
  playing: boolean;
  mode: GameMode;
  gas: number;
  blade: number;
  bladesSpare: number;
  hp: number;
  kills: number;
  score: number;
  /** m/s */
  speed: number;
  combo: number;
  hooks: { state: string }[];
  aim: { valid: boolean; distance: number; lockTitan: unknown };
  napeMarkers: NapeMarker[];
  hookTargets: HookTargetMarker[];
  threats: ThreatMarker[];
  objective: string;
  fps?: number;
  grabbed: boolean;
  struggle: number;
  swapping: boolean;
  wave: number;
  /** Training Yard clock (seconds), null outside training. */
  timer: number | null;
  targets: { left: number; total: number } | null;
  hint: Hint | null;
  controlsCard: boolean;
  cinematic: boolean;
}

/** The shared game object built in host.ts. */
export interface Game {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** The Hull game: its world holds the timers and the named random streams (sim.ts), its loop drives every step. */
  hull: HullGame;
  collision: CollisionWorld;
  events: GameEvents;
  input: Input;
  settings: { sens: number; invertY: boolean };
  time: number;
  mode: GameMode;
  paused?: boolean;
  noRender?: boolean;

  world: WorldHandle;
  player: Player;
  fx: Effects | null;
  /** The nape cut's hit moment drew over the raw renderer; Hull's post chain has no such pass yet, so this stays null. */
  impactFrame: { active?: boolean; trigger?(position: THREE.Vector3, strength?: number): void; cancel?(): void } | null;
  audio: Audio | null;
  hud: Hud | null;
  titans: TitanManager | null;
  training: TrainingCourse | null;
  trainingActive: boolean;
  allies: Ally[];
  /**
   * The stress scale of a perf run (`?scale=4`, plan-rust.md R0): titans a wave, comrades and civilians are multiplied
   * by it, to find the load at which the frame is lost. 1 is the game as it ships.
   */
  load: number;
  herd: Herd | null;
  /** Civilians to save (npc/civilians.ts); null if the module failed to load. */
  civilians?: Civilians | null;
  flow: Flow;

  targetList(): Cuttable[];
  hitTest(center: THREE.Vector3, radius: number): HitTestHit[];

  /** A cutscene is playing (the Behemoth at the gate): the soldier is held where they are, out of harm's way. */
  cutscene?: boolean;
  /** Where the squad fights when it is not following you (Holdout once the gate is down: the town); null: with you. */
  squadHome?: THREE.Vector3 | null;
  /** The squad's scoreboard and your best runs (ui/board.ts). */
  board?: Board | null;

  // Seal the Breach / missions (escort: the shifter's giant carrying the boulder, titans/carrier.ts)
  escort?: Carrier | null;
  gateSealed?: boolean;
  cine?: Cine | null;
  killCam?: KillCam | null;
  _radioAt?: number;

  // time control
  hitstop: number;
  slowmo?: number;
  slowmoDur?: number;
  _frameDt?: number;

  // UI / settings
  showControls?: boolean;
  quality: number;
  setQuality(q: number, say?: boolean | 'auto'): void;
  autoQuality(dt: number, playing: boolean): void;
  allyRange?: number;
  fps?: number;
  flash(k?: number): void;
  pause(): void;
  resume(): void;
  /** Ask the browser for full screen (granted only from a click or key press; refused quietly otherwise). */
  fullscreen?(): void;

  _titanErr?: number;
  _sunOff?: THREE.Vector3;
  _qualityLocked?: boolean;
}

declare global {
  interface Window {
    game: Game;
    stepGame: (dt: number) => void;
    READY: boolean;
  }
}
