import * as THREE from 'three';
import { mulberry32 } from '../core/Noise.js';
import { BODIES } from './bodies.js';
import { DEFS } from './defs.js';
import { Enemy } from './Enemy.js';
import { OUTER } from '../world/Biomes.js';

/**
 * Enemies: spawner + AI + procedural creature models with procedural animation (ref: github.com/Ariescar/anyCreature —
 * procedural legged creatures with IK-ish gait). Everything procedural (no downloads). FF14-mystical bestiary + Destiny combat roles.
 *
 * Types: 'wisp' (floating, fragile, swarm, ranged bolt, flees when hurt), 'hound' (fast quadruped melee, pack, planted-foot gait),
 *   'sentinel' (tall biped, arc shield bubble, 3-bolt volleys, strafes), 'golem' (slow heavy, shockwave slam, rock throw, weak point crystal core),
 *   'drake' (elite flyer, orbits + dives with solar volley), 'warden' (mini-boss: void shield phases at 66/33 %, hammer slam, 5-bolt fan).
 * Each enemy (src/enemies/Enemy.js): { id, type, def, name, level, position:Vector3 (feet; flyers: body centre), center:Vector3, velocity, yaw,
 *   health, maxHealth, shield, maxShield, alive, state:'idle'|'patrol'|'chase'|'attack'|'flee'|'stagger'|'dead', root:Object3D, update(dt,t,lod),
 *   takeDamage(info), target: combat target (kind:'enemy', team:'enemy', name, level, health/shield mirrors, weakPoints, shieldElement) }
 * Bodies (src/enemies/bodies.js): THREE.Bone hierarchies + rigid parts merged into ONE SkinnedMesh per creature (1 draw call, + shield bubble),
 *   shared geometry per type, per-instance material uniforms (tint/emissive palette, hit flash, telegraph glow, dissolve). Gait = foot planting +
 *   2-bone IK (rig.js), head tracking, tails, wing flaps, telegraphs, stagger, collapse + dissolve on death.
 * AI: perception (radius + fov + LOS via combat.rayWorld, pack alert, gunfire within 22 m alerts), steering on terrain (heightAt, slope limit,
 *   water avoidance, collider push-out, separation), melee wind-up/lunge, ranged band + strafing, slam = combat.explode + shockwave + camera shake.
 * Spawning: spawn(type, pos, { level, yaw }) -> enemy (cap 40: if full, the farthest camp enemy is recycled); populate() places camps per the
 *   CLAUDE.md layout (meadow wisps, Sundered Spire ruins + Warden, Whisperwood edge, crystal fields); slots respawn 45 s (boss 180 s) after death
 *   when the player is > 50 m away. Update LOD by camera distance (anim every frame < 50 m, /2 < 110, /4 < 220, none beyond; shadows < 45 m).
 * API: spawn(type, pos, opts), list (alive), all (alive + dying), clear(), populate(), types (defs), killAll(), lineup(pos?) (one of each type in a
 *   row facing the player, passive), passive (bool: nobody aggroes), nearest(pos, r), count(type?), stats()
 * Events: 'enemy:spawn' {enemy}, 'enemy:death' {enemy, killer}, 'enemy:attack' {enemy, kind}, 'enemy:stagger' {enemy}, 'enemy:shieldbreak' {enemy},
 *   'enemy:phase' {enemy, phase}
 */
const MAX_ALIVE = 40;
const STREAM = 300;      // m: camps outside this radius are not populated (and get recycled when the cap is tight)
const _v = new THREE.Vector3(), _c = new THREE.Vector3();

export class Enemies {
  constructor(game) {
    this.game = game; this.list = []; this.all = []; this.dying = []; this.types = DEFS; this.pools = {}; this.assets = {}; this.camps = [];
    this.passive = false; this.maxAlive = MAX_ALIVE; this.frame = 0; this._meleeT = -9;
    this.rnd = mulberry32(game.seed + 9137);
    this.playerPos = new THREE.Vector3();                     // player centre (combat target) — read by every enemy
    this.heightAt = (x, z) => this.game.terrain.heightAt(x, z);
    this.animCtx = { eye: new THREE.Vector3(), heightAt: this.heightAt };
    this._tmp = new THREE.Vector3(); this._lodD = 0;
  }
  init() {
    const t0 = performance.now();
    const built = {};   // types that share a body share its geometry (23 types, 9 rigs)
    for (const type of Object.keys(DEFS)) { const bn = DEFS[type].body ?? type; this.assets[type] = built[bn] ??= BODIES[bn].build(); this.pools[type] = []; }
    this.populate();
    this.game.events.on('weapon:fire', () => this._noise(this.game.player.position, 22));
    this.game.events.on('combat:explosion', (e) => { if (e?.owner === this.game.player || e?.owner?.kind === 'player') this._noise(e.point, 30); });
    this.game.events.on('player:respawn', () => { for (const e of this.list) { e.alert = false; } });
    if (this.game.debug) console.log(`[enemies] assets built in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  // ------------------------------------------------------------------ spawning
  spawn(type, pos, opts = {}) {
    const def = DEFS[type]; if (!def) { console.warn('[enemies] unknown type', type); return null; }
    if (this.list.length >= this.maxAlive) { const far = this._farthestCampEnemy(); if (!far) return null; this._despawnAlive(far); }
    const pool = this.pools[type];
    let e = pool.pop();
    if (!e) { e = new Enemy(this, type, this.assets[type]); this.game.scene.add(e.root); }
    _v.set(pos.x, pos.y ?? 0, pos.z);
    e.spawn(_v, opts);
    this.list.push(e); this.all.push(e);
    return e;
  }
  _farthestCampEnemy() {
    let best = null, bd = -1; const p = this.game.player.position;
    for (const e of this.list) { if (!e.slot || e.def.boss) continue; const d = e.position.distanceToSquared(p); if (d > bd) { bd = d; best = e; } }
    return best;
  }
  _despawnAlive(e) { // silent removal (recycling, clear()) — no death event
    if (e.slot) { e.slot.enemy = null; e.slot.deadAt = this.game.time - 30; }
    this._remove(this.list, e); this._remove(this.all, e); e.sleep(); this.pools[e.type].push(e);
  }
  _onDeath(e) {
    this._remove(this.list, e); this.dying.push(e);
    if (e.slot) { e.slot.enemy = null; e.slot.deadAt = this.game.time; }
  }
  _despawn(e) { this._remove(this.dying, e); this._remove(this.all, e); e.sleep(); this.pools[e.type].push(e); }
  _remove(arr, e) { const i = arr.indexOf(e); if (i >= 0) arr.splice(i, 1); }
  killAll() { for (const e of this.list.slice()) e.takeDamage({ amount: 1e9, element: 'kinetic', crit: false, owner: null, source: 'killAll' }); }
  clear() { for (const e of this.list.slice()) this._despawnAlive(e); for (const e of this.dying.slice()) this._despawn(e); }
  count(type) { let n = 0; for (const e of this.list) if (!type || e.type === type) n++; return n; }
  nearest(pos, r = 1e9) { let best = null, bd = r * r; for (const e of this.list) { const d = e.position.distanceToSquared(pos); if (d < bd) { bd = d; best = e; } } return best; }
  stats() { const by = {}; for (const e of this.list) by[e.type] = (by[e.type] ?? 0) + 1; return { alive: this.list.length, dying: this.dying.length, by, camps: this.camps.length, passive: this.passive, cpuMs: +(this.msAvg ?? 0).toFixed(3) }; }
  /** one of each type in a row 12 m in front of the player, facing them, passive (for lineup screenshots) */
  lineup(pos) {
    const P = this.game.player; const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw); const rx = Math.cos(P.yaw), rz = -Math.sin(P.yaw);
    const c = pos && !Array.isArray(pos) ? _c.set(pos.x, 0, pos.z) : _c.set(P.position.x + fx * 13, 0, P.position.z + fz * 13);
    const types = Array.isArray(pos) ? pos : (this._lineupTypes ?? ['wisp', 'hound', 'sentinel', 'golem', 'drake', 'warden']);
    const out = [];
    let x = -(types.length - 1) * 2.4; this.passive = true;
    for (let i = 0; i < types.length; i++) {
      x += i ? 4.8 : 0; const e = this.spawn(types[i], { x: c.x + rx * x, z: c.z + rz * x }, { level: 3, yaw: Math.atan2(P.position.x - (c.x + rx * x), P.position.z - (c.z + rz * x)) });
      if (e) {
        if (e.def.flying) { e.position.y = this.heightAt(e.position.x, e.position.z) + Math.min(e.def.hover, 2.4); e.root.position.copy(e.position); e.wantPos.copy(e.position); } // pin flyers into frame (drake hovers 11 m otherwise)
        e.home.copy(e.position); e.idleDur = 99; out.push(e);
      }
    }
    return out;
  }

  /** one passive enemy of `type`, `dist` m in front of the player, flyers pinned low — close-up screenshots */
  showcase(type, dist = 4.5, opts = {}) {
    this.clear(); this.passive = true;
    const P = this.game.player, fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    const x = P.position.x + fx * dist, z = P.position.z + fz * dist;
    const e = this.spawn(type, { x, z }, { level: opts.level ?? 3, yaw: P.yaw + Math.PI });
    if (!e) return null;
    if (e.def.flying) { e.position.y = this.heightAt(x, z) + Math.min(e.def.hover, 2.2); e.root.position.copy(e.position); e.wantPos.copy(e.position); }
    e.home.copy(e.position); e.idleDur = 999;
    return e;
  }

  // ------------------------------------------------------------------ world population (CLAUDE.md layout)
  populate() {
    this.clear(); this.camps.length = 0;
    const camp = (name, cx, cz, radius, level, members, opts = {}) => {
      const c = { name, center: new THREE.Vector3(cx, 0, cz), radius, level, slots: [], alertT: -99, respawn: opts.respawn ?? 45 };
      for (const [type, n, r0, r1] of members) for (let i = 0; i < n; i++) {
        const p = this._campPoint(cx, cz, r0 ?? 2, r1 ?? radius, DEFS[type].flying);
        c.slots.push({ type, pos: p, enemy: null, deadAt: -1e9, level: opts.levelOf?.(type) ?? level });
      }
      this.camps.push(c);
    };
    camp('meadow', 0, 0, 58, 1, [['wisp', 2, 48, 64]]);                                                              // user decree: spawn meadow stays peaceful — 2 wisps, beyond perception range of an idle spawn player
    camp('ruins', 140, 60, 42, 3, [['sentinel', 2, 6, 28], ['hound', 2, 10, 36], ['wisp', 2, 8, 38], ['golem', 1, 34, 46]]);   // Sundered Spire camp
    camp('warden', 140, 60, 14, 5, [['warden', 1, 0, 1]], { respawn: 180 });                                        // mini-boss at the shattered tower
    camp('forest-west', -85, -188, 30, 2, [['hound', 3, 4, 26], ['wisp', 2, 6, 28]]);                                 // Whisperwood edge
    camp('forest-east', 75, -192, 32, 3, [['hound', 2, 4, 26], ['wisp', 2, 6, 28], ['drake', 1, 0, 8]]);
    camp('crystal-north', 262, -25, 36, 2, [['hound', 2, 6, 30], ['wisp', 4, 6, 34]]);                               // crystal fields
    camp('crystal-south', 256, 88, 36, 4, [['golem', 1, 2, 12], ['wisp', 2, 8, 30], ['hound', 1, 8, 30], ['drake', 1, 0, 8]]);
    // --- the nine outer regions: roster + level band come from Biomes.js, one camp each.
    for (const b of OUTER) {
      const [lo, hi] = b.level;
      camp(b.short, b.cx, b.cz, 120, Math.round((lo + hi) / 2), b.enemies, {
        respawn: b.id === 'lost' ? 180 : 60,
        levelOf: (type) => (DEFS[type].boss ? hi : lo + Math.floor(this.rnd() * (hi - lo + 1))),
      });
    }
    // Only the home region is populated up front — the rest stream in as the player travels (see update).
    for (const c of this.camps) for (const s of c.slots) if (s.pos.lengthSq() < 340 * 340) this._spawnSlot(c, s);
  }
  _campPoint(cx, cz, r0, r1, flying) {
    const T = this.game.terrain; let best = null, bs = 9;
    for (let i = 0; i < 8; i++) {
      const a = this.rnd() * Math.PI * 2, r = r0 + this.rnd() * (r1 - r0);
      const x = cx + Math.sin(a) * r, z = cz + Math.cos(a) * r, s = flying ? 0 : T.slopeAt(x, z), wet = T.heightAt(x, z) < (T.waterLevel ?? -999) + 0.3 ? 5 : 0;
      if (s + wet < bs) { bs = s + wet; best = new THREE.Vector3(x, 0, z); if (bs < 0.25) break; }
    }
    return best;
  }
  _spawnSlot(c, s) {
    if (this.list.length >= this.maxAlive) return null;
    const e = this.spawn(s.type, s.pos, { level: s.level, camp: c, slot: s });
    if (e) s.enemy = e; return e;
  }

  // ------------------------------------------------------------------ frame
  update(dt, t) {
    const t0 = performance.now();
    const g = this.game, P = g.player, cam = g.camera.position;
    this.playerPos.copy(P.target?.position ?? P.position); this.animCtx.eye.copy(P.eye ?? P.position);
    // daylight fights the emissives: boost glow with sun elevation so crystals/eyes/visors read at noon too (night = x1, unchanged)
    this.dayGlow = 1 + 2.4 * Math.max(0, g.sky?.sunDir?.y ?? 0);
    const shadows = g.quality !== 'low';
    const frame = this.frame = (this.frame ?? 0) + 1;
    // crowd LOD: a full field (40) halves anim/sync tick rates before the CPU budget blows. 72 Hz bone posing at
    // 144 fps is invisible; motion integration + the standoff ring stay per-frame so nothing pops or clips.
    const n = this.all.length; this.crowd = n > 26 ? 2 : n > 16 ? 1.5 : 1;
    for (let i = this.all.length - 1; i >= 0; i--) {
      const e = this.all[i];
      const dx = e.position.x - cam.x, dy = e.position.y - cam.y, dz = e.position.z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;                                       // squared distances: no sqrt in the hot loop
      const lod = d2 < 2500 ? 0 : d2 < 12100 ? 1 : d2 < 48400 ? 2 : 3;             // 50 / 110 / 220 m
      // quality-scaled cast range: skinned shadow draws hit every CSM cascade, and at q=high the
      // 45 m ring meant a whole camp cast at once (~3 ms median at the ruins — perf audit round 3).
      // 25 m keeps the grounding shadow on whatever is actually near you.
      e.mesh.castShadow = shadows && d2 < (this.castD2 ??= 625) && e.alive;
      e.root.visible = d2 < 176400;                                                 // 420 m
      if (this.passive && e.alive) { e.alert = false; e.seen = false; }
      e.update(dt, t, lod, frame, d2);
    }
    // respawns (cheap scan, 4x a second)
    this._respT = (this._respT ?? 0) + dt;
    if (this._respT > 0.25) {
      this._respT = 0;
      // Camp streaming. The world is 2048 m with ten regions; populating every slot would blow the
       // 40-alive cap at spawn and leave every distant biome empty forever. Instead a slot is eligible
       // only inside STREAM m of the player, and when the cap is full the FARTHEST live camp enemy is
       // recycled to make room for a much nearer one (1.6x margin = no thrash on the boundary).
      for (const c of this.camps) for (const s of c.slots) {
        if (s.enemy || t - s.deadAt < c.respawn) continue;
        const d2 = s.pos.distanceToSquared(P.position);
        if (d2 < 50 * 50 || d2 > STREAM * STREAM) continue;
        if (this.list.length >= this.maxAlive) {
          const far = this._farthestCampEnemy();
          if (!far || far.position.distanceToSquared(P.position) < d2 * 1.6) continue;
          this._despawnAlive(far);
        }
        this._spawnSlot(c, s);
      }
    }
    const ms = performance.now() - t0; this.ms = ms; this.msAvg = (this.msAvg ?? ms) * 0.95 + ms * 0.05;   // CPU cost of this system (harness reads enemies.msAvg)
  }
  /** melee attack token: spaces pack strikes out (Destiny: one biter commits at a time, the rest dance).
   *  0.85 s => a pack caps at ~11 strikes / 10 s no matter how many are engaged; a lone melee is never starved
   *  (its own cooldown is the limit). This is the pack DPS knob — tune here, not in defs. */
  meleeToken(t) { if (t < this._meleeT) return false; this._meleeT = t + 0.85; return true; }
  _noise(pos, r) {
    if (this.passive) return;
    const r2 = r * r, t = this.game.time;
    for (const e of this.list) if (e.alive && e.position.distanceToSquared(pos) < r2) { e.alert = true; e.lastSeen.copy(this.playerPos); e.lastSeenT = t; if (e.camp) e.camp.alertT = t; }
  }
}
