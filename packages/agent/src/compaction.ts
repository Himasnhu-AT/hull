// Compaction: when the conversation grows toward the model's window, the older part is replaced by a structured summary
// and the recent part is kept as it is. The summary template, rules and update prompt are copied from OpenCode
// (packages/core/src/session/compaction.ts, MIT, Copyright (c) 2025 opencode); see NOTICES. Hull's version is the simple
// one: no background pre-summarising and no prompt-cache tricks.
import type { Msg, Part, Provider } from './types.ts';

const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`;

const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`;

export const buildPrompt = (update: boolean): string => {
  const shared = [
    'Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.',
    SUMMARY_TEMPLATE,
    SUMMARY_RULES,
    'Do not continue the task or call tools.',
    'Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.',
  ];
  if (!update) return ['You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.', ...shared].join('\n\n');
  return [
    'Update the existing checkpoint in the conversation above into one consolidated summary.',
    'Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to continuing the work, you may remove it.',
    'Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.',
    'Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.',
    ...shared,
  ].join('\n\n');
};

const CHECKPOINT = '<conversation-checkpoint>';
const NUDGE = 'The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template.';

const partSize = (p: Part): number => {
  switch (p.type) {
    case 'text': return p.text.length;
    case 'image': return 6000;
    case 'tool_use': return JSON.stringify(p.input).length + p.name.length;
    case 'tool_result': return p.text.length + (p.images?.length ?? 0) * 6000;
  }
};
/** About four characters to a token. A guess, but only the order of magnitude matters for when to compact. */
export const estimateTokens = (system: string, messages: readonly Msg[]): number =>
  Math.ceil((system.length + messages.reduce((n, m) => n + m.parts.reduce((k, p) => k + partSize(p), 0), 0)) / 4);

/** Where the kept tail may begin: a new request, or an assistant message (its tool results follow it, so no call is cut from its result). */
const isCut = (m: Msg): boolean => m.role === 'assistant' || (m.parts.some((p) => p.type === 'text') && !m.parts.some((p) => p.type === 'tool_result'));

/** Cuts long tool results in the older part of the conversation: the cheap first step, enough when one turn ran long. */
export function prune(messages: Msg[], keepLast = 6, cap = 600): void {
  for (let i = 0; i < messages.length - keepLast; i++) {
    for (const p of messages[i]!.parts) {
      if (p.type !== 'tool_result') continue;
      if (p.text.length > cap) p.text = `${p.text.slice(0, cap)}\n... (older result cut to save room)`;
      if (p.images?.length) delete p.images;
    }
  }
}

function transcript(messages: readonly Msg[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text') lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${p.text}`);
      else if (p.type === 'tool_use') lines.push(`Assistant called ${p.name} ${JSON.stringify(p.input).slice(0, 1500)}`);
      else if (p.type === 'tool_result') lines.push(`Tool result${p.isError ? ' (error)' : ''}: ${p.text.slice(0, 1500)}`);
    }
  }
  return lines.join('\n');
}

export interface CompactOptions {
  provider: Provider; system: string; messages: Msg[]; signal: AbortSignal; ratio?: number;
  /** Tokens the provider reported for this conversation (its last answer's input count, plus a guess for what came after). Used in place of the guess for all of it. */
  reportedTokens?: number;
}

/**
 * Compacts in place when the conversation is over `ratio` of the window. Returns the summary written, or undefined when
 * nothing was done. The last turns stay verbatim (at most 30% of the window); everything before them becomes the summary.
 */
export async function compactIfNeeded(o: CompactOptions, onStart?: () => void): Promise<string | undefined> {
  const limit = o.provider.contextWindow * (o.ratio ?? 0.7);
  const before = estimateTokens(o.system, o.messages);
  if ((o.reportedTokens ?? before) <= limit) return undefined;
  prune(o.messages);
  // What pruning saved comes off the reported count by the same guess that measured it.
  const after = estimateTokens(o.system, o.messages);
  if ((o.reportedTokens === undefined ? after : o.reportedTokens - (before - after)) <= limit) return undefined;

  const starts = o.messages.map((m, i) => (isCut(m) ? i : -1)).filter((i) => i > 0);
  // The oldest turn start whose tail fits in 30% of the window; with none, split at the last one.
  const tailBudget = o.provider.contextWindow * 0.3;
  const cut = starts.find((i) => estimateTokens('', o.messages.slice(i)) <= tailBudget) ?? starts[starts.length - 1];
  if (cut === undefined) return undefined;
  const head = o.messages.slice(0, cut);
  const previous = head[0]?.parts[0]?.type === 'text' && (head[0].parts[0] as { text: string }).text.startsWith(CHECKPOINT);
  onStart?.();

  const ask = (extra?: string): Promise<string> =>
    o.provider.complete({
      system: 'You write structured summaries of working sessions so another agent can resume the work.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: `${transcript(head)}\n\n---\n\n${buildPrompt(Boolean(previous))}${extra ? `\n\n${extra}` : ''}` }] }],
      tools: [], signal: o.signal,
    }).then((c) => c.text.trim());
  let summary = await ask();
  if (!summary.includes('## Objective')) summary = await ask(NUDGE);
  if (!summary) throw new Error('the model returned an empty summary');

  const note: Msg = { role: 'user', parts: [{ type: 'text', text: `${CHECKPOINT}\n<summary>\n${summary}\n</summary>\n</conversation-checkpoint>\nThe run so far is summarized above; the most recent messages follow unchanged. Continue from there.` }] };
  o.messages.splice(0, cut, note);
  return summary;
}
