import * as THREE from 'three';
import { Rig, prim, makeLeg, stepLegs, plantLegs, chainWave, aimAt, relaxBone, aimBone, damp } from './rig.js';
import { glbAnimator } from './glbAnim.js';
import { GLB_CFG } from './glbBody.js';

/**
 * Procedural bodies: one entry per type { build() -> rig asset, setup(e) -> per-instance anim state, animate(e, dt, t, A) }.
 * All parts authored in root space (Y up, +Z forward, root at the feet / ground contact; flyers: root at body center).
 * Bind pose = identity bones. Animations are pure procedural: sine/IK/foot planting on THREE.Bone hierarchies.
 * A = { eye:Vector3 (player eye), heightAt(x,z) }
 *
 * Twelve of the thirteen also have a RIGGED-GLB variant (`BODIES[name].glb`, bottom of this file): same
 * { setup, animate } contract, driving a Tripo skeleton whose bind pose is NOT identity. The procedural entry
 * is never removed — it is the fallback and the normalisation reference. See the RIGGED GLB VARIANTS block
 * at the bottom of this file; the per-model config itself lives in glbBody.js's GLB_CFG.
 */
const ease = (s) => s * s * (3 - 2 * s);
const pulse01 = (t, f) => Math.sin(t * f) * 0.5 + 0.5;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const SW = (e) => (e.state === 'attack' ? e.attackT : 0); // attack progress 0..1 (strike lands at 0.35)
const seg = (x, a, b) => { const k = (x - a) / (b - a); return k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k); };

/**
 * link(): one rigid segment SPANNING a -> b. Every prim whose long axis is +Y (slab/cyl/cone/limb-ish) can be
 * laid along an arbitrary direction this way, which is the only sane way to build a curve out of rigid parts.
 * The hound tail comment says why by hand ("prim.cyl is CENTRED on its origin ... mixing the two is what left
 * the tail floating off behind the hound"); this does the same arithmetic once instead of per creature, so a
 * 10-tendril swirling robe is a loop rather than 30 hand-placed magic numbers that drift apart.
 * o: any R.part option (color/glow/mottle/flat) plus { geo } to override the primitive and { w2 } for depth.
 */
const _lq = new THREE.Quaternion(), _le = new THREE.Euler(), _lv = new THREE.Vector3(), _lu = new THREE.Vector3(0, 1, 0);
function link(R, bone, a, b, w, o = {}) {
  _lv.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const L = _lv.length() || 1e-4; _lv.multiplyScalar(1 / L);
  _lq.setFromUnitVectors(_lu, _lv); _le.setFromQuaternion(_lq);            // Euler order XYZ, same as Rig.build
  R.part(bone, o.geo ?? prim.prism(o.taper ?? 0.55), {
    ...o, p: [a[0] + _lv.x * L * 0.5, a[1] + _lv.y * L * 0.5, a[2] + _lv.z * L * 0.5],
    r: [_le.x, _le.y, _le.z], s: [w, L, o.w2 ?? w],
  });
}

// ---------------------------------------------------------------- HOUND: quadruped, 4-leg planted gait, head tracking, tail
// Rebuilt from tools/out/assetgen/tripo/hound-hq.glb (concept hound-hq.webp, turntable hound-hq-render.jpg).
// Identity-defining features the reference has and the wave-1 body did not, in priority order:
//   1. SLOPED TOPLINE — withers well above the hips, hyena-shouldered. The old body was a level tube.
//   2. A CRYSTAL MANE, not back plates: a ruff of pale shards behind the skull, biggest at the shoulder,
//      running the spine and continuing along the top of the tail.
//   3. Lean predator mass: deep narrow chest, tucked waist, defined haunch — not four fat spheres.
//   4. A narrow wolf muzzle with a lipped snarl, ears swept BACK, tail carried up in an S.
// Rebuilt procedurally at 1/3 the triangles (6584 -> see the budget note in rig.js prim): the reference is
// a 57k-tri sculpt, this is a crowd enemy that can be on screen 20 at a time.
const hound = {
  build() {
    const R = new Rig(), { root } = R;
    // deep indigo-violet hide with a colder belly; shards are the aether (glow channel, capped in materials.js)
    const HIDE = 0x4a4468, HIDE2 = 0x3a3552, BELLY = 0x6f6a88, PLATE = 0x2e2b40, GLOW = 0xffffff, CLAW = 0x1c1a26;
    const body = R.bone('body', root, 0, 0.76, 0);
    // ---- torso: chest high and deep, waist tucked, croup dropping away behind
    R.part(body, prim.sphereLo(), { p: [0, 0.82, 0.30], s: [0.30, 0.33, 0.42], color: HIDE });          // rib cage (deep, a touch wider than the first pass)
    R.part(body, prim.sphereLo(), { p: [0, 0.93, 0.12], s: [0.27, 0.21, 0.32], color: HIDE });          // withers hump — the sloped topline
    R.part(body, prim.sphereLo(), { p: [0, 0.74, -0.16], s: [0.22, 0.23, 0.34], color: HIDE2 });        // tucked waist
    R.part(body, prim.sphereLo(), { p: [0, 0.72, -0.50], s: [0.27, 0.27, 0.31], color: HIDE });         // croup
    R.part(body, prim.sphereLo(), { p: [0, 0.60, 0.06], s: [0.20, 0.16, 0.48], color: BELLY, mottle: 0.12 });
    R.mirror(body, prim.sphereLo(), { p: [0.185, 0.75, -0.46], s: [0.15, 0.19, 0.21], color: HIDE });   // haunch muscle
    R.mirror(body, prim.sphereLo(), { p: [0.165, 0.86, 0.26], s: [0.11, 0.15, 0.17], color: HIDE });    // shoulder blade mass
    // No flank/scapula chitin discs here: on the narrower rebuilt torso they stood proud of the hide and read
    // as floating tiles (visible in tools/out/c1-look/shot-pair-front.png). Flank definition comes from the
    // material's `relief` bump, which is what the reference's normal map is doing anyway.
    // ---- crystal mane: DENSE at the neck/shoulder and thinning down the spine (k^1.35 spacing), which is
    // what makes it read as a mane rather than the evenly-spaced stegosaurus row the first pass produced.
    // Bases are sunk below the back line on purpose: an embedded shard is always better than a floating one.
    for (let i = 0; i < 8; i++) {
      const k = i / 7, z = 0.54 - Math.pow(k, 1.35) * 1.12, y = 1.05 - k * 0.11;
      const h = 0.36 - Math.abs(k - 0.12) * 0.30;                       // longest just behind the skull
      R.part(body, prim.crystal(), { p: [0, y + h * 0.30, z], r: [-0.62 + k * 0.62, 0, 0], s: [0.115, h, 0.10], color: GLOW, glow: 1, flat: true });
      if (i < 5) R.mirror(body, prim.crystal(), { p: [0.115 + k * 0.05, y + h * 0.16, z + 0.02], r: [-0.30, 0, 0.80], s: [0.085, h * 0.78, 0.08], color: GLOW, glow: 0.85, flat: true });
      if (i < 3) R.mirror(body, prim.crystal(), { p: [0.175 - k * 0.10, y - 0.03, z + 0.03], r: [-0.25, 0, 1.10], s: [0.07, h * 0.52, 0.065], color: GLOW, glow: 0.8, flat: true });
    }
    // ---- neck / head / jaw
    const neck = R.bone('neck', body, 0, 0.14, 0.6);
    R.part(neck, prim.limb(0.85), { p: [0, 1.10, 0.74], r: [-1.02, 0, 0], s: [0.125, 0.32, 0.14], color: HIDE });
    R.part(neck, prim.hex(), { p: [0, 1.02, 0.66], r: [-0.5, 0, 0], s: [0.19, 0.05, 0.20], color: HIDE2, mottle: 0.14, flat: true });   // neck ruff base
    const head = R.bone('head', neck, 0, 0.15, 0.26);
    R.part(head, prim.sphereLo(), { p: [0, 1.09, 0.89], s: [0.155, 0.15, 0.20], color: HIDE });                                          // narrow skull
    // slab's long axis is local +Y; rotating -1.45 about X lays it along -Z and points its NARROW end
    // forward-and-slightly-down, which is the whole difference between a wolf muzzle and a pug snout.
    R.part(head, prim.slab(0.60), { p: [0, 1.045, 1.11], r: [-1.45, 0, 0], s: [0.145, 0.30, 0.115], color: HIDE, mottle: 0.16 });
    R.part(head, prim.octa(), { p: [0, 1.055, 1.27], s: [0.05, 0.042, 0.042], color: CLAW, flat: true });                                 // nose leather
    R.part(head, prim.hex(), { p: [0, 1.115, 1.06], r: [1.66, 0, 0], s: [0.055, 0.24, 0.05], color: PLATE, mottle: 0.1, flat: true });    // nasal ridge
    R.mirror(head, prim.hex(), { p: [0.078, 1.155, 1.00], r: [0.28, 0, 0.92], s: [0.075, 0.04, 0.15], color: PLATE, mottle: 0.1, flat: true });  // brow
    R.mirror(head, prim.hex(), { p: [0.105, 1.055, 0.98], r: [0.15, 0, 1.28], s: [0.075, 0.045, 0.15], color: HIDE2, mottle: 0.12, flat: true }); // cheek
    R.mirror(head, prim.octa(), { p: [0.085, 1.125, 1.03], s: 0.036, color: GLOW, glow: 1, flat: true });                                 // eyes
    R.mirror(head, prim.cone(), { p: [0.098, 1.26, 0.80], r: [-0.42, 0, 0.34], s: [0.05, 0.21, 0.035], color: HIDE });                    // ears swept BACK
    R.mirror(head, prim.crystal(), { p: [0.075, 1.21, 0.92], r: [-0.6, 0, 0.5], s: [0.05, 0.14, 0.05], color: GLOW, glow: 0.8, flat: true }); // skull shards
    R.mirror(head, prim.cone(), { p: [0.062, 1.00, 1.20], r: [Math.PI, 0, 0], s: [0.021, 0.075, 0.02], color: CLAW });                    // upper fangs
    const jaw = R.bone('jaw', head, 0, -0.075, 0.10);
    R.part(jaw, prim.slab(0.68), { p: [0, 0.972, 1.09], r: [-1.48, 0, 0], s: [0.115, 0.27, 0.055], color: 0x322e44, mottle: 0.14 });
    R.mirror(jaw, prim.cone(), { p: [0.052, 1.005, 1.16], s: [0.018, 0.06, 0.018], color: CLAW });                                        // lower fangs
    // ---- tail: carried UP in an S, shards along the top, tuft at the tip
    // prim.cyl is CENTRED on its origin (prim.limb hangs from it) — mixing the two is what left the first
    // rebuild's tail as three capsules floating off behind the hound. Each segment centre sits on the arc
    // and its rotation aims the +Y axis along the arc tangent, so the segments meet end to end.
    // The BONE chain follows the same arc as the parts (offsets are the arc's own steps), so a tail wave
    // rotates each segment about a point that is actually on the tail instead of shearing it sideways.
    const t0 = R.bone('tail0', body, 0, 0.10, -0.72), t1 = R.bone('tail1', t0, 0, 0.045, -0.297), t2 = R.bone('tail2', t1, 0, 0.126, -0.232);
    R.part(t0, prim.cyl(), { p: [0, 0.883, -0.869], r: [-1.42, 0, 0], s: [0.080, 0.30, 0.080], color: HIDE });
    R.part(t1, prim.cyl(), { p: [0, 0.968, -1.142], r: [-1.10, 0, 0], s: [0.062, 0.28, 0.062], color: HIDE });
    R.part(t2, prim.cyl(), { p: [0, 1.117, -1.332], r: [-0.76, 0, 0], s: [0.048, 0.24, 0.048], color: HIDE2 });
    R.part(t2, prim.cone(), { p: [0, 1.26, -1.47], r: [-0.76, 0, 0], s: [0.072, 0.21, 0.058], color: HIDE2, mottle: 0.26 });              // tuft
    R.part(t0, prim.crystal(), { p: [0, 0.95, -0.82], r: [-0.55, 0, 0], s: [0.058, 0.14, 0.055], color: GLOW, glow: 0.9, flat: true });
    R.part(t0, prim.crystal(), { p: [0, 0.98, -0.95], r: [-0.50, 0, 0], s: [0.054, 0.13, 0.052], color: GLOW, glow: 0.9, flat: true });
    R.part(t1, prim.crystal(), { p: [0, 1.05, -1.09], r: [-0.42, 0, 0], s: [0.050, 0.12, 0.048], color: GLOW, glow: 0.9, flat: true });
    R.part(t1, prim.crystal(), { p: [0, 1.10, -1.20], r: [-0.36, 0, 0], s: [0.046, 0.11, 0.045], color: GLOW, glow: 0.9, flat: true });
    R.part(t2, prim.crystal(), { p: [0, 1.19, -1.33], r: [-0.28, 0, 0], s: [0.042, 0.10, 0.042], color: GLOW, glow: 0.9, flat: true });
    // ---- legs: hips are children of body (follow bob); knees too (IK sets their position)
    // front pair is straighter and set under the deep chest; hind pair carries the haunch. Slimmer than the
    // wave-1 tubes — the reference's legs are long and wiry, which is most of why it reads as fast.
    const legs = [['FL', 0.20, 0.42, 0], ['FR', -0.20, 0.42, 1], ['HL', 0.19, -0.50, 1], ['HR', -0.19, -0.50, 0]];
    for (const [n, x, z] of legs) {
      const front = z > 0;
      const hip = R.bone('hip' + n, body, x, 0, z), knee = R.bone('knee' + n, body, x, -0.4, z);
      R.part(hip, prim.limb(0.58), { p: [x, 0.78, z], s: [front ? 0.095 : 0.11, 0.42, front ? 0.10 : 0.12], color: HIDE });
      R.part(hip, prim.sphereLo(), { p: [x, 0.73, z], s: [0.10, 0.13, 0.13], color: HIDE2, mottle: 0.14 });                           // shoulder / thigh mass
      R.part(knee, prim.limb(0.78), { p: [x, 0.36, z], s: [0.062, 0.36, 0.066], color: HIDE2 });
      R.part(knee, prim.slab(0.80), { p: [x, 0.042, z + 0.045], s: [0.135, 0.085, 0.24], color: HIDE2, mottle: 0.12 });               // paw
      // claws: two explicit parts, NOT R.mirror — mirror negates x about the body centreline, which on a
      // quadruped welds the twin to this leg's bone over on the OTHER leg's side of the body.
      for (const dx of [0.032, -0.032]) R.part(knee, prim.cone(), { p: [x + dx, 0.022, z + 0.15], r: [1.45, 0, 0], s: [0.019, 0.06, 0.019], color: CLAW });
    }
    return { ...R.build(), legDefs: legs.map(([n, x, z, g]) => ({ n, x, z, g })) };
  },
  setup(e, asset) {
    const b = e.bones;
    e.legs = asset.legDefs.map(({ n, x, z, g }) => makeLeg(b, 'hip' + n, 'knee' + n, [x, 0, z], [x, -0.76, z + (z > 0 ? 0.02 : -0.04)], 0.4, 0.4, [0, 0, -1], g));
    e.tail = [b.tail0, b.tail1, b.tail2]; e.legParent = b.body;
    e.gait = { stepLen: 0.34, stepTime: 0.17, lift: 0.14, lead: 0.14 };
  },
  animate(e, dt, t, A) {
    const b = e.bones, ph = e.phase, sp = e.speedN;
    // body bob + pitch with gait, breathe when idle
    const bob = Math.sin(ph * 2) * 0.03 * sp + Math.sin(t * 1.6 + e.seedT) * 0.01;
    b.body.position.y = 0.76 + bob + (e.state === 'stagger' ? -0.08 : 0);
    const sw = SW(e), crouch = seg(sw, 0, 0.3), lunge = seg(sw, 0.3, 0.4), rec = seg(sw, 0.55, 1);
    b.body.rotation.x = damp(b.body.rotation.x, -Math.sin(ph * 2) * 0.03 * sp + 0.18 * crouch - 0.42 * lunge + 0.32 * rec + e.tilt, 14, dt); // lunge pitch capped: muzzle must not pierce the camera plane at the ring
    b.body.rotation.z = Math.sin(ph) * 0.03 * sp;
    b.body.scale.y = 1 + Math.sin(t * 2.2 + e.seedT) * 0.012;
    // head tracks the player when alert; jaw opens on bite
    if (e.alert && e.state !== 'dead') aimAt(b.neck, A.eye, 1.0, 0.6, 8, dt); else { relaxBone(b.neck, 3, dt); b.neck.rotation.y = Math.sin(t * 0.7 + e.seedT) * 0.4; }
    b.head.rotation.x = -0.15 + (sp > 0.5 ? Math.sin(ph * 2) * 0.05 : 0);
    b.jaw.rotation.x = damp(b.jaw.rotation.x, 0.05 + 0.25 * crouch + 0.55 * lunge - 0.8 * rec + (e.alert ? 0.1 : 0), 16, dt);
    chainWave(e.tail, t + ph * 0.5, 0.25 + sp * 0.2, 3 + sp * 4, 'y', 0.8);
    for (let i = 0; i < 3; i++) e.tail[i].rotation.x = 0.25 - sp * 0.15 - i * 0.1 + (e.state === 'flee' ? -0.4 : 0);
    if (e.onGround) stepLegs(e.legs, b.body, e.velocity, dt, t, A.heightAt, e.gait);
  },
};

// ---------------------------------------------------------------- WISP: floating core + orbiting shards + halo
const wisp = {
  build() {
    const R = new Rig(), { root } = R;       // root = body centre (flyer)
    const core = R.bone('core', root, 0, 0, 0);
    // Core albedo mid-neutral, NOT white: the emissive (element hue x uGlow) must be the dominant term.
    // With a white albedo the hue-preserving channel cap preserves WHITE — on a hit flash the whole orb
    // pinned at the cap as a flat desaturated egg (combat gate cvfx-vfx6, vale crop). Decree: saturate
    // the colour; the orb's identity comes from ecol, the albedo just carries shading.
    R.part(core, prim.ico(), { p: [0, 0, 0], s: 0.27, color: 0x8e97a8, glow: 1, flat: true });                                        // burning aether orb — THE read
    for (let i = 0; i < 4; i++) { // open shell: 4 dark faceted petals with wide gaps, core blazes through
      const a = i / 4 * Math.PI * 2 + 0.4;
      R.part(core, prim.hex(), { p: [Math.cos(a) * 0.3, (i % 2 ? 0.1 : -0.08), Math.sin(a) * 0.3], r: [0.5 + i * 0.3, a, 0.9], s: [0.14, 0.05, 0.17], color: 0x2c3550, glow: 0.1, flat: true, mottle: 0.3 });
    }
    // halo rings: glow pulled back from 0.9/0.7 so they read as thin arcs of the creature's own hue rather
    // than the flat pale loops of the wave-3 void verdict (the hue itself is now held by the channel cap in
    // materials.js — this just stops them being the brightest thing in the region).
    const halo = R.bone('halo', core, 0, 0, 0);
    R.part(halo, prim.torus(), { p: [0, 0, 0], r: [Math.PI / 2, 0, 0], s: [0.44, 0.44, 0.44], color: 0xaab2c2, glow: 0.75 });
    const halo2 = R.bone('halo2', core, 0, 0, 0);
    R.part(halo2, prim.torus(), { p: [0, 0, 0], r: [Math.PI / 2 + 0.6, 0.3, 0], s: [0.34, 0.34, 0.34], color: 0xaab2c2, glow: 0.55 });
    for (let i = 0; i < 6; i++) {
      const piv = R.bone('sh' + i, core, 0, 0, 0); const a = i / 6 * Math.PI * 2;
      R.part(piv, prim.crystal(), { p: [Math.cos(a) * 0.55, Math.sin(i * 1.7) * 0.08, Math.sin(a) * 0.55], r: [0.4, -a, 0.2], s: [0.11, 0.21 + (i % 2) * 0.07, 0.11], color: 0xdde8ff, glow: 0.9, flat: true });
    }
    return R.build();
  },
  setup(e) { e.shards = []; for (let i = 0; i < 6; i++) e.shards.push(e.bones['sh' + i]); },
  animate(e, dt, t, A) {
    const b = e.bones, tt = t + e.seedT;
    const agg = e.alert ? 1.6 : 1;
    b.core.position.y = Math.sin(tt * 1.7) * 0.12 + Math.sin(tt * 3.1) * 0.04 + (e.state === 'flee' ? -0.3 : 0);
    const cs = 1 + Math.sin(tt * 4) * 0.06 + e.telegraph * 0.35 + (e.state === 'stagger' ? -0.2 : 0);
    b.core.scale.setScalar(cs); b.core.rotation.y = tt * 0.7; b.core.rotation.x = Math.sin(tt * 0.5) * 0.3;
    b.halo.rotation.set(Math.sin(tt * 0.8) * 0.5, tt * 1.4, 0);
    b.halo2.rotation.set(tt * 0.9, Math.cos(tt * 0.6) * 0.7, tt * 0.4);
    for (let i = 0; i < 6; i++) { // shards orbit; converge when telegraphing, burst outward on release
      const s = e.shards[i], spd = (1.2 + i * 0.23) * agg;
      s.rotation.y = tt * spd + i; s.rotation.x = Math.sin(tt * 0.7 + i) * 0.5 * (1 - e.telegraph);
      const sw = SW(e), r = 1 - 0.55 * seg(sw, 0, 0.33) + 0.9 * seg(sw, 0.35, 0.45) - 0.35 * seg(sw, 0.6, 1);
      s.scale.set(r, 1, r);
    }
  },
};

// ---------------------------------------------------------------- SENTINEL: tall biped, spear + orb, shield bubble
// Rebuilt from tools/out/assetgen/tripo/sentinel-hq.glb (concept sentinel-hq.webp, turntable
// sentinel-hq-render.jpg). What the reference is and the wave-1 body was not:
//   1. STONE, not gold. A granite golem-knight with gold filigree TRIM; the old one was a gold mannequin
//      ("gold blocky spear bipeds ... flat-shaded voxel mannequins", wave-3 dragon verdict).
//   2. BROAD AND SHORT-LEGGED. Hip line at ~44% of height, huge layered pauldrons, big bare stone feet.
//      The old one was a thin 5-head figure with a level stick body.
//   3. A violet HEART GEM in a gold cartouche, twin visor eyes, and a stone GREATSWORD with a gold fuller
//      — instead of a 2.6 m broom-handle spear that was most of its silhouette.
// 11784 -> ~2.9k tris: the old body spent 8k of that on boxB (588 tris each). Same bone names, same
// contract, so defs/weakPoints/AI/animation hooks are untouched.
const sentinel = {
  build() {
    const R = new Rig(), { root } = R;
    const STONE = 0xa9a496, STONE2 = 0x8a8472, DARK = 0x67614f, GOLD = 0xd8ac5c, GLOW = 0xffffff;
    const pelvis = R.bone('pelvis', root, 0, 1.15, 0);
    // ---- hips, belt, tassets
    R.part(pelvis, prim.plate(), { p: [0, 1.20, 0], s: [0.58, 0.30, 0.40], color: STONE2, mottle: 0.14 });
    R.part(pelvis, prim.hex(), { p: [0, 1.36, 0], r: [0, 0.39, 0], s: [0.32, 0.09, 0.24], color: GOLD, mottle: 0.05, flat: true });
    R.part(pelvis, prim.crystal(), { p: [0, 1.36, 0.25], r: [1.57, 0, 0], s: [0.075, 0.07, 0.075], color: GLOW, glow: 0.85, flat: true });  // buckle gem
    R.part(pelvis, prim.slab(0.62), { p: [0, 1.02, 0.20], r: [0.10, 0, 0], s: [0.28, 0.50, 0.12], color: STONE, mottle: 0.14 });            // front apron
    R.mirror(pelvis, prim.slab(0.70), { p: [0.31, 1.04, 0.01], r: [0, 0, 0.16], s: [0.19, 0.46, 0.28], color: STONE, mottle: 0.14 });       // side tassets
    R.part(pelvis, prim.slab(0.66), { p: [0, 1.03, -0.19], r: [-0.09, 0, 0], s: [0.26, 0.44, 0.11], color: STONE2, mottle: 0.12 });
    R.mirror(pelvis, prim.hex(), { p: [0.115, 0.84, 0.215], r: [0.10, 0, 0], s: [0.075, 0.035, 0.07], color: GOLD, mottle: 0.05, flat: true }); // apron trim
    // ---- legs (IK): short and thick, ending in bare stone feet with toes
    for (const [n, x] of [['L', 0.27], ['R', -0.27]]) {
      const hip = R.bone('hip' + n, pelvis, x, 0, 0), knee = R.bone('knee' + n, pelvis, x, -0.60, 0);
      R.part(hip, prim.limb(0.80), { p: [x, 1.15, 0], s: [0.19, 0.60, 0.20], color: STONE2, mottle: 0.14 });
      R.part(hip, prim.slab(0.76), { p: [x, 1.02, 0.04], r: [0.05, 0, 0], s: [0.25, 0.40, 0.23], color: STONE, mottle: 0.14 });   // cuisse
      R.part(hip, prim.hex(), { p: [x, 1.21, 0.06], r: [1.57, 0, 0], s: [0.135, 0.04, 0.115], color: GOLD, mottle: 0.05, flat: true });
      R.part(knee, prim.limb(0.92), { p: [x, 0.55, 0], s: [0.155, 0.55, 0.165], color: DARK });
      R.part(knee, prim.slab(0.86), { p: [x, 0.50, 0.03], s: [0.23, 0.40, 0.21], color: STONE, mottle: 0.14 });                   // greave
      R.part(knee, prim.hex(), { p: [x, 0.70, 0.10], r: [1.45, 0, 0], s: [0.125, 0.055, 0.125], color: GOLD, mottle: 0.05, flat: true }); // knee cop
      R.part(knee, prim.plate(), { p: [x, 0.09, 0.09], s: [0.28, 0.18, 0.44], color: STONE2, mottle: 0.13 });                     // bare stone foot
      for (const dx of [0.065, -0.065]) R.part(knee, prim.slab(0.78), { p: [x + dx, 0.07, 0.28], s: [0.09, 0.11, 0.15], color: STONE2, mottle: 0.1 }); // toes
    }
    // ---- torso: deep cuirass, gold trim following the plate edges, heart gem at the sternum
    const torso = R.bone('torso', pelvis, 0, 0.36, 0);
    R.part(torso, prim.plate(), { p: [0, 1.66, 0.01], s: [0.50, 0.34, 0.40], color: STONE2, mottle: 0.14 });
    R.part(torso, prim.plate(), { p: [0, 1.98, 0.02], s: [0.78, 0.48, 0.48], color: STONE, mottle: 0.16 });
    R.part(torso, prim.slab(0.88), { p: [0, 2.20, 0.01], s: [0.70, 0.20, 0.44], color: STONE, mottle: 0.16 });                    // clavicle shelf
    R.part(torso, prim.slab(0.82), { p: [0, 2.02, -0.23], r: [-0.10, 0, 0], s: [0.58, 0.44, 0.12], color: STONE2, mottle: 0.14 });
    R.part(torso, prim.hex(), { p: [0, 2.02, 0.245], r: [1.57, 0.39, 0], s: [0.20, 0.05, 0.20], color: GOLD, mottle: 0.05, flat: true }); // cartouche
    R.part(torso, prim.ico(), { p: [0, 2.02, 0.275], s: [0.115, 0.13, 0.085], color: GLOW, glow: 1, flat: true });                // HEART GEM
    R.part(torso, prim.hex(), { p: [0, 2.21, 0.03], r: [0, 0.39, 0], s: [0.36, 0.04, 0.24], color: GOLD, mottle: 0.05, flat: true });
    R.part(torso, prim.hex(), { p: [0, 1.79, 0.02], r: [0, 0.39, 0], s: [0.28, 0.045, 0.23], color: GOLD, mottle: 0.05, flat: true });
    R.mirror(torso, prim.hex(), { p: [0.27, 2.00, 0.20], r: [0.10, 0, 0.5], s: [0.07, 0.03, 0.17], color: GOLD, mottle: 0.05, flat: true });
    R.part(torso, prim.hex(), { p: [0, 2.29, 0.02], r: [0, 0.39, 0], s: [0.21, 0.07, 0.18], color: GOLD, mottle: 0.05, flat: true }); // gorget (kept smaller than the helm so the head still reads)
    for (let i = 0; i < 3; i++) R.part(torso, prim.crystal(), { p: [0, 2.16 - i * 0.15, -0.28], r: [0.55, 0, 0], s: [0.05, 0.12, 0.05], color: GLOW, glow: 0.7, flat: true });
    // ---- pauldrons: three lames each, gold rolled edge. This is the silhouette read at 60 m.
    R.mirror(torso, prim.plate(), { p: [0.56, 2.22, 0], r: [0, 0, 0.32], s: [0.38, 0.28, 0.46], color: STONE, mottle: 0.16 });
    R.mirror(torso, prim.hex(), { p: [0.565, 2.33, 0], r: [0, 0, 0.32], s: [0.20, 0.045, 0.245], color: GOLD, mottle: 0.05, flat: true });
    R.mirror(torso, prim.slab(0.88), { p: [0.62, 2.03, 0], r: [0, 0, 0.46], s: [0.32, 0.15, 0.42], color: STONE, mottle: 0.16 });
    R.mirror(torso, prim.slab(0.88), { p: [0.64, 1.88, 0], r: [0, 0, 0.56], s: [0.27, 0.13, 0.36], color: STONE2, mottle: 0.14 });
    R.mirror(torso, prim.crystal(), { p: [0.58, 2.42, 0], r: [0, 0, -0.30], s: [0.055, 0.12, 0.055], color: GLOW, glow: 0.8, flat: true });
    // ---- helm
    const head = R.bone('head', torso, 0, 0.76, 0);
    R.part(head, prim.plate(), { p: [0, 2.41, 0.01], s: [0.38, 0.36, 0.38], color: STONE, mottle: 0.14 });
    R.part(head, prim.hex(), { p: [0, 2.455, 0.01], r: [0, 0.39, 0], s: [0.205, 0.05, 0.205], color: GOLD, mottle: 0.05, flat: true });
    R.part(head, prim.slab(0.92), { p: [0, 2.35, 0.185], s: [0.21, 0.21, 0.06], color: 0x3e392f, mottle: 0.10 });                  // visor recess
    R.part(head, prim.slab(0.80), { p: [0, 2.33, 0.215], s: [0.045, 0.19, 0.05], color: STONE, mottle: 0.1 });                    // nose ridge splitting the eyes
    R.mirror(head, prim.crystal(), { p: [0.085, 2.37, 0.222], r: [0, 0, 1.57], s: [0.05, 0.09, 0.035], color: GLOW, glow: 1, flat: true }); // eyes
    R.part(head, prim.slab(0.72), { p: [0, 2.21, 0.11], r: [-0.14, 0, 0], s: [0.22, 0.15, 0.22], color: STONE2, mottle: 0.12 });   // jaw guard
    R.mirror(head, prim.slab(0.84), { p: [0.17, 2.34, 0.01], r: [0, 0, 0.10], s: [0.08, 0.26, 0.26], color: GOLD, mottle: 0.05 }); // cheek guards
    R.part(head, prim.crystal(), { p: [0, 2.63, -0.02], r: [-0.15, 0, 0], s: [0.062, 0.13, 0.062], color: GLOW, glow: 0.7, flat: true });
    R.mirror(head, prim.cone(), { p: [0.215, 2.52, -0.02], r: [-0.10, 0, -0.62], s: [0.038, 0.16, 0.038], color: GOLD, mottle: 0.05 });
    // ---- arms: shoulder -> elbow -> hand (children chain). Greatsword right, aether orb left.
    for (const [n, sx] of [['R', 0.47], ['L', -0.47]]) {
      const sh = R.bone('sh' + n, torso, sx, 0.52, 0), el = R.bone('el' + n, sh, 0, -0.44, 0), hd = R.bone('hd' + n, el, 0, -0.42, 0);
      R.part(sh, prim.limb(0.82), { p: [sx, 2.03, 0], s: [0.14, 0.44, 0.15], color: STONE2, mottle: 0.12 });
      R.part(sh, prim.slab(0.82), { p: [sx * 1.03, 2.00, 0.01], s: [0.20, 0.32, 0.21], color: STONE, mottle: 0.16 });   // rerebrace
      R.part(el, prim.limb(0.92), { p: [sx, 1.59, 0], s: [0.125, 0.42, 0.13], color: DARK });
      R.part(el, prim.slab(0.86), { p: [sx * 1.02, 1.55, 0.01], s: [0.21, 0.34, 0.21], color: STONE, mottle: 0.16 });   // vambrace
      R.part(el, prim.hex(), { p: [sx, 1.73, 0], r: [0, 0, 1.57], s: [0.135, 0.06, 0.145], color: GOLD, mottle: 0.05, flat: true }); // couter
      R.part(hd, prim.plate(), { p: [sx, 1.15, 0.02], s: [0.21, 0.19, 0.23], color: STONE2, mottle: 0.12 });
      R.part(hd, prim.hex(), { p: [sx, 1.15, 0.13], r: [1.50, 0, 0], s: [0.11, 0.04, 0.10], color: GOLD, mottle: 0.05, flat: true }); // knuckle plate
      if (n === 'R') {
        // greatsword, held forward and down along the body. Gold parts protrude through the blade rather
        // than being offset onto its face — the blade tilts 0.42 rad, and a face offset would z-fight.
        // Carried upright and canted 0.22 rad FORWARD so the blade passes in front of the pauldron instead
        // of through it, and reads as a held weapon rather than a plank strapped to the shoulder.
        R.part(hd, prim.cyl(), { p: [sx, 1.10, 0.160], r: [0.22, 0, 0], s: [0.038, 0.34, 0.038], color: 0x4a4539, mottle: 0.06 });
        R.part(hd, prim.octa(), { p: [sx, 0.915, 0.118], s: 0.062, color: GOLD, mottle: 0.05, flat: true });                          // pommel
        R.part(hd, prim.slab(0.85), { p: [sx, 1.31, 0.206], r: [0.22, 0, 1.57], s: [0.07, 0.32, 0.11], color: GOLD, mottle: 0.05 });  // crossguard
        R.part(hd, prim.slab(0.55), { p: [sx, 1.80, 0.313], r: [0.22, 0, 0], s: [0.21, 0.90, 0.075], color: STONE, mottle: 0.14 });   // blade
        R.part(hd, prim.cone(), { p: [sx, 2.28, 0.418], r: [0.22, 0, 0], s: [0.115, 0.26, 0.05], color: STONE, mottle: 0.12 });       // tip
        R.part(hd, prim.slab(0.50), { p: [sx, 1.80, 0.313], r: [0.22, 0, 0], s: [0.06, 0.82, 0.095], color: GOLD, mottle: 0.05 });    // fuller inlay
        R.part(hd, prim.crystal(), { p: [sx, 1.76, 0.304], r: [0.22, 0, 0], s: [0.028, 0.50, 0.11], color: GLOW, glow: 0.85, flat: true });
      } else {
        const orb = R.bone('orb', hd, 0, 0.30, 0.12);
        R.part(orb, prim.ico(), { p: [sx, 1.45, 0.14], s: 0.115, color: GLOW, glow: 1, flat: true });
        R.part(orb, prim.ring(), { p: [sx, 1.45, 0.14], r: [0.5, 0, 0], s: 0.19, color: GOLD, glow: 0.25 });
        for (let i = 0; i < 3; i++) {                                        // gold prongs cradling the orb
          const a = i / 3 * Math.PI * 2 + 0.5;
          R.part(orb, prim.cone(), { p: [sx + Math.cos(a) * 0.115, 1.45 + Math.sin(a) * 0.115, 0.14], r: [0, 0, a - Math.PI / 2], s: [0.03, 0.10, 0.03], color: GOLD, mottle: 0.05 });
        }
      }
    }
    return R.build();
  },
  setup(e) {
    const b = e.bones;
    e.legs = [makeLeg(b, 'hipL', 'kneeL', [0.27, 0, 0], [0.29, -1.15, 0.06], 0.6, 0.6, [0, 0, 1], 0), makeLeg(b, 'hipR', 'kneeR', [-0.27, 0, 0], [-0.29, -1.15, 0.06], 0.6, 0.6, [0, 0, 1], 1)];
    e.legParent = b.pelvis; e.gait = { stepLen: 0.44, stepTime: 0.24, lift: 0.15, lead: 0.16 };
  },
  animate(e, dt, t, A) {
    const b = e.bones, ph = e.phase, sp = e.speedN, sw = SW(e), tg = e.telegraph;
    b.pelvis.position.y = 1.15 + Math.sin(ph * 2) * 0.03 * sp + (e.state === 'stagger' ? -0.12 : 0);
    b.pelvis.rotation.y = Math.sin(ph) * 0.06 * sp; b.pelvis.rotation.x = e.tilt;
    const raise = seg(sw, 0, 0.3), thrust = seg(sw, 0.33, 0.42), rec = seg(sw, 0.6, 1);
    b.torso.rotation.x = damp(b.torso.rotation.x, 0.05 + sp * 0.08 - 0.15 * raise + 0.35 * thrust - 0.2 * rec, 10, dt);
    b.torso.rotation.y = -Math.sin(ph) * 0.08 * sp + e.strafeLean * 0.1;
    if (e.alert) aimAt(b.head, A.eye, 1.1, 0.6, 8, dt); else { relaxBone(b.head, 3, dt); b.head.rotation.y = Math.sin(t * 0.5 + e.seedT) * 0.5; }
    // arms: walk swing; the telegraph cocks the sword arm back and brings the orb hand up; release thrusts
    // the orb forward (it is the muzzle — _muzzle() reads the `orb` bone) and swings the sword through.
    const swing = Math.sin(ph) * 0.35 * sp;
    b.shR.rotation.x = damp(b.shR.rotation.x, swing * 0.5 - 1.4 * raise + 1.1 * thrust + 0.5 * rec, 12, dt);
    b.shR.rotation.z = damp(b.shR.rotation.z, -0.14 - 0.5 * raise + 0.5 * rec, 8, dt);
    b.elR.rotation.x = damp(b.elR.rotation.x, -0.12 - 0.5 * raise + 0.5 * rec, 8, dt);   // sword arm hangs straighter than the old spear grip
    b.hdR.rotation.x = damp(b.hdR.rotation.x, 0.9 * raise - 0.9 * rec, 8, dt);   // tip the blade toward the target
    b.shL.rotation.x = damp(b.shL.rotation.x, -swing * 0.5 - 1.3 * raise + 1.3 * rec - (e.alert ? 0.5 : 0), 8, dt);
    b.shL.rotation.z = damp(b.shL.rotation.z, 0.2 + 0.3 * raise - 0.3 * rec, 8, dt); b.elL.rotation.x = damp(b.elL.rotation.x, -0.5 - 0.4 * raise + 0.4 * rec - (e.alert ? 0.6 : 0), 8, dt);
    b.orb.position.y = 0.30 + Math.sin(t * 3 + e.seedT) * 0.04; b.orb.rotation.y = t * 2; b.orb.scale.setScalar(1 + tg * 0.6 + Math.sin(t * 6) * 0.05 * tg);
    if (e.onGround) stepLegs(e.legs, b.pelvis, e.velocity, dt, t, A.heightAt, e.gait);
  },
};

// ---------------------------------------------------------------- GOLEM: heavy rock biped, crystal core weak point, slam
const golem = {
  build() {
    const R = new Rig(), { root } = R;
    const ROCK = 0x8a867c, ROCK2 = 0x6c6960, MOSS = 0x6e8a52, GLOW = 0xffffff;
    const pelvis = R.bone('pelvis', root, 0, 1.5, 0);
    R.part(pelvis, prim.rock(3, 0.22), { p: [0, 1.55, 0], s: [0.55, 0.38, 0.45], color: ROCK2, flat: true });
    const torso = R.bone('torso', pelvis, 0, 0.3, 0);
    R.part(torso, prim.rock(1, 0.2), { p: [0, 2.35, -0.05], s: [0.95, 0.78, 0.72], color: ROCK, flat: true });
    R.part(torso, prim.rock(5, 0.25), { p: [0, 2.75, -0.2], s: [0.6, 0.4, 0.45], color: MOSS, flat: true, mottle: 0.2 });   // mossy back hump
    R.mirror(torso, prim.rock(2, 0.3), { p: [0.95, 2.8, 0], s: [0.45, 0.4, 0.42], color: ROCK, flat: true });                // shoulder boulders
    R.mirror(torso, prim.crystal(), { p: [0.9, 3.15, -0.05], r: [0, 0, -0.4], s: [0.12, 0.3, 0.12], color: GLOW, glow: 0.9, flat: true });
    const core = R.bone('core', torso, 0, 0.45, 0.55);
    R.part(core, prim.crystal(), { p: [0, 2.25, 0.62], r: [0.3, 0, 0], s: [0.24, 0.42, 0.24], color: GLOW, glow: 1, flat: true });
    R.part(core, prim.torus(), { p: [0, 2.25, 0.62], s: 0.33, r: [0.3, 0, 0], color: ROCK2, flat: true });                      // socket ring
    const head = R.bone('head', torso, 0, 1.15, 0.15);
    R.part(head, prim.rock(4, 0.25), { p: [0, 3.05, 0.2], s: [0.34, 0.3, 0.36], color: ROCK, flat: true });
    R.mirror(head, prim.sphere(), { p: [0.13, 3.08, 0.5], s: 0.05, color: GLOW, glow: 1 });
    R.part(head, prim.crystal(), { p: [0, 3.35, 0.1], r: [-0.2, 0, 0], s: [0.1, 0.22, 0.1], color: GLOW, glow: 0.6, flat: true });
    for (const [n, sx] of [['R', 1.0], ['L', -1.0]]) {
      const sh = R.bone('sh' + n, torso, sx, 0.95, 0), el = R.bone('el' + n, sh, 0, -0.82, 0), hd = R.bone('hd' + n, el, 0, -0.78, 0);
      R.part(sh, prim.limb(0.8), { p: [sx, 2.75, 0], s: [0.24, 0.82, 0.24], color: ROCK, mottle: 0.22 });
      R.part(el, prim.limb(1.1), { p: [sx, 1.93, 0], s: [0.24, 0.78, 0.24], color: ROCK2, mottle: 0.22 });
      R.part(hd, prim.rock(6 + (n === 'R'), 0.22), { p: [sx, 1.05, 0.02], s: [0.42, 0.4, 0.42], color: ROCK, flat: true });
      R.part(el, prim.crystal(), { p: [sx * 1.15, 1.75, 0.1], r: [0, 0, sx > 0 ? -1.2 : 1.2], s: [0.08, 0.18, 0.08], color: GLOW, glow: 0.8, flat: true });
    }
    for (const [n, x] of [['L', 0.42], ['R', -0.42]]) {
      const hip = R.bone('hip' + n, pelvis, x, 0, 0), knee = R.bone('knee' + n, pelvis, x, -0.78, 0);
      R.part(hip, prim.limb(0.9), { p: [x, 1.5, 0], s: [0.26, 0.78, 0.26], color: ROCK2, mottle: 0.22 });
      R.part(knee, prim.limb(1.2), { p: [x, 0.72, 0], s: [0.24, 0.66, 0.24], color: ROCK, mottle: 0.22 });
      R.part(knee, prim.rock(8, 0.18), { p: [x, 0.12, 0.1], s: [0.36, 0.16, 0.46], color: ROCK2, flat: true });
    }
    for (let i = 0; i < 3; i++) { const piv = R.bone('deb' + i, torso, 0, 1.2, 0); const a = i / 3 * Math.PI * 2; R.part(piv, prim.rock(10 + i, 0.3), { p: [Math.cos(a) * 1.5, 3.35, Math.sin(a) * 1.5], s: 0.16 + i * 0.04, color: ROCK, flat: true }); }
    return R.build();
  },
  setup(e) {
    const b = e.bones;
    e.legs = [makeLeg(b, 'hipL', 'kneeL', [0.42, 0, 0], [0.48, -1.5, 0.08], 0.78, 0.78, [0, 0, 1], 0), makeLeg(b, 'hipR', 'kneeR', [-0.42, 0, 0], [-0.48, -1.5, 0.08], 0.78, 0.78, [0, 0, 1], 1)];
    e.legParent = b.pelvis; e.gait = { stepLen: 0.7, stepTime: 0.42, lift: 0.22, lead: 0.25 };
    e.debris = [b.deb0, b.deb1, b.deb2];
  },
  animate(e, dt, t, A) {
    const b = e.bones, ph = e.phase, sp = e.speedN, sw = SW(e), tg = e.telegraph;
    b.pelvis.position.y = 1.5 + Math.abs(Math.sin(ph)) * 0.06 * sp + (e.state === 'stagger' ? -0.15 : 0);
    b.pelvis.rotation.z = Math.sin(ph) * 0.05 * sp; b.pelvis.rotation.x = e.tilt;
    // slam: wind-up leans back with both arms up, release crashes forward
    const isSlam = e.attackKind === 'slam' || e.attackKind === null, raise = seg(sw, 0, 0.22), crash = seg(sw, 0.26, 0.35), rec = seg(sw, 0.5, 1);
    b.torso.rotation.x = damp(b.torso.rotation.x, 0.08 - 0.3 * raise + 0.95 * crash - 0.65 * rec, 14, dt);
    b.torso.rotation.y = damp(b.torso.rotation.y, -Math.sin(ph) * 0.1 * sp, 6, dt);
    if (e.alert) aimAt(b.head, A.eye, 0.8, 0.5, 5, dt); else relaxBone(b.head, 2, dt);
    // slam: both arms overhead, crash down at the strike; throw: right arm winds back and hurls
    const armUp = isSlam ? 2.6 * raise - 3.6 * crash + 1.0 * rec : 0;
    for (const n of ['R', 'L']) {
      const s = n === 'R' ? 1 : -1, thr = !isSlam && n === 'R' ? 2.2 * raise - 3.6 * crash + 1.4 * rec : 0;
      b['sh' + n].rotation.x = damp(b['sh' + n].rotation.x, Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 0.3 * sp - armUp - thr, 14, dt);
      b['sh' + n].rotation.z = damp(b['sh' + n].rotation.z, -s * (0.25 + 0.3 * raise - 0.3 * rec), 6, dt);
      b['el' + n].rotation.x = damp(b['el' + n].rotation.x, -0.35 - 0.5 * raise + 0.5 * rec, 8, dt);
    }
    b.core.scale.setScalar(1 + tg * 0.4 + Math.sin(t * 5) * 0.05);
    for (let i = 0; i < 3; i++) { const d = e.debris[i]; d.rotation.y = t * (0.5 + i * 0.2) + i * 2; d.position.y = 1.2 + Math.sin(t * 1.3 + i * 2) * 0.15; }
    if (e.onGround) stepLegs(e.legs, b.pelvis, e.velocity, dt, t, A.heightAt, e.gait);
  },
};

// ---------------------------------------------------------------- DRAKE: winged flyer, flapping, dives
// Rebuilt from tools/out/assetgen/tripo/drake-hq.glb (concept drake-hq.webp, render drake-hq-render.jpg).
// Wave-3 dragon verdict, on the region's SIGNATURE creature: "a flat red-orange cutout with stick wings and
// no body volume — it reads as a paper dart, not a flying reptile."
// Identity-defining features the reference has and the wave-1 body did not, in priority order:
//   1. A HORN CROWN — a fan of eight backswept black horns with gold filigree bands, plus a frill of jaw
//      spikes framing the face. That crown is a third of the reference's silhouette; the old head had two cones.
//   2. BARREL VOLUME — deep chest, broad shoulders, and a SHORT thick neck. The old torso was one
//      0.36 x 0.32 x 0.85 ellipsoid: a fish with wings, with no depth at all from the side.
//   3. Overlapping scale plating (throat, chest scutes, flank), a horn spine ridge, a spiked tail ending in
//      a bladed fluke — the reference's whole surface is plated, the old one was bare.
//   4. Wings with real ARM structure: humerus, forearm, three swept fingers with membrane between them and
//      a wrist claw — not one bone and a flat sheet with glowing stripes painted on it.
//   5. Four tucked clawed limbs, so a drake passing overhead reads as a reptile from below.
// 7324 -> ~3.4k tris, i.e. it gained all of that AND came inside the crowd budget: the old body spent 1764
// on three boxB belly slits and ~3000 on ten box() wing veins. A slab reads as a scute for 16.
const drake = {
  build() {
    const R = new Rig(), { root } = R;
    const HIDE = 0x5e2720, HIDE2 = 0x3d1a15, BELLY = 0x9a7048, PLATE = 0x4a1e18, MEMB = 0x682820,
          EMBER = 0xffffff, HORN = 0x2b2420, GOLD = 0xc9a05a;
    const body = R.bone('body', root, 0, 0, 0);      // root = body centre (flyer)
    // ---- torso: five overlapping masses, deepest at the shoulder, croup falling away behind
    R.part(body, prim.sphereLo(), { p: [0, 0.06, 0.34], s: [0.42, 0.40, 0.46], color: HIDE });
    R.part(body, prim.sphereLo(), { p: [0, 0.20, 0.14], s: [0.38, 0.30, 0.34], color: HIDE2 });
    R.part(body, prim.sphereLo(), { p: [0, 0.00, -0.08], s: [0.38, 0.35, 0.40], color: HIDE });
    R.part(body, prim.sphereLo(), { p: [0, -0.02, -0.46], s: [0.30, 0.28, 0.34], color: HIDE2 });
    R.part(body, prim.sphereLo(), { p: [0, -0.20, 0.16], s: [0.30, 0.20, 0.46], color: BELLY, mottle: 0.14 });
    // belly scutes, with three molten vents between them (read from below on a dive)
    for (let i = 0; i < 6; i++) {
      const k = i / 5, z = 0.62 - k * 0.98;
      R.part(body, prim.slab(0.55), { p: [0, -0.29 + k * 0.05, z], r: [1.57, 0, 0], s: [0.28 - k * 0.07, 0.15, 0.05], color: BELLY, mottle: 0.22, flat: true });
      if (i < 3) R.part(body, prim.slab(0.85), { p: [0, -0.315, z - 0.09], r: [1.57, 0, 0], s: [0.17 - k * 0.03, 0.05, 0.03], color: EMBER, glow: 0.7 });
    }
    // flank plates + shoulder scale clusters
    R.mirror(body, prim.hex(), { p: [0.32, 0.10, 0.24], r: [0, 0, 1.20], s: [0.14, 0.05, 0.20], color: PLATE, flat: true, mottle: 0.14 });
    R.mirror(body, prim.hex(), { p: [0.30, -0.06, -0.16], r: [0, 0, 1.35], s: [0.12, 0.05, 0.18], color: PLATE, flat: true, mottle: 0.14 });
    // spine ridge: horn, not ember. A row of glowing spikes down the back is the blob bug waiting to happen.
    for (let i = 0; i < 8; i++) {
      const k = i / 7;
      R.part(body, prim.cone(), { p: [0, 0.30 - k * 0.10, 0.46 - k * 1.02], r: [-0.75 - k * 0.15, 0, 0], s: [0.045, 0.19 - k * 0.07, 0.035], color: HORN, mottle: 0.1, flat: true });
    }
    // ---- neck: SHORT and thick (two segments), plated on the underside
    const n0 = R.bone('neck0', body, 0, 0.16, 0.56), n1 = R.bone('neck1', n0, 0, 0.12, 0.28), head = R.bone('head', n1, 0, 0.12, 0.26);
    R.part(n0, prim.cyl(), { p: [0, 0.26, 0.66], r: [-1.10, 0, 0], s: [0.21, 0.32, 0.22], color: HIDE });
    R.part(n1, prim.cyl(), { p: [0, 0.44, 0.87], r: [-1.15, 0, 0], s: [0.18, 0.30, 0.19], color: HIDE });
    for (let i = 0; i < 5; i++) {                                   // throat scutes, biggest at the chest
      const k = i / 4;
      R.part(k < 0.5 ? n0 : n1, prim.slab(0.6), { p: [0, 0.16 + k * 0.30, 0.72 + k * 0.26], r: [1.15, 0, 0], s: [0.18 - k * 0.05, 0.13, 0.05], color: BELLY, mottle: 0.2, flat: true });
    }
    // ---- head: heavy skull, blunt snout, and the crown
    R.part(head, prim.sphereLo(), { p: [0, 0.62, 1.08], s: [0.235, 0.225, 0.27], color: HIDE });
    R.part(head, prim.slab(0.72), { p: [0, 0.575, 1.38], r: [-1.50, 0, 0], s: [0.195, 0.34, 0.17], color: HIDE, mottle: 0.14 });   // snout
    R.mirror(head, prim.hex(), { p: [0.10, 0.72, 1.20], r: [0.25, 0, 1.10], s: [0.085, 0.05, 0.17], color: PLATE, flat: true, mottle: 0.1 });   // brow
    R.mirror(head, prim.hex(), { p: [0.125, 0.59, 1.16], r: [0.10, 0, 1.35], s: [0.085, 0.05, 0.16], color: PLATE, flat: true, mottle: 0.12 }); // cheek plate
    R.mirror(head, prim.octa(), { p: [0.055, 0.615, 1.52], s: 0.035, color: HIDE2, flat: true });                                  // nostrils
    R.mirror(head, prim.crystal(), { p: [0.105, 0.665, 1.21], r: [0, 0, 1.4], s: [0.045, 0.055, 0.03], color: EMBER, glow: 1, flat: true });    // eyes
    // THE CROWN: four backswept horn pairs, longest innermost-and-up, fanning outward and flatter as they go
    // down the skull, each with a gold filigree band at the root. Roll is NEGATIVE on the +X side so the horn
    // sweeps OUT — R.mirror negates r[2], which is what carries it correctly to the -X twin.
    for (let i = 0; i < 4; i++) {
      const len = 0.72 - i * 0.11, roll = -(0.34 + i * 0.30), back = -1.05 + i * 0.16;
      R.mirror(head, prim.cone(), { p: [0.10 + i * 0.035, 0.80 - i * 0.055, 1.00 - i * 0.03], r: [back, 0, roll], s: [0.055 - i * 0.007, len, 0.046 - i * 0.006], color: HORN, mottle: 0.08, flat: true });
      if (i < 3) R.mirror(head, prim.hex(), { p: [0.122 + i * 0.035, 0.766 - i * 0.055, 0.978 - i * 0.03], r: [back, 0, roll], s: [0.062 - i * 0.007, 0.045, 0.062 - i * 0.007], color: GOLD, mottle: 0.05, flat: true });
    }
    // jaw frill: three small spikes per cheek, sweeping back — the reference's face is framed by them
    for (let i = 0; i < 3; i++) R.mirror(head, prim.cone(), { p: [0.135, 0.52 - i * 0.06, 1.15 - i * 0.06], r: [-0.55, 0, -(1.35 + i * 0.12)], s: [0.028, 0.16 - i * 0.02, 0.024], color: HORN, mottle: 0.1, flat: true });
    const jaw = R.bone('jaw', head, 0, -0.09, 0.10);
    R.part(jaw, prim.slab(0.68), { p: [0, 0.478, 1.35], r: [-1.52, 0, 0], s: [0.16, 0.33, 0.10], color: HIDE2, mottle: 0.16 });
    R.part(jaw, prim.octa(), { p: [0, 0.52, 1.20], s: [0.075, 0.05, 0.075], color: EMBER, glow: 0.8, flat: true });                 // throat ember
    for (let i = 0; i < 2; i++) R.mirror(jaw, prim.cone(), { p: [0.058, 0.535, 1.42 - i * 0.10], s: [0.020, 0.07, 0.018], color: 0xd8ccb0 });      // lower fangs point UP
    for (let i = 0; i < 2; i++) R.mirror(head, prim.cone(), { p: [0.062, 0.498, 1.45 - i * 0.10], r: [Math.PI, 0, 0], s: [0.020, 0.075, 0.018], color: 0xd8ccb0 });  // upper fangs point DOWN
    // ---- tail: thick at the root, spiked along the top, bladed fluke at the tip
    const t0 = R.bone('tail0', body, 0, -0.02, -0.66), t1 = R.bone('tail1', t0, 0, 0, -0.44), t2 = R.bone('tail2', t1, 0, 0, -0.42);
    R.part(t0, prim.cyl(), { p: [0, -0.02, -0.88], r: [Math.PI / 2, 0, 0], s: [0.165, 0.46, 0.165], color: HIDE });
    R.part(t1, prim.cyl(), { p: [0, -0.02, -1.32], r: [Math.PI / 2, 0, 0], s: [0.115, 0.44, 0.115], color: HIDE });
    R.part(t2, prim.cyl(), { p: [0, -0.02, -1.73], r: [Math.PI / 2, 0, 0], s: [0.070, 0.40, 0.070], color: HIDE2 });
    for (let i = 0; i < 7; i++) {                                   // upward-hooking spikes down the tail top
      const k = i / 6, bn = k < 0.34 ? t0 : k < 0.7 ? t1 : t2;
      R.part(bn, prim.cone(), { p: [0, 0.08 - k * 0.03, -0.72 - k * 1.05], r: [-0.35 + k * 0.25, 0, 0], s: [0.035 - k * 0.012, 0.16 - k * 0.06, 0.028 - k * 0.01], color: HORN, mottle: 0.1, flat: true });
    }
    R.mirror(t2, prim.slab(0.35), { p: [0.075, -0.02, -1.99], r: [0, 0, -0.95], s: [0.06, 0.26, 0.035], color: HORN, mottle: 0.08, flat: true });   // fluke barbs
    R.part(t2, prim.cone(), { p: [0, -0.02, -2.06], r: [-1.57, 0, 0], s: [0.055, 0.22, 0.04], color: HORN, mottle: 0.08, flat: true });
    // ---- wings: wing0 (humerus) -> wing1 (forearm + a THREE-FINGER FAN with a membrane panel in every gap).
    // The first rebuild hung two axis-aligned sheets off the arm and let the fingers overshoot them by 30 cm,
    // so from the front the wing was three bare rods (tools/out/c2-drake/shot-lineup-13m.png). A membrane panel
    // now spans each finger gap: `p` is the wrist plus half the panel's own mean-direction, and the Y-euler is
    // that same mean angle, so the panel's span axis lies along the fan and its chord crosses the gap. Span
    // pulled in from 6.0 to 5.1 root units against a 3.6-unit body — the reference's ratio, not a hang-glider.
    for (const [n, s] of [['L', 1], ['R', -1]]) {
      const w0 = R.bone('wing0' + n, body, s * 0.30, 0.18, 0.22), w1 = R.bone('wing1' + n, w0, s * 0.72, 0, 0);
      const WX = 1.78, WZ = 0.13;                                     // the wrist, in root space (x is signed by s)
      R.part(w0, prim.sphereLo(), { p: [s * 0.36, 0.20, 0.20], s: [0.17, 0.17, 0.19], color: HIDE });                                  // deltoid: the wing has a shoulder
      R.part(w0, prim.cyl(), { p: [s * 0.68, 0.20, 0.18], r: [0, 0, Math.PI / 2], s: [0.078, 0.68, 0.078], color: HIDE2 });            // humerus
      R.part(w0, prim.slab(0.5), { p: [s * 0.68, 0.235, 0.235], r: [0, 0, -s * Math.PI / 2], s: [0.05, 0.72, 0.10], color: PLATE, mottle: 0.12, flat: true }); // leading-edge fairing
      R.part(w0, prim.membrane(3), { p: [s * 0.68, 0.13, -0.17], s: [0.80, 0.22, 0.70], color: MEMB, mottle: 0.28 });                  // elbow-to-flank panel
      R.part(w1, prim.cyl(), { p: [s * 1.40, 0.19, 0.15], r: [0, 0, Math.PI / 2], s: [0.060, 0.76, 0.060], color: HIDE2 });            // forearm
      R.part(w1, prim.hex(), { p: [s * WX, 0.18, WZ], r: [0, 0, Math.PI / 2], s: [0.072, 0.085, 0.072], color: PLATE, flat: true });   // wrist knuckle
      const PHI = [0.28, 0.90, 1.55], LEN = [0.82, 0.70, 0.58];
      for (let f = 0; f < 3; f++) {
        const phi = PHI[f], len = LEN[f];
        R.part(w1, prim.cyl(), { p: [s * (WX + Math.cos(phi) * len * 0.5), 0.175 - f * 0.008, WZ - Math.sin(phi) * len * 0.5], r: [0, s * phi, -s * Math.PI / 2], s: [0.036 - f * 0.005, len, 0.036 - f * 0.005], color: HIDE2 });
        if (f < 2) {                                                  // membrane in the gap between this finger and the next
          const pm = (phi + PHI[f + 1]) * 0.5, lm = (len + LEN[f + 1]) * 0.5, gap = lm * (PHI[f + 1] - phi) * 1.25;
          R.part(w1, prim.membrane(2), { p: [s * (WX + Math.cos(pm) * lm * 0.5), 0.125, WZ - Math.sin(pm) * lm * 0.5], r: [0, s * pm, 0], s: [lm * 1.04, 0.20, gap], color: MEMB, mottle: 0.28 });
        }
      }
      R.part(w1, prim.membrane(3), { p: [s * 1.44, 0.12, -0.22], s: [0.86, 0.20, 0.70], color: MEMB, mottle: 0.28 });                  // trailing panel, last finger to elbow
      R.part(w1, prim.cone(), { p: [s * 1.92, 0.25, 0.26], r: [0, 0, -s * 1.25], s: [0.038, 0.24, 0.032], color: 0xd8ccb0 });          // wrist claw
      // ---- tucked legs: thigh, shin, foot, three claws. Four of them, so a drake passing overhead reads as
      // a reptile from below instead of a dart. Positions are the chain solved by hand (thigh 0.36, shin 0.32)
      // so the segments meet end to end; each entry is [hipY, hipZ, thighEuler.x, kneeY, kneeZ, shinEuler.x, footZ, clawTilt].
      for (const [hy, hz, tx, ky, kz, sx2, fz, ct] of [[-0.14, 0.34, 0.55, -0.43, 0.16, -0.85, 0.44, 1.9], [-0.10, -0.34, -0.45, -0.41, -0.19, 0.85, -0.47, 1.25]]) {
        const x = s * 0.27, kx = s * 0.38, fx = s * 0.41;
        R.part(body, prim.limb(0.72), { p: [x, hy, hz], r: [tx, 0, s * 0.32], s: [0.085, 0.36, 0.085], color: HIDE });
        R.part(body, prim.limb(0.78), { p: [kx, ky, kz], r: [sx2, 0, s * 0.10], s: [0.065, 0.32, 0.065], color: HIDE2 });
        R.part(body, prim.slab(0.8), { p: [fx, ky - 0.24, fz - Math.sign(fz) * 0.05], r: [0.2, 0, 0], s: [0.10, 0.07, 0.17], color: HIDE2, mottle: 0.14, flat: true });
        for (let c = -1; c <= 1; c++) R.part(body, prim.cone(), { p: [fx + c * 0.045, ky - 0.27, fz + Math.sign(fz) * 0.05], r: [ct, 0, 0], s: [0.018, 0.075, 0.018], color: 0xd8ccb0 });
      }
    }
    return R.build();
  },
  setup(e) { const b = e.bones; e.tail = [b.tail0, b.tail1, b.tail2]; e.neck = [b.neck0, b.neck1]; },
  animate(e, dt, t, A) {
    const b = e.bones, tt = t + e.seedT, sw = SW(e);
    const diving = e.state === 'attack';
    const flapF = diving ? 3 : 6.5, flapA = diving ? 0.22 : 0.56;
    const raw = Math.sin(tt * flapF);
    // a real wingbeat is not a sine: the downstroke snaps (it does the work), the recovery drifts, and the outer
    // wing both LAGS the humerus and folds in on the upstroke so it isn't pushing air the wrong way.
    const flap = Math.sign(raw) * Math.pow(Math.abs(raw), raw > 0 ? 0.62 : 1.35);
    const rawL = Math.sin(tt * flapF - 0.9), lag = Math.sign(rawL) * Math.pow(Math.abs(rawL), rawL > 0 ? 0.7 : 1.25);
    const fold = Math.max(0, -flap);                                  // 0 on the downstroke, 1 at the top of the upstroke
    b.body.position.y = flap * 0.08; b.body.rotation.x = e.pitchAnim + flap * 0.03; b.body.rotation.z = e.rollAnim;
    // RAKE IS WHAT MAKES A WING READ, not flap or sweep. The membrane sheet's normal is its bone's local +Y;
    // rotating the bone about Z (flap) or Y (sweep) never gives that normal a Z component, so a wing held out
    // along X is EDGE-ON from directly ahead — and ahead is where the player fights it. That is why the first
    // pass rendered as three bare rods at 13 m (tools/out/c2-drake/shot-lineup-13m.png). rotation.x rolls the
    // sheet about its own span: a 0.5 rad rest rake turns the panel toward the camera and doubles as angle of
    // attack, biting on the downstroke and feathering on the recovery, which is what a real wingbeat does.
    for (const [n, s] of [['L', 1], ['R', -1]]) {
      b['wing0' + n].rotation.z = s * (flap * flapA + 0.16);
      b['wing0' + n].rotation.y = -s * (0.34 + 0.05 * flap + 0.16 * fold);   // swept back at rest, more as it folds
      b['wing0' + n].rotation.x = 0.50 + flap * 0.22;
      b['wing1' + n].rotation.z = s * (lag * flapA * 0.9 - 0.12 - 0.55 * fold);
      b['wing1' + n].rotation.y = -s * (0.24 + 0.32 * fold);                 // outer wing tucks back toward the body
      b['wing1' + n].rotation.x = 0.26 + lag * 0.20;                         // the hand twists more than the arm
    }
    chainWave(e.tail, tt, 0.25, 2.2, 'y', 0.9); for (let i = 0; i < 3; i++) e.tail[i].rotation.x = 0.08 + flap * 0.04;
    if (e.alert) { aimAt(b.neck1, A.eye, 0.9, 0.7, 5, dt); } else { relaxBone(b.neck1, 3, dt); }
    b.neck0.rotation.x = -0.1 + flap * 0.05;
    b.jaw.rotation.x = damp(b.jaw.rotation.x, 0.6 * seg(sw, 0.15, 0.35) - 0.6 * seg(sw, 0.6, 0.9), 10, dt);
  },
};

// ---------------------------------------------------------------- WARDEN: mini-boss, armored biped, hammer + crystal halo
const warden = {
  build() {
    const R = new Rig(), { root } = R;
    const STONE = 0x666070, STONE2 = 0x47434f, GOLD = 0xc9a24a, GLOW = 0xffffff, CLOTH = 0x4d3a62;
    const S = 1.55; // scale of sentinel proportions
    const pelvis = R.bone('pelvis', root, 0, 1.45 * S, 0);
    R.part(pelvis, prim.boxB(), { p: [0, 1.5 * S, 0], s: [0.5 * S, 0.26 * S, 0.34 * S], color: STONE2, mottle: 0.1 });
    for (let i = 0; i < 7; i++) { const a = (i - 3) * 0.42; R.part(pelvis, prim.box(), { p: [Math.sin(a) * 0.3 * S, 1.15 * S, Math.cos(a) * 0.24 * S - 0.02], r: [0.1, a, 0], s: [0.15 * S, 0.6 * S, 0.05 * S], color: i % 2 ? STONE : CLOTH, mottle: 0.1 }); }
    const torso = R.bone('torso', pelvis, 0, 0.22 * S, 0);
    // layered armor mass (beveled + octagonal core, side plates — reads as forged armor at point-blank)
    R.part(torso, prim.hex(), { p: [0, 1.98 * S, 0], r: [0, 0.52, 0], s: [0.34 * S, 0.64 * S, 0.28 * S], color: STONE, mottle: 0.16, flat: true });
    R.part(torso, prim.boxB(), { p: [0, 2.14 * S, 0.02 * S], s: [0.62 * S, 0.42 * S, 0.38 * S], color: STONE, mottle: 0.16 });
    R.part(torso, prim.boxB(), { p: [0, 1.78 * S, 0], s: [0.46 * S, 0.32 * S, 0.32 * S], color: STONE2, mottle: 0.12 });
    R.mirror(torso, prim.boxB(), { p: [0.3 * S, 2.16 * S, 0.02 * S], r: [0, 0, 0.28], s: [0.15 * S, 0.4 * S, 0.34 * S], color: STONE, mottle: 0.16 });
    R.part(torso, prim.boxB(), { p: [0, 2.2 * S, -0.18 * S], r: [-0.3, 0, 0], s: [0.44 * S, 0.36 * S, 0.1 * S], color: GOLD, mottle: 0.06 });
    R.part(torso, prim.boxB(), { p: [0, 2.1 * S, 0.2 * S], s: [0.44 * S, 0.34 * S, 0.07 * S], color: GOLD, mottle: 0.05 });
    R.part(torso, prim.crystal(), { p: [0, 2.1 * S, 0.25 * S], r: [0.2, 0, 0], s: [0.12 * S, 0.2 * S, 0.1 * S], color: GLOW, glow: 1, flat: true }); // chest core
    R.mirror(torso, prim.sphere(), { p: [0.42 * S, 2.28 * S, 0], s: [0.2 * S, 0.14 * S, 0.2 * S], color: GOLD, mottle: 0.04 });
    R.mirror(torso, prim.crystal(), { p: [0.46 * S, 2.45 * S, 0], r: [0, 0, -0.35], s: [0.1 * S, 0.26 * S, 0.1 * S], color: GLOW, glow: 0.9, flat: true });
    R.mirror(torso, prim.crystal(), { p: [0.38 * S, 2.45 * S, -0.08 * S], r: [0.3, 0, -0.2], s: [0.07 * S, 0.18 * S, 0.07 * S], color: GLOW, glow: 0.9, flat: true });
    const head = R.bone('head', torso, 0, 0.62 * S, 0);
    R.part(head, prim.boxB(), { p: [0, 2.46 * S, 0], s: [0.28 * S, 0.34 * S, 0.3 * S], color: STONE, mottle: 0.12 });
    R.part(head, prim.box(), { p: [0, 2.48 * S, 0.16 * S], s: [0.22 * S, 0.035 * S, 0.02 * S], color: GLOW, glow: 1 });
    for (let i = -2; i <= 2; i++) R.part(head, prim.crystal(), { p: [i * 0.08 * S, 2.7 * S, -0.02 * S], r: [0, 0, -i * 0.25], s: [0.06 * S, (0.2 - Math.abs(i) * 0.04) * S, 0.06 * S], color: GLOW, glow: 0.8, flat: true }); // crown
    // halo: ring of shards behind the shoulders
    const halo = R.bone('halo', torso, 0, 0.75 * S, -0.35 * S);
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; R.part(halo, prim.crystal(), { p: [Math.cos(a) * 0.9 * S, 2.2 * S + Math.sin(a) * 0.9 * S, -0.35 * S], r: [0, 0, -a], s: [0.08 * S, 0.22 * S, 0.06 * S], color: GLOW, glow: 0.9, flat: true }); }
    R.part(halo, prim.torus(), { p: [0, 2.2 * S, -0.36 * S], s: 0.9 * S, color: GOLD, glow: 0.3 });
    for (const [n, sx] of [['R', 0.44 * S], ['L', -0.44 * S]]) {
      const sh = R.bone('sh' + n, torso, sx, 0.5 * S, 0), el = R.bone('el' + n, sh, 0, -0.46 * S, 0), hd = R.bone('hd' + n, el, 0, -0.44 * S, 0);
      R.part(sh, prim.limb(0.8), { p: [sx, 2.18 * S, 0], s: [0.11 * S, 0.46 * S, 0.11 * S], color: STONE, mottle: 0.1 });
      R.part(el, prim.limb(0.85), { p: [sx, 1.72 * S, 0], s: [0.09 * S, 0.44 * S, 0.09 * S], color: STONE2 });
      R.part(el, prim.sphere(), { p: [sx, 1.72 * S, 0], s: 0.11 * S, color: GOLD, mottle: 0.04 });
      R.part(hd, prim.box(), { p: [sx, 1.26 * S, 0.02], s: [0.13 * S, 0.14 * S, 0.14 * S], color: STONE2 });
      if (n === 'R') { // great hammer
        R.part(hd, prim.cyl(), { p: [sx, 1.9 * S, 0.12 * S], s: [0.035 * S, 2.4 * S, 0.035 * S], color: STONE2, mottle: 0.05 });
        R.part(hd, prim.rock(21, 0.15), { p: [sx, 3.0 * S, 0.12 * S], s: [0.3 * S, 0.26 * S, 0.46 * S], color: STONE, flat: true });
        R.part(hd, prim.crystal(), { p: [sx, 3.0 * S, 0.12 * S], r: [Math.PI / 2, 0, 0], s: [0.14 * S, 0.5 * S, 0.14 * S], color: GLOW, glow: 1, flat: true });
      } else { const orb = R.bone('orb', hd, 0, 0.32 * S, 0.1 * S); R.part(orb, prim.ico(), { p: [sx, 1.6 * S, 0.12 * S], s: 0.16 * S, color: GLOW, glow: 1, flat: true }); R.part(orb, prim.torus(), { p: [sx, 1.6 * S, 0.12 * S], r: [0.5, 0, 0], s: 0.26 * S, color: GOLD, glow: 0.3 }); }
    }
    for (const [n, x] of [['L', 0.2 * S], ['R', -0.2 * S]]) {
      const hip = R.bone('hip' + n, pelvis, x, 0, 0), knee = R.bone('knee' + n, pelvis, x, -0.75 * S, 0);
      R.part(hip, prim.limb(0.75), { p: [x, 1.45 * S, 0], s: [0.13 * S, 0.75 * S, 0.13 * S], color: STONE, mottle: 0.1 });
      R.part(hip, prim.box(), { p: [x, 1.25 * S, 0.07 * S], s: [0.17 * S, 0.36 * S, 0.1 * S], color: GOLD, mottle: 0.04 });
      R.part(knee, prim.limb(0.8), { p: [x, 0.7 * S, 0], s: [0.1 * S, 0.66 * S, 0.1 * S], color: STONE2 });
      R.part(knee, prim.box(), { p: [x, 0.05 * S, 0.07 * S], s: [0.17 * S, 0.1 * S, 0.36 * S], color: STONE2, mottle: 0.05 });
    }
    return R.build();
  },
  setup(e) {
    const b = e.bones, S = 1.55;
    e.legs = [makeLeg(b, 'hipL', 'kneeL', [0.2 * S, 0, 0], [0.22 * S, -1.45 * S, 0.05], 0.75 * S, 0.75 * S, [0, 0, 1], 0), makeLeg(b, 'hipR', 'kneeR', [-0.2 * S, 0, 0], [-0.22 * S, -1.45 * S, 0.05], 0.75 * S, 0.75 * S, [0, 0, 1], 1)];
    e.legParent = b.pelvis; e.gait = { stepLen: 0.8, stepTime: 0.36, lift: 0.25, lead: 0.22 };
  },
  animate(e, dt, t, A) {
    const b = e.bones, ph = e.phase, sp = e.speedN, sw = SW(e), tg = e.telegraph, S = 1.55;
    b.pelvis.position.y = 1.45 * S + Math.sin(ph * 2) * 0.04 * sp + (e.state === 'stagger' ? -0.15 : 0);
    b.pelvis.rotation.y = Math.sin(ph) * 0.05 * sp; b.pelvis.rotation.x = e.tilt;
    const melee = e.attackKind === 'slam';
    const raise = seg(sw, 0, 0.24), crash = seg(sw, 0.27, 0.35), rec = seg(sw, 0.5, 1);
    b.torso.rotation.x = damp(b.torso.rotation.x, 0.06 + sp * 0.06 + (melee ? -0.3 * raise + 0.9 * crash - 0.6 * rec : -0.15 * raise + 0.15 * rec), 12, dt);
    b.torso.rotation.y = damp(b.torso.rotation.y, -Math.sin(ph) * 0.06 * sp - (tg * (melee ? 0.5 : 0)), 6, dt);
    if (e.alert) aimAt(b.head, A.eye, 1.0, 0.5, 6, dt); else relaxBone(b.head, 3, dt);
    const swing = Math.sin(ph) * 0.3 * sp;
    // hammer arm: slam = raise overhead then crash down; volley = orb hand forward
    const hammer = melee ? 2.8 * raise - 3.9 * crash + 1.1 * rec : 0.4 * raise - 0.4 * rec;
    b.shR.rotation.x = damp(b.shR.rotation.x, swing * 0.4 - hammer, 14, dt); b.shR.rotation.z = damp(b.shR.rotation.z, -0.2 - 0.2 * raise + 0.2 * rec, 8, dt);
    b.elR.rotation.x = damp(b.elR.rotation.x, -0.25 - 0.3 * raise + 0.3 * rec, 8, dt);
    b.shL.rotation.x = damp(b.shL.rotation.x, -swing * 0.4 - (melee ? 0.3 : 1.6 * raise - 1.6 * rec) - (e.alert ? 0.4 : 0), 8, dt);
    b.shL.rotation.z = damp(b.shL.rotation.z, 0.25 + tg * 0.2, 8, dt); b.elL.rotation.x = damp(b.elL.rotation.x, -0.5 - (e.alert ? 0.5 : 0), 8, dt);
    b.orb.position.y = 0.32 * S + Math.sin(t * 3 + e.seedT) * 0.05; b.orb.rotation.y = t * 2; b.orb.scale.setScalar(1 + (melee ? 0 : tg) * 0.6);
    b.halo.rotation.z = t * 0.6; b.halo.rotation.x = Math.sin(t * 0.8) * 0.15; b.halo.scale.setScalar(1 + tg * 0.15 + (e.phaseFlash ?? 0) * 0.4);
    if (e.onGround) stepLegs(e.legs, b.pelvis, e.velocity, dt, t, A.heightAt, e.gait);
  },
};


export { plantLegs };

// ---------------------------------------------------------------- GIANT: hulking two-legged brute (Ice Giant)
// Reads at 100 m: tiny head, huge shoulders, arms past the knees, a crown of shards down the spine.
const giant = {
  build() {
    const R = new Rig(), { root } = R;
    const HIDE = 0x7d8794, PLATE = 0x4b5464, SHARD = 0xffffff, FUR = 0x9aa3ad;
    const pelvis = R.bone('pelvis', root, 0, 2.05, 0);
    R.part(pelvis, prim.boxB(), { p: [0, 2.1, 0], s: [0.74, 0.5, 0.56], color: PLATE, mottle: 0.16 });
    R.part(pelvis, prim.boxB(), { p: [0, 1.72, 0.02], s: [0.6, 0.4, 0.5], color: FUR, mottle: 0.3 });        // hide kilt
    const torso = R.bone('torso', pelvis, 0, 0.5, 0);
    R.part(torso, prim.sphere(), { p: [0, 3.15, -0.06], s: [1.02, 0.92, 0.76], color: HIDE });
    R.part(torso, prim.sphere(), { p: [0, 2.62, 0.12], s: [0.72, 0.5, 0.58], color: FUR, mottle: 0.22 });    // gut
    R.part(torso, prim.boxB(), { p: [0, 3.62, -0.3], s: [0.92, 0.4, 0.44], color: FUR, mottle: 0.26 });      // shoulder mantle
    R.mirror(torso, prim.hex(), { p: [0.9, 3.62, -0.02], r: [0, 0, 0.95], s: [0.36, 0.13, 0.36], color: PLATE, flat: true, mottle: 0.1 });
    for (let i = 0; i < 4; i++) {                                                                             // spine shards
      const sx = i % 2 ? 0.26 : -0.26;
      R.part(torso, prim.crystal(), { p: [sx, 3.92 - i * 0.3, -0.48], r: [-0.45, 0, sx > 0 ? 0.3 : -0.3], s: [0.13, 0.44 - i * 0.05, 0.13], color: SHARD, glow: 0.8, flat: true });
    }
    const head = R.bone('head', torso, 0, 1.22, 0.1);
    R.part(head, prim.sphere(), { p: [0, 4.1, 0.12], s: [0.4, 0.42, 0.4], color: HIDE });
    R.part(head, prim.boxB(), { p: [0, 3.95, 0.4], r: [0.16, 0, 0], s: [0.3, 0.22, 0.3], color: HIDE, mottle: 0.22 });   // heavy jaw
    R.mirror(head, prim.cone(), { p: [0.3, 4.44, -0.02], r: [-0.2, 0, -0.62], s: [0.12, 0.6, 0.12], color: SHARD, glow: 0.55, flat: true });   // horns
    R.mirror(head, prim.sphere(), { p: [0.16, 4.16, 0.38], s: 0.055, color: SHARD, glow: 1 });
    for (const [n, sx] of [['R', 1.0], ['L', -1.0]]) {
      const sh = R.bone('sh' + n, torso, sx * 1.02, 0.52, 0), el = R.bone('el' + n, sh, 0, -1.02, 0), hd = R.bone('hd' + n, el, 0, -0.95, 0);
      R.part(sh, prim.limb(0.78), { p: [sx * 1.02, 3.67, 0], s: [0.3, 1.02, 0.3], color: HIDE, mottle: 0.2 });
      R.part(el, prim.limb(1.05), { p: [sx * 1.02, 2.65, 0], s: [0.26, 0.95, 0.26], color: HIDE, mottle: 0.2 });
      R.part(hd, prim.rock(6 + (n === 'R' ? 1 : 0), 0.24), { p: [sx * 1.02, 1.55, 0.04], s: [0.42, 0.42, 0.42], color: PLATE, flat: true });
      R.part(el, prim.crystal(), { p: [sx * 1.22, 2.4, 0.06], r: [0, 0, sx > 0 ? -1.15 : 1.15], s: [0.09, 0.24, 0.09], color: SHARD, glow: 0.7, flat: true });
    }
    for (const [n, x] of [['L', 0.44], ['R', -0.44]]) {
      const hip = R.bone('hip' + n, pelvis, x, 0, 0), knee = R.bone('knee' + n, pelvis, x, -1.05, 0);
      R.part(hip, prim.limb(0.9), { p: [x, 2.05, 0], s: [0.3, 1.05, 0.3], color: PLATE, mottle: 0.2 });
      R.part(knee, prim.limb(1.2), { p: [x, 1.0, 0], s: [0.27, 0.92, 0.27], color: HIDE, mottle: 0.2 });
      R.part(knee, prim.rock(8, 0.18), { p: [x, 0.16, 0.12], s: [0.38, 0.2, 0.5], color: PLATE, flat: true });
    }
    return R.build();
  },
  setup(e) {
    const b = e.bones;
    e.legs = [makeLeg(b, 'hipL', 'kneeL', [0.44, 0, 0], [0.5, -2.05, 0.1], 1.05, 1.05, [0, 0, 1], 0),
              makeLeg(b, 'hipR', 'kneeR', [-0.44, 0, 0], [-0.5, -2.05, 0.1], 1.05, 1.05, [0, 0, 1], 1)];
    e.legParent = b.pelvis; e.gait = { stepLen: 0.95, stepTime: 0.46, lift: 0.3, lead: 0.26 };
  },
  animate(e, dt, t, A) {
    const b = e.bones, ph = e.phase, sp = e.speedN, sw = SW(e), tg = e.telegraph;
    b.pelvis.position.y = 2.05 + Math.abs(Math.sin(ph)) * 0.09 * sp + (e.state === 'stagger' ? -0.22 : 0);
    b.pelvis.rotation.z = Math.sin(ph) * 0.06 * sp; b.pelvis.rotation.x = e.tilt;
    const raise = seg(sw, 0, 0.24), crash = seg(sw, 0.27, 0.36), rec = seg(sw, 0.5, 1);
    b.torso.rotation.x = damp(b.torso.rotation.x, 0.06 - 0.34 * raise + 0.9 * crash - 0.6 * rec, 13, dt);
    b.torso.rotation.y = damp(b.torso.rotation.y, -Math.sin(ph) * 0.12 * sp, 6, dt);
    if (e.alert) aimAt(b.head, A.eye, 0.85, 0.5, 5, dt); else relaxBone(b.head, 2, dt);
    const armUp = 2.5 * raise - 3.5 * crash + 1.0 * rec;
    for (const n of ['R', 'L']) {
      const s = n === 'R' ? 1 : -1;
      b['sh' + n].rotation.x = damp(b['sh' + n].rotation.x, Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 0.35 * sp - armUp, 13, dt);
      b['sh' + n].rotation.z = damp(b['sh' + n].rotation.z, -s * (0.2 + 0.32 * raise - 0.3 * rec + tg * 0.15), 6, dt);
      b['el' + n].rotation.x = damp(b['el' + n].rotation.x, -0.42 - 0.45 * raise + 0.5 * rec, 8, dt);
    }
    if (e.onGround) stepLegs(e.legs, b.pelvis, e.velocity, dt, t, A.heightAt, e.gait);
  },
};

// ---------------------------------------------------------------- WRAITH: hooded revenant, floats, robe swirls into smoke
// Rebuilt from tools/out/assetgen/tripo/wraith-hq.glb (render wraith-hq-render.jpg). Wave-3 shadowfen verdict,
// on Shadowfen's headline creature: "renders as a flat violet balloon with the reed geometry poking through
// its shell". Half of that was the shield bubble (flat-shaded icosahedron — fixed in Enemy.js); the other half
// was this body, which was ONE downward cone plus ONE smooth sphere, i.e. literally a balloon on a cone.
// Identity-defining features the reference has and the old body did not, in priority order:
//   1. A SWIRLING SKIRT, not a cone. The bottom third is a vortex of ~14 curling tendrils that sweep OUTWARD
//      and all twist the same way, so the creature reads as smoke caught mid-rotation. That silhouette is the
//      whole creature at 40 m and it is the thing the hem dissolve (materials.js uGhost) then eats into.
//   2. A DEEP HOOD with an overhanging brow and a peaked, folded crown — a hollow you can see INTO, not a
//      cone with two dots on it.
//   3. LONG REACHING ARMS with bony four-fingered hands, held forward and low: the pose is grasping.
//   4. A layered shoulder mantle and a fluted robe: cloth in courses, so grazing light has edges to catch.
// ~1.5k tris (the old one was ~1.0k but spent 384 of it on two smooth spheres).
const WR_TEND = 11, WR_TEND2 = 5;
const wraith = {
  build() {
    const R = new Rig(), { root } = R;      // root = body centre (flyer)
    // lifted off near-black on purpose: the ethereal shader (uGhost) multiplies the LIT terms down toward the
    // centre, so a robe that starts at 0x2a2733 comes out as a hole in the world instead of a ghost.
    const CLOTH = 0x393343, CLOTH2 = 0x4b4459, CLOTH3 = 0x5c5470, BONE = 0x8a8098, GLOW = 0xffffff, HOLLOW = 0x07070d;
    const body = R.bone('body', root, 0, 0, 0);
    // ---- torso: a fluted robe. Six drape panels round a core, each leaning out a little, so the trunk has
    // vertical edges instead of being one smooth lit volume (the "balloon" read is a volume with no edges).
    R.part(body, prim.coneS(), { p: [0, -0.34, 0], r: [Math.PI, 0, 0], s: [0.40, 0.92, 0.36], color: CLOTH, mottle: 0.26 });
    R.part(body, prim.sphereMid(), { p: [0, 0.22, -0.01], s: [0.33, 0.28, 0.30], color: CLOTH2, mottle: 0.22 });          // chest/shoulder mass
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2 + 0.5;
      link(R, body, [Math.cos(a) * 0.26, 0.10, Math.sin(a) * 0.24], [Math.cos(a + 0.34) * 0.40, -0.72, Math.sin(a + 0.34) * 0.37], 0.16,
        { color: i % 2 ? CLOTH : CLOTH2, mottle: 0.30, taper: 0.35, w2: 0.10 });
    }
    // ---- shoulder mantle: three lames a side, rolled edge outward. The reference's cowl is its widest point.
    R.mirror(body, prim.prism(0.5), { p: [0.33, 0.30, -0.02], r: [0, 0, 0.62], s: [0.34, 0.20, 0.32], color: CLOTH3, mottle: 0.16 });
    R.mirror(body, prim.prism(0.6), { p: [0.37, 0.16, 0.02], r: [0, 0, 0.86], s: [0.29, 0.17, 0.28], color: CLOTH2, mottle: 0.2 });
    R.mirror(body, prim.prism(0.7), { p: [0.36, 0.01, -0.03], r: [0, 0, 1.02], s: [0.23, 0.14, 0.24], color: CLOTH, mottle: 0.24 });
    R.part(body, prim.prism(0.8), { p: [0, 0.10, -0.28], r: [-0.22, 0, 0], s: [0.44, 0.52, 0.10], color: CLOTH, mottle: 0.28 });   // back cloak
    // ---- hood: peak, brow, cowl ring, and a hollow with two coals in it
    const head = R.bone('head', body, 0, 0.52, 0);
    R.part(head, prim.hex(), { p: [0, 0.34, -0.01], r: [0, 0.52, 0], s: [0.29, 0.09, 0.28], color: CLOTH3, flat: true, mottle: 0.14 });        // cowl ring
    R.part(head, prim.coneS(), { p: [0, 0.64, -0.04], r: [-0.10, 0.45, 0], s: [0.32, 0.56, 0.34], color: CLOTH2, mottle: 0.18 });             // hood
    R.part(head, prim.coneS(), { p: [0, 0.95, -0.08], r: [0.30, 0.9, 0], s: [0.15, 0.34, 0.16], color: CLOTH, mottle: 0.22 });                 // peaked crown fold, tipped BACK
    R.part(head, prim.prism(0.45), { p: [0, 0.68, 0.19], r: [-0.62, 0, 0], s: [0.31, 0.24, 0.14], color: CLOTH3, mottle: 0.16 });               // overhanging brow
    R.part(head, prim.sphereMid(), { p: [0, 0.53, 0.09], s: [0.16, 0.17, 0.14], color: HOLLOW, mottle: 0.04 });                                  // nothing inside it
    R.mirror(head, prim.octa(), { p: [0.072, 0.55, 0.19], s: 0.040, color: GLOW, glow: 1, flat: true });                                        // eyes
    R.mirror(head, prim.prism(0.6), { p: [0.22, 0.50, 0.04], r: [0.1, 0, 0.30], s: [0.13, 0.38, 0.18], color: CLOTH2, mottle: 0.2 });          // hood cheeks
    // hood streamers: cloth licks trailing back off the cowl (the reference has six of them, all curling one way)
    for (let i = 0; i < 4; i++) {
      const sx = i < 2 ? 1 : -1, k = i % 2;
      link(R, head, [sx * 0.22, 0.42 + k * 0.16, -0.10], [sx * (0.36 + k * 0.09), 0.58 + k * 0.20, -0.42 - k * 0.12], 0.052,
        { color: CLOTH, mottle: 0.34, taper: 0.2, geo: prim.coneS() });
    }
    // ---- arms: reaching forward and low, bony four-fingered hands
    for (const [n, sx] of [['R', 1], ['L', -1]]) {
      const sh = R.bone('sh' + n, body, sx * 0.38, 0.22, 0.04), el = R.bone('el' + n, sh, 0, -0.40, 0);
      R.part(sh, prim.limbS(0.62), { p: [sx * 0.39, 0.20, 0.06], s: [0.085, 0.42, 0.085], color: CLOTH2, mottle: 0.2 });
      R.part(sh, prim.coneS(), { p: [sx * 0.39, 0.08, 0.06], r: [Math.PI, 0, 0], s: [0.155, 0.34, 0.155], color: CLOTH, mottle: 0.3 });         // bell sleeve
      R.part(el, prim.limbS(0.5), { p: [sx * 0.39, -0.20, 0.14], r: [-0.28, 0, 0], s: [0.058, 0.40, 0.058], color: BONE, mottle: 0.24 });
      R.part(el, prim.prism(0.8), { p: [sx * 0.39, -0.60, 0.26], r: [0.55, 0, 0], s: [0.105, 0.09, 0.12], color: BONE, mottle: 0.2 });          // palm
      for (let f = 0; f < 4; f++) {                                        // long grasping fingers, splayed
        const fx = sx * (0.39 + (f - 1.5) * 0.042), sp = (f - 1.5) * 0.20;
        link(R, el, [fx, -0.63, 0.29], [fx + sx * 0.04 + sp * 0.04, -0.73 - Math.abs(f - 1.5) * 0.02, 0.43], 0.019,
          { color: BONE, mottle: 0.18, geo: prim.coneS() });
      }
      R.part(el, prim.crystal(), { p: [sx * 0.39, -0.46, 0.19], r: [0.55, 0, 0], s: [0.042, 0.12, 0.042], color: GLOW, glow: 1, flat: true });  // wrist ember
    }
    // ---- THE SKIRT: a vortex of curling tendrils. All twist the same way (SWIRL > 0) so the mass reads as
    // rotating smoke; the outer ring flares wide and curls its tips back UP, the inner ring hangs closer.
    // Each tendril is its own bone so the animation can drift them independently.
    const SWIRL = 1.15;
    for (let i = 0; i < WR_TEND; i++) {
      const rb = R.bone('rag' + i, body, 0, -0.55, 0);
      const a = i / WR_TEND * Math.PI * 2 + 0.31, long = 0.86 + (i % 3) * 0.16;
      const p0 = [Math.cos(a) * 0.20, -0.42, Math.sin(a) * 0.19];
      const a1 = a + SWIRL * 0.45, p1 = [Math.cos(a1) * 0.40, -0.42 - long * 0.44, Math.sin(a1) * 0.38];
      const a2 = a + SWIRL, p2 = [Math.cos(a2) * 0.60, -0.42 - long * 0.72, Math.sin(a2) * 0.56];
      const a3 = a + SWIRL * 1.45, p3 = [Math.cos(a3) * 0.68, -0.42 - long * 0.60, Math.sin(a3) * 0.63];   // tip curls back up
      link(R, rb, p0, p1, 0.088, { color: i % 2 ? CLOTH : CLOTH2, mottle: 0.30, taper: 0.6, w2: 0.062 });
      link(R, rb, p1, p2, 0.062, { color: CLOTH, mottle: 0.34, taper: 0.5, w2: 0.044 });
      link(R, rb, p2, p3, 0.044, { color: CLOTH2, mottle: 0.36, geo: prim.coneS() });
    }
    for (let i = 0; i < WR_TEND2; i++) {                                    // inner ring: fills the vortex core
      const rb = R.bone('rig' + i, body, 0, -0.40, 0), a = i / WR_TEND2 * Math.PI * 2;
      const p0 = [Math.cos(a) * 0.12, -0.30, Math.sin(a) * 0.11];
      const a1 = a + 0.7, p1 = [Math.cos(a1) * 0.26, -0.86, Math.sin(a1) * 0.24];
      const a2 = a + 1.25, p2 = [Math.cos(a2) * 0.34, -1.10, Math.sin(a2) * 0.31];
      link(R, rb, p0, p1, 0.062, { color: CLOTH2, mottle: 0.3, taper: 0.55, w2: 0.045 });
      link(R, rb, p1, p2, 0.042, { color: CLOTH, mottle: 0.34, geo: prim.coneS() });
    }
    return R.build();
  },
  setup(e) {
    e.rags = []; for (let i = 0; i < WR_TEND; i++) e.rags.push(e.bones['rag' + i]);
    e.rigs = []; for (let i = 0; i < WR_TEND2; i++) e.rigs.push(e.bones['rig' + i]);
  },
  animate(e, dt, t, A) {
    const b = e.bones, tt = t + e.seedT, sw = SW(e), reach = seg(sw, 0, 0.3) - seg(sw, 0.34, 0.5);
    b.body.position.y = Math.sin(tt * 1.1) * 0.16 + Math.sin(tt * 2.3) * 0.05 + (e.state === 'stagger' ? -0.2 : 0);
    b.body.rotation.z = Math.sin(tt * 0.7) * 0.09;
    b.body.rotation.y = Math.sin(tt * 0.31) * 0.10;                    // the whole revenant turns slowly on its own axis
    b.body.rotation.x = e.tilt * 0.5 + reach * 0.2;
    if (e.alert) aimAt(b.head, A.eye, 1.1, 0.6, 6, dt); else relaxBone(b.head, 1.5, dt);
    for (const n of ['R', 'L']) {
      const s = n === 'R' ? 1 : -1;
      b['sh' + n].rotation.x = damp(b['sh' + n].rotation.x, -0.25 - reach * 1.5 + Math.sin(tt * 0.9 + s) * 0.12, 9, dt);
      b['sh' + n].rotation.z = damp(b['sh' + n].rotation.z, -s * (0.35 - reach * 0.25) + Math.sin(tt * 0.6 + s * 2) * 0.08, 5, dt);
      b['el' + n].rotation.x = damp(b['el' + n].rotation.x, -0.55 + reach * 0.5, 8, dt);
    }
    // the skirt turns as one vortex plus a per-tendril wobble: a rotating mass reads as smoke, a set of
    // independently flapping rags reads as laundry. Speed adds sweep-back, the telegraph winds it up.
    const spin = tt * (0.55 + e.speedN * 0.9 + e.telegraph * 1.8);
    for (let i = 0; i < WR_TEND; i++) {
      const r = e.rags[i];
      r.rotation.y = Math.sin(spin - i * 0.42) * 0.22 + spin * 0.10;
      r.rotation.x = Math.sin(tt * 1.3 + i * 1.4) * 0.13 + e.speedN * 0.30;
      r.rotation.z = Math.cos(tt * 1.1 + i * 2.1) * 0.11;
    }
    for (let i = 0; i < WR_TEND2; i++) {
      const r = e.rigs[i];
      r.rotation.y = Math.sin(spin * 1.3 + i * 0.9) * 0.26 - spin * 0.14;
      r.rotation.x = Math.sin(tt * 1.7 + i * 2.2) * 0.16;
    }
  },
};

// ---------------------------------------------------------------- SERPENT: long segmented swimmer of air or sea
const serpent = {
  build() {
    const R = new Rig(), { root } = R;      // root = body centre (flyer); +Z forward, segments run back along -Z
    const SCALE1 = 0x2f6a72, SCALE2 = 0x9fd8c8, FIN = 0xffffff, GLOW = 0xffffff;
    const SEGS = 7, GAP = 0.62;
    let parent = root, seg0 = null;
    for (let i = 0; i < SEGS; i++) {
      const b = R.bone('seg' + i, parent, 0, 0, i ? -GAP : 0); parent = b; if (!i) seg0 = b;
      const z = -GAP * i, s = 0.30 * (1 - i * 0.085);
      R.part(b, prim.sphere(), { p: [0, 0, z], s: [s, s * 0.92, 0.4], color: i % 2 ? SCALE1 : SCALE2, mottle: 0.16 });
      R.part(b, prim.hex(), { p: [0, s * 0.85, z], r: [0.2, 0, 0], s: [s * 0.5, 0.05, 0.26], color: SCALE1, flat: true, mottle: 0.1 });   // dorsal plate
      if (i % 2 === 1) R.mirror(b, prim.membrane(2), { p: [s * 1.1, 0.02, z], r: [0, 0, 0.55], s: [0.44, 0.09, 0.36], color: FIN, glow: 0.3, flat: true });
      if (i === SEGS - 1) R.mirror(b, prim.membrane(3), { p: [0.22, 0.05, z - 0.34], r: [0, 0.5, 1.15], s: [0.62, 0.1, 0.5], color: FIN, glow: 0.35, flat: true });   // tail fluke
    }
    const head = R.bone('head', seg0, 0, 0, 0.5);
    R.part(head, prim.sphere(), { p: [0, 0, 0.7], s: [0.29, 0.27, 0.42], color: SCALE1 });
    R.part(head, prim.boxB(), { p: [0, -0.05, 1.05], r: [0.09, 0, 0], s: [0.21, 0.15, 0.31], color: SCALE1, mottle: 0.18 });   // snout
    R.mirror(head, prim.sphere(), { p: [0.14, 0.09, 0.86], s: 0.055, color: GLOW, glow: 1 });
    R.mirror(head, prim.membrane(3), { p: [0.3, 0.14, 0.6], r: [0, 0.3, 0.75], s: [0.5, 0.1, 0.42], color: FIN, glow: 0.4, flat: true });   // head fins
    R.part(head, prim.crystal(), { p: [0, 0.28, 0.62], r: [-0.3, 0, 0], s: [0.08, 0.28, 0.08], color: GLOW, glow: 0.9, flat: true });       // crest
    for (let i = 0; i < 4; i++) R.mirror(head, prim.cone(), { p: [0.13, -0.12, 1.16 - i * 0.06], r: [Math.PI * 0.55, 0, 0.2], s: [0.03, 0.09, 0.03], color: FIN, glow: 0.3, flat: true });   // teeth
    return R.build();
  },
  setup(e) { e.segs = []; for (let i = 0; i < 7; i++) e.segs.push(e.bones['seg' + i]); },
  animate(e, dt, t, A) {
    const b = e.bones, tt = t + e.seedT, sw = SW(e);
    const drive = 0.9 + e.speedN * 1.6 + e.telegraph * 0.8;
    // lateral undulation down the chain: each segment lags the one in front, amplitude grows toward the tail
    for (let i = 0; i < e.segs.length; i++) {
      const s = e.segs[i];
      s.rotation.y = Math.sin(tt * (2.2 + e.speedN * 1.6) - i * 0.85) * 0.20 * drive * (0.45 + i * 0.13);
      s.rotation.x = Math.sin(tt * 1.3 - i * 0.6) * 0.055 * drive + (i === 0 ? e.tilt * 0.6 : 0);
    }
    // strike: the head lunges forward
    const lunge = seg(sw, 0.05, 0.34) - seg(sw, 0.36, 0.6);
    b.head.position.z = 0.5 + lunge * 0.45;
    if (e.alert) aimAt(b.head, A.eye, 0.9, 0.7, 7, dt); else relaxBone(b.head, 2, dt);
  },
};

// ---------------------------------------------------------------- FROSTWOLF: shaggy tundra quadruped
// Built from tools/out/assetgen/tripo/frostwolf-hq.glb (concept frostwolf-hq.webp, render frostwolf-hq-render.jpg).
// It used to wear the hound's body, which is an ARC creature with a crystal mane — so Frostveil's headline
// pack animal was a violet aether hound painted pale blue, wearing shards of a different element.
// Identity-defining features of the reference, in priority order:
//   1. A HUGE SHAGGY RUFF — a spiked collar of fur around the neck and shoulders, twice the width of the
//      skull, continuing as a crest down the spine and as feathering on the elbows, haunches and tail.
//      Where the hound has crystal, this has fur; it is the whole difference between the two silhouettes.
//   2. HEAD CARRIED LOW — at or below the withers, muzzle out front: a hunting stance, not the hound's
//      alert hyena topline.
//   3. Narrow snarling muzzle with a visible tooth line, ears up and forward, big splayed paws, dark claws.
//   4. Thick brush tail carried LOW (the hound's is an up-curled S).
//   5. Palette: white with pale ice-blue mottling. NOTHING on it is emissive except the eyes — an ice
//      creature made of glowing parts in a white snowfield is the blob bug with extra steps.
// The skeleton is deliberately hound-identical (same bone names, same hip/knee spacing, same 0.4+0.4 leg),
// so it reuses hound.setup/animate — a new gait table and a low tail carry are the only behavioural deltas.
const frostwolf = {
  build() {
    const R = new Rig(), { root } = R;
    // COUNTERSHADED, and not as decoration: an all-white wolf on a snowfield is literally invisible — at 22 m
    // in Frostveil the first pass was a nameplate over nothing (tools/out/c2-final/shot-frostwolf-tundra-22m.png).
    // Dark blue-grey saddle over the back and mane, mid on the flanks, white underneath, dark muzzle mask and
    // paws: the same two-value read a real snow-country wolf has, and it holds at every range.
    const FUR = 0xeef3fa, FUR2 = 0xc0d6ea, ICE = 0x86accf, SADDLE = 0x5f7f9f, DARK = 0x40566c, GUM = 0x5d4a52, CLAW = 0x232932, GLOW = 0xffffff;
    const coatCol = (c) => (c > 0.35 ? SADDLE : c > -0.2 ? ICE : FUR2);   // c = cos(ring angle): 1 = spine, -1 = belly
    const body = R.bone('body', root, 0, 0.76, 0);
    // ---- torso: level topline, deep chest, tucked waist, heavy haunches
    R.part(body, prim.sphereLo(), { p: [0, 0.80, 0.26], s: [0.32, 0.32, 0.42], color: FUR2, mottle: 0.26 });
    R.part(body, prim.sphereLo(), { p: [0, 0.88, 0.04], s: [0.31, 0.25, 0.32], color: SADDLE, mottle: 0.28 });
    R.part(body, prim.sphereLo(), { p: [0, 0.76, -0.22], s: [0.25, 0.25, 0.34], color: ICE, mottle: 0.26 });
    R.part(body, prim.sphereLo(), { p: [0, 0.77, -0.52], s: [0.29, 0.28, 0.30], color: FUR2, mottle: 0.26 });
    R.part(body, prim.sphereLo(), { p: [0, 0.60, 0.02], s: [0.21, 0.16, 0.46], color: FUR, mottle: 0.16 });
    R.mirror(body, prim.sphereLo(), { p: [0.20, 0.74, -0.48], s: [0.16, 0.20, 0.22], color: ICE, mottle: 0.28 });
    // ---- THE RUFF: a ring of fur spikes around the neck root, longest over the shoulders, sweeping back.
    // Rz(-a) aims the cone radially out of the ring, Rx tips the top of the ring back over the withers — and
    // the centre is pushed OUT along that same direction by half the cone's length. The first pass put the
    // centres on the ring itself, which buried half of every spike inside the torso and left the wolf reading
    // as a smooth balloon (tools/out/c2-tt/shot-frostwolf-090.png).
    const ruff = (a, len, ring, z, k, w, col) => {
      const c = Math.cos(a), sn = Math.sin(a), cx = Math.cos(k), sk = Math.sin(k);   // k = the Rx tip-back angle
      R.part(body, prim.cone(), { p: [sn * ring + sn * len * 0.5, 0.86 + c * ring * 0.9 + c * cx * len * 0.5, z - c * sk * len * 0.5], r: [k, 0, -a], s: [w, len, w * 0.8], color: col, mottle: 0.30, flat: true });
    };
    // WIDE and SHORT, and raked well back: at 0.095 x 0.62 the first spread read as a crown of icicles rather
    // than a coat (tools/out/c2-tt2/shot-frostwolf-close.png). Fur is a dense mass of blunt clumps.
    for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2; ruff(a, 0.27 + Math.cos(a) * 0.12, 0.23, 0.26, -0.95, 0.135, coatCol(Math.cos(a))); }
    for (let i = 0; i < 10; i++) { const a = (i + 0.5) / 10 * Math.PI * 2; ruff(a, 0.21 + Math.cos(a) * 0.09, 0.21, 0.09, -1.15, 0.115, coatCol(Math.cos(a) - 0.15)); }
    // ---- shaggy coat: tufts scattered over the barrel on a golden-angle spiral, so the torso spheres read as
    // a coat instead of the string of white balloons the first pass produced.
    for (let i = 0; i < 18; i++) {
      const k = i / 17, a = (i * 2.39996) % (Math.PI * 2), c = Math.cos(a), sn = Math.sin(a);
      const rr = 0.235 + Math.sin(k * 3.1) * 0.045, len = 0.15 + (i % 3) * 0.04;
      R.part(body, prim.cone(), { p: [sn * (rr + len * 0.4), 0.79 + c * (rr * 0.85 + len * 0.25), 0.24 - k * 0.80 - len * 0.34], r: [-0.75, sn * 0.75, -a], s: [0.105, len, 0.085], color: coatCol(c), mottle: 0.34, flat: true });
    }
    // ---- crest down the spine, feathering on the haunch and elbow
    for (let i = 0; i < 8; i++) {
      const k = i / 7;
      R.part(body, prim.cone(), { p: [0, 0.98 - k * 0.16, -0.02 - k * 0.62], r: [-1.25 - k * 0.15, 0, 0], s: [0.085, 0.16 - k * 0.06, 0.070], color: SADDLE, mottle: 0.32, flat: true });
    }
    for (const [px, py, pz, rx, rz, len] of [[0.22, 0.70, -0.56, -1.1, -1.15, 0.26], [0.20, 0.60, -0.40, -0.8, -1.45, 0.20], [0.20, 0.72, 0.30, -0.5, -1.30, 0.20]])
      R.mirror(body, prim.cone(), { p: [px, py, pz], r: [rx, 0, rz], s: [0.065, len, 0.06], color: ICE, mottle: 0.32, flat: true });
    // ---- neck carried LOW and forward, head at/below the withers
    const neck = R.bone('neck', body, 0, 0.06, 0.50);
    R.part(neck, prim.limb(0.88), { p: [0, 0.94, 0.46], r: [-1.32, 0, 0], s: [0.155, 0.36, 0.165], color: ICE });
    const head = R.bone('head', neck, 0, -0.04, 0.28);
    R.part(head, prim.sphereLo(), { p: [0, 0.82, 0.86], s: [0.155, 0.155, 0.19], color: ICE });
    R.part(head, prim.slab(0.62), { p: [0, 0.757, 1.06], r: [-1.47, 0, 0], s: [0.115, 0.26, 0.10], color: FUR, mottle: 0.16 });        // narrow muzzle: white, against the dark mask
    R.part(head, prim.octa(), { p: [0, 0.772, 1.19], s: [0.042, 0.036, 0.036], color: CLAW, flat: true });                              // nose leather
    R.part(head, prim.hex(), { p: [0, 0.83, 1.02], r: [1.62, 0, 0], s: [0.05, 0.22, 0.045], color: SADDLE, mottle: 0.14, flat: true }); // nasal ridge / mask
    R.mirror(head, prim.hex(), { p: [0.075, 0.885, 0.945], r: [0.30, 0, 0.90], s: [0.070, 0.040, 0.135], color: SADDLE, mottle: 0.16, flat: true });  // brow
    R.mirror(head, prim.crystal(), { p: [0.079, 0.868, 0.985], s: 0.030, color: GLOW, glow: 1, flat: true });                           // eyes (the only emissive on it)
    for (let i = 0; i < 3; i++) R.mirror(head, prim.cone(), { p: [0.125, 0.83 - i * 0.055, 0.86 - i * 0.02], r: [-0.35, 0, -(1.15 + i * 0.14)], s: [0.05, 0.20 - i * 0.03, 0.045], color: i % 2 ? ICE : FUR2, mottle: 0.3, flat: true });  // cheek fur
    R.mirror(head, prim.cone(), { p: [0.083, 1.00, 0.755], r: [-0.22, 0, -0.26], s: [0.055, 0.20, 0.035], color: SADDLE });             // ears UP and forward
    R.mirror(head, prim.cone(), { p: [0.083, 0.985, 0.775], r: [-0.22, 0, -0.26], s: [0.033, 0.15, 0.022], color: DARK });
    for (let i = 0; i < 2; i++) R.mirror(head, prim.cone(), { p: [0.048, 0.702, 1.13 - i * 0.075], r: [Math.PI, 0, 0], s: [0.016, 0.055, 0.015], color: 0xf4f6fa });   // upper fangs
    const jaw = R.bone('jaw', head, 0, -0.072, 0.10);
    R.part(jaw, prim.slab(0.70), { p: [0, 0.695, 1.03], r: [-1.50, 0, 0], s: [0.095, 0.24, 0.055], color: GUM, mottle: 0.16 });
    for (let i = 0; i < 2; i++) R.mirror(jaw, prim.cone(), { p: [0.042, 0.723, 1.10 - i * 0.075], s: [0.014, 0.048, 0.013], color: 0xf4f6fa });                        // lower fangs
    // ---- tail: carried LOW, brush of fur along it (the hound's is an up-curled S with crystal on top)
    const t0 = R.bone('tail0', body, 0, 0.02, -0.74), t1 = R.bone('tail1', t0, 0, -0.052, -0.295), t2 = R.bone('tail2', t1, 0, -0.088, -0.262);
    R.part(t0, prim.cyl(), { p: [0, 0.735, -0.895], r: [-1.75, 0, 0], s: [0.072, 0.30, 0.072], color: ICE });
    R.part(t1, prim.cyl(), { p: [0, 0.645, -1.175], r: [-1.90, 0, 0], s: [0.060, 0.28, 0.060], color: ICE });
    R.part(t2, prim.cyl(), { p: [0, 0.530, -1.415], r: [-2.05, 0, 0], s: [0.046, 0.24, 0.046], color: SADDLE });
    for (let i = 0; i < 10; i++) {
      const k = i / 9, bn = k < 0.34 ? t0 : k < 0.7 ? t1 : t2, a = (i % 2 ? 1 : -1) * (0.9 + (i % 3) * 0.3);
      R.part(bn, prim.cone(), { p: [Math.sin(a) * 0.07, 0.76 - k * 0.24 + Math.cos(a) * 0.06, -0.86 - k * 0.60], r: [-0.35, 0, -a], s: [0.06, 0.22 - k * 0.05, 0.05], color: k > 0.6 ? SADDLE : ICE, mottle: 0.34, flat: true });
    }
    // ---- legs: long and wiry, big splayed paws. Same hip/knee layout the hound rig uses (0.4 + 0.4 IK).
    const legs = [['FL', 0.22, 0.40, 0], ['FR', -0.22, 0.40, 1], ['HL', 0.21, -0.50, 1], ['HR', -0.21, -0.50, 0]];
    for (const [n, x, z] of legs) {
      const front = z > 0;
      const hip = R.bone('hip' + n, body, x, 0, z), knee = R.bone('knee' + n, body, x, -0.4, z);
      R.part(hip, prim.limb(0.58), { p: [x, 0.78, z], s: [front ? 0.098 : 0.112, 0.42, front ? 0.104 : 0.122], color: ICE });
      R.part(hip, prim.sphereLo(), { p: [x, 0.73, z], s: [0.105, 0.135, 0.135], color: SADDLE, mottle: 0.16 });
      R.part(hip, prim.cone(), { p: [x + Math.sign(x) * 0.055, 0.60, z - 0.03], r: [-0.4, 0, -Math.sign(x) * 1.5], s: [0.055, 0.21, 0.05], color: ICE, mottle: 0.32, flat: true });   // elbow feather
      R.part(knee, prim.limb(0.78), { p: [x, 0.36, z], s: [0.066, 0.36, 0.070], color: FUR2 });
      R.part(knee, prim.slab(0.80), { p: [x, 0.045, z + (front ? 0.05 : -0.02)], s: [0.150, 0.090, 0.245], color: FUR, mottle: 0.14 });   // splayed paw
      for (const dx of [0.038, -0.038]) R.part(knee, prim.cone(), { p: [x + dx, 0.022, z + (front ? 0.17 : 0.10)], r: [1.45, 0, 0], s: [0.020, 0.062, 0.020], color: CLAW });
    }
    return { ...R.build(), legDefs: legs.map(([n, x, z, g]) => ({ n, x, z, g })) };
  },
  setup(e, asset) { hound.setup(e, asset); e.gait = { stepLen: 0.38, stepTime: 0.185, lift: 0.15, lead: 0.15 }; },
  animate(e, dt, t, A) {
    hound.animate(e, dt, t, A);
    // a wolf carries its tail LOW and only lifts it in a chase; the hound's up-curled S is its own read.
    for (let i = 0; i < 3; i++) e.tail[i].rotation.x = -0.18 + e.speedN * 0.34 - i * 0.05 + (e.state === 'flee' ? -0.5 : 0);
  },
};

// ---------------------------------------------------------------- TREANT: walking tree, root feet, canopy
// Built from tools/out/assetgen/tripo/treant-hq.glb (concept treant-hq.webp, render treant-hq-render.jpg).
// It used to wear the golem's body — a boulder pile with a crystal in its chest — so Whisperwood's elite was
// a rock monster tinted acid green (and the def had its palette pair reversed, so the bark took the bright
// green as a TINT and the heartwood glowed brown; fixed in defs.js alongside this).
// Identity-defining features of the reference, in priority order:
//   1. ROOT FEET — the legs do not end in feet, they FLARE into a fan of roots splaying onto the ground.
//      It is the single strongest read and no other creature in the bestiary has it.
//   2. A FACE CARVED IN THE TRUNK — heavy brow, long nose, beard of root strands, lit eyes. Not a head on
//      a neck: the top of the trunk IS the head.
//   3. A CANOPY: three clusters of teal foliage, crown plus both shoulders, that sway on their own.
//   4. The trunk and limbs are a BRAID of vines and cords, not a smooth column — verticals everywhere.
//   5. Long knotty arms hanging past the knee, ending in long twig fingers.
//   6. Sap-light in the crevices. Green and dim: a tree lit like a lantern is the blob bug.
const treant = {
  build() {
    const R = new Rig(), { root } = R;
    // VALUE SPREAD, not four browns. The first pass ran BARK 0x6d5c43 against BARK2 0x53452f — one stop apart —
    // and the whole creature merged into a single mossy pillar with no readable face at 5 m
    // (tools/out/c2-tt2/shot-treant-close.png). Lit bark, deep crevice, pale face wood, bright canopy.
    const BARK = 0x8b7554, BARK2 = 0x3f331f, ROOTW = 0x77653f, FACE = 0xa8916a, MOSS = 0x5c7a3c,
          LEAF = 0x4f8f6a, LEAF2 = 0x74b489, GLOW = 0xffffff;
    const pelvis = R.bone('pelvis', root, 0, 1.45, 0);
    R.part(pelvis, prim.sphereLo(), { p: [0, 1.50, 0], s: [0.44, 0.34, 0.38], color: BARK2, mottle: 0.26 });
    // ---- legs: thigh, shin, then a FAN OF ROOTS instead of a foot
    for (const [n, x] of [['L', 0.34], ['R', -0.34]]) {
      const hip = R.bone('hip' + n, pelvis, x, 0, 0), knee = R.bone('knee' + n, pelvis, x, -0.74, 0);
      R.part(hip, prim.limb(0.86), { p: [x, 1.45, 0], s: [0.21, 0.74, 0.21], color: BARK, mottle: 0.26 });
      R.part(knee, prim.limb(1.05), { p: [x, 0.72, 0], s: [0.185, 0.60, 0.185], color: BARK, mottle: 0.26 });
      for (let i = 0; i < 7; i++) {                                    // roots splay out and down onto the ground
        const a = i / 7 * Math.PI * 2 + (x > 0 ? 0.3 : -0.3), reach = 0.34 + (i % 3) * 0.10;
        R.part(knee, prim.slab(0.26), { p: [x + Math.sin(a) * reach * 0.62, 0.15, Math.cos(a) * reach * 0.62], r: [Math.cos(a) * 1.20, 0, -Math.sin(a) * 1.20], s: [0.092, 0.44 + (i % 2) * 0.09, 0.092], color: ROOTW, mottle: 0.3, flat: true });
      }
      R.part(knee, prim.hex(), { p: [x, 0.32, 0], r: [0, 0.4, 0], s: [0.29, 0.12, 0.27], color: BARK2, mottle: 0.24, flat: true });   // ankle burl
    }
    // ---- trunk: two masses + a braid of eight vine cords running up it
    const torso = R.bone('torso', pelvis, 0, 0.42, 0);
    R.part(torso, prim.sphereLo(), { p: [0, 1.98, -0.01], s: [0.50, 0.42, 0.40], color: BARK, mottle: 0.26 });
    R.part(torso, prim.sphereLo(), { p: [0, 2.38, -0.02], s: [0.62, 0.44, 0.48], color: BARK, mottle: 0.26 });
    R.part(torso, prim.slab(0.86), { p: [0, 2.56, -0.02], s: [1.04, 0.22, 0.52], color: BARK2, mottle: 0.24, flat: true });    // shoulder shelf
    // six THICK cords, not eight thin ones: at 0.058 radius the aether rim owned most of each cylinder and the
    // trunk came out as lime-green pinstripes (tools/out/c2-tt/shot-treant-close.png).
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2 + 0.5;
      R.part(torso, prim.cyl(), { p: [Math.sin(a) * 0.46, 2.18, Math.cos(a) * 0.38], r: [Math.cos(a) * 0.16, 0, -Math.sin(a) * 0.16], s: [0.085, 1.05, 0.085], color: i % 2 ? BARK : BARK2, mottle: 0.28 });
    }
    for (let i = 0; i < 5; i++) {                                       // moss patches
      const a = i / 5 * Math.PI * 2 + 0.7;
      R.part(torso, prim.hex(), { p: [Math.sin(a) * 0.50, 2.05 + (i % 3) * 0.26, Math.cos(a) * 0.42], r: [Math.cos(a) * 1.3, 0, -Math.sin(a) * 1.3], s: [0.18, 0.04, 0.15], color: MOSS, mottle: 0.34, flat: true });
    }
    // ---- heartwood: the weak point defs.js aims at ('core' bone, off [0,0,0.07])
    const core = R.bone('core', torso, 0, 0.28, 0.40);
    R.part(core, prim.crystal(), { p: [0, 2.15, 0.44], r: [0.20, 0, 0], s: [0.19, 0.32, 0.15], color: GLOW, glow: 1, flat: true });
    R.part(core, prim.hex(), { p: [0, 2.15, 0.41], r: [1.57, 0, 0], s: [0.26, 0.10, 0.26], color: BARK2, mottle: 0.22, flat: true });   // socket
    // ---- the face is the top of the trunk
    // The face has to sit PROUD of the shoulder shelf and be a lighter wood than the trunk, or it disappears:
    // a head buried in the same brown as the chest is why the last pass had no face at any range.
    const head = R.bone('head', torso, 0, 1.06, 0.06);
    R.part(head, prim.sphereLo(), { p: [0, 3.00, 0.04], s: [0.36, 0.37, 0.34], color: FACE, mottle: 0.24 });
    R.part(head, prim.slab(0.80), { p: [0, 3.13, 0.235], r: [0.26, 0, 0], s: [0.52, 0.16, 0.20], color: BARK2, mottle: 0.24, flat: true });   // heavy brow, dark against the face
    R.part(head, prim.slab(0.55), { p: [0, 2.965, 0.315], r: [-1.25, 0, 0], s: [0.145, 0.34, 0.15], color: FACE, mottle: 0.22, flat: true }); // long nose
    R.mirror(head, prim.crystal(), { p: [0.145, 3.045, 0.265], r: [0, 0, 1.45], s: [0.070, 0.115, 0.050], color: GLOW, glow: 1, flat: true }); // lit eyes
    R.mirror(head, prim.hex(), { p: [0.265, 2.98, 0.15], r: [0.1, 0, 1.30], s: [0.13, 0.06, 0.21], color: BARK, mottle: 0.24, flat: true });   // cheek ridges
    for (let i = 0; i < 6; i++) {                                       // beard of root strands
      const dx = (i - 2.5) * 0.078;
      R.part(head, prim.slab(0.32), { p: [dx, 2.72, 0.235 - Math.abs(dx) * 0.25], r: [-0.30, 0, dx * 1.6], s: [0.058, 0.34 + (i % 2) * 0.09, 0.058], color: ROOTW, mottle: 0.3, flat: true });
    }
    // ---- arms: long, knotty, twig fingers past the knee
    for (const [n, sx] of [['R', 0.66], ['L', -0.66]]) {
      const sh = R.bone('sh' + n, torso, sx, 0.54, 0), el = R.bone('el' + n, sh, 0, -0.70, 0), hd = R.bone('hd' + n, el, 0, -0.66, 0);
      R.part(sh, prim.limb(0.82), { p: [sx, 2.50, 0], s: [0.175, 0.70, 0.175], color: BARK, mottle: 0.26 });
      R.part(sh, prim.cyl(), { p: [sx * 1.06, 2.32, 0.02], r: [0.12, 0, 0.10], s: [0.055, 0.62, 0.055], color: BARK2, mottle: 0.28 });      // vine wrap
      R.part(sh, prim.cone(), { p: [sx * 1.02, 2.15, -0.14], r: [-0.9, 0, -Math.sign(sx) * 0.6], s: [0.05, 0.22, 0.05], color: LEAF2, mottle: 0.34, flat: true }); // elbow sprout
      R.part(el, prim.limb(0.94), { p: [sx, 1.80, 0], s: [0.150, 0.66, 0.150], color: BARK, mottle: 0.26 });
      R.part(el, prim.cyl(), { p: [sx * 1.04, 1.62, 0.02], r: [-0.10, 0, -0.08], s: [0.048, 0.58, 0.048], color: BARK2, mottle: 0.28 });
      R.part(hd, prim.sphereLo(), { p: [sx, 1.12, 0.02], s: [0.155, 0.145, 0.155], color: BARK2, mottle: 0.26 });                            // knuckle burl
      for (let f = 0; f < 4; f++) {                                     // long twig fingers
        const dx = (f - 1.5) * 0.075;
        R.part(hd, prim.slab(0.30), { p: [sx + dx, 0.90, 0.05 + f * 0.012], r: [-0.22, 0, dx * 2.2], s: [0.048, 0.36, 0.048], color: ROOTW, mottle: 0.3, flat: true });
      }
    }
    // ---- canopy: crown + two shoulder clusters, each on its own bone so it sways
    // Crown lifted clear of the brow and the shoulder pair pushed out: the first pass parked the crown on the
    // forehead and the face disappeared behind it at every range.
    for (const [bn, parent, cx, cy, cz, rad] of [['can0', head, 0, 3.62, -0.04, 0.42], ['can1', torso, 0.94, 2.78, -0.06, 0.40], ['can2', torso, -0.94, 2.78, -0.06, 0.40]]) {
      const cb = R.bone(bn, parent, cx, cy - (parent === head ? 2.93 : 1.87), cz);   // bone offsets are parent-local; parts stay root-space
      for (let i = 0; i < 5; i++) {
        const a = i / 5 * Math.PI * 2 + (cx > 0 ? 0.4 : 0.9), r2 = rad * (0.55 + (i % 2) * 0.35);
        R.part(cb, prim.hex(), { p: [cx + Math.cos(a) * r2, cy + (i % 2 ? 0.09 : -0.03), cz + Math.sin(a) * r2 * 0.8], r: [Math.sin(a) * 0.35, a, Math.cos(a) * 0.35], s: [rad * 0.62, rad * 0.30, rad * 0.58], color: i % 2 ? LEAF : LEAF2, mottle: 0.36, flat: true });
      }
      for (let i = 0; i < 3; i++) {                                     // spiky leaf fans breaking the blob outline
        const a = i / 3 * Math.PI * 2 + 1.1;
        R.part(cb, prim.cone(), { p: [cx + Math.cos(a) * rad * 0.7, cy + 0.16, cz + Math.sin(a) * rad * 0.55], r: [Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8], s: [rad * 0.30, rad * 0.62, rad * 0.26], color: LEAF, mottle: 0.36, flat: true });
      }
    }
    return R.build();
  },
  setup(e) {
    const b = e.bones;
    e.legs = [makeLeg(b, 'hipL', 'kneeL', [0.34, 0, 0], [0.40, -1.45, 0.06], 0.74, 0.74, [0, 0, 1], 0),
              makeLeg(b, 'hipR', 'kneeR', [-0.34, 0, 0], [-0.40, -1.45, 0.06], 0.74, 0.74, [0, 0, 1], 1)];
    e.legParent = b.pelvis; e.gait = { stepLen: 0.62, stepTime: 0.44, lift: 0.18, lead: 0.22 };
    e.canopy = [b.can0, b.can1, b.can2];
  },
  animate(e, dt, t, A) {
    const b = e.bones, ph = e.phase, sp = e.speedN, sw = SW(e), tg = e.telegraph;
    b.pelvis.position.y = 1.45 + Math.abs(Math.sin(ph)) * 0.05 * sp + (e.state === 'stagger' ? -0.14 : 0);
    b.pelvis.rotation.z = Math.sin(ph) * 0.045 * sp; b.pelvis.rotation.x = e.tilt;
    const isSlam = e.attackKind === 'slam' || e.attackKind === null, raise = seg(sw, 0, 0.24), crash = seg(sw, 0.28, 0.37), rec = seg(sw, 0.52, 1);
    b.torso.rotation.x = damp(b.torso.rotation.x, 0.06 - 0.28 * raise + 0.90 * crash - 0.62 * rec, 13, dt);
    b.torso.rotation.y = damp(b.torso.rotation.y, -Math.sin(ph) * 0.09 * sp, 6, dt);
    if (e.alert) aimAt(b.head, A.eye, 0.75, 0.45, 4, dt); else relaxBone(b.head, 1.6, dt);
    const armUp = isSlam ? 2.4 * raise - 3.4 * crash + 1.0 * rec : 0;
    for (const n of ['R', 'L']) {
      const s = n === 'R' ? 1 : -1, thr = !isSlam && n === 'R' ? 2.1 * raise - 3.4 * crash + 1.3 * rec : 0;
      b['sh' + n].rotation.x = damp(b['sh' + n].rotation.x, Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 0.28 * sp - armUp - thr, 13, dt);
      b['sh' + n].rotation.z = damp(b['sh' + n].rotation.z, -s * (0.18 + 0.28 * raise - 0.28 * rec), 6, dt);
      b['el' + n].rotation.x = damp(b['el' + n].rotation.x, -0.40 - 0.45 * raise + 0.45 * rec, 8, dt);
    }
    b.core.scale.setScalar(1 + tg * 0.35 + Math.sin(t * 3.4 + e.seedT) * 0.04);
    // canopy sways on its own clock — a tree that walks with a rigid hedge on its head reads as a prop
    for (let i = 0; i < 3; i++) {
      const c = e.canopy[i], tt = t * 0.8 + e.seedT + i * 2.1;
      c.rotation.x = Math.sin(tt) * 0.075 + sp * 0.10 - crash * 0.20;
      c.rotation.z = Math.cos(tt * 0.83) * 0.065;
    }
    if (e.onGround) stepLegs(e.legs, b.pelvis, e.velocity, dt, t, A.heightAt, e.gait);
  },
};

// ---------------------------------------------------------------- RIFTLING: jagged void quadruped, prowls the air
// Built from tools/out/assetgen/tripo/riftling-hq.glb (render riftling-hq-render.jpg). It used to wear the WISP
// body — a glowing orb with halo rings — which is why the wave-3 void verdict measured the Void's own trash mob
// as "a chunky flat pale-pink body with three flat pink ribbon loops orbiting it ... bubblegum plastic".
// The reference is nothing like an orb: a low crouched armoured lizard-panther. Features in priority order:
//   1. A CREST OF LONG BACKSWEPT SPIKES over the neck and shoulders, tallest at the shoulder, dropping down
//      the spine into a spiked tail. It is most of the silhouette and it is what makes it read as void-forged.
//   2. OVERLAPPING ANGULAR PLATES — the whole hide is faceted armour, not skin. Flat-shaded on purpose.
//   3. A low wedge skull carried out FRONT on a short neck, long jaw, four splayed clawed feet.
// It stays `flying: true` (def unchanged — that is its AI): the mass hangs BELOW the root so a hovering
// riftling has its paws just off the ground, prowling on nothing, which is what a rift beast should do.
// The hem dissolve (def.ghost) eats the paws and tail tip, so the "walking on air" never has to be explained.
const riftling = {
  build() {
    const R = new Rig(), { root } = R;      // root = body centre (flyer); mass hangs below it
    // values chosen against the ghost shader, not in isolation: uGhost multiplies the LIT terms down toward the
    // centre, so a hide that starts at 0x2a2438 renders as a black cutout in a green meadow (first pass did).
    const HIDE = 0x4c4468, HIDE2 = 0x635880, PLATE = 0x322a48, HORN = 0x272038, CLAW = 0x191322, GLOW = 0xffffff;
    const body = R.bone('body', root, 0, 0, 0);
    // ---- torso: shoulders high, waist pinched, haunch heavy — a stalking cat's line
    R.part(body, prim.sphereMid(), { p: [0, -0.06, 0.20], s: [0.23, 0.22, 0.30], color: HIDE });
    R.part(body, prim.sphereMid(), { p: [0, -0.10, -0.10], s: [0.18, 0.17, 0.26], color: HIDE2, mottle: 0.22 });
    R.part(body, prim.sphereMid(), { p: [0, -0.08, -0.42], s: [0.21, 0.20, 0.24], color: HIDE });
    R.part(body, prim.prism(0.75), { p: [0, -0.24, 0.02], s: [0.20, 0.10, 0.52], color: PLATE, flat: true, mottle: 0.2 });   // belly plate
    // overlapping dorsal + flank plates: each one tilted a little more than the last, so the light breaks
    for (let i = 0; i < 6; i++) {
      const k = i / 5, z = 0.34 - k * 0.86;
      R.part(body, prim.prism(0.45), { p: [0, 0.11 - k * 0.05, z], r: [0.30 - k * 0.16, 0, 0], s: [0.30 - k * 0.07, 0.09, 0.20], color: PLATE, flat: true, mottle: 0.16 });
      R.mirror(body, prim.prism(0.5), { p: [0.17 - k * 0.02, -0.03 - k * 0.02, z], r: [0, 0, 1.15 - k * 0.2], s: [0.15, 0.07, 0.19], color: HIDE2, flat: true, mottle: 0.18 });
    }
    // ---- THE CREST: backswept spikes, tallest over the shoulder, plus a shorter outboard pair each side
    for (let i = 0; i < 7; i++) {
      const k = i / 6, z = 0.40 - k * 0.92, h = 0.30 - Math.abs(k - 0.18) * 0.26;
      link(R, body, [0, 0.13 - k * 0.05, z], [0, 0.13 - k * 0.05 + h, z - h * 0.85], 0.055,
        { color: i === 1 || i === 2 ? HORN : PLATE, flat: true, mottle: 0.14, geo: prim.coneS(), w2: 0.038 });
      if (i < 4) {
        const hs = h * 0.62;
        for (const sx of [1, -1]) link(R, body, [sx * (0.13 + k * 0.02), 0.05 - k * 0.03, z], [sx * (0.24 + k * 0.03), 0.05 + hs, z - hs * 0.9], 0.042,
          { color: HORN, flat: true, mottle: 0.14, geo: prim.coneS(), w2: 0.03 });
      }
    }
    R.part(body, prim.crystal(), { p: [0, 0.16, 0.16], r: [-0.35, 0, 0], s: [0.045, 0.13, 0.045], color: GLOW, glow: 1, flat: true });   // rift core between the shoulder spikes
    // ---- neck + wedge head, carried out front and low
    const neck = R.bone('neck', body, 0, -0.02, 0.34);
    R.part(neck, prim.limbS(0.85), { p: [0, 0.06, 0.42], r: [-1.30, 0, 0], s: [0.115, 0.24, 0.13], color: HIDE2 });
    R.part(neck, prim.prism(0.5), { p: [0, 0.11, 0.42], r: [-1.1, 0, 0], s: [0.20, 0.10, 0.16], color: PLATE, flat: true, mottle: 0.16 });
    const head = R.bone('head', neck, 0, 0.02, 0.24);
    R.part(head, prim.prism(0.55), { p: [0, 0.01, 0.66], r: [-1.44, 0, 0], s: [0.155, 0.30, 0.145], color: HIDE });          // skull, narrow to the snout
    R.mirror(head, prim.prism(0.5), { p: [0.075, 0.09, 0.60], r: [0.2, 0, 1.05], s: [0.075, 0.06, 0.20], color: PLATE, flat: true, mottle: 0.14 });   // brow ridges
    R.mirror(head, prim.octa(), { p: [0.078, 0.055, 0.61], s: 0.030, color: GLOW, glow: 1, flat: true });                    // eyes
    R.part(head, prim.prism(0.6), { p: [0, -0.065, 0.68], r: [-1.47, 0, 0], s: [0.115, 0.27, 0.065], color: HIDE2, mottle: 0.2 });   // lower jaw
    for (let i = 0; i < 3; i++) {                                                                                            // jaw fangs + cheek spurs
      for (const sx of [1, -1]) R.part(head, prim.coneS(), { p: [sx * 0.055, -0.015 - i * 0.005, 0.72 - i * 0.06], r: [Math.PI, 0, 0], s: [0.016, 0.055, 0.016], color: CLAW, flat: true });
    }
    for (const sx of [1, -1]) link(R, head, [sx * 0.10, 0.03, 0.55], [sx * 0.20, 0.11, 0.38], 0.032, { color: HORN, flat: true, geo: prim.coneS(), w2: 0.024 });   // cheek horns
    // ---- legs: four, tucked and bent. No IK and no gait — it hovers; the paddle is in animate().
    for (const [n, sx, z, fwd] of [['FL', 1, 0.24, 1], ['FR', -1, 0.24, 1], ['HL', 1, -0.34, 0], ['HR', -1, -0.34, 0]]) {
      const hip = R.bone('hip' + n, body, sx * 0.15, -0.12, z), knee = R.bone('knee' + n, hip, 0, -0.24, 0);
      R.part(hip, prim.limbS(0.6), { p: [sx * 0.17, -0.10, z], r: [0, 0, -sx * 0.22], s: [0.070, 0.34, 0.075], color: HIDE2, mottle: 0.2 });
      R.part(hip, prim.prism(0.6), { p: [sx * 0.19, -0.16, z], r: [0, 0, -sx * 0.3], s: [0.10, 0.16, 0.13], color: PLATE, flat: true, mottle: 0.16 });
      R.part(knee, prim.limbS(0.7), { p: [sx * 0.19, -0.40, z + (fwd ? 0.05 : -0.03)], r: [fwd ? 0.30 : -0.30, 0, 0], s: [0.050, 0.28, 0.052], color: HIDE });
      R.part(knee, prim.prism(0.8), { p: [sx * 0.19, -0.66, z + (fwd ? 0.11 : -0.07)], s: [0.095, 0.055, 0.15], color: HIDE2, flat: true, mottle: 0.18 });   // paw
      for (const dx of [0.030, 0, -0.030]) R.part(knee, prim.coneS(), { p: [sx * 0.19 + dx, -0.685, z + (fwd ? 0.19 : -0.15)], r: [fwd ? 1.45 : -1.45, 0, 0], s: [0.015, 0.055, 0.015], color: CLAW, flat: true });
    }
    // ---- tail: four segments, spiked, ending in a blade
    const t0 = R.bone('tail0', body, 0, -0.04, -0.56), t1 = R.bone('tail1', t0, 0, 0.02, -0.26), t2 = R.bone('tail2', t1, 0, 0.04, -0.24), t3 = R.bone('tail3', t2, 0, 0.05, -0.22);
    link(R, t0, [0, -0.04, -0.56], [0, -0.02, -0.82], 0.070, { color: HIDE, flat: true, mottle: 0.2, taper: 0.7, w2: 0.062 });
    link(R, t1, [0, -0.02, -0.82], [0, 0.02, -1.06], 0.055, { color: HIDE2, flat: true, mottle: 0.2, taper: 0.7, w2: 0.048 });
    link(R, t2, [0, 0.02, -1.06], [0, 0.08, -1.28], 0.042, { color: HIDE, flat: true, mottle: 0.22, taper: 0.7, w2: 0.036 });
    link(R, t3, [0, 0.08, -1.28], [0, 0.20, -1.46], 0.055, { color: PLATE, flat: true, mottle: 0.16, geo: prim.coneS(), w2: 0.022 });   // blade fluke
    for (const [bn, z, y, h] of [[t0, -0.66, 0.02, 0.11], [t1, -0.90, 0.04, 0.10], [t2, -1.14, 0.08, 0.085]]) {
      link(R, bn, [0, y, z], [0, y + h, z - h * 0.8], 0.030, { color: HORN, flat: true, geo: prim.coneS(), w2: 0.02 });
    }
    return R.build();
  },
  setup(e) {
    e.legs = null;                                                       // hovers: no IK, no foot planting
    e.rTail = [e.bones.tail0, e.bones.tail1, e.bones.tail2, e.bones.tail3];
    e.rLegs = ['FL', 'FR', 'HL', 'HR'].map((n) => [e.bones['hip' + n], e.bones['knee' + n]]);
  },
  animate(e, dt, t, A) {
    const b = e.bones, tt = t + e.seedT, sw = SW(e), sp = e.speedN;
    const lunge = seg(sw, 0.05, 0.30) - seg(sw, 0.34, 0.62);
    b.body.position.y = Math.sin(tt * 1.5) * 0.09 + Math.sin(tt * 2.9) * 0.03 + (e.state === 'stagger' ? -0.14 : 0);
    b.body.rotation.x = e.tilt * 0.6 - sp * 0.16 + lunge * 0.34;         // noses down as it accelerates, rears on the spit
    b.body.rotation.z = Math.sin(tt * 0.8) * 0.07 + e.strafeLean * 0.14;
    b.neck.rotation.x = damp(b.neck.rotation.x, -0.10 + sp * 0.14 - lunge * 0.30, 9, dt);
    if (e.alert) aimAt(b.head, A.eye, 1.0, 0.7, 7, dt); else { relaxBone(b.head, 2, dt); b.head.rotation.y = Math.sin(tt * 0.6) * 0.4; }
    chainWave(e.rTail, tt + sp, 0.20 + sp * 0.14, 2.4 + sp * 3, 'y', 0.75);
    for (let i = 0; i < 4; i++) e.rTail[i].rotation.x = 0.10 - i * 0.06 + Math.sin(tt * 1.4 - i * 0.6) * 0.07;
    // legs paddle slowly, front and back out of phase — a beast treading air, not a corpse hanging from a hook
    for (let i = 0; i < 4; i++) {
      const [hip, knee] = e.rLegs[i], ph = tt * (1.1 + sp * 2.2) + i * 1.9;
      hip.rotation.x = Math.sin(ph) * (0.18 + sp * 0.34) - 0.12 - lunge * 0.5;
      knee.rotation.x = 0.55 + Math.cos(ph) * (0.16 + sp * 0.26) + lunge * 0.4;
    }
  },
};

// ---------------------------------------------------------------- SPRITE: round moth-fae, four wings, hooded mantle
// Built from tools/out/assetgen/tripo/sprite-hq.glb (render sprite-hq-render.jpg). Like the riftling it used to
// wear the WISP body, so Whisperwood's own trash mob was the Vale's aether orb painted green.
// The reference is a plump moth-fae: a round fluffy body under a filigreed hooded mantle, one huge domed eye
// each side, two pairs of veined wings, two feathered antennae and a pair of long straight quills swept back.
// Features in priority order: 1. the FOUR WINGS (the whole read at range, and the only fast motion on it),
// 2. the round body + hooded mantle silhouette, 3. the oversized eye, which is what makes it fae and not a bug.
const sprite = {
  build() {
    const R = new Rig(), { root } = R;      // root = body centre (flyer)
    const FLUFF = 0xdfe6f2, FLUFF2 = 0xc4d2e8, CLOAK = 0xb4c4dc, TRIM = 0xe8dfc0, WING = 0xf2f6ff, EYE = 0x3a3450, GLOW = 0xffffff;
    const body = R.bone('body', root, 0, 0, 0);
    R.part(body, prim.sphereMid(), { p: [0, -0.02, 0], s: [0.26, 0.25, 0.27], color: FLUFF, mottle: 0.22 });                     // fluffy abdomen
    R.part(body, prim.sphereMid(), { p: [0, -0.20, -0.02], s: [0.19, 0.15, 0.19], color: FLUFF2, mottle: 0.30 });                // under-fluff
    R.part(body, prim.sphereMid(), { p: [0, 0.10, 0.13], s: [0.20, 0.18, 0.19], color: FLUFF2, mottle: 0.2 });                   // thorax
    // hooded mantle: a cowl over the back and shoulders with a trim edge and two filigree scrolls
    R.part(body, prim.coneS(), { p: [0, 0.10, -0.10], r: [-0.30, 0, 0], s: [0.30, 0.36, 0.28], color: CLOAK, flat: true, mottle: 0.16 });
    R.part(body, prim.hex(), { p: [0, -0.06, -0.06], r: [0.2, 0.5, 0], s: [0.30, 0.05, 0.29], color: TRIM, flat: true, mottle: 0.08 });
    R.mirror(body, prim.prism(0.5), { p: [0.20, 0.02, 0.02], r: [0, 0, 0.9], s: [0.14, 0.20, 0.20], color: CLOAK, flat: true, mottle: 0.16 });  // shoulder lappets
    R.mirror(body, prim.ring(), { p: [0.16, 0.06, -0.14], r: [0.4, 0.6, 0], s: 0.10, color: TRIM, mottle: 0.06 });                             // filigree scrolls
    // ---- head: small, mostly eye
    const head = R.bone('head', body, 0, 0.16, 0.20);
    R.part(head, prim.sphereMid(), { p: [0, 0.17, 0.30], s: [0.150, 0.140, 0.140], color: FLUFF, mottle: 0.18 });
    R.part(head, prim.coneS(), { p: [0, 0.27, 0.20], r: [-0.30, 0, 0], s: [0.135, 0.17, 0.14], color: CLOAK, mottle: 0.14 });                   // hood peak, pulled BACK off the brow
    R.mirror(head, prim.sphereMid(), { p: [0.098, 0.165, 0.375], s: [0.098, 0.105, 0.092], color: EYE, mottle: 0.06 });                         // huge domed eyes — the whole face read
    R.mirror(head, prim.octa(), { p: [0.115, 0.195, 0.445], s: 0.030, color: GLOW, glow: 1, flat: true });                                     // catchlight
    for (const sx of [1, -1]) {                                                                                                                // antennae, curling up and out
      link(R, head, [sx * 0.06, 0.28, 0.26], [sx * 0.13, 0.44, 0.20], 0.014, { color: FLUFF2, flat: true });
      link(R, head, [sx * 0.13, 0.44, 0.20], [sx * 0.20, 0.53, 0.10], 0.011, { color: FLUFF2, flat: true, geo: prim.coneS() });
      R.part(head, prim.octa(), { p: [sx * 0.20, 0.53, 0.10], s: 0.022, color: GLOW, glow: 0.8, flat: true });
    }
    // two long straight quills swept back over the mantle — the reference's odd, memorable detail
    for (const sx of [1, -1]) link(R, body, [sx * 0.05, 0.16, -0.05], [sx * 0.12, 0.62, -0.34], 0.014, { color: TRIM, flat: true, geo: prim.coneS(), w2: 0.008 });
    // ---- four wings. membrane() is a cambered scalloped panel (x = span, z = chord, +Z leading edge).
    for (const [n, sx, fore] of [['FR', 1, 1], ['FL', -1, 1], ['HR', 1, 0], ['HL', -1, 0]]) {
      const w = R.bone('w' + n, body, sx * 0.13, fore ? 0.10 : -0.02, fore ? 0.04 : -0.10);
      const span = fore ? 0.46 : 0.31, chord = fore ? 0.36 : 0.27;
      // glow 0.14, NOT 0.30: at 0.30 the wing's green emissive reached ~1.8 linear under the noon dayGlow
      // multiplier and bloomed along the leading edge. And no `flat` — computeVertexNormals on a non-indexed
      // membrane throws away the camber and leaves a flat-shaded sheet, which is what a paper wing looks like.
      R.part(w, prim.membrane(fore ? 3 : 2), { p: [sx * (0.13 + span * 0.5), fore ? 0.24 : 0.04, fore ? 0.00 : -0.16], r: [0, sx > 0 ? -0.35 : Math.PI + 0.35, sx * (fore ? 0.62 : 0.34)], s: [span, 0.09, chord], color: WING, glow: 0.09 });
      for (let i = 0; i < 2; i++) {                                          // veins: two thin ribs per wing, no more — they are 2 px at combat range
        const u = 0.30 + i * 0.34;
        link(R, w, [sx * (0.13 + span * 0.06), fore ? 0.16 : 0.0, fore ? 0.16 : -0.02], [sx * (0.13 + span * 0.92), fore ? 0.16 + span * 0.30 * (u - 0.3) : 0.0, (fore ? 0.02 : -0.18) - chord * (u - 0.15)], 0.010,
          { color: WING, glow: 0.07, w2: 0.006 });
      }
    }
    for (const sx of [1, -1]) for (let i = 0; i < 3; i++) {                   // six tucked legs
      link(R, body, [sx * 0.10, -0.18, 0.10 - i * 0.10], [sx * 0.15, -0.30, 0.06 - i * 0.11], 0.014, { color: FLUFF2, flat: true, geo: prim.coneS() });
    }
    return R.build();
  },
  setup(e) { e.wings = ['FR', 'FL', 'HR', 'HL'].map((n) => e.bones['w' + n]); },
  animate(e, dt, t, A) {
    const b = e.bones, tt = t + e.seedT, sw = SW(e), tg = e.telegraph;
    const beat = tt * (26 + e.speedN * 10);                                  // fast enough to read as a blur, not a flap
    b.body.position.y = Math.sin(tt * 2.4) * 0.07 + Math.sin(beat) * 0.012 + (e.state === 'stagger' ? -0.12 : 0);
    b.body.rotation.x = e.tilt * 0.5 + e.speedN * 0.22 - seg(sw, 0, 0.3) * 0.25 + seg(sw, 0.34, 0.55) * 0.35;
    b.body.rotation.z = Math.sin(tt * 1.3) * 0.10 + e.strafeLean * 0.18;
    if (e.alert) aimAt(b.head, A.eye, 0.9, 0.6, 7, dt); else { relaxBone(b.head, 2, dt); b.head.rotation.y = Math.sin(tt * 0.8) * 0.45; }
    for (let i = 0; i < 4; i++) {
      const w = e.wings[i], sx = i % 2 ? -1 : 1, fore = i < 2;
      const a = Math.sin(beat - (fore ? 0 : 0.7));                          // hind pair lags the fore pair
      w.rotation.z = sx * (a * (fore ? 0.55 : 0.42) + 0.10 + tg * 0.5);
      w.rotation.x = a * 0.16 * (fore ? 1 : -1);
      w.rotation.y = sx * (-0.10 - tg * 0.35);                              // wings spread flat when it charges a bolt
    }
  },
};

// ---------------------------------------------------------------- RAIDER / CAPTAIN (Gloamtide Corsairs)
// ponytail: deliberately minimal. These two ship as rigged GLBs (raider.glb / captain.glb, always in the
// Assets manifest), so this procedural entry exists for the two jobs the pipeline contract demands of it:
// (1) the bind-pose BOUNDING BOX the GLB is normalised against — a 1.85 m human silhouette, which is what
// def.radius/height/center and the standoff ring were tuned to — and (2) an emergency fallback that stands,
// breathes and swings its arms if the .glb ever fails to load. Upgrade path: a real corsair body build if
// the fallback is ever what the player actually sees.
function humanoid(bulk = 1) {
  return {
    build() {
      const R = new Rig(), { root } = R;
      const COAT = 0x3a3244, SKIN = 0x8a705c, TRIM = 0xd9a53a, DARK = 0x241f2e;
      const body = R.bone('body', root, 0, 1.0, 0);
      R.part(body, prim.limb(0.8), { p: [0, 1.25, 0], s: [0.26 * bulk, 0.42, 0.17 * bulk], color: COAT, mottle: 0.12 });   // torso/coat
      R.part(body, prim.box(), { p: [0, 0.92, 0], s: [0.40 * bulk, 0.16, 0.24 * bulk], color: DARK });                     // belt
      R.part(body, prim.box(), { p: [0, 1.03, 0.10], s: [0.10, 0.30, 0.06], color: TRIM, flat: true });                    // sash trim
      const head = R.bone('head', body, 0, 0.62, 0);
      R.part(head, prim.sphereLo(), { p: [0, 1.70, 0], s: [0.135, 0.155, 0.14], color: SKIN });
      R.part(head, prim.hex(), { p: [0, 1.82, 0], s: [0.16, 0.07, 0.16], color: DARK, flat: true });                       // hat brim
      for (const s of [-1, 1]) {
        const arm = R.bone(s > 0 ? 'shL' : 'shR', body, s * 0.30 * bulk, 0.48, 0);
        R.part(arm, prim.limb(0.7), { p: [s * 0.33 * bulk, 1.48, 0], r: [0, 0, -s * 0.12], s: [0.09, 0.56, 0.09], color: COAT });   // prim.limb HANGS from its origin
        R.part(arm, prim.sphereLo(), { p: [s * 0.37 * bulk, 0.90, 0], s: 0.07, color: SKIN });                             // hand
        const leg = R.bone(s > 0 ? 'hipL' : 'hipR', body, s * 0.14, -0.08, 0);
        R.part(leg, prim.limb(0.75), { p: [s * 0.14, 0.96, 0], s: [0.10 * bulk, 0.94, 0.11 * bulk], color: DARK });        // hangs 0.96 -> 0.02: the box FLOOR is the GLB's ground line
        R.part(leg, prim.box(), { p: [s * 0.14, 0.06, 0.05], s: [0.11, 0.12, 0.22], color: 0x1c1824 });                    // boot
      }
      return R.build();
    },
    setup() {},
    animate(e, dt, t) {   // fallback only: breathe + counter-swing so it never reads dead (animcheck idle/move minimums)
      const b = e.bones, tt = t + e.seedT, ph = e.phase;
      if (b.body) { b.body.rotation.x = Math.sin(tt * 1.7) * 0.03 + e.tilt; b.body.rotation.z = -e.strafeLean * 0.1; b.body.updateMatrix(); }
      if (b.head) { b.head.rotation.y = Math.sin(tt * 0.6) * 0.2; b.head.updateMatrix(); }
      const sw = e.speedN * 0.5;
      for (const [n, s] of [['shL', 1], ['shR', -1], ['hipL', -1], ['hipR', 1]]) {
        const bn = b[n]; if (!bn) continue; bn.rotation.x = Math.sin(ph + (s > 0 ? 0 : Math.PI)) * sw; bn.updateMatrix();
      }
    },
  };
}
const raider = humanoid(1), captain = humanoid(1.12);

export const BODIES = { wisp, hound, sentinel, golem, drake, warden, giant, wraith, serpent, frostwolf, treant, riftling, sprite, raider, captain };

/* ================================================================ RIGGED GLB VARIANTS
 * docs/CREATURE-PIPELINE.md: monsters are rigged GLBs now, architecture stays procedural. Nothing above this
 * line changed. Every procedural body is still built at boot and is still the FALLBACK — a missing or failed
 * /assets/creatures/<name>.glb resolves to null in game.assets and Enemies.init keeps the procedural asset —
 * and it is also what supplies the bounding box the GLB is normalised against (src/enemies/glbBody.js), which
 * is how def.radius/height/center, the standoff ring, hover height and def.scale survive the swap untouched.
 *
 * The GLB variant is a second ANIMATOR on the same { setup, animate } contract; the geometry/skeleton come from
 * glbBody. Enemy's constructor picks `(rigged && BODIES[name].glb) || BODIES[name]`, where `rigged` is the
 * flag glbBody stamps on the asset.
 * `wisp` deliberately has none (user decision): it is a glow orb made of emissive prims + orbiting shards, not
 * a mesh, and there is nothing a scanned body would add to it.
 */

// One animator per configured body, profile straight off glbBody's GLB_CFG — that table is the single source
// of truth for "what shape is this rig" (it also carries the yaw, the leg-group classification and the
// headBone for the two rigs Tripo gave no Head chain), and duplicating it here is how the two halves drift.
// No per-creature `tuning` override: glbAnim's TUNE already differentiates quadruped/biped/flyer/hover/serpent,
// and a per-creature number that has never been looked at on screen is a guess wearing a constant's clothes.
// Add one — glbAnimator(cfg.profile, { legSwing: ... }) — when a screenshot says a specific creature reads wrong.
// `wisp` has no GLB_CFG entry, so it never gets a .glb animator; `wayfinder` has one but no procedural body yet,
// hence the BODIES guard.
for (const [name, cfg] of Object.entries(GLB_CFG)) if (BODIES[name]) BODIES[name]['glb'] = glbAnimator(cfg.profile);
