import { defineConfig } from 'vite';

// A dev server started INSIDE .claude/worktrees/<x> must watch its own files; only the main checkout's
// server should ignore the worktrees (that ignore exists because harness runs churn files in there).
const SERVED_FROM_WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]/.test(process.cwd());
export default defineConfig({
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    // tools/out is harness scratch: every inspect run rm -rf's and recreates its screenshot directories, and the
    // watcher races that (lstat UNKNOWN on a file deleted mid-walk) and takes the whole dev server down with it.
    // Nothing under these paths is imported by the app, so there is no reason to watch them.
    // Other worktrees are ignored too, except when this server IS one of them (see above).
    watch: { ignored: ['**/tools/out/**', '**/progress/**', ...(SERVED_FROM_WORKTREE ? [] : ['**/.claude/worktrees/**'])] },
  },
  // progress.html is a dev-only page (pulls ~29 MB of progress/shots) — dev server still serves it, prod build skips it.
  build: { target: 'esnext' },
  optimizeDeps: { include: ['three', 'postprocessing'] },
});
