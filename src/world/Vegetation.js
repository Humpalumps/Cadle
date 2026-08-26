import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, fbm, noise2, smoothstep, clamp, lerp } from '../core/Noise.js';
import { BIOMES } from './Biomes.js';

/**
 * Vegetation: procedural trees (3 species, instanced, near mesh + baked billboard impostor LOD, wind sway,
 * leaf translucency), rocks (4 shapes, triplanar rock material) and aether crystal clusters (emissive, pulsing).
 * Leaf cards + bark use the AI-painted assets (assets/tex/leaf_card.png, bark.jpg) blended with procedural detail.
 * Everything is placed deterministically by biome (CLAUDE.md world layout) on terrain.heightAt and registers
 * colliders in game.world.colliders.
 * Exposes (stable):
 *   vegetation.trees     [{x,y,z,species,scale,r,c?}]  species 0 slender, 1 gnarled, 2 willow (Props uses it for
 *                        mushrooms), 3 snow conifer (tundra), 4 charred leafless snag (infernal/void), 5 old-growth
 *                        canopy giant (forest), 6 dark alpine pine (dragon), 7 sparse dead husk (shadowfen).
 *                        `c` = [r,g,b] leaf tint, present on region-owned trees only (EZTrees reads it).
 *   vegetation.rocks     [{x,y,z,kind,scale}]
 *   vegetation.crystals  [{x,y,z,scale}]
 *   vegetation.lods      InstLOD sets refreshed round-robin (Props pushes its own)
 *   vegetation.uniforms  { uTime, uWind, uSunDirV, uSunColor, uSunI } shared by Props materials
 *   vegetation.setWind(w)
 *   vegetation.collisionSelfTest() -> {pass, tests[]}  deterministic sphere-walk into registered colliders (for critics)
 * Exports helpers for Props: InstLOD, patchMaterial, triplanarPatch, fadePatch, erodeFade, makeRockGeometry,
 *   noiseTexture, rgbaTexture, normalFromLuma
 */

// ---------------------------------------------------------------- per-biome scatter tables (Biomes.js ids)
// One line per outer region: what grows there, what stone it is made of, what its spires look like.
// `p` is the accept probability at the region's heart; it fades out with the biome weight.
const NO_BIOME = { id: 'meadow', w: 0, k: -1 };
// [accept probability, species pool, LEAF TINT]. The tint is the one that was missing: every tree in the
// world took the same yellow-green instance jitter, so a Frostveil pine, a Void husk and a Whisperwood oak
// were the same tree wearing the same leaves. It multiplies the jitter (so the per-instance variation
// survives) and fades in with the biome weight, exactly like the crystal spires' tint.
// `og` = share of accepts that become species 5 (old-growth, 25-35 m, huge crown cards — see EZTrees.js);
// `sMax`/`yMax` = per-biome slope/altitude gates (glacier faces and dragon cliffs must stay bare).
// p 0.45 -> 0.34 for the forest pays for the old-growth crowns with FEWER instances, not more geometry:
// each old-growth covers ~4x the sky of a sapling, so the canopy closes while the tri count drops
// (looking south out of the Whisperwood is the heaviest view in the world — it must not grow).
const BTREE = {
  forest:    { p: 0.34, sp: [8], og: 0.58, col: [0.45, 0.80, 0.62], gv: 0.72 },   // deep green + subtle teal (accent applied at placement); species 8 is the aspen-free broadleaf pool — the gold-tinted Aspen presets in species 0 were the "random ochre autumn trees"
  tundra:    { p: 0.34, sp: [3],    col: [0.90, 0.96, 1.06], gv: 0.36, sMax: 0.17, yMax: 34 },   // snow-laden conifers (card_conifer_snow) — winter, never summer green; treeline stops below the glacier massif
  celestial: { p: 0.00, sp: [0],    col: [1.12, 0.98, 0.60] },   // marble isles: broken colonnade, not woodland (Props._buildBiomeClutter)
  dragon:    { p: 0.07, sp: [6],    col: [0.30, 0.40, 0.35], sMax: 0.30, yMax: 54 },   // DARK alpine pine, LOW ledges only (heart ~44 m; yMax 62->54 clears the high benches; col darkened — 0.42-green still read spring-lime beside the gate, crit2-dragon-b)
  infernal:  { p: 0.04, sp: [4],    col: [0.92, 0.90, 0.88] },   // charred LEAFLESS snags, sparse — the wastes are mostly vents and ash (col is near-neutral: it tints the trunk impostor, and a charred trunk must stay charcoal)
  lost:      { p: 0.00, sp: [1],    col: [0.88, 0.72, 1.14] },   // standing stones instead
  shadowfen: { p: 0.32, sp: [7],    col: [0.40, 0.46, 0.28] },   // ALL of it dead: sparse husk canopy over standing water (species 7 keeps the old sparse-leaf dead look; 4 went fully leafless for the infernal spec)
  sunken:    { p: 0.00, sp: [2],    col: [0.48, 0.92, 0.84] },   // coral and wreck, no trees
  void:      { p: 0.00, sp: [4],    col: [0.58, 0.44, 0.94] },   // nothing grows; the rubble hangs instead
};
// [accept probability, linear rock tint, material group]. `grp` routes the region's rocks to their own
// albedo material (see _buildRocks GROUPS) — one shared cracked-vein texture read as "dried mud balls" in
// dragon/celestial/infernal and "marble eggs" in lost, and its moss term went olive on tundra domes
// (wave-2 verdicts). No grp (or a missing asset) = the default mossy granite.
const BROCK = {
  forest:    { p: 0.05, col: [0.80, 0.95, 0.78] },                        // mossy granite (procedural)
  tundra:    { p: 0.12, col: [1.05, 1.08, 1.15], grp: 'tundra' },         // frost-bleached granite, snow-dusted tops
  celestial: { p: 0.09, col: [1.12, 1.06, 0.94], grp: 'celestial' },      // white marble strata
  dragon:    { p: 0.22, col: [0.92, 0.90, 0.92], grp: 'dragon' },         // granular granite
  infernal:  { p: 0.17, col: [0.52, 0.48, 0.46], grp: 'infernal' },       // columnar basalt (tint raised from 0.26: over an already-dark albedo the boulders went featureless black)
  lost:      { p: 0.08, col: [0.92, 0.86, 1.10], grp: 'lost' },           // violet megalith stone
  shadowfen: { p: 0.06, col: [0.62, 0.70, 0.55] },
  sunken:    { p: 0.14, col: [0.72, 0.92, 0.92] },
  void:      { p: 0.18, col: [0.34, 0.28, 0.46], grp: 'void' },           // voidstone
};
// biome spires reuse the crystal geometry: [p, linear instance tint, [minScale, maxScale]].
// Colours stay SATURATED and the bright ones stay modest in value — an emissive spire that tone-maps
// to white is the washed-white blob bug (CLAUDE.md architectural law).
// ...plus `a` = [girth, height] aspect. Colour alone was not enough: nine regions all grew the SAME cluster
// silhouette, so an ice shard, a coral fan and an obsidian stump only differed in hue. Aspect costs nothing
// (it is the instance matrix) and is what makes them read apart at a distance.
const BSPIRE = {
  forest:    { p: 0.030, col: [0.45, 1.00, 0.62], s: [0.8, 1.9], a: [0.70, 1.05] },   // fae light: slim wisps
  tundra:    { p: 0.100, col: [0.92, 0.96, 1.04], s: [2.0, 4.4], a: [0.60, 1.60] },   // ice: PALE glacial fracture shards (near-white tint flips the crystal shader's body to frost — see paleT in _buildCrystals; the old 0.66-blue read as opaque royal sapphire, wave-1+2 verdicts)
  celestial: { p: 0.000, col: [1.05, 0.86, 0.42], s: [2.2, 4.2], a: [0.74, 1.40] },   // marble + gold, no crystal
  dragon:    { p: 0.000, col: [0.86, 0.80, 0.74], s: [1.4, 2.8], a: [1.10, 0.85] },   // bone and scorched rock
  infernal:  { p: 0.000, col: [0.30, 0.11, 0.08], s: [1.6, 3.6], a: [1.30, 0.68] },   // basalt vents instead
  lost:      { p: 0.055, col: [0.78, 0.58, 1.10], s: [2.0, 3.8], a: [0.85, 1.25] },   // arcane shards: this IS where magic collects
  shadowfen: { p: 0.000, col: [0.48, 1.00, 0.42], s: [0.8, 1.7], a: [0.95, 0.90] },   // witchlight is the glowing fungus, not a crystal
  sunken:    { p: 0.000, col: [1.00, 0.46, 0.58], s: [1.2, 2.8], a: [1.50, 0.55] },   // real coral instead
  void:      { p: 0.120, col: [0.52, 0.22, 1.05], s: [2.0, 4.8], a: [0.78, 1.35] },   // void shards
};
// Crystal spires survive in FOUR regions only, and in each one a crystal is what the place is actually made
// of: Whisperwood's fae lights, Frostveil's ice, the Lost Realm's arcane shards, the Void's splinters.
// Everywhere else the region grows its own thing (Props._buildBiomeClutter) — the complaint that started
// this was "trees and crystals in every biome", and re-tinting the same two props is not an answer to it.
// grove noise for the outer regions (separate lattice from the home Whisperwood, so they clump differently)
const grove2 = (x, z) => smoothstep(0.10, 0.52, fbm(x * 0.0075, z * 0.0075, { octaves: 3, seed: 41 }) * 0.5 + 0.5);

// ---------------------------------------------------------------- shader patch helpers
const F32 = (a, n) => new THREE.BufferAttribute(Float32Array.from(a), n);

/** Compose onBeforeCompile injections for a built-in material (Standard/Physical/Depth/Basic). */
export function patchMaterial(mat, o) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, o.uniforms || {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + (o.vHead || ''))
      .replace('#include <beginnormal_vertex>', o.vNormal || '#include <beginnormal_vertex>')
      .replace('#include <defaultnormal_vertex>', o.vDefNormal || '#include <defaultnormal_vertex>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (o.vBegin || ''))
      .replace('#include <project_vertex>', (o.vProject || '#include <project_vertex>') + '\n' + (o.vAfter || ''));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + (o.fHead || ''))
      .replace('#include <map_fragment>', o.fMap || '#include <map_fragment>')
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\n' + (o.fAlpha || ''))
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + (o.fEmissive || ''));
  };
  mat.customProgramCacheKey = () => o.key;
  return mat;
}
/** Per-instance dithered fade (attribute aFade 0..1) — used for LOD cross-fades on opaque parts. */
export const fadePatch = {
  vHead: 'attribute float aFade; varying float vFade;',
  vBegin: 'vFade = aFade;',
  fHead: 'varying float vFade; float ditherT(vec2 p){ return fract(52.9829189*fract(dot(p, vec2(0.06711056,0.00583715)))); }',
  fAlpha: 'if (vFade < 0.999 && vFade < ditherT(gl_FragCoord.xy)) discard;',
};
/** Alpha-erode fade for alpha-cutout parts: the cutout threshold rises as vFade drops, so foliage dissolves
 *  leaf-by-leaf instead of screen-door stippling (fixes LOD cross-fade fizz). */
export const erodeFade = (at) => ({
  vHead: 'attribute float aFade; varying float vFade;',
  vBegin: 'vFade = aFade;',
  fHead: 'varying float vFade;',
  fAlpha: `if (diffuseColor.a < mix(1.01, ${at.toFixed(3)}, clamp(vFade, 0.0, 1.0))) discard;`,
});
/** World-space triplanar mapping of material.map (+ optional moss on up-facing surfaces). */
export function triplanarPatch(scale = 0.3, moss = 0.0, mossColor = [0.45, 0.62, 0.28]) {
  return {
    uniforms: { uTriScale: { value: scale }, uMoss: { value: moss }, uMossCol: { value: new THREE.Vector3(...mossColor) } },
    vHead: 'varying vec3 vWPos; varying vec3 vWNormal;',
    vAfter: `{ vec4 wp = vec4(transformed, 1.0); mat3 nm = mat3(modelMatrix);
      #ifdef USE_INSTANCING
        wp = instanceMatrix * wp; nm = nm * mat3(instanceMatrix);
      #endif
      wp = modelMatrix * wp; vWPos = wp.xyz; vWNormal = normalize(nm * objectNormal); }`,
    fHead: 'varying vec3 vWPos; varying vec3 vWNormal; uniform float uTriScale; uniform float uMoss; uniform vec3 uMossCol;',
    fMap: `#ifdef USE_MAP
      { vec3 bw = abs(normalize(vWNormal)); bw = pow(bw, vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
        vec3 p = vWPos * uTriScale;
        vec4 tc = texture2D(map, p.zy) * bw.x + texture2D(map, p.xz) * bw.y + texture2D(map, p.xy) * bw.z;
        diffuseColor *= tc;
        float mossA = uMoss * smoothstep(0.25, 0.85, vWNormal.y) * smoothstep(0.35, 0.7, tc.g * 1.6);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uMossCol * 2.2, mossA); }
      #endif`,
  };
}
export const mergePatch = (...ps) => { const o = {}; for (const p of ps) for (const k in p) o[k] = k === 'uniforms' ? { ...(o[k] || {}), ...p[k] } : (o[k] || '') + '\n' + p[k]; return o; };

// ---------------------------------------------------------------- textures
export function rgbaTexture(data, w, h, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = aniso;
  t.needsUpdate = true; return t;
}
/** Procedural RGB(A) texture from fn(u,v) -> [r,g,b] (0..1), tileable if fn is periodic in u,v. */
export function noiseTexture(w, h, fn, opts) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x / w, y / h); const i = (y * w + x) * 4; d[i] = c[0] * 255; d[i + 1] = c[1] * 255; d[i + 2] = c[2] * 255; d[i + 3] = 255; }
  return rgbaTexture(d, w, h, opts);
}
/** Normal map from a height function h(u,v) 0..1 (tileable). */
function normalTexture(w, h, hf, strength = 2) {
  const H = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) H[y * w + x] = hf(x / w, y / h);
  return normalFromHeights(H, w, h, strength);
}
function normalFromHeights(H, w, h, strength) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H[y * w + (x + 1) % w] - H[y * w + (x + w - 1) % w]) * strength * w / 256, dy = (H[((y + 1) % h) * w + x] - H[((y + h - 1) % h) * w + x]) * strength * h / 256;
    const l = Math.hypot(dx, dy, 1); const i = (y * w + x) * 4; d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (-dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  return rgbaTexture(d, w, h, { srgb: false });
}
/** Derive a tiling normal map from an image's luma (ASSETS.md: only albedo is generated). */
export function normalFromLuma(image, size = 512, strength = 3) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size; const c = cv.getContext('2d');
  c.drawImage(image, 0, 0, size, size);
  const px = c.getImageData(0, 0, size, size).data, H = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) H[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
  return normalFromHeights(H, size, size, strength);
}
// tileable noise on a torus: noise2 of periodic coords is not periodic, so we blend 4 shifted samples (cheap seam killer)
export const tn = (u, v, f, seed) => { const a = noise2(u * f, v * f, seed), b = noise2((u - 1) * f, v * f, seed), c = noise2(u * f, (v - 1) * f, seed), d = noise2((u - 1) * f, (v - 1) * f, seed); return lerp(lerp(a, b, u), lerp(c, d, u), v); };
export const tfbm = (u, v, f, seed, oct = 4) => { let s = 0, a = 0.5, n = 0; for (let i = 0; i < oct; i++) { s += a * tn(u, v, f, seed + i * 17); n += a; a *= 0.5; f *= 2; } return s / n; };

function barkTextures(kind, aniso) {
  const W = 256, Hh = 512;
  const hf = kind === 'birch'
    ? (u, v) => 0.5 + 0.25 * tfbm(u, v, 6, 11, 3) + 0.15 * tfbm(u * 1, v * 0.25, 40, 12, 2) // fine horizontal grain
    : (u, v) => { const r = 1 - Math.abs(tn(u, v * 0.3, 14, 21)); return 0.55 - 0.35 * r * r + 0.12 * tfbm(u, v, 24, 22, 3); }; // deep vertical fissures
  let map;
  if (kind === 'birch') {
    map = noiseTexture(W, Hh, (u, v) => {
      const h = hf(u, v); const fl = smoothstep(0.66, 0.78, 0.5 + 0.5 * tn(u * 1, v * 4, 16, 31)) * smoothstep(0.3, 0.7, 0.5 + 0.5 * tn(u, v, 5, 32)); // dark lenticels
      const base = [0.80, 0.79, 0.73].map((c, i) => c * (0.85 + 0.3 * (h - 0.5)) - [0.05, 0.04, 0.02][i] * (1 - h));
      return base.map((c, i) => lerp(c, [0.30, 0.27, 0.24][i], fl * 0.75)); // softened lenticels: relief comes from the bark normal map, not painted-on ink
    }, { aniso });
  } else {
    map = noiseTexture(W, Hh, (u, v) => { const h = hf(u, v); const t = clamp((h - 0.2) / 0.5, 0, 1); return [lerp(0.14, 0.42, t) + 0.04 * t, lerp(0.09, 0.3, t), lerp(0.06, 0.2, t)]; }, { aniso });
  }
  return { map, normalMap: normalTexture(W, Hh, hf, kind === 'birch' ? 2.2 : 3.6) };
}
// Rock albedo. It used to top out near 0.91 (tint 0.80 + a 0.18 quartz speckle), which is not a rock --
// real granite sits at 0.15-0.35 -- and in direct sun a boulder near the camera crossed 212 sRGB
// luminance, i.e. tools/blobcheck.py's "glowing" bar, whose calibration note expects sunlit rock at
// 202-208. Toned to ~0.80 peak: still bright granite, no longer a light source.
function rockTexture(aniso, base = [0.62, 0.60, 0.565], tint = [0.74, 0.70, 0.63], crack = 1) {
  return noiseTexture(256, 256, (u, v) => {
    const cr = (Math.pow(1 - Math.abs(tn(u, v, 9, 42)), 8) * 0.7 + Math.pow(1 - Math.abs(tn(u, v, 17, 43)), 12) * 0.4) * crack; // cracks (crack < 1: frost-shattered granite, not jigsaw veins)
    const n = tfbm(u, v, 6, 41, 5);
    const sp = tn(u, v, 90, 44) > 0.55 ? 0.095 : 0; // quartz speckle (halved: it was the part that clipped)
    const t = 0.5 + n; return base.map((c, i) => clamp(lerp(c, tint[i], t - 0.5) * (1 - cr * 0.6) + sp, 0, 1));
  }, { aniso });
}
/** Fallback leaf cluster / willow strand card texture (used if the painted asset fails to load). */
function leafTexture(kind, rng, base, dark, light, aniso) {
  const S = 256; const cv = document.createElement('canvas'), mk = document.createElement('canvas'); cv.width = cv.height = mk.width = mk.height = S;
  const c = cv.getContext('2d'), m = mk.getContext('2d');
  const css = (k) => `rgb(${k.map((x) => Math.round(clamp(x, 0, 1) * 255)).join(',')})`;
  c.fillStyle = css(base); c.fillRect(0, 0, S, S); m.fillStyle = '#000'; m.fillRect(0, 0, S, S);
  const leaf = (x, y, rx, ry, rot, col) => { for (const [ctx, fill] of [[c, css(col)], [m, '#fff']]) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.fillStyle = fill; ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); } };
  const mix = (t) => dark.map((d, i) => lerp(d, light[i], t));
  if (kind === 'cluster') {
    for (let i = 0; i < 66; i++) {
      const a = -Math.PI / 2 + (rng() - 0.5) * 2.9, len = 55 + rng() * 135, bend = (rng() - 0.5) * 1.4, x0 = 128 + (rng() - 0.5) * 64, y0 = 254 - rng() * 36;
      const nL = 5 + Math.floor(rng() * 5);
      for (let k = 0; k <= nL; k++) {
        const t = k / nL, ang = a + bend * t, x = x0 + Math.cos(ang) * len * t, y = y0 + Math.sin(ang) * len * t;
        if (x < 3 || x > 253 || y < 3) continue;
        const side = k % 2 ? 1 : -1, sh = clamp(0.25 + t * 0.55 + (rng() - 0.5) * 0.45, 0, 1), sz = (0.7 + 0.5 * Math.sin(t * Math.PI)) * (9 + rng() * 6);
        leaf(x + Math.cos(ang + side * 1.1) * sz * 0.55, y + Math.sin(ang + side * 1.1) * sz * 0.55, sz, sz * 0.42, ang + side * 0.75, mix(sh));
        if (rng() < 0.5) leaf(x + Math.cos(ang - side * 1.2) * sz * 0.5, y + Math.sin(ang - side * 1.2) * sz * 0.5, sz * 0.8, sz * 0.36, ang - side * 0.7, mix(clamp(sh + (rng() - 0.5) * 0.3, 0, 1)));
      }
    }
  } else { // hanging strands from the top (canvas y=0 -> v=1)
    for (let s = 0; s < 8; s++) {
      const x0 = 14 + s * 31 + rng() * 8, ph = rng() * 6, len = 205 + rng() * 50;
      for (let y = 0; y < len; y += 3) {
        const xx = x0 + Math.sin(y * 0.045 + ph) * 6; if (rng() < 0.72 * (1 - y / 340)) leaf(xx + (rng() - 0.5) * 9, y, 5.5 + rng() * 3.5, 2.1 + rng(), (rng() < 0.5 ? 0.6 : -0.6) + (rng() - 0.5) * 0.8, mix(rng()));
        if (y % 9 === 0) leaf(xx, y, 1.3, 5, 0, [0.4, 0.35, 0.2]);
      }
    }
  }
  const cd = c.getImageData(0, 0, S, S).data, md = m.getImageData(0, 0, S, S).data, out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const si = ((S - 1 - y) * S + x) * 4, di = (y * S + x) * 4; out[di] = cd[si]; out[di + 1] = cd[si + 1]; out[di + 2] = cd[si + 2]; out[di + 3] = md[si]; }
  return rgbaTexture(out, S, S, { repeat: false, aniso });
}

// ---------------------------------------------------------------- geometry builders
/** Tube along a polyline with per-point radius; outward normals, uv (around, length*vScale).
 *  gnarl > 0 adds radial noise displacement (organic bark relief, kills the smooth-cylinder read). */
function tube(pts, radii, segs = 8, vScale = 0.5, gnarl = 0, uRep = 1) {
  const P = [], N = [], U = [], I = []; const up = new THREE.Vector3(0, 1, 0), t = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), prev = new THREE.Vector3(); let dist = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i < pts.length - 1) t.subVectors(pts[i + 1], pts[i]).normalize(); else t.subVectors(pts[i], pts[i - 1]).normalize();
    if (i > 0) dist += pts[i].distanceTo(pts[i - 1]);
    if (i === 0) a.crossVectors(t, Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up).normalize(); else a.copy(prev).addScaledVector(t, -prev.dot(t)).normalize();
    b.crossVectors(t, a).normalize(); prev.copy(a);
    for (let j = 0; j <= segs; j++) {
      const th = j / segs * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      let r = radii[i];
      if (gnarl) r *= 1 + gnarl * (noise2(c * 1.6 + 5, s * 1.6 + dist * 0.55, 61) - 0.5) * 2 + gnarl * 0.5 * (noise2(c * 4 + 9, s * 4 + dist * 1.7, 62) - 0.5) * 2; // periodic around, varies along length
      p.copy(pts[i]).addScaledVector(a, c * r).addScaledVector(b, s * r); P.push(p.x, p.y, p.z); N.push(a.x * c + b.x * s, a.y * c + b.y * s, a.z * c + b.z * s); U.push(j / segs * uRep, dist * vScale);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) for (let j = 0; j < segs; j++) { const k = i * (segs + 1) + j; I.push(k, k + 1, k + segs + 1, k + 1, k + segs + 2, k + segs + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', F32(P, 3)); g.setAttribute('normal', F32(N, 3)); g.setAttribute('uv', F32(U, 2)); g.setIndex(I); return g.toNonIndexed();
}
/** Sub-crops of the painted leaf-cluster asset. The asset is ONE dense round bush: mapping it whole onto a 3.5 m
 *  card makes every leaf ~7 cm on screen, which mips down to a flat green paddle (the "toy tree" read).
 *  Cropping a ~1/3 window puts leaves at a real ~20 cm and — because every window straddles the bush's edge —
 *  gives each card a ragged organic silhouette instead of a disc. */
const LEAF_CROPS = (() => {
  const out = [];
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2 + 0.37, s = 0.26 + 0.13 * ((i * 5) % 4) / 3;
    const cx = 0.5 + Math.cos(a) * (0.5 - s * 0.44), cy = 0.5 + Math.sin(a) * (0.5 - s * 0.44);
    out.push([clamp(cx - s / 2, 0, 1 - s), clamp(cy - s / 2, 0, 1 - s), s, s]);
  }
  return out;
})();
/** Folded leaf cards: each card = 2 quads bent around its horizontal mid-line.
 *  list: [{c, n, w, h, up?, fold?, flip?, crop?, ao?}] — spherical normals around `center` give soft canopy shading;
 *  flip mirrors the texture, crop picks a LEAF_CROPS window, aLeaf carries (hue jitter, ambient occlusion). */
function cards(list, center, fold = 0.2) {
  const P = [], N = [], U = [], L = []; const up0 = new THREE.Vector3(0, 1, 0), r = new THREE.Vector3(), u = new THREE.Vector3(), u2 = new THREE.Vector3(), q = new THREE.Vector3(), n = new THREE.Vector3();
  for (const k of list) {
    n.copy(k.n).normalize(); const upv = k.up || up0; u.copy(upv).addScaledVector(n, -n.dot(upv)).normalize(); r.crossVectors(u, n).normalize();
    const f = k.fold ?? fold; u2.copy(u).multiplyScalar(Math.cos(f)).addScaledVector(n, Math.sin(f)); // top half tilts toward the normal
    const hw = k.w / 2, hh = k.h / 2, fx = k.flip ? 1 : 0;
    const [cu, cv, cs, ct] = k.crop ?? [0, 0, 1, 1];
    const ml = k.c.clone().addScaledVector(r, -hw), mr = k.c.clone().addScaledVector(r, hw);
    const bl = ml.clone().addScaledVector(u, -hh), br = mr.clone().addScaledVector(u, -hh);
    const tl = ml.clone().addScaledVector(u2, hh), tr = mr.clone().addScaledVector(u2, hh);
    const tint = k.tint ?? 0.5, ao = k.ao ?? 1;
    for (const [co, v0, v1] of [[[bl, br, mr, ml], 0, 0.5], [[ml, mr, tr, tl], 0.5, 1]]) {
      const uvs = [[fx, v0], [1 - fx, v0], [1 - fx, v1], [fx, v1]];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const p = co[i]; P.push(p.x, p.y, p.z); q.subVectors(p, center).normalize(); N.push(q.x, q.y, q.z);
        U.push(cu + uvs[i][0] * cs, cv + uvs[i][1] * ct); L.push(tint, ao);
      }
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', F32(P, 3)); g.setAttribute('normal', F32(N, 3)); g.setAttribute('uv', F32(U, 2)); g.setAttribute('aLeaf', F32(L, 2)); return g;
}
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
function spine(n, fn) { const pts = [], radii = []; for (let i = 0; i <= n; i++) { const [p, r] = fn(i / n); pts.push(p); radii.push(r); } return [pts, radii]; }
/** Push a leaf card with a random crop, hue jitter and depth-based AO (inner cards read darker → volume, not a shelf). */
function card(list, c, n, w, h, rng, o = {}) {
  const d = o.ao ?? 1;
  list.push({ c, n, w: w * (0.82 + rng() * 0.4), h: h * (0.82 + rng() * 0.4), flip: rng() < 0.5, fold: o.fold ?? (0.12 + rng() * 0.26), up: o.up,
    crop: LEAF_CROPS[(rng() * LEAF_CROPS.length) | 0], tint: rng(), ao: d * (0.86 + rng() * 0.14) });
}
function fan(list, center, y, radius, count, w, h, tilt, rng, jitter = 0.35, ao = 1) {
  for (let i = 0; i < count; i++) {
    const a = (i + rng() * 0.9) / count * Math.PI * 2, rr = radius * (0.5 + rng() * 0.75); const out = V3(Math.cos(a), 0, Math.sin(a));
    const c = V3(Math.cos(a) * rr, y + (rng() - 0.5) * jitter * 2, Math.sin(a) * rr);
    const n = out.clone().multiplyScalar(1 - tilt).add(V3(0, tilt, 0)).add(V3(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(0.5));
    card(list, c, n, w, h, rng, { ao: ao * lerp(0.72, 1.0, clamp(rr / radius, 0, 1)) }); // deeper in the crown = less sky light
  }
}
// species 0: tall slender "shroud birch" — long pale trunk, big painterly canopy clusters near the top
function buildSlender(rng) {
  const H = 16, bx = (rng() - 0.5) * 1.6, bz = (rng() - 0.5) * 1.6;
  const [pts, radii] = spine(10, (t) => [V3(Math.sin(t * 2.2) * bx * t, t * H, Math.sin(t * 1.7 + 1) * bz * t), 0.34 * Math.pow(1 - t, 0.85) + 0.06 + (t < 0.08 ? (0.08 - t) * 2.5 : 0)]);
  const parts = [tube(pts, radii, 10, 0.62, 0.16, 2)];
  for (let i = 0; i < 6; i++) { // short upper branches
    const t0 = 0.58 + rng() * 0.34, a = rng() * Math.PI * 2, p0 = pts[Math.round(t0 * 10)].clone(), dir = V3(Math.cos(a), 0.7 + rng() * 0.5, Math.sin(a)).normalize(), L = 1.6 + rng() * 1.6;
    parts.push(tube([p0, p0.clone().addScaledVector(dir, L * 0.5).add(V3(0, 0.2, 0)), p0.clone().addScaledVector(dir, L).add(V3(0, 0.6, 0))], [0.09, 0.06, 0.02], 6, 0.7, 0.1, 1));
  }
  const L = [], cc = V3(0, H * 0.80, 0);
  fan(L, cc, H * 0.58, 2.0, 7, 2.5, 2.1, 0.35, rng, 0.5, 0.8);
  fan(L, cc, H * 0.70, 2.5, 9, 2.7, 2.2, 0.35, rng, 0.5, 0.92);
  fan(L, cc, H * 0.82, 2.4, 9, 2.6, 2.2, 0.5, rng, 0.5, 1.0);
  fan(L, cc, H * 0.94, 1.7, 7, 2.3, 2.0, 0.7, rng, 0.45, 1.0);
  for (let i = 0; i < 4; i++) card(L, V3((rng() - 0.5) * 1.6, H * (1.0 + rng() * 0.06), (rng() - 0.5) * 1.6), V3(rng() - 0.5, 1.1, rng() - 0.5), 2.2, 2.0, rng);
  return { trunk: mergeGeometries(parts), leaves: cards(L, cc), H, W: 9, colR: 0.36, colH: H * 0.7 };
}
// species 1: gnarled old tree — thick twisted trunk, radiating branches, broad crown of painterly clusters
function buildGnarled(rng) {
  const H = 8.5, ph = rng() * 6;
  const [pts, radii] = spine(10, (t) => [V3(Math.sin(t * 5 + ph) * 0.28 * t + t * 0.5, t * H, Math.cos(t * 4.3 + ph) * 0.28 * t), 0.72 * Math.pow(1 - t * 0.85, 1.1) + 0.12 + (t < 0.12 ? (0.12 - t) * 4.5 : 0)]);
  const parts = [tube(pts, radii, 12, 0.55, 0.22, 3)]; const L = [], cc = V3(0.3, H * 0.85, 0);
  for (let i = 0; i < 7; i++) {
    const t0 = 0.45 + rng() * 0.35, a = i / 7 * Math.PI * 2 + rng() * 0.6, p0 = pts[Math.round(t0 * 10)].clone(), d = V3(Math.cos(a), 0, Math.sin(a)), L0 = 2.2 + rng() * 1.6;
    const b = [p0, p0.clone().addScaledVector(d, L0 * 0.35).add(V3(0, 0.5, 0)), p0.clone().addScaledVector(d, L0 * 0.7).add(V3(0, 1.3, 0)), p0.clone().addScaledVector(d, L0).add(V3(0, 2.4, 0))];
    parts.push(tube(b, [0.26, 0.18, 0.11, 0.04], 7, 0.7, 0.16, 1.5));
    const tip = b[3];
    for (let k = 0; k < 4; k++) card(L, tip.clone().add(V3((rng() - 0.5) * 1.5, 0.2 + rng() * 1.3, (rng() - 0.5) * 1.5)),
      V3(d.x * 0.6 + (rng() - 0.5) * 0.7, 0.7, d.z * 0.6 + (rng() - 0.5) * 0.7), 2.6, 2.2, rng, { ao: 0.9 + k * 0.03 });
  }
  fan(L, cc, H * 0.72, 3.0, 9, 2.8, 2.3, 0.4, rng, 0.5, 0.82);
  fan(L, cc, H * 0.88, 2.8, 8, 2.7, 2.3, 0.55, rng, 0.5, 1.0);
  for (let i = 0; i < 5; i++) card(L, V3((rng() - 0.5) * 2.6 + 0.3, H * (1.0 + rng() * 0.08), (rng() - 0.5) * 2.6), V3(rng() - 0.5, 1.1, rng() - 0.5), 2.5, 2.2, rng);
  return { trunk: mergeGeometries(parts), leaves: cards(L, cc), H: H + 1.5, W: 11, colR: 0.75, colH: H * 0.6 };
}
// species 2: willow — leaning trunk, umbrella crown, hanging leaf strands
function buildWillow(rng) {
  const H = 9.5, lean = 0.9 + rng() * 0.6;
  const [pts, radii] = spine(8, (t) => [V3(t * t * lean, t * H, Math.sin(t * 3) * 0.2), 0.5 * (1 - t * 0.7) + 0.05 + (t < 0.1 ? (0.1 - t) * 3 : 0)]);
  const parts = [tube(pts, radii, 10, 0.6, 0.18, 2.5)]; const top = pts[8].clone(); const L = [], cc = top.clone().add(V3(0, -1.5, 0));
  for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2 + rng(), d = V3(Math.cos(a), 0.35, Math.sin(a)).normalize(); parts.push(tube([top.clone().add(V3(0, -0.6, 0)), top.clone().addScaledVector(d, 1.6), top.clone().addScaledVector(d, 2.8).add(V3(0, -0.3, 0))], [0.18, 0.11, 0.04], 6, 0.7, 0.12, 1.5)); }
  for (let i = 0; i < 14; i++) card(L, top.clone().add(V3((rng() - 0.5) * 3.4, 0.1 + rng() * 1.0, (rng() - 0.5) * 3.4)), V3(rng() - 0.5, 1.0, rng() - 0.5), 2.5, 2.1, rng, { ao: 0.88 + rng() * 0.12 });
  const S = []; for (let i = 0; i < 18; i++) { const a = i / 18 * Math.PI * 2 + rng() * 0.3, rr = 2.1 + rng() * 1.2, out = V3(Math.cos(a), 0, Math.sin(a)), h = 4.8 + rng() * 1.8; const att = top.clone().addScaledVector(out, rr).add(V3(0, -0.2 - rng() * 0.5, 0)); S.push({ c: att.clone().add(V3(out.x * 0.4, -h / 2, out.z * 0.4)), n: out, up: V3(out.x * 0.12, 1, out.z * 0.12), w: 1.3 + rng() * 0.4, h, fold: 0.16, tint: rng(), ao: 0.95 }); }
  return { trunk: mergeGeometries(parts), leaves: cards(L, cc), strands: cards(S, cc), H: H + 1.2, W: 9, colR: 0.5, colH: H * 0.7 };
}
/** Rock shapes 0 boulder, 1 rock, 2 slab, 3 shard. Vertex color = cavity shading. */
export function makeRockGeometry(kind, seed = 1) {
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, kind === 0 ? 3 : 2)); const p = g.attributes.position, n = p.count, col = new Float32Array(n * 3), v = new THREE.Vector3();
  const sc = [[1, 0.85, 1.15], [1.25, 0.75, 1], [1.5, 0.45, 1.1], [0.7, 1.7, 0.6]][kind];
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(p, i); const f = 1.4;
    let d = 0.16 * fbm(v.x * f + v.y * 0.7 * f + seed, v.z * f - v.y * 0.5 * f, { octaves: 4, seed: 77 + seed }) + 0.05 * noise2(v.x * 5 + seed, v.z * 5 + v.y * 3, 78);
    if (kind === 3 && v.y > 0) d -= v.y * 0.18 * (Math.abs(v.x) + Math.abs(v.z)); // pointed tip
    v.multiplyScalar(1 + d); v.x *= sc[0]; v.y *= sc[1]; v.z *= sc[2];
    if (kind === 2 && v.y > 0.25) v.y = 0.25 + (v.y - 0.25) * 0.3; // flat top
    p.setXYZ(i, v.x, v.y, v.z); const c = clamp(0.85 + d * 2.0, 0.6, 1.15); col[i * 3] = c; col[i * 3 + 1] = c; col[i * 3 + 2] = c;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
}
/** One aether shard: an irregular 8-sided prism (per-side radius + height jitter) with a chiselled 3-step tip and a
 *  bevelled waist. Irregular sides mean every facet has its OWN normal, so sun/rim/glint break across the shard —
 *  a regular hexagonal cone renders as two flat tones (the "purple confetti" read the critic called out). */
function shardGeometry(rng, h, r) {
  const SIDES = 8, P = [];
  const rad = [], off = [];
  for (let k = 0; k < SIDES; k++) { rad.push(r * (0.62 + rng() * 0.6)); off.push((rng() - 0.5) * 0.16); }
  // profile: [heightFrac, radiusFrac] — flared foot, waist, shoulder, then a 2-step chisel to the point
  const prof = [[0, 0.74], [0.10, 1.0], [0.46, 0.93], [0.70, 0.82], [0.86, 0.5], [1, 0.0]];
  const twist = (rng() - 0.5) * 0.5;
  const pt = (pi, k) => {
    const [t, rf] = prof[pi], a = (k / SIDES) * Math.PI * 2 + twist * t + off[k % SIDES];
    const rr = rad[k % SIDES] * rf;
    return [Math.cos(a) * rr, t * h * (1 + off[k % SIDES] * 0.3), Math.sin(a) * rr];
  };
  for (let pi = 0; pi < prof.length - 1; pi++) for (let k = 0; k < SIDES; k++) {
    const a = pt(pi, k), b = pt(pi, k + 1), c = pt(pi + 1, k + 1), d = pt(pi + 1, k);
    if (prof[pi][1] > 0) P.push(...a, ...b, ...c);
    if (prof[pi + 1][1] > 0) P.push(...a, ...c, ...d);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(P), 3)); return g;
}
function crystalClusterGeometry(rng, n) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const h = (i === 0 ? 1 : 0.3 + rng() * 0.55) * 2.4, r = h * (0.15 + rng() * 0.06);
    const g = shardGeometry(rng, h, r);
    g.rotateX(i === 0 ? rng() * 0.14 : 0.2 + rng() * 0.6); g.rotateY(rng() * Math.PI * 2);
    if (i > 0) g.translate(Math.cos(i * 2.4) * (0.25 + rng() * 0.4) * 1.2, -0.12, Math.sin(i * 2.4) * (0.25 + rng() * 0.4) * 1.2);
    parts.push(g);
  }
  const g = mergeGeometries(parts); g.computeVertexNormals(); return g;
}

// ---------------------------------------------------------------- instanced LOD set
/** Static instances split each refresh into near mesh(es) (+fade) and an optional far mesh, by camera distance. */
export class InstLOD {
  constructor({ near = [], far = null, nearDist = 90, band = 12, maxDist = 1e9, color = false, onNear = null }) {
    Object.assign(this, { near, far, nearDist, band, maxDist, useColor: color, onNear }); this.items = []; this._m = new THREE.Matrix4();
  }
  add(matrix, color = null) { this.items.push({ e: Float32Array.from(matrix.elements), c: color ? [color.r, color.g, color.b] : [1, 1, 1] }); }
  finalize() {
    const n = Math.max(1, this.items.length); this.n = this.items.length;
    this.mats = new Float32Array(n * 16); this.cols = new Float32Array(n * 3); this.xz = new Float32Array(n * 2);
    this.items.forEach((it, i) => { this.mats.set(it.e, i * 16); this.cols.set(it.c, i * 3); this.xz[i * 2] = it.e[12]; this.xz[i * 2 + 1] = it.e[14]; }); this.items = null;
    const alloc = (meshes) => {
      if (!meshes.length) return null;
      const im = new THREE.InstancedBufferAttribute(new Float32Array(n * 16), 16).setUsage(THREE.DynamicDrawUsage), fa = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
      const ic = this.useColor ? new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage) : null;
      for (const m of meshes) { m.instanceMatrix = im; m.geometry.setAttribute('aFade', fa); if (ic) m.instanceColor = ic; m.count = 0; m.frustumCulled = false; }
      return { im, fa, ic };
    };
    this.nearA = alloc(this.near); this.farA = this.far ? alloc([this.far]) : null;
  }
  refresh(cx, cz) {
    const { nearDist: nd, band: b, maxDist: md } = this; let nn = 0, nf = 0; const N = this.nearA, F = this.farA;
    const nd2 = nd * nd, nb = nd + b, nb2 = nb * nb, md2 = md * md, farCap = md < 1e8;
    for (let i = 0; i < this.n; i++) {
      const dx = this.xz[i * 2] - cx, dz = this.xz[i * 2 + 1] - cz, d2 = dx * dx + dz * dz;
      if (N && d2 < nb2) { N.im.array.set(this.mats.subarray(i * 16, i * 16 + 16), nn * 16); N.fa.array[nn] = d2 < nd2 ? 1 : 1 - (Math.sqrt(d2) - nd) / b; if (N.ic) N.ic.array.set(this.cols.subarray(i * 3, i * 3 + 3), nn * 3); nn++; }
      if (F && d2 >= nd2 && d2 < md2) {
        F.im.array.set(this.mats.subarray(i * 16, i * 16 + 16), nf * 16);
        let f = d2 < nb2 ? (Math.sqrt(d2) - nd) / b : 1;
        if (farCap) f = Math.min(f, clamp((md - Math.sqrt(d2)) / (md * 0.1), 0, 1));
        F.fa.array[nf] = f; if (F.ic) F.ic.array.set(this.cols.subarray(i * 3, i * 3 + 3), nf * 3); nf++;
      }
    }
    const up = (A, cnt) => { // upload only the used range (needsUpdate alone re-uploads the whole buffer)
      A.im.needsUpdate = true; A.fa.needsUpdate = true; if (A.ic) A.ic.needsUpdate = true;
      if (cnt > 0 && A.im.clearUpdateRanges) {
        A.im.clearUpdateRanges(); A.im.addUpdateRange(0, cnt * 16);
        A.fa.clearUpdateRanges(); A.fa.addUpdateRange(0, cnt);
        if (A.ic) { A.ic.clearUpdateRanges(); A.ic.addUpdateRange(0, cnt * 3); }
      }
    };
    if (N) { for (const m of this.near) m.count = nn; up(N, nn); }
    if (F) { this.far.count = nf; up(F, nf); }
    this.nearCount = nn; this.farCount = nf;
  }
}

// ---------------------------------------------------------------- the system
export class Vegetation {
  constructor(game) {
    this.game = game; this.trees = []; this.rocks = []; this.crystals = []; this.lods = [];
    this.uniforms = { uTime: { value: 0 }, uWind: { value: 1 }, uSunDirV: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 1, 1) }, uSunI: { value: 1 } };
    this._ri = 0;
  }
  setWind(w) { this.uniforms.uWind.value = w; }

  async init() {
    const { game } = this; const t0 = performance.now();
    const q = game.renderer.qualityPreset, aniso = q.anisotropy;
    const Q = { low: 0.6, medium: 0.8, high: 1 }[game.quality] ?? 1; this.Q = Q;
    const rng = mulberry32(game.seed + 4242);
    // painted assets (ASSETS.md): painterly leaf cluster card + seamless ridged bark, via the preloader (never load files ourselves)
    const leafCard = game.assets?.tex?.('leaf_card') ?? null;
    const bk = game.assets?.tex?.('bark') ?? null;
    const barkAsset = bk ? { map: bk, normalMap: normalFromLuma(bk.image, 512, 4.5) } : null;
    if (!leafCard || !barkAsset) console.warn('[vegetation] painted assets missing, procedural fallback');
    // A frame between each: these are four long synchronous builds and together they were one of the
    // worst blocks on the loading screen (~1.8 s), which the intro cannot paint through.
    this._buildTrees(rng, aniso, Q, leafCard, barkAsset);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildRocks(rng, aniso, Q);
    await new Promise((r) => requestAnimationFrame(r));
    this._buildCrystals(rng, aniso);
    await new Promise((r) => requestAnimationFrame(r));
    this._place(mulberry32(game.seed + 777));
    // ez-tree trees are the DEFAULT (see EZTrees.js): generated variants through the same InstLOD
    // near/impostor contract. ?eztrees=0 restores the legacy card trees.
    if (game.params?.get?.('eztrees') !== '0') {
      const treeLods = new Set(this.treeSets.map((s) => s.lod));
      this.lods = this.lods.filter((l) => !treeLods.has(l));
      for (const s of this.treeSets) for (const m of [...s.lod.near, s.lod.far]) if (m) { m.count = 0; m.visible = false; this.game.scene.remove(m); }
      import('./EZTrees.js').then(({ buildEZTrees }) => buildEZTrees(this.game, this.trees, this));
    }
    for (const l of this.lods) l.finalize();
    console.log(`[vegetation] trees ${this.trees.length} rocks ${this.rocks.length} crystals ${this.crystals.length} in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  _buildTrees(rng, aniso, Q, leafCard, barkAsset) {
    const U = this.uniforms, sc = this.game.scene;
    // birch keeps its pale painted albedo but borrows the painted bark's REAL ridge relief (kills the "smooth cylinder
    // with stripes" read); oak/willow use the painted bark outright.
    const oak = barkAsset ?? barkTextures('oak', aniso);
    const birchProc = barkTextures('birch', aniso);
    const birch = { map: birchProc.map, normalMap: barkAsset ? barkAsset.normalMap : birchProc.normalMap };
    // painterly cluster card for all species (species identity from tint + silhouette), procedural fallback
    const leafTex = leafCard ?? leafTexture('cluster', rng, [0.28, 0.52, 0.22], [0.16, 0.38, 0.14], [0.55, 0.78, 0.3], aniso);
    const strandTex = leafTexture('strands', rng, [0.45, 0.6, 0.24], [0.32, 0.5, 0.18], [0.76, 0.85, 0.4], aniso);
    const leafTint = [0xdcf5b6, 0x9fc088, 0xe8f2a0]; // slender fresh-lime, gnarled deep muted, willow golden-green
    const specs = [buildSlender(rng), buildGnarled(rng), buildWillow(rng)];
    // willow: leaves + strands merged into one geometry/material; strand cards select the strand texture via uv.x offset +2
    specs[2].leaves = (() => { const s = specs[2].strands; const uv = s.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + 2); return mergeGeometries([specs[2].leaves, s]); })();
    const AT = 0.35; // painterly card cutout
    const leafShader = (i) => mergePatch(erodeFade(AT), {
      key: 'leaf' + i,
      uniforms: { uTime: U.uTime, uWind: U.uWind, uSunDirV: U.uSunDirV, uSunColor: U.uSunColor, uSunI: U.uSunI, uHeight: { value: specs[i].H }, uSway: { value: i === 2 ? 0.35 : 0.5 }, tStrand: { value: strandTex } },
      vHead: 'uniform float uTime, uWind, uHeight, uSway; attribute vec2 aLeaf; varying vec2 vLeaf;',
      vBegin: `vLeaf = aLeaf;
        {
        #ifdef USE_INSTANCING
          vec3 iPos = (modelMatrix * instanceMatrix)[3].xyz;
        #else
          vec3 iPos = modelMatrix[3].xyz;
        #endif
        float ph = dot(iPos.xz, vec2(0.21, 0.17));
        float hf = clamp(position.y / uHeight, 0.0, 1.0); hf *= hf;
        float g = uWind * (0.65 + 0.35 * sin(uTime * 0.35 + ph * 0.5));
        vec3 sw = vec3(sin(uTime * 1.3 + ph) * 0.35 + sin(uTime * 2.7 + ph * 1.9 + position.y * 0.7) * 0.15,
                       sin(uTime * 2.1 + ph * 1.3 + position.x) * 0.08,
                       cos(uTime * 1.1 + ph * 0.8) * 0.3 + cos(uTime * 3.1 + ph + position.z) * 0.12);
        transformed += sw * g * hf * uSway; }`,
      fHead: `uniform vec3 uSunDirV; uniform vec3 uSunColor; uniform float uSunI; uniform sampler2D tStrand; varying vec2 vLeaf;
        const vec3 LEAF_COOL = vec3(0.72, 0.98, 0.74);   // shaded blue-green
        const vec3 LEAF_WARM = vec3(1.24, 1.02, 0.60);   // sun-bleached golden`,
      fMap: `{ vec4 tc = vMapUv.x > 1.5 ? texture2D(tStrand, vec2(vMapUv.x - 2.0, vMapUv.y)) : texture2D(map, vMapUv); diffuseColor *= tc;
        diffuseColor.rgb *= mix(LEAF_COOL, LEAF_WARM, vLeaf.x) * (0.55 + 0.45 * vLeaf.y); }`, // per-card hue break-up + crown AO
      fEmissive: `{ vec3 Vd = normalize(vViewPosition);                       // fragment -> camera
        float back = max(dot(-Vd, uSunDirV), 0.0);                             // sun behind the leaf, shining at us
        float ndl  = dot(normalize(normal), uSunDirV);
        float thin = 1.0 - abs(ndl);                                           // grazing = thinnest path through the blade
        vec3 sap = diffuseColor.rgb * mix(vec3(0.85, 1.15, 0.55), vec3(1.0), 0.35);
        totalEmissiveRadiance += sap * uSunColor * uSunI *
          (pow(back, 2.2) * 1.15 * (0.35 + 0.65 * thin) + max(0.0, ndl + 0.45) / 1.45 * 0.16 + 0.07) * vLeaf.y; }`,
    });
    this.treeSets = specs.map((sp, i) => {
      const bark = i === 0 ? birch : oak;
      const trunkMat = patchMaterial(new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, normalScale: new THREE.Vector2(i === 0 ? 1.5 : 2.4, i === 0 ? 1.5 : 2.4), roughness: 0.94, metalness: 0, color: i === 0 ? 0xffffff : i === 2 ? 0xbfae95 : 0xc9b89e }),
        mergePatch(fadePatch, { key: 'trunk' + i,
          // root darkening + damp moss creeping up the first metre: grounds the trunk, kills the "clean dowel" read
          fMap: `#include <map_fragment>
            { float up0 = clamp(vMapUv.y * 1.1, 0.0, 1.0);
              diffuseColor.rgb *= mix(0.55, 1.0, up0);
              diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.62, 0.95, 0.5), diffuseColor.rgb, clamp(up0 * 1.6 - 0.15, 0.0, 1.0)); }` }));
      const leafMat = patchMaterial(new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: AT, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, color: leafTint[i] }), leafShader(i));
      const leafDepth = patchMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: AT + 0.08, side: THREE.DoubleSide }), leafShader(i));
      leafDepth.customProgramCacheKey = () => 'leafdepth' + i;
      // impostor: bake a side view of the tree into a texture once, draw far trees as camera-facing quads.
      // Clear color = canopy albedo so mip dilution at distance tints toward lit foliage, never toward black.
      const clearCols = [[0.34, 0.46, 0.20], [0.24, 0.34, 0.15], [0.40, 0.48, 0.20]];
      const impTex = this._bakeImpostor(sp, bark, leafTex, strandTex, Q >= 1 ? 512 : 256, clearCols[i], leafTint[i]);
      const impMat = patchMaterial(new THREE.MeshStandardMaterial({ map: impTex, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 1, metalness: 0, color: 0xffffff }), mergePatch(erodeFade(0.3), {
        key: 'impostor',
        vNormal: `vec3 iC0 = (modelMatrix * instanceMatrix)[3].xyz; vec3 tc0 = cameraPosition - iC0; tc0.y = 0.0; tc0 = normalize(tc0 + vec3(0.0, 0.0, 1e-4));
          vec3 objectNormal = normalize(vec3(0.0, 1.0, 0.0) + tc0 * 0.8);`,
        vDefNormal: 'vec3 transformedNormal = normalMatrix * objectNormal;',
        vProject: `vec3 iC = (modelMatrix * instanceMatrix)[3].xyz; float iS = length(instanceMatrix[1].xyz);
          float sgn = fract(dot(iC.xz, vec2(0.317, 0.731))) < 0.5 ? -1.0 : 1.0;      // mirrored variants break silhouette repetition
          vec3 toC = cameraPosition - iC; toC.y = 0.0; toC = normalize(toC + vec3(0.0, 0.0, 1e-4)); vec3 rgt = vec3(-toC.z, 0.0, toC.x);
          vec3 wp = iC + rgt * (position.x * iS * sgn) + vec3(0.0, position.y * iS, 0.0);
          vec4 mvPosition = viewMatrix * vec4(wp, 1.0); gl_Position = projectionMatrix * mvPosition;`,
      }));
      const trunk = new THREE.InstancedMesh(sp.trunk, trunkMat, 8), leaves = new THREE.InstancedMesh(sp.leaves, leafMat, 8), imp = new THREE.InstancedMesh(new THREE.PlaneGeometry(sp.W, sp.H).translate(0, sp.H / 2, 0), impMat, 8);
      // shadows: canopy casts (that is the shadow that reads); trunks skip the shadow pass — saves 3 meshes x 3 CSM cascades
      trunk.castShadow = false; leaves.castShadow = true; trunk.receiveShadow = leaves.receiveShadow = true; leaves.customDepthMaterial = leafDepth; imp.receiveShadow = false;
      trunk.name = 'tree-trunk-' + i; leaves.name = 'tree-leaves-' + i; imp.name = 'tree-impostor-' + i;
      sc.add(trunk, leaves, imp);
      const lod = new InstLOD({ near: [trunk, leaves], far: imp, nearDist: 62 * Q, band: 14, color: true }); this.lods.push(lod); // 46 m put flat impostor quads in the mid-field — the "toy trees" read; 62 m keeps real canopies through the whole readable range
      return { spec: sp, lod, trunk, leaves, imp };
    });
  }
  _bakeImpostor(sp, bark, leafTex, strandTex, res, clearCol = [0.3, 0.5, 0.22], tint = 0xffffff) {
    // bake pure albedo (flat ambient PI, tone mapping off) so the impostor is re-lit by the scene exactly like near trees.
    const r = this.game.renderer, sc = new THREE.Scene();
    const tm = new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, roughness: 0.9 });
    const lm = new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.85, color: tint });
    tm.toneMapped = false; lm.toneMapped = false;
    lm.onBeforeCompile = (sh) => { // mirror the near-tree per-card hue/AO break-up so impostors match the trees they replace
      sh.uniforms.tStrand = { value: strandTex };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aLeaf; varying vec2 vLeaf;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLeaf = aLeaf;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tStrand; varying vec2 vLeaf;')
        .replace('#include <map_fragment>', `{ vec4 tc = vMapUv.x > 1.5 ? texture2D(tStrand, vec2(vMapUv.x - 2.0, vMapUv.y)) : texture2D(map, vMapUv); diffuseColor *= tc;
          diffuseColor.rgb *= mix(vec3(0.72, 0.98, 0.74), vec3(1.24, 1.02, 0.60), vLeaf.x) * (0.55 + 0.45 * vLeaf.y); }`); };
    lm.customProgramCacheKey = () => 'bakeleaf';
    sc.add(new THREE.Mesh(sp.trunk, tm), new THREE.Mesh(sp.leaves, lm), new THREE.AmbientLight(0xffffff, Math.PI)); // lambert /pi * PI = albedo
    const cam = new THREE.OrthographicCamera(-sp.W / 2, sp.W / 2, sp.H, 0, 0.1, 400); cam.position.set(0, 0, 200); cam.lookAt(0, 0, 0);
    const rt = new THREE.WebGLRenderTarget(res, res, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
    const prevRT = r.getRenderTarget(), prevC = new THREE.Color(), prevA = r.getClearAlpha(); r.getClearColor(prevC);
    r.setRenderTarget(rt); r.setClearColor(new THREE.Color().setRGB(clearCol[0], clearCol[1], clearCol[2], THREE.SRGBColorSpace), 0); r.clear(); r.render(sc, cam);
    r.setRenderTarget(prevRT); r.setClearColor(prevC, prevA);
    tm.dispose(); lm.dispose(); rt.texture.anisotropy = 8; return rt.texture; // linear albedo (NoColorSpace) — correct as map input
  }
  _buildRocks(rng, aniso, Q) {
    const rockTex = rockTexture(aniso); this.rockTexture = rockTex;
    const A = (k) => this.game.assets?.tex?.(k) ?? null;
    // One material per region GROUP (BROCK.grp), same 4 geometries. `moss` reuses the triplanar up-face
    // term; for tundra its colour is snow, so domes get a white dusting instead of olive moss.
    const GROUPS = {
      default:   { map: rockTex,                                                          tri: 0.28, moss: 0.55 },
      tundra:    { map: rockTexture(aniso, [0.55, 0.57, 0.61], [0.66, 0.68, 0.73], 0.3),  tri: 0.28, moss: 0.95, mossCol: [0.52, 0.54, 0.58] },
      celestial: { map: A('marble_strata'),   tri: 0.20, moss: 0 },
      dragon:    { map: A('granite_detail'),  tri: 0.30, moss: 0 },
      infernal:  { map: A('basalt_columnar'), tri: 0.22, moss: 0 },
      lost:      { map: A('megalith_violet'), tri: 0.20, moss: 0 },
      void:      { map: A('voidstone'),       tri: 0.22, moss: 0 },
    };
    this.rockGeos = [0, 1, 2, 3].map((k) => makeRockGeometry(k, k * 3 + 1));
    // InstLOD.finalize writes an aFade attribute onto the mesh's geometry, so groups cannot share geometry
    // objects — alias the buffers (same position/normal/color/index, own aFade stream), zero copies.
    const alias = (g) => { const ng = new THREE.BufferGeometry(); for (const k in g.attributes) ng.setAttribute(k, g.attributes[k]); ng.setIndex(g.index); return ng; };
    const near = [320, 130, 130, 130];
    this.rockSets = [];      // FLAT list (Props._pruneCelestialRocks iterates it) — all groups' LODs
    this._rockGrp = {};      // group name -> [lod kind 0..3], used at placement time
    for (const [gname, cfg] of Object.entries(GROUPS)) {
      if (!cfg.map) continue;   // asset missing -> the region falls back to default at placement time
      const mat = patchMaterial(new THREE.MeshStandardMaterial({ map: cfg.map, vertexColors: true, roughness: 0.95, metalness: 0.02 }),
        mergePatch(fadePatch, triplanarPatch(cfg.tri, cfg.moss, cfg.mossCol), { key: 'rock-' + gname }));
      this._rockGrp[gname] = this.rockGeos.map((g, k) => {
        const m = new THREE.InstancedMesh(gname === 'default' ? g : alias(g), mat, 8);
        m.castShadow = k === 0; // only the big boulders cast — small rocks hug the ground, their shadow is invisible but costs 3 cascade draws
        m.receiveShadow = true; m.name = `rocks-${gname}-${k}`; this.game.scene.add(m);
        const lod = new InstLOD({ near: [m], nearDist: near[k] * Q, band: 30, color: true }); this.lods.push(lod); this.rockSets.push(lod); return lod;
      });
    }
  }
  _buildCrystals(rng, aniso) {
    const U = this.uniforms;
    // FF14 daylight read: deep saturated body, per-facet albedo contrast, internal streaks, thin normalized
    // white rim + sparse sun glints (normalize(uSunColor) caps HDR blowout — no more purple->white washout).
    // Clearcoat 0.85 / roughness 0.12 / env 1.6 put a mirror on every facet, and a shard a few metres from the
    // camera came back as a pale near-white slab whatever colour its body was — the same shape of bug as the
    // glossy grass tips (CLAUDE.md: cap the VALUE, saturate the COLOUR). Toned so the facets still catch the
    // sun without becoming the light source.
    const mat = patchMaterial(new THREE.MeshPhysicalMaterial({ color: 0x3a2a9e, emissive: 0x3616e0, emissiveIntensity: 1.0, roughness: 0.30, metalness: 0.0, flatShading: true, clearcoat: 0.48, clearcoatRoughness: 0.30, envMapIntensity: 1.0 }), {
      key: 'crystal', uniforms: { uTime: U.uTime, uSunI: U.uSunI, uSunColor: U.uSunColor, uSunDirV: U.uSunDirV },
      vHead: 'varying float vPh; varying float vLy; flat varying vec3 vFN;', vBegin: `
        #ifdef USE_INSTANCING
          vPh = fract(dot(instanceMatrix[3].xz, vec2(0.137, 0.291)));
        #else
          vPh = 0.0;
        #endif
        vLy = position.y; vFN = objectNormal;`,
      fHead: `uniform float uTime; uniform float uSunI; uniform vec3 uSunColor; uniform vec3 uSunDirV; varying float vPh; varying float vLy; flat varying vec3 vFN;
        float facetHash(vec3 n){ return fract(sin(dot(n, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        vec3 gTint = vec3(0.42, 0.30, 1.00);`,
      fMap: `{
        // Instance HUE, taken once for the whole fragment (map runs before emissive). Everything that
        // used to be hardcoded aether violet reads off this, so an ice shard, a coral fan and a void
        // splinter stop looking like the same meadow crystal. Normalising to the brightest channel takes
        // the hue and leaves the value alone: saturate the colour, never raise it (CLAUDE.md law).
        #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          gTint = vColor.rgb;
          // SATURATE, then normalise. Normalising alone keeps the hue but NOT the chroma, and a pale
          // instance colour — the meadow's own cyan-to-magenta jitter runs up to (0.9, 0.85, 1.0) — comes
          // out near-white, so the glow tone-maps to a white ball instead of its colour. The gate caught
          // exactly that at hour 17 in the spawn meadow, which is the decree's bug by name. Chroma is pushed
          // away from grey first; the value is untouched (the ceiling below is unchanged).
          float tL = dot(gTint, vec3(0.2126, 0.7152, 0.0722));
          gTint = max(vec3(0.0), tL + (gTint - tL) * 2.2);
          gTint /= max(max(gTint.r, max(gTint.g, gTint.b)), 1e-3);
        #endif
        float fh = facetHash(vFN);                                                       // stable per-facet value (flat normals)
        float tipT = clamp(vLy / 2.2, 0.0, 1.0);
        diffuseColor.rgb *= 0.30 + 1.05 * fh;                                            // hard facet-to-facet albedo steps: the faces must read apart in flat sun
        diffuseColor.rgb *= 0.86 + 0.30 * sin(vLy * 7.5 + fh * 19.0);                    // internal growth banding
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (vec3(0.55) + gTint * 0.95), fh * 0.6 + tipT * 0.3);
        // PALE SPIRES (Frostveil ice): a near-white instance tint means "this is ICE, not aether" — the
        // body swaps its deep violet albedo for pale glacial, so daylight facets read frost instead of
        // opaque royal sapphire (wave-1+2 tundra verdicts). Facet steps + growth banding stay, in white.
        // The translucent read comes from tint SATURATION (rim/backlight in the pale ice hue), not emissive.
        #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
        float paleT = smoothstep(0.86, 0.96, dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722)));
        diffuseColor.rgb = mix(diffuseColor.rgb,
          vec3(0.72, 0.80, 0.90) * (0.55 + 0.45 * fh) * (0.88 + 0.18 * sin(vLy * 6.0 + fh * 17.0)), paleT);
        #endif }`,
      fEmissive: `{ float day = clamp(uSunI, 0.0, 1.0);
        vec3 tintC = gTint;
        float pulse = 0.78 + 0.22 * sin(uTime * 1.4 + vPh * 6.2832);
        vec3 Vd = normalize(vViewPosition);                                      // fragment -> camera
        vec3 Nn = normalize(normal);
        float fres = pow(1.0 - clamp(abs(dot(Vd, Nn)), 0.0, 1.0), 2.2);          // broad Fresnel: a rim you can actually see at noon
        float fh = facetHash(vFN);
        float grad = mix(1.2, 0.45, clamp(vLy / 2.2, 0.0, 1.0));                 // bright core at the base, cool tips
        float streak = 0.82 + 0.3 * sin(vLy * 7.0 + fh * 21.0);
        float back = max(dot(-Vd, uSunDirV), 0.0);                               // sun behind the shard, shining through
        float glint = pow(max(dot(reflect(-uSunDirV, Nn), Vd), 0.0), 26.0);      // per-facet sun sparkle
        vec3 sunN = uSunColor / max(max(uSunColor.r, max(uSunColor.g, uSunColor.b)), 1e-3);
        float eL = dot(totalEmissiveRadiance, vec3(0.2126, 0.7152, 0.0722));           // keep the body's brightness, take the instance's hue
        vec3 e = eL * 2.0 * tintC * pulse * grad * streak * mix(1.0, 0.20, day)         // by day the inner glow yields to facet shading
          + 0.78 * tintC * fres * (0.5 + 0.5 * pulse) * mix(1.0, 0.55, day)             // rim in the shard's own colour, day and night
          + mix(sunN, tintC, 0.55) * fres * fres * 0.70 * day                           // thin hot edge where the sun grazes
          + 0.82 * tintC * pow(back, 2.0) * (0.35 + 0.65 * fh) * day * 1.1              // translucency through the body
          + mix(sunN, tintC, 0.50) * glint * (0.35 + 0.5 * fh) * day * 0.75;            // ...and the facet sparkle
        // Both sun terms are pulled toward the shard's own colour. Left as raw sun they are white-gold, and a
        // white-gold facet glint a few metres from the camera in the meadow is the decree's blob by every
        // measure the gate uses (it caught one at 252,228,181). A crystal sparkles in its own hue.
        totalEmissiveRadiance = min(e, vec3(2.1)); }`,                                 // hard cap: bloom must never wash a facet to flat white
    });
    this.crystalMat = mat;
    this.crystalSets = [7, 5, 9].map((n, i) => { const m = new THREE.InstancedMesh(crystalClusterGeometry(rng, n), mat, 8); m.castShadow = false; /* emissive: shadows add nothing */ m.receiveShadow = true; m.name = 'crystals-' + i; this.game.scene.add(m); const lod = new InstLOD({ near: [m], nearDist: 520, band: 60, color: true }); this.lods.push(lod); return lod; });
  }

  // ------------------------------------------------------------ placement (deterministic, biome driven)
  _place(rng) {
    const { terrain } = this.game, col = this.game.world.colliders, wl = terrain.waterLevel, half = terrain.size / 2 - 10;
    const bb = {}, B = (x, z) => (terrain.biomeBlend ? terrain.biomeBlend(x, z, bb) : NO_BIOME);
    const M = new THREE.Matrix4(), P = new THREE.Vector3(), Qt = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler(), C = new THREE.Color();
    const lakeD = (x, z) => Math.hypot(x + 170, z + 70), ruinD = (x, z) => Math.hypot(x - 140, z - 60), arenaD = (x, z) => Math.hypot(x + 60, z - 260), aethD = (x, z) => Math.hypot(x, z + 28);
    const ok = (x, z) => Math.abs(x) < half && Math.abs(z) < half;
    // ---- trees
    const treeSpec = this.treeSets.map((s) => s.spec);
    for (let gx = -half; gx < half; gx += 7) for (let gz = -half; gz < half; gz += 7) {
      const x = gx + (rng() - 0.5) * 6, z = gz + (rng() - 0.5) * 6; if (!ok(x, z)) continue;
      const r0 = Math.hypot(x, z);
      // aetheryte plaza: 22 m, not 14 — a gnarled crown is ~7 m wide, so a legally-placed trunk at 14-16 m
      // still tangled its canopy through the pedestal + crystal (crit2-vale-c/shot-aetheryte-tree-up).
      // Plaza hard floor is r>=12 around (0,-28); trees need plaza + crown + margin.
      if (r0 < 34 || ruinD(x, z) < 58 || arenaD(x, z) < 55 || aethD(x, z) < 22) continue;
      const forest = smoothstep(-170, -215, z) * smoothstep(275, 235, Math.abs(x)) * smoothstep(-470, -420, z);
      const grove = smoothstep(0.12, 0.45, fbm(x * 0.009, z * 0.009, { octaves: 3, seed: 9 }));
      let p = forest * 0.62 + (1 - forest) * (grove * 0.22 + 0.012);
      if (r0 < 95) p *= 0.2; if (x > 220) p *= 0.3; if (ruinD(x, z) < 80) p *= 0.25;
      if (r0 > 300) p *= smoothstep(430, 320, r0);                      // home-bowl groves stop at the mountain feet
      const road = terrain.roadAt?.(x, z) ?? 0;                         // nothing grows in the pass roads
      if (road > 0.35) continue;
      const bt = B(x, z), bTree = bt.w > 0.02 ? BTREE[bt.id] : null;    // outer biome takes over its own canopy
      // `gv` is the FLOOR under the grove noise. Without one, grove2 returns 0 across whole stretches and the
      // region's heart is an open lawn with a treeline around it — which is a meadow, not a forest. A closed
      // canopy needs trees between the groves too; the noise should vary density, not switch it off.
      // The floor fades DOWN toward the region edge: full-strength gv at the heart keeps the closed canopy,
      // but at the edge band a uniform floor over a 7 m lattice read as orchard rows on open ground
      // (crit2-forest-c/shot-lowsun-west) — there the grove noise takes over and trees CLUMP instead.
      if (bTree) { const gv = (bTree.gv ?? 0) * smoothstep(0.30, 0.85, bt.w); p = p * (1 - bt.w) + bTree.p * (gv + (1 - gv) * grove2(x, z)) * bt.w; }
      const u0 = rng(); if (u0 > Math.max(p, 0.22)) continue; // cheap reject before the (costlier) height/slope queries
      const y = terrain.heightAt(x, z); if (y > 190 || y < wl + 0.4) continue;
      const shore = y < wl + 2.6 && lakeD(x, z) < 120; if (shore) p = 0.22;
      if (u0 > p) continue;
      if (terrain.slopeAt(x, z) > (bTree?.sMax ?? 0.5)) continue;      // per-biome slope gate: no pines pasted on the glacier face / sheer dragon domes
      if (bTree?.yMax !== undefined && y > bTree.yMax) continue;       // altitude band: dragon pines on LOW ledges only, tundra treeline below the massif
      if (Math.hypot(x - 118, z + 96) < 36) continue;                  // Hearthfall hamlet: cottages sit 13-24 m from (118,-96) + eaves + canopy overhang — trees were growing through hut roofs
      let species; const u = rng();
      if (bTree) {
        // a region's pool owns ALL of its trees. The old `bt.w > 0.45` gate let the Vale's green species
        // leak in wherever the weight dipped — which is exactly the "living green trees all over the
        // Infernal Wastes" spec violation. Below w 0.02 there is no bTree and home logic applies as before.
        species = bTree.sp[(u * bTree.sp.length) | 0];
        if (bTree.og && rng() < bTree.og * (0.35 + 0.65 * bt.w)) species = 5;   // old-growth share keeps a floor at the edges: the western band was ALL uniform young trees (w-proportional share ~0 there), which is half of the orchard-rows read
      }
      else if (shore) species = 2; else if (forest > 0.5) species = u < 0.72 ? 0 : 1; else species = u < 0.45 ? 0 : 1;
      const sp = treeSpec[species] ?? treeSpec[species === 3 || species === 6 ? 0 : 1];
      const scale = species === 0 ? 0.8 + rng() * 0.55 : species === 1 ? 0.75 + rng() * 0.5 : species === 3 || species === 6 ? 0.7 + rng() * 0.6 : species === 5 ? 0.9 + rng() * 0.35 : 0.8 + rng() * 0.4;
      E.set((rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08); Qt.setFromEuler(E); P.set(x, y - 0.25 * scale, z); S.setScalar(scale); M.compose(P, Qt, S);
      // per-instance hue jitter, then pushed toward the REGION's foliage colour by the biome weight
      const tj = 0.76 + rng() * 0.44;
      let cr = tj * (0.86 + rng() * 0.3), cg = tj, cb = tj * (0.8 + rng() * 0.32);
      if (bTree?.col) { const k = bTree.col, w = bt.w; cr *= 1 + (k[0] - 1) * w; cg *= 1 + (k[1] - 1) * w; cb *= 1 + (k[2] - 1) * w; }
      if (bTree && bt.id === 'forest' && rng() < 0.18) { cr *= 0.78; cb *= 1.24; }   // the enchanted accent: a scatter of blue-teal crowns in the deep green
      C.setRGB(cr, cg, cb);
      (this.treeSets[species] ?? this.treeSets[species === 3 || species === 6 ? 0 : 1]).lod.add(M, C);
      const r = Math.max(0.28, sp.colR * scale * (species === 5 ? 1.5 : 1));
      // `c` (leaf tint) rides along for EZTrees, but ONLY for region-owned trees — the home Vale keeps
      // EZTrees' own neutral jitter so this change cannot shift the spawn meadow's read.
      this.trees.push(bTree ? { x, y, z, species, scale, r, c: [C.r, C.g, C.b] } : { x, y, z, species, scale, r });
      col.add({ type: 'capsule', a: new THREE.Vector3(x, y - 1, z), b: new THREE.Vector3(x, y + sp.colH * scale, z), r });
    }
    // ---- rocks
    for (let gx = -half; gx < half; gx += 10) for (let gz = -half; gz < half; gz += 10) {
      const x = gx + (rng() - 0.5) * 9, z = gz + (rng() - 0.5) * 9; if (!ok(x, z)) continue;
      const r0 = Math.hypot(x, z); if (r0 < 18 || aethD(x, z) < 12 || arenaD(x, z) < 48) continue;
      const y = terrain.heightAt(x, z); if (y < wl - 1) continue; const slope = terrain.slopeAt(x, z); if (slope > 0.75) continue;
      const rd = ruinD(x, z); let p = 0.04 + smoothstep(20, 60, y) * 0.03 + smoothstep(0.15, 0.45, slope) * 0.05; if (y > 50) p *= 0.4;
      if (rd < 45) p = rd < 12 ? 0 : 0.35; if (x > 220 && r0 < 400) p += 0.1; if (r0 < 60) p *= 0.5; if (lakeD(x, z) < 110 && y < wl + 3) p += 0.12;
      if ((terrain.roadAt?.(x, z) ?? 0) > 0.35) continue;
      const br = B(x, z), bRock = br.w > 0.02 ? BROCK[br.id] : null;
      if (bRock) p = p * (1 - br.w) + bRock.p * br.w;
      // the frozen lake at the Frostveil heart is a raised flat ICE SHEET now — keep it ice, not a rock
      // yard (the wave-2 "floating boulders litter the lake bowl" frame was mostly rocks strewn there)
      if (bRock && br.id === 'tundra' && y < wl + 2.5 && slope < 0.06) p *= 0.12;
      if (rng() > p) continue;
      const big = rng() < (slope > 0.2 || y > 30 ? 0.35 : 0.15) && rd > 45;
      const kind = big ? 0 : 1 + Math.floor(rng() * 3); const scale = big ? 2.2 + rng() * 3 : (rd < 45 ? 0.35 + rng() * 0.7 : 0.5 + rng() * 1.3);
      if (big) { // no pine through a dome boulder (crit2-tundra/crop-dome): big rocks yield to standing trees
        const rr = 1.1 * scale + 0.8; let hit = false;
        for (const t of this.trees) if (Math.abs(t.x - x) < rr && Math.abs(t.z - z) < rr) { hit = true; break; } // ponytail: linear scan, ~500 big rocks x ~5k trees once at boot; grid-hash if it ever shows in the boot profile
        if (hit) continue;
      }
      E.set((rng() - 0.5) * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.5); Qt.setFromEuler(E);
      // seat on the LOWEST ground under the base ring, not the centre sample: centre-only seating left
      // boulders hovering off downhill edges (tundra lake bowl floaters, the dragon crest slab)
      let yb = y; { const rr = scale * 0.7; for (let a = 0; a < 3; a++) { const th = a * 2.0944 + 0.5; yb = Math.min(yb, terrain.heightAt(x + Math.cos(th) * rr, z + Math.sin(th) * rr)); } }
      P.set(x, yb - 0.3 * scale, z); S.setScalar(scale); M.compose(P, Qt, S);
      const g = 0.75 + rng() * 0.35; C.setRGB(g * (1 + (rng() - 0.5) * 0.1), g, g * (1 - rng() * 0.08));
      if (bRock) { const t = bRock.col; C.setRGB(C.r * lerp(1, t[0], br.w), C.g * lerp(1, t[1], br.w), C.b * lerp(1, t[2], br.w)); }
      const grp = (bRock?.grp && this._rockGrp[bRock.grp] && br.w > 0.35) ? bRock.grp : 'default';
      this._rockGrp[grp][kind].add(M, C); this.rocks.push({ x, y, z, kind, scale });
      col.add({ type: 'sphere', pos: new THREE.Vector3(x, yb - 0.15 * scale, z), r: scale * (kind === 0 ? 0.95 : kind === 2 ? 0.9 : 0.75) });
    }
    // ---- crystals: east fields + forest + around the aetheryte (no random confetti on open hillsides)
    const addCrystal = (x, z, scale, variant, tint, aspect) => {
      const y = terrain.heightAt(x, z); E.set((rng() - 0.5) * 0.2, rng() * Math.PI * 2, (rng() - 0.5) * 0.2); Qt.setFromEuler(E);
      const ax = aspect ? aspect[0] : 1, ay = aspect ? aspect[1] : 1;
      // seat on the lowest ground under the cluster footprint (same anti-float rule as the rocks: a
      // centre-sampled shard on the tundra lake slope hung its base over downhill air)
      let yb = y; { const rr = scale * ax * 0.55; for (let a = 0; a < 3; a++) { const th = a * 2.0944 + 1.1; yb = Math.min(yb, terrain.heightAt(x + Math.cos(th) * rr, z + Math.sin(th) * rr)); } }
      P.set(x, yb - 0.12 * scale * ay, z); S.set(scale * ax, scale * ay, scale * ax); M.compose(P, Qt, S);
      const hue = rng();
      if (tint) { const j = 0.88 + hue * 0.24; C.setRGB(tint[0] * j, tint[1] * j, tint[2] * j); }   // biome spire: ice / obsidian / coral / void shard
      else C.setRGB(0.55 + hue * 0.5, 0.85 - hue * 0.3, 1.0); // cyan-blue .. magenta
      this.crystalSets[variant].add(M, C); this.crystals.push({ x, y, z, scale });
      col.add({ type: 'sphere', pos: new THREE.Vector3(x, y + 0.4 * scale, z), r: scale * 0.75 });
    };
    for (let gx = -half; gx < half; gx += 11) for (let gz = -half; gz < half; gz += 11) {
      const x = gx + (rng() - 0.5) * 10, z = gz + (rng() - 0.5) * 10; if (!ok(x, z)) continue;
      const r0 = Math.hypot(x, z); if (r0 < 22 || ruinD(x, z) < 40 || arenaD(x, z) < 50 || aethD(x, z) < 12) continue;   // plaza clearance r>=12 (props-B measured ask)
      const y = terrain.heightAt(x, z); if (y < wl + 0.3 || y > 110 || terrain.slopeAt(x, z) > 0.6) continue;
      const home = smoothstep(400, 300, r0);
      const field = smoothstep(215, 250, x) * smoothstep(0.05, 0.4, 0.5 + 0.5 * fbm(x * 0.02, z * 0.02, { octaves: 3, seed: 19 })) * home;
      const forest = smoothstep(-180, -220, z) * smoothstep(270, 240, Math.abs(x)) * home;
      let p = field * 0.38 * smoothstep(80, 45, y) + forest * 0.025;   // fields stay off the snowy slopes
      if ((terrain.roadAt?.(x, z) ?? 0) > 0.35) continue;
      const bc = B(x, z), bSpire = bc.w > 0.02 ? BSPIRE[bc.id] : null;
      if (bSpire) p = p * (1 - bc.w) + bSpire.p * bc.w * smoothstep(0.05, 0.4, 0.5 + 0.5 * fbm(x * 0.016, z * 0.016, { octaves: 3, seed: 23 }));
      if (rng() > p) continue;
      const scale = bSpire && bc.w > 0.4 ? bSpire.s[0] + rng() * (bSpire.s[1] - bSpire.s[0])
        : field > 0.3 ? 2.6 + rng() * 2.6 : 0.9 + rng() * 1.1;
      const own = bSpire && bc.w > 0.4;
      addCrystal(x, z, scale, Math.floor(rng() * 3), own ? bSpire.col : null, own ? bSpire.a : null);
    }
    // hero formations: a handful of towering (8-13 m) clusters in the eastern fields — FF14 landmark scale
    // (home bowl only; each outer biome gets its own landmark from Props)
    let heroes = 0;
    for (let i = 0; i < 300 && heroes < 9; i++) {
      const x = 235 + rng() * 140, z = -150 + rng() * 300;
      if (!ok(x, z) || arenaD(x, z) < 55 || ruinD(x, z) < 55) continue;
      const y = terrain.heightAt(x, z); if (y < wl + 0.5 || y > 75 || terrain.slopeAt(x, z) > 0.45) continue;
      addCrystal(x, z, 3.4 + rng() * 2.0, 2); heroes++;
    }
    // plaza-ring crystals pushed to >= 10.9 m from plaza centre (0,-28): at 8.8-10.8 m they clipped the
    // aetheryte plaza skirt (props-B's measured ask; plaza outer edge is ~10.5 m)
    for (const [x, z, s] of [[9.5, -21.5, 0.9], [-8, -35.5, 1.1], [10.5, -35, 0.7], [-10, -20.5, 0.6]]) addCrystal(x, z, s, Math.floor(rng() * 3));
  }

  /** Deterministic collision self-test: walk a player-sized sphere straight into nearby registered colliders
   *  at several landmarks; pass = the sphere is held outside every collider's radius. Call from __game eval. */
  collisionSelfTest() {
    const col = this.game.world?.colliders; if (!col?.resolveSphere) return { pass: false, error: 'no colliders' };
    const tests = [];
    const probe = (label, x, z) => {
      const near = col.query(x, z, 12, []); let best = null, bd = 1e9;
      for (const c of near) { if (c.type === 'box') continue; const p = c.type === 'sphere' ? c.pos : c.a; const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = c; } }
      if (!best) { tests.push({ label, pass: false, why: 'no collider within 12 m' }); return; }
      const tx = best.type === 'sphere' ? best.pos.x : (best.a.x + best.b.x) / 2, tz = best.type === 'sphere' ? best.pos.z : (best.a.z + best.b.z) / 2;
      const ty = best.type === 'sphere' ? best.pos.y : (best.a.y + best.b.y) / 2, R = best.r;
      let dx = x - tx, dz = z - tz; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const c0 = new THREE.Vector3(tx + dx * (R + 5), ty, tz + dz * (R + 5));
      for (let i = 0; i < 300; i++) { c0.x -= dx * 0.04; c0.z -= dz * 0.04; col.resolveSphere(c0, 0.45); } // 12 m of pushing through the center
      const end = Math.hypot(c0.x - tx, c0.z - tz);
      tests.push({ label, collider: best.type, r: +R.toFixed(2), endDist: +end.toFixed(2), minAllowed: +(R + 0.4).toFixed(2), pass: end >= R + 0.4 });
    };
    let t = null, bd = 1e9; for (const c of this.trees) { const d = Math.hypot(c.x, c.z + 230); if (d < bd) { bd = d; t = c; } }
    if (t) probe('forest tree', t.x + 3, t.z + 3);
    let rk = null; bd = 1e9; for (const c of this.rocks) { const d = Math.hypot(c.x, c.z); if (d < bd) { bd = d; rk = c; } }
    if (rk) probe('rock', rk.x + 2, rk.z + 2);
    let cr = null; bd = 1e9; for (const c of this.crystals) { const d = Math.hypot(c.x - 250, c.z); if (d < bd) { bd = d; cr = c; } }
    if (cr) probe('crystal', cr.x + 2, cr.z + 2);
    probe('ruins tower wall', 150, 60);
    probe('arena monolith', -14, 260);
    probe('aetheryte pedestal', 4, -28);
    return { pass: tests.length > 0 && tests.every((x) => x.pass), tests };
  }

  update(dt, t) {
    const { camera, sky } = this.game, U = this.uniforms;
    U.uTime.value = t;
    if (sky) { U.uSunDirV.value.copy(sky.sunDir).transformDirection(camera.matrixWorldInverse); U.uSunColor.value.copy(sky.sunColor); U.uSunI.value = sky.sunIntensity ?? 1; }
    // staggered LOD refresh: 3 sets per frame, each set when the camera moved > 1 m from ITS last refresh
    // (2 sets @ 1.5 m lagged enough at sprint speed that trees/rocks visibly popped in at the near edge)
    const p = camera.position, n = this.lods.length; if (!n) return;
    let budget = 3;
    for (let k = 0; k < n && budget; k++) {
      const l = this.lods[(this._ri + k) % n];
      if (!l._lp) { l._lp = new THREE.Vector3(1e9, 0, 0); l._lt = -1; }
      if (p.distanceToSquared(l._lp) > 1.0 || t - l._lt > 0.45) {
        l.refresh(p.x, p.z); l._lp.copy(p); l._lt = t;
        if (--budget === 0) this._ri = (this._ri + k + 1) % n;
      }
    }
  }
}
