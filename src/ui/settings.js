/**
 * Settings menu (ESC) + the start hint. OWNER: hud builder.
 *
 * Motion/interaction vocabulary is beUI's (beui.dev/components/motion) and is the house standard for every
 * menu from here on: segmented Tabs with a spring "layoutId" indicator that glides between items, Switches
 * with a spring thumb and a press squash, Range sliders with tick dots and a bouncing bar thumb, spring
 * pressed Buttons, and a Center-Morph modal that unfolds from its own centre with a blur cross-fade.
 * beUI ships as React + motion; this game has neither and takes no new deps, so the components are rebuilt
 * here in plain DOM + CSS custom properties (styles live in the "UI KIT" block of ui.css). The spring is one
 * shared easing token (--spring) so everything moves with the same weight.
 *
 * Persistence: one JSON blob in localStorage under `cadle.settings` (the old af.sens / af.fov keys are
 * migrated on first read). Every control writes straight through to the live system — nothing is queued and
 * nothing needs a restart except Quality, which reloads with ?q= exactly as it did before.
 *
 * Pointer lock: this module never touches the browser lock API itself. HUD passes in its `lock` callback,
 * which is the one and only path (Input.lock); tools/invariants.mjs enforces that, and the mouse escaping
 * the window is the bug it exists to stop.
 */

const KEY = 'cadle.settings';
const DEF = { sens: 5, fov: 100, invertY: 0, shake: 1, bob: 1, fps: 0, master: 0.9, sfx: 1, music: 0.3, ambient: 0.55 };
const QUALITIES = ['low', 'medium', 'high'];
const BINDS = [
  ['W A S D', 'Move'], ['Shift', 'Sprint'], ['Space', 'Jump / double jump'], ['Ctrl', 'Slide'],
  ['Mouse 1', 'Fire'], ['Mouse 2', 'Aim'], ['R', 'Reload'], ['1 2', 'Weapon slots'],
  ['G', 'Grenade'], ['F', 'Melee'], ['Q', 'Class ability'], ['X', 'Super'],
  ['E', 'Interact'], ['M', 'Map'], ['C', 'Character'], ['I', 'Inventory'], ['K', 'Skills'],
  ['F3', 'Performance overlay'], ['Esc', 'This menu'],
];

const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function load() {
  const s = { ...DEF };
  try {
    Object.assign(s, JSON.parse(localStorage.getItem(KEY) || '{}'));
    const oldSens = +localStorage.getItem('af.sens'), oldFov = +localStorage.getItem('af.fov');   // pre-menu keys
    if (oldSens && !('sens' in JSON.parse(localStorage.getItem(KEY) || '{}'))) s.sens = oldSens;
    if (oldFov && !('fov' in JSON.parse(localStorage.getItem(KEY) || '{}'))) s.fov = oldFov;
  } catch (e) {}
  return s;
}

export class Settings {
  constructor(game, hud, lock) {
    this.game = game; this.hud = hud; this.lock = lock;
    this.s = load();
    if (game.debug) this.s.fps = 1;              // ?debug=1 still boots with the overlay up; the switch can turn it off
    this.el = null;
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch (e) {} }

  /** push every value into the live systems; safe to call before those systems exist */
  apply() {
    const g = this.game, s = this.s, view = g.player?.view;
    if (view) {
      view.sens = s.sens; view.baseFov = s.fov;
      view.invertY = s.invertY ? 1 : 0; view.shakeScale = s.shake; view.bobScale = s.bob;
    }
    const a = g.audio;
    a?.setMaster?.(s.master); a?.setSfxVol?.(s.sfx); a?.setMusicVol?.(s.music); a?.setAmbientVol?.(s.ambient);
    this.hud?.setPerfVisible?.(!!s.fps);
  }

  set(key, v) { this.s[key] = v; this.save(); this.apply(); }

  // ------------------------------------------------------------------ controls
  _row(label, control, hint) {
    const r = el('div', 'ui-row');
    const l = el('label', null, `<span>${label}</span><b></b>${hint ? `<em>${hint}</em>` : ''}`);
    r.append(l, control);
    r._val = l.querySelector('b');
    return r;
  }

  /** beUI Range slider: filled track, tick dots, bar thumb that bounces on change */
  _slider(label, key, min, max, step, fmt) {
    const wrap = el('div', 'ui-range');
    const input = el('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    wrap.append(input, el('i', 'ticks'));
    const row = this._row(label, wrap);
    const paint = () => {
      const v = +input.value, p = (v - min) / (max - min);
      input.style.setProperty('--p', (p * 100).toFixed(2) + '%');
      row._val.textContent = fmt(v);
    };
    input.addEventListener('input', () => {
      this.set(key, +input.value); paint();
      wrap.classList.remove('bump'); void wrap.offsetWidth; wrap.classList.add('bump');
    });
    row._sync = () => { input.value = this.s[key]; paint(); };
    return row;
  }

  /** beUI Switch: spring thumb, squash while pressed */
  _switch(label, key, hint) {
    const b = el('button', 'ui-switch', '<i></i>');
    b.type = 'button'; b.setAttribute('role', 'switch');
    const row = this._row(label, b, hint);
    const paint = () => { const on = !!this.s[key]; b.setAttribute('aria-checked', on); b.classList.toggle('on', on); row._val.textContent = on ? 'On' : 'Off'; };
    b.addEventListener('click', () => { this.set(key, this.s[key] ? 0 : 1); paint(); });
    row._sync = paint;
    return row;
  }

  /** beUI segmented control: one pill glides under the active item (the layoutId indicator) */
  _seg(items, getIndex, onPick, cls = '') {
    const seg = el('div', 'ui-seg ' + cls);
    seg.style.setProperty('--n', items.length);
    seg.append(el('span', 'ind'));
    items.forEach((t, i) => {
      const b = el('button', null, t); b.type = 'button';
      b.addEventListener('click', () => onPick(i, t));
      seg.append(b);
    });
    seg._sync = () => {
      const i = getIndex();
      seg.style.setProperty('--i', i);
      [...seg.querySelectorAll('button')].forEach((b, k) => b.classList.toggle('on', k === i));
    };
    return seg;
  }

  // ------------------------------------------------------------------ build
  build(root) {
    if (this.el) return this.el;
    const g = this.game;
    const wrap = el('div', 'ui-scrim hidden'); wrap.id = 'pause';
    const modal = el('div', 'ui-modal');
    modal.innerHTML = `
      <div class="mhead">
        <div class="mtitle"><h1>Cadle</h1><p>settings</p></div>
        <div class="mflourish"></div>
      </div>
      <div class="mtabs"></div>
      <div class="mbody"></div>
      <div class="mfoot"></div>`;
    wrap.append(modal);

    const tabsHost = modal.querySelector('.mtabs');
    const body = modal.querySelector('.mbody');
    const foot = modal.querySelector('.mfoot');

    // ---- panes
    const panes = {};
    const pane = (id) => (panes[id] = el('div', 'mpane'));

    const game_ = pane('game');
    const rows = [];
    const add = (host, row) => { host.append(row); rows.push(row); return row; };
    add(game_, this._slider('Look sensitivity', 'sens', 1, 15, 0.5, (v) => v.toFixed(1)));
    add(game_, this._switch('Invert vertical look', 'invertY'));
    add(game_, this._slider('Field of view', 'fov', 80, 110, 1, (v) => Math.round(v) + '°'));
    add(game_, this._slider('Camera shake', 'shake', 0, 1.5, 0.05, (v) => Math.round(v * 100) + '%'));
    add(game_, this._slider('Head bob', 'bob', 0, 1.5, 0.05, (v) => Math.round(v * 100) + '%'));

    const video = pane('video');
    const qseg = this._seg(QUALITIES.map((q) => q[0].toUpperCase() + q.slice(1)), () => Math.max(0, QUALITIES.indexOf(g.quality)), (i) => {
      const u = new URLSearchParams(location.search); u.set('q', QUALITIES[i]); location.search = u.toString();
    });
    const qrow = this._row('Quality preset', qseg, 'reloads the world');
    qrow._val.textContent = '';   // the segmented control already names the preset
    qrow._sync = () => qseg._sync();
    add(video, qrow);
    add(video, this._switch('Performance overlay', 'fps', 'frame time, draw calls, position'));

    const audio = pane('audio');
    const pct = (v) => Math.round(v * 100) + '%';
    add(audio, this._slider('Master', 'master', 0, 1, 0.05, pct));
    add(audio, this._slider('Weapons & world', 'sfx', 0, 1, 0.05, pct));
    add(audio, this._slider('Music', 'music', 0, 1, 0.05, pct));
    add(audio, this._slider('Ambience', 'ambient', 0, 1, 0.05, pct));

    const controls = pane('controls');
    const grid = el('div', 'kbgrid');
    for (const [k, what] of BINDS) grid.append(el('div', 'kb', `<kbd>${k}</kbd><span>${what}</span>`));
    controls.append(grid);

    for (const p of Object.values(panes)) body.append(p);

    // ---- tabs (same segmented component, so the menu moves like one thing)
    const TABS = ['game', 'video', 'audio', 'controls'];
    this.tab = 'game';
    const tabseg = this._seg(['Gameplay', 'Video', 'Audio', 'Controls'], () => TABS.indexOf(this.tab), (i) => {
      this.tab = TABS[i]; this.sync();
    }, 'tabs');
    tabsHost.append(tabseg);

    // ---- footer
    const reset = el('button', 'ui-btn ghost', 'Reset to defaults'); reset.type = 'button';
    reset.addEventListener('click', () => { this.s = { ...DEF }; this.save(); this.apply(); this.sync(); });
    const resume = el('button', 'ui-btn primary', 'Resume'); resume.type = 'button'; resume.id = 'resume';
    resume.addEventListener('click', this.lock);
    foot.append(el('p', 'mhint', 'Esc released the mouse — resume, or click the world'), reset, resume);

    this.sync = () => {
      for (const [id, p] of Object.entries(panes)) p.classList.toggle('on', id === this.tab);
      tabseg._sync();
      for (const r of rows) r._sync?.();
    };
    this.sync();

    root.append(wrap);
    this.el = wrap;
    return wrap;
  }

  show() { this.sync(); this.el?.classList.remove('hidden'); requestAnimationFrame(() => this.el?.classList.add('on')); }
  hide() { this.el?.classList.remove('on'); this.el?.classList.add('hidden'); }
}

export { clamp };
