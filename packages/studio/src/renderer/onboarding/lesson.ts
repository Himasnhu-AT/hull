// Lesson format and validator for the onboarding whiteboard. The format is the whiteboard-ai-tutor protocol (v1):
// a 1600 x 900 board, 5-8 steps, at most 12 ops per step, ids unique over the whole lesson.
// Pure TypeScript with no DOM, so the unit tests run it in Node over every lesson.

export const BOARD_W = 1600;
export const BOARD_H = 900;
export const MARGIN = 40;
export const COLOR_NAMES = ['ink', 'blue', 'red', 'green', 'gray'] as const;
export type ColorName = (typeof COLOR_NAMES)[number];

export interface WriteOp { op: 'write'; id: string; x: number; y: number; text: string; size?: number; color?: ColorName; anchor?: 'start' | 'middle'; underline?: boolean }
export interface LineOp { op: 'line'; id: string; x1: number; y1: number; x2: number; y2: number; color?: ColorName; width?: number; arrow?: boolean | 'both'; dash?: boolean }
export interface RectOp { op: 'rect'; id: string; x: number; y: number; w: number; h: number; color?: ColorName; width?: number; fill?: ColorName; dash?: boolean }
export interface EllipseOp { op: 'ellipse'; id: string; cx: number; cy: number; rx: number; ry: number; rotate?: number; color?: ColorName; width?: number; fill?: ColorName; dash?: boolean }
export interface PathOp { op: 'path'; id: string; d: string; color?: ColorName; width?: number; fill?: ColorName; arrow?: boolean | 'both'; dash?: boolean }
export interface EraseOp { op: 'erase'; ids?: string[]; region?: { x: number; y: number; w: number; h: number }; all?: boolean }
export type Op = WriteOp | LineOp | RectOp | EllipseOp | PathOp | EraseOp;
export type DrawOp = Exclude<Op, EraseOp>;

export interface Step { title: string; say: string; ops: Op[] }
export interface Lesson { title: string; lang: string; steps: Step[] }

export interface Box { x: number; y: number; w: number; h: number }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isColor = (v: unknown): boolean => typeof v === 'string' && (COLOR_NAMES as readonly string[]).includes(v);
const isCjk = (ch: string): boolean => { const c = ch.codePointAt(0) ?? 0; return c >= 0x3400 && c <= 0x9fff; };

/** Width of one line of handwriting: a Latin character is about size * 0.5, a CJK character size * 1.0. */
export function lineWidth(line: string, size: number): number {
  let w = 0;
  for (const ch of line) w += isCjk(ch) ? size : size * 0.5;
  return w;
}

/** Box of a text op: x,y is the top-left, or the centre of the top edge with anchor "middle". Line height is size * 1.3. */
export function textBox(op: WriteOp): Box {
  const size = op.size ?? 40;
  const lines = op.text.split('\n');
  const w = Math.max(0, ...lines.map((l) => lineWidth(l, size)));
  const h = lines.length * size * 1.3;
  return { x: op.anchor === 'middle' ? op.x - w / 2 : op.x, y: op.y, w, h };
}

/** The points of a path with absolute commands (M L H V C Q A Z): every coordinate pair, the end point of an arc. */
function pathPoints(d: string): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const re = /([MLHVCQAZ])([^MLHVCQAZ]*)/gi;
  let m: RegExpExecArray | null;
  let cx = 0;
  let cy = 0;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1]!.toUpperCase();
    const n = (m[2] ?? '').trim().split(/[\s,]+/).filter((s) => s !== '').map(Number);
    if (n.some((v) => !Number.isFinite(v))) continue;
    if (cmd === 'H') for (const v of n) { cx = v; pts.push({ x: cx, y: cy }); }
    else if (cmd === 'V') for (const v of n) { cy = v; pts.push({ x: cx, y: cy }); }
    else if (cmd === 'A') {
      // rx ry rotation large sweep x y: the end point counts; a full ellipse has its own op.
      for (let i = 0; i + 7 <= n.length; i += 7) { cx = n[i + 5]!; cy = n[i + 6]!; pts.push({ x: cx, y: cy }); }
    } else {
      for (let i = 0; i + 1 < n.length; i += 2) { cx = n[i]!; cy = n[i + 1]!; pts.push({ x: cx, y: cy }); }
    }
  }
  return pts;
}

/** Bounding box of an op as it will be drawn, stroke width and arrow heads included. Null for erase. */
export function opBox(op: Op): Box | null {
  if (op.op === 'erase') return null;
  if (op.op === 'write') {
    const b = textBox(op);
    return op.underline ? { ...b, h: b.h + 8 } : b;
  }
  const w = op.width ?? 5;
  // Arrow heads reach back about 16 + 2.2 * width from the tip.
  const head = 'arrow' in op && op.arrow ? 16 + w * 2.2 : 0;
  const pad = w / 2 + head * 0.5;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number): void => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  if (op.op === 'line') { add(op.x1, op.y1); add(op.x2, op.y2); }
  else if (op.op === 'rect') { add(op.x, op.y); add(op.x + op.w, op.y + op.h); }
  else if (op.op === 'ellipse') {
    const th = ((op.rotate ?? 0) * Math.PI) / 180;
    const hw = Math.hypot(op.rx * Math.cos(th), op.ry * Math.sin(th));
    const hh = Math.hypot(op.rx * Math.sin(th), op.ry * Math.cos(th));
    add(op.cx - hw, op.cy - hh); add(op.cx + hw, op.cy + hh);
  } else for (const p of pathPoints(op.d)) add(p.x, p.y);
  if (x0 > x1) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const NEED: Record<string, string[]> = { write: ['x', 'y'], line: ['x1', 'y1', 'x2', 'y2'], rect: ['x', 'y', 'w', 'h'], ellipse: ['cx', 'cy', 'rx', 'ry'], path: [] };

/** Everything wrong with a lesson, as plain sentences naming the step and op. Empty when the lesson is fine. */
export function validateLesson(input: unknown): string[] {
  const out: string[] = [];
  if (typeof input !== 'object' || input === null) return ['the lesson is not an object'];
  const l = input as Partial<Lesson>;
  if (typeof l.title !== 'string' || l.title.trim() === '') out.push('title is missing');
  if (l.lang !== 'en' && l.lang !== 'zh') out.push('lang must be "en" or "zh"');
  if (!Array.isArray(l.steps)) return [...out, 'steps must be an array'];
  if (l.steps.length < 5 || l.steps.length > 8) out.push(l.steps.length + ' steps; the protocol asks for 5 to 8');

  const seen = new Set<string>();
  const live = new Map<string, { op: DrawOp; box: Box }>();
  l.steps.forEach((st, si) => {
    const at = 'step ' + (si + 1);
    if (typeof st !== 'object' || st === null) { out.push(at + ' is not an object'); return; }
    if (typeof st.title !== 'string' || st.title.trim() === '') out.push(at + ': title is missing');
    if (typeof st.say !== 'string' || st.say.trim() === '') out.push(at + ': say is missing');
    else if ((st.say.match(/[.!?](\s|$)/g) ?? []).length > 2) out.push(at + ': say is longer than two sentences');
    if (!Array.isArray(st.ops)) { out.push(at + ': ops must be an array'); return; }
    if (st.ops.length > 12) out.push(at + ': ' + st.ops.length + ' ops; at most 12');
    st.ops.forEach((op, oi) => {
      const where = at + ' op ' + (oi + 1);
      if (typeof op !== 'object' || op === null) { out.push(where + ': not an object'); return; }
      if (op.op === 'erase') {
        const n = (op.ids ? 1 : 0) + (op.region ? 1 : 0) + (op.all ? 1 : 0);
        if (n !== 1) { out.push(where + ': erase needs exactly one of ids, region, all'); return; }
        if (op.ids) {
          for (const id of op.ids) if (!live.has(id)) out.push(where + ': erase names "' + id + '", which is not on the board');
          for (const id of op.ids) live.delete(id);
        } else if (op.region) {
          const r = op.region;
          if (![r.x, r.y, r.w, r.h].every(isNum)) { out.push(where + ': region needs numeric x, y, w, h'); return; }
          for (const [id, o] of [...live]) {
            const cx = o.box.x + o.box.w / 2;
            const cy = o.box.y + o.box.h / 2;
            if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) live.delete(id);
          }
        } else live.clear();
        return;
      }
      if (!(op.op in NEED)) { out.push(where + ': unknown op "' + String(op.op) + '"'); return; }
      if (typeof op.id !== 'string' || op.id === '') { out.push(where + ': id is missing'); return; }
      const label = where + ' (' + op.id + ')';
      if (seen.has(op.id)) out.push(label + ': id is used twice');
      seen.add(op.id);
      const rec = op as unknown as Record<string, unknown>;
      for (const f of NEED[op.op]!) if (!isNum(rec[f])) out.push(label + ': ' + f + ' must be a number');
      if (op.op === 'write' && (typeof op.text !== 'string' || op.text === '')) { out.push(label + ': text is missing'); return; }
      if (op.op === 'path' && (typeof op.d !== 'string' || op.d === '')) { out.push(label + ': d is missing'); return; }
      if (op.color !== undefined && !isColor(op.color)) out.push(label + ': color "' + String(op.color) + '" is not ink, blue, red, green or gray');
      if ('fill' in op && op.fill !== undefined && !isColor(op.fill)) out.push(label + ': fill "' + String(op.fill) + '" is not a colour name');
      if (op.op === 'write') {
        const size = op.size ?? 40;
        if (!isNum(size) || size < 24 || size > 60) out.push(label + ': size ' + String(op.size) + ' is outside 24 to 60');
        if (op.anchor !== undefined && op.anchor !== 'start' && op.anchor !== 'middle') out.push(label + ': anchor must be start or middle');
      }
      if ('width' in op && op.width !== undefined && !(isNum(op.width) && op.width > 0)) out.push(label + ': width must be positive');
      if ('arrow' in op && op.arrow !== undefined && ![true, false, 'both'].includes(op.arrow)) out.push(label + ': arrow must be true, false or "both"');
      const box = opBox(op);
      if (!box) return;
      if (box.w > 0 && (box.x < MARGIN || box.y < MARGIN || box.x + box.w > BOARD_W - MARGIN || box.y + box.h > BOARD_H - MARGIN)) {
        out.push(label + ': leaves the ' + MARGIN + '-unit margin (x ' + Math.round(box.x) + ' to ' + Math.round(box.x + box.w) + ', y ' + Math.round(box.y) + ' to ' + Math.round(box.y + box.h) + ')');
      }
      if (op.op === 'write') {
        for (const [oid, o] of live) {
          if (o.op.op === 'write' && overlaps(box, o.box)) out.push(label + ': text overlaps "' + oid + '", which is still on the board');
        }
      }
      live.set(op.id, { op, box });
    });
  });
  return out;
}
