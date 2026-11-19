#!/usr/bin/env node
// Hull's agent over ACP on stdio, for an app (or any ACP client) to start as a child process.
// Usage: hull-agent.js [project folder] [--fake script.json | folder]
//   model: ANTHROPIC_API_KEY, or HULL_AGENT_BASE_URL + HULL_AGENT_API_KEY (+ HULL_AGENT_MODEL, HULL_AGENT_CONTEXT);
//          HULL_AGENT_STAGE_STEPS = model calls one build stage may use (default 80).
//   --fake / HULL_AGENT_FAKE: play a scripted model, no network and no key. Two forms:
//     a JSON file ([{ "text": "...", "tools": [{ "name": "check" }] }, ...]), used for every mode; or
//     a FOLDER holding brief.json, build.json and fix.json, one script per mode. build.json is { "<stage id>": [steps] }.
//     packages/agent/fixtures/arena/ is such a folder for a project made from templates/arena:
//       HULL_AGENT_FAKE=<repo>/packages/agent/fixtures/arena pnpm app:web -- --port 5190 --project <copy of the arena template>
//     A step may carry "when": "text" to play only when that text is in the last two user messages, and a tool input may use
//     "$screenshot", "$screenshot.width", "$screenshot.height" for the newest picture a tool returned.
// stdout is the protocol; diagnostics go to stderr.
import { register } from 'tsx/esm/api';
register();
const { resolve } = await import('node:path');
const { startHullAgent, fakeFromPath } = await import('../src/index.ts');
const { findRoot } = await import('@hull/tools');
const args = process.argv.slice(2);
let fake = process.env.HULL_AGENT_FAKE;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--fake') fake = args[++i];
  else rest.push(args[i]);
}
const projectRoot = rest[0] ? resolve(rest[0]) : findRoot(process.cwd());
const provider = fake ? fakeFromPath(fake) : undefined;
const agent = startHullAgent({ projectRoot, ...(provider ? { provider } : {}) });
await agent.closed;
process.exit(0);
