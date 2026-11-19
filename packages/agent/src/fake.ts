// A scripted model for tests and for trying the app with no network and no key: each call to complete() plays the next step,
// streaming its text in small pieces so everything downstream (the deltas, the cards, the app) is exercised.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentMode } from 'hull/dev/protocol';
import type { Completion, CompleteRequest, Msg, Provider } from './types.ts';

export interface FakeStep {
  text?: string;
  /** Tool calls, by Hull tool name (dots allowed) or by a conversation tool (ui_ask, ui_show, ui_approve, update_plan). */
  tools?: { name: string; input?: unknown }[];
  /**
   * Play this step only when this text (any case) is in the last two user messages (tool results and prompts); otherwise skip it.
   * It lets one script hold both ways a conversation can go, for example "approved" and "asked for a change".
   */
  when?: string;
}

/** A script is a list of steps, or (for the build runner) one list per stage id: the model plays the list of the stage it is asked about. */
export type FakeScript = readonly FakeStep[] | Readonly<Record<string, readonly FakeStep[]>>;

export interface FakeProvider extends Provider {
  /** Every request the loop made, for assertions. */
  calls: CompleteRequest[];
}

/** A 1x1 PNG, used for "$screenshot" when no picture has come back yet. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const lastImage = (messages: Msg[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) for (const p of messages[i]!.parts) {
    if (p.type === 'tool_result' && p.images?.length) return p.images[0]!.data;
    if (p.type === 'image') return p.data;
  }
  return undefined;
};

const pngSize = (b64: string): { width: number; height: number } => {
  const b = Buffer.from(b64.slice(0, 64), 'base64');
  return b.length >= 24 && b.readUInt32BE(12) === 0x49484452 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : { width: 1, height: 1 };
};

/**
 * Inside a step's tool input, "$screenshot" becomes a data URL of the newest picture a tool returned (a game screenshot) and
 * "$screenshot.width" / "$screenshot.height" its size, so a script can write a map from what the game really drew.
 */
function fill(v: unknown, png: string): unknown {
  if (v === '$screenshot') return `data:image/png;base64,${png}`;
  if (v === '$screenshot.width') return pngSize(png).width;
  if (v === '$screenshot.height') return pngSize(png).height;
  if (Array.isArray(v)) return v.map((x) => fill(x, png));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, png)]));
  return v;
}

const userText = (messages: Msg[]): string => {
  const users = messages.filter((m) => m.role === 'user').slice(-2);
  return users.flatMap((m) => m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.text : ''))).join('\n').toLowerCase();
};

/** Pieces of about `size` characters, cut after a space so words stay whole. */
export function pieces(text: string, size = 14): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let j = Math.min(text.length, i + size);
    while (j < text.length && text[j - 1] !== ' ' && j - i < size * 2) j++;
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * What HULL_AGENT_FAKE / --fake names: a JSON file (one script, used for every mode, as before), or a folder holding brief.json,
 * build.json and fix.json (one script per mode; a mode with no file is answered with how to set up a model).
 */
export function fakeFromPath(path: string): Provider | Partial<Record<AgentMode, Provider>> {
  const p = resolve(path);
  if (!statSync(p).isDirectory()) return fakeProvider(JSON.parse(readFileSync(p, 'utf8')) as FakeScript);
  const out: Partial<Record<AgentMode, Provider>> = {};
  for (const mode of ['brief', 'build', 'fix'] as const) {
    const f = join(p, mode + '.json');
    if (existsSync(f)) out[mode] = fakeProvider(JSON.parse(readFileSync(f, 'utf8')) as FakeScript);
  }
  return out;
}

export function fakeProvider(script: FakeScript, opts: { contextWindow?: number } = {}): FakeProvider {
  const keyed = !Array.isArray(script);
  const cursors = new Map<string, number>();
  let ids = 0;
  const calls: CompleteRequest[] = [];
  return {
    name: 'fake', model: 'scripted', contextWindow: opts.contextWindow ?? 200_000, calls,
    async complete(req): Promise<Completion> {
      calls.push(req);
      // A summary request (compaction) is answered on the side so it does not use up a step of the script.
      if (req.tools.length === 0 && req.system.includes('structured summaries')) return { text: '## Objective\n- (scripted summary)\n\n## Next Move\n1. (none)', toolCalls: [], stop: 'end', usage: { input: 10, output: 10 } };
      // A keyed script finds its list by the "Stage: <id>" line of the build prompt, and starts it again when a stage begins afresh.
      const key = keyed ? (/^Stage: (\w+)/m.exec(req.system)?.[1] ?? 'default') : 'default';
      const steps: readonly FakeStep[] = keyed ? ((script as Record<string, readonly FakeStep[]>)[key] ?? []) : (script as readonly FakeStep[]);
      if (keyed && req.messages.length === 1) cursors.set(key, 0);
      let i = cursors.get(key) ?? 0;
      const seen = userText(req.messages);
      while (steps[i]?.when !== undefined && !seen.includes(steps[i]!.when!.toLowerCase())) i++;
      const step = steps[i++] ?? { text: '(the script has ended)' };
      cursors.set(key, i);
      const png = lastImage(req.messages) ?? PIXEL;
      const toolCalls = (step.tools ?? []).map((t) => ({ id: `fake_${++ids}`, name: t.name.replace(/\./g, '_'), input: fill(t.input ?? {}, png) }));
      const text = step.text ?? '';
      if (text) for (const piece of pieces(text)) req.onDelta?.(piece);
      const chars = req.messages.reduce((n, m) => n + JSON.stringify(m.parts).length, req.system.length);
      return { text, toolCalls, stop: toolCalls.length ? 'tool_use' : 'end', usage: { input: Math.ceil(chars / 4), output: Math.ceil((text.length + JSON.stringify(toolCalls).length) / 4) } };
    },
  };
}
