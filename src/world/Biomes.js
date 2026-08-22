/**
 * Biomes: the single source of truth for the 10-region world map.
 *
 * Layout (world is `terrain.size` = 2048 m square, centred on origin, +X east, -Z north):
 *   - HOME (r < ~330): the original Vale — spawn meadow, Mirrormere, Sundered Spire, Whisperwood
 *     edge, Crystal Fields, Hollow Crown. Unchanged; it is biome #1 "Meadow".
 *   - RING (r 330..600): the mountain wall, pierced by 9 passes — one on each outer biome's bearing.
 *   - OUTER (9 circular regions of radius RR centred at radius RB on bearings THETA0 + k*STEP):
 *     each is one of the other 9 biomes. Neighbours are ~100 m apart, so the annulus between the
 *     mountain feet and the world edge is a continuous walkable belt: every biome touches its two
 *     neighbours AND has its own pass back to the home meadow. Nothing is teleport-only.
 *   - EDGE (r > 960): impassable wall.
 *
 * This file is DATA + cheap queries only. The height field itself lives in Terrain.js (its kernel is
 * stringified into the bake workers, so it must stay closure-free); Terrain's `BH[]` array is indexed
 * by the same k as ORDER below — keep the two in sync.
 *
 * Consumers: Terrain (splat + biomeAt), Grass (density/tint), Vegetation + Props (placement), Water
 * (dry mask), Lava, Sky (fog grade), Enemies (camps/roster), Ambient (zone beds), RPG (map + landmarks).
 */
import { smoothstep } from '../core/Noise.js';

// ---------------------------------------------------------------- geometry
export const RB = 760;                       // outer biome centres sit on this radius
export const RR = 210;                       // biome mask reaches 0 at this distance from its centre
export const RING_IN = 330, RING_OUT = 600;  // home mountain ring band
export const EDGE = 960;                     // world-edge wall starts here
export const THETA0 = -95 * Math.PI / 180;   // bearing of k=0 (due north: -Z)
export const STEP = 40 * Math.PI / 180;      // 9 biomes x 40 deg = 360

/** k -> biome id. Terrain.js's BH[] height kernels use the same order. */
export const ORDER = ['forest', 'tundra', 'celestial', 'dragon', 'infernal', 'lost', 'shadowfen', 'sunken', 'void'];

export const centerOf = (k) => { const a = THETA0 + k * STEP; return { x: Math.cos(a) * RB, z: Math.sin(a) * RB, a }; };

/** Nearest outer-biome index for a point (always returns one; check `weightAt` for whether we're inside it). */
export function wedgeAt(x, z) {
  let k = Math.round((Math.atan2(z, x) - THETA0) / STEP) % 9;
  return k < 0 ? k + 9 : k;
}
/** 0..1 membership of (x,z) in outer biome k (1 at the centre, 0 at RR). */
export function weightAt(x, z, k) {
  const c = centerOf(k);
  return smoothstep(RR, RR * 0.62, Math.hypot(x - c.x, z - c.z));
}

// ---------------------------------------------------------------- per-biome data
// EVERY field here is read by something. If you add one, wire it or leave it out — a data table that
// promises more than the code delivers is a trap for the next person. Who reads what:
//   name/short/blurb  map screen + region banner   (ui/mapscreen.js, rpg/RPG.js)
//   zone              ambient bed                  (audio/ambient.js ZONES, via Audio._zoneAt)
//   music             generative music mode        (audio/music.js, via Audio._trackTick)
//   level [lo,hi]     enemy level band             (enemies/Enemies.js populate)
//   enemies           camp roster [type, count, rMin, rMax]
//   fog / fogMul      local aerial perspective     (render/Sky.js _gradeFog) — hue forced, luminance kept
//   sun / amb         key light + ambient grade    (render/Lighting.js _gradeBiome) — what makes the
//                     Wastes read as lit by fire and the Void as lit by almost nothing
//   grass.d / .tint   ground-cover density + hue   (world/Terrain.js grassAt, world/Grass.js)
//   dry               no standing water            (Terrain.dryAt -> Water._bed / _bakeHeight)
//   lava              molten skin on the water AND it burns   (world/Water.js, player/Player.js)
//   sea               deep water region: ocean look + swim bed (world/Water.js, audio)
//   float             floating isles + updraft columns        (world/Props.js)
//   gravity           player gravity multiplier    (player/PlayerController.js)
//   landmark          hero prop + map pin          (world/Props.js _buildBiomeLandmarks)
export const BIOMES = {
  meadow: {
    k: -1, name: 'The Vale', short: 'Meadow', zone: 'meadow', level: [1, 5],
    fog: 0xa8c4de, fogMul: 1.0, sun: 0xffffff, amb: 1.0,
    grass: { d: 1.0, tint: 0xffffff }, music: 'field',
    blurb: 'Peaceful grasslands, wildflowers and the Aetheryte. Where every Vale-walker begins.',
  },
  forest: {
    name: 'Whisperwood Deep', short: 'Enchanted Forest', zone: 'forest', level: [5, 11],
    fog: 0x6f9478, fogMul: 1.55, sun: 0xd8ffd0, amb: 0.85,
    ground: 'forest', grass: { d: 0.85, tint: 0x9fd4a8 }, music: 'wood',
    enemies: [['sprite', 4, 8, 90], ['treant', 2, 20, 110], ['hound', 3, 12, 100]],
    landmark: 'The Elderheart',
    blurb: 'Ancient trees, fae lights and druid stones under a canopy the sun barely finds.',
  },
  tundra: {
    name: 'Frostveil Tundra', short: 'Frostveil', zone: 'tundra', level: [11, 17],
    fog: 0xc2dcee, fogMul: 1.35, sun: 0xdcecff, amb: 1.15,
    ground: 'snow', grass: { d: 0.10, tint: 0xa8c0d8 }, music: 'frost',
    enemies: [['frostwolf', 5, 12, 110], ['icegiant', 2, 30, 120], ['wisp', 3, 20, 110]],
    landmark: 'The Glacier Throne',
    blurb: 'Glaciers, frozen beasts and an aurora that never fully leaves the sky.',
  },
  celestial: {
    name: 'Celestial Isles', short: 'Celestial', zone: 'celestial', level: [30, 38],
    fog: 0xe6dcff, fogMul: 0.60, sun: 0xfff2d0, amb: 1.45,
    ground: 'stone', grass: { d: 0.14, tint: 0xd8e8c0 }, music: 'choir',
    enemies: [['seraph', 3, 16, 100], ['skyserpent', 2, 30, 120], ['wisp', 4, 14, 110]],
    landmark: 'The Empyrean Gate', float: true,
    blurb: 'Islands adrift in gold light, divine ruins and serpents that swim the air.',
  },
  dragon: {
    name: 'Dragon Peaks', short: 'Dragon Peaks', zone: 'dragon', level: [24, 32],
    fog: 0x9fa8b6, fogMul: 1.15, sun: 0xffe8c8, amb: 0.95,
    ground: 'rock', grass: { d: 0.18, tint: 0xa8b090 }, music: 'drums',
    enemies: [['wyvern', 3, 30, 130], ['forgeknight', 3, 14, 100], ['golem', 2, 20, 110]],
    landmark: 'Kharaz-Dun Gate',
    blurb: 'Enormous peaks, dragon nests on the ledges, and a dwarven gate cut into the mountain.',
  },
  infernal: {
    name: 'Infernal Wastes', short: 'Infernal', zone: 'infernal', level: [18, 25],
    fog: 0x5a2a18, fogMul: 2.0, sun: 0xffb070, amb: 0.75,
    // NOT `dry`: the channels bhInfernal carves reach below terrain.waterLevel, so the ONE global water
    // surface fills them — that is where the lava rivers come from (see WATER_LOOK.infernal / uLava).
    ground: 'ash', grass: { d: 0, tint: 0x000000 }, lava: true, music: 'forge',
    enemies: [['imp', 5, 12, 110], ['magmagolem', 2, 24, 115], ['drake', 2, 30, 125]],
    landmark: 'The Cinder Maw',
    blurb: 'A volcano bleeding lava rivers across black ash. Demons work the flows.',
  },
  lost: {
    name: 'The Lost Realm', short: 'Lost Realm', zone: 'lost', level: [40, 50],
    fog: 0xb4a0dc, fogMul: 0.95, sun: 0xffe0ff, amb: 1.2,
    ground: 'stone', grass: { d: 0.12, tint: 0xc0b8d8 }, music: 'convergence',
    enemies: [['archon', 1, 0, 3], ['sentinel', 3, 24, 120], ['golem', 2, 30, 120], ['wraith', 3, 20, 110]],
    landmark: 'The Convergence',
    blurb: 'Where every magic in the world meets and argues. The end of the road.',
  },
  shadowfen: {
    name: 'Shadowfen', short: 'Shadowfen', zone: 'shadowfen', level: [15, 22],
    fog: 0x4e5c4a, fogMul: 2.4, sun: 0xa8c090, amb: 0.7,
    ground: 'muck', grass: { d: 0.55, tint: 0x7a8a58 }, music: 'fen',
    enemies: [['wraith', 4, 14, 105], ['bogwitch', 2, 20, 110], ['hound', 3, 16, 110]],
    landmark: 'The Hagstone',
    blurb: 'Cursed water to the knee, witchlight, and things that used to be people.',
  },
  sunken: {
    name: 'The Sunken Kingdom', short: 'Sunken Kingdom', zone: 'sunken', level: [20, 28],
    fog: 0x2e6472, fogMul: 1.7, sun: 0x9fdcf0, amb: 0.9,
    ground: 'sand', grass: { d: 0.05, tint: 0x6a9a90 }, sea: true, music: 'deep',
    enemies: [['drowned', 4, 14, 100], ['leviathan', 2, 40, 130], ['wisp', 3, 20, 110]],
    landmark: 'The Drowned Court',
    blurb: 'A civilisation under the water. Coral has taken the throne room.',
  },
  void: {
    name: 'The Void', short: 'The Void', zone: 'void', level: [34, 44],
    fog: 0x2c2040, fogMul: 1.15, sun: 0xd6c6f0, amb: 0.78,
    ground: 'voidstone', grass: { d: 0, tint: 0x000000 }, dry: true, float: true, gravity: 0.55, music: 'void',
    enemies: [['riftling', 5, 12, 110], ['voidhorror', 3, 24, 120], ['wraith', 2, 20, 110]],
    landmark: 'The Unmaking',
    blurb: 'Reality gave up here. Islands hang, gravity forgets, and something watches.',
  },
};

// resolved centre + display order for the map screen / fast-travel list
export const OUTER = ORDER.map((id, k) => { const c = centerOf(k); Object.assign(BIOMES[id], { id, k, cx: c.x, cz: c.z, bearing: c.a }); return BIOMES[id]; });
Object.assign(BIOMES.meadow, { id: 'meadow', cx: 0, cz: 0 });

/** id of the region containing (x,z) — 'meadow' for the whole home bowl and its sub-zones. */
export function regionAt(x, z) {
  if (x * x + z * z < RING_IN * RING_IN) return 'meadow';
  const k = wedgeAt(x, z);
  return weightAt(x, z, k) > 0.02 ? ORDER[k] : 'meadow';
}
/** { id, w } — nearest outer biome and its 0..1 weight (w = 0 anywhere in the home bowl / ring). */
export function blendAt(x, z, out = { id: 'meadow', w: 0, k: -1 }) {
  const k = wedgeAt(x, z);
  out.k = k; out.id = ORDER[k]; out.w = weightAt(x, z, k);
  return out;
}
/** Landmark list for the map screen / quest system. */
export const LANDMARKS = OUTER.map((b) => ({ name: b.landmark, biome: b.short, position: { x: b.cx, z: b.cz } }));
