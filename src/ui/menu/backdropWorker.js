/**
 * The title screen's backdrop, running on its own thread.   (orchestrator)
 *
 * WHY: while the world builds, the main thread blocks for seconds at a stretch (World ~6.4 s, Lighting
 * ~2.5 s, the first-render shader link ~16 s). While JS runs, no frame paints — chunking only shortens
 * the freezes. Off-thread, a blocked main thread cannot touch the backdrop at all, so the title screen
 * and the loading bar keep moving through every one of them.
 *
 * It also fetches its own still, so the one asset on the critical path never queues behind the main
 * thread's work. index.html preloads the same URL, so this is a memory-cache hit.
 *
 * Protocol (the other half is src/ui/Menu.js):
 *   in   init {canvas, size, still}   size {w,h}   live {bitmap}   set {push,warp,dim,calm,mouse}   stop
 *   out  ready   firstFrame   fps {n}   error {message}
 *
 * Deliberately imports ONLY backdrop.js — no three, no engine. A worker has its own module graph, so an
 * import of three here would mean downloading and parsing the whole engine a second time, on the one
 * thread whose entire job is to be available immediately.
 */
import { Backdrop } from './backdrop.js';

let bd = null, raf = 0, last = 0, frames = 0, stopped = false, paused = false, resume = () => {}, layerSeq = 0;

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'init') {
      bd = new Backdrop(m.canvas);
      if (!bd.ok) { self.postMessage({ type: 'error', message: 'webgl2 unavailable: ' + (bd.error || '') }); return; }
      bd.setSize(m.size.w, m.size.h);
      self.postMessage({ type: 'ready' });
      last = performance.now();
      const loop = () => {
        if (stopped || paused) return;
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.1); last = now;
        bd.frame(dt);
        if (++frames === 1) self.postMessage({ type: 'firstFrame' });
      };
      resume = loop;
      loop();
      // the still is fetched here, not shipped in: the main thread has a world to build
      if (m.still) {
        fetch(m.still, { cache: 'force-cache' })
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('http ' + r.status))))
          .then((b) => createImageBitmap(b, { imageOrientation: 'flipY' }))
          .then((bmp) => bd?.setStill(bmp))
          .catch(() => { /* no vista committed yet: the procedural sky carries the screen */ });
      }
      return;
    }
    if (!bd) return;
    if (m.type === 'size') bd.setSize(m.w, m.h);
    else if (m.type === 'live') bd.setLive(m.bitmap);
    // cadle.gg walks the world as you scroll. The FETCH happens here, on this thread: the main thread
    // has a page to scroll, and decoding a 200 KB JPEG on it is a dropped frame at exactly the moment
    // the user is moving. `seq` drops a response that arrived after a newer one was asked for.
    else if (m.type === 'layer') {
      const seq = ++layerSeq;
      fetch(m.url, { cache: 'force-cache' })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('http ' + r.status))))
        .then((b) => createImageBitmap(b, { imageOrientation: 'flipY' }))
        .then((bmp) => { if (seq === layerSeq && bd) { if (m.fade) bd.fadeSecs = m.fade; bd.crossTo(bmp); } else bmp.close(); })
        .catch(() => {});
    }
    else if (m.type === 'set') bd.set(m);
    else if (m.type === 'fps') self.postMessage({ type: 'fps', n: frames });
    // the landing page pauses the hero once it has scrolled out of view, and on tab hide — a backdrop
    // nobody can see has no business holding the GPU
    else if (m.type === 'pause') { if (!paused) { paused = true; cancelAnimationFrame(raf); } }
    else if (m.type === 'resume') { if (paused && !stopped) { paused = false; last = performance.now(); resume(); } }
    else if (m.type === 'stop') { stopped = true; cancelAnimationFrame(raf); bd.dispose(); bd = null; }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack || err) });
  }
};
