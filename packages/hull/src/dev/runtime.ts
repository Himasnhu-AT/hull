// The game side of the project protocol. The dev page calls connectDev(game, { url }) once; from then on config and
// tunable edits made in the app arrive here and are applied to the running game without a reload, and the app sees the
// game's tick, time and frame rate about four times a second. Dev only: a build never imports this file.
import { config, setTunable, tuningProblems } from '../config/index.ts';
import type { Game, Node } from '../core/index.ts';
import { setTraceSink, type TraceKind } from '../core/trace.ts';
import { clearProbes } from '../core/probes.ts';
import { createRecentFeed } from './recent.ts';
import { ensureCapture } from './capture.ts';
import { checkCond, holds, inspectNode, probeValues, treeLines } from './inspect.ts';
import { input } from '../input/dom.ts';
import { withUi } from '../ui/capture.ts';
import { clickButton, readUi, uiDefault, uiFocus, uiKeyName, type UiDoc } from '../ui/inspect.ts';
import type { ControlErrors, ControlFrames, ControlInspect, ControlOp, ControlClick, ControlPerf, ControlShot, ControlUi, ControlState, ControlTree, ControlUntil, GameControl, GameEvents, GameReport, Pushes } from './protocol.ts';

export interface DevConnection { dispose(): void }

interface Note { method: string; params?: unknown }

/** A step that threw game code. Carries the browser's stack so the project server can map it to the sources. */
class StepFailure extends Error {
  constructor(message: string, readonly raw: string | undefined) { super(message); }
}

type ControlResult = ControlState | ControlShot | ControlUntil | ControlInspect | ControlTree | ControlErrors | ControlPerf | ControlFrames | ControlUi | ControlClick | Record<string, never>;

/** Handed from a page that is restarting to the one that replaces it (sessionStorage survives a reload, and only that). */
const RESTART_KEY = 'hull-restart';
/** An `until` that has run this long in wall time stops and says so, so the answer comes back before the server's 30 s limit. */
const UNTIL_WALL_MS = 20_000;

const stats = (xs: number[]): { avg: number; p95: number; max: number } => {
  const s = [...xs].sort((a, b) => a - b);
  const r = (n: number): number => Math.round(n * 1000) / 1000;
  return { avg: r(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)), p95: r(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0), max: r(s[s.length - 1] ?? 0) };
};

const countNodes = (n: Node): number => { let c = 1; for (const k of n.children) c += countNodes(k); return c; };


const REPORT_MS = 250;
const RECONNECT_MS = [250, 500, 1000, 2000];
// The "Just now" feed goes out at most ten times a second, and not at all when nothing happened.
const FEED_MS = 100;
const TITLE_KIND: Record<TraceKind, 'sound' | 'vfx' | 'character' | undefined> = { sound: 'sound', vfx: 'vfx', actor: 'character', anim: undefined };

export function connectDev(game: Game, opts: { url: string; /** Called for `restart`; the default reloads the page, which runs `ready` again with the same seed. */ onRestart?: () => void }): DevConnection {
  // A page opened by the play tool names itself (?hull-client=) so the tool can aim control ops at exactly this game.
  // The app names its frame the same way (?hull-client=), so its calls aim at the game the person is looking at. A page the
  // play tool opened with no app around it says so (?hull-headless), so the server never prefers it to a game in a frame.
  const query = new URLSearchParams(location.search);
  const client = query.get('hull-client') ?? crypto.randomUUID().slice(0, 6);
  const url = `${opts.url}${opts.url.includes('?') ? '&' : '?'}role=game&client=${encodeURIComponent(client)}${query.has('hull-headless') ? '&headless=1' : ''}`;
  let ws: WebSocket | null = null;
  let disposed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Frame rate from the frames the game really drew, averaged over each report window.
  let frames = 0;
  let windowStart = performance.now();
  let fps = 0;
  const offFrame = game.onFrame(() => { frames++; });

  const send = (method: string, params: unknown): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  };

  // The error ring lives in capture.ts, which started listening when the module loaded (before `ready`). A page restarted
  // through the control port hands over what it had (sessionStorage), and starts paused.
  const cap = ensureCapture();
  const ring = cap.ring;
  cap.clock = () => [game.world.tick, game.world.time];
  cap.onNew = (level, message) => send('log', { level, message, source: 'game' } satisfies Pushes['log']);
  let restarted = false;
  try {
    const carried = sessionStorage.getItem(RESTART_KEY);
    if (carried !== null) { sessionStorage.removeItem(RESTART_KEY); ring.load(carried); restarted = true; }
  } catch { /* no sessionStorage here */ }
  const record = cap.record;
  const realConsole = cap.real;
  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    send('log', { level, message, source: 'game' } satisfies Pushes['log']);
    if (level !== 'info') record(level, message, undefined, false);
    (level === 'error' ? realConsole.error : level === 'warn' ? realConsole.warn : realConsole.info).call(console, `[hull dev] ${message}`);
  };

  // The "Just now" feed: the engine's trace calls land in a ring stamped with game time (so a paused game stamps nothing new
  // and a stepped one stamps what the step reached), and a timer sends what is new. The timer is wall time on purpose:
  // it only decides when to send, never what the simulation does.
  const feed = createRecentFeed({
    time: () => game.world.time,
    title(kind, id) {
      const k = TITLE_KIND[kind];
      if (!k) return undefined;
      try {
        const v = config.lookup(k, id.startsWith(`${k}/`) ? id.slice(k.length + 1) : id) as { title?: unknown };
        return typeof v.title === 'string' && v.title !== '' ? v.title : undefined;
      } catch { return undefined; }
    },
    send: (items) => send('game.events', { items } satisfies GameEvents),
  });
  // `until` can wait for a trace event: the sink notes a hit on the one id being watched, then hands on to the feed.
  let watching: string | null = null;
  let watchHit = false;
  setTraceSink((kind, id, node) => { feed.add(kind, id, node); if (watching !== null && id === watching) watchHit = true; });
  const feeder = setInterval(() => { feed.flush(); }, FEED_MS);

  // Characters built before this connection existed (connectDev runs after the game's ready, and a studio can connect any time later)
  // never traced themselves to this ring. One walk of the tree on each connect asks them to; it is not per frame.
  const announceActors = (): void => {
    const stack: Node[] = [game.world.root];
    for (let n = stack.pop(); n; n = stack.pop()) {
      for (const b of n.behaviours) (b as { announceActor?: () => void }).announceActor?.();
      for (const k of n.children) stack.push(k);
    }
  };

  const control = (c: GameControl): void => {
    if (c.timeScale !== undefined && Number.isFinite(c.timeScale) && c.timeScale >= 0) game.timeScale = c.timeScale;
    if (c.paused !== undefined) game.paused = c.paused;
    if (c.step !== undefined && c.step > 0) { game.paused = true; game.step(Math.floor(c.step)); }
    // Say so at once, so a studio that just paused or resumed the game does not wait for the next report to see it.
    if (c.paused !== undefined || c.step !== undefined || c.timeScale !== undefined) { feed.flush(); report(); }
    if (c.restart) (opts.onRestart ?? (() => location.reload()))();
  };

  // The control port. Keys go through real KeyboardEvents so the input map and the latched edges behave as for a player.
  // A mouse button ("Mouse0".."Mouse4") goes through the mouse events the input layer listens to.
  const key = (type: 'keydown' | 'keyup', code: string): void => {
    const m = /^Mouse([0-4])$/.exec(code);
    if (m) {
      const button = Number(m[1]);
      if (type === 'keydown') document.documentElement.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true, cancelable: true }));
      else window.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
      return;
    }
    // Enter, Space, Escape, Tab and the arrows also belong to the UI layer: with a button focused, the key goes to that element (it
    // bubbles up to the window, so the game still hears it) and the browser's own defaults, which a script's key does not trigger, are done here.
    const k = uiKeyName(code);
    const focus = k ? uiFocus(document as unknown as UiDoc) : null;
    const ev = new KeyboardEvent(type, { code, key: k ?? undefined, bubbles: true, cancelable: true });
    if (focus) {
      (focus as unknown as EventTarget).dispatchEvent(ev);
      if (type === 'keydown' && !ev.defaultPrevented) uiDefault(document as unknown as UiDoc, code);
    } else window.dispatchEvent(ev);
  };
  const stateOf = (names: readonly string[] = []): ControlState => {
    const nodes: ControlState['nodes'] = {};
    for (const name of names) {
      const n = game.world.find(name);
      nodes[name] = n ? { found: true, x: n.position.x, y: n.position.y, z: n.position.z } : { found: false, x: 0, y: 0, z: 0 };
    }
    return { tick: game.world.tick, time: game.world.time, checksum: game.world.checksum(), paused: game.paused, nodes, held: input.heldSources(), probes: probeValues(), errors: ring.unread() };
  };
  // Steps through here so a throw in game code is recorded and comes back as a failure that names the place, not as a bare message.
  const stepSafely = (n: number): void => {
    try { game.step(n); } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const message = `${err.name}: ${err.message}`;
      record('error', message, err.stack);
      throw new StepFailure(message, err.stack);
    }
  };
  const asPng = async (blob: Blob): Promise<ControlShot> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const bmp = await createImageBitmap(blob);
    const shot = { png: btoa(bin), width: bmp.width, height: bmp.height };
    bmp.close();
    return shot;
  };
  const renderView = (): { shot(): Promise<Blob>; stats?(): { drawCalls: number; triangles: number } } => {
    const view = (globalThis as { hull?: { render?: { shot(): Promise<Blob>; stats?(): { drawCalls: number; triangles: number } } } }).hull?.render;
    if (!view) throw new Error('the game has no render view to capture');
    return view;
  };
  // One picture at another size: the view's box is resized for the capture and put back after, so nothing else about the page changes.
  const MAX_W = 1920, MAX_H = 1080;
  const nextFrames = (): Promise<void> => new Promise((r) => { const t = setTimeout(r, 150); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); });
  const atSize = async <T>(w: number | undefined, h: number | undefined, fn: () => Promise<T>): Promise<T> => {
    if (w === undefined && h === undefined) return fn();
    const el = document.querySelector('canvas')?.parentElement;
    if (!el) throw new Error('the game has no view to resize');
    const cur = el.getBoundingClientRect();
    const ok = (v: number | undefined, max: number, name: string): number => {
      if (v === undefined) return 0;
      if (!Number.isInteger(v) || v < 16 || v > max) throw new Error(`${name} must be a whole number from 16 to ${max}, got ${String(v)}`);
      return v;
    };
    const W = ok(w, MAX_W, 'width') || Math.round(cur.width), H = ok(h, MAX_H, 'height') || Math.round(cur.height);
    const before = el.getAttribute('style');
    el.style.setProperty('width', `${W}px`, 'important');
    el.style.setProperty('height', `${H}px`, 'important');
    el.style.setProperty('flex', 'none', 'important');
    await nextFrames();
    try { return await fn(); } finally {
      if (before === null) el.removeAttribute('style'); else el.setAttribute('style', before);
      await nextFrames();
    }
  };
  const tileFrames = async (c: Extract<ControlOp, { op: 'frames' }>): Promise<ControlFrames> => {
    if (!Number.isInteger(c.count) || c.count < 2 || c.count > 12) throw new Error(`frames needs "count" from 2 to 12, got ${String(c.count)}`);
    if (!Number.isInteger(c.every) || c.every < 1) throw new Error(`frames needs "every": ticks between captures, 1 or more, got ${String(c.every)}`);
    return atSize(c.width, c.height, () => tileAt(c));
  };
  const tileAt = async (c: Extract<ControlOp, { op: 'frames' }>): Promise<ControlFrames> => {
    const view = renderView();
    game.paused = true;
    const blobs: Blob[] = [];
    const ticks: number[] = [];
    for (let i = 0; i < c.count; i++) {
      if (i > 0) stepSafely(c.every);
      feed.flush();
      ticks.push(game.world.tick);
      game.frame(0);
      blobs.push(await view.shot());
    }
    const bitmaps = await Promise.all(blobs.map((b) => createImageBitmap(b)));
    const cols = Math.ceil(Math.sqrt(c.count));
    const rows = Math.ceil(c.count / cols);
    const bw = bitmaps[0]!.width, bh = bitmaps[0]!.height;
    // With no size asked the point is judging motion cheaply, so each tile is at most 320 px wide. With a width or height each
    // tile is that size, then the whole sheet is scaled down together so it stays within 1920x1080.
    const scale = c.width === undefined && c.height === undefined ? Math.min(1, 320 / bw) : Math.min(1, MAX_W / (cols * bw), MAX_H / (rows * bh));
    const tw = Math.max(1, Math.round(bw * scale));
    const th = Math.max(1, Math.round(bh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cols * tw;
    canvas.height = rows * th;
    const cx = canvas.getContext('2d');
    if (!cx) throw new Error('frames: the browser gave no 2D canvas to tile the pictures on');
    cx.font = 'bold 13px monospace';
    cx.textBaseline = 'top';
    bitmaps.forEach((bmp, i) => {
      const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
      cx.drawImage(bmp, x, y, tw, th);
      const label = `tick ${ticks[i]}`;
      cx.fillStyle = 'rgba(0,0,0,0.7)';
      cx.fillRect(x + 3, y + 3, cx.measureText(label).width + 8, 18);
      cx.fillStyle = '#fff';
      cx.fillText(label, x + 7, y + 6);
      bmp.close();
    });
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!out) throw new Error('frames: the tiled picture could not be encoded');
    return { ...(await asPng(out)), ticks };
  };
  const perf = async (c: Extract<ControlOp, { op: 'perf' }>): Promise<ControlPerf> => {
    const n = c.steps ?? 120;
    if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error(`perf needs "steps" from 1 to 5000, got ${String(c.steps)}`);
    game.paused = true;
    // A page that has not drawn yet (headless, nobody looking) has no camera view or draw counts: draw once so the numbers mean something.
    try { await renderView().shot(); } catch { /* no render view: frame times then cover the update alone */ }
    const st: number[] = [];
    const fr: number[] = [];
    // Wall time is right here: this measures the machine, and nothing the simulation does reads it.
    for (let i = 0; i < n; i++) { const t = performance.now(); stepSafely(1); st.push(performance.now() - t); }
    // Paused, a frame runs no steps but still updates and draws: that is the cost of showing the game.
    // Draw counts come from the first frame after the steps: later paused frames find nothing changed and skip work (shadow passes),
    // so their count would depend on how many frames were timed. One frame's numbers, never a sum over frames.
    const view = (globalThis as { hull?: { render?: { stats?(): { drawCalls: number; triangles: number } } } }).hull?.render;
    let s: { drawCalls: number; triangles: number } | undefined;
    for (let i = 0; i < n; i++) { const t = performance.now(); game.frame(0); fr.push(performance.now() - t); if (i === 0) s = view?.stats?.(); }
    feed.flush();
    return { stepMs: stats(st), frameMs: stats(fr), drawCalls: s?.drawCalls ?? 0, triangles: s?.triangles ?? 0, nodes: countNodes(game.world.root) };
  };
  const until = (c: Extract<ControlOp, { op: 'until' }>): ControlUntil => {
    const when = checkCond(c.when);
    if (!Number.isFinite(c.max) || c.max < 0) throw new Error(`until needs "max": how many ticks to try at most, zero or more, got ${String(c.max)}`);
    game.paused = true;
    watching = 'event' in when ? when.event : null;
    watchHit = false;
    let steps = 0;
    let met = holds(game.world, when, false);
    const start = performance.now();
    try {
      while (!met && steps < c.max) {
        stepSafely(1);
        steps++;
        met = holds(game.world, when, watchHit);
        if ((steps & 255) === 0 && performance.now() - start > UNTIL_WALL_MS) break;
      }
    } finally { watching = null; }
    game.frame(0);
    feed.flush();
    return { ...stateOf(), met, steps };
  };
  // A game that has not met its renderer yet spawns particles into the CPU pool, and the GPU simulation that takes over when the
  // backend starts (a moment later, by wall time) never sees them. So no time passes until the backend is up: two runs of one
  // script then see the same particles whatever the machine's speed.
  const renderReady = async (): Promise<void> => {
    const ready = (globalThis as { hull?: { render?: { ready?: Promise<unknown> } } }).hull?.render?.ready;
    if (ready) await ready;
  };
  const runControl = async (c: ControlOp): Promise<ControlResult> => {
    if (c.op === 'step' || c.op === 'until' || c.op === 'perf' || c.op === 'frames') await renderReady();
    switch (c.op) {
      case 'step':
        if (!Number.isFinite(c.n) || c.n < 0) throw new Error(`step needs a count of zero or more, got ${String(c.n)}`);
        game.paused = true;
        stepSafely(Math.floor(c.n));
        // The GPU particle simulation takes its spawns and steps at the next drawn frame and drops spawns past a queue limit. Whether
        // the page's own animation callback ran between two ops would then decide what survived: flush here, on our own terms.
        game.frame(0);
        feed.flush();
        return stateOf();
      case 'press': key('keydown', c.key); return {};
      case 'release': key('keyup', c.key); return {};
      case 'state': feed.flush(); return stateOf(c.nodes);
      case 'inspect':
        if (typeof c.node !== 'string' || c.node === '') throw new Error('inspect needs "node": a world.find path like "player" or "squad/ana"');
        return inspectNode(game.world, c.node);
      case 'tree': return treeLines(game.world, c.root, Number.isInteger(c.depth) && (c.depth as number) >= 0 ? (c.depth as number) : 3);
      case 'until': return until(c);
      case 'errors': return { items: c.unread === true ? ring.unreadItems() : ring.take(c.clear === true) } as ControlErrors;
      case 'perf': return perf(c);
      case 'frames': return tileFrames(c);
      case 'look': {
        if (!Number.isFinite(c.dx) || !Number.isFinite(c.dy)) throw new Error('look needs "dx" and "dy": mouse movement in pixels');
        // The input layer counts movement only under pointer lock or freeLook; a page nobody clicked in has neither, so borrow freeLook for this one event.
        const was = input.freeLook;
        input.freeLook = true;
        try { window.dispatchEvent(new MouseEvent('mousemove', { movementX: c.dx, movementY: c.dy, bubbles: true })); } finally { input.freeLook = was; }
        return {};
      }
      case 'restart':
        // The page reloads (that is what runs `ready` again with the same seed) a moment after this answer leaves; the project
        // server waits for the game to come back. The error ring crosses the reload, and the new page starts paused at tick 0.
        clearProbes();
        if (!opts.onRestart) { try { sessionStorage.setItem(RESTART_KEY, ring.dump()); } catch { /* the reload still restarts the game */ } }
        setTimeout(() => (opts.onRestart ?? (() => location.reload()))(), 30);
        return {};
      case 'screenshot': {
        feed.flush();
        const view = renderView();
        // Particles and the UI are copied into their buffers by a frame, not by a step: without one the picture shows whatever the
        // last frame left, which depends on whether the page's own animation callback ran since the step. A paused frame runs no
        // steps, so this adds no game time.
        return atSize(c.width, c.height, async () => {
          game.frame(0);
          let blob = await view.shot();
          // The canvas holds only the 3D frame; the HUD and menus are DOM, so they are painted on unless asked not to.
          if (c.ui !== false && typeof document !== 'undefined') blob = await withUi(blob, document);
          return asPng(blob);
        });
      }
      // The UI is built and updated by frames, not by steps: run one (no game time passes) so it shows the world as it is now.
      case 'ui': game.frame(0); return readUi(document as unknown as UiDoc);
      case 'click': {
        game.frame(0);
        const r = clickButton(document as unknown as UiDoc, c.button);
        game.frame(0);
        return r;
      }
    }
  };

  // A bad value in config/tuning/<block>.json is skipped (the code value stays); say so once per distinct complaint.
  const told = new Set<string>();
  const reportTuning = (): void => {
    const now = new Set<string>();
    for (const p of tuningProblems()) {
      const line = `${p.file}#${p.pointer ?? ''}: ${p.message}`;
      now.add(line);
      if (!told.has(line)) log('error', line);
    }
    told.clear();
    for (const l of now) told.add(l);
  };

  const handle = (n: Note): void => {
    switch (n.method) {
      case 'config.changed': {
        const p = n.params as Pushes['config.changed'];
        const r = config.update({ path: p.path, text: p.text });
        for (const problem of r.problems) log('error', `${problem.file}${problem.pointer ?? ''}: ${problem.message}`);
        reportTuning();
        break;
      }
      case 'config.removed': config.remove((n.params as Pushes['config.removed']).path); break;
      case 'tunable.changed': {
        const p = n.params as Pushes['tunable.changed'];
        const problem = setTunable(`${p.block}.${p.key}`, p.value);
        if (problem) log('warn', problem.message);
        break;
      }
      case 'game.control': control(n.params as GameControl); break;
      case 'game.rpc': {
        const p = n.params as Pushes['game.rpc'];
        runControl(p.control).then(
          (result) => send('game.result', { id: p.id, ok: true, result }),
          (err: unknown) => send('game.result', err instanceof StepFailure
            ? { id: p.id, ok: false, error: err.message, ...(err.raw ? { stack: err.raw } : {}), partStepped: true }
            : { id: p.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
        break;
      }
    }
  };

  const report = (): void => {
    const now = performance.now();
    fps = frames / Math.max((now - windowStart) / 1000, 1e-3);
    frames = 0;
    windowStart = now;
    const body: GameReport = {
      tick: game.world.tick,
      time: game.world.time,
      paused: game.paused,
      timeScale: game.timeScale,
      fps: Math.round(fps * 10) / 10,
      checksum: game.world.checksum(),
    };
    send('game.report', body);
  };
  // The note key. A person who is playing has focus inside the game frame (another origin), so the page around it never sees
  // the key: tell it. N freezes the moment, Escape carries on. Only when embedded, and never while typing in a field.
  const win = (globalThis as { window?: Window }).window;
  const noteKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
    const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const hull = e.code === 'KeyN' ? 'note' : e.code === 'Escape' ? 'resume' : undefined;
    if (hull && win && win.parent && win.parent !== win) win.parent.postMessage({ hull }, '*');
  };
  if (win && win.parent && win.parent !== win) win.addEventListener('keydown', noteKey);
  // A page opened with ?hull-paused starts frozen at tick 0, before its first frame, so a script begins from the same state every time.
  if (new URLSearchParams(location.search).has('hull-paused') || restarted) game.paused = true;

  const reporter = setInterval(report, REPORT_MS);

  const open = (): void => {
    if (disposed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0; feed.clear(); announceActors(); report(); reportTuning();
      // What the page already said (a warning while `ready` ran) reaches the studios once the socket is up.
      for (const it of ring.peek()) send('log', { level: it.level, message: it.message, source: 'game' } satisfies Pushes['log']);
    };
    ws.onmessage = (e) => {
      try { handle(JSON.parse(String(e.data)) as Note); } catch (err) { log('error', `dev message failed: ${(err as Error).message}`); }
    };
    ws.onclose = () => {
      ws = null;
      if (disposed) return;
      timer = setTimeout(open, RECONNECT_MS[Math.min(attempt++, RECONNECT_MS.length - 1)]);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    dispose() {
      disposed = true;
      clearInterval(reporter);
      clearInterval(feeder);
      setTraceSink(null);
      clearTimeout(timer);
      win?.removeEventListener('keydown', noteKey);
      cap.onNew = null;
      cap.uninstall();
      offFrame();
      ws?.close();
    },
  };
}
