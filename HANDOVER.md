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
   once) and starve the GPU until the renderer dies mid-script. They also **manufacture the fake ~65 ms
   periodic hitch** at q=high (see 5.1) — the leak was producing the bug it made unfindable. `inspect.mjs`
   now reaps its browser on exit, on signals and on uncaught errors, and warns at startup if any are already
   running; a hard `taskkill /F` of the harness still cannot be caught, so check the warning line.
   `Get-Process chrome-headless-shell | Stop-Process -Force` before a run, and check afterwards.
2. **A truncated run has no MASK frames**, so `blobcheck.py` loses the ground-cover scoping it depends on and
   dutifully reports the sun through the treeline. **A warm (234, 214, 170) "blob" at y = 0..5 is the sky.**

When the box is contended, run the legs standalone — that completes when the combined run will not:
```bash
node tools/inspect.mjs --nolock --name gate-high --q high --script tools/gate-steps.json --url http://127.0.0.1:5173/
python tools/gate.py tools/out/gate-high && python tools/blobcheck.py tools/out/gate-high burst-blob-
```
**Last measured on `claude/biomes-full-pass` (2026-08-23):** invariants PASS · q=high **jitter 0.079 PASS**
on a complete leg · that same leg's `blobcheck` FAILED with an 11 px green cluster in the meadow, which was
a real regression in the new grass value coupling and is fixed in `2677096` (the coupling may now only take
brightness away, so it cannot exceed the value the gate is calibrated against). **The post-fix blobcheck and
both q=low legs are still owed** — three other agent sessions and a game were sharing the GPU, and runs were
dying after 4-8 frames. Run `bash tools/scripts/gatesplit.sh high` then `... low` on a quiet box.

**MERGED WITHOUT A GREEN BLOB LEG (2026-08-23, user's explicit call).** At merge time: invariants PASS,
`check.mjs` PASS, q=high **jitter PASS** (verified by hand — 6 real lit frames, byte-identical), Frostveil
perf back inside budget (3.54 M tris / 162 calls / p50 5.5 ms). **The q=high blobcheck and the whole q=low
leg were never run to completion** — three agent sessions were driving the harness on one GPU and captures
died at 8-25 of the 88 frames. The argument for merging anyway was that the grass fix strictly LOWERS blade
brightness, so it cannot exceed the value the gate is calibrated against — that is inference, not a
measurement. **Run `bash tools/scripts/gatesplit.sh high` and `... low` on a quiet box and treat any failure
as a live regression, not a stale note.**

**Previously measured, green leg by leg on `main`:** invariants PASS · q=high jitter 0.075 + blobcheck PASS (88
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

**The gate is now splittable, and you should split it.** `tools/scripts/gate-blob.json` (steps 0-56, the 11
blob bursts) and `tools/scripts/gate-jit.json` (the preamble + the frozen-world jitter probe) are the same
`tools/gate-steps.json` cut in two, driven by `tools/scripts/gatesplit.sh <q>`. A full gate leg is ~110
frames and takes 25-40 min on a contended box, and it dies most often in the LAST section — so a single
crash throws away all 88 blob frames. Split, and each half is independently retryable.

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

**`stats().gpuMs` now works and did not before 2026-08-22** — the timer-query queue deadlocked seconds after
boot, so it read 0 for the whole history of the project and every number ever quoted here was CPU/rAF only.
It is a whole-frame bracket (it includes CPU-side idle), so use it for "are we GPU-bound", and use A/B deltas
inside one process for attribution. Orphaned `chrome-headless-shell` processes inflate it exactly like 4b.

### 4e. Anything stringified into a worker is a landmine

`Terrain.js` used to build its bake worker by stringifying its own functions. That works in dev and **dies in
every minified build** (the minifier renames bindings, the template string keeps the old identifiers), and
the only symptom was a silent fall back to a main-thread bake: 22 rendered frames in 17.6 s of boot before,
507 in 12.2 s after. The math now lives in `src/world/terrainKernel.js` (no `three` import, so the worker
chunk stays engine-free) and `terrainWorker.js` imports it. `invariants.mjs` (a2) fails if anyone
reintroduces the string form, drops the module-worker call, imports three into the kernel, or breaks the
`heightAt` wiring.

`terrain.heightAt` is ground truth for the entire game. Snapshot it before touching the kernel — seed 1337
must give `{"n":2695,"sum":162867.162973}`
(**re-baselined 2026-08-23.** The old figure here, 164490.108949, was stale: the ten-biome pass moved the
height kernels — `bhTundra`'s basin alone went 5.2 -> 3.35 — so this check had been FAILING on unmodified
`main`. Verified identical on `main` @ 5e52a14 and on the hitch-wave branch. Re-baseline it deliberately
whenever a kernel changes, and say so here; a snapshot that cries wolf is one nobody reads.):
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

## 4h. The blob gate's own flake — fixed 2026-08-22

`tools/gate.mjs` failed the q=low blobcheck about half the time **on unmodified code** (4 runs each way with
an unrelated optimisation on and off: on → FAIL, FAIL, PASS, PASS; off → PASS, PASS, FAIL, FAIL). Cause: the
harness captured ONE ground-cover mask per burst, *after* the burst finished, on the stated assumption that
"the camera is static through a burst". `gate-steps.json` holds `KeyW` down across the `blob-walk` burst, so
the camera travels through all 8 frames and then ~1 s more before the mask. blobcheck therefore scoped frame 0
with geometry from a metre or more down the meadow, and hazy distant canopy got judged under the strict
ground-cover rule — pass or fail depending on where the walk landed.

`inspect.mjs` now writes `mask-<burst>-<i>.png` per frame, freezing the world for each colour+mask pair so the
two are the same instant; `blobcheck.py` prefers the per-frame mask and falls back to the old per-burst one, so
older captures still evaluate identically. **The jitter burst is deliberately NOT frozen** — pausing there
would let temporal accumulation settle and hand gate rule 2 a free pass. Keep that exemption permanently: with
one mask per frame, every burst frame is now preceded by a forced shadow-map re-render (`_renderSkyMask` arms
`needsUpdate` on exit), which is harmless for blobcheck but is exactly the sort of thing rule 2 exists to catch.

**The RATE is not yet proven, and the original evidence was weaker than it looked.** The 4-runs-each-way result
was *time-ordered* — FAIL, FAIL, PASS, PASS in one arm and PASS, PASS, FAIL, FAIL in the other — which is the
signature of the box drifting through the session, not of a coin flip. So misalignment and machine contention
may BOTH have been contributing and only one is fixed. To settle it, on a quiet box with the reaper working:
restore the single-late-mask behaviour temporarily and run **8x each arm** (not 4 — at a 25% flake rate, 4 runs
has a ~32% chance of showing zero failures by luck, which is how this got declared fixed the first time), and
discard any run whose startup orphan warning was non-zero rather than averaging it in. If the old form passes
8/8 on a quiet box, the flake was contention all along and this fixed a real but different bug.

## 4g. Perf wave 2026-08-22 — the cloud march is half the frame

`Sky`'s volumetric march ran every frame with no idea whether any sky was visible: **4.75 ms inside a closed
canopy showing zero sky pixels**. It now reduces last frame's depth into a 1/8-res `min(1 - depth)` pyramid and
skips rays whose 5x5 neighbourhood is fully covered. **3.0-3.3 ms back in every region (31-39% of frame)**,
image bit-identical (0.0000% of non-HUD pixels differ, incl. a 690 deg/s flick). Kill switch:
`sky.cloudOcclusionCull = false`. Terrain also skips splat fetches whose blend weight is 0 (same shape as the
existing `wRock`/`wB` guards).

**Do not "simplify" these — each one is a bug that was caught, not a precaution:**
- `postfx.depthTexture` is null until a composer frame exists. The intro drives Sky via `Game.stepInto`, which
  never runs the composer; an unwritten depth samples 0, which reads as *fully covered*, so the cull would have
  killed every cloud in the intro.
- Cull is off while `_histValid` is 0 (boot, every resize), else the sentinel is stored as clear sky.
- The occlusion chain resizes ABOVE `_setCloudSize`'s early return — it quantises differently, so a resize could
  leave the pyramid stale and its taps off their 2x2 block.
- The pyramid lookup uses `textureLod` and never returns from inside the loop: a gradient instruction under
  varying iteration (fxc X3595) **crashed the GPU process**.
- 5x5, not 3x3 — the margin must exceed the dome's tent radius plus the resolve's bilinear radius, or stale
  cloud leaks at horizon silhouettes (measured up to 46/255 at 3x3).
- Four frames in every 32 march everything, bounding staleness to ~0.3 s.

Orchestrator edited four builder-owned files (`Sky.js`, `PostFX.js`, `Terrain.js`, `Perf.js`) — sky/postfx/
terrain builders, the diffs in your files are this, not something you forgot.

**The q=low blobcheck is flaky on unmodified code.** Controlled A/B, 4 runs each: cull ON → FAIL, FAIL, PASS,
PASS; cull OFF → PASS, PASS, FAIL, FAIL. Same rate with the optimization disabled. Since a q=low blob failure
is an automatic LOSE, the detector needs fixing before it can gate anything — see 4b, this may be the same
root cause.

## 4i. Per-system GPU attribution, 2026-08-23 — measured, and it retires three guesses

First real per-system GPU numbers this project has had (the timer only started working 2026-08-22). Quiet box,
q=high, 1080p, hour 13. Method that works: **per-frame alternation with its own `TIME_ELAPSED` query and a
`gl.finish()` per frame**, alternating in blocks of 3, with a `none` control to establish the noise floor.

**Meadow, open sky — base frame ~6.3 ms GPU** (noise floor +-0.2 ms):

| system | cost ms | | system | cost ms |
|---|---|---|---|---|
| cloud march + resolve | **1.27** | | skydome | 0.09 (noise) |
| grass | **0.39** | | **shadows / CSM** | **0.05 (noise — FREE)** |
| rocks + crystals | **0.28** | | props / clutter | -0.05 (noise) |
| enemies | **0.28** | | **terrain** | **-1.25 (negative, see below)** |
| trees | **0.23** | | postfx | ~0.3, unstable |

**Whisperwood, closed canopy — base ~8.0 ms** (1.7 ms dearer than the meadow): clouds **1.51**, trees **1.03**,
grass 0.12, shadows **0.09 (free)**, everything else noise or unstable.

**What this kills, so nobody re-proposes it:**
- **Shadows are free.** Freezing all CSM rasterisation saves 0.05-0.09 ms, inside noise, in four reps out of
  four. "Stagger the far cascade for 0.3-0.5 ms" is dead — the far cascade is ALREADY staggered
  (`Lighting.js`, `stagger && i === last && (this._frame & 1)`) and the whole shadow pass is still free.
- **Grass is 0.39 ms, not the 1.0 ms it is budgeted.** Nothing to win, and the blob law makes it expensive to
  touch. Leave it.
- **There is no 2 ms hiding anywhere.** Everything attributable sums to ~2.5 ms of 6.3. The remainder is
  full-screen fragment work that this method CANNOT split, because the ground shader and the sky dome
  substitute for each other — hide one and the other shades those pixels. That is the scene, not the method.

**Terrain measures NEGATIVE (-1.25 ms) and it is the most useful number here.** Hiding the terrain makes the
frame *slower*: it is the world's primary depth occluder, so without it every distant tree, rock and clutter
mesh stops being early-Z rejected and starts shading. **The frame runs on occlusion.** The next real win is
therefore in feeding early-Z better (draw order, front-to-back, impostors not drawing before the ground), not
in making any one shader cheaper.

**Reconciles with 4g rather than contradicting it.** Clouds measure 1.3-1.5 ms *with* the occlusion cull on;
the cull's removal costs +3.7 ms; implied uncalled cost ~5.2 ms; and the independent pre-cull measurement of
`sky.update` was 4.70-4.75 ms. Two methods, two days apart, same number. The cull took the march from ~4.7 ms
to ~1.5 ms.

**`PostFX.profile()` resolves but its output is NOT quotable.** The `gpuPaused` handshake fixed the hang, but
on one unchanged scene it returned 16.175 / 2.009 / 1.507 / 0.847 ms — a 20x spread. `bypass` changes the
frame's whole GPU/queue character, so the two alternating states are not comparable frames. A trustworthy
postfx number needs per-PASS brackets inside the composer. Best current estimate 1-2 ms, no better.

**Three traps that produce confidently wrong tables** (each one bit during this session):
- `stats().gpuMs` **cannot attribute by subtraction** — it is a whole-frame bracket including GPU idle, so
  removing GPU work makes the frame CPU-bound and the number goes UP. It "measured" grass at -9.45 ms.
- **The frame alternates between two costs** (~196 and ~165 draw calls; an extra ~47-call scene pass on odd
  frames). A 1:1 A/B aliases straight onto it. Alternate in blocks of 3. The alternation is NOT the water
  reflection (disabling it leaves the swing unchanged) and not only the staggered cascade (freezing shadows
  changes the swing rather than removing it); it is unattributed, but both candidate systems measure at or
  below the noise floor, so it is **not a hidden cost**.
- **`Grass.update` rewrites `mesh.visible` every frame**, so `visible = false` silently does nothing and grass
  measures as free. Toggle with `layers.set(9)`. Anything that recomputes visibility per frame has this bug.


## 4j. The hitch wave, 2026-08-23 — the per-frame trace, and what it found

**The project had never recorded a per-frame trace, which is why these sat in plain sight for months.**
`stats()` returns percentiles over a 600-frame ring and `perf.systems` is an EMA with alpha 0.05 — a single
1.2 s frame moves the mean by 2 ms and the EMA by 5% of one sample. Both instruments are blind to exactly
the thing "hitches" means. `tools/hitchprobe.mjs` reports the same aggregates and is blind the same way.

`tools/hitchhunt.mjs` is the missing instrument. It wraps every system's `update()`, World's five sub-parts
and `postfx.render()` **in-page** (no game source touched), hooks `perf.end` so the sample lands at the true
end of frame, and records EVERY frame: wall dt, CPU, GPU, program count, draw calls, tris, position. Then it
attributes each spike to whatever was slow ON THAT FRAME.

    node tools/hitchhunt.mjs --name base                     # full route: 10 biomes, combat, border walk, soak
    node tools/hitchhunt.mjs --name x --route tp             # teleports only (~90 s), for iterating
    node tools/hitchhunt.mjs --name x --route combat         # each first-use event on its own mark
    node tools/hitchhunt.mjs --name x --url http://127.0.0.1:5198/ --params nowarm=1    # A/B another build

**Use it before believing any hitch claim, including the ones in this file.**

### Steady state was never the problem

p50 is **16.7 ms in every phase, in all ten biomes** — a vsync-locked 60 Hz. `walk-*` maxima were 20-21 ms
BEFORE any fix. There is no steady-state deficit to chase; every complaint was a discrete event.

### Cause 1 — the grass cache rebuild: 0.82-1.25 s frozen on EVERY fast travel (FIXED)

`Grass._shiftTo` refills a column/row per frame, but a jump over 12 texels (= **6 m**, step is 0.5) falls
through to `_rebuild`, which is `N*N = 262,144` `_texel()` calls with no budget. Measured on all nine
regions: forest 977, tundra 958, celestial 957, dragon 995, infernal 1249, lost 855, shadowfen 886, sunken
895, void 877 ms. Also fires on `respawn()`, on `?at=<biome>`, and once at boot.

**The dominant term was not grass.** Microbenchmark in situ, q=high:

| call | ns |
|---|---|
| `terrain.colorAt` | **1765** |
| `terrain.heightAt` | 405 |
| `_biomeMask` (already block-cached) | 20 |
| whole `_texel` | 1895 |

`colorAt` is 93% of a texel: 3 `heightAt` plus 2 fBm macro noises. Its own comment says "safe for Grass's
100k init samples" — true when it was only an init cost. Its finest input is a slope term off a 1.2 m finite
difference; everything that actually moves the colour is at 61 m and 143 m, so per-0.5 m sampling bought
nothing.

Fix, both inside `Grass.js`: (1) cache the packed albedo per 4x4-texel (2 m) block on the SAME key
`_biomeMask` already used — the idiom was already in the file; (2) `_rebuild` now only ARMS a job and
`update()` drains it under a 6 ms budget, hiding the rings until it lands. **Boot's fill still runs to
completion synchronously** (`_drainRebuild(Infinity)` in `init`): it is behind the loading screen where a
block is free, and slicing it let the splash lift (it waits only for five sub-25 ms frames) over a meadow
with no grass in it. Every `goto-*` is now <= 25 ms.

Do not "simplify" the hide-while-rebuilding branch — a half-written toroidal cache is blades at the OLD
location's heights, i.e. floating and buried grass.

### Cause 2 — shader programs linking during play (PARTLY FIXED — see 5.11)

**A link blocks inside the ANGLE/D3D11 GPU PROCESS, so it is invisible to both `cpuMs` and `gpuMs`** — a
`TIME_ELAPSED` query measures GPU *execution*, not driver-side HLSL compilation. The worst frame read:

    dt = 6502.8 ms | page cpu = 35.4 ms | GPU exec = 5.93 ms | programs 177 -> 178 | vsync ON | quiet box

**This is NOT the 5.1 harness artifact, and 5.1's own reopen condition is how you tell.** That artifact
needs the GPU at ~100% occupancy (`gpuMs` ~= `frameMs`); here GPU exec is 5.93 ms against a 6.5 SECOND
frame. `hitchhunt.mjs` records `gpu` on every spike frame precisely so this stays checkable.

Fixed so far: `Enemies.warm()` builds one sleeping instance of all 23 types at boot (pooled enemies are
already left in the scene, so the boot compile reaches them); `Weapons.init` builds all 8 archetypes instead
of 2; `Abilities.init` now `initTexture`s its glyph/glow/vignette.

### THE ROOT CAUSE OF ALL OF IT: the warmup was compiling the wrong COLORSPACE

**`outputColorSpace` is the SECOND field of three's program cache key** (`WebGLPrograms.
getProgramCacheKeyParameters`), and `getParameters` reads it as
`currentRenderTarget === null ? renderer.outputColorSpace : ColorManagement.workingColorSpace`.

This game draws every pixel through `composer.render()`, i.e. **always INTO a render target**, so every
program it actually uses is keyed `srgb-linear`. `renderer.compile()` with nothing bound builds the `srgb`
twin: a real program, fully linked, that the renderer will never look up — while the one it needs still
links on first draw. **The warmup had been warming nothing for the whole history of the project, and
actively costing boot time to do it.**

Measured: warming that way left the program count **41 HIGHER** than not warming at all (`ctl-warm`
137 -> 175 vs `ctl-nowarm` 129 -> 134, both reproduced exactly twice — program counts are deterministic and
therefore trustworthy, unlike any timing on this box). Binding a target took the programs linked during one
combat session from **44 to 1**, and on the tp route took time-to-playable from 16.7 s to **12.4 s** while
also dropping stall from 1825 ms to 820 ms. Both axes at once, because ~40 programs stopped being built.

Everything goes through `compileForComposer()` / `renderForComposer()` in `src/render/Renderer.js` now, and
`tools/invariants.mjs` check (i) fails the build if any of main.js / Weapons.js / Abilities.js / EZTrees.js
calls `renderer.compile()` directly again. **That guard was tested by reintroducing the bug and confirming a
non-zero exit — a guard nobody has seen fail is not a guard.**

Note `compile()` cannot build depth/distance programs AT ALL: `getDepthMaterial` is only reachable from
`WebGLShadowMap.render()`, which only runs inside `renderer.render()`. Hence `renderForComposer()`.

### The visibility red herring (do not retry it)

"compile() skips hidden meshes, so pooled/invisible VFX meshes are missed" — tried 2026-08-23, WRONG. three
r185 gathers LIGHTS with `traverseVisible` but MATERIALS with a plain `scene.traverse`. Measured live: a
hidden mesh carrying a novel `customProgramCacheKey` took the count 171 -> 172 while still `visible = false`.
The chunking buys paint time between calls; it does not slice compilation.

It looks like `renderer.compile()` skips hidden meshes, so every pooled/invisible VFX mesh is missed. **That
was tried on 2026-08-23 and it is WRONG.** three r185 gathers LIGHTS with `traverseVisible` but prepares
MATERIALS with a plain `scene.traverse` (`three.module.js` ~17403 vs ~17427). Measured in the live game: a
hidden mesh carrying a novel `customProgramCacheKey` took the count 171 -> 172 while still `visible = false`.
What actually gets missed is anything **not in the scene yet** — an empty enemy pool, an ungiven weapon,
whatever a floating dynamic import adds later.

Second thing to know: **`game.start()` is chained on `game.ready` SEPARATELY from `warmScene`**
(`main.js:225` vs the warm block above it), and `warmScene` is `async`, so it yields at its first `await`
and the game loop starts while it is still compiling. Its slices therefore interleave with live gameplay
frames. That is why programs link "in play" at all.

**A trade-off that was on the table and is now MOOT — recorded so nobody re-opens it.** Before the
colorspace bug was found, the only lever on the remaining stall looked like collapsing `warmScene` to a
single blocking `compile()`, i.e. buying smoothness with loading time. Production builds, `--route tp`, same
box, stalls counted only AFTER the game is playable (five consecutive sub-25 ms frames):

| warmScene form | playable at | spikes | stall sum | worst frame |
|---|---|---|---|---|
| sliced, compiling unbound (was) | 16.7 s | 5 | 1825 ms | 562 ms |
| sliced + a final full compile | 16.9 s | 7 | 2093 ms | 580 ms |
| ONE blocking compile, unbound | 17.9 s | 4 | 918 ms | 324 ms |
| **sliced, compiling BOUND (now)** | **11.2 s** | **3** | **483 ms** | **213 ms** |

Binding the target beat every one of them on BOTH axes at once — 5.5 s faster to playable AND less stall —
because it stopped building ~40 programs the renderer could never use. There is no loading-time-for-
smoothness trade here; there was only a bug. Do not spend the loading screen on this again.

### Cause 3 — boot: 13 MB of music for regions you cannot reach (FIXED)

`Assets.init` awaited the whole 44 MB payload before system 1 of 13 began; 19 MB of it was music, nine
region themes at 1.44 MB each for places minutes of walking away. They now start only AFTER the critical set
resolves (firing them on the same tick still left them competing for the same six connections) and are never
awaited; `Audio._decodeAssets` chains each decode onto its arrival. Safe by construction — `music.js
_themeKey()` already played the Vale theme whenever a region buffer was absent.

### Retired guesses — do not re-propose

- **Enemy construction is not a cost.** `lineup()` builds 37 enemies in **1.4 ms**. The stall is entirely the
  first DRAW of a type whose programs were never linked.
- **`renderer.compile()` right after a spawn does nothing** (0 programs, 3 ms) — the fresh enemies are still
  `visible = false` on that tick. But see the trap above: visibility is not why.
- **The grass CPU cost was never the blades.** It was `terrain.colorAt`.

### Result

Player-visible stall (counted after the game is playable), `--route tp`, production builds, same box:

| build | playable | spikes | stall sum | worst frame |
|---|---|---|---|---|
| `main` (control, 2 reps) | 16.8-17.0 s | 10, 11 | 6812, 6851 ms | 1212 ms |
| this wave | 16.7 s | 5 | 1825 ms | 562 ms |

Gate passed at q=high and q=low (blobs clean, jitter clean, pointer lock engage + re-acquire).

## 4k. The GL validation burst, 2026-08-23 — one dropped frame at boot, three causes (FIXED)

Every capture logged `GL_INVALID_OPERATION: ... Mismatch between texture format and sampler type
(signed/unsigned/float/shadow)`. It was reported as "~60 per 50 s during ordinary gameplay". **That premise
was wrong and checking it first is what made this solvable:** across 21 captured `console.log`s the errors are
ONE CONTIGUOUS BURST at boot with no other line interleaved (`span == count` in every file), then silence.
11 at q=high, 7 at q=low — **exactly the cascade count**, which is the whole clue.

**Cause: the far shadow cascade was staggered out before it had ever rendered.** `Lighting.update` does
`this._frame++` BEFORE `_fitCascades()`, so `_frame === 1` on the first rendered frame, and the stagger test
was `(this._frame & 1)` — true. The last cascade therefore never reached `WebGLShadowMap.render()`, its
`DepthTexture` never got a GL texture (the constructor only makes the JS object; `version` stays 0 and
`isRenderTargetTexture` is false, so `setTexture2D` skips the upload and binds `undefined`), three bound
texture 0 to a `sampler2DShadow`, and the driver **dropped every lit draw on that frame**. Fix is the parity:
`(this._frame & 1) === 0`. Same 50% duty cycle from frame 2 on.
**Do NOT "simplify" that to `this._frame > 1`** — it was suggested and it is wrong: the far cascade would
render once and then be staggered on every subsequent frame forever.

Two more, same burst, both real bugs and not just log noise:
- **`Texture marked for update but no image data found` x9, every run, every quality.** `EZTrees`'s readiness
  gate read `if (!img || img.complete) return null` — but `TextureLoader` leaves `texture.image` NULL until
  the data URI decodes, so "not loaded yet" was treated as "ready" and the gate resolved instantly for
  precisely the 9 textures it existed to wait for. The bake then sampled unbound (black) maps, so the first
  impostor albedos were baked wrong. It polls for `m.image && m.image.complete` now. Boot is ~0.9 s slower
  because it now actually waits — that is the fix working, not a regression.
- **`GL_INVALID_VALUE: glGetProgramiv: Program object expected`.** `Terrain.js` called
  `renderer.compileAsync(...)`, which polls `gl.getProgramParameter` on a program three may already have
  released. It was also unbound, so it was building the `srgb` twin (4j) — and `main.js:170` already records
  compileAsync measuring 2x worse than the sync path. Now `compileForComposer`, and `invariants.mjs` check
  (i) covers `Terrain.js` and the string `compileAsync(` too.

Verified: `Mismatch=0 noImageData=0 ProgramObject=0` at q=high AND q=low, gate passes, and the tp route went
from 3 spikes / 483 ms of stall to **0 spikes / 0 ms** (two reps).

## 5. Everything else open

**Performance**
1. ~~A **~65 ms periodic hitch at q=high**~~ — **CLOSED 2026-08-22: it is a harness artifact, not a game bug.**
   `tools/inspect.mjs` launches with `--disable-gpu-vsync --disable-frame-rate-limit`, so the client renders
   flat out; once the GPU is ~100% occupied (q=high sits at ~6.9 ms GPU against a ~6.8 ms frame) the command
   buffer fills and the renderer blocks in `CommandBufferProxyImpl::WaitForGetOffset`. Evidence: on hitch
   frames **the GPU is idle** (frameMs max 92 ms while gpuMs never exceeded 11.6 ms in the same window); the
   whole stall sits inside one arbitrary cheap GL call, a different one each time, with a normal GL call
   count; a CDP trace shows 3446 ms of 8000 ms in `WaitForGetOffset` against 18 `PutChanged` tasks in the GPU
   process; ANGLE worker overlap is 15%, so not shader compilation (matches the 174 → 174 program count).
   Restore vsync and p99 becomes **18.5 ms — exactly one vsync interval**. q=low never hits it because it has
   GPU slack (gpuMs p50 2.25 vs frameMs p50 4.9). **It does not reproduce on an uncontended box at all.**
   The old "confirmed in a headed browser" claim was wrong: `--headed` only flips `headless`, it still passes
   both frame-rate switches, so that reading was taken under the very condition that causes the artifact.
   A frames-in-flight cap was implemented and **reverted** — it cures a contended box but costs 29% of
   throughput on a healthy one, buying a stall that does not otherwise exist.
   Use `tools/hitchprobe.mjs --vsync` (and `--trace`, read with `tools/hitchparse.mjs`) to tell a real hitch
   from this artifact before chasing one again.
   **REOPEN CONDITION — do not wave a stall away just because this entry says "closed".** The artifact needs
   the GPU at ~100% occupancy, whose tell is `gpuMs` mean ≈ `frameMs` mean. If you see periodic stalls while
   `gpuMs` mean sits *well below* `frameMs` mean, on a quiet box with no orphaned `chrome-headless-shell`
   processes, that is NOT this — it is a real hitch and this item is reopened. Equally: if the ratio is ~1.0,
   check the orphan warning `inspect.mjs` prints at startup before believing anything else you measured.
   **The honest item underneath: q=high spends ~6.3-6.9 ms of GPU against a ≤7 ms whole-frame budget — no
   headroom.** Lower that and the backpressure cannot build regardless of pacing. **4i now has the per-system
   breakdown**: there is no single fat target, the meadow is already inside budget at rest, and the case that
   actually breaks it is the forest at ~8.0 ms, where the answer is trees (1.03 ms) plus clouds (1.51 ms).

2. **What a PLAYER actually gets, q=high, vsync ON: frameMs p99 18.5 ms, cpuMs p99 10.9 ms.** Every other
   number in this file comes from the uncapped harness and is therefore a *stress* figure, not an experience
   figure — the project had never recorded the second kind. Re-measure with `node tools/hitchprobe.mjs --vsync`
   after anything that moves the frame, and keep this line honest: it is the only number here a person feels.
3. **Boot is ~13 s to `_running` and ~16.7 s to playable on a PRODUCTION build** (2026-08-23, local
   preview, q=high; the old ~30 s figure was the dev server). Still far over the stated < 4 s budget.
   Original attribution below, kept because the shape still holds:
   ~~Boot to `_running` is ~30 s headless against a stated < 4 s budget~~ (terrain full bake 9.2 s, impostor
   bakes 5.1 s, vegetation 1.5 s; chunking has since taken the worst mid-load stall to ~1.2 s). The harness
   boot wait was raised 60 s -> 150 s to stop runs dying with TIMEOUT, which also removed the last thing that
   was passively noticing this — hence the number is written here instead. A two-minute wait is not normal and
   should not become the next agent's baseline assumption.
4. Impostor tier swap is still a hard pop at the boundary — a dither crossfade over ~15 m is the fix.
5. ~~A ~6.5 s stall on `__game.lineup()`~~ — **CLOSED 2026-08-23: it was the HARNESS, not the game.**
   `tools/hitchhunt.mjs` called `await page.evaluate('window.__game.lineup()')`. `lineup()` RETURNS its 23
   live `Enemy` instances, so Playwright serialised that entire Three.js object graph back over CDP. That
   blocks the page's main thread BETWEEN frames: wall dt 6.5 s, the frame's own cpu ~15-35 ms, GPU idle, no
   program links — the exact signature that made it look like a monstrous driver stall. Wrapping the call to
   return a scalar removed it completely, on the first try, reproducibly.
   **The lesson, and it is now enforced in the tool: never let an eval RETURN a game object.** `ev()` wraps
   every evaluate so the page hands back a scalar; `give()`, `ability()`, `killAll()`, `clearEnemies()` and
   `lineup()` all return live objects and every one of them was adding phantom stalls. Combat route before:
   3 spikes, 10269 ms, worst 6812 ms. After: **3 spikes, 719 ms, worst 330 ms** — same build, same box.
   This is the second time this project has been sent chasing a harness artifact (see 5.1). When a stall has
   page cpu LOW and GPU LOW, suspect the instrument before the game.
   What is actually left on that route: **330 ms on the first super** (cpu 319 ms, programs 127 -> 136), i.e.
   nine real first-use program links from the effects `Abilities` calls into — `combat.explode`,
   `combat.projectile`, `vfx.shockwave`/`emit`, `postfx.flash`. Those pools are not in the scene at boot, so
   the boot compile cannot reach them; prewarming them is a Combat/VFX-side job.

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
