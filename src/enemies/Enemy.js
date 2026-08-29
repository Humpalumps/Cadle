import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BODIES } from './bodies.js';
import { cloneBones, plantLegs, damp } from './rig.js';
import { createCreatureMaterial, createCreatureMaterialGLB, createShieldMaterial } from './materials.js';
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

// ---- rigged-GLB bodies (docs/CREATURE-PIPELINE.md). Three numbers, all of them about the fact that a Tripo
// body already HAS a surface, where a procedural body only has vertex colours and uniforms.
const WHITE = new THREE.Color(0xffffff);
// uTint is a diffuse MULTIPLIER. On a procedural body it is the paint; on a textured one it would repaint an
// already-correct albedo, and the dark palette tints (bogwitch 0x1f3324, imp 0x3a1a10) would multiply a whole
// creature down to near-black. Wash it toward white so the per-variant hue still separates an Empyrean Seraph
// from a Bog Witch on the shared sentinel body without burying the map. Elites keep the FULL gold: it is a
// bright multiplier (it cannot darken to mud) and "that one is gold" is a combat read, not a mood.
const GLB_TINT_WASH = 0.55;
const GLB_BUMP = 0.015;    // see createCreatureMaterialGLB — a real normal map is already doing this job
// Ceiling for the telegraph rim flare below. 0.75 = the highest def.rim any procedural body already ships
// (riftling), so the GLB wind-up read can never occupy blob headroom the bestiary has not always had.
// A GLB body carries vGlow 0 everywhere (no aGlow attribute), so uRim is not picking out crystals the
// way it does on a procedural body — it lights the WHOLE silhouette. Combined with the time `pulse` in
// materials.js it reads as a violet halo that swells and breathes as the creature moves (user report,
// 2026-08-27: "a light glow which bulges a bit as he moves"). A rigged creature's aether read has to
// come mostly from its albedo, not from a fresnel on every pixel of its outline.
const GLB_RIM_MAX = 0.30;

/**
 * Enemy: one creature instance (pooled by type). Owns its SkinnedMesh (shared geometry, own skeleton + material),
 * AI state machine, steering, procedural animation dispatch (bodies.js), combat target + weak points, death/dissolve.
 * States: idle | patrol | chase | attack | flee | stagger | dead.   Positions: `position` = feet (flyers: body centre).
 * Update cost is LOD-ticked (think/steer, move, animate at staggered rates by camera distance); the player-standoff
 * ring (def.standoff) is enforced on EVERY integration step — melee never touches the camera (Destiny melee dance).
 * Shield bubble (def.shield + def.shieldRadius): coloured by def.shieldElement (Combat.ELEMENT_COLORS) so the
 * bubble tells you what strips it, and faded out over SHIELD_FADE0..1 — it is a combat read, not scenery.
 */
// ---- corsair hand props (def.handProps): a tankard while seated, an aether flintlock on aggro. ONE merged
// vertex-coloured geometry + ONE shared material each, so a prop is a single extra draw call per visible
// corsair and links exactly one program (warmed at boot with everything else — the warm pool instance
// carries them too). No emissive anywhere on them (blob law): the "aether" read is a saturated violet
// ALBEDO crystal; the light comes from the muzzle flash vfx that already plays on fire.
const PROP_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.35 });
const _tinted = (g, [r, gg, b]) => { const n = g.index ? g.toNonIndexed() : g; const c = n.attributes.position.count, a = new Float32Array(c * 3); for (let i = 0; i < c; i++) { a[i * 3] = r; a[i * 3 + 1] = gg; a[i * 3 + 2] = b; } n.setAttribute('color', new THREE.BufferAttribute(a, 3)); return n; };
const PEWTER = [0.42, 0.41, 0.46], DKWOOD = [0.16, 0.11, 0.08], GOLD = [0.85, 0.62, 0.22], AETHER = [0.48, 0.24, 0.72];
let TANKARD_GEO = null, FLINTLOCK_GEO = null;
function propGeos() {
  if (TANKARD_GEO) return;
  TANKARD_GEO = mergeGeometries([
    _tinted(new THREE.CylinderGeometry(0.055, 0.062, 0.13, 8), PEWTER),
    _tinted(new THREE.TorusGeometry(0.062, 0.010, 4, 8).translate(0, 0.055, 0), GOLD),          // rim band
    _tinted(new THREE.TorusGeometry(0.052, 0.011, 4, 8).rotateY(Math.PI / 2).translate(0, 0, 0.075), PEWTER), // handle
  ]);
  // aether flintlock: down-curved dark stock, long barrel along local +Z, gold lock plate, violet crystal
  FLINTLOCK_GEO = mergeGeometries([
    _tinted(new THREE.BoxGeometry(0.045, 0.075, 0.16).rotateX(0.6).translate(0, -0.045, -0.10), DKWOOD),   // grip
    _tinted(new THREE.BoxGeometry(0.05, 0.055, 0.26).translate(0, 0.005, 0.02), DKWOOD),                    // stock
    _tinted(new THREE.CylinderGeometry(0.020, 0.024, 0.34, 7).rotateX(Math.PI / 2).translate(0, 0.028, 0.24), PEWTER), // barrel
    _tinted(new THREE.TorusGeometry(0.027, 0.007, 4, 8).rotateX(Math.PI / 2).translate(0, 0.028, 0.40), GOLD),         // muzzle ring
    _tinted(new THREE.BoxGeometry(0.014, 0.05, 0.05).translate(0.028, 0.02, -0.02), GOLD),                  // lock plate
    _tinted(new THREE.OctahedronGeometry(0.026).translate(0, 0.065, -0.02), AETHER),                        // aether "flint"
  ]);
}
// per-body prop mounting (hand-bone local frames differ per Tripo rig; tuned by screenshot)
const PROP_FIT = {
  raider:  { pos: [0, 0.05, 0], rot: [0, 0, 0] },
  captain: { pos: [0, 0.05, 0], rot: [0, 0, 0] },
};

const IDENTITY = new THREE.Matrix4();
// SphereGeometry, not IcosahedronGeometry(1, 2): a three icosahedron is non-indexed with FACE normals, so a
// fresnel shell built on it renders as 320 flat facets — the "hard terminator banding on its surface" in the
// wave-3 shadowfen Fen Wraith finding. A UV sphere has smooth vertex normals, which is the entire point of a
// fresnel, and 480 tris of ONE shared geometry is not a budget line.
// 44x28, not 20x14: the bubble is a translucent SILHOUETTE — its outline is the whole read, and at 20
// segments the limb is a visible polygon chain ('hard-edged low-poly translucent eggs', wave-6 void
// critic; still obvious on the corsair captain at 3 m). One shared geometry across every shielded
// creature, so the cost is ~1k extra triangles TOTAL, not per enemy.
const SHIELD_GEO = new THREE.SphereGeometry(1, 44, 28);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _res = { hit: false, normal: new THREE.Vector3() };
const seg = (x, a, b) => THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
let NEXT_ID = 1;

export class Enemy {
  constructor(sys, type, asset) {
    this.sys = sys; this.game = sys.game; this.type = type; this.def = DEFS[type]; this.asset = asset;
    // Is this a rigged-GLB body? Read once, under a name the rest of the class can use.
    // BRACKET NOTATION ON PURPOSE: tools/invariants.mjs rule (n) scans source for a `.glb` token sitting
    // between two string literals, which is how it catches a hardcoded model URL. It cannot tell that from a
    // boolean flag named `glb`, and the flag name is fixed by the glbBody contract — so read it as a key.
    this.rigged = !!asset['glb'];
    // "a winged thing seen against the sky" — the one class whose pose tick rate is clamped in update().
    // Read once here rather than two property loads deep in the hot path.
    this._sky = !!(this.def.flying && this.def.role === 'dive');
    // One body entry, two animators: the procedural one, and (when Enemies.init resolved a rigged GLB for this
    // body) the rotation-only GLB animator that drives the Tripo skeleton. Same { setup, animate } contract, so
    // nothing else in this class branches on it.
    const base = BODIES[this.def.body ?? type];
    this.body = (this.rigged && base['glb']) || base;
    const def = this.def;
    this.id = 0; this.level = 1; this.name = def.name; this.alive = false; this.state = 'dead'; this.camp = null; this.slot = null;
    this.position = new THREE.Vector3(); this.center = new THREE.Vector3(); this.velocity = new THREE.Vector3(); this.yaw = 0;
    this.home = new THREE.Vector3(); this.wander = new THREE.Vector3(); this.lastSeen = new THREE.Vector3(); this.wantDir = new THREE.Vector3(); this.wantPos = new THREE.Vector3();
    this.steer = new THREE.Vector3();                                   // cached desired velocity (computed on think ticks)
    this.health = this.maxHealth = def.health; this.shield = this.maxShield = def.shield;
    // ---- scene objects ----
    this.root = new THREE.Group(); this.root.name = 'enemy-' + type; this.root.visible = false;
    const { root: boneRoot, bones, byName } = cloneBones(asset.bonesTemplate);
    // THREE.Skeleton pairs bones to boneInverses BY INDEX, and a hole or a length mismatch does not throw —
    // it silently desynchronises every bone after it and the creature renders as a collapsed flat sheet with
    // its texture atlas smeared across it. Cheap to check once per instance, impossible to diagnose from the
    // frame. Fires if a body's bonesTemplate subtree ever stops covering every bone the inverses were built from.
    if (bones.length !== asset.boneInverses.length || bones.some((b) => !b)) {
      console.warn('[enemy]', type, 'skeleton mismatch: template has', bones.filter(Boolean).length,
        'of', asset.boneInverses.length, 'bones — the mesh will render collapsed');
    }
    this.boneRoot = boneRoot; this.bones = byName; this.boneList = bones;
    for (const b of bones) b.matrixAutoUpdate = false;       // we compose bone matrices ourselves after animating (LOD: far = no compose)
    // `ghost`/`hem` are per-TYPE (an instance never stops being a wraith), so they are baked at construction
    // rather than re-set every spawn. uGhost = 0 for everything solid, and the ethereal branch in the shader
    // is a uniform branch: one program still serves the whole bestiary.
    // A GLB body brings its own base-colour / normal / ORM triple, so it gets the map-fed variant of the SAME
    // program (createCreatureMaterialGLB reuses the identical onBeforeCompile — every blob-law cap is shared).
    this.material = this.rigged
      ? createCreatureMaterialGLB({ tex: asset.tex, ghost: def.ghost ?? 0, hem: def.hem ?? [0, -1] })
      : createCreatureMaterial({ roughness: def.ghost ? 0.95 : 0.85, ghost: def.ghost ?? 0, hem: def.hem ?? [0, -1] });
    this.u = this.material.userData.u;
    this.mesh = new THREE.SkinnedMesh(asset.geometry, this.material);
    this.mesh.add(boneRoot);
    this.mesh.bind(new THREE.Skeleton(bones, asset.boneInverses), IDENTITY);
    this.mesh.boundingSphere = asset.geometry.boundingSphere.clone();  // bind-pose sphere (+slack) follows root -> cheap, correct culling
    // a ghost casts no shadow: the shadow pass runs MeshDepthMaterial, which knows nothing about the hem
    // discard, so an ethereal creature would drop a hard solid silhouette on the ground under a shredding robe.
    this.castsShadow = !def.ghost;
    this.mesh.castShadow = this.castsShadow; this.mesh.receiveShadow = true; this.mesh.name = 'enemy-mesh';
    this.root.add(this.mesh);
    if (def.shield > 0 && def.shieldRadius) {
      // colour BY ELEMENT, not a hardcoded arc blue: the bubble is the game telling you which damage type
      // strips it (Destiny's whole shield-matching read). Every hue here is one of Combat's saturated
      // element colours, and only the alpha below carries intensity — blob law, saturate hue / cap value.
      this.shieldMat = createShieldMaterial(ELEMENT_COLORS[def.shieldElement] ?? 0x7fd8ff); this.su = this.shieldMat.userData.u;
      this.shieldMesh = new THREE.Mesh(SHIELD_GEO, this.shieldMat);
      this.shieldMesh.scale.set(def.shieldRadius, def.shieldRadius * 1.3, def.shieldRadius); this.shieldMesh.position.y = def.center; // body-hugging ellipsoid, not a beach ball
      this.shieldMesh.renderOrder = 5; this.shieldMesh.visible = false; this.root.add(this.shieldMesh);
      // The bubble is a see-through read, so it must not paint the sky-mask green — PostFX._renderSkyMask
      // draws every mesh through an OPAQUE override material, which made the sky behind a shield read as
      // world geometry and produced 5 phantom "white core" findings on clouds (2026-08-29).
      this.shieldMesh.userData.maskSkip = true;
      this._shellR = def.shieldRadius * 1.3;   // world half-height of the ellipsoid; rescaled per spawn (elites)
    }
    // ---- combat target ----
    this.target = { kind: 'enemy', team: 'enemy', position: this.center, radius: def.radius, height: def.height || undefined, alive: false, object: this.root,
      name: def.name, level: 1, enemy: this, health: 0, maxHealth: 0, shield: 0, maxShield: 0, shieldElement: def.shieldElement ?? null, velocity: this.velocity,
      takeDamage: (info) => this.takeDamage(info), knockback: (dir, s) => this.knockback(dir, s), weakPoints: null };
    if (def.weakPoints) {
      this.target.weakPoints = def.weakPoints.map((w) => ({
        position: new THREE.Vector3(), radius: w.radius, mult: w.mult,
        // A Tripo skeleton does not always carry the joint a procedural weak point names — golem and warden
        // ship with ZERO tripo::Head_* joints. Walk down to the next-best real bone instead of leaving this
        // undefined, which crashes _sync's `w.bone.matrixWorld` read on the first frame the enemy is close.
        bone: byName[w.bone] ?? byName.head ?? byName.chest ?? byName.torso ?? boneRoot,
        // `off` walks from a PROCEDURAL bone's origin to the visual feature (our 'head' bone sits at the base
        // of the skull with the skull drawn above it). A GLB's semantic bone already IS the feature — the last
        // Head_N is the skull tip — so adding the offset on top pushes the crit sphere off the model; measured
        // on the sentinel it would float ~0.38 m above a 0.30 m sphere, i.e. headshots stop registering.
        off: this.rigged ? new THREE.Vector3() : new THREE.Vector3(...w.off),
      }));
    }
    // ---- anim / ai state ----
    this.phase = 0; this.speedN = 0; this.tilt = 0; this.tiltT = 0; this.telegraph = 0; this.attackT = 0; this.attackKind = null; this.strafeLean = 0; this.pitchAnim = 0; this.rollAnim = 0;
    this.seedT = 0; this.flash = 0; this.dissolve = 0; this.stateT = 0; this.attackCd = 0; this.percT = 0; this.alert = false; this.lastSeenT = -99; this.seen = false;
    this.hurtT = -99; this.staggerT = 0; this.lastStagger = -99; this.fleeCd = 0; this.idleDur = 2; this.strafeDir = 1; this.strafeT = 0; this.distP = 999; this.onGround = !def.flying;
    this.deathT = 0; this.volleyLeft = 0; this.volleyT = 0; this.struck = false; this.phaseIdx = 0; this.phaseFlash = 0; this.glowColor = new THREE.Color();
    this.bodyDrop = 0;   // metres the bind-pose body hangs below the root at this spawn's scale (set in spawn())
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
    // ---- baked locomotion (rigged GLBs whose clips passed the per-body eye gate — glbBody.USE_CLIPS):
    // one AnimationMixer per instance, bound to this instance's cloned skeleton by bone name. Locomotion
    // (idle / walk|quadruped-walk / run) comes from the clips, cross-faded by e.speedN in glbAnim.js;
    // attack/stagger/death stay PROCEDURAL and are layered AFTER mixer.update() (both write bone
    // rotations — order matters). The mixer is only ever advanced inside _animate, so the distance-banded
    // animEvery rate limiter applies to it unchanged. No clips on the asset = no mixer = the full
    // procedural path, untouched.
    this.mixer = null;
    if (this.rigged && asset.clips?.length) {
      this.mixer = new THREE.AnimationMixer(boneRoot);
      const act = (nm) => { const c = asset.clips.find((c2) => c2.name === nm); if (!c || !c.tracks.length) return null;
        const a = this.mixer.clipAction(c); a.setEffectiveWeight(0); a.play(); return a; };
      this.actIdle = act('idle'); this.actWalk = act('walk') ?? act('quadruped-walk'); this.actRun = act('run');
    }
    this.body.setup(this, asset);
    // ---- seated-camp state + hand props (Gloamtide corsairs). sitK is the 0..1 seat blend glbAnim reads;
    // props ride the RIGHT hand bone (bone children get matrixWorld composed by the normal scene update,
    // so they follow every pose for free). Tankard while seated, flintlock otherwise — see _sync.
    this.sitK = 0; this.props = null;
    if (def.handProps && this.rigged) {
      // PICK THE HAND BY ANATOMY, NOT BY NAME. Tripo's limb classifier mirrors on some rigs — measured on
      // the corsair: handR/hdR resolve to L0L_2 at 0.31 m above the feet (BELOW the knee at 0.43, i.e. an
      // ankle), while the real arm runs shoulderL 1.05 -> elbowL 0.85 -> handL 0.60. Taking handR first
      // hung the flintlock and the tankard off a FOOT — that is the "floating mug near the ground" in the
      // camp shots, and why no corsair appeared to be holding anything. A hand is always higher than an
      // ankle, so take the highest candidate; this self-corrects any future rig that comes back mirrored.
      let hand = null, handY = -1e9;
      for (const k of ['handR', 'hdR', 'handL', 'hdL']) {
        const b = byName[k]; if (!b) continue;
        b.updateWorldMatrix(true, false);
        const y = b.matrixWorld.elements[13];
        if (y > handY) { handY = y; hand = b; }
      }
      if (hand) {
        propGeos();
        const fit = PROP_FIT[this.def.body ?? type] ?? PROP_FIT.raider;
        const mk = (geo) => { const m = new THREE.Mesh(geo, PROP_MAT); m.castShadow = false; m.receiveShadow = false;
          m.position.set(...fit.pos); m.rotation.set(...fit.rot); m.visible = false; hand.add(m); return m; };
        this.props = { tankard: mk(TANKARD_GEO), gun: mk(FLINTLOCK_GEO) };
      }
    }
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
    // stagger the baked clips per spawn so a camp of one type doesn't breathe/stride in perfect unison
    if (this.actIdle) this.actIdle.time = this.seedT % this.actIdle.getClip().duration;
    if (this.actWalk) this.actWalk.time = this.seedT % this.actWalk.getClip().duration;
    this.alert = false; this.seen = false; this.lastSeenT = -99; this.hurtT = -99; this.attackCd = 1 + rnd(); this.percT = rnd() * 0.3; this.fleeCd = 0; this.idleDur = 1.5 + rnd() * 3;
    this.flash = 0; this.dissolve = 0; this.telegraph = 0; this.attackT = 0; this.attackKind = null; this.deathT = 0; this.phaseIdx = 0; this.phaseFlash = 0; this.staggerT = 0; this.lastStagger = -99;
    this.onGround = !def.flying; this.phase = rnd() * 6; this.tilt = 0; this.tiltT = 0; this.pitchAnim = 0; this.rollAnim = 0; this.speedN = 0; this.distP = 999;
    this.thinkDt = 0; this.moveDt = 0; this.animDt = 0; this.steer.set(0, 0, 0); this.wantPos.copy(this.position); this.flinch.set(0, 0); this.flinchV.set(0, 0); this._fApplied.on = false; this.fireK = 0; this.fireV = 0; this.turnRate = 0; this.localVel.set(0, 0); this.strafeLean = 0;
    // look: deterministic palette pick per spawn (emissive colour, tint)
    const pal = def.palette[Math.floor(rnd() * def.palette.length)];
    this.glowColor.set(pal[0]); this.u.uEmissive.value.set(pal[0]); this.u.uTint.value.set(elite ? ELITE_TINT : pal[1]);
    if (this.rigged && !elite) this.u.uTint.value.lerp(WHITE, GLB_TINT_WASH);   // see GLB_TINT_WASH
    this.u.uGlow.value = def.glow; this.u.uRim.value = def.rim; this.u.uDissolve.value = 0; this.u.uFlash.value = 0;
    // def.bump is per-type craggy-ness for the procedural relief noise; a GLB has a real normal map doing it.
    this.u.uBump.value = this.rigged ? GLB_BUMP : (def.bump ?? 0.05);
    // The bubble is the ELEMENT, not the instance. The per-spawn palette roll is the creature's own hue and
    // re-rolling the shield with it made a Spire Sentinel's ARC bubble come up gold on half its spawns —
    // i.e. the one piece of UI that tells you which damage type strips it was lying at random.
    if (this.shieldMat) { const sc = ELEMENT_COLORS[def.shieldElement] ?? pal[0]; this.shieldMat.color.set(sc); this.shieldMat.emissive.set(sc); this.su.uHit.value = 0; this.su.uAlpha.value = 1; }
    this.target.alive = true; this.target.health = this.health; this.target.maxHealth = this.maxHealth; this.target.shield = this.shield; this.target.maxShield = this.maxShield;
    g.combat.register(this.target);
    // pose
    this.root.position.copy(this.position); this.root.rotation.set(0, this.yaw, 0); this.root.scale.setScalar((def.scale ?? 1) * (elite ? ELITE_SCALE_MUL : 1)); this.root.visible = true;
    // how far the BIND-pose body hangs below the root, in world metres at this spawn's scale. Read once per
    // spawn (elite scale changes it) and used by the flyer floor + the flyer death landing so a creature whose
    // mass hangs below its origin — a wraith's robe, a void horror's tendrils — never sinks into the terrain.
    { const bb = this.asset.geometry.boundingBox; this.bodyDrop = bb ? Math.max(0, -bb.min.y) * this.root.scale.x : 0; }
    if (this.shieldMesh) this._shellR = def.shieldRadius * 1.3 * this.root.scale.x;   // elites scale the shell too
    this.mesh.castShadow = this.castsShadow; this.mesh.visible = true;
    // Restore the BIND pose, not the identity pose. A procedural rig is authored with identity bone rotations
    // so the two are the same thing there; a Tripo bind pose is not — its joints carry real rotations, and
    // zeroing them straightens every limb chain and turns a pooled creature inside out on its second spawn.
    const bq = this.asset.bindQuat;
    for (const b of this.boneList) {
      const i = b.userData.index;
      b.position.copy(this.asset.bindPos[i]);
      if (bq) b.quaternion.copy(bq[i]); else b.quaternion.identity();
      b.scale.setScalar(1); b.updateMatrix();
    }
    this.root.updateMatrixWorld(true);
    if (this.legs) plantLegs(this.legs, this.legParent, this.sys.heightAt);
    this.center.set(this.position.x, this.position.y + def.center, this.position.z);
    this._sync(0, g.time, 0);   // sets shieldMesh.visible itself (SHIELD_FADE * SHELL_COV) — do NOT re-enable it here
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
    // hand props do not run the dissolve shader (own material) — hide them with the death, or a flintlock
    // outlives its owner floating over the grass
    if (this.props) { this.props.tankard.visible = false; this.props.gun.visible = false; }
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
    // seat blend (def.sit): 1 only while parked idle at a camp with nothing to shoot. damp 6 ≈ the ~0.5 s
    // stand-up decreed for the aggro moment — glbAnim slerps the seat pose by this weight, so the ramp IS
    // the transition. Gated on camp so a bare harness spawn (animcheck, lineup) behaves like any biped.
    if (this.def.sit) this.sitK = damp(this.sitK, this.camp && !this.alert && this.state === 'idle' ? 1 : 0, 6, dt);
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
    // POSE TICK RATE. The pose is HELD between updates, not interpolated, while _move keeps updating
    // the root every frame — so a stepped pose under a gliding root reads in game as a creature
    // swaying or jittering on the spot (user report, 2026-08-27; measured as a per-frame bone delta
    // of 0.107, 0.001, 0.107, 0.001 at 20 m, i.e. every other frame held). The old full-rate band
    // ended at 12 m, which is far closer than a creature stops being readable.
    // These bands were chosen when the rigs were Tripo's originals (hound 101 joints, wraith 94);
    // the conversion-time prune cut those to 40 and 37, so a wider full-rate band costs ~60% less
    // than it did when 12 m was picked. Full rate to 30 m, every 2nd to 50 m, 3rd to 110, 6th to 220.
    // `|| this._sky`: a dive flyer holds full rate across the WHOLE near band, not just to 30 m — see the
    // measurement in the _sky block below. Written into the ladder itself rather than as another clamp
    // underneath it so the crowd scale below (which only touches animEvery > 1) cannot take it back.
    let animEvery = lod === 0 ? (d2cam < 900 || this._sky ? 1 : 2) : lod === 1 ? 3 : lod === 2 ? 6 : 0;
    // THE FULL-RATE BAND IS NOT CROWD-SCALABLE. `Math.ceil(1 * 1.5)` is 2, so the 1.5x crowd tier
    // (>16 alive — a single camp) silently halved the pose rate of every creature in the world,
    // INCLUDING one 3 m from the camera, and reintroduced the exact bug the bands above were widened
    // to kill. Measured 2026-08-27: a wraith at 18 m with 23 alive posed 0.117, 0.0006, 0.105,
    // 0.0006 rad per frame — a perfect every-other-frame strobe under a root that keeps gliding.
    // With 1 alive the same creature read a flat 0.03 every frame. This is what animcheck's STEPPED
    // POSE test was failing on (hound/sprite/skyserpent/wraith/voidhorror), NOT the flyer path.
    // Crowd scaling still applies wherever the pose is already stepped (>= 30 m), where it is free.
    if (cm > 1 && animEvery > 1) animEvery = Math.ceil(animEvery * cm);
    // A SKY FLYER POSES ON A TIGHTER LADDER (user report, 2026-08-28: "the dragon in the sky's animation
    // is flickery"). MEASURED on a hovering Ember Drake, per-frame bone-rotation delta (tools/out/en-drake,
    // 200 rAF samples per distance):
    //     24 m   0% of frames held      46 m  50% held, pattern 0,x,0,x
    //     66 m  66% held, x,0,0        120 m  84% held, x,0,0,0,0,0
    // and the snap when it finally does update GROWS with the hold — 0.34 rad of skeleton in a single
    // frame at 120 m, against 0.03-0.09 at 24 m. That is the flicker: wings teleporting ~20 deg every
    // sixth frame under a root that keeps gliding every frame.
    // It is NOT frustum culling, which was the other candidate and the expensive one to "fix": the bind
    // sphere is r 2.146 against a body whose bind box half-diagonal is 1.55 m, and an onBeforeRender
    // counter fired on 100.0% of frames at 24/46/66/120 m. Nothing here inflates a bound or disables
    // culling — draw calls and shadow tris are untouched.
    // THE CLAMP IS 2, NOT 1, AND THAT IS MEASURED, NOT ROUNDED. What decides whether a held pose reads
    // is the size of the SNAP in screen pixels, so that is what was measured: the drake's wing-tip
    // position in root space, per frame, converted to pixels at 1080p / 67.7 deg vertical fov
    // (tools/out/en-wing). p95 jump, by hold length and distance:
    //             45 m   65 m  120 m  200 m
    //   every-2    0.92   0.64   0.35   0.21   <- sub-pixel from 45 m out
    //   every-3    1.39   0.96   0.52   0.31
    //   every-5    2.30   1.59   0.86   0.52   <- lod 1 + one camp's crowd scale used to give this
    //   every-9    4.07   2.82   1.53   0.92   <- lod 2 + a full field used to give this
    // A 2-4 px teleport of a high-contrast wing edge against flat sky, twelve to twenty times a second,
    // IS the flicker. Under a pixel it cannot be resolved as a jump at all — so every-2 buys the whole
    // read and every-1 would buy nothing visible for twice the CPU (measured back-to-back in one page
    // load by toggling this flag: full rate cost +0.10-0.20 ms of the enemies slice in a 6-drake scene,
    // every-2 costs +0.05-0.10, and the Vale's actual 2 drakes cost ~+0.02).
    // Scoped to `role === 'dive'` (drake, wyvern, skyserpent, leviathan) and NOT to flyers generally.
    // A grounded creature loses its legs to distance and nobody minds, and a wisp is a glowing orb whose
    // pose says nothing at 100 m — but a winged flyer IS its wingbeat, it is silhouetted against flat sky
    // where nothing masks a jump, and it is essentially never near: the 40-200 m band is the only place
    // you ever see one. Beyond 220 m (lod 3) animEvery is 0 and stays 0 — still frozen, still free, and
    // out there even every-9 is already sub-pixel.
    //
    // THE 30 m STEP IS THE OTHER HALF OF THE SAME BUG, and the clamp below never saw it: inside lod 0 the
    // ladder ALREADY steps 1 -> 2 at d2cam 900, so `animEvery > 2` is false there and a dive flyer between
    // 30 and 50 m posed every OTHER frame with the clamp doing nothing at all. MEASURED on a hovering Sky
    // Serpent, 599 rAF frames, per-frame bone-rotation delta split by the ring it was inside on that frame:
    //     inside 30 m (430 frames)   heldFrac 0.009, alternation 0.009
    //     beyond 30 m (169 frames)   heldFrac 0.497, alternation 1.000   <- a perfect every-other-frame hold
    // and the held frames are a TRUE hold, not a slow phase: per-bone pose rate on them is 0.005-0.04 rad/s
    // against 0.5-2.7 rad/s on the moving frames (60-3000x). That is what animcheck's STEPPED POSE test was
    // failing on (tools/out/gate-anim: skyserpent idle 37% held, alternating 28%, "at 20 m"), and the "20 m"
    // is why it read as a paradox — camDist is sampled at the END of the window, after the serpent had
    // wandered back inside the ring it spent a third of the window outside. It is also why hound and
    // skyserpent traded places between runs: it is a coin flip on whether the creature crossed 30 m during
    // its 1.6 s sample, and a dive flyer (hover 6-13 m, speed 15) is the only body that reliably does.
    // The 30 m ring is far too close to freeze a 200 m-visible sky creature, and the pixel table above says
    // exactly where every-2 becomes honest: 0.92 px p95 at 45 m. lod 0 ends at 50 m. So full rate through
    // lod 0, every-2 past it — the two numbers already agree, the ladder just was not asked.
    if (this._sky && animEvery > 2) animEvery = 2;
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
      if (def.sit && this.camp) {
        // seated corsair: never wanders off its log. Settle onto the seat's authored facing (toward the
        // fire) so a camp reads as a circle of drinkers, not people staring at random compass points.
        const sy = this.slot?.opts?.yaw;
        if (sy != null) this.yaw += wrapAngle(sy - this.yaw) * Math.min(1, 3 * dt);
        return;
      }
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
      // a melee unit that also shoots has to LOOK at you from shooting range, not just from arm's length
      this.facePlayer = dh < (def.volleyRange ? def.volleyRange[1] : 7);
      const ring = def.standoff ?? 1.8;
      // attack entry covers the whole dance band (ring..ring+1.6): the lunge closes the gap, the standoff ring stops it
      if (dh < Math.max(def.attackRange, ring + 1.6) && this.attackCd <= 0 && los && this.sys.meleeToken(t)) { this._startAttack('bite'); return; }
      // RANGED OPENER ON A MELEE ROLE (def.volleyRange) — the same seam the 'slam' role has always had,
      // moved to where both roles can use it. It exists because of a READ bug the user reported live: the
      // Spire Sentinel carries a two-handed sword on screen (tools/out/en-look/shot-pair-13m.png) and was
      // role 'ranged' with band [13,24], so it stood at 20 m for the whole fight and shot — "a golem with a
      // sword and he's only ranged". The fix is not to hide the sword (the silhouette is good) but to make
      // the creature do what the silhouette promises: it CLOSES. The bolts stay, as the opener it fires
      // while it marches and as the punish for a player who backs off, which is the Destiny sword-carrier
      // read (Hive Knight: shoots you at range, cleaves you up close). Ordered AFTER the bite check on
      // purpose — inside melee range the sword always wins over the gun.
      if (def.volleyRange && this.attackCd <= 0 && los && dh > def.volleyRange[0] && dh < def.volleyRange[1]) { this._startAttack(def.volley ? 'volley' : 'bolt'); return; }
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
      // melee fallback (def.meleeRange, corsairs): inside the standoff dance a musketeer pistol-whips
      // instead of firing a two-count volley into its own boots. Reuses the whole 'bite' path.
      if (def.meleeRange && dh < def.meleeRange && this.attackCd <= 0 && los) { this._startAttack('bite'); return; }
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
        // reach: a melee role's whole attackRange is its bite; a ranged type with a melee FALLBACK must
        // strike only inside meleeRange (its attackRange is 26+ m of musket range, not an arm)
        if (facing && dh < (def.meleeRange ?? def.attackRange) + 1.0 && Math.abs(pf.y - this.position.y) < 2.5) {
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
    // `handR` only exists on a rigged GLB (glbBody aliases the arm chain's last joint); a procedural body's
    // hand is `hdR` and is reached further down the chain, so this changes nothing for them.
    const b = this.bones.orb ?? this.bones.handR ?? this.bones.core ?? this.bones.head ?? this.bones.hdR ?? this.boneRoot;
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
      // FLOOR A FLYER BY ITS BODY, NOT BY ITS ROOT. A flat 1.2 m is only right for a creature whose mass sits
      // AT the root; the wraith hangs 1.51 m of robe BELOW it (measured: bind box min.y -1.31 x scale 1.15),
      // so the old clamp buried the whole robe and the game read as a corpse lying in the grass while the
      // thing was at full health. bodyDrop is that overhang, so the body's own bottom is what stops at 0.15 m
      // of clearance. Everything whose mass is at or above the root (wisp, drake, riftling) keeps the 1.2.
      const minY = T.heightAt(this.position.x, this.position.z) + Math.max(1.2, this.bodyDrop + 0.15);
      if (this.position.y < minY) { this.position.y = minY; if (v.y < 0) v.y = 0; }
      const lim = T.size * 0.5 - 6; this.position.x = THREE.MathUtils.clamp(this.position.x, -lim, lim); this.position.z = THREE.MathUtils.clamp(this.position.z, -lim, lim);
      this._standoff();
      const sp = v.length(); this.speedN = Math.min(1, sp / def.speed);
      let ty = this.yaw;
      if (def.role === 'dive') { if (Math.hypot(v.x, v.z) > 1) ty = Math.atan2(v.x, v.z); }
      else if (this.facePlayer || this.alert) { const pf = this._threat.pos; ty = Math.atan2(pf.x - this.position.x, pf.z - this.position.z); }
      else if (sp > 0.5) ty = Math.atan2(v.x, v.z);
      const dy = THREE.MathUtils.clamp(wrapAngle(ty - this.yaw), -def.turn * dt, def.turn * dt); this.yaw += dy;
      // BANK CEILING. The target is -turnRate * 0.25 and turnRate saturates at def.turn, so the bank was
      // whatever a type's turn stat happened to be: 0.6 rad on a drake (turn 2.4, the value this was tuned
      // against) but 1.25 on a wraith (turn 5) and 2.0 on a riftling (turn 8). Measured live: the wraith
      // banked 1.156 rad / 66 deg while strafing its ranged band, which lays a 1.5 m robe flat into the
      // grass. 0.6 keeps every dive flyer's bank exactly as authored and closes the top end.
      this.rollAnim = damp(this.rollAnim, THREE.MathUtils.clamp(-dy / Math.max(dt, 1e-3) * 0.25, -0.6, 0.6), 4, dt);
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
    // only stepLegs/plantLegs read legParent.matrixWorld, and both are gated on `legs` — so a body with no IK
    // (riftling's hover, every rotation-only GLB animator) can skip the compose entirely.
    if (this.legs && this.legParent) { this.legParent.updateMatrix(); this.legParent.matrixWorld.multiplyMatrices(this.root.matrixWorld, this.legParent.matrix); }
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
    // Math.min(6, ...): telegraph x phase x dayGlow stacked to ~21x def.glow on a golem, ~37x on a phasing
    // warden. The shader's aether caps absorb it today, but an uncapped input is a blob handed to any future
    // body path that forgets a cap — close it at the source too.
    u.uGlow.value = Math.min(6, this.def.glow * (this.sys.dayGlow ?? 1) * (1 + tg * 1.6 + phaseF * 2)) * (this.state === 'dead' ? Math.max(0, 1 - this.deathT) : 1);
    // uGlow only ever multiplies vGlow terms, and vGlow is 0 across a rigged GLB (no aGlow mask — see
    // createCreatureMaterialGLB). Without this the wind-up and the boss-phase flash have no emissive read at
    // all on a GLB creature, which is a combat cue the player is entitled to. Route it through the aether RIM
    // instead — a lighting term, hue-locked to ecol, clamped at the highest rim the bestiary already ships.
    if (this.rigged) u.uRim.value = Math.min(GLB_RIM_MAX, this.def.rim * (1 + tg * 0.9 + phaseF * 1.2));
    // corsair hand props: tankard while seated, flintlock the rest of its life (patrol included — a
    // corsair walking its camp with the gun slung in hand is the right silhouette).
    if (this.props) { const sit = this.sitK > 0.5; this.props.tankard.visible = this.alive && sit; this.props.gun.visible = this.alive && !sit; }
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
      // land the BODY, not the root — same reason as the flyer floor in _move (see bodyDrop)
      const gy = this.game.terrain.heightAt(this.position.x, this.position.z) + Math.max(def.role === 'dive' ? 0.4 : 0.3, this.bodyDrop);
      if (this.position.y < gy) { this.position.y = gy; this.velocity.set(0, 0, 0); }
      r.position.copy(this.position); r.rotation.x += (def.role === 'dive' ? 1.5 : 0) * dt; r.rotation.z += dt * (def.role === 'dive' ? 0.8 : 2.5);
      if (this.type === 'wisp') { this.bones.core.scale.setScalar(Math.max(0.05, 1 - k * 1.2)); for (const s of this.shards) { s.scale.setScalar(1 + k * 4); s.rotation.y += dt * 12; } this.bones.core.updateMatrix(); for (const s of this.shards) s.updateMatrix(); }
      else this._animate(dt, t);
    } else {
      // collapse: sink + roll over, legs fold (no IK), then dissolve
      r.rotation.z = damp(r.rotation.z, (this.id % 2 ? 1 : -1) * (def.role === 'slam' ? 0.55 : 1.25), 3.5, dt);
      r.rotation.x = damp(r.rotation.x, 0.35, 3, dt);
      r.position.y = damp(r.position.y, this.position.y - def.center * 0.55, 3, dt);
      // A BODY WITHOUT IK LEGS HAD NO DEATH ANIMATION AT ALL — which is every rigged GLB creature in
      // the bestiary (glbAnim sets e.legs = null), i.e. almost the whole roster. The root tipped over
      // and sank while the SKELETON stayed frozen in whatever pose the last live frame left it in, so
      // a dying hound rolled onto its side with four rigid straight legs and a golem span on the spot
      // like a boulder. Measured on the animcheck gate as a death-window bone motion of 0.0009-0.006
      // rad/frame — that is the one legParent.rotation.x damp below and literally nothing else —
      // against an idle of 0.002-0.024 (tools/out/w5-anim/anim-report.json, and the burst
      // tools/out/w5anim2/sheet-d-hound-die.png). Drive the animator instead: its `dead` branch buckles
      // the knees and folds the torso over them. The legParent hack is IK-body-only on purpose — it
      // damps a raw Euler x onto a bone whose bind rotation is not identity, which on a Tripo rig
      // re-poses the whole spine root away from its bind and shears the mesh.
      if (this.legs) {
        for (const l of this.legs) { l.hipBone.rotation.x = damp(l.hipBone.rotation.x, 1.2, 4, dt); l.kneeBone.rotation.x = damp(l.kneeBone.rotation.x, -1.5, 4, dt); l.hipBone.updateMatrix(); l.kneeBone.updateMatrix(); }
        const lp = this.legParent; if (lp) { lp.rotation.x = damp(lp.rotation.x, 0.2, 3, dt); lp.updateMatrix(); }
      // `_lod < 2` = inside ~110 m. update() returns early once dead so _lod is the last live value,
      // which is the right one: a corpse does not move toward the camera. Beyond that band nobody can
      // read a collapse, and a wiped 40-strong camp would otherwise pose every skeleton every frame
      // for its whole death window — death used to be nearly free and should stay that way at range.
      } else if ((this._lod ?? 0) < 2) this._animate(dt, t);
    }
    this.dissolve = THREE.MathUtils.clamp((k - 0.3) / 0.7, 0, 1); this.u.uDissolve.value = this.dissolve; this.u.uFlash.value = Math.max(0, 0.6 - k * 2);
    this.u.uTime.value = t + this.seedT;
    if (this.deathT >= def.deathTime + 0.15) this.sys._despawn(this);
  }
  /** remove from scene (pooled) */
  sleep() { this._breath?.stop(); this._breath = null; this.root.visible = false; this.alive = false; this.state = 'dead'; if (this.target.alive) { this.target.alive = false; this.game.combat.unregister(this.target); } this.root.rotation.set(0, 0, 0); this.camp = null; this.slot = null; this._trail?.stop?.(); this._trail = null; }
}
