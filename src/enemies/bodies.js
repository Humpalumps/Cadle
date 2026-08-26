import * as THREE from 'three';
import { Rig, prim, makeLeg, stepLegs, plantLegs, chainWave, aimAt, relaxBone, aimBone, damp } from './rig.js';

/**
 * Procedural bodies: one entry per type { build() -> rig asset, setup(e) -> per-instance anim state, animate(e, dt, t, A) }.
 * All parts authored in root space (Y up, +Z forward, root at the feet / ground contact; flyers: root at body center).
 * Bind pose = identity bones. Animations are pure procedural: sine/IK/foot planting on THREE.Bone hierarchies.
 * A = { eye:Vector3 (player eye), heightAt(x,z) }
 */
const ease = (s) => s * s * (3 - 2 * s);
const pulse01 = (t, f) => Math.sin(t * f) * 0.5 + 0.5;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const SW = (e) => (e.state === 'attack' ? e.attackT : 0); // attack progress 0..1 (strike lands at 0.35)
const seg = (x, a, b) => { const k = (x - a) / (b - a); return k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k); };

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
    R.part(core, prim.ico(), { p: [0, 0, 0], s: 0.27, color: 0xffffff, glow: 1, flat: true });                                        // burning aether orb — THE read
    for (let i = 0; i < 4; i++) { // open shell: 4 dark faceted petals with wide gaps, core blazes through
      const a = i / 4 * Math.PI * 2 + 0.4;
      R.part(core, prim.hex(), { p: [Math.cos(a) * 0.3, (i % 2 ? 0.1 : -0.08), Math.sin(a) * 0.3], r: [0.5 + i * 0.3, a, 0.9], s: [0.14, 0.05, 0.17], color: 0x2c3550, glow: 0.1, flat: true, mottle: 0.3 });
    }
    // halo rings: glow pulled back from 0.9/0.7 so they read as thin arcs of the creature's own hue rather
    // than the flat pale loops of the wave-3 void verdict (the hue itself is now held by the channel cap in
    // materials.js — this just stops them being the brightest thing in the region).
    const halo = R.bone('halo', core, 0, 0, 0);
    R.part(halo, prim.torus(), { p: [0, 0, 0], r: [Math.PI / 2, 0, 0], s: [0.44, 0.44, 0.44], color: 0xffffff, glow: 0.75 });
    const halo2 = R.bone('halo2', core, 0, 0, 0);
    R.part(halo2, prim.torus(), { p: [0, 0, 0], r: [Math.PI / 2 + 0.6, 0.3, 0], s: [0.34, 0.34, 0.34], color: 0xffffff, glow: 0.55 });
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
const drake = {
  build() {
    const R = new Rig(), { root } = R;
    const SCALE = 0x3d6662, SCALE2 = 0x2c4a48, BELLY = 0xa8926c, MEMB = 0x8a4a30, EMBER = 0xffffff, HORN = 0xd8ccb0;
    const body = R.bone('body', root, 0, 0, 0);
    R.part(body, prim.sphere(), { p: [0, 0, 0.1], s: [0.36, 0.32, 0.85], color: SCALE, mottle: 0.22 });
    R.part(body, prim.sphere(), { p: [0, -0.1, 0.1], s: [0.26, 0.22, 0.7], color: BELLY, mottle: 0.14 });
    for (let i = 0; i < 5; i++) R.part(body, prim.crystal(), { p: [0, 0.3 - i * 0.01, 0.6 - i * 0.28], r: [-0.5, 0, 0], s: [0.08, 0.17, 0.08], color: EMBER, glow: 1, flat: true });
    for (let i = 0; i < 3; i++) R.part(body, prim.boxB(), { p: [0, -0.28, 0.45 - i * 0.3], s: [0.26, 0.035, 0.09], color: EMBER, glow: 0.75 }); // molten belly slits (read from below in flight)
    R.mirror(body, prim.hex(), { p: [0.28, 0.18, 0.35], r: [0, 0, 1.1], s: [0.12, 0.05, 0.16], color: SCALE2, flat: true });
    // neck + head
    const n0 = R.bone('neck0', body, 0, 0.1, 0.8), n1 = R.bone('neck1', n0, 0, 0.08, 0.32), head = R.bone('head', n1, 0, 0.06, 0.3);
    R.part(n0, prim.cyl(), { p: [0, 0.15, 0.96], r: [-1.25, 0, 0], s: [0.15, 0.36, 0.15], color: SCALE });
    R.part(n1, prim.cyl(), { p: [0, 0.22, 1.27], r: [-1.35, 0, 0], s: [0.12, 0.34, 0.12], color: SCALE });
    R.part(head, prim.sphere(), { p: [0, 0.26, 1.52], s: [0.17, 0.15, 0.26], color: SCALE });
    R.part(head, prim.box(), { p: [0, 0.2, 1.76], s: [0.17, 0.11, 0.28], color: SCALE, mottle: 0.1 });
    R.mirror(head, prim.cone(), { p: [0.11, 0.4, 1.4], r: [-0.9, 0, 0.35], s: [0.05, 0.28, 0.04], color: HORN, mottle: 0.05 });
    R.mirror(head, prim.sphere(), { p: [0.09, 0.3, 1.62], s: 0.035, color: EMBER, glow: 1 });
    const jaw = R.bone('jaw', head, 0, -0.06, 0.1);
    R.part(jaw, prim.box(), { p: [0, 0.12, 1.74], s: [0.14, 0.05, 0.26], color: BELLY, mottle: 0.1 });
    R.part(jaw, prim.sphere(), { p: [0, 0.13, 1.66], s: 0.05, color: EMBER, glow: 0.8 });                                  // throat ember
    // tail
    const t0 = R.bone('tail0', body, 0, 0, -0.75), t1 = R.bone('tail1', t0, 0, 0, -0.45), t2 = R.bone('tail2', t1, 0, 0, -0.42);
    R.part(t0, prim.cyl(), { p: [0, 0, -0.98], r: [Math.PI / 2, 0, 0], s: [0.12, 0.46, 0.12], color: SCALE });
    R.part(t1, prim.cyl(), { p: [0, 0, -1.41], r: [Math.PI / 2, 0, 0], s: [0.085, 0.44, 0.085], color: SCALE });
    R.part(t2, prim.cyl(), { p: [0, 0, -1.8], r: [Math.PI / 2, 0, 0], s: [0.05, 0.36, 0.05], color: SCALE });
    R.part(t2, prim.crystal(), { p: [0, 0.02, -2.05], r: [Math.PI / 2, 0, 0], s: [0.12, 0.22, 0.05], color: EMBER, glow: 0.9, flat: true });
    // wings: wing0 (inner, from shoulder) -> wing1 (outer)
    for (const [n, s] of [['L', 1], ['R', -1]]) {
      const w0 = R.bone('wing0' + n, body, s * 0.28, 0.16, 0.25), w1 = R.bone('wing1' + n, w0, s * 1.15, 0, 0);
      R.part(w0, prim.cyl(), { p: [s * 0.85, 0.16, 0.25], r: [0, 0, Math.PI / 2], s: [0.06, 1.15, 0.06], color: SCALE2 });          // humerus
      R.part(w0, prim.membrane(3), { p: [s * 0.85, 0.12, -0.15], r: [0.06, 0, s * 0.05], s: [1.15, 0.30, 0.92], color: MEMB, mottle: 0.22 }); // inner membrane: cambered skin, scalloped trailing edge
      // radiating molten veins (solar glow that reads from every angle, both wing faces)
      R.part(w0, prim.box(), { p: [s * 0.85, 0.13, -0.05], r: [0, 0.2 * s, 0], s: [0.9, 0.04, 0.035], color: EMBER, glow: 0.75 });
      R.part(w0, prim.box(), { p: [s * 0.8, 0.13, -0.32], r: [0, 0.45 * s, 0], s: [0.75, 0.04, 0.03], color: EMBER, glow: 0.7 });
      R.part(w0, prim.box(), { p: [s * 0.7, 0.13, -0.46], r: [0, 0.8 * s, 0], s: [0.5, 0.04, 0.03], color: EMBER, glow: 0.65 });
      R.part(w1, prim.cyl(), { p: [s * 2.05, 0.16, 0.2], r: [0, 0, Math.PI / 2], s: [0.045, 1.25, 0.045], color: SCALE2 });        // finger
      R.part(w1, prim.membrane(2), { p: [s * 2.0, 0.12, -0.2], r: [-0.06, s * 0.15, s * -0.05], s: [1.25, 0.26, 0.88], color: MEMB, mottle: 0.22 }); // outer membrane
      R.part(w1, prim.box(), { p: [s * 2.0, 0.13, -0.1], r: [0, -0.35 * s, 0], s: [1.0, 0.04, 0.035], color: EMBER, glow: 0.75 });
      R.part(w1, prim.box(), { p: [s * 2.1, 0.13, -0.35], r: [0, -0.1 * s, 0], s: [0.85, 0.04, 0.03], color: EMBER, glow: 0.7 });
      R.part(w1, prim.crystal(), { p: [s * 2.62, 0.16, 0.05], r: [0, 0, -s * 1.35], s: [0.08, 0.2, 0.08], color: EMBER, glow: 0.9, flat: true }); // molten wing tip
      R.part(w1, prim.cone(), { p: [s * 2.7, 0.16, 0.22], r: [0, 0, -s * Math.PI / 2], s: [0.05, 0.25, 0.04], color: HORN });         // wing claw
      // tucked legs
      R.part(body, prim.limb(0.7), { p: [s * 0.2, -0.15, -0.25], r: [-1.3, 0, s * 0.4], s: [0.07, 0.4, 0.07], color: SCALE });
    }
    return R.build();
  },
  setup(e) { const b = e.bones; e.tail = [b.tail0, b.tail1, b.tail2]; e.neck = [b.neck0, b.neck1]; },
  animate(e, dt, t, A) {
    const b = e.bones, tt = t + e.seedT, sw = SW(e);
    const diving = e.state === 'attack';
    const flapF = diving ? 3 : 6.5, flapA = diving ? 0.25 : 0.75;
    const raw = Math.sin(tt * flapF);
    // a real wingbeat is not a sine: the downstroke snaps (it does the work), the recovery drifts, and the outer
    // wing both LAGS the humerus and folds in on the upstroke so it isn't pushing air the wrong way.
    const flap = Math.sign(raw) * Math.pow(Math.abs(raw), raw > 0 ? 0.62 : 1.35);
    const rawL = Math.sin(tt * flapF - 0.9), lag = Math.sign(rawL) * Math.pow(Math.abs(rawL), rawL > 0 ? 0.7 : 1.25);
    const fold = Math.max(0, -flap);                                  // 0 on the downstroke, 1 at the top of the upstroke
    b.body.position.y = flap * 0.08; b.body.rotation.x = e.pitchAnim + flap * 0.03; b.body.rotation.z = e.rollAnim;
    for (const [n, s] of [['L', 1], ['R', -1]]) {
      b['wing0' + n].rotation.z = s * (flap * flapA + 0.1);
      b['wing0' + n].rotation.y = -s * (0.05 * flap + 0.16 * fold);   // sweep forward as it folds
      b['wing1' + n].rotation.z = s * (lag * flapA * 0.9 - 0.15 - 0.55 * fold);
      b['wing1' + n].rotation.y = -s * 0.32 * fold;                   // outer wing tucks back toward the body
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

// ---------------------------------------------------------------- WRAITH: hooded revenant, floats, robe trails into rags
const wraith = {
  build() {
    const R = new Rig(), { root } = R;      // root = body centre (flyer)
    const CLOTH = 0x2a2733, CLOTH2 = 0x3b3648, GLOW = 0xffffff, HOLLOW = 0x0a0a12;
    const body = R.bone('body', root, 0, 0, 0);
    R.part(body, prim.cone(), { p: [0, -0.5, 0], r: [Math.PI, 0, 0], s: [0.5, 1.45, 0.44], color: CLOTH, mottle: 0.26, flat: true });   // robe: point down
    R.part(body, prim.sphere(), { p: [0, 0.3, 0], s: [0.4, 0.36, 0.38], color: CLOTH2, mottle: 0.2 });                                   // shoulders
    R.mirror(body, prim.hex(), { p: [0.34, 0.36, -0.02], r: [0, 0, 0.8], s: [0.2, 0.05, 0.2], color: CLOTH2, flat: true, mottle: 0.12 });
    const head = R.bone('head', body, 0, 0.52, 0);
    R.part(head, prim.cone(), { p: [0, 0.6, -0.02], s: [0.29, 0.5, 0.3], color: CLOTH2, flat: true, mottle: 0.18 });   // hood
    R.part(head, prim.sphere(), { p: [0, 0.5, 0.13], s: [0.17, 0.19, 0.15], color: HOLLOW, mottle: 0.05 });            // nothing inside it
    R.mirror(head, prim.sphere(), { p: [0.075, 0.53, 0.23], s: 0.045, color: GLOW, glow: 1 });
    for (const [n, sx] of [['R', 1], ['L', -1]]) {
      const sh = R.bone('sh' + n, body, sx * 0.36, 0.26, 0), el = R.bone('el' + n, sh, 0, -0.4, 0);
      R.part(sh, prim.limb(0.7), { p: [sx * 0.38, 0.2, 0], s: [0.095, 0.42, 0.095], color: CLOTH2, mottle: 0.2 });
      R.part(el, prim.limb(0.5), { p: [sx * 0.38, -0.22, 0.04], s: [0.085, 0.4, 0.085], color: CLOTH, mottle: 0.22 });
      R.part(el, prim.crystal(), { p: [sx * 0.4, -0.58, 0.07], r: [0.35, 0, 0], s: [0.07, 0.2, 0.07], color: GLOW, glow: 1, flat: true });
    }
    for (let i = 0; i < 5; i++) {
      const rb = R.bone('rag' + i, body, 0, -0.85, 0), a = i / 5 * Math.PI * 2 + 0.3;
      R.part(rb, prim.cone(), { p: [Math.cos(a) * 0.28, -1.3, Math.sin(a) * 0.28], r: [Math.PI, 0, 0], s: [0.085, 0.66 + (i % 2) * 0.18, 0.085], color: CLOTH, flat: true, mottle: 0.3 });
    }
    return R.build();
  },
  setup(e) { e.rags = []; for (let i = 0; i < 5; i++) e.rags.push(e.bones['rag' + i]); },
  animate(e, dt, t, A) {
    const b = e.bones, tt = t + e.seedT, sw = SW(e), reach = seg(sw, 0, 0.3) - seg(sw, 0.34, 0.5);
    b.body.position.y = Math.sin(tt * 1.1) * 0.16 + Math.sin(tt * 2.3) * 0.05 + (e.state === 'stagger' ? -0.2 : 0);
    b.body.rotation.z = Math.sin(tt * 0.7) * 0.09;
    b.body.rotation.x = e.tilt * 0.5 + reach * 0.2;
    if (e.alert) aimAt(b.head, A.eye, 1.1, 0.6, 6, dt); else relaxBone(b.head, 1.5, dt);
    for (const n of ['R', 'L']) {
      const s = n === 'R' ? 1 : -1;
      b['sh' + n].rotation.x = damp(b['sh' + n].rotation.x, -0.25 - reach * 1.5 + Math.sin(tt * 0.9 + s) * 0.12, 9, dt);
      b['sh' + n].rotation.z = damp(b['sh' + n].rotation.z, -s * (0.35 - reach * 0.25) + Math.sin(tt * 0.6 + s * 2) * 0.08, 5, dt);
      b['el' + n].rotation.x = damp(b['el' + n].rotation.x, -0.55 + reach * 0.5, 8, dt);
    }
    for (let i = 0; i < 5; i++) {                                     // rags drift like they are underwater
      const r = e.rags[i];
      r.rotation.x = Math.sin(tt * 1.3 + i * 1.4) * 0.22 + e.speedN * 0.3;
      r.rotation.z = Math.cos(tt * 1.1 + i * 2.1) * 0.2;
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

export const BODIES = { wisp, hound, sentinel, golem, drake, warden, giant, wraith, serpent };
