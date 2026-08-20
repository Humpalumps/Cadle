import * as THREE from 'three';

/**
 * Lighting: key light (sun by day / cool moon by night) with cascaded shadow maps, hemisphere fill, procedural env map (IBL).
 * Reads game.sky every frame: sunDir, moonDir, sunColor, sunIntensity, night, skyColor, horizonColor, ambientColor, groundColor.
 *
 * Exposes (stable):
 *   lighting.sun            DirectionalLight — THE key light (cascade 0). .color/.intensity/direction live. Moon takes over at night.
 *   lighting.cascades       DirectionalLight[] (one per cascade, [0] === sun). All shadow-casting DirectionalLights in the scene are cascades.
 *   lighting.keyDir         Vector3 unit, FROM scene TO key light.  lighting.keyColor (Color), lighting.keyIntensity, lighting.isMoon (bool)
 *   lighting.hemi           HemisphereLight (sky.ambientColor / sky.groundColor)
 *   lighting.env            WebGLRenderTarget (PMREM) currently on scene.environment; rebuilt from sky colors when they change (~every 0.25 h)
 *   lighting.sunPeak / moonPeak / hemiIntensity / envIntensity / shadowDistance   tunables
 *   lighting.bakeEnv()      force env rebuild.   lighting.showCascades(bool)  debug tint (red/green/blue = cascade 0/1/2);
 *                           allow ~1-2 s after toggling: every lit material recompiles before the tint shows.
 *   lighting.freezeShadows  (bool) stop re-rendering/refitting the shadow maps (perf A/B, inspecting cascades)
 *   lighting.setupShadowMaterial(shaderMaterial)  + paste lighting.shadowGLSL into its fragment shader, then call
 *                           `aetherSunShadow(worldPos, worldNormal)` (0 = shadow, 1 = lit). For raw ShaderMaterials (grass/water).
 *   Shadow look: per-cascade PCF radius hardens contact (crisp near, soft far), far cascades fade toward ambient
 *   (CASCADE_INTENSITY), and all shadow opacity eases off at low sun (_shadowFade) so golden hour stays warm-lit.
 *   Materials that set `GRASS` in defines also get their indirect light scaled inside cast shadows (dense fields
 *   otherwise wash shadows out through wrapped diffuse + ambient) — see GRASS_INDIRECT_SHADOW.
 *
 * How shadows reach materials — ZERO setup for built-in materials:
 *   ShaderChunk.lights_fragment_begin / shadowmap_pars_fragment are patched once (module-global, like three's CSM addon) so every
 *   MeshStandard/Physical/Lambert/Phong/Toon material is lit ONCE by the key light and shadowed by the finest cascade containing the
 *   fragment (soft hardware-PCF, smooth blend between cascades, radial fade at the far edge). Cascades are sphere-fitted to frustum
 *   slices and texel-snapped in light space, so shadows do not swim/shimmer when moving or turning.
 *   Rules for other builders: mesh.castShadow / receiveShadow as usual; do NOT add shadow-casting DirectionalLights (non-shadow ones
 *   are fine and lit normally); do not replace lights_fragment_begin in onBeforeCompile.
 * Render cost: shadow maps are rendered once per frame (renderer.shadowMap.autoUpdate=false, needsUpdate set here), so extra
 *   renderer.render() calls (water reflection, probes) reuse them.
 */

// ---------- quality presets (per cascade: map size; splits = slice far planes as fraction of shadowDistance) ----------
const PRESET = {
  low:    { sizes: [1024, 1024],        splits: [0.22, 1],        dist: 90,  stagger: true },
  medium: { sizes: [2048, 1024, 1024],  splits: [0.07, 0.26, 1],  dist: 140, stagger: true },
  high:   { sizes: [2048, 2048, 2048],  splits: [0.055, 0.21, 1], dist: 180, stagger: true },
  ultra:  { sizes: [4096, 2048, 2048],  splits: [0.045, 0.17, 1], dist: 260, stagger: false },
};
const PAD = [1.15, 1.05, 1.05, 1.05];        // cascade-0 gets extra room so one-frame-old camera pose never starves it
const PCF_RADIUS = [1.3, 2.2, 3.0, 3.0];     // hardware-PCF vogel-disk radius in texels: crisp near contact, wide+soft far (no far-field crosshatch)
const CASCADE_INTENSITY = [1, 0.95, 0.85, 0.8]; // far shadows lighten toward ambient: reads atmospheric, not artifact spam
const NORMAL_BIAS_TEXELS = 1.5, BIAS_TEXELS = 1.0;
const BACK = 450;                            // how far behind the slice (toward the light) the shadow camera sits: room for mountain casters
const MOON_COLOR = new THREE.Color(0.55, 0.68, 1.0);

// ---------- GLSL: cascade selection chain (shared by the built-in patch and the custom-material helper) ----------
// Expects macros: CSM_N (1..4), CSM_EDGE(I) (square edge distance, >0 inside), CSM_EDGE_LAST(I) (radial), CSM_TAP(I) (pcf shadow 0..1).
const CSM_SELECT = /* glsl */`
#define CSM_BLEND 0.06
#define CSM_FADE 0.12
float aether_csmSelect() {
	float s = 1.0;
	#if CSM_N == 1
		float e0 = CSM_EDGE_LAST( 0 );
		if ( e0 > 0.0 ) s = mix( 1.0, CSM_TAP( 0 ), smoothstep( 0.0, CSM_FADE, e0 ) );
	#else
		float e0 = CSM_EDGE( 0 );
		if ( e0 > CSM_BLEND ) { s = CSM_TAP( 0 ); }
		else {
			#if CSM_N == 2
				float e1 = CSM_EDGE_LAST( 1 );
				if ( e1 > 0.0 ) s = mix( 1.0, CSM_TAP( 1 ), smoothstep( 0.0, CSM_FADE, e1 ) );
			#else
				float e1 = CSM_EDGE( 1 );
				if ( e1 > CSM_BLEND ) { s = CSM_TAP( 1 ); }
				else {
					#if CSM_N == 3
						float e2 = CSM_EDGE_LAST( 2 );
						if ( e2 > 0.0 ) s = mix( 1.0, CSM_TAP( 2 ), smoothstep( 0.0, CSM_FADE, e2 ) );
					#else
						float e2 = CSM_EDGE( 2 );
						if ( e2 > CSM_BLEND ) { s = CSM_TAP( 2 ); }
						else {
							float e3 = CSM_EDGE_LAST( 3 );
							if ( e3 > 0.0 ) s = mix( 1.0, CSM_TAP( 3 ), smoothstep( 0.0, CSM_FADE, e3 ) );
							if ( e2 > 0.0 ) s = mix( s, CSM_TAP( 2 ), e2 / CSM_BLEND );
						}
					#endif
					if ( e1 > 0.0 ) s = mix( s, CSM_TAP( 1 ), e1 / CSM_BLEND );
				}
			#endif
			if ( e0 > 0.0 ) s = mix( s, CSM_TAP( 0 ), e0 / CSM_BLEND );
		}
	#endif
	return s;
}
float aether_csmIndex() {
	if ( CSM_EDGE( 0 ) > 0.0 ) return 0.0;
	#if CSM_N > 1
	if ( CSM_EDGE( 1 ) > 0.0 ) return 1.0;
	#endif
	#if CSM_N > 2
	if ( CSM_EDGE( 2 ) > 0.0 ) return 2.0;
	#endif
	return 3.0;
}
vec3 aether_csmDebugTint( float i ) { return i < 0.5 ? vec3( 1.0, 0.45, 0.45 ) : i < 1.5 ? vec3( 0.45, 1.0, 0.45 ) : i < 2.5 ? vec3( 0.45, 0.55, 1.0 ) : vec3( 1.0 ); }
`;

const EDGE_FNS = /* glsl */`
float aether_edge( vec4 c ) { vec2 p = c.xy / c.w; vec2 d = min( p, 1.0 - p ); return min( d.x, d.y ); }
float aether_edgeRadial( vec4 c ) { vec2 p = c.xy / c.w; return 0.5 - length( p - 0.5 ); }
`;

// Built-in materials: appended to shadowmap_pars_fragment (after getShadow + the directional shadow uniforms exist).
const BUILTIN_PARS = /* glsl */`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	${EDGE_FNS}
	#if NUM_DIR_LIGHT_SHADOWS > 4
		#define CSM_N 4
	#else
		#define CSM_N NUM_DIR_LIGHT_SHADOWS
	#endif
	#define CSM_EDGE(I) aether_edge( vDirectionalShadowCoord[ I ] )
	#define CSM_EDGE_LAST(I) aether_edgeRadial( vDirectionalShadowCoord[ I ] )
	#define CSM_TAP(I) getShadow( directionalShadowMap[ I ], directionalLightShadows[ I ].shadowMapSize, directionalLightShadows[ I ].shadowIntensity, directionalLightShadows[ I ].shadowBias, directionalLightShadows[ I ].shadowRadius, vDirectionalShadowCoord[ I ] )
	${CSM_SELECT}
	float aetherShadowMask = 1.0;
#endif
`;

// Dense fields (materials with a GRASS define) hide a key-only shadow behind wrapped diffuse + bright ambient: also pull their
// indirect light down inside cast shadows so characters get readable grounding. Prepended to lights_fragment_end.
const GRASS_INDIRECT_SHADOW = /* glsl */`
#if defined( GRASS ) && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	{
		float aetherAmbS = mix( 0.52, 1.0, aetherShadowMask );
		irradiance *= aetherAmbS; iblIrradiance *= aetherAmbS;
	}
#endif
`;

// Built-in materials: replaces the directional-light block of lights_fragment_begin.
const BUILTIN_DIR_BLOCK = /* glsl */`
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;

	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
		// Aetherfall CSM: the shadow-casting directional lights are the cascades of ONE key light (same dir/color) — light once, pick cascade.
		directionalLight = directionalLights[ 0 ];
		getDirectionalLightInfo( directionalLight, directLight );
		aetherShadowMask = ( directLight.visible && receiveShadow ) ? aether_csmSelect() : 1.0;
		directLight.color *= aetherShadowMask;
		#ifdef AETHER_CSM_DEBUG
			directLight.color *= aether_csmDebugTint( aether_csmIndex() );
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		#if NUM_DIR_LIGHTS > NUM_DIR_LIGHT_SHADOWS
		#pragma unroll_loop_start
		for ( int i = NUM_DIR_LIGHT_SHADOWS; i < NUM_DIR_LIGHTS; i ++ ) {
			directionalLight = directionalLights[ i ];
			getDirectionalLightInfo( directionalLight, directLight );
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}
		#pragma unroll_loop_end
		#endif
	#else
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
			directionalLight = directionalLights[ i ];
			getDirectionalLightInfo( directionalLight, directLight );
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}
		#pragma unroll_loop_end
	#endif

#endif

`;

let patched = false;
function patchShaderChunks() {
  if (patched) return; patched = true;
  const SC = THREE.ShaderChunk;
  const src = SC.lights_fragment_begin;
  const a = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const b = src.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )');
  if (a < 0 || b < a) { console.warn('Lighting: lights_fragment_begin layout unexpected, CSM patch skipped'); return; }
  SC.lights_fragment_begin = src.slice(0, a) + BUILTIN_DIR_BLOCK + src.slice(b);
  SC.shadowmap_pars_fragment = SC.shadowmap_pars_fragment + BUILTIN_PARS;
  SC.lights_fragment_end = GRASS_INDIRECT_SHADOW + SC.lights_fragment_end;
}

// Custom ShaderMaterials: self-contained version (own uniforms, computes shadow coords in the fragment shader).
function customShadowGLSL(n) {
  return /* glsl */`
#define AETHER_CSM ${n}
#define CSM_N ${n}
uniform sampler2DShadow uCsmMap[ CSM_N ];
uniform mat4 uCsmMatrix[ CSM_N ];
uniform vec4 uCsmParams[ CSM_N ]; // x bias (depth units), y normalBias (m), z pcf radius (texels), w 1/mapSize
${EDGE_FNS}
float aether_ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
float aether_pcf( sampler2DShadow map, vec4 prm, vec4 sc ) {
	vec3 p = sc.xyz / sc.w; p.z += prm.x;
	if ( p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0 ) return 1.0;
	float phi = aether_ign( gl_FragCoord.xy ) * 6.2831853, r = prm.z * prm.w, s = 0.0;
	for ( int i = 0; i < 5; i ++ ) {
		float fi = float( i ), rr = sqrt( ( fi + 0.5 ) * 0.2 ), th = fi * 2.399963 + phi;
		s += texture( map, vec3( p.xy + vec2( cos( th ), sin( th ) ) * rr * r, p.z ) );
	}
	return s * 0.2;
}
uniform vec4 uCsmI; // per-cascade shadow intensity (distance + low-sun fade)
vec4 aether_csmCoord[ CSM_N ];
#define CSM_EDGE(I) aether_edge( aether_csmCoord[ I ] )
#define CSM_EDGE_LAST(I) aether_edgeRadial( aether_csmCoord[ I ] )
#define CSM_TAP(I) mix( 1.0, aether_pcf( uCsmMap[ I ], uCsmParams[ I ], aether_csmCoord[ I ] ), uCsmI[ I ] )
${CSM_SELECT}
// 0 = fully shadowed, 1 = lit. worldNormal is used for normal-offset bias (pass vec3(0,1,0) for grass blades).
float aetherSunShadow( vec3 worldPos, vec3 worldNormal ) {
	for ( int i = 0; i < CSM_N; i ++ ) aether_csmCoord[ i ] = uCsmMatrix[ i ] * vec4( worldPos + worldNormal * uCsmParams[ i ].y, 1.0 );
	return aether_csmSelect();
}
`;
}

export class Lighting {
  constructor(game) {
    this.game = game;
    patchShaderChunks();
    this.sunPeak = 3.2; this.moonPeak = 0.45; this.hemiIntensity = 0.4; this.hemiNight = 1.05; this.envIntensity = 0.4; // sunlit white ≈ 1.0 linear pre-tonemap; night: key/fill ≈ 0.43 so moon shadows read
    this.keyDir = new THREE.Vector3(0, 1, 0); this.keyColor = new THREE.Color(1, 1, 1); this.keyIntensity = 0; this.isMoon = false;
    this._frame = 0;
    this._v = new THREE.Vector3(); this._x = new THREE.Vector3(); this._y = new THREE.Vector3(); this._z = new THREE.Vector3();
    this._c = new THREE.Vector3(); this._fwd = new THREE.Vector3(); this._up = new THREE.Vector3();
  }

  init() {
    const { scene, renderer } = this.game;
    renderer.shadowMap.type = THREE.PCFShadowMap;       // r185: PCFSoft is deprecated → PCF (hardware compare + vogel disk)
    renderer.shadowMap.autoUpdate = false;              // we flag needsUpdate once per frame; extra scene renders reuse the maps
    const preset = PRESET[this.game.quality] ?? PRESET.high;
    this.preset = preset;
    this.shadowDistance = preset.dist;
    this.cascades = [];
    for (let i = 0; i < preset.sizes.length; i++) {
      const size = preset.sizes[i];
      const l = new THREE.DirectionalLight(0xffffff, i === 0 ? 3 : 0); // only cascade 0 lights; others are shadow-only
      l.name = 'csm' + i; l.castShadow = true;
      const sh = l.shadow;
      sh.mapSize.set(size, size); sh.radius = PCF_RADIUS[i]; sh.autoUpdate = false;
      // Pre-create the shadow map exactly like WebGLShadowMap (PCF path) so custom-material uniforms are valid from frame 1.
      sh.map = new THREE.WebGLRenderTarget(size, size);
      const dt = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
      dt.name = l.name + '.shadowMap'; dt.format = THREE.DepthFormat; dt.compareFunction = THREE.LessEqualCompare;
      dt.minFilter = dt.magFilter = THREE.LinearFilter;
      sh.map.depthTexture = dt;
      scene.add(l, l.target);
      this.cascades.push(l);
    }
    this.sun = this.cascades[0];
    this.hemi = new THREE.HemisphereLight(0x88aaff, 0x443322, this.hemiIntensity);
    scene.add(this.hemi);

    // custom-material shadow API
    const n = this.cascades.length;
    this.shadowUniforms = {
      uCsmMap: { value: this.cascades.map((l) => l.shadow.map.depthTexture) },
      uCsmMatrix: { value: this.cascades.map((l) => l.shadow.matrix) },
      uCsmParams: { value: this.cascades.map(() => new THREE.Vector4()) },
      uCsmI: { value: new THREE.Vector4(1, 1, 1, 1) },
    };
    this.shadowGLSL = customShadowGLSL(n);

    // env map: tiny gradient-sky scene → PMREM (size 64: the sky is smooth, detail is wasted)
    this.pmrem = new THREE.PMREMGenerator(this.game.renderer);
    this._envScene = new THREE.Scene();
    this._envMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false,
      uniforms: { zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() },
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color() }, sunI: { value: 0 },
        moonDir: { value: new THREE.Vector3(0, 1, 0) }, moonI: { value: 0 } },
      vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir; uniform vec3 zenith, horizon, ground, sunDir, sunColor, moonDir; uniform float sunI, moonI;
        void main(){
          vec3 d = normalize( vDir ); float h = d.y;
          vec3 c = h >= 0.0 ? mix( horizon, zenith, pow( h, 0.55 ) ) : mix( horizon, ground, clamp( pow( -h, 0.45 ) * 1.3, 0.0, 1.0 ) );
          float s = max( dot( d, sunDir ), 0.0 );
          c += sunColor * sunI * ( 0.05 * pow( s, 4.0 ) + 1.5 * pow( s, 160.0 ) );   // haze glow + sun lobe for glossy reflections
          float m = max( dot( d, moonDir ), 0.0 );
          c += vec3( 0.55, 0.68, 1.0 ) * moonI * ( 0.03 * pow( m, 4.0 ) + 0.6 * pow( m, 200.0 ) );
          gl_FragColor = vec4( c, 1.0 );
        }`,
    });
    this._envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 24, 12), this._envMat));
    this.env = null; this._envHour = -99; this._envT = -99; this._envLum = 1; this._envSig = new Float32Array(12);
    this._updateKey();
    this.bakeEnv();
  }

  // ---------- per frame ----------
  update() {
    const { sky, renderer, scene } = this.game;
    this._frame++;
    this._updateKey();
    if (!this.freezeShadows) this._fitCascades();     // freezeShadows: debug/perf knob — keep last maps, skip the shadow pass
    this.hemi.color.copy(sky.ambientColor ?? sky.skyColor); this.hemi.groundColor.copy(sky.groundColor ?? sky.horizonColor);
    this.hemi.intensity = THREE.MathUtils.lerp(this.hemiIntensity, this.hemiNight, sky.night ?? 0); // night floor: FF14 nights are blue, not black
    // FF14 golden hour: the whole valley floor sits in long cast shadows — warm the hemisphere toward the sun color and
    // boost it so grass/characters read warm-lit at low sun instead of post-dusk murk (fades with sunI as the sun sets).
    const gold = this._golden ?? 0;
    if (gold > 0.01) {
      this.hemi.color.lerp(this.keyColor, gold * 0.5);
      this.hemi.groundColor.lerp(this.keyColor, gold * 0.35);
      this.hemi.intensity *= 1 + gold * 1.3;
    }
    // env: rebake when the sky changed enough (colors or ~0.25 h), at most every 0.5 s; in between scale brightness continuously
    const t = this.game.time;
    if (t - this._envT > 0.5 && (Math.abs(sky.hour - this._envHour) > 0.25 || this._skyDelta() > 0.04)) this.bakeEnv();
    scene.environmentIntensity = this.envIntensity * (this._skyLum() / this._envLum) * (1 + gold * 0.6);
    renderer.shadowMap.needsUpdate = !this.freezeShadows;
  }

  _updateKey() {
    const sky = this.game.sky;
    const sunUp = sky.sunDir.y > -0.01;
    const sunI = sky.sunIntensity ?? THREE.MathUtils.clamp(sky.sunDir.y * 3, 0, 1);
    const moonDir = sky.moonDir ?? this._v.copy(sky.sunDir).negate();
    const moonI = sky.moonIntensity ?? THREE.MathUtils.clamp(moonDir.y * 4, 0, 1) * (sky.night ?? (1 - sunI));
    this.isMoon = !sunUp;
    if (sunUp) { this.keyDir.copy(sky.sunDir); this.keyColor.copy(sky.sunColor); this.keyIntensity = this.sunPeak * sunI; }
    else {
      this.keyDir.copy(moonDir); this.keyIntensity = this.moonPeak * moonI;
      const mc = sky.moonColor, mx = mc ? Math.max(mc.r, mc.g, mc.b) : 0;   // sky.moonColor carries hue (and its own intensity): take the hue only
      if (mx > 1e-4) this.keyColor.copy(mc).multiplyScalar(1 / mx); else this.keyColor.copy(MOON_COLOR);
    }
    if (this.keyDir.y < 0.02) this.keyDir.y = 0.02, this.keyDir.normalize(); // never light from below the horizon
    for (const l of this.cascades) { l.color.copy(this.keyColor); }
    this.sun.intensity = this.keyIntensity;
    this._moonI = moonI; this._sunI = sunI;
    // low sun = huge hazy disc: fade shadow opacity so golden-hour valleys stay warm-lit instead of key-less murk
    this._shadowFade = this.isMoon ? 0.9 : THREE.MathUtils.lerp(0.45, 1, THREE.MathUtils.smoothstep(this.keyDir.y, 0.06, 0.35));
    // golden factor: 1 when the sun is up but low, 0 at midday/night — drives warm fill + env boost in update()
    this._golden = this.isMoon ? 0 : (1 - THREE.MathUtils.smoothstep(sky.sunDir.y, 0.12, 0.5)) * sunI;
  }

  // Sphere-fit each cascade to its frustum slice (rotation-invariant), snap the centre to shadow texels in light space (no swim).
  _fitCascades() {
    const cam = this.game.camera, dir = this.keyDir, preset = this.preset;
    const up = this._up.set(0, 1, 0); if (Math.abs(dir.y) > 0.999) up.set(0, 0, 1);
    // light basis exactly as Matrix4.lookAt(eye = c + dir, target = c, up): z = dir, x = up × z, y = z × x
    const z = this._z.copy(dir), x = this._x.crossVectors(up, z).normalize(), y = this._y.crossVectors(z, x);
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const tanY = Math.tan(THREE.MathUtils.DEG2RAD * cam.fov * 0.5), tanX = tanY * cam.aspect, k2 = tanX * tanX + tanY * tanY;
    const last = this.cascades.length - 1;
    for (let i = 0; i <= last; i++) {
      const l = this.cascades[i], sh = l.shadow, size = preset.sizes[i];
      sh.intensity = CASCADE_INTENSITY[i] * this._shadowFade;   // distance + low-sun fade (uniform only, safe while staggered)
      this.shadowUniforms.uCsmI.value.setComponent(i, sh.intensity);
      const stagger = preset.stagger && i === last && (this._frame & 1);
      sh.needsUpdate = !stagger;
      if (stagger) continue;                         // keep camera + map consistent: don't move a cascade we don't re-render
      const n = i === 0 ? cam.near : this.shadowDistance * preset.splits[i - 1], f = this.shadowDistance * preset.splits[i];
      let c = (f + n) * (1 + k2) * 0.5; if (c > f) c = f;  // centre on axis equidistant to near/far corners (clamped to far plane)
      const r = Math.sqrt((f - c) * (f - c) + f * f * k2) * PAD[i];
      const texel = 2 * r / size;
      const ctr = this._c.copy(cam.position).addScaledVector(fwd, c);
      const lx = Math.round(ctr.dot(x) / texel) * texel, ly = Math.round(ctr.dot(y) / texel) * texel, lz = ctr.dot(z);
      ctr.set(0, 0, 0).addScaledVector(x, lx).addScaledVector(y, ly).addScaledVector(z, lz);
      const back = r + BACK;
      l.target.position.copy(ctr);
      l.position.copy(ctr).addScaledVector(dir, back);
      const sc = sh.camera;
      sc.up.copy(up); sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 1; sc.far = back + r + 10;
      sc.updateProjectionMatrix();
      sh.normalBias = texel * (NORMAL_BIAS_TEXELS + PCF_RADIUS[i] * 0.4); // wider PCF samples farther texels: grow bias with it (no grazing-angle acne)
      sh.bias = -texel * BIAS_TEXELS / (sc.far - sc.near);
      sh.radius = PCF_RADIUS[i];
      this.shadowUniforms.uCsmParams.value[i].set(sh.bias, sh.normalBias, sh.radius, 1 / size);
      this.shadowUniforms.uCsmMap.value[i] = sh.map.depthTexture; this.shadowUniforms.uCsmMatrix.value[i] = sh.matrix;
    }
  }

  // ---------- env map ----------
  _skyLum() { const s = this.game.sky; return 0.05 + s.skyColor.r + s.skyColor.g + s.skyColor.b + s.horizonColor.r + s.horizonColor.g + s.horizonColor.b; }
  _skyDelta() {
    const s = this.game.sky, g = this._envSig, c = [s.skyColor, s.horizonColor, s.groundColor, s.sunColor];
    let d = 0;
    for (let i = 0; i < 4; i++) { d = Math.max(d, Math.abs(c[i].r - g[i * 3]), Math.abs(c[i].g - g[i * 3 + 1]), Math.abs(c[i].b - g[i * 3 + 2])); }
    return d;
  }
  bakeEnv() {
    const s = this.game.sky, u = this._envMat.uniforms, g = this._envSig;
    u.zenith.value.copy(s.skyColor); u.horizon.value.copy(s.horizonColor); u.ground.value.copy(s.groundColor);
    u.sunDir.value.copy(s.sunDir); u.sunColor.value.copy(s.sunColor); u.sunI.value = this._sunI ?? 1;
    u.moonDir.value.copy(s.moonDir ?? this._v.copy(s.sunDir).negate()); u.moonI.value = this._moonI ?? 0;
    const c = [s.skyColor, s.horizonColor, s.groundColor, s.sunColor];
    for (let i = 0; i < 4; i++) { g[i * 3] = c[i].r; g[i * 3 + 1] = c[i].g; g[i * 3 + 2] = c[i].b; }
    const rt = this.pmrem.fromScene(this._envScene, 0, 1, 100, { size: 64 });
    const old = this.env; this.env = rt;
    this.game.scene.environment = rt.texture;
    old?.dispose();
    this._envHour = s.hour; this._envT = this.game.time; this._envLum = this._skyLum();
  }

  // ---------- custom materials ----------
  setupShadowMaterial(mat) {
    mat.uniforms = Object.assign(mat.uniforms || {}, this.shadowUniforms);
    mat.defines = Object.assign(mat.defines || {}, { AETHER_CSM: this.cascades.length });
    mat.needsUpdate = true;
    return mat;
  }

  // ---------- debug ----------
  showCascades(on = true) {
    this.game.scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (!m.isMeshStandardMaterial && !m.isMeshLambertMaterial && !m.isMeshPhongMaterial) continue;
        m.defines = m.defines || {};
        if (on) m.defines.AETHER_CSM_DEBUG = 1; else delete m.defines.AETHER_CSM_DEBUG;
        m.needsUpdate = true;
      }
    });
  }

  dispose() {
    for (const l of this.cascades) { this.game.scene.remove(l, l.target); l.shadow.map?.dispose(); l.dispose(); }
    this.game.scene.remove(this.hemi);
    this.env?.dispose(); this.pmrem.dispose();
    if (this.game.scene.environment === this.env?.texture) this.game.scene.environment = null;
  }
}
