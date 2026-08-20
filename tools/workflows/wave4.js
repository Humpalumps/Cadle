export const meta = {
  name: 'aetherfall-wave4',
  description: 'Wave 4: fix-first using stored wave-3 verdicts (critics were fresh, builders got cut), then fresh critics until WIN',
  phases: [
    { title: 'Critique', detail: 'fresh critic inspects the running game, blind A/B vs real game' },
    { title: 'Fix', detail: 'builder round N with critic gaps' },
  ],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    piece: { type: 'string' }, verdict: { type: 'string', enum: ['WIN', 'TOSSUP', 'LOSE'] }, score: { type: 'number' },
    scores: { type: 'object', properties: { visual: { type: 'number' }, feel: { type: 'number' }, performance: { type: 'number' }, polish: { type: 'number' } } },
    biggest_gap: { type: 'string' }, gaps_ranked: { type: 'array', items: { type: 'string' } }, strengths: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } }, errors: { type: 'array', items: { type: 'string' } },
    perf: { type: 'object', properties: { fps: { type: 'number' }, p95ms: { type: 'number' }, p99ms: { type: 'number' }, calls: { type: 'number' }, tris: { type: 'number' } } },
  },
  required: ['piece', 'verdict', 'score', 'biggest_gap', 'gaps_ranked', 'evidence'],
}

const COMMON = `Project: C:\\Users\\ianca\\Desktop\\FPS3 (browser FPS-RPG "Aetherfall", Three.js). FIRST read CLAUDE.md and tools/BUILDER.md in full and follow them exactly. Dev server already runs at http://127.0.0.1:5173/. ALSO read ASSETS.md (AI-generated textures/SFX/music under public/assets/ — use them where the manifest says, blend with procedural detail, request missing ones with "ASSET ASK: <what>" in your report) and TECHNIQUES.md (ranked, license-verified open-source three.js techniques — follow the STEAL guidance for your piece). Work autonomously, no questions. Use the harness to look at your actual result and iterate until it meets the bar; don't stop at "it runs".`

const PIECES = [
  { key: 'sky', files: 'src/render/Sky.js', prev: `No wave-2 verdict (critic died without returning JSON). Wave-1b: LOSE 5.5 - clouds read as stacked translucent noise slices (5-step parallax banding, beige stains overhead) instead of opaque crisply-silhouetted cumulus with sunlit tops / shadowed bellies (real fix: 3D-noise raymarched clouds at quarter-res - TECHNIQUES.md #8, reference #7); golden-hour horizon near-white not golden; dusk 19h zenith black too early; night 23h near-black (though the lighting critic praises current night - verify fresh). WAVE-3 REGRESSION (score 4): the 2.5D column-extrusion approach renders cumulus as translucent conical spikes / a fence of dithered beige teeth, with a razor-edged white sheet at the noon horizon, screen-space dither crosshatch everywhere, imperceptible drift, and no lit-top/dark-belly structure. Direction: rounded domain-warped fbm cloud MASSES (flat base, cauliflower top), blue-noise per-step jitter (never step-correlated screen dither), real self-shadow contrast + silver lining, visible drift, distance coverage taper. TECHNIQUES.md #8 (leoawen volumetric-clouds, MIT) is the vetted reference — quarter-res + upsample for the budget. Night package (stars/aurora/moon) is praised — do not regress it.`, brief: `PIECE: Sky / atmosphere / time of day (FF14-grade skies). Own: src/render/Sky.js only. Contract = its header doc. Deliver: a sky dome shader with physically-inspired Rayleigh/Mie scattering (sun glow, horizon warmth, zenith deep blue), a bright sun disc with glare (expose sky.sunMesh for god rays), a moon + star field + subtle aurora/aether ribbons at night, layered procedural clouds (2 layers, noise-based with lit edges, silver lining toward the sun, slow drift, dramatic towering feel at golden hour — these must NOT look like flat noise blobs), horizon haze, and a full 24h cycle driving sunDir/sunColor/skyColor/horizonColor/fogColor/ambientColor/groundColor/fogDensity/sunIntensity/night so Lighting/Water/Grass read consistent values. Keep scene.fog (FogExp2) synced to fogColor/density. Dawn (6), noon (13), golden hour (17.5), dusk (19), night (23) must each be a painting. The sky must follow the camera (no parallax) and cost ≤ 0.4 ms. Check all 5 times of day in screenshots at 1080p; compare against FF14 La Noscea / Destiny EDZ skies in your mind and push until it would hold up.` },
  { key: 'lighting', files: 'src/render/Lighting.js', prev: `Wave-2 critic: LOSE 6 - cast shadows invisible wherever grass covers ground (grass/water never adopted setupShadowMaterial - drive adoption or composite terrain shadows under grass); golden-hour ground murky (needs warm raking light); noon flat (no contact shadows / blue fill); no contact hardening (uniform wide penumbra); ruins far-field crosshatch shadow spam; shadow pass 0.9 ms + 41 calls vs 0.8 budget. Strengths to keep: night is genuinely great, zero shimmer, stable cascades.`, brief: `PIECE: Lighting & shadows. Own: src/render/Lighting.js only. Deliver: sun DirectionalLight driven by game.sky (dir/color/intensity incl. night moonlight with cool tint), cascaded shadow maps (use three/addons/csm/CSM.js or your own 2-3 cascades) that are soft (PCF/PCSS-like), stable (no swimming/shimmer when moving — texel snapping), tight near the player (crisp self-shadows on props/grass/enemies within 30m) and fading out at distance; hemisphere/ambient from sky.ambientColor/groundColor; an environment map for specular/diffuse IBL built procedurally from the sky colors (PMREM of a tiny gradient scene, regenerated when the hour changes noticeably — cheap) set on scene.environment; shadow camera follows the player. Make sure MeshStandardMaterial world surfaces (terrain, props, enemies) receive good-looking light: golden hour rim, blue-ish shadows at noon, moonlit night that is still readable. If you use CSM note that custom ShaderMaterials won't receive CSM shadows; document clearly in your report how other builders make materials CSM-compatible (e.g. CSM.setupMaterial). Budget 0.8 ms. Verify with screenshots at several hours and with the perf window.` },
  { key: 'postfx', files: 'src/render/PostFX.js', prev: `No wave-2 verdict (critic killed). Wave-1b: LOSE 6.3 - grade strips golden-hour gold (post ON vs bypass); god rays = uniform milky veil, never crepuscular shafts (real fix: shadow-map raymarched god rays - TECHNIQUES.md #3, keep the zlib notice); AO practically invisible (swap in N8AO - TECHNIQUES.md #1, CC0); a TAAPass appeared since wave 1b - verify it works without ghosting; FF14 grade via procedural 3D LUT (TECHNIQUES.md #10). WAVE-3 NOTE (score 6): god rays = crosshatch stipple (enable the blur pass / raise res / temporal filter); AO leaves 10x-blade-width black smudge halos (cut intensity 4.5 + radius, thin-geometry rejection); post chain 1.74 ms vs 1.3 budget (trim samples/levels); night crystals get zero bloom (threshold 1.2 above night emissive output). Grade/ACES chain itself is praised.`, brief: `PIECE: Post-processing pipeline. Own: src/render/PostFX.js only (keep setOverlay/ClearPass overlay behaviour intact — weapons renders the first-person gun through it). Deliver using the installed 'postprocessing' lib: HDR half-float pipeline; bloom tuned for a soft FF14 glow (not blown out); SSAO/GTAO-ish ambient occlusion (postprocessing SSAOEffect with normal pass, or N8AO-style in-house; must be subtle and stable); god rays from game.sky.sunMesh (GodRaysEffect) that look great at golden hour and are off when sun is below horizon; a color grade (procedural 3D LUT or curves: lifted soft shadows slightly cool, warm highlights, gentle saturation boost, filmic contrast) — FF14 painterly; vignette; subtle film grain; chromatic aberration only on hits (kick()); flash(color,strength,duration) full-screen tint; optional depth-of-field for ADS (setDof) that is cheap; anti-aliasing: SMAA high preset (clean edges, no shimmer on grass/foliage); ACES or AgX tone mapping with exposure that adapts to time of day (read game.sky). Quality presets: q=low disables AO/godrays/DoF. Budget 1.3 ms at 1080p. Prove it with screenshots (noon, golden hour, night) and perf windows; every effect must be visible in at least one shot. Also export small hooks other systems can call: postfx.flash, postfx.kick, postfx.setDof, postfx.exposure.` },
  { key: 'terrain', files: 'src/world/Terrain.js', prev: `Wave-2 critic: LOSE 4.5 - mountain ring reads as chalk-white plaster with bright-green grass terrace stripes wrapping cliff faces (mask grass by altitude/slope properly); strata sine bands = corduroy on gentle slopes (restrict to steep faces); rock loses all texture beyond ~110 m; ruins plateau skirt = smooth felt pancake; terrain.colorAt(x,z) STILL NOT IMPLEMENTED (explicit ask, grass blocked on it); one-time ~1.1 s freeze when the worker bake lands (stagger texture uploads across frames); beach = blinding white pool deck; forest litter = yellow polka dots; arena flagstone grid tiles visibly. NEW ASSETS: real albedo textures exist - public/assets/tex/{grass_albedo,cliff_strata,forest_soil,beach_sand,snow}.jpg (2k seamless, see ASSETS.md) - use as splat albedos (triplanar on cliffs) with hex-tile stochastic blending (TECHNIQUES.md #4) to kill repetition; keep procedural macro variation + detail normals on top. WAVE-3 NOTE (score 5.5, textures landed): the remaining failure is SHAPE — mountains read as smooth soft-serve mounds with identical sin-wave corduroy strata and flat polygon snow sheets; needs sharp ridgelines / faceted crag structure (ridged fbm, domain warp, per-region variation) plus non-uniform strata. colorAt(x,z) landed? verify — grass still needs it.`, brief: `PIECE: Terrain. Own: src/world/Terrain.js only. Keep the API (size, waterLevel, heightAt, normalAt, slopeAt, mesh). Deliver: a heightfield with real LOD (clipmap/quadtree or concentric rings: ~0.5-1 m resolution near the player, coarse far away; no visible cracks/popping; follows the player), shaped to the World layout in CLAUDE.md (spawn meadow flat-ish, Mirrormere lake basin below waterLevel with beaches + island, Sundered Spire plateau, Whisperwood rolling ground, crystal fields, flat boss arena, mountain ring with cliffs + a pass vista), with a triplanar procedural material (MeshStandardMaterial + onBeforeCompile) blending grass / dirt / rock / sand / snow by slope+height+noise, macro-variation to kill tiling, detail normal/bump from noise, wetness darkening at the shoreline, cliffs with strata. Procedural textures via canvas/DataTexture with mipmaps + anisotropy. Must receive shadows. Budget 0.8 ms, ≤ 40 draw calls. heightAt must be analytic (no mesh lookup) and stay cheap (grass samples it 100k+ times at init). Also expose terrain.biomeAt(x,z) -> 'meadow'|'forest'|'lake'|'ruins'|'crystal'|'arena'|'mountain' and terrain.POI = {spawn, aetheryte, lake, ruins, forest, crystal, arena} Vector3s at ground height. NEW CROSS-SYSTEM ASK: expose terrain.colorAt(x,z) returning an approximate ground albedo THREE.Color (cheap, analytic, matches what the material renders) — Grass needs it to blend far blades into the ground instead of fading to black. Verify ground-close shots (texture quality underfoot), vistas, the lake basin, cliffs.` },
  { key: 'water', files: 'src/world/Water.js', prev: `Wave-2 critic: LOSE 6 - the raw planar reflection buffer is crisp and correct but compositing destroys it (uReflDistort 0.14 + heavy distance mip bias + 0.4x res = stippled directional mush mixed with murk) - trust the mirror: low distortion, gentler bias (TECHNIQUES.md #9); then re-check foam band width, night moon glitter, and the 0.8 ms budget. WAVE-3 NOTE (TOSSUP 7.2): foam swung from blanket to ABSENT — add back a crisp narrow contact-line lace band at the shoreline (plus sparse crest lace), that one gap is the WIN blocker.`, brief: `PIECE: Water (reference: threejswaterpro.com quality). Own: src/world/Water.js only. Deliver: a lake surface at terrain.waterLevel wherever terrain < waterLevel (at least Mirrormere; a large plane with height-based clipping or a mesh covering the basin) with: planar reflections (real, of sky+terrain+props, rendered at reduced res with a clip plane), refraction with depth-based color absorption (turquoise shallows → deep blue), shoreline foam ONLY as a narrow crisp band at the contact line plus sparse wave-crest lace (not a blanket over the whole shelf), Gerstner/sum-of-sines waves + animated normal detail, sun specular glitter following game.sky.sunDir/sunColor, strong moon glitter trail at night, Fresnel, caustics-like light dapple on the lake bed (optional, cheap), fog-respecting. Must look stunning at golden hour and at night (moon reflection). Budget 0.8 ms incl. reflection pass (reflection at 0.5x res or lower, cull small stuff from it, skip in q=low). Expose water.level, water.isWater(x,z), water.heightAt(x,z) (wave displacement, for splashes) and water.submergedDepth(pos). Verify from the shore of Mirrormere at several angles/times (teleport to about (-95, null, -50) looking toward (-170,-70)).` },
  { key: 'grass', files: 'src/world/Grass.js', prev: `Wave-2 critic: TOSSUP 7 (best piece) - near-field 0-10 m blades read as rigid straight daggers with near-black dark faces (add visible curvature + soft shading gradient - Quick_Grass blade scheme, TECHNIQUES.md #2); low-sun backlight never reads (field goes black at 17.5/6.5 - but USER DECREE in CLAUDE.md: subtle sheen only, tip roughness >= 0.6, NEVER white point-glints); flowers read as confetti (fix with shape, not glow - matte per decree); black shard artifacts on the walked trail; ring value discontinuity in afternoon; no travelling gust waves; grass casts no shadows at q=high. ASSET: blend far blades toward public/assets/tex/grass_albedo.jpg tones / terrain.colorAt when it lands. WAVE-3 NOTE (TOSSUP 7.3): close range 0-8 m is the blocker — stiff near-black daggers over smeared ground, stemless floating diamond flowers; fix close blade shading/curvature, give flowers stems, and blend the ground texture under the near field.`, brief: `PIECE: Grass (reference: aleksandargjoreski.dev/blog/trimming-my-grass-shader — instanced blades, cheap vertex wind, LOD). Own: src/world/Grass.js only. Deliver: dense instanced grass blades (InstancedBufferGeometry, 3-5 verts per blade, curved, tip thinning) around the player in a moving grid of chunks/tiles, density falling off with distance + fading to terrain color (no hard cutoff, no popping), placed only where terrain.biomeAt/slope allows and above waterLevel, height/color varied by noise and terrain color, wind (gusts via noise, blade bending), player interaction (blades bend away from the player + trail), subtle specular/translucency, shadows received (cheap) and cast only near. FF14 Shroud / Destiny Nessus field density is the bar — the meadow must look lush, not sparse, INCLUDING at 25-80 m (mid-distance carpet matters more than blade count underfoot). Also flowers/wild herbs scattered (same system, different blade shape/color) and glowing aether motes near crystals optional. Budget 1.0 ms at q=high, scale count by quality. Zero per-frame allocation. Verify ground-close shot, walk-through bursts (bending), vista (fade), perf idle+sprint windows with grass on/off A/B.` },
  { key: 'vegetation', files: 'src/world/Vegetation.js, src/world/Props.js (and additive helpers in src/world/Colliders.js)', prev: `Wave-2 critic: LOSE 6 - daylight aether crystals read as flat opaque purple low-poly confetti (need facet shading, rim, translucency at noon - the signature FF14 element); re-verify perf vs 0.8 ms / <=60 calls with ablation A/B; impostor lighting (octahedral impostors: TECHNIQUES.md #6, per-instance culling #5). ASSET: public/assets/tex/ruins_stone.jpg for props stone (ASSETS.md). WAVE-3 NOTE (score 5.5): foliage = flat cel-shaded paddle shelves on painted-stripe cylinder trunks — USE THE ASSETS: game.assets.tex('leaf_card') (1024 RGBA alpha cutout) for leaf cards with translucency + color breakup, game.assets.tex('bark') for trunk relief, game.assets.model('column') for ruins columns, game.assets.model('aetheryte') for the landmark (evaluate vs procedural, keep the better).`, brief: `PIECE: Vegetation + props/landmarks. Own: src/world/Vegetation.js, src/world/Props.js (Colliders.js additive only). Deliver procedurally: (a) trees — at least 3 species (tall FF14-style slender trunks with layered leaf canopies, a gnarled old tree, a willow-ish lake tree) via InstancedMesh with LOD (billboard/impostor far — impostors MUST be lit to match near trees and the sky, never near-black), trunk bark material, leaf cards with alpha cutout + wind sway + translucency, placed by biome (Whisperwood dense, scattered elsewhere); (b) rocks/boulders (3-4 shapes, triplanar rock material); (c) glowing aether crystals (clusters, emissive blue-violet, bloom-friendly, subtle pulse, readable facets + rim in full daylight) esp. crystal fields; (d) Props.js landmarks: the Aetheryte at (0,-28) (a huge faceted floating crystal slowly rotating above an ornate stone plinth with rune glyph rings), Sundered Spire ruins (broken columns, arches, cracked tower, stairs) at (140,60), monolith ring at the boss arena (-60,260), some scattered standing stones + lanterns near the spawn path, glowing mushrooms in the forest. Everything registers colliders (game.world.colliders.add) so the player can't walk through trunks/rocks/pillars. Cast/receive shadows near. HARD BUDGET: 0.8 ms, ≤ 60 draw calls total for vegetation+props (merge instanced batches, one material per species part, no per-tree draws). Measure with visibility ablation A/B at spawn AND in the forest and report the numbers. Verify spawn-looking-at-aetheryte shot, forest shots (teleport (0,null,-230)), ruins (teleport (100,null,60) look toward them), crystal field, and collision (walk into a tree in a step script; state.pos must stop).` },
  { key: 'movement', files: 'src/player/PlayerController.js', prev: `Wave-2 critic: TOSSUP 8.2 - swimming surface control broken: holding Space = breach-jump/sink bob cycle (net -0.9 m over 1 s) instead of a clean ascend/surface swim; then re-verify step-up smoothing, hard landings, sprint 180-turn momentum. WAVE-3 NOTE (TOSSUP 8.3): surface swim porpoises (breach cycle 1.9-3.3 m at 1 Hz, speed surging via air cap) — clamp buoyancy rise near the surface and keep the swim state stable while Space is held at surface.`, brief: `PIECE: Movement controller — Destiny 2 Hunter feel. Own: src/player/PlayerController.js only (Player.js/PlayerCamera.js are others'). Deliver: tuned walk 6.5 / sprint ~10 m/s with acceleration curves (quick start, slight weight), sprint requires forward-ish input, sprint cancels on fire/ADS (expose flags others can set: controller.sprintBlocked), crouch, slide (momentum boost, duration, on slope speeds up, cancels into jump keeping speed — Destiny slide-jump), double jump (double jump + brief float when holding Space on 2nd jump), air control, coyote time, jump buffering, landing (impact value by fall speed, brief speed reduction on hard landings), ledge forgiveness, ground snapping on downhill so you don't hop, stairs/steps up to 0.6 m climb smoothed over ~80-100 ms (never an instant y snap), slopes > 50° slide down, water: wading slowdown if game.world.water?.submergedDepth says submerged, swimming if deep (verify in actual deep water: teleport to (-170,null,-70) center of Mirrormere), momentum penalty when wishDir reverses hard against velocity while sprinting; footstep events 'player:footstep' {surface, speed} cadenced by speed; everything frame-rate independent (test with dt variations). Expose state fields the HUD/camera/weapons read (state, speed, grounded, sliding, crouched, velocity, wishDir, sprintBlocked). Verify with step scripts: record state.pos/speed over time to confirm accel/decel timing, slide distance ~8-10 m, double jump height, stairs at the ruins (burst shots, no per-step camera jolt), swimming, no falling through terrain at high speed.` },
  { key: 'camera', files: 'src/player/PlayerCamera.js', prev: `Wave-2 critic: TOSSUP 7 - baseFov 100 is applied as VERTICAL fov (~129 deg horizontal at 16:9 = fisheye GoPro); interpret the 95-100 target as HORIZONTAL fov and convert to vertical per aspect ratio. Then re-verify recoil accumulation, ADS, bob. WAVE-3 NOTE (TOSSUP 8): landing dip could not be verified on a real fall — demonstrate landDip firing on a real 10 m+ drop in the live game (record pitch/pos trace) or fix it if dead.`, brief: `PIECE: Camera feel — Destiny 2 first person. Own: src/player/PlayerCamera.js only. Deliver: mouse look with proper sensitivity (exposed, default ~ Destiny 'sens 5' at 800dpi feel), pitch clamp, FOV base 95-100 with sprint kick (+8), slide kick, ADS zoom blend per weapon (read game.player.weapons.current?.zoom if present, else 1.3x) with fast in (0.18 s) / slightly slower out, head bob that is subtle and speed-scaled (vertical figure-8, lateral sway, reduced when ADS), landing dip with spring (impact-scaled), slide camera lowering + slight roll, strafe roll, crouch height blend, trauma-based camera shake (shake(strength) adds trauma; shake = trauma², decays; perlin-ish not random jitter), recoil kick with smooth recovery (kick(pitch,yaw) with recoil accumulating while firing and recovering after — automatics MUST visibly climb over a 2 s burst), damage flinch hook (flinch()), idle breathing sway, jump apex float feel (tiny fov/pos), smooth eye height transitions. Expose: eye, yaw, pitch, fov, ads, look(), setAds(), kick(), shake(), flinch(), sensitivity, plus per-frame offsets weapons can read for viewmodel sway: view.sway = {x,y} (look-lag), view.bobOffset (Vector3). Verify: burst sequences while walking/sprinting (bob visible but subtle), a 2 s automatic burst showing cumulative climb in pitch numbers, shake+kick via eval, ADS shot, landing.` },
  { key: 'weapons', files: 'src/player/Weapons.js and new files under src/player/weapons/', prev: `No wave-2 verdict (critic killed by usage limit). Wave-1b: LOSE 6 - muzzle flash was a screen-filling white bloom blob (a petal/star flare partially landed since - verify); no hands/arms (src/player/weapons/hands.js appeared since - verify it reads right); sniper ADS naked zoom (needs scope overlay); guns matte navy plastic with one repeated decal, unbeveled edges; verify falloff actually reduces damage at range. ASSET: real gunshot SFX exist (ASSETS.md) - audio wires them; keep emitting the events. WAVE-3 NOTE (score 6): reloads happen with FROZEN hands — the support hand must actually leave the handguard, grab the mag/shells/cell, and drive the motion (Destiny reloads are hand performances). game.assets.model('handcannon') (57k tris, ornate gold revolver) is available as the hand cannon viewmodel base if it beats your procedural model — evaluate, keep the better one.`, brief: `PIECE: Weapons + first-person viewmodel — Destiny 2 bar. Own: src/player/Weapons.js + src/player/weapons/*.js. Contract in Weapons.js header. Deliver: 6 archetypes with distinct stats and feel (handcannon, autorifle, pulse, shotgun, sniper, fusion) + 3 equipped slots. Procedural gun models that look like real sci-fantasy guns (strong silhouettes, beveled edges, dark metal + brass/gold FF14 filigree + glowing element accents, emissive sights) PLUS first-person hands/arms (simple gauntlet/sleeve geometry gripping the weapon — Destiny never shows a floating gun), rendered in the overlay scene via game.postfx.setOverlay(vmScene, vmCam) with your own lights (mirror sky sun) — NEVER clipping. Procedural animation state machine: idle sway/breath, walk/sprint bob (read controller), sprint pose, ADS blend (sights aligned; sniper gets a proper scope overlay: circular mask + reticle + vignette while ADS, not naked zoom), fire recoil (kick back+up + rotational, per-archetype), reload (visible moving parts, duration per archetype), swap (~0.4 s), landing dip, look-lag sway (read view.sway). Firing: rpm-accurate timing, hitscan via game.combat.hitscan, spread/bloom for hipfire, per-archetype recoil via view.kick, ammo/reserve/reload, empty click, auto-reload, muzzle flash: tight 1-2 frame petal/star mesh at the muzzle (crisp, small, mostly hidden by the gun — NOT a screen-filling bloom blob; keep emissive intensity below bloom-nuke levels) + vfx.emit('muzzle') + tracer, audio.play('shot-<archetype>'), events 'weapon:fire' etc. Pass range falloff in the form Combat understands (falloffStart/falloffEnd fields — combat builder is fixing array support this wave; verify with an eval damage-at-distance test). NEW CROSS-SYSTEM ASK: expose weapons.setHidden(bool) (stow/hide the viewmodel) so Abilities can take over the hands during the super. Keys: LMB, RMB ADS, R, 1/2/3, wheel. Budget 0.3 ms. Verify with shots: idle, sprint, ADS (incl. sniper scope), firing burst (flash must be tight), reload mid-animation, each weapon swapped. The gun should look like it belongs in Destiny, not a grey box.` },
  { key: 'abilities', files: 'src/player/Abilities.js', prev: `Wave-2 critic: LOSE 4.5 - every ability's energy blows out to desaturated cream/white (super bolts, melee dome, glowing hands must be SATURATED gold/arc/void emissive cores that keep hue through ACES: saturate the color, cut the intensity); re-verify super viewmodel takeover, rift lying on the ground, daylight readability.`, brief: `PIECE: Abilities (Destiny kit). Own: src/player/Abilities.js only. Deliver the minimum kit from the header (grenade lob with arc + bounce + explode (combat.explode + vfx), melee lunge+shockwave with small dash, heal rift sigil ON THE GROUND (terrain.heightAt — an ornate glowing ring lying flat on the terrain that heals the player inside), super 'Starfall' 6 s: fast homing bolts (combat.projectile with homing) with real screen presence (thick golden emissive tracers, sky-fall framing) + strong vfx + postfx flash/kick on activation + viewmodel takeover: hide the gun via game.player.weapons.setHidden(true) and show glowing hands/energy for the duration) with cooldowns (grenade 25 s, melee 15 s, class 40 s, super meter fills via 'combat:hit' damage events and passively), key handling (G/F/Q/X), super cannot fire weapons, events 'ability:use'/'ability:ready'. Ability colors must read in FULL DAYLIGHT (saturated emissive cores, not white-hot centers that bloom to white). Expose abilities.list in the contract shape + abilities.charge(id) + abilities.superMeter. Verify by eval: use each ability IN DAYLIGHT (hour 13) and at night, screenshot each effect, confirm the gun disappears during super.` },
  { key: 'combat', files: 'src/combat/Combat.js', prev: `Wave-2 critic: LOSE 5.5 - explode() STILL has no line-of-sight ray: a grenade dealt 64.6/100 damage through a solid wall that combat.rayWorld itself reports as 'rock' at 2.8 m (the brief's own acceptance test fails); then daylight projectile color saturation, water surface hits. WAVE-3 NOTE (TOSSUP 8): bolts read as soft colored balloons — view-oriented stretched halo quad + brighter white-hot core; that plus minor polish is the WIN gap.`, brief: `PIECE: Combat / damage resolution. Own: src/combat/Combat.js only. Implement the full header contract: registry, hitscan (targets capsule/sphere + weakPoints with mult, world colliders, terrain ray-march; return object always), projectiles (pooled, visual mesh/sprite with SATURATED emissive element color readable in daylight + optional trail via vfx.attach, gravity, homing, explode on hit, life), explode with falloff + knockback + a line-of-sight occlusion ray (rayWorld to each target; blocked = no/reduced damage), direct damage, targetsInRadius, nearest, rayWorld; crit determination; damage falloff: accept falloffStart/falloffEnd fields AND falloff:[start,end] arrays AND a function — all three must work (add an eval-able test proving damage drops with distance); elemental shield rules; emits all events; kill handling; team filtering; water surface: if the ray crosses game.world.water?.level inside the lake, return surface 'water' at the crossing point (splash vfx/audio hook) instead of marching to submerged terrain; zero per-frame allocation. Keep combat.spawnDummy(pos). Verify by eval: spawnDummy at 5/30/70 m and log per-distance damage (must fall off), grenade behind a rock does 0, projectiles visible in a noon screenshot, lake shot returns 'water'.` },
  { key: 'enemies', files: 'src/enemies/Enemies.js and new files under src/enemies/', prev: `Wave-2 critic: LOSE 4 - melee standoff STILL does not exist: hounds/golems walk straight through the player capsule (closest approach 0.00 m over 10 s vs required >= 1.2 m) and fill the camera; defs.js now has per-type standoff fields - ENFORCE them in AI steering + attack (stop at range, telegraph, strike, circle between attacks); then perf 0.6 ms with 40 alive, saturated colored emissives, better silhouettes. WAVE-3 NOTE (score 6, standoff landed but overtuned): hound dance band (standoff 2.0+2.0) barely overlaps attack-entry (dh<2.6) so 3 engaged hounds landed 2 bites in 20 s — melee pressure is REQUIRED: tighten the band so hounds regularly commit to lunges (several bites per 10 s per hound), keep the no-camera-clip guarantee.`, brief: `PIECE: Enemies — procedural creatures + AI. Own: src/enemies/Enemies.js + src/enemies/*.js. Deliver the 6 types in the header with distinct procedural bodies (wisp: floating glowing core with orbiting shards + trail; hound: quadruped with procedural 4-leg gait, head tracking, tail; sentinel: tall biped with spear/orb, shield bubble; golem: heavy rock body with glowing crystal core weak point, slam; drake: winged flyer with flapping, dives; warden: large mini-boss) using shared geometries + per-instance color/emissive, FF14-mystical materials with SATURATED colored emissives that survive bloom (never flat white), beveled/faceted silhouettes (no raw boxes at close range), idle/chase/attack/stagger/death animations (procedural; death = collapse + dissolve + vfx.emit('death')), AI state machines (perception radius, LOS via combat.rayWorld, steering on terrain with heightAt + slope + collider avoidance, flocking for packs, strafing for ranged, retreat when hurt for wisps), MELEE STANDOFF: melee attackers stop at attack range (~1.5-2.5 m from the player capsule), never touch the camera, attack with wind-up telegraph from there, back off/circle between attacks (Destiny melee dance), attacks (ranged: combat.projectile team 'enemy' with telegraph glow; melee: combat.damage with wind-up; golem slam: combat.explode), health/shield scaling, stagger on heavy hits, weakpoint crits, populate() placing camps per World layout, respawn timers, bounded alive count (≤ 40) with update LOD by distance (far enemies tick at lower rate — HARD BUDGET 0.6 ms CPU with 40 alive; measure via stats().systems and report). Events per contract. Verify: spawn 3 hounds and let them attack — measure closest approach distance over 10 s (must be ≥ 1.2 m), lineup shot, chase/attack (player hp drops), death screenshot, perf with 40 alive.` },
  { key: 'vfx', files: 'src/vfx/VFX.js and new files under src/vfx/', prev: `Wave-2 critic: LOSE 5 - explosion aftermath evaporates by ~1.5 s: clean grass, no dark smoke column, no lingering dust ring, no scorch decal (brief demands a 2-4 s readable aftermath: alpha-blended dark smoke, dust ring, embers, scorch); then daylight saturation of magic effects, muzzle crispness at all angles. WAVE-3 NOTE (score 6): in real noon firing footage 0/5 mid-burst frames showed ANY flash or tracer — per-shot feedback must read in full daylight (bigger crisp 1-frame flash, hotter tracer cores with dark-edged contrast or brief exposure-independent size).`, brief: `PIECE: VFX. Own: src/vfx/VFX.js + src/vfx/*.js. Implement the header contract: an instanced/GPU particle system (one InstancedMesh or Points-with-attributes per blend mode: additive + ALPHA-BLENDED (for smoke/dust — additive-only cannot make dark smoke); per-particle pos/vel/life/size/color/rotation/gravity/drag in pooled typed arrays ~20k; soft textures on canvas: spark, glow, smoke puff, ring, star, rune), presets with real art direction that READ IN DAYLIGHT (saturated cores, dark alpha smoke for contrast, not white-on-white): muzzle: crisp 1-frame petal/star + few sparks + small smoke wisp; impact-terrain: dust puff + dirt bits; impact-rock: sparks + chips; impact-enemy: aether sparks in element color + small ring; explosion: flash + fireball (0.3-0.5 s) + shockwave ring + embers (1-2 s) + rising DARK smoke column (2-4 s) + dust ring that lingers; aether-burst: spiral motes; death: rising motes + ring; sigil: rotating rune ring with some 3D presence (double-sided + slight cone/height or vertical glyphs so grazing angles still read), tracers (instanced thin stretched quads with glow, fast fade), beams, decals (pooled 200), light flashes (pooled PointLights, max 4), attach() emitters, shockwave rings. Subscribe to the combat/player events listed. Element colors from ELEMENT_COLORS. Zero per-frame allocation; ≤ 8 draw calls for all particles; budget 0.4 ms with 5k live. Verify by eval AT NOON (hour 13) and at night: call each preset in front of the camera with burst sequences covering the full lifetime (explosion needs shots at 0/0.2/0.5/1/2 s showing smoke persistence).` },
  { key: 'audio', files: 'src/audio/Audio.js and new files under src/audio/', prev: `Wave-2 critic: LOSE 6 - music fails its own audibility gates (>900 Hz energy 6.8%/1.6% vs >8% required; L/R correlation 0.855 = nearly mono; 69.5% of energy < 300 Hz). NEW ASSETS replace the weakest synth: public/assets/music/{field-theme,night-theme}.mp3 and public/assets/sfx/shot-<archetype>-{1..4}.mp3 + explosion-{1..4}.mp3 (4 distinct takes each; see ASSETS.md). Wire them: decode into AudioBuffers at init, round-robin takes per shot with +-3% rate jitter, keep the 3D pan/reverb bus and synth layering; explosion gain scaled by event radius; music = the mp3s with crossfaded looping, day/night switch, duck under combat. Keep synthesized foley (reloads, footsteps, UI, abilities) and keep synth fallback if buffers have not loaded (auto mode must stay silent-but-tracked). WAVE-3 NOTE: the generated mp3 takes are STILL NOT WIRED (your fix round was killed before it started) — wiring game.assets.audioBuffer round-robin takes for shots/explosions is the single biggest win and is mandatory this round; the critic also wants a WaveShaper saturation stage + inharmonic metallic partials on any synth layers.`, brief: `PIECE: Audio (all synthesized). Own: src/audio/Audio.js + src/audio/*.js. Implement the header contract with WebAudio: a master bus with compressor/limiter + reverb send (procedural impulse), 3D panning with distance rolloff, pooled voices, each SFX synthesized with care — gunshots MUST have: a sharp mechanical transient/click layer, a mid-frequency bark/report (300-2500 Hz body), a low thump, a room tail 400+ ms, and ±3-6% per-shot pitch/level randomization per archetype (sniper adds echo; fusion charge = rising whine); reload = mechanical click sequence; footsteps per surface; impacts; hit tick / crit brighter / kill chime; abilities; explosion = boom scaled by event radius (small radius = short crack+thump, big = full 1.5 s sub-boom — read the event's radius field); ambient bed WIDE STEREO (two decorrelated noise channels, filter LFOs, birds/insects by time of day, night crickets); music: generative mystical piece with an AUDIBLE melody line (lead voice 500-2000 Hz, gentle arpeggio + slow chords in dorian/lydian, phrase structure, not a flat drone), wide stereo, soft volume, started after first gesture. Listens to game events per contract. Unlock on first click/keydown; silent in game.auto but tracked (audio.debugLastPlayed). Expose setMaster/music/ambient. Verify via audio.selfTest() (OfflineAudioContext RMS check) AND render a few seconds offline and assert spectral spread (report the numbers: shot energy % in 300-2500 Hz band must be >25%, music >900 Hz energy >8%).` },
  { key: 'hud', files: 'src/ui/HUD.js, src/ui/ui.css and new files under src/ui/', prev: `No verdict yet (both critics killed before returning). Built fresh at end of wave 1b: full ornate HUD (per-archetype crosshair, hit markers, damage numbers, ability icons, health/shield, nameplates, boss bar, toasts, death screen, pause menu). First surviving critic pass - judge everything.`, brief: `PIECE: HUD / UI. Own: src/ui/HUD.js, src/ui/ui.css, src/ui/*.js. Implement the header contract fully with a real art direction: FF14 ornate (thin gold filigree borders, soft aether-blue glows, serif-ish display font from the system stack, subtle gradient panels) + Destiny clarity/layout (crosshair center with archetype-specific reticle + spread + hit marker + crit/kill flash; bottom-right ammo mag/reserve big numerals + weapon name + element icon + 3 slot indicator; bottom-left 4 ability icons with radial cooldown sweep + ready pulse + super meter bar; top-left health + shield bars with regen shimmer and damage flash; damage numbers floating from world points (pooled DOM, crit = bigger yellow, element colors); directional damage arcs; enemy nameplate/health bar for the target under the crosshair with name + level + shield; boss bar top with phase ticks; toasts/notify banner and quest tracker; interaction prompt; pickup feed; low-health red vignette pulse; death screen + respawn; pause menu on ESC with sensitivity/fov/quality sliders; start screen; perf overlay toggle (F3 / ?debug=1). Zero layout thrash. Verify: screenshots of spawn (full HUD), firing (hit marker + damage numbers via dummy), damaged state, death screen, pause menu.` },
]

const buildPrompt = (p, round, critic, prevReport) => `${COMMON}
${p.brief}
Files you own: ${p.files}. Do not edit anything else.
Previous wave's critic found (context, may be partially fixed already): ${p.prev}
${critic ? `A fresh harsh critic just inspected the running game and said (JSON): ${JSON.stringify(critic)}.
Fix the biggest gap FIRST, then the rest of gaps_ranked. Verify each fix in screenshots/perf before claiming it.` : ''}
NOTE: your files were already implemented by previous builders (a fix round may have been cut off mid-work). Read them fully first, keep what is good, finish what is missing, then address the critic.
${prevReport ? `Previous builder report: ${prevReport}` : ''}
Return your report as plain text (<= 25 lines).`
const criticPrompt = (p, n) => `Project: C:\\Users\\ianca\\Desktop\\FPS3. Read tools/CRITIC.md in full and follow it exactly; also read CLAUDE.md. You are critic #${n} for PIECE "${p.key}" (files: ${p.files}). Piece brief (what the builder was asked to deliver): ${p.brief}
Inspect the actual running game with tools/inspect.mjs (use --name critic4-${p.key}-${n}), look at the screenshots, read report.json, then do the blind side-by-side against the real Destiny 2 / FF14 equivalent and return the JSON verdict. Be brutal and specific.`

const MAX_FIX_ROUNDS = 3
const PREJUDGED = {
"terrain": {
"piece": "terrain",
"verdict": "LOSE",
"score": 5.5,
"scores": {
"visual": 5,
"feel": 7,
"performance": 9,
"polish": 6
},
"biggest_gap": "Mountain/cliff rock is the frame-filling element of every vista and it reads as smooth soft-serve mounds with identical sin-wave strata corduroy and flat polygon-edged snow sheets — no sharp ridgelines, no faceted crag structure, no per-region variation.",
"gaps_ranked": [
"Mountain ring silhouettes are smooth rounded lumps: add higher-frequency domain-warped ridged octaves so skylines get sharp crests and faceted faces instead of meringue mounds (shot-lake-beach, shot-plateau-skirt background, shot-nw-pass-vista)",
"Strata banding is the same horizontal sin-wave corduroy on every slope in the world: vary band frequency/amplitude/tilt per region and mask by macro noise so it stops reading as one synthetic pattern (shot-arena-rim)",
"Sundered Spire plateau skirt reads as a smooth dark felt mound, not 'broken rock outcrops': the ridged3 skirt term never breaks the silhouette, and the shadowed rock face clips to near-black with zero readable detail (shot-plateau-skirt)",
"Mid/far ground albedo goes flat: beyond ~110 m the detail fade leaves one uniform saturated green (meadow) and one uniform brown (dirt/forest) — the aerial reads as a two-tone poster; keep more macro albedo contrast at distance (shot-aerial, shot-arena-rim midground)",
"Mountain approach belt (r 250-350, e.g. around 280,280) is a vast featureless smooth dirt ramp with no scree, rock breakup, or strata — worst texture-quality area in the zone (shot-cliffs-close)",
"Ruins flagstones underfoot are murky moss-green blobs with cavernous black mortar gullies; stone grain is low-frequency mush vs FF14 masonry — brighten stone, tighten mortar depth, add crisp grain (shot-ruins-flagstone; arena-floor at noon looks much better, so it is partly the moss tint + AO depth)",
"Sawtooth aliasing artifacts along the rock-to-grass blend boundary at the plateau skirt base (shot-plateau-skirt bottom edge)",
"Shoreline wetness darkening barely reads — the island waterline shows only a faint band; widen and strengthen the wet gradient so beaches read wet like FF14 shores (shot-lake-beach)"
],
"strengths": [
"Clipmap LOD is genuinely crack-free and pop-free: sprint burst shots show no seams or vertex swimming; 5 levels x 192 cells, terrain per-system CPU 0.00 ms",
"Performance is excellent: idle 179 fps, frame mean 5.58 ms, p99 9 ms, 137 total draw calls (terrain ~5 of a 40 budget), tris 1.8 M, memMB flat at 98.2 across all windows (no leak), zero page errors",
"World layout faithfully shaped to CLAUDE.md: lake basin with beaches + island, plateau, flat boss arena with rocky rim, forest ground, mountain ring with a real NW pass gap",
"Forest floor leaf-litter texture close-up is genuinely good — crisp elongated leaves, russet palette, believable humus (shot-forest-floor)",
"Full API delivered: analytic heightAt, biomeAt, colorAt (grass blades blend into ground color, no black fade in shot-ground-mid), POI; staggered worker bake means no load hitch ([terrain] preview ready in 181 ms)",
"Arena-rim view at noon shows the strata ledges reading as plausible sedimentary badlands at mid-range — the best-case rock shot"
],
"evidence": [
"shot-arena-rim.png: entire mountain ring shares identical horizontal strata corduroy; snow caps are flat white sheets with polygonal edges; midground grass is one uniform saturated green carpet",
"shot-plateau-skirt.png: plateau skirt is a smooth near-black felt mound — no broken outcrops in the silhouette; sawtooth blend artifacts along the rock/grass base",
"shot-cliffs-close.png: mountain approach at (280,280) is a featureless smooth dirt dune, no scree or rock breakup",
"shot-aerial.png (170 m up): terrain reads as two flat paint fills, green south / tan north — macro variation too weak to survive distance",
"shot-lake-beach.png: lake basin composition good (island, beach ring, tree line) but far shore is flat green and mountains are banded soft-serve; wetness band faint",
"shot-ruins-flagstone.png: underfoot stones are murky green blobs with huge black mortar gullies"
],
"errors": [],
"perf": {
"fps": 179.2,
"p95ms": 7.8,
"p99ms": 9,
"calls": 137,
"tris": 1803858
}
},
"sky": {
"piece": "sky",
"verdict": "LOSE",
"score": 4,
"scores": {
"visual": 4,
"feel": 6,
"performance": 9.5,
"polish": 3
},
"biggest_gap": "The cumulus layer renders as giant translucent conical spikes (a fence of dithered beige teeth at dawn/golden/dusk, from the column-height extrusion + towering-slab term) instead of rounded lit-top/dark-belly cauliflower masses — every daytime sky instantly reads as broken.",
"gaps_ranked": [
"Cumulus shapes are conical spikes, not clouds: the 2.5D column-height march extrudes each coverage peak into a vertical cone, and the golden-hour towering term (uCloudH1 2900->4400) turns them into 40-degree-tall teeth ringing the horizon at dawn/17.5/dusk; needs rounded domed column profiles / domain-warped fbm masses with flat bases and cauliflower tops, and a much shorter slab",
"Noon horizon shows an opaque flat white sheet with a razor-straight top edge spanning the whole west horizon (slab saturating at the shell tangent); needs distance coverage taper / aerial fade before the layer merges into a wall",
"Visible dither crosshatch grain across every cloud body at 1080p (screen-space interleaved-gradient jitter is step-correlated, producing diagonal burlap/static texture, worst on the night clouds); needs blue-noise decorrelated per-step jitter, more steps, or a soft filter",
"Clouds have no readable light structure: no white-gold lit tops vs dark bellies, no silver lining toward the sun at golden hour — they render as uniform translucent haze despite the beer/powder code; self-shadow contrast and forward-scatter rim need to actually show at 1080p",
"Night horizon artifact: a bright white pleated 'organ-pipe' curtain rises from the horizon at the bottom of shot-night-south-moon.png (aurora/cloud term intersecting the horizon)",
"Cloud drift is imperceptible: 4-shot burst over 6 s at golden hour shows pixel-identical cloud positions, so the dramatic sky reads frozen",
"Milky way / nebula wash at night-north reads slightly muddy red-brown rather than FF14's clean blue-violet"
],
"strengths": [
"Atmosphere color script is genuinely FF14-adjacent at all 5 hours: salmon-violet dawn, deep azure noon zenith, warm amber golden hour, mauve-pink civil-twilight dusk, luminous indigo night — smooth gradients, no banding",
"Night sky package is strong: crisp magnitude-varied stars with clustering, phase-lit moon with soft glow, teal aurora curtains with ray structure over the north — best-in-piece view",
"Sun disc + glare look right at low elevations (golden-west-sun) and the disc is exposed via sunMesh for god rays",
"Horizon haze and fog color stay consistent with the dome at every hour; terrain melts into sky-colored haze correctly",
"Performance excellent: Sky CPU 0.01 ms, frame mean 5.61 ms / p99 8.8 ms at 1080p q=high, 178 fps, 130 calls, zero page errors, no cost spike from the golden-hour tall slab (sky-noon vs sky-golden windows identical)"
],
"evidence": [
"shot-golden-west-sun.png + crop-spike.png: cumulus = translucent conical spikes with diagonal dither crosshatch, zero cauliflower structure, no lit-top/dark-base shading; horizon behind mountains shows a flat horizontal cloud sheet edge",
"shot-dawn-east-sun.png / shot-dusk-west-glow.png / burst-golden-drift-*.png: same spike-fence clouds at every low-sun hour; dusk teeth are pink but still teeth",
"shot-noon-north.png + crop-noonband.png: razor-straight hard-edged opaque white band across the left horizon at noon; small dithered cones above",
"shot-night-south-moon.png: right-side night clouds are heavy dither static; bottom-center bright vertical-striped curtain artifact between mountains; moon+stars themselves read well",
"shot-night-north-aurora.png / shot-night-zenith-stars.png: aurora curtains, star field, milky way — genuinely attractive, near-FF14 night quality",
"burst-golden-drift-0..3 (2 s apart): cloud positions pixel-identical — no perceivable drift"
],
"errors": [],
"perf": {
"fps": 178.3,
"p95ms": 7.9,
"p99ms": 8.8,
"calls": 130,
"tris": 1850994
}
},
"combat": {
"piece": "combat",
"verdict": "TOSSUP",
"score": 8,
"scores": {
"visual": 7.5,
"feel": 8.5,
"performance": 9.5,
"polish": 8
},
"biggest_gap": "Close-range projectile look: the glow halo is a velocity-agnostic round point-sprite that overwhelms the hot core, so bolts read as soft colored balloons instead of hot elemental darts — needs a view-oriented stretched halo quad plus a brighter white-hot center.",
"gaps_ranked": [
"Projectile glow halo never stretches with velocity and dominates the core: side-on and close-up bolts are flat round discs (shot-storm.png, crop-bolts-near) vs Destiny's stretched hot-core darts",
"Crit over-award: hitscan sets crit = !!wp even when the body entry t is nearer than the weak point along the ray (Combat.js ~line 313 + _castTargets), so torso-first shots that clip the head sphere still pay full crit mult — D2 counts the first-struck hitbox",
"Hitscan CPU ~44us/ray (2000 rays = 87.9 ms): _rayColliders steps 16 m broadphase queries over the whole range; fine for rifles but tight for 12-pellet shotguns plus AI LOS spam — sort colliders by entry or early-out on first segment hit",
"Glow disc shows a visible hard-ish edge against bright sky (shot-storm.png) — the (1-d2)^3 falloff clips against a bright background; widen the falloff tail or premultiply against luminance",
"Training dummies read as toy pill-people (capsule + collar, crop-dummies) — functional and element-glow-coded, but a mannequin silhouette would sell training-range screenshots",
"Mortar splash-on-target unverified in-run: the gravity projectile exploded (audio counter incremented) but landed >6 m from the dummy, health stayed 300 — explode() damage/occlusion proven separately; expose a deterministic mortar test hook",
"out of scope: world colliders.query returned a collider ~380 m outside the query radius (asked (140,60) r70, matched rock at (-113,-128)) — Colliders.js broadphase looseness inflates every hitscan's collider cost"
],
"strengths": [
"All three falloff forms work and damage measurably falls with distance: testFalloff = [100,80,50] for fields/array/fn; live shots 100 dmg @5 m, 80.4 @30 m",
"Weak-point crit exact (100 x 1.6 = 160, weakPoint returned), elemental match game exact (arc-on-arc-shield 100 = 2x, solar-on-arc 50, shield absorbed to 350)",
"Water surface contract fully honored: dry hitscan, rayWorld, and live impact events all return 'water' at exactly water.level 4.0, for both hitscan and a projectile fired into Mirrormere",
"Explosion line-of-sight occlusion works: 0 dmg behind a rock vs 62.9 open control at identical distance, 61.2 open-field control",
"Homing projectile turned >90 degrees and hit for exactly 77; gravity mortar arcs visibly (shot-mortar-arc.png)",
"Six element bolt colors all distinct and readable at noon in full daylight and gorgeous at night (crop-bolts-near, crop-night)"
],
"evidence": [
"report.json testFalloff: fields/array/fn all [100, 80, 50] at 5/30/70 m",
"report.json live falloff eval: [5 m, 100 dmg], [30 m, 80.4 dmg]; 70 m shot intercepted by nearer dummy in line (test geometry, engine behaved correctly by hitting the first target)",
"report.json crit/shield eval: {crit: true, critDmg: 160, wp: true, matchDmg: 100, offDmg: 50, shieldLeft: 350}",
"report.json water eval: {hs: 'water', hy: 4, rw: 'water', level: 4}; impact listener recorded ['water','water', 'rock' x6]",
"report.json occlusion eval: {blockedDmg: 0, openDmg: 62.94, openField: 61.15} using sphere rock r=3.34",
"report.json homing eval: dummy health 300 -> 223 (exactly 77) from a 90-degree-off launch"
],
"errors": [],
"perf": {
"fps": 162.3,
"p95ms": 8.6,
"p99ms": 10.2,
"calls": 137,
"tris": 1803266
}
},
"water": {
"piece": "water",
"verdict": "TOSSUP",
"score": 7.2,
"scores": {
"visual": 7.5,
"feel": 7,
"performance": 9,
"polish": 6
},
"biggest_gap": "Shoreline foam is effectively absent — no crisp contact-line lace band anywhere on Mirrormere (a brief requirement), so every waterline reads as a bare sand-to-water seam like a tech-demo lake.",
"gaps_ranked": [
"Shoreline foam missing: no crisp narrow lace band at any contact line and no crest lace in open water — debug-foam view is nearly black across the lake; raise foam coverage/thresholds so a 1-2px animated band traces every shore",
"Grazing-angle reflection tearing: tree/pillar reflections shred into vertical comb-teeth stripes and clamped reflection UVs smear bright sky into solid vertical columns at screen edges (worst with moon/aurora at night); fade reflection distortion at grazing and fade the reflection out near UV edges instead of clamping",
"Reflected geometry aliasing: reflected mountains/clouds show sawtooth stair-step edges and crosshatch dither fizz from the 0.4x reflection target — will shimmer in motion; add more edge-region mip bias or a cheap separable blur on the reflection RT",
"q=low midday water collapses to a milky-white opaque sheet: the sky-gradient fallback plus the alpha-blend cover formula washes out the turquoise identity entirely",
"Moon glitter blows out into a solid white sheet at some angles/positions instead of a sparkle trail — needs the soft-knee clamp tuned for the moon path too",
"Night lake away from the moon is featureless near-black; FF14 night water keeps star-glint sparkle and ambient sheen everywhere, not just on the moon azimuth",
"Bright blue caustic dapple disc sits directly beneath the player at night and reads artificial (visible in brightened night shots)",
"Detail-normal tiling repeats as a visible fabric-weave pattern in the 5-30m band at midday (noon shot near field)"
],
"strengths": [
"Golden hour and dawn are genuinely FF14-caliber stills: real planar reflections of mountains/trees/sun disc, warm sun trail, forward-scatter glow through crests (shot-golden-shore, shot-dawn-shore)",
"Depth absorption works as briefed: turquoise shallows falling fast to deep blue, believable cloud reflections at noon (shot-noon-shore)",
"Strong long moon glitter trail when facing the moon, plus star glints and caustic dapple at night (shot-low-night-moonface, crop-night2-bright)",
"Real reflection pipeline is cheap: disabling it recovers only 0.76 ms (229.9 to 278.6 fps); frame mean 4.35 ms with the lake filling the screen, zero per-frame leaks (memMB flat 110.6)",
"API verified live: level=4, isWater(-170,-70)=true, heightAt returns animated 4.006, submergedDepth 1.006 — CPU twin matches the visible surface",
"q=low fallback exists and holds 3.2 ms mean / 279 fps with reflection and grab correctly off (hasGrab:0, hasRefl:0)"
],
"evidence": [
"shot-golden-shore.png: sun trail + mirrored mountains/trees — the hero shot, would hang in a blind panel with FF14 La Noscea",
"crop-noon-shoreline.png + crop-golden-contact.png: island and beach contact lines have zero foam lace — bare seam; shot-debug-foam.png is near-black across the lake confirming foam barely fires",
"burst-golden-motion-1.png: reflected trees/pillars torn into vertical comb-teeth stripes; reflected mountains show sawtooth/dither fizz from the 0.4x reflection target",
"crop-night2-bright.png: bottom-left screen-edge reflection smeared into solid vertical columns (clamped UVs); bright artificial caustic disc under the player",
"shot-night-shore.png: facing away from the moon the lake is featureless near-black (aurora overhead barely reads on the surface)",
"shot-low-night-moonface.png: excellent long moon glitter trail — the brief's night bar is met when facing the moon; shot-low-night-moonface-2.png: same glitter blows out to a solid white sheet from another angle"
],
"errors": [],
"perf": {
"fps": 229.9,
"p95ms": 6.4,
"p99ms": 7.2,
"calls": 78,
"tris": 879150
}
},
"vegetation": {
"piece": "vegetation",
"verdict": "LOSE",
"score": 5.5,
"scores": {
"visual": 5,
"feel": 7,
"performance": 8,
"polish": 6
},
"biggest_gap": "Tree foliage reads as flat cel-shaded solid-green paddle shelves on smooth painted-stripe cylinder trunks — toy/model-railroad trees in every vista; needs textured alpha-cutout leaf cards with color breakup, translucency and bark relief to approach FF14.",
"gaps_ranked": [
"Tree canopies are solid-color low-poly paddle layers with hard cel banding and zero foliage texture; trunks are smooth cylinders with painted-on stripes — mid-distance trees look like toy props in the background of every landmark shot",
"Crystals up close are featureless purple-to-white gradient faces that blow out to pure white (crystals-close.png right half fills the screen with a blank gradient); mid-distance clusters read as flat violet blobs — brief required readable facets + rim in full daylight",
"Sundered Spire tower reads as Minecraft: perfectly regular box courses, uniform crenellation teeth, one beige albedo for tower/columns/arches/paving with no weathering, moss or material separation",
"Ruins paving is a bright uniform bathroom-tile grid with sparse dead-grass spikes poking through the slabs — reads as a placement bug and kills the 'ancient plateau' read",
"Impostor LOD cross-fade dither stipple visibly fizzes on mid-distance trees (forest-far-golden.png) — reads as screen-door shimmer at 1080p",
"Glowing forest mushrooms read as pale cyan pebbles at night — no bloom halo, no light pools on surrounding grass (forest-night-mushrooms.png)",
"Monolith rune emissive texture is mushy/low-res at melee range and the slab is a plain tapered box up close (arena-monoliths.png)",
"Vegetation+props CPU cost ~1.2 ms by forest ablation delta (5.14 vs 3.91 cpuMs) vs the 0.8 ms system budget — whole frame still within global budget"
],
"strengths": [
"Aetheryte landmark genuinely strong: floating faceted crystal, rotating glyph rings, orbiting shards, lantern-lined approach; the night shot with aurora is near toss-up quality for that one vista",
"Collision is flawless: collisionSelfTest passes all 6 cases (tree/rock/crystal/ruins wall/monolith/pedestal) and a scripted walk into a forest tree stopped at gap 0.88 m = trunk r 0.48 + player radius",
"Draw-call discipline well inside budget: veg+props = 46 calls at spawn (126->80 ablation), 22 in forest (83->61), vs <=60 allowed; 1722 trees + 680 rocks + 242 crystals built in 909 ms",
"Impostors pass the lighting test: distant trees tint correctly warm at golden hour, never near-black (forest-far-golden.png)",
"Monolith ring + emissive rune columns and central dais read well at mid distance; crystal fields give strong purple color pop against the grass at range",
"Zero console/page errors across both runs; memMB stable"
],
"evidence": [
"shot-forest-n.png: canopies are solid-green paddle shelves with cel banding, trunks smooth white cylinders with painted black stripes; three species visible (slender birch-like, dark conifer, gnarled oak) — willow at the lake not verified (no lake shot taken)",
"shot-crystals-close.png: giant crystal face is a blank purple->white gradient blown to white at the edge; also an unexplained flat pink disc artifact on the hillside at frame left",
"shot-crystals-day.png: mid-distance crystal clusters read as flat solid-violet cones; facets only readable on the nearest few",
"shot-ruins-approach.png: tower built from uniform box courses (voxel look), arches perfectly clean, everything one beige; paving tile grid with dead-grass spikes poking through slabs",
"shot-arena-monoliths.png: rune glyph emissive is soft/low-res at close range; slab silhouette is a plain tapered box; distant monolith ring reads well",
"shot-forest-far-golden.png: impostor trees correctly lit warm (pass) but visible dither stipple on LOD cross-fade trees"
],
"errors": [],
"perf": {
"fps": 148.6,
"p95ms": 8.7,
"p99ms": 9.7,
"calls": 118,
"tris": 1499798
}
},
"enemies": {
"piece": "enemies",
"verdict": "LOSE",
"score": 6,
"scores": {
"visual": 5.5,
"feel": 6,
"performance": 7,
"polish": 6.5
},
"biggest_gap": "Melee pressure is effectively absent: the hound dance band (standoff 2.0 m + 2.0) barely overlaps the attack-entry range (dh < 2.6), so 3 engaged hounds landed only 2 bites in ~20 s and player HP stayed at 100 through a 6 s god-off window — the required \"player hp drops\" verify failed.",
"gaps_ranked": [
"Hound melee cadence: 3 hounds, 2 bite attacks in ~20 s, player HP never dropped during the 6 s god-off window (report eval minApproach/playerHealth step: {minApproach: 2.0, playerHealth: 100}); widen attack entry (start bite from the dance band, dh < ~3.4) or shorten cooldown/token spacing",
"Daylight emissive death: at hour 15 eyes/visor slits/spine crystals/aether lines read as flat matte lavender — no visible glow or bloom on hound spines, sentinel visor, warden chest core (shot-close-hound, shot-close-sentinel, shot-close-warden); glow only sings at night",
"Point-blank hound reads as a glowing toy pug: big rounded-box muzzle with a grey jaw band plus full-body cyan fresnel rim at the 2 m ring turns it into blue glass (burst-death-2, burst-hound-attack-0/2); soften uRim by view distance and break up the muzzle shape",
"Shield bubbles are beach-ball soap spheres that hide the creature: sentinel (r 1.55) and warden (r 2.6) bodies are half-obscured in every shot (shot-lineup-wide, shot-warden-combat); shrink to body-hugging and lower base alpha, keep the hit flare",
"Wisp is the weakest body: reads as a small blue ring + white faceted cube with no motion trail and no emissive core presence in daylight (shot-close-wisp); it should read as a burning aether orb with orbiting shards and a trail",
"Sentinel daylight look is a drab grey-tan cardboard mannequin: gold trim, chest aether lines and spear-tip crystal all vanish at noon (shot-close-sentinel)",
"Enemies CPU 0.71 ms avg with 40 alive vs the 0.6 ms hard budget (stats alive40 systems.Enemies 0.71, baseline 0.01) — ~18% over; frame budget still met",
"lineup() is unusable for the drake: it climbs to hover 11 m and leaves the close-up frame entirely (shot-close-drake shows only wing tips at top); pin flyers low while passive lineup is active"
],
"strengths": [
"Standoff ring is airtight: measured closest approach exactly 2.000 m over ~16 s of 3 hounds engaging — melee never touches the camera, and the circle/back-off dance is visible across burst-hound-attack frames (genuinely Destiny-like spacing)",
"Night look is excellent and FF14-mystical: saturated colored rims (cyan golem, purple warden crown/halo, blue sentinel bubble) under aurora, nothing clips to white (shot-lineup-night)",
"Golem is a genuinely good body: faceted rock mass, glowing blue eyes and crystal core weak point, floating debris, and a readable two-arm overhead slam telegraph (shot-close-golem area of close-sentinel shot, burst-golem-slam-3), slam fires combat.explode + shockwave + dust + camera shake",
"All 6 types distinct with per-instance palettes, one SkinnedMesh each (164 total draw calls with 40 alive), procedural planted-foot gait, head tracking, tails, wing flapping visible in bursts",
"Perf with 40 alive: 144 fps, frame mean 6.94 ms, p99 10.7 ms, 1.93 M tris, memMB stable 104, zero page errors; ranged pressure works (enemy-shot 19, player-hurt 18 during the 40-alive window)",
"Full system plumbing: camps per world layout, respawn slots, pack alert on gunfire, wisp flee, warden phase shields, events (enemy:death drives VFX dissolve burst + audio), LOD tick staggering"
],
"evidence": [
"report.json eval step t=45.44: {minApproach: 2.0, playerHealth: 100} — standoff >= 1.2 m PASSED, but hp-drop verify FAILED (hp 100 after 6 s god-off with 3 hounds engaged)",
"report.json audio counters: enemy-attack 2 at t=39.4 and still 2 at t=51.8 — two melee attacks total from 3 hounds over ~20 s of engagement",
"stats alive40: fps 144.1, frameMs mean 6.94 / p95 9.6 / p99 10.7, calls 164, tris 1928448, memMB 104; systems.Enemies 0.71 ms (hard budget 0.6) vs baseline 0.01 cleared",
"shot-close-hound.png / burst-hound-attack-2.png: hound at melee range reads as matte purple toy with a grey jaw band; spine crystals and eyes show no daylight glow",
"burst-death-2.png / burst-hound-attack-0.png: cyan-palette hound at the 2 m ring is full-body rim-lit into translucent blue glass; the actual killed hound's collapse+dissolve happened ~15 m away and is barely visible in burst-death-0/1",
"shot-lineup-wide.png / shot-warden-combat.png: oversized soap-bubble shields dominate sentinel and warden; drake absent from its lineup slot (red wings at top edge)"
],
"errors": [],
"perf": {
"fps": 144.1,
"p95ms": 9.6,
"p99ms": 10.7,
"calls": 164,
"tris": 1928448
}
},
"movement": {
"piece": "movement",
"verdict": "TOSSUP",
"score": 8.3,
"scores": {
"visual": 8,
"feel": 8.5,
"performance": 9.5,
"polish": 7.5
},
"biggest_gap": "Surface swimming porpoises: holding Space at the surface breaches repeatedly (feet y cycles 1.9→3.3 m at ~1 Hz), state thrashes swim→air→swim, and speed surges 4.0→6.5 m/s on every breach because the air cap takes over — clamp the buoyancy rise near the surface and keep 'swim' state while within ~0.5 m of it.",
"gaps_ranked": [
"Surface swim porpoising: Space-held rise breaches out of water at ~1 Hz (y 1.88→3.33→1.88 full-res trace), state flickers swim→air→swim so camera/HUD/audio see 1 Hz state thrash, and horizontal speed surges 4.0→6.5 m/s each breach; hold the player at depth≈swimDepth-0.35 while rising and keep 'swim' until well clear of water",
"Sprint 180-degree reversal scrubs 10→1.15 m/s in ≤60 ms — an instant arcade stop; Destiny carries ~0.2-0.3 s of weighty deceleration through a hard reversal (lower decelK for reversals or blend through)",
"state reports 'idle' while pushing into a wall with W held (ruins trace: speed 0.11, state I for 8 s against the tower) — animation/camera/audio consumers lose the run cue; report 'walk' when wishDir is nonzero even if speed < 0.3",
"Coyote time, jump buffering, and ledge forgiveness are implemented in code but not verifiable live — expose a __game debug hook (e.g. forced walk-off-ledge + delayed jump) so a critic can confirm the 0.12 s window actually works",
"Wade speed wobbles ±0.35 m/s around ~3.4 at constant input over undulating lakebed (run-1 water trace 43981-45601) — depth-driven cap changes read as micro speed pumping; smooth the wade cap over ~0.3 s",
"Terminal-velocity hard landing locks to ~12% speed for a full ~1 s (fall trace: 1.93 m/s recovering to 5.07 over 0.8 s) — heavier than Destiny's ~0.4 s stumble; justified only if fall-damage feedback lands with it"
],
"strengths": [
"Walk/sprint measured at exactly 6.5/10.0 m/s with 0→95% accel in ~200 ms and full stop in ~170 ms — Destiny-matched tuning, not approximation",
"Slide is in spec: boost to 12.46 (12.5 target), 8.8 m over 1.08 s, decays into crouch with cooldown; player:slide event fires at 12.5",
"Slide-jump carries 10.94 m/s untouched through 0.8 s of air and lands straight back into 10.0 sprint — the Destiny slide-jump tech genuinely works (jump event n=1 slide=true)",
"Double jump +3.33 m total with working hold-to-float (fall only 0.55 m in the 310 ms after apex); correct n=1/n=2 events",
"Stair/step-up: three 0.2-0.4 m rises each eased over ~100-130 ms at constant 6.5 m/s, zero instant y snaps in the full-res trace — the Destiny stair glide",
"Sprint gating is exact: cancels the frame fire is held (9.65→6.5 over 300 ms), resumes ~0.2 s after release; requires forward-ish input (backward sprint correctly denied in reverse test)"
],
"evidence": [
"critic3-movement-1/report.json walk trace: speed 1.52→4.46→5.75→6.16→6.45→6.50 over ~440 ms after W-down; release: 6.5→2.13→0.68→0.22 in ~170 ms",
"run-1 sprint trace: flat 10.00 m/s for 6+ s; firecancel trace t=10831: state R→W on fire-down, 9.65→6.5 in ~300 ms, R resumes ~11582 (~150-200 ms after release) — matches sprintResume 0.2 s",
"run-1 slide trace: 10→12.46 boost at t=12997, x 54.92→63.69 (8.8 m) in 1.08 s, exits to crouch 3.5 m/s; events.slide=[12.5]",
"critic3-movement-2 slidejump2 trace: L at 11.86 → jump → state A with speed locked 10.94 for 0.8 s → lands t=4458 at 10.4 → sprint 10.0; jumps meta [[1,1]]",
"run-2 plinth full-res trace t=13889-14414: y 7.386→7.587 (~100 ms), 7.587→7.937 (~100 ms), 7.937→8.337 (~130 ms), each eased, speed 6.5 throughout — no snap; burst-plinth-0/1.png show the aetheryte plinth steps being climbed",
"run-1 djump trace: apex1 9.62 (jump from 8.07, +1.55 m), apex2 11.40 (+3.33 m total), float: only 0.55 m fall in 310 ms post-apex with Space held"
],
"errors": [],
"perf": {
"fps": 170.1,
"p95ms": 8.4,
"p99ms": 9.4,
"calls": 156,
"tris": 2167602
}
},
"grass": {
"piece": "grass",
"verdict": "TOSSUP",
"score": 7.3,
"scores": {
"visual": 7.5,
"feel": 7.5,
"performance": 9.5,
"polish": 6
},
"biggest_gap": "At close range (0-8 m) the field falls apart: blades read as stiff, near-black triangular daggers over a flat smeared terrain texture, and the flowers are stemless diamond shards floating in the air — fix the close-range blade/ground/flower read and the mid-distance carpet already competes with FF14.",
"gaps_ranked": [
"Close-range read: blades are dark rigid triangle-daggers with near-black roots over a visibly flat, smeared ground texture at the player's feet (shot-ground-close.png, golden-close-crop) — needs softer blade curvature/AO falloff and a denser or textured understory so bare splat never shows within ~5 m",
"Flowers render as stemless pink/white/purple diamond quads floating above the grass — read as confetti shards, worst at night where a purple diamond hovers mid-air (night-crop.png, golden-close pink shard); give them visible stems and smaller multi-quad heads",
"Player trail is a razor-edged ~2 m lane mowed to zero — bright uniform terrain strip with hard edges that reads as grass deletion, not trampling (shot-trail-behind.png); keep bent/leaning blades in the lane (crush to ~40% not 10%), feather the edge, vary width",
"Mid-band tonal monotony: 25-100 m is one saturated green with faint repetitive streaking; the coded dry-gold patches barely read at 15:00 (shot-mid-east.png, midband-south.png) — boost macro tone variation (dry patches, flower drifts) so the carpet isn't a golf course",
"Sun-silvering overexposure: a large band of grass blows out to near-white in shot-vista-meadow.png right side — clamp the gust-silvering/backlight product so it never exceeds ~1.5x base color",
"Golden hour: the field stays green-dark while all surrounding terrain goes fully golden (shot-golden-mid.png) — grass should inherit more of the warm sun tint at low sun angles",
"40 GL_INVALID_OPERATION 'mismatch between texture format and sampler type' warnings per run on glDrawElementsInstanced/glDrawArrays — the RGBA32F cache DataTexture sampling is the prime suspect (attribution uncertain, may be another system); must be traced and killed",
"q=low scaling not separately measured (presets exist in code; whole-frame q=high is 4.89 ms so low likely passes, but unverified)"
],
"strengths": [
"Mid-distance carpet (25-80 m) — the brief's explicit bar — is genuinely dense and continuous with zero visible fade line or popping; blends cleanly into terrain color (shot-mid-east, midband-south, fade-band crops)",
"A/B proves the system carries the meadow: grass off is a flat billiard table (shot-off-confirm.png), and the on/off ground tones match, which is why the LOD fade is invisible",
"Wind is alive across the entire field — amplified frame diff over 2.25 s shows broad distributed per-blade motion, not rigid jitter (wind-compare.png)",
"Player interaction works: blades bend away while walking (walk-bend.png frames) and a persistent spring-back trail is left behind",
"Lighting integration: shadows received on blades, warm side-lighting at golden hour, blue-violet moonlit lift at night, backlit tips in vista-meadow",
"Performance exemplary: 87,472 blades / 5,467 patches in 3-4 draw calls; grass costs ~0.40 ms idle and ~0.77 ms sprinting whole-frame (self cpuMs 0.31/0.51), well inside the 1.0 ms budget; whole frame 4.89 ms mean, p99 7.8 ms, 204 fps, memMB stable"
],
"evidence": [
"shot-ground-close.png: feet-level blades are stiff dark triangular daggers, sparse, over flat smeared green splat; big blurry blade shadows; white/pink diamond petal shards lying oddly",
"night-crop.png (from shot-night-meadow.png): purple diamond flower head floats mid-air with no stem; night lift otherwise readable",
"shot-trail-behind.png: perfectly straight razor-edged mowed lane, grass crushed to zero, bright uniform strip — reads as deletion, not trampling",
"shot-mid-east.png / midband-south.png: dense continuous carpet 25-100 m, clean fade, but single-tone green with faint vertical streak repetition",
"wind-compare.png: amplified diff between burst-wind-0 and burst-wind-5 shows broad blade motion across the whole field — wind works",
"walk-bend.png: near-band blades reorient between burst-walk frames — player bending works"
],
"errors": [
"No page errors (report.errors empty in both runs). Console: 40x GL_INVALID_OPERATION 'Mismatch between texture format and sampler type (signed/unsigned/float/shadow)' warnings per run on instanced + non-instanced draws — needs attribution; grass's RGBA32F DataTexture is a suspect but glDrawArrays hits suggest another system may also be involved"
],
"perf": {
"fps": 204.5,
"p95ms": 6.8,
"p99ms": 7.8,
"calls": 122,
"tris": 1826310
}
},
"postfx": {
"piece": "postfx",
"verdict": "LOSE",
"score": 6,
"scores": {
"visual": 6.5,
"feel": 7.5,
"performance": 6.5,
"polish": 5.5
},
"biggest_gap": "God rays render with visible crosshatch/stipple dither noise across the entire golden-hour sky (0.4 res scale with blur:false) — the flagship FF14 money shot has fabric-textured light plumes where the real games have silky smooth shafts.",
"gaps_ranked": [
"God-ray dither: bright ray plumes and sky haze show a strong crosshatch/stipple pattern at golden hour (zoom-godray-noise.png) — enable the godray blur pass or raise resolutionScale/add temporal filtering",
"AO is far from the required 'subtle and stable': grass blades and props leave huge soft black smudge halos on flat stone, ~10x blade width (cmp-ao.png, mean abs diff 44/255 between AO on/off) — cut intensity (4.5) / radius, add thin-geometry rejection",
"Post chain GPU cost 1.741 ms vs 1.3 ms budget (postfx.profile 240 frames, q=high golden hour, sun on screen: on 3.738 / off 1.997) — trim godray samples (44) / res or bloom levels (7)",
"God rays read as a broad radial veil + glowing plumes over distant mountains rather than distinct crepuscular beams carved by tree canopy (shot-golden-shafts-forest.png) — occluders barely produce individual shafts",
"Night emissive crystals get zero visible bloom halo up close (zoom-night-bloom.png: razor-sharp flat purple edges) — luminanceThreshold 1.2 is above night-exposure emissive output; lower threshold at night or boost with vegetation's emissive intensity",
"Dusk grade lays a heavy uniform magenta veil that flattens all contrast (shot-dusk.png) — ease the night lift toward blue-violet and preserve warm horizon separation",
"Noon sun bloom halo is soft and diffuse but the disc has no HDR core punch/glare (zoom-noon-sun.png) — partly sky's sunMesh brightness, needs a hotter core feeding bloom",
"Whole-frame p99 15 ms in the night crystal-field window (mean 8.43 ms) exceeds the 14 ms budget — mostly scene cost, not postfx (PostFX CPU ~0), flag for orchestrator"
],
"strengths": [
"Chain-on vs chain-bypass A/B is night-and-day: ACES + FF14 grade + bloom transforms a washed-out linear render into a warm painterly frame (shot-chain-on vs shot-chain-bypass)",
"Time-of-day grading genuinely evokes FF14: warm saturated golden hour (shot-golden-lake), violet dusk, blue night with readable exposure lift (shot-night-sky with aurora + glowing aetheryte)",
"All API hooks verified working: flash() edge-weighted white tint decaying correctly (burst-flash meanRGB 170/182/172 -> baseline in 1 frame), kick() strong radial CA fringing (cmp-kick.png), setDof() clean cheap background blur (cmp-dof.png)",
"Correct gating everywhere: god rays off below horizon (sunY -0.137 -> godraysEnabled false), q=low strips AO/godrays/TAA/DoF exactly as specced",
"q=low scales properly: post chain 0.391 ms, whole frame 3.19 ms mean / 5.6 p99 (budget <= 4 ms) at 313 fps",
"SMAA+TAA edges are clean in every still — no jaggies on foliage, thin trunks, or crystal edges at 1920x1080"
],
"evidence": [
"zoom-godray-noise.png (crop of shot-golden-shafts-forest.png): heavy crosshatch stipple noise across bright god-ray plumes and canopy edges",
"cmp-ao.png (shot-ruins-ao-on vs shot-ruins-ao-off, same view): AO adds huge black smudge halos around grass blades on stone tiles; mean abs pixel diff 44/255 — not subtle",
"report.json profile eval: {on: 3.738, off: 1.997, cost: 1.741 ms, 240 frames} vs 1.3 ms budget",
"report.json dusk eval: {sunY: -0.137, godraysEnabled: false} — below-horizon gating confirmed",
"critic3-postfx-2 (q=low) eval: {ao: false, godrays: false, taa: false, dof: false}; profile cost 0.391 ms; low-golden fps 313.5 mean 3.19 ms",
"burst-flash-0 meanRGB [170,182,172] vs baseline [105,127,110] -> flash visible and edge-weighted (cmp-flash.png), fully decayed next frame"
],
"errors": [],
"perf": {
"fps": 128.5,
"p95ms": 10.5,
"p99ms": 11.4,
"calls": 129,
"tris": 2103402
}
},
"audio": {
"piece": "audio",
"verdict": "LOSE",
"score": 6,
"scores": {
"visual": 5.5,
"feel": 7.5,
"performance": 9.5,
"polish": 8
},
"biggest_gap": "Gun reports are clean filtered-noise layers with no saturation/inharmonic grain — a blind panel clocks them as synthesized against Destiny 2's recorded shots within one magazine; adding a WaveShaper distortion stage plus metallic inharmonic partials to the bark/crack layers would move the verdict most.",
"gaps_ranked": [
"Shot timbre: bark/crack are bandpassed noise with no waveshaping distortion or inharmonic metallic partials, so every archetype reads 'synth approximation' next to Destiny 2's recorded reports — add a WaveShaperNode saturation stage on the shot chain and 2-3 detuned inharmonic ring layers",
"Music melody is a random-walk arpeggio over chord tones (20 onsets/18s measured) with no recurring motif or phrase cadence — FF14 field themes are hummable; give the lead a seeded 2-4 bar motif that repeats and cadences at phrase ends",
"Reload foley is thin (selfTest rms 0.0083, four clicks + two noise swishes over 1.1s) vs Destiny's dense mag-scrape/rattle/bolt layering — add rattle/scrape layers and per-archetype reload variants",
"Autorifle and pulse room tails measure 0.39s and 0.34s audible (<0.003 amp), under the 400+ms brief spec — extend roomDur/tailG for the fast archetypes",
"Big explosion audible tail is 1.23s at -50dB vs the brief's 'full 1.5s sub-boom' — lengthen the big-blast sub/lowpass decay ~30%",
"No automatic music track switching: musicTrack stayed 'field' through combat and at hour 23 despite 'combat' and 'night' tracks existing — wire track selection to combat state and hour",
"Ambient zone lags 1-1.5s+ after fast travel (teleport to ruins still read 'crystal' 1.5s later; teleport hitch starves the 0.5s dt-accumulated poll) — re-poll zone immediately on large position deltas",
"Sniper per-shot vary is ±2.5% pitch, just under the brief's ±3-6% band — bump vary to 0.03+"
],
"strengths": [
"All 44 SFX pass selfTest (rms/peak/tail sane), zero console or page errors in both runs",
"Every archetype hits the 300-2500 Hz report-body spec: 27.2-41.0% band energy, with transient click (peak ~22ms), sub thump (shotgun 41% <150Hz), and 0.84-1.06s tails on hc/shotgun/sniper",
"Explosion genuinely reads the event radius: r=1.6 gives a 0.28s crack (centroid 3644Hz), r=8 gives a 1.23s boom with 95.4% sub-band energy",
"Fusion charge is a real rising whine (spectral centroid 639 to 1634 Hz, rms 0.022 to 0.112) and sniper echo repeats are measurable (2 discrete post-report onsets)",
"Complete event wiring verified live: shots, hit/crit/kill ticks (with sfx-bus ducking), impacts per surface, footsteps, jump/land, abilities, positional enemy fire all counted in debugCounts with positions",
"Ambient beds are properly wide (L/R correlation 0.011 meadow, -0.049 forest) with LFO gust movement, and the day/night ecology works: birds at hour 10, 46 crickets plus an owl at hour 23"
],
"evidence": [
"critic3-audio-1 report.json selfTest eval: ok:true n:44 bad:[] (handcannon rms 0.0769 peak 1.822 tail 0.88s)",
"shot spectra eval: 300-2500Hz fractions hc 0.2716, ar 0.2957, pulse 0.4099, shotgun 0.3766, sniper 0.3578, fusion 0.3905 - all >25% spec; but ar tail 0.39s / pulse 0.34s under the 400ms spec",
"explosion eval: radius 1.6 tail 0.28s frac[300-2500]=0.4333 vs radius 8 tail 1.23s frac[20-120]=0.954 - radius scaling real, big-blast tail 1.23s < briefed 1.5s",
"fusion-charge eval: centroid 639->1634Hz, rms 0.0224->0.1116 - rising whine confirmed; sniper onsets=2 - echo confirmed",
"music eval (18s field): >900Hz 0.3957 (spec >0.08), 500-2000Hz 0.5377, corr 0.407, 20 onsets, env swells 0.016-0.147 - audible melody activity but random-walk, no recurring motif in music.js _arp (w<0.45 up / w<0.75 down / else random)",
"ambient eval: meadow corr 0.011, forest corr -0.049 (decorrelated wide), env 0.025-0.058 movement; live counts: bird 5 at hour 10, cricket 46 + owl 1 at hour 23"
],
"errors": [],
"perf": {
"fps": 104.9,
"p95ms": 12.6,
"p99ms": 16.2,
"calls": 140,
"tris": 1864163
}
},
"camera": {
"piece": "camera",
"verdict": "TOSSUP",
"score": 8,
"scores": {
"visual": 8,
"feel": 8.5,
"performance": 10,
"polish": 8
},
"biggest_gap": "Landing dip could not be verified on a real fall (test-environment failures, not a measured zero) — if the impact-scaled dip+nod is dead in real play it is the single most Destiny-signature moment missing; builder must demonstrate landDip>0 and the pitch nod after an 8m drop and a double-jump landing.",
"gaps_ranked": [
"Landing dip unverified: teleport-drop tests never produced a clean measurement (my game.world.terrain path bug once, vite full-reloads from concurrent edits killed 3 more attempts); demonstrate eye-Y dip + dipPitch nod on real landings",
"Damage flinch unverified: god-mode blocked the one clean attempt; demonstrate flinch pitch/roll springs on damagePlayer(40) without god",
"Sprint camera bob vertical is ±42mm — Destiny keeps the camera itself calmer and puts run energy into the viewmodel; consider ~30% less vertical camera bob at sprint (keep the roll)",
"AR recoil is almost pure smooth pitch; Destiny autos have per-archetype horizontal wander/pattern noise — add small seeded yaw walk to automatics",
"First-2s AR climb (~2.9 deg incl. offset) is on the mild side vs a Destiny 600rpm auto; per-shot punch could read ~20-30% stronger",
"Trauma-1 shake fully decays in ~0.65s; big-hit shakes in Destiny linger closer to 1s — slightly slower trauma decay for heavy hits",
"Jump apex float (+1.5 fov, 2cm) untested and likely imperceptible — verify it reads at all or spend the budget elsewhere"
],
"strengths": [
"Sensitivity is Destiny-exact: 800 counts -> 26.40 deg = sens 5 @ 800dpi, exposed as .sens, and ADS sens uses focal-length scaling",
"ADS blend 0.188s in / slower out with exact tan-space zoom per weapon: 100->85.0 @1.3x handcannon, 33.2 deg horizontal @4x sniper",
"Slide camera fully correct: FOV holds 111 flat (no pump), eye 1.65->0.85, -2.5 deg roll, smooth recovery through crouch 1.10",
"Recoil model is authentically Destiny: rate-capped recovery while firing so autos climb monotonically (no snap-back), 20% permanent displacement (settled +3.69 deg after long burst), alternating per-shot roll punch, visible on-screen climb across burst frames",
"Trauma-squared shake with smooth value-noise (peak 3.15 deg roll, no white-noise jitter) plus positional thump",
"Head bob is speed-scaled, footstep-phase-locked, ADS-damped: subtle walk (±14mm), rocking sprint (±42mm, ±0.7 deg roll)"
],
"evidence": [
"tools/out/critic3-camera-1/report.json eval: yawDelta800counts=26.40deg (expected 26.4)",
"critic3-camera-1 FOV curve: 100 -> 108 in ~0.6s on sprint; critic3-camera-1v slide curve: 108 -> 111 flat hold, eyeHeight 1.65->0.85, slideRoll -2.51 deg, recovery through crouch 1.10",
"critic3-camera-1 recoil curve: aim pitch 0.05->1.03 deg + recoil offset 0->1.87 deg over first 2.0s of AR fire, monotonic; settled aim +3.69 deg after burst; arfire-compare.png (frames 0/3/7): plinth beam boundary moves down-screen = visible climb",
"critic3-camera-1 ADS: adsInAt=0.188s, minFov 85.03 (1.3x), sniper fov 33.2 h / 19.0 v (4x); shot-ads-hc.png, shot-ads-sniper.png",
"critic3-camera-1 shake: maxRoll 3.15 deg at trauma 1, smooth decay samples 1.73/0.77/0.25/0.69/-0.12 (no jitter); burst-shake-0/1.png show smooth tilt+reframe",
"critic3-camera-1 bob: walk ±14.1mm Y ±7.7mm X ±0.35 deg roll; sprint ±41.7mm Y ±18mm X ±0.7 deg roll; idle breathing roll 0.017-0.08 deg"
],
"errors": [],
"perf": {
"fps": 208.3,
"p95ms": 6.7,
"p99ms": 8,
"calls": 110,
"tris": 1837508
}
},
"weapons": {
"piece": "weapons",
"verdict": "LOSE",
"score": 6,
"scores": {
"visual": 6,
"feel": 6.5,
"performance": 7.5,
"polish": 6
},
"biggest_gap": "Reloads happen with frozen hands — the support hand never leaves the handguard to pull the mag/shells/cell (the mag just drops off-frame), so every reload reads as \"gun wiggles while parts slide\" instead of Destiny's hand-driven performance.",
"gaps_ranked": [
"Static hands during reloads: no hand reaches for the mag/cylinder/shells; AR mag drops straight down out of frame (shot-ar-reload.png), hand cannon reload swings the gun half off-screen with the cylinder motion unreadable (burst-hc-reload-1.png) — animate the left hand through the reload keyframes",
"ADS sight misalignment: at full ADS the hand cannon's front bead/rear notch sit ~30-50px below-left of the crosshair (shot-hc-ads.png center crop) — sight marker should land exactly on the camera axis",
"Hand cannon muzzle flash oversized: the 6-point star spans ~25% of screen width and is fully exposed left of the barrel (burst-hc-fire-0.png), vs the brief's 'small, mostly hidden by the gun'; AR flash is correctly tight (burst-ar-fire-0.png) — scale hc/shotgun flashScale down ~50%",
"Fusion rifle reads unfinished: large flat untextured tan top plate + pink/white coils and side strip on a VOID weapon (shot-fu-idle.png) — should be dark metal with violet glow",
"No projectiles visible on missed shots: vfx.tracer only fires when hitscan returns a hit point, so a fusion volley into open terrain shows zero bolts in flight (shot-fu-bolts.png: mid-burst, nothing visible) — always draw tracers to max range point",
"Hand geometry too crude at viewmodel distance: torus-arc fingers read as ribbed tubes and the grip palm is a plain box (crop of shot-sg-idle/shot-pu-idle); add knuckle plates/finger segments or thicken the glove silhouette",
"Hand cannon silhouette too thin and long (flintlock-like): barrel is ~8px wide on screen and the cylinder is barely visible from the shooter's angle (shot-hc-idle.png); Destiny hand cannons are chunky with a dominant cylinder",
"weapons.setHidden(bool) not implemented (eval: typeof __game.game.player.weapons.setHidden => undefined) — explicit cross-system ask this wave; Abilities is using its rig.visible fallback"
],
"strengths": [
"Sniper scope overlay is genuinely Destiny-grade: circular lens mask, gold rim, crosshair + mil ticks, full black vignette over real 4x zoom, subtle sway/recoil bump (shot-sn-scope.png, shot-sn-scope-fire.png)",
"All 6 archetypes present with distinct silhouettes, rpm-accurate fire modes (burst queue, fusion charge->7 bolts), per-archetype reload styles (mag/cylinder/pump/bolt/cell) and recoil springs",
"FF14 art direction lands on the autorifle/pulse/sniper: dark blue-steel + gold filigree decals, emissive holo/reflex sights, element glow accents, brass details (shot-ar-idle.png is the best gun)",
"Damage falloff correctly plumbed as falloff:[start,end] per weapon, verified: hc 100/100/95/55/50 at 5/15/30/60/120m, sniper flat 100, shotgun collapses past 15m (eval table)",
"Empty-click auto-reload works (ammo 0 + trigger => reloading:true), swap lowers the gun fully off-screen (shot-swap-mid.png), night readability handled via fill light (shot-night-idle.png)",
"Zero console/page errors; firing adds only ~0.6ms frame mean and +13 draw calls; weapons CPU inside the Player 0.31ms bucket (0.3ms budget)"
],
"evidence": [
"shot-ar-reload.png + burst-hc-reload-1.png: hands frozen on gun through reload; AR mag not visible being pulled, hc cylinder swing unreadable",
"shot-hc-ads.png (center crop): front bead sits below-left of crosshair ring at full ADS",
"burst-hc-fire-0.png: hand cannon flash star ~480px wide, fully exposed beside the barrel; burst-ar-fire-0/2.png: AR flash correctly tight",
"shot-fu-idle.png / shot-fu-bolts.png: flat tan untextured top plate, pink coils on a void weapon, no bolts visible mid-volley",
"eval typeof weapons.setHidden => undefined (brief's explicit cross-system ask)",
"eval falloff table: handcannon [100,100,95,55,50], shotgun [100,68,50,50,50], sniper [100,100,100,100,100] at 5/15/30/60/120m — array form works"
],
"errors": [],
"perf": {
"fps": 102.8,
"p95ms": 12.3,
"p99ms": 13.6,
"calls": 136,
"tris": 1866598
}
},
"vfx": {
"piece": "vfx",
"verdict": "LOSE",
"score": 6,
"scores": {
"visual": 6.5,
"feel": 6,
"performance": 9,
"polish": 7
},
"biggest_gap": "Per-shot gunplay feedback barely reads in daylight — muzzle flash, tracers, and enemy-impact sparks are tiny/white-on-bright and invisible in real noon firing footage (0/5 mid-burst frames show any flash or tracer), while Destiny 2's read crisply on every shot.",
"gaps_ranked": [
"Noon muzzle flash + tracer invisible during actual firing: burst-fire-noon-0..4 (ammo 9->5) show zero flash/tracer frames; night frame catches a huge one — boost HDR/size/duration and add a dark backing so it reads at high sun",
"impact-enemy (arc, crit) at 7 m reads as a small white sparkle with no element color and no visible ring (crop-shot-impact-enemy-rock); impact-rock at 9 m nearly invisible — element identity washes to white, needs saturated colored halo + bigger ring",
"Explosion smoke ball 0.2-1 s is a flat, near-opaque ink-black blob that swallows the fireball phase (shot-exp-02) — needs fire-lit interior and grey-brown gradient like a Destiny grenade before going dark",
"aether-burst at noon is a smudgy dark blob with ~8 faint dots (crop-shot-aether) — spiral motes need 3-4x density/brightness and saturated violet-blue to read as magic instead of a shadow artifact",
"heal/flash showcase item renders as a giant structureless pure-white orb bigger than the viewmodel (shot-showcase-night-08 right side) — fully blown out, reads as a rendering error; needs internal falloff/structure and exposure-aware HDR cap",
"death vfx afterglow gone by ~0.75 s at noon (shot-death-075 empty) — the 1.2-2.2 s rising motes are too faint/small at 8 m; the kill payoff needs a lingering readable tail like Destiny",
"Ground shockwave rings, lingering dust ring, and all decals are lost under 1 m meadow grass (no exp shot shows the ring or scorch; decal never visible in any shot) — lift rings higher and add a grass-clearing or brighter edge treatment",
"Draw-call/perf budget never validated at the specified 5k live particles (max observed ~1.3k from 8 explosions + full showcase, VFX CPU 0.02 ms) — add a heavier stress hook so the 0.4 ms @5k claim is provable"
],
"strengths": [
"Death burst is the best effect in the piece: void veil + white-hot star pop + double ring + violet motes reads FF14-quality at noon (shot-death-015)",
"Sigils are genuinely FF14-grade: crisp counter-rotating gold rune bands with grazing-angle boost, gorgeous at night (shot-showcase-night-08) and readable at noon (shot-sigil-15)",
"Explosion delivers the full Destiny cadence, verified with controlled timing: flash/fireball -> dark smoke ball at 0.8 s -> rising dark column with red embers at 2.5 s, all reading against bright noon grass (probe-exp-08.png, probe-exp-25.png)",
"Real-gunfire ground impacts kick up readable tan dust against green grass (critic3-vfx-1/shot-impacts-ground.png)",
"Night muzzle flash is a punchy crisp petal/star burst (critic3-vfx-1/burst-fire-night-0.png)",
"Performance is immaculate: VFX 0.02-0.04 ms CPU with ~1.3k live + 3 sigils + tracers, 137 draw calls under full VFX load vs 138 idle (zero measurable call growth, well under the 8-call particle budget), memMB stable, zero errors"
],
"evidence": [
"critic3-vfx-1/burst-fire-noon-0..4.png: ammo counter drops 9->5 across 5 frames at noon, zero visible muzzle flash or tracer in any frame; burst-fire-night-0.png shows a huge crisp flash — noon readability gap, not a sampling fluke alone",
"critic3-vfx-1b/crop-shot-impact-enemy-rock (from shot-impact-enemy-rock.png): arc crit at 7 m = small white sparkle, no blue element color, no ring; impact-rock 2.5 m right = nearly nothing",
"critic3-vfx-1b/shot-exp-02.png: smoke ball at ~0.2-1 s is a flat near-black opaque blob hiding all fire tongues",
"critic3-vfx-1b/probe-exp-08.png + probe-exp-25.png with live counts (alpha 31->38->32 alive from 0.1-2.5 s, 7 at 3.5 s): explosion smoke column persists and reads at noon — the 1b timeline shots (exp-05..30 empty) were mistimed by ~0.5-1 s/screenshot latency",
"critic3-vfx-1b/shot-death-015.png: excellent void death pop; shot-death-075.png: afterglow already gone",
"critic3-vfx-1b/shot-showcase-night-08.png: two beautiful gold rune circles, but a giant blown-white structureless orb (heal/flash) dominates the right side"
],
"errors": [],
"perf": {
"fps": 106.6,
"p95ms": 12.4,
"p99ms": 15,
"calls": 137,
"tris": 1876560
}
}
}
const results = await pipeline(PIECES, async (p) => {
  const history = []
  let report = null
  let critic = PREJUDGED[p.key] ?? null   // wave-3 critics already judged these; builders were cut off — fix first
  for (let round = 1; round <= MAX_FIX_ROUNDS + 1; round++) {
    if (!critic) {
      critic = await agent(criticPrompt(p, round), { label: `critic:${p.key}#${round}`, phase: 'Critique', schema: CRITIC_SCHEMA })
    }
    history.push({ round, report: (report || '').slice(0, 1500), critic })
    log(`${p.key} round ${round}: ${critic?.verdict} ${critic?.score} — ${critic?.biggest_gap}`)
    if (!critic || critic.verdict === 'WIN' || round > MAX_FIX_ROUNDS) break
    report = await agent(buildPrompt(p, round, critic, report), { label: `build:${p.key}#${round}`, phase: 'Fix' })
    critic = null
  }
  return { piece: p.key, final: critic ?? history[history.length - 1]?.critic ?? null, history }
})
return results.filter(Boolean)
