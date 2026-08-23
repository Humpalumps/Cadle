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
const CSS = [
  '#introui{position:fixed;inset:0;z-index:60;pointer-events:none;display:flex;align-items:flex-end;justify-content:center;padding-bottom:6vh}',
  '#introui .cta{margin:0;font:400 15px/1 Georgia,serif;letter-spacing:6px;color:#f0e2bf;text-shadow:0 0 18px rgba(0,0,0,.8);opacity:.9}',
  '#introflash{position:fixed;inset:0;z-index:70;background:#fff;opacity:0;pointer-events:none}',
  '#introflash.on{opacity:1}',
  '#introflash.off{opacity:0;transition:opacity .85s ease}',
].join('\n');

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
    else if (m.type === 'armed') this._armed = true;
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
