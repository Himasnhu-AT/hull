// A canvas for the textures the game paints in code. In a browser it is a real one; in Node (the headless tests) it is a
// stand-in whose 2D context accepts every call and keeps no pixels, so the same painting code runs and builds the same
// geometry and colliders, only without a picture.

const sink = (): unknown => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : sink()),
  set: () => true,
  apply: () => sink(),
});

function stubContext(canvas: object): unknown {
  const own: Record<string, unknown> = {
    canvas,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : sink()), set: () => true });
}

export function makeCanvas(width = 300, height = 150): HTMLCanvasElement {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  const c: Record<string, unknown> = { width, height, style: {} };
  c['getContext'] = () => stubContext(c);
  return c as unknown as HTMLCanvasElement;
}

/** A Path2D from SVG path text; in Node (no Path2D) a placeholder the stand-in context ignores. */
export function makePath(d?: string): Path2D {
  return typeof Path2D !== 'undefined' ? new Path2D(d) : (sink() as Path2D);
}
