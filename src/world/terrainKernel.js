// Terrain bake kernel — the pure height/texture math, NO three.js import.
// Lives apart from Terrain.js so Vite can bundle it into a real module worker (terrainWorker.js):
// the old build stringified these functions into a Blob, which broke the moment a minifier renamed
// anything (`ReferenceError: noise2 is not defined` in every production build -> silent main-thread bake).
// Terrain.js imports heightAt from here and hangs it on the prototype, so there is still exactly one
// height field in the game.
import { mulberry32, noise2, smoothstep, lerp } from '../core/Noise.js';
import { ORDER, RB, RR, EDGE, THETA0, STEP, centerOf } from './Biomes.js';

export const LAYERS = 17;    // 0 grass 1 forest 2 dirt 3 rock 4 sand 5 snow 6 stone 7 detail(nx,nz,h,macro) 8 ash-basalt 9 sastrugi-snow 10 peat 11 voidstone 12 columnar-basalt(infernal cliffs) 13 violet-flagstone(lost) 14 seabed-sand(sunken) 15 glacial-ice(tundra frozen lake) 16 granite-detail(near-camera cliff octave)

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

// ---------------------------------------------------------------- outer-biome height kernels
// Indexed by the wedge index k — SAME ORDER as Biomes.ORDER. Signature (x, z, h, s, w, cx, cz) -> h,
// where h is the base landscape, w the 0..1 region weight and (cx,cz) the region centre.
// CLOSURE-FREE on purpose: these are stringified into the bake workers alongside heightAt.
const BH = [
  function bhForest(x, z, h, s, w, cx, cz) {                                   // Whisperwood Deep: rolling wooded hills + dells
    const hills = fbm3(x * 0.006 + 31, z * 0.006 - 17, s + 201) * 11 + rmf(x * 0.011, z * 0.011, s + 202, 3) * 9;
    const dell = ss(0.62, 0.30, fbm2(x * 0.004 - 8, z * 0.004 + 12, s + 203) * 0.5 + 0.5) * 7;
    return mix(h, 15 + hills - dell, w);
  },
  function bhTundra(x, z, h, s, w, cx, cz) {                                   // Frostveil: glacier shelves + a frozen basin
    const g = fbm3(x * 0.0045 + 7, z * 0.0045 + 3, s + 211);
    let t = 24 + g * 13 + rmf(x * 0.014, z * 0.014, s + 212, 3) * 6;
    t -= 4.5 * Math.sin(t * 0.42 + n2(x * 0.009, z * 0.009, s + 213) * 3.4);   // ice terraces / pressure ridges
    const bd = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz) + 1e-3) + n2(x * 0.012, z * 0.012, s + 214) * 18;
    // FROZEN LAKE, walkable at last (wave-2 major: "no walkable ice sheet"). 4.22 sits 0.22 m ABOVE
    // terrain.waterLevel: the bowl is a solid ice SHEET you walk onto — the splat paints it ice_glacial
    // (layer 15, cracks + snow patches) and Terrain.dryAt masks the bowl so no melt puddle ever paints.
    // The liquid-meltwater read came from the old 3.35 bed: 0.65 m of real water over the whole bowl.
    t = mix(t, 4.22, ss(96, 52, bd));
    return mix(h, t, w);
  },
  function bhCelestial(x, z, h, s, w, cx, cz) {                                // Celestial Isles: shattered high plateau, chasms below the floating isles
    const pl = 62 + fbm3(x * 0.007 + 9, z * 0.007 - 4, s + 221) * 9;
    let cut = ss(0.34, 0.15, ridged3(x * 0.0065, z * 0.0065, s + 222));        // narrow gulfs between the shelves
    // APPROACH FLATTENING (props-B ask, wave 2): a gully on the walk-in bearing ~100-150 m out swallowed
    // the 34 m Empyrean Gate at mid-approach (reads at 250 m and <60 m, vanishes between). Inside a ~30 m
    // corridor along the region bearing, 95..175 m out on the HOME side only, the gulf cut is suppressed
    // so the shelf runs unbroken and the gate stays on the skyline for the whole walk.
    const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz) + 1e-3);
    {
      const r0 = Math.sqrt(x * x + z * z);
      let da = Math.abs(Math.atan2(z, x) - (THETA0 + 2 * STEP)); if (da > Math.PI) da = 2 * Math.PI - da;
      const walk = ss(30, 12, da * r0) * ss(175, 138, d) * ss(60, 95, d) * ss(775, 745, r0);
      cut *= 1 - walk;
    }
    // chasm WALLS get their own crag detail: without it the drop reads as one smooth grey dome
    const crag = rmf(x * 0.021, z * 0.021, s + 223, 4) * 9 * cut * (1 - cut) * 4;
    let t = mix(pl, pl - 48 + crag, cut);
    t = mix(t, pl, ss(115, 58, d));                                            // the Empyrean Gate stands on solid shelf, not over a gulf
    return mix(h, t, w);
  },
  function bhDragon(x, z, h, s, w, cx, cz) {                                   // Dragon Peaks: the biggest rock in the world
    const wx = x + n2(x * 0.008, z * 0.008, s + 231) * 42, wz = z + n2(x * 0.008 + 5, z * 0.008 - 3, s + 232) * 42;
    const m = rmf(wx * 0.0058, wz * 0.0058, s + 233, 3), c = rmf(wx * 0.016, wz * 0.016, s + 234, 4);
    const ledge = 9.0 * Math.sin(m * 142 * 0.21 + (x - z) * 0.008);            // nest ledges cut across the faces
    let t = 18 + m * 142 + c * c * 55 - ledge * ss(0.26, 0.62, m);
    // Three nest BENCHES: wide flat shoulders you can actually stand and fight on, at three altitudes.
    // Without them the region is one unbroken climb and the "dragon nests on the ledges" is a texture.
    const bench = ss(0.30, 0.44, m) * (1 - ss(0.52, 0.64, m));
    if (bench > 0.01) t = mix(t, Math.round(t / 26) * 26 + 4, bench * 0.72);
    const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz) + 1e-3);
    t = mix(t, 44, ss(105, 55, d));                                            // the gate needs a forecourt
    return mix(h, t, w);
  },
  function bhInfernal(x, z, h, s, w, cx, cz) {                                 // Infernal Wastes: a cracked basalt plain, cinder cones on the skyline
    // Burning Steppes is a BROKEN PLAIN you cross, not a volcano you stand inside. The old kernel put a
    // 150 m-radius, 98 m-tall cone with a 62 m caldera on the region centre, so from the heart the whole
    // view was one smooth red dome and the charcoal floor only showed on the ash plains off-centre. Now:
    // the heart is a low plain of tilted basalt plates cut by lava channels, and the volcano is three
    // smaller cinder cones off to the sides — a skyline you navigate by instead of a bowl you sit in.
    const dx = x - cx, dz = z - cz;
    const d = Math.sqrt(dx * dx + dz * dz + 1e-3) + n2(x * 0.01, z * 0.01, s + 241) * 12;
    let t = 10 + fbm3(x * 0.0085 + 5, z * 0.0085, s + 242) * 4.5 + rmf(x * 0.028, z * 0.028, s + 243, 4) * 3.0;
    // plates: fbm quantised with a cubic riser, so the plain is flat tops meeting at 2-3 m fault scarps
    // (a rolling fbm plain reads as dunes — the thing that made this a red desert).
    const p0 = (fbm2(x * 0.0075 - 4, z * 0.0075 + 9, s + 245) * 0.5 + 0.5) * 2.6;
    const pr = Math.round(p0), pd = p0 - pr;
    t += (pr + 4 * pd * pd * pd) * 2.3;
    // three cinder cones on fixed bearings, each with its own summit crater and crag detail
    let coneM = 0;
    for (let i = 0; i < 3; i++) {
      const a = 0.6 + i * 2.2, rr = 118 + i * 26;
      const ox = cx + Math.cos(a) * rr, oz = cz + Math.sin(a) * rr;
      const cd = Math.sqrt((x - ox) * (x - ox) + (z - oz) * (z - oz) + 1e-3) + n2(x * 0.02, z * 0.02, s + 246 + i) * 9;
      const m = ss(46 + i * 12, 6, cd);
      t += m * (38 + i * 13) - ss(11, 3, cd) * (13 + i * 4);
      if (m > coneM) coneM = m;
    }
    t += rmf(x * 0.05, z * 0.05, s + 249, 4) * 6.0 * coneM * (1 - coneM) * 4;   // flank crags: the cones are not meringue
    // The Cinder Maw sits in a low vent rampart, not a 62 m caldera: enough to frame the obsidian ring.
    t += 7 * ss(28, 38, d) * ss(58, 46, d) - 3.0 * ss(22, 8, d);
    // Channels are cut BELOW terrain.waterLevel on purpose: the world water surface fills them and wears the
    // molten skin (Water uLava), so the lava rivers are real geometry you can fall into, not a decal.
    // Lower frequency than the old cut: fewer, longer, wider rivers across the plain instead of a rash.
    t -= ss(0.50, 0.88, ridged3(x * 0.0075 + 3, z * 0.0075 - 2, s + 244)) * 14;
    return mix(h, t, w);
  },
  function bhLost(x, z, h, s, w, cx, cz) {                                     // The Lost Realm: ceremonial plain inside a ruined rampart ring
    const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz) + 1e-3) + n2(x * 0.011, z * 0.011, s + 251) * 12;
    let t = 32 + fbm3(x * 0.007 + 13, z * 0.007 + 9, s + 252) * 5;
    // GATE NOTCH (wave-2 major: "arrival sightline is a wall"). The rampart is cut through on the arrival
    // bearing (+105 deg): full cut inside +-8 m of the centreline, feathered to +-20 m, edges roughened so
    // the breach reads ruined, not routed. Sill ~3.6 m of residual berm over the plain — a saddle you walk,
    // with 30 m berm shoulders either side. Crossing centre ~(-157, 586), i.e. r0 568..642 on the bearing;
    // Props can frame that span with gate architecture.
    let da = Math.abs(Math.atan2(z, x) - (THETA0 + 5 * STEP)); if (da > Math.PI) da = 2 * Math.PI - da;
    const notch = ss(20, 8, da * Math.sqrt(x * x + z * z) + n2(x * 0.03, z * 0.03, s + 253) * 4);
    t += 30 * ss(118, 146, d) * ss(192, 160, d) * (1 - 0.88 * notch);          // rampart ring, pierced by the gate
    t -= 7 * ss(62, 22, d);                                                    // sunken plaza
    return mix(h, t, w);
  },
  function bhShadowfen(x, z, h, s, w, cx, cz) {                                // Shadowfen: hummocks in standing water (WL = 4)
    const hum = fbm4(x * 0.021 + 3, z * 0.021 - 7, s + 261);
    // Wetter. At 3.05 the flats sat under 0.95 m of water and the hummocks were most of the surface, so from
    // anywhere but the middle the fen read as a damp green wood. 2.45 puts the flats knee-to-thigh deep and
    // leaves the hummocks as the only dry ground — which is the region's whole passive.
    const t = 2.45 + (hum > 0 ? hum : 0) * 3.2 + fbm3(x * 0.005, z * 0.005, s + 262) * 1.3;
    return mix(h, t, w);
  },
  function bhSunken(x, z, h, s, w, cx, cz) {                                   // The Sunken Kingdom: cascade gorge (user decree 2026-08-25 — NO underwater area)
    // docs/SUNKEN-REDESIGN-BRIEF.md: the sea bowl became a tiered gorge — three broad terraces stepping
    // down from the mountain-ring side to the Drowned Court, gorge walls at the flanks. The ONE global
    // water plane (WL 4) can only flood one altitude, so: the Court basin floods at wading depth
    // (~3.45, 0.4-0.7 m of water, never over-head), the upper treads sit dry ABOVE the plane and carry
    // their water in a meandering rapid CHANNEL cut below WL — the plane fills it, and where the channel
    // crosses a riser is a waterfall face for Water to dress. Risers 5.3/5.6 m (brief: 4-8).
    const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz) + 1e-3);
    const r0 = Math.sqrt(x * x + z * z);
    const a = RB - r0 + n2(x * 0.013, z * 0.013, s + 271) * 14;                // along the approach: +210 pass side, 0 at the Court, negative behind it. Jitter -> riser lines meander
    let da = Math.abs(Math.atan2(z, x) - (THETA0 + 7 * STEP)); if (da > Math.PI) da = 2 * Math.PI - da;
    const b = da * r0;                                                         // metres off the gorge centreline
    let t = 3.45                                                               // T3: the Court basin — flooded streets at wading depth
      + 5.35 * ss(38, 56, a)                                                   // riser T3 -> T2 (waterfall face)
      + 5.6 * ss(96, 116, a)                                                   // riser T2 -> T1
      + ss(150, 205, a) * 20                                                   // entrance ramp down off the pass
      + ss(-70, -130, a) * 24                                                  // gorge back wall behind the Court
      + (fbm3(x * 0.02 + 7, z * 0.02 - 3, s + 272) - 0.5) * 0.28;              // tread micro-relief (keeps wading 0.3-0.7 m, never over-head)
    // dry causeways: raised street bands through the flooded basin, so the old kingdom's streets
    // alternate flooded/dry (the causeway tops sit ~0.6 m above the water line)
    const basinM = ss(56, 38, a) * ss(-130, -70, a);
    t += basinM * ss(0.62, 0.78, ridged3(x * 0.016, z * 0.016, s + 273)) * 1.15;
    // the rapid channel: ~10-18 m wide, meanders down the centreline, cut to 3.35 (0.65 m of fast water).
    // It slots through the upper treads and pours over each riser; gated off behind the Court.
    const ch = ss(13, 5, b + n2(x * 0.02 + 3, z * 0.02 - 5, s + 274) * 9) * ss(-60, -25, a);
    if (ch > 0.01) t = mix(t, 3.35, ch);
    t = mix(t, 4.55, ss(30, 14, d));                                           // the Court plaza stands dry (after the channel: the rapids END at the plaza rim, water round the arches) — Props raise the dais on it
    // gorge walls at the flanks, cragged so they read as cut rock
    const fl = ss(118, 168, b);
    if (fl > 0.01) t += fl * (18 + rmf(x * 0.02, z * 0.02, s + 275, 3) * 12);
    return mix(h, t, w);
  },
  function bhVoid(x, z, h, s, w, cx, cz) {                                     // The Void: shelves of broken reality over an abyss
    const r1 = ridged3(x * 0.0055 + 5, z * 0.0055 - 9, s + 281);
    const plat = 46 + fbm3(x * 0.009, z * 0.009, s + 282) * 7;                 // shelves are FLAT: you fight on them
    const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz) + 1e-3);
    // THE ABYSS (wave-2 major: the old -40 dish never read as one). The pit floor now drops to ~-100 m
    // around the heart ring, the shelf->pit transition band is HALVED (0.32..0.205, sheer walls instead
    // of a ramp), the walls carry their own crag detail (also kills the smooth-slope contour rings from
    // the 1 m bake), and the floor gets low relief so it reads as broken ground, not a bowl. Shelf tops
    // are untouched (same r1 field, same plat) — the walkable ring and the isle/updraft routes hold.
    const cut = ss(0.32, 0.205, r1);
    const pit = -40 - 62 * ss(200, 95, d) + (rmf(x * 0.016, z * 0.016, s + 284, 3) - 0.5) * 9;
    let t = mix(plat, pit, cut);
    const band = cut * (1 - cut) * 4;                                          // wall band only
    if (band > 0.02) t += band * (rmf(x * 0.019, z * 0.019, s + 283, 4) * 18 - 5);
    t = mix(t, plat, ss(120, 62, d));                                          // The Unmaking needs ground under it
    return mix(h, t, w);
  },
];
// biome centres, [cx, cz] per k — literal so the worker gets them without importing Biomes.js
export const BC = ORDER.map((_, k) => { const c = centerOf(k); return [c.x, c.z]; });

// ---------------------------------------------------------------- height field (pure, analytic)
// Reads `this.seed` — called as a Terrain method on the main thread and via `T` in the worker.
export function heightAt(x, z) {
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
    const keep = (1 - me) * (1 - low) * (1 - pl) * (1 - ar) * ss(520, 420, d0);   // home features stop at the mountain feet
    if (keep > 0.001) {                                                  // bluffs, forest hills, crystal ridges
      let add = ss(0.52, 0.62, fbm3(x * 0.004 + 11, z * 0.004 - 5, s + 31)) * 6;
      if (z < -140) { const fo = ss(-140, -220, z) * ss(300, 240, Math.abs(x)); if (fo > 0) add += fo * (3 + fbm3(x * 0.006 + 3, z * 0.006, s + 8) * 5); }
      if (x > 190) add += ss(190, 260, x) * (3 + ridged3(x * 0.008, z * 0.008, s + 9) * 9);
      h += keep * add;
    }
    if (d0 > 236 && d0 < 600) {                                          // mountain ring: craggy wall, warped crests, strata ledges — pierced by 9 passes
      // The ring is now a BAND, not a wall at the end of the world: `env` brings the land back down
      // past ~600 m so the biome belt beyond it is walkable, and every outer biome has its own notch.
      const env = ss(580, 452, d0);
      const dm = d0 + fbm3(x * 0.004, z * 0.004, s + 21) * 60;
      const mt = ss(352, 462, dm), wall = ss(326, 380, dm);
      const belt = ss(238, 306, dm) * ss(404, 340, dm) * (1 - ar);       // approach belt: rocky knolls/scree, not a featureless dirt ramp
      const th = Math.atan2(z, x) - THETA0;                              // angular distance to the NEAREST biome bearing
      const da = Math.abs(th - Math.round(th / STEP) * STEP);
      const pass = 1 - 0.86 * ss(0.26, 0.055, da);
      if (belt > 0.01) {                                                 // warped creased knolls + boulder-scale bumps across the whole approach
        const bx = x + n2(x * 0.019, z * 0.019, s + 39) * 13, bz = z + n2(x * 0.019 + 4, z * 0.019 - 6, s + 40) * 13;
        h += env * belt * (0.4 + 0.6 * pass) * (rmf(bx * 0.017, bz * 0.017, s + 29, 4) * 14 - 3.9 + n2(x * 0.062, z * 0.062, s + 30) * 1.7);
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
        let m = wall * (12 + 26 * teeth) * (0.35 + 0.65 * pass)
              + mt * ((14 + 54 * massif) * summit * pass + 52 * teeth * (0.25 + 0.75 * pass));   // ring crests ~120-175 m (CLAUDE.md: ~150); a pass bottoms out ~35 m over the meadow
        // bedding planes: amplitude, frequency, TILT and presence all vary per region, so the ring is never one corduroy
        const reg = n2(x * 0.0035, z * 0.0035, s + 28), reg2 = n2(x * 0.011 + 4.4, z * 0.011 - 2.2, s + 36);
        const bandAmt = ss(0.30, 0.74, fbm2(x * 0.0055, z * 0.0055, s + 37) * 0.5 + 0.5) * mt;
        // ~23 m-period ledges cut ACROSS the faces. At 400 m the step edge is what reads as rock rather than
        // felt, and it costs one sin of a value we already have; amplitude raised with the steeper faces.
        if (bandAmt > 0.01) m -= (4.5 + 8.5 * reg * reg) * Math.sin(m * (0.27 + 0.15 * reg) + (x - z) * 0.011 * reg + reg2 * 5) * bandAmt;
        h += m * env;
      }
    }
    // PASS ROADS. A notch in the ring is not enough: the approach belt's boulder-scale noise (+-8 m over
    // ~16 m) leaves micro-faces past 50 degrees, and a kinematic controller treats those as no-traction and
    // slides you back down — measured, the walk out of the Vale jammed at r=394 every time. So inside a
    // narrow angular band the height is blended toward a smooth radial ramp: a road over the saddle that
    // rises ~24 m over 175 m (about 8 degrees). The mountains either side keep all their roughness.
    if (d0 > 240 && d0 < 760) {
      const th2 = Math.atan2(z, x) - THETA0;
      const da2 = Math.abs(th2 - Math.round(th2 / STEP) * STEP);
      const road = ss(0.10, 0.022, da2) * ss(250, 320, d0) * ss(760, 650, d0);
      if (road > 0.01) {
        const u = (d0 - 285) / 400;                                      // 0 at the meadow foot, 1 at the belt
        const ramp = 11 + 25 * Math.sin(Math.PI * (u < 0 ? 0 : u > 1 ? 1 : u)) + n2(x * 0.02, z * 0.02, s + 44) * 0.8;
        h = mix(h, ramp, road * 0.92);
      }
    }
    if (d0 > 470) {                                                      // one of the 9 outer biomes (Biomes.js layout)
      let k = Math.round((Math.atan2(z, x) - THETA0) / STEP) % 9; if (k < 0) k += 9;
      const c = BC[k], bx = x - c[0], bz = z - c[1];
      const w = ss(RR, RR * 0.62, Math.sqrt(bx * bx + bz * bz));
      if (w > 0.001) h = BH[k](x, z, h, s, w, c[0], c[1]);
    }
    if (d0 > EDGE - 20) {
      // World edge. This is the backdrop of EVERY view in the outer belt, so it cannot be a smooth ramp —
      // an unbroken curtain around the horizon is the single most artificial thing a bounded world can do.
      // Same two-stage domain warp + creased RMF the home ring uses, so it reads as a far range with peaks
      // and saddles that the aerial haze can bite into.
      const wx = x + n2(x * 0.0062, z * 0.0062, s + 292) * 52 + n2(x * 0.021, z * 0.021, s + 296) * 9;
      const wz = z + n2(x * 0.0062 + 8.1, z * 0.0062 - 3.3, s + 293) * 52 + n2(x * 0.021 + 4.2, z * 0.021 + 6.6, s + 297) * 9;
      const massif = rmf(wx * 0.0058, wz * 0.0058, s + 294, 3);
      const crag = rmf(wx * 0.0165, wz * 0.0165, s + 295, 4);
      const summit = 0.35 + 0.9 * ss(0.24, 0.84, fbm2(x * 0.0036 + 5.2, z * 0.0036 - 6.4, s + 298) * 0.5 + 0.5);
      const e = ss(EDGE - 20, EDGE + 78, d0);
      h += e * ((26 + 132 * massif) * summit + 78 * crag * crag) + ss(EDGE + 60, EDGE + 190, d0) * 110;
    }
    return h;
}

// ======================================================================= bake kernels (run in workers; stringified, so keep them closure-free)
// One job = a band of height rows (+6 row halo) -> heights + normal/AO, plus every LAYERS-th layer texture.
export function bakeKernel(job) {
  const { seed, w, W, R, N } = job;
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
  for (let l = w; l < LAYERS; l += W) layers.push({ l, data: layerTex(l, R, seed) });
  return { hgt, nrm, layers, y0 };
}

// Tiling layer textures (period 1 in uv). RGB = linear albedo stored sRGB-encoded (the array is SRGB8_ALPHA8), A = height
// for blend sharpening. Layer 7 = detail: RG normal xz, B bump height, A low-frequency macro noise.
export function layerTex(layer, R, seed) {
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
  // leaf litter palette: desaturated russet-olive duff, occasional dull gold. The old bright red-orange
  // range tiled as "polka-dot confetti" (wave-1 forest verdict) — value range narrowed, hue pulled brown.
  const leafC = (w) => w > 0.86 ? [0.17, 0.155, 0.045] : [mix(0.115, 0.21, pm(w * 7.3, 1)), mix(0.085, 0.145, pm(w * 5.1, 1)), mix(0.035, 0.06, pm(w * 3.7, 1))];
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
    } else if (layer === 1) {     // forest floor: dark humus + LOW-frequency leaf-litter mottling + teal moss + twig grit.
      // Was two worley passes at 40-64 cells/tile: ~7 cm leaves that alias into repeating orange dots at any
      // distance ("polka-dot confetti"). Now 16-26 cells (~15-25 cm drifts) with soft edges = mottling, and
      // the moss is pulled teal so the floor sits in the Whisperwood palette instead of lawn green.
      const n1 = fbm(u, v, 5, 5);
      r = mix(0.070, 0.135, n1); g = mix(0.058, 0.110, n1); b = mix(0.038, 0.068, n1);       // humus base, deeper + cooler
      worley(u + 0.37, v + 0.61, 16, 26);                                                    // under pass: broad litter drifts
      let lh2 = 0, l1 = 0;
      if (wid > 0.30) { const c = leafC(wid); lh2 = ss(0.52, 0.34, wd) * 0.7; r = mix(r, c[0] * 0.72, lh2); g = mix(g, c[1] * 0.72, lh2); b = mix(b, c[2] * 0.72, lh2); }
      worley(u, v, 26, 16);                                                                  // over pass: smaller patches, still soft-edged
      if (wid > 0.38) { const c = leafC(wid); l1 = ss(0.46, 0.30, wd) * 0.85; r = mix(r, c[0], l1); g = mix(g, c[1], l1); b = mix(b, c[2], l1); }
      const moss = ss(0.50, 0.72, fbm(u + 2, v + 2, 4, 3)) * 0.75 * (1 - l1);
      const grit = (vnoise(u, v, 512) - 0.5) * 0.06;
      r = mix(r, 0.062, moss) + grit; g = mix(g, 0.155, moss) + grit; b = mix(b, 0.105, moss) + grit * 0.6;   // teal-moss, not lawn
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
    } else if (layer === 7) {     // detail: bump normal (rg), bump height (b), macro noise (a)
      const c = bumpH[j * R + i], k2 = R * 0.03 * 0.5;                           // slope per uv * 0.03 (same strength at any R)
      const dx = (bumpH[j * R + ((i + 1) % R)] - bumpH[j * R + ((i + R - 1) % R)]) * k2, dy = (bumpH[((j + 1) % R) * R + i] - bumpH[((j + R - 1) % R) * R + i]) * k2;
      const il = 1 / Math.sqrt(dx * dx + 1 + dy * dy);
      r = -dx * il * 0.5 + 0.5; g = -dy * il * 0.5 + 0.5; b = c; h = fbm(u + 7.7, v + 7.7, 2, 3);   // alpha: LOW-freq macro (patches ~1/6 tile scale)
    } else if (layer === 8) {     // Infernal Wastes: volcanic ash over cracked basalt (the fissure GLOW is emissive, added in the splat)
      const n1 = fbm(u, v, 7, 5), cr = ridge(u, v, 5, 4);
      const crack = ss(0.86, 1.0, cr), grit = (vnoise(u, v, 512) - 0.5) * 0.05;
      const base = mix(0.020, 0.078, n1);
      r = base * 1.05 + crack * 0.30 + grit; g = base * 0.95 + crack * 0.085 + grit * 0.7; b = base * 0.92 + crack * 0.012 + grit * 0.5;
      h = n1 * 0.7 - crack * 0.5;
    } else if (layer === 9) {     // Frostveil: glacier ice - blue-white, pressure fractures, rare sparkle (kept well under 1.0)
      const n1 = fbm(u, v, 5, 4), fr = ridge(u + 1.7, v + 1.7, 8, 3);
      const frac = ss(0.88, 1.0, fr) * 0.5, sp = vnoise(u, v, 512) > 0.991 ? 0.10 : 0;
      const base = mix(0.46, 0.70, n1);
      r = base * 0.80 * (1 - frac * 0.25) + sp; g = base * 0.92 * (1 - frac * 0.15) + sp; b = base * 1.12 + sp;
      h = n1 - frac * 0.4;
    } else if (layer === 10) {    // Shadowfen: peat muck, algae mats, gas-bubble pocks
      const n1 = fbm(u, v, 6, 5), alg = ss(0.55, 0.78, fbm(u + 4, v + 4, 3, 3));
      worley(u, v, 26, 26); const bub = ss(0.24, 0.16, wd) * 0.5, grit = (vnoise(u, v, 400) - 0.5) * 0.05;
      r = mix(0.055, 0.118, n1) + grit; g = mix(0.052, 0.108, n1) + grit; b = mix(0.030, 0.056, n1) + grit * 0.6;
      r = mix(r, 0.085, alg); g = mix(g, 0.158, alg); b = mix(b, 0.045, alg);
      r *= 1 - bub * 0.3; g *= 1 - bub * 0.2; b *= 1 - bub * 0.3;
      h = n1 * 0.6 + alg * 0.25 - bub * 0.4;
    } else if (layer === 11) {    // The Void: near-black stone shot through with violet fracture veins
      const n1 = fbm(u, v, 6, 5), vn = ridge(u + 2.3, v + 2.3, 6, 4);
      const vein = ss(0.87, 1.0, vn), grit = (vnoise(u, v, 512) - 0.5) * 0.04;
      const base = mix(0.030, 0.092, n1);
      r = base * 0.95 + vein * 0.16 + grit; g = base * 0.80 + vein * 0.05 + grit * 0.6; b = base * 1.30 + vein * 0.34 + grit;
      h = n1 * 0.7 - vein * 0.4;
    } else if (layer === 12) {    // columnar basalt (infernal cliffs/cinder cones): near-black vertical columns
      const n1 = fbm(u, v, 6, 4);
      const col = ss(-0.6, 0.9, Math.sin(u * 6.2832 * 16 + fbm(u, v * 0.4, 3, 2) * 3.2));    // column faces + shadowed joints
      const grit = (vnoise(u, v, 400) - 0.5) * 0.04;
      const base = mix(0.016, 0.052, n1) * (0.70 + 0.55 * col);
      r = base + grit; g = base * 1.02 + grit; b = base * 1.08 + grit * 0.8;
      h = col * 0.5 + n1 * 0.5;
    } else if (layer === 13) {    // Lost Realm: dark violet flagstone, faint gold inlay tracery in the joints
      const T = 6, py = v * T, idy = Math.floor(py);
      const px = u * T + (hash(idy, 5, T) > 0.5 ? 0.5 : 0), idx = Math.floor(px), fx = px - idx, fy = py - idy;
      const hv = hash(idx, idy, T), m = Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy));
      const mortar = ss(0.020, 0.007, m + (fbm(u, v, 36, 2) - 0.5) * 0.014), n1 = fbm(u + hv, v + hv, 7, 4);
      const gold = ss(0.965, 1.0, ridge(u + 4.1, v + 4.1, 5, 3)) * (hashB(idx, idy, T) > 0.45 ? 1 : 0);
      const grit = (vnoise(u + 0.6, v + 0.2, 400) - 0.5) * 0.05;
      const base = mix(0.85, 1.25, n1);
      r = mix(0.052 * base + grit, 0.028, mortar); g = mix(0.038 * base + grit, 0.020, mortar); b = mix(0.088 * base + grit, 0.042, mortar);
      r = mix(r, 0.42, gold * (1 - mortar) * 0.8); g = mix(g, 0.30, gold * (1 - mortar) * 0.8); b = mix(b, 0.10, gold * (1 - mortar) * 0.8);
      h = 1 - mortar * 0.4 + (n1 - 0.5) * 0.2;
    } else if (layer === 14) {    // sunken gorge bed: rippled sand, warm tan with cool troughs (the cascade streets' floor)
      const n1 = fbm(u, v, 7, 4), hue = fbm(u + 6, v + 6, 2, 3);
      const rip = Math.sin((u + fbm(u, v, 3, 2) * 0.25 + v * 0.2) * 6.2832 * 14) * 0.7 + Math.sin((v - u * 0.25) * 6.2832 * 7) * 0.3;
      const rb = 0.90 + 0.10 * rip;
      const grit = (vnoise(u, v, 300) - 0.5) * 0.08;
      r = mix(0.34, 0.52, n1) * mix(0.96, 1.06, hue) * rb + grit; g = mix(0.28, 0.44, n1) * mix(0.94, 1.03, hue) * rb + grit; b = mix(0.17, 0.28, n1) * mix(1.0, 1.10, hue) * rb + grit * 0.7;
      h = 0.5 + rip * 0.3 + (n1 - 0.5) * 0.4;
    } else if (layer === 15) {    // frozen-lake ice: pale glacial sheet, dark pressure-crack web, faint blue depth mottle
      const n1 = fbm(u, v, 4, 4), fr = ridge(u + 2.9, v + 2.9, 7, 3);
      const crack = ss(0.80, 0.97, fr);                                        // wider band than glacier layer 9 — the cracks must READ from eye height
      const deep = ss(0.35, 0.70, fbm(u + 5, v + 5, 3, 3)) * 0.20;             // darker teal patches: thick ice over deep water
      const base = mix(0.56, 0.74, n1) - deep;
      r = base * 0.82 * (1 - crack * 0.45); g = base * 0.93 * (1 - crack * 0.30); b = base * 1.10 * (1 - crack * 0.12);
      h = n1 * 0.8 - crack * 0.6;
    } else {                      // granite detail: fine granular grain for the near-camera cliff octave (no coursing, no bands)
      const n1 = fbm(u, v, 9, 4);
      const sp = (vnoise(u, v, 512) - 0.5) * 0.22 + (vnoise(u + 0.4, v + 0.1, 256) - 0.5) * 0.12;   // salt-and-pepper feldspar/mica speckle
      worley(u + 0.2, v + 0.7, 48, 48);
      const pit = ss(0.30, 0.18, wd) * 0.16;                                   // sparse pits
      const base = mix(0.30, 0.52, n1);
      r = base + sp - pit; g = base * 0.97 + sp - pit; b = base * 0.92 + sp * 0.9 - pit;
      h = n1 * 0.6 + sp * 1.5 + 0.2;
    }
    out[k] = enc(r); out[k + 1] = enc(g); out[k + 2] = enc(b); out[k + 3] = (h < 0 ? 0 : h > 1 ? 1 : h) * 255;
  }
  return out;
}
const T = { seed: 0, heightAt };            // the bake's `this`: heightAt is a method on both sides
