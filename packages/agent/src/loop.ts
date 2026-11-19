// The agent loop for one conversation: model call, tools, repeat. Gates (see run()):
//  - writes happen only through Hull's validated edit tools; the destructive ones ask the person first;
//  - after edits the loop runs `check` itself, and the run cannot end while it fails, up to a bounded number of fixes;
//  - an edited run is recorded in the history as a checkpoint, under the author the tools were opened with.
import { compactIfNeeded } from './compaction.ts';
import type { HullTools } from './hullTools.ts';
import type { Msg, Part, Provider, ToolSpec, Usage } from './types.ts';

export interface PlanItem { content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'high' | 'medium' | 'low' }
export type ToolContent = { type: 'text'; text: string } | { type: 'diff'; path: string; oldText: string | null; newText: string };
export type Decision = 'allow_once' | 'allow_always' | 'reject' | 'cancelled';

/** What the loop tells its host (the ACP layer, or a test). */
export interface RunIo {
  text(t: string): void;
  plan(items: PlanItem[]): void;
  toolStart(c: { id: string; title: string; kind: string; input: unknown }): void;
  toolEnd(c: { id: string; ok: boolean; content: ToolContent[]; output: unknown }): void;
  permission(c: { id: string; title: string; kind: string; input: unknown; content: ToolContent[] }): Promise<Decision>;
  usage(u: { used: number; size: number; total: Usage }): void;
  compaction(status: 'in_progress' | 'completed' | 'failed', summary?: string, error?: string): void;
}

export type PermissionMode = 'risky' | 'writes' | 'none';

export interface SessionState {
  provider: Provider;
  tools: HullTools;
  system: string;
  history: Msg[];
  permissions: PermissionMode;
  /** Tools the person allowed for the rest of the session. */
  allowed: Set<string>;
  plan: PlanItem[];
  /** Fixes the loop allows after a failed check before it gives up. */
  maxFixRounds: number;
  maxSteps: number;
  runs: number;
}

export interface RunResult { stop: 'end_turn' | 'cancelled' | 'max_turn_requests'; checkFailed: boolean; wrote: boolean; usage: Usage; steps: number }

const PLAN_TOOL: ToolSpec = {
  name: 'update_plan',
  description: 'Show the person your plan as a checklist. Send the whole list each time; mark items in_progress and completed as you go.',
  schema: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { enum: ['pending', 'in_progress', 'completed'] }, priority: { enum: ['high', 'medium', 'low'] } }, required: ['content', 'status'] } } }, required: ['entries'] },
};

const CHECK_PROBLEM = (text: string): string => `The check failed. Fix these before you finish (the run cannot end while check fails):\n${text}`;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const titleOf = (name: string, input: unknown): string => {
  const i = asRecord(input);
  const key = i['id'] ?? i['block'] ?? i['key'] ?? i['name'] ?? i['path'];
  return key !== undefined ? `${name} ${String(key)}${i['pointer'] ? String(i['pointer']) : ''}` : name;
};

interface Snap { path: string; text: string }

/** Before-and-after text of a write, for the diff the person sees. Best effort: a failure here never blocks the write. */
async function snapshot(tools: HullTools, name: string, input: unknown): Promise<Snap | undefined> {
  try {
    const i = asRecord(input);
    if (name === 'config.set') {
      const r = await tools.call('config.read', { id: i['id'] });
      return r.ok ? { path: String(asRecord(r.value)['path'] ?? i['id']), text: String(asRecord(r.value)['text'] ?? '') } : undefined;
    }
    if (name === 'tunables.set') {
      const r = await tools.call('tunables.list', {});
      const hit = ((asRecord(r.value)['items'] ?? []) as Record<string, unknown>[]).find((t) => t['block'] === i['block'] && t['key'] === i['key']);
      return { path: `tunables:${String(i['block'])}`, text: `${String(i['key'])} = ${JSON.stringify(hit?.['value'])}` };
    }
  } catch { /* no diff */ }
  return undefined;
}

async function diffOf(tools: HullTools, name: string, input: unknown, before: Snap | undefined): Promise<ToolContent[]> {
  if (!before) return [];
  const after = await snapshot(tools, name, input);
  if (!after || after.text === before.text) return [];
  return [{ type: 'diff', path: before.path, oldText: before.text, newText: after.text }];
}

export async function run(s: SessionState, prompt: Msg['parts'], io: RunIo, signal: AbortSignal): Promise<RunResult> {
  const total: Usage = { input: 0, output: 0 };
  const result: RunResult = { stop: 'end_turn', checkFailed: false, wrote: false, usage: total, steps: 0 };
  const specs: ToolSpec[] = [...s.tools.specs, PLAN_TOOL];
  let dirty = false;
  let fixes = 0;
  let ids = 0;
  s.runs++;
  s.history.push({ role: 'user', parts: prompt });

  const finish = (stop: RunResult['stop']): RunResult => { result.stop = stop; return result; };

  /** Runs check as a visible step of its own, for the end-of-run gate. */
  const gateCheck = async (): Promise<{ ok: boolean; text: string }> => {
    const id = `gate_${s.runs}_${++ids}`;
    io.toolStart({ id, title: 'check (required after edits)', kind: 'execute', input: {} });
    const r = await s.tools.call('check', {});
    io.toolEnd({ id, ok: r.ok, content: [{ type: 'text', text: r.text }], output: r.value });
    return r;
  };

  while (true) {
    if (signal.aborted) return finish('cancelled');
    if (result.steps >= s.maxSteps) return finish('max_turn_requests');

    try {
      const summary = await compactIfNeeded({ provider: s.provider, system: s.system, messages: s.history, signal }, () => io.compaction('in_progress'));
      if (summary) io.compaction('completed', summary);
    } catch (e) {
      if (signal.aborted) return finish('cancelled');
      io.compaction('failed', undefined, e instanceof Error ? e.message : String(e));
    }

    let c;
    try {
      c = await s.provider.complete({ system: s.system, messages: s.history, tools: specs, signal });
    } catch (e) {
      if (signal.aborted) return finish('cancelled');
      throw e;
    }
    result.steps++;
    total.input += c.usage.input;
    total.output += c.usage.output;
    io.usage({ used: c.usage.input + c.usage.output, size: s.provider.contextWindow, total });
    if (c.text) io.text(c.text);

    const parts: Part[] = [];
    if (c.text) parts.push({ type: 'text', text: c.text });
    for (const t of c.toolCalls) parts.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
    if (parts.length) s.history.push({ role: 'assistant', parts });

    if (c.toolCalls.length === 0) {
      if (dirty) {
        // The gate: edits since the last passing check, so check now. The model may not end the run over a failing check.
        const r = await gateCheck();
        if (r.ok) { dirty = false; result.checkFailed = false; break; }
        result.checkFailed = true;
        if (fixes >= s.maxFixRounds) { io.text(`\nStopping: the check still fails after ${s.maxFixRounds} attempts to fix it. The changes are kept and the problems are above.`); break; }
        fixes++;
        s.history.push({ role: 'user', parts: [{ type: 'text', text: CHECK_PROBLEM(r.text) }] });
        continue;
      }
      break;
    }

    const results: Part[] = [];
    for (const call of c.toolCalls) {
      if (signal.aborted) { results.push({ type: 'tool_result', id: call.id, text: 'Cancelled by the person.', isError: true }); continue; }
      results.push(await execute(call));
    }
    s.history.push({ role: 'user', parts: results });
    if (signal.aborted) return finish('cancelled');
  }

  // Recorded: a named checkpoint marks where this run ended; the changes themselves carry the author already.
  if (result.wrote) {
    try { await s.tools.call('history.checkpoint', { name: `hull-agent-run-${s.runs}` }); } catch { /* the history keeps the changes either way */ }
  }
  return result;

  async function execute(call: { id: string; name: string; input: unknown }): Promise<Part> {
    const fail = (text: string): Part => ({ type: 'tool_result', id: call.id, text, isError: true });
    if (call.name === PLAN_TOOL.name) {
      const raw = asRecord(call.input)['entries'];
      const items: PlanItem[] = (Array.isArray(raw) ? raw : []).map((e) => { const r = asRecord(e); return { content: String(r['content'] ?? ''), status: (['pending', 'in_progress', 'completed'].includes(String(r['status'])) ? r['status'] : 'pending') as PlanItem['status'], priority: (['high', 'medium', 'low'].includes(String(r['priority'])) ? r['priority'] : 'medium') as PlanItem['priority'] }; }).filter((e) => e.content);
      s.plan = items;
      io.plan(items);
      return { type: 'tool_result', id: call.id, text: 'Plan shown.' };
    }
    const name = s.tools.hullName(call.name);
    if (!name) return fail(`unknown tool "${call.name}" (have: ${s.tools.specs.map((t) => t.name).join(', ')})`);
    const kind = s.tools.kind(name);
    const title = titleOf(name, call.input);
    io.toolStart({ id: call.id, title, kind, input: call.input });

    const write = s.tools.isWrite(name);
    const ask = write && !s.allowed.has(name) && (s.permissions === 'writes' || (s.permissions === 'risky' && s.tools.isRisky(name)));
    if (ask) {
      const d = await io.permission({ id: call.id, title, kind, input: call.input, content: [{ type: 'text', text: JSON.stringify(call.input, null, 2) }] });
      if (d === 'reject' || d === 'cancelled') {
        const text = d === 'cancelled' ? 'Cancelled by the person.' : 'The person denied this step. Do not retry it; continue another way or stop and say what you need.';
        io.toolEnd({ id: call.id, ok: false, content: [{ type: 'text', text }], output: null });
        return fail(text);
      }
      if (d === 'allow_always') s.allowed.add(name);
    }

    const before = write ? await snapshot(s.tools, name, call.input) : undefined;
    let r;
    try { r = await s.tools.call(name, call.input); } catch (e) {
      const text = `${name}: ${e instanceof Error ? e.message : String(e)}`;
      io.toolEnd({ id: call.id, ok: false, content: [{ type: 'text', text }], output: null });
      return fail(text);
    }
    if (write && r.ok) { result.wrote = true; dirty = true; }
    if (name === 'check' && r.ok) dirty = false;
    const content: ToolContent[] = write && r.ok ? await diffOf(s.tools, name, call.input, before) : [];
    content.push({ type: 'text', text: r.text.length > 4000 ? `${r.text.slice(0, 4000)}\n... (${r.text.length} characters)` : r.text });
    io.toolEnd({ id: call.id, ok: r.ok, content, output: r.value });
    return { type: 'tool_result', id: call.id, text: r.text, ...(r.images.length ? { images: r.images } : {}), isError: !r.ok };
  }
}
