// Hit and collider shapes of a character: the `hits` list, checked against the body's bones and returned with each
// shape's bone index, so a game can follow the shape with the bone's world transform.
import type { Character, CharacterHit } from '../schema/character.ts';
import { buildBody } from './skeleton.ts';

export interface ResolvedHit {
  /** Index into the character's skeleton. */
  bone: number;
  hit: CharacterHit;
}

/** Throws a sentence naming the pointer if a shape has no bone, or lacks the numbers its kind needs. */
export function characterHits(def: Character, at = 'character'): ResolvedHit[] {
  const { skeleton } = buildBody(def.body, `${at}#/body`);
  const out: ResolvedHit[] = [];
  (def.hits ?? []).forEach((hit, i) => {
    const where = `${at}#/hits/${i}`;
    const bone = skeleton.index(hit.bone);
    if (bone < 0) throw new Error(`${where}/bone: "${hit.bone}" is not a bone of this body`);
    const need = hit.shape === 'capsule' ? (hit.a && hit.b && hit.r !== undefined) : hit.shape === 'sphere' ? (hit.c && hit.r !== undefined) : (hit.c && hit.h);
    if (!need) throw new Error(`${where}: a ${hit.shape} needs ${hit.shape === 'capsule' ? 'a, b and r' : hit.shape === 'sphere' ? 'c and r' : 'c and h'}`);
    out.push({ bone, hit });
  });
  return out;
}
