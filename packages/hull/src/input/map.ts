// An `input-map` config value turned into what the sampler reads: per action, source names by slot. Pure: no DOM.
import type { InputMap } from '../schema/input-map.ts';
import { PAD_AXES, expandSource } from './keys.ts';

export type ActionType = 'button' | 'axis' | 'axis2';
export type MouseUse = 'delta' | 'deltaX' | 'deltaY' | 'wheel';

/** Slot names per action type. A button has one list; an axis has two directions; an axis2 has four. */
export const SLOT_NAMES: Readonly<Record<ActionType, readonly string[]>> = {
  button: ['main'],
  axis: ['neg', 'pos'],
  axis2: ['up', 'down', 'left', 'right'],
};

export interface ActionDef {
  readonly name: string;
  readonly type: ActionType;
  /** slot name to source names (already expanded: 'W' is 'KeyW'). Includes gamepad buttons as 'pad:south'. */
  slots: Record<string, string[]>;
  readonly mouse: MouseUse | null;
  /** Indices into the pad's axes: one for an axis, two (x, y) for a stick. */
  readonly padAxes: readonly number[];
  readonly deadzone: number;
  readonly sensitivity: number;
  readonly invertY: boolean;
  readonly rebind: boolean;
}

export interface CompiledMap {
  actions: ActionDef[];
  groups: Record<string, string[]>;
  /** Each names its place: 'input-map/play#/actions/jump/keys/0: ...'. The map still works; bad sources are skipped. */
  problems: string[];
}

/** The player's changes: action -> slot -> the sources that replace the map's. Plain JSON, so a game can save it. */
export type Overrides = Record<string, Record<string, string[]>>;

function addSources(out: string[], names: readonly unknown[], where: string, problems: string[]): void {
  names.forEach((n, i) => {
    const ex = typeof n === 'string' ? expandSource(n) : null;
    if (!ex) { problems.push(`${where}/${i}: "${String(n)}" is not a key, mouse button or gamepad button name`); return; }
    for (const s of ex) if (!out.includes(s)) out.push(s);
  });
}

function padAxisIndices(name: string, type: ActionType, where: string, problems: string[]): number[] {
  if (type === 'axis') {
    const i = (PAD_AXES as readonly string[]).indexOf(name);
    if (i < 0) problems.push(`${where}: "${name}" is not a gamepad axis (${PAD_AXES.join(', ')})`);
    return i < 0 ? [] : [i];
  }
  if (name === 'stickL') return [0, 1];
  if (name === 'stickR') return [2, 3];
  problems.push(`${where}: "${name}" is not a stick (stickL, stickR)`);
  return [];
}

/** `id` is only for messages, e.g. 'input-map/play'. */
export function compileMap(map: InputMap | undefined, id = 'input-map', overrides: Overrides = {}): CompiledMap {
  const out: CompiledMap = { actions: [], groups: {}, problems: [] };
  if (!map) return out;
  const problems = out.problems;
  for (const [name, a] of Object.entries(map.actions)) {
    const at = `${id}#/actions/${name}`;
    const type = a.type;
    const slots: Record<string, string[]> = {};
    for (const s of SLOT_NAMES[type]) slots[s] = [];
    const keys = a.keys;
    if (Array.isArray(keys)) {
      if (type !== 'button') problems.push(`${at}/keys: a ${type} needs { ${SLOT_NAMES[type].join(', ')} }, not a list`);
      else addSources(slots['main']!, keys, `${at}/keys`, problems);
    } else if (keys) {
      if (type === 'button') problems.push(`${at}/keys: a button takes a list of keys`);
      for (const [slot, list] of Object.entries(keys)) {
        if (!slots[slot]) problems.push(`${at}/keys/${slot}: a ${type} has the slots ${SLOT_NAMES[type].join(', ')}`);
        else addSources(slots[slot]!, list, `${at}/keys/${slot}`, problems);
      }
    }
    let padAxes: number[] = [];
    if (a.pad !== undefined) {
      const list = Array.isArray(a.pad) ? a.pad : [a.pad];
      if (type === 'button') {
        addSources(slots['main']!, list.map((p) => `pad:${p}`), `${at}/pad`, problems);
      } else {
        padAxes = padAxisIndices(list[0] ?? '', type, `${at}/pad`, problems);
      }
    }
    if (a.mouse && type === 'button') problems.push(`${at}/mouse: a button reads mouse buttons from keys ('Mouse0'), not mouse`);
    if (a.mouse === 'delta' && type === 'axis') problems.push(`${at}/mouse: an axis reads 'deltaX', 'deltaY' or 'wheel'; 'delta' is for axis2`);
    if ((a.mouse === 'deltaX' || a.mouse === 'deltaY' || a.mouse === 'wheel') && type === 'axis2') {
      problems.push(`${at}/mouse: an axis2 reads 'delta'`);
    }
    const rebind = a.rebind !== false;
    const ov = overrides[name];
    if (ov && rebind) {
      for (const [slot, list] of Object.entries(ov)) {
        if (!slots[slot]) continue;
        const next: string[] = [];
        addSources(next, list, `override ${name}/${slot}`, problems);
        slots[slot] = next;
      }
    }
    out.actions.push({
      name,
      type,
      slots,
      mouse: type === 'button' ? null : (a.mouse ?? null),
      padAxes,
      deadzone: a.deadzone ?? 0.15,
      sensitivity: a.sensitivity ?? 1,
      invertY: a.invertY === true,
      rebind,
    });
  }
  for (const [g, list] of Object.entries(map.groups ?? {})) {
    out.groups[g] = [...list];
    for (const n of list) if (!map.actions[n]) problems.push(`${id}#/groups/${g}: "${n}" is not an action`);
  }
  return out;
}
