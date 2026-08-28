# HANDOVER — Cadle

Read this first if you are picking the project up cold. It is the only thing a replacement agent gets.
Order: **§1 the job → §2 the next job (biomes) → §3 the machine → §4 the traps → §5 everything else open.**
`CLAUDE.md` is the contract (file ownership, conventions, perf budget, world layout, `window.__game` API) —
this file is state and hard-won knowledge. **Keep it current; delete what has stopped being true.**

Repo: `https://github.com/Humpalumps/Cadle`. **You are in the worktree
`.claude/worktrees/cadle-character-load-perf-ee5b7b` on branch `claude/session-e5730b`, and its dev
server is `http://127.0.0.1:5179/` — NOT 5173, which serves the main checkout.** All of this session's work is COMMITTED **and PUSHED**:
HEAD `913ed1c` on branch `claude/session-e5730b`, 31 commits, **deliberately NOT merged to `main`**.

---

## 0. WHERE THE CAMPAIGN IS RIGHT NOW - READ THIS BEFORE ANYTHING ELSE

> **Written 2026-08-27 as a deliberate HANDOVER at the end of a session. Wave 5 is BUILT, COMMITTED,
> PUSHED and JUDGED — and it went BACKWARDS (4.9/10, was 5.8, with 5 blob violations).**
> **YOU ARE THE ORCHESTRATOR.** That matters: it means you own `tools/`, `progress.html`, git and
> this file — the "never edit files you don't own" rule in CLAUDE.md binds the sub-agents you spawn,
> not you. You may edit any file; your BUILDERS may not.
> **YOUR SHELL IS PowerShell** (a Bash tool is also available; each takes its own syntax). Commands in
> this repo's older notes are written for bash — `cmd > log 2>&1 &` is a parse error in PowerShell.
> **THE CAMPAIGN METHOD ASSUMES THE `Workflow` TOOL** (fan out sub-agents, file-owned lanes). If your
> session does not have it, use the Agent tool instead and say so — every "fire this workflow"
> instruction below is really "run these agents in parallel with these prompts".
> Keep this section current after every milestone, not at session end: the user hits weekly usage
> limits and swaps in a fresh agent mid-campaign, and this file is all your replacement gets.

### WAVE 5 IS JUDGED - IT WENT BACKWARDS, AND WHY (read before doing anything else)

**Average 4.9/10, down from 5.8. Five of ten regions carry a BLOB VIOLATION; wave 4 had none.**
Full verdicts: `tools/out/wave5-summary.txt` and `wave5-verdicts.json` (I wrote these by hand from the
workflow journal - the collator agent never ran, see the takeover note below). Raw journal returns:
`tools/out/wave5-raw.json`.

**ALL FIVE BLOBS ARE THE SAME BUG, AND IT IS NOT THE PLAYER'S GUNFIRE: fighting a region's own
bestiary blows the screen to white.** Five independent critics found it separately, several with the
player never firing a shot:

| region | what they measured |
|---|---|
| dragon | a wyvern's breath attack tone-maps to pure cream-white and swallows the entire frame |
| vale | wisp bolt impact renders as a hard white core, sampled **rgb 229,238,233**, on the spawn meadow grass |
| void | riftling + voidhorror at 16-18 m; **437 additive + 291 alpha particles**; player never fired (ammo still 6/60) |
| infernal | imp/magmagolem/drake at 8-12 m, drop passive, viewport near-solid within **0.5 s** |
| lost | Stone Golem hit -> hard-edged opaque near-white egg over its chest crystal, **rgb 236,232,221**, crisp rim, no falloff |

**THE REAL LESSON, and it is bigger than the bug: `node tools/gate.mjs` PASSED while the game was in
this state.** `blobcheck` is scoped to GROUND COVER in a scripted meadow burst, so a full-screen
combat-VFX wash is simply outside what it looks at. A gate with a coverage hole reads as a clean bill
of health, and this campaign has now been burned twice by trusting a green gate over a person looking
at the screen (the other time was the animation gate passing 23/23 while creatures visibly jittered).
**WAVE 6's FIRST JOB IS TO CLOSE THAT HOLE - a combat-VFX blobcheck scenario - BEFORE any new art.**
Do not simply fix the five instances; the next uncovered scenario will do the same thing again.

**Suspects for the regression, in order** (none verified - this is where to start, not a conclusion):
enemy attack/impact VFX intensity; whatever the wave-5 LIGHTING lane changed about the environment /
PMREM to make gold read as metal (a hotter env raises everything); and the new GLB creature material.
Note `GLB_RIM_MAX` was already lowered 0.75 -> 0.30 this session, so the rim is not it.

**THE COHERENCE PASS (first ever run) is the good news and it is worth reading in full** at the end of
`wave5-summary.txt`. Its verdict: Cadle is *"unmistakably a game rather than a tech demo"* - a real
quest spine (55 written quests, a closed 1-50 XP curve, drop pity that holds), an MMO-grade parchment
map and quest log, a measurably correct Destiny-shaped movement core (walk 6.61 / sprint 10.18 m/s,
sprint FOV kick in 300 ms, ADS 220 ms, slide boosting to 11.54), and ten regions you can genuinely
WALK between - it held W for 200 seconds from the Vale meadow through a pass into the Whisperwood and
out to the world's edge with no teleport. Its blocker list: **every surface within 8 m of your face is
a flat plane with low-frequency noise on it in seven of ten regions**, the mountain ring shows
horizontal contour-line banding that reads as a texture bug, the impact decal is a 200-pixel pure-black
circle, the super is two flat yellow clip-art hands, the only NPC has no face, and creatures charging
the spawn meadow blow the grass out.

### READ THIS BEFORE TRUSTING ANYTHING BELOW SECTION 0

**Section 0 is current. Sections 2-5 are an archive and parts of them are STALE.** They were written
across earlier waves and were not rewritten when later waves changed the same files. Specifically:

- **Section 2's per-region `gap:` lists are dated 2026-08-23** and predate wave 5, which shipped
  lanes for `Terrain.js`, `Sky.js`, `Lighting.js`, `Props.js`, `Vegetation.js` and `Water.js`.
  **Use the wave-5 verdicts in `tools/out/wave5-summary.txt` for what is wrong TODAY**; section 2 is
  still good for what each region IS SUPPOSED TO BE (the spec), which has not changed.
- **Section 3 tells you to "start from the main checkout and make a fresh branch."** That is a whole
  wave out of date. You are in the `cadle-character-load-perf-ee5b7b` worktree on
  `claude/session-e5730b`. Ignore it.
- **Ports quoted in sections 3-5 (5173 / 5174 / 5198) are from earlier worktrees.** This one is 5179.
- Two counts disagree with CLAUDE.md and CLAUDE.md is the older number: enemies alive is **72**
  (`MAX_ALIVE`), not 40; the washed-white-blob bug has now shipped **six** times, not five.
- **CLAUDE.md contradicts itself on GLBs in adjacent bullets** (one says monsters/NPCs ARE rigged
  GLBs, the next says "no GLB reaches the runtime"). The FIRST is current — the route changed
  2026-08-26 and `tools/invariants.mjs` rule (n) enforces the new rule mechanically: creature GLBs
  are allowed from `Assets.js` and `src/enemies/` and banned everywhere else. Architecture stays
  procedural.
- **CLAUDE.md's three-gate sign-off lists PERFORMANCE as mandatory; the user later deferred it**
  (2026-08-26). The deferral is current — do not gate a wave on frame time. Graphics, animation and
  game-mechanics gates still bind.

### ENVIRONMENT & ACCESS - what survives a different Claude account / a different machine

**The code is safe and portable.** Pushed 2026-08-27 to
`https://github.com/Humpalumps/Cadle` as branch **`claude/session-e5730b`** (30 commits,
**deliberately NOT merged to `main`**, so main is untouched and this can be reviewed or reset away).

**Same machine, same Windows user (`ianca`), different Claude account -> everything works:**
the worktree, `~/.claude/` (global CLAUDE.md, skills, this project's memory files) and the
`TRIPO_API_KEY` environment variable are all per-WINDOWS-USER, not per-Claude-account.

**Different machine -> you must bootstrap:**
```
git clone https://github.com/Humpalumps/Cadle.git
cd Cadle && git checkout claude/session-e5730b && npm install
npx vite --port 5179 --strictPort --host 127.0.0.1 > tools/out/vite.log 2>&1 &
```
Then set `TRIPO_API_KEY` in the environment. Node 22. The harness needs `npx playwright install chromium`
if it has never run there, and it wants a real GPU (this box is an RTX 3060).

**THE DEV SERVER IS A PROCESS, NOT A FILE.** Everything in this handover assumes
`http://127.0.0.1:5179/` is serving THIS worktree. Check with `curl -s -o /dev/null -w "%{http_code}"
http://127.0.0.1:5179/` and start it with the vite command above if it is down. **Port 5173 serves the
MAIN checkout — measuring or screenshotting it tests the wrong build, and that has burned this project
before.**

**WHAT DOES NOT TRAVEL, and one of these matters:**
- **The Magnific MCP connector is account-level, NOT in the repo.** `.mcp.json` contains only `tripo`.
  So a different Claude account may have **no image generation**, which means no new CONCEPT ART and
  therefore no new creatures until it is reconnected. **Tripo is unaffected** — the REST API works off
  `$TRIPO_API_KEY` (`tools/creature-anims.mjs` uses it directly), and the doc notes the Tripo MCP tools
  401 in-session anyway, so REST is the supported path regardless.
- **Workflow runs and session transcripts are session-scoped.** Nothing in flight can be resumed by
  another session or account; re-fire from the script path instead. This is why the wave-5 judge script
  lives in the repo at `tools/out/wave5-judge-workflow.js`.
- Credit balances are on the shared Tripo/Magnific accounts, not the Claude account: Tripo ~4,150,
  Magnific ~4,400 at handover.

### ⚡ TAKEOVER 2026-08-27 EVENING (written at ~8% usage with an 8-lane build batch IN FLIGHT)

**If you are reading this cold, here is the exact state and what to do, in order:**

1. **Git state: everything up to `tools/out/wave6-build-batch.js` is COMMITTED AND PUSHED** on
   `claude/session-e5730b` (this worktree, dev server 5179 — start with the vite command in
   ENVIRONMENT & ACCESS below if `curl` on 5179 fails). Landed this session, all pushed:
   - `b2dbf49` the COMBAT GATE (tools/combatcheck.py + tools/scripts/combat-blob-steps.json + gate.mjs
     check 1b) — the wave-5 coverage hole is closed and was RED on the wave-5 build (8/10 regions).
   - `66f5569` animcheck folded into gate.mjs (check 2b). HANDOVER job 5 done.
   - `e0eecd5` the combat white-out FIX (3 builder lanes: Brush min-channel cap, pool+halo near-fades,
     preset re-authors, uGLB material ceilings, METAL_ENV skinned-mesh opt-out, AE aeKnee rolloff)
     + invariants rule (o) pinning every guard.
   - `87c494a` Assets.js keeps GLB animation clips (assets.clips(name)) + 11 animated GLBs swapped
     into public/assets/creatures/ (idle/walk/run; serpent+giant have none; wisp procedural).
   - a follow-up commit: bolt-core saturation, death-pop hued, explosion energy conservation
     (er=min(1,2.2/r)) — combat gate progression 58→47→37→44-findings-no-washes across runs
     `tools/out/cvfx-{cal,vfxlane,verify,r2,r3,r4}` (r4 worst region washFrac 0.085 vs 0.84 pre-fix;
     residuals are cores over PALE ground — snow/marble — and small; vfx lane owns finishing them).
2. **THE WAVE-6 BATCH IS RESOLVED, and the 3-lane REDO is IN FLIGHT (workflow wf_5340119f-a0d, script archived at tools/out/wave6-redo-3lanes.js; journal path pattern same as before under this session dir). If it died: same decision rule — gates + journal reports, commit what passes, revert unexplained failures.** The user's spend limit killed
   3 of 8 lanes mid-work; the other 5 returned verified reports. What happened next:
   - **COMMITTED per-lane (a0a2fc4..15460f9): terrain** (ring contour banding killed at both authors —
     never reintroduce a height-periodic term on the ring; near-field grain within 22 m; forest floor
     lift), **water** (fen tannin brown + shore soak + scum thinned; reflection cap 0.17→0.34),
     **sky** (shadowfen golden hour sun; void distance haze), **grass** (vale off neon), **weapons**
     (viewmodel night fixes; the full rebuild was already in an earlier commit).
   - **REVERTED (unfinished, unexplained, user-visible damage): enemies mixer wiring, Props.js batch,
     vfx-abilities batch.** Their partial diffs are archived at `tools/out/wave6-partials/*.patch`
     (committed) — mineable, but the REDO should start clean from the briefs in
     `tools/out/wave6-build-batch.js`. The half-wired mixer made creatures FLAIL (user saw it live) and
     one of the partials broke boot (stuck loading overlay + black composer) — both cured by revert.
   - **USER FEEDBACK for the mixer REDO (binding): the baked clips must be judged BY EYE, not just by
     animcheck** — "floppy, limbs flail everywhere, much worse than before". The redo lane must
     compare procedural vs baked per creature (gait contact sheets) and KEEP THE BETTER ONE per
     creature; a bad retarget does not ship because a gate passed.
   - **SKY LANE HANDOFF: the infernal "giant flat blue polygon" is NOT sky** — it is a world-anchored
     column of layered blue camera-facing translucent sheets with a red-orange tip (a vfx/loot-beacon
     class object), photographed in `tools/out/skyw5-wedge/`. The vfx redo lane owns it.
   - Terrain lane could not capture 3 of its after-shots (the boot breakage window); re-shoot
     sunken/fen/forest down-looks when convenient — the code paths are shared with verified shots.
2b. **REDO RESOLVED (later that evening): all three redo lanes landed, COMMITTED+PUSHED**
   (`02965f4` enemies, `165ea18` props, `107bd90` vfx). Headlines: the mixer is wired but **USE_CLIPS
   ships all-false — every Tripo retarget lost the eye A/B against the procedural gait** (sheets in
   `tools/out/eyepass-clips/`); regenerating better locomotion clips is an OPEN product question —
   with better clips, flipping a body's USE_CLIPS entry after its A/B sheet is the whole integration.
   animcheck 23/23 (serpent vertical wave + arch, wraith aux streaming, spine breath de-phase, seraph
   arm-chain trim fixes all six sentinel-body types). The infernal blue wedge was 5+ stacked unfogged
   LOOT BEACONS (dropmesh.js fogged/translucent; **ASK for rpg lane: scatter multi-drops ~2 m**).
   Firing wedge = tracer endpoint behind the eye mirror-projecting; near-plane clip in Extras TR_VERT
   fixes tracers AND beams. Impact decal rebuilt; Starfall redone, barrel warp REMOVED. Combat gate
   42→21 during the lanes; the orchestrator then fixed the two attributed residual authors (wisp
   WHITE core albedo → mid-neutral 0x8e97a8 so ecol dominates; aether-burst deep-clamp L≤0.55/S≥0.7
   for pastel glowColors; bolt-core view-normal shading in Combat.js) — verification run r5 lands in
   `tools/out/cvfx-r5/` + `cvfx-r5-check.txt`. **BOSS TIER decision (user): bosses convert at ~30k
   tris with wing/finger chains kept — docs/CREATURE-PIPELINE.md.**
2c. **QUEUE (user asks, 2026-08-27 late): after content batch 1 lands** (workflow `wf_62b76999-b8e`,
   script archived `tools/out/wave6-content-1.js` — quest !/? markers + town quests | first-person
   arms | town NPCs): (i) **BANDIT/PIRATE CAMP lane** (raider enemy types on existing GLB bodies +
   camp set pieces + quests naming them; needs enemies files free — the combat-gate closer holds
   them); (ii) **COLLISION lane** (user: "I can go through buildings / fall through floor" — audit +
   fix wall/floor colliders in Props/Vegetation via the registry, bisect prop-floor vs heightAt vs
   streaming causes, and build a tools/collidecheck probe that drives the player at every
   building/landmark and asserts no clip-through/sink; needs Props.js free — the town lane holds it).
   THEN: full gate + curvecheck + questgate capstone, THEN the Opus-high judge fleet.
2d. **CRASH RECOVERY + BATCH 3 ASSETS (2026-08-27, latest).** Claude Code crashed mid-session; the dev
   server was restarted (same vite command), the two in-flight closers (combat gate, collision) were
   unresumable and were RELAUNCHED as fresh agents inheriting their on-disk uncommitted edits
   (combat: Combat.js/materials.js/VFX.js; collision: Props.js + NEW tools/collidecheck.mjs).
   **NPC/RAIDER ASSET BATCH 3 (npcs get their own skins — user ask):** 6 Magnific concepts (~450 cr)
   at tools/out/assetgen/npcs/*.jpg (style-checked, excellent); 5 Tripo models generated + RIGGED
   (herbwife-b, merchant, mason, raider, captain — *-rigged.glb on disk, task ids in npc-*-tasks.txt,
   forge script tools/out/assetgen/npc-forge.mjs: gen|poll|rig|rigpoll|clips|clipspoll); idle+walk
   retargets (10 tasks, ~130 cr) polling. NEXT for assets: clipspoll -> optimize each via
   tools/optimize-creature.mjs (biped 15k tier) -> merge clips -> stage to public/assets/creatures/
   -> Assets.js MODEL literals -> lanes consume.
   **USER FEEDBACK QUEUE (all recorded 2026-08-27):** quest markers lagging walkers FIXED+pushed
   (live-ref glue per frame). PIRATE CAMP spec addenda: pirates SIT (drinking ale) at camp, stand on
   aggro and shoot GUNS (aether flintlock/musket style, coherent with the world); chest at each camp
   centre; named captain mini-boss per camp (captain model forged). FP ARMS still not good enough by
   the user's eye — a dedicated arms-quality redo lane is owed (judge by screenshots, not by "exists").
   ECONOMY lane owed: gold drops with ammo-style magnet pickup + vendor NPCs (ammo/weapons/armor,
   prices as data). QUEST OFFER CARD owed: E opens name/pitch/objectives/rewards Accept/Decline
   before accepting. Wayfinder STAYS as unique first-contact guide.
2e. **USER ASK (2026-08-28): PRE-JUDGE PERF PASS — the performance deferral is LIFTED for this.**
   Before the Opus fleet: `node tools/hitchhunt.mjs --route combat` on the densest case AND the hamlet
   viewpoint, fix what it blames, re-measure. Budget: mean <=7 ms, p99 <=14 ms, <=350 calls, <=4 M
   tris, memMB flat 30 s. KNOWN DEBTS going in: village angle measured 4.79 M tris (over budget —
   pre-existing 4.46 + villagers 0.34); assets payload 66.95 MB vs 40 target (boot bandwidth — webp/
   quality trim candidates); 12 villager mixers (distance-banded already); collision added ~1000
   static AABBs (broadphase, cheap). Sequence: pirates lane -> perf pass -> full gate battery
   (invariants, combat, anim, collide, meadow, pointer, curvecheck, questgate) -> Opus judges.
2f. **STATE 2026-08-28: COMBAT GATE GREEN (COMBATCHECK OK, 260 frames, 0.0% peak washFrac — the
   halo quad was the last author, pinned by a corrected bisect: toggle material.visible, not
   glowMesh.visible which Combat.update overwrites). PIRATE CAMPS SHIPPED (3 named Gloamtide Corsair
   camps: sitting/drinking crews, aether flintlocks, paying strongboxes — props:chest never paid for
   ANY world chest before, fixed — named captains, 3 quests). VILLAGERS: pruned to unique bodies,
   static only, facing root-caused (+X-authored rigs, shipped yaw was 90 deg off backwards); 7 unique
   villager bodies + raider/captain staged; re-fill lane in flight (harl/tessa/cole/pell on
   fisherman/farmwoman/guard/scholar). Full gate.mjs on this build: blob high/low clean, anim 25/25,
   combat no fails, pointer lock OK; sole red = in-gate collidecheck eval race (dedicated run all OK).
   REMAINING BEFORE THE OPUS FLEET: re-fill lands -> PERF PASS (2e) -> one quiet-GPU capstone
   gate.mjs + curvecheck + questgate all green -> judges (Opus high, script per 3 below).**
2g. **WAVE 6 JUDGED (2026-08-28, Opus fleet, 13 agents): average 4.73 — a SECOND regression
   (5.75 -> 4.90 -> 4.73), no region at the bar, best tundra 5.8, worst dragon 4.0. BUT the trend
   inside it is not all bad: blob violations 5 -> 2 (forest treant-KILL bloom, shadowfen grenade
   core), and the COHERENCE score rose 5.0 -> 5.5 with the verdict "Cadle is a real game with a real
   world in it, being sabotaged by three or four specific objects... the parts are wave-6 quality,
   the assembly is not". Full: `tools/out/wave6-summary.txt`, `wave6-verdicts.json`,
   `wave6-judge-workflow.js` (re-fire with resumeFromRunId for a wave-7 judging).
   **THE JUDGES' OWN LESSON, again: the gate could not see what they saw.** The combat suite never
   KILLED anything, never fired the player's gun and never threw a grenade, so the kill-bloom, the
   sight-post bloom and the grenade white core were all outside it. The scenario now covers kills +
   loot payout + player fire + grenade (bursts `cvfx-<region>-k`, `cvfx-pfire-*`).
   **The animation lane's find is the wave's best catch: EVERY grounded creature died as a mannequin
   tipping over** — death-window bone motion at float noise (0.001-0.009 rad/frame) passing a
   threshold set BELOW frozen-skeleton level. Fixed: 0.04-0.12 rad/frame limb collapse on 20+ types.
   **WAVE 7 = the discrete defect list, in two lanes (in flight):** combat-visual (magenta bolt lens,
   kill-VFX bloom, grenade core, the OPAQUE FILM class that is hue-legal so the detector passes it,
   bogwitch screen-wide beam, screen-edge streak, sight-post bloom) and world (Aetheryte ring has no
   collider and eats the player's head in the first 30 seconds; Cinder Maw drops you inside the world
   with lava classified as swimmable water; vale grass LOD bubble at 25-28 m that slides with the
   camera; villager facing not firing live; border content collapse). Then: re-run the extended gate,
   re-judge.
3. **Then the standing order continues: BUILD MORE BEFORE JUDGING** (user directive, with the two
   model rules in "The method" below: builders Fable-5 high, judges Opus high). Remaining backlog
   beyond the batch: whatever lanes report unfinished, then wave-5 items not in any lane (tundra
   Glacier Throne read, celestial region-wide identity, void 120 m drop rim, forest canopy leaf-card
   rectangles). Re-judge ONLY after a big batch: `Workflow({scriptPath: 'tools/out/wave5-judge-workflow.js'})`
   with every judge agent switched to `model: 'opus', effort: 'high'` (edit the script first — it
   predates that directive).
4. Keep progress.html current (user asks for it; it is served at http://127.0.0.1:5179/progress.html).

### FIRST THING TO DO ON TAKEOVER (older block, session handed over 2026-08-27 at ~3% usage)

**Everything is COMMITTED AND PUSHED: HEAD `913ed1c` on branch `claude/session-e5730b`, not merged
to `main`.** Working tree is clean,
`node tools/invariants.mjs` exits 0, and the game boots at q=high with zero page errors
(298 draw calls / 3.33 M tris, inside the 350 / 4 M budget).

**YOUR FIRST ACTION IS JOB 0 IN "NEXT JOBS" — close the gate's combat-VFX coverage hole, then fix
the five blobs. Nothing else comes before it.**

Do NOT start by re-firing the wave-5 judge workflow: wave 5 is already judged (verdicts are written
to `tools/out/wave5-summary.txt`), and re-judging a build whose blockers you have not fixed just
reproduces the same five verdicts. The judge script stays in the repo for the NEXT wave, after you
have fixed something:

```
Workflow({ scriptPath: 'tools/out/wave5-judge-workflow.js' })
```

It runs 11 agents at once (ten fresh region critics, each pre-loaded with its own wave-4 findings so
it must report whether they were CLOSED, plus the whole-game coherence agent), then the ANIMATION
inspect-and-fix lane, then a collator that writes `tools/out/wave5-summary.txt` and
`wave5-verdicts.json` in the wave-4 format. Partial output from the killed run may exist under
`tools/out/crit5-*`, `tools/out/coh*` and `tools/scripts/coh/*` - it is safe to ignore or reuse.

**THE SCOREBOARD BELOW NOW HAS A w5 COLUMN and it is worse than w4.** That is real, not a
measurement artifact — read "WAVE 5 IS JUDGED" above for why.

**Parallelism, since it came up:** the fan-out is capped by FILE OWNERSHIP, not agent budget -
per-region work all lands in the same few single-owner files (`Props.js` owns all ten landmarks,
`Terrain.js` all ground), which is why wave 5 was six FILE-owned lanes rather than ten region lanes.
Critics additionally need a FROZEN build, and every judging agent drives headless Chromium on the
real GPU (16 live Chromium processes today made an agent unable to run the gate at all). **The unlock
not yet used: the Workflow tool's `isolation: 'worktree'`** gives each agent its own git worktree, so
two agents CAN own the same file and you merge after - worth it for genuinely separable landmarks,
not for a shared helper library where every agent touches the same functions.

### The method the user asked for (keep using it)

**USER DIRECTIVE (2026-08-27 late): CONCURRENCY CAP — at most 3-4 agents running at once while the
user is at the machine (they play games on it; agent load + GPU capture bursts lag them). Queue the
rest; prefer letting a wave finish before firing the next. Harness captures are the real GPU load —
pause them on request.**

**USER DIRECTIVE 2026-08-27 (binding): BUILD BEFORE RE-JUDGING, and JUDGE ON OPUS.** (1) Do not fire
the wave-6 judge fleet until a large batch of fixes has landed — the campaign was burning most of its
credits on judging instead of building. (2) When critics/judges DO run, spawn them with
`model: 'opus', effort: 'high'` in the agent() opts (Workflow tool) — never on the default session
model; the user does not want Fable credits spent on judge sub-agents. (3) MODEL STATE 2026-08-28: **the Fable monthly spend limit was hit mid-wave-7 and the session
switched to OPUS 5** — builders now inherit the session model (omit `model`, keep `effort: 'high'`).
The earlier directive was builders on
**Fable 5 at high effort** — omit `model` (inherits the session's fable-5) and pass
`effort: 'high'` explicitly.

Break work into the smallest judgeable pieces; fan out sub-agents with strictly owned files
(`CLAUDE.md` has the table); a **fresh-context critic inspects the RUNNING GAME**, never a builder's
summary, and is harsh; the critic compares blind against real Destiny 2 / FF14 and names the single
biggest gap when ours loses. **No fixed number of rounds - loop until the critics are genuinely
wowed.** Between major waves, one fresh agent plays the whole thing end to end and judges it as ONE
experience. The user is usually away: **act, do not ask.** Report what you did and what you measured.

### Wave scoreboard (fresh critics, blind vs the real Destiny 2 / FF14)

| region | w1 | w2 | w3 | w4 | **w5** |
|---|---|---|---|---|---|
| forest | 3 | 6 | 6 | 5 | **4.5** |
| tundra | 4.5 | 6 | 5 | 6 | **5.5** |
| celestial | 3.5 | 4.5 | 6 | 6.5 | **5.5** |
| dragon | 3.5 | 5 | 4 | 5 | **4.5** **BLOB** |
| infernal | 4 | 5.5 | 6 | 6.5 | **4.5** **BLOB** |
| lost | 3.5 | 5 | 6 | 6.5 | **5.5** **BLOB** |
| shadowfen | 4 | 5.5 | 5 | 6 | **5.5** |
| sunken | 3 | (redesign) | 4 | 4.5 | **5** |
| void | 4 | 5.5 | 5 | 5.5 | **4.5** **BLOB** |
| vale | 6.5 | 7 | 5 | 6 | **4** **BLOB** |

Average 3.9 -> 5.7 -> 5.2 -> 5.8 -> **4.9 (REGRESSION)**. Nothing is at the bar, and wave 5 went BACKWARDS. Per-finding evidence:
`tools/out/wave{1,2,3,4}-summary.txt`, `wave{1,2,3,4}-verdicts.json`, screenshots in
`tools/out/crit{1,2,3,4}-<region>*/`. Wave 4 closed with a **full GATE PASS** and curvecheck OK.

### THE FOUR SYSTEMIC FAULTS behind every wave-4 LOSE (this is what wave 5 is fixing)

Reading all ten wave-4 verdicts together, the same four causes repeat in ten places. **Wave 5 is
therefore organised by CAUSE, not by region** - which also makes it file-disjoint and parallelisable,
because per-region work all lands in the same few single-owner files.

1. **Landmarks are greybox.** No carved ornament, no material truth. 8 of 10 regions. The fix is the
   shared ornament library in `Props.js` (`docs/ORNAMENT-STANDARD.md`): flute / moulding / dentils /
   coffer / relief / gold-trace / weather. **This is the wave headline.**
2. **The near field is a featureless smear** at 2-25 m (shadowfen, lost, infernal slopes, sunken
   bedrock) and there is no macro relief (dragon). Terrain lane.
3. **Noon identity fails** - void reads as a purple alpine valley, infernal shows blue sky and white
   cumulus, the mountain ring wears snowcaps inside the fire region. Sky lane (+ ring splat).
4. **Gold renders black-brown and aether washes to white.** Both are the same missing piece: metal
   with no environment to reflect goes black, and an uncapped aether clips to white. Lighting lane.

### WHAT LANDED THIS SESSION

- **`creature-glb-integration`** (`wf_6dc753f5-91b`) - **LANDED, 8 agents, 0 errors.** All 12 creature
  GLBs preload through `game.assets` (7.91 MiB, 73/73 assets in ~4.3 s, not the boot critical path);
  `glbBody.js` + `glbAnim.js` created with a runnable offline check
  (`node tools/out/glbbody-check.mjs` -> 13/13 rigs); 21 enemy types resolve to a GLB asset; one
  SkinnedMesh / one material / 3 textures each = **1 draw call per creature**.
- **`wave5-builders`** (`wf_e0b17042-114`) - **LANDED 2026-08-27, 12 agents, 0 errors.** Six file-owned lanes, one systemic fault each, each
  followed by its own self-check pass that must screenshot and fix what it sees:
  `Props.js` (ornament) | `Terrain.js`+kernel (near field, ring splat) | `Sky.js` (noon identity) |
  `Lighting.js` (metal/aether/aerial perspective) | `Vegetation.js` (canopy cards) | `Water.js`
  (the sunken staircase-of-water shot, foam, fen murk).

Both persist their scripts under
`~/.claude/projects/<proj>/<session>/workflows/scripts/*.js`; resume with
`Workflow({scriptPath, resumeFromRunId})`. Per-agent returns are in each run's `journal.jsonl`.

### BUILD HEALTH (verified by the orchestrator after wave-5 builders landed)

`node tools/invariants.mjs` -> all OK. Game boots at q=high with **ZERO page errors**, **21 enemy
types on GLB assets**, **298 draw calls / 3.33 M tris** (budget: <=350 / <=4 M).
A `vUv : undeclared identifier` shader error in the Props floor-sigil rework was live mid-wave and
the Props lane's own self-check fixed it. Kept here as a standing trap: **in three r185 the map
varying is `vMapUv` - plain `vUv` does not exist unless something declares it**, so an
`onBeforeCompile` injection that uses `vUv` compiles nowhere.

### THE CREATURE ROUTE - monsters and NPCs are rigged GLBs (architecture stays procedural)

The user rejected the procedural reconstruction output ("those models are terrible ... they aren't
even close to the glb sample"). **`docs/CREATURE-PIPELINE.md` is the definitive process** and must be
read before touching a creature or an NPC. concept (Magnific) -> Tripo `image_to_model` -> Tripo
`animate_rig` -> Tripo `animate_retarget` for locomotion -> `node tools/optimize-creature.mjs` ->
`public/assets/creatures/*.glb` -> `game.assets`. `tools/invariants.mjs` rule (n) allows
`/assets/creatures/*.glb` from `Assets.js` or `src/enemies/` and **fails the build for a `.glb`
anywhere else**, so architecture cannot quietly follow.

**Tripo version audit (2026-08-27), so nobody re-derives it:** the authoritative `model_version` enum
lives in the Tripo MCP tool schema, not the docs site (which renders empty). Newest is
**`v3.1-20260211`** and that is what we use, at `geometry_quality: detailed` /
`texture_quality: detailed` / `face_limit: 60000` / `pbr: true`. There is no v3.5. Rig side,
`v2.0-20250506` resolves server-side to `v2.5-20260210`. **Deliberately NOT used:**
`orientation: "align_image"` (would lock the model to our three-quarter concept camera),
`quad: true` (topology we would immediately triangulate, and `simplify` dissolves its edge loops
anyway), `auto_size` (redundant - we normalise to the procedural body's bind box).
**THE TRAP that reads as a dead end:** `animate_rig` MUST get `model_version` or it returns
`error_code 1004` with zero credits, which is indistinguishable from "unriggable".

### THE BESTIARY AS IT STANDS - 13 creatures + 1 NPC, all on tier

`public/assets/creatures/`. One mesh + one material each, so **one draw call each**.

| creature | tris | joints | MB | notes |
|---|---|---|---|---|
| treant | 15,000 | 32 | 1.06 | +walk/idle/run clips staged |
| golem | 14,973 | 30 | 0.88 | +clips |
| sentinel | 15,000 | 28 | 0.97 | +clips |
| warden | 15,000 | 20 | 0.84 | NEW batch 2, +clips, critic 5/10 |
| giant | ~15,000 | - | 0.73 | NEW batch 2, critic 6/10, NO clips (see below) |
| hound | 10,000 | 40 | 0.79 | was 101 joints, +clips |
| drake | 10,000 | 52 | 0.84 | +clips |
| wraith | 10,000 | 37 | 0.74 | was 94 joints, +clips |
| frostwolf | 9,992 | 30 | 0.75 | +clips |
| riftling | 10,000 | 45 | 0.69 | +clips |
| serpent | ~10,000 | - | 0.69 | NEW batch 2, critic 7/10, NO clips |
| sprite | 4,606 | 27 | 0.40 | +idle/walk |
| wayfinder (NPC) | 15,000 | 23 | 0.68 | NEW - replaces the vale blocker's "flat face slab" |

**wisp stays PROCEDURAL by user decision** - it is a glow orb, not a mesh.

**Both batch-1 optimiser issues are CLOSED (2026-08-27).** (1) The simplify ratio was computed from
`count()` evaluated *before* `weld()` in the same transform chain; a Tripo export is non-indexed so
the base read ~2x high and everything shipped 1.3-5x over tier. Weld now runs in its own pass and
simplify iterates to convergence. (2) `tools/creature-joints.mjs` prunes skeletons at conversion
time - keeps every `tripo::*` structural joint, everything carrying >=1.2% skin weight and their
ancestors, folds dropped joints' weights into the nearest kept ancestor and re-parents children with
the matrix composed, so every surviving bone's world bind pose is bit-identical and the inverse bind
matrices are a plain row subset. It is animation-aware: when clips are present it only drops LEAF
joints, because folding a dropped joint's rest transform into a child would silently invalidate any
channel writing an absolute local T/R/S to that child.

**Baked locomotion landed**: 29 clips over 10 creatures via `tools/creature-anims.mjs fetch|merge`
(~390 credits). Verified: clips survive decimation, root motion is ~0.01 units (Tripo bakes in
place, so a clip cannot fight the AI-driven `root.position`), +0.2 MB per creature.
**Staged at `tools/out/anims/*.glb`, NOT yet swapped into `public/assets/creatures/`** - deliberately,
because the integration workflow was consuming those files. **Swapping them in and wiring an
AnimationMixer that blends idle/walk/run by `e.speedN` is the next creature job.** Attacks, stagger
and death stay PROCEDURAL by decree (a baked clip cannot be cut off mid-swing, and attack timing has
to line up with damage windows and telegraph frames).

**serpent and giant have no reachable rig task id** - the batch-2 forge only persisted
`warden-rig.json` - so they cannot get retargeted clips and run on procedural animation. That is
acceptable (a serpent is a `chainWave`; a slam boss attacks procedurally anyway).
**ALWAYS write `<name>-rig.json`.** Recorded ids: `tools/out/assetgen/creatures/rig-tasks.txt`.

**What every batch-2 critic independently said**, and it is a MATERIAL-stage fix, not new art:
surfaces read as glossy vinyl, and the gold filigree arrives as desaturated beige. The fix is a
roughness floor plus an albedo saturate/darken on the accent, in `src/enemies/materials.js`.

### THE ANIMATION GATE (new 2026-08-27, user ask: "proper inspection and fix of animations")

`node tools/animcheck.mjs [--types a,b,c] [--calibrate]`. It is now **gate 2b in the CLAUDE.md
sign-off** and must exit 0 for any creature you touched. It does NOT judge pixels: it reads the live
bone hierarchy while the AI drives the creature and fails on T-pose (never leaves bind),
frozen-while-moving, foot slide (limb rotation per metre travelled), moonwalking (facing vs
velocity), sunk/hovering feet (lowest bone Y vs `terrain.heightAt`), size mismatch vs
`def.height * def.scale`, dead idle, flat attack, and a death that never plays. Screenshots are
captured only to show WHY a number failed. **Thresholds in its `LIMITS` block are orchestrator-owned
- run `--calibrate` to read the numbers, never widen one to turn a red build green.**
**CALIBRATED AND PASSING 2026-08-27: 23/23 clean** (`tools/out/animgate/anim-report.json`). That is
the first mechanical proof the bestiary actually animates: no T-poses, no foot slide on any walker,
no sunk or hovering feet, no moonwalking, sizes correct, every attack animates or telegraphs, every
death plays. Sample numbers for a healthy creature (hound): facing 1.00, groundGap -0.054 m,
limbPerMetre 7.45, bindDelta 0.71 rad.

**Calibration corrected three false-positive classes in the gate itself - do not reintroduce them:**
(a) FOOT SLIDE is walker-only; the first full run failed exactly five creatures and all five were
flyers (wisp, imp, drake, skyserpent, leviathan) - a serpent has no legs and a wisp is a glow orb.
Flyers and limbless bodies get a RAILS check on whole-body deformation instead. (b) FLAT ATTACK
compares against IDLE, not against locomotion - a melee creature attacks from its standoff ring with
its legs planted, so locomotion is the wrong comparand and it failed a hound whose attack was fine.
(c) An attack counts as animated if it moves bones **OR** raises `e.telegraph` - a wisp/imp
telegraphs with emissive and scale, not with its skeleton, and a bone-only gate called it flat for
doing exactly what it was designed to do.

### CREATURE ANIMATION - what the user found by eye, all four fixed, one thread still open

**The general lesson, which is now written up properly in `docs/CREATURE-PIPELINE.md` ("TWO BUG
CLASSES THE USER FOUND BY EYE THAT EVERY GATE MISSED"): a 23/23 gate PASS meant the creatures
animated CORRECTLY, not WELL.** Every fault below was invisible to every metric we had and obvious to
a person looking at the game for ten seconds. Read that section before wiring any new creature.

1. **Swaying/jittering on the spot - FIXED.** `Enemy.js` rate-limits `_animate` by camera distance and
   HOLDS the pose between updates rather than interpolating, while `_move` keeps gliding the root
   every frame. Full-rate animation ended at **12 m**. Measured per-frame bone delta at 20 m was
   `0.107 0.001 0.107 0.001` - every other frame held. Bands widened to full rate < 30 m, every 2nd to
   50 m, 3rd to 110, 6th to 220; affordable because the joint prune cut hound 101 -> 40 and wraith
   94 -> 37. Verified `_animate` now runs 60/60 rendered frames at lod 0.
2. **A membrane tearing between the hound's tail and its right hind leg - FIXED.** `chainWave()` ramps
   amplitude per segment (`amp * (0.6 + i*0.3)`) and those rotations SUM down the chain. Tuned against
   3-bone procedural tails (sum 2.7); Tripo hands back 6 (hound) and 7 (riftling), i.e. sums 8.1 and
   10.5, so the tail curled ~120 degrees into the haunch. Normalised by chain length INSIDE `wave()`
   in glbAnim.js, which fixed the aux-chain caller for free. **Cleared the joint prune of causing it**
   by measuring skin influence spread before/after: the prune IMPROVED it (hound 8.03% of verts with
   influences >0.35 m apart -> 0%).
3. **"A light glow which bulges as he moves" - FIXED.** A GLB body has `vGlow` 0 everywhere (no aGlow
   attribute), so `uRim` was not picking out crystals as it does on a procedural body - it lit the
   WHOLE silhouette, and the time `pulse` in materials.js made it breathe. `GLB_RIM_MAX` 0.75 -> 0.30.
   A rigged creature's aether read must come mostly from its albedo.
4. **"The movement of the 4 legs is a bit off" - FIXED.** Phasing was already correct (`off =
   (front === left) ? 0 : PI` is a proper diagonal trot, FL+HR / FR+HL) and `boneAxes` correctly maps
   world axes into each bone's parent frame, so mirroring was fine too. It was pure AMPLITUDE:
   `legSwing 0.55 * (0.10 + 0.90*sp)` gives ~10 degrees of hip swing at patrol speed and ~31 flat out,
   where a real quadruped swings 45-60. Now `0.92 * (0.34 + 0.66*sp)`. Verified visually against a
   12-frame gait contact sheet (`tools/out/houndrun2/gait-sheet.png` vs the before at
   `tools/out/houndrun/gait-sheet.png`).

**STILL OPEN - flyers strobe.** After the band fix `tools/out/animfull2` still failed
`hound, sprite, skyserpent, magmagolem, leviathan, riftling` on STEPPED POSE, and riftling's reading
is unambiguous: **50% of frames held, alternating 100% of the time, at 19 m** - where `animEvery` is
definitionally 1 and `_animate` was measured running every frame. So there is a SECOND rate limiter
somewhere in the flyer/hover path (most of the failures fly), and it is not `Enemy.update`'s
`animEvery`. Find it. The gate now also requires ALTERNATION as well as held frames, because a
creature that damps to rest at its standoff ring is legitimately still and read 32% held at 4 m -
settling is not strobing.

### WHAT THE INTEGRATION REPORTED THAT MATTERS LATER (do not rediscover)

- **`wayfinder.glb` is on disk but NOT referenced by `Assets.js`** - it was not in the contract's key
  list. Add it when the NPC is wired (Props.js owns the Wayfinder).
- **Invariants rule (n) matches a LITERAL path**, so the 12 model URLs in `Assets.js` are spelled out
  one by one on purpose. A template like `` `/assets/creatures/${name}.glb` `` FAILS THE BUILD. Do not
  "tidy" them into a loop.
- **The ORM texture is bound twice per material** (roughnessMap AND metalnessMap), so the GPU warm
  loop de-dupes with a Set - 36 unique textures for 12 creatures, not 72.
- **Per-model facing had to be read, never assumed:** every upright Tripo model faces +X; the
  quadrupeds and the serpent face +Z - EXCEPT the frostwolf, which is a quadruped facing +X. That is
  the `yaw` column of `GLB_CFG`.
- **Limb classification is shaky on some rigs and is worth a look** when animation quality is judged:
  sentinel's legs classified as g0.**L** and g1.**R**; giant came back g0 L4 R1 / g1 L1 R4; wraith's
  "16-joint limb" is really spine+arm+fingers on the midline; drake's WINGS are unnamed
  `bone_30..38` / `bone_42..50` so they are not in the limb set at all; golem has no `Head_` chain
  (its neck is `L1L_2`); serpent has NO spine and NO limbs, just a 9-joint tail; frostwolf's tail is
  a single joint.

### NEXT JOBS, in order

0. ~~CLOSE THE GATE'S COVERAGE HOLE~~ **GATE HALF DONE 2026-08-27 (new session): the coverage hole is
   CLOSED, the fix lanes are IN FLIGHT.** What exists now:
   - `tools/scripts/combat-blob-steps.json` — drives all ten regions: own bestiary spawned 8-18 m,
     aggroed (alert forced), one `takeDamage({amount:6})` landed on every enemy (hit-flash path), a
     late "sustain" burst so slow volleys (void: 0.7 windup + 2.2 cd + 4.5 s flight) detonate at the
     lens inside the capture, player NEVER fires. Bursts `cvfx-<region>-{a,hit,c}`.
   - `tools/combatcheck.py` — the detector. Washed = bright AND desaturated (the decree verbatim: a
     hue that survives tone mapping passes by construction). WASH >5.5% of non-sky / CATASTROPHE
     >40% of whole frame / WHITE CORE clusters (blobcheck's cluster+local-contrast machinery, scoped
     to all non-sky). numpy-vectorised, 180 frames ~19 s. `--selftest <frame>` paints a synthetic
     wash + core and asserts both caught — run it after ANY change. Fail-closed on missing masks
     (exit 2). blobcheck.py gained an `if __name__` guard so its machinery imports (selftest re-run:
     PASS).
   - `tools/gate.mjs` — new section 1b runs the scenario at q=high + combatcheck (~12 min; q=high
     only is justified: presets differ only in pixelRatio/shadows/aniso, bloom/exposure identical).
   - **Calibration on the wave-5 build (`tools/out/cvfx-cal/combatcheck.json`): EIGHT of ten regions
     fail, not five** — peak washFrac dragon .84, celestial .83, infernal .76, lost .75, sunken .63,
     shadowfen .55, tundra .31, vale white-cores at rgb(225,238,233) = the critic's sampled value;
     forest alone clean. The wave-5 critics under-sampled: every region with explosive bolts washes.
   - **Root causes diagnosed to the line** (4-agent read-only workflow, results in this session's
     journal `wf_87c26cc4-dfc`): (1) the 'explosion' preset (core 0xffffff×hdr8, flare 0xfff4d8×4)
     fires for EVERY enemy explosive bolt via 'combat:explosion' with NO near-camera fade on the
     quads — bolts detonate AT the camera; (2) 'impact-enemy' 0xffffff×hdr(6+3day) = the lost golem
     "egg"; (3) 'impact-terrain' 0xfff0d0×3 discards the element colour = the vale bolt core;
     (4) HOT_TINT only fires on exact 0xffffff and cannot cap sums; (5) 'spark-trail' 70 Hz on every
     enemy bolt stacks ~59 additive/bolt (the 'trail' preset's range-fade fix was never propagated);
     (6) additive pool shader has NO output cap of any kind; (7) GLB creatures have all-zero aGlow so
     BOTH aether caps are inert on 13 creatures, and the rim add (~1.43/ch) bypasses caps everywhere;
     (8) wave-5 METAL_ENV (2.5-3x env specular) reaches skinned creatures with ORM metalness 1;
     (9) wave-5 veil-darkening makes auto-exposure ride its 1.3x cap in void/infernal — a frame-wide
     multiplier applied before the bloom threshold test.
   - **Fix workflow `wf_c4b8377c-1cf` launched**: three file-owned lanes (vfx: Brush min-channel
     hue-preserving cap + additive-pool near-camera fade + preset re-author; materials: uGLB-keyed
     aether caps + rim/dissolve/hit-flash/telegraph caps; lighting: USE_SKINNING guard on METAL_ENV +
     AE-bloom decoupling) + a serialized verifier that re-runs the combat gate. If it died mid-run,
     resume: `Workflow({scriptPath: '<session workflows dir>/blob-fix-wf_c4b8377c-1cf.js',
     resumeFromRunId: 'wf_c4b8377c-1cf'})` — or just read the lanes' reports in its journal and run
     the verifier steps by hand (invariants → combat capture → combatcheck).
   **STATE 2026-08-27 (late): fixes LANDED and COMMITTED (`e0eecd5` fix, `87c494a` clips,
   invariants rule (o) pins every guard). Washes are DEAD** — per-region peak washFrac after the lanes
   + orchestrator follow-ups: dragon .84→.0002, celestial .83→.005, infernal .76→.0006, lost
   .75→.0004, sunken .63→.0002, shadowfen .55→.035, tundra .31→.036, void/vale/forest ≈0 (all under
   the .055 bar; run r3 = `tools/out/cvfx-r3/`). Residual WHITE-CORE clusters were traced by crop to
   THREE authors, all fixed after r3: the Combat.js bolt-core sphere (lerp-to-WHITE removed,
   min-channel cap, halo near-fade, sat 1.0 / l≤0.48 ×1.5), the spark-trail mist bleaching the bolt's
   own core (alpha 0.7→0.5), and the DEATH preset's white-hot pop (hued to the creature's element,
   hdr 5-7→3-3.5 — the tundra 22k-px "ball" was a wisp dying). Verification run r4 in flight.
   The judge fleet stays PARKED (user directive): build a big batch first, judges on Opus high.
   **r4 residual class understood: additive glows over PALE ground (snow/marble/sand) lift an
   already-bright surface into the cream band — fixed structurally with explosion energy conservation
   (`er = min(1, 2.2/r)`), bolt-core saturation, death-pop hue (commit after e0eecd5). Remaining
   combat-gate findings are OWNED by the wave6 batch's vfx lane (target: zero).**

   **THE WAVE-6 BUILD BATCH IS IN FLIGHT: workflow `wf_a359a136-2de`, 8 file-owned lanes, builders
   Fable-5 effort-high** (terrain: ring banding + region ring splat + near field | props: Elderheart,
   Kharaz-Dun doorway, lost monolith gold + aether, vale ruin plaza + aetheryte, Hagstone, Drowned
   Court, celestial isles + 8 m marble, Wayfinder placement | water: fen murk + sunken cascade shot |
   sky: infernal blue polygon, shadowfen sun, void haze | grass: vale neon retune | weapons: the
   viewmodel rebuild | vfx+abilities: combat gate to zero, impact decal, Starfall super, firing wedge |
   enemies: mixer wiring, second rate limiter, seraph rig). If it dies, per-lane reports are in the
   run's journal.jsonl; resume with the scriptPath in the session workflows dir. AFTER it lands:
   orchestrator runs full gate (all checks incl. combat + animcheck), curvecheck/questgate, commits,
   THEN the judge fleet on Opus high (script: tools/out/wave5-judge-workflow.js).
0b. ~~Read the wave-5 judge verdicts~~ **DONE** - they are at the top of this section, and
   `tools/out/wave5-summary.txt` / `wave5-verdicts.json` / `wave5-raw.json` are written.
1. **WIRE THE ANIMATION MIXER. The decisive next creature job** - it turns a smooth *procedural* gait
   into a real retargeted walk cycle, and it is what decides whether Blender+Mixamo is worth adding
   (that evaluation is in `docs/CREATURE-PIPELINE.md`, "EVALUATED AND DEFERRED"). Five steps:
   **(1) THE TRAP: `src/core/Assets.js` currently THROWS THE CLIPS AWAY** -
   `gltfLoader.loadAsync(url).then((g) => { this.models[name] = g.scene; })` drops `g.animations` on
   the floor, so swapping the animated GLBs in without fixing this looks like "the clips did not
   work". Keep them (`this.clips[name] = g.animations`) and add a `clips(name)` accessor.
   (2) `src/enemies/glbBody.js` - pass the clips onto the asset it returns.
   (3) `src/enemies/Enemy.js` - an `AnimationMixer` per instance, actions cross-faded by `e.speedN`;
   clip names as merged are `idle`, `walk` (or `quadruped-walk` on quadrupeds), `run`.
   (4) `src/enemies/glbAnim.js` - keep procedural attack/stagger/death and layer them AFTER
   `mixer.update()`, since both write bone rotations.
   (5) copy `tools/out/anims/*.glb` -> `public/assets/creatures/` (10 creatures have clips; serpent
   and giant have no reachable rig task id; wisp is procedural by decision).
   **Prerequisite:** the `animEvery` band fix is already in, but if a second rate limiter is still
   holding poses (job 2) the baked clips will strobe exactly as the procedural gait did.
2. **Find the SECOND pose rate limiter.** After the `animEvery` fix, `_animate` was measured running
   60/60 frames at lod 0, yet `tools/out/animfull2` still failed
   `hound, sprite, skyserpent, magmagolem, leviathan, riftling` on STEPPED POSE - riftling at
   **50% held / 100% alternating at 19 m**. Most of those fly, so look in the flyer/hover path.
   `node tools/animcheck.mjs` is the red test.
3. **Wire the Wayfinder NPC** - `public/assets/creatures/wayfinder.glb` exists (15k tris, 23 joints,
   walk/idle/run clips) but is not in `Assets.js`'s MODEL table and not consumed by `Props.js`.
   Closes the vale blocker's "flat face slab, gold headphone discs" finding.
4. **Fire the wave-5 judge phase** - the script is already written:
   `Workflow({ scriptPath: 'tools/out/wave5-judge-workflow.js' })`. Ten fresh region critics each
   pre-loaded with their own wave-4 findings, an ANIMATION inspect-and-fix lane, and **the whole-game
   coherence agent that plays it end to end and judges it as ONE experience** - the user asked for
   that between major waves and it has never been run. **Do not fire it against a half-written build.**
5. **Fold `tools/animcheck.mjs` into `tools/gate.mjs`** so the animation gate runs with the others
   instead of having to be remembered.
6. **Performance is a DEFERRED dedicated pass** (user call) - do NOT gate waves on it. Current live
   reading after wave 5: 298 draw calls / 3.33 M tris at q=high, inside the 350 / 4 M budget.

### Live asset accounts
Magnific ~4,400 credits. Tripo **~4,150** (`$TRIPO_API_KEY` is in the environment; the REST API works,
the Tripo MCP tools 401 in-session and need an app restart to pick the key up). Creature payload
~9.6 MB of a 40 MB budget.

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
must give `{"n":2695,"sum":164219.761892}`
(**re-baselined 2026-08-26** — the wave-3 kernel pass moved sunken/void/lost/tundra deliberately; previous figure 162867.162973. Earlier note: **re-baselined 2026-08-23.** The old figure here, 164490.108949, was stale: the ten-biome pass moved the
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

## 4m-bis. CREATURE TRI BUDGET IS TIERED (user, 2026-08-26)

Was a flat ~3.5k. Now tiered by FORM complexity: **~4k** small/ethereal (wisp, sprite), **~10k**
standard creature (hound, frostwolf, drake, serpent, riftling, wraith), **~15k** complex/armoured
(sentinel, golem, treant, warden, giant). Roughly where Destiny 2's own rank-and-file combatants sit.

Triangles were never the reason our creatures looked bad — the sentinel reads as stacked slabs at 4k
and would at 50k. Chamfered edges, relief and material are what was missing.

**The trap, and it is not obvious:** `performanceBudget.targetTriangles` selects the img2threejs
generator's tessellation tier (low <= 6000, standard <= 60000). Declaring the 4k target directly
picks the LOW tier and coarsens every curve — which is precisely how a small creature comes out
faceted. Always declare 10000/15000 and let a simple form land under its target.

**What the deferred perf pass must therefore check** (it did not exist as a risk before): `MAX_ALIVE`
is 72 and `Enemies` streams camps by distance, so a dense fight can put a lot of LOD0 bodies on
screen at once. 15k x even a dozen near bodies is 180k tris, which is fine against the 4 M budget —
the failure mode is the LOD ladder NOT falling away, not LOD0 itself. Measure a real camp fight, not
the meadow, and check LOD1/LOD2 tri counts as well as the totals.

## 4m. PERFORMANCE IS A DEFERRED PASS (user call, 2026-08-26)

During the Destiny-2-polish campaign the user decided **not** to gate each wave on performance:
"none of that seems majorly over, we can tidy up with performance and hitch afterwards." Builders
still carry the budget in their briefs and self-report, but the perf leg of the three-gate sign-off
is deliberately deferred to ONE dedicated wave at the end of the visual/content campaign.

What that wave owes, measured 2026-08-26 and not yet fixed:
- **Vegetation reports 4.2-5.0 M tris** on the densest forest views (budget 4 M). The forest south
  view was already 4.4 M before this campaign; the canopy has since been closed, so it is worse.
- **One 514 ms frame** in `tools/out/props2-hitch` with cpu 513 ms, gpu 6.3 ms and a moving program
  count — the shader-link-during-play signature (4j). Every wave has added material variants
  (per-region prop albedos, converted creature bodies); they need boot prewarm through
  `compileForComposer`, or they link on first draw mid-play.
- **hitchhunt mean 7.56 ms vs the 7 ms budget, p99 18.2 vs 14, 152 spikes (50/min)** on that run.
- Individual probes reported p99 39.7 ms (terrain) and p99 176 ms (vegetation, life) — unattributed.

Do NOT let a builder spend a wave on this before the visuals are signed off; equally, do not let the
campaign end without it.

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
- The character is **fully procedural** (`character.js`) — no model file, no loader, no placement constants.
  The generated `guy.glb` was removed 2026-08-24; with it went `GUY_FIT`/`GUY_CHAIR`/`fitGuy`/`setChair` in
  `stage.js`, the `<head>` preload in `index.html` and the `guyBuf` hand-off through `IntroHost` ->
  `introWorker` -> `Intro`. There is nothing to tune live any more: the body is authored directly in the
  room's coordinates, which is precisely what the GLB could not be (one rigid mesh, fitted by eye).
  It also restores the animation — the GLB had `skinCount 0`, so the two-bone IK arms, the breathing idle
  and the `setSuck()` reach were all dead while it was on screen.
  `intro.html` gained two dev-only handles for this work and they are worth knowing about:
  `__intro.renderer` / `__intro.composer`, and `__intro.post(on)` which toggles the effect stack **and**
  promotes `RenderPass` to `renderToScreen` — without that promotion the composer blits nothing and the
  preview silently freezes on the previous frame, which will quietly ruin any diagnostic capture.
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
