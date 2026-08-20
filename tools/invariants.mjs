// invariants.mjs — SOURCE INVARIANTS. `node tools/invariants.mjs` — instant, no dev server.
// Run this before you touch anything and again before you report done; tools/gate.mjs runs it too,
// CI (.github/workflows/checks.yml) runs it on every push/PR, and the repo's .claude/settings.json
// Stop hook runs it at the end of every agent turn.
// Each rule below encodes a bug that has shipped MORE THAN ONCE. They kept coming back because a
// later builder wrote a NEW code path that the prose rule in CLAUDE.md did not literally name.
// Thresholds are orchestrator-owned: if a rule blocks legitimate work, say so in your report.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
let failed = false;
const fail = (msg) => { console.error('[invariants] FAIL: ' + msg); failed = true; };
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

// ---------------------------------------------------------------- (a) POINTER LOCK: exactly one lock path.
// Every regression of "the mouse escapes / camera stops at the screen edge" came from a builder adding
// their own requestPointerLock without the unadjustedMovement-rejection + relock-cooldown handling that
// Input.lock() has — or from removing the HUD/menu hookup into it.
for (const f of srcFiles) {
  if (f.endsWith(join('core', 'Input.js'))) continue;
  if (/requestPointerLock/.test(read(f))) {
    fail(`${f} calls requestPointerLock directly — use Input.lock(canvas), the single lock path (it handles unadjustedMovement rejection + Chrome's relock cooldown; bypassing it is how the mouse keeps escaping the window)`);
  }
}
const inputSrc = read(join('src', 'core', 'Input.js'));
if (!/static lock\s*\(/.test(inputSrc)) fail('Input.lock() is gone — the single pointer-lock path must exist');
if (!/setTimeout/.test(inputSrc) || !/catch/.test(inputSrc)) fail("Input.lock() lost its rejection fallback / relock retry — the mouse will escape again");
if (!/!this\.locked && !this\.synthetic/.test(inputSrc)) fail('Input.js lost the "!this.locked && !this.synthetic" gates — mousemove/mousedown must be inert while unlocked (otherwise the OS cursor drives the camera and stops at the screen edge)');
const hudSrc = read(join('src', 'ui', 'HUD.js'));
if (!/\.lock\(\s*g\.canvas\s*\)|Input\.lock\(/.test(hudSrc)) fail('HUD.js no longer routes start/resume clicks through Input.lock — the start screen will play without pointer lock (mouse stops at the screen edge)');
const gameSrc = read(join('src', 'core', 'Game.js'));
for (const f of srcFiles) {
  const s = read(f);
  for (const m of s.matchAll(/^.*\.synthetic\s*=\s*true.*$/gm)) {
    if (!/auto/.test(m[0])) fail(`${f}: "${m[0].trim()}" — input.synthetic may only be enabled under the ?auto=1 guard; anywhere else it lets the game read the OS cursor without pointer lock (mouse stops at the screen edge)`);
  }
}

// ---------------------------------------------------------------- (b) GROUND COVER NEVER GLOWS
// The flashing white/blue blob bug (shipped 5x, 5 different causes). Grass.js must keep BOTH the
// emissive ceiling AND the final outgoing-luminance cap (the cap closes every term at once:
// emissive, specular, gust silvering, translucency, exposure stacking).
const grass = read(join('src', 'world', 'Grass.js'));
if (!grass) fail('src/world/Grass.js missing');
else {
  const ceil = grass.match(/vGrassEmissive\s*=\s*min\s*\(\s*vGrassEmissive\s*,\s*vec3\(\s*([0-9.]+)\s*\)\s*\)/);
  if (!ceil) fail('Grass.js lost its ABSOLUTE emissive ceiling (min(vGrassEmissive, vec3(<=0.25))) — sub-pixel blades will flicker into bloom blobs again');
  else if (parseFloat(ceil[1]) > 0.25) fail(`grass emissive ceiling raised to ${ceil[1]} (max 0.25) — thresholds are orchestrator-owned`);
  const rough = grass.match(/roughnessFactor\s*=\s*mix\(\s*([0-9.]+)\s*,\s*([0-9.]+)/);
  if (!rough) fail('Grass.js lost its roughnessFactor mix(a, b, ...) override — the stock 0.6 material value stops applying per-blade and the next tweak brings back specular glints');
  else if (Math.min(parseFloat(rough[1]), parseFloat(rough[2])) < 0.6) fail(`grass tip roughness ${rough[2]} < 0.6 — low-roughness blades throw drifting specular glints (the original blob bug)`);
  const cap = grass.match(/outgoingLight\s*\*=\s*([0-9.]+)\s*\/\s*max\(\s*grassLum\s*,\s*\1\s*\)/);
  if (!cap) fail('Grass.js lost GRASS_LUM_CAP (outgoingLight *= 0.60 / max(grassLum, 0.60)) — the final-luminance cap is the one guard that closes EVERY blob path at once; do not remove it');
  else if (parseFloat(cap[1]) > 0.65) fail(`GRASS_LUM_CAP raised to ${cap[1]} (max 0.65) — near the bloom threshold blades flicker into white balls again`);
  if (!grass.includes('#include <opaque_fragment>\'') && !/GRASS_LUM_CAP \+ '#include <opaque_fragment>'/.test(grass)) fail('Grass.js no longer injects GRASS_LUM_CAP before <opaque_fragment> — the cap exists but is not applied');
  if (!/metalness:\s*0[,\s}]/.test(grass)) fail('grass material metalness must stay 0 — metallic blades throw sun glints');
  if (/envMapIntensity/.test(grass)) fail('grass material must not set envMapIntensity — glossy IBL on blades is another specular-glint path');
}

// ---------------------------------------------------------------- (c) VFX intensity ceilings
// "Saturate the COLOUR, cap the INTENSITY." Agents keep brightening vfx to win daytime readability;
// on small/ambient elements that is the blob bug. Ceilings anchor at the current hottest values.
const vfx = read(join('src', 'vfx', 'VFX.js'));
if (vfx) {
  // wisp ambient trail: emitted 24/7 at grass height across the meadow — the strictest cap in the file
  const trail = vfx.match(/\n  trail\([\s\S]*?\n  \},/);
  if (!trail) fail("VFX.js 'trail' preset not found — if renamed, move its invariant too (wisp ambient trail must stay hue-saturated and capped)");
  else {
    if (/0xffffff/.test(trail[0])) fail("VFX 'trail' preset uses white (0xffffff) — wisps drag this across the meadow all day; white clips to white balls. Saturate: use the element color");
    for (const m of trail[0].matchAll(/\.hdr\(\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?/g)) {
      if (parseFloat(m[1]) > 1.2) fail(`VFX 'trail' preset hdr ${m[1]} > 1.2 — the wisp ambient trail must stay at/below the wisp glow ceiling (1.1); brighter = drifting flashing blobs over the grass`);
    }
  }
  // global ceiling: nothing hotter than the muzzle flash core (34x at noon), the current repo max
  for (const m of vfx.matchAll(/\.hdr\(\s*([0-9.]+)(?:\s*\+\s*([0-9.]+)\s*\*\s*day)?/g)) {
    const total = parseFloat(m[1]) + (m[2] ? parseFloat(m[2]) : 0);
    if (total > 34) fail(`VFX.js hdr(${m[0].slice(5)}...) totals ${total} (> 34, the muzzle-core max) — anything hotter white-clips through ACES into a blob`);
  }
  const flash = vfx.match(/\*\s*([0-9.]+)\s*\*\s*\(0\.5\s*\+\s*0\.5\s*\*\s*this\.day\)/);
  if (!flash) fail('VFX.flash() lost its night-halving "(0.5 + 0.5 * this.day)" — full-power point flashes at night blow the lit grass field into a white orb (shipped before)');
  else if (parseFloat(flash[1]) > 9) fail(`VFX.flash() multiplier ${flash[1]} > 9 — flash PointLights light the actual meadow geometry past the bloom threshold`);
}

// ---------------------------------------------------------------- (d) enemy glow ceilings (user decree)
const defs = read(join('src', 'enemies', 'defs.js'));
if (defs) {
  const wisp = defs.match(/wisp:\s*\{[\s\S]*?glow:\s*([0-9.]+)/);
  if (wisp && parseFloat(wisp[1]) > 1.1) fail(`wisp glow ${wisp[1]} > 1.1 — user decree: wisps must not read as white blobs across the meadow (keep hue, cap intensity)`);
}
const enemies = read(join('src', 'enemies', 'Enemies.js'));
if (enemies) {
  const dg = enemies.match(/dayGlow\s*=\s*1\s*\+\s*([0-9.]+)\s*\*/);
  if (dg && parseFloat(dg[1]) > 2.4) fail(`Enemies.dayGlow coefficient ${dg[1]} > 2.4 — it multiplies EVERY enemy emissive; higher pushes wisps/crystals past white-clip at noon`);
}

// ---------------------------------------------------------------- (e) postfx / lighting calibration pins
// The bloom thresholds and sun intensity are jointly calibrated so sunlit white ~= 1.0 linear sits
// UNDER the day bloom threshold (1.05). Moving any of them independently reintroduces field-wide blobs.
const postfx = read(join('src', 'render', 'PostFX.js'));
if (postfx) {
  const th = postfx.match(/bloomNightTh\s*=\s*([0-9.]+)\s*;\s*this\.bloomDayTh\s*=\s*([0-9.]+)/);
  if (!th) fail('PostFX bloomNightTh/bloomDayTh assignments not found — the threshold pins must stay greppable');
  else {
    if (parseFloat(th[2]) < 1.0) fail(`bloomDayTh ${th[2]} < 1.0 — sunlit-white (~1.0) crosses the day bloom threshold and the whole meadow blooms into white balls`);
    if (parseFloat(th[1]) < 0.25) fail(`bloomNightTh ${th[1]} < 0.25 — moonlit grass crosses the night threshold`);
  }
  const ae = postfx.match(/AutoExposureEffect\(\{[^}]*max:\s*([0-9.]+)/);
  if (ae && parseFloat(ae[1]) > 1.3) fail(`AutoExposure max ${ae[1]} > 1.3 — exposure gain multiplies the scene toward the bloom threshold`);
  if (!/frameBufferType:\s*THREE\.HalfFloatType/.test(postfx)) fail('EffectComposer lost frameBufferType: THREE.HalfFloatType — LDR buffers clamp at 1.0 and the 1.05 day threshold silently never fires (bloom picks arbitrary pixels instead)');
}
const lighting = read(join('src', 'render', 'Lighting.js'));
if (lighting) {
  const sp = lighting.match(/sunPeak\s*=\s*([0-9.]+)/);
  if (sp && parseFloat(sp[1]) > 3.2) fail(`Lighting sunPeak ${sp[1]} > 3.2 — calibrated so sunlit white ~= 1.0 pre-tonemap, 0.05 under the day bloom threshold; raising it blooms every bright surface`);
}

// ---------------------------------------------------------------- (f) viewmodel — always in frame, over the grass
const wmodels = read(join('src', 'player', 'weapons', 'models.js'));
if (wmodels) {
  const white = wmodels.match(/white:\s*std\(\{[^}]*emissiveIntensity:\s*([0-9.]+)/);
  if (white && parseFloat(white[1]) > 1.0) fail(`weapon sight 'white' emissiveIntensity ${white[1]} > 1.0 — the sights sit in EVERY frame over the grass; above the day bloom threshold they are permanent white balls`);
  for (const name of ['gold', 'brass']) {
    const m = wmodels.match(new RegExp(name + ':\\s*std\\(\\{[^}]*roughness:\\s*([0-9.]+)'));
    if (m && parseFloat(m[1]) < 0.3) fail(`weapon '${name}' roughness ${m[1]} < 0.3 — glossy metal viewmodel parts throw white sun glints over the meadow (blobcheck-gated)`);
  }
}

// ---------------------------------------------------------------- (g) props in the spawn meadow
const props = read(join('src', 'world', 'Props.js'));
if (props) {
  const fm = props.match(/color:\s*0xffd090,\s*emissive:\s*0xff9a40,\s*emissiveIntensity:\s*([0-9.]+)/);
  if (fm && parseFloat(fm[1]) > 1.6) fail(`lantern flame emissiveIntensity ${fm[1]} > 1.6 — 0.1 m flickering octahedra 6-17 m from spawn; hotter = sub-pixel warm blobs (shipped before at 4.0)`);
}

console.log(failed ? '[invariants] ==== FAILED ====' : '[invariants] all OK');
process.exit(failed ? 1 : 0);
