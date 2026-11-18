// The render bridge. M0 carries only what `hull dev` needs to show the cube: a WebGL2 view of the node tree.
// M1 moves this behind the Backend interface from the build design, so games never touch three directly and
// the WebGPU backend can slot in. Until then, three lives only in this file.
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  type BufferGeometry,
  Mesh as ThreeMesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from 'three';
import { Behaviour, type Game, type Node } from '../core/index.ts';

function geometryFor(shape: 'box' | 'sphere' | 'plane'): BufferGeometry {
  switch (shape) {
    case 'box': return new BoxGeometry(1, 1, 1);
    case 'sphere': return new SphereGeometry(0.5, 32, 16);
    case 'plane': return new PlaneGeometry(1, 1);
  }
}

/** A solid shape of one colour, drawn at its node's transform. Set `shape` and `color` through `add(Mesh, {...})`. */
export class Mesh extends Behaviour {
  shape: 'box' | 'sphere' | 'plane' = 'box';
  color = '#cccccc';

  private view: ThreeMesh | null = null;
  private shown = '';

  // The view is built in ready(), after add()'s init values are in place.
  override ready(): void {
    this.view = new ThreeMesh(geometryFor(this.shape), new MeshStandardMaterial({ color: this.color }));
    this.shown = this.color;
    this.node.object3d.add(this.view);
  }

  // Colour changes (a tunable, a script) show on the next frame. Strings are compared, so nothing allocates.
  override update(): void {
    if (this.view && this.color !== this.shown) {
      (this.view.material as MeshStandardMaterial).color.set(this.color);
      this.shown = this.color;
    }
  }

  override dispose(): void {
    if (!this.view) return;
    this.view.removeFromParent();
    this.view.geometry.dispose();
    (this.view.material as MeshStandardMaterial).dispose();
    this.view = null;
  }
}

/** A perspective camera at its node's transform. `mountRender` draws through the first one it finds. */
export class Camera extends Behaviour {
  fov = 60;
  near = 0.1;
  far = 1000;

  /** The three camera; exists once the behaviour is ready. */
  view: PerspectiveCamera | null = null;

  override ready(): void {
    this.view = new PerspectiveCamera(this.fov, 1, this.near, this.far);
    this.node.object3d.add(this.view);
  }

  override dispose(): void {
    this.view?.removeFromParent();
    this.view = null;
  }
}

function firstCamera(node: Node): Camera | undefined {
  const own = node.get(Camera);
  if (own?.view) return own;
  for (const child of node.children) {
    const found = firstCamera(child);
    if (found) return found;
  }
  return undefined;
}

export function mountRender(game: Game, el: HTMLElement): { dispose(): void } {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.domElement.style.display = 'block';
  el.appendChild(renderer.domElement);

  // The scene is ours; the game's node tree hangs under it, next to a plain light rig.
  const scene = new Scene();
  scene.background = new Color('#14161b');
  const sun = new DirectionalLight('#ffffff', 2.2);
  sun.position.set(3, 5, 4);
  scene.add(new AmbientLight('#ffffff', 0.6), sun);
  const rootObject: Object3D = game.world.root.object3d;
  const previousParent = rootObject.parent;
  scene.add(rootObject);

  let width = 0;
  let height = 0;
  const resize = () => {
    width = Math.max(1, el.clientWidth);
    height = Math.max(1, el.clientHeight);
    renderer.setSize(width, height);
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(el);

  let raf = 0;
  let last = -1;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    // rAF hands over its own timestamp in ms; the simulation never reads a clock itself.
    const dt = last < 0 ? 0 : (now - last) / 1000;
    last = now;
    game.frame(dt);
    const cam = firstCamera(game.world.root);
    if (!cam?.view) return;
    cam.view.fov = cam.fov;
    cam.view.near = cam.near;
    cam.view.far = cam.far;
    cam.view.aspect = width / height;
    cam.view.updateProjectionMatrix();
    renderer.render(scene, cam.view);
  };
  raf = requestAnimationFrame(loop);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      scene.remove(rootObject);
      previousParent?.add(rootObject);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
