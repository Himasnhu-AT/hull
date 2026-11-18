// Shared geometry and material caches: a hundred boxes use one geometry, and every mesh that names
// `material/steel` shares one material that follows the config file live.
import { BoxGeometry, CapsuleGeometry, CylinderGeometry, MeshStandardMaterial, PlaneGeometry, SphereGeometry, type BufferGeometry } from 'three';
import { config } from '../config/index.ts';
import type { Material } from '../schema/material.ts';

export type Shape = 'box' | 'sphere' | 'plane' | 'capsule' | 'cylinder';

export interface MaterialParams {
  color: string;
  roughness: number;
  metalness: number;
}

/** What a Mesh asks for: a config id, or (when it has none) a plain colour. */
export interface MaterialSpec {
  material?: string | undefined;
  color?: string | undefined;
}

/** Key of the cache entry for a spec. Colours are lower-cased so '#FFF000' and '#fff000' share one material. */
export function materialKey(spec: MaterialSpec): string {
  if (spec.material) return `id:${spec.material}`;
  return `color:${(spec.color ?? '#cccccc').toLowerCase()}`;
}

/** The three numbers a material is drawn with, with the schema's defaults filled in. */
export function materialParams(def: Pick<Material, 'color'> & Partial<Material>): MaterialParams {
  return { color: def.color, roughness: def.roughness ?? 0.5, metalness: def.metalness ?? 0 };
}

interface Entry {
  readonly material: MeshStandardMaterial;
  refs: number;
  unwatch: (() => void) | null;
}

const materials = new Map<string, Entry>();
const reported = new Set<string>();

function apply(m: MeshStandardMaterial, p: MaterialParams): void {
  m.color.set(p.color);
  m.roughness = p.roughness;
  m.metalness = p.metalness;
}

function fullId(id: string): string {
  return id.startsWith('material/') ? id : `material/${id}`;
}

/** Reads `material/x` from config; reports a missing one once, by name, and returns undefined. */
function readConfig(id: string): MaterialParams | undefined {
  try {
    return materialParams(config.lookup('material', fullId(id).slice('material/'.length)));
  } catch {
    if (!reported.has(id)) {
      reported.add(id);
      console.warn(`[hull] render: material "${fullId(id)}" does not exist (a Mesh asks for it); drawing with its colour instead.`);
    }
    return undefined;
  }
}

/** Takes a shared material. Pair every call with `releaseMaterial` using the same spec. */
export function acquireMaterial(spec: MaterialSpec): MeshStandardMaterial {
  const key = materialKey(spec);
  let e = materials.get(key);
  if (e === undefined) {
    const m = new MeshStandardMaterial();
    const entry: Entry = { material: m, refs: 0, unwatch: null };
    e = entry;
    const id = spec.material;
    const fromConfig = id ? readConfig(id) : undefined;
    if (id && fromConfig) {
      apply(m, fromConfig);
      entry.unwatch = config.watch(fullId(id), (now) => apply(m, materialParams(now as Material)));
    } else {
      apply(m, { color: spec.color ?? '#cccccc', roughness: 0.5, metalness: 0 });
    }
    materials.set(key, e);
  }
  e.refs++;
  return e.material;
}

export function releaseMaterial(spec: MaterialSpec): void {
  const key = materialKey(spec);
  const e = materials.get(key);
  if (e === undefined) return;
  if (--e.refs > 0) return;
  e.unwatch?.();
  e.material.dispose();
  materials.delete(key);
}

const geometries = new Map<Shape, { geometry: BufferGeometry; refs: number }>();

function makeGeometry(shape: Shape): BufferGeometry {
  // Every shape is one unit across (a capsule is one unit tall), so a node's scale sizes it.
  switch (shape) {
    case 'box': return new BoxGeometry(1, 1, 1);
    // A plane lies flat, facing up: the usual floor.
    case 'plane': return new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    case 'sphere': return new SphereGeometry(0.5, 32, 16);
    case 'capsule': return new CapsuleGeometry(0.25, 0.5, 8, 16);
    case 'cylinder': return new CylinderGeometry(0.5, 0.5, 1, 24);
  }
}

export function acquireGeometry(shape: Shape): BufferGeometry {
  let e = geometries.get(shape);
  if (e === undefined) {
    e = { geometry: makeGeometry(shape), refs: 0 };
    geometries.set(shape, e);
  }
  e.refs++;
  return e.geometry;
}

export function releaseGeometry(shape: Shape): void {
  const e = geometries.get(shape);
  if (e === undefined || --e.refs > 0) return;
  e.geometry.dispose();
  geometries.delete(shape);
}

/** For tests and the Studio's stats: how many shared objects are alive. */
export function cacheSizes(): { materials: number; geometries: number } {
  return { materials: materials.size, geometries: geometries.size };
}
