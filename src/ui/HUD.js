import * as THREE from 'three';

/**
 * HUD: DOM-based heads-up display (CSS transforms, no per-frame layout thrash). Visual language: FF14 ornate gold/aether-blue frames
 * and soft glows + Destiny clarity (clean crosshair, ammo counter bottom-right, super/ability icons bottom-left, health/shield top-left-ish).
 * Elements: crosshair (per-archetype reticle, spread animation, hit marker X, crit marker color, kill flash), health + shield bars (regen shimmer),
 *   ammo (mag / reserve, low-ammo pulse, reload spinner), weapon name + element icon + slot selector (1/2/3), abilities (4 icons with radial cooldown sweep
 *   + ready pop; super meter), damage numbers (world->screen projection, float+fade, crit bigger/yellow, element colored; pooled), directional damage
 *   indicator arcs, enemy health bar above target under crosshir (name, level, shield bar), boss bar (top, with phase ticks),
 *   toasts / quest tracker (right side), interaction prompt ("[E] Talk"), pickup feed, death screen + respawn, pause menu (ESC),
 *   settings (sensitivity, fov, quality), low-health vignette pulse (CSS), sniper scope overlay, fusion charge bar,
 *   loading/start screen (click to begin), perf overlay (toggle F3 / ?debug=1).
 * API:
 *   hud.toast(text, { ms, kind }), hud.prompt(text|null), hud.damageNumber(worldPos, amount, { crit, element }), hud.hitMarker({ crit, kill }),
 *   hud.showBoss(name, getHealthFn|null) / hud.hideBoss(), hud.setQuest(title, objectiveText|null), hud.notify(title, subtitle),
 *   hud.pickup(text), hud.setPerfVisible(bool), hud.demo() (fires toasts/notify/numbers/boss for screenshots)
 * Reads: game.player (health/shield/weapons.current/abilities.list/controller.state), game.perf, game.combat.list (target under reticle).
 * Listens: 'combat:hit','player:damaged','player:died','player:respawn','weapon:fire','weapon:reload','weapon:reloaded','weapon:swap',
 *   'weapon:empty','ability:ready','ability:use','ability:end','enemy:spawn','rpg:pickup'.
 * Keeps #start click-to-begin + pointer lock; ESC (pointer unlock) opens the pause menu with sensitivity/FOV/quality wired to
 *   game.player.view.sens/baseFov and the ?q= URL param. Settings persist in localStorage (af.sens / af.fov).
 */

const EL_COL = { kinetic: '#ffe9c4', solar: '#ff8a3d', arc: '#7fd8ff', void: '#b070ff', stasis: '#9fd8ff', strand: '#7cff9c' };
const ELEM_ICON = {
  kinetic: '<path d="M8 1 14 8 8 15 2 8Z"/>',
  solar: '<path d="M8 1C10.5 4.5 13 6 13 9.8A5 5 0 0 1 3 9.8C3 6 5.5 4.5 8 1Z"/>',
  arc: '<path d="M9.5 1 3 9h4l-1.5 6L13 6H9z"/>',
  void: '<circle cx="8" cy="8" r="3.6"/><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.1"/>',
  stasis: '<path d="M8 1v14M2.2 4.7l11.6 6.6M13.8 4.7 2.2 11.3" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  strand: '<path d="M3 2c4 3 6 9 10 12M13 2C9 5 7 11 3 14" stroke="currentColor" stroke-width="1.6" fill="none"/>',
};
const AB_ICON = { // 24x24 glyphs
  grenade: '<circle cx="12" cy="12" r="5.6"/><path d="M12 2v3.4M12 18.6V22M2 12h3.4M18.6 12H22" stroke="currentColor" stroke-width="1.7"/>',
  melee: '<path d="M12 2l2.1 7.9L22 12l-7.9 2.1L12 22l-2.1-7.9L2 12l7.9-2.1Z"/>',
  class: '<path d="M12 3v9M7.5 8.5 12 13l4.5-4.5" stroke="currentColor" stroke-width="1.9" fill="none"/><path d="M4 18.5h16" stroke="currentColor" stroke-width="1.9"/><path d="M7 21h10" stroke="currentColor" stroke-width="1.3" opacity=".6"/>',
  super: '<path d="M12 1l2.6 6.9L22 9.2l-5.2 4.9 1.5 7L12 17.6 5.7 21l1.5-7L2 9.2l7.4-1.3Z"/>',
};
const RET_GAP = { handcannon: 10, autorifle: 7, pulse: 8, shotgun: 15, sniper: 6, fusion: 9 };
const svg = (vb, inner) => `<svg viewBox="0 0 ${vb} ${vb}" fill="currentColor">${inner}</svg>`;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// text/scaleX setters that only touch the DOM when the value changed
const setT = (el, v) => { if (el._t !== v) { el._t = v; el.textContent = v; } };
const setX = (el, v) => { v = clamp01(v); if (Math.abs((el._x ?? -1) - v) > 0.004) { el._x = v; el.style.transform = `scaleX(${v})`; } };
const setCls = (el, c, on) => { if (el._c?.[c] !== on) { (el._c ??= {})[c] = on; el.classList.toggle(c, on); } };

const TEMPLATE = `
<div id="lowhp"></div>
<div id="dnums"></div>
<div id="dmgdir"></div>
<div id="ch" data-arch="autorifle">
  <div class="ring"></div>
  <div class="tk tv up"></div><div class="tk tv dn"></div><div class="tk th lf"></div><div class="tk th rt"></div>
  <div class="dot"></div>
  <div id="chargebar"><i></i></div>
  <div id="hitmark"><i style="transform:rotate(45deg) translateY(-13px)"></i><i style="transform:rotate(135deg) translateY(-13px)"></i><i style="transform:rotate(225deg) translateY(-13px)"></i><i style="transform:rotate(315deg) translateY(-13px)"></i></div>
</div>
<div id="scope"><div class="lens"></div><div class="lh"></div><div class="lv"></div><div class="ld"></div></div>
<div id="tgt"><div class="tname"><span class="tn"></span><span class="tlvl"></span></div><div class="bar"><i class="ghost"></i><i class="tfill"></i><i class="tsh"></i></div></div>
<div id="boss"><div class="bname"></div><div class="bar"><i class="bfill"></i><i class="bsh"></i><s style="left:33.3%"></s><s style="left:66.6%"></s></div></div>
<div id="vitals"><div id="lvl"><b>1</b></div><div class="bars">
  <div id="sbar" class="bar"><i class="ghost"></i><i class="fill"></i><i class="shim"></i></div>
  <div id="hbar" class="bar"><i class="ghost"></i><i class="fill"></i><i class="shim"></i></div>
</div></div>
<div id="ammo">
  <div id="wline"><span id="wname"></span><span id="welem"></span></div>
  <div id="wnums"><span id="mag">—</span><span id="res">—</span></div>
  <div id="rline"><i></i></div>
  <div id="slots"><i></i><i></i><i></i></div>
</div>
<div id="abil"><div id="abrow"></div><div id="smeter"><i></i></div></div>
<div id="pickups"></div>
<div id="quest" class="hidden"><div class="qt"></div><div class="qo"></div><div class="ql"></div></div>
<div id="toasts"></div>
<div id="notify"><h2></h2><div class="fl"></div><p></p></div>
<div id="iprompt"><kbd>E</kbd><span></span></div>
<div id="death"><h1>Defeated</h1><p>press any key to return to the aetheryte</p></div>
<div id="perf"></div>`;

export class HUD {
  constructor(game) { this.game = game; this.root = document.getElementById('ui'); }

  init() {
    const g = this.game;
    this.root.innerHTML = TEMPLATE;
    const $ = (s) => this.root.querySelector(s);
    this.$ = $;
    this.perfEl = $('#perf'); this.ch = $('#ch'); this.hitEl = $('#hitmark'); this.scopeEl = $('#scope');
    this.chRing = $('#ch .ring'); this.chTk = [$('.up'), $('.dn'), $('.lf'), $('.rt')];
    this.chargeEl = $('#chargebar'); this.chargeFill = $('#chargebar i');
    this.lowhp = $('#lowhp'); this.lvlEl = $('#lvl b');
    this.sbar = $('#sbar'); this.hbar = $('#hbar');
    this.sFill = $('#sbar .fill'); this.hFill = $('#hbar .fill'); this.sGhost = $('#sbar .ghost'); this.hGhost = $('#hbar .ghost');
    this.wname = $('#wname'); this.welem = $('#welem'); this.mag = $('#mag'); this.res = $('#res');
    this.rline = $('#rline'); this.rFill = $('#rline i'); this.slotEls = [...$('#slots').children];
    this.tgtEl = $('#tgt'); this.tgtName = $('#tgt .tn'); this.tgtLvl = $('#tgt .tlvl'); this.tgtFill = $('#tgt .tfill'); this.tgtSh = $('#tgt .tsh'); this.tgtGhost = $('#tgt .ghost');
    this.bossEl = $('#boss'); this.bossName = $('#boss .bname'); this.bossFill = $('#boss .bfill'); this.bossSh = $('#boss .bsh');
    this.notifyEl = $('#notify'); this.toastsEl = $('#toasts'); this.promptEl = $('#iprompt'); this.promptTxt = $('#iprompt span');
    this.pickupsEl = $('#pickups'); this.questEl = $('#quest'); this.deathEl = $('#death');
    this.smeter = $('#smeter'); this.smFill = $('#smeter i');

    // ability icons
    this.abEls = {};
    const row = $('#abrow');
    for (const [id, key, sup] of [['super', 'X', 1], ['grenade', 'G'], ['melee', 'F'], ['class', 'Q']]) {
      const d = document.createElement('div'); d.className = 'ab' + (sup ? ' sup' : ''); d.dataset.id = id;
      d.innerHTML = `<div class="dia"><div class="in">${svg(24, AB_ICON[id])}</div><div class="cd"></div></div><b>${key}</b>`;
      row.appendChild(d); this.abEls[id] = { el: d, cd: d.querySelector('.cd'), pct: -1 };
    }

    // damage-number pool
    this.dnPool = []; this.dnActive = [];
    const dn = $('#dnums');
    for (let i = 0; i < 28; i++) { const b = document.createElement('b'); dn.appendChild(b); this.dnPool.push({ el: b, p: new THREE.Vector3(), t0: 0, amt: 0, crit: false, tgt: null, drift: 0 }); }
    // directional damage arcs pool
    this.arcPool = []; this.arcI = 0;
    const dd = $('#dmgdir');
    for (let i = 0; i < 8; i++) { const a = document.createElement('div'); a.className = 'arc'; dd.appendChild(a); this.arcPool.push(a); }

    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();
    this._acc = 0; this._slow = 0; this._gap = 10; this._boss = null; this._bossFn = null;
    this._tgt = null; this._tgtUntil = -1; this._extPrompt = null; this._proxPrompt = null; this._attuned = false;
    this._prevHp = 100; this._prevSh = 100; this._reloadT0 = -1; this._started = false; this._deadSince = -1;
    this._perfOn = g.debug; this.perfEl.style.display = this._perfOn ? '' : 'none';

    this._bindEvents();
    this._buildMenus();
    if (g.auto) { $('#start')?.remove(); }
    this.setQuest('The Sundered Spire', 'Investigate the ruins to the east');
    setTimeout(() => this.notify('The Shattered Meadow', 'Aetherfall'), 1200);

    // death screen: any key / click to respawn (after a beat so the killing blow doesn't skip it)
    const tryRespawn = () => {
      if (this.game.player.alive || this.game.time - this._deadSince < 1.2) return;
      const sp = this.game.terrain?.POI?.spawn;
      this.game.player.respawn(sp ? { x: sp.x, y: sp.y + 0.2, z: sp.z } : undefined);
    };
    window.addEventListener('keydown', tryRespawn); window.addEventListener('mousedown', tryRespawn);
  }

  // ---------- events ----------
  _bindEvents() {
    const g = this.game, ev = g.events;
    ev.on('combat:hit', (e) => {
      if (e.owner !== g.player) return;
      this.hitMarker({ crit: e.crit, kill: e.killed });
      this._dnum(e.point, e.amount, e.crit, e.element, e.target);
    });
    ev.on('player:damaged', (e) => {
      const src = e.source?.position ?? e.info?.point;
      if (src) this._dmgArc(src);
      this._barFlash();
    });
    ev.on('player:died', () => { this._deadSince = g.time; this.deathEl.classList.add('on'); this.deathEl.style.opacity = 1; });
    ev.on('player:respawn', () => { this.deathEl.classList.remove('on'); this.deathEl.style.opacity = 0; });
    ev.on('weapon:swap', ({ weapon }) => this._refreshWeapon(weapon));
    ev.on('weapon:reload', () => { this._reloadT0 = g.time; });
    ev.on('weapon:reloaded', () => { this._reloadT0 = -1; });
    ev.on('weapon:empty', () => { this.mag.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 180 }); });
    ev.on('ability:ready', ({ id }) => {
      const a = this.abEls[id]; if (!a) return;
      a.el.querySelector('.dia').animate([{ boxShadow: '0 0 30px rgba(246,227,172,0.9)' }, { boxShadow: '0 0 12px rgba(0,0,0,0.55)' }], { duration: 700, easing: 'ease-out' });
    });
    ev.on('ability:use', ({ id }) => { const a = this.abEls[id]; a?.el.animate([{ transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' }); });
    ev.on('enemy:spawn', ({ enemy }) => { if (enemy?.def?.boss) this._boss = enemy; });
    ev.on('rpg:pickup', (e) => this.pickup(e?.name ?? 'Aether Shard'));
  }

  // ---------- public API ----------
  toast(text, { ms = 2200, kind = '' } = {}) {
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = text;
    this.toastsEl.appendChild(t);
    while (this.toastsEl.children.length > 4) this.toastsEl.firstChild.remove();
    t.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' });
    setTimeout(() => { t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350 }).onfinish = () => t.remove(); }, ms);
  }
  notify(title, subtitle = '') {
    const n = this.notifyEl;
    n.querySelector('h2').textContent = title; n.querySelector('p').textContent = subtitle;
    n.getAnimations().forEach((a) => a.cancel());
    n.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'scale(1)', offset: 0.12 }, { opacity: 1, offset: 0.8 }, { opacity: 0, transform: 'scale(1.02)' }], { duration: 3600, easing: 'ease-out' });
  }
  prompt(text) { this._extPrompt = text || null; }
  pickup(text) {
    const d = document.createElement('div'); d.textContent = text; this.pickupsEl.appendChild(d);
    while (this.pickupsEl.children.length > 5) this.pickupsEl.firstChild.remove();
    d.animate([{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none', offset: 0.1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: 3200 }).onfinish = () => d.remove();
  }
  setQuest(title, objective) {
    this.questEl.classList.toggle('hidden', !title);
    if (title) { setT(this.questEl.querySelector('.qt'), title); setT(this.questEl.querySelector('.qo'), objective ?? ''); }
  }
  hitMarker({ crit = false, kill = false } = {}) {
    const h = this.hitEl;
    setCls(h, 'crit', crit && !kill); setCls(h, 'kill', kill);
    h.getAnimations().forEach((a) => a.cancel());
    h.animate(kill
      ? [{ opacity: 1, transform: 'scale(1)' }, { opacity: 1, transform: 'scale(1.8)', offset: 0.35 }, { opacity: 0, transform: 'scale(2.1)' }]
      : [{ opacity: 1, transform: 'scale(0.8)' }, { opacity: 1, transform: 'scale(1.05)', offset: 0.4 }, { opacity: 0, transform: 'scale(1.1)' }],
      { duration: kill ? 320 : 190, easing: 'ease-out' });
  }
  damageNumber(worldPos, amount, { crit = false, element = 'kinetic' } = {}) { this._dnum(worldPos, amount, crit, element, null); }
  showBoss(name, getHealthFn = null) { this._bossFn = getHealthFn; this.bossName.textContent = name; this.bossEl.style.opacity = 1; this._bossShown = true; }
  hideBoss() { this._bossFn = null; this._bossShown = false; this.bossEl.style.opacity = 0; }
  setPerfVisible(v) { this._perfOn = v; this.perfEl.style.display = v ? '' : 'none'; }
  demo() { // one call -> screenshot-ready HUD moments (critics)
    this.notify('The Hollow Crown', 'World Boss Arena'); this.toast('Super ready', { kind: 'super' });
    this.pickup('Aether Shard'); this.pickup('Glimmering Motes');
    this.showBoss('Warden of the Spire', () => ({ hp: 0.62, shield: 0.3 }));
    this.hitMarker({ crit: true });
    const p = this.game.player, d = this._v2.set(-Math.sin(p.yaw), 0.2, -Math.cos(p.yaw));
    for (let i = 0; i < 5; i++) this.damageNumber(this._v.copy(p.eye).addScaledVector(d, 8 + i * 2).add({ x: (i - 2) * 0.8, y: (i % 3) * 0.5, z: 0 }), 34 + i * 61, { crit: i === 2, element: ['arc', 'solar', 'void', 'kinetic', 'arc'][i] });
    this._dmgArc({ x: p.position.x + 10, y: 0, z: p.position.z + 4 });
  }

  // ---------- internals ----------
  _dnum(point, amount, crit, element, target) {
    // merge rapid same-target hits (autorifle spam) into one growing number
    const m = this._dnLast;
    if (m && !crit && !m.crit && target && m.tgt === target && this.game.time - m.t0 < 0.35) {
      m.amt += amount; m.t0 = this.game.time - 0.08; setT(m.el, String(Math.round(m.amt))); return;
    }
    const n = this.dnPool.length ? this.dnPool.pop() : this.dnActive.shift();
    n.p.copy(point); n.p.y += 0.25; n.t0 = this.game.time; n.amt = amount; n.crit = crit; n.tgt = target; n.drift = (Math.random() - 0.5) * 40;
    setT(n.el, String(Math.round(amount)));
    n.el.style.color = crit ? '#ffd24a' : (EL_COL[element] ?? '#fff');
    setCls(n.el, 'crit', crit);
    this.dnActive.push(n); this._dnLast = n;
  }
  _dmgArc(srcPos) {
    const p = this.game.player;
    const dx = srcPos.x - p.position.x, dz = srcPos.z - p.position.z;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const a = Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz); // + = clockwise from screen-top
    const arc = this.arcPool[this.arcI++ % this.arcPool.length];
    arc.style.transform = `rotate(${a}rad)`;
    arc.getAnimations().forEach((x) => x.cancel());
    arc.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: 950 });
  }
  _barFlash() {
    this.sbar.parentElement.animate([{ filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 260 });
  }
  _refreshWeapon(w) {
    if (!w) return;
    setT(this.wname, w.name);
    this.welem.innerHTML = svg(16, ELEM_ICON[w.element] ?? ELEM_ICON.kinetic);
    this.welem.style.color = EL_COL[w.element] ?? '#fff';
    this.ch.dataset.arch = w.archetype;
    this.wname.parentElement.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 250 });
    const ws = this.game.player.weapons;
    this.slotEls.forEach((el, i) => {
      setCls(el, 'on', i === ws.index);
      const sw = ws.slots?.[i];
      if (sw && i !== ws.index) el.style.background = `${EL_COL[sw.element] ?? '#fff'}3a`;
      else el.style.background = '';
    });
  }

  // ---------- menus ----------
  _buildMenus() {
    const g = this.game;
    if (g.auto) return;
    // No click-to-begin screen: the world loads straight in (browsers require a real click before
    // pointer lock, so a small floating hint stands in until the first capture).
    const start = document.createElement('div'); start.id = 'start'; start.className = 'strip';
    start.innerHTML = `<p class="cta">click to take the field</p>
      <p class="controls">wasd move · shift sprint · space jump (double) · lmb fire · rmb aim · q grapple · m map · esc menu</p>`;
    const pause = document.createElement('div'); pause.id = 'pause'; pause.className = 'hidden';
    pause.innerHTML = `<div id="pausebox"><h1>Aetherfall</h1>
      <label>Sensitivity <span id="sensv"></span></label><input id="sensr" type="range" min="1" max="15" step="0.5">
      <label>Field of View <span id="fovv"></span></label><input id="fovr" type="range" min="80" max="110" step="1">
      <label>Quality</label><div id="qualrow">${['low', 'medium', 'high', 'ultra'].map((q) => `<button data-q="${q}">${q}</button>`).join('')}</div>
      <button id="resume">Resume</button>
      <p class="controls">esc released the mouse — click resume or the world to continue</p></div>`;
    this.root.append(start, pause);
    const lock = () => g.input.constructor.lock(g.canvas); // user decree: pointer lock must never silently fail — Input.lock handles unadjustedMovement rejection + Chrome relock cooldown (gate-tested)
    start.addEventListener('click', lock);
    pause.querySelector('#resume').addEventListener('click', lock);
    // settings (persisted)
    const view = g.player.view;
    try { const s = +localStorage.getItem('af.sens'); if (s) view.sens = s; const f = +localStorage.getItem('af.fov'); if (f) view.baseFov = f; } catch {}
    const sensr = pause.querySelector('#sensr'), fovr = pause.querySelector('#fovr'), sensv = pause.querySelector('#sensv'), fovv = pause.querySelector('#fovv');
    const sync = () => { sensr.value = view.sens; fovr.value = view.baseFov; sensv.textContent = (+view.sens).toFixed(1); fovv.textContent = Math.round(view.baseFov); };
    sync();
    sensr.addEventListener('input', () => { view.sens = +sensr.value; sensv.textContent = (+view.sens).toFixed(1); try { localStorage.setItem('af.sens', view.sens); } catch {} });
    fovr.addEventListener('input', () => { view.baseFov = +fovr.value; fovv.textContent = Math.round(view.baseFov); try { localStorage.setItem('af.fov', view.baseFov); } catch {} });
    for (const b of pause.querySelectorAll('#qualrow button')) {
      b.classList.toggle('on', b.dataset.q === g.quality);
      b.addEventListener('click', () => { const u = new URLSearchParams(location.search); u.set('q', b.dataset.q); location.search = u.toString(); });
    }
    document.addEventListener('pointerlockchange', () => {
      const locked = !!document.pointerLockElement;
      if (locked) { this._started = true; g.paused = false; start.classList.add('hidden'); pause.classList.add('hidden'); g.rpg?.screens?.close?.(false); }
      else if (this._started) {
        g.paused = true;
        // an RPG screen (map/character/inventory) owns this unlock — it pauses without the pause menu
        if (!g.rpg?.screens?.open) { pause.classList.remove('hidden'); sync(); }
      } else start.classList.remove('hidden');
    });
    // before the first capture the world runs unpaused behind the hint — a living title screen
    start.classList.remove('hidden');
  }

  // ---------- per-frame ----------
  update(dt, t) {
    const g = this.game, p = g.player, w = p.weapons?.current;
    if (g.input.justPressed('F3')) this.setPerfVisible(!this._perfOn);

    // vitals
    const hp = p.health / p.maxHealth, sh = p.shield / p.maxShield;
    setX(this.hFill, hp); setX(this.sFill, sh);
    this.hGhost._g = Math.max(hp, (this.hGhost._g ?? hp) - dt * 0.55); setX(this.hGhost, this.hGhost._g);
    this.sGhost._g = Math.max(sh, (this.sGhost._g ?? sh) - dt * 0.55); setX(this.sGhost, this.sGhost._g);
    setCls(this.hbar, 'low', hp < 0.33);
    setCls(this.hbar, 'regen', p.health > this._prevHp + dt * 0.5 && p.health < p.maxHealth);
    setCls(this.sbar, 'regen', p.shield > this._prevSh + dt * 0.5 && p.shield < p.maxShield);
    this._prevHp = p.health; this._prevSh = p.shield;
    setT(this.lvlEl, String(p.level ?? 1));
    // low-health vignette
    const lo = p.alive ? clamp01((0.42 - hp) / 0.42) * 0.9 : 0;
    if (Math.abs((this.lowhp._o ?? -1) - lo) > 0.02) { this.lowhp._o = lo; this.lowhp.style.opacity = lo; }
    setCls(this.lowhp, 'pulse', lo > 0.25);

    // weapon / ammo
    if (w) {
      if (this._wSeen !== w) { this._wSeen = w; this._refreshWeapon(w); }
      setT(this.mag, String(w.ammo)); setT(this.res, String(w.reserve));
      setCls(this.mag, 'low', w.ammo > 0 && w.ammo <= Math.max(2, w.magSize * 0.25));
      setCls(this.mag, 'empty', w.ammo === 0);
      const rel = this._reloadT0 >= 0 && w.reloading;
      if (rel !== this._relVis) { this._relVis = rel; this.rline.style.opacity = rel ? 1 : 0.25; }
      if (rel) setX(this.rFill, (t - this._reloadT0) / (w.def?.reloadTime ?? 2)); else setX(this.rFill, 0);
      // crosshair spread -> px
      const fovV = g.camera.fov * Math.PI / 360;
      const px = Math.tan(w.spread ?? 0) * (this._h ?? innerHeight) * 0.5 / Math.tan(fovV);
      const gap = (RET_GAP[w.archetype] ?? 8) + px;
      this._gap += (gap - this._gap) * Math.min(1, dt * 22);
      if (Math.abs(this._gap - (this._gapDom ?? -9)) > 0.2) {
        const gp = this._gapDom = this._gap;
        this.chTk[0].style.transform = `translateY(${-gp - 10}px)`; this.chTk[1].style.transform = `translateY(${gp}px)`;
        this.chTk[2].style.transform = `translateX(${-gp - 10}px)`; this.chTk[3].style.transform = `translateX(${gp}px)`;
        this.chRing.style.transform = `scale(${(gp * 2 + 6) / 44})`;
      }
      // fusion charge
      const c = w.charge ?? 0;
      if ((this.chargeEl._on = c > 0) !== this.chargeEl._was) { this.chargeEl._was = this.chargeEl._on; this.chargeEl.style.opacity = c > 0 ? 1 : 0; }
      if (c > 0) setX(this.chargeFill, c);
      // sniper scope
      const scoped = !!w.def?.hideOnAds && w.ads > 0.85;
      if (scoped !== this._scoped) { this._scoped = scoped; this.scopeEl.style.opacity = scoped ? 1 : 0; }
      const chVis = p.alive && !scoped;
      if (chVis !== this._chVis) { this._chVis = chVis; this.ch.style.opacity = chVis ? 1 : 0; }
    }

    // abilities + super
    const ab = p.abilities;
    if (ab?.list) {
      for (const a of ab.list) {
        const e = this.abEls[a.id]; if (!e) continue;
        const ready = a.id === 'super' ? (a.ready && !ab.superActive) : a.ready;
        setCls(e.el, 'ready', ready);
        if (a.id === 'super') setCls(e.el, 'active', !!ab.superActive);
        if (!ready) {
          const pct = clamp01(a.charge ?? 0);
          if (Math.abs(pct - e.pct) > 0.006) { e.pct = pct; e.cd.style.background = `conic-gradient(transparent 0 ${(pct * 360).toFixed(1)}deg, rgba(4,6,14,0.78) 0)`; }
        } else e.pct = -1;
      }
      setX(this.smFill, ab.superActive ? clamp01(ab.superTimeLeft / 6) : clamp01(ab.superMeter ?? 0));
      setCls(this.smeter, 'full', (ab.superMeter ?? 0) >= 1 || ab.superActive);
    }

    // damage numbers (project + float)
    const cam = g.camera, W = this._w ?? innerWidth, H = this._h ?? innerHeight;
    for (let i = this.dnActive.length - 1; i >= 0; i--) {
      const n = this.dnActive[i]; const age = t - n.t0; const life = n.crit ? 1.05 : 0.85;
      if (age > life) { n.el.style.opacity = 0; this.dnActive.splice(i, 1); this.dnPool.push(n); if (this._dnLast === n) this._dnLast = null; continue; }
      const v = this._v.copy(n.p).project(cam);
      if (v.z > 1 || v.z < -1) { n.el.style.opacity = 0; continue; }
      const x = (v.x * 0.5 + 0.5) * W + n.drift * age, y = (0.5 - v.y * 0.5) * H - 46 * age;
      const s = n.crit ? (age < 0.12 ? 1 + (0.12 - age) * 5 : 1) : 1;
      n.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%) scale(${s.toFixed(2)})`;
      n.el.style.opacity = age > life - 0.3 ? ((life - age) / 0.3).toFixed(2) : 1;
    }

    // target nameplate (20 Hz search, per-frame bars)
    this._slow += dt;
    if (this._slow >= 0.05) {
      this._slow = 0;
      const tg = this._findTarget();
      if (tg) { this._tgt = tg; this._tgtUntil = t + 0.6; }
    }
    const showTgt = this._tgt && t < this._tgtUntil && this._tgt.alive && p.alive;
    if (showTgt !== this._tgtVis) { this._tgtVis = showTgt; this.tgtEl.style.opacity = showTgt ? 1 : 0; }
    if (showTgt) {
      const tg = this._tgt;
      setT(this.tgtName, tg.name ?? 'Enemy'); setT(this.tgtLvl, 'Lv ' + (tg.level ?? 1));
      const thp = tg.maxHealth ? tg.health / tg.maxHealth : 1;
      setX(this.tgtFill, thp); setX(this.tgtSh, tg.maxShield ? tg.shield / tg.maxShield : 0);
      this.tgtGhost._g = Math.max(thp, (this.tgtGhost._g ?? thp) - dt * 0.7); setX(this.tgtGhost, this.tgtGhost._g);
    } else this.tgtGhost._g = undefined;

    // boss bar
    if (this._bossFn) {
      const r = this._bossFn(); const hpv = typeof r === 'number' ? r : r?.hp ?? 0;
      setX(this.bossFill, hpv); setX(this.bossSh, typeof r === 'object' ? r?.shield ?? 0 : 0);
    } else if (this._boss) {
      const b = this._boss;
      const near = b.alive && b.position.distanceToSquared(p.position) < 90 * 90;
      if (near !== this._bossShown) { this._bossShown = near; this.bossEl.style.opacity = near ? 1 : 0; if (near) this.bossName.textContent = b.name; }
      if (near) { setX(this.bossFill, b.health / b.maxHealth); setX(this.bossSh, b.maxShield ? b.shield / b.maxShield : 0); }
    }

    // interaction prompt (external wins; else aetheryte proximity)
    this._acc += dt;
    if (this._acc >= 0.25) {
      this._acc = 0;
      const ae = g.terrain?.POI?.aetheryte;
      this._proxPrompt = (ae && p.position.distanceToSquared(ae) < 144) ? 'Attune to the Aetheryte' : null;
      const txt = this._extPrompt ?? this._proxPrompt;
      if (txt !== this._promptShown) { this._promptShown = txt; this.promptEl.style.opacity = txt ? 1 : 0; if (txt) setT(this.promptTxt, txt); }
      if (this._perfOn) this._perfText();
    }
    if (this._proxPrompt && !this._extPrompt && g.input.justPressed('KeyE') && !this._attuned) {
      this._attuned = true; this.toast('Attuned to the Aetheryte', { kind: 'super' }); g.events.emit('ui:click');
    }
  }

  _findTarget() {
    const g = this.game, cam = g.camera, list = g.combat?.list;
    if (!list) return null;
    const dir = this._v2; cam.getWorldDirection(dir);
    let best = null, bestA = 1e9;
    for (let i = 0; i < list.length; i++) {
      const tg = list[i];
      if (!tg.alive || tg.team !== 'enemy') continue;
      const v = this._v.copy(tg.position).sub(cam.position); const d = v.length();
      if (d > 130 || d < 0.5) continue;
      const dot = v.divideScalar(d).dot(dir);
      if (dot < 0.9) continue;
      const ang = Math.acos(Math.min(1, dot));
      const allow = Math.atan((tg.radius ?? 0.5) * 2.2 / d) + 0.02;
      if (ang < allow && ang < bestA) { bestA = ang; best = tg; }
    }
    return best;
  }

  _perfText() {
    const s = this.game.perf.stats(); const p = this.game.player;
    this.perfEl.textContent = `${s.fps} fps  ${s.frameMs.p95}ms p95  cpu ${s.cpuMs.mean}ms\ncalls ${s.calls}  tris ${(s.tris / 1000).toFixed(0)}k  ${s.memMB ?? '?'}MB\n${p.controller.state}  ${p.controller.speed?.toFixed(1)} m/s  (${p.position.x.toFixed(0)}, ${p.position.y.toFixed(0)}, ${p.position.z.toFixed(0)})`;
  }

  resize(w, h) { this._w = w; this._h = h; }
}
