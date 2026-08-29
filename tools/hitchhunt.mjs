#!/usr/bin/env node
// HITCH HUNTER. Records EVERY frame's wall time (not a percentile summary) while driving a route that
// crosses the whole world, then attributes each spike to the system that was slow ON THAT FRAME.
//
//   node tools/hitchhunt.mjs --name base                     # local dev, vsync ON (what a player feels)
//   node tools/hitchhunt.mjs --name prod --url https://cadle.gg/
//   node tools/hitchhunt.mjs --name stress --uncapped        # no vsync (stress; see HANDOVER 5.1 artifact)
//   flags: --q high|low --secs-per-biome 6 --spike 24 --headed
//
// Why this exists and tools/hitchprobe.mjs does not do it: hitchprobe reports perf.stats() aggregates, and
// perf.systems is an EMA, so a single 90 ms frame is invisible in both. This wraps every system's update()
// and postfx.render() to capture RAW per-frame ms, and hooks perf.end so the sample is taken at the exact
// end of the frame. No game source is modified -- the patch is injected into the page.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { gameUrl } from './gameurl.mjs';

const a = Object.fromEntries(process.argv.slice(2).reduce((o, v, i, r) => { if (v.startsWith('--')) o.push([v.slice(2), r[i + 1]?.startsWith('--') || r[i + 1] === undefined ? true : r[i + 1]]); return o; }, []));
const name = a.name || 'hitchhunt';
const q = a.q || 'high';
const SPIKE = +(a.spike || 24);           // ms. one 60 Hz frame is 16.7; 24 is "the player saw it".
const PER_BIOME = +(a['secs-per-biome'] || 6);
const base = gameUrl(a.url || process.env.CADLE_URL);
const out = path.resolve('tools/out', name);
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });

const args = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080'];
if (a.uncapped) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');

const browser = await chromium.launch({ headless: !a.headed, args });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 300)); });

const tNav = Date.now();
const extra = typeof a.params === 'string' ? '&' + a.params : '';
await page.goto(`${base}?auto=1&q=${q}&seed=1337${extra}`, { waitUntil: 'load', timeout: 180000 });
let booted = false;
for (let i = 0; i < 180; i++) { if (await page.evaluate(() => !!window.__game?.game?._running).catch(() => false)) { booted = true; break; } await new Promise((r) => setTimeout(r, 500)); }
const bootMs = Date.now() - tNav;
if (!booted) { console.error('NEVER BOOTED after 90 s'); await browser.close(); process.exit(1); }

// ---- inject the per-frame recorder -----------------------------------------------------------
await page.evaluate((SPIKE) => {
  const g = window.__game.game;
  const raw = {};
  window.__hp = { frames: [], marks: [], t0: performance.now(), spike: SPIKE };
  // Systems, plus World's five sub-parts by name -- "World: 1.2 s" is not an answer, and World.update is a
  // one-line delegator, so without this every world stall is attributed to the container.
  const wrap = (o, k) => { if (typeof o?.update !== 'function') return; const orig = o.update.bind(o); o.update = (dt, t) => { const a = performance.now(); orig(dt, t); raw[k] = performance.now() - a; }; };
  for (const s of g.systems) wrap(s, s.constructor.name);
  for (const p of g.world?.parts ?? []) wrap(p, 'World.' + p.constructor.name);
  const pr = g.postfx.render.bind(g.postfx);
  g.postfx.render = (dt) => { const a = performance.now(); pr(dt); raw.render = performance.now() - a; };
  const pe = g.perf.end.bind(g.perf);
  let last = performance.now();
  g.perf.end = (r) => {
    pe(r);
    const now = performance.now(), dt = now - last; last = now;
    // prog on EVERY frame, not just spikes: a program LINK is the thing we are hunting and it shows up as
    // a count step. Without the per-frame series you cannot tell a link stall from a GC pause.
    const rec = { t: +(now - window.__hp.t0).toFixed(1), dt: +dt.toFixed(2), cpu: +g.perf.ms.toFixed(2), prog: r.info.programs?.length ?? 0 };
    if (dt >= window.__hp.spike) {
      rec.calls = r.info.render.calls; rec.tris = r.info.render.triangles;
      rec.geo = r.info.memory.geometries; rec.tex = r.info.memory.textures; rec.prog = r.info.programs?.length ?? 0;
      rec.mem = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : 0;
      // HANDOVER 5.1: the harness artifact needs the GPU at ~100% occupancy (gpuMs ~= frameMs). A stall
      // with gpuMs WELL BELOW frameMs on a quiet box is a real hitch. Last resolved TIME_ELAPSED sample.
      const gs = g.perf.gpuSamples; rec.gpu = gs ? +gs[(g.perf._gi - 1 + 600) % 600].toFixed(2) : -1;
      rec.enemies = g.enemies?.list?.length ?? -1;
      rec.sys = Object.fromEntries(Object.entries(raw).filter(([, v]) => v > 0.8).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => [k, +v.toFixed(2)]));
      const p = g.player?.position; if (p) rec.pos = [Math.round(p.x), Math.round(p.z)];
    }
    window.__hp.frames.push(rec);
  };
  window.__hpMark = (label) => window.__hp.marks.push({ label, t: +(performance.now() - window.__hp.t0).toFixed(1) });
}, SPIKE);

const mark = (l) => page.evaluate((l) => window.__hpMark(l), l);
// NEVER let an eval RETURN game objects. `window.__game.lineup()` hands back 23 live Enemy instances,
// and Playwright then serialises that whole Three.js graph over CDP -- a MEASURED 6.5 s of blocked main
// thread, off-frame, which reads as a monstrous game hitch (page cpu low, GPU idle, no program links)
// and is nothing of the sort. It cost most of a session to chase. Always return a scalar.
const LINEUP = 'window.__game.game.enemies.lineup()';
// Wrap EVERY eval so the page returns a scalar, for the reason above: give()/ability()/killAll()/
// clearEnemies()/lineup() all hand back live game objects, and serialising one over CDP blocks the main
// thread off-frame for hundreds of ms to seconds. That is measurement noise indistinguishable from a hitch.
const ev = (js) => page.evaluate(`(()=>{const __r=(${js});return typeof __r==="object"&&__r!==null?1:(__r??1);})()`)
  .catch((e) => ({ err: String(e).slice(0, 200) }));
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const key = (code, down) => page.evaluate(([c, d]) => (d ? window.__game.input.press(c) : window.__game.input.release(c)), [code, down]);

// ---- the route --------------------------------------------------------------------------------
await mark('settle');
await sleep(8);                                    // impostor bake / staggered uploads finish here
await ev('window.__game.look(-1.5708, 0)');

// --route tp: teleports only (~60 s). For attributing the fast-travel stall while iterating on a fix.
// --route lineup: the SAME spawn three times over, each on its own mark. If the stall is a one-time driver
// cost (a D3D shader re-translation for a new input layout, a texture upload) only pass 1 pays it; if every
// pass pays, it is work the spawn itself does. That one bit decides whether it is warmable at all.
if (a.route === 'lineup') {
  await mark('l-idle'); await sleep(4);
  // The combat route stalls ~6.5 s on lineup(); a bare lineup() does not. The only difference is that
  // combat gives a weapon and fires first, so reproduce that prefix and bisect it.
  if (a.prefix !== '0') {
    await ev('window.__game.god(true)');
    await mark('l-give'); await ev("window.__game.give('autorifle',0)"); await sleep(4);
    await mark('l-fire'); await page.evaluate(() => window.__game.input.button(0, true)); await sleep(1.5);
    await page.evaluate(() => window.__game.input.button(0, false)); await sleep(3);
  }
  for (let i = 1; i <= 3; i++) {
    await mark('l-spawn' + i); await ev(LINEUP); await sleep(9);
    await mark('l-clear' + i); await ev('window.__game.clearEnemies()'); await sleep(3);
  }
  // and one single enemy, to see whether the cost is per-spawn or per-batch
  await mark('l-one'); await ev("window.__game.spawnNear('hound',12)"); await sleep(6);
  await mark('l-two'); await ev("window.__game.spawnNear('drake',14)"); await sleep(6);
  await mark('end');
} else
// --route combat: each first-use event on its own mark, so a program link lands in a named phase.
if (a.route === 'combat') {
  await mark('c-idle'); await sleep(3);
  await ev('window.__game.god(true)');
  await mark('c-give'); await ev("window.__game.give('autorifle',0)"); await sleep(2);
  await mark('c-fire1'); await page.evaluate(() => window.__game.input.button(0, true)); await sleep(1.5);
  await page.evaluate(() => window.__game.input.button(0, false)); await sleep(1.5);
  await mark('c-lineup'); await ev(LINEUP); await sleep(4);
  await mark('c-fire2'); await page.evaluate(() => window.__game.input.button(0, true)); await sleep(2.5);
  await page.evaluate(() => window.__game.input.button(0, false)); await sleep(1.5);
  for (const ab of ['grenade', 'melee', 'class', 'super']) { await mark('c-' + ab); await ev(`window.__game.ability('${ab}')`); await sleep(4); }
  await mark('c-kill'); await ev('window.__game.killAll()'); await sleep(4);
  await mark('end');
} else if (a.route === 'tp') {
  for (const b of ['forest', 'tundra', 'infernal', 'lost', 'void']) {
    await mark('goto-' + b); await ev(`window.__game.goto('${b}', 150)`); await sleep(3.5);
  }
  await mark('end');
} else {

await mark('meadow-idle'); await sleep(4);
await mark('meadow-walk'); await key('KeyW', true); await sleep(5); await key('KeyW', false);
await mark('meadow-sprint'); await key('KeyW', true); await key('ShiftLeft', true); await sleep(6); await key('ShiftLeft', false); await key('KeyW', false);
await mark('spin'); for (let i = 0; i < 24; i++) { await page.evaluate((i) => window.__game.look(i * 0.26, 0), i); await sleep(0.12); }

await mark('combat'); await ev('window.__game.god(true)');
await ev("window.__game.give('autorifle',0)");
await ev(LINEUP);
await sleep(1);
await page.evaluate(() => window.__game.input.button(0, true)); await sleep(3);
await page.evaluate(() => window.__game.input.button(0, false));
for (const ab of ['grenade', 'melee', 'class', 'super']) { await ev(`window.__game.ability('${ab}')`); await sleep(1.6); }
await sleep(2); await ev('window.__game.killAll()'); await sleep(2);
await ev('window.__game.clearEnemies()');

// every region: teleport in, look around, walk. This is where region-first shader/asset work shows up.
const biomes = ['forest', 'tundra', 'celestial', 'dragon', 'infernal', 'lost', 'shadowfen', 'sunken', 'void'];
for (const b of biomes) {
  await mark('goto-' + b);
  await ev(`window.__game.goto('${b}', 150)`);
  await sleep(1.5);
  await mark('look-' + b);
  for (let i = 0; i < 8; i++) { await page.evaluate((i) => window.__game.look(i * 0.785, 0), i); await sleep(0.25); }
  await mark('walk-' + b);
  await key('KeyW', true); await key('ShiftLeft', true); await sleep(PER_BIOME); await key('ShiftLeft', false); await key('KeyW', false);
  await sleep(0.6);
}

// a real border crossing on foot: Vale -> mountain pass -> forest.
await mark('cross-on-foot');
await ev('window.__game.goto("forest", 520)');
await sleep(1.5);
await ev('window.__game.look(Math.atan2(66, -757) , 0)');
await key('KeyW', true); await key('ShiftLeft', true); await sleep(20); await key('ShiftLeft', false); await key('KeyW', false);

await mark('soak'); await ev('window.__game.teleport(0, null, 0)'); await sleep(1); await key('KeyW', true);
await sleep(25); await key('KeyW', false);
await mark('end');
}

// ---- pull the trace ---------------------------------------------------------------------------
const hp = await page.evaluate(() => ({ frames: window.__hp.frames, marks: window.__hp.marks }));
const final = await page.evaluate(() => window.__game.stats());
await browser.close();

const F = hp.frames;
const dts = F.map((f) => f.dt);
const qf = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : 0; };
const phaseOf = (t) => { let l = 'boot'; for (const m of hp.marks) { if (m.t <= t) l = m.label; else break; } return l; };

const spikes = F.filter((f) => f.dt >= SPIKE).map((f) => ({ ...f, phase: phaseOf(f.t) }));
const byPhase = {};
for (const f of F) { const p = phaseOf(f.t); (byPhase[p] ??= []).push(f.dt); }
const phases = Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, { n: v.length, mean: +(v.reduce((x, y) => x + y, 0) / v.length).toFixed(2), p50: qf(v, 0.5), p99: qf(v, 0.99), max: +Math.max(...v).toFixed(2), spikes: v.filter((x) => x >= SPIKE).length }]));

// which system was slowest on spike frames, and how often
const blame = {};
for (const s of spikes) { const k = Object.keys(s.sys ?? {})[0] ?? '(none attributable)'; (blame[k] ??= { n: 0, worst: 0, totalMs: 0 }); blame[k].n++; blame[k].worst = Math.max(blame[k].worst, s.dt); blame[k].totalMs += s.dt; }

const summary = {
  url: base, q, vsync: !a.uncapped, bootMs, frames: F.length, spikeThresholdMs: SPIKE,
  frameMs: { mean: +(dts.reduce((x, y) => x + y, 0) / dts.length).toFixed(2), p50: qf(dts, 0.5), p95: qf(dts, 0.95), p99: qf(dts, 0.99), p999: qf(dts, 0.999), max: +Math.max(...dts).toFixed(2) },
  spikeCount: spikes.length, spikesPerMin: +(spikes.length / (dts.reduce((x, y) => x + y, 0) / 60000)).toFixed(1),
  blame: Object.fromEntries(Object.entries(blame).sort((x, y) => y[1].n - x[1].n)),
  phases, worstSpikes: spikes.sort((x, y) => y.dt - x.dt).slice(0, 30), finalStats: final,
  errors: [...new Set(errors)].slice(0, 40),
};
fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(hp));
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, worstSpikes: summary.worstSpikes.slice(0, 12) }, null, 2));
