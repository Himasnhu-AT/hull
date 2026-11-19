// Build the game: the one place that runs the build tool and reads its answer. The editor's Build button and the Share
// screen both use it, so they say the same thing about the same build.

import { useCallback, useRef, useState } from 'react';
import type { Problem } from 'hull';
import type { RpcClient } from '../lib/rpc.ts';

export interface BuiltFile { path: string; bytes: number; gzip?: number }

export type BuildResult =
  | { ok: true; dir: string; files: BuiltFile[]; total: number }
  | { ok: false; problems: Problem[]; error?: string };

export const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`);

/** Where a problem is, as the rules of the code ask: file:line:col for code, file#/pointer for config. */
export const placeOf = (pr: Problem): string => `${pr.file}${pr.line ? `:${pr.line}${pr.col ? `:${pr.col}` : ''}` : pr.pointer ? `#${pr.pointer}` : ''}`;

export async function runBuildTool(rpc: RpcClient, root: string): Promise<BuildResult> {
  try {
    const r = await rpc.call('tool.call', { name: 'build' }, { timeoutMs: 600_000 });
    const out = (r.output ?? {}) as { outDir?: string; files?: BuiltFile[] };
    if (!r.ok) return { ok: false, problems: r.problems };
    const files = out.files ?? [];
    return { ok: true, dir: out.outDir ?? `${root}/dist`, files, total: files.reduce((n, f) => n + f.bytes, 0) };
  } catch (e) {
    return { ok: false, problems: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export interface BuildHook { state: 'idle' | 'running'; run(): Promise<BuildResult | null> }

/** One build at a time: a second call while one runs does nothing and resolves null. */
export function useBuild(rpc: RpcClient, root: string): BuildHook {
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const busy = useRef(false);
  const run = useCallback(async (): Promise<BuildResult | null> => {
    if (busy.current) return null;
    busy.current = true; setState('running');
    try { return await runBuildTool(rpc, root); } finally { busy.current = false; setState('idle'); }
  }, [rpc, root]);
  return { state, run };
}
