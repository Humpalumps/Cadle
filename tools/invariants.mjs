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

// ---------------------------------------------------------------- (a2) THE BAKE WORKER IS A REAL MODULE
// The terrain bake worker used to be built by stringifying Terrain.js's own functions into a Blob. That
// compiles fine in dev and dies in EVERY minified build (`ReferenceError: noise2 is not defined`), where the
// only symptom is a silent fall back to a single-threaded bake on the main thread — the world still loads,
// just frozen for seconds (measured: 22 rendered frames in 17.6 s of boot, vs 507 with the workers).
// So: the bake math lives in src/world/terrainKernel.js and terrainWorker.js imports it; the bundler resolves
// the names. Nothing here may go back to string-building a worker, and the kernel must stay three-free
// (importing three would drag the whole engine into the worker chunk).
{
  const terr = read(join('src', 'world', 'Terrain.js'));
  const kern = read(join('src', 'world', 'terrainKernel.js'));
  const wrk = read(join('src', 'world', 'terrainWorker.js'));
  if (/URL\.createObjectURL\s*\(\s*new Blob/.test(terr) || /\bnew Worker\(\s*url\b/.test(terr))
    fail('src/world/Terrain.js is string-building its bake worker again — use `new Worker(new URL(\'./terrainWorker.js\', import.meta.url), { type: \'module\' })`; a stringified worker throws ReferenceError in every minified build and silently bakes on the main thread');
  if (!/new Worker\(\s*new URL\(\s*'\.\/terrainWorker\.js'\s*,\s*import\.meta\.url\s*\)\s*,\s*\{\s*type:\s*'module'\s*\}\s*\)/.test(terr))
    fail("src/world/Terrain.js: the bake worker must be created as `new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' })` so Vite bundles it");
  if (/from '.*\bthree\b/.test(kern)) fail('src/world/terrainKernel.js imports three — the bake worker chunk must stay engine-free');
  if (!/import \{ bakeKernel \} from '\.\/terrainKernel\.js'/.test(wrk)) fail('src/world/terrainWorker.js no longer imports bakeKernel from the kernel module');
  if (!/import \{[^}]*\bheightAt\b[^}]*\} from '\.\/terrainKernel\.js'/.test(terr) || !/Terrain\.prototype\.heightAt = heightAt;/.test(terr))
    fail('src/world/Terrain.js must import heightAt from terrainKernel.js and hang it on the prototype — one height field for the game AND the bake, or the mesh stops matching the colliders');
  // the nine outer-biome kernels still have to be closure-free-ish: everything they call must exist in the kernel module
  const bh = kern.match(/const BH = \[([\s\S]*?)\n\];/);
  if (!bh) fail('src/world/terrainKernel.js: the BH[] outer-biome kernels are gone or reshaped — heightAt indexes that array by wedge k');
  else {
    const defined = ['ss', 'mix', 'n2', 'fbm2', 'fbm3', 'fbm4', 'ridged3', 'ridged4', 'rmf', 'rg', 'Math', 'Number'];
    const kw = ['function', 'if', 'for', 'while', 'return', 'switch', 'catch'];
    const body = bh[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');   // comments are prose, not calls
    const called = [...new Set([...body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
    const bad = called.filter((id) => !defined.includes(id) && !kw.includes(id) && !id.startsWith('bh'));
    if (bad.length) fail(`src/world/terrainKernel.js BH[] calls ${bad.join(', ')} — add it to the kernel module (and to this invariant's \`defined\` list) or the outer biomes bake flat`);
    for (const id of defined.slice(0, 10)) if (!new RegExp(`(?:const|,)\\s*${id}\\s*=`).test(kern)) fail(`src/world/terrainKernel.js no longer defines \`${id}\`, which BH[]/heightAt call`);
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

// ---------------------------------------------------------------- (h) HOT CORES KEEP THEIR HUE
// Same decree as the grass cap, one level up: any small additive/emissive element that tone-maps to white
// stops reading as magic and starts reading as a blob. Two structural guards, both added after the gate
// caught live examples (a wisp reading as a white orb, and every impact preset starting from pure white).
{
  const mat = read(join('src', 'enemies', 'materials.js'));
  if (!/aetherCap/.test(mat) || !/gl_FragColor\.rgb \*= aetherCap \/ aetherLum/.test(mat)) {
    fail('src/enemies/materials.js lost the hue-preserving aether luminance cap (aetherCap) — creature crystals/eyes/cores blow out to white balls again');
  } else {
    const m = mat.match(/mix\(\s*6\.0\s*,\s*([0-9.]+)\s*,\s*vGlow\s*\)/);
    if (!m || Number(m[1]) > 0.75) fail(`src/enemies/materials.js: the aether cap for full-glow parts is ${m ? m[1] : '?'} — must stay <= 0.75 linear or it clears the bloom threshold`);
  }
  const brush = read(join('src', 'vfx', 'Brush.js'));
  const t = brush.match(/const HOT_TINT = ([0-9.]+)/);
  if (!t) fail('src/vfx/Brush.js lost HOT_TINT — every impact/burst preset starts from pure white again, and an additive white core at hdr 4-7 is a white ball');
  else if (Number(t[1]) < 0.4) fail(`src/vfx/Brush.js HOT_TINT is ${t[1]} — below 0.4 the hot core is white again; saturate the COLOUR, cap the INTENSITY`);
  const terr2 = read(join('src', 'world', 'Terrain.js'));
  if (!/FRAG_SHOULDER/.test(terr2)) fail('src/world/Terrain.js lost FRAG_SHOULDER — the ground goes flat white where a low sun rakes across it');
}

// ------------------------------------------------- (i) SHADER WARMUP MUST COMPILE IN THE COMPOSER'S SPACE
// `outputColorSpace` is the SECOND field of three's program cache key, and getParameters reads it as
// `currentRenderTarget === null ? renderer.outputColorSpace : workingColorSpace`. This game draws every pixel
// through composer.render(), i.e. INTO a target, so its programs are keyed `srgb-linear`. A bare
// renderer.compile() with nothing bound links the `srgb` twin — a real program the renderer never looks up —
// and the one it needs still links on first draw, inside the GPU process, where neither cpuMs nor gpuMs sees
// it. This shipped unnoticed for the project's whole history: warming that way left the program count 41
// HIGHER than not warming at all. Binding a target took programs linked during one combat session 44 -> 1.
// Route every warmup through compileForComposer/renderForComposer in src/render/Renderer.js.
{
  const rend = read(join('src', 'render', 'Renderer.js'));
  if (!/export function compileForComposer/.test(rend) || !/setRenderTarget\(_warmRT\)/.test(rend)) {
    fail('src/render/Renderer.js lost compileForComposer (or its bound scratch target) — shader warmup silently compiles the wrong colorspace and every program relinks during play');
  }
  for (const f of [['src', 'main.js'], ['src', 'player', 'Weapons.js'], ['src', 'player', 'Abilities.js'], ['src', 'world', 'EZTrees.js'], ['src', 'world', 'Terrain.js']]) {
    // Strip line comments before testing: these files DOCUMENT this bug at length, so a naive substring
    // test flags the prose explaining it. (It did, the moment the explanation was written.)
    const src = read(join(...f)).replace(/\/\/[^\r\n]*/g, '');
    if (src.includes('renderer.compile(') || src.includes('.renderer.compile(') || src.includes('compileAsync(')) {
      fail(f.join('/') + " calls renderer.compile() directly - use compileForComposer(), or it builds the srgb twin the renderer never uses and the real program links mid-play (see src/render/Renderer.js)");
    }
  }
}

// ------------------------------------------------- (j) QUESTS ARE WRITTEN, NEVER SPOKEN
// User decision 2026-08-23: the voiced opening quest was removed and every quest from here on is READ.
// The failure mode this pins: a later builder "improves" a quest beat by reaching for audio.playVoice()
// again, and the game silently reacquires a voice cast, a pinned-voice consistency contract and a
// per-line asset budget that nobody signed up for. Narration belongs in the quest text and the quest
// log. If story-mode voiced NPCs are ever green-lit, lift this rule deliberately — do not route
// around it, and do not re-add /assets/voice/* to the preloader to make a single line work.
for (const f of srcFiles) {
  if (!f.includes(join('src', 'rpg'))) continue;
  const src = read(f);
  if (/playVoice\s*\(/.test(src)) fail(f + ' calls playVoice() - quests are WRITTEN, never spoken (user decision 2026-08-23). Put the words in the quest text and the quest log.');
  if (/assets\/voice\//.test(src)) fail(f + ' references /assets/voice/ - the voice lines were deleted with the voiced opener; quests are written now.');
}
{
  const assets = read(join('src', 'core', 'Assets.js'));
  if (/voice-vale|assets\/voice\//.test(assets)) fail('src/core/Assets.js still preloads voice lines - they were deleted with the voiced opening quest (quests are written now).');
}

// ------------------------------------------------- (k) QUEST/AMMO DROPS MUST NOT FIGHT THE LOOT CAP
// The opening quest's reward kept being evicted by loot.js's MAX_DROPS cap, and the workaround shipped
// was a 5-second poll that re-dropped a legendary on the ground forever. Quest items and ammo bricks are
// not loot: a fight that drops twelve commons must never delete the thing a quest told you to pick up,
// and a quest item must never push someone's exotic off the floor either. Whoever owns loot.js keeps
// these populations separate - if this rule blocks legitimate work, say so in your report.
{
  const ammo = read(join('src', 'rpg', 'ammo.js'));
  if (ammo && !/MAX_BRICKS|BRICK_CAP/.test(ammo)) fail('src/rpg/ammo.js has no separate brick cap - bricks must not share loot.js MAX_DROPS, or a firefight evicts the loot you came for');
}

// ------------------------------------------------------------------ (l) NO TRADEMARKED ITEM NAMES
// The weapon-name grammar is combinatorial and keyed by archetype, so one evocative word in a pool can
// reproduce a real shipped item from the very games this project is benchmarked against — and land it on
// the same weapon class as the original, which makes it look deliberate rather than accidental. Two were
// already live: "Last Word" (Destiny exotic hand cannon; our `lastbreath` tag rolled onto hand cannons)
// and "Thorn" (likewise). This greps the generator's pools, not free prose, so flavour text is unaffected.
{
  // Strip comments first. The whole point of this rule is that removals get EXPLAINED in place, and an
  // explanation naming the word it removed would otherwise trip the rule that removal satisfied — which
  // is how a guardrail teaches people to write vaguer comments.
  const names = read(join('src', 'rpg', 'names.js'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  // Proper nouns, not ordinary words: "Reckoning" alone is fine English; the faction name is not.
  const banned = ['Last Word', 'Gjallarhorn', 'Ace of Spades', 'Fatebringer', 'Whisper of the Worm',
                  'Hawkmoon', 'Sunshot', 'Riskrunner', 'the Nine', 'Xur', 'the Traveler',
                  'Frostmourne', 'Thunderfury', 'Ashbringer', 'Shadowmourne', 'Atiesh'];
  for (const b of banned) {
    if (new RegExp("'" + b + "'").test(names)) {
      fail(`src/rpg/names.js has "${b}" in a generator pool - that is a real shipped item from Destiny or WoW, and this project is benchmarked against both. Pick an original word.`);
    }
  }
}

// ------------------------------------------------------------------ (m) LOOT DROPS ARE AIRBORNE EMISSIVES
// HANDOVER 9 says the coverage for glowing things OFF the ground is "the invariants.mjs ceilings + the
// aether cap + HOT_TINT". That was not true of src/rpg/dropmesh.js, which had NO rule here at all while
// carrying per-rarity emissive intensities up to 1.05 on an object that hovers at chest height and is
// deliberately built to catch the eye. blobcheck.py cannot help: its BRIGHT test is scoped to ground
// cover, so a drop beacon is invisible to it by construction. That is exactly the gap a future "make
// exotics pop more" tweak walks through.
// The ceiling is the same one the wisps use (1.1) — below the ~1.2 bloom threshold with margin.
{
  const dm = read(join('src', 'rpg', 'dropmesh.js'));
  const m = dm.match(/const EMIS = \{([^}]*)\}/);
  if (!m) fail('src/rpg/dropmesh.js lost its per-rarity EMIS table - the drop emissive ceiling is unpinned');
  else {
    for (const pair of m[1].split(',')) {
      const kv = pair.split(':');
      if (kv.length !== 2) continue;
      const k = kv[0].trim(), v = Number(kv[1]);
      if (Number.isFinite(v) && v > 1.1) fail(`src/rpg/dropmesh.js EMIS.${k} is ${v} - above the 1.1 ceiling. A drop hovers at chest height where blobcheck's ground-cover scoping cannot see it; saturate the COLOUR, cap the INTENSITY.`);
    }
  }
}

// ------------------------------------------------------------------ (n) NO GLB EVER REACHES THE RUNTIME
// User directive 2026-08-26: assets come in through concept -> Tripo GLB -> the img2threejs skill ->
// PROCEDURAL Three.js code, and the GLB is a structural reference that never ships. The project already
// paid for the lesson once: guy.glb was a single rigid mesh with skinCount 0, so while it was on screen
// the intro's IK arms, breathing idle and suck-in reach were all dead code (HANDOVER 6).
// Provenance COMMENTS naming a .glb are wanted — every converted body should say what it was built from —
// so this rule only looks at code, and only for the two things that actually load one.
{
  const stripped = (src) => {
    let out = '', block = false;
    for (const raw of src.split('\n')) {
      let line = raw;
      if (block) { const e = line.indexOf('*/'); if (e < 0) continue; line = line.slice(e + 2); block = false; }
      for (;;) {                                  // a line can open a block comment after real code
        const s = line.indexOf('/*');
        if (s < 0) break;
        const e = line.indexOf('*/', s + 2);
        if (e < 0) { line = line.slice(0, s); block = true; break; }
        line = line.slice(0, s) + line.slice(e + 2);
      }
      const c = line.indexOf('//');
      out += (c >= 0 ? line.slice(0, c) : line) + '\n';
    }
    return out;
  };
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : (d.name.endsWith('.js') ? [join(dir, d.name)] : []));
  for (const f of walk('src')) {
    const code = stripped(read(f));
    if (/GLTFLoader|GLTF_?Loader/.test(code)) fail(`${f} imports/uses GLTFLoader - GLBs are references for the img2threejs pipeline, never runtime assets (docs/CREATURE-PIPELINE.md).`);
    if (/['"`][^'"`]*\.glb\b/.test(code)) fail(`${f} names a .glb file in CODE (comments are fine) - nothing may load a GLB at runtime; ship the procedural conversion instead (docs/CREATURE-PIPELINE.md).`);
  }
}

console.log(failed ? '[invariants] ==== FAILED ====' : '[invariants] all OK');
process.exit(failed ? 1 : 0);
