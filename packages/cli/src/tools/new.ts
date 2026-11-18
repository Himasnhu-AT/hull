import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '../tool.ts';

const skip = new Set(['node_modules', '.hull', 'dist']);
const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../templates');

export interface NewInput { dir: string; template?: string }
export interface NewOutput { dir: string; template: string; ok: boolean; problems: [] }

export const newGame = defineTool<NewInput, NewOutput>({
  name: 'new',
  summary: 'Makes a new game from a template.',
  input: { type: 'object', required: ['dir'], properties: { dir: { type: 'string' }, template: { type: 'string', default: 'cube' } } },
  output: { type: 'object', required: ['dir', 'template'] },
  cli: {
    args: [{ name: 'dir', description: 'Folder to create' }],
    options: [{ name: 'template', flags: '--template <name>', description: 'Template to copy', default: 'cube' }],
  },
  format: (o) => [`Created ${o.dir} from the ${o.template} template.`],
  async run(ctx, input) {
    const template = input.template ?? 'cube';
    const from = join(templatesDir, template);
    if (!existsSync(from)) {
      const names = readdirSync(templatesDir).join(', ');
      throw new Error(`no template '${template}' (have: ${names})`);
    }
    const to = resolve(ctx.root, input.dir);
    if (existsSync(to) && readdirSync(to).length > 0) throw new Error(`${to} exists and is not empty`);
    cpSync(from, to, { recursive: true, filter: (src) => !skip.has(src.split(/[\\/]/).pop()!) });
    return { dir: to, template, ok: true, problems: [] };
  },
});
