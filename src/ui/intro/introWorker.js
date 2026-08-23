/**
 * The intro's renderer, running in a Web Worker on an OffscreenCanvas.  (orchestrator)
 *
 * WHY: the loading screen and the game's world build used to share one thread and one GL context, so
 * every long synchronous build (World ~6.4 s, Lighting ~2.5 s, the first-render shader compile ~16 s)
 * froze the loading screen with it. No amount of chunking fixes that — while JS runs, no frame paints.
 * Here the intro owns its own thread and its own context, so a blocked main thread cannot touch it.
 * Measured in the spike: +179 intro frames rendered during a deliberate 3 s main-thread freeze.
 *
 * The monitor still shows the REAL game: the main thread ships frames of the game's canvas across as
 * ImageBitmaps (0.1 ms each, zero-copy transfer) and they land on the panel. When the game is blocked the
 * monitor holds its last frame — which is honest, and reads as a game mid-load rather than a broken page.
 *
 * Protocol (see IntroHost.js for the other half):
 *   in   init {canvas, size, params, seed}  progress {p,label}  monitor {bitmap}  arm  click  resize  hold  skip
 *   out  ready  firstFrame  armed  whoosh  handover  skipped  error
 */
import * as THREE from 'three';
import { Intro } from '../Intro.js';

let intro = null;

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'init') {
      const renderer = new THREE.WebGLRenderer({ canvas: m.canvas, antialias: false, powerPreference: 'high-performance' });
      renderer.setPixelRatio(1);                       // the worker canvas is already sized in device px
      renderer.setSize(m.size.w, m.size.h, false);
      // A host shaped like `game` but with only what the intro actually touches. No stepInto: that is the
      // signal to Intro that the live monitor comes from shipped frames instead (see Intro._arm).
      const host = {
        renderer,
        canvas: m.canvas,
        params: new URLSearchParams(m.params || ''),
        seed: m.seed ?? 1337,
        auto: false,
        size: m.size,
      };
      intro = new Intro(host);
      intro.onArmed = () => self.postMessage({ type: 'armed' });
      intro.onHandover = () => self.postMessage({ type: 'handover' });
      intro.onSkip = () => self.postMessage({ type: 'skipped' });
      intro.onWhoosh = () => self.postMessage({ type: 'whoosh' });
      intro.onFlash = () => self.postMessage({ type: 'flash' });
      intro.firstFrame.then(() => self.postMessage({ type: 'firstFrame' }));
      intro.finished.then((played) => self.postMessage({ type: 'finished', played }));
      await intro.init();
      // ?debug=1: report the worker's own frame rate. This is the number that proves the decoupling —
      // it should stay ~60 while the main thread is blocked solid building the world.
      if (host.params.get('debug') === '1') {
        let last = 0;
        setInterval(() => {
          const n = intro._n | 0;
          self.postMessage({ type: 'fps', frames: n, delta: n - last });
          last = n;
        }, 1000);
      }
      self.postMessage({ type: 'ready' });
      return;
    }
    if (!intro) return;
    if (m.type === 'progress') intro.setProgress(m.p, m.label);
    else if (m.type === 'monitor') intro.setMonitorFrame(m.bitmap);
    else if (m.type === 'arm') intro.arm();
    else if (m.type === 'click') intro._onClick();
    else if (m.type === 'resize') intro.resize(m.w, m.h);
    else if (m.type === 'hold') intro.hold();
    else if (m.type === 'skip') intro.skip();
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.stack) || err) });
  }
};
