import * as THREE from 'three';
import { mulberry32, smoothstep, clamp, lerp } from '../core/Noise.js';
import { ORDER, RB, RR, RL_CORE, RL_EDGE, RING_IN, RING_OUT, THETA0, STEP, BIOMES, centerOf, wedgeAt, weightAt } from './Biomes.js';
// The bake math lives in terrainKernel.js so a REAL module worker can import it (see terrainWorker.js).
// It used to be stringified into a Blob worker, which silently died in every minified build.
import { heightAt, bakeKernel, layerTex, LAYERS, BC } from './terrainKernel.js';

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
 *     wavelengths so a 1 m bake reproduces it. It lives in terrainKernel.js (imported here and hung on the prototype) so
 *     the bake workers — real Vite module workers, ./terrainWorker.js, started in the constructor — import the SAME code
 *     instead of a stringified copy. They bake it into a 2048² R32F
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
const SIZE = 2048;           // world extent (m). 10 biomes: home bowl + mountain ring + 9 outer regions (see Biomes.js)
const TEX = 2048;            // height/normal bake resolution (1 texel = 1 m), covers [-1024, 1024)
const HALF = TEX / 2;
const ss = smoothstep, mix = lerp;

// mean LINEAR albedo of each biome's floor + how much of the ground it covers (mirrors FRAG_SPLAT's biome layer)
const BALB = [[0.049, 0.074, 0.032], [0.55, 0.62, 0.72], [0.40, 0.43, 0.53], [0.185, 0.192, 0.196], [0.055, 0.042, 0.038], [0.21, 0.23, 0.51], [0.070, 0.095, 0.052], [0.30, 0.31, 0.28], [0.052, 0.044, 0.070]];
const BCOV = [0.72, 1.0, 0.55, 0.6, 1.0, 0.6, 0.8, 0.9, 1.0];

export class Terrain {
  constructor(game) {
    this.game = game;
    this.size = SIZE;
    this.waterLevel = WL;
    this.seed = game.seed;
    this._n = new THREE.Vector3();
    const P = (x, z) => new THREE.Vector3(x, this.heightAt(x, z), z);
    this.POI = { spawn: P(0, 0), aetheryte: P(0, -28), lake: P(-170, -70), ruins: P(140, 60), forest: P(0, -235), crystal: P(300, 0), arena: P(-60, 260) };
    this.biomePOI = {};                                                  // the 9 outer biome hearts (POI.forest stays Whisperwood, the home-side forest edge)
    for (let k = 0; k < ORDER.length; k++) { const c = centerOf(k); this.biomePOI[ORDER[k]] = P(c.x, c.z); if (!this.POI[ORDER[k]]) this.POI[ORDER[k]] = this.biomePOI[ORDER[k]]; }
    this._R = game.quality === 'low' ? 256 : 512;   // layer texture resolution
    this._baked = this._bakeAsync();                    // workers start now, overlapping the other systems' init
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 0.5;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z), hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }
  slopeAt(x, z) { return 1 - clamp(this.normalAt(x, z, this._n).y, 0, 1); }
  biomeAt(x, z) {
    const d2 = x * x + z * z;
    if (d2 > RING_IN * RING_IN) {                      // outside the home bowl: one of the 9 outer regions, else ring/corridor rock
      const k = wedgeAt(x, z);
      if (weightAt(x, z, k) > 0.02) return ORDER[k];
      if (d2 > RING_OUT * RING_OUT) return 'wilds';
    }
    const h = this.heightAt(x, z);
    if (h > 45 || d2 > 160000) return 'mountain';
    const lx = x + 170, lz = z + 70; if (lx * lx + lz * lz < 13225 && h < WL + 2.5) return 'lake';
    const ax = x + 60, az = z - 260; if (ax * ax + az * az < 3600) return 'arena';
    const rx = x - 140, rz = z - 60; if (rx * rx + rz * rz < 5184) return 'ruins';
    if (z < -180 && Math.abs(x) < 260) return 'forest';
    if (x > 220) return 'crystal';
    return 'meadow';
  }

  /**
   * 0..1 "this is one of the nine pass roads". Same band heightAt flattens, exposed so nothing gets PLACED
   * in it — a road with trees growing across it is not a road, and a wedged player never reaches the region.
   */
  roadAt(x, z) {
    const d0 = Math.sqrt(x * x + z * z);
    if (d0 < 240 || d0 > 760) return 0;
    const th = Math.atan2(z, x) - THETA0;
    // Width in METRES off the centre line, not in radians. An angular road is a WEDGE: at 0.10 rad it was
    // 24 m wide at the mountain feet and 61 m wide at a region's heart, so every outer region had a bald
    // 100 m corridor driven through the middle of it — which is what made the Whisperwood read as a lawn
    // with a treeline round it, and why nine `goto` screenshots all landed in the same empty clearing.
    const arc = Math.abs(th - Math.round(th / STEP) * STEP) * d0;
    return ss(13.0, 3.5, arc) * ss(250, 320, d0) * ss(760, 650, d0);
  }

  /** 0..1 ground-cover density. Grass.js prefers this over its own biome-name heuristics. */
  grassAt(x, z) {
    const d2 = x * x + z * z;
    if (d2 > RING_IN * RING_IN) {
      const k = wedgeAt(x, z), w = weightAt(x, z, k);
      const wild = 0.5 * (1 - ss(28, 56, this.heightAt(x, z)));      // ring rock + the corridors between regions: patchy scrub
      return mix(wild, BIOMES[ORDER[k]].grass.d, w);
    }
    const b = this.biomeAt(x, z);
    return b === 'meadow' ? 1 : b === 'crystal' ? 0.7 : b === 'forest' ? 0.6 : b === 'ruins' ? 0.2 : 0;
  }

  /** { id, w } — nearest outer biome + its 0..1 weight. w = 0 anywhere in the home bowl. Allocation-free. */
  biomeBlend(x, z, out = this._bb ??= { id: 'meadow', w: 0, k: -1 }) {
    out.id = 'meadow'; out.w = 0; out.k = -1;
    if (x * x + z * z < RING_IN * RING_IN) return out;
    const k = wedgeAt(x, z); out.k = k; out.id = ORDER[k]; out.w = weightAt(x, z, k);
    return out;
  }
  /** 0..1 "no standing water here" mask (Infernal ash + the Void abyss). Water/Lava read it. */
  dryAt(x, z) {
    const b = this.biomeBlend(x, z, this._bd ??= {});
    return BIOMES[b.id]?.dry ? b.w : 0;
  }
  /** Gravity multiplier for the player/projectiles (the Void's broken physics). */
  gravityAt(x, z) {
    const b = this.biomeBlend(x, z, this._bg ??= {});
    const g = BIOMES[b.id]?.gravity;
    return g ? mix(1, g, b.w) : 1;
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
    const mtn = Math.max(ss(26, 40, h + (macro - 0.5) * 10), ss(340, 400, d0c + (macro - 0.5) * 70) * (1 - ss(500, 580, d0c)));
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
    if (d0c > 470) {   // outer biome floor: same wedge choice, same meandering seam and same cross-fade as the splat
      const rr = Math.max(d0c, 1);
      const f = (Math.atan2(z, x) - THETA0) / STEP
        + ((macro - 0.5) * 52 + (macro2 - 0.5) * 19) / (rr * STEP);
      const kf = Math.floor(f + 0.5), u = f - kf;
      const wrap = (n) => ((n % 9) + 9) % 9;
      const k = wrap(kf), k2 = wrap(kf + (u >= 0 ? 1 : -1));
      const hw = clamp(34 / (rr * STEP), 0.02, 0.45), bm = 0.5 * ss(0.5 - hw, 0.5, Math.abs(u));
      const bwOf = (i) => { const c = BC[i]; return ss(RL_EDGE, RL_CORE, Math.hypot(x - c[0], z - c[1])) * BCOV[i]; };
      const bw = mix(bwOf(k), bwOf(k2), bm);
      if (bw > 0.002) {
        const a = BALB[k], a2 = BALB[k2];
        r = mix(r, mix(a[0], a2[0], bm), bw); g = mix(g, mix(a[1], a2[1], bm), bw); b = mix(b, mix(a[2], a2[2], bm), bw);
      }
    }
    const wet = lakeM * ss(WL + 6.5, WL + 0.2, h);
    r *= mix(1, 0.30, wet); g *= mix(1, 0.35, wet); b *= mix(1, 0.44, wet);
    return out.setRGB(r, g, b);
  }

  // ---------------------------------------------------------------- bake (workers; main-thread fallback runs the same kernel)
  _bakeAsync() {
    const N = TEX, R = this._R;
    const out = { hgt: new Float32Array(N * N), nrm: new Uint8Array(N * N * 4), layers: new Uint8Array(LAYERS * R * R * 4), R };
    const merge = (r) => { out.hgt.set(r.hgt, r.y0 * N); out.nrm.set(r.nrm, r.y0 * N * 4); for (const L of r.layers) out.layers.set(L.data, L.l * R * R * 4); };
    const fallback = (e) => { console.warn('[terrain] worker bake unavailable, baking on the main thread', e?.message ?? e); merge(bakeKernel({ seed: this.seed, w: 0, W: 1, R, N })); return out; };
    try {
      const W = Math.min(6, Math.max(2, navigator.hardwareConcurrency || 4));
      // Real module worker: the bundler resolves terrainKernel.js, so the worker bakes exactly what
      // heightAt() says in dev AND in a minified build. (The old Blob-of-stringified-functions worker
      // threw `noise2 is not defined` in every production build and fell back to the main thread.)
      const jobs = [];
      for (let w = 0; w < W; w++) jobs.push(new Promise((res, rej) => {
        const wk = new Worker(new URL('./terrainWorker.js', import.meta.url), { type: 'module' });
        wk.onmessage = (e) => { merge(e.data); wk.terminate(); res(); };
        wk.onerror = (e) => { wk.terminate(); rej(e); };
        wk.postMessage({ seed: this.seed, w, W, R, N });
      }));
      return Promise.all(jobs).then(() => out, fallback);
    } catch (e) { return Promise.resolve(fallback(e)); }
  }

  // ---------------------------------------------------------------- init
  async init() {
    const { renderer, scene, camera } = this.game;
    const q = renderer.qualityPreset;
    const n = { low: 128, medium: 160, high: 192 }[this.game.quality] ?? 192;  // cells per level (multiple of 4)
    const E = n / 2, H = E / 2 - 1;
    const L = Math.ceil(Math.log2(SIZE / E)) + 1;                       // levels until the coarsest covers the whole world
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
      const SH = 3, st = 1 << SH, C = (TEX >> SH) + 1, cq = new Float32Array(C * C);   // 8 m analytic grid -> bilinear 1 m upsample (~66k heightAt, ~0.1 s)
      for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) cq[j * C + i] = this.heightAt(i * st - HALF, j * st - HALF);
      for (let j = 0; j < TEX; j++) {
        const j0 = j >> SH, fj = (j & (st - 1)) / st, r0 = j0 * C, r1 = Math.min(j0 + 1, C - 1) * C;
        for (let i = 0; i < TEX; i++) {
          const i0 = i >> SH, fi = (i & (st - 1)) / st, i1 = Math.min(i0 + 1, C - 1);
          const a = cq[r0 + i0], b = cq[r0 + i1], c = cq[r1 + i0], d = cq[r1 + i1];
          hgtQ[j * TEX + i] = a + (b - a) * fi + (c - a + (a - b + d - c) * fi) * fj;
        }
      }
      heightTex.image.data = hgtQ; heightTex.needsUpdate = true;
    }
    const RQ = 512, RQS = TEX / RQ, nrmQdata = new Uint8Array(RQ * RQ * 4);   // preview normals from the preview height (AO = 1)
    {
      const Hs = (i, j) => hgtQ[Math.min(TEX - 1, Math.max(0, j)) * TEX + Math.min(TEX - 1, Math.max(0, i))];
      for (let j = 0, k = 0; j < RQ; j++) for (let i = 0; i < RQ; i++, k += 4) {
        const I = RQS * i, J = RQS * j, dx = Hs(I + 2, J) - Hs(I - 2, J), dz = Hs(I, J + 2) - Hs(I, J - 2);
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
    // [layer, file, sRGB gain]. 6/8/9/10/11 are the outer regions' floors — they were procedural noise, which
    // is why the Isles read as flat tan with a visible lattice and the Void and the fen read as coloured mud.
    const ASSET_LAYERS = [[0, 'grass_albedo', 1.00], [3, 'cliff_strata', 1.20], [4, 'beach_sand', 0.80], [5, 'snow', 0.84],
      [6, 'celestial_marble', 0.88], [8, 'ash', 1.00], [9, 'glacier_ice', 0.90], [10, 'fen_muck', 1.02], [11, 'voidstone', 1.05]];
    const imgP = Promise.all(ASSET_LAYERS.map(([l, nm, mul]) =>
      fetch(`/assets/tex/${nm}.jpg`).then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
        .then((bl) => createImageBitmap(bl, { resizeWidth: R, resizeHeight: R, resizeQuality: 'high' }))
        .then((bm) => { const cv = new OffscreenCanvas(R, R), cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(bm, 0, 0, R, R); bm.close(); return { l, mul, data: cx.getImageData(0, 0, R, R).data }; })
        .catch((e) => { console.warn(`[terrain] asset ${nm} unavailable (${e?.message ?? e}), procedural fallback`); return null; })));
    Promise.all([this._baked, imgP]).then(([b, imgs]) => {
      this._hgt = b.hgt;                       // exact 1 m height field (Water reuses it if it rebakes)
      let err = 0; for (let k = 0; k < 64; k++) { const i = (k * 97 + 5) % TEX, j = (k * 389 + 11) % TEX; err = Math.max(err, Math.abs(b.hgt[j * TEX + i] - this.heightAt(i - HALF, j - HALF))); }
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
// The height field itself lives in terrainKernel.js (so the bake worker can import it). It reads
// `this.seed`, so hanging it on the prototype keeps `terrain.heightAt(x, z)` byte-identical for every caller.
Terrain.prototype.heightAt = heightAt;

// ======================================================================= shaders
const VERT_PARS = /* glsl */`
uniform highp sampler2D uHeight;
uniform highp sampler2D uNormal;
uniform vec2 uCenter;
uniform vec2 uMorph;
varying vec3 vWPos;
// Out-of-world skirt. The 2048 m bake stops at the world edge; past it the clipmap used to add
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
  vec2 cc = clamp(c, -${HALF}.0, ${HALF - 1}.0);
  float h = texelFetch(uHeight, ivec2(cc + ${HALF}.0), 0).r;
  float o = max(0.0, max(abs(c.x), abs(c.y)) - ${HALF - 1}.0);
  if (o <= 0.0) return h;
  float r1 = 1.0 - abs(skNoise(w * 0.0045) * 2.0 - 1.0);
  float r2 = 1.0 - abs(skNoise(w * 0.0115 + 7.3) * 2.0 - 1.0);
  return h + o * (0.05 + 0.30 * (r1 * r1 * 0.8 + r2 * r2 * 0.2));   // tuned so the far range tops out just UNDER the ring crest
}
vec3 terrainN(vec2 w) {
  vec4 t = textureLod(uNormal, (w + ${HALF}.5) / ${TEX}.0, 0.0);
  vec3 n = vec3(t.r * 2.0 - 1.0, 0.0, t.g * 2.0 - 1.0);
  n.y = sqrt(max(0.0, 1.0 - dot(n.xz, n.xz)));
  float o = max(abs(w.x), abs(w.y)) - ${HALF - 1}.0;
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
// Explicit-gradient twin of lyr(). REQUIRED for any fetch inside a weight guard: implicit derivatives are
// undefined in divergent control flow, so a guarded texture() would sample a garbage mip on the silhouette
// of the branch. Callers hoist dFdx/dFdy(P.xz) out of the branch and scale them by the same factor as uv.
vec4 lyrG(vec2 uv, float i, vec2 dx, vec2 dy) { return textureGrad(uLayers, vec3(uv, i), dx, dy); }
// hex-tile stochastic sampling (technique: three-hex-tiling / Mikkelsen hextile, MIT) — random per-hex offsets kill visible repeats
vec2 hexH(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
// Derivatives passed in, not taken inside: the seam blend samples a second layer behind a branch, and
// dFdx/dFdy in non-uniform control flow is undefined. lyrHex() keeps the old signature for every other caller.
vec4 lyrHexG(vec2 uv, float i, float sharp, vec2 dx, vec2 dy) {
  const mat2 sk = mat2(1.0, 0.0, -0.57735027, 1.15470054);
  vec2 t = sk * (uv * 0.35); vec2 b = floor(t); vec3 w = vec3(fract(t), 0.0); w.z = 1.0 - w.x - w.y;
  vec2 v1, v2, v3;
  if (w.z > 0.0) { w = vec3(w.z, w.y, w.x); v1 = b; v2 = b + vec2(0.0, 1.0); v3 = b + vec2(1.0, 0.0); }
  else { w = vec3(-w.z, 1.0 - w.y, 1.0 - w.x); v1 = b + 1.0; v2 = b + vec2(1.0, 0.0); v3 = b + vec2(0.0, 1.0); }
  w = pow(w, vec3(sharp)); w /= (w.x + w.y + w.z);
  return textureGrad(uLayers, vec3(uv + hexH(v1), i), dx, dy) * w.x
       + textureGrad(uLayers, vec3(uv + hexH(v2), i), dx, dy) * w.y
       + textureGrad(uLayers, vec3(uv + hexH(v3), i), dx, dy) * w.z;
}
vec4 lyrHex(vec2 uv, float i, float sharp) { return lyrHexG(uv, i, sharp, dFdx(uv), dFdy(uv)); }
// One outer region's floor recipe, by wedge index. Pulled out of the splat so the seam can evaluate BOTH
// sides of a border and cross-fade them (see FRAG_SPLAT's bMix).
void biomeSet(float k, out float layer, out float scl, out float rough, out float cov, out float snow, out float rockCut, out vec3 tint) {
  layer = 1.0; scl = 3.6; rough = 0.90; cov = 0.72; snow = 0.0; rockCut = 0.0; tint = vec3(1.0);
  if (k < 0.5)      { layer = 1.0;  scl = 3.4; cov = 0.92; tint = vec3(0.42, 0.60, 0.50); }                  // Whisperwood floor: moss + leaf litter in SHADE. It was 0.86/1.10/0.80 — a lit lawn with a treeline round it; Ashenvale's floor is the darkest ground in the world, not the brightest
  else if (k < 1.5) { layer = 9.0;  scl = 6.5; cov = 1.00; rough = 0.45; snow = 1.0; rockCut = 0.55; }       // tundra glacier
  else if (k < 2.5) { layer = 6.0;  scl = 4.6; cov = 0.86; rough = 0.55; tint = vec3(0.98, 1.14, 1.46); }    // celestial: celestial_marble.jpg is TAN (linear ratio 1 : 0.85 : 0.61) and the old warm tint pushed it further, which is why the Isles read as a sand desert. This inverts the asset's own hue to a warm WHITE marble
  else if (k < 3.5) { layer = 3.0;  scl = 6.0; cov = 0.88; rockCut = 0.12; tint = vec3(0.84, 0.88, 1.02); }   // dragon rock. rockCut stays LOW on purpose: the triplanar cliff (cR) is the only layer with real crag detail, and cutting it replaced the faces with a top-projected texture that smears into sand dunes on a slope. The Peaks' warmth is cooled by the tint and the key instead: cool granite, not desert mesa
  else if (k < 4.5) { layer = 8.0;  scl = 3.2; cov = 1.00; rough = 0.92; rockCut = 0.80; tint = vec3(0.80, 0.82, 0.94); }   // infernal ash: Burning Steppes is CHARCOAL with red cracks, not red rock
  else if (k < 5.5) { layer = 6.0;  scl = 4.2; cov = 0.86; tint = vec3(0.56, 0.62, 1.42); }                  // lost realm: worn VIOLET flagstone — same tan asset as the Isles, so it needs the same blue lift or it is just warm stone under a pink sky
  else if (k < 6.5) { layer = 10.0; scl = 3.0; cov = 0.94; rough = 0.55; rockCut = 0.45; tint = vec3(0.70, 0.86, 0.74); }   // shadowfen: wet peat, olive-black. fen_muck.jpg is warm brown (1 : 0.78 : 0.46) and read as dry earth under bright grass
  else if (k < 7.5) { layer = 4.0;  scl = 3.0; cov = 0.90; rough = 0.70; tint = vec3(0.78, 0.95, 0.94); rockCut = 0.55; }   // sunken reef
  else              { layer = 11.0; scl = 4.0; cov = 1.00; rough = 0.68; rockCut = 0.88; tint = vec3(0.78, 0.74, 0.92); }   // voidstone
}`;

// splat: computed where <map_fragment> would sample the albedo; leaves tN (world normal), tRough, tAO, tEmis for later chunks
const FRAG_SPLAT = /* glsl */`
vec3 tN; float tRough; float tAO; vec3 tEmis = vec3(0.0);
{
  vec3 P = vWPos;
  vec4 nt = texture(uNormal, (P.xz + ${HALF}.5) / ${TEX}.0);
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
  float rad = length(P.xz);
  float home = 1.0 - smoothstep(300.0, 400.0, rad);                          // home-bowl features never leak into the biome belt
  forestM *= home;
  float mtn = max(smoothstep(26.0, 40.0, P.y + (macro - 0.5) * 10.0), smoothstep(340.0, 400.0, rad + (macro - 0.5) * 70.0) * (1.0 - smoothstep(500.0, 580.0, rad)));
  float crystalM = smoothstep(195.0, 260.0, P.x + (macro - 0.5) * 40.0) * (1.0 - mtn) * home;
  // --- outer biome (Biomes.js: 9 wedges, centres on a ring of radius RB) ---
  // The border between two regions is the bisector wedgeAt hands over on. Picking ONE wedge per pixel drew
  // that bisector as a dead-straight radial line — snow ending mid-stride against marble. So: the wedge
  // coordinate is pushed around by the macro noise (a boundary that MEANDERS, in metres, not degrees), and
  // within a band either side of it BOTH neighbours are sampled and cross-faded. Together they read as one
  // region's ground breaking up into the next, which is what a border looks like from the ground.
  float bAng = atan(P.z, P.x);
  float bRad = max(rad, 1.0);
  float bJit = ((macro - 0.5) * 52.0 + (macro2 - 0.5) * 19.0 + (det2.b - 0.5) * 6.0) / (bRad * ${STEP});
  float bF = (bAng - ${THETA0}) / ${STEP} + bJit;
  float bKf = floor(bF + 0.5), bU = bF - bKf;                     // bU: 0 at the wedge centre, +-0.5 at a seam
  float bK = mod(bKf, 9.0), bK2 = mod(bKf + (bU >= 0.0 ? 1.0 : -1.0), 9.0);
  float bHW = clamp(34.0 / (bRad * ${STEP}), 0.02, 0.45);         // ~34 m half-band, constant in METRES at any radius
  // ...and only while the border is something you can actually LOOK at. Far away a 68 m band is thinner than
  // a pixel, so blending there just hands the sampler two floors to alias between: distant ground flickered
  // green<->ice frame to frame, which is a bloom-blob report waiting to happen. MEASURED, not guessed — with
  // no fade the gate reported 17 blob lines and with 260..460 it reported 26-647 px clusters up at the
  // horizon (y~50-100 px); at 120..240 every remaining report is the pre-existing near-ground grass speck and
  // the horizon is clean. It costs nothing to look at: from 150 m up the blend still runs at ~84%.
  float bMix = 0.5 * smoothstep(0.5 - bHW, 0.5, abs(bU)) * (1.0 - smoothstep(120.0, 240.0, camD));
  float bA = ${THETA0} + bK * ${STEP}, bA2 = ${THETA0} + bK2 * ${STEP};
  float bD = length(P.xz - vec2(cos(bA), sin(bA)) * ${RB}.0) + (macro - 0.5) * 26.0;
  float bD2 = length(P.xz - vec2(cos(bA2), sin(bA2)) * ${RB}.0) + (macro - 0.5) * 26.0;
  float bLayer, bScl, bRough, bCov, bSnow, bRockCut; vec3 bTint;
  float bLayer2, bScl2, bRough2, bCovN, bSnow2, bRockCut2; vec3 bTint2;
  biomeSet(bK, bLayer, bScl, bRough, bCov, bSnow, bRockCut, bTint);
  biomeSet(bK2, bLayer2, bScl2, bRough2, bCovN, bSnow2, bRockCut2, bTint2);
  float bW = 1.0 - smoothstep(${RL_CORE}.0, ${RL_EDGE}.0, bD);    // Biomes.RL_*: regions abut, seam at ~260 m
  float bW2 = 1.0 - smoothstep(${RL_CORE}.0, ${RL_EDGE}.0, bD2);
  float wB = mix(bW * bCov, bW2 * bCovN, bMix);
  bRough = mix(bRough, bRough2, bMix);
  bSnow = mix(bSnow, bSnow2, bMix); bRockCut = mix(bRockCut, bRockCut2, bMix);
  bW = mix(bW, bW2, bMix);                                        // used below for the snow / cliff overrides
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
  wSnow *= 1.0 - smoothstep(${HALF - 32}.0, ${HALF}.0, max(abs(P.x), abs(P.z)));
  float skirtM = smoothstep(76.0, 58.0, ruinD) * smoothstep(38.0, 52.0, ruinD);   // Spire skirt band: broken rock, not a dirt mound
  float rockTh = mix(0.30, 0.12, max(alt, max(mtn, skirtM)));
  float rockW = 0.13 + far * 0.12;                                       // wide blend + multi-octave dither: no sawtooth boundary at the skirt base
  float wRock = smoothstep(rockTh - rockW, rockTh + rockW * 1.25, slope + (macro - 0.5) * 0.10 + (det2.b - 0.5) * 0.07 + (det.b - 0.5) * 0.06 * detFade + (det0.b - 0.5) * 0.05 * nearF);
  float beltD = length(P.xz);                                            // mountain approach belt: scree/rock patches, not a dirt ramp
  float beltM = smoothstep(238.0, 296.0, beltD) * (1.0 - smoothstep(348.0, 412.0, beltD));
  wRock = max(wRock, beltM * smoothstep(0.26, 0.60, macro2C + (det2.b - 0.5) * 0.30) * smoothstep(0.02, 0.09, slope));
  wRock = max(wRock, skirtM * smoothstep(0.10, 0.20, slope + (macro - 0.5) * 0.08));
  wRock *= 1.0 - bW * bRockCut;      // in the Wastes/Void/glacier/reef the CLIFF is the biome's own stone, not generic strata
  float wSand = lakeM * smoothstep(uWater + 1.9, uWater + 0.9, P.y + (macro2 - 0.5) * 0.9);
  float wStone = max(ruinM, arenaM);
  float wDirt = clamp(smoothstep(0.12, 0.26, slope + (macro2 - 0.5) * 0.06) + smoothstep(0.64, 0.80, macro2) * 0.7 + crystalM * 0.35 + alt * 0.5 + mtn * 0.75, 0.0, 1.0);
  wSnow = max(wSnow, bW * bSnow * (1.0 - smoothstep(0.40, 0.68, slope)));    // Frostveil is snowbound at 25 m, not 120
  float wForest = forestM * (1.0 - mtn);
  float wGrass = 1.0 - mtn;
  wGrass *= 1.0 - wForest;
  float k = 1.0 - wDirt; wGrass *= k; wForest *= k;
  k = 1.0 - wB; wGrass *= k; wForest *= k; wDirt *= k;                       // the biome floor sits over grass/forest/dirt...
  k = 1.0 - wStone; wGrass *= k; wForest *= k; wDirt *= k; wB *= k;
  k = 1.0 - wSand; wGrass *= k; wForest *= k; wDirt *= k; wStone *= k; wB *= k;
  k = 1.0 - wRock; wGrass *= k; wForest *= k; wDirt *= k; wStone *= k; wSand *= k; wB *= k;   // ...but cliffs and snow still win
  k = 1.0 - wSnow; wGrass *= k; wForest *= k; wDirt *= k; wStone *= k; wSand *= k; wRock *= k; wB *= k;
  // --- sample layers (top projection; rock triplanar). Asset albedos live in the array; hex-tiling kills the repeat.
  float farC = smoothstep(50.0, 280.0, camD);                            // albedo macro contrast ramps in EARLY (aerial is not a paint fill)
  vec4 cG = mix(lyrHex(P.xz * (1.0 / 3.7), 0.0, 3.0), lyr(P.xz * (1.0 / 11.0) + 0.31, 0.0), 0.35);
  cG.rgb = mix(cG.rgb, lyr(P.xz * (1.0 / 43.0) + 0.61, 0.0).rgb, farC * 0.65);  // huge-scale patches: contrast survives distance
  cG.rgb *= mix(1.0, 0.55 + 0.95 * macroC, farC);                        // 143 m light/dark meadow patches from the air
  float dry = smoothstep(0.42, 0.64, macro2) * (1.0 - forestM);          // sun-dried grass patches ringing the dirt patches
  cG.rgb = mix(cG.rgb, cG.rgb * vec3(1.6, 1.25, 0.55) + vec3(0.05, 0.03, 0.0), dry * 0.6);
  // Weight-guarded layer fetches. Each of these five layers is multiplied by a weight that is exactly 0 across
  // most of the map (no sand in the tundra, no snow in the meadow, no flagstone outside the ruins), yet every
  // fetch ran unconditionally -- 7 of ~16 array taps serving layers contributing nothing. Same 0.002 threshold
  // and same shape as the wRock / wB guards below; the sample is multiplied by ~0 either way, so the image does
  // not move. Gradients are hoisted so the guarded taps keep the mip the unguarded ones would have picked.
  vec2 pdx = dFdx(P.xz), pdy = dFdy(P.xz);
  vec4 cF = vec4(0.0);
  if (wForest > 0.002) {
    cF = lyrG(P.xz * (1.0 / 3.6), 1.0, pdx * (1.0 / 3.6), pdy * (1.0 / 3.6));
    cF.rgb = mix(cF.rgb, lyrG(P.xz * (1.0 / 27.0) + 0.41, 1.0, pdx * (1.0 / 27.0), pdy * (1.0 / 27.0)).rgb, farC * 0.5);
  }
  vec4 cD = vec4(0.0);
  if (wDirt > 0.002) {
    cD = lyrG(P.xz * (1.0 / 4.2), 2.0, pdx * (1.0 / 4.2), pdy * (1.0 / 4.2));
    cD.rgb = mix(cD.rgb, lyrG(P.xz * (1.0 / 31.0) + 0.23, 2.0, pdx * (1.0 / 31.0), pdy * (1.0 / 31.0)).rgb, farC * 0.55);
    cD.rgb *= mix(1.0, 0.62 + 0.80 * macroC, farC);
  }
  vec4 cS = vec4(0.0);
  if (wSand > 0.002) {
    cS = lyrG(P.xz * (1.0 / 2.4), 4.0, pdx * (1.0 / 2.4), pdy * (1.0 / 2.4));
    cS.rgb *= mix(vec3(1.08, 0.99, 0.88), vec3(0.92, 0.90, 0.97), smoothstep(0.35, 0.65, macro2));   // warm/cool sand patches
  }
  vec4 cW = vec4(0.0);
  if (wSnow > 0.002) cW = lyrG(P.xz * (1.0 / 9.0), 5.0, pdx * (1.0 / 9.0), pdy * (1.0 / 9.0));
  // flagstones: per-5m-cell whole-stone offset + 90deg rotation kills the parking-lot repeat (cell borders land on mortar)
  vec4 cT = vec4(0.0);
  if (wStone > 0.002) {
    vec2 stC = floor(P.xz * 0.2);
    float stH = fract(sin(dot(stC, vec2(127.1, 311.7))) * 43758.545);
    vec2 stUV = P.xz * 0.2 + floor(vec2(stH, fract(stH * 7.0)) * 7.0) * (1.0 / 7.0);   // quantum = one stone (7 stones/tile)
    vec2 sdx = pdx * 0.2, sdy = pdy * 0.2;
    if (stH > 0.5) { stUV = vec2(stUV.y, -stUV.x); sdx = vec2(sdx.y, -sdx.x); sdy = vec2(sdy.y, -sdy.x); }   // rotate the gradients with the uv
    cT = lyrG(stUV, 6.0, sdx, sdy);
  }
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
  // biome floor. Derivatives are taken in uniform control flow (pdx/pdy, hoisted above with the guarded splat
  // fetches) and handed to the sampler, so the second (neighbour) fetch can sit behind a branch and cost
  // nothing outside a border band.
  vec4 cB = vec4(0.0);
  if (wB > 0.002) {
    cB = lyrHexG(P.xz / bScl, bLayer, 3.0, pdx / bScl, pdy / bScl);
    cB.rgb *= bTint * mix(0.78, 1.24, macro2C);
    if (bMix > 0.004) {                                           // inside a border band: fade the neighbour's floor in
      vec4 cN = lyrHexG(P.xz / bScl2, bLayer2, 3.0, pdx / bScl2, pdy / bScl2);
      cN.rgb *= bTint2 * mix(0.78, 1.24, macro2C);
      cB = mix(cB, cN, bMix);
    }
  }
  // height-sharpened blend
  float e = 0.35;
  float sG = wGrass * (e + cG.a), sF = wForest * (e + cF.a), sD = wDirt * (e + cD.a), sS = wSand * (e + cS.a), sW = wSnow * (e + cW.a), sT = wStone * (e + cT.a), sR = wRock * (e + cR.a), sB = wB * (e + cB.a);
  sG *= sG; sF *= sF; sD *= sD; sS *= sS; sW *= sW; sT *= sT; sR *= sR; sB *= sB;
  float sum = sG + sF + sD + sS + sW + sT + sR + sB + 1e-5;
  vec3 alb = (cG.rgb * sG + cF.rgb * sF + cD.rgb * sD + cS.rgb * sS + cW.rgb * sW + cT.rgb * sT + cR.rgb * sR + cB.rgb * sB) / sum;
  float rough = (0.86 * sG + 0.92 * sF + 0.93 * sD + 0.78 * sS + 0.62 * sW + 0.80 * sT + 0.84 * sR + bRough * sB) / sum;
  // snow: cool ambient tint so the caps read blue-grey, not blown white
  alb = mix(alb, alb * vec3(0.88, 0.94, 1.08), sW / sum);
  // macro tint: meadow warm/cool patches; stone/rock/snow stay neutral (no olive ruins, no mauve scree)
  vec3 tint = mix(vec3(0.84, 0.87, 0.70), vec3(1.10, 1.07, 0.98), macro) * (0.90 + 0.20 * macro2);
  tint = mix(tint, vec3(1.0), clamp((sT + sR + sW + sB) / sum, 0.0, 1.0));
  alb *= tint;
  alb = mix(alb, alb * vec3(0.78, 0.86, 0.74), forestM * 0.6);
  alb = mix(alb, alb * vec3(0.92, 0.84, 1.12) + vec3(0.02, 0.01, 0.05), crystalM * 0.7);
  // far-field macro contrast on the VEGETATED ground only (rock/stone/snow keep their own): the aerial and every midground
  // beyond the detail fade used to collapse to one flat green + one flat brown. Value AND hue swing, ~140 m and ~60 m scales.
  float veg = clamp((sG + sF + sD) / sum, 0.0, 1.0);
  alb = mix(alb, alb * mix(vec3(0.60, 0.70, 0.50), vec3(1.36, 1.24, 1.02), macroC * 0.62 + macro2C * 0.38), farC * veg * 0.9);
  // Underwater CAUSTICS. The Sunken Kingdom's whole identity is being under the sea, and below the surface
  // the only thing that changed was the fog colour. Two counter-drifting sine lattices sharpened with a
  // power curve give the moving light net; it MULTIPLIES the albedo (never emissive), so it respects the
  // sun, the shadows and the tone map, and it cannot bloom. Fades out with depth like the real thing.
  float sub = smoothstep(0.0, -1.0, P.y - uWater);
  if (sub > 0.002) {
    vec2 cq = P.xz * 0.55;
    float w1 = sin(cq.x + uTime * 0.75) * sin(cq.y * 1.07 - uTime * 0.62);
    float w2 = sin((cq.x + cq.y) * 0.71 - uTime * 0.48) * sin((cq.x - cq.y) * 0.63 + uTime * 0.39);
    float cst = pow(clamp(w1 * 0.5 + w2 * 0.5 + 0.5, 0.0, 1.0), 5.0);
    alb *= 1.0 + cst * 1.5 * sub * (1.0 - smoothstep(0.0, 22.0, uWater - P.y));
  }
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
  // Biome ground glow. ARCHITECTURAL LAW: saturate the HUE, cap the VALUE - a ground emissive that can reach the
  // bloom threshold turns into drifting white balls. Deep orange fissures / violet void veins, both well under 1.
  float bCov2 = sB / sum;
  // Thresholds are calibrated to the LUMA OF THE FLOOR TEXTURE (cB.a is its luma): ash and voidstone sit at
  // median 0.11, so the old 0.30..0.06 ramp lit the entire floor and the Wastes and the Void rendered as one
  // flat sheet of orange / violet emissive with no ground under it. These bands catch the darkest ~10-12% —
  // the cracks between the plates, which is what a fissure is. Re-measure if either texture is replaced.
  // blended across a seam as well, so the Wastes' fissures fade out into the next region instead of stopping dead
  float wLava = mix(step(3.5, bK) * step(bK, 4.5), step(3.5, bK2) * step(bK2, 4.5), bMix);
  float wVein = mix(step(7.5, bK), step(7.5, bK2), bMix);
  // MEASURED against ash.jpg's luma histogram (median 0.111): the 0.075..0.025 band caught ~10% of the floor,
  // which at a 3.2 m tile is a glowing NET over every square metre — the Wastes read as red-hot ground with
  // black bits, the exact inverse of Burning Steppes. 0.045..0.012 catches ~3% (the deepest cracks only), and
  // the macro gate concentrates those into hot zones so the rest of the plain is honestly cold black rock.
  tEmis += vec3(0.90, 0.155, 0.012) * wLava * bCov2 * smoothstep(0.045, 0.012, cB.a) * (0.62 + 0.38 * sin(uTime * 0.7 + det2.b * 9.0)) * 0.45 * (0.20 + 0.80 * macroC);
  tEmis += vec3(0.34, 0.10, 0.85) * wVein * bCov2 * smoothstep(0.085, 0.032, cB.a) * (0.55 + 0.45 * sin(uTime * 1.1 + det.b * 14.0)) * 0.34;
  tRough = rough;
  diffuseColor.rgb *= alb;
}`;

// Hue-preserving highlight shoulder on the ground's outgoing colour. Grass has a hard luminance CAP
// (GRASS_LUM_CAP) because a sub-pixel blade that reaches the bloom threshold becomes a floating ball.
// Terrain is a large continuous surface, so a hard cap would flatten a legitimately bright snowfield —
// what it needs is a soft shoulder: below KNEE nothing changes at all, above it the excess is compressed
// asymptotically toward CEIL. This is what stops the meadow floor going flat white when a low sun rakes
// across it (which the 10-biome ring rework let happen by opening the eastern horizon).
const FRAG_SHOULDER = /* glsl */`
#include <opaque_fragment>
{
  const float KNEE = 0.55, CEIL = 0.86;
  float L = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  if (L > KNEE) {
    float Lc = KNEE + (CEIL - KNEE) * (1.0 - exp(-(L - KNEE) / (CEIL - KNEE)));
    gl_FragColor.rgb *= Lc / L;
  }
}`;

function patchFragment(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <opaque_fragment>', FRAG_SHOULDER)
    .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
    .replace('#include <map_fragment>', FRAG_SPLAT)
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
    .replace('#include <normal_fragment_begin>', 'float faceDirection = gl_FrontFacing ? 1.0 : -1.0; vec3 normal = normalize((viewMatrix * vec4(tN, 0.0)).xyz); vec3 nonPerturbedNormal = normal;')
    .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += tEmis;')
    .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= tAO;');
}
