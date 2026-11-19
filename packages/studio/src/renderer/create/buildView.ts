// Build as data: the seven stages in words, what the person can do, what the screen should start. No React.

import type { CreateState, StageId, StageState } from 'hull/dev/protocol';

export const STAGE_ORDER: StageId[] = ['world', 'actors', 'animations', 'rules', 'sounds', 'effects', 'screens'];
export const STAGE_LABEL: Record<StageId, string> = { world: 'The world', actors: 'Characters', animations: 'Animations', rules: 'Rules', sounds: 'Sounds', effects: 'Effects', screens: 'Screens' };
export const STAGE_STATUS: Record<StageState['status'], string> = { waiting: 'Waiting', building: 'Building', ready: 'Ready', failed: 'Stopped' };
export const MAY_PLAY: StageId[] = ['world', 'actors', 'animations'];

/** The person may play once world, actors and animations are ready; nothing has to be approved first. */
export function canPlay(stages: readonly StageState[]): boolean {
  return MAY_PLAY.every((id) => stages.find((s) => s.id === id)?.status === 'ready');
}

/** Entering Build with the brief approved and every stage waiting starts the build. */
export function shouldStartBuild(s: CreateState | null): boolean {
  return !!s && s.briefApproved && s.stages.length > 0 && s.stages.every((x) => x.status === 'waiting');
}

export const readyCount = (stages: readonly StageState[]): number => stages.filter((s) => s.status === 'ready').length;

/** The stage to show: the one being built, else the first that stopped, else the last that is ready, else the first. */
export function defaultStage(stages: readonly StageState[]): StageId {
  const building = stages.find((s) => s.status === 'building');
  if (building) return building.id;
  const failed = stages.find((s) => s.status === 'failed');
  if (failed) return failed.id;
  const ready = [...stages].reverse().find((s) => s.status === 'ready');
  return (ready ?? stages[0])?.id ?? 'world';
}

export interface StagePieces {
  /** Things to look at and listen to. */
  look: string[];
  /** Ids of explain documents. */
  explained: string[];
  /** Review keys of pieces that are only numbers: shown as a table under Explained, since a person cannot look at a number. */
  numbers: string[];
}

/** A tunables block or a tuning config: nothing in it can be seen or heard. */
export const isNumbersKey = (key: string): boolean => key.startsWith('tunables:') || key.startsWith('tuning/');

/** A stage's pieces in its three groups. 'explain:<id>' keys are the explained ones, numbers go to a values table, the rest are looked at. */
export function splitPieces(keys: readonly string[]): StagePieces {
  return {
    look: keys.filter((k) => !k.startsWith('explain:') && !isNumbersKey(k)),
    explained: keys.filter((k) => k.startsWith('explain:')).map((k) => k.slice('explain:'.length)),
    numbers: keys.filter(isNumbersKey),
  };
}

/** The checkpoint a stage is compared with: the nearest earlier stage that saved one. Undefined for the first stage or when none saved. */
export function previousCheckpoint(stages: readonly StageState[], id: StageId): string | undefined {
  const at = STAGE_ORDER.indexOf(id);
  for (let i = at - 1; i >= 0; i--) {
    const cp = stages.find((s) => s.id === STAGE_ORDER[i])?.checkpoint;
    if (cp) return cp;
  }
  return undefined;
}

export const explainKey = (id: string): string => `explain:${id}`;
