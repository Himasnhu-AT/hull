// AOTT world builder. buildWorld(game) -> WorldHandle { playerSpawn, supplyDepots, titanSpawns, sun, update, ... }:
// the Ashwall and its gate, Varn behind it, the plain beyond and the Greatwood.
import * as THREE from 'hull/three';
import type { Game, WorldHandle } from '../types';
import { createContext, SUN_DIR, FOG_COLOR } from './common';
import { buildSky } from './sky';
import { buildGround } from './terrain';
import { buildWall } from './wall';
import { buildTown } from './town';
import { buildField } from './field';
import { buildForest } from './forest';
import { buildFlags } from './flags';
import { foliageFade } from './trees';
import { buildGrass, paintGroundMaterial } from './grass';
import type { GrassHandle } from './grass';

/**
 * One atmosphere (world.setAtmosphere). sky: dome horizon / mid / zenith; fog: colour, near, far; glow: the colour of
 * the sun disc and its halo; tint: multiplies the mountains and clouds; canopy: tints the haze under the forest canopy.
 * The sun and the hemisphere light are not here: they belong to the engine's look of the same name
 * (config/look/<name>.json), which also carries the shadows. look.test.ts keeps the two in step.
 */
interface Atmosphere {
  sky: [number, number, number]; fog: [number, number, number];
  glow: number; tint: number; canopy: number;
}
const ATMOS: Record<string, Atmosphere> = {
  // clear midday: warm sun, cool sky fill, a pale blue-grey haze on the horizon
  day: { sky: [FOG_COLOR, 0x8fb2d6, 0x3d6aa8], fog: [FOG_COLOR, 140, 1500], glow: 0xfff0d8, tint: 0xffffff, canopy: 0xffffff },
  // Varn under attack: a smoke-hazed amber afternoon, the light thick and warm, the far town lost in haze
  varn: { sky: [0x9c8c7c, 0x928883, 0x56606f], fog: [0x9c8c7c, 150, 1900], glow: 0xffc890, tint: 0xb8a28e, canopy: 0xd8c0a0 },
  // the expedition rides out in the early morning: low golden light, a pale sky, a long soft haze
  dawn: { sky: [0xdcc3ab, 0xb2b6c2, 0x52709c], fog: [0xd6c1ac, 90, 1200], glow: 0xffc890, tint: 0xeed7c2, canopy: 0xf2e4cc },
};

export interface World extends WorldHandle {
  sunDirection: THREE.Vector3;
  fogColor: THREE.Color;
  inFoliage(pos: THREE.Vector3): boolean;
  setFoliageFocus(pos: THREE.Vector3 | null): void;
  setAtmosphere(name: string): void;
  stats: { box: number; cyl: number; cap: number; sph: number; trees: number; grassTufts: number };
  grass: GrassHandle;
  pressGrass(pos: THREE.Vector3, radius?: number, strength?: number, lasting?: boolean): void;
  setGate(open: boolean, burst?: boolean): void;
  smash(at: THREE.Vector3, radius: number): number;
  rebuildTown(): void;
  readonly gateOpen: boolean;
}

export function buildWorld(game: Game): World {
  const ctx = createContext(game);
  const scene = game.scene;

  // No lights here: the sun, the hemisphere and the shadows come from the engine's look (config/look/*.json).
  const skyRefs = buildSky(ctx);
  buildGround(ctx);
  paintGroundMaterial(ctx.mat.grass);
  const grass = buildGrass(ctx);
  buildWall(ctx);
  buildTown(ctx);
  buildField(ctx);
  const forest = buildForest(ctx);
  buildFlags(ctx);

  const fog = scene.fog as THREE.Fog, bg = scene.background as THREE.Color;
  const world: World = {
    playerSpawn: { position: new THREE.Vector3(0, 50.6, 0), yaw: 0 },   // wall-top surface (y = 50) + 0.6
    supplyDepots: ctx.depots,
    titanSpawns: ctx.titanSpawns,
    sunDirection: SUN_DIR.clone(), fogColor: new THREE.Color(FOG_COLOR),
    inFoliage: (pos) => ctx.foliage.test(pos),
    /** Thin out leaves between the camera and `pos` (the soldier); null turns it off (menus). */
    setFoliageFocus(pos) { if (pos) foliageFade.focus.value.copy(pos); foliageFade.fade.value = pos ? 1 : 0; },
    stats: Object.assign(ctx.stats, { trees: forest.trees, grassTufts: grass.instances }),
    grass,
    /** Flatten the grass tufts round pos (world) out to radius m; strength 0..1; lasting = slow to spring back. */
    pressGrass: (pos, radius, strength, lasting) => grass.press(pos, radius, strength, lasting),
    /** Bring down the houses of Varn within `radius` of a point; returns how many came down. */
    smash(at, radius) { return ctx.smash ? ctx.smash(at, radius) : 0; },
    /** Stand every house up again (a new run starts with the town whole). */
    rebuildTown() { ctx.rebuild?.(); },
    /** The gate: true = breached (the wreck and the rubble), false = shut (the doors stand). */
    setGate(open, burst) { ctx.gate?.set(open); if (open && burst) ctx.gate?.burst(); },
    get gateOpen() { return ctx.gate?.open ?? true; },
    /** Sky, fog and light for a mode or a mission: 'day' (default), 'varn', 'dawn'. */
    setAtmosphere(name) {
      if (world.atmosphere === name) return;
      const a = ATMOS[name] || ATMOS.day, d = skyRefs.dome;
      world.atmosphere = name;
      d.cHorizon.value.set(a.sky[0]); d.cMid.value.set(a.sky[1]); d.cZenith.value.set(a.sky[2]); d.cSun.value.set(a.glow);
      ctx.atmo.fog.set(a.fog[0]); ctx.atmo.near = a.fog[1]; ctx.atmo.far = a.fog[2]; ctx.atmo.canopy.set(a.canopy);
      fog.color.copy(ctx.atmo.fog); fog.near = a.fog[1]; fog.far = a.fog[2];
      bg.copy(ctx.atmo.fog);
      world.fogColor.copy(ctx.atmo.fog);
      skyRefs.tint.set(a.tint);
    },
    update(dt, camPos) {
      ctx.time.value += dt;
      for (const u of ctx.updaters) u(dt, camPos);
    },
  };
  world.setAtmosphere('day');
  return world;
}
