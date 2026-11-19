#!/usr/bin/env node
// Hull's agent over ACP on stdio, for an app (or any ACP client) to start as a child process.
// Usage: hull-agent.js [project folder] [--fake script.json]
//   model: ANTHROPIC_API_KEY, or HULL_AGENT_BASE_URL + HULL_AGENT_API_KEY (+ HULL_AGENT_MODEL, HULL_AGENT_CONTEXT)
//   --fake / HULL_AGENT_FAKE: play a scripted model from a JSON file ([{ "text": "...", "tools": [{ "name": "check" }] }, ...]), no network.
// stdout is the protocol; diagnostics go to stderr.
import { register } from 'tsx/esm/api';
register();
const { readFileSync } = await import('node:fs');
const { resolve } = await import('node:path');
const { startHullAgent, fakeProvider } = await import('../src/index.ts');
const { findRoot } = await import('@hull/tools');
const args = process.argv.slice(2);
let fake = process.env.HULL_AGENT_FAKE;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--fake') fake = args[++i];
  else rest.push(args[i]);
}
const projectRoot = rest[0] ? resolve(rest[0]) : findRoot(process.cwd());
const provider = fake ? fakeProvider(JSON.parse(readFileSync(resolve(fake), 'utf8'))) : undefined;
const agent = startHullAgent({ projectRoot, ...(provider ? { provider } : {}) });
await agent.closed;
process.exit(0);
