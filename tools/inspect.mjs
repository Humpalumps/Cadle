#!/usr/bin/env node
// Automation harness: runs the live game in headless Chromium WITH the real GPU, drives it with a step script,
// saves screenshots + perf stats + console/errors to tools/out/<name>/report.json.
//
//   node tools/inspect.mjs --name tour                       # default tour script
//   node tools/inspect.mjs --name x --steps '[{"wait":1},{"shot":"a"}]'
//   node tools/inspect.mjs --name x --script tools/scripts/combat.json
//   flags: --w 1920 --h 1080 --q high|medium|low --seed 1337 --headed --url http://127.0.0.1:5173/ --params "foo=1"
//          --noready  (do not wait for the game loop to start before running steps; for the intro/loading screen)
//          --nolock   (default: waits for an exclusive lock so perf numbers aren't skewed by parallel runs; use --nolock for quick screenshot-only iteration)
//
// Step types (JSON objects, run in order):
//   {wait: secs}                         sleep
//   {shot: name}                         screenshot -> shot-<name>.png (+ game state recorded)
//   {burst: {name, n, interval}}         n screenshots, interval secs apart -> burst-<name>-<i>.png (judge motion/animation)
//                                        plus mask-<name>-<i>.png per frame (frozen for the pair, so mask and colour agree)
//   {key: code, down: bool}              synthetic key (KeyboardEvent.code, e.g. KeyW, Space, ShiftLeft)
//   {hold: code, secs}                   press, wait, release
//   {look: [yaw, pitch]}                 set view angles (radians)
//   {mouse: [dx, dy]}                    synthetic mouse delta (pixels)
//   {turn: {dyaw, dpitch, secs}}         smooth turn over time
//   {click: button, down: bool}          synthetic mouse button
//   {fire: secs}                         hold LMB
//   {tp: [x, y|null, z]}                 teleport
//   {hour: h}                            set time of day (freezes day cycle)
//   {eval: "js"}                         evaluate in page (result recorded)
//   {stats: label}                       record perf stats now, then reset the window
//   {perfWindow: {secs, label}}          reset stats, wait, record
//   {resetStats: true}
//   {log: "text"}
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { gameUrl } from './gameurl.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => { if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]); return a; }, []));
const name = args.name || 'run';
const W = +(args.w || 1920), H = +(args.h || 1080);
const q = args.q || 'high';
const seed = args.seed || 1337;
const base = gameUrl(args.url || process.env.CADLE_URL);   // CADLE_URL: run a second dev server (e.g. a worktree on another port). The game is at /play/; gameurl.mjs appends it.
const outDir = path.resolve('tools/out', name);
fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });

const DEFAULT_TOUR = [
  { wait: 5.0 }, { resetStats: true },   // warmup: shader compiles, grass/terrain builds
  { log: 'spawn look-around' },
  { look: [0, 0] }, { shot: 'spawn-n' }, { look: [1.5708, 0] }, { shot: 'spawn-e' }, { look: [3.1416, 0] }, { shot: 'spawn-s' }, { look: [4.7124, -0.1] }, { shot: 'spawn-w' },
  { look: [0, -0.9] }, { shot: 'ground-close' }, { look: [0.5, 0.7] }, { shot: 'sky' },
  { look: [-1.5708, 0] },   // face east (spawn meadow; the aetheryte is north at z=-28)
  { perfWindow: { secs: 3, label: 'idle' } },
  { log: 'walk' }, { key: 'KeyW', down: true }, { wait: 1.5 }, { burst: { name: 'walk', n: 6, interval: 0.12 } }, { wait: 1 }, { shot: 'walk' },
  { log: 'sprint' }, { key: 'ShiftLeft', down: true }, { wait: 1 }, { shot: 'sprint' }, { perfWindow: { secs: 3, label: 'sprint' } },
  { log: 'jump x2' }, { key: 'Space', down: true }, { key: 'Space', down: false }, { wait: 0.4 }, { key: 'Space', down: true }, { key: 'Space', down: false }, { wait: 0.3 }, { shot: 'airborne' }, { wait: 1.2 },
  { log: 'slide' }, { key: 'ControlLeft', down: true }, { wait: 0.3 }, { shot: 'slide' }, { wait: 0.6 }, { key: 'ControlLeft', down: false },
  { key: 'ShiftLeft', down: false }, { key: 'KeyW', down: false },
  { log: 'turn' }, { turn: { dyaw: 6.283, dpitch: 0, secs: 2 } },
  { log: 'fire' }, { fire: 1.2 }, { shot: 'post-fire' }, { click: 0, down: true }, { wait: 0.15 }, { shot: 'firing' }, { click: 0, down: false },
  { log: 'ads' }, { click: 2, down: true }, { wait: 0.5 }, { shot: 'ads' }, { fire: 0.6 }, { shot: 'ads-firing' }, { click: 2, down: false },
  { key: 'KeyR', down: true }, { wait: 0.1 }, { key: 'KeyR', down: false }, { wait: 0.6 }, { shot: 'reload' }, { wait: 1.5 },
  { perfWindow: { secs: 3, label: 'combat' } },
  { log: 'time of day' }, { look: [0.6, 0.15] },
  { hour: 6 }, { wait: 0.6 }, { shot: 'tod-06-dawn' }, { hour: 9 }, { wait: 0.6 }, { shot: 'tod-09' }, { hour: 13 }, { wait: 0.6 }, { shot: 'tod-13-noon' }, { hour: 17.5 }, { wait: 0.6 }, { shot: 'tod-17-golden' }, { hour: 19 }, { wait: 0.6 }, { shot: 'tod-19-dusk' }, { hour: 23 }, { wait: 0.6 }, { shot: 'tod-23-night' }, { hour: 15 },
  { log: 'vista' }, { tp: [60, null, -120] }, { look: [-0.7, 0.05] }, { wait: 1 }, { shot: 'vista-1' }, { tp: [-220, null, 180] }, { look: [2.4, 0.0] }, { wait: 1 }, { shot: 'vista-2' }, { perfWindow: { secs: 3, label: 'vista' } },
  { stats: 'final' },
];

let steps = DEFAULT_TOUR;
if (args.steps) steps = JSON.parse(args.steps);
else if (args.script) steps = JSON.parse(fs.readFileSync(args.script, 'utf8'));

// --- exclusive lock (mkdir mutex, stale after 4 min) ---
const lockDir = path.resolve('tools/out/.lock');
if (!args.nolock) {
  const t0l = Date.now();
  for (;;) {
    try { fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, 'owner'), `${name} ${process.pid} ${new Date().toISOString()}`); break; }
    catch { try { if (Date.now() - fs.statSync(lockDir).mtimeMs > 240000) fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} await new Promise((r) => setTimeout(r, 1500)); }
    if (Date.now() - t0l > 15 * 60000) { console.error('lock wait timeout'); break; }
  }
  const rel = () => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} };
  process.on('exit', rel); process.on('SIGINT', () => { rel(); process.exit(1); }); process.on('uncaughtException', (e) => { console.error(e); rel(); process.exit(1); });
}
// Read-only orphan check. NOT a kill: --nolock runs are legitimately parallel, and reaping a sibling's
// browser mid-run would corrupt their capture instead of ours.
try {
  const { execSync } = await import('node:child_process');
  const out = execSync(process.platform === 'win32' ? 'tasklist /FI "IMAGENAME eq chrome-headless-shell.exe" /NH' : 'pgrep -fc chrome-headless-shell || true', { encoding: 'utf8' });
  const n = process.platform === 'win32' ? (out.match(/chrome-headless-shell\.exe/g) || []).length : (+out.trim() || 0);
  if (n > 0) console.warn(`[inspect] WARNING: ${n} chrome-headless-shell process(es) already running. If they are not a parallel harness run they are orphans, and every timing number from this run is inflated (see HANDOVER 4b/4d).`);
} catch {}

const browser = await chromium.launch({
  headless: !args.headed,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`],
});
// ALWAYS reap the browser. A run that threw, or was killed, used to leave ~4 chrome-headless-shell processes
// alive, and they keep contending for the GPU: every later run reads worse, gate.mjs starts failing on
// scenes it just passed (HANDOVER 4b), and at q=high they manufacture the "periodic 65 ms hitch" outright
// (the renderer blocks in WaitForGetOffset once the GPU is oversubscribed). The leak was manufacturing the
// bug it made unfindable. Note a hard kill (taskkill /F) still cannot be caught -- hence the orphan warning
// below, which tells you the numbers are already contaminated before you trust them.
let reaped = false;
const reap = async () => {
  if (reaped) return; reaped = true;
  try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]); } catch {}
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reap().finally(() => process.exit(130)); });
process.on('uncaughtException', (e) => { console.error('[inspect] uncaught:', e?.message || e); reap().finally(() => process.exit(1)); });
process.on('unhandledRejection', (e) => { console.error('[inspect] unhandled rejection:', e?.message || e); reap().finally(() => process.exit(1)); });

const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const report = { name, url: '', gpu: '', size: [W, H], quality: q, steps: [], shots: [], stats: [], state: [], console: [], errors: [], startedAt: new Date().toISOString() };
page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; report.console.push(t); if (m.type() === 'error') report.errors.push(t); });
page.on('pageerror', (e) => report.errors.push(`[pageerror] ${e.message}`));

const url = `${base}${base.includes('?') ? '&' : '?'}auto=1&q=${q}&seed=${seed}${args.params ? '&' + args.params : ''}`;
report.url = url;

// ---------------------------------------------------------------- IS THIS SERVER SERVING *THIS* TREE?
// 2026-08-23: five agents spent a session measuring http://127.0.0.1:5173/, which was a dev server the
// user had started in the MAIN repo — a different git branch entirely. Screenshots, frame timings, a
// density cap and a full "GATE PASSED" were all produced against code that did not contain the work
// being measured, and every one of them looked like evidence. Nothing in the harness noticed, because
// a wrong tree serves a perfectly healthy game.
// So: before any run, fetch a few source files back off the server and check they are the ones on disk
// here. Vite transforms modules, but it preserves comment and string bodies for plain ES modules, so a
// long distinctive line from the local file must appear in what the server hands back.
// Set CADLE_SKIP_TREECHECK=1 only if you are deliberately measuring another tree.
async function verifyServedTree() {
  if (process.env.CADLE_SKIP_TREECHECK) return;
  const { readFileSync } = await import('node:fs');
  const probes = ['src/main.js', 'src/core/Game.js', 'src/render/PostFX.js'];
  // Probe off the ORIGIN, not the raw --url. A caller passing a url that already carries a query
  // (`http://host:5174/?auto=1&q=low`) produced `.../?auto=1&q=low/src/main.js`; the dev server's SPA
  // fallback answers that 200 with index.html, every probe "mismatches", and the guard cries WRONG
  // TREE at a server that is serving exactly the right code. A guard that false-positives is worse
  // than no guard - this one taught an agent to run with CADLE_SKIP_TREECHECK, after which none of
  // its captures could be trusted. Strip query and hash here, once; page navigation still uses `base`.
  // The TRUE origin, not base's directory: the game moved to /play/ on 2026-08-28, and `src/...` is
  // still served from the server root. Probing `${base}/src/main.js` asks for /play/src/main.js, the
  // dev server answers with the app shell, and every probe "mismatches" — the exact false positive the
  // paragraph above is about, one directory level later.
  const u = new URL(base);
  const origin = u.origin;
  const bad = [];
  for (const rel of probes) {
    let local;
    try { local = readFileSync(rel, 'utf8'); } catch { continue; }
    // longest line that is a comment or a long string — those survive Vite's transform verbatim
    const marker = local.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l.length > 60 && l.length < 300 && (l.startsWith('//') || l.startsWith('*')))
      .sort((a, b) => b.length - a.length)[0];
    if (!marker) continue;
    let served;
    try {
      const r = await fetch(`${origin}/${rel}`);
      if (!r.ok) { bad.push(`${rel}: server returned ${r.status}`); continue; }
      served = await r.text();
    } catch (e) { bad.push(`${rel}: ${e.message}`); continue; }
    // Distinguish "the server handed back HTML" from "this is a JS module whose contents differ".
    // A dev server's SPA fallback answers an unresolvable path with index.html, which contains no
    // marker and therefore looks exactly like a wrong tree. That is how this guard misfired: the
    // probe URL was malformed, every file came back as the app shell, and the message said "wrong
    // tree" when the truth was "I asked for the wrong thing". A guardrail that cannot tell those
    // apart teaches people to disable it, which is what happened. Name the difference.
    if (/^\s*<(?:!doctype|html)/i.test(served)) {
      bad.push(`${rel}: server returned HTML, not a JS module - it fell through to the SPA fallback, `
             + `which usually means the probe URL is wrong rather than the tree. Probed: ${origin}/${rel}`);
    } else if (!served.includes(marker)) {
      bad.push(`${rel}: served a JS module, but its contents differ from the copy on disk here`);
    }
  }
  if (bad.length) {
    console.error('');
    console.error('[inspect] ==== WRONG TREE ====');
    console.error(`[inspect] ${base} is not serving this working directory:`);
    for (const b of bad) console.error('  - ' + b);
    console.error('[inspect] Every number and screenshot from this run would describe code that is not here.');
    if (bad.every((b) => b.includes('returned HTML'))) {
      console.error('[inspect] NOTE: every probe came back as HTML, so this is very likely a BAD PROBE URL,');
      console.error('[inspect] not a wrong tree. Check the --url you passed. If the tree is genuinely right,');
      console.error('[inspect] this is a bug in the guard itself - fix it rather than skipping it.');
    }
    console.error('[inspect] Start a dev server in THIS directory on a free port and pass --url / CADLE_URL,');
    console.error('[inspect] or set CADLE_SKIP_TREECHECK=1 if you really mean to measure another tree.');
    console.error('');
    await browser.close().catch(() => {});
    process.exit(2);
  }
  console.log(`[inspect] served tree matches this working directory (${base})`);
}
await verifyServedTree();
await page.goto(url, { waitUntil: 'load', timeout: 120000 }); // vite can take >30s to serve the module graph while parallel agent runs saturate it
report.gpu = await page.evaluate(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); const d = gl?.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
if (!args.noready) {   // --noready: the page never starts the game loop by itself (e.g. the intro held on screen)
  // 150 s, not 60: a cold headless boot is now ~30 s on this box (terrain full bake ~9 s, impostor bakes ~5 s)
  // and lands near the old ceiling whenever the GPU is busy, so runs were dying with TIMEOUT before they
  // rendered a frame. A too-short ceiling here reads exactly like a broken build.
  // waitForFunction(fn, ARG, options): {timeout} in the 2nd slot becomes the page-function's ARGUMENT
  // and the wait silently runs at the 30 s default — two agents independently hit this class
  // (collidecheck carried the same latent bug). The null arg slot is load-bearing.
  try { await page.waitForFunction(() => window.__game && (window.__game.errors.length > 0 || window.__game.game?._running), null, { timeout: 150000 }); }
  catch (e) { report.errors.push('TIMEOUT waiting for game to start: ' + e.message); }
}
const t0 = Date.now();
const now = () => +((Date.now() - t0) / 1000).toFixed(2);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const state = async () => { try { return await ev(() => window.__game.state()); } catch { return null; } };
const shot = async (label) => { const f = `shot-${label}.png`; await page.screenshot({ path: path.join(outDir, f) }); const st = await state(); report.shots.push({ file: f, t: now(), state: st }); return f; };

for (const step of steps) {
  const [k] = Object.keys(step); const v = step[k];
  report.steps.push({ t: now(), step });
  try {
    if (k === 'wait') await sleep(v);
    else if (k === 'shot') await shot(v);
    else if (k === 'burst') {
      // ONE MASK PER FRAME, captured with the world frozen so the mask is the SAME INSTANT as the colour
      // frame it scopes. This used to be one mask for the whole burst, taken after the last frame, on the
      // stated assumption that "the camera is static through a burst" -- which is false for the burst that
      // matters most: gate-steps.json holds KeyW down across blob-walk, so the camera travels for the whole
      // burst and then another ~1 s before the mask. blobcheck then scoped frame 0 with a mask from a metre
      // or more further down the meadow, so hazy distant canopy was tested under the strict ground-cover
      // rule and the gate failed or passed depending on where the walk happened to land. That is the whole
      // of the q=low blobcheck flake (measured: 4 runs each way, ~50% either side, cull on or off).
      // Freezing for the pair costs nothing the burst is testing: frames are still `interval` apart with
      // real motion between them, so a blob that ignites between frames still shows up in the FLASH test.
      const noMask = !!process.env.CADLE_NOMASK;
      // NEVER freeze the jitter probe. gate.mjs rule 2 asks "does a STATIC camera produce near-identical
      // consecutive frames"; pausing for each capture would let any temporal accumulator settle and hand the
      // rule a free pass. Its camera really is static, so a per-burst mask was already aligned for it.
      const freeze = !noMask && !v.name.startsWith('jit');
      const setPaused = (b) => page.evaluate((p) => { const g = window.__game?.game; if (g) g.paused = p; }, b).catch(() => {});
      for (let i = 0; i < (v.n ?? 5); i++) {
        if (freeze) { await setPaused(true); await sleep(0.05); }   // freeze: colour + mask must agree exactly
        await page.screenshot({ path: path.join(outDir, `burst-${v.name}-${i}.png`) });
        if (!noMask) {
          try {
            await page.evaluate(() => window.__game?.skyMask?.(true));
            await sleep(0.08);
            await page.screenshot({ path: path.join(outDir, `mask-${v.name}-${i}.png`) });
          } finally { await page.evaluate(() => window.__game?.skyMask?.(false)); await sleep(0.05); }
          if (freeze) await setPaused(false);
        }
        await sleep(v.interval ?? 0.1);
      }
      report.shots.push({ file: `burst-${v.name}-*.png`, t: now(), state: await state() });
    }
    else if (k === 'key') await ev(([c, d]) => d ? window.__game.input.press(c) : window.__game.input.release(c), [v, step.down !== false]);
    else if (k === 'hold') { await ev((c) => window.__game.input.press(c), v); await sleep(step.secs ?? 1); await ev((c) => window.__game.input.release(c), v); }
    else if (k === 'look') await ev(([y, p]) => window.__game.look(y, p), v);
    else if (k === 'mouse') await ev(([x, y]) => window.__game.input.move(x, y), v);
    else if (k === 'turn') { const n = Math.max(1, Math.round((v.secs ?? 1) * 60)); const st = await state(); const y0 = st?.yaw ?? 0, p0 = st?.pitch ?? 0; for (let i = 1; i <= n; i++) { await ev(([y, p]) => window.__game.look(y, p), [y0 + (v.dyaw ?? 0) * i / n, p0 + (v.dpitch ?? 0) * i / n]); await sleep((v.secs ?? 1) / n); } }
    else if (k === 'click') await ev(([b, d]) => window.__game.input.button(b, d), [v, step.down !== false]);
    else if (k === 'fire') { await ev(() => window.__game.input.button(0, true)); await sleep(v); await ev(() => window.__game.input.button(0, false)); }
    else if (k === 'tp') await ev(([x, y, z]) => window.__game.teleport(x, y ?? undefined, z), v);
    else if (k === 'hour') await ev((h) => window.__game.setHour(h), v);
    else if (k === 'eval') { const r = await page.evaluate(v); report.steps.at(-1).result = r; }
    else if (k === 'stats') { const s = await ev(() => { const s = window.__game.stats(); window.__game.resetStats(); return s; }); report.stats.push({ label: v, t: now(), ...s }); }
    else if (k === 'resetStats') await ev(() => window.__game.resetStats());
    else if (k === 'perfWindow') { await ev(() => window.__game.resetStats()); await sleep(v.secs ?? 3); const s = await ev(() => window.__game.stats()); report.stats.push({ label: v.label, t: now(), secs: v.secs ?? 3, ...s }); }
    else if (k === 'log') { /* annotation only */ }
    else report.steps.at(-1).error = 'unknown step';
  } catch (e) { report.steps.at(-1).error = String(e.message || e); }
}
try { const ge = await ev(() => window.__game.errors); report.errors.push(...ge.map((e) => '[game] ' + e)); } catch {}
report.finalState = await state();
report.endedAt = new Date().toISOString();
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(outDir, 'console.log'), report.console.join('\n'));
// concise summary to stdout
const sum = { gpu: report.gpu, shots: report.shots.length, errors: report.errors.slice(0, 10), stats: report.stats.map((s) => ({ label: s.label, fps: s.fps, meanMs: s.frameMs?.mean, p95ms: s.frameMs?.p95, p99ms: s.frameMs?.p99, cpuMs: s.cpuMs?.mean, gpuMs: s.gpuMs?.mean, gpuP95: s.gpuMs?.p95, calls: s.calls, tris: s.tris, memMB: s.memMB })), out: outDir };
console.log(JSON.stringify(sum, null, 2));
await reap();
