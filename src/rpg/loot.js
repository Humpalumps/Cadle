// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Cadle via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: rpg agent. Drop table, pity timers, physical loot in the world, pickup.
import * as THREE from 'three';
import { TIERS, rarityOf, makeWeapon, makeArmour, describe, shortLabel } from './items.js';
import { state as S, addItem, grant, powerLevel } from './progression.js';
import { buildKit, makeDrop, disposeDrop, ringGeometry, ringMaterial, beamColorOf, HOVER_Y } from './dropmesh.js';

// ------------------------------------------------------------------ drop table
// Base weights. Pity only ever *adds* on top of these, so the long-run shape holds.
const W = { common: 0.550, uncommon: 0.280, rare: 0.125, legendary: 0.038, exotic: 0.007 };
// hard pity: a drought this long ends now. Set roughly 3x the mean gap for each tier so
// it catches genuine bad luck without dragging the measured rates off the table above.
const HARD = { rare: 20, legendary: 90, exotic: 400 };
// soft pity: odds start climbing from here
const SOFT = { legendary: 55, exotic: 260 };
const RAMP = { legendary: 0.0025, exotic: 0.0005 };

const dry = { rare: 0, legendary: 0, exotic: 0 };
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

// ------------------------------------------------------------------ visuals
const MAX_DROPS = 12;
const drops = [];
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

// Legendary and exotic get a floating nameplate so you can read what dropped from across a
// clearing instead of walking to it to find out. Rare and below deliberately do not: five
// plates in one clearing overlap into mush, and the beacon colour already says enough.
// Passing the live vector means the plate follows the drop while it is still falling.
const PLATE_FROM = 3;   // index into TIERS
function nameplate(ctx, d) {
  if (TIERS.indexOf(d.tier) < PLATE_FROM || !ctx.hud || !ctx.hud.marker) return;
  try {
    d.unmark = ctx.hud.marker({
      id: 'loot:' + d.item.id,
      text: shortLabel(d.item),
      position: d.pos, kind: 'loot', color: cssColor(d.tier),
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

export function dropLoot(ctx, position, tier, opts = {}) {
  const t = TIERS.includes(tier) ? tier : rollTier(ctx.rpg.stats.luck || 0);
  const p = toVec(ctx, position).clone();
  let gh = 0;
  try { gh = ctx.world.heightAt(p.x, p.z) || 0; } catch (e) {}
  p.y = Math.max(p.y, gh) + 1.1;

  const power = powerLevel() + Math.floor(Math.random() * 9) + (S.skills.attunement ? 15 : 0);
  const weaponBias = t === 'exotic' ? 0.7 : 0.6;
  const wantWeapon = opts.kind === 'weapon' ? true
    : opts.kind === 'armour' ? false : Math.random() < weaponBias;
  const item = wantWeapon
    ? makeWeapon(t, power, { archetypes: ctx.weapon && ctx.weapon.archetypes, archetype: opts.archetype })
    : makeArmour(t, power, { slot: opts.slot, set: opts.set });

  if (drops.length >= MAX_DROPS) despawn(0);
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

function despawn(i) {
  const d = drops[i];
  if (!d) return;
  group.remove(d.mesh.g);
  disposeDrop(d.mesh);
  if (d.unmark) { try { d.unmark(); } catch (e) {} d.unmark = null; }
  drops.splice(i, 1);
}

function collect(ctx, i) {
  const d = drops[i];
  if (!d) return null;
  despawn(i);
  addItem(ctx, d.item);
  const r = rarityOf(d.tier);
  grant(ctx, { glimmer: Math.round(25 * r.mult * r.mult), emberdust: d.tier === 'legendary' || d.tier === 'exotic' ? 1 : 0, relicShard: d.tier === 'exotic' ? 1 : 0 });
  ctx.events.emit('loot:picked', { item: d.item, tier: d.tier, rarity: r });
  try { ctx.hud.toast && ctx.hud.toast(describe(d.item)); } catch (e) {}
  // auto-equip anything strictly better than the empty slot you are carrying
  const slot = d.item.kind === 'weapon' ? 'weapon' : d.item.slot;
  if (!S.equipped[slot] && ctx.rpg.equip) ctx.rpg.equip(d.item);
  return d.item;
}

export function pickupNearest(ctx, maxDist) {
  const R = maxDist || (ctx.rpg.stats.pickupRadius || 2.2);
  let best = -1, bd = R * R;
  for (let i = 0; i < drops.length; i++) {
    const dd = drops[i].pos.distanceToSquared(ctx.player.position);
    if (dd < bd) { bd = dd; best = i; }
  }
  return best >= 0 ? collect(ctx, best) : null;
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
    // Destiny cadence: most kills give dust, some give a beam. Elites always pay out twice.
    const elite = /golem|warden|drake|boss/.test(en.type || '');
    if (elite) { dropLoot(ctx, pos); dropLoot(ctx, pos); }
    else if (Math.random() < 0.28) dropLoot(ctx, pos);
  });
}

const tmpPrompt = new THREE.Vector3();

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
    d.mesh.ring.scale.setScalar(1 + Math.sin(ctx.time * 2.2 + i * 1.3) * 0.09);
    d.mesh.ring.material.opacity = 0.6 + Math.sin(ctx.time * 2.2 + i * 1.3) * 0.25;
    if (d.mesh.chev) {
      // a chevron sliding down the column: an authored signal, never mistaken for weather
      const k = (ctx.time * 0.55 + i * 0.37) % 1;
      d.mesh.chev.position.y = d.mesh.core.position.y + d.mesh.h * (1 - k);
      d.mesh.chev.material.opacity = 0.9 * Math.min(1, k * 4) * (1 - k);
      d.mesh.chev.scale.setScalar(1 + k * 0.8);
    }

    if (d.age > 150) { despawn(i); continue; }

    const dist = d.pos.distanceTo(p);
    const R = ctx.rpg.stats.pickupRadius || 2.2;
    if (dist < R) {
      const cheap = d.tier === 'common' || d.tier === 'uncommon';
      if ((cheap && dist < 1.25) || (ctx.input && ctx.input.actionHit('interact'))) { collect(ctx, i); continue; }
      if (dist < nearD) { nearD = dist; near = d; }
    }
  }

  // The UI piece owns prompts (ctx.hud.prompt). Publishing ctx.rpg.prompt for nobody to read
  // is how the pickup prompt was written and thrown away every frame for the whole review.
  // Only the nearest drop prompts, so a pile of loot is one line and not six.
  if (near && ctx.hud && ctx.hud.prompt) {
    try {
      ctx.hud.prompt('Take  ' + shortLabel(near.item),
        tmpPrompt.copy(near.pos).setY(near.pos.y + HOVER_Y), { key: 'E' });
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
