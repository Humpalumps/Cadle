import * as THREE from 'three';
import { mulberry32 } from '../core/Noise.js';
import { BIOMES } from './Biomes.js';

const SS = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };   // smoothstep, works inverted (a > b)

/**
 * Water: every basin below terrain.waterLevel (Mirrormere + any low ground) as one camera-following water surface.
 *  - Mesh: fine grid (1.6 m) around the camera + coarse skirt to the world edge, snapped to the grid so it never swims.
 *  - Waves: 4 Gerstner waves in the vertex shader (+ CPU twin for heightAt) and 3 scrolling layers of a baked tileable normal/height map.
 *  - Reflection: real planar reflection of the scene (sky/terrain/props/enemies), rendered from a mirrored camera with an oblique clip plane
 *    into a 0.5x HalfFloat target inside onBeforeRender (same trick as three's Reflector). Skipped on q=low (sky gradient fallback).
 *  - Refraction: framebuffer grab of the opaque scene (copyFramebufferToTexture) distorted by the normal, per-channel depth absorption
 *    (turquoise shallows -> deep blue), caustic dapple on the bed. Depth comes from a baked terrain-height texture (no scene depth needed).
 *  - Shoreline foam + soft depth edge, GGX sun glitter (sky.sunDir/sunColor) and moon glitter at night, Fresnel, FogExp2.
 *  - From below: real air interface — Snell's window (refracted sky/grab, sun glow) + total internal reflection
 *    outside it, then the surface sinks into per-biome water-volume fog with distance (~40-60 m visibility,
 *    denser with depth). Air fog never applies under the surface.
 *  - Infernal lava skin: lava_crust albedo, plates stretched+scrolled along the channel's downhill direction,
 *    ember glow in the cracks (saturated, hue-preserving luma cap — never a white blob), 1-tap crust parallax.
 *  - Shadowfen: opaque peat murk (extinction < 1 m), dark olive mirror, duckweed scum patches (instanced
 *    matte cards) hugging the shores, plus surface-only life — drifting tannin film and expanding
 *    marsh-gas rings — because nothing under a bog's surface can be seen at all. Sun/moon specular is
 *    per-biome capped (sp key): under the fen's overcast key a glossy glint read as washed-white blobs.
 *  - Sunken cascade gorge (docs/SUNKEN-REDESIGN-BRIEF.md): the cascade is placed by DRAINAGE, not by
 *    coverage — the region is priority-flooded and D8 flow-accumulated at init, and white water goes where
 *    a real catchment runs steeply. That yields the staircase the brief asks for (threads gather on a
 *    tread, blaze over the riser, gather again) instead of a blanket, and it has no iso-contour for a hard
 *    edge to be drawn along. Plunge foam rings + spray mist sit at EACH step's own altitude, not only at
 *    the water plane. One merged mesh, one draw call. All foam/mist is LIT colour, luma-capped — silver,
 *    never clipped white.
 * API (stable):
 *   water.level                       y of the flat water plane (= terrain.waterLevel)
 *   water.isWater(x, z)               terrain below water level here?
 *   water.heightAt(x, z)              animated surface height (level + wave displacement), for splashes/buoyancy
 *   water.submergedDepth(pos) / (x, y, z)  meters below the surface (0 when dry)
 *   water.underwater()                {submerged, depth, fogColor:THREE.Color, fogDensity} — one source of truth
 *                                     for Sky/PostFX underwater grading (fogColor/Density match the surface shader)
 *   water.mesh, water.material, water.reflectionEnabled, water.setQuality('low'|'medium'|'high')
 *   water.excludeFromReflection(obj) / includeInReflection(obj)   hide expensive objects from the reflection pass
 *   water.debug = 0|1|2|3|4|5   shader debug view (reflection / refraction grab / depth / foam / normal)
 * Owns: game.world.water
 */
const QP = {  // refl = reflection res scale, everyN = render reflection every N frames, grab = refraction framebuffer copy
  low:    { refl: 0,    fine: 128, span: 256, hq: 0, grab: 0, everyN: 1 },
  medium: { refl: 0.35, fine: 160, span: 320, hq: 1, grab: 1, everyN: 2 },
  // measured: the mirror re-render is 0.28-0.47 ms and the surface draw 0.34 ms, so the old 0.35x/every-3rd
  // was budgeting against a cost that isn't there. The detail LOD in FRAG pays for a sharper, fresher mirror:
  // 0.5x every 2nd frame kills the smeared far shore and the half-second reflection lag when you strafe.
  high:   { refl: 0.5,  fine: 200, span: 320, hq: 1, grab: 1, everyN: 2 },
};
// hidden from the planar reflection pass (vertex/CPU-heavy, visually negligible in a half-res distorted mirror)
const NO_REFLECT = /^(grass-ring|rocks-|crystals-|enemy-|vfx-|lantern-flames|eztree-trunk|eztree-leaves)/;   // ez near trees are full geometry — re-rendering them into the half-res mirror every 3rd frame was a periodic 30ms spike (perf audit); the crossed-quad impostors stay in, so the far shore still shows trees
// per-biome water look: shallow tint, deep tint, per-channel absorption (higher = light dies sooner).
// Optional keys: rt = reflection tint, rgh = roughness, det = detail-normal strength, fm = foam multiplier
// (white lace reads wrong on a peat bog), sp = sun/moon specular multiplier, rc = reflection luminance cap,
// rb = extra reflection mip bias (blur) — all lerped by biome weight.
const WATER_LOOK = {
  // peat murk: extinction inside ~0.5 m, green-black body, dark olive mirror, oily still surface (wave-1 critic).
  // rgh 0.155 -> 0.34 + sp 0.05 (wave-2 BLOCKER): the glossy lobe threw huge washed-white sun smears under the
  // overcast key (the sun uniform doesn't know about cloud) — satin sheen only, the glint can never reach white.
  // rc/rb (wave-3 major): a half-res planar mirror is SHARP, and a bog reflecting a metre-scale emissive
  // through it turned the fungus into "a green searchlight painted on the water" and the Hagstone glyphs
  // into two straight neon lines across the whole basin. A peat surface is oily and diffuse — 3.2 mips of
  // blur plus a 0.17 luminance ceiling makes both of those physically impossible instead of tuned away.
  // det 0.16 -> 0.36 (wave-4 major "everything from 2 m to 25 m is featureless water"): with extinction
  // under half a metre there is nothing to see THROUGH the surface, and a 3.2-mip, 0.17-capped mirror shows
  // nothing ON it either — so the only lever left is the ripple normal, which reads through Fresnel as
  // light/dark relief rather than as glints (rgh 0.34 + sp 0.05 make a glint impossible here by construction).
  // wave-5 BLOCKER re-tune. sh red channel raised above green (peat is TANNIN-stained: olive-BROWN, and under
  // the fen's green ambient a green-dominant sh multiplied out to exactly the "flat mint sheet" the critic
  // shot). rc 0.17 -> 0.34 + rb 3.2 -> 1.9: the 0.17 cap flattened the WHOLE mirror to one luminance — sky,
  // megaliths, banks all capped to the same value = zero contrast = "16 m trilithons cast no reflection".
  // The cap's job is only to keep a bright bank emissive from streaking; 0.34 still holds those far below
  // white while letting a dark stone silhouette exist against the capped sky. Same logic on the blur: 1.9
  // mips is still an oily surface, 3.2 was erasure.
  shadowfen: { sh: [0.058, 0.052, 0.024], dp: [0.011, 0.009, 0.004], ab: [5.50, 5.20, 8.50], rt: [0.44, 0.45, 0.36], rgh: 0.34, det: 0.36, fm: 0.25, sp: 0.05, rc: 0.34, rb: 1.9 },
  // cascade gorge (user decree 2026-08-25): clear fast mountain water at wading depth, not open ocean
  sunken:    { sh: [0.060, 0.200, 0.240], dp: [0.008, 0.045, 0.075], ab: [1.30, 0.55, 0.30], fm: 0.90, det: 0.44 },
  tundra:    { sh: [0.075, 0.215, 0.310], dp: [0.008, 0.045, 0.115], ab: [1.45, 0.55, 0.26] },   // meltwater under ice
  void:      { sh: [0.030, 0.020, 0.075], dp: [0.004, 0.002, 0.020], ab: [2.20, 2.40, 1.30] },
  infernal:  { sh: [0.180, 0.045, 0.010], dp: [0.060, 0.012, 0.002], ab: [0.60, 2.40, 3.20] },   // molten: the uLava skin does the rest
};
const COARSE = 32;   // coarse skirt cell (m); fine grid snaps to it
const G = 9.81;
// 8-neighbourhood + inverse-distance weight, for the cascade drainage solve (_buildFalls). Module-level so
// the priority flood and the D8 pass share one table and allocate nothing per cell.
const NB8 = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], [-1, -1, 0.7071], [1, -1, 0.7071], [-1, 1, 0.7071], [1, 1, 0.7071]];

// dir.x, dir.z, wavelength (m), amplitude (m) — calm lake: long gentle swell + short ripples
const WAVES = [
  [1.0, 0.3, 23.0, 0.10],
  [0.7, 0.7, 11.0, 0.060],
  [-0.3, 1.0, 6.5, 0.034],
  [0.85, -0.5, 3.6, 0.018],
].map(([dx, dz, len, amp]) => { const l = Math.hypot(dx, dz), k = 2 * Math.PI / len; return { dx: dx / l, dz: dz / l, k, amp, w: Math.sqrt(G * k) }; });
const STEEP = 0.6;
const SUM_AMP = WAVES.reduce((s, w) => s + w.amp, 0);

const VERT = /* glsl */`
uniform float uTime; uniform vec4 uWave[4]; uniform vec4 uWaveW; uniform float uSteep; uniform float uFadeR;
uniform sampler2D uHeight; uniform float uInvSize; uniform float uHeightOffset;
varying vec3 vWorld; varying vec3 vGN; varying float vViewZ; varying float vCrest;
void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  float fade = 1.0 - smoothstep(uFadeR * 0.7, uFadeR, distance(wp.xz, cameraPosition.xz));
  // waves damp out in the shallows (and can't poke through the beach): scale by local depth from the terrain bake
  float bed = texture2D(uHeight, wp.xz * uInvSize + 0.5 + uHeightOffset).r;
  fade *= smoothstep(0.05, 1.2, -bed);
  vec3 disp = vec3(0.0); vec3 n = vec3(0.0, 1.0, 0.0); float crest = 0.0;
  if (fade > 0.0) {
    for (int i = 0; i < 4; i++) {
      vec2 d = uWave[i].xy; float k = uWave[i].z; float A = uWave[i].w;
      float q = uSteep / (k * A * 4.0);
      float ph = k * dot(d, wp.xz) - uWaveW[i] * uTime;
      float s = sin(ph), c = cos(ph);
      disp.xz += q * A * d * c; disp.y += A * s;
      n.xz -= d * k * A * c; n.y -= q * k * A * s;
    }
    wp += disp * fade; n = mix(vec3(0.0, 1.0, 0.0), n, fade); crest = disp.y * fade;
  }
  vWorld = wp; vGN = normalize(n); vCrest = crest;
  vec4 mv = viewMatrix * vec4(wp, 1.0); vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
#define PI 3.14159265
uniform sampler2D uHeight; uniform sampler2D uNormal; uniform sampler2D uReflect; uniform sampler2D uGrab;
uniform sampler2D uLavaTex; uniform float uHasLavaTex;
uniform float uInvSize; uniform float uHeightOffset; uniform mat4 uReflMatrix; uniform float uHasReflect; uniform float uHasGrab; uniform vec2 uGrabSize;
uniform vec3 uSunDir; uniform vec3 uSunRad; uniform vec3 uMoonDir; uniform vec3 uMoonRad;
uniform vec3 uSkyColor; uniform vec3 uHorizonColor; uniform vec3 uAmbient; uniform vec3 uFogColor; uniform vec3 uFogParams; // density, near, far (near<far -> linear fog)
uniform float uTime; uniform float uLava; uniform float uCamBelow; uniform float uDetail; uniform float uRough; uniform float uDistort; uniform float uReflDistort;
uniform float uSpecMax; uniform float uSumAmp; uniform float uLevel; uniform vec3 uReflTint; uniform float uFoamMul; uniform float uSpecMul; uniform float uRapid;
uniform float uReflCap; uniform float uReflBlur; uniform float uDryW; uniform vec2 uFlowC; uniform float uFilm;
uniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uAbsorb; uniform float uFoamDepth; uniform float uDebug; uniform float uNight;
varying vec3 vWorld; varying vec3 vGN; varying float vViewZ; varying float vCrest;

float ggx(vec3 n, vec3 v, vec3 l, float rough) {
  float NdotL = dot(n, l); if (NdotL <= 0.0) return 0.0;
  vec3 h = normalize(l + v);
  float NdotH = max(dot(n, h), 0.0), NdotV = max(dot(n, v), 1e-3), VdotH = max(dot(v, h), 0.0);
  float a = rough * rough, a2 = a * a;
  float dd = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float F = 0.02 + 0.98 * pow(1.0 - VdotH, 5.0);
  float k = a * 0.5;
  float Gs = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));
  float x = D * F * Gs / (4.0 * NdotV + 1e-4);
  return x / (1.0 + x / uSpecMax);   // soft knee, not a hard clamp: no flat blown-white plateau at noon
}
vec3 skyGrad(vec3 r) { return mix(uHorizonColor, uSkyColor, smoothstep(-0.05, 0.5, r.y)); }

void main() {
  float bed = texture2D(uHeight, vWorld.xz * uInvSize + 0.5 + uHeightOffset).r;   // terrain height relative to water level
  float depth = -bed + vCrest;                                      // actual local depth under the displaced surface
  // derivative MUST be taken before the discard: ANGLE/D3D lowers discard to clip(), which poisons the quad's other
  // lanes -> fwidth() was garbage in exactly the quads that straddle the waterline, i.e. where the foam band lives
  float fwD = fwidth(depth);
  if (depth < -uDryW) discard;                                      // dry land well above the plane (the lava skirt widens this so the pool dissolves into its bank instead of ending on a polygon edge)
  float d0 = max(depth, 0.0);
  vec3 V = normalize(cameraPosition - vWorld);
  float dist = vViewZ;
  float t = uTime;
  vec2 p = vWorld.xz;

  // ---- bed gradient, ONE shared 4-tap. The foam band, the rapid flow frame and the lava advection each
  //      used to roll their own (or, in the foam's case, none at all). Slope is the term a shoreline band
  //      has to be measured in: a DEPTH-only band is 30 cm wide on a beach and 12 m wide on a flat pan,
  //      which is exactly why the fen basin wore "soap-marble" patches and the sunken bank wore a solid
  //      white ribbon with a razor edge (wave-3). Everything below works in metres-of-shore instead.
  vec2 huvG = p * uInvSize + 0.5 + uHeightOffset;
  float eG = 3.0 * uInvSize;
  vec2 bg = vec2(texture2D(uHeight, huvG + vec2(eG, 0.0)).r - texture2D(uHeight, huvG - vec2(eG, 0.0)).r,
                 texture2D(uHeight, huvG + vec2(0.0, eG)).r - texture2D(uHeight, huvG - vec2(0.0, eG)).r) * (1.0 / 6.0);
  float bslope = length(bg);
  float shoreD = d0 / max(bslope, 0.02);            // horizontal metres of ground between here and the waterline

  // ---- rapid flow frame (sunken cascade gorge). The treads are graded nearly flat, so the bed gradient
  //      ALONE reports "still" over the whole channel the brief promises current in. CONFINEMENT is the
  //      honest signal — but it has to be a CHANNEL test, not a "some dry ground nearby" test: the Court
  //      basin is threaded with dry causeways, so counting dry neighbours put current on the entire basin
  //      and turned it into a milky sheet. An OPPOSING PAIR of dry sides (or three of four) is a slot.
  vec2 fdir = vec2(0.0, 1.0); float fast = 0.0;
  if (uRapid > 0.001) {
    float e2 = 11.0 * uInvSize;
    float ha = step(0.15, texture2D(uHeight, huvG + vec2(e2, 0.0)).r), hb = step(0.15, texture2D(uHeight, huvG - vec2(e2, 0.0)).r);
    float hc = step(0.15, texture2D(uHeight, huvG + vec2(0.0, e2)).r), hd = step(0.15, texture2D(uHeight, huvG - vec2(0.0, e2)).r);
    float chan = max(max(ha * hb, hc * hd), smoothstep(2.6, 3.6, ha + hb + hc + hd));
    // slope 0.05->0.20, not 0.02->0.11: the basin's own micro-relief and causeway shoulders sit at 0.05-0.15
    // (measured p90 over wet cells is 0.147), so the low gate lit the whole Court up as rapids.
    fast = max(smoothstep(0.05, 0.20, bslope), chan * 0.85) * uRapid;
    // downhill where the bed says so, else down-gorge toward the Court. The rotated frame's singularity is
    // where the gradient vanishes — and there the down-gorge fallback takes over, so it is never visible.
    fdir = normalize(mix(normalize(uFlowC - p + vec2(1e-4, 1e-4)), -bg / max(bslope, 1e-4), smoothstep(0.008, 0.045, bslope)));
  }

  // ---- detail normal: scrolling layers of the baked tileable slope map, fading with distance (anti-shimmer).
  //      Layer 2/3 sample rotated coords + a macro mask trades layer weights spatially: kills the fabric-weave repeat in the 5-30 m band ----
  float str = uDetail / (1.0 + dist * 0.0090);   // was 0.012: the ripple normal died by ~40 m, leaving a flat plastic sheet with no glitter (0.0055 pushed the tile repeat into the far field)
  float macro = texture2D(uNormal, p * 0.0046 + vec2(0.006, -0.004) * t).a;
  vec4 n1 = texture2D(uNormal, p * 0.042 + vec2(0.043, 0.025) * t);
  // rotate AND domain-warp the finer layers by the coarse one: the 5-30 m band showed a fabric-weave repeat when the
  // layers stayed on the same grid, and a +-2.5 m warp at the coarse layer's own period decorrelates them for free
  vec2 p2 = mat2(0.66, -0.75, 0.75, 0.66) * p + (n1.rg * 2.0 - 1.0) * 2.5;
  vec4 n2 = texture2D(uNormal, p2 * 0.105 + vec2(-0.058, 0.047) * t);
  vec2 d = (n1.rg * 2.0 - 1.0) * (0.7 + 0.6 * macro) + (n2.rg * 2.0 - 1.0) * (0.9 - 0.55 * macro);
  // Detail LOD. Past ~130 m one ripple of the finest layer is well under a pixel, so the third normal
  // octave, the caustic dapple and the star glint stop being detail and become aliasing — they were
  // paying four texture fetches per pixel to make the far lake crawl. Fading them out is both cheaper
  // and cleaner; dist is uniform across a quad, so the branch is coherent.
  float hqNear = 1.0 - smoothstep(70.0, 130.0, dist);
#ifdef WATER_HQ
  vec4 n3 = vec4(0.5, 0.5, 1.0, 0.0);
  if (hqNear > 0.0) {
    n3 = texture2D(uNormal, p2 * 0.26 + vec2(0.081, -0.089) * t);
    d += (n3.rg * 2.0 - 1.0) * 0.35 * hqNear;
  }
#endif
  // far swell octave: past ~100 m the fine layers are averaged away by str's distance falloff and the sea
  // collapsed into a texture-less band — one large-scale fetch keeps micro-contrast out to the far shore
  float farW = smoothstep(90.0, 260.0, dist) * (1.0 - smoothstep(600.0, 900.0, dist));
  if (farW > 0.0) {
    vec4 nf = texture2D(uNormal, p * 0.012 + vec2(0.011, -0.008) * t);
    d += (nf.rg * 2.0 - 1.0) * 1.3 * farW;
  }
  // moving surface in the rapids: ripples stretched ALONG the flow, fine across it, advected downstream.
  // The same two fetches carry the white-water streaks in the foam block (their .b channel), so the whole
  // "the water is mirror-still" fix costs two taps inside the sunken channel and nothing anywhere else.
  vec4 fr1 = vec4(0.0), fr2 = vec4(0.0);
  if (fast > 0.002) {
    vec2 q = vec2(dot(p, vec2(-fdir.y, fdir.x)), dot(p, fdir));
    float sp = 1.0 + 2.2 * fast;
    // ~2.4 m across x 8 m along, and 1.3 x 4 m: at the first pass's 5 m/18 m the ripple read as one slow
    // directional smear and the streak threshold magnified the map's own texels into visible blocks.
    // LOD bias by grazing angle. Standing IN the channel the texel footprint explodes along the view and
    // the automatic derivative under-filters: the streaks resolved into a hard stipple lattice across the
    // whole surface (diag shot-d3-foammask). Blurring the flow layers at grazing costs nothing and is what
    // the water actually looks like from there.
    float graze = 1.0 - clamp(abs(V.y) * 3.0, 0.0, 1.0);
    fr1 = texture2D(uNormal, vec2(q.x * 0.42, q.y * 0.125 - t * 0.26 * sp), graze * 3.0);
    fr2 = texture2D(uNormal, vec2(q.x * 0.75 + 0.37, q.y * 0.240 - t * 0.44 * sp + 0.5), graze * 3.0);
    d = mix(d, d * 0.35 + (fr1.rg * 2.0 - 1.0) * 1.05 + (fr2.rg * 2.0 - 1.0) * 0.65, fast * 0.55);
  }
  // ---- MARSH GAS (Shadowfen). A peat bog extinguishes inside half a metre, so nothing UNDER the surface
  //      can give the 2-25 m band any detail — that is the whole mechanism behind "everything from 2 m to
  //      25 m in front of the player is featureless water". The read has to be made ON the surface, and the
  //      thing a bog actually does is belch: sparse rings expanding from one point, decaying as they go.
  //      Pure normal perturbation, no light added — the blob law is satisfied by construction.
  if (uFilm > 0.001) {
    vec2 gc = floor(p * (1.0 / 9.0));
    float hsh = fract(sin(dot(gc, vec2(41.3, 289.1))) * 43758.5453);
    if (hsh > 0.42) {
      vec2 gf = p - (gc + vec2(0.25 + hsh * 0.5, 0.25 + fract(hsh * 7.3) * 0.5)) * 9.0;
      float rr = length(gf) + 1e-4;
      float ph = fract(t * 0.085 + hsh * 3.71);
      float ring = sin((rr - ph * 5.5) * 5.2) * exp(-rr * 0.5) * (1.0 - ph) * (1.0 - ph);
      d += (gf / rr) * ring * 2.2 * uFilm;
    }
  }
  vec3 n = normalize(vec3(vGN.x - d.x * str, vGN.y, vGN.z - d.y * str));
  if (uCamBelow > 0.5) n = -n;
  float NdotV = max(dot(n, V), 0.0);
  float F = 0.032 + 0.968 * pow(1.0 - NdotV, 5.0);   // slightly above physical F0: the near field keeps a sky sheen (FF14 look)

  // ---- light reaching the water body ----
  float day = clamp(uSunDir.y * 2.5, 0.0, 1.0);
  // mostly-desaturated sun/ambient for the body: golden-hour orange x teal water = pea-green murk otherwise; crests keep the warmth via sss
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  vec3 sunBody = mix(vec3(dot(uSunRad, LUMA)), uSunRad, 0.22);
  vec3 ambBody = mix(vec3(dot(uAmbient, LUMA)), uAmbient, 0.25);
  vec3 light = sunBody * 0.5 * day + uMoonRad * 0.12 + ambBody * 0.52;   // moon mostly glitters, barely lights the body (ambient trimmed: it was milking the whole lake)
  vec3 wc = mix(uShallow, uDeep, 1.0 - exp(-d0 * 0.5));                 // fast fall to deep blue: only a true shelf reads turquoise
  vec3 scatter = wc * light;
  // forward scattering through wave crests when looking toward the sun (golden-hour glow)
  float sss = pow(max(dot(uSunDir, V), 0.0), 3.0) * (1.0 - NdotV) * (0.5 + 0.5 * clamp(vCrest / uSumAmp, -1.0, 1.0));
  scatter += uShallow * uSunRad * sss * 0.35 * day;

  // ---- refraction: framebuffer grab + per-channel absorption along the refracted path.
  //      From below the path is the CAMERA->SURFACE distance (that is the water the ray actually crosses),
  //      which is what gives the near=bright / far=absorbed gradient the flat old constant path could not ----
  vec3 R = refract(-V, n, 0.75);
  float path = (uCamBelow > 0.5) ? dist : d0 / max(0.12, -R.y);
  vec3 T = exp(-uAbsorb * path);
  vec2 suv = gl_FragCoord.xy / uGrabSize + n.xz * uDistort * clamp(d0, 0.0, 1.0) / (1.0 + dist * 0.02);
  vec3 grab = texture2D(uGrab, clamp(suv, 0.001, 0.999)).rgb;
  grab *= mix(1.0, 0.82, smoothstep(0.0, 0.6, d0));   // submerged bed reads slightly darker (wet sand); keep the sand visible through clear shallows
#ifdef WATER_HQ
  // caustic dapple on the bed: product of two scrolled height fields, projected along the refracted ray, fading with depth
  if (hqNear > 0.0) {
    vec2 bp = vWorld.xz + R.xz * path;
    // LOD bias at grazing, same reason as the flow layers below: R.xz stretches the bed footprint along
    // the view, the automatic derivative under-filters, and the shallows wore a hard diamond lattice
    // (wave-4 "visible moire", clearest looking down a beach). Blurring sub-pixel dapple costs nothing.
    float cLod = (1.0 - clamp(abs(V.y) * 3.0, 0.0, 1.0)) * 3.0;
    float c1 = texture2D(uNormal, bp * 0.13 + vec2(0.035, 0.021) * t, cLod).a;
    float c2 = texture2D(uNormal, bp * 0.095 - vec2(0.027, -0.033) * t, cLod).a;
    float caust = pow(max(c1 * c2 * 4.6 - 0.5, 0.0), 2.0);
    grab *= 1.0 + caust * hqNear * smoothstep(0.04, 0.3, d0) * exp(-d0 * 0.3) * (0.9 * day + 0.04 * uNight * clamp(uMoonDir.y * 2.0, 0.0, 1.0));
  }
#endif
  // no-grab fallback: dim the body so the turquoise stays saturated instead of washing milky-white at noon
  vec3 refr = mix(scatter * 0.6, grab * T + scatter * (1.0 - T), uHasGrab);

  // ---- reflection: near-sharp mirror. Distortion fades at grazing (fixed uv offsets tear compressed reflections into comb-teeth);
  //      near the RT edge fade to the sky gradient instead of clamping (clamped uvs smeared bright sky into solid columns) ----
  vec4 rp = uReflMatrix * vec4(vWorld, 1.0);
  vec2 ruv = rp.xy / rp.w + n.xz * uReflDistort * NdotV / (1.0 + dist * 0.05);
  // grazing bias, trimmed: the old 1.2 cap blurred the far shore into mush. uReflBlur is the per-biome
  // extra: a peat bog's mirror is oily and diffuse, and a SHARP half-res mirror is what turned a metre-scale
  // emissive into "a green searchlight painted on the water" and the Hagstone glyphs into neon laser lines.
  float rbias = clamp(dist * 0.004, 0.15, 0.7) + (1.0 - NdotV) * 0.35 + uReflBlur;
  vec3 skyR = skyGrad(reflect(-V, n)) * 0.92;
  float noRefl = 1.0 - step(0.5, uHasReflect);   // q=low (and the first frames): the flat sky gradient is the only mirror we have
  // tint the gradient fallback toward the lake body ALWAYS (0.7 weight, not just on noRefl): untinted it painted the
  // midday far field a flat milky sheet on q=low AND smeared a pale vertical column wherever the RT edge fade used it
  // (the waterline band artifact) — partial weight keeps the golden-hour horizon warmth alive in the fallback
  skyR = mix(skyR, skyR * (uShallow * 1.9 + 0.42), 0.7);
  // EDGE FADE, PER AXIS — they are not the same problem. ruv is the reflected camera's own screen position
  // under the SAME projection, so horizontally the RT is valid right to the border and the only thing that
  // can push a fetch off it is the ripple distortion, which is well under 1%. Vertically a planar mirror
  // really does lose geometry off the bottom edge at grazing. Fading BOTH at 7.5% painted a 7%-of-screen
  // column of flat sky gradient down the left AND right of every lake — a pale near-white slab with a
  // vertical seam through it, worst at Mirrormere where it ate the whole left margin of the signature vista
  // (wave-5 self-check, shot-vale-mirrormere). Product, not min, so a corner still fades on both axes.
  float redge = smoothstep(0.0, 0.012, min(ruv.x, 1.0 - ruv.x)) * smoothstep(0.0, 0.060, min(ruv.y, 1.0 - ruv.y));
  vec3 refl;
  if (uHasReflect > 0.5 && uCamBelow < 0.5) {
    // grazing views magnify the half-res RT: hard silhouettes (trunks, dunes) turned into stair-stepped blocks.
    // Mip bias alone can't fix an LOD-0 magnification, so smear 3 taps vertically — the axis planar mirrors
    // stretch along — with a width that grows toward grazing and vanishes head-on.
    // widened at night: a small VERY bright reflected source (the fen waystone beacon) is a thin vertical
    // streak in a half-res RT, and LOD-0 magnification stair-steps it (wave-2 minor). The smear axis is the
    // axis the steps run along, so 3x the width at night dissolves them; the night sky itself is smooth.
    float roff = (1.0 - NdotV) * 0.0045 * (1.0 + uNight * 1.8) * (1.0 + uReflBlur * 1.6);
    vec3 rtex = (texture2D(uReflect, clamp(ruv, 0.001, 0.999), rbias).rgb
               + texture2D(uReflect, clamp(ruv + vec2(0.0, roff), 0.001, 0.999), rbias).rgb
               + texture2D(uReflect, clamp(ruv - vec2(0.0, roff), 0.001, 0.999), rbias).rgb) * (1.0 / 3.0);
    refl = mix(skyR, rtex, redge);
  } else refl = (uCamBelow > 0.5) ? scatter : skyR;
  refl *= uReflTint;
  // hue-preserving cap (same trick as the moon trail below): at grazing angles the mirror carries the whole
  // bright sky, which reads as a washed milky-white sheet at distance — worst at q=low where the flat
  // sky-gradient fallback IS the mirror (blobcheck-gated). Sun/moon glitter lives in spec, unaffected.
  // ...and per-biome: 0.62 is right for a lake, far too bright for peat murk, where anything luminous on the
  // bank comes back as a hard-edged wedge or a straight line across the whole basin (wave-3 shadowfen major).
  float rlum = dot(refl, LUMA);
  refl *= uReflCap / max(rlum, uReflCap);

  // ---- specular: sun/moon glitter. Trail lobes use a cross-trail-squashed normal, only at grazing view angles (no brushed-metal from above),
  //      and the moon's glitter direction is elevation-clamped so a high moon still lays a long trail across the lake instead of a pool at the feet
  float rough = uRough + smoothstep(40.0, 500.0, dist) * 0.12;
  float gw = min(1.0, 4.0 * pow(1.0 - NdotV, 4.0));   // strictly grazing: elevated views must not get brushed-metal trails
  vec2 sa = normalize(uSunDir.xz + vec2(1e-4));
  vec2 spar = sa * dot(n.xz, sa);
  vec3 nSun = normalize(vec3(spar + (n.xz - spar) * 0.35, n.y).xzy);
  float mh = max(length(uMoonDir.xz), 1e-3);
  vec3 mDir = normalize(vec3(uMoonDir.x, min(uMoonDir.y, mh * 0.5), uMoonDir.z));
  vec2 ma = uMoonDir.xz / mh;
  vec2 mpar = ma * dot(n.xz, ma);
  vec3 nMoon = normalize(vec3(mpar + (n.xz - mpar) * 0.3, n.y).xzy);
  float sunTrail = gw * (1.0 - smoothstep(0.3, 0.6, uSunDir.y));   // trail is a low-sun, eye-level phenomenon
  vec3 spec = uSunRad * (ggx(n, V, uSunDir, rough) + ggx(nSun, V, uSunDir, rough * 2.2 + 0.05) * 0.8 * sunTrail);
  // moon: sharp lobe carries the per-pixel sparkle (may blow to white per-glint); the broad trail lobe is Reinhard-capped
  // so it lays a long glowing path but can never saturate into a solid white sheet
  float mtrail = ggx(nMoon, V, mDir, rough * 2.8 + 0.1);
  mtrail = mtrail / (1.0 + mtrail * 0.66);
  vec3 mspec = uMoonRad * (ggx(n, V, uMoonDir, rough) * 0.8 + mtrail * 0.9 * gw);
  spec += mspec / (1.0 + dot(mspec, LUMA) * 0.55);   // hue-preserving cap: per-pixel sparkle survives, the trail can never flatten into a white sheet
  spec *= uSpecMul;   // per-biome glint kill switch (fen murk: satin, never a washed-white smear)

  vec3 col;
  if (uCamBelow > 0.5) {
    // ---- FROM BELOW: a real air interface, not a tinted sheet. Inside Snell's window the sky/above-world
    //      refracts through (grab when we have it) with a soft sun glow; outside the critical angle the
    //      interface is a total internal mirror of the dark water body. Then the whole surface sinks into
    //      per-biome water-volume fog with distance — the "visibility ~50 m" read, denser the deeper you are.
    float k = 1.0 - 1.7778 * (1.0 - NdotV * NdotV);                    // eta^2 = 1.333^2 water->air; k <= 0 -> TIR
    float cosT = sqrt(max(k, 0.0));
    float Fw = (k <= 0.0) ? 1.0 : 0.02 + 0.98 * pow(1.0 - cosT, 5.0); // Schlick on the transmitted angle -> 1 at the critical angle
    vec3 Rw = normalize(1.3333 * (-V) + (1.3333 * NdotV - cosT) * n);  // refracted view ray into the air (n points camera-side)
    vec3 window = mix(skyGrad(Rw) * 0.92, grab, uHasGrab) * T + scatter * (1.0 - T);
    float sunW = pow(max(dot(Rw, uSunDir), 0.0), 40.0);
    vec3 sunGlow = uSunRad * sunW * 0.55 * T;                          // absorbed with distance like everything else
    sunGlow /= (1.0 + dot(sunGlow, LUMA));                             // hue-preserving cap: a glow through the window, never a white ball
    col = mix(window + sunGlow, scatter * 0.85, Fw);
    float camD = max(uLevel - cameraPosition.y, 0.0);
    float kW = 0.050 * (0.55 + 0.30 * dot(uAbsorb, vec3(0.3333))) * (1.0 + camD * 0.035);
    vec3 farCol = uDeep * light * exp(-uAbsorb * camD * 0.22);         // per-channel: blue survives -> deep blue-black falloff
    col = mix(col, farCol, 1.0 - exp(-kW * dist));
  } else {
  // night water reads more mirror-like: lift the reflection weight so moon/aurora/star sky sits on the whole surface
  float Fr = min(F * (1.0 + uNight * 1.2) + uNight * 0.03, 1.0 - noRefl * 0.3);   // no real mirror -> never a full-Fresnel white sheet
  col = mix(refr, refl, Fr) + spec;
  // ambient sheen: night lake never falls to featureless black — damped in the fen (uFilm), where it was the
  // main term behind wave-5's "the water value-inverts to a pale sheet BRIGHTER than the sky at night": peat
  // has nothing under the surface to return ambient, so at night it stays a dark mirror, not a glow sheet.
  col += uAmbient * uNight * (0.05 + 0.3 * pow(1.0 - NdotV, 3.0)) * (1.0 - 0.72 * uFilm);
#ifdef WATER_HQ
  // star-glint twinkle everywhere at night (not just the moon azimuth): sparse product threshold of two scrolling height layers
  float star = smoothstep(0.86, 0.985, n3.a) * smoothstep(0.72, 0.95, n1.a);
  // flat magnitude: the old 1/(1+dist) falloff drew a bright blue disc centred on the player. Only fade far, where it aliases.
  col += vec3(0.6, 0.75, 1.0) * (star * star * uNight * 1.15 * hqNear);   // hqNear, not its own falloff: n3 stops being fetched at 130 m, so the twinkle has to be gone by then or it pops off
#endif
  }

  // ---- shoreline foam, measured in METRES OF SHORE (shoreD), not metres of depth.
  //      The old band tested depth against a width clamped in DEPTH. On a beach that is a 30 cm lace; on a
  //      flat pan the same 30 cm of depth is twelve metres of ground, which is precisely the wave-3 pair of
  //      defects: the fen's whole basin wore pale "soap-marble" wash patches, and the sunken bank wore a
  //      solid white ribbon of constant width with a razor edge. Working in shoreD closes both at once, and
  //      a screen-space ceiling keeps it from ever becoming a wide flat slab under the player's feet.
  vec2 pf = mat2(0.31, -0.95, 0.95, 0.31) * p * 1.014 + (n1.rg * 2.0 - 1.0) * 1.4;
  float fp = n2.a * 0.6 + texture2D(uNormal, pf * 0.07 + vec2(-0.02, 0.035) * t).b * 0.7;
  // HARD hand-over to a clean continuous hairline past ~90 m: ANY per-pixel modulation of a band that is
  // 1-2 px wide aliases into evenly spaced dashes, whichever term it comes from.
  float far = smoothstep(70.0, 150.0, dist);
  float pxM = fwD / max(bslope, 0.02);                        // metres of shore covered by one screen pixel
  float bandM = max(max(min(1.15, pxM * 34.0), pxM * 2.5), 0.02);   // ~1.15 m of wash, never wider than ~34 px, never thinner than 2.5 px (0.02 floor: fwD is 0 on a perfectly flat far quad, and a zero-width smoothstep is a NaN)
  float sd = shoreD + ((fp - 0.62) * 1.1 + 0.5 * sin(t * 1.3 + fp * 9.0)) * bandM * (1.0 - far);
  float lace = texture2D(uNormal, p * 0.31 + vec2(0.05, -0.04) * t).b;
  float holes = 0.25 + 0.75 * smoothstep(0.12, 0.58, lace * 0.6 + fp * 0.4);  // lace texture: bright clumps + gaps, never fully solid
  // far away the clump/gap pattern is sub-pixel: go SOLID (no gaps to alias into dashes) and let the
  // macro field (217 m period) only swell/thin the line gently, well above zero so it never breaks
  holes = mix(holes, 0.72 + 0.28 * macro, far);
  float foam = (1.0 - smoothstep(0.0, bandM, sd)) * holes;                   // the contact lace (land side is clipped by the shore alpha)
  // wash fronts creeping up the shelf — only where there IS a shelf. A flat pan has no surf, and painting
  // one on it was the fen's decorative-marble bug.
  // THE ARC HAS TO BE AT LEAST A COUPLE OF PIXELS WIDE, for the same reason the contact lace does. Its
  // period is 1/0.55 = 1.82 m of shore and its ON-width was a fixed 0.07 of that — 13 cm, which at a
  // grazing incidence 15 m out is well under one pixel. A sub-pixel hairline whose PHASE is modulated per
  // pixel by fp does not fade, it DITHERS: the waterline wore a crawling checkerboard of dots laid out in
  // rows along the wash fronts (wave-5 self-check, shot-sk-mid-downgorge, shot-fen-8m — it reads as "moire"
  // but it is aliasing of this sinusoid, not of any texture fetch, which is why LOD bias never touched it).
  // So widen the band with the footprint (aw = one pixel, in arc-period units) and drop the amplitude as it
  // widens: close up an unchanged crisp wash front, far out a soft swell, dashes nowhere.
  float aw = clamp(pxM * 0.55, 0.018, 0.16);
  float arc = smoothstep(0.05 + aw * 2.0, 0.05 - aw * 0.5, abs(fract(sd * 0.55 + fp * 0.3 - t * 0.11) - 0.4) - 0.05)
            * (0.075 / (0.075 + aw));
  foam += arc * smoothstep(3.2 * bandM, 0.4 * bandM, sd) * smoothstep(0.5, 0.82, fp) * 0.45
        * smoothstep(0.025, 0.085, bslope) * (1.0 - smoothstep(60.0, 170.0, dist));
  // sparse wave-crest lace in open water: only the sharpest crests, never a third of the lake.
  foam += smoothstep(0.62, 0.92, vCrest / uSumAmp) * smoothstep(0.62, 0.88, fp) * 0.16;
  // White-water rapids (sunken cascade gorge). fr1/fr2 are the flow-advected pair the surface normal
  // already fetched, so the streaks are CONTINUOUS TRAILS carried downstream rather than stamped dashes —
  // and at 0.42 they read as aeration inside the water instead of paint strokes lying on it (wave-3).
  if (fast > 0.002) {
    // 0.30..0.95 (was 0.34..0.84) and 0.26 (was 0.42): a hard threshold on an 8-bit map paints solid slabs
    // and shows the map's own texels; a soft one leaves aeration threading through water you can still see.
    float streak = smoothstep(0.42, 0.98, fr1.b * 0.60 + fr2.b * 0.55);
    foam += fast * (streak * 0.16 + smoothstep(0.35, 0.06, shoreD) * 0.12);   // sparse threads + froth shearing off the bank; the water between them stays clear
  }
  // far field: the line fades by AMPLITUDE (a dim continuous hairline), never by punching gaps in it.
  // 0.86 ceiling: aerated water is never opaque paint — the body always shows through it.
  // far cap 200-480 -> 280-650: from the sunken pass (~500-600 m out) the cascade treads' white threads were
  // fully faded, which was half of "no staircase of water from the approach". The far band is a continuous
  // amplitude-faded hairline by then (no gaps), so extending it cannot re-introduce the dash aliasing.
  foam = clamp(foam, 0.0, 1.0) * uFoamMul * (1.0 - 0.55 * far) * (1.0 - smoothstep(280.0, 650.0, dist)) * (1.0 - uCamBelow) * 0.86;
  // silver, not chalk: pull the foam colour toward the local water hue so it stays a saturated highlight
  // (blob law — saturate the colour, cap the value) instead of a neutral white that tone-maps to paper.
  vec3 foamCol = mix(vec3(0.80), vec3(0.70) + uShallow * 0.95, 0.4) * (uSunRad * max(dot(vGN, uSunDir), 0.0) * 0.4 + uAmbient * 1.1 + uMoonRad * 0.35);
  foamCol /= (1.0 + dot(foamCol, LUMA) * 0.35);   // blob law on the lace: golden-hour sun radiance pushed this past the bloom threshold
  col = mix(col, foamCol, foam);

  // ---- TANNIN FILM (Shadowfen): drifting rafts of peat scum and open black water, two scales (28 m and
  //      90 m) so the fen has macro composition as well as texture. Purely MULTIPLICATIVE and it never
  //      exceeds 1.12 on a surface whose luminance is ~0.03 — it can darken the bog, it cannot light it.
  if (uFilm > 0.001 && uCamBelow < 0.5) {
    float f1 = texture2D(uNormal, p * 0.036 + vec2(0.0035, -0.0026) * t).a;
    float f2 = texture2D(uNormal, p * 0.011 - vec2(0.0018, 0.0044) * t).a;
    // third octave at ~7 m, and a WIDE smoothstep: two smooth octaves alone plateau into big flat lobes
    // that read as marbled paint (the exact charge levelled at the wave-3 scum cards). Broken edges and a
    // gradient instead of plateaus is the difference between floating scum and an oil slick.
    float f3 = texture2D(uNormal, p * 0.145 + vec2(0.010, 0.007) * t).a;
    float sheen = smoothstep(0.26, 0.88, f1 * 0.50 + f2 * 0.48 + f3 * 0.22);
    // SCUM IS A MATERIAL, NOT A TINT. The old form was a pure multiply spanning 0.75..1.10 — proportionally
    // that sounds like plenty, but the fen's surface luminance is ~0.09, so the whole range of the effect was
    // +-0.01 and the 2-25 m band stayed exactly as featureless as the finding said (wave-5 self-check,
    // shot-fen-8m: a flat olive sheet). A raft of peat scum is its own diffusely-lit surface sitting ON the
    // black water, so it has to be MIXED IN, at a magnitude set by the light, not by the water underneath it.
    // Blob law: the colour is the fen's own shallow hue at unit luminance (a hue that survives ACES), the
    // magnitude is 0.055 of the local key, and the whole thing is hue-preserving-capped at 0.5 luminance —
    // a bog raft cannot approach the bloom threshold by construction, in any weather, at any hour.
    vec3 hue = uShallow / max(dot(uShallow, LUMA), 1e-4);
    vec3 scum = hue * 0.055 * (uAmbient * 2.4 + uSunRad * max(dot(vGN, uSunDir), 0.0) * 0.5 + uMoonRad * 0.7);
    scum /= (1.0 + dot(scum, LUMA) * 2.0);
    float sw = uFilm * (1.0 - smoothstep(180.0, 420.0, dist));
    col = mix(col, col * 0.80 + scum * sheen, sw);
  }

  // ---- fog (matches three's FogExp2 / Fog on view depth). AIR fog — it never applies under the surface:
  //      the below branch already sank the surface into its own water-volume fog ----
  float fog = (uFogParams.z > uFogParams.y) ? smoothstep(uFogParams.y, uFogParams.z, vViewZ) : 1.0 - exp(-uFogParams.x * uFogParams.x * vViewZ * vViewZ);
  col = mix(col, uFogColor, fog * (1.0 - uCamBelow));

  // knife-edge shore normally (water identity survives at 2 cm depth) — but a peat fen's waterline is water
  // SOAKING INTO the bank, not a cut: widen the ramp with uFilm so on the fen's flat pans the shoreline is a
  // metres-wide soft gradient instead of the hard polygon polyline of the terrain triangulation (wave-5 blocker).
  float alpha = smoothstep(0.0, 0.045 + 0.16 * uFilm, depth);
  // no grab -> alpha-blend fallback: opacity from absorption, but Fresnel sheen + foam always survive (never a bare bed)
  float cover = clamp(1.0 - dot(T, vec3(0.3333)), 0.0, 1.0);
  alpha *= mix(clamp(cover + F * 2.5 + foam + 0.25, 0.0, 1.0) * 0.95, 1.0, uHasGrab);
  alpha = max(alpha, foam * smoothstep(0.0, 0.02, depth));                      // the contact lace survives the shore alpha ramp
  // from below the interface is optically closed (TIR mirror / absorbed window) — it only stays a little
  // translucent in the first arm's length of submergence so ducking under is not a hard cut
  if (uCamBelow > 0.5) alpha = mix(0.88, 1.0, smoothstep(0.2, 1.0, max(uLevel - cameraPosition.y, 0.0)));
  // Lava. The Infernal channels are the same water surface wearing a molten skin: dark basalt crust plates
  // riding on incandescent flow, glow in the CRACKS between the plates, everything advected downhill along
  // the channel. ARCHITECTURAL LAW — the hot colour is a deep SATURATED orange, hue-preserving-capped in
  // luminance, so it tone-maps as fire instead of clipping into a white blob.
  if (uLava > 0.001) {
    vec2 fd = normalize(bg + vec2(1e-4, 3e-4));                       // +x of the flow frame runs downhill (shared bed gradient)
    vec3 lcol;
    if (uHasLavaTex > 0.5) {
      // Flow-map ping-pong advection. NO rotated UV frame: a frame that follows the downhill direction has a
      // singularity wherever the flow converges (every pool centre), which rendered the whole surface as a
      // hypnotic radial vortex (wave-2 probe). The plates keep a stable world-space grid; two phase-offset
      // copies drift along the local flow and crossfade so neither phase's reset is ever visible. The pair is
      // also nudged apart along the flow, so their blend motion-blurs the cracks into directional streaks.
      vec3 t2 = texture2D(uLavaTex, vWorld.xz * 0.016).rgb;             // macro octave: static, breaks the pool into fields
      float hgt = dot(t2, vec3(0.5, 0.35, 0.15));
      vec2 po = V.xz * 0.06 * (0.35 - hgt * 0.7);                       // 1-tap parallax: crust plates ride above the glow
      // 0.125/0.14 -> 0.17/0.30: the crust was creeping at ~0.35 m/s, which reads as a still photograph at
      // any distance. 0.30 UV of drift per 5.9 s cycle over a 20 m tile is ~1.0 m/s — a crust that visibly
      // rides the flow (wave-3 "give the surface crust motion").
      float ph1 = fract(uTime * 0.17), ph2 = fract(ph1 + 0.5);
      float bl = abs(ph1 * 2.0 - 1.0);
      vec2 base = vWorld.xz * 0.05 + po;
      vec3 ta = texture2D(uLavaTex, base - fd * 0.30 * (ph1 - 0.5)).rgb;
      vec3 tb = texture2D(uLavaTex, base - fd * (0.30 * (ph2 - 0.5) + 0.04)).rgb;
      vec3 t1 = mix(ta, tb, bl);
      float lfar = smoothstep(35.0, 150.0, dist);
      t1 = mix(t1, t2, lfar * 0.7);                                     // fine plates alias into sparkle at distance: hand over to the macro field
      float emA = smoothstep(0.16, 0.60, ta.r - ta.b * 0.55), emB = smoothstep(0.16, 0.60, tb.r - tb.b * 0.55);
      float ember = max(mix(emA, emB, bl), 0.6 * max(emA, emB));        // max of the flow-offset pair elongates the glow along the flow
      float pulse = 0.82 + 0.18 * sin(uTime * 0.9 + (t2.r + hgt) * 12.0) * (1.0 - lfar);
      vec3 crustCol = t1 * vec3(0.34, 0.31, 0.30) * (0.50 + 0.50 * t2.r + 0.35 * t2.g);   // matte basalt plates, warmed faintly by the field below
      vec3 hot = vec3(1.10, 0.29, 0.024) * (0.50 + 0.55 * t1.r) * pulse * (0.70 + 0.55 * smoothstep(0.20, 0.65, t2.r - t2.b * 0.5));
      float hl = dot(hot, LUMA);
      hot *= min(1.0, 0.50 / max(hl, 1e-4));                          // hue-preserving luma cap: saturate the colour, cap the intensity
      lcol = mix(crustCol, hot, ember);
    } else {
      // no asset -> the old procedural skin (accessor returned null; keep the fallback per the assets law)
      vec2 lu = vWorld.xz * 0.021 + vec2(uTime * 0.0055, uTime * -0.0035);
      float a1 = texture2D(uNormal, lu).b, a2 = texture2D(uNormal, lu * 3.1 - uTime * 0.006).b;
      float crust = smoothstep(0.40, 0.80, a1 * 0.65 + a2 * 0.35);
      vec3 hot = vec3(0.95, 0.21, 0.020) * (0.50 + 0.50 * (1.0 - crust));
      vec3 skin = vec3(0.055, 0.030, 0.024) * (0.55 + 0.85 * a2);
      lcol = mix(hot, skin, crust);
    }
    // bank light (wave-2 minor "lava casts no light on its banks"): the terrain rock is unlit by the pool, so
    // fake the contact-line heat water-side — the crust EDGE (shallow lava) brightens into a saturated ember
    // band that reads as light pooling where lava meets rock. Hue-preserving luma cap: fire, never a white rim.
    // 1.1 m was far too wide for pools this shallow: the ember band swallowed the whole rim and the pool
    // read inside-out (bright donut, dark middle). 0.45 m hugs the contact line, so the crust keeps the
    // middle and the heat reads as a hot shoreline.
    float bank = 1.0 - smoothstep(0.05, 0.45, d0);
    vec3 bankGlow = vec3(1.0, 0.30, 0.03) * bank * (0.42 + 0.18 * sin(uTime * 0.8 + vWorld.x * 0.6 + vWorld.z * 0.45));
    bankGlow *= min(1.0, 0.42 / max(dot(bankGlow, LUMA), 1e-4));
    lcol += bankGlow;
    // ...and put the heat ON THE ROCK, over a skirt of DRY ground past the shoreline (uDryW, widened to
    // ~2.3 m under full lava weight). Two wave-3 findings close here: the pool "terminates in a dead-straight
    // edge... a placed plane", because a 0.6 m opaque skirt ends on the bed's contour line inside a couple of
    // screen pixels. Now the terminator is (a) ERODED by crust noise, so it is a ragged rock margin instead
    // of an isoline, and (b) dissolved over ~2 m as a translucent saturated ember wash — a heat decal that
    // reads as light pooling on the rock, which a pure emissive surface can never do. No light source, no
    // shadow cost, and it is gone by the discard so it cannot become a glowing halo.
    // The margin is measured in HORIZONTAL METRES UP THE BANK, not in depth. A depth-measured skirt is a
    // few screen pixels wide wherever the bank is steep — which is every pit wall in this region — so the
    // pool still ended on a straight line with a flat painted strip inside it. In ground metres it is a
    // 0.8-2.2 m margin, raggedly eroded by two octaves of crust noise, and the wash carries the rock's own
    // grain so it reads as heat ON stone instead of an orange stripe.
    float lnA = texture2D(uNormal, p * 0.30 + 0.31).a;
    float lnB = texture2D(uNormal, p * 0.085 + 0.77).b;
    float dryH = max(-depth, 0.0) / max(bslope, 0.08);
    // ...and a depth-fraction ramp as well, whichever gets there first. Against a near-vertical pit wall the
    // horizontal term barely moves, so the sheet used to reach the discard still fully opaque — a straight
    // polygon cut with a stair-stepped fringe. The depth term guarantees a fade there too.
    float dryS = clamp(max(dryH * (0.45 + 0.75 * (lnA * 0.55 + lnB * 0.45)),
                           max(-depth, 0.0) / uDryW * (0.75 + 0.7 * lnA)), 0.0, 1.0);
    vec3 heat = vec3(1.0, 0.30, 0.04) * (0.45 + 0.17 * sin(uTime * 0.8 + vWorld.x * 0.6 + vWorld.z * 0.45));
    heat *= min(1.0, 0.50 / max(dot(heat, LUMA), 1e-4));  // hue-preserving cap: fire, never a white rim
    heat *= 0.55 + 0.85 * lnA;
    lcol = mix(lcol, heat, smoothstep(0.0, 0.32, dryS));
    col = mix(col, lcol, uLava);
    alpha = mix(alpha, 1.0 - smoothstep(0.15, 0.95, dryS), uLava);
  }
  if (uDebug > 0.5) {   // 1 reflection, 2 refraction grab, 3 depth, 4 foam, 5 normal
    if (uDebug < 1.5) col = texture2D(uReflect, clamp(rp.xy / rp.w, 0.0, 1.0)).rgb;
    else if (uDebug < 2.5) col = texture2D(uGrab, gl_FragCoord.xy / uGrabSize).rgb;
    else if (uDebug < 3.5) col = vec3(fract(d0), d0 / 10.0, step(depth, 0.0));
    else if (uDebug < 4.5) col = vec3(foam);
    else col = n * 0.5 + 0.5;
    alpha = 1.0;
  }
  // A fully transparent fragment still WRITES DEPTH (depthWrite is on, and it has to be — the falls and the
  // scum cards sort against this surface). Over the dry skirt between the waterline and the uDryW discard
  // that is a depth write contributing no colour, sitting a hair from the bank it is about to lose to.
  // Dropping it costs nothing and is the other half of the contact-band fix above. All derivatives are
  // already taken by here, so this discard cannot poison a quad's fwidth (see the note at the top one).
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---- Sunken cascade dressing: terrain-skinned cascade aprons + plunge foam rings + spray mist, ONE merged
// mesh / ONE draw call. aKind picks the branch. All colour is LIT (sun/ambient/moon uniforms shared with the
// water surface) and hue-preserving-capped — the blob law: silver foam, never clipped white.
// WHY AN APRON AND NOT A CURTAIN (wave-3 blocker "white sheets on a hard-edged triangular wedge fed by
// nothing"): the gorge's risers are 5.3 m of drop over ~18 m of run — 16 degrees, a CASCADE, not a cliff.
// A hanging quad draped in front of that leaves an air gap, a straight silhouette and a sheet that starts
// in mid-air. A sheet skinned ONTO the slope cannot do any of those things, and braids around the rock
// instead of blanketing it.
// WHERE the apron goes is decided by the DRAINAGE SOLVE in _buildFalls, not by a coverage test — read the
// comment there before touching any threshold here. The three levers that make the staircase read, in the
// order they matter: (1) the wa remap, which rescales the drainage weight's real 0..0.55 range onto opacity;
// (2) the discharge->braid blend, which makes a thread split and a step sheet over; (3) the noisy dissolve
// on the boundary. Every one of them exists because a wave-4 critic saw a flat pale wash with a razor edge.
const FALLS_VERT = /* glsl */`
attribute vec2 aLocal; attribute float aKind; attribute vec2 aFlow;
varying vec2 vUvM; varying vec2 vLocal; varying float vKind; varying float vViewZ; varying vec2 vWxz; varying vec2 vFlow; varying float vGraze;
void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vUvM = uv; vLocal = aLocal; vKind = aKind; vWxz = wp.xz; vFlow = aFlow;
  // how edge-on this surface is seen. The apron is skinned onto the ground, so standing on a tread the
  // texel footprint explodes along the view — that undersampling is the "visible moire" the wave-4 critic
  // saw as a cross-hatch lattice over the whole bank. Carried to the fragment as an explicit LOD bias.
  vGraze = 1.0 - clamp(abs(normalize(wp - cameraPosition).y) * 3.0, 0.0, 1.0);
  vec4 mv = viewMatrix * vec4(wp, 1.0); vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const FALLS_FRAG = /* glsl */`
uniform sampler2D uTex; uniform float uTime;
uniform sampler2D uHeight; uniform float uInvSize; uniform float uHeightOffset;
uniform vec3 uSunDir; uniform vec3 uSunRad; uniform vec3 uAmbient; uniform vec3 uMoonRad;
uniform vec3 uFogColor; uniform vec3 uFogParams;
varying vec2 vUvM; varying vec2 vLocal; varying float vKind; varying float vViewZ; varying vec2 vWxz; varying vec2 vFlow; varying float vGraze;
void main() {
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  float t = uTime;
  float day = clamp(uSunDir.y * 2.5, 0.0, 1.0);
  vec3 fc = vec3(0.84, 0.91, 0.96) * (uSunRad * 0.32 * day + uAmbient * 1.2 + uMoonRad * 0.3);
  fc /= (1.0 + dot(fc, LUMA) * 0.5);            // soft hue-preserving cap: bright silver, never a white clip
  float bed = texture2D(uHeight, vWxz * uInvSize + 0.5 + uHeightOffset).r;   // terrain height relative to the water plane
  // LOD bias: distance (one flow ripple is sub-pixel past ~60 m) + grazing (the footprint stretches along
  // the view). Without it the automatic derivative under-filters an already anisotropic UV and the sheet
  // wears a stipple lattice — the wave-4 "visible moire". Blurring what is under a pixel costs nothing.
  // 0.75, NOT 3.0. Three mip levels of grazing bias is not filtering, it is erasure: the apron is skinned
  // onto the ground, so vGraze is ~1 over almost the whole sheet, and every octave it is made of — flow
  // streaks, aeration, the braid mask, the dissolve that gives its boundary fingers — got averaged to a
  // constant. What was left was a flat opaque cream lozenge with a hard rim lying on the bank, which is
  // exactly what the wave-5 self-check photographed at 40 m (shot-sk-fall1-40m). And the "visible moire"
  // that bias was added to fight is not this mesh at all: with the water surface, the scum and the whole
  // falls mesh hidden the stipple is still there (tools/out/w-dbg3/shot-z1-nowater-noscum.png), so it
  // belongs to the terrain. Keep a mild anisotropy compensation, give the sheet its structure back.
  float lod = max(0.0, log2(max(vViewZ, 1.0) * 0.018)) + vGraze * 0.75;
  float a;
  if (vKind < 0.5) {
    // cascade apron: white water skinned onto the riser slope, advected down the local fall line.
    float w = vLocal.x, slope = vLocal.y;
    float fl = length(vFlow);
    vec2 fd = fl > 1e-4 ? vFlow / fl : vec2(0.0, 1.0);
    vec2 q = vec2(dot(vWxz, vec2(-fd.y, fd.x)), dot(vWxz, fd));
    float sp = 0.8 + 2.4 * slope;                                            // steeper = faster
    float s1 = texture2D(uTex, vec2(q.x * 0.085, q.y * 0.026 - t * 0.055 * sp), lod).b;
    float s2 = texture2D(uTex, vec2(q.x * 0.155 + 0.37, q.y * 0.045 - t * 0.095 * sp + 0.5), lod).b;
    // A THIRD, FINE OCTAVE. The other two have periods of 12 m and 38 m across the flow, so over a 20 m
    // patch of sheet the aeration is one smooth lobe — i.e. a constant — and a constant aeration is a flat
    // plate of paint however well it is lit. This one runs at ~3 m across and ~9 m along, which is the scale
    // white water actually breaks at, and it is what turns the sheet back into threads.
    float s3 = texture2D(uTex, vec2(q.x * 0.32 + 0.71, q.y * 0.11 - t * 0.17 * sp), lod).b;
    // 0.60..1.12, NOT 0.26..0.86 — and this one line is why the apron was a milk veil rather than white
    // water. uTex's .b sits around 0.55 on average, so a window opening at 0.26 on a weighted sum of three
    // taps was ALREADY SATURATED almost everywhere: aer read ~1 across the whole sheet, which made it fully
    // opaque, perfectly uniform, and completely deaf to every other lever in this branch (measured by
    // toggling the mesh: with it hidden the same shot is clear braided turquoise, with it on the frame is
    // a pale veil — tools/out/w-dbg6/shot-s0-on.png vs shot-s1-nofalls.png). Aeration is the TOP of the
    // distribution, not its middle: threads of churn with water you can see through between them.
    float aer = smoothstep(0.60, 1.12, s1 * 0.50 + s2 * 0.45 + s3 * 0.44);
    // FAR HANDOVER (wave-5 blocker "from the pass there is no staircase of water"). Past ~150 m every churn
    // octave is sub-pixel and the mips average it to its mean, which sits BELOW the aeration window — the
    // measured whole-sheet alpha from the pass was 0.02-0.15, i.e. invisible against the rock through 40% of
    // haze. The staircase can only read at that range as SOLID silver ribbons, so hand the sheet over to its
    // drainage weight: full aeration, closed braid, opacity carried by wa alone. Continuous, so nothing pops.
    float vfar = smoothstep(140.0, 380.0, vViewZ);
    aer = mix(aer, 0.92, vfar);
    // braided channels, not a blanket: real cascades split around rock, and a full-width sheet is exactly
    // the "flat white paint" read. Two octaves (22 m and 9 m) so the braid has fingers, not just blobs; it
    // opens into a full curtain only at the foot, where the whole flow plunges — read from vUvM.x (metres
    // still to fall along this cell's own drainage path), so it works on a riser 10 m above the water
    // plane exactly as it does at the shore. The old test was bed-relative and only ever fired at WL.
    float braidRaw = smoothstep(0.30, 0.82, texture2D(uTex, vWxz * 0.045 + 0.11, lod * 0.5).a * 0.70
                                          + texture2D(uTex, vWxz * 0.110 - 0.23, lod * 0.5).a * 0.44);
    float plunge = 1.0 - smoothstep(0.05, 0.45, vUvM.x);
    // The drainage weight arrives with a real dynamic range of about 0..0.55 (measured over the gorge:
    // the treads sit at 0.12, the chute at 0.40, the big riser at 0.51), so it has to be REMAPPED before
    // it can drive opacity — used raw it multiplies the brightest step down to a grey smudge and the
    // staircase never reads. wa is that remap; w itself still drives the dissolve, where the raw value
    // is what the geometry boundary actually follows.
    float wa = smoothstep(0.05, 0.45, w);
    // DISCHARGE decides braid vs curtain, and that is why the staircase reads. A trickle splits around
    // every stone; a step carrying the whole gorge is a sheet. So treads wear faint threads and the steps
    // blaze — bright bands with dark treads between them, which is what a staircase of water IS.
    // ...gated by SLOPE, because that is the other half of the sentence. Discharge alone closed the curtain
    // on any strong drainage cell, including the gentle shoulders where a stream is at its most braided, and
    // a closed curtain plus a smooth aeration lobe is a 20 m opaque lozenge lying on the bank. Water sheets
    // when it FALLS; on anything flatter than a riser it splits around every stone however much of it there
    // is. Below ~10 degrees this term is now off entirely and braidRaw carries the sheet.
    float steep = smoothstep(0.18, 0.55, slope);
    float braid = mix(braidRaw, 1.0, clamp((smoothstep(0.35, 0.90, wa) * 0.85 + plunge * 0.25) * steep, 0.0, 1.0));
    braid = max(braid, vfar);          // braid gaps are sub-pixel from the pass: the far sheet is a ribbon
    // NOISY DISSOLVE, not a threshold. Where the sheet ends, it has to end in fingers: any mask that ends
    // on a level set of a smooth field draws a visible line, and that line was half of the wave-4 finding.
    // Subtracting the braid noise from the weight makes the boundary the noise's own edge.
    float edge = smoothstep(0.0, 0.30, w - (1.0 - braidRaw) * 0.20);
    // AERATED WATER IS TRANSLUCENT — the rock has to show through its thin parts, or it is paint. The old
    // base of 0.22 meant even zero-aeration cells were a fifth opaque, and 0.90 at full aeration left no
    // headroom for a crest to read against a trough.
    a = wa * edge * braid * (0.05 + 0.78 * aer) * (0.50 + 0.50 * wa);
    a = mix(a, min(wa * 1.5, 1.0) * edge * 0.85, vfar);   // the far ribbon: opacity from discharge, not from churn the mips ate
    // THE APRON IS A SKIN ON GROUND, SO IT STOPS AT THE WATERLINE. Its vertices are clamped up to the water
    // plane (they have to be, or a submerged foot is depth-rejected against the surface), which means every
    // cell the 5 m lattice carries out over standing water becomes a FLAT HORIZONTAL PLATE floating on it —
    // opaque cream, with the lattice's own boundary for an edge. That is the hard-edged lozenge the wave-5
    // self-check photographed lying in the gorge channel (shot-sk-fall1-40m); the channel bed is 0.65 m under
    // the plane there and the water is clear enough to read as dry rock, which is why it looked like a
    // sticker on stone. Below the waterline, white water is the plunge ring's job and the surface's own foam
    // term's job — both of which are shaped by noise and by depth instead of by a quad.
    // ...and that waterline is a DISSOLVE too, for the same reason the sheet's own boundary is. A plain
    // smoothstep on depth is an iso-contour of a smooth field, i.e. a straight line — on the gorge's flat
    // shelf 0.5 m of depth is metres of ground, so the first cut of this fade drew a razor diagonal right
    // across the near field (wave-5 self-check, shot-sk-fall1-8m). Jittering the threshold by the braid
    // noise turns the same cut into fingers of white water running out into the shallows.
    a *= smoothstep(-0.55, -0.05, bed + (braidRaw - 0.5) * 0.45);
    fc *= (0.74 + 0.40 * aer) * (1.0 + 0.22 * vfar);   // crests bright, troughs grey; far ribbon lifted toward silver so it beats the haze mix (still under the fc cap x1.22 — silver, never clip-white)
  } else if (vKind < 1.5) {
    // plunge ring: churned foam collar spreading outward from the fall base (integer tile counts round
    // the circle so the angular seam is invisible)
    vec2 c = vLocal * 2.0 - 1.0; float r = length(c); float ang = atan(c.y, c.x);
    float s1 = texture2D(uTex, vec2(ang * 0.4775, r * 1.1 - t * 0.16), lod * 0.5).b;
    float s2 = texture2D(uTex, vec2(ang * 0.3183 + 0.5, r * 0.7 - t * 0.10), lod * 0.5).b;
    // ...and one WORLD-SPACE octave to break the polar frame. Two purely polar layers are a function of
    // (angle, radius) and nothing else, so up close the collar reads as a pinwheel — a dartboard of spokes
    // around a centre, which is what the wave-5 self-check saw at 8 m (shot-sk-fall1-8m, a radial swirl in
    // the middle of the channel). Real plunge foam boils in world space; one non-polar octave is enough to
    // decorrelate the spokes without losing the outward drift the polar pair provides.
    float s3 = texture2D(uTex, vWxz * 0.085 + vec2(0.02, -0.015) * t, lod * 0.5).a;
    float f = smoothstep(0.34, 0.82, s1 * 0.5 + s2 * 0.44 + s3 * 0.52);
    // NO CONSTANT FLOOR, and the rim is a DISSOLVE. The old 0.16 + 0.72*f laid a solid 0.16-alpha slab
    // across the whole 22 m disc and then ramped it out on a smooth radius — i.e. exactly a flat milky
    // stain with a soft circular edge, which is what the wave-5 self-check found at 8 m (shot-fall1-8m:
    // a radial swirl centred on nothing). Churn is patchy or it is paint: the noise carries the whole
    // value, and it also carries the boundary, so the collar ends in fingers instead of on a circle.
    a = (0.02 + 0.66 * f) * smoothstep(1.0, 0.15, r + (1.0 - f) * 0.35);
    // the ring is a flat disc on the pool it lands in, so where that pool ends it must end too (the wave-3
    // vista had white discs sitting on dry sand). vFlow.x is the ring's own surface height relative to the
    // water plane; _buildFalls now only emits a ring for a fall that lands IN the standing water, so this
    // is the DEPTH ramp, and it runs out to a metre rather than to 14 cm on purpose: a plunge pool's churn
    // is proportional to the pool. In the sunken channel the water is 0.65 m deep and clear enough to read
    // as bare rock, so a collar at full strength there was a flat pale plate lying on stone. Ramped, the
    // same collar is a broken lace in the shallows and a full boil only where there is depth to boil in.
    a *= smoothstep(-0.02, 0.95, vFlow.x - bed);
    // ...and it FADES with distance instead of blurring into a plate. The collar is a 20 m disc whose whole
    // substance is churn noise; past ~40 m that noise is sub-pixel, the mip filter averages it to a constant,
    // and what is left is a flat pale lozenge lying in the channel — which is exactly how it read at 40 m
    // (wave-5 self-check, shot-sk-fall1-40m) even after the dissolve fixed it at 8 m. At that range the fall
    // is carried by its mist plume, which is a silhouette and survives being small. Melt the collar out.
    a *= 1.0 - smoothstep(30.0, 70.0, vViewZ);
  } else {
    // spray mist: soft breathing veil, hazier and cooler than the foam — matte, capped, never washes white
    vec2 c = vLocal * 2.0 - 1.0;
    float nm = texture2D(uTex, vec2(vLocal.x * 0.8 + t * 0.010, vLocal.y * 0.8 - t * 0.016), lod * 0.5).a;
    float rr = max(1.0 - dot(c, c), 0.0);
    // squared radial falloff so the card edge is never a visible rectangle — and a NEAR fade, because a
    // plume card is 25 m wide and 8 m tall and the player wades right through it. From inside, a billboard
    // is not a plume, it is a flat grey filter over the whole screen, which is half of what made the 8 m
    // read a milk veil. Gone by 4 m, full by 14 m, where it is a silhouette again. Noise carries more of
    // the value too: spray is ragged, and a constant term is the part that reads as fog.
    // far boost (wave-5 pass-approach blocker): from 300+ m the plume IS the fall — a receding file of white
    // columns is what reads as a staircase long after the sheets are 2 px wide. At that range nm mips to ~0.5
    // and the column washed out to ~0.2 alpha; lift it back toward a solid silhouette.
    a = rr * rr * (0.09 + 0.26 * nm) * smoothstep(4.0, 14.0, vViewZ) * (1.0 + 1.2 * smoothstep(120.0, 420.0, vViewZ));
    fc = mix(fc, uAmbient * 1.15, 0.6);
  }
  float fog = (uFogParams.z > uFogParams.y) ? smoothstep(uFogParams.y, uFogParams.z, vViewZ) : 1.0 - exp(-uFogParams.x * uFogParams.x * vViewZ * vViewZ);
  vec3 col = mix(fc, uFogColor, fog);
  gl_FragColor = vec4(col, a * 0.92);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Water {
  constructor(game) {
    this.game = game;
    this.level = 0; this.time = 0;
    this.reflectionEnabled = true; this.debug = 0;
    this.sunStrength = 3.0;      // sun irradiance scale (matches Lighting's DirectionalLight intensity)
    this.moonStrength = 1.7;     // moon glitter must read as a real trail at night (FF14 bar)
    this._noReflect = new Set();
    this._v2 = new THREE.Vector2(); this._v3 = new THREE.Vector3();
    // reflection pass scratch (allocated once)
    this._reflCam = new THREE.PerspectiveCamera();
    this._plane = new THREE.Plane(); this._clip = new THREE.Vector4(); this._q = new THREE.Vector4();
    this._view = new THREE.Vector3(); this._target = new THREE.Vector3(); this._look = new THREE.Vector3(); this._rot = new THREE.Matrix4();
    this._camPos = new THREE.Vector3(); this._planePos = new THREE.Vector3(); this._normal = new THREE.Vector3(0, 1, 0);
    this._reflMatrix = new THREE.Matrix4();
    this._frame = -1; this._reflFrame = -1;
    this.cpuMs = { grab: 0, reflect: 0 };   // main-thread cost of the two extra passes (GPU cost shows in the frame time)
  }

  // ---------------------------------------------------------------- public API
  /** Terrain height as WATER sees it: the Infernal ash and the Void abyss are dry by decree (terrain.dryAt), so
   *  a chasm floor 40 m down there is a chasm, not a lake. Kept in sync with the same term in _bakeHeight. */
  _bed(x, z) { const T = this.game.terrain; return T.heightAt(x, z) + (T.dryAt ? T.dryAt(x, z) * 300 : 0); }
  isWater(x, z) { return this._bed(x, z) < this.level; }
  heightAt(x, z) {
    // matches the vertex shader's depth damping (waves die in the shallows) so splashes/buoyancy sit on the visible surface
    const bed = this._bed(x, z) - this.level;
    const f = Math.min(1, Math.max(0, (-bed - 0.05) / 1.15));
    const fade = f * f * (3 - 2 * f);
    let y = this.level; const t = this.time;
    if (fade > 0) for (let i = 0; i < 4; i++) { const w = WAVES[i]; y += fade * w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t); }
    return y;
  }
  submergedDepth(a, b, c) {
    const x = typeof a === 'object' ? a.x : a, y = typeof a === 'object' ? a.y : b, z = typeof a === 'object' ? a.z : c;
    if (this._bed(x, z) >= this.level) return 0;   // dry ground below the plane (Void abyss, Infernal ash) is DRY — physics-audit "the abyss is swimmable"
    return Math.max(0, this.heightAt(x, z) - y);
  }
  excludeFromReflection(obj) { this._noReflect.add(obj); }
  includeInReflection(obj) { this._noReflect.delete(obj); }
  setQuality(q) {
    this.qp = QP[q] ?? QP.high;
    if (this.mesh) { this._buildGeometry(); this.material.defines = this.qp.hq ? { WATER_HQ: 1 } : {}; this.material.needsUpdate = true; this.uniforms.uFadeR.value = this.qp.span * 0.4; }
    if (this._reflRT && !this.qp.refl) { this._reflRT.dispose(); this._reflRT = null; }
  }

  // ---------------------------------------------------------------- init
  async init() {
    const { game } = this;
    this.level = game.terrain.waterLevel ?? 0;
    this.qp = QP[game.quality] ?? QP.high;
    this._bakeHeight();
    await new Promise((r) => requestAnimationFrame(r));   // two heavy bakes, one frame apart
    this._bakeNormal();
    const u = this.uniforms = {
      uTime: { value: 0 }, uSteep: { value: STEEP }, uFadeR: { value: this.qp.span * 0.4 }, uSumAmp: { value: SUM_AMP }, uLevel: { value: this.level },
      uWave: { value: WAVES.map((w) => new THREE.Vector4(w.dx, w.dz, w.k, w.amp)) }, uWaveW: { value: new THREE.Vector4(...WAVES.map((w) => w.w)) },
      uHeight: { value: this.heightTex }, uInvSize: { value: 1 / game.terrain.size }, uHeightOffset: { value: this._heightOffset }, uNormal: { value: this.normalTex },
      uReflect: { value: null }, uReflMatrix: { value: this._reflMatrix }, uHasReflect: { value: 0 },
      uGrab: { value: null }, uHasGrab: { value: 0 }, uGrabSize: { value: new THREE.Vector2(1, 1) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunRad: { value: new THREE.Color() }, uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonRad: { value: new THREE.Color() },
      uSkyColor: { value: new THREE.Color() }, uHorizonColor: { value: new THREE.Color() }, uAmbient: { value: new THREE.Color() },
      uFogColor: { value: new THREE.Color() }, uFogParams: { value: new THREE.Vector3(0, 0, 0) }, uCamBelow: { value: 0 },
      // detail 0.13 -> 0.36: the ripple normal is what makes a lake read as water rather than tinted glass.
      // rough 0.11 -> 0.075: crisper sun glints. absorb/shallow deepened so the middle of Mirrormere is
      // blue-green instead of the uniform milky turquoise it shipped as.
      uLava: { value: 0 },
      uDetail: { value: 0.36 }, uRough: { value: 0.075 }, uDistort: { value: 0.026 }, uReflDistort: { value: 0.026 }, uSpecMax: { value: 6.0 }, uReflTint: { value: new THREE.Color(0.94, 0.97, 1.0) },
      uShallow: { value: new THREE.Color(0.035, 0.27, 0.32) }, uDeep: { value: new THREE.Color(0.006, 0.038, 0.105) },
      uAbsorb: { value: new THREE.Vector3(1.25, 0.42, 0.19) }, uFoamDepth: { value: 0.22 }, uFoamMul: { value: 1 }, uSpecMul: { value: 1 }, uRapid: { value: 0 }, uDebug: { value: 0 }, uNight: { value: 0 },
      uReflCap: { value: 0.62 }, uReflBlur: { value: 0 }, uDryW: { value: 0.6 }, uFlowC: { value: new THREE.Vector2(BIOMES.sunken?.cx ?? 0, BIOMES.sunken?.cz ?? 0) }, uFilm: { value: 0 },
      uLavaTex: { value: null }, uHasLavaTex: { value: 0 },
    };
    const lavaTex = game.assets?.tex?.('lava_crust');
    u.uLavaTex.value = lavaTex ?? this.normalTex;   // something bound either way; uHasLavaTex picks the path
    u.uHasLavaTex.value = lavaTex ? 1 : 0;
    // Mirrormere's tuned look is the base; the biome water presets below are lerped in by biome weight.
    this._baseWater = {
      sh: u.uShallow.value.clone(), dp: u.uDeep.value.clone(), ab: u.uAbsorb.value.clone(),
      rt: u.uReflTint.value.clone(), rgh: u.uRough.value, det: u.uDetail.value,
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: u, vertexShader: VERT, fragmentShader: FRAG, defines: this.qp.hq ? { WATER_HQ: 1 } : {},
      transparent: true, depthWrite: true, side: THREE.DoubleSide, fog: false, lights: false,
      // The water plane and the bank are nearly COPLANAR wherever the shore is shallow, and they carry
      // different tessellations, so along the whole contact the terrain's centimetre relief interpenetrates
      // the plane and the depth test picks a different winner every pixel. That is not a shader problem and
      // no amount of filtering touches it: it renders as a crawling 1-px dither of foam-and-bank speckle
      // strung along the waterline, worst on a flat pan (wave-5 self-check, shot-fen-8m; also the sunken
      // beach in shot-sk-mid-downgorge). Biasing the water a few depth units toward the camera makes it win
      // the contact band outright, so the edge is decided by the alpha ramp — which is smooth — instead of
      // by the depth buffer. Sub-millimetre of world at these ranges; it can never expose a gap.
      polygonOffset: true, polygonOffsetFactor: -1.0, polygonOffsetUnits: -4.0,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'water'; this.mesh.frustumCulled = true; this.mesh.renderOrder = 5; this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.mesh.raycast = () => {};   // never a raycast target (combat uses water.heightAt for splashes)
    this._buildGeometry();
    this.mesh.onBeforeRender = (renderer, scene, camera) => this._onBeforeRender(renderer, scene, camera);
    this.mesh.visible = this.hasWater;
    game.scene.add(this.mesh);
    this._buildScum();
    this._buildFalls();
  }

  // Sunken cascade gorge (docs/SUNKEN-REDESIGN-BRIEF.md). Build a CASCADE FIELD over the region: a smooth
  // per-cell weight for "fast white water runs over this ground", from bed slope x height above the water
  // plane x distance to standing water. Every riser, the entrance-ramp foot and the gorge-wall bases come
  // out of it automatically — no hardcoded coordinates, deterministic, one mesh / one draw call.
  //
  // This REPLACED a scan that picked the 16 tallest wall cells and hung a quad curtain in front of each.
  // The wave-3 verdict on that: "white sheets on a hard-edged triangular sand wedge fed by nothing", with a
  // visible air gap. The cause is geometric, not cosmetic — the risers here are 5.3 m of drop over ~18 m of
  // run, so there is no wall to hang anything on. Water skinned onto the slope cannot leave a gap, cannot
  // show a straight silhouette, and reads as a staircase from the pass because it follows the ledge line.
  _buildFalls() {
    const g = this.game, T = g.terrain, WL = this.level;
    if (!T?.biomeAt || !this.hasWater) return;
    const t0 = performance.now();
    const rnd = mulberry32(g.seed + 52121);
    const half = T.size / 2;
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let z = -half + 12; z < half; z += 24) for (let x = -half + 12; x < half; x += 24)
      if (T.biomeAt(x, z) === 'sunken') { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    if (x1 < x0) return;
    x0 -= 30; z0 -= 30; x1 += 30; z1 += 30;
    // ---- 1) sample the region on a 5 m lattice (bed height + region weight)
    const CELL = 5;
    const NX = Math.round((x1 - x0) / CELL) + 1, NZ = Math.round((z1 - z0) / CELL) + 1, N = NX * NZ;
    const H = new Float32Array(N), RW = new Float32Array(N), bb = {};
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      const x = x0 + i * CELL, z = z0 + j * CELL, k = j * NX + i;
      const b = T.biomeBlend ? T.biomeBlend(x, z, bb) : null;
      let rw = b ? (b.id === 'sunken' ? b.w : 0) : (T.biomeAt(x, z) === 'sunken' ? 1 : 0);
      // the world-edge crag (r > ~900) is OUT. Its 60 m drops carry the biggest weight x drop products in the
      // whole field, so it monopolised the 18-fall budget and the apron paint — the wave-5 critic found the
      // cataracts "built onto the outer EDGE crag, outside the walkable region", while the gorge's own risers
      // between the pass and the Court went begging. The brief wants ring-wall feeds + terrace cascades the
      // player walks beside; the impassable rim wall is scenery nobody reaches, so it gets no white water.
      const rr2 = x * x + z * z;
      if (rr2 > 860 * 860) rw *= SS(940 * 940, 860 * 860, rr2);
      if (rw <= 0.02 || (T.dryAt && T.dryAt(x, z) > 0.5)) { RW[k] = 0; H[k] = WL + 1e3; continue; }
      RW[k] = rw; H[k] = T.heightAt(x, z);
    }
    // ---- 2) DRAINAGE. Where white water goes is not a question of "is this bank near a lake and steep
    //      enough" — that is a COVERAGE test, and a coverage test over a gorge whose every bank qualifies
    //      is how three waves running produced "the foam saturates half the frame into a flat pale wash
    //      with a hard geometric edge". Worse, the edge came from the test itself: the old gate was
    //      SS(34, 12, chamferDistanceToWater), and an iso-contour of a chamfer distance field IS a straight
    //      line running parallel to the shore. No amount of noise on top hides a razor drawn by the mask.
    //      So: route real water. Priority-flood the depressions (Barnes/Planchon — a raw heightfield is full
    //      of 1-cell pits and D8 without it dies in the first one), then D8 flow accumulation. A cell is
    //      white water if a real catchment drains through it AND it is steep. That is scale-free, it has no
    //      contour to draw an edge along, and it comes out as what a cascade gorge actually is: threads that
    //      gather on a tread, blaze over the riser, gather again. Measured on this seed: 8.6% of the region
    //      wears water instead of 30%, and the smoothed weight down the gorge centre reads 0.37 at the
    //      entrance chute, 0.12 on the treads, 0.51 on the big riser at r700 — bands with dark treads
    //      between them, i.e. the staircase. Do NOT widen the window to brighten the upper riser: swept,
    //      2.5/3.4 costs 17% coverage and 2.0/3.0 costs 36% and neither moves r640 off 0.24, because that
    //      riser genuinely drains less. The brightness lever is the wa remap in FALLS_FRAG, not this gate.
    const F = new Float32Array(N); F.set(H);
    {
      const seen = new Uint8Array(N), hp = [];
      const up = (c) => { while (c > 0) { const p = (c - 1) >> 1; if (F[hp[p]] <= F[hp[c]]) break; const t = hp[p]; hp[p] = hp[c]; hp[c] = t; c = p; } };
      const push = (k) => { hp.push(k); up(hp.length - 1); };
      const pop = () => { const top = hp[0], last = hp.pop();
        if (hp.length) { hp[0] = last; let p = 0; for (;;) { const l = p * 2 + 1, r = l + 1; let m = p;
          if (l < hp.length && F[hp[l]] < F[hp[m]]) m = l;
          if (r < hp.length && F[hp[r]] < F[hp[m]]) m = r;
          if (m === p) break; const t = hp[p]; hp[p] = hp[m]; hp[m] = t; p = m; } } return top; };
      // outlets: the standing water itself (flow that reaches the plane is done) and the lattice border
      for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) { const k = j * NX + i;
        if (RW[k] <= 0.02) { seen[k] = 1; continue; }
        if (H[k] <= WL || i === 0 || j === 0 || i === NX - 1 || j === NZ - 1) { seen[k] = 1; push(k); } }
      while (hp.length) { const k = pop(), i = k % NX, j = (k / NX) | 0;
        for (let o = 0; o < 8; o++) { const a = i + NB8[o][0], b = j + NB8[o][1];
          if (a < 0 || a >= NX || b < 0 || b >= NZ) continue;
          const kk = b * NX + a; if (seen[kk]) continue;
          seen[kk] = 1; if (F[kk] < F[k] + 1e-3) F[kk] = F[k] + 1e-3; push(kk); } }
    }
    const ORD = [];
    for (let k = 0; k < N; k++) if (RW[k] > 0.02) ORD.push(k);
    ORD.sort((a, b) => F[b] - F[a]);                        // highest first: one pass accumulates the whole tree
    const ACC = new Float32Array(N), DN = new Int32Array(N).fill(-1);
    for (const k of ORD) {
      const i = k % NX, j = (k / NX) | 0;
      // rain, plus a pulse on the high rim: the gorge is FED by the mountain ring (brief), and the ring
      // itself is outside this lattice, so its catchment has to enter as a boundary condition.
      ACC[k] += 1 + (H[k] > WL + 18 ? 40 : 0);
      let best = -1, bs = 0;
      for (let o = 0; o < 8; o++) { const a = i + NB8[o][0], b = j + NB8[o][1];
        if (a < 0 || a >= NX || b < 0 || b >= NZ) continue;
        const kk = b * NX + a; if (RW[kk] <= 0.02) continue;
        const s = (F[k] - F[kk]) * NB8[o][2]; if (s > bs) { bs = s; best = kk; } }
      DN[k] = best;
    }
    for (const k of ORD) { const d = DN[k]; if (d >= 0) ACC[d] += ACC[k]; }
    // ---- 3) the cascade weight field + local fall line
    const W = new Float32Array(N), FX = new Float32Array(N), FZ = new Float32Array(N), SL = new Float32Array(N);
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const k = j * NX + i;
      if (RW[k] <= 0.02 || RW[k - 1] <= 0.02 || RW[k + 1] <= 0.02 || RW[k - NX] <= 0.02 || RW[k + NX] <= 0.02) continue;
      const gx = (H[k + 1] - H[k - 1]) / (2 * CELL), gz = (H[k + NX] - H[k - NX]) / (2 * CELL);
      const sl = Math.hypot(gx, gz); SL[k] = sl;
      // The whole field, in one line. `chan` is the drainage test (25 -> 800 upstream cells, i.e. a real
      // stream, not a rivulet); the slope term is a 0.20 FLOOR plus 0.80 of steepness, NOT a gate — the
      // floor is the braided thread that crosses a flat tread from one riser to the next, so the steps are
      // visibly connected instead of three unexplained bands, and the 0.80 is what makes a riser blaze at
      // 5x the tread. `ha > -0.5` keeps the sheet above the waterline: below it, whiteness is the plunge
      // rings' job (an apron cell on a pool floor gets its vertex lifted to the plane, which is how the
      // basin once wore a flat milky sheet).
      if (H[k] - WL < -0.5) { FX[k] = -gx / Math.max(sl, 1e-4); FZ[k] = -gz / Math.max(sl, 1e-4); continue; }
      const chan = SS(2.9, 3.9, Math.log10(Math.max(ACC[k], 1)));
      W[k] = RW[k] * chan * (0.20 + 0.80 * SS(0.14, 0.34, sl));
      FX[k] = -gx / Math.max(sl, 1e-4); FZ[k] = -gz / Math.max(sl, 1e-4);
    }
    // How far this cell still has to fall — 8 steps down its own D8 path, in metres. The shader turns it
    // into the braid/curtain blend: high on a riser face (split around rock), 0 at the foot (the whole flow
    // plunges). It replaces a `bed`-relative test that only ever fired at the water plane, so every fall
    // that lands on a dry tread — i.e. every step of the staircase but the last — opened no curtain at all.
    const HD = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      if (W[k] <= 0) continue;
      let d = k, lo = H[k];
      for (let s = 0; s < 8 && d >= 0; s++) { if (H[d] < lo) lo = H[d]; d = DN[d]; }
      HD[k] = H[k] - lo;
    }
    // one box blur: the lattice is coarser than the terrain, and an unsmoothed weight shows its own grid
    const WB = new Float32Array(N);
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const k = j * NX + i;
      WB[k] = RW[k] <= 0.02 ? 0 : (W[k] * 4 + W[k - 1] + W[k + 1] + W[k - NX] + W[k + NX]
             + (W[k - NX - 1] + W[k - NX + 1] + W[k + NX - 1] + W[k + NX + 1]) * 0.5) / 10;
    }
    // ---- 4) plunge sites: the feet of the cascade. Also what Audio/VFX read.
    // A FOOT IS WHERE THE FALLING STOPS, at whatever altitude that is — `H - WL <= 0.8` (the old test)
    // only ever fired at the water plane, so the two riser feet the staircase is made of, which land on
    // dry treads 5 and 10 m up, got no collar and no mist at all. The honest test is a SLOPE COLLAPSE:
    // flow that was on steep ground here is on flat ground (or in the pool) one cell on. Testing residual
    // drop instead does not work — a 5 m cell on a 0.45 riser sheds 2.2 m per step, so HD skips straight
    // over any fixed window and the first cut found 3 feet in the whole region, all on the far crag.
    const BK = 40, buck = new Map();
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const k = j * NX + i, d = DN[k];
      // 0.25/0.16 -> 0.18/0.14: with the edge crag excluded from the field (above), the 18-fall budget is no
      // longer spent on unreachable wall cataracts — so the gate can afford the gorge's own, more modest
      // risers, which are exactly the falls the wave-5 critic found missing ("the only two sites inside the
      // region body"). More interior feet = plunge collars + mist columns stepping down the walkable gorge.
      if (WB[k] < 0.18 || d < 0 || SL[k] < 0.14) continue;
      // RELATIVE collapse, not an absolute one: the treads carry fbm micro-relief and causeway shoulders at
      // slope 0.05-0.15, so `SL[d] < 0.09` almost never fired on them and the whole gorge yielded 3 feet.
      if (!(SL[d] < SL[k] * 0.55 || H[d] <= WL + 0.15)) continue;
      const key = ((i * CELL / BK) | 0) * 4096 + ((j * CELL / BK) | 0);
      const prev = buck.get(key);
      if (!prev || WB[k] > prev[4]) buck.set(key, [x0 + i * CELL, z0 + j * CELL, -FX[k], -FZ[k], WB[k], Math.max(H[d], WL)]);   // uphill = against the fall line; [5] = the pool surface this lands on
    }
    const feet = [...buck.values()];
    for (const f of feet) {                                  // drop: walk uphill along the fall line out of the pool it lands in
      let hw = 0;
      for (let dd = 3; dd <= 30; dd += 2) hw = Math.max(hw, T.heightAt(f[0] + f[2] * dd, f[1] + f[3] * dd) - f[5]);
      f[6] = Math.min(Math.max(hw, 1.6), 14);
    }
    feet.sort((a, b) => b[4] * b[6] - a[4] * a[6]);          // weight x drop: a real step beats a trickle over a kerb
    const falls = [];
    for (const f of feet) {
      if (falls.length >= 18) break;
      if (!falls.every((p) => (p.sx - f[0]) ** 2 + (p.sz - f[1]) ** 2 > 26 * 26)) continue;
      falls.push({ sx: f[0], sz: f[1], dx: f[2], dz: f[3], tx: -f[3], tz: f[2], hw: f[6], y: f[5], w: Math.min(9 + f[6] * 1.4, 26) });
    }
    // ---- 5) merged geometry: aprons, then rings, then mist (index order = blend order; all depthWrite:false)
    const pos = [], uv = [], loc = [], kind = [], flow = [], idx = [];
    const quad = (a, b, c, d) => idx.push(a, c, b, b, c, d);
    // apron: one quad per lattice cell whose corners carry weight; y sits 0.3 m proud of the bake so the
    // 5 m chords and the terrain's own micro-relief cannot poke through it.
    // ponytail: 5 m lattice + fixed 0.3 m lift; upgrade = subdivide by local curvature if a face ever pokes.
    const vmap = new Int32Array(N).fill(-1);
    const vert = (i, j) => {
      const k = j * NX + i; if (vmap[k] >= 0) return vmap[k];
      const id = pos.length / 3; vmap[k] = id;
      // lift along the surface NORMAL, not straight up: on a 55 degree flank a vertical offset leaves the
      // sheet inside the rock at grazing angles and the depth test punches holes in it.
      const sl = SL[k], inv = 0.28 / Math.sqrt(1 + sl * sl);
      // ...and never below the water plane: the surface writes depth at renderOrder 5, so a submerged foot
      // would be depth-rejected and the plunge zone — the brightest part of a cascade — would vanish.
      pos.push(x0 + i * CELL + FX[k] * sl * inv, Math.max(H[k] + inv, WL + 0.06), z0 + j * CELL + FZ[k] * sl * inv);
      // uv.x = metres still to fall, normalised. The fragment shader reads only this out of `uv`.
      uv.push(Math.min(HD[k] / 4.0, 1), 0); loc.push(WB[k], SL[k]); kind.push(0); flow.push(FX[k], FZ[k]);
      return id;
    };
    for (let j = 1; j < NZ - 2; j++) for (let i = 1; i < NX - 2; i++) {
      const k = j * NX + i;
      if (WB[k] < 0.03 && WB[k + 1] < 0.03 && WB[k + NX] < 0.03 && WB[k + NX + 1] < 0.03) continue;
      // every corner must be a sampled cell — an unsampled one carries the WL+1e3 sentinel, i.e. a spike
      if (RW[k] <= 0.02 || RW[k + 1] <= 0.02 || RW[k + NX] <= 0.02 || RW[k + NX + 1] <= 0.02) continue;
      quad(vert(i, j), vert(i + 1, j), vert(i, j + 1), vert(i + 1, j + 1));
    }
    // ---- plunge foam rings (flat on the pool the fall lands in — f.y, which is the WATER PLANE only for
    // the last step; the upper steps land on their own tread). aFlow.x carries that altitude so the shader
    // can end the collar where the ground climbs out of the pool, at any height, with one term.
    for (const f of falls) {
      // A PLUNGE RING IS FOAM ON A POOL — no pool, no ring. The previous build emitted one at every foot at
      // whatever altitude it landed on, and a foot on a dry crag shelf or a dry tread has nothing to spread
      // on: the collar's only escape was the ground climbing back OUT of the landing height, so anywhere the
      // rock stayed level the entire 22 m disc painted at full alpha. That is what the wave-5 self-check
      // photographed — hard-edged cream ellipses lying on dry stone (shot-fall1-40m, shot-fall2-8m), i.e.
      // the blob decree, twice, on ground cover. Dry feet still get their apron and their mist; what they do
      // not get is a flat white plate. The 2.2x drop clamp is the second half: a 1.6 m kerb was being given
      // the same 22 m collar as a 14 m cataract because the radius only ever read the fall's WIDTH.
      if (f.y > WL + 0.3) continue;
      const rr = Math.min(f.w * 0.5 + 3.0, f.hw * 2.2 + 2.5), ox = f.sx - f.dx * rr * 0.5, oz = f.sz - f.dz * rr * 0.5, base = pos.length / 3;
      const fy = f.y - WL;
      for (let j = 0; j < 4; j++) {
        const ax = (j & 1) * 2 - 1, az = ((j >> 1) & 1) * 2 - 1;
        pos.push(ox + (f.tx * ax + f.dx * az * 0.8) * rr, f.y + 0.07, oz + (f.tz * ax + f.dz * az * 0.8) * rr);
        uv.push(0, 0); loc.push(ax * 0.5 + 0.5, az * 0.5 + 0.5); kind.push(1); flow.push(fy, 0);
      }
      quad(base, base + 1, base + 2, base + 3);
    }
    // ---- spray mist: two crossed soft cards. Sized off the fall, and deliberately tall — from the pass
    // 300 m out the plumes ARE the vista: a receding sequence of white columns stepping down toward the
    // Court is what reads as a staircase at that range, long after the sheets themselves are 2 px wide.
    for (const f of falls) {
      const mw = f.w * 0.72 + 2.8, mh = f.hw * 1.25 + 3.6;   // taller: the plume column is the vista-range read of a step (wave-5 pass blocker)
      const my = f.y + mh * 0.42, ox = f.sx - f.dx * 1.6, oz = f.sz - f.dz * 1.6;
      for (let q = 0; q < 2; q++) {
        const ca = Math.cos(q * 1.1 - 0.55 + rnd() * 0.2), sa = Math.sin(q * 1.1 - 0.55);
        const ux = f.tx * ca - f.tz * sa, uz = f.tz * ca + f.tx * sa, base = pos.length / 3;
        for (let j = 0; j < 4; j++) {
          const ax = (j & 1) * 2 - 1, ay = ((j >> 1) & 1) * 2 - 1;
          pos.push(ox + ux * ax * mw, my + ay * mh * 0.5, oz + uz * ax * mw);
          uv.push(0, 0); loc.push(ax * 0.5 + 0.5, ay * 0.5 + 0.5); kind.push(2); flow.push(0, 0);
        }
        quad(base, base + 1, base + 2, base + 3);
      }
    }
    if (!idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aLocal', new THREE.Float32BufferAttribute(loc, 2));
    geo.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
    geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const u = this.uniforms;
    const mat = new THREE.ShaderMaterial({
      vertexShader: FALLS_VERT, fragmentShader: FALLS_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, lights: false,
      // shared ENTRY objects: the water surface's _updateUniforms (runs every frame, before renderOrder 6) keeps these fresh
      uniforms: { uTex: { value: this.normalTex }, uTime: u.uTime, uSunDir: u.uSunDir, uSunRad: u.uSunRad, uAmbient: u.uAmbient, uMoonRad: u.uMoonRad, uFogColor: u.uFogColor, uFogParams: u.uFogParams,
        uHeight: u.uHeight, uInvSize: u.uInvSize, uHeightOffset: u.uHeightOffset },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'water-falls'; mesh.renderOrder = 6; mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = true;
    mesh.raycast = () => {};
    this.falls = mesh; this.fallSites = falls;              // fallSites: exposed for Audio (roar emitters) / VFX (spray bursts)
    g.scene.add(mesh);
    let cov = 0, tot = 0; for (let k = 0; k < N; k++) if (RW[k] > 0.02) { tot++; if (WB[k] > 0.05) cov++; }
    console.log(`[water] cascades: ${falls.length} falls, ${idx.length / 3} tris, wet ${(100 * cov / tot).toFixed(1)}%, scan ${(performance.now() - t0) | 0} ms`);
  }

  // Shadowfen duckweed/scum: matte card patches hugging the shore shallows (wave-1 critic: peat murk needs a
  // choked surface, not open glass). One InstancedMesh, ~2 tris per card, one draw call, deterministic.
  _buildScum() {
    const g = this.game, tex = g.assets?.tex?.('card_moss');
    if (!tex || !g.terrain?.biomeAt) return;   // no asset / no biome query -> skip quietly (procedural fen still reads via the murk water)
    const rnd = mulberry32(g.seed + 40917);
    const S = g.terrain.size, half = S / 2;
    // scan for fen shore-shallow cells (16 m grid), then cluster cards on a deterministic subset
    const cand = [];
    for (let z = -half + 8; z < half; z += 16) for (let x = -half + 8; x < half; x += 16) {
      if (g.terrain.biomeAt(x, z) !== 'shadowfen') continue;
      const d = this.level - this._bed(x, z);
      if (d > 0.06 && d < 0.85) cand.push(x, z);
    }
    if (!cand.length) return;
    // clusters of WILDLY different size and character (wave-3: "the same pale patches cover every square
    // metre... they read as an oil slick"). A fen chokes in mats, not in wallpaper: a few big rafts, many
    // small ones, and large open water between them.
    // 46 -> 26 seeds, 18 m apart: the wave-5 critic's "flat opaque mint sheet" was in large part these cards —
    // enough of them blanketed the basin that the mats WERE the water surface in half the shots. Scum is an
    // accent on the murk, never a carpet over it.
    const seeds = [];
    for (let tries = 0; tries < 900 && seeds.length < 26; tries++) {
      const i = (rnd() * (cand.length / 2)) | 0, x = cand[i * 2], z = cand[i * 2 + 1];
      if (seeds.every((s) => (s[0] - x) ** 2 + (s[1] - z) ** 2 > 18 * 18)) seeds.push([x, z, rnd()]);
    }
    const mats = [], tints = [];
    const q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
    let cx = 0, cz = 0;
    for (const [sx, sz, big] of seeds) {
      const spread = 5 + big * big * 16;                       // 5 m knots .. 21 m rafts
      const nCards = 3 + ((rnd() * (3 + big * 16)) | 0);
      const algae = rnd() < 0.42;                              // dark slimy algae vs pale duckweed: two populations, not one ramp
      for (let k = 0; k < nCards; k++) {
        const x = sx + (rnd() - 0.5) * spread, z = sz + (rnd() - 0.5) * spread;
        const d = this.level - this._bed(x, z);
        if (d < 0.04 || d > 1.0) continue;   // stay in the damped shallows: waves are ~flat there, cards can float statically
        e.set(-Math.PI / 2, rnd() * Math.PI * 2, 0, 'YXZ'); q.setFromEuler(e);
        v.set(x, this.level + 0.045 + rnd() * 0.03, z);   // ponytail: static float height; upgrade = bob with water.heightAt in a vertex shader
        const s = (algae ? 0.7 : 1.4) + rnd() * (algae ? 1.1 : 2.6);
        sc.set(s * (0.75 + rnd() * 0.5), s * (0.75 + rnd() * 0.5), 1);
        mats.push(new THREE.Matrix4().compose(v, q, sc));
        // duckweed L 0.26-0.42 -> 0.13-0.21: under the fen's bright green ambient the pale population tone-
        // mapped to exactly the "mint" the wave-5 blocker names. Both populations are now dark peat tones —
        // the duckweed stays the visibly warmer/lighter of the two, but it can never carry the frame.
        tints.push(algae ? col.setHSL(0.27 + rnd() * 0.05, 0.34 + rnd() * 0.12, 0.09 + rnd() * 0.06).clone()
                         : col.setHSL(0.21 + rnd() * 0.05, 0.32 + rnd() * 0.14, 0.13 + rnd() * 0.08).clone());
        cx += x; cz += z;
      }
    }
    if (!mats.length) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    // alphaTest 0.5 alone was the wave-5 "raw screen-door alpha DITHER band along every shore": a cutout card
    // seen nearly edge-on minifies its alpha map into per-pixel pass/fail — a crawling checkerboard exactly in
    // the 5-15 m shore band the cards live in. Blend the edges instead (a low alphaTest stays, purely so the
    // fully-clear texels never occupy depth/blend slots); depthWrite off + renderOrder above the water surface
    // so the near-coplanar cards resolve by blending, not by fighting the depth buffer.
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.15, transparent: true, depthWrite: false, roughness: 1.0, metalness: 0, side: THREE.DoubleSide, color: new THREE.Color(0.30, 0.33, 0.18) });
    // instanceColor does NOT reach the fragment shader on its own in three r185 (USE_INSTANCING_COLOR is
    // emitted into the VERTEX prefix only) — without this patch every card renders the same olive and the
    // whole fen surface goes uniform, which is exactly the wave-3 "uniform across the whole basin" finding.
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vITint;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvITint = vec3(1.0);\n#ifdef USE_INSTANCING_COLOR\nvITint = instanceColor;\n#endif');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vITint;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vITint;');
    };
    mat.customProgramCacheKey = () => 'water-scum';
    const mesh = new THREE.InstancedMesh(geo, mat, mats.length);
    for (let i = 0; i < mats.length; i++) { mesh.setMatrixAt(i, mats[i]); mesh.setColorAt(i, tints[i]); }
    cx /= mats.length; cz /= mats.length;
    let r2 = 0;
    for (const m of mats) { const dx = m.elements[12] - cx, dz = m.elements[14] - cz; r2 = Math.max(r2, dx * dx + dz * dz); }
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, this.level, cz), Math.sqrt(r2) + 4);
    mesh.name = 'water-scum'; mesh.renderOrder = 6; mesh.castShadow = false; mesh.receiveShadow = true; mesh.frustumCulled = true;
    mesh.raycast = () => {};
    this._noReflect.add(mesh);   // never re-rendered into the half-res mirror
    this.scum = mesh;
    g.scene.add(mesh);
  }

  // terrain height (relative to the water level) baked into a half-float texture: depth/foam/caustics/shore edge per pixel, no scene depth needed
  _bakeHeight() {
    const terrain = this.game.terrain, S = terrain.size, L = this.level;
    const t0 = performance.now();
    // reuse Terrain's own 1 m height bake when it is there (texel i <-> x = i - S/2), else sample heightAt at texel centres
    const hg = terrain._hgt; const reuse = hg instanceof Float32Array && Number.isInteger(Math.sqrt(hg.length)) && hg.length >= 512 * 512;
    let R;
    if (reuse) { R = Math.sqrt(hg.length); this._heightOffset = 0.5 / R; }
    else {
      for (let i = 0; i < 2048; i++) terrain.heightAt((i % 64) * 3.1 - 100, ((i / 64) | 0) * 2.7 - 90);
      const per = (performance.now() - t0) / 2048;
      R = per * 1024 * 1024 < 450 ? 1024 : 512;                            // keep the bake under ~0.45 s
      this._heightOffset = 0;
    }
    const data = new Uint16Array(R * R); const toH = THREE.DataUtils.toHalfFloat;
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9, n = 0;
    // wet-texel bins -> per-basin bounding spheres for _waterOnScreen. The old proxy was ONE hardcoded
    // Mirrormere sphere, so the mirror + refraction grab never ran in any of the nine outer biomes — the
    // sunken sea rendered its flat fallback forever (wave-1 "flat mint cutout").
    const BIN = 128, NB = Math.ceil(S / BIN), bins = new Map();
    for (let j = 0; j < R; j++) {
      const z = reuse ? j - R / 2 : -S / 2 + (j + 0.5) * S / R;
      for (let i = 0; i < R; i++) {
        const x = reuse ? i - R / 2 : -S / 2 + (i + 0.5) * S / R;
        const h = (reuse ? hg[j * R + i] : terrain.heightAt(x, z)) - L + (terrain.dryAt ? terrain.dryAt(x, z) * 300 : 0);
        data[j * R + i] = toH(Math.max(-60, Math.min(60, h)));
        if (h < 0.6) {
          n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          const key = Math.floor((x + S / 2) / BIN) * (NB + 1) + Math.floor((z + S / 2) / BIN);
          let b = bins.get(key); if (!b) bins.set(key, b = [1e9, 1e9, -1e9, -1e9]);
          if (x < b[0]) b[0] = x; if (z < b[1]) b[1] = z; if (x > b[2]) b[2] = x; if (z > b[3]) b[3] = z;
        }
      }
    }
    this._wetSpheres = [...bins.values()].map(([x0, z0, x1, z1]) =>
      new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, L, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0) / 2 + 25));
    const tex = new THREE.DataTexture(data, R, R, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.generateMipmaps = false; tex.needsUpdate = true;
    this.heightTex = tex;
    this.hasWater = n > 0;
    this.waterCenter = new THREE.Vector3((minX + maxX) / 2, L, (minZ + maxZ) / 2);
    this.waterRadius = n ? Math.hypot(maxX - minX, maxZ - minZ) / 2 + 40 : 1;
    this.bakeMs = performance.now() - t0; this.bakeRes = R;
  }

  // tileable slope (rg) + foam noise (b) + height (a) map: sum of integer-wavevector sinusoids (tiles by construction), seeded
  _bakeNormal() {
    const R = 256, rnd = mulberry32(this.game.seed + 9107);
    const mk = (count, kmin, kspan, pw) => { const a = []; for (let i = 0; i < count; i++) { const ang = rnd() * Math.PI * 2, km = kmin + Math.pow(rnd(), pw) * kspan; let nx = Math.round(Math.cos(ang) * km), nz = Math.round(Math.sin(ang) * km); if (!nx && !nz) nx = 1; const kk = Math.hypot(nx, nz); a.push({ nx, nz, a: 1 / Math.pow(kk, 1.2), ph: rnd() * Math.PI * 2 }); } return a; };
    const w1 = mk(26, 2, 18, 1.6), w2 = mk(12, 3, 9, 1.0);
    const h = new Float32Array(R * R), gx = new Float32Array(R * R), gz = new Float32Array(R * R), h2 = new Float32Array(R * R);
    let hmin = 1e9, hmax = -1e9, gsq = 0, h2min = 1e9, h2max = -1e9;
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const u = i / R, v = j / R, idx = j * R + i; let s = 0, sx = 0, sz = 0, s2 = 0;
      for (const w of w1) { const arg = 2 * Math.PI * (w.nx * u + w.nz * v) + w.ph; const sn = Math.sin(arg), cs = Math.cos(arg); s += w.a * sn; sx += w.a * 2 * Math.PI * w.nx * cs; sz += w.a * 2 * Math.PI * w.nz * cs; }
      for (const w of w2) s2 += w.a * Math.sin(2 * Math.PI * (w.nx * u + w.nz * v) + w.ph);
      h[idx] = s; gx[idx] = sx; gz[idx] = sz; h2[idx] = s2;
      if (s < hmin) hmin = s; if (s > hmax) hmax = s; if (s2 < h2min) h2min = s2; if (s2 > h2max) h2max = s2;
      gsq += sx * sx + sz * sz;
    }
    const gmax = 2.5 * Math.sqrt(gsq / (2 * R * R));   // normalise slopes by 2.5 sigma (clamped) so typical ripples use the 8-bit range
    const cl = (v) => Math.max(0, Math.min(255, v));
    const data = new Uint8Array(R * R * 4);
    for (let i = 0; i < R * R; i++) {
      data[i * 4] = cl((gx[i] / gmax * 0.5 + 0.5) * 255); data[i * 4 + 1] = cl((gz[i] / gmax * 0.5 + 0.5) * 255);
      data[i * 4 + 2] = (h2[i] - h2min) / (h2max - h2min) * 255; data[i * 4 + 3] = (h[i] - hmin) / (hmax - hmin) * 255;
    }
    const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true;
    tex.anisotropy = Math.min(this.game.renderer.qualityPreset?.anisotropy ?? 8, this.game.renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    this.normalTex = tex;
  }

  // fine grid around the camera (Gerstner-displaced) + coarse flat skirt to the world edge, overlapping one coarse cell (flat there -> no cracks)
  _buildGeometry() {
    const { fine, span } = this.qp;
    const pos = [], idx = [];
    const grid = (half, cells, skip) => {
      const s = (half * 2) / cells, base = pos.length / 3;
      for (let j = 0; j <= cells; j++) for (let i = 0; i <= cells; i++) pos.push(-half + i * s, 0, -half + j * s);
      for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
        const x0 = -half + i * s, z0 = -half + j * s;
        if (skip && skip(x0, z0, s)) continue;
        const a = base + j * (cells + 1) + i, b = a + 1, c = a + cells + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    };
    grid(span / 2, fine, null);
    const hole = span / 2 - COARSE;   // coarse cells fully inside +-hole are covered by the fine grid
    const worldHalf = Math.ceil((this.game.terrain.size / 2 + 200) / COARSE) * COARSE;
    grid(worldHalf, (worldHalf * 2) / COARSE, (x0, z0, s) => x0 >= -hole && x0 + s <= hole && z0 >= -hole && z0 + s <= hole);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.waterRadius);
    geo.boundingBox = null;
    this.mesh.geometry?.dispose?.();
    this.mesh.geometry = geo;
    this.tris = idx.length / 3;
  }

  // ---------------------------------------------------------------- per frame
  update(dt, t) {
    this.time = t; this._frame++;
    const m = this.mesh; if (!m) return;
    const cam = this.game.camera;
    m.position.set(Math.round(cam.position.x / COARSE) * COARSE, this.level, Math.round(cam.position.z / COARSE) * COARSE);
    // culling sphere = all water basins, in mesh-local space
    m.geometry.boundingSphere.center.set(this.waterCenter.x - m.position.x, 0, this.waterCenter.z - m.position.z);
    m.visible = this.hasWater;
  }

  /** Water reads as the place it is in: peat murk in the fen, open ocean over the Sunken Kingdom, meltwater in the tundra. */
  _gradeWater(camera) {
    const u = this.uniforms, base = this._baseWater; if (!base) return;
    u.uShallow.value.copy(base.sh); u.uDeep.value.copy(base.dp); u.uAbsorb.value.copy(base.ab);
    u.uReflTint.value.copy(base.rt); u.uRough.value = base.rgh; u.uDetail.value = base.det; u.uFoamMul.value = 1; u.uSpecMul.value = 1; u.uRapid.value = 0;
    u.uReflCap.value = 0.62; u.uReflBlur.value = 0;
    const b = this.game.terrain?.biomeBlend?.(camera.position.x, camera.position.z, this._wb ??= {});
    u.uLava.value = b && b.id === 'infernal' ? b.w : 0;
    u.uRapid.value = b && b.id === 'sunken' ? b.w : 0;
    u.uFilm.value = b && b.id === 'shadowfen' ? b.w : 0;   // tannin scum + marsh-gas rings: the fen's only surface detail
    // dry skirt: 0.6 m normally, 3.6 m of DEPTH over lava — enough headroom that the heat wash, which is
    // measured in horizontal ground metres, always reaches zero before the discard, however steep the bank
    // (wave-3 "flat quads with razor-straight polygon edges clipping through their banks").
    u.uDryW.value = 0.6 + 3.0 * u.uLava.value;
    const P = b && b.w > 0.002 ? WATER_LOOK[b.id] : null; if (!P) return;
    const w = b.w;
    u.uShallow.value.setRGB(base.sh.r + (P.sh[0] - base.sh.r) * w, base.sh.g + (P.sh[1] - base.sh.g) * w, base.sh.b + (P.sh[2] - base.sh.b) * w);
    u.uDeep.value.setRGB(base.dp.r + (P.dp[0] - base.dp.r) * w, base.dp.g + (P.dp[1] - base.dp.g) * w, base.dp.b + (P.dp[2] - base.dp.b) * w);
    u.uAbsorb.value.set(base.ab.x + (P.ab[0] - base.ab.x) * w, base.ab.y + (P.ab[1] - base.ab.y) * w, base.ab.z + (P.ab[2] - base.ab.z) * w);
    if (P.rt) u.uReflTint.value.setRGB(base.rt.r + (P.rt[0] - base.rt.r) * w, base.rt.g + (P.rt[1] - base.rt.g) * w, base.rt.b + (P.rt[2] - base.rt.b) * w);
    if (P.rgh !== undefined) u.uRough.value = base.rgh + (P.rgh - base.rgh) * w;
    if (P.det !== undefined) u.uDetail.value = base.det + (P.det - base.det) * w;
    if (P.fm !== undefined) u.uFoamMul.value = 1 + (P.fm - 1) * w;
    if (P.sp !== undefined) u.uSpecMul.value = 1 + (P.sp - 1) * w;
    if (P.rc !== undefined) u.uReflCap.value = 0.62 + (P.rc - 0.62) * w;
    if (P.rb !== undefined) u.uReflBlur.value = P.rb * w;
  }

  /** One source of truth for the underwater medium — Sky (scene fog) and PostFX (full-screen grade) can read
   *  this so geometry, sky and the water surface agree on what being submerged looks like. Matches the
   *  surface shader's from-below volume fog: per-biome colour, ~40-60 m visibility, denser with depth. */
  underwater(camera = this.game.camera) {
    const out = this._uw ??= { submerged: false, depth: 0, fogColor: new THREE.Color(), fogDensity: 0 };
    const p = camera.position, d = Math.max(0, this.level - p.y);
    out.submerged = d > 0 && this.isWater(p.x, p.z);
    out.depth = out.submerged ? d : 0;
    const u = this.uniforms;
    if (!u) { out.fogDensity = 0; return out; }
    const ab = u.uAbsorb.value, abm = (ab.x + ab.y + ab.z) / 3;
    // FogExp2 equivalent of the shader's exp(-kW * dist) linear-ish falloff: density = sqrt(kW)/~distance scale
    const kW = 0.050 * (0.55 + 0.30 * abm) * (1 + out.depth * 0.035);
    out.fogDensity = out.submerged ? Math.sqrt(kW) * 0.045 : 0;
    out.fogColor.copy(u.uDeep.value).multiplyScalar(1.6 * Math.exp(-abm * out.depth * 0.22));
    return out;
  }

  _updateUniforms(camera) {
    const { sky, scene } = this.game, u = this.uniforms;
    this._gradeWater(camera);
    u.uTime.value = this.time; u.uDebug.value = this.debug | 0;
    u.uSunDir.value.copy(sky.sunDir);
    u.uSunRad.value.copy(sky.sunColor).multiplyScalar((sky.sunIntensity ?? 1) * this.sunStrength);
    u.uMoonDir.value.copy(sky.moonDir ?? u.uMoonDir.value);
    u.uMoonRad.value.setRGB(0.55, 0.68, 1.0).multiplyScalar(this.moonStrength * (sky.night ?? 0) * Math.max(0, sky.moonDir?.y ?? 0));
    u.uNight.value = sky.night ?? 0;
    u.uSkyColor.value.copy(sky.skyColor); u.uHorizonColor.value.copy(sky.horizonColor ?? sky.skyColor); u.uAmbient.value.copy(sky.ambientColor ?? sky.skyColor);
    const fog = scene.fog;
    if (fog) { u.uFogColor.value.copy(fog.color); u.uFogParams.value.set(fog.density ?? 0, fog.near ?? 0, fog.far ?? 0); } else { u.uFogColor.value.copy(sky.fogColor ?? sky.skyColor); u.uFogParams.value.set(0, 0, 0); }
    u.uCamBelow.value = camera.position.y < this.level ? 1 : 0;
  }

  // Is any actual water plausibly ON SCREEN? The surface mesh follows the camera everywhere, so
  // onBeforeRender fires (and paid for a mirror + a framebuffer grab) even standing in the meadow
  // with the lake behind you. Proxy: every wet basin's bounding sphere (baked in _bakeHeight — ALL the
  // basins, not just Mirrormere) vs the camera frustum, or the camera being over/near water. A few dozen
  // sphere tests per frame; saves both passes when false. (perf audit 2026-08-20 lead #1)
  _waterOnScreen(camera) {
    const p = camera.position;
    if (this.isWater(p.x, p.z) || this.submergedDepth(p) > 0) return true;
    const S = this._wetSpheres; if (!S || !S.length) return false;
    this._fr ??= new THREE.Frustum(); this._frM ??= new THREE.Matrix4();
    this._frM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._fr.setFromProjectionMatrix(this._frM);
    for (let i = 0; i < S.length; i++) if (this._fr.intersectsSphere(S[i])) return true;
    return false;
  }

  _onBeforeRender(renderer, scene, camera) {
    if (scene.overrideMaterial) return;
    const u = this.uniforms;
    this._updateUniforms(camera);
    if (camera === this.game.camera && !this._waterOnScreen(camera)) { u.uHasGrab.value = 0; u.uHasReflect.value = 0; this.cpuMs.grab = 0; this.cpuMs.reflect = 0; return; }
    // ---- refraction grab: copy the opaque scene (everything drawn before this transparent mesh) ----
    const tg0 = performance.now();
    const rt = renderer.getRenderTarget();
    const samples = rt ? rt.samples : 0;
    if (samples === 0 && this.qp.grab) {
      let w, h, type;
      if (rt) { w = rt.width; h = rt.height; type = rt.texture.type; } else { renderer.getDrawingBufferSize(this._v2); w = this._v2.x; h = this._v2.y; type = THREE.UnsignedByteType; }
      let g = this._grab;
      if (!g || g.image.width !== w || g.image.height !== h || g.type !== type) {
        g?.dispose();
        g = this._grab = new THREE.FramebufferTexture(w, h);
        g.type = type; g.minFilter = g.magFilter = THREE.LinearFilter; g.generateMipmaps = false;
        u.uGrab.value = g; u.uGrabSize.value.set(w, h);
      }
      renderer.copyFramebufferToTexture(g);
      u.uHasGrab.value = 1;
    } else u.uHasGrab.value = 0;   // ponytail: MSAA composer buffer can't be copied -> alpha-blend fallback; upgrade = own refraction pass
    const tg1 = performance.now(); this.cpuMs.grab = tg1 - tg0;
    // ---- planar reflection (every qp.everyN frames, main camera only; the RT + its matrix stay consistent when reused) ----
    if (!this.reflectionEnabled || !this.qp.refl || camera !== this.game.camera) { u.uHasReflect.value = 0; return; }
    const stale = this._frame - this._reflFrame;
    if (stale <= 0 || (u.uHasReflect.value > 0 && stale < this.qp.everyN)) { this.cpuMs.reflect = 0; return; }   // reuse last render
    u.uHasReflect.value = 0;
    if (this._renderReflection(renderer, scene, camera)) { this._reflFrame = this._frame; u.uHasReflect.value = 1; }
    this.cpuMs.reflect = performance.now() - tg1;
  }

  _renderReflection(renderer, scene, camera) {
    const cam = this._reflCam, normal = this._normal;
    this._planePos.set(0, this.level, 0);
    this._camPos.setFromMatrixPosition(camera.matrixWorld);
    const view = this._view.subVectors(this._planePos, this._camPos);
    if (view.dot(normal) > 0) return false;                 // camera under the surface: nothing to reflect
    view.reflect(normal).negate().add(this._planePos);
    this._rot.extractRotation(camera.matrixWorld);
    const look = this._look.set(0, 0, -1).applyMatrix4(this._rot).add(this._camPos);
    const target = this._target.subVectors(this._planePos, look).reflect(normal).negate().add(this._planePos);
    cam.position.copy(view);
    cam.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(normal);
    cam.lookAt(target);
    cam.near = camera.near; cam.far = camera.far; cam.layers.mask = camera.layers.mask;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);
    this._reflMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    // oblique near plane = water plane (Lengyel), so nothing below the surface leaks into the reflection
    this._plane.setFromNormalAndCoplanarPoint(normal, this._planePos).applyMatrix4(cam.matrixWorldInverse);
    const c = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const pm = cam.projectionMatrix, q = this._q;
    q.x = (Math.sign(c.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(c.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1; q.w = (1 + pm.elements[10]) / pm.elements[14];
    c.multiplyScalar(2 / c.dot(q));
    pm.elements[2] = c.x; pm.elements[6] = c.y; pm.elements[10] = c.z + 1 - 0.002; pm.elements[14] = c.w;
    // target at qp.refl x drawing-buffer size
    renderer.getDrawingBufferSize(this._v2);
    const w = Math.max(64, Math.floor(this._v2.x * this.qp.refl)), h = Math.max(64, Math.floor(this._v2.y * this.qp.refl));
    if (!this._reflRT || this._reflRT.width !== w || this._reflRT.height !== h) {
      this._reflRT?.dispose();
      // mipmapped so the shader can mip-bias with distance (cheap blur -> no blocky smear bands at grazing angles)
      this._reflRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
      this.uniforms.uReflect.value = this._reflRT.texture;
    }
    // hide vertex/CPU-heavy small stuff from the mirror (rescan the scene occasionally: enemies/vfx spawn late)
    if (this._frame - (this._scanFrame ?? -1e9) > 300) { this._scanFrame = this._frame; scene.traverse((o) => { if (o.name && NO_REFLECT.test(o.name)) this._noReflect.add(o); }); }
    // render
    this.mesh.visible = false;
    const hidden = this._hidden ??= [];
    // NEVER hide a LIGHT from the mirror (perf pass 2026-08-28, MEASURED): NO_REFLECT's `vfx-` prefix was
    // catching the four pooled `vfx-flash` PointLights, so this pass rendered with numPointLights 3 while
    // the main pass (and every boot-warmed program) is keyed 7 — and three keys programs by light count, so
    // every material the mirror saw for the first time LINKED A FRESH VARIANT mid-play: 1339 ms frozen on
    // first infernal approach (lava mirrors the whole region), 173 ms at the tundra lake, and the steady
    // drip of 50-150 ms 'render' spikes at Mirrormere/pirate coves (tools/out/perf-tp-after, proglink
    // probe: linked keys differ from warmed ones ONLY in numPointLights 3 vs 7). Keeping the lights
    // visible costs nothing new to link — the mirror then uses the exact programs the main pass already
    // built — and a muzzle flash reflecting in water is more correct, not less. Meshes stay excluded.
    hidden.length = 0; for (const o of this._noReflect) if (o.visible && !o.isLight) { o.visible = false; hidden.push(o); }
    const curRT = renderer.getRenderTarget(), curXr = renderer.xr.enabled, curShadow = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false;   // reuse this frame's shadow maps
    renderer.setRenderTarget(this._reflRT);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, cam);
    renderer.xr.enabled = curXr; renderer.shadowMap.autoUpdate = curShadow;
    renderer.setRenderTarget(curRT);
    if (camera.viewport !== undefined) renderer.state.viewport(camera.viewport);
    for (const o of hidden) o.visible = true;
    this.mesh.visible = true;
    return true;
  }

  resize() { /* render targets are re-fitted lazily from the drawing-buffer size */ }
}
