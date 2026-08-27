import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from '../core/Noise.js';

/**
 * Rig: procedural creature assembly (anyCreature-style). A body is a THREE.Bone hierarchy (template) plus a list of
 * rigid "parts" (primitive geometries authored in root space at bind pose, each welded to one bone). build() merges all
 * parts into ONE non-indexed geometry with color / aGlow / skinIndex / skinWeight attributes -> one SkinnedMesh per
 * creature (1 draw call), skeleton cloned per instance, bone inverses shared.
 * Animation helpers: 2-bone analytic IK legs with foot planting (procedural gait), chain waves, aim-at.
 */
const _c = new THREE.Color();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();

// ---- shared primitives (cached) ----
const PRIM = {};
export const prim = {
  sphere: () => PRIM.sphere ??= new THREE.SphereGeometry(1, 12, 9),
  sphereLo: () => PRIM.sphereLo ??= new THREE.SphereGeometry(1, 8, 6),
  box: () => PRIM.box ??= new RoundedBoxGeometry(1, 1, 1, 2, 0.09),   // beveled: soft edge highlights, no cardboard look
  boxB: () => PRIM.boxB ??= new RoundedBoxGeometry(1, 1, 1, 3, 0.22), // heavy bevel: armor plates / organic chunks that read at close range
  // THE COST TABLE MATTERS: boxB is 588 tris and sphere is 192, which is why the wave-1 bodies came out at
  // 6-12k each against a 3.5k crowd budget. These three are the cheap workhorses — a chamfered slab reads
  // as forged armour at 108, a 4-sided taper reads as a plate/blade/tasset at 16, and a coarse band is a
  // gold trim ring at 96 instead of the 240 the smooth torus costs.
  plate: () => PRIM.plate ??= new RoundedBoxGeometry(1, 1, 1, 1, 0.12),          // 108 tris: chamfered armour slab
  // tapered 4-sided prism, unit box footprint (-0.5..0.5 in x/z, y too). `taper` = bottom width / top width.
  slab: (taper = 0.7) => PRIM['slab' + taper] ??= new THREE.CylinderGeometry(1, taper, 1, 4, 1).rotateY(Math.PI / 4).scale(0.70711, 1, 0.70711),
  ring: () => PRIM.ring ??= new THREE.TorusGeometry(1, 0.06, 4, 12),             // 96 tris: trim band / halo
  cyl: () => PRIM.cyl ??= new THREE.CylinderGeometry(1, 1, 1, 8, 1),          // unit cylinder, y -0.5..0.5
  cone: () => PRIM.cone ??= new THREE.ConeGeometry(1, 1, 7, 1),
  octa: () => PRIM.octa ??= new THREE.OctahedronGeometry(1, 0),
  ico: () => PRIM.ico ??= new THREE.IcosahedronGeometry(1, 1),
  // thinner tube than the original 0.06/6x20: at 0.045 the wisp/riftling halo reads as an arc of light
  // instead of the "hula-hoop rings" the wave-3 void verdict called out — and costs 180 tris, not 240.
  torus: () => PRIM.torus ??= new THREE.TorusGeometry(1, 0.045, 5, 18),
  hex: () => PRIM.hex ??= new THREE.CylinderGeometry(1, 1, 1, 6, 1),
  // tapered limb segment: top radius 1, bottom radius `taper`, y from 0 down to -1 (so a bone at the top aims -Y along it)
  limb: (taper = 0.7) => PRIM['limb' + taper] ??= new THREE.CylinderGeometry(1, taper, 1, 8, 1).translate(0, -0.5, 0),
  // jagged rock: displaced icosahedron, faceted
  rock: (seed = 1, jag = 0.28, detail = 1) => PRIM[`rock${seed}_${jag}_${detail}`] ??= makeRock(seed, jag, detail),
  // crystal shard: stretched octahedron with a jagged mid band
  crystal: () => PRIM.crystal ??= new THREE.OctahedronGeometry(1, 0).scale(0.35, 1, 0.35),
  // wing membrane: cambered skin panel with a scalloped trailing edge, closed into a thin lens so it reads from
  // both faces under a FrontSide material. Unit box: x = span, z = chord (+Z leading edge), y = billow.
  // ~72 tris — LESS than the beveled RoundedBox it replaces, and it stops the wing looking like a plank.
  membrane: (lobes = 3) => PRIM['memb' + lobes] ??= makeMembrane(lobes),

  // ---- SMOOTH / CHAMFERED FAMILY (creature triangle budget raised by the user 2026-08-26: ~4k small and
  // ethereal, ~10k standard creature). The cost table above was written against a 3.5k crowd budget and the
  // whole bestiary is now sitting at a fifth of its ceiling, so the cheap prims above are no longer the
  // right default for anything ORGANIC. What the extra triangles actually buy, per docs/CREATURE-PIPELINE.md:
  // curvature (an 8-segment limb facets visibly at 3 m) and chamfered edges (a razor 90 deg edge is the
  // loudest greybox tell there is). Nothing here changes a silhouette — same shapes, no hard edges.
  sphereMid: () => PRIM.sphereMid ??= new THREE.SphereGeometry(1, 16, 12),                                  // 352 tris
  coneS: (seg = 14) => PRIM['coneS' + seg] ??= new THREE.ConeGeometry(1, 1, seg, 1),                        // 28 tris
  limbS: (taper = 0.7, seg = 14) => PRIM[`limbS${taper}_${seg}`] ??= new THREE.CylinderGeometry(1, taper, 1, seg, 1).translate(0, -0.5, 0),
  // `slab` generalised: an n-gon prism with the same unit footprint (flat-to-flat = 1 on x and z), so it is a
  // drop-in for slab(taper) at any side count. sides=8 IS slab with all four of its 90 deg edges chamfered
  // away, for 16 more triangles — which is the single highest-value triangle in the whole table.
  prism: (taper = 0.6, sides = 8) => PRIM[`prism${taper}_${sides}`] ??= (() => {
    const k = 1 / (2 * Math.cos(Math.PI / sides));
    return new THREE.CylinderGeometry(1, taper, 1, sides, 1).rotateY(Math.PI / sides).scale(k, 1, k);
  })(),
};
function makeMembrane(lobes) {
  const NX = 6, NZ = 3, pos = [], uv = [], idx = [];
  const rowOf = (side) => {
    const base = pos.length / 3;
    for (let i = 0; i <= NX; i++) for (let j = 0; j <= NZ; j++) {
      const u = i / NX, v = j / NZ;                                  // u = span 0..1, v = chord 0 (trailing) .. 1 (leading)
      const zTrail = -0.5 + 0.10 * Math.abs(Math.sin(u * Math.PI * lobes));  // scallops between the finger bones
      const z = zTrail + v * (0.5 - zTrail);
      const camber = Math.sin(v * Math.PI) * (0.3 + 0.7 * u);        // billows more toward the tip
      const fade = Math.min(1, Math.min(u, 1 - u) / 0.16) * Math.min(1, Math.min(v, 1 - v) / 0.16); // sheets meet at the rim
      pos.push(u - 0.5, camber * 0.5 + side * 0.05 * fade, z); uv.push(u, v);
    }
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
      const a = base + i * (NZ + 1) + j, b = a + NZ + 1;
      if (side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1);
      else idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  };
  rowOf(1); rowOf(-1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));   // mergeGeometries needs the same attribute set as the other prims
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function makeRock(seed, jag, detail) {
  const g = new THREE.IcosahedronGeometry(1, detail);   // polyhedra are already non-indexed
  const rnd = mulberry32(seed * 7919 + 13);
  const pos = g.attributes.position; const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let f = seen.get(k); if (f === undefined) { f = 1 + (rnd() - 0.5) * 2 * jag; seen.set(k, f); }
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.9, pos.getZ(i) * f);
  }
  g.computeVertexNormals(); return g;
}

export class Rig {
  constructor() { this.bones = []; this.parts = []; this.root = this.bone('root', null, 0, 0, 0); }
  bone(name, parent, x = 0, y = 0, z = 0) {
    const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z);
    if (parent) parent.add(b);
    b.userData.index = this.bones.length; this.bones.push(b); return b;
  }
  /** part(bone, geo, { p:[x,y,z] root-space, r:[rx,ry,rz] euler, s:number|[x,y,z], color:hex, glow:0..1, mottle:0..1, flat:bool }) */
  part(bone, geo, o = {}) { this.parts.push({ bone, geo, o }); return this; }
  mirror(bone, geo, o = {}) { // add part and its x-mirrored twin (same bone or o.boneMirror)
    this.part(bone, geo, o);
    const p = o.p ?? [0, 0, 0], r = o.r ?? [0, 0, 0];
    this.part(o.boneMirror ?? bone, geo, { ...o, p: [-p[0], p[1], p[2]], r: [r[0], -r[1], -r[2]] });
    return this;
  }
  build() {
    this.root.updateMatrixWorld(true);
    const geos = [];
    for (const { bone, geo, o } of this.parts) {
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      const s = o.s ?? 1; _s.set(...(Array.isArray(s) ? s : [s, s, s]));
      _e.set(...(o.r ?? [0, 0, 0])); _q.setFromEuler(_e); _p.set(...(o.p ?? [0, 0, 0]));
      _m.compose(_p, _q, _s); g.applyMatrix4(_m);
      if (o.flat) { g.computeVertexNormals(); }
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3), glow = new Float32Array(n), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      _c.set(o.color ?? 0x888888); const mot = o.mottle ?? 0.18, gl = o.glow ?? 0;
      const pos = g.attributes.position;
      for (let i = 0; i < n; i++) {
        const h = Math.sin(pos.getX(i) * 91.7 + pos.getY(i) * 47.3 + pos.getZ(i) * 13.1);
        const f = 1 + h * mot;
        col[i * 3] = _c.r * f; col[i * 3 + 1] = _c.g * f; col[i * 3 + 2] = _c.b * f;
        glow[i] = gl; si[i * 4] = bone.userData.index; sw[i * 4] = 1;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
      g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
      geos.push(g);
    }
    const geometry = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    geometry.computeBoundingSphere(); geometry.boundingSphere.radius *= 1.5; // animation slack for frustum culling
    const boneInverses = this.bones.map((b) => b.matrixWorld.clone().invert());
    return { geometry, bonesTemplate: this.root, boneInverses, boneNames: this.bones.map((b) => b.name), bindPos: this.bones.map((b) => b.position.clone()) };
  }
}

/**
 * Clone the template bone hierarchy for an instance; returns { root, bones (flat, template order), byName }.
 * ALIASES: a bone may carry `userData.alias` — a list of extra names it also answers to. That is how a rigged
 * GLB body (src/enemies/glbBody.js) keeps the procedural vocabulary working: Tripo's joints are renamed to
 * 'spine0'/'neck2'/'L1R_3', and the semantic names the rest of the game looks up (def.weakPoints' 'head' /
 * 'core' / 'torso', Enemy._fBody/_fHead, _muzzle) ride along as aliases on whichever joint actually is that
 * feature. A real bone NAME always wins (`??=`) so an alias can never shadow a procedural body's own bone.
 */
export function cloneBones(template) {
  const root = template.clone(true); const bones = []; const byName = {};
  root.traverse((b) => { if (b.isBone) { bones[b.userData.index] = b; byName[b.name] = b; } });
  root.traverse((b) => { if (b.isBone && b.userData.alias) for (const a of b.userData.alias) byName[a] ??= b; });
  return { root, bones, byName };
}

// ---- animation helpers ----
const FWD = new THREE.Vector3(0, 0, 1);
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _d = new THREE.Vector3(), _k = new THREE.Vector3(), _pp = new THREE.Vector3(), _inv = new THREE.Matrix4(), _qi = new THREE.Quaternion();
/** Orient bone so its local -Y axis points along dir (parent space) and its local +Z stays close to fwd. */
export function aimBone(bone, dir, fwd) {
  _y.copy(dir).normalize().negate();                       // bone +Y
  _x.crossVectors(_y, fwd); if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0); _x.normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z); bone.quaternion.setFromRotationMatrix(_m);
}

/**
 * Legs: procedural foot-planting gait + 2-bone IK.
 * leg = { hip:Vector3 (parent-local), home:Vector3 (parent-local rest foot), a, b, pole:Vector3 (parent-local bend dir),
 *         group:0|1, hipBone, kneeBone, foot:Vector3 (world), from:Vector3, to:Vector3, swing:-1 (planted) or 0..1 }
 * parent: bone whose local frame holds the hips (its matrixWorld must be current). vel: world velocity of creature.
 */
export function stepLegs(legs, parent, vel, dt, t, heightAt, opt) {
  const stepLen = opt.stepLen, stepTime = opt.stepTime, lift = opt.lift, lead = opt.lead ?? 0.12;
  const speed = Math.hypot(vel.x, vel.z);
  _inv.copy(parent.matrixWorld).invert();
  // how many legs of each group are mid-swing (legs of one group step together; groups alternate)
  let swinging0 = 0, swinging1 = 0; for (const l of legs) if (l.swing >= 0) (l.group ? swinging1++ : swinging0++);
  let settled = true;
  for (const l of legs) {
    _pp.copy(l.home).applyMatrix4(parent.matrixWorld);     // home in world
    _pp.addScaledVector(vel, lead);
    if (l.swing < 0) {
      const d = Math.hypot(_pp.x - l.foot.x, _pp.z - l.foot.z);
      const otherBusy = l.group ? swinging0 > 0 : swinging1 > 0;
      const thresh = speed > 0.3 ? stepLen : stepLen * 0.45;
      if (d > thresh && !otherBusy) {
        l.from.copy(l.foot); l.to.copy(_pp).addScaledVector(vel, lead * 0.8);
        l.to.y = heightAt(l.to.x, l.to.z); l.swing = 0; (l.group ? swinging1++ : swinging0++);
        l.stepT = THREE.MathUtils.clamp(stepTime * (1.4 - Math.min(speed, 8) * 0.06), stepTime * 0.6, stepTime * 1.4);
      }
    }
    if (l.swing >= 0) {
      settled = false;
      l.swing += dt / l.stepT;
      if (l.swing >= 1) { l.swing = -1; l.foot.copy(l.to); (l.group ? swinging1-- : swinging0--); }
      else { const s = l.swing, e = s * s * (3 - 2 * s); l.foot.lerpVectors(l.from, l.to, e); l.foot.y += Math.sin(s * Math.PI) * lift; }
    }
    // IK in parent-local space
    _k.copy(l.foot).applyMatrix4(_inv);                   // foot local
    _d.subVectors(_k, l.hip); let L = _d.length(); const maxL = l.a + l.b - 0.01;
    if (L > maxL) { _d.multiplyScalar(maxL / L); L = maxL; } if (L < 0.05) { _d.set(0, -0.05, 0); L = 0.05; }
    const u = _d.multiplyScalar(1 / L);
    const cosA = THREE.MathUtils.clamp((l.a * l.a + L * L - l.b * l.b) / (2 * l.a * L), -1, 1), A = Math.acos(cosA);
    _pp.copy(l.pole).addScaledVector(u, -u.dot(l.pole)); if (_pp.lengthSq() < 1e-5) _pp.set(0, 0, 1); _pp.normalize();
    // knee = hip + u*a*cosA + perp*a*sinA
    _k.copy(l.hip).addScaledVector(u, l.a * cosA).addScaledVector(_pp, l.a * Math.sin(A));
    l.hipBone.position.copy(l.hip);
    _d.subVectors(_k, l.hip); aimBone(l.hipBone, _d, FWD);
    l.kneeBone.position.copy(_k);
    _d.copy(l.foot).applyMatrix4(_inv).sub(_k); aimBone(l.kneeBone, _d, FWD);
  }
  return settled;
}
/** Snap all feet to their home positions (spawn / teleport). */
export function plantLegs(legs, parent, heightAt) { // parent.matrixWorld must be current
  for (const l of legs) { l.foot.copy(l.home).applyMatrix4(parent.matrixWorld); l.foot.y = heightAt(l.foot.x, l.foot.z); l.swing = -1; }
}
export function makeLeg(byName, hipName, kneeName, hip, home, a, b, pole, group) {
  return { hip: new THREE.Vector3(...hip), home: new THREE.Vector3(...home), a, b, pole: new THREE.Vector3(...pole), group,
    hipBone: byName[hipName], kneeBone: byName[kneeName], foot: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), swing: -1, stepT: 0.2 };
}

/** Sine wave down a bone chain (tails, tentacles). axis 'x'|'y'; phase offset per segment. */
export function chainWave(bones, t, amp, freq, axis = 'y', lag = 0.7, base = 0) {
  for (let i = 0; i < bones.length; i++) bones[i].rotation[axis] = base + Math.sin(t * freq - i * lag) * amp * (0.6 + i * 0.3);
}
/** Rotate bone so its +Z looks at world target (clamped yaw/pitch, smoothed). rest: base quaternion (optional). */
const _tq = new THREE.Quaternion(), _lk = new THREE.Vector3(), _pw = new THREE.Vector3();
export function aimAt(bone, worldTarget, maxYaw, maxPitch, k, dt) {
  const parent = bone.parent; _inv.copy(parent.matrixWorld).invert();
  _lk.copy(worldTarget).applyMatrix4(_inv).sub(bone.position);
  const yaw = THREE.MathUtils.clamp(Math.atan2(_lk.x, _lk.z), -maxYaw, maxYaw);
  const pitch = THREE.MathUtils.clamp(-Math.atan2(_lk.y, Math.hypot(_lk.x, _lk.z)), -maxPitch, maxPitch);
  _e.set(pitch, yaw, 0, 'YXZ'); _tq.setFromEuler(_e);
  bone.quaternion.slerp(_tq, 1 - Math.exp(-k * dt));
}
export function relaxBone(bone, k, dt) { bone.quaternion.slerp(_qi, 1 - Math.exp(-k * dt)); }
export const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
