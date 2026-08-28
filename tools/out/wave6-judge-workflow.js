// WAVE 6 JUDGE PHASE (judges on Opus high per user directive 2026-08-27) - pre-written so it can be fired without reconstructing it.
//   Workflow({ scriptPath: 'tools/out/wave5-judge-workflow.js' })
//
// FIRE THIS ONLY AFTER both wave5-builders and creature-glb-integration have landed and the game
// boots clean (no page errors, no shader errors). A critic judging a half-written build produces
// verdicts that are worse than no verdicts, because they get believed.
//
// Three things run here, and the third has never been done before:
//   1. ten fresh-context region critics, harsh, blind against the real Destiny 2 / FF14
//   2. an ANIMATION inspect-and-fix lane (user ask 2026-08-27) backed by tools/animcheck.mjs
//   3. THE COHERENCE AGENT: one fresh agent plays the whole game end to end and judges it as ONE
//      experience. The user asked for this between major waves and it is the only judge in the
//      campaign that can see whether ten good regions add up to one good game.
export const meta = {
  name: 'wave6-judge',
  description: 'Wave 6 verdicts (judges on Opus high): 10 region critics, the animation gate + fix lane, and the whole-game coherence pass',
  phases: [
    { title: 'Judge', detail: 'ten region critics + the whole-game coherence pass, all at once' },
    { title: 'Animation', detail: 'animcheck gate, then inspect and fix what it catches' },
    { title: 'Verdict', detail: 'collate into wave6-summary.txt + verdicts.json' },
  ],
}

const REPO = 'C:/Users/ianca/Desktop/fps4/.claude/worktrees/cadle-character-load-perf-ee5b7b'
const PORT = 5179

const GROUND = `
REPO: ${REPO}  (a git worktree - run everything from here, never cd to the main checkout)
DEV SERVER: http://127.0.0.1:${PORT}/  -- ALREADY RUNNING for THIS worktree. Do NOT start another.
Port 5173 is the MAIN checkout; judging it judges the wrong build. Every --url must say 127.0.0.1:${PORT}.

Read ${REPO}/CLAUDE.md and ${REPO}/HANDOVER.md section 0 first.

HOW TO DRIVE THE GAME:
  node tools/inspect.mjs --name <label> --url "http://127.0.0.1:${PORT}/?auto=1&q=high&at=<biome>&back=<m>&hour=<h>" --steps '<json>'
  -> tools/out/<label>/{shot-*.png, burst-*.png, report.json, console.log}. Then READ the PNGs.
  Step types are documented at the top of tools/inspect.mjs. {burst:{name,n,interval}} is how you
  judge MOTION - a single still cannot show you an animation.
  Biome ids: forest tundra celestial dragon infernal lost shadowfen sunken void (vale = default).
  window.__game: teleport, look(yaw,pitch), setHour, goto(id, back), spawn, spawnNear, lineup,
  passive, killAll, clearEnemies, give, ability, stats, biomeAt, poi.

THE TRAP THAT HAS RUINED EVERY REGION SCREENSHOT EVER TAKEN: goto()/&at= drop you ON the region's
bearing, which is exactly where the pass ROAD is - a 7 m trail with a shoulder, cut through the
middle of the region. Screenshot PERPENDICULAR to the bearing (see tools/scripts/fin/*.json) or you
are photographing the one bald corridor and concluding the region is empty.

YOU ARE A CRITIC. YOU EDIT NOTHING (the animation lane is the one exception and it says so).
Judge the RUNNING GAME, never a builder's summary. Be harsh. Compare blind against the real
Destiny 2 and Final Fantasy XIV - not against last wave's screenshots.

THE ACCEPTANCE RULE: everything must hold at THREE distances - 200 m+ (silhouette against sky,
value separation), 40 m (ornament HIERARCHY - you can SEE the carving), 8 m (material truth - stone
has veining and dirt, metal is metal, edges are chipped). Something that only works at one distance
has failed two thirds of the test.

AUTOMATIC LOSE, call it out loudly and by filename if you see it:
  - a washed-white glowing blob anywhere (the user's standing decree; a value that clips through
    ACES instead of keeping its hue)
  - a creature that T-poses, slides without cycling its limbs, sinks into the ground or moonwalks
  - geometry you can see through or walk under
  - anything that reads WORSE than the wave-4 screenshots in tools/out/crit4-*/ and tools/out/fin-*/
`

const REGIONS = [
  { id: "forest", name: "Whisperwood Deep", w4: 4.5, gap: "wave-5 biggest gap: The ground you actually walk on. In FF14's Black Shroud and Destiny 2's EDZ the 2-25 m floor carries the fidelity — layered litter and decals, exposed roots, wet patches, stones, and a value range from deep shade to lit dust — and it is what fills 60% of the screen 100% of the time. Here it is one low-frequency near-black smear (measured mean RGB 8,19,18 at the region heart) with unlit radioactive-green moss cards dropped on it. Every other finding in this region is survivable; this one is visible in every single frame. || top findings: The Elderheart still has NO readable silhouette at ANY range — the wave-4 blocker is not closed. Props.js claims a 50 m pale-silver bole with a 66 m crown clearing a 30 m; The near field at 2-25 m is a featureless smear over a near-black floor, and wave-4's 'floor crushes to near-black at the heart' is unchanged. Measured floor mean RGB(8,1; The giant flat leaf-print cards are still the near canopy — wave-4's exact finding, and now the dominant read of the region. Individual card RECTANGLES are visible hangin" },
  { id: "tundra", name: "Frostveil Tundra", w4: 5.5, gap: "wave-5 biggest gap: The Glacier Throne fails two of the three acceptance distances. At 200 m+ it is invisible on three of the four bearings I walked (a 3-pixel needle at best), so the region has no reveal; at 8 m the ice is a soft cloudy blue wash with no crystal structure, no sparkle, no chipping and no bevel on a single edge, so there is no material truth either. It only works in the ~40-80 m band on the one home bearing, and even there it reads as a stepped wedding cake with a clock tower on it, not a throne. || top findings: The region's heart is invisible from every approach that matters. Wave-4 finding (b) is NOT closed. I walked in from four bearings at 200-300 m: on the NE perpendicular t; No material truth on the landmark at 2-8 m. The ice_glacial map at close range is a soft, low-frequency cloudy blue with no crystalline structure, no internal depth, no f; Hard identity break at the tundra/celestial border: standing exactly on the bisector (biomeAt() returns 'tundra', minimap says Frostveil) the ground in front of the playe" },
  { id: "celestial", name: "Celestial Isles", w4: 5.5, gap: "wave-5 biggest gap: The architecture got carved; the world it stands on did not. Every surface that is not the gate facade or the plaza tiles is a blank — the hero's own marble at 8 m is featureless clay, the floating isles are greybox pancakes, and two thirds of the region is Vale meadow wearing a \"Celestial\" label. || top findings: 8 m MATERIAL TRUTH: TOTAL FAILURE on the hero. Standing 4-8 m from the Empyrean Gate's podium wall the marble is a flat olive-cream void with a few soft smoke ribbons. No; THE FLOATING ISLES ARE GREYBOX. The region's signature feature — 'islands adrift in gold light' — is, when you stand on one, a bald cream-tan dome with soft smoky mottle,; THE REGION HAS NO IDENTITY ACROSS MOST OF ITS AREA. At (760, 0) — 199 m from the biome centre, well inside RL_CORE 270, minimap reading 'Celestial' — the ground is fluore" },
  { id: "dragon", name: "Dragon Peaks", w4: 4.5, gap: "wave-5 biggest gap: Kharaz-Dun Gate is a wall with no gate. From every one of the six angles and five distances I photographed it (200 m / 90 m / 45 m / 35 m orbit x4 / 20 m / 12 m / 6 m), the centre of the facade is a solid, slightly-recessed ashlar panel — there is no portal, no opening, no darkness behind anything. Wave 4's complaint was \"a greybox box with a flat black rectangle for a door\"; wave 5 deleted the rectangle and shipped the box. The shared ornament library did land 30 feet away on the APRON — the paving at 8 m (D1/shot-gate-8-base.png) has real granite grain, chamfered joints and an inlaid geometric inlay, and it is the best material in the region — so the capability exists and simply was not applied to the hero surface. Everything a player travels to see is a tiled chamfered-block wall with a flat mustard-yellow band, two unequal yellow tabs and a floating yellow cube glued to it. || top findings: AUTOMATIC LOSE — washed-white full-screen blob in normal combat. A wyvern's breath attack tone-maps to pure cream-white and swallows the entire frame. This is not my abil; The hero landmark has no doorway. I orbited Kharaz-Dun Gate at 35 m through four bearings and closed to 20 m, 12 m and 6 m dead on the arrival axis: the centre of the fac; The gold is paint, not metal, at all three times of day. The cornice is a solid mustard slab with a cheap gold-nugget noise map and one flat white highlight strip — no sp" },
  { id: "infernal", name: "Infernal Wastes", w4: 4.5, gap: "wave-5 biggest gap: Fighting the region's own bestiary washes the entire screen to white and then to a flat orange sheet — for roughly half a second you cannot see the enemy, the ground, or your own crosshair; Destiny 2's fire VFX are the loudest in the genre and never once cost you the read of the arena, and ours does it with three trash mobs at 8 m. || top findings: WASHED-WHITE BLOWOUT IN NORMAL COMBAT — the standing decree, at full-screen scale. Spawn the region's own imp/magmagolem/drake at 8-12 m, drop passive, and within 0.5 s t; A GIANT FLAT BLUE POLYGON FLOATING IN THE SKY. At golden hour on the standard 120 m approach a solid, unlit, untextured blue wedge ~1000 px wide spans the upper-left thir; FIRING DRAWS A HARD-EDGED DIAGONAL WEDGE ACROSS THE WHOLE SCREEN. Holding LMB produces a perfectly straight, unfeathered polygon edge running corner-to-corner; inside it " },
  { id: "lost", name: "The Lost Realm", w4: 5.5, gap: "wave-5 biggest gap: The Lost Realm is one hue at one value — magenta stone, magenta ground, magenta wall, magenta mountains, under a generic pale sky — so nothing separates foreground from background, and the only ornament that breaks the monochrome (the gold) is broken geometry: 16 lopsided plates cantilevered into empty air on top of the monoliths. || top findings: THE GOLD ORNAMENT ON THE MONOLITH RING IS BROKEN GEOMETRY, x16, and it is the dominant midground read of the whole landmark. Each monolith's 'moulded cap' is a flat gold ; WASHED-WHITE BLOB IN COMBAT. When the Stone Golem is hit, a hard-edged, flat, opaque near-white egg (sampled RGB 236,232,221, uniform fill, crisp rim, no falloff) covers ; THE AETHER IS STILL FLAT PASTEL DECALS — wave 4's finding is NOT closed. Every aether element (the vertical bars on the drum, the pylon strips, the conduits up the shaft," },
  { id: "shadowfen", name: "Shadowfen", w4: 5.5, gap: "wave-5 biggest gap: The water — the one surface this region is named for — is a flat opaque mint-green sheet. Sixteen-metre megaliths stand in it and cast no reflection; there is no transparency, no depth gradient, no foam or wet band at the shore, the shoreline is a hard polygon polyline, and a raw screen-door dither band runs along the waterline 5-15 m in front of the player. Wave 4's blocker \"everything from 2 m to 25 m was featureless water\" is still true verbatim. In FF14's Black Shroud bogs or Destiny's Dreaming City pools the water is the thing you look at; here it is the worst-looking surface in the frame and it occupies 50-60% of every screenshot taken inside the fen. || top findings: The fen water is a flat opaque mint sheet with zero reflection, zero transparency, zero shore treatment — and a raw screen-door alpha DITHER band along the waterline that; The Hagstone landmark still fails material truth at 8 m. The bored menhir renders as a near-black cutout (albedo ~0.02-0.05) with no carving, no coursing, no chipped arri; The trilithon's 'moulded imposts' — the flagship of the wave-5 carved-ornament library — render as thin flat ribbons looping OFF the front of each shaft with a visible ai" },
  { id: "sunken", name: "The Sunken Kingdom", w4: 5, gap: "wave-5 biggest gap: The region's entire identity — a tiered cascade gorge you walk beside — is not present at ground level. The falls were placed on the r>950 edge crag and the r~500-550 ring wall, i.e. outside the body of the region; the two sites inside it are w=16 stubs at wading depth. So the player's actual experience is one flat water plane over one flat sand pan, and the \"staircase of silver water falling toward a ruined palace\" has now failed four waves running. Moving the cataracts INTO the walkable gorge, with real terraces between them, is the one change that would make this region exist. || top findings: The named acceptance shot STILL does not exist, fourth wave running: from the pass there is no staircase of water and no palace. The cascades were built onto the outer ED; The Drowned Court is still greybox with a texture on it — the wave-5 carved-ornament library did not reach this landmark. The 'court' is one module repeated four times: a; Material truth fails completely at 8 m. Column, arch ring, plinth, lintel and the floor slab all carry the SAME pale mint marble swirl at the SAME scale on vertical and h" },
  { id: "void", name: "The Void", w4: 4.5, gap: "wave-5 biggest gap: Combat bleaches the Void. Two natural enemies attacking (player never fired — ammo stayed 6/60) produced 437 additive + 291 alpha particles that tone-map to cream-white (248,243,233) balls filling the frame and an orange-brown (121,57,23) full-screen wash at noon, erasing the region's violet-black identity for the whole engagement. In Destiny 2 a Void fight stays Void-coloured; here the region's entire premise survives only while nothing is happening. || top findings: AUTOMATIC LOSE — washed-white glowing blobs, screen-filling, in normal combat. Two Void creatures attacking (riftling + voidhorror at 16-18 m) with the player NEVER firin; The 120 m drop still has no rim and is still invisible from the edge — wave-4's blocker, verbatim, unfixed. I scripted the camera to a point with a >45 m drop within 14 m; Noon identity fails the same way it did in wave 4 — the mountain ring is crisp, fully readable and SNOW-CAPPED inside the Void. At 40 m from the landmark the ring fills t" },
  { id: "vale", name: "The Vale (home)", w4: 4, gap: "wave-5 biggest gap: Every surface in the Vale is still a greybox wearing a texture. The grass shader inside 25 m and the night sky are the only two things that would survive a blind cut against FF14 — the moment you look at an object (Aetheryte, Sundered Spire, a cottage, the Wayfinder, a cliff, a tree) it is untextured primitives or one running-bond brick photo tiled over everything, with zero carved ornament, zero material differentiation, and zero relief. Wave 5's headline ornament library, near-field detail pass, foliage rework and metal/aether lighting pass are not visible anywhere in this region. All four wave-4 findings are still open, verbatim, and combat now puts washed-white flashing balls on the meadow grass. || top findings: AUTOMATIC LOSE — washed-white flashing blobs on the spawn-meadow grass during ordinary combat with the local bestiary. A wisp bolt / impact renders as a hard white core (; The Wayfinder is EXACTLY the wave-4 blocker, unchanged: a flat beige slab for a face with a painted dark bar for eyes (no nose, no brow, no sockets, no mouth geometry) an; The Sundered Spire — a RUIN — still stands on a pristine polished cream marble plaza with clean 2-3 m tiles and gold filigree vein lines, exactly the wave-4 blocker. The " },
]

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['region', 'score', 'verdict', 'findings'],
  properties: {
    region: { type: 'string' },
    score: { type: 'number' },
    result: { type: 'string' },
    verdict: { type: 'string' },
    biggestGap: { type: 'string' },
    blobViolation: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'text'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          text: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    shots: { type: 'array', items: { type: 'string' } },
  },
}

phase('Judge')


const judgeJobs = REGIONS.map((r) => () => agent(`${GROUND}

YOU ARE A FRESH-CONTEXT CRITIC FOR: ${r.name} (biome id "${r.id}").
You have no history with this project. You did not build any of it. Judge what is on screen.

It scored ${r.w4}/10 in wave 5. What wave 5's critic said was wrong with it:
${r.gap}

Wave 6 (2026-08-28) attempted: the combat white-out class killed at every author (combat gate now
0.0% washed across all regions - verify with a real fight), mountain-ring de-banding + region ring
splat + near-field grain, all-eight landmark ornament closures + a real Kharaz-Dun portal, fen/sunken
water, per-region skies, collision fixed and gated (try walking through walls), a populated hamlet
(7 unique-bodied villagers who face you, quest !/? markers, offer cards, glimmer economy + shops,
paying chests), three Gloamtide Corsair pirate camps (sitting crews, muskets, named captains), a
rebuilt viewmodel with real gloved hands, and a hitch pass (combat should never freeze). Your job is
to say whether it actually landed HERE, at Destiny 2 / FF14 quality.

DO NOT grade on effort or on improvement over last wave. Grade against the real Destiny 2 and
Final Fantasy XIV. The question is "would a player who just came off those two be impressed", not
"is this better than it was".

Cover, at minimum: the approach to the region's landmark from 200 m+, the landmark at 40 m and at
8 m, the ground directly in front of the player at 2-25 m, the sky and the haze at noon AND at
golden hour AND at night, the border crossing into a neighbour, and one fight with the local
bestiary (spawnNear + let it come at you; judge the creatures' animation as well as their looks).

Return JSON only, matching the schema. score is 1-10. result is "LOSE" under 7, "TOSSUP" at 7-7.9,
"WIN" at 8+. findings are ordered most severe first. Set blobViolation true ONLY if you can point at
a specific PNG with a washed-white blob in it, and name that file in the evidence field.`,
  { label: `crit6:${r.id}`, phase: 'Judge', schema: VERDICT_SCHEMA, model: 'opus', effort: 'high' }))


// This has never been run. It is the only judge that can see whether ten good regions are one game.
const coherenceJob = () => agent(`${GROUND}

YOU ARE THE COHERENCE AGENT, and this pass has never been run before. The user asked for it
specifically: between major waves, one fresh agent PLAYS THE WHOLE GAME END TO END and judges it as
ONE EXPERIENCE.

Everyone else in this campaign has judged a region, a landmark, a creature or a shader. Nobody has
ever asked whether the thing adds up. That is your only question.

PLAY IT, do not tour it. Start at the actual start - the intro loading screen and the spawn in the
Vale - and move through the world the way a player would: on foot, through the mountain passes,
into regions, fighting what lives there, picking up quests, using the HUD. Use long inspect.mjs
scripts with real input (KeyW, ShiftLeft to sprint, Space to jump, mouse look, fire) rather than
teleporting everywhere. Teleport only to skip distance you have already proven is walkable.

JUDGE THESE, and nothing else:
1. **Does it read as one world?** Do the ten regions feel like places in the same world, or like ten
   separate tech demos with a texture swap between them? Is the walk between two of them a JOURNEY?
2. **Style unity.** One look - painterly-realistic fantasy MMO, saturated but soft, warm golds and
   deep blue-violets, gold filigree on dark materials, luminous blue-violet aether. Does the
   procedural art sit next to the AI-generated art without either one looking pasted on? Do the new
   rigged-GLB creatures belong in the same game as the world around them?
3. **Does the moment-to-moment feel hold up over minutes, not seconds?** Destiny 2 is the bar:
   90-105 FOV, instant input response, weighty-but-snappy acceleration, sprint FOV kick, slide with
   momentum, double jump with air control, landing dip, ADS snap, per-archetype recoil, hit markers,
   damage numbers, satisfying stagger and death, the ability cooldown loop.
4. **Is there anything to DO?** Quests, progression, loot, a reason to walk to the next place.
   Does the game tell you where to go and why, in writing (quests are WRITTEN, never spoken)?
5. **Where does the illusion break?** Name the exact moments a player would stop believing it.
6. **What is the ONE thing that, fixed, would most raise the whole game?** Not per region - overall.

Take a lot of screenshots and read them. Note every hitch, pop, seam, missing collision, broken
nameplate, silent moment where music should be, and anything that made you go "what?".

Return a written report, not JSON. Structure it as: the one-paragraph verdict; a score out of 10 for
the GAME as a whole against Destiny 2 / FF14; then the six questions above answered in order with
evidence paths; then the single highest-leverage fix. Be harsh and be specific - a vague criticism
cannot be acted on and wastes the pass.`,
  { label: 'coherence', phase: 'Judge', model: 'opus', effort: 'high' })


// EVERY agent above is READ-ONLY, so they can all run at once against one frozen build — ten region
// critics plus the whole-game coherence pass, 11 concurrent. The single source-EDITING agent (the
// animation lane) runs after them, which is the only ordering constraint that actually exists here:
// a critic judging a build that is being edited underneath it produces verdicts that are worse than
// none, because they get believed.
const judged = await parallel([...judgeJobs, coherenceJob])
const verdicts = judged.slice(0, -1)
const coherence = judged[judged.length - 1]

phase('Animation')

// The animation lane is the ONE agent here allowed to edit source, because the user asked for
// "proper inspection AND FIX of animations". It runs the mechanical gate first so it is fixing
// measured faults rather than impressions.
const animation = await agent(`${GROUND}

YOU ARE THE ANIMATION LANE. Unlike every other agent in this wave you MAY edit source, but ONLY
under ${REPO}/src/enemies/ . Nothing else.

STEP 1 - RUN THE GATE, which is mechanical and does not care about opinions:
  cd ${REPO} && node tools/animcheck.mjs --name w5-anim --calibrate
It reads the LIVE bone hierarchy while the AI drives each creature and reports, per creature:
bindDelta (T-pose detection), motion while moving, limbPerMetre (foot slide), facing vs velocity
(moonwalk), groundGap (sunk/hovering feet), heightM vs def.height*def.scale, idle motion, attack
motion, death motion. Read tools/out/w5-anim/anim-report.json.
NOTE: it has never been calibrated against a clean build. Run --calibrate FIRST and look at the
numbers; if a threshold in its LIMITS block is obviously mis-set, SAY SO IN YOUR REPORT and let the
orchestrator move it. Thresholds are orchestrator-owned. Do NOT edit tools/.

STEP 2 - LOOK AT THE ANIMATION, which the gate cannot do:
Use {burst:{name,n,interval}} steps to capture motion for every creature, in every state: idle,
walking, chasing at speed, attack wind-up, attack strike, stagger, death. A single still cannot show
you an animation and has been the reason this was never caught before. Judge:
 - does the gait read as WALKING, or as a mannequin sliding?
 - do heads track the player?
 - does the attack telegraph, commit, and recover - can you tell a wind-up from a strike?
 - does death collapse, or does it snap to a T-pose and sink?
 - do flyers bank and beat, or float on rails?
 - do the feet stay on the ground on SLOPES, not just on flat meadow?

STEP 3 - FIX WHAT YOU FOUND, at the root, in src/enemies/. Then re-run the gate and paste the
result. If a creature is fundamentally broken and you cannot fix it in this pass, revert that ONE
creature to its procedural body (the fallback path is live) rather than shipping something broken,
and say which and why.

CONTEXT YOU NEED: the creatures are rigged Tripo GLBs wired in during this same session. Baked
locomotion clips (idle/walk/run) for 10 of them are STAGED at ${REPO}/tools/out/anims/*.glb but were
NOT yet swapped into public/assets/creatures/ and no AnimationMixer is wired. If the procedural
rotation gait is what is failing, wiring the baked clips is very likely the real fix - the clips are
verified good (root motion ~0.01 units, so they cannot fight the AI-driven position). Attacks,
stagger and death must stay PROCEDURAL by decree: a baked clip cannot be cut off mid-swing and
attack timing has to line up with damage windows.

Report: the gate output before and after, what you fixed, the burst paths you actually looked at,
and an honest per-creature animation score out of 10.`,
  { label: 'animation', phase: 'Animation', model: 'opus', effort: 'high' })

phase('Verdict')

const good = verdicts.filter(Boolean)
const collate = await agent(`${GROUND}

You are collating wave 5. YOU EDIT NO SOURCE. You write exactly two files:
  ${REPO}/tools/out/wave6-summary.txt
  ${REPO}/tools/out/wave6-verdicts.json

The ten region verdicts:
${JSON.stringify(good, null, 1)}

The animation lane's report:
${animation}

The whole-game coherence report:
${coherence}

wave6-summary.txt must match the format of tools/out/wave4-summary.txt exactly (read it first): one
block per region, "<id>: <RESULT> <score>/10 (was <w4>)", then the one-line verdict, then the
findings indented and tagged [blocker]/[major]. Append the animation lane's per-creature scores and
the coherence verdict at the end as their own blocks.

wave6-verdicts.json is the structured form: every region's full verdict object plus an "animation"
and a "coherence" key.

Then state, in your reply: the new average, the movement per region against wave 4, whether ANY
region reached the bar (8+), whether any blob violation was found and where, and the three things
the next wave should do. Do not soften anything - the scoreboard being honest is the only reason it
is useful.`,
  { label: 'collate', phase: 'Verdict', model: 'opus', effort: 'high' })

return { verdicts: good, animation, coherence, collate }
