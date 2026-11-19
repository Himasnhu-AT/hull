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

export interface StagePieces { look: string[]; explained: string[] }

/** A stage's pieces in its two groups. 'explain:<id>' keys are the explained ones; the rest are things to look at and listen to. */
export function splitPieces(keys: readonly string[]): StagePieces {
  return { look: keys.filter((k) => !k.startsWith('explain:')), explained: keys.filter((k) => k.startsWith('explain:')).map((k) => k.slice('explain:'.length)) };
}

export const explainKey = (id: string): string => `explain:${id}`;
