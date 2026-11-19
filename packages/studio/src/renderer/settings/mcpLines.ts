// How a coding agent reaches the open project's tools: the lines Settings and the agent panel show to copy.
// Pure, so it is tested without a page.

import type { OpenedProject } from '../../shared/appApi.ts';

export interface McpLine { id: string; label: string; text: string; note?: string }

export function mcpLines(m: OpenedProject['mcp'], root: string): McpLine[] {
  return [
    { id: 'url', label: 'Address (streamable HTTP)', text: m.url, note: 'While Hull has this project open.' },
    { id: 'claude', label: 'Claude Code', text: `claude mcp add --transport http hull ${m.url}`, note: 'Run in the project folder.' },
    { id: 'codex', label: 'Codex (~/.codex/config.toml)', text: `[mcp_servers.hull]\ncommand = "node"\nargs = [${JSON.stringify(m.launcher)}, ${JSON.stringify(root)}]`, note: 'Starts the tools itself, so it works with Hull closed.' },
    { id: 'json', label: 'Cursor, Windsurf and other JSON configs', text: JSON.stringify({ mcpServers: { hull: { url: m.url } } }, null, 2) },
    { id: 'stdio', label: 'Any client that starts a command (stdio)', text: `node ${JSON.stringify(m.launcher)} ${JSON.stringify(root)}` },
  ];
}
