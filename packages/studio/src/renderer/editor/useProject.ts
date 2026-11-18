// The editor's view of the project: everything it knows comes from protocol calls and pushes, nothing from disk.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Problem } from 'hull';
import type { Change, GameReport, LibraryItem, TunableWire } from 'hull/dev/protocol';
import type { RpcClient, Status } from '../lib/rpc.ts';

export interface LogLine {
  id: number;
  at: number;
  level: 'info' | 'warn' | 'error' | 'ok';
  source: string;
  message: string;
  /** A config id the line can open (problems name their file). */
  open?: string;
}

/** 'config/sound/sword/hit.json' -> 'sound/sword/hit'. Code files have no config id. */
export const idFromPath = (path: string): string | null => {
  const m = /^config\/(.+)\.json$/.exec(path);
  return m ? m[1]! : null;
};

export const problemPlace = (p: Problem): string =>
  p.line !== undefined ? `${p.file}:${p.line}${p.col !== undefined ? `:${p.col}` : ''}` : p.pointer ? `${p.file}#${p.pointer}` : p.file;

export interface ProjectState {
  status: Status;
  library: LibraryItem[] | null;
  libraryError: string | null;
  tunables: TunableWire[];
  journal: Change[];
  logs: LogLine[];
  report: GameReport | null;
  problems: Problem[];
  refreshLibrary(): void;
  setTunableLocal(block: string, key: string, value: unknown): void;
  log(level: LogLine['level'], message: string, source?: string, open?: string): void;
  clearLogs(): void;
}

export function useProject(rpc: RpcClient): ProjectState {
  const [status, setStatus] = useState<Status>(rpc.status);
  const [library, setLibrary] = useState<LibraryItem[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [tunables, setTunables] = useState<TunableWire[]>([]);
  const [journal, setJournal] = useState<Change[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [report, setReport] = useState<GameReport | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const nextLog = useRef(1);

  const log = useCallback((level: LogLine['level'], message: string, source = 'app', open?: string): void => {
    setLogs((l) => [...l.slice(-499), { id: nextLog.current++, at: Date.now(), level, source, message, ...(open ? { open } : {}) }]);
  }, []);

  const loadLibrary = useCallback(() => {
    rpc.call('library.list', {}).then((l) => { setLibrary(l); setLibraryError(null); }, (e: Error) => setLibraryError(e.message));
  }, [rpc]);
  const loadTunables = useCallback(() => {
    rpc.call('tunables.list', {}).then(setTunables, (e: Error) => log('error', `Could not read tunables: ${e.message}`, 'server'));
  }, [rpc, log]);

  // Debounced so a burst of file events is one refresh.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshLibrary = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(loadLibrary, 150);
  }, [loadLibrary]);

  useEffect(() => {
    const offs = [
      rpc.onStatus((s) => {
        setStatus(s);
        if (s === 'open') {
          loadLibrary();
          loadTunables();
          rpc.call('journal.list', { limit: 200 }).then(setJournal, () => {});
          // The server's problem state includes authorship problems; later changes arrive as `problems` pushes.
          rpc.call('problems.list', {}).then(setProblems, () => {});
        }
      }),
      rpc.on('log', (p) => log(p.level, p.message, p.source)),
      rpc.on('journal.added', (c) => setJournal((j) => [c, ...j].slice(0, 500))),
      rpc.on('game.report', (r) => setReport(r)),
      rpc.on('problems', (p) => { setProblems(p.problems); refreshLibrary(); }),
      rpc.on('config.changed', () => refreshLibrary()),
      rpc.on('config.removed', () => refreshLibrary()),
      rpc.on('source.changed', () => { loadTunables(); refreshLibrary(); }),
      rpc.on('tunable.changed', (t) => setTunables((list) => list.map((x) => (x.block === t.block && x.key === t.key ? { ...x, value: t.value } : x)))),
    ];
    if (rpc.status === 'open') {
      loadLibrary();
      loadTunables();
      rpc.call('journal.list', { limit: 200 }).then(setJournal, () => {});
    }
    return () => { offs.forEach((o) => o()); if (timer.current) clearTimeout(timer.current); };
  }, [rpc, loadLibrary, loadTunables, refreshLibrary, log]);

  const setTunableLocal = useCallback((block: string, key: string, value: unknown) => {
    setTunables((list) => list.map((x) => (x.block === block && x.key === key ? { ...x, value } : x)));
  }, []);

  return { status, library, libraryError, tunables, journal, logs, report, problems, refreshLibrary, setTunableLocal, log, clearLogs: () => setLogs([]) };
}
