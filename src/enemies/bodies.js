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
const hound = {
  build() {
    const R = new Rig(), { root } = R;
    const HIDE = 0x5a6a85, BELLY = 0x8a94a8, PLATE = 0x3a4252, GLOW = 0xffffff, CLAW = 0x2a2e38;
    const body = R.bone('body', root, 0, 0.76, 0);
    R.part(body, prim.sphere(), { p: [0, 0.78, 0.32], s: [0.3, 0.3, 0.42], color: HIDE });
    R.part(body, prim.sphere(), { p: [0, 0.72, -0.18], s: [0.27, 0.26, 0.42], color: HIDE });
    R.part(body, prim.sphere(), { p: [0, 0.74, -0.52], s: [0.24, 0.26, 0.26], color: HIDE });
    R.part(body, prim.sphere(), { p: [0, 0.62, 0.05], s: [0.24, 0.2, 0.55], color: BELLY, mottle: 0.1 });
    // chitin back plates + crystal spines
    for (let i = 0; i < 4; i++) {
      const z = 0.45 - i * 0.3;
      R.part(body, prim.hex(), { p: [0, 1.02 - i * 0.02, z], r: [0.15, 0, 0], s: [0.17, 0.05, 0.15], color: PLATE, mottle: 0.06, flat: true });
      R.part(body, prim.crystal(), { p: [0, 1.1 - i * 0.02, z + 0.02], r: [-0.35, 0, 0], s: [0.12, 0.2 + (i === 1 ? 0.07 : 0), 0.12], color: GLOW, glow: 1, flat: true });
    }
    R.mirror(body, prim.hex(), { p: [0.27, 0.95, 0.38], r: [0, 0, 0.9], s: [0.14, 0.05, 0.16], color: PLATE, mottle: 0.06, flat: true });
    // flank + haunch chitin (faceted detail that reads at point-blank — no smooth blob)
    R.mirror(body, prim.hex(), { p: [0.27, 0.8, 0.02], r: [0, 0.15, 1.05], s: [0.17, 0.045, 0.22], color: PLATE, mottle: 0.09, flat: true });
    R.mirror(body, prim.hex(), { p: [0.23, 0.82, -0.44], r: [0.25, 0, 1.15], s: [0.14, 0.04, 0.17], color: PLATE, mottle: 0.09, flat: true });
    R.mirror(body, prim.crystal(), { p: [0.26, 0.93, -0.02], r: [0.3, 0, 1.0], s: [0.06, 0.11, 0.06], color: GLOW, glow: 0.7, flat: true });
    // neck / head / jaw
    const neck = R.bone('neck', body, 0, 0.14, 0.6);
    R.part(neck, prim.cyl(), { p: [0, 1.0, 0.75], r: [-1.1, 0, 0], s: [0.12, 0.32, 0.12], color: HIDE });
    const head = R.bone('head', neck, 0, 0.15, 0.26);
    R.part(head, prim.sphere(), { p: [0, 1.07, 0.9], s: [0.19, 0.17, 0.22], color: HIDE });
    R.part(head, prim.boxB(), { p: [0, 1.03, 1.1], r: [0.1, 0, 0], s: [0.16, 0.115, 0.26], color: HIDE, mottle: 0.14 });   // beveled muzzle, narrow + tipped down (no toy-pug snout)
    R.part(head, prim.hex(), { p: [0, 1.0, 1.26], r: [1.62, 0, 0], s: [0.06, 0.1, 0.05], color: CLAW, flat: true });        // dark nose tip
    R.part(head, prim.hex(), { p: [0, 1.1, 1.1], r: [1.68, 0, 0], s: [0.07, 0.26, 0.055], color: PLATE, mottle: 0.08, flat: true }); // nasal ridge
    R.mirror(head, prim.hex(), { p: [0.1, 1.03, 1.0], r: [0.2, 0, 1.25], s: [0.075, 0.05, 0.15], color: PLATE, mottle: 0.08, flat: true }); // cheek plates
    R.mirror(head, prim.boxB(), { p: [0.07, 1.15, 1.04], r: [0.35, 0, 0.35], s: [0.1, 0.05, 0.19], color: PLATE, mottle: 0.06 }); // angled brow ridges
    R.mirror(head, prim.sphere(), { p: [0.085, 1.1, 1.06], s: 0.04, color: GLOW, glow: 1 });                           // eyes
    R.mirror(head, prim.cone(), { p: [0.13, 1.27, 0.85], r: [-0.3, 0, 0.45], s: [0.05, 0.18, 0.04], color: HIDE });      // ears
    R.part(head, prim.crystal(), { p: [0, 1.24, 1.0], r: [-0.9, 0, 0], s: [0.08, 0.18, 0.08], color: GLOW, glow: 0.8, flat: true }); // horn
    R.mirror(head, prim.cone(), { p: [0.07, 0.96, 1.3], r: [Math.PI, 0, 0], s: [0.025, 0.08, 0.02], color: CLAW });     // fangs
    const jaw = R.bone('jaw', head, 0, -0.08, 0.1);
    R.part(jaw, prim.boxB(), { p: [0, 0.94, 1.1], s: [0.13, 0.055, 0.26], color: 0x424c60, mottle: 0.12 });  // dark under-jaw (the grey band read as a toy grin)
    // tail (3 segments)
    const t0 = R.bone('tail0', body, 0, 0.1, -0.72), t1 = R.bone('tail1', t0, 0, 0.04, -0.28), t2 = R.bone('tail2', t1, 0, 0.03, -0.26);
    R.part(t0, prim.cyl(), { p: [0, 0.88, -0.86], r: [1.45, 0, 0], s: [0.06, 0.3, 0.06], color: HIDE });
    R.part(t1, prim.cyl(), { p: [0, 0.9, -1.13], r: [1.5, 0, 0], s: [0.045, 0.28, 0.045], color: HIDE });
    R.part(t2, prim.crystal(), { p: [0, 0.92, -1.4], r: [1.6, 0, 0], s: [0.09, 0.2, 0.09], color: GLOW, glow: 0.9, flat: true });
    // legs: hips are children of body (follow bob); knees too (IK sets their position)
    const legs = [['FL', 0.22, 0.4, 0], ['FR', -0.22, 0.4, 1], ['HL', 0.2, -0.5, 1], ['HR', -0.2, -0.5, 0]];
    for (const [n, x, z] of legs) {
      const hip = R.bone('hip' + n, body, x, 0, z), knee = R.bone('knee' + n, body, x, -0.4, z);
      R.part(hip, prim.limb(0.7), { p: [x, 0.76, z], s: [0.085, 0.4, 0.085], color: HIDE });
      R.part(hip, prim.sphere(), { p: [x, 0.76, z], s: 0.1, color: PLATE, mottle: 0.05 });
      R.part(knee, prim.limb(0.8), { p: [x, 0.36, z], s: [0.06, 0.36, 0.06], color: HIDE });
      R.part(knee, prim.box(), { p: [x, 0.03, z + 0.05], s: [0.12, 0.06, 0.2], color: PLATE, mottle: 0.05 });
      R.mirror(knee, prim.cone(), { p: [x + 0.03, 0.02, z + 0.17], r: [1.5, 0, 0], s: [0.02, 0.06, 0.02], color: CLAW });
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
    const halo = R.bone('halo', core, 0, 0, 0);
    R.part(halo, prim.torus(), { p: [0, 0, 0], r: [Math.PI / 2, 0, 0], s: [0.44, 0.44, 0.44], color: 0xffffff, glow: 0.9 });
    const halo2 = R.bone('halo2', core, 0, 0, 0);
    R.part(halo2, prim.torus(), { p: [0, 0, 0], r: [Math.PI / 2 + 0.6, 0.3, 0], s: [0.34, 0.34, 0.34], color: 0xffffff, glow: 0.7 });
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
const sentinel = {
  build() {
    const R = new Rig(), { root } = R;
    const STONE = 0xd9c9a8, DARK = 0x6b6055, GOLD = 0xe6b45c, GLOW = 0xffffff, CLOTH = 0x4656a8;   // warmer stone, brighter gold, saturated cloth (drab-cardboard fix)
    const pelvis = R.bone('pelvis', root, 0, 1.45, 0);
    R.part(pelvis, prim.boxB(), { p: [0, 1.5, 0], s: [0.42, 0.24, 0.3], color: DARK, mottle: 0.1 });
    for (let i = 0; i < 5; i++) { const a = (i - 2) * 0.55; R.part(pelvis, prim.box(), { p: [Math.sin(a) * 0.24, 1.2, Math.cos(a) * 0.2 - 0.02], r: [0.1, a, 0], s: [0.14, 0.5, 0.04], color: i % 2 ? STONE : CLOTH, mottle: 0.1 }); } // skirt plates
    const torso = R.bone('torso', pelvis, 0, 0.22, 0);
    // layered armor mass (beveled plates + octagonal core — no single cardboard box)
    R.part(torso, prim.hex(), { p: [0, 1.98, 0], r: [0, 0.52, 0], s: [0.29, 0.6, 0.24], color: STONE, mottle: 0.16, flat: true }); // octagonal core
    R.part(torso, prim.boxB(), { p: [0, 2.14, 0.02], s: [0.52, 0.4, 0.33], color: STONE, mottle: 0.16 });                 // chest block
    R.part(torso, prim.boxB(), { p: [0, 1.8, 0], s: [0.4, 0.3, 0.27], color: DARK, mottle: 0.12 });                       // waist taper
    R.mirror(torso, prim.boxB(), { p: [0.25, 2.16, 0.02], r: [0, 0, 0.28], s: [0.13, 0.36, 0.3], color: STONE, mottle: 0.16 }); // angled side plates
    R.part(torso, prim.boxB(), { p: [0, 2.2, -0.15], r: [-0.3, 0, 0], s: [0.38, 0.32, 0.1], color: GOLD, mottle: 0.06 });  // back plate
    for (let i = 0; i < 3; i++) R.part(torso, prim.crystal(), { p: [0, 2.38 - i * 0.15, -0.24], r: [0.6, 0, 0], s: [0.05, 0.11, 0.05], color: GLOW, glow: 0.7, flat: true }); // spine studs
    R.part(torso, prim.boxB(), { p: [0, 2.1, 0.17], s: [0.36, 0.28, 0.07], color: GOLD, mottle: 0.05 });                  // chest plate
    R.part(torso, prim.box(), { p: [0, 2.1, 0.2], s: [0.05, 0.22, 0.02], color: GLOW, glow: 1 });                          // aether line
    R.part(torso, prim.box(), { p: [0, 2.0, 0.2], s: [0.22, 0.04, 0.02], color: GLOW, glow: 1 });
    R.mirror(torso, prim.sphere(), { p: [0.34, 2.26, 0], s: [0.14, 0.1, 0.14], color: GOLD, mottle: 0.04 });               // pauldrons
    R.mirror(torso, prim.crystal(), { p: [0.36, 2.4, 0], r: [0, 0, -0.3], s: [0.08, 0.16, 0.08], color: GLOW, glow: 0.8, flat: true });
    const head = R.bone('head', torso, 0, 0.6, 0);
    R.part(head, prim.boxB(), { p: [0, 2.44, 0], s: [0.26, 0.32, 0.28], color: STONE, mottle: 0.12 });
    R.part(head, prim.box(), { p: [0, 2.46, 0.15], s: [0.2, 0.05, 0.03], color: GLOW, glow: 1 });                          // visor slit (thicker: must read at noon)
    R.part(head, prim.crystal(), { p: [0, 2.7, -0.02], s: [0.1, 0.2, 0.1], color: GLOW, glow: 0.7, flat: true });            // crest
    R.mirror(head, prim.boxB(), { p: [0.16, 2.5, 0], r: [0, 0, 0.12], s: [0.07, 0.24, 0.22], color: GOLD, mottle: 0.05 });   // cheek guards
    // arms: shoulder -> elbow -> hand (children chain)
    for (const [n, sx] of [['R', 0.36], ['L', -0.36]]) {
      const sh = R.bone('sh' + n, torso, sx, 0.48, 0), el = R.bone('el' + n, sh, 0, -0.42, 0), hd = R.bone('hd' + n, el, 0, -0.4, 0);
      R.part(sh, prim.limb(0.75), { p: [sx, 2.15, 0], s: [0.08, 0.42, 0.08], color: STONE, mottle: 0.1 });
      R.part(el, prim.limb(0.8), { p: [sx, 1.73, 0], s: [0.065, 0.4, 0.065], color: DARK });
      R.part(el, prim.sphere(), { p: [sx, 1.73, 0], s: 0.08, color: GOLD, mottle: 0.04 });
      R.part(hd, prim.box(), { p: [sx, 1.3, 0.02], s: [0.1, 0.12, 0.12], color: DARK });
      if (n === 'R') { // spear held vertically in right hand
        R.part(hd, prim.cyl(), { p: [sx, 1.65, 0.12], s: [0.025, 2.6, 0.025], color: DARK, mottle: 0.05 });
        R.part(hd, prim.torus(), { p: [sx, 2.75, 0.12], r: [Math.PI / 2, 0, 0], s: 0.08, color: GOLD });
        R.part(hd, prim.crystal(), { p: [sx, 3.15, 0.12], s: [0.12, 0.38, 0.12], color: GLOW, glow: 1, flat: true });
        R.part(hd, prim.crystal(), { p: [sx, 2.9, 0.12], r: [Math.PI, 0, 0], s: [0.06, 0.15, 0.06], color: GLOW, glow: 0.7, flat: true });
      } else { const orb = R.bone('orb', hd, 0, 0.3, 0.1); R.part(orb, prim.ico(), { p: [sx, 1.6, 0.12], s: 0.12, color: GLOW, glow: 1, flat: true }); R.part(orb, prim.torus(), { p: [sx, 1.6, 0.12], r: [0.5, 0, 0], s: 0.2, color: GOLD, glow: 0.3 }); }
    }
    // legs (IK): hips children of pelvis
    for (const [n, x] of [['L', 0.17], ['R', -0.17]]) {
      const hip = R.bone('hip' + n, pelvis, x, 0, 0), knee = R.bone('knee' + n, pelvis, x, -0.75, 0);
      R.part(hip, prim.limb(0.7), { p: [x, 1.45, 0], s: [0.1, 0.75, 0.1], color: STONE, mottle: 0.1 });
      R.part(hip, prim.box(), { p: [x, 1.25, 0.06], s: [0.14, 0.34, 0.1], color: GOLD, mottle: 0.04 });                  // thigh plate
      R.part(knee, prim.limb(0.75), { p: [x, 0.7, 0], s: [0.08, 0.66, 0.08], color: DARK });
      R.part(knee, prim.box(), { p: [x, 0.05, 0.06], s: [0.14, 0.1, 0.32], color: DARK, mottle: 0.05 });                 // foot
    }
    return R.build();
  },
  setup(e) {
    const b = e.bones;
    e.legs = [makeLeg(b, 'hipL', 'kneeL', [0.17, 0, 0], [0.19, -1.45, 0.05], 0.75, 0.75, [0, 0, 1], 0), makeLeg(b, 'hipR', 'kneeR', [-0.17, 0, 0], [-0.19, -1.45, 0.05], 0.75, 0.75, [0, 0, 1], 1)];
    e.legParent = b.pelvis; e.gait = { stepLen: 0.55, stepTime: 0.26, lift: 0.18, lead: 0.18 };
  },
  animate(e, dt, t, A) {
    const b = e.bones, ph = e.phase, sp = e.speedN, sw = SW(e), tg = e.telegraph;
    b.pelvis.position.y = 1.45 + Math.sin(ph * 2) * 0.03 * sp + (e.state === 'stagger' ? -0.12 : 0);
    b.pelvis.rotation.y = Math.sin(ph) * 0.06 * sp; b.pelvis.rotation.x = e.tilt;
    const raise = seg(sw, 0, 0.3), thrust = seg(sw, 0.33, 0.42), rec = seg(sw, 0.6, 1);
    b.torso.rotation.x = damp(b.torso.rotation.x, 0.05 + sp * 0.08 - 0.15 * raise + 0.35 * thrust - 0.2 * rec, 10, dt);
    b.torso.rotation.y = -Math.sin(ph) * 0.08 * sp + e.strafeLean * 0.1;
    if (e.alert) aimAt(b.head, A.eye, 1.1, 0.6, 8, dt); else { relaxBone(b.head, 3, dt); b.head.rotation.y = Math.sin(t * 0.5 + e.seedT) * 0.5; }
    // arms: walk swing; telegraph raises the spear arm + orb hand; release thrusts forward
    const swing = Math.sin(ph) * 0.35 * sp;
    b.shR.rotation.x = damp(b.shR.rotation.x, swing * 0.5 - 1.9 * raise + 1.3 * thrust + 0.6 * rec, 12, dt);
    b.shR.rotation.z = damp(b.shR.rotation.z, -0.15 - 0.6 * raise + 0.6 * rec, 8, dt);
    b.elR.rotation.x = damp(b.elR.rotation.x, -0.3 - 0.6 * raise + 0.6 * rec, 8, dt);
    b.hdR.rotation.x = damp(b.hdR.rotation.x, 1.2 * raise - 1.2 * rec, 8, dt);   // tip spear toward target
    b.shL.rotation.x = damp(b.shL.rotation.x, -swing * 0.5 - 1.3 * raise + 1.3 * rec - (e.alert ? 0.5 : 0), 8, dt);
    b.shL.rotation.z = damp(b.shL.rotation.z, 0.2 + 0.3 * raise - 0.3 * rec, 8, dt); b.elL.rotation.x = damp(b.elL.rotation.x, -0.5 - 0.4 * raise + 0.4 * rec - (e.alert ? 0.6 : 0), 8, dt);
    b.orb.position.y = 0.3 + Math.sin(t * 3 + e.seedT) * 0.04; b.orb.rotation.y = t * 2; b.orb.scale.setScalar(1 + tg * 0.6 + Math.sin(t * 6) * 0.05 * tg);
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

export const BODIES = { wisp, hound, sentinel, golem, drake, warden };
export { plantLegs };
