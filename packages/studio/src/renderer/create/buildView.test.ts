import { describe, expect, it } from 'vitest';
import type { CreateState, StageId, StageState } from 'hull/dev/protocol';
import { STAGE_ORDER, canPlay, defaultStage, previousCheckpoint, readyCount, shouldStartBuild, splitPieces } from './buildView.ts';

const stages = (m: Partial<Record<StageId, StageState['status']>>): StageState[] => STAGE_ORDER.map((id) => ({ id, status: m[id] ?? 'waiting', pieces: [] }));
const state = (s: StageState[], briefApproved = true): CreateState => ({ idea: 'x', step: 'build', briefApproved, stages: s });

describe('build view', () => {
  it('play opens when world, actors and animations are ready, not before', () => {
    expect(canPlay(stages({ world: 'ready', actors: 'ready' }))).toBe(false);
    expect(canPlay(stages({ world: 'ready', actors: 'ready', animations: 'building' }))).toBe(false);
    expect(canPlay(stages({ world: 'ready', actors: 'ready', animations: 'ready' }))).toBe(true);
  });
  it('starts the build only for an approved brief and seven waiting stages', () => {
    expect(shouldStartBuild(state(stages({})))).toBe(true);
    expect(shouldStartBuild(state(stages({}), false))).toBe(false);
    expect(shouldStartBuild(state(stages({ world: 'building' })))).toBe(false);
    expect(shouldStartBuild(state(stages({ world: 'failed' })))).toBe(false);
    expect(shouldStartBuild(null)).toBe(false);
  });
  it('shows the stage being built, else a failed one, else the last ready', () => {
    expect(defaultStage(stages({ world: 'ready', actors: 'building' }))).toBe('actors');
    expect(defaultStage(stages({ world: 'ready', actors: 'failed' }))).toBe('actors');
    expect(defaultStage(stages({ world: 'ready', actors: 'ready' }))).toBe('actors');
    expect(defaultStage(stages({}))).toBe('world');
    expect(readyCount(stages({ world: 'ready', actors: 'ready' }))).toBe(2);
  });
  it('splits a stage into what to look at and what is explained', () => {
    expect(splitPieces(['sound/hit', 'explain:raider-turn'])).toEqual({ look: ['sound/hit'], explained: ['raider-turn'], numbers: [] });
  });
  it('sends pieces that are only numbers to the values table', () => {
    expect(splitPieces(['sound/hit', 'tunables:player', 'tuning/arena'])).toEqual({ look: ['sound/hit'], explained: [], numbers: ['tunables:player', 'tuning/arena'] });
  });
  it('compares a stage with the nearest earlier checkpoint', () => {
    const s = stages({}).map((x) => (x.id === 'actors' ? { ...x, checkpoint: 'stage-actors' } : x));
    expect(previousCheckpoint(s, 'rules')).toBe('stage-actors');
    expect(previousCheckpoint(s, 'actors')).toBeUndefined();
    expect(previousCheckpoint(s, 'world')).toBeUndefined();
  });
});
