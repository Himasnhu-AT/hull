// Node only: the fingerprint of the kernel crate's source. `pnpm kernels:build` writes it beside the module it built
// (wasm.ts), and kernel.test.ts takes it again, so `pnpm check` fails when the source has changed and the committed
// module has not been rebuilt. The runtime never imports this file.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'target') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

/** sha256 over every file that decides what the module is: the workspace manifest, the lock file, the pinned compiler and the crate. */
export function kernelSourceStamp(repoRoot: string): string {
  const files = [join(repoRoot, 'Cargo.toml'), join(repoRoot, 'Cargo.lock'), join(repoRoot, 'rust-toolchain.toml')];
  walk(join(repoRoot, 'crates', 'hull-kernels'), files);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(repoRoot, f).split('\\').join('/'));
    h.update('\0');
    // Line endings are normalised so a checkout on Windows gives the same stamp.
    h.update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex');
}
