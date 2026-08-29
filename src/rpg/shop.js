// OWNER: rpg agent. Shopkeepers — vendors, stock, prices, and the buy path.
//
// Two Hearthfall villagers keep shop (both already exist in Props' named-NPC roster, so no
// world edit is needed): Bram the Mason sells arms and armour off his bench, Wick the
// Lamplighter sells ammunition and draughts beside his market lantern. Both are ALSO quest
// givers — the interaction rule (QuestMarkers.js) is quests-first: an E press hands in /
// offers their quest while one is pending, and opens the shop once there is nothing to say.
//
// PRICES ARE DATA (a table, no functions in content). Gear stock is ROLLED once per session
// per vendor through the same loot generator drops use (ctx.rpg.rollItem), at a fixed tier +
// level bracket, so a bought gun is a genuine roll — the shop is a slot you pay to stop at,
// not a second loot system.
//
// API (wired onto game.rpg by RPG.js):
//   isVendor(npcId) -> bool
//   vendorFor(npcId) -> { id, name, title, greet } | null
//   stockFor(ctx, npcId) -> [{ key, name, sub, price, kind, canBuy, why, item? }]
//   buy(ctx, npcId, key) -> { ok, reason?, name? }   — deducts glimmer, grants the goods
import { CONSUMABLES } from './items.js';
import { state as S, trySpend } from './progression.js';

// ---------------------------------------------------------------- the data
// Which archetypes eat special ammo — mirrors ammo.js's SPECIAL_ARCH (same ids, one screen away).
const SPECIAL_ARCH = new Set(['shotgun', 'sniper', 'fusion', 'beam']);

// PRICES — one flat table, glimmer only. Kill payout at Vale levels is ~10-20 a corpse, quests
// pay 25-140, so an ammo pack is a couple of kills and an uncommon gun is a quest's worth.
export const PRICES = {
  ammoLight: 40,       // 60% of maxReserve on every carried weapon
  ammoSpecial: 70,     // 60% of maxReserve on carried special weapons
  draught: 35,
  tonic: 60,
  charm: 90,
  weaponUncommon: 220,
  weaponRare: 520,
  armourUncommon: 180,
  armourRare: 440,
};

// Gear stock specs — DATA. Rolled once per session through ctx.rpg.rollItem at these tiers;
// power bracket comes from `level` (level * 8, the same POWER_PER_LEVEL loot and quests use).
const BRAM_STOCK = [
  { key: 'w1', kind: 'weapon', tier: 'uncommon', level: 3, price: PRICES.weaponUncommon },
  { key: 'w2', kind: 'weapon', tier: 'uncommon', level: 4, price: PRICES.weaponUncommon },
  { key: 'w3', kind: 'weapon', tier: 'rare',     level: 5, price: PRICES.weaponRare },
  { key: 'a1', kind: 'armour', tier: 'uncommon', level: 3, price: PRICES.armourUncommon },
  { key: 'a2', kind: 'armour', tier: 'uncommon', level: 4, price: PRICES.armourUncommon },
  { key: 'a3', kind: 'armour', tier: 'rare',     level: 5, price: PRICES.armourRare },
];

export const VENDORS = {
  bram: {
    id: 'bram', name: 'Bram the Mason', title: 'Arms & Armour',
    greet: 'Stone holds a wall, steel holds a life. Both are priced fair.',
    gear: BRAM_STOCK,
  },
  wick: {
    id: 'wick', name: 'Wick the Lamplighter', title: 'Provisions & Ammunition',
    greet: 'Lamps, powder and something for the road. All of it burns one way or another.',
    goods: [
      { key: 'ammoLight',   name: 'Ammunition Case',        sub: 'refills every carried weapon (60% of reserve)', price: PRICES.ammoLight },
      { key: 'ammoSpecial', name: 'Special Ammunition Case', sub: 'refills special weapons (60% of reserve)',      price: PRICES.ammoSpecial },
      { key: 'draught', name: CONSUMABLES.draught.name, sub: CONSUMABLES.draught.desc, price: PRICES.draught },
      { key: 'tonic',   name: CONSUMABLES.tonic.name,   sub: CONSUMABLES.tonic.desc,   price: PRICES.tonic },
      { key: 'charm',   name: CONSUMABLES.charm.name,   sub: CONSUMABLES.charm.desc,   price: PRICES.charm },
    ],
  },
};

export const isVendor = (id) => !!VENDORS[id];
export const vendorFor = (id) => VENDORS[id] || null;

// ---------------------------------------------------------------- stock
// Rolled gear is kept per session (a bought row is removed; the rest sit until reload) —
// a shop that rerolls on every open is a free slot machine.
const _rolled = {};   // vendorId -> [{ spec, item }]

function gearRows(ctx, v) {
  if (!v.gear) return [];
  if (!_rolled[v.id]) {
    _rolled[v.id] = v.gear.map((spec) => {
      let item = null;
      // `source: { level }` is how the roller takes a level bracket: rollItemAt reads
      // source.level * POWER_PER_LEVEL for the item's power (see loot.js) — same route a
      // level-N corpse takes, so shop gear sits exactly in the vendor's stated bracket.
      try { item = ctx.rpg.rollItem?.(spec.tier, { kind: spec.kind, source: { level: spec.level } }); } catch (e) {}
      return item ? { spec, item } : null;
    }).filter(Boolean);
  }
  return _rolled[v.id];
}

const carried = (ctx) => (ctx.weapons && ctx.weapons.slots) || [];

/** Everything this vendor will sell right now, priced and buy-gated — plain JSON for the UI. */
export function stockFor(ctx, npcId) {
  const v = VENDORS[npcId];
  if (!v) return [];
  const g = S.currencies.glimmer | 0;
  const rows = [];
  for (const r of gearRows(ctx, v)) {
    const it = r.item;
    rows.push({
      key: r.spec.key, kind: it.kind, price: r.spec.price, item: it,
      canBuy: g >= r.spec.price, why: g >= r.spec.price ? '' : 'not enough glimmer',
    });
  }
  for (const row of v.goods || []) {
    let canBuy = g >= row.price, why = canBuy ? '' : 'not enough glimmer';
    if (row.key === 'ammoLight' && !carried(ctx).some(Boolean)) { canBuy = false; why = 'no weapons carried'; }
    if (row.key === 'ammoSpecial' && !carried(ctx).some((w) => w && SPECIAL_ARCH.has(w.archetype))) {
      canBuy = false; why = 'no special weapon carried';
    }
    rows.push({ key: row.key, kind: 'goods', name: row.name, sub: row.sub, price: row.price, canBuy, why });
  }
  return rows;
}

// ---------------------------------------------------------------- buy
const AMMO_PCT = 0.6;

function grantAmmo(ctx, special) {
  const wp = ctx.weapons;
  const slots = carried(ctx);
  let given = 0;
  for (let i = 0; i < slots.length; i++) {
    const w = slots[i];
    if (!w) continue;
    if (special && !SPECIAL_ARCH.has(w.archetype)) continue;
    const was = w.reserve | 0;
    wp.addAmmo(i, Math.max(1, Math.ceil((w.maxReserve || 0) * AMMO_PCT)));
    given += (w.reserve | 0) - was;
  }
  // same courtesy as the ammo bricks: never leave the mag clicking after a purchase
  if (given > 0 && wp.current && (wp.current.ammo | 0) <= 0) { try { wp.reload(); } catch (e) {} }
  return given;
}

/** The one buy path. Deducts glimmer FIRST (trySpend refuses without touching the wallet),
 *  then grants through the existing flows: addItem for gear, addAmmo for ammo, the
 *  consumables pouch for draughts. */
export function buy(ctx, npcId, key) {
  const v = VENDORS[npcId];
  if (!v) return { ok: false, reason: 'no such vendor' };

  // rolled gear row?
  const gr = gearRows(ctx, v).find((r) => r.spec.key === key);
  if (gr) {
    if (!trySpend(ctx, { glimmer: gr.spec.price })) return { ok: false, reason: 'not enough glimmer' };
    ctx.rpg.addItem(gr.item);
    _rolled[v.id] = _rolled[v.id].filter((r) => r !== gr);   // sold — off the shelf
    ctx.rpg.save?.();
    ctx.events.emit('shop:bought', { vendor: npcId, key, item: gr.item });
    return { ok: true, name: gr.item.name };
  }

  const row = (v.goods || []).find((r) => r.key === key);
  if (!row) return { ok: false, reason: 'not in stock' };
  if (key === 'ammoLight' || key === 'ammoSpecial') {
    const special = key === 'ammoSpecial';
    if (special && !carried(ctx).some((w) => w && SPECIAL_ARCH.has(w.archetype))) {
      return { ok: false, reason: 'no special weapon carried' };
    }
    if (!trySpend(ctx, { glimmer: row.price })) return { ok: false, reason: 'not enough glimmer' };
    const given = grantAmmo(ctx, special);
    ctx.events.emit('shop:bought', { vendor: npcId, key, given });
    return { ok: true, name: row.name + (given ? ` — +${given} rounds` : '') };
  }
  if (CONSUMABLES[key]) {
    if (!trySpend(ctx, { glimmer: row.price })) return { ok: false, reason: 'not enough glimmer' };
    S.consumables[key] = (S.consumables[key] | 0) + 1;
    ctx.rpg.save?.();
    ctx.events.emit('shop:bought', { vendor: npcId, key });
    return { ok: true, name: row.name };
  }
  return { ok: false, reason: 'not in stock' };
}
