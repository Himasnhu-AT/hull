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

export const RAIDERS: RaiderSpec[] = [
  { name: 'Ashblade', hold: 'hold-sword', moves: ['sword-cut', 'sword-cross', 'sword-feint'] },
  { name: 'Ashpike', hold: 'hold-spear', moves: ['spear-thrust', 'spear-sweep'] },
  { name: 'Cinder Hulk', hold: 'hold-hulk', moves: ['hulk-smash', 'hulk-grab'] },
  { name: 'Ashkite', hold: 'hold-bow', moves: ['bow-shoot'] },
  { name: 'Kagari', hold: 'hold-duel', moves: ['duel-cut', 'duel-thrust', 'duel-sweep', 'duel-rush', 'duel-phase'] },
];
const FILES: Record<string, string> = { Ashblade: 'ashblade', Ashpike: 'ashpike', 'Cinder Hulk': 'hulk', Ashkite: 'ashkite', Kagari: 'kagari' };
export function writeRaiderGraphs(): void {
  for (const r of RAIDERS) save(FILES[r.name]!, raiderGraph(r));
}
export { save };
