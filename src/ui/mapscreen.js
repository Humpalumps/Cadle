// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Cadle via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: UI agent. The map screen: cached parchment hillshade + zoom/pan, fog of war,
// scale bar, waypoints and markers that read at a glance.
// The hillshade is built ONCE into paperCv and only ever blitted after that — nothing
// per-frame touches heightAt().
import { C, clamp } from './theme.js';

const PN = 512;                       // hillshade resolution (built once)
const FOG_N = 128;                    // fog-of-war grid
const REVEAL = 115;                   // world units the player uncovers as they walk

let paperCv = null;
let fog = null, fogCv = null, fogDirty = true;
let wired = null;

export const view = { zoom: 1, cx: 0, cz: 0 };
export let waypoint = null;

const sizeOf = (ctx) => (ctx.world && ctx.world.size) || 2048;
const NICE = [5, 10, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

export function reset() { view.zoom = 1; view.cx = 0; view.cz = 0; }

// ---------------------------------------------------------------- the parchment
// Built lazily on first open, then cached forever. ~0.2s of heightAt() once.
/** Build the cached parchment sheet.
 *  `budgetMs > 0` slices the work across calls and returns false until it is finished — the HUD minimap
 *  builds it that way, because the 512x512 heightAt() pass is ~1 s of blocking JS and a boot-time hitch
 *  that size shows up as a p99 spike in the perf report. The map screen (M) still calls build(ctx) with
 *  no budget: by then a single blocking pass is what the player is waiting for anyway.
 */
let bs = null;                          // in-progress slice state
export function build(ctx, budgetMs = 0) {
  if (paperCv) return true;
  const N = PN;
  const size = sizeOf(ctx), half = size / 2;
  const wl = ctx.world.waterLevel || 0;
  const t0 = performance.now();
  const over = () => budgetMs > 0 && performance.now() - t0 > budgetMs;
  if (!bs) bs = { hs: new Float32Array(N * N), row: 0, prow: 0, img: null };
  while (bs.row < N) {
    const j = bs.row, z = -half + (j + 0.5) / N * size;
    for (let i = 0; i < N; i++) bs.hs[j * N + i] = ctx.world.heightAt(-half + (i + 0.5) / N * size, z);
    bs.row++;
    if (over()) return false;
  }
  const hs = bs.hs;
  bs.img ??= new ImageData(N, N);
  const d = bs.img.data;
  while (bs.prow < N) {
    const j = bs.prow;
    for (let i = 0; i < N; i++) {
      const o = j * N + i;
      const h = hs[o];
      const hx = hs[j * N + Math.min(N - 1, i + 1)] - h;
      const hz = hs[Math.min(N - 1, j + 1) * N + i] - h;
      const sh = clamp(0.5 + (hz - hx) * 0.30, 0, 1);       // hillshade, light from NW
      let r, g, b;
      if (h <= wl) {
        // Inked water, not app-blue: a cool grey-green wash under ruled engraver's
        // hatching that breaks up like a pen line. Shorelines get their own ink edge.
        const k = clamp((wl - h) / 26, 0, 1);
        r = 181 - 50 * k; g = 187 - 52 * k; b = 168 - 44 * k;
        if (j % 4 === 0) {
          const brk = ((i * 7 + j * 13) % 23) / 23;
          if (brk > 0.18 + 0.5 * k) { r -= 27; g -= 26; b -= 22; }
        }
        const shore = (hs[j * N + Math.max(0, i - 1)] > wl) || (hs[j * N + Math.min(N - 1, i + 1)] > wl)
          || (hs[Math.max(0, j - 1) * N + i] > wl) || (hs[Math.min(N - 1, j + 1) * N + i] > wl);
        if (shore) { r -= 46; g -= 44; b -= 38; }
      } else {
        const e = clamp((h - wl) / 95, 0, 1);
        r = 214 - e * 26 + (sh - 0.5) * 74;
        g = 194 - e * 44 + (sh - 0.5) * 68;
        b = 150 - e * 58 + (sh - 0.5) * 58;
        // contours only where one line means one contour; on cliffs they alias to speckle
        const slope = Math.max(Math.abs(hx), Math.abs(hz));
        if (slope < 7) {
          const band = ((h % 12) + 12) % 12;
          const k = Math.max(0, 1 - band / (0.6 + slope * 0.35));
          r -= 34 * k; g -= 33 * k; b -= 27 * k;
        }
      }
      const q = o * 4;
      d[q] = clamp(r, 0, 255); d[q + 1] = clamp(g, 0, 255); d[q + 2] = clamp(b, 0, 255); d[q + 3] = 255;
    }
    bs.prow++;
    if (over()) return false;
  }
  paperCv = document.createElement('canvas');
  paperCv.width = paperCv.height = N;
  const t = paperCv.getContext('2d');
  t.putImageData(bs.img, 0, 0);
  bs = null;
  // parchment wash: the sheet is older and browner toward its edges
  t.globalCompositeOperation = 'multiply';
  const vg = t.createRadialGradient(N / 2, N / 2, N * 0.30, N / 2, N / 2, N * 0.74);
  vg.addColorStop(0, 'rgba(255,255,255,1)');
  vg.addColorStop(1, 'rgba(186,158,110,1)');
  t.fillStyle = vg; t.fillRect(0, 0, N, N);
  t.globalCompositeOperation = 'source-over';
  return true;
}

// ---------------------------------------------------------------- fog of war
// Stamped from screens.update(), i.e. only while the player is actually walking.
/** The cached parchment hillshade (null until build() has run) + its resolution — the HUD minimap
 *  blits a window out of the same sheet instead of generating a second one. */
export const sheet = () => paperCv;
export const sheetRes = PN;

export function stamp(ctx) {
  if (!fog) { fog = new Uint8Array(FOG_N * FOG_N); fogDirty = true; }
  const size = sizeOf(ctx), half = size / 2;
  const p = ctx.player.position;
  const cell = size / FOG_N;
  const rad = Math.ceil(REVEAL / cell);
  const ci = Math.floor((p.x + half) / cell), cj = Math.floor((p.z + half) / cell);
  for (let j = cj - rad; j <= cj + rad; j++) {
    if (j < 0 || j >= FOG_N) continue;
    for (let i = ci - rad; i <= ci + rad; i++) {
      if (i < 0 || i >= FOG_N) continue;
      if ((i - ci) * (i - ci) + (j - cj) * (j - cj) > rad * rad) continue;
      const k = j * FOG_N + i;
      if (!fog[k]) { fog[k] = 1; fogDirty = true; }
    }
  }
}

function fogImage() {
  if (!fogCv) { fogCv = document.createElement('canvas'); fogCv.width = fogCv.height = FOG_N; }
  if (!fogDirty || !fog) return fogCv;
  const g = fogCv.getContext('2d');
  const img = g.createImageData(FOG_N, FOG_N);
  const d = img.data;
  // Unwalked ground is a pale vellum WASH, not a blackout — the hillshade is the best thing
  // on this sheet and must still read underneath. Walked ground comes up to full contrast.
  for (let k = 0; k < fog.length; k++) {
    const q = k * 4;
    d[q] = 232; d[q + 1] = 216; d[q + 2] = 175;
    d[q + 3] = fog[k] ? 0 : 150;
  }
  g.putImageData(img, 0, 0);
  fogDirty = false;
  return fogCv;
}

// ---------------------------------------------------------------- view maths
function clampView(ctx) {
  const size = sizeOf(ctx), half = size / 2;
  view.zoom = clamp(view.zoom, 1, 14);
  const vis = size / view.zoom, h = vis / 2;
  if (vis >= size) { view.cx = 0; view.cz = 0; return; }
  view.cx = clamp(view.cx, -half + h, half - h);
  view.cz = clamp(view.cz, -half + h, half - h);
}

function frameOf(ctx, W) {
  clampView(ctx);
  const size = sizeOf(ctx), vis = size / view.zoom;
  const s = W / vis;                                   // screen px per world unit
  return { size, vis, s, x0: view.cx - vis / 2, z0: view.cz - vis / 2 };
}

export function screenToWorld(ctx, cv, px, py) {
  const W = cv.clientWidth || cv.width;
  const f = frameOf(ctx, W);
  return { x: f.x0 + px / W * f.vis, z: f.z0 + py / W * f.vis };
}

// ---------------------------------------------------------------- markers
function chevron(g, size) {
  g.beginPath();
  g.moveTo(0, -size); g.lineTo(size * 0.72, size * 0.78);
  g.lineTo(0, size * 0.34); g.lineTo(-size * 0.72, size * 0.78);
  g.closePath();
}

function saltire(g, r) {                                // foe: an X, not a dot
  g.beginPath();
  g.moveTo(-r, -r); g.lineTo(r, r);
  g.moveTo(r, -r); g.lineTo(-r, r);
}

// ---------------------------------------------------------------- draw
// The sheet is square but its box is whatever the viewport left over. Sizing the canvas
// here (rather than with aspect-ratio in CSS) is the only way it can never grow the box
// it is measured against — which is what pushed the legend off the card at short heights.
function fitCanvas(cv) {
  const box = cv.parentElement;
  if (!box) return;
  const s = Math.max(120, Math.min(box.clientWidth, box.clientHeight) - 2);
  if (cv._fit !== s) { cv._fit = s; cv.style.width = cv.style.height = s + 'px'; }
}

export function draw(ctx, cv) {
  if (!paperCv || !cv) return;
  fitCanvas(cv);
  const cssW = cv.clientWidth || 300;
  const want = Math.max(240, Math.min(1400, Math.round(cssW * Math.min(2, devicePixelRatio || 1))));
  if (cv.width !== want) { cv.width = cv.height = want; }
  const g = cv.getContext('2d');
  const W = cv.width;
  const f = frameOf(ctx, W);
  const toX = (x) => (x - f.x0) * (W / f.vis);
  const toY = (z) => (z - f.z0) * (W / f.vis);
  const S = W / f.vis;

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, W);

  // the cached sheet, blitted through the view window
  const sx = (f.x0 + f.size / 2) / f.size * PN, sw = f.vis / f.size * PN;
  const sy = (f.z0 + f.size / 2) / f.size * PN;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(paperCv, sx, sy, sw, sw, 0, 0, W, W);

  // fog of war — uncharted ground is blank vellum, not black
  if (fog) {
    const fi = fogImage();
    const fsx = (f.x0 + f.size / 2) / f.size * FOG_N, fsw = f.vis / f.size * FOG_N;
    const fsy = (f.z0 + f.size / 2) / f.size * FOG_N;
    g.drawImage(fi, fsx, fsy, fsw, fsw, 0, 0, W, W);
  }

  // graticule at a round world spacing, so it stays crisp at every zoom
  const step = NICE.find(n => n * S > W * 0.11) || 2000;
  g.strokeStyle = 'rgba(90,68,32,.20)'; g.lineWidth = 1;
  g.beginPath();
  for (let x = Math.ceil(f.x0 / step) * step; x < f.x0 + f.vis; x += step) {
    const px = Math.round(toX(x)) + 0.5; g.moveTo(px, 0); g.lineTo(px, W);
  }
  for (let z = Math.ceil(f.z0 / step) * step; z < f.z0 + f.vis; z += step) {
    const py = Math.round(toY(z)) + 0.5; g.moveTo(0, py); g.lineTo(W, py);
  }
  g.stroke();

  const k = W / 620;                                    // marker scale, tuned at 620px
  const inView = (x, z, m) => x > f.x0 - m && x < f.x0 + f.vis + m && z > f.z0 - m && z < f.z0 + f.vis + m;

  // ---- landmarks: always on the sheet and always iconed — a map of anonymous shapes sells no
  // destination (feel audit). Outer-region landmarks (l.biome) carry their region name and label at
  // every zoom; the six Vale POIs label from zoom 2 up so their names don't pile onto the home bowl
  // when the whole world is in frame. (The old fog/quest-discovery gate hid everything for hours.)
  for (const l of (ctx.world.landmarks || ctx.rpg && ctx.rpg.landmarks || [])) {
    const p = l.position || l.pos || l;
    if (typeof p.x !== 'number') continue;
    if (!inView(p.x, p.z, 60 / S)) continue;
    const x = toX(p.x), y = toY(p.z);
    g.save(); g.translate(x, y);
    g.rotate(Math.PI / 4);
    g.fillStyle = C.gold; g.strokeStyle = 'rgba(50,36,14,.85)'; g.lineWidth = 1.3 * k;
    const s = 5 * k;
    g.fillRect(-s, -s, s * 2, s * 2); g.strokeRect(-s, -s, s * 2, s * 2);
    g.rotate(-Math.PI / 4);
    if (l.biome || view.zoom >= 2) {
      const nm = l.name || l.label || l.id;
      g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.font = `${Math.round(12 * k)}px Georgia,serif`;
      g.lineWidth = 3 * k; g.strokeStyle = 'rgba(240,228,198,.85)';
      g.strokeText(nm, 0, -13 * k);
      g.fillStyle = 'rgba(40,30,14,.95)'; g.fillText(nm, 0, -13 * k);
      if (l.biome) {                              // the region the landmark anchors, small italic
        g.font = `italic ${Math.round(10 * k)}px Georgia,serif`;
        g.strokeText(l.biome, 0, 19 * k);
        g.fillStyle = 'rgba(96,66,28,.92)'; g.fillText(l.biome, 0, 19 * k);
      }
    }
    g.restore();
  }

  // ---- foes: a dark saltire with a pale halo. Reads as an X at any size, in greyscale,
  // and shares no shape with the player chevron or the landmark diamond.
  for (const e of (ctx.ai && ctx.ai.enemies) || []) {
    if (e.dead) continue;
    const p = e.position || (e.mesh && e.mesh.position);
    if (!p || !inView(p.x, p.z, 20 / S)) continue;
    const x = toX(p.x), y = toY(p.z), r = 5.5 * k;
    g.save(); g.translate(x, y);
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(244,232,204,.85)'; g.lineWidth = 4.2 * k; saltire(g, r); g.stroke();
    g.strokeStyle = '#5e1a14'; g.lineWidth = 2 * k; saltire(g, r); g.stroke();
    g.restore();
  }

  // ---- waypoint
  if (waypoint && inView(waypoint.x, waypoint.z, 30 / S)) {
    const x = toX(waypoint.x), y = toY(waypoint.z);
    g.save(); g.translate(x, y);
    g.strokeStyle = 'rgba(40,28,10,.85)'; g.lineWidth = 1.6 * k;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -15 * k); g.stroke();
    g.beginPath(); g.moveTo(0, -15 * k); g.lineTo(11 * k, -11 * k); g.lineTo(0, -7 * k); g.closePath();
    g.fillStyle = C.goldLt; g.fill(); g.stroke();
    g.beginPath(); g.arc(0, 0, 2.4 * k, 0, 7); g.fillStyle = 'rgba(40,28,10,.9)'; g.fill();
    g.restore();
  }

  // ---- the player: a big two-tone chevron with a cream keyline, plus a facing cone.
  // Deliberately ~2.5x a landmark and a different silhouette entirely.
  const pp = ctx.player.position, yaw = ctx.player.yaw || 0;
  const px = toX(pp.x), py = toY(pp.z);
  g.save();
  g.translate(px, py); g.rotate(-yaw);
  const coneR = 74 * k, half = 0.5;
  const a0 = -Math.PI / 2 - half, a1 = -Math.PI / 2 + half;
  const cone = g.createRadialGradient(0, 0, 5 * k, 0, 0, coneR);
  cone.addColorStop(0, 'rgba(211,165,72,.62)');
  cone.addColorStop(0.72, 'rgba(211,165,72,.22)');
  cone.addColorStop(1, 'rgba(211,165,72,0)');
  g.fillStyle = cone;
  g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, coneR, a0, a1); g.closePath(); g.fill();
  // a bright leading arc instead of a V of edge lines, which read as stray ink
  g.strokeStyle = 'rgba(211,165,72,.75)'; g.lineWidth = 2 * k;
  g.beginPath(); g.arc(0, 0, coneR * 0.94, a0 + 0.06, a1 - 0.06); g.stroke();

  g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 9 * k; g.shadowOffsetY = 1.5 * k;
  chevron(g, 20 * k);
  g.fillStyle = 'rgba(250,241,218,.97)'; g.fill();          // cream keyline
  g.shadowBlur = 0; g.shadowOffsetY = 0;
  chevron(g, 15 * k);
  g.fillStyle = C.blood; g.fill();
  g.strokeStyle = 'rgba(40,20,10,.9)'; g.lineWidth = 1.4 * k; g.stroke();
  g.restore();

  rose(g, W, k);
  scaleBar(ctx, g, W, k, S);
  legend(g, W, k);
}

// A four-row key, bottom-right (rose owns top-right, scale bar bottom-left): what a diamond, an X,
// the flag and the chevron each mean. Same glyph functions as the live markers so it cannot drift.
function legend(g, W, k) {
  const lh = 16 * k, pad = 8 * k, w = 96 * k, h = pad * 2 + 4 * lh;
  const x = W - w - 14 * k, y = W - h - 14 * k;
  g.save();
  g.fillStyle = 'rgba(240,228,198,.80)'; g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(90,68,32,.8)'; g.lineWidth = 1 * k; g.strokeRect(x, y, w, h);
  g.font = `${Math.round(10 * k)}px Georgia,serif`;
  g.textAlign = 'left'; g.textBaseline = 'middle';
  const gx = x + pad + 6 * k, tx = x + pad + 16 * k;
  let cy = y + pad + lh / 2;
  const label = (t) => { g.fillStyle = 'rgba(50,36,14,.95)'; g.fillText(t, tx, cy); cy += lh; };
  // you — the chevron
  g.save(); g.translate(gx, cy); chevron(g, 4.6 * k);
  g.fillStyle = C.blood; g.fill(); g.strokeStyle = 'rgba(40,20,10,.9)'; g.lineWidth = 0.9 * k; g.stroke();
  g.restore(); label('you');
  // landmark — the gold diamond
  g.save(); g.translate(gx, cy); g.rotate(Math.PI / 4);
  g.fillStyle = C.gold; g.strokeStyle = 'rgba(50,36,14,.85)'; g.lineWidth = 1 * k;
  g.fillRect(-3.4 * k, -3.4 * k, 6.8 * k, 6.8 * k); g.strokeRect(-3.4 * k, -3.4 * k, 6.8 * k, 6.8 * k);
  g.restore(); label('landmark');
  // objective — the waypoint flag (the tracked quest plants it)
  g.save(); g.translate(gx - 1 * k, cy + 4 * k);
  g.strokeStyle = 'rgba(40,28,10,.85)'; g.lineWidth = 1.1 * k;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -9 * k); g.stroke();
  g.beginPath(); g.moveTo(0, -9 * k); g.lineTo(6.5 * k, -6.6 * k); g.lineTo(0, -4.2 * k); g.closePath();
  g.fillStyle = C.goldLt; g.fill(); g.stroke();
  g.restore(); label('objective');
  // foe — the saltire
  g.save(); g.translate(gx, cy); g.lineCap = 'round';
  g.strokeStyle = 'rgba(244,232,204,.85)'; g.lineWidth = 3 * k; saltire(g, 3.6 * k); g.stroke();
  g.strokeStyle = '#5e1a14'; g.lineWidth = 1.4 * k; saltire(g, 3.6 * k); g.stroke();
  g.restore(); label('foe');
  g.restore();
}

function rose(g, W, k) {
  const R = 26 * k;
  g.save();
  g.translate(W - R - 20 * k, R + 20 * k);
  g.beginPath(); g.arc(0, 0, R * 1.24, 0, 7);
  g.fillStyle = 'rgba(240,228,198,.66)'; g.fill();
  g.strokeStyle = 'rgba(90,68,32,.9)'; g.lineWidth = 1.4 * k;
  g.beginPath(); g.arc(0, 0, R * 0.92, 0, 7); g.stroke();
  g.lineWidth = 1.1 * k;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, L = i % 2 ? R * 0.44 : R * 0.84;
    g.beginPath();
    g.moveTo(Math.cos(a) * R * 0.12, Math.sin(a) * R * 0.12);
    g.lineTo(Math.cos(a) * L, Math.sin(a) * L);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(0, -R * 0.84); g.lineTo(R * 0.18, -R * 0.16); g.lineTo(-R * 0.18, -R * 0.16); g.closePath();
  g.fillStyle = C.blood; g.fill();
  g.strokeStyle = 'rgba(50,30,14,.85)'; g.lineWidth = 1 * k; g.stroke();
  g.fillStyle = 'rgba(50,36,14,.95)';
  g.font = `${Math.round(11 * k)}px Georgia,serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('N', 0, -R * 1.06);
  g.restore();
}

function scaleBar(ctx, g, W, k, S) {
  const want = W * 0.22;
  const m = NICE.find(n => n * S >= want) || NICE[NICE.length - 1];
  const len = m * S;
  const x = 18 * k, y = W - 20 * k;
  g.save();
  g.lineWidth = 3 * k; g.strokeStyle = 'rgba(244,232,204,.8)';
  g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y); g.stroke();
  g.lineWidth = 1.5 * k; g.strokeStyle = 'rgba(40,28,10,.9)';
  g.beginPath();
  g.moveTo(x, y - 5 * k); g.lineTo(x, y + 3 * k);
  g.moveTo(x, y); g.lineTo(x + len, y);
  g.moveTo(x + len / 2, y - 3 * k); g.lineTo(x + len / 2, y + 2 * k);
  g.moveTo(x + len, y - 5 * k); g.lineTo(x + len, y + 3 * k);
  g.stroke();
  g.font = `${Math.round(11 * k)}px Georgia,serif`;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.lineWidth = 3 * k; g.strokeStyle = 'rgba(244,232,204,.85)';
  g.strokeText(m + ' m', x, y - 8 * k);
  g.fillStyle = 'rgba(40,30,14,.95)';
  g.fillText(m + ' m', x, y - 8 * k);
  g.restore();
}

// ---------------------------------------------------------------- interaction
export function attach(ctx, cv, say) {
  if (wired === cv) return;
  wired = cv;
  let drag = null;

  const zoomAt = (px, py, mul) => {
    const W = cv.clientWidth || 1;
    const before = screenToWorld(ctx, cv, px, py);
    view.zoom = clamp(view.zoom * mul, 1, 14);
    clampView(ctx);
    const after = screenToWorld(ctx, cv, px, py);
    view.cx += before.x - after.x;
    view.cz += before.z - after.z;
    clampView(ctx);
    say && say(readout(ctx));
  };

  cv.addEventListener('wheel', (e) => {
    e.preventDefault(); e.stopPropagation();
    const r = cv.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.18 : 1 / 1.18);
  }, { passive: false });

  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, cx: view.cx, cz: view.cz, moved: 0, px: e.clientX - r.left, py: e.clientY - r.top };
    cv.focus();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const W = cv.clientWidth || 1;
    const perPx = (sizeOf(ctx) / view.zoom) / W;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    view.cx = drag.cx - dx * perPx;
    view.cz = drag.cz - dy * perPx;
    clampView(ctx);
  });
  const end = (e) => {
    if (!drag) return;
    if (drag.moved < 4) setWaypoint(ctx, screenToWorld(ctx, cv, drag.px, drag.py), say);
    drag = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);

  cv.addEventListener('keydown', (e) => {
    const pan = (sizeOf(ctx) / view.zoom) * 0.14;
    let hit = true;
    switch (e.code) {
      case 'ArrowLeft': view.cx -= pan; break;
      case 'ArrowRight': view.cx += pan; break;
      case 'ArrowUp': view.cz -= pan; break;
      case 'ArrowDown': view.cz += pan; break;
      case 'Equal': case 'NumpadAdd': zoomAt(cv.clientWidth / 2, cv.clientWidth / 2, 1.3); break;
      case 'Minus': case 'NumpadSubtract': zoomAt(cv.clientWidth / 2, cv.clientWidth / 2, 1 / 1.3); break;
      case 'Digit0': case 'Home': reset(); break;
      case 'Enter': case 'Space': setWaypoint(ctx, { x: view.cx, z: view.cz }, say); break;
      case 'Delete': case 'Backspace': waypoint = null; say && say('waypoint cleared'); break;
      case 'KeyC': centreOnPlayer(ctx); break;
      default: hit = false;
    }
    if (hit) { e.preventDefault(); e.stopPropagation(); clampView(ctx); say && say(readout(ctx)); }
  });
}

export function centreOnPlayer(ctx) {
  view.zoom = Math.max(view.zoom, 3.2);
  view.cx = ctx.player.position.x; view.cz = ctx.player.position.z;
  clampView(ctx);
}

export function zoomBy(ctx, mul, say) {
  view.zoom = clamp(view.zoom * mul, 1, 14);
  clampView(ctx);
  say && say(readout(ctx));
}

export function setWaypoint(ctx, w, say) {
  waypoint = { x: Math.round(w.x), z: Math.round(w.z) };
  say && say(readout(ctx));
}
export function clearWaypoint(say) { waypoint = null; say && say('waypoint cleared'); }

export function readout(ctx) {
  const p = ctx.player.position;
  let s = 'zoom ' + view.zoom.toFixed(1) + '×  ·  you are at ' + Math.round(p.x) + ', ' + Math.round(p.z);
  if (waypoint) {
    const d = Math.round(Math.hypot(waypoint.x - p.x, waypoint.z - p.z));
    s += '  ·  waypoint ' + waypoint.x + ', ' + waypoint.z + ' — ' + d + ' m away';
  }
  return s;
}
