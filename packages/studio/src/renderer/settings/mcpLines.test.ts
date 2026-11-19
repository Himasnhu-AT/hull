import { describe, expect, it } from 'vitest';
import { mcpLines } from './mcpLines.ts';

describe('mcpLines', () => {
  const m = { url: 'http://127.0.0.1:5412/mcp', launcher: '/app/tools/bin/hull-mcp.js' };
  it('gives every client the open project', () => {
    const l = mcpLines(m, '/games/my game');
    const by = Object.fromEntries(l.map((x) => [x.id, x.text]));
    expect(by['claude']).toBe('claude mcp add --transport http hull http://127.0.0.1:5412/mcp');
    expect(by['codex']).toContain('args = ["/app/tools/bin/hull-mcp.js", "/games/my game"]');
    expect(JSON.parse(by['json']!)).toEqual({ mcpServers: { hull: { url: m.url } } });
    // A folder with a space stays one argument.
    expect(by['stdio']).toBe('node "/app/tools/bin/hull-mcp.js" "/games/my game"');
  });
});
