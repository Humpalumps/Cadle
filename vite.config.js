import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    // tools/out is harness scratch: every inspect run rm -rf's and recreates its screenshot directories, and the
    // watcher races that (lstat UNKNOWN on a file deleted mid-walk) and takes the whole dev server down with it.
    // Nothing under these paths is imported by the app, so there is no reason to watch them.
    watch: { ignored: ['**/tools/out/**', '**/progress/**', '**/.claude/worktrees/**'] },
  },
  // progress.html is a dev-only page (pulls ~29 MB of progress/shots) — dev server still serves it, prod build skips it.
  build: { target: 'esnext' },
  optimizeDeps: { include: ['three', 'postprocessing'] },
});
