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
      <div class="parch pane sheet" style="width:min(1180px,96vw);height:min(760px,92vh)">
        <div class="ttl"></div>
        <div class="rule"></div>
        <div class="pscroll"><div class="pbody"></div></div>
        <div class="mapbox" style="display:none"><canvas tabindex="0" aria-label="Map of the Vale"></canvas></div>
        <div class="say" role="status"></div>
        <div class="hint"></div>
      </div>`;
    root.appendChild(el);
    this._body = el.querySelector('.pbody');
    this._mapbox = el.querySelector('.mapbox');
    this._canvas = el.querySelector('canvas');
    this._ttl = el.querySelector('.ttl');
    this._say = el.querySelector('.say');
    this._hint = el.querySelector('.hint');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const next = R.act(this.ctx, b, (t, kind) => this.say(t, kind));
      if (next === 'skills' || next === 'inv') this.tab = next;
      if (b.getAttribute('data-act') === 'goskills') this.tab = 'skills';
      if (b.getAttribute('data-act') === 'goinv') this.tab = 'inv';
      this._render();
    });
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
    this._mapbox.style.display = isMap ? '' : 'none';
    this._body.parentElement.style.display = isMap ? 'none' : '';
    this._hint.textContent = isMap
      ? 'drag to pan · wheel to zoom · click to set a waypoint · C centres on you · M or Esc closes'
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
