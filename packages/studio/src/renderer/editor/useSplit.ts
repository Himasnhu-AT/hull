// Panel sizes you can drag, remembered between sessions. Storage can be missing or blocked: then sizes just reset.

import { useCallback, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { clamp } from '../lib/math.ts';

export interface Sizes { lib: number; insp: number; dock: number }
const DEFAULTS: Sizes = { lib: 248, insp: 332, dock: 232 };
const KEY = 'hull.panelSizes';

function load(): Sizes {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Sizes> | null;
    if (s && typeof s === 'object') return { lib: Number(s.lib) || DEFAULTS.lib, insp: Number(s.insp) || DEFAULTS.insp, dock: Number(s.dock) || DEFAULTS.dock };
  } catch { /* use the defaults */ }
  return DEFAULTS;
}

export function useSplit(): {
  sizes: Sizes;
  active: keyof Sizes | null;
  bind(key: keyof Sizes, dir: 1 | -1, min: number, max: number, axis?: 'x' | 'y'): { onPointerDown(e: RPointerEvent<HTMLElement>): void; onPointerMove(e: RPointerEvent<HTMLElement>): void; onPointerUp(e: RPointerEvent<HTMLElement>): void; onDoubleClick(): void };
} {
  const [sizes, setSizes] = useState<Sizes>(load);
  const [active, setActive] = useState<keyof Sizes | null>(null);
  const drag = useRef<{ key: keyof Sizes; start: number; at: number } | null>(null);
  const latest = useRef(sizes);
  latest.current = sizes;

  const bind = useCallback((key: keyof Sizes, dir: 1 | -1, min: number, max: number, axis: 'x' | 'y' = 'x') => ({
    onPointerDown: (e: RPointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { key, start: latest.current[key], at: axis === 'x' ? e.clientX : e.clientY };
      setActive(key);
    },
    onPointerMove: (e: RPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const delta = ((axis === 'x' ? e.clientX : e.clientY) - d.at) * dir;
      setSizes((s) => ({ ...s, [key]: Math.round(clamp(d.start + delta, min, max)) }));
    },
    onPointerUp: () => {
      drag.current = null;
      setActive(null);
      try { localStorage.setItem(KEY, JSON.stringify(latest.current)); } catch { /* not saved */ }
    },
    onDoubleClick: () => setSizes((s) => ({ ...s, [key]: DEFAULTS[key] })),
  }), []);

  return { sizes, active, bind };
}
