import * as THREE from 'three';

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
uniform mat3 uCamRot;
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

void main() {
  vec3 d = normalize(uCamRot * vec3((vUv * 2.0 - 1.0) * uTan, -1.0));
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
      float jit = fract(sin(dot(vUv, vec2(12.9898, 78.233)) * 1.0) * 43758.5453);
      vec2 wth = weather(uCamPos.xz + d.xz * (t0 + span * 0.35));
      if (wth.x > 0.005) {
        float sigE = 0.0075;
        vec3 skyC = lutSky(d);
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
            float aer = 1.0 - exp(-t * 4.2e-5);                                          // distant clouds dissolve into the haze
            acc += T * mix(S, skyC, aer) * (1.0 - tr);
            T *= tr;
            if (T < 0.02) break;
          }
        }
        // let the very last kilometres melt out completely (no razor wall at the shell tangent)
        float fade = exp(-max(t0 - 16000.0, 0.0) * 9.0e-5) * smoothstep(-0.035, 0.02, d.y);
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

// ---------------- the dome ----------------
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }`;

const DOME_FRAG = /* glsl */`
uniform sampler2D uLut, uNoise, uClouds;
uniform vec3 uSunDir, uMoonDir, uSunDisc, uMoonCol, uFogColor, uMoonGlow;
uniform float uTime, uHaze, uAurora, uStarVis, uPixAng;
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

  // ---- moon (phase-lit sphere: dark maria + crater mottling; radiance kept under bloom) + glow ----
  if (uMoonDir.y > -0.12) {
    float mum = dot(d, uMoonDir); float angm = acos(clamp(mum, -1.0, 1.0)); float R = 0.026;
    float mUp = smoothstep(-0.08, 0.05, uMoonDir.y);
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

  // ---- night: stars, milky way, aether aurora ----
  float hzFade = smoothstep(-0.02, 0.18, d.y);
  if (uStarVis > 0.001) {
    vec3 sd = uStarMat * d;
    float clus = texture2D(uNoise, vec2(atan(sd.x, sd.z) * 0.45, sd.y * 0.8) + 0.31).r;
    vec3 st = stars(sd, uPixAng, clus);
    vec3 mwN = normalize(vec3(0.35, 0.72, 0.55));
    float band = exp(-pow(dot(sd, mwN) * 3.2, 2.0));
    float mwn = texture2D(uNoise, vec2(atan(sd.x, sd.z) * 0.5, sd.y * 0.9) * 1.3).a;
    float mwn2 = texture2D(uNoise, vec2(atan(sd.x, sd.z) * 1.7, sd.y * 2.3) + 0.2).r;
    vec3 mw = mix(vec3(0.20, 0.28, 0.66), vec3(0.42, 0.32, 0.86), mwn2) * band * (0.35 + 0.9 * mwn * mwn) * 0.20;
    col += (st + mw) * uStarVis * hzFade;
  }
  if (uAurora > 0.001 && d.y > 0.02) {
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
    col += aur * uAurora * 0.30 * northW * smoothstep(0.12, 0.30, d.y);   // keep curtains well clear of the horizon
  }

  // ---- clouds: half-res volumetric pass, 4-tap tent upsample (removes the march jitter) ----
  vec3 cam = vec3(dot(d, uCamRot[0]), dot(d, uCamRot[1]), dot(d, uCamRot[2]));   // = transpose(rot)*d (no transpose() in ESSL1)
  vec4 cl = vec4(0.0);
  if (cam.z < -1e-4) {
    vec2 cuv = (cam.xy / -cam.z) / uTan * 0.5 + 0.5;
    if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {
      vec2 o = uCloudTexel * 0.5;
      cl = 0.25 * (texture2D(uClouds, cuv + vec2(o.x, o.y)) + texture2D(uClouds, cuv + vec2(-o.x, o.y))
                 + texture2D(uClouds, cuv + vec2(o.x, -o.y)) + texture2D(uClouds, cuv + vec2(-o.x, -o.y)));
    }
  }
  col = col * (1.0 - cl.a) + cl.rgb;

  // ---- horizon haze (tinted by the actual sky at that azimuth: amber toward a low sun, cool away) & ground ----
  float hz = exp(-max(d.y, 0.0) * 11.0) * uHaze;
  vec3 hcol = mix(fogCol, lutSky(normalize(vec3(d.x, abs(d.y) + 0.05, d.z))), 0.60) * 0.94;
  col = mix(col, hcol, hz * smoothstep(-0.1, 0.02, d.y));
  col = mix(col, fogCol * (1.0 - 0.28 * smoothstep(0.0, -0.32, d.y)), smoothstep(0.012, -0.03, d.y));
  // soft shoulder (keeps hue/saturation of bright haze & cloud highlights under ACES), then the HDR sun disc for bloom/god rays
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (lum > 1.15) col *= (1.15 + (lum - 1.15) / (1.0 + (lum - 1.15) * 0.55)) / lum;   // gentle: preserves lit-top vs belly contrast (ACES finishes the roll-off)
  col += sunDisc * disc * limb * 60.0 * sunUp * (1.0 - cl.a);
  gl_FragColor = vec4(col, 1.0);
}`;

// GLSL-identical smoothstep (works with reversed edges, like the shader uses)
function sstep(e0, e1, x) { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }

const CLOUD_Q = {
  low: { scale: 0.42, steps: 20, light: 2 },
  medium: { scale: 0.50, steps: 32, light: 3 },
  high: { scale: 0.50, steps: 36, light: 3 },   // perf: 48x4 at 0.55 blew the sky budget once the GLSL3 fix made clouds actually render
  ultra: { scale: 0.70, steps: 64, light: 4 },
};

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
    this.cloudRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    this.uniforms = {
      uLut: { value: this.lutRT.texture }, uNoise: { value: this.noiseRT.texture }, uClouds: { value: this.cloudRT.texture },
      uShape: { value: this.shapeRT.texture }, uDetail: { value: this.detailRT.texture },
      uSunDir: { value: this.sunDir }, uMoonDir: { value: this.moonDir }, uSunDisc: { value: this.sunDiscColor }, uMoonCol: { value: new THREE.Color() }, uMoonGlow: { value: new THREE.Color() },
      uFogColor: { value: this.fogColor }, uCloudLightDir: { value: new THREE.Vector3(0, 1, 0) }, uCloudLightCol: { value: new THREE.Color() },
      uCloudAmbTop: { value: new THREE.Color() }, uCloudAmbBot: { value: new THREE.Color() }, uBeltCol: { value: new THREE.Color() },
      uTime: { value: 0 }, uWindT: { value: 0 }, uCamY: { value: 0 }, uCamPos: { value: new THREE.Vector3() },
      uCloudCover: { value: 0.5 }, uCirrusCover: { value: 0.5 }, uHaze: { value: 0.3 }, uAurora: { value: 0 },
      uSunEl: { value: 0.5 }, uStarVis: { value: 0 }, uStarMat: { value: new THREE.Matrix3() },
      uCloudH0: { value: 1500 }, uCloudH1: { value: 4200 }, uBelt: { value: 0 }, uPixAng: { value: 0.001 },
      uTileM: { value: CLOUD_TILE }, uWindV: { value: new THREE.Vector2() }, uShearV: { value: new THREE.Vector2() },
      uThr: { value: new THREE.Vector3(0.80, 0.16, 0.26) },
      uCamRot: { value: new THREE.Matrix3() }, uTan: { value: new THREE.Vector2(1, 1) }, uCloudTexel: { value: new THREE.Vector2(0.002, 0.002) },
    };

    // --- cloud pass (half res) ---
    this.cloudMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: CLOUD_FRAG, uniforms: this.uniforms, glslVersion: THREE.GLSL3,
      defines: { CLOUD_STEPS: cq.steps, LIGHT_STEPS: cq.light }, depthTest: false, depthWrite: false });
    this.cloudScene = bake(this.cloudMat);

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
    const cw = Math.max(64, Math.round(w * this.cloudScale)), ch = Math.max(64, Math.round(h * this.cloudScale));
    if (cw === this.cloudRT.width && ch === this.cloudRT.height) return;
    this.cloudRT.setSize(cw, ch);
    this.uniforms.uCloudTexel.value.set(1 / cw, 1 / ch);
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
    this.sunIntensity = THREE.MathUtils.smoothstep(elD, -2, 6);
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
    const ty = Math.tan(camera.fov * DEG * 0.5) * 1.08;
    u.uTan.value.set(ty * camera.aspect, ty);
    // celestial sphere rotation (stars) follows the clock
    this._q.setFromAxisAngle(this._starAxis, this.hour / 24 * PI * 2 + 0.7);
    this._m4.makeRotationFromQuaternion(this._q); u.uStarMat.value.setFromMatrix4(this._m4);
    // volumetric clouds -> half-res target (composited by the dome)
    renderer.setRenderTarget(this.cloudRT); renderer.render(this.cloudScene, this.lutCam); renderer.setRenderTarget(null);
    // sun mesh follows the camera
    this.sunMesh.position.copy(camera.position).addScaledVector(this.sunDir, 1500);
    this.sunMesh.visible = this.sunDir.y > -0.08;
    scene.fog.color.copy(this.fogColor); scene.fog.density = this.fogDensity;
  }

  dispose() {
    for (const rt of [this.noiseRT, this.lutRT, this.cloudRT, this.shapeRT, this.detailRT]) rt?.dispose();
    this.material?.dispose(); this.cloudMat?.dispose(); this.lutMat?.dispose(); this.sunMat?.dispose();
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
  }
}
