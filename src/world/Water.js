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
 * API (stable):
 *   water.level                       y of the flat water plane (= terrain.waterLevel)
 *   water.isWater(x, z)               terrain below water level here?
 *   water.heightAt(x, z)              animated surface height (level + wave displacement), for splashes/buoyancy
 *   water.submergedDepth(pos) / (x, y, z)  meters below the surface (0 when dry)
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
uniform float uInvSize; uniform float uHeightOffset; uniform mat4 uReflMatrix; uniform float uHasReflect; uniform float uHasGrab; uniform vec2 uGrabSize;
uniform vec3 uSunDir; uniform vec3 uSunRad; uniform vec3 uMoonDir; uniform vec3 uMoonRad;
uniform vec3 uSkyColor; uniform vec3 uHorizonColor; uniform vec3 uAmbient; uniform vec3 uFogColor; uniform vec3 uFogParams; // density, near, far (near<far -> linear fog)
uniform float uTime; uniform float uCamBelow; uniform float uDetail; uniform float uRough; uniform float uDistort; uniform float uReflDistort;
uniform float uSpecMax; uniform float uSumAmp; uniform float uLevel; uniform vec3 uReflTint;
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

  // ---- refraction: framebuffer grab + per-channel absorption along the refracted path ----
  vec3 R = refract(-V, n, 0.75);
  float path = (uCamBelow > 0.5) ? max(uLevel - cameraPosition.y, 0.0) * 1.5 : d0 / max(0.12, -R.y);
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
  // tint that fallback toward the lake body — untinted, grazing Fresnel painted the whole midday far field a flat milky horizon sheet
  skyR = mix(skyR, skyR * (uShallow * 1.9 + 0.42), noRefl);
  float redge = smoothstep(0.0, 0.045, min(min(ruv.x, 1.0 - ruv.x), min(ruv.y, 1.0 - ruv.y)));
  vec3 refl = (uHasReflect > 0.5 && uCamBelow < 0.5) ? mix(skyR, texture2D(uReflect, clamp(ruv, 0.001, 0.999), rbias).rgb, redge) : ((uCamBelow > 0.5) ? scatter : skyR);
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

  // night water reads more mirror-like: lift the reflection weight so moon/aurora/star sky sits on the whole surface
  float Fr = min(F * (1.0 + uNight * 1.2) + uNight * 0.03, 1.0 - noRefl * 0.3);   // no real mirror -> never a full-Fresnel white sheet
  vec3 col = mix(refr, refl, Fr) + spec;
  col += uAmbient * uNight * (0.05 + 0.3 * pow(1.0 - NdotV, 3.0));   // ambient sheen: night lake never falls to featureless black
#ifdef WATER_HQ
  // star-glint twinkle everywhere at night (not just the moon azimuth): sparse product threshold of two scrolling height layers
  float star = smoothstep(0.86, 0.985, n3.a) * smoothstep(0.72, 0.95, n1.a);
  // flat magnitude: the old 1/(1+dist) falloff drew a bright blue disc centred on the player. Only fade far, where it aliases.
  col += vec3(0.6, 0.75, 1.0) * (star * star * uNight * 1.15 * hqNear);   // hqNear, not its own falloff: n3 stops being fetched at 130 m, so the twinkle has to be gone by then or it pops off
#endif

  // ---- shoreline foam: a pixel-crisp lace line hugging every contact isoline (fwidth-normalised width, noise-wobbled, breathing)
  //      + a couple of broken wash fronts creeping up the shelf + sparse crest lace. Never a blanket over the whole shelf ----
  float fp = n2.a * 0.6 + texture2D(uNormal, p * 0.07 + vec2(-0.02, 0.035) * t).b * 0.7;
  float iso = d0 + (fp - 0.62) * 0.07 + 0.035 * sin(t * 1.3 + fp * 9.0);      // wobbled + breathing contact isoline
  // band width = max(~6 screen px, 9 cm of depth), capped at 55 cm: a hairline at distance, a believable wash at your
  // feet, and never the whole shelf even where the bed is nearly flat
  float bandW = clamp(fwD * 6.0, 0.09, 0.55);
  float lace = texture2D(uNormal, p * 0.31 + vec2(0.05, -0.04) * t).b;
  float holes = 0.25 + 0.75 * smoothstep(0.12, 0.58, lace * 0.6 + fp * 0.4);  // lace texture: bright clumps + gaps, never fully solid
  float foam = (1.0 - smoothstep(0.0, bandW, iso)) * holes;                   // the contact lace (land side is clipped by the shore alpha)
  float arc = smoothstep(0.10, 0.03, abs(fract(iso * 2.2 + fp * 0.3 - t * 0.09) - 0.4) - 0.05);   // wash fronts sliding shoreward
  foam += arc * smoothstep(0.75, 0.15, iso) * smoothstep(0.5, 0.82, fp) * 0.5 * (1.0 - smoothstep(60.0, 170.0, dist));
  // sparse wave-crest lace in open water. 0.30/0.45 put a white cap on roughly a third of the lake at any
  // instant and read as soap suds from the shore; a lake this calm should only lace the sharpest crests.
  foam += smoothstep(0.62, 0.92, vCrest / uSumAmp) * smoothstep(0.62, 0.88, fp) * 0.16;
  foam = clamp(foam, 0.0, 1.0) * (1.0 - smoothstep(200.0, 480.0, dist)) * (1.0 - uCamBelow);
  vec3 foamCol = vec3(0.8) * (uSunRad * max(dot(vGN, uSunDir), 0.0) * 0.4 + uAmbient * 1.1 + uMoonRad * 0.35);
  col = mix(col, foamCol, foam);

  // ---- fog (matches three's FogExp2 / Fog on view depth) ----
  float fog = (uFogParams.z > uFogParams.y) ? smoothstep(uFogParams.y, uFogParams.z, vViewZ) : 1.0 - exp(-uFogParams.x * uFogParams.x * vViewZ * vViewZ);
  col = mix(col, uFogColor, fog);

  float alpha = smoothstep(0.0, 0.045, depth);                                  // knife-edge shore: water identity survives at 2 cm depth
  // no grab -> alpha-blend fallback: opacity from absorption, but Fresnel sheen + foam always survive (never a bare bed)
  float cover = clamp(1.0 - dot(T, vec3(0.3333)), 0.0, 1.0);
  alpha *= mix(clamp(cover + F * 2.5 + foam + 0.25, 0.0, 1.0) * 0.95, 1.0, uHasGrab);
  alpha = max(alpha, foam * smoothstep(0.0, 0.02, depth));                      // the contact lace survives the shore alpha ramp
  if (uCamBelow > 0.5) alpha = 0.85;
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
  isWater(x, z) { return this.game.terrain.heightAt(x, z) < this.level; }
  heightAt(x, z) {
    // matches the vertex shader's depth damping (waves die in the shallows) so splashes/buoyancy sit on the visible surface
    const bed = this.game.terrain.heightAt(x, z) - this.level;
    const f = Math.min(1, Math.max(0, (-bed - 0.05) / 1.15));
    const fade = f * f * (3 - 2 * f);
    let y = this.level; const t = this.time;
    if (fade > 0) for (let i = 0; i < 4; i++) { const w = WAVES[i]; y += fade * w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t); }
    return y;
  }
  submergedDepth(a, b, c) {
    const x = typeof a === 'object' ? a.x : a, y = typeof a === 'object' ? a.y : b, z = typeof a === 'object' ? a.z : c;
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
  init() {
    const { game } = this;
    this.level = game.terrain.waterLevel ?? 0;
    this.qp = QP[game.quality] ?? QP.high;
    this._bakeHeight();
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
      uDetail: { value: 0.36 }, uRough: { value: 0.075 }, uDistort: { value: 0.026 }, uReflDistort: { value: 0.026 }, uSpecMax: { value: 6.0 }, uReflTint: { value: new THREE.Color(0.94, 0.97, 1.0) },
      uShallow: { value: new THREE.Color(0.035, 0.27, 0.32) }, uDeep: { value: new THREE.Color(0.006, 0.038, 0.105) },
      uAbsorb: { value: new THREE.Vector3(1.25, 0.42, 0.19) }, uFoamDepth: { value: 0.22 }, uDebug: { value: 0 }, uNight: { value: 0 },
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
    for (let j = 0; j < R; j++) {
      const z = reuse ? j - R / 2 : -S / 2 + (j + 0.5) * S / R;
      for (let i = 0; i < R; i++) {
        const x = reuse ? i - R / 2 : -S / 2 + (i + 0.5) * S / R;
        const h = (reuse ? hg[j * R + i] : terrain.heightAt(x, z)) - L;
        data[j * R + i] = toH(Math.max(-60, Math.min(60, h)));
        if (h < 0.6) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
      }
    }
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

  _updateUniforms(camera) {
    const { sky, scene } = this.game, u = this.uniforms;
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
  // with the lake behind you. Proxy: Mirrormere's bounding sphere vs the camera frustum, or the
  // camera being over/near water. Costs a frustum build every few frames; saves both passes when
  // false. (perf audit 2026-08-20 lead #1)
  _waterOnScreen(camera) {
    const p = camera.position;
    if (this.isWater(p.x, p.z) || this.submergedDepth(p) > 0) return true;
    this._fr ??= new THREE.Frustum(); this._frM ??= new THREE.Matrix4(); this._lakeS ??= new THREE.Sphere(new THREE.Vector3(-170, this.level, -70), 115);
    this._frM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._fr.setFromProjectionMatrix(this._frM);
    return this._fr.intersectsSphere(this._lakeS);
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
