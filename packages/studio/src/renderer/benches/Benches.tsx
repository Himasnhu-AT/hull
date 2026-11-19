// The M3 benches: Character (turntable, clips, state graph), VFX and Look. Each runs the real engine in this
// renderer (see engine.ts). What you tune is the file: the Inspector writes it with config.set, the bench's own
// controls for speed and loop write the same way, and every result you see comes back from the engine.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { LibraryItem } from 'hull/dev/protocol';
import type { Animator } from 'hull/anim';
import type { RpcClient } from '../lib/rpc.ts';
import { throttle } from '../lib/math.ts';
import { Icon } from '../ui/Icon.tsx';
import { createStage, loadEngine, syncConfig, type Engine, type Stage } from './engine.ts';
import { GraphView, type GraphDef, type Live } from './GraphView.tsx';
import { buildCharacterScene, buildYard, type CharacterScene, type YardScene } from './scenes.ts';
import './benches.css';

export type BenchKind = 'character' | 'vfx' | 'look';
interface Props { kind: BenchKind; rpc: RpcClient; items: LibraryItem[]; selected: string | null; onSelect(id: string): void }

const short = (id: string): string => id.slice(id.indexOf('/') + 1);
const esc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Loads the engine and the project's config once, and says so while it works. */
function useEngine(rpc: RpcClient): { eng: Engine | null; error: string | null; problems: string[] } {
  const [st, setSt] = useState<{ eng: Engine | null; error: string | null; problems: string[] }>({ eng: null, error: null, problems: [] });
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const eng = await loadEngine();
        const problems = await syncConfig(rpc, eng);
        if (!dead) setSt({ eng, error: null, problems });
      } catch (e) {
        if (!dead) setSt({ eng: null, error: e instanceof Error ? e.message : String(e), problems: [] });
      }
    })();
    return () => { dead = true; };
  }, [rpc]);
  return st;
}

/** One stage in a div for as long as the bench is open. */
function useStage<T>(eng: Engine | null, make: (eng: Engine, game: Parameters<Parameters<typeof createStage>[2]>[0]) => T, opts: { look?: string | undefined; vfx?: boolean }): { host: React.RefObject<HTMLDivElement | null>; stage: Stage<T> | null; error: string | null } {
  const host = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const makeRef = useRef(make);
  makeRef.current = make;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (!eng || !host.current) return;
    let dead = false;
    let made: Stage<T> | null = null;
    createStage(eng, host.current, (g) => makeRef.current(eng, g), optsRef.current).then(
      (s) => { if (dead) s.dispose(); else { made = s; setStage(s); } },
      (e: unknown) => { if (!dead) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { dead = true; made?.dispose(); setStage(null); };
  }, [eng]);
  return { host, stage, error };
}

function Empty({ title, text }: { title: string; text: string }): JSX.Element {
  return <div className="overlay-msg"><div><b style={{ color: 'var(--text)' }}>{title}</b><div style={{ marginTop: 4 }}>{text}</div></div></div>;
}

function Picker({ label, ids, id, onSelect }: { label: string; ids: string[]; id: string | null; onSelect(id: string): void }): JSX.Element {
  return (
    <div className="seg" role="group" aria-label={label} style={{ flexWrap: 'wrap' }}>
      {ids.map((i) => <button key={i} className={i === id ? 'on' : ''} aria-pressed={i === id} onClick={() => onSelect(i)}>{short(i)}</button>)}
    </div>
  );
}

function Metric({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: 'ok' | 'warn' }): JSX.Element {
  return <div className="metric"><span>{label}</span><b style={tone ? { color: `var(--${tone})` } : undefined}>{value}</b>{unit && <small>{unit}</small>}</div>;
}

/* ---------------------------------------------------------------- character ---------------------------------------------------------------- */

interface ClipInfo { length: number; loop: boolean; speed: number; travel: number; events: { name: string; time: number }[] }

function CharacterBench({ rpc, eng, items, selected, onSelect }: Omit<Props, 'kind'> & { eng: Engine }): JSX.Element {
  const chars = useMemo(() => items.filter((i) => i.kind === 'character').map((i) => i.id), [items]);
  const id = chars.includes(selected ?? '') ? selected : (chars[0] ?? null);
  // The Inspector follows the bench: the character on show is the one it edits.
  useEffect(() => { if (id && id !== selected) onSelect(id); }, [id, selected, onSelect]);

  const look = useMemo(() => (eng.hull.config.has('look/dusk') ? 'look/dusk' : eng.hull.config.ids('look')[0] ? `look/${eng.hull.config.ids('look')[0]}` : undefined), [eng]);
  const { host, stage, error } = useStage<CharacterScene>(eng, (e, g) => buildCharacterScene(e, g), { look });

  const [mode, setMode] = useState<'clips' | 'graph'>('clips');
  const [clipNames, setClipNames] = useState<string[]>([]);
  const [clip, setClip] = useState<string | null>(null);
  const [info, setInfo] = useState<ClipInfo | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [turn, setTurn] = useState(true);
  const [look3, setLook3] = useState(false);
  const [live, setLive] = useState<(Live & { slide: number; stride: number; speed: number }) | null>(null);
  const [graphDef, setGraphDef] = useState<GraphDef | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [animTick, setAnimTick] = useState<Animator | null>(null);

  const animRef = useRef<Animator | null>(null);
  const tRef = useRef(0);
  const playRef = useRef(true);
  const modeRef = useRef(mode);
  const clipRef = useRef<string | null>(null);
  const lookRef = useRef(false);
  const params = useRef<Record<string, number | boolean>>({});
  const lastRt = useRef<unknown>(null);
  playRef.current = playing;
  modeRef.current = mode;
  clipRef.current = clip;
  lookRef.current = look3;

  // The character on the turntable follows the selection.
  useEffect(() => {
    if (!stage) return;
    animRef.current = stage.scene.setCharacter(id);
    setAnimTick(animRef.current);
    lastRt.current = null;
    params.current = {};
    setClip(null);
    setGraphDef(null);
    tRef.current = 0;
  }, [stage, id]);

  useEffect(() => { stage?.scene.setTurn(turn ? 0.6 : 0); }, [stage, turn]);

  // Every frame: the held clip pose in Clips mode (so scrubbing and playing are the engine's own sampling), the look target.
  useEffect(() => {
    if (!stage) return;
    let last = performance.now();
    return stage.game.onFrame(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const a = animRef.current;
      if (!a) return;
      if (modeRef.current === 'clips') {
        const name = clipRef.current;
        const c = name ? a.clip(name) : undefined;
        if (name && c) {
          if (playRef.current) {
            let nt = tRef.current + dt * c.speed;
            if (nt >= c.length) {
              if (c.loop) nt %= c.length;
              else { nt = c.length; playRef.current = false; setPlaying(false); }
            }
            tRef.current = nt;
          }
          if (tRef.current > c.length) tRef.current = c.length;
          a.previewClip(name, tRef.current);
        }
      }
      if (lookRef.current) {
        const tt = now / 1000;
        const p = { x: Math.sin(tt * 0.9) * 1.6, y: 1.4 + Math.sin(tt * 0.6) * 0.4, z: 1.5 };
        a.look(p);
        stage.scene.setTarget(p);
      } else {
        a.look(null);
        stage.scene.setTarget(null);
      }
    });
  }, [stage]);

  // The panel's numbers, about 15 times a second.
  useEffect(() => {
    if (!stage) return;
    const timer = setInterval(() => {
      const a = animRef.current;
      if (!a) return;
      const names = a.clipNames;
      setClipNames((cur) => (cur.join('|') === names.join('|') ? cur : names));
      setProblems((cur) => (cur.length === a.problems.length ? cur : [...a.problems]));
      const name = clipRef.current;
      const c = name ? a.clip(name) : undefined;
      if (c) {
        setInfo({ length: c.length, loop: c.loop, speed: c.speed, travel: c.travel, events: c.events.map((e) => ({ name: e.name, time: e.time })) });
        setT(tRef.current);
      } else setInfo(null);
      const rt = a.graphRuntime;
      if (rt !== lastRt.current) {
        lastRt.current = rt;
        setGraphDef(rt ? (rt.def as unknown as GraphDef) : null);
        // A rebuilt graph starts from its defaults: put the parameters you set back.
        if (rt) for (const [n, v] of Object.entries(params.current)) a.set(n, v);
      }
      if (rt && modeRef.current === 'graph') {
        const layers: Live['layers'] = {};
        for (const ln of Object.keys(rt.def.layers)) layers[ln] = { state: a.stateOf(ln) ?? '', weights: a.weights(ln) };
        const ps: Record<string, number> = {};
        for (const n of rt.paramNames) ps[n] = a.get(n);
        setLive({ layers, params: ps, slide: a.footSlide, stride: a.footStride, speed: rt.speed });
      }
    }, 66);
    return () => clearInterval(timer);
  }, [stage]);

  // A first clip to look at once the character has built.
  useEffect(() => { if (!clip && clipNames.length > 0) setClip(clipNames.includes('walk') ? 'walk' : clipNames[0]!); }, [clip, clipNames]);
  useEffect(() => { tRef.current = 0; setT(0); setPlaying(true); }, [clip]);
  useEffect(() => {
    const a = animRef.current;
    if (mode === 'graph') { a?.stopPreview(); a?.look(null); }
  }, [mode]);

  const setAnimParam = (name: string, v: number | boolean): void => { params.current[name] = v; animRef.current?.set(name, v); };

  const animSetId = useMemo(() => {
    if (!id) return null;
    try { const s = eng.hull.config.lookup('character', id.slice('character/'.length)).animSet; return typeof s === 'string' ? s : null; } catch { return null; }
  }, [eng, id, animTick]);
  const writeClip = useMemo(() => throttle((field: 'speed' | 'loop', value: number | boolean, set: string, name: string) => {
    void rpc.call('config.set', { id: set, pointer: `/clips/${esc(name)}/${field}`, value, author: 'you' });
  }, 80), [rpc]);
  useEffect(() => () => writeClip.flush(), [writeClip]);

  if (chars.length === 0) return <Empty title="No characters in this project yet" text="Characters live in config/character. Ask the AI for one, or add a file, and it shows up in the Library." />;

  const clipDef = info;
  const slideTone = live ? (live.slide < 0.15 ? 'ok' : live.slide < 0.4 ? undefined : 'warn') : undefined;
  return (
    <div className="bench bb">
      <div className="bb-row">
        <Picker label="Character" ids={chars} id={id} onSelect={onSelect} />
        <div className="seg" role="group" aria-label="What to look at">
          <button className={mode === 'clips' ? 'on' : ''} onClick={() => setMode('clips')}>Clips</button>
          <button className={mode === 'graph' ? 'on' : ''} onClick={() => setMode('graph')}>State graph</button>
        </div>
        <span style={{ flex: 1 }} />
        <button className={`chip${turn ? ' on' : ''}`} aria-pressed={turn} onClick={() => setTurn((v) => !v)}>Turntable</button>
        <button className={`chip${look3 ? ' on' : ''}`} aria-pressed={look3} onClick={() => setLook3((v) => !v)} title="IK: the head follows a moving point">Look at a point</button>
      </div>

      <div className={`bb-top${mode === 'graph' ? ' two' : ''}`}>
      <div className="bb-view" ref={host}>
        {!stage && !error && <div className="bb-load">Starting the engine...</div>}
        {error && <div className="note-err" role="alert" style={{ margin: 12 }}>{error}</div>}
        {stage && <div className="bb-tag mono">{id}</div>}
      </div>
        {mode === 'graph' && (
          <div className="bb-side">
          <div className="metrics">
            <Metric label="Ground speed" value={(live?.params['speed'] ?? 0).toFixed(2)} unit="m/s" />
            <Metric label="Feet cover" value={(live?.params['speed'] ?? 0) < 0.2 ? '-' : (live?.stride ?? 0).toFixed(2)} unit="m/s" />
            <Metric label="Foot slide" value={(live?.slide ?? 0).toFixed(2)} unit="m/s" {...(slideTone ? { tone: slideTone } : {})} />
            <Metric label="Base state" value={live?.layers['base']?.state ?? '-'} />
          </div>
          <div className="bcard">
            <h3>Parameters</h3>
            <div className="bb-params">
              {animTick?.graphRuntime && Object.entries((animTick.graphRuntime.def.params ?? {}) as Record<string, { type: string; min?: number; max?: number; default?: number | boolean }>).map(([n, p]) => {
                if (p.type === 'trigger') return <button key={n} className="btn" onClick={() => animRef.current?.trigger(n)}>{n}</button>;
                if (p.type === 'boolean') {
                  const on = (live?.params[n] ?? 0) > 0.5;
                  return <label key={n} className="bb-f check"><input type="checkbox" checked={on} onChange={(e) => setAnimParam(n, e.target.checked)} /><span>{n}</span></label>;
                }
                const v = live?.params[n] ?? 0;
                return (
                  <label key={n} className="bb-f">
                    <span>{n}</span>
                    <input type="range" min={p.min ?? 0} max={p.max ?? 10} step={0.05} value={v} aria-label={`Parameter ${n}`} onChange={(e) => setAnimParam(n, Number(e.target.value))} />
                    <b className="mono">{v.toFixed(2)}</b>
                  </label>
                );
              })}
              {!animTick?.graphRuntime && <span className="bb-dim">This character has no animation graph.</span>}
            </div>
          </div>
          </div>
        )}
      </div>

      {problems.length > 0 && <div className="note-err" role="alert">{problems.slice(0, 4).map((p, i) => <div key={i}>{p}</div>)}</div>}

      {mode === 'clips' && (
        <div className="bcard">
          <h3>Clips ({clipNames.length})</h3>
          <div className="picker">
            {clipNames.map((c) => <button key={c} className={`chip${c === clip ? ' on' : ''}`} aria-pressed={c === clip} onClick={() => setClip(c)}>{c}</button>)}
          </div>
          {clip && clipDef && (
            <>
              <div className="bb-scrub">
                <button className="bigplay sm" onClick={() => { if (!playing && !clipDef.loop && tRef.current >= clipDef.length) tRef.current = 0; setPlaying((p) => !p); }} aria-label={playing ? 'Pause the clip' : 'Play the clip'}>
                  <Icon name={playing ? 'pause' : 'play'} size={14} />
                </button>
                <div className="bb-track">
                  <input type="range" min={0} max={clipDef.length} step={clipDef.length / 400} value={Math.min(t, clipDef.length)} aria-label={`Scrub ${clip}`}
                    onChange={(e) => { tRef.current = Number(e.target.value); setT(tRef.current); setPlaying(false); }} />
                  {clipDef.events.map((e, i) => (
                    <i key={i} className="bb-ev" style={{ left: `${(Math.min(e.time, clipDef.length) / clipDef.length) * 100}%` }} title={`${e.name} at ${e.time.toFixed(2)} s`} />
                  ))}
                </div>
                <span className="mono bb-time">{t.toFixed(2)} / {clipDef.length.toFixed(2)} s</span>
              </div>
              <div className="bb-ctl">
                <label className="bb-f">
                  <span>Speed</span>
                  <input type="range" min={0.1} max={3} step={0.05} value={clipDef.speed} disabled={!animSetId} aria-label={`Speed of ${clip}`}
                    onChange={(e) => animSetId && writeClip('speed', Number(e.target.value), animSetId, clip)} />
                  <b className="mono">{clipDef.speed.toFixed(2)}x</b>
                </label>
                <label className="bb-f check">
                  <input type="checkbox" checked={clipDef.loop} disabled={!animSetId} onChange={(e) => { if (animSetId) { writeClip('loop', e.target.checked, animSetId, clip); writeClip.flush(); } }} />
                  <span>Loop</span>
                </label>
                <span className="mono bb-dim">{clipDef.travel > 0 ? `feet cover ${clipDef.travel.toFixed(2)} m/s` : 'stays in place'}</span>
                <span className="mono bb-dim">{clipDef.events.length > 0 ? `events: ${clipDef.events.map((e) => e.name).join(', ')}` : 'no events'}</span>
              </div>
              <div className="bb-dim" style={{ fontSize: 11.5 }}>Speed and Loop write to <span className="mono">{animSetId ?? '(no anim-set)'}</span>; the Inspector shows the same fields.</div>
            </>
          )}
        </div>
      )}

      {mode === 'graph' && animTick?.graphRuntime && graphDef && (
        <GraphView eng={eng} animator={animTick} def={graphDef} live={live} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- vfx and look (one yard) ---------------------------------------------------------------- */

function useYard(eng: Engine, items: LibraryItem[], lookId: string | null): { host: React.RefObject<HTMLDivElement | null>; stage: Stage<YardScene> | null; error: string | null } {
  const firstChar = items.find((i) => i.kind === 'character')?.id ?? null;
  const charRef = useRef(firstChar);
  charRef.current = firstChar;
  const r = useStage<YardScene>(eng, (e, g) => buildYard(e, g, charRef.current), { look: lookId ?? undefined, vfx: true });
  useEffect(() => { if (r.stage && lookId) r.stage.view.setLook(lookId); }, [r.stage, lookId]);
  return r;
}

function VfxBench({ eng, items, selected, onSelect }: Omit<Props, 'kind' | 'rpc'> & { eng: Engine }): JSX.Element {
  const ids = useMemo(() => items.filter((i) => i.kind === 'vfx').map((i) => i.id), [items]);
  const id = ids.includes(selected ?? '') ? selected : (ids[0] ?? null);
  useEffect(() => { if (id && id !== selected) onSelect(id); }, [id, selected, onSelect]);
  const lookId = useMemo(() => (eng.hull.config.has('look/dusk') ? 'look/dusk' : eng.hull.config.ids('look')[0] ? `look/${eng.hull.config.ids('look')[0]}` : null), [eng]);
  const { host, stage, error } = useYard(eng, items, lookId);

  const [loop, setLoop] = useState(false);
  const [every, setEvery] = useState(1.5);
  const [trail, setTrail] = useState(false);
  const [stats, setStats] = useState({ live: 0, peak: 0, fired: 0, capacity: 0, dropped: 0, draws: 0, fps: 0 });
  const peak = useRef(0);
  const base = useRef({ spawned: 0, dropped: 0 });
  const idRef = useRef(id);
  idRef.current = id;
  const { vfx, previewVfx } = eng.vfx;

  const rebase = useCallback(() => {
    const e = idRef.current ? vfx.stats().effects[idRef.current] : undefined;
    base.current = { spawned: e?.spawned ?? 0, dropped: e?.dropped ?? 0 };
    peak.current = 0;
  }, [vfx]);

  const fire = useCallback((which: string): void => {
    if (!stage) return;
    if (which === idRef.current) rebase();
    vfx.burst(which.slice('vfx/'.length), stage.scene.at);  }, [stage, vfx, rebase]);

  // Looping goes through previewVfx, the engine's own bench helper.
  useEffect(() => {
    if (!stage || !loop || !id) return;
    rebase();
    return previewVfx(id.slice('vfx/'.length), { at: stage.scene.at, every, game: stage.game });
  }, [stage, loop, id, every, previewVfx, rebase]);

  useEffect(() => {
    if (!stage || !id) return;
    rebase();
    setTrail(false);
    const timer = setInterval(() => {
      const s = vfx.stats();
      const e = s.effects[id];
      const mine = e?.live ?? 0;
      peak.current = Math.max(peak.current, mine);
      setStats({ live: mine, peak: peak.current, fired: (e?.spawned ?? 0) - base.current.spawned, capacity: e?.capacity ?? 0, dropped: (e?.dropped ?? 0) - base.current.dropped, draws: s.drawCalls, fps: stage.view.stats().fps });
    }, 50);
    return () => clearInterval(timer);
  }, [stage, id, vfx, rebase]);

  const trailRef = useRef<{ stop(): void } | null>(null);
  useEffect(() => {
    if (!stage || !id || !trail) return;
    trailRef.current = vfx.trail(id.slice('vfx/'.length), stage.scene.mover);
    return () => { trailRef.current?.stop(); trailRef.current = null; };
  }, [stage, id, trail, vfx]);

  if (ids.length === 0) return <Empty title="No effects in this project yet" text="Effects live in config/vfx. Ask the AI for one, or add a file, and it shows up in the Library." />;
  return (
    <div className="bench bb">
      <div className="bb-row"><Picker label="Effect" ids={ids} id={id} onSelect={onSelect} /></div>
      <div className="bb-view" ref={host}>
        {!stage && !error && <div className="bb-load">Starting the engine...</div>}
        {error && <div className="note-err" role="alert" style={{ margin: 12 }}>{error}</div>}
        {stage && <div className="bb-tag mono">{id}</div>}
      </div>
      <div className="bb-row">
        <button className="btn primary lg" disabled={!stage || !id} onClick={() => id && fire(id)}><Icon name="play" size={13} />Fire</button>
        <button className="btn lg" disabled={!stage} onClick={() => ids.forEach(fire)} title="Fire every effect at once">Fire all</button>
        <button className={`chip${loop ? ' on' : ''}`} aria-pressed={loop} onClick={() => setLoop((v) => !v)}>Loop</button>
        <label className="bb-f" style={{ opacity: loop ? 1 : 0.5 }}>
          <span>every</span>
          <input type="range" min={0.3} max={4} step={0.1} value={every} onChange={(e) => setEvery(Number(e.target.value))} aria-label="Seconds between bursts" />
          <b className="mono">{every.toFixed(1)} s</b>
        </label>
        <button className={`chip${trail ? ' on' : ''}`} aria-pressed={trail} onClick={() => setTrail((v) => !v)} title="Stream the effect from a node that circles">Trail on a mover</button>
        <button className="btn ghost" disabled={!stage} onClick={() => { vfx.clear(); rebase(); }}><Icon name="reset" />Clear</button>
      </div>
      <div className="metrics">
        <Metric label="Live now" value={String(stats.live)} />
        <Metric label="Peak since fired" value={String(stats.peak)} />
        <Metric label="Spawned by this effect" value={String(stats.fired)} unit={stats.dropped > 0 ? `${stats.dropped} dropped` : ''} />
        <Metric label="Pool capacity" value={String(stats.capacity)} />
      </div>
      <div className="bb-dim mono" style={{ fontSize: 11.5 }}>{stats.draws} draw call{stats.draws === 1 ? '' : 's'} for particles · {Math.round(stats.fps)} fps in this view</div>
    </div>
  );
}

function LookBench({ eng, items, selected, onSelect }: Omit<Props, 'kind' | 'rpc'> & { eng: Engine }): JSX.Element {
  const ids = useMemo(() => items.filter((i) => i.kind === 'look').map((i) => i.id), [items]);
  const id = ids.includes(selected ?? '') ? selected : (ids[0] ?? null);
  useEffect(() => { if (id && id !== selected) onSelect(id); }, [id, selected, onSelect]);
  const { host, stage, error } = useYard(eng, items, id);
  const [q, setQ] = useState<'low' | 'medium' | 'high'>('high');
  useEffect(() => { stage?.view.setQuality(q); }, [stage, q]);
  if (ids.length === 0) return <Empty title="No looks in this project yet" text="A look is the sky, fog, light and post-processing of a scene. It lives in config/look." />;
  return (
    <div className="bench bb">
      <div className="bb-row">
        <Picker label="Look" ids={ids} id={id} onSelect={onSelect} />
        <span style={{ flex: 1 }} />
        <div className="seg" role="group" aria-label="Quality">
          {(['low', 'medium', 'high'] as const).map((k) => <button key={k} className={q === k ? 'on' : ''} onClick={() => setQ(k)}>{k}</button>)}
        </div>
      </div>
      <div className="bb-view" ref={host}>
        {!stage && !error && <div className="bb-load">Starting the engine...</div>}
        {error && <div className="note-err" role="alert" style={{ margin: 12 }}>{error}</div>}
        {stage && <div className="bb-tag mono">{id}</div>}
      </div>
      <div className="bb-dim" style={{ fontSize: 12 }}>The yard has metal, a gem, a crate, a wall and the first character, so you see how the look treats each. Change a value in the Inspector and it shows here at once.</div>
    </div>
  );
}

/* ---------------------------------------------------------------- entry ---------------------------------------------------------------- */

export function BenchView({ kind, rpc, items, selected, onSelect }: Props): JSX.Element {
  const { eng, error, problems } = useEngine(rpc);
  if (error) return <div className="overlay-msg"><div className="note-err" role="alert">The engine did not load: {error}</div></div>;
  if (!eng) return <div className="overlay-msg"><div>Loading the engine...</div></div>;
  return (
    <>
      {kind === 'character' && <CharacterBench rpc={rpc} eng={eng} items={items} selected={selected} onSelect={onSelect} />}
      {kind === 'vfx' && <VfxBench eng={eng} items={items} selected={selected} onSelect={onSelect} />}
      {kind === 'look' && <LookBench eng={eng} items={items} selected={selected} onSelect={onSelect} />}
      {problems.length > 0 && <div className="bb-probs" title={problems.join('\n')}>{problems.length} config problem{problems.length === 1 ? '' : 's'} on load</div>}
    </>
  );
}
