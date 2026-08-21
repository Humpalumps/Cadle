import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, ClearPass, ShaderPass, Effect, EffectAttribute, BlendFunction,
  BloomEffect, SMAAEffect, SMAAPreset, EdgeDetectionMode, PredicationMode, ToneMappingEffect, ToneMappingMode,
  VignetteEffect, GodRaysEffect, ChromaticAberrationEffect, KawaseBlurPass, KernelSize,
  LuminancePass, AdaptiveLuminancePass,
} from 'postprocessing';

/**
 * PostFX: the post-processing pipeline. Owns the composer and renders each frame.
 * Pipeline (HDR half-float): world RenderPass -> AO (depth-only SAO-ish, half res, tight radius, bilateral blur, depth-aware upsample)
 *   -> god rays (GodRaysEffect, blurred light buffer; light source = internal warm disc 260 m out along game.sky.sunDir so the
 *      mountain ring can't fully swallow golden hour; near occluders (trees/hills) carve shafts; off below horizon)
 *   -> DoF (ADS, off by default) -> [overlay: ClearPass(depth) + RenderPass(overlayScene, overlayCamera) for the first-person viewmodel]
 *   -> final: auto-exposure (GPU 1x1 adapted scene luminance, bounded) + chromatic aberration (kick) + bloom (threshold rides
 *      time-of-day so night emissives glow) + tone map (ACES, time-of-day exposure) + FF14 grade (sun-elevation-keyed warm
 *      gain / cool lift / saturation; dusk keyed deep so the warm horizon survives) + grain + flash + vignette
 *   -> SMAA (HIGH preset at q>=medium).
 * NO TAA: a jittered temporal resolve never settles on a static scene (the 13% current-frame term is a different subpixel
 *   sample every frame) and it amplified the animated grain through its neighborhood clamp -> the user-visible "screen
 *   jitters at q=high, clean at q=low". SMAA + no jitter = a rock-stable image, and it bought back ~0.3 ms.
 * API (stable):
 *   postfx.render(dt), postfx.resize(w,h)
 *   postfx.setOverlay(scene, camera)          viewmodel overlay; camera aspect kept in sync on resize. Weapons calls this.
 *   postfx.flash(color, strength, duration)   full-screen tint kick (damage taken, super pop); edge-weighted so the center stays readable
 *   postfx.kick(strength)                     chromatic aberration pulse (explosions, big hits)
 *   postfx.setDof({ focus, range, strength, enabled })  used when ADS with sniper etc (optional, cheap half-res blur by CoC, ~0.2 ms)
 *   postfx.exposure (number, base; time-of-day + bounded scene-luminance adaptation on top), .bloom, .vignette, .ao, .godrays, .grade, .tone handles
 *   postfx.setBypass(bool)                    world+overlay only (perf A/B), postfx.setQuality('low'|'medium'|'high')
 *   postfx.profile(frames) -> Promise<{on,off,cost}>  GPU ms of the whole post chain (timer queries, alternates bypass per frame)
 *   postfx.readLum() -> Promise<number>       adapted average scene luminance (pre-exposure; debug/calibration)
 *   postfx.godraysSource (Object3D|null)     override the god-rays light source (e.g. game.sky.sunMesh); null = internal disc
 * Quality: low = no AO / god rays / DoF, SMAA medium. Budget @1080p q=high on RTX 3060: <= 1.3 ms with sun on screen.
 */

const QUALITY = {
  low:    { ao: false, aoSamples: 0,  godrays: false, godraysScale: 0.4,  godraysSamples: 24, dof: false, smaa: SMAAPreset.MEDIUM },
  medium: { ao: true,  aoSamples: 8,  godrays: true,  godraysScale: 0.4,  godraysSamples: 26, dof: true,  smaa: SMAAPreset.HIGH },
  high:   { ao: true,  aoSamples: 8,  godrays: true,  godraysScale: 0.4,  godraysSamples: 22, dof: false, smaa: SMAAPreset.HIGH },  // perf: DoF + ULTRA SMAA cost more than they read at 1080p
};

const FS_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

// ---- AO: depth-only ambient occlusion (SAO-style spiral taps, normals reconstructed from depth), half res, bilateral blur, depth-aware upsample.
//      Deliberately SHORT reach (max 8 half-res px): thin near geometry (grass blades over stone) must not smear a wide dark halo.
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
  float rPx = clamp(radius * projScale / dist, 2.0, 8.0);           // short max reach: no 40 px smudge around a 3 px blade
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); // interleaved gradient noise: static per pixel = no temporal crawl
  float a0 = noise * 6.2831853, R2 = radius * radius, occ = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float a = (float(i) + 0.5) / float(SAMPLES);
    float ang = a * 6.2831853 * 3.0 + a0;
    vec2 uv2 = vUv + vec2(cos(ang), sin(ang)) * (a * rPx) * texelSize;
    vec3 v = vp(uv2, rd(uv2)) - P;
    float vv = dot(v, v), vn = dot(v, N) - bias * dist;
    float f = max(R2 - vv, 0.0) / R2;
    float thin = 1.0 - smoothstep(radius * 0.25, radius * 0.7, v.z);  // occluder floating in front (grass blade over stone): reject
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
  for (int i = 1; i <= 2; i++) { float fi = float(i); float g = exp(-fi * fi * 0.3);
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
  constructor(camera, { samples = 10, radius = 0.55, intensity = 1.9, bias = 0.0025, fadeDist = 110, resolutionScale = 0.5 } = {}) {
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
  // `frozen` holds the adaptation where it is. A paused game is a static scene, and an eye-adaptation
  // curve still running under it is literally "the renderer keeps changing a static scene" (gate rule 2).
  update(renderer, inputBuffer, deltaTime) { this.lumPass.render(renderer, inputBuffer); this.adaptPass.render(renderer, null, null, this.frozen ? 0 : deltaTime); }
}

// ---- Grade: FF14 painterly curves (lift/gain/contrast/saturation driven per-frame from sun elevation: warm golden-hour gain,
//      cool blue-violet dusk/night lift) + film grain + edge-weighted flash tint. Runs after tone mapping.
const GRADE_FRAG = /* glsl */`
uniform vec3 lift; uniform vec3 gain; uniform float contrast; uniform float saturation; uniform float grain; uniform float grainT; uniform vec3 flashColor; uniform float flashAmt;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  vec3 c = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));        // grade in display-ish space
  c = c * gain + lift * (1.0 - c);                                  // lift shadows (cool), gain highlights (warm)
  c = mix(c, c * c * (3.0 - 2.0 * c), contrast);                    // filmic S-curve
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  float edge = smoothstep(0.12, 0.62, distance(uv, vec2(0.5)));     // Destiny-style damage flash: strong at the rim, center stays readable
  c = mix(c, flashColor, flashAmt * mix(0.35, 1.0, edge));
  float n = fract(sin(dot(floor(uv * resolution) + mod(grainT * 60.0, 97.0) * vec2(7.13, 3.71), vec2(12.9898, 78.233))) * 43758.5453);   // grainT, not the built-in time uniform: it stops with the game
  c += (n - 0.5) * grain * (1.0 - 0.7 * l);                         // grain, weaker in highlights
  outputColor = vec4(pow(max(c, 0.0), vec3(2.2)), inputColor.a);
}`;
class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, { blendFunction: BlendFunction.SRC, uniforms: new Map([
      ['lift', new THREE.Uniform(new THREE.Vector3(0.015, 0.02, 0.038))], ['gain', new THREE.Uniform(new THREE.Vector3(1.0, 0.99, 0.955))],
      ['contrast', new THREE.Uniform(0.3)], ['saturation', new THREE.Uniform(1.1)], ['grain', new THREE.Uniform(0.035)], ['grainT', new THREE.Uniform(0)],
      ['flashColor', new THREE.Uniform(new THREE.Color(1, 1, 1))], ['flashAmt', new THREE.Uniform(0)]]) });
  }
  get lift() { return this.uniforms.get('lift').value; } get gain() { return this.uniforms.get('gain').value; }
  get contrast() { return this.uniforms.get('contrast').value; } set contrast(v) { this.uniforms.get('contrast').value = v; }
  get saturation() { return this.uniforms.get('saturation').value; } set saturation(v) { this.uniforms.get('saturation').value = v; }
  get grain() { return this.uniforms.get('grain').value; } set grain(v) { this.uniforms.get('grain').value = v; }
  set grainT(v) { this.uniforms.get('grainT').value = v; }
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
    composer.autoRenderToScreen = false; // renderToScreen managed per-frame in _tick (last pass varies with bypass)
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
    this._sun.frustumCulled = false; this.godraysSource = null; this.godraysAngle = 0.035; this.godraysDist = 1200; // beyond the mountain ring: peaks now depth-occlude the disc (and so its rays) instead of the sun drawing in front of them
    this.godraysBoost = 2.0; // HDR disc brightness: puts the ray core above the day bloom threshold (hot sun punch)
    this.godrays = new GodRaysEffect(camera, this._sun, { resolutionScale: this.q.godraysScale, samples: this.q.godraysSamples, density: 0.97, decay: 0.945, weight: 0.6, exposure: 0.3, clampMax: 1.35, kernelSize: KernelSize.SMALL, blur: true });
    this.godraysPass = new EffectPass(camera, this.godrays); composer.addPass(this.godraysPass);
    // DoF (ADS), own pass so it can be toggled without recompiling
    this.dof = new CheapDofEffect(this._dof);
    this.dofPass = new EffectPass(camera, this.dof); this.dofPass.enabled = false; composer.addPass(this.dofPass);
    // final: auto-exposure + CA (kick) + bloom + tone + grade + vignette  (overlay passes get inserted right before this)
    this.autoExposure = new AutoExposureEffect({ target: 0.3, min: 0.8, max: 1.3 });
    this.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.25 });
    this.bloom = new BloomEffect({ mipmapBlur: true, intensity: 0.5, luminanceThreshold: 1.05, luminanceSmoothing: 0.5, radius: 0.7, levels: 5 });
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.grade = new GradeEffect();
    this.vignette = new VignetteEffect({ darkness: 0.42, offset: 0.32 });
    this.finalPass = new EffectPass(camera, this.autoExposure, this.ca, this.bloom, this.tone, this.grade, this.vignette); composer.addPass(this.finalPass);
    this.smaa = new SMAAEffect({ preset: this.q.smaa, edgeDetectionMode: EdgeDetectionMode.COLOR, predicationMode: PredicationMode.DEPTH });
    this.smaaPass = new EffectPass(camera, this.smaa); composer.addPass(this.smaaPass);
    this.overlayClear = new ClearPass(false, true, false); // depth only
    if (this.overlay) this.setOverlay(this.overlay.scene, this.overlay.camera);
    this.game.events?.on?.('player:damaged', ({ amount }) => { this.flash(0xff3020, clamp(0.1 + amount / 120, 0.12, 0.45), 0.35); this.kick(clamp(amount / 40, 0.3, 1)); });
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
  setBypass(b) { this.bypass = !!b; }
  setQuality(name) {
    this.q = QUALITY[name] ?? QUALITY.high;
    if (this.q.aoSamples) this.ao.samples = this.q.aoSamples;
    this.godrays.resolution.scale = this.q.godraysScale; this.godrays.samples = this.q.godraysSamples;
    this.smaa.applyPreset(this.q.smaa);
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
    const golden = smoothstep(sy, -0.10, 0.05) * (1 - smoothstep(sy, 0.2, 0.45)); // low warm sun (dawn/golden hour), lingers through dusk so the horizon keeps its gold
    const target = this.exposure * lerp(this.nightExposure, 1.0, day);            // base; bounded scene-luminance adaptation stacks in-shader
    this._exp += (target - this._exp) * Math.min(1, dt * 2.5);
    renderer.toneMappingExposure = this._exp;
    // freeze the two things that animate independently of the world clock, so a paused frame is a frozen
    // frame: eye adaptation and film grain (gate rule 2 -- and a pause menu should not crawl or brighten)
    const frozen = !!this.game.paused;
    this.autoExposure.frozen = frozen;
    if (!frozen) this._grainT = (this._grainT ?? 0) + dt;
    this.grade.grainT = this._grainT ?? 0;
    this.bloom.intensity = 0.5 + 0.35 * night;
    this.bloom.luminanceMaterial.threshold = lerp(this.bloomNightTh, this.bloomDayTh, day); // night emissives (crystals, aetheryte) sit below day threshold; let them halo
    // FF14 grade rides the sun: warm gain + saturation at golden hour, cool blue-violet lift + softer S-curve deep at night
    const g = this.grade;
    g.gain.set(lerp(1.0, 1.075, golden), lerp(0.99, 0.96, golden), lerp(0.955, 0.84, golden));
    g.lift.set(lerp(0.015, 0.014, night), lerp(0.02, 0.032, night), lerp(0.038, 0.078, night)); // night lift is blue-violet, NOT magenta
    g.contrast = 0.3 - 0.1 * night;
    g.saturation = 1.1 + 0.13 * golden;
    // god rays: strongest at low sun (golden hour), gone below horizon
    const sunUp = sy > -0.04;
    this.godraysPass.enabled = !by && q.godrays && sunUp;
    if (this.godraysPass.enabled) {
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
    this.smaaPass.renderToScreen = !by;
    for (const p of [this.worldPass, this.overlayClear, this.overlayPass]) if (p) p.renderToScreen = by;
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
