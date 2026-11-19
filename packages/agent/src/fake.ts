// A scripted model for tests and for trying the panel with no network: each call to complete() plays the next step.
import type { Completion, CompleteRequest, Provider } from './types.ts';

export interface FakeStep {
  text?: string;
  /** Tool calls, by Hull tool name (dots allowed). */
  tools?: { name: string; input?: unknown }[];
}

export interface FakeProvider extends Provider {
  /** Every request the loop made, for assertions. */
  calls: CompleteRequest[];
}

export function fakeProvider(script: readonly FakeStep[], opts: { contextWindow?: number } = {}): FakeProvider {
  let i = 0;
  let ids = 0;
  const calls: CompleteRequest[] = [];
  return {
    name: 'fake', model: 'scripted', contextWindow: opts.contextWindow ?? 200_000, calls,
    async complete(req): Promise<Completion> {
      calls.push(req);
      // A summary request (compaction) is answered on the side so it does not use up a step of the script.
      if (req.tools.length === 0 && req.system.includes('structured summaries')) return { text: '## Objective\n- (scripted summary)\n\n## Next Move\n1. (none)', toolCalls: [], stop: 'end', usage: { input: 10, output: 10 } };
      const step = script[i++] ?? { text: '(the script has ended)' };
      const toolCalls = (step.tools ?? []).map((t) => ({ id: `fake_${++ids}`, name: t.name.replace(/\./g, '_'), input: t.input ?? {} }));
      const text = step.text ?? '';
      const chars = req.messages.reduce((n, m) => n + JSON.stringify(m.parts).length, req.system.length);
      return { text, toolCalls, stop: toolCalls.length ? 'tool_use' : 'end', usage: { input: Math.ceil(chars / 4), output: Math.ceil((text.length + JSON.stringify(toolCalls).length) / 4) } };
    },
  };
}
