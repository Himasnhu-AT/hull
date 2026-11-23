// Arranging a test through the control port: put a node somewhere, change one plain field, and (in inspect.ts) wait until a node
// is near a spot. Dev only. These change the world from outside the game's own rules, so a run that uses them is not a replay of
// real input: say so wherever they are described. Pure over a World, so a test drives it in Node.
import type { Behaviour, World } from '../core/index.ts';
import { teleported } from '../render/index.ts';
import { behaviourName } from './inspect.ts';
import type { ControlSet, ControlTeleport } from './protocol.ts';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Moves `node` to `to` (its own position, so a world position for a top-level node), tells the renderer it jumped (as the kits'
 * respawns do, so no blend is drawn across the jump), and clears the velocity of a kit body: a behaviour with a `walk` state
 * ({ vx, vy, vz }, as FirstPerson and ThirdPerson have) would otherwise carry its old speed out of the new place. `yaw` (radians)
 * turns the node and the behaviours that keep their own facing (`yaw` on FirstPerson, `facing` on ThirdPerson); without it the facing stays.
 */
export function teleportNode(world: World, node: string, to: unknown, yaw: unknown): ControlTeleport {
  const n = typeof node === 'string' && node !== '' ? world.find(node) : null;
  if (!n) throw new Error(`teleport: there is no node "${String(node)}" (a world.find path like "player")`);
  if (!Array.isArray(to) || to.length !== 3 || !to.every(num)) throw new Error('teleport needs "to": [x, y, z], three numbers');
  if (yaw !== undefined && !num(yaw)) throw new Error('teleport "yaw" is a number of radians');
  n.position.set(to[0] as number, to[1] as number, to[2] as number);
  if (yaw !== undefined) n.rotation.y = yaw;
  for (const b of n.behaviours) {
    const bag = b as unknown as Record<string, unknown>;
    const w = bag['walk'];
    if (typeof w === 'object' && w !== null && num((w as Record<string, unknown>)['vx'])) { const s = w as Record<string, number>; s['vx'] = 0; s['vy'] = 0; s['vz'] = 0; }
    if (yaw !== undefined) for (const f of ['yaw', 'facing']) if (num(bag[f])) bag[f] = yaw;
  }
  teleported(n);
  return { node, position: [n.position.x, n.position.y, n.position.z], yaw: yaw ?? null };
}

/**
 * Sets one field of one behaviour: `field` is "<BehaviourName>.<field>". Only a number, string or boolean field that the
 * behaviour has itself, and only to a value of the same type: an object, a method or a getter is never touched. Answers the old and new value.
 */
export function setField(world: World, node: string, field: string, value: unknown): ControlSet {
  const n = typeof node === 'string' && node !== '' ? world.find(node) : null;
  if (!n) throw new Error(`set: there is no node "${String(node)}" (a world.find path like "player")`);
  const dot = typeof field === 'string' ? field.indexOf('.') : -1;
  if (dot < 1 || dot === field.length - 1) throw new Error(`set needs "field" as <BehaviourName>.<field>, like "Health.hp" (got ${JSON.stringify(field)}); inspect lists them`);
  const bname = field.slice(0, dot), key = field.slice(dot + 1);
  const b: Behaviour | undefined = n.behaviours.find((x) => behaviourName(x) === bname);
  if (!b) throw new Error(`set: "${node}" has no behaviour "${bname}" (it has: ${n.behaviours.map(behaviourName).join(', ') || 'none'})`);
  const bag = b as unknown as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(bag, key)) throw new Error(`set: ${bname} has no field "${key}" (inspect lists the fields)`);
  const old = bag[key];
  if (typeof old !== 'number' && typeof old !== 'string' && typeof old !== 'boolean') throw new Error(`set: ${bname}.${key} is not a number, string or boolean field, and set changes only those`);
  if (typeof value !== typeof old || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`set: ${bname}.${key} is a ${typeof old}; "value" must be a ${typeof old}, got ${JSON.stringify(value)}`);
  bag[key] = value;
  return { node, field, old, new: value as number | string | boolean };
}
