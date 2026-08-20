// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Aetherfall via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: rpg agent. Physical identity for a drop: a silhouette you can read from across a
// clearing, and a beacon that cannot be mistaken for the world's own light shafts.
//
// Why it looks like this:
//  * Every rarity used to be the same 0.26 icosahedron. Now the *shape* is the archetype
//    (rifle / hand cannon / scout / charge beam) or the armour slot (helm / gauntlets /
//    plate / greaves / cloak). Rarity is colour and beacon size only, so shape reads first.
//  * The beacon is short (1.8–6 m), never wider than 0.44 m, saturated, brightest at its base
//    and cut off at the top. The world's light shafts (fx/worldfx.js) are 26–30 m, several
//    metres wide, warm cream and brightest at the *top*, and they start at the ground; this
//    one starts above the item. Nothing about the two silhouettes overlaps now.
//  * The core column is NORMAL-blended with toneMapped:false. Additive colour over a bright
//    sky was the actual reason the exotic's gold washed to near-white: the grade pass
//    (render/post.js) runs ACES, and additive pushes every channel into the highlight
//    roll-off, which desaturates. Replacing the sky colour instead of adding to it keeps
//    gold gold. Only the faint outer halo stays additive.
//  * The item floats at 1.25 m, not 0.75 m. Tall grass in world/scatter.js is 0.62 m before
//    per-blade scale, which is what was eating the drops at 4 m.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TIERS, RARITY } from './items.js';

export const HOVER_Y = 1.25;
const BEAM_BASE = 1.8;       // the column starts above the item, not through it

// ---------------------------------------------------------------- geometry kit
function xf(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  return g;
}
const box = (w, h, d, ...a) => xf(new THREE.BoxGeometry(w, h, d), ...a);
const cyl = (rt, rb, h, s, ...a) => xf(new THREE.CylinderGeometry(rt, rb, h, s), ...a);
const tor = (r, t, ...a) => xf(new THREE.TorusGeometry(r, t, 4, 10), ...a);
const cone = (r, h, s, ...a) => xf(new THREE.ConeGeometry(r, h, s), ...a);
const P2 = Math.PI / 2;

// Weapons lie along +X, roughly 0.8 m long: big enough to read at 30 m, small enough to be
// an object you pick up rather than a prop.
const SHAPES = {
  // long body, box magazine, straight stock — the rifle silhouette
  auto: () => [
    box(0.42, 0.095, 0.075),
    cyl(0.026, 0.030, 0.32, 7, 0.37, 0.012, 0, 0, 0, P2),
    box(0.105, 0.19, 0.055, -0.03, -0.13, 0, 0, 0, 0.14),
    box(0.26, 0.085, 0.058, -0.32, -0.015, 0),
    box(0.055, 0.045, 0.05, 0.12, 0.08, 0),
    box(0.05, 0.115, 0.045, -0.13, -0.10, 0, 0, 0, 0.26),
  ],
  // short, fat drum, steeply raked grip — nothing else in the set is this stubby
  handcannon: () => [
    box(0.24, 0.085, 0.062),
    cyl(0.032, 0.036, 0.26, 7, 0.24, 0.008, 0, 0, 0, P2),
    cyl(0.068, 0.068, 0.105, 8, -0.01, -0.012, 0, 0, 0, P2),
    box(0.085, 0.22, 0.058, -0.16, -0.145, 0, 0, 0, 0.42),
    box(0.05, 0.035, 0.045, 0.34, 0.045, 0),
  ],
  // longest barrel, a scope you can see from a distance
  scout: () => [
    box(0.40, 0.08, 0.068),
    cyl(0.021, 0.024, 0.44, 7, 0.42, 0.008, 0, 0, 0, P2),
    cyl(0.048, 0.048, 0.30, 8, 0.06, 0.115, 0, 0, 0, P2),
    tor(0.052, 0.012, -0.05, 0.115, 0, 0, 0, P2),
    tor(0.052, 0.012, 0.17, 0.115, 0, 0, 0, P2),
    box(0.30, 0.11, 0.058, -0.32, -0.02, 0),
    box(0.048, 0.12, 0.045, -0.11, -0.10, 0, 0, 0, 0.2),
  ],
  // fat coil body and a two-prong emitter fork — obviously heavy, obviously not a rifle
  beam: () => [
    cyl(0.085, 0.095, 0.46, 9, -0.02, 0, 0, 0, 0, P2),
    tor(0.115, 0.022, -0.14, 0, 0, 0, 0, P2),
    tor(0.115, 0.022, -0.01, 0, 0, 0, 0, P2),
    tor(0.115, 0.022, 0.12, 0, 0, 0, 0, P2),
    box(0.22, 0.032, 0.032, 0.34, 0, 0.075),
    box(0.22, 0.032, 0.032, 0.34, 0, -0.075),
    box(0.05, 0.04, 0.19, 0.44, 0, 0),
    box(0.07, 0.15, 0.06, -0.13, -0.13, 0, 0, 0, 0.1),
  ],

  // Armour hangs vertically. Each slot gets one feature no other slot has.
  head: () => [
    xf(new THREE.SphereGeometry(0.19, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.6), 0, 0.02, 0),
    box(0.34, 0.055, 0.22, 0, -0.005, 0),
    box(0.028, 0.15, 0.30, 0, 0.13, 0),                    // crest fin
    box(0.075, 0.13, 0.05, 0.145, -0.09, 0.05, 0, 0, -0.2),
    box(0.075, 0.13, 0.05, -0.145, -0.09, 0.05, 0, 0, 0.2),
  ],
  arms: () => [
    cyl(0.082, 0.058, 0.28, 8, 0.115, 0, 0, 0, 0, 0.1),
    cyl(0.082, 0.058, 0.28, 8, -0.115, 0, 0, 0, 0, -0.1),
    box(0.11, 0.075, 0.11, 0.135, -0.16, 0),               // knuckles
    box(0.11, 0.075, 0.11, -0.135, -0.16, 0),
    tor(0.088, 0.018, 0.11, 0.14, 0, P2),
    tor(0.088, 0.018, -0.11, 0.14, 0, P2),
  ],
  chest: () => [
    cyl(0.155, 0.205, 0.36, 4, 0, 0, 0, 0, Math.PI / 4),   // tapered torso
    box(0.17, 0.075, 0.155, 0.20, 0.13, 0, 0, 0, -0.42),   // pauldrons
    box(0.17, 0.075, 0.155, -0.20, 0.13, 0, 0, 0, 0.42),
    tor(0.10, 0.022, 0, 0.185, 0, P2),                     // collar
    box(0.09, 0.09, 0.03, 0, 0.02, 0.155, 0, 0, Math.PI / 4),
  ],
  legs: () => [
    cyl(0.078, 0.052, 0.38, 7, 0.085, 0, 0),
    cyl(0.078, 0.052, 0.38, 7, -0.085, 0, 0),
    box(0.10, 0.085, 0.055, 0.085, 0.06, 0.055),           // knee plates
    box(0.10, 0.085, 0.055, -0.085, 0.06, 0.055),
    box(0.13, 0.045, 0.19, 0.085, -0.19, 0.045),           // boots
    box(0.13, 0.045, 0.19, -0.085, -0.19, 0.045),
  ],
  cloak: () => [
    cone(0.27, 0.50, 7, 0, -0.05, 0),                      // draped fall, apex up
    tor(0.10, 0.024, 0, 0.19, 0, P2),                      // collar
    box(0.07, 0.07, 0.07, 0, 0.19, 0.085, 0, Math.PI / 4, 0),
    box(0.30, 0.03, 0.03, 0, -0.29, 0.10, 0.3),            // hem weight
  ],
};

const cache = {};
function shapeGeo(key) {
  const k = SHAPES[key] ? key : 'auto';
  if (!cache[k]) {
    const g = mergeGeometries(SHAPES[k](), false);
    g.computeVertexNormals();
    cache[k] = g;
  }
  return cache[k];
}

// which silhouette an item wants
function shapeKeyFor(item) {
  if (!item) return 'auto';
  if (item.kind === 'weapon') return SHAPES[item.archetype] ? item.archetype : 'auto';
  return SHAPES[item.slot] ? item.slot : 'chest';
}

// ---------------------------------------------------------------- beacon geometry
// Vertex alpha (4-component colour attribute) fades the column out toward the top without a
// custom shader. Bright at the base, gone at the tip — the inverse of a god ray.
function column(rTop, rBot, seg, fade) {
  const g = new THREE.CylinderGeometry(rTop, rBot, 1, seg, 4, true);
  g.translate(0, 0.5, 0);
  const pos = g.attributes.position;
  const c = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    c[i * 4] = c[i * 4 + 1] = c[i * 4 + 2] = 1;
    // fade out toward the top, and fade *in* over the first slice so the base is not a hard
    // bright disc hanging in the air above the item
    c[i * 4 + 3] = Math.pow(Math.max(0, 1 - y), fade) * Math.min(1, y / 0.12);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 4));
  return g;
}

// Beacon colours are pushed past the UI swatch on purpose: the grade pass desaturates
// anything bright, so the authored colour has to start further from white than the label does.
const BEAM_COLOR = {
  common: 0x8f9aa6, uncommon: 0x28c25c, rare: 0x2f7dff, legendary: 0x9b2dff, exotic: 0xffa000,
};
// how hard the core pushes past 1.0 in linear space — the top tier must be the loudest thing
const BEAM_GAIN = { common: 0.8, uncommon: 1.0, rare: 1.25, legendary: 1.6, exotic: 2.1 };
// Short on purpose. The world's own light shafts are 26-30 m; nothing here goes past 6.
const BEAM_H = { common: 1.8, uncommon: 2.4, rare: 3.2, legendary: 4.4, exotic: 6.0 };
const EMIS = { common: 0.30, uncommon: 0.42, rare: 0.58, legendary: 0.78, exotic: 1.05 };

let geo = null, mats = null;

export function buildKit() {
  if (geo) return;
  // The column has to stay narrower than the silhouette or it swallows it: the item is
  // ~1.1 m across, the widest the beacon ever gets is 0.44 m.
  geo = {
    core: column(0.085, 0.155, 8, 1.5),
    halo: column(0.20, 0.36, 10, 2.4),
    ring: new THREE.RingGeometry(0.42, 0.72, 24).rotateX(-P2),
    chev: new THREE.RingGeometry(0.17, 0.27, 16).rotateX(-P2),
  };
  mats = {};
  for (const k of TIERS) {
    const label = new THREE.Color(RARITY[k].color);
    const beam = new THREE.Color(BEAM_COLOR[k]).multiplyScalar(BEAM_GAIN[k]);
    mats[k] = {
      // dark body, rarity-coloured glow. A pale emissive blob has no silhouette against a
      // bright sky; dark metal with an accent does, which is the whole point of the shape.
      item: new THREE.MeshStandardMaterial({
        color: label.clone().multiplyScalar(0.34), emissive: new THREE.Color(BEAM_COLOR[k]),
        emissiveIntensity: EMIS[k], roughness: 0.55, metalness: 0.35, flatShading: true,
      }),
      // NORMAL blend + no tone map: this is the one that has to hold its hue against the sky
      core: new THREE.MeshBasicMaterial({
        color: beam, vertexColors: true, transparent: true, opacity: 0.92,
        depthWrite: false, side: THREE.FrontSide, fog: false, toneMapped: false,
      }),
      halo: new THREE.MeshBasicMaterial({
        color: new THREE.Color(BEAM_COLOR[k]), vertexColors: true, transparent: true, opacity: 0.24,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        fog: false, toneMapped: false,
      }),
      ring: new THREE.MeshBasicMaterial({
        color: beam, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
        depthWrite: false, fog: false, toneMapped: false,
      }),
    };
  }
}

export const beamColorOf = (t) => BEAM_COLOR[t] || BEAM_COLOR.common;
export const ringMaterial = (t) => mats[t].ring;
export const ringGeometry = () => geo.ring;

// ---------------------------------------------------------------- assembly
export function makeDrop(item, tier) {
  buildKit();
  const m = mats[tier] || mats.common;
  const h = BEAM_H[tier] || 2;
  const g = new THREE.Group();

  const core = new THREE.Mesh(geo.core, m.core);
  const halo = new THREE.Mesh(geo.halo, m.halo);
  core.scale.set(1, h, 1); halo.scale.set(1, h, 1);
  // The beacon rises *from* the item, it does not pass through it. A transparent column
  // drawn over the silhouette is what turned every drop into a glowing smear.
  core.position.y = halo.position.y = BEAM_BASE;
  core.renderOrder = halo.renderOrder = 3;

  // ground rune — flat on the terrain, which no light shaft has
  const ring = new THREE.Mesh(geo.ring, m.ring);
  ring.position.y = 0.03;
  ring.renderOrder = 3;

  // the thing itself
  const shape = new THREE.Mesh(shapeGeo(shapeKeyFor(item)), m.item);
  shape.position.y = HOVER_Y;
  // 1.5x the "realistic" size: a 0.8 m rifle is 30 px at 15 m, which is not a silhouette.
  shape.scale.setScalar(1.5 * (tier === 'exotic' ? 1.2 : tier === 'legendary' ? 1.1 : 1));
  shape.castShadow = false;

  g.add(halo, core, ring, shape);

  // legendary+ get a chevron sliding down the column: unmistakably authored, never weather
  let chev = null;
  if (tier === 'legendary' || tier === 'exotic') {
    chev = new THREE.Mesh(geo.chev, m.ring.clone());
    chev.renderOrder = 4;
    g.add(chev);
  }
  return { g, shape, core, halo, ring, chev, h };
}

export function disposeDrop(d) {
  if (d && d.chev) d.chev.material.dispose();
}

// One runnable check: every archetype and slot must resolve to its own geometry, and the
// icosahedron-for-everything bug must be impossible to reintroduce.
export function selfTest() {
  buildKit();
  const keys = ['auto', 'handcannon', 'scout', 'beam', 'head', 'arms', 'chest', 'legs', 'cloak'];
  const seen = new Set();
  for (const k of keys) {
    const g = shapeGeo(k);
    const n = g.attributes.position.count;
    if (seen.has(g)) throw new Error('shape collision: ' + k);
    seen.add(g);
    if (n < 60) throw new Error('shape too simple to read: ' + k + ' (' + n + ' verts)');
  }
  return seen.size;
}
