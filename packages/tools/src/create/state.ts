// Where a project is in the idea-to-play flow: .hull/create.json (docs/IDEA-TO-PLAY.md section 4.1). A project without the
// file is a finished one: step 'play', seven stages all waiting. The seven stages always exist, in order.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CreateMethods, CreateState, StageId, StageState } from 'hull/dev/protocol';

export const STAGES: readonly StageId[] = ['world', 'actors', 'animations', 'rules', 'sounds', 'effects', 'screens'];
const STEPS: readonly CreateState['step'][] = ['idea', 'brief', 'build', 'play'];
const STATUSES: readonly StageState['status'][] = ['waiting', 'building', 'ready', 'failed'];
const FILE = '.hull/create.json';

export const initialCreate = (): CreateState => ({ idea: '', step: 'play', briefApproved: false, stages: STAGES.map((id) => ({ id, status: 'waiting', pieces: [] })) });

/** Whatever is on disk, mended: missing stages are added in order, unknown fields dropped. */
export function readCreate(root: string): CreateState {
  const base = initialCreate();
  let v: Partial<CreateState>;
  try { v = JSON.parse(readFileSync(join(root, FILE), 'utf8')) as Partial<CreateState>; } catch { return base; }
  if (typeof v.idea === 'string') base.idea = v.idea;
  if (v.step && STEPS.includes(v.step)) base.step = v.step;
  if (typeof v.briefApproved === 'boolean') base.briefApproved = v.briefApproved;
  for (const s of Array.isArray(v.stages) ? v.stages : []) {
    const at = base.stages.findIndex((x) => x.id === s?.id);
    if (at >= 0 && STATUSES.includes(s.status)) {
      base.stages[at] = { id: s.id, status: s.status, pieces: Array.isArray(s.pieces) ? s.pieces.filter((p) => typeof p === 'string') : [], ...(typeof s.summary === 'string' ? { summary: s.summary } : {}), ...(typeof s.checkpoint === 'string' ? { checkpoint: s.checkpoint } : {}) };
    }
  }
  return base;
}

/** Applies a patch. Throws a sentence naming the field when the patch is wrong; nothing is written then. */
export function setCreate(root: string, p: CreateMethods['create.set']['params']): CreateState {
  const state = readCreate(root);
  const fail = (message: string, pointer: string): never => { throw new Error(`${FILE}#${pointer}: ${message}`); };
  const patch = p.patch ?? {};
  if (patch.idea !== undefined) { if (typeof patch.idea !== 'string') fail('idea must be text', '/idea'); state.idea = patch.idea; }
  if (patch.step !== undefined) { if (!STEPS.includes(patch.step)) fail(`step must be one of ${STEPS.join(', ')}`, '/step'); state.step = patch.step; }
  if (patch.briefApproved !== undefined) { if (typeof patch.briefApproved !== 'boolean') fail('briefApproved must be true or false', '/briefApproved'); state.briefApproved = patch.briefApproved; }
  if (p.stage) {
    const at = state.stages.findIndex((s) => s.id === p.stage!.id);
    if (at < 0) fail(`no stage "${String(p.stage.id)}" (stages: ${STAGES.join(', ')})`, '/stages');
    const cur = state.stages[at]!;
    const { id: _id, ...rest } = p.stage;
    if (rest.status !== undefined && !STATUSES.includes(rest.status)) fail(`status must be one of ${STATUSES.join(', ')}`, `/stages/${at}/status`);
    if (rest.pieces !== undefined && (!Array.isArray(rest.pieces) || rest.pieces.some((k) => typeof k !== 'string'))) fail('pieces must be a list of review keys', `/stages/${at}/pieces`);
    state.stages[at] = { ...cur, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) } as StageState;
  }
  mkdirSync(join(root, '.hull'), { recursive: true });
  const tmp = join(root, '.hull', `create.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, join(root, FILE));
  return state;
}
