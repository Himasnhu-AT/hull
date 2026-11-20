// The game side of the project protocol. The dev page calls connectDev(game, { url }) once; from then on config and
// tunable edits made in the app arrive here and are applied to the running game without a reload, and the app sees the
// game's tick, time and frame rate about four times a second. Dev only: a build never imports this file.
import { config, setTunable, tuningProblems } from '../config/index.ts';
import type { Game, Node } from '../core/index.ts';
import { setTraceSink, type TraceKind } from '../core/trace.ts';
import { createRecentFeed } from './recent.ts';
import { input } from '../input/dom.ts';
import { withUi } from '../ui/capture.ts';
import type { ControlOp, ControlShot, ControlState, GameControl, GameEvents, GameReport, Pushes } from './protocol.ts';

export interface DevConnection { dispose(): void }

interface Note { method: string; params?: unknown }

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

  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    send('log', { level, message, source: 'game' } satisfies Pushes['log']);
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(`[hull dev] ${message}`);
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
  setTraceSink(feed.add);
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
  const key = (type: 'keydown' | 'keyup', code: string): void => {
    window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  };
  const stateOf = (names: readonly string[] = []): ControlState => {
    const nodes: ControlState['nodes'] = {};
    for (const name of names) {
      const n = game.world.find(name);
      nodes[name] = n ? { found: true, x: n.position.x, y: n.position.y, z: n.position.z } : { found: false, x: 0, y: 0, z: 0 };
    }
    return { tick: game.world.tick, time: game.world.time, checksum: game.world.checksum(), paused: game.paused, nodes, held: input.heldSources() };
  };
  const runControl = async (c: ControlOp): Promise<ControlState | ControlShot | Record<string, never>> => {
    switch (c.op) {
      case 'step':
        if (!Number.isFinite(c.n) || c.n < 0) throw new Error(`step needs a count of zero or more, got ${String(c.n)}`);
        game.paused = true;
        game.step(Math.floor(c.n));
        feed.flush();
        return stateOf();
      case 'press': key('keydown', c.key); return {};
      case 'release': key('keyup', c.key); return {};
      case 'state': feed.flush(); return stateOf(c.nodes);
      case 'screenshot': {
        feed.flush();
        const view = (globalThis as { hull?: { render?: { shot(): Promise<Blob> } } }).hull?.render;
        if (!view) throw new Error('the game has no render view to capture');
        let blob = await view.shot();
        // The canvas holds only the 3D frame; the HUD and menus are DOM, so they are painted on unless asked not to.
        if (c.ui !== false && typeof document !== 'undefined') blob = await withUi(blob, document);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const bmp = await createImageBitmap(blob);
        const shot = { png: btoa(bin), width: bmp.width, height: bmp.height };
        bmp.close();
        return shot;
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
          (err: unknown) => send('game.result', { id: p.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
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
  if (new URLSearchParams(location.search).has('hull-paused')) game.paused = true;
  const reporter = setInterval(report, REPORT_MS);

  const open = (): void => {
    if (disposed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { attempt = 0; feed.clear(); announceActors(); report(); reportTuning(); };
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
      offFrame();
      ws?.close();
    },
  };
}
