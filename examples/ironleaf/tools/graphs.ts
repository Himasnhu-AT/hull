// Writes the anim graphs of Ironleaf's characters (config/anim-graph/*.json). Triggers are named after the moves the
// combat kit fires, so a move's clip plays the moment its trigger is set.
import { writeFileSync } from 'node:fs';

type J = Record<string, unknown>;
const root = new URL('../config/anim-graph/', import.meta.url).pathname;
const save = (name: string, g: J): void => writeFileSync(root + name + '.json', JSON.stringify(g, null, 2) + '\n');

export interface RaiderSpec {
  name: string;
  hold: string;
  /** Clips played by a trigger of the same name, with how long they blend out. */
  moves: string[];
  springs?: Record<string, J>;
  extra?: J;
}

export function raiderGraph(s: RaiderSpec): J {
  const params: Record<string, J> = {
    speed: { type: 'number', default: 0, min: 0, max: 12 },
    dead: { type: 'boolean', default: false },
    guarding: { type: 'boolean', default: false },
    broken: { type: 'boolean', default: false },
    hit: { type: 'trigger' }, stagger: { type: 'trigger' }, dodge: { type: 'trigger' }, cancel: { type: 'trigger' }, backstep: { type: 'trigger' },
  };
  for (const m of s.moves) params[m] = { type: 'trigger' };
  const moveStates = (exit: string): Record<string, J> => Object.fromEntries(s.moves.map((m) => [m, { clip: m, exit, exitBlend: 0.12 }]));
  const moveTrans = (): J[] => s.moves.map((m) => ({ from: '*', to: m, when: m, blend: 0.05 }));
  const g: J = {
    kind: 'anim-graph',
    note: s.name + ': a trigger per move (named like the clip), full-body in the base layer and the same clip on the upper body so the arms win over the walk swing.',
    params,
    layers: {
      base: {
        start: 'idle',
        states: {
          idle: { clip: 'idle' },
          move: { blend: { by: 'speed', points: { '1.44': 'walk', '4.82': 'run' } }, speedFrom: 'speed' },
          dead: { clip: 'death' },
          'back-step': { clip: 'back-step', exit: 'idle', exitBlend: 0.12 },
          ...moveStates('idle'),
        },
        transitions: [
          { from: '*', to: 'dead', when: 'dead', blend: 0.12 },
          { from: '*', to: 'back-step', when: 'backstep', blend: 0.06 },
          ...moveTrans(),
          ...s.moves.map((m) => ({ from: m, to: 'idle', when: 'cancel', blend: 0.1 })),
          { from: 'idle', to: 'move', when: 'speed > 0.3', blend: 0.15 },
          { from: 'move', to: 'idle', when: 'speed < 0.2', blend: 0.2 },
        ],
      },
      upper: {
        mask: ['spine', 'armL', 'armR', 'head'],
        start: 'hold',
        states: {
          hold: { clip: s.hold },
          hit: { clip: 'hit', exit: 'hold', exitBlend: 0.1 },
          stagger: { clip: 'stagger', exit: 'hold', exitBlend: 0.2 },
          'back-step': { clip: 'back-step', exit: 'hold', exitBlend: 0.12 },
          ...moveStates('hold'),
        },
        transitions: [
          { from: '*', to: 'stagger', when: 'stagger', blend: 0.05 },
          { from: '*', to: 'hit', when: 'hit', blend: 0.04 },
          { from: '*', to: 'back-step', when: 'backstep', blend: 0.06 },
          ...moveTrans(),
          ...s.moves.map((m) => ({ from: m, to: 'hold', when: 'cancel', blend: 0.1 })),
        ],
      },
      breath: { additive: true, weight: 0.8, start: 'on', states: { on: { clip: 'breathe' } } },
    },
    ik: { feet: { enabled: true, maxStep: 0.35 } },
    ...(s.springs ? { springs: s.springs } : {}),
    ...(s.extra ?? {}),
  };
  return g;
}

const chain = (names: string[], stiffness: number, damping: number, drive: number): J => ({ chain: names, stiffness, damping, drive });
const AYA_SPRINGS: Record<string, J> = {
  ponytail: chain(['pony1', 'pony2', 'pony3'], 90, 6, 0.06),
  sashL: chain(['sashL1', 'sashL2', 'sashL3'], 70, 5, 0.05),
  sashR: chain(['sashR1', 'sashR2', 'sashR3'], 70, 5, 0.05),
  scarf: chain(['scarf1', 'scarf2', 'scarf3'], 55, 4, 0.07),
};

export const RAIDERS: RaiderSpec[] = [
  { name: 'Ashblade', hold: 'hold-sword', moves: ['sword-cut', 'sword-cross', 'sword-feint'], springs: { ragL: chain(['ragL1', 'ragL2'], 60, 5, 0.05), ragR: chain(['ragR1', 'ragR2'], 60, 5, 0.05) } },
  { name: 'Ashpike', hold: 'hold-spear', moves: ['spear-thrust', 'spear-sweep'], springs: { ragL: chain(['ragL1', 'ragL2'], 60, 5, 0.05), flag: chain(['flag1', 'flag2'], 45, 4, 0.06) } },
  { name: 'Cinder Hulk', hold: 'hold-hulk', moves: ['hulk-smash', 'hulk-grab'], springs: { rag: chain(['rag1', 'rag2'], 50, 5, 0.04) } },
  { name: 'Ashkite', hold: 'hold-bow', moves: ['bow-shoot'], springs: { cape: chain(['cape1', 'cape2', 'cape3'], 50, 4, 0.06), ragL: chain(['ragL1', 'ragL2'], 60, 5, 0.05) } },
  { name: 'Kagari', hold: 'hold-duel', moves: ['duel-cut', 'duel-thrust', 'duel-sweep', 'duel-rush', 'duel-phase'], springs: { ponytail: chain(['pony1', 'pony2', 'pony3'], 90, 6, 0.06), coatL: chain(['coatL1', 'coatL2', 'coatL3'], 45, 4, 0.06), coatR: chain(['coatR1', 'coatR2', 'coatR3'], 45, 4, 0.06) } },
];
const FILES: Record<string, string> = { Ashblade: 'ashblade', Ashpike: 'ashpike', 'Cinder Hulk': 'hulk', Ashkite: 'ashkite', Kagari: 'kagari' };

const STANCE_MOVES = ['stone-1', 'stone-2', 'stone-3', 'stone-heavy', 'stone-charge', 'water-1', 'water-2', 'water-3', 'water-4', 'water-heavy', 'water-charge', 'wind-1', 'wind-2', 'wind-heavy', 'wind-charge'];
const MOVES = [...STANCE_MOVES, 'finisher-stone', 'finisher-water', 'finisher-wind', 'riposte', 'draw', 'sheathe', 'quickdraw'];
/** Aya: the stance (a number) picks the idle, hold and guard clips by a blend; every move is a trigger named like its clip. */
export function ayaGraph(): J {
  const byStance = (pre: string): J => ({ blend: { by: 'stance', points: { '0': pre + '-stone', '1': pre + '-water', '2': pre + '-wind' } } });
  const params: Record<string, J> = {
    speed: { type: 'number', default: 0, min: 0, max: 12 },
    stance: { type: 'number', default: 0, min: 0, max: 2 },
    dodgeDir: { type: 'number', default: 0, min: 0, max: 3 },
    grounded: { type: 'boolean', default: true },
    dead: { type: 'boolean', default: false },
    guarding: { type: 'boolean', default: false },
    broken: { type: 'boolean', default: false },
    standoff: { type: 'boolean', default: false },
    hitHeavy: { type: 'boolean', default: false },
    hit: { type: 'trigger' }, stagger: { type: 'trigger' }, deflect: { type: 'trigger' }, dodge: { type: 'trigger' }, cancel: { type: 'trigger' },
  };
  for (const m of MOVES) params[m] = { type: 'trigger' };
  // One-shot actions: state name, clip, how long they blend out. They exist in both layers so the arms follow the clip.
  const ACTIONS: [string, string][] = [
    ...MOVES.filter((m) => m !== 'draw' && m !== 'sheathe').map((m): [string, string] => [m, m]),
    ['deflect', 'deflect'], ['dodge-roll', 'roll'], ['dodge-l', 'dodge-l'], ['dodge-r', 'dodge-r'], ['dodge-back', 'dodge-back'],
    ['hit-light', 'hit-light'], ['hit-heavy', 'hit-heavy'], ['guard-broken', 'guard-broken'],
  ];
  const mkStates = (exit: string): Record<string, J> => {
    const s: Record<string, J> = {};
    for (const [n, c] of ACTIONS) s[n] = { clip: c, exit, exitBlend: n.startsWith('hit') ? 0.15 : n.startsWith('dodge') ? 0.1 : 0.12 };
    s['draw'] = { clip: 'draw', exit, exitBlend: 0.12 };
    s['sheathe'] = { clip: 'sheathe', exit: 'sheathed', exitBlend: 0.1 };
    s['sheathed'] = { clip: 'sheathed' };
    s['standoff'] = { clip: 'standoff' };
    s['posture-broken'] = { clip: 'stagger', exit: 'broken-hold', exitBlend: 0.15 };
    s['broken-hold'] = { clip: 'broken' };
    s['dead'] = { clip: 'death' };
    return s;
  };
  const trans = (idle: string): J[] => [
    { from: '*', to: 'dead', when: 'dead', blend: 0.1 },
    { from: '*', to: 'posture-broken', when: 'broken', blend: 0.08 },
    { from: 'posture-broken', to: idle, when: '!broken', blend: 0.15 },
    { from: 'broken-hold', to: idle, when: '!broken', blend: 0.2 },
    { from: '*', to: 'guard-broken', when: 'stagger && hitHeavy && guarding', blend: 0.04 },
    { from: '*', to: 'hit-heavy', when: 'stagger && hitHeavy', blend: 0.04 },
    { from: '*', to: 'hit-light', when: 'stagger', blend: 0.04 },
    { from: '*', to: 'hit-light', when: 'hit', blend: 0.04 },
    { from: '*', to: 'deflect', when: 'deflect', blend: 0.03 },
    { from: '*', to: 'dodge-roll', when: 'dodge && dodgeDir < 0.5', blend: 0.04 },
    { from: '*', to: 'dodge-l', when: 'dodge && dodgeDir < 1.5', blend: 0.04 },
    { from: '*', to: 'dodge-r', when: 'dodge && dodgeDir < 2.5', blend: 0.04 },
    { from: '*', to: 'dodge-back', when: 'dodge', blend: 0.04 },
    { from: 'standoff', to: 'quickdraw', when: 'quickdraw', blend: 0.04 },
    { from: 'sheathed', to: 'draw', when: 'draw', blend: 0.06 },
    ...MOVES.filter((m) => m !== 'sheathe').map((m): J => ({ from: '*', to: m, when: m, blend: m.includes('charge') ? 0.1 : 0.05 })),
    { from: '*', to: 'sheathe', when: 'sheathe', blend: 0.08 },
    ...ACTIONS.map(([n]): J => ({ from: n, to: idle, when: 'cancel', blend: 0.08 })),
    { from: 'standoff', to: idle, when: '!standoff', blend: 0.15 },
    { from: '*', to: 'standoff', when: 'standoff && !dead', blend: 0.2 },
  ];
  return {
    kind: 'anim-graph',
    note: 'Aya. stance (0 stone, 1 water, 2 wind) blends the idle, hold and guard clips; every move is a trigger named like its clip; dodgeDir picks the dodge; the base layer plays the whole body, the upper layer repeats each action on the arms so they follow it, and holds or guards while she walks.',
    params,
    layers: {
      base: {
        start: 'idle',
        states: {
          idle: byStance('idle'),
          move: { blend: { by: 'speed', points: { '1.44': 'walk', '4.82': 'run' } }, speedFrom: 'speed' },
          ...mkStates('idle'),
        },
        transitions: [
          ...trans('idle'),
          { from: 'idle', to: 'move', when: 'speed > 0.3', blend: 0.15 },
          { from: 'move', to: 'idle', when: 'speed < 0.2', blend: 0.2 },
        ],
      },
      upper: {
        mask: ['spine', 'armL', 'armR', 'head'],
        start: 'hold',
        states: {
          hold: byStance('hold'),
          guard: byStance('guard'),
          ...mkStates('hold'),
        },
        transitions: [
          ...trans('hold').filter((t) => t.to !== 'standoff' && t.from !== 'standoff'),
          { from: 'standoff', to: 'hold', when: '!standoff', blend: 0.15 },
          { from: '*', to: 'standoff', when: 'standoff && !dead', blend: 0.2 },
          { from: 'hold', to: 'guard', when: 'guarding', blend: 0.06 },
          { from: 'guard', to: 'hold', when: '!guarding', blend: 0.1 },
        ],
      },
      breath: { additive: true, weight: 0.8, start: 'on', states: { on: { clip: 'breathe' } } },
    },
    ik: { feet: { enabled: true, maxStep: 0.35 } },
    springs: AYA_SPRINGS,
    hitReact: { angle: 0.4 },
  };
}
export function writeAyaGraph(): void {
  save('aya', ayaGraph());
}
export function writeRaiderGraphs(): void {
  for (const r of RAIDERS) save(FILES[r.name]!, raiderGraph(r));
}
export { save };
