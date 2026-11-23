import { describe, expect, it } from 'vitest';
import { docSources } from './create/docs.ts';
import { createMcpServer } from './mcp/server.ts';
import type { ProjectLink } from './server/link.ts';

// docs.read over MCP: the text content is the markdown itself, and structuredContent is the object with title and text.
describe('docs.read over MCP', () => {
  const link = async (): Promise<ProjectLink> => ({
    attached: true, url: 'ws://x', gameUrl: 'http://x', close: async () => {},
    call: async (_m: string, p: unknown) => { const id = (p as { id: string }).id; const d = docSources().find((s) => s.id === id)!; return { ok: true, problems: [], id, title: d.title, text: d.text() }; },
  } as unknown as ProjectLink);

  it('gives the document as text and as structuredContent', async () => {
    const mcp = createMcpServer('/nowhere', { link });
    const r = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'docs.read', arguments: { id: 'api/anim' } } }))!.result as { content: { text: string }[]; structuredContent: { title: string; text: string } };
    expect(r.structuredContent.title).toBe('API: hull/anim');
    expect(r.structuredContent.text).toContain('class Animator');
    expect(r.content[0]!.text).toBe(r.structuredContent.text);
    expect(r.content[0]!.text.startsWith('{')).toBe(false);
    await mcp.close();
  });

  it('no api document is empty: each lists at least one export', () => {
    for (const s of docSources().filter((x) => x.kind === 'api' && x.id !== 'api/three')) expect(s.text().split('\n').filter((l) => l.startsWith('- ')).length, s.id).toBeGreaterThan(0);
  });
});
