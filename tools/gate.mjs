// gate.mjs — REGRESSION GATE. `node tools/gate.mjs` must exit 0 before any builder reports done;
// critics run it and any failure = automatic LOSE (user decree, see CLAUDE.md).
// Checks: 1) washed-white blobs in the meadow  2) screen jitter (static camera)  3) pointer lock
// (acquires on click, survives the unadjustedMovement rejection path, re-acquires after exit).
// 1+2 run through inspect.mjs (tools/gate-steps.json) + gate.py; 3 runs its own Playwright session.
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.CADLE_URL || 'http://127.0.0.1:5173/';
const URL = BASE.replace(/\/$/, '') + '/?q=low&seed=1337'; // NO auto: test the real click-to-start + pointer lock path
let failed = false;

// EXCLUSIVITY. inspect.mjs warns about orphaned browsers and carries on, which is right for a scoped
// burst and wrong here: the gate captures 88 frames per quality and a starved run truncates, which
// then reads as a failure rather than as an aborted measurement. That has now cost two full re-runs
// (2026-08-23) — once as a fake BLOBCHECK FAIL on an unmasked frame, once as INCONCLUSIVE at 8 of 88
// frames. Fail fast instead: a gate that produces an untrustworthy verdict is worse than one that
// refuses to start. Set CADLE_GATE_FORCE=1 to override.
if (!process.env.CADLE_GATE_FORCE) {
  const ps = spawnSync(process.platform === 'win32' ? 'powershell' : 'sh',
    process.platform === 'win32'
      ? ['-NoProfile', '-Command', '@(Get-Process chrome-headless-shell -ErrorAction SilentlyContinue).Count']
      : ['-c', 'pgrep -c chrome-headless-shell || true'],
    { encoding: 'utf8' });
  const n = parseInt(String(ps.stdout || '0').trim(), 10) || 0;
  if (n > 0) {
    console.error(`[gate] ==== NOT STARTING ====`);
    console.error(`[gate] ${n} chrome-headless-shell process(es) are already running.`);
    console.error('[gate] The gate captures 88 frames per quality and needs the GPU to itself; a starved run');
    console.error('[gate] truncates, and a truncated capture reads as a failure it did not earn.');
    console.error('[gate] Reap them and re-run, or set CADLE_GATE_FORCE=1 if you know what you are doing:');
    console.error('[gate]   Get-Process chrome-headless-shell | Stop-Process -Force');
    process.exit(3);
  }
}

// --- 0: IS THE THING WE ARE JUDGING EVEN THERE? -----------------------------------------------------
// A dead dev server made every visual check fail and the gate printed "GATE FAILED", which reads as
// "your change is broken" and costs a builder a full investigation before they think to curl the port.
// It is worse in worktrees: 5173 is the MAIN checkout, so a worktree agent who forgets CADLE_URL either
// judges the WRONG BUILD (server up, different tree) or gets a phantom failure (server down). Fail here,
// loudly, with the URL we are about to use — a gate that cannot reach the game has not judged anything.
{
  let ok = false, why = '';
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(4000) });
    ok = res.ok; why = `HTTP ${res.status}`;
  } catch (e) { why = e?.cause?.code ?? e?.name ?? String(e); }
  if (!ok) {
    console.error(`[gate] cannot reach the game at ${BASE} (${why}).`);
    console.error('[gate] The gate judges a RUNNING game; with no server it would report failures it did not earn.');
    console.error('[gate] Start the dev server for THIS worktree and point the gate at it, e.g.');
    console.error('[gate]   npx vite --port 5185 --strictPort --host 127.0.0.1 &');
    console.error('[gate]   CADLE_URL=http://127.0.0.1:5185/ node tools/gate.mjs');
    console.error('[gate] (CADLE_URL defaults to 5173, which serves the MAIN checkout — in a worktree that is');
    console.error('[gate]  the wrong build even when it answers.)');
    process.exit(3);
  }
  console.log(`[gate] target ${BASE} is up.`);
}

console.log('[gate] source invariants...');
{
  const r0 = spawnSync('node', ['tools/invariants.mjs'], { stdio: 'inherit' });
  if (r0.status !== 0) failed = true;
}

// --- 1+2: screenshots + analysis, at BOTH quality levels ---
// (blobs have shipped at q=low while q=high looked clean, and jitter only shows at q=high — check both)
for (const q of ['high', 'low']) {
  console.log(`[gate] visual checks (blobs, jitter) @ q=${q}...`);
  const dir = `gate-${q}`;
  // 600s: the suite gained the dawn burst, and the volumetric clouds actually render since the GLSL3
  // fix — a q=high run is legitimately ~8 min. A timeout kill leaves no report.json and fails the gate.
  const r1 = spawnSync('node', ['tools/inspect.mjs', '--nolock', '--name', dir, '--q', q, '--script', 'tools/gate-steps.json', '--url', BASE], { stdio: 'inherit', timeout: 600000 });
  if (r1.status !== 0) { console.error(`[gate] harness run failed @ q=${q}`); failed = true; continue; }
  const r2 = spawnSync('python', ['tools/gate.py', `tools/out/${dir}`], { stdio: 'inherit' });          // jitter
  if (r2.status !== 0) failed = true;
  const r3 = spawnSync('python', ['tools/blobcheck.py', `tools/out/${dir}`, 'burst-blob-'], { stdio: 'inherit' }); // blobs: bright-any-hue + flashing
  if (r3.status !== 0) failed = true;
}

// --- 1b: COMBAT-VFX white-out check (the wave-5 coverage hole) ---
// Five regions shipped with "fighting the region's own bestiary blows the screen to white" while this
// gate PASSED, because blobcheck is scoped to ground cover in a scripted meadow burst. This scenario
// spawns each region's own bestiary at 8-18 m, aggroes it, has every enemy take a hit, and never fires
// the player's gun; combatcheck.py then fails any frame where the visible world goes near-white
// DESATURATED (a hue that survives tone mapping passes by construction — the decree is "saturate the
// colour, cap the intensity"). Runs at q=high only: bloom thresholds, exposure and ACES are identical
// across quality presets (verified 2026-08-27 — presets differ only in pixelRatio/shadows/aniso), so
// quality cannot be the variable that hides or causes a wash.
{
  console.log('[gate] combat-VFX white-out check (10 regions, ~10 min)...');
  const r1 = spawnSync('node', ['tools/inspect.mjs', '--nolock', '--name', 'gate-combat', '--q', 'high', '--script', 'tools/scripts/combat-blob-steps.json', '--url', BASE], { stdio: 'inherit', timeout: 1200000 });
  if (r1.status !== 0) { console.error('[gate] combat harness run failed'); failed = true; }
  else {
    const r2 = spawnSync('python', ['tools/combatcheck.py', 'tools/out/gate-combat'], { stdio: 'inherit' });
    if (r2.status !== 0) failed = true;
  }
}

// --- 2b: animation gate (HANDOVER job 5: fold animcheck in so it runs with the others) ---
// Numeric checks on the live bone hierarchy (T-pose, foot slide, moonwalk, sunk/hover feet, stepped
// pose, dead idle, flat attack, missing death). Thresholds live in animcheck's LIMITS block and are
// orchestrator-owned. It drives its own headless Chromium, so it runs after the visual captures.
{
  console.log('[gate] animation gate (animcheck)...');
  const r = spawnSync('node', ['tools/animcheck.mjs', '--name', 'gate-anim', '--url', BASE], { stdio: 'inherit', timeout: 1200000 });
  if (r.status !== 0) { console.error('[gate] animation gate failed'); failed = true; }
}

// --- 2c: collision gate ---
// The user could walk through buildings and fall through prop floors (collider DATA gaps on rotated
// props and floor decks). collidecheck drives the player into 23 probe sites (wall penetration, floor
// sink, doorway-admits) and fails on any named site. ~3 min. Sites live in tools/collidecheck.mjs.
{
  console.log('[gate] collision check (collidecheck)...');
  const r = spawnSync('node', ['tools/collidecheck.mjs', '--url', BASE], { stdio: 'inherit', timeout: 420000 });
  if (r.status !== 0) { console.error('[gate] collision gate failed'); failed = true; }
}

// --- 3: pointer lock behavior ---
console.log('[gate] pointer lock check...');
try {
  const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => !!window.__game || !!document.querySelector('canvas'), { timeout: 30000 });
  // The cinematic intro owns the screen (and the clicks) until it hands the canvas over, so clicking 4 s
  // after load now lands on the intro, not the game — which is what "pointer lock did not engage" meant the
  // first time this ran against it. Skip it and wait for the game to actually be running before testing the
  // real click-to-lock path. Without this the check races the intro and fails intermittently.
  await page.evaluate(() => window.__game?.intro?.skip?.());
  await page.waitForFunction(() => window.__game?.game?.started === true || !!document.getElementById('start'), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const click = () => page.mouse.click(640, 360);
  await click(); await page.waitForTimeout(500);
  let locked = await page.evaluate(() => !!document.pointerLockElement);
  if (!locked) { await click(); await page.waitForTimeout(800); locked = await page.evaluate(() => !!document.pointerLockElement); }
  if (!locked) { console.error('[gate] FAIL: pointer lock did not engage after clicking the game'); failed = true; }
  else {
    // exit, wait out Chrome's relock cooldown, click again — must re-acquire
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForTimeout(1600);
    await click(); await page.waitForTimeout(800);
    const relocked = await page.evaluate(() => !!document.pointerLockElement);
    if (!relocked) { console.error('[gate] FAIL: pointer lock did not RE-acquire after exit + click (regression: mouse escapes the window)'); failed = true; }
    else console.log('[gate] pointer lock OK (engage + re-acquire)');
  }
  await browser.close();
} catch (e) { console.error('[gate] pointer lock check errored:', e.message); failed = true; }

console.log(failed ? '[gate] ==== GATE FAILED ====' : '[gate] ==== GATE PASSED ====');
process.exit(failed ? 1 : 0);
