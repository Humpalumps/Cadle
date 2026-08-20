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
 *
 * How it works: a tiny sky-view LUT (256x128, half float) is ray-marched on the GPU (Rayleigh + Mie + ozone, planet shadow, fake multi-scatter,
 * art-directed twilight glow / belt of venus / civil-twilight dome / indigo night floor) whenever the sun moves; the dome shader just looks it up,
 * then layers per-pixel: sun disc+glare, moon (phase-lit, maria+craters), stars (clustered hash cells, pixel-crisp, halos on the brightest) +
 * milky way, aether aurora ribbons, fibrous cirrus, and a 2.5D stratified-jitter cumulus march. Cumulus columns use an f² height profile
 * (contour at height f is H>f², so smooth coverage peaks become flat-based hemispherical domes, not cones), worley-lump modulated tops,
 * rim-only erosion (opaque cores, crumbly cauliflower edges), 2-probe beer/powder self-shadow (white-gold lit tops vs dark bellies),
 * a forward-scatter silver-lining rim, low-freq macro coverage banks, and a distance dissolve so the layer melts into haze instead of
 * saturating into a wall at the shell tangent. Cloud noise is a one-time
 * GPU-baked tileable 512² RGBA texture (perlin fbm / perlin-worley / detail / cirrus). The same atmosphere model is ported to JS (few rays) to
 * produce the CPU-side colors (sky/horizon/fog/ambient/ground/sun) so Lighting/Water/Grass/fog match what the dome shows.
 */

const PI = Math.PI, DEG = PI / 180;
// --- atmosphere model (shared by the GLSL LUT and the JS port below; keep in sync) ---
const Rg = 6360e3, Rt = 6460e3, HR = 8000, HM = 1200;
const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6], BETA_MS = 2.6e-6, BETA_MA = 2.4e-6, BETA_O = [0.65e-6, 1.881e-6, 0.085e-6];
const SUN_E = 22.0;         // sun radiance scale (linear HDR, tuned for ACES @ exposure 1)
const MS = 0.22;            // fake multiple-scatter strength
const OBS_H = 150;          // observer altitude used by the model (player height changes nothing visible)

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

// ---------------- one-time tileable noise bake (512² RGBA8, mips): R perlin fbm, G perlin-worley, B detail fbm, A cirrus fbm ----------------
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

const QUAD_VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ---------------- the dome ----------------
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }`;

const DOME_FRAG = /* glsl */`
uniform sampler2D uLut, uNoise;
uniform vec3 uSunDir, uMoonDir, uSunDisc, uMoonCol, uFogColor, uCloudLightDir, uCloudLightCol, uCloudAmbTop, uCloudAmbBot, uMoonGlow, uBeltCol;
uniform float uTime, uCamY, uCloudCover, uCirrusCover, uHaze, uAurora, uSunEl, uStarVis, uWindT, uCloudH0, uCloudH1, uBelt, uPixAng;
uniform mat3 uStarMat;
varying vec3 vDir;
const float PI = 3.14159265;

vec3 lutSky(vec3 d) {
  vec2 sh = normalize(uSunDir.xz + vec2(1e-4, 0.0)), dh = normalize(d.xz + vec2(1e-4, 0.0));
  float az = acos(clamp(dot(sh, dh), -1.0, 1.0)) / PI;
  float el = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI));
  return texture2D(uLut, vec2(az, v)).rgb;
}
float hg(float mu, float g) { return (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5)); }
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

// ---- 2.5D cumulus slab: f² height profile turns coverage peaks into flat-based domes (not cones); lumpy tops from the worley channel ----
const float CURV_R = 2.5e5, CL_TILE = 12000.0;
float shell(vec3 d, float H) { float oc = uCamY + CURV_R; float b = oc * d.y; float c = oc * oc - (CURV_R + H) * (CURV_R + H); return -b + sqrt(max(b * b - c, 0.0)); }
float cloudTop(vec2 uv, float cov) {
  float s = texture2D(uNoise, uv).r;
  float H = clamp((s - (1.0 - cov)) / max(cov, 0.02), 0.0, 1.0);
  float lump = texture2D(uNoise, uv * 0.5 + 0.61 + uWindT * vec2(-0.0006, 0.0004)).g;
  return H * (0.72 + 0.42 * lump);
}
float colDens(vec2 uv, float f, float cov) { return smoothstep(f * f + 0.02, f * f + 0.17, cloudTop(uv, cov)) * smoothstep(1.0, 0.80, f); }
float cloudPhase(float mu) { return mix(hg(mu, -0.25), hg(mu, 0.72), 0.5) * 4.0 * PI; }

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
    vec3 mw = mix(vec3(0.22, 0.30, 0.62), vec3(0.44, 0.36, 0.72), mwn2) * band * (0.35 + 0.9 * mwn * mwn) * 0.20;
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
    col += aur * uAurora * 0.30 * northW * smoothstep(0.05, 0.20, d.y);   // keep curtains off the horizon (no white pleats between mountains)
  }

  float lmu = dot(d, uCloudLightDir);
  float phase = cloudPhase(lmu);

  // ---- cirrus veil (8 km): fibrous mares' tails sheared along a fixed wind axis, not radial smears ----
  if (d.y > 0.01) {
    float tc = shell(d, 8000.0);
    vec2 pc = (d * tc).xz;
    vec2 uvc = (pc + vec2(uWindT * 40.0, uWindT * 13.0)) / 46000.0;
    vec2 uvf = mat2(0.885, 0.466, -0.466, 0.885) * uvc;
    float cov = texture2D(uNoise, uvc * 0.8 + 0.13).a;
    float fib = texture2D(uNoise, uvf * vec2(0.9, 6.5)).a;
    float fib2 = texture2D(uNoise, uvf * vec2(1.8, 14.0) + 0.41).b;
    float cir = cov * 0.5 + fib * 0.32 + fib2 * 0.18;
    float ca = smoothstep(0.62 - uCirrusCover * 0.14, 0.88, cir);
    ca *= smoothstep(0.005, 0.11, d.y) * 0.34;
    vec3 cc = uCloudLightCol * (0.42 + 0.22 * phase + hg(lmu, 0.82) * 4.0 * PI * 0.16) + uCloudAmbTop * 0.55;
    float aerc = 1.0 - exp(-tc * 0.00001);
    cc = mix(cc, sky, aerc);
    col = mix(col, cc, ca * (1.0 - aerc * 0.6));
  }

  // ---- cumulus slab ----
  if (d.y > -0.10) {
    float t0 = shell(d, uCloudH0), t1 = shell(d, uCloudH1);
    vec2 wind = vec2(uWindT * 30.0, uWindT * 11.0);
    vec3 ld = uCloudLightDir; if (ld.y < 0.06) ld = normalize(vec3(ld.x, 0.06, ld.z));
    vec2 lOff = ld.xz * (520.0 / CL_TILE);
    float fL = ld.y * (520.0 / (uCloudH1 - uCloudH0));
    // pink underlighting for cloud bellies opposite a low sun (belt of venus light)
    vec2 sh = normalize(uSunDir.xz + vec2(1e-4, 0.0)), dh = normalize(d.xz + vec2(1e-4, 0.0));
    float anti = clamp(-dot(sh, dh), 0.0, 1.0);
    vec3 ambBot = mix(uCloudAmbBot, uBeltCol, uBelt * anti) * 0.52;
    // macro coverage banks (clear lanes / cloud streets): low-freq, one fetch mid-slab is enough
    vec2 uvM = ((d * (0.5 * (t0 + t1))).xz + wind) / CL_TILE;
    float macro = texture2D(uNoise, uvM * 0.14 + 0.37).a;
    float cov = clamp(uCloudCover * (0.55 + 0.95 * macro), 0.0, 1.0);
    // distance coverage taper: far clouds shrink and break up before the shell tangent can merge them into a wall
    cov *= exp(-max(t0 - 9000.0, 0.0) * 7e-5);
    // interleaved-gradient jitter (neighbor-correlated -> fine weave, not static) + per-step golden-ratio decorrelation
    float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float T = 1.0; vec3 acc = vec3(0.0);
    float sig = 28.0 / float(CLOUD_STEPS);
    float fwd = hg(lmu, 0.86) * 4.0 * PI;
    float phC = min(phase, 2.6);   // near-sun forward scatter capped for the body term (the rim term keeps full fwd) so backlit clouds keep structure
    for (int i = 0; i < CLOUD_STEPS; i++) {
      float f = (float(i) + fract(jit + float(i) * 0.618034)) / float(CLOUD_STEPS);
      float t = mix(t0, t1, f);
      vec2 uv = ((d * t).xz + wind) / CL_TILE;
      float f2 = f * f;
      float s = texture2D(uNoise, uv).r;
      float H = clamp((s - (1.0 - cov)) / max(cov, 0.02), 0.0, 1.0);
      if (H * 1.14 <= f2 + 0.02) continue;
      float lump = texture2D(uNoise, uv * 0.5 + 0.61 + uWindT * vec2(-0.0006, 0.0004)).g;
      H *= 0.72 + 0.42 * lump;
      float dn = smoothstep(f2 + 0.02, f2 + 0.17, H) * smoothstep(1.0, 0.80, f);
      if (dn <= 0.01) continue;
      // crumbly cauliflower rims: erode edges only (cores stay opaque); detail drifts vs base for slow morphing
      float det = texture2D(uNoise, uv * 1.9 + vec2(0.61, 0.43) + uWindT * vec2(0.0011, -0.0007)).g;
      float det2 = texture2D(uNoise, uv * 6.1 + vec2(0.13, 0.77)).b;
      float ero = (1.0 - det) * 0.55 + (0.5 - det2) * 0.22;
      dn = clamp((dn - ero * (1.0 - dn)) * 1.9, 0.0, 1.0);
      if (dn <= 0.012) continue;
      // self-shadow: 2 density probes along the light + depth under the local cloud top
      float dL1 = colDens(uv + lOff, f + fL, cov);
      float dL2 = colDens(uv + lOff * 2.2, f + fL * 2.2, cov);
      float depthTop = clamp((sqrt(H) - f) * 3.5, 0.0, 1.0);
      float tau = dL1 * 2.8 + dL2 * 1.8 + depthTop * 3.1 + dn * 0.5;
      float beer = exp(-tau) + 0.20 * exp(-tau * 0.20);          // multi-scatter floor
      float powder = 1.0 - 0.72 * exp(-dn * 5.0);
      // silver lining: unoccluded rims facing the sun catch strong forward scatter
      vec3 lit = uCloudLightCol * (beer * powder * phC * 1.25 + exp(-(dL1 * 3.0 + dn * 1.2)) * fwd * 0.22);
      float topness = exp(-depthTop * 1.8);
      vec3 amb = mix(ambBot * (0.90 + 0.20 * det), uCloudAmbTop * (1.45 + 0.35 * det2), topness * (0.35 + 0.65 * det));
      vec3 c = lit + amb;
      float a = 1.0 - exp(-pow(dn, 1.2) * sig);                  // opaque cores, soft rims
      float aer = 1.0 - exp(-t * 0.00005);                       // far clouds take on the haze color
      c = mix(c, sky, aer);
      acc += T * a * c; T *= 1.0 - a;
      if (T < 0.02) break;
    }
    // per-pixel distance dissolve: the whole slab contribution fades before the shell-tangent wall can saturate
    float hzc = smoothstep(-0.01, 0.10, d.y) * exp(-max(t0 - 8000.0, 0.0) * 5e-5);
    col = col * (1.0 - (1.0 - T) * hzc) + acc * hzc;
  }

  // ---- horizon haze (tinted by the actual sky at that azimuth: amber toward a low sun, cool away) & ground ----
  float hz = exp(-max(d.y, 0.0) * 11.0) * uHaze;
  vec3 hcol = mix(fogCol, lutSky(normalize(vec3(d.x, abs(d.y) + 0.05, d.z))), 0.60) * 0.94;
  col = mix(col, hcol, hz * smoothstep(-0.1, 0.02, d.y));
  col = mix(col, fogCol * (1.0 - 0.28 * smoothstep(0.0, -0.32, d.y)), smoothstep(0.012, -0.03, d.y));
  // soft shoulder (keeps hue/saturation of bright haze & cloud highlights under ACES), then the HDR sun disc for bloom/god rays
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (lum > 1.15) col *= (1.15 + (lum - 1.15) / (1.0 + (lum - 1.15) * 0.55)) / lum;   // gentle: preserves lit-top vs belly contrast (ACES finishes the roll-off)
  col += sunDisc * disc * limb * 60.0 * sunUp;
  gl_FragColor = vec4(col, 1.0);
}`;

// GLSL-identical smoothstep (works with reversed edges, like the shader uses)
function sstep(e0, e1, x) { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }

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
    this._dirty = true; this._lastSunEl = 99; this._lastCover = null;
    this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._c = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
    this._od = [0, 0, 0];
  }

  init() {
    const { scene, renderer, quality } = this.game;
    scene.background = null;
    scene.fog = new THREE.FogExp2(this.fogColor.getHex(), this.fogDensity);

    // --- noise bake (GPU, once) ---
    this.noiseRT = new THREE.WebGLRenderTarget(512, 512, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, stencilBuffer: false });
    this.noiseRT.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const nScene = new THREE.Scene();
    nScene.add(new THREE.Mesh(quadGeo, new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: NOISE_FRAG, uniforms: { uSeed: { value: (this.game.seed % 997) * 0.013 } }, depthTest: false, depthWrite: false })));
    renderer.setRenderTarget(this.noiseRT); renderer.render(nScene, quadCam); renderer.setRenderTarget(null);

    // --- sky-view LUT ---
    this.lutRT = new THREE.WebGLRenderTarget(256, 128, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    this.lutMat = new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: LUT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { uSunDir: { value: this.sunDir }, uSunE: { value: SUN_E }, uMs: { value: MS }, uObsH: { value: OBS_H }, uSunEl: { value: 0.5 } } });
    this.lutScene = new THREE.Scene(); this.lutScene.add(new THREE.Mesh(quadGeo, this.lutMat)); this.lutCam = quadCam;

    // --- dome ---
    const steps = { low: 6, medium: 12, high: 20, ultra: 26 }[quality] ?? 20;
    this.uniforms = {
      uLut: { value: this.lutRT.texture }, uNoise: { value: this.noiseRT.texture },
      uSunDir: { value: this.sunDir }, uMoonDir: { value: this.moonDir }, uSunDisc: { value: this.sunDiscColor }, uMoonCol: { value: new THREE.Color() }, uMoonGlow: { value: new THREE.Color() },
      uFogColor: { value: this.fogColor }, uCloudLightDir: { value: new THREE.Vector3(0, 1, 0) }, uCloudLightCol: { value: new THREE.Color() },
      uCloudAmbTop: { value: new THREE.Color() }, uCloudAmbBot: { value: new THREE.Color() }, uBeltCol: { value: new THREE.Color() },
      uTime: { value: 0 }, uWindT: { value: 0 }, uCamY: { value: 0 }, uCloudCover: { value: 0.5 }, uCirrusCover: { value: 0.5 }, uHaze: { value: 0.3 }, uAurora: { value: 0 },
      uSunEl: { value: 0.5 }, uStarVis: { value: 0 }, uStarMat: { value: new THREE.Matrix3() },
      uCloudH0: { value: 1500 }, uCloudH1: { value: 2900 }, uBelt: { value: 0 }, uPixAng: { value: 0.001 },
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: this.uniforms, defines: { CLOUD_STEPS: steps }, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false });
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
    this.setHour(this.hour);
    this._refreshColors();
  }

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
    u.uCamY.value = Math.max(0, camera.position.y);
    u.uSunEl.value = this.sunElevation;
    u.uPixAng.value = (camera.fov * DEG) / (renderer.domElement.height || 1080);   // angular size of one pixel (star cores)
    // celestial sphere rotation (stars) follows the clock
    this._q.setFromAxisAngle(this._starAxis, this.hour / 24 * PI * 2 + 0.7);
    this._m4.makeRotationFromQuaternion(this._q); u.uStarMat.value.setFromMatrix4(this._m4);
    // sun mesh follows the camera
    this.sunMesh.position.copy(camera.position).addScaledVector(this.sunDir, 1500);
    this.sunMesh.visible = this.sunDir.y > -0.08;
    scene.fog.color.copy(this.fogColor); scene.fog.density = this.fogDensity;
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
    const sunCloud = c0.setRGB(tmp[0], tmp[1] * 0.98, tmp[2] * 0.95).multiplyScalar(2.2 * sunUp);
    const useMoon = sunCloud.r + sunCloud.g + sunCloud.b < 0.03;
    if (useMoon) { uc.uCloudLightDir.value.copy(this.moonDir); uc.uCloudLightCol.value.copy(this.moonColor).multiplyScalar(0.9); }
    else { uc.uCloudLightDir.value.copy(this.sunDir); uc.uCloudLightCol.value.copy(sunCloud); }
    uc.uCloudAmbTop.value.copy(this.ambientColor).multiplyScalar(1.0);
    this._radiance(0, 3 * DEG, tmp);                                   // horizon toward the sun: dusk/dawn glow lights cloud bellies
    const gl = THREE.MathUtils.clamp(1.2 - Math.abs(elD + 4) / 9, 0, 1);
    uc.uCloudAmbBot.value.setRGB(this.fogColor.r * 0.38 + tmp[0] * 0.20 * gl + this.ambientColor.r * 0.10, this.fogColor.g * 0.38 + tmp[1] * 0.20 * gl + this.ambientColor.g * 0.10, this.fogColor.b * 0.38 + tmp[2] * 0.20 * gl + this.ambientColor.b * 0.10);
    // belt-of-venus pink underlight on anti-solar cloud bellies at golden hour/dusk
    const beltW = sstep(-0.30, -0.10, el) * (1 - sstep(-0.04, 0.14, el));
    uc.uBelt.value = THREE.MathUtils.clamp((1 - sstep(-0.04, 0.14, el)) * sstep(-0.30, 0.02, el), 0, 1);
    uc.uBeltCol.value.setRGB(0.50, 0.24, 0.28).multiplyScalar(0.35 + 0.65 * Math.max(beltW, uc.uBelt.value));
    const h = this.hour;
    const autoCover = 0.60 + 0.08 * Math.exp(-((h - 6.5) ** 2) / 3.0) + 0.10 * Math.exp(-((h - 17.8) ** 2) / 3.2) - 0.03 * Math.exp(-((h - 12.5) ** 2) / 6.0) - 0.10 * nf;
    uc.uCloudCover.value = this.cloudCover ?? autoCover;
    uc.uCirrusCover.value = 0.45 + 0.25 * Math.exp(-((h - 17) ** 2) / 6.0);
    // mild towering at golden hour / dawn (kept short: a tall slab extrudes the columns into teeth)
    const goldT = Math.exp(-((h - 17.7) ** 2) / 2.5) + 0.6 * Math.exp(-((h - 6.4) ** 2) / 2.5);
    uc.uCloudH0.value = 1500 - 150 * goldT;
    uc.uCloudH1.value = 2900 + 500 * goldT;
    uc.uHaze.value = 0.16 + 0.18 * dawn + 0.07 * golden + 0.10 * nf;
    uc.uStarVis.value = 1 - THREE.MathUtils.smoothstep(elD, -14, -8);   // stars only after civil twilight (~-8°), full by -14°
    uc.uAurora.value = (1 - THREE.MathUtils.smoothstep(elD, -14, -7)) * 1.0;
  }
}
