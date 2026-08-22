// character.js — the seated gamer + his chair for the cinematic intro.
//
// WHAT THIS IS
//   A fully procedural (zero-asset) seated young-adult gamer in a hoodie with over-ear
//   headphones, hands on keyboard + mouse, in a high-backed gaming chair. Authored directly
//   in the intro's WORLD coordinates (floor y=0, he faces -Z, desk top y=0.745, monitor
//   screen centre (0, 1.21, -0.945), panel 0.868 x 0.49). The hero angle is the BACK three-quarter
//   dolly (0.98, 1.96, 2.28) -> (1.14, 1.82, 1.86) looking at ~(0.06, 1.13, -0.48), 38 deg vFOV.
//   NOTE (2026-08-22): the visible BODY is now a generated GLB loaded by stage.js; the body in this
//   file is the fallback for when that download fails. The CHAIR here is always the one on screen.
//   The HOODIE_TINT derivation further down was measured against an older, dimmer lighting rig — the
//   number may still be right but do not re-derive it from that recipe; re-measure against stage.js.
//   The camera sits at +X, which is his RIGHT: everything that has to read — the hood bunch, the
//   hair silhouette, the shoulder seam, the sleeve — must be visible over his RIGHT shoulder, or
//   it may as well not exist. Judge every change from that camera, never from straight behind.
//   MEASURE, DON'T EYEBALL. Two whole revisions were spent tuning things that are not in the shot:
//   at this framing the UPPER arm is the sleeve (screen 828,700 -> 996,877) and the forearm is 90 px
//   of foreshortened tube behind the hand; the chair sits below-LEFT of him, never past his right
//   shoulder. Project the part you are about to change before you change it (see the harness recipe
//   at the bottom of this file), and sample the rendered pixels rather than trusting the viewer —
//   the shot is sRGB, but every image viewer in this pipeline shows it gamma-boosted, so a garment
//   that samples at sRGB 18 is what everyone calls "display 76".
//   No face geometry beyond ear/jaw/neck.
//
// POSE COMPOSITION RULE (important — read before editing)
//   `update(t)` and `setSuck(k)` are NOT two animators that fight. Both only store their
//   input (`_t`, `_k`) and then call `_apply()`, which rebuilds the ENTIRE pose from the
//   immutable rest constants every time:  rest -> idle(_t) -> suck(_k) layered on top.
//   Therefore setSuck(0) is exactly the idle pose, calling it every frame is free, and the
//   order of the two calls in a frame never matters. Never write pose state incrementally.
//
// ARMS are two-bone IK (shoulder -> elbow -> wrist) re-solved every frame against a wrist
//   TARGET point. That is what keeps the hands planted on the keyboard/mouse while the chest
//   breathes, and what makes the suck reach read as one continuous motion instead of a snap.
//   Hands hang off the rig (not the forearm) so the palms stay flat on the desk regardless of
//   the forearm roll the IK happens to produce.
//
// BLOB RULE (project decree): nothing here is emissive-white and nothing is glossy-small.
//   The single emissive element is the headphone accent ring — saturated violet #7c5bd6 at
//   emissiveIntensity 0.45, roughness 0.5. All other roughness stays >= 0.3.
//
// TEXTURES: the stage hands us `tex` (see stage.js) — `tex.hoodie` (knit fleece) drives the garment's
//   map+bump, `tex.leather` the chair. Both are SHARED objects: clone before touching .repeat, dispose the
//   clone. Every material keeps a working procedural fallback for `null`.
//
// No lights, no per-frame allocation.
//
// HARNESS RECIPE (what every measurement in this file was taken with):
//   node tools/inspect.mjs --nolock --name char --url http://127.0.0.1:5174/intro.html //     --steps '[{"wait":3},{"eval":"__intro.cam(1.02,1.72,1.46)"},{"wait":0.6},{"shot":"hero"}]'
//   then sample tools/out/char/shot-hero.png with Pillow. `__intro.stage.character` exposes the rig,
//   so an {eval} step can console.log a part's world bbox or its projected screen position.

import * as THREE from 'three';
import { makeCanvas } from './env.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- module scratch (no per-frame alloc)
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _sh = new THREE.Vector3();
const _el = new THREE.Vector3();
const _wr = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------- geometry helpers
const xf = (g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
  if (sx !== 1 || sy !== 1 || sz !== 1) g.scale(sx, sy, sz);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  return g;
};

const deform = (g, fn) => {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    _v.fromBufferAttribute(p, i);
    fn(_v, i);
    p.setXYZ(i, _v.x, _v.y, _v.z);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
};

const flat = (g) => (g.index ? g.toNonIndexed() : g);
const merge = (list) => (list.length === 1 ? flat(list[0]) : mergeGeometries(list.map(flat), false));

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
// sharp valleys, soft crowns — reads as cloth folds, not as a sine ripple
const crease = (x, k) => Math.pow(Math.abs(Math.sin(x)), k) - 0.62;

// piecewise-linear profile lookup over a [[u, ...vals], ...] table
const prof = (table, u) => {
  let i = 1;
  while (i < table.length - 1 && u > table[i][0]) i++;
  const a = table[i - 1], b = table[i];
  const t = Math.min(1, Math.max(0, (u - a[0]) / (b[0] - a[0])));
  return [lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
};

// ---------------------------------------------------------------- procedural textures
function fabricTex(rng) {
  const c = makeCanvas(96, 96);
  const g = c.getContext('2d');
  const img = g.createImageData(96, 96);
  const d = img.data;
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      const weave = ((x >> 1) & 1) ^ ((y >> 1) & 1) ? 226 : 196;
      const v = Math.max(150, Math.min(255, weave * 0.75 + (168 + rng() * 60) * 0.25));
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(7, 7);
  return t;
}

// ---------------------------------------------------------------- rig constants (world/body space)
// SCALE — measured, not eyeballed. A seated adult's crown is 1.32-1.40 m off the floor over a 0.46-0.50 m
// seat; the previous rig put him at 1.471 and he read as a giant next to the 0.745 desk. Two knobs fix it
// without touching a single hand-tuned local coordinate:
//   PELVIS.y 0.510  (seat pan top 0.470)  and  STATURE 0.96 applied to `torso.scale` in apply().
// Because the arms are IK'd to FIXED world wrist targets on the desk, shrinking the torso only shortens
// the shoulder-to-wrist span (0.523 -> 0.490 against a 0.587 reach) — the hands never leave the keys.
// Result: crown ~1.39, chair headrest top 1.16, so he still clearly clears the chair by 23 cm.
const STATURE = 0.96;
const PELVIS = new THREE.Vector3(0, 0.510, 0.13);
const LEAN = -0.26;                 // torso pitch, leaning toward the monitor
const SHOULDER_L = new THREE.Vector3(-0.165, 0.585, 0.012); // torso-local
const SHOULDER_R = new THREE.Vector3(0.165, 0.585, 0.012);
const L_UPPER = 0.315, L_FORE = 0.275;
const HAND_L_REST = new THREE.Vector3(-0.06, 0.782, -0.468); // palm centre, on the keys
const HAND_R_REST = new THREE.Vector3(0.30, 0.782, -0.465);  // palm centre, on the mouse
const WRIST_BACK = new THREE.Vector3(0, 0.015, 0.070);       // palm centre -> wrist joint
const HAND_L_REACH = new THREE.Vector3(-0.26, 1.30, -1.02);  // k=1 target
const HAND_R_REACH = new THREE.Vector3(0.26, 1.30, -1.02);

export function buildCharacter({ rng, tex }) {
  const tStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const R = typeof rng === 'function' ? rng : Math.random;
  const T = tex || {};

  const materials = [];
  const textures = [];
  const geometries = [];
  // emissiveIntensity defaults to 1 in three even with a black emissive. Harmless in maths, but this
  // project's blob rule is checked literally, so nothing here carries a >0 emissive budget it is not using.
  const mk = (Ctor, o) => { const m = new Ctor({ emissiveIntensity: 0, ...o }); materials.push(m); return m; };

  // the stage's textures are SHARED with room.js — always clone before touching .repeat, and dispose the clone
  const clone = (name, rx, ry) => {
    const src = T[name];
    if (!src) return null;
    const c = src.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(rx, ry);
    c.needsUpdate = true;
    textures.push(c);
    return c;
  };

  const fabric = fabricTex(R);                      // fallback weave (roughness breakup) when tex.hoodie is null
  textures.push(fabric);
  const knit = clone('hoodie', 5, 4);
  const leatherTex = clone('leather', 3.0, 3.0);    // fine perforation, not giant Victorian quilting

  // ------------------------------------------------------------ materials
  //
  // HOODIE VALUE AND HUE — a WHITE BALANCE, measured off the shipping frame. Read this before "fixing" it.
  //   The lighting rig is frozen and everything that reaches his back from the hero camera is warm:
  //   0xffb457@1.7 at (1.55,1.80,0.50) plus 0xffc9a8@1.15 at (1.55,1.95,1.85). The cool rim is on the far
  //   (-X) side and the hemi is only 0.62. Measured incident on the lit back: linear (1.00, 0.38, 0.12).
  //   With the near-neutral map (linear mean 0.074, 0.076, 0.084) times a flat 0.88, the rendered pixel
  //   came out sRGB (20, 9, 3) — i.e. saturation 0.85, a khaki poncho. That is not a tuning opinion, it
  //   is what the sampler says, and NO in-gamut grey albedo can fix it: out = albedo * light, so the only
  //   term in this module that can cancel a (1, 0.38, 0.12) key is a per-channel albedo of the inverse.
  //   Hence the vector below. It is not a "hack" and it is not emissive — it is the same thing a gaffer
  //   does with a CTB gel, done on the garment because the lights are frozen. Effective albedo lands at
  //   linear (0.046, 0.114, 0.38): a blue fabric under an orange key, which is exactly how the reference
  //   plate's charcoal fleece behaves under neutral light.
  //   HOW FAR TO TAKE IT — this is the whole tuning problem, so don't re-derive it from scratch. The two
  //   lights on his back want OPPOSITE corrections: the warm key measures (1, 0.411, 0.138) and wants an
  //   albedo of (1, 2.43, 7.25); the shadow-side fill (hemi + the -X rim + monitor spill) measures
  //   (1, 0.752, 1.204) and wants (1, 1.33, 0.83). No albedo satisfies both, so a full correction for the
  //   key turns everything the key does NOT reach into a blue garment. (1, 2.10, 4.30) is the chosen
  //   point: the LIT back — the thing the frame is actually about — measures display (90,85,76) at the
  //   shoulder, (82,80,71) mid-sleeve, (64,63,60) across the back, spread <= 14 everywhere, and the
  //   shadow side is merely cool instead of cobalt. Move it toward 7.25 and the shadows go blue; toward
  //   0.83 and the khaki poncho comes back. Measure BOTH regions before changing it.
  //   Target read: lit back display 60-95 per channel, spread < 15, clearly under the monitor panel
  //   (which measures display 158/171/220 in the same frame).
  //   WHAT CHANGED IN THE LAST PASS, and why the old number was too far: (0.72, 1.72, 3.74) normalises to
  //   (1, 2.39, 5.19), i.e. it is balanced almost purely against the warm key. But the warm key is not the
  //   only light on him — the monitor is a 0x9b8bff RectAreaLight at 9, whose linear ratio is (1, 0.81,
  //   3.1), and a 5.19x blue albedo MULTIPLIES that: the shoulder and sleeve facing the screen came out
  //   sRGB (86, 78, 191). A masked measurement said 2.3 % of the garment was brighter than the monitor
  //   panel itself, all of it that violet, and that — not the diffuse back, which measures 13 — is why a
  //   garment whose median pixel is a fifth of the monitor's still read as the lightest mass in frame.
  //   HOW FAR TO PULL THE BLUE BACK is the whole tuning problem, and a twelve-point sweep run live in the
  //   harness (set the three garment colours from an {eval} step, shoot, measure a magenta-emissive mask
  //   of the garment — the only reliable way, because ACES makes the response to this knob strongly
  //   non-linear) brackets it from both sides:
  //     ratio 5.19 (the old value)  lit back sRGB (23.9, 22.1, 22.7) — neutral, but 2.3 % of the garment
  //                                 renders BRIGHTER than the monitor panel, all of it screen-violet;
  //     ratio 2.65                  that violet drops to 1.5 %, but the lit back goes (26.7, 24.3, 15.3)
  //                                 — the khaki poncho is back;
  //     ratio 4.21 (chosen)         keeps the back within a couple of points of neutral and takes about a
  //                                 fifth off the violet blowout.
  //   Overall luminance is held at the old value (1.66) because the sweep also showed the lit garment is
  //   already only ~25 % under the monitor panel in display gamma: darkening it further drops it out of
  //   the 10-25 % target. The lightness problem was never the diffuse level, it was the sheen rims and
  //   the blue gain, and both of those are fixed above. Move THIS if the value is wrong again — never a
  //   flat brightness multiplier, which just re-tips the hue one way or the other.
  const HOODIE_TINT = new THREE.Color(0.78, 1.76, 3.28);
  const hoodieMat = (extra) => mk(THREE.MeshPhysicalMaterial, {
    // fallback (no map): the same balanced albedo baked as a plain colour, so `tex === null` still reads grey
    color: knit ? HOODIE_TINT.clone() : new THREE.Color(0.058, 0.134, 0.276),
    map: knit,
    // was 0.9 — at hero distance a knit that fine is sub-pixel, and a hard bump only sharpened the
    // grazing-angle terminator into noise. Halved: it still breaks the cloth up, it no longer sparkles.
    bumpMap: knit, bumpScale: knit ? 0.45 : 0,
    roughnessMap: knit ? null : fabric,
    roughness: 0.98, metalness: 0.0,
    // Fleece fuzz: a LIGHTING term, so it gives the garment its soft fibrous rim with no emissive at all.
    // 0.45 -> 0.28 -> 0.16. Sheen is REAL reflected energy stacked on the diffuse lobe and it peaks at
    // GRAZING angles, so it does not raise the garment evenly — it lights up every rounded silhouette
    // edge. Masked measurement of the shipping frame: the garment's median pixel was sRGB 15 against a
    // monitor panel at 70, but its 99th percentile was 112 — i.e. 1 % of the hoodie (the sheen rims down
    // the sleeve and over the shoulder) was 60 % BRIGHTER than the monitor, which is exactly why a
    // garment that measures dark still read as the lightest mass in the frame. Cutting sheen is the
    // right knob because it only touches those rims; the albedo, and with it the fold shading, is
    // untouched. Do not put it back up to "get the fleece rim" — that rim is the bug.
    sheen: 0.16, sheenRoughness: 0.95, sheenColor: new THREE.Color(0xa89c92),
    ...extra,
  });
  const tintX = (k) => new THREE.Color(HOODIE_TINT.r * k, HOODIE_TINT.g * k, HOODIE_TINT.b * k);

  const M = {
    hoodie: hoodieMat(),
    // THE HOOD IS THREE VALUE STEPS OF ONE CLOTH, and that is the whole reason it reads (critic note 3).
    // Torso ~display 64, flap ~70, collar roll ~80: doubled fleece catches more light, so each layer is a
    // step lighter than the one under it and the eye gets an actual edge at "where the hood ends and the
    // back begins". Silhouette alone never did it — from the hero camera the hood is nearly edge-on.
    // Do not flatten these back together, and do not make the flap DARKER than the torso (tried: it just
    // reads as a stain on his back, not as a garment layer).
    hoodiePanel: hoodieMat({    // hem roll of the hood + cuffs + waist hem
      color: knit ? tintX(1.24) : new THREE.Color(0.072, 0.166, 0.342),
    }),
    hoodFlap: hoodieMat({       // the hood's drape, lying down his back
      color: knit ? tintX(1.15) : new THREE.Color(0.067, 0.154, 0.317),
    }),
    // Brushed fleece lining in the mouth of the collar: the lightest cloth on him, ~1.6x the hoodie's
    // outgoing value, matte, never emissive and never near white. White-balanced the same way as the
    // garment (see HOODIE_TINT) — a warm-grey albedo under this warm key is what made the old hood khaki.
    hoodLining: mk(THREE.MeshStandardMaterial, { color: new THREE.Color(0.093, 0.214, 0.442), roughness: 0.99 }),
    string: mk(THREE.MeshStandardMaterial, { color: 0xa39c8c, roughness: 0.9 }),
    // SKIN: in both desk references the hands are the least conspicuous thing in frame. Desaturated,
    // darker than "flesh tone", matte (clearcoat on skin at this scale reads as wet plastic).
    skin: mk(THREE.MeshPhysicalMaterial, {
      color: 0x6f6058, roughness: 0.86, metalness: 0.0,
      sheen: 0.22, sheenColor: new THREE.Color(0x9aa0b2), sheenRoughness: 0.95,
    }),
    hair: mk(THREE.MeshPhysicalMaterial, {
      // honest dark warm brown. The reference plate's hair IS warm under this key — that is correct,
      // not a white-balance error, and the previous out-of-gamut blue albedo is what made it read as
      // a cracked ceramic helmet.
      // roughness 0.74 -> 0.84 and sheen 0.35 -> 0.20: at hero distance the broad specular lobe of the
      // old values pooled across the whole mass and read as moulded plastic. Matte, the individual locks
      // separate on their own shading instead of being washed together by one highlight.
      color: new THREE.Color(0x40332a), roughness: 0.84, metalness: 0.0,
      sheen: 0.20, sheenRoughness: 0.92, sheenColor: new THREE.Color(0x6d6055), // soft strand rim, no emissive
    }),
    phone: mk(THREE.MeshStandardMaterial, { color: 0x15151a, roughness: 0.48, metalness: 0.25 }),
    cushion: mk(THREE.MeshStandardMaterial, { color: 0x1d1d24, roughness: 0.95 }),
    accent: mk(THREE.MeshStandardMaterial, {
      color: 0x2a2140, roughness: 0.5, metalness: 0.0,
      emissive: new THREE.Color(0x7c5bd6), emissiveIntensity: 0.45, // saturated violet, capped: never white, never > 0.6
    }),
    cable: mk(THREE.MeshStandardMaterial, { color: 0x1a1a20, roughness: 0.6 }),
    pants: mk(THREE.MeshStandardMaterial, { color: 0x2a2f3a, roughness: 0.95, roughnessMap: fabric }),
    shoe: mk(THREE.MeshStandardMaterial, { color: 0x181a20, roughness: 0.7 }),
    // CHAIR: black mesh/leather gaming chair (both references). It stays black — but "black" at sRGB 2
    // in a room whose walls are already at sRGB 5 is not black, it is ABSENT, and the hero frame lost the
    // chair entirely (critic note 5). Same white balance as the garment so it reads as neutral charcoal
    // rather than brown, and lifted to ~sRGB 7-9 on the lit side: still the darkest large mass in frame,
    // but now separated from the wall behind it.
    leather: mk(THREE.MeshStandardMaterial, {
      color: leatherTex ? new THREE.Color(0.40, 0.84, 1.72) : new THREE.Color(0.012, 0.024, 0.051),
      map: leatherTex, roughness: 0.62, metalness: 0.05,
    }),
    leatherPlain: mk(THREE.MeshStandardMaterial, { color: new THREE.Color(0.012, 0.024, 0.051), roughness: 0.5, metalness: 0.08 }),
    metal: mk(THREE.MeshStandardMaterial, { color: 0x4c4e56, roughness: 0.42, metalness: 0.8 }),
    // the chair's edge trim: the ONE thing in the hero frame that says "gaming chair". A semi-rough
    // metal catches a thin warm specular line off the fairy-light point at (1.55,1.80,0.50) and draws the
    // backrest outline. Deliberately rough (0.52) and only half metallic so the line is a soft streak and
    // never a clipped highlight — a thin bright specular is exactly the thing the blob decree is about.
    trim: mk(THREE.MeshStandardMaterial, { color: 0x5a5d68, roughness: 0.52, metalness: 0.55 }),
    rubber: mk(THREE.MeshStandardMaterial, { color: 0x0e0e12, roughness: 0.85 }),
  };

  const mesh = (list, mat, parent, name) => {
    const g = merge(list);
    geometries.push(g);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = name || '';
    parent.add(m);
    return m;
  };

  // ------------------------------------------------------------ scene graph
  const group = new THREE.Group();
  group.name = 'introCharacter';
  const body = new THREE.Group();
  body.name = 'introBody';
  const chair = new THREE.Group();
  chair.name = 'introChair';
  group.add(body, chair);

  // `body` itself is the ORCHESTRATOR's handle (it re-parents it into its suck pivot and writes its
  // position/quaternion). Everything of ours lives one level down in `rig` so the two never fight.
  const rig = new THREE.Group();
  rig.name = 'introRig';
  body.add(rig);

  const torso = new THREE.Group();
  torso.position.copy(PELVIS);
  torso.rotation.x = LEAN;
  rig.add(torso);

  const headPivot = new THREE.Group();   // at neck base, torso-local
  headPivot.position.set(0, 0.600, -0.004);
  torso.add(headPivot);

  const hairDyn = new THREE.Group();     // strands + fringe: sweeps back during the suck
  headPivot.add(hairDyn);

  const legs = new THREE.Group();
  legs.position.set(0, 0.500, 0.09);   // follows PELVIS; the shin/ankle below are shortened to match so
                                       // the soles stay on the floor at y ~0.04 (see LEGS)
  rig.add(legs);

  const armL = new THREE.Group(), armR = new THREE.Group();
  const foreL = new THREE.Group(), foreR = new THREE.Group();
  armL.add(foreL); armR.add(foreR);
  foreL.position.set(0, L_UPPER, 0); foreR.position.set(0, L_UPPER, 0);
  const handL = new THREE.Group(), handR = new THREE.Group();
  rig.add(armL, armR, handL, handR);

  const cableGrp = new THREE.Group();
  rig.add(cableGrp);

  // ------------------------------------------------------------ TORSO (hoodie)
  // Oversized: the reference garment is a good 6-8 cm proud of the body on every side, and that
  // extra volume (plus the fold shading it makes possible) is most of what says "wearing a hoodie"
  // rather than "bare torso". Do not slim this back down to anatomy.
  {
    const H = 0.63;
    // [u, halfWidth, halfDepth] hem -> neck base
    const table = [
      [0.00, 0.188, 0.146],
      [0.16, 0.182, 0.140],
      [0.38, 0.190, 0.146],
      [0.60, 0.196, 0.150],
      [0.80, 0.209, 0.160],
      [0.90, 0.196, 0.148],
      [0.96, 0.170, 0.132],
      [1.00, 0.108, 0.100],
    ];
    const g = new THREE.CylinderGeometry(1, 1, 1, 40, 30, false);
    deform(g, (v) => {
      const u = v.y + 0.5;
      const [hw, hd] = prof(table, u);
      const a = Math.atan2(v.z, v.x);
      const back = Math.max(0, Math.sin(a));          // 1 straight up the spine side
      // cloth: sharp-valleyed drape folds, deepest low down where an oversized hoodie stacks on the seat
      const fold = 1
        + 0.046 * crease(a * 3.5 + u * 2.2, 0.60) * (1.20 - u)
        + 0.026 * crease(a * 6.0 - u * 4.0, 0.65)
        + 0.018 * crease(u * 11.0 + a * 1.5, 0.70) * (1.1 - 0.6 * u)
        // stacked horizontal folds where the hem piles on the seat — the reference is all seam and fold
        + 0.022 * crease(u * 17.0 - 0.6, 0.55) * smooth(0.42, 0.02, u);
      v.x *= hw * fold;
      v.z *= hd * fold;
      v.y = u * H;
      // hunched upper back
      v.z += 0.026 * smooth(0.45, 0.95, u) * back;
      // SEAMS. A hoodie is panels: a horizontal yoke across the blades, a stitched centre-back line, and
      // two side seams under the arms. Each is a narrow inward groove — geometry, so it shades itself.
      v.z -= 0.016 * Math.exp(-Math.pow((u - 0.72) / 0.050, 2)) * back;                  // yoke
      const spine = Math.exp(-Math.pow((a - Math.PI * 0.5) / 0.075, 2));
      v.z -= 0.010 * spine * smooth(0.10, 0.45, u) * smooth(0.86, 0.66, u);              // centre back
      const side = Math.exp(-Math.pow(Math.sin(a) / 0.10, 2));                           // a = 0 and PI = +-X
      v.x *= 1 - 0.030 * side * smooth(0.05, 0.30, u);
      v.z *= 1 - 0.030 * side * smooth(0.05, 0.30, u);
      // armhole: a deep set-in-sleeve trench arcing over the shoulder. This is the single line that
      // stops the arm and the body reading as one continuous bag from the hero camera.
      const arm = Math.exp(-Math.pow((u - 0.80) / 0.16, 2)) * Math.exp(-Math.pow(Math.sin(a) / 0.55, 2));
      v.x *= 1 - 0.105 * arm;
      v.z *= 1 - 0.080 * arm;
      // hem: the ribbed waistband pulls the drape in
      v.x *= 1 - 0.10 * smooth(0.10, 0.0, u);
      v.z *= 1 - 0.10 * smooth(0.10, 0.0, u);
    });
    const parts = [g];
    // sleeve caps — big, drooping, obviously fabric over the shoulder rather than a deltoid
    for (const s of [-1, 1]) {
      const d = new THREE.SphereGeometry(1, 22, 16);
      deform(d, (v) => {
        const a = Math.atan2(v.z, v.x);
        const r = 1 + 0.045 * crease(a * 4.0 + v.y * 6.0, 0.5);
        v.x *= 0.094 * r; v.y *= 0.064 * r; v.z *= 0.094 * r;
        v.y -= 0.040 * Math.max(0, -v.y / 0.072);      // the cap droops into the sleeve
      });
      parts.push(xf(d, s * 0.136, 0.532, 0.008, 0, 0, -s * 0.22));   // 16 mm lower: the shoulder line has to sit UNDER the hood roll
    }
    mesh(parts, M.hoodie, torso, 'torso');

    // ribbed hem band
    const hem = [];
    for (let i = 0; i < 3; i++) {
      const t2 = new THREE.TorusGeometry(0.190, 0.011, 6, 34);
      hem.push(xf(t2, 0, 0.020 + i * 0.019, 0.004, Math.PI * 0.5, 0, 0, 1.0, 1.0, 0.77));
    }
    mesh(hem, M.hoodiePanel, torso, 'hem');
  }

  // ---- HOOD, down. THE defining shape of this character (look at hoodie-back-ref.jpg).
  //
  // WHAT A DOWN HOOD ACTUALLY IS, and the failure this replaces. Four revisions built it as a fat even
  // TUBE lying across the shoulders plus a second lump under it, and every single one read as a travel
  // pillow — because a bolster of constant section IS a travel pillow, whatever colour it is. In the
  // reference the mass is not in a tube at all:
  //   * the only tubular element is the ~3 cm ROLLED HEM around the hood's mouth, and it is thinner than
  //     the neck it rings, not thicker;
  //   * everything else is a flattened DRAPE of doubled fleece lying against the back — pinched where it
  //     hangs off the neck seam, WIDEST across the upper back well below the shoulder line, converging to
  //     a soft rounded point between the blades;
  //   * its edges are CLOTH edges: the drape is 4 cm through the middle and tapers to nearly nothing at
  //     the rim, which is what stops a lens reading as a sphere;
  //   * nothing about it is mirror-symmetric — it hangs a few degrees off-axis with one side folded
  //     further over than the other, and its lower edge is a soft scalloped line, never a smooth arc.
  // Total ~32 cm wide, ~30 cm tall, mouth ~21 cm across. If the silhouette over his right shoulder is a
  // constant-thickness sausage again, this failed again.
  {
    const parts = [];

    // 1) THE ROLLED HEM of the mouth. A 1.30*PI arc (a real hood opens at the front), radius 0.104 with
    //    a 0.030 tube — 6 cm of doubled fleece where the fabric turns over, HALF what the old bolster
    //    was. `ang` is the angle after the arc is spun into place: sin(ang) = 1 at the nape, -1 at the
    //    throat. The gathers are shallow (0.10/0.30 rather than 0.22/0.50) because a hem gathers, a
    //    cushion bulges.
    const ARC = Math.PI * 1.30, SPIN = Math.PI * 0.5 - ARC * 0.5;
    const roll = new THREE.TorusGeometry(0.104, 0.030, 12, 44, ARC);
    deform(roll, (v) => {
      const ang = Math.atan2(v.y, v.x) + SPIN;
      const back = smooth(-0.25, 1.0, Math.sin(ang));
      const front = Math.max(0, -Math.sin(ang));
      const right = Math.exp(-Math.pow((ang - 0.55) / 0.70, 2));    // the camera's side: an extra gather
      const bunch = 1 + 0.085 * back + 0.055 * right + 0.070 * crease(ang * 5.0, 0.5);
      // the hem is FLATTER where it lies on the back and rounder at the sides — a rolled edge, not a pipe
      const thick = (1 + 0.26 * back + 0.16 * right + 0.22 * crease(ang * 4.0 + 0.4, 0.5)) * (1 - 0.62 * front * front);
      v.x *= bunch; v.y *= bunch; v.z *= thick;
    });
    roll.scale(0.98, 1.0, 0.66);
    roll.rotateZ(SPIN);
    roll.rotateX(Math.PI * 0.5 - 0.60);   // tipped further back: the mouth opens UP at the camera
    roll.rotateY(0.055);                  // ...and off-axis, like cloth that was shrugged off, not sewn on
    roll.translate(0.004, 0.601, 0.040);
    parts.push(roll);

    // 2) THE DRAPE. `t` runs 0 at the mouth to 1 at the hanging point; `prof` gives (halfWidth, halfDepth)
    //    at that height, so the outline is authored as a real garment pattern instead of an ellipsoid.
    //    SIZE — measured off hoodie-back-ref.jpg, not guessed, because the first attempt at this drape
    //    made it 32 cm across and it read as a CAPE, a flat plate laid over the shoulders with a knife
    //    edge. In the plate the hood spans 255 px against a 605 px shoulder width (42 %) and is 31 % of
    //    that width tall. Our shoulders are 0.46 m, so the hood is ~0.20 m across and ~0.15 m tall, i.e.
    //    barely wider than its own mouth — a down hood sits in the MIDDLE of the upper back, it does not
    //    reach the shoulder seams. It reads because of the value step and the shadow gap under the hem
    //    roll, never because it is big. Depth is 3 cm at the fattest: doubled fleece, nothing more.
    //    The top of the profile is NOT pinched to a stalk: the drape's sides continue down from the sides
    //    of the mouth, so at t=0 it is already three quarters of the hem roll's width. Pinched, it read
    //    as a separate green blob floating on his back with the collar hovering above it (measured with a
    //    debug-coloured pass — the roll is 12 cm forward of the drape in z, and at this camera +z projects
    //    LEFT, so any vertical gap between them opens sideways on screen and the two stop being one
    //    garment). Same reason for the -0.22 tilt below: the drape has to lean back as it descends or its
    //    top separates from the roll's back edge.
    const drape = [
      [0.00, 0.076, 0.018],   // hangs straight off the sides of the mouth
      [0.15, 0.100, 0.028],
      [0.35, 0.117, 0.032],   // widest across the upper back
      [0.58, 0.112, 0.030],
      [0.78, 0.092, 0.023],
      [0.92, 0.062, 0.015],
      [1.00, 0.034, 0.009],   // soft point between the shoulder blades
    ];
    const flap = [];
    const bag = new THREE.SphereGeometry(1, 40, 28);
    deform(bag, (v) => {
      const t = smooth(1.0, -1.0, v.y);                   // 0 at the mouth, 1 at the point
      const rr = Math.hypot(v.x, v.y);                    // 0 on the faces, 1 at the cloth edge
      const [hw0, hd] = prof(drape, t);
      const a = Math.atan2(v.z, v.x);
      // the OUTLINE itself wanders — a straight side edge is what made it look die-cut
      const hw = hw0 * (1 + 0.075 * Math.sin(t * 7.3 + 1.4) + 0.045 * Math.sin(t * 13.0));
      // soft folds, and an ASYMMETRIC one running diagonally across the left of the drape
      const fold = 1
        + 0.058 * crease(a * 3.0 + v.y * 3.4, 0.55)
        + 0.040 * crease(v.y * 7.0 + a * 1.4 + 1.1, 0.60)
        + 0.034 * crease(v.x * 22.0 - v.y * 5.0, 0.5) * smooth(0.0, -0.5, v.x);
      const yy = v.y;
      v.x *= hw * fold;
      // CLOTH EDGE, not a sphere horizon: the section thins toward the rim. rr^3 rather than rr^4 —
      // a quartic collapses over the last few percent and gives the edge a hard terminator.
      v.z *= hd * fold * (1 - 0.66 * Math.pow(rr, 3));
      v.y = yy * 0.108;
      v.z -= 0.030 * Math.pow(Math.abs(v.x) / 0.117, 2);  // wraps around the curve of the back
      v.x += 0.016 * t * t;                               // hangs off-axis toward the camera side
      v.y -= 0.018 * smooth(0.0, -0.9, yy);               // the point droops away from the body
      // IRREGULAR LOWER EDGE: scallop the hem so it is a soft broken line, never a drawn arc
      v.y -= (0.010 + 0.007 * Math.sin(v.x * 62.0 + 2.2)) * smooth(0.52, 1.0, t) * (0.5 + 0.5 * Math.sin(v.x * 36.0));
      // UNDERCUT: the top of the drape tucks IN under the hem roll. That gap is the hood's shadow line.
      v.z -= 0.022 * smooth(0.62, 1.0, yy);
    });
    flap.push(xf(bag, 0.002, 0.532, 0.150, -0.22, 0, -0.05));

    // 3) the centre fold — one soft ridge, set OFF the midline, so it is folded cloth and not a pillow
    const fold2 = new THREE.SphereGeometry(1, 22, 16);
    deform(fold2, (v) => {
      const t = smooth(1.0, -1.0, v.y);
      const rr = Math.hypot(v.x, v.y);
      // wide and shallow, NOT a spindle: at 0.028 x 0.082 x 0.017 it stood 13 mm proud of the drape and
      // silhouetted from straight behind as a pointed leaf stuck to his back. A fold in lying cloth is a
      // broad soft swell — it should shade, never outline.
      v.x *= 0.040 * (1 - 0.45 * t);
      v.y *= 0.062; v.z *= 0.010 * (1 - 0.70 * Math.pow(rr, 3));
    });
    flap.push(xf(fold2, -0.012, 0.545, 0.170, -0.22, 0, -0.10));

    // TWO meshes, not one: the hem roll is the lighter doubled-fleece panel, the drape sits between it
    // and the torso. That value step is what makes "where the hood ends and the back begins" visible.
    mesh(parts, M.hoodiePanel, torso, 'hood');
    mesh(flap, M.hoodFlap, torso, 'hoodFlap');

    // LINING: brushed fleece inside the MOUTH. A cone standing in the ring's hole is invisible — the neck
    // and the nape fill the hole from every angle this camera has. What you actually see of a down hood's
    // inside (and what the reference plate shows) is a pale crescent peeking over the BACK of the hem
    // roll, so that is what this is: the same arc as the roll, one ring-radius inboard and offset a
    // centimetre along the mouth's own normal so it clears the roll instead of hiding inside it.
    const lin = [];
    const LARC = Math.PI * 0.92, LSPIN = Math.PI * 0.5 - LARC * 0.5;
    const cres = new THREE.TorusGeometry(0.096, 0.014, 8, 28, LARC);
    deform(cres, (v) => {
      const a = Math.atan2(v.y, v.x);
      v.z *= 0.68 * (1 + 0.16 * crease(a * 6.0, 0.45));  // brushed fleece, gathered
    });
    cres.rotateZ(LSPIN);
    cres.rotateX(Math.PI * 0.5 - 0.60);
    cres.rotateY(0.055);
    // offset one tube-radius along the MOUTH'S OWN normal, (0, 0.825, -0.566) — up and forward. Anything
    // inside the ring is hidden by the neck and the nape, anything outside it reads as a second roll;
    // riding the mouth-facing side of the hem is the one place a camera looking DOWN at him can see it,
    // and it is what "the lining just showing" looks like on the plate.
    cres.translate(0.004, 0.622, 0.025);
    lin.push(cres);
    mesh(lin, M.hoodLining, torso, 'hoodLining');
  }

  // drawstrings — front-side of the chest, hanging with a slight sway built in
  const stringMesh = (() => {
    const parts = [];
    for (const s of [-1, 1]) {
      const pts = [
        new THREE.Vector3(s * 0.046, 0.508, -0.118),
        new THREE.Vector3(s * 0.062, 0.455, -0.130),
        new THREE.Vector3(s * 0.066, 0.400, -0.128),
        new THREE.Vector3(s * 0.078, 0.330, -0.118),
      ];
      const c = new THREE.CatmullRomCurve3(pts);
      parts.push(new THREE.TubeGeometry(c, 12, 0.0055, 6, false));
      // aglet
      parts.push(xf(new THREE.CylinderGeometry(0.007, 0.006, 0.020, 7), s * 0.078, 0.322, -0.117, 0.2, 0, 0));
    }
    return mesh(parts, M.string, torso, 'drawstrings');
  })();

  // ------------------------------------------------------------ NECK + HEAD
  {
    const neck = new THREE.CylinderGeometry(0.048, 0.070, 0.235, 16, 3, false);
    xf(neck, 0, 0.598, -0.010, 0.10, 0, 0);
    mesh([neck], M.skin, torso, 'neck');
  }

  const HEAD_C = new THREE.Vector3(0, 0.19, -0.005); // head-pivot local
  headPivot.rotation.x = 0.13; // counter the torso lean: he is looking level at the screen

  {
    const head = new THREE.SphereGeometry(1, 30, 24);
    deform(head, (v) => {
      const y = v.y, z = v.z;
      v.x *= 0.082; v.y *= 0.107; v.z *= 0.097;
      // jaw: taper the lower half, more at the front (chin)
      if (y < 0) {
        const d = Math.pow(-y, 1.5);
        v.x *= 1 - 0.42 * d;
        v.z *= 1 - (z < 0 ? 0.30 : 0.18) * d;
        v.z -= 0.012 * d; // chin forward
      }
      // occipital bulge (this is the shape the camera actually sees)
      if (z > 0) v.z *= 1 + 0.07 * smooth(-0.55, 0.45, y);
      // brow / flat forehead
      if (z < 0 && y > 0.25) v.z *= 0.96;
    });
    xf(head, HEAD_C.x, HEAD_C.y, HEAD_C.z);

    const ears = [];
    for (const s of [-1, 1]) {
      const e = new THREE.SphereGeometry(1, 12, 10);
      deform(e, (v) => { v.x *= 0.010; v.y *= 0.030; v.z *= 0.020; });
      ears.push(xf(e, s * 0.080, 0.178, 0.010, 0, 0, s * 0.12));
    }
    mesh([head, ...ears], M.skin, headPivot, 'head');
  }

  // ---- HAIR: three smooth base shells + ~45 soft LOCKS in three layers + a crown cluster.
  //
  // THREE earlier constructions failed here; all three failure modes are worth naming, because each fix
  // is one line and each regression looks like an art problem when it is a maths problem.
  //   (a) Many fine round strands -> at 1080p they average into one smooth dark cap: a helmet.
  //   (b) Fat round strands + scalloped shell rims -> plates and tentacles: a horse chestnut.
  //   (c) RAZOR ribbons (0.0085 thick against 0.030 wide = 28%) over a shell whose azimuthal noise term
  //       `sin(3*atan2(z,x))` was evaluated AT THE POLE, where atan2 fans out across the pole vertices
  //       and pinches a three-lobed star into the crown. Read together in the shipping frame those are
  //       "hard-edged shards with a triangular notch cut out of the crown — a cracked helmet".
  // The fixes, in order: locks are soft LENSES (thickness 45% of width, so the silhouette edge has a
  // rounded terminator instead of a knife), the shell's azimuth noise is faded out by horizontal radius
  // so it is exactly zero at the pole, a dedicated crown cluster covers the parting, lock lengths vary
  // better than 2:1 inside a layer, and the nape tapers to short soft down at the sides.
  {
    // base shells: smooth, no scallops. They only exist so the scalp is never visible between locks.
    const shells = [];
    const shell = (rx, ry, rz, oy, oz, theta, seed, cutBack, cutFront) => {
      const g = new THREE.SphereGeometry(1, 28, 20, 0, Math.PI * 2, 0, theta);
      deform(g, (v) => {
        const a = Math.atan2(v.z, v.x);
        const rad = Math.hypot(v.x, v.z);   // 0 AT THE POLE — this is what kills the triangular notch
        v.multiplyScalar(1 + 0.026 * Math.sin(a * 3.0 + seed) * rad + 0.015 * Math.sin(v.y * 6.0 + seed));
        v.x *= rx; v.y *= ry; v.z *= rz;
        // hairline: high at the forehead, over the ears at the sides, low at the nape
        v.y = Math.max(v.y, lerp(cutFront, cutBack, smooth(-0.012, -0.062, v.z)));
      });
      return xf(g, HEAD_C.x, HEAD_C.y + oy, HEAD_C.z + oz);
    };
    // NOT rotated: tilting the cap leaves a bald patch at the back of the crown, which is the exact
    // part of the head this camera looks at.
    // SHRUNK 6 %. These are a SCALP, not the haircut: while they matched the locks' own radius they WERE
    // the silhouette, every lock was buried inside them, and the head read as one smooth bell however
    // much the lock lengths varied. Pulled in, they only stop the scalp showing through the gaps.
    shells.push(shell(0.088, 0.111, 0.101, 0.002, 0.002, Math.PI * 0.80, 1.7 + R(), -0.052, 0.020));
    shells.push(shell(0.092, 0.098, 0.105, -0.030, 0.012, Math.PI * 0.88, 4.1 + R() * 2, -0.100, -0.030));
    // closed crown cap: no hairline clamp, no rim, purely there so the top can never open up again
    shells.push(shell(0.086, 0.114, 0.100, 0.004, 0.001, Math.PI * 0.52, 2.9 + R(), -1, -1));
    mesh(shells, M.hair, headPivot, 'hairShells');

    // ---- locks
    const HR = [0.096, 0.120, 0.112];
    const scalp = (az, el, k, out) => out.set(
      Math.cos(el) * Math.cos(az) * HR[0] * k,
      Math.sin(el) * HR[1] * k,
      Math.cos(el) * Math.sin(az) * HR[2] * k,
    ).add(HEAD_C);
    const _n = new THREE.Vector3();
    const locks = [];

    /** one lock: follows `curve`, `wide` across the skull, ~45% of that off it — a soft lens section */
    const lock = (curve, wide, segs = 9, thinRatio = 0.45) => {
      const g = new THREE.TubeGeometry(curve, segs, wide, 8, false);
      const p = g.attributes.position;
      const ring = 9;                                   // radialSegments + 1
      for (let vi = 0; vi < p.count; vi++) {
        const t = Math.min(1, Math.floor(vi / ring) / segs);
        curve.getPoint(t, _v2);
        _n.copy(_v2).sub(HEAD_C).normalize();           // outward from the skull
        _v.fromBufferAttribute(p, vi).sub(_v2);
        _v.addScaledVector(_n, -_v.dot(_n) * (1 - thinRatio));     // squash the off-skull axis, gently
        _v.multiplyScalar(1 - 0.42 * Math.pow(t, 1.7));            // tapers, but never to a shard point
        _v.add(_v2);
        p.setXYZ(vi, _v.x, _v.y, _v.z);
      }
      g.computeVertexNormals();
      locks.push(g);
    };

    // three radial layers; the outer ones are shorter so the inner layer's ends show below them
    // The radii matter more than the lengths: at k 1.005/1.048/1.088 against the old shells every lock
    // sat AT or just under the scalp surface, so the outline was the shell and the locks were surface
    // detail. 1.045/1.115/1.185 against the shrunk shells puts the outer layer ~9 mm proud of a 100 mm
    // skull — enough that individual locks own the silhouette and light gets in between them.
    const LAYERS = [
      { k: 1.045, n: 16, w: 0.022, len: 1.00 },
      { k: 1.115, n: 14, w: 0.020, len: 0.80 },
      { k: 1.185, n: 12, w: 0.018, len: 0.60 },
    ];
    // FIVE STRAYS. Scruffy is not "more variance everywhere" — an evenly noisy mass still averages into a
    // bob. What reads as messy is a handful of locks that leave the mass: longer than their neighbours,
    // lifted off the skull so light gets under them, and drifted sideways so they cross the outline. They
    // are chosen by running index, so the seed decides WHERE they land but there are always five.
    const STRAY = new Set();
    while (STRAY.size < 5) STRAY.add(Math.floor(R() * 42));
    let li2 = 0;
    for (let li = 0; li < LAYERS.length; li++) {
      const L = LAYERS[li];
      for (let i = 0; i < L.n; i++) {
        const stray = STRAY.has(li2++);
        const az = (i / L.n) * Math.PI * 2 + li * 0.55 + (R() - 0.5) * 0.58;   // uneven parting
        const front = Math.max(0, -Math.sin(az));       // 1 at the face, 0 at the back
        const el0 = 0.50 + R() * 0.80;
        // 2:1 length spread inside a layer — a shag is uneven, a wig is not
        const reach = (0.55 + R() * 1.25) * L.len * (stray ? 1.5 : 1);
        // THE BOB-MAKER WAS THIS FLOOR, not the reach. Every lock that ran out of skull bottomed out at
        // exactly el = -0.34, so all of them ended on one circle and the nape drew a clean hem — a bob,
        // no matter how much the lengths above it varied. Jittering the floor per lock (+-0.17 rad, ~+-35%
        // of the visible lock length) is what breaks the nape into separate strands.
        const floor = lerp(-0.34, 0.26, front) + (R() - 0.5) * 0.34;
        const elEnd = Math.max(el0 - reach, stray ? floor - 0.28 : floor);
        const drift = (R() - 0.5) * 0.55 + (stray ? (R() < 0.5 ? -0.52 : 0.52) : 0);
        const kick = stray ? 0.175 : 0.030;             // strays lift right off the mass; the rest hug the skull
        const pts = [];
        for (let s = 0; s <= 3; s++) {
          const t = s / 3;
          const p = scalp(az + drift * t, lerp(el0, elEnd, t), L.k + kick * t * t, new THREE.Vector3());
          if (s === 3) { p.y -= 0.008 + R() * 0.030; p.z += 0.006 + (stray ? 0.016 : 0); }  // tip drops, kicks back
          pts.push(p);
        }
        lock(new THREE.CatmullRomCurve3(pts), L.w * (0.62 + R() * 0.80) * (stray ? 0.82 : 1));
      }
    }

    // CROWN CLUSTER: short locks starting near the top and sweeping back over the parting. Without these
    // the highest thing on him is a bare shell and the whole head reads as moulded, not grown.
    for (let i = 0; i < 9; i++) {
      const az = (i / 9) * Math.PI * 2 + R() * 0.5;
      const el0 = 1.16 + R() * 0.26;
      const pts = [];
      for (let s = 0; s <= 2; s++) {
        const t = s / 2;
        pts.push(scalp(az + 0.30 * t, el0 - (0.42 + R() * 0.30) * t, 1.02 + 0.055 * t, new THREE.Vector3()));
      }
      lock(new THREE.CatmullRomCurve3(pts), 0.019 + R() * 0.008, 6, 0.55);
    }

    // NAPE: soft down that TAPERS — longest and widest at the centre of the neck, shrinking to almost
    // nothing at the sides, angled back. Equal-length chisels all round is the "helmet rim" look.
    for (let i = 0; i < 13; i++) {
      const f = i / 12;                                  // 0..1 across the back
      const az = Math.PI * (0.06 + f * 0.88) + (R() - 0.5) * 0.16;
      const mid = 1 - Math.abs(f - 0.5) * 2;             // 1 at the centre-back, 0 at the ears
      const taper = 0.30 + 0.70 * mid * mid;
      const r0 = new THREE.Vector3(Math.cos(az) * 0.092, -0.050 - R() * 0.020, Math.sin(az) * 0.106).add(HEAD_C);
      // 0.55..1.55x on top of the taper: the nape has to break into strands of visibly different length,
      // otherwise the down under the hem is itself a tiny second hem.
      const len = (0.030 + R() * 0.038) * taper * (0.55 + R()) + 0.010;
      const r1 = r0.clone().add(new THREE.Vector3(Math.cos(az) * 0.010, -len, Math.sin(az) * 0.018 + 0.014));
      const m = r0.clone().lerp(r1, 0.5).add(new THREE.Vector3(0, 0.002, 0.009));
      lock(new THREE.CatmullRomCurve3([r0, m, r1]), (0.009 + R() * 0.006) + 0.011 * taper, 5, 0.55);
    }
    mesh(locks, M.hair, hairDyn, 'hairStrands');
  }

  // ---- headphones. Real over-ears, not a torus plus a floating disc.
  // The numbers below are chosen so nothing can float: the hair shell reaches x = +-0.098, so the ear
  // cushion is centred at +-0.100 with a 0.019 tube (inner face 0.081 = INSIDE the hair, no gap), the cup
  // shell starts at 0.106 so it overlaps the cushion, and the band's ends and the cup are physically
  // bridged by a yoke arm plus a hub. The band also carries a fat pad that rests on the crown.
  {
    const bodyParts = [], cushions = [], accents = [];
    const BAND_ARC = Math.PI * 0.88, BR = 0.146;
    const band = new THREE.TorusGeometry(BR, 0.0165, 10, 44, BAND_ARC);
    xf(band, HEAD_C.x, HEAD_C.y + 0.006, HEAD_C.z + 0.006, 0, 0, (Math.PI - BAND_ARC) * 0.5, 1, 1, 0.52);
    bodyParts.push(band);
    // outer shell rib running along the band, so it is a moulded strap and not a wire hoop
    const rib = new THREE.TorusGeometry(BR + 0.010, 0.0075, 8, 40, BAND_ARC * 0.96);
    xf(rib, HEAD_C.x, HEAD_C.y + 0.006, HEAD_C.z + 0.006, 0, 0, (Math.PI - BAND_ARC * 0.96) * 0.5, 1, 1, 0.40);
    bodyParts.push(rib);
    // the head pad: thick, sits ON the crown, slightly inboard of the band it hangs from
    const pad = new THREE.TorusGeometry(BR - 0.014, 0.0235, 9, 26, Math.PI * 0.40);
    deform(pad, (v) => {
      const a = Math.atan2(v.y, v.x);
      v.multiplyScalar(1 + 0.05 * Math.sin(a * 6.0));    // stitched channels across the pad
    });
    xf(pad, HEAD_C.x, HEAD_C.y + 0.006, HEAD_C.z + 0.006, 0, 0, (Math.PI - Math.PI * 0.40) * 0.5, 1, 1, 0.66);
    cushions.push(pad);

    const endX = BR * Math.sin(BAND_ARC * 0.5), endY = HEAD_C.y + 0.006 + BR * Math.cos(BAND_ARC * 0.5);
    for (const s of [-1, 1]) {
      const cx = s * 0.124, cy = HEAD_C.y - 0.014, cz = HEAD_C.z + 0.010;
      // cup shell: a fat rounded puck, axis along X
      const cup = new THREE.CylinderGeometry(0.058, 0.055, 0.036, 28);
      bodyParts.push(xf(cup, cx, cy, cz, 0, 0, s * Math.PI * 0.5, 1, 1, 0.88));
      // domed outer face, sitting flush on the puck's rim (no gap, no flat black disc)
      const dome = new THREE.SphereGeometry(1, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.5);
      deform(dome, (v) => { v.x *= 0.056; v.y *= 0.020; v.z *= 0.049; });
      bodyParts.push(xf(dome, cx + s * 0.017, cy, cz, 0, 0, s * Math.PI * 0.5));
      // YOKE: a flat arm that physically spans band-end -> cup, plus the hub it pivots on
      const yoke = new RoundedBoxGeometry(0.017, 0.075, 0.030, 2, 0.007);
      const my = (endY + cy + 0.030) * 0.5;
      bodyParts.push(xf(yoke, s * (endX + 0.124) * 0.5, my, cz, 0, 0, -s * 0.22));
      const hub = new THREE.CylinderGeometry(0.014, 0.014, 0.028, 12);
      bodyParts.push(xf(hub, cx - s * 0.004, cy + 0.034, cz, 0, 0, s * Math.PI * 0.5));
      // ear cushion — pressed INTO the hair, so the join is an intersection and never a gap
      const cu = new THREE.TorusGeometry(0.045, 0.019, 9, 26);
      deform(cu, (v) => { v.z *= 1 + 0.25 * smooth(0.0, -1.0, v.z / 0.019); });
      cushions.push(xf(cu, s * 0.100, cy, cz, 0, s * Math.PI * 0.5, 0, 1, 0.90, 1));
      // saturated violet accent ring on the outer cup (the one emissive element on the whole character)
      const ring = new THREE.TorusGeometry(0.040, 0.0038, 6, 30);
      accents.push(xf(ring, cx + s * 0.0185, cy, cz, 0, s * Math.PI * 0.5, 0, 1, 0.90, 1));
    }
    mesh(bodyParts, M.phone, headPivot, 'headphones');
    mesh(cushions, M.cushion, headPivot, 'headphoneCushions');
    mesh(accents, M.accent, headPivot, 'headphoneAccent');
  }

  // ---- cable: from the LEFT cup (his left = -X) down to the desk, gentle sag
  {
    const top = new THREE.Vector3(-0.122, 1.235, 0.012);   // left cup, re-measured after PELVIS/STATURE
    cableGrp.position.copy(top);
    const pts = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(-0.030, -0.125, -0.012),
      new THREE.Vector3(-0.052, -0.255, -0.060),
      new THREE.Vector3(-0.048, -0.395, -0.150),
      new THREE.Vector3(-0.030, -0.448, -0.250),
      new THREE.Vector3(-0.010, -0.482, -0.345),
    ];
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.0048, 6, false);
    mesh([g], M.cable, cableGrp, 'cable');
  }

  // ------------------------------------------------------------ ARMS (geometry only; posed by IK)
  //
  // These are SLEEVES, not arms. The reference hoodie is baggy: the tube is 3-4 cm proud of the limb
  // inside it, it has a raglan seam ridge at the shoulder, it crumples into concentric folds at the
  // elbow, and it stops at a tight gathered rib cuff with the wrist emerging from it. Losing any of
  // those turns the arm back into one smooth tube from shoulder to hand.
  {
    // note: the ARM ROOT is at the shoulder and +Y runs down the bone, so u=0 is the shoulder end.
    // PROPORTION (this was wrong and it is the loudest tell of an amateur rig): the sleeve is FATTEST at
    // the shoulder and tapers all the way to the cuff. Upper 0.097 -> 0.078 at the elbow; forearm 0.073 at
    // the elbow -> 0.046 at the wrist. The elbow crumple is 2 shallow rings, not 3 deep ones, so the
    // forearm can never end up wider than the upper arm the way it did before.
    // THE UPPER ARM IS THE SLEEVE THE CAMERA SEES. Measured from the hero frame: the upper arm runs
    // screen (828,700) -> (996,877), ~200 px; the whole forearm is 90 px of foreshortened tube tucked
    // behind the hand. Three rounds of crease work went into fore() and changed nothing in the shot,
    // because fore() is not the part in the shot. Crumple THIS one.
    const upper = () => {
      const g = new THREE.CylinderGeometry(0.078, 0.097, L_UPPER, 22, 30, true);
      deform(g, (v) => {
        const u = v.y / L_UPPER + 0.5;                 // 0 = shoulder, 1 = elbow
        const a = Math.atan2(v.z, v.x);
        // loose cloth folds running down the sleeve, slack (deeper) toward the elbow
        let f = 1
          + 0.038 * crease(a * 3.5 + u * 3.4, 0.70) * (0.55 + 0.65 * u)
          + 0.018 * crease(a * 6.0 - u * 5.5, 0.75);
        // and the crumple rings. Amplitudes are 6-11 % of the sleeve radius (~6-10 mm of travel over
        // ~8 mm of length): that is the depth at which a fold's wall turns far enough from the key to
        // read as a shadow line rather than as a soft ramp. `wob` keeps them from being perfect
        // machined rings — a bunched sleeve gathers unevenly around its circumference.
        const wob = 0.80 + 0.20 * crease(a * 2.5 + 1.3, 0.6);
        f -= 0.060 * Math.exp(-Math.pow((u - 0.430) / 0.038, 2)) * wob;   // mid-sleeve drape fold
        f += 0.045 * Math.exp(-Math.pow((u - 0.530) / 0.045, 2)) * wob;
        f -= 0.095 * Math.exp(-Math.pow((u - 0.700) / 0.030, 2)) * wob;   // ELBOW CRUMPLE: the deep one
        f += 0.075 * Math.exp(-Math.pow((u - 0.790) / 0.034, 2)) * wob;   // fabric bunched below it
        f -= 0.078 * Math.exp(-Math.pow((u - 0.885) / 0.028, 2)) * wob;   // second crease into the joint
        v.x *= f; v.z *= f;
        // raglan seam: a shallow groove ringing the top of the sleeve where it meets the body
        v.x *= 1 - 0.10 * Math.exp(-Math.pow((u - 0.085) / 0.045, 2));
        v.z *= 1 - 0.10 * Math.exp(-Math.pow((u - 0.085) / 0.045, 2));
        // the sleeve hangs: slack gathers on the underside near the elbow
        v.z += 0.016 * smooth(0.55, 1.0, u) * Math.max(0, Math.cos(a));
      });
      return xf(g, 0, L_UPPER * 0.5, 0);
    };
    const fore = () => {
      // 36 height rings, not 18: a fold only shades if its WALL turns away from the key, and at 18 rings
      // one ring is 15 mm — wider than the fold itself, so every crease got averaged into a smooth ramp.
      // This is why the sleeve kept reading as a tube no matter how deep the creases were made.
      const g = new THREE.CylinderGeometry(0.043, 0.073, L_FORE, 22, 36, true);
      deform(g, (v) => {
        const u = v.y / L_FORE + 0.5;                  // 0 = elbow, 1 = wrist
        const a = Math.atan2(v.z, v.x);
        let f = 1
          + 0.042 * crease(a * 3.5 - u * 3.0, 0.70) * (1.0 - 0.35 * u)
          + 0.020 * crease(a * 6.0 + u * 4.5, 0.75);
        // ELBOW CRUMPLE (critic note 4). Two shallow BULGES read as nothing at hero distance, because a
        // bulge on a matte tube under a broad key barely changes value. What reads is the VALLEY between
        // them: a narrow inward groove turns its own wall away from the key and goes dark. So the profile
        // is now bulge / deep valley / bulge — the valley is 2.5x deeper than the old ripples and half as
        // wide, and it is biased to the OUTSIDE of the joint (cos a < 0 side), which is the side this
        // camera sees. That dark ring is the crease shadow.
        const outer = 0.65 + 0.35 * Math.max(0, -Math.cos(a));
        // AMPLITUDE. A 3 % dent is 2 px of radius at this framing — invisible, which is why three rounds
        // of "deeper creases" changed nothing. A real crumple in loose fleece moves the surface 10-15 %
        // of the sleeve radius, and that is what these are: ~8 mm of travel across ~7 mm of length, a
        // 45-50 deg wall that actually turns away from the key and goes dark.
        f += 0.050 * Math.exp(-Math.pow((u - 0.040) / 0.032, 2));               // bulge above the crease
        f -= 0.100 * Math.exp(-Math.pow((u - 0.108) / 0.024, 2)) * outer;       // THE crease
        f += 0.068 * Math.exp(-Math.pow((u - 0.180) / 0.032, 2)) * outer;       // bunched fabric below it
        f -= 0.052 * Math.exp(-Math.pow((u - 0.255) / 0.026, 2)) * outer;       // second, shallower fold
        // ...and two more down the middle of the sleeve. The elbow sits high and half-hidden behind the
        // hood from the hero camera, so creases confined to the joint never made it into the shot; the
        // 25 cm of forearm the camera DOES see needs its own slack or it stays a smooth tube.
        f -= 0.055 * Math.exp(-Math.pow((u - 0.430) / 0.028, 2)) * outer;
        f += 0.036 * Math.exp(-Math.pow((u - 0.515) / 0.038, 2)) * outer;
        f -= 0.044 * Math.exp(-Math.pow((u - 0.660) / 0.028, 2)) * outer;
        v.x *= f; v.z *= f;
        // the cuff gathers the slack in hard over the last 12% of the sleeve — deeper now (0.30 -> 0.40)
        // so the ribbed band below it steps OUT of the sleeve instead of continuing it
        const gather = smooth(0.84, 1.0, u);
        v.x *= 1 - 0.40 * gather; v.z *= 1 - 0.40 * gather;
      });
      return xf(g, 0, L_FORE * 0.5, 0);
    };
    mesh([upper()], M.hoodie, armL, 'upperArmL');
    mesh([upper()], M.hoodie, armR, 'upperArmR');
    // elbow: plugs the open ends of both tubes AND gives the joint the crumpled bulge a baggy sleeve has
    // smoother and rounder than before: at 22x16 with a 0.055 crease the joint silhouetted as a faceted
    // polygon every time the IK bent it past ~30 deg.
    const elbow = () => {
      const g = new THREE.SphereGeometry(1, 28, 20);
      deform(g, (v) => {
        const a = Math.atan2(v.z, v.x);
        const r = 1 + 0.026 * crease(a * 4.0 + v.y * 5.0, 0.6);
        v.x *= 0.080 * r; v.y *= 0.073 * r; v.z *= 0.081 * r;
      });
      return [g];
    };
    mesh([fore(), ...elbow()], M.hoodie, foreL, 'foreArmL');
    mesh([fore(), ...elbow()], M.hoodie, foreR, 'foreArmR');

    // RIBBED CUFF (critic note 4): it has to be a STEP in the silhouette, not a texture change. The
    // sleeve now necks down to ~0.026 at u=1 (0.40 gather) and the band immediately swells back out to
    // 0.056 — a 2.1x jump across 1 cm, which is a hard shoulder in profile from any angle. It is also
    // barrelled (fattest in the middle) and capped by a proud top ring, so the step survives being lit
    // flat: the ring's upper face turns away from the key and draws a dark line under the forearm.
    const cuff = () => {
      const parts = [];
      const band = new THREE.CylinderGeometry(0.046, 0.052, 0.070, 20, 5, true);
      deform(band, (v) => {
        const a = Math.atan2(v.z, v.x);
        const u = v.y / 0.070 + 0.5;
        const barrel = 1 + 0.16 * Math.sin(u * Math.PI);       // gathered knit bulges in the middle
        const f = barrel * (1 + 0.060 * crease(a * 9.0, 0.35)); // knit rib
        v.x *= f; v.z *= f;
      });
      parts.push(xf(band, 0, L_FORE - 0.030, 0));
      // the proud top ring: the actual silhouette step where the sleeve ends and the cuff begins
      parts.push(xf(new THREE.TorusGeometry(0.052, 0.0125, 8, 26), 0, L_FORE - 0.062, 0, Math.PI * 0.5));
      for (let i = 0; i < 3; i++) {
        parts.push(xf(new THREE.TorusGeometry(0.050 + i * 0.003, 0.0085, 6, 22), 0, L_FORE - 0.006 - i * 0.020, 0, Math.PI * 0.5));
      }
      return parts;
    };
    mesh(cuff(), M.hoodiePanel, foreL, 'cuffL');
    mesh(cuff(), M.hoodiePanel, foreR, 'cuffR');

    // the forearm/wrist that actually emerges from the cuff (the sleeve is hollow and open-ended)
    const wrist = () => [xf(new THREE.CylinderGeometry(0.031, 0.037, 0.070, 14, 2, false), 0, L_FORE + 0.004, 0)];
    mesh(wrist(), M.skin, foreL, 'wristL');
    mesh(wrist(), M.skin, foreR, 'wristR');
  }

  // ------------------------------------------------------------ HANDS
  // canonical frame: palm centre at origin, fingers along -Z, back of hand +Y
  // WHAT WAS WRONG: five equal parallel sausages on a flat slab, no thumb reading, no knuckle break, in
  // the most saturated colour in the frame. Fixed here by (a) narrowing the fingers so there are gaps
  // between them, (b) arching the MCP line in z and splaying the fingers so they are not parallel,
  // (c) real knuckle domes, (d) a thumb swung far enough out of the palm to silhouette, and
  // (e) the desaturated skin material above. In both desk references the hands are the QUIETEST thing.
  function handGeo(thumbX, curlBase, curlTip) {
    const parts = [];
    const sgn = thumbX > 0 ? -1 : 1;
    const palm = new RoundedBoxGeometry(0.082, 0.034, 0.098, 3, 0.016);
    deform(palm, (v) => {
      v.y *= 1 - 0.22 * smooth(0.0, -0.050, v.z);          // thins toward the knuckles
      v.x *= 1 - 0.20 * smooth(0.0, 0.049, v.z);           // narrows into the wrist
      v.y -= 0.005 * smooth(0.02, -0.05, v.z);             // knuckles roll over
      v.y *= 1 + 0.16 * smooth(-0.041, 0.041, v.x * thumbX); // thenar side is the fat side of a hand
    });
    parts.push(palm);
    const lens = [0.045, 0.050, 0.046, 0.036];             // index .. pinky, proximal
    const lens2 = [0.033, 0.037, 0.034, 0.026];
    const zoff = [-0.005, -0.008, -0.003, 0.005];          // MCP line is an ARCH, not a bar
    const splay = [-0.005, -0.001, 0.002, 0.007];          // fingers fan; parallel = sausages
    for (let i = 0; i < 4; i++) {
      const fx = (-0.0262 + i * 0.0180 + splay[i]) * sgn;
      const bz = -0.047 + zoff[i];
      const c1 = curlBase * (0.85 + i * 0.10);
      const l1 = lens[i], l2 = lens2[i];
      const r = 0.0096 - i * 0.0007;
      // knuckle dome — the break the critic asked for; without it the back of the hand is one plane
      const kn = new THREE.SphereGeometry(1, 10, 8);
      deform(kn, (v) => { v.x *= r * 1.05; v.y *= r * 0.95; v.z *= r * 1.20; });
      parts.push(xf(kn, fx, 0.004, bz));
      const p1 = new RoundedBoxGeometry(r * 1.92, r * 2.05, l1, 2, r * 0.90);
      xf(p1, 0, 0, -l1 * 0.5, 0, 0, 0);
      xf(p1, 0, 0, 0, -c1, 0, 0);
      xf(p1, fx, -0.002, bz - 0.003);
      parts.push(p1);
      // distal segment, hinged at the end of the proximal
      const ex = fx, ey = -0.002 + Math.sin(-c1) * -l1, ez = bz - 0.003 - Math.cos(c1) * l1;
      const p2 = new RoundedBoxGeometry(r * 1.78, r * 1.86, l2, 2, r * 0.85);
      xf(p2, 0, 0, -l2 * 0.5, 0, 0, 0);
      xf(p2, 0, 0, 0, -(c1 + curlTip), 0, 0);
      xf(p2, ex, ey, ez);
      parts.push(p2);
    }
    // thenar pad: the ball of the thumb. Also what stops the thumb looking glued on.
    const then = new THREE.SphereGeometry(1, 12, 10);
    deform(then, (v) => { v.x *= 0.021; v.y *= 0.017; v.z *= 0.036; });
    parts.push(xf(then, thumbX * 0.031, -0.001, -0.012));
    // thumb: two segments swung well out of the palm so it silhouettes against the desk
    const t1 = new RoundedBoxGeometry(0.023, 0.022, 0.042, 2, 0.010);
    xf(t1, 0, 0, -0.021);
    xf(t1, 0, 0, 0, -0.20, thumbX > 0 ? 0.80 : -0.80, 0);
    xf(t1, thumbX * 0.034, -0.001, -0.012);
    parts.push(t1);
    const t2 = new RoundedBoxGeometry(0.020, 0.019, 0.032, 2, 0.0088);
    xf(t2, 0, 0, -0.016);
    xf(t2, 0, 0, 0, -0.48, thumbX > 0 ? 0.52 : -0.52, 0);
    xf(t2, thumbX * 0.058, -0.008, -0.043);
    parts.push(t2);
    return parts;
  }
  mesh(handGeo(1, 0.72, 0.62), M.skin, handL, 'handL');   // left hand: thumb toward +X (midline), curled on keys
  mesh(handGeo(-1, 0.88, 0.82), M.skin, handR, 'handR');  // right hand: draped over the mouse

  // ------------------------------------------------------------ LEGS (mostly hidden by the desk)
  {
    const bone = (a, b, r1, r2, seg = 14) => {
      const d = _v.subVectors(b, a);
      const len = d.length();
      const g = new THREE.CylinderGeometry(r2, r1, len, seg, 2, true);
      g.translate(0, len * 0.5, 0);
      _q.setFromUnitVectors(UP, _v2.copy(d).divideScalar(len));
      g.applyQuaternion(_q);
      g.translate(a.x, a.y, a.z);
      return g;
    };
    const parts = [];
    // seat-of-the-pants mass
    const hips = new THREE.SphereGeometry(1, 20, 14);
    deform(hips, (v) => { v.x *= 0.175; v.y *= 0.105; v.z *= 0.155; });
    parts.push(xf(hips, 0, -0.012, 0.030));
    for (const s of [-1, 1]) {
      const hip = new THREE.Vector3(s * 0.095, 0.005, 0.000);
      const knee = new THREE.Vector3(s * 0.115, -0.035, -0.380);
      const ankle = new THREE.Vector3(s * 0.115, -0.390, -0.260);   // 45 mm shorter shin: PELVIS dropped 45 mm
      parts.push(bone(hip, knee, 0.090, 0.072));
      parts.push(bone(knee, ankle, 0.070, 0.050));
      const kn = new THREE.SphereGeometry(0.070, 12, 10);
      parts.push(xf(kn, knee.x, knee.y, knee.z, 0, 0, 0, 1, 1, 1));
    }
    mesh(parts, M.pants, legs, 'legs');

    const shoes = [];
    for (const s of [-1, 1]) {
      const f = new RoundedBoxGeometry(0.098, 0.072, 0.255, 3, 0.028);
      shoes.push(xf(f, s * 0.115, -0.420, -0.330, -0.10, s * 0.05, 0));
      const sole = new RoundedBoxGeometry(0.100, 0.024, 0.250, 2, 0.010);
      shoes.push(xf(sole, s * 0.115, -0.447, -0.330, -0.10, s * 0.05, 0));
    }
    mesh(shoes, M.shoe, legs, 'shoes');
  }

  // ------------------------------------------------------------ CHAIR
  //
  // A BLACK MESH/LEATHER GAMING CHAIR with a winged headrest — see desk-back-1.jpg / desk-back-2.jpg.
  // What it replaced was a brown quilted tufted Victorian wingback, a third of the frame wide, whose side
  // rolls physically stood between the hero camera and his torso. Three hard rules came out of that:
  //   WIDTH   nothing on this chair reaches past |x| = 0.25. At the backrest's depth the camera-to-torso
  //           ray passes x = 0.43, so 0.25 guarantees the chair can never occlude him again.
  //   HEIGHT  the headrest now tops out at y = 1.16 (was 1.22) against a crown at ~1.39 — 23 cm of clear
  //           air, so he still reads as sitting IN the chair rather than being swallowed by it.
  //   VALUE   see M.leather: still the darkest large mass in frame, but lifted off pure black and
  //           white-balanced, because at sRGB 2 against a wall at sRGB 5 the chair simply vanished.
  //   PLACE   CHAIR_Z pulls the whole chair 6 cm toward the monitor so the backrest sits behind his back
  //           instead of 40 cm behind it — nobody sits like that, and the gap is what pushed the chair
  //           down into the bottom-left corner of the hero frame where it read as an unlit lump.
  //           It still frames him from below-LEFT, not past his right shoulder, and that is geometry,
  //           not a choice: measured, the backrest top spans screen x 268..598 while his shoulders are at
  //           603..826, and putting chair geometry out at screen x > 830 needs x > 0.40 at the backrest's
  //           depth — which is the 0.43 occlusion line. Anything that reads "past his right shoulder"
  //           also stands in front of his torso. Left-and-below is the only place the chair can be.
  const CHAIR_PIVOT = new THREE.Vector3(0, 0.0, 0.30);
  const CHAIR_Z = -0.060;
  chair.position.copy(CHAIR_PIVOT);
  {
    const shift = (list) => list.map((g) => g.translate(-CHAIR_PIVOT.x, -CHAIR_PIVOT.y, -CHAIR_PIVOT.z + CHAIR_Z));

    // --- textured upholstery: seat pan, backrest face, headrest
    const lea = [];
    // seat pan (top at y = 0.505 — he sits high enough to clear the desk properly)
    const pan = new RoundedBoxGeometry(0.46, 0.085, 0.46, 3, 0.040);
    deform(pan, (v) => { v.y -= 0.016 * smooth(0.17, 0.0, Math.abs(v.x)) * smooth(0.19, 0.0, Math.abs(v.z)) * (v.y > 0 ? 1 : 0); });
    lea.push(xf(pan, 0, 0.4275, 0.28));   // seat pan TOP = 0.470
    // backrest: a tall narrow shell leaning back 12 deg, with the stitched channels of a gaming seat
    const back = new RoundedBoxGeometry(0.360, 0.62, 0.090, 3, 0.042);
    deform(back, (v) => {
      const front = v.z < 0 ? 1 : 0;
      v.z -= 0.018 * smooth(0.17, 0.0, Math.abs(v.x)) * front;                    // dished for a spine
      v.z -= 0.007 * Math.pow(Math.abs(Math.sin(v.y * 26.0)), 0.6) * front;       // horizontal channels
      v.z += 0.020 * Math.exp(-Math.pow((v.y + 0.16) / 0.10, 2)) * front;         // lumbar bulge
    });
    lea.push(xf(back, 0, 0.787, 0.545, 0.21));
    // winged headrest pillow
    const hr = new RoundedBoxGeometry(0.235, 0.105, 0.080, 3, 0.036);
    deform(hr, (v) => { v.z -= 0.012 * smooth(0.10, 0.0, Math.abs(v.x)) * (v.z < 0 ? 1 : 0); });
    lea.push(xf(hr, 0, 1.110, 0.628, 0.30));   // headrest TOP = 1.160
    mesh(shift(lea), M.leather, chair, 'chairLeather');

    // --- moulded black shell: back frame, side wings, armrest pads, headrest wings
    const plain = [];
    // the shell the backrest cushion sits in — this is the piece the camera sees from behind
    const shell = new RoundedBoxGeometry(0.395, 0.655, 0.055, 3, 0.045);
    deform(shell, (v) => { v.z += 0.014 * smooth(0.14, 0.0, Math.abs(v.x)) * (v.z > 0 ? 1 : 0); });
    plain.push(xf(shell, 0, 0.787, 0.588, 0.21));
    for (const s of [-1, 1]) {
      // narrow side wings: they read as a gaming seat without ever reaching |x| = 0.25
      const w = new RoundedBoxGeometry(0.055, 0.400, 0.105, 3, 0.030);
      plain.push(xf(w, s * 0.180, 0.702, 0.518, 0.21, 0, -s * 0.13));
      // seat bolsters, likewise slim
      const b = new RoundedBoxGeometry(0.052, 0.080, 0.420, 3, 0.028);
      plain.push(xf(b, s * 0.214, 0.445, 0.283, 0, 0, -s * 0.16));
      // headrest wings
      const hw = new RoundedBoxGeometry(0.040, 0.090, 0.070, 2, 0.026);
      plain.push(xf(hw, s * 0.126, 1.102, 0.612, 0.30, 0, -s * 0.16));
      // armrest pad: low and well behind his forearm
      const pad = new RoundedBoxGeometry(0.072, 0.026, 0.200, 3, 0.012);
      plain.push(xf(pad, s * 0.262, 0.653, 0.245));
    }
    mesh(shift(plain), M.leatherPlain, chair, 'chairPlain');

    // --- EDGE TRIM. The camera looks at the BACK of the backrest, so this is the chair's whole read in
    // the hero frame: a plate 17 mm proud of the shell on every side, in a half-metallic grey. The warm
    // point light at (1.55,1.80,0.50) is 1.3 m away and rakes across it, so its rim draws a thin bright
    // outline around an otherwise black shell — "slim black backrest edge" (critic note 5), plus a
    // matching bar under the headrest. Two boxes, one draw call, |x| <= 0.215 so it still cannot occlude.
    const trim = [];
    trim.push(xf(new RoundedBoxGeometry(0.430, 0.690, 0.028, 3, 0.030), 0, 0.787, 0.618, 0.21));
    trim.push(xf(new RoundedBoxGeometry(0.262, 0.104, 0.026, 3, 0.024), 0, 1.110, 0.660, 0.30));
    mesh(shift(trim), M.trim, chair, 'chairTrim');

    // --- metal (gas cylinder, base spokes, armrest posts, headrest post)
    const met = [];
    met.push(xf(new THREE.CylinderGeometry(0.034, 0.028, 0.290, 18), 0, 0.235, 0.30));
    met.push(xf(new THREE.CylinderGeometry(0.044, 0.044, 0.050, 18), 0, 0.360, 0.30));
    met.push(xf(new THREE.CylinderGeometry(0.058, 0.066, 0.052, 20), 0, 0.100, 0.30));
    met.push(xf(new RoundedBoxGeometry(0.18, 0.028, 0.19, 2, 0.010), 0, 0.371, 0.295));
    // recline bracket: the seat pan and the back shell have to be joined by something
    met.push(xf(new RoundedBoxGeometry(0.085, 0.150, 0.060, 2, 0.018), 0, 0.465, 0.520, 0.21));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.35;
      const spoke = new RoundedBoxGeometry(0.050, 0.036, 0.285, 2, 0.016);
      deform(spoke, (v) => { v.x *= 1 - 0.45 * smooth(0.0, -0.14, v.z); v.y *= 1 - 0.35 * smooth(0.0, -0.14, v.z); });
      met.push(xf(spoke, 0, 0, -0.155, 0, 0, 0));
      met[met.length - 1].rotateY(a);
      met[met.length - 1].translate(0, 0.078, 0.30);
    }
    for (const s of [-1, 1]) {
      const post = new RoundedBoxGeometry(0.026, 0.200, 0.046, 2, 0.010);
      met.push(xf(post, s * 0.252, 0.550, 0.290, 0, 0, s * 0.05));
    }
    mesh(shift(met), M.metal, chair, 'chairMetal');

    // --- castors
    const cas = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.35;
      const wx = Math.sin(a) * 0.290, wz = Math.cos(a) * 0.290;
      const w = new THREE.CylinderGeometry(0.032, 0.032, 0.020, 14);
      cas.push(xf(w, wx, 0.032, 0.30 + wz, 0, 0, Math.PI * 0.5));
      const fork = new THREE.CylinderGeometry(0.011, 0.011, 0.040, 8);
      cas.push(xf(fork, wx, 0.058, 0.30 + wz));
    }
    mesh(shift(cas), M.rubber, chair, 'chairCastors');
  }

  // ------------------------------------------------------------ pose state
  const state = {
    t: 0,
    k: 0,
    handL: HAND_L_REST.clone(),
    handR: HAND_R_REST.clone(),
    mouseNudge: 0,
    mouseNudgeV: 0,
    nextNudge: 2.5 + R() * 3,
  };
  const phase = R() * 10;
  const restLegRotX = legs.rotation.x;

  // two-bone IK: writes the arm root + forearm transforms so the wrist lands on `wrist`
  function solveArm(root, foreGrp, shoulder, wrist, poleX) {
    root.position.copy(shoulder);
    _v.subVectors(wrist, shoulder);
    let d = _v.length();
    const maxD = (L_UPPER + L_FORE) * 0.995;
    if (d > maxD) { _v.multiplyScalar(maxD / d); d = maxD; }
    if (d < 1e-4) { _v.set(0, -1e-4, 0); d = 1e-4; }
    _wr.copy(shoulder).add(_v);
    _dir.copy(_v).divideScalar(d);
    const a = (L_UPPER * L_UPPER - L_FORE * L_FORE + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L_UPPER * L_UPPER - a * a));
    // pole vector: elbow swings out and down, away from the ribs
    _perp.set(poleX, -1, 0.15).normalize();
    _perp.addScaledVector(_dir, -_perp.dot(_dir));
    if (_perp.lengthSq() < 1e-6) _perp.set(poleX, 0, 0);
    _perp.normalize();
    _el.copy(shoulder).addScaledVector(_dir, a).addScaledVector(_perp, h);

    _v.subVectors(_el, shoulder).normalize();
    root.quaternion.setFromUnitVectors(UP, _v);
    _v2.subVectors(_wr, _el).normalize();
    _q.setFromUnitVectors(UP, _v2);
    foreGrp.quaternion.copy(root.quaternion).invert().multiply(_q);
  }

  // Single source of truth for the pose. rest -> idle(t) -> suck(k), rebuilt from scratch.
  function apply() {
    const t = state.t, k = Math.min(1, Math.max(0, state.k));
    const kA = smooth(0.0, 0.25, k);   // startle
    const kB = smooth(0.22, 0.62, k);  // pulled forward
    const kC = smooth(0.55, 1.0, k);   // full flight

    // ---- breathing
    const breath = Math.sin(t * 0.22 * Math.PI * 2 + phase);
    const bAmt = 1 - 0.85 * kB;
    // STATURE rides on the breathing scale: it is the seated-height knob (see the rig constants). Doing
    // it here rather than in 30 hand-tuned local coordinates keeps the hood/head/headphones/arms in
    // proportion for free, and because it is a factor (not an offset) setSuck(0) is still exact identity.
    torso.scale.set(
      STATURE * (1 + 0.004 * breath * bAmt),
      STATURE * (1 + 0.013 * breath * bAmt),
      STATURE * (1 + 0.011 * breath * bAmt),
    );

    // ---- torso: lean + tense + pull
    const sway = Math.sin(t * 0.13 + phase) * 0.010 + Math.sin(t * 0.31 + phase * 2) * 0.005;
    torso.rotation.x = LEAN + sway * (1 - kA) - 0.10 * kA - 0.42 * kB - 0.52 * kC;
    torso.rotation.z = Math.sin(t * 0.17 + phase) * 0.008 * (1 - kA);
    torso.rotation.y = Math.sin(t * 0.09 + phase * 3) * 0.012 * (1 - kA);
    torso.position.set(PELVIS.x, PELVIS.y + 0.030 * kA + 0.055 * kB, PELVIS.z - 0.02 * kB);

    // ---- he lifts off the seat and pitches into the screen (on `rig`, never on `body`)
    rig.position.set(0, 0.055 * kB + 0.075 * kC, -0.05 * kB - 0.10 * kC);
    rig.rotation.x = -0.10 * kB - 0.30 * kC;

    // ---- SUCK LEGIBILITY. The stage stretches the whole body along the travel axis (stage.setSuck does
    // pivot.scale.z = 1 + 4.2*e, and that axis is world -Z, which is rig-local Z to within the small pitch
    // set just above). Unopposed he is a featureless pale cone by k~0.4. Un-stretching 65% of it HERE —
    // one scale, on our own inner group, never on `body` — keeps the head, hood, hair and arms reading as
    // themselves past k=0.6 while the remaining ~1.5x smear still sells the speed. `e` mirrors stage.js's
    // easing: if that changes, change this with it. e(0) = 0, so setSuck(0) is exactly identity.
    const e = k * k * (1.9 - 0.9 * k);
    rig.scale.set(1, 1, 1 / (1 + 0.65 * 4.2 * e));

    // ---- head: micro drift, then a hard snap up toward the screen
    const hx = Math.sin(t * 0.37 + phase) * 0.012 + Math.sin(t * 0.11 + phase * 1.7) * 0.010;
    const hy = Math.sin(t * 0.29 + phase * 2.3) * 0.020 + Math.sin(t * 0.07) * 0.012;
    const hz = Math.sin(t * 0.19 + phase * 0.7) * 0.014;
    // the counter-rotation has to grow with the torso pitch, or a body diving flat at the screen
    // ends up face-down at the desk instead of looking into it
    headPivot.rotation.x = 0.13 + hx * (1 - kA) - 0.34 * kA + 0.55 * kB + 0.85 * kC;
    headPivot.rotation.y = hy * (1 - kA);
    headPivot.rotation.z = hz * (1 - kA) + 0.05 * kA;

    // ---- hair drags backward
    hairDyn.rotation.x = 0.05 * kA + 0.55 * kB + 0.42 * kC + Math.sin(t * 0.4 + phase) * 0.006;
    // NB: no z-stretch on the hair. It used to grow to 1.8x, which stacked on top of the stage's travel
    // stretch and was the first thing to dissolve the head into a cone. The sweep is rotation only.
    hairDyn.scale.set(1, 1 + 0.08 * kC, 1 + 0.10 * kC);

    // ---- drawstrings + cable trail
    stringMesh.rotation.x = -0.06 * kA + 0.26 * kB + 0.16 * kC + Math.sin(t * 0.45 + phase) * 0.010;
    cableGrp.rotation.x = Math.sin(t * 0.33 + phase * 1.3) * 0.012 + 0.30 * kB + 0.34 * kC;
    cableGrp.rotation.z = Math.sin(t * 0.21 + phase) * 0.010;

    // ---- legs trail
    legs.rotation.x = restLegRotX + 0.10 * kB + 0.62 * kC;
    legs.position.z = 0.09 + 0.03 * kC;

    // ---- chair rolls back and tips
    chair.position.set(CHAIR_PIVOT.x, CHAIR_PIVOT.y, CHAIR_PIVOT.z + 0.10 * kB + 0.09 * kC);
    chair.rotation.x = 0.055 * kB + 0.055 * kC;
    chair.rotation.y = 0.03 * kB;

    // ---- hand targets: idle micro motion, then the reach
    // mouse: rare, damped nudge
    if (t > state.nextNudge) {
      state.mouseNudgeV += (R() - 0.5) * 0.9;
      state.nextNudge = t + 2.0 + R() * 4.0;
    }
    state.mouseNudgeV *= 0.90;
    state.mouseNudge = state.mouseNudge * 0.90 + state.mouseNudgeV * 0.012;
    const tap = Math.max(0, Math.sin(t * 2.7 + phase)) * Math.max(0, Math.sin(t * 0.41 + phase * 2));

    state.handL.set(
      HAND_L_REST.x + Math.sin(t * 0.23 + phase) * 0.002,
      HAND_L_REST.y + tap * 0.004,
      HAND_L_REST.z + Math.sin(t * 0.31 + phase) * 0.002,
    );
    state.handR.set(
      HAND_R_REST.x + state.mouseNudge * 0.6,
      HAND_R_REST.y + Math.sin(t * 0.27 + phase * 1.9) * 0.0015,
      HAND_R_REST.z + state.mouseNudge,
    );
    // startle lift, then the reach into the screen
    const lift = 0.045 * kA;
    state.handL.y += lift; state.handR.y += lift;
    state.handL.lerp(HAND_L_REACH, kB * 0.75).lerp(HAND_L_REACH, kC);
    state.handR.lerp(HAND_R_REACH, kB * 0.75).lerp(HAND_R_REACH, kC);

    // ---- hands: flat on the desk, then palms forward as he is pulled in
    handL.position.copy(state.handL);
    handR.position.copy(state.handR);
    handL.rotation.set(-0.10 + tap * 0.05 - 1.05 * kB - 0.35 * kC, -0.10, -0.06 + 0.10 * kB);
    handR.rotation.set(-0.14 - 1.05 * kB - 0.35 * kC, 0.16, 0.07 - 0.12 * kB);

    // ---- arms: IK from the (breathing, leaning) shoulders to the wrists
    torso.updateMatrix();
    _sh.copy(SHOULDER_L).applyMatrix4(torso.matrix);
    _v2.copy(state.handL).add(WRIST_BACK);
    solveArm(armL, foreL, _sh, _v2, -0.75);
    _sh.copy(SHOULDER_R).applyMatrix4(torso.matrix);
    _v2.copy(state.handR).add(WRIST_BACK);
    solveArm(armR, foreR, _sh, _v2, 0.75);
  }

  apply();

  let tris = 0;
  group.traverse((o) => { if (o.isMesh) tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3; });
  let draws = 0;
  group.traverse((o) => { if (o.isMesh) draws++; });
  const buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - tStart;
  if (typeof console !== 'undefined') {
    console.info(`[intro/character] built in ${buildMs.toFixed(1)} ms — ${tris | 0} tris, ${draws} draw calls, ${materials.length} materials`);
  }

  return {
    group,
    body,
    chair,
    materials,
    stats: { tris: tris | 0, draws, buildMs, materials: materials.length },
    update(t) { state.t = t || 0; apply(); },
    setSuck(k) { state.k = k || 0; apply(); },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      group.clear();
    },
  };
}
