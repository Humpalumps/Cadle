import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * Procedural first-person hands/arms (Destiny-style armored gauntlets). Built INTO the gun's Builder buckets
 * (same materials: grip=leather glove, dark=undersleeve, metal2=armor plates, gold=trim) so they merge with the
 * gun geometry -> zero extra draw calls. Gun space: +Y up, +X right, forward -Z, origin = top of pistol grip.
 *
 *   gripHand(b, { p, tilt, R, side, part })  hand wrapped around a vertical(ish) grip. side=1 right hand, -1 left.
 *   wrapHand(b, { p, R, part, dz })          support hand wrapped around a horizontal tube/handguard along Z.
 *   looseHand(b, { p, part })                cupped palm-up hand (reload performances: speedloader/shells).
 * Fingers are SEGMENTED (3 rounded-box knuckle segments per finger + armored plate on the proximal one) so the
 * glove reads as articulated armor, not ribbed tubes. Pass part='lhand' to make the support hand animatable.
 */
const PI = Math.PI;
const _q = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();
const rbox = (w, h, d, r = 0.003) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.49));
const alignY = (g, x, y, z) => g.applyQuaternion(_q.setFromUnitVectors(_Y, _d.set(x, y, z).normalize()));

// one segmented finger wrapping an arc of radius R around center c, in the plane spanned by unit vectors e1,e2.
// a0..a1 radians (dir(t)=cos*e1+sin*e2). segs knuckle segments, tapering; armored plate over segment 0.
function finger(b, c, e1, e2, R, a0, a1, segs, thick, part) {
  const arc = a1 - a0, segLen = (Math.abs(arc) * R) / segs + 0.0045;
  for (let j = 0; j < segs; j++) {
    const t = a0 + arc * (j + 0.5) / segs, co = Math.cos(t), si = Math.sin(t);
    const dx = co * e1[0] + si * e2[0], dy = co * e1[1] + si * e2[1], dz = co * e1[2] + si * e2[2];
    const tx = -si * e1[0] + co * e2[0], ty = -si * e1[1] + co * e2[1], tz = -si * e1[2] + co * e2[2];
    const w = thick * (1 - j * 0.12);
    b.add(alignY(rbox(w, segLen, w * 1.1, w * 0.38), tx, ty, tz), 'grip', { p: [c[0] + dx * R, c[1] + dy * R, c[2] + dz * R], part });
    if (j === 0) // knuckle armor plate riding the proximal segment
      b.add(alignY(rbox(w * 0.9, segLen * 0.62, w * 0.45, 0.002), tx, ty, tz), 'metal2', { p: [c[0] + dx * (R + w * 0.6), c[1] + dy * (R + w * 0.6), c[2] + dz * (R + w * 0.6)], part });
  }
}

// forearm + wrist armor reaching off-screen toward the camera's lower corner. wrist = attach point, d = direction to elbow.
function forearm(b, wrist, dx, dy, dz, part = null) {
  const d = _d.set(dx, dy, dz).normalize().clone();
  const arm = alignY(new THREE.CylinderGeometry(0.032, 0.025, 0.30, 10), d.x, d.y, d.z); // narrow at wrist, flares to elbow
  b.add(arm, 'dark', { p: [wrist[0] + d.x * 0.17, wrist[1] + d.y * 0.17, wrist[2] + d.z * 0.17], part });
  const cuff = alignY(new THREE.CylinderGeometry(0.029, 0.026, 0.055, 10), d.x, d.y, d.z);   // metal bracer
  b.add(cuff, 'metal2', { p: [wrist[0] + d.x * 0.055, wrist[1] + d.y * 0.055, wrist[2] + d.z * 0.055], part });
  const ring = alignY(new THREE.TorusGeometry(0.028, 0.0026, 6, 16).rotateX(PI / 2), d.x, d.y, d.z);
  b.add(ring, 'gold', { p: [wrist[0] + d.x * 0.085, wrist[1] + d.y * 0.085, wrist[2] + d.z * 0.085], part });
  const plate = alignY(rbox(0.052, 0.10, 0.038, 0.006), d.x, d.y, d.z);                       // top-of-forearm plate
  b.add(plate, 'metal2', { p: [wrist[0] + d.x * 0.19 - dz * 0.012, wrist[1] + d.y * 0.19 + 0.016, wrist[2] + d.z * 0.19 - 0.012], part });
}

// hand around a vertical grip (pistol grips, fusion foregrip). p = grip center, tilt = grip lean (rot X), R = wrap radius.
export function gripHand(b, { p, tilt = -0.35, R = 0.021, side = 1, part = null } = {}) {
  const ax = Math.cos(tilt), az = Math.sin(tilt);                        // grip axis (unit, along tilted +Y)
  const e1 = [side, 0, 0], e2 = [0, az, -ax];                            // arc basis: grip side -> front
  const at = (dy, ox = 0, oy = 0, oz = 0) => [p[0] + ox, p[1] + dy * ax + oy, p[2] + dy * az + oz];
  for (let i = 0; i < 4; i++) finger(b, at(0.020 - i * 0.0145), e1, e2, R + 0.001, -0.35, 2.95, 3, 0.0125 * (i === 3 ? 0.9 : 1), part);
  // palm block + heel on the gripping side, thumb (2 segments) on the other side reaching forward
  b.add(rbox(0.019, 0.06, 0.046, 0.006), 'grip', { p: at(0.004, side * (R + 0.005)), r: [tilt, 0, -side * 0.08], part });
  b.add(rbox(0.017, 0.022, 0.034, 0.005), 'grip', { p: at(-0.024, side * (R + 0.003), 0, 0.006), r: [tilt, 0, -side * 0.15], part });
  b.add(rbox(0.0115, 0.0115, 0.026, 0.004), 'grip', { p: at(0.026, -side * (R - 0.001), 0, -0.006), r: [tilt, side * 0.35, 0], part });
  b.add(rbox(0.010, 0.010, 0.024, 0.0035), 'grip', { p: at(0.028, -side * (R - 0.004), 0, -0.026), r: [tilt, side * 0.75, 0], part });
  // armored back-of-hand plate + gold knuckle studs
  b.add(rbox(0.015, 0.052, 0.017, 0.004), 'metal2', { p: at(0.006, side * (R + 0.012)), r: [tilt, 0, 0], part });
  for (let i = 0; i < 3; i++) b.add(new THREE.SphereGeometry(0.003, 6, 5), 'gold', { p: at(0.016 - i * 0.014, side * (R + 0.014)), part });
  forearm(b, at(-0.040, side * 0.014, 0, 0.024), side * 0.42, -0.72, 0.60, part);
}

// support hand under a horizontal tube/handguard along Z. p = tube center, R = wrap radius, dz shifts fingers along the tube.
export function wrapHand(b, { p, R = 0.03, part = null, dz = 0 } = {}) {
  const e1 = [1, 0, 0], e2 = [0, 1, 0];
  for (let i = 0; i < 4; i++) finger(b, [p[0], p[1], p[2] + dz - 0.021 + i * 0.0148], e1, e2, R + 0.001, -0.55, 3.05, 3, 0.0125 * (i === 3 ? 0.9 : 1), part);
  // palm under-left + heel, thumb along the left side pointing forward (2 segments)
  b.add(rbox(0.020, 0.06, 0.06, 0.006), 'grip', { p: [p[0] - (R + 0.002) * 0.72, p[1] - (R + 0.002) * 0.72, p[2] + dz + 0.004], r: [0, 0, 0.72], part });
  b.add(rbox(0.017, 0.024, 0.04, 0.005), 'grip', { p: [p[0] - (R + 0.004) * 0.5, p[1] - (R + 0.006) * 0.85, p[2] + dz + 0.022], r: [0, 0, 0.5], part });
  b.add(rbox(0.0115, 0.0115, 0.028, 0.004), 'grip', { p: [p[0] - R - 0.004, p[1] + 0.006, p[2] + dz - 0.024], r: [0.06, 0.16, 0.12], part });
  b.add(rbox(0.010, 0.010, 0.024, 0.0035), 'grip', { p: [p[0] - R - 0.001, p[1] + 0.012, p[2] + dz - 0.046], r: [0.2, 0.35, 0.2], part });
  // armored strip along the top knuckles + gold studs
  b.add(rbox(0.052, 0.015, 0.018, 0.004), 'metal2', { p: [p[0] - 0.002, p[1] + R + 0.010, p[2] + dz], part });
  for (let i = 0; i < 3; i++) b.add(new THREE.SphereGeometry(0.003, 6, 5), 'gold', { p: [p[0] - 0.014 + i * 0.014, p[1] + R + 0.013, p[2] + dz], part });
  forearm(b, [p[0] - (R + 0.012) * 0.7, p[1] - (R + 0.014) * 0.7, p[2] + dz + 0.024], -0.40, -0.70, 0.63, part);
}

// cupped palm-up hand for reload performances (speedloader / shells). Authored in the part's LOCAL frame around
// pivot p (the part's baseRot orients it). Fingers curl up at the front edge, thumb on +X.
export function looseHand(b, { p, part = null } = {}) {
  const at = (l) => [p[0] + l[0], p[1] + l[1], p[2] + l[2]];
  b.add(rbox(0.048, 0.014, 0.055, 0.005), 'grip', { p: at([0, -0.012, 0.004]), part });                 // palm
  b.add(rbox(0.044, 0.013, 0.02, 0.004), 'grip', { p: at([0, -0.010, 0.028]), r: [-0.25, 0, 0], part }); // heel
  for (let i = 0; i < 4; i++) {
    const x = -0.0195 + i * 0.013, w = 0.0115 * (i === 3 ? 0.9 : 1);
    b.add(rbox(w, 0.021, w * 1.1, w * 0.38), 'grip', { p: at([x, -0.002, -0.026]), r: [0.75, 0, 0], part });
    b.add(rbox(w * 0.9, 0.019, w, w * 0.35), 'grip', { p: at([x, 0.012, -0.034]), r: [1.45, 0, 0], part });
    b.add(rbox(w * 0.85, 0.013, w * 0.45, 0.002), 'metal2', { p: at([x, -0.001, -0.032]), r: [0.75, 0, 0], part }); // knuckle plate
  }
  b.add(rbox(0.011, 0.011, 0.03, 0.004), 'grip', { p: at([0.028, -0.004, -0.004]), r: [0.35, 0, -0.5], part });    // thumb
  forearm(b, at([0, -0.02, 0.045]), 0.18, -0.72, 0.62, part);
}
