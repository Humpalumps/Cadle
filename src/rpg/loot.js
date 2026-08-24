// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Cadle via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: rpg agent. Drop table, pity timers, physical loot in the world, pickup.
import * as THREE from 'three';
import { TIERS, rarityOf, makeWeapon, makeArmour, describe, shortLabel, makeQuestItem, addQuestItem } from './items.js';
import { state as S, addItem, grant, powerLevel } from './progression.js';
import { buildKit, makeDrop, disposeDrop, ringGeometry, ringMaterial, beamColorOf, HOVER_Y } from './dropmesh.js';
import { regionAt } from '../world/Biomes.js';   // read-only: the ONE answer to "which region is this"
import { compareItem } from './compare.js';      // pure item-vs-equipped verdict, shared with the prompt/nameplate

// ------------------------------------------------------------------ drop table
// The maths moved to droptable.js so `node` can import it without a browser or THREE and
// roll 100,000 tiers in CI (tools/curvecheck.mjs). Re-exported here so every existing
// caller — RPG.js, the screens, the harness — keeps working unchanged.
export { W, HARD, SOFT, RAMP, counts, rollTier, pity, resetTable, enemyTier } from './droptable.js';
import { rollTier, atLeast, enemyTier } from './droptable.js';

// ------------------------------------------------------------------ source bias
// "Where you farm" has to mean something, so a drop is rolled from what KILLED it, not from
// what you are wearing. Three biases, all soft — a surprise element is part of the fun, and a
// hard lock would make every Frostveil drop the same arc gun.
const REGION_ELEMENT = {
  tundra: 'arc', infernal: 'solar', void: 'void', forest: 'verdant',
  shadowfen: 'void', sunken: 'arc', dragon: 'solar', celestial: 'arc',
  lost: ['void', 'arc'],
};
// items.js knows five elements; enemy defs also use stasis/strand, which have no weapon
// counterpart — fold them onto the nearest one that exists rather than rolling kinetic.
const DEF_ELEMENT = { stasis: 'arc', strand: 'verdant' };
const ELEMENT_BIAS = 0.6;      // how often the region wins; the rest is a free roll

// Enemy role -> the archetypes it should be handing you. A sniper off a ranged elite reads as
// a trophy; a sniper off a hound reads as a slot machine.
const ROLE_ARCH = {
  ranged: ['sniper', 'scout', 'pulse', 'beam'],
  dive:   ['sniper', 'scout', 'pulse', 'beam'],
  melee:  ['shotgun', 'fusion', 'autorifle', 'handcannon'],
  slam:   ['shotgun', 'fusion', 'autorifle', 'handcannon'],
};
const ARCH_BIAS = 0.55;
const POWER_PER_LEVEL = 8;     // matches progression.powerLevel()'s gearless fallback

const rnd = (a) => a[(Math.random() * a.length) | 0];

// "Take & Equip" — a second key on the pickup prompt for the common case of an already-full slot
// (walking over a weapon only auto-equips into an EMPTY slot, so a straight upgrade otherwise means
// pick it up then dig through a menu). KeyT is free: checked against every live binding in the repo
// (WASD/Shift/Space/mouse movement, E interact, R reload, Z consumable, F/G/Q/X abilities, 1/2 swap,
// C crouch, M/I/J/K screens) — none of them claim T.
const EQUIP_KEY = 'KeyT';
const EQUIP_KEY_LABEL = EQUIP_KEY.slice(3);
// RPG.js's ctx.hud.prompt adapter is `(t) => hud.prompt(t)` — ONE argument, and RPG.js is another
// owner's file — so a second bindable action has to ride inside the text string itself. HUD.js's
// prompt() (src/ui/HUD.js, same sentinel) splits it back out; U+0001 cannot appear in a generated name.
const PROMPT_SEP = '';

function biasedElement(ctx, en, p) {
  let id = null;
  try { id = regionAt(p.x, p.z); } catch (e) {}
  const want = REGION_ELEMENT[id];
  if (want && Math.random() < ELEMENT_BIAS) return Array.isArray(want) ? rnd(want) : want;
  // no region opinion (the Vale, or the roll went free): let the creature speak instead
  const de = en && en.def && en.def.element;
  if (de && Math.random() < 0.35) return DEF_ELEMENT[de] || de;
  return undefined;             // undefined -> makeWeapon rolls its own
}

function biasedArchetype(ctx, en) {
  const pool = ROLE_ARCH[en && en.def && en.def.role];
  if (!pool || Math.random() > ARCH_BIAS) return undefined;
  // only ever name a gun the live armoury actually has ("nothing here may name a gun that
  // does not exist") — otherwise makeWeapon silently falls back to archPool[0] every time
  const have = (ctx.weapon && ctx.weapon.archetypes) || null;
  const usable = have ? pool.filter((a) => have.some((x) => x.id === a)) : pool;
  return usable.length ? rnd(usable) : undefined;
}

// Tier floors are a GIFT on top of a finished roll (see droptable.atLeast): the pity counters
// have already moved on the tier the table produced, so a boss's guaranteed legendary cannot
// drag the published long-run rates off the table. curvecheck.mjs measures exactly that.
const BOSS_EXOTIC = 0.18;
function floorFor(en) {
  const t = enemyTier(en);
  if (t === 'boss') return Math.random() < BOSS_EXOTIC ? 'exotic' : 'legendary';
  if (t === 'elite') return 'rare';
  return null;
}

// ------------------------------------------------------------------ visuals
// MAX_DROPS counts ROLLED loot only. Quest items share the array (they want the same fall
// physics, bob, pickup and prompt) but are accounted separately, so a firefight dropping
// twelve commons can never delete the thing a quest told you to fetch. That eviction bug
// shipped once and was papered over with a 5-second re-drop poll; this is the fix instead.
const MAX_DROPS = 12;
const QUEST_MAX = 8;         // a buggy quest still cannot carpet the floor
const drops = [];
const isQuest = (d) => d.tier === 'quest';
function countQuest() { let n = 0; for (const d of drops) if (isQuest(d)) n++; return n; }
// evict the oldest NON-quest drop. Plain despawn(0) was the bug: index 0 is simply the oldest
// record, quest item or not.
function evictOldestLoot() {
  for (let i = 0; i < drops.length; i++) if (!isQuest(drops[i])) { despawn(i); return true; }
  return false;
}
const bursts = [];
let group;

// A drop is now a readable object: dropmesh.js builds the silhouette (rifle / hand cannon /
// scout / charge beam / helm / gauntlets / plate / greaves / cloak) and a beacon that does
// not look like the world's light shafts. See that file for the reasoning.
function spawnMesh(ctx, tier, pos, item) {
  const vis = makeDrop(item, tier);
  // Keen Eye says "loot beams reach further" on the tin, so make that literally true
  if (S.skills.keenEye) { vis.core.scale.y *= 1.4; vis.halo.scale.y *= 1.4; vis.h *= 1.4; }
  vis.g.position.copy(pos);
  group.add(vis.g);
  return vis;
}

function shockwave(ctx, pos, tier, n) {
  for (let i = 0; i < n; i++) {
    const r = new THREE.Mesh(ringGeometry(), ringMaterial(tier).clone());
    r.position.copy(pos); r.position.y += 0.12;
    r.renderOrder = 4;
    group.add(r);
    bursts.push({ m: r, t: 0, delay: i * 0.16, life: 1.3 });
  }
}

// hex string for the HUD, which draws 2D and wants CSS colours
const cssColor = (t) => '#' + beamColorOf(t).toString(16).padStart(6, '0');

// ------------------------------------------------------------------ drop-vs-equipped verdict
// Destiny tells you whether a drop beats what you are holding before you walk over it. compare.js
// has the scalar math (shared with rpgscreens' inventory/character sheets); this is just the two
// presentation strings the world side needs. Glyph + word, never colour alone, per CLAUDE.md's
// blob-law spirit (a reading has to survive greyscale).
const VERDICT_GLYPH = { better: '▲', worse: '▼', sidegrade: '◆' };   // ▲ ▼ ◆
const VERDICT_WORD = { better: 'Upgrade', worse: 'Downgrade', sidegrade: 'Sidegrade' };

// What is currently worn in this item's slot — same lookup rpgscreens.compareTo() does, against
// the same live S.equipped this file already imports.
const equippedFor = (item) => (item.kind === 'weapon' ? S.equipped.weapon : S.equipped[item.slot]);

/** One-line verdict for the pickup prompt: "▲ +18 Power" / "▼ −9 Power" / "◆ Sidegrade". '' for
 *  quest items (compareItem returns null for those) — never print "+0" on a fetch objective. */
function verdictLine(item) {
  const v = compareItem(item, equippedFor(item));
  if (!v) return '';
  const g = VERDICT_GLYPH[v.verdict];
  if (v.verdict === 'sidegrade') return `${g} ${VERDICT_WORD[v.verdict]}`;
  return `${g} ${v.powerDelta > 0 ? '+' : '−'}${Math.abs(v.powerDelta)} Power`;
}

/** Two-line verdict for the taller nameplate: the power line, plus the stat that moved most
 *  ("▲ +18 Power" / "Impact +12"). '' for either line when there is nothing to say. */
function verdictLines(item) {
  const v = compareItem(item, equippedFor(item));
  if (!v) return null;
  const g = VERDICT_GLYPH[v.verdict];
  const power = v.verdict === 'sidegrade' ? `${g} ${VERDICT_WORD[v.verdict]}`
    : `${g} ${v.powerDelta > 0 ? '+' : '−'}${Math.abs(v.powerDelta)} Power`;
  const top = v.lines[0];
  const stat = top ? `${top.label} ${top.delta > 0 ? '+' : '−'}${Math.abs(top.delta)}` : '';
  return { verdict: v.verdict, power, stat };
}

// Legendary and exotic get a floating nameplate so you can read what dropped from across a
// clearing instead of walking to it to find out. Rare and below deliberately do not: five
// plates in one clearing overlap into mush, and the beacon colour already says enough.
// Passing the live vector means the plate follows the drop while it is still falling.
//
// The verdict is computed ONCE here, at drop time — not every frame. It reads S.equipped as of
// this instant; if the player re-equips while the drop is still sitting on the ground the plate
// goes stale rather than recomputing, matching the "no per-frame churn" rule the HUD's other
// world-projected elements (damage numbers, the escort guide) already follow.
const PLATE_FROM = 3;   // index into TIERS
function nameplate(ctx, d) {
  // A quest item ALWAYS gets a plate — you were told to fetch it, so it has to be findable.
  // The plate is the readability answer precisely so the emissive does not have to be.
  if (!isQuest(d) && TIERS.indexOf(d.tier) < PLATE_FROM) return;
  if (!ctx.hud || !ctx.hud.marker) return;
  const vl = verdictLines(d.item);   // null for quest items — no +0 on a fetch target
  try {
    d.unmark = ctx.hud.marker({
      id: 'loot:' + d.item.id,
      text: shortLabel(d.item),
      position: d.pos, kind: 'loot', color: cssColor(d.tier),
      sub: vl ? vl.power : '', sub2: vl ? vl.stat : '', subKind: vl ? vl.verdict : '',
    });
  } catch (e) {}
}

// ------------------------------------------------------------------ dropping
const tmp = new THREE.Vector3();

function toVec(ctx, p) {
  if (!p) return tmp.copy(ctx.player.position);
  if (typeof p.x === 'number') return tmp.set(p.x, typeof p.y === 'number' ? p.y : 0, p.z || 0);
  return tmp.copy(ctx.player.position);
}

// Shared by dropLoot (a real drop, world position known — used to bias element by region) and
// rollItem (a preview roll, no world position — biases off wherever the player currently stands).
// This IS "the same rolling path dropLoot uses" the quest-reward preview needs: same tier/power/
// bias logic, same RNG calls, just no mesh/beacon/event/position side effects.
function rollItemAt(ctx, tier, opts, p) {
  const en = opts.source || null;
  const t = TIERS.includes(tier)
    ? tier
    : atLeast(rollTier(ctx.rpg.stats.luck || 0), opts.floor || floorFor(en));
  // Power comes from what you KILLED when we know it. Rolling a level-44 Void Horror off the
  // player's power level is what made every region's loot identical.
  const basePower = en && en.level ? en.level * POWER_PER_LEVEL : powerLevel();
  const power = basePower + Math.floor(Math.random() * 9) + (S.skills.attunement ? 15 : 0);
  const weaponBias = t === 'exotic' ? 0.7 : 0.6;
  const wantWeapon = opts.kind === 'weapon' ? true
    : opts.kind === 'armour' ? false : Math.random() < weaponBias;
  const item = wantWeapon
    ? makeWeapon(t, power, {
        archetypes: ctx.weapon && ctx.weapon.archetypes,
        archetype: opts.archetype || biasedArchetype(ctx, en),
        element: opts.element || biasedElement(ctx, en, p),
      })
    : makeArmour(t, power, { slot: opts.slot, set: opts.set });
  return { item, tier: t };
}

/**
 * Roll a real item WITHOUT dropping it into the world — no mesh, no beacon, no `loot:dropped`
 * event, no MAX_DROPS bookkeeping. Same rolling path dropLoot uses (rollTier/atLeast/pity, power,
 * element/archetype bias, makeWeapon/makeArmour), so a previewed reward is a genuine roll, not a
 * mock. Safe to call repeatedly (e.g. 2-3 candidate quest rewards) — the only side effect is the
 * roll itself moving droptable.js's pity counters, same as any other roll.
 *   rollItem(ctx, tier, opts) -> item
 * `tier`: a TIERS value to force it, or null/undefined to roll one (honours opts.floor same as
 * dropLoot). `opts`: { kind: 'weapon'|'armour', archetype, element, slot, set, source, floor } —
 * identical meaning to dropLoot's opts. Element bias reads the region under the player (no drop
 * position exists yet to read instead).
 */
export function rollItem(ctx, tier, opts = {}) {
  return rollItemAt(ctx, tier, opts, ctx.player.position).item;
}

export function dropLoot(ctx, position, tier, opts = {}) {
  const p = toVec(ctx, position).clone();
  let gh = 0;
  try { gh = ctx.world.heightAt(p.x, p.z) || 0; } catch (e) {}
  p.y = Math.max(p.y, gh) + 1.1;

  const { item, tier: t } = rollItemAt(ctx, tier, opts, p);

  if (drops.length - countQuest() >= MAX_DROPS) evictOldestLoot();
  const vis = spawnMesh(ctx, t, p, item);
  const d = {
    item, tier: t, mesh: vis, pos: p,
    vel: new THREE.Vector3((Math.random() - 0.5) * 2.6, 3.4, (Math.random() - 0.5) * 2.6),
    grounded: false, age: 0, spin: 0.5 + Math.random() * 0.45, unmark: null,
    // armour hangs, weapons lie flat and turn — each reads as the thing it is
    tilt: item.kind === 'weapon' ? 0.22 : 0,
  };
  drops.push(d);
  nameplate(ctx, d);

  const r = rarityOf(t);
  if (t === 'exotic') {
    shockwave(ctx, p, t, 3);
    ctx.player.shake = Math.min(1.4, (ctx.player.shake || 0) + 0.55);
    try { ctx.hud.toast && ctx.hud.toast('EXOTIC   ·   ' + item.name); } catch (e) {}
  } else if (t === 'legendary') {
    shockwave(ctx, p, t, 1);
    ctx.player.shake = Math.min(1, (ctx.player.shake || 0) + 0.16);
    try { ctx.hud.toast && ctx.hud.toast('LEGENDARY   ·   ' + item.name); } catch (e) {}
  }
  ctx.events.emit('loot:dropped', { item, tier: t, rarity: r, color: r.color, position: p.clone() });
  return d;
}

// ------------------------------------------------------------------ quest items
// Deliberately NOT a rarity beam and NOT an ammo brick: a rose relic shard with a ground rune
// and a HUD nameplate. Rose is the one hue nothing else in the game uses — the beams are
// grey/green/blue/violet/orange, the bricks are gold and blue-violet — so "the thing the quest
// wants" is identifiable at a glance without being the brightest object in the frame.
//
// BLOB LAW: emissiveIntensity 0.45 (dimmer than a *rare* drop's 0.58), roughness 0.7, no
// beacon column, no additive halo, no toneMapped:false. Readability comes from the nameplate,
// which is a UI term and cannot bloom — exactly the substitution CLAUDE.md prescribes.
// One geometry + two materials for the whole population.
// Crimson-rose, deliberately NOT magenta: PostFX._renderSkyMask paints the sky pure magenta and
// blobcheck.py treats magenta as "ignore". Authoring a world object in the gate's own ignore colour
// is a trap for whoever next touches the mask, so this sits well to the red side of it.
const QUEST_HUE = 0xe8365f;
let qGeo = null, qMat = null, qRing = null;
function questVis() {
  buildKit();                                   // idempotent; we borrow its shared ring geometry
  if (!qGeo) {
    qGeo = new THREE.OctahedronGeometry(0.24, 0);
    qMat = new THREE.MeshStandardMaterial({
      // albedo carries the object, emissive only tints it. At 0.45 against a night-dark albedo the
      // emissive WAS the whole surface and the shard read as a flat UI decal pasted on the grass
      // (seen live at q=low, 23:00). A brighter body + a dimmer glow reads as a lit relic instead.
      color: 0x5a2030, emissive: QUEST_HUE,
      emissiveIntensity: 0.30,                  // BLOB LAW ceiling 0.6 — do not raise
      roughness: 0.7,                           // BLOB LAW floor 0.6 — below it, point-glints
      metalness: 0.15, flatShading: true,
    });
    qRing = new THREE.MeshBasicMaterial({
      color: QUEST_HUE, transparent: true, opacity: 0.26, side: THREE.DoubleSide,
      depthWrite: false, fog: false,            // toneMapped stays TRUE: a rune must not clip
    });
  }
  const g = new THREE.Group();
  const shape = new THREE.Mesh(qGeo, qMat);
  shape.position.y = HOVER_Y; shape.scale.setScalar(1.1); shape.castShadow = false;
  // 0.6x the loot rune: a marker under the item, not a crop circle. Six full-size rose rings
  // overlapping in one clearing was the single loudest thing in the frame.
  const ring = new THREE.Mesh(ringGeometry(), qRing);
  ring.position.y = 0.03; ring.renderOrder = 3;
  g.add(shape, ring);
  // shape/ring/chev are the fields the frame loop touches; core/halo only inside the chev branch
  return { g, shape, ring, chev: null, core: null, halo: null, h: 0 };
}

/**
 * Put a physical, pickable quest item on the ground.
 *   dropQuestItem(ctx, position, itemId, name, opts) -> the drop record, or null if capped.
 * opts: { count = 1, desc, quest }  — passed straight through to makeQuestItem.
 * Exempt from MAX_DROPS and from the 150 s despawn; capped at QUEST_MAX on its own account,
 * and it refuses rather than evicting, because nothing may delete a fetch objective's target.
 * On pickup it stacks into the inventory and emits:
 *   'loot:picked' { item: { kind:'quest', id, questItem, name, count, desc, quest }, tier:'quest', rarity }
 */
export function dropQuestItem(ctx, position, itemId, name, opts = {}) {
  if (!itemId) return null;
  if (countQuest() >= QUEST_MAX) return null;
  const item = makeQuestItem(itemId, name, opts);
  const p = toVec(ctx, position).clone();
  let gh = 0;
  try { gh = ctx.world.heightAt(p.x, p.z) || 0; } catch (e) {}
  p.y = Math.max(p.y, gh) + 1.1;

  const vis = questVis();
  vis.g.position.copy(p);
  group.add(vis.g);
  const d = {
    item, tier: 'quest', mesh: vis, pos: p,
    vel: new THREE.Vector3((Math.random() - 0.5) * 2.2, 3.2, (Math.random() - 0.5) * 2.2),
    grounded: false, age: 0, spin: 0.9 + Math.random() * 0.4, unmark: null, tilt: 0,
    ringScale: 0.6,
  };
  drops.push(d);
  nameplate(ctx, d);
  ctx.events.emit('loot:dropped', { item, tier: 'quest', rarity: rarityOf('quest'), color: QUEST_HUE, position: p.clone() });
  return d;
}

/** Sweep quest drops off the floor — turn-in, abandon, or a gate resetting between passes. */
export function clearQuestDrops(itemId) {
  let n = 0;
  for (let i = drops.length - 1; i >= 0; i--) {
    if (isQuest(drops[i]) && (!itemId || drops[i].item.id === itemId)) { despawn(i); n++; }
  }
  return n;
}

function despawn(i) {
  const d = drops[i];
  if (!d) return;
  group.remove(d.mesh.g);
  disposeDrop(d.mesh);
  if (d.unmark) { try { d.unmark(); } catch (e) {} d.unmark = null; }
  drops.splice(i, 1);
}

function collect(ctx, i, forceEquip) {
  const d = drops[i];
  if (!d) return null;
  despawn(i);
  if (isQuest(d)) {
    // stacks into one inventory row; the EVENT carries this pickup's own count, not the
    // running stack total, because that is what a `collect N` objective increments by
    addQuestItem(S.inventory, d.item.id, d.item.name, d.item.count, { desc: d.item.desc, quest: d.item.quest });
    ctx.events.emit('loot:picked', { item: d.item, tier: 'quest', rarity: rarityOf('quest') });
    try { ctx.hud.toast && ctx.hud.toast(shortLabel(d.item)); } catch (e) {}
    return d.item;
  }
  addItem(ctx, d.item);
  const r = rarityOf(d.tier);
  grant(ctx, { glimmer: Math.round(25 * r.mult * r.mult), emberdust: d.tier === 'legendary' || d.tier === 'exotic' ? 1 : 0, relicShard: d.tier === 'exotic' ? 1 : 0 });
  // Loot pickup was silent too. Pitch rises with rarity, so a legendary sounds like a legendary
  // before you have read a single word of the toast.
  try { ctx.audio?.play?.('pickup', { pitch: 0.9 + TIERS.indexOf(d.tier) * 0.12, vol: 0.62, force: true }); } catch (e) {}
  ctx.events.emit('loot:picked', { item: d.item, tier: d.tier, rarity: r });
  try { ctx.hud.toast && ctx.hud.toast(describe(d.item)); } catch (e) {}
  // auto-equip anything strictly better than the empty slot you are carrying, OR anything the
  // player explicitly asked to equip on pickup (the [T] Take & Equip prompt key) — equip() itself
  // handles the swap (previous item goes back to the bag), so this is safe to call unconditionally.
  const slot = d.item.kind === 'weapon' ? 'weapon' : d.item.slot;
  if (ctx.rpg.equip && (forceEquip || !S.equipped[slot])) ctx.rpg.equip(d.item);
  return d.item;
}

export function pickupNearest(ctx, maxDist, forceEquip) {
  const R = maxDist || (ctx.rpg.stats.pickupRadius || 2.2);
  let best = -1, bd = R * R;
  for (let i = 0; i < drops.length; i++) {
    const dd = drops[i].pos.distanceToSquared(ctx.player.position);
    if (dd < bd) { bd = dd; best = i; }
  }
  return best >= 0 ? collect(ctx, best, forceEquip) : null;
}

export const activeDrops = () => drops.map(d => ({ tier: d.tier, name: d.item.name, x: +d.pos.x.toFixed(1), z: +d.pos.z.toFixed(1) }));
export function clearDrops() { for (let i = drops.length - 1; i >= 0; i--) despawn(i); }

// ------------------------------------------------------------------ lifecycle
export function init(ctx) {
  buildKit();
  group = new THREE.Group();
  group.name = 'rpg-loot';
  ctx.scene.add(group);

  ctx.events.on('enemy:death', (e) => {              // Cadle payload: { enemy, killer }
    const en = (e && e.enemy) || e || {};
    const pos = en.position || (en.mesh && en.mesh.position) || ctx.player.position;
    grant(ctx, { glimmer: 8 + Math.floor(Math.random() * 10) });
    // Destiny cadence: most kills give dust, some give a beam. Elites always pay out twice,
    // a region boss three times — and every one of them is rolled from the SOURCE, so the
    // level, the region's element and the creature's role all reach the item.
    const t = enemyTier(en);
    const n = t === 'boss' ? 3 : t === 'elite' ? 2 : Math.random() < 0.28 ? 1 : 0;
    // Only the FIRST drop takes the full floor: a boss rolling floorFor() three times would
    // turn a "~18% exotic" boss into a ~45% one. The rest ride the plain tier floor.
    const rest = t === 'boss' ? 'legendary' : 'rare';
    for (let i = 0; i < n; i++) dropLoot(ctx, pos, null, { source: en, floor: i ? rest : undefined });
  });
}

export function update(ctx, dt) {
  const p = ctx.player.position;
  let near = null, nearD = 1e9;

  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.age += dt;
    if (!d.grounded) {
      d.vel.y -= 22 * dt;
      d.pos.addScaledVector(d.vel, dt);
      let gh = 0;
      try { gh = ctx.world.heightAt(d.pos.x, d.pos.z) || 0; } catch (e) {}
      if (d.pos.y <= gh + 0.05) { d.pos.y = gh + 0.05; d.grounded = true; }
      d.mesh.g.position.copy(d.pos);
    }
    // the item turns on the spot and bobs; the silhouette is the point, so it is kept
    // broadside-ish rather than spun on two axes into an unreadable tumble
    const sh = d.mesh.shape;
    sh.rotation.y += d.spin * dt;
    sh.rotation.z = d.tilt;
    sh.position.y = HOVER_Y + Math.sin(ctx.time * 1.5 + i) * 0.11;
    d.mesh.ring.scale.setScalar((d.ringScale || 1) * (1 + Math.sin(ctx.time * 2.2 + i * 1.3) * 0.09));
    // quest drops share ONE ring material, so writing opacity per-drop pulsed every shard in
    // lockstep — a synthetic strobe, and six of them at once. They keep the authored 0.26.
    if (!isQuest(d)) d.mesh.ring.material.opacity = 0.6 + Math.sin(ctx.time * 2.2 + i * 1.3) * 0.25;
    if (d.mesh.chev) {
      // a chevron sliding down the column: an authored signal, never mistaken for weather
      const k = (ctx.time * 0.55 + i * 0.37) % 1;
      d.mesh.chev.position.y = d.mesh.core.position.y + d.mesh.h * (1 - k);
      d.mesh.chev.material.opacity = 0.9 * Math.min(1, k * 4) * (1 - k);
      d.mesh.chev.scale.setScalar(1 + k * 0.8);
    }

    if (d.age > 150 && !isQuest(d)) { despawn(i); continue; }   // quest items never time out

    const dist = d.pos.distanceTo(p);
    const R = ctx.rpg.stats.pickupRadius || 2.2;
    if (dist < R) {
      // quest items and cheap tiers vacuum on contact — no E press for something you were sent to get
      const vac = isQuest(d) ? 1.6 : (d.tier === 'common' || d.tier === 'uncommon') ? 1.25 : 0;
      if (dist < vac || (ctx.input && ctx.input.actionHit('interact'))) { collect(ctx, i); continue; }
      // Take & Equip: the same interaction, plus an immediate swap. Never offered on a quest token —
      // there is nothing to equip a fetch objective into.
      if (!isQuest(d) && ctx.input && ctx.input.hit && ctx.input.hit(EQUIP_KEY)) { collect(ctx, i, true); continue; }
      if (dist < nearD) { nearD = dist; near = d; }
    }
  }

  // The UI piece owns prompts (ctx.hud.prompt). Publishing ctx.rpg.prompt for nobody to read
  // is how the pickup prompt was written and thrown away every frame for the whole review.
  // Only the nearest drop prompts, so a pile of loot is one line and not six.
  if (near && ctx.hud && ctx.hud.prompt) {
    try {
      const vl = verdictLine(near.item);   // '' for quest items — never "Take Frost Shard +0"
      const equippable = !isQuest(near);   // quest tokens have no slot to equip into
      const base = 'Take  ' + shortLabel(near.item) + (vl ? '   ' + vl : '');
      // ctx.hud.prompt only forwards one string (see PROMPT_SEP's comment) — the second action
      // rides inside it, and HUD.js's prompt() splits it back out into the [T] Take & Equip row.
      ctx.hud.prompt(equippable ? base + PROMPT_SEP + EQUIP_KEY_LABEL + PROMPT_SEP + 'Take & Equip' : base);
    } catch (e) {}
  }

  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    if (b.delay > 0) { b.delay -= dt; continue; }
    b.t += dt;
    const k = b.t / b.life;
    if (k >= 1) { group.remove(b.m); b.m.material.dispose(); bursts.splice(i, 1); continue; }
    b.m.scale.setScalar(1 + k * 11);
    b.m.material.opacity = 0.8 * (1 - k) * (1 - k);
  }
}
