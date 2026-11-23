// The build (docs/IDEA-TO-PLAY.md 4.5): not one run but one run per stage, each with a fresh history seeded with the brief, the docs
// index and what the earlier stages made. The stages are data; the runner is the loop around run(). A stage ends only when the
// check passes, the tests pass, the explain documents it owes are written, and the model has looked at one screenshot; then it
// is saved as a history checkpoint and handed over as pieces the person can review.
import type { CreateState, ExplainDoc, StageId, StageState } from 'hull/dev/protocol';
import { configKinds, historyHead, historySince, summarize } from './changes.ts';
import type { HullTools } from './hullTools.ts';
import { run, type RunIo, type SessionState } from './loop.ts';
import { BASE, systemPrompt } from './prompt.ts';
import type { Part } from './types.ts';

export interface ExplainNeed {
  kind: ExplainDoc['body']['type'];
  /** Said to the model: what the document is for. */
  how: string;
}

export interface StageDef {
  id: StageId;
  title: string;
  /** What to make, in the builder's terms. */
  make: string;
  /** Config kinds that belong to the stage (a hint, not a fence). */
  kinds: string[];
  /** Explain documents the stage must write before it is done. Any stage may write more. */
  explain: ExplainNeed[];
  /** What "done" means beyond the check, the tests and the explain documents. */
  done: string;
}

export const STAGES: readonly StageDef[] = [
  {
    id: 'world', title: 'World',
    make: 'The place the game happens in: the ground, walls, props, the sky and light, and where things start. Use the level kit and the materials and looks the brief names. Make it playable ground, not a picture.',
    kinds: ['material', 'look', 'tuning'],
    explain: [{ kind: 'map', how: 'A map of the place: take a wide screenshot with game_run {"control":{"op":"screenshot"}} after stepping the game a few frames, and write an explain document of type "map" whose image is that screenshot (a data URL, with its width and height) and whose marks (x and y from 0 to 1) name the spawn, the goal, the hazards and the places the brief names. Its why says in a sentence how the layout serves the first fight or the first goal.' }],
    done: 'the game starts in the place the brief describes and a screenshot shows it',
  },
  {
    id: 'actors', title: 'Actors',
    make: 'Every character the brief names in Cast: the player and the enemies or helpers, with their models, materials, sizes, health and speeds. Use the character and enemy kinds and the kits.',
    kinds: ['character', 'enemy', 'material', 'move-set'],
    explain: [],
    done: 'each cast member exists in the game and can be seen in a screenshot',
  },
  {
    id: 'animations', title: 'Animations',
    make: 'How the characters move: idle, walk, run, jump and attack as the brief needs, as animation sets and graphs wired to the characters.',
    kinds: ['anim-set', 'anim-graph'],
    explain: [],
    done: 'every character that moves has an animation graph and the player visibly changes pose when it moves',
  },
  {
    id: 'rules', title: 'Rules',
    make: 'What happens: how the player wins and loses, how enemies behave, scoring, timers, damage and the numbers that balance them. Put numbers in tunables or tuning config so they can be changed later; put logic in src/.',
    kinds: ['tuning', 'enemy', 'move-set', 'input-map'],
    explain: [{ kind: 'flow', how: 'A flowchart of the main rule loop (or of the enemy behaviour): nodes for each step or decision, edges between them with labels such as "yes" and "no", kind "ask" for a decision and "end" for a win or a loss. Its why says in a sentence what this decides. Write more documents (a table of the numbers that balance it) when they help.' }],
    done: 'the rules from the brief run in the game: stepping it shows the state change they describe',
  },
  {
    id: 'sounds', title: 'Sounds',
    make: 'The sounds the brief names: footsteps, hits, pickups, music or ambience, with the sound kit and the mixer. Each sound is a config the person can play on its own.',
    kinds: ['sound', 'mixer'],
    explain: [],
    done: 'each sound exists as config, is wired to the event that plays it, and is not clipping',
  },
  {
    id: 'effects', title: 'Effects',
    make: 'The visual effects: hit sparks, dust, smoke, trails and the look (light and colour grade) the brief asks for.',
    kinds: ['vfx', 'look'],
    explain: [],
    done: 'each effect is spawned by the event it belongs to and a screenshot after that event shows it',
  },
  {
    id: 'screens', title: 'Screens',
    make: 'The screens around the game: the heads-up display, the title and pause screens, and the win and lose screens, with a theme that matches the look.',
    kinds: ['ui-screen', 'ui-theme'],
    explain: [],
    done: 'the screens the brief names exist and a screenshot shows the heads-up display',
  },
];

/** Stages that do not build on the ones before them, so they still run when an earlier stage failed. The others need their predecessors. */
export const INDEPENDENT_STAGES: readonly StageId[] = ['sounds', 'effects', 'screens'];

export const stageDef = (id: StageId): StageDef => STAGES.find((s) => s.id === id)!;

/** The system prompt of one stage's run. The first line is what the scripted model finds its steps by. */
export function stageSystem(projectRoot: string, def: StageDef): string {
  const lead = [
    'Stage: ' + def.id,
    BASE,
    '',
    'You are in the build step. The person has approved a brief and is not watching this run: work on your own, do not ask questions, decide. You build one stage of seven (world, actors, animations, rules, sounds, effects, screens); earlier stages are done and the later ones come after you. Change only what belongs to your stage.',
    'Your stage is done only when: check passes, the tests pass, every explain document below is written, and you have looked at a screenshot. Finish with one or two plain sentences saying what the stage made (ids and values): the person reads them.',
    'Explain documents are for pieces the person cannot judge by looking or listening: write them with explain_write {doc:{id,title,stage:"' + def.id + '",why,body}}. Ids are lower-case words joined by dashes.',
  ].join('\n');
  return systemPrompt(projectRoot, 'build', lead);
}

const ownerLine = (n: ExplainNeed): string => '- a "' + n.kind + '" document: ' + n.how;

/** The first message of a stage's history: the brief, the docs index, the earlier stages' summaries, and this stage's task. */
export function stageTask(def: StageDef, o: { brief: string; docs: string[]; earlier: { id: string; title: string; summary: string }[]; note?: string; retry?: { reason: string; summary: string } }): string {
  const lines = [
    'Build the "' + def.title + '" stage.',
    '',
    'The brief (GAME.md):',
    o.brief || '(no brief was written; use the idea in create_get)',
    '',
    'Documents you can read with docs_read (read the kit READMEs you use before you write code):',
    ...(o.docs.length ? o.docs : ['(none)']),
    '',
    o.earlier.length ? 'Earlier stages made:' : 'No earlier stage has been built.',
    ...o.earlier.map((e) => '- ' + e.title + ': ' + e.summary),
    '',
    'This stage: ' + def.make,
    'Config kinds that usually belong here: ' + def.kinds.join(', ') + '.',
    def.explain.length ? 'Explain documents you must write:' : 'Explain documents: none are required; write one if a piece here cannot be judged by eye or ear.',
    ...def.explain.map(ownerLine),
    'Done when: ' + def.done + '.',
  ];
  if (o.note) lines.push('', 'The person looked at this stage and asked for a change: "' + o.note + '". Change only what the note asks, and keep the rest as it is.');
  if (o.retry) lines.push('', 'A first attempt at this stage stopped because ' + o.retry.reason, 'What that attempt said it made: ' + (o.retry.summary || '(it said nothing)'), 'Its changes are still in the project. Read what is there, fix what the reason names, and finish the stage; do not start over.');
  return lines.join('\n');
}

const stripVolatile = (d: ExplainDoc): string => JSON.stringify({ ...d, by: undefined, at: undefined });

/** The explain documents a stage still owes: one per required kind that no document of this stage has. */
export function missingExplain(def: StageDef, docs: readonly ExplainDoc[]): ExplainNeed[] {
  return def.explain.filter((need) => !docs.some((d) => d.stage === def.id && d.body.type === need.kind));
}

/** The last thing the model said in a history, for a stage's summary. */
export function lastText(history: SessionState['history']): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    const t = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('').trim();
    if (t) return t;
  }
  return '';
}

/** Whether a failed test run is only the project not being able to load its tests here (no installed packages), not a real failure. */
export function testsCouldNotRun(v: { total?: number; problems?: { message?: string }[] }): boolean {
  return (v.total ?? 0) === 0 && (v.problems ?? []).length > 0 && (v.problems ?? []).every((p) => /Cannot find (package|module)|ENOENT/.test(p.message ?? ''));
}

export interface BuildDeps {
  /** The provider, permissions and tools of the session; each stage runs on a copy with a fresh history. */
  state: SessionState;
  io: RunIo;
  signal: AbortSignal;
  /** Model calls one stage may use. Default 80 (HULL_AGENT_STAGE_STEPS). */
  stageSteps: number;
  /** Rework only this stage. */
  only?: StageId;
  /** What the person said about that stage. */
  note?: string;
  log?: (line: string) => void;
}

export interface BuildResult {
  outcome: 'done' | 'failed' | 'cancelled';
  built: StageId[];
  /** The first stage that failed (after its retry). */
  failed?: { stage: StageId; reason: string };
  /** Every stage that failed, in build order. */
  failures?: { stage: StageId; reason: string }[];
}

/** Fixed steps the game takes before the stage's screenshot. */
export const SHOT_TICKS = 60;

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + ' ...' : s);

export async function runBuild(deps: BuildDeps): Promise<BuildResult> {
  const { io, signal } = deps;
  const tools: HullTools = deps.state.tools;
  const log = deps.log ?? (() => {});
  const get = async (): Promise<CreateState> => (await tools.call('create.get', {})).value as CreateState;
  const setStage = async (stage: Partial<StageState> & { id: StageId }): Promise<CreateState> => (await tools.call('create.set', { stage })).value as CreateState;
  const showStages = (st: CreateState): void => io.ui({ id: 'stages', kind: 'stages', stages: st.stages });
  const built: StageId[] = [];
  const failures: { stage: StageId; reason: string }[] = [];

  let st = await get();
  const todo = deps.only ? [deps.only] : STAGES.filter((d) => st.stages.find((s) => s.id === d.id)?.status !== 'ready').map((d) => d.id);
  if (!todo.length) { io.text('Every stage is already built. Say which one to change.'); return { outcome: 'done', built }; }
  if (st.step === 'idea' || st.step === 'brief') st = (await tools.call('create.set', { patch: { step: 'build' } })).value as CreateState;

  for (const id of todo) {
    if (signal.aborted) return { outcome: 'cancelled', built };
    // After a failure only the stages that do not build on the others go on.
    if (failures.length && !INDEPENDENT_STAGES.includes(id)) continue;
    const def = stageDef(id);
    const before = st.stages.find((s) => s.id === id)!;
    io.text((built.length ? '\n\n' : '') + (deps.only ? 'Changing ' : 'Building ') + def.title.toLowerCase() + '.');
    st = await setStage({ id, status: 'building' });
    showStages(st);

    // A stage that fails its gates gets one more go, seeded with why it failed and what the first attempt said it made.
    let out = await buildStage(def, before, st);
    if (out.outcome === 'failed') {
      log('stage ' + id + ' failed: ' + out.reason);
      io.text('\n\n' + def.title + ' did not pass: ' + out.reason + ' Trying once more.');
      out = await buildStage(def, before, st, { reason: out.reason, summary: out.summary });
    }
    if (out.outcome === 'cancelled') {
      st = await setStage({ id, status: before.status === 'ready' ? 'ready' : 'waiting' });
      showStages(st);
      return { outcome: 'cancelled', built };
    }
    if (out.outcome === 'failed') {
      st = await setStage({ id, status: 'failed', summary: out.reason });
      showStages(st);
      failures.push({ stage: id, reason: out.reason });
      continue;
    }
    built.push(id);
    st = await setStage({ id, status: 'ready', summary: out.summary, checkpoint: out.checkpoint, pieces: out.pieces });
    showStages(st);
    if (out.pieces.length) io.ui({ id: 'pieces-' + id, kind: 'pieces', stage: id, keys: out.pieces });
    for (const doc of out.docs) io.ui({ id: 'explain-' + doc.id, kind: 'explain', doc });
  }

  if (failures.length) {
    const first = failures[0]!;
    const skipped = todo.filter((t) => !built.includes(t) && !failures.some((f) => f.stage === t));
    io.text('\n\nStopped. ' + (built.length ? 'Built: ' + built.map((b) => stageDef(b).title.toLowerCase()).join(', ') + '. ' : '') + 'Failed: ' + failures.map((f) => stageDef(f.stage).title.toLowerCase() + ' (' + f.reason + ')').join(' ') + (skipped.length ? ' Not started, because they build on a failed stage: ' + skipped.map((k) => stageDef(k).title.toLowerCase()).join(', ') + '.' : '') + ' Ask me to go on and I will start again from the first stage that is not ready.');
    showStages(st);
    return { outcome: 'failed', built, failed: first, failures };
  }

  if (st.stages.every((s) => s.status === 'ready') && st.step !== 'play') st = (await tools.call('create.set', { patch: { step: 'play' } })).value as CreateState;
  showStages(st);
  io.text('\n\nBuilt: ' + built.map((b) => stageDef(b).title.toLowerCase()).join(', ') + '. You can play it now.');
  return { outcome: 'done', built };

  async function buildStage(def: StageDef, prev: StageState, now: CreateState, retry?: { reason: string; summary: string }): Promise<
    { outcome: 'ready'; summary: string; checkpoint: string; pieces: string[]; docs: ExplainDoc[] } | { outcome: 'failed'; reason: string; summary: string } | { outcome: 'cancelled' }
  > {
    const baseHead = await historyHead(tools).catch(() => undefined);
    const kinds = await configKinds(tools).catch(() => new Set<string>());
    const libIds = async (): Promise<Set<string>> => new Set((((await tools.call('library.list', {})).value as { items?: { id: string; kind: string }[] }).items ?? []).filter((i) => i.kind !== 'game').map((i) => i.id));
    const libBefore = await libIds();
    const explainNow = async (): Promise<ExplainDoc[]> => (((await tools.call('explain.list', {})).value as { items?: ExplainDoc[] }).items ?? []);
    const docsBefore = new Map((await explainNow()).map((d) => [d.id, stripVolatile(d)]));
    const brief = ((await tools.call('brief.read', {})).value as { text?: string }).text ?? '';
    const docs = (((await tools.call('docs.list', {})).value as { items?: { id: string; title: string }[] }).items ?? []).map((d) => d.id + '  ' + d.title);
    const earlier = now.stages.filter((s) => s.status === 'ready' && s.id !== def.id && s.summary).map((s) => ({ id: s.id, title: stageDef(s.id).title, summary: s.summary! }));

    const state: SessionState = { ...deps.state, history: [], plan: [], mode: 'build', system: stageSystem(tools.root, def), maxSteps: deps.stageSteps, uiCount: deps.state.uiCount };
    const limit = deps.stageSteps;
    const maxFix = deps.state.maxFixRounds;
    let steps = 0;
    let fixRounds = 0;
    let summary = '';
    let prompt: Part[] = [{ type: 'text', text: stageTask(def, { brief, docs, earlier, ...(deps.note && deps.only ? { note: deps.note } : {}), ...(retry ? { retry } : {}) }) }];

    const step = async (p: Part[]): Promise<Awaited<ReturnType<typeof run>>> => {
      state.maxSteps = Math.max(1, limit - steps);
      const r = await run(state, p, io, signal);
      steps += r.steps;
      deps.state.runs = state.runs;
      return r;
    };
    const fail = (reason: string): { outcome: 'failed'; reason: string; summary: string } => ({ outcome: 'failed', reason, summary: cut(summary, 400) });

    try {
      while (true) {
        if (steps >= limit) return fail('it used all ' + limit + ' steps without finishing.');
        const r = await step(prompt);
        if (r.stop === 'cancelled') return { outcome: 'cancelled' };
        if (r.stop === 'max_turn_requests') return fail('it used all ' + limit + ' steps without finishing.');
        if (!summary) summary = lastText(state.history);
        if (r.checkFailed) {
          const c = await tools.call('check', {});
          return fail('the check still fails after ' + maxFix + ' fixes: ' + cut(c.text, 400));
        }
        const owed = missingExplain(def, await explainNow());
        if (owed.length) {
          if (fixRounds++ >= maxFix) return fail('the explain document this stage owes was not written (' + owed.map((o) => o.kind).join(', ') + ').');
          prompt = [{ type: 'text', text: 'This stage is not done: you still owe these explain documents.\n' + owed.map(ownerLine).join('\n') }];
          continue;
        }
        const t = await testGate(tools);
        if (!t.ok) {
          if (fixRounds++ >= maxFix) return fail('the tests still fail after ' + maxFix + ' fixes: ' + cut(t.text, 400));
          prompt = [{ type: 'text', text: 'The tests failed. Fix what they show, then finish again:\n' + cut(t.text, 3000) }];
          continue;
        }
        break;
      }

      // One screenshot, read by the model: the last check that what was built is what the stage was meant to make. The game is stepped
      // first (a second of game time), because a page that has only just loaded is still on tick 0 and shows nothing of the stage.
      await tools.call('game.run', { control: { op: 'step', n: SHOT_TICKS } }).catch((e: unknown) => { log('step before the screenshot failed: ' + String(e)); });
      const shot = await tools.call('game.run', { control: { op: 'screenshot' } }).catch((e: unknown) => { log('screenshot failed: ' + String(e)); return undefined; });
      if (shot?.images.length) {
        const r = await step([
          { type: 'text', text: 'This is the game after the ' + def.title.toLowerCase() + ' stage. Say in one sentence what you see. If something is clearly wrong for this stage, fix it; otherwise change nothing.' },
          { type: 'image', mime: shot.images[0]!.mime, data: shot.images[0]!.data },
        ]);
        if (r.stop === 'cancelled') return { outcome: 'cancelled' };
        if (r.checkFailed) return fail('the check failed after the last look.');
        if (r.wrote) {
          const t = await testGate(tools);
          if (!t.ok) return fail('the tests failed after the last look: ' + cut(t.text, 400));
        }
      }

      const cp = await tools.call('history.checkpoint', { name: 'stage-' + def.id });
      const items = await historySince(tools, baseHead);
      const changed = summarize(items, kinds);
      const pieces = [...changed.pieces];
      for (const l of await libIds()) if (!libBefore.has(l) && !pieces.includes(l)) pieces.push(l);
      const docsAfter = await explainNow();
      const written = docsAfter.filter((d) => docsBefore.get(d.id) !== stripVolatile(d));
      for (const d of written) pieces.push('explain:' + d.id);
      for (const p of prev.status === 'ready' || deps.only ? prev.pieces : []) if (!pieces.includes(p)) pieces.push(p);
      return { outcome: 'ready', summary: cut(summary || def.title + ' built.', 400), checkpoint: cp.ok ? 'stage-' + def.id : '', pieces, docs: written };
    } catch (e) {
      if (signal.aborted) return { outcome: 'cancelled' };
      throw e;
    }
  }
}

/** The tests, as a gate. A project whose tests cannot load here (no installed packages) is not failed for that. */
export async function testGate(tools: HullTools): Promise<{ ok: boolean; text: string }> {
  const r = await tools.call('test', {});
  const v = (r.value ?? {}) as { ok?: boolean; total?: number; problems?: { message?: string }[] };
  if (r.ok && v.ok !== false) return { ok: true, text: r.text };
  if (testsCouldNotRun(v)) return { ok: true, text: 'the tests could not run here' };
  return { ok: false, text: r.text };
}
