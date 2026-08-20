# Performance audit — 2026-08-20 (handoff to Opus)

Measured regression after the quest/vitals/voice pushes. This doc: hard numbers, bisect data
(with one known confound), ranked hypotheses with file pointers, and the exact protocol to
confirm/fix. All measurements @1080p q=high on the RTX 3060 via
`node tools/inspect.mjs --name X --q high --w 1920 --h 1080 --script <steps>` with 4-5 s
`perfWindow`s. NOTE: the user's desktop Chrome shares this GPU — absolute fps wobbles ±8;
trust p50/mean deltas within one run more than run-to-run fps.

## History (same three camera windows: spawn / ruins camp / lake)

| Build | spawn fps (p50 ms) | ruins | lake | notes |
|---|---|---|---|---|
| pre-v0.2.0 | 29 (4.4) | 32 | 42 | GPU overcommit + broken cloud shader stalls |
| v0.2.0 trims | 63 (3.6) | 50 | 70 | pixelRatio 1.0, cloud/DoF/SMAA trims |
| v0.3.1 impostor trees | 68 (3.6) | — | 71 vista | 545 real + 1311 impostor trees |
| **HEAD (this audit)** | **37 (17.3!)** | **33 (6.8)** | **43 (4.5)** | quest + vitals + voice + straight-in boot landed since |

The alarming datum is not fps (contended GPU) — it is **spawn p50 = 17.3 ms** (median frame!),
vs 3.6 at v0.3.1. Later windows in the same run settle (6.8 → 4.5), so the slowness is
front-loaded after boot.

## Bisect data (one run, sequential windows — ORDER IS A CONFOUND, see below)

| window | fps | mean ms | p50 ms |
|---|---|---|---|
| hud-on (baseline) | 37.8 | 26.4 | 15.4 |
| all DOM hidden | 34.7 | 28.8 | 17.3 |
| + quest.beat=4 (update early-outs) | 40.2 | 24.9 | **6.9** |

- Hiding the ENTIRE DOM overlay changed nothing → the HUD/vitals CSS is NOT the regression.
- p50 collapsed 17→7 when the quest update was disabled — **BUT** that was also the third/last
  window, and the earlier 3-window run showed the same decay pattern (17.3 → 6.8 → 4.5) with the
  quest running throughout. So "quest guilty" and "first-20-s-post-boot settling" are confounded.

## Ranked hypotheses (verify in this order)

1. **Post-boot settling got worse** (most likely). Something now burns the first ~15-25 s after
   boot: candidates are the ez-tree async pipeline (texture decode → `bakeImpostor` per variant →
   first-use shader compiles for bark/leaf/impostor materials, `src/world/EZTrees.js` `ready.then`)
   and the straight-in boot (v0.2.x measured after a click-to-start pause; the splash now fades at
   first frames, so measurement windows land earlier in the warmup).
   **Test:** one run, identical camera, `perfWindow`s at +10 s, +30 s, +60 s post-load. If p50 at
   +60 s is ~4 ms, the steady state is fine and the fix is warmup scheduling (spread impostor
   bakes across frames; `renderer.compile` the tree materials under the splash; keep the splash up
   until first stable frame time, not first frame).
2. **Quest beat-1 per-frame work** (`src/rpg/quest.js` update): distance `setQuest` at 2 Hz plus
   `Math.hypot` — looks innocent, but confirm with an order-controlled A/B: two runs, SAME window
   position, beat 1 vs beat forced to 4. If it reproduces, suspect the tracker DOM write path
   (`HUD.setQuest` does two `querySelector`s per call — cache them) and anything re-triggering
   layout in `#quest`.
3. **Health-regen HUD churn** (`src/ui/HUD.js` vitals block): the WoW trickle means `health`
   changes EVERY frame below max → `setX` scaleX write + `hpnum` text write (`Math.ceil` changes
   ~1/s, fine; the fill transform every frame is pre-existing behavior). Cheap insurance:
   quantize the fill write to 0.25 % steps. Not the main regression (DOM-hidden test above), but
   free to do.
4. **Straight-in boot changes what the first minute renders**: pre-lock the world runs live
   (grass, enemies, vfx all simulating behind the hint) where the old build sat on a static
   start screen. If the demo recording flow matters more than idle perf, this is by-design; just
   make sure measurement protocols wait longer.
5. **Environment**: the user's browser session. Always compare p50 within a run, and close OBS/
   Chrome tabs for reference numbers.

## Not suspects (checked)

- DOM/vitals CSS overlay — hiding all DOM changed nothing (table above).
- Voice/portrait assets — decode is on-demand (`Audio.playVoice`), +40 MB memory total is expected
  (memMB 150 → 190 across ez-trees + voice + portrait; stable, no leak across windows).
- Impostor rebucketing — typed-array rewrite on 6 m movement, sub-ms (`EZTrees.js` probe).
- Per-system CPU (`stats().systems`) — all ≤0.4 ms; the time is inside `render` (GPU/driver).

## Standing budgets & protocol

- Target (CLAUDE.md): frame mean ≤7 ms, p99 ≤14 ms @1080p q=high; q=low ≤4 ms.
- Measure: `node tools/inspect.mjs --name perf --q high --w 1920 --h 1080 --script tools/…` with
  `{"perfWindow":{"secs":5,"label":"…"}}` — never trust a window in the first 20 s until H1 is
  resolved. `--nolock` skews numbers when runs overlap; omit it for reference measurements.
- The regression gate (`node tools/gate.mjs`) must stay green through any perf work — grass/vfx
  material changes are exactly what re-summons the blob bug (see CLAUDE.md invariants).

## Quick wins Opus can bank while in there

- Cache `.qt`/`.qo` element refs in `HUD.setQuest` (constructed per call today).
- `renderer.compile(scene, camera)` after ez-tree materials exist, while the splash still covers.
- Spread the per-variant `bakeImpostor` calls across frames (one per rAF) instead of a burst.
- Quantize the health-fill `setX` writes (0.25 % steps).


## UPDATE — same day, fixes started (Fable, continued by Opus)

**Root cause found and fixed:** the water's planar mirror was re-rendering every near-tier
ez-tree (full geometry) into its half-res target every 3rd frame — a periodic ~30 ms spike that
read as "p50 fine, mean terrible" bimodal frames. `NO_REFLECT` in `src/world/Water.js` predated
the ez-trees; trunks+leaves are now excluded (impostor quads stay in, so the far shore still
shows trees in the mirror). **Lake window: 43 -> 81 fps, mean 23.3 -> 12.3 ms.**

**Exonerated by order-controlled tests (do not re-chase):**
- Quest beat-1 update: p50 16.3 (on) vs 16.5 (off), same window position.
- ez-trees themselves: hiding ALL tree meshes moved the mean ~1.3 ms only.
- DOM/HUD overlay: hiding everything changed nothing.
- Post-boot settling: p50 was flat 10-16 ms from +10 s to +60 s — the earlier "decay" was
  camera position, not time.

**Landed alongside (warmup polish, keep):** splash now holds until 5 consecutive sub-25 ms
frames (8 s cap); ez impostor bakes spread one per frame; `renderer.compile` of the whole scene
under the splash; `HUD.setQuest` element refs cached.

**Round 2 (same day): lead #1 CONFIRMED AND FIXED.** The camera-following water surface made
`onBeforeRender` fire everywhere — the mirror AND the full-framebuffer refraction grab ran every
frame even standing in the meadow with no water on screen. New `_waterOnScreen()` gate
(Mirrormere bounding sphere vs camera frustum, or camera over water) skips both passes when no
water can be visible. spawn 45.5 -> 61.7 fps (p50 10.3 -> 4.3), ruins 41.8 -> 56.7, lake holds
80.8 with the mirror fully intact when it IS on screen (visually verified at the shore).

**Round 3 probe (ruins camp) — enemies' RENDERING is the last cost, handed to Opus:**
same-window bisect at the camp: base p50 14.1 ms -> `passive(true)` 15.1 (AI is free) ->
`clearEnemies()` **7.0** (rendering the 7-enemy camp costs ~7 ms median), 186 -> 143 draw calls
(~43 calls for 7 enemies: per-part meshes x types, plus their casts into every CSM cascade).
Means barely moved (19.6 -> 19.0) — the mean is contention noise; trust the p50 delta.

**Opus's job:** cut enemy render cost without touching the look up close.
Options, in order of safety: (a) stop enemy shadow casting beyond ~30 m (needs per-enemy
control — parts are per-TYPE InstancedMeshes today, so either split cast/no-cast instance
buckets per type the way EZTrees buckets near/far, or cast only lod-0 enemies); (b) merge
per-part meshes per type to cut the 6-ish draws per enemy; (c) check `enemies/bodies.js` part
materials for anything expensive per-fragment. The enemy files are `src/enemies/*` (enemies
builder ownership). Re-verify with the same window (`tp 140,60, look 0.6,-0.1`) and run
`node tools/gate.mjs` after — enemy material edits are blob-gate territory.

Also still standing: one CLEAN re-measure (user's Chrome closed) before deeper work — spawn
61.7 / lake 80.8 already clear the 60 bar even contended; ruins 56.7 is close.
