// What each model can hold and write. A small table, matched by name prefix, so the provider asks for a sensible
// max_tokens instead of one number for everything: a file written in one tool call can be tens of thousands of tokens,
// and an answer cut at 8192 loses it. HULL_AGENT_CONTEXT and HULL_AGENT_MAX_TOKENS override the table; a model that is
// not in it gets the default of its provider kind.

export interface ModelLimits {
  /** Tokens the model can read. Compaction starts at 70% of it. */
  context: number;
  /** Most tokens one answer may have: sent as max_tokens. */
  maxOutput: number;
}

/** First match wins, so the longer prefix goes first. */
const TABLE: readonly [prefix: string, limits: ModelLimits][] = [
  ['claude-opus-5', { context: 200_000, maxOutput: 32_000 }],
  ['claude-sonnet-5', { context: 200_000, maxOutput: 64_000 }],
  ['claude-haiku-5', { context: 200_000, maxOutput: 32_000 }],
  ['claude-opus-4', { context: 200_000, maxOutput: 32_000 }],
  ['claude-sonnet-4', { context: 200_000, maxOutput: 64_000 }],
  ['claude-haiku-4', { context: 200_000, maxOutput: 32_000 }],
  ['claude-3-7', { context: 200_000, maxOutput: 64_000 }],
  ['claude-3-5', { context: 200_000, maxOutput: 8_192 }],
  ['gpt-4.1', { context: 1_000_000, maxOutput: 32_768 }],
  ['gpt-4o', { context: 128_000, maxOutput: 16_384 }],
  ['gpt-5', { context: 400_000, maxOutput: 64_000 }],
  ['o3', { context: 200_000, maxOutput: 64_000 }],
  ['o4', { context: 200_000, maxOutput: 64_000 }],
];

/** For a model the table does not know: what is safe to ask of any current model of that kind. */
export const DEFAULT_LIMITS: Record<'anthropic' | 'openai', ModelLimits> = {
  anthropic: { context: 200_000, maxOutput: 16_000 },
  openai: { context: 128_000, maxOutput: 8_192 },
};

/** The limits for a model name; a gateway may prefix it ("anthropic/claude-sonnet-5"), which is ignored. */
export function limitsFor(kind: 'anthropic' | 'openai', model: string | undefined, over: { context?: number; maxOutput?: number } = {}): ModelLimits {
  const name = (model ?? '').toLowerCase().replace(/^.*\//, '');
  const hit = TABLE.find(([p]) => name.startsWith(p))?.[1] ?? DEFAULT_LIMITS[kind];
  return { context: over.context ?? hit.context, maxOutput: over.maxOutput ?? hit.maxOutput };
}
