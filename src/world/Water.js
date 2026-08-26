import * as THREE from 'three';
import { mulberry32 } from '../core/Noise.js';

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
 *  - Shadowfen: opaque peat murk (extinction < 1 m), dark olive mirror, oily still surface, duckweed scum
 *    patches (instanced matte cards) hugging the shores. Sun/moon specular is per-biome capped (sp key):
 *    under the fen's overcast key a glossy glint read as washed-white blobs — blob law applies to water too.
 *  - Sunken cascade gorge (docs/SUNKEN-REDESIGN-BRIEF.md): waterfall curtains draped on every wall the
 *    water laps against (auto-scanned from the terrain bake — riser notches, gorge flanks), plunge-pool
 *    foam rings and soft mist cards at each fall base (merged: 2 draw calls total), plus advected
 *    white-water streaks in the shader flowing down-gorge. All foam/mist is LIT colour, luma-capped —
 *    silver, never clipped white.
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
// (white lace reads wrong on a peat bog), sp = sun/moon specular multiplier — all lerped by biome weight.
const WATER_LOOK = {
  // peat murk: extinction inside ~0.5 m, green-black body, dark olive mirror, oily still surface (wave-1 critic).
  // rgh 0.155 -> 0.34 + sp 0.05 (wave-2 BLOCKER): the glossy lobe threw huge washed-white sun smears under the
  // overcast key (the sun uniform doesn't know about cloud) — satin sheen only, the glint can never reach white.
  shadowfen: { sh: [0.040, 0.062, 0.030], dp: [0.006, 0.011, 0.004], ab: [7.50, 4.80, 8.50], rt: [0.40, 0.46, 0.38], rgh: 0.34, det: 0.16, fm: 0.25, sp: 0.05 },
  // cascade gorge (user decree 2026-08-25): clear fast mountain water at wading depth, not open ocean
  sunken:    { sh: [0.060, 0.200, 0.240], dp: [0.008, 0.045, 0.075], ab: [1.30, 0.55, 0.30], fm: 1.35, det: 0.44 },
  tundra:    { sh: [0.075, 0.215, 0.310], dp: [0.008, 0.045, 0.115], ab: [1.45, 0.55, 0.26] },   // meltwater under ice
  void:      { sh: [0.030, 0.020, 0.075], dp: [0.004, 0.002, 0.020], ab: [2.20, 2.40, 1.30] },
  infernal:  { sh: [0.180, 0.045, 0.010], dp: [0.060, 0.012, 0.002], ab: [0.60, 2.40, 3.20] },   // molten: the uLava skin does the rest
};
const COARSE = 32;   // coarse skirt cell (m); fine grid snaps to it
const G = 9.81;

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
  if (depth < -0.6) discard;                                        // dry land well above the plane
  float d0 = max(depth, 0.0);
  vec3 V = normalize(cameraPosition - vWorld);
  float dist = vViewZ;
  float t = uTime;
  vec2 p = vWorld.xz;

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
    float c1 = texture2D(uNormal, bp * 0.13 + vec2(0.035, 0.021) * t).a;
    float c2 = texture2D(uNormal, bp * 0.095 - vec2(0.027, -0.033) * t).a;
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
  float rbias = clamp(dist * 0.004, 0.15, 0.7) + (1.0 - NdotV) * 0.35;   // grazing bias, trimmed: the old 1.2 cap blurred the far shore into mush
  vec3 skyR = skyGrad(reflect(-V, n)) * 0.92;
  float noRefl = 1.0 - step(0.5, uHasReflect);   // q=low (and the first frames): the flat sky gradient is the only mirror we have
  // tint the gradient fallback toward the lake body ALWAYS (0.7 weight, not just on noRefl): untinted it painted the
  // midday far field a flat milky sheet on q=low AND smeared a pale vertical column wherever the RT edge fade used it
  // (the waterline band artifact) — partial weight keeps the golden-hour horizon warmth alive in the fallback
  skyR = mix(skyR, skyR * (uShallow * 1.9 + 0.42), 0.7);
  float redge = smoothstep(0.0, 0.075, min(min(ruv.x, 1.0 - ruv.x), min(ruv.y, 1.0 - ruv.y)));
  vec3 refl;
  if (uHasReflect > 0.5 && uCamBelow < 0.5) {
    // grazing views magnify the half-res RT: hard silhouettes (trunks, dunes) turned into stair-stepped blocks.
    // Mip bias alone can't fix an LOD-0 magnification, so smear 3 taps vertically — the axis planar mirrors
    // stretch along — with a width that grows toward grazing and vanishes head-on.
    // widened at night: a small VERY bright reflected source (the fen waystone beacon) is a thin vertical
    // streak in a half-res RT, and LOD-0 magnification stair-steps it (wave-2 minor). The smear axis is the
    // axis the steps run along, so 3x the width at night dissolves them; the night sky itself is smooth.
    float roff = (1.0 - NdotV) * 0.0045 * (1.0 + uNight * 1.8);
    vec3 rtex = (texture2D(uReflect, clamp(ruv, 0.001, 0.999), rbias).rgb
               + texture2D(uReflect, clamp(ruv + vec2(0.0, roff), 0.001, 0.999), rbias).rgb
               + texture2D(uReflect, clamp(ruv - vec2(0.0, roff), 0.001, 0.999), rbias).rgb) * (1.0 / 3.0);
    refl = mix(skyR, rtex, redge);
  } else refl = (uCamBelow > 0.5) ? scatter : skyR;
  refl *= uReflTint;
  // hue-preserving cap (same trick as the moon trail below): at grazing angles the mirror carries the whole
  // bright sky, which reads as a washed milky-white sheet at distance — worst at q=low where the flat
  // sky-gradient fallback IS the mirror (blobcheck-gated). Sun/moon glitter lives in spec, unaffected.
  float rlum = dot(refl, LUMA);
  refl *= 0.62 / max(rlum, 0.62);

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
  col += uAmbient * uNight * (0.05 + 0.3 * pow(1.0 - NdotV, 3.0));   // ambient sheen: night lake never falls to featureless black
#ifdef WATER_HQ
  // star-glint twinkle everywhere at night (not just the moon azimuth): sparse product threshold of two scrolling height layers
  float star = smoothstep(0.86, 0.985, n3.a) * smoothstep(0.72, 0.95, n1.a);
  // flat magnitude: the old 1/(1+dist) falloff drew a bright blue disc centred on the player. Only fade far, where it aliases.
  col += vec3(0.6, 0.75, 1.0) * (star * star * uNight * 1.15 * hqNear);   // hqNear, not its own falloff: n3 stops being fetched at 130 m, so the twinkle has to be gone by then or it pops off
#endif
  }

  // ---- shoreline foam: a pixel-crisp lace line hugging every contact isoline (fwidth-normalised width, noise-wobbled, breathing)
  //      + a couple of broken wash fronts creeping up the shelf + sparse crest lace. Never a blanket over the whole shelf ----
  // rotate + domain-warp the foam noise (it was sampled straight on the tile grid: at 100+ m only the tile's
  // lowest frequency survived the mips, which drew one bright clump per 14 m repeat = the "dashed line" shore)
  vec2 pf = mat2(0.31, -0.95, 0.95, 0.31) * p * 1.014 + (n1.rg * 2.0 - 1.0) * 1.4;
  float fp = n2.a * 0.6 + texture2D(uNormal, pf * 0.07 + vec2(-0.02, 0.035) * t).b * 0.7;
  float distF = smoothstep(60.0, 200.0, dist);
  // HARD hand-over to a clean continuous hairline past ~90 m. Damping the far-field noise was not enough
  // (wave-2: "the right half still resolves into evenly spaced white dashes"): ANY per-pixel modulation of
  // a band that is 1-2 px wide aliases into evenly spaced dashes, whichever term it comes from. Past that,
  // the isoline is smooth, the lace is solid, and the LINE FADES BY AMPLITUDE instead — which is also what
  // kills the island's uniform white collar. You cannot resolve foam lace at 150 m anyway.
  float far = smoothstep(70.0, 150.0, dist);
  float iso = d0 + ((fp - 0.62) * 0.07 + 0.035 * sin(t * 1.3 + fp * 9.0)) * (1.0 - far);
  // band width = max(~6 screen px, 9 cm of depth), capped at 55 cm: a hairline at distance, a believable wash at your
  // feet, and never the whole shelf even where the bed is nearly flat. Far shores thin toward a soft bright
  // edge instead of holding a uniform 55 cm skirt (the island wore it like a white collar).
  // ...and a SCREEN-SPACE FLOOR on the band, which is what finally kills the dashes. The band's on-screen
  // width is bandW / |grad depth|, and the baked bed is bilinear, so its gradient is piecewise constant per
  // texel: the width steps at every texel edge. Thinning the far band by 65% then pushed the steep steps
  // below one pixel — the line vanished there and survived elsewhere, i.e. evenly spaced dashes locked to
  // the height-texture grid. fwD is one pixel of depth, so max(..., fwD * 2.5) guarantees ~2.5 px of line
  // everywhere: thickness still varies, but it can never break. Costs nothing (fwD is already computed).
  float bandW = max(clamp(fwD * 6.0, 0.09, 0.55) * (1.0 - 0.65 * distF), fwD * 2.5);
  float lace = texture2D(uNormal, p * 0.31 + vec2(0.05, -0.04) * t).b;
  float holes = 0.25 + 0.75 * smoothstep(0.12, 0.58, lace * 0.6 + fp * 0.4);  // lace texture: bright clumps + gaps, never fully solid
  // far away the clump/gap pattern is sub-pixel: go SOLID (no gaps to alias into dashes) and let the
  // macro field (217 m period) only swell/thin the line gently, well above zero so it never breaks
  holes = mix(holes, 0.72 + 0.28 * macro, far);
  float foam = (1.0 - smoothstep(0.0, bandW, iso)) * holes;                   // the contact lace (land side is clipped by the shore alpha)
  float arc = smoothstep(0.10, 0.03, abs(fract(iso * 2.2 + fp * 0.3 - t * 0.09) - 0.4) - 0.05);   // wash fronts sliding shoreward
  foam += arc * smoothstep(0.75, 0.15, iso) * smoothstep(0.5, 0.82, fp) * 0.5 * (1.0 - smoothstep(60.0, 170.0, dist));
  // sparse wave-crest lace in open water. 0.30/0.45 put a white cap on roughly a third of the lake at any
  // instant and read as soap suds from the shore; a lake this calm should only lace the sharpest crests.
  foam += smoothstep(0.62, 0.92, vCrest / uSumAmp) * smoothstep(0.62, 0.88, fp) * 0.16;
  // White-water rapids (sunken cascade gorge): elongated foam streaks running downhill.
  // Gate them on the BED SLOPE, not on depth. The gorge is 0.91 m deep at its deepest point (wave-3 kernel
  // scan), so the old shallow-water test was true EVERYWHERE and painted the whole region one silver sheet.
  // Bed slope separates it cleanly: p50 over wet cells is 0.006, p90 is 0.147 — flats vs cut channels differ
  // by 20x. So: still plazas on the terraces, white water only in the channels and down the risers.
  if (uRapid > 0.001) {
    float e = 3.0 * uInvSize;
    vec2 huv = vWorld.xz * uInvSize + 0.5 + uHeightOffset;
    vec2 gb = vec2(texture2D(uHeight, huv + vec2(e, 0.0)).r - texture2D(uHeight, huv - vec2(e, 0.0)).r,
                   texture2D(uHeight, huv + vec2(0.0, e)).r - texture2D(uHeight, huv - vec2(0.0, e)).r);
    float fast = smoothstep(0.025, 0.13, length(gb) * (1.0 / 6.0));   // gb spans 6 m of world
    // Rotated flow frame is safe HERE (unlike the lava skin, which had to stay world-aligned): the frame's
    // singularity is where the gradient vanishes, and that is exactly where fast is 0, so the vortex the
    // lava probe found can never become visible.
    vec2 fd2 = -gb / max(length(gb), 1e-4);                                              // downstream
    vec2 q = vec2(dot(p, fd2), dot(p, vec2(-fd2.y, fd2.x)));
    float s1 = texture2D(uNormal, vec2(q.x * 0.020 - t * 0.055, q.y * 0.11)).b;         // ~2.8 m/s downstream
    float s2 = texture2D(uNormal, vec2(q.x * 0.033 - t * 0.115 + 0.37, q.y * 0.19 + 0.5)).b;
    float streak = smoothstep(0.50, 0.86, s1 * 0.62 + s2 * 0.55);
    foam += uRapid * fast * (streak * 0.85 + smoothstep(0.26, 0.04, d0) * 0.35);        // streaks + froth against the bank
  }
  // far field: the line fades by AMPLITUDE (a dim continuous hairline), never by punching gaps in it
  foam = clamp(foam, 0.0, 1.0) * uFoamMul * (1.0 - 0.55 * far) * (1.0 - smoothstep(200.0, 480.0, dist)) * (1.0 - uCamBelow);
  vec3 foamCol = vec3(0.8) * (uSunRad * max(dot(vGN, uSunDir), 0.0) * 0.4 + uAmbient * 1.1 + uMoonRad * 0.35);
  foamCol /= (1.0 + dot(foamCol, LUMA) * 0.35);   // blob law on the lace: golden-hour sun radiance pushed this past the bloom threshold
  col = mix(col, foamCol, foam);

  // ---- fog (matches three's FogExp2 / Fog on view depth). AIR fog — it never applies under the surface:
  //      the below branch already sank the surface into its own water-volume fog ----
  float fog = (uFogParams.z > uFogParams.y) ? smoothstep(uFogParams.y, uFogParams.z, vViewZ) : 1.0 - exp(-uFogParams.x * uFogParams.x * vViewZ * vViewZ);
  col = mix(col, uFogColor, fog * (1.0 - uCamBelow));

  float alpha = smoothstep(0.0, 0.045, depth);                                  // knife-edge shore: water identity survives at 2 cm depth
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
    // flow direction = downhill of the baked bed (the channels are carved below waterLevel): two cheap gradient taps
    float e = 4.0 * uInvSize;
    vec2 huv = vWorld.xz * uInvSize + 0.5 + uHeightOffset;
    vec2 gb = vec2(texture2D(uHeight, huv + vec2(e, 0.0)).r - texture2D(uHeight, huv - vec2(e, 0.0)).r,
                   texture2D(uHeight, huv + vec2(0.0, e)).r - texture2D(uHeight, huv - vec2(0.0, e)).r);
    vec2 fd = normalize(gb + vec2(1e-4, 3e-4));                       // +x of the flow frame runs downhill
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
      float ph1 = fract(uTime * 0.125), ph2 = fract(ph1 + 0.5);
      float bl = abs(ph1 * 2.0 - 1.0);
      vec2 base = vWorld.xz * 0.05 + po;
      vec3 ta = texture2D(uLavaTex, base - fd * 0.14 * (ph1 - 0.5)).rgb;
      vec3 tb = texture2D(uLavaTex, base - fd * (0.14 * (ph2 - 0.5) + 0.02)).rgb;
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
    // ...and put the heat ON THE ROCK. The water mesh already covers 0.6 m of DRY ground past the shoreline
    // (the discard is at depth < -0.6); until now uLava forced that skirt fully opaque, so the pool visibly
    // spilled onto the bank. Instead, fade it out as a translucent saturated ember wash: a heat decal that
    // reads as light pooling on the rock, which a pure emissive surface can never do. No light source, no
    // shadow cost, and it dies within 0.6 m so it cannot become a glowing halo.
    float dryS = clamp(-depth * (1.0 / 0.6), 0.0, 1.0);   // 0 at the waterline -> 1 at the discard edge
    vec3 heat = vec3(1.0, 0.30, 0.04) * (0.45 + 0.17 * sin(uTime * 0.8 + vWorld.x * 0.6 + vWorld.z * 0.45));
    heat *= min(1.0, 0.50 / max(dot(heat, LUMA), 1e-4));  // hue-preserving cap: fire, never a white rim
    lcol = mix(lcol, heat, smoothstep(0.0, 0.15, dryS));
    col = mix(col, lcol, uLava);
    alpha = mix(alpha, 1.0 - smoothstep(0.0, 0.85, dryS), uLava);
  }
  if (uDebug > 0.5) {   // 1 reflection, 2 refraction grab, 3 depth, 4 foam, 5 normal
    if (uDebug < 1.5) col = texture2D(uReflect, clamp(rp.xy / rp.w, 0.0, 1.0)).rgb;
    else if (uDebug < 2.5) col = texture2D(uGrab, gl_FragCoord.xy / uGrabSize).rgb;
    else if (uDebug < 3.5) col = vec3(fract(d0), d0 / 10.0, step(depth, 0.0));
    else if (uDebug < 4.5) col = vec3(foam);
    else col = n * 0.5 + 0.5;
    alpha = 1.0;
  }
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---- Sunken cascade dressing: waterfall curtains + plunge foam rings + spray mist, ONE merged mesh /
// ONE draw call. aKind picks the branch. All colour is LIT (sun/ambient/moon uniforms shared with the
// water surface) and hue-preserving-capped — the blob law: silver foam, never clipped white.
const FALLS_VERT = /* glsl */`
attribute vec2 aLocal; attribute float aKind;
varying vec2 vUvM; varying vec2 vLocal; varying float vKind; varying float vViewZ; varying vec2 vWxz;
void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vUvM = uv; vLocal = aLocal; vKind = aKind; vWxz = wp.xz;
  vec4 mv = viewMatrix * vec4(wp, 1.0); vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const FALLS_FRAG = /* glsl */`
uniform sampler2D uTex; uniform float uTime;
uniform sampler2D uHeight; uniform float uInvSize; uniform float uHeightOffset;
uniform vec3 uSunDir; uniform vec3 uSunRad; uniform vec3 uAmbient; uniform vec3 uMoonRad;
uniform vec3 uFogColor; uniform vec3 uFogParams;
varying vec2 vUvM; varying vec2 vLocal; varying float vKind; varying float vViewZ; varying vec2 vWxz;
void main() {
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  float t = uTime;
  float day = clamp(uSunDir.y * 2.5, 0.0, 1.0);
  vec3 fc = vec3(0.86, 0.92, 0.96) * (uSunRad * 0.32 * day + uAmbient * 1.2 + uMoonRad * 0.3);
  fc /= (1.0 + dot(fc, LUMA) * 0.5);            // soft hue-preserving cap: bright silver, never a white clip
  float a;
  if (vKind < 0.5) {
    // curtain: vertical ropes of falling water, thin at the lip, dissolving into spray at the foot
    float s1 = texture2D(uTex, vec2(vUvM.x * 0.50, vUvM.y * 0.055 - t * 0.42)).b;   // ~7.6 m/s fall
    float s2 = texture2D(uTex, vec2(vUvM.x * 0.23 + 0.41, vUvM.y * 0.030 - t * 0.30)).b;
    float ropes = smoothstep(0.30, 0.78, s1 * 0.62 + s2 * 0.55);
    a = 0.30 + 0.62 * ropes;
    a *= smoothstep(0.0, 0.14, vLocal.y);                                           // sheet gathers below the lip
    a *= smoothstep(0.0, 0.10, vLocal.x) * smoothstep(1.0, 0.90, vLocal.x);         // side feather
    a *= 1.0 - 0.35 * smoothstep(0.72, 1.0, vLocal.y);                              // foot dissolves into the pool
  } else if (vKind < 1.5) {
    // plunge ring: churned foam collar spreading outward from the fall base (integer tile counts round
    // the circle so the angular seam is invisible)
    vec2 c = vLocal * 2.0 - 1.0; float r = length(c); float ang = atan(c.y, c.x);
    float s1 = texture2D(uTex, vec2(ang * 0.4775, r * 1.1 - t * 0.16)).b;
    float s2 = texture2D(uTex, vec2(ang * 0.3183 + 0.5, r * 0.7 - t * 0.10)).b;
    float f = smoothstep(0.34, 0.72, s1 * 0.6 + s2 * 0.55);
    a = (0.25 + 0.75 * f) * (1.0 - smoothstep(0.35, 1.0, r));
    // the ring is a flat disc on the pool, so where the pool ends it must end too: the wave-3 vista had
    // white foam discs sitting on dry sand wherever a fall's foot was near a shoreline
    float bed = texture2D(uHeight, vWxz * uInvSize + 0.5 + uHeightOffset).r;
    a *= smoothstep(-0.02, 0.14, -bed);
  } else {
    // spray mist: soft breathing veil, hazier and cooler than the foam — matte, capped, never washes white
    vec2 c = vLocal * 2.0 - 1.0;
    float nm = texture2D(uTex, vec2(vLocal.x * 0.8 + t * 0.010, vLocal.y * 0.8 - t * 0.016)).a;
    a = max(1.0 - dot(c, c), 0.0) * (0.16 + 0.14 * nm);
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

  // Sunken cascade gorge (docs/SUNKEN-REDESIGN-BRIEF.md): scan the terrain for every place the water laps
  // against a wall face (riser notches, gorge flanks, the ramp cut) and drape a waterfall there — curtain
  // following the wall profile + plunge foam ring + spray mist cards. Fully generic (reads only the height
  // field), deterministic, merged into ONE mesh / ONE draw call (~1.3k tris for ~12 falls).
  _buildFalls() {
    const g = this.game, T = g.terrain, WLv = this.level;
    if (!T?.biomeAt || !this.hasWater) return;
    const rnd = mulberry32(g.seed + 52121);
    const S = T.size, half = S / 2;
    // 1) coarse bbox of the sunken region (biome test only)
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let z = -half + 12; z < half; z += 24) for (let x = -half + 12; x < half; x += 24)
      if (T.biomeAt(x, z) === 'sunken') { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    if (x1 < x0) return;
    // 2) fall sites: wet cells with a >=2.4 m wall within 8 m (the face the water pours off).
    //    Order matters for boot cost — biomeAt is ~20x cheaper than the 8 heightAt probes, and the bbox
    //    covers a lot of neighbouring region, so it goes first. 8 m step: the narrowest fall is 9 m wide.
    const t0 = performance.now();
    const DIRS = []; for (let i = 0; i < 8; i++) DIRS.push([Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
    const cand = [];
    for (let z = z0; z <= z1; z += 8) for (let x = x0; x <= x1; x += 8) {
      if (T.biomeAt(x, z) !== 'sunken') continue;
      if (this._bed(x, z) >= WLv - 0.15) continue;
      let best = null;
      for (const D of DIRS) {
        const hw = this._bed(x + D[0] * 8, z + D[1] * 8) - WLv;
        if (hw >= 2.4 && (!best || hw > best[2])) best = [D[0], D[1], hw];
      }
      if (best) cand.push([x, z, best[0], best[1], best[2]]);
    }
    if (!cand.length) return;
    cand.sort((a, b) => b[4] - a[4]);                       // tallest walls first (the pass-side staircase)
    const picks = [];
    for (const c of cand) {
      if (picks.length >= 16) break;
      if (picks.every((p) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 > 26 * 26)) picks.push(c);
    }
    // 3) resolve each pick: shoreline foot, wall height, drape profile.
    //    march is capped at 6 m: the curtain may hug the wall, never lean out into a flat sheet.
    const march = (sx, sz, dx, dz, target) => { for (let d = 0.25; d <= 6; d += 0.25) if (this._bed(sx + dx * d, sz + dz * d) >= target) return d; return 6; };
    const falls = [];
    for (const [cx, cz, dx, dz] of picks) {
      const sd = march(cx, cz, dx, dz, WLv);
      const sx = cx + dx * sd, sz = cz + dz * sd;           // where the water meets the wall
      // height from the SAME 6 m window the drape can march across. Reading it out to 12 m let a gentle bank
      // claim a 10 m curtain whose top row hung metres out in the air above the slope.
      let hw = 0; for (let d = 1; d <= 6; d += 0.5) hw = Math.max(hw, this._bed(sx + dx * d, sz + dz * d) - WLv);
      hw = Math.min(Math.max(hw, 2.2), 15);
      falls.push({ sx, sz, dx, dz, tx: -dz, tz: dx, hw, w: Math.min(4.5 + hw, 14) });
    }
    // 4) merged geometry: curtains, then rings, then mist (index order = blend order; all depthWrite:false)
    const pos = [], uv = [], loc = [], kind = [], idx = [];
    const quad = (a, b, c, d) => idx.push(a, c, b, b, c, d);
    const ROWS = 4, COLS = 4;
    for (const f of falls) {                                // ---- curtains: drape the wall face
      const jig = []; for (let j = 0; j <= COLS; j++) jig.push((rnd() - 0.5) * 0.9);
      const hTot = f.hw + 0.45, base = pos.length / 3;
      for (let i = 0; i <= ROWS; i++) {
        const fy = i / ROWS, y = WLv + f.hw - hTot * fy;
        // never lean out more than 0.85x the drop: a face that recedes further than that gets a free-falling
        // plume instead of a sheet laid flat on the slope (the wave-3 "white paper triangles on the sand")
        const dWall = y > WLv ? Math.min(march(f.sx, f.sz, f.dx, f.dz, y), f.hw * 0.85) : 0;
        const proud = 0.35 + 1.3 * fy * fy;                 // plume leans out toward the foot
        for (let j = 0; j <= COLS; j++) {
          const fx = j / COLS, off = (fx - 0.5) * f.w;
          const dd = dWall - proud + jig[j] * (1 - fy);     // ragged lip, converging foot
          pos.push(f.sx + f.dx * dd + f.tx * off, y, f.sz + f.dz * dd + f.tz * off);
          uv.push(fx * f.w, fy * hTot); loc.push(fx, fy); kind.push(0);
        }
      }
      for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) {
        const a = base + i * (COLS + 1) + j;
        quad(a, a + 1, a + COLS + 1, a + COLS + 2);
      }
    }
    for (const f of falls) {                                // ---- plunge foam rings (flat on the pool)
      const rr = f.w * 0.55 + 2.2, ox = f.sx - f.dx * rr * 0.55, oz = f.sz - f.dz * rr * 0.55, base = pos.length / 3;
      for (let j = 0; j < 4; j++) {
        const ax = (j & 1) * 2 - 1, az = ((j >> 1) & 1) * 2 - 1;
        pos.push(ox + (f.tx * ax + f.dx * az * 0.8) * rr, WLv + 0.07, oz + (f.tz * ax + f.dz * az * 0.8) * rr);
        uv.push((ax * 0.5 + 0.5) * rr * 2, (az * 0.5 + 0.5) * rr * 2); loc.push(ax * 0.5 + 0.5, az * 0.5 + 0.5); kind.push(1);
      }
      quad(base, base + 1, base + 2, base + 3);
    }
    for (const f of falls) {                                // ---- spray mist: two crossed soft cards
      const mw = f.w * 0.55, mh = f.hw * 0.28 + 1.4;
      const my = WLv + mh * 0.55, ox = f.sx - f.dx * 1.3, oz = f.sz - f.dz * 1.3;
      for (let q = 0; q < 2; q++) {
        const ca = Math.cos(q * 1.1 - 0.55), sa = Math.sin(q * 1.1 - 0.55);
        const ux = f.tx * ca - f.tz * sa, uz = f.tz * ca + f.tx * sa, base = pos.length / 3;
        for (let j = 0; j < 4; j++) {
          const ax = (j & 1) * 2 - 1, ay = ((j >> 1) & 1) * 2 - 1;
          pos.push(ox + ux * ax * mw, my + ay * mh * 0.5, oz + uz * ax * mw);
          uv.push(ax * 0.5 + 0.5, ay * 0.5 + 0.5); loc.push(ax * 0.5 + 0.5, ay * 0.5 + 0.5); kind.push(2);
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
    console.log(`[water] cascades: ${falls.length} falls, ${idx.length / 3} tris, scan ${(performance.now() - t0) | 0} ms`);
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
    const seeds = [];
    for (let tries = 0; tries < 400 && seeds.length < 26; tries++) {
      const i = (rnd() * (cand.length / 2)) | 0, x = cand[i * 2], z = cand[i * 2 + 1];
      if (seeds.every((s) => (s[0] - x) ** 2 + (s[1] - z) ** 2 > 18 * 18)) seeds.push([x, z]);
    }
    const mats = [];
    const q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    let cx = 0, cz = 0;
    for (const [sx, sz] of seeds) {
      const nCards = 4 + (rnd() * 5) | 0;
      for (let k = 0; k < nCards; k++) {
        const x = sx + (rnd() - 0.5) * 11, z = sz + (rnd() - 0.5) * 11;
        const d = this.level - this._bed(x, z);
        if (d < 0.04 || d > 1.0) continue;   // stay in the damped shallows: waves are ~flat there, cards can float statically
        e.set(-Math.PI / 2, rnd() * Math.PI * 2, 0, 'YXZ'); q.setFromEuler(e);
        v.set(x, this.level + 0.045 + rnd() * 0.03, z);   // ponytail: static float height; upgrade = bob with water.heightAt in a vertex shader
        sc.set(1.2 + rnd() * 1.8, 1.2 + rnd() * 1.8, 1);
        mats.push(new THREE.Matrix4().compose(v, q, sc));
        cx += x; cz += z;
      }
    }
    if (!mats.length) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 1.0, metalness: 0, side: THREE.DoubleSide, color: new THREE.Color(0.42, 0.47, 0.24) });
    const mesh = new THREE.InstancedMesh(geo, mat, mats.length);
    const col = new THREE.Color();
    for (let i = 0; i < mats.length; i++) {
      mesh.setMatrixAt(i, mats[i]);
      mesh.setColorAt(i, col.setHSL(0.22 + rnd() * 0.06, 0.40 + rnd() * 0.15, 0.30 + rnd() * 0.18));   // olive-green variation, always matte
    }
    cx /= mats.length; cz /= mats.length;
    let r2 = 0;
    for (const m of mats) { const dx = m.elements[12] - cx, dz = m.elements[14] - cz; r2 = Math.max(r2, dx * dx + dz * dz); }
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, this.level, cz), Math.sqrt(r2) + 4);
    mesh.name = 'water-scum'; mesh.castShadow = false; mesh.receiveShadow = true; mesh.frustumCulled = true;
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
    const b = this.game.terrain?.biomeBlend?.(camera.position.x, camera.position.z, this._wb ??= {});
    u.uLava.value = b && b.id === 'infernal' ? b.w : 0;
    u.uRapid.value = b && b.id === 'sunken' ? b.w : 0;
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
    hidden.length = 0; for (const o of this._noReflect) if (o.visible) { o.visible = false; hidden.push(o); }
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
