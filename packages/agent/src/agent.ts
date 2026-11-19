// Hull's own agent as an ACP agent: initialize, session/new, session/prompt (streaming text, plan, tool calls with diffs,
// permission requests), session/cancel, session/close. The model, the loop and the tools are in their own files; this one
// only translates between them and the protocol.
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { HullTools } from './hullTools.ts';
import { run, type Decision, type PermissionMode, type RunIo, type SessionState, type ToolContent } from './loop.ts';
import { systemPrompt } from './prompt.ts';
import { createProvider, providerConfigFromEnv, type ProviderConfig } from './providers.ts';
import type { Part, Provider } from './types.ts';

export const AGENT_NAME = 'Hull agent';

export interface HullAgentOptions {
  /** The project folder (the one holding hull.json). */
  projectRoot: string;
  /** A model, or the settings for one. Without it the environment decides (HULL_AGENT_BASE_URL / ANTHROPIC_API_KEY); with neither, a prompt is answered with how to set one up. */
  provider?: Provider | ProviderConfig;
  env?: Record<string, string | undefined>;
  /** Which writes ask first. Default 'risky': rename, move, delete, restore, revert, adopt. */
  permissions?: PermissionMode;
  /** Streams to speak ACP over. Default: this process's stdin and stdout. */
  input?: ReadableStream<Uint8Array>;
  output?: WritableStream<Uint8Array>;
  /** Or an already-made ACP stream (for an in-process client). Wins over input/output. */
  stream?: acp.Stream;
  maxFixRounds?: number;
  log?: (line: string) => void;
}

export interface HullAgent { connection: acp.AgentConnection; closed: Promise<void>; close(): void }

interface Live { state: SessionState; abort: AbortController; running: boolean; cancelPermission?: () => void }

const NO_MODEL = `Hull's agent has no model to talk to. Set ANTHROPIC_API_KEY (an Anthropic key), or HULL_AGENT_BASE_URL and HULL_AGENT_API_KEY (any OpenAI-compatible endpoint, such as Marl's gateway), and start the session again.`;

const textOf = (b: acp.ContentBlock): Part | undefined => {
  switch (b.type) {
    case 'text': return { type: 'text', text: b.text };
    case 'image': return { type: 'image', mime: b.mimeType, data: b.data };
    case 'resource_link': return { type: 'text', text: `[file: ${b.uri}]` };
    case 'resource': return 'text' in b.resource ? { type: 'text', text: `[${b.resource.uri}]\n${b.resource.text}` } : undefined;
    default: return undefined;
  }
};

export function startHullAgent(o: HullAgentOptions): HullAgent {
  const log = o.log ?? ((l: string) => console.error(l));
  const provider: Provider | undefined = (() => {
    const p = o.provider ?? providerConfigFromEnv(o.env ?? process.env);
    if (!p) return undefined;
    return 'complete' in p ? p : createProvider(p);
  })();
  const sessions = new Map<string, Live>();

  const abs = (p: string): string => (isAbsolute(p) || p.startsWith('tunables:') ? p : join(o.projectRoot, p));
  const mapContent = (c: ToolContent[]): acp.ToolCallContent[] => c.map((x) => (x.type === 'diff' ? { type: 'diff' as const, path: abs(x.path), oldText: x.oldText, newText: x.newText } : { type: 'content' as const, content: { type: 'text' as const, text: x.text } }));

  const app = acp.agent({ name: 'hull-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: false } },
      agentInfo: { name: 'hull-agent', title: AGENT_NAME, version: '0.0.0' },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.new, async () => {
      const tools = new HullTools(o.projectRoot, { clientName: AGENT_NAME, log });
      await tools.open();
      // params.mcpServers is not used: the same tools are called in-process, so there is no second connection to the app.
      const id = randomUUID();
      sessions.set(id, {
        abort: new AbortController(), running: false,
        state: { provider: provider ?? NO_PROVIDER, tools, system: systemPrompt(o.projectRoot), history: [], permissions: o.permissions ?? (process.env['HULL_AGENT_PERMISSIONS'] as PermissionMode | undefined) ?? 'risky', allowed: new Set(), plan: [], maxFixRounds: o.maxFixRounds ?? 3, maxSteps: 60, runs: 0 },
      });
      return { sessionId: id };
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const live = sessions.get(params.sessionId);
      if (!live) throw new acp.RequestError(-32602, `unknown session ${params.sessionId}`);
      if (live.running) throw new acp.RequestError(-32602, 'a prompt is already running in this session');
      const sessionId = params.sessionId;
      const send = (update: acp.SessionUpdate): Promise<void> => client.notify(acp.methods.client.session.update, { sessionId, update });
      if (!provider) {
        await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: NO_MODEL } });
        return { stopReason: 'end_turn' as const };
      }
      live.running = true;
      live.abort = new AbortController();
      const signal = live.abort.signal;
      let compactions = 0;
      let queue: Promise<void> = Promise.resolve();
      // Updates must reach the client in the order they happened, so each waits for the one before.
      const emit = (update: acp.SessionUpdate): void => { queue = queue.then(() => send(update)).catch((e) => log(`update failed: ${String(e)}`)); };
      const io: RunIo = {
        text: (t) => emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }),
        plan: (items) => emit({ sessionUpdate: 'plan', entries: items }),
        toolStart: (c) => emit({ sessionUpdate: 'tool_call', toolCallId: c.id, title: c.title, kind: c.kind as acp.ToolKind, status: 'in_progress', rawInput: c.input }),
        toolEnd: (c) => emit({ sessionUpdate: 'tool_call_update', toolCallId: c.id, status: c.ok ? 'completed' : 'failed', content: mapContent(c.content), rawOutput: c.output }),
        usage: (u) => emit({ sessionUpdate: 'usage_update', used: u.used, size: u.size, _meta: { input: u.total.input, output: u.total.output } }),
        compaction: (status, summary, error) => emit({ sessionUpdate: 'compaction_update', compactionId: `c${compactions + (status === 'in_progress' ? 1 : 0)}`, status, ...(summary ? { summary: [{ type: 'text' as const, text: summary }] } : {}), ...(error ? { error } : {}) }),
        permission: async (c): Promise<Decision> => {
          await queue;
          const cancelled = new Promise<Decision>((res) => { live.cancelPermission = () => res('cancelled'); });
          const ask = client.request(acp.methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId: c.id, title: c.title, kind: c.kind as acp.ToolKind, status: 'pending', rawInput: c.input, content: mapContent(c.content) },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
              { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
            ],
          }).then((r): Decision => (r.outcome.outcome === 'cancelled' ? 'cancelled' : r.outcome.optionId === 'allow' ? 'allow_once' : r.outcome.optionId === 'allow_always' ? 'allow_always' : 'reject'));
          try { return await Promise.race([ask, cancelled]); } finally { delete live.cancelPermission; }
        },
      };
      try {
        const parts = params.prompt.map(textOf).filter((p): p is Part => p !== undefined);
        const result = await run(live.state, parts.length ? parts : [{ type: 'text', text: '(empty prompt)' }], { ...io, compaction: (s, sum, err) => { if (s === 'in_progress') compactions++; io.compaction(s, sum, err); } }, signal);
        await queue;
        const stopReason = result.stop === 'cancelled' ? 'cancelled' : result.stop === 'max_turn_requests' ? 'max_turn_requests' : 'end_turn';
        return { stopReason: stopReason as acp.StopReason, _meta: { usage: result.usage, steps: result.steps, wrote: result.wrote, checkFailed: result.checkFailed, model: live.state.provider.model, provider: live.state.provider.name } };
      } catch (e) {
        await queue;
        const msg = e instanceof Error ? e.message : String(e);
        await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `The model call failed: ${msg}` } });
        return { stopReason: 'end_turn' as const, _meta: { error: msg } };
      } finally { live.running = false; }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      const live = sessions.get(params.sessionId);
      live?.abort.abort();
      live?.cancelPermission?.();
    })
    .onRequest(acp.methods.agent.session.close, async ({ params }) => {
      const live = sessions.get(params.sessionId);
      if (live) { live.abort.abort(); sessions.delete(params.sessionId); await live.state.tools.close(); }
      return {};
    });

  const stream = o.stream ?? acp.ndJsonStream(o.output ?? (Writable.toWeb(process.stdout) as WritableStream<Uint8Array>), o.input ?? (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
  const connection = app.connect(stream);
  const closed = connection.closed.then(async () => { for (const l of sessions.values()) { l.abort.abort(); await l.state.tools.close().catch(() => {}); } sessions.clear(); });
  return { connection, closed, close: () => connection.close() };
}

/** Stand-in so SessionState is complete when no model is set up: prompts are answered before it is ever called. */
const NO_PROVIDER: Provider = { name: 'none', model: 'none', contextWindow: 1, complete: () => Promise.reject(new Error(NO_MODEL)) };
