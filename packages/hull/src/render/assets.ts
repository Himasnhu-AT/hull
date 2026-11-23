// The project's binary files (models, textures) as the page sees them. In dev the project server serves assets/ from
// the project root, so each file has a URL; in a build every file is inlined into game.js as a data: URL (the build's
// assetsInlineLimit is unlimited), so a game never reads the disk and one file still runs everywhere. Games name a
// file by its path inside assets/ ('models/crate.glb'). Tests and tools may add files by hand with registerAsset.
// Vite turns the import.meta.glob call below into a table when it bundles this file; under plain Node (the Studio's
// main process, a tool run) there is no such call and the table is empty.

function bundledTable(): Record<string, string> {
  try {
    // @ts-ignore import.meta.glob exists only under Vite; the type is absent when this file is checked in a game.
    return import.meta.glob('/assets/**/*.{glb,gltf,bin,png,jpg,jpeg,webp,ktx2}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
  } catch {
    return {};
  }
}

const sources = new Map<string, string | ArrayBuffer>();
for (const [path, url] of Object.entries(bundledTable())) sources.set(clean(path), url);

/** 'models/crate.glb' from '/assets/models/crate.glb', 'assets/models/crate.glb' or './models/crate.glb'. */
export function clean(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.?\/)+/, '').replace(/^assets\//, '');
}

/** Adds (or replaces) a file: bytes, or a URL to fetch them from. For tests, tools and a Studio that streams a file in. */
export function registerAsset(path: string, data: ArrayBuffer | Uint8Array | string): void {
  let value: string | ArrayBuffer;
  if (typeof data === 'string') value = data;
  else if (data instanceof ArrayBuffer) value = data;
  else value = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  sources.set(clean(path), value);
}

export function hasAsset(path: string): boolean {
  return sources.has(clean(path));
}

/** The files the page has, by path inside assets/. */
export function assetNames(): string[] {
  return [...sources.keys()].sort();
}

/** The URL a loader may fetch, or undefined (a file added as bytes has none). */
export function assetUrl(path: string): string | undefined {
  const s = sources.get(clean(path));
  return typeof s === 'string' ? s : undefined;
}

/** The file's bytes. Rejects with a sentence that names the path and lists what assets/ holds. */
export async function readAsset(path: string): Promise<ArrayBuffer> {
  const key = clean(path);
  const s = sources.get(key);
  if (s === undefined) {
    const have = assetNames();
    throw new Error(`assets/${key} does not exist${have.length ? ` (assets/ holds: ${have.slice(0, 8).join(', ')}${have.length > 8 ? ', ...' : ''})` : ' (assets/ has no model or texture files)'}`);
  }
  if (typeof s !== 'string') return s;
  const res = await fetch(s);
  if (!res.ok) throw new Error(`assets/${key} could not be fetched (${res.status})`);
  return res.arrayBuffer();
}
