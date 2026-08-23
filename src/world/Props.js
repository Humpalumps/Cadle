import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, clamp, lerp, smoothstep } from '../core/Noise.js';
import { InstLOD, patchMaterial, triplanarPatch, fadePatch, mergePatch, noiseTexture, normalFromLuma, makeRockGeometry, tn, tfbm } from './Vegetation.js';
import { OUTER, THETA0, STEP } from './Biomes.js';

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
// per-landmark sigil colour (linear HDR: additive rings must read at noon without tone-mapping to white,
// so the HUE is saturated and only one channel goes above 1)
const LANDMARK_STONE = {
  forest:    { glyph: [0.35, 1.9, 0.75], mat: 'stone' },
  tundra:    { glyph: [0.62, 1.35, 2.3], mat: 'ice' },
  celestial: { glyph: [2.3, 1.55, 0.55], mat: 'stone' },
  dragon:    { glyph: [2.1, 1.0, 0.35],  mat: 'stone' },
  infernal:  { glyph: [2.4, 0.55, 0.12], mat: 'basalt' },
  lost:      { glyph: [1.35, 0.75, 2.4], mat: 'stone' },
  shadowfen: { glyph: [0.55, 1.9, 0.5],  mat: 'basalt' },
  sunken:    { glyph: [0.45, 1.5, 1.9],  mat: 'stone' },
  void:      { glyph: [1.1, 0.4, 2.4],   mat: 'basalt' },
};
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
    // Landmark stone. Nine hero props sharing ONE sandstone material read as nine sandstone props with
    // different tints — the Glacier Throne was blue sandstone. Three materials is enough to cover the
    // range that matters (warm stone, ice, basalt) and costs two extra draw calls for the whole world.
    this.iceMat = patchMaterial(new THREE.MeshStandardMaterial({ map: sand, vertexColors: true, roughness: 0.34, metalness: 0.0, color: 0xdfeeff }), mergePatch(triplanarPatch(0.5, 0.35), { key: 'ice-stone' }));
    this.basaltMat = patchMaterial(new THREE.MeshStandardMaterial({ map: basalt, vertexColors: true, roughness: 0.95, metalness: 0.02, color: 0x8e8a96 }), mergePatch(triplanarPatch(0.42, 0.5), { key: 'basalt-stone' }));
    this.plinthMat = patchMaterial(new THREE.MeshStandardMaterial({ map: sand, roughness: 0.7, metalness: 0.08, color: 0xe8e4f0 }), mergePatch(triplanarPatch(0.5, 0.0), { key: 'plinth' }));
    const runeTex = runeColumnTexture(rng);
    this.monoMat = patchMaterial(new THREE.MeshStandardMaterial({ map: basalt, roughness: 0.8, metalness: 0.05, color: 0xffffff, emissiveMap: runeTex, emissive: 0x6a3cff, emissiveIntensity: 2.8 }),
      mergePatch(triplanarPatch(0.4, 0.2), { key: 'monolith', uniforms: { uTime: this.U.uTime }, fHead: 'uniform float uTime;', fEmissive: 'totalEmissiveRadiance *= 0.72 + 0.28 * sin(uTime * 0.9 + vWPos.x * 0.35 + vWPos.z * 0.21);' }));
    this.glyphMat = (tex, color) => new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });

    // A frame between each landmark build. Nine of these ran back to back and the set was one of the
    // longest blocks on the loading screen; the intro cannot paint through any of it.
    this._buildAetheryte(rng, h, col);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildRuins(rng, h, col);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildArena(rng, h, col);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildMeadow(rng, h, col);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildMushrooms(rng, h, veg, Q);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildBiomeLandmarks(rng, h, col);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildVillage(rng, h, col);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildBorderStones(rng, h, col);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildBiomeClutter(rng, h, col);
  }


  /**
   * BIOME CLUTTER — what each region GROWS, as opposed to what it is tinted.
   *
   * The nine regions used to be furnished out of exactly two props: a tree and a crystal cluster, re-tinted.
   * That is why the Isles, the Peaks, the Wastes and the Sunken Kingdom all read as the same field with a
   * different filter on it. A place is its furniture: marble drums and gilded arch fragments say ruined
   * temple, a ribcage in scorched rock says something enormous died here, a basalt vent breathing ash says
   * volcano. So each region gets its OWN kit, and trees/crystals were pulled back to the four regions where
   * they are the honest answer (Vegetation.BTREE / BSPIRE).
   *
   * Cost: everything is procedural boxes/cylinders/cones/rock-blobs merged into ONE mesh per region per
   * material — 2 draw calls for a region's entire furniture, each with a tight bounding sphere so the other
   * eight regions frustum-cull instead of riding along in every frame (which is what one world-spanning
   * merged mesh would do). Colliders go on the things you could walk into, not on reeds and rubble.
   */
  _buildBiomeClutter(rng, h, col) {
    const { scene } = this.game, terrain = this.game.terrain;
    const WL = terrain.waterLevel ?? 4;
    const cyl = (rt, rb, ht, seg = 7) => new THREE.CylinderGeometry(rt, rb, ht, seg);
    const box = (w, ht, d) => new THREE.BoxGeometry(w, ht, d);
    const cone = (r, ht, seg = 7) => new THREE.ConeGeometry(r, ht, seg);
    const rock = (kind) => makeRockGeometry(kind, (rng() * 1e6) | 0);

    // one recipe per region: { mat, n, tint, place(x, y, z, out) }. `out(geometry, tintOverride)` collects.
    // `n` is how many ATTEMPTS are made across the region disc; terrain rejects thin that out.
    const KIT = {
      celestial: { mat: 'stone', n: 260, tint: [1.10, 1.06, 0.94], build: (x, y, z, P) => {
        const k = rng();
        if (k < 0.42) {                                                    // fallen column drums, half-buried
          const drums = 1 + ((rng() * 3) | 0), a = rng() * Math.PI * 2;
          for (let i = 0; i < drums; i++) P(cyl(0.62, 0.66, 1.5 + rng() * 0.7, 12).rotateZ(Math.PI / 2).rotateY(a + (rng() - 0.5) * 0.4)
            .translate(x + Math.cos(a) * i * 1.7, y + 0.5, z + Math.sin(a) * i * 1.7));
        } else if (k < 0.78) {                                             // a stub still standing on its plinth
          const hh = 2.2 + rng() * 3.4;
          P(box(2.0, 0.4, 2.0).translate(x, y + 0.2, z));
          P(columnGeometry(hh, true, rng).translate(x, y + 0.4, z));
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh, z), r: 1.0 });
        } else if (k < 0.92) {                                             // arch fragment: two jambs and a broken span
          const w = 2.6 + rng() * 1.4, hh = 3.0 + rng() * 1.6, a = rng() * Math.PI;
          const ca = Math.cos(a), sa = Math.sin(a);
          for (const sd of [-1, 1]) P(box(0.7, hh, 0.7).translate(x + ca * sd * w * 0.5, y + hh / 2, z + sa * sd * w * 0.5));
          P(box(w * 0.8, 0.6, 0.7).rotateY(-a).rotateZ(0.12).translate(x, y + hh + 0.2, z));
        } else {                                                           // a gilded standard: the GOLD the Isles are described by and never had on the ground
          const hh = 3.4 + rng() * 2.2;
          P(cyl(0.16, 0.22, hh, 8).translate(x, y + hh / 2, z), [1.14, 0.86, 0.34]);
          P(new THREE.TorusGeometry(0.85, 0.09, 6, 20).rotateX(Math.PI / 2).translate(x, y + hh - 0.2, z), [1.18, 0.90, 0.36]);
          for (let i = 0; i < 4; i++) P(new THREE.OctahedronGeometry(0.20).translate(x + Math.cos(i * 1.5708) * 0.85, y + hh - 0.2, z + Math.sin(i * 1.5708) * 0.85), [1.16, 0.88, 0.34]);
          P(box(1.5, 0.35, 1.5).translate(x, y + 0.17, z), [1.08, 1.04, 0.92]);
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh, z), r: 0.5 });
        }
      } },
      dragon: { mat: 'basalt', n: 210, tint: [0.86, 0.84, 0.80], build: (x, y, z, P) => {
        const kd = rng();
        if (kd < 0.24) {                                                   // dwarven ore working: a gold seam cut open, with the spoil under it
          const a = rng() * Math.PI, ca = Math.cos(a), sa = Math.sin(a), seg = 2 + ((rng() * 3) | 0);
          for (let i = 0; i < seg; i++) {
            const t = (i - seg / 2) * 1.1;
            P(box(1.0 + rng() * 0.6, 0.26, 0.34).rotateY(a).rotateZ(0.18 + (rng() - 0.5) * 0.3)
              .translate(x + ca * t, y + 0.5 + i * 0.26 + rng() * 0.6, z + sa * t), [1.10, 0.80, 0.24]);   // gold: saturated hue, ordinary value — it catches the sun, it does not bloom
          }
          for (let i = 0; i < 3; i++) { const g = rock(2); const sc = 0.3 + rng() * 0.5; g.scale(sc, sc * 0.6, sc); g.translate(x + (rng() - 0.5) * 2.4, y + 0.1, z + (rng() - 0.5) * 2.4); P(g, [0.58, 0.54, 0.50]); }
          return;
        }
        if (kd < 0.36) {                                                   // a nest: a bowl of splintered wood with eggs still in it
          const cnt = 11;
          for (let i = 0; i < cnt; i++) {
            const a = (i / cnt) * 6.2832;
            P(cyl(0.09, 0.13, 1.5, 4).rotateZ(1.05).rotateY(a).translate(x + Math.cos(a) * 1.5, y + 0.32, z + Math.sin(a) * 1.5), [0.36, 0.30, 0.24]);
          }
          for (let i = 0; i < 3; i++) {
            const a = rng() * 6.2832, d = rng() * 0.7;
            P(new THREE.SphereGeometry(0.42, 10, 8).scale(0.78, 1.0, 0.78).rotateZ((rng() - 0.5) * 0.5)
              .translate(x + Math.cos(a) * d, y + 0.42, z + Math.sin(a) * d), [0.72, 0.66, 0.54]);
          }
          col.add({ type: 'sphere', pos: V3(x, y + 0.4, z), r: 1.8 });
          return;
        }
        if (rng() < 0.34) {                                                // ribcage: a spine and its ribs, picked clean
          const a = rng() * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), ribs = 4 + ((rng() * 4) | 0);
          P(cyl(0.16, 0.2, ribs * 1.25, 6).rotateZ(Math.PI / 2).rotateY(a).translate(x, y + 0.35, z), [0.92, 0.90, 0.82]);
          for (let i = 0; i < ribs; i++) {
            const t = (i - ribs / 2) * 1.25, rh = 1.5 + Math.cos((i / ribs - 0.5) * 2.6) * 1.1;
            for (const sd of [-1, 1]) P(cyl(0.09, 0.13, rh, 5).rotateZ(sd * 0.55).rotateY(a)
              .translate(x + ca * t - sa * sd * rh * 0.26, y + 0.3 + rh * 0.44, z + sa * t + ca * sd * rh * 0.26), [0.94, 0.92, 0.84]);
          }
        } else {                                                            // scorched rock fangs off the ledges
          const hh = 1.6 + rng() * 3.2, g = rock(3);
          g.scale(0.5 + rng() * 0.4, hh * 0.5, 0.5 + rng() * 0.4); g.translate(x, y + hh * 0.35, z);
          P(g, [0.62 + rng() * 0.2, 0.60, 0.60]);
          col.add({ type: 'sphere', pos: V3(x, y + hh * 0.4, z), r: 1.1 });
        }
      } },
      infernal: { mat: 'basalt', n: 230, tint: [0.26, 0.23, 0.23], build: (x, y, z, P) => {
        const k = rng();
        if (k < 0.45) {                                                     // vent: a cinder cone with a throat
          const r = 1.4 + rng() * 1.8, hh = 1.1 + rng() * 1.7;
          P(cone(r, hh, 9).translate(x, y + hh / 2, z), [0.26, 0.22, 0.22]);
          P(cyl(r * 0.3, r * 0.34, 0.5, 8).translate(x, y + hh - 0.1, z), [0.60, 0.24, 0.10]);   // hot throat: hue, never a bloom-capable value
          col.add({ type: 'sphere', pos: V3(x, y + hh * 0.5, z), r: r * 0.8 });
        } else if (k < 0.8) {                                               // basalt columns, hexagonal, in clumps
          const cnt = 2 + ((rng() * 4) | 0), a0 = rng() * Math.PI * 2;
          for (let i = 0; i < cnt; i++) {
            const a = a0 + i * 1.9, d = 0.7 + rng() * 1.5, hh = 1.4 + rng() * 3.4;
            P(cyl(0.55, 0.62, hh, 6).rotateY(rng()).translate(x + Math.cos(a) * d, y + hh / 2 - 0.3, z + Math.sin(a) * d), [0.30, 0.27, 0.29]);
          }
          col.add({ type: 'sphere', pos: V3(x, y + 1.4, z), r: 2.4 });
        } else {                                                            // ash drift
          const g = rock(2); g.scale(2.2 + rng() * 2.2, 0.5 + rng() * 0.5, 2.0 + rng() * 2.0); g.translate(x, y + 0.1, z);
          P(g, [0.24, 0.22, 0.23]);
        }
      } },
      shadowfen: { mat: 'stone', n: 300, tint: [0.52, 0.60, 0.40], build: (x, y, z, P) => {
        const ks = rng();
        if (ks < 0.20) {                                                    // a drowned snag hung with moss: the fen's vertical, and what makes it feel roofed
          const hh = 3.0 + rng() * 3.4, a = rng() * 6.2832;
          P(cyl(0.14, 0.30, hh, 6).rotateZ((rng() - 0.5) * 0.30).rotateY(a).translate(x, y + hh / 2 - 0.2, z), [0.24, 0.23, 0.19]);
          const drapes = 3 + ((rng() * 4) | 0);
          for (let i = 0; i < drapes; i++) {                                // hanging moss: thin ragged sheets off the limbs
            const da = rng() * 6.2832, dd = 0.35 + rng() * 0.9, dl = 0.9 + rng() * 1.8;
            P(box(0.05, dl, 0.34 + rng() * 0.3).rotateY(da).translate(x + Math.cos(da) * dd, y + hh * (0.55 + rng() * 0.35) - dl * 0.5, z + Math.sin(da) * dd),
              [0.30 + rng() * 0.10, 0.40 + rng() * 0.12, 0.22]);
          }
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: 0.45 });
          return;
        }
        if (rng() < 0.62) {                                                 // reed clump — the fen's signature, and it hides things
          const cnt = 7 + ((rng() * 9) | 0);
          for (let i = 0; i < cnt; i++) {
            const a = rng() * Math.PI * 2, d = rng() * 1.5, hh = 1.3 + rng() * 1.6;
            P(cyl(0.015, 0.07, hh, 4).rotateZ((rng() - 0.5) * 0.45).rotateY(a)
              .translate(x + Math.cos(a) * d, y + hh / 2, z + Math.sin(a) * d), [0.44 + rng() * 0.2, 0.58 + rng() * 0.2, 0.26]);
          }
        } else {                                                            // rotted stump, drowned to the ankle
          const hh = 0.7 + rng() * 1.3, g = cyl(0.5 + rng() * 0.3, 0.8 + rng() * 0.4, hh, 8);
          P(g.translate(x, y + hh / 2 - 0.15, z), [0.30, 0.28, 0.22]);
          col.add({ type: 'sphere', pos: V3(x, y + hh * 0.5, z), r: 0.85 });
        }
      } },
      sunken: { mat: 'stone', n: 200, tint: [0.62, 0.86, 0.84], build: (x, y, z, P) => {
        const k = rng();
        if (k < 0.55) {                                                     // coral: a stem that forks, and forks again
          const hh = 0.9 + rng() * 1.6, tc = [0.9 + rng() * 0.5, 0.42 + rng() * 0.3, 0.52 + rng() * 0.3];
          P(cyl(0.14, 0.22, hh, 6).translate(x, y + hh / 2, z), tc);
          const arms = 2 + ((rng() * 3) | 0);
          for (let i = 0; i < arms; i++) {
            const a = rng() * Math.PI * 2, ah = hh * (0.5 + rng() * 0.5);
            P(cyl(0.07, 0.12, ah, 5).rotateZ((rng() - 0.5) * 1.1).rotateY(a)
              .translate(x + Math.cos(a) * 0.3, y + hh * 0.75 + ah * 0.35, z + Math.sin(a) * 0.3), tc);
          }
        } else if (k < 0.82) {                                              // anemone / kelp holdfast: a low fan
          const cnt = 5 + ((rng() * 6) | 0), tc = [0.36, 0.78 + rng() * 0.2, 0.62];
          for (let i = 0; i < cnt; i++) {
            const a = (i / cnt) * Math.PI * 2, hh = 0.8 + rng() * 1.5;
            P(box(0.1, hh, 0.34).rotateZ((rng() - 0.5) * 0.7).rotateY(a).translate(x + Math.cos(a) * 0.3, y + hh * 0.45, z + Math.sin(a) * 0.3), tc);
          }
        } else {                                                            // wreck: ribs of a hull coming out of the sand
          const a = rng() * Math.PI, ca = Math.cos(a), sa = Math.sin(a), ribs = 3 + ((rng() * 4) | 0);
          for (let i = 0; i < ribs; i++) {
            const t = (i - ribs / 2) * 1.6, rh = 2.2 + rng() * 2.0;
            P(box(0.3, rh, 0.7).rotateZ(0.35 - i * 0.06).rotateY(a).translate(x + ca * t, y + rh * 0.4, z + sa * t), [0.32, 0.26, 0.22]);
          }
          col.add({ type: 'sphere', pos: V3(x, y + 1.5, z), r: 2.2 });
        }
      } },
      void: { mat: 'basalt', n: 190, tint: [0.42, 0.36, 0.56], build: (x, y, z, P) => {
        if (rng() < 0.7) {                                                  // rubble that never landed
          const cnt = 1 + ((rng() * 3) | 0);
          for (let i = 0; i < cnt; i++) {
            const sc = 0.4 + rng() * 1.3, g = rock(1);
            g.scale(sc, sc * (0.5 + rng() * 0.7), sc);
            g.rotateX(rng() * 3); g.rotateZ(rng() * 3);
            g.translate(x + (rng() - 0.5) * 5, y + 1.2 + rng() * 5.5, z + (rng() - 0.5) * 5);
            P(g, [0.36 + rng() * 0.2, 0.30, 0.52 + rng() * 0.2]);
          }
        } else {                                                            // a pillar of something older, snapped off
          const hh = 2.0 + rng() * 4.0;
          P(box(0.9, hh, 0.9).rotateY(rng()).rotateZ((rng() - 0.5) * 0.3).translate(x, y + hh / 2, z), [0.34, 0.28, 0.46]);
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: 0.8 });
        }
      } },
      tundra: { mat: 'ice', n: 155, tint: [0.92, 0.96, 1.04], build: (x, y, z, P) => {   // Frostveil is the tightest tri budget in the world (3.97 M of 4 M measured at the frozen lake) — the icicle pillars cost ~0.3 M, so this stays lean
        const kt = rng();
        if (kt < 0.22) {                                                    // pressure-ice pillar hung with icicles — Winterspring's vertical
          const hh = 2.6 + rng() * 3.8, r0 = 0.5 + rng() * 0.5;
          P(cyl(r0 * 0.55, r0, hh, 6).rotateY(rng()).translate(x, y + hh / 2 - 0.2, z), [0.86, 0.94, 1.06]);
          const ic = 4 + ((rng() * 4) | 0);
          for (let i = 0; i < ic; i++) {
            const a = (i / ic) * 6.2832 + rng() * 0.5, il = 0.5 + rng() * 1.3;
            P(cone(0.09 + rng() * 0.05, il, 5).rotateX(Math.PI).translate(x + Math.cos(a) * r0 * 1.05, y + hh - il * 0.5, z + Math.sin(a) * r0 * 1.05), [0.92, 0.98, 1.10]);
          }
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: r0 + 0.2 });
          return;
        }
        if (rng() < 0.6) {                                                  // wind-carved drift
          const g = rock(2); g.scale(2.4 + rng() * 3.0, 0.6 + rng() * 0.8, 1.8 + rng() * 2.4);
          g.rotateY(rng() * 3.14); g.translate(x, y + 0.15, z);
          P(g, [0.98, 1.00, 1.06]);
        } else {                                                            // a boulder frozen into the shelf
          const sc = 0.8 + rng() * 1.4, g = rock(0); g.scale(sc, sc * 0.8, sc); g.translate(x, y + sc * 0.3, z);
          P(g, [0.80, 0.86, 0.96]);
          col.add({ type: 'sphere', pos: V3(x, y + sc * 0.35, z), r: sc * 0.9 });
        }
      } },
      forest: { mat: 'stone', n: 340, tint: [0.60, 0.56, 0.44], build: (x, y, z, P) => {
        const kf = rng();
        if (kf < 0.42) {                                                    // FERN clump: the forest floor, instead of meadow grass
          const cnt = 5 + ((rng() * 6) | 0), tc = [0.16 + rng() * 0.08, 0.34 + rng() * 0.12, 0.20 + rng() * 0.08];
          for (let i = 0; i < cnt; i++) {
            const a = (i / cnt) * 6.2832 + rng() * 0.6, len = 0.55 + rng() * 0.85;
            P(box(0.06, len, 0.30).rotateZ(0.85 + (rng() - 0.5) * 0.35).rotateY(a)
              .translate(x + Math.cos(a) * len * 0.34, y + 0.12 + len * 0.30, z + Math.sin(a) * len * 0.34), tc);
          }
          return;
        }
        if (kf < 0.62) {                                                    // elven ruin going under the moss: a step, a jamb, a fallen lintel
          const a = rng() * Math.PI, ca = Math.cos(a), sa = Math.sin(a), mc = [0.40, 0.50, 0.36];
          const kind = rng();
          if (kind < 0.4) {                                                 // half-buried stair block, moss on the tread
            for (let i = 0; i < 3; i++) P(box(3.2 - i * 0.5, 0.42, 1.1).rotateY(a).translate(x - sa * i * 0.9, y + 0.1 + i * 0.34, z + ca * i * 0.9), i ? mc : [0.46, 0.44, 0.36]);
            col.add({ type: 'sphere', pos: V3(x, y + 0.5, z), r: 1.7 });
          } else if (kind < 0.78) {                                         // a jamb still standing, its arch snapped off
            const hh = 2.4 + rng() * 2.6;
            P(box(0.62, hh, 0.62).rotateY(a).translate(x, y + hh / 2 - 0.2, z), [0.44, 0.46, 0.36]);
            P(box(0.78, 0.34, 0.78).rotateY(a).translate(x, y + hh - 0.3, z), mc);
            col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 0.4, z), r: 0.55 });
          } else {                                                          // the lintel that came off it, in the leaf litter
            P(box(2.6 + rng() * 1.4, 0.5, 0.7).rotateY(a).rotateZ((rng() - 0.5) * 0.25).translate(x, y + 0.22, z), mc);
          }
          return;
        }
        if (rng() < 0.5) {                                                  // fallen log, mossed on the up side
          const len = 3.5 + rng() * 5.0, a = rng() * Math.PI * 2;
          P(cyl(0.32, 0.42, len, 8).rotateZ(Math.PI / 2).rotateY(a).translate(x, y + 0.38, z), [0.46, 0.40, 0.30]);
          col.add({ type: 'capsule', a: V3(x - Math.cos(a) * len * 0.5, y + 0.4, z - Math.sin(a) * len * 0.5),
            b: V3(x + Math.cos(a) * len * 0.5, y + 0.4, z + Math.sin(a) * len * 0.5), r: 0.45 });
        } else {                                                            // stump with its roots showing
          const hh = 0.5 + rng() * 0.9;
          P(cyl(0.55, 0.8, hh, 9).translate(x, y + hh / 2 - 0.1, z), [0.42, 0.36, 0.27]);
          for (let i = 0; i < 4; i++) { const a = rng() * Math.PI * 2; P(cyl(0.1, 0.2, 1.1, 5).rotateZ(1.25).rotateY(a).translate(x + Math.cos(a) * 0.6, y + 0.12, z + Math.sin(a) * 0.6), [0.40, 0.34, 0.25]); }
        }
      } },
      lost: { mat: 'stone', n: 110, tint: [0.80, 0.72, 0.98], build: (x, y, z, P) => {
        const cnt = 2 + ((rng() * 4) | 0), r0 = 2.5 + rng() * 3.5, a0 = rng() * Math.PI * 2;
        for (let i = 0; i < cnt; i++) {                                     // a ring of stones, half of them down
          const a = a0 + (i / cnt) * Math.PI * 2, hh = 1.8 + rng() * 2.6;
          const px = x + Math.cos(a) * r0, pz = z + Math.sin(a) * r0, py = h(px, pz);
          if (Math.abs(py - y) > 3) continue;
          P(menhirGeometry(hh, rng).rotateZ((rng() - 0.5) * (rng() < 0.3 ? 1.5 : 0.14)).rotateY(-a).translate(px, py, pz));
          col.add({ type: 'capsule', a: V3(px, py - 1, pz), b: V3(px, py + hh - 0.6, pz), r: 0.7 });
        }
      } },
    };

    const MATS = { stone: this.stoneMat, ice: this.iceMat, basalt: this.basaltMat };
    let total = 0;
    for (const B of OUTER) {
      const K = KIT[B.id]; if (!K) continue;
      const parts = [], tints = [];
      const P = (g, t) => { parts.push(g); tints.push(t ?? K.tint); };
      for (let i = 0; i < K.n; i++) {
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * 250;          // sqrt: even area density, not a bullseye
        const x = B.cx + Math.cos(a) * d, z = B.cz + Math.sin(a) * d;
        const bb = terrain.biomeBlend?.(x, z, this._cb ??= {});
        if (!bb || bb.id !== B.id || bb.w < 0.55) continue;                  // never leak a region's furniture over a border
        if ((terrain.roadAt?.(x, z) ?? 0) > 0.3) continue;
        const y = h(x, z);
        if (y < WL + 0.35 || terrain.slopeAt(x, z) > 0.55) continue;         // not in the water, not on a cliff
        if (Math.hypot(x - B.cx, z - B.cz) < 26) continue;                   // keep the landmark's own ground clear
        K.build(x, y, z, P);
      }
      if (!parts.length) continue;
      total += parts.length;
      const m = new THREE.Mesh(mergeAll(parts, tints), MATS[K.mat] ?? this.stoneMat);
      m.castShadow = m.receiveShadow = true; m.name = `clutter-${B.id}`;
      m.geometry.computeBoundingSphere();                                    // tight bounds => the other eight regions cull
      scene.add(m);
    }
    console.log(`[props] biome clutter: ${total} pieces across ${OUTER.length} regions`);
  }

  /**
   * BORDER STONES. Nine seams, one gate each. `wedgeAt` hands one region to the next on the bisector between
   * two centres, and the ground, haze, light and music all turn on that line — but an open line in a field is
   * something you cross without noticing. Standing stones flanking it give the crossing a THRESHOLD: you see
   * the gate from a long way off, you walk between the two stones, and the world on the far side is a
   * different place. Three pairs per seam (r 700 / 762 / 824) so the gate reads from any approach across the
   * belt, all merged into one mesh — 54 stones for one draw call.
   */
  _buildBorderStones(rng, h, col) {
    const { scene } = this.game;
    const parts = [], tints = [];
    for (let k = 0; k < 9; k++) {
      const a = THETA0 + (k + 0.5) * STEP;                       // the seam bearing
      const ox = Math.cos(a), oz = Math.sin(a);                  // outward along it
      const tx = -oz, tz = ox;                                   // across it: the gate opens this way
      for (const [r, s] of [[700, 0.74], [762, 1.0], [824, 0.74]]) {
        for (const side of [-1, 1]) {
          const x = ox * r + tx * side * 9.5, z = oz * r + tz * side * 9.5, y = h(x, z);
          if (y < 6) continue;                                   // never a stone standing in water
          const hh = (7.4 + rng() * 2.6) * s;
          parts.push(monolithGeometry(hh, rng).rotateY(-a).rotateZ(side * -0.045).translate(x, y - 0.5, z));
          tints.push([0.60, 0.58, 0.66]);
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: 1.5 });
        }
      }
    }
    if (!parts.length) return;
    const m = new THREE.Mesh(mergeAll(parts, tints), this.stoneMat);
    m.castShadow = m.receiveShadow = true; m.name = 'border-stones'; scene.add(m);
  }

  /**
   * Hearthfall — the Vale's hamlet (biome 1 is "grasslands, VILLAGES, wildflowers"). Nine cottages and a well
   * on the gentle rise east of the meadow, far enough from the Aetheryte plaza to read as its own place.
   * All one merged mesh + one merged thatch mesh: two draw calls for a village.
   */
  _buildVillage(rng, h, col) {
    const { scene } = this.game;
    const CX = 118, CZ = -96;                       // meadow, clear of the aetheryte (0,-28) and the lake
    const walls = [], wallT = [], roofs = [], roofT = [];
    const W = (g, t) => { walls.push(g); wallT.push(t); };
    const R = (g, t) => { roofs.push(g); roofT.push(t); };

    this._cottages = [];
    const cottage = (x, z, ry, w, d, wh) => {
      const y = h(x, z) - 0.15;
      this._cottages.push({ x, y, z, ry, d, wh });
      const body = new THREE.BoxGeometry(w, wh, d).rotateY(ry).translate(x, y + wh / 2, z);
      W(body, [0.86, 0.82, 0.72]);
      // plinth course: a stone footing stops the walls looking like they were dropped on the grass
      W(new THREE.BoxGeometry(w + 0.35, 0.45, d + 0.35).rotateY(ry).translate(x, y + 0.22, z), [0.62, 0.60, 0.56]);
      // thatched hip roof: a 4-sided pyramid. (A pair of leaning slabs needs the pitch maths to be exactly
      // right from every yaw; a cone with 4 segments is correct by construction and one geometry cheaper.)
      R(new THREE.ConeGeometry(Math.hypot(w, d) * 0.60, 2.4, 4).rotateY(Math.PI / 4 + ry).translate(x, y + wh + 1.15, z), [0.50, 0.38, 0.21]);
      R(new THREE.ConeGeometry(Math.hypot(w, d) * 0.30, 0.9, 4).rotateY(Math.PI / 4 + ry).translate(x, y + wh + 2.6, z), [0.42, 0.32, 0.17]);
      // chimney + a dark doorway so the silhouette is not a plain shed
      const cx2 = x + Math.sin(ry) * (w * 0.32), cz2 = z + Math.cos(ry) * (w * 0.32);
      W(new THREE.BoxGeometry(0.7, wh + 2.6, 0.7).rotateY(ry).translate(cx2, y + (wh + 2.6) / 2, cz2), [0.58, 0.54, 0.5]);
      W(new THREE.BoxGeometry(1.0, 1.9, 0.18).rotateY(ry).translate(x + Math.cos(ry) * (d / 2 + 0.02), y + 0.95, z - Math.sin(ry) * (d / 2 + 0.02)), [0.16, 0.12, 0.09]);
      const rad = Math.max(w, d) * 0.5;
      col.add({ type: 'box', box: new THREE.Box3(V3(x - rad, y - 1, z - rad), V3(x + rad, y + wh + 1.6, z + rad)) });
    };

    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2 + rng() * 0.4, r = 13 + rng() * 11;
      cottage(CX + Math.cos(a) * r, CZ + Math.sin(a) * r, a + Math.PI / 2 + (rng() - 0.5) * 0.5,
        4.6 + rng() * 2.2, 5.6 + rng() * 2.4, 3.0 + rng() * 0.9);
    }
    // the well the whole place is built around
    const wy = h(CX, CZ);
    W(new THREE.CylinderGeometry(1.5, 1.65, 1.1, 12).translate(CX, wy + 0.5, CZ), [0.6, 0.58, 0.54]);
    W(new THREE.CylinderGeometry(1.15, 1.15, 0.9, 12).translate(CX, wy + 0.7, CZ), [0.10, 0.10, 0.12]);
    for (const s of [1, -1]) W(new THREE.BoxGeometry(0.22, 2.6, 0.22).translate(CX + s * 1.3, wy + 2.0, CZ), [0.45, 0.34, 0.2]);
    R(new THREE.BoxGeometry(3.6, 0.26, 2.4).rotateX(0.35).translate(CX, wy + 3.5, CZ + 0.35), [0.5, 0.38, 0.2]);
    R(new THREE.BoxGeometry(3.6, 0.26, 2.4).rotateX(-0.35).translate(CX, wy + 3.5, CZ - 0.35), [0.5, 0.38, 0.2]);
    col.add({ type: 'sphere', pos: V3(CX, wy + 0.6, CZ), r: 1.8 });
    // low field walls between the nearest cottages: the hamlet reads as enclosed, not as scattered sheds
    for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2 + 0.2, r = 27 + rng() * 4;
      const x = CX + Math.cos(a) * r, z = CZ + Math.sin(a) * r, y = h(x, z);
      W(new THREE.BoxGeometry(7 + rng() * 5, 0.9, 0.6).rotateY(a + Math.PI / 2).translate(x, y + 0.35, z), [0.58, 0.56, 0.5]);
    }

    // warm windows: additive quads that only light up as the sun goes down (same trick the mushrooms use).
    // No point lights — nine cottages would be nine shadow-casting lights for one visual beat.
    const winGeo = [], WIN = new THREE.PlaneGeometry(0.85, 0.7);
    for (const c of this._cottages ?? []) {
      for (const s of [1, -1]) {
        const g = WIN.clone().rotateY(c.ry + (s > 0 ? 0 : Math.PI));
        g.translate(c.x + Math.sin(c.ry + Math.PI / 2) * s * (c.d / 2 + 0.06), c.y + c.wh * 0.55, c.z + Math.cos(c.ry + Math.PI / 2) * s * (c.d / 2 + 0.06));
        winGeo.push(g);
      }
    }
    if (winGeo.length) {
      const wmat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 0.95, 0.45), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: true, side: THREE.DoubleSide });
      const wmesh = new THREE.Mesh(mergeGeometries(winGeo), wmat);
      wmesh.name = 'village-windows'; wmesh.renderOrder = 1; scene.add(wmesh);
      this.villageWindows = wmesh;
    }
    const wm = new THREE.Mesh(flat(mergeAll(walls, wallT)), this.stoneMat);
    wm.castShadow = wm.receiveShadow = true; wm.name = 'village-walls'; scene.add(wm);
    const rm = new THREE.Mesh(flat(mergeAll(roofs, roofT)), this.stoneMat);
    rm.castShadow = rm.receiveShadow = true; rm.name = 'village-thatch'; scene.add(rm);
    this.landmarks.village = V3(CX, wy, CZ);
  }


  /**
   * The nine outer-region landmarks (Biomes.js). One merged stone mesh + one additive floor glyph per region,
   * built from a shared kit (pillar / slab / arch / dais / ring) so nine hero silhouettes cost nine draw calls.
   * Celestial and the Void additionally get FLOATING ISLES: walkable box colliders under real rock domes, with
   * an updraft column at the landmark so you can actually get up there.
   */
  _buildBiomeLandmarks(rng, h, col) {
    const { scene } = this.game;
    const isles = [];

    for (const B of OUTER) {
      const CX = B.cx, CZ = B.cz, CY = h(CX, CZ);
      const parts = [], tints = [];
      const P = (g, t) => { parts.push(g); tints.push(t ?? B.stone ?? [0.8, 0.78, 0.74]); };
      const T = LANDMARK_STONE[B.id];
      // ---- kit -------------------------------------------------------------
      const pillar = (x, z, ph, r = 1.1, taper = 0.82, tint) => {
        const y = h(x, z);
        P(new THREE.CylinderGeometry(r * taper, r, ph, 9).translate(x, y + ph / 2 - 0.4, z), tint);
        col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + ph - 1, z), r: r * 1.05 });
      };
      const slab = (x, y, z, w, hh, d, ry = 0, tint) => {
        const g = new THREE.BoxGeometry(w, hh, d); if (ry) g.rotateY(ry);
        P(g.translate(x, y, z), tint);
        col.add({ type: 'box', box: new THREE.Box3(V3(x - w / 2, y - hh / 2, z - d / 2), V3(x + w / 2, y + hh / 2, z + d / 2)) });
      };
      const dais = (r0, steps, step = 0.55, tint) => {
        for (let i = 0; i < steps; i++) {
          const r = r0 - i * (r0 * 0.16), y = CY + i * step;
          P(new THREE.CylinderGeometry(r - 0.3, r, step, 14).translate(CX, y + step / 2, CZ), tint);
          col.add({ type: 'box', box: new THREE.Box3(V3(CX - r * 0.72, CY - 2, CZ - r * 0.72), V3(CX + r * 0.72, y + step, CZ + r * 0.72)), walkable: true });
        }
        return CY + steps * step;
      };
      const gate = (span, ph, ry, tint) => {                                   // two legs + a lintel
        const dx = Math.cos(ry) * span / 2, dz = Math.sin(ry) * span / 2;
        pillar(CX - dx, CZ - dz, ph, 1.6, 0.72, tint); pillar(CX + dx, CZ + dz, ph, 1.6, 0.72, tint);
        slab(CX, CY + ph + 0.3, CZ, span + 3.4, 1.8, 3.0, ry, tint);
        slab(CX, CY + ph + 1.9, CZ, span * 0.6, 1.2, 2.4, ry, tint);
      };
      const ring = (n, rad, fn) => { for (let i = 0; i < n; i++) fn(i / n * Math.PI * 2, i); };

      // ---- the nine ---------------------------------------------------------
      if (B.id === 'forest') {                                                  // The Elderheart: stones round a titanic stump
        P(new THREE.CylinderGeometry(5.2, 6.4, 3.4, 13).translate(CX, CY + 1.3, CZ), [0.42, 0.34, 0.22]);
        col.add({ type: 'box', box: new THREE.Box3(V3(CX - 4.2, CY - 2, CZ - 4.2), V3(CX + 4.2, CY + 3.0, CZ + 4.2)), walkable: true });
        ring(7, 13, (a) => { const x = CX + Math.cos(a) * 13, z = CZ + Math.sin(a) * 13, y = h(x, z), hh = 6.5 + rng() * 3.5;
          P(monolithGeometry(hh, rng).rotateX(0.13).rotateY(-a).translate(x, y, z), [0.5, 0.56, 0.44]);
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: 1.4 }); });
      } else if (B.id === 'tundra') {                                           // The Glacier Throne
        const top = dais(11, 4, 0.7, [0.78, 0.86, 0.96]);
        slab(CX, top + 4.6, CZ - 3.2, 9, 9.2, 1.6, 0, [0.72, 0.82, 0.96]);      // throne back
        slab(CX, top + 0.9, CZ, 7.4, 1.6, 5.0, 0, [0.7, 0.8, 0.95]);            // seat
        ring(4, 15, (a) => pillar(CX + Math.cos(a) * 15, CZ + Math.sin(a) * 15, 12 + rng() * 4, 1.2, 0.5, [0.74, 0.85, 0.98]));
      } else if (B.id === 'celestial') {                                        // The Empyrean Gate + the isles above it
        dais(13, 3, 0.6, [0.86, 0.83, 0.76]);
        gate(15, 17, 0.6, [0.9, 0.86, 0.78]);
        ring(6, 21, (a) => pillar(CX + Math.cos(a) * 21, CZ + Math.sin(a) * 21, 9 + rng() * 5, 0.9, 0.86, [0.88, 0.85, 0.78]));
        isles.push({ x: CX + 70, z: CZ - 55, y0: CY + 58, n: 7, spread: 95, tint: [1.42, 1.38, 1.26], kind: 'celestial' });   // marble, not mud: on the tan stone map anything at or below 1.0 hangs over the white plain as a brown pod
      } else if (B.id === 'dragon') {                                           // Kharaz-Dun Gate, cut into the mountain
        const GOLD = [1.25, 0.98, 0.52];
        slab(CX, CY + 12, CZ - 2.4, 44, 24, 7, 0.3, [0.60, 0.58, 0.56]);        // the wall, set BACK
        // a real recess: two jambs and a lintel standing proud of the wall, with the dark doorway behind
        slab(CX - 7.5, CY + 9, CZ + 1.2, 4, 18, 5, 0.3, [0.70, 0.66, 0.58]);
        slab(CX + 7.5, CY + 9, CZ + 1.2, 4, 18, 5, 0.3, [0.70, 0.66, 0.58]);
        slab(CX, CY + 19, CZ + 1.2, 21, 3.2, 5.4, 0.3, GOLD);                   // gilded lintel
        slab(CX, CY + 21.4, CZ + 0.9, 15, 1.6, 4.2, 0.3, GOLD);
        slab(CX, CY + 8, CZ - 0.6, 11, 17, 2.5, 0.3, [0.10, 0.09, 0.09]);       // the dark inside
        for (let i = 0; i < 4; i++) slab(CX, CY + 0.5 + i * 0.5, CZ + 5.5 - i * 1.1, 20 - i * 2, 0.6, 2.2, 0.3, [0.66, 0.62, 0.54]);   // steps up to it
        ring(2, 19, (a, i) => pillar(CX + Math.cos(a + 1.2) * 19, CZ + Math.sin(a + 1.2) * 19, 15 + i * 4, 3.0, 0.7, [0.66, 0.62, 0.56]));
        // dragon nests on the benches: a boulder ring with eggs, on the flats bhDragon carves
        for (let n = 0; n < 5; n++) {
          const a = 0.7 + n * 1.21, rr = 60 + rng() * 70;
          const nx = CX + Math.cos(a) * rr, nz = CZ + Math.sin(a) * rr, ny = h(nx, nz);
          if (Math.abs(h(nx + 5, nz) - ny) > 4 || Math.abs(h(nx, nz + 5) - ny) > 4) continue;   // benches only
          ring(9, 0, (aa) => {
            const bx = nx + Math.cos(aa) * (6 + rng()), bz = nz + Math.sin(aa) * (6 + rng());
            P(makeRockGeometry(1, (rng() * 1e6) | 0).scale(1.5 + rng(), 1.0, 1.4 + rng()).translate(bx, h(bx, bz) + 0.2, bz), [0.52, 0.48, 0.44]);
          });
          for (let e = 0; e < 3; e++) {
            const ex = nx + (rng() - 0.5) * 5, ez = nz + (rng() - 0.5) * 5;
            P(new THREE.SphereGeometry(1.0, 10, 8).scale(0.72, 1.0, 0.72).translate(ex, h(ex, ez) + 0.8, ez), [0.95, 0.88, 0.72]);
          }
          col.add({ type: 'sphere', pos: V3(nx, ny + 1, nz), r: 7.5 });
        }
      } else if (B.id === 'infernal') {                                         // The Cinder Maw: obsidian teeth round the crater
        ring(9, 26, (a, i) => { const x = CX + Math.cos(a) * 26, z = CZ + Math.sin(a) * 26, y = h(x, z), hh = 9 + (i % 3) * 5 + rng() * 4;
          P(monolithGeometry(hh, rng).rotateX(0.3 * Math.cos(a)).rotateZ(0.3 * Math.sin(a)).rotateY(-a).translate(x, y, z), [0.20, 0.16, 0.15]);
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: 1.7 }); });
        gate(17, 20, 1.9, [0.17, 0.14, 0.14]);
      } else if (B.id === 'lost') {                                             // The Convergence: the endgame ring
        const top = dais(20, 4, 0.6, [0.80, 0.74, 0.88]);
        P(new THREE.ConeGeometry(3.0, 22, 8).translate(CX, top + 11, CZ), [0.84, 0.76, 0.94]);
        col.add({ type: 'capsule', a: V3(CX, top, CZ), b: V3(CX, top + 20, CZ), r: 2.6 });
        ring(16, 34, (a) => { const x = CX + Math.cos(a) * 34, z = CZ + Math.sin(a) * 34, y = h(x, z), hh = 11 + rng() * 6;
          P(monolithGeometry(hh, rng).rotateY(-a).translate(x, y, z), [0.78, 0.72, 0.9]);
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: 1.5 }); });
      } else if (B.id === 'shadowfen') {                                        // The Hagstone: a holed stone over a stake circle
        pillar(CX - 3.4, CZ, 13, 1.5, 0.9, [0.42, 0.46, 0.38]); pillar(CX + 3.4, CZ, 13, 1.5, 0.9, [0.42, 0.46, 0.38]);
        slab(CX, CY + 13.4, CZ, 11, 2.2, 3.0, 0, [0.40, 0.44, 0.36]);
        ring(11, 12, (a) => { const x = CX + Math.cos(a) * 12, z = CZ + Math.sin(a) * 12, y = h(x, z), hh = 3 + rng() * 2.5;
          P(new THREE.CylinderGeometry(0.10, 0.28, hh, 6).rotateX((rng() - 0.5) * 0.5).rotateZ((rng() - 0.5) * 0.5).translate(x, y + hh / 2, z), [0.30, 0.26, 0.2]); });
      } else if (B.id === 'sunken') {                                           // The Drowned Court: a colonnade under the sea
        const top = dais(15, 3, 0.7, [0.72, 0.78, 0.74]);
        ring(10, 22, (a, i) => pillar(CX + Math.cos(a) * 22, CZ + Math.sin(a) * 22, i % 4 === 1 ? 5 + rng() * 3 : 15 + rng() * 5, 1.35, 0.8, [0.70, 0.80, 0.76]));
        slab(CX, top + 2.6, CZ - 4, 8, 5.2, 1.4, 0, [0.68, 0.78, 0.76]);        // the throne nobody sits on
        // The hoard at the foot of the throne. The Sunken Kingdom is the one region you have to hold your
        // breath to reach the bottom of and there was nothing down there to find — so: spilled coin, a
        // broken chest, and the crown, all in gold that is saturated but nowhere near the bloom threshold.
        for (let i = 0; i < 26; i++) {
          const a = rng() * 6.2832, d = rng() * 5.5;
          P(new THREE.CylinderGeometry(0.22 + rng() * 0.18, 0.24 + rng() * 0.2, 0.10, 10)
            .rotateZ((rng() - 0.5) * 0.9).translate(CX + Math.cos(a) * d, top + 0.1 + rng() * 0.35, CZ + 2.5 + Math.sin(a) * d), [1.06, 0.78, 0.24]);
        }
        for (const sd of [-1, 1]) P(new THREE.BoxGeometry(2.2, 1.1, 1.4).rotateY(0.3 * sd).translate(CX + sd * 4.5, top + 0.55, CZ + 3.2), [0.42, 0.30, 0.20]);
        P(new THREE.TorusGeometry(0.62, 0.10, 6, 16).rotateX(Math.PI / 2).translate(CX, top + 0.14, CZ + 2.2), [1.10, 0.84, 0.30]);
        for (let i = 0; i < 6; i++) P(new THREE.ConeGeometry(0.13, 0.42, 5).translate(CX + Math.cos(i / 6 * 6.2832) * 0.62, top + 0.36, CZ + 2.2 + Math.sin(i / 6 * 6.2832) * 0.62), [1.10, 0.84, 0.30]);
      } else {                                                                  // void — The Unmaking: shattered ring, nothing holding it up
        ring(10, 24, (a, i) => { const x = CX + Math.cos(a) * 24, z = CZ + Math.sin(a) * 24, y = h(x, z) + 6 + (i % 4) * 5, hh = 8 + rng() * 6;
          P(monolithGeometry(hh, rng).rotateX(0.5 * Math.cos(a * 2)).rotateZ(0.5 * Math.sin(a * 3)).rotateY(-a).translate(x, y, z), [0.30, 0.26, 0.40]);
          col.add({ type: 'capsule', a: V3(x, y, z), b: V3(x, y + hh, z), r: 1.5 }); });
        isles.push({ x: CX + 60, z: CZ + 62, y0: CY + 52, n: 8, spread: 105, tint: [0.32, 0.27, 0.42], kind: 'void' });
      }

      if (parts.length) {
        const mat = LANDMARK_STONE[B.id].mat === 'ice' ? this.iceMat
          : LANDMARK_STONE[B.id].mat === 'basalt' ? this.basaltMat : this.stoneMat;
        const m = new THREE.Mesh(flat(mergeAll(parts, tints)), mat);
        m.castShadow = m.receiveShadow = true; m.name = 'landmark-' + B.id; scene.add(m);
      }
      // floor sigil: additive, HDR colour so it reads at noon; hue is the region's, VALUE stays modest
      const gl = new THREE.Mesh(new THREE.RingGeometry(6, 11, 96).rotateX(-Math.PI / 2), this.glyphMat(glyphTexture(512, 6 / 11, 1, rng), new THREE.Color(...T.glyph)));
      gl.name = 'glyph-' + B.id; gl.position.set(CX, CY + 0.2, CZ); gl.userData.speed = 0.035 * (B.k % 2 ? -1 : 1);
      this._rot.push(gl); scene.add(gl);
      this.landmarks[B.id] = V3(CX, CY, CZ);
    }

    if (isles.length) this._buildIsles(isles, rng, h, col);
  }

  /**
   * Floating isles: flattened rock domes with a flat walkable cap. An archipelago is only a place if you
   * can move around it, so the isles are LINKED — each one is joined to the previous by a ruined span you
   * can walk, and every third isle carries its own updraft column so a fall is a detour, not a death.
   * Spans are deliberately narrow (2.6 m) and railless: crossing one should cost a held breath.
   */
  _buildIsles(specs, rng, h, col) {
    const { scene } = this.game;
    const parts = [], tints = [];
    this.updrafts = this.updrafts ?? [];
    for (const s of specs) {
      const isles = [];
      for (let i = 0; i < s.n; i++) {
        const a = i === 0 ? 0 : (i / s.n) * Math.PI * 2 + rng() * 0.7, r = i === 0 ? 0 : 26 + (i / s.n) * s.spread + rng() * 22;
        const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
        const y = s.y0 + (i === 0 ? 0 : (rng() - 0.5) * 34);
        const R = i === 0 ? 26 : 11 + rng() * 15;
        const g = makeRockGeometry(2, (rng() * 1e6) | 0);
        g.scale(R, R * 0.5, R * 0.92); g.translate(x, y, z);
        parts.push(g); tints.push([s.tint[0] * (0.86 + rng() * 0.28), s.tint[1] * (0.86 + rng() * 0.28), s.tint[2] * (0.86 + rng() * 0.28)]);
        // KEEL. A flattened dome seen from underneath is a dark ellipse — the isles read as discs pasted on
        // the sky, which is the one angle you always have on them while you are still on the ground below.
        // Hanging a torn root off each one gives the underside a silhouette and something for the light to
        // break on. Rock kind 3 is the pointed shard, flipped to hang.
        // ...but a keel as deep as the isle is WIDE turns the silhouette into a mushroom. Shallower and
        // wider reads as an eroded underside; the tint stays close to the cap so it is the same rock in shade.
        const gk = makeRockGeometry(3, (rng() * 1e6) | 0);
        gk.rotateX(Math.PI); gk.scale(R * 0.86, R * 0.58, R * 0.82); gk.translate(x, y + R * 0.06, z);
        parts.push(gk); tints.push([s.tint[0] * 0.80, s.tint[1] * 0.80, s.tint[2] * 0.86]);
        // the cap you stand on: one walkable box, inset so you cannot stand on thin air past the rim
        col.add({ type: 'box', box: new THREE.Box3(V3(x - R * 0.62, y - 8, z - R * 0.6), V3(x + R * 0.62, y + R * 0.2, z + R * 0.6)), walkable: true });
        isles.push({ x, y: y + R * 0.2, z, R });
        if (i % 3 === 0) this.updrafts.push({ x, z, r: i === 0 ? 13 : 8, top: y + 26 });   // a way back up from most of the ring
        // SOMETHING ON THE ISLE. An archipelago you can walk to and find nothing on is a platforming test,
        // not a place — both float regions shipped as bare rock caps. Each isle now carries the region's own
        // ruin, and the biggest one carries a focal piece you can see from the ground below.
        const ty = y + R * 0.2, hero = R > 18;
        if (s.kind === 'celestial') {
          const ring = hero ? 8 : 4, rr = R * 0.52;
          for (let c = 0; c < ring; c++) {                                  // a peristyle, half of it fallen
            const ca2 = (c / ring) * Math.PI * 2, px = x + Math.cos(ca2) * rr, pz = z + Math.sin(ca2) * rr;
            if (c % 3 === 2) { parts.push(new THREE.CylinderGeometry(0.52, 0.55, 3.4, 10).rotateZ(Math.PI / 2).rotateY(ca2).translate(px, ty + 0.3, pz)); tints.push([1.02, 0.98, 0.86]); continue; }
            const ph = hero ? 5.6 : 3.4;
            parts.push(new THREE.CylinderGeometry(0.46, 0.56, ph, 10).translate(px, ty + ph / 2, pz)); tints.push([1.06, 1.02, 0.90]);
            col.add({ type: 'capsule', a: V3(px, ty, pz), b: V3(px, ty + ph, pz), r: 0.7 });
          }
          if (hero) {                                                       // the altar: a gilded drum on a stepped dais
            parts.push(new THREE.CylinderGeometry(4.2, 4.8, 0.5, 12).translate(x, ty + 0.25, z)); tints.push([1.04, 1.00, 0.88]);
            parts.push(new THREE.CylinderGeometry(3.2, 3.6, 0.5, 12).translate(x, ty + 0.72, z)); tints.push([1.06, 1.02, 0.90]);
            parts.push(new THREE.CylinderGeometry(1.5, 1.8, 1.6, 10).translate(x, ty + 1.75, z)); tints.push([1.20, 0.94, 0.44]);
            col.add({ type: 'capsule', a: V3(x, ty, z), b: V3(x, ty + 2.6, z), r: 2.0 });
          }
        } else if (s.kind === 'void') {
          const n2 = hero ? 5 : 3;
          for (let c = 0; c < n2; c++) {                                    // snapped pillars, leaning the wrong way
            const ca2 = rng() * Math.PI * 2, rr = R * (0.2 + rng() * 0.45), ph = 2.4 + rng() * (hero ? 7 : 3.5);
            const px = x + Math.cos(ca2) * rr, pz = z + Math.sin(ca2) * rr;
            parts.push(new THREE.BoxGeometry(0.85, ph, 0.85).rotateY(rng()).rotateZ((rng() - 0.5) * 0.55).translate(px, ty + ph / 2, pz));
            tints.push([0.36, 0.30, 0.52]);
            col.add({ type: 'capsule', a: V3(px, ty, pz), b: V3(px, ty + ph * 0.8, pz), r: 0.7 });
          }
          for (let c = 0; c < 4; c++) {                                     // rubble that never landed, orbiting the cap
            const ca2 = rng() * Math.PI * 2, rr = R * (0.5 + rng() * 0.6), sc = 0.5 + rng() * 1.2;
            const g2 = makeRockGeometry(1, (rng() * 1e6) | 0);
            g2.scale(sc, sc * 0.7, sc); g2.rotateX(rng() * 3); g2.rotateZ(rng() * 3);
            g2.translate(x + Math.cos(ca2) * rr, ty + 2.5 + rng() * 6, z + Math.sin(ca2) * rr);
            parts.push(g2); tints.push([0.40, 0.33, 0.56]);
          }
        }
      }
      // spans: isle i to isle i-1, plus one back to the hub, laid as a few short segments so a long
      // bridge follows the height difference in steps instead of hovering as one impossible plank
      const spans = isles.slice(1).map((b, i) => [isles[i], b]).concat(isles.length > 2 ? [[isles[isles.length - 1], isles[0]]] : []);
      for (const [a, b] of spans) {
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
        if (len > 150) continue;                                     // too far to bridge; the updraft is the way
        const ux = dx / len, uz = dz / len, ry = Math.atan2(dx, dz);
        const t0 = a.R * 0.55, t1 = len - b.R * 0.55, span = t1 - t0;
        if (span < 6) continue;
        const SEG = Math.max(2, Math.round(span / 16));
        for (let k = 0; k < SEG; k++) {
          const f0 = t0 + (span * k) / SEG, f1 = t0 + (span * (k + 1)) / SEG, fm = (f0 + f1) / 2;
          const px = a.x + ux * fm, pz = a.z + uz * fm;
          const py = a.y + (b.y - a.y) * (fm / len) - 0.5 - Math.sin((fm - t0) / span * Math.PI) * 1.6;   // sags in the middle
          const L = f1 - f0 + 0.6;
          const g = new THREE.BoxGeometry(2.6, 0.55, L).rotateY(ry).translate(px, py, pz);
          parts.push(g); tints.push([s.tint[0] * 0.92, s.tint[1] * 0.92, s.tint[2] * 0.92]);
          // Kerbs and posts. A 2.6 x 0.55 slab seen from the side is a plank hanging in the air — which is
          // exactly how the spans read from the ground below, the angle you spend the most time at. A raised
          // edge and a post at each joint give it a profile, and read as a bridge from any angle.
          for (const sd of [-1, 1]) {
            const ox = -uz * sd * 1.15, oz = ux * sd * 1.15;
            const gk2 = new THREE.BoxGeometry(0.32, 0.46, L).rotateY(ry).translate(px + ox, py + 0.34, pz + oz);
            parts.push(gk2); tints.push([s.tint[0] * 1.02, s.tint[1] * 1.02, s.tint[2] * 1.02]);
            const gp = new THREE.BoxGeometry(0.42, 1.05, 0.42).rotateY(ry).translate(px + ox - ux * (L * 0.5 - 0.3), py + 0.6, pz + oz - uz * (L * 0.5 - 0.3));
            parts.push(gp); tints.push([s.tint[0] * 0.98, s.tint[1] * 0.98, s.tint[2] * 0.98]);
          }
          col.add({ type: 'box', box: new THREE.Box3(V3(px - 1.6, py - 0.3, pz - 1.6), V3(px + 1.6, py + 0.28, pz + 1.6)), walkable: true });
        }
      }
    }
    const m = new THREE.Mesh(mergeAll(parts, tints), this.stoneMat);
    m.castShadow = m.receiveShadow = true; m.name = 'floating-isles'; scene.add(m);
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
    const flameMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffd090, emissive: 0xff9a40, emissiveIntensity: 0.95, roughness: 0.6 }), { key: 'flame', uniforms: { uTime: U.uTime }, fHead: 'uniform float uTime; varying float vPh;', vHead: 'varying float vPh;', vBegin: 'vPh = fract(instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21);',
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
    const mat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, emissive: 0x30ffd8, emissiveIntensity: 2.2 }), mergePatch(fadePatch, {
      key: 'mushroom', uniforms: { uTime: U.uTime, uSunI: U.uSunI ?? { value: 1 } }, vHead: 'attribute float aGlow; varying float vGlow; varying float vPh;', vBegin: 'vGlow = aGlow; vPh = fract(instanceMatrix[3].x * 0.17 + instanceMatrix[3].z * 0.29);',
      fHead: 'uniform float uTime; uniform float uSunI; varying float vGlow; varying float vPh;',
      // Night-boosted glow, but daylight-capped. A sunlit near-white cap already sits near 1.0 linear; the old
      // 0.55 day term put another ~0.9 of cyan emissive on top, which crossed the 1.05 day bloom threshold and
      // bloomed every cap into a washed-white ball (gate blobcheck). Same rule as everywhere else in this repo:
      // saturate the COLOUR (the cap albedo below is now real mint, not white), cap the INTENSITY, and close it
      // with a HUE-PRESERVING luminance cap (per-component min would clip cyan to grey) that tightens in
      // daylight and opens up at night, where a glowing mushroom blooming its own colour is the point.
      fEmissive: 'totalEmissiveRadiance *= vGlow * (0.75 + 0.25 * sin(uTime * 1.7 + vPh * 6.28)) * (0.14 + 2.1 * (1.0 - clamp(uSunI, 0.0, 1.0))); float mLum = dot(totalEmissiveRadiance, vec3(0.2126, 0.7152, 0.0722)); float mCap = mix(1.15, 0.55, clamp(uSunI, 0.0, 1.0)); totalEmissiveRadiance *= mCap / max(mLum, mCap);',
    }));
    const mesh = new THREE.InstancedMesh(mushroomGeometry(), mat, 1); mesh.receiveShadow = true; mesh.name = 'mushrooms'; scene.add(mesh);
    const lod = new InstLOD({ near: [mesh], nearDist: 52 * Q, band: 10, color: true });
    const M = new THREE.Matrix4(), Qt = new THREE.Quaternion(), S = V3(1, 1, 1), E = new THREE.Euler(), C = new THREE.Color();
    const glowPts = [];
    const add = (x, z, s) => { const y = h(x, z); E.set((rng() - 0.5) * 0.3, rng() * 6.28, (rng() - 0.5) * 0.3); Qt.setFromEuler(E); S.setScalar(s); M.compose(V3(x, y - 0.02, z), Qt, S); const hue = rng(); C.setRGB(0.34 + hue * 0.22, 0.80, 0.70 + (1 - hue) * 0.16);   // mint cap, not white: a white albedo in full sun is already at the bloom threshold before the glow is added lod.add(M, C);
      if (s > 0.75 && glowPts.length < 450 && rng() < 0.6) glowPts.push([x, y + 0.06, z, 0.7 + s * 0.9]); };
    for (const t of veg?.trees ?? []) { if (t.z > -175 || Math.abs(t.x) > 260 || rng() < 0.45) continue; const n = 1 + Math.floor(rng() * 4); for (let i = 0; i < n; i++) { const a = rng() * 6.28, d = t.r + 0.3 + rng() * 1.4; add(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, 0.5 + rng() * 1.3); } }
    for (let i = 0; i < 700; i++) { const x = (rng() - 0.5) * 500, z = -190 - rng() * 230; if (Math.hypot(x, z + 28) < 10) continue; const n = 1 + Math.floor(rng() * 3); for (let k = 0; k < n; k++) add(x + (rng() - 0.5) * 2, z + (rng() - 0.5) * 2, 0.4 + rng() * 1.0); }
    // The same fungus, in the two OUTER regions whose spec asks for it by name: Whisperwood Deep's fae lights
    // between the trunks, and Shadowfen's witchlight. Both were written down as region identity and neither
    // existed — the glow only ever reached the home-bowl treeline. One instanced mesh serves all three.
    const WL2 = this.game.terrain?.waterLevel ?? 4;
    for (const [cx, cz, R, wet] of [[-66, -757, 190, false], [-623, 436, 185, true]]) {
      for (let i = 0; i < 620; i++) {
        const a = rng() * 6.2832, d = Math.sqrt(rng()) * R;
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d, y = h(x, z);
        if (wet ? y < WL2 + 0.15 || y > WL2 + 2.2 : y < WL2 + 0.4) continue;   // the fen's fungus grows on the hummocks, not under the peat
        const n = 1 + Math.floor(rng() * 4);
        for (let k = 0; k < n; k++) add(x + (rng() - 0.5) * 2.2, z + (rng() - 0.5) * 2.2, 0.45 + rng() * 1.15);
      }
    }
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
    if (this.villageWindows) this.villageWindows.material.opacity = clamp(1.05 - (this.game.sky?.sunIntensity ?? 1) * 1.6, 0, 0.9);   // hearths lit after dusk
    if (!this.game.world.vegetation?.lods && this._ownLods) { const p = this.game.camera.position; for (const l of this._ownLods) l.refresh(p.x, p.z); }
    if (!this.game.world.vegetation) this.U.uTime.value = t;
  }
}
