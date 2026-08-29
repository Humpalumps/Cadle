#!/usr/bin/env node
// TEMP DIAGNOSTIC (hitch investigation 2026-08-22). Runs the game like tools/inspect.mjs but lets the
// two harness frame-rate switches be turned OFF, and can capture a whole-browser chrome://tracing trace
// so a stall inside the GPU process is visible instead of just "some GL call blocked".
//   node tools/hitchprobe.mjs --secs 8 --q high [--vsync] [--trace] [--cats ...] [--flags a,b]
// --vsync: drop --disable-gpu-vsync/--disable-frame-rate-limit, i.e. behave like a real browser.
// Delete this file when the hitch is closed.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { gameUrl } from './gameurl.mjs';

const a = Object.fromEntries(process.argv.slice(2).reduce((o, v, i, r) => { if (v.startsWith('--')) o.push([v.slice(2), r[i + 1]?.startsWith('--') || r[i + 1] === undefined ? true : r[i + 1]]); return o; }, []));
const secs = +(a.secs || 8), q = a.q || 'high';
const base = gameUrl(a.url || process.env.CADLE_URL);
const out = path.resolve('tools/out/hitchprobe'); fs.mkdirSync(out, { recursive: true });
const cats = (typeof a.cats === 'string' ? a.cats : 'disabled-by-default-gpu.service,disabled-by-default-gpu.device,gpu,viz,toplevel,cc,blink,latency');

const args = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080'];
if (!a.vsync) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
if (typeof a.flags === 'string') args.push(...a.flags.split(',').map((x) => '--' + x));
const browser = await chromium.launch({ headless: !a.headed, args });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`${base}?auto=1&q=${q}&seed=1337`, { waitUntil: 'load', timeout: 120000 });
for (let i = 0; i < 120; i++) { if (await page.evaluate(() => !!window.__game?.game?._running).catch(() => false)) break; await new Promise((r) => setTimeout(r, 1000)); }
await new Promise((r) => setTimeout(r, 8000));   // settle: impostor bake / staggered layer uploads
await page.evaluate(() => window.__game.look(-1.5708, 0));
await page.evaluate(() => window.__game.resetStats());

if (a.trace) await browser.startTracing(page, { categories: cats.split(','), screenshots: false });
await new Promise((r) => setTimeout(r, secs * 1000));
const stats = await page.evaluate(() => { const s = window.__game.stats(); return { fps: s.fps, frameMs: s.frameMs, cpuMs: s.cpuMs, gpuMs: s.gpuMs, calls: s.calls, tris: s.tris }; });
if (a.trace) { const buf = await browser.stopTracing(); fs.writeFileSync(path.join(out, 'trace.json'), buf); console.log('trace bytes', buf.length); }
console.log(JSON.stringify({ vsync: !!a.vsync, q, ...stats }));
await browser.close();
