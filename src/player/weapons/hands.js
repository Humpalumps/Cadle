import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * Procedural first-person hands/arms (Destiny-style armored gauntlets). Built INTO the gun's Builder buckets
 * (materials: hand=fine glove leather, dark=undersleeve, metal2=armor plates, gold=trim) so they merge with the
 * gun geometry -> zero extra draw calls. Gun space: +Y up, +X right, forward -Z, origin = top of pistol grip.
 *
 *   gripHand(b, { p, tilt, R, side, part })  hand wrapped around a vertical(ish) grip. side=1 right hand, -1 left.
 *   wrapHand(b, { p, R, part, dz })          support hand wrapped around a horizontal tube/handguard along Z.
 *   looseHand(b, { p, part })                cupped palm-up hand (reload performances: speedloader/shells).
 * Fingers are SEGMENTED (4 rounded knuckle segments per finger + armored plate on the proximal one) and each
 * finger carries its OWN curl arc/thickness — four identical parallel curls read robotic; a staggered wrap
 * (index straighter and high, middle deepest, pinky short and shallow) reads gripped. Pass part='lhand' to
 * make the support hand animatable.
 */
const PI = Math.PI;
const _q = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();
const rbox = (w, h, d, r = 0.003) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.49));
const alignY = (g, x, y, z) => g.applyQuaternion(_q.setFromUnitVectors(_Y, _d.set(x, y, z).normalize()));

// one segmented finger wrapping an arc of radius R around center c, in the plane spanned by unit vectors e1,e2.
// a0..a1 radians (dir(t)=cos*e1+sin*e2). segs knuckle segments, tapering; armored plate over segment 0.
// Segments overlap (+6 mm on the arc share) and round hard (r = w*0.48) so the curl reads as one padded finger,
// not a chain of boxes with daylight between the knuckles.
function finger(b, c, e1, e2, R, a0, a1, segs, thick, part, tipTuck = 0) {
  const arc = a1 - a0, segLen = (Math.abs(arc) * R) / segs + 0.006;
  for (let j = 0; j < segs; j++) {
    const t = a0 + arc * (j + 0.5) / segs, co = Math.cos(t), si = Math.sin(t);
    const Rj = R - tipTuck * (j / (segs - 1));   // distal segments taper thinner, so pull them INTO the grip: a tip that stands off the flat shows daylight from behind
    const dx = co * e1[0] + si * e2[0], dy = co * e1[1] + si * e2[1], dz = co * e1[2] + si * e2[2];
    const tx = -si * e1[0] + co * e2[0], ty = -si * e1[1] + co * e2[1], tz = -si * e1[2] + co * e2[2];
    const w = thick * (1 - j * 0.09);
    b.add(alignY(rbox(w, segLen, w * 1.08, w * 0.48), tx, ty, tz), 'hand', { p: [c[0] + dx * Rj, c[1] + dy * Rj, c[2] + dz * Rj], part });
    if (j === 0) // knuckle armor plate half-embedded in the proximal segment (at +0.6R the chips floated above the fingers as loose fins)
      b.add(alignY(rbox(w * 0.98, segLen * 0.68, w * 0.38, 0.003), tx, ty, tz), 'metal2', { p: [c[0] + dx * (R + w * 0.42), c[1] + dy * (R + w * 0.42), c[2] + dz * (R + w * 0.42)], part });
  }
}

// per-finger wrap variation shared by both gripping hands: a0 = arc start, a1 = arc-end offset,
// th = thickness scale, dR = wrap radius offset. Index straighter, middle deepest, pinky short and shallow.
const FVAR = [
  { a0: -0.28, a1: -0.24, th: 1.00, dR: 0.0015 },
  { a0: -0.36, a1: 0.10, th: 1.05, dR: 0.0 },
  { a0: -0.33, a1: 0.04, th: 0.97, dR: -0.0006 },
  { a0: -0.22, a1: -0.30, th: 0.85, dR: -0.0016 },
];

// forearm + wrist armor reaching off-screen toward the camera's lower corner. wrist = attach point, d = direction to elbow.
// `len` shortens the arm tube: at full length beside a rifle it reads as a second barrel, so the ability gauntlet
// (which floats in open frame with nothing to sell the scale) asks for a stub and keeps only the cuff/ring/plate.
// The sleeve is GLOVE leather (matte), elliptical in cross-section (flattened toward the ulna) and 14-sided:
// the old 'dark' 10-sided cylinder read as a glossy PVC pipe with a chrome end-cap disc at the wrist.
function forearm(b, wrist, dx, dy, dz, part = null, len = 0.30) {
  const d = _d.set(dx, dy, dz).normalize().clone();
  // padded wrist joint bridging glove -> sleeve (covers the sleeve's near end cap, which used to catch the sun)
  b.add(alignY(rbox(0.047, 0.038, 0.041, 0.011), d.x, d.y, d.z), 'hand', { p: [wrist[0] + d.x * 0.012, wrist[1] + d.y * 0.012, wrist[2] + d.z * 0.012], part });
  const arm = alignY(new THREE.CylinderGeometry(0.032, 0.025, len, 14).scale(1.1, 1, 0.9), d.x, d.y, d.z); // narrow at wrist, flares to elbow, ulna-flattened
  const am = len * 0.567, ap = len * 0.633;
  b.add(arm, 'hand', { p: [wrist[0] + d.x * am, wrist[1] + d.y * am, wrist[2] + d.z * am], part });
  // bracer cuff in MATTE dark steel ('metal'): the brighter metal2 read as a glossy silver band this close to camera
  const cuff = alignY(new THREE.CylinderGeometry(0.031, 0.029, 0.055, 12), d.x, d.y, d.z);
  b.add(cuff, 'metal', { p: [wrist[0] + d.x * 0.055, wrist[1] + d.y * 0.055, wrist[2] + d.z * 0.055], part });
  const ring = alignY(new THREE.TorusGeometry(0.0305, 0.0026, 6, 16).rotateX(PI / 2), d.x, d.y, d.z);
  b.add(ring, 'gold', { p: [wrist[0] + d.x * 0.085, wrist[1] + d.y * 0.085, wrist[2] + d.z * 0.085], part });
  // top-of-forearm armor plate, half-embedded in the sleeve along the arm's own "up" (perpendicular component of
  // world-up): the old fixed world-space offset left it hovering next to the sleeve as a detached slab.
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(d, -d.y).normalize();
  const plate = alignY(rbox(0.052, Math.min(0.10, len * 0.34), 0.038, 0.006), d.x, d.y, d.z);
  b.add(plate, 'metal', { p: [wrist[0] + d.x * ap + up.x * 0.030, wrist[1] + d.y * ap + up.y * 0.030, wrist[2] + d.z * ap + up.z * 0.030], part });
}

// hand around a vertical grip (pistol grips, fusion foregrip). p = grip center, tilt = grip lean (rot X), R = wrap radius.
export function gripHand(b, { p, tilt = -0.35, R = 0.021, side = 1, part = null, armLen = 0.30, armDir = null } = {}) {
  const ax = Math.cos(tilt), az = Math.sin(tilt);                        // grip axis (unit, along tilted +Y)
  const e1 = [side, 0, 0], e2 = [0, az, -ax];                            // arc basis: grip side -> front
  const at = (dy, ox = 0, oy = 0, oz = 0) => [p[0] + ox, p[1] + dy * ax + oy, p[2] + dy * az + oz];
  // wrap radius tucked 2.5 mm INTO the grip: the grip is a box, the finger arc is a circle, and at ADS the
  // arc's bulge past the box's front corners showed daylight slivers between fingertips and grip. Clipping
  // slightly into the box is invisible; a gap is not.
  for (let i = 0; i < 4; i++) {
    const f = FVAR[i];
    finger(b, at(0.020 - i * 0.0145), e1, e2, R - 0.0015 + f.dR, f.a0, 2.95 + f.a1, 4, 0.0125 * f.th, part, 0.004);
  }
  // palm block + heel PRESSED into the grip side (centers tucked ~5 mm vs the old R+offset: seen from behind
  // at ADS the palm floated 4 mm off the grip flat and the gap read as a bright sliver), thumb on the other side
  b.add(rbox(0.019, 0.06, 0.046, 0.007), 'hand', { p: at(0.004, side * (R - 0.0005)), r: [tilt, 0, -side * 0.08], part });
  b.add(rbox(0.017, 0.022, 0.034, 0.006), 'hand', { p: at(-0.024, side * (R - 0.002), 0, 0.006), r: [tilt, 0, -side * 0.15], part });
  b.add(rbox(0.0115, 0.0115, 0.026, 0.005), 'hand', { p: at(0.026, -side * (R - 0.001), 0, -0.006), r: [tilt, side * 0.35, 0], part });
  b.add(rbox(0.010, 0.010, 0.024, 0.0045), 'hand', { p: at(0.028, -side * (R - 0.004), 0, -0.026), r: [tilt, side * 0.75, 0.12], part });
  // armored back-of-hand plate + gold knuckle studs (ride the tucked palm surface)
  b.add(rbox(0.015, 0.052, 0.017, 0.004), 'metal2', { p: at(0.006, side * (R + 0.0065)), r: [tilt, 0, 0], part });
  for (let i = 0; i < 3; i++) b.add(new THREE.SphereGeometry(0.003, 6, 5), 'gold', { p: at(0.016 - i * 0.014, side * (R + 0.0085)), part });
  // armDir lets a caller aim the arm in the hand's LOCAL frame — the ability gauntlet is yawed a quarter turn, so
  // the default direction would send the forearm across the screen instead of trailing back past the camera.
  const ad = armDir ?? [side * 0.42, -0.72, 0.60];
  forearm(b, at(-0.040, side * 0.014, 0, 0.024), ad[0], ad[1], ad[2], part, armLen);
}

// support hand under a horizontal tube/handguard along Z. p = tube center, R = wrap radius, dz shifts fingers along the tube.
export function wrapHand(b, { p, R = 0.03, part = null, dz = 0 } = {}) {
  const e1 = [1, 0, 0], e2 = [0, 1, 0];
  for (let i = 0; i < 4; i++) {
    const f = FVAR[i];
    finger(b, [p[0], p[1], p[2] + dz - 0.021 + i * 0.0148], e1, e2, R + 0.001 + f.dR, -0.55 - f.a0 * 0.5, 3.05 + f.a1, 4, 0.0125 * f.th, part);
  }
  // palm under-left + heel, thumb along the left side pointing forward (2 segments)
  b.add(rbox(0.020, 0.06, 0.06, 0.007), 'hand', { p: [p[0] - (R + 0.002) * 0.72, p[1] - (R + 0.002) * 0.72, p[2] + dz + 0.004], r: [0, 0, 0.72], part });
  b.add(rbox(0.017, 0.024, 0.04, 0.006), 'hand', { p: [p[0] - (R + 0.004) * 0.5, p[1] - (R + 0.006) * 0.85, p[2] + dz + 0.022], r: [0, 0, 0.5], part });
  b.add(rbox(0.0115, 0.0115, 0.028, 0.005), 'hand', { p: [p[0] - R - 0.004, p[1] + 0.006, p[2] + dz - 0.024], r: [0.06, 0.16, 0.12], part });
  b.add(rbox(0.010, 0.010, 0.024, 0.0045), 'hand', { p: [p[0] - R - 0.001, p[1] + 0.012, p[2] + dz - 0.046], r: [0.2, 0.35, 0.2], part });
  // armored strip along the top knuckles + gold studs
  b.add(rbox(0.052, 0.015, 0.018, 0.004), 'metal2', { p: [p[0] - 0.002, p[1] + R + 0.010, p[2] + dz], part });
  for (let i = 0; i < 3; i++) b.add(new THREE.SphereGeometry(0.003, 6, 5), 'gold', { p: [p[0] - 0.014 + i * 0.014, p[1] + R + 0.013, p[2] + dz], part });
  forearm(b, [p[0] - (R + 0.012) * 0.7, p[1] - (R + 0.014) * 0.7, p[2] + dz + 0.024], -0.40, -0.70, 0.63, part);
}

// cupped palm-up hand for reload performances (speedloader / shells). Authored in the part's LOCAL frame around
// pivot p (the part's baseRot orients it). Fingers curl up at the front edge (each its own curl), thumb on +X.
export function looseHand(b, { p, part = null } = {}) {
  const at = (l) => [p[0] + l[0], p[1] + l[1], p[2] + l[2]];
  b.add(rbox(0.048, 0.014, 0.055, 0.006), 'hand', { p: at([0, -0.012, 0.004]), part });                 // palm
  b.add(rbox(0.044, 0.013, 0.02, 0.005), 'hand', { p: at([0, -0.010, 0.028]), r: [-0.25, 0, 0], part }); // heel
  for (let i = 0; i < 4; i++) {
    const x = -0.0195 + i * 0.013, w = 0.0115 * (i === 3 ? 0.85 : i === 1 ? 1.04 : 1);
    const c0 = 0.68 + i * 0.05, c1 = 1.34 + i * 0.08;   // each finger its own curl: cupped, not a parallel rake
    b.add(rbox(w, 0.021, w * 1.08, w * 0.45), 'hand', { p: at([x, -0.002, -0.026]), r: [c0, 0, 0], part });
    b.add(rbox(w * 0.9, 0.019, w, w * 0.42), 'hand', { p: at([x, 0.012 - i * 0.001, -0.034 + i * 0.0012]), r: [c1, 0, 0], part });
    b.add(rbox(w * 0.85, 0.013, w * 0.45, 0.002), 'metal2', { p: at([x, -0.001, -0.032]), r: [c0, 0, 0], part }); // knuckle plate
  }
  b.add(rbox(0.011, 0.011, 0.03, 0.005), 'hand', { p: at([0.028, -0.004, -0.004]), r: [0.35, 0, -0.5], part });    // thumb
  forearm(b, at([0, -0.02, 0.045]), 0.18, -0.72, 0.62, part);
}
