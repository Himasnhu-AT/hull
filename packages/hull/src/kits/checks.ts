// What the schemas cannot say, per config kind, in one table the check tool runs on every file that passed its schema.
// Each checker returns sentences that start with the place, "<kind>/<id>#/json/pointer: ...". Nothing here (or in the
// files it imports) touches a renderer or the world, so a tool can load it without loading the kits.
import type { Character, Enemy, Level, MoveSet, Prefab } from '../schema/index.ts';
import { checkEnemy, checkMoveSet } from './combat/check.ts';
import { checkLevel, checkPrefab } from './level/check.ts';

export interface CheckContext {
  /** Another config by kind and id relative to the kind ('move-set', 'duelist'); undefined when there is none. */
  lookup(kind: string, id: string): unknown;
  /** True when the file is in the project's assets/ folder ('models/crate.glb'). */
  hasAsset(file: string): boolean;
}

export type MeaningCheck = (def: unknown, at: string, ctx: CheckContext) => string[];

const bare = (id: string): string => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);
const inAssets = (file: string): string => file.replace(/^(\.?\/)+/, '').replace(/^assets\//, '');

export const meaningChecks: Readonly<Record<string, MeaningCheck>> = {
  'move-set': (def, at) => checkMoveSet(def as MoveSet, at),
  enemy: (def, at, ctx) => {
    const moves = ctx.lookup('move-set', bare((def as Enemy).moveSet));
    // A move-set that does not exist is the references check's finding; there is nothing to compare against here.
    return moves ? checkEnemy(def as Enemy, moves as MoveSet, at) : [];
  },
  level: (def, at) => checkLevel(def as Level, at),
  prefab: (def, at, ctx) => checkPrefab(def as Prefab, at, ctx.hasAsset),
  character: (def, at, ctx) => {
    const body = (def as Character).body as { type?: string; file?: string } | undefined;
    if (body?.type !== 'gltf') return [];
    if (!body.file) return [at + '#/body: a gltf body needs a `file`, a .glb or .gltf inside assets/'];
    return ctx.hasAsset(body.file) ? [] : [at + '#/body/file: assets/' + inAssets(body.file) + ' does not exist'];
  },
};
