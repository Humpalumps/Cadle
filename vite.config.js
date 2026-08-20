import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  // progress.html is a dev-only page (pulls ~29 MB of progress/shots) — dev server still serves it, prod build skips it.
  build: { target: 'esnext' },
  optimizeDeps: { include: ['three', 'postprocessing'] },
});
