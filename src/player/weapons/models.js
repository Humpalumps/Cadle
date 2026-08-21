import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { noise2, mulberry32 } from '../../core/Noise.js';
import { ELEMENT_COLORS } from './defs.js';
import { gripHand, wrapHand, looseHand } from './hands.js';

/**
 * Procedural gun models for the first-person viewmodel. Gun space: +Y up, +X right (player's right), forward = -Z.
 * Origin = top of the pistol grip (where the hand is). Each builder returns { group, parts:{...moving Object3Ds}, muzzle, sight, coreMat? }.
 * Static geometry is merged per material (4-6 draw calls per gun); moving parts (mag/bolt/cylinder/pump/cell/hammer) are own Groups.
 * Look: dark gunmetal + brass/gold FF14 filigree + element glow accents + emissive sights (bloom picks these up in PostFX).
 */
const PI = Math.PI;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

// ---------- procedural textures (canvas) ----------
function canvasTex(w, h, draw, { srgb = false, repeat = [1, 1] } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; return t;
}
// Height -> tangent-space normal (Sobel). One extra 256^2 texture for the whole gun set; `normalMap` costs ONE
// fetch where `bumpMap` costs three, so switching the metals over is cheaper AND sharper than what it replaces.
function normalFromCanvas(src, strength = 2.4, repeat = [3, 3]) {
  const w = src.width, h = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
  const L = (x, y) => sd[((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (L(x + 1, y) - L(x - 1, y)) * strength, dy = (L(x, y + 1) - L(x, y - 1)) * strength;
    const len = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
    d[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
    d[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
    d[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255); d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); t.anisotropy = 8;
  return t;                                                    // linear (no colorSpace): normal maps must not be sRGB-decoded
}

function makeTextures() {
  const rnd = mulberry32(777);
  // metal: low-freq tonal variation + fine scratches (used as colour map, dark tint applied via material.color)
  const metal = canvasTex(256, 256, (ctx, w, h) => {
    const img = ctx.createImageData(w, h); const d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = 0.86 + 0.10 * noise2(x / 37, y / 37, 3) + 0.05 * noise2(x / 9, y / 9, 5);
      const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = Math.round(255 * Math.min(1, n)); d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
    for (let i = 0; i < 70; i++) { const x = rnd() * w, y = rnd() * h, a = rnd() * PI, l = 6 + rnd() * 30; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke(); }
  }, { srgb: true, repeat: [3, 3] });
  // roughness (green channel): brushed noise + scratches rougher
  const rough = canvasTex(256, 256, (ctx, w, h) => {
    const img = ctx.createImageData(w, h); const d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = 0.5 + 0.18 * noise2(x / 23, y / 5, 11) + 0.1 * noise2(x / 60, y / 60, 13);
      const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = Math.round(255 * Math.max(0.15, Math.min(1, n))); d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    for (let i = 0; i < 50; i++) { const x = rnd() * w, y = rnd() * h, a = rnd() * PI, l = 6 + rnd() * 30; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke(); }
  }, { repeat: [3, 3] });
  // grip: diagonal leather wrap as bump
  const wrap = canvasTex(128, 128, (ctx, w, h) => {
    const img = ctx.createImageData(w, h); const d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = 0.5 + 0.5 * Math.sin((x + y) / 128 * PI * 2 * 6);
      const n = 0.6 * s * s + 0.1 * noise2(x / 6, y / 6, 21) + 0.3;
      const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = Math.round(255 * Math.max(0, Math.min(1, n))); d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, { repeat: [2, 4] });
  // filigree: gold ornament decals (alphaTest), 3 distinct layouts so guns don't share the same sticker. FF14-ish.
  const filigreeVariant = (v) => {
    const t = canvasTex(512, 256, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = ctx.fillStyle = 'rgba(255,214,130,1)';
      const curl = (cx, cy, r0, turns, dir, lw = 4) => {
        ctx.lineWidth = lw; ctx.beginPath();
        const n = 60; for (let i = 0; i <= n; i++) { const tt = i / n; const r = r0 * (1 - 0.85 * tt); const a = dir * tt * turns * PI * 2; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
      };
      if (v === 0) { // symmetric curls + central diamond
        for (const sx of [1, -1]) {
          const X = (x) => w / 2 + sx * x;
          ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(X(0), h * 0.5); ctx.bezierCurveTo(X(w * 0.12), h * 0.15, X(w * 0.30), h * 0.85, X(w * 0.46), h * 0.5); ctx.stroke();
          curl(X(w * 0.10), h * 0.28, 28, 1.3, sx, 5); curl(X(w * 0.26), h * 0.72, 30, 1.4, -sx, 5);
          curl(X(w * 0.40), h * 0.30, 22, 1.2, sx, 5); curl(X(w * 0.18), h * 0.5, 14, 1.0, -sx, 4);
          ctx.beginPath(); ctx.arc(X(w * 0.45), h * 0.5, 6, 0, PI * 2); ctx.fill();
        }
        ctx.beginPath(); ctx.moveTo(w / 2, h * 0.3); ctx.lineTo(w / 2 + 18, h * 0.5); ctx.lineTo(w / 2, h * 0.7); ctx.lineTo(w / 2 - 18, h * 0.5); ctx.closePath(); ctx.fill();
        ctx.lineWidth = 3.5; ctx.strokeRect(8, 8, w - 16, h - 16);
      } else if (v === 1) { // laurel vine scroll
        ctx.lineWidth = 5; ctx.beginPath();
        for (let x = 24; x < w - 24; x += 6) { const y = h * 0.5 + Math.sin(x / 40) * h * 0.17; x === 24 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke();
        for (let i = 0; i < 6; i++) { const x = 60 + i * (w - 120) / 5; curl(x, h * 0.5 + (i % 2 ? -h * 0.20 : h * 0.20), 22, 1.3, i % 2 ? -1 : 1, 4); }
        for (let i = 0; i < 7; i++) { const x = 40 + i * (w - 80) / 6; ctx.beginPath(); ctx.arc(x, h * 0.5 + (i % 2 ? h * 0.32 : -h * 0.32), 4.5, 0, PI * 2); ctx.fill(); }
        ctx.lineWidth = 2.5; ctx.strokeRect(6, 6, w - 12, h - 12); ctx.strokeRect(14, 14, w - 28, h - 28);
      } else { // geometric diamond chain + corner brackets
        ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(w * 0.05, h * 0.5); ctx.lineTo(w * 0.95, h * 0.5); ctx.stroke();
        for (let i = 0; i < 5; i++) {
          const x = w * 0.15 + i * w * 0.175, s = i === 2 ? 26 : 15;
          ctx.beginPath(); ctx.moveTo(x, h * 0.5 - s); ctx.lineTo(x + s, h * 0.5); ctx.lineTo(x, h * 0.5 + s); ctx.lineTo(x - s, h * 0.5); ctx.closePath(); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, h * 0.5, 4.5, 0, PI * 2); ctx.fill();
        }
        ctx.lineWidth = 5;
        for (const [cx, cy] of [[12, 12], [w - 12, 12], [12, h - 12], [w - 12, h - 12]]) {
          ctx.beginPath(); ctx.moveTo(cx, cy + (cy < h / 2 ? 30 : -30)); ctx.lineTo(cx, cy); ctx.lineTo(cx + (cx < w / 2 ? 30 : -30), cy); ctx.stroke();
        }
      }
    }, { srgb: true });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
  };
  const filigrees = [filigreeVariant(0), filigreeVariant(1), filigreeVariant(2)];
  // muzzle flash petal (bright at left/muzzle, fades to the right) + star disc
  const petal = canvasTex(128, 64, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, h * 0.35); ctx.lineTo(w * 0.15, 0); ctx.lineTo(w, h * 0.5); ctx.lineTo(w * 0.15, h); ctx.lineTo(0, h * 0.65); ctx.closePath(); ctx.fill();
  });
  petal.wrapS = petal.wrapT = THREE.ClampToEdgeWrapping;
  const star = canvasTex(128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h); const cx = w / 2, cy = h / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.5); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,255,255,0.8)'); g.addColorStop(0.45, 'rgba(255,255,255,0.15)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 6; i++) { const a = i * PI / 3; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a + 1.57) * 3, cy + Math.sin(a + 1.57) * 3); ctx.lineTo(cx + Math.cos(a) * w * 0.5, cy + Math.sin(a) * h * 0.5); ctx.lineTo(cx - Math.cos(a + 1.57) * 3, cy - Math.sin(a + 1.57) * 3); ctx.closePath(); ctx.fill(); }
  });
  star.wrapS = star.wrapT = THREE.ClampToEdgeWrapping;
  // machined-steel height: broad forged undulation + fine broach lines + scattered pits/nicks. Drives the normal map
  // that stops the receiver reading as a smooth plastic slab (it had no map at all).
  const height = canvasTex(256, 256, (ctx, w, h) => {
    const img = ctx.createImageData(w, h), d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let n = 0.5 + 0.20 * noise2(x / 42, y / 42, 31) + 0.10 * noise2(x / 11, y / 11, 37);
      n += 0.055 * Math.sin(y * 1.15) * (0.5 + 0.5 * noise2(x / 60, y / 60, 41));   // broach lines across the blank
      const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = Math.round(255 * Math.max(0, Math.min(1, n))); d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1;                        // scratches cut IN
    for (let i = 0; i < 90; i++) { const x = rnd() * w, y = rnd() * h, a = rnd() * PI, l = 5 + rnd() * 34; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke(); }
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 0; i < 60; i++) { ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, 0.7 + rnd() * 1.9, 0, PI * 2); ctx.fill(); }
  });
  const normal = normalFromCanvas(height.image, 2.6, [6, 6]);   // fine tiling: machining marks, not camo blotches
  const wrapNormal = normalFromCanvas(wrap.image, 3.2, [2, 4]);                     // leather wrap relief for the grip
  return { metal, rough, wrap, filigrees, petal, star, normal, wrapNormal };
}

export function makeMaterials() {
  const T = makeTextures();
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const mats = {
    metal: std({ color: 0x2e333c, map: T.metal, roughnessMap: T.rough, roughness: 0.95, metalness: 0.9, envMapIntensity: 0.8, normalMap: T.normal, normalScale: new THREE.Vector2(0.85, 0.85) }),
    metal2: std({ color: 0x6e7480, map: T.metal, roughnessMap: T.rough, roughness: 0.78, metalness: 0.85, envMapIntensity: 0.85, normalMap: T.normal, normalScale: new THREE.Vector2(0.7, 0.7) }),
    // the receiver/frame slab: was a flat untextured black box in every frame — now forged steel with broach lines
    dark: std({ color: 0x0c0c10, roughnessMap: T.rough, roughness: 0.7, metalness: 0.3, normalMap: T.normal, normalScale: new THREE.Vector2(0.9, 0.9) }),   // no albedo map: the frame stays deep gunmetal, the normal alone supplies the relief
    gold: std({ color: 0xd8a94b, roughness: 0.38, metalness: 1.0, envMapIntensity: 1.0, emissive: 0x2a1a05, emissiveIntensity: 0.35, normalMap: T.normal, normalScale: new THREE.Vector2(0.3, 0.3) }),   // user decree: viewmodel metals must not throw white sun glints over the meadow (blobcheck-gated) — normalScale kept low so cast gold breaks up without adding new specular hot spots
    brass: std({ color: 0xffca6a, roughness: 0.35, metalness: 1.0, envMapIntensity: 1.1, emissive: 0x7a4a10, emissiveIntensity: 0.6, normalMap: T.normal, normalScale: new THREE.Vector2(0.25, 0.25) }),
    grip: std({ color: 0x2e211a, roughness: 0.85, metalness: 0.0, normalMap: T.wrapNormal, normalScale: new THREE.Vector2(1.1, 1.1) }),
    ivory: std({ color: 0xe8dcc3, roughness: 0.45, metalness: 0.05, normalMap: T.normal, normalScale: new THREE.Vector2(0.45, 0.45) }),
    white: std({ color: 0xfff4da, emissive: 0xfff4da, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0 }),   // sights stay lit-white but under the day bloom threshold (1.05): 2.2 bloomed into permanent white balls over the grass
    glass: std({ color: 0x9fd0ff, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.28, depthWrite: false, emissive: 0x4080c0, emissiveIntensity: 0.25, side: THREE.DoubleSide }),
    glow: {}, flash: {}, tex: T,
  };
  for (let i = 0; i < 3; i++) mats['filigree' + i] = std({ color: 0xe0b24f, map: T.filigrees[i], alphaTest: 0.5, roughness: 0.28, metalness: 1.0, envMapIntensity: 1.2, emissive: 0x3a2606, emissiveIntensity: 0.5, side: THREE.DoubleSide });
  mats.filigree = mats.filigree0; // back-compat alias
  for (const [el, hex] of Object.entries(ELEMENT_COLORS)) {
    mats.glow[el] = std({ color: hex, emissive: hex, emissiveIntensity: 2.4, roughness: 0.35, metalness: 0 });
    mats.flash[el] = { petal: new THREE.MeshBasicMaterial({ color: hex, map: T.petal, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
                       star: new THREE.MeshBasicMaterial({ color: hex, map: T.star, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }) };
  }
  mats.flashCore = new THREE.MeshBasicMaterial({ color: 0xffffff, map: T.star, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const el of Object.keys(ELEMENT_COLORS)) { mats.flash[el].petal.opacity = 0.95; mats.flash[el].star.opacity = 0.75; }
  mats.all = [mats.metal, mats.metal2, mats.dark, mats.gold, mats.brass, mats.grip, mats.ivory, mats.white, mats.filigree0, mats.filigree1, mats.filigree2, mats.glass, ...Object.values(mats.glow)];
  return mats;
}

// ---------- geometry helpers (all centered at origin unless stated) ----------
const box = (w, h, d, r = 0.003) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.49));
const pbox = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cylZ = (rFront, rBack, len, seg = 16) => new THREE.CylinderGeometry(rFront, rBack, len, seg).rotateX(-PI / 2);   // along Z, front = -Z
const cylY = (rTop, rBot, h, seg = 16) => new THREE.CylinderGeometry(rTop, rBot, h, seg);
const cylX = (r, len, seg = 10) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(PI / 2);
const sphere = (r, seg = 10) => new THREE.SphereGeometry(r, seg, seg);
const torusZ = (R, tube, tseg = 8, rseg = 24, arc = PI * 2) => new THREE.TorusGeometry(R, tube, tseg, rseg, arc);       // ring around Z (barrel axis)
const torusX = (R, tube, tseg = 8, rseg = 24, arc = PI * 2) => new THREE.TorusGeometry(R, tube, tseg, rseg, arc).rotateY(PI / 2); // ring in the YZ plane (trigger guard)
// lathe along Z: pts = [[radius, forward]] forward>0 = toward muzzle; front = -Z
const latheZ = (pts, seg = 16) => new THREE.LatheGeometry(pts.map(([r, f]) => new THREE.Vector2(r, f)), seg).rotateX(-PI / 2);
// side profile extrusion: pts = [[u forward, v up]], extruded across X (width), beveled edges
function profile(pts, width, bevel = 0.004, curveSegments = 4) {
  const sh = new THREE.Shape(); pts.forEach(([u, v], i) => i ? sh.lineTo(u, v) : sh.moveTo(u, v)); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.001, width - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelSegments: 2, curveSegments });
  g.rotateY(PI / 2); g.translate(-(width - 2 * bevel) / 2, 0, 0); return g;
}
// decal plane facing +X (side=1) or -X (side=-1)
const decal = (w, h, side) => new THREE.PlaneGeometry(w, h).rotateY(side > 0 ? PI / 2 : -PI / 2);

class Builder {
  constructor(mats, element) { this.mats = mats; this.el = element; this.buckets = new Map(); this.pivots = new Map(); this.group = new THREE.Group(); this.parts = {}; this.coreMat = null; }
  mat(key) {
    if (key === 'glow') return this.mats.glow[this.el];
    if (key === 'core') { if (!this.coreMat) { this.coreMat = this.mats.glow[this.el].clone(); } return this.coreMat; }
    return this.mats[key];
  }
  part(name, pivot, rot = [0, 0, 0]) { this.pivots.set(name, { p: new THREE.Vector3(...pivot), r: rot }); return this; }
  // add geometry at gun-space position p, rotation r (XYZ euler), scale s; optional moving part
  add(g, key, { p = [0, 0, 0], r = [0, 0, 0], s = 1, part = null } = {}) {
    _e.set(r[0], r[1], r[2]); _q.setFromEuler(_e);
    _v.set(p[0], p[1], p[2]); if (part) _v.sub(this.pivots.get(part).p);
    _s.set(...(Array.isArray(s) ? s : [s, s, s]));
    _m.compose(_v, _q, _s); g.applyMatrix4(_m);
    if (g.index) g = g.toNonIndexed();
    const k = (part ? part + '|' : '') + key;
    (this.buckets.get(k) ?? this.buckets.set(k, []).get(k)).push(g);
    return this;
  }
  marker(name, p) { const o = new THREE.Object3D(); o.position.set(...p); this.group.add(o); this[name] = o; return o; }
  build() {
    for (const [name, pv] of this.pivots) {
      const g = new THREE.Group(); g.position.copy(pv.p); g.rotation.set(pv.r[0], pv.r[1], pv.r[2]);
      g.userData.basePos = pv.p.clone(); g.userData.baseRot = new THREE.Euler(pv.r[0], pv.r[1], pv.r[2]);
      this.group.add(g); this.parts[name] = g;
    }
    for (const [k, list] of this.buckets) {
      const [part, key] = k.includes('|') ? k.split('|') : [null, k];
      const geo = mergeGeometries(list, false); list.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(geo, this.mat(key)); mesh.frustumCulled = false;
      if (key === 'glass') mesh.renderOrder = 2;
      (part ? this.parts[part] : this.group).add(mesh);
    }
    return { group: this.group, parts: this.parts, muzzle: this.muzzle, sight: this.sight, coreMat: this.coreMat, pivots: this.pivots };
  }
}

// shared sub-assemblies
function pistolGrip(b, { p = [0, -0.045, 0.02], h = 0.085, w = 0.03, d = 0.036, tilt = -0.35, cap = true } = {}) {
  b.add(box(w, h, d, 0.008), 'grip', { p, r: [tilt, 0, 0] });
  if (cap) b.add(box(w + 0.003, 0.008, d + 0.003, 0.002), 'gold', { p: [p[0], p[1] - Math.cos(tilt) * h / 2, p[2] - Math.sin(tilt) * h / 2], r: [tilt, 0, 0] });
  // metal backstrap spine
  b.add(pbox(w * 0.6, h * 0.9, 0.004), 'metal', { p: [p[0], p[1] - Math.sin(tilt) * d / 2, p[2] + Math.cos(tilt) * d / 2], r: [tilt, 0, 0] });
}
function triggerGuard(b, p, r = 0.017) {
  b.add(torusX(r, 0.0028, 6, 18), 'metal', { p });
  b.add(box(0.005, 0.016, 0.004, 0.001), 'metal2', { p: [p[0], p[1] - 0.002, p[2] + 0.002], r: [0.25, 0, 0] }); // trigger
}
function filigreeSides(b, p, w, h, { x = 0.025, left = true, right = true, v = 0 } = {}) {
  if (right) b.add(decal(w, h, 1), 'filigree' + v, { p: [p[0] + x + 0.0007, p[1], p[2]] });
  if (left) b.add(decal(w, h, -1), 'filigree' + v, { p: [p[0] - x - 0.0007, p[1], p[2]] });
}
function railNotches(b, y, z0, z1, w = 0.022, step = 0.014) {
  for (let z = z0; z > z1; z -= step) b.add(pbox(w, 0.0035, 0.006), 'metal2', { p: [0, y, z] });
}
// visible screw heads at panel corners (both sides), tiny gold cylinders along X
function screws(b, list) {
  for (const [x, y, z] of list) { b.add(cylX(0.0024, 0.004, 6), 'gold', { p: [x, y, z] }); b.add(cylX(0.0024, 0.004, 6), 'gold', { p: [-x, y, z] }); }
}

// ---------- guns ----------
function handcannon(b) {
  // frame: tall rear block, MASSIVE top strap, deep front block — Destiny hand cannons are chunky, cylinder-dominant
  b.add(box(0.046, 0.062, 0.058, 0.006), 'metal', { p: [0, 0.014, -0.010] });
  b.add(box(0.034, 0.016, 0.088, 0.004), 'metal', { p: [0, 0.048, -0.058] });
  b.add(box(0.046, 0.058, 0.030, 0.006), 'metal', { p: [0, 0.012, -0.105] });
  b.add(pbox(0.0025, 0.005, 0.084), 'gold', { p: [0.0175, 0.048, -0.058] }); b.add(pbox(0.0025, 0.005, 0.084), 'gold', { p: [-0.0175, 0.048, -0.058] });
  filigreeSides(b, [0, 0.014, -0.008], 0.05, 0.046, { x: 0.023 });
  // cylinder (moving): big fluted 6-shot + gold bands
  b.part('cyl', [0, 0.012, -0.062]);
  b.add(cylZ(0.0245, 0.0245, 0.056, 24), 'metal2', { p: [0, 0.012, -0.062], part: 'cyl' });
  for (let i = 0; i < 6; i++) { const a = i * PI / 3 + PI / 6; b.add(cylZ(0.0085, 0.0085, 0.058, 10), 'metal', { p: [Math.cos(a) * 0.0175, 0.012 + Math.sin(a) * 0.0175, -0.062], part: 'cyl' }); }
  b.add(torusZ(0.0264, 0.0022, 6, 28), 'gold', { p: [0, 0.012, -0.038], part: 'cyl' });
  b.add(torusZ(0.0264, 0.0022, 6, 28), 'gold', { p: [0, 0.012, -0.086], part: 'cyl' });
  // hammer (moving)
  b.part('hammer', [0, 0.034, 0.016]);
  b.add(box(0.009, 0.022, 0.010, 0.002), 'metal2', { p: [0, 0.046, 0.022], r: [0.5, 0, 0], part: 'hammer' });
  b.add(pbox(0.014, 0.006, 0.009), 'gold', { p: [0, 0.055, 0.028], r: [0.5, 0, 0], part: 'hammer' });
  // barrel: heavy octagon, SHORT (chunk over length), deep top rib + glow strip, thick under-lug
  b.add(cylZ(0.0165, 0.0175, 0.155, 8), 'metal', { p: [0, 0.028, -0.195], r: [0, 0, PI / 8] });
  b.add(box(0.014, 0.012, 0.15, 0.002), 'metal2', { p: [0, 0.047, -0.192] });
  b.add(pbox(0.005, 0.002, 0.12), 'gold', { p: [0, 0.0535, -0.19] });
  b.add(pbox(0.0025, 0.004, 0.13), 'gold', { p: [0.0175, 0.028, -0.188] }); b.add(pbox(0.0025, 0.004, 0.13), 'gold', { p: [-0.0175, 0.028, -0.188] });
  b.add(cylZ(0.010, 0.010, 0.115, 10), 'metal2', { p: [0, 0.003, -0.19] });
  b.add(box(0.026, 0.026, 0.036, 0.004), 'metal', { p: [0, 0.008, -0.13] });
  b.add(latheZ([[0.012, 0], [0.019, 0.004], [0.019, 0.016], [0.013, 0.019], [0.008, 0.019], [0.008, 0]], 12), 'gold', { p: [0, 0.028, -0.278] });
  // sights: tall front post + bead; rear notch posts on the strap rear, same sight line height
  b.add(box(0.005, 0.014, 0.012, 0.001), 'metal2', { p: [0, 0.060, -0.262] });
  b.add(sphere(0.0030, 8), 'white', { p: [0, 0.0675, -0.262] });
  b.add(pbox(0.003, 0.008, 0.009), 'metal2', { p: [0.010, 0.060, -0.018] }); b.add(pbox(0.003, 0.008, 0.009), 'metal2', { p: [-0.010, 0.060, -0.018] });
  b.add(pbox(0.0014, 0.0014, 0.009), 'white', { p: [0.0108, 0.0672, -0.018] }); b.add(pbox(0.0014, 0.0014, 0.009), 'white', { p: [-0.0108, 0.0672, -0.018] });
  screws(b, [[0.0235, 0.038, 0.012], [0.0235, -0.008, 0.012], [0.0235, 0.034, -0.108], [0.0235, -0.006, -0.108]]);
  // grip + guard
  pistolGrip(b, { p: [0, -0.054, 0.026], h: 0.10, w: 0.036, d: 0.044, tilt: -0.40 });
  b.add(pbox(0.013, 0.044, 0.024), 'ivory', { p: [0.012, -0.042, 0.024], r: [-0.40, 0, 0] }); b.add(pbox(0.013, 0.044, 0.024), 'ivory', { p: [-0.012, -0.042, 0.024], r: [-0.40, 0, 0] });
  triggerGuard(b, [0, -0.016, -0.024], 0.019);
  gripHand(b, { p: [0, -0.054, 0.026], tilt: -0.40, R: 0.024, side: 1 }); // D2 hand cannons are one-handed at idle
  // reload performance: left hand rises in with a speedloader (hidden outside reloads)
  const LP = [-0.055, -0.024, -0.010];
  b.part('lhand', LP, [0.5, 0.25, 0.3]); b.part('litem', LP, [0.5, 0.25, 0.3]);
  looseHand(b, { p: LP, part: 'lhand' });
  b.add(cylZ(0.019, 0.019, 0.009, 14), 'gold', { p: [LP[0], LP[1] + 0.008, LP[2] - 0.012], part: 'litem' });      // speedloader disc
  for (let i = 0; i < 6; i++) { const a = i * PI / 3; b.add(cylZ(0.0055, 0.0055, 0.022, 8), 'brass', { p: [LP[0] + Math.cos(a) * 0.0135, LP[1] + 0.008 + Math.sin(a) * 0.0135, LP[2] - 0.022], part: 'litem' }); }
  b.marker('muzzle', [0, 0.028, -0.302]); b.marker('sight', [0, 0.0675, -0.262]);
  return { flashScale: 0.62, lhandIdle: false };
}

function autorifle(b) {
  b.add(profile([[-0.10, -0.028], [-0.10, 0.032], [-0.07, 0.042], [0.20, 0.042], [0.23, 0.030], [0.23, -0.012], [0.12, -0.028]], 0.05), 'metal');
  b.add(profile([[-0.30, -0.062], [-0.30, 0.006], [-0.26, 0.014], [-0.10, 0.018], [-0.10, -0.018], [-0.25, -0.044]], 0.034), 'metal');
  b.add(box(0.038, 0.075, 0.014, 0.004), 'grip', { p: [0, -0.028, 0.305] });
  b.add(pbox(0.002, 0.004, 0.19), 'gold', { p: [0.0175, 0.0, 0.195] }); b.add(pbox(0.002, 0.004, 0.19), 'gold', { p: [-0.0175, 0.0, 0.195] });
  b.add(pbox(0.002, 0.004, 0.33), 'gold', { p: [0.0255, -0.021, -0.06] }); b.add(pbox(0.002, 0.004, 0.33), 'gold', { p: [-0.0255, -0.021, -0.06] });
  filigreeSides(b, [0, 0.008, -0.05], 0.15, 0.042, { x: 0.025, v: 1 });
  screws(b, [[0.0255, 0.032, 0.05], [0.0255, -0.018, 0.05], [0.0255, 0.032, -0.14], [0.0255, -0.018, -0.14]]);
  // ejection port + bolt handle (moving)
  b.add(pbox(0.003, 0.014, 0.045), 'dark', { p: [0.0255, 0.016, -0.045] });
  b.part('bolt', [0.02, 0.02, -0.01]);
  b.add(box(0.016, 0.012, 0.03, 0.003), 'metal2', { p: [0.033, 0.02, -0.01], part: 'bolt' });
  b.add(pbox(0.004, 0.012, 0.045), 'metal2', { p: [0.027, 0.016, -0.045], part: 'bolt' });
  // top rail + holo sight
  b.add(box(0.024, 0.008, 0.30, 0.002), 'metal2', { p: [0, 0.046, -0.06] });
  railNotches(b, 0.0515, 0.06, -0.20);
  b.add(box(0.014, 0.026, 0.016, 0.003), 'metal', { p: [0, 0.062, 0.02] });
  b.add(torusZ(0.015, 0.0025, 8, 24), 'metal2', { p: [0, 0.084, 0.02] });
  b.add(torusZ(0.0125, 0.0012, 6, 24), 'gold', { p: [0, 0.084, 0.02] });
  b.add(sphere(0.0018, 8), 'glow', { p: [0, 0.084, 0.02] });
  b.add(box(0.003, 0.022, 0.004, 0.001), 'metal2', { p: [0, 0.06, -0.43] });
  b.add(sphere(0.0018, 8), 'white', { p: [0, 0.072, -0.43] });
  // mag well + mag (moving)
  b.add(box(0.036, 0.036, 0.056, 0.004), 'metal', { p: [0, -0.038, -0.072] });
  b.part('mag', [0, -0.05, -0.072]);
  b.add(box(0.03, 0.115, 0.046, 0.005), 'metal2', { p: [0, -0.105, -0.066], r: [0.18, 0, 0], part: 'mag' });
  b.add(box(0.032, 0.01, 0.048, 0.002), 'gold', { p: [0, -0.16, -0.056], r: [0.18, 0, 0], part: 'mag' });
  b.add(pbox(0.005, 0.09, 0.003), 'glow', { p: [0.0135, -0.10, -0.090], r: [0.18, 0, 0], part: 'mag' }); // ammo window
  // handguard: octagonal tube with glowing vents + gold rings
  b.add(cylZ(0.026, 0.026, 0.23, 8), 'metal2', { p: [0, 0.012, -0.345], r: [0, 0, PI / 8] });
  for (const z of [-0.285, -0.345, -0.405]) {
    b.add(pbox(0.004, 0.009, 0.04), 'glow', { p: [0.0255, 0.018, z] }); b.add(pbox(0.004, 0.009, 0.04), 'glow', { p: [-0.0255, 0.018, z] });
    b.add(pbox(0.009, 0.004, 0.04), 'glow', { p: [0, 0.0375, z] });
  }
  b.add(torusZ(0.029, 0.004, 8, 24), 'gold', { p: [0, 0.012, -0.235] }); b.add(torusZ(0.029, 0.004, 8, 24), 'gold', { p: [0, 0.012, -0.455] });
  b.add(box(0.026, 0.05, 0.03, 0.006), 'grip', { p: [0, -0.032, -0.36], r: [-0.25, 0, 0] });
  // barrel + brake
  b.add(cylZ(0.010, 0.011, 0.17, 16), 'metal', { p: [0, 0.012, -0.545] });
  b.add(latheZ([[0.008, 0], [0.0115, 0.0], [0.0115, 0.008], [0.017, 0.011], [0.017, 0.028], [0.012, 0.030], [0.017, 0.032], [0.017, 0.05], [0.012, 0.053], [0.008, 0.053], [0.008, 0]], 16), 'metal2', { p: [0, 0.012, -0.62] });
  b.add(torusZ(0.0175, 0.0015, 6, 20), 'gold', { p: [0, 0.012, -0.64] });
  pistolGrip(b);
  triggerGuard(b, [0, -0.016, -0.022]);
  gripHand(b, { p: [0, -0.045, 0.02], tilt: -0.35, R: 0.021, side: 1 });
  b.part('lhand', [0, 0.010, -0.36]);
  wrapHand(b, { p: [0, 0.010, -0.36], R: 0.031, part: 'lhand' });
  b.marker('muzzle', [0, 0.012, -0.675]); b.marker('sight', [0, 0.084, 0.02]); b.marker('port', [0.03, 0.018, -0.045]);
  return { flashScale: 0.8 };
}

function pulse(b) {
  b.add(profile([[-0.08, -0.026], [-0.08, 0.032], [0.26, 0.032], [0.29, 0.02], [0.29, -0.012], [0.10, -0.026]], 0.044), 'metal');
  // skeleton stock
  b.add(box(0.028, 0.018, 0.25, 0.004), 'metal', { p: [0, 0.0, 0.20], r: [0.1, 0, 0] });
  b.add(box(0.026, 0.014, 0.20, 0.003), 'metal2', { p: [0, -0.05, 0.20], r: [-0.05, 0, 0] });
  b.add(box(0.034, 0.085, 0.022, 0.005), 'grip', { p: [0, -0.03, 0.32] });
  b.add(pbox(0.036, 0.004, 0.024), 'gold', { p: [0, 0.012, 0.32] });
  b.add(pbox(0.003, 0.004, 0.36), 'gold', { p: [0.0225, -0.02, 0.06] }); b.add(pbox(0.003, 0.004, 0.36), 'gold', { p: [-0.0225, -0.02, 0.06] });
  filigreeSides(b, [0, 0.005, 0.02], 0.14, 0.036, { x: 0.022, v: 2 });
  screws(b, [[0.022, 0.026, 0.06], [0.022, -0.02, 0.06], [0.022, 0.026, -0.06], [0.022, -0.02, -0.06]]);
  // reflex sight: frame + glass + dot
  b.add(box(0.02, 0.022, 0.04, 0.003), 'metal2', { p: [0, 0.042, -0.02] });
  const fy = 0.078, fz = -0.02;
  b.add(pbox(0.036, 0.004, 0.006), 'metal', { p: [0, fy + 0.014, fz] }); b.add(pbox(0.036, 0.004, 0.006), 'metal', { p: [0, fy - 0.014, fz] });
  b.add(pbox(0.004, 0.032, 0.006), 'metal', { p: [0.016, fy, fz] }); b.add(pbox(0.004, 0.032, 0.006), 'metal', { p: [-0.016, fy, fz] });
  b.add(pbox(0.03, 0.0015, 0.0065), 'gold', { p: [0, fy + 0.0115, fz] });
  b.add(new THREE.PlaneGeometry(0.03, 0.026), 'glass', { p: [0, fy, fz] });
  b.add(sphere(0.0016, 8), 'glow', { p: [0, fy, fz] });
  // bolt handle (moving) + port
  b.add(pbox(0.003, 0.012, 0.04), 'dark', { p: [0.0225, 0.012, -0.06] });
  b.part('bolt', [0.02, 0.015, -0.02]);
  b.add(box(0.014, 0.010, 0.026, 0.003), 'metal2', { p: [0.028, 0.015, -0.02], part: 'bolt' });
  // mag (moving)
  b.add(box(0.032, 0.03, 0.056, 0.004), 'metal', { p: [0, -0.035, -0.085] });
  b.part('mag', [0, -0.045, -0.085]);
  b.add(box(0.028, 0.10, 0.05, 0.004), 'metal2', { p: [0, -0.095, -0.085], part: 'mag' });
  b.add(box(0.03, 0.008, 0.052, 0.002), 'gold', { p: [0, -0.146, -0.085], part: 'mag' });
  // long rectangular handguard with top glow slits + side gold rails
  b.add(box(0.042, 0.046, 0.26, 0.006), 'metal2', { p: [0, 0.006, -0.42] });
  for (const z of [-0.33, -0.37, -0.41, -0.45, -0.49]) b.add(pbox(0.018, 0.003, 0.024), 'glow', { p: [0, 0.0295, z] });
  b.add(pbox(0.003, 0.006, 0.24), 'gold', { p: [0.0215, 0.0, -0.42] }); b.add(pbox(0.003, 0.006, 0.24), 'gold', { p: [-0.0215, 0.0, -0.42] });
  for (const z of [-0.36, -0.42, -0.48]) { b.add(pbox(0.003, 0.012, 0.02), 'glow', { p: [0.0215, 0.014, z] }); b.add(pbox(0.003, 0.012, 0.02), 'glow', { p: [-0.0215, 0.014, z] }); }
  b.add(box(0.03, 0.02, 0.03, 0.004), 'metal', { p: [0, -0.032, -0.40] }); // handstop
  // barrel + compensator
  b.add(cylZ(0.009, 0.010, 0.18, 16), 'metal', { p: [0, 0.010, -0.63] });
  b.add(latheZ([[0.007, 0], [0.012, 0.0], [0.014, 0.006], [0.014, 0.04], [0.010, 0.045], [0.007, 0.045], [0.007, 0]], 12), 'metal2', { p: [0, 0.010, -0.70] });
  b.add(pbox(0.032, 0.006, 0.006), 'dark', { p: [0, 0.010, -0.72] }); b.add(pbox(0.032, 0.006, 0.006), 'dark', { p: [0, 0.010, -0.73] });
  b.add(torusZ(0.0145, 0.0015, 6, 20), 'gold', { p: [0, 0.010, -0.703] });
  b.add(box(0.003, 0.014, 0.004, 0.001), 'metal2', { p: [0, 0.036, -0.54] }); b.add(sphere(0.0016, 8), 'white', { p: [0, 0.044, -0.54] });
  pistolGrip(b);
  triggerGuard(b, [0, -0.016, -0.022]);
  gripHand(b, { p: [0, -0.045, 0.02], tilt: -0.35, R: 0.021, side: 1 });
  b.part('lhand', [0, 0.006, -0.42]);
  wrapHand(b, { p: [0, 0.006, -0.42], R: 0.030, part: 'lhand' });
  b.marker('muzzle', [0, 0.010, -0.747]); b.marker('sight', [0, fy, fz]); b.marker('port', [0.026, 0.014, -0.06]);
  return { flashScale: 0.75 };
}

function shotgun(b) {
  b.add(box(0.056, 0.07, 0.16, 0.007), 'metal', { p: [0, 0.012, -0.05] });
  b.add(profile([[-0.22, -0.06], [-0.22, 0.0], [-0.14, 0.012], [-0.03, 0.02], [-0.03, -0.02], [-0.15, -0.045]], 0.038), 'metal');
  b.add(box(0.042, 0.07, 0.016, 0.004), 'grip', { p: [0, -0.028, 0.225] });
  b.add(pbox(0.002, 0.004, 0.15), 'gold', { p: [0.0195, -0.01, 0.10] }); b.add(pbox(0.002, 0.004, 0.15), 'gold', { p: [-0.0195, -0.01, 0.10] });
  filigreeSides(b, [0, 0.012, -0.05], 0.12, 0.05, { x: 0.028, left: false, v: 1 });
  screws(b, [[0.028, 0.04, 0.02], [0.028, -0.016, 0.02], [0.028, 0.04, -0.115], [0.028, -0.016, -0.115]]);
  // side saddle shells (left), solar tips
  for (let i = 0; i < 4; i++) { const y = 0.03 - i * 0.016; b.add(cylZ(0.0065, 0.0065, 0.05, 10), 'gold', { p: [-0.034, y, -0.04] }); b.add(cylZ(0.0062, 0.0062, 0.02, 10), 'glow', { p: [-0.034, y, -0.075] }); }
  b.add(pbox(0.004, 0.07, 0.07), 'metal2', { p: [-0.0285, 0.008, -0.04] });
  // barrel, heat shield with glowing vents, mag tube
  b.add(cylZ(0.014, 0.014, 0.34, 16), 'metal', { p: [0, 0.032, -0.30] });
  b.add(cylZ(0.021, 0.021, 0.20, 12), 'metal2', { p: [0, 0.032, -0.245] });
  for (const z of [-0.19, -0.225, -0.26, -0.295]) { b.add(pbox(0.004, 0.007, 0.024), 'glow', { p: [0.021, 0.038, z] }); b.add(pbox(0.004, 0.007, 0.024), 'glow', { p: [-0.021, 0.038, z] }); b.add(pbox(0.010, 0.004, 0.024), 'glow', { p: [0, 0.051, z] }); }
  b.add(torusZ(0.0235, 0.003, 8, 24), 'gold', { p: [0, 0.032, -0.145] }); b.add(torusZ(0.0235, 0.003, 8, 24), 'gold', { p: [0, 0.032, -0.345] });
  b.add(cylZ(0.012, 0.012, 0.31, 12), 'metal', { p: [0, 0.004, -0.285] });
  b.add(latheZ([[0.012, 0], [0.014, 0.004], [0.014, 0.012], [0.010, 0.014], [0.006, 0.014], [0.006, 0]], 12), 'gold', { p: [0, 0.004, -0.44] });
  // pump (moving)
  b.part('pump', [0, 0.018, -0.30]);
  b.add(box(0.05, 0.05, 0.09, 0.009), 'grip', { p: [0, 0.018, -0.30], part: 'pump' });
  for (const z of [-0.27, -0.30, -0.33]) b.add(torusZ(0.0255, 0.002, 6, 4), 'gold', { p: [0, 0.018, z], r: [0, 0, PI / 4], s: [1.05, 1.05, 1], part: 'pump' });
  // muzzle choke
  b.add(latheZ([[0.012, 0], [0.016, 0], [0.019, 0.01], [0.019, 0.03], [0.015, 0.033], [0.011, 0.033], [0.011, 0]], 16), 'metal2', { p: [0, 0.032, -0.47] });
  b.add(torusZ(0.0195, 0.0015, 6, 20), 'gold', { p: [0, 0.032, -0.49] });
  // sights
  b.add(box(0.004, 0.008, 0.01, 0.001), 'metal2', { p: [0, 0.053, -0.48] }); b.add(sphere(0.0028, 8), 'white', { p: [0, 0.0585, -0.48] });
  b.add(pbox(0.004, 0.006, 0.008), 'metal2', { p: [0.006, 0.050, 0.0] }); b.add(pbox(0.004, 0.006, 0.008), 'metal2', { p: [-0.006, 0.050, 0.0] });
  pistolGrip(b, { p: [0, -0.045, 0.025], w: 0.034, d: 0.04 });
  triggerGuard(b, [0, -0.016, -0.02]);
  gripHand(b, { p: [0, -0.045, 0.025], tilt: -0.35, R: 0.0225, side: 1 });
  // support hand is its own part: rides the pump on fire, leaves to feed shells on reload
  const SLP = [0, 0.018, -0.30];
  b.part('lhand', SLP); b.part('litem', SLP);
  wrapHand(b, { p: SLP, R: 0.033, part: 'lhand' });
  b.add(cylZ(0.0068, 0.0068, 0.05, 10), 'gold', { p: [SLP[0] - 0.02, SLP[1] - 0.026, SLP[2] + 0.01], r: [0.2, 0.3, 0], part: 'litem' });   // shell in hand
  b.add(cylZ(0.0064, 0.0064, 0.018, 10), 'glow', { p: [SLP[0] - 0.02 - 0.0085, SLP[1] - 0.026 + 0.0056, SLP[2] + 0.01 - 0.031], r: [0.2, 0.3, 0], part: 'litem' });
  b.marker('muzzle', [0, 0.032, -0.505]); b.marker('sight', [0, 0.0585, -0.48]); b.marker('port', [0.03, 0.02, -0.04]);
  return { flashScale: 0.85, lSaddle: [-0.036, 0.012, -0.04], lPort: [0, -0.028, -0.115] };
}

function sniper(b) {
  b.add(profile([[-0.06, -0.03], [-0.06, 0.035], [0.18, 0.035], [0.20, 0.02], [0.20, -0.015], [0.05, -0.03]], 0.046), 'metal');
  b.add(profile([[-0.32, -0.08], [-0.32, 0.02], [-0.28, 0.046], [-0.12, 0.04], [-0.06, 0.035], [-0.06, -0.03], [-0.22, -0.05]], 0.04), 'metal');
  b.add(box(0.032, 0.016, 0.11, 0.004), 'grip', { p: [0, 0.052, 0.20] }); // cheek riser
  b.add(box(0.044, 0.10, 0.016, 0.004), 'grip', { p: [0, -0.03, 0.325] });
  b.add(pbox(0.003, 0.005, 0.22), 'gold', { p: [0.0205, 0.0, 0.16], r: [0.1, 0, 0] }); b.add(pbox(0.003, 0.005, 0.22), 'gold', { p: [-0.0205, 0.0, 0.16], r: [0.1, 0, 0] });
  filigreeSides(b, [0, -0.01, 0.19], 0.16, 0.05, { x: 0.02 });
  filigreeSides(b, [0, 0.004, 0.06], 0.1, 0.04, { x: 0.023, v: 2 });
  screws(b, [[0.023, 0.028, 0.02], [0.023, -0.022, 0.02], [0.023, 0.028, -0.05], [0.023, -0.022, -0.05]]);
  // scope
  b.add(cylZ(0.02, 0.02, 0.26, 20), 'metal', { p: [0, 0.085, -0.04] });
  b.add(latheZ([[0.02, 0], [0.028, 0.015], [0.028, 0.05], [0.025, 0.054], [0.0, 0.054]], 20), 'metal', { p: [0, 0.085, -0.17] });
  b.add(cylZ(0.024, 0.021, 0.03, 20), 'metal', { p: [0, 0.085, 0.105] });
  b.add(cylZ(0.017, 0.017, 0.004, 20), 'glass', { p: [0, 0.085, 0.121] });      // ocular lens
  b.add(torusZ(0.019, 0.0015, 6, 24), 'glow', { p: [0, 0.085, 0.122] });      // glowing reticle ring
  b.add(cylZ(0.025, 0.025, 0.003, 20), 'glass', { p: [0, 0.085, -0.225] });     // objective lens
  b.add(torusZ(0.028, 0.002, 6, 24), 'gold', { p: [0, 0.085, -0.224] }); b.add(torusZ(0.025, 0.002, 6, 24), 'gold', { p: [0, 0.085, 0.12] });
  for (const z of [-0.10, 0.03]) { b.add(torusZ(0.022, 0.004, 8, 24), 'metal2', { p: [0, 0.085, z] }); b.add(box(0.02, 0.03, 0.02, 0.003), 'metal2', { p: [0, 0.055, z] }); }
  b.add(cylY(0.009, 0.009, 0.016, 12), 'metal2', { p: [0, 0.11, -0.03] }); b.add(cylX(0.009, 0.016, 12), 'metal2', { p: [0.028, 0.085, -0.03] });
  b.add(torusZ(0.0205, 0.0015, 6, 24), 'gold', { p: [0, 0.085, -0.06] });
  // bolt (moving): body + handle + ball
  b.part('bolt', [0, 0.02, -0.03]);
  b.add(cylZ(0.008, 0.008, 0.09, 12), 'metal2', { p: [0, 0.02, 0.0], part: 'bolt' });
  b.add(cylX(0.0035, 0.034, 8), 'metal2', { p: [0.038, 0.014, -0.03], r: [0, 0, -0.35], part: 'bolt' });
  b.add(sphere(0.0065, 10), 'gold', { p: [0.054, 0.008, -0.03], part: 'bolt' });
  b.add(pbox(0.003, 0.012, 0.05), 'dark', { p: [0.0235, 0.02, -0.06] });
  // mag (moving)
  b.part('mag', [0, -0.03, -0.09]);
  b.add(box(0.032, 0.06, 0.07, 0.004), 'metal2', { p: [0, -0.055, -0.09], part: 'mag' });
  b.add(box(0.034, 0.008, 0.072, 0.002), 'gold', { p: [0, -0.088, -0.09], part: 'mag' });
  // barrel, bands, brake, bipod
  b.add(cylZ(0.011, 0.013, 0.53, 16), 'metal', { p: [0, 0.02, -0.465] });
  for (const z of [-0.30, -0.45, -0.60]) b.add(torusZ(0.0135, 0.0018, 6, 20), 'gold', { p: [0, 0.02, z] });
  b.add(latheZ([[0.009, 0], [0.013, 0], [0.02, 0.005], [0.02, 0.018], [0.014, 0.02], [0.02, 0.022], [0.02, 0.036], [0.014, 0.038], [0.02, 0.04], [0.02, 0.056], [0.013, 0.06], [0.009, 0.06], [0.009, 0]], 16), 'metal2', { p: [0, 0.02, -0.73] });
  b.add(torusZ(0.0205, 0.0015, 6, 20), 'gold', { p: [0, 0.02, -0.76] });
  for (const sx of [1, -1]) { b.add(cylZ(0.0035, 0.0035, 0.14, 8), 'metal2', { p: [sx * 0.014, 0.004, -0.56], r: [0.05, 0, sx * 0.12] }); b.add(box(0.008, 0.008, 0.02, 0.002), 'metal', { p: [sx * 0.022, -0.002, -0.63] }); }
  b.add(box(0.02, 0.014, 0.05, 0.003), 'metal', { p: [0, 0.002, -0.49] });
  // iron backup sight (front) - scope is primary
  b.add(box(0.003, 0.012, 0.004, 0.001), 'metal2', { p: [0, 0.04, -0.70] }); b.add(sphere(0.0015, 8), 'white', { p: [0, 0.047, -0.70] });
  pistolGrip(b, { p: [0, -0.05, 0.03], h: 0.095 });
  triggerGuard(b, [0, -0.016, -0.02]);
  gripHand(b, { p: [0, -0.05, 0.03], tilt: -0.35, R: 0.021, side: 1 });
  b.part('lhand', [0, 0.012, -0.49]);
  wrapHand(b, { p: [0, 0.012, -0.49], R: 0.026, part: 'lhand' });
  b.marker('muzzle', [0, 0.02, -0.792]); b.marker('sight', [0, 0.085, -0.04]); b.marker('port', [0.026, 0.022, -0.06]);
  return { flashScale: 0.85 };
}

function fusion(b) {
  // deep-violet void weapon: dark metal body, gold filigree, restrained glow (no flat plates, no pink)
  const core = b.mat('core'); core.color.setHex(0x1a1030); core.emissive.setHex(0x7a3cff); core.emissiveIntensity = 1.2;
  b.add(box(0.06, 0.068, 0.30, 0.009), 'metal', { p: [0, 0.012, -0.08] });
  b.add(box(0.052, 0.02, 0.26, 0.005), 'metal2', { p: [0, 0.045, -0.08] });                    // shoulder chamfer
  b.add(box(0.03, 0.016, 0.36, 0.004), 'metal', { p: [0, 0.058, -0.10] });                     // top spine (dark)
  b.add(pbox(0.004, 0.0035, 0.34), 'gold', { p: [0.012, 0.0672, -0.10] }); b.add(pbox(0.004, 0.0035, 0.34), 'gold', { p: [-0.012, 0.0672, -0.10] });
  b.add(pbox(0.010, 0.0025, 0.30), 'dark', { p: [0, 0.0668, -0.10] });                          // center channel
  for (let z = 0.02; z > -0.22; z -= 0.028) b.add(pbox(0.032, 0.004, 0.008), 'metal2', { p: [0, 0.0675, z] }); // spine ribs
  b.add(new THREE.PlaneGeometry(0.18, 0.024).rotateX(-PI / 2), 'filigree2', { p: [0, 0.0704, -0.09] });        // top filigree
  b.add(box(0.04, 0.05, 0.12, 0.008), 'metal', { p: [0, -0.008, 0.13] });
  b.add(box(0.042, 0.07, 0.016, 0.004), 'grip', { p: [0, -0.012, 0.195] });
  b.add(pbox(0.003, 0.006, 0.28), 'gold', { p: [0.0305, 0.038, -0.08] }); b.add(pbox(0.003, 0.006, 0.28), 'gold', { p: [-0.0305, 0.038, -0.08] });
  b.add(pbox(0.003, 0.006, 0.28), 'gold', { p: [0.0305, -0.016, -0.08] }); b.add(pbox(0.003, 0.006, 0.28), 'gold', { p: [-0.0305, -0.016, -0.08] });
  filigreeSides(b, [0, 0.012, -0.08], 0.2, 0.04, { x: 0.030, v: 1 });
  screws(b, [[0.0305, 0.04, 0.05], [0.0305, -0.014, 0.05], [0.0305, 0.04, -0.21], [0.0305, -0.014, -0.21]]);
  b.add(pbox(0.004, 0.04, 0.004), 'core', { p: [0.0305, 0.012, 0.0] }); b.add(pbox(0.004, 0.04, 0.004), 'core', { p: [-0.0305, 0.012, 0.0] }); // charge indicator bars
  // coil section: core tube + gold coils + glow rings + rails + front cap
  b.add(cylZ(0.012, 0.012, 0.27, 14), 'core', { p: [0, 0.015, -0.365] });
  for (const z of [-0.27, -0.33, -0.39, -0.45]) b.add(torusZ(0.026, 0.0055, 10, 28), 'gold', { p: [0, 0.015, z] });
  for (const z of [-0.30, -0.36, -0.42]) b.add(torusZ(0.024, 0.0025, 8, 28), 'core', { p: [0, 0.015, z] });
  for (const a of [PI / 2, PI / 2 + 2.2, PI / 2 - 2.2]) b.add(box(0.007, 0.007, 0.27, 0.002), 'metal2', { p: [Math.cos(a) * 0.034, 0.015 + Math.sin(a) * 0.034, -0.365] });
  b.add(box(0.052, 0.064, 0.03, 0.008), 'metal', { p: [0, 0.015, -0.515] });
  b.add(cylZ(0.016, 0.016, 0.006, 16), 'dark', { p: [0, 0.015, -0.531] });
  b.add(cylZ(0.010, 0.010, 0.004, 16), 'core', { p: [0, 0.015, -0.533] });
  b.add(torusZ(0.02, 0.002, 6, 24), 'gold', { p: [0, 0.015, -0.531] });
  // battery cell (moving) under the body
  b.part('cell', [0, -0.03, -0.10]);
  b.add(cylY(0.017, 0.017, 0.09, 14), 'metal2', { p: [0, -0.065, -0.10], part: 'cell' });
  b.add(torusZ(0.0178, 0.0025, 6, 20), 'core', { p: [0, -0.07, -0.10], r: [PI / 2, 0, 0], part: 'cell' });
  b.add(cylY(0.019, 0.019, 0.008, 14), 'gold', { p: [0, -0.112, -0.10], part: 'cell' });
  // bottom rail + foregrip, sights
  b.add(box(0.03, 0.012, 0.26, 0.003), 'metal', { p: [0, -0.025, -0.36] });
  b.add(box(0.028, 0.05, 0.03, 0.006), 'grip', { p: [0, -0.055, -0.33], r: [-0.25, 0, 0] });
  b.add(torusZ(0.01, 0.002, 6, 20), 'metal2', { p: [0, 0.084, 0.02] }); b.add(pbox(0.004, 0.012, 0.008), 'metal2', { p: [0, 0.07, 0.02] });
  b.add(box(0.003, 0.016, 0.004, 0.001), 'metal2', { p: [0, 0.074, -0.27] }); b.add(sphere(0.0018, 8), 'white', { p: [0, 0.084, -0.27] });
  pistolGrip(b, { p: [0, -0.05, 0.02], h: 0.09 });
  triggerGuard(b, [0, -0.022, -0.02]);
  gripHand(b, { p: [0, -0.05, 0.02], tilt: -0.35, R: 0.021, side: 1 });
  b.part('lhand', [0, -0.055, -0.33]);
  gripHand(b, { p: [0, -0.055, -0.33], tilt: -0.25, R: 0.019, side: -1, part: 'lhand' });
  b.marker('muzzle', [0, 0.015, -0.54]); b.marker('sight', [0, 0.084, 0.02]);
  return { flashScale: 0.8, coreBase: 1.2 };
}


// Pale Verse — scout rifle, imported from the Aurelen build. Long, light, precision: slim receiver, ivory
// furniture, a prism sight with a lit reticle ring, and a barrel long enough to read as "reach" in the hand.
function scout(b) {
  b.add(profile([[-0.08, -0.028], [-0.08, 0.034], [-0.05, 0.042], [0.20, 0.042], [0.23, 0.028], [0.23, -0.014], [0.10, -0.028]], 0.046), 'metal');
  b.add(profile([[-0.34, -0.062], [-0.34, 0.016], [-0.30, 0.030], [-0.12, 0.030], [-0.08, 0.024], [-0.08, -0.028], [-0.26, -0.048]], 0.036), 'metal');   // dark stock: an ivory slab this size fills half the screen at ADS
  b.add(box(0.028, 0.012, 0.095, 0.004), 'grip', { p: [0, 0.040, 0.22] });                    // leather cheek comb (ivory here sits against the eye at ADS and reads as a white slab)
  b.add(box(0.040, 0.012, 0.055, 0.003), 'gold', { p: [0, -0.052, 0.31], r: [0.12, 0, 0] });  // butt plate
  b.add(pbox(0.0025, 0.005, 0.24), 'gold', { p: [0.0185, 0.006, 0.19], r: [0.06, 0, 0] }); b.add(pbox(0.0025, 0.005, 0.24), 'gold', { p: [-0.0185, 0.006, 0.19], r: [0.06, 0, 0] });
  b.add(pbox(0.0025, 0.005, 0.30), 'gold', { p: [0.0235, -0.020, -0.05] }); b.add(pbox(0.0025, 0.005, 0.30), 'gold', { p: [-0.0235, -0.020, -0.05] });
  filigreeSides(b, [0, 0.006, -0.02], 0.17, 0.044, { x: 0.024, v: 2 });
  screws(b, [[0.0235, 0.030, 0.06], [0.0235, -0.018, 0.06], [0.0235, 0.030, -0.13], [0.0235, -0.018, -0.13]]);
  // ejection port + charging handle (moving)
  b.add(pbox(0.003, 0.013, 0.042), 'dark', { p: [0.0235, 0.014, -0.04] });
  b.part('bolt', [0.02, 0.018, -0.01]);
  b.add(box(0.014, 0.011, 0.026, 0.003), 'metal2', { p: [0.031, 0.018, -0.01], part: 'bolt' });
  b.add(pbox(0.004, 0.011, 0.040), 'metal2', { p: [0.026, 0.014, -0.04], part: 'bolt' });
  // top rail + prism sight (short scope, gold rings, lit reticle)
  b.add(box(0.022, 0.008, 0.30, 0.002), 'metal2', { p: [0, 0.046, -0.05] });
  railNotches(b, 0.0515, 0.07, -0.19);
  b.add(cylZ(0.0165, 0.0165, 0.115, 18), 'metal', { p: [0, 0.078, -0.02] });
  b.add(latheZ([[0.0165, 0], [0.023, 0.012], [0.023, 0.03], [0.0, 0.03]], 18), 'metal', { p: [0, 0.078, -0.088] });
  b.add(cylZ(0.020, 0.020, 0.003, 18), 'glass', { p: [0, 0.078, -0.118] });                   // objective
  b.add(cylZ(0.0145, 0.0145, 0.003, 18), 'glass', { p: [0, 0.078, 0.038] });                  // ocular
  b.add(torusZ(0.0225, 0.0018, 6, 24), 'gold', { p: [0, 0.078, -0.117] });
  b.add(torusZ(0.0165, 0.0015, 6, 24), 'glow', { p: [0, 0.078, 0.039] });                     // reticle ring
  for (const z of [-0.055, 0.012]) { b.add(torusZ(0.0185, 0.0035, 8, 22), 'metal2', { p: [0, 0.078, z] }); b.add(box(0.018, 0.026, 0.018, 0.003), 'metal2', { p: [0, 0.056, z] }); }
  // mag (moving) + well
  b.add(box(0.032, 0.030, 0.050, 0.004), 'metal', { p: [0, -0.036, -0.062] });
  b.part('mag', [0, -0.046, -0.062]);
  b.add(box(0.028, 0.086, 0.042, 0.005), 'metal2', { p: [0, -0.090, -0.056], r: [0.14, 0, 0], part: 'mag' });
  b.add(box(0.030, 0.009, 0.044, 0.002), 'gold', { p: [0, -0.132, -0.050], r: [0.14, 0, 0], part: 'mag' });
  b.add(pbox(0.004, 0.070, 0.003), 'glow', { p: [0.0125, -0.088, -0.076], r: [0.14, 0, 0], part: 'mag' });
  // handguard + long barrel + brake
  b.add(cylZ(0.023, 0.023, 0.20, 8), 'metal2', { p: [0, 0.012, -0.34], r: [0, 0, PI / 8] });
  for (const z of [-0.28, -0.34, -0.40]) { b.add(pbox(0.004, 0.008, 0.036), 'glow', { p: [0.0225, 0.018, z] }); b.add(pbox(0.004, 0.008, 0.036), 'glow', { p: [-0.0225, 0.018, z] }); }
  b.add(torusZ(0.026, 0.0035, 8, 24), 'gold', { p: [0, 0.012, -0.245] }); b.add(torusZ(0.026, 0.0035, 8, 24), 'gold', { p: [0, 0.012, -0.435] });
  b.add(box(0.024, 0.044, 0.028, 0.006), 'grip', { p: [0, -0.026, -0.35], r: [-0.22, 0, 0] });    // leather foregrip
  b.add(cylZ(0.0095, 0.0105, 0.24, 16), 'metal', { p: [0, 0.012, -0.565] });
  for (const z of [-0.50, -0.60]) b.add(torusZ(0.0125, 0.0016, 6, 20), 'gold', { p: [0, 0.012, z] });
  b.add(latheZ([[0.008, 0], [0.012, 0], [0.017, 0.005], [0.017, 0.020], [0.012, 0.022], [0.017, 0.024], [0.017, 0.040], [0.012, 0.043], [0.008, 0.043], [0.008, 0]], 16), 'metal2', { p: [0, 0.012, -0.688] });
  b.add(torusZ(0.0175, 0.0015, 6, 20), 'gold', { p: [0, 0.012, -0.716] });
  b.add(box(0.003, 0.011, 0.004, 0.001), 'metal2', { p: [0, 0.036, -0.66] }); b.add(sphere(0.0015, 8), 'white', { p: [0, 0.0425, -0.66] });  // backup front post
  pistolGrip(b, { p: [0, -0.048, 0.028], h: 0.092 });
  triggerGuard(b, [0, -0.016, -0.020]);
  gripHand(b, { p: [0, -0.048, 0.028], tilt: -0.35, R: 0.021, side: 1 });
  b.part('lhand', [0, 0.008, -0.35]);
  wrapHand(b, { p: [0, 0.008, -0.35], R: 0.028, part: 'lhand' });
  b.marker('muzzle', [0, 0.012, -0.742]); b.marker('sight', [0, 0.078, -0.02]); b.marker('port', [0.026, 0.016, -0.05]);
  return { flashScale: 0.72 };
}

// Rimecaller — charge beam, imported from the Aurelen build. A shoulder relic, not a gun: a frost prism in
// a gold cradle, three focusing prongs, and a cell that drops out on reload. Glow stays hue-saturated and
// capped at the fusion's core intensity — a beam weapon is the easiest thing in the game to turn into a
// white ball, and CLAUDE.md is explicit that the fix is colour, never brightness.
function beam(b) {
  const core = b.mat('core'); core.color.setHex(0x0d1c30); core.emissive.setHex(0x7fd8ff); core.emissiveIntensity = 1.15;
  b.add(box(0.058, 0.070, 0.28, 0.010), 'metal', { p: [0, 0.014, -0.06] });
  b.add(box(0.050, 0.018, 0.24, 0.005), 'metal2', { p: [0, 0.048, -0.06] });
  b.add(box(0.028, 0.014, 0.34, 0.004), 'metal', { p: [0, 0.060, -0.09] });                      // spine
  b.add(pbox(0.004, 0.003, 0.32), 'gold', { p: [0.011, 0.068, -0.09] }); b.add(pbox(0.004, 0.003, 0.32), 'gold', { p: [-0.011, 0.068, -0.09] });
  b.add(new THREE.PlaneGeometry(0.17, 0.022).rotateX(-PI / 2), 'filigree0', { p: [0, 0.0705, -0.08] });
  b.add(pbox(0.003, 0.006, 0.26), 'gold', { p: [0.0295, 0.040, -0.06] }); b.add(pbox(0.003, 0.006, 0.26), 'gold', { p: [-0.0295, 0.040, -0.06] });
  b.add(pbox(0.003, 0.006, 0.26), 'gold', { p: [0.0295, -0.014, -0.06] }); b.add(pbox(0.003, 0.006, 0.26), 'gold', { p: [-0.0295, -0.014, -0.06] });
  filigreeSides(b, [0, 0.014, -0.06], 0.19, 0.042, { x: 0.030, v: 1 });
  screws(b, [[0.0295, 0.042, 0.05], [0.0295, -0.012, 0.05], [0.0295, 0.042, -0.17], [0.0295, -0.012, -0.17]]);
  b.add(pbox(0.004, 0.036, 0.004), 'core', { p: [0.0295, 0.014, -0.01] }); b.add(pbox(0.004, 0.036, 0.004), 'core', { p: [-0.0295, 0.014, -0.01] });
  // shoulder stock: the weight cue that says "braced", per the original's heavy pose
  b.add(profile([[-0.28, -0.052], [-0.28, 0.026], [-0.24, 0.040], [-0.08, 0.040], [-0.08, -0.034], [-0.22, -0.044]], 0.040), 'metal');
  b.add(box(0.046, 0.086, 0.016, 0.004), 'grip', { p: [0, -0.014, 0.285], r: [0.10, 0, 0] });     // shoulder pad
  b.add(box(0.048, 0.012, 0.020, 0.003), 'gold', { p: [0, 0.030, 0.286], r: [0.10, 0, 0] });
  // frost prism in a gold cradle (the barrel is a lens stack, not a tube)
  b.add(cylZ(0.013, 0.013, 0.25, 14), 'core', { p: [0, 0.016, -0.325] });
  for (const z of [-0.235, -0.30, -0.365, -0.43]) b.add(torusZ(0.027, 0.006, 10, 28), 'gold', { p: [0, 0.016, z] });
  for (const z of [-0.268, -0.333, -0.398]) b.add(torusZ(0.025, 0.0026, 8, 28), 'core', { p: [0, 0.016, z] });
  for (const a of [PI / 2, PI / 2 + 2.09, PI / 2 - 2.09]) b.add(box(0.0075, 0.0075, 0.25, 0.002), 'metal2', { p: [Math.cos(a) * 0.035, 0.016 + Math.sin(a) * 0.035, -0.325] });
  // three focusing prongs, angled in toward the emitter point
  for (const a of [PI / 2, PI / 2 + 2.09, PI / 2 - 2.09]) {
    const cx = Math.cos(a), cy = Math.sin(a);
    b.add(box(0.010, 0.010, 0.085, 0.003), 'metal', { p: [cx * 0.030, 0.016 + cy * 0.030, -0.485], r: [cy * 0.16, -cx * 0.16, 0] });
    b.add(sphere(0.0055, 10), 'core', { p: [cx * 0.019, 0.016 + cy * 0.019, -0.524] });
  }
  b.add(cylZ(0.017, 0.017, 0.008, 16), 'dark', { p: [0, 0.016, -0.470] });
  b.add(cylZ(0.010, 0.010, 0.004, 16), 'core', { p: [0, 0.016, -0.474] });
  b.add(torusZ(0.021, 0.0022, 6, 24), 'gold', { p: [0, 0.016, -0.470] });
  // aether cell (moving) under the body
  b.part('cell', [0, -0.030, -0.08]);
  b.add(cylY(0.018, 0.018, 0.086, 14), 'metal2', { p: [0, -0.064, -0.08], part: 'cell' });
  b.add(torusZ(0.0188, 0.0026, 6, 20), 'core', { p: [0, -0.068, -0.08], r: [PI / 2, 0, 0], part: 'cell' });
  b.add(cylY(0.020, 0.020, 0.008, 14), 'gold', { p: [0, -0.108, -0.08], part: 'cell' });
  // bottom rail + foregrip + sights
  b.add(box(0.030, 0.012, 0.24, 0.003), 'metal', { p: [0, -0.026, -0.32] });
  b.add(box(0.028, 0.050, 0.030, 0.006), 'grip', { p: [0, -0.056, -0.30], r: [-0.25, 0, 0] });
  b.add(torusZ(0.0105, 0.002, 6, 20), 'metal2', { p: [0, 0.086, 0.01] }); b.add(pbox(0.004, 0.012, 0.008), 'metal2', { p: [0, 0.072, 0.01] });
  b.add(box(0.003, 0.016, 0.004, 0.001), 'metal2', { p: [0, 0.076, -0.24] }); b.add(sphere(0.0018, 8), 'white', { p: [0, 0.086, -0.24] });
  pistolGrip(b, { p: [0, -0.050, 0.020], h: 0.092 });
  triggerGuard(b, [0, -0.022, -0.020]);
  gripHand(b, { p: [0, -0.050, 0.020], tilt: -0.35, R: 0.021, side: 1 });
  b.part('lhand', [0, -0.056, -0.30]);
  gripHand(b, { p: [0, -0.056, -0.30], tilt: -0.25, R: 0.019, side: -1, part: 'lhand' });
  b.marker('muzzle', [0, 0.016, -0.540]); b.marker('sight', [0, 0.086, 0.01] );
  return { flashScale: 0.9, coreBase: 1.15 };
}

const BUILDERS = { handcannon, autorifle, pulse, shotgun, sniper, fusion, scout, beam };

/**
 * Standalone armored gauntlet for the ability gestures (grenade lob / grapple launch). Built from the
 * SAME hands.js sub-assemblies and the SAME gun materials as the weapon viewmodel hands, so the character keeps one
 * pair of hands — an energy hand belongs to the super (you are channelling Starfall), not to throwing a grenade.
 * Used by the grenade lob and the grapple launch. Melee does NOT use it — melee is a bash with the equipped weapon.
 * ~4 merged meshes, only visible for the 0.5-0.62 s a gesture lasts.
 */
export function buildAbilityHand(mats) {
  const b = new Builder(mats, 'kinetic');
  // gripHand is the good one: 3-segment fingers with knuckle armour, back-of-hand plate, gold studs, bracer forearm.
  // Curled with the grip hole filled in it is a closed gauntlet — which is how you hold a grenade and launch a hook.
  // armLen 0.09: the cuff, gold ring and plate collapse into a wrist BRACER. A full-length arm floating in open
  // frame with no body attached reads as a loose object next to the gun, not as the player's arm.
  gripHand(b, { p: [0, 0, 0], tilt: -0.25, R: 0.019, side: 1, armLen: 0.11, armDir: [-0.28, -0.95, 0.15] });   // hangs DOWN from the wrist: aimed at the camera you just see its end cap, which reads as a pipe
  b.add(box(0.032, 0.055, 0.046, 0.011), 'grip', { p: [0, 0, -0.002], r: [-0.25, 0, 0] });
  // wrist bridge: gripHand's forearm attaches ~4 cm below the grip, a gap the GUN normally hides. Free-floating in
  // open frame that gap made the bracer read as a separate object next to a disembodied fist.
  b.add(box(0.031, 0.052, 0.050, 0.010), 'grip', { p: [0.007, -0.020, 0.017], r: [-0.25, 0, 0] });
  const group = b.build().group;
  group.frustumCulled = false;
  return { group };
}

export function buildGun(archetype, mats, element) {
  const b = new Builder(mats, element);
  const extra = BUILDERS[archetype](b);
  const out = b.build();
  return { ...out, ...extra, archetype };
}

// muzzle flash: 3 crossed petals along the barrel + star disc + white core. Reused for all guns (re-parented to the muzzle marker).
// Kept TIGHT (Destiny reads as a crisp 1-2 frame petal/star, not a bloom blob): ~9 cm petals before per-gun flashScale.
export function makeFlash(mats) {
  const g = new THREE.Group(); g.visible = false;
  const petalGeo = new THREE.PlaneGeometry(0.088, 0.034).translate(0.044, 0, 0); // extends along +X from origin; rotate so it points -Z
  // petals: order ZYX -> Ry(PI/2) maps local +X to -Z (forward), then roll around the barrel axis
  const petals = [0, PI / 2, PI / 4].map((roll) => { const m = new THREE.Mesh(petalGeo, mats.flash.kinetic.petal); m.rotation.order = 'ZYX'; m.rotation.set(0, PI / 2, roll); return m; });
  const [p1, p2, p3] = petals;
  const star = new THREE.Mesh(new THREE.PlaneGeometry(0.055, 0.055), mats.flash.kinetic.star);
  const core = new THREE.Mesh(new THREE.PlaneGeometry(0.022, 0.022), mats.flashCore);
  g.add(p1, p2, p3, star, core);
  for (const m of g.children) m.frustumCulled = false;
  g.userData.petals = [p1, p2, p3]; g.userData.star = star; g.userData.core = core;
  return g;
}
