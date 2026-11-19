import { homedir } from 'node:os';
import { join } from 'node:path';
import { listCommunity, openCommunity, type CommunityGame } from '../server/community.ts';
import { defineTool } from '../tool.ts';

/** Where an agent's copies go when it does not say; the app passes its own projects folder. */
const defaultProjects = (): string => join(homedir(), 'Hull', 'projects');

export interface CommunityListOutput { ok: boolean; problems: []; items: CommunityGame[] }

const server = (): string | undefined => process.env['HULL_BACKEND_URL'] || undefined;

export const communityList = defineTool<{ projectsDir?: string }, CommunityListOutput>({
  name: 'community.list',
  summary: 'Lists the community games: title, note, the newest version, and whether you already have your own copy (and which version, and whether a newer one is out).',
  input: { type: 'object', properties: { projectsDir: { type: 'string', description: 'The folder copies live under. Defaults to ~/Hull/projects.' } } },
  output: { type: 'object', required: ['items'] },
  format: (o) => o.items.map((g) => `${g.id}  ${g.title}${g.version ? `  ${g.version}` : ''}${g.copy.exists ? `  (your copy${g.copy.version ? ` ${g.copy.version}` : ''}${g.update ? `, ${g.update} out` : ''})` : ''}`),
  async run(_ctx, input) {
    return { ok: true, problems: [], items: (await listCommunity({ projectsDir: input.projectsDir ?? defaultProjects(), server: server() })).map((g) => ({ ...g, cover: null })) };
  },
});

export const communityOpen = defineTool<{ id: string; reset?: boolean; update?: boolean; projectsDir?: string }, { ok: boolean; problems: []; root: string; created: boolean; version: string | null }>({
  name: 'community.open',
  summary: 'Gives you your own copy of a community game (downloaded or copied on first use, reused after) and returns its folder. The published game is never edited. reset: true replaces your copy with the published one; update: true does so only when a newer version is out.',
  input: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, reset: { type: 'boolean' }, update: { type: 'boolean' }, projectsDir: { type: 'string' } } },
  output: { type: 'object', required: ['root'] },
  format: (o) => [`${o.created ? 'Copied to' : 'Using'} ${o.root}${o.version ? ` (${o.version})` : ''}`],
  async run(_ctx, input) {
    const r = await openCommunity({ id: input.id, projectsDir: input.projectsDir ?? defaultProjects(), server: server(), ...(input.reset ? { reset: true } : {}), ...(input.update ? { update: true } : {}) });
    return { ok: true, problems: [], ...r };
  },
});
