import * as THREE from 'three';

/**
 * Creature materials. One MeshStandardMaterial program shared by every enemy (same onBeforeCompile reference =>
 * same program cache key); per-enemy instance gets its own material object so uniforms (tint, emissive, flash,
 * telegraph glow, dissolve) are per creature while draw calls stay at 1 per creature.
 * Vertex attributes baked into the shared geometry: color (stone/shell base), aGlow (0..1 aether crystal mask).
 * Procedural 3D value noise in the fragment gives stone grain + the dissolve pattern (no textures).
 */
const NOISE_GLSL = /* glsl */`
float ehash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float enoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(ehash(i), ehash(i + vec3(1,0,0)), f.x), mix(ehash(i + vec3(0,1,0)), ehash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(ehash(i + vec3(0,0,1)), ehash(i + vec3(1,0,1)), f.x), mix(ehash(i + vec3(0,1,1)), ehash(i + vec3(1,1,1)), f.x), f.y), f.z); }
`;

function creatureOnBeforeCompile(shader) {
  const u = this.userData.u;
  Object.assign(shader.uniforms, u);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute float aGlow; varying float vGlow; varying vec3 vEPos;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\nvGlow = aGlow; vEPos = position;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nuniform vec3 uTint; uniform vec3 uEmissive; uniform float uGlow; uniform float uFlash; uniform float uDissolve; uniform float uTime; uniform float uRim;\nvarying float vGlow; varying vec3 vEPos;\n${NOISE_GLSL}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      float grain = enoise(vEPos * 9.0) * 0.45 + enoise(vEPos * 31.0) * 0.35 + enoise(vEPos * 90.0) * 0.2;
      diffuseColor.rgb *= uTint * (0.62 + grain * 0.72);
      // saturated aether: push the emissive color toward its square so it stays colored through ACES instead of clipping white
      vec3 ecol = mix(uEmissive, uEmissive * uEmissive, 0.9) * 2.2;
      // crystals/glow parts: darken the lit base so the colored emissive dominates (no sunlit-white paper cutouts at noon)
      diffuseColor.rgb = mix(diffuseColor.rgb, ecol * 0.06, vGlow * 0.94);
      float dn = enoise(vEPos * 4.0 + 7.3) * 0.65 + enoise(vEPos * 13.0) * 0.35;
      if (dn < uDissolve) discard;`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor * (0.85 + grain * 0.3), 0.45, vGlow);`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float pulse = 0.82 + 0.18 * sin(uTime * 3.1 + vEPos.y * 2.5 + vEPos.x * 1.7);
      totalEmissiveRadiance += ecol * (vGlow * uGlow * pulse);
      float edge = smoothstep(0.14, 0.0, dn - uDissolve) * step(0.001, uDissolve);
      totalEmissiveRadiance += ecol * edge * 4.0;`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      float rim = pow(1.0 - saturate(dot(normal, geometryViewDir)), 3.0);
      rim *= smoothstep(1.8, 8.0, length(vViewPosition));   // fade the aether rim out at point-blank: creature reads as a body, not blue glass
      reflectedLight.indirectDiffuse += ecol * rim * uRim * (0.6 + 0.4 * pulse);`)
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.6, 1.5, 1.35), uFlash);`);
}

export function createCreatureMaterial({ tint = 0xffffff, emissive = 0x66ccff, roughness = 0.85, metalness = 0.05 } = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness });
  m.userData.u = {
    uTint: { value: new THREE.Color(tint) }, uEmissive: { value: new THREE.Color(emissive) },
    uGlow: { value: 2.2 }, uFlash: { value: 0 }, uDissolve: { value: 0 }, uTime: { value: 0 }, uRim: { value: 0.35 },
  };
  m.onBeforeCompile = creatureOnBeforeCompile;
  m.customProgramCacheKey = () => 'aether-creature';
  return m;
}

// Shield bubble: fresnel-alpha sphere, hit flash + hex shimmer. Shared program, per-enemy instance (uniforms).
function shieldOnBeforeCompile(shader) {
  Object.assign(shader.uniforms, this.userData.u);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vSPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSPos = position;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nuniform float uHit; uniform float uTime; uniform float uAlpha; varying vec3 vSPos;\n${NOISE_GLSL}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      float fr = pow(1.0 - saturate(dot(normal, geometryViewDir)), 2.2);
      float hex = smoothstep(0.55, 0.9, enoise(vSPos * 6.0 + uTime * 0.4));
      diffuseColor.a = uAlpha * (0.015 + fr * 0.3 + hex * 0.04 + uHit * 0.5);
      reflectedLight.indirectDiffuse += emissive * (fr * 1.3 + hex * 0.25 + uHit * 3.5);`);
}
export function createShieldMaterial(color = 0x7fd8ff) {
  const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, roughness: 0.3, metalness: 0, transparent: true, opacity: 1, depthWrite: false, side: THREE.FrontSide });
  m.userData.u = { uHit: { value: 0 }, uTime: { value: 0 }, uAlpha: { value: 1 } };
  m.onBeforeCompile = shieldOnBeforeCompile;
  m.customProgramCacheKey = () => 'aether-shield';
  return m;
}
