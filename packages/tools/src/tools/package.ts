// `package`: the game becomes a desktop app. It builds dist/web, puts it and shell/electron into a copy of the Electron
// runtime and renames that into the game's app. No packager is needed: an Electron app is the runtime plus an `app`
// folder in its resources. It builds for the OS it runs on; the other two need that OS's Electron runtime.
// electron-builder (installers, icons, signing with a real identity) can replace this later behind the same tool.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Problem } from 'hull';
import { buildProject } from '../server/build.ts';
import { defineTool } from '../tool.ts';
import { check } from './check.ts';

export type Target = 'mac' | 'win' | 'linux';
const TARGETS: readonly Target[] = ['mac', 'win', 'linux'];

export interface PackageInput {
  targets?: Target[];
  skipCheck?: boolean;
  /** Launch the app once, let it draw the first frames, and save a screenshot to prove it runs. */
  smoke?: boolean;
  /** The folder of an unpacked Electron runtime (contains Electron.app, or electron.exe, or electron). */
  electronDist?: string;
}

export interface PackageOutput {
  ok: boolean;
  problems: Problem[];
  artifacts?: { target: Target; path: string; bytes: number }[];
  skipped?: { target: Target; reason: string }[];
  smoke?: { launched: boolean; screenshot?: string; detail?: string };
}

export const currentTarget = (): Target => (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux');

/** The repo's shell/electron folder: it sits three levels above this file (packages/tools/src/tools). */
const shellDir = (): string => resolve(import.meta.dirname, '..', '..', '..', '..', 'shell', 'electron');

/** Where an unpacked Electron runtime for this OS can be found, or undefined. */
export function findElectronDist(explicit?: string): string | undefined {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env['HULL_ELECTRON_DIST']) candidates.push(process.env['HULL_ELECTRON_DIST']);
  const roots = [import.meta.url, pathUrl(join(shellDir(), '..', '..', 'packages', 'studio', 'package.json'))];
  for (const from of roots) {
    try { candidates.push(join(dirname(createRequire(from).resolve('electron/package.json')), 'dist')); } catch { /* not installed there */ }
  }
  const marker = process.platform === 'darwin' ? 'Electron.app' : process.platform === 'win32' ? 'electron.exe' : 'electron';
  return candidates.find((c) => existsSync(join(c, marker)));
}

const pathUrl = (p: string): string => `file://${p}`;

/** A name safe as a file name on all three systems. */
export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9 _.-]/g, '').trim().replace(/\s+/g, ' ') || 'Hull Game';

export function dirSize(p: string): number {
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const f of readdirSync(p)) n += dirSize(join(p, f));
  return n;
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`);
}

/** Chromium ships every language; a game that has none of its own needs English. Saves about 30 MB. */
function trimLocales(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (f.endsWith('.lproj') && !f.startsWith('en')) rmSync(join(dir, f), { recursive: true, force: true });
}

interface Meta { id: string; title: string; version: string }

/** `resources/app`: the shell's three files and the game. Same for every system. */
function writeApp(appDir: string, web: string, meta: Meta): void {
  const shell = shellDir();
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  for (const f of ['main.cjs', 'preload.cjs']) cpSync(join(shell, f), join(appDir, f));
  const pkg = JSON.parse(readFileSync(join(shell, 'package.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({ ...pkg, name: meta.id, productName: meta.title, version: meta.version, private: true }, null, 2)}\n`);
  cpSync(web, join(appDir, 'web'), { recursive: true });
}

function packageMac(dist: string, web: string, outDir: string, meta: Meta): string {
  const title = safeName(meta.title);
  const app = join(outDir, `${title}.app`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // ditto keeps the framework's symlinks and attributes exactly; a plain copy can break the bundle.
  run('ditto', [join(dist, 'Electron.app'), app]);
  const contents = join(app, 'Contents');
  writeApp(join(contents, 'Resources', 'app'), web, meta);
  renameSync(join(contents, 'MacOS', 'Electron'), join(contents, 'MacOS', title));
  const plist = join(contents, 'Info.plist');
  for (const [k, v] of [
    ['CFBundleExecutable', title],
    ['CFBundleName', title],
    ['CFBundleDisplayName', title],
    ['CFBundleIdentifier', `com.hull.game.${meta.id.replace(/[^A-Za-z0-9]/g, '-')}`],
    ['CFBundleShortVersionString', meta.version],
    ['CFBundleVersion', meta.version],
  ] as const) run('plutil', ['-replace', k, '-string', v, plist]);
  // The asar integrity check would reject our app folder; Electron ships it off for unpacked apps, so drop the key.
  spawnSync('plutil', ['-remove', 'ElectronAsarIntegrity', plist]);
  trimLocales(join(contents, 'Resources'));
  trimLocales(join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources'));
  // Changing the plist broke the runtime's signature; Apple Silicon refuses an unsigned or broken bundle. An ad-hoc
  // signature runs on this Mac. Shipping to others needs a Developer ID signature and notarization.
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
  return app;
}

function packageFolder(target: 'win' | 'linux', dist: string, web: string, outDir: string, meta: Meta): string {
  const title = safeName(meta.title);
  const out = join(outDir, `${title}-${target === 'win' ? 'win32' : 'linux'}-${process.arch}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(dist, out, { recursive: true, verbatimSymlinks: true });
  writeApp(join(out, 'resources', 'app'), web, meta);
  const exe = target === 'win' ? 'electron.exe' : 'electron';
  renameSync(join(out, exe), join(out, target === 'win' ? `${title}.exe` : title));
  trimLocales(join(out, 'locales'));
  return out;
}

export function executableOf(artifact: string, target: Target, title: string): string {
  const t = safeName(title);
  return target === 'mac' ? join(artifact, 'Contents', 'MacOS', t) : join(artifact, target === 'win' ? `${t}.exe` : t);
}

/** Starts the app with the screenshot hook, waits for it to quit, and says whether it drew something. */
function smoke(exe: string, shot: string): Promise<{ launched: boolean; screenshot?: string; detail?: string }> {
  rmSync(shot, { force: true });
  return new Promise((done) => {
    const child = spawn(exe, [], { env: { ...process.env, HULL_SHELL_SCREENSHOT: shot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 45_000);
    child.on('error', (e) => { clearTimeout(timer); done({ launched: false, detail: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = existsSync(shot) && lstatSync(shot).size > 1000;
      done({ launched: ok, ...(ok ? { screenshot: shot } : {}), detail: ok ? `exit ${code}` : `exit ${code}: ${log.trim().split('\n').slice(-5).join(' | ')}` });
    });
  });
}

export const packageTool = defineTool<PackageInput, PackageOutput>({
  name: 'package',
  summary: 'Builds the game and packages it as a desktop app (Electron) for this OS: dist/desktop/<Title>.app on macOS.',
  input: {
    type: 'object',
    properties: {
      targets: { type: 'array', items: { enum: ['mac', 'win', 'linux'] }, description: 'Systems to package for. Only the one this runs on can be built; the others are reported as skipped.' },
      skipCheck: { type: 'boolean', description: 'Skip types, schemas and house rules.' },
      smoke: { type: 'boolean', description: 'Launch the packaged app once and save a screenshot (dist/desktop/smoke.png).' },
      electronDist: { type: 'string', description: 'Folder of an unpacked Electron runtime. Default: the one installed in the repo.' },
    },
    additionalProperties: false,
  },
  output: { type: 'object', required: ['ok', 'problems'] },
  format: (o) => [
    ...(o.artifacts ?? []).map((a) => `Packaged ${a.target}: ${a.path} (${(a.bytes / 1048576).toFixed(0)} MB)`),
    ...(o.skipped ?? []).map((s) => `Skipped ${s.target}: ${s.reason}`),
    ...(o.smoke ? [`Launch: ${o.smoke.launched ? `ok, screenshot ${o.smoke.screenshot}` : `FAILED (${o.smoke.detail})`}`] : []),
  ],
  async run(ctx, input) {
    const raw = input.targets as unknown;
    const wanted = (typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : (input.targets ?? [currentTarget()])) as Target[];
    const bad = wanted.filter((t) => !TARGETS.includes(t));
    if (bad.length) return { ok: false, problems: [{ file: 'package', message: `unknown target "${bad[0]}": use mac, win or linux`, rule: 'package' }] };
    if (!input.skipCheck) {
      const r = await check.run(ctx, {});
      if (!r.ok) return { ok: false, problems: r.problems };
    }
    const built = await buildProject(ctx.root, ctx.log);
    if (!built.ok || !built.outDir) return { ok: false, problems: built.problems };

    const here = currentTarget();
    const skipped: NonNullable<PackageOutput['skipped']> = [];
    const artifacts: NonNullable<PackageOutput['artifacts']> = [];
    const manifest = JSON.parse(readFileSync(join(ctx.root, 'hull.json'), 'utf8')) as { id?: string; title?: string; version?: string };
    const meta: Meta = { id: manifest.id ?? 'game', title: manifest.title ?? manifest.id ?? 'Hull Game', version: manifest.version ?? '0.0.0' };
    const outDir = join(ctx.root, 'dist', 'desktop');
    let smokeResult: PackageOutput['smoke'];

    for (const target of [...new Set(wanted)]) {
      if (target !== here) { skipped.push({ target, reason: `an Electron runtime for ${target} is needed; run this tool on ${target === 'mac' ? 'macOS' : target === 'win' ? 'Windows' : 'Linux'}` }); continue; }
      const dist = findElectronDist(input.electronDist);
      if (!dist) return { ok: false, problems: [{ file: 'package', message: 'no unpacked Electron runtime found: install electron (its dist folder) or pass electronDist / HULL_ELECTRON_DIST', rule: 'package' }] };
      try {
        ctx.log(`packaging ${meta.title} for ${target}`);
        const path = target === 'mac' ? packageMac(dist, built.outDir, outDir, meta) : packageFolder(target, dist, built.outDir, outDir, meta);
        artifacts.push({ target, path, bytes: dirSize(path) });
        if (input.smoke) smokeResult = await smoke(executableOf(path, target, meta.title), join(outDir, 'smoke.png'));
      } catch (e) {
        return { ok: false, problems: [{ file: 'package', message: (e as Error).message, rule: 'package' }] };
      }
    }
    const launchedOk = !smokeResult || smokeResult.launched;
    return {
      ok: artifacts.length > 0 && launchedOk,
      problems: artifacts.length === 0 ? [{ file: 'package', message: `nothing packaged: ${skipped.map((s) => `${s.target}: ${s.reason}`).join('; ')}`, rule: 'package' }] : launchedOk ? [] : [{ file: 'package', message: `the packaged app did not start: ${smokeResult?.detail}`, rule: 'package' }],
      artifacts,
      skipped,
      ...(smokeResult ? { smoke: smokeResult } : {}),
    };
  },
});
