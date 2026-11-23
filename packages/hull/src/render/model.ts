// Model: draws a glTF or GLB file from the project's assets/ folder. It goes through the same bridge as Mesh (the node's
// Object3D), so both backends draw it. Materials come from the file; `material` or `color` replaces every material.
// A file is read once and parsed once; each Model gets its own clone that shares the geometry. The model appears when
// the file has loaded (at once if a game awaited preloadModels in its `ready`). Without a renderer it only holds the
// scene, like Mesh, and does not throw.
import { Mesh as ThreeMesh, Object3D, type Material } from 'three';
import { Behaviour } from '../core/index.ts';
import { acquireMaterial, releaseMaterial, type MaterialSpec } from './materials.ts';
import { instantiate, loadedModel, loadModel, type LoadedModel } from './gltf.ts';
import { stateFor } from './interp.ts';

const told = new Set<string>();
function warnOnce(message: string): void {
  if (told.has(message)) return;
  told.add(message);
  console.warn(`[hull] render: ${message}`);
}

export class Model extends Behaviour {
  /** A path inside assets/, like 'models/crate.glb'. A change shows on the next frame. */
  file = '';
  /** 'material/steel': draws every part with this material instead of the file's own. */
  material: string | undefined = undefined;
  /** A plain colour for every part, when there is no `material`. Leave both unset to keep the file's materials. */
  color: string | undefined = undefined;
  castShadow = true;
  receiveShadow = true;

  /** The model's scene once it has loaded (a three Object3D); null before that and after an error. */
  view: Object3D | null = null;
  /** What went wrong, by file; undefined when fine. */
  problem: string | undefined = undefined;

  private heldFile = '';
  private heldMaterial: string | undefined = undefined;
  private heldColor: string | undefined = undefined;
  private overrideSpec: MaterialSpec | null = null;
  private meshes: { mesh: ThreeMesh; original: Material | Material[] }[] = [];
  private token = 0;

  get loaded(): boolean {
    return this.view !== null;
  }

  override ready(): void {
    stateFor(this.world).interp.track(this.node);
    this.start();
  }

  override update(): void {
    if (this.file !== this.heldFile) { this.start(); return; }
    if (this.view && (this.material !== this.heldMaterial || this.color !== this.heldColor)) this.applyOverride();
    for (const r of this.meshes) {
      r.mesh.castShadow = this.castShadow;
      r.mesh.receiveShadow = this.receiveShadow;
    }
  }

  override dispose(): void {
    this.token++;
    this.clear();
  }

  private start(): void {
    this.clear();
    this.heldFile = this.file;
    const token = ++this.token;
    if (this.file === '') { this.problem = 'a Model has no file'; warnOnce(`the Model on "${this.node.name}" has no \`file\`, so it draws nothing.`); return; }
    const have = loadedModel(this.file);
    if (have) { this.adopt(have); return; }
    loadModel(this.file).then(
      (m) => { if (token === this.token) this.adopt(m); },
      (e: unknown) => {
        if (token !== this.token) return;
        this.problem = e instanceof Error ? e.message : String(e);
        warnOnce(`the Model on "${this.node.name}" could not load \`${this.file}\`: ${this.problem}`);
      },
    );
  }

  private adopt(m: LoadedModel): void {
    this.problem = undefined;
    const view = instantiate(m);
    view.traverse((o) => {
      const mesh = o as ThreeMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = this.receiveShadow;
      // A skinned mesh's bounds are those of its bind pose; do not cull it while it moves.
      if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) mesh.frustumCulled = false;
      this.meshes.push({ mesh, original: mesh.material });
    });
    this.view = view;
    this.node.object3d.add(view);
    this.applyOverride();
  }

  private applyOverride(): void {
    this.heldMaterial = this.material;
    this.heldColor = this.color;
    const old = this.overrideSpec;
    this.overrideSpec = null;
    if (this.material !== undefined || this.color !== undefined) {
      const spec: MaterialSpec = { material: this.material, color: this.color ?? '#cccccc' };
      const next = acquireMaterial(spec);
      for (const r of this.meshes) r.mesh.material = next;
      this.overrideSpec = spec;
    } else {
      for (const r of this.meshes) r.mesh.material = r.original;
    }
    if (old) releaseMaterial(old);
  }

  private clear(): void {
    if (this.overrideSpec) releaseMaterial(this.overrideSpec);
    this.overrideSpec = null;
    this.view?.removeFromParent();
    this.view = null;
    this.meshes.length = 0;
    this.problem = undefined;
  }
}
