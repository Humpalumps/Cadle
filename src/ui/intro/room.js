// room.js — the cinematic loading-screen bedroom (dark, night, lit by monitor + moonlight).
//
// Contract:
//   buildRoom({ rng, tex }) -> { group, screen, materials, update(t), dispose() }
//   tex is the intro texture set loaded by stage.js (plaster/wood/rug/leather/posterCrystal/
//   posterRuins, any of them possibly null). stage.js owns and disposes the originals; we only
//   own the per-surface CLONES we make for their `repeat`, and the canvases we draw ourselves.
//   rng() is a deterministic mulberry32 float in [0,1). NEVER Math.random().
//
// Geometry is 100% procedural and so is every texture stage.js could not hand us: this module runs
// BEFORE the asset preloader, so it never fetches anything itself. Each canvas fallback is only
// DRAWN when its real texture is missing, so the normal path pays nothing for them.
//
// Lighting is the ORCHESTRATOR's job (monitor rect-area light, moonlight, ambient). We own at most
// FOUR small PointLights that are part of props (fairy string x2, keyboard underglow, aetheryte
// figurine), all intensity <= 2 with a distance set so they cannot wash the room.
//
// USER DECREE (CLAUDE.md): no washed-white glowing blobs. Every emissive here is a SATURATED hue at
// a CAPPED intensity (<= 1.0 on anything small), never 0xffffff, and nothing tiny is glossier than
// roughness 0.3 (point specular on sub-pixel geometry is the blob bug).
//
// World coords (metres, Y up, -Z into the back wall):
//   floor y=0, ceiling y=2.6, back wall z=-1.10, side walls x=+-2.30
//   desk top y=0.745 over x[-0.95,0.95] z[-1.05,-0.30]
//   screen plane 0.868 x 0.49 centred (0, 1.21, -0.945), normal +Z, tilted back 4 deg
//   window opening x[-1.96,-1.04] y[1.00,1.98] in the BACK wall, left of the monitor
//   KEEP-OUT (camera flight path): z > 0.85 && |x| < 1.5 && y < 1.95 — floor and rug only.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function buildRoom({ rng, tex = {} }) {
  const group = new THREE.Group();
  group.name = 'introRoom';

  // ---- bookkeeping so dispose() is exact ---------------------------------------------------
  const geos = [];
  const mats = [];       // returned as `materials` (screen placeholder excluded)
  const texs = [];
  const G = (g) => { geos.push(g); return g; };
  const M = (m) => { mats.push(m); return m; };

  // ---- tiny helpers ------------------------------------------------------------------------
  const std = (o) => M(new THREE.MeshStandardMaterial(o));

  /** Draw into a canvas -> CanvasTexture. Keep sizes small; this runs on the loading screen. */
  function canvasTex(w, h, draw, opts = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = opts.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    if (opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
    t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.anisotropy = 8;
    texs.push(t);
    return t;
  }

  /** Axis-aligned box from world min/max — the whole room is built out of these, then merged. */
  function box(x0, x1, y0, y1, z0, z1) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return g;
  }

  /** Bake a transform into a geometry so it can be merged (box() only does axis-aligned). */
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  function at(g, x, y, z, rx = 0, ry = 0, rz = 0) {
    g.applyMatrix4(_m4.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s));
    return g;
  }

  function merged(list) {
    const g = mergeGeometries(list, false);
    list.forEach((x) => x.dispose());
    return G(g);
  }

  function add(geo, mat, { cast = false, receive = false, name = '' } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast; m.receiveShadow = receive;
    if (name) m.name = name;
    group.add(m);
    return m;
  }

  const rr = (a, b) => a + rng() * (b - a);

  // =========================================================================================
  // TEXTURES
  // =========================================================================================

  // --- dark oak floor: planks running along X, seams + grain, staggered end joints ---
  const drawPlanks = (c, S) => {
    const rows = 5, H = S / rows;
    c.fillStyle = '#3c2a1d'; c.fillRect(0, 0, S, S);
    for (let r = 0; r < rows; r++) {
      const y = r * H;
      const l = 0.78 + rng() * 0.45;                       // per-plank tone variation
      c.fillStyle = `rgb(${(100 * l) | 0},${(69 * l) | 0},${(47 * l) | 0})`;
      c.fillRect(0, y, S, H);
      // grain: long low-contrast wavy strokes
      c.lineWidth = 1;
      for (let i = 0; i < 11; i++) {
        const gy = y + 3 + rng() * (H - 6);
        c.strokeStyle = `rgba(${rng() < 0.5 ? 22 : 110},${rng() < 0.5 ? 14 : 80},8,${0.05 + rng() * 0.10})`;
        c.beginPath(); c.moveTo(0, gy);
        c.bezierCurveTo(S * 0.3, gy + rr(-3, 3), S * 0.7, gy + rr(-3, 3), S, gy + rr(-2, 2));
        c.stroke();
      }
      // end joints
      c.fillStyle = 'rgba(8,4,2,0.85)';
      for (let i = 0; i < 2; i++) c.fillRect((rng() * S) | 0, y + 1, 1.6, H - 2);
      // seam between planks (dark line + faint highlight on the near lip)
      c.fillStyle = 'rgba(6,3,1,0.9)'; c.fillRect(0, y, S, 1.6);
      c.fillStyle = 'rgba(150,110,70,0.05)'; c.fillRect(0, y + 2, S, 1);
    }
  };

  // --- wall plaster: very low contrast blotch, just enough to kill the flat-shader look ---
  const drawPlaster = (c, S) => {
    c.fillStyle = '#443d4e'; c.fillRect(0, 0, S, S);
    for (let i = 0; i < 90; i++) {
      const x = rng() * S, y = rng() * S, r = 8 + rng() * 46;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      const up = rng() < 0.5;
      g.addColorStop(0, up ? 'rgba(96,86,110,0.16)' : 'rgba(24,20,30,0.20)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
    }
  };

  // --- rug: deep indigo with a faint gold border ---
  const drawRug = (c, S) => {
    c.fillStyle = '#242252'; c.fillRect(0, 0, S, S);
    for (let i = 0; i < 140; i++) {                        // wool speckle
      const x = rng() * S, y = rng() * S, r = 10 + rng() * 60;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rng() < 0.5 ? 'rgba(74,68,140,0.12)' : 'rgba(12,10,34,0.14)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
    }
    c.strokeStyle = 'rgba(150,112,50,0.55)';
    c.lineWidth = 4; c.strokeRect(26, 26, S - 52, S - 52);
    c.lineWidth = 2; c.strokeRect(44, 44, S - 88, S - 88);
    // border motif: small diamonds marching between the two gold lines
    c.fillStyle = 'rgba(168,128,58,0.45)';
    const inset = 35, step = 26;
    for (let p = inset + 8; p < S - inset; p += step) {
      for (const [x, y] of [[p, inset], [p, S - inset], [inset, p], [S - inset, p]]) {
        c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x + 5, y); c.lineTo(x, y + 5); c.lineTo(x - 5, y); c.fill();
      }
    }
    // faint centre medallion
    const g2 = c.createRadialGradient(S / 2, S / 2, 10, S / 2, S / 2, 150);
    g2.addColorStop(0, 'rgba(126,96,44,0.16)'); g2.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g2; c.fillRect(0, 0, S, S);
  };

  /** Real texture -> a per-surface CLONE carrying its own repeat. `.repeat` lives on the Texture,
   *  not the material, and the same Texture object is shared with the character module — setting
   *  repeat on the original would re-tile his chair too. Null in, null out; caller falls back. */
  function useMap(t, rx, ry) {
    if (!t) return null;
    const c = t.clone();          // shares the GPU source, so this costs nothing to upload
    // The supplied maps are not actually seamless: wall_plaster is 94 vs 76 mean luma on its left
    // vs right edge (wood_floor 65 vs 47 top/bottom), so plain RepeatWrapping tiles them into a
    // visible checkerboard of value blocks. Mirrored wrapping makes every tile edge match its
    // neighbour by construction — free, and undetectable on a blotchy plaster or a dark plank.
    // ponytail: mirroring hides the seam, it does not remove the gradient. Upgrade path is a
    // properly de-lit tileable source (see ASSET ASK in the report), then this can go back to
    // RepeatWrapping.
    c.wrapS = c.wrapT = THREE.MirroredRepeatWrapping;
    c.repeat.set(rx, ry);
    texs.push(c);
    return c;
  }

  // --- night sky seen through the window: gradient, moon, stars, rooftops ---
  const skyTex = canvasTex(384, 384, (c, S) => {
    const g = c.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0.00, '#080a22');
    g.addColorStop(0.45, '#131a3f');
    g.addColorStop(0.78, '#2b2358');
    g.addColorStop(1.00, '#3d2f52');
    c.fillStyle = g; c.fillRect(0, 0, S, S);
    for (let i = 0; i < 220; i++) {                        // stars — pale violet, never white
      const x = rng() * S, y = rng() * S * 0.8, a = 0.12 + rng() * 0.5;
      c.fillStyle = `rgba(198,206,255,${a})`;
      c.fillRect(x, y, rng() < 0.12 ? 1.8 : 1, rng() < 0.12 ? 1.8 : 1);
    }
    const mx = S * 0.66, my = S * 0.24, mr = S * 0.055;     // moon + halo (cool, not white-hot)
    const halo = c.createRadialGradient(mx, my, mr * 0.7, mx, my, mr * 6);
    halo.addColorStop(0, 'rgba(138,158,224,0.26)'); halo.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = halo; c.beginPath(); c.arc(mx, my, mr * 6, 0, 6.283); c.fill();
    c.fillStyle = '#a9bce8'; c.beginPath(); c.arc(mx, my, mr, 0, 6.283); c.fill();
    c.fillStyle = 'rgba(150,158,196,0.35)';                // craters
    for (let i = 0; i < 5; i++) {
      const a = rng() * 6.283, d = rng() * mr * 0.6;
      c.beginPath(); c.arc(mx + Math.cos(a) * d, my + Math.sin(a) * d, mr * (0.1 + rng() * 0.16), 0, 6.283); c.fill();
    }
    // distant rooftops as a dark silhouette band along the bottom
    c.fillStyle = '#0a0817';
    let x = -10;
    while (x < S + 10) {
      const w = 18 + rng() * 46, h = 26 + rng() * 58;
      c.fillRect(x, S - h, w, h);
      if (rng() < 0.35) c.fillRect(x + w * 0.3, S - h - 12, 5, 12);   // chimney
      // a couple of lit windows, warm and tiny
      if (rng() < 0.5) {
        c.fillStyle = 'rgba(214,152,72,0.5)';
        c.fillRect(x + 5 + rng() * (w - 12), S - h + 8 + rng() * (h - 20), 3, 4);
        c.fillStyle = '#0a0817';
      }
      x += w;
    }
  }, { clamp: true });

  // --- two framed prints: abstract painterly fantasy, one gold emblem. No text. ---
  function posterTex(warm) {
    return canvasTex(256, 256, (c, S) => {
      c.fillStyle = warm ? '#1b1220' : '#101a2c'; c.fillRect(0, 0, S, S);
      for (let i = 0; i < 16; i++) {                       // soft painterly washes
        const x = rng() * S, y = rng() * S, r = 30 + rng() * 110;
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        const hue = warm ? [190, 132, 58] : [86, 74, 176];
        g.addColorStop(0, `rgba(${hue[0]},${hue[1]},${hue[2]},${0.05 + rng() * 0.13})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
      }
      if (warm) {                                          // gold emblem: ring + chevrons
        c.strokeStyle = 'rgba(190,146,66,0.75)'; c.lineWidth = 4;
        c.beginPath(); c.arc(S / 2, S * 0.48, S * 0.24, 0, 6.283); c.stroke();
        c.lineWidth = 3;
        for (let i = 0; i < 3; i++) {
          const o = i * 15;
          c.beginPath(); c.moveTo(S * 0.35, S * 0.56 + o); c.lineTo(S / 2, S * 0.44 + o); c.lineTo(S * 0.65, S * 0.56 + o); c.stroke();
        }
      } else {                                             // mountains + a violet aether column
        c.fillStyle = 'rgba(10,10,26,0.9)';
        c.beginPath(); c.moveTo(0, S); c.lineTo(S * 0.3, S * 0.42); c.lineTo(S * 0.55, S * 0.72);
        c.lineTo(S * 0.75, S * 0.36); c.lineTo(S, S); c.fill();
        const gg = c.createLinearGradient(S * 0.5, S * 0.1, S * 0.5, S);
        gg.addColorStop(0, 'rgba(126,88,220,0.42)'); gg.addColorStop(1, 'rgba(126,88,220,0)');
        c.fillStyle = gg; c.fillRect(S * 0.44, 0, S * 0.12, S);
      }
      c.fillStyle = 'rgba(0,0,0,0.28)';                    // vignette-ish edge darkening
      c.fillRect(0, 0, S, 10); c.fillRect(0, S - 10, S, 10); c.fillRect(0, 0, 10, S); c.fillRect(S - 10, 0, 10, S);
    }, { clamp: true });
  }

  // --- soft radial falloff, reused for the bias glow, the leaf cards and the dust sprite ---
  const softTex = canvasTex(64, 64, (c, S) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.00, 'rgb(255,255,255)');
    g.addColorStop(0.35, 'rgb(140,140,140)');
    g.addColorStop(0.70, 'rgb(30,30,30)');
    g.addColorStop(1.00, 'rgb(0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, S, S);
  }, { clamp: true, linear: true });

  // wall bias glow — additive so it fades to nothing instead of ending on an alpha cut
  // NOTE: the falloff must live in the COLOUR channels, not in canvas alpha — alphaMap samples .g,
  // and a canvas painted with rgba(255,255,255,a) still reads 1.0 green everywhere (that mistake
  // turns this into a flat violet disc with a hard edge).
  const biasTex = canvasTex(256, 256, (c, S) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.00, 'rgb(210,210,210)');
    g.addColorStop(0.22, 'rgb(150,150,150)');
    g.addColorStop(0.45, 'rgb(78,78,78)');
    g.addColorStop(0.68, 'rgb(32,32,32)');
    g.addColorStop(0.86, 'rgb(9,9,9)');
    g.addColorStop(1.00, 'rgb(0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, S, S);
  }, { clamp: true, linear: true });

  const leafTex = canvasTex(64, 64, (c, S) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
    c.fillStyle = '#fff';
    c.beginPath();
    c.moveTo(S / 2, S * 0.05);
    c.bezierCurveTo(S * 0.88, S * 0.30, S * 0.80, S * 0.82, S / 2, S * 0.97);
    c.bezierCurveTo(S * 0.20, S * 0.82, S * 0.12, S * 0.30, S / 2, S * 0.05);
    c.fill();
  }, { clamp: true, linear: true });

  // =========================================================================================
  // SHELL — floor, walls, ceiling, skirting, rug
  // =========================================================================================

  // Cool desaturated plaster. The monitor is the ONLY violet source in this room, so the paint itself
  // has to read blue-grey where the screen light does not reach — a warm/neutral map under a violet
  // rect-area light turns the whole wall magenta (the critic's #5).
  // repeat 2 x 1.2 (was 3 x 2): with MirroredRepeatWrapping every integer boundary is a mirror axis, so
  // 3 tiles across the wall put two hard mirror lines in frame — that was the vertical banding at the
  // corner. One mirror axis, hidden behind the monitor, is invisible.
  // AMBIENT BOUNCE, EXPRESSED PER-MATERIAL. The lighting rig is frozen and already at its ceiling,
  // yet the floor, the rug and the far corners were crushed to black (45 % of the shipping frame
  // under 12/255, the bottom-left corner averaging 5). A dark bedroom still has to show MATERIAL.
  // The lift is each surface's own albedo map fed back as an emissiveMap at a tiny, tinted
  // intensity: it scales WITH the texture, so the plank joints and the rug weave come up while the
  // seams stay dark. A flat ambient add would have greyed everything and erased the pattern —
  // which is the whole thing we are trying to make readable.
  // Safe by construction: ~0.01-0.02 linear on a big flat surface, two orders under the bloom
  // threshold, and every emissive tint is a saturated hue (never white — CLAUDE.md decree).
  const plasterMap = useMap(tex.plaster, 2, 1.2) || canvasTex(256, 256, drawPlaster, { repeat: [2, 1.2] });
  const woodFloorMap = useMap(tex.wood, 4, 4) || canvasTex(512, 512, drawPlanks, { repeat: [4.7, 4.3] });
  const wallMat = std({
    map: plasterMap, color: 0x7f8798, roughness: 0.96, metalness: 0,
    emissive: 0x4c5568, emissiveMap: plasterMap, emissiveIntensity: 0.60,
  });
  const floorMat = std({
    map: woodFloorMap, color: 0xffffff, roughness: 0.55, metalness: 0,
    emissive: 0x8a6242, emissiveMap: woodFloorMap, emissiveIntensity: 1.10,
  });

  // ponytail: box UVs are per-face 0..1 so the plaster tiles at slightly different scales on a
  // 4.3 m wall vs a 0.45 m strip. It is low-contrast noise in a dark room — invisible. Upgrade
  // path if it ever shows: per-face UV rescale before the merge.
  // WINDOW OPENING. It used to be cut into the LEFT wall (x = -2.30), which is outside the frustum in
  // every shipping framing — a whole window, moon and skyline built and never seen. It is now cut into
  // the BACK wall to the left of the monitor, where it fills the dead left third of the hero shot and
  // reads as the source of the rig's cool moonlight.
  const WIN = { x0: -1.96, x1: -1.04, y0: 1.00, y1: 1.98 };
  const WINCX = (WIN.x0 + WIN.x1) / 2, WINCY = (WIN.y0 + WIN.y1) / 2;
  const shell = [
    box(2.30, 2.34, 0.00, 2.60, -1.14, 3.20),              // right wall (surface x = +2.30)
    box(-2.34, -2.30, 0.00, 2.60, -1.14, 3.20),            // left wall (surface x = -2.30) — now solid
    box(-2.34, 2.34, 2.60, 2.64, -1.14, 3.20),             // ceiling
    // back wall (surface z = -1.10) built around the window opening
    box(-2.34, 2.34, 0.00, WIN.y0, -1.14, -1.10),
    box(-2.34, 2.34, WIN.y1, 2.60, -1.14, -1.10),
    box(-2.34, WIN.x0, WIN.y0, WIN.y1, -1.14, -1.10),
    box(WIN.x1, 2.34, WIN.y0, WIN.y1, -1.14, -1.10),
  ];
  add(merged(shell), wallMat, { receive: true, name: 'walls' });

  const floor = add(G(new THREE.PlaneGeometry(4.68, 4.34)), floorMat, { receive: true, name: 'floor' });
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 1.03);

  // skirting board — merged, one draw call, sits proud of the plaster
  const skirtMat = std({ color: 0x342e3d, roughness: 0.7, metalness: 0, emissive: 0x3a3450, emissiveIntensity: 0.16 });
  add(merged([
    box(-2.28, 2.28, 0.00, 0.105, -1.10, -1.078),
    box(-2.30, -2.278, 0.00, 0.105, -1.10, 3.20),
    box(2.278, 2.30, 0.00, 0.105, -1.10, 3.20),
  ]), skirtMat, { receive: true, name: 'skirting' });

  // roughness 0.86 (was 0.98): wool is matte, not a void — a little grazing sheen is what lets the
  // monitor spill find the pile at all. Big flat geometry, so this is a broad sheen, never a glint.
  const rugMap = useMap(tex.rug, 2, 2) || canvasTex(512, 512, drawRug, { clamp: true });
  const rugMat = std({
    map: rugMap, color: 0xffffff, roughness: 0.86, metalness: 0,
    emissive: 0x6a6690, emissiveMap: rugMap, emissiveIntensity: 0.62,
  });
  const rug = add(G(new THREE.PlaneGeometry(3.30, 2.70)), rugMat, { receive: true, name: 'rug' });
  rug.rotation.x = -Math.PI / 2;
  rug.rotation.z = 0.03;
  rug.position.set(-0.05, 0.006, 0.32);

  // =========================================================================================
  // WINDOW (back wall, left of the monitor) — casing + mullion cross, night sky behind
  // =========================================================================================

  const frameMat = std({ color: 0x2e2a35, roughness: 0.55, metalness: 0.05 });
  const cw = 0.05;                       // casing width
  // The casing sits proud of the plaster by 20 mm and NO MORE: the fairy string crosses this stretch of
  // wall, and its wire dips to z = -1.081 (bulb backs reach -1.076) between x = -1.96 and -1.04. A deeper
  // casing would spear the string. The sill shelf below it (y ~ 0.97) has no wire near it and can jut.
  const cz0 = -1.104, cz1 = -1.084;
  // Pieces tile the border edge-to-edge — no two share a coplanar FRONT face, because overlapping merged
  // boxes z-fight into a speckled seam (the same class of bug as the monitor bezel below).
  add(merged([
    box(WIN.x0 - cw, WIN.x1 + cw, WIN.y1, WIN.y1 + 0.06, cz0, cz1),               // head
    box(WIN.x0 - cw, WIN.x0, WIN.y0, WIN.y1, cz0, cz1),                           // jamb (left)
    box(WIN.x1, WIN.x1 + cw, WIN.y0, WIN.y1, cz0, cz1),                           // jamb (right)
    box(WIN.x0 - cw, WIN.x1 + cw, WIN.y0 - 0.090, WIN.y0 - 0.032, cz0, cz1),      // apron
    box(WIN.x0 - cw - 0.02, WIN.x1 + cw + 0.02, WIN.y0 - 0.032, WIN.y0, -1.104, -1.052),  // sill shelf
    box(WINCX - 0.016, WINCX + 0.016, WIN.y0, WIN.y1, -1.128, -1.106),            // mullion — vertical
    box(WIN.x0, WIN.x1, WINCY - 0.016, WINCY + 0.016, -1.128, -1.106),            // mullion — horizontal
  ]), frameMat, { cast: true, receive: true, name: 'windowFrame' });

  // Night sky plane BEHIND the wall (z = -1.30, the wall's outer face is -1.14), so it is seen through
  // the opening and can never draw in front of the plaster. It is sized to the cone the camera actually
  // pushes through the hole over the whole 12 s dolly, plus margin — big enough that no frame catches its
  // edge, small enough that the moon and the rooftop silhouette both land inside the visible rectangle.
  // Emissive so it reads in an unlit void; the texture is deep blue-violet and the moon, its brightest
  // pixel, still tone-maps to pale blue rather than white.
  const skyMat = std({
    color: 0x000000, emissive: 0xffffff, emissiveMap: skyTex, emissiveIntensity: 0.85,
    roughness: 1, metalness: 0, toneMapped: true,
  });
  const sky = add(G(new THREE.PlaneGeometry(1.40, 1.40)), skyMat, { name: 'nightSky' });
  sky.position.set(-1.66, 1.47, -1.30);

  // faint glass — large surface, so a little gloss here is a reflection, not a sub-pixel glint
  const glassMat = std({ color: 0x9fb0d8, roughness: 0.16, metalness: 0, transparent: true, opacity: 0.04 });
  const glass = add(G(new THREE.PlaneGeometry(WIN.x1 - WIN.x0, WIN.y1 - WIN.y0)), glassMat, { name: 'windowGlass' });
  glass.position.set(WINCX, WINCY, -1.117);

  // No curtain. A single translucent plane lit flat by moonlight reads as a hard-edged blue
  // wedge floating in the room, not as cloth — and the hero camera sees it across the whole
  // upper-left of frame. Cloth that reads needs folds + a skinned/simmed drape; not worth it
  // for a loading screen. // ponytail: no curtain, add real geometry-folded drape if the
  // window ever becomes a hero element.

  // =========================================================================================
  // DESK
  // =========================================================================================

  // same walnut as the floor, tiled tighter and tinted a stop warmer so the desk separates from it
  const deskMap = useMap(tex.wood, 2.2, 0.9) || canvasTex(512, 512, drawPlanks, { repeat: [1.9, 0.75] });
  const woodMat = std({
    map: deskMap, color: 0xc9a882, roughness: 0.45, metalness: 0.02,
    emissive: 0x6a4a2e, emissiveMap: deskMap, emissiveIntensity: 0.30,   // same bounce term as the floor
  });

  const deskTop = add(G(new RoundedBoxGeometry(1.90, 0.042, 0.75, 2, 0.012)), woodMat, { cast: true, receive: true, name: 'deskTop' });
  deskTop.position.set(0, 0.724, -0.675);

  const metalMat = std({ color: 0x14141a, roughness: 0.52, metalness: 0.65 });
  const legs = [];
  for (const sx of [-0.84, 0.84]) {
    legs.push(box(sx - 0.028, sx + 0.028, 0.02, 0.703, -1.00, -0.945));  // rear post
    legs.push(box(sx - 0.028, sx + 0.028, 0.02, 0.703, -0.43, -0.375));  // front post
    legs.push(box(sx - 0.024, sx + 0.024, 0.655, 0.703, -1.00, -0.375)); // top rail
    legs.push(box(sx - 0.055, sx + 0.055, 0.00, 0.024, -1.02, -0.355));  // foot
  }
  legs.push(box(-0.84, 0.84, 0.615, 0.655, -0.99, -0.955));              // cross brace
  legs.push(box(-0.80, 0.80, 0.545, 0.610, -1.00, -0.905));              // cable tray
  add(merged(legs), metalMat, { cast: true, receive: true, name: 'deskFrame' });

  // desk mat under keyboard + mouse
  const matMat = std({ color: 0x1a1826, roughness: 0.97, metalness: 0 });
  const deskMat = add(G(new RoundedBoxGeometry(1.02, 0.005, 0.36, 1, 0.008)), matMat, { receive: true, name: 'deskMat' });
  deskMat.position.set(0.05, 0.7475, -0.47);

  // =========================================================================================
  // MONITOR — 38" ultrawide-ish (0.868 m panel), thin bezel, chin, neck + weighted base
  // It is the loading MENU: it has to be the biggest, brightest thing in the frame, so the whole
  // assembly is 1.4x the old 27" and the panel centre is raised to 1.21 so the taller body still
  // clears the desk. Every derived part below (bezel, sheen, LED, shell, stand, wall bias) is sized
  // off SW/SH so the assembly stays coherent if it is ever rescaled again.
  // =========================================================================================

  const SW = 0.868, SH = 0.49;                             // panel size; centre (0, 1.21, -0.945)
  const monitor = new THREE.Group();
  // solved so the screen's LOCAL z offset lands the panel exactly on (0, 1.21, -0.945) after the tilt
  monitor.position.set(0, 1.2093, -0.9550);
  monitor.rotation.x = -0.07;                              // ~4 deg back tilt
  group.add(monitor);

  // The screen: orchestrator REPLACES this material. 2 mm proud of the bezel front face.
  const screenGeo = G(new THREE.PlaneGeometry(SW, SH));
  const screen = new THREE.Mesh(screenGeo, new THREE.MeshBasicMaterial({ color: 0x101828 }));
  screen.name = 'screen';
  screen.position.set(0, 0, 0.010);
  monitor.add(screen);

  // Physical, not Standard: a WIDE, dull clearcoat lobe is what keeps the surround from reading as a
  // flat black rectangle. (No env map exists in this scene, so clearcoat here is a light response, not
  // a mirror.)
  // 0.82 rough / metalness 0 / clearcoat 0.14 @ 0.80 — was 0.42 / 0.30 / 0.50 @ 0.34, and that tight
  // lobe is HALF OF DEFECT 2. The bezel is an 11 mm strip and the rect-area light is 8 % WIDER than the
  // panel, so the light's own edge lies alongside the bezel and rakes it: a tight specular went Fresnel
  // and drew a hard white-violet line down the outside of the panel. Measured at the hero framing, the
  // strip went 212 -> 67 sRGB (the adjacent screen edge reads 67), i.e. it stopped being a line at all.
  // A/B proof: forcing the bezel matte removed the line and nothing else did. This is a point glint on
  // thin geometry — exactly the pattern CLAUDE.md bans; do not sharpen it back up.
  const bezelMat = M(new THREE.MeshPhysicalMaterial({
    color: 0x121217, roughness: 0.82, metalness: 0.0,
    clearcoat: 0.10, clearcoatRoughness: 0.92, reflectivity: 0.22,
  }));
  // DEFECT FIX (bright seam around the panel). The old ring did two things wrong at once:
  //  1) its inner edge stopped 1 mm OUTSIDE the screen quad, leaving a full-height slit at each side
  //     that looked straight past the back shell at the violet bias glow on the wall — that is the hard
  //     white vertical line the critic photographed on the right edge;
  //  2) the four boxes overlapped at the corners, so two coplanar front faces z-fought into a dashed
  //     white/blue speckle around the outside of the panel.
  // Both are geometry, not tuning. The ring now TUCKS 2 mm BEHIND the screen quad on all four sides
  // (the screen is 2 mm proud, so the overlap is hidden, not z-fighting and not cropping the image),
  // and the four pieces tile edge-to-edge with zero overlapping area.
  const bw = 0.011, chin = 0.040;                          // thin bezel, slightly taller chin
  const bxI = SW / 2 - 0.002, byI = SH / 2 - 0.002;        // inner edge, 2 mm behind the panel
  const bxO = SW / 2 + bw, byO = SH / 2 + bw;              // outer edge
  // 15 mm deep, not 23: the rect-area light is WIDER than the panel (SCREEN.w * 1.08), so its edge sits
  // just outside the bezel's outer face and rakes it side-on. The shallower the side face, the less of
  // that raking strip the camera can see.
  const bz0 = -0.0050, bz1 = 0.008;                        // front face 2 mm behind the screen quad
  add2(monitor, merged([
    box(-bxO, bxO, byI, byO, bz0, bz1),                    // top
    box(-bxO, bxO, -SH / 2 - chin, -byI, bz0, bz1),        // chin
    box(-bxO, -bxI, -byI, byI, bz0, bz1),                  // left
    box(bxI, bxO, -byI, byI, bz0, bz1),                    // right
  ]), bezelMat, { cast: true });

  // --- panel glass: an off-axis sheen sheet over BOTH the screen and the bezel ------------------
  // A monitor at night is not an emissive rectangle, it is a sheet of glass in front of one: what
  // tells the eye "screen" is the room reflected in that glass at a grazing angle. We cannot mirror
  // the room (no env map, and a real reflection pass for a loading screen is absurd), so the
  // reflection is PAINTED: the window rectangle with its mullion cross on the left, the haze streak
  // the room's ambient makes across the top, and two warm fairy-light specks at the top right.
  // Additive at 0.16 — it fades to nothing over the bright screen and only reads over the dark
  // surround and the screen's edges, which is exactly where a real reflection reads.
  const sheenTex = canvasTex(256, 144, (c, W, H) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    const streak = c.createLinearGradient(0, H, W * 0.9, 0);   // grazing haze across the sheet
    streak.addColorStop(0.00, 'rgba(0,0,0,0)');
    streak.addColorStop(0.42, 'rgba(96,110,150,0.5)');
    streak.addColorStop(0.60, 'rgba(120,132,175,0.62)');
    streak.addColorStop(0.85, 'rgba(0,0,0,0)');
    c.fillStyle = streak; c.fillRect(0, 0, W, H);
    // reflected window: a soft-edged rectangle with a mullion cross, low in the left third
    const wx = W * 0.10, wy = H * 0.30, ww = W * 0.20, wh = H * 0.44;
    const wg = c.createLinearGradient(wx, wy, wx + ww, wy + wh);
    wg.addColorStop(0, 'rgba(150,168,214,0.42)'); wg.addColorStop(1, 'rgba(110,126,180,0.12)');
    c.fillStyle = wg; c.fillRect(wx, wy, ww, wh);
    c.fillStyle = 'rgba(0,0,0,0.85)';
    c.fillRect(wx + ww * 0.47, wy, 2, wh); c.fillRect(wx, wy + wh * 0.45, ww, 2);
    c.filter = 'blur(6px)';                                    // cheap: one blurred self-copy
    c.drawImage(c.canvas, 0, 0); c.filter = 'none';
    for (let i = 0; i < 2; i++) {                              // fairy bulbs caught in the glass
      const x = W * (0.72 + i * 0.11), y = H * (0.12 + i * 0.05);
      const g = c.createRadialGradient(x, y, 0, x, y, 9);
      g.addColorStop(0, 'rgba(210,150,80,0.7)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, 9, 0, 6.283); c.fill();
    }
    // Fade every edge to black. The map is ClampToEdge, so whatever value sits in the outermost texel
    // row gets stretched to the plane's boundary and ends on a HARD CUT — an additive blue hairline
    // tracing the sheet, which is the second half of the "speckled line around the panel" defect.
    // Multiply by a black->white ramp per side; past the ramp width it clamps to white = identity.
    c.globalCompositeOperation = 'multiply';
    for (const [x0, y0, x1, y1] of [[0, 0, 12, 0], [W, 0, W - 12, 0], [0, 0, 0, 9], [0, H, 0, H - 9]]) {
      const g = c.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    }
    c.globalCompositeOperation = 'source-over';
  }, { clamp: true, linear: true });

  const sheenMat = M(new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: 0x8a9bd6, emissiveIntensity: 0.52, emissiveMap: sheenTex,
    alphaMap: sheenTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    roughness: 1, metalness: 0, fog: false,
  }));
  // Sized to sit 5 mm INSIDE the bezel's outer edge on every side — it used to overhang the chin, which
  // put an additive edge in open air past the hardware silhouette.
  const shW = (bxO - 0.005) * 2, shH = (byO - 0.005) + (SH / 2 + chin - 0.005);
  const sheen = new THREE.Mesh(G(new THREE.PlaneGeometry(shW, shH)), sheenMat);
  sheen.position.set(0, (byO - (SH / 2 + chin)) / 2, 0.0115);   // covers screen + bezel, 1.5 mm proud
  sheen.renderOrder = 5;                          // after the screen + its UI layer (stage sets 2/3)
  sheen.name = 'panelGlass';
  monitor.add(sheen);

  // power LED on the chin — saturated teal, 11 x 3 mm, emissive 0.45. Tiny and capped: a white one at
  // any intensity is the blob bug in miniature.
  const ledMat = M(new THREE.MeshStandardMaterial({
    color: 0x0b1a18, emissive: 0x1fd8b0, emissiveIntensity: 0.45, roughness: 0.5, metalness: 0,
  }));
  const ledY = -(SH / 2 + chin * 0.55);
  const led = new THREE.Mesh(G(box(bxI - 0.135, bxI - 0.124, ledY - 0.0015, ledY + 0.0015, 0.0074, 0.0086)), ledMat);
  led.name = 'powerLed';
  monitor.add(led);

  const shellMat = std({ color: 0x191920, roughness: 0.62, metalness: 0.25 });
  const backShell = new THREE.Mesh(G(new RoundedBoxGeometry(0.862, 0.520, 0.042, 2, 0.014)), shellMat);
  backShell.position.set(0, -0.017, -0.030);
  backShell.castShadow = true;
  monitor.add(backShell);
  const hump = new THREE.Mesh(G(new RoundedBoxGeometry(0.28, 0.21, 0.036, 2, 0.014)), shellMat);
  hump.position.set(0, -0.070, -0.068);
  monitor.add(hump);

  // stand — in world space (upright, not tilted with the panel). Taller as well as wider: the panel's
  // chin now sits at y = 0.925, so the neck has to reach 0.18 m above the desk before it meets the body.
  const stand = [];
  stand.push(box(-0.038, 0.038, 0.786, 1.145, -1.002, -0.948));            // neck
  stand.push(box(-0.105, 0.105, 0.758, 0.812, -1.022, -0.925));            // neck shoulder
  add(merged(stand), shellMat, { cast: true, name: 'monitorNeck' });
  const baseGeo = G(new THREE.CylinderGeometry(0.161, 0.175, 0.022, 24, 1));
  const mbase = add(baseGeo, metalMat, { cast: true, receive: true, name: 'monitorBase' });
  mbase.scale.set(1, 1, 0.72);
  mbase.position.set(0, 0.756, -0.960);

  // bias light: a soft, deeply saturated violet gradient on the wall behind the panel.
  // Emissive 0.42 (well under the 1.0 small-element cap) and it is a big soft plane, never a blob.
  const biasMat = M(new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: 0x5a2fd0, emissiveIntensity: 0.46,
    alphaMap: biasTex, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, roughness: 1, metalness: 0,
  }));
  // The spill has to READ AS A POOL: wide+bright made every pixel of visible wall violet, which is the
  // "uniformly magenta wall" note — the glow dies out well before the corners so the plaster's blue-grey
  // shows either side of it. Grown with the panel, but by less than 1.4x on purpose: at a true 1.4x its
  // left tail washed violet across the new window, and a light pool does not fall on a hole in the wall.
  const bias = add(G(new THREE.PlaneGeometry(2.90, 1.78)), biasMat, { name: 'biasLight' });
  bias.position.set(-0.02, 1.34, -1.094);

  // =========================================================================================
  // PERIPHERALS — keyboard (instanced keycaps), mouse
  // =========================================================================================

  const plasticMat = std({ color: 0x17161c, roughness: 0.58, metalness: 0.06 });
  const kbBase = add(G(new RoundedBoxGeometry(0.362, 0.020, 0.132, 2, 0.005)), plasticMat, { cast: true, receive: true, name: 'keyboard' });
  kbBase.position.set(0, 0.7595, -0.48);

  // keycaps: one InstancedMesh, ~72 caps in a believable 6-row layout
  const capGeo = G(new RoundedBoxGeometry(0.0158, 0.0075, 0.0158, 1, 0.0022));
  // Keycaps carry a little violet emissive of their own: in both references the keys are LIT, and a
  // pool of light under a slab of dead-black caps does not read as a backlit keyboard. 0.28 on a
  // saturated violet is far under the 1.0 small-element cap and never reaches bloom.
  const capMat = std({
    color: 0x2a2830, emissive: 0x3d1f9e, emissiveIntensity: 0.28, roughness: 0.68, metalness: 0.03,
  });
  const rowsSpec = [14, 14, 13, 12, 11, 8];
  const capCount = rowsSpec.reduce((a, b) => a + b, 0);
  const caps = new THREE.InstancedMesh(capGeo, capMat, capCount);
  caps.castShadow = true;
  {
    const d = new THREE.Object3D();
    const col = new THREE.Color();
    const pitchX = 0.0216, pitchZ = 0.0182;
    let i = 0;
    for (let r = 0; r < rowsSpec.length; r++) {
      const n = rowsSpec[r];
      const z = -0.48 - 0.046 + r * pitchZ;
      for (let k = 0; k < n; k++) {
        d.position.set((k - (n - 1) / 2) * pitchX, 0.7735 + (r === 0 ? -0.001 : 0), z);
        d.rotation.set(0, 0, 0);
        d.updateMatrix();
        caps.setMatrixAt(i, d.matrix);
        // WASD + the modifier row get a deep violet accent; the rest vary a hair so the field
        // of keys does not read as one flat slab.
        const wasd = (r === 3 && k === 2) || (r === 2 && (k === 1 || k === 2 || k === 3));
        if (wasd) col.setHex(0x4a2f9c);
        else col.setRGB(0.86 + rng() * 0.2, 0.86 + rng() * 0.2, 0.9 + rng() * 0.2);
        caps.setColorAt(i, col);
        i++;
      }
    }
    caps.instanceMatrix.needsUpdate = true;
  }
  group.add(caps);

  // keyboard underglow: a thin saturated violet strip + one capped PointLight for the bounce
  // The strip is 1 cm WIDER than the base on every side, so it reads as a lit rim around the board
  // instead of hiding underneath it (it was 0.352 x 0.124 under a 0.362 x 0.132 base — invisible).
  const glowStripMat = M(new THREE.MeshStandardMaterial({
    color: 0x140b2a, emissive: 0x5326c8, emissiveIntensity: 0.6, roughness: 0.9, metalness: 0,
  }));
  const strip = add(G(new THREE.BoxGeometry(0.382, 0.005, 0.152)), glowStripMat, { name: 'kbGlow' });
  strip.position.set(0, 0.7515, -0.48);

  // ...and the pool it throws on the desk mat. Additive with the same soft falloff as the wall bias,
  // so it has no edge; this is the thing that actually reads as RGB backlight from the hero camera.
  const kbPoolMat = M(new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: 0x5a2fd0, emissiveIntensity: 0.34, alphaMap: biasTex,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, roughness: 1, metalness: 0,
  }));
  const kbPool = add(G(new THREE.PlaneGeometry(0.72, 0.42)), kbPoolMat, { name: 'kbPool' });
  kbPool.rotation.x = -Math.PI / 2;
  kbPool.position.set(0, 0.7508, -0.48);

  const kbLight = new THREE.PointLight(0x6a3ae0, 1.6, 1.10, 2);
  kbLight.position.set(0, 0.742, -0.47);
  group.add(kbLight);

  // mouse
  const mouse = add(G(new RoundedBoxGeometry(0.062, 0.034, 0.106, 3, 0.017)), plasticMat, { cast: true, name: 'mouse' });
  mouse.position.set(0.30, 0.7645, -0.465);
  mouse.rotation.y = -0.10;
  const mouseAccentMat = M(new THREE.MeshStandardMaterial({
    color: 0x14102a, emissive: 0x5a2fd0, emissiveIntensity: 0.45, roughness: 0.85, metalness: 0,
  }));
  const mAcc = add(G(new THREE.BoxGeometry(0.0035, 0.010, 0.055)), mouseAccentMat, { name: 'mouseAccent' });
  mAcc.position.set(0.30, 0.7648, -0.462);
  mAcc.rotation.y = -0.10;

  // =========================================================================================
  // DESK CLUTTER — mug + steam, plant, books, notebook + pen, aetheryte figurine, cable
  // =========================================================================================

  // mug (lathe, ~250 tris) + handle
  // Nothing in this room may compete with the monitor. Pale ceramic at roughness 0.42 made the mug
  // the brightest non-screen object in frame — a whole stop over the desk. Darker clay body and a
  // matter glaze: it still catches the spill, it just no longer pulls the eye off the screen.
  // (Shared with the shelf candle, which had the same problem.)
  const ceramicMat = std({ color: 0x453f38, roughness: 0.78, metalness: 0.02 });
  const mugProfile = [];
  for (let i = 0; i <= 10; i++) {
    const v = i / 10;
    mugProfile.push(new THREE.Vector2(0.038 + Math.sin(v * 3.0) * 0.004, v * 0.095));
  }
  mugProfile.push(new THREE.Vector2(0.034, 0.095), new THREE.Vector2(0.0, 0.012), new THREE.Vector2(0.0, 0.0));
  const mug = add(G(new THREE.LatheGeometry(mugProfile, 18)), ceramicMat, { cast: true, receive: true, name: 'mug' });
  mug.position.set(-0.43, 0.746, -0.60);
  const handle = add(G(new THREE.TorusGeometry(0.026, 0.006, 6, 14, Math.PI * 1.25)), ceramicMat, { cast: true });
  handle.position.set(-0.472, 0.796, -0.60);
  handle.rotation.set(0, Math.PI / 2, -0.4);
  const coffeeMat = std({ color: 0x24140b, roughness: 0.22, metalness: 0 });
  const coffee = add(G(new THREE.CircleGeometry(0.036, 16)), coffeeMat, { name: 'coffee' });
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.set(-0.43, 0.828, -0.60);

  // steam: 8 additive points, warm and *very* faint — saturated amber, never white
  const steamCount = 8;
  const steamPos = new Float32Array(steamCount * 3);
  const steamPhase = new Float32Array(steamCount);
  for (let i = 0; i < steamCount; i++) {
    steamPhase[i] = rng();
    steamPos[i * 3] = -0.43; steamPos[i * 3 + 1] = 0.83; steamPos[i * 3 + 2] = -0.60;
  }
  const steamGeo = G(new THREE.BufferGeometry());
  steamGeo.setAttribute('position', new THREE.BufferAttribute(steamPos, 3));
  const steamMat = M(new THREE.PointsMaterial({
    color: 0xd8a06a, size: 0.042, map: softTex, transparent: true, opacity: 0.05,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  const steam = new THREE.Points(steamGeo, steamMat);
  group.add(steam);

  // potted plant
  const potMat = std({ color: 0x573729, roughness: 0.86, metalness: 0 });   // terracotta, one stop down (see mug)
  const potProfile = [];
  for (let i = 0; i <= 6; i++) {
    const v = i / 6;
    potProfile.push(new THREE.Vector2(0.042 + v * 0.020, v * 0.085));
  }
  potProfile.push(new THREE.Vector2(0.066, 0.092), new THREE.Vector2(0.058, 0.088), new THREE.Vector2(0, 0.075), new THREE.Vector2(0, 0));
  const pot = add(G(new THREE.LatheGeometry(potProfile, 16)), potMat, { cast: true, receive: true, name: 'pot' });
  pot.position.set(-0.80, 0.745, -0.90);
  const soilMat = std({ color: 0x241a12, roughness: 1, metalness: 0 });
  const soil = add(G(new THREE.CircleGeometry(0.056, 14)), soilMat);
  soil.rotation.x = -Math.PI / 2;
  soil.position.set(-0.80, 0.828, -0.90);

  const leafMat = std({
    color: 0x2f5c36, roughness: 0.80, metalness: 0, alphaMap: leafTex, alphaTest: 0.4, side: THREE.DoubleSide,
  });
  const leafGeo = G(new THREE.PlaneGeometry(0.105, 0.175));
  leafGeo.translate(0, 0.09, 0);
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, 18);
  leaves.castShadow = true;
  {
    const d = new THREE.Object3D();
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 * 2.4 + rng() * 0.4;
      const lean = 0.32 + rng() * 0.62;
      d.position.set(-0.80 + Math.cos(a) * 0.018, 0.826 + rng() * 0.02, -0.90 + Math.sin(a) * 0.018);
      d.rotation.set(0, a, 0);
      d.rotateOnAxis(new THREE.Vector3(1, 0, 0), lean);
      d.scale.setScalar(0.55 + rng() * 0.55);
      d.updateMatrix();
      leaves.setMatrixAt(i, d.matrix);
    }
    leaves.instanceMatrix.needsUpdate = true;
  }
  group.add(leaves);

  // book stack — one InstancedMesh, per-instance colour
  const bookGeo = G(new RoundedBoxGeometry(0.155, 0.032, 0.115, 1, 0.004));
  const bookMat = std({ color: 0xffffff, roughness: 0.82, metalness: 0 });
  const books = new THREE.InstancedMesh(bookGeo, bookMat, 4);
  books.castShadow = true; books.receiveShadow = true;
  {
    const d = new THREE.Object3D();
    const cols = [0x5a2129, 0x232a52, 0x5c451c, 0x24402c];
    const c = new THREE.Color();
    let y = 0.762;
    for (let i = 0; i < 4; i++) {
      d.position.set(0.66 + rr(-0.012, 0.012), y, -0.885 + rr(-0.012, 0.012));
      d.rotation.set(0, rr(-0.22, 0.22), 0);
      d.scale.set(1, 0.75 + rng() * 0.6, 1);
      d.updateMatrix();
      books.setMatrixAt(i, d.matrix);
      books.setColorAt(i, c.setHex(cols[i]));
      y += 0.030;
    }
    books.instanceMatrix.needsUpdate = true;
  }
  group.add(books);

  // notebook + pen
  const nbMat = std({ color: 0x2b2438, roughness: 0.75, metalness: 0 });
  const notebook = add(G(new RoundedBoxGeometry(0.16, 0.011, 0.215, 1, 0.003)), nbMat, { cast: true, receive: true, name: 'notebook' });
  notebook.position.set(-0.46, 0.7525, -0.40);
  notebook.rotation.y = 0.28;
  const penMat = std({ color: 0x8d7434, roughness: 0.35, metalness: 0.6 });
  const penGeo = () => new THREE.CylinderGeometry(0.0042, 0.0032, 0.135, 8);
  // one pen lying on the notebook + four standing in the pot; one merge, one draw call
  const pens = [at(penGeo(), -0.44, 0.7615, -0.395, Math.PI / 2, 0, 0.55)];
  for (let i = 0; i < 4; i++) {
    const a = rr(0, 6.283), lean = rr(0.06, 0.22);
    pens.push(at(penGeo(), -0.655 + Math.cos(a) * 0.013, 0.845, -0.655 + Math.sin(a) * 0.013,
      Math.sin(a) * lean, 0, -Math.cos(a) * lean));
  }
  add(merged(pens), penMat, { cast: true, name: 'pens' });

  // =========================================================================================
  // MORE DESK CLUTTER — the references are DENSE. A bedroom desk with five objects on it reads
  // as a showroom; what sells "lived in" is small stuff with different materials catching the
  // monitor spill at different angles. Everything here is merged by material: 4 extra draw calls
  // for ~12 objects. All of it sits on the desk (z <= -0.30), clear of the camera path and the
  // chair, and nothing crosses the sight line from the camera to the screen.
  // =========================================================================================

  const clutter = [];   // -> plasticMat (dark satin plastic)
  // desktop speaker, angled at the chair
  clutter.push(box(-0.658, -0.573, 0.745, 0.918, -0.912, -0.827));
  clutter.push(box(-0.652, -0.579, 0.918, 0.925, -0.906, -0.833));           // top cap
  // headphone stand: weighted disc, post, and the cans hanging off it. Moved from x = 0.44 to 0.84:
  // the 1.4x panel reaches x = 0.445 and the cans used to sit 7 cm IN FRONT of it, so they now ate the
  // screen's bottom-right corner. 0.84 keeps them clear of the book stack (which ends at 0.738) and
  // inside the desk top (which ends at 0.95).
  const HPX = 0.84, HPZ = -0.860;
  clutter.push(at(new THREE.CylinderGeometry(0.052, 0.056, 0.014, 16), HPX, 0.752, HPZ));
  clutter.push(at(new THREE.CylinderGeometry(0.010, 0.011, 0.262, 10), HPX, 0.890, HPZ));
  clutter.push(at(new THREE.TorusGeometry(0.056, 0.009, 6, 16, Math.PI), HPX, 0.985, HPZ, 0, 0.30, 0));
  for (const s of [-1, 1]) {                                                  // ear cups
    clutter.push(at(new THREE.CylinderGeometry(0.033, 0.031, 0.024, 14), HPX + s * 0.053, 0.982, HPZ + s * 0.016, 0, 0, Math.PI / 2));
  }
  clutter.push(at(new THREE.BoxGeometry(0.070, 0.008, 0.145), 0.165, 0.7515, -0.880, 0, 0.34, 0)); // phone, face down
  clutter.push(at(new THREE.CylinderGeometry(0.036, 0.032, 0.100, 14), -0.655, 0.795, -0.655));   // pen pot
  // dice: plain cubes on purpose — IcosahedronGeometry is non-indexed and mergeGeometries needs the
  // whole list to agree, so a polyhedron here silently kills the merge.
  clutter.push(at(new THREE.BoxGeometry(0.017, 0.017, 0.017), 0.300, 0.7535, -0.760, 0, 0.7, 0));
  clutter.push(at(new THREE.BoxGeometry(0.016, 0.016, 0.016), 0.267, 0.753, -0.788, 0, 0.3, 0));
  add(merged(clutter), plasticMat, { cast: true, receive: true, name: 'clutterDark' });

  // energy can + the speaker's driver rings — brushed aluminium, the cool specular hits on the left
  // of the desk (both references are full of small metal catches; that is most of what "dense" means)
  // color one stop down from 0x8f97a6 / rough 0.38: the can was reading as the second-brightest
  // thing on the desk. Metal still catches the spill — it just does not out-shine the screen.
  const aluMat = std({ color: 0x5e6572, roughness: 0.56, metalness: 0.82 });
  const SX = -0.6155, SZ = -0.8275;      // speaker faceplate centre / front plane (cabinet face -0.827)
  add(merged([
    at(new THREE.CylinderGeometry(0.033, 0.033, 0.112, 18, 1, true), -0.285, 0.801, -0.862),
    at(new THREE.CylinderGeometry(0.028, 0.033, 0.010, 18), -0.285, 0.860, -0.862),
    at(new THREE.CircleGeometry(0.028, 18), -0.285, 0.866, -0.862, -Math.PI / 2, 0, 0),
    at(new THREE.CylinderGeometry(0.026, 0.026, 0.004, 16), SX, 0.860, -0.8245, Math.PI / 2, 0, 0),
    at(new THREE.CylinderGeometry(0.014, 0.014, 0.004, 12), SX, 0.792, -0.8245, Math.PI / 2, 0, 0),
    // Speaker faceplate + lid trim. The cabinet was a black box on a black wall — only the two
    // driver rings read, so it looked like a hole. A brushed-alu frame around the baffle and a lid
    // strip on top give it four lit edges: the fairy string above catches the lid, the monitor
    // spill catches the inner frame, and the silhouette finally closes.
    box(-0.658, -0.573, 0.9095, 0.9145, SZ, -0.8255),                   // baffle frame — top
    box(-0.658, -0.573, 0.7495, 0.7545, SZ, -0.8255),                   //              — bottom
    box(-0.6565, -0.6525, 0.7495, 0.9145, SZ, -0.8255),                 //              — left
    box(-0.5785, -0.5745, 0.7495, 0.9145, SZ, -0.8255),                 //              — right
    box(-0.6525, -0.5785, 0.9250, 0.9285, -0.9060, -0.8330),            // lid strip (catches fairy light)
  ]), aluMat, { cast: true, receive: true, name: 'can' });

  // speaker standby LED — 8 x 4 mm, saturated teal, same capped material as the monitor's power
  // light (emissiveIntensity 0.45). Small + saturated + capped: reads as an LED, never as a blob.
  add(G(box(-0.600, -0.592, 0.7580, 0.7620, -0.8280, -0.8262)), ledMat, { name: 'speakerLed' });
  const labelMat = std({ color: 0x1d6f57, roughness: 0.46, metalness: 0.1 });
  const label = add(G(new THREE.CylinderGeometry(0.0335, 0.0335, 0.068, 18, 1, true)), labelMat, { name: 'canLabel' });
  label.position.set(-0.285, 0.796, -0.862);

  // Sticky notes on the wall between the print and the monitor. A flat card, uniformly lit, is a
  // square — not a note. What says "stuck to the wall" is CONTACT: the sheet lies flat except at
  // one corner, which peels, and the sheet throws a small soft shadow. So each note is a curled
  // plane plus a blurred shadow quad, both instanced (2 draw calls for the set).
  const noteGeo = G(new THREE.PlaneGeometry(0.052, 0.052, 4, 4));
  {
    const p = noteGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      // bottom-left corner peels: its normal turns toward the fairy string (up-right of the wall),
      // so the peel catches a highlight instead of going dark, and the sheet lies flat elsewhere.
      const u = Math.max(0, -(p.getX(i) + p.getY(i)) / 0.052);
      p.setZ(i, u * u * 0.0085);
    }
    noteGeo.computeVertexNormals();
  }
  const noteMat = std({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  // real sticky-note paper, not mud: the old colours (0x7d6f3c etc.) were already half-dark before
  // the room's light got to them, so the notes could never separate from the plaster.
  // pushed right (was x 0.415-0.505): the 1.4x panel's bezel now reaches x = 0.445 and stands 13 cm in
  // front of this wall, so the old positions were hidden behind the monitor. 0.525-0.646 keeps them
  // between the panel and the right print's frame (which starts at x = 0.73).
  const spec = [[0.545, 1.335, 0xc7b35e], [0.620, 1.240, 0xc07d86], [0.525, 1.185, 0x86ab6b]];
  const notes = new THREE.InstancedMesh(noteGeo, noteMat, 3);
  // Drop shadow shaped like the note, not like a dot: softTex is a radial falloff, so its core sat
  // hidden BEHIND the note and only its ~5 % tail showed past the edge — an invisible shadow. A
  // blurred square keeps full density right up to the note's outline and feathers over ~4 mm.
  const noteShadowTex = canvasTex(64, 64, (c, S) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
    c.filter = 'blur(9px)';
    c.fillStyle = '#fff'; c.fillRect(S * 0.22, S * 0.22, S * 0.56, S * 0.56);
    c.filter = 'none';
  }, { clamp: true, linear: true });
  const noteShadowMat = M(new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 1, metalness: 0, alphaMap: noteShadowTex,
    transparent: true, opacity: 0.85, depthWrite: false,
  }));
  const noteShadows = new THREE.InstancedMesh(G(new THREE.PlaneGeometry(0.070, 0.070)), noteShadowMat, 3);
  {
    const d = new THREE.Object3D(), c = new THREE.Color();
    for (let i = 0; i < 3; i++) {
      // z -1.0915 puts the notes and their shadows IN FRONT of the bias plane (z = -1.094). That
      // plane is the thing that was killing them: it is an additive violet wash with depthWrite
      // off, so at the old z it painted the identical value over note and plaster alike — the note
      // and the wall ended up the same colour by construction, which is exactly what "no contact"
      // looks like. In front of it, the note occludes the wash, is lit only by the real lights, and
      // its shadow blends DOWN over the glowing wall instead of being erased by it.
      const tilt = rr(-0.16, 0.16);
      d.position.set(spec[i][0], spec[i][1], -1.0915);
      d.rotation.set(0, 0, tilt);
      d.updateMatrix();
      notes.setMatrixAt(i, d.matrix);
      notes.setColorAt(i, c.setHex(spec[i][2]));
      // shadow falls down-left: the monitor is edge-on to this wall and contributes almost nothing
      // here, so the fairy string (up and to the right) is what actually casts on these notes.
      d.position.set(spec[i][0] - 0.0065, spec[i][1] - 0.0055, -1.0925);
      d.rotation.set(0, 0, tilt);   // the shadow is the note's own outline — it has to share its tilt
      d.updateMatrix();
      noteShadows.setMatrixAt(i, d.matrix);
    }
    notes.instanceMatrix.needsUpdate = true;
    noteShadows.instanceMatrix.needsUpdate = true;
  }
  group.add(noteShadows);
  group.add(notes);

  // aetheryte figurine (the game's landmark, shrunk to a desk toy) on a tiny stone plinth
  const plinthMat = std({ color: 0x50484f, roughness: 0.86, metalness: 0.05 });
  const plinth = add(G(new THREE.CylinderGeometry(0.032, 0.040, 0.022, 8)), plinthMat, { cast: true, receive: true });
  plinth.position.set(0.50, 0.756, -0.665);
  const crystalMat = M(new THREE.MeshStandardMaterial({
    // 0.55 / rough 0.44 (was 0.85 / 0.34): the figurine was measuring BRIGHTER than the start
    // screen behind it (p95 223 vs 187) — a desk toy out-glowing the hero element. Saturated hue,
    // capped value: it still reads as aether, it just stops competing.
    color: 0x2a1a68, emissive: 0x5a2fd8, emissiveIntensity: 0.55,
    roughness: 0.44, metalness: 0.05, flatShading: true,
  }));
  const crystalGeo = G(new THREE.OctahedronGeometry(0.030, 0));
  crystalGeo.scale(0.72, 1.7, 0.72);
  const crystal = add(crystalGeo, crystalMat, { name: 'aetheryte' });
  crystal.position.set(0.50, 0.813, -0.665);
  crystal.rotation.y = 0.4;
  // 0.12 @ 0.45 m, lifted clear of the crystal's own tip. It used to sit INSIDE the mesh, and a
  // decay-2 point light at ~2 cm is effectively infinite: the figurine measured brighter than the
  // start screen (p95 223 vs 187). Up here it does what it was for — a small violet pool on the
  // desk — without blowing out the thing it is supposed to be coming from.
  const crystalLight = new THREE.PointLight(0x6a3ae0, 0.12, 0.45, 2);
  crystalLight.position.set(0.50, 0.905, -0.665);
  group.add(crystalLight);

  // cable: monitor -> down the back of the desk -> across the floor toward the wall
  const cableCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.055, 1.100, -1.012),   // clear of the wider/taller neck (x +-0.038, z to -0.948)
    new THREE.Vector3(0.06, 0.860, -1.030),
    new THREE.Vector3(0.02, 0.700, -1.050),
    new THREE.Vector3(-0.10, 0.580, -1.010),
    new THREE.Vector3(-0.32, 0.560, -0.980),
    new THREE.Vector3(-0.52, 0.330, -1.030),
    new THREE.Vector3(-0.58, 0.030, -1.020),
    new THREE.Vector3(-0.78, 0.018, -1.045),
  ]);
  // two more loose leads (keyboard, speaker) over the back edge of the desk — merged with the monitor
  // lead, so the whole cable run is still one draw call
  const kbCable = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.150, 0.7530, -0.552), new THREE.Vector3(-0.190, 0.7520, -0.700),
    new THREE.Vector3(-0.200, 0.7515, -0.840), new THREE.Vector3(-0.170, 0.7500, -0.960),
    new THREE.Vector3(-0.140, 0.7200, -1.042), new THREE.Vector3(-0.132, 0.6000, -1.052),
  ]);
  const spkCable = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.612, 0.800, -0.905), new THREE.Vector3(-0.622, 0.756, -0.995),
    new THREE.Vector3(-0.636, 0.700, -1.044), new THREE.Vector3(-0.668, 0.440, -1.028),
    new THREE.Vector3(-0.706, 0.100, -1.048), new THREE.Vector3(-0.790, 0.022, -1.030),
  ]);
  const cableMat = std({ color: 0x0e0e12, roughness: 0.72, metalness: 0.05 });
  add(merged([
    new THREE.TubeGeometry(cableCurve, 40, 0.006, 5, false),
    new THREE.TubeGeometry(kbCable, 26, 0.0042, 5, false),
    new THREE.TubeGeometry(spkCable, 26, 0.0045, 5, false),
  ]), cableMat, { cast: true, name: 'cable' });

  // =========================================================================================
  // WALL DRESSING — framed prints + fairy lights
  // =========================================================================================

  // Hero camera (0.95, 1.62, 1.35) -> (0.02, 1.06, -0.55), 38 deg vFOV, so the back wall it can
  // actually see is roughly x[-1.0,1.4] y[1.3,2.4]. Everything up here has to sit inside that box
  // or it is furniture nobody will ever see. Frames are warm brushed brass (not near-black) so
  // they catch the monitor spill and the fairy lights and give the top of the frame an edge.
  const printFrameMat = std({ color: 0x6d5c3d, roughness: 0.42, metalness: 0.45 });
  // sizes match the poster art's aspect (352x528 portrait, 528x352 landscape) so nothing stretches;
  // p1's top stays clear of the fairy wire (~2.04) and p2's right edge stays inside x=1.4.
  // Real framed prints are 0.4-0.7 m on the long edge. These were 0.66 and 0.66 with the camera 2 m
  // closer than they were sized for, so the left one read like a 2 m gallery canvas next to a 0.75 m
  // desk and broke the scale of the whole room. 0.51 / 0.48 long edge, aspect kept.
  const p1 = { x: -0.72, y: 1.56, w: 0.34, h: 0.51 };
  const p2 = { x: 0.99, y: 1.66, w: 0.48, h: 0.32 };
  add(merged([
    box(p1.x - p1.w / 2 - 0.020, p1.x + p1.w / 2 + 0.020, p1.y - p1.h / 2 - 0.020, p1.y + p1.h / 2 + 0.020, -1.098, -1.072),
    box(p2.x - p2.w / 2 - 0.020, p2.x + p2.w / 2 + 0.020, p2.y - p2.h / 2 - 0.020, p2.y + p2.h / 2 + 0.020, -1.098, -1.072),
  ]), printFrameMat, { cast: true, name: 'printFrames' });

  for (const [p, art, warm] of [[p1, tex.posterCrystal, false], [p2, tex.posterRuins, true]]) {
    // color 0x8a8a94, not white: the fairy point light sits ~0.45 m off the left print, and with the
    // rig lifted the print measured mean 119 / p95 230 against the monitor's 64 / 125 — a poster
    // out-reading the hero element. Tinting the albedo keeps the art readable and puts it back under
    // the screen. NOTHING in this room may out-read the monitor.
    const m = std({ map: art || posterTex(warm), color: 0x8a8a94, roughness: 0.88, metalness: 0 });
    const mesh = add(G(new THREE.PlaneGeometry(p.w, p.h)), m, { receive: true, name: 'print' });
    mesh.position.set(p.x, p.y, -1.0715);
  }

  // floating shelf directly above the monitor — fills the middle of the upper third, and its
  // underside catches the bias glow so there is a lit edge instead of flat wall.
  const shelfMat = std({ color: 0x4b3f31, roughness: 0.68, metalness: 0.04 });
  const shelfY = 1.66, shelfX0 = -0.02, shelfX1 = 0.60;
  add(G(box(shelfX0, shelfX1, shelfY, shelfY + 0.030, -1.076, -0.905)), shelfMat, { cast: true, receive: true, name: 'shelf' });

  // Proper L-brackets. The old ones were two 4 cm stubs tucked against the wall UNDER the board, which
  // from the hero angle is invisible — so a 62 cm plank appeared to be glued to the plaster. Each
  // bracket is a wall plate + an arm under the board + a diagonal strut, in the dark desk metal.
  const brackets = [];
  for (const bx of [shelfX0 + 0.075, shelfX1 - 0.075]) {
    brackets.push(box(bx - 0.007, bx + 0.007, shelfY - 0.150, shelfY, -1.098, -1.087));   // wall plate
    brackets.push(box(bx - 0.008, bx + 0.008, shelfY - 0.018, shelfY, -1.098, -0.975));   // arm
    brackets.push(at(new THREE.BoxGeometry(0.007, 0.007, 0.176), bx, shelfY - 0.0865, -1.032, -0.902, 0, 0));
  }
  add(merged(brackets), metalMat, { cast: true, name: 'shelfBrackets' });

  // shelf dressing: three leaning books + a small candle. Reuses existing materials.
  const shelfBooks = new THREE.InstancedMesh(bookGeo, bookMat, 3);
  shelfBooks.castShadow = true;
  {
    const d = new THREE.Object3D();
    const c = new THREE.Color();
    const cols = [0x4a2440, 0x2b3a5e, 0x5c451c];
    for (let i = 0; i < 3; i++) {
      // stood on end: the 0.032 m "thickness" becomes the spine width
      d.position.set(shelfX0 + 0.10 + i * 0.045, shelfY + 0.030 + 0.062, -0.995);
      d.rotation.set(0, 0, Math.PI / 2 + (i === 2 ? 0.30 : 0.03));
      d.scale.set(0.80, 1, 0.95);
      d.updateMatrix();
      shelfBooks.setMatrixAt(i, d.matrix);
      shelfBooks.setColorAt(i, c.setHex(cols[i]));
    }
    shelfBooks.instanceMatrix.needsUpdate = true;
  }
  group.add(shelfBooks);

  const candle = add(G(new THREE.CylinderGeometry(0.026, 0.028, 0.075, 12)), ceramicMat, { cast: true, receive: true, name: 'candle' });
  candle.position.set(shelfX1 - 0.11, shelfY + 0.030 + 0.0375, -0.985);

  // fairy lights: catenary along the back wall, wire as one tube, bulbs as one InstancedMesh
  const bulbCount = 14;
  const catY = (u) => 2.16 - 0.26 * Math.sin(Math.PI * u) - 0.02 * Math.sin(u * 9.0);
  const wirePts = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    wirePts.push(new THREE.Vector3(-2.18 + u * 4.36, catY(u), -1.072 - Math.sin(u * 5.0) * 0.006));
  }
  const wireCurve = new THREE.CatmullRomCurve3(wirePts);
  const wireMat = std({ color: 0x1a1a1e, roughness: 0.8, metalness: 0.1 });
  add(G(new THREE.TubeGeometry(wireCurve, 52, 0.0028, 4, false)), wireMat, { name: 'fairyWire' });

  // Warm gold, emissive 0.9 — under the 1.0 small-element cap, and saturated so it tone-maps to
  // amber rather than white. vColor multiplies emissive (injection below) so update() can breathe
  // each bulb independently without touching the shared material.
  const bulbMat = std({ color: 0x3a2a12, emissive: 0xffa63c, emissiveIntensity: 0.9, roughness: 0.55, metalness: 0 });
  bulbMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#if defined( USE_INSTANCING_COLOR )\n  totalEmissiveRadiance *= vColor;\n#endif'
    );
  };
  // Actual bulb geometry, not beads: a lathed teardrop with a neck, hung from the wire by its neck.
  // A sphere at this size is a dot; the taper is what reads as a filament bulb at 2 m.
  const bulbProfile = [
    new THREE.Vector2(0.0000, 0.000), new THREE.Vector2(0.0075, 0.0025), new THREE.Vector2(0.0125, 0.008),
    new THREE.Vector2(0.0142, 0.017), new THREE.Vector2(0.0128, 0.027), new THREE.Vector2(0.0085, 0.035),
    new THREE.Vector2(0.0062, 0.042),
  ];
  const bulbGeo = G(new THREE.LatheGeometry(bulbProfile, 10));
  bulbGeo.translate(0, -0.042, 0);                 // origin at the neck, so it hangs off the wire
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, bulbCount);
  const bulbPhase = new Float32Array(bulbCount);
  {
    const d = new THREE.Object3D();
    const c = new THREE.Color(1, 1, 1);
    for (let i = 0; i < bulbCount; i++) {
      const u = (i + 0.5) / bulbCount;
      d.position.set(-2.18 + u * 4.36, catY(u) - 0.002, -1.062);
      d.rotation.set(0, rng() * 6.283, rr(-0.22, 0.22));      // each bulb hangs at its own angle
      d.scale.setScalar(0.85 + rng() * 0.3);
      d.updateMatrix();
      bulbs.setMatrixAt(i, d.matrix);
      bulbs.setColorAt(i, c);
      bulbPhase[i] = rng() * 6.283;
    }
    bulbs.instanceMatrix.needsUpdate = true;
  }
  group.add(bulbs);

  // The pool each bulb throws on the plaster. Two point lights cannot do a 4 m string, and 14 of them
  // is not allowed (and would be absurd), so the wash is PAINTED at the bulb positions: one additive
  // plane whose texture is 14 soft amber blobs sitting exactly where the catenary puts them. Warm
  // amber at 0.34 — saturated hue, capped value, tone-maps to gold rather than white.
  const POOL_TOP = 2.40, POOL_H = 1.05;
  const fairyPoolTex = canvasTex(512, 118, (c, W, H) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    for (let i = 0; i < bulbCount; i++) {
      const u = (i + 0.5) / bulbCount;
      const wxi = -2.18 + u * 4.36;
      // no pool over the window: this plane hangs in front of the wall, and a painted patch of warm
      // wall-light floating on the night sky reads as a smear, not as a light
      if (wxi > WIN.x0 - 0.02 && wxi < WIN.x1 + 0.02) continue;
      const px = (wxi + 2.25) / 4.5 * W;
      const py = (POOL_TOP - (catY(u) - 0.02)) / POOL_H * H;
      const r = 32 + rng() * 9;
      const g = c.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0.00, 'rgba(255,196,124,0.62)');
      g.addColorStop(0.30, 'rgba(255,150,70,0.26)');
      g.addColorStop(1.00, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.beginPath(); c.arc(px, py, r, 0, 6.283); c.fill();
    }
  }, { clamp: true, linear: true });
  const fairyPoolMat = M(new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: 0xff9a48, emissiveIntensity: 0.75, emissiveMap: fairyPoolTex,
    alphaMap: fairyPoolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, roughness: 1, metalness: 0,
  }));
  const fairyPool = add(G(new THREE.PlaneGeometry(4.50, POOL_H)), fairyPoolMat, { name: 'fairyPool' });
  fairyPool.position.set(0, POOL_TOP - POOL_H / 2, -1.092);

  const fairyLight = new THREE.PointLight(0xffa860, 1.35, 3.2, 2);
  fairyLight.position.set(-0.75, 1.94, -0.88);
  group.add(fairyLight);
  // second one on the right half — the string is 4.4 m wide and one light lit only its left third
  const fairyLight2 = new THREE.PointLight(0xffa860, 1.05, 2.8, 2);
  fairyLight2.position.set(1.10, 1.95, -0.88);
  group.add(fairyLight2);

  // =========================================================================================
  // ATMOSPHERE — slow dust in the volume the monitor light rakes across
  // =========================================================================================

  // Dust is a TEXTURE, not a starfield: you should have to look for it. It lives only inside the
  // monitor's light cone, and each mote's brightness falls off with distance from the monitor
  // axis (vertexColors scales the additive contribution — cheaper than a custom shader), so the
  // edge of the volume is literally invisible and there is no hard boundary to see.
  const dustCount = 140;
  const dustBase = new Float32Array(dustCount * 3);
  const dustPos = new Float32Array(dustCount * 3);
  const dustCol = new Float32Array(dustCount * 3);
  const dustPhase = new Float32Array(dustCount);
  for (let i = 0; i < dustCount; i++) {
    const x = rr(-0.85, 0.85), y = rr(0.70, 1.70), z = rr(-0.90, 0.55);
    dustBase[i * 3] = x; dustBase[i * 3 + 1] = y; dustBase[i * 3 + 2] = z;
    dustPhase[i] = rng() * 6.283;
    // radial fade off the monitor axis (x=0, y=1.15) + a fade as the cone spreads away from it
    const r = Math.hypot(x, (y - 1.15) * 1.25) / 0.95;
    const a = Math.max(0, 1 - r) ** 1.4 * (1 - 0.45 * ((z + 0.90) / 1.45));
    dustCol[i * 3] = dustCol[i * 3 + 1] = dustCol[i * 3 + 2] = a;
  }
  dustPos.set(dustBase);
  const dustGeo = G(new THREE.BufferGeometry());
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('color', new THREE.BufferAttribute(dustCol, 3));
  // size 0.005 m @ 2.3 m with a 38 deg vertical FOV at 1080p ≈ 3 px of quad, so the bright
  // core of the soft sprite is 1-2 px. Bigger than this and it reads as a star.
  const dustMat = M(new THREE.PointsMaterial({
    color: 0xb0a0f0, size: 0.005, map: softTex, transparent: true, opacity: 0.14,
    vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  group.add(dust);

  // =========================================================================================
  // update / dispose
  // =========================================================================================

  const dustAttr = dustGeo.attributes.position;
  const steamAttr = steamGeo.attributes.position;
  const bulbColor = new THREE.Color();

  function update(t) {
    // dust: two slow out-of-phase sines per mote, no allocation
    for (let i = 0; i < dustCount; i++) {
      const p = dustPhase[i], i3 = i * 3;
      dustPos[i3] = dustBase[i3] + Math.sin(t * 0.13 + p) * 0.030;
      dustPos[i3 + 1] = dustBase[i3 + 1] + Math.sin(t * 0.21 + p * 1.7) * 0.026;
      dustPos[i3 + 2] = dustBase[i3 + 2] + Math.cos(t * 0.11 + p) * 0.030;
    }
    dustAttr.needsUpdate = true;

    // steam: a slow rising column that wobbles as it climbs
    for (let i = 0; i < steamCount; i++) {
      const u = (t * 0.10 + steamPhase[i]) % 1;
      const i3 = i * 3;
      steamPos[i3] = -0.43 + Math.sin(u * 5.0 + steamPhase[i] * 6.0) * 0.018 * u;
      steamPos[i3 + 1] = 0.832 + u * 0.15;
      steamPos[i3 + 2] = -0.60 + Math.cos(u * 4.0 + steamPhase[i] * 6.0) * 0.014 * u;
    }
    steamAttr.needsUpdate = true;

    // fairy bulbs: +-8 % breathing, staggered. vColor multiplies emissive (see onBeforeCompile),
    // so the material's 0.9 cap is never exceeded — the multiplier stays <= 1.
    for (let i = 0; i < bulbCount; i++) {
      const b = 0.92 + 0.08 * Math.sin(t * 0.7 + bulbPhase[i]);
      bulbs.setColorAt(i, bulbColor.setRGB(b, b, b));
    }
    if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;

  }

  function dispose() {
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    for (const t of texs) t.dispose();
    // (screen.material belongs to stage.js by teardown — it disposes it there)
  }

  return { group, screen, materials: mats, update, dispose };

  // local helper used before its declaration is fine (hoisted function)
  function add2(parent, geo, mat, { cast = false, receive = false } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast; m.receiveShadow = receive;
    parent.add(m);
    return m;
  }
}

