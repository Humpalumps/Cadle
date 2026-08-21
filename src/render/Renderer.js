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
