#!/usr/bin/env node
// Automation harness: runs the live game in headless Chromium WITH the real GPU, drives it with a step script,
// saves screenshots + perf stats + console/errors to tools/out/<name>/report.json.
//
//   node tools/inspect.mjs --name tour                       # default tour script
//   node tools/inspect.mjs --name x --steps '[{"wait":1},{"shot":"a"}]'
//   node tools/inspect.mjs --name x --script tools/scripts/combat.json
//   flags: --w 1920 --h 1080 --q high|medium|low --seed 1337 --headed --url http://127.0.0.1:5173/ --params "foo=1"
//          --nolock   (default: waits for an exclusive lock so perf numbers aren't skewed by parallel runs; use --nolock for quick screenshot-only iteration)
//
// Step types (JSON objects, run in order):
//   {wait: secs}                         sleep
//   {shot: name}                         screenshot -> shot-<name>.png (+ game state recorded)
//   {burst: {name, n, interval}}         n screenshots, interval secs apart -> burst-<name>-<i>.png (judge motion/animation)
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

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => { if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]); return a; }, []));
const name = args.name || 'run';
const W = +(args.w || 1920), H = +(args.h || 1080);
const q = args.q || 'high';
const seed = args.seed || 1337;
const base = args.url || process.env.CADLE_URL || 'http://127.0.0.1:5173/';   // CADLE_URL: run a second dev server (e.g. a worktree on another port)
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
const browser = await chromium.launch({
  headless: !args.headed,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const report = { name, url: '', gpu: '', size: [W, H], quality: q, steps: [], shots: [], stats: [], state: [], console: [], errors: [], startedAt: new Date().toISOString() };
page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; report.console.push(t); if (m.type() === 'error') report.errors.push(t); });
page.on('pageerror', (e) => report.errors.push(`[pageerror] ${e.message}`));

const url = `${base}${base.includes('?') ? '&' : '?'}auto=1&q=${q}&seed=${seed}${args.params ? '&' + args.params : ''}`;
report.url = url;
await page.goto(url, { waitUntil: 'load', timeout: 120000 }); // vite can take >30s to serve the module graph while parallel agent runs saturate it
report.gpu = await page.evaluate(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); const d = gl?.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
try { await page.waitForFunction(() => window.__game && (window.__game.errors.length > 0 || window.__game.game?._running), { timeout: 60000 }); }
catch (e) { report.errors.push('TIMEOUT waiting for game to start: ' + e.message); }
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
      for (let i = 0; i < (v.n ?? 5); i++) { await page.screenshot({ path: path.join(outDir, `burst-${v.name}-${i}.png`) }); await sleep(v.interval ?? 0.1); }
      // One SKY MASK per burst (the camera is static through a burst): magenta = sky. tools/blobcheck.py
      // uses it to ignore the sun and the sky seen through gaps in the trees, which are not blobs.
      try {
        if (process.env.CADLE_NOMASK) throw new Error("skip");
        await page.evaluate(() => window.__game?.skyMask?.(true));
        await sleep(0.25);
        await page.screenshot({ path: path.join(outDir, `mask-${v.name}.png`) });
      } catch (e) { if (!process.env.CADLE_NOMASK) throw e; } finally { await page.evaluate(() => window.__game?.skyMask?.(false)); await sleep(0.15); }
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
await browser.close();
