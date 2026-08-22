# HANDOVER — Cadle orchestration

Read this first if you are picking this project up cold (new session, new agent, previous orchestrator ran out of usage). It tells you what the job is, how the machine is built, what state it is in, and the exact commands to carry on.

**Keep this file current.** Every loop tick / wave boundary: update "Current state" + "Next actions". It is the only thing a replacement agent gets.

---

## 0. MERGED TO MAIN (2026-08-22) — read the gate note before you trust a red gate here

The border-crossing + biome-identity work is **on `main` and pushed** (`0d73fb8`). It merged cleanly with the
cinematic-intro branch; two conflicts, both because main had moved code this branch edited:

- `Terrain.js` — main lifted heightAt/bakeKernel/layerTex into `terrainKernel.js` for a real module worker.
  Took main's side; this branch's only edit in that region was a comment. Everything else (border partition,
  seam blend, biomeSet/lyrHexG splat, the five ground albedos) merged clean.
- `main.js` — main gated `game.start()` behind the intro. `spawnParam()` (the `?at=` link) now hangs off
  `game.ready`, so a link is already standing in the right region when the intro hands over.

### THE HARNESS CANNOT RUN BOTH GATE LEGS BACK TO BACK ON THIS BOX (2026-08-22)

`node tools/gate.mjs` failed five times in a row with `JITTER: burst-jit frames missing — gate steps did not
run` and warm 20 px "blobs" at the very top of frame. **None of those were real.** Two causes, both
environmental, both worth knowing before someone "fixes" a shader that is not broken:

1. **Orphaned browsers.** 14 stray `chrome-headless-shell` processes had accumulated from earlier runs. They
   starve the GPU and the renderer dies mid-script. `Get-Process chrome-headless-shell | Stop-Process -Force`
   before a gate run, and check afterwards.
2. **A truncated run has no MASK frames**, so `blobcheck.py` loses the ground-cover scoping it depends on and
   reports the sun through the treeline. A "blob" at y = 0..5 that is warm (234, 214, 170) is the sky.

Run the legs **standalone** when the box is contended — that completes when the combined run will not:

```bash
node tools/inspect.mjs --nolock --name gate-high --q high --script tools/gate-steps.json --url http://127.0.0.1:5173/
python tools/gate.py tools/out/gate-high && python tools/blobcheck.py tools/out/gate-high burst-blob-
```

**Green on the merged code, measured leg by leg:** invariants PASS · q=high jitter 0.075 + blobcheck PASS
(88 frames, 107 files captured) · q=low jitter 0.137 + blobcheck PASS (88 frames) · pointer lock PASS (the
gate leg plus six standalone runs). A single end-to-end `gate.mjs` run that captures everything is still owed
once the machine is quiet.

### Two real bugs the gate caught during the merge (both mine, both the decree's bug)

- The crystal instance tint fed the emissive **normalised by its brightest channel** — that keeps the hue but
  not the chroma, so the meadow's pale cyan-to-magenta jitter came out near-white. Saturate BEFORE you
  normalise.
- Grass: the first replacement for the green-dominance rule capped **luminance**. Equal luminance is not equal
  closeness to white — a cyan blade sits near the cap in two channels at once. Cap the CHANNEL as well.

---

## 0. Latest wave — BORDER CROSSINGS (2026-08-22)

The user's bar for this wave, verbatim: *walking from one biome to another must be at the level of walking
from the Barrens to Ashenvale in World of Warcraft — you can plainly see a biome shift, and the music plays
different as you enter one biome to another.*

### The diagnosis

The ten-biome map already had per-region ground, haze, key light, ambient bed and "music". None of it read as a
crossing, for four separate reasons:

1. **There was no border.** `weightAt` faded each region out at 210 m from its centre, but neighbouring centres
   are 520 m apart — so between every pair of regions lay ~100 m of belt that belonged to NOBODY. Walking
   tundra → celestial, the world went back to Vale green (with a "The Vale" card on it) for half a minute and
   then became something else. Measured, not guessed: a 20 m-step probe across the seam read
   `id=tundra w=0.09` → `w=0.00` → `id=celestial w=0.09`.
2. **A region did not have its own music.** `music.js` played ONE theme with a per-region playback rate, tilt
   filter and reverb send. That is a re-EQ, not a different piece.
3. **Nothing announced the crossing.** The minimap showed the nearest landmark; no zone card.
4. **Walking into a region threw an exception every frame.** `Lighting._gradeBiome` set `_biomeId` inside the
   early-out branch but cached `_biomeSun` after it, so entering a region through the low-weight edge (i.e. on
   foot, which is the only way a player ever does it) left the tint undefined and the whole lighting update
   threw from then on. This is why the first crossing probe froze at r≈558 with ten `reading 'r'` page errors.

### What shipped

- **The belt is a partition** (`Biomes.RL_CORE/RL_EDGE = 270/320`, used by `weightAt`, the splat GLSL and
  `Terrain.colorAt`). Two neighbours now read full strength right up to the bisector where `wedgeAt` hands
  over, so the border is a LINE (broken by the splat's own ±13 m macro noise), not a corridor. The landform
  mask (`RR` = 210) was deliberately NOT widened: a region's look reaches past its mountains, the mountains
  do not, and widening it would have meant a re-bake with different terrain.
- **`Biomes.regionAt` is the single crossing truth** (weight > 0.30 — the weakest point of a region is the seam
  itself, ~0.38 along the ring arc). Audio's music region, Audio's ambient zone and the HUD's card and minimap
  label all read it, so they change on the same step.
- **Nine region themes**, 60 s each, generated with Magnific/ElevenLabs and committed under
  `public/assets/music/` (`wood/frost/choir/drums/forge/convergence/fen/deep/void-theme.mp3`). `music.js`
  `_themeKey()` picks `<region>-theme` when its buffer is decoded, cross-fading over 2 s; the old rate/tilt
  colouring is now only the fallback for a region whose buffer is missing. All eleven themes are decoded up
  front (`Audio._decodeAssets`) — a first-play decode of a 60 s mp3 would hitch exactly at a crossing.
- **Zone card on crossing** — the existing `hud.notify()` (44 px small-caps gold serif + filigree rule) fires
  with the region's name and its level band. Suppressed for the region you spawn in.
- **Border stones** (`Props._buildBorderStones`): three pairs of standing stones flanking each of the nine
  seams at r 700 / 762 / 824, one merged mesh, 54 stones for one draw call. An open line in a field is
  something you cross without noticing; a gate is a threshold.
- **The border itself is blended, not a line.** Picking one wedge per pixel drew the bisector as a
  dead-straight radial edge — snow ending mid-stride against marble (the user's screenshot). The wedge
  coordinate is now pushed around by the macro noise, so the boundary MEANDERS in metres rather than degrees,
  and inside a ~34 m half-band either side BOTH neighbours are sampled and cross-faded (`bMix`, capped at 0.5
  so the seam is an even mix). `lyrHexG` takes explicit derivatives, so the second fetch sits behind a branch
  and costs nothing outside a border band — measured in one process, standing ON a seam is not slower than
  standing inside a region. `Terrain.colorAt` does the same arithmetic so the grass tint follows the same
  ragged edge, and the lava/void ground glow is blended too so it fades out instead of stopping dead.
  The LOGICAL boundary (`Biomes.regionAt`, i.e. music / name card / bed) stays on the analytic bisector — it
  can sit up to ~40 m from the art boundary, which is how an MMO does it anyway.
- **The crossing eases in time as well as space**: `Lighting._gradeBiome` and `Sky._gradeFog` now chase the
  target tint / fog hue / fog density (~1 s) instead of taking them straight, because the id flips in one frame
  at the seam.
- **Region tracking no longer needs an AudioContext** (`Audio._zoneTick`), so `?auto=1` harness runs — which
  have no ctx — can verify a crossing. This is why every earlier probe reported `zone=meadow music=field`
  standing in the heart of the tundra.

### Also fixed on the way (all found by looking at the screenshots)

- **Every biome's spires looked like the same meadow crystal.** The per-biome tint only reached the crystal
  albedo; the emissive body, rim and translucency were hardcoded aether violet, which drowns it. They now take
  the instance hue (`gTint`, normalised to the brightest channel — hue only, the intensity and its cap are
  untouched, per the architectural law).
- **Five region floors were procedural noise** — the Isles read as flat tan with a lattice in it, the Void and
  the fen as coloured mud. Generated `celestial_marble / ash / glacier_ice / fen_muck / voidstone` (1024²,
  low-frequency lighting divided out so the tile repeat does not read as a checkerboard), wired through
  `Terrain.ASSET_LAYERS`.
- **The Infernal Wastes rendered as one flat orange sheet.** The lava-fissure and void-vein emissives key off
  `cB.a`, the floor texture's luma, with a 0.30..0.06 ramp — and the new ash/voidstone sit at median 0.11, so
  every pixel was a fissure. Re-calibrated to the darkest ~10% (0.075..0.025 and 0.085..0.032). **Re-measure
  if either texture is replaced** (the numbers are in ASSETS.md).
- **Floating isles were dark ellipses** from below — the one angle you always have on them. Each isle now hangs
  a torn keel (rock kind 3, flipped).

### Verification — what was actually run

- `node tools/invariants.mjs` — OK. `node tools/check.mjs` — 61 files OK.
- **All nine passes walked end to end** (`tools/out/passes1`), sprinting outward from r≈320 for 40 s:
  every one leaves the mountain ring and ends inside its destination region. Logged x/z as well as radius, so a
  tangential slide can no longer be mistaken for "stuck" (the old probe's flaw). **Four of the nine —
  dragon, lost, void, infernal — genuinely stop** at r 569 / 592 / 597 / 630 (movement drops to 0–2 m per 2 s):
  the straight line runs into the region's own landform (peak wall, abyss shelf, caldera rim). They are IN the
  region by then; a player would walk around. Not fixed, flagged.
- `vegetation.collisionSelfTest()` — **pass** (tree capsule, rock, crystal, ruins wall).
- **Perf, 1080p RTX 3060, six regions.** q=high p50 2.9–4.6 ms, ≤ 189 draw calls, ≤ 2.9 M tris, memMB flat at
  272.8. **q=low re-profiled since the world grew 4× (outstanding item 1): mean 2.5–3.65 ms, p99 4.4–13.3 ms,
  ≤ 135 calls — inside the ≤ 4 ms budget in every region.**
- **The ~250 ms frame spikes (outstanding item 2) are now characterised, not fixed.** They are periodic
  (~3/second), q=high only — **q=low has none at all** — and they survive every subsystem toggle: env bake off,
  shadows frozen, water update stubbed, postfx bypassed, TAA off, AO+godrays off, and a second pass over the
  whole map with the program count already warm (174 → 174, so it is not shader compilation). Vegetation LOD
  refresh was measured directly and is not it (0.3 ms for all eight sets). **In a HEADED browser
  (`--headed`) the same probe reads p99 86 ms / max 345 ms with ~65 ms spikes** — so the headless figure is
  inflated ~3×, but a real ~65 ms hitch does exist at q=high and is still a "hitches are failures" problem.
  Next place to look: the harness's own frame pacing vs the real one, and per-frame render-target work that
  scales with the q=high resolution/MSAA path.
- Regression gate at merge: see "Gate status" below.

### Biome identity: each region grows its own thing (2026-08-22, after user feedback)

The complaint was "the trees are the same everywhere and kind of the same with the crystals" — nine regions
furnished out of exactly two props, re-tinted. Fixed on three levels:

1. **Trees and crystals were pulled back to where they are the honest answer.** Trees: Whisperwood, Frostveil,
   Dragon Peaks (ledges), Shadowfen (drowned wood), Infernal (charred husks). Crystal spires: Whisperwood
   (fae light), Frostveil (ice), Lost Realm (arcane), the Void. Everywhere else they are gone.
2. **`Props._buildBiomeClutter`** gives every outer region its OWN kit, ~3.6k pieces in total: marble drums,
   column stubs and arch fragments (Celestial); ribcages and scorched fangs (Dragon Peaks); vents with hot
   throats, hexagonal basalt clumps and ash drifts (Infernal); reed clumps and rotted stumps (Shadowfen);
   branching coral, anemone fans and wreck ribs (Sunken); hanging rubble and snapped pillars (Void); wind
   drifts and frozen boulders (Frostveil); fallen logs and root-stumps (Whisperwood); rings of standing
   stones (Lost Realm). One merged mesh per region per material, tight bounds so the other eight cull.
3. **Foliage takes the region's colour** (BTREE `col`) instead of one global yellow-green jitter, and the
   spires take a per-region aspect (BSPIRE `a`) so an ice shard, a coral fan and an obsidian stump differ in
   silhouette, not just hue.

**Reference passes** (user named these): Burning Steppes → Infernal (charcoal splat tint, ember sun 0xff8a3c,
ambient 0.52, thick smoke, 230 clutter attempts); Winterspring → Frostveil (it is a FOREST under snow: tree
density 0.13 → 0.34 with a grove floor); Ashenvale → Whisperwood (teal foliage, ambient 0.85 → 0.68, mist
fogMul 1.55 → 1.95, and a grove FLOOR so the heart of the wood is not an open lawn with a treeline).

**The grass rule changed, and the first two attempts were wrong — read this before touching it again.**
Grass was forced GREEN-DOMINANT everywhere, which is why marble, ash and voidstone all wore the same lawn.
Green was never the safety property — NOT BEING NEUTRAL is, because a neutral blade is what tone-maps to a
white spike. The rule is now: a saturation floor, a green fallback for genuinely grey sources (you cannot
saturate a grey by scaling a zero difference), and BOTH of the old clamp's ceilings — max channel 0.52 AND
luminance 0.483. The middle attempt capped luminance only, and the gate caught it immediately at BOTH
qualities (9-15 clusters up to 179 px): two colours of equal luminance are not equally close to white, and a
cyan blade sits near the cap in two channels at once. **Cap the channel, not just the light.**

**Tri budget is now 4 M** (user, 2026-08-22 — "we can work on optimizations elsewhere"). A closed canopy in
two regions measured 4.19 M / 3.88 M at the old NEAR=190; EZTrees NEAR is 175 and SHADOW_CAST 68, which lands
forest ~3.3 M and Frostveil ~3.9 M. Frostveil has the least headroom — check it first after any tree change.

### `?at=` — spawn straight into a region

`http://127.0.0.1:5173/?at=<id>` drops you in that region instead of the Vale, facing its heart, with the
music and the ambient bed already correct. Works with or without `auto=1`. `&back=N` is how many metres short
of the landmark you land (default 150; celestial and dragon want ~250, their landmark sits behind a rise),
`&hour=H` sets and freezes the clock. Ids are the Biomes.js ones plus `meadow`. Unknown id = normal spawn.

### THE DEV SERVER SILENTLY SERVED STALE MODULES (read this before trusting a measurement)

`vite.config.js` already carries a comment about exactly this, and it happened again anyway: after a
`git stash` / `git stash pop` pair the watcher stopped invalidating and `curl http://127.0.0.1:5173/src/...`
returned the PRE-EDIT file, with no error anywhere. Two results in this session were taken against the old
code before it was caught (a perf A/B and one gate run) and had to be re-run. **When a change does not seem to
do anything, or before trusting a perf/gate number, check what the server is actually serving:**

```bash
curl -s http://127.0.0.1:5173/src/world/Terrain.js | grep -c lyrHexG
```

Recovery: `taskkill //PID <pid> //F` (find it with `netstat -ano | grep :5173`), `rm -rf node_modules/.vite`,
then relaunch with `--force`.

### Still open (carried forward)

1. Four of nine straight-line pass walks stop at the destination region's landform edge (above).
2. The q=high ~65 ms periodic hitch (above) — the biggest remaining perf item.
3. Celestial Isles read weakest at NIGHT — brown, unlit, no gold. Day is fine.
4. Isles have spans, updrafts and now keels, but still nothing ON them: no props, no encounter, no reward.
5. Village is nine huts and a well — no interiors, no NPCs.
6. Serpents still read thin from below; hover band wants tuning against the dive AI.
7. Underwater is fog only — no caustics, no muffled audio, no oxygen.
8. Level bands declared but never validated; no signposting when a level-5 player wanders into the Lost Realm.
9. Submerged-in-lava has bright star flares (bloom on hot cracks from inside).
10. `public/assets/` is ~41 MB against a 40 MB target — the nine themes are 192 kbps CBR and there is no mp3
    encoder on this machine (no ffmpeg; Pillow is images only). Re-encoding to 128 kbps recovers ~4 MB.
11. `tools/blobcheck.py` BRIGHT no longer covers airborne blobs; coverage there is the invariants ceilings +
    the aether cap + HOT_TINT. A glowing ball off the ground is the gap.
12. `tools/gate.mjs` still hardcodes `http://127.0.0.1:5173` (it happened to be this worktree's server).

### Gate status at merge (`node tools/gate.mjs`, this worktree's server on 5173)

**`==== GATE PASSED ====` — the first fully green run this project has had.** invariants PASS · jitter PASS at
both qualities (0.849 and 0.1 against a 2.0 limit) · **blobcheck PASS at BOTH q=high and q=low** (88 frames
each, no glowing clusters, no flashes) · pointer lock PASS (engage + re-acquire).

Getting there was not a tuning exercise, it was two real findings:

1. The seam blend, unfaded, gave the sampler two floors to alias between out where a 68 m border band is
   thinner than a pixel. Distant ground flickered green<->ice frame to frame and blobcheck reported 26-647 px
   clusters up at the horizon (y ~50-100 px). Fading the blend out over camD 120..240 m removes it and costs
   nothing to look at — from 150 m up the blend still runs at ~84%, and the aerials are indistinguishable.
   A wider 260..460 band was tried and put the horizon clusters straight back; the number is measured.
2. The near-ground grass speck that the previous session merged on (24 report lines then, 3-12 in the runs
   before this one) is genuinely flaky run to run — this run has none. Do not read a single clean run as
   proof it is gone.

*(the ten-biome wave that this one builds on is below)*

## 0b. Previous wave — THE TEN BIOMES (2026-08-21/22)

The world is **2048 × 2048 m with ten biomes** (was 1024 m / one region). `src/world/Biomes.js` is the single
source of truth for the layout and the per-region data; CLAUDE.md "World layout" has the full table and rules.

### What shipped

**World** — home bowl unchanged (r < 330); the mountain ring is now a BAND that comes back down past ~580 m,
pierced by nine passes; nine circular regions of radius 210 m centred at radius 760 m, 40° apart, so the outer
annulus is one continuous walkable belt. Every biome touches its two neighbours AND has its own pass home.

- `Biomes.js` (new): one data row per region. Every field is consumed — see the header comment for who reads what.
- `Terrain.js`: 2048 m world, 2048² bake (unchanged cost — same 1 m texel, 4× as many), nine closure-free height
  kernels in `BH[]` (stringified into the bake workers), 12 splat layers (+ash/ice/muck/voidstone),
  `biomeBlend / grassAt / dryAt / gravityAt / roadAt`, a jagged world-edge range, and **PASS ROADS** (a smooth
  radial ramp inside a narrow angular band — without it the belt's boulder noise leaves >50° micro-faces that
  the controller treats as no-traction, and the walk out of the Vale jammed at r≈394 every time).
- `Grass.js`: blades take the ground's hue from the biome-tinted `colorAt`, clamped green-dominant and
  value-capped so a pale floor can never bleach them into white spikes. The Vale is bit-identical.
- `Vegetation.js` + `EZTrees.js`: per-biome scatter tables, conifer + dead species, nothing grows in a road.
- `Props.js`: nine landmarks (three stone materials), floating isles with **linked spans + updraft columns**,
  Dragon Peaks gate + nests, and Hearthfall (the Vale hamlet, with windows that light after dusk).
- `Water.js`: dry mask, per-biome water look, and a **molten skin** on the Infernal channels (which are carved
  below `waterLevel` on purpose — the lava rivers are the world water surface, not a decal). Lava burns (26 dps).
- `Sky.js` / `Lighting.js`: local aerial-perspective grade AND a per-biome key-light + ambient grade (hue only
  for the key, so time of day still owns the brightness). Real underwater fog.
- `enemies/*`: 17 new types on 9 rigs (giant, wraith, serpent are new), camps streamed by distance, and **six
  signature moves** — frost breath + chill, ice-giant chill/frozen ground, magma burning ground, riftling blink,
  void-horror pull, bog-witch mend. All verified functional in the harness.
- `VFX.js`: per-region weather (snow, ash, rain, motes) on one camera-following emitter, ≤ ~40 live particles.
- `music.js` / `Audio.js`: the one score is re-lit per region (playback rate, tilt filter, reverb send).

### The gate was broken; it is fixed

`tools/gate.mjs` blobcheck failed on **pristine f378c9e** too (verified against a clean worktree) — it was
flagging the sun through a treeline, dawn haze on distant geometry, lantern flames and loot beacons. Fixed
properly rather than by moving thresholds:

- `PostFX._renderSkyMask()` renders an **atmosphere/ground-cover mask** per burst: geometry green, sky and fog
  magenta, grass RED (the blades render in `uMaskMode`, since their geometry is built in their own vertex shader
  and an overrideMaterial draws nothing). `tools/inspect.mjs` captures one `mask-*.png` per burst.
- `tools/blobcheck.py` scopes BOTH tests to ground cover (the decree's actual rule), ignores anything the haze
  owns, and drops lit surfaces (`MAX_AREA_FRAC`) and slivers (`MIN_THICK`). **`--selftest` paints synthetic
  bloom-balls on the blades and asserts they are still caught** — run it after any threshold change.
- Two real bugs it then found, both fixed: creature aether now has a hue-preserving luminance cap
  (`materials.js`, wisps were reading as white orbs) and `Brush.color` tints white hot cores toward their
  element hue (`HOT_TINT`) instead of starting from pure white. Both pinned by new invariants.
- `tools/invariants.mjs` also now pins the bake-worker rule (BH[] may only call injected helpers) and
  `FRAG_SHOULDER` (the terrain highlight roll-off that stops the ground going flat white at grazing sun).

### Perf

p50 3.6–4.3 ms at 1080p q=high on the RTX 3060 in every region, ≤ 3.0 M tris, ≤ 175 draw calls, memory flat.
Bake unchanged at ~12.5 s (same as main). `CADLE_URL=http://127.0.0.1:<port>/` makes the harness and the gate
target a worktree server on its own port.

### OUTSTANDING — start here

**Verification not done**
1. `q=low` never re-profiled since the world grew 4×. Run `--q low` perf windows in three regions.
2. Recurring ~250–300 ms frame spikes in the headless harness (p50 is fine). Survives postfx/water/shadow/grass/
   enemy toggles with zero resource churn, so it looks like the headless compositor — **never confirmed against a
   headed browser**. Do that before trusting it.
3. Only one pass (north, to Whisperwood Deep) has been walked end to end. Walk the other eight.
4. `vegetation.collisionSelfTest()` not run since the change; nothing verifies you cannot fall through a
   floating isle or a bridge span.
5. The long-walk probe logged radius only, so a tangential slide reads as "stuck". Re-run logging x/z.

**Content gaps**
6. Dragon Peaks still the weakest region — the gate and nests are in, but the rock reads flat grey; wants
   ice/gold accents and a reason to climb.
7. Isles have spans and updrafts but nothing ON them — no props, no encounter, no reward.
8. Village is nine huts, a well and field walls. No interiors, no NPCs, no doors.
9. Serpents are scaled up but still read thin from below; their hover band wants tuning against the dive AI.
10. Underwater is fog only — no caustics from below, no muffled audio, no oxygen.
11. Level bands are declared but never validated: nothing checks the XP/loot curve reaches 50, and a level-5
    player wandering into the Lost Realm just dies with no signposting.
12. `wilds` (the corridors between regions) has an ambient bed but no identity of its own.

**Known rough edges**
13. Submerged-in-lava has bright star flares (bloom on the hot cracks seen from inside). 4-second death state,
    low priority, but it is a white-ish artefact.
14. Void isle undersides are flat dark discs; bridge segments read as floating planks edge-on.
15. `tools/blobcheck.py` BRIGHT no longer covers airborne blobs (intended emissives made it unworkable there).
    Coverage for the rest of the world is `invariants.mjs` ceilings + the aether cap + HOT_TINT. If a glowing
    ball ever shows up off the ground again, that is the gap.

---

## 1. The job (from the user, verbatim intent)

Build a browser FPS-RPG in Three.js at **Destiny 2** level for game mechanics and **Final Fantasy XIV** level for the mystical look. Utterly perfect, beautiful, responsive. Three pillars in order: **graphics, performance, game mechanics (smooth)**. Later, after fundamentals are signed off: world bosses with mechanics, quests, story mode with voiced NPCs.

Method the user asked for, which you must keep using:
- Break the game into the **smallest pieces that can be judged on their own** (orchestrator decides the pieces).
- **Fan out sub-agents**, one builder per piece, files strictly owned.
- **A separate fresh-context sub-agent critic inspects the actual running game** — never the builder's summary — and is a really harsh critic.
- Critic does a **blind side-by-side vs the real Destiny 2 / FF14**, says which is better, and when ours loses names **the single biggest gap** and sends the builder back in.
- **No fixed number of rounds.** Loop until every critic is genuinely wowed.
- Between major waves, **one fresh agent plays the whole game** and smooths everything into one coherent thing.
- Keep a **live progress page** the user can watch.
- Use `ultracode` / Workflow orchestration; the user is away, so act, never ask.

Standing constraints (also in `CLAUDE.md`): everything procedural (no asset downloads/CDN/fetch), one owner per file, perf budget, determinism via `core/Noise.js`, `?auto=1` automation must keep working.

---

## 2. Machine (how work actually gets done)

| Thing | Path | What it is |
|---|---|---|
| Game | `src/**` | Vite 8 + three r185 + `postprocessing` 6.39, plain ES modules |
| Contracts + rules | `CLAUDE.md` | architecture, ownership table, conventions, perf budget, world layout, `window.__game` API |
| Builder protocol | `tools/BUILDER.md` | what a builder sub-agent must do |
| Critic protocol | `tools/CRITIC.md` | how a critic inspects + the JSON verdict schema |
| Harness | `tools/inspect.mjs` | Playwright headless Chromium **with the real GPU**, drives the game, saves shots + perf + errors |
| Syntax gate | `tools/check.mjs` | `node --check` every src file + resolve relative imports (run before every harness run) |
| Contact sheet | `tools/sheet.py` | `python tools/sheet.py tools/out/<dir> 3 640` → `sheet.png` to Read |
| Progress page | `progress/state.json` + `tools/progress.mjs` → `progress.html` | live status page, served by Vite |
| Wave workflows | `tools/workflows/*.js` | Workflow scripts (fan-out + critic loop) |

### Dev server (keep it up)
Always runs at `http://127.0.0.1:5173/`. Check: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/`.
Restart if down:
```bash
npx vite --port 5173 --strictPort --host 127.0.0.1 > tools/out/vite.log 2>&1 &
```
The orchestrator also keeps the game open in the Browser pane so it can see it live:
`preview_start {name:"cadle"}` (config in `.claude/launch.json`, attaches, starts nothing), then `navigate` to `http://127.0.0.1:5173/?auto=1&debug=1`, then `computer{action:"screenshot"}` / `read_console_messages` / `javascript_tool`. **The pane must be visible in the app for screenshots to work** — if it returns "Browser pane is not displayed", fall back to `tools/inspect.mjs` screenshots (headless, always works).

### Harness usage
```bash
node tools/inspect.mjs --name tour-w2                      # default tour (24 shots, perf windows)
node tools/inspect.mjs --nolock --name x --steps '[{"wait":5},{"shot":"a"}]'
node tools/inspect.mjs --name x --script file.json --q low --w 1920 --h 1080
```
- Step language is documented in the header of `tools/inspect.mjs`.
- `--nolock` for quick screenshot iteration; **omit it for perf numbers** (mkdir-mutex serialises runs so parallel agents don't skew each other).
- Perf: wait ≥ 5 s after load before a `perfWindow` (shader warmup). `stats().gpuMs` = true GPU ms (timer queries), `stats().systems` = per-system CPU ms EMA.
- GPU flags that make headless use the RTX 3060: `--use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu` (already in the harness). Without them you silently get SwiftShader and useless numbers.

---

## 3. How a wave is run (the pattern to repeat)

One Workflow call fans out one agent per piece; each piece runs `critic → (fix builder → critic)*` until `verdict: "WIN"` or the round cap, all pieces in parallel via `pipeline()`.

- Script lives in `tools/workflows/<wave>.js`, launched with `Workflow({scriptPath: "C:\\Users\\ianca\\Desktop\\FPS3\\tools\\workflows\\<wave>.js"})`.
- **Strip CRLF from the script** (`python -c "s=open(p,newline='').read().replace('\r','')"`) or the permission layer rejects it ("control characters").
- Builders get `COMMON` + a per-piece `brief` + the files they own + the critic JSON from the previous round. Critics get `tools/CRITIC.md` + the same brief and return the verdict JSON (schema in the script).
- Round cap per wave is a knob (`MAX_FIX_ROUNDS`); pieces that come back `LOSE`/`TOSSUP` go into the next wave. There is no global round limit — keep launching waves until every piece is `WIN`.
- **Usage-limit recovery pattern (this happens every wave — the monthly/session limit kills the run ~90 min in):** if critics returned but fix builders died, the next wave goes **fix-first**: embed each piece's full stored verdict JSON as `PREJUDGED` in the script and start with the builder, then a fresh critic (see `tools/workflows/wave4.js` + its generator `scratchpad/wave4-gen.py` pattern). Never re-run critics whose verdicts are already in the journal.
- Watch progress: `/workflows`, or read `~/.claude/projects/C--Users-ianca-Desktop-FPS3/<session>/subagents/workflows/<runId>/journal.jsonl` (one `{"type":"result"}` line per finished agent — the critic JSON is in there even if the workflow itself dies).
- If a wave dies mid-way (usage limit, crash): the source files on disk keep whatever the builders wrote. Do **not** resume blindly — relaunch a critic-first wave (like `tools/workflows/wave1.js` does) so already-built pieces get judged instead of rebuilt.

### Between waves (required by the user)
1. **Integrate**: wire any new system hooks into `window.__game` (`src/main.js`), run `node tools/check.mjs`, run the full tour, fix cross-system breakage.
2. **Coherence agent**: one fresh agent plays the whole game end to end and smooths inconsistencies into one coherent thing — including STYLE coherence: generated assets (ASSETS.md) and procedural art must read as one painterly-realistic look (palette rules in CLAUDE.md style section).
3. Update `progress/state.json` → `node tools/progress.mjs`.
4. Launch the next wave.

---

## 3b. Asset pipeline (NEW 2026-08-20 — user bought Magnific MCP; "no excuse" mandate for AAA look)

- **Magnific MCP** connected (tools `mcp__df0d6b46-...__*`): images_generate (seedream-5-pro default, 100 cr/2k image), audio_sfx_generate (ElevenLabs, ~10-40 cr), audio_music_generate (elevenlabs-music-generation-v2, ~20 cr/s — pricey, use sparingly), models3d_generate (image→GLB, tripo-v31 detailed ≈ 1160 cr), images_remove_background, images_upscale. Check `account_balance` before big batches; started with 45k credits. Flow: generate → `creations_wait` → curl the `url` into `public/assets/...` (tokens expire — download IMMEDIATELY) → update `ASSETS.md`.
- **ToS gotcha**: naming trademarked games ("Final Fantasy XIV") in music prompts = rejection; describe the style instead.
- **`ASSETS.md`** = manifest builders read (paths, usage notes, ASSET ASK protocol). Landed: 10 textures (6 terrain/stone albedos + bark + alpha leaf card + 2 glyph rings, tiling verified), 28 SFX takes, field + night themes, 3 GLBs (handcannon 57k / aetheryte 38k / column 31k tris — decimated from 380k with gltf-transform simplify+quantize; sharp/vips texture-resize is broken on this machine, geometry decimation is what matters). Total payload ~24 MB.
- **`src/core/Assets.js` (orchestrator-owned) preloads everything** as the FIRST system init: parallel fetch, GPU texture pre-upload (`renderer.initTexture`), progress events `assets:progress` for the HUD load bar, null-safe accessors (`game.assets.tex/model/audioBuffer`), measured 2.6 s under full wave load (43/43 assets, 0 errors). Builders must NOT load asset files directly — CLAUDE.md forbids it; keeps one copy + zero mid-game streaming hitches. Prod perf rules (tri/texture/payload budgets, preload-only, style-coherence palette) are now a CLAUDE.md conventions block.
- **`TECHNIQUES.md`** = ranked license-verified open-source three.js techniques from X/GitHub research (N8AO CC0, SimonDev Quick_Grass MIT, three-good-godrays zlib, hex-tiling MIT, octahedral impostors MIT, volumetric clouds MIT, takram atmosphere reference...). Builders follow its STEAL guidance.
- CLAUDE.md conventions updated: generated assets allowed (local-only at runtime, committed to repo, no CDN/external fetch from game code).

## 4. Current state

**Updated: 2026-08-21 (UI + visuals polish wave — branch `claude/game-ui-visuals-polish-26a5fb`).**

Landed in this wave, all verified in the running game:

- **Mountains read as mountains.** Three separate causes, all fixed in `Terrain.js`/`Sky.js`: (1) the ring's crag term
  was *linear* ridged noise — a cosine swell, i.e. a dune — so it is now squared (`teeth`) into face+arete pairs with
  40-70 m of relief, plus a ~310 m `summit` mask so the crest line is peaks-and-cols instead of one bank at a constant
  altitude, and the bedding-plane ledges went from 2-6 m to 4.5-13 m; (2) the out-of-world skirt past ±512 m was
  `Chebyshev distance × 0.3` with the baked EDGE normal clamped flat across it — a smooth four-sided cone, unlit, that
  stood over the ring as the white "elongated slope" in the user's screenshots. It is now a ridged 2-octave value noise
  (222 m / 87 m) with a finite-differenced normal, tuned to top out just under the ring crest; (3) the snow slope gate
  was 0.22-0.46, which draped every 30° back in white — tightened to 0.17-0.42 so snow sits on benches and gullies.
- **Water.** The milky-turquoise pool is gone. Open-water crest foam was laced across ~a third of the lake at any instant
  (threshold 0.30, weight 0.45 → 0.62/0.16); the ripple normal died by ~40 m leaving a flat plastic sheet (detail
  0.13 → 0.36, distance falloff 0.012 → 0.009); absorption/shallow deepened; grazing mip bias trimmed so the far shore
  is a mirror, not mush. **The basin shape mattered as much as the shader**: Mirrormere was a 1.2 m paddling shelf across
  most of its width and no absorption curve makes 1.2 m of water look deep, so the middle now drops to -5.5 (shoreline,
  beach band and lake footprint unchanged; the island bump was raised with the floor so it stays an island).
- **UI.** New `src/ui/settings.js` + a "UI KIT" block in `ui.css`: the beUI (beui.dev/components/motion) component
  vocabulary — segmented tabs with a spring layoutId indicator, spring switches with a press squash, tick-dot range
  sliders, spring-pressed buttons, a centre-morph modal with a blur cross-fade — rebuilt in plain DOM/CSS because the
  game ships no React or motion runtime. **This is the house standard for every menu from here on.** Four tabs
  (Gameplay / Video / Audio / Controls) driving real settings: sensitivity, invert-Y, FOV, camera shake, head bob,
  quality, perf overlay, four audio buses, and a keybind reference. Persisted as one JSON blob under `cadle.settings`
  (old `af.sens`/`af.fov` migrated). HUD v3 on top: reframed vitals vessel, larger ability diamonds with keycaps,
  serif ammo block, card-style toasts/quest tracker, shield rails under health bars instead of over them.
- **Weapons.** `scout` (Pale Verse) and `beam` (Rimecaller) imported from the Aurelen build
  (`C:/Users/ianca/Desktop/FPS`) — the only two archetypes with no counterpart here. Original tuning intent, this
  repo's schema, models rebuilt from scratch in the house language (`models.js`). Both drop: added to `AR_LABEL`
  (`RPG.js`) and the `ARCHETYPES` fallback (`items.js`). `beam` pierces — `Weapons._shoot` now forwards `def.pierce`
  to `combat.hitscan` (verified: one charge shot took 132 off all three golems in a line).
- **Opening quest.** The Vale now gives the marching order (`voice-vale-01b`) as the quest card lands, in her pinned
  voice. Previously she greeted you and went quiet.
- **Tree flicker + frozen-world jitter (gate rule 2) — fixed at the source.** `EZTrees.js` drove its wind clock from
  `performance.now()`, so the canopy kept moving while `game.paused`; the frozen-world probe saw the trees, and only the
  trees, change frame to frame. It now accumulates its own clock that stops with the game. Same pass: the LOD-rebucket
  probe renders in *every* scene pass (including the water's mirrored reflection camera) and now early-outs unless it is
  the main camera; leaves dissolve within ~2.6 m of the eye so backing into a canopy no longer slams black polygons
  across the frame; and the sway patch got a `key` (a keyless `patchMaterial` patch shares the "undefined" program-cache
  slot with every other keyless one). **Result: a paused frame is now bit-identical frame to frame — jitter 0.0 vs the
  2.0 limit, and vs 2.4-3.7 before.**
- **Blob sources closed.** (a) Glowing mushrooms had a near-white cap albedo and an uncapped daylight glow — the albedo
  is real mint now and the emissive carries a hue-preserving luminance cap that tightens in daylight and opens at night.
  (b) `GRASS_LUM_CAP` 0.60 → 0.50: blobcheck's header asserts grass "can never reach" its 212 bar *because of* that cap,
  but 0.60 linear leaves ACES + the FF14 grade at ~220, so pale cream flower heads were tripping the meadow detector.
  0.50 puts it back under the bar (203 over-threshold pixels → 6) and is visually free — frame mean/p99 luminance move
  114.6 → 114.5 and 177.6 → 177.1. (c) Rock albedo peaked near 0.91 (tint 0.80 + a 0.18 quartz speckle), which is not a
  rock; toned to ~0.80 peak.
- **PostFX freezes with the game.** Eye adaptation and film grain both animated independently of the world clock, so a
  paused frame kept changing. Both now hold while `game.paused` — correct for the gate and for a pause menu that should
  not crawl or brighten.

### Gate status at merge

`node tools/gate.mjs` — **invariants PASS, jitter PASS (0.0 at both qualities, was 2.4-3.7), pointer lock PASS
(engage + re-acquire), blobcheck FAIL on 24 lines, every one of them a 10-16 px speck.**

For comparison, the same gate on the base commit (`1c02cfc`, this branch stashed, same box, same server): jitter FAIL
3.057, blobcheck FAIL with 140+ lines including 29-37-cluster frames. So every blob source with a real cause was
found and closed — glowing mushrooms, the grass luminance cap being above the detector's bar after the grade, 0.91
albedo boulders, lantern flames, wisp glow tone-mapping to near-white at night. What is left is at the detector's
noise floor: single 10-16 px clusters of sunlit grass-blade edge and one distant point of aether glow at 23:00.
Pushing those under 212 sRGB means darkening the meadow or turning off night glow, so they are **left deliberately**
and flagged here rather than tuned away. **A merge on a red gate is a decision, and this is the decision that was
made** — if the next wave wants a green gate, the honest lever is `tools/blobcheck.py`'s `MIN_AREA`/`LUM_BRIGHT`
(orchestrator-owned), not more grade-flattening.

> **SUPERSEDED 2026-08-22 (see §0).** The gate is green at both qualities now, and the lever turned out to be
> neither the grade nor the brightness bar: the detector was missing the SHAPE and the CONTEXT of a blob. It now
> gets a per-burst classification mask from the renderer (ground cover / geometry / atmosphere) and applies the
> strict rule only to ground cover, plus two shape rules. `--selftest` proves it still catches painted blobs.
> Chasing this also found two genuine bugs the old detector was drowning in its own noise: wisps reading as white
> orbs, and every impact preset starting from a pure-white core.

### Known issues / next fixes (this wave)

1. ~~**`tools/gate.mjs` hardcodes `http://127.0.0.1:5173`.**~~ DONE 2026-08-22: both `gate.mjs` and `inspect.mjs`
   honour `CADLE_URL`, so a worktree can be gated on its own port.
2. ~~**`tools/blobcheck.py`'s calibration note is stale**~~ DONE 2026-08-22: the note now says what was measured
   (a sunlit blade edge arrives at 214-218, so the bar alone cannot separate it from a blob), and `MIN_THICK`
   handles the "one sunlit blade edge counts as a blob" case by shape instead of by brightness.
3. **The q=high gate harness run intermittently exceeds its 600 s timeout** on a contended box (it did on the baseline
   run twice). A timeout kills the run with no `report.json`, which reads as a gate failure rather than "not measured".
4. **Perf A/B was inconclusive**, not negative. Alternating before/after tours on this box varied as much between two
   runs of the *same* code (60 → 32 fps) as between versions; the deterministic counters were flat (draw calls
   130/130 meadow, 193/202 ruins). Per-system cost was not moved by design: every change is constants, one extra
   `fbm2` inside the mountain-ring branch of `heightAt` (async bake only), and a few vertex-shader instructions on
   out-of-world skirt vertices. Re-measure on a quiet machine before trusting any number.
5. **`beam` pierces without falloff** — the Aurelen original had `pierceFalloff: 0.75`; `Combat.hitscan`'s `pierce` is a
   boolean, so all targets in the line take full damage. Add per-hit attenuation to `Combat` if it plays too strong.
6. **No generated gunshot takes for the two new archetypes.** ASSET ASK: `shot-scout-{1..4}.mp3`,
   `shot-beam-{1..4}.mp3`. They run on the synth recipes in `sfx.js` until then.
7. **Impostor tier swap is still a hard pop** at the 190 m boundary (rebucketed every 6 m of camera movement, no
   crossfade). Visible if you watch for it; a dither crossfade over a ~15 m band is the fix.
8. **beUI coverage is only what the settings menu needed.** Toasts, the pause modal and the tabs are on the kit; the
   RPG screens (`Screens.js`, `rpgscreens.js`, `mapscreen.js`) still use the older parchment language and should be
   migrated to the same tokens next.

*(previous state below)*

**Updated: 2026-08-20 (blob/pointer-lock fix + guardrail hardening PR).**

- **Fifth blob recurrence fixed at the source (fresh clone was visibly broken; gate failed).** Live causes found by bisection + gate screenshots: (1) three r185 gives GLSL3 `ShaderMaterial`s NO `gl_FragColor` alias — both cloud shaders in Sky.js failed to compile (console shader errors, no clouds; this was also the q=high frozen-jitter breach — after the fix, frozen diff is ~0.8 vs the 2.0 limit, all remaining variation is film grain); (2) the vfx `trail` preset wisps drag across the meadow 24/7 was WHITE at hdr 2.5 → drifting white/purple flashing streaks; (3) viewmodel `white` sight emissive 2.2 + glossy gold/brass (roughness 0.22-0.3, envMap 1.6) → permanent white/warm glints in every frame; (4) lantern flames emissive 4.0 → sub-pixel warm blobs; (5) sunlit grass silvering × translucency could cross the 1.05 day bloom threshold field-wide. Fixes: Sky GLSL3 `out` vars; trail saturated + hdr 1.1; sights 0.9 / metals roughness ≥ 0.35; flames 1.4; and the structural one — **`GRASS_LUM_CAP` in Grass.js: the final outgoing luminance of grass is hue-preserving-capped at 0.60**, closing every current and future term at once (see CLAUDE.md architectural law).
- **Guardrails now enforce themselves**: `tools/invariants.mjs` extended (pointer-lock hookup + synthetic guard, grass cap, vfx/enemy/viewmodel/prop ceilings, bloom/exposure pins — every rule injection-tested to fail when its bug is reintroduced), CI runs it + `check.mjs` on every push/PR (`.github/workflows/checks.yml`), and `.claude/settings.json` runs it as a Stop hook after every agent turn. `tools/blobcheck.py` fixed: no more diffing across burst/hour boundaries, FLASH requires the spiking pixel to reach glowing (wind motion no longer false-positives), thin horizon/water strips are not "blobs" (compactness), dead-black frames fail loudly. `tools/gate-steps.json` gained a dawn burst (threshold mid-lerp, backlit — worst case).

*(previous state below)*

- **Wave 1**: builders landed ~9.1k lines across 15 systems; usage limit killed the critics.
- **Wave 1b** (`wf_6614cf46-d1b`, dead): critic-first on 16 pieces. **All 15 critics returned verdicts** (journal: `.claude/projects/.../3bf2ab25-.../subagents/workflows/wf_6614cf46-d1b/journal.jsonl`): **12 LOSE / 3 TOSSUP / 0 WIN** (movement 8.2, combat 7.5, lighting 6.5 TOSSUP; terrain/water/enemies 4.5 worst). The 16 fix builders launched, then the **usage limit killed 14 of them mid-flight**; only camera (full recoil/bob/flinch fix pass) and HUD (built fresh, never judged) completed. Files on disk may contain partial fix-round edits — `check.mjs` passes, game boots clean.
- **Wave 2** (`wf_022db421-f2d`, dead — usage limit killed 27/40 agents): 13 critics returned — combat 5.5, lighting 6, water 6, vegetation 6, abilities 4.5, grass 7 TOSSUP, vfx 5, enemies 4, camera 7 TOSSUP, terrain 4.5, audio 6, movement 8.2 TOSSUP; sky critic returned empty (no StructuredOutput), postfx/weapons/hud critics killed. Several fix builders completed mid-wave (grass clipmap rewrite, enemies standoff defs, weapons hands.js, TAAPass) — judged fresh in wave 3.
- **Wave 3** (`wf_e7ac807f-e3c`, dead at 13/42 — usage limit again): 13 fresh verdicts, **scores climbing every wave** (avg ~5.2 → ~6.5): combat 8 (occlusion fixed), movement 8.3, camera 8, grass 7.3, water 7.2 (all TOSSUP — one gap from WIN each); terrain 5.5 (textures landed, shape still soft-serve), enemies 6 (standoff landed but overtuned — no melee pressure), vegetation 5.5, weapons 6 (hands exist, reloads frozen), vfx 6, audio 6 (mp3 takes STILL unwired — builder killed), postfx 6 (god-ray stipple, AO halos), sky 4 (REGRESSED — cloud rewrite = conical spike fence; night package praised). lighting/abilities/hud critics died.
- **Wave 4** (`wf_cd5c7899-156`) — **died with 0/29 agents completed** (Fable 5 model limit hit immediately). No fixes landed; nothing lost. The session model was then switched to Opus 5.
- **Wave 5 — running now** (`tools/workflows/wave5.js`, run id `wf_c90dc398-1cd`, task `w9vimwmui`): same fix-first design as wave 4 (stored wave-3 verdicts embedded as `PREJUDGED`), plus: every builder must pass `node tools/gate.mjs` before reporting done, every critic runs the gate and cannot award WIN if it fails, the postfx brief carries the verified TAA non-convergence diagnosis, and the grass brief carries the q=low blob report.
- **GitHub backup live**: `https://github.com/Humpalumps/FPS-RPG` (branch `main`). Revert points: `v0.1.0-stable` (baseline), **`v0.1.1-stable` (baseline + regression gate + pointer-lock fix — use this one)**. Commit between waves; git is orchestrator-only (CLAUDE.md forbids agents from touching it).
- *(previous)* Wave 4 design notes: **fix-first** — the 13 judged pieces start at their builder with the full stored wave-3 verdict (`PREJUDGED` map embedded in the script), then a fresh critic; lighting/abilities/hud go critic-first. Briefs carry targeted direction (sky: rounded fbm masses + blue-noise jitter per TECHNIQUES.md #8, never cone extrusion; enemies: tighten hound band for real melee pressure; audio: wiring the mp3 takes is mandatory; vegetation: use leaf_card/bark/column/aetheryte assets).
- Orchestrator fixes landed earlier: Player.js pre-shield damage event; grass tip roughness decree; wisp glow/meadow decree (see §5b + CLAUDE.md decree block).
- Game state at last verify: 0 errors, blob-free meadow at 15h/17.5h. p99 was 16.4 ms vs 14 budget; builders carry perf gates.
- Not started (later waves): RPG stats/loot/inventory, quests + voiced NPCs (Magnific audio_tts can voice them now), world bosses, story mode.

## 4b. The cinematic loading screen / landing page (2026-08-22)

The front door of the site. A young man sits at his computer in a dark bedroom at night; **his monitor is
showing the game's own start screen** (wordmark + subtitle + load bar, composited over the live game world
as the menu backdrop, the way a real title screen is). When the world has finished building the prompt
becomes "CLICK TO ENTER THE VALE"; the player clicks, **he is pulled head-first into the monitor**, the
camera follows him through the glass, a violet flash covers the handover, and the game starts.

| file | owner | what |
|---|---|---|
| `src/ui/Intro.js` | orchestrator | renderer/composer, the start-screen canvas, the DOM load bar, the transition, the handover |
| `src/ui/intro/stage.js` | orchestrator | scene assembly, ALL lights, camera path, the suck-in transform, the intro texture loader |
| `src/ui/intro/room.js` | intro-room builder | bedroom, desk, monitor hardware, props, posters, fairy lights |
| `src/ui/intro/character.js` | intro-character builder | the seated guy + his gaming chair, idle animation, `setSuck(k)` acting |
| `intro.html` | orchestrator | dev-only standalone preview of the stage (`?noroom=1 ?nochar=1 ?char=b ?seed=N`) |
| `public/assets/intro/` | orchestrator | 1.6 MB: the texture set + `guy.glb`, the generated seated character (see ASSETS.md) |
| `docs/intro-ref/` | orchestrator | the art references builders are judged against (not shipped) |

**Things that are load-bearing — do not undo them:**
- It shares the GAME's renderer and canvas. That is what lets the monitor show a real render of the world
  (`Game.stepInto(dt, target, systems)` draws the world into a render target). Two consequences:
  (1) `Lighting.js` sets `renderer.shadowMap.autoUpdate = false`, so the intro sets `shadowMap.needsUpdate = true`
  every frame or its own shadow maps never render and **the whole room goes black**;
  (2) the intro must restore `toneMapping` / `shadowMap.enabled` / `setRenderTarget(null)` on teardown.
- The transition timeline runs on **wall clock**, not accumulated `dt`. Impostor baking can still be hogging
  the thread when the player clicks; a dt-driven timeline turns the 2 s dive into 5 s of slow motion.
- `#introui` is `pointer-events: none` with its click listener on `window`, so the canvas's own
  `mousedown -> Input.lock` path still runs. A full-screen div that swallowed the click broke the gate's
  "pointer lock re-acquires after exit" leg.
- `Input.lock` now remembers a refused `unadjustedMovement` and asks plain from then on. The refusal is
  asynchronous, so the fallback request landed outside the click's transient activation and Chrome answered
  "a user gesture is required". That was the real cause of flaky re-lock.
- `?auto=1` skips the intro entirely — the harness and every critic see exactly what they saw before.
  `?auto=1&intro=1` runs it and auto-plays 4 s after arming; add `&introhold=1` to hold it for screenshots
  (needs `node tools/inspect.mjs --noready`, since the game loop only starts after the transition).
  `__game.intro.seek(t)` freezes the transition at an absolute time — that is how you review the dive.
- The intro loads its own textures from `public/assets/intro/` (the ONE documented exception to
  "everything through `game.assets`"): it is on screen while `game.assets` is still preloading 29 MB.
- **LOAD ORDER: `main.js` does NOT statically import `Game.js`.** `Game`'s import graph is the whole game
  (~239 KB gz on its own chunk); importing it at the top meant nothing could paint until all of it had
  downloaded — in production that was the page sitting dark while the tab title counted to 40%. `main.js`
  now builds the renderer itself (`createRenderer`), puts the intro on screen with it, and only then
  `await import('./core/Game.js')`, passing the renderer in via `opts.renderer`. `Intro` therefore takes a
  minimal `{ canvas, renderer, seed, auto, params }` host at construction and gets the real Game later via
  `intro.attach(game)`; anything in `Intro` that runs before `arm()` must not assume `game.input` exists.
  The intro's own assets are `<link rel="preload">`ed from index.html so they fetch in parallel with the JS.
- **TIME TO FIRST FRAME is compile-bound, not download-bound.** Measured on a production build: assets are
  all in by ~0.7 s, but the first `render()` used to take ~6.8 s because it compiled every material in the
  room AND the whole post-processing chain in one blocking call. Two things keep it down and both must
  stay: (a) the `EffectComposer` is built in `_buildComposer()` two frames AFTER the room is on screen —
  the early frames render plain with renderer-side ACES; (b) `stage.setLightsFull(false)` paints the first
  frame against a cheap rig (spot + warm rim + hemisphere) and the rect-area light, moon and prop points
  switch on a frame later. Every material compiles against NUM_*_LIGHTS, so the full rig is a much bigger
  permutation. Net: first frame 7.2 s -> 2.0 s. If you add lights or effects, re-measure — the marks are
  logged as `[intro] boot ms:` from `Intro._boot`.
- Preload hints only work if the credentials mode matches the eventual request. three's `TextureLoader`
  sets `img.crossOrigin='anonymous'`, so the image preloads need `crossorigin`; `as="fetch"` is always
  CORS-mode, so `guy.glb` is preloaded with `crossorigin` and fetched with `credentials: 'omit'`. Get this
  wrong and the browser silently downloads every asset twice — check the console for "preload ... not
  used because the request credentials mode does not match".
- **The character is a generated GLB** (`public/assets/intro/guy.glb`), not the procedural body. The
  procedural one in `character.js` is the fallback and still supplies the chair. The GLB is NOT awaited: it
  streams in and fades up. Placement lives in `GUY_FIT` in `stage.js`; tune it live with
  `__intro.stage.fitGuy({height, x, y, z, rotY})` on `intro.html` and paste the result back into the const.

**Gate status at the time this landed (2026-08-22):** jitter PASS at q=high and q=low (≈0.05, effectively
zero), pointer lock PASS (engage + re-acquire). `blobcheck` FAILS — **pre-existing on `main`, not from the
intro**: two independent baseline runs of `tools/gate-steps.json` against the unmodified main checkout on
:5173 produce the identical signature (8 findings on `burst-blob-dawn-*`, 4 on `burst-blob-pop13a-*`) — the
dawn sun/sky seen through the tree canopy at the top of frame. That needs an owner (sky/vegetation/postfx),
but it is not the loading screen. Reproduce with:
`node tools/inspect.mjs --nolock --name basemain-low --q low --script tools/gate-steps.json --url http://127.0.0.1:5173/`
then `python tools/blobcheck.py tools/out/basemain-low burst-blob-`.

## 4c. The terrain bake worker (2026-08-22)

`src/world/Terrain.js` used to build its bake worker by stringifying its own functions into a Blob. That
works in dev and **dies in every minified build** — the minifier renames the bindings but the template
strings still contain the literal identifiers, so the worker threw `ReferenceError: noise2 is not defined`,
`_bakeAsync`'s `fallback` caught it, and the game silently baked the whole terrain **on the main thread**.
Measured on a production build: **22 rendered frames in 17.6 s of boot before, 507 in 12.2 s after.**

The bake math now lives in `src/world/terrainKernel.js` (no `three` import, so the worker chunk stays
engine-free) and `src/world/terrainWorker.js` imports it; `Terrain.js` creates the workers with
`new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' })` and hangs the kernel's
`heightAt` on `Terrain.prototype` so there is still exactly ONE height field for the game and the bake.
`tools/invariants.mjs` (a2) now fails if anyone string-builds a worker again, if the module-worker form is
lost, if the kernel imports three, or if the `heightAt` wiring goes.

**The general lesson, which applies beyond terrain:** anything that ships `Function.prototype.toString()`
into a Blob worker is a landmine — it works in dev, degrades silently in production, and the only symptom
is a `console.warn` nobody reads. Let the bundler resolve names; never hand-write identifiers into a
worker source string.

Regression guard: `terrain.heightAt` is ground truth for the whole game. Before touching the kernel, snapshot it:
`node tools/inspect.mjs --nolock --name heightcheck --steps '[{"wait":20},{"eval":"(()=>{const t=window.__game.game.terrain;let s=0,n=0;for(let i=-1000;i<=1000;i+=37)for(let j=-1000;j<=1000;j+=41){s+=t.heightAt(i,j);n++;}return JSON.stringify({n,sum:+s.toFixed(6)});})()"}]'`
Seed 1337 must give `{"n":2695,"sum":164490.108949}`.

## 5. Next actions (in order)

**The live to-do is §0 "OUTSTANDING — start here".** Everything below §0 is a dated log of previous waves: read it
for WHY something is the way it is, not for what to do next. (The old entries here — a wave-3 workflow id and an
asset batch — completed long ago and were removed 2026-08-22 so nobody chases them.)

1. Work §0's OUTSTANDING list, verification items first (nothing there has been confirmed on a headed browser).
2. **IN FLIGHT ELSEWHERE — do not duplicate, and expect conflicts.** A parallel session is building the cinematic
   loading screen / landing page (a bedroom scene whose monitor shows the real start screen, then the camera dives
   through the glass into the game). As of 2026-08-22 it is **uncommitted** in the worktree
   `.claude/worktrees/recursing-moser-26d7ce` — new `src/ui/Intro.js`, `src/ui/intro/*`, `intro.html`,
   `public/assets/intro/`, plus edits to `src/core/Game.js`, `src/core/Input.js`, `src/main.js`, `tools/inspect.mjs`,
   `tools/gate.mjs`, `vite.config.js`, `CLAUDE.md`, `ASSETS.md`. **Five of those files also changed in §0's commits**
   (main.js, inspect.mjs, gate.mjs, vite.config.js, CLAUDE.md), so that branch needs a rebase onto `main` before it
   can land, and its own HANDOVER section (§4b, written against the pre-§0 file) says blobcheck fails as a
   pre-existing issue — that is no longer true, see §0.
3. Between waves: update progress/state.json + shots, run check.mjs + the full tour, coherence agent, then next wave.
4. Only once graphics/perf/mechanics are all WIN: world bosses → quests/NPC voice (audio_tts) → story mode.

## 5b. User decrees (2026-08-20, from watching the live game — enforce in every wave, tell every builder/critic)

- **No sparkly white blobs in the meadow, ever.** (Also pinned as a USER DECREE at the top of CLAUDE.md — critics must auto-LOSE any piece whose screenshots show washed-white blobs.) Diagnosed live, three stacked causes: (a) wisp glow parts white-clipping through ACES + 3 spawn wisps perma-aggroing the idle player (bolt trail/impact vfx rain), (b) grass flower-head emissive, and (c) **the persistent one: grass glossy tips** — `roughnessFactor mix(0.78, 0.35, v²)` threw drifting, gust-flashing white specular glints across the whole meadow (immune to every object toggle; confirmed by hiding the grass material — the user spotted it first). Fixes landed by orchestrator (keep, refine, never revert): tip roughness → `mix(0.82, 0.62, v²)` (Grass.js — survived the grass builder's clipmap rewrite), flowers matte (Grass.js), wisp `glow` 2.6→1.1 / `rim` 1.0→0.6 (defs.js), meadow camp → 2 wisps @48-64 m (Enemies.js). Verified clean at hour 15 + 17.5 from spawn after the rewrite. Watch every grass builder round for regressions — the wave-2 grass critic explicitly asked for MORE backlight sheen (gap 1), which is how this reappears.
- Grass sparkles in general are out: no glowing/emissive flower heads by day; night magic = subtle colored lift, not bright points.

## 5c. Regression gate + the jitter/blob/pointer-lock decrees (2026-08-20)

`node tools/gate.mjs` (orchestrator-owned; CLAUDE.md makes it mandatory for builders, and any failure = automatic LOSE for critics). It runs the blob+jitter screenshot suite at **both q=high and q=low** (blobs have shipped at low while high looked clean) plus a real pointer-lock session:
1. **White blobs** — `tools/gate.py` finds connected clusters of near-white pixels (min channel ≥ 232) on meadow shots at 13/15/17.5 h, both with enemies present and cleared. Colored glows pass; washed-white ones fail.
2. **Jitter** — the ONLY valid measurement is with **`game.paused = true`** (world frozen, rendering still running). A static-camera diff is useless: wind/clouds/water make q=low and q=high look equally "jittery" (~5-9). Frozen, the signal is clean: q=low sits flat at ~1.15 (film grain only) while q=high drifted 1.17 → 3.21 and kept climbing. **Diagnosis: the TAA pass is not converging at q=high** (PostFX.js, postfx builder's file — do not let another agent "fix" it elsewhere). It is INTERMITTENT: a later gate run measured 1.5-1.7 with no ramp, so a single passing run does not clear it. The gate fails on either an absolute breach (> 2.0) or a ramping trend.
3. **Pointer lock** — real click-to-start session (no `auto=1`): lock must engage on click AND re-acquire after `exitPointerLock` + click. `Input.lock(canvas)` (static, in `src/core/Input.js`) is now the ONE lock path — it catches `unadjustedMovement` rejection (some mice/drivers reject the promise, which is how the mouse kept escaping) and retries after Chrome's ~1.3 s relock cooldown. HUD start/resume calls it too.

Gotcha found while building it: `PostFX.update()` re-applies `enabled` from `this.q.*` every frame, so runtime `pass.enabled = false` toggles are silently reverted — bisect via `postfx.q.taa/ao/godrays` instead.

## 5d. Why the blob / mouse bugs kept coming back — and the mechanism that stops them (2026-08-20)

**Root cause was structural, not a bad tune.** Each recurrence had a DIFFERENT source (flower-head emissive -> wisp glow -> grass tip specular -> grass rim emissive), because two forces kept regenerating it:
1. *The critic loop rewards glow.* Critics legitimately ask for "backlit sheen", "low-sun rim", "readable flowers", "the field goes black at golden hour". Builders satisfy that the easy way: add emissive. On sub-pixel geometry that is the bug.
2. *Prose rules are followed literally.* A decree naming flowers and roughness did not stop a builder adding a brand-new emissive rim path.

**The physics:** a blade is smaller than a pixel at distance, so any value that can reach the bloom threshold (~1.2) flickers on/off as wind and camera move; bloom smears each flicker into a floating ball. A RELATIVE clamp (`min(x, col*0.75)`) does not fix it - a bright blade colour raises the ceiling too. Hence an ABSOLUTE ceiling.

**Mechanism now in place (three layers, in order of strength):**
- `node tools/invariants.mjs` - source greps, ~1 s, no server: single pointer-lock path (`Input.lock`), grass absolute emissive ceiling <= 0.25, grass tip roughness >= 0.6. **Verified by injecting both regressions: it catches them with the exact reason, and passes when restored.** This is the layer that survives contention and busy waves.
- `tools/blobcheck.py` - blob detection rewritten: ANY hue (the old test was near-white only, so blue aether blobs walked through) and TEMPORAL flash detection across bursts (the old test used single shots, so flashing blobs appeared between frames). Gate now captures 8-frame bursts at 13/15/17.5/23 h, standing and walking, enemies present and cleared.
- CLAUDE.md **architectural law**: ground cover is never emissive; rim/backlight goes in `reflectedLight.directDiffuse` (respects exposure, cannot bloom). Critics are told that asking for more glow on ground cover is asking for the bug back.

Same shape for pointer lock: the fix decayed whenever a builder wrote their own `requestPointerLock` (which can REJECT with `unadjustedMovement`, and which Chrome blocks for ~1.3 s after an exit). Now there is one path, and the invariant check fails the build if anything else calls it.

## 6. Gotchas learned the hard way

- **Bash heredocs > ~5 KB fail on this machine** (`unexpected EOF`). Use the Write tool for anything long; heredocs only for short files.
- `renderer.info` must be reset per frame (`autoReset = false` + `info.reset()` in `Perf.begin`) or draw-call/tri counts are garbage.
- postprocessing's `EffectComposer.addPass(pass, index)` is the supported way to insert the viewmodel overlay passes; splicing `composer.passes` skips initialisation.
- Critics/builders must **look at the PNGs**, not just read the report — a build can be error-free and still look like programmer art.
- Never let two agents own the same file. Cross-system needs go in the report as an ask; the orchestrator wires them.
