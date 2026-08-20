// invariants.mjs — SOURCE INVARIANTS. `node tools/invariants.mjs` — instant, no dev server.
// Run this before you touch anything and again before you report done; tools/gate.mjs runs it too.
// Each rule below encodes a bug that has shipped MORE THAN ONCE. They kept coming back because a
// later builder wrote a NEW code path that the prose rule in CLAUDE.md did not literally name.
// Thresholds are orchestrator-owned: if a rule blocks legitimate work, say so in your report.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
let failed = false;
// ---------------------------------------------------------------- 0: SOURCE INVARIANTS
// Deterministic, instant, no dev server needed. These encode bugs that have shipped repeatedly:
// each one decayed because a later builder wrote a NEW code path that the prose rule did not name.
// A source rule cannot be missed the way a paragraph in CLAUDE.md can.
const srcFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) srcFiles.push(p);
  }
})('src');
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

console.log('[invariants] checking...');
// (a) POINTER LOCK: exactly one lock path. Every regression of "the mouse escapes / camera stops at
//     the screen edge" came from a builder adding their own requestPointerLock without the
//     unadjustedMovement-rejection + relock-cooldown handling that Input.lock() has.
for (const f of srcFiles) {
  if (f.endsWith(join('core', 'Input.js'))) continue;
  if (/requestPointerLock/.test(read(f))) {
    console.error(`[invariants] FAIL: ${f} calls requestPointerLock directly — use Input.lock(canvas), the single lock path (it handles unadjustedMovement rejection + Chrome's relock cooldown; bypassing it is how the mouse keeps escaping the window)`);
    failed = true;
  }
}
const inputSrc = read(join('src', 'core', 'Input.js'));
if (!/static lock\s*\(/.test(inputSrc)) { console.error('[invariants] FAIL: Input.lock() is gone — the single pointer-lock path must exist'); failed = true; }
if (!/setTimeout/.test(inputSrc) || !/catch/.test(inputSrc)) { console.error('[invariants] FAIL: Input.lock() lost its rejection fallback / relock retry — the mouse will escape again'); failed = true; }

// (b) GROUND COVER IS NEVER EMISSIVE: the flashing white/blue blob bug (shipped 4x, 4 different causes).
const grass = read(join('src', 'world', 'Grass.js'));
if (grass) {
  const ceil = grass.match(/vGrassEmissive\s*=\s*min\s*\(\s*vGrassEmissive\s*,\s*vec3\(\s*([0-9.]+)\s*\)\s*\)/);
  if (!ceil) { console.error('[invariants] FAIL: Grass.js lost its ABSOLUTE emissive ceiling (min(vGrassEmissive, vec3(<=0.25))) — sub-pixel blades will flicker into bloom blobs again'); failed = true; }
  else if (parseFloat(ceil[1]) > 0.25) { console.error(`[invariants] FAIL: grass emissive ceiling raised to ${ceil[1]} (max 0.25) — thresholds are orchestrator-owned`); failed = true; }
  const rough = grass.match(/roughnessFactor\s*=\s*mix\(\s*([0-9.]+)\s*,\s*([0-9.]+)/);
  if (rough && Math.min(parseFloat(rough[1]), parseFloat(rough[2])) < 0.6) {
    console.error(`[invariants] FAIL: grass tip roughness ${rough[2]} < 0.6 — low-roughness blades throw drifting specular glints (the original blob bug)`); failed = true;
  }
}
console.log(failed ? '[invariants] ==== FAILED ====' : '[invariants] all OK');
process.exit(failed ? 1 : 0);
