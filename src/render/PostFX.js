import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, ClearPass, ShaderPass, Pass, Effect, EffectAttribute, BlendFunction,
  BloomEffect, SMAAEffect, SMAAPreset, EdgeDetectionMode, PredicationMode, ToneMappingEffect, ToneMappingMode,
  VignetteEffect, GodRaysEffect, ChromaticAberrationEffect, KawaseBlurPass, KernelSize,
  LuminancePass, AdaptiveLuminancePass,
} from 'postprocessing';

/**
 * PostFX: the post-processing pipeline. Owns the composer and renders each frame.
 * Pipeline (HDR half-float): world RenderPass -> AO (depth-only GTAO-ish, half res, bilateral blur, depth-aware upsample)
 *   -> [sky de-stipple (day-only 8-tap far-field average: hides the sky shader's static dither) + god rays]
 *      (GodRaysEffect, blurred light buffer; light source = internal warm disc 260 m out along game.sky.sunDir so the
 *      mountain ring can't fully swallow golden hour; near occluders (trees/hills) carve shafts; off below horizon)
 *   -> DoF (ADS, off by default) -> [overlay: ClearPass(depth) + RenderPass(overlayScene, overlayCamera) for the first-person viewmodel]
 *   -> final: auto-exposure (GPU 1x1 adapted scene luminance, bounded) + chromatic aberration (kick) + bloom (threshold rides
 *      time-of-day so night emissives glow) + tone map (ACES, time-of-day exposure) + FF14 grade (sun-elevation-keyed warm
 *      gain / cool lift / saturation; dusk keyed deep so the warm horizon survives) + grain + flash + vignette
 *   -> SMAA (HIGH) -> TAA (subpixel-jittered temporal resolve, depth reprojection + neighborhood clamp; kills foliage shimmer).
 * API (stable):
 *   postfx.render(dt), postfx.resize(w,h)
 *   postfx.setOverlay(scene, camera)          viewmodel overlay; camera aspect kept in sync on resize. Weapons calls this.
 *   postfx.flash(color, strength, duration)   full-screen tint kick (damage taken, super pop); edge-weighted so the center stays readable
 *   postfx.kick(strength)                     chromatic aberration pulse (explosions, big hits)
 *   postfx.setDof({ focus, range, strength, enabled })  used when ADS with sniper etc (optional, cheap half-res blur by CoC, ~0.2 ms)
 *   postfx.exposure (number, base; time-of-day + bounded scene-luminance adaptation on top), .bloom, .vignette, .ao, .godrays, .grade, .tone, .taa handles
 *   postfx.setBypass(bool)                    world+overlay only (perf A/B), postfx.setQuality('low'|'medium'|'high'|'ultra')
 *   postfx.profile(frames) -> Promise<{on,off,cost}>  GPU ms of the whole post chain (timer queries, alternates bypass per frame)
 *   postfx.readLum() -> Promise<number>       adapted average scene luminance (pre-exposure; debug/calibration)
 *   postfx.godraysSource (Object3D|null)     override the god-rays light source (e.g. game.sky.sunMesh); null = internal disc
 * Quality: low = no AO / god rays / DoF / TAA, SMAA medium. Budget @1080p q=high on RTX 3060: <= 1.3 ms with sun on screen.
 */

const QUALITY = {
  low:    { ao: false, aoSamples: 0,  godrays: false, godraysScale: 0.4,  dof: false, taa: false, smaa: SMAAPreset.MEDIUM },
  medium: { ao: true,  aoSamples: 8,  godrays: true,  godraysScale: 0.4,  dof: true,  taa: true,  smaa: SMAAPreset.HIGH },
  high:   { ao: true,  aoSamples: 10, godrays: true,  godraysScale: 0.4,  dof: true,  taa: true,  smaa: SMAAPreset.HIGH },
  ultra:  { ao: true,  aoSamples: 16, godrays: true,  godraysScale: 0.55, dof: true,  taa: true,  smaa: SMAAPreset.ULTRA },
};

const FS_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

// ---- AO: depth-only ambient occlusion (SAO-style spiral taps, normals reconstructed from depth), half res, bilateral blur, depth-aware upsample.
const AO_FRAG = /* glsl */`
#include <common>
#include <packing>
uniform highp sampler2D depthBuffer;
uniform vec2 texelSize; uniform vec2 cameraNearFar; uniform mat4 projectionMatrix; uniform mat4 inverseProjectionMatrix;
uniform float radius; uniform float intensity; uniform float bias; uniform float fadeDist; uniform float projScale;
varying vec2 vUv;
float rd(vec2 uv){ return texture2D(depthBuffer, uv).r; }
vec3 vp(vec2 uv, float d){ float z = perspectiveDepthToViewZ(d, cameraNearFar.x, cameraNearFar.y); vec4 c = vec4(vec3(uv, d) * 2.0 - 1.0, 1.0); c *= projectionMatrix[2][3] * z + projectionMatrix[3][3]; return (inverseProjectionMatrix * c).xyz; }
void main(){
  float d = rd(vUv);
  vec3 P = vp(vUv, d); float dist = -P.z;
  if (d >= 1.0 || dist > fadeDist) { gl_FragColor = vec4(1.0, dist, 0.0, 1.0); return; }
  vec2 tx = vec2(texelSize.x, 0.0), ty = vec2(0.0, texelSize.y);
  vec3 Pl = vp(vUv - tx, rd(vUv - tx)), Pr = vp(vUv + tx, rd(vUv + tx)), Pd = vp(vUv - ty, rd(vUv - ty)), Pu = vp(vUv + ty, rd(vUv + ty));
  vec3 dx = abs(Pl.z - P.z) < abs(Pr.z - P.z) ? P - Pl : Pr - P;   // pick the neighbour on our side of a depth edge
  vec3 dy = abs(Pd.z - P.z) < abs(Pu.z - P.z) ? P - Pd : Pu - P;
  vec3 N = normalize(cross(dx, dy));
  float rPx = clamp(radius * projScale / dist, 2.0, 20.0);          // low max reach: thin near geometry (grass) can't smear wide halos
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); // interleaved gradient noise: static per pixel = no temporal crawl
  float a0 = noise * 6.2831853, R2 = radius * radius, occ = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float a = (float(i) + 0.5) / float(SAMPLES);
    float ang = a * 6.2831853 * 3.0 + a0;
    vec2 uv2 = vUv + vec2(cos(ang), sin(ang)) * (a * rPx) * texelSize;
    vec3 v = vp(uv2, rd(uv2)) - P;
    float vv = dot(v, v), vn = dot(v, N) - bias * dist;
    float f = max(R2 - vv, 0.0) / R2;
    float thin = 1.0 - smoothstep(radius * 0.35, radius * 0.9, v.z);  // occluder floating well in front (grass blade over stone): reject
    occ += f * f * f * max(vn, 0.0) / (0.03 + vv) * thin;
  }
  float ao = clamp(1.0 - occ * intensity / float(SAMPLES), 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(fadeDist * 0.5, fadeDist, dist));
  gl_FragColor = vec4(ao, dist, 0.0, 1.0);
}`;
const AO_BLUR_FRAG = /* glsl */`
uniform sampler2D inputBuffer; uniform vec2 dir; varying vec2 vUv;
void main(){
  vec2 c = texture2D(inputBuffer, vUv).rg; float sum = c.r, wsum = 1.0, tol = 0.015 * c.g + 0.02;
  for (int i = 1; i <= 3; i++) { float fi = float(i); float g = exp(-fi * fi * 0.18);
    vec2 a = texture2D(inputBuffer, vUv + dir * fi).rg, b = texture2D(inputBuffer, vUv - dir * fi).rg;
    float wa = g * max(0.0, 1.0 - abs(a.g - c.g) / tol), wb = g * max(0.0, 1.0 - abs(b.g - c.g) / tol);
    sum += a.r * wa + b.r * wb; wsum += wa + wb; }
  gl_FragColor = vec4(sum / wsum, c.g, 0.0, 1.0);
}`;
const AO_COMP_FRAG = /* glsl */`
uniform sampler2D aoBuffer; uniform vec2 aoTexel;
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor){
  float z = -getViewZ(depth);   // depth-aware upsample: weight the 4 half-res texels by view-depth similarity
  vec2 p = uv / aoTexel - 0.5, f = fract(p), b = (floor(p) + 0.5) * aoTexel;
  vec2 s00 = texture2D(aoBuffer, b).rg, s10 = texture2D(aoBuffer, b + vec2(aoTexel.x, 0.0)).rg, s01 = texture2D(aoBuffer, b + vec2(0.0, aoTexel.y)).rg, s11 = texture2D(aoBuffer, b + aoTexel).rg;
  float tol = 0.05 * z + 0.05;
  float w00 = (1.0 - f.x) * (1.0 - f.y) * max(0.02, 1.0 - abs(s00.g - z) / tol), w10 = f.x * (1.0 - f.y) * max(0.02, 1.0 - abs(s10.g - z) / tol);
  float w01 = (1.0 - f.x) * f.y * max(0.02, 1.0 - abs(s01.g - z) / tol), w11 = f.x * f.y * max(0.02, 1.0 - abs(s11.g - z) / tol);
  float ao = (s00.r * w00 + s10.r * w10 + s01.r * w01 + s11.r * w11) / (w00 + w10 + w01 + w11);
  outputColor = vec4(vec3(ao), inputColor.a);
}`;

class AOEffect extends Effect {
  constructor(camera, { samples = 10, radius = 0.8, intensity = 2.3, bias = 0.002, fadeDist = 120, resolutionScale = 0.5 } = {}) {
    super('AOEffect', AO_COMP_FRAG, { blendFunction: BlendFunction.MULTIPLY, attributes: EffectAttribute.DEPTH,
      uniforms: new Map([['aoBuffer', new THREE.Uniform(null)], ['aoTexel', new THREE.Uniform(new THREE.Vector2(1, 1))]]) });
    this.camera = camera; this.scale = resolutionScale;
    const mk = () => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, format: THREE.RGFormat, type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.rtA = mk(); this.rtB = mk();
    this.aoMat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: AO_FRAG, defines: { SAMPLES: samples }, depthTest: false, depthWrite: false,
      uniforms: { depthBuffer: { value: null }, texelSize: { value: new THREE.Vector2() }, cameraNearFar: { value: new THREE.Vector2(camera.near, camera.far) },
        projectionMatrix: { value: camera.projectionMatrix }, inverseProjectionMatrix: { value: camera.projectionMatrixInverse },
        radius: { value: radius }, intensity: { value: intensity }, bias: { value: bias }, fadeDist: { value: fadeDist }, projScale: { value: 1 } } });
    this.blurMat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: AO_BLUR_FRAG, depthTest: false, depthWrite: false, uniforms: { inputBuffer: { value: null }, dir: { value: new THREE.Vector2() } } });
    this.aoPass = new ShaderPass(this.aoMat, 'depthBuffer'); this.blurPass = new ShaderPass(this.blurMat);
    this.uniforms.get('aoBuffer').value = this.rtA.texture;
    this._depth = null;
  }
  get radius() { return this.aoMat.uniforms.radius.value; } set radius(v) { this.aoMat.uniforms.radius.value = v; }
  get intensity() { return this.aoMat.uniforms.intensity.value; } set intensity(v) { this.aoMat.uniforms.intensity.value = v; }
  set samples(n) { this.aoMat.defines.SAMPLES = n; this.aoMat.needsUpdate = true; }
  setDepthTexture(t) { this._depth = t; this.aoMat.uniforms.depthBuffer.value = t; }
  setSize(w, h) {
    const sw = Math.max(1, Math.round(w * this.scale)), sh = Math.max(1, Math.round(h * this.scale));
    this.rtA.setSize(sw, sh); this.rtB.setSize(sw, sh);
    this.aoMat.uniforms.texelSize.value.set(1 / sw, 1 / sh); this.uniforms.get('aoTexel').value.set(1 / sw, 1 / sh);
    this._sh = sh;
  }
  update(renderer) {
    const c = this.camera, u = this.aoMat.uniforms;
    u.cameraNearFar.value.set(c.near, c.far); u.projScale.value = 0.5 * c.projectionMatrix.elements[5] * this._sh;
    // ShaderPass sets uniform 'depthBuffer' from inputBuffer.texture; we pass a fake buffer wrapping the stable depth texture.
    this._fake ??= { texture: null }; this._fake.texture = this._depth;
    this.aoPass.render(renderer, this._fake, this.rtA);
    this.blurMat.uniforms.dir.value.set(u.texelSize.value.x, 0); this.blurPass.render(renderer, this.rtA, this.rtB);
    this.blurMat.uniforms.dir.value.set(0, u.texelSize.value.y); this.blurPass.render(renderer, this.rtB, this.rtA);
  }
}

// ---- Sky de-stipple: the sky/cloud shader dithers with static per-pixel noise (IGN) that reads as a fabric weave in the
//      bright golden-hour plumes (and TAA can't average static noise). 8-tap average restricted to sky pixels (depth == 1,
//      dome has depthWrite off) so geometry never bleeds; day-gated so night stars stay pixel-crisp. ~0.1 ms.
const SKY_SMOOTH_FRAG = /* glsl */`
uniform float amt;
#define SKY_TAP(o) { vec2 uv2 = uv + (o); float w = step(0.999999, readDepth(uv2)); sum += texture2D(inputBuffer, uv2).rgb * w; wsum += w; }
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor){
  if (amt <= 0.0 || depth < 0.999999) { outputColor = inputColor; return; }
  vec3 sum = inputColor.rgb; float wsum = 1.0;
  vec2 t = texelSize * 2.0, s = texelSize * 1.4;
  SKY_TAP(vec2(t.x, 0.0)) SKY_TAP(vec2(-t.x, 0.0)) SKY_TAP(vec2(0.0, t.y)) SKY_TAP(vec2(0.0, -t.y))
  SKY_TAP(vec2(s.x, s.y)) SKY_TAP(vec2(-s.x, s.y)) SKY_TAP(vec2(s.x, -s.y)) SKY_TAP(vec2(-s.x, -s.y))
  outputColor = vec4(mix(inputColor.rgb, sum / wsum, amt), inputColor.a);
}`;
class SkySmoothEffect extends Effect {
  constructor() {
    super('SkySmoothEffect', SKY_SMOOTH_FRAG, { blendFunction: BlendFunction.SRC, attributes: EffectAttribute.DEPTH,
      uniforms: new Map([['amt', new THREE.Uniform(1)]]) });
  }
  get amt() { return this.uniforms.get('amt').value; } set amt(v) { this.uniforms.get('amt').value = v; }
}

// ---- Auto exposure: GPU scene-luminance (128^2 luminance -> mips -> 1x1 temporally adapted), bounded factor applied pre-tone-map.
//      Measures PRE-exposure luminance so there is no feedback loop; the time-of-day exposure stays the base.
const AE_FRAG = /* glsl */`
uniform lowp sampler2D lumBuffer; uniform vec3 aeParams; // target, min, max
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  float la = unpackRGBAToFloat(texture2D(lumBuffer, vec2(0.5)));
  float f = clamp(aeParams.x / max(la, 1e-3), aeParams.y, aeParams.z);
  outputColor = vec4(inputColor.rgb * f, inputColor.a);
}`;
class AutoExposureEffect extends Effect {
  constructor({ target = 0.3, min = 0.8, max = 1.3, tau = 1.6 } = {}) {
    super('AutoExposureEffect', AE_FRAG, { blendFunction: BlendFunction.SRC,
      uniforms: new Map([['lumBuffer', new THREE.Uniform(null)], ['aeParams', new THREE.Uniform(new THREE.Vector3(target, min, max))]]) });
    const size = 128, exp = Math.log2(size);
    this.rtLum = new THREE.WebGLRenderTarget(size, size, { minFilter: THREE.LinearMipmapLinearFilter, depthBuffer: false });
    this.rtLum.texture.generateMipmaps = true;
    this.lumPass = new LuminancePass({ renderTarget: this.rtLum });
    this.lumPass.resolution.setPreferredSize(size, size);
    this.adaptPass = new AdaptiveLuminancePass(this.lumPass.texture, { minLuminance: 0.004, adaptationRate: tau });
    this.adaptPass.fullscreenMaterial.mipLevel1x1 = exp;
    this.uniforms.get('lumBuffer').value = this.adaptPass.texture;
  }
  get params() { return this.uniforms.get('aeParams').value; }
  initialize(renderer, alpha, frameBufferType) { this.lumPass.initialize(renderer, alpha, frameBufferType); this.adaptPass.initialize(renderer, alpha, frameBufferType); }
  update(renderer, inputBuffer, deltaTime) { this.lumPass.render(renderer, inputBuffer); this.adaptPass.render(renderer, null, null, deltaTime); }
}

// ---- Grade: FF14 painterly curves (lift/gain/contrast/saturation driven per-frame from sun elevation: warm golden-hour gain,
//      cool blue-violet dusk/night lift) + film grain + edge-weighted flash tint. Runs after tone mapping.
const GRADE_FRAG = /* glsl */`
uniform vec3 lift; uniform vec3 gain; uniform float contrast; uniform float saturation; uniform float grain; uniform vec3 flashColor; uniform float flashAmt;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  vec3 c = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));        // grade in display-ish space
  c = c * gain + lift * (1.0 - c);                                  // lift shadows (cool), gain highlights (warm)
  c = mix(c, c * c * (3.0 - 2.0 * c), contrast);                    // filmic S-curve
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  float edge = smoothstep(0.12, 0.62, distance(uv, vec2(0.5)));     // Destiny-style damage flash: strong at the rim, center stays readable
  c = mix(c, flashColor, flashAmt * mix(0.35, 1.0, edge));
  float n = fract(sin(dot(floor(uv * resolution) + mod(time * 60.0, 97.0) * vec2(7.13, 3.71), vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) * grain * (1.0 - 0.7 * l);                         // grain, weaker in highlights
  outputColor = vec4(pow(max(c, 0.0), vec3(2.2)), inputColor.a);
}`;
class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, { blendFunction: BlendFunction.SRC, uniforms: new Map([
      ['lift', new THREE.Uniform(new THREE.Vector3(0.015, 0.02, 0.038))], ['gain', new THREE.Uniform(new THREE.Vector3(1.0, 0.99, 0.955))],
      ['contrast', new THREE.Uniform(0.3)], ['saturation', new THREE.Uniform(1.1)], ['grain', new THREE.Uniform(0.05)],
      ['flashColor', new THREE.Uniform(new THREE.Color(1, 1, 1))], ['flashAmt', new THREE.Uniform(0)]]) });
  }
  get lift() { return this.uniforms.get('lift').value; } get gain() { return this.uniforms.get('gain').value; }
  get contrast() { return this.uniforms.get('contrast').value; } set contrast(v) { this.uniforms.get('contrast').value = v; }
  get saturation() { return this.uniforms.get('saturation').value; } set saturation(v) { this.uniforms.get('saturation').value = v; }
  get grain() { return this.uniforms.get('grain').value; } set grain(v) { this.uniforms.get('grain').value = v; }
}

// ---- Cheap DoF (ADS): one half-res Kawase blur of the frame, mixed in by a depth CoC. ponytail: no near-field bleed handling, upgrade to postprocessing DepthOfFieldEffect (+0.8 ms) if a sniper scope wants bokeh.
const DOF_FRAG = /* glsl */`
uniform sampler2D blurBuffer; uniform vec3 dof; // focus distance, range, strength
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor){
  float coc = smoothstep(0.0, 1.0, abs(-getViewZ(depth) - dof.x) / dof.y) * dof.z;
  outputColor = mix(inputColor, texture2D(blurBuffer, uv), coc);
}`;
class CheapDofEffect extends Effect {
  constructor({ focus = 25, range = 40, strength = 1 } = {}) {
    super('CheapDofEffect', DOF_FRAG, { blendFunction: BlendFunction.SRC, attributes: EffectAttribute.DEPTH,
      uniforms: new Map([['blurBuffer', new THREE.Uniform(null)], ['dof', new THREE.Uniform(new THREE.Vector3(focus, range, strength))]]) });
    this.blurPass = new KawaseBlurPass({ kernelSize: KernelSize.MEDIUM, resolutionScale: 0.5 });
    this.rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
    this.uniforms.get('blurBuffer').value = this.rt.texture;
  }
  get params() { return this.uniforms.get('dof').value; }
  initialize(renderer, alpha, frameBufferType) { this.blurPass.initialize(renderer, alpha, frameBufferType); }
  setSize(w, h) { this.blurPass.setSize(w, h); this.rt.setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2))); }
  update(renderer, inputBuffer) { this.blurPass.render(renderer, inputBuffer, this.rt); }
}

// ---- TAA: subpixel camera jitter (halton 8) + depth reprojection of a full-res history + 5-tap neighborhood clamp.
//      Velocity-less (camera motion only); moving objects are rescued by the clamp. Runs LAST (post-SMAA, LDR domain).
const TAA_FRAG = /* glsl */`
uniform sampler2D inputBuffer; uniform sampler2D historyBuffer; uniform highp sampler2D depthBuffer;
uniform mat4 reproj; uniform vec2 texelSize; uniform float blend;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(inputBuffer, vUv).rgb;
  float d = texture2D(depthBuffer, vUv).r;
  vec4 pc = reproj * vec4(vec3(vUv, d) * 2.0 - 1.0, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  vec3 n1 = texture2D(inputBuffer, vUv + vec2(texelSize.x, 0.0)).rgb, n2 = texture2D(inputBuffer, vUv - vec2(texelSize.x, 0.0)).rgb;
  vec3 n3 = texture2D(inputBuffer, vUv + vec2(0.0, texelSize.y)).rgb, n4 = texture2D(inputBuffer, vUv - vec2(0.0, texelSize.y)).rgb;
  vec3 mn = min(c, min(min(n1, n2), min(n3, n4))), mx = max(c, max(max(n1, n2), max(n3, n4)));
  vec3 h = clamp(texture2D(historyBuffer, puv).rgb, mn, mx);
  float a = (puv != clamp(puv, 0.0, 1.0)) ? 1.0 : blend;
  gl_FragColor = vec4(mix(h, c, a), 1.0);
}`;
const BLIT_FRAG = /* glsl */`
uniform sampler2D inputBuffer; varying vec2 vUv;
void main(){ gl_FragColor = texture2D(inputBuffer, vUv);
#include <colorspace_fragment>
}`;
class TAAPass extends Pass {
  constructor() {
    super('TAAPass');
    this.needsSwap = false; this.needsDepthTexture = true;
    this.mat = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: TAA_FRAG, depthTest: false, depthWrite: false,
      uniforms: { inputBuffer: { value: null }, historyBuffer: { value: null }, depthBuffer: { value: null },
        reproj: { value: new THREE.Matrix4() }, texelSize: { value: new THREE.Vector2() }, blend: { value: 0.13 } } });
    this.resolvePass = new ShaderPass(this.mat, 'inputBuffer');
    this.blitPass = new ShaderPass(new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: BLIT_FRAG, depthTest: false, depthWrite: false, uniforms: { inputBuffer: { value: null } } }), 'inputBuffer');
    const mk = () => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rtRead = mk(); this.rtWrite = mk();
    this.reset = 2; this._w = 1; this._h = 1;
  }
  setDepthTexture(t) { this.mat.uniforms.depthBuffer.value = t; }
  initialize(renderer, alpha, frameBufferType) { this.resolvePass.initialize(renderer, alpha, frameBufferType); this.blitPass.initialize(renderer, alpha, frameBufferType); }
  setSize(w, h) { this._w = w; this._h = h; this.rtRead.setSize(w, h); this.rtWrite.setSize(w, h); this.mat.uniforms.texelSize.value.set(1 / w, 1 / h); this.reset = 2; }
  render(renderer, inputBuffer, outputBuffer) {
    const u = this.mat.uniforms;
    u.historyBuffer.value = this.rtRead.texture;
    u.blend.value = this.reset > 0 ? 1 : 0.13; if (this.reset > 0) this.reset--;
    this.resolvePass.render(renderer, inputBuffer, this.rtWrite);
    this.blitPass.renderToScreen = this.renderToScreen;
    this.blitPass.render(renderer, this.rtWrite, outputBuffer);
    const t = this.rtRead; this.rtRead = this.rtWrite; this.rtWrite = t;
  }
}
// halton(2,3) - 0.5, 8 points (pixels)
const JITTER = [[0, -0.167], [-0.25, 0.167], [0.25, -0.389], [-0.375, -0.056], [0.125, 0.278], [-0.125, -0.278], [0.375, 0.056], [-0.4375, 0.389]];

const { smoothstep, lerp, clamp } = THREE.MathUtils;
const WARM = new THREE.Color(1.0, 0.85, 0.6), DEEP_WARM = new THREE.Color(1.0, 0.58, 0.26);

export class PostFX {
  constructor(game) {
    this.game = game; this.overlay = null; this.overlayPass = null;
    this.exposure = 0.9; this.nightExposure = 1.4; this.bypass = false;
    this.bloomNightTh = 0.28; this.bloomDayTh = 1.05; // bloom luminance thresholds (tunable; _tick lerps by sun elevation)
    this._exp = 1; this._flash = { color: new THREE.Color(), strength: 0, t: 0, dur: 0.3 }; this._kick = 0;
    this._dof = { enabled: false, focus: 25, range: 40, strength: 1 };
  }
  init() {
    const { renderer, scene, camera } = this.game;
    this.q = QUALITY[this.game.quality] ?? QUALITY.high;
    renderer.toneMapping = THREE.NoToneMapping; // tone map in the composer (HDR half-float chain)
    renderer.toneMappingExposure = 1;
    const composer = this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    composer.autoRenderToScreen = false; // renderToScreen managed per-frame in _tick (last pass varies with quality/bypass)
    this.worldPass = new RenderPass(scene, camera);
    composer.addPass(this.worldPass);
    // AO
    this.ao = new AOEffect(camera, { samples: this.q.aoSamples || 10 });
    this.aoPass = new EffectPass(camera, this.ao); composer.addPass(this.aoPass);
    // god rays: our own warm disc placed 260 m out along sky.sunDir (NOT at the far plane: the 380 m mountain ring would
    // swallow the sun for the whole golden hour; at 260 m near occluders — trees, hills, ruins — still carve distinct shafts
    // while the sun glow bleeds over the distant ridge, FF14-style). Set postfx.godraysSource = game.sky.sunMesh to use theirs.
    // Tight disc (angle 0.035) + blurred light buffer = defined smooth shafts instead of a broad stippled veil.
    this._sun = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffe8c0, fog: false }));
    this._sun.frustumCulled = false; this.godraysSource = null; this.godraysAngle = 0.035; this.godraysDist = 260;
    this.godraysBoost = 2.0; // HDR disc brightness: puts the ray core above the day bloom threshold (hot sun punch)
    this.godrays = new GodRaysEffect(camera, this._sun, { resolutionScale: this.q.godraysScale, samples: 44, density: 1.0, decay: 0.955, weight: 0.55, exposure: 0.28, clampMax: 1.35, kernelSize: KernelSize.SMALL, blur: true });
    this.skySmooth = new SkySmoothEffect();
    this.godraysPass = new EffectPass(camera, this.skySmooth, this.godrays); composer.addPass(this.godraysPass);
    // DoF (ADS), own pass so it can be toggled without recompiling
    this.dof = new CheapDofEffect(this._dof);
    this.dofPass = new EffectPass(camera, this.dof); this.dofPass.enabled = false; composer.addPass(this.dofPass);
    // final: auto-exposure + CA (kick) + bloom + tone + grade + vignette  (overlay passes get inserted right before this)
    this.autoExposure = new AutoExposureEffect({ target: 0.3, min: 0.8, max: 1.3 });
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.25 });
    this.bloom = new BloomEffect({ mipmapBlur: true, intensity: 0.5, luminanceThreshold: 1.15, luminanceSmoothing: 0.5, radius: 0.7, levels: 5 });
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.grade = new GradeEffect();
    this.vignette = new VignetteEffect({ darkness: 0.42, offset: 0.32 });
    this.finalPass = new EffectPass(camera, this.autoExposure, this.ca, this.bloom, this.tone, this.grade, this.vignette); composer.addPass(this.finalPass);
    this.smaa = new SMAAEffect({ preset: this.q.smaa, edgeDetectionMode: EdgeDetectionMode.COLOR, predicationMode: PredicationMode.DEPTH });
    this.smaaPass = new EffectPass(camera, this.smaa); composer.addPass(this.smaaPass);
    this.taaPass = new TAAPass(); composer.addPass(this.taaPass);
    this.overlayClear = new ClearPass(false, true, false); // depth only
    if (this.overlay) this.setOverlay(this.overlay.scene, this.overlay.camera);
    this.game.events?.on?.('player:damaged', ({ amount }) => { this.flash(0xff3020, clamp(0.1 + amount / 120, 0.12, 0.45), 0.35); this.kick(clamp(amount / 40, 0.3, 1)); });
    this._tmp = new THREE.Vector3(); this._jf = 0;
    this._prevVP = new THREE.Matrix4(); this._invVP = new THREE.Matrix4(); this._m4 = new THREE.Matrix4();
    this.grade.grain = this.q.taa ? 0.05 : 0.035; // TAA temporally averages animated grain (~2.5x weaker perceived)
  }
  setOverlay(scene, camera) {
    this.overlay = { scene, camera };
    if (!this.composer) return;                       // Weapons may call this before our init; applied in init()
    if (this.overlayPass) { this.composer.removePass(this.overlayPass); this.composer.removePass(this.overlayClear); }
    this.overlayPass = new RenderPass(scene, camera); this.overlayPass.clear = false; this.overlayPass.needsDepthBlit = false; // keep world depth for AO/godrays/DoF
    const i = this.composer.passes.indexOf(this.finalPass);
    this.composer.addPass(this.overlayClear, i); this.composer.addPass(this.overlayPass, i + 1);
    this.resize(innerWidth, innerHeight);
  }
  flash(color = 0xffffff, strength = 0.3, duration = 0.3) {
    const f = this._flash; if (strength < f.strength * (1 - f.t / f.dur)) return;
    f.color.set(color); f.strength = strength; f.t = 0; f.dur = Math.max(0.05, duration);
  }
  kick(strength = 1) { this._kick = Math.max(this._kick, clamp(strength, 0, 2)); }
  setDof({ focus, range, strength, enabled } = {}) {
    const d = this._dof; if (focus !== undefined) d.focus = focus; if (range !== undefined) d.range = range; if (strength !== undefined) d.strength = strength; if (enabled !== undefined) d.enabled = !!enabled;
    this.dof?.params.set(d.focus, d.range, d.strength);
  }
  setBypass(b) { this.bypass = !!b; if (this.taaPass) this.taaPass.reset = 2; }
  setQuality(name) {
    this.q = QUALITY[name] ?? QUALITY.high;
    if (this.q.aoSamples) this.ao.samples = this.q.aoSamples;
    this.godrays.resolution.scale = this.q.godraysScale; this.smaa.applyPreset(this.q.smaa);
    this.taaPass.reset = 2; this.grade.grain = this.q.taa ? 0.05 : 0.035;
  }
  resize(w, h) { if (!this.composer) return; this.composer.setSize(w, h); if (this.overlay) { this.overlay.camera.aspect = w / h; this.overlay.camera.updateProjectionMatrix(); } }
  /** Adapted average scene luminance (pre-exposure), for exposure calibration. */
  readLum() {
    const rt = this.autoExposure.adaptPass.renderTargetAdapted, buf = new Uint8Array(4);
    return this.game.renderer.readRenderTargetPixelsAsync?.(rt, 0, 0, 1, 1, buf).then(() =>
      buf[0] / 255 + buf[1] / 65025 + buf[2] / 16581375 + buf[3] / 4228250625) ?? Promise.resolve(null);
  }

  _tick(dt) {
    const { sky, renderer, camera } = this.game, q = this.q, by = this.bypass;
    const sy = sky?.sunDir?.y ?? 0.6;
    const day = smoothstep(sy, -0.24, -0.05);                                     // grade key: dusk keeps its warm bright horizon, full night look arrives when it's actually dark
    const night = 1 - day;
    const golden = smoothstep(sy, -0.06, 0.05) * (1 - smoothstep(sy, 0.2, 0.45)); // low warm sun (dawn/golden hour), lingers a touch past sunset
    const target = this.exposure * lerp(this.nightExposure, 1.0, day);            // base; bounded scene-luminance adaptation stacks in-shader
    this._exp += (target - this._exp) * Math.min(1, dt * 2.5);
    renderer.toneMappingExposure = this._exp;
    this.bloom.intensity = this._noBloom ? 0 : 0.5 + 0.35 * night;
    this.bloom.luminanceMaterial.threshold = lerp(this.bloomNightTh, this.bloomDayTh, day); // night emissives (crystals, aetheryte) sit below day threshold; let them halo
    // FF14 grade rides the sun: warm gain + saturation at golden hour, cool blue-violet lift + softer S-curve deep at night
    const g = this.grade;
    g.gain.set(lerp(1.0, 1.075, golden), lerp(0.99, 0.96, golden), lerp(0.955, 0.84, golden));
    g.lift.set(lerp(0.015, 0.02, night), lerp(0.02, 0.036, night), lerp(0.038, 0.075, night));
    g.contrast = 0.3 - 0.1 * night;
    g.saturation = 1.1 + 0.13 * golden;
    // god rays: strongest at low sun (golden hour), gone below horizon
    const sunUp = sy > -0.04;
    this.godraysPass.enabled = !by && q.godrays && sunUp;
    if (this.godraysPass.enabled) {
      this.skySmooth.amt = smoothstep(sy, -0.04, 0.02);            // fades out with the sun so night stars stay crisp
      const sm = this.godraysSource || this._sun;
      if (this.godrays.lightSource !== sm) this.godrays.lightSource = sm;
      if (sm === this._sun) {
        const D = this.godraysDist;
        sm.position.copy(camera.position).addScaledVector(sky.sunDir, D); sm.scale.setScalar(D * this.godraysAngle);
        sm.material.color.copy(sky.sunColor ?? WARM).lerp(DEEP_WARM, 0.3 + 0.45 * golden).multiplyScalar(this.godraysBoost);
        sm.updateMatrix(); sm.updateMatrixWorld(true);
      }
      this.godrays.blendMode.opacity.value = smoothstep(sy, -0.05, 0.02) * (0.55 + 0.45 * golden);
    }
    this.aoPass.enabled = !by && q.ao;
    this.dofPass.enabled = !by && q.dof && this._dof.enabled;
    this.finalPass.enabled = !by; this.smaaPass.enabled = !by;
    const taaOn = !by && q.taa;
    this.taaPass.enabled = taaOn;
    this.taaPass.renderToScreen = taaOn;
    this.smaaPass.renderToScreen = !by && !taaOn;
    for (const p of [this.worldPass, this.overlayClear, this.overlayPass]) if (p) p.renderToScreen = by;
    // TAA: subpixel jitter on both cameras (rebuild first so jitter never accumulates), then reprojection matrix = prevVP * currInvVP
    if (taaOn) {
      const [jx, jy] = JITTER[this._jf++ & 7], w = this.taaPass._w, h = this.taaPass._h;
      for (const cam of [camera, this.overlay?.camera]) if (cam) {
        cam.updateProjectionMatrix();
        cam.projectionMatrix.elements[8] += jx * 2 / w; cam.projectionMatrix.elements[9] += jy * 2 / h;
        cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      }
      camera.updateMatrixWorld();
      this._invVP.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
      this.taaPass.mat.uniforms.reproj.value.multiplyMatrices(this._prevVP, this._invVP);
      this._prevVP.multiplyMatrices(camera.projectionMatrix, this._m4.copy(camera.matrixWorld).invert());
    } else if (this._jf) { this._jf = 0; camera.updateProjectionMatrix(); camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert(); }
    // kick (chromatic aberration) + flash decay
    if (this._kick > 0) { this._kick = Math.max(0, this._kick - dt * 4); }
    const k = this._kick * this._kick * 0.006; this.ca.offset.set(k, k * 0.6);
    const f = this._flash, u = this.grade.uniforms;
    if (f.strength > 0) { f.t += dt; const a = clamp(1 - f.t / f.dur, 0, 1); u.get('flashAmt').value = f.strength * a * a; u.get('flashColor').value.copy(f.color); if (a <= 0) f.strength = 0; }
    else u.get('flashAmt').value = 0;
  }
  /** GPU cost of the post pipeline (EXT_disjoint_timer_query_webgl2): alternates bypass on/off per frame so both see the same scene.
   *  Resolves { on, off, cost } in ms (medians) or null if the extension is missing. Debug/perf only. */
  profile(frames = 240) { return new Promise((resolve) => { this._prof = { frames, i: 0, on: [], off: [], pending: [], resolve }; }); }
  _profRender(dt) {
    const gl = this.game.renderer.getContext(), pr = this._prof;
    const ext = this._gpuExt ??= gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) { this._prof = null; pr.resolve(null); return false; }
    this.bypass = (pr.i++ & 1) === 1;
    const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); this._tick(dt); this.composer.render(dt); gl.endQuery(ext.TIME_ELAPSED_EXT); pr.pending.push([q, this.bypass]);
    for (const e of pr.pending.slice()) if (gl.getQueryParameter(e[0], gl.QUERY_RESULT_AVAILABLE)) { if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) (e[1] ? pr.off : pr.on).push(gl.getQueryParameter(e[0], gl.QUERY_RESULT) / 1e6); gl.deleteQuery(e[0]); pr.pending.splice(pr.pending.indexOf(e), 1); }
    if (pr.on.length >= pr.frames / 2 && pr.off.length >= pr.frames / 2) {
      const med = (a) => { a.sort((x, y) => x - y); return +a[a.length >> 1].toFixed(3); }, on = med(pr.on), off = med(pr.off);
      this._prof = null; this.bypass = false; pr.resolve({ on, off, cost: +(on - off).toFixed(3), frames: pr.frames });
    }
    return true;
  }
  render(dt) { if (this._prof && this._profRender(dt)) return; this._tick(dt); this.composer.render(dt); }
}
