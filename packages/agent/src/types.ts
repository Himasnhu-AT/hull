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
  toolCalls: { id: string; name: string; input: unknown }[];
  stop: 'end' | 'tool_use' | 'max_tokens';
  usage: Usage;
}

export interface CompleteRequest {
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

/** A model. Providers do no retries of their own beyond one for a rate limit; the loop owns the run. */
export interface Provider {
  /** Shown to the person: 'anthropic' or the endpoint's host. */
  name: string;
  model: string;
  /** Tokens the model can hold; compaction starts at 70% of it. */
  contextWindow: number;
  complete(req: CompleteRequest): Promise<Completion>;
}
