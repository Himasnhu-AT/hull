import { homedir } from 'node:os';
import { join } from 'node:path';
import { listCommunity, openCommunity, type CommunityGame } from '../server/community.ts';
import { defineTool } from '../tool.ts';

/** Where an agent's copies go when it does not say; the app passes its own projects folder. */
const defaultProjects = (): string => join(homedir(), 'Hull', 'projects');

export interface CommunityListOutput { ok: boolean; problems: []; items: CommunityGame[] }

export const communityList = defineTool<{ projectsDir?: string }, CommunityListOutput>({
  name: 'community.list',
  summary: 'Lists the community games: title, note, cover, and whether you already have your own copy.',
  input: { type: 'object', properties: { projectsDir: { type: 'string', description: 'The folder copies live under. Defaults to ~/Hull/projects.' } } },
  output: { type: 'object', required: ['items'] },
  format: (o) => o.items.map((g) => `${g.id}  ${g.title}${g.copy.exists ? '  (copied)' : ''}`),
  async run(_ctx, input) {
    return { ok: true, problems: [], items: listCommunity({ projectsDir: input.projectsDir ?? defaultProjects() }).map((g) => ({ ...g, cover: null })) };
  },
});

export const communityOpen = defineTool<{ id: string; reset?: boolean; projectsDir?: string }, { ok: boolean; problems: []; root: string; created: boolean }>({
  name: 'community.open',
  summary: 'Gives you your own copy of a community game (copied on first use, reused after) and returns its folder. The shipped game is never edited. reset: true replaces your copy with the original.',
  input: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, reset: { type: 'boolean' }, projectsDir: { type: 'string' } } },
  output: { type: 'object', required: ['root'] },
  format: (o) => [`${o.created ? 'Copied to' : 'Using'} ${o.root}`],
  async run(_ctx, input) {
    const r = openCommunity({ id: input.id, projectsDir: input.projectsDir ?? defaultProjects(), ...(input.reset ? { reset: true } : {}) });
    return { ok: true, problems: [], ...r };
  },
});
