import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, clamp, lerp, smoothstep } from '../core/Noise.js';
import { InstLOD, patchMaterial, triplanarPatch, fadePatch, mergePatch, noiseTexture, normalFromLuma, tn, tfbm } from './Vegetation.js';

/**
 * Props: hand-placed landmarks (procedural geometry, seeded detail), all colliding:
 *   - Aetheryte at (0,-28): huge faceted floating crystal (rotates/bobs, pulsing emissive, point light) over an ornate octagonal
 *     stone plinth with 3 rotating rune glyph rings, floor glyph, orbiting shards and drifting motes.
 *   - Sundered Spire ruins at (140,60): jagged shattered tower (per-block tinted masonry, assets/tex/ruins_stone.jpg triplanar),
 *     colonnades (intact + broken fluted columns), arches, sunken cracked paving, fallen drums, a broken stair.
 *   - The Hollow Crown: 12 rune-lit monoliths ringing the boss arena (-60,260) + floor glyph + central dais.
 *   - Standing stones on the spawn meadow, rune lanterns (emissive crystal flames + additive ground glow, no point lights).
 *   - Glowing mushrooms clustered at tree bases in the Whisperwood (instanced, LOD, night-boosted emissive + additive ground glow).
 * Exposes: props.aetheryte {group, crystal, light, pos}, props.lights [PointLight], props.landmarks {name -> Vector3}
 */

// ---------------------------------------------------------------- textures
function stoneTexture(aniso, base, tint) {
  return noiseTexture(256, 256, (u, v) => {
    const n = tfbm(u, v, 5, 51, 4), band = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 5 + tn(u, v, 3, 52) * 2.0), grime = smoothstep(-0.1, 0.5, tfbm(u, v, 3, 53, 3));
    const cr = Math.pow(1 - Math.abs(tn(u, v, 11, 54)), 18) * 0.14 * smoothstep(0.0, 0.5, tn(u, v, 2.5, 56)); const sp = tn(u, v, 80, 55) > 0.6 ? 0.08 : 0;
    const t = clamp(0.5 + n * 0.9 + (band - 0.5) * 0.12, 0, 1);
    return base.map((c, i) => clamp(lerp(c, tint[i], t) * (1 - cr) * (1 - grime * 0.22) + sp, 0, 1));
  }, { aniso });
}
/** Ring of rune glyphs on black (additive). band = [inner, outer] fractions of the canvas half-size. */
function glyphTexture(size, rIn, rOut, rng, ticks = true) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size; const c = cv.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, size, size);
  const R = size / 2; const glyphs = [];
  const n = 26, rm = (rIn + rOut) / 2 * R, gh = (rOut - rIn) * R * 0.5;
  for (let i = 0; i < n; i++) { const k = 3 + Math.floor(rng() * 3), pts = []; for (let s = 0; s <= k; s++) pts.push([(rng() - 0.5) * gh * 0.7, -gh * 0.45 + s / k * gh * 0.9]); glyphs.push({ pts, circ: rng() < 0.5 ? [(rng() - 0.5) * gh * 0.4, (rng() - 0.5) * gh * 0.6] : null }); }
  const draw = (blur) => {
    c.save(); c.translate(R, R); c.filter = blur ? `blur(${blur}px)` : 'none'; c.lineCap = 'round'; c.strokeStyle = blur ? 'rgba(190,170,255,0.9)' : '#fff';
    for (const [r, w] of [[rOut * R * 0.985, 3], [rIn * R * 1.02, 2], [(rIn + (rOut - rIn) * 0.72) * R, 1]]) { c.lineWidth = w * (blur ? 2 : 1); c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.stroke(); }
    glyphs.forEach((g, i) => {
      c.save(); c.rotate(i / n * Math.PI * 2); c.translate(rm, 0); c.rotate(Math.PI / 2); c.lineWidth = blur ? 5 : 2.4;
      c.beginPath(); g.pts.forEach(([x, y], j) => j ? c.lineTo(x, y) : c.moveTo(x, y)); c.stroke();
      if (g.circ) { c.beginPath(); c.arc(g.circ[0], g.circ[1], gh * 0.12, 0, Math.PI * 2); c.stroke(); }
      c.restore();
    });
    if (ticks) for (let i = 0; i < n * 4; i++) { c.save(); c.rotate(i / (n * 4) * Math.PI * 2); c.lineWidth = blur ? 3 : 1.5; c.beginPath(); c.moveTo(rOut * R * 0.955, 0); c.lineTo(rOut * R * 0.985, 0); c.stroke(); c.restore(); }
    c.restore();
  };
  draw(4); draw(0);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; return tex;
}
/** Vertical rune column (emissive map for monoliths): black with crisp glyph strokes (hi-res: readable at melee range). */
function runeColumnTexture(rng) {
  const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S; const c = cv.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
  const rows = 9, rh = (S - 40) / rows;
  const draw = (blur) => {
    c.save(); c.filter = blur ? 'blur(9px)' : 'none'; c.strokeStyle = blur ? 'rgba(200,180,255,0.9)' : '#fff'; c.lineCap = 'round'; c.lineWidth = blur ? 16 : 6;
    for (let i = 0; i < rows; i++) { const y0 = 24 + i * rh, k = 3 + Math.floor(rng() * 3); c.beginPath(); for (let s = 0; s <= k; s++) { const x = 224 + (rng() - 0.5) * 92; const y = y0 + s / k * (rh * 0.72); s ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke();
      if (rng() < 0.45) { c.beginPath(); c.arc(256 + (rng() - 0.5) * 52, y0 + rh * 0.36, 13, 0, Math.PI * 2); c.stroke(); }
      if (rng() < 0.35) { c.beginPath(); c.moveTo(206, y0 + rh * 0.7); c.lineTo(306, y0 + rh * 0.7); c.stroke(); } }
    c.lineWidth = blur ? 9 : 3.2; c.beginPath(); c.moveTo(176, 12); c.lineTo(176, 500); c.moveTo(336, 12); c.lineTo(336, 500); c.stroke(); c.restore();
  };
  draw(9); draw(0);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; return tex;
}

// ---------------------------------------------------------------- geometry helpers
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const flat = (g) => { const n = g.index ? g.toNonIndexed() : g; n.deleteAttribute('uv'); n.computeVertexNormals(); return n; }; // faceted stone
/** Merge parts to one non-indexed geometry. tints: per-part [r,g,b] array (or one tint for all) -> vertex colors
 *  (stoneMat has vertexColors on: per-block tint kills the single-beige-albedo read). */
const mergeAll = (list, tints = null) => mergeGeometries(list.map((g, gi) => {
  const n = g.index ? g.toNonIndexed() : g; if (n.attributes.uv) n.deleteAttribute('uv');
  const t = tints ? (Array.isArray(tints[0]) ? tints[gi] : tints) : [1, 1, 1];
  const cnt = n.attributes.position.count, a = new Float32Array(cnt * 3);
  for (let k = 0; k < cnt; k++) { a[k * 3] = t[0]; a[k * 3 + 1] = t[1]; a[k * 3 + 2] = t[2]; }
  n.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return n;
}));
// (the shattered tower is built from individual block courses in _buildRuins — reads as masonry inside and out)
function columnGeometry(h, broken, rng) {
  const shaft = new THREE.CylinderGeometry(0.72, 0.84, h, 16, 4, broken); const p = shaft.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z); if (r < 0.1) continue; const a = Math.atan2(z, x), f = 1 + 0.06 * Math.cos(a * 16); // fluting
    let y = p.getY(i); if (broken && y > h * 0.49) y -= 0.2 + (0.5 + 0.5 * Math.sin(a * 3 + 1.3)) * 1.4 * (0.5 + 0.5 * Math.sin(a * 7)); // ragged top
    p.setXYZ(i, x * f, y, z * f); }
  shaft.translate(0, h / 2 + 0.45, 0);
  const parts = [shaft, new THREE.BoxGeometry(2.0, 0.45, 2.0).translate(0, 0.225, 0), new THREE.CylinderGeometry(1.05, 1.15, 0.25, 16).translate(0, 0.55, 0)];
  if (broken) parts.push(new THREE.CircleGeometry(0.8, 16).rotateX(-Math.PI / 2).translate(0, h * 0.45 + 0.45, 0)); // dark core plug
  else parts.push(new THREE.CylinderGeometry(1.15, 0.85, 0.35, 16).translate(0, h + 0.6, 0), new THREE.BoxGeometry(2.2, 0.4, 2.2).translate(0, h + 0.95, 0));
  return flat(mergeAll(parts));
}
function monolithGeometry(h, rng) {
  // carved silhouette: tapered slab, waist notch, angled crown, beveled corners; jitter is a hash of position so duplicated box verts stay welded
  const g = new THREE.BoxGeometry(3.3, h, 1.9, 3, 7, 3), p = g.attributes.position, ph = rng() * 7;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i); const t = y / h + 0.5;
    const cx = x / 1.65, cz = z / 0.95, corner = Math.pow(Math.abs(cx * cz), 1.6);          // soften the box corners (hewn, not extruded)
    x *= 1 - 0.13 * corner; z *= 1 - 0.13 * corner;
    const notch = Math.exp(-Math.pow((t - 0.68) * 7.0, 2.0)) * 0.22;                       // carved waist band
    x *= (1 - t * 0.34) * (1 - notch); z *= (1 - t * 0.24) * (1 - notch);
    if (t > 0.9) { x *= 0.6; z *= 0.75; y += x * 0.35; }                                   // angled crown
    x += Math.sin(y * 1.7 + ph) * 0.07; z += Math.cos(y * 2.3 + ph) * 0.06;               // hewn wobble
    p.setXYZ(i, x, y, z);
  }
  g.translate(0, h / 2 - 0.6, 0); g.computeVertexNormals(); return g;
}
function menhirGeometry(h, rng) {
  const g = new THREE.BoxGeometry(1.3, h, 0.9, 2, 3, 2).toNonIndexed(), p = g.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) { const k = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`; let d = seen.get(k); if (!d) { d = [(rng() - 0.5) * 0.3, (rng() - 0.5) * 0.25, (rng() - 0.5) * 0.3]; seen.set(k, d); }
    const y = p.getY(i), t = (y / h + 0.5); p.setXYZ(i, (p.getX(i) + d[0]) * (1 - t * 0.3), y + d[1], (p.getZ(i) + d[2]) * (1 - t * 0.3)); }
  g.translate(0, h / 2 - 0.4, 0); g.deleteAttribute('uv'); g.computeVertexNormals(); return g;
}
function bigCrystalGeometry() {
  // hexagonal elongated bipyramid with a mid-band and a slight twist; flat facets
  const rings = [[-4.6, 0], [-2.4, 1.15], [0.5, 1.8], [2.9, 1.15], [5.2, 0]], P = [];
  const pt = (ri, k) => { const [y, r] = rings[ri], a = (k / 6 + ri * 0.06) * Math.PI * 2; return [Math.cos(a) * r, y, Math.sin(a) * r]; };
  for (let ri = 0; ri < rings.length - 1; ri++) for (let k = 0; k < 6; k++) {
    const a = pt(ri, k), b = pt(ri, k + 1), c = pt(ri + 1, k + 1), d = pt(ri + 1, k);
    if (rings[ri][1] > 0) P.push(...a, ...b, ...c); if (rings[ri + 1][1] > 0) P.push(...a, ...c, ...d);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(P), 3)); g.computeVertexNormals(); return g;
}
function mushroomGeometry() {
  const cap = new THREE.LatheGeometry([V3(0, 0.3, 0), V3(0.11, 0.29, 0), V3(0.2, 0.24, 0), V3(0.25, 0.17, 0), V3(0.23, 0.13, 0), V3(0.12, 0.12, 0), V3(0.07, 0.13, 0)].map((v) => new THREE.Vector2(v.x, v.y)), 10);
  const stem = new THREE.CylinderGeometry(0.05, 0.075, 0.16, 7).translate(0, 0.08, 0);
  const col = (g, c, glow) => { const n = g.attributes.position.count, a = new Float32Array(n * 3), gl = new Float32Array(n); for (let i = 0; i < n; i++) { a.set(c, i * 3); gl[i] = glow; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.setAttribute('aGlow', new THREE.BufferAttribute(gl, 1)); return g; };
  col(cap, [0.32, 0.85, 0.88], 1.0); col(stem, [0.75, 0.75, 0.68], 0.12);
  const g = mergeGeometries([cap.toNonIndexed(), stem.toNonIndexed()]); g.computeVertexNormals(); return g;
}

// ---------------------------------------------------------------- the system
export class Props {
  constructor(game) { this.game = game; this.lights = []; this.landmarks = {}; this._rot = []; }

  async init() {
    const { game } = this, { scene, terrain } = game, veg = game.world.vegetation, col = game.world.colliders;
    const aniso = game.renderer.qualityPreset.anisotropy, rng = mulberry32(game.seed + 9001), Q = veg?.Q ?? 1;
    this.U = veg?.uniforms ?? { uTime: { value: 0 }, uSunI: { value: 1 } };
    const h = (x, z) => terrain.heightAt(x, z);
    // ---- materials: props stone = assets/tex/ruins_stone.jpg (sandstone bricks + moss mortar) via triplanar
    const ruinsTex = game.assets?.tex?.('ruins_stone') ?? null; // preloaded (ASSETS.md); sRGB/repeat/aniso already set
    if (!ruinsTex) console.warn('[props] ruins_stone missing, procedural fallback');
    const sand = ruinsTex ?? stoneTexture(aniso, [0.58, 0.52, 0.42], [0.82, 0.77, 0.66]), basalt = stoneTexture(aniso, [0.26, 0.25, 0.3], [0.5, 0.48, 0.55]);
    this.stoneMat = patchMaterial(new THREE.MeshStandardMaterial({ map: sand, vertexColors: true, roughness: 0.9, metalness: 0.02, color: 0xf2ece0 }), mergePatch(triplanarPatch(ruinsTex ? 0.34 : 0.45, 0.55), { key: 'stone' }));
    this.plinthMat = patchMaterial(new THREE.MeshStandardMaterial({ map: sand, roughness: 0.7, metalness: 0.08, color: 0xe8e4f0 }), mergePatch(triplanarPatch(0.5, 0.0), { key: 'plinth' }));
    const runeTex = runeColumnTexture(rng);
    this.monoMat = patchMaterial(new THREE.MeshStandardMaterial({ map: basalt, roughness: 0.8, metalness: 0.05, color: 0xffffff, emissiveMap: runeTex, emissive: 0x6a3cff, emissiveIntensity: 2.8 }),
      mergePatch(triplanarPatch(0.4, 0.2), { key: 'monolith', uniforms: { uTime: this.U.uTime }, fHead: 'uniform float uTime;', fEmissive: 'totalEmissiveRadiance *= 0.72 + 0.28 * sin(uTime * 0.9 + vWPos.x * 0.35 + vWPos.z * 0.21);' }));
    this.glyphMat = (tex, color) => new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });

    this._buildAetheryte(rng, h, col);
    this._buildRuins(rng, h, col);
    this._buildArena(rng, h, col);
    this._buildMeadow(rng, h, col);
    this._buildMushrooms(rng, h, veg, Q);
  }

  _buildAetheryte(rng, h, col) {
    const { scene } = this.game; const X = 0, Z = -28, Y = h(X, Z) - 0.15; this.landmarks.aetheryte = V3(X, Y, Z);
    const g = new THREE.Group(); g.name = 'aetheryte'; g.position.set(X, Y, Z); scene.add(g);
    // plinth: octagonal steps, pedestal, tapered column, cradle, 8 small pillars + rim
    const parts = [new THREE.CylinderGeometry(7.6, 8.2, 0.6, 8).translate(0, 0.05, 0), new THREE.CylinderGeometry(6.4, 6.9, 0.35, 8).translate(0, 0.52, 0), new THREE.CylinderGeometry(5.2, 5.6, 0.4, 8).translate(0, 0.9, 0),
      new THREE.CylinderGeometry(2.3, 2.8, 1.6, 8).translate(0, 1.9, 0), new THREE.CylinderGeometry(1.0, 1.8, 3.0, 8).translate(0, 4.2, 0), new THREE.CylinderGeometry(1.9, 0.9, 0.8, 8).translate(0, 6.1, 0),
      new THREE.TorusGeometry(6.35, 0.12, 6, 48).rotateX(Math.PI / 2).translate(0, 1.12, 0),
      new THREE.TorusGeometry(2.55, 0.14, 6, 32).rotateX(Math.PI / 2).translate(0, 2.72, 0),   // carved pedestal collar
      new THREE.TorusGeometry(1.75, 0.09, 5, 24).rotateX(Math.PI / 2).translate(0, 5.55, 0)];  // column neck ring
    for (let i = 0; i < 8; i++) {
      const a = (i + 0.5) / 8 * Math.PI * 2, x = Math.cos(a) * 5.9, z = Math.sin(a) * 5.9;
      parts.push(new THREE.CylinderGeometry(0.2, 0.26, 2.4, 8).translate(x, 2.3, z), new THREE.BoxGeometry(0.55, 0.2, 0.55).translate(x, 3.6, z), new THREE.OctahedronGeometry(0.22).translate(x, 3.95, z));
      const a2 = i / 8 * Math.PI * 2; parts.push(new THREE.OctahedronGeometry(0.16).translate(Math.cos(a2) * 6.65, 0.85, Math.sin(a2) * 6.65)); // step-edge studs
    }
    const plinth = new THREE.Mesh(flat(mergeAll(parts)), this.plinthMat); plinth.castShadow = plinth.receiveShadow = true; plinth.name = 'aetheryte-plinth'; g.add(plinth);
    // rune plaques on the pedestal (share monoMat program with the arena monoliths — box faces map the rune strip cleanly)
    const plq = []; for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + Math.PI / 4; plq.push(new THREE.BoxGeometry(1.0, 1.5, 0.16).rotateY(-a + Math.PI / 2).translate(Math.cos(a) * 2.45, 1.95, Math.sin(a) * 2.45).toNonIndexed()); }
    const plaques = new THREE.Mesh(mergeGeometries(plq), this.monoMat); plaques.castShadow = false; plaques.receiveShadow = true; plaques.name = 'aetheryte-plaques'; g.add(plaques);
    // colliders: steps walkable, pedestal solid
    col.add({ type: 'box', box: new THREE.Box3(V3(X - 8, Y - 1, Z - 8), V3(X + 8, Y + 0.35, Z + 8)), walkable: true });
    col.add({ type: 'box', box: new THREE.Box3(V3(X - 6.6, Y - 1, Z - 6.6), V3(X + 6.6, Y + 0.7, Z + 6.6)), walkable: true });
    col.add({ type: 'box', box: new THREE.Box3(V3(X - 5.4, Y - 1, Z - 5.4), V3(X + 5.4, Y + 1.1, Z + 5.4)), walkable: true });
    col.add({ type: 'capsule', a: V3(X, Y + 1.0, Z), b: V3(X, Y + 6.5, Z), r: 2.7 });
    for (let i = 0; i < 8; i++) { const a = (i + 0.5) / 8 * Math.PI * 2; col.add({ type: 'capsule', a: V3(X + Math.cos(a) * 5.9, Y + 1, Z + Math.sin(a) * 5.9), b: V3(X + Math.cos(a) * 5.9, Y + 4, Z + Math.sin(a) * 5.9), r: 0.3 }); }
    // the crystal
    const crystalMat = patchMaterial(new THREE.MeshPhysicalMaterial({ color: 0x4a38c8, roughness: 0.18, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.2, emissive: 0x3a1cff, emissiveIntensity: 1.2, flatShading: true }), {
      key: 'aethcrystal', uniforms: { uTime: this.U.uTime }, fHead: 'uniform float uTime; varying vec3 vWPosA;',
      fEmissive: `{ float pulse = 0.8 + 0.2 * sin(uTime * 1.1); vec3 Vd = normalize(vViewPosition); float rim = pow(1.0 - abs(dot(Vd, normal)), 2.0);
        float core = smoothstep(0.9, 0.0, abs(vViewPosition.y) * 0.0 + length(vWPosA.xz) / 2.2);
        totalEmissiveRadiance = totalEmissiveRadiance * pulse * (0.6 + core * 0.9) + vec3(0.5, 0.4, 1.0) * rim * (0.8 + 0.6 * pulse); }`,
      vHead: 'varying vec3 vWPosA;', vBegin: 'vWPosA = position;',
    });
    this.crystalMat = crystalMat;
    const crystal = new THREE.Mesh(bigCrystalGeometry().scale(1.35, 1.35, 1.35), crystalMat); crystal.position.set(0, 13.0, 0); crystal.castShadow = true; crystal.name = 'aetheryte-crystal'; g.add(crystal);
    const shardGeos = []; for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; shardGeos.push(new THREE.OctahedronGeometry(0.35 + rng() * 0.3).scale(1, 1.9, 1).rotateX(rng()).rotateZ(rng()).translate(Math.cos(a) * 4.6, 11.5 + Math.sin(a * 2) * 2.4, Math.sin(a) * 4.6)); }
    const shards = new THREE.Mesh(mergeGeometries(shardGeos.map((g0) => g0.index ? g0.toNonIndexed() : g0)), crystalMat); shards.castShadow = true; g.add(shards);
    // rune rings (additive glyphs), different radii/tilts/speeds
    const rings = [[3.0, 3.8, 9.2, 0.12, 0.28], [4.8, 5.7, 13.0, -0.22, -0.17], [6.4, 7.4, 17.0, 0.1, 0.11]].map(([ri, ro, y, tilt, speed]) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(ri, ro, 72).rotateX(-Math.PI / 2), this.glyphMat(glyphTexture(512, ri / ro, 1, rng), 0x9a80ff)); m.position.y = y; m.rotation.z = tilt; m.userData.speed = speed; m.renderOrder = 2; g.add(m); return m;
    });
    const floorGlyph = new THREE.Mesh(new THREE.RingGeometry(2.9, 5.0, 96).rotateX(-Math.PI / 2), this.glyphMat(glyphTexture(512, 2.9 / 5.0, 1, rng), 0x8878ff)); floorGlyph.position.y = 1.14; floorGlyph.userData.speed = 0.05; g.add(floorGlyph); rings.push(floorGlyph);
    // motes: points orbiting in the vertex shader
    const N = 240, pos = new Float32Array(N * 3); for (let i = 0; i < N; i++) { pos[i * 3] = 2 + rng() * 8; pos[i * 3 + 1] = 2 + rng() * 19; pos[i * 3 + 2] = rng() * Math.PI * 2; }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); pg.boundingSphere = new THREE.Sphere(V3(0, 9, 0), 12);
    const dot = document.createElement('canvas'); dot.width = dot.height = 32; const dc = dot.getContext('2d'); const gr = dc.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(200,190,255,0.5)'); gr.addColorStop(1, 'rgba(150,130,255,0)'); dc.fillStyle = gr; dc.fillRect(0, 0, 32, 32);
    const pm = new THREE.PointsMaterial({ size: 0.22, map: new THREE.CanvasTexture(dot), color: 0xb0a0ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    pm.onBeforeCompile = (sh) => { sh.uniforms.uTime = this.U.uTime; sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace('#include <begin_vertex>',
      `float mr = position.x, mh = position.y, mp = position.z; float ma = mp + uTime * (0.25 + 0.6 / mr);
       vec3 transformed = vec3(cos(ma) * mr, mh + sin(uTime * 0.7 + mp * 3.0) * 0.8, sin(ma) * mr);`); };
    pm.customProgramCacheKey = () => 'motes';
    const motes = new THREE.Points(pg, pm); motes.frustumCulled = false; g.add(motes);
    // light
    const light = new THREE.PointLight(0x7a5cff, 60, 48, 2); light.name = 'props-light'; light.position.set(0, 11, 0); g.add(light); this.lights.push(light);
    this.aetheryte = { group: g, crystal, shards, rings, light, pos: V3(X, Y, Z) };
  }

  _buildRuins(rng, h, col) {
    const { scene } = this.game; const CX = 140, CZ = 60; this.landmarks.ruins = V3(CX, h(CX, CZ), CZ);
    const stat = [], tintA = []; const S = (g, t) => { stat.push(g); tintA.push(t); }; // merged static stone + per-part tint
    const warm = (b, v = 0.08) => { const t = b + rng() * v * 2; return [t * (1 + (rng() - 0.5) * 0.07), t, t * (0.9 + rng() * 0.1)]; };
    // shattered tower: ring wall from staggered block courses, two breaches, ragged random top (no regular teeth)
    const segs = 20, hts = []; const ty = h(CX, CZ), TR = 9.0;
    for (let j = 0; j < segs; j++) { const a = j / segs; let hh = 17 + 9 * Math.sin(a * Math.PI * 2 * 1.7 + 1) + 5 * (rng() - 0.5) + 3 * Math.sin(a * 47 + 2) * rng(); if (a > 0.22 && a < 0.34) hh = 0.1 + rng() * 0.2; /* breach kept below the first block course */ if (a > 0.78 && a < 0.88) hh = 5 + rng() * 2; hts.push(ty + hh); }
    const WR = TR - 0.75;
    let y0 = ty - 1.5;
    for (let ci = 0; ci < 28; ci++) {
      const ch = 1.15 * (0.88 + rng() * 0.28); // varied course heights — breaks the voxel-course read
      for (let j = 0; j < segs; j++) {
        const fa = (j + (ci % 2) * 0.5) / segs, a = fa * Math.PI * 2;
        const hj = lerp(hts[j], hts[(j + 1) % segs], (ci % 2) * 0.5);
        if (y0 - ty + ch * 0.6 > hj - ty) continue;
        if (y0 > ty + 3 && rng() < 0.02 + 0.08 * ci / 28) continue; // more missing blocks toward the ragged top
        const w = 2 * Math.PI * WR / segs * (0.985 + rng() * 0.012), d = 1.5 + rng() * 0.1, rr = WR + (rng() - 0.5) * 0.09;
        S(new THREE.BoxGeometry(w, ch * 1.03, d).rotateY(-a - Math.PI / 2).translate(CX + Math.cos(a) * rr, y0 + ch / 2 + (rng() - 0.5) * 0.05, CZ + Math.sin(a) * rr), warm(0.7, 0.14)); // near-solid courses: joints read via tint + texture, not slits
      }
      y0 += ch;
    }
    S(new THREE.CylinderGeometry(TR + 0.4, TR + 0.4, 0.5, 20).translate(CX, ty - 0.05, CZ), [0.62, 0.6, 0.57]); // floor slab, darker
    // interior: sunken cracked paving, broken ring-ledge remnants, rubble spilling from the breach, fallen drums
    for (let gx = -7; gx <= 7; gx += 1.9) for (let gz = -7; gz <= 7; gz += 1.9) {
      const r = Math.hypot(gx, gz); if (r > 7.3 || rng() < 0.4) continue;
      S(new THREE.BoxGeometry(1.3 + rng() * 0.8, 0.14, 1.3 + rng() * 0.8).rotateY((rng() - 0.5) * 0.7).translate(CX + gx + (rng() - 0.5) * 0.5, ty + 0.2 + rng() * 0.06, CZ + gz + (rng() - 0.5) * 0.5), warm(0.5, 0.12));
    }
    for (const [st, ln, yy] of [[0.48, 0.2, 7.1], [1.05, 0.14, 10.3], [1.62, 0.24, 5.0]])
      S(new THREE.TorusGeometry(TR - 1.7, 0.5, 5, 22, ln * Math.PI * 2).rotateX(-Math.PI / 2).rotateY(st * Math.PI).translate(CX, ty + yy, CZ), warm(0.78));
    { const ba = 0.28 * Math.PI * 2;
      for (let i = 0; i < 16; i++) { const rr2 = 2 + rng() * 5.5, aa = ba + (rng() - 0.5) * 1.1, x = CX + Math.cos(aa) * rr2, z = CZ + Math.sin(aa) * rr2, s = 0.4 + rng() * 0.9;
        S(new THREE.BoxGeometry(s, s * 0.7, s * 0.85).rotateY(rng() * 3).rotateX((rng() - 0.5) * 0.6).translate(x, ty + s * 0.24, z), warm(0.68, 0.12)); }
      col.add({ type: 'sphere', pos: V3(CX + Math.cos(ba) * 4, ty + 0.2, CZ + Math.sin(ba) * 4), r: 1.5 });
    }
    for (let i = 0; i < 3; i++) { const aa = 4.2 + i * 0.8, rr2 = 4.5 + rng() * 2, x = CX + Math.cos(aa) * rr2, z = CZ + Math.sin(aa) * rr2;
      S(new THREE.CylinderGeometry(0.7, 0.7, 1.4 + rng() * 0.6, 14).rotateZ(Math.PI / 2).rotateY(rng() * Math.PI).translate(x, ty + 0.65, z), warm(0.9));
      col.add({ type: 'sphere', pos: V3(x, ty + 0.6, z), r: 0.95 }); }
    for (let k = 0; k < 6; k++) { const a = (k + 0.5) / 6 * Math.PI * 2; if (a / (Math.PI * 2) > 0.2 && a / (Math.PI * 2) < 0.36) continue; S(new THREE.BoxGeometry(1.6, 6 + rng() * 3, 2.2).translate(0, 2.5, TR + 0.6).rotateY(-a + Math.PI / 2).translate(CX, ty, CZ), [0.58, 0.59, 0.63]); } // buttresses: cooler grey — material separation
    for (let j = 0; j < segs; j++) { if (hts[j] - ty < 2) continue; const a = (j + 0.5) / segs * Math.PI * 2, x = CX + Math.cos(a) * (TR - 0.75), z = CZ + Math.sin(a) * (TR - 0.75); col.add({ type: 'capsule', a: V3(x, ty - 1, z), b: V3(x, hts[j], z), r: 1.6 }); } // wall ring; the breach is open
    // colonnades: outer ring r 26 (16), inner ring r 13 (8); intact vs broken; arches between intact neighbours (outer ring)
    const intactG = columnGeometry(8.4, false, rng), brokenG = columnGeometry(8.4, true, rng);
    const colsI = [], colsB = [], ringInfo = [];
    const M = new THREE.Matrix4(), Qt = new THREE.Quaternion(), Sv = V3(1, 1, 1), E = new THREE.Euler();
    for (const [R, n] of [[26, 16], [13, 8]]) for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + (R === 13 ? Math.PI / 8 : 0), x = CX + Math.cos(a) * R, z = CZ + Math.sin(a) * R; if (rng() < 0.12) { ringInfo.push(null); continue; } // missing column
      const y = h(x, z) - 0.25, intact = rng() < 0.45, sy = intact ? 1 : 0.25 + rng() * 0.6;
      E.set(0, rng() * Math.PI * 2, 0); Qt.setFromEuler(E); Sv.set(1, sy, 1); M.compose(V3(x, y, z), Qt, Sv); (intact ? colsI : colsB).push(M.clone());
      ringInfo.push({ x, z, y, intact, a, R });
      col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + (intact ? 9.6 : 8.4 * sy + 0.5), z), r: 1.0 });
    }
    const IC = new THREE.Color();
    const mkInst = (geo, mats, name) => { const m = new THREE.InstancedMesh(geo, this.stoneMat, Math.max(1, mats.length)); mats.forEach((mm, i) => { m.setMatrixAt(i, mm); const c = 0.85 + rng() * 0.22; m.setColorAt(i, IC.setRGB(c * 1.04, c, c * 0.9)); }); m.count = mats.length; m.castShadow = m.receiveShadow = true; m.name = name; scene.add(m); return m; };
    mkInst(intactG, colsI, 'ruins-columns'); mkInst(brokenG, colsB, 'ruins-columns-broken');
    for (let i = 0; i < 16; i++) { const a = ringInfo[i], b = ringInfo[(i + 1) % 16]; if (!a || !b || !a.intact || !b.intact || a.R !== 26 || b.R !== 26) continue;
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, d = Math.hypot(b.x - a.x, b.z - a.z), yaw = -Math.atan2(b.z - a.z, b.x - a.x), y = Math.max(a.y, b.y) + 9.3;
      S(new THREE.TorusGeometry(d / 2 - 0.5, 0.55, 8, 28, Math.PI).rotateY(yaw).translate(mx, y, mz), warm(0.95)); }
    // outer paving: irregular sunken slabs — ancient broken floor, not a bathroom-tile grid
    for (let gx = -22; gx <= 22; gx += 2.1) for (let gz = -22; gz <= 22; gz += 2.1) { const r = Math.hypot(gx, gz); if (r > 22 || r < 8 || rng() < 0.42 + smoothstep(14, 22, r) * 0.5) continue;
      const x = CX + gx + (rng() - 0.5) * 0.6, z = CZ + gz + (rng() - 0.5) * 0.6, y = h(x, z);
      S(new THREE.BoxGeometry(1.2 + rng() * 1.3, 0.2, 1.2 + rng() * 1.3).rotateY((rng() - 0.5) * 0.5).rotateX((rng() - 0.5) * 0.07).rotateZ((rng() - 0.5) * 0.07).translate(x, y - 0.04 + rng() * 0.08, z), warm(0.52, 0.13)); }
    for (let i = 0; i < 12; i++) { const a = rng() * Math.PI * 2, r = 9 + rng() * 22, x = CX + Math.cos(a) * r, z = CZ + Math.sin(a) * r, yaw = rng() * Math.PI;
      S(new THREE.CylinderGeometry(0.7, 0.7, 1.6 + rng() * 0.8, 14).rotateZ(Math.PI / 2).rotateY(yaw).translate(x, h(x, z) + 0.45, z), warm(0.88)); col.add({ type: 'sphere', pos: V3(x, h(x, z) + 0.4, z), r: 0.95 }); }
    { const sx = CX - 14, sz = CZ + 18, sy = h(sx, sz); for (let i = 0; i < 8; i++) { const g = new THREE.BoxGeometry(3.2, 0.32, 0.55).translate(sx, sy + 0.16 + i * 0.32, sz - i * 0.5); S(g, warm(0.75)); col.add({ type: 'box', box: new THREE.Box3(V3(sx - 1.6, sy - 1, sz - i * 0.5 - 0.28), V3(sx + 1.6, sy + 0.32 + i * 0.32, sz - i * 0.5 + 0.28)), walkable: true }); }
      S(new THREE.BoxGeometry(0.5, 2.6, 4.2).translate(sx - 1.85, sy + 1.0, sz - 1.75), warm(0.72)); S(new THREE.BoxGeometry(0.5, 2.2, 3.6).translate(sx + 1.85, sy + 0.8, sz - 1.45), warm(0.72)); }
    const ruins = new THREE.Mesh(flat(mergeAll(stat, tintA)), this.stoneMat); ruins.castShadow = ruins.receiveShadow = true; ruins.name = 'ruins-stone'; scene.add(ruins);
  }

  _buildArena(rng, h, col) {
    const { scene } = this.game; const CX = -60, CZ = 260; this.landmarks.arena = V3(CX, h(CX, CZ), CZ);
    const parts = [];
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2, x = CX + Math.cos(a) * 43, z = CZ + Math.sin(a) * 43, y = h(x, z);
      const broken = i % 5 === 2, hh = broken ? 4.5 + rng() * 1.5 : 13 + rng() * 4;        // towering ring with a couple of shattered stubs
      parts.push(monolithGeometry(hh, rng).rotateX((rng() - 0.5) * (broken ? 0.3 : 0.1)).rotateY(-a + Math.PI / 2 + (rng() - 0.5) * 0.2).translate(x, y, z));
      col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: 1.55 });
      // low rune-stone between each pair of monoliths — density without extra draws
      const am = (i + 0.5) / 12 * Math.PI * 2, mx = CX + Math.cos(am) * 44.5, mz = CZ + Math.sin(am) * 44.5, my = h(mx, mz);
      parts.push(monolithGeometry(2.2 + rng() * 1.2, rng).rotateX((rng() - 0.5) * 0.35).rotateY(rng() * 6.28).translate(mx, my, mz));
      col.add({ type: 'sphere', pos: V3(mx, my + 0.8, mz), r: 1.1 }); }
    const mono = new THREE.Mesh(mergeGeometries(parts), this.monoMat); mono.castShadow = mono.receiveShadow = true; mono.name = 'arena-monoliths'; scene.add(mono);
    // central cracked dais + floor glyph
    const cy = h(CX, CZ); const dais = new THREE.Mesh(flat(mergeAll([new THREE.CylinderGeometry(5.5, 6.0, 0.5, 12).translate(CX, cy + 0.1, CZ), new THREE.CylinderGeometry(3.5, 4.0, 0.4, 12).translate(CX, cy + 0.5, CZ)], [0.72, 0.7, 0.66])), this.stoneMat);
    dais.castShadow = dais.receiveShadow = true; dais.name = 'arena-dais'; scene.add(dais);
    col.add({ type: 'box', box: new THREE.Box3(V3(CX - 6, cy - 1, CZ - 6), V3(CX + 6, cy + 0.35, CZ + 6)), walkable: true });
    col.add({ type: 'box', box: new THREE.Box3(V3(CX - 4, cy - 1, CZ - 4), V3(CX + 4, cy + 0.7, CZ + 4)), walkable: true });
    const glyph = new THREE.Mesh(new THREE.RingGeometry(7, 12, 128).rotateX(-Math.PI / 2), this.glyphMat(glyphTexture(512, 7 / 12, 1, rng), new THREE.Color(0.95, 0.68, 2.4))); glyph.name = 'arena-glyph'; glyph.position.set(CX, cy + 0.16, CZ); glyph.userData.speed = -0.04; this._rot.push(glyph); scene.add(glyph); // HDR color: additive ring stays readable at noon
  }

  _buildMeadow(rng, h, col) {
    const { scene } = this.game; const parts = [], tints = []; const U = this.U;
    const P = (g, t) => { parts.push(g); tints.push(t); };
    // standing stones around the spawn meadow (keep the north path to the aetheryte clear)
    for (let i = 0; i < 7; i++) { const a = (i + 0.5) / 7 * Math.PI * 2 + 0.4, r = 42 + rng() * 40, x = Math.cos(a) * r, z = Math.sin(a) * r; if (Math.abs(x) < 12 && z < 0) continue; const hh = 2.4 + rng() * 1.8, y = h(x, z);
      const t0 = 0.78 + rng() * 0.2;
      P(menhirGeometry(hh, rng).rotateZ((rng() - 0.5) * 0.16).rotateY(rng() * Math.PI * 2).translate(x, y, z), [t0, t0, t0 * 1.04]); col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 0.6, z), r: 0.75 }); }
    // rune lanterns lining the spawn path to the Aetheryte: hex cage on a tapered post, crystal-flame inside
    const flames = [];
    for (const [x, z] of [[-3.6, -8], [3.6, -8], [-3.8, -17], [3.8, -17], [-4.2, 6], [4.2, 6]]) {
      const y = h(x, z) - 0.05;
      for (const g of [
        new THREE.CylinderGeometry(0.3, 0.44, 0.22, 6).translate(x, y + 0.11, z),
        new THREE.CylinderGeometry(0.07, 0.12, 1.5, 6).translate(x, y + 0.95, z),
        new THREE.TorusGeometry(0.11, 0.035, 5, 10).rotateX(Math.PI / 2).translate(x, y + 1.64, z),
        new THREE.CylinderGeometry(0.3, 0.22, 0.07, 6).translate(x, y + 1.72, z),
        new THREE.CylinderGeometry(0.35, 0.3, 0.06, 6).translate(x, y + 2.21, z),
        new THREE.ConeGeometry(0.35, 0.36, 6).translate(x, y + 2.42, z),
        new THREE.OctahedronGeometry(0.08).translate(x, y + 2.68, z)]) P(g, [0.95, 0.92, 0.86]);
      for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; P(new THREE.BoxGeometry(0.035, 0.48, 0.035).translate(x + Math.cos(a) * 0.3, y + 1.97, z + Math.sin(a) * 0.3), [0.95, 0.92, 0.86]); }
      flames.push(V3(x, y + 1.97, z)); col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + 2.4, z), r: 0.32 });
    }
    const stones = new THREE.Mesh(flat(mergeAll(parts, tints)), this.stoneMat); stones.castShadow = stones.receiveShadow = true; stones.name = 'meadow-stones'; scene.add(stones);
    // user decree: 4.0 on a 0.1 m flickering octahedron = sub-pixel warm blobs at distance (blobcheck-gated).
    // 1.4 keeps the flame reading and its night halo (night bloom threshold 0.28) without daytime white balls.
    const flameMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffd090, emissive: 0xff9a40, emissiveIntensity: 1.4, roughness: 0.6 }), { key: 'flame', uniforms: { uTime: U.uTime }, fHead: 'uniform float uTime; varying float vPh;', vHead: 'varying float vPh;', vBegin: 'vPh = fract(instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21);',
      fEmissive: 'totalEmissiveRadiance *= 0.8 + 0.2 * sin(uTime * 9.0 + vPh * 6.28) * sin(uTime * 4.3 + vPh * 9.0);' });
    const fl = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.1).scale(1, 1.7, 1), flameMat, flames.length); flames.forEach((p, i) => fl.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z))); fl.name = 'lantern-flames'; scene.add(fl);
    // warm ground-glow decals instead of point lights (bloom + emissive carry the look; zero lighting cost, no recompile storms)
    const glowTex = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c2 = cv.getContext('2d');
      const gr = c2.createRadialGradient(32, 32, 2, 32, 32, 32); gr.addColorStop(0, 'rgba(255,175,90,0.6)'); gr.addColorStop(0.5, 'rgba(255,140,60,0.22)'); gr.addColorStop(1, 'rgba(255,120,40,0)');
      c2.fillStyle = gr; c2.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();
    const glows = new THREE.Mesh(mergeGeometries(flames.map((p) => new THREE.CircleGeometry(1.7, 18).rotateX(-Math.PI / 2).translate(p.x, p.y - 1.9, p.z).toNonIndexed())), this.glyphMat(glowTex, 0xffc080));
    glows.name = 'lantern-glow'; glows.renderOrder = 1; scene.add(glows);
  }

  _buildMushrooms(rng, h, veg, Q) {
    const { scene } = this.game, U = this.U;
    const mat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, emissive: 0x30ffd8, emissiveIntensity: 2.2 }), mergePatch(fadePatch, {
      key: 'mushroom', uniforms: { uTime: U.uTime, uSunI: U.uSunI ?? { value: 1 } }, vHead: 'attribute float aGlow; varying float vGlow; varying float vPh;', vBegin: 'vGlow = aGlow; vPh = fract(instanceMatrix[3].x * 0.17 + instanceMatrix[3].z * 0.29);',
      fHead: 'uniform float uTime; uniform float uSunI; varying float vGlow; varying float vPh;',
      fEmissive: 'totalEmissiveRadiance *= vGlow * (0.75 + 0.25 * sin(uTime * 1.7 + vPh * 6.28)) * (0.55 + 1.7 * (1.0 - clamp(uSunI, 0.0, 1.0)));', // night-boosted: real glow after dark
    }));
    const mesh = new THREE.InstancedMesh(mushroomGeometry(), mat, 1); mesh.receiveShadow = true; mesh.name = 'mushrooms'; scene.add(mesh);
    const lod = new InstLOD({ near: [mesh], nearDist: 52 * Q, band: 10, color: true });
    const M = new THREE.Matrix4(), Qt = new THREE.Quaternion(), S = V3(1, 1, 1), E = new THREE.Euler(), C = new THREE.Color();
    const glowPts = [];
    const add = (x, z, s) => { const y = h(x, z); E.set((rng() - 0.5) * 0.3, rng() * 6.28, (rng() - 0.5) * 0.3); Qt.setFromEuler(E); S.setScalar(s); M.compose(V3(x, y - 0.02, z), Qt, S); const hue = rng(); C.setRGB(0.8 + hue * 0.3, 1.0, 0.9 + (1 - hue) * 0.2); lod.add(M, C);
      if (s > 0.75 && glowPts.length < 450 && rng() < 0.6) glowPts.push([x, y + 0.06, z, 0.7 + s * 0.9]); };
    for (const t of veg?.trees ?? []) { if (t.z > -175 || Math.abs(t.x) > 260 || rng() < 0.45) continue; const n = 1 + Math.floor(rng() * 4); for (let i = 0; i < n; i++) { const a = rng() * 6.28, d = t.r + 0.3 + rng() * 1.4; add(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, 0.5 + rng() * 1.3); } }
    for (let i = 0; i < 700; i++) { const x = (rng() - 0.5) * 500, z = -190 - rng() * 230; if (Math.hypot(x, z + 28) < 10) continue; const n = 1 + Math.floor(rng() * 3); for (let k = 0; k < n; k++) add(x + (rng() - 0.5) * 2, z + (rng() - 0.5) * 2, 0.4 + rng() * 1.0); }
    lod.finalize(); (veg?.lods ?? (this._ownLods = [])).push(lod); this.mushroomCount = lod.n;
    // additive cyan ground-glow pools under the bigger mushrooms (bloom halo + light-pool read at night; 1 draw call)
    if (glowPts.length) {
      const gt = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c2 = cv.getContext('2d');
        const gr = c2.createRadialGradient(32, 32, 1, 32, 32, 32); gr.addColorStop(0, 'rgba(120,255,230,0.65)'); gr.addColorStop(0.45, 'rgba(60,220,200,0.25)'); gr.addColorStop(1, 'rgba(40,200,190,0)');
        c2.fillStyle = gr; c2.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();
      const mg = new THREE.Mesh(mergeGeometries(glowPts.map(([x, y, z, r]) => new THREE.CircleGeometry(r, 14).rotateX(-Math.PI / 2).translate(x, y, z).toNonIndexed())), this.glyphMat(gt, 0x70ffe0));
      mg.name = 'mushroom-glow'; mg.renderOrder = 1; scene.add(mg); this.mushGlow = mg;
    }
  }

  update(dt, t) {
    const A = this.aetheryte; if (!A) return;
    A.crystal.rotation.y += dt * 0.12; A.crystal.position.y = 13.0 + Math.sin(t * 0.6) * 0.4; A.shards.rotation.y -= dt * 0.3; A.shards.position.y = Math.sin(t * 0.9 + 1) * 0.3;
    for (const r of A.rings) r.rotation.y += dt * r.userData.speed;
    for (const r of this._rot) r.rotation.y += dt * r.userData.speed;
    const dcam = this.game.camera.position.distanceTo(A.group.position);
    A.light.intensity = (55 + 12 * Math.sin(t * 1.1)) * clamp(1 - (dcam - 55) / 25, 0, 1); // distance-fade the only point light (radius 48; keeps the shader program stable)
    if (this.mushGlow) this.mushGlow.material.opacity = clamp(1.15 - (this.game.sky?.sunIntensity ?? 1), 0.06, 0.85); // glow pools live at night, near-off at noon
    if (!this.game.world.vegetation?.lods && this._ownLods) { const p = this.game.camera.position; for (const l of this._ownLods) l.refresh(p.x, p.z); }
    if (!this.game.world.vegetation) this.U.uTime.value = t;
  }
}
