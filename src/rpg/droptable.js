// OWNER: rpg agent. The drop table, lifted verbatim out of loot.js.
//
// WHY IT IS ITS OWN FILE: it must be importable by plain `node` — no browser, no THREE, no
// canvas — so tools/curvecheck.mjs can roll 100,000 tiers in CI and prove the published rates
// still hold. loot.js re-exports everything here, so nothing downstream changed.
// Nothing in this file may import THREE, touch the DOM, or read `window`. items.js is pure
// data (it only pulls names.js, also pure), so importing TIERS from it is safe in node.
import { TIERS } from './items.js';

// Base weights. Pity only ever *adds* on top of these, so the long-run shape holds.
export const W = { common: 0.550, uncommon: 0.280, rare: 0.125, legendary: 0.038, exotic: 0.007 };
// hard pity: a drought this long ends now. Set roughly 3x the mean gap for each tier so
// it catches genuine bad luck without dragging the measured rates off the table above.
export const HARD = { rare: 20, legendary: 90, exotic: 400 };
// soft pity: odds start climbing from here
export const SOFT = { legendary: 55, exotic: 260 };
export const RAMP = { legendary: 0.0025, exotic: 0.0005 };

export const dry = { rare: 0, legendary: 0, exotic: 0 };
export const counts = { common: 0, uncommon: 0, rare: 0, legendary: 0, exotic: 0 };

// Loot rarity varies per run on purpose -> Math.random, not ctx.rng.
export function rollTier(luck = 0) {
  let tier;
  if (dry.exotic >= HARD.exotic) tier = 'exotic';
  else if (dry.legendary >= HARD.legendary) tier = 'legendary';
  else {
    const pe = W.exotic * (1 + luck) + Math.max(0, dry.exotic - SOFT.exotic) * RAMP.exotic;
    const pl = W.legendary * (1 + luck) + Math.max(0, dry.legendary - SOFT.legendary) * RAMP.legendary;
    const pr = W.rare * (1 + luck * 0.5);
    const r = Math.random();
    if (r < pe) tier = 'exotic';
    else if (r < pe + pl) tier = 'legendary';
    else if (r < pe + pl + pr) tier = 'rare';
    else if (dry.rare >= HARD.rare) tier = 'rare';
    else if (r < pe + pl + pr + W.uncommon) tier = 'uncommon';
    else tier = 'common';
  }
  const idx = TIERS.indexOf(tier);
  dry.rare = idx >= 2 ? 0 : dry.rare + 1;
  dry.legendary = idx >= 3 ? 0 : dry.legendary + 1;
  dry.exotic = idx >= 4 ? 0 : dry.exotic + 1;
  counts[tier]++;
  return tier;
}

export const pity = () => ({ ...dry, hard: HARD, soft: SOFT });

/** Zero the pity droughts and the tally so a simulation can run repeatable trials. */
export function resetTable() {
  dry.rare = dry.legendary = dry.exotic = 0;
  for (const k in counts) counts[k] = 0;
  return counts;
}

// ------------------------------------------------------------------ tier floors
// A floor is a GIFT applied on top of a finished roll, never a parameter of the roll: the
// pity counters have already moved on the tier the table actually produced, so guaranteeing a
// boss a legendary cannot drag the published long-run rates off the table. That separation is
// the thing curvecheck.mjs measures — do not fold `floor` into rollTier().
export function atLeast(tier, floor) {
  if (!floor) return tier;
  return TIERS.indexOf(floor) > TIERS.indexOf(tier) ? floor : tier;
}

// ------------------------------------------------------------------ what did I kill
// One classifier, shared by loot.js (tier floors, drop count) and ammo.js (special-brick
// odds), so the two can never disagree about what an elite is.
// ponytail: the type regex is a stand-in until Enemies publishes `enemy.elite` — the flag is
// checked first, so the day it lands this list stops mattering. See the API ASK in the report.
const ELITE_TYPES = /golem|drake|treant|icegiant|seraph|skyserpent|wyvern|forgeknight|bogwitch|leviathan|voidhorror/;

/** 'trash' | 'elite' | 'boss' */
export function enemyTier(en) {
  if (!en) return 'trash';
  if (en.def && en.def.boss) return 'boss';
  if (en.elite) return 'elite';
  return ELITE_TYPES.test(en.type || '') ? 'elite' : 'trash';
}

// One runnable check: the floor must never demote, and the classifier must resolve the three
// cases it exists for. `node -e "import('./src/rpg/droptable.js').then(m=>m.selfTest())"`.
export function selfTest() {
  if (atLeast('exotic', 'rare') !== 'exotic') throw new Error('atLeast demoted a tier');
  if (atLeast('common', 'legendary') !== 'legendary') throw new Error('atLeast failed to lift');
  if (atLeast('rare', null) !== 'rare') throw new Error('atLeast mangled a null floor');
  if (enemyTier({ def: { boss: true }, type: 'warden' }) !== 'boss') throw new Error('boss missed');
  if (enemyTier({ type: 'magmagolem' }) !== 'elite') throw new Error('elite missed');
  if (enemyTier({ type: 'wisp' }) !== 'trash') throw new Error('trash misread');
  if (enemyTier({ type: 'wisp', elite: true }) !== 'elite') throw new Error('elite flag ignored');
  return true;
}
