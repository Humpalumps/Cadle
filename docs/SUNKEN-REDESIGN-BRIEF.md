# The Sunken Kingdom — above-water redesign brief (user decree 2026-08-25)

**The decree:** *no underwater area.* Waterfalls, rapids, above-water. The swim-over-a-drowned-city
identity is dead; CLAUDE.md/HANDOVER's `sea: true` spec for k=7 is stale from this date.

## Target identity

A drowned kingdom **among cataracts**, not under a sea. The sea basin becomes a **tiered gorge**:
three broad terraces stepping down toward the landmark, fed by **waterfalls off the mountain ring**,
linked by **white-water rapids and cascades** between terraces. Streets and plazas of the old kingdom
sit **flooded at wading depth** (ankle–knee, like Shadowfen's mechanic but clear mountain water, fast
not murky). The **Drowned Court** stands IN the cascade basin at the lowest terrace — water pouring
through its broken arches, the throne and the gold hoard on a spray-soaked dais **above** the water
line. Mist/spray hangs over the falls. The read from the pass: a staircase of silver water falling
toward a ruined palace.

## System work (owners)

- **Terrain (kernel change — heightAt WILL change, re-baseline the 4e checksum deliberately):**
  `bhSunken` sea bowl → three stepped terraces (quantised fbm risers like Infernal's plates but
  broader/flatter), narrow rapid channels cut between terraces, gorge walls. Flats sit ~0.3–0.6 m
  below `waterLevel` (wading), never over-head depth. `dryAt` shapes where water is allowed.
- **Water:** waterfall sheets (scrolling foam material on the terrace risers), rapid streaks + foam
  in the channels, plunge-pool foam rings, spray mist cards at fall bases. Flow direction follows
  the terrace gradient. No deep-water rendering needed.
- **Biomes.js (orchestrator):** `sea: false`; passive becomes spray/wading flavor ("The cataracts
  slow and soak you" or similar — only if the effect exists); haze = cool spray-mist; audio ask:
  waterfall roar bed near falls.
- **Props:** Drowned Court re-staged above water (dais raised, arches as fall-throughs), hoard
  stays (gold now readable in open air), wreck ribs become bridge-like spans over rapids, kelp/coral
  kit retired from scatter.
- **RPG data:** audit `src/rpg/quests/*` sunken chain — any objective phrased around swimming/diving
  gets re-worded (data-only); `reach` targets stay valid. `curvecheck.mjs` must stay green.
- **Player:** breath meter stays as dormant code (harmless), no longer a featured mechanic.
- **Audio:** ask — waterfall roar loop + rapid babble for the region bed.

## Acceptance (critic bar)

From the pass: the staircase-of-water vista reads at 800 m. In-region: falls audible+visible from
any point, no over-head swimming anywhere on the main routes, the Court's arches genuinely pour
water, gold hoard reads gold in open air, spray mist present but never washes white (blob law).
