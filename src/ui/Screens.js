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
  ['quests', 'Quest Log', 'KeyJ'],
];

export class Screens {
  constructor(game, ctx) {
    this.game = game; this.ctx = ctx;
    this.visible = false; this.tab = 'map';
    this._raf = 0; this._el = null;
    this._reward = null;                       // { id, name, cands } while a turn-in is waiting on a pick
    this._keydown = (e) => this._onKey(e);
    // Warm the item art HERE, not in _build() (~720 KB of 256 px PNGs, decoded once). Same relative-path
    // rule as every other asset — nothing is fetched from outside the repo. It used to warm on the first
    // screen build, which is the same instant that screen renders: the first open drew empty black frames
    // where the icons go and filled them in a beat later. This runs during RPG.init(), long before any
    // key is pressed, so the first bag grid and the first reward card come up already painted.
    for (const u of R.ART_URLS || []) { const i = new Image(); i.src = u; }
  }

  get open() { return this.visible; }

  /**
   * The turn-in reward picker. src/rpg/quest.js calls this instead of silently granting a default;
   * the choice goes back through quest.claim(id, i). It is a TAB, not a second modal: the same
   * shell, the same pause, the same single Input.lock path out — and it leaves the player free to
   * flip to the bag and compare before deciding, which is most of the point.
   */
  showReward(id, name, cands) {
    this._reward = { id, name, cands };
    this.show('reward');
  }

  /** Take candidate `i`. i < 0 (closed without choosing) resolves to the first one inside quest.js. */
  _claimReward(i) {
    const r = this._reward; if (!r) return;
    this._reward = null;
    this.game.rpg?.quest?.claim?.(r.id, i);
  }

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
    this._body = el.querySelector('.pbody');
    this._pscroll = el.querySelector('.pscroll');
    // scroll affordance: theme.js's .pscroll already paints the fade+caret (see screencss.js), it
    // just needs the .more/.off classes toggled — every tab (map excluded, it never scrolls) shares
    // this one wiring instead of each renderer reimplementing it.
    this._body.addEventListener('scroll', () => this._scrollAffordance());
    window.addEventListener('resize', () => this._scrollAffordance());
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
      if (b.getAttribute('data-act') === 'takereward') {   // the one action that is not R.act's — it is quest state, not inventory state
        this._claimReward(+b.getAttribute('data-i'));
        this.tab = 'quests'; this.close(); return;
      }
      const next = R.act(this.ctx, b, (t, kind) => this.say(t, kind));
      if (next === 'skills' || next === 'inv') this.tab = next;
      if (b.getAttribute('data-act') === 'goskills') this.tab = 'skills';
      if (b.getAttribute('data-act') === 'goinv') this.tab = 'inv';
      this._render();
    });

    // ---- right-click equips, the WoW way ---------------------------------------------------
    // No selection step: the tile goes on immediately, and progression's own rule decides which
    // slot (empty first, else the weaker gun, tie keeps the one in hand) — see R.act's equip case,
    // which calls equip() with NO slot for exactly this reason. Scoped to the bag and the doll so
    // right-click anywhere else in the panel still behaves normally, and preventDefault only fires
    // where we actually handle it, so no OS menu lands on top of the screen.
    el.addEventListener('contextmenu', (e) => {
      if (this.tab !== 'inv') return;
      const t = e.target.closest && e.target.closest('.tile[data-id], .pdslot[data-slot]');
      if (!t) return;
      e.preventDefault();
      if (!t.classList.contains('tile')) {
        // the mirror (right-click a worn slot to take it off) has no path in progression.js —
        // there is no unequip(). Say so rather than pretending the click did something.
        this.say('nothing takes gear back off yet — equip something else into the slot');
        return;
      }
      const id = t.getAttribute('data-id');
      R.invState.sel = id;
      R.act(this.ctx, { getAttribute: (k) => (k === 'data-act' ? 'equip' : k === 'data-id' ? id : null) },
        (m, kind) => this.say(m, kind));
      this._render();
    });

    // ---- drag and drop: a find from the bag onto the body it goes on ----------------------
    // Native HTML5 DnD, not a hand-rolled pointer drag: the browser already owns the ghost image,
    // the cursor and the "not allowed" feedback, and dropping outside is already a no-op. Which
    // slots accept the thing is asked ONCE per drag (R.dropSlots) and painted as classes, so the
    // grid is not re-rendered while the mouse is moving.
    el.addEventListener('dragstart', (e) => {
      const t = e.target.closest && e.target.closest('.tile[data-id]');
      if (!t) return;
      const id = t.getAttribute('data-id');
      this._drag = id;
      try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
      const ok = new Set(R.dropSlots(this.ctx, id));
      el.classList.add('dragging');
      for (const s of el.querySelectorAll('[data-slot]')) {
        const good = ok.has(s.getAttribute('data-slot'));
        // the hover glow comes OFF for the length of the drag: "could go here" and "you are
        // holding it over this" are two states, and showing both at once says neither
        s.classList.remove('ok', 'okfree', 'okpick');
        s.classList.toggle('dragok', good);
        s.classList.toggle('dragno', !good);
      }
      if (!ok.size) this.say('nothing on you takes that', 'bad');
    });
    el.addEventListener('dragover', (e) => {
      const s = e.target.closest && e.target.closest('[data-slot]');
      if (!s || !s.classList.contains('dragok')) return;
      e.preventDefault();                                   // the only thing that marks a target droppable
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      s.classList.add('over');
    });
    el.addEventListener('dragleave', (e) => {
      const s = e.target.closest && e.target.closest('[data-slot]');
      if (s) s.classList.remove('over');
    });
    el.addEventListener('drop', (e) => {
      const s = e.target.closest && e.target.closest('[data-slot]');
      const valid = s && s.classList.contains('dragok');
      let id = this._drag;
      try { id = id || (e.dataTransfer && e.dataTransfer.getData('text/plain')); } catch (err) {}
      this._endDrag();
      if (!s) return;
      e.preventDefault();
      if (!valid) { this.say('that does not go there', 'bad'); return; }
      // through R.act like every other equip, so the guard and the message are the same one
      R.act(this.ctx, { getAttribute: (k) => (k === 'data-act' ? 'equipslot' : k === 'data-id' ? id
        : k === 'data-slot' ? s.getAttribute('data-slot') : null) }, (m, kind) => this.say(m, kind));
      this._render();
    });
    el.addEventListener('dragend', () => this._endDrag());

    // ---- hover comparison ------------------------------------------------------------------
    // Hovering a bag tile previews it in the detail card — against EVERY slot it could go into,
    // which for a gun means both of yours. It never moves the selection (the click owns that) and
    // it repaints one card, only when the hovered id actually changed: no per-mousemove work.
    el.addEventListener('mouseover', (e) => {
      if (this.tab !== 'inv' || this._drag) return;
      const t = e.target.closest && e.target.closest('.tile[data-id]');
      const id = t ? t.getAttribute('data-id') : null;
      if (R.invState.hover === id) return;
      R.invState.hover = id;
      this._renderDetail();
      this._lightSlots(id || R.invState.sel);
    });
  }

  /**
   * Light the body slots that would accept `id` — the "where does this go" answer, given before
   * the player commits to a drag. Class toggles on at most ~7 nodes, driven by the hovered id
   * CHANGING, never by mousemove. Empty slots get their own class: dropping into one costs nothing,
   * dropping onto a worn piece is a trade, and the doll should not tell the player those are the same.
   */
  _lightSlots(id) {
    if (!this._el) return;
    const nodes = this._el.querySelectorAll('.pdslot[data-slot]');
    if (!nodes.length) return;
    const eq = (this.ctx.rpg && this.ctx.rpg.equipped) || {};
    const ok = id ? new Set(R.dropSlots(this.ctx, id)) : null;
    const pick = id ? R.pickSlot(this.ctx, id) : null;
    for (const s of nodes) {
      const k = s.getAttribute('data-slot'), on = !!ok && ok.has(k);
      s.classList.toggle('ok', on && !!eq[k]);
      s.classList.toggle('okfree', on && !eq[k]);
      s.classList.toggle('okpick', on && k === pick);
    }
  }

  _endDrag() {
    const was = this._drag;
    this._drag = null;
    if (!this._el) return;
    this._el.classList.remove('dragging');
    for (const s of this._el.querySelectorAll('[data-slot]')) s.classList.remove('dragok', 'dragno', 'over');
    if (was) this._lightSlots(R.invState.hover || R.invState.sel);   // hand the glow back
  }

  /** Repaint just the inventory detail card (hover preview). Skipped when nothing it reads moved. */
  _renderDetail() {
    if (this.tab !== 'inv' || !this._body) return;
    const host = this._body.querySelector('.detail');
    const key = R.detailKey();
    if (!host || key === this._detailKey) return;
    this._detailKey = key;
    host.outerHTML = R.detailHTML(this.ctx);
  }

  /** Equip whatever is selected in the bag. One path for the button, Enter, E and double-click.
   *  The selection lives in R.invState.sel, not in the DOM: the loadout strip can select a WORN
   *  item, which has no tile in the grid. R.act's equip case owns the why-not message (quest
   *  token, already worn, nothing takes it) so every path reports the same reason. */
  _equipSelected(id) {
    // whatever the detail card is showing: the hovered tile if the mouse is on one, else the pick
    id = id || R.invState.hover || R.invState.sel;
    if (!id) { this.say('nothing picked'); return; }
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

  /**
   * AUTOMATION ONLY. The harness presses keys through `Input.press()`, which never dispatches a
   * DOM KeyboardEvent — so `_onKey` (a document listener) cannot see them, and `frame()`, which
   * does read the input system, only runs while the game is UNPAUSED, which an open screen never
   * is. Net effect: a critic's synthetic `C` did nothing and every screenshot came out on
   * whichever tab was opened first. Polled here, edge-detected against keys+pressed because
   * Game.frame() clears `pressed` every frame even while paused. Gated on `g.auto` so a real
   * player never gets a second handler racing `_onKey`.
   */
  _autoKeys() {
    const inp = this.game.input;
    const seen = this._autoSeen || (this._autoSeen = new Set());
    for (const [tab, , code] of TABS) {
      const down = inp.keys.has(code) || inp.justPressed(code);
      if (!down) { seen.delete(code); continue; }
      if (seen.has(code)) continue;
      seen.add(code);
      if (tab === this.tab) this.close();
      else { this.tab = tab; this._render(); }
      return;
    }
  }

  say(t, kind) { if (this._say) { this._say.textContent = t || ''; this._say.dataset.kind = kind || ''; } }

  /** Toggles the CSS-painted fade+caret on .pscroll (screencss.js) — 'more' while content sits
   *  below the fold, 'off' ('above the fold' scrolled past) while content sits above it. Without
   *  this a quest sliced off at the panel edge gives the player no sign anything is missing. */
  _scrollAffordance() {
    const b = this._body, wrap = this._pscroll;
    if (!b || !wrap) return;
    const max = b.scrollHeight - b.clientHeight;
    const scrollable = max > 2;
    wrap.classList.toggle('more', scrollable && b.scrollTop < max - 2);
    wrap.classList.toggle('off', scrollable && b.scrollTop > 2);
  }

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
      const loop = () => {
        if (!this.visible) return;
        if (this.tab === 'map') MAP.draw(this.ctx, this._canvas);
        if (g.auto) this._autoKeys();
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    }
    this._render();
  }

  close(relock = true) {
    if (!this.visible) return;
    // Walking away from the picker still pays out: quest.js grants the first candidate rather than
    // nothing. Losing a quest reward to a stray Esc is the one outcome that is never acceptable.
    if (this._reward) { this._claimReward(-1); if (this.tab === 'reward') this.tab = 'quests'; }
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
        const id = R.invState.sel;
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
    if (hit && (!mapFocused || e.code === 'KeyM' || e.code === 'KeyI' || e.code === 'KeyK' || e.code === 'KeyJ')) {
      e.preventDefault(); e.stopPropagation();
      if (hit[0] === this.tab) this.close();
      else { this.tab = hit[0]; this._render(); }
    }
  }

  _render() {
    const ctx = this.ctx;
    const isMap = this.tab === 'map';
    const isReward = this.tab === 'reward';
    this._ttl.textContent = isReward ? 'Choose your reward' : (TABS.find(([t]) => t === this.tab)?.[1] ?? '');
    for (const b of this._tabs) b.classList.toggle('on', b.getAttribute('data-tab') === this.tab);
    this._mapbox.style.display = isMap ? '' : 'none';
    this._body.parentElement.style.display = isMap ? 'none' : '';
    this._hint.textContent = isReward
      ? 'pick the one you want · I compares it against your bag · closing takes the first'
      : isMap
      ? 'drag to pan · wheel to zoom · click to set a waypoint · C centres on you · M or Esc closes'
      : this.tab === 'inv'
        ? 'drag onto the figure to wear it · or pick one and click a slot · hover to compare · E equips · arrows pick · Delete dismantles'
        : 'M map · C character · I inventory · K skills · J quest log · Esc returns to the fight';
    if (isMap) {
      MAP.build(ctx);
      MAP.attach(ctx, this._canvas, (t) => this.say(t));
      MAP.centreOnPlayer(ctx);
      this._canvas.focus();
      this.say(MAP.readout(ctx));
    } else if (this.tab === 'char') R.renderChar(ctx, this._body);
    else if (this.tab === 'inv') { R.renderInv(ctx, this._body); this._detailKey = R.detailKey(); }
    else if (this.tab === 'skills') R.renderSkills(ctx, this._body);
    else if (this.tab === 'quests') R.renderQuestLog(this.game, ctx, this._body);
    else if (isReward) R.renderRewardPicker(ctx, this._reward, this._body);
    // a tab switch starts scrolled to the top; an in-place re-render (equip/upgrade/filter clicks)
    // keeps wherever the player was reading
    if (this._prevTab !== this.tab) this._body.scrollTop = 0;
    this._prevTab = this.tab;
    this._scrollAffordance();
  }
}
