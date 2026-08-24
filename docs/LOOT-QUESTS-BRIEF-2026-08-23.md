# Brief — Loot, Ammo, Quests, Density (2026-08-23)

The build order for four connected systems: a procedural loot economy that keeps paying out, ammo
that drops off mobs so a gun is never dead weight, a WoW-shaped quest chain that carries a player
from level 1 to 50 through all ten regions in the right order, and the mob density those quests
need. Plus the sign-off gate every one of them has to pass.

**Scope decision up front: most of this is extension, not construction.** `src/rpg/` already holds a
working drop table with pity timers, procedural weapon/armour rolls, five rarities, physical world
drops with beacons and nameplates, an inventory, a skill tree, currencies, dismantle, infuse and
upgrade. Nobody rebuilds that. The gaps are narrow and specific, and they are listed below.

---

## 1. What exists today (do not rebuild)

| Piece | Where | State |
|---|---|---|
| Drop table + pity (hard/soft, per tier) | `src/rpg/loot.js` | Works. Rates: common .55 / uncommon .28 / rare .125 / legendary .038 / exotic .007 |
| Procedural weapons + armour, perks, elements, exotics | `src/rpg/items.js` | Works. 8 archetypes mirroring the real armoury, 3 perk slots, 5 armour slots, 6 named exotics |
| Physical drops: beacon, silhouette mesh, nameplate, pickup | `src/rpg/loot.js`, `dropmesh.js` | Works. Cap 12 drops, 150 s despawn, cheap tiers vacuum at 1.25 m |
| Levels 1–50, XP curve, skill tree, stat derivation | `src/rpg/progression.js` | Works. `xpToNext(l) = 80·l^1.55 + 40·l`, `MAX_LEVEL = 50` |
| Inventory / character / skills / map screens | `src/ui/Screens.js`, `rpgscreens.js`, `mapscreen.js` | Works. Parchment shell, tabs M / C / I / K |
| Save/load | `src/rpg/save.js` | Works, localStorage |
| Camps, streaming spawner, 23 enemy types, biome rosters | `src/enemies/Enemies.js`, `defs.js`, `src/world/Biomes.js` | Works. Cap 40 alive, 300 m stream radius |
| HUD quest tracker, toasts, notify, boss bar, waypoints | `src/ui/HUD.js`, `mapscreen.js` | Works, single-objective only |

### The gaps, precisely

1. **No ammo economy at all.** `Weapons.addAmmo(slot, n)` exists at `src/player/Weapons.js:211` and
   **nothing in the codebase calls it**. The only refill is on respawn. That is the whole of the
   user's complaint: run a gun dry and it is dead until you die.
2. **Loot does not know what killed it.** `dropLoot` rolls power from *your* power level, not the
   enemy's level, biome or tier. Killing a level-44 Void Horror and a level-2 wisp roll the same table.
3. **Enemy XP is flat.** `defs.js` has `LEVEL_HP` and `LEVEL_DMG` that scale with level; there is no
   `LEVEL_XP`. A level-44 mob pays the same `def.xp` as the level-34 version of itself.
4. **One quest exists, it is voiced, and it is hardcoded.** `src/rpg/quest.js` is a 171-line
   three-beat script for "The Sundered Spire" with five ElevenLabs voice lines. Being removed — §6.
5. **Density is thin for questing.** One camp per outer region (120 m radius) inside a 270 m-radius
   region, 40 alive globally across a 2048 m world.
6. **No mechanics test exists.** `tools/gate.mjs` covers graphics and input; `hitchhunt.mjs` covers
   performance. Nothing checks that a quest completes or that the curve reaches 50.

---

## 2. Ammo — ship this first

Smallest system, unblocks the complaint, zero risk to the render.

**No edit to `Weapons.js` is needed.** `addAmmo(slot, n)` is already the right API and already clamps
to `maxReserve`. New file `src/rpg/ammo.js` (rpg owner) does the rest.

### Two brick types, because the reserves demand it

Cadle has two weapon slots and no heavy slot. One universal brick would be simpler, but sniper
reserve is 20 (max 28) against auto rifle 216 (max 300) — refilling a sniper from every trash kill
would delete the weapon economy. So:

| Brick | Drops from | Refills | Colour |
|---|---|---|---|
| **Light** | ~35 % of any kill | 12 % of `maxReserve` on **both** slots | pale gold, saturated |
| **Special** | ~7 % of kills, ~40 % of elites, 100 % of mini-bosses | 25 % of `maxReserve`, only to slots holding shotgun / sniper / fusion / beam | deep violet, saturated |

Archetype→class table lives in `ammo.js` keyed by archetype id, so `weapons/defs.js` (another
owner's file) is untouched.

### The dry-guard is the actual fix

If both slots are at `ammo === 0 && reserve === 0`, the **next kill drops a guaranteed Light brick**.
That is the rule that makes "guns are wasted once they run out" impossible, and it is four lines.

Melee and abilities still work while dry, so there is always a way to earn the brick.

### Pickup and presentation

Reuse the `loot.js` drop loop: bricks walk-over collect at 1.25 m like cheap tiers, no `E` press,
no nameplate. Mesh is one small box from the `dropmesh.js` kit.

> **Blob law applies.** A brick is exactly the "small bright element" the user's decree names.
> Saturate the colour, cap the intensity — brick emissive ≤ 0.6, never neutral-bright. Two brick
> types × up to 40 mobs is the densest emissive population the world has ever had on the ground.
> This goes through `blobcheck` before it ships, not after.

### Cap exemption

Bricks and quest items **do not count against `MAX_DROPS = 12`** and **do not despawn at 150 s**.
The existing opening quest already hit this bug and worked around it with a 5-second re-drop poll
(`quest.js:143`); do not reproduce that workaround, fix the cap instead.

---

## 3. Loot depth

Four changes, all inside `src/rpg/`.

**3a. Source-aware rolls.** `dropLoot(pos, tier, opts)` gains `opts.source = enemy`. Power comes
from the enemy's level, not the player's. Element biases by region (Frostveil → arc/stasis,
Infernal → solar, Void → void, Whisperwood → verdant). Archetype biases by enemy role (a sniper
drops off a ranged elite far more often than off a hound). This is the single change that makes
"where you farm" mean something.

**3b. Tier floors by enemy tier.** Elite → guaranteed rare or better. Mini-boss → guaranteed
legendary. Region boss → real exotic chance (~18 %). Trash keeps the existing 28 % roll.

**3c. A fourth item kind: `quest`.** No stats, no rarity roll, stacks, shows in a Quest Items
section of the inventory, cannot be dismantled or equipped. Required for collect-X quests. ~30 lines
in `items.js` plus a stack counter in `progression.js`.

**3d. World chests.** One to three hand-placed per region near the landmark, 20-minute respawn,
contents rolled at the region's level band. Reuses the existing drop silhouettes and beacon.
This is what gives Dragon Peaks a reason to climb (HANDOVER §2 names it as a live gap).

**3e. Split the table out of `loot.js`.** The ~40 lines of drop-table maths (`W`, `HARD`, `SOFT`,
`RAMP`, `rollTier`) move to a new pure `src/rpg/droptable.js` with no `three` import; `loot.js`
re-exports so nothing else changes. **This is what lets the mechanics gate measure drop rates in
node without a GPU.** It is the reason to do it.

Deliberately skipped: no new rarity tier, no new currency, no crafting, no vendors, no random
enchant re-rolls. Add when the loop is proven boring without them.

---

## 4. Quests

### 4a. Data, not code

Quest content is plain JS objects under `src/rpg/quests/<region>.js`. One engine reads them all.
Adding a quest must never mean writing a function.

```js
{
  id: 'frostveil-03', region: 'tundra', level: 13, next: 'frostveil-04',
  name: 'What the Ice Kept',
  giver: 'stele:tundra',
  text: {
    offer:    'The glacier gave up more than water when it cracked...',
    progress: 'Frostwolves guard the shelves. They always have.',
    done:     'Cold iron, and older than the Vale. Keep it.',
  },
  objectives: [
    { type: 'kill',    enemy: 'frostwolf', count: 8, where: 'tundra' },
    { type: 'collect', item: 'frost-shard', count: 5, from: ['frostwolf'], chance: 0.45 },
  ],
  reward: { xp: 4200, glimmer: 320, tier: 'rare' },
}
```

### 4b. Five objective types — the WoW spread the user asked for

| Type | Mechanic | Hooks into | New runtime? |
|---|---|---|---|
| `kill` | Kill N of a type, optionally scoped to a region | `enemy:death` event | none |
| `collect` | Gather N quest items from tagged mobs or nodes | quest-item drops (§3c) | none |
| `slay` | Kill one named elite / mini-boss | elite spawn + `HUD.showBoss` (exists) | elite modifier |
| `reach` | Discover a POI | `Biomes.regionAt` + distance | none |
| `escort` | Keep a guide alive along a route | guide entity | **yes — the only one** |

**Escort is the one genuinely new system, so descope it hard.** The guide is a `wisp` body (already
built, already rigged) on a friendly team, following a spline between two points, with an HP bar and
timed ambushes along the route. No pathfinding, no companion AI, no new art. A floating aether wisp
you walk home is thematically the most Cadle thing on this list and costs the least. Build it last.

### 4c. Delivery — written, with a giver

The user's call: quests are **read, never spoken**. But a quest board with no giver reads as a menu,
not a world. The cheapest thing that still reads as a world:

**Wayfinder Steles.** One carved stone at each region's landmark. `E` to read; a parchment scroll
card opens using the shell `Screens.js` already has. Accept, track, return to the same stele to turn
in. `Props.js` already builds an aetheryte with plaques and already owns per-region kits, so this is
a prop variant, not a new system.

Fallback so content is testable before the art lands: a region with no stele auto-offers its chain
on first entry. Ship the fallback in the same wave as the engine.

### 4d. UI

- **Tracker** — `HUD.setQuest(title, objective)` exists but is single-line. Extend to N objectives
  with `3 / 8` counters. HUD builder's file.
- **Quest log** — a fifth tab (`J`) in `Screens.js` beside map / character / inventory / skills.
  Same parchment shell, so it is a renderer function, not a new screen system. Active chain, side
  quests, completed list, and the full written text of anything accepted.
- **Cards** — accept / step-complete / turn-in use the existing `notify` + `toast`. No new card
  system, and specifically **not** the `#valecard` portrait card being deleted in §6.

### 4e. Engine

`src/rpg/quest.js` is rewritten as a `Quests` class, ~200 lines: accept, track, complete, persist.

> **One listener, not fifty-five.** The engine registers exactly one `enemy:death` and one
> `loot:picked` handler and dispatches to active objectives. Per-quest subscriptions across 55
> quests is a guaranteed leak, and `memMB` stable over 30 s is in the perf budget.

Quest state persists next to the existing save. `?fresh=1` already clears `cadle.quest`
(`main.js:7`) — keep that working.

---

## 5. The route from 1 to 50

### 5a. Region order is set by the level bands already in `Biomes.js`

| # | Region | Band | Landmark |
|---|---|---|---|
| 1 | The Vale (meadow) | 1–5 | Aetheryte Plaza / Sundered Spire |
| 2 | Whisperwood Deep | 5–11 | The Elderheart |
| 3 | Frostveil Tundra | 11–17 | The Glacier Throne |
| 4 | Shadowfen | 15–22 | The Hagstone |
| 5 | Infernal Wastes | 18–25 | The Cinder Maw |
| 6 | The Sunken Kingdom | 20–28 | The Drowned Court |
| 7 | Dragon Peaks | 24–32 | Kharaz-Dun Gate |
| 8 | Celestial Isles | 30–38 | The Empyrean Gate |
| 9 | The Void | 34–44 | The Unmaking |
| 10 | The Lost Realm | 40–50 | The Convergence |

Every region's chain **ends with a quest that points at the next region's stele**. That is the whole
of "goes through the areas correctly" — no travel system, no gating, just a written objective and a
map waypoint (`setWaypoint` already exists). The passes through the mountain ring are already
walkable on every bearing.

Bands overlap by design (Shadowfen 15–22 and Infernal 18–25), so a player who wants to skip a region
can, and a player who over-levels has somewhere to spend it.

### 5b. The XP maths — measured, not guessed

Total XP for 1 → 50 under the current curve: **706,299**.

| To level | Cumulative XP | XP for that level alone |
|---:|---:|---:|
| 5 | 1,839 | 846 |
| 11 | 14,786 | 3,239 |
| 17 | 45,328 | 6,521 |
| 22 | 87,601 | 9,805 |
| 25 | 121,344 | 11,986 |
| 28 | 161,926 | 14,314 |
| 32 | 227,410 | 17,635 |
| 38 | 351,920 | 23,048 |
| 44 | 510,619 | 28,945 |
| 50 | 706,299 | 35,294 |

At today's flat enemy XP (8 for a wisp, 280 for a Void Horror, 900 for the Archon), that is roughly
**3,500–7,000 kills** for one playthrough. Too many. Two fixes, both small:

1. **Add `LEVEL_XP(base, level) = base · (1 + 0.16·(level − 1))`** in `defs.js`, matching the shape
   of `LEVEL_HP`. A level-40 Void Horror then pays ~2,000 instead of 280.
2. **Split the curve 60 / 40 in favour of quests.** ~424,000 XP from ~55 quests (average ~7,700,
   scaled by band: a Vale quest pays ~350, a Lost Realm quest ~28,000) and ~282,000 from kills.

Target pacing: **45–75 minutes per band, 8–12 hours to 50.** These are the numbers the mechanics
gate asserts — see §7. They are a starting point to be tuned by simulation, not a promise.

---

## 6. Removing the voiced opener

Per the user's decision, the spoken opening quest goes and quests are written from here on.

| Action | File |
|---|---|
| Delete `LINES`, `DIRECTIVE`, `_speak`, `_say`, `_card`, `PORTRAIT`, `#valecard` CSS | `src/rpg/quest.js` (whole file is being replaced anyway) |
| Delete the five `voice-vale-*` preload entries | `src/core/Assets.js:44–45` |
| Delete the mp3s | `public/assets/voice/` — also recovers payload against the 43 MB / 40 MB overage in HANDOVER §5 |
| Mark the "Voice cast" section retired, keep the consistency rule for a future story mode | `ASSETS.md:142` |
| Add the rule: quests are written, never spoken | `CLAUDE.md` |
| Add an invariant: no `playVoice` call anywhere under `src/rpg/` | `tools/invariants.mjs` |

The Vale's opening beat is **not** deleted, it is rewritten as the first written quest — an
aetheryte flare, a zone card, a scroll, a waypoint east. Same staging, no audio.

`Audio.playVoice` stays (it is ~10 lines and belongs to another owner). Report it as an ask if the
audio builder wants it gone.

---

## 7. The sign-off gate — graphics, performance, mechanics

The user's requirement: nothing signs off until it passes all three. Two exist. The third does not
and is part of this work.

### Gate 1 — Graphics (exists)

```bash
node tools/gate.mjs
```

Must exit 0: source invariants, no washed-white blobs at `q=high` and `q=low`, no screen jitter,
pointer lock engages and re-acquires. Plus `tools/inspect.mjs` screenshots of every new visual
element — ammo bricks, quest items, chests, steles, the escort wisp, the quest scroll card.

Ammo bricks and quest items are new emissives on the ground in large numbers. That is the exact
shape of the bug that has shipped six times. They get their own blobcheck burst.

### Gate 2 — Performance (exists)

```bash
node tools/hitchhunt.mjs --name loot-density --route combat
```

Budget at 1080p `q=high` on the RTX 3060: whole frame mean ≤ 7 ms, p99 ≤ 14 ms, ≤ 350 draw calls,
≤ 4 M tris, `enemies` system CPU ≤ 0.6 ms, `memMB` flat over 30 s.

Density work (§8) is measured on the **densest** region, not the meadow. The memory check matters
more than usual here: quest state, listeners and drop records are all new long-lived allocations.

### Gate 3 — Game mechanics (does not exist — build it)

Two pieces, both new.

**`tools/curvecheck.mjs`** — pure node, no browser, ~1 second. Imports `progression.js`,
`items.js`, the new `droptable.js` and the quest tables, then asserts:

- every level 1 → 50 is reachable from the sum of quest XP + expected kill XP in its band, ±15 %
- no band has a gap where the next region's quests are unreachable at the previous one's exit level
- drop rates over 100,000 rolls match the published table within 2σ
- pity never breaks: no drought exceeds its hard limit, no tier exceeds its table rate
- every quest's `next` resolves; every `enemy` and `item` a quest names exists in `defs.js` / items
- every objective is completable from the region's actual spawn roster

Runs in CI beside `invariants.mjs`. This is the cheapest high-value thing in the whole brief — it
catches broken content in a second without a GPU, and content is where the bugs will be.

**`tools/questgate.mjs`** — Playwright, drives `window.__game`. One pass per objective *type* (five),
not per quest: accept → spawn the requirement → satisfy it → assert the objective ticks → assert
turn-in → assert XP and reward landed. Plus the ammo test that motivated all of this:

> fire until `reserve === 0` on both slots → kill 3 mobs → assert `reserve > 0`.

New `__game` hooks needed (orchestrator wires them): `quest.accept(id)`, `quest.state()`,
`quest.abandon(id)`, `ammo()`, `setLevel(n)`.

> **Return scalars only.** HANDOVER §5.5: an eval that returns a live game object serialises the
> whole Three.js graph over CDP and manufactures a 6.5-second phantom stall. Every new hook returns
> a plain object or a number.

---

## 8. Mob density

The user is right that quests need more targets. This is also the **only item in this brief that can
break the frame budget**, so it is measured, not assumed.

**Today:** `MAX_ALIVE = 40` across a 2048 m world, one camp per outer region at 120 m radius inside
a region whose look radius is 270–320 m, `STREAM = 300 m`.

**Target shape:**

- **3 camps per outer region** — the heart plus two satellites at roughly ±140 m off the bearing,
  so a region has fights in it rather than a fight at the middle of it.
- **Camp membership × 1.6.**
- **Roaming packs** of 2–3 between camps, so the space between camps is not empty.
- **`MAX_ALIVE` 40 → 72**, raised in steps of 8 with a measurement at every step.

**Do the free work before raising the cap.** `Enemies.update` already decimates animation above 26
alive (`crowd = n > 26 ? 2 : ...`) and caps shadow casting at 25 m. Extend the LOD ladder (anim /2
above 32, /3 above 48, AI ticks decimated by distance band) *first*; that buys headroom without
costing a frame, and it is the difference between 72 alive being affordable and not.

**Stop rule:** raise until the last step that still measures inside the §7 Gate 2 budget on the
densest region, then stop and record the number. Do not ship a cap that was not measured.

---

## 9. Order of work

Two lanes, different file owners, no overlap.

**Lane A — systems (rpg owner)**

| Wave | Work | Gate |
|---|---|---|
| A1 | Ammo (§2) + `droptable.js` split (§3e) + `curvecheck.mjs` (§7) | 1 + 2 + 3 |
| A2 | Quest engine, quest log tab, tracker, written opener replacing the voiced one (§4, §6) + `questgate.mjs` | 1 + 3 |
| A3 | Loot depth: source-aware rolls, tier floors, quest items, chests (§3) | 1 + 2 + 3 |
| A4 | Quest content ×55 across ten regions (§4a, §5) | 3 |
| A5 | Escort guide, elite modifier, Lost Realm endgame chain | 1 + 2 + 3 |

**Lane B — world (enemies + vegetation owners), runs in parallel from the start**

| Wave | Work | Gate |
|---|---|---|
| B1 | LOD ladder extension, AI tick decimation (free headroom) | 2 |
| B2 | Density raise in steps of 8 to the measured ceiling (§8) | 2 |
| B3 | Wayfinder Steles per region (§4c) | 1 + 2 |

A2 depends on A1's `droptable` split only. A4 depends on A2's engine and B2's density. B is
independent until B3.

---

## 10. Deliberately not building

Named so nobody adds them back as a surprise:

- No dialogue trees, no branching quests, no choices with consequences.
- No reputation, factions, dailies, weeklies or repeatables.
- No crafting, vendors, auction house, or currency exchange.
- No new rarity tier and no new currency.
- No NPC characters or humanoid rigs — steles and a wisp guide carry the whole delivery layer.
- No voice, per §6.
- No multiplayer or quest sharing.

Each of these is a real feature that a real MMO has. None of them is needed to prove the loop is
fun, and every one of them is cheaper to add after the loop is proven than to carry while proving it.

---

## 11. Known risks

1. **The blob law vs. hundreds of new emissives.** Ammo bricks and quest items put more glowing
   objects on the ground than anything in the project's history. Non-negotiable: saturate the
   colour, cap the intensity, blobcheck before ship.
2. **Boot time.** Already 13–16.7 s to playable against a < 4 s budget (HANDOVER §5.3). Quest data
   must be plain JS objects with no new preloaded assets, or it gets worse.
3. **Density vs. the frame.** §8's stop rule exists because of this. The forest view is already at
   4.4–4.9 M tris against a 4 M budget (HANDOVER §5.9) — that view gets no extra mobs until it is
   back inside budget.
4. **Listener leaks.** One engine listener, not one per quest. `memMB` flat over 30 s is a gate.
5. **Content correctness.** 55 quests referencing enemy ids, item ids and regions is where the bugs
   will actually be. That is what `curvecheck.mjs` is for, and it is why it runs in CI.
6. **The loot cap eating quest items.** Already happened once with the opening quest's reward. Fixed
   properly by the cap exemption in §2, not by a re-drop poll.
