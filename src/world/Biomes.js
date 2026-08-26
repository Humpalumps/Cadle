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
 * This file is DATA + cheap queries only. The height field itself lives in terrainKernel.js, which the
 * bake worker imports directly (it used to be stringified into a Blob worker — that broke in every
 * minified build); the kernel's `BH[]` array is indexed by the same k as ORDER below — keep them in sync.
 *
 * Consumers: Terrain (splat + biomeAt), Grass (density/tint), Vegetation + Props (placement), Water
 * (dry mask), Lava, Sky (fog grade), Enemies (camps/roster), Ambient (zone beds), RPG (map + landmarks).
 */
import { smoothstep } from '../core/Noise.js';

// ---------------------------------------------------------------- geometry
export const RB = 760;                       // outer biome centres sit on this radius
export const RR = 210;                       // LANDFORM radius: how far a region's own height kernel reaches (Terrain.BH[])
// LOOK radius. The belt is a PARTITION, not nine islands in a neutral sea. Two neighbouring centres are
// 2*RB*sin(STEP/2) = 520 m apart along the chord and ~528 m along the ring arc, so the farthest a seam
// point ever sits from either centre is ~264 m. RL_CORE is set PAST that: both neighbours read full
// strength right up to the line where `wedgeAt` hands over, so the border is a line (broken up by the
// splat's own +-13 m macro noise), not a 100 m corridor where the world fades back to Vale green with a
// "The Vale" card on it. That corridor is what made a crossing read as "the world went neutral for half
// a minute" instead of "I have arrived somewhere else".
// Radially this reaches r 440..1030, i.e. a region's ground, haze, light, music and bestiary start up in
// its mountain pass. The LANDFORM mask (RR) is deliberately NOT widened — a region's look reaches past
// its own mountains and lakes; the mountains themselves do not.
export const RL_CORE = 270, RL_EDGE = 320;
export const RING_IN = 330, RING_OUT = 600;  // home mountain ring band
export const EDGE = 960;                     // world-edge wall starts here
export const THETA0 = -95 * Math.PI / 180;   // bearing of k=0 (due north: -Z)
export const STEP = 40 * Math.PI / 180;      // 9 biomes x 40 deg = 360

/** k -> biome id. Terrain.js's BH[] height kernels use the same order. */
export const ORDER = ['forest', 'tundra', 'celestial', 'dragon', 'infernal', 'lost', 'shadowfen', 'sunken', 'void'];

// Precomputed once, frozen, and handed out shared: weightAt() sits under terrain.biomeAt/grassAt/dryAt/
// gravityAt and boot alone calls it ~400k times (Water._bakeHeight + Vegetation._place), which used to be
// 400k throwaway objects. Same flat-table spirit as terrainKernel.js's BC. Every call site only READS it.
const CENTERS = Array.from({ length: 9 }, (_, k) => { const a = THETA0 + k * STEP; return Object.freeze({ x: Math.cos(a) * RB, z: Math.sin(a) * RB, a }); });
export const centerOf = (k) => CENTERS[k];

/** Nearest outer-biome index for a point (always returns one; check `weightAt` for whether we're inside it). */
export function wedgeAt(x, z) {
  let k = Math.round((Math.atan2(z, x) - THETA0) / STEP) % 9;
  return k < 0 ? k + 9 : k;
}
/** 0..1 membership of (x,z) in outer biome k: 1 out to RL_CORE, 0.5 on the seam with its neighbour, 0 past RL_EDGE. */
export function weightAt(x, z, k) {
  const c = centerOf(k);
  return smoothstep(RL_EDGE, RL_CORE, Math.hypot(x - c.x, z - c.z));
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
//   fogLum            optional haze BRIGHTNESS scale (Sky._gradeFog). Only for regions whose air is
//                     genuinely darker than the sky above it — smoke, peat reek, void murk. Default 1.
//   skyVeil           0..1: how much of that air reaches the SKY DOME itself (Sky's DOME_FRAG uVeil).
//                     Use it where the region is under a ceiling of its own weather — ash, reek, murk —
//                     and a clean blue noon sky would give the game away. Default 0. The veil also
//                     suppresses stars/aurora (smoke erases point sources first) and dims the sun disc.
//   glow / glowI      horizon glow band on the sky dome (Sky._gradeFog -> DOME_FRAG uGlow): ember light
//                     off the Wastes' lava fields, the Isles' gold memory at night. Saturated hue, tiny
//                     intensity (glowI ≤ 0.3, night-weighted) — a broad band, never a point source.
//   sun / amb         key light + ambient grade    (render/Lighting.js _gradeBiome) — what makes the
//                     Wastes read as lit by fire and the Void as lit by almost nothing
//   keyLow            optional hex (Sky._gradeFog): at LOW sun the extinction-orange key (sky.sunColor,
//                     which Lighting/Water/Grass all read) is pulled toward this hue, luminance kept.
//                     For regions whose identity collapses into the sunset hue (celestial terracotta).
//   ambNight          optional 0..1 (Sky._gradeFog): scales sky.ambientColor/groundColor at NIGHT only,
//                     by region weight. For regions whose .amb is right by day but over-lights the
//                     night floor (celestial read as daylight sepia at midnight).
//   hazeSun           optional 0..1 (Sky._gradeFog): how much the region's forced haze hue lets the
//                     time-of-day fog colour through at LOW sun. Water mist takes on sunset light in
//                     reality — this is what lets golden hour finally touch the Sunken gorge instead
//                     of the constant-mist grade repainting it every hour.
//   grass.d           ground-cover DENSITY          (world/Terrain.js grassAt -> world/Grass.js)
//   grass.tint        reference hue only — the blades actually take their colour from terrain.colorAt
//                     (which is biome-tinted from Terrain.BALB); keep the two in the same family
//   dry               no standing water            (Terrain.dryAt -> Water._bed / _bakeHeight)
//   lava              molten skin on the water AND it burns   (world/Water.js, player/Player.js)
//   sea               deep water region: ocean look + swim bed (world/Water.js, audio)
//   float             floating isles + updraft columns        (world/Props.js)
//   gravity           player gravity multiplier    (player/PlayerController.js)
//   landmark          hero prop + map pin          (world/Props.js _buildBiomeLandmarks)
//   passive           one line of RULES text on the zone card   (ui/HUD.js). ONLY for effects that are
//                     really implemented — gravity, lava damage, swimming, wading, updrafts. If you add a
//                     line here without the code behind it you have written a lie into the player's HUD.
export const BIOMES = {
  meadow: {
    k: -1, name: 'The Vale', short: 'Meadow', zone: 'meadow', level: [1, 5],
    fog: 0xa8c4de, fogMul: 1.0, sun: 0xffffff, amb: 1.0,
    grass: { d: 1.0, tint: 0xffffff }, music: 'field',
    blurb: 'Peaceful grasslands, wildflowers and the Aetheryte. Where every Vale-walker begins.',
  },
  forest: {
    name: 'Whisperwood Deep', short: 'Enchanted Forest', zone: 'forest', level: [5, 11],
    fog: 0x466e64, fogMul: 2.6, fogLum: 0.52, skyVeil: 0.42, sun: 0xc8f0d6, amb: 0.68,   // Ashenvale: shade under the canopy, DEEP teal mist between the trunks — at fogLum 0.66 the haze luminance-matched a midday sky and every far ridge clipped to flat pale mint
    ground: 'forest', grass: { d: 0.40, tint: 0x6f9c7a }, music: 'wood',   // 0.85 was a knee-high LAWN under the canopy; a forest floor is litter, moss and fern (Props KIT.forest), with grass only in the gaps
    enemies: [['sprite', 4, 8, 90], ['treant', 2, 20, 110], ['hound', 3, 12, 100]],
    landmark: 'The Elderheart',
    blurb: 'Ancient trees, fae lights and druid stones under a canopy the sun barely finds.',
  },
  tundra: {
    name: 'Frostveil Tundra', short: 'Frostveil', zone: 'tundra', level: [11, 17],
    fog: 0xc8e4f4, fogMul: 1.5, skyVeil: 0.24, sun: 0xdcecff, amb: 1.2,     // Winterspring: bright, snow-bounced, hazy with falling ice
    ground: 'snow', grass: { d: 0.03, tint: 0xa8c0d8 }, music: 'frost',
    enemies: [['frostwolf', 5, 12, 110], ['icegiant', 2, 30, 120], ['wisp', 3, 20, 110]],
    landmark: 'The Glacier Throne',
    blurb: 'Glaciers, frozen beasts and an aurora that never fully leaves the sky.',
  },
  celestial: {
    name: 'Celestial Isles', short: 'Celestial', zone: 'celestial', level: [30, 38],
    // fog was 0xe6dcff: bubble-gum lavender haze fought the gold identity; pale ivory-gold supports it and
    // keeps marble value separation at golden hour. amb was 1.45 — at night the floor read near daylight-
    // bright; 1.22 is still the brightest air in the world by day. glow: soft gold horizon memory after dark.
    // keyLow: hour-18 collapsed the zone to monochrome terracotta (crit2-celestial-b/shot-approach) — the
    // extinction-orange key fed the hemi/env/grass warm boost; pale gold keeps golden hour without the Mars
    // wash. ambNight 0.45: even at amb 1.22 the midnight floor read as daylight sepia (shot-night-ground).
    fog: 0xf0e6d2, fogMul: 0.60, sun: 0xfff2d0, amb: 1.22, glow: 0xe0aa50, glowI: 0.16,
    keyLow: 0xffe2ac, ambNight: 0.45,
    ground: 'stone', grass: { d: 0.05, tint: 0xd8e8c0 }, music: 'choir',
    enemies: [['seraph', 3, 16, 100], ['skyserpent', 2, 30, 120], ['wisp', 4, 14, 110]],
    landmark: 'The Empyrean Gate', float: true,
    passive: 'Updraft columns at the Gate carry you to the isles',
    blurb: 'Islands adrift in gold light, divine ruins and serpents that swim the air.',
  },
  dragon: {
    name: 'Dragon Peaks', short: 'Dragon Peaks', zone: 'dragon', level: [24, 32],
    fog: 0x9fa8b6, fogMul: 1.15, fogLum: 0.82, sun: 0xf0eeee, amb: 0.95,   // alpine, not desert: a warm key on warm strata is what made the Peaks read as a sandstone mesa. fogLum 0.82: far ranges keep a blue-grey value instead of clipping to fog-white paper
    ground: 'rock', grass: { d: 0.07, tint: 0xa8b090 }, music: 'drums',
    enemies: [['wyvern', 3, 30, 130], ['forgeknight', 3, 14, 100], ['golem', 2, 20, 110]],
    landmark: 'Kharaz-Dun Gate',
    blurb: 'Enormous peaks, dragon nests on the ledges, and a dwarven gate cut into the mountain.',
  },
  infernal: {
    name: 'Infernal Wastes', short: 'Infernal', zone: 'infernal', level: [18, 25],
    // 0x5c4636 @ fogLum 0.30 still tone-mapped to bright Mars-cream at noon (crit2-infernal/shot-in: the
    // noon fog luminance base is ~2 in HDR, so 30% of it is a lit desert, not smoke) — desaturated near-
    // charcoal + 0.16 makes the distance converge to black-basalt murk and the noon dome read as a smoke
    // ceiling. Verified both ways: the Cinder Maw ring still resolves at 30-150 m (fog DENSITY untouched).
    fog: 0x4a423c, fogMul: 1.85, fogLum: 0.16, skyVeil: 0.92, sun: 0xffd2b0, amb: 0.62, glow: 0xff5a1c, glowI: 0.26,   // Burning Steppes: black rock, red cracks, smoke you look through
    // fog was 0x4a1f11 (saturated red-brown): through the 0.72 veil it MIXED with the blue zenith into candy
    // pink — the smoke has to be warm grey-brown and near-total (0.88) to read as a ceiling, not a tint.
    // glow: ember-orange horizon band after dark (capped, saturated — the lava fields lighting the smoke).
    // The key was 0xff8a3c — linear (1.00, 0.25, 0.05), i.e. it multiplies almost all the green and blue out
    // of whatever it touches, so charcoal ground rendered as saturated (80, 11, 17) RED and the region read
    // as Mars, not Burning Steppes. Amber keeps the firelight and lets the rock stay rock; the RED belongs
    // to the lava, the fissure glow and the vents, which have it in their own emissives.
    // NOT `dry`: the channels bhInfernal carves reach below terrain.waterLevel, so the ONE global water
    // surface fills them — that is where the lava rivers come from (see WATER_LOOK.infernal / uLava).
    ground: 'ash', grass: { d: 0, tint: 0x000000 }, lava: true, music: 'forge',
    enemies: [['imp', 5, 12, 110], ['magmagolem', 2, 24, 115], ['drake', 2, 30, 125]],
    landmark: 'The Cinder Maw',
    passive: 'The lava burns — the channels are not water',
    blurb: 'A volcano bleeding lava rivers across black ash. Demons work the flows.',
  },
  lost: {
    name: 'The Lost Realm', short: 'Lost Realm', zone: 'lost', level: [40, 50],
    fog: 0xb4a0dc, fogMul: 0.95, skyVeil: 0.20, sun: 0xfff2f8, amb: 1.15,   // the key was 0xffe0ff: a pink light on pink ground under a pink haze, and the whole region read as candy. The violet belongs to the flagstone and the shards
    ground: 'stone', grass: { d: 0.05, tint: 0xc0b8d8 }, music: 'convergence',
    enemies: [['archon', 1, 0, 3], ['sentinel', 3, 24, 120], ['golem', 2, 30, 120], ['wraith', 3, 20, 110]],
    landmark: 'The Convergence',
    blurb: 'Where every magic in the world meets and argues. The end of the road.',
  },
  shadowfen: {
    name: 'Shadowfen', short: 'Shadowfen', zone: 'shadowfen', level: [15, 22],
    // At 13:00 the fen still read as a cheerful alpine lake: fogMul 2.4 left 2 km sightlines, fogLum 0.42 kept
    // the haze bright, skyVeil 0.62 left a third of the blue dome + white cumulus. 3.2/0.32/0.85 chokes noon
    // visibility to ~300 m under a bruised olive ceiling. amb 0.50 -> 0.42: the world-dimmest daylight.
    // 3.6/0.22 (wave 3): the near mountain slopes still sat in front of the murk as soapy spring-lime
    // (crit2-shadowfen/shot-approach upper-left) — the haze now reaches the slope band and stays bruised.
    fog: 0x46503c, fogMul: 3.6, fogLum: 0.22, skyVeil: 0.85, sun: 0x9cb47e, amb: 0.42,
    ground: 'muck', grass: { d: 0.12, tint: 0x5e6f3e }, music: 'fen',   // the fen's ground cover is REEDS (Props KIT.shadowfen), not lawn: at 0.22 a quarter of the blades still survive at full height and the region read as a green hillside
    enemies: [['wraith', 4, 14, 105], ['bogwitch', 2, 20, 110], ['hound', 3, 16, 110]],
    landmark: 'The Hagstone',
    passive: 'Peat to the knee: the fen drags at every step',
    blurb: 'Cursed water to the knee, witchlight, and things that used to be people.',
  },
  sunken: {
    // USER DECREE 2026-08-25: no underwater area. The sea basin became a tiered cascade gorge —
    // waterfalls off the ring, rapids between terraces, streets flooded at WADING depth only.
    // See docs/SUNKEN-REDESIGN-BRIEF.md. `sea` removed on purpose; do not reintroduce swimming here.
    name: 'The Sunken Kingdom', short: 'Sunken Kingdom', zone: 'sunken', level: [20, 28],
    // spray-mist over cataracts: cool pale haze, no more constant deep-cyan sea grade. sun was 0xd8ecf2 —
    // Lighting hue-forces the key to it, so golden hour arrived cyan; warm-neutral lets the hour read.
    // hazeSun 0.6: mist takes on the sunset light instead of repainting the gorge mint every hour.
    fog: 0x9ab8bc, fogMul: 1.25, skyVeil: 0.30, sun: 0xeceee6, amb: 0.95, hazeSun: 0.6,
    ground: 'sand', grass: { d: 0.02, tint: 0x6a9a90 }, music: 'deep',
    enemies: [['drowned', 4, 14, 100], ['leviathan', 2, 40, 130], ['wisp', 3, 20, 110]],
    landmark: 'The Drowned Court',
    passive: 'The cataracts drag at every step you wade',
    blurb: 'A drowned kingdom among the waterfalls. The court still stands beneath the spray.',
  },
  void: {
    name: 'The Void', short: 'The Void', zone: 'void', level: [34, 44],
    // 1.5/0.30/0.72 (wave 3, the 'no horizon' decree): midday used to show a bright white-lavender dome, a
    // crisp horizon line and both neighbours in plain view (crit2-void/shot-in) — the floor now falls off
    // into violet-black murk and the dome converges to the same air, so the horizon dissolves. Isles stay
    // readable as silhouettes against the mid-violet; stars/aurora after dark are mostly veiled — on theme.
    fog: 0x2c2040, fogMul: 1.5, fogLum: 0.30, skyVeil: 0.72, sun: 0xd6c6f0, amb: 0.78,
    ground: 'voidstone', grass: { d: 0, tint: 0x000000 }, dry: true, float: true, gravity: 0.55, music: 'void',
    enemies: [['riftling', 5, 12, 110], ['voidhorror', 3, 24, 120], ['wraith', 2, 20, 110]],
    landmark: 'The Unmaking',
    passive: 'Gravity is broken: you fall slow, you jump far. Updrafts at the Unmaking',
    blurb: 'Reality gave up here. Islands hang, gravity forgets, and something watches.',
  },
};

// resolved centre + display order for the map screen / fast-travel list
export const OUTER = ORDER.map((id, k) => { const c = centerOf(k); Object.assign(BIOMES[id], { id, k, cx: c.x, cz: c.z, bearing: c.a }); return BIOMES[id]; });
Object.assign(BIOMES.meadow, { id: 'meadow', cx: 0, cz: 0 });

/**
 * id of the region containing (x,z) — 'meadow' for the whole home bowl and its sub-zones. This is the
 * ONE definition of "which region am I standing in": `wedgeAt` flips exactly on the bisector between two
 * neighbours, so the music, the ambient bed and the name card all change on the same step. The threshold
 * only has to clear the WEAKEST point of a region, which is that seam: two centres are 520 m apart along
 * the chord but 528 m along the ring arc, so a seam weight bottoms out near 0.38 — 0.30 owns every seam
 * and still hands the belt back to the Vale on the mountain side, about 490 m out, i.e. up in the pass.
 */
export function regionAt(x, z) {
  if (x * x + z * z < RING_IN * RING_IN) return 'meadow';
  const k = wedgeAt(x, z);
  return weightAt(x, z, k) > 0.30 ? ORDER[k] : 'meadow';
}
/** { id, w } — nearest outer biome and its 0..1 weight (w = 0 anywhere in the home bowl / ring). */
export function blendAt(x, z, out = { id: 'meadow', w: 0, k: -1 }) {
  const k = wedgeAt(x, z);
  out.k = k; out.id = ORDER[k]; out.w = weightAt(x, z, k);
  return out;
}
/** Landmark list for the map screen / quest system. */
export const LANDMARKS = OUTER.map((b) => ({ name: b.landmark, biome: b.short, position: { x: b.cx, z: b.cz } }));
