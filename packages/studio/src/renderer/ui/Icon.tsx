// The icon set of the approved canvas (24 px grid, 1.75 stroke, round caps), one family throughout.
// The design skill prefers an icon package; adding one is a dependency change the brief does not allow,
// so these are the canvas's own paths. Swap them for a package in one place when a dependency is allowed.

import type { CSSProperties, JSX } from 'react';

const P = {
  play: <polygon points="6 4 20 12 6 20 6 4" />,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>,
  step: <><line x1="6" y1="4" x2="6" y2="20" /><polygon points="10 4 20 12 10 20 10 4" /></>,
  restart: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><polyline points="3 3 3 8 8 8" /></>,
  build: <><path d="M15 12l-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9" /><path d="M17.6 6.4L20 9l-4 4-6-6 4-4z" /></>,
  lib: <><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="9" y1="4" x2="9" y2="20" /></>,
  dock: <><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="14" x2="21" y2="14" /></>,
  insp: <><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="15" y1="4" x2="15" y2="20" /></>,
  chat: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>,
  chevron: <polyline points="9 6 15 12 9 18" />,
  gameplay: <><rect x="2" y="7" width="20" height="10" rx="4" /><line x1="7" y1="10" x2="7" y2="14" /><line x1="5" y1="12" x2="9" y2="12" /></>,
  characters: <><circle cx="12" cy="5" r="2.5" /><path d="M12 8v7M8 11h8M12 15l-3 6M12 15l3 6" /></>,
  audio: <path d="M2 12h3l3-7 4 14 3-9 2 4h5" />,
  world: <><path d="M3 20l6-10 4 6 3-4 5 8z" /><circle cx="17" cy="6" r="2" /></>,
  interface: <><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="9" x2="9" y2="20" /></>,
  input: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
  other: <><circle cx="12" cy="12" r="9" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></>,
  warn: <><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12.5" /><line x1="12" y1="16" x2="12.01" y2="16" /></>,
  reset: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><polyline points="3 3 3 8 8 8" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  file: <><path d="M6 3h8l5 5v13H6z" /><polyline points="14 3 14 8 19 8" /></>,
  plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  close: <><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></>,
  check: <polyline points="20 6 9 17 4 12" />,
  game: <><rect x="2" y="7" width="20" height="10" rx="4" /><line x1="7" y1="10" x2="7" y2="14" /><line x1="5" y1="12" x2="9" y2="12" /></>,
  console: <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>,
  history: <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></>,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  back: <><line x1="19" y1="12" x2="5" y2="12" /><polyline points="11 6 5 12 11 18" /></>,
  reload: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><polyline points="21 3 21 8 16 8" /></>,
  branch: <><circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="8" r="2.2" /><path d="M6 7.2v9.6M18 10.2c0 4-6 3-12 6.6" /></>,
  compare: <><rect x="3" y="5" width="8" height="14" rx="1.5" /><rect x="13" y="5" width="8" height="14" rx="1.5" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>,
  sliders: <><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="17" x2="20" y2="17" /><circle cx="9" cy="7" r="2.2" /><circle cx="15" cy="17" r="2.2" /></>,
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof P;

export function Icon({ name, size, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }): JSX.Element {
  return (
    <svg className={`i${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" aria-hidden="true" style={size ? { width: size, height: size, ...style } : style}>
      {P[name]}
    </svg>
  );
}
