// The island as nodes: terrain, plants and village drawn through SceneObject (the render bridge's escape hatch for
// three.js content the game builds itself), and the same ground as physics, so the heroine, the camera and the swing all
// see what is drawn.
import { Behaviour, type Node, type World } from 'hull';
import { Collider, usePhysics } from 'hull/physics';
import { SceneObject } from 'hull/render';
import { LAYER } from 'hull/kits';
import { buildPlants } from './plants';
import { buildTerrain, terrainData } from './terrain';
import { buildVillage } from './village';
import { windU } from './wind';
import { groundHeight } from './map';

export interface IslandStats { plants: Record<string, number>; houses: number; terrainVerts: number }

/** Builds the island once in ready(). Its update only moves the wind's clock. */
export class Island extends Behaviour {
  stats: IslandStats = { plants: {}, houses: 0, terrainVerts: 0 };
  lights: { x: number; y: number; z: number }[] = [];

  override ready(): void {
    const w = this.world;
    const phys = usePhysics(w);
    const t = terrainData();
    phys.addHeightfield(t.heights, t.cols, t.rows, t.cell, { origin: t.origin, layer: LAYER.world, static: true });

    const draw = (name: string, obj: import('hull/three').Object3D): void => {
      const n = w.spawn(name, this.node);
      n.add(SceneObject, { object: obj });
    };
    draw('terrain', buildTerrain(t));
    const plants = buildPlants();
    draw('plants', plants.group);
    const village = buildVillage();
    draw('village', village.group);
    this.lights = village.lights;
    for (const b of village.blocks) {
      const n = w.spawn('building', this.node);
      n.position.set(b.x, b.y, b.z);
      n.add(Collider, { shape: { type: 'box', size: [b.sx, b.sy, b.sz] }, static: true, layer: LAYER.world });
    }
    // The sea is not walkable: a ring of invisible spheres keeps Aya on the island.
    const ring = 44;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      const n = w.spawn('shore', this.node);
      n.position.set(Math.cos(a) * 108, 2, Math.sin(a) * 96);
      n.add(Collider, { shape: { type: 'sphere', radius: 9 }, static: true, layer: LAYER.world });
    }
    this.stats = { plants: plants.counts, houses: village.blocks.length, terrainVerts: t.cols * t.rows };
  }

  override update(): void {
    windU.uTime.value = this.world.time;
  }
}

export function spawnIsland(world: World): Node {
  const n = world.spawn('island');
  n.add(Island);
  return n;
}

export { groundHeight };
