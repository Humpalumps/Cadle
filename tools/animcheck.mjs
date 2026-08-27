#!/usr/bin/env node
// ANIMATION GATE.  node tools/animcheck.mjs [--name label] [--types a,b,c] [--url ...] [--calibrate]
//
// WHY THIS EXISTS: "the creature animates" has been asserted in reports and never once measured. A
// mannequin sliding across the ground, a T-posed spawn, feet buried in the terrain and a creature
// walking backwards all look fine in a single still, and a still is all anyone ever captured. Every
// check below is NUMERIC and read straight off the live bone hierarchy — pixels are captured too,
// but only so a human can see WHY a number failed, never as the evidence itself.
//
// What it measures, per creature, per state:
//   bindDelta     max angular deviation of any bone from its BIND pose. ~0 means the rig never left
//                 bind: a T-pose. This is the check that catches a body wired up but never driven.
//   motion        mean per-frame summed |angular delta| across all bones. Separates a posed-but-
//                 frozen creature from an animated one, and idle from locomotion.
//   limbPerMetre  limb-bone angular travel divided by ground distance covered. THE foot-slide test:
//                 a creature that translates without cycling its limbs is a mannequin on rails.
//   groundGap     mesh world-bbox minimum Y minus terrain.heightAt at its feet. Negative = sunk into
//                 the world, large positive = hovering (expected only for def.flying).
//   facing        dot(root forward, velocity direction). Negative = moonwalking.
//   heightM       world bbox height vs def.height * def.scale — catches a bad normalisation.
//
// Thresholds live in LIMITS below and are ORCHESTRATOR-OWNED. Run --calibrate to print the numbers
// without failing, which is how you set them honestly the first time; do not widen a threshold to
// make a red build green.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => { if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]); return a; }, []));
const name = args.name || 'animcheck';
const base = args.url || process.env.CADLE_URL || 'http://127.0.0.1:5179/';
const calibrate = !!args.calibrate;
const outDir = path.resolve('tools/out', name);
fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });

// Calibrated 2026-08-27 against the live build. Deliberately loose: this gate exists to catch a rig
// that is DEAD or a body that is in the wrong place, not to police animation taste.
const LIMITS = {
  bindDeltaMin: 0.05,      // rad — below this the creature never leaves its bind pose (T-pose)
  idleMotionMin: 0.0008,   // rad/frame summed over bones — a living creature is never perfectly still
  moveMotionMin: 0.010,    // rad/frame while actually travelling
  limbPerMetreMin: 0.12,   // rad of limb travel per metre of ground covered — below this it slides
  groundGapMin: -0.35,     // m — more negative than this and it is buried
  groundGapMax: 0.60,      // m — higher than this and a walker is hovering (flyers are exempt)
  heightTol: 0.55,         // fraction — |measured / expected - 1| may not exceed this
  // A creature close enough to read must animate on EVERY frame. Anything above this fraction of
  // held frames means Enemy.update's animEvery band is stepping the pose where it is still visible.
  heldFracMax: 0.20,
  // ...AND the held frames must alternate with moving ones. Settling to rest is not strobing.
  alternationMin: 0.25,
};

const browser = await chromium.launch({
  headless: !args.headed,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720'],
});
let reaped = false;
const reap = async () => { if (reaped) return; reaped = true; try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]); } catch {} };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reap().finally(() => process.exit(130)); });
process.on('uncaughtException', (e) => { console.error('[animcheck]', e?.message || e); reap().finally(() => process.exit(1)); });

const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message + ' || ' + (e.stack || '').split(/\r?\n/).slice(0, 4).join(' | ')));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${base}${base.includes('?') ? '&' : '?'}auto=1&q=high&seed=1337`, { waitUntil: 'domcontentloaded', timeout: 120000 });
// Probe _running, NOT state(): __game.state() calls VFX.stats(), which reads this.add.n and throws
// while VFX is still constructing. Same probe inspect.mjs uses.
await page.waitForFunction(() => window.__game && (window.__game.errors?.length > 0 || window.__game.game?._running), null, { timeout: 150000 });
await page.waitForTimeout(4000);

// FAIL FAST ON A BROKEN BOOT. The readiness probe above also resolves on __game.errors, so a game
// that threw during init reaches here with only the early stub on window — and every check below
// then fails with a confusing "G.god is not a function" instead of the real cause.
const booted = await page.evaluate(() => typeof window.__game?.god === 'function' && !!window.__game?.game?._running);
if (!booted) {
  fs.writeFileSync(path.join(outDir, 'anim-report.json'), JSON.stringify({ name, url: base, bootFailed: true, errors }, null, 1));
  console.error('[animcheck] THE GAME DID NOT BOOT — nothing to measure. Page errors:');
  for (const e of errors.slice(0, 10)) console.error('   ' + e);
  await reap(); process.exit(2);
}

// ---------------------------------------------------------------- the in-page sampler
// Installed once. sample(ms) accumulates bone deltas across real animation frames and returns the
// aggregate, so the numbers are frame-rate independent (per-frame means, not per-second sums).
await page.evaluate(() => {
  const T = window.__animcheck = {};
  T.attach = (e) => { T.e = e; T.prev = null; };
  T.sample = (ms) => new Promise((resolve) => {
    const e = T.e;
    if (!e) return resolve(null);
    const bones = e.boneList || [];
    // limb bones = anything the semantic map named as a limb joint, else every bone below the root
    const isLimb = (b) => /hip|knee|foot|shoulder|elbow|hand|_L\d|L\d[RL]_/i.test(b.name || '');
    const limbs = bones.filter(isLimb);
    let frames = 0, motion = 0, limbMotion = 0, bindMax = 0, telegraphMax = 0, flashMax = 0;
    const perFrame = [];        // every frame's total bone delta — see the STEPPED POSE check below
    let p0 = null, dist = 0, facingDot = 0, facingN = 0;
    let gapMin = 1e9, gapMax = -1e9, hMin = 1e9, hMax = -1e9;
    const prevQ = bones.map((b) => b.quaternion.clone());
    const t0 = performance.now();
    const step = () => {
      if (!e.alive && !e.state) return resolve(null);
      let m = 0, lm = 0;
      for (let i = 0; i < bones.length; i++) {
        const b = bones[i], d = prevQ[i].angleTo(b.quaternion);
        m += d; if (isLimb(b)) lm += d;
        prevQ[i].copy(b.quaternion);
        // deviation from BIND. GLB assets carry bindQuat (a Tripo bind pose is not identity);
        // procedural rigs bind at identity, so an identity clone is the right comparand there.
        const bind = e.asset?.bindQuat?.[i] || (T._id ??= b.quaternion.clone().identity());
        bindMax = Math.max(bindMax, bind.angleTo(b.quaternion));
      }
      if (frames > 0) { motion += m; limbMotion += lm; perFrame.push(m); }   // frame 0 is the priming delta, discard
      // Not every creature telegraphs with its SKELETON. A wisp/imp is a glow orb whose wind-up is
      // emissive and scale, so a bone-only gate calls its attack flat when it is doing exactly what
      // it was designed to do. e.telegraph is the game's own universal wind-up signal — read it.
      telegraphMax = Math.max(telegraphMax, e.telegraph || 0);
      flashMax = Math.max(flashMax, e.flash || 0);
      frames++;
      const p = e.position;
      if (p0) { const dx = p.x - p0.x, dz = p.z - p0.z; const d = Math.hypot(dx, dz); dist += d;
        if (d > 1e-3) { const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw); facingDot += (dx * fx + dz * fz) / d; facingN++; } }
      p0 = { x: p.x, z: p.z };
      // Vertical extent from BONE world positions rather than a mesh Box3 — no THREE import needed
      // in the page, and it is the right proxy anyway: joint centres sit a little inside the skin,
      // so the thresholds are calibrated against bones, not against a true silhouette box.
      let lo = 1e9, hi = -1e9;
      for (const b of bones) { const y = b.matrixWorld.elements[13]; if (y < lo) lo = y; if (y > hi) hi = y; }
      if (lo < 1e8) {
        const g = window.__game.game.terrain.heightAt(p.x, p.z);
        gapMin = Math.min(gapMin, lo - g); gapMax = Math.max(gapMax, lo - g);
        hMin = Math.min(hMin, hi - lo); hMax = Math.max(hMax, hi - lo);
      }
      if (performance.now() - t0 < ms) requestAnimationFrame(step);
      else resolve({
        frames, state: e.state, limbBones: limbs.length, telegraphMax, flashMax,
        // STEPPED POSE / STROBING. Enemy.update rate-limits _animate by camera distance and HOLDS
        // the pose between updates instead of interpolating, so past the full-rate band the skeleton
        // strobes at 1/2, 1/3, 1/4 the render rate while the root keeps gliding every frame. That
        // reads in-game as a creature swaying or jittering on the spot, and the user found it by eye
        // because every other metric here is a MEAN — and a mean is identical whether the pose moves
        // smoothly or in held steps. heldFrac is the fraction of frames where the pose did not move.
        heldFrac: (() => {
          if (perFrame.length < 12) return null;
          const nz = perFrame.filter((d) => d > 1e-4);
          if (!nz.length) return 1;
          const mean = nz.reduce((a, c) => a + c, 0) / nz.length;
          return perFrame.filter((d) => d < mean * 0.15).length / perFrame.length;
        })(),
        // held frames ALONE do not prove strobing: a creature that damps to rest at its standoff ring
        // is legitimately still, and that read 32% held at 4 m where the pose is definitionally
        // updated every frame. What separates the two is that strobing ALTERNATES - held, moving,
        // held, moving - while settling is one contiguous quiet run. So count the transitions.
        alternation: (() => {
          if (perFrame.length < 12) return null;
          const nz = perFrame.filter((d) => d > 1e-4);
          if (!nz.length) return 0;
          const mean = nz.reduce((a, c) => a + c, 0) / nz.length;
          const held = perFrame.map((d) => d < mean * 0.15);
          let flips = 0;
          for (let k = 1; k < held.length; k++) if (held[k] !== held[k - 1]) flips++;
          return flips / (held.length - 1);
        })(),
        camDist: (() => { const c = window.__game.game.camera.position, q = e.position; return Math.hypot(c.x - q.x, c.y - q.y, c.z - q.z); })(),
        motion: frames > 1 ? motion / (frames - 1) : 0,
        limbMotion: frames > 1 ? limbMotion / (frames - 1) : 0,
        limbPerMetre: dist > 0.25 ? limbMotion / dist : null,
        bindDelta: bindMax, dist,
        facing: facingN ? facingDot / facingN : null,
        groundGap: gapMin < 1e8 ? (gapMin + gapMax) / 2 : null,
        heightM: hMin < 1e8 ? (hMin + hMax) / 2 : null,
      });
    };
    requestAnimationFrame(step);
  });
});

const types = (args.types ? String(args.types).split(',') : await page.evaluate(() => Object.keys(window.__game.game.enemies.types))).map((s) => s.trim()).filter(Boolean);
const report = { name, url: base, at: new Date().toISOString(), limits: LIMITS, creatures: [], errors: [] };

for (const type of types) {
  const rec = { type, states: {}, fails: [] };
  try {
    const meta = await page.evaluate(async (t) => {
      const G = window.__game;
      G.god(true); G.clearEnemies(); G.passive(true);
      const p = G.game.player.position;
      const e = G.spawn(t, p.x + 18, p.z);
      if (!e) return null;
      window.__animcheck.attach(e);
      const d = G.game.enemies.types[t];
      return { flying: !!d.flying, scale: d.scale ?? 1, defHeight: d.height || 0, hover: d.hover ?? 0, glb: !!e.asset?.glb };
    }, type);
    if (!meta) { rec.fails.push('spawn returned null'); report.creatures.push(rec); continue; }
    rec.glb = meta.glb; rec.flying = meta.flying;

    await page.waitForTimeout(600);
    rec.states.idle = await page.evaluate(() => window.__animcheck.sample(1600));

    // chase: let it come at the player under its own AI, which is the only honest locomotion test
    await page.evaluate(() => { window.__game.passive(false); const e = window.__animcheck.e; e.alert = true; e.seen = true; });
    await page.waitForTimeout(700);
    rec.states.move = await page.evaluate(() => window.__animcheck.sample(2600));
    await page.screenshot({ path: path.join(outDir, `${type}-move.png`) });

    // Wait for the creature to actually BE attacking before sampling it. Sampling a fixed window
    // after locomotion mostly catches it standing on its standoff ring, which is not an attack.
    try {
      await page.waitForFunction(() => ['attack', 'stagger'].includes(window.__animcheck.e?.state), null, { timeout: 12000 });
    } catch { rec.attackNeverFired = true; }
    rec.states.attack = await page.evaluate(() => window.__animcheck.sample(2000));

    await page.evaluate(() => window.__game.killAll());
    await page.waitForTimeout(200);
    rec.states.death = await page.evaluate(() => window.__animcheck.sample(1200));
    await page.screenshot({ path: path.join(outDir, `${type}-death.png`) });

    // ---- verdicts
    const m = rec.states.move, i = rec.states.idle, a = rec.states.attack, d = rec.states.death;
    const F = (s) => rec.fails.push(s);
    if (m) {
      if (m.bindDelta < LIMITS.bindDeltaMin) F(`T-POSE: never leaves bind pose (bindDelta ${m.bindDelta.toFixed(3)} rad < ${LIMITS.bindDeltaMin})`);
      if (m.motion < LIMITS.moveMotionMin) F(`FROZEN while moving (motion ${m.motion.toFixed(4)} < ${LIMITS.moveMotionMin})`);
      for (const [label, st] of [['moving', m], ['idle', i]]) {
        if (st && st.heldFrac !== null && st.heldFrac > LIMITS.heldFracMax && (st.alternation ?? 0) > LIMITS.alternationMin) {
          F(`STEPPED POSE while ${label}: ${(st.heldFrac * 100).toFixed(0)}% of frames hold the pose, alternating ${(st.alternation * 100).toFixed(0)}% of the time, at ${st.camDist?.toFixed(0)} m — the skeleton is strobing, not animating`);
        }
      }
      // FOOT SLIDE is a WALKER-ONLY test, and calibration proved it: the only five creatures that
      // failed the first full run were all flyers (wisp, imp, drake, skyserpent, leviathan). A
      // serpent has no legs and a wisp is a glow orb, so "limb rotation per metre travelled" is
      // meaningless for them — and a gate that cries wolf is a gate nobody reads. Flyers and
      // limbless bodies are covered by the moveMotionMin check above instead, which is the right
      // question for them: is the body doing ANYTHING while it travels.
      const walker = !meta.flying && m.limbBones > 0;
      if (walker && m.dist > 1 && m.limbPerMetre !== null && m.limbPerMetre < LIMITS.limbPerMetreMin) F(`FOOT SLIDE: ${m.limbPerMetre.toFixed(3)} rad of limb travel per metre (< ${LIMITS.limbPerMetreMin}) over ${m.dist.toFixed(1)} m`);
      if (!walker && m.dist > 1 && m.motion < LIMITS.moveMotionMin * 2) F(`RAILS: limbless/flying body barely deforms while travelling ${m.dist.toFixed(1)} m (motion ${m.motion.toFixed(4)})`);
      if (m.facing !== null && m.facing < -0.2) F(`MOONWALK: travelling backwards (facing dot ${m.facing.toFixed(2)})`);
      if (!meta.flying && m.groundGap !== null) {
        if (m.groundGap < LIMITS.groundGapMin) F(`SUNK: feet ${m.groundGap.toFixed(2)} m below terrain`);
        if (m.groundGap > LIMITS.groundGapMax) F(`HOVERING: feet ${m.groundGap.toFixed(2)} m above terrain (not a flyer)`);
      }
      const expect = (meta.defHeight || 0) * (meta.scale || 1);
      if (expect > 0.2 && m.heightM && Math.abs(m.heightM / expect - 1) > LIMITS.heightTol) F(`SIZE: bbox ${m.heightM.toFixed(2)} m vs def ${expect.toFixed(2)} m`);
    } else F('no move sample');
    if (i && i.motion < LIMITS.idleMotionMin) F(`DEAD IDLE: perfectly still at rest (motion ${i.motion.toFixed(5)})`);
    // Compare an attack against STANDING STILL, not against running. A melee creature attacks from
    // its standoff ring with its legs planted, so locomotion is the wrong comparand and using it
    // failed a hound whose attack was fine — the question is "does the attack animate more than
    // just standing there", and that is idle.
    if (a && i && !rec.attackNeverFired && a.motion < Math.max(i.motion * 1.5, LIMITS.idleMotionMin) && (a.telegraphMax ?? 0) < 0.15) F(`FLAT ATTACK: no skeletal wind-up (${a.motion.toFixed(4)} vs idle ${i.motion.toFixed(4)}) AND no telegraph (${(a.telegraphMax ?? 0).toFixed(2)})`);
    if (rec.attackNeverFired) rec.fails.push('ATTACK NEVER FIRED: creature never entered the attack state within 12 s of engaging');
    if (d && d.motion < LIMITS.idleMotionMin) F('DEATH DOES NOT PLAY: no bone motion during the death window');
  } catch (e) {
    rec.fails.push('threw: ' + (e?.message || e));
  }
  report.creatures.push(rec);
  const tag = rec.fails.length ? 'FAIL' : 'ok  ';
  console.log(`${tag} ${type.padEnd(12)} ${rec.glb ? 'glb' : 'proc'} ${rec.fails.join(' | ')}`);
}

report.errors = errors.slice(0, 40);
fs.writeFileSync(path.join(outDir, 'anim-report.json'), JSON.stringify(report, null, 1));
await reap();

const bad = report.creatures.filter((c) => c.fails.length);
console.log(`\n[animcheck] ${report.creatures.length - bad.length}/${report.creatures.length} clean -> ${path.join(outDir, 'anim-report.json')}`);
if (calibrate) { console.log('[animcheck] --calibrate: not failing the build'); process.exit(0); }
if (bad.length) { console.error(`[animcheck] FAIL: ${bad.map((c) => c.type).join(', ')}`); process.exit(1); }
console.log('[animcheck] PASS');
