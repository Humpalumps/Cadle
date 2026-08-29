# HANDOVER — Cadle

Read this first if you are picking the project up cold. It is the only thing a replacement agent gets.
Order: **§1 the job → §2 the next job (biomes) → §3 the machine → §4 the traps → §5 everything else open.**
`CLAUDE.md` is the contract (file ownership, conventions, perf budget, world layout, `window.__game` API) —
this file is state and hard-won knowledge. **Keep it current; delete what has stopped being true.**

Repo: `https://github.com/Humpalumps/Cadle` · branch `main` · everything below is merged and pushed.

---

## 0. WHERE IT STANDS (2026-08-29) - read this before anything else

Working tree: the `shader-compilation-worker-7299da` worktree, on `6579628`. **Nothing is committed** -
43 changed files. The orchestrator commits; builders and critics never touch git.

**The game itself is unchanged and verified.** Only three game files were touched this pass:
`src/core/Input.js` (the Tab guard, §6.0i), `src/ui/ui.css` and `src/ui/screencss.js` (chrome tokens,
chamfer removed). `invariants` OK, `curvecheck` OK, **`questgate` all OK** - both weapons fire and
reload, ammo returns after running dry, all five quest objective types accept/tick/turn in, no page
errors, memory flat. `tools/gate.mjs` has NOT been run since those edits: it refuses to start with other
harness Chromes alive and will not accept a starved capture. **Run it first on a quiet machine.**

The work of this pass is the front door:

* the old cinematic intro is **deleted**. The game lives at **`/play/`** behind a title screen
  (`src/ui/Menu.js`) that loads instantly and boots nothing until Play is pressed.
* **`/` is a real marketing site** (`index.html` + `src/site/*`), a second Vite entry, shipping no engine
  code. Every link is `/play/?start` WITH the slash - the slashless form needs a rewrite that only the
  dev server and `public/.htaccess` provide. Region cards deep-link `/play/?start&at=<biome id>`.
* the hero feature is **the range** (§6.0c/§6.0d): one unchanging reticle, a left click is a shot,
  everything reacts, six creatures fall off the page when shot.
* the brand mark is **new** (§6.0k below): an engraved gold ring with a cut amethyst, generated in
  Magnific and split into three layers so it counter-rotates. Assets in `public/assets/ui/mark/`.

### What is left before it can go live

**Blocking:**
1. ~~The loading screen.~~ **DONE.** All ten audit items closed - see §6.0h. The rendered bar now
   reverses 3x per load with a worst reversal of 3.6 points (was 13-26x, worst 42.7); the fix was to
   stop driving it with a CSS transition at all, because a transition has a *from-value* to revert to,
   so a stale commit replays the whole move. It is a time-driven Web Animation seeked by `currentTime`,
   which has only a stale *time*. Failure shows an error and a Reload button, `role="progressbar"` is
   real, and the hand-off is a 2.6 s luma ramp instead of a single-frame 23 -> 136 slam.
   **The phase budget is wired in `main.js`:** `menu.phases([...16 ids])`, then `menu.phase(id, label)`
   on `boot:progress` - which Game.js emits AFTER a system's `init()` resolved, so main.js opens the
   *next* phase, not the one named. `Menu` times each phase, persists to `localStorage` under
   `cadle.loadms`, and spends the bar by the last load's milliseconds. Proved end to end by
   `tools/out/phase2.mjs` (boots twice in one browser context): all 16 phases recorded both times, and
   the second load spent 52% of the bar on `Player` because that is what `Player` actually cost. First
   ever load has no record and falls back to equal weights.
2. **`tools/gate.mjs` on a quiet machine.** It refuses to start with other harness Chromes alive
   (`Get-Process chrome-headless-shell | Stop-Process -Force` first) and it defaults to `5173`, which is
   the MAIN repo - **pass `CADLE_URL=http://127.0.0.1:5181`** or it fails with `WRONG TREE`.
3. **One clean critic round.** Art direction, game feel and front-end have all returned DO NOT SIGN OFF;
   the last two rounds of fixes have not been re-reviewed. Twice now a fix has re-opened the same defect
   on the adjacent code path, so do not skip this.
4. **Commit.**
5. ~~The mark on `/play/`.~~ **DONE.** `play/index.html` carries the same favicon set as `index.html`,
   `#brand .sig` is the three-layer `.mark3` build at 72px, and the loading screen's wheel is the same
   mark with its `playbackRate` driven 1x -> 5x by the bar's own position (`playbackRate`, not
   `animation-duration` - changing a duration reinterprets local time and the ring jumps on every write).
   Nothing was added to the in-game HUD deliberately: an FPS reticle-and-ammo HUD does not carry a
   wordmark, and putting one there is a design decision, not a wiring gap.

**Done in the pre-launch cleanup (§6.0j):** no-JS content for the rail and weapon strip, the initial long
task 205 ms -> 107 ms, above the fold 439 KB.

**The gallery is done too:** re-shot so three frames carry no viewmodel and the other three use three
different guns at three different angles (all six used to carry the same hand cannon in the same
corner), `-sm.jpg` 800x450 variants wired through `srcset`, and captions rewritten to match what is
actually in each frame. Both phone and desktop now fetch the small cut - about 1.4 MB down to 362 KB -
while `src` stays the full-size file, because main.js reads it to build the lightbox.
**Watch `sizes`:** at `100vw` a 430 px phone at DPR 2 asks for 860 device px and pulls the 1600 anyway,
which defeats the whole exercise. It is `92vw`, and `tools/out/srcsetcheck.mjs` proves which cut each
viewport actually fetches.

**Nothing follows the cursor any more** (user, 2026-08-29). `magnetic()` is deleted: it listened on the
*window* and translated a button toward the pointer from 120 px away, so the three Play buttons drifted
about as you approached them. `tilt()` lost its rotation for the same reason - the `.tiltcard` panes are
shootable, so the thing you were aiming at rolled away from the shot - and kept only the cursor-tracked
glare, which let `transform-style:preserve-3d` and `will-change:transform` come off the card too. The
reticle, the rail's drag and the backdrop's camera parallax are the only pointer-driven motion left, and
all three are deliberate. `tools/out/jiggle.mjs` sweeps the pointer past every control from four sides at
110/80/55/35/20 px and asserts 0 px of drift; run it if you touch `src/site/ui.js`.

So the non-blocking list is closed. What remains is items 2, 3 and 4 above.

### Servers and checks

This worktree needs **its own** dev server - 5173 serves the MAIN repo and 5179 has been seen serving a
different worktree entirely, so a run against either measures the wrong build.

```
node C:/Users/ianca/Desktop/fps4/node_modules/vite/bin/vite.js --port 5181 --strictPort --host 127.0.0.1
node C:/Users/ianca/Desktop/fps4/node_modules/vite/bin/vite.js build
node C:/Users/ianca/Desktop/fps4/node_modules/vite/bin/vite.js preview --port 5182 --strictPort --host 127.0.0.1
$env:CADLE_URL='http://127.0.0.1:5181'; node tools/gate.mjs      # needs the GPU to itself
```

Site checks live in `tools/out/` (gitignored scratch, all take a base URL):
`cssguard` (the inline sheet still parses to its last rule - one unterminated string once silently
dropped every rule after it), `rangecheck`, `shootcheck`, `linkcheck` (every Play link, real mouse),
`copyguard` (shoot a paragraph, read it back), `railhit`, `misscheck`, `a11y`, `nojs`, `clscheck`,
`longtask`, `abovefold`, `siteperf`, `perfab2` (A/B a visual change against frame time), `loadbar`,
`tabcheck`, `ingamesmoke`, `sitepage`, `beastshots`, `mark` + `markshot`.

**Two traps that have each cost hours:** PowerShell's `Get-Content`/`Set-Content` mojibakes any BOM-less
UTF-8 file - edit with Python or the Edit tool, never a PS round trip. And a harness run is only honest
if the machine is quiet; a contended run reports failures it did not earn.

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

**�?��? Frostveil Tundra — the frozen forest.** Reference: **Winterspring**. Not an empty steppe: it is a CONIFER
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

**�?��? Dragon Peaks — the high mountain.** 200 m fangs of rock, ledges with dragon nests, a dwarven gate cut
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

**�?� The Lost Realm — where every magic meets.** Endgame. A violet flagstone plain, a rampart ring, sixteen
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

**🕳�? The Void — reality gave up.** Shelves of dark violet stone over an abyss, islands hanging with nothing
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

### 4a-bis. THE DEV SERVER MAY NOT BE SERVING YOUR CODE (2026-08-23, cost most of a wave)

`CLAUDE.md` says "the dev server is **always already running** at `http://127.0.0.1:5173/`". That
sentence was true and became a trap the moment work moved into a **git worktree**. The user's server
was started in the MAIN repo (`C:/Users/ianca/Desktop/fps4`), which sits on its own branch. A worktree
under `.claude/worktrees/<name>/` is a different directory with different files, and nothing about
`localhost:5173` tells you which one it is showing you.

**What that produced:** five agents measuring a tree that contained none of their work. Screenshots of
UI that had not been written. A density cap "measured" on the wrong branch. A full `GATE PASSED`
(blobcheck clean at both qualities, jitter 0.031/0.034, pointer lock OK) reported as evidence for code
the server had never loaded. Every one of those results *looked* completely healthy, because a wrong
tree serves a perfectly good game. It was found by accident: `window.__game.quest` was undefined in the
running page although it was plainly there in `src/main.js` on disk.

**One-line diagnosis — run it before you trust any harness number:**
```bash
curl -s http://127.0.0.1:5173/src/main.js | grep -c "<a phrase you just wrote>"
```
Zero matches = wrong tree. Or check the obvious: `git -C C:/Users/ianca/Desktop/fps4 branch --show-current`.

**The fix is in the harness now, so this cannot silently recur.** `tools/inspect.mjs` fetches
`src/main.js`, `src/core/Game.js` and `src/render/PostFX.js` back off the server before it navigates,
and requires the longest distinctive comment line of each to match the copy on disk in the current
working directory. Mismatch prints `==== WRONG TREE ====` and exits 2, before a single frame is
captured. Every agent-facing tool routes through `inspect.mjs`, which is why the check lives there
rather than in each gate. `CADLE_SKIP_TREECHECK=1` overrides it, for the rare case where measuring
another tree is the actual intent.

**When you are working in a worktree:** start your own server in it on a free port and pass the URL
explicitly to everything — `--url http://127.0.0.1:5174/`, or `CADLE_URL=http://127.0.0.1:5174/`,
which `gate.mjs`, `inspect.mjs`, `hitchhunt.mjs` and `questgate.mjs` all honour. **Do not kill the
server on 5173** — it is the user's. Tell every sub-agent the port in its opening prompt; they have no
way to work it out.

### 4a-ter. THREE THINGS THAT MAKE `gate.mjs` LIE, ALL FOUND 2026-08-23

**0. `gate.mjs` NOW REFUSES TO START when any `chrome-headless-shell` is already running.** It captures
88 frames per quality and needs the GPU to itself; a starved run truncates, and a truncated capture reads
as a failure it did not earn. That cost two full re-runs on the day this was written — once as a fake
`BLOBCHECK FAIL` on an unmasked frame, once as `INCONCLUSIVE` at 8 of 88 frames. It now exits 3 with
`==== NOT STARTING ====` and tells you to reap. `CADLE_GATE_FORCE=1` overrides. Reap with
`Get-Process chrome-headless-shell | Stop-Process -Force`, and note that agents' browsers linger after
their runs finish — check immediately before starting the gate, not five minutes earlier.

**1. `gate.mjs` writes to FIXED output directories, so parallel runs eat each other.** Every invocation
captures into `tools/out/gate-high` and `tools/out/gate-low`. Two agents and the orchestrator each ran
the gate at once; their bursts interleaved in one directory and their browsers killed each other. The
result looked like a real regression: `GATE FAIL`, `BLOBCHECK FAIL`, and
`pointer lock check errored: Target page, context or browser has been closed`. Re-running `blobcheck`
against the *same directory* minutes later returned `PASS (60 frames)`. **Only one party runs the gate
at a time — the orchestrator, at the end.** Builders run their own scoped bursts into their own
`--name` directories instead.

**2. A truncated capture used to be reported as a blob, and now is not.** `blobcheck` scopes both of
its tests through `mask-*.png`. A colour frame whose mask never got written is judged against the WHOLE
frame, and the first thing that finds is the sky — a warm `(243, 210, 157)` cluster at `y = 7..23`. That
false positive has now cost two investigations. `tools/blobcheck.py` therefore refuses to judge a run
with missing masks: it prints `BLOBCHECK INCONCLUSIVE (harness, not the game)`, names the unmasked
frames, and **exits 2** — distinct from exit 1, which still means "found a blob". If you see exit 2,
the capture was cut short; reap orphaned `chrome-headless-shell` and re-run. The selftest was re-run
after this change per `CLAUDE.md` and still catches painted ground blobs.

**3. OPEN — `blobcheck`'s BRIGHT test false-positives on very pale ground cover at `q=low`.** Measured
at the Sundered Spire's sandy plateau (`tools/out/stele-blob-low`, prefix `burst-stelelow`): three
clusters, largest 32 px, mean rgb `(223, 219, 210)`, masks present, so this is NOT case 2. Cropping the
pixels shows **pale sunlit sand with tan reed blades** — the ground itself crosses `LUM_BRIGHT` without
anything emissive being involved. It is a genuine limitation of a luminance bar on near-white terrain,
not the washed-white-blob bug the decree is about. The standard gate route never walks that ground,
which is why it has never surfaced. **Do not fix this by lowering the bar** — thresholds are
orchestrator-owned and weakening them is how a gate stops catching the real thing. The honest fix is
scoping the BRIGHT test by *local contrast* rather than absolute luminance, so a blade brighter than
its surroundings is caught while uniformly bright ground is not. Nobody owns that yet.

### 4a-quater. `{key: ...}` STEPS DO NOT REACH DOM KEY HANDLERS (2026-08-23)

`tools/inspect.mjs`'s `{key: code, down: bool}` step calls `Input.press()`, which drives the GAME's
input system. It does **not** dispatch a DOM `KeyboardEvent`. So anything listening on `window`/
`document` for real keys — `Screens.js`'s `_onKey`, which owns the M / C / I / K / J tab switches —
never hears a harness keypress.

**What that quietly produced:** every screenshot anyone has taken of a "second" full-screen tab was
actually the FIRST tab. It was caught because `tools/out/invchar/shot-character.png` is byte-identical
to `shot-inventory.png` in the same run: the `KeyC` step did nothing and the capture is the inventory
screen wearing a character-screen filename. Assume any historical screenshot of a non-default tab is
suspect unless the image itself proves otherwise.

**Real keyboard input was never broken** — only the harness path. `Screens.js` now polls the game input
system from its own rAF, gated on `g.auto`, so `?auto=1` runs can switch tabs while a real player keeps
the single `_onKey` handler with nothing racing it.

**How to check you are not fooling yourself:** compare file hashes across a multi-shot run, or assert a
state change in an `{eval: ...}` step rather than trusting the image. Generally: a screenshot proves a
render, never that the input that was supposed to produce it landed.

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

## 4l. The intro's late swap, 2026-08-23 — arm() was the first draw of the world (FIXED)

Complaint: "the screen that should swap over just as it hits 100% swaps too late and looks clunky."
`tools/introprobe.mjs` is the instrument for this — `hitchhunt.mjs` can only attach after the game loop is
running, so it is blind to the entire loading screen. introprobe installs a frame recorder via
`addInitScript` BEFORE page load and hooks the intro's own `setProgress`/`arm`/`play`, recording a program
count with every event.

**Measured cause.** Nothing draws the game world before `game.start()`, and with the intro that does not
happen until the hand-off. So `arm()` -> `IntroHost._shipFrame()` -> `stepInto` was the **first time the
world had ever been rendered**, and it linked 27 shader programs in one blocking call:

| | before | after |
|---|---|---|
| `arm()` cost | 6955 ms | **11 ms** |
| bar reads 100% -> clickable | **9631 ms** | **20 ms** |
| total time to clickable | 21402 ms | 21537 ms |

Fix: `IntroHost.prewarm()` / `Intro.prewarm()` render that frame under the loading bar instead, and the bar's
last slice now reports the shader warm so 100% means "you may click" rather than "the systems are up".

**Three things here that cost time to learn:**
- **The intro monitor draws to the CANVAS** (`stepInto(dt, null, ...)`), so it needs the `srgb` program
  variants — a DIFFERENT set from the composer's `srgb-linear` (4j). That is why warming the game's own path
  never covered it, and it means the `srgb` twins are not always waste: the intro genuinely uses them.
- **Warm what you will actually draw.** A warm pass through `game.camera` into a small target linked only 8
  of the 27; `arm()` draws through a 58 deg menu lens into a 1536x864 target. `prewarm()` is therefore the
  same method `arm()` calls, not a lookalike, so they cannot drift apart.
- **Order: warmScene BEFORE prewarm.** Running prewarm cold (to make the pause land earlier in the bar) made
  it link everything itself — 9.5 s instead of 6.3 s, ~8 s onto the whole boot for a cosmetic gain. Reverted.

**Still open:** the bar pauses ~7-8 s at ~94% for that one render. It is a single `renderer.render()`, so it
cannot be sliced — the loading screen stops for it either way; all that was chosen is WHERE. The real cure is
to route the intro monitor through the composer so it reuses the already-warm `srgb-linear` programs and only
the final fullscreen pass is `srgb` — but that changes how the monitor looks (tone mapping, post effects) and
is a design call, not a perf one.

**A drift trap this session walked into, twice.** After the intro change the no-intro boot measured 21.6 s
against 11.6 s before it, which looks exactly like a 10 s regression. It was not: an interleaved A/B against
`main` on a quiet box gave main 16.6/14.8 s and the branch 17.8/14.3 s — overlapping — and the two builds'
JS bundles differ by 1004 bytes with identical chunking. **Cross-run boot comparisons on this box are
worthless (4d), and 18 orphaned `chrome-headless-shell` processes were inflating everything (4b).** Kill the
orphans, then interleave, before believing any boot number.

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

**Not started** — world bosses with mechanics, story mode. (Voiced NPCs are RETIRED, not pending: the
user decided 2026-08-23 that quests are written. See `CLAUDE.md` and invariant (j).)

**DELIVERED 2026-08-23 — loot, ammo, quests, density.** Spec: `docs/LOOT-QUESTS-BRIEF-2026-08-23.md`.
- **Ammo economy** (`src/rpg/ammo.js`). `Weapons.addAmmo` had existed since the weapons wave with **no
  caller**, so a dry gun stayed dry until you died. Two brick types (light = 12% of `maxReserve` on both
  slots, special = 25% for shotgun/sniper/fusion/beam) and a **dry-guard**: at 0/0 on every slot the next
  kill drops one guaranteed brick at your feet. Three bugs were found by TESTING, each of which already
  had a passing report attached: `Weapons.give()` reset `reserve` on every pickup (a loot weapon
  confiscated your ammo, AND a dry player got a free top-up — which is precisely what faked the first
  passing dry-guard test); the dry-guard fired once per corpse, so clearing a camp took reserves 0 ->
  maximum, an ammo faucet spelled "run out first"; and `ctx.weapons` exposed no `reload`, so the
  auto-reload-on-pickup would have silently no-opped forever.
- **Quests are DATA and are WRITTEN** (`src/rpg/quest.js` + `src/rpg/quests/`). 55 quests across ten
  regions, five objective types (kill / collect / slay / reach / escort), each region's chain ending on a
  `reach` at the next region's landmark, so the route through the world IS the content.
  Givers are **Wayfinder Steles**: `props.steleAt(region)` -> `props:stele` event -> `quest.readStele`,
  with a region auto-offer fallback for any region whose stele is missing.
- **Escorts are real escorts**: `enemies.spawnFriendly('wisp', from, {to, hp, tag})` walks a guide that
  hostiles aggro and that CAN DIE; death fails the quest, and a failed quest never enters `done` so it
  stays re-acceptable. It carries a HUD frame (`hud.showGuide` / `hideGuide`) with a live health bar,
  because an escort whose health you cannot see is a `reach` quest in a costume.
- **Density** 40 -> 72 alive, three camps per outer region plus roaming packs, paid for by an extended
  LOD ladder. **Measured with a CONTROL** — see the comment above `MAX_ALIVE` in `Enemies.js`: the raise
  costs 0.01 ms of mean, and the uncapped p99 miss is pre-existing at BOTH caps, so it is not this change.
- **`LEVEL_XP`** added to `defs.js` (xp was flat while hp and damage scaled with level) and `RPG.js` now
  reads `enemy.xp`, not `enemy.def.xp` — without that second half the first half is a no-op.
- **The mechanics gate now exists**, and it did not before. `tools/curvecheck.mjs` (pure node, ~1 s, runs
  in CI: xp curve closes, bands contiguous, every enemy/item a quest names exists, no raw ids in
  player-facing text, objective mix, drop rates and pity — deterministic via five fixed seeds and a
  median, after the first version flaked 1 run in 4 on sampling noise) and `tools/questgate.mjs` (drives
  the live game: ammo returns after running dry AND is not a faucet, every objective type accepts, ticks,
  turns in and pays, no leak). `CLAUDE.md` carries the three-gate sign-off decree.

---

## 6. The site and the title screen (do not undo these)

### 6.0 Two pages, and the game is at /play/

`/` is **cadle.gg, a real marketing site**. `/play/` is the game (`play/index.html` -> `src/main.js`).
`vite.config.js` lists both as build inputs. The landing page's Play button goes to **`/play?start`**,
which is exactly "open /play and press Play": `play/index.html` puts the screen into its loading state
during parse (so the menu never flashes) and `Menu.init()` calls `play()`. Both pages draw the same vista
on the same shader and the landing page fades only its TYPE out before navigating, so the hand-over reads
as a dissolve rather than a page load.

**`/play` with no trailing slash needs help in two places** and both are done: a tiny dev-server
middleware in `vite.config.js` (without it Vite 404s and the SPA fallback serves the LANDING page back —
the Play button looped to itself, measured) and a `RewriteRule` in `public/.htaccess` for Apache.

### 6.0b cadle.gg itself

One document (`index.html`, inline CSS, no framework, no webfont), plus four small modules under
`src/site/`. It never constructs a renderer, never imports three, never preloads a game asset.

**The world behind the page.** ONE fixed full-viewport canvas (`scene.js`) running the SAME shader the
title screen uses (`ui/menu/backdrop.js`, same worker), and every section carries a `data-place`. As a
section takes the middle of the viewport the canvas CROSS-FADES to that place's frame — scrolling the
site is flying across the map, and the region rail steers it directly. `Backdrop.crossTo()` is the whole
trick: upload into whichever of the two textures is currently hidden and send the mix to it, so an
arbitrarily long chain of images costs two textures and one uniform. The worker does the fetch and the
decode (`{type:'layer', url}`), because decoding a JPEG on the main thread is a dropped frame at exactly
the moment the user is scrolling. It pauses when scrolled past and on tab hide.

**The component set is the game's** — see `src/site/ui.js`. Same `--spring` token as `ui.css`'s UI KIT,
same beUI vocabulary: the segmented control in "What you do" is a FLIP (motion's `layoutId` by hand), the
gallery opens the game's own centre-morph modal, gold corner studs and all.

**The page is about the GAME, not the engine (user note, 2026-08-28).** The first version of it led with
draw calls, triangle counts, an fps target and a list of rendering techniques. Nobody choosing a game
cares. It now leads with what you do — 8 weapon archetypes with their real names, the four abilities with
their real cooldowns, five loot tiers, 65 quests, 25 named creatures by region, and two bosses. Every one
of those facts was read out of the running game (`__game` on the newest dev server), not written from
memory. The only tech claim left is the one that is a player benefit: free, in the browser, no install.
If you add a section, ask whose problem it solves — the player's or the author's.

**Immersion pass.** A reticle replaces the cursor (fine pointers only, off under reduced motion — the
`has-reticle` class is what hides the native one, and it is only ever added when the replacement is
actually running). The game's own menu blips fire on hover and click. A sound toggle in the bar streams
the REAL region theme and follows the backdrop as it travels — hero plays `night`, the Infernal section
plays `forge`, dragging the rail to Frostveil plays `frost` — nothing fetched until the visitor asks.
Images fade in off `load` instead of popping. The gallery arrows and keyboard through six frames. A
hairline under the top bar tracks scroll. Both pages finally have a favicon (inline SVG, no request).

**The rail** (`rail.js`) is ten cards on a shallow cylinder with drag, flick inertia, wheel, arrows and
dots. It WRAPS (`wrap()` folds the index distance into [-n/2, n/2)) — without that the first card sits in
the middle with an empty half-screen beside it. One float of state; every card is one transform write.

Three things that cost real time and are now commented in place:
* `body` must stay TRANSPARENT. `#ground` and `#scene` are its children at negative z-index, so an opaque
  background on `body` paints straight over both and the page goes flat black.
* the rail needs a `.railclip` WRAPPER with `overflow:hidden`. `overflow-x: clip` on the root does not
  stop a fullPage capture reaching 4565 px, and `overflow` on the element that has `preserve-3d` flattens
  the 3D.
* `.rail`'s chrome (name, band, dots, arrows) lives OUTSIDE `.rail`, so `rail.js` looks it up on the
  section. Querying the rail returned null for all of it and the arrows silently did nothing.

Measured on the production build: FCP **376 ms** on throttled 3G, **318 KB above the fold** (296 KB of
that is the hero, shared with /play/), 15 KB of JS, scroll at mean 16.7 ms / p99 18.5 ms with 2 frames
over 33 ms in 3115. Screenshots live in `public/assets/site/` at three sizes — see ASSETS.md.

**Every harness tool appends `/play/` itself** (`tools/gameurl.mjs`), so `--url` / `CADLE_URL` still take
a bare origin. `inspect.mjs`'s served-tree guard probes the true ORIGIN, not the base's directory —
`${base}/src/main.js` would ask for `/play/src/main.js`, get the app shell, and cry WRONG TREE.

### 6.0d THE RANGE, v2 — EVERYTHING is shootable, and the reticle never changes (user, 2026-08-28)

Two user decisions tightened the toy into the site's hero feature:

* **"everything should be able to be shot".** `range.js` no longer needs a `.shootable` opt-in. A shot
  resolves in three steps: a `.beast` (it flinches / falls), else a control (it spins, then does its job),
  else the smallest SURFACE that owns the pixel — `figure, .tiltcard, .rail-card, .plate, .pane, .stat,
  .railclip, .card, #bar, footer, section`. `section` is the backstop, which is why a shot into the sky
  leaves a hole in the sky and why no pixel on the page swallows a click. A line of type additionally
  takes the shock (`.struck`, transform only — a filter on a paragraph repaints the text under it).
* **"the cursor shouldn't change just cause it goes over a model".** The reticle's hover/hot state is
  gone from `ui.js` entirely, and `html.has-reticle *{cursor:none}` replaced the four-selector list. Two
  DIRECT rules (`.beast{cursor:crosshair}`, `#gallery figure{cursor:zoom-in}`) had been beating the
  INHERITED `cursor:none`, so the native pointer reappeared on top of the custom reticle over the two
  things you most want to shoot. One universal selector cannot be out-specified by the next rule someone
  adds.

Costs that had to be paid for "anything":

* **A global decal cap.** Per-target `MAX_HOLES` 8 was enough when eight elements were shootable; with
  the whole page shootable a held trigger is unbounded. `MAX_TOTAL` 48, oldest-on-the-page first.
  Measured: 90 rapid shots into empty art -> 8 holes, +135 DOM nodes, flat.
* **`layerFor` promotes a static host to `position:relative`.** A hole is positioned against its host, so
  a static section would fling every decal out to whatever ancestor was not static.
* **No `.jolt` on a `section` / `#bar` / `footer`.** Shaking a viewport of content because someone clicked
  the background is nausea, not feedback. (`.rail` was already excluded — rail.js writes a transform to
  those cards every frame and the two together snap a card out of the cylinder.)
* **The gallery lightbox is held 260 ms** (`src/site/main.js`). It used to open in the same frame as the
  shot and land on top of the hole you had just made. Now the shot reads, then the picture expands.

Also in this pass, from the UX review (all measured, all verified):

* the lightbox is a real dialog — `role`/`aria-modal`, a visible ✕, and Tab cycling inside it. Before, six
  Tabs from an open lightbox all landed in the top bar behind the scrim, and touch had no way out at all.
* the segmented control implements the tab contract (`aria-selected`, `aria-controls`, `role=tabpanel`,
  Arrow/Home/End) instead of just claiming `role="tab"`.
* rail dots are real `<button aria-label>`s; rail cards that have rotated to `opacity:0` leave the tab
  order; the rail has an INSET focus ring (an outline would be clipped by `.railclip{overflow:hidden}`).
* **every region card deep-links into its own region** — `href="/play?start&at=<id>"`. All ten used to
  point at `/play?start`, i.e. the Vale at level 1, under a label that said "Enter The Void, levels
  34-44". Verified: `/play?start&at=void` lands at (-431, -431), `biomeAt() === 'void'`.
* **reduced motion gets the art, not a gradient.** `scene.js` gated BOTH the worker and the in-thread
  backdrop on `!reduced()`, so that visitor saw a flat purple gradient in place of all ten region vistas.
  It now paints the same `-b.jpg` the canvas would have drawn onto `#ground` as a still. Reduced motion
  is a vestibular setting, not "ship me less product".
* mobile: the nav is a scrolling row instead of `display:none` with no replacement; `height:auto` on the
  weapon and bestiary strips, because the HTML `height` attribute makes height definite and a definite
  height makes `aspect-ratio` a no-op (measured 323x428 from a 1.78 source — the gun cropped out of a
  photograph captioned about the gun).
* `.shot` was two unrelated classes — the reticle's hit-flash and the bestiary image's layout wrapper — so
  the bestiary screenshot played a brightness-1.75 flash once on load. The hit-flash is `.hitflash` now.

Checks: `tools/out/cssguard.mjs` (277 rules, last rule still the reduced-motion block),
`tools/out/rangecheck.mjs`, `tools/out/shootcheck.mjs` (headline flinches, sky takes a hole, one cursor
value `none` on all eight probes, 10 distinct rail hrefs, cap holds), `tools/out/a11y.mjs`,
`tools/out/siteperf.mjs` (mean 16.74 ms, p99 19.0, 5 frames > 33 ms in 3473 — unchanged),
`tools/out/beastshots.mjs`, `tools/out/playat.mjs`.

### 6.0k The brand mark (user ask, 2026-08-29)

New emblem, generated in Magnific and split into three counter-rotating layers - see ASSETS.md for the
pipeline and the files. Two decisions worth keeping:

* **The favicon is the mark, downscaled.** A hand-drawn "simplified sibling" for 16 px was built and
  rejected on sight: it was the flat clip-art look the new mark exists to replace. If the emblem ever
  changes, re-cut the PNGs from the master, do not redraw it in shapes.
* **The animated build goes where the mark is large.** The site's top bar uses the flat 96 px PNG; the
  three layers are 91 KB and at 24 px nobody can see them turn.

Still to do: `/play/`'s title screen sigil and the loading screen's spinner (whose comment has always
claimed it speeds up with progress and never did - drive its ring off `_shown`), and the in-game HUD.

### 6.0j The pre-launch cleanup, and two measurements that changed the answer (2026-08-29)

**With JavaScript off, the rail and the weapon strip were empty.** The ten region cards were built by an
inline script from a `REGIONS` array, so that visitor got an 840 px empty band and a dot list with no
dots; the eight weapon frames ship `data-src` with no `src`, so they were eight hollow outlines under a
headline about eight archetypes.

The obvious fix - ship the markup with a real `src` - is WRONG, and the measurement says so: above the
fold went **376 KB -> 1249 KB**. Chrome's lazy heuristic pulls in a transformed, stacked carousel card
and an image inside a `display:none` pane whatever `loading="lazy"` says, which is the entire reason
`data-src` exists on this page. So the rail cards are now real markup (they are content, and `rail.js`
reads everything off their data attributes) but keep `data-src`, and the no-JS case gets a `<noscript>`
carrying the ten regions and the eight archetypes as plain readable lists. `<noscript>` is only parsed
when scripting is off, so it costs a normal visitor nothing. Above the fold: **439 KB**.

**The long tasks were the browser, not the JavaScript.** Two on a static page, 205 ms at t=124 ms and
~123 ms later. Profiled: script self-time is 6.7% and `(program)` - parse, style, layout, paint - is
46%. So the lever is not code, it is how much document the browser has to style at once.
`content-visibility:auto` on `#gallery` took the initial task to **107 ms**.

**But `contain-intrinsic-size` has to be MEASURED, and CLS will not tell you when it is wrong.** Guessed
values (1398/1488 against a real 1158/560) made the document 1654 px taller than it is until you
scrolled far enough to lay those sections out, so the scrollbar thumb resized under the reader's hand -
with **CLS 0.000 throughout**, because nothing visible moved. Real value on `#gallery` alone: 198 px of
7069 settle, still CLS 0. Applied to `#end` too it was 486 px for no further gain, so `#end` does not
get it.

**The second long task is the feature.** Measured with the canvas on and off: 327 ms vs 77 ms - it is
the WebGL backdrop initialising, ~3.4 s after load, when the page is already readable and interactive.
Not chased.

### 6.0i The shape of the chrome, and the line that killed keyboard nav (2026-08-29)

**USER DECISION: no cut corners.** A chamfer was rolled across both the site and the game as the "house
geometry" and the verdict was that the buttons and panels "are too tryhard with the cut off top left and
bottom right corners". It is out of `index.html`, `src/ui/ui.css` (11 clips) and `src/ui/screencss.js`
(19 clips), and the `--chamfer` token is retired so nobody reaches for it again. **The house shape is a
radius from the scale, and a full pill on anything that behaves like a button.**

**The buttons are beUI's** (beui.dev/components/motion/button), in this palette, because the user named
that reference: a full pill, a metallic fill whose reflection drifts on a slow cycle, a rim and inner
surface, a highlight swept on hover, and spring states - scale 1.02 up on hover, a real press down. The
icon buttons are the same family at 40/52/34 px. Do not reintroduce a bespoke silhouette here; the ask
was explicitly for this component, not an interpretation of it.

**No em dashes anywhere a reader can see one.** 74 of them across `index.html` and the five
`src/site/*.js` modules are hyphens now. The reason is not typographic: an em dash nobody typed is one of
the clearest tells that copy was machine-written, and this page is selling a game made by people. If you
add copy, use a hyphen. (Watch the replacement itself - doing it with `\s*—\s*` eats the NEWLINE when a
dash ends a line and welds the next comment line onto the previous one. Replace the character, never the
whitespace around it.)

**`Input.js` was preventing Tab's default unconditionally, and that killed keyboard navigation across the
entire product.** One line swallowed Space, Tab, F, R, E and the arrows on every keydown at all times -
including with a full-screen RPG screen or the settings modal open. Measured: `document.activeElement`
stayed on `<body>` after ten real Tab presses in the inventory, so every focus ring in the game was
unreachable by exactly the people who need one. It is gated on `this.locked || this.synthetic` now: the
pointer lock IS the signal, because `Screens.js` calls `exitPointerLock()` whenever a screen opens. After
the fix, eight Tabs walk three distinct stops and cycle. `tools/out/tabcheck.mjs` is the check - note it
has to clear `synthetic` by hand, because under `?auto=1` the harness is legitimately driving the keys.

**Two things the site's shape work also fixed:** the hero's `text-indent:-.06em` was pushing the C of
CADLE off the left of the viewport at display size (an optical correction larger than the overhang it
caused), and the golem "floating" over the world section's bottom edge was already geometrically exact -
its seat and the section boundary both measured y=529 - but the boundary was a 35 px tonal GRADIENT.
Nothing can sit on a gradient. The scrim now holds flat and steps at the very bottom, with a two-tone
engraved rule on top, so there is an edge to sit on.

### 6.0h The loading bar, and the button that looked like a framework default (2026-08-28)

**The bar ran backwards.** `Menu.setProgress` took whatever it was handed, and FOUR independent sources
feed it: `assets:progress`, `boot:progress` (emitted per system by `Game.js` AND separately by
`Assets.js`, `World.js` and `Player.js` for their own sub-steps), then `warmScene` and `warmFrames`. Any
ordering that delivered a lower number after a higher one ran the bar the wrong way — and because the
fill is a linear CSS transition, that is not a flicker, it is a full second of the bar travelling
backwards. It is **monotonic** now: `if (p < this._progress) p = this._progress`. Add a fifth source
later and it still cannot reverse.

**And it froze.** Instrumented across a real load, the bar stood still five times, worst **3.3 s** —
which reads as a hang exactly the way a reversal reads as a fault. So the target written to the DOM is
now a little AHEAD of the truth: `_paint()` approaches a ceiling (`min(.985, p + .09)`) by 22% of the
remaining gap per tick, driven by a 400 ms interval, and the real update overtakes it. It is a crawl, so
it never arrives and never promises anything that has not happened; and it is written as a transform with
a long linear transition, so the compositor keeps it moving through a main-thread stall that would freeze
any rAF-driven version. Measured after: **zero backward steps** at both the call level and the rendered
level, longest still 2.3 s and that is up at 98%.
`tools/out/loadbar.mjs` is the check — it hooks `setProgress` AND samples the rendered transform every
150 ms, because the two can disagree and only the second one is what a player sees.

**The gold Play button read as a framework default, because it was one.** A rounded gold gradient with a
chevron built from a square with two borders rotated 45 degrees is the shape any CSS starter hands you.
It is drawn now: a cut corner top-left and bottom-right so the silhouette is not a rectangle, a struck
hairline rule set inside the fill the way a metal plate carries one, a brushed grain under the ramp
rather than a three-stop gradient, a sheen that sweeps once on hover (a transform, so it is free), a
pressed state that SINKS — the highlight moves from the top edge to the bottom and the lift goes — rather
than the usual scale-down, and a drawn arrow with a tail. `/play`'s loading track carries the same cut, so
the two pages read as the same object.

**The rule this establishes:** anything on either page whose shape is the shape CSS gives you for free —
a plain rectangle, a uniform radius, a 1px solid border with no inner rule, a rotated square standing in
for a glyph — is a thing nobody drew. The house geometry is the cut corner, the inset rule, and the gold
corner stud.

### 6.0g The sign-off loop, and the four traps it kept finding (2026-08-28)

Three senior critics — art direction, game feel, front-end — reviewed the running page in rounds, each
told not to sign off unless it beat a shipped AAA studio site. Nobody has signed off yet. What is worth
keeping is not the list of fixes, it is the four MECHANISMS underneath them, because each one produced a
fresh defect in a fresh place every round:

**1. A broad `#section img` rule eats the next prop that lands in that section.** It ate the wraith
(`#gallery img`, 1601 px wide), then the moth (`#foes .shot img`, stretched to 591x104), and the mobile
copy of the second rule still had to be fixed separately. Every image rule scoped to a section now reads
`img:not(.beast)`. **Write it that way the first time.**

**2. A state class on `.beast` must out-specify every idle it can collide with.** `.beast.grounded.idle`
is (0,3,0); `.beast.flinch`, `.beast.dead` and `.beast.respawn` were all (0,2,0), so three creatures
could not flinch, could not die, and — once the flinch was raised — never stopped flinching, because the
class was never removed. Both halves are the same trap.

**3. An HTML `height` attribute makes `aspect-ratio` a no-op.** This was found once, fixed inside
`@media (max-width:600px)`, and shipped broken at every desktop width for another two rounds: 129x428
from a 1.78 source, guns cropped out of a section arguing the guns are different. `height:auto` belongs
on the base rule.

**4. A protective WHITELIST always loses.** Bullet holes were kept off `.plate/.pane/.card` — three
elements, while 37 of 72 readable text blocks sat outside them, and the hero's own pitch measurably lost
four characters. It is inverted now: `section > .wrap,.plate,.pane,.card{position:relative;z-index:1}`
over `section > .holes{z-index:0}`, so a section's decals are behind its content by default and art opts
back out. Verified by shooting the pitch three times and reading it back.

Three more that are worth naming on their own:

* **`.rail-track` was occluding its own cards.** `inset:0` with `pointer-events:auto` at z=0 inside the
  `preserve-3d` space meant every card pushed back to `translateZ(-90/-180px)` was unclickable: a
  228-point grid found the middle card 100% hittable and both neighbours **0%** — seven region links
  keyboard-activatable, one mouse-activatable. `.rail-track{pointer-events:none}`; the drag binds to
  `.rail`, so the track never needed to be a target.
* **`.rail-card` must NOT be in range.js's `CONTROL`.** `.spun` animates a transform and rail.js writes
  an inline transform to every card every frame; the spin threw "The Void" **885 px** out of the cylinder
  before it snapped back. It takes a hole instead, like the art it is.
* **On the production artifact every Play link returned the landing page.** The `/play` rewrite lived
  only in `configureServer`. Links point at `/play/?start` now (the form that needs no rewrite anywhere)
  and `vite.config.js` has a `configurePreviewServer` so `npm run preview` can prove it.

**And the page must survive with JavaScript off.** `.reveal` shipped at `opacity:0` — 49 of 49 elements
invisible, including the h1 and both CTAs — which was also why LCP was gated on a 0.9 s transition
rather than on bytes. An inline `html.js` set before first paint does the hiding now; the reduced-motion
block has to match `.js .reveal` too, or arming it leaves 43 of them invisible for that visitor.

New checks in `tools/out/`: `linkcheck.mjs` (every Play link, real mouse, fresh page each),
`copyguard.mjs` (shoot a paragraph, read it back), `railhit.mjs` (per-card hit-test grid + spin
excursion), `misscheck.mjs` (a miss must look like a miss), `beasthit.mjs`, `hitfeel.mjs`,
`killflash.mjs`, `nojs.mjs`, `perfab2.mjs` (A/B a visual change against frame time — the lit band's
first version cost 139 dropped frames per scroll and this is how that was found).

### 6.0f The creature props, and why a hit did not read (2026-08-28)

Two user reports, both correct, and both with a single mechanical cause underneath.

**"These ones don't get shot."** They did — every click decremented hit points. What did not happen was
the FLINCH, on exactly the three creatures carrying `.grounded`:
`.beast.grounded.idle{animation:breathe}` is specificity (0,3,0) and `.beast.flinch` was (0,2,0), so the
idle won the `animation` property and the hit animation never ran. Measured: hound, golem and sentinel
moved **0.7-0.8 px** when shot (that is the ambient idle) and did not change brightness at all. `.dead`
and `.respawn` were (0,2,0) too, so the death was suppressed by the same rule — shoot a hound three
times and it does nothing, then stops responding to clicks for 26 s. The state classes are
`.beast.flinch,.beast.idle.flinch,.beast.grounded.idle.flinch` now, and the same for `.dead`/`.respawn`.
**Any state class on `.beast` must out-specify every idle it can collide with, or it silently loses.**
The other half of the trap: `.flinch` then has to come OFF again (`animationend`), or the creature that
just won the specificity fight never animates again.

**"They aren't positioned right — the one sitting down should be sitting ON the seam, not with its feet
on it and its backside in the air."** Also exactly right. A creature is placed by the part of it that
TOUCHES, and that is not the bottom of its box: a sitting golem's lower legs hang below its seat, and a
sprite carries 4-14% transparent padding under its last solid pixel because its baked shadow needs room.
So each perched creature now carries `--contact`, the fraction of its height where it meets the world,
measured off the artwork — golem `.74` (the seat), hound `.87`, sentinel `.935`, drake `.74` (claws, not
tail tip). `.beast.perched` turns that into `margin-bottom:calc((var(--contact) - 1) * var(--bh))`, so
`bottom` positions the EDGE and the margin drops the overhang past it. Verified: the sentinel's boots and
the hound's paws both land on y=970-972 at 1600x900, the same line.

**A cut-out prop must never straddle a hard edge between two backgrounds.** The sentinel was half on the
bestiary plate and half on lit grass with a 1px gold rule bisecting its chest. There are exactly three
coordinates that guarantee this by construction — a section boundary, a plate border, and a scrim
terminator — and anchoring a creature to any of them is the bug. One coherent field, and it has to touch
something.

**What a hit does now** (`range.js`): body flinch away from the shot side with a 55 ms colour blowout,
an expanding shockwave, a floating damage number offset up-left of the impact (the reticle sits ON the
impact, so a number there is a number nobody reads), a health-pip row over the creature that STAYS up
while it is wounded, 60 ms of hit-stop (120 on a kill), and a synthesized blip. Shots are alpha-tested
against the sprite — 39-56% of every creature's box is transparent air, and a click into it used to be a
free hit; it is a miss that puts a hole in whatever is behind it.

**Two things the range must not do to the site:** `.plate`, `.pane` and `.card` are NOT in `SURFACE`, so
a shot into a reading panel falls through to the section behind it — permanent 56 px decals over 15 px
body copy made three paragraphs unreadable for the rest of the visit. And `jolt` never shakes a reading
panel.

**A perf trap worth remembering:** the lit band's first version gave `#world`'s head and meta row a
2400 px-wide radial gradient each, and repainting those every scroll frame took the page from p99 16.8 ms
with zero frames over 33 to **p99 116.8 with 139 of them** — A/B measured with `tools/out/perfab2.mjs`,
which is the pattern to copy whenever a visual change might cost frames. It is two gradient layers on the
section's existing `::before` now. Same class of trap: `rail.js` writes `--veil` on ten cards every frame,
and as an `rgba()` background-colour that repainted all ten (p99 24.5); as `opacity` it is free.

### 6.0e What the second art-direction pass found (2026-08-28)

A fresh critic drove the whole site at 1600 and at 430 and came back with twelve. The five that mattered:

* **`.plate` had no background at all.** `background:rgba(9,7,20,.62),var(--glass)` is INVALID CSS — a
  `<color>` is only legal in the LAST background layer, so the entire shorthand was dropped and every
  plated section on the site was body copy sitting straight on a blurred screenshot at about 2.8:1. The
  browser does not warn; the plate still had its border and its `backdrop-filter`, so it still looked like
  a plate. **Any time a plate looks washed out, check that its `background` shorthand is legal before
  anything else.** It is one valid gradient layer now.
* **The drake was floating.** It was positioned against `#end`, which has no relationship to where the
  `.flourish` rule actually renders, so it perched on nothing. A creature that perches has to be a CHILD
  of the thing it perches on (`#end .flourish .beast.drake{bottom:100%;margin-bottom:-16px}`) — measured
  13 px of overlap with the rule at 1600.
* **The rail told you the wrong bestiary for nine regions of ten.** `rail.js` had lookups for
  `.rail-name` (an element that no longer exists), `.rail-blurb` and `.rail-band`, and none for
  `.rail-foe` — so the Vale's creature line stayed under every other region's name. The string was
  already in `REGIONS`; it just was not carried onto the card. Fixed via `data-foe` + a `foeEl` write.
* **The rail card was the only navigation control that took a hole instead of spinning** — it is an
  `<a href>`, and the primary conversion in that section. It is in `CONTROL` now.
* **The moth and the wraith had no colour** — median HSV saturation 0.03 and 0.05 against 0.23-0.50 for
  the other four, so on a gold-and-violet page they read as grey cut-outs, and the moth was the brightest
  non-type object in the hero. Both are tinted 62% toward `--aether` at bake time (a blend, not a flat
  multiply — a full multiply throws the painting away) and darkened. Now 0.38-0.42.

Also: the spin opened on `brightness(1.9)`, so a gold control read as a white bar for the first ~100 ms
(1.35 now); phone tap targets were 23 px (44 now); the gallery lightbox hold went 260 -> 520 ms because
260 was still opening the scrim while the decal was scaling in.

**Two of its findings were wrong, and are worth writing down so nobody re-fixes them:** the creature
sprites DO carry baked shadows (compositing all six over a light plate shows them; the critic sampled the
last few rows of a Gaussian tail and found alpha ~0), and the mobile nav was already fixed before the
review finished — the selector had been `#bar .wrap`, which matches nothing because `#bar` has no `.wrap`
child, and is `#bar{flex-wrap:wrap}` now.

**The weapon strip was six photographs of the same place** � identical aetheryte, identical grass,
identical hour in all six, one muzzle flash between them, under copy that says each gun is "in hand and
firing". Re-shot: six regions, six hours, six camera angles, HUD hidden and viewmodel kept, the shot
actually landing (`god(true)`/`passive(true)`, a spawned target, and a burst of frames around the trigger
because a muzzle flash lives 0.03 s and a tracer 0.14-0.25 s). 531 KB -> 354 KB. Script: `tools/out/wshots.json`.

**A standing decision, so it stops being re-raised:** the six 1600 px GALLERY frames keep their HUD on
purpose — their heading is "All of this is the game running" and their caption says screenshots from the
live build, so a HUD-less capture there would be the dishonest version. The region cards, the backdrops
and the weapon strip are all captured clean.

### 6.0c THE RANGE — the page is the shooter (user ask, 2026-08-28)

`src/site/range.js` + the THE RANGE block in `index.html`. The cursor is a reticle, a left click is a
shot, and everything on the page knows what being hit looks like:

* **controls** spin a full 360 (no back face to build, nothing can land backwards) and still do their job
* **pictures** keep the bullet hole, permanently, where you clicked — capped at 8 per target, oldest
  recycled
* **six creatures** sit around the page; hits flinch them, enough hits and they fall out of the document
  and come back 26 s later. A `N / 6 cleared` tally appears after the first kill.

**THE RULE: not one line of range.js calls preventDefault.** The listener is `capture: true, passive:
true` — it cannot delay anything. The only delay on the page is the 240 ms leave-fade main.js already had
before /play, and the spin plays inside it. A visitor who never notices the toy clicks a link and it works
at the speed it always did.

Four things this cost, all now commented in place:

* **No `filter` on an animating element.** `drop-shadow` on the six idling creatures re-ran every frame:
  scroll p99 18.5 ms -> 112 ms. The shadow is baked into the sprite and `.idle` is removed by an
  IntersectionObserver when a creature scrolls out of view.
* **`.jolt` must not touch a rail card.** The shake is a `transform` animation and rail.js writes a
  transform to those cards every frame; both together snap the card out of the cylinder for 300 ms.
  `punch()` skips the shake inside `.rail` — the hole still lands.
* **`#gallery img` was an ID selector** and claimed the creature standing in that section, stretching it
  to 1601 px across the heading. It is `#gallery figure img` now. Any broad `#section img` rule will do
  the same to the next prop that lands there.
* **The hole has to carry its own darkening AND its own bright rim.** A dark-only decal vanishes into the
  Void's night shots, a bright-only one vanishes into the meadow. The first version was 34 px with
  hairline cracks and read as dust — it is 56 px now, checked on the actual page.

`tools/out/rangecheck.mjs` drives all of it (hole lands, tab spins AND switches, creature dies, tally
counts, link still navigates) and `tools/out/cssguard.mjs` asserts the inline stylesheet still parses to
its last rule — one unterminated string in it silently dropped every rule after it and the page still
rendered, just wrong.

### 6.1 NOTHING LOADS UNTIL PLAY (user decision 2026-08-28)

Landing on `/play/` builds **no renderer, no `Game`, no 29 MB asset preload, no terrain**. Verified:
6 s after load, `window.__game.game` is undefined and the game canvas is still 300 px wide.

`main.js` has one `boot()` and exactly three callers: `menu.onPlay` (Play), `menu.finished` (skip or the
hand-off — this is how `tools/gate.mjs` and `questgate.mjs` get a game after calling
`__game.intro.skip()`), and an immediate call when there is no menu (`?auto=1`). It is idempotent.

Two traps this cost, both now commented in `main.js`:
* `menu.onPlay` must be wired **before** `menu.init()` — `?start` makes init() call play() synchronously.
* the `let game, booting` declarations must sit **above** the menu block, or that same path hits a
  temporal dead zone (`Cannot access 'booting' before initialization`).

What it costs: time-to-play is now the full ~13 s build after the click instead of overlapping with
menu browsing. What it buys is the thing that was asked for — a page that is idle until you ask it for
something. The engine's *code* is still fetched on landing (`import()` at the top of `main.js`, never
awaited), which is a download, not a boot.

### 6.2 The title screen



Replaced the cinematic bedroom intro on 2026-08-28. Menu on the left, the Vale on the right, Play sweeps
the items out and the loading bar takes their place. Files: `index.html` (the markup AND every style it
needs, inline), `src/ui/Menu.js`, `src/ui/menu/{backdrop,backdropWorker}.js`. Deleted with the old one:
`src/ui/Intro.js`, `src/ui/IntroHost.js`, `src/ui/intro/*`, `intro.html`, `public/assets/intro/` (304 KB).

**The two rules, and everything below is one of them:**

**(1) It must be on screen before JavaScript runs.** The finished title screen is markup + inline CSS in
`index.html`, so the browser paints it during HTML parse. `main.js`'s only static import is `Menu.js`,
which imports only `menu/backdrop.js` — **no three, no engine**. three, `Renderer.js` and `Game.js` are all
`await import(...)`ed *after* `menu.init()`. Put a static `import ... from 'three'` back at the top of
`main.js` and you have undone the whole thing: nothing in that file can run until the engine has parsed.
`ui.css` (40 KB, HUD-only) is loaded `media="print"` and flipped to `all` on load so it cannot block either.

**(2) Nothing it shows can be frozen by the world build.**
- The backdrop is raw WebGL2 (one program, one full-screen triangle) on an **OffscreenCanvas in a Worker**.
  `?worker=0` or no OffscreenCanvas falls back in-thread, then to the CSS gradient already on the canvas.
- Its `push` / `dim` / `warp` / `calm` ramps run **on the worker's own clock** (`RATE` in `backdrop.js`).
  The menu sends a target once and never has to be alive again. Driving them per-frame from the main
  thread would stutter them through exactly the stalls the worker exists to survive.
- The loading bar's fill is `transform: scaleX()` with a **1.1 s linear CSS transition**, and the leading
  spark is a full-width box translated by `p * 100%`. The compositor keeps interpolating both through a
  multi-second main-thread stall. Never animate that bar's `width` or `left`.

**The backdrop has three lives, cross-faded:** procedural sky (instant, no asset) -> `menu_vista.jpg`
(a still of the real game, fetched inside the worker) -> the LIVE game once the world exists. The still
was captured through the SAME camera the live backdrop uses, so the swap reads as the picture waking up.

**The live backdrop draws through PostFX, using the GAME's camera.** Not a private camera into a render
target: the composer's `RenderPass` and every effect are bound to `game.camera` at `PostFX.init`, so bloom,
godrays, AO, the ACES grade and SMAA are only reachable by moving that camera. A menu backdrop without them
measurably reads as an asset viewer, not as the game. `Menu.prewarm()` writes down what it borrows —
camera pose + fov, `sky.hour` + `sky.dayLength`, the viewmodel scene's visibility — and `_teardown()`
puts all of it back, on the hand-off path AND on `skip()`.

- **`CAM` is an OFFSET FROM THE PLAYER, and a small one (5.5 m across, 11 m back).** Terrain and Vegetation
  LOD follow `game.camera`, but **Grass builds its rings around `game.player.position`** and the player does
  not move while the menu is up. The first capture pass parked the camera 100 m out and the meadow rendered
  as a flat green lawn. Inside the 18 m near ring it is a field of blades.
- **The menu pins the clock** (`MENU_HOUR`, golden hour) and freezes `dayLength`. Without that an unattended
  title screen drifts into night in about four minutes — the day cycle is 20 real minutes.
- The player system is deliberately NOT stepped (its update drives the camera from the player's head), nor
  are rpg/audio/hud/enemies/combat.

**Pointer lock.** The lock is taken in `play()`, inside the Play click's transient activation — anywhere
later the gesture is gone and Chrome refuses. `#menu` is `pointer-events: none` except the nav and the
open panel, so a click on the art still reaches the canvas's own `mousedown -> Input.lock` path. At
hand-off, if the lock did succeed, the menu dispatches a `pointerlockchange` so the HUD (which did not
exist when it was taken) flips out of its start state.

**Harness.** `?auto=1` removes the menu entirely — the harness sees what it always saw. `?auto=1&menu=1`
runs it anyway and auto-plays 4 s after arming; `&hold=1` (or `__game.menu.hold()`) holds it for
screenshots (needs `--noready`). `__game.intro` is kept as an alias of `__game.menu` because
`tools/gate.mjs` and `tools/questgate.mjs` call `__game.intro.skip()`. `__game.menu.shot(t, over)` draws one
menu-camera frame straight to the canvas — that is how `menu_vista.jpg` is re-captured
(`tools/scripts/menu-vista.json`, see ASSETS.md).

**Graphics preset is chosen in the menu** and stored as `localStorage['cadle.q']`. `?q=` still wins.
`main.js` passes it to both `createRenderer` and `new Game(canvas, { renderer, quality })` — `Game.js`
takes `opts.quality` so the renderer and the systems can never disagree.

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

