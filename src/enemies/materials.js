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
float enoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
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
    .replace('#include <common>', `#include <common>\nuniform vec3 uTint; uniform vec3 uEmissive; uniform float uGlow; uniform float uFlash; uniform float uDissolve; uniform float uTime; uniform float uRim; uniform float uBump; uniform float uGhost; uniform vec2 uHem;\nvarying float vGlow; varying vec3 vEPos;\n${NOISE_GLSL}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      float n1 = enoise(vEPos * 9.0), n2 = enoise(vEPos * 31.0), n3 = enoise(vEPos * 90.0);
      float grain = n1 * 0.45 + n2 * 0.35 + n3 * 0.2;
      // slope-balanced height (amplitude ~ 1/frequency) so every octave contributes equal RELIEF instead of the
      // finest one owning the whole gradient — reuses the three fetches above, costs nothing extra.
      float relief = n1 * 0.74 + n2 * 0.21 + n3 * 0.05;
      // large-scale tonal drift: one hide is never one flat colour (uTint used to paint the creature evenly)
      float blotch = enoise(vEPos * 1.7 + 3.1);
      diffuseColor.rgb *= uTint * (0.62 + grain * 0.72) * (0.80 + blotch * 0.40);
      // saturated aether: push the emissive color toward its square so it stays colored through ACES instead of clipping white
      vec3 ecol = mix(uEmissive, uEmissive * uEmissive, 0.9) * 2.2;
      // crystals/glow parts: darken the lit base so the colored emissive dominates (no sunlit-white paper cutouts at noon)
      diffuseColor.rgb = mix(diffuseColor.rgb, ecol * 0.06, vGlow * 0.94);
      float dn = enoise(vEPos * 4.0 + 7.3) * 0.65 + enoise(vEPos * 13.0) * 0.35;
      if (dn < uDissolve) discard;
      // ---------------------------------------------------------------- ETHEREAL (uGhost > 0)
      // Tripo has no hologram mode, so wraith/riftling/sprite are sculpted as OPAQUE statues and the ghost is
      // applied here (docs/CREATURE-PIPELINE.md). Three parts, none of which can bloom:
      //  1. HEM DISSOLVE — an alpha-free shred (discard) that ramps in over uHem.x..uHem.y of the BIND-pose Y,
      //     so a robe's tendrils / a beast's paws break into tatters and the creature has no hard bottom edge.
      //     vEPos is the bind attribute, so the pattern is welded to the body and does not swim under animation;
      //     the uTime scroll drifts it upward, which is the whole "made of smoke" read.
      //  2. hollow interior + hue rim (lights_fragment_end) — that is what stops it being a lit BALLOON.
      //  3. a hard channel cap (opaque_fragment). Discard costs nothing extra: no transparency, so no sorting,
      //     no depthWrite games, and nothing behind it z-fights through a translucent shell.
      float hemT = 0.0, hemN = 0.0;
      if (uGhost > 0.001) {
        float hem = 1.0 - smoothstep(uHem.y, uHem.x, vEPos.y);
        hemN = enoise(vEPos * vec3(3.6, 2.2, 3.6) + vec3(0.0, uTime * 0.42, 0.0)) * 0.72
             + enoise(vEPos * 11.0 + vec3(0.0, uTime * 0.9, 0.0)) * 0.28;
        hemT = hem * hem * uGhost * 0.94;
        if (hemN < hemT) discard;
      }`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor * (0.85 + grain * 0.3), 0.45, vGlow);`)
    // Sculpted surface relief: Mikkelsen screen-space bump driven by the `relief` height above. No texture, no extra
    // noise fetch, no extra sampler — creatures stop reading as smooth untextured clay. Faded out past ~26 m (and off
    // on the glow crystals) so the fine octave can never turn into distance shimmer.
    .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
      float bumpK = uBump * (1.0 - vGlow) * (1.0 - smoothstep(7.0, 30.0, length(vViewPosition)));
      if (bumpK > 0.002) {
        vec2 dH = vec2(dFdx(relief), dFdy(relief)) * bumpK;
        vec3 sp = -vViewPosition, sx = dFdx(sp), sy = dFdy(sp);
        vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
        float det = dot(sx, r1) * faceDirection;
        normal = normalize(abs(det) * normal - sign(det) * (dH.x * r1 + dH.y * r2));
      }`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float pulse = 0.82 + 0.18 * sin(uTime * 3.1 + vEPos.y * 2.5 + vEPos.x * 1.7);
      totalEmissiveRadiance += ecol * (vGlow * uGlow * pulse);
      float edge = smoothstep(0.14, 0.0, dn - uDissolve) * step(0.001, uDissolve);
      totalEmissiveRadiance += ecol * edge * 4.0;
      // ghost hem: the shredding boundary carries a LOW, hue-locked ember. 0.55 not 4.0 — the death dissolve is a
      // one-off event you are meant to look at, the hem is on screen for the creature's whole life.
      totalEmissiveRadiance += ecol * smoothstep(0.09, 0.0, hemN - hemT) * step(0.001, hemT) * 0.55;`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      float rim = pow(1.0 - saturate(dot(normal, geometryViewDir)), 3.0);
      rim *= smoothstep(1.8, 8.0, length(vViewPosition));   // fade the aether rim out at point-blank: creature reads as a body, not blue glass
      reflectedLight.indirectDiffuse += ecol * rim * uRim * (0.6 + 0.4 * pulse);
      if (uGhost > 0.001) {
        // A GHOST IS A RIM, NOT A BALLOON. The wave-3 shadowfen verdict on the Fen Wraith was "a flat violet
        // balloon": a big smooth lit volume reads as a party balloon at every range, because the lit term is
        // brightest where the surface faces you. So invert it — scale the LIT terms DOWN toward the centre and
        // leave the grazing edges alone, then add the creature's own hue at the silhouette. Every operation
        // here either multiplies light by < 1 or adds a term that the cap below closes, so it cannot blob.
        float gfr = pow(1.0 - saturate(dot(normal, geometryViewDir)), 2.0);
        float hollow = mix(1.0, 0.16 + 0.84 * gfr, uGhost);
        reflectedLight.directDiffuse *= hollow;
        reflectedLight.indirectDiffuse *= mix(1.0, 0.34 + 0.66 * gfr, uGhost);
        reflectedLight.directSpecular *= 1.0 - uGhost * 0.9;      // nothing incorporeal has a highlight
        reflectedLight.indirectSpecular *= 1.0 - uGhost * 0.9;
        reflectedLight.indirectDiffuse += ecol * gfr * gfr * uGhost * (0.42 + 0.14 * pulse);
      }`)
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.6, 1.5, 1.35), uFlash);
      // HUE-PRESERVING CEILING on the aether parts — same principle as GRASS_LUM_CAP, same user decree.
      // A crystal / core / eye is a handful of pixels at combat range: once its outgoing luminance clears
      // the bloom threshold it stops reading as "an arc-blue mote" and becomes an anonymous white ball,
      // which is exactly the washed-white blob the project forbids. Cap the VALUE, keep the HUE — scaling
      // by a ratio leaves the colour untouched and only pulls the brightness back under the threshold.
      // Body parts (vGlow 0) get a ceiling far above anything they reach, so they are unaffected.
      float aetherLum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      float aetherCap = mix(6.0, 0.62, vGlow);
      if (aetherLum > aetherCap) gl_FragColor.rgb *= aetherCap / aetherLum;
      // ...AND CAP THE CHANNEL, which is the half the luminance cap cannot see. Luminance is a WEIGHTED
      // average (blue counts 0.07), so a violet sitting at luminance 0.62 can still carry a blue channel
      // of 2.2 and a red of 0.97 — both clip through ACES and the crystal comes out pale pink. That is
      // exactly the wave-3 void "pale-pink blob with hula-hoop rings" (measured 255,201,251) and the vale
      // "wisps tone-map toward pale cyan-white". Same principle as the luminance cap, same one-scalar
      // hue-preserving scale; 1.02 sits just under the 1.05 day bloom threshold on purpose.
      // smoothstep(0.05, 0.40), NOT (0.25, 0.85): a "half glow" part is exactly as blob-prone as a full one.
      // The wisp/riftling halo rings carry glow 0.55-0.75, which under the old ramp bought them a 1.7-3.4
      // channel ceiling — times dayGlow 3.4 at noon that is a blue channel of ~3.1, well over the 1.05 bloom
      // threshold, i.e. the "hula-hoop rings" and the pale-cyan meadow wisp were still legal. They are not now.
      float aetherMax = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));
      float aetherChan = mix(8.0, 1.02, smoothstep(0.05, 0.40, vGlow));
      if (aetherMax > aetherChan) gl_FragColor.rgb *= aetherChan / aetherMax;
      // GHOST CEILING. The two caps above key off vGlow, so they see a creature's crystals and eyes but not its
      // BODY — and an ethereal body is lit almost entirely at grazing angles, which is where a fresnel term
      // peaks. Cap the whole ghost, channel first: a wraith must never out-value the world it haunts.
      if (uGhost > 0.001) {
        float gMax = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));
        float gCap = mix(1.60, 0.95, uGhost);
        if (gMax > gCap) gl_FragColor.rgb *= gCap / gMax;
      }`);
}

/** `ghost` 0..1 = ethereality (see the ETHEREAL block above); `hem` = [solidY, goneY] in BIND-pose root space. */
export function createCreatureMaterial({ tint = 0xffffff, emissive = 0x66ccff, roughness = 0.85, metalness = 0.05, ghost = 0, hem = [0, -1] } = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness });
  m.userData.u = {
    uTint: { value: new THREE.Color(tint) }, uEmissive: { value: new THREE.Color(emissive) },
    uGlow: { value: 2.2 }, uFlash: { value: 0 }, uDissolve: { value: 0 }, uTime: { value: 0 }, uRim: { value: 0.35 }, uBump: { value: 0.05 },
    uGhost: { value: ghost }, uHem: { value: new THREE.Vector2(hem[0], hem[1]) },
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
      // SATURATE BEFORE YOU NORMALISE: push the element hue toward its square so an arc cyan or a solar
      // orange still reads as that colour through ACES instead of washing out to cream.
      vec3 scol = mix(emissive, emissive * emissive, 0.8);
      diffuseColor.a = uAlpha * (0.012 + fr * 0.26 + hex * 0.03 + uHit * 0.42);
      reflectedLight.indirectDiffuse += scol * (fr * 1.1 + hex * 0.2 + uHit * 2.6);`)
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>
      // BLOB LAW ON THE SHELL. A shield bubble is a combat READ, not a light source, and at melee standoff
      // it covers most of the frame (see SHELL_COV in Enemy.js) — so every pixel of it has to stay well
      // under the bloom threshold. Cap the CHANNEL first (a cyan or a violet sits near the ceiling in two
      // channels at once, which a luminance-only clamp never sees), then the luminance. Both are single
      // hue-preserving scalars: the shell gets dimmer, never whiter.
      float sMax = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));
      if (sMax > 0.80) gl_FragColor.rgb *= 0.80 / sMax;
      float sLum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      if (sLum > 0.50) gl_FragColor.rgb *= 0.50 / sLum;`);
}
export function createShieldMaterial(color = 0x7fd8ff) {
  const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, roughness: 0.3, metalness: 0, transparent: true, opacity: 1, depthWrite: false, side: THREE.FrontSide });
  m.userData.u = { uHit: { value: 0 }, uTime: { value: 0 }, uAlpha: { value: 1 } };
  m.onBeforeCompile = shieldOnBeforeCompile;
  m.customProgramCacheKey = () => 'aether-shield';
  return m;
}
