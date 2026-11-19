// The Inspector's widgets. Each one shows the value it is given and reports changes through `onChange(value, final)`:
// `final` is true when a gesture ends (pointer up, Enter, blur), so the caller can flush its throttle.
// Dragging is 1:1 from the value at pointer-down (math.ts); nothing here waits for the server to answer.

import { memo, useCallback, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { defaultFor, itemTitle, listItemFields, mapEntryFields, type Field } from '../lib/schemaForm.ts';
import {
  arcPath, clamp, curveAt, curveMove, dialAngle, dialDrag, dragScale, formatNumber, fromFraction, nearestEnd, rangeMove, sameJson,
  scrubDelta, snap, toFraction, type CurvePoint,
} from '../lib/math.ts';
import { leaveBox } from '../lib/keys.ts';
import { Icon } from './Icon.tsx';

export type Change = (pointer: string, value: unknown, final?: boolean) => void;

export interface FieldViewProps {
  field: Field;
  value: unknown;
  /** The value when the project was opened (what the AI wrote): the reset arrow goes back to it. */
  baseline: unknown;
  problems: readonly string[];
  /** Ids of the kind a `ref` field points at. */
  refOptions: readonly string[];
  /** Ids of any kind, for the `ref` fields inside a map's entries. */
  refs?: (kind: string) => string[];
  onChange: Change;
}

const asNum = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/* ---------- pointer gestures ---------- */

interface DragState<T> { id: number; x0: number; y0: number; s: T }

/** Pointer-captured drag: start gives the state to remember, move/end receive it with the distance travelled. */
function useDrag<T>(handlers: {
  start(e: RPointerEvent<Element>): T;
  move(e: RPointerEvent<Element>, s: T, dx: number, dy: number): void;
  end?(e: RPointerEvent<Element>, s: T): void;
}): { onPointerDown(e: RPointerEvent<Element>): void; onPointerMove(e: RPointerEvent<Element>): void; onPointerUp(e: RPointerEvent<Element>): void; onPointerCancel(e: RPointerEvent<Element>): void } {
  const st = useRef<DragState<T> | null>(null);
  const h = useRef(handlers);
  h.current = handlers;
  return {
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      st.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, s: h.current.start(e) };
    },
    onPointerMove: (e) => {
      const d = st.current;
      if (d && d.id === e.pointerId) h.current.move(e, d.s, e.clientX - d.x0, e.clientY - d.y0);
    },
    onPointerUp: (e) => {
      const d = st.current;
      if (!d || d.id !== e.pointerId) return;
      st.current = null;
      h.current.end?.(e, d.s);
    },
    onPointerCancel: (e) => {
      const d = st.current;
      st.current = null;
      if (d) h.current.end?.(e, d.s);
    },
  };
}

/* ---------- number input ---------- */

function NumInput({ value, step, label, onCommit, className, blank }: { value: number; step: number; label: string; onCommit(v: number): void; className?: string; blank?: boolean }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const finish = (): void => {
    if (draft === null) return;
    const n = Number.parseFloat(draft.replace(',', '.'));
    setDraft(null);
    if (Number.isFinite(n) && n !== value) onCommit(n);
  };
  return (
    <input
      className={className}
      aria-label={label}
      inputMode="decimal"
      onKeyUp={leaveBox}
      value={draft ?? (blank ? '' : formatNumber(value, step))}
      placeholder={blank ? '\u2014' : undefined}
      onFocus={(e) => { setDraft(blank ? '' : formatNumber(value, step)); e.currentTarget.select(); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setDraft(null);
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const cur = draft === null ? value : Number.parseFloat(draft);
          const next = (Number.isFinite(cur) ? cur : value) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
          setDraft(null);
          onCommit(Number(next.toFixed(6)));
        }
      }}
    />
  );
}

/* ---------- shells ---------- */

function ResetButton({ onClick }: { onClick(): void }): JSX.Element {
  return (
    <button className="rs" onClick={onClick} aria-label="Back to the value the AI wrote" title="Back to the value the AI wrote">
      <Icon name="reset" />
    </button>
  );
}

function Problems({ list }: { list: readonly string[] }): JSX.Element | null {
  if (list.length === 0) return null;
  return <>{list.map((m, i) => <div key={i} className="err" role="alert"><Icon name="warn" /><span>{m}</span></div>)}</>;
}

/** A label you can drag sideways to change the number, like Unity. */
function ScrubLabel({ field, value, onChange }: { field: Field; value: number; onChange(v: number, final: boolean): void }): JSX.Element {
  const last = useRef(value);
  last.current = value;
  const drag = useDrag<number>({
    start: () => value,
    move: (e, s, dx) => onChange(scrubDelta(s, dx, field.min, field.max, field.step, dragScale(e)), false),
    end: () => onChange(last.current, true),
  });
  return <label className="fl scrub" title="Drag sideways to change. Shift: fine. Alt: coarse." {...drag}>{field.label}</label>;
}

/* ---------- slider ---------- */

function Slider({ field, value, onChange }: { field: Field; value: number; onChange(v: number, final: boolean): void }): JSX.Element {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const at = (clientX: number): number => {
    const r = track.current!.getBoundingClientRect();
    return snap(fromFraction((clientX - r.left) / r.width, field.min, field.max), field.min, field.max, field.step);
  };
  const last = useRef(value);
  last.current = value;
  const drag = useDrag<null>({
    start: (e) => { setActive(true); onChange(at(e.clientX), false); return null; },
    move: (e) => onChange(at(e.clientX), false),
    end: () => { setActive(false); onChange(last.current, true); },
  });
  const f = toFraction(value, field.min, field.max) * 100;
  const key = (e: KeyboardEvent): void => {
    const big = e.shiftKey ? 10 : 1;
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'PageUp' ? 10 : e.key === 'PageDown' ? -10 : 0;
    if (e.key === 'Home') { e.preventDefault(); onChange(field.min, true); }
    else if (e.key === 'End') { e.preventDefault(); onChange(field.max, true); }
    else if (d) { e.preventDefault(); onChange(snap(value + d * field.step * big, field.min, field.max, field.step), true); }
  };
  return (
    <>
      <div ref={track} className="slider" role="slider" tabIndex={0} aria-label={field.label} aria-valuemin={field.min} aria-valuemax={field.max} aria-valuenow={value} onKeyDown={key} {...drag}>
        <span className="base" /><span className="fill" style={{ left: 0, width: `${f}%` }} /><span className={`thumb${active ? ' drag' : ''}`} style={{ left: `${f}%` }} />
      </div>
      <div className="scale"><span>{formatNumber(field.min, field.step)}</span><span>{formatNumber(field.max, field.step)}</span></div>
    </>
  );
}

/* ---------- dial ---------- */

export const Dial = memo(function Dial({ field, value, baseline, problems, onChange }: FieldViewProps): JSX.Element {
  const v = asNum(value);
  const f = toFraction(v, field.min, field.max);
  const changed = baseline !== undefined && !sameJson(value, baseline);
  const [grab, setGrab] = useState(false);
  const send = (n: number, final = false): void => onChange(field.pointer, n, final);
  const last = useRef(v);
  last.current = v;
  const drag = useDrag<number>({
    start: () => { setGrab(true); return v; },
    move: (e, s, _dx, dy) => send(dialDrag(s, dy, field.min, field.max, field.step, dragScale(e))),
    end: () => { setGrab(false); send(last.current, true); },
  });
  const a1 = dialAngle(f);
  return (
    <div className={`dial${changed ? ' mod' : ''}${problems.length ? ' bad' : ''}`}>
      <button
        className="knob" role="slider" aria-label={field.label} aria-valuemin={field.min} aria-valuemax={field.max} aria-valuenow={v}
        title={`${field.label}. Drag up or down. Shift: fine. Double-click: back to the AI's value.`}
        onDoubleClick={() => { if (baseline !== undefined) onChange(field.pointer, baseline, true); }}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
          if (d) { e.preventDefault(); send(snap(v + d * field.step * (e.shiftKey ? 10 : 1), field.min, field.max, field.step), true); }
        }}
        {...drag}
      >
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <path d={arcPath(32, 32, 25, -135, 135)} stroke="var(--track)" strokeWidth="5" fill="none" strokeLinecap="round" />
          <path d={arcPath(32, 32, 25, -135, a1)} stroke="var(--accent)" strokeWidth="5" fill="none" strokeLinecap="round" />
          <circle cx="32" cy="32" r={grab ? 17 : 16} fill="var(--panel2)" stroke="var(--line2)" style={{ transition: 'r 0.12s var(--ease)' }} />
        </svg>
        <span className="kv">{formatNumber(v, field.step)}</span>
      </button>
      <span className="dl" title={field.help || field.label}>{field.label}</span>
      <span className="du">{field.unit}</span>
      <button className="rs" onClick={() => { if (baseline !== undefined) onChange(field.pointer, baseline, true); }} aria-label="Back to the value the AI wrote" title="Back to the value the AI wrote"><Icon name="reset" /></button>
      {problems.length > 0 && <div style={{ gridColumn: '1 / -1' }}><Problems list={problems} /></div>}
    </div>
  );
});

/* ---------- range (two ends) ---------- */

function RangeBody({ field, pair, onChange }: { field: Field; pair: [number, number]; onChange(p: [number, number], final: boolean): void }): JSX.Element {
  const track = useRef<HTMLDivElement>(null);
  const cur = useRef(pair);
  cur.current = pair;
  const at = (clientX: number): number => {
    const r = track.current!.getBoundingClientRect();
    return fromFraction((clientX - r.left) / r.width, field.min, field.max);
  };
  const drag = useDrag<0 | 1>({
    start: (e) => {
      const which = nearestEnd(cur.current, at(e.clientX));
      onChange(rangeMove(cur.current, which, at(e.clientX), field.min, field.max, field.step), false);
      return which;
    },
    move: (e, which) => onChange(rangeMove(cur.current, which, at(e.clientX), field.min, field.max, field.step), false),
    end: () => onChange(cur.current, true),
  });
  const lo = toFraction(pair[0], field.min, field.max) * 100;
  const hi = toFraction(pair[1], field.min, field.max) * 100;
  return (
    <>
      <div ref={track} className="slider" role="group" aria-label={`${field.label}, drag either end`} {...drag}>
        <span className="base" /><span className="fill" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
        <span className="thumb" style={{ left: `${lo}%` }} /><span className="thumb" style={{ left: `${hi}%` }} />
      </div>
      <div className="scale"><span>{formatNumber(field.min, field.step)}</span><span>{formatNumber(field.max, field.step)}</span></div>
    </>
  );
}

/* ---------- curve ---------- */

const CW = 260;
const CH = 96;

function CurveBody({ field, points, onChange }: { field: Field; points: CurvePoint[]; onChange(p: CurvePoint[], final: boolean): void }): JSX.Element {
  const svg = useRef<SVGSVGElement>(null);
  const cur = useRef(points);
  cur.current = points;
  const vMin = Number.isFinite(field.min) ? field.min : 0;
  const vMax = Number.isFinite(field.max) ? field.max : 1;
  const px = (t: number): number => 6 + t * (CW - 12);
  const py = (v: number): number => 6 + (1 - (v - vMin) / (vMax - vMin || 1)) * (CH - 12);
  const toLocal = (e: { clientX: number; clientY: number }): { t: number; v: number } => {
    const r = svg.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * CW;
    const y = ((e.clientY - r.top) / r.height) * CH;
    return { t: clamp((x - 6) / (CW - 12), 0, 1), v: vMin + (1 - clamp((y - 6) / (CH - 12), 0, 1)) * (vMax - vMin) };
  };
  const drag = useDrag<number>({
    start: (e) => Number(e.currentTarget.getAttribute('data-i')),
    move: (e, i) => { const p = toLocal(e); onChange(curveMove(cur.current, i, p.t, p.v, vMin, vMax), false); },
    end: () => onChange(cur.current, true),
  });
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)} ${py(p[1]).toFixed(1)}`).join(' ');
  const addPoint = (e: React.MouseEvent): void => {
    const { t } = toLocal(e);
    const next = [...cur.current, [Number(t.toFixed(3)), Number(curveAt(cur.current, t).toFixed(3))] as CurvePoint].sort((a, b) => a[0] - b[0]);
    onChange(next, true);
  };
  return (
    <>
      <svg ref={svg} className="curve" viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="none" role="group" aria-label={`${field.label} curve, drag the points. Double-click to add or remove one.`} onDoubleClick={addPoint}>
        <line x1="6" y1={py(0)} x2={CW - 6} y2={py(0)} stroke="var(--line2)" strokeDasharray="3 4" />
        <line x1={px(1 / 3)} y1="0" x2={px(1 / 3)} y2={CH} stroke="var(--line)" /><line x1={px(2 / 3)} y1="0" x2={px(2 / 3)} y2={CH} stroke="var(--line)" />
        <path d={path} stroke="var(--accent)" strokeWidth="2" fill="none" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <circle key={i} data-i={i} cx={px(p[0])} cy={py(p[1])} r="6" fill="#fff" stroke="var(--accent)" strokeWidth="2" style={{ cursor: 'ns-resize', touchAction: 'none' }}
            onDoubleClick={(e) => { e.stopPropagation(); if (i > 0 && i < points.length - 1) onChange(points.filter((_, j) => j !== i), true); }}
            {...drag} />
        ))}
      </svg>
      <div className="scale"><span>0</span><span>time 0 to 1</span><span>1</span></div>
    </>
  );
}

/* ---------- vec3 ---------- */

const AXES = [['X', 'var(--ax-x)'], ['Y', 'var(--ax-y)'], ['Z', 'var(--ax-z)']] as const;

function Axis({ field, n, label, color, value, onChange }: { field: Field; n: number; label: string; color: string; value: number; onChange(v: number, final: boolean): void }): JSX.Element {
  const last = useRef(value);
  last.current = value;
  const drag = useDrag<number>({
    start: () => value,
    move: (e, s, dx) => onChange(scrubDelta(s, dx, field.min, field.max, field.step, dragScale(e)), false),
    end: () => onChange(last.current, true),
  });
  return (
    <div className="axis">
      <label style={{ background: color }} title="Drag sideways to scrub" {...drag}>{label}</label>
      <NumInput value={value} step={field.step} label={`${field.label} ${label}`} onCommit={(v) => onChange(v, true)} />
    </div>
  );
}

/* ---------- colour ---------- */

const PRESETS = ['#5a9bff', '#3cc482', '#f2a43c', '#ff7a70', '#e9ebee', '#2a2e35'];

/* ---------- one field ---------- */

export const FieldView = memo(function FieldView({ field, value, baseline, problems, refOptions, refs, onChange }: FieldViewProps): JSX.Element {
  const changed = baseline !== undefined && !sameJson(value, baseline);
  const send = useCallback((v: unknown, final = false) => onChange(field.pointer, v, final), [onChange, field.pointer]);
  const reset = (): void => { if (baseline !== undefined) send(baseline, true); };
  const w = field.widget;
  const cls = `fld${changed ? ' mod' : ''}${problems.length ? ' bad' : ''}${field.unset ? (field.def !== undefined ? ' dflt' : ' unset') : ''}`;
  const unit = field.unit ? <small>{field.unit}</small> : null;

  if (w === 'toggle') {
    const on = value === true;
    return (
      <div className={cls}>
        <div className="fh">
          <span className="fl" title={field.help}>{field.label}</span>
          <button className={`tg${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={field.label} onClick={() => send(!on, true)} />
          <ResetButton onClick={reset} />
        </div>
        {field.help && <div className="help">{field.help}</div>}
        <Problems list={problems} />
      </div>
    );
  }

  if (w === 'slider' || w === 'number' || w === 'dial') {
    const v = asNum(value);
    return (
      <div className={cls}>
        <div className="fh">
          <ScrubLabel field={field} value={v} onChange={(n, final) => send(n, final)} />
          <span className="fv"><NumInput value={v} step={field.step} label={field.label} blank={value === undefined} onCommit={(n) => send(n, true)} />{unit}</span>
          <ResetButton onClick={reset} />
        </div>
        {w !== 'number' && <Slider field={field} value={v} onChange={(n, final) => send(n, final)} />}
        {field.help && <div className="help">{field.help}</div>}
        <Problems list={problems} />
      </div>
    );
  }

  if (w === 'range') {
    // A bare number is a range of one value (docs/SCHEMAS.md "numberOrRange"); dragging turns it into a pair.
    const pair: [number, number] = Array.isArray(value) ? [asNum(value[0]), asNum(value[1])] : [asNum(value), asNum(value)];
    const lo = Number.isFinite(field.min) ? field.min : Math.min(0, pair[0]);
    const hi = Number.isFinite(field.max) ? field.max : Math.max(1, pair[1]);
    const f = { ...field, min: lo, max: hi };
    return (
      <div className={cls}>
        <div className="fh">
          <span className="fl" title={field.help}>{field.label}</span>
          <span className="fv">
            <NumInput value={pair[0]} step={field.step} label={`${field.label} from`} onCommit={(n) => send(rangeMove(pair, 0, n, lo, hi, field.step), true)} />
            <span style={{ color: 'var(--faint)', padding: '0 3px' }}>to</span>
            <NumInput value={pair[1]} step={field.step} label={`${field.label} to`} onCommit={(n) => send(rangeMove(pair, 1, n, lo, hi, field.step), true)} />
            {unit}
          </span>
          <ResetButton onClick={reset} />
        </div>
        <RangeBody field={f} pair={pair} onChange={(p, final) => send(p, final)} />
        {field.help && <div className="help">{field.help}</div>}
        <Problems list={problems} />
      </div>
    );
  }

  if (w === 'curve') {
    const pts: CurvePoint[] = Array.isArray(value) ? (value as unknown[]).filter((p): p is CurvePoint => Array.isArray(p) && p.length === 2).map((p) => [asNum(p[0]), asNum(p[1])]) : [[0, 0], [1, 1]];
    return (
      <div className={cls}>
        <div className="fh"><span className="fl" title={field.help}>{field.label}</span><ResetButton onClick={reset} /></div>
        <CurveBody field={field} points={pts} onChange={(p, final) => send(p, final)} />
        {field.help && <div className="help">{field.help}</div>}
        <Problems list={problems} />
      </div>
    );
  }

  if (w === 'vec3') {
    const v = Array.isArray(value) ? [asNum(value[0]), asNum(value[1]), asNum(value[2])] : [0, 0, 0];
    return (
      <div className={cls}>
        <div className="fh"><span className="fl" title={field.help}>{field.label}</span>{field.unit && <span className="fv" style={{ background: 'none', padding: 0 }}>{unit}</span>}<ResetButton onClick={reset} /></div>
        <div className="vec">
          {AXES.map(([name, color], i) => (
            <Axis key={name} field={field} n={i} label={name} color={color} value={v[i]!}
              onChange={(n, final) => { const next = [...v]; next[i] = n; send(next, final); }} />
          ))}
        </div>
        {field.help && <div className="help">{field.help}</div>}
        <Problems list={problems} />
      </div>
    );
  }

  if (w === 'color') {
    const hex = typeof value === 'string' ? value : '#000000';
    const presets = PRESETS.some((p) => p.toLowerCase() === hex.toLowerCase()) ? PRESETS : [hex, ...PRESETS.slice(0, 5)];
    return (
      <div className={cls}>
        <div className="fh"><span className="fl" title={field.help}>{field.label}</span><span className="fv"><span style={{ color: 'var(--muted)' }}>{typeof value === 'string' ? hex.toLowerCase() : '\u2014'}</span></span><ResetButton onClick={reset} /></div>
        <div className="sws">
          {presets.map((c) => (
            <button key={c} className={`swc${c.toLowerCase() === hex.toLowerCase() ? ' on' : ''}`} style={{ background: c }} onClick={() => send(c, true)} aria-label={`${field.label} ${c}`} />
          ))}
          <input className="pick" type="color" value={/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000'} aria-label={`${field.label}, pick any colour`}
            onChange={(e) => send(e.target.value, false)} onBlur={(e) => send(e.target.value, true)} />
        </div>
        {field.help && <div className="help">{field.help}</div>}
        <Problems list={problems} />
      </div>
    );
  }

  if (w === 'segments') {
    return (
      <div className={cls}>
        <div className="fh"><span className="fl" title={field.help}>{field.label}</span><ResetButton onClick={reset} /></div>
        <div className="seg full" role="group" aria-label={field.label}>
          {field.options.map((o) => <button key={o} className={String(value) === o ? 'on' : ''} aria-pressed={String(value) === o} onClick={() => send(optionValue(field, o), true)} title={o}>{o}</button>)}
        </div>
        {field.help && <div className="help">{field.help}</div>}
        <Problems list={problems} />
      </div>
    );
  }

  if (w === 'select' || w === 'ref') {
    const opts = w === 'ref' ? [...new Set([...refOptions, ...(typeof value === 'string' && value ? [value] : [])])] : field.options;
    return (
      <div className={cls}>
        <div className="fh"><label className="fl" htmlFor={`f${field.pointer}`} title={field.help}>{field.label}</label><ResetButton onClick={reset} /></div>
        {opts.length > 0 ? (
          <select id={`f${field.pointer}`} className="field-in" value={String(value ?? '')} onChange={(e) => send(optionValue(field, e.target.value), true)}>
            {value === undefined && <option value="" disabled>Choose...</option>}
            {opts.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : <input id={`f${field.pointer}`} className="field-in" value={String(value ?? '')} onChange={(e) => send(e.target.value, false)} onBlur={(e) => send(e.target.value, true)} />}
        {field.help && <div className="help">{field.help}</div>}
        <Problems list={problems} />
      </div>
    );
  }

  if (w === 'checks') {
    return <ChecksField className={cls} field={field} value={value} send={send} reset={reset} problems={problems} />;
  }

  if (w === 'list') {
    return <ListField className={cls} field={field} value={value} problems={problems} refs={refs} send={send} reset={reset} onChange={onChange} />;
  }

  if (w === 'map') {
    return <MapField className={cls} field={field} value={value} problems={problems} refs={refs} send={send} reset={reset} onChange={onChange} />;
  }

  if (w === 'text' || w === 'keys') {
    return <TextField className={cls} field={field} value={value} send={send} reset={reset} problems={problems} />;
  }

  return <JsonField className={cls} field={field} value={value} send={send} reset={reset} problems={problems} />;
});

/** The real value behind an option label: a number or boolean stays one. */
const optionValue = (field: Field, label: string): unknown => {
  const i = field.options.indexOf(label);
  return i >= 0 && i < field.optionValues.length ? field.optionValues[i] : typeof field.value === 'number' ? Number(label) : label;
};

function TextField({ className, field, value, send, reset, problems }: { className: string; field: Field; value: unknown; send(v: unknown, final?: boolean): void; reset(): void; problems: readonly string[] }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  // A list of words (key names, feature names) is typed with commas and stored as an array.
  const list = field.widget === 'keys' && (Array.isArray(value) || value === undefined);
  const shown = list ? (Array.isArray(value) ? value.join(', ') : '') : String(value ?? '');
  const out = (t: string): unknown => (list ? t.split(',').map((x) => x.trim()).filter(Boolean) : t);
  return (
    <div className={className}>
      <div className="fh"><label className="fl" htmlFor={`f${field.pointer}`} title={field.help}>{field.label}</label><ResetButton onClick={reset} /></div>
      <input id={`f${field.pointer}`} className="field-in" value={draft ?? shown} placeholder={list ? 'Comma separated' : undefined}
        onChange={(e) => { setDraft(e.target.value); if (!list) send(out(e.target.value), false); }}
        onBlur={(e) => { if (draft !== null && draft !== shown) send(out(e.target.value), true); setDraft(null); }}
        onKeyUp={leaveBox} />
      {field.help && <div className="help">{field.help}</div>}
      <Problems list={problems} />
    </div>
  );
}

/** Anything the mapping does not know how to draw: the JSON itself, checked as you leave the box. */
function JsonField({ className, field, value, send, reset, problems }: { className: string; field: Field; value: unknown; send(v: unknown, final?: boolean): void; reset(): void; problems: readonly string[] }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    try { send(JSON.parse(draft), true); setBad(null); setDraft(null); }
    catch (e) { setBad(e instanceof Error ? e.message : 'not valid JSON'); }
  };
  return (
    <div className={`${className}${bad ? ' bad' : ''}`}>
      <div className="fh"><label className="fl" htmlFor={`f${field.pointer}`} title={field.help}>{field.label}</label>{field.fallback && <span className="jtag" title="The Inspector has no form for this shape yet">JSON</span>}<ResetButton onClick={reset} /></div>
      <textarea id={`f${field.pointer}`} className="field-in" spellCheck={false} placeholder={field.unset ? 'Not set' : undefined} value={draft ?? (value === undefined ? '' : JSON.stringify(value, null, 2))}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit(); else if (e.key === 'Escape') { setDraft(null); setBad(null); } }} />
      {field.help ? <div className="help">{field.help}</div> : field.fallback && field.label !== '' && <div className="help">No form for this shape yet, so this is the raw JSON. It is checked before it is saved.</div>}
      {bad && <div className="err" role="alert"><Icon name="warn" /><span>{bad}</span></div>}
      <Problems list={problems} />
    </div>
  );
}

/** An array of choices (the features a game uses): every option is a button that is on or off, kept in the schema's order. */
function ChecksField({ className, field, value, send, reset, problems }: { className: string; field: Field; value: unknown; send(v: unknown, final?: boolean): void; reset(): void; problems: readonly string[] }): JSX.Element {
  const on: unknown[] = Array.isArray(value) ? value : [];
  const toggle = (opt: unknown): void => {
    const next = field.optionValues.filter((o) => (o === opt ? !on.includes(o) : on.includes(o)));
    // A value the file has that the schema does not list stays: the server's check says what is wrong with it.
    send([...next, ...on.filter((v) => !field.optionValues.includes(v))], true);
  };
  return (
    <div className={className}>
      <div className="fh"><span className="fl" title={field.help}>{field.label}</span><span className="fv"><span style={{ color: 'var(--muted)' }}>{on.length}</span></span><ResetButton onClick={reset} /></div>
      <div className="checks" role="group" aria-label={field.label}>
        {field.optionValues.map((o, i) => {
          const sel = on.includes(o);
          return <button key={field.options[i]} className={sel ? 'on' : ''} aria-pressed={sel} onClick={() => toggle(o)}>{sel && <Icon name="check" size={12} />}{field.options[i]}</button>;
        })}
      </div>
      {field.help && <div className="help">{field.help}</div>}
      <Problems list={problems} />
    </div>
  );
}

/** An array of objects (anim-graph transitions, bones, parts): one collapsible row each, with add, remove and move; every row's values in their own widgets. */
function ListField({ className, field, value, problems, refs, send, reset, onChange }: {
  className: string; field: Field; value: unknown; problems: readonly string[]; refs?: (kind: string) => string[];
  send(v: unknown, final?: boolean): void; reset(): void; onChange: Change;
}): JSX.Element {
  const arr: unknown[] = Array.isArray(value) ? value : [];
  const root = field.schemaRoot ?? {};
  const [closed, setClosed] = useState<Set<number>>(() => new Set(arr.length > 4 ? arr.map((_, i) => i) : []));
  const toggle = (i: number): void => setClosed((c) => { const n = new Set(c); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  // Rows keep their open or closed state when others come and go.
  const remap = (f: (i: number) => number | null): void => setClosed((c) => new Set([...c].map(f).filter((i): i is number => i !== null)));

  const add = (): void => {
    send([...arr, defaultFor(root, field.valueSchema, refs ? refs(refKindOf(field.valueSchema)) : [])], true);
    remap((i) => i);
  };
  const remove = (i: number): void => { send(arr.filter((_, j) => j !== i), true); remap((j) => (j === i ? null : j > i ? j - 1 : j)); };
  const move = (i: number, by: -1 | 1): void => {
    const j = i + by;
    if (j < 0 || j >= arr.length) return;
    const next = [...arr];
    [next[i], next[j]] = [next[j]!, next[i]!];
    send(next, true);
    remap((k) => (k === i ? j : k === j ? i : k));
  };

  return (
    <div className={`${className} map list`}>
      <div className="fh"><span className="fl" title={field.help}>{field.label === field.group ? `${arr.length} ${arr.length === 1 ? 'row' : 'rows'}` : field.label}</span>{field.label !== field.group && <span className="fv"><span style={{ color: 'var(--muted)' }}>{arr.length}</span></span>}<ResetButton onClick={reset} /></div>
      {field.help && <div className="help">{field.help}</div>}
      {arr.length === 0 && <div className="help">Nothing here yet.</div>}
      {arr.map((item, i) => {
        const open = !closed.has(i);
        const row = listItemFields(field, i, item);
        const plain = row.length === 1 && row[0]!.label === '';
        const title = itemTitle(item, i);
        return (
          // Rows have no identity of their own, so the index is the key; the open state follows it (remap).
          <div className="mapent" key={i}>
            <div className="mapk">
              {!plain && <button className={`mapc${open ? ' open' : ''}`} onClick={() => toggle(i)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} row ${i + 1}, ${title}`}><Icon name="chevron" size={12} /></button>}
              <span className="listn">{i + 1}</span>
              {plain
                ? <div className="mapv">{row.map((f) => <FieldView key={f.pointer} field={f} value={f.value} baseline={undefined} problems={[]} refOptions={f.refKind && refs ? refs(f.refKind) : []} refs={refs} onChange={onChange} />)}</div>
                : <span className="listt" title={title}>{title}</span>}
              <button className="rs show lup" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move row ${i + 1} up`} title="Move up"><Icon name="chevron" /></button>
              <button className="rs show ldn" onClick={() => move(i, 1)} disabled={i === arr.length - 1} aria-label={`Move row ${i + 1} down`} title="Move down"><Icon name="chevron" /></button>
              <button className="rs show" onClick={() => remove(i)} aria-label={`Remove row ${i + 1}`} title="Remove"><Icon name="trash" /></button>
            </div>
            {!plain && open && (
              <div className="mapb">
                {row.map((f) => <FieldView key={f.pointer} field={f} value={f.value} baseline={undefined} problems={[]} refOptions={f.refKind && refs ? refs(f.refKind) : []} refs={refs} onChange={onChange} />)}
              </div>
            )}
          </div>
        );
      })}
      <div className="mapadd"><button className="btn" onClick={add}><Icon name="plus" />Add row</button></div>
      <Problems list={problems} />
    </div>
  );
}

/** A map with names the user picks (sockets, materials, clips): add, remove and rename, each value in its own widget. */
function MapField({ className, field, value, problems, refs, send, reset, onChange }: {
  className: string; field: Field; value: unknown; problems: readonly string[]; refs?: (kind: string) => string[];
  send(v: unknown, final?: boolean): void; reset(): void; onChange: Change;
}): JSX.Element {
  const obj: Record<string, unknown> = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const keys = Object.keys(obj);
  const [closed, setClosed] = useState<Set<string>>(() => new Set(keys.length > 5 ? keys : []));
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const root = field.schemaRoot ?? {};
  const toggle = (k: string): void => setClosed((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const add = (): void => {
    const k = draft.trim();
    if (!k) return;
    if (k in obj) { setNote(`"${k}" is already here.`); return; }
    send({ ...obj, [k]: defaultFor(root, field.valueSchema, refs ? refs(refKindOf(field.valueSchema)) : []) }, true);
    setDraft(''); setNote(null);
  };
  const remove = (k: string): void => { const { [k]: _gone, ...rest } = obj; send(rest, true); };
  const rename = (from: string, to: string): boolean => {
    const t = to.trim();
    if (t === from) return true;
    if (!t) { setNote('A name cannot be empty.'); return false; }
    if (t in obj) { setNote(`"${t}" is already here.`); return false; }
    // Rebuild in order so the entry keeps its place in the list.
    send(Object.fromEntries(keys.map((k) => [k === from ? t : k, obj[k]])), true);
    setNote(null);
    return true;
  };

  return (
    <div className={`${className} map`}>
      <div className="fh"><span className="fl" title={field.help}>{field.label === field.group ? `${keys.length} ${keys.length === 1 ? 'entry' : 'entries'}` : field.label}</span>{field.label !== field.group && <span className="fv"><span style={{ color: 'var(--muted)' }}>{keys.length}</span></span>}<ResetButton onClick={reset} /></div>
      {field.help && <div className="help">{field.help}</div>}
      {keys.length === 0 && <div className="help">Nothing here yet.</div>}
      {keys.map((k) => {
        const open = !closed.has(k);
        const entry = mapEntryFields(field, k, obj[k]);
        const plain = entry.length === 1 && entry[0]!.label === '';
        return (
          <div className="mapent" key={k}>
            <div className="mapk">
              {!plain && <button className={`mapc${open ? ' open' : ''}`} onClick={() => toggle(k)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${k}`}><Icon name="chevron" size={12} /></button>}
              <KeyInput name={k} onRename={rename} />
              {plain && <div className="mapv">{entry.map((f) => <FieldView key={f.pointer} field={f} value={f.value} baseline={undefined} problems={[]} refOptions={f.refKind && refs ? refs(f.refKind) : []} refs={refs} onChange={onChange} />)}</div>}
              <button className="rs show" onClick={() => remove(k)} aria-label={`Remove ${k}`} title={`Remove ${k}`}><Icon name="trash" /></button>
            </div>
            {!plain && open && (
              <div className="mapb">
                {entry.map((f) => <FieldView key={f.pointer} field={f} value={f.value} baseline={undefined} problems={[]} refOptions={f.refKind && refs ? refs(f.refKind) : []} refs={refs} onChange={onChange} />)}
              </div>
            )}
          </div>
        );
      })}
      <div className="mapadd">
        <input className="field-in" value={draft} placeholder="New name" aria-label={`New name in ${field.label}`} onChange={(e) => { setDraft(e.target.value); setNote(null); }} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="btn" onClick={add} disabled={!draft.trim()}><Icon name="plus" />Add</button>
      </div>
      {note && <div className="err" role="alert"><Icon name="warn" /><span>{note}</span></div>}
      <Problems list={problems} />
    </div>
  );
}

const refKindOf = (schema: Field['valueSchema']): string => (schema && typeof schema['x-ref'] === 'string' ? schema['x-ref'] : '');

/** The name of a map entry; Enter or leaving the box renames it, Escape puts the old name back. */
function KeyInput({ name, onRename }: { name: string; onRename(from: string, to: string): boolean }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const done = (): void => { if (draft !== null && !onRename(name, draft)) { /* keep the old name; the note says why */ } setDraft(null); };
  return (
    <input className="field-in mapname" value={draft ?? name} aria-label={`Name of ${name}`} spellCheck={false}
      onChange={(e) => setDraft(e.target.value)} onBlur={done}
      onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); }} onKeyUp={leaveBox} />
  );
}
