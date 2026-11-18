import { basename, resolve } from 'node:path';
import { createProject } from '../server/templates.ts';
import { defineTool } from '../tool.ts';

export interface NewInput { dir: string; template?: string; title?: string }
export interface NewOutput { dir: string; template: string; ok: boolean; problems: [] }

// The app's "New project" and this command make a project the same way: createProject writes the standalone
// tsconfig and the title, so a project made here opens outside this repository too.
export const newGame = defineTool<NewInput, NewOutput>({
  name: 'new',
  summary: 'Makes a new game from a template.',
  input: {
    type: 'object',
    required: ['dir'],
    properties: { dir: { type: 'string' }, template: { type: 'string', default: 'cube' }, title: { type: 'string' } },
  },
  output: { type: 'object', required: ['dir', 'template'] },
  cli: {
    args: [{ name: 'dir', description: 'Folder to create' }],
    options: [
      { name: 'template', flags: '--template <name>', description: 'Template to copy', default: 'cube' },
      { name: 'title', flags: '--title <title>', description: 'The game\'s title (default: the folder name)' },
    ],
  },
  format: (o) => [`Created ${o.dir} from the ${o.template} template.`],
  async run(ctx, input) {
    const template = input.template ?? 'cube';
    const dir = resolve(ctx.root, input.dir);
    const { root } = await createProject({ template, dir, title: input.title ?? basename(dir) });
    return { dir: root, template, ok: true, problems: [] };
  },
});
