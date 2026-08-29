# CADLE — browser FPS-RPG (Three.js)

> Orchestrator: read `HANDOVER.md` first — it holds the live wave state, the exact commands, and what to do next.

Target: **Destiny 2 moment-to-moment game feel** × **Final Fantasy XIV mystical look**. Three pillars, in order: graphics, performance, game mechanics. Everything judged against the real games.

> **SOURCE INVARIANTS (run first, takes one second): `node tools/invariants.mjs`.** It greps the source for the rules that encode bugs which have shipped repeatedly — the single pointer-lock path (`Input.lock`, plus the HUD hookup and the `synthetic`-only-under-`auto` guard), the grass emissive ceiling AND final-luminance cap, the grass roughness floor, vfx/enemy/viewmodel/prop intensity ceilings, and the bloom/exposure calibration pins. Run it before you start and again before you report; it needs no dev server, so it works even when the harness is contended. It is also enforced automatically: CI (`.github/workflows/checks.yml`) runs it on every push/PR, and the repo's `.claude/settings.json` Stop hook runs it at the end of every agent turn and blocks on failure. These rules exist because prose in this file kept being followed *literally* while a new code path reintroduced the same bug — do not edit `tools/` to satisfy them, fix the code, or say in your report that the rule is wrong.
>
> **The gate needs a MASK to be honest (2026-08-22).** `tools/inspect.mjs` captures one `mask-*.png` per burst
> from `PostFX._renderSkyMask()`: geometry green, sky and fog magenta, **ground cover RED**. `tools/blobcheck.py`
> scopes both of its tests to the red — that is what the decree is actually about — and ignores whatever the haze
> owns. Without this it fails on the sun through a treeline, on lantern flames and on loot beacons, and a gate
> that cries wolf is a gate nobody reads. **After ANY change to blobcheck.py run `python tools/blobcheck.py
> --selftest <a burst frame>`**: it paints synthetic bloom-balls onto the blades and asserts they are still caught.
> Coverage for emissives OFF the ground is `tools/invariants.mjs` (intensity ceilings), the hue-preserving aether
> cap in `src/enemies/materials.js`, and `HOT_TINT` in `src/vfx/Brush.js`.
>
> **REGRESSION GATE (mandatory): `node tools/gate.mjs` must exit 0 before any builder reports done; critics run it and ANY failure = automatic LOSE.** It mechanically enforces three decrees that have each regressed multiple times: (1) no washed-white blobs in the meadow, (2) no screen jitter (static camera must produce near-identical consecutive frames), (3) pointer lock engages on click and RE-acquires after exit (the mouse must never escape the window mid-play). If your change can affect any of these (grass/vfx/postfx/enemies materials; TAA/camera; input/HUD start-pause), run the gate FIRST, not last. Do not weaken gate thresholds — thresholds are orchestrator-owned.
>
> **THE VISUAL SIGN-OFF (user decree, 2026-08-28): ANYTHING THAT CAN BE SEEN MUST BE LOOKED AT, BY YOU,
> IN THE RUNNING GAME, BEFORE YOU SAY IT IS DONE — and before the gate is run, not after.**
> A gate is a regression alarm, not a quality judgement: `combatcheck` cannot see an opaque orange film
> that keeps its hue, `blobcheck` cannot see a nameplate floating 350 px above a creature's head, and no
> gate in this repo can see that a "seraph" is wearing the forgeknight's body. Every one of those shipped
> green and was caught by a person looking at the screen.
> The rule, mechanically:
>   1. **Capture it** — `tools/inspect.mjs` at the distances the thing is actually seen from (a landmark:
>      200 m / 40 m / 8 m; a creature: a burst while it MOVES; a HUD element: the state that draws it;
>      a material: noon AND night). A single still cannot show you an animation, and one distance cannot
>      show you a landmark.
>   2. **READ THE PNG** — actually open the image. "The code is correct" is not a visual check, and
>      neither is a passing metric.
>   3. **Say what you saw** in your report, name the file, and say what you would still dock points for.
>      A report that only quotes gate output has not been visually signed off.
> Two traps this decree exists for: a metric that is green while the screen is wrong (see the wave-6
> verdicts), and a probe that measures the wrong place — `goto(id)` drops you at a region's HEART, which
> is inside the landmark clearance where ground detail is deliberately suppressed, so "I looked down and
> saw nothing" may be your camera, not the build. Shoot off-centre too.
>
> **THE THREE-GATE SIGN-OFF (user decree, 2026-08-23): nothing is "done" until it passes GRAPHICS, PERFORMANCE and GAME MECHANICS.**
> Reporting a feature complete without all three is the same failure as reporting a shader done without a screenshot.
> 1. **Graphics** — `node tools/gate.mjs` exits 0 (invariants + blobcheck + jitter + pointer lock at q=high AND q=low), plus `tools/inspect.mjs` screenshots of every new visual element. A visual you did not look at is not done.
> 2. **Performance** — `node tools/hitchhunt.mjs --name <label> --route combat` on the *densest* case, not the meadow. Budget is the one below: frame mean <= 7 ms, p99 <= 14 ms, <= 350 calls, <= 4 M tris, per-system CPU inside its slice, `memMB` flat over 30 s.
> 2b. **Animation (added 2026-08-27, user ask).** `node tools/animcheck.mjs` must exit 0 for every creature
> you touched. "It animates" has been asserted in reports and never measured — a mannequin sliding on rails,
> a T-posed spawn, feet buried in the terrain and a creature walking backwards all look fine in a single
> still, and a still was all anyone ever captured. animcheck reads the LIVE bone hierarchy while the AI
> drives the creature and fails on: T-pose (never leaves bind), frozen-while-moving, foot slide (limb
> rotation per metre travelled), moonwalking (facing vs velocity), sunk/hovering feet (bone-lowest-Y vs
> `terrain.heightAt`), a size mismatch against `def.height * def.scale`, a dead idle, a flat attack, and a
> death that does not play. Thresholds in its `LIMITS` block are ORCHESTRATOR-OWNED — run `--calibrate` to
> read the numbers, never widen a threshold to turn a red build green.
> 3. **Game mechanics** — `node tools/curvecheck.mjs` (pure node, ~1 s, also in CI: xp curve closes, level bands contiguous, every enemy/item a quest names exists, drop rates and pity hold) **and** `node tools/questgate.mjs` (drives the running game: ammo returns after running dry, every objective type ticks, a quest turns in and pays, no leak).
> A gate that was not run is a gate that failed. Say in your report which ones you ran and paste the result.

> **ARCHITECTURAL LAW — GROUND COVER IS NEVER EMISSIVE, AND NEVER GLOWS AT ALL (this bug has shipped five times; each time a different system caused it).**
> Grass blades, flowers, leaf cards and other sub-pixel/thin geometry must never write `totalEmissiveRadiance` above a hard absolute ceiling (grass: `min(..., vec3(0.22))`, already in Grass.js — do not raise or remove it), and must never carry low-roughness specular that produces point glints (grass tip roughness stays >= 0.6). On top of the per-term rules, Grass.js hue-preserving-caps its FINAL outgoing luminance at 0.60 (`GRASS_LUM_CAP`, injected before `<opaque_fragment>`): every path — emissive, specular, gust silvering, translucency, exposure stacking — is closed at once, because the fifth recurrence came from lighting terms the emissive ceiling could not see. Do not raise or remove it; both are grepped by `tools/invariants.mjs`.
> **Why, mechanically:** a blade is smaller than a pixel at distance, so any value that can reach the bloom threshold (~1.2) flickers on and off frame-to-frame as wind and the camera move; bloom then smears each flicker into a floating glowing ball. That is the "flashing white/blue blobs" bug. It is not a tuning problem — a *relative* clamp (e.g. `min(x, col * 0.75)`) does NOT fix it, because a bright blade colour raises the ceiling with it.
> **So when a critic asks for backlit sheen, low-sun rim, readable flowers, or "the field goes black at golden hour" — the fix is a LIGHTING term, never emissive:** put it in `reflectedLight.directDiffuse` (wrapped diffuse / translucency), which respects exposure and shadowing and cannot bloom. Critics: asking for more glow on ground cover is asking for the bug back — judge the rim by whether it reads, not by how bright the emissive is.
> Same principle for any small bright element (motes, crystals, bolts, muzzle flashes): saturate the COLOUR, cap the INTENSITY. A hue that survives tone mapping reads as magic; a value that clips reads as a white ball.
>
> **USER DECREE (2026-08-20, binding on every builder and critic): no washed-white glowing blobs, ever.** The spawn meadow was covered in flashing white balls three separate times: grass flower-head emissive, wisp glow white-clipping through ACES, and glossy grass tips (roughness 0.35) throwing drifting specular glints. All are fixed — keep them fixed: grass flowers stay matte (no emissive), grass tip roughness stays ≥ 0.6 (subtle sheen, never point-glints), wisp `glow` stays ≤ 1.1, spawn meadow stays peaceful (2 wisps beyond idle perception). Any emissive/specular/additive element that tone-maps to white instead of its hue is a bug — saturate the color, lower the intensity. Critics: a screenshot with washed-white blobs in the meadow = automatic LOSE regardless of everything else.

## Stack / commands
- Vite 8 + three r185 (WebGL2) + `postprocessing` 6.39. Plain ES modules, no TypeScript, no frameworks. Node 22.
- Dev server: **THE PORT DEPENDS ON WHICH CHECKOUT YOU ARE IN.** 5173 serves the MAIN checkout; a worktree gets its own port (the `cadle-character-load-perf-ee5b7b` worktree uses **5179**). **Measuring or screenshotting the wrong one tests a tree that does not contain your work** — that cost this project a full wave (HANDOVER 4a-bis). Confirm before you trust a number: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/`. If yours is down, start it — bash: `npx vite --port <port> --strictPort --host 127.0.0.1 > tools/out/vite.log 2>&1 &` · PowerShell: `Start-Process npx -ArgumentList 'vite','--port','<port>','--strictPort','--host','127.0.0.1'` — then wait 5s. Never start a second server on a port that already answers.
- Vite hot-reloads; the harness always loads a fresh page anyway.
- Inspect the running game: `node tools/inspect.mjs --name <label> [--steps '<json>' | --script file.json] [--w 1920 --h 1080] [--q high]` → `tools/out/<label>/{shot-*.png, report.json, console.log}`. See the header of `tools/inspect.mjs` for step types. Runs headless Chromium WITH the real GPU (RTX 3060). fps is **uncapped** (no vsync) so frame ms = real cost.
- **Hunt hitches: `node tools/hitchhunt.mjs --name <label> [--route tp|combat] [--url ...] [--params ...]`** →
  `tools/out/<label>/{frames.json, summary.json}`. Records EVERY frame (wall dt, cpu, GPU, program count,
  draw calls) and blames each spike on the system that was slow on that frame. Use it instead of
  `stats()` for anything spike-shaped: `stats()` is percentiles over 600 frames and `perf.systems` is an
  EMA, so both are blind to a single 1 s frame. Runs vsync ON by default (what a player feels);
  `--uncapped` for the old stress behaviour. See HANDOVER 4j.
- **TWO PAGES.** `/` is the marketing site (`index.html`, zero engine); **the game is at `/play/`**
  (`play/index.html` -> `src/main.js`). Every harness tool appends `/play/` itself (`tools/gameurl.mjs`),
  so keep passing a bare origin to `--url` / `CADLE_URL`.
- **NOTHING LOADS UNTIL PLAY (user decision 2026-08-28).** Landing on `/play/` builds no renderer, no
  `Game`, no asset preload and no terrain — the title screen is idle. `Menu.play()` calls `main.js`'s
  `boot()`, and that is the only thing that starts the world (plus `skip()` and `?auto=1`, which are the
  harness's paths). `/play?start` — the landing page's Play button — is exactly "load /play and press
  Play". Do not move world-building back to page load.
- Game URL params: `?auto=1` (automation: no click-to-start, synthetic input), `&q=low|medium|high|ultra`, `&seed=N`, `&debug=1`,
  `&start` (skip the menu, go straight to the loading screen), `&menu=1` (run the title screen under `?auto=1`), `&hold=1` (do not auto-play it),
  `&at=<biome id>` (spawn in that region instead of the Vale, facing its heart, music/bed already correct), `&back=N`
  (metres short of that region's landmark, default 150), `&hour=H` (set + freeze the clock).
- Python 3 + Pillow available for cropping/contact sheets: `python -c "from PIL import Image; ..."`.

## Architecture (one owner per file — NEVER edit files you don't own; report needed API changes instead)
```
src/main.js                 boot + window.__game automation API          (orchestrator)
src/core/Game.js            systems list, loop, fixed update order         (orchestrator)
src/core/Input.js, Events.js, Perf.js, Noise.js   shared utils            (orchestrator; Noise.js may be extended additively)
src/render/Renderer.js      WebGLRenderer + quality presets                (orchestrator)
src/render/Sky.js           sky/atmosphere/time-of-day/clouds/stars        (sky builder)
src/render/Lighting.js      sun/shadows(CSM)/hemi/env                       (lighting builder)
src/render/PostFX.js        composer pipeline, overlay pass, effects       (postfx builder)
src/world/Biomes.js         THE 10-BIOME MAP: layout consts + per-biome data  (orchestrator; read-only for everyone else)
src/world/Terrain.js        heightfield LOD + material + heightAt/normalAt (terrain builder)
src/world/terrainKernel.js  pure bake math (heightAt/bakeKernel/layerTex), NO three   (terrain builder)
src/world/terrainWorker.js  the bake worker entry — imports the kernel, nothing else  (terrain builder)
src/world/Water.js          lakes/rivers: reflect/refract/foam/waves       (water builder)
src/world/Grass.js          instanced grass, wind, interaction, LOD        (grass builder)
src/world/Vegetation.js     trees/rocks/crystals instancing + colliders    (vegetation builder)
src/world/Props.js          landmarks: ruins, aetheryte, pillars, POIs     (vegetation builder)
src/world/Colliders.js      static collider registry (sphere/capsule/box)  (orchestrator; additive changes ok by vegetation builder)
src/world/World.js          container                                       (orchestrator)
src/player/Player.js        container + health/shield/target               (orchestrator)
src/player/PlayerController.js  movement physics                           (movement builder)
src/player/PlayerCamera.js  look/fov/bob/shake/recoil                      (camera builder)
src/player/Weapons.js (+ src/player/weapons/*.js)  guns/viewmodel           (weapons builder)
src/player/Abilities.js     grenade/melee/class/super                       (abilities builder)
src/combat/Combat.js        hit resolution, projectiles, damage events     (combat builder)
src/enemies/Enemies.js (+ src/enemies/*.js)  creatures/AI/spawner            (enemies builder)
src/vfx/VFX.js (+ src/vfx/*.js)  particles/tracers/decals/flashes            (vfx builder)
src/audio/Audio.js (+ src/audio/*.js)  synthesized SFX/ambient/music          (audio builder)
src/ui/HUD.js, src/ui/ui.css (+ src/ui/*.js)  DOM HUD/menus                  (hud builder)
src/ui/Menu.js              title screen + loading screen: nav, panels, bar, hand-off (orchestrator)
src/ui/menu/backdrop.js     the animated backdrop (raw WebGL2, no three, no engine)  (orchestrator)
src/ui/menu/backdropWorker.js  it running on its own thread (OffscreenCanvas)        (orchestrator)
play/index.html             the title screen's MARKUP + inline CSS: it paints before any JS (orchestrator)
index.html                  cadle.gg — the marketing site. NO engine, no three          (orchestrator)
src/site/main.js            the site's entry: wires the components, nothing load-bearing (orchestrator)
src/site/ui.js              the house component set on the web side (beUI vocabulary)    (orchestrator)
src/site/scene.js           the world behind the page (reuses ui/menu/backdrop.js)       (orchestrator)
src/site/rail.js            the ten-region cylinder carousel that steers the backdrop    (orchestrator)
src/rpg/*, src/bosses/*     later waves
```
Each file's header doc-comment is the **contract** (methods, fields, events). Implement it fully; you may add more. If another system's stub lacks something you need, code defensively (`game.vfx.emit?.(...)`) and list the ask in your final report.

## Non-negotiable conventions
- **Never end a report with "what's left" — do it.** If the remaining work is performance, cleanup or
  follow-through with **no downside** (no visual change, no behaviour change, no scope or API decision,
  nothing traded away), implement it in the same turn instead of listing it as a suggestion. Listing it
  turns your work into the user's to-do list. Check in ONLY when the next step actually costs something:
  fidelity for speed, a design change, a risky or hard-to-reverse edit, or two defensible options where
  the user's taste decides. "I could also X" about a free perf win is not a check-in, it is X, done.
- **Assets: local-only at runtime; AI-generated assets now allowed and encouraged (user decision 2026-08-20).** The orchestrator generates textures / SFX / music / GLB models with the Magnific MCP and commits them under `public/assets/` — see `ASSETS.md` for the manifest. **Load them ONLY through `game.assets`** (`src/core/Assets.js`, preloaded before any system init): `game.assets.tex(name)`, `game.assets.model(name)` (clone the scene AND materials before mutating), `game.assets.audioBuffer(ctx, name)`. Never fetch/TextureLoader asset files yourself — the preloader guarantees one copy, GPU pre-upload, and zero mid-game streaming hitches. Missing asset → the accessor returns null → keep your procedural fallback. **One documented exception: the title screen** (`src/ui/Menu.js` / `menu/backdropWorker.js`) fetches its single backdrop still, `public/assets/ui/menu_vista.jpg` — it is on screen *while* `game.assets` is still preloading, so it cannot wait for it; see ASSETS.md. Nothing else may bypass `game.assets`. Need a new asset? Put "ASSET ASK: ..." in your report. **Never fetch an external URL from game code, no CDN, no npm asset packages** — everything ships in the repo.
- **MODELS, ROUTE CHANGED 2026-08-26: MONSTERS are rigged GLBs (concept -> Tripo generate -> Tripo `animate_rig` -> local `gltf-transform` meshopt+KTX2 -> `game.assets`); ARCHITECTURE stays procedural.** The old blanket ban came from `guy.glb` shipping with `skinCount 0` (an animation failure, not a perf one) — on the GPU a rigged GLB costs exactly what procedural geometry costs. `tools/invariants.mjs` rule (n) now allows `/assets/creatures/*.glb` from `Assets.js` or `src/enemies/` and still fails the build everywhere else. **Gotcha that looks like a dead end: `animate_rig` MUST be passed `model_version: v2.0-20250506` or newer — the default v1.0 returns error 1004 with zero credits and reads as "unriggable".** Full route + the 101-joint pruning question: `docs/CREATURE-PIPELINE.md`.
- **The old rule, still in force for everything that is not a rigged creature: no GLB reaches the runtime. The pipeline is concept image → Tripo GLB → the `img2threejs` SKILL → procedural Three.js code, and only that code ships** (user directive 2026-08-26; `tools/invariants.mjs` rule (n) fails the build on a `GLTFLoader` import or a `.glb` string in code — provenance *comments* naming the reference are wanted). **Every monster and every NPC goes through it, and every future creature is born this way.** Before you convert anything, read **`docs/CREATURE-PIPELINE.md`** (the recipe, the machine setup, the concept-prompt rules) and **`docs/ORNAMENT-STANDARD.md`** (why our landmarks read as greybox and the bar that fixes it).
  **Do not improvise it.** `img2threejs` is a gated multi-stage pipeline — local state gate (`forge/next.py`), pre-spec assessment + quality contract, a detail inventory where every identity-defining feature maps to a real component (prose does not count), staged build passes, then turntable / self-intersection / interior-difference / per-feature fidelity gates with a bounded correction loop. Three landmark rebuilds and two creatures shipped at ~15-20% of their reference's detail because a builder wrote "img2threejs GLB-mediated track" in a comment and hand-assembled primitives instead. **The mechanical cause: the skill's docs say `python3` and this box had none** — that is shimmed now (`~/bin\python3{,.cmd}`), so the documented commands work verbatim. Run its scripts from the skill root, `~/.claude/skills/img2threejs`.
  **Creature tri budget is TIERED by form complexity** (user 2026-08-26, was a flat 3.5k): ~4k small/ethereal (wisp, sprite), ~10k standard creature (hound, frostwolf, drake, serpent, riftling, wraith), ~15k complex/armoured (sentinel, golem, treant, warden, giant). **Never declare `targetTriangles` <= 6000** — that picks the img2threejs generator's *low* tessellation tier and coarsens every curve, which is how a small creature comes out faceted; declare 10000/15000 and let a simple form land under its target. Triangles were never why our creatures looked bad — chamfered edges, relief and material are. Full table + rationale: `docs/CREATURE-PIPELINE.md`. **And optimise the right axis**: measured here, ten treants cost +159 draw calls (~16 each) for ~2.3k tris of geometry — 45% of the call budget for almost no vertex work. Spend triangles freely, meshes and materials carefully; merge per animated group, <= 3 materials, <= 4 draw calls per creature at LOD0. The LOD ladder must still fall away hard past LOD0 (72 alive; LOD0 is for the near few).
  **Acceptance for any hero asset is three distances, not one:** silhouette at 200 m, ornament hierarchy at 40 m, material truth at 8 m. Fixing only the 200 m read is one third of the job, and is why landmarks kept scoring 4-6.
- **Asset perf budgets (prod-grade — AAA look AND AAA frame rate):** every asset is preloaded behind the start screen (HUD shows `assets:progress`), never streamed mid-game. GLB budgets: viewmodel ≤ 60k tris, hero landmark ≤ 40k, instanced prop ≤ 32k (instances share geometry — total tri budget in the frame still rules); textures inside GLBs ≤ 2k. Standalone textures ≤ 2k, JPG (PNG only when alpha needed), mipmaps + aniso 8 (the preloader sets this). Audio mp3. Total `public/assets/` payload target ≤ 40 MB. New generated assets must pass: tri/size budget, tiling check (textures), and an in-game screenshot before a builder ships them.
- **Style coherence (all Magnific generations + all procedural art):** one look — painterly-realistic fantasy MMO, saturated-but-soft, warm golds / deep blue-violets, ornate gold filigree accents on dark materials, luminous blue-violet aether. Magnific prompts must carry the suffix "painterly-realistic fantasy MMO style, even diffuse lighting" (textures also: "seamless tileable, no shadows, no vignette"; never name trademarked games in audio prompts). Procedural materials must match the generated assets sitting next to them (sample their palette, don't fight it). The between-wave coherence agent judges style unity explicitly.
- **Quests are WRITTEN, never spoken (user decision 2026-08-23).** The voiced opening quest and its five narration clips were deleted. Quest narration lives in the quest text (`src/rpg/quests/*.js`) and is read in the tracker and the quest log — never in `audio.playVoice`, never as a preloaded clip. `tools/invariants.mjs` rule (j) fails the build if `src/rpg/` calls `playVoice` or references `/assets/voice/`. Story-mode voiced NPCs may be green-lit later as a deliberate decision; until then, if a beat needs impact, it gets better words, a card and a sound effect, not a performance. **Quest content is DATA** — adding a quest must never mean writing a function, and every enemy/item id a quest names must exist (`tools/curvecheck.mjs` asserts this in CI).
- **Materials**: world surfaces use `MeshStandardMaterial`/`MeshPhysicalMaterial` + `onBeforeCompile` injections (so shadows, fog, sun, CSM, env all work). Raw `ShaderMaterial` only for sky/particles/water/grass-style things that handle fog+sun themselves. Custom materials must respect `scene.fog` (FogExp2) and `game.sky.sunDir/sunColor`.
- **Performance budget @1080p `q=high` on RTX 3060 (uncapped harness)**: whole frame mean ≤ 7 ms (≈140 fps), p99 ≤ 14 ms, ≤ 350 draw calls, ≤ 4 M tris (raised from 3 M by the user 2026-08-22: the biomes need the geometry, optimisation comes from elsewhere), no per-frame allocation in hot paths (pool everything), `memMB` stable over 30 s (no leak). Per-system GPU+CPU budget roughly: terrain 0.8, grass 1.0, water 0.8, vegetation 0.8, sky+clouds 0.4, shadows 0.8, postfx 1.3, enemies 0.6, vfx 0.4, rest 0.3. `q=low` must hit ≤ 4 ms. Scale with `game.renderer.qualityPreset` / `game.quality`.
- **Determinism**: all randomness via `mulberry32(game.seed + yourOffset)` / `hash2` from `core/Noise.js` (so critics see the same world). Runtime effects may use Math.random.
- **Frame loop**: systems get `update(dt, t)`; dt is clamped to 50 ms. Don't add your own rAF loops. Heavy init work is fine in `async init()` (may await), but keep total startup < 4 s.
- **Coordinates**: Y up, meters. Player spawn ≈ (0, h, 0). Terrain is `terrain.size` m square centered at origin; `terrain.heightAt(x,z)` is the ground truth for everything.
- **Automation must keep working**: `?auto=1` start with no click; `window.__game` API in `src/main.js` (teleport/look/setHour/input/state/stats). If you add things critics should be able to trigger (spawn enemies, give weapon, set quality), expose them through your system and mention them — the orchestrator wires `__game`.
- No new npm deps without strong reason (and say so in the report). Prefer `three/addons/*` already installed.
- **The site's motion vocabulary is the GAME's.** `src/ui/settings.js` + the "UI KIT" block of
  `src/ui/ui.css` rebuild beUI's components (beui.dev/components/motion) in plain DOM and CSS on ONE
  spring token (`--spring: cubic-bezier(.22,1.42,.36,1)`): segmented tabs with a gliding indicator,
  spring-pressed buttons, cards with a cursor glare, blur cross-fades between panes, a
  centre-morph modal with gold corner studs, text that reveals in a cascade, numbers that roll.
  `src/site/ui.js` is the same set for cadle.gg, on the same token. Anything new on either side extends
  that set — a control that moves on its own easing is how a page starts looking assembled rather than
  designed.
- Code: compact, readable, comment the why. Mark deliberate shortcuts with `// ponytail: <ceiling>, <upgrade path>`.
- **Git: the orchestrator owns it.** The repo is `https://github.com/Humpalumps/Cadle` (branch `main`; `v0.1.0-stable` = known-good revert point). Builders and critics: never `git commit`, `git push`, `git checkout`, `git reset`, or otherwise touch git state — just edit your files; the orchestrator commits between waves. Never touch `progress.html` or `tools/` unless you are the orchestrator (running `tools/gate.mjs` / `tools/inspect.mjs` is expected, editing them is not).

## Look & feel bar (what "done" means)
- **Graphics (FF14)**: painterly-realistic, saturated-but-soft, dramatic skies with volumetric-looking clouds and god rays, long view distances with atmospheric haze, glowing aether crystals / floating motes, ornate stone ruins, lush grass + water with real reflections, golden-hour warmth, magical blue-violet night with stars and aurora. Clean anti-aliasing, no shimmer, no popping, soft shadows, proper color management (linear workflow, ACES/AgX tone map, filmic grade).
- **Feel (Destiny 2)**: 90-105 FOV, instant input response, acceleration curves that feel weighty-but-snappy, sprint with FOV kick, slide with momentum, double jump with air control, landing dip, ADS snap (~0.2 s), per-archetype recoil + audio punch, hit markers + damage numbers, satisfying enemy stagger/death, ability cooldown loop, weapon swap animation. 60+ fps always; hitches are failures.
- **World**: an open world of ~4 km² holding **ten biomes** (see World layout). Each one has to hold up on its own —
  its own ground, silhouette, palette, haze, weather of light, bestiary and ambient bed — and the walk between any two
  of them has to read as a journey, not a texture swap. Readable, beautiful from every angle the tour script looks at.

## World layout — TEN BIOMES (shared coordinates; `src/world/Biomes.js` is the single source of truth)
Terrain is **2048 × 2048 m** centered at origin, `terrain.waterLevel` ≈ 4 (water fills wherever ground < waterLevel
AND `terrain.dryAt(x,z)` is 0). Everything below is derived from `Biomes.js` — read the table, do not hardcode.

**HOME BOWL (r < 330) — biome 1, "The Vale" (Meadow).** Unchanged from v0.5:
- **Spawn meadow**: origin, gentle rolling grass, radius ~90. **Aetheryte** at (0, h, -28) — Props.
- **Lake "Mirrormere"**: basin centered (-170, -, -70), radius ~85, beaches; island at (-150, -, -60).
- **Ruins "Sundered Spire"**: plateau at (140, -, 60), radius ~60; enemy camp + the Warden.
- **Forest "Whisperwood"** (the Enchanted Forest's home-side edge): z < -180, x -250..250.
- **Crystal fields**: east (x > 220, inside r 400). **Boss arena "The Hollow Crown"**: radius 45 at (-60, -, 260).

**MOUNTAIN RING (r 330..600).** Craggy wall rising to ~150 m — but it is a BAND, not the end of the world:
it comes back down past ~580 m, and it is **pierced by 9 passes**, one on each outer biome's bearing
(`THETA0 + k*STEP`, k = 0..8). A pass bottoms out ~35 m above the meadow: a real climb, always walkable.

**THE NINE OUTER REGIONS (r 550..970).** Centred at radius `RB` (760 m) on bearings 40° apart, starting due
north. TWO radii, and they are not the same thing: `RR` (210 m) is the LANDFORM reach — how far a region's own
height kernel (`Terrain.BH[]`) shapes the ground — while `RL_CORE`/`RL_EDGE` (270/320 m) is the LOOK reach,
what `weightAt` returns for ground splat, haze, key light, grass, music, bestiary and gravity. The look radii
are set past the halfway point between two centres (260 m on the chord, ~264 m on the arc) **on purpose: the
belt is a PARTITION.** Two neighbours read full strength right up to the bisector where `wedgeAt` hands over,
so a border is a LINE you cross, not a corridor of un-owned ground. **Never "fix" a seam by shrinking the look
radii back inside 260 m — that is the bug this replaced: ~100 m of nobody's-land between every pair, which
made a crossing read as "the world went back to Vale green for half a minute".** `Biomes.regionAt` (weight >
0.30) is the ONE answer to "which region am I in"; music, ambient bed, minimap label and the zone name card
all read it so they change on the same step. **Every biome touches its two neighbours and has its own pass
home. Nothing is teleport-only.** k / bearing / centre / level band:

| k | bearing | biome | centre (x, z) | levels | the read |
|---|---------|-------|---------------|--------|----------|
| 0 | -95° N  | 🌲 Whisperwood Deep (forest)   | (-66, -757)  | 5-11  | closed canopy, fae light, The Elderheart |
| 1 | -55° NE | ❄️ Frostveil Tundra (tundra)   | (436, -623)  | 11-17 | glacier shelves, pines, ice shards, The Glacier Throne |
| 2 | -15° E  | ✨ Celestial Isles (celestial) | (734, -197)  | 30-38 | high marble plateau + **floating isles**, The Empyrean Gate |
| 3 | +25° ESE| 🏔️ Dragon Peaks (dragon)       | (689, 321)   | 24-32 | 200 m peaks, nest ledges, Kharaz-Dun Gate |
| 4 | +65° SE | 🔥 Infernal Wastes (infernal)  | (321, 689)   | 18-25 | caldera, **lava rivers**, black ash, The Cinder Maw |
| 5 | +105° S | 🏰 The Lost Realm (lost)       | (-197, 734)  | 40-50 | endgame: rampart ring, 16 monoliths, The Convergence |
| 6 | +145° SW| 🌑 Shadowfen (shadowfen)       | (-623, 436)  | 15-22 | knee-deep peat murk, dead wood, The Hagstone |
| 7 | +185° W | 🌊 The Sunken Kingdom (sunken) | (-757, -66)  | 20-28 | real sea basin, swim it, The Drowned Court |
| 8 | +225° NW| 🕳️ The Void (void)             | (-537, -537) | 34-44 | shelves over an abyss, **0.55 gravity**, **floating isles**, The Unmaking |

**EDGE (r > 960)**: impassable crag wall.

How each system reads the table (do NOT re-derive any of this):
- height: `terrain.heightAt` (the 9 kernels live in `Terrain.BH[]`, indexed by the same k — closure-free, they are
  stringified into the bake workers). `terrain.biomeAt/biomeBlend/grassAt/dryAt/gravityAt` are the queries.
- ground: `FRAG_SPLAT` picks one of 12 layer textures per region (8 ash, 9 ice, 10 muck, 11 voidstone are new).
- Grass density/tint, Vegetation scatter (`BTREE`/`BROCK`/`BSPIRE`), Props landmarks, Sky fog grade, Water look,
  Enemy camps and Ambient beds are all keyed off the biome id.
- **music**: every region has its OWN recorded theme (`BIOMES[id].music` -> `<music>-theme` in the manifest),
  cross-faded over 2 s on crossing. `audio/music.js`'s REGION rate/tilt table is only the fallback for a theme
  that is missing or still decoding — do not "colour" a region by re-EQ'ing the Vale's tune again.
- **Enemy camps stream by distance** (`STREAM` = 300 m in Enemies.js): the 40-alive cap follows the player around
  the map instead of being spent at spawn. Keep the spawn meadow peaceful (2 wisps).
- Floating isles (celestial, void) are walkable box colliders; **updraft columns** at the landmark lift you up
  (`props.updrafts`, read by PlayerController).

## Automation API (`window.__game`, see src/main.js) — use from harness `{eval: "..."}` steps
`stats()` (fps, frameMs, cpuMs, gpuMs, calls, tris, memMB, systems{per-system CPU ms}), `resetStats()`, `state()`, `teleport(x,y|null,z)`, `look(yaw,pitch)` (yaw 0 = -Z/north, -1.5708 = +X/east), `setHour(h)`, `poi()`,
`biomes()` (the 9 outer biome centres), `goto('tundra'|...[, backOffMetres])` (teleport to a biome heart), `biomeAt(x?,z?)`,
`spawn(type,x,z,opts)`, `spawnNear(type,dist)`, `lineup([types])` (a row of enemies, passive), `passive(bool)`, `killAll()`, `clearEnemies()`, `dummy(dist)` (static target),
`give(weaponId,slot)`, `swap(i)`, `reload()`, `ads(bool)`, `ability('grenade'|'melee'|'class'|'super')` (charges + uses), `damagePlayer(n)`, `respawn()`, `god(bool)`,
`vfxShowcase()`, `flash()`, `kick()`, `bypassPostfx(bool)`, `audioSelfTest()`, `input.press/release/move/button`, `game` (the Game instance: game.<system>.*).
