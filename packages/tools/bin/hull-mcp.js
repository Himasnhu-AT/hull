#!/usr/bin/env node
// Starts the Hull MCP server on stdio for a project, for an agent to launch when the Hull app is not open. MCP only:
// there are no commands. Usage: hull-mcp.js [project folder]   (default: the folder holding hull.json at or above cwd)
import { register } from 'tsx/esm/api';
register();
const { createMcpServer, serveMcpStdio, findRoot } = await import('../src/index.ts');
const { resolve } = await import('node:path');
const root = process.argv[2] ? resolve(process.argv[2]) : findRoot(process.cwd());
const server = createMcpServer(root, { log: (l) => console.error(l) });
await serveMcpStdio(server, process.stdin, process.stdout, { author: process.env.HULL_MCP_AUTHOR });
process.exit(0);
