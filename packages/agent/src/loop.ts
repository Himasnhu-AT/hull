// The agent loop for one conversation: model call, tools, repeat. Gates (see run()):
//  - writes happen only through Hull's validated edit tools; the destructive ones ask the person first;
//  - after edits the loop runs `check` itself, and the run cannot end while it fails, up to a bounded number of fixes;
//  - an edited run is recorded in the history as a checkpoint, under the author the tools were opened with.
import { changeCard } from './changeCard.ts';
import { configKinds, historyHead } from './changes.ts';
import { compactIfNeeded, estimateTokens } from './compaction.ts';
import type { HullTools } from './hullTools.ts';
import { checkUiBlock, OWN_WORDS, PLAN_TOOL, toolsFor, UI_APPROVE, UI_ASK, UI_SHOW, type AgentMode, type UiBlock } from './modes.ts';
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
  /** A card that does not wait (brief, stages, pieces, explain, change); sent again with the same id it replaces itself. */
  ui(block: UiBlock): void;
  /** A card that waits (ask, approve). Resolves to the text of the chosen option, or undefined when the person answers in their own words. */
  ask(block: Extract<UiBlock, { kind: 'ask' | 'approve' }>): Promise<string | undefined>;
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
  /** What kind of run this is: it picks the tool list. Default 'fix'. */
  mode: AgentMode;
  /** Counts the cards that wait, for their ids. */
  uiCount: number;
  /** Model calls to wait before compaction is tried again after it failed, so one failure is not paid for on every step. */
  compactSkip?: number;
}

export interface RunResult {
  stop: 'end_turn' | 'cancelled' | 'max_turn_requests' | 'refusal';
  /** With stop 'refusal': what the model said about why. */
  refusal?: string;
  checkFailed: boolean;
  /** The game changed (config, tunables, code, assets). The brief, explain documents and the flow state do not count. */
  wrote: boolean;
  usage: Usage;
  steps: number;
  /** The person chose to answer in their own words: the turn ended early and their next message is the answer. */
  ownWords: boolean;
  /** What the model said last. */
  text: string;
}

/** How many answers in a row may be cut at the output limit before the run stops asking the model to go on. */
const MAX_CUTS = 4;
/** Model calls skipped after a failed compaction. */
const COMPACT_RETRY_AFTER = 5;
const CONTINUE = 'Your last answer was cut off at the output limit. Continue exactly where it stopped, without repeating what you already wrote.';
const CUT_CALL = (name: string): string => `${name}: your answer hit the output limit in the middle of this call, so it was cut and not run. Write the file in smaller parts: code_write a short first part (under about 150 lines), then add the rest with code_edit, one piece at a time.`;

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
    if (name === 'code.edit' || name === 'code.write') {
      const r = await tools.call('code.read', { path: i['path'] });
      return { path: String(i['path']), text: r.ok ? String(asRecord(r.value)['text'] ?? '') : '' };
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
  const result: RunResult = { stop: 'end_turn', checkFailed: false, wrote: false, usage: total, steps: 0, ownWords: false, text: '' };
  const specs: ToolSpec[] = toolsFor(s.mode, s.tools.specs);
  const allowed = new Set(specs.map((t) => t.name));
  const kinds = s.mode === 'fix' ? await configKinds(s.tools).catch(() => new Set<string>()) : new Set<string>();
  const base = s.mode === 'fix' ? await historyHead(s.tools).catch(() => undefined) : undefined;
  let spoke = false;
  let cuts = 0;
  /** What the provider said the history held at its last call, and how long the history was then. */
  let reported: { tokens: number; at: number } | undefined;
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

    if (s.compactSkip && s.compactSkip > 0) s.compactSkip--;
    else {
      try {
        // The provider's own count of the history at the last call, plus a guess for what was added since, beats a guess for all of it.
        const reportedTokens = reported ? reported.tokens + estimateTokens('', s.history.slice(reported.at)) : undefined;
        const summary = await compactIfNeeded({ provider: s.provider, system: s.system, messages: s.history, signal, ...(reportedTokens ? { reportedTokens } : {}) }, () => io.compaction('in_progress'));
        if (summary) { io.compaction('completed', summary); reported = undefined; }
      } catch (e) {
        if (signal.aborted) return finish('cancelled');
        s.compactSkip = COMPACT_RETRY_AFTER;
        io.compaction('failed', undefined, e instanceof Error ? e.message : String(e));
      }
    }

    let c;
    let streamed = false;
    const sentAt = s.history.length;
    try {
      // Text goes out as it arrives; a model call after the first starts a new paragraph.
      c = await s.provider.complete({
        system: s.system, messages: s.history, tools: specs, signal, mode: s.mode,
        onDelta: (t) => { io.text(!streamed && spoke ? '\n\n' + t : t); streamed = true; spoke = true; },
      });
    } catch (e) {
      if (signal.aborted) return finish('cancelled');
      throw e;
    }
    result.steps++;
    reported = c.usage.input > 0 ? { tokens: c.usage.input, at: sentAt } : undefined;
    total.input += c.usage.input;
    total.output += c.usage.output;
    io.usage({ used: c.usage.input + c.usage.output, size: s.provider.contextWindow, total });
    if (c.text) {
      if (!streamed) { io.text(spoke ? '\n\n' + c.text : c.text); spoke = true; }
      result.text = c.text;
    }

    // The provider's own list keeps thinking blocks where they were; without one, text then tool calls.
    const parts: Part[] = c.parts ? [...c.parts] : [];
    if (!c.parts) {
      if (c.text) parts.push({ type: 'text', text: c.text });
      for (const t of c.toolCalls) parts.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
    }

    // The model declined. That is not a finished turn and not work: no check gate, no retry, and the person is told plainly.
    if (c.stop === 'refusal') {
      const kept = parts.filter((p) => p.type !== 'tool_use' && p.type !== 'thinking');
      if (kept.length) s.history.push({ role: 'assistant', parts: kept });
      const why = [c.refusal?.category ? `category: ${c.refusal.category}` : '', c.refusal?.explanation ?? ''].filter(Boolean).join('. ');
      result.refusal = `The model declined to continue with this request${why ? ` (${why})` : ''}. The turn ended there. Ask for it another way, or for something else.`;
      io.text((spoke ? '\n\n' : '') + result.refusal);
      return finish('refusal');
    }
    if (parts.length) s.history.push({ role: 'assistant', parts });

    // An answer cut at the output limit is not the end of the turn, whatever it holds.
    const cutOff = c.stop === 'max_tokens';
    cuts = cutOff ? cuts + 1 : 0;
    if (cutOff && cuts > MAX_CUTS) { io.text(`\nStopping: the answer was cut at the output limit ${MAX_CUTS} times in a row. Ask for a smaller step, or raise HULL_AGENT_MAX_TOKENS.`); break; }

    if (c.toolCalls.length === 0) {
      if (cutOff) {
        if (!parts.length) s.history.push({ role: 'assistant', parts: [{ type: 'text', text: '(no answer)' }] });
        s.history.push({ role: 'user', parts: [{ type: 'text', text: CONTINUE }] });
        continue;
      }
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

    // Calls that only read run side by side; a write, a game step or a question to the person waits for the calls before it.
    const results: Part[] = [];
    const calls = c.toolCalls;
    const readOnly = (call: (typeof calls)[number]): boolean => {
      const n = allowed.has(call.name) && !call.cut ? s.tools.hullName(call.name) : undefined;
      return n !== undefined && s.tools.isReadOnly(n);
    };
    for (let i = 0; i < calls.length;) {
      if (signal.aborted) { results.push({ type: 'tool_result', id: calls[i]!.id, text: 'Cancelled by the person.', isError: true }); i++; continue; }
      let j = i + 1;
      if (readOnly(calls[i]!)) {
        while (j < calls.length && readOnly(calls[j]!)) j++;
        results.push(...await Promise.all(calls.slice(i, j).map(execute)));
      } else results.push(await execute(calls[i]!));
      i = j;
    }
    s.history.push({ role: 'user', parts: results });
    if (signal.aborted) return finish('cancelled');
    // The person would rather type: stop here and let their next message be the answer.
    if (result.ownWords) break;
  }

  // Recorded: a named checkpoint marks where this run ended; the changes themselves carry the author already.
  if (result.wrote) {
    try { await s.tools.call('history.checkpoint', { name: `hull-agent-run-${s.runs}` }); } catch { /* the history keeps the changes either way */ }
    // A fix ends with a card saying what changed, with the id of the newest change so the person can keep it or put it back.
    if (s.mode === 'fix') {
      try { const card = await changeCard(s.tools, base, kinds, result.text, s.runs); if (card) io.ui(card); } catch { /* the card is a courtesy */ }
    }
  }
  return result;

  async function execute(call: { id: string; name: string; input: unknown; cut?: boolean }): Promise<Part> {
    const fail = (text: string): Part => ({ type: 'tool_result', id: call.id, text, isError: true });
    if (call.cut) {
      const text = CUT_CALL(call.name);
      io.toolStart({ id: call.id, title: call.name, kind: 'other', input: call.input });
      io.toolEnd({ id: call.id, ok: false, content: [{ type: 'text', text }], output: null });
      return fail(text);
    }
    if (!allowed.has(call.name)) return fail(`${call.name} is not available in ${s.mode} mode (have: ${[...allowed].join(', ')})`);
    if (call.name === UI_SHOW) {
      const c = checkUiBlock(asRecord(call.input)['block']);
      if (!c.ok) return fail(`ui_show: ${c.reason}`);
      io.ui(c.block);
      return { type: 'tool_result', id: call.id, text: 'Shown.' };
    }
    if (call.name === UI_ASK || call.name === UI_APPROVE) {
      const i = asRecord(call.input);
      const question = String(i['question'] ?? '').trim();
      if (!question) return fail(`${call.name}: question is required`);
      const id = 'ask-' + ++s.uiCount;
      let block: Extract<UiBlock, { kind: 'ask' | 'approve' }>;
      if (call.name === UI_ASK) {
        const options = (Array.isArray(i['options']) ? i['options'] : []).map(String).filter(Boolean);
        if (options.length < 2) return fail('ui_ask: give at least two options');
        block = { id, kind: 'ask', question, options };
      } else {
        const yes = String(i['yes'] ?? '').trim();
        const no = String(i['no'] ?? '').trim();
        if (!yes || !no) return fail('ui_approve: yes and no are required');
        block = { id, kind: 'approve', question, yes, no, ...(i['detail'] ? { detail: String(i['detail']) } : {}) };
      }
      const answer = await io.ask(block);
      if (answer === undefined) {
        if (!signal.aborted) result.ownWords = true;
        return { type: 'tool_result', id: call.id, text: OWN_WORDS };
      }
      io.ui(block.kind === 'ask' ? { ...block, answer } : { ...block, answer: answer === block.yes ? 'yes' : 'no' });
      return { type: 'tool_result', id: call.id, text: answer };
    }
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
    const game = s.tools.changesGame(name);
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
    // A code write with type problems is kept (ok is false), so the check gate must still run.
    const kept = r.ok || asRecord(r.value)['written'] === true;
    if (game && kept) { result.wrote = true; dirty = true; }
    if (name === 'check' && r.ok) dirty = false;
    const content: ToolContent[] = write && kept ? await diffOf(s.tools, name, call.input, before) : [];
    content.push({ type: 'text', text: r.text.length > 4000 ? `${r.text.slice(0, 4000)}\n... (${r.text.length} characters)` : r.text });
    io.toolEnd({ id: call.id, ok: r.ok, content, output: r.value });
    return { type: 'tool_result', id: call.id, text: r.text, ...(r.images.length ? { images: r.images } : {}), isError: !r.ok };
  }
}
