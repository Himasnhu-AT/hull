// Render-side debug lines for dev: `debug.line(a, b, color)` shows a line in the next drawn frame only, so a
// game calls it every frame from `update`. It draws nothing while no backend is mounted.
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineSegments } from 'three';

interface Vec3 { x: number; y: number; z: number }

const tint = new Color();

class DebugLines {
  readonly object: LineSegments;
  private readonly geometry = new BufferGeometry();
  private positions = new Float32Array(3 * 2 * 256);
  private colors = new Float32Array(3 * 2 * 256);
  private count = 0;
  /** Backends mounted right now; with none, `line` returns at once so nothing piles up. */
  private users = 0;

  constructor() {
    this.object = new LineSegments(this.geometry, new LineBasicMaterial({ vertexColors: true, fog: false }));
    this.object.frustumCulled = false;
    this.object.renderOrder = 1000;
    this.object.visible = false;
    this.bind();
  }

  line(a: Vec3, b: Vec3, color: string | number = 0xffffff): void {
    if (this.users === 0) return;
    if (this.count * 6 === this.positions.length) this.grow();
    if (typeof color === 'number') tint.setHex(color);
    else tint.set(color);
    const o = this.count * 6;
    const p = this.positions;
    const c = this.colors;
    p[o] = a.x; p[o + 1] = a.y; p[o + 2] = a.z;
    p[o + 3] = b.x; p[o + 4] = b.y; p[o + 5] = b.z;
    c[o] = tint.r; c[o + 1] = tint.g; c[o + 2] = tint.b;
    c[o + 3] = tint.r; c[o + 4] = tint.g; c[o + 5] = tint.b;
    this.count++;
  }

  /** Called by a backend before it draws. */
  upload(): void {
    this.object.visible = this.count > 0;
    this.geometry.setDrawRange(0, this.count * 2);
    this.geometry.attributes['position']!.needsUpdate = true;
    this.geometry.attributes['color']!.needsUpdate = true;
  }

  /** Called by a backend after it draws: lines last one frame. */
  clear(): void {
    this.count = 0;
    this.object.visible = false;
  }

  attach(): void {
    this.users++;
  }

  detach(): void {
    if (--this.users <= 0) {
      this.users = 0;
      this.count = 0;
    }
  }

  private grow(): void {
    const p = new Float32Array(this.positions.length * 2);
    p.set(this.positions);
    this.positions = p;
    const c = new Float32Array(this.colors.length * 2);
    c.set(this.colors);
    this.colors = c;
    this.bind();
  }

  private bind(): void {
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new BufferAttribute(this.colors, 3));
  }
}

const lines = new DebugLines();

/** Dev drawing. Anything added here shows for one frame. */
export const debug = {
  line(a: Vec3, b: Vec3, color?: string | number): void {
    lines.line(a, b, color);
  },
};

/** @internal For backends. */
export const debugLines: Pick<DebugLines, 'object' | 'upload' | 'clear' | 'attach' | 'detach'> = lines;
