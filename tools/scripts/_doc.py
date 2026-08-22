import os
os.chdir(r'C:\Users\ianca\Desktop\fps4')
p = 'HANDOVER.md'
s = open(p, encoding='utf-8').read()

def rep(a, b):
    global s
    assert s.count(a) == 1, (a[:80], s.count(a))
    s = s.replace(a, b)

# ---------------------------------------------------------------- §2 header
rep("""## 2. THE NEXT JOB — fix all the biomes fully

The world is ten regions (`src/world/Biomes.js` is the single source of truth; `CLAUDE.md` has the map). The
border crossings, per-region music, zone cards and per-region furniture all landed. **What is left is that
several regions still do not look like the place they are named after.**""",
"""## 2. THE BIOMES — pass 1 done (2026-08-23), what is left

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
  lands on exactly 1.0 and is untouched.""")

# ---------------------------------------------------------------- per-region gap lines
rep("""- gap: the floor is a bright LAWN — it wants ferns and undergrowth and a darker ground cover. No light shafts.
  No overgrown ruins. **Never:** meadow grass at 0.85 pretending to be forest floor.""",
"""- DONE: the road fix put the trees back around you; grass 0.85 -> 0.40 and the floor layer darkened to a
  shade-green (tint 0.42/0.60/0.50); `Props.KIT.forest` now builds **fern clumps** and **elven ruins going
  under the moss** (stair blocks, jambs, fallen lintels) at n 340; fae fungus scattered through the region
  (it only ever reached the home-bowl treeline before); `gv` 0.62 -> 0.72 with `p` 0.52 -> 0.45, which
  closes the grove holes at the SAME total tree count (looking south out of the Whisperwood is the heaviest
  view in the world — see §4d).
- gap: the canopy still lets a lot of sky through, so there are no real light shafts (godrays need the
  canopy to occlude); the floor is still fairly bright green in full sun.""")

rep("""- gap: **no frozen lakes** — Winterspring's signature. No icicles, no falling snow in-region. Tightest tri
  budget in the world (~3.9 M of 4 M): check Frostveil first after ANY tree change.""",
"""- DONE: the frozen lake exists now — `bhTundra` mixed its basin to 5.2, which is 1.2 m ABOVE
  `terrain.waterLevel`, so Winterspring's signature was a dry dish; 3.35 puts ~0.65 m of ice-cold water
  over it. Pressure-ice pillars hung with **icicles** added to the kit. Needles re-tinted 1.02/1.22/1.52 —
  the old 0.74/0.88/1.06 multiplied an already-dark pine and read as summer green.
- NOT a gap: falling snow already exists (`VFX.WEATHER.tundra`, ~48/s). The old note was stale.
- gap: still the tightest tri budget in the world — check Frostveil first after ANY tree change.""")

rep("""- gap: **the heart of the region is a lava caldera, so from the middle it reads as a red desert, not black
  rock.** The charcoal floor only shows on the ash plains off-centre. The honest fix is TERRAIN SHAPE — less
  lava surface, more black rock — not another tint. Also: submerged-in-lava throws bright star flares.""",
"""- DONE, terrain shape first: `bhInfernal` used to put a 150 m-radius, 98 m-tall cone with a 62 m caldera on
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
  itself, not more tinting.""")

rep("""- gap: reads WEAK at night — brown and unlit, no gold. **Nothing is ON the isles**: no props, no encounter, no
  reward. Bridge spans still read as planks edge-on.""",
"""- DONE: the ground is marble instead of sand — `celestial_marble.jpg` is TAN (linear ratio 1 : 0.85 : 0.61)
  and the old warm tint pushed it further, which is why the Isles rendered as a beige desert; the tint now
  INVERTS the asset's hue (0.98/1.14/1.46). Each isle carries a **peristyle** (half of it fallen) and the
  big one an **altar on a stepped dais**; the void isles carry snapped pillars and orbiting rubble. Bridge
  spans got **kerbs and posts** so they read as bridges edge-on, not planks. A **gilded standard** was added
  to the ground kit (n 150 -> 260) — the gold the region is described by and never had.
- gap: the isles still read as brown discs / hats from below. The tint was raised twice with no visible
  change, so it is the SHAPE (a flat dome plus a keel) and/or `stoneMat`'s sand map, not the vertex colour —
  they want to be modelled as layered rock with a stepped underside. The plain also still reads empty from
  the middle: the colonnade kit is scattered, and it wants to be clustered into a plaza you walk to. Night
  not re-checked this pass.""")

rep("""- gap: still the flattest-reading region. The rock is grey-brown with no gold or ice accent to catch the eye,
  and there is no reason to climb — no reward, no nest encounter.""",
"""- DONE: it is alpine granite now, not a sandstone mesa. Two things did it: the key went 0xffe8c8 ->
  0xf0eeee (a warm key on warm strata was most of the problem) and the floor tint went cool
  (0.84/0.88/1.02, cov 0.60 -> 0.88). `rockCut` stays LOW (0.12) ON PURPOSE — the triplanar cliff is the
  only layer with real crag detail, and cutting it (tried at 0.55) replaced the faces with a top-projected
  texture that smears into sand dunes on a slope. Kit (n 130 -> 210) gained **dwarven gold-ore workings**
  (the accent that catches the eye) and **nests with eggs in them**.
- gap: the nests are scenery, not an encounter, and there is still no loot for climbing.""")

rep("""- gap: an endgame zone with no endgame content, and the level band 40-50 is declared but never validated.""",
"""- DONE (look only): the key went 0xffe0ff -> 0xfff2f8 and the floor tint went properly violet
  (0.56/0.62/1.42, same tan asset as the Isles, so it needs the same blue lift). It was a pink light on pink
  ground under a pink haze and the whole region read as candy.
- gap: the flagstone still reads pale lilac dust rather than worn violet stone — it wants to go darker. And
  it is still an endgame zone with no endgame content; the level band 40-50 is declared but never validated.""")

rep("""- gap: can still read too green and too bright in daylight. No hanging moss, no witchlight fungus clusters.""",
"""- DONE, and this is the biggest single change after Infernal: `bhShadowfen`'s flats sat at 3.05 with
  `waterLevel` 4, i.e. under 0.95 m of water, and the hummocks were most of the surface — so from anywhere
  but the middle it was a damp green WOOD. 2.45 puts the flats knee-to-thigh deep and leaves the hummocks as
  the only dry ground, which is the region's whole passive. Plus: grass 0.22 -> 0.12 (at 0.22 a quarter of
  the blades still survive at full height), floor tinted to olive-black peat, key 0xa8c090 -> 0x9ab488 and
  amb 0.7 -> 0.50, `fogLum` 0.42 + `skyVeil` 0.62, species pool cut to dead wood only (species 2 is a leafy
  willow and a green canopy over standing water is a wood, not a fen), **drowned snags hung with moss**, and
  **witchlight fungus** scattered on the hummocks.""")

rep("""- gap: **underwater is fog only** — no caustics, no muffled audio, no oxygen meter, and nothing down there to
  find. The best region in the world for a reward you have to hold your breath to reach.""",
"""- DONE, all four: **caustics** (two counter-drifting sine lattices sharpened with a power curve, in
  `FRAG_SPLAT`; they MULTIPLY the albedo, so they respect the sun and the shadows and cannot bloom),
  **muffled audio** (one master lowpass in `Audio.js`, 20 kHz on land, swept to 430 Hz when the camera is
  under the surface), a **breath meter** (`Player.breath`, 22 s under then 14 dps; `#bbar` in the HUD, only
  on screen while it is draining or refilling) and a **hoard at the Drowned Court** — spilled coin, broken
  chests and the crown at the foot of the throne.
- gap: none measured this pass. The caustics were added late and only checked in the region-heart shots.""")

rep("""- gap: bridge spans read as planks edge-on, and nothing is on the isles.""",
"""- DONE: bridges got kerbs and posts; the isles carry snapped pillars and rubble that never landed.
- gap: same isle silhouette problem as the Celestial Isles (see there).""")

# ---------------------------------------------------------------- §4 traps: add the contention one
rep("""### 4c. The dev server silently serves stale modules""",
"""### 4b-bis. The harness dies constantly when the box is busy — and it is not always your code

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

### 4c. The dev server silently serves stale modules""")

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('handover patched')
