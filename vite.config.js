import { defineConfig } from 'vite';
import path from 'node:path';

// Anchored to THIS checkout's root. The patterns used to be `**/tools/out/**` style, which also matched
// when the dev server itself runs from inside `.claude/worktrees/<x>/` — the server then ignored every
// source file under it and served the first transform forever (edits silently did nothing).
const R = path.resolve(process.cwd()).replace(/\\/g, '/');

export default defineConfig({
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    // tools/out is harness scratch: every inspect run rm -rf's and recreates its screenshot directories, and the
    // watcher races that (lstat UNKNOWN on a file deleted mid-walk) and takes the whole dev server down with it.
    // Nothing under these paths is imported by the app, so there is no reason to watch them.
    // usePolling: native fs events do not reliably reach this checkout (it is a git worktree under
    // .claude/worktrees, and Windows watch handles across that boundary have twice now gone quiet with no
    // error at all — the server kept serving the FIRST transform of every module while curl and the game
    // showed pre-edit code, so measurements silently described code that was no longer on disk). Polling a
    // few hundred source files every 300 ms is nothing next to a wave of results that describe the wrong build.
    watch: { ignored: [`${R}/tools/out/**`, `${R}/progress/**`, `${R}/.claude/worktrees/**`], usePolling: true, interval: 300 },
  },
  // progress.html is a dev-only page (pulls ~29 MB of progress/shots) — dev server still serves it, prod build skips it.
  build: { target: 'esnext' },
  optimizeDeps: { include: ['three', 'postprocessing'] },
});
