import { defineConfig } from 'vite';

// Dev-only page for the physics module; never part of a ship build.
export default defineConfig({
  root: import.meta.dirname,
  server: { port: 5309, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2023' },
});
