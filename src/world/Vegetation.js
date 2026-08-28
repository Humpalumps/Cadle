import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, fbm, noise2, smoothstep, clamp, lerp } from '../core/Noise.js';
import { BIOMES, RL_EDGE, ORDER, weightAt } from './Biomes.js';
import { GroundScatter } from './GroundScatter.js';

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
 *   vegetation.understory  InstLOD of Whisperwood fern/bracken clumps, or null when card_fern is missing
 *   vegetation.canopy    [InstLOD x3] Whisperwood mid-canopy leaf bundles, or null when leaf_card is missing
 *   vegetation.groundScatter  GroundScatter — the 5-40 cm ground layer (pebbles/grit/tufts/crust/clinker/
 *                        shards) in all ten regions. Player-following, 3 draw calls; see GroundScatter.js.
 *   vegetation.lods      InstLOD sets refreshed round-robin (Props pushes its own)
 *   vegetation.uniforms  { uTime, uWind, uSunDirV, uSunColor, uSunI } shared by Props materials
 *   vegetation.setWind(w)
 *   vegetation.collisionSelfTest() -> {pass, tests[]}  deterministic sphere-walk into registered colliders (for critics)
 * Exports helpers for Props: InstLOD, patchMaterial, triplanarPatch, fadePatch, erodeFade, instTintPatch,
 *   makeRockGeometry, noiseTexture, rgbaTexture, normalFromLuma
 * NOTE for anyone building an InstancedMesh here: instanceColor does NOT reach the fragment shader on its
 * own in three r185 — add `instTintPatch` (see its doc comment) or your per-instance tint is silently dead.
 */

// ---------------------------------------------------------------- per-biome scatter tables (Biomes.js ids)
// One line per outer region: what grows there, what stone it is made of, what its spires look like.
// `p` is the accept probability at the region's heart; it fades out with the biome weight.
const NO_BIOME = { id: 'meadow', w: 0, k: -1 };
// [accept probability, species pool, LEAF TINT]. The tint is the one that was missing: every tree in the
// world took the same yellow-green instance jitter, so a Frostveil pine, a Void husk and a Whisperwood oak
// were the same tree wearing the same leaves. It multiplies the jitter (so the per-instance variation
// survives) and fades in with the biome weight, exactly like the crystal spires' tint.
// `col` VALUES WERE REBALANCED 2026-08-26: until the iTint fix in EZTrees.js the tint never reached the
// fragment shader at all, so these numbers had been tuned against a canopy that was ignoring them. Now that
// they land, forest/dragon/shadowfen are pulled back toward 1.0 — the old triples multiplied a leaf material
// that is ALREADY region-coloured (LEAF_COL/card assets) and would have rendered near-black.
// `og` = share of accepts that become species 5 (old-growth, 25-35 m, huge crown cards — see EZTrees.js);
// `sMax`/`yMax` = per-biome slope/altitude gates (glacier faces and dragon cliffs must stay bare).
// p 0.45 -> 0.34 for the forest pays for the old-growth crowns with FEWER instances, not more geometry:
// each old-growth covers ~4x the sky of a sapling, so the canopy closes while the tri count drops
// (looking south out of the Whisperwood is the heaviest view in the world — it must not grow).
const BTREE = {
  forest:    { p: 0.34, sp: [8], og: 0.58, col: [0.58, 0.86, 0.70], gv: 0.72 },   // deep green + subtle teal (accent applied at placement); species 8 is the aspen-free broadleaf pool — the gold-tinted Aspen presets in species 0 were the "random ochre autumn trees"
  tundra:    { p: 0.34, sp: [3],    col: [0.90, 0.96, 1.06], gv: 0.36, sMax: 0.17, yMax: 34 },   // snow-laden conifers (card_conifer_snow) — winter, never summer green; treeline stops below the glacier massif
  celestial: { p: 0.00, sp: [0],    col: [1.12, 0.98, 0.60] },   // marble isles: broken colonnade, not woodland (Props._buildBiomeClutter)
  dragon:    { p: 0.07, sp: [6],    col: [0.68, 0.82, 0.74], sMax: 0.30, yMax: 54 },   // DARK alpine pine, LOW ledges only (heart ~44 m; yMax 62->54 clears the high benches; col darkened — 0.42-green still read spring-lime beside the gate, crit2-dragon-b)
  infernal:  { p: 0.04, sp: [4],    col: [0.92, 0.90, 0.88] },   // charred LEAFLESS snags, sparse — the wastes are mostly vents and ash (col is near-neutral: it tints the trunk impostor, and a charred trunk must stay charcoal)
  lost:      { p: 0.00, sp: [1],    col: [0.88, 0.72, 1.14] },   // standing stones instead
  shadowfen: { p: 0.32, sp: [7],    col: [0.55, 0.62, 0.42] },   // ALL of it dead: sparse husk canopy over standing water (species 7 keeps the old sparse-leaf dead look; 4 went fully leafless for the infernal spec)
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
// LANDMARK CLEARANCE, metres from the region centre (Props builds every hero landmark centred on B.cx/B.cz).
// Nothing this file scatters — tree, rock or spire — may stand inside it. "A full pine stands inside the black
// doorway recess of the Kharaz-Dun Gate ... plus three more on the gate's own apron" (crit3-dragon-c/z_door.png)
// is the shipped symptom; the cause is that scatter never knew the landmarks existed outside the home bowl.
// Values are the built footprint plus a crown's worth of margin (a 13 m pine is ~7 m across at the top).
// dragon 56 -> 78 (wave-6: "a grey rubble blob punches through the gate's door leaves"): the Kharaz-Dun
// door leaves stand 66 m from the region centre and the apron runs to ~70, so a 56 m clearance dropped
// 5-11 m granite boulders inside the doorway. Props now also records landmarks.dragon AT the gate, so the
// other three clearance callers move with it.
const LM_CLEAR = { forest: 26, tundra: 30, celestial: 46, dragon: 78, infernal: 34, lost: 48, shadowfen: 28, sunken: 40, void: 34 };
// Regions whose ground is snow. Read by the snow gate in _place: a broadleaf may not stand in a snowfield,
// and the snowfield's edge is a WEIGHT, not the angular wedge the species table is keyed off.
const SNOW_K = ORDER.map((id, k) => (BIOMES[id].ground === 'snow' ? k : -1)).filter((k) => k >= 0);

// CROWN ENVELOPE of the two Whisperwood species, metres before instance scale — where _buildCanopyFoliage
// hangs its mid-canopy bundles. `h` mirrors EZTrees' TARGET_H (27 m old-growth, 13 m broadleaf); y0..y1 is
// the crown's vertical span as a fraction of h, `r` its half-width, `n` bundles per tree, `bs` bundle size
// in metres. Bundles sit at 0.4-1.15 of the crown radius: the SHELL and just outside it, so from under the
// tree they are between the eye and the giant crown cards, which is the whole point.
// y1 STOPS SHORT OF THE APEX on purpose (0.86 / 0.90, was 0.96 / 0.98). The crown card cloud thins to
// almost nothing in the top tenth of a tree, so bundles placed there are the only thing on the silhouette
// and they read as a chain of foliage balls floating in open sky above the treeline
// (S6/shot-13-side.png). tools/out/S7 settles what they are: shot-D-onlybundles.png hides EZTrees' leaves
// and the bundles are visibly ringed onto their own trunk tops — the placement is right, the TOP of the
// band was not. Same 34 bundles in a shorter band is also denser where a player actually looks.
// `bs` is the dial that decides whether this layer FIXES the defect or joins it: a bundle card carries a
// ~0.3 LEAF_CROPS window of the painted bush, i.e. 2-3 painted leaves across the card, so a 2 m card puts
// leaves at ~0.7 m and a 4 m card puts them back at 1.4 m — which is the giant-crown-card failure again, one
// size down. Measured against tools/out/L5-a1-forest (bs 2.9): near bundles still read metre-scale. 1.75/1.25
// lands leaves at 0.4-0.7 m, and the count goes UP to hold crown coverage.
const CROWN = {
  5: { h: 27, y0: 0.38, y1: 0.86, r: 0.31, n: 34, bs: 1.75 },   // old-growth giant: the tree whose 9 m cards read as stage flats
  8: { h: 13, y0: 0.48, y1: 0.90, r: 0.30, n: 6,  bs: 1.25 },   // broadleaf sub-canopy: fewer, smaller — this layer's cards are already honest
};

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
/** World-space triplanar mapping of material.map (+ optional moss on up-facing surfaces, + optional SNOW).
 *  `snow` (0..1) drives a real albedo/roughness swap on up-facing surfaces, not a tint multiply: a boulder
 *  in a snowfield with a crisp snow-free top is the tundra's "bare smooth grey dome" finding
 *  (crit3-tundra-c/shot-boulders-a.png). The edge is broken by the map's own luma so it drifts around the
 *  dome instead of drawing a latitude line, and the snow value is capped well under the bloom threshold —
 *  snow is a bright DIFFUSE surface, never a light source. */
export function triplanarPatch(scale = 0.3, moss = 0.0, mossColor = [0.45, 0.62, 0.28], snow = 0.0) {
  return {
    uniforms: { uTriScale: { value: scale }, uMoss: { value: moss }, uMossCol: { value: new THREE.Vector3(...mossColor) }, uSnow: { value: snow } },
    vHead: 'varying vec3 vWPos; varying vec3 vWNormal;',
    vAfter: `{ vec4 wp = vec4(transformed, 1.0); mat3 nm = mat3(modelMatrix);
      #ifdef USE_INSTANCING
        wp = instanceMatrix * wp; nm = nm * mat3(instanceMatrix);
      #endif
      wp = modelMatrix * wp; vWPos = wp.xyz; vWNormal = normalize(nm * objectNormal); }`,
    fHead: 'varying vec3 vWPos; varying vec3 vWNormal; uniform float uTriScale; uniform float uMoss; uniform vec3 uMossCol; uniform float uSnow;\nfloat gSnowA = 0.0;',
    fMap: `#ifdef USE_MAP
      { vec3 bw = abs(normalize(vWNormal)); bw = pow(bw, vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
        vec3 p = vWPos * uTriScale;
        vec4 tc = texture2D(map, p.zy) * bw.x + texture2D(map, p.xz) * bw.y + texture2D(map, p.xy) * bw.z;
        diffuseColor *= tc;
        float mossA = uMoss * smoothstep(0.25, 0.85, vWNormal.y) * smoothstep(0.35, 0.7, tc.g * 1.6);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uMossCol * 2.2, mossA);
        if (uSnow > 0.001) {
          float lum = dot(tc.rgb, vec3(0.2126, 0.7152, 0.0722));
          gSnowA = uSnow * smoothstep(0.10, 0.66, vWNormal.y + (lum - 0.5) * 0.85);   // luma-broken edge: drift, never a latitude line
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.60, 0.635, 0.70) * (0.80 + 0.34 * lum), gSnowA);
        } }
      #endif`,
    // roughnessFactor only exists from <roughnessmap_fragment> onward, which is AFTER map_fragment — so the
    // snow's matte roughness lands here, still ahead of lights_physical_fragment. Emitted ONLY when snow is
    // actually on: Props patches ten materials with this helper and a depth/basic one would not declare it.
    ...(snow > 0 ? { fEmissive: 'roughnessFactor = mix(roughnessFactor, 0.74, gSnowA);' } : {}),
  };
}
/** Per-instance InstancedMesh colour, carried by hand — USE THIS ON EVERY INSTANCED MATERIAL THAT WANTS
 *  ITS instanceColor. three r185 emits `#define USE_INSTANCING_COLOR` into the VERTEX prefix only, and
 *  `color_pars_fragment` declares `vColor` under `USE_COLOR`/`USE_COLOR_ALPHA` — which come from the
 *  MATERIAL's `vertexColors` flag, not from instanceColor. So on an InstancedMesh with instanceColor and
 *  no vertexColors the tint is uploaded, interpolated and then dropped: three's own `color_fragment`
 *  skips it, and a fragment `#ifdef USE_INSTANCING_COLOR` is always false. Setting `vertexColors: true`
 *  is NOT the fix — three then reads a `color` ATTRIBUTE the geometry does not have, which comes through
 *  as (0,0,0) and renders black. (The rocks were always fine: vertexColors:true AND a colour attribute.)
 *  This cost the project two waves of "Frostveil ice shards are royal sapphire" fixes that edited a tint
 *  which could not arrive, and it is why the Whisperwood canopy ignored BTREE.forest.col. */
export const instTintPatch = {
  vHead: 'varying vec3 vITint;',
  vBegin: 'vITint = vec3(1.0);\n#ifdef USE_INSTANCING_COLOR\nvITint = instanceColor;\n#endif',
  fHead: 'varying vec3 vITint;',
  fMap: '#include <map_fragment>\ndiffuseColor.rgb *= vITint;',
};
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
  const P = [], N = [], U = [], L = [], Q = []; const up0 = new THREE.Vector3(0, 1, 0), r = new THREE.Vector3(), u = new THREE.Vector3(), u2 = new THREE.Vector3(), q = new THREE.Vector3(), n = new THREE.Vector3();
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
        U.push(cu + uvs[i][0] * cs, cv + uvs[i][1] * ct); L.push(tint, ao); Q.push(uvs[i][0], uvs[i][1]);
      }
    }
  }
  // aLuv = the card's OWN 0..1 uv, which `uv` no longer is once a LEAF_CROPS window is applied. A shader
  // that wants to fade a card out toward its own border (so the card RECTANGLE stops existing) needs it.
  const g = new THREE.BufferGeometry(); g.setAttribute('position', F32(P, 3)); g.setAttribute('normal', F32(N, 3)); g.setAttribute('uv', F32(U, 2)); g.setAttribute('aLeaf', F32(L, 2)); g.setAttribute('aLuv', F32(Q, 2)); return g;
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
/** A UNIT leaf bundle: `n` small cards on a sphere of radius ~0.5, normals pointing outward from the centre.
 *  This is the mid-canopy atom (see _buildCanopyFoliage) — instanced at ~1-2.3 m it puts leaves at 30-70 cm,
 *  which is the size the painted card asset was drawn at. Contrast with an old-growth CROWN card, which is
 *  ~9 m across and therefore magnifies the same painting until one leaf is 3 m wide and reads as a flat
 *  print. Cards are pushed through card()/cards(), so each one gets its own LEAF_CROPS window (ragged
 *  silhouette), fold, flip, hue jitter and AO for free. 4 tris a card. */
function leafBundle(rng, n) {
  const L = [], c = V3(0, 0, 0);
  for (let i = 0; i < n; i++) {
    // golden-angle spiral over the sphere: the cards actually surround the centre instead of clumping,
    // so a bundle has a silhouette from every side (it is instanced at a fully random orientation).
    const yy = 1 - (i + 0.5) / n * 1.72, rr = Math.sqrt(Math.max(0.02, 1 - yy * yy)), a = i * 2.39996 + rng() * 0.7;
    const dir = V3(Math.cos(a) * rr, yy, Math.sin(a) * rr);
    const p = dir.clone().multiplyScalar(0.16 + rng() * 0.30);
    const nrm = dir.clone().add(V3(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(0.7));
    card(L, p, nrm, 0.82, 0.74, rng, { ao: 0.66 + 0.34 * (yy * 0.5 + 0.5) });   // undersides darker: volume, not a shelf
  }
  return cards(L, c, 0.34);
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
    // Third octave, and it is not decoration: the boulder was a smooth ellipsoid, which is the wave-3
    // "marble-egg boulders ... still smooth domes" (lost) and "bare smooth grey dome" (tundra) finding in
    // both regions at once. A ridged |noise| term breaks the silhouette into shoulders and hollows at
    // ~0.5 m, so the dome reads as weathered stone from its outline alone. Zero extra triangles.
    let d = 0.16 * fbm(v.x * f + v.y * 0.7 * f + seed, v.z * f - v.y * 0.5 * f, { octaves: 4, seed: 77 + seed }) + 0.05 * noise2(v.x * 5 + seed, v.z * 5 + v.y * 3, 78)
      + 0.075 * (1 - Math.abs(noise2(v.x * 2.6 + seed * 1.7, v.z * 2.6 - v.y * 2.1, 79)));
    if (kind === 3 && v.y > 0) d -= v.y * 0.18 * (Math.abs(v.x) + Math.abs(v.z)); // pointed tip
    v.multiplyScalar(1 + d); v.x *= sc[0]; v.y *= sc[1]; v.z *= sc[2];
    if (kind === 2 && v.y > 0.25) v.y = 0.25 + (v.y - 0.25) * 0.3; // flat top
    p.setXYZ(i, v.x, v.y, v.z); const c = clamp(0.85 + d * 2.0, 0.6, 1.15); col[i * 3] = c; col[i * 3 + 1] = c; col[i * 3 + 2] = c;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
}
/** One aether shard: an irregular 8-sided prism (per-side radius + height jitter) with a chiselled tip and a
 *  bevelled waist. Irregular sides mean every facet has its OWN normal, so sun/rim/glint break across the shard —
 *  a regular hexagonal cone renders as two flat tones (the "purple confetti" read the critic called out).
 *  THREE ARCHETYPES, not one prototype scaled (crit3-void-b: "no variation between instances beyond scale ...
 *  Blender primitives with a toon shader"): 0 chisel spike, 1 flat blade (squashed on one axis, snapped tip),
 *  2 stubby twisted prism with a bevelled crown. One extra chamfer row each, so the silhouette has seven
 *  breaks instead of five, and blade/prism keep a capped top instead of collapsing to a needle point. */
const SHARD_PROF = [
  [[0, 0.74], [0.10, 1.00], [0.34, 0.96], [0.55, 0.86], [0.74, 0.68], [0.89, 0.36], [1, 0.00]],
  [[0, 0.62], [0.08, 0.94], [0.30, 1.00], [0.58, 0.88], [0.80, 0.58], [0.93, 0.30], [1, 0.07]],
  [[0, 0.86], [0.12, 1.00], [0.44, 0.98], [0.66, 0.90], [0.82, 0.72], [0.93, 0.42], [1, 0.11]],
];
function shardGeometry(rng, h, r, arch = 0) {
  const SIDES = 8, P = [];
  const rad = [], off = [];
  const squash = arch === 1 ? 0.46 : 1;                       // blade: a plate, not a pencil
  for (let k = 0; k < SIDES; k++) { rad.push(r * (0.58 + rng() * 0.70)); off.push((rng() - 0.5) * 0.20); }
  const prof = SHARD_PROF[arch % 3];
  const twist = (rng() - 0.5) * (arch === 2 ? 0.95 : 0.5);
  const pt = (pi, k) => {
    const [t, rf] = prof[pi], a = (k / SIDES) * Math.PI * 2 + twist * t + off[k % SIDES];
    const rr = rad[k % SIDES] * rf;
    return [Math.cos(a) * rr, t * h * (1 + off[k % SIDES] * 0.3), Math.sin(a) * rr * squash];
  };
  for (let pi = 0; pi < prof.length - 1; pi++) for (let k = 0; k < SIDES; k++) {
    const a = pt(pi, k), b = pt(pi, k + 1), c = pt(pi + 1, k + 1), d = pt(pi + 1, k);
    if (prof[pi][1] > 0) P.push(...a, ...b, ...c);
    if (prof[pi + 1][1] > 0) P.push(...a, ...c, ...d);
  }
  const top = prof[prof.length - 1];
  if (top[1] > 0) { const c0 = [0, top[0] * h, 0]; for (let k = 0; k < SIDES; k++) P.push(...c0, ...pt(prof.length - 1, k), ...pt(prof.length - 1, k + 1)); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(P), 3)); return g;
}
function crystalClusterGeometry(rng, n, arch = 0) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const h = (i === 0 ? 1 : 0.3 + rng() * 0.55) * 2.4, r = h * (0.15 + rng() * 0.06);
    // the cluster's own shards mix archetypes too — a spike leaning out of a blade reads as a growth, a
    // row of identical cones reads as confetti
    const g = shardGeometry(rng, h, r, i === 0 ? arch : (arch + 1 + ((rng() * 2) | 0)) % 3);
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
    this._leafCard = leafCard;
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
    this._buildUnderstory();
    this._buildCanopyFoliage();
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
    // The 5-40 cm ground layer. Built here (not in _place) because it is generated around the player at
    // runtime, not baked over the map — see GroundScatter.js's header for why a whole-map bake cannot hold it.
    this.groundScatter = new GroundScatter(game); this.groundScatter.init();
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
      // snow, not "moss that happens to be grey": a real albedo swap on the up-faces (see triplanarPatch).
      // The multiply-tint version shipped in wave 2 and read as nothing at all — every Frostveil boulder
      // was still a bare grey dome in unbroken snow (crit3-tundra-c/shot-boulders-a.png).
      tundra:    { map: rockTexture(aniso, [0.55, 0.57, 0.61], [0.66, 0.68, 0.73], 0.3),  tri: 0.28, moss: 0, snow: 0.92 },
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
        mergePatch(fadePatch, triplanarPatch(cfg.tri, cfg.moss, cfg.mossCol, cfg.snow), { key: 'rock-' + gname }));
      this._rockGrp[gname] = this.rockGeos.map((g, k) => {
        const m = new THREE.InstancedMesh(gname === 'default' ? g : alias(g), mat, 8);
        m.castShadow = k === 0; // only the big boulders cast — small rocks hug the ground, their shadow is invisible but costs 3 cascade draws
        m.receiveShadow = true; m.name = `rocks-${gname}-${k}`; this.game.scene.add(m);
        const lod = new InstLOD({ near: [m], nearDist: near[k] * Q, band: 30, color: true }); this.lods.push(lod); this.rockSets.push(lod); return lod;
      });
    }
  }
  /** One ground-cover card layer: instanced quads, alpha-eroded LOD fade, per-instance tint, all normals
   *  forced UP so it is lit like the ground it sits on (no black backside quad). Null-safe: missing asset
   *  -> null, and the caller's placement loop skips it. */
  _cardLayer(texName, name, at, nearDist, geoFn) {
    const tex = this.game.assets?.tex?.(texName) ?? null;
    if (!tex) return null;
    const geo = geoFn();
    const nn = geo.getAttribute('normal');
    for (let i = 0; i < nn.count; i++) nn.setXYZ(i, 0, 1, 0);
    const mat = patchMaterial(new THREE.MeshStandardMaterial({ map: tex, alphaTest: at, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 }),
      mergePatch(erodeFade(at), instTintPatch, { key: name }));   // instTintPatch: without it the per-clump tint jitter would silently do nothing
    const m = new THREE.InstancedMesh(geo, mat, 8);
    m.castShadow = false; m.receiveShadow = true; m.name = name;
    this.game.scene.add(m);
    const lod = new InstLOD({ near: [m], nearDist, band: 8, color: true });
    this.lods.push(lod); return lod;
  }
  /** Whisperwood floor, two layers.
   *  FERN: knee-to-waist bracken clumps ABOVE the grass-blade fern cards. The wave-2 forest minor was "one
   *  fern mesh repeated at uniform density" — Grass.js owns the blade-scale card and cannot give it a second
   *  SIZE, so the variety has to come from a layer with its own instance scale/rotation/tint.
   *  MOSS: near-horizontal overlapping sheets hugging the duff. The region spec is "deep teal-green MOSS and
   *  fern undergrowth" and the moss half was simply missing — the floor between the bracken clumps was bare
   *  splat, which is what makes a forest floor read as terrain-with-plants-on-it at 8 m instead of a forest
   *  floor. Horizontal cards cost the same as vertical ones and answer a distance the fern cannot: a fern is
   *  a silhouette, moss is a SURFACE.
   *  6-8 triangles each, near tier only, one draw call apiece. */
  _buildUnderstory() {
    this.understory = this._cardLayer('card_fern', 'understory-fern', 0.42, 38, () => {
      const q = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
      return mergeGeometries([q, q.clone().rotateY(Math.PI / 3), q.clone().rotateY(Math.PI * 2 / 3)]);
    });
    this.moss = this._cardLayer('card_moss', 'understory-moss', 0.34, 30, () => {
      const q = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);   // flat on the ground, not a billboard
      return mergeGeometries([q, q.clone().rotateY(1.14).translate(0.22, 0.045, -0.16), q.clone().rotateY(2.35).translate(-0.19, 0.085, 0.20)]);
    });
  }
  /** WHISPERWOOD MID-CANOPY — the wave-4 forest BLOCKER, and it is the first thing in frame in that region:
   *  "near-field canopy is a handful of giant flat leaf-print cards ... the forest roof reads as painted
   *  stage flats" (tools/out/L5-base-forest/shot-roof.png reproduces it exactly).
   *
   *  The mechanism, because the obvious fix is the wrong one. An old-growth crown card is ~9 m across and
   *  the painted leaf_card asset is ONE bush, so a 0.30 crop window puts ~2.5 painted leaves across 9 m —
   *  each leaf renders 3 m wide and perfectly smooth. That is not a resolution problem and not a tri
   *  problem: it is a card that is far larger than the art drawn on it. Making the crown cards smaller is
   *  EZTrees.js's dial (SPECIES_TUNE[5]) and it trades canopy closure away; the tri-cheap fix that costs
   *  nothing else is to hang a layer of CORRECTLY-SCALED foliage in front of them.
   *
   *  So: bundles of 5-7 small cards (leafBundle) instanced at ~0.8-2.3 m through the crown shell of every
   *  region-owned Whisperwood tree, at a fully random orientation, non-uniform scale and its own tint.
   *  Three bundle geometries round-robin so a near bundle is never a visible clone. What this buys, in the
   *  critic's own words: many smaller cards (~30 cm leaves, the size the asset was painted at), varied
   *  orientation (random quaternion, not the crown's radial fan), broken silhouettes (LEAF_CROPS window +
   *  the radial card mask below, so no bundle ever shows a straight edge) and real parallax between layers
   *  — bundles sit at 0.45-1.0 of tree height and OUTSIDE the crown card cloud, so the giant sheets are
   *  seen THROUGH foliage instead of being the foreground.
   *
   *  Cost: ~20 tris an instance, ~450 in frame at nearDist 72, 3 draw calls, near tier only (the impostor
   *  band past ~128 m never sees them). No shadow cast — the giants already own the canopy shadow, and an
   *  alpha-cutout caster would need its own depth material plus 3 cascade draws for a read nobody can see.
   *  Null-safe: no leaf_card asset -> no layer, everything else is unchanged.
   *  BLOB LAW: no emissive anywhere in here. Value comes from the standard lit path and per-card AO. */
  _buildCanopyFoliage() {
    const tex = this._leafCard;
    this.canopy = null;
    if (!tex) return;
    const rng = mulberry32(this.game.seed + 8181);
    const AT = 0.36;
    const mat = patchMaterial(new THREE.MeshStandardMaterial({ map: tex, alphaTest: AT, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 }), {
      key: 'canopy-bundle',
      vHead: 'attribute float aFade; attribute vec2 aLeaf; attribute vec2 aLuv; varying float vFade; varying vec2 vLeaf; varying vec2 vLuv; varying vec3 vITint;',
      vBegin: `vFade = aFade; vLeaf = aLeaf; vLuv = aLuv; vITint = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vITint = instanceColor;
        #endif`,
      fHead: `varying float vFade; varying vec2 vLeaf; varying vec2 vLuv; varying vec3 vITint;
        const vec3 CAN_SHADE = vec3(0.66, 0.94, 0.78);   // deep teal-green, the Whisperwood's shaded leaf
        const vec3 CAN_SUN   = vec3(1.14, 1.04, 0.68);   // sun-struck leaf. Both are ALBEDO multipliers, not light.`,
      fMap: `#include <map_fragment>
        diffuseColor.rgb *= vITint * mix(CAN_SHADE, CAN_SUN, vLeaf.x) * (0.52 + 0.48 * vLeaf.y);
        // BLOB LAW insurance. Three multipliers stack here (texture x per-instance tint x per-card hue), and
        // the per-instance tint alone can reach ~1.07 in green, i.e. an ALBEDO above 1 — nonphysical, and the
        // exact shape of every washed-white recurrence this project has had. Hue-preserving max-channel cap:
        // the colour is untouched, only the value moves.
        { float mx = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
          if (mx > 1.0) diffuseColor.rgb /= mx; }
        // RADIAL CARD MASK on the card's OWN uv (aLuv, not vMapUv: vMapUv is inside a LEAF_CROPS window).
        // Fading a card out toward its own border is what makes the card RECTANGLE stop existing: corners
        // go first, which is where every "flat pasted quad" read comes from.
        diffuseColor.a *= 1.0 - smoothstep(0.62, 1.22, length(vLuv - 0.5) * 2.0);`,
      // One combined discard: the LOD cross-fade erosion AND the walked-into-the-canopy dissolve. Erosion,
      // never a screen door — a static camera holds a dither pattern forever (the tundra stipple blocker).
      fAlpha: `if (diffuseColor.a < mix(1.01, ${AT.toFixed(3)}, min(clamp(vFade, 0.0, 1.0), smoothstep(0.8, 2.6, length(vViewPosition))))) discard;`,
    });
    this.canopy = [5, 6, 7].map((n, i) => {
      const m = new THREE.InstancedMesh(leafBundle(rng, n), mat, 8);
      m.castShadow = false; m.receiveShadow = true; m.name = 'canopy-bundle-' + i;
      this.game.scene.add(m);
      const lod = new InstLOD({ near: [m], nearDist: 72, band: 16, color: true });
      this.lods.push(lod); return lod;
    });
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
      // vITint — THE PER-INSTANCE TINT, CARRIED BY HAND. three r185 puts `#define USE_INSTANCING_COLOR` in
      // the VERTEX prefix only (WebGLProgram prefixVertex), and `color_pars_fragment` declares `vColor`
      // under `USE_COLOR || USE_COLOR_ALPHA` — i.e. only when the MATERIAL sets vertexColors. So on an
      // InstancedMesh with instanceColor but no vertexColors, the tint reaches the vertex stage and dies
      // there: `#if defined(USE_INSTANCING_COLOR)` in a fragment patch is always FALSE, and three's own
      // `color_fragment` never multiplies it in either. Every crystal in the world was therefore rendering
      // the material's base aether violet — which is why "Frostveil ice shards read as royal sapphire, not
      // glacial ice" survived a wave-1 fix AND a wave-2 fix: both edited a tint that could not arrive.
      // (Rocks were never affected — that material sets vertexColors:true and its geometry has a colour
      // attribute.) Reading `instanceColor` in the vertex shader and forwarding it costs one varying.
      vHead: 'varying float vPh; varying float vLy; varying vec3 vLp; flat varying vec3 vFN; varying vec3 vITint;', vBegin: `
        #ifdef USE_INSTANCING
          vPh = fract(dot(instanceMatrix[3].xz, vec2(0.137, 0.291)));
        #else
          vPh = 0.0;
        #endif
        vITint = vec3(-1.0);
        #ifdef USE_INSTANCING_COLOR
          vITint = instanceColor;
        #endif
        vLy = position.y; vLp = position; vFN = objectNormal;`,
      fHead: `uniform float uTime; uniform float uSunI; uniform vec3 uSunColor; uniform vec3 uSunDirV; varying float vPh; varying float vLy; varying vec3 vLp; flat varying vec3 vFN; varying vec3 vITint;
        float facetHash(vec3 n){ return fract(sin(dot(n, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float cellHash(vec3 p){ return fract(sin(dot(floor(p), vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        vec3 gTint = vec3(0.42, 0.30, 1.00);
        float gPale = 0.0;    // 1 = this instance is ICE, not aether (set in map_fragment, read by the emissive block)
        float gFH = 0.0;      // per-facet hash, shared by both blocks so albedo steps and specular agree`,
      fMap: `{
        // Instance HUE, taken once for the whole fragment (map runs before emissive). Everything that
        // used to be hardcoded aether violet reads off this, so an ice shard, a coral fan and a void
        // splinter stop looking like the same meadow crystal. Normalising to the brightest channel takes
        // the hue and leaves the value alone: saturate the colour, never raise it (CLAUDE.md law).
        if (vITint.r >= 0.0) {
          gTint = vITint;
          // SATURATE, then normalise. Normalising alone keeps the hue but NOT the chroma, and a pale
          // instance colour — the meadow's own cyan-to-magenta jitter runs up to (0.9, 0.85, 1.0) — comes
          // out near-white, so the glow tone-maps to a white ball instead of its colour. The gate caught
          // exactly that at hour 17 in the spawn meadow, which is the decree's bug by name. Chroma is pushed
          // away from grey first; the value is untouched (the ceiling below is unchanged).
          float tL = dot(gTint, vec3(0.2126, 0.7152, 0.0722));
          gTint = max(vec3(0.0), tL + (gTint - tL) * 2.2);
          gTint /= max(max(gTint.r, max(gTint.g, gTint.b)), 1e-3);
        }
        gFH = facetHash(vFN);                                                            // stable per-facet value (flat normals)
        // THE BODY TAKES THE INSTANCE HUE, it is no longer merely mixed TOWARD it over a fixed violet
        // albedo. That mix could never win: the material colour is 0x3a2a9e, so a Whisperwood fae spire
        // carrying a green tint still rendered a fuchsia body — "hot magenta crystal clusters across the
        // western band break the region palette" (crit3-forest-c/shot-west-band-in.png), a finding that
        // survived two waves of edits to a tint that only ever reached the RIM. Luminance is preserved and
        // the hue is replaced: saturate the colour, never raise the value (CLAUDE.md law).
        float bl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        diffuseColor.rgb = mix(diffuseColor.rgb, gTint * bl * 1.45, step(0.0, vITint.r));
        diffuseColor.rgb *= 0.34 + 0.98 * gFH;                                           // hard facet-to-facet albedo steps: the faces must read apart in flat sun
        diffuseColor.rgb *= 0.86 + 0.30 * sin(vLy * 7.5 + gFH * 19.0);                   // internal growth banding
        // INTERIOR DEPTH. "normal" does not exist this early in the fragment (normal_fragment_begin runs
        // after map_fragment) and a flat-shaded material declares no vNormal, so the facet normal comes
        // from the same screen derivatives three's own FLAT_SHADED path uses.
        vec3 fdX = dFdx(vViewPosition), fdY = dFdy(vViewPosition);
        vec3 fN = normalize(cross(fdX, fdY));
        float nv = abs(dot(fN, normalize(vViewPosition)));
        diffuseColor.rgb *= mix(1.28, 0.42, nv);                                         // face-on = looking through the deep core, grazing = a thin bright wall
        diffuseColor.rgb *= 0.86 + 0.36 * cellHash(vLp * 3.7);                           // clouding / inclusions: a gem is not one value per facet
        // PALE SPIRES (Frostveil ice): a near-white instance tint means "this is ICE, not aether".
        // ...and "is this ice?" is a question about SATURATION, not brightness. Keying it off luminance
        // meant the per-instance brightness jitter (j = 0.88..1.12 in addCrystal) decided it: the dim ~40%
        // of Frostveil shards fell under the threshold and came out royal sapphire next to their pale
        // neighbours (tools/out/veg3-runC/shot-tundra-shards.png). Chroma is invariant under that jitter —
        // it scales all three channels — so it separates the regions cleanly and for good: ice [.92 .96 1.04]
        // is 0.12 saturated, while void [.52 .22 1.05], lost, forest and the meadow's own jitter are all 0.45+.
        // The ice BODY is now dark saturated blue, not pale grey. Pale grey was the bug: at 40 m+ the shard
        // sat at the value of the snowfield behind it and the silhouette dissolved into white cardboard
        // (crit3-tundra/shot-side.png). Value separation comes from a dark body; the ICE read comes from a
        // fresnel rim and a thin-slab translucency added to reflectedLight below — lighting, never emissive.
        float pMax = max(vITint.r, max(vITint.g, vITint.b));
        float pSat = (pMax - min(vITint.r, min(vITint.g, vITint.b))) / max(pMax, 1e-3);
        gPale = vITint.r < 0.0 ? 0.0 : 1.0 - smoothstep(0.14, 0.34, pSat);
        diffuseColor.rgb = mix(diffuseColor.rgb,
          vec3(0.26, 0.40, 0.60) * (0.55 + 0.62 * gFH) * (0.86 + 0.22 * sin(vLy * 6.0 + gFH * 17.0)) * mix(1.30, 0.52, nv), gPale);
        }`,
      fEmissive: `{ float day = clamp(uSunI, 0.0, 1.0);
        vec3 tintC = gTint;
        float pulse = 0.78 + 0.22 * sin(uTime * 1.4 + vPh * 6.2832);
        vec3 Vd = normalize(vViewPosition);                                      // fragment -> camera
        vec3 Nn = normalize(normal);
        float fres = pow(1.0 - clamp(abs(dot(Vd, Nn)), 0.0, 1.0), 2.2);          // broad Fresnel: a rim you can actually see at noon
        float fh = gFH;
        // per-facet specular variance: one roughness across the whole solid is what makes a gem read as
        // moulded plastic (crit3-void-b "no specular breakup"). roughnessmap_fragment already ran, so
        // roughnessFactor is live and this lands before lights_physical_fragment consumes it.
        roughnessFactor = clamp(roughnessFactor * (0.60 + 0.90 * fh), 0.07, 0.85);
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
        // ICE IS NOT A LIGHT SOURCE. The aether glow is cut to a seventh on pale instances and the read
        // moves into LIGHTING: a saturated cyan-blue fresnel rim plus a thin-slab backlight, added to
        // reflectedLight.directDiffuse so it respects exposure, tone mapping and the bloom threshold and
        // can never become a floating white ball (same mechanism as the ground-cover law in CLAUDE.md).
        // Channel-capped, not luminance-capped: a cyan sits near the ceiling in two channels at once.
        e = mix(e, e * 0.14, gPale);
        vec3 iceHue = vec3(0.42, 0.70, 1.00);
        reflectedLight.directDiffuse += min(gPale * uSunColor * max(uSunI, 0.35) *
          (iceHue * pow(fres, 1.35) * 1.05 + iceHue * pow(back, 1.6) * (0.30 + 0.55 * fh) * 0.90),
          vec3(0.42, 0.68, 0.92));
        totalEmissiveRadiance = min(e, vec3(2.1)); }`,                                 // hard cap: bloom must never wash a facet to flat white
    });
    this.crystalMat = mat;
    this.crystalSets = [7, 5, 9].map((n, i) => { const m = new THREE.InstancedMesh(crystalClusterGeometry(rng, n, i), mat, 8); m.castShadow = false; /* emissive: shadows add nothing */ m.receiveShadow = true; m.name = 'crystals-' + i; this.game.scene.add(m); const lod = new InstLOD({ near: [m], nearDist: 520, band: 60, color: true }); this.lods.push(lod); return lod; });
  }

  // ------------------------------------------------------------ placement (deterministic, biome driven)
  _place(rng) {
    const { terrain } = this.game, col = this.game.world.colliders, wl = terrain.waterLevel, half = terrain.size / 2 - 10;
    const bb = {}, B = (x, z) => (terrain.biomeBlend ? terrain.biomeBlend(x, z, bb) : NO_BIOME);
    const M = new THREE.Matrix4(), P = new THREE.Vector3(), Qt = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler(), C = new THREE.Color();
    const UPV = new THREE.Vector3(0, 1, 0), Qs = new THREE.Quaternion(), Nv = new THREE.Vector3();   // moss: sit flat cards ON the slope, not through it
    // DECORATION STREAM. Everything this file added in wave 5 — crown anisotropy, mid-canopy bundles, moss
    // sheets — draws from here, NOT from `rng`. A decorative layer must not move the world: `rng` is one
    // shared sequence walked by trees, then understory, then rocks, then crystals, so a single extra draw
    // in the tree loop re-rolls every rock and crystal on the map. That is not hypothetical — the first
    // version of this change did exactly that, and `collisionSelfTest()` on the default seed started
    // failing its crystal probe because a re-rolled cluster landed 7 m from its neighbour (the probe gets
    // wedged: Colliders.resolveSphere is single-pass, so two overlapping pushes can undo each other).
    // With a separate stream the tree/rock/crystal layout is bit-identical to before this wave.
    const drng = mulberry32(this.game.seed + 9091);
    const lakeD = (x, z) => Math.hypot(x + 170, z + 70), ruinD = (x, z) => Math.hypot(x - 140, z - 60), arenaD = (x, z) => Math.hypot(x + 60, z - 260), aethD = (x, z) => Math.hypot(x, z + 28);
    const ok = (x, z) => Math.abs(x) < half && Math.abs(z) < half;
    /** true when (x,z) sits inside the nearest outer region's landmark footprint (LM_CLEAR). */
    const inLandmark = (b, x, z) => { const B0 = b.k >= 0 ? BIOMES[b.id] : null; return !!B0 && Math.hypot(x - B0.cx, z - B0.cz) < (LM_CLEAR[b.id] ?? 30); };
    /** Seat height under a footprint of radius rr: the LOWEST ground under the base ring AND under a half-ring.
     *  Three samples at 0.7r left boulders hanging over the downhill lip on a bowl slope — "a grey ellipsoidal
     *  boulder hangs clean in mid-air against the bowl slope with open snow visible underneath"
     *  (crit3-tundra-b/crop-float2.png), and the same defect all over the Dragon Peaks landmark bowl
     *  (crit3-dragon-c/z_wallfloat.png). Six at the rim plus three inboard cover the real contact patch. */
    // seatHi = the HIGHEST sample of the last seat() call. A footprint whose ground spans more than the
    // object is tall has no resting place on it: seat it on the low sample and it hangs in open air, seat
    // it on the high one and it is buried. That is "boulders float in open air and glue themselves to
    // near-vertical faces, all over the landmark bowl" (crit3-dragon-c/z_wallfloat.png) and half the
    // tundra bowl floaters — a slope THRESHOLD cannot catch it, because slopeAt is a smoothed gradient at
    // a point and a 3 m boulder cares about the 3 m around it. Callers reject on the range.
    let seatHi = 0;
    const seat = (x, z, rr) => {
      let lo = terrain.heightAt(x, z); let hi = lo;
      const s = (px, pz) => { const h = terrain.heightAt(px, pz); if (h < lo) lo = h; if (h > hi) hi = h; };
      for (let a = 0; a < 6; a++) { const th = a * 1.0472 + 0.31; s(x + Math.cos(th) * rr, z + Math.sin(th) * rr); }
      for (let a = 0; a < 3; a++) { const th = a * 2.0944 + 1.4; s(x + Math.cos(th) * rr * 0.55, z + Math.sin(th) * rr * 0.55); }
      seatHi = hi; return lo;
    };
    // ---- trees
    const treeSpec = this.treeSets.map((s) => s.spec);
    for (let gx = -half; gx < half; gx += 7) for (let gz = -half; gz < half; gz += 7) {
      // DE-ROWED LATTICE. One candidate per 7 m cell jittered by only +-3 m leaves 1 m of dead space on
      // every cell boundary, and the eye reads that residual grid as ORCHARD ROWS the moment density gets
      // high enough to see two cells at once — the wave-2 forest deficiency, and plainly visible around the
      // Vale plaza too (tools/out/veg3-before/shot-vale-aetheryte-up.png). Full-cell jitter plus a half-cell
      // stagger on alternate columns turns the square lattice into a hex-ish one: no axis-aligned rows left
      // to see. Same cost, same instance count, same determinism.
      const x = gx + (rng() - 0.5) * 7, z = gz + ((((gx / 7) | 0) & 1) ? 3.5 : 0) + (rng() - 0.5) * 7;
      if (!ok(x, z)) continue;
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
      const bt = B(x, z);
      // BORDER INTERLEAVE (wave-6 tundra blocker: "summer oaks shoulder to shoulder with snow-laden pines
      // across a straight line"). Terrain._seam already bent that line into the same meander the ground
      // splat draws; this is the CONTENT gradient on top of it. Inside the seam band `bt.m` ramps 0 -> 0.5,
      // so each candidate independently draws its pool from the NEIGHBOUR with that probability: the two
      // canopies interdigitate over ~34 m — pines thinning into oaks — instead of meeting on an edge.
      // `bt.m > 0.001` short-circuits, so the rng stream (and the whole scatter) is untouched everywhere
      // except the nine seams.
      const nb = bt.m > 0.001 && rng() < bt.m;
      const bId = nb ? bt.id2 : bt.id, bW = nb ? bt.w2 : bt.w;
      const bTree = bW > 0.02 ? BTREE[bId] : null;                      // outer biome takes over its own canopy
      if (inLandmark(bt, x, z)) continue;                               // hero landmarks keep their own ground
      // SIGHTLINE SPECIES. `bt.w` is a DISTANCE-from-centre weight, so between RING_IN and the region's look
      // radius it is 0 and the Vale's own broadleaf pool used to take over — from inside Frostveil at full
      // biome weight you were looking at "bright saturated summer-green broadleaf canopy directly behind the
      // frost-pines" (crit3-tundra-c/crop-green.png, player at (296,-513), trees 160-260 m away on the ring).
      // `bt.id` is the nearest wedge whatever the weight is, so out here species and tint come from the region
      // whose sightline this ground is in, while DENSITY stays the home grove noise. Inside RING_IN nothing
      // changes — the Vale keeps its own trees.
      const bLook = !bTree && bt.k >= 0 ? BTREE[bId] : null;
      // `gv` is the FLOOR under the grove noise. Without one, grove2 returns 0 across whole stretches and the
      // region's heart is an open lawn with a treeline around it — which is a meadow, not a forest. A closed
      // canopy needs trees between the groves too; the noise should vary density, not switch it off.
      // The floor fades DOWN toward the region edge: full-strength gv at the heart keeps the closed canopy,
      // but at the edge band a uniform floor over a 7 m lattice read as orchard rows on open ground
      // (crit2-forest-c/shot-lowsun-west) — there the grove noise takes over and trees CLUMP instead.
      if (bTree) { const gv = (bTree.gv ?? 0) * smoothstep(0.30, 0.85, bW); p = p * (1 - bW) + bTree.p * (gv + (1 - gv) * grove2(x, z)) * bW; }
      const u0 = rng(); if (u0 > Math.max(p, 0.22)) continue; // cheap reject before the (costlier) height/slope queries
      const y = terrain.heightAt(x, z); if (y > 190 || y < wl + 0.4) continue;
      const shore = y < wl + 2.6 && lakeD(x, z) < 120; if (shore) p = 0.22;
      if (u0 > p) continue;
      if (terrain.slopeAt(x, z) > (bTree?.sMax ?? 0.5)) continue;      // per-biome slope gate: no pines pasted on the glacier face / sheer dragon domes
      if (bTree?.yMax !== undefined && y > bTree.yMax) continue;       // altitude band: dragon pines on LOW ledges only, tundra treeline below the massif
      if (Math.hypot(x - 118, z + 96) < 36) continue;                  // Hearthfall hamlet: cottages sit 13-24 m from (118,-96) + eaves + canopy overhang — trees were growing through hut roofs
      let species; const u = rng();
      // No old-growth on a sightline: the giants are a region's own INTERIOR read, and the ring band is
      // both the heaviest view in the world and visible from the Vale — 27 m crowns there buy nothing and
      // cost the frame (the south-facing Whisperwood view is leaf-tri-bound, tools/out/veg4-perf).
      if (bLook) species = bLook.sp[(u * bLook.sp.length) | 0];
      else if (bTree) {
        // a region's pool owns ALL of its trees. The old `bt.w > 0.45` gate let the Vale's green species
        // leak in wherever the weight dipped — which is exactly the "living green trees all over the
        // Infernal Wastes" spec violation. Below w 0.02 there is no bTree and home logic applies as before.
        species = bTree.sp[(u * bTree.sp.length) | 0];
        // Old-growth share at the EDGE, not just the heart: at w~0.4 the old floor gave 0.61 of the heart
        // share, so the western band was mostly uniform young trees — the other half of the orchard-rows
        // read (the lattice above is the first half). 0.58 + 0.42w is heart-identical (w=1 -> 1.0) and
        // hands the west band 0.75: giants clump, and a giant costs FEWER triangles than the saplings it
        // replaces (see SPECIES_TUNE[5] in EZTrees.js), so extending old-growth west is a tri WIN.
        if (bTree.og && rng() < bTree.og * (0.58 + 0.42 * bW)) species = 5;
      }
      else if (shore) species = 2; else if (forest > 0.5) species = u < 0.72 ? 0 : 1; else species = u < 0.45 ? 0 : 1;
      // SNOW GATE (wave-6 coherence: "a fat green deciduous tree with green grass under it stands in the
      // middle of the snowfield"). Two different snowfields, one rule, and neither was known to BTREE:
      //  (a) Terrain's snow layer is a GLOBAL ALTITUDE splat — `ss(104, 138, h + macro*24)` in colorAt and in
      //      FRAG_SPLAT — so every shoulder of the mountain ring above ~92 m is white ground no matter which
      //      wedge it is in. Only tundra and dragon carried a `yMax`, so the home grove's own broadleafs (and
      //      every sightline species) climbed straight into it.
      //  (b) Frostveil's snow FLOOR is a distance weight (weightAt), but `wedgeAt` flips SPECIES on the
      //      angular bisector — two different boundaries. On the forest/celestial side of a tundra seam the
      //      ground is still half snowfield while the canopy has already handed over to summer broadleaf.
      // Conifers (3, 6) and the leafless species (4, 7) belong on snow and are untouched. A broadleaf is not,
      // and no tint fixes it: an oak in unbroken snow reads as an oak in unbroken snow. Species gate, not a
      // colour gate — same reasoning as the blob decree's "cap the value, do not tint the symptom".
      if (species === 0 || species === 1 || species === 2 || species === 5 || species === 8) {
        if (y > 92) continue;
        let snowed = false;
        for (const sk of SNOW_K) if (sk !== bt.k && weightAt(x, z, sk) > 0.26) { snowed = true; break; }
        if (snowed) continue;
      }
      const sp = treeSpec[species] ?? treeSpec[species === 3 || species === 6 ? 0 : 1];
      // FOREST SCALE SPREAD, not one size. Half of the wave-4 "a handful of giant flat cards" blocker is
      // that every old-growth giant was 27 m x (0.9..1.25), so every crown card in frame was the same ~9 m
      // sheet. 0.70+0.62 holds the mean (1.01 vs 1.075) and nearly triples the spread — crown cards now run
      // 6.5-12 m and the roof stops being one repeated plane. Species 8 widens the same way, which is what
      // turns the broadleaf sub-canopy into a real LAYER (8-18.5 m) instead of a uniform 13 m shelf; two
      // separated height bands under the emergents is where the "parallax between layers" actually comes from.
      const scale = species === 0 ? 0.8 + rng() * 0.55 : species === 1 ? 0.75 + rng() * 0.5
        : species === 3 || species === 6 ? 0.7 + rng() * 0.6
        : species === 5 ? 0.70 + rng() * 0.62
        : species === 8 ? 0.62 + rng() * 0.80
        : 0.8 + rng() * 0.4;
      // A crown is not a solid of revolution. A little XZ anisotropy (area-preserving: ani x 1/ani) plus a
      // touch more lean on the giants re-aspects and rotates a whole card set per instance — "varied
      // orientation" for the cost of one matrix, no extra geometry and no extra draw.
      const ani = CROWN[species] ? 0.88 + drng() * 0.26 : 1, lean = species === 5 ? 0.13 : 0.08;
      E.set((rng() - 0.5) * lean, rng() * Math.PI * 2, (rng() - 0.5) * lean); Qt.setFromEuler(E);
      P.set(x, y - 0.25 * scale, z); S.set(scale * ani, scale, scale / ani); M.compose(P, Qt, S);
      // per-instance hue jitter, then pushed toward the REGION's foliage colour by the biome weight
      const tj = 0.76 + rng() * 0.44;
      let cr = tj * (0.86 + rng() * 0.3), cg = tj, cb = tj * (0.8 + rng() * 0.32);
      const kCol = bTree?.col ?? bLook?.col;
      if (kCol) { const w = bTree ? bW : 1; cr *= 1 + (kCol[0] - 1) * w; cg *= 1 + (kCol[1] - 1) * w; cb *= 1 + (kCol[2] - 1) * w; }
      if (bTree && bId === 'forest' && rng() < 0.18) { cr *= 0.78; cb *= 1.24; }   // the enchanted accent: a scatter of blue-teal crowns in the deep green
      // ALBEDO IS A REFLECTANCE — it cannot exceed 1, and `tr.c` goes straight into EZTrees' leaf and
      // impostor instanceColor (EZTrees.js:419). tj alone reaches 1.20 and the per-channel jitter takes
      // red to ~1.39, so the brightest crowns were multiplying their leaf card ABOVE the painted value:
      // backlit, an old-growth crown card then read as a pale mint plastic sheet 4 m across
      // (S1-before/shot-12-eye.png, top of frame). Hue-preserving max-channel cap — the colour is
      // untouched, only the value moves. Same rule as the canopy-bundle shader in _buildCanopyFoliage,
      // and the same rule the blob decree states: saturate the colour, cap the intensity.
      { const mx = Math.max(cr, cg, cb); if (mx > 1) { cr /= mx; cg /= mx; cb /= mx; } }
      // ...and the old-growth giant gets one stop less on top of the cap. Its crown is a few ~9 m cards
      // carrying a 0.30 uv window of leaf_card (EZTrees LEAF_MAP[5] + the fixed `cs` crop), so a painted
      // leaf renders ~3 m wide with a smooth interior: backlit at the TOP of the crown that reads as a pale
      // mint plastic sheet, and it was the brightest thing in the frame from under the canopy
      // (S4/shot-13-in.png). Leaf SCALE is EZTrees' dial and not mine; VALUE is mine, and dropping the
      // giant's crown a stop hands the highlight to the mid-canopy bundles below it — which carry leaves at
      // the size the asset was painted at. Species 5 only: the sub-canopy broadleaf's cards are honest.
      if (species === 5) { cr *= 0.90; cg *= 0.90; cb *= 0.90; }
      C.setRGB(cr, cg, cb);
      (this.treeSets[species] ?? this.treeSets[species === 3 || species === 6 ? 0 : 1]).lod.add(M, C);
      const r = Math.max(0.28, sp.colR * scale * (species === 5 ? 1.5 : 1));
      // `c` (leaf tint) rides along for EZTrees, but ONLY for region-owned and sightline trees — the home
      // Vale keeps EZTrees' own neutral jitter so this change cannot shift the spawn meadow's read.
      this.trees.push(kCol ? { x, y, z, species, scale, r, c: [C.r, C.g, C.b] } : { x, y, z, species, scale, r });
      col.add({ type: 'capsule', a: new THREE.Vector3(x, y - 1, z), b: new THREE.Vector3(x, y + sp.colH * scale, z), r });
      // ---- MID-CANOPY BUNDLES (see _buildCanopyFoliage), LAST in the iteration because they reuse M/C
      // (InstLOD.add copies both, and trees.push above still needed C as the tree's own leaf tint).
      // Region-owned Whisperwood trees only: the layer exists to break the old-growth crown's flat sheets,
      // and those only grow inside the forest region (bLook sightline trees never get species 5).
      const cw = this.canopy && bTree && bId === 'forest' ? CROWN[species] : null;
      if (cw) {
        const Hc = cw.h * scale, nB = Math.round(cw.n * (0.65 + drng() * 0.75));
        for (let i = 0; i < nB; i++) {
          // A CROWN IS NOT A CYLINDER. Pick the height first, then taper the radius toward the apex:
          // sampling a constant 0.25-0.93 of the crown radius at ALL heights hung bundles ~8 m off the
          // trunk at the very TOP of the tree, where the crown has already closed to a point — a scatter
          // of detached foliage puffs in open sky with nothing behind them (S1-before/shot-12-up.png,
          // and the same puffs at golden hour in shot-18-up.png). `1 - 0.78 t^2` keeps the mid and lower
          // crown full-width, so canopy closure is untouched, and pulls the apex in to ~a fifth.
          // ...and it does not reach the rim either. At 0.93 of the crown half-width a bundle's own 1.4 m
          // radius pokes THROUGH the leaf mass, so from below the treeline it reads as a compact ball of
          // foliage alone in the sky (S2b/shot-12-b-eye.png, above the ridge). 0.80 keeps the whole bundle
          // inside, and `rim` shrinks the outermost ones on top of that — a tuft at the edge of a crown is
          // small in nature, and a small stray reads as a branch tip instead of a floating object.
          const t = drng(), prof = 1 - 0.85 * t * t, rn = 0.20 + drng() * 0.60, rim = 1.20 - 0.45 * rn;
          const a = drng() * Math.PI * 2, rr = Hc * cw.r * prof * rn;
          const bs = cw.bs * scale * rim * (0.62 + drng() * 0.60);
          E.set(drng() * 6.2832, drng() * 6.2832, drng() * 6.2832); Qt.setFromEuler(E);   // fully random orientation — a bundle is never a clone of its neighbour
          P.set(x + Math.cos(a) * rr, y + Hc * (cw.y0 + t * (cw.y1 - cw.y0)), z + Math.sin(a) * rr);
          S.set(bs * (0.82 + drng() * 0.36), bs * (0.74 + drng() * 0.50), bs * (0.82 + drng() * 0.36));
          M.compose(P, Qt, S);
          const bd = 0.70 + drng() * 0.30;   // bundles hang inside the crown's shade: they read DOWN from the tree's tint, never up
          C.setRGB(cr * bd, cg * bd, cb * bd);
          this.canopy[(drng() * 3) | 0].add(M, C);
        }
      }
    }
    // ---- forest understory (see _buildUnderstory). Scanned over the Whisperwood's bounding box only —
    // a whole-map grid here would add ~110 k biomeBlend calls to boot for a layer that exists in one region.
    if (this.understory || this.moss) {
      const F = BIOMES.forest, x0 = F.cx - RL_EDGE, x1 = F.cx + RL_EDGE, z0 = F.cz - RL_EDGE, z1 = F.cz + RL_EDGE;
      for (let gx = x0; gx < x1; gx += 6) for (let gz = z0; gz < z1; gz += 6) {
        const x = gx + (rng() - 0.5) * 6, z = gz + ((((gx / 6) | 0) & 1) ? 3 : 0) + (rng() - 0.5) * 6;
        if (!ok(x, z)) continue;
        const bu = B(x, z); if (bu.id !== 'forest' || bu.w < 0.22 || inLandmark(bu, x, z)) continue;
        // clumped, never a carpet: the point is patches of bracken between bare duff, not a second lawn
        const clump = smoothstep(0.34, 0.72, 0.5 + 0.5 * fbm(x * 0.021, z * 0.021, { octaves: 3, seed: 57 }));
        const road = (terrain.roadAt?.(x, z) ?? 0) > 0.35;
        const y = terrain.heightAt(x, z), slope = terrain.slopeAt(x, z);
        const bad = road || y < wl + 0.4 || slope > 0.42;
        // MOSS SHEETS, on the ANTI-clump: moss takes the damp shaded floor the bracken is NOT standing on,
        // so the two layers interlock instead of stacking, and the bare duff between clumps stops existing.
        // Banks steeper than ~17 deg are skipped (roots and washout, not a moss bed); the rest lie ON the
        // slope, aligned to the terrain normal below.
        // A 6 m lattice can hold at most one sheet per 36 m², which measured 18 instances in frame — a
        // rounding error, not a surface (tools/out/L5-a2-forest, moss [1453, 18]). Moss grows in PATCHES,
        // so an accepted cell drops 2-4 overlapping sheets inside ±2.4 m: the coverage that makes it read,
        // the clumping that keeps it from being a lawn, and the same one draw call.
        if (this.moss && !bad && slope < 0.30 && drng() < 0.60 * (1.15 - clump) * bu.w) {
          const nM = 2 + ((drng() * 3) | 0);
          for (let k = 0; k < nM; k++) {
            const mx = x + (drng() - 0.5) * 4.8, mz = z + (drng() - 0.5) * 4.8;
            const my = terrain.heightAt(mx, mz); if (my < wl + 0.4) continue;
            const ms = 0.8 + drng() * 1.4;
            // LIE ON THE GROUND. A horizontal 2.8 m card on a 15 deg bank sinks 0.4 m in at the uphill edge
            // and floats 0.4 m off at the downhill one — the flat-card version of a decal with no projection.
            // Align to the terrain normal first, then spin about it, so the sheet follows the slope.
            terrain.normalAt(mx, mz, Nv);
            Qt.setFromUnitVectors(UPV, Nv).multiply(Qs.setFromAxisAngle(UPV, drng() * 6.2832));
            P.set(mx, my + 0.035, mz); S.set(ms * (0.85 + drng() * 0.4), 1, ms * (0.85 + drng() * 0.4)); M.compose(P, Qt, S);
            // SATURATE THE COLOUR, CAP THE VALUE — and here that is not a slogan, it is the whole bug.
            // card_moss is a HANGING DRAPE asset (ASSETS.md: fen snags): pale sage-grey strands, almost
            // no chroma of its own. The first tint was near-neutral (channel ratio 0.72/1.00/0.89 at
            // value ~0.79), so the surface had nothing to hold a hue with and simply took the colour of
            // whatever lit it — under a closed canopy that is blue-violet sky fill, and the layer read as
            // pale blue-grey rags stapled to the duff (S1-before/shot-12-floor8.png, the patches around
            // the near trunk). Value HIGHER than the floor it sits on plus no hue = a light blob, which
            // is the same disease as the meadow's white blobs one stop down.
            // 0.34/0.86/0.46 is a real moss green with the chroma to survive a blue fill, and the value
            // is now BELOW the duff instead of above it: damp shaded ground, not a sticker. Albedo only,
            // no emissive, max channel <= 0.85.
            // Blue stays LOW on purpose. The light reaching a horizontal card under a closed canopy is
            // mostly blue-violet sky fill, so a tint with blue anywhere near green hands the surface's hue
            // straight to the fill and the floor goes cyan (S2a/shot-12-a-floor8.png, first tint pass).
            // 0.40/0.92/0.32 is warm forest green with enough chroma to win that argument.
            const mg = 0.58 + drng() * 0.32, tq = drng() * 0.14;
            C.setRGB(mg * (0.40 - tq * 0.5), mg * 0.92, mg * (0.32 + tq));   // tq: a few patches drift teal, the region's accent

            this.moss.add(M, C);
          }
        }
        if (!this.understory) continue;
        if (rng() > 0.62 * clump * bu.w) continue;
        if (bad) continue;
        const s = 0.55 + rng() * 1.45, lean = 0.22;                                  // 0.55-2.0 m: the size spread the grass card cannot have
        E.set((rng() - 0.5) * lean, rng() * Math.PI * 2, (rng() - 0.5) * lean); Qt.setFromEuler(E);
        P.set(x, y - 0.06 * s, z); S.set(s * (0.8 + rng() * 0.5), s, s * (0.8 + rng() * 0.5)); M.compose(P, Qt, S);
        const g = 0.62 + rng() * 0.5; C.setRGB(g * (0.72 + rng() * 0.22), g, g * (0.66 + rng() * 0.3));   // deep green .. teal, matching BTREE.forest
        this.understory.add(M, C);
      }
    }
    // ---- rocks
    for (let gx = -half; gx < half; gx += 10) for (let gz = -half; gz < half; gz += 10) {
      const x = gx + (rng() - 0.5) * 9, z = gz + (rng() - 0.5) * 9; if (!ok(x, z)) continue;
      const r0 = Math.hypot(x, z); if (r0 < 18 || aethD(x, z) < 12 || arenaD(x, z) < 48) continue;
      const y = terrain.heightAt(x, z); if (y < wl - 1) continue; const slope = terrain.slopeAt(x, z); if (slope > 0.75) continue;
      const rd = ruinD(x, z); let p = 0.04 + smoothstep(20, 60, y) * 0.03 + smoothstep(0.15, 0.45, slope) * 0.05; if (y > 50) p *= 0.4;
      if (rd < 45) p = rd < 12 ? 0 : 0.35; if (x > 220 && r0 < 400) p += 0.1; if (r0 < 60) p *= 0.5; if (lakeD(x, z) < 110 && y < wl + 3) p += 0.12;
      if ((terrain.roadAt?.(x, z) ?? 0) > 0.35) continue;
      const br = B(x, z);
      const rnb = br.m > 0.001 && rng() < br.m, rId = rnb ? br.id2 : br.id, rW = rnb ? br.w2 : br.w;   // border interleave, see the tree loop
      const bRock = rW > 0.02 ? BROCK[rId] : null;
      if (bRock) p = p * (1 - rW) + bRock.p * rW;
      if (inLandmark(br, x, z)) continue;                               // hero landmarks keep their own ground
      // The frozen lake at the Frostveil heart is a raised flat ICE SHEET (bed at 4.22 m, walkable) — it is
      // ICE, not a rock yard. 0.12 still left a litter of boulders across it in every hero frame
      // (crit3-tundra-b/shot-throne-58.png), so the sheet itself is now bare and the band just off it is
      // thinned; the shore keeps its rocks. Bowl SLOPE floaters are a seating bug, fixed by seat() below.
      if (bRock && rId === 'tundra' && slope < 0.10) { if (y < wl + 1.6) continue; if (y < wl + 4.0) p *= 0.15; }
      if (rng() > p) continue;
      const big = rng() < (slope > 0.2 || y > 30 ? 0.35 : 0.15) && rd > 45;
      const kind = big ? 0 : 1 + Math.floor(rng() * 3); const scale = big ? 2.2 + rng() * 3 : (rd < 45 ? 0.35 + rng() * 0.7 : 0.5 + rng() * 1.3);
      if (big) { // no pine through a dome boulder (crit2-tundra/crop-dome): big rocks yield to standing trees
        const rr = 1.1 * scale + 0.8; let hit = false;
        for (const t of this.trees) if (Math.abs(t.x - x) < rr && Math.abs(t.z - z) < rr) { hit = true; break; } // ponytail: linear scan, ~500 big rocks x ~5k trees once at boot; grid-hash if it ever shows in the boot profile
        if (hit) continue;
      }
      E.set((rng() - 0.5) * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.5); Qt.setFromEuler(E);
      // seat on the LOWEST ground under the WHOLE footprint (see seat()), then sink deeper: a boulder that
      // only kisses the ground shows daylight under its downhill lip on any slope worth the name.
      const yb = seat(x, z, scale * 0.82);
      if (seatHi - yb > 1.25 * scale) continue;                        // no resting place: this is a cliff, not ground
      P.set(x, yb - 0.34 * scale, z); S.setScalar(scale); M.compose(P, Qt, S);
      const g = 0.75 + rng() * 0.35; C.setRGB(g * (1 + (rng() - 0.5) * 0.1), g, g * (1 - rng() * 0.08));
      if (bRock) { const t = bRock.col; C.setRGB(C.r * lerp(1, t[0], rW), C.g * lerp(1, t[1], rW), C.b * lerp(1, t[2], rW)); }
      const grp = (bRock?.grp && this._rockGrp[bRock.grp] && rW > 0.35) ? bRock.grp : 'default';
      this._rockGrp[grp][kind].add(M, C); this.rocks.push({ x, y, z, kind, scale });
      col.add({ type: 'sphere', pos: new THREE.Vector3(x, yb - 0.15 * scale, z), r: scale * (kind === 0 ? 0.95 : kind === 2 ? 0.9 : 0.75) });
    }
    // ---- crystals: east fields + forest + around the aetheryte (no random confetti on open hillsides)
    const addCrystal = (x, z, scale, variant, tint, aspect) => {
      const y = terrain.heightAt(x, z); E.set((rng() - 0.5) * 0.2, rng() * Math.PI * 2, (rng() - 0.5) * 0.2); Qt.setFromEuler(E);
      const ax = aspect ? aspect[0] : 1, ay = aspect ? aspect[1] : 1;
      // seat on the lowest ground under the whole cluster footprint, then bury the foot: a shard standing
      // on its point over downhill air was half of the "floating boulders and shards litter the lake bowl"
      // finding (crit3-tundra-b/crop-float2.png)
      const yb = seat(x, z, scale * ax * 0.75);
      if (seatHi - yb > 1.1 * scale * ay) return;                      // a shard cannot grow out of a cliff face either
      P.set(x, yb - 0.28 * scale * ay, z); S.set(scale * ax, scale * ay, scale * ax); M.compose(P, Qt, S);
      const hue = rng();
      // Per-instance HUE jitter, not just brightness: a region of identically-coloured spires is the
      // "no variation between instances beyond scale" read (crit3-void-b). The jitter is a rotation
      // WITHIN the region's band (+-9% on the off-channels), so the palette holds and the value does not
      // move — saturate the colour, cap the value.
      if (tint) { const j = 0.88 + hue * 0.24, h2 = rng() - 0.5;
        C.setRGB(tint[0] * j * (1 + h2 * 0.18), tint[1] * j * (1 - h2 * 0.10), tint[2] * j * (1 - h2 * 0.16)); }
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
      const bc = B(x, z);
      const snb = bc.m > 0.001 && rng() < bc.m, sId = snb ? bc.id2 : bc.id, sW = snb ? bc.w2 : bc.w;   // border interleave, see the tree loop
      const bSpire = sW > 0.02 ? BSPIRE[sId] : null;
      if (bSpire) p = p * (1 - sW) + bSpire.p * sW * smoothstep(0.05, 0.4, 0.5 + 0.5 * fbm(x * 0.016, z * 0.016, { octaves: 3, seed: 23 }));
      if (inLandmark(bc, x, z)) continue;                               // hero landmarks keep their own ground
      if (sId === 'tundra' && sW > 0.02 && y < wl + 1.6 && terrain.slopeAt(x, z) < 0.10) continue;   // the frozen lake is an ice SHEET, not a shard field
      if (rng() > p) continue;
      // `own` at w > 0.4 was the second half of the forest magenta bug: between 0.02 and 0.4 the spire was
      // placed by the REGION's probability but handed the home meadow's cyan..magenta jitter, so the
      // Whisperwood's outer band grew fuchsia aether spires (crit3-forest-c/shot-west-band-in.png). If the
      // region put it there, the region colours it.
      const own = bSpire && sW > 0.12;
      const scale = own ? bSpire.s[0] + rng() * (bSpire.s[1] - bSpire.s[0])
        : field > 0.3 ? 2.6 + rng() * 2.6 : 0.9 + rng() * 1.1;
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

  /** THE ELDERHEART'S CROWN (forest blocker, crit3-forest-b/shot-approach-80.png + crit3-forest-c/
   *  shot-lowsun-into-sun.png): Props builds the hero tree's canopy as flat-shaded icosahedron blobs, and
   *  from every bearing it caps the treeline as "a pile of low-poly boulders instead of foliage".
   *  Foliage cards are THIS file's system, so the crown is re-dressed here instead of re-modelled there:
   *  the blob mesh is kept — dark, matte, smooth-shaded — as the canopy's inner MASS (it is what gives the
   *  crown volume and self-shadowing, and it is why a card shell alone reads as a hedge), and its own
   *  triangles are used as anchors for a painterly leaf-card shell built with the same cards()/LEAF_CROPS
   *  canopy every tree in the world uses. ~560 cards, one draw call, ~2.2 k tris on a 45 m landmark.
   *  Runs once on the first update: Props builds after Vegetation (World.parts order), so the mesh does
   *  not exist yet at init time.
   *  ponytail: reaches into Props' scene object by name rather than Props calling an export — upgrade path
   *  is a `vegetation.dressCanopy(mesh, opts)` call from Props._buildBiomeClutter (raised as an ask). */
  _dressElderheart() {
    const scene = this.game.scene, src = scene.getObjectByName('elderheart-crown');
    if (!src?.geometry || !this._leafCard) return false;
    const pos = src.geometry.attributes.position;
    if (!pos || pos.count < 9) return false;
    const rng = mulberry32(this.game.seed + 9131);
    const box = new THREE.Box3().setFromBufferAttribute(pos), C0 = box.getCenter(new THREE.Vector3());
    const L = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), cen = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    const tris = (pos.count / 3) | 0, step = Math.max(1, Math.round(tris / 1000));
    for (let t = 0; t < tris; t += step) {
      a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
      cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2).normalize();
      if (n.dot(cen.clone().sub(C0)) < 0) n.negate();                    // outward, whatever the winding says
      // jitter the anchor across the face and push the card proud of the shell, so the cards read as a
      // ragged foliage surface instead of a decal sheet lying on a polyhedron
      const u = rng(), v = rng() * (1 - u);
      cen.copy(a).addScaledVector(e1, u).addScaledVector(e2, v).addScaledVector(n, 0.9 + rng() * 1.5);
      n.x += (rng() - 0.5) * 0.7; n.y += (rng() - 0.5) * 0.5 + 0.25; n.z += (rng() - 0.5) * 0.7;
      card(L, cen.clone(), n.clone().normalize(), 5.4, 4.6, rng, { ao: 0.72 + rng() * 0.28 });
    }
    const geo = cards(L, C0, 0.24);
    const mat = patchMaterial(new THREE.MeshStandardMaterial({
      map: this._leafCard, alphaTest: 0.38, side: THREE.DoubleSide, roughness: 0.96, metalness: 0, color: 0xb6e0b4,
    }), {
      key: 'elderheart-canopy',
      vHead: 'attribute vec2 aLeaf; attribute vec2 aLuv; varying vec2 vLeaf; varying vec2 vLuv;',
      vBegin: 'vLeaf = aLeaf; vLuv = aLuv;',
      fHead: `varying vec2 vLeaf; varying vec2 vLuv;
        const vec3 EH_COOL = vec3(0.62, 0.95, 0.78);    // shaded blue-green, the Whisperwood accent
        const vec3 EH_WARM = vec3(1.12, 1.06, 0.66);    // sun-struck golden-green`,
      // per-card hue + crown-depth AO: an inner card is darker than a rim card, which is what turns a shell
      // of quads into a canopy with depth. Matte only — a landmark canopy that glows is the blob decree.
      // The radial mask fades each card out toward its OWN border (aLuv, not uv — uv is inside a LEAF_CROPS
      // window), so no card can present a straight edge whatever texel it sampled.
      fMap: `#include <map_fragment>
        diffuseColor.rgb *= mix(EH_COOL, EH_WARM, vLeaf.x) * (0.60 + 0.40 * vLeaf.y);
        diffuseColor.a *= 1.0 - smoothstep(0.72, 1.30, length(vLuv - 0.5) * 2.0);`,
    });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true; m.name = 'elderheart-canopy';
    m.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: this._leafCard, alphaTest: 0.46, side: THREE.DoubleSide });
    scene.add(m);
    // The blob shell stays, as shadow and mass — but dark and SMOOTH: flat shading on an icosahedron is
    // exactly the faceted-boulder tell, and the cards only cover ~80% of it.
    try { src.geometry = mergeVertices(src.geometry); } catch (e) { /* welding is a nicety; the cards are the fix */ }
    src.geometry.computeVertexNormals();
    src.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, color: 0x9ec2a2 });
    this.elderheartCanopy = m;
    return true;
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
    if (!this._dressed) { this._dressed = true; try { this._dressElderheart(); } catch (e) { console.warn('[vegetation] elderheart canopy', e); } }
    U.uTime.value = t;
    if (sky) { U.uSunDirV.value.copy(sky.sunDir).transformDirection(camera.matrixWorldInverse); U.uSunColor.value.copy(sky.sunColor); U.uSunI.value = sky.sunIntensity ?? 1; }
    this.groundScatter?.update();   // no-op unless the camera crossed a 6 m cell
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
