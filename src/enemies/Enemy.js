import * as THREE from 'three';
import { BODIES } from './bodies.js';
import { cloneBones, plantLegs, damp } from './rig.js';
import { createCreatureMaterial, createShieldMaterial } from './materials.js';
import { DEFS, LEVEL_HP, LEVEL_DMG, LEVEL_XP } from './defs.js';
import { ELEMENT_COLORS } from '../combat/Combat.js';

// Shield bubble read range (m). A shield bubble answers ONE question — "what breaks this, and is it still
// up?" — and that question only exists inside shooting range. Past it the bubble is a translucent ball
// parked on a hillside: the wave-2 tundra verdict called them "ghost soap-bubbles stuck in the snow" at
// 60+ m. So it fades out over this band instead of being drawn on the skyline. Squared, for the hot loop.
const SHIELD_FADE0 = 28 * 28, SHIELD_FADE1 = 52 * 52;
// NEAR-SHELL COVERAGE CULL (blob decree, wave-3 dragon blocker). r/d is the sine of the shell's silhouette
// half-angle: at 0.26 it subtends ~30 deg, at 0.44 it is ~52 deg — wider than half the frame — and a
// translucent fresnel shell that covers the frame stops being a bubble and becomes a full-screen wash that
// tone-maps to cream-white (crit3-dragon-c/shot-aggro.png: 85% of the screen, scene invisible behind it).
// A melee enemy parked on its standoff ring 2.2-3.4 m from the eye is the NORMAL state of every fight, not
// an edge case, so this has to be structural: fade the shell out before it can ever fill frame, and the
// nameplate keeps carrying the "shield still up" read at that range anyway.
const SHELL_COV0 = 0.26, SHELL_COV1 = 0.44;

// Elite modifier: a lightweight reskin of an existing body for slay-a-mini-boss quest objectives and the
// loot builder's elite tier floor. Not a new creature — same rig, same AI, three numbers and a look tweak.
// The tint is a DIFFUSE multiplier (uTint, see materials.js `diffuseColor.rgb *= uTint * ...`), never the
// emissive/glow channel, so it reads as "richer, elite-coloured" without touching anything the blob law caps.
const ELITE_HP_MUL = 3.0, ELITE_DMG_MUL = 1.35, ELITE_XP_MUL = 4.0, ELITE_SCALE_MUL = 1.35;
const ELITE_TINT = new THREE.Color(0xd9a53a);   // saturated antique gold — distinguishing, diffuse only

/**
 * Enemy: one creature instance (pooled by type). Owns its SkinnedMesh (shared geometry, own skeleton + material),
 * AI state machine, steering, procedural animation dispatch (bodies.js), combat target + weak points, death/dissolve.
 * States: idle | patrol | chase | attack | flee | stagger | dead.   Positions: `position` = feet (flyers: body centre).
 * Update cost is LOD-ticked (think/steer, move, animate at staggered rates by camera distance); the player-standoff
 * ring (def.standoff) is enforced on EVERY integration step — melee never touches the camera (Destiny melee dance).
 * Shield bubble (def.shield + def.shieldRadius): coloured by def.shieldElement (Combat.ELEMENT_COLORS) so the
 * bubble tells you what strips it, and faded out over SHIELD_FADE0..1 — it is a combat read, not scenery.
 */
const IDENTITY = new THREE.Matrix4();
const SHIELD_GEO = new THREE.IcosahedronGeometry(1, 2);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _res = { hit: false, normal: new THREE.Vector3() };
const seg = (x, a, b) => THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
let NEXT_ID = 1;

export class Enemy {
  constructor(sys, type, asset) {
    this.sys = sys; this.game = sys.game; this.type = type; this.def = DEFS[type]; this.asset = asset; this.body = BODIES[this.def.body ?? type];
    const def = this.def;
    this.id = 0; this.level = 1; this.name = def.name; this.alive = false; this.state = 'dead'; this.camp = null; this.slot = null;
    this.position = new THREE.Vector3(); this.center = new THREE.Vector3(); this.velocity = new THREE.Vector3(); this.yaw = 0;
    this.home = new THREE.Vector3(); this.wander = new THREE.Vector3(); this.lastSeen = new THREE.Vector3(); this.wantDir = new THREE.Vector3(); this.wantPos = new THREE.Vector3();
    this.steer = new THREE.Vector3();                                   // cached desired velocity (computed on think ticks)
    this.health = this.maxHealth = def.health; this.shield = this.maxShield = def.shield;
    // ---- scene objects ----
    this.root = new THREE.Group(); this.root.name = 'enemy-' + type; this.root.visible = false;
    const { root: boneRoot, bones, byName } = cloneBones(asset.bonesTemplate);
    this.boneRoot = boneRoot; this.bones = byName; this.boneList = bones;
    for (const b of bones) b.matrixAutoUpdate = false;       // we compose bone matrices ourselves after animating (LOD: far = no compose)
    this.material = createCreatureMaterial({ roughness: 0.85 });
    this.u = this.material.userData.u;
    this.mesh = new THREE.SkinnedMesh(asset.geometry, this.material);
    this.mesh.add(boneRoot);
    this.mesh.bind(new THREE.Skeleton(bones, asset.boneInverses), IDENTITY);
    this.mesh.boundingSphere = asset.geometry.boundingSphere.clone();  // bind-pose sphere (+slack) follows root -> cheap, correct culling
    this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.name = 'enemy-mesh';
    this.root.add(this.mesh);
    if (def.shield > 0 && def.shieldRadius) {
      // colour BY ELEMENT, not a hardcoded arc blue: the bubble is the game telling you which damage type
      // strips it (Destiny's whole shield-matching read). Every hue here is one of Combat's saturated
      // element colours, and only the alpha below carries intensity — blob law, saturate hue / cap value.
      this.shieldMat = createShieldMaterial(ELEMENT_COLORS[def.shieldElement] ?? 0x7fd8ff); this.su = this.shieldMat.userData.u;
      this.shieldMesh = new THREE.Mesh(SHIELD_GEO, this.shieldMat);
      this.shieldMesh.scale.set(def.shieldRadius, def.shieldRadius * 1.3, def.shieldRadius); this.shieldMesh.position.y = def.center; // body-hugging ellipsoid, not a beach ball
      this.shieldMesh.renderOrder = 5; this.shieldMesh.visible = false; this.root.add(this.shieldMesh);
      this._shellR = def.shieldRadius * 1.3;   // world half-height of the ellipsoid; rescaled per spawn (elites)
    }
    // ---- combat target ----
    this.target = { kind: 'enemy', team: 'enemy', position: this.center, radius: def.radius, height: def.height || undefined, alive: false, object: this.root,
      name: def.name, level: 1, enemy: this, health: 0, maxHealth: 0, shield: 0, maxShield: 0, shieldElement: def.shieldElement ?? null, velocity: this.velocity,
      takeDamage: (info) => this.takeDamage(info), knockback: (dir, s) => this.knockback(dir, s), weakPoints: null };
    if (def.weakPoints) {
      this.target.weakPoints = def.weakPoints.map((w) => ({ position: new THREE.Vector3(), radius: w.radius, mult: w.mult, bone: byName[w.bone], off: new THREE.Vector3(...w.off) }));
    }
    // ---- anim / ai state ----
    this.phase = 0; this.speedN = 0; this.tilt = 0; this.tiltT = 0; this.telegraph = 0; this.attackT = 0; this.attackKind = null; this.strafeLean = 0; this.pitchAnim = 0; this.rollAnim = 0;
    this.seedT = 0; this.flash = 0; this.dissolve = 0; this.stateT = 0; this.attackCd = 0; this.percT = 0; this.alert = false; this.lastSeenT = -99; this.seen = false;
    this.hurtT = -99; this.staggerT = 0; this.lastStagger = -99; this.fleeCd = 0; this.idleDur = 2; this.strafeDir = 1; this.strafeT = 0; this.distP = 999; this.onGround = !def.flying;
    this.deathT = 0; this.volleyLeft = 0; this.volleyT = 0; this.struck = false; this.phaseIdx = 0; this.phaseFlash = 0; this.glowColor = new THREE.Color();
    this.thinkDt = 0; this.moveDt = 0; this.animDt = 0;
    // reactive-animation layer (see _animate): a 2-axis spring the shooter drives on every hit, plus turn banking.
    // Kept OUT of bodies.js: it is added after the body poses itself and subtracted again next frame, so a body that
    // damps toward a target never fights the layer and every creature type gets flinch for free.
    this.flinch = new THREE.Vector2(); this.flinchV = new THREE.Vector2();
    this._fApplied = { on: false, b: null, z: 0, x: 0, h: null, hz: 0, hx: 0 };   // preallocated: no per-frame garbage in the anim path
    this.fireK = 0; this.fireV = 0;                                  // per-bolt recoil: volleys used to fire with the shooter dead still
    this.turnRate = 0; this.localVel = new THREE.Vector2();
    // resolved combat target for this tick: normally the player, but generalized to "nearest of {player, the
    // escort guide}" so hostile AI can aggro the guide too (see _perceive) — one seam, reused by _think/_attack.
    this._threat = { pos: new THREE.Vector3(), feet: new THREE.Vector3(), obj: null };
    this.isGuide = false;   // true only for the escort guide instance (Enemies.spawnFriendly) — see takeDamage
    this.body.setup(this, asset);
    this._fBody = this.bones.torso ?? this.bones.body ?? this.bones.core ?? null;
    this._fHead = this.bones.head ?? this.bones.neck1 ?? this.bones.neck ?? null;
    if (this._fHead === this._fBody) this._fHead = null;
  }

  /** (re)initialise for a spawn at feet position `pos`. `elite`: scaled mini-boss modifier (see ELITE_* above);
   *  `name`: override the readable name (elite default: "Elite <def.name>"); `questTag`: opaque string quest
   *  code can match on (e.g. objectives keyed to a specific spawn, not just a type). `isGuide`: true only for
   *  the escort guide (Enemies.spawnFriendly) — routes takeDamage to _guideDamage instead of the normal AI death. */
  spawn(pos, { level = 1, camp = null, slot = null, yaw, elite = false, name = null, questTag = null, isGuide = false, hpMul = null, namedRare = false } = {}) {
    const def = this.def, g = this.game, rnd = this.sys.rnd;
    this.id = NEXT_ID++; this.level = level; this.camp = camp; this.slot = slot; this.alive = true; this.state = 'idle'; this.stateT = 0;
    this.elite = elite; this.questTag = questTag; this.isGuide = isGuide; this.namedRare = namedRare;
    this.target.team = 'enemy';   // reset every spawn: spawnFriendly flips this to 'player' AFTER calling spawn()
    // for the escort guide specifically — without this reset a pooled ex-guide instance stays immune to the
    // player's own fire forever the next time it is recycled as a normal hostile.
    // safe default before the first _perceive tick runs (percT can start > 0): threat = the player, so nothing
    // reads a stale/zero position on frame 1.
    this._threat.pos.copy(this.sys.playerPos); this._threat.obj = g.player?.target ?? null;
    this._threat.feet.copy(g.player?.position ?? this.sys.playerPos);
    this.name = name ?? (elite ? `Elite ${def.name}` : def.name); this.target.name = this.name; this.target.level = level;
    // `hpMul` overrides the elite HP multiplier when given (named rares are speced at 2.5x, not the full 3.0x)
    const hm = hpMul ?? (elite ? ELITE_HP_MUL : 1);
    this.maxHealth = Math.round(LEVEL_HP(def.health, level) * hm); this.health = this.maxHealth;
    this.maxShield = Math.round(LEVEL_HP(def.shield, level) * hm); this.shield = this.maxShield;
    this.damage = Math.round(LEVEL_DMG(def.damage, level) * (elite ? ELITE_DMG_MUL : 1));
    this.xp = Math.round(LEVEL_XP(def.xp, level) * (elite ? ELITE_XP_MUL : 1));
    this.position.copy(pos); if (!def.flying) this.position.y = g.terrain.heightAt(pos.x, pos.z); else this.position.y = g.terrain.heightAt(pos.x, pos.z) + def.hover;
    this.home.copy(this.position); this.velocity.set(0, 0, 0); this.yaw = yaw ?? rnd() * Math.PI * 2; this.seedT = rnd() * 100;
    this.alert = false; this.seen = false; this.lastSeenT = -99; this.hurtT = -99; this.attackCd = 1 + rnd(); this.percT = rnd() * 0.3; this.fleeCd = 0; this.idleDur = 1.5 + rnd() * 3;
    this.flash = 0; this.dissolve = 0; this.telegraph = 0; this.attackT = 0; this.attackKind = null; this.deathT = 0; this.phaseIdx = 0; this.phaseFlash = 0; this.staggerT = 0; this.lastStagger = -99;
    this.onGround = !def.flying; this.phase = rnd() * 6; this.tilt = 0; this.tiltT = 0; this.pitchAnim = 0; this.rollAnim = 0; this.speedN = 0; this.distP = 999;
    this.thinkDt = 0; this.moveDt = 0; this.animDt = 0; this.steer.set(0, 0, 0); this.wantPos.copy(this.position); this.flinch.set(0, 0); this.flinchV.set(0, 0); this._fApplied.on = false; this.fireK = 0; this.fireV = 0; this.turnRate = 0; this.localVel.set(0, 0); this.strafeLean = 0;
    // look: deterministic palette pick per spawn (emissive colour, tint)
    const pal = def.palette[Math.floor(rnd() * def.palette.length)];
    this.glowColor.set(pal[0]); this.u.uEmissive.value.set(pal[0]); this.u.uTint.value.set(elite ? ELITE_TINT : pal[1]);
    this.u.uGlow.value = def.glow; this.u.uRim.value = def.rim; this.u.uBump.value = def.bump ?? 0.05; this.u.uDissolve.value = 0; this.u.uFlash.value = 0;
    // The bubble is the ELEMENT, not the instance. The per-spawn palette roll is the creature's own hue and
    // re-rolling the shield with it made a Spire Sentinel's ARC bubble come up gold on half its spawns —
    // i.e. the one piece of UI that tells you which damage type strips it was lying at random.
    if (this.shieldMat) { const sc = ELEMENT_COLORS[def.shieldElement] ?? pal[0]; this.shieldMat.color.set(sc); this.shieldMat.emissive.set(sc); this.su.uHit.value = 0; this.su.uAlpha.value = 1; }
    this.target.alive = true; this.target.health = this.health; this.target.maxHealth = this.maxHealth; this.target.shield = this.shield; this.target.maxShield = this.maxShield;
    g.combat.register(this.target);
    // pose
    this.root.position.copy(this.position); this.root.rotation.set(0, this.yaw, 0); this.root.scale.setScalar((def.scale ?? 1) * (elite ? ELITE_SCALE_MUL : 1)); this.root.visible = true;
    if (this.shieldMesh) this._shellR = def.shieldRadius * 1.3 * this.root.scale.x;   // elites scale the shell too
    this.mesh.castShadow = true; this.mesh.visible = true;
    for (const b of this.boneList) { b.position.copy(this.asset.bindPos[b.userData.index]); b.quaternion.identity(); b.scale.setScalar(1); b.updateMatrix(); }
    this.root.updateMatrixWorld(true);
    if (this.legs) plantLegs(this.legs, this.legParent, this.sys.heightAt);
    this.center.set(this.position.x, this.position.y + def.center, this.position.z);
    this._sync(0, g.time, 0);
    if (this.shieldMesh) this.shieldMesh.visible = this.shield > 0;
    if (this.type === 'wisp') { this._trail?.stop?.(); this._trail = g.vfx?.attach?.('trail', this, { rate: 18, color: this.glowColor.getHex(), scale: 0.7, until: () => this.alive }); } // burning-orb motes trail
    this.game.events.emit('enemy:spawn', { enemy: this });
    return this;
  }

  // ------------------------------------------------------------------ damage / death
  takeDamage(info) {
    if (!this.alive) return;
    // escort guide: a straight-lerp follower, not a hostile AI — skip stagger/flee/blink/phase/_die entirely
    // (which would fire 'enemy:death' and trip loot/xp listeners built for a real kill) and let Enemies.js
    // own the quest-visible death instead.
    if (this.isGuide) { this._guideDamage(info); return; }
    const t = this.game.time; let a = info.amount;
    if (a <= 0) return;
    const s = Math.min(this.shield, a); this.shield -= s; a -= s;
    if (s > 0 && this.su) this.su.uHit.value = 1;
    if (s > 0 && this.shield <= 0) this._shieldBreak();
    this.health = Math.max(0, this.health - a);
    this.flash = 1; this.hurtT = t; this.alert = true; this.lastSeenT = t; this.lastSeen.copy(this.sys.playerPos); this._alertPack(t);
    // directional flinch impulse, in the creature's own frame: a shot from its right rocks it left, a shot in the
    // back pitches it forward. Bosses absorb most of it; crits hit harder. This is the read that says "that landed".
    if (info.dir) {
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const rx = info.dir.x * cy - info.dir.z * sy, fz = info.dir.x * sy + info.dir.z * cy;
      const k = Math.min(1, info.amount / this.maxHealth * 7) * (this.def.boss ? 0.3 : 1) * (info.crit ? 1.6 : 1) * 2.6;
      this.flinchV.x += rx * k; this.flinchV.y += (fz * 0.55 + 0.45) * k;
    }
    this.target.health = this.health; this.target.shield = this.shield;
    this.game.audio?.play?.('enemy-hurt', { pos: this.center, vol: 0.6 });
    if (this.health <= 0) { this._die(info.owner); return; }
    // stagger on heavy hits (fraction of max health in one hit) or weak point crits; resists chain-stagger
    const heavy = info.amount >= this.def.stagger * this.maxHealth || (info.crit && this.def.role === 'melee');
    if (heavy && t - this.lastStagger > 1.4 && this.state !== 'stagger' && !(this.def.boss && this.shield > 0)) {
      this._setState('stagger'); this.staggerT = this.def.staggerTime; this.lastStagger = t; this.telegraph = 0; this.attackKind = null;
      if (info.dir) this.velocity.addScaledVector(info.dir, this.def.flying ? 3 : 2.5); this.game.events.emit('enemy:stagger', { enemy: this });
    }
    // blink (Riftling, Void Horror): a hit teleports it, so you cannot just hold the crosshair on one.
    const sig = this.def.signature;
    if (sig?.blink && this.alive && t - (this._blinkT ?? -99) > sig.blink.cd) {
      this._blinkT = t;
      const a = this.yaw + (this.sys.rnd() < 0.5 ? 1.9 : -1.9) + (this.sys.rnd() - 0.5);
      const nx = this.position.x + Math.sin(a) * sig.blink.dist, nz = this.position.z + Math.cos(a) * sig.blink.dist;
      const g2 = this.game, k0 = this._nearK(this.center);
      if (k0 > 0.05) g2.vfx?.emit?.('aether-burst', this.center, { color: this.glowColor.getHex(), count: Math.round(5 + 9 * k0), scale: 0.9 * (0.45 + 0.55 * k0) });
      this.position.x = nx; this.position.z = nz;
      if (!this.def.flying) this.position.y = this.sys.heightAt(nx, nz);
      else this.position.y = this.sys.heightAt(nx, nz) + this.def.hover;
      this.root.position.copy(this.position); this.wantPos.copy(this.position);
      const k1 = this._nearK(this.center);
      if (k1 > 0.05) g2.vfx?.emit?.('aether-burst', this.center, { color: this.glowColor.getHex(), count: Math.round(5 + 9 * k1), scale: 0.9 * (0.45 + 0.55 * k1) });
    }
    // wisps are cowards
    if (this.def.fleeAt && this.health < this.def.fleeAt * this.maxHealth && this.fleeCd <= 0 && this.state !== 'flee') { this._setState('flee'); this.fleeCd = this.def.fleeTime + 6; }
    // warden phases: at thresholds the shield refills and a shockwave pushes the player back
    const ph = this.def.phases;
    if (ph && this.phaseIdx < ph.length && this.health <= ph[this.phaseIdx] * this.maxHealth) this._phase();
  }
  knockback(dir, s) { if (!this.alive) return; const k = this.def.boss ? 0.15 : this.def.role === 'slam' ? 0.3 : 1; this.velocity.addScaledVector(dir, s * k); if (s > 6 && k >= 1 && this.game.time - this.lastStagger > 1.4) { this._setState('stagger'); this.staggerT = this.def.staggerTime; this.lastStagger = this.game.time; } }
  /** guide-only damage path: just HP, no stagger/flinch/AI. Cleanup + the quest-visible death event is
   *  Enemies.js's job (_killFriendly) since it owns the route/tag state this instance doesn't carry. */
  _guideDamage(info) {
    const a = info.amount; if (a <= 0) return;
    this.health = Math.max(0, this.health - a); this.target.health = this.health;
    if (this.health <= 0) this.sys._killFriendly(this);
  }
  _shieldBreak() {
    const bk = this._nearK(this.center);   // point-blank shield break must not flash-bang the lens — see _nearK
    this.game.vfx?.emit?.('ring', this.center, { color: this.glowColor.getHex(), scale: (this.def.shieldRadius ?? 1) * (0.35 + 0.65 * bk) });
    this.game.vfx?.emit?.('aether-burst', this.center, { color: this.glowColor.getHex(), count: Math.round(8 + 16 * bk) });
    this.game.events.emit('enemy:shieldbreak', { enemy: this });
    if (!this.def.boss) { this._setState('stagger'); this.staggerT = 0.6; this.lastStagger = this.game.time; }
  }
  _phase() {
    this.phaseIdx++; this.shield = this.maxShield; this.target.shield = this.shield; this.phaseFlash = 1;
    this.game.combat.explode?.({ point: this.center, radius: 7, damage: 12, element: this.def.shieldElement ?? 'void', owner: this, team: 'enemy', knockback: 14, source: 'warden-phase' });
    // A boss phase pops an 8 m dome; standing next to the boss when it triggers is the NORMAL case. Visuals
    // scale with _nearK, the explode/knockback above does not.
    const pk = this._nearK(this.position);
    this.game.vfx?.shockwave?.(this.position, { radius: 8 * (0.30 + 0.70 * pk), color: this.glowColor.getHex(), duration: 0.6 });
    this.game.vfx?.emit?.('sigil', this.position, { color: this.glowColor.getHex(), scale: 3 * (0.4 + 0.6 * pk) });
    this.game.events.emit('enemy:phase', { enemy: this, phase: this.phaseIdx });
    this.attackCd = 1.2;
  }
  _die(killer) {
    this.alive = false; this.target.alive = false; this._setState('dead'); this.deathT = 0; this.telegraph = 0; this.attackKind = null; this._breath?.stop(); this._breath = null;
    this.game.combat.unregister(this.target);
    this.mesh.castShadow = false; if (this.shieldMesh) this.shieldMesh.visible = false;
    this.game.events.emit('enemy:death', { enemy: this, killer });
    this.game.audio?.play?.('enemy-death', { pos: this.center });
    this.sys._onDeath(this);
  }

  // ------------------------------------------------------------------ update (tick-rate LOD: near = full, far = staggered)
  update(dt, t, lod, frame, d2cam) {
    if (this.state === 'dead') { this._updateDeath(dt, t); return; }
    this.stateT += dt; this.attackCd -= dt; this.fleeCd -= dt;
    this.flash = Math.max(0, this.flash - dt * 6); this.phaseFlash = Math.max(0, this.phaseFlash - dt * 1.5);
    if (this.su && this.su.uHit.value > 0) this.su.uHit.value = Math.max(0, this.su.uHit.value - dt * 4);
    this._lod = lod; this._d2 = d2cam;   // squared camera distance, read by _sync (shield-bubble fade)
    // perception (throttled, staggered; far enemies look less often)
    this.percT -= dt; if (this.percT <= 0) { this.percT = (lod >= 2 ? 0.5 : 0.22) + (this.id % 7) * 0.015; this._perceive(t); }
    // decisions + steering: attack/stagger frame-accurate (strike timing is gameplay); the rest ticks by distance
    const active = this.state === 'attack' || this.state === 'stagger';
    this.thinkDt += dt;
    // crowd-scaled beyond 110 m: a hound 200 m away does not need to re-steer every frame, and a bigger
    // crowd means less of it matters that we notice late. lod 0/1 (close, in a fight) stay un-decimated
    // by crowd size — that band is where a late decision reads as the enemy standing still for a beat.
    let thinkEvery = active ? 1 : lod === 0 ? 3 : lod === 1 ? 5 : lod === 2 ? 9 : 16;
    if (!active && lod >= 2 && this.sys.crowd > 1) thinkEvery = Math.ceil(thinkEvery * this.sys.crowd);
    if (thinkEvery === 1 || (frame + this.id) % thinkEvery === 0) {
      const td = this.thinkDt; this.thinkDt = 0;
      this.distP = this.position.distanceTo(this._threat.pos);
      this.wantDir.set(0, 0, 0); this.wantSpeed = 0; this.facePlayer = false;
      this._think(td, t);
      this._steer(td, t);
    }
    // motion integration: every frame near, ticked far (far pops are invisible)
    this.moveDt += dt;
    const moveEvery = active || lod === 0 ? 1 : lod === 1 ? 2 : lod === 2 ? 3 : 6;
    if (moveEvery === 1 || (frame + this.id) % moveEvery === 0) { this._move(this.moveDt, t); this.moveDt = 0; }
    // animation (bone posing + IK): full rate only right in front of the camera, stretched when the field is crowded
    this.animDt += dt;
    const cm = this.sys.crowd;
    let animEvery = lod === 0 ? (d2cam < 144 ? 1 : d2cam < 900 ? 2 : 3) : lod === 1 ? 4 : lod === 2 ? 6 : 0;
    if (cm > 1 && animEvery) animEvery = Math.ceil(animEvery * cm);
    if (animEvery && (frame + this.id) % animEvery === 0) { this._animate(this.animDt, t); this.animDt = 0; }
    // uniform upkeep (uTime/uGlow/weak-point/shield) is invisible-stale at distance: crowd-scale it too, free.
    if (lod < 2 ? (cm === 1 || (frame + this.id) % 2 === 0) : (frame + this.id) % Math.ceil(3 * cm) === 0) this._sync(dt, t, lod);
  }

  _perceive(t) {
    const g = this.game, P = g.player;
    // A dead player used to stop perception for EVERY hostile, which was correct when the player was the
    // only possible threat. With an escort out it made the guide invulnerable for the whole
    // death-to-respawn window — the escort's only fail state switching off exactly when it is most
    // likely to fire. Keep perceiving while a guide is alive; only `passive` silences everything.
    const guideOut = !!this.sys.friendly?.enemy?.alive;
    if (this.sys.passive || (!P?.alive && !guideOut)) { this.seen = false; if (this.sys.passive || (this.alert && t - this.lastSeenT > 4)) this.alert = false; return; }
    const def = this.def;
    // threat = nearest of {player, the escort guide, if one is out}. combat.nearest(..., 'player') is reused
    // completely unmodified: the guide's target.team is flipped to 'player' on spawn (Enemies.spawnFriendly)
    // specifically so this query already returns "whichever of the two is closer" for free — that is the
    // whole of "hostile enemies should aggro it", no per-role AI rewrite. Gated on sys.friendly so the O(n)
    // combat.nearest scan only runs while an escort is actually out (rare) — every other tick, of which there
    // are far more, stays the old O(1) player-only read.
    const th = (this.sys.friendly ? g.combat.nearest(this.center, 1e9, 'player') : null) ?? P.target;
    this._threat.obj = th; this._threat.pos.copy(th.position);
    // feet: the player publishes them directly; anything else (the guide) carries its own `position`,
    // and we fall back to the centre rather than inventing an offset for a body we do not own.
    // The player publishes feet separately. Anything else (the guide) only exposes its combat centre,
    // and inventing an offset for a body we do not own would be worse than using the centre.
    this._threat.feet.copy(th === P.target ? P.position : th.position);
    const pc = this._threat.pos;
    const d = this.center.distanceTo(pc);
    let see = false;
    if (d < def.perception * (this.alert ? 1.6 : 1)) {
      // field of view (unless already alert) then line of sight through terrain/colliders
      _v.subVectors(pc, this.center); const ang = Math.atan2(_v.x, _v.z);
      if (this.alert || Math.abs(wrapAngle(ang - this.yaw)) < def.fov * 0.5 || d < 4) {
        _v.normalize(); const hit = g.combat.rayWorld?.(this.center, _v, d);
        see = !hit || hit.distance > d - 0.8;
      }
    }
    this.seen = see;
    if (see) { this.alert = true; this.lastSeen.copy(pc); this.lastSeenT = t; this._alertPack(t); }
    else if (this.alert && t - this.lastSeenT > 9 && t - this.hurtT > 9) this.alert = false;
  }
  _alertPack(t) { if (this.camp) this.camp.alertT = t; }

  /**
   * NEAR-LENS SCALE for an effect about to be spawned at world point `p` — 0 right at the eye, 1 past ~6 m.
   * THE WAVE-3 DRAGON BLOCKER LIVED HERE. A slam's shockwave is a 5-7 m additive dome and its origin is one
   * body-radius in front of a creature standing on its 3.0-3.4 m standoff ring, so the dome does not appear
   * "near the camera" — it CONTAINS the camera. Every pixel of the frame then gets an additive add, the raw
   * scene render clips to white before postfx even runs (proved with bypassPostfx: the un-composited frame
   * was already pure white), and auto-exposure drags the whole world dark for a second afterwards.
   * The same trap catches the bite burst (spawned at the jaw, ~1 m from the eye) and a phase/shield-break
   * ring on a boss you are standing next to. This is the identical rule the drake breath jet already
   * follows — cap the on-screen SIZE of anything additive as it approaches the lens — just applied to
   * every close-range effect instead of one of them. The hit, knockback, camera shake and audio are
   * untouched: only the part that would swallow the lens is pulled in.
   */
  _nearK(p) {
    const cam = this.game.camera?.position; if (!cam) return 1;
    return THREE.MathUtils.clamp((p.distanceTo(cam) - 2.0) / 4.0, 0, 1);
  }

  _setState(s) {
    // leaving the attack (staggered, killed, interrupted) stops _attack being called at all, so the breath jet has
    // to be cut here or it burns on forever with nothing left to update it
    if (s !== 'attack' && this._breath) { this._breath.stop(); this._breath = null; }
    this.state = s; this.stateT = 0;
  }
  _startAttack(kind) { this._setState('attack'); this.attackKind = kind; this.struck = false; this.telegraph = 0; this.attackT = 0; this.volleyLeft = 0; }

  _think(dt, t) {
    // pc = the threat's CENTRE (chest height), pf = its FEET. These are two different points and always
    // were: `sys.playerPos` is `player.target.position`, which Player.js sets to feet + 0.9. Collapsing
    // both onto _threat.pos moved every `pf` consumer up by 0.9 m and made melee's vertical gate
    // asymmetric — a player on a 2 m ledge became unreachable while one 2 m below became reachable to
    // 3.4 m. Keep them distinct; `_threat.feet` is maintained beside `_threat.pos` in _perceive.
    const def = this.def, g = this.game, P = g.player, pc = this._threat.pos, pf = this._threat.feet;
    const st = this.state;
    if (this.camp && !this.alert && t - this.camp.alertT < 6 && this.camp.alertT > 0) { this.alert = true; this.lastSeen.copy(pc); this.lastSeenT = t; } // pack alert
    if (st === 'stagger') { this.staggerT -= dt; if (this.staggerT <= 0) this._setState(this.alert ? 'chase' : 'idle'); return; }
    if (st === 'idle') {
      if (this.alert) { this._setState('chase'); return; }
      if (this.stateT > this.idleDur) { this._pickWander(); this._setState('patrol'); }
      if (def.flying) { this.wantPos.copy(this.position); }
      return;
    }
    if (st === 'patrol') {
      if (this.alert) { this._setState('chase'); return; }
      // routed camps (roaming packs) walk waypoint LOOPS through the region's POIs — legs are long, so
      // arrival is loose (7 m) and the timeout generous; a timeout does NOT advance the route (the next
      // patrol leg resumes the same waypoint), only a real arrival does.
      const route = this.camp?.route;
      _v.subVectors(this.wander, this.position); _v.y = 0; const d = _v.length();
      if (d < (route ? 7 : 1.2) || this.stateT > (route ? 75 : 14)) {
        if (route && d < 7) this.routeIdx = ((this.routeIdx ?? this.id) + 1) % route.length;
        this._setState('idle'); this.idleDur = route ? 0.6 + this.sys.rnd() * 1.8 : 1.5 + this.sys.rnd() * 4; return;
      }
      this.wantDir.copy(_v).multiplyScalar(1 / d); this.wantSpeed = def.speed * (def.flying ? (route ? 0.45 : 0.35) : (route ? 0.55 : 0.42));
      if (def.flying) { this.wantPos.copy(this.wander); this.wantPos.y = this.sys.heightAt(this.wander.x, this.wander.z) + def.hover; }
      return;
    }
    if (st === 'flee') {
      _v.subVectors(this.position, pc); _v.y = 0; const d = _v.length() || 1; _v.multiplyScalar(1 / d);
      this.wantDir.copy(_v); this.wantSpeed = def.speed * 1.25;
      if (def.flying) { this.wantPos.copy(this.position).addScaledVector(_v, 6); this.wantPos.y = this.sys.heightAt(this.wantPos.x, this.wantPos.z) + def.hover * 0.6; }
      if (this.stateT > def.fleeTime) this._setState('chase');
      return;
    }
    if (st === 'attack') { this._attack(dt, t); return; }
    // ---- chase (role specific) ----
    if (!this.alert) { this._setState('patrol'); this.wander.copy(this.home); return; }
    const d = this.distP, los = this.seen || t - this.lastSeenT < 0.6;
    if (!P.alive) { this._setState('patrol'); this.wander.copy(this.home); this.alert = false; return; }
    const role = def.role;
    if (role === 'melee') {
      _v.subVectors(pf, this.position); _v.y = 0; const dh = _v.length() || 1; _v.multiplyScalar(1 / dh);
      this.facePlayer = dh < 7;
      const ring = def.standoff ?? 1.8;
      // attack entry covers the whole dance band (ring..ring+1.6): the lunge closes the gap, the standoff ring stops it
      if (dh < Math.max(def.attackRange, ring + 1.6) && this.attackCd <= 0 && los && this.sys.meleeToken(t)) { this._startAttack('bite'); return; }
      if (dh < ring + 2.0) {
        // Destiny melee dance: hold just outside the standoff ring between strikes, circling the player
        this.strafeT -= dt; if (this.strafeT <= 0) { this.strafeT = 1.1 + this.sys.rnd() * 1.5; this.strafeDir = this.sys.rnd() < 0.5 ? -1 : 1; }
        _w.set(_v.z, 0, -_v.x).multiplyScalar(this.strafeDir);
        _w.addScaledVector(_v, dh < ring + 0.5 ? -0.9 : dh > ring + 1.5 ? 0.5 : 0);   // band-keeping: back off inside, close in outside
        _w.normalize(); this.wantDir.copy(_w); this.wantSpeed = def.speed * 0.42; this.facePlayer = true;
        return;
      }
      // approach: pack fans out around the player; arrive (decelerate) into the ring instead of ramming it
      if (this.camp && dh > 3) { const a = ((this.id * 2.399) % (Math.PI * 2)); _w.set(Math.sin(a), 0, Math.cos(a)).multiplyScalar(2.2); _v.copy(pf).add(_w).sub(this.position); _v.y = 0; _v.normalize(); }
      this.wantDir.copy(_v); this.wantSpeed = def.speed * THREE.MathUtils.clamp((dh - ring) / 2.5, 0.3, 1);
      return;
    }
    if (role === 'ranged') {
      const [b0, b1] = def.band; _v.subVectors(this.position, pf); _v.y = 0; const dh = _v.length() || 1; _v.multiplyScalar(1 / dh);
      this.strafeT -= dt; if (this.strafeT <= 0) { this.strafeT = 1.6 + this.sys.rnd() * 2.2; this.strafeDir = this.sys.rnd() < 0.5 ? -1 : 1; }
      _w.set(_v.z, 0, -_v.x).multiplyScalar(this.strafeDir * def.strafe);              // tangent
      if (dh < b0) _w.addScaledVector(_v, 1.2); else if (dh > b1) _w.addScaledVector(_v, -1.2); else if (!los) _w.addScaledVector(_v, -0.8);
      _w.normalize(); this.wantDir.copy(_w); this.wantSpeed = def.speed * (dh > b1 + 8 ? 1 : 0.65); this.facePlayer = true;
      this.strafeLean = damp(this.strafeLean, this.strafeDir, 3, dt);
      if (def.flying) { this.wantPos.copy(this.position).addScaledVector(_w, 4); this.wantPos.y = this.sys.heightAt(this.wantPos.x, this.wantPos.z) + def.hover + Math.sin(t * 0.7 + this.seedT) * 0.4; }
      if (d < def.attackRange && this.attackCd <= 0 && los) this._startAttack(def.volley ? 'volley' : 'bolt');
      return;
    }
    if (role === 'slam') {
      _v.subVectors(pf, this.position); _v.y = 0; const dh = _v.length() || 1; _v.multiplyScalar(1 / dh);
      const ring = def.standoff ?? 2.4;
      this.wantDir.copy(_v); this.wantSpeed = def.speed * THREE.MathUtils.clamp((dh - ring) / 3, 0, 1); this.facePlayer = dh < 9;
      if (dh < def.attackRange && this.attackCd <= 0) this._startAttack('slam');
      else if (this.attackCd <= 0 && los) {
        if (def.throwRange && dh > def.throwRange[0] && dh < def.throwRange[1]) this._startAttack('throw');
        else if (def.volleyRange && dh > def.volleyRange[0] && dh < def.volleyRange[1]) this._startAttack('volley');
      }
      return;
    }
    if (role === 'dive') {
      // orbit the player at altitude; dive when ready
      const a = t * 0.45 + this.seedT; _w.set(Math.sin(a), 0, Math.cos(a)).multiplyScalar(def.orbit);
      this.wantPos.copy(pf).add(_w); this.wantPos.y = Math.max(this.sys.heightAt(this.wantPos.x, this.wantPos.z) + def.hover, pf.y + def.hover * 0.8);
      this.wantSpeed = def.speed * 0.8;
      if (this.attackCd <= 0 && d < def.attackRange && los) this._startAttack('dive');
    }
  }
  _pickWander() {
    const route = this.camp?.route;
    if (route) {   // patrol ROUTE: head for the current waypoint of the loop (jittered so a pack doesn't stack)
      this.routeIdx = (this.routeIdx ?? this.id) % route.length;   // modulo every read: pooled instances carry a stale index
      const p = route[this.routeIdx], rnd = this.sys.rnd;
      this.wander.set(p.x + (rnd() - 0.5) * 14, 0, p.z + (rnd() - 0.5) * 14);
      this.wander.y = this.sys.heightAt(this.wander.x, this.wander.z);
      return;
    }
    const r = this.camp ? this.camp.radius : 10, rnd = this.sys.rnd, c = this.camp ? this.camp.center : this.home;
    for (let i = 0; i < 4; i++) {
      const a = rnd() * Math.PI * 2, rr = 3 + rnd() * r;
      this.wander.set(c.x + Math.sin(a) * rr, 0, c.z + Math.cos(a) * rr);
      if (this.def.flying || this.game.terrain.slopeAt(this.wander.x, this.wander.z) < 0.5) break;
    }
    this.wander.y = this.sys.heightAt(this.wander.x, this.wander.z);
  }

  /** Signature: mend — heal every ally in range on a timer. Kill the healer first, or kill nothing. */
  _mend(t) {
    const m = this.def.signature.mend;
    if (t - (this._mendT ?? -99) < m.cd) return;
    this._mendT = t;
    let any = false;
    for (const e of this.sys.list) {
      if (e === this || !e.alive || e.health >= e.maxHealth) continue;
      if (e.position.distanceToSquared(this.position) > m.r * m.r) continue;
      e.health = Math.min(e.maxHealth, e.health + e.maxHealth * m.frac); e.target.health = e.health;
      e.flash = Math.max(e.flash, 0.35); any = true;
      this.game.vfx?.emit?.('heal-motes', e.center, { count: 10, scale: 0.8 });
    }
    if (any) this.game.vfx?.emit?.('heal', this.center, { count: 16, scale: 1.2 });
  }

  _attack(dt, t) {
    const def = this.def, g = this.game, pc = this._threat.pos, pf = this._threat.feet, kind = this.attackKind, atPlayer = this._threat.obj === g.player.target;
    const wind = def.attackWindup, total = wind + def.attackRecover;
    this.attackT = this.stateT < wind ? 0.35 * this.stateT / wind : 0.35 + 0.65 * Math.min(1, (this.stateT - wind) / def.attackRecover);
    this.telegraph = this.stateT < wind ? this.stateT / wind : Math.max(0, this.telegraph - dt * 6);
    this.facePlayer = true;
    if (kind === 'dive') {
      // swoop: descend toward a point just above the player's head, strafing past; recover climbs out
      if (this.stateT < wind + 0.9) { this.wantPos.copy(pc); this.wantPos.y += 1.6; this.wantSpeed = def.speed * 1.35; }
      else { _v.subVectors(this.position, pf); _v.y = 0; _v.normalize(); this.wantPos.copy(this.position).addScaledVector(_v, 10); this.wantPos.y = this.sys.heightAt(this.wantPos.x, this.wantPos.z) + def.hover; this.wantSpeed = def.speed; }
    } else if (kind === 'bite' && this.stateT > wind * 0.6 && !this.lunged) { this.lunged = true; _v.subVectors(pf, this.position); _v.y = 0; _v.normalize(); this.velocity.addScaledVector(_v, def.lungeSpeed ?? 5); }
    else if (kind === 'bite' && this.stateT < wind * 0.6) { this.lunged = false; }
    if (!this.struck && this.stateT >= wind) {
      this.struck = true; g.events.emit('enemy:attack', { enemy: this, kind });
      const sig = def.signature;
      if (sig?.pull && atPlayer) {                       // the strike DRAGS you in: backing off is not free
        const pcv = g.player.controller;                 // player-only: the guide has no controller to pull
        _v.subVectors(this.position, pf); _v.y = 0.25; _v.normalize();
        pcv?.velocity?.addScaledVector?.(_v, sig.pull.force);
        g.vfx?.emit?.('aether-burst', this.center, { color: this.glowColor.getHex(), count: 10, scale: 0.8 });
      }
      if (kind === 'bite') {
        // the lunge is stopped at the standoff ring, so the strike reaches from there: range covers the whole dance
        // band, but only in a ~115 deg cone — you can't be bitten by a hound facing away, and sidestepping still works
        const dx = pf.x - this.position.x, dz = pf.z - this.position.z, dh = Math.hypot(dx, dz);
        const facing = Math.abs(wrapAngle(Math.atan2(dx, dz) - this.yaw)) < 1.0;
        this._muzzle(_w);
        const bk = this._nearK(_w);   // the jaw sits ~1 m from the eye at the standoff ring — see _nearK
        if (bk > 0.05) g.vfx?.emit?.('aether-burst', _w, { color: this.glowColor.getHex(), count: Math.round(3 + 5 * bk), scale: 0.6 * (0.45 + 0.55 * bk) });
        if (facing && dh < def.attackRange + 1.0 && Math.abs(pf.y - this.position.y) < 2.5) {
        this._hitThreat(this.damage, 'kinetic');
        if (sig?.chill && atPlayer) g.player.controller?.chill?.(sig.chill.secs, sig.chill.mul);   // the bite is cold: you slow down (player-only — the guide has no controller)
      }
      } else if (kind === 'slam') {
        _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); _w.copy(this.position).addScaledVector(_v, def.radius + 1.2); _w.y = this.sys.heightAt(_w.x, _w.z);
        g.combat.explode?.({ point: _w, radius: def.slamRadius, damage: this.damage, element: 'kinetic', owner: this, team: 'enemy', knockback: def.knockback, source: this.type + '-slam' });
        // VISUALS ONLY are scaled by _nearK — the explode above (damage, radius, knockback) is untouched, so
        // a slam you are standing inside hits exactly as hard; it just stops painting the whole screen white.
        const sk = this._nearK(_w);
        if (sk > 0.05) {
          g.vfx?.shockwave?.(_w, { radius: def.slamRadius * (0.30 + 0.70 * sk), color: this.glowColor.getHex(), duration: 0.5 });
          g.vfx?.emit?.('dust', _w, { count: Math.round(8 + 22 * sk), scale: 2 * (0.35 + 0.65 * sk) });
        }
        // burning/freezing ground: the slam leaves a patch, so the arena shrinks while you fight
        if (def.signature?.ground) { const gr = def.signature.ground; this.sys.addHazard?.(_w, gr.r, gr.dps, gr.secs, gr.color, gr.element); }
        const dd = _w.distanceTo(g.player.position); g.player.view?.shake?.(THREE.MathUtils.clamp(1.2 - dd / 14, 0, 0.9));   // camera shake is always keyed to the REAL player, not the threat
        g.audio?.play?.('explosion', { pos: _w, vol: 0.8 });
      } else if (kind === 'bolt') this._fireBolt(def.projectile, this.damage);
      else if (kind === 'volley') { this.volleyLeft = def.volley; this.volleyT = 0; }
      else if (kind === 'throw') this._throwRock();
      else if (kind === 'dive') { this.volleyLeft = def.volley; this.volleyT = 0; }
    }
    if (def.breath) this._breathe(def, pc, this.stateT > wind * 0.4);
    if (def.signature?.mend && this.alert) this._mend(t);
    if (this.volleyLeft > 0) { this.volleyT -= dt; if (this.volleyT <= 0) { this.volleyT = def.volleyGap; this.volleyLeft--; this._fireBolt(def.projectile, def.projectile.damage ?? this.damage, def.volleySpread ?? 0.06); } }
    if (this.stateT >= total) { this.attackCd = def.attackCooldown * (0.85 + this.sys.rnd() * 0.3); this.attackT = 0; this.telegraph = 0; this.attackKind = null; this._breathe(def, pc, false); this._setState('chase'); }
  }
  /** fire breath: one ribbon from the jaw toward the player, held open across the wind-up and the volley. */
  _breathe(def, pc, on) {
    if (!on) { if (this._breath) { this._breath.stop(); this._breath = null; } return; }
    const g = this.game;
    if (!this._breath || !this._breath.alive) {
      this._breath = g.vfx?.filaments?.spawn({ color: def.breath.color, width: def.breath.width, spread: def.breath.spread, strands: def.breath.strands }) ?? null;
      if (!this._breath) return;
    }
    const br = def.breath, jaw = this.bones.jaw ?? this.bones.head ?? this.boneRoot;
    _w.setFromMatrixPosition(jaw.matrixWorld);
    _n.subVectors(pc, _w); const d = _n.length() || 1; _n.multiplyScalar(1 / d);
    // stop the jet well SHORT of the player. Aimed straight down the lens a full-length additive ribbon covers the
    // whole frame and saturates to white — the breath has to read as fire in the world, not as a screen wash.
    const len = Math.min(br.length, Math.max(1.2, d - (br.standoff ?? 4.5)));
    this._breath.set(_w, _v.copy(_w).addScaledVector(_n, len));
    // Fade the jet out entirely as the drake closes. PostFX runs temporally-adapted auto-exposure, so a jet that
    // fills the frame does not just risk a white blob — it drags the whole scene's exposure down and the world goes
    // dark for a second afterwards. Off inside `near`, full only beyond `far`.
    const dCam = _w.distanceTo(this.game.camera.position);
    this._breath.fade((br.alpha ?? 0.8) * THREE.MathUtils.clamp((dCam - (br.near ?? 8)) / ((br.far ?? 18) - (br.near ?? 8)), 0, 1));
  }
  /** damage whatever this enemy resolved as its threat this tick — the player, or the escort guide. */
  _hitThreat(amount, element) {
    const g = this.game, th = this._threat.obj; if (!th?.alive) return;
    _n.subVectors(th.position, this.center).normalize();
    g.combat.damage(th, { amount, element, crit: false, point: th.position, normal: _v.copy(_n).negate(), dir: _n, owner: this, source: this.type });
    if (th === g.player.target) g.player.view?.flinch?.(0.6);   // screen flinch is player-only
  }
  _muzzle(out) {
    const b = this.bones.orb ?? this.bones.core ?? this.bones.head ?? this.bones.hdR ?? this.boneRoot;
    return out.setFromMatrixPosition(b.matrixWorld);
  }
  _fireBolt(pj, damage, spread = 0.05) {
    const g = this.game, pc = this._threat.pos, P = g.player, atPlayer = this._threat.obj === P.target;
    this.fireV += 3.4;                                                // kick the shooter back on every bolt of the volley
    this._muzzle(_w);
    // lead the target a little (Destiny enemies mostly miss a moving player; a bit of lead keeps them honest).
    // Player-only: the guide has no controller velocity to lead (it barely moves, no lead needed).
    _v.copy(pc).addScaledVector(atPlayer ? (P.controller?.velocity ?? _n.set(0, 0, 0)) : _n.set(0, 0, 0), 0.25).sub(_w);
    const dist = _v.length() || 1; _v.multiplyScalar(1 / dist);
    _v.x += (this.sys.rnd() - 0.5) * spread; _v.y += (this.sys.rnd() - 0.5) * spread * 0.6; _v.z += (this.sys.rnd() - 0.5) * spread; _v.normalize();
    const explode = pj.explodeRadius ? { radius: pj.explodeRadius, damage: damage * 0.8, knockback: 2 } : null;
    // NO GPU RIBBON ON A BOLT AIMED AT THE PLAYER. A filament ribbon follows its projectile, and an enemy
    // projectile ends its life AT the camera — so the ribbon is guaranteed to cross the near plane at full
    // width every single volley, and the filament shader has no near-plane fade (uAlphaMul is global). That
    // is a measured contributor to the wave-3 dragon full-frame cream-white blowout: over a 9-frame burst in
    // the crit3 repro, ribbons visible = 4 washed frames, ribbons hidden = 1 (tools/out/c1-diag3). The drake
    // and wyvern keep their fire identity through the held BREATH jet, which already fades by camera
    // distance (see _breathe), plus the bolt's own saturated colour and spark trail (`trail: !fl` below).
    // Re-enable per-bolt ribbons only once filaments fade by distance-to-camera — see the report's VFX ask.
    const fl = null;
    const pr = g.combat.projectile?.({ origin: _w, dir: _v, speed: pj.speed, damage, element: pj.element, owner: this, team: 'enemy', radius: pj.radius, life: pj.life, explode, source: this.type,
      visual: { color: this.glowColor.getHex(), size: pj.radius * 1.1, trail: !fl } });
    if (fl && pr) g.vfx?.filaments?.spawn({ color: fl.color, width: fl.width, spread: fl.spread, strands: fl.strands })?.follow(pr, fl.lag);
    // Muzzle flash: a real PointLight, and with a full camp volleying there are several alive at once. The
    // 4-config bisect in tools/out/c1-diag4 showed that zeroing the VFX flash lights alone removes the
    // full-frame cream wash (washed frames 3/5 -> 0/7), so the enemy side keeps its flash small: lower peak,
    // tighter falloff radius, and scaled down again by _nearK when the muzzle itself is at the lens.
    const mk = this._nearK(_w);
    g.vfx?.flash?.(_w, { color: this.glowColor.getHex(), intensity: 1.5 * (0.35 + 0.65 * mk), distance: 4.5, duration: 0.08 });
    if (mk > 0.05) g.vfx?.emit?.('aether-burst', _w, { color: this.glowColor.getHex(), count: Math.round(2 + 4 * mk), scale: 0.5 * (0.45 + 0.55 * mk) });
    g.audio?.play?.('enemy-shot', { pos: _w, vol: 0.7 });
  }
  _throwRock() {
    const g = this.game, pf = this._threat.feet, th = this.def.throw;
    this._muzzle(_w); _w.y += 0.5;
    _v.subVectors(pf, _w); const dy = _v.y + 1; _v.y = 0; const dx = _v.length() || 1; _v.multiplyScalar(1 / dx);
    // ballistic low-arc: sin(2θ) = d·g/v²  (clamped -> 45° lob when out of reach), plus a height correction
    const v = th.speed, s2 = THREE.MathUtils.clamp(dx * th.gravity / (v * v), -1, 1);
    const theta = 0.5 * Math.asin(s2) + Math.atan2(dy, dx) * 0.5 + 0.08;
    _v.multiplyScalar(Math.cos(theta)); _v.y = Math.sin(theta);
    g.combat.projectile?.({ origin: _w, dir: _v, speed: v, damage: th.damage, element: th.element, owner: this, team: 'enemy', radius: th.radius, gravity: th.gravity, life: th.life, source: 'golem-rock',
      explode: { radius: th.explodeRadius, damage: th.damage, knockback: 5 }, visual: { color: 0x8a7f6a, size: th.radius, trail: false, glow: 0.2 } });
    g.audio?.play?.('enemy-shot', { pos: _w, vol: 0.9, pitch: 0.5 });
  }

  // ------------------------------------------------------------------ movement / steering
  /** heavy steering (terrain probes, separation, tilt) — runs on think ticks, result cached in this.steer */
  _steer(dt, t) {
    const def = this.def, T = this.game.terrain;
    if (!def.flying) {
      _w.copy(this.wantDir).multiplyScalar(this.wantSpeed);
      if (this.wantSpeed > 0.01) {
        _v.copy(this.position).addScaledVector(this.wantDir, 1.8);
        if (T.slopeAt(_v.x, _v.z) > 0.62) { // too steep ahead: try sliding along (rotate desire +-70deg)
          _v.copy(this.position).addScaledVector(_n.set(this.wantDir.z, 0, -this.wantDir.x), 1.8);
          if (T.slopeAt(_v.x, _v.z) < 0.55) _w.set(this.wantDir.z, 0, -this.wantDir.x).multiplyScalar(this.wantSpeed * 0.7);
          else _w.set(-this.wantDir.z, 0, this.wantDir.x).multiplyScalar(this.wantSpeed * 0.7);
        }
        const wl = T.waterLevel ?? -999; _v.copy(this.position).addScaledVector(this.wantDir, 2.5);
        if (T.heightAt(_v.x, _v.z) < wl - 0.6) _w.multiplyScalar(-0.4); // don't walk into deep water
      }
      if (this.state !== 'attack') this._separate(_w);   // attackers are token-gated + standoff-clamped; skip the O(n) scan
      this.steer.copy(_w); this.steer.y = 0;
      if (this.wantSpeed > 0.01) { // slope tilt target (visual): pitch the body along the ground normal — only when actually moving
        T.normalAt(this.position.x, this.position.z, _n); _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        this.tiltT = Math.asin(THREE.MathUtils.clamp(_n.dot(_v), -0.5, 0.5)) * 0.8;
      }
    } else {
      // flyers: seek wantPos in 3D (wisp: hover band; drake: orbit/dive)
      _w.subVectors(this.wantPos, this.position); const d = _w.length();
      if (d > 0.2) _w.multiplyScalar(Math.min(this.wantSpeed || def.speed * 0.5, d * 2) / d); else _w.set(0, 0, 0);
      if (this.state === 'idle') _w.y += Math.sin(t * 1.1 + this.seedT) * 0.3;
      this._separate(_w);
      this.steer.copy(_w);
    }
  }
  /** motion integration + facing — cheap, runs (near) every frame so the standoff ring is airtight */
  _move(dt, t) {
    const def = this.def, g = this.game, T = g.terrain, v = this.velocity;
    if (!def.flying) {
      const k = 1 - Math.exp(-def.accel * dt / Math.max(1, def.speed * 0.6));
      v.x += (this.steer.x - v.x) * k; v.z += (this.steer.z - v.z) * k;
      if (this.state === 'stagger') { v.x *= Math.exp(-6 * dt); v.z *= Math.exp(-6 * dt); }
      this.position.x += v.x * dt; this.position.z += v.z * dt;
      // world bounds / colliders / hard player standoff / ground
      const lim = T.size * 0.5 - 6; this.position.x = THREE.MathUtils.clamp(this.position.x, -lim, lim); this.position.z = THREE.MathUtils.clamp(this.position.z, -lim, lim);
      const col = g.world?.colliders;
      if (col) { _v.set(this.position.x, this.position.y + def.radius + 0.1, this.position.z); if (col.resolveSphere(_v, def.radius, _res).hit) { this.position.x = _v.x; this.position.z = _v.z; } }
      this._standoff();
      const gy = T.heightAt(this.position.x, this.position.z);
      this.position.y = damp(this.position.y, gy, 18, dt); if (Math.abs(this.position.y - gy) > 1.5) this.position.y = gy;
      v.y = 0;
      // facing
      const sp = Math.hypot(v.x, v.z); this.speedN = Math.min(1, sp / def.speed);
      let ty = this.yaw;
      if (this.facePlayer || this.state === 'attack') { const pf = this._threat.pos; ty = Math.atan2(pf.x - this.position.x, pf.z - this.position.z); }
      else if (sp > 0.4) ty = Math.atan2(v.x, v.z);
      const rate = def.turn * (this.state === 'attack' ? 1.5 : 1);
      const dyaw = THREE.MathUtils.clamp(wrapAngle(ty - this.yaw), -rate * dt, rate * dt);
      this.yaw += dyaw;
      // smoothed turn rate drives the bank in _animate; body-space velocity drives strafe lean (sentinel reads it)
      this.turnRate = damp(this.turnRate, THREE.MathUtils.clamp(dyaw / Math.max(dt, 1e-3), -4, 4), 8, dt);
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      this.localVel.set((v.x * cy - v.z * sy) / def.speed, (v.x * sy + v.z * cy) / def.speed);
      this.strafeLean = damp(this.strafeLean, THREE.MathUtils.clamp(-this.localVel.x, -1, 1), 6, dt);
      this.phase += sp * dt * (def.gaitFreq ?? (2.4 / (this.gait?.stepLen ?? 0.5) * 0.5));
      this.tilt = damp(this.tilt, this.tiltT, 4, dt);
      this.center.set(this.position.x, this.position.y + def.center, this.position.z);
    } else {
      const k = 1 - Math.exp(-def.accel * dt / Math.max(1, def.speed * 0.5));
      v.lerp(this.steer, k);
      if (this.state === 'stagger') v.multiplyScalar(Math.exp(-4 * dt));
      this.position.addScaledVector(v, dt);
      const minY = T.heightAt(this.position.x, this.position.z) + 1.2; if (this.position.y < minY) { this.position.y = minY; if (v.y < 0) v.y = 0; }
      const lim = T.size * 0.5 - 6; this.position.x = THREE.MathUtils.clamp(this.position.x, -lim, lim); this.position.z = THREE.MathUtils.clamp(this.position.z, -lim, lim);
      this._standoff();
      const sp = v.length(); this.speedN = Math.min(1, sp / def.speed);
      let ty = this.yaw;
      if (def.role === 'dive') { if (Math.hypot(v.x, v.z) > 1) ty = Math.atan2(v.x, v.z); }
      else if (this.facePlayer || this.alert) { const pf = this._threat.pos; ty = Math.atan2(pf.x - this.position.x, pf.z - this.position.z); }
      else if (sp > 0.5) ty = Math.atan2(v.x, v.z);
      const dy = THREE.MathUtils.clamp(wrapAngle(ty - this.yaw), -def.turn * dt, def.turn * dt); this.yaw += dy;
      this.rollAnim = damp(this.rollAnim, -dy / Math.max(dt, 1e-3) * 0.25, 4, dt);
      this.pitchAnim = damp(this.pitchAnim, THREE.MathUtils.clamp(-v.y * 0.06, -0.6, 0.6), 4, dt);
      this.center.copy(this.position); if (def.center) this.center.y += def.center;
      this.phase += dt * 2;
    }
    this.root.position.copy(this.position); this.root.rotation.set(0, this.yaw, 0);
    if (this.def.flying && this.def.role === 'dive') { this.root.rotation.x = 0; }
  }
  /** hard minimum distance to the player: enemies NEVER cross the ring (melee stops at attack range, camera stays clear) */
  _standoff() {
    const ring = this.def.standoff; if (!ring) return;
    const P = this.game.player; if (!P) return;
    const v = this.velocity;
    if (!this.def.flying) {
      const pf = P.position;
      const dx = this.position.x - pf.x, dz = this.position.z - pf.z, d2 = dx * dx + dz * dz;
      if (d2 >= ring * ring) return;
      let nx, nz;
      if (d2 < 1e-6) { nx = Math.sin(this.yaw); nz = Math.cos(this.yaw); }        // degenerate: push out along facing
      else { const d = Math.sqrt(d2); nx = dx / d; nz = dz / d; }
      this.position.x = pf.x + nx * ring; this.position.z = pf.z + nz * ring;
      const vn = v.x * nx + v.z * nz; if (vn < 0) { v.x -= vn * nx; v.z -= vn * nz; } // kill inward velocity (lunges stop AT the ring)
    } else {
      const eye = this.sys.animCtx.eye;
      _n.subVectors(this.position, eye); const d2 = _n.lengthSq();
      if (d2 >= ring * ring) return;
      if (d2 < 1e-6) _n.set(Math.sin(this.yaw), 0.3, Math.cos(this.yaw)).normalize(); else _n.multiplyScalar(1 / Math.sqrt(d2));
      this.position.copy(eye).addScaledVector(_n, ring);
      const vn = v.dot(_n); if (vn < 0) v.addScaledVector(_n, -vn);
    }
  }
  _separate(out) {
    if (this._lod >= 2) return;                            // far camps: overlap is invisible, skip the O(n) scan
    const list = this.sys.list, L = list.length, r = this.def.radius; let n = 0;
    // ponytail: bounded rotating window instead of a full O(n²) pack scan — with 40 alive this is 18 checks/enemy
    // and any missed overlap is corrected within a few ticks. Upgrade path: uniform grid in Enemies.update if packs grow.
    const scan = L < 20 ? L : 18, i0 = L ? this.id % L : 0;
    for (let k = 0; k < scan; k++) {
      const o = list[L < 20 ? k : (i0 + k) % L]; if (o === this || !o.alive) continue;
      const dx = this.position.x - o.position.x, dz = this.position.z - o.position.z, dy = this.position.y - o.position.y;
      const min = r + o.def.radius + 0.5, d2 = dx * dx + dz * dz + (this.def.flying ? dy * dy : 0);
      if (d2 < min * min && d2 > 1e-4) { const d = Math.sqrt(d2), push = (min - d) / min * 4; out.x += dx / d * push; out.z += dz / d * push; if (this.def.flying) out.y += dy / d * push; if (++n > 4) break; }
    }
  }

  // ------------------------------------------------------------------ animation + sync
  _animate(dt, t) {
    // strip last frame's additive reaction layer so the body poses from a clean base (damp() must not chase it)
    const L = this._fApplied;
    if (L.on) { L.b.rotation.z -= L.z; L.b.rotation.x -= L.x; if (L.h) { L.h.rotation.z -= L.hz; L.h.rotation.x -= L.hx; } L.on = false; }
    // ensure the leg parent's world matrix is fresh for IK (root moved this frame)
    this.root.updateMatrix(); this.root.matrixWorld.copy(this.root.matrix);
    if (this.legParent) { this.legParent.updateMatrix(); this.legParent.matrixWorld.multiplyMatrices(this.root.matrixWorld, this.legParent.matrix); }
    this.body.animate(this, dt, t, this.sys.animCtx);
    this._react(dt);
    for (const b of this.boneList) b.updateMatrix();
  }
  /** additive reaction layer: hit-flinch spring + turn bank, applied on top of whatever bodies.js posed. */
  _react(dt) {
    const fb = this._fBody; if (!fb) return;
    const F = this.flinch, V = this.flinchV;
    if (V.x || V.y || F.x || F.y) {                                  // sub-stepped so a big hit can't blow the spring up
      const n = Math.min(5, Math.ceil(dt / 0.012)), h = dt / n, K = 165, C = 15;
      for (let i = 0; i < n; i++) { V.x += (-K * F.x - C * V.x) * h; V.y += (-K * F.y - C * V.y) * h; F.x += V.x * h; F.y += V.y * h; }
      if (Math.abs(F.x) < 2e-4 && Math.abs(F.y) < 2e-4 && Math.abs(V.x) < 2e-3 && Math.abs(V.y) < 2e-3) { F.set(0, 0); V.set(0, 0); }
    }
    if (this.fireV || this.fireK) {                                  // bolt recoil: same spring shape, one axis
      const n = Math.min(4, Math.ceil(dt / 0.014)), h = dt / n, K = 260, C = 22;
      for (let i = 0; i < n; i++) { this.fireV += (-K * this.fireK - C * this.fireV) * h; this.fireK += this.fireV * h; }
      if (Math.abs(this.fireK) < 2e-4 && Math.abs(this.fireV) < 2e-3) { this.fireK = 0; this.fireV = 0; }
    }
    // flyers already bank via rollAnim; grounded creatures lean into their turn instead of pivoting like a turret
    const bank = this.def.flying ? 0 : -this.turnRate * 0.05 * (0.35 + this.speedN * 0.65);
    const z = F.x + bank, x = F.y - this.fireK * 0.055;
    if (Math.abs(z) < 2e-4 && Math.abs(x) < 2e-4) return;   // standing still and unhurt: skip the whole layer
    fb.rotation.z += z; fb.rotation.x += x;
    const h = this._fHead, hz = h ? z * 0.55 : 0, hx = h ? x * 0.5 : 0;
    if (h) { h.rotation.z += hz; h.rotation.x += hx; }
    const L = this._fApplied; L.on = true; L.b = fb; L.z = z; L.x = x; L.h = h; L.hz = hz; L.hx = hx;
  }
  _sync(dt, t, lod) {
    if (lod >= 3) return;                                        // beyond 220 m: skip uniform/weak-point upkeep entirely
    const u = this.u;
    u.uTime.value = t + this.seedT; u.uFlash.value = this.flash * 0.8;
    const tg = this.telegraph, phaseF = this.phaseFlash;
    u.uGlow.value = this.def.glow * (this.sys.dayGlow ?? 1) * (1 + tg * 1.6 + phaseF * 2) * (this.state === 'dead' ? Math.max(0, 1 - this.deathT) : 1);
    const wps = this.target.weakPoints;
    if (wps && lod < 2) for (let i = 0; i < wps.length; i++) { const w = wps[i]; w.position.copy(w.off).applyMatrix4(w.bone.matrixWorld); }
    if (this.shieldMesh) {
      // SHIELD_FADE: full strength inside 28 m (where you are shooting it), gone by 52 m — a bubble on an
      // idle creature across a valley is scenery, and the wave-2/3 tundra verdicts both called it a soap
      // bubble stuck in the snow at ~55 m. Multiplied by the near-shell coverage cull (see SHELL_COV).
      const cam = this.game.camera.position;
      const dx = this.center.x - cam.x, dy = this.center.y - cam.y, dz = this.center.z - cam.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      const near = (1 - THREE.MathUtils.smoothstep(this._d2 ?? 0, SHIELD_FADE0, SHIELD_FADE1))
                 * (1 - THREE.MathUtils.smoothstep(this._shellR / d, SHELL_COV0, SHELL_COV1));
      const on = this.shield > 0 && this.alive && near > 0.02; this.shieldMesh.visible = on;
      if (on) { this.su.uTime.value = t; this.su.uAlpha.value = (0.45 + 0.45 * (this.shield / this.maxShield) + phaseF) * near; this.shieldMesh.rotation.y = t * 0.3; }
    }
  }
  _updateDeath(dt, t) {
    const def = this.def; this.deathT += dt; const k = this.deathT / def.deathTime;
    const r = this.root;
    if (def.flying) {
      // drop out of the sky (drake) / pop (wisp)
      this.velocity.y -= 20 * dt; this.velocity.x *= 0.98; this.velocity.z *= 0.98; this.position.addScaledVector(this.velocity, dt);
      const gy = this.game.terrain.heightAt(this.position.x, this.position.z) + (def.role === 'dive' ? 0.4 : 0.3);
      if (this.position.y < gy) { this.position.y = gy; this.velocity.set(0, 0, 0); }
      r.position.copy(this.position); r.rotation.x += (def.role === 'dive' ? 1.5 : 0) * dt; r.rotation.z += dt * (def.role === 'dive' ? 0.8 : 2.5);
      if (this.type === 'wisp') { this.bones.core.scale.setScalar(Math.max(0.05, 1 - k * 1.2)); for (const s of this.shards) { s.scale.setScalar(1 + k * 4); s.rotation.y += dt * 12; } this.bones.core.updateMatrix(); for (const s of this.shards) s.updateMatrix(); }
      else this._animate(dt, t);
    } else {
      // collapse: sink + roll over, legs fold (no IK), then dissolve
      r.rotation.z = damp(r.rotation.z, (this.id % 2 ? 1 : -1) * (def.role === 'slam' ? 0.55 : 1.25), 3.5, dt);
      r.rotation.x = damp(r.rotation.x, 0.35, 3, dt);
      r.position.y = damp(r.position.y, this.position.y - def.center * 0.55, 3, dt);
      if (this.legs) for (const l of this.legs) { l.hipBone.rotation.x = damp(l.hipBone.rotation.x, 1.2, 4, dt); l.kneeBone.rotation.x = damp(l.kneeBone.rotation.x, -1.5, 4, dt); l.hipBone.updateMatrix(); l.kneeBone.updateMatrix(); }
      const lp = this.legParent; if (lp) { lp.rotation.x = damp(lp.rotation.x, 0.2, 3, dt); lp.updateMatrix(); }
    }
    this.dissolve = THREE.MathUtils.clamp((k - 0.3) / 0.7, 0, 1); this.u.uDissolve.value = this.dissolve; this.u.uFlash.value = Math.max(0, 0.6 - k * 2);
    this.u.uTime.value = t + this.seedT;
    if (this.deathT >= def.deathTime + 0.15) this.sys._despawn(this);
  }
  /** remove from scene (pooled) */
  sleep() { this._breath?.stop(); this._breath = null; this.root.visible = false; this.alive = false; this.state = 'dead'; if (this.target.alive) { this.target.alive = false; this.game.combat.unregister(this.target); } this.root.rotation.set(0, 0, 0); this.camp = null; this.slot = null; this._trail?.stop?.(); this._trail = null; }
}
