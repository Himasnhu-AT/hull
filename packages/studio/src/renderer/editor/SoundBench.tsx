// The sound bench: pick a sound, hear it, see it. The recipe comes from config.read, is rendered offline by
// hull/audio (renderSound), played with playBuffer and drawn from measureSound. Any edit to the file, from the
// Inspector, an agent or an editor on disk, arrives as config.changed and renders again.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { LibraryItem } from 'hull/dev/protocol';
import type { RpcClient } from '../lib/rpc.ts';
import { loadAudio, spectralCentroid, type AudioApi, type Measure } from '../lib/audioApi.ts';
import { Icon } from '../ui/Icon.tsx';

interface Props { rpc: RpcClient; sounds: LibraryItem[]; selected: string | null; onSelect(id: string): void }

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

/** A canvas that keeps its backing store at the device pixel ratio and redraws when its size or the theme changes. */
function useCanvas(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]): React.RefObject<HTMLCanvasElement | null> {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const paint = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    drawRef.current(g, w, h);
  }, []);
  useEffect(() => {
    paint();
    const c = ref.current;
    const ro = c ? new ResizeObserver(paint) : null;
    if (c) ro?.observe(c);
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', paint);
    return () => { ro?.disconnect(); mq.removeEventListener('change', paint); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

const fmtDb = (v: number): string => (v <= -90 ? '-inf' : v.toFixed(1));

function drawWave(g: CanvasRenderingContext2D, w: number, h: number, m: Measure | null, ghost: Measure | null): void {
  const mid = h / 2;
  g.strokeStyle = css('--line2');
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, Math.round(mid) + 0.5); g.lineTo(w, Math.round(mid) + 0.5); g.stroke();
  const fill = (meas: Measure, color: string, alpha: number): void => {
    const wf = meas.waveform;
    const pairs = wf.length >= 1024;
    const n = pairs ? wf.length / 2 : wf.length;
    g.fillStyle = color;
    g.globalAlpha = alpha;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const hi = pairs ? wf[i * 2 + 1]! : Math.abs(wf[i]!);
      const x = (i / (n - 1)) * w;
      g.lineTo(x, mid - Math.min(1, Math.max(0, hi)) * (mid - 4));
    }
    for (let i = n - 1; i >= 0; i--) {
      const lo = pairs ? wf[i * 2]! : -Math.abs(wf[i]!);
      g.lineTo((i / (n - 1)) * w, mid - Math.max(-1, Math.min(0, lo)) * (mid - 4));
    }
    g.closePath(); g.fill();
    g.globalAlpha = 1;
  };
  if (ghost) fill(ghost, css('--faint'), 0.4);
  if (m) fill(m, css('--accent'), 1);
}

function drawSpectrum(g: CanvasRenderingContext2D, w: number, h: number, m: Measure | null): void {
  if (!m) return;
  const n = m.spectrum.length;
  const gap = 2;
  const bw = (w - gap * (n - 1)) / n;
  g.fillStyle = css('--accent');
  for (let i = 0; i < n; i++) {
    const db = Math.max(-96, Math.min(0, m.spectrum[i] ?? -72));
    if (db <= -95) continue;
    const bh = Math.max(1.5, ((db + 96) / 96) * (h - 2));
    g.beginPath();
    g.roundRect(i * (bw + gap), h - bh, bw, bh, 1.5);
    g.fill();
  }
}

export function SoundBench({ rpc, sounds, selected, onSelect }: Props): JSX.Element {
  const [audio, setAudio] = useState<AudioApi | null>(null);
  const id = sounds.some((s) => s.id === selected) ? selected : (sounds[0]?.id ?? null);
  const [buf, setBuf] = useState<AudioBuffer | null>(null);
  const [m, setM] = useState<Measure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  // The first render of each sound in this session, to compare edits against.
  const first = useRef(new Map<string, { buf: AudioBuffer; m: Measure }>());
  const [ghost, setGhost] = useState<{ buf: AudioBuffer; m: Measure } | null>(null);
  const renderSeq = useRef(0);

  useEffect(() => { void loadAudio().then(setAudio).catch((e) => setError(`The audio engine did not load: ${String(e)}`)); }, []);

  const render = useCallback(async (): Promise<void> => {
    if (!audio || !id) return;
    const seq = ++renderSeq.current;
    setRendering(true);
    try {
      const doc = await rpc.call('config.read', { id });
      const b = await audio.renderSound(doc.value);
      if (seq !== renderSeq.current) return;
      const meas = audio.measureSound(b);
      if (!first.current.has(id)) first.current.set(id, { buf: b, m: meas });
      setGhost(first.current.get(id) ?? null);
      setBuf(b);
      setM(meas);
      setError(null);
    } catch (e) {
      if (seq === renderSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === renderSeq.current) setRendering(false);
    }
  }, [audio, id, rpc]);

  useEffect(() => { setBuf(null); setM(null); void render(); }, [render]);

  // Re-render on every edit, a moment after the last one so a drag does not queue a render per frame.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = rpc.on('config.changed', (p) => {
      if (p.id !== id) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void render(), 120);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [rpc, id, render]);

  const differs = (a: Measure, b: Measure): boolean => a.peakDb !== b.peakDb || a.loudnessDb !== b.loudnessDb || a.duration !== b.duration || a.waveform.some((v, i) => v !== b.waveform[i]);
  const showGhost = ghost && m && differs(ghost.m, m) ? ghost.m : null;
  const wave = useCanvas((g, w, h) => drawWave(g, w, h, m, showGhost), [m, showGhost]);
  const spec = useCanvas((g, w, h) => drawSpectrum(g, w, h, m), [m]);

  if (sounds.length === 0) {
    return <div className="overlay-msg"><div><b style={{ color: 'var(--text)' }}>No sounds in this project yet</b><div style={{ marginTop: 4 }}>Sounds live in config/sound. Ask the AI for one, or add a file, and it shows up in the Library.</div></div></div>;
  }

  const centre = m ? spectralCentroid(m.spectrum) : 0;
  return (
    <div className="bench">
      <div className="picker" role="group" aria-label="Sound">
        <div className="seg" style={{ flexWrap: 'wrap' }}>
          {sounds.map((s) => <button key={s.id} className={s.id === id ? 'on' : ''} aria-pressed={s.id === id} onClick={() => onSelect(s.id)}>{s.id.replace(/^sound\//, '')}</button>)}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="bigplay" disabled={!buf} onClick={() => buf && audio?.playBuffer(buf)} aria-label="Play the sound" title="Play"><Icon name="play" size={18} /></button>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="mono" style={{ fontSize: 15, fontWeight: 500 }}>{id}</div>
          <div style={{ color: 'var(--muted)' }}>
            {rendering && !m ? 'Rendering...' : 'Plays from the file as it is now. Change a value and it renders again.'}
            {audio?.source === 'preview' && <span style={{ color: 'var(--warn)' }}> Preview renderer: hull/audio is not in this build yet.</span>}
          </div>
        </div>
        <button className="chip" disabled={!showGhost} onClick={() => showGhost && ghost && audio?.playBuffer(ghost.buf)} title="Hear the version from when you opened the project" style={showGhost ? undefined : { opacity: 0.45 }}>
          <Icon name="reset" />Before your edits
        </button>
      </div>
      {error && <div className="note-err" role="alert">{error}</div>}
      <div className="bcard">
        <div className="legend"><span><i style={{ background: 'var(--accent)' }} />Now</span>{showGhost && <span><i style={{ background: 'var(--faint)' }} />Before your edits</span>}</div>
        <canvas ref={wave} style={{ height: 140 }} role="img" aria-label="Waveform" />
        <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--faint)', fontSize: 10.5 }}>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{m ? `${Math.round(f * m.duration * 1000)} ms` : ''}</span>)}
        </div>
      </div>
      <div className="metrics">
        <div className="metric"><span>Peak</span><b style={{ color: m && m.peakDb > -1 ? 'var(--warn)' : undefined }}>{m ? fmtDb(m.peakDb) : '-'}</b><small>dBFS</small></div>
        <div className="metric"><span>Loudness</span><b>{m ? fmtDb(m.loudnessDb) : '-'}</b><small>dB RMS</small></div>
        <div className="metric"><span>Length</span><b>{m ? Math.round(m.duration * 1000) : '-'}</b><small>ms</small></div>
        <div className="metric"><span>Brightness</span><b>{m ? (centre >= 1000 ? (centre / 1000).toFixed(1) : Math.round(centre)) : '-'}</b><small>{centre >= 1000 ? 'kHz' : 'Hz'}</small></div>
      </div>
      <div className="bcard">
        <h3>Spectrum</h3>
        <canvas ref={spec} style={{ height: 110 }} role="img" aria-label="Spectrum" />
        <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--faint)', fontSize: 10.5 }}><span>60 Hz</span><span>1 kHz</span><span>16 kHz</span></div>
      </div>
    </div>
  );
}
