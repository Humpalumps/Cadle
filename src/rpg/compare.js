// OWNER: rpg agent (loot). Pure item-vs-equipped comparison — no `three`, no DOM, no `ctx`.
//
// WHY IT IS ITS OWN FILE: src/ui/rpgscreens.js already computes item-vs-equipped deltas
// (compareTo()/delta()) for the inventory and character sheets, but that logic lives in a UI
// file loot.js is not allowed to import (loot.js is world-side: it has to show the same
// verdict on the pickup prompt and the floating nameplate BEFORE a player opens any menu).
// This module mirrors that math in a plain-data form so both sides agree. Importable by plain
// `node`, same as droptable.js, because tools/curvecheck.mjs and tools/questgate.mjs import
// these mechanics modules directly.
//
// ponytail: this duplicates rpgscreens.js's per-stat delta math rather than rpgscreens.js
// importing this module — rpgscreens.js is owned by another agent mid-edit this wave. De-dupe
// (make rpgscreens.compareTo/detail call into compareItem()) is a clean follow-up once it's free.

const n0 = (v) => Math.round(+v || 0);

// Same stat sets rpgscreens.js's WSTAT/ASTAT walk, keys and labels included, so a stat line
// printed here reads identically to the one printed in the inventory screen.
const WSTAT = [['damage', 'Impact'], ['rpm', 'Rounds / min'], ['mag', 'Magazine'],
  ['range', 'Range'], ['stability', 'Stability'], ['handling', 'Handling']];
const ASTAT = [['mobility', 'Mobility'], ['resilience', 'Resilience'], ['recovery', 'Recovery'],
  ['discipline', 'Discipline'], ['strength', 'Strength']];

/**
 * compareItem(item, equipped) -> verdict | null
 *
 * `item` is the candidate (a drop, or a rolled quest-reward preview). `equipped` is whatever is
 * currently worn in that item's slot (S.equipped.weapon or S.equipped[item.slot]), or null/undefined
 * for an empty slot. Returns null for anything with no stats to compare (quest items) — callers
 * must not print a verdict for those.
 *
 * verdict: {
 *   powerDelta: number,                          // item.power - equipped.power (or item.power if nothing equipped)
 *   verdict: 'better' | 'worse' | 'sidegrade',    // by power, the headline number
 *   lines: [{ key, label, delta }],               // up to 2, the stats that moved most (abs), zero deltas dropped
 *   hasEquipped: boolean,                         // false = comparing against an empty slot
 * }
 */
export function compareItem(item, equipped) {
  if (!item || item.kind === 'quest' || !item.stats) return null;
  const powerDelta = n0(item.power) - (equipped ? n0(equipped.power) : 0);
  const verdict = powerDelta > 0 ? 'better' : powerDelta < 0 ? 'worse' : 'sidegrade';
  const table = item.kind === 'weapon' ? WSTAT : ASTAT;
  const s = item.stats, cs = (equipped && equipped.stats) || {};
  const lines = table
    .map(([key, label]) => ({ key, label, delta: n0(s[key]) - n0(cs[key]) }))
    .filter((l) => l.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 2);
  return { powerDelta, verdict, lines, hasEquipped: !!equipped };
}

// ------------------------------------------------------------------ the loadout
// The game carries TWO live guns (src/player/weapons/defs.js DEFAULT_SLOTS = ['handcannon',
// 'autorifle'], HUD digits 1 and 2). The RPG modelled one, which is how equipping from the
// inventory silently deleted whichever gun happened to be in your hands. These two ids map
// 1:1 onto Weapons.slots[0] and Weapons.slots[1] and are the single source of that vocabulary
// — progression.js imports them from here (this file has no imports, so there is no cycle).
export const WEAPON_SLOTS = ['weaponA', 'weaponB'];
export const SLOT_LABELS = {
  weaponA: 'Weapon 1', weaponB: 'Weapon 2',
  head: 'Helm', arms: 'Gauntlets', chest: 'Plate', legs: 'Greaves', cloak: 'Cloak',
};
export const slotsFor = (item) => !item ? []
  : item.kind === 'weapon' ? WEAPON_SLOTS.slice()
  : item.kind === 'armour' ? [item.slot] : [];

/**
 * compareAgainstLoadout(item, equippedMap) -> [{ slot, slotLabel, equipped, ...compareItem }]
 *
 * One entry per slot the item could actually go into: BOTH guns for a weapon, the matching
 * piece for armour. `equippedMap` is progression's S.equipped (or ctx.rpg.equipped). Empty
 * array for anything with nothing to compare (quest items), same rule as compareItem.
 * `equipped` is a thin {name, power, rarity} snapshot, or null for an empty slot.
 */
export function compareAgainstLoadout(item, equippedMap) {
  if (!item || item.kind === 'quest' || !item.stats) return [];
  const eq = equippedMap || {};
  return slotsFor(item).map((slot) => {
    const cur = eq[slot] || null;
    return {
      slot, slotLabel: SLOT_LABELS[slot] || slot,
      equipped: cur ? { name: cur.name, power: n0(cur.power), rarity: cur.rarity } : null,
      ...compareItem(item, cur),
    };
  });
}

/** Which of `slots` a fresh weapon should displace: an empty one first, else the weakest by
 *  power. `heldSlot` breaks a tie in favour of KEEPING the gun in your hands. Pure — the
 *  policy lives here so the UI can preview the same answer equip() will take. */
export function defaultSlotFor(item, equippedMap, heldSlot) {
  const slots = slotsFor(item);
  if (slots.length < 2) return slots[0] || null;
  const eq = equippedMap || {};
  const empty = slots.find((s) => !eq[s]);
  if (empty) return empty;
  let best = slots[0];
  for (const s of slots.slice(1)) {
    const d = n0(eq[s].power) - n0(eq[best].power);
    if (d < 0 || (d === 0 && best === heldSlot)) best = s;
  }
  return best;
}
