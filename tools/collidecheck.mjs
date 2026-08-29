// collidecheck.mjs — COLLISION GATE. `node tools/collidecheck.mjs [--url http://...] [--nolock]`
//
// Drives the running game through window.__game and mechanically asserts the two failure classes the
// user reported ("I can go through buildings / fall through floor"):
//   WALL  sites: teleport ~2 m outside a wall, walk INTO it for 1.5 s, assert the player did not pass
//         through (travel along the walk direction stays under `maxTravel`), and — where a rotated
//         footprint `fp` is declared — that the player did not end up INSIDE the visual footprint
//         (the exact bug: rotated cottages had an axis-aligned collider, corners were penetrable).
//   FLOOR sites: teleport 1.2 m ABOVE a prop floor (bridge deck, isle cap edge, wreck deck, dais,
//         stair top), wait, assert the player rests at floor height (no sink, no fall-through).
//   DOOR  sites: walk a declared opening (the Lost gatehouse arch) and assert it still ADMITS —
//         colliders added for the frame must never seal the doorway.
//
// SITES ARE DATA: procedural sites (cottage corners, stalls, field walls, gate jamb+arch, isle edges,
// bridge decks, wreck decks) are pushed by src/world/Props.js into `props.colProbes` at build time, so
// the probes always match the seed's actual layout. The STATIC list below adds fixed Vale floors.
// Exit 1 on any failure, each failure names its site.
//
// Same two harness rules as questgate.mjs: never return live game objects from evaluate (ev() wraps
// everything in JSON), and a TIMEOUT may be GPU starvation by orphaned chromium, not a real failure.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = (arg('--url', process.env.CADLE_URL || 'http://127.0.0.1:5173/')).replace(/\/$/, '');
const URL = BASE + '/?auto=1&q=low&seed=1337';

// Fixed-coordinate floor sites (Vale landmarks whose placement is not seed-dependent).
// y is resolved in-page as terrain.heightAt(hx,hz) + dy (matching the source that built them).
const STATIC_FLOORS = [
  { name: 'arena-dais', x: -60, z: 260, hx: -60, hz: 260, dy: 0.7 },              // Props._buildArena upper dais top
  { name: 'ruins-stair-top', x: 126, z: 74.5, hx: 126, hz: 78, dy: 2.56 },        // Props._buildRuins 8-step stair, top tread
];

// --- exclusive lock (mkdir mutex, stale after 4 min — same protocol as inspect.mjs) ---
const lockDir = path.resolve('tools/out/.lock');
let unlock = () => {};
if (!process.argv.includes('--nolock')) {
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lockDir, { recursive: false }); fs.writeFileSync(path.join(lockDir, 'owner'), `collidecheck ${process.pid} ${new Date().toISOString()}`); break; }
    catch { try { if (Date.now() - fs.statSync(lockDir).mtimeMs > 240000) fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} await new Promise((r) => setTimeout(r, 1500)); }
    if (Date.now() - t0 > 15 * 60000) { console.error('[collidecheck] lock wait timeout'); break; }
  }
  unlock = () => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { unlock(); process.exit(130); });
}

let failed = false;
const fail = (m) => { console.error('  FAIL: ' + m); failed = true; };
const ok = (m) => console.log('  ok:   ' + m);

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// warn only: a vite full-reload mid-run (another agent editing src) makes even harness predicates throw
// transiently. REAL game exceptions are captured in-page by window.__game.errors and asserted at the end.
page.on('pageerror', (e) => console.warn('  warn: page error: ' + e.message));
const ev = async (fn, a) => page.evaluate(
  ([src, x]) => { const r = (0, eval)('(' + src + ')')(x); return r === undefined ? null : JSON.parse(JSON.stringify(r)); },
  [fn.toString(), a ?? null],
);
const wait = (ms) => page.waitForTimeout(ms);

// Full boot wait, reload-tolerant: an agent editing src while we run makes vite full-reload the page,
// which briefly leaves window.__game undefined — every predicate must be optional-chained end to end.
const boot = async () => {
  await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
  await page.evaluate(() => window.__game?.intro?.skip?.());
  await page.waitForFunction(() => !!window.__game?.game?.world?.props && !!window.__game?.state, null, { timeout: 180000 });
  // the world builds asynchronously after the systems exist — wait for the probe sites (pushed at the
  // END of the props build) and for the game loop to actually be ticking before trusting any physics
  await page.waitForFunction(() => (window.__game?.game?.world?.props?.colProbes ?? []).length >= 10, null, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => (window.__game?.stats?.()?.fps ?? 0) > 5, null, { timeout: 60000 }).catch(() => {});
  // PlayerController.init() snaps y to terrain+0.1 and can land AFTER an early teleport (async system
  // init straggles past first render) — which stomps the first floor probe into a phantom "fell through",
  // and a not-yet-ticking loop freezes a floor probe at teleport height (a phantom PASS). grounded===true
  // can ONLY be set by a real physics update landing the player at spawn: the one honest "physics live".
  await page.waitForFunction(() => window.__game?.game?.player?.controller?.grounded === true, null, { timeout: 120000 });
  await wait(2000);
  await ev(() => { window.__game.god(true); window.__game.passive?.(true); });
};
try {
  console.log('[collidecheck] booting ' + URL);
  await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
  await boot();
  ok('booted');

  const readSites = () => ev((sf) => {
    const g = window.__game?.game, list = (g?.world?.props?.colProbes ?? []).slice();
    for (const s of sf) list.push({ kind: 'floor', name: s.name, x: s.x, z: s.z, y: g.terrain.heightAt(s.hx, s.hz) + s.dy });
    return list;
  }, STATIC_FLOORS);
  let sites = await readSites();
  if (sites.length < 10) { await boot(); sites = await readSites(); }   // a reload mid-boot leaves colProbes empty for a while — go around once
  console.log(`[collidecheck] ${sites.length} sites (${sites.filter((s) => s.kind === 'wall').length} wall, ${sites.filter((s) => s.kind === 'floor').length} floor, ${sites.filter((s) => s.kind === 'door').length} door)`);
  if (sites.length < 10) fail(`only ${sites.length} probe sites — props.colProbes did not populate; the gate is not testing anything`);

  for (const s of sites) {
    if (s.kind === 'floor') {
      await ev((p) => { window.__game.teleport(p.x, p.y + 1.2, p.z); return 1; }, s);
      // wait for the drop to SETTLE (y stable across 400 ms), not a fixed 1.4 s: under GPU contention the
      // fall itself can take seconds of wall time and a mid-fall read is a phantom "floating" failure
      let y = await ev(() => window.__game.game.player.position.y), y0 = y + 9;
      for (let i = 0; i < 20 && Math.abs(y - y0) > 0.02; i++) { y0 = y; await wait(400); y = await ev(() => window.__game.game.player.position.y); }
      if (y < s.y - 0.35) fail(`${s.name}: SANK/FELL THROUGH floor — rest y ${y.toFixed(2)} vs expected ${s.y.toFixed(2)} (${(s.y - y).toFixed(2)} m below)`);
      else if (y > s.y + 1.2) fail(`${s.name}: floating ${(y - s.y).toFixed(2)} m ABOVE the floor (invisible collider?) at (${s.x.toFixed(0)}, ${s.z.toFixed(0)})`);
      else ok(`${s.name}: stands at y ${y.toFixed(2)} (expected ${s.y.toFixed(2)})`);
    } else {
      // wall or door: teleport to start, face the walk direction, hold W
      const dur = (s.dur ?? 1.5) * 1000;
      await ev((p) => {
        const G = window.__game;
        G.teleport(p.sx, null, p.sz);
        G.look(Math.atan2(-p.dx, -p.dz), 0);           // yaw 0 = -Z; walking W moves along (-sin yaw, -cos yaw)
        return 1;
      }, s);
      await wait(400);
      const start = await ev(() => { const p = window.__game.game.player.position; window.__game.input.press('KeyW'); return { x: p.x, z: p.z }; });
      // the first frames after a cross-map teleport can stall 1-2 s (camp streaming + shader links eat the
      // clamped dt), so time the walk from when the player actually MOVES — otherwise 0.0 m travel is
      // ambiguous between "blocked" (pass) and "input never engaged" (a probe that tested nothing).
      let engaged = false;
      for (let i = 0; i < 40 && !engaged; i++) {
        await wait(150);
        const q = await ev(() => { const p = window.__game.game.player.position; return { x: p.x, z: p.z }; });
        engaged = Math.hypot(q.x - start.x, q.z - start.z) > 0.25;
      }
      if (!engaged) {
        await ev(() => { window.__game.input.release('KeyW'); return 1; });
        fail(`${s.name}: player never moved after 6 s of holding W — probe tested nothing (stall or spawn-stuck)`);
        continue;
      }
      let end;
      if (s.kind === 'door') {
        // a door probe asserts DISTANCE, not speed: succeed the moment minTravel is reached, and only give
        // up after a generous cap — a fixed walk duration fails spuriously when GPU contention time-slices
        // the walk (observed: 9.2 m of 13 m in 3.5 s on a healthy collider path).
        let travel = 0;
        for (let i = 0; i < 80 && travel < s.minTravel; i++) {
          await wait(150);
          end = await ev(() => { const p = window.__game.game.player.position; return { x: p.x, z: p.z }; });
          travel = (end.x - start.x) * s.dx + (end.z - start.z) * s.dz;
        }
        await ev(() => { window.__game.input.release('KeyW'); return 1; });
        if (travel < s.minTravel) fail(`${s.name}: DOORWAY BLOCKED — walked only ${travel.toFixed(1)} m of ${s.minTravel} m through the opening in 12 s`);
        else ok(`${s.name}: doorway admits (${travel.toFixed(1)} m)`);
        continue;
      }
      await wait(dur);
      end = await ev(() => { window.__game.input.release('KeyW'); const p = window.__game.game.player.position; return { x: p.x, z: p.z }; });
      const travel = (end.x - start.x) * s.dx + (end.z - start.z) * s.dz;
      {
        let inside = false;
        if (s.fp) {   // end position in the prop's local (rotated) frame — inside the visual footprint = penetration
          const c = Math.cos(s.fp.ry), si = Math.sin(s.fp.ry), wx = end.x - s.fp.cx, wz = end.z - s.fp.cz;
          const lx = wx * c - wz * si, lz = wx * si + wz * c;
          inside = Math.abs(lx) < s.fp.hw && Math.abs(lz) < s.fp.hd;
        }
        // Sliding AROUND a wall into open passage is legitimate (collision deflects along rotated faces —
        // the Lost gate jamb sits beside an 18 m open arch). A true tunnel-through keeps the player ON the
        // walk line, so "walked through" = big travel WITH small lateral drift; big travel with big lateral
        // drift is a deflection, and the footprint check still catches ending up inside the prop either way.
        const lat = Math.abs((end.x - start.x) * s.dz - (end.z - start.z) * s.dx);
        if (inside) fail(`${s.name}: PENETRATED — player ended inside the prop's footprint after ${travel.toFixed(1)} m`);
        else if (travel > s.maxTravel && lat < 1.5) fail(`${s.name}: WALKED THROUGH — travelled ${travel.toFixed(1)} m along the wall normal (limit ${s.maxTravel}, lateral drift only ${lat.toFixed(1)} m)`);
        else if (travel > s.maxTravel) ok(`${s.name}: deflected around (travel ${travel.toFixed(1)} m, lateral ${lat.toFixed(1)} m, footprint clear)`);
        else ok(`${s.name}: blocked at ${travel.toFixed(1)} m (limit ${s.maxTravel})`);
      }
    }
  }

  const errs = await ev(() => (window.__game.errors || []).length);
  if (errs) fail(`${errs} uncaught page error(s) during the run: ` + JSON.stringify(await ev(() => (window.__game.errors || []).slice(0, 3))));
} catch (e) {
  fail('harness error (check for orphaned chromium starving the GPU before believing it): ' + e.message);
} finally {
  await browser.close().catch(() => {});
  unlock();
}
console.log(failed ? '\n[collidecheck] FAIL' : '\n[collidecheck] all OK');
process.exit(failed ? 1 : 0);
