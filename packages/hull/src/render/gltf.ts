// Loading glTF and GLB files from assets/ with three's own loader. One parsed copy per file is kept; every Model or
// character body that uses the file gets its own clone (skeleton and bones included) that shares the geometry and
// materials. three comes from the engine's one copy ('three' is aliased in dev and in a build), and the addon is
// imported from three's package like hull/three does, so the backends and the loader agree on every class.
import { LoadingManager, type AnimationClip, type Group, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { assetUrl, clean, hasAsset, readAsset } from './assets.ts';

export interface LoadedModel {
  readonly file: string;
  readonly scene: Group;
  readonly animations: readonly AnimationClip[];
}

const done = new Map<string, LoadedModel>();
const pending = new Map<string, Promise<LoadedModel>>();
const failed = new Map<string, Error>();

/** Parses bytes that are already in memory (tests, tools). `file` names the model in messages and keys the cache. */
export function parseModel(file: string, bytes: ArrayBuffer): Promise<LoadedModel> {
  const key = clean(file);
  const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
  // Files a .gltf names (its .bin, its textures) are looked up in assets/ the same way as the model itself.
  const manager = new LoadingManager();
  manager.setURLModifier((url) => (hasAsset(url) ? (assetUrl(url) ?? url) : url));
  const loader = new GLTFLoader(manager);
  return new Promise<LoadedModel>((resolve, reject) => {
    const fail = (err: unknown): void => reject(new Error(`assets/${key} is not a valid glTF: ${err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err)}`));
    try {
      loader.parse(
        bytes,
        `assets/${dir}`,
        (gltf) => {
          const m: LoadedModel = { file: key, scene: gltf.scene, animations: gltf.animations };
          done.set(key, m);
          resolve(m);
        },
        fail,
      );
    } catch (e) {
      fail(e);
    }
  });
}

/** Loads a model once; later calls share the result. Rejects with a sentence naming the file. */
export function loadModel(file: string): Promise<LoadedModel> {
  const key = clean(file);
  const have = done.get(key);
  if (have) return Promise.resolve(have);
  const bad = failed.get(key);
  if (bad) return Promise.reject(bad);
  let p = pending.get(key);
  if (!p) {
    p = readAsset(key)
      .then((bytes) => parseModel(key, bytes))
      .catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        failed.set(key, err);
        throw err;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

/** The parsed model if it has been loaded already; undefined otherwise. */
export function loadedModel(file: string): LoadedModel | undefined {
  return done.get(clean(file));
}

/** Loads every file; the game's `ready` can await it so the first frame already has its models. */
export async function preloadModels(files: readonly string[]): Promise<void> {
  await Promise.all(files.map((f) => loadModel(f)));
}

/** Forgets a file so the next load reads it again (a replaced file in the Studio, or a test). */
export function forgetModel(file: string): void {
  const key = clean(file);
  done.delete(key);
  failed.delete(key);
  pending.delete(key);
}

/** An independent copy of the model's scene: its own nodes and bones, the cached geometry and materials. */
export function instantiate(m: LoadedModel): Object3D {
  return clone(m.scene);
}
