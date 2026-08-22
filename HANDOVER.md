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

## 2. THE BIOMES — pass 1 done (2026-08-23), what is left

The world is ten regions (`src/world/Biomes.js` is the single source of truth; `CLAUDE.md` has the map). The
border crossings, per-region music, zone cards and per-region furniture landed earlier. **This pass went
through all ten and made each one look like the place it is named after.** Every region below was
re-screenshotted from inside itself on the final code (`tools/out/fin-<region>/`, 3 shots each: looking at
the landmark, 90 deg off it, and straight down at the floor).

### The single biggest thing this pass found: the pass roads were 100 m wide

`Terrain.roadAt` measured the road's width in RADIANS (`ss(0.10, 0.022, da)`), so the tree/prop exclusion
was a WEDGE: 24 m across at the mountain feet and **61 m across at a region's heart**. Every outer region
had a bald corridor driven through the middle of it, and — because `__game.goto(id, back)` drops you on the
region's bearing — every screenshot anyone had ever taken of a region heart was taken standing in that
corridor. That is why the Whisperwood looked like "a lawn with a treeline round it": the trees were there,
you were just standing in the clearing. `roadAt` now measures **metres off the centre line**
(`ss(13.0, 3.5, arc)`), so a pass is a 7 m trail with a shoulder. **When you screenshot a region, teleport
PERPENDICULAR to its bearing (see `tools/scripts/fin/*.json`) — on the bearing you are on the road.**

### Three new pieces of machinery, all per-region data in `Biomes.js`

- **`fogLum`** (Sky._gradeFog) — a haze BRIGHTNESS scale. Hue-only grading keeps the sky's luminance, which
  is right for clear air and wrong for smoke: at midday a hue-only Infernal was a bright cream-orange
  desert. Set only where the air is genuinely darker than the sky (infernal 0.26, shadowfen 0.42, forest
  0.66, void 0.62). Default 1 = the old behaviour.
- **`skyVeil`** 0..1 (Sky's DOME_FRAG `uVeil`) — how much of that air reaches the SKY DOME. A clean blue
  noon dome over the Wastes and the fen was the loudest remaining "tinted meadow" cue. Eases both ways
  (including on `_gradeFog`'s early-out, or it sticks over the Vale).
- **Grass VALUE follows the floor** (Grass.js) — the hue coupling gave every region the Vale's brightness,
  so a forest floor and a peat bog both came out as a mown lawn. `pow(tLum / 0.133, 1.15)` clamped to
  [0.34, 1.12]; 0.133 is the measured mean luminance of `terrain.colorAt` in the spawn meadow, so the Vale
  lands on exactly 1.0 and is untouched.

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
- DONE: the road fix put the trees back around you; grass 0.85 -> 0.40 and the floor layer darkened to a
  shade-green (tint 0.42/0.60/0.50); `Props.KIT.forest` now builds **fern clumps** and **elven ruins going
  under the moss** (stair blocks, jambs, fallen lintels) at n 340; fae fungus scattered through the region
  (it only ever reached the home-bowl treeline before); `gv` 0.62 -> 0.72 with `p` 0.52 -> 0.45, which
  closes the grove holes at the SAME total tree count (looking south out of the Whisperwood is the heaviest
  view in the world — see §4d).
- gap: the canopy still lets a lot of sky through, so there are no real light shafts (godrays need the
  canopy to occlude); the floor is still fairly bright green in full sun.

**❄️ Frostveil Tundra — the frozen forest.** Reference: **Winterspring**. Not an empty steppe: it is a CONIFER
FOREST buried in snow. Blue-white everything, pines with snow on the boughs, frozen lakes with cracked ice you
can walk out onto, ice formations, icicles, a permanent aurora at night.
- trees: **YES — frosted pines**, dense [p 0.34, gv 0.36, needles tinted 0.74/0.88/1.06, never summer green].
- ground: glacier ice and packed snow [layer 9], almost no grass [0.03]. Ice shards are the crystal here —
  tall and thin [BSPIRE 0.100, aspect 0.60/1.60], pale blue, NOT the meadow's violet aether.
- rock: frost-bleached boulders, wind-carved drifts.
- have: dense frosted conifers, ice shards, drifts, frozen boulders, aurora, bright snow-bounce [amb 1.2].
- DONE: the frozen lake exists now — `bhTundra` mixed its basin to 5.2, which is 1.2 m ABOVE
  `terrain.waterLevel`, so Winterspring's signature was a dry dish; 3.35 puts ~0.65 m of ice-cold water
  over it. Pressure-ice pillars hung with **icicles** added to the kit. Needles re-tinted 1.02/1.22/1.52 —
  the old 0.74/0.88/1.06 multiplied an already-dark pine and read as summer green.
- NOT a gap: falling snow already exists (`VFX.WEATHER.tundra`, ~48/s). The old note was stale.
- gap: still the tightest tri budget in the world — check Frostveil first after ANY tree change.

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
- DONE, terrain shape first: `bhInfernal` used to put a 150 m-radius, 98 m-tall cone with a 62 m caldera on
  the region centre, so the heart was one smooth red dome. It is now a low **basalt plain of tilted plates**
  (fbm quantised with a cubic riser -> flat tops meeting at 2-3 m fault scarps) cut by wider, longer lava
  channels, with **three cinder cones off to the sides** as a skyline and a low vent rampart framing the
  Cinder Maw. Also: key light 0xff8a3c -> 0xffd2b0 (the old key is linear (1.00, 0.25, 0.05) — it multiplies
  almost all the green and blue out of whatever it touches, so charcoal rendered as saturated (80, 11, 17)
  RED); fissure emissive band tightened from 0.075..0.025 to 0.045..0.012 with a macro gate (measured
  against ash.jpg's luma histogram: the old band lit ~10% of a 3.2 m tile = a glowing NET over every square
  metre); `fogLum` 0.26 + `skyVeil` 0.72 for a real smoke ceiling; lava contact now throws EMBERS
  (`'sparks'`) instead of the star-textured `'aether-burst'`.
- gap: the rock reads dark warm brown rather than true black basalt. Going blacker needs the ash albedo
  itself, not more tinting.

**✨ Celestial Isles — the divine high plateau.** Sun-warmed white marble and gold, ruined colonnades and
arches, islands floating in gold light with updrafts between them, wordless-choir calm. Everything here is
stone and light; nothing here is woodland.
- trees: **NONE** [p 0]. What replaces them: **broken architecture** — fallen column drums, stubs on plinths,
  arch fragments. Crystals: **none** — the glow here is gilded stone and light, not aether shards.
- ground: veined marble flagstone [layer 6], a trace of pale grass in the cracks [0.05]. The brightest light
  in the world [amb 1.45] through the thinnest haze [fogMul 0.60].
- have: marble and gold ground, the colonnade kit, floating isles with hanging keels, updraft columns.
- DONE: the ground is marble instead of sand — `celestial_marble.jpg` is TAN (linear ratio 1 : 0.85 : 0.61)
  and the old warm tint pushed it further, which is why the Isles rendered as a beige desert; the tint now
  INVERTS the asset's hue (0.98/1.14/1.46). Each isle carries a **peristyle** (half of it fallen) and the
  big one an **altar on a stepped dais**; the void isles carry snapped pillars and orbiting rubble. Bridge
  spans got **kerbs and posts** so they read as bridges edge-on, not planks. A **gilded standard** was added
  to the ground kit (n 150 -> 260) — the gold the region is described by and never had.
- gap: the isles still read as brown discs / hats from below. The tint was raised twice with no visible
  change, so it is the SHAPE (a flat dome plus a keel) and/or `stoneMat`'s sand map, not the vertex colour —
  they want to be modelled as layered rock with a stepped underside. The plain also still reads empty from
  the middle: the colonnade kit is scattered, and it wants to be clustered into a plaza you walk to. Night
  not re-checked this pass.

**🏔️ Dragon Peaks — the high mountain.** 200 m fangs of rock, ledges with dragon nests, a dwarven gate cut
into the mountain, the bones of whatever the dragons ate, wind and drums. Alpine, not forested.
- trees: **a few dark alpine pines on the LOWER ledges only** [p 0.10, tint 0.70/0.78/0.68].
- ground: bare strata rock [layer 3], almost no grass [0.07]. Crystals: **none** — broken mountain quartz at
  most. This is not an aether region.
- have: the peaks, the gate, nest ledges, ribcages, scorched rock fangs.
- DONE: it is alpine granite now, not a sandstone mesa. Two things did it: the key went 0xffe8c8 ->
  0xf0eeee (a warm key on warm strata was most of the problem) and the floor tint went cool
  (0.84/0.88/1.02, cov 0.60 -> 0.88). `rockCut` stays LOW (0.12) ON PURPOSE — the triplanar cliff is the
  only layer with real crag detail, and cutting it (tried at 0.55) replaced the faces with a top-projected
  texture that smears into sand dunes on a slope. Kit (n 130 -> 210) gained **dwarven gold-ore workings**
  (the accent that catches the eye) and **nests with eggs in them**.
- gap: the nests are scenery, not an encounter, and there is still no loot for climbing.

**🏰 The Lost Realm — where every magic meets.** Endgame. A violet flagstone plain, a rampart ring, sixteen
monoliths, standing-stone circles, arcane shards, ceremonial light. Ruined and deliberate, not natural.
- trees: **NONE** [p 0] — standing stones instead. Crystals: **YES, arcane shards** [BSPIRE 0.055]. One of the
  only four regions where a crystal is the honest answer, because this is where magic collects.
- ground: worn violet flagstone [layer 6, tinted], trace grass [0.05], a wide pale-violet haze.
- have: the flagstone, 16 monoliths, stone rings, arcane shards.
- DONE (look only): the key went 0xffe0ff -> 0xfff2f8 and the floor tint went properly violet
  (0.56/0.62/1.42, same tan asset as the Isles, so it needs the same blue lift). It was a pink light on pink
  ground under a pink haze and the whole region read as candy.
- gap: the flagstone still reads pale lilac dust rather than worn violet stone — it wants to go darker. And
  it is still an endgame zone with no endgame content; the level band 40-50 is declared but never validated.

**🌑 Shadowfen — the cursed swamp.** Knee-deep peat water you wade through, dead drowned wood, reeds taller
than you, hanging moss, witchlight in the dark, and things that used to be people. Choked, sunk, green-black.
- trees: **YES but all DEAD or drowned** — bare wood and willows, sickly olive [p 0.32, tint 0.62/0.74/0.42].
- ground: wet peat muck [layer 10]. The ground cover is reeds, not lawn [0.22, cut from 0.55]. Crystals:
  **none** — the witchlight here should be glowing FUNGUS, not a shard.
- liquid: standing water everywhere, and wading slows you (the region's passive). The thickest haze in the
  world [fogMul 2.4] under a dim sickly key [sun 0xa8c090, amb 0.7].
- have: peat murk, dead wood and willows, reed clumps, rotted stumps, wading.
- DONE, and this is the biggest single change after Infernal: `bhShadowfen`'s flats sat at 3.05 with
  `waterLevel` 4, i.e. under 0.95 m of water, and the hummocks were most of the surface — so from anywhere
  but the middle it was a damp green WOOD. 2.45 puts the flats knee-to-thigh deep and leaves the hummocks as
  the only dry ground, which is the region's whole passive. Plus: grass 0.22 -> 0.12 (at 0.22 a quarter of
  the blades still survive at full height), floor tinted to olive-black peat, key 0xa8c090 -> 0x9ab488 and
  amb 0.7 -> 0.50, `fogLum` 0.42 + `skyVeil` 0.62, species pool cut to dead wood only (species 2 is a leafy
  willow and a green canopy over standing water is a wood, not a fen), **drowned snags hung with moss**, and
  **witchlight fungus** scattered on the hummocks.

**🌊 The Sunken Kingdom — the drowned city.** A real sea you swim in and a civilisation under it: coral over
the throne room, kelp, anemones, the ribs of wrecks in the sand, whale-song and muffled everything.
- trees: **NONE** [p 0] — coral and kelp are the flora. Crystals: **none** — real branching coral instead.
- ground: reef sand [layer 4, tinted]. Sea [`sea: true`]: past the shelf the water is over your head and you
  swim (the region's passive).
- have: the sea basin, swimming, coral, anemone fans, wreck ribs.
- DONE, all four: **caustics** (two counter-drifting sine lattices sharpened with a power curve, in
  `FRAG_SPLAT`; they MULTIPLY the albedo, so they respect the sun and the shadows and cannot bloom),
  **muffled audio** (one master lowpass in `Audio.js`, 20 kHz on land, swept to 430 Hz when the camera is
  under the surface), a **breath meter** (`Player.breath`, 22 s under then 14 dps; `#bbar` in the HUD, only
  on screen while it is draining or refilling) and a **hoard at the Drowned Court** — spilled coin, broken
  chests and the crown at the foot of the throne.
- gap: none measured this pass. The caustics were added late and only checked in the region-heart shots.

**🕳️ The Void — reality gave up.** Shelves of dark violet stone over an abyss, islands hanging with nothing
holding them up, rubble that never landed, snapped pillars of something older, 0.55 gravity, no horizon.
- trees: **NONE** [p 0] — nothing grows. Crystals: **YES, void shards** [BSPIRE 0.120] — jagged and violet,
  the densest spires in the world.
- ground: voidstone with amethyst veins [layer 11], **no grass [0]**, `dry: true` so water never fills it.
- have: voidstone, hanging rubble, snapped pillars, low gravity, floating isles with keels, updrafts.
- DONE: bridges got kerbs and posts; the isles carry snapped pillars and rubble that never landed.
- gap: same isle silhouette problem as the Celestial Isles (see there).

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

### 4b-bis. The harness dies constantly when the box is busy — and it is not always your code

This pass lost roughly an hour to `TIMEOUT waiting for game to start: Target crashed`, always around the
terrain layer uploads, always with `GL_INVALID_OPERATION: Mismatch between texture format and sampler type`
spamming the GPU log first. **None of it was the code.** Three separate causes, all environmental:

1. **Two sweeps running at once.** A backgrounded loop that looks dead often is not: two copies of the same
   `for region in ...` script were fighting for the GPU for ten minutes. Check with
   `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'inspect.mjs' }` — kill the
   *parents* (`run.sh`, the loop script) or they respawn.
2. **The user's own machine.** The user had League of Legends and three other agent sessions open. A run
   that fails three times and then passes unchanged is contention, not a regression.
3. **Editing source while a run is in flight.** Vite HMR pushes a shader edit into a live headless page.

The decisive test is an A/B against unmodified `main`, interleaved, not sequential:
`git worktree add ../fps4-base main`, junction `node_modules` into it, run a second vite on 5174, then
`node tools/inspect.mjs --url http://127.0.0.1:5174/ ...`. Branch and main both passed back-to-back once the
box was quiet, which is what proved the code innocent. **One region per run, three shots, serially** is the
only shape that finishes here — a 13-leg script never completed once.

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
3. **The floating isles read as brown discs / flying-saucer hats from below** (Celestial and the Void). The
   tint was raised twice with no visible change, so it is the SHAPE — a flat rock dome plus a hanging keel —
   and/or `stoneMat`'s sand map, not the vertex colour. They want to be modelled as layered rock with a
   stepped underside. It is the one thing you always have a view of from the ground in both regions.
4. Four of nine straight-line pass walks (dragon, lost, void, infernal) stop at the destination region's own
   landform edge. The player is inside the region by then and would walk around, but a route would be better.
5. The village (Hearthfall) is nine huts and a well: no interiors, no NPCs, no doors.
6. Level bands are declared but never validated; nothing checks the XP/loot curve reaches 50, and a level-5
   player wandering into the Lost Realm just dies with no signposting.
7. `wilds` (the belt between region cores) has an ambient bed but no identity of its own.
8. Serpents read thin from below; their hover band wants tuning against the dive AI.
9. **Looking south out of the Whisperwood is 4.4-4.9 M tris — over the 4 M budget, and it already was
   before this pass** (measured at the pre-pass tree density: 4.44 M). The forest tree count was deliberately
   held at parity while closing the canopy, so this is unchanged, not caused — but it is the one view in the
   world that breaks the budget and nobody has owned it. Draw calls (250) and frame time are fine.
10. **Celestial Isles still read flat and empty from the middle.** The marble is right now, but the
   colonnade kit is scattered thinly instead of clustered into a plaza you walk to, and the region's night
   look was not re-checked in this pass.

**Tooling / assets**
9. `tools/blobcheck.py`'s BRIGHT test no longer covers airborne blobs (intended emissives made it unworkable
   there). Coverage for those is the `invariants.mjs` ceilings + the aether cap + `HOT_TINT`. If a glowing
   ball appears off the ground, that is the gap.
10. `public/assets/` is ~43 MB against a 40 MB target — re-encoding the nine 192 kbps region themes to 128
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
