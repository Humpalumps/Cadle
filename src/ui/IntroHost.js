import * as THREE from 'three';

/**
 * Main-thread half of the cinematic intro.  (orchestrator)
 *
 * Owns everything the worker cannot: the DOM (click prompt, flash, hiding the HUD), input, the whoosh,
 * the hand-off to the game, and the bridge that ships the game's frames onto his monitor. The rendering
 * half lives in intro/introWorker.js. The public API matches the old main-thread Intro, so src/main.js
 * does not care which one it got: init() attach(game) setProgress() arm() hold() skip(), plus the
 * `firstFrame` and `finished` promises.
 *
 * WHY THIS EXISTS: the loading screen and the world build used to share one thread, so every long
 * synchronous build (World ~6.4 s, Lighting ~2.5 s, the first-render compile ~16 s) froze the intro with
 * it. Chunking only shortened the freezes; while JS runs, no frame paints. Off-thread, a blocked main
 * thread cannot touch the intro at all.
 *
 * Falls back to the main-thread Intro when OffscreenCanvas is unavailable (or ?worker=0).
 */
// The intro's own stylesheet, verbatim from Intro.js. Writing a fresh one here is what turned the
// prompt into a small grey caption at the bottom instead of the gold small-caps title-screen
// prompt with rules either side — and dropped the `armed` reveal with it.
const CSS = `
#introui{position:fixed;inset:0;z-index:120;font-family:Georgia,'Palatino Linotype',serif;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:16px;padding-bottom:6vh;background:transparent}
/* The call to action has to be unmissable — it is the only instruction on the page. Gold on a soft
   dark plate, wide tracking, breathing, with a rule either side so it reads as a title-screen prompt
   rather than a caption. */
#introui .cta{margin:0 0 2vh;font-size:clamp(19px,2.35vw,34px);letter-spacing:.5em;text-indent:.5em;
  font-variant:small-caps;color:#f7eed6;padding:.62em 1.5em;border-radius:2px;
  background:linear-gradient(90deg,rgba(9,6,20,0),rgba(9,6,20,.72) 18%,rgba(9,6,20,.72) 82%,rgba(9,6,20,0));
  text-shadow:0 0 26px rgba(211,165,72,.85),0 0 6px rgba(211,165,72,.6),0 2px 10px #000;
  opacity:0;transition:opacity 1s ease;animation:introPulse 2.4s ease-in-out infinite}
#introui .cta::before,#introui .cta::after{content:'';position:absolute;top:50%;width:clamp(40px,7vw,120px);height:1px;
  background:linear-gradient(90deg,rgba(211,165,72,0),rgba(211,165,72,.9))}
#introui .cta::before{right:calc(100% + 10px)}
#introui .cta::after{left:calc(100% + 10px);transform:scaleX(-1)}
#introui.armed .cta{opacity:1}
@keyframes introPulse{0%,100%{filter:brightness(.8)}50%{filter:brightness(1.35)}}
#introflash{position:fixed;inset:0;z-index:130;pointer-events:none;opacity:0;transition:opacity .16s ease-in;
  background:radial-gradient(58% 58% at 50% 50%,#efe9ff 0%,#b9a2ff 34%,#6b4fd0 62%,#160f30 100%)}
#introflash.on{opacity:1}
#introflash.off{opacity:0;transition:opacity .7s cubic-bezier(.2,.7,.3,1)}`;

export class IntroHost {
  constructor(host) {
    this.host = host;
    this.canvas = host.introCanvas;
    this.gameCanvas = host.canvas;
    this.done = false;
    this._armed = false;
    this.finished = new Promise((r) => { this._resolve = r; });
    this.firstFrame = new Promise((r) => { this._resolveFirst = r; });
  }

  attach(game) { this._game = game; return this; }

  async init() {
    const style = document.createElement('style'); style.id = 'introcss'; style.textContent = CSS;
    document.head.appendChild(style); this._style = style;
    this._ui = document.getElementById('ui');
    if (this._ui) this._ui.style.display = 'none';

    const ui = document.createElement('div'); ui.id = 'introui';
    ui.innerHTML = '<p class="cta">click or press any key</p>';
    document.body.appendChild(ui); this._clickUI = ui;
    const flash = document.createElement('div'); flash.id = 'introflash';
    document.body.appendChild(flash); this._flash = flash;

    const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';

    const off = this.canvas.transferControlToOffscreen();
    this.worker = new Worker(new URL('./intro/introWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onMessage(e.data || {});
    this.worker.postMessage({
      type: 'init', canvas: off, size: { w: this.canvas.width, h: this.canvas.height },
      params: String(this.host.params || ''), seed: this.host.seed,
    }, [off]);

    this._onWinClick = () => this._click();
    this._onWinKey = (e) => { if (!e.repeat) this._click(); };
    window.addEventListener('click', this._onWinClick);
    window.addEventListener('keydown', this._onWinKey);
    this._onResize = () => {
      const W = innerWidth, H = innerHeight, d = Math.min(devicePixelRatio || 1, 2);
      this.canvas.style.width = W + 'px'; this.canvas.style.height = H + 'px';
      this.worker?.postMessage({ type: 'resize', w: Math.round(W * d), h: Math.round(H * d) });
    };
    window.addEventListener('resize', this._onResize);
    return this;
  }

  _onMessage(m) {
    if (m.type === 'firstFrame') { document.getElementById('splash')?.remove(); this._resolveFirst?.(); }
    else if (m.type === 'armed') { this._armed = true; this._clickUI?.classList.add('armed'); }
    else if (m.type === 'whoosh') this._whoosh();
    else if (m.type === 'flash') this._flash?.classList.add('on');
    else if (m.type === 'handover') this._handover();
    else if (m.type === 'skipped') this._finish(false);
    else if (m.type === 'fps') { this.workerFps = m.delta; (window.__introFps ||= []).push(m.delta); }
    else if (m.type === 'error') { console.error('[intro worker]', m.message); this.skip(); }
  }

  // ---------------------------------------------------------------- the true monitor
  /** Ship a frame of the REAL game onto his screen. ~0.1 ms and zero-copy, so it can run while the world
   *  builds; when the main thread is blocked no frame is produced and the monitor holds its last one —
   *  which is exactly what a game mid-load looks like, rather than a broken page. */
  _shipFrame() {
    if (this.done || !this.worker || !this._game) return;
    const g = this._game;
    // RENDER the world first. Nothing draws the game until game.start(), which does not happen until
    // hand-off — so without this the canvas is still blank and the monitor showed a black screen with
    // just the title on it. stepInto is what the old in-thread intro used for exactly this, and the
    // system list is the same one: only what makes the world LOOK alive, not rpg/audio/hud/enemies.
    if (!g._running) {
      try {
        this._menuCam ||= new THREE.PerspectiveCamera(58, 16 / 9, 0.05, 4000);
        this._liveSystems ||= [g.sky, g.lighting, g.terrain, g.world, g.player, g.vfx].filter(Boolean);
        this._menuCam.aspect = (this.gameCanvas.width || 16) / (this.gameCanvas.height || 9);
        this._menuCam.updateProjectionMatrix();
        this._menuCam.position.copy(g.camera.position);
        this._menuCam.quaternion.copy(g.camera.quaternion);
        g.stepInto(1 / 30, null, this._liveSystems, this._menuCam);
      } catch (e) { /* a system not ready yet: skip this frame, try the next */ }
    }
    const src = this.gameCanvas;
    if (!src || !src.width) return;
    createImageBitmap(src).then((bmp) => {
      if (this.done || !this.worker) { bmp.close(); return; }
      this.worker.postMessage({ type: 'monitor', bitmap: bmp }, [bmp]);
    }).catch(() => {});
  }

  /** start feeding the monitor once there is a world worth looking at */
  startMonitor(everyMs = 120) {
    if (this._monTimer) return;
    this._monTimer = setInterval(() => this._shipFrame(), everyMs);
  }

  setProgress(p, label) {
    this.worker?.postMessage({ type: 'progress', p, label: label || null });
    if (!this._armed) document.title = 'CADLE — loading ' + Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
  }

  arm() { this.worker?.postMessage({ type: 'arm' }); document.title = 'CADLE'; }
  hold() { this.worker?.postMessage({ type: 'hold' }); return true; }
  _click() { if (!this.done) this.worker?.postMessage({ type: 'click' }); }

  _handover() {
    const g = this._game;
    this._flash?.classList.add('on');
    this._clickUI?.remove(); this._clickUI = null;
    clearInterval(this._monTimer); this._monTimer = null;
    this.canvas.style.transition = 'opacity .25s ease';
    this.canvas.style.opacity = '0';
    if (this._ui) {
      this._ui.style.display = '';
      this._ui.style.opacity = '0';
      this._ui.style.transition = 'opacity .9s ease';
      setTimeout(() => { if (this._ui) { this._ui.style.opacity = '1'; setTimeout(() => { this._ui.style.transition = ''; }, 1000); } }, 260);
    }
    if (!document.pointerLockElement && g) {
      g.paused = false;
      try { g.hud?.settings?.hide?.(); } catch (e) {}
    }
    try { g?.start(); } catch (e) { console.error(e); }
    // Cleanup on a TIMER, not on rAF. g.start() above kicks off the game's first render, which compiles
    // the world's shaders and blocks the main thread for seconds — rAF callbacks queued behind it landed
    // anywhere between 1 s and never, leaving a dead canvas and a live GL context over the running game.
    // setTimeout still waits for the thread, but it does not wait for a FRAME, which is the part that
    // was being starved.
    setTimeout(() => { this._killWorker(); }, 1200);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._flash?.classList.remove('on');
      this._flash?.classList.add('off');
      setTimeout(() => { this._flash?.remove(); this._flash = null; }, 900);
    }));
    this._finish(true);
  }

  skip() { this.worker?.postMessage({ type: 'skip' }); this._finish(false); }

  _finish(played) {
    if (this.done) return;
    this.done = true;
    clearInterval(this._monTimer); this._monTimer = null;
    window.removeEventListener('click', this._onWinClick);
    window.removeEventListener('keydown', this._onWinKey);
    window.removeEventListener('resize', this._onResize);
    this._clickUI?.remove(); this._clickUI = null;
    if (this._ui) this._ui.style.display = '';
    this._style?.remove();
    if (!played) this._killWorker();   // played: _handover kills it once the fade is done
    this._resolveFirst?.();
    this._resolve?.(played);
  }

  /** drop the worker and its canvas together; safe to call twice */
  _killWorker() {
    try { this.worker?.terminate(); } catch (e) {}
    this.worker = null;
    this.canvas?.remove();
    this.canvas = null;
  }

  _whoosh() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = new AC(), t0 = ac.currentTime;
      const n = ac.createBufferSource();
      const buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
      n.buffer = buf;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(180, t0); bp.frequency.exponentialRampToValueAtTime(4200, t0 + 1.35);
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.34, t0 + 1.25);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.75);
      n.connect(bp).connect(ng).connect(ac.destination);
      n.start(t0); n.stop(t0 + 1.9);
      const o = ac.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(70, t0); o.frequency.exponentialRampToValueAtTime(660, t0 + 1.4);
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
      const og = ac.createGain();
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.16, t0 + 1.3);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.7);
      o.connect(lp).connect(og).connect(ac.destination);
      o.start(t0); o.stop(t0 + 1.8);
      setTimeout(() => ac.close().catch(() => {}), 2600);
    } catch (e) {}
  }
}

/** true when the intro can run off-thread; ?worker=0 forces the old main-thread path */
export function canUseIntroWorker(params) {
  return typeof OffscreenCanvas !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && !!HTMLCanvasElement.prototype.transferControlToOffscreen
    && params?.get?.('worker') !== '0';
}
