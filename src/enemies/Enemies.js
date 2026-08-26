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
 * Spawning: spawn(type, pos, { level, yaw, elite, name, questTag }) -> enemy (cap MAX_ALIVE: if full, the farthest camp enemy is recycled);
 *   `elite: true` scales HP/dmg/xp and gives a distinguishing gold tint + size bump (see ELITE_* in Enemy.js) for slay-a-mini-boss quest
 *   objectives — `enemy.elite === true`, optional `enemy.questTag`. populate() places camps per the CLAUDE.md layout (meadow wisps, Sundered
 *   Spire ruins + Warden, Whisperwood edge, crystal fields) plus, per outer region: 3 camps (heart + two satellites ~140 m off the region
 *   bearing), 2 roaming packs of the region's common trash type walking a waypoint LOOP (heart -> satellite -> the rare's POI; camp.route),
 *   and ONE NAMED RARE (NAMED_RARES: gold elite at 2.5x hp, band-top level, 8-12 min respawn, at a POI off the pass road, `enemy.namedRare`
 *   — RPG.js drops a guaranteed legendary off it); slots respawn 45-60 s (boss/mini-boss 180 s)
 *   after death when the player is > 50 m away. Dragon nests are encounters (_updateNests): approach one and a guardian wyvern pair
 *   wakes + the nest drops an egg (quest item while 'peak-s3' is active, else an uncommon); 10 min re-arm, never under `passive`. Update LOD by camera distance (anim every frame < 50 m, /2 < 110, /4 < 220, none beyond;
 *   shadows < 25 m); anim + AI-tick + uniform-upkeep rates are further crowd-scaled (1.5x > 16 alive, 2x > 32, 3x > 48 alive).
 * API: spawn(type, pos, opts), list (alive), all (alive + dying), clear(), populate(), warm() (one sleeping instance of every type in the pools, so boot compiles their shaders), types (defs), killAll(), lineup(pos?) (one of each type in a
 *   row facing the player, passive), passive (bool: nobody aggroes), nearest(pos, r), count(type?), stats(),
 *   spawnFriendly(type, from, {to, hp, tag, name}) -> handle (escort guide: reuses `type`'s body, no new creature;
 *   scaled up + tinted GUIDE_COLOR so it doesn't read as another wisp, and a world-tracked HUD nameplate +
 *   health bar via hud.showGuide — see HUD.js). Straight lerp route via
 *   terrain.heightAt, friendly team so player fire can't hit it but hostile AI still aggroes it — see Enemy.js's
 *   `_threat` resolution. despawnFriendly(handle) (abandon; optional-chained by callers, but skipping it leaves
 *   a stray wisp standing forever — also the one hud.hideGuide() call site, so every exit path clears the HUD)
 * Events: 'enemy:spawn' {enemy}, 'enemy:death' {enemy, killer}, 'enemy:attack' {enemy, kind}, 'enemy:stagger' {enemy}, 'enemy:shieldbreak' {enemy},
 *   'enemy:phase' {enemy, phase}, 'quest:guide' {id (the `tag` passed to spawnFriendly), alive, arrived} — fired once on the guide's
 *   death (alive:false) or on reaching `to` (arrived:true), never both
 */
// MAX_ALIVE 40 -> 72. MEASURED, on a quiet box, by the orchestrator (2026-08-23), and the number
// that matters is the CONTROL: the same route re-run with this constant set back to 40.
//   uncapped, --route combat, q=high, http://127.0.0.1:5174/, no orphaned headless browsers
//   cap 40  mean 7.23 ms  p95 10.0  p99 79.0  max 823  spikes 138
//   cap 72  mean 7.24 ms  p95  9.2  p99 74.5  max 692  spikes 142
// The raise costs 0.01 ms of mean and is slightly BETTER on p95/p99/max — i.e. free, and the LOD
// ladder above is what paid for it. The uncapped p99 misses the CLAUDE.md budget at BOTH caps, so
// that miss is pre-existing (see HANDOVER 5.1: q=high has no GPU headroom) and is not this change.
// With vsync on — what a player actually feels — every combat phase holds 60 fps: mean 16.6-16.8 ms,
// p99 19-23 ms, zero spikes in most phases.
// Raise this further only with the same control in hand: measure the new cap AND the current one on
// the same quiet box, or you are measuring the weather.
const MAX_ALIVE = 72;
const r6 = (r) => Math.min(2.2, r * 0.32);   // hazard puff scale
const STREAM = 300;      // m: camps outside this radius are not populated (and get recycled when the cap is tight)
const _v = new THREE.Vector3(), _c = new THREE.Vector3();
// escort guide: warm peach/apricot. Reworked from an earlier green pick (2026-08-23 review) — green loses
// against the actual world, not against other creatures: the Vale is a green MEADOW and Whisperwood is a
// green FOREST, and the guide walks through both, so a green guide was camouflage against 90% of the pixels
// on screen for the entire escort. Colliding with the ENVIRONMENT matters far more than colliding with any
// one hostile's palette, because the environment is always on screen and everything else is not. Warm
// peach/apricot separates from grass/foliage (green) by hue, from snow (Frostveil) by warmth, from ash
// (Infernal) and peat (Shadowfen) by value, and from water (Sunken) by hue — the universal case across every
// biome an escort can run through, not just the one it was designed against. Biased toward rose/peach rather
// than pure gold specifically so it still doesn't read as the elite's tint (0xd9a53a, ELITE_TINT in Enemy.js)
// even though that collision is minor in practice (a large humanoid with a red boss bar vs. a small floating
// wisp with a green HUD plate — they don't actually get confused). Colour only, `def.glow` (0.85 for wisp) is
// left untouched — already under the 1.1 ceiling tools/invariants.mjs enforces, so this can never cross the
// bloom threshold. Blob law: saturate the colour, cap the intensity — never the other way round.
const GUIDE_COLOR = new THREE.Color(0xffb37a);
const GUIDE_SCALE = 1.7;   // bigger than even an elite (1.35x, see ELITE_SCALE_MUL in Enemy.js) — the one
                           // friendly silhouette in the world has to read as unmistakably not-hostile at range
const GUIDE_SPEED = 3.2;   // m/s: a walk, not a sprint — the player has to stay with it
// ponytail: no ground-marker pulse (a periodic vfx 'ring' at its feet was tried and cut — it measurably
// flashed a ground-cover pixel cluster past the blob threshold in tools/blobcheck.py, the exact bug the
// ARCHITECTURAL LAW exists to prevent). Findability instead comes from silhouette (GUIDE_SCALE), colour
// (GUIDE_COLOR + trail), and the HUD nameplate (HUD.js showGuide/hideGuide) — all off the ground-cover
// blob path entirely. Upgrade path if a ground cue is still wanted: a static (non-flashing) decal texture
// under the feet, not a particle burst — ask whoever owns VFX.js/Grass.js for a ground-cover-safe primitive.

// NAMED RARES — one per outer region (Destiny "wandering elite" beat). Pure data: the runtime is the
// existing elite modifier (Enemy.js) + the existing camp/slot/respawn machinery, at 2.5x HP (hpMul
// overrides the elite 3.0x), level = top of the region's band, 8-12 min respawn, spawned at a POI off
// the pass road (radial+tangent diagonal from the region heart — see populate). Every `type` is in
// that region's Biomes.js roster, so nothing here can name an enemy that does not exist.
// The guaranteed legendary drop on death is RPG.js's side of the contract (it checks `enemy.namedRare`).
const NAMED_RARES = {
  forest:    { type: 'treant',     name: 'Thornmaw the Rooted' },
  tundra:    { type: 'frostwolf',  name: 'Old Rimefang' },
  celestial: { type: 'seraph',     name: 'Auriel of the Second Choir' },
  dragon:    { type: 'wyvern',     name: 'Ashwing the Broodmother' },
  infernal:  { type: 'magmagolem', name: 'Slagheart' },
  lost:      { type: 'sentinel',   name: 'Warden of the Sixteenth Stone' },
  shadowfen: { type: 'bogwitch',   name: 'Grandmother Rot' },
  sunken:    { type: 'drowned',    name: 'The Seneschal' },
  void:      { type: 'voidhorror', name: 'Null-of-Nine' },
};

export class Enemies {
  constructor(game) {
    this.game = game; this.list = []; this.all = []; this.dying = []; this.types = DEFS; this.pools = {}; this.assets = {}; this.camps = [];
    this.passive = false; this.maxAlive = MAX_ALIVE; this.frame = 0; this._meleeT = -9;
    this.rnd = mulberry32(game.seed + 9137);
    this.playerPos = new THREE.Vector3();                     // player centre (combat target) — read by every enemy
    this.heightAt = (x, z) => this.game.terrain.heightAt(x, z);
    this.animCtx = { eye: new THREE.Vector3(), heightAt: this.heightAt };
    this._tmp = new THREE.Vector3(); this._lodD = 0;
    this.hazards = [];      // lingering ground patches left by signature slams (see addHazard)
    this.friendly = null;   // the one escort guide, if any — see spawnFriendly(); NOT in list/all (see there)
  }
  init() {
    const t0 = performance.now();
    const built = {};   // types that share a body share its geometry (23 types, 9 rigs)
    for (const type of Object.keys(DEFS)) { const bn = DEFS[type].body ?? type; this.assets[type] = built[bn] ??= BODIES[bn].build(); this.pools[type] = []; }
    this.populate();
    this.warm();   // AFTER populate: the home camps consume from the pools, so warming first left the six home types with no spare
    this.game.events.on('weapon:fire', () => this._noise(this.game.player.position, 22));
    this.game.events.on('combat:explosion', (e) => { if (e?.owner === this.game.player || e?.owner?.kind === 'player') this._noise(e.point, 30); });
    this.game.events.on('player:respawn', () => { for (const e of this.list) { e.alert = false; } if (this.friendly) this.despawnFriendly(this.friendly); });
    if (this.game.debug) console.log(`[enemies] assets built in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  /**
   * Boot prewarm: one sleeping instance of EVERY type, parked in its pool, so that at boot the scene
   * holds a mesh + material (+ shield bubble) for all 23 — nothing a shader-warming pass can miss and
   * nothing left to construct mid-play. Called AFTER populate(), which pops the home types.
   * Nothing is wasted: pooled enemies are already left in the scene (sleep() only hides the root, and
   * an invisible object is still walked by renderer.compile(), which traverses rather than culls), and
   * the first real spawn of a type just pops this one off the pool.
   * Inert by construction: the Enemy constructor leaves root.visible = false, alive = false, no combat
   * target registered, and it is in neither `list` nor `all`, so nothing sees it (AI, maxAlive, state()).
   * ~1 ms for all 23 (bodies share geometry, so this is a bone clone + a material each) and it consumes
   * no rnd() draws, so camp placement stays deterministic.
   * NOTE (2026-08-23, measured): existing in the scene is necessary but NOT sufficient. The game draws
   * through the postfx composer, i.e. into a render target, so every program it uses is keyed
   * outputColorSpace = 'srgb-linear' (WebGLPrograms.getParameters), while a renderer.compile() with no
   * render target bound builds the 'srgb' variant of the same shader. Warming therefore only pays off
   * if the warm pass has a render target bound — see the report / main.js warmScene.
   */
  warm() {
    const y = this.heightAt(0, 0) + 1;   // parked ON the spawn point: a one-frame warm render at boot (main.js) then
    for (const type of Object.keys(DEFS)) {   // has them in frame AND in shadow cascade 0 — mesh.castShadow is already true from the ctor
      if (this.pools[type].length) continue;
      const e = new Enemy(this, type, this.assets[type]);
      e.root.position.set(0, y, 0);
      this.game.scene.add(e.root);
      this.pools[type].push(e);
    }
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

  // ------------------------------------------------------------------ escort guide (quest system)
  /**
   * Spawn the one escort guide: reuses `type`'s existing body/Enemy class (no new creature, no new art) on a
   * straight lerp route from `from` to `opts.to` at a walking pace — deliberately not a companion AI. Friendly:
   * target.team is flipped to 'player' so Combat's existing hostility check (same team = not hostile) blocks
   * the player's own fire, while hostile enemies (team 'enemy') still see it as a valid target — see Enemy.js
   * `_perceive`'s `combat.nearest(..., 'player')` threat resolution, which now returns whichever of {player,
   * guide} is nearer. Kept OUT of `list`/`all`: it never competes for MAX_ALIVE and gets its own tiny per-frame
   * tick (_updateFriendly) instead of the full AI update (it has no AI — a lerp needs none).
   * Exactly one at a time: a second call despawns the first. Returns the handle (truthy) or null if `to`/the
   * type is missing. `opts`: { to:{x,z}, hp, tag, name }. `tag` comes back verbatim as `id` on every
   * 'quest:guide' event. `name` (default 'Wayfinder') is what the HUD frame and nameplate read — deliberately
   * not `def.name` ("Aether Wisp" etc.), which is literally the hostile creature's own name.
   * Visuals + HUD: scaled up (GUIDE_SCALE), tinted/emissive GUIDE_COLOR, a denser same-coloured ambient trail
   * (re-attached here — Enemy.spawn() already started one in whatever random hostile hue the palette rolled),
   * and a world-tracked HUD nameplate + health bar (hud.showGuide) so the player always knows it's alive and
   * how hurt it is — see HUD.js.
   */
  spawnFriendly(type, from, opts = {}) {
    if (this.friendly) this.despawnFriendly(this.friendly);
    const def = DEFS[type]; if (!def || !opts.to) return null;
    const pool = this.pools[type]; let e = pool.pop();
    if (!e) { e = new Enemy(this, type, this.assets[type]); this.game.scene.add(e.root); }
    _v.set(from.x, from.y ?? 0, from.z);
    e.spawn(_v, { level: 1, isGuide: true, name: opts.name ?? 'Wayfinder' });
    e.target.team = 'player';
    if (opts.hp) { e.maxHealth = e.health = e.target.maxHealth = e.target.health = opts.hp; }
    e.glowColor.set(GUIDE_COLOR); e.u.uEmissive.value.set(GUIDE_COLOR); e.u.uTint.value.set(GUIDE_COLOR);   // friendly hue, same capped def.glow
    e.root.scale.setScalar((def.scale ?? 1) * GUIDE_SCALE);
    e._trail?.stop?.(); e._trail = this.game.vfx?.attach?.('trail', e, { rate: 26, color: GUIDE_COLOR.getHex(), scale: 1.1, until: () => e.alive });   // overrides the random hostile-hued trail Enemy.spawn() just started
    const to = new THREE.Vector3(opts.to.x, 0, opts.to.z); to.y = this.heightAt(to.x, to.z) + (def.hover ?? 0);
    const f = { enemy: e, to, arrived: false, tag: opts.tag ?? null };
    this.friendly = f;
    this.game.hud?.showGuide?.(e);
    return f;
  }
  /** Abandon the escort: cleanup only, no 'quest:guide' event (that's for a real death/arrival). Skipping this
   *  call (it's optional-chained by design) leaves the wisp standing at wherever it got to, forever. */
  despawnFriendly(handle) {
    if (!handle || handle !== this.friendly) return;
    this.friendly = null;
    this.game.hud?.hideGuide?.();   // single hook for all three exits: this call, _killFriendly (death) and player:respawn all route through here
    const e = handle.enemy; e.isGuide = false; e.root.scale.setScalar(e.def.scale ?? 1); e.sleep(); this.pools[e.type].push(e);
  }
  /** called from Enemy._guideDamage when the guide's HP hits 0 — the quest-visible death. */
  _killFriendly(enemy) {
    const f = this.friendly; if (!f || f.enemy !== enemy) return;
    this.game.events.emit('quest:guide', { id: f.tag, alive: false, arrived: false });
    this.despawnFriendly(f);
  }
  /** the guide's entire "AI": lerp toward `to` along the ground, then stop. No think/perceive/steer — those
   *  are for creatures that fight; this one just walks and can be shot (see Enemy.js isGuide/_guideDamage). */
  _updateFriendly(dt, t) {
    const f = this.friendly; if (!f) return;
    const e = f.enemy;
    const dx = f.to.x - e.position.x, dz = f.to.z - e.position.z, d = Math.hypot(dx, dz);
    if (d > 1) {
      const k = Math.min(1, GUIDE_SPEED * dt / d);
      e.position.x += dx * k; e.position.z += dz * k;
      e.position.y = this.heightAt(e.position.x, e.position.z) + (e.def.hover ?? 0);
      e.yaw = Math.atan2(dx, dz); e.center.copy(e.position);
      e.root.position.copy(e.position); e.root.rotation.set(0, e.yaw, 0);
    } else if (!f.arrived) {
      f.arrived = true;
      this.game.events.emit('quest:guide', { id: f.tag, alive: true, arrived: true });
      // job done: disappear cleanly, same as death/explicit despawn (also clears the HUD frame — see
      // despawnFriendly). quest.js's own cleanup on quest completion still calls despawnFriendly too; that's
      // a harmless no-op second call (it early-returns once `this.friendly` no longer matches the handle) —
      // without THIS call nothing despawns it at all until quest completion, which can be well after arrival
      // (the objective just needs a bump), leaving a "Guide" standing there forever with a live HUD frame.
      this.despawnFriendly(f);
      return;
    }
    e._animate(dt, t); e._sync(dt, t, 0);   // visual life only (bob/pulse) — lod 0: it's the only one, full quality is free
  }

  // ------------------------------------------------------------------ world population (CLAUDE.md layout)
  populate() {
    this.clear(); this.camps.length = 0;
    const camp = (name, cx, cz, radius, level, members, opts = {}) => {
      const c = { name, center: new THREE.Vector3(cx, 0, cz), radius, level, slots: [], alertT: -99, respawn: opts.respawn ?? 45, route: opts.route ?? null };
      for (const [type, n, r0, r1] of members) for (let i = 0; i < n; i++) {
        const p = this._campPoint(cx, cz, r0 ?? 2, r1 ?? radius, DEFS[type].flying);
        c.slots.push({ type, pos: p, enemy: null, deadAt: -1e9, level: opts.levelOf?.(type) ?? level, opts: opts.slotOpts ?? null });
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
    // --- the nine outer regions: roster + level band come from Biomes.js. 3 camps each — the heart plus
    // two satellites ~140 m off the region's own bearing (tangentially, i.e. sideways: never toward a
    // neighbour) — so a region has fights spread through it instead of one fight parked on the centre.
    // Per-type membership is x1.6 vs. the original single-camp roster, split 50/25/25 across heart/sat/sat
    // (rounding drifts a bit high, not low — never ships under the brief's x1.6). A boss/mini-boss entry
    // (count 1, e.g. the Archon) is not split: splitting a 1-count slot across camps makes no sense, so it
    // stays on the heart only, unscaled. Two roaming packs of the region's most common trash type wander the
    // gap between heart and each satellite — reuses the exact same camp/slot/respawn/wander machinery with a
    // wide radius, not a new AI system, so "the space between camps is not empty" costs zero new code paths.
    // EXCEPTION: Whisperwood (forest) is held at its ORIGINAL single-camp roster, unscaled. The view south
    // out of it is already 4.4-4.9 M tris against the 4 M budget (HANDOVER 5.9) — it gets no extra mobs
    // until that is fixed by whoever owns tree density; density work here must not make that worse.
    for (const b of OUTER) {
      const [lo, hi] = b.level;
      const midLevel = Math.round((lo + hi) / 2);
      const respawn = b.id === 'lost' ? 180 : 60;
      const levelOf = (type) => (DEFS[type].boss ? hi : lo + Math.floor(this.rnd() * (hi - lo + 1)));
      const px = -Math.sin(b.bearing), pz = Math.cos(b.bearing);   // tangent to the bearing
      if (b.id === 'forest') {
        camp(b.short, b.cx, b.cz, 120, midLevel, b.enemies, { respawn, levelOf });
        // forest keeps its original roster (tri-budget exception) but still gets its named rare:
        // ONE extra streamed slot, geometry shared with every other treant — not a density change.
        const fr = NAMED_RARES.forest;
        camp(b.short + '-rare', b.cx + Math.cos(b.bearing) * 90 + px * 70, b.cz + Math.sin(b.bearing) * 90 + pz * 70, 20, hi,
          [[fr.type, 1, 0, 8]], { respawn: 480 + (b.k % 5) * 60, levelOf: () => hi,
            slotOpts: { elite: true, hpMul: 2.5, name: fr.name, namedRare: true, questTag: 'rare:' + b.id } });
        continue;
      }
      const centers = [
        { name: b.short, cx: b.cx, cz: b.cz, share: 0.5 },
        { name: b.short + '-e1', cx: b.cx + px * 140, cz: b.cz + pz * 140, share: 0.25 },
        { name: b.short + '-e2', cx: b.cx - px * 140, cz: b.cz - pz * 140, share: 0.25 },
      ];
      for (const c of centers) {
        const roster = b.enemies
          .map(([type, n, r0, r1]) => [type, DEFS[type].boss ? (c.share === 0.5 ? n : 0) : Math.round(n * 1.6 * c.share), r0, r1])
          .filter(([, n]) => n > 0);
        if (roster.length) camp(c.name, c.cx, c.cz, 120, midLevel, roster, { respawn, levelOf });
      }
      // --- the region's NAMED RARE: at a POI off the pass road (the pass comes home along the radial,
      // satellites sit on the tangent — the diagonal is claimed by neither), guaranteed-legendary elite
      // on an 8-12 min clock. The name IS the content: a gold-tinted 2.5x-hp version of a roster
      // archetype the player already knows how to fight, worth walking to.
      const rare = NAMED_RARES[b.id];
      const rx = b.cx + Math.cos(b.bearing) * 90 + px * 70, rz = b.cz + Math.sin(b.bearing) * 90 + pz * 70;
      if (rare) {
        camp(b.short + '-rare', rx, rz, 20, hi, [[rare.type, 1, 0, 8]], {
          respawn: 480 + (b.k % 5) * 60,   // 8-12 min, staggered per region so two rares never share a clock
          levelOf: () => hi,
          slotOpts: { elite: true, hpMul: 2.5, name: rare.name, namedRare: true, questTag: 'rare:' + b.id },
        });
      }
      // --- roaming packs walk a real patrol ROUTE: heart -> satellite -> the rare's POI and around
      // again (~450 m loop through three places that exist), instead of milling around a midpoint.
      const roamType = b.enemies.find(([t]) => !DEFS[t].boss)?.[0] ?? b.enemies[0][0];
      for (let i = 0; i < 2; i++) {
        const sat = centers[1 + i];
        camp(b.short + '-roam' + i, (b.cx + sat.cx) / 2, (b.cz + sat.cz) / 2, 80, midLevel, [[roamType, i === 0 ? 3 : 2, 0, 80]],
          { respawn, levelOf, route: [{ x: b.cx, z: b.cz }, { x: sat.cx, z: sat.cz }, { x: rx, z: rz }] });
      }
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
    const e = this.spawn(s.type, s.pos, { level: s.level, camp: c, slot: s, ...(s.opts ?? {}) });   // slot opts: named rares (elite/hpMul/name/namedRare)
    if (e) s.enemy = e; return e;
  }

  /**
   * A lingering damage patch on the ground. Cheap by construction: a handful of records, a distance check
   * per frame, one decal + one emitter each. Capped at 8 so a long fight cannot carpet the arena.
   */
  addHazard(pos, r, dps, secs, color, element = 'solar') {
    if (this.hazards.length >= 8) this.hazards.shift();
    this.hazards.push({ x: pos.x, y: pos.y, z: pos.z, r, dps, until: this.game.time + secs, color, element, next: 0 });
    this.game.vfx?.emit?.('scorch', new THREE.Vector3(pos.x, pos.y + 0.02, pos.z), { size: r * 1.7, life: secs + 4 });
  }
  _updateHazards(dt, t) {
    const P = this.game.player;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      if (t > h.until) { this.hazards.splice(i, 1); continue; }
      if (t > h.next) {   // a puff every 0.4 s: the patch has to be visible or it is an unfair invisible trap
        h.next = t + 0.4;
        _v.set(h.x, h.y + 0.1, h.z);
        this.game.vfx?.emit?.('aether-burst', _v, { color: h.color, count: 5, scale: r6(h.r) });
      }
      const dx = P.position.x - h.x, dz = P.position.z - h.z;
      if (dx * dx + dz * dz < h.r * h.r && Math.abs(P.position.y - h.y) < 3) P.damage?.(h.dps * dt, null, { element: h.element, source: 'hazard' });
    }
  }

  // ------------------------------------------------------------------ dragon nests (wave-2: "nests are scenery")
  /**
   * Approaching a nest is an ENCOUNTER: a guardian pair of wyverns wakes on top of you and the nest
   * gives up an egg. Nest positions come from Props' egg placements (game.world.props._eggs — ASK:
   * expose this as props.nests officially), clustered into sites; if Props hasn't published them a
   * deterministic bench-ring fallback around the dragon landmark is used. A nest re-arms after 10 min.
   * Egg loot: while the 'peak-s3' collect quest is active it drops the quest egg; otherwise a
   * vendor-value uncommon. Checked at 4 Hz, dragon region only, and never under `passive` (harness).
   */
  _buildNests() {
    const out = this._nests = [];
    const eggs = this.game.world?.props?._eggs;
    if (Array.isArray(eggs) && eggs.length) {
      for (const [x, y, z] of eggs) {   // cluster: eggs sit within ~5 m of their nest centre
        const n = out.find((m) => (m.x - x) * (m.x - x) + (m.z - z) * (m.z - z) < 64);
        if (n) { n.x = (n.x * n.c + x) / (n.c + 1); n.z = (n.z * n.c + z) / (n.c + 1); n.c++; }
        else out.push({ x, y, z, c: 1, rearmAt: -1e9 });
      }
    } else {
      const b = this._dragonB, T = this.game.terrain;   // fallback: the five bench-ring bearings Props uses
      for (let n = 0; n < 5; n++) {
        const a = 0.7 + n * 1.21, x = b.cx + Math.cos(a) * 95, z = b.cz + Math.sin(a) * 95;
        out.push({ x, y: T.heightAt(x, z), z, c: 3, rearmAt: -1e9 });
      }
    }
  }
  _updateNests(t) {
    if (this.passive) return;
    const b = this._dragonB ??= OUTER.find((o) => o.id === 'dragon'); if (!b) return;
    const p = this.game.player.position;
    const dx0 = p.x - b.cx, dz0 = p.z - b.cz; if (dx0 * dx0 + dz0 * dz0 > 340 * 340) return;
    if (!this._nests) this._buildNests();
    let guards = 0; for (const e of this.list) if (e.questTag === 'nest-guard') guards++;
    for (const n of this._nests) {
      if (t < n.rearmAt) continue;
      const dx = p.x - n.x, dz = p.z - n.z;
      if (dx * dx + dz * dz > 16 * 16) continue;
      n.rearmAt = t + 600;
      if (guards < 6) {   // ponytail: flat cap on live guardians so kiting every nest can't flood the region
        const [lo, hi] = b.level;
        for (let i = 0; i < 2; i++) {
          const a = (i ? 2.6 : 0.9) + n.x * 0.01;
          const e = this.spawn('wyvern', { x: n.x + Math.sin(a) * 10, z: n.z + Math.cos(a) * 10 },
            { level: i ? lo : Math.round((lo + hi) / 2), questTag: 'nest-guard' });
          if (e) { e.alert = true; e.lastSeen.copy(this.playerPos); e.lastSeenT = t; e.home.set(n.x, e.position.y, n.z); guards++; }
        }
      }
      const rpg = this.game.rpg, pos = { x: n.x, y: n.y + 0.5, z: n.z };
      if (rpg?.quest?.active?.has?.('peak-s3')) rpg.dropQuestItem?.(pos, 'drake-egg', 'Speckled Drake Egg');
      else rpg?.dropLoot?.(pos, 'uncommon');
      this.game.hud?.toast?.('THE BROOD WAKES', { ms: 2200, kind: 'ability' });
    }
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
    // crowd LOD: a full field halves/thirds anim tick rates before the CPU budget blows (extended for the
    // higher density cap — 1.5x above 16, 2x/"halved" above 32, 3x/"thirded" above 48). 72 Hz bone posing at
    // 144 fps is invisible; motion integration + the standoff ring stay per-frame so nothing pops or clips.
    const n = this.all.length; this.crowd = n > 48 ? 3 : n > 32 ? 2 : n > 16 ? 1.5 : 1;
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
    if (this.hazards.length) this._updateHazards(dt, t);
    if (this.friendly) this._updateFriendly(dt, t);
    // respawns (cheap scan, 4x a second)
    this._respT = (this._respT ?? 0) + dt;
    if (this._respT > 0.25) {
      this._respT = 0;
      this._updateNests(t);
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
