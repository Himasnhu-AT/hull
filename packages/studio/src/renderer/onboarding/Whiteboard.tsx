// Whiteboard player adapted from whiteboard-ai-tutor (MIT), Copyright (c) 2026 Whiteboard AI Tutor contributors.
// See ../NOTICE.md for the licence text. The protocol and the way of drawing (text revealed by a growing clip,
// strokes drawn with stroke-dashoffset, a small pen following the tip, steps played one at a time) are theirs;
// this version is a React component with a cancellable requestAnimationFrame clock, speed and pause as props,
// and a reduced-motion mode that shows each step's final state at once.
//
// The component holds no React state: the SVG is built and animated through refs, so nothing can call setState
// after unmount, and the frame loop is cancelled on unmount and whenever the lesson or step changes.

import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { opBox, type ColorName, type DrawOp, type EraseOp, type Lesson, type Op } from './lesson.ts';
import './onboarding.css';

/** Hull's palette for the board. */
export const COLORS: Record<ColorName, string> = { ink: '#1c1b18', blue: '#2f5fbf', red: '#c2412d', green: '#2b7a4b', gray: '#8f8a80' };
const FONT = "'Hull Caveat', 'Caveat', 'Segoe Print', 'Bradley Hand', cursive";
const FONT_WEIGHT = '600';
// Caveat is narrow and small for its size; drawing it a little larger keeps the lessons' sizes readable. The validator's
// width estimate (size * 0.5 per character) stays a safe upper bound.
const FONT_SCALE = 1.3;
const TINT = 0.14;
const NS = 'http://www.w3.org/2000/svg';
const CANCEL = Symbol('cancel');

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    const on = (): void => setReduced(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return reduced;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent?.appendChild(e);
  return e;
}

interface Stroke { el: SVGPathElement; len: number; fillEl: SVGPathElement | null; heads: SVGPathElement[]; dash: boolean; col: string }
interface TextLine { el: SVGTextElement; bb: DOMRect; clip: SVGClipPathElement | null; clipRect: SVGRectElement | null }
interface Obj { id: string; spec: DrawOp; g: SVGGElement; texts: TextLine[]; strokes: Stroke[] }

function arrowHead(g: Element, p: SVGPathElement, len: number, end: 'start' | 'end', col: string, w: number, hide: boolean): SVGPathElement {
  const a = p.getPointAtLength(end === 'end' ? len : 0);
  const b = p.getPointAtLength(end === 'end' ? Math.max(0, len - 5) : Math.min(len, 5));
  const ang = Math.atan2(a.y - b.y, a.x - b.x);
  const L = 16 + w * 2.2;
  const sp = 0.45;
  const x1 = a.x - L * Math.cos(ang - sp);
  const y1 = a.y - L * Math.sin(ang - sp);
  const x2 = a.x - L * Math.cos(ang + sp);
  const y2 = a.y - L * Math.sin(ang + sp);
  return el('path', { d: 'M ' + x1 + ' ' + y1 + ' L ' + a.x + ' ' + a.y + ' L ' + x2 + ' ' + y2, fill: 'none', stroke: col, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: hide ? 0 : 1 }, g);
}

function shapePath(op: DrawOp): string {
  switch (op.op) {
    case 'line': return 'M ' + op.x1 + ' ' + op.y1 + ' L ' + op.x2 + ' ' + op.y2;
    case 'rect': return 'M ' + op.x + ' ' + op.y + ' L ' + (op.x + op.w) + ' ' + op.y + ' L ' + (op.x + op.w) + ' ' + (op.y + op.h) + ' L ' + op.x + ' ' + (op.y + op.h) + ' Z';
    case 'ellipse': {
      const rot = op.rotate ?? 0;
      const th = (rot * Math.PI) / 180;
      const ax = op.rx * Math.cos(th);
      const ay = op.rx * Math.sin(th);
      const sx = op.cx - ax;
      const sy = op.cy - ay;
      const ex = op.cx + ax;
      const ey = op.cy + ay;
      return 'M ' + sx + ' ' + sy + ' A ' + op.rx + ' ' + op.ry + ' ' + rot + ' 0 1 ' + ex + ' ' + ey + ' A ' + op.rx + ' ' + op.ry + ' ' + rot + ' 0 1 ' + sx + ' ' + sy;
    }
    case 'path': return op.d;
    default: return '';
  }
}

/** Builds and animates the board. One per Whiteboard; it owns every node under layer, defs and pen. */
class BoardPlayer {
  private token = 0;
  private raf = 0;
  private rejectPending: ((e: unknown) => void) | null = null;
  private readonly objs = new Map<string, Obj>();
  private clipN = 0;
  private fontsReady: Promise<void> | null = null;

  constructor(
    private readonly layer: SVGGElement,
    private readonly defs: SVGDefsElement,
    private readonly pen: SVGGElement,
    private readonly prefix: string,
    private readonly getSpeed: () => number,
    private readonly isPaused: () => boolean,
  ) {}

  /** Stops the frame loop. Anything waiting on a frame is dropped; nothing is called after this. */
  cancel(): void {
    this.token++;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const r = this.rejectPending;
    this.rejectPending = null;
    r?.(CANCEL);
  }

  dispose(): void { this.cancel(); }

  private clear(): void {
    this.layer.replaceChildren();
    this.defs.replaceChildren();
    this.objs.clear();
    this.pen.style.display = 'none';
  }

  /** The text is measured, so wait (a little) for the handwriting font before the first drawing. */
  private whenFonts(): Promise<void> {
    this.fontsReady ??= typeof document !== 'undefined' && document.fonts
      ? Promise.race([document.fonts.load("600 40px 'Hull Caveat'").then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, 1500))])
      : Promise.resolve();
    return this.fontsReady;
  }

  /** Shows the board as it is after the steps before stepIndex, then plays (or just draws) step stepIndex. True when it finished. */
  async show(lesson: Lesson, stepIndex: number, animate: boolean): Promise<boolean> {
    this.cancel();
    const tok = this.token;
    this.clear();
    await this.whenFonts();
    if (tok !== this.token) return false;
    try {
      for (let i = 0; i < stepIndex; i++) for (const op of lesson.steps[i]?.ops ?? []) await this.doOp(op, tok, false);
      const ops = lesson.steps[stepIndex]?.ops ?? [];
      for (let i = 0; i < ops.length; i++) {
        await this.doOp(ops[i]!, tok, animate);
        if (animate && i < ops.length - 1) await this.anim(140, () => {}, tok);
      }
      this.pen.style.display = 'none';
      return tok === this.token;
    } catch (e) {
      if (e === CANCEL) return false;
      throw e;
    }
  }

  private anim(ms: number, fn: (k: number) => void, tok: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (tok !== this.token) { reject(CANCEL); return; }
      this.rejectPending = reject;
      let elapsed = 0;
      let last = -1;
      fn(0);
      const tick = (now: number): void => {
        this.raf = 0;
        if (tok !== this.token) { reject(CANCEL); return; }
        if (last < 0) last = now;
        const dt = Math.min(100, now - last);
        last = now;
        if (!this.isPaused()) elapsed += dt * this.getSpeed();
        fn(Math.min(1, elapsed / ms));
        if (elapsed >= ms) { this.rejectPending = null; resolve(); return; }
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  private async doOp(op: Op, tok: number, animate: boolean): Promise<void> {
    if (op.op === 'erase') { await this.erase(op, tok, animate); return; }
    if (this.objs.has(op.id)) return;
    const o = this.build(op, !animate);
    this.objs.set(op.id, o);
    if (animate) await this.reveal(o, tok);
  }

  private async erase(op: EraseOp, tok: number, animate: boolean): Promise<void> {
    const all = [...this.objs.values()];
    let targets: Obj[];
    if (op.all) targets = all;
    else if (op.ids) targets = op.ids.map((i) => this.objs.get(i)).filter((o): o is Obj => !!o);
    else if (op.region) {
      const r = op.region;
      targets = all.filter((o) => {
        const b = opBox(o.spec);
        if (!b) return false;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
      });
    } else targets = [];
    if (animate && targets.length) await this.anim(450, (k) => { for (const o of targets) o.g.style.opacity = String(1 - k); }, tok);
    for (const o of targets) { o.g.remove(); this.objs.delete(o.id); for (const t of o.texts) t.clip?.remove(); }
  }

  private build(op: DrawOp, show: boolean): Obj {
    const g = el('g', { 'data-id': op.id }, this.layer);
    const o: Obj = { id: op.id, spec: op, g, texts: [], strokes: [] };
    const col = COLORS[op.color ?? 'ink'];
    const hide = !show;
    if (op.op === 'write') {
      const size = op.size ?? 40;
      const mid = op.anchor === 'middle';
      op.text.split('\n').forEach((ln, i) => {
        const t = el('text', { x: op.x, y: op.y + size * 0.85 + i * size * 1.3, 'font-size': size * FONT_SCALE, 'font-family': FONT, 'font-weight': FONT_WEIGHT, fill: col, 'text-anchor': mid ? 'middle' : 'start' }, g);
        t.style.whiteSpace = 'pre';
        t.textContent = ln;
        o.texts.push({ el: t, bb: t.getBBox(), clip: null, clipRect: null });
      });
      if (hide) {
        for (const t of o.texts) {
          const id = this.prefix + '-c' + ++this.clipN;
          const cp = el('clipPath', { id }, this.defs);
          t.clip = cp;
          t.clipRect = el('rect', { x: t.bb.x - 4, y: t.bb.y - 4, width: 0, height: t.bb.height + 8 }, cp);
          t.el.setAttribute('clip-path', 'url(#' + id + ')');
        }
      }
      if (op.underline) {
        const bb = g.getBBox();
        const y = bb.y + bb.height + 2;
        this.addStroke(o, 'M ' + bb.x + ' ' + y + ' L ' + (bb.x + bb.width) + ' ' + y, col, 4, {}, hide);
      }
    } else {
      this.addStroke(o, shapePath(op), col, op.width ?? 5, { fill: 'fill' in op ? op.fill : undefined, dash: op.dash, arrow: 'arrow' in op ? op.arrow : undefined }, hide);
    }
    return o;
  }

  private addStroke(o: Obj, d: string, col: string, w: number, opts: { fill?: ColorName | undefined; dash?: boolean | undefined; arrow?: boolean | 'both' | undefined }, hide: boolean): void {
    let fillEl: SVGPathElement | null = null;
    if (opts.fill) fillEl = el('path', { d, fill: COLORS[opts.fill], 'fill-opacity': hide ? 0 : TINT, stroke: 'none' }, o.g);
    const p = el('path', { d, fill: 'none', stroke: col, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, o.g);
    const len = p.getTotalLength();
    const s: Stroke = { el: p, len, fillEl, heads: [], dash: !!opts.dash, col };
    if (opts.dash) {
      p.setAttribute('stroke-dasharray', '12 10');
      if (hide) p.style.opacity = '0';
    } else if (hide) {
      p.setAttribute('stroke-dasharray', String(len + 2));
      p.setAttribute('stroke-dashoffset', String(len + 2));
    }
    if (opts.arrow && len > 0) for (const end of opts.arrow === 'both' ? (['end', 'start'] as const) : (['end'] as const)) s.heads.push(arrowHead(o.g, p, len, end, col, w, hide));
    o.strokes.push(s);
  }

  private movePen(x: number, y: number, col: string): void {
    this.pen.style.display = '';
    this.pen.setAttribute('transform', 'translate(' + x + ',' + y + ')');
    for (const c of this.pen.querySelectorAll('rect,circle')) c.setAttribute('fill', col);
  }

  private async reveal(o: Obj, tok: number): Promise<void> {
    const col = COLORS[(o.spec.color ?? 'ink') as ColorName];
    for (const t of o.texts) {
      const b = t.bb;
      const ms = Math.max(260, (t.el.textContent ?? '').length * 48);
      await this.anim(ms, (k) => {
        t.clipRect?.setAttribute('width', String((b.width + 8) * k));
        this.movePen(b.x + b.width * k, b.y + b.height * 0.72, col);
      }, tok);
      t.el.removeAttribute('clip-path');
      t.clip?.remove();
    }
    for (const s of o.strokes) {
      if (s.len <= 0) continue;
      if (s.dash) {
        await this.anim(420, (k) => { s.el.style.opacity = String(k); const q = s.el.getPointAtLength(s.len * k); this.movePen(q.x, q.y, s.col); }, tok);
      } else {
        await this.anim(Math.min(1500, Math.max(240, s.len * 1.3)), (k) => {
          s.el.setAttribute('stroke-dashoffset', String((s.len + 2) * (1 - k)));
          const q = s.el.getPointAtLength(s.len * k);
          this.movePen(q.x, q.y, s.col);
        }, tok);
        s.el.removeAttribute('stroke-dasharray');
        s.el.removeAttribute('stroke-dashoffset');
      }
      for (const h of s.heads) h.setAttribute('opacity', '1');
      const f = s.fillEl;
      if (f) await this.anim(260, (k) => f.setAttribute('fill-opacity', String(TINT * k)), tok);
    }
    this.pen.style.display = 'none';
  }
}

export interface WhiteboardProps {
  lesson: Lesson;
  /** The step to show. The board first shows what the steps before it drew, then plays this one. */
  step: number;
  /** Change it to play the same step again. */
  playKey?: number;
  /** 1 is normal. */
  speed?: number;
  paused?: boolean;
  /** Draw each step's final state at once. Also on whenever the system asks for reduced motion. */
  instant?: boolean;
  /** Called once when the step has been drawn completely (not when it was cut off by another step or by unmount). */
  onStepDone?(step: number): void;
  className?: string;
}

export function Whiteboard({ lesson, step, playKey = 0, speed = 1, paused = false, instant = false, onStepDone, className }: WhiteboardProps): JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const layerRef = useRef<SVGGElement>(null);
  const defsRef = useRef<SVGDefsElement>(null);
  const penRef = useRef<SVGGElement>(null);
  const playerRef = useRef<BoardPlayer | null>(null);
  const speedRef = useRef(speed);
  const pausedRef = useRef(paused);
  const doneRef = useRef(onStepDone);
  const reduced = usePrefersReducedMotion();
  const still = instant || reduced;
  speedRef.current = speed;
  pausedRef.current = paused;
  doneRef.current = onStepDone;

  useEffect(() => {
    const layer = layerRef.current;
    const defs = defsRef.current;
    const pen = penRef.current;
    if (!layer || !defs || !pen) return;
    const player = new BoardPlayer(layer, defs, pen, 'wb' + id, () => speedRef.current, () => pausedRef.current);
    playerRef.current = player;
    return () => { player.dispose(); playerRef.current = null; };
  }, [id]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    let live = true;
    void player.show(lesson, step, !still).then((done) => { if (live && done) doneRef.current?.(step); });
    return () => { live = false; player.cancel(); };
    // id is stable; the player is created by the effect above, which runs first.
  }, [lesson, step, playKey, still, id]);

  return (
    <svg className={'ob-board' + (className ? ' ' + className : '')} viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" role="img" aria-label={lesson.title + ', step ' + (step + 1) + ': ' + (lesson.steps[step]?.title ?? '')}>
      <defs ref={defsRef} />
      <g ref={layerRef} />
      <g ref={penRef} style={{ display: 'none' }} aria-hidden="true">
        <g transform="rotate(-35)"><rect x="2" y="-5" width="46" height="10" rx="3" /></g>
        <circle r="3.5" />
      </g>
    </svg>
  );
}
