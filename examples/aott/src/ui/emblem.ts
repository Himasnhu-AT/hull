// The AOTT emblem as inline SVG, for the DOM UI (the title screen and the HUD). The canvas version for cloaks and
// flags is drawEmblem() in src/player/model.ts; both draw the same mark: a pointed heater shield, inside it one
// vertical sword point up crossing a wall line with three crenellations, and a thin ring (the tether) looping from
// the guard round the blade. Two-tone: bone on graphite (HUD) or bone on deep green (cloth).

export interface EmblemOptions {
  /** Shield field colour. Graphite for the HUD, deep green `#24382c` for cloth. */
  field?: string;
  /** Line colour. */
  bone?: string;
  /** Class name for the <svg>. */
  cls?: string;
}

export const EMBLEM_GRAPHITE = '#15181b';
export const EMBLEM_GREEN = '#24382c';
export const EMBLEM_BONE = '#e6e1d6';

/** SVG markup for the emblem; viewBox 100 x 120 (scale it with CSS width/height). */
export function emblemSVG(opts: EmblemOptions = {}): string {
  const f = opts.field ?? EMBLEM_GRAPHITE;
  const b = opts.bone ?? EMBLEM_BONE;
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  const blade = `<path d="M50 12 L55.5 22 V78 H44.5 V22 Z" fill="${b}"/>`;
  return `<svg${cls} viewBox="0 0 100 120" aria-hidden="true" focusable="false">`
    // shield and its inner hairline
    + `<path d="M8 6 H92 V50 C92 80 74 100 50 115 C26 100 8 80 8 50 Z" fill="${f}" stroke="${b}" stroke-width="4" stroke-linejoin="round"/>`
    + `<path d="M15.5 13 H84.5 V50 C84.5 75 69 92.5 50 105.5 C31 92.5 15.5 75 15.5 50 Z" fill="none" stroke="${b}" stroke-opacity=".32" stroke-width="1.2"/>`
    // the wall: one line, three crenellations
    + `<path d="M17 71 H25 V62 H33 V71 H46 V62 H54 V71 H67 V62 H75 V71 H83" fill="none" stroke="${b}" stroke-width="3.2" stroke-linecap="square"/>`
    // the sword, cut out of the wall by a field-coloured outline
    + `<g stroke="${f}" stroke-width="3" paint-order="stroke">${blade}`
    + `<rect x="34" y="78" width="32" height="5" rx="1.2" fill="${b}"/>`
    + `<rect x="47" y="83" width="6" height="13" fill="${b}"/><circle cx="50" cy="99.5" r="3.8" fill="${b}"/></g>`
    + `<path d="M50 25 V74" stroke="${f}" stroke-width="1.1"/>`
    // the tether: a ring round the blade (in front below, behind above) and its line down to the guard
    + `<ellipse cx="50" cy="44" rx="19" ry="7.5" transform="rotate(-14 50 44)" fill="none" stroke="${b}" stroke-width="2.2"/>`
    + `<path d="M67.6 41 C73 55 70 70 63 78" fill="none" stroke="${b}" stroke-width="1.6" stroke-linecap="round"/>`
    + `<path d="M43 31 H44.5 V41 H43 Z M55.5 31 H57 V41 H55.5 Z" fill="${f}"/>`
    + `<rect x="44.5" y="31" width="11" height="10" fill="${b}"/>`
    + `<path d="M50 31 V41" stroke="${f}" stroke-width="1.1"/>`
    + `</svg>`;
}
