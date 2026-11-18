// DEV ONLY. A stand-in project server that speaks hull/dev/protocol over an in-memory project, so the app can be
// built and tested without the real server (packages/cli/src/server). It is never part of the app bundle: the
// host only loads it when HULL_MOCK=1 or when the real server module is missing.
//
// It serves a tiny "game" page (a spinning cube on a canvas) that connects as role=game, so play, pause, step,
// speed and live tunable edits can be seen working end to end.

import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import type { Problem } from 'hull';
import type { Change, GameControl, LibraryItem, MethodName, Methods, PushName, Pushes, TunableWire } from 'hull/dev/protocol';
import { getAtPointer, setAtPointer } from '../renderer/lib/math.ts';

// `ws` is a dependency of @hull/cli, not of the app, so it is found from there (dev only).
interface WsLike { send(d: string): void; on(ev: 'message', fn: (d: Buffer) => void): void; on(ev: 'close', fn: () => void): void; readyState: number }
interface WssLike { on(ev: 'connection', fn: (ws: WsLike, req: IncomingMessage) => void): void; close(): void }
type WssCtor = new (opts: { server: ReturnType<typeof createServer> }) => WssLike;
const cliRequire = createRequire(createRequire(import.meta.url).resolve('@hull/cli/package.json'));
const { WebSocketServer } = cliRequire('ws') as { WebSocketServer: WssCtor };

export interface ProjectServer { url: string; gameUrl: string; close(): Promise<void> }

const numberOrRange = { oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }] };

interface MockFile { id: string; kind: string; path: string; value: Record<string, unknown>; schema: Record<string, unknown>; problems: Problem[] }

function seedFiles(): MockFile[] {
  const sound = (id: string, value: Record<string, unknown>): MockFile => ({
    id, kind: 'sound', path: `config/${id}.json`, value: { kind: 'sound', ...value }, problems: [],
    schema: {
      type: 'object',
      properties: {
        kind: { const: 'sound' },
        note: { type: 'string' },
        bus: { type: 'string', 'x-ref': 'bus', 'x-ui': { group: 'Mix' } },
        level: { type: 'number', minimum: -60, maximum: 12, 'x-ui': { widget: 'dial', unit: 'dB', step: 0.5, group: 'Mix' } },
        pitch: { ...numberOrRange, 'x-ui': { widget: 'range', min: 0.25, max: 4, step: 0.01, group: 'Mix' } },
        loop: { type: 'boolean', 'x-ui': { group: 'Mix' } },
        limit: { type: 'object', properties: {
          minGap: { type: 'number', minimum: 0, maximum: 1, 'x-ui': { unit: 's', step: 0.01 } },
          voices: { type: 'integer', minimum: 1, maximum: 32 },
          over: { enum: ['steal-oldest', 'skip'] },
        } },
        spatial: { type: 'object', properties: {
          ref: { type: 'number', minimum: 0, maximum: 50, 'x-ui': { unit: 'm', help: 'Full level inside this distance.' } },
          max: { type: 'number', minimum: 1, maximum: 200, 'x-ui': { unit: 'm' } },
          airLowpass: { type: 'boolean' },
        } },
        source: { type: 'object', properties: {
          type: { const: 'synth' },
          length: { type: 'number', minimum: 0.05, maximum: 4, 'x-ui': { unit: 's', step: 0.01 } },
          reverb: { type: 'number', minimum: 0, maximum: 1, 'x-ui': { widget: 'dial' } },
          layers: { type: 'object', 'x-ui': { widget: 'json' } },
        } },
      },
    },
  });
  return [
    {
      id: 'tuning/cube-look', kind: 'tuning', path: 'config/tuning/cube-look.json', problems: [],
      value: { kind: 'tuning', note: 'How the cube looks and moves.', spin: 1.2, bob: 0.3, size: 1, tint: '#4b8dff', wire: false, shape: 'cube', orbit: [0, 0.4, 0] },
      schema: { type: 'object', properties: {
        kind: { const: 'tuning' },
        note: { type: 'string' },
        spin: { type: 'number', minimum: 0, maximum: 10, 'x-ui': { widget: 'dial', unit: 'rad/s', group: 'Motion', help: 'Turns per second times two pi.' } },
        bob: { type: 'number', minimum: 0, maximum: 1, 'x-ui': { widget: 'dial', unit: 'm', group: 'Motion' } },
        size: { type: 'number', minimum: 0.2, maximum: 3, 'x-ui': { widget: 'dial', unit: 'm', group: 'Motion' } },
        tint: { type: 'string', 'x-ui': { widget: 'color', group: 'Look' } },
        wire: { type: 'boolean', 'x-ui': { group: 'Look', help: 'Draw edges only.' } },
        shape: { enum: ['cube', 'slab', 'pillar'], 'x-ui': { group: 'Look' } },
        orbit: { type: 'array', items: { type: 'number' }, 'x-ui': { widget: 'vec3', group: 'Look', step: 0.05 } },
      } },
    },
    sound('sound/sword/hit', {
      note: 'Blade on armour. Short and bright.', bus: 'sfx', level: -6, pitch: [0.95, 1.05],
      limit: { minGap: 0.06, voices: 4, over: 'steal-oldest' }, spatial: { ref: 4, max: 60, airLowpass: true },
      source: { type: 'synth', length: 0.5, reverb: 0.15, layers: {
        ring: { from: { osc: 'triangle', freq: [1800, 2300], glideTo: 0.7, glideTime: 0.12 }, then: [{ filter: 'bandpass', freq: 2400, q: 6 }, { envelope: { attack: 0.002, decay: 0.28, curve: 'exp' } }, { gain: -4 }] },
        clack: { from: { noise: 'white' }, then: [{ filter: 'highpass', freq: 3000 }, { envelope: { attack: 0.001, decay: 0.04 } }, { gain: -8 }] },
      } },
    }),
    sound('sound/ui/click', {
      note: 'A soft tick for buttons.', bus: 'ui', level: -10, pitch: 1,
      limit: { minGap: 0.03, voices: 2, over: 'skip' }, spatial: { ref: 5, max: 80, airLowpass: false },
      source: { type: 'synth', length: 0.12, reverb: 0, layers: { tick: { from: { osc: 'sine', freq: 1400 }, then: [{ envelope: { attack: 0.001, decay: 0.06 } }, { gain: -6 }] } } },
    }),
    {
      id: 'material/steel', kind: 'material', path: 'config/material/steel.json', problems: [],
      value: { kind: 'material', color: '#9aa4b2', roughness: 0.35, metalness: 0.9, emissive: '#000000' },
      schema: { type: 'object', properties: {
        kind: { const: 'material' },
        color: { type: 'string', 'x-ui': { widget: 'color' } },
        roughness: { type: 'number', minimum: 0, maximum: 1, 'x-ui': { widget: 'dial', group: 'Surface' } },
        metalness: { type: 'number', minimum: 0, maximum: 1, 'x-ui': { widget: 'dial', group: 'Surface' } },
        emissive: { type: 'string', 'x-ui': { widget: 'color', group: 'Surface' } },
      } },
    },
    {
      id: 'look/dusk', kind: 'look', path: 'config/look/dusk.json', problems: [{ file: 'config/look/dusk.json', pointer: '/fog/density', rule: 'schema', message: 'fog density must be at most 1, got 1.4' }],
      value: { kind: 'look', sky: '#f2a97c', ambient: 0.35, fog: { color: '#d98e6a', density: 1.4 } },
      schema: { type: 'object', properties: {
        kind: { const: 'look' },
        sky: { type: 'string', 'x-ui': { widget: 'color' } },
        ambient: { type: 'number', minimum: 0, maximum: 1, 'x-ui': { widget: 'slider' } },
        fog: { type: 'object', properties: { color: { type: 'string', 'x-ui': { widget: 'color' } }, density: { type: 'number', minimum: 0, maximum: 1, 'x-ui': { widget: 'dial' } } } },
      } },
    },
    {
      id: 'input-map/default', kind: 'input-map', path: 'config/input-map/default.json', problems: [],
      value: { kind: 'input-map', actions: { jump: { keys: ['Space'] }, left: { keys: ['KeyA', 'ArrowLeft'] } } },
      schema: { type: 'object', properties: { kind: { const: 'input-map' }, actions: { type: 'object', 'x-ui': { widget: 'json', help: 'Action names with their keys and buttons.' } } } },
    },
  ];
}

function seedTunables(): TunableWire[] {
  const t = (block: string, key: string, kind: TunableWire['kind'], value: unknown, opts: Record<string, unknown>, line: number): TunableWire =>
    ({ block, key, kind, value, opts, file: `src/${block}/tuning.ts`, line, col: 12 });
  return [
    t('cube', 'spin', 'num', 1.2, { min: 0, max: 10, unit: 'rad/s', widget: 'dial' }, 4),
    t('player', 'runSpeed', 'num', 7.5, { min: 1, max: 20, unit: 'm/s', widget: 'dial' }, 5),
    t('player', 'jumpHeight', 'num', 2.2, { min: 0.5, max: 8, unit: 'm', widget: 'dial', step: 0.1 }, 6),
    t('player', 'gravity', 'num', 24, { min: 5, max: 60, unit: 'm/s2' }, 7),
    t('player', 'coyote', 'num', 0.12, { min: 0, max: 0.4, unit: 's', step: 0.01, help: 'How long after leaving a ledge a jump still counts.' }, 8),
    t('player', 'dashDistance', 'range', [3, 5], { min: 0, max: 12, unit: 'm', step: 0.1 }, 9),
    t('player', 'doubleJump', 'bool', true, { help: 'A second jump in the air.' }, 10),
    t('player', 'stance', 'choice', 'steady', { options: ['steady', 'wild', 'calm'] }, 11),
    t('player', 'trail', 'color', '#4b8dff', {}, 12),
    t('player', 'camOffset', 'vec', [0, 4, -8], { step: 0.1 }, 13),
    t('player', 'landing', 'curve', [[0, 1], [0.3, 0.45], [0.7, 0.12], [1, 0]], { help: 'Squash after a landing, over 0.3 s.' }, 14),
  ];
}

const gamePage = (title: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#101216;overflow:hidden}canvas{display:block;width:100%;height:100%}</style></head>
<body><canvas id="c"></canvas><script>
const c=document.getElementById('c'),g=c.getContext('2d');
const S={spin:1.2,bob:0.3,size:1,tint:'#4b8dff',wire:false,shape:'cube',paused:false,timeScale:1,tick:0,time:0,acc:0};
const ws=new WebSocket('ws://'+location.host+'/?role=game');
const rep=()=>{if(ws.readyState===1)ws.send(JSON.stringify({jsonrpc:'2.0',method:'game.report',params:{tick:S.tick,time:S.time,paused:S.paused,timeScale:S.timeScale,fps:Math.round(fps)}}))};
let fps=60;
ws.onmessage=e=>{const m=JSON.parse(e.data),p=m.params||{};
 if(m.method==='tunable.changed'&&p.block==='cube'&&p.key==='spin')S.spin=p.value;
 if(m.method==='config.changed'&&p.id==='tuning/cube-look'){try{Object.assign(S,JSON.parse(p.text))}catch(_){}}
 if(m.method==='game.control'){if(p.paused!==undefined)S.paused=p.paused;if(p.timeScale)S.timeScale=p.timeScale;if(p.restart){S.tick=0;S.time=0}
  if(p.step){for(let i=0;i<p.step;i++)step();S.paused=true}rep()}};
function step(){S.tick++;S.time+=1/60}
let last=performance.now();setInterval(rep,250);
function frame(now){const dt=Math.min(.1,(now-last)/1000);last=now;fps+=(1/Math.max(dt,1e-3)-fps)*.05;
 if(!S.paused){S.acc+=dt*S.timeScale;while(S.acc>=1/60){S.acc-=1/60;step()}}
 const w=c.width=c.clientWidth*devicePixelRatio,h=c.height=c.clientHeight*devicePixelRatio;
 g.fillStyle='#101216';g.fillRect(0,0,w,h);
 const u=Math.min(w,h)/5,cx=w/2,cy=h/2+Math.sin(S.time*2)*S.bob*u*.5;
 g.fillStyle='rgba(255,255,255,.04)';g.beginPath();g.ellipse(cx,h/2+u*1.1,u*1.4,u*.3,0,0,7);g.fill();
 const a=S.time*S.spin,sx=S.size*u*(S.shape==='slab'?1.5:S.shape==='pillar'?.6:1),sy=S.size*u*(S.shape==='slab'?.5:S.shape==='pillar'?1.6:1);
 const P=[];for(const x of[-1,1])for(const y of[-1,1])for(const z of[-1,1]){const X=x*Math.cos(a)-z*Math.sin(a),Z=x*Math.sin(a)+z*Math.cos(a);P.push([cx+X*sx*.5,cy+y*sy*.5+Z*u*.12,Z])}
 const F=[[0,1,3,2],[4,5,7,6],[0,1,5,4],[2,3,7,6],[0,2,6,4],[1,3,7,5]];
 g.lineJoin='round';
 F.map(f=>[f,f.reduce((s,i)=>s+P[i][2],0)]).sort((p,q)=>p[1]-q[1]).forEach(([f,z],k)=>{g.beginPath();f.forEach((i,j)=>j?g.lineTo(P[i][0],P[i][1]):g.moveTo(P[i][0],P[i][1]));g.closePath();
  if(!S.wire){g.globalAlpha=.35+.1*k;g.fillStyle=S.tint;g.fill();g.globalAlpha=1}g.strokeStyle=S.wire?S.tint:'rgba(255,255,255,.5)';g.lineWidth=1.5*devicePixelRatio;g.stroke()});
 requestAnimationFrame(frame)}
requestAnimationFrame(frame);
</script></body></html>`;

export async function startProjectServer(opts: { root: string; port?: number; log?: (line: string) => void }): Promise<ProjectServer> {
  const files = seedFiles();
  const tunables = seedTunables();
  const journal: Change[] = [];
  const studios = new Set<WsLike>();
  const games = new Map<WsLike, string>();
  let gameCount = 0;

  const title = opts.root.split('/').filter(Boolean).pop() ?? 'Project';
  const http = createServer((req, res) => {
    if (req.url?.startsWith('/healthz')) { res.end('ok'); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(gamePage(title));
  });
  const wss = new WebSocketServer({ server: http });

  const push = <K extends PushName>(to: Iterable<WsLike>, method: K, params: Pushes[K]): void => {
    const text = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const s of to) if (s.readyState === 1) s.send(text);
  };
  const toStudios = <K extends PushName>(method: K, params: Pushes[K]): void => push(studios, method, params);
  const log = (level: Pushes['log']['level'], message: string, source: Pushes['log']['source'] = 'server'): void => toStudios('log', { level, message, source });

  const countProblems = (f: MockFile): number => f.problems.length;
  const library = (): LibraryItem[] => [
    ...files.map((f) => ({ id: f.id, kind: f.kind, path: f.path, title: f.id.split('/').slice(1).join('/'), note: typeof f.value['note'] === 'string' ? (f.value['note'] as string) : undefined, problems: countProblems(f) })),
    ...[...new Set(tunables.map((t) => t.block))].map((b) => ({ id: `tunables:${b}`, kind: 'tunables', path: `src/${b}/tuning.ts`, title: b, problems: 0 })),
  ];

  /** The few rules the mock enforces: number bounds, enums and colours. Enough to see inline problems. */
  const validate = (f: MockFile, pointer: string, value: unknown): Problem[] => {
    const parts = pointer.split('/').slice(1);
    let node: Record<string, unknown> | undefined = f.schema;
    for (const p of parts) {
      const props = node?.['properties'] as Record<string, Record<string, unknown>> | undefined;
      node = props?.[p] ?? (node?.['additionalProperties'] as Record<string, unknown> | undefined);
    }
    const bad = (message: string): Problem[] => [{ file: f.path, pointer, rule: 'schema', message }];
    if (!node) return [];
    if ((node['type'] === 'number' || node['type'] === 'integer') && typeof value !== 'number') return bad(`must be a number, got ${JSON.stringify(value)}`);
    if (typeof value === 'number') {
      if (typeof node['minimum'] === 'number' && value < node['minimum']) return bad(`must be at least ${node['minimum']}, got ${value}`);
      if (typeof node['maximum'] === 'number' && value > node['maximum']) return bad(`must be at most ${node['maximum']}, got ${value}`);
    }
    if (Array.isArray(node['enum']) && !node['enum'].includes(value)) return bad(`must be one of ${(node['enum'] as unknown[]).join(', ')}`);
    return [];
  };

  const record = (target: string, path: string, from: unknown, to: unknown): void => {
    const change: Change = { at: new Date().toISOString(), by: 'you', target, path, from, to };
    journal.push(change);
    toStudios('journal.added', change);
  };

  const handlers: { [M in MethodName]: (p: Methods[M]['params']) => Methods[M]['result'] | Promise<Methods[M]['result']> } = {
    'project.info': () => ({ root: opts.root, title, gameUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/`, manifest: { title } }),
    'library.list': () => library(),
    'config.read': ({ id }) => {
      const f = files.find((x) => x.id === id);
      if (!f) throw new Error(`there is no config file "${id}"`);
      return { id, path: f.path, text: JSON.stringify(f.value, null, 2) + '\n', value: f.value, schema: f.schema, problems: f.problems };
    },
    'config.set': ({ id, pointer, value, author }) => {
      const f = files.find((x) => x.id === id);
      if (!f) throw new Error(`there is no config file "${id}"`);
      const problems = validate(f, pointer, value);
      if (problems.length) return { ok: false, problems };
      const from = getAtPointer(f.value, pointer);
      f.value = setAtPointer(f.value, pointer, value) as Record<string, unknown>;
      f.problems = f.problems.filter((p) => p.pointer !== pointer);
      toStudios('config.changed', { id, path: f.path, text: JSON.stringify(f.value, null, 2) + '\n' });
      push(games.keys(), 'config.changed', { id, path: f.path, text: JSON.stringify(f.value) });
      record(id, pointer, from, value);
      void author;
      return { ok: true, problems: [] };
    },
    'tunables.list': () => tunables,
    'tunables.set': ({ block, key, value }) => {
      const t = tunables.find((x) => x.block === block && x.key === key);
      if (!t) throw new Error(`there is no tunable ${block}.${key}`);
      const o = t.opts as { min?: number; max?: number };
      if (t.kind === 'num' && typeof value === 'number' && ((o.min !== undefined && value < o.min) || (o.max !== undefined && value > o.max)))
        return { ok: false, problems: [{ file: t.file, line: t.line, col: t.col, rule: 'tunable', message: `${key} must be between ${o.min} and ${o.max}, got ${value}` }] };
      const from = t.value;
      t.value = value;
      push(games.keys(), 'tunable.changed', { block, key, value });
      toStudios('tunable.changed', { block, key, value });
      record(`tunables:${block}`, key, from, value);
      return { ok: true, problems: [] };
    },
    'journal.list': ({ limit }) => journal.slice(-(limit ?? 200)).reverse(),
    'game.control': (c: GameControl) => { push(games.keys(), 'game.control', c); return {}; },
    'tool.call': async ({ name }) => {
      if (name === 'build') {
        log('info', 'build: checking types', 'tool');
        await new Promise((r) => setTimeout(r, 350));
        log('info', 'build: bundling src/main.ts', 'tool');
        await new Promise((r) => setTimeout(r, 450));
        log('info', 'build: wrote dist/game.js (212 kB)', 'tool');
        return { ok: true, output: { file: `${opts.root}/dist/game.js`, dir: `${opts.root}/dist`, bytes: 217088 }, problems: [] };
      }
      if (name === 'check') return { ok: false, output: null, problems: files.flatMap((f) => f.problems) };
      throw new Error(`there is no tool "${name}"`);
    },
  };

  wss.on('connection', (ws, req) => {
    const role = new URL(req.url ?? '/', 'http://x').searchParams.get('role');
    if (role === 'game') {
      const id = `game-${++gameCount}`;
      games.set(ws, id);
      log('info', `${id} connected`, 'game');
      ws.on('message', (d) => {
        try {
          const m = JSON.parse(d.toString()) as { method?: string; params?: Pushes['game.report'] };
          if (m.method === 'game.report' && m.params) toStudios('game.report', { ...m.params, client: id });
        } catch { /* ignore */ }
      });
      ws.on('close', () => { games.delete(ws); log('info', `${id} left`, 'game'); });
      return;
    }
    studios.add(ws);
    ws.on('close', () => studios.delete(ws));
    ws.on('message', async (d) => {
      let msg: { id?: number; method?: MethodName; params?: never };
      try { msg = JSON.parse(d.toString()); } catch { return; }
      if (typeof msg.id !== 'number' || !msg.method) return;
      const h = handlers[msg.method] as ((p: unknown) => unknown) | undefined;
      try {
        if (!h) throw new Error(`unknown method ${msg.method}`);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: await h(msg.params ?? {}) }));
      } catch (e) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }));
      }
    });
    log('info', `project ${title} opened (mock server: nothing here is saved to disk)`);
  });

  await new Promise<void>((done) => http.listen(opts.port ?? 0, '127.0.0.1', done));
  const port = (http.address() as AddressInfo).port;
  opts.log?.(`mock project server on ${port}`);
  return {
    url: `ws://127.0.0.1:${port}`,
    gameUrl: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((done) => { wss.close(); http.closeAllConnections(); http.close(() => done()); }),
  };
}

export function listTemplates(): { name: string; title: string; description: string }[] {
  return [
    { name: 'cube', title: 'Cube', description: 'A spinning cube with one tuning file. The smallest project that shows every part working.' },
    { name: 'arena', title: 'Arena (sample)', description: 'A walled arena, a player and sounds. Only in the mock server.' },
  ];
}

export async function createProject(opts: { template: string; dir: string; title: string }): Promise<{ root: string }> {
  return { root: opts.dir };
}
