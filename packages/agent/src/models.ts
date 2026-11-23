// What each model can do, and what the agent asks of it. Two different things:
//  - the row: the model's real limits (context window, max output) and what a request must know about it (thinking, effort);
//  - the ask: the agent works within WORKING_CONTEXT tokens of history by default (a longer history is slower and dearer on every
//    step; compaction starts at 70% of that budget) and sends max_tokens ASK_OUTPUT (the answer is streamed, so a large number is safe).
// HULL_AGENT_CONTEXT and HULL_AGENT_MAX_TOKENS change the ask, up to the row's real limits. Model ids have no date suffix.

export type Thinking =
  /** Thinking cannot be turned off (a request that disables it, or sets a budget, is a 400). Send no thinking field. */
  | 'always'
  /** Thinking is on unless asked otherwise. The agent never asks otherwise. */
  | 'default-on'
  /** Thinking happens only when the request enables it, which the agent does not. */
  | 'opt-in'
  | 'none';

export interface ModelRow {
  /** Real limits. */
  context: number;
  maxOutput: number;
  thinking: Thinking;
  /** Takes output_config.effort. */
  effort: boolean;
}

export interface ModelLimits extends ModelRow {
  /** Tokens of history the agent works within; compaction starts at 70% of it. */
  workingContext: number;
  /** max_tokens the agent sends. */
  askOutput: number;
}

export const WORKING_CONTEXT = 300_000;
export const ASK_OUTPUT = 64_000;

const M1 = 1_000_000;
const K128 = 128_000;
const fivePlus: ModelRow = { context: M1, maxOutput: K128, thinking: 'default-on', effort: true };
const always: ModelRow = { context: M1, maxOutput: K128, thinking: 'always', effort: true };
/** Older models of the 1M-context line. Whether they take effort is not known here, so none is sent. */
const older: ModelRow = { context: M1, maxOutput: K128, thinking: 'opt-in', effort: false };

/** First match wins, so the longer prefix goes first (claude-opus-5-5 before claude-opus-5). */
const TABLE: readonly [prefix: string, row: ModelRow][] = [
  ['claude-fable-5', always],
  ['claude-mythos-5', always],
  ['claude-opus-5-5', always],
  ['claude-opus-5', fivePlus],
  ['claude-sonnet-5-5', fivePlus],
  ['claude-sonnet-5', fivePlus],
  ['claude-haiku-5-5', fivePlus],
  ['claude-opus-4-8', older],
  ['claude-opus-4-7', older],
  ['claude-opus-4-6', older],
  ['claude-sonnet-4-6', older],
  ['claude-haiku-4-5', { context: 200_000, maxOutput: 64_000, thinking: 'opt-in', effort: false }],
  ['gpt-4.1', { context: 1_000_000, maxOutput: 32_768, thinking: 'none', effort: false }],
  ['gpt-4o', { context: 128_000, maxOutput: 16_384, thinking: 'none', effort: false }],
  ['gpt-5', { context: 400_000, maxOutput: 128_000, thinking: 'none', effort: false }],
];

/** For a model the table does not know: what is safe to ask of any current model of that kind. */
export const DEFAULT_ROW: Record<'anthropic' | 'openai', ModelRow> = {
  anthropic: { context: 200_000, maxOutput: 16_000, thinking: 'none', effort: false },
  openai: { context: 128_000, maxOutput: 8_192, thinking: 'none', effort: false },
};

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The row for a model name; a gateway may prefix it ("anthropic/claude-sonnet-5-5"), which is ignored. */
export function rowFor(kind: 'anthropic' | 'openai', model: string | undefined): { row: ModelRow; known: boolean } {
  const name = (model ?? '').toLowerCase().replace(/^.*\//, '');
  const hit = TABLE.find(([p]) => name.startsWith(p))?.[1];
  return { row: hit ?? DEFAULT_ROW[kind], known: hit !== undefined };
}

/** The row, plus what the agent works within and asks for after the environment's overrides (never above the row's real limits for a known model). */
export function limitsFor(kind: 'anthropic' | 'openai', model: string | undefined, over: { context?: number; maxOutput?: number } = {}): ModelLimits {
  const { row, known } = rowFor(kind, model);
  const cap = (v: number, max: number): number => (known ? Math.min(v, max) : v);
  return {
    ...row,
    workingContext: over.context !== undefined ? cap(over.context, row.context) : Math.min(WORKING_CONTEXT, row.context),
    askOutput: over.maxOutput !== undefined ? cap(over.maxOutput, row.maxOutput) : Math.min(ASK_OUTPUT, row.maxOutput),
  };
}

/** Effort by kind of run: the brief is a short interview, a build or a fix is the hard work. HULL_AGENT_EFFORT overrides all of them. */
export function effortFor(mode: 'brief' | 'build' | 'fix' | undefined, override?: Effort): Effort {
  return override ?? (mode === 'brief' || mode === undefined ? 'medium' : 'high');
}
