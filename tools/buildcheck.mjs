#!/usr/bin/env node
// buildcheck.mjs — DOES THE PRODUCTION BUILD STILL SHIP A GAME?  `node tools/buildcheck.mjs`
//
// This exists because of a bug that dev CANNOT show you. play/index.html used to create its module
// script at runtime (`createElement('script'); m.src = '/src/main.js'`). The dev server serves that
// path, so every local check passed and every harness run passed. Vite only rewrites entries it can
// SEE in the HTML, so the built page kept asking for a source path that does not exist in dist/ —
// cadle.gg answered 404 on /src/main.js and the loading bar sat at 0% for every visitor.
//
// The rule: both pages must come out of the build with a HASHED module entry, and no reference to a
// /src/ path may survive into dist/. Runs the real build (needs node_modules), so CI runs it after
// npm ci; it is the only check in this repo that looks at what is actually deployed.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

let failed = false;
const fail = (m) => { console.error('[buildcheck] FAIL: ' + m); failed = true; };

console.log('[buildcheck] building...');
try { execSync('npx vite build', { stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { console.error(String(e.stdout || '') + String(e.stderr || '')); fail('the production build itself failed'); }

for (const page of ['dist/index.html', 'dist/play/index.html']) {
  if (!existsSync(page)) { fail(`${page} was not produced — the build no longer emits that entry`); continue; }
  const html = readFileSync(page, 'utf8');
  const entry = html.match(/<script[^>]*type="module"[^>]*src="(\/assets\/[^"]+\.js)"/);
  if (!entry) fail(`${page} has no hashed module entry — the bundler could not see this page's script, so the deployed page will load no JavaScript at all (this is the /src/main.js 404 that took cadle.gg down)`);
  // Comments survive the build and this file's own explanation of the bug mentions the path, so strip
  // them first and then look only at LIVE references: a src= attribute or a dynamic import.
  const live = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/src="\/src\/|import\(\s*['"]\/src\//.test(live)) fail(`${page} still loads a /src/ path in the built output — that path exists only on the dev server; it is a 404 in production`);
}

console.log(failed ? '[buildcheck] ==== FAILED ====' : '[buildcheck] production build OK (both pages carry a hashed module entry)');
process.exit(failed ? 1 : 0);
