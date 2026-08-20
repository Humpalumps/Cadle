// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Aetherfall via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: rpg agent. Item definitions + procedural generation. Pure data, no THREE, no ctx.
// Everything here returns plain JSON-safe objects so save/load is a straight stringify.
import { weaponName, armourName } from './names.js';

export const RARITY = {
  common:    { key: 'common',    label: 'Common',    w: 0.550, color: 0xb8c0c8, perks: 1, mult: 1.00, statSpread: 0.35 },
  uncommon:  { key: 'uncommon',  label: 'Uncommon',  w: 0.280, color: 0x74d68a, perks: 2, mult: 1.06, statSpread: 0.50 },
  rare:      { key: 'rare',      label: 'Rare',      w: 0.125, color: 0x6aa6ff, perks: 2, mult: 1.14, statSpread: 0.66 },
  legendary: { key: 'legendary', label: 'Legendary', w: 0.038, color: 0xb478ff, perks: 3, mult: 1.26, statSpread: 0.82 },
  exotic:    { key: 'exotic',    label: 'Exotic',    w: 0.007, color: 0xffb43c, perks: 4, mult: 1.42, statSpread: 1.00 },
};
export const TIERS = ['common', 'uncommon', 'rare', 'legendary', 'exotic'];
export const rarityOf = (k) => RARITY[k] || RARITY.common;

export const ELEMENTS = {
  kinetic: { label: 'Kinetic', color: 0xe8e2d2, note: 'plain, honest steel' },
  solar:   { label: 'Solar',   color: 0xff9a3c, note: 'burns what it touches' },
  arc:     { label: 'Arc',     color: 0x8fdcff, note: 'leaps between the struck' },
  void:    { label: 'Void',    color: 0xa070ff, note: 'drinks the light around it' },
  verdant: { label: 'Verdant', color: 0x8ce07a, note: 'the vale answers when it sings' },
};

// Fallback archetypes. We prefer ctx.weapon.archetypes when combat publishes it, so these
// mirror combat's armoury exactly — ids included. Inventing ids combat has never heard of
// (autorifle / pulse / longbow / stormcaster) is what let an equipped Longbow leave a hand
// cannon in your hands; nothing here may name a gun that does not exist.
export const ARCHETYPES = [   // mirrors Aetherfall's armoury (src/player/weapons/defs.js) — ids must exist there
  { id: 'autorifle',  label: 'Auto Rifle',   rpm: 600, damage: 12,  range: 46,  stability: 82, handling: 47, mag: 32 },
  { id: 'handcannon', label: 'Hand Cannon',  rpm: 140, damage: 34,  range: 64,  stability: 45, handling: 65, mag: 6 },
  { id: 'pulse',      label: 'Pulse Rifle',  rpm: 300, damage: 20,  range: 80,  stability: 70, handling: 55, mag: 21 },
  { id: 'shotgun',    label: 'Shotgun',      rpm: 80,  damage: 90,  range: 12,  stability: 40, handling: 60, mag: 6 },
  { id: 'sniper',     label: 'Sniper Rifle', rpm: 90,  damage: 130, range: 170, stability: 50, handling: 35, mag: 4 },
  { id: 'fusion',     label: 'Fusion Rifle', rpm: 70,  damage: 118, range: 60,  stability: 27, handling: 32, mag: 5 },
];

// perk slots: barrel (range/stability), magazine (mag/handling), trait (the one you keep it for)
export const PERKS = {
  barrel: [
    { id: 'coiled',    name: 'Coiled Barrel',   desc: '+range, -handling',      mods: { range: 12, handling: -6 } },
    { id: 'smallbore', name: 'Smallbore',       desc: '+range, +stability',     mods: { range: 8, stability: 8 } },
    { id: 'chambered', name: 'Chambered Brace', desc: '+stability',             mods: { stability: 14 } },
    { id: 'fluted',    name: 'Fluted Shroud',   desc: '+handling',              mods: { handling: 15 } },
    { id: 'thornlash', name: 'Thornlash',       desc: '+damage, -stability',    mods: { damagePct: 6, stability: -8 } },
  ],
  magazine: [
    { id: 'deepwell',  name: 'Deep Well',       desc: '+magazine',              mods: { magPct: 30 } },
    { id: 'lightmag',  name: 'Light Magazine',  desc: '+handling, +reload',     mods: { handling: 10, reload: 12 } },
    { id: 'ricochet',  name: 'Ricochet Rounds', desc: '+stability, +range',     mods: { stability: 7, range: 5 } },
    { id: 'quickfall', name: 'Quickfall Drum',  desc: '+rpm, -damage',          mods: { rpmPct: 10, damagePct: -5 } },
    { id: 'heavyload', name: 'Heavy Load',      desc: '+damage, -magazine',     mods: { damagePct: 9, magPct: -20 } },
  ],
  trait: [
    { id: 'rampage',   name: 'Rampage',         desc: 'kills stack +damage',    mods: { damagePct: 4 }, tag: 'rampage' },
    { id: 'kill_clip', name: 'Kill Clip',       desc: 'reload after a kill: +damage', mods: {}, tag: 'killclip' },
    { id: 'outlaw',    name: 'Outlaw',          desc: 'precision kills: fast reload', mods: { reload: 25 }, tag: 'outlaw' },
    { id: 'firefly',   name: 'Firefly',         desc: 'precision kills detonate', mods: {}, tag: 'firefly' },
    { id: 'vale_song', name: 'Vale Song',       desc: 'kills mend your shield', mods: {}, tag: 'valesong' },
    { id: 'headseek',  name: 'Headseeker',      desc: '+crit damage',           mods: { critPct: 20 }, tag: 'headseeker' },
    { id: 'lastbreath',name: 'Last Breath',     desc: 'last round hits far harder', mods: {}, tag: 'lastbreath' },
    { id: 'unwaver',   name: 'Unwavering',      desc: 'no flinch, +stability',  mods: { stability: 12 }, tag: 'unwavering' },
  ],
};

// Exotics are named things, not rolls. Six of them; each has one rule-bending perk.
// Every `arch` here must be an id that exists in combat's armoury (auto / handcannon /
// scout / beam) — see ARCHETYPES above.
export const EXOTICS = [
  { id: 'x_thousand',  name: 'A Thousand Quiet Mornings', arch: 'sniper',      element: 'solar',   perk: { name: 'Slow Dawn', desc: 'every shot that lands makes the next one brighter', tag: 'slowdawn' }, flavour: 'Held by the last watcher of Emberfen, who never fired it in anger.' },
  { id: 'x_sablewake', name: 'Sablewake',                 arch: 'handcannon', element: 'void',    perk: { name: 'Widow\'s Tithe', desc: 'kills open a rift that drinks light', tag: 'tithe' }, flavour: 'It remembers a name nobody in Aurelen will say aloud.' },
  { id: 'x_chorister', name: 'The Chorister',             arch: 'autorifle',       element: 'arc',     perk: { name: 'Antiphon', desc: 'every third shot chains to a second throat', tag: 'antiphon' }, flavour: 'Sing, and the Vale sings the harmony you were too small to hear.' },
  { id: 'x_greenhour', name: 'Green Hour',                arch: 'autorifle',       element: 'verdant', perk: { name: 'Overgrowth', desc: 'sustained fire grows roots through the target', tag: 'overgrowth' }, flavour: 'The forge was a garden. Nobody has explained this satisfactorily.' },
  { id: 'x_longsorrow',name: 'Long Sorrow',               arch: 'sniper',      element: 'kinetic', perk: { name: 'Patience and Time', desc: 'a held aim never misses what it deserves', tag: 'patience' }, flavour: 'Four hundred years of aim, spent on one deer, once.' },
  { id: 'x_kaltmere',  name: 'Kaltmere\'s Answer',        arch: 'fusion',       element: 'arc',     perk: { name: 'The Reply', desc: 'damage taken is stored and returned', tag: 'reply' }, flavour: 'He asked the storm a question. This is what came back.' },
];

export const ARMOUR_SLOTS = ['head', 'arms', 'chest', 'legs', 'cloak'];
const SLOT_LABEL = { head: 'Helm', arms: 'Gauntlets', chest: 'Plate', legs: 'Greaves', cloak: 'Cloak' };

export const ARMOUR_SETS = {
  pilgrim:  { label: 'Vale Pilgrim',  two: { id: 'sure_foot', name: 'Sure Foot',  desc: '+8 mobility', stats: { mobility: 8 } },
                                      four:{ id: 'longstride', name: 'Longstride', desc: 'dash cooldown -25%', mods: { dashCdMul: 0.75 } } },
  emberward:{ label: 'Emberward',     two: { id: 'banked_coal', name: 'Banked Coal', desc: '+8 resilience', stats: { resilience: 8 } },
                                      four:{ id: 'hearthfire', name: 'Hearthfire', desc: 'shield regen 35% faster', mods: { shieldRegenMul: 1.35 } } },
  glasswright:{label: 'Glasswright',  two: { id: 'clear_eye', name: 'Clear Eye',  desc: '+8 recovery', stats: { recovery: 8 } },
                                      four:{ id: 'facets', name: 'Facets', desc: '+8% weapon damage', mods: { damageMul: 1.08 } } },
  chorus:   { label: 'Chorus Keeper', two: { id: 'refrain', name: 'Refrain', desc: '+8 discipline', stats: { discipline: 8 } },
                                      four:{ id: 'full_choir', name: 'Full Choir', desc: 'rarer drops (+30% luck)', mods: { luck: 0.3 } } },
  wyrmsworn:{ label: 'Wyrmsworn',     two: { id: 'scaled', name: 'Scaled', desc: '+8 strength', stats: { strength: 8 } },
                                      four:{ id: 'hoard', name: 'Hoard', desc: '+50% glimmer', mods: { currencyMul: 1.5 } } },
};
const SET_KEYS = Object.keys(ARMOUR_SETS);
export const STAT_KEYS = ['mobility', 'resilience', 'recovery', 'discipline', 'strength'];

// ---------------------------------------------------------------- exotic armour
// An exotic is a named thing or it is not an exotic. A 0.72% drop used to have a 25% chance
// of landing on "Chorus Keeper Greaves" — a generic string with a gold border.
export const EXOTIC_ARMOUR = [
  { id: 'xa_striders', name: 'Nine-League Striders', slot: 'legs',  set: 'pilgrim',
    perk: { name: 'Ground Given', desc: 'sprinting long enough turns the ground under you soft and fast', tag: 'groundgiven' },
    flavour: 'She walked to Kaltmere and back to settle an argument about how far Kaltmere was.' },
  { id: 'xa_hearth',   name: 'The Banked Hearth',    slot: 'chest', set: 'emberward',
    perk: { name: 'Coal Kept Warm', desc: 'the shield you do not spend becomes the shield you get back', tag: 'coalkept' },
    flavour: 'Emberfen kept one fire lit for two hundred years. This is what was left of the keeper.' },
  { id: 'xa_facet',    name: 'Sixhundredth Pane',    slot: 'head',  set: 'glasswright',
    perk: { name: 'Not The Same Sky', desc: 'precision hits show you the next one before you take it', tag: 'notsamesky' },
    flavour: 'The last pane the Glasswright cut. She looked through it once and stopped cutting.' },
  { id: 'xa_antiphon', name: 'Second Throat',        slot: 'cloak', set: 'chorus',
    perk: { name: 'Answering Voice', desc: 'your abilities come back when someone else sings', tag: 'answering' },
    flavour: 'A choir needs two. It has been a very long time since there were two.' },
  { id: 'xa_hoard',    name: 'Kindly Wyrm\'s Grasp', slot: 'arms',  set: 'wyrmsworn',
    perk: { name: 'The Kind Part', desc: 'what you break pays you twice', tag: 'kindpart' },
    flavour: 'Threnn wrote that the wyrm was kind. Threnn was holding these when she wrote it.' },
];

const pick = (a, rand) => a[(rand() * a.length) | 0];

// name grammar lives in names.js — re-exported so callers keep one import
export { weaponName, armourName };

// ---------------------------------------------------------------- generation
let nextId = 1;
const uid = () => 'i' + (nextId++) + '_' + ((Math.random() * 1e6) | 0).toString(36);

function rollN(pool, n, rand) {
  const src = pool.slice(), out = [];
  for (let i = 0; i < n && src.length; i++) out.push(src.splice((rand() * src.length) | 0, 1)[0]);
  return out;
}

// spread points around a base value; higher rarity = wider swing, so two of the same
// archetype genuinely handle differently.
const jitter = (base, spread, rand) => Math.max(1, Math.round(base * (1 + (rand() * 2 - 1) * 0.22 * spread)));

export function makeWeapon(tier, powerLevel, opts = {}) {
  const rand = opts.rand || Math.random;
  const r = rarityOf(tier);
  const archPool = (opts.archetypes && opts.archetypes.length) ? opts.archetypes : ARCHETYPES;
  const arch = opts.archetype ? (archPool.find(a => a.id === opts.archetype) || archPool[0]) : pick(archPool, rand);

  if (tier === 'exotic') {
    // only offer exotics whose archetype the live armoury actually has, so an equipped
    // exotic always puts the gun it names in your hands
    const usable = EXOTICS.filter(e => archPool.some(a => a.id === e.arch));
    const pool = usable.length ? usable : EXOTICS;
    const ex = opts.exotic ? (pool.find(e => e.id === opts.exotic) || pick(pool, rand)) : pick(pool, rand);
    const base = archPool.find(a => a.id === ex.arch) || ARCHETYPES.find(a => a.id === ex.arch) || arch;
    return finish({
      id: uid(), kind: 'weapon', rarity: 'exotic', exoticId: ex.id, name: ex.name,
      archetype: base.id, archetypeLabel: base.label || base.id, element: ex.element,
      flavour: ex.flavour, power: powerLevel + 12, upgrades: 0, masterwork: 0,
      perks: [{ id: 'x_' + ex.id, name: ex.perk.name, desc: ex.perk.desc, tag: ex.perk.tag, slot: 'exotic', mods: {} },
              ...rollN(PERKS.barrel, 1, rand).map(p => ({ ...p, slot: 'barrel' })),
              ...rollN(PERKS.magazine, 1, rand).map(p => ({ ...p, slot: 'magazine' })),
              ...rollN(PERKS.trait, 1, rand).map(p => ({ ...p, slot: 'trait' }))],
      base: {
        damage: jitter(base.damage, 1, rand), rpm: base.rpm, mag: jitter(base.mag, 0.6, rand),
        range: jitter(base.range, 1, rand), stability: jitter(base.stability, 1, rand), handling: jitter(base.handling, 1, rand),
      },
    });
  }

  const nPerks = r.perks;
  const perks = [];
  if (nPerks >= 1) perks.push(...rollN(PERKS.trait, 1, rand).map(p => ({ ...p, slot: 'trait' })));
  if (nPerks >= 2) perks.push(...rollN(PERKS.barrel, 1, rand).map(p => ({ ...p, slot: 'barrel' })));
  if (nPerks >= 3) perks.push(...rollN(PERKS.magazine, 1, rand).map(p => ({ ...p, slot: 'magazine' })));
  if (nPerks >= 4) perks.push(...rollN(PERKS.trait.filter(t => t.id !== perks[0].id), 1, rand).map(p => ({ ...p, slot: 'trait' })));

  const elKeys = Object.keys(ELEMENTS);
  const element = opts.element || (tier === 'common' ? 'kinetic' : pick(elKeys, rand));
  // the name is rolled *from* the weapon, never beside it: element picks the imagery,
  // archetype picks the noun, the trait perk can take the name over entirely.
  return finish({
    id: uid(), kind: 'weapon', rarity: r.key,
    name: opts.name || weaponName({ element, archetype: arch.id, perks }, rand),
    archetype: arch.id, archetypeLabel: arch.label || arch.id,
    element,
    power: powerLevel, upgrades: 0, masterwork: 0, perks,
    base: {
      damage: jitter(arch.damage, r.statSpread, rand), rpm: arch.rpm,
      mag: jitter(arch.mag, r.statSpread * 0.7, rand),
      range: jitter(arch.range, r.statSpread, rand),
      stability: jitter(arch.stability, r.statSpread, rand),
      handling: jitter(arch.handling, r.statSpread, rand),
    },
  });
}

export function makeArmour(tier, powerLevel, opts = {}) {
  const rand = opts.rand || Math.random;
  const r = rarityOf(tier);
  const ex = tier === 'exotic'
    ? (opts.exotic ? EXOTIC_ARMOUR.find(e => e.id === opts.exotic) : pick(EXOTIC_ARMOUR, rand))
    : null;
  const slot = ex ? ex.slot : (opts.slot || pick(ARMOUR_SLOTS, rand));
  const setKey = ex ? ex.set : (opts.set || pick(SET_KEYS, rand));
  // total stat budget scales with rarity, split unevenly so pieces have a personality
  const budget = Math.round(18 + r.statSpread * 40 + rand() * 10);
  const stats = { mobility: 0, resilience: 0, recovery: 0, discipline: 0, strength: 0 };
  const weights = STAT_KEYS.map(() => rand() * rand()); // squared -> lopsided, most pieces favour one stat
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  STAT_KEYS.forEach((k, i) => { stats[k] = Math.round(budget * weights[i] / total); });
  const weave = { id: 'armour_' + setKey, name: ARMOUR_SETS[setKey].label + ' Weave', desc: 'counts double toward its set', tag: 'setdouble', slot: 'armour', mods: {} };
  return {
    id: uid(), kind: 'armour', rarity: r.key, slot, set: setKey,
    // exotic armour is a named thing; everything else names itself after what it is built for
    name: ex ? ex.name : (opts.name || armourName(slot, setKey, rand, stats)),
    exoticId: ex ? ex.id : undefined, flavour: ex ? ex.flavour : undefined,
    setLabel: ARMOUR_SETS[setKey].label,
    power: powerLevel + (ex ? 12 : 0), upgrades: 0, stats,
    perks: ex
      ? [{ id: 'x_' + ex.id, name: ex.perk.name, desc: ex.perk.desc, tag: ex.perk.tag, slot: 'exotic', mods: {} }, weave]
      : (tier === 'legendary' ? [weave] : []),
  };
}

export const CONSUMABLES = {
  draught: { id: 'draught', name: 'Vale Draught',   desc: 'restores 60 health' },
  tonic:   { id: 'tonic',   name: 'Glasswright Tonic', desc: '+45 overshield for 25s' },
  charm:   { id: 'charm',   name: 'Wyrm Charm',     desc: 'luck +60% for the next 6 drops' },
};

// ---------------------------------------------------------------- derived stats
// One place that turns an item + its perks + upgrades into the numbers combat reads.
export function weaponStats(w) {
  if (!w || !w.base) return null;
  const acc = { damagePct: 0, rpmPct: 0, magPct: 0, range: 0, stability: 0, handling: 0, reload: 0, critPct: 0 };
  for (const p of w.perks || []) for (const k in (p.mods || {})) acc[k] = (acc[k] || 0) + p.mods[k];
  const r = rarityOf(w.rarity);
  const up = 1 + (w.upgrades || 0) * 0.02;
  const pw = 1 + (w.power || 0) * 0.0035;
  return {
    damage: +(w.base.damage * r.mult * up * pw * (1 + acc.damagePct / 100)).toFixed(2),
    rpm: Math.max(45, Math.round(w.base.rpm * (1 + acc.rpmPct / 100))),
    mag: Math.max(1, Math.round(w.base.mag * (1 + acc.magPct / 100))),
    range: Math.round(w.base.range + acc.range),
    stability: Math.max(1, Math.min(100, Math.round(w.base.stability + acc.stability))),
    handling: Math.max(1, Math.min(100, Math.round(w.base.handling + acc.handling))),
    reload: Math.round(acc.reload),
    critMul: 2 + acc.critPct / 100,
    tags: (w.perks || []).map(p => p.tag).filter(Boolean),
  };
}

// finish() exists only so makeWeapon has one exit point that stamps derived stats.
function finish(w) { w.stats = weaponStats(w); return w; }
export function restat(item) { if (item && item.kind === 'weapon') item.stats = weaponStats(item); return item; }

export function itemPower(it) { return (it && it.power) || 0; }

// one compact line for prompts and nameplates: what it is called, and what it is
export const shortLabel = (it) => !it ? '' : it.kind === 'weapon'
  ? `${it.name} · ${rarityOf(it.rarity).label} ${it.archetypeLabel}`
  : `${it.name} · ${rarityOf(it.rarity).label} ${SLOT_LABEL[it.slot] || it.slot}`;

export function describe(it) {
  if (!it) return '';
  if (it.kind === 'weapon') {
    const s = it.stats || weaponStats(it);
    return `${it.name} — ${rarityOf(it.rarity).label} ${it.archetypeLabel} · ${(ELEMENTS[it.element] || ELEMENTS.kinetic).label} · ${Math.round(s.damage)} dmg / ${s.rpm} rpm · pwr ${it.power}`;
  }
  const dom = STAT_KEYS.reduce((a, k) => ((it.stats || {})[k] > ((it.stats || {})[a] || 0) ? k : a), 'resilience');
  return `${it.name} — ${rarityOf(it.rarity).label} ${SLOT_LABEL[it.slot] || it.slot} · ${it.setLabel || ''} · ${dom} ${(it.stats || {})[dom] || 0} · pwr ${it.power}`;
}
