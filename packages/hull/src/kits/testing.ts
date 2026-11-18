/// <reference types="node" />
// Test helpers for the kits and for games built from them: read config from disk, start a game with a headless input
// and counted sounds. Node only; never imported by a game.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, startGame, type ConfigSource, type Game, type GameDef } from '../index.ts';
import { InputCore, wireInput, type StepSnapshot } from '../input/index.ts';
import { createSaves, memoryStore } from '../platform/index.ts';
import { kitIO } from './io.ts';

const here = dirname(fileURLToPath(import.meta.url));

function walk(dir: string, rel: string, out: ConfigSource[]): void {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, rel, out);
    else if (n.endsWith('.json')) out.push({ path: relative(rel, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') });
  }
}

/** The config of a project folder: its hull.json and everything under config/. */
export function projectSources(root: string): ConfigSource[] {
  const out: ConfigSource[] = [{ path: 'hull.json', text: readFileSync(join(root, 'hull.json'), 'utf8') }];
  walk(join(root, 'config'), root, out);
  return out;
}

/** The default config of the named kits ('level', 'fps'), as if they were a project's `config/`. */
export function kitSources(...kits: string[]): ConfigSource[] {
  const out: ConfigSource[] = [{ path: 'hull.json', text: JSON.stringify({ kind: 'game', id: 'kit-test', title: 'Kit test', version: '0.0.0', entry: 'src/main.ts', step: 60 }) }];
  const seen = new Set<string>();
  for (const k of kits) {
    const tmp: ConfigSource[] = [];
    walk(join(here, k, 'config'), join(here, k), tmp);
    for (const s of tmp) if (!seen.has(s.path)) { seen.add(s.path); out.push({ path: s.path.startsWith('config/') ? s.path : `config/${s.path}`, text: s.text }); }
  }
  return out;
}

/** Every kit's default config, for tests that mix kits. */
export const ALL_KITS = ['level', 'fps', 'third-person', 'health', 'pickups', 'spawner', 'pause'] as const;

export interface Rig {
  g: Game;
  core: InputCore;
  /** Sounds played, by id. */
  sounds: Record<string, number>;
  /** Fresh in-memory saves, used by the kits for this game. */
  step(n: number, frame?: StepSnapshot): void;
}

/** Loads the config, then starts the game with a headless input core mapped by `inputMap` ('fps'; '' for none). */
export async function startRig(def: GameDef, sources: ConfigSource[], inputMap: string, seed = 7): Promise<Rig> {
  const loaded = config.load(sources);
  if (loaded.problems.length) throw new Error(`config problems:\n${loaded.problems.map((p) => `${p.file}${p.pointer ?? ''}: ${p.message}`).join('\n')}`);
  const sounds: Record<string, number> = {};
  kitIO.sink = (id) => { sounds[id] = (sounds[id] ?? 0) + 1; };
  kitIO.useSaves(createSaves({ store: memoryStore(), version: 1, now: () => 1_700_000_000_000 }));
  const g = await startGame(def, { seed });
  const core = new InputCore(() => g.world.tick);
  if (inputMap) core.setMap(config.lookup('input-map', inputMap), `input-map/${inputMap}`);
  wireInput(g, core);
  kitIO.input = core;
  return {
    g, core, sounds,
    step(n, frame) {
      // One recorded frame per step, so an input is held for exactly the steps it is given.
      core.play(Array.from({ length: n }, () => frame ?? {}));
      g.step(n);
    },
  };
}

export interface ScenarioOptions {
  def: GameDef;
  sources: ConfigSource[];
  inputMap: string;
  steps: number;
  seed?: number;
  /** What the player does at step `i`. Called once per step; it may look at the game. */
  input(i: number, rig: Rig): StepSnapshot;
  /** Calls that are not input (a save, a load) at a step, before that step runs. Replays must give the same. */
  at?: Record<number, (rig: Rig) => void>;
  /** Called after every step. */
  observe?(i: number, rig: Rig): void;
}

/** Plays a game for `steps` steps, recording what the input saw. The rig is returned live: read it, then dispose. */
export async function runScenario(o: ScenarioOptions): Promise<{ rig: Rig; checksum: string; recording: StepSnapshot[] }> {
  const rig = await startRig(o.def, o.sources, o.inputMap, o.seed ?? 11);
  const rec = rig.core.record();
  for (let i = 0; i < o.steps; i++) {
    o.at?.[i]?.(rig);
    rig.core.play([o.input(i, rig)]);
    rig.g.step(1);
    o.observe?.(i, rig);
  }
  const recording = rec.stop();
  return { rig, checksum: rig.g.world.checksum(), recording };
}
