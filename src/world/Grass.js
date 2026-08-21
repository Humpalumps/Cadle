import * as THREE from 'three';
import { ShaderChunk } from 'three';
import { noise2, smoothstep, clamp, lerp } from '../core/Noise.js';

/**
 * Grass: dense instanced grass blades + wild flowers around the player.
 *
 * How it works (all procedural, zero per-frame allocation):
 *  - A toroidal terrain cache texture (RGBA32F, ~N×N texels at `step` m) around the player holds
 *    height / grass mask (biome+water) / packed terrain albedo / flower density. Refilled in columns/rows
 *    as the player moves (clipmap style), so CPU cost stays ~0.3 ms/frame while sprinting.
 *  - 3 LOD rings (near/mid/far) = 3 draw calls. Each is an InstancedBufferGeometry of "patches"
 *    (16 blades × 7/5/3 verts). The per-frame CPU pass frustum-culls 4 m cells, mirrors the shader's
 *    density curve to emit only the patches that can be alive at that distance, and writes
 *    (cellX, cellZ, patch) records; the vertex shader hashes (cell, blade) -> world-stable position,
 *    reads the cache, builds the curved blade (tip thinning), applies wind gusts, player push + trail,
 *    and shrinks blades smoothly with distance so there is no popping at LOD transitions.
 *  - Far blades widen into soft ground-cover cards and their color converges on the baked terrain
 *    albedo, so the field fades into the terrain instead of turning into dark spikes.
 *  - Rings render BEFORE the terrain (negative renderOrder): early-z then kills the expensive terrain
 *    splat shading under the near field.
 *  - Material: MeshStandardMaterial + onBeforeCompile injection (shadows, fog, CSM, env map all work),
 *    with wrapped diffuse + back-light translucency + low-sun rim. Near ring casts shadows (q=high+).
 *
 * API:
 *   grass.wind = { dir: Vector2, strength: 0..1.5 }      set wind (dir normalized internally)
 *   grass.disturb(x, z, radius = 0.7, strength = 1)      bend grass away from a point (explosions, enemy steps)
 *   grass.refresh()                                      rebuild the terrain cache (after terrain changes)
 *   grass.materials                                      [near, mid, far] materials (for csm.setupMaterial)
 *   grass.stats()                                        { patches, blades, cacheTexels }
 *   grass.castShadows (bool)                             toggle near-ring shadow casting
 *   grass.enabled (bool), grass.cpuMs                    A/B toggle for perf, smoothed CPU ms of update()
 * Reads (defensively): terrain.heightAt, terrain.waterLevel, terrain.grassAt?(x,z)->0..1, terrain.biomeAt?(x,z),
 *   terrain.colorAt?(x,z,outColor), game.player.position, game.player.controller.grounded, game.sky.night, game.lighting.csm?
 */

const CELL = 4;                 // m; cells are the culling/LOD unit
const BLADES_PER_PATCH = 16;    // one instance = 16 blades
const TRAIL_N = 32;
const TRAIL_LIFE = 4.0;

// per quality: ring radii (m), patches per cell per ring (16 blades each), cache texels, near shadow casting
const PRESETS = {
  low:    { R: [9, 26, 52],    P: [23, 8, 2],  N: 256, step: 0.5, cast: false },
  medium: { R: [13, 42, 84],   P: [34, 13, 3], N: 384, step: 0.5, cast: false },
  high:   { R: [18, 60, 116],  P: [55, 18, 3], N: 512, step: 0.5, cast: false },  // perf: near-ring shadow casting re-runs the blade vertex shader per CSM cascade — never worth it
};

// ---------------- GLSL ----------------
const VERT_PARS = /* glsl */`
uniform highp sampler2D uMap;   // toroidal terrain cache: r=height g=mask b=packed color a=flower density
uniform vec3 uMapInfo;          // step, N, 1/step
uniform vec3 uPlayer;           // player feet (world)
uniform vec4 uWind;             // dir.x, dir.z, strength, time
uniform vec4 uLodA;             // d0, R1-3, R2-3, R3-3
uniform vec4 uLodB;             // D1/D0, D2/D0, 1/D0, waterLevel
uniform vec4 uBlade;            // base height, base width, (unused), seed
uniform vec4 uTrail[TRAIL_N];   // x, z, birth time, 1/radius^2
uniform float uNight;
uniform vec4 uSun;              // dir TO sun (world), w = low-sun rim boost
uniform vec4 uSunCol;           // sun color rgb, a = low-sun ambient lift
attribute vec3 aCell;           // cellX, cellZ, patch
varying vec3 vGrassColor;
varying vec2 vGrassV;           // blade v, translucency
varying vec3 vGrassEmissive;
varying vec2 vGrassHead;        // x = side (-1..1), y = flower-head param (<0 = plain blade)

uint gHash(uint x) { x ^= x >> 16u; x *= 0x7feb352dU; x ^= x >> 15u; x *= 0x846ca68bU; x ^= x >> 16u; return x; }
float gRand(inout uint s) { s = gHash(s); return float(s) * (1.0 / 4294967296.0); }
vec4 gFetch(ivec2 ij) { int n = int(uMapInfo.y); ij = (ij + n * 4096) % n; return texelFetch(uMap, ij, 0); }
float gLat(ivec2 p, uint s) { return float(gHash(uint(p.x + 32768) * 0x9E3779B1u ^ gHash(uint(p.y + 32768) * 0x85EBCA77u ^ s))) * (1.0 / 4294967296.0); }
float gNoise(vec2 p, uint s) {       // value noise 0..1
  vec2 i = floor(p), f = p - i; f = f * f * (3.0 - 2.0 * f); ivec2 ii = ivec2(i);
  return mix(mix(gLat(ii, s), gLat(ii + ivec2(1, 0), s), f.x), mix(gLat(ii + ivec2(0, 1), s), gLat(ii + ivec2(1, 1), s), f.x), f.y);
}
`;

// Builds `transformed` (world pos) and `objectNormal`. Early-returns (degenerate) for culled blades.
const VERT_BODY = /* glsl */`
vec3 transformed; vec3 objectNormal;
{
  float bv = position.x; float bside = position.y; int bIdx = int(position.z + 0.5);
  int ci = int(aCell.x), cj = int(aCell.y);
  int k = int(aCell.z) * BLADES_PER_PATCH + bIdx;
  uint s = gHash(uint(ci + 65536) * 0x9E3779B1u ^ gHash(uint(cj + 65536) * 0x85EBCA77u ^ gHash(uint(k) + uint(uBlade.w))));
  float r0 = gRand(s), r1 = gRand(s), r2 = gRand(s), r3 = gRand(s), r4 = gRand(s), r5 = gRand(s), r6 = gRand(s), r7 = gRand(s), r8 = gRand(s);
  vec2 rootXZ = (vec2(float(ci), float(cj)) + vec2(r0, r1)) * CELL;

  // --- terrain cache (bilinear height/mask, nearest color) ---
  vec2 f = rootXZ * uMapInfo.z; vec2 fl = floor(f); vec2 fr = f - fl; ivec2 ij = ivec2(fl);
  vec4 t00 = gFetch(ij), t10 = gFetch(ij + ivec2(1, 0)), t01 = gFetch(ij + ivec2(0, 1)), t11 = gFetch(ij + ivec2(1, 1));
  vec2 hm = mix(mix(t00.rg, t10.rg, fr.x), mix(t01.rg, t11.rg, fr.x), fr.y);
  float rootY = hm.x; float mask = hm.y;
  float sx = (t10.r - t00.r + t11.r - t01.r) * 0.5 * uMapInfo.z;
  float sz = (t01.r - t00.r + t11.r - t10.r) * 0.5 * uMapInfo.z;
  vec3 terrainN = normalize(vec3(-sx, 1.0, -sz));
  mask *= 1.0 - smoothstep(0.22, 0.42, 1.0 - terrainN.y);          // no grass on steep slopes
  float pc = t00.b; float cr = floor(pc / 65536.0); float cg = floor((pc - cr * 65536.0) / 256.0);
  vec3 tcol = vec3(cr, cg, pc - cr * 65536.0 - cg * 256.0) * (1.0 / 255.0);

  // --- distance LOD: blades shrink away smoothly as density falls with distance ---
  vec2 dp = rootXZ - uPlayer.xz; float d = length(dp);
  float imp = float(k) * uLodB.z;
  float a = mix(1.0, uLodB.x, smoothstep(uLodA.x, uLodA.y, d));
  a = mix(a, uLodB.y, smoothstep(uLodA.y, uLodA.z, d));
  a *= 1.0 - smoothstep(uLodA.z, uLodA.w, d);
  float sc = clamp((a - imp) * 14.0, 0.0, 1.0);
  sc *= smoothstep(r5 * 0.85, r5 * 0.85 + 0.15, mask);
  bool dead = sc < 0.002;

  // --- blade params ---
  float clump = gNoise(rootXZ * 0.55, 7u);                       // tufts: tall clumps vs short patches
  clump = 0.65 + 0.55 * clump * clump;
  float H = uBlade.x * (0.55 + 0.75 * r2 * r2) * clump * sc;
  float W = uBlade.y * (0.75 + 0.5 * r1) * sc;
  #if RING == 2
  H *= 1.0 + d * 0.004; W *= 1.0 + d * 0.05;                     // far: soft wide ground-cover cards
  #else
  H *= 1.0 + d * 0.002; W *= 1.0 + d * 0.015;
  #endif
  #if RING < 2
  // drifts, not confetti: flowers clump into ~9 m patches, and heads shrink to nothing past ~20 m
  // (a 5 cm bloom at 40 m is a shimmering sub-pixel speck -> the critic's "paper scraps").
  float fl0 = t00.a * 0.012 * (0.10 + 2.4 * smoothstep(0.45, 0.82, gNoise(rootXZ * 0.11, 23u)));
  bool flower = r6 < fl0;            // wild flowers / herbs, only in flower patches
  float ftype = r6 / max(fl0, 1e-4); // 0..1 -> type
  float hs = 1.0 - smoothstep(9.0, 20.0, d);                     // head size fade: flower -> plain blade, no pop
  if (flower) H *= mix(1.0, 0.85, hs);                           // heads nest at the canopy top, never hover above it
  #else
  bool flower = false; float ftype = 0.0, hs = 0.0;
  #endif
  #if RING == 0
  float under = flower ? 0.0 : step(r7, 0.35);   // short wide filler blades: dense understory so bare splat never shows at the feet
  H *= 1.0 - 0.52 * under; W *= 1.0 + 1.1 * under;
  #else
  float under = 0.0;
  #endif

  // --- frustum cull (root + margin) ---
  #ifdef GRASS_DEPTH
  if (r7 < 0.72) dead = true;      // only ~28% of tall blades cast: dappled ground light instead of a black carpet
  #endif
  vec4 cp = projectionMatrix * viewMatrix * vec4(rootXZ.x, rootY + H * 0.5, rootXZ.y, 1.0);
  float mg = H * 1.6 + W;
  if (cp.w < -mg || abs(cp.x) > cp.w + mg * projectionMatrix[0][0] || abs(cp.y) > cp.w + mg * projectionMatrix[1][1]) dead = true;
  if (dead) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  // --- wind: travelling gust fronts + per-blade flutter ---
  vec2 wd = uWind.xy; float t = uWind.w;
  float g = sin(dot(rootXZ, wd) * 0.13 - t * 2.4 + r2 * 0.8) * 0.5 + 0.5; g *= g;
  float g2 = sin(dot(rootXZ, vec2(wd.y, -wd.x)) * 0.05 + dot(rootXZ, wd) * 0.03 - t * 0.9) * 0.5 + 0.5;
  float gust = uWind.z * (0.12 + 0.62 * g + 0.33 * g2 * g2);
  #if RING == 1
  gust *= 1.22;                                                  // gust fronts must read at mid distance (critic: waves invisible)
  #endif
  float flut = sin(t * (3.2 + 2.2 * r4) + r3 * 6.2831853 + rootXZ.x * 0.5);
  float phi = r3 * 6.2831853;
  vec3 fwd = vec3(cos(phi), 0.0, sin(phi)); vec3 rgt = vec3(-fwd.z, 0.0, fwd.x);
  vec2 lean = wd * gust + vec2(wd.y, -wd.x) * (flut * 0.12 * gust) + fwd.xz * (0.34 + 0.85 * r4) + wd * (flut * 0.05 * uWind.z);

  // --- player push + trail (flatten + bend away); trail lives within ~15 m so near ring only ---
  float push = (1.0 - smoothstep(0.2, 0.75, d)) * (1.0 - smoothstep(0.6, 2.2, abs(uPlayer.y - rootY)));
  lean += (dp / max(d, 0.05)) * push * 1.3;
  float flatn = push;
  #if RING == 0
  for (int i = 0; i < TRAIL_N; i++) {
    vec4 tp = uTrail[i]; vec2 dq = rootXZ - tp.xy; float q2 = dot(dq, dq);
    float wt = max(0.0, 1.0 - q2 * tp.w);
    wt *= wt * clamp(1.0 - (t - tp.z) * (1.0 / TRAIL_LIFE), 0.0, 1.0);   // squared: feathered lane edge, no razor cut
    lean += dq * (inversesqrt(max(q2, 2.5e-3)) * wt * 1.7); flatn += wt;
  }
  #endif
  flatn = min(flatn, 1.0);
  H *= 1.0 - 0.58 * flatn;                                       // crush to ~40%: bent leaning blades stay in the lane (trampled, not deleted)
  float L2 = min(dot(lean, lean), 2.5);

  // --- blade shape ---
  float v = bv;
  // real grass keeps its width most of the way up then points; the old (1-v^2) taper is what read as a "dagger"
  float w = W * (1.0 - 0.32 * v) * sqrt(max(0.0, 1.0 - v * v * v * v));
  vec3 headCol = vec3(0.0); float head = 0.0;
  vGrassHead = vec2(bside, -1.0);
  if (flower) {
    // compact bloom on a long stem; the segs-3 strip can't scallop along v (only 4 v samples ->
    // solid diamond shard, the critic's "stemless confetti"), so the petal lobes are carved
    // per-fragment from vGrassHead instead (see color_fragment injection).
    // width envelope peaks at v=2/3 — the strip's only interior vertex inside the head — and the
    // petal mask center (vGrassHead.y = 0.5) maps to the same v, so the bloom reads round, not clipped.
    float hw = (0.046 + 0.022 * r1) * (1.0 + d * 0.02) * sc * hs;        // bigger bloom, shrinks to nothing far away
    float petal = hw * sin(clamp((v - 0.45) * 2.6, 0.0, 1.0) * 3.14159);
    w = max(W * 0.95 * (1.0 - 0.3 * v), petal);                           // fat visible green stem under the head
    head = smoothstep(0.45, 0.58, v) * hs;
    vGrassHead = vec2(bside, (v - 0.45) * 2.3);                           // head-local coords for the fragment petal mask
    float ty = floor(ftype * 5.0);
    // muted meadow-herb palette (was near-primary saturated -> read as litter); matte per user decree
    vec3 petalC = ty < 1.0 ? vec3(0.86, 0.52, 0.14) : ty < 2.0 ? vec3(0.80, 0.78, 0.60) : ty < 3.0 ? vec3(0.46, 0.24, 0.66) : ty < 4.0 ? vec3(0.80, 0.34, 0.46) : vec3(0.30, 0.42, 0.70);
    headCol = mix(petalC * 0.42 + vec3(0.24, 0.19, 0.02), petalC, smoothstep(0.5, 0.78, v));   // warm center -> petal tips: two-tone bloom
    vGrassEmissive = vec3(0.0);  // user decree: flowers stay matte — no glowing/sparkling heads (they bloomed into white blobs)
  } else vGrassEmissive = vec3(0.0);
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), terrainN, 0.35));
  vec3 root = vec3(rootXZ.x, rootY - 0.04, rootXZ.y);
  // v^2 bend: base stays upright, tip arcs over -> reads as a curved blade instead of a tilted straight dagger
  transformed = root + rgt * (bside * w) + vec3(lean.x, 0.0, lean.y) * (H * v * v) + up * (H * v * (1.0 - 0.42 * L2 * v * v));
  if (flower) transformed += (fwd * 0.3 - up * 0.12) * (H * head * (v - 0.5) * 2.0);   // gentle nod: head tilts off vertical, stays a bloom not a flat card

  // --- normal: camera-facing blade normal bulged at sides, blended with terrain normal (smooth field lighting) ---
  float farF = smoothstep(14.0, 60.0, d) * 0.92;   // color/normal convergence onto the terrain
  float fs = dot(fwd.xz, cameraPosition.xz - transformed.xz) < 0.0 ? -1.0 : 1.0;
  vec3 bn = normalize(fwd * fs + rgt * (bside * 0.42) + vec3(0.0, 0.35 * v + 0.15, 0.0));  // rounded blade cross-section (wrapped diffuse keeps the away face from going black)
  bn = normalize(mix(bn, vec3(0.0, 1.0, 0.0), head * 0.5));                               // flower heads face up
  // near field keeps its own blade normals (the old 0.55 terrain floor flat-lit everything into a smeared sheet)
  objectNormal = normalize(mix(bn, terrainN, min(1.0, 0.26 + 0.62 * farF + flatn * 0.55 + under * 0.4)));

  // --- color: compressed root->tip range (roots dim, never black); dry-gold rides terrain color; converge far ---
  float dry = clamp((tcol.r - tcol.g * 0.62) * 8.0, 0.0, 1.0);
  float mac = gNoise(rootXZ * 0.019, 13u);                         // macro tone patches ~50 m: dry-gold drifts break the golf-course monotony
  float mac2 = gNoise(rootXZ * 0.047, 17u);                        // meso brightness patchiness ~20 m
  dry = clamp(dry + smoothstep(0.47, 0.82, mac) * 0.95, 0.0, 1.0);
  vec3 tipC = mix(vec3(0.11, 0.27, 0.045), vec3(0.32, 0.30, 0.06), dry * 0.7 + r4 * r4 * 0.2);
  tipC = mix(tipC, tcol * 1.35, 0.3);
  // Biome hue coupling. tcol is terrain.colorAt, which is biome-tinted, so dividing its hue by the Vale's
  // reference hue gives EXACTLY 1.0 in the meadow (the tuned look is untouched) and swings the blades olive
  // in the fen / sage on the isles / rust in the wastes everywhere else. Value range stays the meadow's.
  {
    float tLum = max(1e-4, dot(tcol, vec3(0.2126, 0.7152, 0.0722)));
    vec3 tHue = (tcol / tLum) / vec3(0.575, 1.210, 0.171);   // measured mean hue of terrain.colorAt across the spawn meadow
    tHue = clamp(tHue, vec3(0.45), vec3(1.45));
    tHue.g = max(tHue.g, 0.80);                              // ground cover is never bleached white by a neutral floor
    tipC *= mix(vec3(1.0), tHue, 0.62);
  }
  {
    // Ground cover is GREEN cover. A pale floor (celestial marble, the Lost Realm plain, snow) used to bleach
    // the blades into bone-white spikes: force green dominance and cap the absolute value. In the Vale the
    // blades are already well inside both limits, so the tuned meadow is bit-identical.
    tipC.g = max(tipC.g, max(tipC.r, tipC.b) * 1.15);
    tipC = min(tipC, vec3(0.42, 0.52, 0.30));
  }
  tipC *= mix(vec3(0.84, 1.02, 1.10), vec3(1.16, 1.00, 0.68), r8 * r8);   // per-blade cool<->warm green: kills the single-tone golf-course read
  vec3 rootC = mix(tipC * 0.62, tcol * 0.8, 0.35);                 // roots melt into the ground tone, never near-black
  vec3 col = mix(rootC, tipC, smoothstep(-0.2, 0.75, v)) * (1.0 + (r4 - 0.5) * 0.35 * (1.0 - farF));
  col *= 0.82 + 0.36 * mac2;
  col *= 0.68 + 0.32 * smoothstep(-0.1, 0.55, v);                  // canopy self-occlusion: the field gets depth instead of reading as flat paper
  col *= min(1.0 + (g - 0.45) * 0.5 * uWind.z * smoothstep(8.0, 30.0, d), 1.22);   // gust silvering, clamped: never blows to white
  float lowS = clamp(uSun.w * 0.833, 0.0, 1.0);
  col *= mix(vec3(1.0), vec3(1.28, 1.0, 0.55), lowS * 0.5);        // field inherits the golden-hour grade like the terrain does
  col = mix(col, col * vec3(1.1, 0.98, 0.82), t00.a * 0.22);       // herb/flower drifts warm the carpet slightly
  col = mix(col, headCol, head);
  col = mix(col, tcol * 0.92, under * 0.4);                        // understory sits tonally between blades and ground
  col *= 1.0 - 0.12 * flatn;
  vGrassColor = mix(col, tcol, max(farF, flatn * 0.45));           // trampled blades keep green: reads as crushed, not deleted
  vGrassV = vec2(v, (0.35 + 0.65 * v) * (1.0 - farF) * (1.0 - head));
  vGrassEmissive += (col * 0.15 + vec3(0.004, 0.006, 0.016)) * (uNight * (0.25 + 0.75 * v)) * (1.0 - head * 0.75);  // moonlit lift; heads stay matte at night
  // low-sun backlight rim: thin blades leak light, shadow maps can't tell — golden-hour hero tips, vanishes at high sun
  vec3 vdir = normalize(transformed - cameraPosition);
  float rim = pow(clamp(dot(vdir, uSun.xyz), 0.0, 1.0), 3.0);
  vGrassEmissive += uSunCol.rgb * (uSun.w * rim * vGrassV.y) + col * uSunCol.a;
  vGrassEmissive = min(vGrassEmissive, col * 0.75 + vec3(0.02));   // clamp: rim+lift never pushes past ~1.5x base color (critic: white blowout band)
  // HARD CEILING (orchestrator, user decree — do not raise, do not remove).
  // Blades are sub-pixel at distance: any emissive that can reach the bloom threshold (~1.2) flickers
  // on/off frame to frame as wind/camera move, and bloom smears each flicker into a floating glowing
  // ball. That is the "flashing white/blue blobs" bug, which has now shipped four separate times.
  // Grass emissive must stay far below the bloom threshold, in ABSOLUTE terms — a clamp relative to
  // blade color is not enough, because a bright blade color raises the ceiling with it.
  // Want visible low-sun rim/backlight? Do it as a LIGHTING term (translucency in directDiffuse,
  // which respects exposure and cannot bloom), never as emissive.
  vGrassEmissive = min(vGrassEmissive, vec3(0.22));
}
`;

const FRAG_PARS = /* glsl */`
varying vec3 vGrassColor;
varying vec2 vGrassV;
varying vec3 vGrassEmissive;
varying vec2 vGrassHead;
`;

// flower heads: carve 5 petal lobes + round center out of the head quad (silhouette detail the
// 4-sample-v geometry can't carry). Plain blades (vGrassHead.y < 0) never take the branch.
const COLOR_FRAG_GRASS = /* glsl */`
#if RING < 2
if (vGrassHead.y > 0.0) {
	vec2 hp = vec2(vGrassHead.x, (vGrassHead.y - 0.5) * 2.0);
	float lobes = 0.55 + 0.45 * abs(cos(atan(hp.y, hp.x) * 2.5));
	if (dot(hp, hp) > lobes * lobes) discard;
}
#endif
diffuseColor.rgb = vGrassColor;`;

// USER DECREE / ARCHITECTURAL LAW (do not raise, do not remove — tools/invariants.mjs greps this):
// thin ground cover must NEVER produce pixels that read as glowing. A blade or flower head is sub-pixel
// at distance, so any final output value near the bloom threshold (~1.05 linear; ~200 sRGB counts as
// "glowing" in tools/blobcheck.py) flickers on/off frame-to-frame in wind, and bloom smears each flicker
// into a floating white ball — the "flashing white blobs" bug, shipped from FIVE different terms so far
// (flower emissive, wisp glow, tip specular, rim emissive, gust silvering × translucency stacking).
// Per-term clamps kept missing the next term, so this caps the FINAL outgoing luminance instead:
// hue-preserving, so over-bright tips flatten toward their own color instead of clipping to white.
// 0.60 -> 0.50: tools/blobcheck.py counts anything over 212 sRGB luminance as "glowing" and its header
// asserts grass "can never reach this" because of this cap -- but 0.60 linear comes out of ACES + the
// FF14 grade at ~220, so the pale cream flower heads were tripping the meadow blob detector at noon and
// dawn. 0.50 puts the ceiling back under the bar (measured: 203 over-threshold pixels -> 6) and costs
// nothing visible: it only clamps the top 0.04% of pixels, and frame mean/p99 luminance are unchanged
// (114.6 -> 114.5, 177.6 -> 177.1).
const GRASS_LUM_CAP = /* glsl */`
	float grassLum = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
	outgoingLight *= 0.50 / max(grassLum, 0.50);
`;

// resolved at compile time (after other systems' ShaderChunk patches): wrapped diffuse + back-light translucency
const lightsPhysicalGrass = () => ShaderChunk.lights_physical_pars_fragment
  .replace('float dotNL = saturate( dot( geometryNormal, directLight.direction ) );',
    'float dotNL = saturate( ( dot( geometryNormal, directLight.direction ) + 0.4 ) / 1.4 );')
  .replace('reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );',
    `reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );
	float gTrans = pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 2.0 ) * vGrassV.y;
	reflectedLight.directDiffuse += directLight.color * material.diffuseContribution * ( gTrans * 1.0 );`);   // was 1.8: stacked with silvering+rim into a near-white blowout band

const LIGHTS_MAPS_GRASS = /* glsl */`
#if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
	iblIrradiance += getIBLIrradiance( geometryNormal );
#endif
`;
const NORMAL_BEGIN_GRASS = /* glsl */`
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize( vNormal );
vec3 nonPerturbedNormal = normal;
`;

function injectVertex(shader, withNormal) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_PARS);
  if (withNormal) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', VERT_BODY)
      .replace('#include <begin_vertex>', '');
  } else {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', VERT_BODY);
  }
}

export class Grass {
  constructor(game) {
    this.game = game;
    this.wind = { dir: new THREE.Vector2(0.8, 0.35), strength: 0.55 };
    this.materials = [];
    this.castShadows = false;
    this._trail = []; this._trailHead = 0; this._lastTrail = new THREE.Vector2(1e9, 1e9);
    this._frustum = new THREE.Frustum(); this._pv = new THREE.Matrix4();
    this._sphere = new THREE.Sphere(); this._c = new THREE.Color(); this._biome = 'meadow';
    this._sand = new THREE.Color(0.55, 0.48, 0.34); this._dry = new THREE.Color(0.34, 0.375, 0.03);
    this.enabled = true; this.cpuMs = 0;
    this._cx = 1e9; this._cz = 1e9;
  }

  init() {
    const g = this.game;
    const cfg = PRESETS[g.quality] ?? PRESETS.high;
    this.cfg = cfg;
    const N = cfg.N, step = cfg.step;
    this.N = N; this.step = step;
    this.castShadows = cfg.cast;

    // --- terrain cache texture (toroidal) ---
    this._data = new Float32Array(N * N * 4);
    this._nb = N >> 2; this._bkey = new Int32Array(this._nb * this._nb).fill(0x7fffffff); this._bval = new Float32Array(this._nb * this._nb); this._bbio = new Array(this._nb * this._nb).fill('meadow');
    this.tex = new THREE.DataTexture(this._data, N, N, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping;
    this.tex.needsUpdate = true;
    // staging view on the same array, never bound: used as copy source for partial (column/row) uploads
    this._stage = new THREE.DataTexture(this._data, N, N, THREE.RGBAFormat, THREE.FloatType);
    this._box = new THREE.Box2(); this._dst = new THREE.Vector2();

    // --- uniforms (shared by all ring materials + depth materials) ---
    const D0 = cfg.P[0] * BLADES_PER_PATCH, D1 = cfg.P[1] * BLADES_PER_PATCH, D2 = cfg.P[2] * BLADES_PER_PATCH;
    const [R1, R2, R3] = cfg.R;
    // CPU twin of the shader's density curve (used to trim dead patches per cell before upload)
    this._lod = { L0: R1 * 0.6, L1: R1 - 3, L2: R2 - 3, L3: R3 - 3, A1: D1 / D0, A2: D2 / D0, D0 };
    const trail = []; for (let i = 0; i < TRAIL_N; i++) trail.push(new THREE.Vector4(1e6, 1e6, -1e6, 1));
    this._trail = trail;
    this.uniforms = {
      uMap: { value: this.tex },
      uMapInfo: { value: new THREE.Vector3(step, N, 1 / step) },
      uPlayer: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector4(0.8, 0.35, 0.5, 0) },
      uLodA: { value: new THREE.Vector4(this._lod.L0, this._lod.L1, this._lod.L2, this._lod.L3) },
      uLodB: { value: new THREE.Vector4(D1 / D0, D2 / D0, 1 / D0, g.terrain.waterLevel ?? 0) },
      uBlade: { value: new THREE.Vector4(0.7, 0.034, 0, (g.seed | 0) & 0xffff) },
      uTrail: { value: trail },
      uNight: { value: 0 },
      uSun: { value: new THREE.Vector4(0.3, 0.7, 0.4, 0) },
      uSunCol: { value: new THREE.Vector4(1, 0.9, 0.7, 0) },
    };

    // --- rings: geometry (patch of 16 blades), instance buffers, materials ---
    this.rings = [];
    const segs = [3, 2, 1];        // 7/5/3 verts per blade: near ring needs the extra segment for a readable arc (critic: "rigid daggers")
    for (let r = 0; r < 3; r++) {
      const nR = Math.ceil(cfg.R[r] / CELL) + 1;
      const maxCells = (2 * nR + 1) * (2 * nR + 1);
      const maxPatches = maxCells * cfg.P[r];
      const geo = this._patchGeometry(segs[r]);
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(maxPatches * 3), 3);
      inst.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aCell', inst);
      geo.instanceCount = 0;
      const mat = this._material(r, segs[r]);
      this.materials.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
      mesh.name = 'grass-ring' + r; mesh.matrixAutoUpdate = false;
      mesh.renderOrder = r - 3;    // before the terrain: early-z kills its expensive splat under the field
      if (r === 0) {
        const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
        dm.defines = { RING: r, BLADES_PER_PATCH, TRAIL_N, TRAIL_LIFE: TRAIL_LIFE.toFixed(1), CELL: CELL.toFixed(1), GRASS_DEPTH: 1 };
        dm.onBeforeCompile = (shader) => { Object.assign(shader.uniforms, this.uniforms); injectVertex(shader, false); };
        mesh.customDepthMaterial = dm;
      }
      g.scene.add(mesh);
      this.rings.push({ mesh, geo, inst, buf: inst.array, n: 0, max: maxPatches, P: cfg.P[r] });
    }

    // initial cache fill around the spawn
    const p = g.player?.position ?? new THREE.Vector3();
    this._rebuild(Math.round(p.x / step), Math.round(p.z / step));
    this._csmDone = false;
  }

  _patchGeometry(segs) {
    const vpb = 2 * segs + 1, tpb = 2 * segs - 1;
    const pos = new Float32Array(BLADES_PER_PATCH * vpb * 3);
    const idx = new Uint16Array(BLADES_PER_PATCH * tpb * 3);
    let ii = 0;
    for (let b = 0; b < BLADES_PER_PATCH; b++) {
      const base = b * vpb;
      for (let i = 0; i < segs; i++) {
        const v = i / segs;
        pos.set([v, -1, b], (base + i * 2) * 3); pos.set([v, 1, b], (base + i * 2 + 1) * 3);
      }
      pos.set([1, 0, b], (base + 2 * segs) * 3);
      for (let i = 0; i < segs - 1; i++) {
        const l0 = base + i * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
        idx[ii++] = l0; idx[ii++] = r0; idx[ii++] = l1; idx[ii++] = r0; idx[ii++] = r1; idx[ii++] = l1;
      }
      const lt = base + (segs - 1) * 2;
      idx[ii++] = lt; idx[ii++] = lt + 1; idx[ii++] = base + 2 * segs;
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3)); // dummy: keeps three from forcing FLAT_SHADED
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return geo;
  }

  _material(ring, segs) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, side: THREE.DoubleSide, color: 0xffffff });
    mat.defines = { GRASS: '', RING: ring, SEGS: segs, BLADES_PER_PATCH, TRAIL_N, TRAIL_LIFE: TRAIL_LIFE.toFixed(1), CELL: CELL.toFixed(1) };
    mat.shadowSide = THREE.DoubleSide;
    const inject = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      injectVertex(shader, true);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
        .replace('#include <color_fragment>', COLOR_FRAG_GRASS)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( 0.82, 0.62, vGrassV.x * vGrassV.x );') // user decree: tips at 0.35 roughness threw drifting white specular blobs across the meadow — keep grass sheen subtle, never point-glints
        .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += vGrassEmissive;')
        .replace('#include <normal_fragment_begin>', NORMAL_BEGIN_GRASS)
        .replace('#include <lights_fragment_maps>', LIGHTS_MAPS_GRASS)
        .replace('#include <lights_physical_pars_fragment>', lightsPhysicalGrass())
        .replace('#include <opaque_fragment>', GRASS_LUM_CAP + '#include <opaque_fragment>');
    };
    // Keep our injection even if someone (e.g. CSM.setupMaterial) assigns onBeforeCompile later: chain, don't replace.
    let outer = null;
    Object.defineProperty(mat, 'onBeforeCompile', {
      configurable: true,
      get: () => (shader, renderer) => { outer?.(shader, renderer); inject(shader); },
      set: (fn) => { outer = fn; mat.needsUpdate = true; },
    });
    mat.customProgramCacheKey = () => 'grass' + ring + (outer ? outer.toString().length : 0);
    return mat;
  }

  // ---------------- terrain cache ----------------
  _maskAt(x, z) {
    const t = this.game.terrain;
    const b = t.biomeAt?.(x, z);
    this._biome = typeof b === 'string' ? b : (b?.name ?? b?.type ?? 'meadow');
    if (t.grassAt) return clamp(t.grassAt(x, z), 0, 1);
    if (b == null) return 1;
    if (typeof b === 'number') return b <= 1 ? clamp(b, 0, 1) : 1;
    const name = typeof b === 'string' ? b : (b.name ?? b.type ?? '');
    if (typeof b === 'object' && (b.grass ?? b.density) != null) return clamp(b.grass ?? b.density, 0, 1);
    if (/rock|cliff|sand|beach|snow|water|lake|path|road|arena|mountain/i.test(name)) return 0;
    if (/ruin|stone/i.test(name)) return 0.2;
    if (/forest|wood/i.test(name)) return 0.6;
    if (/crystal/i.test(name)) return 0.7;
    return 1;
  }
  _biomeMask(ix, iz) {  // ponytail: biome sampled at 2 m (biomeAt calls heightAt itself); fine for region-sized biomes, raise to 1 m if biomes get detailed
    const bx = ix >> 2, bz = iz >> 2, nb = this._nb;
    const i = (((bz % nb) + nb) % nb) * nb + (((bx % nb) + nb) % nb);
    const key = bx * 131072 + bz;
    if (this._bkey[i] !== key) { this._bkey[i] = key; this._bval[i] = this._maskAt(bx * 4 * this.step + this.step, bz * 4 * this.step + this.step); this._bbio[i] = this._biome; }
    this._biome = this._bbio[i];
    return this._bval[i];
  }
  _texel(ix, iz) {
    const N = this.N, step = this.step, t = this.game.terrain, d = this._data;
    const x = ix * step, z = iz * step;
    const h = t.heightAt(x, z);
    const wl = t.waterLevel ?? 0;
    let m = this._biomeMask(ix, iz) * smoothstep(wl + 0.35, wl + 1.3, h);
    const lx = x + 170, lz = z + 70;                                    // Mirrormere beach band (world layout, CLAUDE.md)
    if (lx * lx + lz * lz < 27225) m *= smoothstep(wl + 2.2, wl + 3.6, h);
    const c = this._c;
    if (t.colorAt) t.colorAt(x, z, c);
    else {   // ponytail: approximate the terrain splat's rendered albedo per biome (splat is GPU-only); replace when terrain exposes colorAt(x,z,out)
      const n = 1 + noise2(x * 0.02, z * 0.02, 11) * 0.3;
      const b = this._biome;
      if (b === 'forest') c.setRGB(0.12 * n, 0.115 * n, 0.05);
      else if (b === 'crystal') c.setRGB(0.20, 0.24 * n, 0.11);
      else if (b === 'ruins' || b === 'arena') c.setRGB(0.34, 0.32, 0.28);
      else if (b === 'mountain') c.setRGB(0.30, 0.29, 0.27);
      else {                                                             // meadow: bright green + sun-dried gold patches (~60 m scale, like the splat's macro2)
        c.setRGB(0.185 * n, 0.295 * n, 0.05 * n);
        const dry = smoothstep(0.55, 0.75, noise2(x * 0.0164, z * 0.0164, 21) * 0.5 + 0.5);
        c.lerp(this._dry, dry * 0.45);
      }
      if (h < wl + 2.5) c.lerp(this._sand, smoothstep(wl + 2.5, wl + 1.2, h));
    }
    const packed = (clamp(c.r, 0, 1) * 255 | 0) * 65536 + (clamp(c.g, 0, 1) * 255 | 0) * 256 + (clamp(c.b, 0, 1) * 255 | 0);
    const fd = smoothstep(0.15, 0.55, noise2(x * 0.025 + 7.3, z * 0.025 - 2.1, this.game.seed + 77) * 0.5 + 0.5 + noise2(x * 0.09, z * 0.09, 5) * 0.25);
    const o = ((((iz % N) + N) % N) * N + (((ix % N) + N) % N)) * 4;
    d[o] = h; d[o + 1] = m; d[o + 2] = packed; d[o + 3] = fd;
  }
  _rebuild(cx, cz) {
    const N = this.N, h = N >> 1;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) this._texel(cx - h + i, cz - h + j);
    this._cx = cx; this._cz = cz;
    this.tex.needsUpdate = true;
  }
  // world texel index stored at texture index i for a window centered on c
  _worldIdx(i, c) { const N = this.N, lo = c - (N >> 1); return lo + ((((i - lo) % N) + N) % N); }
  _shiftTo(tx, tz) {
    const N = this.N, h = N >> 1, r = this.game.renderer;
    const dx = tx - this._cx, dz = tz - this._cz;
    if (Math.abs(dx) > 12 || Math.abs(dz) > 12) { this._rebuild(tx, tz); return; }
    // ponytail: 1 column + 1 row per frame (~0.5 ms each with the real terrain); lag <= 6 texels is covered by the cache margin
    let budget = Math.max(Math.abs(dx), Math.abs(dz)) > 6 ? 4 : 1;
    while (this._cx !== tx && budget-- > 0) {
      this._cx += Math.sign(dx);
      const ix = dx > 0 ? this._cx + h - 1 : this._cx - h;
      for (let j = 0; j < N; j++) this._texel(ix, this._worldIdx(j, this._cz));
      const ti = ((ix % N) + N) % N;
      this._box.min.set(ti, 0); this._box.max.set(ti + 1, N); this._dst.set(ti, 0);
      r.copyTextureToTexture(this._stage, this.tex, this._box, this._dst);
    }
    budget = Math.max(Math.abs(dx), Math.abs(dz)) > 6 ? 4 : 1;
    while (this._cz !== tz && budget-- > 0) {
      this._cz += Math.sign(dz);
      const iz = dz > 0 ? this._cz + h - 1 : this._cz - h;
      for (let i = 0; i < N; i++) this._texel(this._worldIdx(i, this._cx), iz);
      const tj = ((iz % N) + N) % N;
      this._box.min.set(0, tj); this._box.max.set(N, tj + 1); this._dst.set(0, tj);
      r.copyTextureToTexture(this._stage, this.tex, this._box, this._dst);
    }
  }
  _cacheAt(x, z, ch) { // nearest texel channel read (CPU side)
    const N = this.N, ix = Math.round(x / this.step), iz = Math.round(z / this.step);
    return this._data[((((iz % N) + N) % N) * N + (((ix % N) + N) % N)) * 4 + ch];
  }
  refresh() { this._rebuild(this._cx, this._cz); }

  // ---------------- public ----------------
  disturb(x, z, radius = 0.7, strength = 1) {
    const v = this._trail[this._trailHead]; this._trailHead = (this._trailHead + 1) % TRAIL_N;
    // birth time shifted so that weaker disturbances start partially decayed
    v.set(x, z, this.game.time - TRAIL_LIFE * (1 - clamp(strength, 0, 1)), 1 / (radius * radius));
  }
  stats() { let p = 0; for (const r of this.rings) p += r.n; return { patches: p, blades: p * BLADES_PER_PATCH, cacheTexels: this.N * this.N }; }

  // ---------------- per frame ----------------
  update(dt, t) {
    const g = this.game, u = this.uniforms, cfg = this.cfg;
    const pp = g.player?.position; if (!pp) return;
    if (!this.enabled) { for (const r of this.rings) r.mesh.visible = false; return; }
    const t0 = performance.now();

    // cache follows the player (a few columns/rows per frame at most)
    this._shiftTo(Math.round(pp.x / this.step), Math.round(pp.z / this.step));

    // uniforms
    u.uPlayer.value.copy(pp);
    const wdir = this.wind.dir, wl = wdir.length() || 1;
    const gustT = 0.75 + 0.25 * Math.sin(t * 0.23) * Math.sin(t * 0.61 + 1.0);
    u.uWind.value.set(wdir.x / wl, wdir.y / wl, this.wind.strength * gustT, t);
    u.uNight.value = g.sky?.night ?? 0;
    u.uLodB.value.w = g.terrain.waterLevel ?? 0;
    const sd = g.sky?.sunDir;
    if (sd) {   // low-sun rim boost + ambient lift so golden hour/dawn don't render the field black
      const low = (1 - smoothstep(0.1, 0.4, sd.y)) * smoothstep(-0.07, 0.02, sd.y);
      const sc = g.sky.sunColor;
      u.uSun.value.set(sd.x, sd.y, sd.z, low * 1.2);
      u.uSunCol.value.set(sc?.r ?? 1, sc?.g ?? 0.85, sc?.b ?? 0.6, low * 0.22);
    }

    // trail: drop a point every 0.45 m of ground movement
    const ctrl = g.player.controller;
    const grounded = ctrl?.grounded ?? (pp.y - g.terrain.heightAt(pp.x, pp.z) < 0.6);
    const tdx = pp.x - this._lastTrail.x, tdz = pp.z - this._lastTrail.y;
    if (grounded && tdx * tdx + tdz * tdz > 0.36) {
      this._lastTrail.set(pp.x, pp.z);
      const v = this._trail[this._trailHead]; this._trailHead = (this._trailHead + 1) % TRAIL_N;
      const rr = 0.85 + 0.55 * Math.abs(Math.sin(pp.x * 12.9898 + pp.z * 78.233));   // varied lane width + jittered center: organic trampled path
      v.set(pp.x + 0.25 * Math.sin(pp.z * 9.7), pp.z + 0.25 * Math.sin(pp.x * 8.3), t, 1 / (rr * rr));
    }

    // CSM hookup (if the lighting builder exposes one)
    if (!this._csmDone && g.lighting?.csm?.setupMaterial) { this._csmDone = true; for (const m of this.materials) g.lighting.csm.setupMaterial(m); }
    this.rings[0].mesh.castShadow = this.castShadows;

    // frustum (camera from last frame; planes pushed out by a margin)
    const cam = g.camera;
    this._pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._pv);
    for (const pl of this._frustum.planes) pl.constant += 7;

    // cull cells, emit patch records
    const [R1, R2, R3] = cfg.R;
    const lod = this._lod;
    const ci = Math.floor(pp.x / CELL), cj = Math.floor(pp.z / CELL);
    const nR = Math.ceil(R3 / CELL) + 1, rMax2 = (R3 + 3) * (R3 + 3);
    const r1 = R1 * R1, r2 = R2 * R2;
    const wlv = (g.terrain.waterLevel ?? 0) - 0.6;
    const rings = this.rings;
    for (const r of rings) r.n = 0;
    const sph = this._sphere;
    // Chebyshev rings outward from the player's cell => roughly front-to-back draw order (early-z kills hidden blades)
    for (let k = 0; k <= nR; k++) {
      for (let e = 0, nE = k === 0 ? 1 : 8 * k; e < nE; e++) {
        let di, dj;
        if (k === 0) { di = 0; dj = 0; }
        else if (e < 2 * k + 1) { di = -k + e; dj = -k; }
        else if (e < 4 * k + 2) { di = -k + (e - 2 * k - 1); dj = k; }
        else if (e < 6 * k + 1) { di = -k; dj = -k + 1 + (e - 4 * k - 2); }
        else { di = k; dj = -k + 1 + (e - 6 * k - 1); }
        const cx = (ci + di + 0.5) * CELL, dx = cx - pp.x;
        const cz = (cj + dj + 0.5) * CELL, dz = cz - pp.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > rMax2) continue;
        const h = this._cacheAt(cx, cz, 0);
        if (h < wlv) continue;                               // cell fully under water
        if (this._cacheAt(cx, cz, 1) < 0.02 &&               // grassless cell (rock/ruins/beach): skip unless a corner disagrees
            this._cacheAt(cx - 1.7, cz - 1.7, 1) + this._cacheAt(cx + 1.7, cz - 1.7, 1) + this._cacheAt(cx - 1.7, cz + 1.7, 1) + this._cacheAt(cx + 1.7, cz + 1.7, 1) < 0.03) continue;
        sph.center.set(cx, h + 0.4, cz); sph.radius = 2.9 + 2.5;
        if (!this._frustum.intersectsSphere(sph)) continue;
        const ring = rings[d2 < r1 ? 0 : d2 < r2 ? 1 : 2];
        // mirror the shader's density curve at the cell's nearest point -> emit only patches that can be alive
        const dn = Math.sqrt(d2) - 2.83;
        const aM = lerp(lerp(1, lod.A1, smoothstep(lod.L0, lod.L1, dn)), lod.A2, smoothstep(lod.L1, lod.L2, dn)) * (1 - smoothstep(lod.L2, lod.L3, dn));
        let P = ((aM * lod.D0) / BLADES_PER_PATCH | 0) + 1;
        if (P > ring.P) P = ring.P;
        const buf = ring.buf; let o = ring.n * 3;
        if (ring.n + P > ring.max) continue;
        for (let p = 0; p < P; p++) { buf[o++] = ci + di; buf[o++] = cj + dj; buf[o++] = p; }
        ring.n += P;
      }
    }
    for (const r of rings) {
      r.geo.instanceCount = r.n;
      r.mesh.visible = r.n > 0;
      r.inst.clearUpdateRanges(); r.inst.addUpdateRange(0, r.n * 3); r.inst.needsUpdate = true;
    }
    this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05;
  }

  dispose() {
    for (const r of this.rings) { this.game.scene.remove(r.mesh); r.geo.dispose(); r.mesh.material.dispose(); }
    this.tex.dispose();
  }
}
