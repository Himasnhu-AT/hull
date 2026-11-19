/// <reference types="node" />
// The "Just now" hooks in the engine, fired for real with a sink installed (no browser): an animator, a graph and a burst.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config, defineGame, startGame, type Game } from '../index.ts';
import { setTraceSink, type TraceKind } from '../core/trace.ts';
import { Animator } from '../anim/index.ts';
import { exampleSources } from '../anim/examples/load.ts';
import { mountVfx, vfx } from '../vfx/index.ts';
import { feedLabel, humanize } from './labels.ts';

afterEach(() => setTraceSink(null));

type Heard = { kind: TraceKind; id: string; node: string | undefined };
const listen = (): Heard[] => {
  const heard: Heard[] = [];
  setTraceSink((kind, id, node) => heard.push({ kind, id, node }));
  return heard;
};

describe('labels', () => {
  it('turns ids into words a person reads', () => {
    expect(humanize('clash-sparks')).toBe('Clash sparks');
    expect(humanize('lightAttack_2')).toBe('Light attack 2');
    expect(feedLabel('vfx', 'vfx/clash-sparks', undefined)).toBe('Clash sparks');
    expect(feedLabel('sound', 'sound/sword/hit', undefined)).toBe('Sword hit');
    expect(feedLabel('anim', 'anim-graph/hero#light-attack', 'Aya')).toBe('Light attack');
    expect(feedLabel('actor', 'character/swordswoman', 'model')).toBe('Swordswoman');
    expect(feedLabel('actor', 'character', 'Aya')).toBe('Aya');
    expect(feedLabel('actor', 'character', '')).toBe('Character');
  });
  it('prefers the config title when there is one', () => {
    expect(feedLabel('sound', 'sound/sword/hit', undefined, 'Clash')).toBe('Clash');
    expect(feedLabel('actor', 'character/aya', 'Node', '  Aya the swordswoman ')).toBe('Aya the swordswoman');
    expect(feedLabel('vfx', 'vfx/x', undefined, '   ')).toBe('X');
  });
});

describe('animator and graph hooks', () => {
  beforeAll(() => { expect(config.load(exampleSources()).problems).toEqual([]); });
  const start = async (): Promise<{ game: Game; a: Animator }> => {
    let a!: Animator;
    const game = await startGame(defineGame({ ready(g) { a = g.world.spawn('hero').add(Animator, { character: 'character/swordswoman' }); } }), { seed: 3, stepRate: 60 });
    return { game, a };
  };

  it('reports the actor once when it is built, and once more when asked for a studio that came later', async () => {
    const heard = listen();
    const { game, a } = await start();
    game.step(2);
    expect(heard.filter((h) => h.kind === 'actor')).toEqual([{ kind: 'actor', id: 'character/swordswoman', node: 'hero' }]);
    a.announceActor();
    expect(heard.filter((h) => h.kind === 'actor')).toHaveLength(2);
    game.dispose();
  });

  it('announces a character that was built before the sink existed only when asked', async () => {
    const { game, a } = await start();
    game.step(2);
    const heard = listen();
    game.step(5);
    expect(heard).toEqual([]);
    a.announceActor();
    expect(heard).toEqual([{ kind: 'actor', id: 'character/swordswoman', node: 'hero' }]);
    game.dispose();
  });

  it('reports one anim event per state change, with the graph and the node', async () => {
    const { game, a } = await start();
    game.step(2);
    const heard = listen();
    a.trigger('light');
    game.step(1);
    const anims = heard.filter((h) => h.kind === 'anim');
    expect(anims).toHaveLength(1);
    expect(anims[0]!.id).toMatch(/^anim-graph\/.+#light1$/);
    expect(anims[0]!.node).toBe('hero');
    game.step(3);
    expect(heard.filter((h) => h.kind === 'anim')).toHaveLength(1);
    game.dispose();
  });

  it('builds no string and reads no id while nobody listens', async () => {
    const { game, a } = await start();
    game.step(2);
    const g = (a as unknown as { graphRt: { traceId: string } }).graphRt;
    let reads = 0;
    Object.defineProperty(g, 'traceId', { get() { reads++; return 'anim-graph/x'; }, configurable: true });
    a.trigger('light');
    game.step(1);
    expect(a.stateOf()).toBe('light1');
    expect(reads).toBe(0);
    game.step(240);
    expect(a.stateOf()).not.toBe('light1');
    const heard = listen();
    a.trigger('light');
    game.step(1);
    expect(heard).toHaveLength(1);
    expect(reads).toBe(1);
    game.dispose();
  });
});

describe('vfx hook', () => {
  const dir = join(import.meta.dirname, '..', 'vfx', 'examples', 'config');
  const files = (kind: string): { path: string; text: string }[] => readdirSync(join(dir, kind)).map((f) => ({ path: `config/${kind}/${f}`, text: readFileSync(join(dir, kind, f), 'utf8') }));
  it('reports a burst once, not per particle or per frame, and a trail once with its node', async () => {
    config.load([...files('vfx'), ...files('look'), ...files('material')]);
    const g = await startGame(defineGame({ ready() {} }), { seed: 3 });
    mountVfx(g);
    vfx.burst('dust', { x: 0, y: 0, z: 0 });
    const heard = listen();
    vfx.burst('sparks', { x: 0, y: 0, z: 0 });
    g.step(60);
    expect(heard).toEqual([{ kind: 'vfx', id: 'vfx/sparks', node: undefined }]);
    const n = g.world.spawn('ship');
    vfx.trail('gas-trail', n);
    g.step(30);
    expect(heard.filter((h) => h.id === 'vfx/gas-trail')).toEqual([{ kind: 'vfx', id: 'vfx/gas-trail', node: 'ship' }]);
    setTraceSink(null);
    const before = heard.length;
    vfx.burst('sparks', { x: 0, y: 0, z: 0 });
    g.step(5);
    expect(heard).toHaveLength(before);
    g.dispose();
  });
});
