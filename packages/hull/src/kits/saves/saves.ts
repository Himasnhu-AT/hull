import { Behaviour, signal, type Node } from '../../core/index.ts';
import { teleported } from '../../render/index.ts';
import { GROUP } from '../common.ts';
import { kitIO } from '../io.ts';

/** What one slot holds. `b[i]` is the declared state of the node's i-th behaviour that has any. */
export interface SaveData {
  v: 1;
  nodes: { n: string; p: [number, number, number]; r: [number, number, number]; b: Record<string, unknown>[] }[];
}

interface Loadable { afterLoad?(): void }
const stateOf = (b: object): readonly string[] | undefined => (b.constructor as { state?: readonly string[] }).state;
// Behaviours are listed through the node's engine-side list: the kits are part of the engine, and this is the one
// place that needs every behaviour of a node, not one type.
const behavioursOf = (n: Node): object[] => n._behaviours;

/**
 * Save slots for the nodes in the `save` group: where each is, and the declared `state` of each of its behaviours
 * (the same fields the checksum covers). Nodes are matched by name, so a saved game loads into a fresh start of the
 * same game. A behaviour with `afterLoad()` is told once the state is back (a pickup shows or hides itself, the
 * spawner clears the old wave). Random streams and the clock are not part of a save.
 * Storage is the platform's saves: files in the desktop shell, IndexedDB or localStorage in a browser.
 */
export class SaveSlots extends Behaviour {
  slots = 3;
  readonly saved = signal<[slot: number]>();
  readonly loaded = signal<[slot: number]>();

  private name(slot: number): string {
    if (!Number.isInteger(slot) || slot < 1 || slot > this.slots) throw new Error(`save slots: slot ${slot} is not between 1 and ${this.slots}`);
    return `slot${slot}`;
  }

  snapshot(): SaveData {
    const nodes: SaveData['nodes'] = [];
    for (const n of this.world.group(GROUP.save)) {
      const b: Record<string, unknown>[] = [];
      for (const beh of behavioursOf(n)) {
        const fields = stateOf(beh);
        if (!fields) continue;
        const o: Record<string, unknown> = {};
        for (const f of fields) o[f] = structuredClone((beh as Record<string, unknown>)[f]);
        b.push(o);
      }
      nodes.push({ n: n.name, p: [n.position.x, n.position.y, n.position.z], r: [n.rotation.x, n.rotation.y, n.rotation.z], b });
    }
    return { v: 1, nodes };
  }

  save(slot: number): boolean {
    const ok = kitIO.saves().write(this.name(slot), this.snapshot());
    if (ok) this.saved.emit(slot);
    return ok;
  }

  /** False when the slot is empty or unreadable (the saves layer reports why). */
  load(slot: number): boolean {
    const data = kitIO.saves().read<SaveData>(this.name(slot));
    if (!data || data.v !== 1) return false;
    const byName = new Map<string, Node>();
    for (const n of this.world.group(GROUP.save)) byName.set(n.name, n);
    for (const e of data.nodes) {
      const n = byName.get(e.n);
      if (!n) continue;
      n.position.set(e.p[0], e.p[1], e.p[2]);
      n.rotation.set(e.r[0], e.r[1], e.r[2]);
      let i = 0;
      for (const beh of behavioursOf(n)) {
        const fields = stateOf(beh);
        if (!fields) continue;
        const saved = e.b[i++];
        if (!saved) continue;
        for (const f of fields) {
          if (!(f in saved)) continue;
          const rec = beh as Record<string, unknown>;
          const cur = rec[f];
          const val = structuredClone(saved[f]);
          // Objects are filled in place, so anything holding a reference (a Stock's `values`) keeps working.
          if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) && val !== null && typeof val === 'object') {
            for (const k of Object.keys(cur)) delete (cur as Record<string, unknown>)[k];
            Object.assign(cur, val);
          } else rec[f] = val;
        }
      }
      for (const beh of behavioursOf(n)) (beh as Loadable).afterLoad?.();
      teleported(n);
    }
    this.loaded.emit(slot);
    return true;
  }

  /** When the slot was written (ms since 1970) or 0 if it is empty. */
  savedAt(slot: number): number {
    const name = this.name(slot);
    return kitIO.saves().list().find((s) => s.slot === name)?.savedAt ?? 0;
  }
}
