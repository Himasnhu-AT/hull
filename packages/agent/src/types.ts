// The neutral message format between the loop and the model providers. A provider turns it into its own wire format.

export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; text: string; images?: { mime: string; data: string }[]; isError?: boolean };

export interface Msg { role: 'user' | 'assistant'; parts: Part[] }

export interface ToolSpec { name: string; description: string; schema: Record<string, unknown> }

export interface Usage { input: number; output: number }

export interface Completion {
  text: string;
  /** `cut`: the answer hit the output limit in the middle of this call, so its input is not whole. */
  toolCalls: { id: string; name: string; input: unknown; cut?: boolean }[];
  /** 'max_tokens' wins over 'tool_use': an answer that was cut is not a finished turn, even when it holds tool calls. */
  stop: 'end' | 'tool_use' | 'max_tokens';
  usage: Usage;
}

export interface CompleteRequest {
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
  /** Called with each piece of reply text as it arrives. A provider that cannot stream may ignore it; the loop then shows the whole text at the end. */
  onDelta?: (text: string) => void;
}

/** A model. A provider retries what is worth retrying (see providers.ts: 408, 409, 429, 5xx, a stream that breaks); the loop owns the run. */
export interface Provider {
  /** Shown to the person: 'anthropic' or the endpoint's host. */
  name: string;
  model: string;
  /** Tokens the model can hold; compaction starts at 70% of it. */
  contextWindow: number;
  /** Most tokens one answer may have (from the model table or HULL_AGENT_MAX_TOKENS). */
  maxOutput?: number;
  complete(req: CompleteRequest): Promise<Completion>;
}
