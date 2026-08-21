// Full-screen RPG overlays for Cadle: map (M), character (C), inventory (I), skill tree (K).
// Shell + keys + focus live here; the bodies are the ported renderers (rpgscreens.js, mapscreen.js)
// driven by the ctx adapter built in src/rpg/RPG.js. Runs on DOM + its own rAF because the game
// loop stops updating while game.paused — a menu that freezes is a broken menu.
// Pointer lock: opening a screen exits lock (game pauses via HUD's pointerlockchange, which
// suppresses its pause menu while a screen is visible); closing re-locks through Input.lock —
// the single lock path (tools/invariants.mjs enforces it).
import { CSS as THEME_CSS } from './theme.js';
import { SCREEN_CSS } from './screencss.js';
import * as R from './rpgscreens.js';
import * as MAP from './mapscreen.js';

const TABS = [
  ['map', 'The Vale', 'KeyM'],
  ['char', 'Character', 'KeyC'],
  ['inv', 'Inventory', 'KeyI'],
  ['skills', 'Skills', 'KeyK'],
];

export class Screens {
  constructor(game, ctx) {
    this.game = game; this.ctx = ctx;
    this.visible = false; this.tab = 'map';
    this._raf = 0; this._el = null;
    this._keydown = (e) => this._onKey(e);
  }

  get open() { return this.visible; }

  // called from RPG.update (i.e. only while the game is unpaused and running)
  frame() {
    const g = this.game, inp = g.input;
    MAP.stamp(this.ctx);                      // fog of war uncovers as the player walks
    if (!g.player?.alive) return;
    for (const [tab, , code] of TABS) if (inp.justPressed(code)) { this.show(tab); return; }
  }

  _build() {
    if (this._el) return;
    const root = this.game.hud?.root || document.getElementById('ui') || document.body;
    const style = document.createElement('style');
    style.textContent = THEME_CSS + SCREEN_CSS;   // theme carries .scr/.parch shells; screencss carries the bodies
    root.appendChild(style);
    const el = this._el = document.createElement('div');
    el.className = 'scr';
    el.style.pointerEvents = 'auto';
    el.innerHTML = `
      <div class="parch pane sheet" style="width:min(1240px,96vw);height:min(880px,93vh)">
        <div class="shead">
          <div class="ttl"></div>
          <p class="kick">The Vale remembers</p>
          <div class="mflourish"></div>
          <div class="stabs">${TABS.map(([t, label, code]) =>
            `<button data-tab="${t}"><span>${label}</span><kbd>${code.replace('Key', '')}</kbd></button>`).join('')}</div>
        </div>
        <div class="pscroll"><div class="pbody"></div></div>
        <div class="mapbox" style="display:none"><canvas tabindex="0" aria-label="Map of the Vale"></canvas></div>
        <div class="say" role="status"></div>
        <div class="sfoot">
          <span class="hint"></span>
          <button class="btn gold" data-close type="button">Return to the fight <kbd>Esc</kbd></button>
        </div>
        <button class="sclose" data-close type="button" aria-label="Close and return to the fight">✕</button>
      </div>`;
    root.appendChild(el);
    // Warm the item art the first time a screen is built (~720 KB of 256 px PNGs, decoded once). The
    // bag is opened by a keypress mid-fight; a grid that fades in tile by tile is what "unfinished" looks
    // like. Same relative-path rule as every other asset — nothing is fetched from outside the repo.
    for (const u of R.ART_URLS || []) { const i = new Image(); i.src = u; }
    this._body = el.querySelector('.pbody');
    this._mapbox = el.querySelector('.mapbox');
    this._canvas = el.querySelector('canvas');
    this._ttl = el.querySelector('.ttl');
    this._tabs = [...el.querySelectorAll('.stabs button')];
    this._say = el.querySelector('.say');
    this._hint = el.querySelector('.hint');
    el.addEventListener('dblclick', (e) => {
      const tile = e.target.closest('.tile[data-equip]');
      if (!tile || !tile.getAttribute('data-equip')) return;
      R.invState.sel = tile.getAttribute('data-id');
      this._equipSelected(tile.getAttribute('data-equip'));   // the DOM has not re-rendered yet — pass the id
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { this.close(); return; }
      const t = e.target.closest('[data-tab]');
      if (t) { this.tab = t.getAttribute('data-tab'); this._render(); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const next = R.act(this.ctx, b, (t, kind) => this.say(t, kind));
      if (next === 'skills' || next === 'inv') this.tab = next;
      if (b.getAttribute('data-act') === 'goskills') this.tab = 'skills';
      if (b.getAttribute('data-act') === 'goinv') this.tab = 'inv';
      this._render();
    });
  }

  /** Equip whatever is selected in the bag. One path for the button, Enter, E and double-click. */
  _equipSelected(id) {
    if (!id) {   // no id given: whatever the bag has selected right now
      const t = this._body && this._body.querySelector('.tile.sel[data-equip]');
      id = t && t.getAttribute('data-equip');
    }
    if (!id) { this.say('that one is already on you'); return; }
    // R.act only ever reads getAttribute, so a two-key stand-in is a whole element's worth of object
    R.act(this.ctx, { getAttribute: (k) => (k === 'data-act' ? 'equip' : k === 'data-id' ? id : null) },
      (m, kind) => this.say(m, kind));
    this._render();
  }

  /** Arrow-key roving over the bag grid. Column count is measured, not assumed — the grid is fluid. */
  _navBag(dir) {
    const tiles = [...(this._body ? this._body.querySelectorAll('.tile[data-id]') : [])];
    if (!tiles.length) return;
    let i = tiles.findIndex((t) => t.classList.contains('sel'));
    if (i < 0) i = 0;
    let cols = 1;
    const top = tiles[0].offsetTop;
    while (cols < tiles.length && tiles[cols].offsetTop === top) cols++;
    const step = dir === 'ArrowLeft' ? -1 : dir === 'ArrowRight' ? 1 : dir === 'ArrowUp' ? -cols : cols;
    const j = Math.max(0, Math.min(tiles.length - 1, i + step));
    if (j === i) return;
    R.invState.sel = tiles[j].getAttribute('data-id');
    this._render();
  }

  say(t, kind) { if (this._say) { this._say.textContent = t || ''; this._say.dataset.kind = kind || ''; } }

  show(tab) {
    const g = this.game;
    this._build();
    this.tab = tab || this.tab;
    if (!this.visible) {
      this.visible = true;
      g.paused = true;
      if (document.pointerLockElement) document.exitPointerLock();
      document.addEventListener('keydown', this._keydown, true);
      this._el.classList.add('on', 'shown');   // theme css: .on = display, .shown = opacity (fade-in class)
      const loop = () => { if (!this.visible) return; if (this.tab === 'map') MAP.draw(this.ctx, this._canvas); this._raf = requestAnimationFrame(loop); };
      this._raf = requestAnimationFrame(loop);
    }
    this._render();
  }

  close(relock = true) {
    if (!this.visible) return;
    this.visible = false;
    cancelAnimationFrame(this._raf);
    document.removeEventListener('keydown', this._keydown, true);
    this._el.classList.remove('on', 'shown');
    const g = this.game;
    // Input.lock is the ONE pointer-lock path; the HUD's pointerlockchange handler unpauses on lock.
    if (relock && !g.auto) g.input.constructor.lock(g.canvas);
    else g.paused = false;
  }

  _onKey(e) {
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    if (this.tab === 'inv') {
      if (e.code === 'Enter' || e.code === 'KeyE') { e.preventDefault(); e.stopPropagation(); this._equipSelected(); return; }
      if (e.code.startsWith('Arrow')) { e.preventDefault(); e.stopPropagation(); this._navBag(e.code); return; }
      if (e.code === 'Delete') {
        e.preventDefault(); e.stopPropagation();
        const t = this._body.querySelector('.tile.sel[data-equip]');
        const id = t && t.getAttribute('data-equip');
        if (id) {
          R.act(this.ctx, { getAttribute: (k) => (k === 'data-act' ? 'dismantle' : k === 'data-id' ? id : null) },
            (m, kind) => this.say(m, kind));
          this._render();
        }
        return;
      }
    }
    const hit = TABS.find(([, , code]) => code === e.code);
    // typing into the map canvas: it consumes its own keys (arrows/+/-/C/0); C also means the
    // character tab, so only treat tab keys as tab keys when the map canvas is not focused, except M.
    const mapFocused = document.activeElement === this._canvas;
    if (hit && (!mapFocused || e.code === 'KeyM' || e.code === 'KeyI' || e.code === 'KeyK')) {
      e.preventDefault(); e.stopPropagation();
      if (hit[0] === this.tab) this.close();
      else { this.tab = hit[0]; this._render(); }
    }
  }

  _render() {
    const ctx = this.ctx;
    const isMap = this.tab === 'map';
    this._ttl.textContent = TABS.find(([t]) => t === this.tab)?.[1] ?? '';
    for (const b of this._tabs) b.classList.toggle('on', b.getAttribute('data-tab') === this.tab);
    this._mapbox.style.display = isMap ? '' : 'none';
    this._body.parentElement.style.display = isMap ? 'none' : '';
    this._hint.textContent = isMap
      ? 'drag to pan · wheel to zoom · click to set a waypoint · C centres on you · M or Esc closes'
      : this.tab === 'inv'
        ? 'arrows pick · E or Enter equips · double-click equips · Delete dismantles · Esc returns to the fight'
        : 'M map · C character · I inventory · K skills · Esc returns to the fight';
    if (isMap) {
      MAP.build(ctx);
      MAP.attach(ctx, this._canvas, (t) => this.say(t));
      MAP.centreOnPlayer(ctx);
      this._canvas.focus();
      this.say(MAP.readout(ctx));
    } else if (this.tab === 'char') R.renderChar(ctx, this._body);
    else if (this.tab === 'inv') R.renderInv(ctx, this._body);
    else if (this.tab === 'skills') R.renderSkills(ctx, this._body);
  }
}
