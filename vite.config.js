import { defineConfig } from 'vite';
import path from 'node:path';

// Anchored to THIS checkout's root. The patterns used to be `**/tools/out/**` style, which also matched
// when the dev server itself runs from inside `.claude/worktrees/<x>/` — the server then ignored every
// source file under it and served the first transform forever (edits silently did nothing).
const R = path.resolve(process.cwd()).replace(/\\/g, '/');

// `/play` without a trailing slash.
//
// Every static host (Cloudflare Pages, Netlify, Vercel, S3+CloudFront) serves `/play` from
// `play/index.html`. Vite's dev server does not: it 404s and falls through to the SPA fallback, which
// hands back the LANDING page — so the Play button on `/` opened `/play?start` and got cadle.gg again,
// with no game in it. Measured, not guessed. This makes dev behave like production.
// Every link on the site points at `/play/` WITH the slash, because that is the form that needs no
// rewrite anywhere. This middleware is for the person who types `/play` — and it is on BOTH servers on
// purpose: it used to be dev-only, so `npm run preview` served the landing page back for every Play
// route and the production artifact could not be checked with the project's own tooling.
const rewrite = (req, _res, next) => {
  if (req.url === '/play' || req.url.startsWith('/play?')) req.url = '/play/index.html' + req.url.slice(5);
  next();
};
const playRoute = {
  name: 'cadle-play-route',
  configureServer(server) { server.middlewares.use(rewrite); },
  configurePreviewServer(server) { server.middlewares.use(rewrite); },
};

export default defineConfig({
  plugins: [playRoute],
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
  // TWO pages. `/` is the marketing site (index.html, zero JS modules, no engine); `/play/` is the game
  // (play/index.html -> src/main.js). Splitting them is the reason the landing page can be a ~40 KB
  // document while the game is half a megabyte of engine — and why nothing about the game is downloaded
  // by someone who only came to look.
  // progress.html is a dev-only page (pulls ~29 MB of progress/shots) — dev server still serves it, prod build skips it.
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        landing: path.resolve(R, 'index.html'),
        play: path.resolve(R, 'play/index.html'),
      },
    },
  },
  optimizeDeps: { include: ['three', 'postprocessing'] },
});
