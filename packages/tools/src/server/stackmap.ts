// Turns a browser stack into project places. The game page runs Vite's transformed JavaScript, so its stack points at lines
// of that output; Vite puts an inline source map on every module it serves, and node:module can read one without a
// dependency. The result names the original TypeScript: "src/player.ts:40:5".
import { SourceMap } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';

export interface MappedFrame {
  /** Project-relative ('src/player.ts'), engine-relative ('packages/hull/src/core/world.ts') or the URL path when no map was found. */
  file: string;
  line: number;
  col: number;
  fn?: string;
  /** The frame as one line: 'Player.fixedUpdate (src/player.ts:40:5)'. */
  text: string;
  /** True for a file of the project itself (src/ or config/), as against the engine or a library. */
  project: boolean;
}

export interface MappedStack {
  frames: MappedFrame[];
  /** The place to name: the first frame inside the project, else the first frame. */
  place?: MappedFrame;
}

export interface StackMapper {
  map(raw: string | undefined, maxFrames?: number): Promise<MappedStack>;
}

const FRAME = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?\s*$/;
const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/;
const MAX_CACHE = 300;

/**
 * `origin` is where the project's Vite server answers (the game URL's origin); frames are fetched from there whatever host
 * the page itself used. `root` is the project folder, so a source path under it comes back relative.
 */
export function createStackMapper(o: { root: string; origin: () => string; fetchText?: (url: string) => Promise<string | undefined> }): StackMapper {
  const root = resolve(o.root);
  const fetchText = o.fetchText ?? (async (url: string): Promise<string | undefined> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return res.ok ? await res.text() : undefined;
    } catch { return undefined; }
  });
  // A URL carries Vite's ?t=<time> after a hot update, so a changed file is a new key and an old map is never reused for it.
  const maps = new Map<string, Promise<SourceMap | undefined>>();
  const mapFor = (url: string): Promise<SourceMap | undefined> => {
    let p = maps.get(url);
    if (!p) {
      p = (async () => {
        const text = await fetchText(url);
        const m = text ? INLINE_MAP.exec(text) : null;
        if (!m) return undefined;
        try { return new SourceMap(JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8'))); } catch { return undefined; }
      })();
      maps.set(url, p);
      if (maps.size > MAX_CACHE) maps.delete(maps.keys().next().value as string);
    }
    return p;
  };

  /** `dir` is the folder of the module the source map belongs to, absolute: a relative source is relative to it. */
  const nameOf = (source: string, dir: string, urlPath: string): { file: string; project: boolean } => {
    let abs = source.startsWith('file://') ? decodeURIComponent(new URL(source).pathname) : source;
    // Vite writes the source as its bare file name, relative to the module it came from: 'player.ts' for /src/player.ts.
    if (!abs.startsWith('/')) abs = resolve(dir, abs);
    const rel = relative(root, abs).split(sep).join('/');
    if (!rel.startsWith('..')) return { file: rel, project: rel.startsWith('src/') || rel.startsWith('config/') };
    const engine = /\/(packages\/[^/]+\/src\/.*)$/.exec(abs);
    if (engine) return { file: engine[1]!, project: false };
    return { file: abs.includes('/node_modules/') ? abs.slice(abs.lastIndexOf('/node_modules/') + 1) : urlPath, project: false };
  };

  const mapFrame = async (line: string): Promise<MappedFrame | undefined> => {
    const m = FRAME.exec(line);
    if (!m) return undefined;
    const fn = m[1] && m[1] !== '<anonymous>' ? m[1] : undefined;
    const rawUrl = m[2]!;
    let line1 = Number(m[3]), col1 = Number(m[4]);
    let url: URL;
    try { url = new URL(rawUrl); } catch { return undefined; }
    const pathname = decodeURIComponent(url.pathname);
    // /@fs/<absolute path> is a file outside the project root (the engine); anything else is under the root.
    const fsPath = pathname.startsWith('/@fs/') ? pathname.slice(4) : undefined;
    const urlPath = fsPath ?? pathname.replace(/^\//, '');
    const dir = fsPath ? dirname(fsPath) : resolve(root, dirname(urlPath));
    let file = urlPath;
    let project = urlPath.startsWith('src/');
    const sm = await mapFor(new URL(url.pathname + url.search, o.origin()).href);
    const hit = sm?.findEntry(line1 - 1, col1 - 1) as { originalSource?: string; originalLine?: number; originalColumn?: number } | undefined;
    if (hit && typeof hit.originalSource === 'string' && typeof hit.originalLine === 'number') {
      ({ file, project } = nameOf(hit.originalSource, dir, urlPath));
      line1 = hit.originalLine + 1;
      col1 = (hit.originalColumn ?? 0) + 1;
    } else if (fsPath) {
      ({ file, project } = nameOf(fsPath, dir, urlPath));
    }
    const where = `${file}:${line1}:${col1}`;
    return { file, line: line1, col: col1, ...(fn ? { fn } : {}), text: fn ? `${fn} (${where})` : where, project };
  };

  return {
    async map(raw, maxFrames = 6) {
      const lines = (raw ?? '').split('\n').filter((l) => /^\s*at /.test(l));
      const frames: MappedFrame[] = [];
      for (const l of lines) {
        const f = await mapFrame(l);
        if (f) frames.push(f);
        else if (l.trim()) frames.push({ file: '', line: 0, col: 0, text: l.trim().replace(/^at /, ''), project: false });
      }
      // Everything from the dev runtime down is the control port's own plumbing, not the game's story.
      const cut = frames.findIndex((f) => f.file.endsWith('/dev/runtime.ts'));
      if (cut >= 0) frames.length = cut;
      const real = frames.filter((f) => f.file !== '');
      const place = real.find((f) => f.project) ?? real[0];
      return { frames: frames.slice(0, maxFrames), ...(place ? { place } : {}) };
    },
  };
}
