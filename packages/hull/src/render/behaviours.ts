// The behaviours a game adds to nodes to be seen: Mesh, Camera, Light, and `instances` for many copies of one
// mesh. Options are plain data; three.js objects stay inside this folder.
import {
  AmbientLight,
  DirectionalLight,
  Euler,
  InstancedMesh,
  Matrix4,
  Mesh as ThreeMesh,
  Object3D,
  PerspectiveCamera,
  PointLight,
  Quaternion,
  Vector3,
  type Light as ThreeLight,
} from 'three';
import { Behaviour, type Node } from '../core/index.ts';
import { stateFor } from './interp.ts';
import { acquireGeometry, acquireMaterial, releaseGeometry, releaseMaterial, type MaterialSpec, type Shape } from './materials.ts';

/** A solid shape. `material` is the id of a `material/*` config file and follows it live; without one, `color` is used. */
export class Mesh extends Behaviour {
  shape: Shape = 'box';
  /** 'material/steel'. Wins over `color` when set and the file exists. */
  material: string | undefined = undefined;
  color = '#cccccc';
  castShadow = true;
  receiveShadow = true;

  private view: ThreeMesh | null = null;
  private heldShape: Shape = 'box';
  private heldColor = '';
  private heldMaterial: string | undefined = undefined;

  // The view is built in ready(), after add()'s init values are in place.
  override ready(): void {
    this.heldShape = this.shape;
    this.heldColor = this.color;
    this.heldMaterial = this.material;
    this.view = new ThreeMesh(acquireGeometry(this.shape), acquireMaterial(this.spec()));
    this.view.castShadow = this.castShadow;
    this.view.receiveShadow = this.receiveShadow;
    this.node.object3d.add(this.view);
    stateFor(this.world).interp.track(this.node);
  }

  // Changes from a tunable, a script or the Inspector show on the next frame. Plain comparisons: nothing allocates.
  override update(): void {
    const view = this.view;
    if (!view) return;
    if (this.shape !== this.heldShape) {
      releaseGeometry(this.heldShape);
      view.geometry = acquireGeometry(this.shape);
      this.heldShape = this.shape;
    }
    if (this.color !== this.heldColor || this.material !== this.heldMaterial) {
      const next = acquireMaterial(this.spec());
      releaseMaterial({ material: this.heldMaterial, color: this.heldColor });
      view.material = next;
      this.heldColor = this.color;
      this.heldMaterial = this.material;
    }
    view.castShadow = this.castShadow;
    view.receiveShadow = this.receiveShadow;
  }

  override dispose(): void {
    if (!this.view) return;
    this.view.removeFromParent();
    releaseGeometry(this.heldShape);
    releaseMaterial({ material: this.heldMaterial, color: this.heldColor });
    this.view = null;
  }

  private spec(): MaterialSpec {
    return { material: this.material, color: this.color };
  }
}

/** A perspective camera at its node's transform. The first active one in the tree is the one drawn through. */
export class Camera extends Behaviour {
  fov = 60;
  near = 0.1;
  far = 1000;
  /** Turn a camera off to hand the screen to the next one in the tree. */
  active = true;

  /** The three camera; exists once the behaviour is ready. */
  view: PerspectiveCamera | null = null;

  override ready(): void {
    this.view = new PerspectiveCamera(this.fov, 1, this.near, this.far);
    this.node.object3d.add(this.view);
    stateFor(this.world).interp.track(this.node);
  }

  override dispose(): void {
    this.view?.removeFromParent();
    this.view = null;
  }
}

/** The node of the first active camera in the tree, in tree order, or null. */
export function activeCamera(root: Node): Node | null {
  const own = root.get(Camera);
  if (own?.view && own.active) return root;
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) {
    const found = activeCamera(kids[i]!);
    if (found) return found;
  }
  return null;
}

/**
 * A light at its node. A sun shines along the node's forward (-Z) and can cast shadows over `shadowSize` metres
 * around the node; a point light is round; ambient lights everything equally. While a sun Light exists, the
 * `look`'s own sun is switched off, so there is only ever one.
 */
export class Light extends Behaviour {
  type: 'sun' | 'point' | 'ambient' = 'point';
  color = '#ffffff';
  intensity = 1;
  /** Sun and point lights only. */
  castShadow = false;
  /** Sun: half the width of the shadowed square, in metres. */
  shadowSize = 40;
  /** Point: reach in metres; 0 means unlimited. */
  range = 0;

  private view: ThreeLight | null = null;
  private heldColor = '';
  private heldIntensity = -1;
  private heldShadow = false;
  private heldSize = 0;
  private heldRange = -1;

  override ready(): void {
    switch (this.type) {
      case 'ambient':
        this.view = new AmbientLight(this.color, this.intensity);
        break;
      case 'point':
        this.view = new PointLight(this.color, this.intensity, this.range, 2);
        break;
      case 'sun': {
        const sun = new DirectionalLight(this.color, this.intensity);
        // The target is a child at the node's forward, so rotating the node aims the light.
        sun.target.position.set(0, 0, -1);
        sun.add(sun.target);
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 400;
        sun.shadow.bias = -0.0005;
        sun.shadow.normalBias = 0.02;
        sun.shadow.mapSize.set(2048, 2048);
        this.view = sun;
        stateFor(this.world).suns++;
        break;
      }
    }
    this.node.object3d.add(this.view);
    stateFor(this.world).interp.track(this.node);
    this.heldColor = this.color;
    this.heldIntensity = this.intensity;
    this.heldShadow = !this.castShadow;
    this.heldSize = -1;
    this.heldRange = this.range;
    this.update();
  }

  override update(): void {
    const view = this.view;
    if (!view) return;
    if (this.color !== this.heldColor) {
      view.color.set(this.color);
      this.heldColor = this.color;
    }
    if (this.intensity !== this.heldIntensity) {
      view.intensity = this.intensity;
      this.heldIntensity = this.intensity;
    }
    if (this.castShadow !== this.heldShadow) {
      if (view instanceof DirectionalLight || view instanceof PointLight) view.castShadow = this.castShadow;
      this.heldShadow = this.castShadow;
    }
    if (view instanceof DirectionalLight && this.shadowSize !== this.heldSize) {
      const c = view.shadow.camera;
      const r = this.shadowSize;
      c.left = -r; c.right = r; c.top = r; c.bottom = -r;
      c.updateProjectionMatrix();
      this.heldSize = this.shadowSize;
    }
    if (view instanceof PointLight && this.range !== this.heldRange) {
      view.distance = this.range;
      this.heldRange = this.range;
    }
  }

  override dispose(): void {
    if (!this.view) return;
    if (this.type === 'sun') stateFor(this.world).suns--;
    this.view.removeFromParent();
    this.view.dispose();
    this.view = null;
  }
}

interface Vec3 { x: number; y: number; z: number }

export interface InstancesOptions {
  shape: Shape;
  /** 'material/x' config id; without it, `color`. */
  material?: string;
  color?: string;
  /** Capacity: the most copies this handle can ever show. */
  max: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** Many copies of one mesh drawn in one call. The handle writes straight into the GPU buffer's source: no allocation. */
export interface Instances {
  /** How many copies are drawn, 0 to `max`. */
  count: number;
  readonly max: number;
  /** Copy `i` at a position, Euler rotation (radians) and scale (one number, or per axis). */
  set(i: number, pos: Vec3, rot?: Vec3, scale?: number | Vec3): void;
  dispose(): void;
}

const _e = new Euler();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _m = new Matrix4();

/** Instanced copies hang under `parent`, so moving that node moves them all. Copies are not interpolated: set them each frame. */
export function instances(parent: Node, opts: InstancesOptions): Instances {
  const spec: MaterialSpec = { material: opts.material, color: opts.color ?? '#cccccc' };
  const mesh = new InstancedMesh(acquireGeometry(opts.shape), acquireMaterial(spec), opts.max);
  mesh.count = 0;
  // Per-instance bounds are unknown to three, so culling the whole mesh as one sphere would pop copies out.
  mesh.frustumCulled = false;
  mesh.castShadow = opts.castShadow ?? true;
  mesh.receiveShadow = opts.receiveShadow ?? true;
  const holder: Object3D = parent.object3d;
  holder.add(mesh);
  let alive = true;
  return {
    get count() {
      return mesh.count;
    },
    set count(n: number) {
      mesh.count = Math.max(0, Math.min(n, opts.max));
    },
    max: opts.max,
    set(i, pos, rot, scale) {
      _p.set(pos.x, pos.y, pos.z);
      if (rot) {
        _e.set(rot.x, rot.y, rot.z);
        _q.setFromEuler(_e);
      } else {
        _q.identity();
      }
      if (scale === undefined) _s.set(1, 1, 1);
      else if (typeof scale === 'number') _s.set(scale, scale, scale);
      else _s.set(scale.x, scale.y, scale.z);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      if (!alive) return;
      alive = false;
      mesh.removeFromParent();
      mesh.dispose();
      releaseGeometry(opts.shape);
      releaseMaterial(spec);
    },
  };
}
