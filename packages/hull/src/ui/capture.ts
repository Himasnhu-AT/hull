// Draws the UI layer into a picture so a screenshot shows the HUD, the pause screen and the game-over screen, not
// only the WebGL canvas. The DOM is turned into an SVG <foreignObject> with each element's computed style written
// inline, then painted over the canvas image. No dependency, and the same page gives the same pixels.
// Limits, on purpose: pseudo-elements (::before/::after), <img> pictures and web fonts the page loaded are not in the
// picture (an SVG used as an image cannot fetch anything). The UI kit uses none of them for text or bars.

/** The part of a DOM element the walk reads: small, so a test can hand in plain objects. */
export interface CaptureNode {
  nodeType: number;
  tagName?: string;
  textContent: string | null;
  childNodes: ArrayLike<CaptureNode>;
}
export type StyleReader = (el: CaptureNode) => { length: number; item(i: number): string; getPropertyValue(name: string): string };

const XHTML = 'http://www.w3.org/1999/xhtml';
const VOID = new Set(['img', 'br', 'hr', 'input']);

const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => escText(s).replace(/"/g, '&quot;');

function walk(el: CaptureNode, read: StyleReader, root: boolean, w: number, h: number): string {
  const tag = (el.tagName ?? 'div').toLowerCase();
  const cs = read(el);
  if (cs.getPropertyValue('display') === 'none') return '';
  let style = '';
  for (let i = 0; i < cs.length; i++) {
    const name = cs.item(i);
    const v = cs.getPropertyValue(name);
    if (v !== '') style += `${name}:${v};`;
  }
  // The layer is placed at the corner and sized to the game view, whatever the page put around it.
  if (root) style += `position:absolute;left:0;top:0;margin:0;width:${w}px;height:${h}px;`;
  const open = `<${tag} style="${escAttr(style)}"`;
  if (VOID.has(tag)) return `${open}/>`;
  let inner = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]!;
    if (c.nodeType === 1) inner += walk(c, read, false, w, h);
    else if (c.nodeType === 3) inner += escText(c.textContent ?? '');
  }
  return `${open}>${inner}</${tag}>`;
}

/** An SVG document, `width` by `height` CSS pixels, holding `host` and everything under it as it looks now. */
export function uiSvg(host: CaptureNode, read: StyleReader, width: number, height: number): string {
  const body = walk(host, read, true, width, height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="${XHTML}" style="position:relative;width:${width}px;height:${height}px;overflow:hidden">${body}</div></foreignObject></svg>`;
}

/** The picture `canvasPng` with the `.hull-ui` layers of `doc` painted over it, as a PNG. Throws when the browser cannot draw the layer. */
export async function withUi(canvasPng: Blob, doc: Document): Promise<Blob> {
  const hosts = Array.from(doc.querySelectorAll<HTMLElement>('.hull-ui'));
  if (hosts.length === 0) return canvasPng;
  const win = doc.defaultView!;
  const base = await createImageBitmap(canvasPng);
  try {
    const out = doc.createElement('canvas');
    out.width = base.width;
    out.height = base.height;
    const g = out.getContext('2d');
    if (!g) throw new Error('screenshot: no 2d canvas to draw the UI layer on');
    g.drawImage(base, 0, 0);
    for (const host of hosts) {
      // A bar mid-transition reports a style from the wall clock; jump every running transition to its end so two
      // captures of the same game state give the same pixels.
      for (const a of host.getAnimations({ subtree: true })) a.finish();
      const r = host.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const svg = uiSvg(host, (e) => win.getComputedStyle(e as unknown as Element), r.width, r.height);
      // A data: URL, not a blob: URL: a canvas that drew an SVG from a blob URL is marked tainted and cannot be exported.
      const img = new win.Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      g.drawImage(img, 0, 0, base.width, base.height);
    }
    return await new Promise<Blob>((ok, no) => out.toBlob((b) => (b ? ok(b) : no(new Error('screenshot: the canvas gave no PNG'))), 'image/png'));
  } finally {
    base.close();
  }
}
