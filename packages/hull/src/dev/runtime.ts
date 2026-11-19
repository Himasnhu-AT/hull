// The game side of the project protocol. The dev page calls connectDev(game, { url }) once; from then on config and
// tunable edits made in the app arrive here and are applied to the running game without a reload, and the app sees the
// game's tick, time and frame rate about four times a second. Dev only: a build never imports this file.
import { config, setTunable, tuningProblems } from '../config/index.ts';
import type { Game } from '../core/index.ts';
import { input } from '../input/dom.ts';
import type { ControlOp, ControlShot, ControlState, GameControl, GameReport, Pushes } from './protocol.ts';

export interface DevConnection { dispose(): void }

interface Note { method: string; params?: unknown }

const REPORT_MS = 250;
const RECONNECT_MS = [250, 500, 1000, 2000];

export function connectDev(game: Game, opts: { url: string; /** Called for `restart`; the default reloads the page, which runs `ready` again with the same seed. */ onRestart?: () => void }): DevConnection {
  // A page opened by the play tool names itself (?hull-client=) so the tool can aim control ops at exactly this game.
  const client = new URLSearchParams(location.search).get('hull-client') ?? crypto.randomUUID().slice(0, 6);
  const url = `${opts.url}${opts.url.includes('?') ? '&' : '?'}role=game&client=${client}`;
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

  const control = (c: GameControl): void => {
    if (c.timeScale !== undefined && Number.isFinite(c.timeScale) && c.timeScale >= 0) game.timeScale = c.timeScale;
    if (c.paused !== undefined) game.paused = c.paused;
    if (c.step !== undefined && c.step > 0) { game.paused = true; game.step(Math.floor(c.step)); }
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
        return stateOf();
      case 'press': key('keydown', c.key); return {};
      case 'release': key('keyup', c.key); return {};
      case 'state': return stateOf(c.nodes);
      case 'screenshot': {
        const view = (globalThis as { hull?: { render?: { shot(): Promise<Blob> } } }).hull?.render;
        if (!view) throw new Error('the game has no render view to capture');
        const blob = await view.shot();
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
  // A page opened with ?hull-paused starts frozen at tick 0, before its first frame, so a script begins from the same state every time.
  if (new URLSearchParams(location.search).has('hull-paused')) game.paused = true;
  const reporter = setInterval(report, REPORT_MS);

  const open = (): void => {
    if (disposed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { attempt = 0; report(); reportTuning(); };
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
      clearTimeout(timer);
      offFrame();
      ws?.close();
    },
  };
}
