import * as THREE from 'three';
import { fbm, mulberry32 } from '../core/Noise.js';

/**
 * Procedural canvas textures for VFX. All grayscale masks (rgb = a = intensity), colored in shaders.
 *   makeAtlas()  -> { texture, cols:4, rows:3 }  tiles: 0 glow, 1 spark, 2 smoke, 3 ring, 4 star, 5 rune, 6 dirt, 7 flare, 8 smoke2
 *   makeDecals() -> 2x1 atlas: 0 bullet hole, 1 scorch
 *   makeSigil()  -> 512px rune circle (sigil/heal/levelup ground glyphs)
 */
export const TEX = { GLOW: 0, SPARK: 1, SMOKE: 2, RING: 3, STAR: 4, RUNE: 5, DIRT: 6, FLARE: 7, SMOKE2: 8 };
const T = 256; // tile size

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// fill tile (cx, cy in tiles) of ctx using f(x, y, r) -> intensity 0..1, x/y in -1..1
function fillTile(ctx, tx, ty, f, size = T) {
  const img = ctx.createImageData(size, size), d = img.data;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = (i + 0.5) / size * 2 - 1, y = (j + 0.5) / size * 2 - 1;
    const v = Math.round(clamp01(f(x, y, Math.hypot(x, y))) * 255);
    const o = (j * size + i) * 4; d[o] = d[o + 1] = d[o + 2] = d[o + 3] = v;
  }
  ctx.putImageData(img, tx * size, ty * size);
}
function tex(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.flipY = false; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4; t.colorSpace = THREE.NoColorSpace;
  return t;
}
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

export function makeAtlas(seed = 1) {
  const c = canvas(T * 4, T * 3), ctx = c.getContext('2d');
  const rnd = mulberry32(seed + 911);
  // 0 glow: soft gaussian
  fillTile(ctx, 0, 0, (x, y, r) => Math.exp(-r * r * 7) * sstep(1, 0.6, r));
  // 1 spark: hot core + halo (stretched along velocity in shader)
  fillTile(ctx, 1, 0, (x, y, r) => Math.exp(-r * r * 90) * 1.2 + 0.45 * Math.exp(-r * r * 9) * sstep(1, 0.5, r));
  // 2 smoke: fbm puff, wispy edge.
  // WAVE-3 INFERNAL BUG ("flat blurry grey sprite-quads with visible straight edges", _c3inf_vents.png):
  // the noisy edge term leaves ~0.29 alpha at r = 1, i.e. at the quad's edge MIDPOINTS, and the quad cuts
  // it off there — every large smoke sprite therefore had four dead-straight sides. The pool's own
  // silhouette rounding (Particles.js FRAG) only bites near the CORNERS (len 0.95..1.42), so it never saw
  // this. RIM is the fix and it belongs in the tile: a hard radial window that is 0 for every direction by
  // r = 1, so no smoke sprite anywhere in the game can ever paint its own border.
  const RIM = (r) => sstep(1.0, 0.74, r);
  fillTile(ctx, 2, 0, (x, y, r) => {
    const n = fbm(x * 2.2 + 7.1, y * 2.2 - 3.3, { octaves: 5, seed: seed + 3 }) * 0.5 + 0.5;
    const n2 = fbm(x * 6 - 2, y * 6 + 5, { octaves: 3, seed: seed + 9 }) * 0.5 + 0.5;
    const edge = sstep(1.0, 0.35, r + 0.45 * (n - 0.5) + 0.12 * (n2 - 0.5));
    return edge * clamp01(0.25 + 0.85 * n + 0.25 * n2 - 0.25 * r) * RIM(r);
  });
  // 3 ring: crisp bright band + faint inner haze
  fillTile(ctx, 3, 0, (x, y, r) => { const d = (r - 0.62) / 0.08; return Math.exp(-d * d) + 0.18 * Math.exp(-(((r - 0.45) / 0.2) ** 2)) * sstep(0.9, 0.5, r); });
  // 4 star: 4-point sparkle + faint diagonals
  fillTile(ctx, 0, 1, (x, y, r) => {
    const core = Math.exp(-r * r * 45);
    const arm = (u, v) => Math.exp(-Math.abs(v) * 28) * Math.exp(-Math.abs(u) * 4.2) * sstep(1, 0.7, r);
    const s = Math.SQRT1_2, dx = (x + y) * s, dy = (y - x) * s;
    return core + arm(x, y) + arm(y, x) + 0.35 * (arm(dx, dy) + arm(dy, dx));
  });
  // 5 rune: small glyph (drawn with canvas strokes + glow)
  {
    const g = canvas(T, T), gc = g.getContext('2d');
    gc.strokeStyle = '#fff'; gc.fillStyle = '#fff'; gc.lineCap = 'round'; gc.lineWidth = 7; gc.shadowColor = '#fff'; gc.shadowBlur = 14;
    gc.beginPath(); gc.arc(T / 2, T / 2, T * 0.34, 0, Math.PI * 2); gc.stroke();
    for (let k = 0; k < 4; k++) { const a0 = rnd() * 6.283, a1 = a0 + 1.5 + rnd() * 2.5, rr = T * (0.12 + rnd() * 0.22); gc.beginPath(); gc.moveTo(T / 2 + Math.cos(a0) * rr, T / 2 + Math.sin(a0) * rr); gc.lineTo(T / 2 + Math.cos(a1) * rr, T / 2 + Math.sin(a1) * rr); gc.stroke(); }
    gc.beginPath(); gc.arc(T / 2, T / 2, 9, 0, 6.283); gc.fill();
    ctx.drawImage(g, T * 1, T * 1);
  }
  // 6 dirt: irregular hard-edged chunk (alpha-blended debris, dust bits)
  { const k1 = rnd() * 6.28, k2 = rnd() * 6.28, k3 = rnd() * 6.28;
    fillTile(ctx, 2, 1, (x, y, r) => { const ang = Math.atan2(y, x); const R = 0.55 + 0.22 * Math.sin(3 * ang + k1) + 0.12 * Math.sin(5 * ang + k2) + 0.08 * Math.sin(9 * ang + k3);
      return sstep(R + 0.025, R - 0.025, r) * (0.55 + 0.45 * sstep(-1, 1, x * 0.8 + y * 0.6)); }); }
  // 7 flare: crisp 4-petal muzzle star — thin long arms + faint diagonals + hot core (Destiny hand-cannon signature)
  fillTile(ctx, 3, 1, (x, y, r) => {
    const arm = (u, w) => Math.exp(-(u * u * 2.0 + w * w * 300)) * sstep(1, 0.72, r);
    const s2 = Math.SQRT1_2, dx = (x + y) * s2, dy = (y - x) * s2;
    return arm(x, y) + arm(y, x) + 0.35 * (arm(dx, dy) + arm(dy, dx)) + 1.4 * Math.exp(-r * r * 30);
  });
  // 8 smoke2: the SECOND billow. One smoke tile stamped 40 times up a column reads as one sprite repeated,
  // which is half of why the plumes read as smudges; alternating two silhouettes (this one is lobed and
  // cauliflower-edged rather than wispy) plus random per-particle rotation is what makes a column churn.
  fillTile(ctx, 0, 2, (x, y, r) => {
    const a = Math.atan2(y, x);
    const lobe = 0.60 + 0.15 * Math.sin(3 * a + 1.7) + 0.10 * Math.sin(5 * a - 0.6) + 0.06 * Math.sin(8 * a + 2.9);
    const n = fbm(x * 3.1 - 4.2, y * 3.1 + 1.9, { octaves: 4, seed: seed + 21 }) * 0.5 + 0.5;
    const R = lobe + 0.22 * (n - 0.5);
    return sstep(R + 0.14, R - 0.40, r) * clamp01(0.32 + 0.78 * n - 0.30 * r) * RIM(r);
  });
  // layout (index = col + row*4): glow(0,0) spark(1,0) smoke(2,0) ring(3,0) | star(0,1) rune(1,1) dirt(2,1) flare(3,1) | smoke2(0,2)
  return { texture: tex(c), cols: 4, rows: 3 };
}

export function makeDecals(seed = 1) {
  const c = canvas(T * 2, T), ctx = c.getContext('2d');
  const rnd = mulberry32(seed + 313);
  // 0 bullet hole. Wave-6 verdict on the old one: "a huge pure-black soft radial blob — no crater, no rim"
  // — its 0.5-alpha halo out to r 0.55 was most of the footprint, so at any distance the mips averaged the
  // whole tile into one soft dark disc. Now the alpha lives in STRUCTURE: a small hard pit, a ragged
  // HALF-strength lip ring around it (reads as chipped stone, not a shadow), and thin tapering fracture
  // streaks with bare surface showing between them — so the mark reads as a crater at 2 m and shrinks to a
  // crisp dot at range instead of a smudge.
  { const cracks = []; for (let k = 0; k < 8; k++) cracks.push([rnd() * 6.283, 0.34 + rnd() * 0.42, 0.014 + rnd() * 0.016]);
    fillTile(ctx, 0, 0, (x, y, r) => {
      const n = fbm(x * 5, y * 5, { octaves: 3, seed: seed + 5 }) * 0.5 + 0.5;
      let m = sstep(0.20 + 0.06 * (n - 0.5), 0.08, r);                                             // small dark pit
      m = Math.max(m, 0.42 * sstep(0.40, 0.18, r + 0.24 * (n - 0.5)) * sstep(0.10, 0.20, r));      // chipped lip: lighter, ragged, gone by r~0.4
      const ang = Math.atan2(y, x);
      for (const [a, len, w] of cracks) { const da = Math.abs(((ang - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI); const d = da * r; if (r < len) m = Math.max(m, 0.85 * sstep(w * 1.6, 0, d) * (1 - r / len) * (0.5 + 0.8 * n)); }
      return m;
    }); }
  // 1 scorch: fbm blotch with streaks
  fillTile(ctx, 1, 0, (x, y, r) => {
    const n = fbm(x * 3 + 1, y * 3 - 2, { octaves: 5, seed: seed + 8 }) * 0.5 + 0.5;
    const ang = Math.atan2(y, x); const streak = 0.5 + 0.5 * Math.sin(ang * 9 + n * 6);
    return Math.min(1, sstep(0.98, 0.25, r + 0.4 * (n - 0.5) + 0.12 * streak) * (0.55 + 0.45 * n) * sstep(0.9, 0.0, r * 0.4) + 0.6 * sstep(0.5, 0.0, r));
  });
  return { texture: tex(c), cols: 2, rows: 1 };
}

export function makeSigil(seed = 1) {
  const S = 512, c = canvas(S, S), g = c.getContext('2d'), rnd = mulberry32(seed + 777), cx = S / 2;
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round'; g.shadowColor = '#fff'; g.shadowBlur = 10;
  const ring = (r, w) => { g.lineWidth = w; g.beginPath(); g.arc(cx, cx, r * S / 2, 0, 6.2832); g.stroke(); };
  ring(0.94, 5); ring(0.80, 3); ring(0.62, 2); ring(0.42, 4); ring(0.14, 3);
  // outer band runes
  g.lineWidth = 4;
  for (let k = 0; k < 24; k++) { const a = k / 24 * 6.2832, r0 = 0.82 * S / 2, r1 = 0.92 * S / 2; const n = 1 + (rnd() * 3 | 0);
    for (let s = 0; s < n; s++) { const a2 = a + (rnd() - 0.5) * 0.16, ra = r0 + rnd() * (r1 - r0), rb = r0 + rnd() * (r1 - r0), a3 = a2 + (rnd() - 0.5) * 0.14;
      g.beginPath(); g.moveTo(cx + Math.cos(a2) * ra, cx + Math.sin(a2) * ra); g.lineTo(cx + Math.cos(a3) * rb, cx + Math.sin(a3) * rb); g.stroke(); } }
  // star polygon (hexagram) between r 0.62 and inner
  g.lineWidth = 3;
  for (let tri = 0; tri < 2; tri++) { g.beginPath(); for (let k = 0; k < 3; k++) { const a = tri * Math.PI / 3 + k * 2.0944 - Math.PI / 2, r = 0.62 * S / 2; k ? g.lineTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r) : g.moveTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r); } g.closePath(); g.stroke(); }
  // nodes + spokes
  for (let k = 0; k < 6; k++) { const a = k * 1.0472 - Math.PI / 2, r = 0.62 * S / 2; g.beginPath(); g.arc(cx + Math.cos(a) * r, cx + Math.sin(a) * r, 9, 0, 6.2832); g.fill();
    g.lineWidth = 2; g.beginPath(); g.moveTo(cx + Math.cos(a) * 0.14 * S / 2, cx + Math.sin(a) * 0.14 * S / 2); g.lineTo(cx + Math.cos(a) * 0.42 * S / 2, cx + Math.sin(a) * 0.42 * S / 2); g.stroke(); }
  g.beginPath(); g.arc(cx, cx, 12, 0, 6.2832); g.fill();
  // soft center haze
  const grd = g.createRadialGradient(cx, cx, 0, cx, cx, S * 0.47); grd.addColorStop(0, 'rgba(255,255,255,0.10)'); grd.addColorStop(0.7, 'rgba(255,255,255,0.02)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.shadowBlur = 0; g.fillStyle = grd; g.fillRect(0, 0, S, S);
  return tex(c);
}
