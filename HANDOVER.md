# HANDOVER — Cadle

Read this first if you are picking the project up cold. It is the only thing a replacement agent gets.
Order: **§1 the job → §2 the next job (biomes) → §3 the machine → §4 the traps → §5 everything else open.**
`CLAUDE.md` is the contract (file ownership, conventions, perf budget, world layout, `window.__game` API) —
this file is state and hard-won knowledge. **Keep it current; delete what has stopped being true.**

Repo: `https://github.com/Humpalumps/Cadle` · branch `main` · everything below is merged and pushed.

---

## 1. The job

Build a browser FPS-RPG in Three.js at **Destiny 2** level for game feel and **Final Fantasy XIV** level for
the mystical look. Three pillars in order: **graphics, performance, game mechanics**. Later, once the
fundamentals are signed off: world bosses with mechanics, quests, story mode with voiced NPCs.

Method the user asked for and you should keep using:

- Break the work into the **smallest pieces that can be judged on their own**.
- **Fan out sub-agents**, one builder per piece, files strictly owned (`CLAUDE.md` has the table).
- A **fresh-context critic inspects the running game** — never the builder's summary — and is harsh.
- Critic compares blind against the real Destiny 2 / FF14, and when ours loses, names the single biggest gap.
- **No fixed number of rounds.** Loop until every critic is genuinely wowed.
- Between waves, one fresh agent plays the whole thing and smooths it into one coherent game.
- The user is usually away: **act, do not ask.** Report what you did and what you measured.

---

## 2. THE NEXT JOB — fix all the biomes fully

The world is ten regions (`src/world/Biomes.js` is the single source of truth; `CLAUDE.md` has the map). The
border crossings, per-region music, zone cards and per-region furniture all landed. **What is left is that
several regions still do not look like the place they are named after.**

The user's own standard, in their words: *"I need all these areas to be different and properly represent the
kind of area and surroundings you'd expect to see in them."* They named three WoW zones as the bar —
**Burning Steppes → Infernal Wastes, Winterspring → Frostveil Tundra, Ashenvale → Whisperwood Deep.**

### What each region IS — the target, not just the gap

Each block is the SPEC: what grows there, what the ground and rock are, what the light and the liquid do, and
what must never appear. `have:` is what is already built (so you extend it), `gap:` is what is missing. Values
in brackets are the live ones in `Biomes.js` / `Vegetation.js`, so you can see what a change is moving.

**🌲 Whisperwood Deep — the enchanted forest.** Reference: **Ashenvale**. Old-growth wood you are *inside*:
trunks in every direction, a canopy that closes over you, shafts of light coming through it, deep teal-green
moss and fern undergrowth, streams, and elven ruins going under the moss. Fae lights drift between the trunks
after dark.
- trees: **YES, the densest in the world** — broadleaf (aspen/oak), full green-teal canopy [p 0.52, gv 0.62,
  tint 0.72/1.12/0.94]. The light is shade, not sun [amb 0.68, fog 0x52806f x 1.95].
- ground: forest soil, leaf litter, moss. Crystals: only tiny **fae wisps** [BSPIRE 0.030], never big shards.
- have: closed canopy, teal foliage, mist between trunks, fallen logs and root-stumps.
- gap: the floor is a bright LAWN — it wants ferns and undergrowth and a darker ground cover. No light shafts.
  No overgrown ruins. **Never:** meadow grass at 0.85 pretending to be forest floor.

**❄️ Frostveil Tundra — the frozen forest.** Reference: **Winterspring**. Not an empty steppe: it is a CONIFER
FOREST buried in snow. Blue-white everything, pines with snow on the boughs, frozen lakes with cracked ice you
can walk out onto, ice formations, icicles, a permanent aurora at night.
- trees: **YES — frosted pines**, dense [p 0.34, gv 0.36, needles tinted 0.74/0.88/1.06, never summer green].
- ground: glacier ice and packed snow [layer 9], almost no grass [0.03]. Ice shards are the crystal here —
  tall and thin [BSPIRE 0.100, aspect 0.60/1.60], pale blue, NOT the meadow's violet aether.
- rock: frost-bleached boulders, wind-carved drifts.
- have: dense frosted conifers, ice shards, drifts, frozen boulders, aurora, bright snow-bounce [amb 1.2].
- gap: **no frozen lakes** — Winterspring's signature. No icicles, no falling snow in-region. Tightest tri
  budget in the world (~3.9 M of 4 M): check Frostveil first after ANY tree change.

**🔥 Infernal Wastes — the volcanic waste.** Reference: **Burning Steppes**. Black cracked basalt and grey ash
lit from BELOW by the red in its own cracks. Lava rivers and pools, vents breathing smoke, cinder cones,
scorched skeletal trees, bones, an orange-brown smoke haze you look through. The sky is dim; the ground glows.
- trees: **almost none, and only charred husks** — bare black skeletons, no leaves [p 0.04, species 4, tint
  0.34/0.24/0.20]. **Never** a living tree, never green.
- ground: black ash and cracked basalt [layer 8, charcoal tint]. **Zero grass [0].** Crystals: **none** —
  obsidian belongs here, not aether. The red comes from lava and crack-glow, never from a crystal.
- liquid: **lava** [`lava: true`] — the channels are the world's water surface wearing a molten skin, and it
  burns (26 dps). Light: ember key, dim ambient, thick smoke [sun 0xff8a3c, amb 0.52, fog 0x4a1f11 x 1.85].
- have: charcoal splat tint, ember light, burning lava channels, vents with hot throats, hexagonal basalt
  clumps, ash drifts, charred husks.
- gap: **the heart of the region is a lava caldera, so from the middle it reads as a red desert, not black
  rock.** The charcoal floor only shows on the ash plains off-centre. The honest fix is TERRAIN SHAPE — less
  lava surface, more black rock — not another tint. Also: submerged-in-lava throws bright star flares.

**✨ Celestial Isles — the divine high plateau.** Sun-warmed white marble and gold, ruined colonnades and
arches, islands floating in gold light with updrafts between them, wordless-choir calm. Everything here is
stone and light; nothing here is woodland.
- trees: **NONE** [p 0]. What replaces them: **broken architecture** — fallen column drums, stubs on plinths,
  arch fragments. Crystals: **none** — the glow here is gilded stone and light, not aether shards.
- ground: veined marble flagstone [layer 6], a trace of pale grass in the cracks [0.05]. The brightest light
  in the world [amb 1.45] through the thinnest haze [fogMul 0.60].
- have: marble and gold ground, the colonnade kit, floating isles with hanging keels, updraft columns.
- gap: reads WEAK at night — brown and unlit, no gold. **Nothing is ON the isles**: no props, no encounter, no
  reward. Bridge spans still read as planks edge-on.

**🏔️ Dragon Peaks — the high mountain.** 200 m fangs of rock, ledges with dragon nests, a dwarven gate cut
into the mountain, the bones of whatever the dragons ate, wind and drums. Alpine, not forested.
- trees: **a few dark alpine pines on the LOWER ledges only** [p 0.10, tint 0.70/0.78/0.68].
- ground: bare strata rock [layer 3], almost no grass [0.07]. Crystals: **none** — broken mountain quartz at
  most. This is not an aether region.
- have: the peaks, the gate, nest ledges, ribcages, scorched rock fangs.
- gap: still the flattest-reading region. The rock is grey-brown with no gold or ice accent to catch the eye,
  and there is no reason to climb — no reward, no nest encounter.

**🏰 The Lost Realm — where every magic meets.** Endgame. A violet flagstone plain, a rampart ring, sixteen
monoliths, standing-stone circles, arcane shards, ceremonial light. Ruined and deliberate, not natural.
- trees: **NONE** [p 0] — standing stones instead. Crystals: **YES, arcane shards** [BSPIRE 0.055]. One of the
  only four regions where a crystal is the honest answer, because this is where magic collects.
- ground: worn violet flagstone [layer 6, tinted], trace grass [0.05], a wide pale-violet haze.
- have: the flagstone, 16 monoliths, stone rings, arcane shards.
- gap: an endgame zone with no endgame content, and the level band 40-50 is declared but never validated.

**🌑 Shadowfen — the cursed swamp.** Knee-deep peat water you wade through, dead drowned wood, reeds taller
than you, hanging moss, witchlight in the dark, and things that used to be people. Choked, sunk, green-black.
- trees: **YES but all DEAD or drowned** — bare wood and willows, sickly olive [p 0.32, tint 0.62/0.74/0.42].
- ground: wet peat muck [layer 10]. The ground cover is reeds, not lawn [0.22, cut from 0.55]. Crystals:
  **none** — the witchlight here should be glowing FUNGUS, not a shard.
- liquid: standing water everywhere, and wading slows you (the region's passive). The thickest haze in the
  world [fogMul 2.4] under a dim sickly key [sun 0xa8c090, amb 0.7].
- have: peat murk, dead wood and willows, reed clumps, rotted stumps, wading.
- gap: can still read too green and too bright in daylight. No hanging moss, no witchlight fungus clusters.

**🌊 The Sunken Kingdom — the drowned city.** A real sea you swim in and a civilisation under it: coral over
the throne room, kelp, anemones, the ribs of wrecks in the sand, whale-song and muffled everything.
- trees: **NONE** [p 0] — coral and kelp are the flora. Crystals: **none** — real branching coral instead.
- ground: reef sand [layer 4, tinted]. Sea [`sea: true`]: past the shelf the water is over your head and you
  swim (the region's passive).
- have: the sea basin, swimming, coral, anemone fans, wreck ribs.
- gap: **underwater is fog only** — no caustics, no muffled audio, no oxygen meter, and nothing down there to
  find. The best region in the world for a reward you have to hold your breath to reach.

**🕳️ The Void — reality gave up.** Shelves of dark violet stone over an abyss, islands hanging with nothing
holding them up, rubble that never landed, snapped pillars of something older, 0.55 gravity, no horizon.
- trees: **NONE** [p 0] — nothing grows. Crystals: **YES, void shards** [BSPIRE 0.120] — jagged and violet,
  the densest spires in the world.
- ground: voidstone with amethyst veins [layer 11], **no grass [0]**, `dry: true` so water never fills it.
- have: voidstone, hanging rubble, snapped pillars, low gravity, floating isles with keels, updrafts.
- gap: bridge spans read as planks edge-on, and nothing is on the isles.

**🌾 The Vale (home) — the calibration reference.** Rolling meadow, wildflowers, the Aetheryte, Mirrormere,
the Sundered Spire, the hamlet. Full grass [1.0], neutral light. **Do not "improve" it casually** — it is what
the blob gate is calibrated against, and it is the one region the user has signed off.

### The rule the whole thing turns on

**Trees and crystals were deliberately pulled back to the regions where they are the honest answer.** Trees:
Whisperwood, Frostveil, Dragon ledges, Shadowfen (dead), Infernal (charred). Crystal spires: Whisperwood (fae
lights), Frostveil (ice), Lost Realm (arcane), the Void. **Everywhere else gets its own kit instead** — that
is what `Props._buildBiomeClutter` is for. The complaint that started this was *"the trees are the same
everywhere and kind of the same with the crystals"*, and re-tinting the same two props is not an answer to it.
If a region needs more life, give it a NEW thing that belongs there.

### How the machinery works, so you extend it instead of fighting it

- **Ground**: `Terrain.js` `FRAG_SPLAT` picks a layer per region via `biomeSet()`; layers 6/8/9/10/11 are real
  albedos (`ASSETS.md` batch 3). The ground-glow masks key off `cB.a` = **the floor texture's luma** — if you
  swap a texture, re-measure and re-tune those bands or the whole region lights up.
- **Borders**: neighbours abut and cross-fade (`Biomes.RL_CORE/RL_EDGE`, `bMix` in the splat, faded out over
  camD 120..240 m). `Biomes.regionAt` is the ONE answer to "which region am I in" — music, ambient bed,
  minimap label and the zone card all read it, so they change on the same step.
- **Furniture**: `Props._buildBiomeClutter` — one recipe per region, built from boxes/cylinders/cones/rock
  blobs, merged into one mesh per region per material with tight bounds so the other regions frustum-cull.
  **This is where you add a region's identity.** ~3.7k pieces today.
- **Flora**: `Vegetation.BTREE` (probability, species pool, leaf tint, `gv` grove floor) and `BSPIRE`
  (probability, tint, scale, `a` = girth/height aspect). Trees and crystals are deliberately restricted to
  the regions where they are the honest answer — **do not put them back everywhere, that was the complaint.**
- **Light / haze / music / passives**: per-region fields in `Biomes.js`. `passive` is the line on the zone
  card and may ONLY describe effects that really exist in code.

### Spawn straight into a region while you work

`http://127.0.0.1:5173/?at=<id>` — drops you there facing its heart, music and ambient bed already correct.
`&back=N` metres short of the landmark (default 150; **celestial and dragon want 250**, their landmark sits
behind a rise), `&hour=H` sets and freezes the clock, `&q=low|high`, `?at=meadow` for the normal Vale spawn.

`forest · tundra · celestial · dragon · infernal · lost · shadowfen · sunken · void`

A border to walk: `?at=tundra&back=-260` (the tundra/celestial seam, gate stones either side).

---

## 3. The machine

| thing | path | what |
|---|---|---|
| Game | `src/**` | Vite 8 + three r185 + `postprocessing` 6.39, plain ES modules, Node 22 |
| Contract | `CLAUDE.md` | ownership, conventions, perf budget, world layout, `window.__game` API |
| Builder / critic protocol | `tools/BUILDER.md`, `tools/CRITIC.md` | what a sub-agent must do and return |
| Harness | `tools/inspect.mjs` | headless Chromium **with the real GPU**, drives the game, saves shots + perf + errors |
| Syntax gate | `tools/check.mjs` | `node --check` every src file + resolve relative imports |
| Source invariants | `tools/invariants.mjs` | ~1 s, no server; the rules that encode bugs which have shipped repeatedly |
| Regression gate | `tools/gate.mjs` | blobs + jitter at both qualities + a real pointer-lock session |
| Contact sheet | `tools/sheet.py` | `python tools/sheet.py tools/out/<dir> 3 640` → `sheet.png` to Read |
| Progress page | `progress/state.json` + `tools/progress.mjs` | → `progress.html` |

**Where you work.** `main` is checked out at `C:/Users/ianca/Desktop/fps4`; the biome work was done in the
worktree `.claude/worktrees/graphics-ff14-quality-audit-7eb837` and is fully merged, so **start from the main
checkout** and make a fresh branch. The dev server on 5173 was last started from that worktree — if you edit
the main checkout and nothing changes in the browser, that is why: kill it and restart from where you are
(see 4c).

**Dev server** — always at `http://127.0.0.1:5173/`. Check with
`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/`. Restart:
`npx vite --port 5173 --strictPort --host 127.0.0.1 --force > tools/out/vite.log 2>&1 &`

**Harness**
```bash
node tools/inspect.mjs --name tour
node tools/inspect.mjs --nolock --name x --steps '[{"wait":5},{"shot":"a"}]'
node tools/inspect.mjs --name x --script file.json --q low --w 1920 --h 1080 --params "at=void&hour=21"
```
Step language is in the header of `tools/inspect.mjs`. `--nolock` for screenshot iteration; omit it for perf
numbers. **Wait ≥ 22 s before judging ground textures** — the bake lands at ~5 s and the layer uploads are
staggered one per frame after it; earlier than that you are looking at the blurry preview layers. Use
`window.__game.god(true)` + `passive(true)` in probes near a landmark or the local camp will kill you
mid-shoot.

**Assets** — Magnific MCP (`mcp__df0d6b46-…__*`): `images_generate` (~75-100 cr), `audio_sfx_generate`,
`audio_music_generate` (elevenlabs v2, 20 cr/s), `models3d_generate` (~1160 cr). Check `account_balance`
first. Flow: generate → `creations_wait` → **curl the url immediately** (tokens expire) into
`public/assets/…` → update `ASSETS.md`. Naming a trademarked game in a prompt gets it rejected — describe the
style instead. Everything loads through `game.assets` (`src/core/Assets.js`), preloaded before any system
init; the ONE documented exception is the intro's own texture set. `TECHNIQUES.md` holds the ranked,
license-verified open-source three.js techniques builders are told to steal from.

---

## 4. Traps that have each cost hours

### 4a. The blob law (read `CLAUDE.md`'s architectural law first — this is the field guide)

The washed-white-blob bug has shipped **six** times, each from a different system. The rule that actually
holds: **saturate the COLOUR, cap the VALUE.** A neutral bright thing tone-maps to a white ball; a saturated
one reads as its own colour at the same brightness. Three lessons that cost real time here:

- **Cap the CHANNEL, not just the luminance.** Two colours of equal luminance are not equally close to white
  — a cyan sits near the cap in two channels at once. Grass caps max channel 0.52 AND luminance 0.483; the
  intermediate version capped luminance only and the gate lit up at both qualities immediately.
- **Saturate BEFORE you normalise.** Normalising a tint by its brightest channel keeps the hue and throws
  the chroma away, so a pale instance colour comes out near-white. That is what made meadow crystals glow
  white after the biome tint work.
- **Green was never the safety property — not being neutral is.** Grass used to be forced green-dominant,
  which is why marble, ash and voidstone all wore the same lawn. It now has a saturation floor plus a green
  fallback for genuinely grey ground (you cannot saturate a grey by scaling a zero difference).

Ground cover is never emissive; rim/backlight goes in `reflectedLight.directDiffuse`. `tools/invariants.mjs`
pins the ceilings — **fix the code, never the rule.**

### 4b. The gate lies when the box is busy — check this before you "fix" a shader

`node tools/gate.mjs` failed five times in a row with `JITTER: burst-jit frames missing — gate steps did not
run` and warm ~20 px "blobs" at the very top of frame. **None were real.**

1. **Orphaned browsers.** Stray `chrome-headless-shell` processes accumulate from earlier runs (14 of them
   once) and starve the GPU until the renderer dies mid-script.
   `Get-Process chrome-headless-shell | Stop-Process -Force` before a run, and check afterwards.
2. **A truncated run has no MASK frames**, so `blobcheck.py` loses the ground-cover scoping it depends on and
   dutifully reports the sun through the treeline. **A warm (234, 214, 170) "blob" at y = 0..5 is the sky.**

When the box is contended, run the legs standalone — that completes when the combined run will not:
```bash
node tools/inspect.mjs --nolock --name gate-high --q high --script tools/gate-steps.json --url http://127.0.0.1:5173/
python tools/gate.py tools/out/gate-high && python tools/blobcheck.py tools/out/gate-high burst-blob-
```
**Last measured, green leg by leg on `main`:** invariants PASS · q=high jitter 0.075 + blobcheck PASS (88
frames) · q=low jitter 0.137 + blobcheck PASS (88 frames) · pointer lock PASS (gate leg + six standalone
runs). **A single end-to-end `gate.mjs` run that captures every leg is still owed** on a quiet machine.

### 4c. The dev server silently serves stale modules

Twice, native fs events stopped reaching this checkout (it is a git worktree under `.claude/worktrees`) and
Vite kept serving the FIRST transform of every module with no error anywhere — a perf A/B and two gate runs
had to be thrown away. `vite.config.js` now uses `watch.usePolling`. **Before trusting any measurement:**
```bash
curl -s http://127.0.0.1:5173/src/world/Terrain.js | grep -c lyrHexG
```
Recovery: `netstat -ano | grep :5173` → `taskkill //PID <pid> //F`, `rm -rf node_modules/.vite`, relaunch
with `--force`, then prove the watcher is alive (append a marker to a source file, curl it, remove it).

### 4d. Perf numbers drift on this machine

The same unmodified code measured p50 4.6 ms and then 9.4 ms an hour later. Cross-run comparisons are
worthless; **A/B inside one process** (two `perfWindow`s in one script) or interleave. The deterministic
counters (draw calls, tris, memMB) are the trustworthy signal. Budget: **≤ 4 M tris** (raised from 3 M by the
user — "we can work on optimizations elsewhere"), ≤ 350 draw calls, frame mean ≤ 7 ms, p99 ≤ 14 ms at 1080p
q=high; `q=low` ≤ 4 ms.

### 4e. Anything stringified into a worker is a landmine

`Terrain.js` used to build its bake worker by stringifying its own functions. That works in dev and **dies in
every minified build** (the minifier renames bindings, the template string keeps the old identifiers), and
the only symptom was a silent fall back to a main-thread bake: 22 rendered frames in 17.6 s of boot before,
507 in 12.2 s after. The math now lives in `src/world/terrainKernel.js` (no `three` import, so the worker
chunk stays engine-free) and `terrainWorker.js` imports it. `invariants.mjs` (a2) fails if anyone
reintroduces the string form, drops the module-worker call, imports three into the kernel, or breaks the
`heightAt` wiring.

`terrain.heightAt` is ground truth for the entire game. Snapshot it before touching the kernel — seed 1337
must give `{"n":2695,"sum":164490.108949}`:
```bash
node tools/inspect.mjs --nolock --name heightcheck --steps '[{"wait":20},{"eval":"(()=>{const t=window.__game.game.terrain;let s=0,n=0;for(let i=-1000;i<=1000;i+=37)for(let j=-1000;j<=1000;j+=41){s+=t.heightAt(i,j);n++;}return JSON.stringify({n,sum:+s.toFixed(6)});})()"}]'
```

### 4f. Small ones

- Bash heredocs > ~5 KB fail on this machine (`unexpected EOF`) — use the Write tool for anything long.
- `renderer.info` must be reset per frame or draw-call/tri counts are garbage.
- `PostFX.update()` re-applies `enabled` from `this.q.*` every frame, so runtime `pass.enabled = false`
  toggles are silently reverted — bisect via `postfx.q.taa/ao/godrays`.
- postprocessing's `EffectComposer.addPass(pass, index)` is the supported way to insert the viewmodel overlay
  passes; splicing `composer.passes` skips initialisation.
- Look at the PNGs. A build can be error-free and still look like programmer art.
- Never let two agents own the same file. Cross-system needs go in the report as an ask.

---

## 5. Everything else open

**Performance**
1. A **~65 ms periodic hitch at q=high** (~3/second). Characterised, not fixed: q=low has none, and it
   survives env-bake off, shadows frozen, water stubbed, full postfx bypass, TAA off, AO+godrays off, and a
   second pass with the program count already warm (174 → 174, so not shader compilation). Vegetation LOD
   refresh was measured directly and is not it (0.3 ms for all eight sets). Headless inflates it ~3×; in a
   headed browser it reads p99 86 ms / max 345 ms. **Biggest remaining perf item.**
2. Impostor tier swap is still a hard pop at the boundary — a dither crossfade over ~15 m is the fix.

**World / content**
3. Four of nine straight-line pass walks (dragon, lost, void, infernal) stop at the destination region's own
   landform edge. The player is inside the region by then and would walk around, but a route would be better.
4. The village (Hearthfall) is nine huts and a well: no interiors, no NPCs, no doors.
5. Level bands are declared but never validated; nothing checks the XP/loot curve reaches 50, and a level-5
   player wandering into the Lost Realm just dies with no signposting.
6. `wilds` (the belt between region cores) has an ambient bed but no identity of its own.
7. Serpents read thin from below; their hover band wants tuning against the dive AI.

**Tooling / assets**
8. `tools/blobcheck.py`'s BRIGHT test no longer covers airborne blobs (intended emissives made it unworkable
   there). Coverage for those is the `invariants.mjs` ceilings + the aether cap + `HOT_TINT`. If a glowing
   ball appears off the ground, that is the gap.
9. `public/assets/` is ~43 MB against a 40 MB target — re-encoding the nine 192 kbps region themes to 128
   would recover ~4 MB, but there is no mp3 encoder on this machine (no ffmpeg; Pillow is images only).

**Not started** — RPG stats/loot/inventory depth, quests + voiced NPCs (`audio_tts` can voice them), world
bosses, story mode.

---

## 6. The cinematic loading screen (do not undo these)

A young man at his computer in a dark bedroom; **his monitor shows the game's own start screen** composited
over the live world. On click he is pulled head-first into the monitor and the game starts. Files:
`src/ui/Intro.js` + `src/ui/intro/{stage,room,character}.js`, `intro.html` (dev-only preview),
`public/assets/intro/` (1.6 MB), `docs/intro-ref/` (art references, not shipped).

- It **shares the game's renderer and canvas** — that is what lets the monitor show a real render. So:
  `Lighting.js` sets `shadowMap.autoUpdate = false` and the intro must set `needsUpdate = true` every frame
  or the room goes black; and it must restore `toneMapping` / `shadowMap.enabled` / `setRenderTarget(null)`.
- The transition runs on **wall clock**, not accumulated `dt` — impostor baking can still be hogging the
  thread when the player clicks, and a dt-driven timeline turns a 2 s dive into 5 s of slow motion.
- `#introui` is `pointer-events: none` with its listener on `window`, so the canvas's own
  `mousedown → Input.lock` path still runs. A full-screen div that swallowed the click broke the gate's
  pointer-lock re-acquire leg.
- **`main.js` does NOT statically import `Game.js`** — it builds the renderer, puts the intro up with it, and
  only then `await import('./core/Game.js')`. Importing it at the top meant a dark page until the whole game
  chunk had downloaded.
- **First frame is compile-bound, not download-bound**: the composer is built two frames after the room is on
  screen, and `stage.setLightsFull(false)` paints the first frame against a cheap rig. 7.2 s → 2.0 s. If you
  add lights or effects, re-measure — marks are logged as `[intro] boot ms:`.
- Preload hints only work if the credentials mode matches (three's `TextureLoader` sets
  `crossOrigin='anonymous'`); get it wrong and every asset downloads twice.
- The character is a generated GLB that streams in and fades up; the procedural body in `character.js` is the
  fallback and still supplies the chair. Placement is `GUY_FIT` in `stage.js` — tune live with
  `__intro.stage.fitGuy({…})` on `intro.html` and paste the result back.
- `?auto=1` skips the intro entirely, so the harness sees what it always saw. `?auto=1&intro=1` runs it and
  auto-plays; `&introhold=1` holds it for screenshots (needs `--noready`). `__game.intro.seek(t)` freezes the
  transition at an absolute time. **The gate must wait for the game to be running before its click** — the
  intro owns the screen for the first seconds, and a click at 4 s lands on the intro.

---

## 7. History (short)

Waves 1-5 built the systems out with fan-out builders and fresh-context critics; scores climbed ~5.2 → ~6.5
before the loop was replaced by direct orchestration. Then: the ten-biome map (2048 m world, nine outer
regions on a pierced mountain ring), an identity pass (per-biome light, weather, score, signature enemy
moves), the cinematic loading screen and the real module worker, the border-crossing wave (regions abut,
nine region themes, zone cards, `?at=`), and the biome identity wave (per-region furniture, trees and
crystals restricted, Burning Steppes / Winterspring / Ashenvale passes). `git log` has the detail; each
commit message explains the why. Revert points: `v0.1.0-stable`, `v0.1.1-stable` (baseline + regression gate
+ pointer-lock fix).

**Git is the orchestrator's.** Builders and critics never commit, push, checkout or reset — edit your files
and report; the orchestrator commits between waves.
