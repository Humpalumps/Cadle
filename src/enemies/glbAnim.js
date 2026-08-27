import * as THREE from 'three';
import { chainWave, damp } from './rig.js';

/**
 * glbAnim: one procedural animator for every rigged Tripo creature. Same contract as a bodies.js entry
 * ({ setup(e, asset), animate(e, dt, t, A) }) so Enemy.js drives a GLB body and a procedural body identically.
 *
 * ROTATION-ONLY, AND COMPOSED ONTO THE BIND POSE. A Tripo joint's rest rotation is not identity — every bone
 * frame is aimed along its own chain — so writing `bone.rotation.x = k` would throw the limb off the body.
 * Everything here does `bone.quaternion = delta * bindQuat`, where `delta` is built about `asset.boneAxes[i][k]`
 * (world axis k expressed in that bone's parent frame, precomputed in glbBody.js). That is the one primitive
 * that makes "swing this leg about the lateral axis" a correct sentence on all twelve skeletons at once.
 *
 * ponytail: a rotation gait, not planted-foot IK. rig.js's stepLegs() cannot be reused — it writes ABSOLUTE
 * parent-local bone positions taken from the procedural bind pose, which a Tripo bind pose does not share, and
 * it needs per-creature hip/home/pole/segment-length tuning that does not exist for a generated skeleton. The
 * ceiling is visible foot sliding on slopes and at low speed. Upgrade path, in order of cost: (1) scale
 * legSwing by measured ground speed per leg so the slide is at least consistent; (2) a 2-bone analytic IK that
 * solves in each chain's OWN bind frame, reading the segment lengths straight out of asset.bindPos — that is a
 * real generalisation of stepLegs and would restore foot planting for every GLB creature at once.
 *
 * The only bone POSITION this file writes is the root bone's hover bob (flyer/hover profiles), recomputed from
 * asset.bindPos every frame so it can never drift. Rotation cannot express a vertical bob and a flyer without
 * one reads as a decal.
 */

const _q = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _m = new THREE.Matrix4();
const seg = (x, a, b) => { const k = (x - a) / (b - a); return k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k); };
const SW = (e) => (e.state === 'attack' ? e.attackT : 0);   // attack progress 0..1, strike lands at 0.35

// Per-profile tuning. Every one of these is a single scalar on purpose: the integrate pass corrects a gait
// that reads wrong by editing a number here, not by touching the code.
// bob is gated on `!e.onGround`, and onGround is `!def.flying` fixed for the creature's whole life — so this
// number reaches exactly one quadruped, the riftling (flying: true, hover 1.4). Every grounded quadruped is
// unaffected (the term multiplies by 0).
// `bank` scales Enemy._move's rollAnim (already ceilinged at 0.6 rad there). A dive flyer rolls into its turn,
// a robed ghost drifting sideways does not — the wraith was banking 66 deg and laying its robe flat in the grass.
// `airGait` = keep cycling the legs when NOT on the ground. The only creature it reaches is the riftling
// (the one `flying: true` quadruped): without it every flyer takes the airborne tuck branch for its whole life,
// which is why a four-legged crystal beast glided through its ranged band with four splayed, frozen legs.
const TUNE = {
  // legSwing 0.55 gave ~10 deg of hip swing at patrol speed and ~31 deg flat out; a real quadruped
  // swings 45-60, and at 10 deg the four legs read as a shuffle rather than a stride (user report).
  quadruped: { legSwing: 0.92, kneeBend: 1.25, footSwing: 0.45, phaseHz: 1.0, breathe: 0.030, lean: 0.28, headYaw: 0.95, headPitch: 0.55, tailAmp: 0.26, tailHz: 3.2, bob: 0.07, tuck: 0.55, bank: 0.25, airGait: 1 },
  biped:     { legSwing: 0.48, kneeBend: 1.10, footSwing: 0.30, phaseHz: 1.0, breathe: 0.026, lean: 0.22, headYaw: 1.05, headPitch: 0.55, tailAmp: 0.20, tailHz: 2.4, bob: 0, tuck: 0.35, armSwing: 0.42, bank: 0.5 },
  flyer:     { legSwing: 0.18, kneeBend: 0.60, footSwing: 0.20, phaseHz: 1.0, breathe: 0.020, lean: 0.35, headYaw: 0.90, headPitch: 0.65, tailAmp: 0.30, tailHz: 2.0, bob: 0.10, tuck: 0.85, flap: 0.62, flapHz: 3.4, bank: 1 },
  hover:     { legSwing: 0.14, kneeBend: 0.35, footSwing: 0.20, phaseHz: 1.0, breathe: 0.035, lean: 0.30, headYaw: 1.00, headPitch: 0.55, tailAmp: 0.34, tailHz: 1.3, bob: 0.08, tuck: 0.30, flap: 0.30, flapHz: 1.6, bank: 0.22 },
  serpent:   { legSwing: 0.00, kneeBend: 0.00, footSwing: 0.00, phaseHz: 1.0, breathe: 0.020, lean: 0.30, headYaw: 1.10, headPitch: 0.70, tailAmp: 0.52, tailHz: 1.8, bob: 0.09, tuck: 0, undulate: 0.9, bank: 0.7 },
};

/** bone i := bindQuat[i] rotated by `a` radians about world axis `k` (0=X lateral, 1=Y up, 2=Z forward). */
function rot(G, i, k, a, k2, a2) {
  const b = G.bones[i]; if (!b) return;
  b.quaternion.copy(G.bind[i]);
  if (a) b.quaternion.premultiply(_dq.setFromAxisAngle(G.axes[i][k], a));
  if (a2) b.quaternion.premultiply(_dq.setFromAxisAngle(G.axes[i][k2], a2));
}
/**
 * Layer a delta about world axis `k` onto whatever the MIXER already posed this frame, instead of
 * resetting to bind the way rot() does. Only sound on bones the mixer rewrites every animate frame —
 * on any other bone a premultiplied delta would accumulate frame over frame and wind the limb into a
 * pretzel — so bones without a clip track in every clip (G.tracked[i] = 0) reset to bind first,
 * which degrades exactly to rot() there. That guard is what makes the layered mode structurally safe.
 */
function radd(G, i, k, a, k2, a2) {
  const b = G.bones[i]; if (!b) return;
  if (!(G.tracked && G.tracked[i])) b.quaternion.copy(G.bind[i]);
  if (a) b.quaternion.premultiply(_dq.setFromAxisAngle(G.axes[i][k], a));
  if (a2) b.quaternion.premultiply(_dq.setFromAxisAngle(G.axes[i][k2], a2));
}

/**
 * Aim bone i's own chain direction at a world point, clamped and damped. This is rig.js's aimAt() generalised:
 * aimAt assumes the bone's local +Z is forward, which is true of every procedural rig here and of no Tripo rig
 * (their joints aim +Y down their own chain, and each one differently). Same clamped-yaw/pitch-with-slerp
 * behaviour, but the "forward" it swings is asset.boneFwd[i].
 */
function aimChain(G, i, target, maxAng, f) {   // f = slerp blend this frame (callers pass 1-exp(-k*dt) or a weight)
  const b = G.bones[i]; if (!b) return false;
  const par = b.parent; if (!par) return false;
  _m.copy(par.matrixWorld).invert();                       // one frame stale (matrices compose after animate) — fine for a damped aim
  _v.copy(target).applyMatrix4(_m).sub(b.position);
  if (_v.lengthSq() < 1e-8) return false;
  _v.normalize();
  _dq.setFromUnitVectors(G.fwd[i], _v);
  let ang = 2 * Math.acos(Math.min(1, Math.abs(_dq.w)));
  if (ang > maxAng) {                                      // clamp the swing, then slerp toward it
    _v2.set(_dq.x, _dq.y, _dq.z); const sl = _v2.length();
    if (sl > 1e-6) { _v2.multiplyScalar(1 / sl); _dq.setFromAxisAngle(_v2, _dq.w < 0 ? -maxAng : maxAng); }
    ang = maxAng;
  }
  _q.copy(G.bind[i]).premultiply(_dq);
  b.quaternion.slerp(_q, f);
  return true;
}
/** relax back to the bind pose (rig.js's relaxBone slerps to IDENTITY, which is the wrong target here). */
function relax(G, i, k, dt) { const b = G.bones[i]; if (b) b.quaternion.slerp(G.bind[i], 1 - Math.exp(-k * dt)); }

/** rig.js's chainWave, made bind-pose-safe: wave in each bone's own local frame, then compose onto the bind. */
// chainWave() ramps amplitude per segment as amp * (0.6 + i * 0.3), and those rotations are
// RELATIVE TO THE PARENT, so the tip deflection is their SUM. That ramp was tuned against the
// procedural bodies, whose tails are 3 bones — sum 2.7. A Tripo rig hands us 6 (hound) or 7
// (riftling), i.e. sum 8.1 and 10.5, so the identical tuning curled the hound's tail through ~120
// degrees, wrapped it into the haunch and tore the skin into a visible membrane between tail and
// hind leg (user report, 2026-08-27; confirmed by forcing bind pose, where the artifact vanishes).
// Normalise by the chain's own sum so total deflection is INDEPENDENT of how many joints the rig
// happened to come back with. 2.7 is the 3-segment reference every TUNE value was authored against.
const CHAIN_REF = 2.7;
const chainSum = (n) => 0.6 * n + 0.15 * n * (n - 1);      // sum of (0.6 + i*0.3), i = 0..n-1
function wave(G, ids, t, amp, freq, axis, lag, pitch) {
  const bs = G.pool; bs.length = 0;
  for (let j = 0; j < ids.length; j++) { const b = G.bones[ids[j]]; if (!b) return; b.quaternion.set(0, 0, 0, 1); bs.push(b); }
  if (!bs.length) return;
  chainWave(bs, t, amp * (CHAIN_REF / chainSum(bs.length)), freq, axis, lag);
  for (let j = 0; j < bs.length; j++) {
    // += not =: when the wave itself runs on the 'x' axis (serpent vertical undulation) an assignment
    // would erase it; every 'y'-axis caller has rotation.x at 0 here so += is identical for them.
    if (pitch) bs[j].rotation.x += pitch * (1 - j / bs.length);
    bs[j].quaternion.premultiply(G.bind[ids[j]]);
  }
}

export function glbAnimator(profile, tuning) {
  const T = { ...(TUNE[profile] ?? TUNE.biped), ...tuning };
  const flying = profile === 'flyer' || profile === 'hover' || profile === 'serpent';

  return {
    setup(e, asset) {
      const bl = e.boneList, C = asset.chains;
      const G = {
        bones: bl, bind: asset.bindQuat, axes: asset.boneAxes, fwd: asset.boneFwd, pool: [],
        spine: C.spine, neck: C.neck, tail: C.tail, root: C.root,
        // legs carry their gait phase offset: contralateral pairs move together (FL+HR, then FR+HL)
        legs: C.legs.map((c) => ({ ids: c.ids, off: (c.front === c.left) ? 0 : Math.PI, left: c.left })),
        arms: C.arms.map((c) => ({ ids: c.ids, left: c.left, lat: c.lat })),
        aux: asset.auxChains, wings: null, wingIds: null, rootY: asset.bindPos[C.root]?.y ?? 0,
        sPitch: 0,     // smoothed scalar: reading a pitch back off a composed quaternion would drift
        tracked: asset.clipTracked ?? null,   // per-bone: 1 = every clip rewrites it (radd may layer)
        aimW: 0,       // mixer path only: smoothed 0..1 head-aim blend — the clip pose is rewritten every
                       // frame, so a damped slerp FROM it never converges; blend by weight instead
        wWalk: 0, wRun: 0,   // smoothed clip weights: speedN can step ~0.3 in one frame (accel), and an
                             // unsmoothed weight snap between two unrelated clip poses is a visible pop
      };
      // Wings: the opposed pair of non-leg chains that reaches FURTHEST outboard. The drake's are unnamed Tripo
      // filler hanging off the spine, the sprite's are limb group 0 — one test finds both, no hand exceptions.
      // Ranked by reach, not by length, so a long midline chain (a neck, or the wraith's spine+arm+fingers that
      // Tripo filed as one 16-joint limb) can never win. Only 'flyer' hunts for wings: a hover creature's loose
      // chains are a robe, and the generic aux drift below is already the right motion for one.
      if (profile === 'flyer') {
        const cand = [...asset.auxChains, ...G.arms].filter((c) => c.ids.length >= 2);
        const L = cand.filter((c) => c.left), R = cand.filter((c) => !c.left);
        if (L.length && R.length) {
          const best = (a) => a.reduce((x, y) => (y.lat > x.lat ? y : x));
          G.wings = [best(L), best(R)];
          G.wingIds = new Set(G.wings.map((w) => w.ids));   // identity by the ids ARRAY: aux and arm entries are different wrappers
        }
      }
      e.ga = G; e.legs = null;                                   // no IK: Enemy._updateDeath's leg-fold branch is skipped
      e.legParent = bl[C.spine[0]] ?? bl[C.root] ?? null;
    },

    animate(e, dt, t, A) {
      const G = e.ga; if (!G) return;
      const sp = e.speedN, ph = e.phase * T.phaseHz, tt = t + e.seedT, sw = SW(e), tg = e.telegraph;
      const stag = e.state === 'stagger', dead = e.state === 'dead';
      const wind = seg(sw, 0, 0.30), strike = seg(sw, 0.30, 0.40), rec = seg(sw, 0.55, 1);

      // ---- BAKED LOCOMOTION (rigged GLBs whose clips passed the eye gate). The mixer poses the whole
      // skeleton first — idle / walk / run cross-faded by speedN — and the procedural sections below
      // LAYER onto that pose (radd) or deliberately override it (head aim, wing flap, tail, aux drift).
      // Attack/stagger/death stay procedural by decree: a baked clip cannot be cut off mid-swing, and
      // attack timing must line up with damage windows and telegraph frames.
      // `air`: a flyer holds the idle clip mid-air with the procedural tuck on top (a ground walk cycled
      // in the sky reads as treading water) — except an airGait profile (riftling), whose cycling legs
      // in flight are its authored look.
      const M = e.mixer;
      const air = M ? !e.onGround && !T.airGait : false;
      if (M) {
        if (!dead) {
          const tRun = air || !e.actRun ? 0 : seg(sp, 0.55, 0.92);
          const tWalk = air ? 0 : Math.min(1 - tRun, seg(sp, 0.03, 0.32) + (e.actRun ? 0 : seg(sp, 0.55, 0.92)));
          G.wWalk = damp(G.wWalk, tWalk, 8, dt); if (tWalk === 0 && G.wWalk < 0.008) G.wWalk = 0;   // snap to 0:
          G.wRun = damp(G.wRun, tRun, 8, dt); if (tRun === 0 && G.wRun < 0.008) G.wRun = 0;         // a weight-0
          // action is skipped by the mixer entirely, but damp() alone never reaches 0 — every idle
          // creature would evaluate its walk clip's tracks forever for an invisible contribution
          e.actIdle?.setEffectiveWeight(Math.max(0, 1 - G.wWalk - G.wRun));
          e.actWalk?.setEffectiveWeight(G.wWalk);
          e.actRun?.setEffectiveWeight(G.wRun);
          // stride rate follows the actual ground speed so the feet track the ground instead of skating
          if (e.actWalk) e.actWalk.timeScale = 0.55 + 0.85 * sp;
          if (e.actRun) e.actRun.timeScale = 0.7 + 0.5 * sp;
        }
        // keep advancing while dead too: the radd layers below compose onto a pose the mixer refreshes
        // every animate frame — on a frozen pose they would accumulate without bound.
        M.update(dt);
      }

      // ---- root: hover bob (the one position write, always recomputed from the bind pose) + turn bank
      const rb = G.bones[G.root];
      if (rb) {
        if (T.bob) rb.position.y = G.rootY + (Math.sin(tt * 1.6) * 0.7 + Math.sin(tt * 2.9) * 0.3) * T.bob * (e.onGround ? 0 : 1);
        rot(G, G.root, 2, -e.strafeLean * 0.12 - (e.rollAnim ?? 0) * (T.bank ?? 1), 1, 0);
      }

      // ---- spine: breath, gait sway, attack arc, stagger. One damped scalar drives the pitch so nothing
      // fights the additive flinch layer Enemy._react adds on top. On the mixer path the clip owns the
      // gait sway — only slope tilt, attack arc, stagger, telegraph and breath are layered on (breath
      // rides on top of the clip too: some idle clips have near-still stretches long enough to read as
      // a held pose, and a live creature breathes continuously).
      const pitchTgt = e.tilt + (e.pitchAnim ?? 0) + (M ? 0 : T.lean * (0.10 + sp * 0.35))
        - 0.55 * wind * (1 - tg * 0.3) + 0.85 * strike - 0.45 * rec + (stag ? -0.40 : 0) - tg * 0.22;
      G.sPitch = damp(G.sPitch, pitchTgt, 12, dt);
      for (let k = 0; k < G.spine.length; k++) {
        const f = 1 / Math.max(1, G.spine.length);
        // breath phase LAGS per segment (a breath travels up the torso). Not cosmetic: on a shared phase
        // every spine bone crosses its sine turnaround on the SAME frames, so a rig whose idle is mostly
        // breath (the wraith after the arm-chain trim moved its 16-joint midline chain into the spine)
        // goes near-still twice a cycle — animcheck read it as a 35%-held strobing pose at 18 m.
        const breath = Math.sin(tt * 1.7 - k * 0.7) * T.breathe * (k ? 0.4 : 1);
        if (M) { if (!dead) radd(G, G.spine[k], 0, G.sPitch * f + breath, 1, stag ? Math.sin(tt * 26) * 0.05 : 0); }
        else rot(G, G.spine[k], 0, G.sPitch * f + breath,
                           1, Math.sin(ph) * T.lean * 0.22 * sp * f + (stag ? Math.sin(tt * 26) * 0.05 : 0));
      }

      // ---- neck + head: track the player when alert, drift when not (mixer path: the clip owns the
      // idle drift; the aim OVERRIDES it by weight, because a damped slerp from a pose that is
      // rewritten every frame never converges)
      if (G.neck.length && !dead) {
        if (M) {
          G.aimW = damp(G.aimW, e.alert && A?.eye ? 1 : 0, 6, dt);
          if (G.aimW > 0.02 && A?.eye) {
            aimChain(G, G.neck[0], A.eye, T.headYaw, G.aimW);
            if (G.neck.length > 1) aimChain(G, G.neck[G.neck.length - 1], A.eye, T.headPitch, G.aimW);
          }
          if (wind || strike) for (let k = 1; k < G.neck.length; k++) radd(G, G.neck[k], 0, 0.35 * strike - 0.2 * wind);
        } else {
          const aimed = e.alert && A?.eye ? aimChain(G, G.neck[0], A.eye, T.headYaw, 1 - Math.exp(-9 * dt)) : false;
          if (!aimed) { relax(G, G.neck[0], 3, dt); }
          for (let k = 1; k < G.neck.length; k++) {
            const lead = k === G.neck.length - 1 && e.alert && A?.eye;
            if (lead) { if (!aimChain(G, G.neck[k], A.eye, T.headPitch, 1 - Math.exp(-7 * dt))) relax(G, G.neck[k], 4, dt); }
            else rot(G, G.neck[k], 0, Math.sin(tt * 1.3 + k) * 0.05 + 0.35 * strike - 0.2 * wind, 1, Math.sin(tt * 0.6 + k * 0.7) * (e.alert ? 0.06 : 0.22));
          }
        }
      }

      // ---- legs: contralateral rotation gait when grounded, tuck when airborne
      // floor raised 0.10 -> 0.34: the low end of this curve is a WALK, not a standstill, and at 0.10
      // a patrolling creature moved its legs ~3 degrees while sliding forward at 3 m/s.
      const am = T.legSwing * (0.34 + 0.66 * sp) * (stag ? 0.3 : 1);
      for (const L of G.legs) {
        const ids = L.ids, p2 = ph + L.off;
        if (M) {
          // clip owns the gait. Layer only the attack crouch, and the airborne tuck for flyers (which
          // are holding the idle clip — see `air` above).
          if (air) {
            const s2 = Math.sin(tt * 1.1 + L.off) * 0.10;
            radd(G, ids[0], 0, T.tuck * 0.6 + s2);
            for (let k = 1; k < ids.length; k++) radd(G, ids[k], 0, T.tuck * (k === 1 ? 1 : 0.5) + s2 * 0.5);
          } else if (!dead && (wind || strike)) {
            radd(G, ids[0], 0, 0.28 * wind - 0.22 * strike);
            if (ids[1] != null) radd(G, ids[1], 0, 0.35 * wind);
          }
          continue;
        }
        if ((e.onGround || T.airGait) && !dead) {
          rot(G, ids[0], 0, -am * Math.sin(p2) + 0.28 * wind - 0.22 * strike);
          if (ids[1] != null) rot(G, ids[1], 0, am * T.kneeBend * Math.max(0, Math.sin(p2 + 1.1)) + 0.35 * wind);
          for (let k = 2; k < ids.length; k++) rot(G, ids[k], 0, -am * T.footSwing * Math.sin(p2 + 2.0) / (k - 1));
        } else {
          // airborne: fold up under the body with a slow paddle so a flyer's legs are not four rigid pins
          const s2 = Math.sin(tt * 1.1 + L.off) * 0.10;
          rot(G, ids[0], 0, T.tuck * 0.6 + s2);
          for (let k = 1; k < ids.length; k++) rot(G, ids[k], 0, T.tuck * (k === 1 ? 1 : 0.5) + s2 * 0.5);
        }
      }

      // ---- arms: counter-swing to the legs, wind up and swing through on an attack.
      // TWO amplitudes, keyed to the attack the creature is actually performing. The old code drove ONE
      // haymaker (-1.35 rad wind-up, +1.55 rad strike) for EVERY attackKind, so a ranged creature threw a
      // melee arc while shooting a bolt from 20 m, and a golem's fist reached 4.08 m from its root (measured,
      // vs 2.99 at rest) — far enough to swing through the camera at its standoff ring. A ranged creature
      // now raises and braces; a melee/slam creature still swings, inside what a Tripo shoulder holds.
      // FOR THE RECORD, because it cost a diagnostic pass: the "sentinel's arm tears into a long thin gold
      // needle" verdict is NOT a skinning failure. Posing that rig at its exact bind pose with the animator
      // disabled shows the same shape — it is the sentinel's own curved greatsword held across the body
      // (tools/out/D6/shot-a-bind.png). Rotating its shoulder and elbow to 0.6 rad in isolation deforms
      // cleanly (D6 b..f). Do not "fix" it by freezing the arms.
      const melee = e.attackKind === 'bite' || e.attackKind === 'slam' || e.attackKind === 'throw';
      const aWind = melee ? 0.60 : 0.26, aStrike = melee ? 0.75 : 0.14;
      const asw = (T.armSwing ?? 0.30) * (0.10 + 0.90 * sp);
      for (const R of G.arms) {
        if (G.wingIds?.has(R.ids)) continue;
        const ids = R.ids, sgn = R.left ? 1 : -1, p2 = ph + (R.left ? Math.PI : 0);
        if (M) {
          // clip owns the counter-swing; layer only the attack wind-up / swing-through
          if (!dead && (wind || strike || rec)) {
            radd(G, ids[0], 0, -aWind * wind + aStrike * strike + 0.25 * rec, 2, sgn * (0.22 * wind - 0.15 * rec));
            if (ids[1] != null) radd(G, ids[1], 0, -(melee ? 0.55 : 0.18) * wind + (melee ? 0.40 : 0.10) * strike);
          }
          continue;
        }
        const swing = asw * Math.sin(p2) - aWind * wind + aStrike * strike + 0.25 * rec;
        rot(G, ids[0], 0, swing, 2, sgn * (0.16 + 0.22 * wind - 0.15 * rec));
        if (ids[1] != null) rot(G, ids[1], 0, -0.22 - (melee ? 0.55 : 0.18) * wind + (melee ? 0.40 : 0.10) * strike);
        for (let k = 2; k < ids.length; k++) rot(G, ids[k], 0, -0.12 + Math.sin(tt * 1.4 + k) * 0.05);
      }

      // ---- wings: beat about the forward axis, outer joints lagging so the membrane cambers
      if (G.wings) {
        const beat = Math.sin(tt * T.flapHz * (e.onGround ? 0.35 : 1)) * T.flap * (e.onGround ? 0.35 : 1) * (1 - rec * 0.5);
        for (const Wg of G.wings) {
          const sgn = Wg.left ? 1 : -1;
          Wg.ids.forEach((i, k) => {
            const lag = Math.sin(tt * T.flapHz * (e.onGround ? 0.35 : 1) - k * 0.55) * T.flap * (e.onGround ? 0.35 : 1);
            rot(G, i, 2, sgn * (k ? lag * 0.7 : beat), 1, sgn * (k ? 0 : -0.18 * tg));
          });
        }
      }

      // ---- tail / body chain
      if (G.tail.length) {
        // serpent: VERTICAL undulation ('x' = pitch wave) plus a standing body arch, not plan-view
        // snaking. Every serpent-profile creature FLIES (skyserpent, leviathan — dive role, hover
        // 6-9 m), and a flyer seen from below or the side reads its motion in the vertical plane; the
        // old horizontal S-curve read as a rigid glider AND collapsed the skeleton's vertical extent
        // to ~0.38x of def.height (animcheck SIZE fail on both). The arch is what gives the body its
        // authored dragon-glide posture — head high, body cresting — independent of the wave phase.
        if (profile === 'serpent') wave(G, G.tail, tt + ph * 0.4, T.tailAmp * (0.6 + sp * 0.8) * (T.undulate ?? 1), T.tailHz + sp * 2, 'x', 0.7, T.arch ?? 0.22);
        else wave(G, G.tail, tt + ph * 0.5, T.tailAmp * (0.7 + sp * 0.6), T.tailHz + sp * 3, 'y', 0.8, 0.16 - sp * 0.10 + (e.state === 'flee' ? -0.3 : 0));
      }

      // ---- leftover chains (robes, horns, mandibles, void tendrils): slow secondary drift so nothing on the
      // creature is frozen. Skipped for anything already driven as a wing.
      // Speed-responsive: loose parts STREAM when the body travels. A hovering wraith gliding 3 m/s
      // with a statically-drifting robe read as a decal on rails (animcheck RAILS, wraith/voidhorror
      // at motion 0.018-0.020 — the conversion prune cut the rig to 37 joints, so what deformation
      // remains has to actually move). Amplitude and rate both ride e.speedN; at rest it is exactly
      // the old slow drift.
      const aux = G.aux;
      if (aux) for (let c = 0; c < aux.length; c++) {
        const ch = aux[c];
        if (ch.ids.length < 2 || G.wingIds?.has(ch.ids)) continue;
        wave(G, ch.ids, tt * 0.55 + c, 0.07 + tg * 0.08 + sp * 0.12, 1.1 + (c % 3) * 0.3 + sp * 0.9, 'y', 0.6, 0);
      }
    },
  };
}
