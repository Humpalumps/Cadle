# THE VALE SIGN-OFF — unanimous, or it does not ship

User decree, 2026-08-28, after ten minutes of play in the starting area produced "hundreds of problems":

> "i need you to loop with your senior sub-agents and be very harsh critics where you all do not sign
> things like this off unless you are all agree that there is nothing wrong when you visually look at
> everything in the starting biome, that includes bones, limbs, coherence, collisions, hitches everything"

This file is the standing charter for that loop. It is re-read at the start of every round. It applies to
**biome 1, The Vale** — the spawn meadow, Hearthfall hamlet, the Aetheryte plaza, Mirrormere, the Sundered
Spire ruins, Whisperwood's home edge, the crystal fields and the Hollow Crown — and to everything a player
meets there in the first ten minutes.

## The rule

**One dissent blocks the wave.** Sign-off requires every critic seat to return PASS. A critic who is
"mostly happy", "happy apart from X", or who lists a defect and still writes PASS has failed the seat, not
passed the build. There is no majority vote and no averaging of scores.

A critic who cannot find a defect must say so plainly and stake the seat on it. Being unable to find
anything is a legitimate result; inventing something to look diligent is not.

## The seats

Each seat is a fresh context. A seat judges the RUNNING GAME through its own captures — never a builder's
summary, never another critic's report, never a screenshot someone else chose.

1. **BONES & LIMBS** — every rig in the Vale, NPC and creature. Foot and toe direction on flat ground and on
   a grade, ankle articulation, knee and elbow bend direction, hand and prop attachment, head and neck aim,
   spine breath, missing or detached geometry, bind-pose leaks, mesh interpenetration, the mesh sitting above
   or below the ground it stands on. Judged from four bearings, at 1.5 m, 3 m, 8 m and 20 m, standing and in
   motion.
2. **COHERENCE** — does everything in frame look like it came from one game? Characters against architecture,
   architecture against terrain, props against both, VFX against all of it. Material truth at 8 m, silhouette
   at 40 m. The Wayfinder is the user's stated reference for "acceptable".
3. **COLLISION & TRAVERSAL** — walk, sprint, jump, slide and fall at every building, wall, prop, cliff, water
   edge and NPC in the Vale. Nothing may be walked through, stood inside, fallen through, or climbed by
   accident; nothing may block a path that reads as open. Drive it, do not read it.
4. **PERFORMANCE & HITCHES** — a blocking seat with numbers, not impressions. User decree, 2026-08-28:
   *"we need to maintain our performance."* Two independent tests, and BOTH must pass:

   **(a) The budget.** @1080p `q=high` on the RTX 3060, uncapped harness (CLAUDE.md):

   | metric | budget |
   |---|---|
   | frame mean | <= 7 ms (~140 fps) |
   | frame p99 | <= 14 ms |
   | draw calls | <= 350 |
   | triangles | <= 4 M |
   | `memMB` over 30 s | flat — no upward drift |
   | `q=low` frame mean | <= 4 ms |

   Per-system CPU+GPU slices: terrain 0.8, grass 1.0, water 0.8, vegetation 0.8, sky+clouds 0.4, shadows 0.8,
   postfx 1.3, enemies 0.6, vfx 0.4, rest 0.3. A system over its slice is a defect even when the whole frame
   is inside budget — it is the next wave's regression.

   **(b) No regression against the wave that shipped.** The budget alone cannot catch a change that spends
   2 ms it did not have to; a Vale that was 6.2 ms and is now 6.9 ms passes the budget and has still lost a
   fifth of its headroom. Measure the SHIPPED build and the candidate build **back to back, on the same quiet
   machine, in the same session** — never a number quoted from an earlier run, never two runs with other
   captures in flight, because a parallel harness or a background game inflates everything (`tools/hitchhunt.mjs`
   warns when other chrome-headless-shell processes are alive; if it warns, the run is void). Baseline is
   `origin/main` as of this wave's start. Any metric worse by more than 5% is a defect and must be either
   fixed or explained to the user as a deliberate trade with the fidelity it bought.

   **The baseline is already served — do not stash anything to get it.** The worktree
   `<repo>/.claude/worktrees/cadle-character-load-perf-ee5b7b` sits at 26b0b9e
   (= `origin/main` as of this wave's start) with a clean `src/`, and its dev server is up at
   **http://127.0.0.1:5179/**. The candidate build is this worktree at **http://127.0.0.1:5185/**. So the A/B
   is two `--url` flags against two live servers, back to back, with nothing else rendering. Verify the
   baseline is still clean before trusting it: `git -C <that worktree> status --porcelain -- src/` must be
   empty and `git -C <that worktree> log --oneline -1` must still read 26b0b9e.

   **What to run.** `node tools/hitchhunt.mjs --name <label> --route combat` on the DENSEST case in the Vale
   (the hamlet angle and the ruins camp fight — not the empty meadow), plus `--route tp` for the traversal
   path, at `q=high` and `q=low`. Read `frames.json`, not just `summary.json`: a single 1 s frame is invisible
   in percentiles and is exactly what a player feels. Every spike must be blamed on the system that was slow
   on that frame. A hitch a player would feel is a failure at any average frame rate.
5. **THE PLAYER'S FIRST TEN MINUTES** — spawn, look around, walk to the hamlet, talk to a villager, take a
   quest, fight the first thing that fights back, die or nearly die, come back. Judged as a player, not as an
   engineer: readability, feel, whether anything reads as unfinished.

## What a seat must produce

- The exact capture commands it ran and the screenshots it opened — a PNG that was not opened with the Read
  tool was not checked, and saying otherwise is the one unforgivable failure in this loop.
- For each defect: what it is, where (coordinates, hour, quality preset), the frame that shows it, and how bad
  in one line.
- A verdict line, exactly `VERDICT: PASS` or `VERDICT: FAIL`.
- FAIL requires at least one defect. PASS requires the seat to name what it looked at hardest and still could
  not fault.

## What is NOT a defect

Deliberate, documented decisions are out of scope for a FAIL: the blob law's caps on ground cover, the
biome partition's look radii, quests being written rather than voiced, villagers being static idlers. A seat
that disagrees with a decree writes it as a note to the user, not as a blocking defect.

## The loop

    round N: builders fix -> gate (`node tools/gate.mjs`) -> five critic seats, fresh contexts, concurrent
             all five PASS -> the Vale is signed off, report to the user
             any FAIL      -> defects go back to the owning lane -> round N+1

The gate is necessary and not sufficient: `node tools/gate.mjs` exiting 0 is an entry condition for the
critic round, never a substitute for one. A round where the gate passes and a seat fails is a failed round.

**Scheduling: the PERFORMANCE seat runs ALONE.** Every other seat may run concurrently — they only take
screenshots. Timing does not survive company: a parallel harness, another seat's capture, or a game running
on the user's desktop inflates every number, and a perf verdict measured under load is worse than no verdict
because it reads as evidence. So the round is: the four visual/traversal seats concurrently, then the machine
goes quiet, then the perf seat runs its baseline and candidate back to back. If the perf seat reports that it
saw other chrome-headless-shell processes, its run is void and it re-runs — it does not caveat and pass.
