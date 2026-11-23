import type { Level, Prefab } from '../../schema/index.ts';

/**
 * What a schema cannot say about a prefab: a collider that is flat, parts that are flat. Each sentence names its place
 * (`prefab/crate#/collider/size`). Missing materials are the references check's job, not this one's.
 */
export function checkPrefab(def: Prefab, at = 'prefab'): string[] {
  const out: string[] = [];
  const flat = (v: readonly number[]): boolean => v.some((n) => !(n > 0));
  def.parts.forEach((p, i) => { if (flat(p.size)) out.push(`${at}#/parts/${i}/size: every side must be more than 0, got [${p.size.join(', ')}]`); });
  if (def.collider && flat(def.collider.size.slice(0, def.collider.shape === 'box' ? 3 : def.collider.shape === 'capsule' ? 2 : 1))) {
    out.push(`${at}#/collider/size: the collider has no volume, got [${def.collider.size.join(', ')}]`);
  }
  return out;
}

/**
 * What a schema cannot say about a level: a block with no volume, a thing or marker outside the ground, a scatter area off
 * the ground or two scatter rules drawing from one stream (so adding one would move the other's things). `prefabs`, when
 * given, is how a prefab id is read ('prefab/crate'), so a scatter rule that cannot fit its prefab is found too.
 */
export function checkLevel(def: Level, at = 'level'): string[] {
  const out: string[] = [];
  const [gw, gd] = def.ground.size;
  if (!(gw > 0 && gd > 0)) out.push(`${at}#/ground/size: the ground needs a width and a depth above 0`);
  const inside = (x: number, z: number): boolean => Math.abs(x) <= gw / 2 && Math.abs(z) <= gd / 2;
  (def.blocks ?? []).forEach((b, i) => {
    if (b.size.some((n) => !(n > 0))) out.push(`${at}#/blocks/${i}/size: every side must be more than 0, got [${b.size.join(', ')}]`);
    if (!inside(b.at[0], b.at[2])) out.push(`${at}#/blocks/${i}/at: the block's centre is off the ground (the ground is ${gw} by ${gd}, centred on 0)`);
  });
  (def.things ?? []).forEach((t, i) => { if (!inside(t.at[0], t.at[2])) out.push(`${at}#/things/${i}/at: the thing stands off the ground (the ground is ${gw} by ${gd}, centred on 0)`); });
  for (const [name, m] of Object.entries(def.markers ?? {})) {
    if (!inside(m.at[0], m.at[2])) out.push(`${at}#/markers/${name.replace(/~/g, '~0').replace(/\//g, '~1')}/at: the marker is off the ground (the ground is ${gw} by ${gd}, centred on 0)`);
  }
  const streams = new Map<string, number>();
  (def.scatter ?? []).forEach((s, i) => {
    const [ax, az] = s.area.at;
    const [aw, ad] = s.area.size;
    if (!(aw > 0 && ad > 0)) out.push(`${at}#/scatter/${i}/area/size: the area needs a width and a depth above 0`);
    else if (ax + aw / 2 < -gw / 2 || ax - aw / 2 > gw / 2 || az + ad / 2 < -gd / 2 || az - ad / 2 > gd / 2) out.push(`${at}#/scatter/${i}/area: the area does not touch the ground`);
    const first = streams.get(s.stream);
    if (first !== undefined) out.push(`${at}#/scatter/${i}/stream: "${s.stream}" is already drawn from by scatter rule ${first}; give each rule its own stream`);
    else streams.set(s.stream, i);
  });
  return out;
}
