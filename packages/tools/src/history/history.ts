// History and experiments for one project (PLAN section 5, ARCHITECTURE section 7). The main line is the project folder;
// each experiment is a branch with its own working copy under .hull/exp/<name>/. Every change is a commit made after a
// burst of edits goes quiet, with the author who made it and a plain-words description from the diff.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Problem } from 'hull';
import type { ChangeDelta, ExpAdoptResult, ExpInfo, HistoryAuthor, HistoryChange, MergeConflict } from 'hull/dev/protocol';
import { readJournal } from '../server/journal.ts';
import { applyDeltas, authorshipProblems, contribution, loadBook, saveBook, type Entries } from './authors.ts';
import { setJsonPointer, pointerSegments } from '../server/jsonEdit.ts';
import { diffFiles, isConfigPath, summarize, type FileMap } from './diff.ts';
import { patchLines, type PatchLine } from './lines.ts';
import { mergeFiles } from './merge.ts';
import { replayJournal } from './replay.ts';
import { atomicWrite, readTracked, Store, writeTracked, type CommitInfo } from './store.ts';

export interface ExpGames {
  /** Starts the experiment's own game page and returns its URL. */
  start(name: string, dir: string): Promise<string>;
  stop(name: string): Promise<void>;
  url(name: string): string | undefined;
}

export interface HistoryOptions {
  root: string;
  /** Quiet time after the last edit before a change is recorded. About 2 s; tests use 0. */
  quietMs?: number;
  log?: (line: string) => void;
  onAdded?: (change: HistoryChange) => void;
  onExp?: (name: string, change: 'started' | 'edited' | 'adopted' | 'discarded', info: ExpInfo) => void;
  games?: ExpGames;
}

interface ExpMeta { name: string; from: string; createdAt: string; by: HistoryAuthor; status: ExpInfo['status'] }

const MAIN = 'refs/heads/main';
const expRef = (name: string): string => `refs/heads/exp/${name}`;
const tagRef = (name: string): string => `refs/tags/cp/${encodeURIComponent(name).replace(/\./g, '%2E')}`;
const tagName = (ref: string): string => decodeURIComponent(ref.replace(/^cp\//, ''));
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/i;
const key = (p: Problem): string => `${p.file}|${p.pointer ?? ''}|${p.rule}|${p.message}`;

/** The field at `pointer` as it was in `before` (absent: removed), written into `now` with the formatting kept where it can be. */
function revertField(now: string, before: string | undefined, pointer: string): { ok: true; text: string } | { ok: false; message: string } {
  let old: unknown;
  try { old = before === undefined ? undefined : JSON.parse(before); } catch { return { ok: false, message: 'the old file did not parse' }; }
  const segs = pointerSegments(pointer);
  let v: unknown = old;
  for (const s of segs) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[s] : undefined;
  if (v !== undefined) return setJsonPointer(now, pointer, v);
  // The field did not exist then: take it out.
  let doc: unknown;
  try { doc = JSON.parse(now); } catch (e) { return { ok: false, message: (e as Error).message }; }
  let parent: unknown = doc;
  for (const s of segs.slice(0, -1)) parent = parent !== null && typeof parent === 'object' ? (parent as Record<string, unknown>)[s] : undefined;
  const last = segs[segs.length - 1];
  if (parent === null || typeof parent !== 'object' || last === undefined) return { ok: false, message: `there is nothing at ${pointer}` };
  if (Array.isArray(parent)) parent.splice(Number(last), 1); else delete (parent as Record<string, unknown>)[last];
  const indent = /^\t/m.test(now) ? '\t' : (/^( +)\S/m.exec(now)?.[1]?.length ?? 2);
  return { ok: true, text: `${JSON.stringify(doc, null, indent)}${now.endsWith('\n') ? '\n' : ''}` };
}

export class History {
  readonly store: Store;
  private authors: Entries = {};
  private exps: Record<string, ExpMeta> = {};
  private pending = new Map<string, { by: HistoryAuthor; timer: ReturnType<typeof setTimeout> }>();
  private quietMs: number;

  private constructor(private o: HistoryOptions) {
    this.store = new Store(o.root);
    this.quietMs = o.quietMs ?? 2000;
  }

  static async open(o: HistoryOptions): Promise<History> {
    const h = new History(o);
    await h.start();
    return h;
  }

  private get root(): string { return this.o.root; }
  private expDir = (name: string): string => join(this.root, '.hull', 'exp', name);
  private metaPath = (): string => join(this.root, '.hull', 'exp.json');
  private dirOf = (line: string): string => (line === 'main' ? this.root : this.expDir(line));
  private refOf = (line: string): string => (line === 'main' ? MAIN : expRef(line));

  private async start(): Promise<void> {
    this.ignoreHullFolder();
    try { this.exps = JSON.parse(readFileSync(this.metaPath(), 'utf8')) as Record<string, ExpMeta>; } catch { this.exps = {}; }
    if (!this.store.exists()) {
      await this.store.serial(async () => {
        await this.store.init();
        const n = await replayJournal(this.store, readTracked(this.root), readJournal(this.root, Number.MAX_SAFE_INTEGER));
        this.o.log?.(`history started${n ? ` with ${n} changes from the journal` : ''}`);
      });
    }
    // Edits made while Hull was not running are recorded as the disk's.
    await this.commitLine('main', 'disk');
    this.authors = await loadBook(this.root, this.store, await this.store.resolve(MAIN));
    for (const m of Object.values(this.exps)) {
      if (m.status !== 'active') continue;
      if (!existsSync(this.expDir(m.name))) { m.status = 'discarded'; continue; }
      try { await this.o.games?.start(m.name, this.expDir(m.name)); } catch (e) { this.o.log?.(`experiment ${m.name}: its page did not start: ${(e as Error).message}`); }
    }
    this.saveMeta();
  }

  /** `.hull/` belongs in the project's own .gitignore when it has one. */
  private ignoreHullFolder(): void {
    const p = join(this.root, '.gitignore');
    if (!existsSync(p)) return;
    const text = readFileSync(p, 'utf8');
    if (!/^\/?\.hull\/?\s*$/m.test(text)) appendFileSync(p, `${text.endsWith('\n') || text === '' ? '' : '\n'}.hull/\n`);
  }

  private saveMeta(): void {
    mkdirSync(join(this.root, '.hull'), { recursive: true });
    atomicWrite(this.metaPath(), `${JSON.stringify(this.exps, null, 2)}\n`, join(this.root, '.hull', 'tmp'));
  }

  // ---- Recording changes ---------------------------------------------------------------------------------------------

  /** Before a write by `by`: edits already waiting from someone else are recorded first, so each change has one author. */
  async settle(by: HistoryAuthor, line = 'main'): Promise<void> {
    const p = this.pending.get(line);
    if (p && p.by !== by) await this.flush(line);
  }

  /** Something in `line` changed on disk. The change is recorded when edits have been quiet for `quietMs`. */
  touch(by: HistoryAuthor, line = 'main'): void {
    const p = this.pending.get(line);
    // A disk event during a burst of server edits cannot be told apart from them; the burst keeps its author.
    const author = p ? (p.by === 'disk' ? by : p.by) : by;
    if (p) clearTimeout(p.timer);
    const timer = setTimeout(() => { this.pending.delete(line); void this.commitLine(line, author).catch((e) => this.o.log?.(`history: ${(e as Error).message}`)); }, this.quietMs);
    this.pending.set(line, { by: author, timer });
  }

  /** Records what is waiting now (one line, or all). */
  async flush(line?: string): Promise<void> {
    const lines = line ? [line] : [...this.pending.keys()];
    for (const l of lines) {
      const p = this.pending.get(l);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(l);
      await this.commitLine(l, p.by);
    }
    // Wait for anything already queued, too.
    await this.store.serial(async () => undefined);
  }

  private commitLine(line: string, by: HistoryAuthor): Promise<HistoryChange | undefined> {
    return this.store.serial(async () => {
      const files = readTracked(this.dirOf(line));
      const tip = await this.store.resolve(this.refOf(line));
      const deltas = diffFiles(tip ? await this.store.filesAt(tip) : new Map(), files);
      if (deltas.length === 0) return undefined;
      const id = await this.store.commit(this.refOf(line), files, { by, message: summarize(deltas), details: deltas.map((d) => d.text) });
      if (!id) return undefined;
      return this.recorded(id, line, deltas, () => by);
    });
  }

  private async recorded(id: string, line: string, deltas: ChangeDelta[], by: (d: ChangeDelta) => HistoryAuthor): Promise<HistoryChange> {
    const c = await this.store.commitOf(id);
    if (line === 'main') {
      applyDeltas(this.authors, deltas, by, c.at, id);
      saveBook(this.root, id, this.authors);
    }
    const change = this.toChange(c, line, await this.checkpointMap());
    this.o.onAdded?.(change);
    if (line !== 'main' && this.exps[line]) this.o.onExp?.(line, 'edited', await this.info(this.exps[line]!));
    return change;
  }

  // ---- Reading -------------------------------------------------------------------------------------------------------

  private async checkpointMap(): Promise<Map<string, string[]>> {
    const m = new Map<string, string[]>();
    for (const t of await this.store.tags()) (m.get(t.oid) ?? m.set(t.oid, []).get(t.oid)!).push(tagName(t.name));
    return m;
  }

  private toChange(c: CommitInfo, line: string, cps: Map<string, string[]>): HistoryChange {
    return { id: c.id, short: c.id.slice(0, 7), at: c.at, by: c.by, line, kind: c.kind, message: c.message, details: c.details, parents: c.parents, checkpoints: cps.get(c.id) ?? [] };
  }

  /** The timeline, newest first: the main line, then each experiment's own changes. */
  async list(o: { limit?: number; line?: string } = {}): Promise<HistoryChange[]> {
    await this.flush();
    const cps = await this.checkpointMap();
    const seen = new Set<string>();
    const rows: HistoryChange[] = [];
    const mainChain = await this.store.chainFrom(await this.store.resolve(MAIN));
    for (const c of mainChain) { seen.add(c.id); rows.push(this.toChange(c, 'main', cps)); }
    for (const m of Object.values(this.exps)) {
      for (const c of await this.store.chainFrom(await this.store.resolve(expRef(m.name)), seen)) rows.push(this.toChange(c, m.name, cps));
    }
    const ordered = rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.at < b.r.at ? 1 : a.r.at > b.r.at ? -1 : a.i - b.i)).map((x) => x.r);
    const filtered = o.line ? ordered.filter((r) => r.line === o.line) : ordered;
    return o.limit ? filtered.slice(0, o.limit) : filtered;
  }

  /** An id, a prefix, a checkpoint name, 'main' or an experiment's name, as a commit id. */
  async rev(spec: string): Promise<string> {
    const found = (await this.store.resolve(tagRef(spec))) ?? (spec === 'main' ? await this.store.resolve(MAIN) : undefined)
      ?? (this.exps[spec] ? await this.store.resolve(expRef(spec)) : undefined) ?? (await this.store.expand(spec));
    if (!found) throw new Error(`there is no change, checkpoint or experiment called "${spec}"`);
    return found;
  }

  async diff(o: { from?: string; to: string }): Promise<{ from: string | null; to: string; deltas: ChangeDelta[] }> {
    await this.flush();
    const to = await this.rev(o.to);
    const from = o.from ? await this.rev(o.from) : (await this.store.commitOf(to)).parents[0];
    const deltas = diffFiles(from ? await this.store.filesAt(from) : new Map(), await this.store.filesAt(to));
    return { from: from ?? null, to, deltas };
  }

  /** The line diff of one file between two states, for the Changes panel (code and other text). */
  async patch(o: { from?: string; to: string; file: string }): Promise<{ file: string; lines: PatchLine[]; binary: boolean }> {
    await this.flush();
    const to = await this.rev(o.to);
    const from = o.from ? await this.rev(o.from) : (await this.store.commitOf(to)).parents[0];
    const a = from ? (await this.store.filesAt(from)).get(o.file) : undefined;
    const b = (await this.store.filesAt(to)).get(o.file);
    if ((a && a.subarray(0, 4096).includes(0)) || (b && b.subarray(0, 4096).includes(0))) return { file: o.file, lines: [], binary: true };
    return { file: o.file, lines: patchLines(a?.toString('utf8') ?? '', b?.toString('utf8') ?? ''), binary: false };
  }

  /**
   * Puts one file (or, with `pointer`, one field of a config file) back as it was at `spec`. The same checks and the same
   * record as `restore`: it may not add a problem, and it is a new change with its author, so it can be undone.
   */
  async revert(spec: string, file: string, by: HistoryAuthor = 'you', pointer?: string): Promise<{ ok: boolean; problems: Problem[]; change?: HistoryChange }> {
    await this.flush('main');
    const target = await this.rev(spec);
    return this.store.serial(async () => {
      const then = (await this.store.filesAt(target)).get(file);
      const current = readTracked(this.root);
      const now = current.get(file);
      const next: FileMap = new Map(current);
      if (pointer === undefined || !isConfigPath(file)) {
        if (then) next.set(file, then); else next.delete(file);
      } else {
        if (!now) return { ok: false, problems: [{ file, rule: 'revert', message: 'the file is gone, so only the whole file can be put back' }] };
        const edited = revertField(now.toString('utf8'), then?.toString('utf8'), pointer);
        if (!edited.ok) return { ok: false, problems: [{ file, pointer, rule: 'revert', message: edited.message }] };
        next.set(file, Buffer.from(edited.text));
      }
      const problems = await this.newProblems(next, current);
      if (problems.length) return { ok: false, problems };
      const deltas = diffFiles(current, next);
      if (deltas.length === 0) return { ok: true, problems: [] };
      writeTracked(this.root, next);
      const id = await this.store.commit(MAIN, next, { by, kind: 'restore', message: `revert ${pointer === undefined ? file : `${file}${pointer}`}: ${summarize(deltas)}`, details: deltas.map((d) => d.text), force: true });
      return { ok: true, problems: [], change: await this.recorded(id!, 'main', deltas, () => by) };
    });
  }

  /** AI changes that overwrote a value you set. */
  async authorshipProblems(): Promise<Problem[]> {
    await this.flush('main');
    return authorshipProblems(this.authors);
  }

  // ---- Checkpoints and restore ---------------------------------------------------------------------------------------

  async checkpoint(name: string, id?: string): Promise<{ name: string; id: string }> {
    if (!name.trim()) throw new Error('a checkpoint needs a name');
    await this.flush();
    const at = id ? await this.rev(id) : await this.store.resolve(MAIN);
    if (!at) throw new Error('there is nothing to checkpoint yet');
    await this.store.serial(() => this.store.setRef(tagRef(name), at));
    return { name, id: at };
  }

  /** Problems the files would have that the current ones do not: a write may not add any. */
  private async newProblems(next: FileMap, current: FileMap): Promise<Problem[]> {
    const { createRegistry } = await import('hull');
    const load = (f: FileMap): Problem[] => createRegistry().load([...f].filter(([p]) => isConfigPath(p)).map(([path, d]) => ({ path, text: d.toString('utf8') }))).problems;
    const known = new Set(load(current).map(key));
    return load(next).filter((p) => !known.has(key(p)));
  }

  async restore(spec: string, by: HistoryAuthor = 'you'): Promise<{ ok: boolean; problems: Problem[]; change?: HistoryChange }> {
    await this.flush('main');
    const target = await this.rev(spec);
    return this.store.serial(async () => {
      const files = await this.store.filesAt(target);
      const current = readTracked(this.root);
      const problems = await this.newProblems(files, current);
      if (problems.length) return { ok: false, problems };
      const deltas = diffFiles(current, files);
      if (deltas.length === 0) return { ok: true, problems: [] };
      writeTracked(this.root, files);
      const label = (await this.checkpointMap()).get(target)?.[0] ?? target.slice(0, 7);
      const id = await this.store.commit(MAIN, files, { by, kind: 'restore', message: `restore ${label}: ${summarize(deltas)}`, details: deltas.map((d) => d.text), force: true });
      return { ok: true, problems: [], change: await this.recorded(id!, 'main', deltas, () => by) };
    });
  }

  // ---- Experiments ---------------------------------------------------------------------------------------------------

  private async info(m: ExpMeta): Promise<ExpInfo> {
    const tip = (await this.store.resolve(expRef(m.name))) ?? m.from;
    const changes = (await this.store.chainFrom(tip, new Set([m.from]))).length;
    const gameUrl = m.status === 'active' ? this.o.games?.url(m.name) : undefined;
    return { name: m.name, status: m.status, from: m.from, tip, changes, createdAt: m.createdAt, by: m.by, ...(gameUrl ? { gameUrl } : {}) };
  }

  expDirOf(name: string): string {
    const m = this.exps[name];
    if (!m || m.status !== 'active') throw new Error(`there is no active experiment called "${name}"`);
    return this.expDir(name);
  }

  async expStart(name: string, from?: string, by: HistoryAuthor = 'you'): Promise<ExpInfo> {
    if (!NAME.test(name)) throw new Error(`"${name}" is not a usable experiment name (letters, digits and dashes)`);
    if (this.exps[name] || name === 'main') throw new Error(`there is already an experiment called "${name}"`);
    await this.flush('main');
    const base = from ? await this.rev(from) : await this.store.resolve(MAIN);
    if (!base) throw new Error('there is nothing to start from yet');
    const dir = this.expDir(name);
    await this.store.serial(async () => {
      await this.store.setRef(expRef(name), base);
      mkdirSync(dir, { recursive: true });
      writeTracked(dir, await this.store.filesAt(base));
    });
    const meta: ExpMeta = { name, from: base, createdAt: new Date().toISOString(), by, status: 'active' };
    this.exps[name] = meta;
    this.saveMeta();
    await this.o.games?.start(name, dir);
    const info = await this.info(meta);
    this.o.onExp?.(name, 'started', info);
    return info;
  }

  async expList(): Promise<ExpInfo[]> {
    await this.flush();
    const out: ExpInfo[] = [];
    for (const m of Object.values(this.exps)) {
      if (m.status === 'active' && !this.o.games?.url(m.name) && existsSync(this.expDir(m.name))) await this.o.games?.start(m.name, this.expDir(m.name));
      out.push(await this.info(m));
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async expCompare(a: string, b: string): Promise<{ a: string; b: string; deltas: ChangeDelta[] }> {
    await this.flush();
    const files = async (line: string): Promise<FileMap> => this.store.filesAt(await this.rev(line));
    return { a, b, deltas: diffFiles(await files(a), await files(b)) };
  }

  async expAdopt(name: string, by: HistoryAuthor = 'you', resolve: Record<string, 'ours' | 'theirs'> = {}): Promise<ExpAdoptResult> {
    this.expDirOf(name);
    await this.flush();
    return this.store.serial(async () => {
      const ours = await this.store.resolve(MAIN);
      const theirs = await this.store.resolve(expRef(name));
      if (!ours || !theirs) throw new Error(`experiment "${name}" has no changes to adopt`);
      const base = (await this.store.mergeBase(ours, theirs)) ?? this.exps[name]!.from;
      const current = readTracked(this.root);
      const merged = mergeFiles(await this.store.filesAt(base), current, await this.store.filesAt(theirs), resolve);
      if (merged.conflicts.length) return { ok: false, conflicts: merged.conflicts as MergeConflict[], problems: [] };
      const problems = await this.newProblems(merged.files, current);
      if (problems.length) return { ok: false, conflicts: [], problems };
      const deltas = diffFiles(current, merged.files);
      writeTracked(this.root, merged.files);
      const id = await this.store.commit(MAIN, merged.files, {
        by, kind: 'merge', parents: [ours, theirs], force: true,
        message: `adopt ${name}: ${summarize(deltas)}`, details: deltas.map((d) => d.text),
      });
      const c = await this.store.commitOf(id!);
      const credit = await contribution(this.store, c);
      if (credit) applyDeltas(this.authors, credit.deltas, credit.by, c.at, c.id);
      saveBook(this.root, c.id, this.authors);
      const change = this.toChange(c, 'main', await this.checkpointMap());
      this.o.onAdded?.(change);
      await this.retire(name, 'adopted');
      return { ok: true, conflicts: [], problems: [], change };
    });
  }

  async expDiscard(name: string): Promise<{ ok: boolean }> {
    this.expDirOf(name);
    await this.flush(name);
    await this.store.serial(() => this.retire(name, 'discarded'));
    return { ok: true };
  }

  /** The working copy and its page go away; its changes stay in the timeline. */
  private async retire(name: string, status: 'adopted' | 'discarded'): Promise<void> {
    const m = this.exps[name]!;
    m.status = status;
    this.saveMeta();
    await this.o.games?.stop(name);
    rmSync(this.expDir(name), { recursive: true, force: true });
    this.o.onExp?.(name, status, await this.info(m));
  }

  async close(): Promise<void> {
    await this.flush();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
