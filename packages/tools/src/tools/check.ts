import type { Problem } from 'hull';
import { defineTool, type ProblemOutput } from '../tool.ts';
import { checkAuthorship } from '../history/authors.ts';
import { checkConfig } from './config.ts';
import { checkHouseRules } from './houseRules.ts';
import { checkKitConfig } from './kitConfig.ts';
import { checkConfigMeaning } from './meaning.ts';
import { checkConfigRefs } from './refCheck.ts';
import { runTsc } from './types.ts';

export const check = defineTool<Record<string, never>, ProblemOutput>({
  name: 'check',
  summary: 'Types, config against schemas, references, what each kit knows about its own kinds (a level, a prefab, a move-set, an enemy, a glTF file that is missing), house rules, "<kind>/<id>" names in src/ that no config answers to, and kits imported without the config they ship (fix: kit.add).',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', required: ['ok', 'problems'] },
  async run(ctx) {
    // Config first: it writes .hull/gen/ids.ts, which the type check reads.
    const problems: Problem[] = [];
    problems.push(...(await checkConfig(ctx.root)));
    // What the kits know about their own kinds and a schema cannot say (a window past the end of a move, a missing model file).
    problems.push(...(await checkConfigMeaning(ctx.root)));
    problems.push(...checkHouseRules(ctx.root));
    problems.push(...(await checkConfigRefs(ctx.root)));
    // Config a kit needs and the project does not have (the kit's code runs, warns and draws nothing).
    problems.push(...(await checkKitConfig(ctx.root)));
    // An AI change over a value you set is flagged (ARCHITECTURE section 7, authorship per value).
    problems.push(...(await checkAuthorship(ctx.root)));
    problems.push(...(await runTsc(ctx.root)));
    return { ok: problems.length === 0, problems };
  },
});
