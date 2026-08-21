import * as THREE from 'three';
import { mulberry32, hash2, noise2, smoothstep, clamp, lerp } from '../core/Noise.js';

/**
 * Terrain: heightfield mesh + height/normal queries used by everything else (player, grass, water, props, AI).
 * API (stable — other systems depend on it):
 *   terrain.size            world extent in meters (square, centered on origin)
 *   terrain.waterLevel      y of the water plane
 *   terrain.heightAt(x, z)  -> y   (analytic, works anywhere, cheap enough to call thousands of times/frame)
 *   terrain.normalAt(x, z, outVec3) -> outVec3
 *   terrain.slopeAt(x, z)   -> 0..1 (0 flat, 1 vertical)
 *   terrain.biomeAt(x, z)   -> 'meadow'|'forest'|'lake'|'ruins'|'crystal'|'arena'|'mountain'
 *   terrain.colorAt(x, z, outColor) -> THREE.Color  approximate LINEAR ground albedo, matches the material's splat
 *                            (analytic + the exact layer-7 macro noise; Grass uses it to blend far blades into the ground)
 *   terrain.POI             { spawn, aetheryte, lake, ruins, forest, crystal, arena } Vector3 at ground height
 *   terrain.mesh            THREE.Group of the LOD level meshes (receives + casts shadows). terrain.mesh.material = the shared material.
 *   terrain.meshes          the per-level THREE.Mesh list, terrain.material the shared MeshStandardMaterial
 *
 * Implementation:
 *   - heightAt is a pure analytic function (noise + feature masks for the CLAUDE.md world layout), band-limited to >= 8 m
 *     wavelengths so a 1 m bake reproduces it. Workers (started in the constructor, same source) bake it into a 1024² R32F
 *     texture + an RGBA8 normal/AO map, and generate the 8 tiling layer textures (sRGB8 array, mips + anisotropy).
 *     Real asset albedos (public/assets/tex, see ASSETS.md) are fetched in parallel and merged over the grass/rock/sand/snow
 *     layers (procedural output stays the fallback + supplies macro shading). Uploads are STAGGERED (one item per frame).
 *   - LOD = geometry clipmap on the GPU: L nested square levels (1, 2, 4, 8, 16 m spacing) snapped to their own grid,
 *     vertex shader fetches height from the bake, morphs toward the coarser level at the edge (continuous, no pops/cracks).
 *     One shared material, per-level data carried by the mesh matrix (position = snapped origin, scale = spacing).
 *   - Material = MeshStandardMaterial + onBeforeCompile: slope/height/biome splat of 7 layers with hex-tile stochastic
 *     sampling (three-hex-tiling technique, MIT) on grass + triplanar rock, per-region strata, detail bump, macro variation,
 *     far-scale albedo patches (contrast survives distance), shoreline wetness, cavity AO, aether motes.
 */
const WL = 4.0;
const TEX = 1024;            // height/normal bake resolution (1 texel = 1 m), covers [-512, 512)
const LAYERS = 8;            // 0 grass 1 forest 2 dirt 3 rock 4 sand 5 snow 6 stone 7 detail(nx,nz,h,macro)

const ss = smoothstep, mix = lerp, n2 = noise2;
// unrolled fbm/ridged (same lattice + seed scheme as Noise.js fbm/ridged, no options object => ~2x faster)
const fbm2 = (x, y, s) => (n2(x, y, s) * 0.5 + n2(x * 2, y * 2, s + 101) * 0.25) / 0.75;
const fbm3 = (x, y, s) => (n2(x, y, s) * 0.5 + n2(x * 2, y * 2, s + 101) * 0.25 + n2(x * 4, y * 4, s + 202) * 0.125) / 0.875;
const fbm4 = (x, y, s) => (n2(x, y, s) * 0.5 + n2(x * 2, y * 2, s + 101) * 0.25 + n2(x * 4, y * 4, s + 202) * 0.125 + n2(x * 8, y * 8, s + 303) * 0.0625) / 0.9375;
const rg = (x, y, s) => { const n = 1 - Math.abs(n2(x, y, s)); return n * n; };
const ridged3 = (x, y, s) => (rg(x, y, s) * 0.5 + rg(x * 2, y * 2, s + 131) * 0.25 + rg(x * 4, y * 4, s + 262) * 0.125) / 0.875;
const ridged4 = (x, y, s) => (rg(x, y, s) * 0.5 + rg(x * 2, y * 2, s + 131) * 0.25 + rg(x * 4, y * 4, s + 262) * 0.125 + rg(x * 8, y * 8, s + 393) * 0.0625) / 0.9375;
// Ridged MULTIFRACTAL: the crest is (1 - |n|) UNSQUARED, so the ridge stays a crease (arete) instead of being rounded into a
// meringue dome by the square; each octave is gated by the previous one so detail branches off the main ridges = faceted crags.
// `oct` is the band-limit knob: 3 for the far ring (>=44 m features, coarse clipmap levels reproduce them), 4 near the player.
const rmf = (x, y, s, oct) => {
  let sum = 0, nrm = 0, a = 0.55, f = 1, w = 1;
  for (let o = 0; o < oct; o++) {
    const n = (1 - Math.abs(n2(x * f, y * f, s + o * 137))) * w;
    w = n * 1.7 > 1 ? 1 : n * 1.7;
    sum += n * a; nrm += a; a *= 0.52; f *= 2.07;
  }
  return sum / nrm;
};

export class Terrain {
  constructor(game) {
    this.game = game;
    this.size = 1024;
    this.waterLevel = WL;
    this.seed = game.seed;
    this._n = new THREE.Vector3();
    const P = (x, z) => new THREE.Vector3(x, this.heightAt(x, z), z);
    this.POI = { spawn: P(0, 0), aetheryte: P(0, -28), lake: P(-170, -70), ruins: P(140, 60), forest: P(0, -235), crystal: P(300, 0), arena: P(-60, 260) };
    this._R = game.quality === 'low' ? 256 : game.quality === 'ultra' ? 1024 : 512;   // layer texture resolution
    this._baked = this._bakeAsync();                    // workers start now, overlapping the other systems' init
  }

  // ---------------------------------------------------------------- height field (pure, analytic)
  heightAt(x, z) {
    const s = this.seed;
    let h = 9 + fbm4(x * 0.0035, z * 0.0035, s) * 9 + fbm2(x * 0.02 + 7.3, z * 0.02 - 2.1, s + 3) * 1.2 + n2(x * 0.12, z * 0.12, s + 4) * 0.15;
    if (h < 7) h = 7 - 1.2 * (1 - Math.exp((h - 7) / 1.2));          // soft floor at 5.8: no stray puddles outside the lake
    const d0 = Math.sqrt(x * x + z * z);
    const me = ss(140, 70, d0);                                          // spawn meadow: gentle
    h = mix(h, 8.5 + (h - 9) * 0.35, me);
    const lx = x + 170, lz = z + 70; let low = 0;                        // Mirrormere: grassy apron, steep shore drop, bowl, island
    if (lx * lx + lz * lz < 36100) {
      const dL = Math.sqrt(lx * lx + lz * lz) + n2(x * 0.015, z * 0.015, s + 11) * 12;
      low = ss(150, 100, dL);
      h = mix(h, 8.2 + (h - 9) * 0.35, low);       // apron stays above the beach band -> grass meets a 6-12 m beach, not a sand pancake
      h = mix(h, 1.6, ss(98, 74, dL));             // shoreline: ~6.5 m drop over ~20 m -> waterline still near dL 82
      // Deep water now starts much closer in (was ss(72, 32)). Mirrormere was a 1.2 m paddling shelf across
      // most of its width, and no absorption curve makes 1.2 m of water read as anything but a turquoise
      // swimming pool: the "water looks bad" report is a BASIN-shape problem as much as a shader one.
      // Shoreline, beach band and lake footprint are unchanged; only the middle drops away.
      h = mix(h, -5.5, ss(80, 38, dL));
      const ix = x + 150, iz = z + 60;
      h += 12 * ss(38, 10, Math.sqrt(ix * ix + iz * iz) + n2(x * 0.05, z * 0.05, s + 12) * 4);   // island bump raised with the floor so it stays an island
    }
    const rx = x - 140, rz = z - 60; let pl = 0;                         // Sundered Spire plateau: steep craggy rock skirt
    if (rx * rx + rz * rz < 9025) {
      pl = ss(66, 56, Math.sqrt(rx * rx + rz * rz) + n2(x * 0.02, z * 0.02, s + 5) * 7 + n2(x * 0.055, z * 0.055, s + 63) * 3);
      h = mix(h, 17.5 + (h - 9) * 0.15, pl);
      const sk = pl * (1 - pl) * 4;                                      // skirt band only (0 on top and on the meadow)
      if (sk > 0.02) {                                                   // domain-warped jagged outcrops: teeth that BREAK the silhouette
        const ox = x + n2(x * 0.033, z * 0.033, s + 61) * 10, oz = z + n2(x * 0.033 + 5, z * 0.033 + 5, s + 62) * 10;
        // creased 4-octave RMF (36/17/8/4 m) -> broken outcrops with vertical faces, not a felt mound (skirt sits in clipmap L0/L1)
        h += sk * (rmf(ox * 0.028, oz * 0.028, s + 6, 4) * 16 - 4.8 + n2(ox * 0.1, oz * 0.1, s + 64) * 1.6);
      }
    }
    const ax = x + 60, az = z - 260; let ar = 0;                         // Hollow Crown arena: flat disc + rocky rim wall
    if (ax * ax + az * az < 7225) { const dA = Math.sqrt(ax * ax + az * az); ar = ss(62, 47, dA); h = mix(h, 11, ar); h += 6 * ss(48, 58, dA) * ss(84, 62, dA); }
    const keep = (1 - me) * (1 - low) * (1 - pl) * (1 - ar);
    if (keep > 0.001) {                                                  // bluffs, forest hills, crystal ridges
      let add = ss(0.52, 0.62, fbm3(x * 0.004 + 11, z * 0.004 - 5, s + 31)) * 6;
      if (z < -140) { const fo = ss(-140, -220, z) * ss(300, 240, Math.abs(x)); if (fo > 0) add += fo * (3 + fbm3(x * 0.006 + 3, z * 0.006, s + 8) * 5); }
      if (x > 190) add += ss(190, 260, x) * (3 + ridged3(x * 0.008, z * 0.008, s + 9) * 9);
      h += keep * add;
    }
    if (d0 > 236) {                                                      // mountain ring: craggy wall + sharp warped crests + varied strata ledges + NW pass
      const dm = d0 + fbm3(x * 0.004, z * 0.004, s + 21) * 60;
      const mt = ss(352, 462, dm), wall = ss(326, 380, dm);
      const belt = ss(238, 306, dm) * ss(404, 340, dm) * (1 - ar);       // approach belt: rocky knolls/scree, not a featureless dirt ramp
      let da = Math.abs(Math.atan2(z, x) + 2.356); if (da > Math.PI) da = 2 * Math.PI - da;
      const pass = 1 - 0.72 * ss(0.6, 0.15, da);
      if (belt > 0.01) {                                                 // warped creased knolls + boulder-scale bumps across the whole approach
        const bx = x + n2(x * 0.019, z * 0.019, s + 39) * 13, bz = z + n2(x * 0.019 + 4, z * 0.019 - 6, s + 40) * 13;
        h += belt * (0.4 + 0.6 * pass) * (rmf(bx * 0.017, bz * 0.017, s + 29, 4) * 14 - 3.9 + n2(x * 0.062, z * 0.062, s + 30) * 1.7);
      }
      if (mt > 0 || wall > 0) {
        // TWO-stage domain warp: ridge lines bend and fork instead of running as parallel arcs around the ring
        const wx = x + n2(x * 0.0072, z * 0.0072, s + 24) * 48 + n2(x * 0.024, z * 0.024, s + 34) * 8;
        const wz = z + n2(x * 0.0072 + 9.2, z * 0.0072 - 4.1, s + 25) * 48 + n2(x * 0.024 + 3.1, z * 0.024 + 7.7, s + 35) * 8;
        const massif = rmf(wx * 0.0053, wz * 0.0053, s + 17, 3);         // 190/91/44 m arete network — creased crests, band-limited for the 16 m LOD
        const crag = rmf(wx * 0.0135, wz * 0.0135, s + 23, 4);           // 74/36/17/8 m faceted crag detail (near wall renders at 1-4 m stride)
        // SUMMITS vs COLS: a ~310 m mask so the crest line is a row of separate peaks with saddles between
        // them. Without it every section of the ring tops out at the same altitude, which from the meadow
        // reads as one continuous bank — the "elongated slope, not jaggy mountains" report.
        const summit = 0.30 + 0.85 * ss(0.22, 0.86, fbm2(x * 0.0032 + 3.7, z * 0.0032 - 8.1, s + 41) * 0.5 + 0.5);
        // crag SQUARED. An rmf crest sits near 1 while its flanks collapse fast, so squaring turns a cosine
        // swell into a face + arete pair: 40-70 m of relief with steep sides. Linear crag (what shipped) is
        // exactly the smooth dune the snow then drapes as a bedsheet — the shape fix, not the amount.
        const teeth = crag * crag;
        // the NW pass lowers the CRESTS, not the rock: crag detail keeps most of its amplitude in the
        // saddle, so the pass reads as a rocky notch instead of a smooth bank (the "mountain looks
        // like a slope" report — pass * everything flattened the whole gap into a dune)
        let m = wall * (12 + 26 * teeth) * (0.65 + 0.35 * pass)
              + mt * ((14 + 54 * massif) * summit * pass + 52 * teeth * (0.5 + 0.5 * pass));   // ring crests ~120-175 m (CLAUDE.md: ~150)
        // bedding planes: amplitude, frequency, TILT and presence all vary per region, so the ring is never one corduroy
        const reg = n2(x * 0.0035, z * 0.0035, s + 28), reg2 = n2(x * 0.011 + 4.4, z * 0.011 - 2.2, s + 36);
        const bandAmt = ss(0.30, 0.74, fbm2(x * 0.0055, z * 0.0055, s + 37) * 0.5 + 0.5) * mt;
        // ~23 m-period ledges cut ACROSS the faces. At 400 m the step edge is what reads as rock rather than
        // felt, and it costs one sin of a value we already have; amplitude raised with the steeper faces.
        if (bandAmt > 0.01) m -= (4.5 + 8.5 * reg * reg) * Math.sin(m * (0.27 + 0.15 * reg) + (x - z) * 0.011 * reg + reg2 * 5) * bandAmt;
        h += m;
      }
      h += ss(462, 530, dm) * 45;
    }
    return h;
  }
  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 0.5;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z), hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }
  slopeAt(x, z) { return 1 - clamp(this.normalAt(x, z, this._n).y, 0, 1); }
  biomeAt(x, z) {
    const h = this.heightAt(x, z);
    if (h > 45 || x * x + z * z > 160000) return 'mountain';
    const lx = x + 170, lz = z + 70; if (lx * lx + lz * lz < 13225 && h < WL + 2.5) return 'lake';
    const ax = x + 60, az = z - 260; if (ax * ax + az * az < 3600) return 'arena';
    const rx = x - 140, rz = z - 60; if (rx * rx + rz * rz < 5184) return 'ruins';
    if (z < -180 && Math.abs(x) < 260) return 'forest';
    if (x > 220) return 'crystal';
    return 'meadow';
  }

  // exact JS twin of the layer-7 alpha macro noise the shader samples (same seeded permutation table)
  _macroNoise(u, v) {
    let P = this._perm;
    if (!P) {
      P = this._perm = new Uint8Array(512);
      const rnd = mulberry32((this.seed * 7919) | 0);
      for (let i = 0; i < 256; i++) P[i] = i;
      for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0, t = P[i]; P[i] = P[j]; P[j] = t; }
      for (let i = 0; i < 256; i++) P[256 + i] = P[i];
    }
    const pm = (x, p) => x - Math.floor(x / p) * p;
    const hash = (x, y, per) => P[(P[pm(x, per) & 255] + pm(y, per)) & 255] * (1 / 255);
    let sum = 0, amp = 0.5, nrm = 0, f = 2, uu = u + 7.7, vv = v + 7.7;
    for (let o = 0; o < 3; o++) {                                        // fbm(u+7.7, v+7.7, 2, 3) from layerTex
      const px = (uu + o * 0.173) * f, py = (vv + o * 0.173) * f, ix = Math.floor(px), iy = Math.floor(py);
      let fx = px - ix, fy = py - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
      const a = hash(ix, iy, f), b = hash(ix + 1, iy, f), c = hash(ix, iy + 1, f), d = hash(ix + 1, iy + 1, f);
      sum += amp * mix(mix(a, b, fx), mix(c, d, fx), fy); nrm += amp; amp *= 0.5; f *= 2;
    }
    return sum / nrm;
  }

  // approximate LINEAR ground albedo at (x,z) — mirrors the shader splat weights with per-layer mean colors.
  // ~3 heightAt + 2 macro noise calls => a few µs; safe for Grass's 100k init samples.
  colorAt(x, z, out = new THREE.Color()) {
    const h = this.heightAt(x, z);
    const e = 1.2, dxh = (this.heightAt(x + e, z) - h) / e, dzh = (this.heightAt(x, z + e) - h) / e;
    const slope = 1 - 1 / Math.sqrt(1 + dxh * dxh + dzh * dzh);
    const macro = this._macroNoise(x * (1 / 143), z * (1 / 143));
    const macro2 = this._macroNoise(x * (1 / 61) + 0.37, z * (1 / 61) + 0.37);
    const macroC = ss(0.33, 0.67, macro), macro2C = ss(0.35, 0.65, macro2);
    const lakeM = 1 - ss(105, 150, Math.hypot(x + 170, z + 70));
    const rd = Math.hypot(x - 140, z - 60), d0c = Math.hypot(x, z);
    const ruinM = 1 - ss(50, 70, rd + (macro2 - 0.5) * 16);
    const skirtM = ss(76, 58, rd) * ss(38, 52, rd);
    const arenaM = 1 - ss(43, 49, Math.hypot(x + 60, z - 260));
    const forestM = ss(-150, -215, z + (macro - 0.5) * 40) * ss(290, 245, Math.abs(x));
    const mtn = Math.max(ss(26, 40, h + (macro - 0.5) * 10), ss(340, 400, d0c + (macro - 0.5) * 70));
    const crystalM = ss(195, 260, x + (macro - 0.5) * 40) * (1 - mtn);
    const alt = ss(26, 58, h);
    let wSnow = ss(104, 138, h + (macro - 0.5) * 24) * (1 - ss(0.22, 0.46, slope));
    const rockTh = mix(0.30, 0.12, Math.max(alt, Math.max(mtn, skirtM)));
    let wRock = ss(rockTh - 0.13, rockTh + 0.16, slope + (macro - 0.5) * 0.10);
    const beltM = ss(238, 296, d0c) * (1 - ss(348, 412, d0c));
    wRock = Math.max(wRock, beltM * ss(0.26, 0.60, macro2C) * ss(0.02, 0.09, slope));
    wRock = Math.max(wRock, skirtM * ss(0.10, 0.20, slope + (macro - 0.5) * 0.08));
    let wSand = lakeM * ss(WL + 1.9, WL + 0.9, h + (macro2 - 0.5) * 0.9);
    let wStone = Math.max(ruinM, arenaM);
    let wDirt = clamp(ss(0.12, 0.26, slope + (macro2 - 0.5) * 0.06) + ss(0.64, 0.80, macro2) * 0.7 + crystalM * 0.35 + alt * 0.5 + mtn * 0.75, 0, 1);
    let wForest = forestM * (1 - mtn);
    let wGrass = 1 - mtn;
    wGrass *= 1 - wForest;
    let k = 1 - wDirt; wGrass *= k; wForest *= k;
    k = 1 - wStone; wGrass *= k; wForest *= k; wDirt *= k;
    k = 1 - wSand; wGrass *= k; wForest *= k; wDirt *= k; wStone *= k;
    k = 1 - wRock; wGrass *= k; wForest *= k; wDirt *= k; wStone *= k; wSand *= k;
    k = 1 - wSnow; wGrass *= k; wForest *= k; wDirt *= k; wStone *= k; wSand *= k; wRock *= k;
    const sum = wGrass + wForest + wDirt + wStone + wSand + wRock + wSnow + 1e-5;
    // per-layer mean linear albedos (match the merged asset albedos + shader-side rock/sand modifiers)
    const dry = ss(0.42, 0.64, macro2) * (1 - forestM) * 0.6;
    let gr_ = mix(0.099, 0.21, dry), gg = mix(0.218, 0.30, dry), gb = mix(0.033, 0.018, dry);     // grass_albedo.jpg mean (+sun-dried tint)
    const rMac = mix(0.80, 1.28, macro2), rr = 0.222 * rMac, rgc = 0.206 * rMac, rb = 0.172 * rMac; // cliff_strata.jpg mean, warm/cool patches
    const sw = ss(0.35, 0.65, macro2), sr = 0.52 * mix(1.08, 0.90, sw), sg = 0.42 * mix(0.98, 0.88, sw), sb = 0.21 * mix(0.85, 0.95, sw);
    let r = (gr_ * wGrass + 0.15 * wForest + 0.24 * wDirt + 0.45 * wStone + sr * wSand + rr * wRock + 0.51 * wSnow) / sum;
    let g = (gg * wGrass + 0.11 * wForest + 0.19 * wDirt + 0.42 * wStone + sg * wSand + rgc * wRock + 0.60 * wSnow) / sum;
    let b = (gb * wGrass + 0.05 * wForest + 0.14 * wDirt + 0.36 * wStone + sb * wSand + rb * wRock + 0.74 * wSnow) / sum;
    const neut = (wStone + wRock + wSnow) / sum;                                                  // stone/rock/snow stay untinted
    const tR = mix(mix(0.84, 1.10, macro) * (0.9 + 0.2 * macro2), 1, neut);
    const tG = mix(mix(0.87, 1.07, macro) * (0.9 + 0.2 * macro2), 1, neut);
    const tB = mix(mix(0.70, 0.98, macro) * (0.9 + 0.2 * macro2), 1, neut);
    r *= tR; g *= tG; b *= tB;
    const fm = forestM * 0.6; r *= mix(1, 0.78, fm); g *= mix(1, 0.86, fm); b *= mix(1, 0.74, fm);
    const cm = crystalM * 0.7; r = r * mix(1, 0.92, cm) + 0.02 * cm; g = g * mix(1, 0.84, cm) + 0.01 * cm; b = b * mix(1, 1.12, cm) + 0.05 * cm;
    // the shader ramps this macro contrast in with camera distance; Grass mostly uses colorAt for FAR blades, so carry ~60% of it
    const vg = (1 - neut) * 0.55, mC = macroC * 0.62 + macro2C * 0.38;
    r *= mix(1, mix(0.60, 1.36, mC), vg); g *= mix(1, mix(0.70, 1.24, mC), vg); b *= mix(1, mix(0.50, 1.02, mC), vg);
    const wet = lakeM * ss(WL + 6.5, WL + 0.2, h);
    r *= mix(1, 0.30, wet); g *= mix(1, 0.35, wet); b *= mix(1, 0.44, wet);
    return out.setRGB(r, g, b);
  }

  // ---------------------------------------------------------------- bake (workers; main-thread fallback runs the same kernel)
  _bakeAsync() {
    const N = TEX, R = this._R;
    const out = { hgt: new Float32Array(N * N), nrm: new Uint8Array(N * N * 4), layers: new Uint8Array(LAYERS * R * R * 4), R };
    const merge = (r) => { out.hgt.set(r.hgt, r.y0 * N); out.nrm.set(r.nrm, r.y0 * N * 4); for (const L of r.layers) out.layers.set(L.data, L.l * R * R * 4); };
    const fallback = (e) => { console.warn('[terrain] worker bake unavailable, baking on the main thread', e?.message ?? e); merge(bakeKernel({ seed: this.seed, w: 0, W: 1, R })); return out; };
    try {
      const W = Math.min(6, Math.max(2, navigator.hardwareConcurrency || 4));
      // the worker is built from this module's own function sources, so it always bakes exactly what heightAt() says
      const src = [
        `const clamp=${clamp};const smoothstep=${smoothstep};const lerp=(a,b,t)=>a+(b-a)*t;const fade=(t)=>t*t*t*(t*(t*6-15)+10);`,
        mulberry32.toString(), hash2.toString(), noise2.toString(),
        `const ss=smoothstep,mix=lerp,n2=noise2;const fbm2=${fbm2};const fbm3=${fbm3};const fbm4=${fbm4};const rg=${rg};const ridged3=${ridged3};const ridged4=${ridged4};const rmf=${rmf};`,
        `const T={seed:0,heightAt:function ${Terrain.prototype.heightAt}};`,
        layerTex.toString(), bakeKernel.toString(),
        `self.onmessage=(e)=>{const r=bakeKernel(e.data);postMessage(r,[r.hgt.buffer,r.nrm.buffer,...r.layers.map((x)=>x.data.buffer)]);};`,
      ].join('\n');
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const jobs = [];
      for (let w = 0; w < W; w++) jobs.push(new Promise((res, rej) => {
        const wk = new Worker(url);
        wk.onmessage = (e) => { merge(e.data); wk.terminate(); res(); };
        wk.onerror = (e) => { wk.terminate(); rej(e); };
        wk.postMessage({ seed: this.seed, w, W, R });
      }));
      return Promise.all(jobs).then(() => { URL.revokeObjectURL(url); return out; }, fallback);
    } catch (e) { return Promise.resolve(fallback(e)); }
  }

  // ---------------------------------------------------------------- init
  async init() {
    const { renderer, scene, camera } = this.game;
    const q = renderer.qualityPreset;
    const n = { low: 128, medium: 160, high: 192, ultra: 256 }[this.game.quality] ?? 192;  // cells per level (multiple of 4)
    const E = n / 2, H = E / 2 - 1;
    const L = Math.ceil(Math.log2(1024 / E)) + 1;                       // levels until the coarsest covers the whole world
    const t0 = performance.now();
    const R = this._R;

    // --- textures (data arrays are filled by the workers; uploaded staggered once they are done) ---
    const heightTex = new THREE.DataTexture(null, TEX, TEX, THREE.RedFormat, THREE.FloatType);
    heightTex.minFilter = heightTex.magFilter = THREE.NearestFilter; heightTex.generateMipmaps = false;
    const normalTex = new THREE.DataTexture(null, TEX, TEX, THREE.RGBAFormat, THREE.UnsignedByteType);
    normalTex.minFilter = THREE.LinearMipmapLinearFilter; normalTex.magFilter = THREE.LinearFilter; normalTex.generateMipmaps = true; normalTex.anisotropy = q.anisotropy;
    const layerArr = new THREE.DataArrayTexture(null, R, R, LAYERS);
    layerArr.format = THREE.RGBAFormat; layerArr.type = THREE.UnsignedByteType; layerArr.colorSpace = THREE.SRGBColorSpace;
    layerArr.minFilter = THREE.LinearMipmapLinearFilter; layerArr.magFilter = THREE.LinearFilter; layerArr.generateMipmaps = true;
    layerArr.wrapS = layerArr.wrapT = THREE.RepeatWrapping; layerArr.anisotropy = q.anisotropy;

    // --- instant preview bake (main thread, ~0.2 s): terrain exists on the first frame; workers replace it when they land ---
    const hgtQ = new Float32Array(TEX * TEX);
    {
      const C = 257, st = 4, cq = new Float32Array(C * C);                 // 4 m analytic grid -> bilinear 1 m upsample
      for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) cq[j * C + i] = this.heightAt(i * st - 512, j * st - 512);
      for (let j = 0; j < TEX; j++) {
        const j0 = j >> 2, fj = (j & 3) / 4, r0 = j0 * C, r1 = Math.min(j0 + 1, C - 1) * C;
        for (let i = 0; i < TEX; i++) {
          const i0 = i >> 2, fi = (i & 3) / 4, i1 = Math.min(i0 + 1, C - 1);
          const a = cq[r0 + i0], b = cq[r0 + i1], c = cq[r1 + i0], d = cq[r1 + i1];
          hgtQ[j * TEX + i] = a + (b - a) * fi + (c - a + (a - b + d - c) * fi) * fj;
        }
      }
      heightTex.image.data = hgtQ; heightTex.needsUpdate = true;
    }
    const RQ = 512, nrmQdata = new Uint8Array(RQ * RQ * 4);                // preview normals from the preview height (AO = 1)
    {
      const Hs = (i, j) => hgtQ[Math.min(TEX - 1, Math.max(0, j)) * TEX + Math.min(TEX - 1, Math.max(0, i))];
      for (let j = 0, k = 0; j < RQ; j++) for (let i = 0; i < RQ; i++, k += 4) {
        const I = 2 * i, J = 2 * j, dx = Hs(I + 2, J) - Hs(I - 2, J), dz = Hs(I, J + 2) - Hs(I, J - 2);
        const il = 1 / Math.sqrt(dx * dx * 0.0625 + 1 + dz * dz * 0.0625);
        nrmQdata[k] = (-dx * 0.25 * il * 0.5 + 0.5) * 255; nrmQdata[k + 1] = (-dz * 0.25 * il * 0.5 + 0.5) * 255; nrmQdata[k + 2] = 255; nrmQdata[k + 3] = 255;
      }
    }
    const nrmQ = new THREE.DataTexture(nrmQdata, RQ, RQ, THREE.RGBAFormat, THREE.UnsignedByteType);
    nrmQ.minFilter = THREE.LinearMipmapLinearFilter; nrmQ.magFilter = THREE.LinearFilter; nrmQ.generateMipmaps = true; nrmQ.anisotropy = q.anisotropy; nrmQ.needsUpdate = true;
    const LQ = 64, layQdata = new Uint8Array(LAYERS * LQ * LQ * 4);        // preview layers: tiny but correct colors (sharp ones swap in later)
    for (let l = 0; l < LAYERS; l++) layQdata.set(layerTex(l, LQ, this.seed), l * LQ * LQ * 4);
    const layQ = new THREE.DataArrayTexture(layQdata, LQ, LQ, LAYERS);
    layQ.format = THREE.RGBAFormat; layQ.type = THREE.UnsignedByteType; layQ.colorSpace = THREE.SRGBColorSpace;
    layQ.minFilter = THREE.LinearMipmapLinearFilter; layQ.magFilter = THREE.LinearFilter; layQ.generateMipmaps = true;
    layQ.wrapS = layQ.wrapT = THREE.RepeatWrapping; layQ.anisotropy = q.anisotropy; layQ.needsUpdate = true;

    // --- shared uniforms + material ---
    this._uCenter = { value: new THREE.Vector2() };
    const uniforms = { uHeight: { value: heightTex }, uNormal: { value: nrmQ }, uLayers: { value: layQ }, uCenter: this._uCenter, uMorph: { value: new THREE.Vector2(E - 5 - Math.max(12, Math.round(E * 0.2)), E - 5) }, uWater: { value: WL }, uTime: { value: 0 } };
    this._uniforms = uniforms;
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, dithering: true });
    const inject = (shader) => { Object.assign(shader.uniforms, uniforms); patchVertex(shader); patchFragment(shader); };
    // chainable onBeforeCompile: if another system (e.g. CSM.setupMaterial) assigns its own, ours still runs first.
    let chained = null;
    Object.defineProperty(mat, 'onBeforeCompile', { configurable: true, get: () => (shader, r) => { inject(shader); chained?.(shader, r); }, set: (fn) => { chained = fn; } });
    mat.customProgramCacheKey = () => 'terrain' + (chained ? chained.toString().length : 0);
    const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depthMat.onBeforeCompile = (shader) => { Object.assign(shader.uniforms, uniforms); patchVertex(shader); };
    depthMat.customProgramCacheKey = () => 'terrain-depth';
    this.material = mat;

    // --- clipmap geometry: one shared flat grid in cell units; level 0 = full grid, others = ring with a 2H hole ---
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    for (let j = 0, k = 0; j <= n; j++) for (let i = 0; i <= n; i++, k += 3) { pos[k] = i - E; pos[k + 2] = j - E; }
    const posAttr = new THREE.BufferAttribute(pos, 3);
    const mkGeo = (hole) => {
      const idx = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const ci = i - E, cj = j - E;
        if (hole && ci >= -H && ci < H && cj >= -H && cj < H) continue;
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;     // a=(i,j) b=(i+1,j) c=(i+1,j+1) d=(i,j+1)
        idx.push(a, c, b, a, d, c);                                              // diagonal a-c = (1,1): coarse centers lie on it
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', posAttr);
      g.setIndex(new THREE.BufferAttribute((n + 1) * (n + 1) > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);  // never culled (displaced in the shader)
      return g;
    };
    const geoFull = mkGeo(false), geoRing = mkGeo(true);

    this.mesh = new THREE.Group(); this.mesh.name = 'terrain'; this.mesh.material = mat; this.mesh.receiveShadow = true;
    this.meshes = []; this.levels = L;
    for (let l = 0; l < L; l++) {
      const m = new THREE.Mesh(l === 0 ? geoFull : geoRing, mat);
      const s = 1 << l;
      // castShadow only within shadowDistance reach (levels 0-2 span +-384 m): outer rings in every cascade were ~1 M wasted tris
      m.scale.set(s, 1, s); m.frustumCulled = false; m.receiveShadow = true; m.castShadow = l < 3;
      m.customDepthMaterial = depthMat; m.renderOrder = l; m.name = 'terrain-l' + l;
      this.meshes.push(m); this.mesh.add(m);
    }
    this.ready = true;                         // preview bake means there is always ground, from the very first frame
    scene.add(this.mesh);
    this.update(0, 0);
    // start translating/linking the terrain program now (driver threads) so the first frame doesn't pay for it
    renderer.compileAsync(this.mesh, camera, scene).catch(() => {});
    const t1 = performance.now();
    console.log(`[terrain] preview ready in ${(t1 - t0).toFixed(0)} ms, ${L} levels x ${n} cells`);
    // real asset albedos (ASSETS.md): fetched + resized in parallel with the worker bake, merged over the procedural
    // layers when both land (procedural stays the fallback + its height supplies the macro shading / blend alpha source)
    const ASSET_LAYERS = [[0, 'grass_albedo', 1.00], [3, 'cliff_strata', 1.20], [4, 'beach_sand', 0.80], [5, 'snow', 0.84]];  // [layer, file, sRGB gain]
    const imgP = Promise.all(ASSET_LAYERS.map(([l, nm, mul]) =>
      fetch(`/assets/tex/${nm}.jpg`).then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
        .then((bl) => createImageBitmap(bl, { resizeWidth: R, resizeHeight: R, resizeQuality: 'high' }))
        .then((bm) => { const cv = new OffscreenCanvas(R, R), cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bm, 0, 0, R, R); bm.close(); return { l, mul, data: cx.getImageData(0, 0, R, R).data }; })
        .catch((e) => { console.warn(`[terrain] asset ${nm} unavailable (${e?.message ?? e}), procedural fallback`); return null; })));
    Promise.all([this._baked, imgP]).then(([b, imgs]) => {
      this._hgt = b.hgt;                       // exact 1 m height field (Water reuses it if it rebakes)
      let err = 0; for (let k = 0; k < 64; k++) { const i = (k * 97 + 5) % TEX, j = (k * 389 + 11) % TEX; err = Math.max(err, Math.abs(b.hgt[j * TEX + i] - this.heightAt(i - 512, j - 512))); }
      console.log(`[terrain] full bake done ${(performance.now() - t0).toFixed(0)} ms after init (${err > 1e-4 ? 'MISMATCH ' + err : 'exact'}), layers ${R}, assets ${imgs.filter(Boolean).length}/${ASSET_LAYERS.length}; staggering uploads`);
      // STAGGERED upload: one item per frame so the bake landing never hitches (was a ~1.1 s single-frame stall).
      const step = (label, fn) => () => { const s0 = performance.now(); fn(); const ms = performance.now() - s0; if (ms > 4) console.log(`[terrain] upload ${label} ${ms.toFixed(0)} ms`); };
      const mergeLayer = ({ l, mul, data }) => {          // photo albedo x procedural macro shading; alpha = luma (blend sharpening follows visible detail)
        const off = l * R * R * 4, L = b.layers;
        for (let k = 0; k < R * R * 4; k += 4) {
          const sh = mul * (0.90 + 0.20 * (L[off + k + 3] / 255));
          const r = data[k] * sh, g = data[k + 1] * sh, bb = data[k + 2] * sh;
          L[off + k] = r > 255 ? 255 : r; L[off + k + 1] = g > 255 ? 255 : g; L[off + k + 2] = bb > 255 ? 255 : bb;
          L[off + k + 3] = data[k] * 0.35 + data[k + 1] * 0.5 + data[k + 2] * 0.15;
        }
      };
      const jobs = [
        step('height', () => { heightTex.image.data = b.hgt; heightTex.needsUpdate = true; renderer.initTexture(heightTex); }),
        step('normal', () => { normalTex.image.data = b.nrm; normalTex.needsUpdate = true; renderer.initTexture(normalTex); this._uniforms.uNormal.value = normalTex; nrmQ.dispose(); }),
      ];
      for (const im of imgs) if (im) jobs.push(step('asset ' + im.l, () => mergeLayer(im)));
      layerArr.image.data = b.layers;
      if (typeof layerArr.addLayerUpdate === 'function') {
        for (let l = 0; l < LAYERS; l++) jobs.push(step('layer ' + l, () => { layerArr.addLayerUpdate(l); layerArr.needsUpdate = true; renderer.initTexture(layerArr); }));
      } else {
        jobs.push(step('layers', () => { layerArr.needsUpdate = true; renderer.initTexture(layerArr); }));   // ponytail: old three fallback, whole-array upload in one frame
      }
      jobs.push(step('swap', () => { this._uniforms.uLayers.value = layerArr; layQ.dispose(); }));
      this._pending = jobs;
    });
  }

  update(dt, t) {
    if (this._pending && this._pending.length) this._pending.shift()();   // staggered bake upload: one texture/layer per frame
    const c = this.game.camera.position;
    for (let l = 0; l < this.levels; l++) {
      const g = 2 << l;                                                 // snap to 2*spacing so this level's vertices coincide with the coarser one's
      this.meshes[l].position.set(Math.floor(c.x / g + 0.5) * g, 0, Math.floor(c.z / g + 0.5) * g);
    }
    this._uCenter.value.set(c.x, c.z);
    this._uniforms.uTime.value = t;
  }
}

// ======================================================================= bake kernels (run in workers; stringified, so keep them closure-free)
// One job = a band of height rows (+6 row halo) -> heights + normal/AO, plus every LAYERS-th layer texture.
function bakeKernel(job) {
  const { seed, w, W, R } = job; const N = 1024;
  T.seed = seed;
  const y0 = Math.floor(w * N / W), y1 = Math.floor((w + 1) * N / W), h0 = Math.max(0, y0 - 6), h1 = Math.min(N, y1 + 6);
  const band = new Float32Array((h1 - h0) * N);
  for (let j = h0, k = 0; j < h1; j++) { const z = j - N / 2; for (let i = 0; i < N; i++) band[k++] = T.heightAt(i - N / 2, z); }
  const hgt = band.slice((y0 - h0) * N, (y1 - h0) * N);
  const Hf = (i, j) => band[(Math.min(h1 - 1, Math.max(h0, j)) - h0) * N + Math.min(N - 1, Math.max(0, i))];
  const nrm = new Uint8Array((y1 - y0) * N * 4);
  for (let j = y0, k = 0; j < y1; j++) for (let i = 0; i < N; i++, k += 4) {
    const c = Hf(i, j), dx = Hf(i + 1, j) - Hf(i - 1, j), dz = Hf(i, j + 1) - Hf(i, j - 1);
    const il = 1 / Math.sqrt(dx * dx * 0.25 + 1 + dz * dz * 0.25);
    // cavity AO: height relative to the 2 m / 6 m neighbourhood mean (valleys darker, ridges open)
    const m2 = (Hf(i + 2, j) + Hf(i - 2, j) + Hf(i, j + 2) + Hf(i, j - 2)) * 0.25, m6 = (Hf(i + 6, j) + Hf(i - 6, j) + Hf(i, j + 6) + Hf(i, j - 6)) * 0.25;
    const ao = Math.min(1, Math.max(0.55, 1 + (c - m2) * 0.35 + (c - m6) * 0.08));
    nrm[k] = (-dx * 0.5 * il * 0.5 + 0.5) * 255; nrm[k + 1] = (-dz * 0.5 * il * 0.5 + 0.5) * 255; nrm[k + 2] = ao * 255; nrm[k + 3] = 255;
  }
  const layers = [];
  for (let l = w; l < 8; l += W) layers.push({ l, data: layerTex(l, R, seed) });
  return { hgt, nrm, layers, y0 };
}

// Tiling layer textures (period 1 in uv). RGB = linear albedo stored sRGB-encoded (the array is SRGB8_ALPHA8), A = height
// for blend sharpening. Layer 7 = detail: RG normal xz, B bump height, A low-frequency macro noise.
function layerTex(layer, R, seed) {
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }, mix = (a, b, t) => a + (b - a) * t;
  const pm = (x, p) => x - Math.floor(x / p) * p;
  // seeded permutation-table hash (fast), wrapped to the lattice period -> every layer tiles
  const P = new Uint8Array(512);
  { const rnd = mulberry32((seed * 7919) | 0); for (let i = 0; i < 256; i++) P[i] = i; for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0, t = P[i]; P[i] = P[j]; P[j] = t; } for (let i = 0; i < 256; i++) P[256 + i] = P[i]; }
  const hash = (x, y, per) => P[(P[pm(x, per) & 255] + pm(y, per)) & 255] * (1 / 255);
  const hashB = (x, y, per) => P[(P[(pm(x, per) + 37) & 255] + pm(y, per) + 91) & 255] * (1 / 255);
  const vnoise = (u, v, f) => {
    const px = u * f, py = v * f, ix = Math.floor(px), iy = Math.floor(py); let fx = px - ix, fy = py - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, f), b = hash(ix + 1, iy, f), c = hash(ix, iy + 1, f), d = hash(ix + 1, iy + 1, f);
    return mix(mix(a, b, fx), mix(c, d, fx), fy);
  };
  const fbm = (u, v, f, oct) => { let s = 0, a = 0.5, n = 0; for (let i = 0; i < oct; i++) { s += a * vnoise(u + i * 0.173, v + i * 0.173, f); n += a; a *= 0.5; f *= 2; } return s / n; };
  const ridge = (u, v, f, oct) => { let s = 0, a = 0.5, n = 0; for (let i = 0; i < oct; i++) { const q = 1 - Math.abs(vnoise(u + i * 0.31, v + i * 0.31, f) * 2 - 1); s += a * q * q; n += a; a *= 0.5; f *= 2; } return s / n; };
  let wd = 0, wid = 0;                                                          // worley: distance to nearest feature (cell units), feature id
  const worley = (u, v, fx, fy) => {                                            // anisotropic freq => elongated cells (leaf shapes)
    const px = u * fx, py = v * fy, ix = Math.floor(px), iy = Math.floor(py), fxx = px - ix, fyy = py - iy; wd = 8; wid = 0;
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      const wx = pm(ix + x, fx), wy = pm(iy + y, fy);
      const dx = x + hash(wx, wy, 256) - fxx, dy = y + hashB(wx, wy, 256) - fyy; const d = Math.sqrt(dx * dx + dy * dy);
      if (d < wd) { wd = d; wid = hashB(wx + 3, wy + 5, 256); }
    }
  };
  // leaf litter palette: mostly russet/brown, occasional fresh yellow-green
  const leafC = (w) => w > 0.86 ? [0.30, 0.25, 0.05] : [mix(0.19, 0.40, pm(w * 7.3, 1)), mix(0.095, 0.185, pm(w * 5.1, 1)), mix(0.028, 0.06, pm(w * 3.7, 1))];
  let bumpH = null;                                                             // detail layer: bump height field, normals from its finite differences
  if (layer === 7) { bumpH = new Float32Array(R * R); for (let j = 0, k = 0; j < R; j++) for (let i = 0; i < R; i++) bumpH[k++] = fbm((i + 0.5) / R, (j + 0.5) / R, 9, 5); }
  const enc = (c) => { c = c < 0 ? 0 : c > 1 ? 1 : c; return (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255 + 0.5; };
  const out = new Uint8Array(R * R * 4);
  for (let j = 0, k = 0; j < R; j++) for (let i = 0; i < R; i++, k += 4) {
    const u = (i + 0.5) / R, v = (j + 0.5) / R;
    let r, g, b, h;
    if (layer === 0) {            // grass: clumpy, blade streaks, dry highlights
      const n1 = fbm(u, v, 6, 5), n3 = fbm(u + 0.5, v + 0.5, 3, 3);
      const st = fbm(u + 3.1, v * 5 + 3.1, 8, 3), st2 = fbm(u * 5 + 1.7, v + 1.7, 8, 3);
      const streak = mix(st, st2, ss(0.4, 0.6, n3)), hi = ss(0.55, 0.85, streak) * 0.7, dry = ss(0.62, 0.8, n3) * 0.4, sp = ss(0.75, 0.95, vnoise(u + 1.3, v + 1.3, 128)) * 0.07;
      r = mix(mix(mix(0.09, 0.17, n1), 0.38, hi), 0.30, dry) + sp; g = mix(mix(mix(0.20, 0.33, n1), 0.44, hi), 0.36, dry) + sp; b = mix(mix(mix(0.05, 0.07, n1), 0.13, hi), 0.09, dry) + sp;
      h = n1 * 0.5 + streak * 0.5;
    } else if (layer === 1) {     // forest floor: humus + two passes of crisp elongated leaf litter + moss + twig grit
      const n1 = fbm(u, v, 5, 5);
      r = mix(0.085, 0.165, n1); g = mix(0.060, 0.115, n1); b = mix(0.035, 0.065, n1);       // humus base
      worley(u + 0.37, v + 0.61, 40, 64);                                                    // under pass: vertical-ish leaves
      let lh2 = 0, l1 = 0;
      if (wid > 0.30) { const c = leafC(wid); lh2 = ss(0.44, 0.36, wd) * 0.8; r = mix(r, c[0] * 0.72, lh2); g = mix(g, c[1] * 0.72, lh2); b = mix(b, c[2] * 0.72, lh2); }
      worley(u, v, 64, 40);                                                                  // over pass: horizontal-ish leaves, sharp edge
      if (wid > 0.34) { const c = leafC(wid); l1 = ss(0.40, 0.33, wd); r = mix(r, c[0], l1); g = mix(g, c[1], l1); b = mix(b, c[2], l1); }
      const moss = ss(0.55, 0.75, fbm(u + 2, v + 2, 4, 3)) * 0.7 * (1 - l1);
      const grit = (vnoise(u, v, 512) - 0.5) * 0.07;
      r = mix(r, 0.10, moss) + grit; g = mix(g, 0.23, moss) + grit; b = mix(b, 0.065, moss) + grit * 0.6;
      h = n1 * 0.4 + Math.max(l1, lh2 * 0.7) * 0.6 + moss * 0.25;
    } else if (layer === 2) {     // dirt: packed earth, sparse crisp pebbles, fine grit, cracks
      const n1 = fbm(u, v, 6, 5); worley(u, v, 34, 34);
      const peb = ss(0.30, 0.22, wd) * ss(0.4, 0.55, wid), crack = 1 - ss(0.90, 1.0, ridge(u, v, 7, 3)) * 0.45;
      const grit = (vnoise(u, v, 512) - 0.5) * 0.09;
      r = (mix(mix(0.20, 0.33, n1), mix(0.37, 0.26, wid), peb) + grit) * crack; g = (mix(mix(0.145, 0.255, n1), mix(0.33, 0.23, wid), peb) + grit) * crack; b = (mix(mix(0.10, 0.18, n1), mix(0.28, 0.20, wid), peb) + grit * 0.7) * crack;
      h = n1 * 0.5 + peb * 0.5 - (1 - crack) * 0.6;
    } else if (layer === 3) {     // rock: warm grey-tan, wide value range (contrast must survive distance); subdued internal bands
      const n1 = fbm(u, v, 5, 5), n2r = fbm(u + 3, v + 3, 11, 4), warp = fbm(u + 4, v + 4, 4, 3);
      const bands = ss(-0.45, 0.45, Math.sin((v + warp * 0.07) * 6.2832 * 9 + n1 * 1.6)), bb = 0.87 + 0.15 * bands;
      const vein = ss(0.62, 0.82, fbm(u * 3 + 9, v + 9, 4, 3)) * 0.5, crack = 1 - ss(0.88, 1.0, ridge(u + 1, v + 1, 6, 4)) * 0.6, gr = (vnoise(u, v, 256) - 0.5) * 0.09;
      const base = mix(0.16, 0.40, n1) * (0.80 + 0.40 * n2r);
      r = mix(base * 1.06, 0.42, vein) * bb * crack + gr; g = mix(base * 0.97, 0.33, vein) * bb * crack + gr; b = mix(base * 0.88, 0.22, vein) * bb * crack + gr;
      h = bands * 0.35 + n1 * 0.65 - (1 - crack) * 0.7;
    } else if (layer === 4) {     // sand: warm, darker (was a blinding pool-deck), hue patches, LOW-contrast crossing ripples
      const n1 = fbm(u, v, 8, 4), hue = fbm(u + 9, v + 9, 2, 3);
      const rip = Math.sin((u + fbm(u, v, 3, 2) * 0.2 + v * 0.35) * 6.2832 * 21) * 0.6 + Math.sin((v - u * 0.3 + fbm(u + 5, v + 5, 3, 2) * 0.15) * 6.2832 * 9) * 0.4;
      const rb = 0.96 + 0.04 * rip;
      const gr = (vnoise(u, v, 256) - 0.5) * 0.10 + (vnoise(u + 0.3, v + 0.3, 512) - 0.5) * 0.06;
      r = mix(0.38, 0.55, n1) * mix(0.94, 1.10, hue) * rb + gr; g = mix(0.30, 0.45, n1) * mix(0.90, 1.05, hue) * rb + gr; b = mix(0.19, 0.30, n1) * mix(0.98, 1.02, hue) * rb + gr;
      h = 0.5 + rip * 0.25 + (n1 - 0.5) * 0.5;
    } else if (layer === 5) {     // snow: wind-packed drifts, cool blue shading, sparse sparkle (kept < 1.0 so ACES+bloom won't blow out)
      const n1 = fbm(u, v, 4, 4), n2s = fbm(u + 0.5, v + 0.5, 12, 3), sp = vnoise(u, v, 512) > 0.988 ? 0.14 : 0;
      const base = mix(0.50, 0.68, n1) + (n2s - 0.5) * 0.10;
      r = base * 0.90 + sp; g = base * 0.96 + sp; b = base * 1.10 + sp;
      h = n1;
    } else if (layer === 6) {     // worn flagstones (ruins / arena floor), running-bond row offsets
      const T = 7, py = v * T, idy = Math.floor(py);
      const px = u * T + (hash(idy, 3, T) > 0.5 ? 0.5 : 0), idx = Math.floor(px), fx = px - idx, fy = py - idy;
      const hv = hash(idx, idy, T), hv2 = hashB(idx, idy, T);
      const m = Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy));
      // tight mortar line (was a cavernous gully), brighter warm sandstone, crisp fine grain, moss only as a faint tint
      const mortar = ss(0.016, 0.006, m + (fbm(u, v, 40, 2) - 0.5) * 0.012), n1 = fbm(u + hv, v + hv, 8, 4), sh = 0.90 + 0.22 * n1;
      const mossy = hv2 > 0.9 ? 0.07 : 0, crack = 1 - ss(0.93, 1.0, ridge(u + hv2, v + hv2, 9, 3)) * 0.3;
      const grit = (vnoise(u + 0.7, v + 0.7, 512) - 0.5) * 0.075 + (vnoise(u + 0.2, v + 0.4, 200) - 0.5) * 0.055;  // crisp masonry grain that survives mips
      r = mix(mix(mix(0.54, 0.70, hv) * sh, 0.50, mossy) * crack + grit, 0.42, mortar); g = mix(mix(mix(0.50, 0.65, hv) * sh, 0.52, mossy) * crack + grit, 0.39, mortar); b = mix(mix(mix(0.44, 0.57, hv) * sh, 0.42, mossy) * crack + grit * 0.8, 0.33, mortar);
      h = 1 - mortar * 0.35 - (1 - crack) * 0.35;
    } else {                      // detail: bump normal (rg), bump height (b), macro noise (a)
      const c = bumpH[j * R + i], k2 = R * 0.03 * 0.5;                           // slope per uv * 0.03 (same strength at any R)
      const dx = (bumpH[j * R + ((i + 1) % R)] - bumpH[j * R + ((i + R - 1) % R)]) * k2, dy = (bumpH[((j + 1) % R) * R + i] - bumpH[((j + R - 1) % R) * R + i]) * k2;
      const il = 1 / Math.sqrt(dx * dx + 1 + dy * dy);
      r = -dx * il * 0.5 + 0.5; g = -dy * il * 0.5 + 0.5; b = c; h = fbm(u + 7.7, v + 7.7, 2, 3);   // alpha: LOW-freq macro (patches ~1/6 tile scale)
    }
    out[k] = enc(r); out[k + 1] = enc(g); out[k + 2] = enc(b); out[k + 3] = (h < 0 ? 0 : h > 1 ? 1 : h) * 255;
  }
  return out;
}
const T = { seed: 0, heightAt: Terrain.prototype.heightAt };               // main-thread twin of the worker's T (fallback path)

// ======================================================================= shaders
const VERT_PARS = /* glsl */`
uniform highp sampler2D uHeight;
uniform highp sampler2D uNormal;
uniform vec2 uCenter;
uniform vec2 uMorph;
varying vec3 vWPos;
// Out-of-world skirt. The 1024 m bake stops at +-512; past it the clipmap used to add
// (Chebyshev distance x 0.3) with the baked EDGE normal clamped flat across the whole thing: a smooth,
// unlit four-sided cone that stood over the ring crest as a white bank -- what the "mountains look like
// elongated slopes, not jaggy mountains" screenshots are actually showing. It is replaced by a ridged
// 2-octave value noise (222 m / 87 m features) so the land beyond the ring reads as a far hazed massif,
// and terrainN below finite-differences it so the thing is lit like ground instead of a paper sheet.
// Angular-only modulation is NOT enough here: constant-in-radius ridges run dead radial and converge into
// exactly the fan of creases we are removing.
float skHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float skNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(skHash(i), skHash(i + vec2(1.0, 0.0)), f.x),
             mix(skHash(i + vec2(0.0, 1.0)), skHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float terrainH(vec2 w) {
  vec2 c = floor(w + 0.5);
  vec2 cc = clamp(c, -512.0, 511.0);
  float h = texelFetch(uHeight, ivec2(cc + 512.0), 0).r;
  float o = max(0.0, max(abs(c.x), abs(c.y)) - 511.0);
  if (o <= 0.0) return h;
  float r1 = 1.0 - abs(skNoise(w * 0.0045) * 2.0 - 1.0);
  float r2 = 1.0 - abs(skNoise(w * 0.0115 + 7.3) * 2.0 - 1.0);
  return h + o * (0.05 + 0.30 * (r1 * r1 * 0.8 + r2 * r2 * 0.2));   // tuned so the far range tops out just UNDER the ring crest
}
vec3 terrainN(vec2 w) {
  vec4 t = textureLod(uNormal, (w + 512.5) / 1024.0, 0.0);
  vec3 n = vec3(t.r * 2.0 - 1.0, 0.0, t.g * 2.0 - 1.0);
  n.y = sqrt(max(0.0, 1.0 - dot(n.xz, n.xz)));
  float o = max(abs(w.x), abs(w.y)) - 511.0;
  if (o > 0.0) {   // real slope for the skirt; the clamped edge normal lit it as one flat sheet
    const float e = 12.0;
    float hx = terrainH(w + vec2(e, 0.0)) - terrainH(w - vec2(e, 0.0));
    float hz = terrainH(w + vec2(0.0, e)) - terrainH(w - vec2(0.0, e));
    n = normalize(mix(n, normalize(vec3(-hx, 2.0 * e, -hz)), clamp(o / 30.0, 0.0, 1.0)));
  }
  return n;
}`;
// clipmap displacement: world xz from the model matrix (position = snapped origin, scale = spacing); morph odd vertices
// toward the average of their coarse-level neighbours as they approach the ring edge (continuous in camera distance).
const VERT_BEGIN = /* glsl */`
vec3 transformed = vec3( position );
{
  vec2 wxz = (modelMatrix * vec4(position.x, 0.0, position.z, 1.0)).xz;
  float sp = modelMatrix[0][0];
  vec2 par = mod(position.xz, 2.0) * sp;          // 1 for odd cells -> offset to the coarse neighbours
  float h = terrainH(wxz);
  float hc = 0.5 * (terrainH(wxz - par) + terrainH(wxz + par));
  float m = smoothstep(uMorph.x * sp, uMorph.y * sp, max(abs(wxz.x - uCenter.x), abs(wxz.y - uCenter.y)));
  transformed.y = mix(h, hc, m);
  vWPos = vec3(wxz.x, transformed.y, wxz.y);
}`;
const VERT_NORMAL = /* glsl */`
vec3 objectNormal = terrainN((modelMatrix * vec4(position.x, 0.0, position.z, 1.0)).xz);`;

function patchVertex(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_PARS)
    .replace('#include <beginnormal_vertex>', VERT_NORMAL)
    .replace('#include <begin_vertex>', VERT_BEGIN);
}

const FRAG_PARS = /* glsl */`
uniform highp sampler2D uNormal;
uniform highp sampler2DArray uLayers;
uniform float uWater;
uniform float uTime;
varying vec3 vWPos;
vec4 lyr(vec2 uv, float i) { return texture(uLayers, vec3(uv, i)); }
// hex-tile stochastic sampling (technique: three-hex-tiling / Mikkelsen hextile, MIT) — random per-hex offsets kill visible repeats
vec2 hexH(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
vec4 lyrHex(vec2 uv, float i, float sharp) {
  const mat2 sk = mat2(1.0, 0.0, -0.57735027, 1.15470054);
  vec2 t = sk * (uv * 0.35); vec2 b = floor(t); vec3 w = vec3(fract(t), 0.0); w.z = 1.0 - w.x - w.y;
  vec2 v1, v2, v3;
  if (w.z > 0.0) { w = vec3(w.z, w.y, w.x); v1 = b; v2 = b + vec2(0.0, 1.0); v3 = b + vec2(1.0, 0.0); }
  else { w = vec3(-w.z, 1.0 - w.y, 1.0 - w.x); v1 = b + 1.0; v2 = b + vec2(1.0, 0.0); v3 = b + vec2(0.0, 1.0); }
  w = pow(w, vec3(sharp)); w /= (w.x + w.y + w.z);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  return textureGrad(uLayers, vec3(uv + hexH(v1), i), dx, dy) * w.x
       + textureGrad(uLayers, vec3(uv + hexH(v2), i), dx, dy) * w.y
       + textureGrad(uLayers, vec3(uv + hexH(v3), i), dx, dy) * w.z;
}`;

// splat: computed where <map_fragment> would sample the albedo; leaves tN (world normal), tRough, tAO, tEmis for later chunks
const FRAG_SPLAT = /* glsl */`
vec3 tN; float tRough; float tAO; vec3 tEmis = vec3(0.0);
{
  vec3 P = vWPos;
  vec4 nt = texture(uNormal, (P.xz + 512.5) / 1024.0);
  vec3 gN = vec3(nt.r * 2.0 - 1.0, 0.0, nt.g * 2.0 - 1.0); gN.y = sqrt(max(0.0, 1.0 - dot(gN.xz, gN.xz)));
  tAO = nt.b;
  float slope = 1.0 - gN.y;
  float camD = length(vViewPosition);
  float far = smoothstep(110.0, 420.0, camD);        // fades only the FINE detail/strata (grazing-angle moire); coarse contrast stays
  // macro variation (low-frequency noise, breaks tiling + drives patches), detail bump (close-up)
  float macro = lyr(P.xz * (1.0 / 143.0), 7.0).a;
  float macro2 = lyr(P.xz * (1.0 / 61.0) + 0.37, 7.0).a;
  // fbm output clusters around 0.5 -> raw macro only swung the far albedo by +-16% (the "two-tone poster" aerial).
  // Expanded copies drive every far-field variation; the raw ones stay for blend dithering (needs to be gentle).
  float macroC = smoothstep(0.33, 0.67, macro);
  float macro2C = smoothstep(0.35, 0.65, macro2);
  vec4 det = lyr(P.xz * (1.0 / 0.9), 7.0);
  vec4 det2 = lyr(P.xz * (1.0 / 4.3) + 0.5, 7.0);
  vec4 det0 = lyr(P.xz * (1.0 / 0.23), 7.0);
  float detFade = 1.0 - smoothstep(18.0, 80.0, camD);
  float nearF = 1.0 - smoothstep(2.0, 10.0, camD);   // crisp micro octave right underfoot
  vec3 bump = vec3(det.r * 2.0 - 1.0, 0.0, det.g * 2.0 - 1.0) * 0.8 * detFade
            + vec3(det2.r * 2.0 - 1.0, 0.0, det2.g * 2.0 - 1.0) * 0.35 * (1.0 - far)
            + vec3(det0.r * 2.0 - 1.0, 0.0, det0.g * 2.0 - 1.0) * 0.55 * nearF;
  // --- biome / region masks (analytic, same layout as Terrain.biomeAt) ---
  float lakeD = length(P.xz - vec2(-170.0, -70.0));
  float lakeM = 1.0 - smoothstep(105.0, 150.0, lakeD);
  float ruinD = length(P.xz - vec2(140.0, 60.0));
  float ruinM = 1.0 - smoothstep(50.0, 70.0, ruinD + (macro2 - 0.5) * 16.0);
  float arenaM = 1.0 - smoothstep(43.0, 49.0, length(P.xz - vec2(-60.0, 260.0)));
  float forestM = smoothstep(-150.0, -215.0, P.z + (macro - 0.5) * 40.0) * smoothstep(290.0, 245.0, abs(P.x));
  // mountain mask: grass/forest only live on genuinely low ground (kills the green terrace stripes on cliff ledges)
  float mtn = max(smoothstep(26.0, 40.0, P.y + (macro - 0.5) * 10.0), smoothstep(340.0, 400.0, length(P.xz) + (macro - 0.5) * 70.0));
  float crystalM = smoothstep(195.0, 260.0, P.x + (macro - 0.5) * 40.0) * (1.0 - mtn);
  float alt = smoothstep(26.0, 58.0, P.y);           // mountain altitude: rock takes over sooner, dirt turns to scree
  // --- layer weights ("over" compositing, then height-sharpened) ---
  float snowN = lyr(P.xz * (1.0 / 23.0) + 0.77, 7.0).a;                 // mid-scale breakup: no polygon-edged snow sheets
  float snowN2 = lyr(P.xz * (1.0 / 6.5) + 0.29, 7.0).a;                 // drift-edge breakup at the snowline (kills the flat sheet border)
  // high snowline + hard slope cutoff: snow dusts benches and summits, rock faces stay rock (no chalk-white ring)
  // slope gate tightened with the steeper ring: snow settles on benches, shoulders and gully floors and
  // slides off the faces, so a cap reads as a cap. The old 0.22-0.46 gate draped every 30-degree back in
  // white, which is what turned the whole ring into one smooth bedsheet.
  float wSnow = smoothstep(100.0, 140.0, P.y + (macro - 0.5) * 28.0 + (snowN - 0.5) * 24.0 + (snowN2 - 0.5) * 8.0) * (1.0 - smoothstep(0.17, 0.42, slope + (snowN - 0.5) * 0.12));
  // never on the out-of-world skirt: it is a gentle ramp, so a height-and-slope snow test paints ALL of it
  // white, and a white sheet behind the ring is exactly the bank the mountains were being mistaken for.
  wSnow *= 1.0 - smoothstep(496.0, 528.0, max(abs(P.x), abs(P.z)));
  float skirtM = smoothstep(76.0, 58.0, ruinD) * smoothstep(38.0, 52.0, ruinD);   // Spire skirt band: broken rock, not a dirt mound
  float rockTh = mix(0.30, 0.12, max(alt, max(mtn, skirtM)));
  float rockW = 0.13 + far * 0.12;                                       // wide blend + multi-octave dither: no sawtooth boundary at the skirt base
  float wRock = smoothstep(rockTh - rockW, rockTh + rockW * 1.25, slope + (macro - 0.5) * 0.10 + (det2.b - 0.5) * 0.07 + (det.b - 0.5) * 0.06 * detFade + (det0.b - 0.5) * 0.05 * nearF);
  float beltD = length(P.xz);                                            // mountain approach belt: scree/rock patches, not a dirt ramp
  float beltM = smoothstep(238.0, 296.0, beltD) * (1.0 - smoothstep(348.0, 412.0, beltD));
  wRock = max(wRock, beltM * smoothstep(0.26, 0.60, macro2C + (det2.b - 0.5) * 0.30) * smoothstep(0.02, 0.09, slope));
  wRock = max(wRock, skirtM * smoothstep(0.10, 0.20, slope + (macro - 0.5) * 0.08));
  float wSand = lakeM * smoothstep(uWater + 1.9, uWater + 0.9, P.y + (macro2 - 0.5) * 0.9);
  float wStone = max(ruinM, arenaM);
  float wDirt = clamp(smoothstep(0.12, 0.26, slope + (macro2 - 0.5) * 0.06) + smoothstep(0.64, 0.80, macro2) * 0.7 + crystalM * 0.35 + alt * 0.5 + mtn * 0.75, 0.0, 1.0);
  float wForest = forestM * (1.0 - mtn);
  float wGrass = 1.0 - mtn;
  wGrass *= 1.0 - wForest;
  float k = 1.0 - wDirt; wGrass *= k; wForest *= k;
  k = 1.0 - wStone; wGrass *= k; wForest *= k; wDirt *= k;
  k = 1.0 - wSand; wGrass *= k; wForest *= k; wDirt *= k; wStone *= k;
  k = 1.0 - wRock; wGrass *= k; wForest *= k; wDirt *= k; wStone *= k; wSand *= k;
  k = 1.0 - wSnow; wGrass *= k; wForest *= k; wDirt *= k; wStone *= k; wSand *= k; wRock *= k;
  // --- sample layers (top projection; rock triplanar). Asset albedos live in the array; hex-tiling kills the repeat.
  float farC = smoothstep(50.0, 280.0, camD);                            // albedo macro contrast ramps in EARLY (aerial is not a paint fill)
  vec4 cG = mix(lyrHex(P.xz * (1.0 / 3.7), 0.0, 3.0), lyr(P.xz * (1.0 / 11.0) + 0.31, 0.0), 0.35);
  cG.rgb = mix(cG.rgb, lyr(P.xz * (1.0 / 43.0) + 0.61, 0.0).rgb, farC * 0.65);  // huge-scale patches: contrast survives distance
  cG.rgb *= mix(1.0, 0.55 + 0.95 * macroC, farC);                        // 143 m light/dark meadow patches from the air
  float dry = smoothstep(0.42, 0.64, macro2) * (1.0 - forestM);          // sun-dried grass patches ringing the dirt patches
  cG.rgb = mix(cG.rgb, cG.rgb * vec3(1.6, 1.25, 0.55) + vec3(0.05, 0.03, 0.0), dry * 0.6);
  vec4 cF = lyr(P.xz * (1.0 / 3.6), 1.0);
  cF.rgb = mix(cF.rgb, lyr(P.xz * (1.0 / 27.0) + 0.41, 1.0).rgb, farC * 0.5);
  vec4 cD = lyr(P.xz * (1.0 / 4.2), 2.0);
  cD.rgb = mix(cD.rgb, lyr(P.xz * (1.0 / 31.0) + 0.23, 2.0).rgb, farC * 0.55);
  cD.rgb *= mix(1.0, 0.62 + 0.80 * macroC, farC);
  vec4 cS = lyr(P.xz * (1.0 / 2.4), 4.0);
  cS.rgb *= mix(vec3(1.08, 0.99, 0.88), vec3(0.92, 0.90, 0.97), smoothstep(0.35, 0.65, macro2));   // warm/cool sand patches
  vec4 cW = lyr(P.xz * (1.0 / 9.0), 5.0);
  // flagstones: per-5m-cell whole-stone offset + 90deg rotation kills the parking-lot repeat (cell borders land on mortar)
  vec2 stC = floor(P.xz * 0.2);
  float stH = fract(sin(dot(stC, vec2(127.1, 311.7))) * 43758.545);
  vec2 stUV = P.xz * 0.2 + floor(vec2(stH, fract(stH * 7.0)) * 7.0) * (1.0 / 7.0);   // quantum = one stone (7 stones/tile)
  if (stH > 0.5) stUV = vec2(stUV.y, -stUV.x);
  vec4 cT = lyr(stUV, 6.0);
  vec4 cR = vec4(0.0);
  if (wRock > 0.002) {
    vec3 bw = pow(abs(gN), vec3(5.0)); bw /= (bw.x + bw.y + bw.z);
    float rs = 1.0 / 13.0;    // cliff_strata.jpg: real blocky strata; hex offsets shift the blocks like faults (no repeat)
    cR = lyrHex(P.zy * rs, 3.0, 8.0) * bw.x + lyrHex(P.xz * rs, 3.0, 8.0) * bw.y + lyrHex(P.xy * rs, 3.0, 8.0) * bw.z;
    // macro warm/cool patches that survive ANY distance (kills the chalk-plaster look on far cliffs)
    float rMac = mix(lyr(vec2(P.x + P.z, P.y) * (1.0 / 47.0), 7.0).a, macro2, gN.y * gN.y);
    cR.rgb *= mix(vec3(0.80, 0.72, 0.62), vec3(1.28, 1.20, 1.12), rMac);
    // per-region strata: frequency, TILT, phase drift and PRESENCE all vary (steep faces only, never one global corduroy)
    float steep = smoothstep(0.28, 0.48, slope);
    float reg = lyr(P.xz * (1.0 / 301.0) + 0.57, 7.0).a;
    float regB = lyr(P.xz * (1.0 / 151.0) + 0.19, 7.0).a;                 // 75/38/19 m bedding-phase drift: bands wander and pinch out
    float bandOn = smoothstep(0.30, 0.62, lyr(P.xz * (1.0 / 430.0) + 0.83, 7.0).a);   // whole massifs with no visible bedding at all
    float bandA = 0.25 + 0.75 * smoothstep(0.30, 0.65, reg);
    float sc = smoothstep(-0.3, 0.8, sin(P.y * mix(0.16, 0.52, reg) + (P.x - P.z) * (reg - 0.5) * 0.09 + regB * 12.0 + det2.b * 0.8));
    cR.rgb *= mix(1.0, 0.72 + 0.44 * sc, steep * bandA * bandOn);         // asymmetric ledge shading, floor lifted (no near-black clip)
    cR.rgb = mix(cR.rgb, cR.rgb * vec3(0.84, 0.86, 0.95), alt * 0.35);    // high crags: slightly cooler granite
    tAO = mix(tAO, min(1.0, tAO * 1.25 + 0.22), wRock);                   // shadowed faces keep readable detail (no near-black clip)
    // triplanar detail bump for cliffs
    vec4 dX = lyr(P.zy * (1.0 / 1.1), 7.0), dZ = lyr(P.xy * (1.0 / 1.1), 7.0);
    vec3 bX = vec3(0.0, dX.g * 2.0 - 1.0, dX.r * 2.0 - 1.0) * bw.x, bZ = vec3(dZ.r * 2.0 - 1.0, dZ.g * 2.0 - 1.0, 0.0) * bw.z;
    bump = mix(bump, (bX + bZ) * 0.7 * detFade + bump * bw.y, wRock);
  }
  // height-sharpened blend
  float e = 0.35;
  float sG = wGrass * (e + cG.a), sF = wForest * (e + cF.a), sD = wDirt * (e + cD.a), sS = wSand * (e + cS.a), sW = wSnow * (e + cW.a), sT = wStone * (e + cT.a), sR = wRock * (e + cR.a);
  sG *= sG; sF *= sF; sD *= sD; sS *= sS; sW *= sW; sT *= sT; sR *= sR;
  float sum = sG + sF + sD + sS + sW + sT + sR + 1e-5;
  vec3 alb = (cG.rgb * sG + cF.rgb * sF + cD.rgb * sD + cS.rgb * sS + cW.rgb * sW + cT.rgb * sT + cR.rgb * sR) / sum;
  float rough = (0.86 * sG + 0.92 * sF + 0.93 * sD + 0.78 * sS + 0.62 * sW + 0.80 * sT + 0.84 * sR) / sum;
  // snow: cool ambient tint so the caps read blue-grey, not blown white
  alb = mix(alb, alb * vec3(0.88, 0.94, 1.08), sW / sum);
  // macro tint: meadow warm/cool patches; stone/rock/snow stay neutral (no olive ruins, no mauve scree)
  vec3 tint = mix(vec3(0.84, 0.87, 0.70), vec3(1.10, 1.07, 0.98), macro) * (0.90 + 0.20 * macro2);
  tint = mix(tint, vec3(1.0), clamp((sT + sR + sW) / sum, 0.0, 1.0));
  alb *= tint;
  alb = mix(alb, alb * vec3(0.78, 0.86, 0.74), forestM * 0.6);
  alb = mix(alb, alb * vec3(0.92, 0.84, 1.12) + vec3(0.02, 0.01, 0.05), crystalM * 0.7);
  // far-field macro contrast on the VEGETATED ground only (rock/stone/snow keep their own): the aerial and every midground
  // beyond the detail fade used to collapse to one flat green + one flat brown. Value AND hue swing, ~140 m and ~60 m scales.
  float veg = clamp((sG + sF + sD) / sum, 0.0, 1.0);
  alb = mix(alb, alb * mix(vec3(0.60, 0.70, 0.50), vec3(1.36, 1.24, 1.02), macroC * 0.62 + macro2C * 0.38), farC * veg * 0.9);
  // shoreline wetness: wide gradient + saturated dark waterline band, like an FF14 shore
  float wet = lakeM * smoothstep(uWater + 6.5, uWater + 0.2, P.y + (det2.b - 0.5) * 0.7);
  alb *= mix(vec3(1.0), vec3(0.30, 0.35, 0.44), wet);
  alb *= mix(vec3(1.0), vec3(0.48, 0.54, 0.64), lakeM * smoothstep(uWater + 1.6, uWater + 0.2, P.y));   // dark saturated waterline band
  alb = mix(alb, alb * vec3(0.6, 0.72, 0.7), lakeM * smoothstep(uWater, uWater - 3.0, P.y));
  rough = mix(rough, 0.10, wet);
  // detail bump into the normal, close-up detail contrast (some albedo contrast survives at distance)
  tN = normalize(gN + bump);
  alb *= 1.0 + (det.b - 0.5) * 0.5 * detFade + (det2.b - 0.5) * 0.2 * (1.0 - 0.6 * far) + (det0.b - 0.5) * 0.45 * nearF;
  // crystal fields: faint aether motes in the ground
  tEmis = crystalM * vec3(0.35, 0.25, 0.9) * smoothstep(0.82, 0.96, det.b) * (0.5 + 0.5 * sin(uTime * 1.5 + det2.b * 20.0)) * 0.6;
  tRough = rough;
  diffuseColor.rgb *= alb;
}`;

function patchFragment(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
    .replace('#include <map_fragment>', FRAG_SPLAT)
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
    .replace('#include <normal_fragment_begin>', 'float faceDirection = gl_FrontFacing ? 1.0 : -1.0; vec3 normal = normalize((viewMatrix * vec4(tN, 0.0)).xyz); vec3 nonPerturbedNormal = normal;')
    .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += tEmis;')
    .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= tAO;');
}
