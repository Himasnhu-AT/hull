// The three modes of a run (docs/IDEA-TO-PLAY.md 4.5): which tools each one sees, and the conversation tools that sit next to
// update_plan. The conversation tools are interface, not project tools, so they live here and not in @hull/tools.
import type { AgentMode, UiBlock } from 'hull/dev/protocol';
import type { ToolSpec } from './types.ts';

export type { AgentMode, UiBlock };

export const UI_SHOW = 'ui_show';
export const UI_ASK = 'ui_ask';
export const UI_APPROVE = 'ui_approve';
/** What a person's own words in place of a choice come back as, so the model ends its turn. */
export const OWN_WORDS = '(the person will answer in their own words)';

const str = { type: 'string' };

export const UI_SHOW_TOOL: ToolSpec = {
  name: UI_SHOW,
  description: 'Show the person a card in the conversation, without waiting. block is {id, kind, ...}: kind "brief" {title, sections:[{id,title,text,status:"writing"|"done"|"changed"}]}, "stages" {stages}, "pieces" {stage, keys}, "explain" {doc}, or "change" {title, piece, lines:[{label,from,to}], change?}. Send a block again with the same id to update it in place.',
  schema: { type: 'object', properties: { block: { type: 'object', properties: { id: str, kind: { enum: ['brief', 'stages', 'pieces', 'explain', 'change'] } }, required: ['id', 'kind'], additionalProperties: true } }, required: ['block'] },
};

export const UI_ASK_TOOL: ToolSpec = {
  name: UI_ASK,
  description: `Ask the person a question with two to four short answers they click. Waits and returns the text of the answer they chose, or "${OWN_WORDS}" when they would rather type: then end your turn and wait for their next message.`,
  schema: { type: 'object', properties: { question: str, options: { type: 'array', items: str, minItems: 2, maxItems: 4 } }, required: ['question', 'options'] },
};

export const UI_APPROVE_TOOL: ToolSpec = {
  name: UI_APPROVE,
  description: `Ask the person to approve something before you go on. Waits and returns the text of "yes" or "no" they chose, or "${OWN_WORDS}": then end your turn and wait for their next message.`,
  schema: { type: 'object', properties: { question: str, detail: str, yes: str, no: str }, required: ['question', 'yes', 'no'] },
};

export const PLAN_TOOL: ToolSpec = {
  name: 'update_plan',
  description: 'Show the person your plan as a checklist. Send the whole list each time; mark items in_progress and completed as you go.',
  schema: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { enum: ['pending', 'in_progress', 'completed'] }, priority: { enum: ['high', 'medium', 'low'] } }, required: ['content', 'status'] } } }, required: ['entries'] },
};

/** Every tool the loop answers itself. */
export const CONVERSATION_TOOLS: readonly ToolSpec[] = [PLAN_TOOL, UI_SHOW_TOOL, UI_ASK_TOOL, UI_APPROVE_TOOL];

/** Hull tools (wire names) the brief mode may use: it reads, writes the brief and records progress. No code or config writes. */
const BRIEF_TOOLS = new Set(['brief_read', 'brief_write', 'docs_list', 'docs_read', 'project_info', 'library_list', 'create_get', 'create_set']);

/**
 * The tool list for a mode. brief: the few above plus ui_* and the plan. build: everything, but no questions, because the stage
 * runner works on its own and the person reviews the pieces afterwards. fix: everything.
 */
export function toolsFor(mode: AgentMode, hull: readonly ToolSpec[]): ToolSpec[] {
  if (mode === 'brief') return [...hull.filter((t) => BRIEF_TOOLS.has(t.name)), ...CONVERSATION_TOOLS];
  if (mode === 'build') return [...hull, PLAN_TOOL, UI_SHOW_TOOL];
  return [...hull, ...CONVERSATION_TOOLS];
}

const KINDS = new Set(['brief', 'stages', 'pieces', 'explain', 'change']);

/** Checks a block the model sent to ui_show enough that the app can draw it. Returns the block or why not. */
export function checkUiBlock(v: unknown): { ok: true; block: UiBlock } | { ok: false; reason: string } {
  const b = v as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return { ok: false, reason: 'block must be an object' };
  if (typeof b['id'] !== 'string' || !b['id']) return { ok: false, reason: 'block.id must be a non-empty string' };
  if (typeof b['kind'] !== 'string' || !KINDS.has(b['kind'])) return { ok: false, reason: `block.kind must be one of ${[...KINDS].join(', ')} (use ui_ask or ui_approve to wait for an answer)` };
  const need = (k: string, t: 'string' | 'array'): string | undefined => (t === 'array' ? (Array.isArray(b[k]) ? undefined : `block.${k} must be an array`) : typeof b[k] === 'string' ? undefined : `block.${k} must be a string`);
  const problem =
    b['kind'] === 'brief' ? (need('title', 'string') ?? need('sections', 'array'))
      : b['kind'] === 'stages' ? need('stages', 'array')
        : b['kind'] === 'pieces' ? (need('stage', 'string') ?? need('keys', 'array'))
          : b['kind'] === 'explain' ? (b['doc'] && typeof b['doc'] === 'object' ? undefined : 'block.doc must be an explain document')
            : (need('title', 'string') ?? need('piece', 'string') ?? need('lines', 'array'));
  return problem ? { ok: false, reason: problem } : { ok: true, block: b as unknown as UiBlock };
}
