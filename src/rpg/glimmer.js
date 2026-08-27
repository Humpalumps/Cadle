// OWNER: rpg agent. Glimmer motes — the currency economy made PHYSICAL.
//
// Kills used to pay glimmer silently (loot.js granted it straight into the wallet on
// 'enemy:death'), which meant the most universal reward in the game had no presence in the
// world at all. Now a kill scatters small gold motes that MAGNET to the player, Destiny
// style: walk anywhere near them and they stream in and pay out. Quests keep paying wallet
// glimmer directly at turn-in (reward.glimmer, quest.js) — a turn-in is a transaction, not
// a pickup.
//
// Value scales with what died: base rises with enemy level, elites pay ~2.5x, bosses ~6x
// (enemyTier from droptable.js, same vocabulary loot uses). currencyMul (Salvage skill,
// Wyrmsworn 4-set) is applied by prog.grant at collect time, so the skill keeps working.
//
// BLOB LAW (CLAUDE.md): up to 48 of these can be on the ground mid-fight, the densest
// population after ammo bricks. Saturate the COLOUR, cap the INTENSITY: emissiveIntensity
// 0.5 (hard ceiling 0.6), roughness 0.7 (floor 0.6), warm saturated gold hue that survives
// tone mapping. No beacon, no halo, no toneMapped:false, nothing additive. A mote does not
// need to be found — it finds YOU — so it needs no visibility budget at all.
import * as THREE from 'three';
import { enemyTier } from './droptable.js';
import { grant } from './progression.js';

const MAX_MOTES = 48;
const MOTE_LIFE = 45;          // s — shorter than ammo bricks; a mote you outran was tiny money
const MAG_R = 9;               // m — magnet reach (bricks are walk-over at 1.6; money comes to you)
const COLLECT_R = 0.9;         // m — close enough = paid
const MAG_ACCEL = 46;          // m/s^2 toward the player once inside MAG_R
const HOVER_H = 0.35;          // m rest height — small object, above most blade tips is not needed
                               // because it moves; motion is its visibility
const FEED_GAP = 1.5;          // s between HUD pickup-feed lines (batch the amount between them)

// warm saturated gold — same family as the light ammo brick, smaller and dimmer
function moteMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x4a3410, emissive: 0xffc040,
    emissiveIntensity: 0.5,   // BLOB LAW: hard ceiling 0.6 — do not raise
    roughness: 0.7,           // BLOB LAW: never below 0.6
    metalness: 0.25, flatShading: true,
  });
}

let inst = null, group = null;
const pool = [];
for (let i = 0; i < MAX_MOTES; i++) {
  pool.push({ live: false, value: 0, age: 0, grounded: false, phase: 0, spin: 0,
    pos: new THREE.Vector3(), vel: new THREE.Vector3() });
}

// scratch — the frame loop allocates nothing
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
let _feedAcc = 0, _feedT = -99;

/** one mote on the ground. Pool-full = silently skipped (its value merges into a sibling below). */
function spawnMote(ctx, x, y, z, value) {
  const m = pool.find((b) => !b.live);
  if (!m) {
    // no free slot: fold the value into the oldest live mote so no money is ever lost
    let old = null;
    for (const b of pool) if (b.live && (!old || b.age > old.age)) old = b;
    if (old) old.value += value;
    return null;
  }
  m.live = true; m.value = value; m.age = 0; m.grounded = false;
  m.phase = Math.random() * 6.28; m.spin = 2.2 + Math.random() * 1.6;
  m.pos.set(x, y, z);
  m.vel.set((Math.random() - 0.5) * 3.2, 3.4 + Math.random() * 1.2, (Math.random() - 0.5) * 3.2);
  return m;
}

/** The kill payout: total glimmer scaled by level + tier, scattered as 2-5 motes. */
export function dropFor(ctx, enemy, position) {
  const level = (enemy && enemy.level) || 1;
  const tier = enemyTier(enemy);
  const mult = tier === 'boss' ? 6 : tier === 'elite' ? 2.5 : 1;
  const total = Math.max(3, Math.round((5 + level * 1.6) * mult * (0.8 + Math.random() * 0.5)));
  const n = Math.min(2 + ((total / 14) | 0), 5);
  const p = position || (ctx.player && ctx.player.position);
  if (!p) return;
  let gh = 0;
  try { gh = ctx.world.heightAt(p.x, p.z) || 0; } catch (e) {}
  const y = Math.max(p.y || 0, gh) + 0.8;
  let left = total;
  for (let i = 0; i < n; i++) {
    const v = i === n - 1 ? left : Math.max(1, Math.round(total / n));
    left -= v;
    spawnMote(ctx, p.x, y, p.z, v);
  }
}

export function init(ctx) {
  group = new THREE.Group();
  group.name = 'rpg-glimmer';
  ctx.scene.add(group);
  // one small faceted gold shard, instanced — 1 draw call for the whole population
  const geo = new THREE.OctahedronGeometry(0.09, 0);
  geo.scale(1, 1.5, 1);
  inst = new THREE.InstancedMesh(geo, moteMaterial(), MAX_MOTES);
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.frustumCulled = false;
  inst.castShadow = false; inst.receiveShadow = false;
  inst.count = 0;
  group.add(inst);

  ctx.events.on('enemy:death', (e) => {
    const en = (e && e.enemy) || e || {};
    const pos = en.position || (en.mesh && en.mesh.position) || ctx.player.position;
    dropFor(ctx, en, pos);
  });
}

export function update(ctx, dt) {
  if (!inst) return;
  const p = ctx.player.position;
  const t = ctx.time;
  let n = 0;
  let paid = 0;

  for (let i = 0; i < pool.length; i++) {
    const m = pool[i];
    if (!m.live) continue;
    m.age += dt;
    if (m.age > MOTE_LIFE) { m.live = false; continue; }

    const dx = p.x - m.pos.x, dy = (p.y + 0.9) - m.pos.y, dz = p.z - m.pos.z;
    const d2 = dx * dx + dy * dy + dz * dz;

    if (d2 < COLLECT_R * COLLECT_R) { paid += m.value; m.live = false; continue; }

    if (d2 < MAG_R * MAG_R) {
      // the magnet: accelerate toward the player, ignore the ground once hooked
      const d = Math.sqrt(d2) || 1;
      const pull = MAG_ACCEL * (1 - d / (MAG_R * 1.4));
      m.vel.x += dx / d * pull * dt;
      m.vel.y += dy / d * pull * dt;
      m.vel.z += dz / d * pull * dt;
      m.vel.multiplyScalar(Math.max(0, 1 - 2.0 * dt));   // drag so it homes, not orbits
      m.pos.addScaledVector(m.vel, dt);
      m.grounded = false;
    } else if (!m.grounded) {
      m.vel.y -= 20 * dt;
      m.pos.addScaledVector(m.vel, dt);
      let gh = 0;
      try { gh = ctx.world.heightAt(m.pos.x, m.pos.z) || 0; } catch (e) {}
      if (m.pos.y <= gh + HOVER_H) { m.pos.y = gh + HOVER_H; m.grounded = true; m.vel.set(0, 0, 0); }
    }

    _e.set(0, m.spin * t + m.phase, 0.3);
    _q.setFromEuler(_e);
    _p.set(m.pos.x, m.pos.y + (m.grounded ? Math.sin(t * 2.6 + m.phase) * 0.05 : 0), m.pos.z);
    _s.setScalar(1);
    _m4.compose(_p, _q, _s);
    inst.setMatrixAt(n++, _m4);
  }

  if (inst.count !== n) inst.count = n;
  inst.instanceMatrix.needsUpdate = true;

  if (paid > 0) {
    grant(ctx, { glimmer: paid });   // currencyMul applied inside grant
    _feedAcc += paid;
    try { ctx.audio?.play?.('pickup', { pitch: 1.55, vol: 0.3, force: true }); } catch (e) {}
  }
  // batched feed line: a pack dying at once reads as one "+38 Glimmer", not five lines
  if (_feedAcc > 0 && t - _feedT > FEED_GAP) {
    _feedT = t;
    try { ctx.hud?.pickup?.('+' + _feedAcc + ' Glimmer'); } catch (e) {}
    _feedAcc = 0;
  }
}

/** Automation surface — scalars only (HANDOVER §5.5). */
export function state() {
  let motes = 0, value = 0;
  for (const m of pool) if (m.live) { motes++; value += m.value; }
  return { motes, value };
}

/** Sweep the field — respawn, fast travel, a gate resetting. */
export function clearMotes() {
  for (const m of pool) m.live = false;
  if (inst) inst.count = 0;
}
