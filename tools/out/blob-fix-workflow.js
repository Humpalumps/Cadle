export const meta = {
  name: 'blob-fix',
  description: 'Fix combat white-outs: VFX brush/pool caps, GLB material caps, lighting amplifiers; then verify with the new combat gate',
  phases: [
    { title: 'Build', detail: '3 file-owned lanes in parallel' },
    { title: 'Verify', detail: 'serialized combat capture + combatcheck' },
  ],
}
const ROOT = 'C:/Users/ianca/Desktop/fps4/.claude/worktrees/cadle-character-load-perf-ee5b7b'
const COMMON = `Repo root: ${ROOT} (git worktree, branch claude/session-e5730b). Dev server ALREADY RUNNING at http://127.0.0.1:5179/ serving this worktree — never start another, never touch 5173. You are a BUILDER on the Cadle FPS (three r185 + postprocessing, ACES, bloom day threshold 1.05 / night 0.28, HalfFloat composer). Do not touch git. Do not edit tools/ or files outside your lane.

THE BUG YOU ARE FIXING (wave-5 regression, standing user decree): fighting a region's own bestiary blows the screen to near-white. The decree: ANY emissive/additive element that tone-maps to WHITE instead of its hue is a bug — saturate the colour, cap the intensity. A hue survives ACES iff its SMALLEST channel stays under clip; punch must come from saturated colour, size, and light — never from all-channels-high.

A NEW MECHANICAL GATE EXISTS AND IS RED ON THE CURRENT BUILD: \`node tools/inspect.mjs --nolock --name cvfx-<yourlane> --q high --script tools/scripts/combat-blob-steps.json --url http://127.0.0.1:5179/\` then \`python tools/combatcheck.py tools/out/cvfx-<yourlane>\`. It spawns each region's bestiary at 8-18 m, aggroes it, damages every enemy once, player never fires; it fails frames where the visible world goes near-white desaturated (WASH >5.5% of non-sky, CATASTROPHE >40% of frame, WHITE CORE clusters). Measured on the current build: dragon 84% washed, celestial 83%, infernal 76%, lost 75%, sunken 63%, shadowfen 55%, tundra 31%, vale white-core clusters at rgb(225,238,233); forest is the only clean region. The full 10-region run takes ~12 min and needs the GPU roughly to itself — DO NOT run it while another agent's browser is running (it uses --nolock; check first with PowerShell: Get-Process chrome-headless-shell -ErrorAction SilentlyContinue | Measure-Object | % Count — if >0, wait and retry in a loop before launching). Prefer ONE full run late in your work over many partial runs.

Also keep GREEN: \`node tools/invariants.mjs\` (source greps — must exit 0 before you finish; do not weaken any rule).`
const VERDICT = { type: 'object', additionalProperties: false, required: ['report'], properties: { report: { type: 'string' } } }
phase('Build')
const [vfx, mat, light] = await parallel([
  () => agent(`${COMMON}

YOUR LANE — you own ONLY these files: src/vfx/VFX.js, src/vfx/Brush.js, src/vfx/Particles.js, src/vfx/Extras.js, src/vfx/Filaments.js, src/vfx/Textures.js.

DIAGNOSED ROOT CAUSES IN YOUR FILES (from a 4-agent read-only investigation — verify line numbers yourself, code may have drifted slightly):
1. THE BIG ONE — 'explosion' preset (VFX.js ~:643-664): core flash .color(0xffffff, fire).hdr(8,3), flare petal 0xfff4d8 × hdr 4 at up to 3.2 m, fire tongues 0xfff0b8 × 3.2, embers 0xffd080 × 3.5. Fired via the 'combat:explosion' listener (~:485) for EVERY enemy explosive bolt (imp/drake/wyvern/skyserpent/voidhorror/leviathan/bogwitch explodeRadius 1.2-1.9; golem/treant/icegiant/magmagolem throws 2.5-3.0) — bolts that by design detonate AT the camera — and the additive quads have NO near-camera scaling (only the pooled light does). All channels 3.4-8× over the 1.05 bloom threshold → ACES clips to cream-white → full-frame wash. This preset was tuned for the player's own grenade thrown AWAY from the camera.
2. 'impact-enemy' white-hot core (VFX.js ~:630): .color(0xffffff, c).hdr(6 + 3*day, 3) = hdr 9 at noon, crit star on top (~:637) — this is the lost-region "opaque near-white egg over the golem chest crystal" (critic sampled rgb 236,232,221).
3. 'impact-terrain' pop (VFX.js ~:596): .color(0xfff0d0, 0xd8b070).hdr(3, 1.2) — DISCARDS the element colour entirely and bypasses HOT_TINT (not exact 0xffffff). This is the vale "wisp bolt impact = hard white core rgb 229,238,233 on the meadow grass".
4. HOT_TINT (Brush.js ~:47) fires only on exact c0===0xffffff, and only tints — at hdr>=3 the tinted product still clips every channel. Near-white literals (0xfff4d8, 0xfff0b8, 0xfff0d0, 0xfff0c0, 0xffd080) bypass it entirely.
5. 'spark-trail' (attached to EVERY projectile incl. enemy bolts, 70 Hz, 3 additive/tick, hdr 2.2-3.5, ~59 live per bolt): stacks additively — riftling+voidhorror sustain ~375 live additive particles; the uMinW 1.5 px sprite floor (Particles.js ~:40,44) makes it worse at range. The 'trail' preset already carries the range-fade fix for exactly this (VFX.js ~:580-589 documents it) — it was never propagated to 'spark-trail'.
6. Void weather motes (VFX.js ~:529, rate 14, life 7-13 s, hdr 0.9 × alpha 0.7): ~140 permanently live; two overlapping cross the day bloom threshold, at night every one blooms.
7. The additive pool fragment shader (Particles.js ~:59-63) has NO output cap of any kind — it is the ONE renderer of small bright elements with no structural ceiling (grass has GRASS_LUM_CAP, creatures have aetherChan).
8. Pooled PointLight flashes (VFX.js ~:421): enemy bolt lights at ~4.7-13.5 intensity light the scene under the particle stack; a previous bisect showed zeroing these lights alone took washed frames 3/5 → 0/7.

THE FIX PRINCIPLE (structural first, then tuning):
a) In Brush (the single chokepoint every pool particle goes through): after colour×hdr resolution, enforce a hue-preserving ceiling — rescale any particle whose (colour × hdr) MINIMUM channel exceeds ~1.0 so the minimum channel lands at ~0.95-1.0. White can then never clip to bloom; saturated hues keep a bright dominant channel and still bloom in their own colour. Name the constant clearly (e.g. BRUSH_MINCH_CAP) — the orchestrator will pin it in invariants afterwards. Keep HOT_TINT (invariants rule h greps for it).
b) In the additive pool shader: add a near-camera fade (additive quads fade out inside ~1.2-2.5 m of the eye, matching the pooled light's existing near fade) so a detonation at the lens cannot fill the frame.
c) Re-author the three presets: stop discarding the element colour, replace near-white literals with saturated on-palette hues (fire = deep orange, arc = electric blue, void = violet...), and bring hdr values down to where the ceiling barely engages. An explosion should read as FIRE, not as a flashbulb.
d) Propagate the 'trail' range-fade to 'spark-trail'; drop its hdr toward ~1.2-1.6; cut void weather mote hdr so two overlapping stay under 1.05.
e) Halve-ish the enemy-bolt pooled-light peak (the bisect evidence says lights are a co-author of the wash).
Judge every change by whether combat still looks PUNCHY — Destiny 2 explosions are vivid and violent, never white sheets and never damp squibs. Iterate with your own eyes: use small targeted inspect runs (e.g. spawn imps in infernal, screenshot) before the one full gate run.

DONE = (1) node tools/invariants.mjs exits 0; (2) one full combat capture + python tools/combatcheck.py run at the END exits 0 or is clearly close (list every remaining finding verbatim if not zero); (3) 2-3 screenshots proving explosions/impacts still read as vivid fire/arc/void. Report: what you changed file:line, constants chosen, gate result verbatim, screenshot paths.`, { label: 'vfx-lane', schema: VERDICT }),

  () => agent(`${COMMON}

YOUR LANE — you own ONLY these files: src/enemies/materials.js, src/enemies/glbBody.js, src/enemies/Enemy.js, src/enemies/bodies.js. (defs.js is NOT yours; neither is src/vfx/.)

DIAGNOSED ROOT CAUSES IN YOUR FILES (from a read-only investigation — verify yourself):
1. The hue-preserving aether caps in materials.js (~:142-156) are keyed off vGlow (the aGlow vertex mask) — but glbBody.js (~:124) gives every rigged-GLB creature an ALL-ZERO aGlow buffer, so on all 13 GLB creatures the caps relax to luminance 6.0 / channel 8.0, i.e. INERT. Most of the bestiary is GLB now.
2. The aether RIM term (materials.js ~:94, reflectedLight.indirectDiffuse += ecol*rim*uRim) lands on vGlow=0 pixels and BYPASSES both caps: a non-ghost creature's silhouette can carry ~1.43/channel at grazing — over the 1.05 bloom threshold — with nothing catching it. Only ghost types have a ceiling.
3. Death-dissolve edge (~:89): totalEmissiveRadiance += ecol*edge*4.0 → up to ~8.8/channel, effectively capped only at 8.0 on GLB bodies. It is a deliberate look-at-me event — keep it blooming, but it must bloom in its HUE (violet/fire), not clip white: rescale so the minimum channel stays ~<=1.0 while the dominant channel keeps the punch.
4. Hit flash (~:124): gain up to 2.92x + FKNEE 0.55 soft knee. It cannot bloom (output <1.0) but on a GLB whose albedo is painted near-white (Tripo 255-value texels, e.g. the golem chest crystal) the knee flattens the whole region onto one uniform ~1.0 value — a flat white card with a crisp rim (uGrain=0 on GLB removes all breakup). Contributes to the lost-region "white egg" read (the main author is a VFX particle, another lane).
5. Telegraph drive (Enemy.js ~:882): uGlow = def.glow * dayGlow(<=3.4) * (1 + tg*1.6 + phaseF*2) — up to ~21x on a golem, ~37x on a phasing warden, uncapped at source. Procedural glow parts are saved by the aether caps; cap it at source anyway (min(x, ~6)) so no future body path inherits an absurd input.

THE FIXES:
a) Make the aether caps bite on GLB bodies: add a uniform (e.g. uGLB set by the GLB material factory) and key the caps so a GLB body pixel gets a sane hue-preserving channel cap (~1.02, same spirit as the procedural glow-part cap) on the EMISSIVE/ADDITIVE terms (rim, hem ember, telegraph-driven glow), while leaving ordinary lit albedo alone. The existing cap code structure (hue-preserving rescale) is the pattern to reuse.
b) Cap the rim path for ALL bodies so its add can never exceed ~1.02/channel.
c) Death dissolve: hue-preserving rescale (min channel <=1.0, dominant channel may stay ~2+) instead of the flat 4.0 multiplier landing on an 8.0 cap.
d) Hit flash: tint the hot term toward the creature's element colour (ecol) and attenuate the gain where the albedo is already bright (e.g. scale flash gain by 1-luminance-ish) so a near-white crystal region no longer flattens into a uniform card; keep peak output <1.0 as now.
e) Cap uGlow at source in Enemy.js (_sync).
Preserve the look: aether crystals must still read as luminous blue-violet; telegraphs must still be readable warnings. GLB_RIM_MAX stays 0.30 (invariants pin).

VERIFY: node tools/invariants.mjs exits 0. Small targeted inspect runs for your eyes (lineup + takeDamage evals + zoom screenshots of a golem hit, a wisp telegraph, a creature death dissolve at noon and night). Do NOT run the full 10-region combat gate — the vfx lane owns that run this wave (your changes are covered by the orchestrator's post-merge run). node tools/animcheck.mjs is NOT needed (no skeleton/animation changes).
DONE = invariants 0 + screenshots showing: hit flash reads as a coloured flash not a white card, death dissolve blooms in-hue, telegraph readable, crystals luminous. Report file:line changes, constants, screenshot paths.`, { label: 'materials-lane', schema: VERDICT }),

  () => agent(`${COMMON}

YOUR LANE — you own ONLY these files: src/render/Lighting.js, src/render/PostFX.js.

DIAGNOSED AMPLIFIERS IN YOUR FILES (from a read-only investigation of the wave-5 diff — verify yourself):
1. METAL_ENV (Lighting.js ~:87-92, installed ~:232): a global ShaderChunk patch multiplying environment-specular radiance by clamp(1/envMapIntensity,1,3) weighted by metalness — 2.5-3.0x. It was built so GOLD ORNAMENT reads as metal. But Tripo creature GLB materials run metalness~1 wherever the ORM says so (another lane's file), so entire CREATURES inherit the 2.5-3x specular boost on a probe that wave 5 also made brighter (new +0.22 horizon ring, region glow band, broad 0.38*pow(s,26) sun sheen lobe). FIX: exclude skinned meshes from the boost — creatures (and the NPC) are the only skinned meshes in the game, so a '#ifdef USE_SKINNING' guard inside the injected chunk (or an equivalent explicit opt-out) surgically restores pre-wave-5 creature response while keeping the gold fix on architecture. 
2. Auto-exposure coupling (PostFX.js ~:153-157): AE target 0.3, clamp [0.8, 1.3], applied BEFORE the bloom luminance test and before ACES. Wave 5's veilOpacity change (Sky.js — NOT your file, do not edit it) darkened Void/Infernal noon so AE now rides its 1.3x cap exactly there — a frame-wide 1.3x multiplier on every additive/emissive VFX value, pushing things over the 1.05 bloom threshold that were tuned to sit under it. FIX: decouple bloom from adaptation — scale the bloom pass's luminance threshold by the CURRENT AE factor (so adaptation brightens the image but cannot change WHAT blooms), or equivalently divide the bloom input by it. Do not simply lower the AE cap unless the compensation approach genuinely cannot work in this pipeline — losing night adaptation is a real cost.
CONSTRAINT: tools/invariants.mjs pins bloom/exposure calibration constants — run it and keep it green; do NOT change the pinned bloom threshold/intensity/exposure constants themselves. The compensation must be a new term, not a re-tune of the pins.
VERIFY: node tools/invariants.mjs exits 0. Take before/after screenshots (inspect.mjs single shots, --nolock, small runs): (a) a gold-ornament landmark (e.g. celestial Empyrean Gate or lost monoliths) at noon — gold must STILL read as metal; (b) a GLB creature (hound or golem) at 26 m in the vale at noon — values should sit closer to the scene (the coherence critic measured them 'near-black-violet / near-white-cyan stickers'); (c) void and infernal at noon — the AE fix must not visibly break their exposure. Do NOT run the full 10-region combat gate; the orchestrator runs it post-merge.
DONE = invariants 0 + those screenshots. Report file:line changes, mechanism chosen for the AE-bloom decoupling, screenshot paths.`, { label: 'lighting-lane', schema: VERDICT }),
])
phase('Verify')
const gate = await agent(`Repo root: ${ROOT}. Dev server http://127.0.0.1:5179/ (do not start another; never 5173). Three builder lanes just landed fixes for the combat white-out bug. You are the VERIFIER. Edit NOTHING except reading files; run commands from the repo root.
1. Wait until no chrome-headless-shell processes remain (PowerShell: Get-Process chrome-headless-shell -ErrorAction SilentlyContinue | Measure-Object | % Count), polling every 30 s up to 10 min.
2. node tools/invariants.mjs — record exit + any failures.
3. node tools/inspect.mjs --nolock --name cvfx-verify --q high --script tools/scripts/combat-blob-steps.json --url http://127.0.0.1:5179/   (~12 min; timeout generously)
4. python tools/combatcheck.py tools/out/cvfx-verify — record the verdict VERBATIM (all findings if it fails).
5. Look at 6 frames yourself (Read the PNGs): the worst washFrac frame per the new combatcheck.json for infernal, dragon, celestial, void, plus one vale-hit and one tundra-hit frame. Say what combat now LOOKS like: vivid coloured VFX, or nerfed/invisible, or still washed.
Return: invariants result, combatcheck verdict verbatim, per-region peak washFrac from combatcheck.json, and your visual read of the six frames.`, { label: 'verify-gate', schema: { type: 'object', additionalProperties: false, required: ['invariants', 'combatcheck', 'perRegion', 'visualRead'], properties: { invariants: { type: 'string' }, combatcheck: { type: 'string' }, perRegion: { type: 'string' }, visualRead: { type: 'string' } } } })
return { vfx, mat, light, gate }