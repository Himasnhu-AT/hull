import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

// The renderer is plain static files: `base: './'` so they load from file:// inside Electron.
export default defineConfig({
  root: resolve(here, 'src/renderer'),
  base: './',
  plugins: [react()],
  server: { port: 5305, strictPort: true, host: '127.0.0.1' },
  build: { outDir: resolve(here, 'out/renderer'), emptyOutDir: true, target: 'es2023' },
});
