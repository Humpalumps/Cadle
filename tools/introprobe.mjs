#!/usr/bin/env node
// INTRO PROBE. hitchhunt.mjs can only attach after the game loop is running, so it is blind to the whole
// loading screen. This installs a frame recorder BEFORE page load (addInitScript) and hooks the intro's
// own setProgress/arm/play, so you get: every frame delta from the first paint, when the bar reached each
// value, when arm() fired, and the gap between "bar looks full" and "you may click".
//
//   node tools/introprobe.mjs --name intro [--url http://127.0.0.1:5199/] [--q high] [--worker 0]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { gameUrl } from './gameurl.mjs';

const a = Object.fromEntries(process.argv.slice(2).reduce((o, v, i, r) => { if (v.startsWith('--')) o.push([v.slice(2), r[i + 1]?.startsWith('--') || r[i + 1] === undefined ? true : r[i + 1]]); return o; }, []));
const name = a.name || 'intro';
const base = gameUrl(a.url || process.env.CADLE_URL || 'http://127.0.0.1:5199/');
const out = path.resolve('tools/out', name);
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: !a.headed,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 200)));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));

await page.addInitScript(() => {
  window.__ip = { frames: [], events: [], t0: performance.now() };
  const progCount = () => { try { return window.__game.game.renderer.info.programs.length; } catch (e) { return -1; } };
  const ev = (n, v) => window.__ip.events.push({ n, v, prog: progCount(), t: +(performance.now() - window.__ip.t0).toFixed(1) });
  window.__ipEv = ev;
  let last = performance.now();
  (function loop() { const n = performance.now(); window.__ip.frames.push({ t: +(n - window.__ip.t0).toFixed(1), dt: +(n - last).toFixed(2) }); last = n; requestAnimationFrame(loop); })();
  // The intro object appears partway through main.js; grab it the moment it does.
  const iv = setInterval(() => {
    const it = window.__game && window.__game.intro;
    if (!it || it.__hooked) return;
    it.__hooked = true; ev('intro-exists', it.constructor && it.constructor.name);
    window.__ip.introClass = (it.constructor && it.constructor.name) || '?';
    window.__ip.hasStepInto = !!(it.game && it.game.stepInto);
    const sp = it.setProgress && it.setProgress.bind(it);
    if (sp) it.setProgress = (p, l) => { ev('progress', +(Number(p) || 0).toFixed(3)); return sp(p, l); };
    const ar = it.arm && it.arm.bind(it);
    if (ar) it.arm = () => { ev('arm:enter'); const r = ar(); ev('arm:done'); return r; };
    const pl = it.play && it.play.bind(it);
    if (pl) it.play = () => { ev('play'); return pl(); };
    if (it.finished && it.finished.then) it.finished.then(() => ev('finished'));
    clearInterval(iv);
  }, 4);
  // wrap stepInto so _arm()'s own render shows up as its own event with a program delta
  const iv3 = setInterval(() => {
    const g = window.__game && window.__game.game;
    if (!g || !g.stepInto || g.__siHooked) return;
    g.__siHooked = true;
    const si = g.stepInto.bind(g);
    g.stepInto = (dt, target, sys, cam) => {
      const p0 = progCount(), t0 = performance.now();
      const r = si(dt, target, sys, cam);
      ev('stepInto', { ms: +(performance.now() - t0).toFixed(1), progFrom: p0, progTo: progCount(), w: target && target.width });
      return r;
    };
    clearInterval(iv3);
  }, 4);
  // and note the moment the game loop actually starts
  const iv2 = setInterval(() => { if (window.__game && window.__game.game && window.__game.game._running) { ev('game-running'); clearInterval(iv2); } }, 8);
});

const q = a.q || 'high';
const worker = a.worker === '0' ? '&worker=0' : '';
await page.goto(`${base}?auto=1&intro=1&q=${q}&seed=1337${worker}`, { waitUntil: 'load', timeout: 180000 });
// auto mode plays the transition 4 s after arming; wait for the game to own the canvas, then a little more.
for (let i = 0; i < 240; i++) {
  const done = await page.evaluate(() => (window.__ip.events || []).some((e) => e.n === 'finished')).catch(() => false);
  if (done) break;
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 2000));
const ip = await page.evaluate(() => window.__ip);
await browser.close();

const F = ip.frames, E = ip.events;
const at = (n) => E.find((e) => e.n === n)?.t ?? null;
const firstFull = E.find((e) => e.n === 'progress' && e.v >= 0.999)?.t ?? null;
const lastProg = [...E].reverse().find((e) => e.n === 'progress');
const armEnter = at('arm:enter'), armDone = at('arm:done');
const spikes = F.filter((f) => f.dt >= 50);
const before = armEnter ? F.filter((f) => f.t < armEnter) : F;
const q95 = (arr) => { const s = arr.map((f) => f.dt).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.95)] : 0; };

const summary = {
  url: base, q, worker: worker ? 'off' : 'on',
  timeline: {
    introExists: at('intro-exists'), gameRunning: at('game-running'),
    barReached100: firstFull, lastProgressValue: lastProg?.v ?? null, lastProgressAt: lastProg?.t ?? null,
    introClass: ip.introClass, hasStepInto: ip.hasStepInto,
    armEnter, armDone, armCostMs: armEnter != null && armDone != null ? +(armDone - armEnter).toFixed(1) : null,
    play: at('play'), finished: at('finished'),
    DEAD_TIME_bar100_to_armed: firstFull != null && armDone != null ? +(armDone - firstFull).toFixed(1) : null,
  },
  introFrames: { n: before.length, p50: before.length ? before.map((f) => f.dt).sort((x, y) => x - y)[Math.floor(before.length / 2)] : 0, p95: q95(before), max: before.length ? Math.max(...before.map((f) => f.dt)) : 0 },
  spikesDuringIntro: spikes.filter((f) => armEnter == null || f.t < armEnter).map((f) => ({ t: f.t, dt: f.dt })),
  progressSteps: E.filter((e) => e.n === 'progress').map((e) => ({ t: e.t, v: e.v })),
};
fs.writeFileSync(path.join(out, 'intro.json'), JSON.stringify({ summary, frames: F, events: E }, null, 1));
fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
console.log(JSON.stringify({ ...summary, progressSteps: summary.progressSteps.slice(-8), spikesDuringIntro: summary.spikesDuringIntro.slice(0, 20) }, null, 1));
