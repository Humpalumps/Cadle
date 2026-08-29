/**
 * Menu: the title screen and the loading screen.   (orchestrator)
 *
 * Replaces the old cinematic intro (a bedroom, a character and 304 KB of textures that had to download,
 * build and render before anything appeared). This is a Destiny-style main menu: the art is on the
 * right, the type is on the left, you pick Play, the items sweep out and a loading bar takes their place.
 *
 * THE TWO THINGS THIS FILE IS OPTIMISED FOR, IN ORDER:
 *
 * 1. **It is already on screen before this file runs.** The markup and every style it needs are inline
 *    in index.html, so the browser paints a finished title screen during HTML parse. This module only
 *    attaches behaviour to nodes that already exist. It imports NOTHING but its own backdrop — in
 *    particular not three, so main.js can defer the entire engine until after the menu is up.
 *
 * 2. **Nothing it shows can be frozen by the world build.** The backdrop runs in a Web Worker on an
 *    OffscreenCanvas; the ramps inside it are driven by the worker's own clock (see backdrop.js `set`).
 *    Everything in the DOM animates transform/opacity only, so it runs on the compositor, and the
 *    loading bar's fill is a long linear CSS transition rather than a per-frame width — a five-second
 *    main-thread stall cannot stop any of it. That is the difference between a loading screen and a
 *    frozen page that happens to have a bar on it.
 *
 * 3. **Nothing loads until Play** (user decision 2026-08-28). Landing here builds no renderer, no Game,
 *    no 29 MB asset preload and no terrain. `play()` calls `onPlay` — main.js's boot() — and only then
 *    does the world start, behind the bar the player just asked for. `?start` (the Play button on the
 *    landing page at /) does the same thing without showing the menu first.
 *
 * The backdrop is a still of the real game (public/assets/ui/menu_vista.jpg, captured through the same
 * lens `CAM` describes) plus a shader layer over it — sun shafts, drifting aether, haze, parallax,
 * grain — with a procedural sky standing in for the frames before the image has decoded. It is never a
 * live render: there is no world to render until Play, which is the point.
 *
 * Wiring (src/main.js): new Menu(host) -> menu.init() -> Play -> onPlay() builds the game ->
 * attach(game) -> setProgress() from 'assets:progress' / 'boot:progress' -> prewarm() -> arm() when
 * game.ready resolves -> `finished` resolves once the game owns the canvas.
 *
 * Kept from the old intro because tools depend on them: `window.__game.intro` is this object, and
 * skip() / hold() / setProgress() / arm() / prewarm() behave the same (tools/gate.mjs, questgate.mjs,
 * introprobe.mjs). skip() now also boots, because for the harness it means "get on with it".
 */
import { Backdrop } from './menu/backdrop.js';
// The ONE pointer-lock path in the app (tools/invariants.mjs rule (a)). Imported statically and not
// pulled off `game` because the lock has to be taken inside the Play click's transient activation, and
// at that moment the engine may still be downloading — `game` does not exist yet. Input.js has no
// imports of its own, so this costs the menu chunk ~2 KB and keeps it engine-free.
import { Input } from '../core/Input.js';

const STILL = '/assets/ui/menu_vista.jpg';

/**
 * Where the title screen looks from — an OFFSET FROM THE PLAYER, not a world position, and a small one.
 *
 * Grass is the reason. Terrain and vegetation LOD both follow `game.camera`, so they come with us, but
 * Grass.js builds its three rings around `game.player.position` (18 / 60 / 116 m at q=high) and the
 * player never moves while the menu is up. Park the camera 100 m away and the meadow renders as a flat
 * green lawn — measured, see the first capture pass. Inside the near ring it is a field of blades.
 * The dive then also lands you roughly where the camera was standing, which is the point.
 *
 * `fov` is narrow on purpose: 95 deg is a gameplay lens, and a title card wants a longer one.
 */
const CAM = { dx: 5.5, dz: 11.0, eye: 6.0, yaw: 0.32, pitch: -0.05, fov: 55 };
/**
 * The menu pins the clock here, and 19.6 is the Vale's best hour: aurora, stars, rose-lit mountain ring,
 * and the waystone reading as the brightest thing in frame. It also leaves the left third dark, which is
 * where the type goes. Pinning it at all is a bug fix as much as a look: the day cycle is 20 real minutes,
 * so an unattended title screen would otherwise drift into a different sky every few minutes.
 * The clock and everything else the menu borrows is restored exactly as found at hand-off (_teardown).
 */
const MENU_HOUR = 19.6;

const TIPS = [
  'Momentum is the point. Sprint, slide, then jump — the Vale is built for people who never stop moving.',
  'Every region has its own sky. If the air changes colour around you, so have the rules.',
  'Aether pools where the world broke. So does everything that learned to feed on it.',
  'Aim down sights to steady a shot. Hip fire is for whatever is already close enough to touch you.',
  'The mountain ring is not a wall. Nine passes cut through it, one for each of the outer regions.',
  'Reload between fights, not during them. An empty magazine is the loudest sound in the Vale.',
  'The Sundered Spire was a bell tower, once. Something on the other side answered it.',
];

const PANELS = {
  world: `<h2>The Vale</h2><p class="lead">Ten regions, one broken sky.</p>
    <p>The Sundering tore the world open and left the Vale at the centre of it — a green bowl ringed by
    mountains, with nine other places pressed up against its edges. Everything out there is still
    running on what leaked through.</p>
    <ul>
      <li><b>The Vale</b>Meadow, lake and ruins<i>1–10</i></li>
      <li><b>Whisperwood</b>Closed canopy, fae light<i>5–11</i></li>
      <li><b>Frostveil</b>Buried conifers, frozen lake<i>11–17</i></li>
      <li><b>Shadowfen</b>Peat murk and dead wood<i>15–22</i></li>
      <li><b>Infernal Wastes</b>Caldera and lava rivers<i>18–25</i></li>
      <li><b>Sunken Kingdom</b>Rapids over a drowned court<i>20–28</i></li>
      <li><b>Dragon Peaks</b>200 m spires, nest ledges<i>24–32</i></li>
      <li><b>Celestial Isles</b>Marble plateau, floating isles<i>30–38</i></li>
      <li><b>The Void</b>Shelves over an abyss<i>34–44</i></li>
      <li><b>The Lost Realm</b>Sixteen monoliths<i>40–50</i></li>
    </ul>`,
  controls: `<h2>Controls</h2><p class="lead">Mouse and keyboard. The mouse locks when you take the field.</p>
    <ul>
      <li><b>Move</b>W A S D</li>
      <li><b>Sprint</b>Shift</li>
      <li><b>Jump · double jump</b>Space</li>
      <li><b>Slide · crouch</b>Ctrl</li>
      <li><b>Fire</b>Left mouse</li>
      <li><b>Aim</b>Right mouse</li>
      <li><b>Reload</b>R</li>
      <li><b>Swap weapon</b>1 · 2</li>
      <li><b>Grenade</b>G</li>
      <li><b>Melee</b>F</li>
      <li><b>Grapple</b>Q</li>
      <li><b>Interact</b>E</li>
      <li><b>Map · character · bag</b>M · C · I</li>
      <li><b>Skills · quests</b>K · J</li>
      <li><b>Pause</b>Esc</li>
    </ul>`,
  credits: `<h2>Credits</h2><p class="lead">Cadle — a browser FPS-RPG.</p>
    <p>Built on Three.js and WebGL2. Terrain, weather, creatures, weapons, music and every effect in the
    Vale are generated in code and shipped in the page — no streaming, no CDN, nothing to install.</p>
    <p>Reference points, openly: <i>Destiny 2</i> for how it feels in the hand, <i>Final Fantasy XIV</i>
    for how the light falls.</p>
    <p class="note">v0.1.0 · runs best in a Chromium browser with hardware acceleration on</p>`,
};

const QUALITIES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

/** the bar's animation timeline, in ms: position = progress * UNIT. Arbitrary, just big enough that a
 *  1% step is 1000 ticks of resolution. */
const UNIT = 1e5;

export class Menu {
  /** `host` is a minimal boot context — { canvas, params, seed, auto } — NOT the Game. main.js calls
   *  attach(game) once the engine chunk has landed; nothing before arm() needs it. */
  constructor(host) {
    this.host = host;
    this.params = host.params;
    this.auto = !!host.auto;
    this.done = false;
    this.active = false;
    this._progress = 0;
    this._ready = false;
    this._playing = false;
    this._sel = 0;
    this._panel = null;
    this.finished = new Promise((r) => { this._resolve = r; });
    this.firstFrame = new Promise((r) => { this._resolveFirst = r; });
  }

  attach(game) { this.game = game; return this; }

  // ---------------------------------------------------------------- boot
  async init() {
    // the harness calls skip() the moment __game exists, which can be before this runs; without this
    // guard it would build a backdrop worker nobody will ever tear down
    if (this.done) return this;
    const $ = (id) => document.getElementById(id);
    this.el = {
      menu: $('menu'), nav: $('nav'), panel: $('panel'), load: $('load'),
      canvas: $('menucanvas'), flash: $('flash'), ui: $('ui'), splash: $('splash'),
    };
    if (!this.el.menu) throw new Error('index.html is missing the #menu markup');
    this.el.phase = this.el.load.querySelector('.phase');
    this.el.pct = this.el.load.querySelector('.pct');
    this.el.track = this.el.load.querySelector('.track');
    this.el.fill = this.el.load.querySelector('.fill');
    this.el.cap = this.el.load.querySelector('.cap');
    this.el.tip = this.el.load.querySelector('.tip');
    this.el.err = this.el.load.querySelector('.err');
    this.el.ui.style.display = 'none';               // the game's HUD is built during boot; keep it off the menu
    this._buildPct();

    this._startBackdrop();
    this._wire();
    this._nextTip();
    this._tipTimer = setInterval(() => this._nextTip(), 9000);
    this.active = true;
    // ?start — arriving from the Play button on the landing page. Identical to pressing Play here, and
    // index.html has already put the menu in its loading state so there is no flash of the nav first.
    if (this.params.has('start')) this.play();
    // They pressed Play before this module landed — index.html's inline script caught it. The pointer
    // lock may or may not still be inside the click's transient activation by now; if it is not, the
    // HUD's start hint covers it, exactly as it does for ?start. A dead button is the worse failure.
    else if (window.__earlyPlay) this.play();
    // the harness: nobody is here to click, so play by itself. Scheduled from init and not from arm()
    // because arm() no longer happens on its own — nothing builds the world until play() asks for it.
    else if (this.auto && !this._held && this.params.get('hold') !== '1') this._autoTimer = setTimeout(() => this.play(), 4000);
    return this;
  }

  /** dev/harness only: build the world WITHOUT entering it, so tools can render through the menu camera
   *  (see shot()). Players never take this path — Play is play(). */
  buildWorld() { return this.onPlay?.(); }

  /** The backdrop prefers its own thread. ?worker=0, no OffscreenCanvas or no WebGL2 all fall back —
   *  first to an in-thread Backdrop, and finally to the CSS gradient already painted on the canvas. */
  _startBackdrop() {
    const c = this.el.canvas;
    // prefers-reduced-motion means the drifting shader too, not just the ornaments. The backdrop's
    // whole content is the still underneath it, so show that: same picture, no motion, no worker, no
    // WebGL context at all. (The CSS block in index.html stops everything else on the screen moving.)
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      c.classList.add('still');
      this._onFirstFrame();
      return;
    }
    const dpr = Math.min(devicePixelRatio || 1, 2);
    // A soft painterly backdrop does not need more than ~1440p of real pixels, and this is the one thing
    // on screen while a whole game engine is being compiled behind it. Cap it and give the GPU back.
    const scale = Math.min(1, 2560 / Math.max(1, innerWidth * dpr));
    this._px = () => [Math.round(innerWidth * dpr * scale), Math.round(innerHeight * dpr * scale)];
    const [w, h] = this._px();

    const useWorker = typeof OffscreenCanvas !== 'undefined'
      && !!c.transferControlToOffscreen && this.params.get('worker') !== '0';
    if (useWorker) {
      try {
        c.width = w; c.height = h;
        const off = c.transferControlToOffscreen();
        this.worker = new Worker(new URL('./menu/backdropWorker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => {
          const m = e.data || {};
          if (m.type === 'firstFrame') this._onFirstFrame();
          else if (m.type === 'error') { console.warn('[menu] backdrop worker:', m.message); this._killBackdrop(); }
        };
        this.worker.postMessage({ type: 'init', canvas: off, size: { w, h }, still: STILL }, [off]);
      } catch (e) {
        console.warn('[menu] worker backdrop unavailable:', e?.message);
        this.worker = null;
      }
    }
    if (!this.worker) {
      this.backdrop = new Backdrop(c);
      if (this.backdrop.ok) {
        this.backdrop.setSize(w, h);
        fetch(STILL, { cache: 'force-cache' }).then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
          .then((b) => createImageBitmap(b, { imageOrientation: 'flipY' })).then((b) => this.backdrop?.setStill(b)).catch(() => {});
        const loop = () => {
          if (!this.active || !this.backdrop) return;
          this._raf = requestAnimationFrame(loop);
          const now = performance.now();
          const dt = Math.min((now - (this._last || now)) / 1000, 0.1); this._last = now;
          this.backdrop.frame(dt);
          if (!this._first) this._onFirstFrame();
        };
        loop();
      } else {
        this.backdrop = null;
        this._onFirstFrame();                        // the CSS gradient is the backdrop; carry on
      }
    }
    this._onResize = () => {
      const [W, H] = this._px();
      if (this.worker) this.worker.postMessage({ type: 'size', w: W, h: H });
      else this.backdrop?.setSize(W, H);
    };
    addEventListener('resize', this._onResize);
  }

  _bd(msg) {
    if (this.worker) this.worker.postMessage({ type: 'set', ...msg });
    else this.backdrop?.set(msg);
  }

  _killBackdrop() {
    try { this.worker?.postMessage({ type: 'stop' }); this.worker?.terminate(); } catch (e) {}
    this.worker = null;
    try { this.backdrop?.dispose(); } catch (e) {}
    this.backdrop = null;
    if (this.el?.canvas) this.el.canvas.style.opacity = '0';   // fall back to the CSS gradient beneath
  }

  _onFirstFrame() {
    if (this._first) return;
    this._first = true;
    this.el.splash?.remove();
    this._resolveFirst?.();
  }

  // ---------------------------------------------------------------- input
  _wire() {
    const nav = this.el.nav;
    this._items = [...nav.querySelectorAll('button')];
    this._items.forEach((b, i) => {
      b.addEventListener('pointerenter', () => this._select(i, true));
      b.addEventListener('click', (e) => { e.stopPropagation(); this._activate(b.dataset.act); });
    });
    this._select(0, false);

    // Parallax. The backdrop eases toward this on its own thread, so it stays smooth through a stall.
    this._onMove = (e) => this._bd({ mouse: [(e.clientX / innerWidth - 0.5) * 2, (e.clientY / innerHeight - 0.5) * 2] });
    addEventListener('pointermove', this._onMove, { passive: true });

    this._onKey = (e) => {
      if (this._playing || this.done) return;
      const k = e.key;
      if (k === 'Escape') { if (this._panel) { this._closePanel(); e.preventDefault(); } return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        this._select((this._sel + (k === 'ArrowDown' ? 1 : this._items.length - 1)) % this._items.length, true);
      } else if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        this._activate(this._items[this._sel].dataset.act);
      } else if (k >= '1' && k <= '4') {
        e.preventDefault();
        this._activate(this._items[+k]?.dataset.act);
      }
    };
    addEventListener('keydown', this._onKey);
    // A click on the ART (not on a menu item, not inside the open panel) closes the panel. It must NOT
    // take the pointer lock: the menu needs a visible cursor, and the lock is taken by Play, which is a
    // real user gesture. The panel swallows its own clicks or selecting text inside it would close it.
    this.el.panel.addEventListener('click', (e) => e.stopPropagation());
    this._onClick = () => { if (this._panel) this._closePanel(); };
    addEventListener('click', this._onClick);
  }

  _select(i, sound) {
    if (i === this._sel && this._items[i].classList.contains('on')) return;
    this._items.forEach((b, n) => b.classList.toggle('on', n === i));
    this._sel = i;
    if (sound) this._blip(880, 0.035, 0.028);
  }

  _activate(act) {
    if (!act || this._playing) return;
    this._blip(300, 0.20, 0.05);
    if (act === 'play') return this.play();
    if (this._panel === act) return this._closePanel();
    this._openPanel(act);
  }

  _openPanel(act) {
    const p = this.el.panel;
    p.innerHTML = act === 'settings' ? this._settingsHtml() : (PANELS[act] || '');
    if (act === 'settings') this._wireSettings();
    p.classList.add('open');
    this._panel = act;
    this.el.menu.classList.add('panelled');    // only narrow layouts dim the list; wide ones sit side by side
  }

  _closePanel() {
    this.el.panel.classList.remove('open');
    this.el.menu.classList.remove('panelled');
    this._panel = null;
  }

  // ---------------------------------------------------------------- settings (pre-game)
  /** Only what can honestly be set before the world exists. Everything else is the in-game Esc menu. */
  _settingsHtml() {
    let q = 'high';
    try { q = localStorage.getItem('cadle.q') || 'high'; } catch (e) {}
    if (['low', 'medium', 'high'].includes(this.params.get('q'))) q = this.params.get('q');
    // A SEGMENTED CONTROL, not three outlined boxes that swap their own background: one indicator glides
    // between the three on --spring, the same component as `.ui-seg` in the pause menu and the tabs on
    // cadle.gg. --qi is the selected index; the indicator's transform reads it.
    const i = Math.max(0, QUALITIES.findIndex(([id]) => id === q));
    return `<h2>Settings</h2><p class="lead">Graphics preset. Everything else lives in the pause menu.</p>
      <div class="seg" role="radiogroup" aria-label="Graphics preset" style="--n:3;--qi:${i}">
        <span class="ind" aria-hidden="true"></span>
        ${QUALITIES.map(([id, n], k) => `<button data-q="${id}" data-i="${k}" role="radio"
          aria-checked="${id === q}" class="${id === q ? 'on' : ''}">${n}</button>`).join('')}
      </div>
      <p class="note" id="qnote">High targets 140 fps on a desktop GPU. Low halves the draw cost for laptops
        and integrated graphics.</p>`;
  }

  _wireSettings() {
    const note = this.el.panel.querySelector('#qnote');
    const seg = this.el.panel.querySelector('.seg');
    for (const b of this.el.panel.querySelectorAll('[data-q]')) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const q = b.dataset.q;
        try { localStorage.setItem('cadle.q', q); } catch (err) {}
        for (const o of this.el.panel.querySelectorAll('[data-q]')) {
          o.classList.toggle('on', o === b);
          o.setAttribute('aria-checked', o === b);
        }
        seg?.style.setProperty('--qi', b.dataset.i);
        this._blip(660, 0.05, 0.03);
        // The world is already being built at this preset — changing it now would mean throwing that
        // away and starting over, which is a worse trade than one honest sentence.
        if (note) note.textContent = this.game
          ? 'Saved. The Vale is already being raised at the old preset — this takes effect next launch.'
          : 'Saved.';
      });
    }
  }

  // ---------------------------------------------------------------- progress
  setProgress(p, label) {
    p = Math.max(0, Math.min(1, p));
    // MONOTONIC, and it has to be. FOUR independent sources drive this bar — `assets:progress`,
    // `boot:progress` (emitted by Game per system AND by Assets, World and Player for sub-steps),
    // warmScene and warmFrames — and any ordering that delivers a lower number after a higher one made
    // the bar visibly run backwards and then climb again. A bar that goes backwards reads as a fault in
    // the thing you are waiting for, which is the one thing a loading screen must never say. The fill is
    // a 1.1 s linear transition, so a reversal is not a flicker either: it is a full second of the bar
    // travelling the wrong way.
    if (p < this._progress) p = this._progress;
    this._progress = p;
    this._lastTick = performance.now();          // the watchdog's heartbeat
    if (label) this._label = label;
    if (label && this.el?.phase) this.el.phase.textContent = label;
    this._paint();
    if (p >= 1 && this._playing) this._finale();
  }

  /**
   * WEIGHTED PHASES — because an evenly-divided bar lies by two orders of magnitude.
   *
   * Measured on this loader: 10% -> 20% took 1 ms and 60% -> 70% took 12.8 s. Every one of the boot's
   * systems was worth the same 2.9 points regardless of what it cost, so half the bar was 15% of the
   * wait. The honest budget is not a guess, it is the LAST load: `phase()` times each phase, persists
   * the times, and spends the bar in proportion to them next launch. First-ever load has no record and
   * falls back to equal weights, which is exactly where we started, so this can only improve.
   *
   * main.js: call `menu.phases([...ids])` once with the boot's phase ids in order, then
   * `menu.phase(id, 'LABEL')` on entering each one — plus `menu.phase(id, label, frac)` with a 0..1
   * fraction for a phase that can report its own sub-progress (assets). Nothing else changes;
   * setProgress stays the public API and still wins if you drive it directly.
   */
  phases(ids) {
    this._phaseIds = ids.slice();
    let w = {};
    try { w = JSON.parse(localStorage.getItem('cadle.loadms') || '{}') || {}; } catch (e) {}
    // a phase with no record is worth the mean of the ones that have one, so a newly added phase does
    // not silently get zero of the bar
    const known = ids.map((i) => +w[i]).filter((v) => v > 0);
    const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    this._w = ids.map((i) => (+w[i] > 0 ? +w[i] : mean));
    const total = this._w.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    this._cum = this._w.map((v) => { const s = acc / total; acc += v; return s; });   // start of each phase
    this._cum.push(1);
    this._times = {};
    return this;
  }

  phase(id, label, frac = 0) {
    if (!this._phaseIds) return this.setProgress(this._progress, label);
    const i = this._phaseIds.indexOf(id);
    if (i < 0) return this.setProgress(this._progress, label);
    const now = performance.now();
    if (this._openPhase && this._openPhase !== id) {
      this._times[this._openPhase] = (this._times[this._openPhase] || 0) + (now - this._phaseAt);
    }
    if (this._openPhase !== id) { this._openPhase = id; this._phaseAt = now; }
    const a = this._cum[i], b = this._cum[i + 1];
    this.setProgress(a + (b - a) * Math.max(0, Math.min(1, frac)), label);
  }

  /** remember what this load actually cost, so the next one can spend the bar honestly */
  _savePhases() {
    if (!this._times || !this._openPhase) return;
    this._times[this._openPhase] = (this._times[this._openPhase] || 0) + (performance.now() - this._phaseAt);
    try { localStorage.setItem('cadle.loadms', JSON.stringify(this._times)); } catch (e) {}
  }

  /**
   * THE BAR NEVER SITS STILL EITHER.
   *
   * Monotonic was half the fix. The other half is that real progress arrives in lumps — measured, the
   * bar froze five times for between 1.3 s and 2.7 s while a system built — and a bar that stops reads
   * as a hang exactly like a bar that reverses reads as a fault. So the target written to the DOM is a
   * little AHEAD of the truth: it creeps toward the next milestone and the real update overtakes it.
   * The creep is capped at a few per cent and always short of 100, so it can never promise something
   * that has not happened; and because it is carried by a compositor animation's playbackRate (see
   * _seek) it keeps moving through a main-thread stall that would freeze any rAF-driven version.
   */
  _paint() {
    if (!this.el?.fill) return;
    const p = this._progress;
    // An ASYMPTOTIC crawl toward a ceiling a little above the truth, and the ceiling has two rules.
    //
    // It COLLAPSES past 0.88. prewarm() is one un-sliceable composed render — it links every shader
    // program in the scene — and truth sits at 0.94 across the whole of it. With a flat 9-point lead
    // the bar reached 98.5% and then stood there for 2.1 s warm, 5.2 s cold and 26.6 s at 4x CPU: a bar
    // that says 98% and stops has promised the end and broken the promise. Two points promise nothing.
    //
    // And it WIDENS WITH THE WAIT, because approaching a FIXED ceiling saturates — always moving in
    // theory, moving by less than a pixel a second after four or five time constants, measured as 61 s
    // of rendered stillness inside one 4x-CPU gap. Growing the lead with how long the truth has been
    // silent gives the crawl somewhere to keep travelling: 15.6 s of stillness in the same shape of
    // gap. Still bounded, still short of the next milestone, still tight above 0.88.
    const quiet = Math.min(30, (performance.now() - (this._lastTick || performance.now())) / 1000);
    const lead = p > 0.88 ? 0.02 + quiet * 0.001 : 0.09 + quiet * 0.002;
    const ceil = p >= 1 ? 1 : Math.min(0.985, p + lead);
    // `prev` is what the bar is ACTUALLY showing, read back off the animation, not what we last asked
    // for. That is what makes the whole thing monotonic at the pixel level: we only ever seek forward
    // from where it really is.
    const prev = Math.max(this._shown || 0, this._at());
    // STEP CAP: 3.5 points a tick is still 8.75 points a second, more than twice the average rate of a
    // real load, so it never lags the truth — it just never asks for a large move at once.
    const shown = Math.max(prev, p >= 1 ? 1 : Math.min(prev + 0.035, prev + (ceil - prev) * 0.22));
    this._shown = shown;
    // Creep velocity: cover whatever lead is left over about four seconds. The animation carries this
    // by itself, on the compositor, so the bar keeps moving through a main-thread stall exactly as the
    // old long transition did — and it can never run past `ceil`, because every tick recomputes it.
    // At 100% we do not jump the last points either: rate closes the gap in 400 ms, which is the bar
    // shutting rather than teleporting.
    if (p >= 1) this._seek(prev, Math.max(0, 1 - prev) * UNIT / 400);
    else this._seek(shown, Math.max(0, ceil - shown) * UNIT / 4000);
    this.el.load.style.setProperty('--k', shown.toFixed(3));
    this._spin(shown);
    const n = Math.round(shown * 100);
    this._setPct(n);
    // ONE source of truth for every place the number appears. The title used to be written from
    // setProgress off `_progress` while the screen showed `_shown`, so the tab read "CADLE — 11%" over
    // a screen reading 20%. What is on the bar is what is true for the reader.
    this.el.track?.setAttribute('aria-valuenow', n);
    if (!this._ready) document.title = `CADLE — ${n}%`;
  }

  /**
   * THE FILL IS A TIME-DRIVEN ANIMATION, NOT A TRANSITION — and that is a bug fix, not a preference.
   *
   * Measured off the compositor's own screencast frames (`tools/out/loadaudit.mjs` + `barpix.py`), the
   * rendered bar reversed 13-26 times per load while `setProgress` was provably monotonic and while
   * `_paint` had made no DOM write at all in the window. A CSS transition is defined by a FROM value
   * and a TO value; under GPU/main-thread contention the browser re-commits one that is still in
   * flight and replays it from that from-value, so the size of the visible collapse is the size of the
   * move in flight — worst measured, 53.4% down to 10.7% in a single frame, then a second and a half
   * climbing back. Shortening the transition only shortens how long the wrong number is on screen.
   *
   * An animation seeked by `currentTime` has no from-value to revert to: its position is a function of
   * the timeline, so a stale commit is a stale TIME — worth at most the crawl's own velocity — and a
   * seek is exact. We only ever seek forward, from the position read back off the animation itself, so
   * the bar cannot go backwards even in principle. `playbackRate` carries the crawl on the compositor,
   * which is what used to be the long transition's job: a five-second stall cannot stop it.
   */
  _ensureAnim() {
    if (this._fa !== undefined) return;
    this._fa = null;
    if (!this.el?.fill?.animate) return;                // no WAAPI: the CSS transition is the fallback
    const o = { duration: UNIT, easing: 'linear', fill: 'both' };
    this._fa = this.el.fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], o);
    this._ca = this.el.cap.animate([{ transform: 'translateX(0%)' }, { transform: 'translateX(100%)' }], o);
    for (const a of [this._fa, this._ca]) { a.pause(); a.currentTime = 0; }
  }

  /**
   * THE MARK SPINS UP AS THE WORLD COMES TOGETHER.
   *
   * The loading screen's emblem used to be a dashed ring with a comment claiming it sped up with
   * progress and 6s/9s hard-coded durations that nothing ever touched. This is that promise, kept:
   * `playbackRate` on the three layers' existing CSS animations, 1x at the start and 5x at the end.
   *
   * playbackRate and NOT animation-duration — a duration change reinterprets the animation's local
   * time, so the ring jumps to a new angle on every write, forty times a load. Rate is continuous, and
   * it stays a compositor animation, so a main-thread stall does not stop the mark either.
   */
  _spin(k) {
    const r = 1 + k * 4;
    if (Math.abs(r - (this._spinRate || 0)) < 0.02) return;      // don't touch it for a rounding change
    this._spinRate = r;
    this._layers ||= [...(this.el.load.querySelectorAll('.wheel i') || [])];
    for (const el of this._layers) for (const a of el.getAnimations?.() || []) a.playbackRate = r;
  }

  /** where the bar actually is, 0..1 */
  _at() {
    this._ensureAnim();
    return this._fa ? Math.min(1, (+this._fa.currentTime || 0) / UNIT) : (this._shown || 0);
  }

  /** put the bar at `v` (never backwards) and let it creep on at `rate` timeline-ms per wall-ms */
  _seek(v, rate) {
    this._ensureAnim();
    if (!this._fa) {                                    // fallback: the CSS transition path
      this.el.fill.style.transform = `scaleX(${v})`;
      this.el.cap.style.transform = `translateX(${(v * 100).toFixed(2)}%)`;
      return;
    }
    for (const a of [this._fa, this._ca]) {
      const now = +a.currentTime || 0, t = Math.max(now, v * UNIT);
      if (t !== now) a.currentTime = t;
      a.playbackRate = rate;
      if (rate > 0) { if (a.playState !== 'running') a.play(); } else if (a.playState === 'running') a.pause();
    }
  }

  /**
   * THE PERCENTAGE ROLLS, AND IT ROLLS ON THE COMPOSITOR.
   *
   * The marketing site's stat strip counts up in a rAF loop (`tickers()` in src/site/ui.js) and can
   * afford to: nothing is blocking that page. Here the whole point of the screen is that a multi-second
   * main-thread stall cannot stop it, and a rAF ticker would freeze in exactly the stall the bar is
   * built to survive — a frozen number beside a moving bar reads worse than a number that never moved.
   * So each digit is an eleven-cell strip (a blank cell, then 0-9) inside a clipped window, and rolling
   * is a translateY with a spring transition. Cell 0 is the blank, cell d+1 is digit d, which is how the
   * leading slots stay empty at 7% and fill in at 100% without the number ever changing width.
   */
  _buildPct() {
    const p = this.el?.pct; if (!p) return;
    const strip = `<span>${'<b></b>' + [0,1,2,3,4,5,6,7,8,9].map((d) => `<b>${d}</b>`).join('')}</span>`;
    p.innerHTML = `<span class="d" aria-hidden="true">${strip}</span>`.repeat(3)
      + '<span class="u" aria-hidden="true">%</span>';
    this._digits = [...p.querySelectorAll('.d>span')];
    this._setPct(Math.round((this._shown || 0) * 100));
  }

  /** n is 0..100. Falls back to plain text if init() has not built the strips yet. */
  _setPct(n) {
    const p = this.el?.pct; if (!p) return;
    p.setAttribute('aria-label', `${n} percent`);
    if (!this._digits) { p.textContent = n + '%'; return; }
    const cells = [n >= 100 ? 2 : 0, n >= 10 ? Math.floor(n / 10) % 10 + 1 : 0, n % 10 + 1];
    for (let i = 0; i < 3; i++) this._digits[i].style.setProperty('--c', cells[i]);
  }

  /** keep the creep alive between real updates; cleared at the hand-off */
  _startCreep() {
    if (this._creepT) return;
    this._creepT = setInterval(() => {
      if (this.done || this._ready) return;
      this._paint();
      // THE WATCHDOG. A load that dies used to leave the player on a bar frozen at 5.8% under
      // "GATHERING AETHER" for as long as they were willing to wait — measured five minutes on a slow
      // 3G module fetch, with no error and nothing to press. The threshold is deliberately far above
      // the worst honest gap this loader has ever shown (26.6 s of legitimate stillness inside
      // prewarm at 4x CPU), because a watchdog that cries wolf on a slow laptop is worse than none.
      if (!this._failed && performance.now() - (this._lastTick || 0) > 75000) {
        this.fail('The Vale did not answer. The connection may have dropped mid-load.');
      }
    }, 400);
  }

  /**
   * The load is not coming back: say so, and give them the one thing that can help.
   *
   * Public, because main.js's boot() is where the throw actually happens — call `menu.fail(err)`
   * instead of `menu.skip()` on a boot failure. skip() removes the whole menu, which measured as a
   * blank purple gradient with `document.body.innerText === ''`: the player is told nothing at all.
   */
  fail(err) {
    if (this._failed || this.done) return;
    this._failed = true;
    clearInterval(this._creepT); this._creepT = 0;
    const msg = typeof err === 'string' ? err : (err?.message || 'The world could not be built.');
    console.error('[menu] load failed:', err);
    if (!this.el?.err) return;
    this.el.menu.classList.add('failed');
    if (this.el.phase) this.el.phase.textContent = 'THE VALE DID NOT ANSWER';
    this.el.err.querySelector('.msg').textContent = msg;
    this.el.err.hidden = false;
    const b = this.el.err.querySelector('button');
    b.onclick = () => location.reload();
    b.focus();
  }

  _nextTip() {
    const t = this.el?.tip; if (!t) return;
    this._tipI = ((this._tipI ?? -1) + 1) % TIPS.length;
    t.classList.add('fade');
    setTimeout(() => { t.textContent = TIPS[this._tipI]; t.classList.remove('fade'); }, 420);
  }

  // ---------------------------------------------------------------- warming the world under the bar
  /**
   * Render ONE fully composed frame of the world, through PostFX, while the loading bar is still moving.
   *
   * This is the FIRST time the world is ever drawn — nothing renders it before game.start(), which does
   * not happen until the hand-off — and that one call links the scene's shader programs. Measured on the
   * old intro: 6.2 s for 27 programs, all of it AFTER the bar already read 100%. Paying for it under a
   * moving bar is the whole difference between "loading" and "hung".
   *
   * It goes through `postfx.render` and not a bare `renderer.render` on purpose: the composer's passes
   * are what the running game actually uses, so this warms the exact programs the first real frame
   * needs, including the viewmodel overlay. Idempotent; main.js calls it once.
   */
  prewarm() {
    const g = this.game;
    if (this._warmed || !g?.postfx?.render) return false;
    this._warmed = true;
    this._borrowClock();
    this._live = [g.sky, g.lighting, g.terrain, g.world, g.player, g.vfx].filter(Boolean);
    return this._renderGameFrame();
  }

  /**
   * Pin the world's clock to the hour the title screen is painted at, and remember what it was.
   *
   * The backdrop still is a night capture and the type is laid out against its dark left third; the
   * game boots at hour 15. Measured across the hand-off: mean frame luma 23 for the whole loading
   * screen, then 136 the instant the flash lifts. After a minute of dark adaptation, having been told
   * you are going to the Waystone Plaza, you arrive somewhere that looks like a different place. So
   * the world is built at the menu's hour and walked back to its own afterwards (_restoreGame).
   */
  _borrowClock() {
    const g = this.game;
    if (!g?.sky || this._was) return;
    this._was = {
      pos: g.camera.position.clone(), quat: g.camera.quaternion.clone(), fov: g.camera.fov,
      hour: g.sky.hour, dayLength: g.sky.dayLength, vm: g.player?.weapons?.scene?.visible,
    };
    g.sky.dayLength = 0;
    g.sky.setHour(MENU_HOUR);
  }

  /** step the world one frame and draw it composed, exactly as the game loop will */
  _renderGameFrame(dt = 1 / 60) {
    const g = this.game;
    if (!g?.postfx?.render || !this._live) return false;
    try {
      g.time += dt;
      for (const s of this._live) s.update?.(dt, g.time);
      g.input.endFrame();
      g.postfx.render(dt);
      return true;
    } catch (e) { return false; }      // a system not ready yet: skip this frame and try the next
  }

  /**
   * Dev/harness hook: pose the camera at the title screen's own lens and draw one composed frame to the
   * canvas, so `public/assets/ui/menu_vista.jpg` can be re-captured from exactly the pose the screen was
   * designed around (see ASSETS.md). `over` patches CAM for the shot.
   *
   * It borrows game.camera and pins the clock; `_teardown` puts both back, but a capture session throws
   * the page away anyway. Players never reach this — the backdrop is the still plus its own shader.
   */
  shot(t = 0, over = null) {
    const g = this.game;
    if (over) Object.assign(CAM, over);
    if (!this._live) this.prewarm();
    if (!g?.postfx?.render) return false;
    this._borrowClock();
    if (g.player?.weapons?.scene) g.player.weapons.scene.visible = false;   // no gun in a title card
    const p = g.player?.position, cam = g.camera;
    const x = (p?.x ?? 0) + CAM.dx + Math.sin(t * 0.055) * 2.0;
    const z = (p?.z ?? 0) + CAM.dz + Math.cos(t * 0.041) * 1.5;
    cam.position.set(x, (g.terrain?.heightAt?.(x, z) ?? 0) + CAM.eye + Math.sin(t * 0.09) * 0.10, z);
    cam.rotation.set(CAM.pitch, CAM.yaw, 0);
    cam.fov = CAM.fov; cam.updateProjectionMatrix();
    // the player system would put the camera back on the player's head, so step everything but it
    const live = this._live;
    this._live = live.filter((s) => s !== g.player);
    const ok = this._renderGameFrame(1 / 30);
    this._live = live;
    return ok;
  }

  // ---------------------------------------------------------------- ready / play
  /** the world is built and warm: close the bar and, if Play has been pressed, dive. */
  arm() {
    if (this._ready) return;
    this._ready = true;
    document.title = 'CADLE';
    this.el?.menu?.classList.add('ready');
    this.setProgress(1, 'THE VALE AWAITS');
    if (this._playing) this._finale();
  }

  /** harness: cancel the auto-play so the menu can be inspected for as long as the critic wants.
   *  Sticky, because it is usually called before arm() has scheduled anything. */
  hold() { this._held = true; clearTimeout(this._autoTimer); this._autoTimer = 0; return true; }

  /**
   * Play. **This is the only thing that starts the game loading** (user decision 2026-08-28): the items
   * sweep out, the loading screen takes the frame, and only then does main.js build the world behind it.
   */
  play() {
    if (this._playing || this.done) return this.finished;
    this._playing = true;
    clearTimeout(this._autoTimer);
    this._closePanel();
    this.el.menu.classList.add('loading');
    // The nav is only invisible — it kept its five buttons in the tab order and in the accessibility
    // tree for the whole load, announcing "Play enter", "The Vale 1" over a screen that is loading.
    this.el.nav.inert = true;
    this.el.load.setAttribute('aria-busy', 'true');
    this.el.phase.textContent = this._ready ? 'THE VALE AWAITS' : (this._label || 'GATHERING AETHER');
    this._lastTick = performance.now();
    this.setProgress(this._progress);
    this._startCreep();
    // dolly in and dip the exposure so the type reads; the worker runs both ramps on its own clock
    this._bd({ push: 1, dim: 0.82 });
    this._playAt = performance.now();
    // Take the lock HERE, inside the click's transient activation. Anywhere later (at hand-off, twenty
    // seconds from now) the gesture is gone and Chrome refuses — which is how "the mouse never captured"
    // used to happen. Input.lock is the ONE lock path in the app; nothing may call the browser API
    // directly (tools/invariants.mjs rule (a)). Skipped for ?start, where the click happened on the
    // landing page and this document has no activation of its own — the HUD's start hint covers that.
    if (!this.auto && !this.params.has('start') && !document.pointerLockElement) {
      try { Input.lock(this.host.canvas); } catch (e) {}
    }
    // and NOW build the world. boot() is async, so a throw inside it arrives as a rejection and the old
    // try/catch never saw it — that is the path that ended with a blank purple page.
    try { Promise.resolve(this.onPlay?.()).catch((e) => this.fail(e)); } catch (e) { this.fail(e); }
    if (this._ready) this._finale();
    return this.finished;
  }

  /** progress is at 100% and Play has been pressed: hold a beat, then dive. */
  _finale() {
    if (this._diving || !this._playing || !this._ready || this.done) return;
    this._diving = true;
    clearInterval(this._creepT); this._creepT = 0;
    this.el.menu.classList.add('ready');
    this.el.phase.textContent = 'THE VALE AWAITS';
    this._shown = 1;
    this._seek(this._at(), Math.max(0, 1 - this._at()) * UNIT / 350);
    this.el.load.style.setProperty('--k', '1');
    this._setPct(100);
    // Never cut straight from the click: even a world that is already built gets the beat, or Play reads
    // as a page navigation instead of an entrance. At least 700 ms with the bar closed and the
    // destination named, and at least 1.3 s since the click so the loading screen has finished arriving.
    const beat = Math.max(700, 1300 - (performance.now() - this._playAt));
    setTimeout(() => {
      this._bd({ warp: 1, dim: 1.25, calm: 0 });           // the dive: swirl, pinch, blow out
      this.el.menu.classList.add('off');
      setTimeout(() => this.el.flash?.classList.add('on'), 620);
      setTimeout(() => this._handover(), 800);
    }, beat);
  }

  // ---------------------------------------------------------------- hand-off
  _handover() {
    if (this.done) return;
    const g = this.game;
    this.done = true;
    this._teardown();
    // Hand over in the state the game boots into: running and unpaused, next click on the canvas takes
    // the lock. If Play's lock request succeeded the HUD never saw a pointerlockchange (it did not exist
    // yet), so tell it — otherwise its start hint sits over a game that is already captured.
    if (!document.pointerLockElement) {
      if (g) g.paused = false;
      try { g?.hud?.settings?.hide?.(); } catch (e) {}
    }
    try { g?.start(); } catch (e) { console.error(e); }
    if (document.pointerLockElement) {
      try { document.dispatchEvent(new Event('pointerlockchange')); } catch (e) {}
    }
    // ease the HUD in rather than slamming the whole thing on the frame the flash lifts
    const ui = this.el.ui;
    if (ui) {
      ui.style.display = ''; ui.style.opacity = '0'; ui.style.transition = 'opacity .9s ease';
      setTimeout(() => { ui.style.opacity = '1'; setTimeout(() => { ui.style.transition = ''; }, 1000); }, 240);
    }
    // two frames of real game on the canvas before the flash lifts, so it never uncovers a black screen
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.el.flash?.classList.remove('on');
      this.el.flash?.classList.add('off');
      setTimeout(() => this.el.flash?.remove(), 900);
    }));
    this._resolve?.(true);
  }

  /** abandon the menu immediately (?auto=1, a failure, or the harness) and give the game the canvas */
  skip() {
    if (this.done) return;
    this.done = true;
    this._teardown();
    this.el?.flash?.remove();
    if (this.el?.ui) this.el.ui.style.display = '';
    this.el?.splash?.remove();
    this._resolveFirst?.();
    this._resolve?.(false);
  }

  /** put back everything the menu borrowed from the game: the camera, the clock, the viewmodel */
  _restoreGame() {
    const g = this.game, w = this._was;
    if (!g || !w) return;
    this._was = null;
    try {
      g.camera.position.copy(w.pos); g.camera.quaternion.copy(w.quat);
      g.camera.fov = w.fov; g.camera.updateProjectionMatrix();
      if (g.player?.weapons?.scene && w.vm !== undefined) g.player.weapons.scene.visible = w.vm;
      if (g.sky && w.hour != null) this._rampHour(g, w);
    } catch (e) { console.warn('[menu] restore failed:', e?.message); }
  }

  /**
   * Walk the clock back from the menu's hour to the game's own instead of cutting to it.
   *
   * Not by restoring dayLength and letting it run: 19.6 -> 15 forwards is most of a night. Round the
   * SHORT way, 4.6 hours in six seconds, which reads as the sun coming up over your shoulder while you
   * find your feet. One six-second rAF at the hand-off, not a system loop — it ends by itself and it is
   * the only frame-driven thing this file owns. skip() and ?auto=1 snap instead: the harness asks for
   * the game's hour and must get it on frame one.
   */
  _rampHour(g, w) {
    const from = g.sky.hour, to = w.hour;
    let d = to - from;
    if (d > 12) d -= 24; else if (d < -12) d += 24;
    if (this.auto || !this._playing || Math.abs(d) < 0.05) {
      g.sky.dayLength = w.dayLength; g.sky.setHour(to); return;
    }
    g.sky.dayLength = 0;                                  // hold it while we drive it
    const t0 = performance.now(), DUR = 6000;
    let last = 0;
    const step = () => {
      const now = performance.now(), k = Math.min(1, (now - t0) / DUR);
      // 20 Hz, not 60. setHour is 38x its normal rate here (a day is 20 real minutes) and whatever it
      // rebuilds — env, CSM splits — should not be rebuilt three times per frame's worth of change on
      // the first second of gameplay. 120 steps is far past the point the eye can see a step.
      if (now - last > 50 || k >= 1) {
        last = now;
        const s = k * k * (3 - 2 * k);                    // smoothstep: no visible start, no visible stop
        try { g.sky.setHour(((from + d * s) % 24 + 24) % 24); } catch (e) { return; }
      }
      if (k < 1) requestAnimationFrame(step);
      else { g.sky.dayLength = w.dayLength; g.sky.setHour(to); }
    };
    requestAnimationFrame(step);
  }

  _teardown() {
    this.active = false;
    this._savePhases();
    this._restoreGame();
    clearInterval(this._creepT); this._creepT = 0;
    cancelAnimationFrame(this._raf);
    clearInterval(this._tipTimer); clearTimeout(this._autoTimer);
    removeEventListener('resize', this._onResize);
    removeEventListener('pointermove', this._onMove);
    removeEventListener('keydown', this._onKey);
    removeEventListener('click', this._onClick);
    this._killBackdrop();
    this.el?.canvas?.remove();
    this.el?.menu?.remove();
    try { this._ac?.close(); } catch (e) {}
    this._ac = null;
  }

  // ---------------------------------------------------------------- menu sfx
  /** Two synthesized blips. No asset, no dependency, and the context is closed at hand-off so it can
   *  never sit alongside the game's own audio graph. */
  _blip(freq, dur, gain) {
    if (this.auto) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ac = (this._ac ||= new AC());
      if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime;
      const o = ac.createOscillator(), g2 = ac.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.62, t + dur);
      g2.gain.setValueAtTime(0, t);
      g2.gain.linearRampToValueAtTime(gain, t + 0.008);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g2).connect(ac.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* audio is a garnish; never let it break the menu */ }
  }
}
