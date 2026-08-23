import * as THREE from 'three';

export const QUALITY = {
  low:    { pixelRatio: 0.75, shadowMap: 1024, anisotropy: 4,  msaa: 0 },
  medium: { pixelRatio: 1.0,  shadowMap: 2048, anisotropy: 8,  msaa: 0 },
  high:   { pixelRatio: 1.0, shadowMap: 2048, anisotropy: 16, msaa: 0 },   // perf: dpr 1.25-1.5 was shading 1.6-2.25x the pixels of 1080p — the single biggest q=high cost; SMAA carries the edges
};

export function createRenderer(canvas, quality = 'high') {
  const q = QUALITY[quality] ?? QUALITY.high;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true, alpha: false });
  renderer.setPixelRatio(q.pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // PostFX may override (tone mapping done in composer)
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;
  renderer.qualityPreset = q;
  return renderer;
}

// ---------------------------------------------------------------------------------------------
let _warmRT = null;
/**
 * compile() the way the game actually DRAWS. Never call renderer.compile() directly — call this.
 *
 * `outputColorSpace` is the SECOND field of the program cache key (WebGLPrograms.getProgramCacheKeyParameters),
 * and getParameters reads it as `currentRenderTarget === null ? renderer.outputColorSpace : workingColorSpace`.
 * Every pixel of this game is drawn through composer.render(), i.e. INTO a render target, so every program it
 * actually uses is keyed `srgb-linear`. A compile() with nothing bound builds the `srgb` twin instead: a real
 * program, fully linked, that the renderer will never look up — and the one it needs still links on first draw.
 *
 * MEASURED 2026-08-23: warming this way left the program count 41 HIGHER than not warming at all, while the
 * real programs still linked during play — worst frame 6502 ms, with the page's own CPU idle at 35 ms, because
 * an ANGLE/D3D11 link blocks inside the GPU PROCESS where neither cpuMs nor gpuMs can see it. Binding a target
 * took the programs linked during one combat session from 44 to 1.
 *
 * The scratch target is 4x4 and shared: only its EXISTENCE changes the cache key, never its size or contents.
 * Bind and restore inside one synchronous span — the game loop starts before boot warmup finishes (main.js
 * chains game.start() on game.ready separately), so a target left bound across an await eats a real frame.
 */
export function compileForComposer(renderer, scene, camera) {
  _warmRT ??= new THREE.WebGLRenderTarget(4, 4);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(_warmRT);
  try { renderer.compile(scene, camera); } finally { renderer.setRenderTarget(prev); }
}

/**
 * One real render into the scratch target, shadows forced. Needed because `compile()` cannot build depth or
 * distance programs AT ALL — `getDepthMaterial` is only reachable from `WebGLShadowMap.render()`, which only
 * runs inside `renderer.render()`. Without this the shadow variants link on the first frame that casts one.
 * Bound, so it never paints over the loading screen and its main-pass programs get the composer's colorspace.
 */
export function renderForComposer(renderer, scene, camera) {
  _warmRT ??= new THREE.WebGLRenderTarget(4, 4);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(_warmRT);
  renderer.shadowMap.needsUpdate = true;
  try { renderer.render(scene, camera); } finally { renderer.setRenderTarget(prev); }
}
