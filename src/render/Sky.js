import * as THREE from 'three';
import { BIOMES } from '../world/Biomes.js';
import { mulberry32 } from '../core/Noise.js';

/**
 * Sky + atmosphere + time of day. Owns: sky dome (physically-inspired scattering, FF14-dramatic), sun disc, moon, stars, clouds, aether/aurora at night,
 * horizon haze, fog color/density by time of day, and the day/night cycle clock.
 * Exposes (stable; Lighting/Water/Grass/PostFX read these every frame):
 *   sky.hour (0-24), sky.setHour(h), sky.dayLength (seconds per full day; 0 = frozen)
 *   sky.sunDir (Vector3, unit, FROM scene TO sun), sky.moonDir, sky.sunColor (Color, linear, light color incl. sunset tint), sky.sunIntensity (0..1 daylight factor)
 *   sky.skyColor (zenith), sky.horizonColor, sky.fogColor, sky.ambientColor (sky-ish ambient), sky.groundColor (bounce), sky.fogDensity
 *   sky.sunMesh (Object3D of the sun disc, for god rays), sky.night (0..1)
 *   game.scene.fog must be kept in sync (FogExp2 with fogColor/fogDensity) — Sky owns scene.fog and scene.background/environment (if it builds an env map).
 * Extras (also stable):
 *   sky.moonColor (Color, linear moonlight color*strength), sky.moonIntensity (0..1), sky.sunElevation (radians)
 *   sky.cloudCover (null = automatic per time of day, or 0..1 override), sky.dome (the dome Mesh; on layers 0 and 1 -> a CubeCamera on layer 1 sees only sky+sun for env probes)
 *   sky.sunDiscColor (Color, linear HDR radiance of the visible sun disc, already extinction-tinted)
 *   sky.cloudScale (0.35..1 render scale of the cloud pass; set + call resize() to change), sky.windSpeed (m/s cloud drift)
 *   sky.cloudOcclusionCull (bool, default true) skip marching cloud texels that last frame's depth says are fully
 *     behind opaque geometry; set false to A/B it or if it is ever suspected of eating visible sky
 *
 * How it works:
 *  - a tiny sky-view LUT (256x128, half float) is ray-marched on the GPU (Rayleigh + Mie + ozone, planet shadow, fake multi-scatter, art-directed
 *    twilight glow / belt of venus / civil-twilight dome / indigo night floor) whenever the sun moves; the dome shader just looks it up.
 *  - CLOUDS are a real volumetric raymarch (Horizon/Nubis-style, technique per TECHNIQUES.md #8 leoawen/volumetric-clouds, MIT) rendered into a
 *    HALF-RES RGBA16F target once per frame and composited into the dome with a 4-tap tent upsample (kills march dither, keeps the budget).
 *    Density = tileable 96³ perlin-worley shape texture (GPU-baked once) remapped by a 2D weather map (coverage + cloud-type/top-height) through a
 *    cumulus height gradient (hard flat base, rounded cauliflower top), eroded by a 32³ worley detail texture (wispy at the base, billowy on top),
 *    sheared downwind with altitude. Lighting = 4-tap light march -> optical depth -> 2-octave multi-scatter beer + powder + dual-lobe HG phase, so
 *    tops are white-gold, bellies dark, and rims toward the sun get a real silver lining. Curved shell geometry + aerial perspective melt the layer
 *    into the haze at the horizon instead of stacking into a wall.
 *  - the dome adds, per pixel: sun disc+glare, moon (phase-lit, maria+craters), stars (clustered hash cells, pixel-crisp, halos on the brightest) +
 *    milky way, aether aurora ribbons, then the cloud composite, then horizon haze.
 *  - the same atmosphere model is ported to JS (few rays) to produce the CPU-side colors (sky/horizon/fog/ambient/ground/sun) so Lighting/Water/Grass/fog
 *    match what the dome shows.
 */

const PI = Math.PI, DEG = PI / 180;
// --- atmosphere model (shared by the GLSL LUT and the JS port below; keep in sync) ---
const Rg = 6360e3, Rt = 6460e3, HR = 8000, HM = 1200;
const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6], BETA_MS = 2.6e-6, BETA_MA = 2.4e-6, BETA_O = [0.65e-6, 1.881e-6, 0.085e-6];
const SUN_E = 22.0;         // sun radiance scale (linear HDR, tuned for ACES @ exposure 1)
const MS = 0.22;            // fake multiple-scatter strength
const OBS_H = 150;          // observer altitude used by the model (player height changes nothing visible)
const CLOUD_TILE = 5500;    // meters per repeat of the 3D shape texture
const WIND = [0.93, 0.37];  // cloud drift direction (normalized-ish)

const ATMO_GLSL = /* glsl */`
const float Rg = 6360e3, Rt = 6460e3, HR = 8000.0, HM = 1200.0, PI = 3.14159265;
const vec3 betaR = vec3(5.802e-6, 13.558e-6, 33.1e-6), betaO = vec3(0.65e-6, 1.881e-6, 0.085e-6);
const float betaMs = 2.6e-6, betaMa = 2.4e-6;
float rsFar(vec3 o, vec3 d, float R) { float b = dot(o, d); float c = dot(o, o) - R * R; return -b + sqrt(max(b * b - c, 0.0)); }
float rsNear(vec3 o, vec3 d, float R) { float b = dot(o, d); float c = dot(o, o) - R * R; float q = b * b - c; if (q < 0.0) return -1.0; return -b - sqrt(q); }
void dens(float h, out float dR, out float dM, out float dO) { h = max(h, 0.0); dR = exp(-h / HR); dM = exp(-h / HM); dO = max(0.0, 1.0 - abs(h - 25e3) / 15e3); }
// transmittance from p to space along s (0 when the ray dives into the planet, softened)
vec3 transm(vec3 p, vec3 s) {
  float b = dot(p, s); float soft = 1.0;
  if (b < 0.0) { float hmin = sqrt(max(dot(p, p) - b * b, 0.0)) - Rg; soft = smoothstep(-2500.0, 1500.0, hmin); if (soft <= 0.0) return vec3(0.0); }
  float tMax = rsFar(p, s, Rt); float dt = tMax / 8.0; vec3 od = vec3(0.0);
  for (int i = 0; i < 8; i++) { vec3 q = p + s * ((float(i) + 0.5) * dt); float dR, dM, dO; dens(length(q) - Rg, dR, dM, dO); od += (betaR * dR + (betaMs + betaMa) * dM + betaO * dO) * dt; }
  return exp(-od) * soft;
}
float hg(float mu, float g) { return (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5)); }
`;

// ---------------- sky-view LUT (u: azimuth rel. to sun 0..PI, v: elevation, sqrt-warped around the horizon) ----------------
const LUT_FRAG = ATMO_GLSL + /* glsl */`
uniform vec3 uSunDir; uniform float uSunE, uMs, uObsH, uSunEl;
varying vec2 vUv;
void main() {
  float az = vUv.x * PI;
  float w = vUv.y * 2.0 - 1.0; float el = sign(w) * w * w * 0.5 * PI;
  vec3 d = vec3(sin(az) * cos(el), sin(el), cos(az) * cos(el));
  vec3 s = vec3(0.0, sin(uSunEl), cos(uSunEl));
  vec3 o = vec3(0.0, Rg + uObsH, 0.0);
  float tG = rsNear(o, d, Rg); float tMax = tG > 0.0 ? tG : rsFar(o, d, Rt); tMax = min(tMax, 420e3);
  float mu = dot(d, s);
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.72; float pM = 3.0 / (8.0 * PI) * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 L = vec3(0.0), T = vec3(1.0);
  const int N = 32;
  for (int i = 0; i < N; i++) {
    float f0 = float(i) / float(N), f1 = float(i + 1) / float(N);
    float t0 = tMax * f0 * f0, t1 = tMax * f1 * f1, dt = t1 - t0;
    vec3 p = o + d * (0.5 * (t0 + t1));
    float dR, dM, dO; dens(length(p) - Rg, dR, dM, dO);
    vec3 ext = betaR * dR + (betaMs + betaMa) * dM + betaO * dO;
    vec3 Tl = transm(p, s);
    vec3 S = (betaR * dR * pR + betaMs * dM * pM) * Tl * uSunE + (betaR * dR + betaMs * dM * 0.35) * pow(Tl, vec3(0.6)) * uSunE * uMs / (4.0 * PI);
    vec3 sT = exp(-ext * dt);
    L += T * (S - S * sT) / max(ext, vec3(1e-9));
    T *= sT;
  }
  float upe = max(el, 0.0);
  // art-directed twilight afterglow (FF14 dusk: the sun's horizon stays orange→pink→violet long after sunset)
  float tw = smoothstep(-0.26, -0.05, uSunEl) * (1.0 - smoothstep(-0.01, 0.12, uSunEl));
  float ah = pow(max(cos(az), 0.0) * 0.5 + 0.5, 4.0);
  float ev = exp(-upe * 7.0);
  vec3 twc = mix(vec3(1.0, 0.32, 0.05), vec3(0.70, 0.22, 0.45), clamp(el * 4.0, 0.0, 1.0));
  L += twc * tw * ah * ev * 1.6 * uSunE / 22.0;
  // wide pink-violet wash above the glow
  L += vec3(0.45, 0.18, 0.40) * tw * (0.35 + 0.65 * ah) * exp(-upe * 2.2) * 0.22 * uSunE / 22.0;
  // golden-hour warmth around a low sun (art)
  float gold = smoothstep(0.30, 0.03, uSunEl) * smoothstep(-0.06, 0.0, uSunEl);
  L *= mix(vec3(1.0), vec3(1.12, 0.86, 0.55), gold * ah * exp(-upe * 5.0) * 0.85);
  // civil twilight: the dome stays a luminous violet-blue after sunset instead of collapsing to black
  float civ = smoothstep(-0.30, -0.02, uSunEl) * (1.0 - smoothstep(0.02, 0.10, uSunEl));
  float cm = pow(max(cos(az), 0.0) * 0.5 + 0.5, 2.0) * exp(-upe * 2.0);
  vec3 civc = mix(vec3(0.085, 0.115, 0.30), vec3(0.32, 0.17, 0.40), cm);
  L += civc * civ * (0.32 + 0.68 * exp(-upe * 1.1)) * 0.62 * uSunE / 22.0;
  // belt of venus: pink anti-solar band + cool earth-shadow wedge under it
  float bv = smoothstep(0.035, -0.03, uSunEl) * (1.0 - smoothstep(-0.10, -0.26, uSunEl));
  float aaz = pow(max(-cos(az), 0.0), 1.6);
  L += vec3(0.80, 0.34, 0.38) * bv * aaz * exp(-abs(el - 0.055) * 11.0) * 0.55 * uSunE / 22.0;
  L *= mix(vec3(1.0), vec3(0.55, 0.65, 0.95), bv * aaz * exp(-upe * 22.0) * 0.6);
  // deep-night floor: FF14 magical indigo, never void-black
  float nightF = 1.0 - smoothstep(-0.30, -0.10, uSunEl);
  L += vec3(0.0135, 0.0175, 0.041) * (0.75 + 0.55 * exp(-upe * 1.7)) * nightF;
  gl_FragColor = vec4(L, 1.0);
}`;

// ---------------- one-time tileable 2D noise bake (512² RGBA8, mips): R perlin fbm, G perlin-worley, B detail fbm, A cirrus/weather fbm ----------------
const NOISE_FRAG = /* glsl */`
uniform float uSeed; varying vec2 vUv;
vec2 h2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))) + uSeed; return -1.0 + 2.0 * fract(sin(p) * 43758.5453123); }
float gnoise(vec2 p, float P) {
  vec2 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(h2(mod(i, P)), f), b = dot(h2(mod(i + vec2(1, 0), P)), f - vec2(1, 0));
  float c = dot(h2(mod(i + vec2(0, 1), P)), f - vec2(0, 1)), d = dot(h2(mod(i + vec2(1, 1), P)), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4;
}
float fbm(vec2 p, float P, int oct, float gain) { float s = 0.0, a = 0.5, n = 0.0; for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * gnoise(p, P); n += a; p *= 2.0; P *= 2.0; a *= gain; } return s / n; }
float worley(vec2 p, float P) {
  vec2 i = floor(p), f = fract(p); float m = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(x, y); vec2 o = 0.5 + 0.5 * h2(mod(i + g, P)); m = min(m, length(g + o - f)); }
  return m;
}
float wfbm(vec2 p, float P) { return 1.0 - (worley(p, P) * 0.625 + worley(p * 2.0, P * 2.0) * 0.25 + worley(p * 4.0, P * 4.0) * 0.125); }
void main() {
  vec2 uv = vUv;
  float base = 0.5 + 0.5 * fbm(uv * 3.0, 3.0, 5, 0.5);
  float w = wfbm(uv * 7.0, 7.0);
  float pw = clamp((base - (1.0 - w) * 0.75) / 0.75, 0.0, 1.0);      // perlin-worley: puffy cauliflower masses
  float shape = clamp((base * 0.55 + pw * 0.45 - 0.18) / 0.64, 0.0, 1.0);
  float w2 = wfbm(uv * 18.0 + 2.3, 18.0);
  float b2 = 0.5 + 0.5 * fbm(uv * 14.0 + 5.1, 14.0, 4, 0.55);
  float puff = clamp((b2 - (1.0 - w2) * 0.7) / 0.7, 0.0, 1.0);
  float det = 0.5 + 0.5 * fbm(uv * 28.0 + 3.7, 28.0, 4, 0.6);
  float cir = 0.5 + 0.5 * fbm(uv * 3.0 + 11.3, 3.0, 6, 0.62);
  gl_FragColor = vec4(shape, puff, det, cir);
}`;

// ---------------- one-time tileable 3D cloud noise bake (rendered layer by layer into a WebGL3DRenderTarget) ----------------
// SHAPE (96³ RGBA8): R = perlin-worley, G/B/A = worley fbm at 3 octaves  -> classic Horizon/Nubis shape packing
// DETAIL (32³ RGBA8): worley fbm at 3 rising frequencies (cauliflower crumb)
const NOISE3D_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out highp vec4 oColor;   // GLSL3: three r185 adds no oColor alias for glslVersion GLSL3 materials
uniform float uSlice, uSeed, uMode; varying vec2 vUv;
vec3 h33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973) + uSeed); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
// periodic 3D gradient noise
float gn3(vec3 p, float P) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n = 0.0;
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float(k >> 2));
    vec3 g = normalize(h33(mod(i + o, P)) * 2.0 - 1.0);
    float w = mix(1.0 - u.x, u.x, o.x) * mix(1.0 - u.y, u.y, o.y) * mix(1.0 - u.z, u.z, o.z);
    n += w * dot(g, f - o);
  }
  return n * 1.6;
}
float pfbm(vec3 p, float P) { float s = 0.0, a = 0.5, n = 0.0; for (int i = 0; i < 4; i++) { s += a * gn3(p, P); n += a; p *= 2.0; P *= 2.0; a *= 0.5; } return 0.5 + 0.5 * s / n; }
float wor(vec3 p, float P) {
  vec3 i = floor(p), f = fract(p); float m = 4.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z)); vec3 o = h33(mod(i + g, P));
    m = min(m, dot(g + o - f, g + o - f));
  }
  return sqrt(m);
}
float iwf(vec3 p, float P) { return 1.0 - (wor(p, P) * 0.625 + wor(p * 2.0, P * 2.0) * 0.25 + wor(p * 4.0, P * 4.0) * 0.125); }
void main() {
  vec3 uv = vec3(vUv, uSlice);
  if (uMode < 0.5) {
    float per = pfbm(uv * 4.0, 4.0);
    float w0 = iwf(uv * 4.0, 4.0);
    float pw = clamp(w0 + per * (1.0 - w0), 0.0, 1.0);                // perlin-worley (Nubis): billowy worley base, perlin fills the gaps
    oColor = vec4(pw, iwf(uv * 4.0 + 0.33, 4.0), iwf(uv * 8.0 + 0.71, 8.0), iwf(uv * 14.0 + 0.17, 14.0));
  } else {
    oColor = vec4(iwf(uv * 3.0, 3.0), iwf(uv * 6.0 + 0.41, 6.0), iwf(uv * 11.0 + 0.83, 11.0), 1.0);
  }
}`;

const QUAD_VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ---------------- volumetric cloud pass (half res, own target) ----------------
// Technique after leoawen/volumetric-clouds (MIT) + Schneider/Nubis "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn" (public course notes).
const CLOUD_COMMON = /* glsl */`
const float PI = 3.14159265;
const float CURV_R = 2.6e5;          // fake planet radius: the layer bends down and meets the horizon at ~26 km
float hg(float mu, float g) { return (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5)); }
float shell(float camY, vec3 d, float H) { float oc = camY + CURV_R; float b = oc * d.y; float c = oc * oc - (CURV_R + H) * (CURV_R + H); return -b + sqrt(max(b * b - c, 0.0)); }
float altAt(float camY, vec3 d, float t) { float oc = camY + CURV_R; vec3 q = vec3(d.x * t, oc + d.y * t, d.z * t); return length(q) - CURV_R; }
float rmp(float v, float a, float b) { return clamp((v - a) / max(b - a, 1e-5), 0.0, 1.0); }
`;

const CLOUD_FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
layout(location = 0) out highp vec4 oColor;   // GLSL3: no oColor alias (see NOISE3D_FRAG note)
uniform sampler2D uLut, uNoise;
uniform sampler3D uShape, uDetail;
uniform vec3 uSunDir, uCloudLightDir, uCloudLightCol, uCloudAmbTop, uCloudAmbBot, uBeltCol;
uniform float uCamY, uCloudCover, uCirrusCover, uBelt, uCloudH0, uCloudH1, uWindT, uTileM, uSunEl;
uniform vec2 uTan, uWindV, uShearV;
uniform vec3 uCamPos, uThr;   // x = clear-sky iso threshold, y = full-coverage threshold, z = soft width
uniform mat3 uCamRot, uPrevRotInv;
uniform vec2 uSubJitter;      // this frame's 2x2 phase, in cloud-buffer UV: which full-res pixel this lo-res texel is
uniform sampler2D uOcc;       // 1/8-res min(1 - depth) pyramid of LAST frame (0 = that tile still saw sky)
uniform vec2 uOccTexel, uPrevTanS;   // uPrevTanS = last frame's REAL frustum tan (uTan is 8% wider than the frustum)
uniform float uCullOn;
varying vec2 vUv;
` + CLOUD_COMMON + /* glsl */`

vec3 lutSky(vec3 d) {
  vec2 sh = normalize(uSunDir.xz + vec2(1e-4, 0.0)), dh = normalize(d.xz + vec2(1e-4, 0.0));
  float az = acos(clamp(dot(sh, dh), -1.0, 1.0)) / PI;
  float el = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI));
  return texture2D(uLut, vec2(az, v)).rgb;
}

// weather map: x = local coverage, y = cloud type (0 = flat pancake, 1 = towering castle)
vec2 weather(vec2 xz) {
  vec2 uv = (xz + uWindV * 0.55) / 38000.0;
  float m = texture2D(uNoise, uv + 0.21).a;
  float m2 = texture2D(uNoise, uv * 2.6 + 0.57).r;
  float cov = clamp(uCloudCover * (0.30 + 1.45 * m * m) * (0.66 + 0.62 * m2), 0.0, 1.0);
  return vec2(cov, clamp(m * 0.85 + m2 * 0.45, 0.0, 1.0));
}

// density at a world point. hi = also fetch the erosion detail (skipped for light-march taps)
float cloudDens(vec3 p, vec2 wth, bool hi) {
  float hf = clamp((p.y - uCloudH0) / (uCloudH1 - uCloudH0), 0.0, 1.0);
  vec3 wp = p;
  wp.xz += uWindV + uShearV * hf;              // drift + downwind lean of the tops
  wp.y += uWindT * 3.5;                        // slow vertical evolution (clouds boil, not just slide)
  vec4 s = texture(uShape, wp / uTileM);
  float w = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  float base = mix(s.r, s.r * w, 0.55);                     // worley octaves carve lumps into the perlin-worley mass
  // cumulus vertical profile: hard flat base, rounded top whose ceiling varies per region
  float topH = mix(0.26, 1.0, wth.y);
  float grad = smoothstep(0.0, 0.05, hf) * smoothstep(topH, topH * 0.40, hf);
  float thr = mix(uThr.x, uThr.y, wth.x);                   // coverage -> iso-threshold: crisp silhouettes, big blue gaps
  float d = rmp(base * grad, thr, thr + uThr.z);
  if (d <= 0.0) return 0.0;
  if (hi) {
    vec3 dt = texture(uDetail, wp / (uTileM * 0.085)).rgb;
    float df = dt.r * 0.625 + dt.g * 0.25 + dt.b * 0.125;
    float m = mix(1.0 - df, df, clamp(hf * 3.0, 0.0, 1.0));   // wispy shredded base, billowy cauliflower top
    d = rmp(d, m * 0.42, 1.0);
  }
  return d;
}

float lightTau(vec3 p, vec2 wth, vec3 L) {
  float tau = 0.0, d = 0.0;
  for (int i = 0; i < LIGHT_STEPS; i++) {
    float sl = 55.0 * pow(2.0, float(i));
    d += sl;
    tau += cloudDens(p + L * d, wth, false) * sl;
  }
  tau += cloudDens(p + L * 2200.0, wth, false) * 900.0;       // one far tap so cloud banks shadow each other
  return tau;
}

// True when every pixel this ray could land on was covered by opaque geometry LAST frame. Uses the same
// rotation-delta reprojection the temporal resolve already trusts (clouds are kilometres away, so rotation
// is the only term that matters), then reads the 1/8-res pyramid with a 3x3 neighbourhood -- ~8 full-res
// pixels of slack in every direction, which covers a frame of camera turn on top of the cloud buffer
// already being 8% wider than the frustum.
bool occludedLastFrame(vec3 dir) {
  if (uCullOn < 0.5) return false;
  vec3 dv = uPrevRotInv * dir;
  if (dv.z > -1e-4) return false;                                    // behind last frame's eye: unknown, so march
  vec2 uvp = ((dv.xy / -dv.z) / uPrevTanS) * 0.5 + 0.5;
  if (any(lessThan(uvp, vec2(0.0))) || any(greaterThan(uvp, vec2(1.0)))) return false;   // off-screen last frame: march
  // 5x5, not 3x3. INVARIANT: the asserted margin (2 * uOccTexel = 20 screen px at 1080p) must stay far larger
  // than everything that can read ACROSS a texel boundary -- the resolve's bilinear history fetch (~0.9 px) and
  // the dome's 4-tap tent upsample (~0.5 px) -- because a culled texel holds deliberately stale content and
  // bloom smears any leak into a soft blob. It is also what keeps the periodic full-march (see uCullOn) from
  // showing up as frame-to-frame change on a static camera, i.e. gate rule 2. Re-derive it if cloudScale, the
  // pyramid depth, or the tent offset changes; do not go back to 3x3. Measured at 3x3: horizon cloud edges
  // differed by up to 46/255. At 5x5: zero differing pixels.
  // textureLod, and NO early exit inside the loop. The pyramid has no mips, so a gradient-taking texture() buys
  // nothing -- and returning out of a loop containing one is a gradient instruction under varying iteration
  // (fxc X3595), undefined by spec. It cost a GPU process crash on this machine, not just a warning.
  float m = 1.0, unknown = 0.0;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      vec2 t = uvp + vec2(float(i), float(j)) * uOccTexel;
      // Outside the frame is UNKNOWN, not covered: the RT clamps to edge, so a tap past the border would
      // re-read the edge texel and assert coverage nothing verified -- exactly where a turning ray is
      // likeliest to be leaving the known region.
      float outside = (any(lessThan(t, vec2(0.0))) || any(greaterThan(t, vec2(1.0)))) ? 1.0 : 0.0;
      unknown = max(unknown, outside);
      m = min(m, mix(textureLod(uOcc, clamp(t, vec2(0.0), vec2(1.0)), 0.0).r, 1.0, outside));
    }
  return unknown < 0.5 && m > 1e-5;
}

void main() {
  vec2 cUv = vUv + uSubJitter;
  vec3 d = normalize(uCamRot * vec3((cUv * 2.0 - 1.0) * uTan, -1.0));
  // Nothing this ray could reach is visible, so the march would be thrown away. Write the sentinel and let
  // the resolve keep this texel's history: writing 0 instead would erase clouds that come back into view.
  if (occludedLastFrame(d)) { oColor = vec4(0.0, 0.0, 0.0, -1.0); return; }
  vec3 acc = vec3(0.0); float T = 1.0;
  float lmu = dot(d, uCloudLightDir);
  // dual-lobe phase: broad back lobe + forward lobe (clamped — the raw HG spike near the sun would blow the body term out)
  float phase = clamp(mix(hg(lmu, -0.22), hg(lmu, 0.78), 0.55) * 4.0 * PI, 0.30, 2.8);
  float fwd = min(hg(lmu, 0.90) * 4.0 * PI, 16.0);            // silver lining: only thin sunward rims get this
  // pink under-lighting for bellies opposite a low sun (belt-of-venus bounce)
  vec2 sh = normalize(uSunDir.xz + vec2(1e-4, 0.0)), dh = normalize(d.xz + vec2(1e-4, 0.0));
  float anti = clamp(-dot(sh, dh), 0.0, 1.0);
  vec3 ambBot = mix(uCloudAmbBot, uBeltCol, uBelt * anti);
  vec3 L = uCloudLightDir; if (L.y < 0.07) L = normalize(vec3(L.x, 0.07, L.z));

  if (d.y > -0.035) {
    float t0 = shell(uCamY, d, uCloudH0), t1 = min(shell(uCamY, d, uCloudH1), 46000.0);
    if (t1 > t0 && t0 < 44000.0) {
      float span = t1 - t0;
      float dt = span / float(CLOUD_STEPS);
      // white-noise jitter (no screen-space structure -> the 4-tap tent upsample erases it; IGN/dither made a crosshatch weave)
      float jit = fract(sin(dot(cUv, vec2(12.9898, 78.233)) * 1.0) * 43758.5453);
      vec2 wth = weather(uCamPos.xz + d.xz * (t0 + span * 0.35));
      if (wth.x > 0.005) {
        float sigE = 0.0075;
        vec3 skyC = lutSky(d);
        // perf: a coarse/fine empty-space skip was tried here and MEASURED SLOWER (82 -> 73 fps at 36 steps).
        // A dynamic hi flag makes the density fetch divergent, so every lane pays for both the shape and
        // the erosion tap, and the ragged loop keeps the warp alive longer than the uniform march does.
        // The temporal quarter-rate march below is where the win is; keep this loop branch-free.
        for (int i = 0; i < CLOUD_STEPS; i++) {
          float t = t0 + (float(i) + jit) * dt;
          vec3 p = vec3(uCamPos.x + d.x * t, altAt(uCamY, d, t), uCamPos.z + d.z * t);
          float dens = cloudDens(p, wth, true);
          if (dens > 0.003) {
            float hf = clamp((p.y - uCloudH0) / (uCloudH1 - uCloudH0), 0.0, 1.0);
            float tau = lightTau(p, wth, L) * sigE;
            // 2-octave multiple scattering (Wrenninge): keeps deep cloud bodies luminous instead of grey mud
            vec3 sun = uCloudLightCol * (exp(-tau) * phase + 0.42 * exp(-tau * 0.32) * (phase * 0.35 + 0.55));
            sun += uCloudLightCol * fwd * 0.055 * exp(-tau * 2.0 - dens * 1.2);          // silver lining on thin sunward rims
            float powder = 1.0 - 0.45 * exp(-dens * 7.0);                                // dark crenellations facing the light
            vec3 amb = mix(ambBot, uCloudAmbTop, hf * hf * (0.55 + 0.45 * hf)) * (0.42 + 0.58 * (1.0 - dens));
            vec3 S = sun * powder + amb;
            float ext = dens * sigE;
            float tr = exp(-ext * dt);
            float aer = 1.0 - exp(-t * 8.0e-5);                                          // distant clouds dissolve into the haze
            acc += T * mix(S, skyC, aer) * (1.0 - tr);
            T *= tr;
            if (T < 0.02) break;
          }
        }
        // Let the far kilometres melt out completely. Pulled in from 16 km / 9e-5 because a full-coverage
        // deck at 20-40 km stacked into a solid white bank sitting on the horizon that read as a smooth
        // snow massif behind the ring -- the "mountains look like elongated slopes" screenshot. Overhead
        // cumulus (t0 of a few km) is untouched; only the horizon wall dissolves into haze.
        float fade = exp(-max(t0 - 9000.0, 0.0) * 1.5e-4) * smoothstep(-0.035, 0.02, d.y);
        acc *= fade; T = 1.0 - (1.0 - T) * fade;
      }
    }
  }

  // ---- cirrus veil (8 km), behind the cumulus: fibrous mares' tails sheared along a fixed wind axis ----
  if (d.y > 0.012 && T > 0.02) {
    float tc = shell(uCamY, d, 8000.0);
    vec2 uvc = ((d * tc).xz + uCamPos.xz + uWindV * 1.6) / 46000.0;
    vec2 uvf = mat2(0.885, 0.466, -0.466, 0.885) * uvc;
    float cov = texture2D(uNoise, uvc * 0.8 + 0.13).a;
    float fib = texture2D(uNoise, uvf * vec2(0.9, 6.5)).a;
    float fib2 = texture2D(uNoise, uvf * vec2(1.8, 14.0) + 0.41).b;
    float cir = cov * 0.5 + fib * 0.32 + fib2 * 0.18;
    float ca = smoothstep(0.62 - uCirrusCover * 0.14, 0.88, cir) * smoothstep(0.008, 0.12, d.y) * 0.36;
    vec3 cc = uCloudLightCol * (0.40 + 0.20 * phase + fwd * 0.10) + uCloudAmbTop * 0.55;
    cc = mix(cc, lutSky(d), 1.0 - exp(-tc * 1.1e-5));
    acc += T * cc * ca; T *= 1.0 - ca;
  }
  oColor = vec4(acc, 1.0 - T);
}`;

// ---------------- cloud occlusion pyramid ----------------
// One 2x2 min-reduction step. The value stored is min(1 - depth) over the block: the sky is cleared to
// depth 1.0 and the dome writes no depth (depthWrite:false), so a texel reads EXACTLY 0 if any pixel in
// its block still sees sky, and > 0 only when every pixel is covered by opaque geometry. That makes the
// "is this whole tile behind the world?" test conservative by construction rather than by tuning.
// NearestFilter on the chain is load-bearing: bilinear would interpolate a 0 away and cull visible sky.
const OCC_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out highp vec4 oColor;
uniform highp sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform float uFromDepth;
varying vec2 vUv;
// Four explicit taps, NOT textureGather: gather is GLSL ES 3.1 and WebGL2 is ES 3.00. With NearestFilter on
// the source these land exactly on the 2x2 block that feeds this texel, so the reduction stays exact.
void main() {
  vec4 g = vec4(
    texture(uSrc, vUv + vec2(-0.5, -0.5) * uSrcTexel).r,
    texture(uSrc, vUv + vec2( 0.5, -0.5) * uSrcTexel).r,
    texture(uSrc, vUv + vec2(-0.5,  0.5) * uSrcTexel).r,
    texture(uSrc, vUv + vec2( 0.5,  0.5) * uSrcTexel).r);
  if (uFromDepth > 0.5) g = vec4(1.0) - g;              // depth -> coveredness (sky is exactly 0)
  oColor = vec4(min(min(g.x, g.y), min(g.z, g.w)), 0.0, 0.0, 1.0);
}`;

// ---------------- temporal resolve: quarter-rate march -> full cloud buffer ----------------
// Each frame marches one of the four 2x2 sub-pixels (into a half-linear-size target) and rebuilds the
// full cloud buffer: fresh texels come straight from this frame's march, the other three quarters come
// from the previous buffer reprojected by the camera-rotation delta. Clouds are kilometres away, so a
// rotation-only reprojection is exact to well under a pixel — no velocity buffer, no clamp, no ghosting
// of moving objects (nothing but sky is in this buffer). A camera that does not rotate reprojects to
// identity, so a static shot is bit-stable: this cannot feed the screen-jitter failure mode.
// The cloud buffer covers 8% more than the frustum so a fast turn cannot run off its edge. The occlusion
// reprojection has to divide that back out, because the depth buffer it reads spans the REAL frustum.
const CLOUD_WIDEN = 1.08;

const CLOUD_RESOLVE_FRAG = /* glsl */`
precision highp float;
layout(location = 0) out highp vec4 oColor;
uniform sampler2D uLo, uHist;
uniform vec2 uSubIdx, uTan, uPrevTan;
uniform mat3 uCamRot, uPrevRotInv;
uniform float uHistValid;
varying vec2 vUv;

void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  vec2 ph = vec2(pix & ivec2(1));
  // A sentinel alpha (< 0) means the march was culled as occluded, NOT that the sky is clear there: fall
  // through to history so the texel keeps its last known cloud instead of being erased.
  if (ph.x == uSubIdx.x && ph.y == uSubIdx.y) { vec4 lo = texelFetch(uLo, pix >> 1, 0); if (lo.a > -0.5) { oColor = lo; return; } }
  if (uHistValid > 0.5) {
    vec3 dv = uPrevRotInv * (uCamRot * vec3((vUv * 2.0 - 1.0) * uTan, -1.0));   // world ray -> last frame's view basis
    if (dv.z < -1e-4) {
      vec2 uvp = ((dv.xy / -dv.z) / uPrevTan) * 0.5 + 0.5;
      if (all(greaterThan(uvp, vec2(0.0))) && all(lessThan(uvp, vec2(1.0)))) { oColor = texture(uHist, uvp); return; }
    }
  }
  // turned off the edge of history (or first frames): this frame's march, bilinear. Clamp because a bilinear
  // tap can straddle a culled texel's sentinel, and a negative alpha would reach the dome.
  vec4 lo = texture(uLo, vUv);
  oColor = vec4(max(lo.rgb, vec3(0.0)), max(lo.a, 0.0));
}`;

// ---------------- the dome ----------------
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }`;

const DOME_FRAG = /* glsl */`
uniform sampler2D uLut, uNoise, uClouds;
uniform vec3 uSunDir, uMoonDir, uSunDisc, uMoonCol, uFogColor, uMoonGlow, uGlow;
uniform float uTime, uHaze, uAurora, uStarVis, uPixAng, uVeil, uFogD;
uniform vec2 uTan, uCloudTexel;
uniform mat3 uStarMat, uCamRot;
varying vec3 vDir;
const float PI = 3.14159265;

vec3 lutSky(vec3 d) {
  vec2 sh = normalize(uSunDir.xz + vec2(1e-4, 0.0)), dh = normalize(d.xz + vec2(1e-4, 0.0));
  float az = acos(clamp(dot(sh, dh), -1.0, 1.0)) / PI;
  float el = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI));
  return texture2D(uLut, vec2(az, v)).rgb;
}
vec3 hash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }

// ---- stars: hash cells on the unit sphere; pixel-crisp cores, halos only on the brightest, density clustered by low-freq noise ----
vec3 stars(vec3 sd, float px, float clus) {
  const float N = 42.0;
  vec3 p = sd * N; vec3 b = floor(p - 0.5); vec3 acc = vec3(0.0);
  float thr = mix(0.93, 0.64, clus * clus);      // dense patches / sparse voids instead of a uniform spread
  for (int k = 0; k < 8; k++) {
    vec3 c = b + vec3(float(k & 1), float((k >> 1) & 1), float(k >> 2)) + 0.5;
    if (abs(length(c) - N) > 0.75) continue;      // only shell cells can own a visible star
    vec3 h = hash33(c);
    if (h.x < thr) continue;
    vec3 h2 = hash33(c + 19.19);
    vec3 sp = normalize(c + (h2 - 0.5) * 0.5);
    float ang = length(sd - sp);
    float m = pow(h.y, 6.0);                      // magnitude distribution: few bright
    float r = px * (0.65 + 1.1 * m);              // ~1-2 px core
    float g = exp(-ang * ang / (2.0 * r * r));
    float tw = 0.78 + 0.22 * sin(uTime * (1.5 + 4.0 * h.z) + h2.x * 6.2832);
    vec3 col = mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.82, 0.58), h2.y * h2.y);
    float halo = max(m - 0.75, 0.0) * 4.0 * exp(-ang / (px * 5.0)) * 0.20;
    acc += col * (g * (0.30 + 2.6 * m) * tw + halo);
  }
  return acc;
}

void main() {
  vec3 d = normalize(vDir);
  vec3 fogCol = uFogColor;
  if (d.y < -0.32) { gl_FragColor = vec4(fogCol * 0.72, 1.0); return; }
  vec3 sky = lutSky(d);
  vec3 col = sky;
  float mu = dot(d, uSunDir);
  float ang = acos(clamp(mu, -1.0, 1.0));
  float sunUp = smoothstep(-0.10, 0.0, uSunDir.y);

  // ---- sun glare (disc itself added last, HDR, after the shoulder) ----
  vec3 sunDisc = uSunDisc;
  float discR = 0.0225;
  float disc = 1.0 - smoothstep(discR * 0.90, discR, ang);
  float limb = 1.0 - 0.35 * pow(clamp(ang / discR, 0.0, 1.0), 2.0);
  col += sunDisc * (0.7 * exp(-ang * ang / (2.0 * 0.035 * 0.035)) + 0.12 * exp(-ang / 0.25)) * sunUp;

  // Smoke/reek ceiling (Biomes.skyVeil): point sources and curtains die FIRST under real smoke — long
  // before the sky colour goes. The gentler 1-v² left a legible starfield and a crisp moon over the
  // Wastes' 0.88 veil (wave-1 critic: "green aurora + starfield at night ... gives the region away").
  float pv = clamp(1.0 - uVeil * 1.15, 0.0, 1.0); pv *= pv;

  // ---- moon (phase-lit sphere: dark maria + crater mottling; radiance kept under bloom) + glow ----
  if (uMoonDir.y > -0.12) {
    float mum = dot(d, uMoonDir); float angm = acos(clamp(mum, -1.0, 1.0)); float R = 0.026;
    float mUp = smoothstep(-0.08, 0.05, uMoonDir.y) * pv;
    col += uMoonGlow * (0.50 * exp(-(angm - R) * 30.0) + 0.22 * exp(-angm / 0.30)) * mUp;
    if (angm < R) {
      vec3 t1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0))), t2 = cross(uMoonDir, t1);
      vec2 lc = vec2(dot(d, t1), dot(d, t2)) / R; float z = sqrt(max(1.0 - dot(lc, lc), 0.0));
      vec3 n = t1 * lc.x + t2 * lc.y - uMoonDir * z;
      float lit = max(dot(n, uSunDir), 0.0);
      float mar = texture2D(uNoise, lc * 0.16 + vec2(0.34, 0.72)).g;
      float cra = texture2D(uNoise, lc * 0.55 + vec2(0.11, 0.53)).b;
      float surf = mix(0.45, 1.0, smoothstep(0.30, 0.72, mar)) * (0.78 + 0.35 * cra);
      float e = 1.0 - smoothstep(R * 0.93, R, angm);
      col += uMoonCol * (lit * surf + 0.035) * e * mUp;
    }
  }

  // ---- night: stars, milky way, aether aurora (all scaled by the veil's pv, same as the moon) ----
  float hzFade = smoothstep(-0.02, 0.18, d.y);
  if (uStarVis * pv > 0.001) {
    vec3 sd = uStarMat * d;
    float clus = texture2D(uNoise, vec2(atan(sd.x, sd.z) * 0.45, sd.y * 0.8) + 0.31).r;
    vec3 st = stars(sd, uPixAng, clus);
    vec3 mwN = normalize(vec3(0.35, 0.72, 0.55));
    float band = exp(-pow(dot(sd, mwN) * 3.2, 2.0));
    float mwn = texture2D(uNoise, vec2(atan(sd.x, sd.z) * 0.5, sd.y * 0.9) * 1.3).a;
    float mwn2 = texture2D(uNoise, vec2(atan(sd.x, sd.z) * 1.7, sd.y * 2.3) + 0.2).r;
    vec3 mw = mix(vec3(0.20, 0.28, 0.66), vec3(0.42, 0.32, 0.86), mwn2) * band * (0.35 + 0.9 * mwn * mwn) * 0.20;
    col += (st + mw) * uStarVis * hzFade * pv;
  }
  if (uAurora * pv > 0.001 && d.y > 0.02) {
    float az = atan(d.x, -d.z);                                  // 0 = north
    float el = asin(clamp(d.y, 0.0, 1.0));
    vec3 aur = vec3(0.0);
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      float cEl = 0.30 + 0.14 * fk + 0.10 * sin(az * 2.2 + uTime * 0.045 + fk * 2.1) + 0.05 * sin(az * 5.1 - uTime * 0.07 + fk);
      float y = el - cEl;
      float prof = smoothstep(-0.02, 0.015, y) * exp(-max(y, 0.0) * (7.5 - fk * 1.5));
      float rays = texture2D(uNoise, vec2(az * 0.9 + uTime * 0.010 + fk * 0.37, 0.5 * fk + uTime * 0.004)).a;
      float rays2 = texture2D(uNoise, vec2(az * 3.6 - uTime * 0.016 + fk * 0.13, 0.17 + uTime * 0.003)).b;
      float amp = pow(rays, 3.5) * 3.0 * (0.25 + rays2 * rays2 * 1.4);
      vec3 ac = mix(vec3(0.18, 0.95, 0.65), vec3(0.50, 0.25, 1.0), clamp(y * 3.0, 0.0, 1.0));
      aur += ac * prof * amp;
    }
    float northW = smoothstep(-0.6, 0.3, -d.z) * 0.94 + 0.06;
    col += aur * uAurora * 0.30 * northW * smoothstep(0.12, 0.30, d.y) * pv;   // keep curtains well clear of the horizon
  }

  // ---- clouds: half-res volumetric pass, 4-tap tent upsample (removes the march jitter) ----
  vec3 cam = vec3(dot(d, uCamRot[0]), dot(d, uCamRot[1]), dot(d, uCamRot[2]));   // = transpose(rot)*d (no transpose() in ESSL1)
  vec4 cl = vec4(0.0);
  if (cam.z < -1e-4) {
    vec2 cuv = (cam.xy / -cam.z) / uTan * 0.5 + 0.5;
    if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {
      vec2 o = uCloudTexel * 0.3;   // tent pulled in from 0.5: the temporal resolve rebuilds a full-res buffer, so the wide 2x2 box was throwing away cloud-edge detail it no longer needs to hide
      cl = 0.25 * (texture2D(uClouds, cuv + vec2(o.x, o.y)) + texture2D(uClouds, cuv + vec2(-o.x, o.y))
                 + texture2D(uClouds, cuv + vec2(o.x, -o.y)) + texture2D(uClouds, cuv + vec2(-o.x, -o.y)));
    }
  }
  // Under a smoke/reek ceiling (uVeil) the cumulus read must FLIP: not friendly white puffs punching
  // through, but darker billows hanging under the lit haze — so dim the cloud light with the veil.
  // The post-composite veil mix below cannot do this: it pulls clouds TOWARD the haze colour, which
  // leaves anything brighter than the haze reading as white cumulus (the infernal noon giveaway).
  cl.rgb *= 1.0 - uVeil * 0.72;
  col = col * (1.0 - cl.a) + cl.rgb;

  // ---- horizon haze (tinted by the actual sky at that azimuth: amber toward a low sun, cool away) & ground ----
  float hz = exp(-max(d.y, 0.0) * 11.0) * uHaze;
  vec3 hcol = mix(fogCol, lutSky(normalize(vec3(d.x, abs(d.y) + 0.05, d.z))), 0.60) * 0.94;
  col = mix(col, hcol, hz * smoothstep(-0.1, 0.02, d.y));
  col = mix(col, fogCol * (1.0 - 0.28 * smoothstep(0.0, -0.32, d.y)), smoothstep(0.012, -0.03, d.y));
  // Aerial-perspective MATCH (the mint-cutout fix): FogExp2 paints a distant ridge with fogCol at
  // 1-exp(-(density*depth)^2), so the dome must converge to the SAME colour at the same rate just above the
  // horizon — otherwise a fully-fogged ridge reads as a flat paper cutout in the region's haze hue against a
  // clean blue sky (forest/sunken/dragon crit shots). Path length through the haze layer shrinks with
  // elevation, so nearer/higher geometry keeps its 2-3 value steps instead of everything clipping to one.
  // In the Vale fogCol ≈ the horizon ring colour, so this is near-invisible there.
  float pl = 1500.0 / (1.0 + max(d.y, 0.0) * 26.0);
  float fmz = 1.0 - exp(-pow(uFogD * pl, 2.0));
  col = mix(col, fogCol, fmz * smoothstep(-0.10, 0.015, d.y));
  // Region veil (Biomes.skyVeil): smoke / peat reek / void murk that reaches the SKY, not just the aerial
  // perspective. Without it the Wastes and the fen sit under a clean blue noon dome, which is the single
  // loudest "this is a tinted meadow" cue left in those regions. Thickest at the horizon, thinner overhead.
  // zenith factor 0.92 (was 0.78): a smoke ceiling is a CEILING — the leak of clean bright noon sky
  // through the old 22% overhead window kept the Wastes/Void domes reading as bright haze, not weather.
  col = mix(col, fogCol, uVeil * mix(1.0, 0.92, smoothstep(0.0, 0.80, d.y)));
  // Region horizon glow (Biomes.glow/glowI): ember light off the Wastes' lava fields, the Isles' gold memory
  // at night. A broad saturated band, intensity premultiplied and capped ≤0.3 — never a point source (blob law).
  col += uGlow * exp(-max(d.y, 0.0) * 5.5);
  // soft shoulder (keeps hue/saturation of bright haze & cloud highlights under ACES), then the HDR sun disc for bloom/god rays
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (lum > 1.15) col *= (1.15 + (lum - 1.15) / (1.0 + (lum - 1.15) * 0.55)) / lum;   // gentle: preserves lit-top vs belly contrast (ACES finishes the roll-off)
  // the disc dims through a smoke ceiling (uVeil) — an undimmed 60x disc through heavy smoke is a washed-white
  // ball, exactly the bug the blob decree bans. It does NOT dim with fmz: a low sun must still burn through haze.
  col += sunDisc * disc * limb * 60.0 * sunUp * (1.0 - cl.a) * (1.0 - uVeil);
  gl_FragColor = vec4(col, 1.0);
}`;

// GLSL-identical smoothstep (works with reversed edges, like the shader uses)
function sstep(e0, e1, x) { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }

// Step counts are per MARCHED pixel, and only a quarter of the cloud buffer is marched each frame
// (2x2 temporal phase, resolved against a reprojected history — see CLOUD_RESOLVE_FRAG). That buys back
// ~4x, which is spent on longer marches + a deeper light march: sharper silhouettes, less step banding,
// better self-shadowing, and still well under half the old cost. Measured q=high 1080p: 9.3 ms -> ~3 ms.
const CLOUD_Q = {
  low: { scale: 0.42, steps: 28, light: 2 },
  medium: { scale: 0.52, steps: 36, light: 3 },
  high: { scale: 0.58, steps: 44, light: 3 },   // measured q=high 1080p: 16.3 ms -> 8.0 ms, with a 16% larger cloud buffer and 22% longer marches
};
// 2x2 temporal phase order (Bayer): consecutive frames land in opposite corners, so a turn never
// leaves a whole row stale. A static camera re-marches the same pixel with the same result every 4th
// frame, so the resolved image is bit-stable — no temporal shimmer for the jitter gate to catch.
const SUB_PHASE = [[0, 0], [1, 1], [1, 0], [0, 1]];

export class Sky {
  constructor(game) {
    this.game = game;
    this.hour = 15;
    this.dayLength = 60 * 20;
    this.sunDir = new THREE.Vector3(0.3, 0.6, 0.4).normalize();
    this.moonDir = new THREE.Vector3(0, 1, 0);
    this.sunColor = new THREE.Color(1, 0.95, 0.85);
    this.moonColor = new THREE.Color(0.5, 0.6, 0.9);
    this.sunDiscColor = new THREE.Color(1, 1, 1);
    this.skyColor = new THREE.Color(0.45, 0.65, 0.95);
    this.horizonColor = new THREE.Color(0.85, 0.8, 0.75);
    this.fogColor = new THREE.Color(0.7, 0.75, 0.85);
    this.ambientColor = new THREE.Color(0.5, 0.6, 0.8);
    this.groundColor = new THREE.Color(0.3, 0.25, 0.2);
    this.sunIntensity = 1; this.moonIntensity = 0; this.night = 0; this.fogDensity = 0.0012; this.sunMesh = null;
    this.sunElevation = 0.5;
    this.cloudCover = null;     // null = automatic by time of day
    this.windSpeed = 38;        // m/s cloud drift (game-fast: an FF14 sky is never still)
    this._dirty = true; this._lastSunEl = 99; this._lastCover = null;
    this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._c = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
    this._od = [0, 0, 0];
  }

  init() {
    const { scene, renderer, quality } = this.game;
    scene.background = null;
    scene.fog = new THREE.FogExp2(this.fogColor.getHex(), this.fogDensity);
    const cq = CLOUD_Q[quality] ?? CLOUD_Q.high;
    this.cloudScale = cq.scale;

    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const bake = (mat) => { const s = new THREE.Scene(); s.add(new THREE.Mesh(quadGeo, mat)); return s; };

    // --- 2D noise bake (weather map, cirrus, moon surface, star clustering) ---
    this.noiseRT = new THREE.WebGLRenderTarget(512, 512, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, stencilBuffer: false });
    this.noiseRT.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const nScene = bake(new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: NOISE_FRAG, uniforms: { uSeed: { value: (this.game.seed % 997) * 0.013 } }, depthTest: false, depthWrite: false }));
    renderer.setRenderTarget(this.noiseRT); renderer.render(nScene, quadCam); renderer.setRenderTarget(null);

    // --- 3D cloud noise bake (shape 96³, detail 32³), one draw per z slice ---
    const t3 = performance.now();
    const mk3 = (n) => {
      const rt = new THREE.WebGL3DRenderTarget(n, n, n, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
      const tx = rt.texture;
      tx.minFilter = tx.magFilter = THREE.LinearFilter;
      tx.wrapS = tx.wrapT = tx.wrapR = THREE.RepeatWrapping;
      tx.generateMipmaps = false;
      return rt;
    };
    this.shapeRT = mk3(96); this.detailRT = mk3(32);
    const n3u = { uSlice: { value: 0 }, uSeed: { value: (this.game.seed % 733) * 0.0017 }, uMode: { value: 0 } };
    const n3Scene = bake(new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: NOISE3D_FRAG, uniforms: n3u, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false }));
    for (const [rt, n, mode] of [[this.shapeRT, 96, 0], [this.detailRT, 32, 1]]) {
      n3u.uMode.value = mode;
      for (let z = 0; z < n; z++) { n3u.uSlice.value = (z + 0.5) / n; renderer.setRenderTarget(rt, z); renderer.render(n3Scene, quadCam); }
      console.log('[sky] bake mode', mode, (performance.now() - t3).toFixed(0), 'ms');
    }
    renderer.setRenderTarget(null);
    console.log('[sky] 3D cloud noise baked in', (performance.now() - t3).toFixed(0), 'ms');

    // --- sky-view LUT ---
    this.lutRT = new THREE.WebGLRenderTarget(256, 128, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    this.lutMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: LUT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { uSunDir: { value: this.sunDir }, uSunE: { value: SUN_E }, uMs: { value: MS }, uObsH: { value: OBS_H }, uSunEl: { value: 0.5 } } });
    this.lutScene = bake(this.lutMat); this.lutCam = quadCam;

    // --- shared uniforms (cloud pass + dome read the same objects) ---
    const mkRT = () => new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    this.cloudRT = mkRT();              // full cloud resolution, ping-pong history (the dome samples this pair)
    this.cloudRTB = mkRT();
    this.cloudLoRT = mkRT();            // half linear size: the quarter of pixels actually marched this frame
    this._sub = 0; this._histValid = 0;
    this.uniforms = {
      uLut: { value: this.lutRT.texture }, uNoise: { value: this.noiseRT.texture }, uClouds: { value: this.cloudRT.texture },
      uShape: { value: this.shapeRT.texture }, uDetail: { value: this.detailRT.texture },
      uSunDir: { value: this.sunDir }, uMoonDir: { value: this.moonDir }, uSunDisc: { value: this.sunDiscColor }, uMoonCol: { value: new THREE.Color() }, uMoonGlow: { value: new THREE.Color() },
      uFogColor: { value: new THREE.Color().copy(this.fogColor) }, uVeil: { value: 0 }, uFogD: { value: this.fogDensity }, uGlow: { value: new THREE.Color(0, 0, 0) }, uCloudLightDir: { value: new THREE.Vector3(0, 1, 0) }, uCloudLightCol: { value: new THREE.Color() },
      uCloudAmbTop: { value: new THREE.Color() }, uCloudAmbBot: { value: new THREE.Color() }, uBeltCol: { value: new THREE.Color() },
      uTime: { value: 0 }, uWindT: { value: 0 }, uCamY: { value: 0 }, uCamPos: { value: new THREE.Vector3() },
      uCloudCover: { value: 0.5 }, uCirrusCover: { value: 0.5 }, uHaze: { value: 0.3 }, uAurora: { value: 0 },
      uSunEl: { value: 0.5 }, uStarVis: { value: 0 }, uStarMat: { value: new THREE.Matrix3() },
      uCloudH0: { value: 1500 }, uCloudH1: { value: 4200 }, uBelt: { value: 0 }, uPixAng: { value: 0.001 },
      uTileM: { value: CLOUD_TILE }, uWindV: { value: new THREE.Vector2() }, uShearV: { value: new THREE.Vector2() },
      uThr: { value: new THREE.Vector3(0.80, 0.16, 0.26) },
      uCamRot: { value: new THREE.Matrix3() }, uTan: { value: new THREE.Vector2(1, 1) }, uCloudTexel: { value: new THREE.Vector2(0.002, 0.002) },
      // temporal cloud resolve
      uSubJitter: { value: new THREE.Vector2() }, uSubIdx: { value: new THREE.Vector2() },
      uLo: { value: this.cloudLoRT.texture }, uHist: { value: this.cloudRTB.texture },
      uPrevRotInv: { value: new THREE.Matrix3() }, uPrevTan: { value: new THREE.Vector2(1, 1) }, uHistValid: { value: 0 },
      uOcc: { value: null }, uOccTexel: { value: new THREE.Vector2() }, uPrevTanS: { value: new THREE.Vector2(1, 1) }, uCullOn: { value: 0 },
    };

    // --- cloud pass (quarter of the cloud buffer per frame) ---
    this.cloudMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: CLOUD_FRAG, uniforms: this.uniforms, glslVersion: THREE.GLSL3,
      defines: { CLOUD_STEPS: cq.steps, LIGHT_STEPS: cq.light }, depthTest: false, depthWrite: false });
    this.cloudScene = bake(this.cloudMat);
    this.resolveMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: CLOUD_RESOLVE_FRAG, uniforms: this.uniforms, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false });
    this.resolveScene = bake(this.resolveMat);

    // --- cloud occlusion pyramid: three 2x2 min-reductions of last frame's depth (full -> 1/2 -> 1/4 -> 1/8) ---
    // Cheap (a 4-tap gather per texel, ~0.77 M taps total) next to what it saves: a fully-occluded cloud texel
    // skips a 44-step march. NearestFilter, RedFormat, HalfFloat -- the decision boundary is at 0, where fp16
    // has precision to spare, and the values never need to be interpolated.
    const mkOcc = () => { const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false }); return rt; };
    this.occRT = [mkOcc(), mkOcc(), mkOcc()];
    this.occMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: OCC_FRAG, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
      uniforms: { uSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() }, uFromDepth: { value: 0 } } });
    this.occScene = bake(this.occMat);
    this.cloudOcclusionCull = true;   // kill switch + the A/B handle for verifying the cull is lossless

    // --- dome ---
    this.material = new THREE.ShaderMaterial({ vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false });
    this.dome = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.dome.frustumCulled = false; this.dome.renderOrder = 10000; this.dome.layers.enable(1); this.dome.name = 'skyDome';
    scene.add(this.dome);

    // --- sun disc mesh (god-rays light source) ---
    this.sunMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false, depthWrite: false });
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10), this.sunMat);
    this.sunMesh.scale.setScalar(1500 * Math.tan(0.0225 * 0.95)); this.sunMesh.renderOrder = 10001; this.sunMesh.frustumCulled = true; this.sunMesh.layers.enable(1); this.sunMesh.name = 'sun';
    scene.add(this.sunMesh);

    this._starAxis = new THREE.Vector3(0.05, 0.72, -0.69).normalize();
    this._q = new THREE.Quaternion(); this._m4 = new THREE.Matrix4();
    const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
    this._setCloudSize(sz.x, sz.y);
    this.setHour(this.hour);
    this._refreshColors();
  }

  _setCloudSize(w, h) {
    // The occlusion chain follows the SCREEN (it reduces the scene depth texture), so it must be sized ABOVE the
    // cloud-size early return: cw quantises to ~3.4 px of width while the chain quantises to 2, so a resize can
    // leave cw unchanged while the chain is stale, and the four reduction taps then miss their 2x2 block.
    if (this.occRT) {
      let sw = w, sh = h;
      for (let i = 0; i < 3; i++) { sw = Math.max(1, sw >> 1); sh = Math.max(1, sh >> 1); this.occRT[i].setSize(sw, sh); }
      const last = this.occRT[2];
      this.uniforms.uOccTexel.value.set(1 / last.width, 1 / last.height);
      this.uniforms.uOcc.value = last.texture;
      this._occSrc0 = new THREE.Vector2(1 / Math.max(1, w), 1 / Math.max(1, h));   // level 0 reads the depth texture itself
    }
    // cloud buffer is even-sized: the 2x2 temporal phase needs whole blocks, and the marched target is exactly half of it
    const cw = Math.max(64, Math.round(w * this.cloudScale) & ~1), ch = Math.max(64, Math.round(h * this.cloudScale) & ~1);
    if (cw === this.cloudRT.width && ch === this.cloudRT.height) return;
    this.cloudRT.setSize(cw, ch); this.cloudRTB.setSize(cw, ch); this.cloudLoRT.setSize(cw >> 1, ch >> 1);
    this.uniforms.uCloudTexel.value.set(1 / cw, 1 / ch);
    this._histValid = 0;   // both history buffers are garbage after a resize
  }
  resize() { const sz = this.game.renderer.getDrawingBufferSize(new THREE.Vector2()); this._setCloudSize(sz.x, sz.y); }

  setHour(h) {
    this.hour = ((h % 24) + 24) % 24;
    const th = (this.hour - 5.75) / 12.5 * PI;                 // sunrise 5:45, sunset 18:15, noon elevation 70° transiting south (+z)
    const s70 = Math.sin(70 * DEG), c70 = Math.cos(70 * DEG);
    const vx = Math.cos(th), vy = Math.sin(th) * s70, vz = Math.sin(th) * c70;
    // flatten the path near the horizon (≈10°/h at sunrise/sunset like mid-latitudes, so golden hour/dusk last): el' = el·(0.6+0.4(el/70°)²)
    const el0 = Math.asin(THREE.MathUtils.clamp(vy, -1, 1)), k = el0 / (70 * DEG), el1 = el0 * (0.6 + 0.4 * k * k);
    const hl = Math.hypot(vx, vz) || 1e-6;
    this.sunDir.set(vx / hl * Math.cos(el1), Math.sin(el1), vz / hl * Math.cos(el1)).normalize();
    const tm = th + PI + 0.45;                                  // moon roughly opposite, on a differently tilted/rotated orbit so it's never exactly anti-solar
    const s55 = Math.sin(55 * DEG), c55 = Math.cos(55 * DEG), mx = Math.cos(tm), mz = Math.sin(tm) * c55, r20 = 20 * DEG;
    this.moonDir.set(mx * Math.cos(r20) - mz * Math.sin(r20), Math.sin(tm) * s55, mx * Math.sin(r20) + mz * Math.cos(r20)).normalize();
    this.sunElevation = Math.asin(THREE.MathUtils.clamp(this.sunDir.y, -1, 1));
    const elD = this.sunElevation / DEG;
    this.sunIntensity = this._sunIBase = THREE.MathUtils.smoothstep(elD, -2, 6);
    this.night = 1 - THREE.MathUtils.smoothstep(elD, -14, -2);
    this.moonIntensity = THREE.MathUtils.smoothstep(this.moonDir.y, -0.04, 0.12) * this.night;
    this._dirty = true;
  }

  update(dt, t) {
    if (this.dayLength > 0) this.setHour(this.hour + dt * 24 / this.dayLength);
    const { renderer, camera, scene } = this.game;
    const u = this.uniforms;
    // LUT + CPU colors only when the sun actually moved (~every 0.06 s during the cycle) or something was forced
    if (this.cloudCover !== this._lastCover) { this._lastCover = this.cloudCover; this._dirty = true; this._lastSunEl = 99; }
    if (this._dirty && Math.abs(this.sunElevation - this._lastSunEl) > 0.0003) {
      this._lastSunEl = this.sunElevation; this._dirty = false;
      this.lutMat.uniforms.uSunEl.value = this.sunElevation;
      renderer.setRenderTarget(this.lutRT); renderer.render(this.lutScene, this.lutCam); renderer.setRenderTarget(null);
      this._refreshColors(false);
    }
    // per-frame uniforms
    u.uTime.value = t; u.uWindT.value = t;
    u.uWindV.value.set(WIND[0] * this.windSpeed * t, WIND[1] * this.windSpeed * t);
    u.uShearV.value.set(WIND[0] * 340, WIND[1] * 340);           // tops lean downwind of the bases
    u.uCamY.value = Math.max(0, camera.position.y);
    u.uCamPos.value.copy(camera.position);
    u.uSunEl.value = this.sunElevation;
    u.uPixAng.value = (camera.fov * DEG) / (renderer.domElement.height || 1080);   // angular size of one pixel (star cores)
    // camera basis for the cloud pass; 8% wider than the real frustum so a fast turn can't run off the edge of the buffer
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    const ty = Math.tan(camera.fov * DEG * 0.5) * CLOUD_WIDEN;
    u.uTan.value.set(ty * camera.aspect, ty);
    // celestial sphere rotation (stars) follows the clock
    this._q.setFromAxisAngle(this._starAxis, this.hour / 24 * PI * 2 + 0.7);
    this._m4.makeRotationFromQuaternion(this._q); u.uStarMat.value.setFromMatrix4(this._m4);
    // volumetric clouds: march this frame's 2x2 phase at quarter rate, then resolve against the reprojected
    // previous buffer. The dome always samples the buffer we just wrote (composited with a 4-tap tent upsample).
    const ph = SUB_PHASE[this._sub & 3];
    u.uSubIdx.value.set(ph[0], ph[1]);
    // a lo-res texel covers one 2x2 block; its four sub-positions sit a quarter of a lo-texel from the centre
    u.uSubJitter.value.set((ph[0] - 0.5) * 0.5 / this.cloudLoRT.width, (ph[1] - 0.5) * 0.5 / this.cloudLoRT.height);
    // Reduce last frame's scene depth into the occlusion pyramid, then let the march skip tiles the world
    // already covers. `depthTexture` is null before the first composed frame and whenever no depth-consuming
    // effect is enabled (q=low), in which case uCullOn stays 0 and every ray marches as before.
    const depthTex = this.game.postfx?.depthTexture ?? null;
    if (depthTex && this.cloudOcclusionCull) {
      const om = this.occMat.uniforms;
      for (let i = 0; i < 3; i++) {
        om.uSrc.value = i === 0 ? depthTex : this.occRT[i - 1].texture;
        om.uFromDepth.value = i === 0 ? 1 : 0;
        if (i === 0) om.uSrcTexel.value.copy(this._occSrc0);           // the depth texture's own texel, not a doubled level-0
        else om.uSrcTexel.value.set(1 / this.occRT[i - 1].width, 1 / this.occRT[i - 1].height);
        renderer.setRenderTarget(this.occRT[i]); renderer.render(this.occScene, this.lutCam);
      }
      // A culled texel keeps its history instead of refreshing, so its content can drift arbitrarily far from
      // the truth while it stays hidden -- and the dome's 4-tap tent upsample can pull that stale value a
      // pixel or two into visible sky at an occluder edge. Measured: with a history inherited from a moving
      // camera, 3.1% of meadow pixels differed (max 51/255) until the buffer was fully re-marched.
      // So bound the staleness: four consecutive frames out of every 32 march everything, which is exactly
      // one full 2x2 sub-phase cycle, i.e. every texel is guaranteed fresh within ~0.3 s at 100 fps. Costs
      // 12.5% of the saving and removes the failure mode entirely.
      // Never cull while the history buffer is garbage (boot, and every resize clears _histValid): the resolve's
      // last-resort branch clamps the sentinel to alpha 0 and stores THAT as history, i.e. "clear sky", and a
      // texel that stays culled keeps it. Observed as a cloudless patch where an occluder used to be.
      u.uCullOn.value = (this._histValid > 0.5 && (this._sub & 31) >= 4) ? 1 : 0;
    } else u.uCullOn.value = 0;
    renderer.setRenderTarget(this.cloudLoRT); renderer.render(this.cloudScene, this.lutCam);
    const hist = this.cloudRTB, dst = this.cloudRT;                 // dst was last frame's history (they swap below)
    u.uLo.value = this.cloudLoRT.texture; u.uHist.value = hist.texture; u.uHistValid.value = this._histValid;
    renderer.setRenderTarget(dst); renderer.render(this.resolveScene, this.lutCam); renderer.setRenderTarget(null);
    u.uClouds.value = dst.texture;
    this.cloudRT = hist; this.cloudRTB = dst;                       // ping-pong: next frame reads what we just wrote
    u.uPrevRotInv.value.copy(u.uCamRot.value).transpose();          // rotation matrix: inverse == transpose
    u.uPrevTan.value.copy(u.uTan.value);
    u.uPrevTanS.value.copy(u.uTan.value).multiplyScalar(1 / CLOUD_WIDEN);   // real frustum tan: what the depth buffer spans
    this._sub++; this._histValid = 1;
    // sun mesh follows the camera
    this.sunMesh.position.copy(camera.position).addScaledVector(this.sunDir, 1500);
    this.sunMesh.visible = this.sunDir.y > -0.08;
    this._gradeFog(camera);
    scene.fog.color.copy(this._fogC); scene.fog.density = this._fogD;
    // the dome's horizon haze and the region veil read the GRADED fog, so the sky over a region is made of
    // the same air the distance is (in the Vale _fogC === fogColor, so nothing changes there)
    u.uFogColor.value.copy(this._fogC);
    u.uVeil.value = this._veilE ?? 0;
    u.uFogD.value = this._fogD;   // graded density: the dome's aerial-perspective match mirrors FogExp2 exactly
    // the physical HDR sun mesh (40x, feeds god rays + bloom) dims through the smoke ceiling like the dome's
    // disc does — an undimmed mesh through a 0.88 veil is a washed-white ball over the Wastes (blob law)
    this.sunMat.color.copy(this.sunDiscColor).multiplyScalar(40 * (1 - (this._veilE ?? 0)));
    // A smoke/reek ceiling dims the SUN ITSELF, not just the dome: without this the Wastes' mountains
    // stayed brightly key-lit tan under a "smoke" sky and the fen's slopes stayed cheerful spring-lime
    // (crit2-infernal / crit2-shadowfen). Squared, so true ceilings (0.85+) go sunless-overcast while a
    // light canopy veil (forest 0.42) keeps most of its key. Lighting reads sunIntensity after us.
    this.sunIntensity = (this._sunIBase ?? this.sunIntensity) * (1 - 0.70 * (this._veilE ?? 0) ** 2);
    this._updateShafts(t);   // forest under-canopy sun shafts + dapple (reads _bb, set by _gradeFog above)
  }

  /**
   * Aerial perspective is LOCAL: push the haze toward the biome the camera is standing in, keeping the
   * sky's own time-of-day luminance so night still reads as night and dawn still reads as dawn. Only the
   * hue and the density move — one lerp per frame, no allocation.
   */
  _gradeFog(camera) {
    const out = this._fogC ??= new THREE.Color();
    out.copy(this.fogColor); this._fogD = this.fogDensity;
    // Submerged: the whole world is seen through the water column, so the fog IS the water. Colour comes
    // from whatever look Water is currently wearing, so the fen is green murk and the Sunken Kingdom is blue.
    const wtr = this.game.world?.water;
    if (wtr?.level != null && camera.position.y < wtr.level && wtr.isWater?.(camera.position.x, camera.position.z)) {
      const sh = wtr.uniforms?.uShallow?.value;
      if (sh) { out.setRGB(sh.r * 2.1, sh.g * 2.1, sh.b * 2.1); this._fogD = 0.055; return; }
    }
    const b = this.game.terrain?.biomeBlend?.(camera.position.x, camera.position.z, this._bb ??= {});
    const B = b && b.w > 0.002 ? BIOMES[b.id] : null;
    // the veil eases BOTH ways, including on this early-out — otherwise walking out of the Wastes leaves
    // its smoke ceiling stuck over the Vale for the rest of the session
    const veilT = B ? (B.skyVeil ?? 0) * b.w : 0;
    this._veilE = (this._veilE ?? 0) + (veilT - (this._veilE ?? 0)) * 0.03;
    // Horizon glow (Biomes.glow/glowI -> DOME_FRAG uGlow). Eased both ways here, same as the veil, so it
    // cannot stick over a neighbour. Night-weighted: an ember horizon is a night read, a faint one by day.
    const gU = this.uniforms.uGlow.value;
    let gr = 0, gg = 0, gb = 0;
    if (B && B.glow != null) {
      const gcache = this._glowCache ??= new Map();
      let gt = gcache.get(b.id);
      if (!gt) { gt = new THREE.Color(B.glow).convertSRGBToLinear(); gcache.set(b.id, gt); }
      const s = Math.min(B.glowI ?? 0, 0.3) * b.w * (0.25 + 0.75 * this.night);
      gr = gt.r * s; gg = gt.g * s; gb = gt.b * s;
    }
    gU.r += (gr - gU.r) * 0.03; gU.g += (gg - gU.g) * 0.03; gU.b += (gb - gU.b) * 0.03;
    // ---- per-region key + night-ambient grade (Biomes.keyLow / .ambNight) ----
    // Applied HERE (Sky updates before Lighting/Water/Grass, all of which read these colours), re-derived
    // every frame from the pristine copies _refreshColors keeps, so nothing compounds.
    const L = (v) => v.r * 0.2126 + v.g * 0.7152 + v.b * 0.0722;
    const gld = sstep(0.35, 0.10, this.sunElevation) * sstep(-0.05, 0.02, this.sunElevation);   // 1 = golden hour, 0 = high noon / night
    const klT = B && B.keyLow != null ? b.w * gld : 0;
    this._klE = (this._klE ?? 0) + (klT - (this._klE ?? 0)) * 0.03;
    if (B && B.keyLow != null) {
      const kcache = this._klCache ??= new Map();
      let kc = kcache.get(b.id);
      if (!kc) { kc = new THREE.Color(B.keyLow).convertSRGBToLinear(); kcache.set(b.id, kc); }
      this._klC = kc;
    }
    // keyLow grades the FILL as well as the key, and that is where the fix actually lives. Measured at
    // hour 18 in the Isles (sky3-a/shot-cel18-ground): the floor came out 1 : 0.30 : 0.125 in linear —
    // far more orange than the key ever was, because Lighting hue-forces the key to BIOMES.sun anyway
    // (luminance-preserving, so keyLow could never reach it) while the ORANGE arrived through the
    // hemisphere (= sky.ambientColor / groundColor) and the env probe (baked from groundColor+sunColor).
    // Grading all three at low sun is what stops a region collapsing into one sunset hue.
    if (this._sunBase) this._hueToward(this.sunColor.copy(this._sunBase), this._klC, this._klE);
    const anT = B && B.ambNight != null ? 1 + (B.ambNight - 1) * b.w * this.night : 1;
    this._anE = (this._anE ?? 1) + (anT - (this._anE ?? 1)) * 0.03;
    if (this._ambBase) {
      this._hueToward(this.ambientColor.copy(this._ambBase).multiplyScalar(this._anE), this._klC, this._klE);
      this._hueToward(this.groundColor.copy(this._gndBase).multiplyScalar(this._anE), this._klC, this._klE);
    }
    if (!B || !B.fog) return;
    const cache = this._fogCache ??= new Map();
    let t = cache.get(b.id);
    if (!t) { t = new THREE.Color(B.fog).convertSRGBToLinear(); cache.set(b.id, t); }
    // Regions abut (Biomes.RL_*), so crossing a seam flips b.id in one frame at weight ~0.5. Chase the
    // target hue/density instead of taking them straight, so the haze turns over ~1 s of walking.
    const c = this._fogBiome ??= t.clone();
    c.lerp(t, 0.03);
    this._fogMulE = this._fogMulE == null ? (B.fogMul ?? 1) : this._fogMulE + ((B.fogMul ?? 1) - this._fogMulE) * 0.03;
    // fogLum: the ONE place a region is allowed to move the haze's brightness. Hue-only grading keeps the
    // sky's luminance, which is right for clear air — but smoke, peat reek and void murk are DARKER than
    // the sky they hang under, and at midday a hue-only Wastes reads as a bright cream-orange desert.
    this._fogLumE = this._fogLumE == null ? (B.fogLum ?? 1) : this._fogLumE + ((B.fogLum ?? 1) - this._fogLumE) * 0.03;
    // fogLum darkens the AIR ITSELF, before the hue force: smoke/reek/murk hang DARKER than the sky above
    // them. It used to be folded into k and diluted through the 0.85 hue mix — 15% of a luminance-2 noon
    // sky leaking through is why the Wastes' "smoke" still tone-mapped to a lit cream desert (crit2-infernal).
    const lumS = 1 + (this._fogLumE - 1) * b.w;
    out.r *= lumS; out.g *= lumS; out.b *= lumS;
    // hazeSun: at low sun a mist region hands part of the mix back to the time-of-day colour — water vapour
    // takes on the sunset light, so golden hour reaches the Sunken gorge instead of constant sea-mint.
    const k = L(out) / Math.max(1e-4, L(c)), w = b.w * 0.85 * (1 - (B.hazeSun ?? 0) * gld);
    out.setRGB(out.r + (c.r * k - out.r) * w, out.g + (c.g * k - out.g) * w, out.b + (c.b * k - out.b) * w);
    this._fogD = this.fogDensity * (1 + (this._fogMulE - 1) * b.w);
  }

  /** Pull colour `c` toward hue `kc` by `e`, keeping c's own luminance — same trick as Lighting._gradeBiome.
   *  In place, no allocation (this runs on every colour, every frame). */
  _hueToward(c, kc, e) {
    if (!kc || !(e > 0.002)) return c;
    const lc = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722, lk = kc.r * 0.2126 + kc.g * 0.7152 + kc.b * 0.0722;
    const k = lc / Math.max(1e-4, lk);
    return c.setRGB(c.r + (kc.r * k - c.r) * e, c.g + (kc.g * k - c.g) * e, c.b + (kc.b * k - c.b) * e);
  }

  // ---------------- forest sun shafts + ground dapple ----------------
  // Midday under the Whisperwood canopy read as flat near-dusk with zero light play (crit2-forest-b/
  // shot-interior-70). These are FF14's cathedral shafts: camera-facing additive ribbons dropped where
  // a deterministic "canopy gap" scatter allows, each with a broken light pool at its foot. They are
  // LIGHT, not glow: broad and soft, colour = the real key filtered through leaves, peak added radiance
  // ~0.45 per shaft (bloom threshold is 1.2 — nothing here can bloom, per the blob decree), and they
  // fade out entirely when the sun is low (dapple is a high-sun read) or the camera leaves the forest.
  // Cost: 2 draw calls, ~1.4k tris, forest-only (group hidden elsewhere).
  //
  // DENSITY IS THE WHOLE FEATURE. At 44 points over a 240 m disc the spacing is ~64 m, so the visible
  // annulus (the 14..70 m band the fade keeps, across a ~100 deg fov) held ONE shaft on average — which is
  // why hour 13 still photographed as flat dusk with no light play (sky3-verify/shot-for13-interior).
  // 190 points is ~4-5 in frame: a floor that is broken by light instead of uniformly dark. Cheap enough
  // that this is the right lever; do not "fix" a thin read by raising the per-shaft radiance instead —
  // these are additive and they stack, and ground cover is what they land on (blob decree).
  _buildShafts() {
    const T = this.game.terrain;
    if (!T?.heightAt) return;                                 // terrain not up yet: retry next frame
    this._shaftsBuilt = true;                                 // past here every exit is PERMANENT (the scatter is seeded, so an empty result stays empty) — do not retry per frame
    const F = BIOMES.forest;                                  // cx/cz resolved by Biomes at module load
    const rnd = mulberry32(((this.game.seed ?? 1) | 0) + 777);
    const pts = [];
    for (let i = 0; i < 1100 && pts.length < 190; i++) {
      const a = rnd() * PI * 2, r = Math.sqrt(rnd()) * 240;
      const g = rnd();                                          // gap acceptance BEFORE the position is used
      const x = F.cx + Math.cos(a) * r, z = F.cz + Math.sin(a) * r;
      if (g < 0.42) continue;                                   // clustered gaps, not a lawn of shafts
      const y = T.heightAt(x, z);
      if (y < (T.waterLevel ?? 4) + 0.5) continue;
      pts.push([x, y + 0.05, z, rnd()]);
    }
    if (!pts.length) return;
    const mkGeo = (corners) => {
      const n = pts.length, v = corners.length;
      const org = new Float32Array(n * v * 3), cor = new Float32Array(n * v * 2), rd = new Float32Array(n * v);
      const idx = [];
      for (let i = 0; i < n; i++) {
        const p = pts[i], b = i * v;
        for (let j = 0; j < v; j++) {
          org.set([p[0], p[1], p[2]], (b + j) * 3); cor.set(corners[j], (b + j) * 2); rd[b + j] = p[3];
        }
        idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('aOrigin', new THREE.BufferAttribute(org, 3));
      geo.setAttribute('aCorner', new THREE.BufferAttribute(cor, 2));
      geo.setAttribute('aRand', new THREE.BufferAttribute(rd, 1));
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * v * 3), 3));   // unused; keeps three happy
      geo.setIndex(idx);
      return geo;
    };
    this._shaftU = {
      uSunDirW: { value: this.sunDir }, uCol: { value: new THREE.Color() }, uI: { value: 0 },
      uTime: { value: 0 }, uLen: { value: 26 }, uNoise: { value: this.noiseRT.texture },
    };
    const common = { uniforms: this._shaftU, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false };
    const shaftMat = new THREE.ShaderMaterial({ ...common,
      vertexShader: /* glsl */`
        attribute vec3 aOrigin; attribute vec2 aCorner; attribute float aRand;
        uniform vec3 uSunDirW; uniform float uLen;
        varying vec2 vUv; varying float vRand, vFade;
        void main() {
          vec3 axis = normalize(uSunDirW);
          vec3 toCam = cameraPosition - aOrigin;
          vec3 side = cross(axis, toCam);
          side = normalize(dot(side, side) > 1e-6 ? side : vec3(1.0, 0.0, 0.0));
          vec3 p = aOrigin + axis * (aCorner.y * uLen) + side * (aCorner.x * (1.0 + aRand * 1.8));
          vUv = aCorner; vRand = aRand;
          float d = length(toCam);
          vFade = (1.0 - smoothstep(70.0, 150.0, d)) * smoothstep(2.5, 9.0, d);    // gone far away, gone right on top of it
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uCol; uniform float uI, uTime; uniform sampler2D uNoise;
        varying vec2 vUv; varying float vRand, vFade;
        void main() {
          float across = 1.0 - abs(vUv.x);
          float streak = texture2D(uNoise, vec2(vUv.x * 0.22 + vRand * 5.31 + uTime * 0.006, vRand * 0.73 + uTime * 0.002)).g;
          float body = smoothstep(0.02, 0.25, vUv.y) * (1.0 - smoothstep(0.60, 0.98, vUv.y));
          gl_FragColor = vec4(uCol, across * across * (0.30 + 0.70 * streak) * body * uI * vFade);
        }`,
    });
    const discMat = new THREE.ShaderMaterial({ ...common,
      vertexShader: /* glsl */`
        attribute vec3 aOrigin; attribute vec2 aCorner; attribute float aRand;
        varying vec2 vUv; varying float vRand, vFade;
        void main() {
          vec3 p = aOrigin + vec3(aCorner.x, 0.0, aCorner.y) * (2.2 + aRand * 3.2) + vec3(0.0, 0.06, 0.0);
          vUv = aCorner; vRand = aRand;
          vFade = 1.0 - smoothstep(60.0, 130.0, distance(cameraPosition, aOrigin));
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uCol; uniform float uI, uTime; uniform sampler2D uNoise;
        varying vec2 vUv; varying float vRand, vFade;
        void main() {
          float core = max(1.0 - dot(vUv, vUv), 0.0);
          float dap = texture2D(uNoise, vUv * 0.9 + vRand * 3.7 + uTime * 0.0015).b;   // broken leaf-light pool, not a spotlight
          gl_FragColor = vec4(uCol, core * core * (0.25 + 0.75 * smoothstep(0.35, 0.75, dap)) * 0.55 * uI * vFade);
        }`,
    });
    const quad = [[-1, 0], [1, 0], [-1, 1], [1, 1]], dquad = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    this.shafts = new THREE.Group(); this.shafts.name = 'sunShafts'; this.shafts.visible = false;
    for (const [geo, mat] of [[mkGeo(quad), shaftMat], [mkGeo(dquad), discMat]]) {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false; m.renderOrder = 900;
      this.shafts.add(m);
    }
    this.game.scene.add(this.shafts);
  }

  _updateShafts(t) {
    if (!this._shaftsBuilt) { this._buildShafts(); if (!this._shaftsBuilt) return; }
    if (!this._shaftU) return;
    const bb = this._bb;                                        // region blend cached by _gradeFog this frame
    // 0.28..0.52 (was 0.35..0.60): the shafts now carry the whole afternoon, half-strength by ~15:30 and
    // gone by ~16:30. They cannot go lower than that — the quad is extruded from the ground ALONG sunDir,
    // so under a 15-degree sun it lies down and reads as a horizontal beam instead of light coming through
    // the canopy. A real low-sun shaft needs a different anchor (canopy-height origin, extruded downward).
    const tgt = (bb?.id === 'forest' && bb.w > 0.02 ? bb.w : 0) * THREE.MathUtils.smoothstep(this.sunDir.y, 0.28, 0.52);
    this._shaftE = (this._shaftE ?? 0) + (tgt - (this._shaftE ?? 0)) * 0.04;
    const on = this._shaftE > 0.015;
    this.shafts.visible = on;
    if (!on) return;
    const su = this._shaftU;
    su.uI.value = this._shaftE; su.uTime.value = t;
    // sun through leaves: the graded key filtered warm-green, scaled so stacked shafts stay under bloom.
    // 0.50 (was 0.60) buys headroom for the 4x denser scatter: peak per shaft ~0.28 luminance, so it takes
    // four at full centre-line alpha to reach the 1.2 bloom threshold, and `across*across` means the centre
    // line is a sliver. Saturate the colour, cap the intensity.
    su.uCol.value.copy(this.sunColor).multiply(this._leafF ??= new THREE.Color(0.85, 1.0, 0.62)).multiplyScalar(0.50);
  }

  dispose() {
    for (const rt of [this.noiseRT, this.lutRT, this.cloudRT, this.cloudRTB, this.cloudLoRT, this.shapeRT, this.detailRT, ...(this.occRT ?? [])]) rt?.dispose();
    this.material?.dispose(); this.cloudMat?.dispose(); this.lutMat?.dispose(); this.sunMat?.dispose();
    this.resolveMat?.dispose(); this.occMat?.dispose();
    if (this.shafts) for (const m of this.shafts.children) { m.geometry.dispose(); m.material.dispose(); }
  }

  // ---------------- CPU twin of the atmosphere (colors for the other systems) ----------------
  _transmittance(px, py, pz, sx, sy, sz, out) {
    const b = px * sx + py * sy + pz * sz; let soft = 1;
    if (b < 0) { const hmin = Math.sqrt(Math.max(px * px + py * py + pz * pz - b * b, 0)) - Rg; soft = THREE.MathUtils.smoothstep(hmin, -2500, 1500); if (soft <= 0) { out[0] = out[1] = out[2] = 0; return out; } }
    const c = px * px + py * py + pz * pz - Rt * Rt; const tMax = -b + Math.sqrt(Math.max(b * b - c, 0)); const dt = tMax / 6;
    let o0 = 0, o1 = 0, o2 = 0;
    for (let i = 0; i < 6; i++) { const tt = (i + 0.5) * dt; const qx = px + sx * tt, qy = py + sy * tt, qz = pz + sz * tt; const h = Math.max(Math.sqrt(qx * qx + qy * qy + qz * qz) - Rg, 0);
      const dR = Math.exp(-h / HR), dM = Math.exp(-h / HM), dO = Math.max(0, 1 - Math.abs(h - 25e3) / 15e3);
      o0 += (BETA_R[0] * dR + (BETA_MS + BETA_MA) * dM + BETA_O[0] * dO) * dt; o1 += (BETA_R[1] * dR + (BETA_MS + BETA_MA) * dM + BETA_O[1] * dO) * dt; o2 += (BETA_R[2] * dR + (BETA_MS + BETA_MA) * dM + BETA_O[2] * dO) * dt; }
    out[0] = Math.exp(-o0) * soft; out[1] = Math.exp(-o1) * soft; out[2] = Math.exp(-o2) * soft; return out;
  }
  // sky radiance toward (az relative to sun, el); fewer samples than the GPU but same model (keep the art terms in sync with LUT_FRAG!)
  _radiance(az, el, out) {
    const sEl = this.sunElevation, sx = 0, sy = Math.sin(sEl), sz = Math.cos(sEl);
    const dx = Math.sin(az) * Math.cos(el), dy = Math.sin(el), dz = Math.cos(az) * Math.cos(el);
    const oy = Rg + OBS_H;
    const b = oy * dy, cG = oy * oy - Rg * Rg, qG = b * b - cG; const tG = qG >= 0 ? -b - Math.sqrt(qG) : -1;
    const cT = oy * oy - Rt * Rt; let tMax = tG > 0 ? tG : -b + Math.sqrt(Math.max(b * b - cT, 0)); tMax = Math.min(tMax, 420e3);
    const mu = dx * sx + dy * sy + dz * sz, g = 0.72;
    const pR = 3 / (16 * PI) * (1 + mu * mu), pM = 3 / (8 * PI) * (1 - g * g) * (1 + mu * mu) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));
    let L0 = 0, L1 = 0, L2 = 0, T0 = 1, T1 = 1, T2 = 1; const N = 14; const Tl = this._od;
    for (let i = 0; i < N; i++) {
      const f0 = i / N, f1 = (i + 1) / N, t0 = tMax * f0 * f0, t1 = tMax * f1 * f1, dt = t1 - t0, tm = 0.5 * (t0 + t1);
      const px = dx * tm, py = oy + dy * tm, pz = dz * tm; const h = Math.max(Math.sqrt(px * px + py * py + pz * pz) - Rg, 0);
      const dR = Math.exp(-h / HR), dM = Math.exp(-h / HM), dO = Math.max(0, 1 - Math.abs(h - 25e3) / 15e3);
      this._transmittance(px, py, pz, sx, sy, sz, Tl);
      const msk = SUN_E * MS / (4 * PI);
      for (let k = 0; k < 3; k++) {
        const ext = BETA_R[k] * dR + (BETA_MS + BETA_MA) * dM + BETA_O[k] * dO;
        const S = (BETA_R[k] * dR * pR + BETA_MS * dM * pM) * Tl[k] * SUN_E + (BETA_R[k] * dR + BETA_MS * dM * 0.35) * Math.pow(Tl[k], 0.6) * msk;
        const sT = Math.exp(-ext * dt);
        const add = (k === 0 ? T0 : k === 1 ? T1 : T2) * (S - S * sT) / Math.max(ext, 1e-9);
        if (k === 0) { L0 += add; T0 *= sT; } else if (k === 1) { L1 += add; T1 *= sT; } else { L2 += add; T2 *= sT; }
      }
    }
    // same art terms as the LUT
    const upe = Math.max(el, 0);
    const tw = sstep(-0.26, -0.05, sEl) * (1 - sstep(-0.01, 0.12, sEl));
    const ah = Math.pow(Math.max(Math.cos(az), 0) * 0.5 + 0.5, 4), ev = Math.exp(-upe * 7);
    const k2 = THREE.MathUtils.clamp(el * 4, 0, 1), tws = tw * ah * ev * 1.6;
    L0 += (1.0 + (0.70 - 1.0) * k2) * tws; L1 += (0.32 + (0.22 - 0.32) * k2) * tws; L2 += (0.05 + (0.45 - 0.05) * k2) * tws;
    const goldW = sstep(0.30, 0.03, sEl) * sstep(-0.06, 0.0, sEl) * ah * Math.exp(-upe * 5) * 0.85;
    L0 *= 1 + 0.12 * goldW; L1 *= 1 - 0.14 * goldW; L2 *= 1 - 0.45 * goldW;
    const tw2 = tw * (0.35 + 0.65 * ah) * Math.exp(-upe * 2.2) * 0.22;
    L0 += 0.45 * tw2; L1 += 0.18 * tw2; L2 += 0.40 * tw2;
    // civil twilight dome
    const civ = sstep(-0.30, -0.02, sEl) * (1 - sstep(0.02, 0.10, sEl));
    const cmv = Math.pow(Math.max(Math.cos(az), 0) * 0.5 + 0.5, 2) * Math.exp(-upe * 2.0);
    const cw = civ * (0.32 + 0.68 * Math.exp(-upe * 1.1)) * 0.62;
    L0 += (0.085 + (0.32 - 0.085) * cmv) * cw; L1 += (0.115 + (0.17 - 0.115) * cmv) * cw; L2 += (0.30 + (0.40 - 0.30) * cmv) * cw;
    // belt of venus + earth shadow
    const bv = sstep(0.035, -0.03, sEl) * (1 - sstep(-0.10, -0.26, sEl));
    const aaz = Math.pow(Math.max(-Math.cos(az), 0), 1.6);
    const bva = bv * aaz * Math.exp(-Math.abs(el - 0.055) * 11) * 0.55;
    L0 += 0.80 * bva; L1 += 0.34 * bva; L2 += 0.38 * bva;
    const esh = bv * aaz * Math.exp(-upe * 22) * 0.6;
    L0 *= 1 + (0.55 - 1) * esh; L1 *= 1 + (0.65 - 1) * esh; L2 *= 1 + (0.95 - 1) * esh;
    // deep-night indigo floor
    const nightF = 1 - sstep(-0.30, -0.10, sEl);
    const nb = (0.75 + 0.55 * Math.exp(-upe * 1.7)) * nightF;
    L0 += 0.0135 * nb; L1 += 0.0175 * nb; L2 += 0.041 * nb;
    out[0] = L0; out[1] = L1; out[2] = L2; return out;
  }

  _refreshColors() {
    const tmp = this._od, c0 = this._c[0], c1 = this._c[1], c2 = this._c[2];
    const el = this.sunElevation, elD = el / DEG;
    // zenith
    this._radiance(0, PI / 2, tmp); this.skyColor.setRGB(tmp[0], tmp[1], tmp[2]);
    // azimuth-averaged rings: horizon (0°), fog (1.5°), ambient (30°)
    const ring = (elv, out) => { let r = 0, g = 0, b = 0; for (let i = 0; i < 8; i++) { this._radiance((i + 0.5) / 8 * PI, elv, tmp); r += tmp[0]; g += tmp[1]; b += tmp[2]; } return out.setRGB(r / 8, g / 8, b / 8); };
    ring(0.0, this.horizonColor); ring(1.5 * DEG, c1); ring(30 * DEG, c2);
    // fog: a little desaturated + lifted so far terrain melts into the haze rather than going grey-dark
    const lum = c1.r * 0.2126 + c1.g * 0.7152 + c1.b * 0.0722;
    this.fogColor.setRGB(c1.r + (lum - c1.r) * 0.15, c1.g + (lum - c1.g) * 0.15, c1.b + (lum - c1.b) * 0.15);
    const nf = this.night;
    // ambient: hemispheric mix of zenith and the 30° ring (night indigo floor comes from the model itself now)
    this.ambientColor.setRGB(this.skyColor.r * 0.4 + c2.r * 0.6, this.skyColor.g * 0.4 + c2.g * 0.6, this.skyColor.b * 0.4 + c2.b * 0.6);
    this.ambientColor.r += 0.006 * nf; this.ambientColor.g += 0.009 * nf; this.ambientColor.b += 0.020 * nf;
    // sun transmittance (ground) → sun light color, disc color
    const sx = 0, sy = Math.sin(el), sz = Math.cos(el);
    this._transmittance(0, Rg + OBS_H, 0, sx, sy, sz, tmp);
    const T0 = tmp[0], T1 = tmp[1], T2 = tmp[2];
    const p = 0.55; // softened extinction for the *light* color: real horizon sun is too red for a key light
    const n = 1 / Math.pow(0.94, p);
    this.sunColor.setRGB(Math.pow(T0, p) * n, Math.pow(T1, p) * n, Math.pow(T2, p) * n);
    this.sunDiscColor.setRGB(T0 * 1.0, T1 * 0.98, T2 * 0.92);
    this.sunMat.color.copy(this.sunDiscColor).multiplyScalar(40);
    // moon: cool pale light; disc radiance kept ~1 so maria/craters survive tonemap+bloom
    const mEl = Math.asin(THREE.MathUtils.clamp(this.moonDir.y, -1, 1));
    this._transmittance(0, Rg + OBS_H, 0, 0, Math.sin(mEl), Math.cos(mEl), tmp);
    const mi = this.moonIntensity;
    this.moonColor.setRGB(0.62 * tmp[0] ** 0.4, 0.72 * tmp[1] ** 0.4, 1.0 * tmp[2] ** 0.4).multiplyScalar(0.35 * Math.max(mi, 0.0));
    this.uniforms.uMoonCol.value.setRGB(0.92 * tmp[0] ** 0.5, 0.95 * tmp[1] ** 0.5, 1.0 * tmp[2] ** 0.5);
    this.uniforms.uMoonGlow.value.setRGB(0.16 * tmp[0] ** 0.5, 0.19 * tmp[1] ** 0.5, 0.28 * tmp[2] ** 0.5).multiplyScalar(0.4 + 0.6 * nf);
    // ground bounce: warm earthy ambient + sunlit grass bounce
    const si = this.sunIntensity;
    this.groundColor.setRGB(this.ambientColor.r * 0.35 + this.sunColor.r * si * 0.16, this.ambientColor.g * 0.32 + this.sunColor.g * si * 0.15, this.ambientColor.b * 0.22 + this.sunColor.b * si * 0.08);
    // fog density by time of day: misty dawn, clear noon, warm golden haze, deep blue night
    const dawn = Math.exp(-((this.hour - 6.3) ** 2) / 2.2), golden = Math.exp(-((this.hour - 17.6) ** 2) / 1.6);
    this.fogDensity = 0.0008 + 0.0005 * dawn + 0.0004 * golden + 0.0002 * nf;
    // clouds: light reaches 2 km altitude ~2.5° "earlier" than the ground
    const uc = this.uniforms;
    const elC = el + 2.5 * DEG;
    this._transmittance(0, Rg + 2000, 0, 0, Math.sin(elC), Math.cos(elC), tmp);
    const sunUp = THREE.MathUtils.smoothstep(elC, -0.04, 0.02);
    const sunCloud = c0.setRGB(tmp[0], tmp[1] * 0.98, tmp[2] * 0.95).multiplyScalar(2.6 * sunUp);
    const useMoon = sunCloud.r + sunCloud.g + sunCloud.b < 0.03;
    if (useMoon) { uc.uCloudLightDir.value.copy(this.moonDir); uc.uCloudLightCol.value.copy(this.moonColor).multiplyScalar(1.1); }
    else { uc.uCloudLightDir.value.copy(this.sunDir); uc.uCloudLightCol.value.copy(sunCloud); }
    uc.uCloudAmbTop.value.copy(this.ambientColor).multiplyScalar(0.85);
    this._radiance(0, 3 * DEG, tmp);                                   // horizon toward the sun: dusk/dawn glow lights cloud bellies
    const gl = THREE.MathUtils.clamp(1.2 - Math.abs(elD + 4) / 9, 0, 1);
    uc.uCloudAmbBot.value.setRGB(this.fogColor.r * 0.30 + tmp[0] * 0.16 * gl + this.ambientColor.r * 0.06, this.fogColor.g * 0.30 + tmp[1] * 0.16 * gl + this.ambientColor.g * 0.06, this.fogColor.b * 0.30 + tmp[2] * 0.16 * gl + this.ambientColor.b * 0.06);
    // belt-of-venus pink underlight on anti-solar cloud bellies at golden hour/dusk
    const beltW = sstep(-0.30, -0.10, el) * (1 - sstep(-0.04, 0.14, el));
    uc.uBelt.value = THREE.MathUtils.clamp((1 - sstep(-0.04, 0.14, el)) * sstep(-0.30, 0.02, el), 0, 1);
    uc.uBeltCol.value.setRGB(0.42, 0.20, 0.26).multiplyScalar(0.35 + 0.65 * Math.max(beltW, uc.uBelt.value));
    const h = this.hour;
    const autoCover = 0.50 + 0.06 * Math.exp(-((h - 6.5) ** 2) / 3.0) + 0.10 * Math.exp(-((h - 17.8) ** 2) / 3.2) - 0.04 * Math.exp(-((h - 12.5) ** 2) / 6.0) - 0.08 * nf;
    uc.uCloudCover.value = this.cloudCover ?? autoCover;
    uc.uCirrusCover.value = 0.45 + 0.25 * Math.exp(-((h - 17) ** 2) / 6.0);
    // towering at golden hour / dawn: the layer gets deeper (real cumulus congestus grow through the afternoon)
    const goldT = Math.exp(-((h - 17.7) ** 2) / 3.0) + 0.7 * Math.exp(-((h - 6.4) ** 2) / 2.5);
    uc.uCloudH0.value = 1450 - 180 * goldT;
    uc.uCloudH1.value = 4200 + 900 * goldT;
    uc.uHaze.value = 0.16 + 0.18 * dawn + 0.07 * golden + 0.10 * nf;
    uc.uStarVis.value = 1 - THREE.MathUtils.smoothstep(elD, -14, -8);   // stars only after civil twilight (~-8°), full by -14°
    uc.uAurora.value = (1 - THREE.MathUtils.smoothstep(elD, -14, -7)) * 1.0;
    // pristine copies: _gradeFog re-applies the per-region key/night-ambient grade from these every frame
    // (keyLow/ambNight in Biomes.js), so the grade never compounds across frames.
    (this._sunBase ??= new THREE.Color()).copy(this.sunColor);
    (this._ambBase ??= new THREE.Color()).copy(this.ambientColor);
    (this._gndBase ??= new THREE.Color()).copy(this.groundColor);
  }
}
