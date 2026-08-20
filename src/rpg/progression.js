// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Cadle via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: rpg agent. Levels, stats, skill tree, abilities, inventory, equipment, economy.
// Everything the player *is*. Loot/quests live in their own files.
import {
  RARITY, rarityOf, STAT_KEYS, ARMOUR_SETS, ARMOUR_SLOTS, CONSUMABLES,
  makeWeapon, makeArmour, weaponStats, restat, describe,
} from './items.js';

// ------------------------------------------------------------------ curve
export const MAX_LEVEL = 50;
export const xpToNext = (lvl) => Math.round(80 * Math.pow(lvl, 1.55) + 40 * lvl);

// ------------------------------------------------------------------ skill tree
// Three branches. Each has one genuine either/or fork you cannot un-pick for free.
export const SKILLS = {
  // Wayfarer — traversal
  dash:        { branch: 'wayfarer',   name: 'Windstep',      desc: 'Shift in mid-air: burst forward.',            lvl: 2,  cost: 1 },
  doubleJump:  { branch: 'wayfarer',   name: 'Second Wind',   desc: 'One more air jump than anyone should have.',  lvl: 5,  cost: 1, req: 'dash', excl: 'glide' },
  glide:       { branch: 'wayfarer',   name: 'Vale Glide',    desc: 'Your glide jump carries twice as far.',       lvl: 5,  cost: 1, req: 'dash', excl: 'doubleJump' },
  wanderer:    { branch: 'wayfarer',   name: 'Wanderer',      desc: 'Kills refund Windstep. +12 mobility.',        lvl: 12, cost: 2, req: 'dash' },
  // Emberward — survival / damage
  rally:       { branch: 'emberward',  name: 'Rally',         desc: 'Every kill mends 14 shield.',                 lvl: 3,  cost: 1 },
  bulwark:     { branch: 'emberward',  name: 'Bulwark',       desc: '+15 resilience, +25 max shield.',             lvl: 8,  cost: 1, req: 'rally', excl: 'emberRounds' },
  emberRounds: { branch: 'emberward',  name: 'Ember Rounds',  desc: '+14% weapon damage. Shields stay thin.',      lvl: 8,  cost: 1, req: 'rally', excl: 'bulwark' },
  lastLight:   { branch: 'emberward',  name: 'Last Light',    desc: 'Survive one lethal blow every 90s.',          lvl: 15, cost: 2, req: 'rally' },
  // Loreseeker — loot / world
  keenEye:     { branch: 'loreseeker', name: 'Keen Eye',      desc: 'Loot beams reach further. +80% pickup range.', lvl: 2, cost: 1 },
  fortune:     { branch: 'loreseeker', name: 'Fortune',       desc: '+45% luck. The dry spells get shorter.',      lvl: 6,  cost: 1, req: 'keenEye', excl: 'salvage' },
  salvage:     { branch: 'loreseeker', name: 'Salvage',       desc: '+80% glimmer and materials.',                 lvl: 6,  cost: 1, req: 'keenEye', excl: 'fortune' },
  attunement:  { branch: 'loreseeker', name: 'Attunement',    desc: 'Drops roll +15 power.',                       lvl: 14, cost: 2, req: 'keenEye' },
};

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
// Display tier (0-10, what the UI shows) and the *continuous* response the numbers use.
// Flooring both was the reason eight levels moved max health 121 -> 137 and nothing else:
// a level adds to the base stat, the base stat floored to a tier, and a tier boundary
// arrived roughly every 18 levels. Tiers are now a label, not the mechanism.
const tierOf = (s) => clamp(Math.floor(s / 10), 0, 10);
const tf = (s) => clamp(s / 10, 0, 10);
const toast = (ctx, t, o) => { try { ctx.hud && ctx.hud.toast && ctx.hud.toast(t, o); } catch (e) {} };

// ------------------------------------------------------------------ state
const S = {
  level: 1, xp: 0, points: 0, skills: {},
  inventory: [], equipped: { weapon: null, head: null, arms: null, chest: null, legs: null, cloak: null },
  currencies: { glimmer: 0, emberdust: 0, relicShard: 0 },
  consumables: { draught: 2, tonic: 0, charm: 0 },
  overshield: 0, overshieldT: 0, luckCharges: 0,
  lastHurt: -99, lastShield: 0, dashCd: 0, lastLightT: -99, tuneBase: null,
};
export const state = S;

// ------------------------------------------------------------------ stats
//
// THE PUBLISHED CONTRACT — everything below lands on `ctx.rpg.stats` under these exact
// names and is safe to read every frame. Other pieces should multiply their own tuned
// value by ours rather than replace it.
//
//   moveSpeedMul   1.02 -> 1.22   ground + air speed scalar          (player/controller)
//   jumpMul        1.01 -> 1.14   jump impulse scalar                (player/controller)
//   meleeMul       1.07 -> 1.90   melee damage scalar                (combat)
//   cooldownMul    0.96 -> 0.48   ability cooldown scalar, LOWER IS FASTER  (combat)
//   damageMul      1.00 -> 1.14+  weapon damage scalar               (combat, already live)
//   critMul        2.00 -> 2.20+  precision multiplier               (combat)
//   maxHealth      104  -> 226    integer hit points                 (player, already live)
//   maxShield       77  -> 250    integer shield points              (player, already live)
//   shieldDelay    5.36 -> 2.20   seconds after damage before regen  (rpg drives it here)
//   shieldRegen      30 ->   76   shield points per second
//   dashCooldown   4.97 -> 2.60   seconds between Windsteps
//   pickupRadius   2.2 / 3.96 m   loot magnet radius
//   luck / currencyMul / power / setBonuses / weaponTags / tiers — informational
//
// Every one of them is continuous in level, so a level always moves something measurable.
// Level 1 values sit within ~2% of neutral: a consumer that multiplies blind is safe.
function derive(ctx) {
  // 6 + 1.62/level: reaches ~87 by level 50 on its own, so gear tops the last stretch out.
  // The old 0.55/level never crossed more than two tier lines in a whole playthrough.
  const base = 6 + S.level * 1.62;
  const s = {};
  for (const k of STAT_KEYS) s[k] = base;

  // armour
  const counts = {};
  for (const slot of ARMOUR_SLOTS) {
    const it = S.equipped[slot];
    if (!it || !it.stats) continue;
    for (const k of STAT_KEYS) s[k] += it.stats[k] || 0;
    const weight = (it.perks || []).some(p => p.tag === 'setdouble') ? 2 : 1;
    counts[it.set] = (counts[it.set] || 0) + weight;
  }

  const mods = { damageMul: 1, luck: 0, currencyMul: 1, shieldRegenMul: 1, dashCdMul: 1 };
  const bonuses = [];
  for (const setKey in counts) {
    const def = ARMOUR_SETS[setKey]; if (!def) continue;
    if (counts[setKey] >= 2) { applyBonus(def.two, s, mods); bonuses.push(def.label + ' (2)'); }
    if (counts[setKey] >= 4) { applyBonus(def.four, s, mods); bonuses.push(def.label + ' (4)'); }
  }

  // skills
  if (S.skills.wanderer) s.mobility += 12;
  if (S.skills.bulwark) s.resilience += 15;
  if (S.skills.emberRounds) mods.damageMul *= 1.14;
  if (S.skills.fortune) mods.luck += 0.45;
  if (S.skills.salvage) mods.currencyMul *= 1.8;

  for (const k of STAT_KEYS) s[k] = clamp(Math.round(s[k]), 0, 100);
  const t = {}; for (const k of STAT_KEYS) t[k] = tierOf(s[k]);       // 0-10, for display
  const c = {}; for (const k of STAT_KEYS) c[k] = tf(s[k]);           // 0-10 continuous, for effect

  const w = S.equipped.weapon;
  const ws = w ? (w.stats || weaponStats(w)) : null;

  const st = ctx.rpg.stats;
  Object.assign(st, s, {
    tiers: t,
    moveSpeedMul: +(1 + c.mobility * 0.022).toFixed(4),
    jumpMul: +(1 + c.mobility * 0.014).toFixed(4),
    maxHealth: Math.round(100 + S.level * 2 + c.resilience * 2.6),
    maxShield: Math.round(70 + c.resilience * 15 + (S.skills.bulwark ? 25 : 0) + S.overshield),
    shieldDelay: +(5.4 - c.recovery * 0.32).toFixed(2),
    shieldRegen: Math.round((26 + c.recovery * 5) * mods.shieldRegenMul),
    cooldownMul: +clamp(1 - c.discipline * 0.052, 0.4, 1).toFixed(3),
    meleeMul: +(1 + c.strength * 0.09).toFixed(3),
    damageMul: +mods.damageMul.toFixed(3),
    critMul: ws ? ws.critMul : 2,
    luck: +(mods.luck + (S.luckCharges > 0 ? 0.6 : 0)).toFixed(3),
    currencyMul: +mods.currencyMul.toFixed(3),
    pickupRadius: 2.2 * (S.skills.keenEye ? 1.8 : 1),
    beamRange: S.skills.keenEye ? 260 : 150,
    dashCooldown: +(5 * (1 - c.discipline * 0.048) * mods.dashCdMul).toFixed(2),
    power: powerLevel(),
    setBonuses: bonuses,
    weaponTags: ws ? ws.tags : [],
  });

  // every path that changes the player routes through derive(), so the scalar mirrors the
  // HUD reads get refreshed here rather than in each caller (spendPoint used to miss them).
  ctx.rpg.level = S.level; ctx.rpg.xp = S.xp; ctx.rpg.points = S.points;
  ctx.rpg.next = xpToNext(S.level);

  // push what we own onto the player. Movement/jump multipliers are advertised on both
  // ctx.rpg.stats and ctx.player so whichever the controller reads, it finds them.
  const p = ctx.player;
  if (p) {
    p.maxHealth = st.maxHealth;
    p.maxShield = st.maxShield;
    if (p.health > p.maxHealth) p.health = p.maxHealth;
    if (p.shield > p.maxShield) p.shield = p.maxShield;
    p.moveSpeedMul = st.moveSpeedMul;
    p.jumpMul = st.jumpMul;
    applyTuning(p);
  }
  return st;
}

// The controller owns air movement and exposes its tunables as a live handle (p.tune).
// Traversal skills raise its allowance instead of writing velocity, so its three air-jump
// modes (boost / glide / high) keep their distinct feel. Values are set absolutely from a
// captured baseline, so this stays idempotent across re-derives and save loads.
function applyTuning(p) {
  const T = p.tune;
  if (!T) return;
  if (!S.tuneBase) {
    S.tuneBase = { airJumps: T.airJumps, glideTime: T.glideTime, glideGrav: T.glideGrav, glideSteer: T.glideSteer };
  }
  const b = S.tuneBase;
  if (typeof b.airJumps === 'number') T.airJumps = b.airJumps + (S.skills.doubleJump ? 1 : 0);
  const g = S.skills.glide;
  if (typeof b.glideTime === 'number') T.glideTime = b.glideTime * (g ? 2 : 1);
  if (typeof b.glideGrav === 'number') T.glideGrav = b.glideGrav * (g ? 0.55 : 1);
  if (typeof b.glideSteer === 'number') T.glideSteer = b.glideSteer * (g ? 1.25 : 1);
}

function applyBonus(b, s, mods) {
  if (!b) return;
  for (const k in (b.stats || {})) s[k] = (s[k] || 0) + b.stats[k];
  for (const k in (b.mods || {})) {
    if (k === 'luck') mods.luck += b.mods.luck;
    else mods[k] = (mods[k] || 1) * b.mods[k];
  }
}

export function powerLevel() {
  const gear = [S.equipped.weapon, ...ARMOUR_SLOTS.map(x => S.equipped[x])].filter(Boolean);
  if (!gear.length) return S.level * 8;
  return Math.round(gear.reduce((a, g) => a + (g.power || 0), 0) / gear.length);
}

// ------------------------------------------------------------------ equipment
// The combat piece owns ctx.weapon and rewrites its live fields every frame from its own
// armoury, so we publish the roll beside them (ctx.weapon.roll) instead of fighting for
// them, and express the roll's quality as one multiplier the damage hook applies.
// ponytail: only damage rides the roll. rpm/handling/stability would need combat to read
// ctx.rpg.equipped.weapon; it doesn't yet, and inventing a shadow gun here would be worse.
function baselineDamage(ctx, w) {
  const list = (ctx.weapon && ctx.weapon.archetypes) || [];
  const a = list.find(x => x.id === w.archetype);
  return (a && a.damage) || (w.base && w.base.damage) || 1;
}

function applyWeapon(ctx, w) {
  if (!ctx.weapon) ctx.weapon = {};
  if (!w) { ctx.rpg.weaponMul = 1; return; }
  const s = w.stats || weaponStats(w);
  ctx.rpg.weaponMul = clamp(s.damage / baselineDamage(ctx, w), 0.6, 3);
  ctx.weapon.roll = {
    name: w.name, rarity: w.rarity, element: w.element, archetype: w.archetype,
    archetypeLabel: w.archetypeLabel, power: w.power, upgrades: w.upgrades,
    damage: s.damage, rpm: s.rpm, mag: s.mag, range: s.range,
    stability: s.stability, handling: s.handling, critMul: s.critMul,
    perks: (w.perks || []).map(p => ({ name: p.name, desc: p.desc })), tags: s.tags,
    mul: ctx.rpg.weaponMul, item: w,
  };
  // if combat can hand us the matching gun from its armoury, take it: equipping a rolled
  // Hand Cannon should put a hand cannon in your hands.
  try {
    const list = ctx.combat && ctx.combat.weapons;
    if (list && ctx.combat.equip) {
      const i = list.findIndex(x => x.model === w.archetype || x.id === w.archetype);
      if (i >= 0) ctx.combat.equip(i);
    }
  } catch (e) {}
}

export function equip(ctx, item) {
  if (!item) return false;
  const it = typeof item === 'string' ? S.inventory.find(x => x.id === item) : item;
  if (!it) return false;
  const slot = it.kind === 'weapon' ? 'weapon' : it.slot;
  if (!(slot in S.equipped)) return false;
  const prev = S.equipped[slot];
  if (prev && prev.id === it.id) return true;
  const i = S.inventory.indexOf(it);
  if (i >= 0) S.inventory.splice(i, 1);
  if (prev) S.inventory.push(prev);
  S.equipped[slot] = it;
  derive(ctx);
  if (slot === 'weapon') applyWeapon(ctx, it);
  ctx.events.emit('rpg:equipped', { item: it, slot });
  toast(ctx, 'EQUIPPED — ' + it.name);
  return true;
}

export function addItem(ctx, it) {
  if (!it) return null;
  S.inventory.push(it);
  if (S.inventory.length > 120) S.inventory.splice(0, S.inventory.length - 120);
  return it;
}

export function dismantle(ctx, item) {
  const it = typeof item === 'string' ? S.inventory.find(x => x.id === item) : item;
  const i = S.inventory.indexOf(it);
  if (i < 0) return false;
  S.inventory.splice(i, 1);
  const r = rarityOf(it.rarity);
  grant(ctx, { glimmer: Math.round(40 * r.mult * r.mult), emberdust: r.key === 'legendary' || r.key === 'exotic' ? 2 : 1, relicShard: r.key === 'exotic' ? 1 : 0 });
  return true;
}

// ------------------------------------------------------------------ economy
export function grant(ctx, amounts) {
  const mul = ctx.rpg.stats.currencyMul || 1;
  for (const k in amounts) {
    if (!(k in S.currencies)) continue;
    S.currencies[k] += Math.max(0, Math.round(amounts[k] * (k === 'glimmer' ? mul : 1)));
  }
  ctx.events.emit('rpg:currency', S.currencies);
}

function afford(cost) {
  for (const k in cost) if ((S.currencies[k] || 0) < cost[k]) return false;
  return true;
}
function spend(cost) { for (const k in cost) S.currencies[k] -= cost[k]; }

const findAny = (id) => S.inventory.find(x => x.id === id)
  || [S.equipped.weapon, ...ARMOUR_SLOTS.map(s => S.equipped[s])].find(x => x && x.id === id);

// upgrade: raw power on the thing you already like
export function upgrade(ctx, id) {
  const it = typeof id === 'string' ? findAny(id) : id;
  if (!it) return { ok: false, reason: 'no such item' };
  const u = it.upgrades || 0;
  if (u >= 10) return { ok: false, reason: 'already masterworked' };
  const cost = { glimmer: 120 * (u + 1), emberdust: 1 + Math.floor(u / 3) };
  if (!afford(cost)) return { ok: false, reason: 'not enough glimmer/emberdust', cost };
  spend(cost);
  it.upgrades = u + 1;
  if (it.upgrades === 10) it.masterwork = 1;
  restat(it);
  refresh(ctx);
  toast(ctx, it.name + ' +' + it.upgrades);
  return { ok: true, item: it };
}

// infusion: pour a higher-power drop into a beloved old one so it stays relevant
export function infuse(ctx, targetId, sourceId) {
  const t = typeof targetId === 'string' ? findAny(targetId) : targetId;
  const s = typeof sourceId === 'string' ? S.inventory.find(x => x.id === sourceId) : sourceId;
  if (!t || !s) return { ok: false, reason: 'need a target and a source' };
  if (t.id === s.id) return { ok: false, reason: 'cannot infuse into itself' };
  if (t.kind !== s.kind) return { ok: false, reason: 'kinds must match' };
  if ((s.power || 0) <= (t.power || 0)) return { ok: false, reason: 'source is not higher power' };
  const cost = { glimmer: 350, emberdust: 3, relicShard: t.rarity === 'exotic' ? 1 : 0 };
  if (!afford(cost)) return { ok: false, reason: 'not enough materials', cost };
  spend(cost);
  t.power = s.power;
  restat(t);
  const i = S.inventory.indexOf(s); if (i >= 0) S.inventory.splice(i, 1);
  refresh(ctx);
  toast(ctx, t.name + ' → power ' + t.power);
  return { ok: true, item: t };
}

export function useConsumable(ctx, id) {
  if (!S.consumables[id]) return { ok: false, reason: 'none left' };
  S.consumables[id]--;
  const p = ctx.player;
  if (id === 'draught') { p.health = Math.min(p.maxHealth, p.health + 60); }
  if (id === 'tonic') { S.overshield = 45; S.overshieldT = 25; derive(ctx); p.shield = p.maxShield; }
  if (id === 'charm') { S.luckCharges = 6; derive(ctx); }
  toast(ctx, CONSUMABLES[id].name);
  ctx.events.emit('rpg:consumed', { id, left: S.consumables[id] });
  return { ok: true };
}

// ------------------------------------------------------------------ skills
export function canSpend(id) {
  const n = SKILLS[id];
  if (!n) return 'unknown node';
  if (S.skills[id]) return 'already learned';
  if (S.level < n.lvl) return 'requires level ' + n.lvl;
  if (n.req && !S.skills[n.req]) return 'requires ' + SKILLS[n.req].name;
  if (n.excl && S.skills[n.excl]) return 'you chose ' + SKILLS[n.excl].name;
  if (S.points < n.cost) return 'needs ' + n.cost + ' point' + (n.cost > 1 ? 's' : '');
  return null;
}

export function spendPoint(ctx, id) {
  const why = canSpend(id);
  if (why) return { ok: false, reason: why };
  S.points -= SKILLS[id].cost;
  S.skills[id] = 1;
  derive(ctx);
  toast(ctx, 'UNLOCKED — ' + SKILLS[id].name);
  ctx.events.emit('rpg:skill', { id, node: SKILLS[id] });
  return { ok: true };
}

export function skillTree() {
  const out = { wayfarer: [], emberward: [], loreseeker: [] };
  for (const id in SKILLS) {
    const n = SKILLS[id];
    out[n.branch].push({ id, ...n, owned: !!S.skills[id], blocked: canSpend(id) });
  }
  return out;
}

// ------------------------------------------------------------------ xp
export function addXp(ctx, n) {
  n = Math.max(0, Math.round(n || 0));
  if (!n || S.level >= MAX_LEVEL) { ctx.rpg.xp = S.xp; return; }
  S.xp += n;
  ctx.events.emit('rpg:xp', { gained: n, xp: S.xp, next: ctx.rpg.next });
  let next = xpToNext(S.level);
  while (S.xp >= next && S.level < MAX_LEVEL) {
    const was = { hp: ctx.rpg.stats.maxHealth, sh: ctx.rpg.stats.maxShield, st: ctx.rpg.stats.resilience };
    S.xp -= next;
    S.level++;
    // every fifth level is a milestone: a second point and a guaranteed good drop, so the
    // curve has landmarks in it rather than fifty identical +1s
    const milestone = S.level % 5 === 0;
    S.points += milestone ? 2 : 1;
    derive(ctx);
    ctx.player.health = ctx.player.maxHealth;
    ctx.player.shield = ctx.player.maxShield;
    // say what the level actually bought. A level that reports nothing feels like nothing.
    const st = ctx.rpg.stats;
    const sub = `+${st.resilience - was.st} to every stat · +${st.maxHealth - was.hp} health · +${st.maxShield - was.sh} shield`;
    toast(ctx, 'LEVEL ' + S.level + (milestone ? '  ·  MILESTONE' : ''),
      { kind: 'level', sub: sub + (milestone ? '  ·  +2 points' : '  ·  +1 point') });
    if (milestone) {
      try { ctx.rpg.dropLoot(ctx.player.position, S.level >= 25 ? 'legendary' : 'rare'); } catch (e) {}
    }
    ctx.events.emit('rpg:levelup', S.level);
    next = xpToNext(S.level);
  }
  ctx.rpg.level = S.level; ctx.rpg.xp = S.xp; ctx.rpg.next = next; ctx.rpg.points = S.points;
}

export function refresh(ctx) {
  derive(ctx);
  applyWeapon(ctx, S.equipped.weapon);
  ctx.rpg.level = S.level; ctx.rpg.xp = S.xp; ctx.rpg.next = xpToNext(S.level);
  ctx.rpg.points = S.points; ctx.rpg.skills = S.skills;
  ctx.rpg.inventory = S.inventory; ctx.rpg.equipped = S.equipped;
  ctx.rpg.currencies = S.currencies; ctx.rpg.consumables = S.consumables;
}

// ------------------------------------------------------------------ lifecycle
export function init(ctx) {
  ctx.rpg.stats = ctx.rpg.stats || {};
  ctx.rpg.weaponMul = 1;
  refresh(ctx);

  // Combat resolves damage from its own weapon defs, so the resolved number is the one
  // place a weapon roll and your armour stats can actually reach the fight. Wrap it once.
  // Combat can opt out by checking ctx.rpg.appliesDamageMul before applying its own.
  const base = ctx.combat && ctx.combat.damage;
  if (typeof base === 'function' && !ctx.rpg.appliesDamageMul) {
    ctx.combat.damage = (target, amount, opts) =>
      base(target, amount * (ctx.rpg.stats.damageMul || 1) * (ctx.rpg.weaponMul || 1), opts);
    ctx.rpg.appliesDamageMul = true;
  }

  ctx.events.on('player:hurt', () => { S.lastHurt = ctx.time; });

  ctx.events.on('enemy:death', () => {
    if (S.skills.rally) ctx.player.shield = Math.min(ctx.rpg.stats.maxShield, ctx.player.shield + 14);
    if (S.skills.wanderer) S.dashCd = 0;
    if (S.luckCharges > 0) { S.luckCharges--; if (!S.luckCharges) derive(ctx); }
  });

  // starter kit, only on a brand new save (index.js clears it if a save loaded)
  ctx.rpg._giveStarter = () => {
    const w = makeWeapon('common', 10, { archetype: 'handcannon', name: 'Dawnbreak Oath' });
    addItem(ctx, w);
    equip(ctx, w);
    addItem(ctx, makeArmour('common', 10, { slot: 'chest', set: 'pilgrim' }));
  };
}

// ------------------------------------------------------------------ abilities
// Air jumps and glide belong to the controller (see applyTuning). The only thing left here
// is Windstep, which the controller has no equivalent of.
// ponytail: Windstep writes one impulse onto ctx.player.velocity on a multi-second cooldown.
// If the controller ever exposes an impulse API, call that instead.
const DASH_SPEED = 15.5;

export function update(ctx, dt) {
  const p = ctx.player, inp = ctx.input;
  if (!p || !inp) return;

  if (S.overshieldT > 0) {
    S.overshieldT -= dt;
    if (S.overshieldT <= 0) { S.overshield = 0; derive(ctx); }
  }

  // Shield regeneration driven by recovery. The combat piece also regenerates on a flat
  // timer; rather than guess its constants, we simply stand down the moment anything else
  // has already raised the shield this frame. Recovery then owns the part combat cannot:
  // how long you wait before it starts.
  if (!p.dead) {
    const st = ctx.rpg.stats;
    const grew = p.shield > S.lastShield + 1e-4;
    if (!grew && p.shield < p.maxShield && ctx.time - S.lastHurt > st.shieldDelay) {
      p.shield = Math.min(p.maxShield, p.shield + st.shieldRegen * dt);
    }
  }
  S.lastShield = p.shield;

  if (S.dashCd > 0) S.dashCd -= dt;

  if (p.dead || !inp.locked) return;

  // Windstep — sprint key in mid-air. The controller reads sprint held, never its edge,
  // and has no dash of its own, so an edge-triggered air dash collides with nothing.
  if (S.skills.dash && !p.grounded && S.dashCd <= 0 && inp.actionHit('sprint')) {
    S.dashCd = ctx.rpg.stats.dashCooldown;
    const f = (inp.action('forward') ? 1 : 0) - (inp.action('back') ? 1 : 0);
    const r = (inp.action('right') ? 1 : 0) - (inp.action('left') ? 1 : 0);
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    let dx = r * cy - f * sy, dz = -r * sy - f * cy;
    if (!dx && !dz) { dx = -sy; dz = -cy; }
    const l = Math.hypot(dx, dz) || 1;
    p.velocity.x = dx / l * DASH_SPEED;
    p.velocity.z = dz / l * DASH_SPEED;
    p.velocity.y = Math.max(p.velocity.y, 1.6);
    p.fovBoost = (p.fovBoost || 0) + 7;
    p.shake = Math.min(1, (p.shake || 0) + 0.12);
    ctx.events.emit('rpg:ability', { id: 'dash' });
  }

  // consumables on Z, cycling to whatever you actually have
  if (inp.hit('KeyZ')) {
    const id = ['draught', 'tonic', 'charm'].find(k => S.consumables[k] > 0);
    if (id) useConsumable(ctx, id);
  }

  // Last Light — one cheat of death per 90s
  if (S.skills.lastLight && p.health <= 0 && ctx.time - S.lastLightT > 90) {
    S.lastLightT = ctx.time;
    p.dead = false; p.health = Math.round(p.maxHealth * 0.35); p.shield = p.maxShield;
    toast(ctx, 'LAST LIGHT');
    ctx.events.emit('rpg:ability', { id: 'lastLight' });
  }
}

// ------------------------------------------------------------------ save hooks
export function serialize() {
  return {
    level: S.level, xp: S.xp, points: S.points, skills: S.skills,
    inventory: S.inventory, equipped: S.equipped,
    currencies: S.currencies, consumables: S.consumables,
  };
}

export function deserialize(ctx, d) {
  if (!d) return false;
  S.level = clamp(+d.level || 1, 1, MAX_LEVEL);
  S.xp = Math.max(0, +d.xp || 0);
  S.points = Math.max(0, +d.points || 0);
  S.skills = {};
  if (d.skills && typeof d.skills === 'object') for (const k in d.skills) if (SKILLS[k]) S.skills[k] = 1;
  S.inventory = Array.isArray(d.inventory) ? d.inventory.filter(validItem).map(restat) : [];
  S.equipped = { weapon: null, head: null, arms: null, chest: null, legs: null, cloak: null };
  if (d.equipped && typeof d.equipped === 'object') {
    for (const slot in S.equipped) {
      const it = d.equipped[slot];
      if (validItem(it)) S.equipped[slot] = restat(it);
    }
  }
  for (const k in S.currencies) S.currencies[k] = Math.max(0, +((d.currencies || {})[k]) || 0);
  for (const k in S.consumables) S.consumables[k] = Math.max(0, +((d.consumables || {})[k]) || 0);
  refresh(ctx);
  return true;
}

function validItem(it) {
  if (!it || typeof it !== 'object') return false;
  if (it.kind !== 'weapon' && it.kind !== 'armour') return false;
  if (typeof it.name !== 'string' || !RARITY[it.rarity]) return false;
  if (it.kind === 'weapon' && (!it.base || typeof it.base.damage !== 'number')) return false;
  if (it.kind === 'armour' && (!it.stats || !ARMOUR_SLOTS.includes(it.slot))) return false;
  if (!Array.isArray(it.perks)) it.perks = [];
  return true;
}

export { describe };
