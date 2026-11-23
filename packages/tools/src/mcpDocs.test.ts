import { describe, expect, it, vi } from 'vitest';
import { docSources } from './create/docs.ts';
import { createMcpServer } from './mcp/server.ts';
import type { ProjectLink } from './server/link.ts';

// docs.read over MCP: the text content is the markdown itself, and structuredContent is the object with title and text.
// The first call builds one TypeScript program over every entry of the hull package (a few seconds when the machine is busy), so these tests wait longer than the default.
vi.setConfig({ testTimeout: 30_000 });

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

  // An agent learned Node, World, Behaviour, Light, Stock and KitUi by writing wrong code and reading type errors: the members are in the documents.
  it('lists the public members of classes and interfaces, with their doc comment', () => {
    const text = (id: string): string => docSources().find((s) => s.id === id)!.text();
    const core = text('api/core');
    for (const m of ['destroy(): void', 'add<B extends Behaviour>(', 'get<B extends Behaviour>(', 'addTo(group: string)']) expect(core, m).toContain('  - ' + m);
    for (const m of ['spawn(', 'find(path: string)', 'group(name: string)', 'after(seconds: number', 'every(seconds: number', 'random(stream: string)']) expect(core, m).toContain('  - ' + m);
    for (const m of ['ready?(): void', 'fixedUpdate?(dt: number): void', 'update?(dt: number, alpha: number): void', 'dispose?(): void']) expect(core, m).toContain('  - ' + m);
    expect(core).toMatch(/destroy\(\): void \/\/ Removes the node/);
    // Inherited members are listed once, on the base class: Node's own members are not repeated on a subclass.
    expect(text('api/render')).toMatch(/class Light extends Behaviour[^\n]*\n(  - [^\n]*\n)*  - intensity: number/);
    expect(text('api/render')).not.toMatch(/class Light[\s\S]*?  - node: Node[\s\S]*?\n- /);
    const stock = text('api/kits/pickups');
    expect(stock).toContain('  - take(name: string, amount: number): boolean');
    expect(text('api/kits/shared')).toContain('class KitUi extends Behaviour');
    // Private, protected, underscore and @internal members are left out.
    expect(core).not.toMatch(/^  - _/m);
    expect(core).not.toContain('_register');
  });

  it('every api document is under 20 KB, and a split entry has an index that says where each name is', () => {
    const all = docSources().filter((x) => x.kind === 'api');
    for (const s of all) expect(Buffer.byteLength(s.text()), s.id).toBeLessThan(20_000);
    const idx = all.find((s) => s.id === 'api/kits')!.text();
    expect(idx).toContain('api/kits/pickups: ');
    expect(idx).toContain('Stock');
    expect(all.some((s) => s.id === 'api/kits/pickups')).toBe(true);
  });
});
