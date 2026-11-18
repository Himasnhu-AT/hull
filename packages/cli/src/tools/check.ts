import type { Problem } from 'hull';
import { defineTool, type ProblemOutput } from '../tool.ts';
import { checkConfig } from './config.ts';
import { checkHouseRules } from './houseRules.ts';
import { runTsc } from './types.ts';

export const check = defineTool<Record<string, never>, ProblemOutput>({
  name: 'check',
  summary: 'Types, config against schemas, references, house rules.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', required: ['ok', 'problems'] },
  async run(ctx) {
    // Config first: it writes .hull/gen/ids.ts, which the type check reads.
    const problems: Problem[] = [];
    problems.push(...(await checkConfig(ctx.root)));
    problems.push(...checkHouseRules(ctx.root));
    problems.push(...(await runTsc(ctx.root)));
    return { ok: problems.length === 0, problems };
  },
});
