/**
 * Tiny context shims so the intro's scene code runs BOTH on the main thread and inside a worker.
 * (orchestrator)
 *
 * The intro renders in a Web Worker on an OffscreenCanvas so that the game's world build — which blocks
 * the main thread for seconds at a time — cannot stutter the loading screen. Workers have no `document`,
 * so the two things the scene code reached for have to be routed:
 *
 *   makeCanvas()  document.createElement('canvas')  ->  OffscreenCanvas
 *   loadTexture() THREE.TextureLoader (needs Image) ->  fetch + createImageBitmap
 *
 * Both keep working unchanged on the main thread, so intro.html and any non-worker fallback still run.
 */
import * as THREE from 'three';

/** a 2D-capable canvas in either context */
export function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

/** THREE.TextureLoader replacement: no Image element, so it works in a worker */
export async function loadTexture(url, { srgb = true, tile = false, aniso = 8 } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  // imageOrientation flipY + texture.flipY=false reproduces exactly what <img> + flipY=true did.
  // Without this every texture is upside down — invisible on tiling ground, obvious on the posters.
  const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'flipY' });
  const t = new THREE.Texture(bmp);
  t.flipY = false;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (tile) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
