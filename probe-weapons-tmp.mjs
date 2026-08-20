// TEMP mini-runner (weapons builder): same steps as tools/inspect.mjs but tolerant of the thrashed box —
// waits on domcontentloaded + __game instead of the 'load' event. Visual iteration only; final perf via inspect.mjs.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [, , scriptPath, outName] = process.argv;
const steps = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const outDir = path.resolve('C:/Users/ianca/AppData/Local/Temp/claude/C--Users-ianca-Desktop-FPS3/d286c103-b3f2-4ff6-a66c-0c2bde7234fc/scratchpad', outName || 'wpnrun');
fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });

const W = 1920, H = 1080;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const report = { steps: [], stats: [], console: [], errors: [] };
page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; report.console.push(t); if (m.type() === 'error') report.errors.push(t); });
page.on('pageerror', (e) => report.errors.push(`[pageerror] ${e.message}`));

await page.goto('http://127.0.0.1:5173/?auto=1&q=high&seed=1337', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__game && (window.__game.errors.length > 0 || window.__game.game?._running), { timeout: 240000 });
console.log('game running');

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const state = async () => { try { return await ev(() => window.__game.state()); } catch { return null; } };
const shot = async (label) => { await page.screenshot({ path: path.join(outDir, `shot-${label}.png`) }); };

for (const step of steps) {
  const [k] = Object.keys(step); const v = step[k];
  report.steps.push({ step });
  try {
    if (k === 'wait') await sleep(v);
    else if (k === 'shot') await shot(v);
    else if (k === 'burst') { for (let i = 0; i < (v.n ?? 5); i++) { await page.screenshot({ path: path.join(outDir, `burst-${v.name}-${i}.png`) }); await sleep(v.interval ?? 0.1); } }
    else if (k === 'key') await ev(([c, d]) => d ? window.__game.input.press(c) : window.__game.input.release(c), [v, step.down !== false]);
    else if (k === 'look') await ev(([y, p]) => window.__game.look(y, p), v);
    else if (k === 'click') await ev(([b, d]) => window.__game.input.button(b, d), [v, step.down !== false]);
    else if (k === 'fire') { await ev(() => window.__game.input.button(0, true)); await sleep(v); await ev(() => window.__game.input.button(0, false)); }
    else if (k === 'tp') await ev(([x, y, z]) => window.__game.teleport(x, y ?? undefined, z), v);
    else if (k === 'hour') await ev((h) => window.__game.setHour(h), v);
    else if (k === 'eval') { report.steps.at(-1).result = await page.evaluate(v); }
    else if (k === 'stats') { const s = await ev(() => { const s = window.__game.stats(); window.__game.resetStats(); return s; }); report.stats.push({ label: v, ...s }); }
    else if (k === 'resetStats') await ev(() => window.__game.resetStats());
    else if (k === 'perfWindow') { await ev(() => window.__game.resetStats()); await sleep(v.secs ?? 3); const s = await ev(() => window.__game.stats()); report.stats.push({ label: v.label, secs: v.secs ?? 3, ...s }); }
  } catch (e) { report.steps.at(-1).error = String(e.message || e); }
}
try { const ge = await ev(() => window.__game.errors); report.errors.push(...ge.map((e) => '[game] ' + e)); } catch {}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ errors: report.errors.slice(0, 10), evals: report.steps.filter((s) => s.result !== undefined).map((s) => s.result), stats: report.stats.map((s) => ({ label: s.label, fps: s.fps, meanMs: s.frameMs?.mean, p99: s.frameMs?.p99, calls: s.calls, tris: s.tris })), out: outDir }, null, 2));
await browser.close();
