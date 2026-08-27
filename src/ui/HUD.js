import * as THREE from 'three';
import { Settings } from './settings.js';
import * as MAP from './mapscreen.js';
import { BIOMES, regionAt } from '../world/Biomes.js';

/**
 * HUD: DOM-based heads-up display (CSS transforms, no per-frame layout thrash). Visual language: FF14 ornate gold/aether-blue frames
 * and soft glows + Destiny clarity (clean crosshair, ammo counter bottom-right, super/ability icons bottom-left, health/shield top-left-ish).
 * Elements: crosshair (per-archetype reticle, spread animation, hit marker X, crit marker color, kill flash), health + shield bars (regen shimmer),
 *   ammo (mag / reserve, low-ammo pulse, reload spinner), weapon name + element icon + slot selector (1/2/3), abilities (4 icons with radial cooldown sweep
 *   + ready pop; super meter), damage numbers (world->screen projection, float+fade, crit bigger/yellow, element colored; pooled), directional damage
 *   indicator arcs, enemy health bar above target under crosshir (name, level, shield bar), boss bar (top, with phase ticks),
 *   escort guide frame (world-tracked nameplate + health bar, green — see hud.showGuide/hideGuide),
 *   NAMED RARES (`enemy.namedRare` / `enemy.name`, Enemies.js) — a wandering elite never steals the boss bar: it gets the
 *     ordinary target nameplate re-keyed gold with a "Rare" tag (#tgt.rare), a gold ringed diamond on the minimap that
 *     clamps to the rim when it is off the disc (so it reads as a destination you can choose to walk to), a ringed +
 *     named saltire on the map screen (ui/mapscreen.js + its legend), and a gold centre banner on the kill — on top of
 *     the "<NAME> FALLS" toast Enemies.js already feeds,
 *   loot markers (N simultaneous world-tracked nameplates, e.g. legendary+ drops — see hud.marker),
 *   toasts / quest tracker (right side), interaction prompt ("[E] Talk"), pickup feed, death screen + respawn, pause menu (ESC),
 *   settings (sensitivity, fov, quality), low-health vignette pulse (CSS), sniper scope overlay, fusion charge bar,
 *   loading/start screen (click to begin), perf overlay (toggle F3 / ?debug=1).
 * API:
 *   hud.toast(text, { ms, kind }), hud.prompt(text|null, { key2, text2 }?) (opts add a second bindable
 *     action to the same prompt, e.g. loot's "[E] Take · [T] Take & Equip"), hud.damageNumber(worldPos, amount, { crit, element }), hud.hitMarker({ crit, kill }),
 *   hud.showBoss(name, getHealthFn|null) / hud.hideBoss(), hud.showGuide(enemy) / hud.hideGuide() (escort guide frame — `enemy` is the
 *     live Enemies.js Enemy instance, read every frame for position/health/alive; never a boss-bar reuse, a friendly reading as a
 *     boss is worse than no bar — own element, own green palette; auto-hides if `enemy.alive` goes false as a safety net, but the
 *     normal path is Enemies.despawnFriendly calling hideGuide itself), hud.marker({ id, text, sub, sub2, subKind,
 *     position, kind, color }) -> unmark() (world-tracked nameplate, N at once — content set once, position read
 *     live every frame; see its doc-comment), hud.notify(title, subtitle, note, kind) (kind 'rare' re-keys the card gold),
 *   hud.pickup(text), hud.setPerfVisible(bool), hud.demo() (fires toasts/notify/numbers/boss for screenshots)
 *   hud.setQuest(title, objective, others) — the tracker (right side, under the minimap):
 *     title: falsy hides the tracker.
 *     objective: legacy single string (shown plain, no counter) OR an array of
 *       { text, have?, need?, done? } — one line per objective, `have`/`need` render as a
 *       tabular-nums counter, and a line reads as `done` when `.done` is true or `have >= need`.
 *     others (optional): an array of other active quest titles, or a plain count number — renders
 *       one compact dim line under the objectives ("+2 other quests"). Omit when there is nothing else tracked.
 * Reads: game.player (health/shield/weapons.current/abilities.list/controller.state), game.perf, game.combat.list (target under reticle).
 * Listens: 'combat:hit','player:damaged','player:died','player:respawn','weapon:fire','weapon:reload','weapon:reloaded','weapon:swap',
 *   'weapon:empty','ability:ready','ability:use','ability:end','enemy:spawn','rpg:pickup'.
 * Keeps #start click-to-begin + pointer lock; ESC (pointer unlock) opens the pause menu with sensitivity/FOV/quality wired to
 *   game.player.view.sens/baseFov and the ?q= URL param. Settings persist in localStorage (af.sens / af.fov).
 */

const EL_COL = { kinetic: '#ffe9c4', solar: '#ff8a3d', arc: '#7fd8ff', void: '#b070ff', stasis: '#9fd8ff', strand: '#7cff9c' };
// Approximate screen footprint of a loot plate, used only to detect overlap between two of them.
// Deliberately not measured from the DOM: getBoundingClientRect() on every plate every frame is a
// forced layout, and being a few pixels out just means plates stack slightly early.
const MK_W = 230, MK_H = 46;
// marker() verdict accent — a colour ADD-ON only; the ▲/▼/◆ glyph the caller bakes into the text
// is what actually reads as better/worse/sidegrade (see marker()'s doc-comment).
const VERDICT_COLOR = { better: '#8ee07a', worse: '#ff8a72', sidegrade: '#8fd8ff' };
const ELEM_ICON = {
  kinetic: '<path d="M8 1 14 8 8 15 2 8Z"/>',
  solar: '<path d="M8 1C10.5 4.5 13 6 13 9.8A5 5 0 0 1 3 9.8C3 6 5.5 4.5 8 1Z"/>',
  arc: '<path d="M9.5 1 3 9h4l-1.5 6L13 6H9z"/>',
  void: '<circle cx="8" cy="8" r="3.6"/><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.1"/>',
  stasis: '<path d="M8 1v14M2.2 4.7l11.6 6.6M13.8 4.7 2.2 11.3" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  strand: '<path d="M3 2c4 3 6 9 10 12M13 2C9 5 7 11 3 14" stroke="currentColor" stroke-width="1.6" fill="none"/>',
};
const AB_ICON = { // 24x24 glyphs — each one has to READ as the ability it fires (user call 2026-08-21).
  // Drawn fat on purpose: they render ~25 px inside the diamond, so nothing thinner than ~2 px survives.
  grenade: '<circle cx="10.5" cy="14.5" r="6.8"/><path d="M15.4 9.6 18.6 6.4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M19.4 1.6 20.6 5.2 24 6.4l-3.4 1.2-1.2 3.6-1.2-3.6L14.8 6.4l3.4-1.2Z"/>',
  melee: '<path d="M7.2 21.6c-2.2-1.6-3.3-3.6-3.3-6V10a1.5 1.5 0 0 1 3 0v2.6h.4V4.6a1.55 1.55 0 0 1 3.1 0v8h.4V3.2a1.55 1.55 0 0 1 3.1 0v9.4h.4V6.4a1.5 1.5 0 0 1 3 0v7.8c0 3.5-1.3 6-3.6 7.4Z"/><path d="M20.4 1.4 16 8.6h3.4l-1.2 5.2L23 6.2h-3.4Z"/>',
  class: '<path d="M2.4 2.2c3.4 1.4 6 3.3 7.7 5.7 1.5 2.1 2.3 4.4 2.4 6.8" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/><rect x="10.6" y="12.4" width="6" height="2.8" rx="1"/><path d="M13.6 15.2v3.4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M13.6 18.4c0 2.4-1.6 3.8-4.2 4.1M13.6 18.4c0 2.4 1.6 3.8 4.2 4.1" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
  super: '<path d="M15 1.4 16.7 6.7 22 8.4l-5.3 1.7L15 15.4l-1.7-5.3L8 8.4l5.3-1.7Z"/><path d="M9.4 12.2 4.2 17.4M12.4 15.2 9 18.6M6.4 9.2 2.6 13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" opacity=".75"/><path d="M4 21.4c0-1.5 3.6-2.6 8-2.6s8 1.1 8 2.6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
};
// Sentinel for hud.prompt()'s single-string encoding of a second bindable action — see prompt()'s
// doc-comment.  (SOH) can't appear in any generated item name/label, so splitting on it is safe.
const PROMPT_SEP = '';
const MM_SPAN = 300;   // metres across the minimap disc — wide enough that the lake/ruins/forest edges read
const RET_GAP = { handcannon: 10, autorifle: 7, pulse: 8, shotgun: 15, sniper: 6, fusion: 9, scout: 7, beam: 11 };
const svg = (vb, inner) => `<svg viewBox="0 0 ${vb} ${vb}" fill="currentColor">${inner}</svg>`;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// combat.list / the 'combat:hit' event carry Enemy.target — a COMBAT ADAPTER ({name, level, health, ...,
// enemy: <the Enemy>}), not the Enemy itself. Only the Enemy has `namedRare`, so every rare check has to
// hop the back-reference. Accepts either shape so callers holding a real Enemy (map screen) also work.
const isRare = (t) => !!(t && (t.namedRare || t.enemy?.namedRare));
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// The quest engine's objective text already carries a baked-in "— h / n" (or a trailing "✓" when
// h>=n===1) for the benefit of an old string-only HUD (see src/rpg/quest.js's own doc-comment). This
// HUD renders its own counter/checkmark column, so that suffix would double up — strip it back off.
const stripObjCount = (s) => String(s == null ? '' : s).replace(/\s*(?:[—-]\s*\d+\s*\/\s*\d+|✓)\s*$/, '');
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
<div id="tgt"><div class="tname"><i class="trare">&#9670;&nbsp;Rare</i><span class="tn"></span><span class="tlvl"></span></div><div class="bar"><i class="ghost"></i><i class="tfill"></i><i class="tsh"></i></div></div>
<div id="boss"><div class="bname"></div><div class="bar"><i class="bfill"></i><i class="bsh"></i><s style="left:33.3%"></s><s style="left:66.6%"></s></div></div>
<div id="guide"><div class="gname"></div><div class="bar"><i class="gfill"></i></div></div>
<div id="markers"></div>
<div id="vitals"><div id="lvl"><b>1</b></div><div class="bars">
  <div id="hbar" class="bar"><i class="ghost"></i><i class="fill"></i><i class="shim"></i><span class="hpnum"></span></div>
  <div id="bbar" class="bar hidden"><i class="fill"></i></div>
</div></div>
<div id="ammo">
  <div id="wline"><span id="wname"></span><span id="welem"></span></div>
  <div id="wnums"><span id="mag">—</span><span id="res">—</span></div>
  <div id="rline"><i></i></div>
  <div id="glim"><svg width="11" height="11" viewBox="0 0 11 11"><path d="M5.5 0 11 5.5 5.5 11 0 5.5Z" fill="#d3a548" stroke="#8a6119"/></svg><b>0</b><u>glimmer</u></div>
</div>
<div id="wslots"></div>
<div id="minimap"><canvas width="164" height="164"></canvas><i class="rim"></i><b class="np">N</b><div class="zone"></div><div class="wpd"></div></div>
<div id="abil"><div id="abrow"></div><div id="smeter"><i></i></div></div>
<div id="pickups"></div>
<div id="quest" class="hidden"><div class="qt"></div><div class="qlist"></div><div class="qothers"></div></div>
<div id="toasts"></div>
<div id="notify"><h2></h2><div class="fl"></div><p></p></div>
<div id="iprompt"><kbd>E</kbd><span class="ipt"></span><span class="ip2" style="display:none">&nbsp;&middot;&nbsp;<kbd class="ipk2"></kbd><span class="ipt2"></span></span></div>
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
    this.hbar = $('#hbar');
    this.hFill = $('#hbar .fill'); this.hGhost = $('#hbar .ghost'); this.hpNum = $('#hbar .hpnum');
    this.bbar = $('#bbar'); this.bFill = $('#bbar .fill');
    this.wname = $('#wname'); this.welem = $('#welem'); this.mag = $('#mag'); this.res = $('#res');
    this.rline = $('#rline'); this.rFill = $('#rline i');
    this.glimEl = $('#glim'); this.glimNum = $('#glim b');   // wallet balance — src/rpg glimmer economy
    this.wslots = $('#wslots'); this.slotEls = [];
    this.mmCv = $('#minimap canvas'); this.mmZone = $('#minimap .zone'); this.mmWpd = $('#minimap .wpd');
    this.tgtEl = $('#tgt'); this.tgtName = $('#tgt .tn'); this.tgtLvl = $('#tgt .tlvl'); this.tgtFill = $('#tgt .tfill'); this.tgtSh = $('#tgt .tsh'); this.tgtGhost = $('#tgt .ghost');
    this.bossEl = $('#boss'); this.bossName = $('#boss .bname'); this.bossFill = $('#boss .bfill'); this.bossSh = $('#boss .bsh');
    this.guideEl = $('#guide'); this.guideName = $('#guide .gname'); this.guideFill = $('#guide .gfill');
    this.markersEl = $('#markers'); this.markersEl.style.cssText = 'position:absolute;left:0;top:0;';
    this._markers = new Map();
    this.notifyEl = $('#notify'); this.toastsEl = $('#toasts'); this.promptEl = $('#iprompt'); this.promptTxt = $('#iprompt .ipt');
    // second bindable action on the same prompt — e.g. loot's "[E] Take · [T] Take & Equip" (see prompt())
    this.promptEl2 = $('#iprompt .ip2'); this.promptKey2 = $('#iprompt .ipk2'); this.promptTxt2 = $('#iprompt .ipt2');
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

    // Minimap: blits a window out of the SAME cached parchment hillshade the map screen (M) uses, so the
    // one 512x512 heightAt() pass is paid once for both. Kicked off on idle so it never lands in a boot frame.
    this._mmT = -9; this._mmX = 1e9; this._mmZ = 0; this._mmYaw = 9; this._mmZoneT = -9;
    // 8 ms slices: the whole sheet is ~1 s of heightAt() and one blocking pass shows up as a second-long
    // p99 spike in the perf report. setTimeout(0), not requestIdleCallback: the game never goes idle at 140 fps, so idle callbacks either
    // never fire or fire twice a second and the sheet takes a minute. A 0 ms timeout yields to the event loop
    // between slices, so the loop keeps rendering and each frame gives up at most one slice.
    const buildSheet = () => { try { const c = g.rpg?.ctx; if (!c || !MAP.build(c, 8)) setTimeout(buildSheet, 0); } catch (e) {} };
    setTimeout(buildSheet, 300);

    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();
    this._acc = 0; this._slow = 0; this._gap = 10; this._boss = null; this._bossFn = null;
    this._guide = null; this._guideVis = false;
    this._tgt = null; this._tgtUntil = -1; this._extPrompt = null; this._proxPrompt = null; this._attuned = false;
    this._prevHp = 100; this._prevSh = 100; this._reloadT0 = -1; this._started = false; this._deadSince = -1;
    this._perfOn = g.debug; this.perfEl.style.display = this._perfOn ? '' : 'none';

    this._bindEvents();
    this._buildMenus();
    if (g.auto) { $('#start')?.remove(); }

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
      // NAMED RARE kill banner. Enemies.js already drops a "<NAME> FALLS" line into the toast feed;
      // this is the Destiny beat on top of it — the centre card the zone crossing uses, in the rare's
      // own warm gold instead of the aether blue, so a wandering elite dying reads as an event and
      // not as another line scrolling past the ability toasts.
      if (e.killed && isRare(e.target)) this.notify(e.target.enemy?.name ?? e.target.name ?? 'Rare Slain', 'rare felled', '', 'rare');
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
    // wallet moved (mote collected, quest paid, shop purchase): tick the balance at once + a brief pulse
    ev.on('rpg:currency', (c) => {
      if (!this.glimNum) return;
      setT(this.glimNum, String((c && c.glimmer) | 0));
      this.glimEl.animate([{ filter: 'brightness(1.9)' }, { filter: 'brightness(1)' }], { duration: 420, easing: 'ease-out' });
    });
  }

  // ---------- public API ----------
  toast(text, { ms = 2200, kind = '' } = {}) {
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = text;
    this.toastsEl.appendChild(t);
    while (this.toastsEl.children.length > 4) this.toastsEl.firstChild.remove();
    t.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' });
    setTimeout(() => { t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350 }).onfinish = () => t.remove(); }, ms);
  }
  notify(title, subtitle = '', note = '', kind = '') {
    const n = this.notifyEl;
    setCls(n, 'rare', kind === 'rare');
    n.querySelector('h2').textContent = title; n.querySelector('p').textContent = subtitle;
    // third line: the RULES of the place (low gravity, lava, swimming). Only regions that really change
    // something set it — see BIOMES[].passive. textContent, never innerHTML: this string is content, not markup.
    let e = n.querySelector('.rule'); if (!e) { e = document.createElement('p'); e.className = 'rule'; n.appendChild(e); }
    e.textContent = note; e.style.display = note ? '' : 'none';
    n.getAnimations().forEach((a) => a.cancel());
    n.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'scale(1)', offset: 0.12 }, { opacity: 1, offset: 0.8 }, { opacity: 0, transform: 'scale(1.02)' }], { duration: 3600, easing: 'ease-out' });
  }
  /** External interaction prompt, bottom-center. `text` null/'' clears it. `opts.key2`/`opts.text2`
   *  add a second bindable action on the SAME prompt — e.g. loot's "[E] Take · [T] Take & Equip" —
   *  without disturbing every other caller (aetheryte, chests, steles), which just pass `text`.
   *  RPG.js's ctx.hud.prompt adapter only forwards ONE argument (`(t) => hud.prompt(t)`, and that
   *  file belongs to another owner), so a second-key caller reaching through ctx.hud must instead
   *  fold `key2`/`text2` into `text` itself, joined by PROMPT_SEP — parsed back out below. Direct
   *  callers of hud.prompt (not through ctx) can just pass `opts` normally. */
  prompt(text, opts) {
    let t = text || null, o = (t && opts) ? opts : null;
    if (t && !o && t.indexOf(PROMPT_SEP) !== -1) {
      const [main, key2, text2] = t.split(PROMPT_SEP);
      t = main; o = key2 ? { key2, text2 } : null;
    }
    this._extPrompt = t; this._extPrompt2 = o;
  }
  pickup(text) {
    const d = document.createElement('div'); d.textContent = text; this.pickupsEl.appendChild(d);
    while (this.pickupsEl.children.length > 5) this.pickupsEl.firstChild.remove();
    d.animate([{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none', offset: 0.1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: 3200 }).onfinish = () => d.remove();
  }
  /** Multi-objective quest tracker. See the class doc-comment for the `objective`/`others` shapes.
   *  DOM is only touched when the rendered content actually changed (signature-compared), matching
   *  every other HUD element's no-per-frame-churn rule — callers may pass this every tick safely. */
  setQuest(title, objective, others) {
    this.questEl.classList.toggle('hidden', !title);
    this._qt ??= this.questEl.querySelector('.qt');
    this._qList ??= this.questEl.querySelector('.qlist');
    this._qOthers ??= this.questEl.querySelector('.qothers');
    if (!title) return;
    setT(this._qt, title);
    const objs = Array.isArray(objective) ? objective.slice(0, 6) : (objective ? [{ text: String(objective) }] : []);
    const sig = objs.map((o) => `${o.text}|${o.have ?? ''}|${o.need ?? ''}|${o.done ? 1 : 0}`).join(';');
    if (this._qSig !== sig) {
      this._qSig = sig;
      this._qList.innerHTML = objs.map((o) => {
        const done = !!o.done || (o.have != null && o.need != null && o.have >= o.need);
        // reach/escort are not countable — a "0 / 1" next to "Reach the ruins" reads as a bug.
        // The live progress toward those already lives on the minimap waypoint readout (see
        // _minimap's mmWpd) while the quest is tracked, so this line just stays quiet instead.
        const hasCounter = (o.type !== 'reach' && o.type !== 'escort') && o.have != null && o.need != null;
        const counter = hasCounter ? `<span class="qc">${o.have} / ${o.need}</span>` : '';
        const text = (o.have != null && o.need != null) ? stripObjCount(o.text) : o.text;
        return `<div class="qo-line${done ? ' done' : ''}"><i class="qmark">${done ? '✓' : '▸'}</i><span class="qtx">${escHtml(text)}</span>${counter}</div>`;
      }).join('');
    }
    const n = Array.isArray(others) ? others.length : (others | 0);
    const othTxt = !n ? '' : Array.isArray(others)
      ? `+${n} more: ${others.slice(0, 3).join(', ')}${n > 3 ? '…' : ''}`
      : `+${n} other quest${n > 1 ? 's' : ''} tracked`;
    setT(this._qOthers, othTxt); // textContent — safe without escaping
    if (this._qOthersShown !== !!othTxt) { this._qOthersShown = !!othTxt; this._qOthers.style.display = othTxt ? '' : 'none'; }
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
  /** Escort guide frame: world-anchored (screen-projected every frame, not fixed top-of-screen like #tgt/#boss —
   *  the player is usually walking beside it, not staring down the crosshair at it) nameplate + health bar for
   *  the one active Enemies.friendly guide. `enemy` is the live Enemy instance; update() reads its .center/
   *  .health/.maxHealth/.alive directly every frame so the bar visibly moves as it's hit and the plate follows
   *  it walking, with zero per-frame allocation here beyond the one shared projection vector. */
  showGuide(enemy) { this._guide = enemy; setT(this.guideName, enemy.name ?? 'Wayfinder'); }
  hideGuide() { this._guide = null; if (this._guideVis) { this._guideVis = false; this.guideEl.style.opacity = 0; } }
  /**
   * A world-projected floating nameplate — same screen-projection technique as showGuide/
   * damageNumber, generalised to N independent, simultaneous plates (loot.js puts one per
   * legendary+ drop and per quest item). `position` is read LIVE every frame — pass the caller's
   * own THREE.Vector3 (e.g. a falling drop's `.pos`), never a clone, so the plate tracks a moving
   * object with zero per-frame allocation here beyond the one shared projection vector update()
   * already uses for damage numbers and the guide frame.
   * `text`/`sub`/`sub2`/`color` are static content, set ONCE at creation — loot.js deliberately
   * computes its verdict at drop time and never touches it again (see loot.js's nameplate()); a
   * caller that genuinely needs the content to change calls the returned unmark() and marker()
   * again rather than mutating a live plate every frame.
   *   hud.marker({ id, text, sub, sub2, subKind, position, kind, color }) -> unmark()
   * `subKind`: 'better' | 'worse' | 'sidegrade' | '' — a colour ACCENT on `sub` only; the glyph
   * baked into `sub`/`sub2` by the caller (▲/▼/◆ + a word) is what actually carries the meaning,
   * so the plate still reads with colour off.
   * `id`: optional de-dupe key — calling marker() again with the same id retires the old plate.
   * `nearFade`: optional [d0, d1] — opacity ramps 0 at distance <= d0 to 1 at distance >= d1 (metres to
   *   camera), recomputed every frame alongside the existing on-screen check. For a marker that should
   *   get out of the way once you're close (e.g. a quest-giver icon handing off to an [E] prompt) rather
   *   than a static plate. Omit for the old binary on/off-screen behaviour.
   * `kind: 'quest'`: a bare glyph icon (no panel/border) instead of a nameplate — see Props._questGiverState.
   */
  marker({ id, text, sub = '', sub2 = '', subKind = '', position, kind = '', color = '', nearFade = null } = {}) {
    if (id && this._markers.has(id)) this._markers.get(id).unmark();
    const el = document.createElement('div');
    el.className = 'mk' + (kind ? ' mk-' + kind : '');
    const nameEl = document.createElement('b'); nameEl.textContent = text || '';
    if (kind === 'quest') {
      // a floating icon badge (WoW/FF14 "!"/"?"), not a nameplate — this is the whole fix for "the NPC
      // vanishes at range": DOM text is a fixed pixel size on screen, so unlike the 3D model it never
      // shrinks with world distance. A bare glyph on transparent background (the first cut of this)
      // measured unreadable: "!" is a ~7 px sliver at font-size 27 that disappears into gold autumn
      // foliage or a bright sky. A solid dark badge behind it guarantees contrast against ANY backdrop,
      // exactly like the genre's icon convention — the glyph is what carries the state, not the badge.
      el.style.cssText = 'position:absolute;left:0;top:0;opacity:0;pointer-events:none;text-align:center;white-space:nowrap;' +
        'width:32px;height:32px;border-radius:50%;background:radial-gradient(circle at 35% 30%,rgba(46,36,22,.94),rgba(8,6,4,.90));' +
        'border:1.5px solid ' + (color || 'var(--gold-hi)') + ';box-shadow:0 2px 8px rgba(0,0,0,.7)' + (color ? ',0 0 12px ' + color + '99' : '') + ';';
      nameEl.style.cssText = 'display:block;width:32px;height:32px;line-height:32px;font:800 21px/32px var(--serif);' +
        'color:' + (color || 'var(--gold-hi)') + ';text-shadow:0 1px 2px rgba(0,0,0,.9);';
    } else {
      el.style.cssText = 'position:absolute;left:0;top:0;opacity:0;pointer-events:none;text-align:center;' +
        'white-space:nowrap;transition:opacity .15s;padding:3px 11px;border-radius:3px;background:var(--panel);' +
        'border:1px solid ' + (color || 'var(--gold-dim)') + ';box-shadow:0 2px 10px rgba(0,0,0,.55)' +
        (color ? ',0 0 10px ' + color + '66' : '') + ';';
      nameEl.style.cssText = 'display:block;font:500 12.5px var(--serif);font-variant:small-caps;' +
        'letter-spacing:.08em;color:var(--ivory);text-shadow:0 1px 3px #000;';
    }
    el.appendChild(nameEl);
    if (sub) {
      const subEl = document.createElement('i'); subEl.textContent = sub;
      subEl.style.cssText = "display:block;font:700 11px 'Segoe UI',sans-serif;font-style:normal;" +
        'letter-spacing:.02em;margin-top:1px;text-shadow:0 1px 3px #000;color:' + (VERDICT_COLOR[subKind] || 'var(--gold-hi)') + ';';
      el.appendChild(subEl);
    }
    let detailEl = null;
    if (sub2) {
      const s2 = document.createElement('i'); s2.textContent = sub2;
      s2.style.cssText = "display:block;font:400 10px 'Segoe UI',sans-serif;font-style:normal;color:var(--gold-dim);margin-top:1px;";
      el.appendChild(s2); detailEl = s2;   // hidden when this plate is not the nearest — see update()
    }
    this.markersEl.appendChild(el);
    const key = id || el;
    // Quest glyphs anchor on the GIVER'S FEET (Props hands us the NPC's stand point, which is what the
    // [E] radius and `steleAt` are measured from) — projected raw, the "!" then sits at ankle height and,
    // wherever the giver is standing in water, on the water sheet itself (shadowfen verdict, 3 waves).
    // Lift it a head-and-a-bit in WORLD space so it reads as the genre's over-the-head badge at every
    // distance and angle. `_d` stays on the feet so nearFade's hand-off radii keep their tuning.
    const rec = { el, pos: position, yOff: kind === 'quest' ? 2.4 : 0, vis: false, detailEl, nearFade, _compact: false, _x: 0, _y: 0, _d: 0, _op: -1 };
    rec.unmark = () => { if (rec.dead) return; rec.dead = true; el.remove(); if (this._markers.get(key) === rec) this._markers.delete(key); };
    this._markers.set(key, rec);
    return rec.unmark;
  }
  setPerfVisible(v) { this._perfOn = v; this.perfEl.style.display = v ? '' : 'none'; }
  demo() { // one call -> screenshot-ready HUD moments (critics)
    this.setQuest('The Sundered Spire', [
      { text: 'Slay frostwolves', have: 3, need: 8 },
      { text: 'Recover frost shards', have: 5, need: 5, done: true },
      { text: 'Speak with the Warden' },
    ], ['Whispers in the Wood', 'A Cold Debt']);
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
    this.hbar.parentElement.animate([{ filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 260 });
  }
  _refreshWeapon(w) {
    if (!w) return;
    setT(this.wname, w.name);
    this.welem.innerHTML = svg(16, ELEM_ICON[w.element] ?? ELEM_ICON.kinetic);
    this.welem.style.color = EL_COL[w.element] ?? '#fff';
    this.ch.dataset.arch = w.archetype;
    this.wname.parentElement.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 250 });
    this._syncSlots();
  }

  /** Carried loadout, bottom-centre: one card per slot (two — kinetic + energy). Rebuilt only when the slot
   *  list itself changes; the ammo line ticks in update(). */
  _syncSlots() {
    const ws = this.game.player.weapons; if (!ws?.slots?.length) return;
    if (this.slotEls.length !== ws.slots.length) {
      this.wslots.innerHTML = '';
      this.slotEls = ws.slots.map((_, i) => {
        const d = document.createElement('div'); d.className = 'wslot';
        d.innerHTML = `<b class="k">${i + 1}</b><s class="wel"></s><span class="wn"></span><span class="wa"></span>`;
        this.wslots.appendChild(d);
        return { el: d, nm: d.querySelector('.wn'), am: d.querySelector('.wa'), ic: d.querySelector('.wel') };
      });
    }
    this.slotEls.forEach((c, i) => {
      const sw = ws.slots[i]; if (!sw) return;
      setCls(c.el, 'on', i === ws.index);
      setT(c.nm, sw.name);
      const col = EL_COL[sw.element] ?? '#fff';
      if (c.el._col !== col) {
        c.el._col = col; c.el.style.setProperty('--el', col);
        c.ic.innerHTML = svg(16, ELEM_ICON[sw.element] ?? ELEM_ICON.kinetic); c.ic.style.color = col;
      }
    });
  }

  /** Minimap, 10 Hz: one drawImage out of the cached sheet + a handful of markers. North-up (the arrow
   *  turns, not the world — cheaper AND easier to read at a glance than a rotating map). */
  _minimap(t) {
    const g = this.game, ctx = g.rpg?.ctx, p = g.player.position;
    if (!ctx || !this.mmCv) return;
    const yaw = g.player.yaw ?? 0;
    if (t - this._mmT < 0.1 && Math.abs(p.x - this._mmX) < 0.6 && Math.abs(p.z - this._mmZ) < 0.6 && Math.abs(yaw - this._mmYaw) < 0.02) return;
    this._mmT = t; this._mmX = p.x; this._mmZ = p.z; this._mmYaw = yaw;
    const cv = this.mmCv, W = cv.width, R = W / 2, c = this._mmCtx ??= cv.getContext('2d');
    const SPAN = MM_SPAN, k = W / SPAN;                       // px per metre
    const toX = (x) => (x - p.x) * k + R, toY = (z) => (z - p.z) * k + R;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, W);
    c.save(); c.beginPath(); c.arc(R, R, R, 0, 6.2832); c.clip();
    const sheet = MAP.sheet();
    if (sheet) {
      const size = ctx.world.size ?? 1024, PN = MAP.sheetRes;
      const sw = SPAN / size * PN;
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
      c.drawImage(sheet, (p.x - SPAN / 2 + size / 2) / size * PN, (p.z - SPAN / 2 + size / 2) / size * PN, sw, sw, 0, 0, W, W);
    } else { c.fillStyle = '#cdbb93'; c.fillRect(0, 0, W, W); }
    // landmarks in range
    for (const l of ctx.world.landmarks ?? []) {
      const x = toX(l.position.x), y = toY(l.position.z);
      if (x < 6 || x > W - 6 || y < 6 || y > W - 6) continue;
      c.fillStyle = 'rgba(20,14,6,0.85)'; c.beginPath(); c.arc(x, y, 3.4, 0, 6.2832); c.fill();
      c.fillStyle = '#e9c46a'; c.beginPath(); c.arc(x, y, 2.1, 0, 6.2832); c.fill();
    }
    // quest-giver pips — ! (new) / ? (turn-in) / grey ? (in progress). Data owned by rpg
    // (QuestMarkers.pips(), a cached array rebuilt at its own poll rate — this is a pure read).
    for (const m of g.rpg?.markers?.pips?.() ?? []) {
      const x = toX(m.x), y = toY(m.z);
      if (x < 6 || x > W - 6 || y < 6 || y > W - 6) continue;
      c.font = '900 11px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.lineWidth = 3; c.strokeStyle = 'rgba(20,14,6,0.9)';
      c.fillStyle = m.state === 'progress' ? '#9aa0a8' : '#ffd24a';
      const ch = m.state === 'offer' ? '!' : '?';
      c.strokeText(ch, x, y); c.fillText(ch, x, y);
    }
    // enemies you can already see on the tracker: red pips, cheap (list is short).
    // A NAMED RARE is the one enemy on this disc that is a destination, so it gets the treatment the
    // genre gives a wandering elite: bigger, gold, ringed, and clamped to the rim with a chevron when
    // it is off the disc — the whole point is that you can decide to go hunt it.
    for (const e of g.combat?.list ?? []) {
      if (!e.alive || e.team !== 'enemy') continue;
      if (isRare(e)) {
        const dx = e.position.x - p.x, dz = e.position.z - p.z, d = Math.hypot(dx, dz) || 1;
        const inside = d * k < R - 8;
        const x = inside ? toX(e.position.x) : R + dx / d * (R - 8), y = inside ? toY(e.position.z) : R + dz / d * (R - 8);
        c.save(); c.translate(x, y);
        c.beginPath(); c.moveTo(0, -5.6); c.lineTo(5.6, 0); c.lineTo(0, 5.6); c.lineTo(-5.6, 0); c.closePath();
        c.fillStyle = '#e9c46a'; c.strokeStyle = 'rgba(24,12,4,0.92)'; c.lineWidth = 1.5; c.fill(); c.stroke();
        c.beginPath(); c.moveTo(0, -2.4); c.lineTo(2.4, 0); c.lineTo(0, 2.4); c.lineTo(-2.4, 0); c.closePath();
        c.fillStyle = '#8e2b16'; c.fill();
        c.restore();
        continue;
      }
      const x = toX(e.position.x), y = toY(e.position.z);
      if (x < 4 || x > W - 4 || y < 4 || y > W - 4) continue;
      c.fillStyle = '#d8402a'; c.beginPath(); c.arc(x, y, 2.4, 0, 6.2832); c.fill();
    }
    // quest waypoint: on the map if it fits, clamped to the rim as a chevron if it does not
    const wp = MAP.waypoint;
    if (wp) {
      const dx = wp.x - p.x, dz = wp.z - p.z, d = Math.hypot(dx, dz);
      const inside = d * k < R - 10;
      const x = inside ? toX(wp.x) : R + dx / d * (R - 9), y = inside ? toY(wp.z) : R + dz / d * (R - 9);
      c.save(); c.translate(x, y);
      c.fillStyle = '#b98fd6'; c.strokeStyle = 'rgba(20,14,6,0.9)'; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(0, -6); c.lineTo(4.6, 0); c.lineTo(0, 6); c.lineTo(-4.6, 0); c.closePath();
      c.fill(); c.stroke(); c.restore();
      setT(this.mmWpd, Math.round(d) + ' m');
    } else setT(this.mmWpd, '');
    // player arrow (yaw 0 = north = up)
    c.save(); c.translate(R, R); c.rotate(-yaw);
    c.fillStyle = '#8fd8ff'; c.strokeStyle = 'rgba(10,14,26,0.95)'; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(0, -7.5); c.lineTo(5.2, 6); c.lineTo(0, 3); c.lineTo(-5.2, 6); c.closePath();
    c.fill(); c.stroke(); c.restore();
    c.restore();
    // zone label + border crossing (1 Hz). Outside the home bowl the label is the REGION you are standing
    // in — crossing the seam between two regions renames the map and throws the name card, which is the
    // whole point of a border. Inside the bowl the regions are one, so the nearest landmark is the useful
    // label instead. Same `regionAt` the music and the ambient bed use, so all three land on one step.
    if (t - this._mmZoneT > 1) {
      this._mmZoneT = t;
      const rid = regionAt(p.x, p.z), B = BIOMES[rid];
      if (rid !== 'meadow') setT(this.mmZone, B?.short ?? '');
      else {
        let best = null, bd = 1e9;
        for (const l of ctx.world.landmarks ?? []) { const d = (l.position.x - p.x) ** 2 + (l.position.z - p.z) ** 2; if (d < bd) { bd = d; best = l; } }
        setT(this.mmZone, best ? best.name : '');
      }
      if (this._region === undefined) this._region = rid;                      // first poll: you did not cross into where you spawned
      else if (rid !== this._region) {
        this._region = rid;
        const lv = B?.level;
        this.notify(B?.name ?? '', lv ? `levels ${lv[0]}–${lv[1]}` : '', B?.passive ?? '');
      }
    }
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
    this.root.append(start);
    const lock = () => g.input.constructor.lock(g.canvas); // user decree: pointer lock must never silently fail — Input.lock handles unadjustedMovement rejection + Chrome relock cooldown (gate-tested)
    start.addEventListener('click', lock);
    // ESC menu: the beUI-vocabulary settings panel (segmented tabs / spring switches / tick sliders),
    // src/ui/settings.js. It owns persistence and writes straight through to the live systems; the ONE
    // pointer-lock path is passed in rather than re-derived, so there is still exactly one caller.
    const st = this.settings = new Settings(g, this, lock);
    st.build(this.root);
    st.apply();
    document.addEventListener('pointerlockchange', () => {
      const locked = !!document.pointerLockElement;
      if (locked) { this._started = true; g.paused = false; start.classList.add('hidden'); st.hide(); g.rpg?.screens?.close?.(false); }
      else if (this._started) {
        g.paused = true;
        // an RPG screen (map/character/inventory) owns this unlock — it pauses without the pause menu
        if (!g.rpg?.screens?.open) st.show();
      } else start.classList.remove('hidden');
    });
    // before the first capture the world runs unpaused behind the hint — a living title screen
    start.classList.remove('hidden');
  }

  // ---------- per-frame ----------
  update(dt, t) {
    const g = this.game, p = g.player, w = p.weapons?.current;
    if (g.input.justPressed('F3')) this.setPerfVisible(!this._perfOn);

    // vitals (health-only; shield removed — WoW-style regen lives in Player.update)
    const hp = p.health / p.maxHealth;
    setX(this.hFill, hp);
    this.hGhost._g = Math.max(hp, (this.hGhost._g ?? hp) - dt * 0.55); setX(this.hGhost, this.hGhost._g);
    setCls(this.hbar, 'low', hp < 0.33);
    setCls(this.hbar, 'regen', p.health > this._prevHp + dt * 0.5 && p.health < p.maxHealth);
    this._prevHp = p.health;
    setT(this.hpNum, Math.ceil(p.health) + ' / ' + Math.round(p.maxHealth));
    setT(this.lvlEl, String(p.level ?? 1));
    // breath: only on screen when it is draining or refilling, so the Vale never shows a bar it does not need
    const br = p.maxBreath ? p.breath / p.maxBreath : 1;
    setCls(this.bbar, 'hidden', br > 0.999);
    if (br <= 0.999) { setX(this.bFill, br); setCls(this.bbar, 'low', br < 0.3); }
    // low-health vignette
    const lo = p.alive ? clamp01((0.42 - hp) / 0.42) * 0.9 : 0;
    if (Math.abs((this.lowhp._o ?? -1) - lo) > 0.02) { this.lowhp._o = lo; this.lowhp.style.opacity = lo; }
    setCls(this.lowhp, 'pulse', lo > 0.25);

    // weapon / ammo
    if (w) {
      if (this._wSeen !== w) { this._wSeen = w; this._refreshWeapon(w); }
      setT(this.mag, String(w.ammo)); setT(this.res, String(w.reserve));
      for (let i = 0; i < this.slotEls.length; i++) {
        const sw = p.weapons.slots[i]; if (!sw) continue;
        setT(this.slotEls[i].am, sw.ammo + ' / ' + sw.reserve);
      }
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

    this._minimap(t);

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

    // escort guide: world-projected nameplate + health bar (not fixed top-of-screen like #tgt/#boss — the
    // player is usually walking beside it, could be looking anywhere). Reads Enemies.js's live Enemy instance
    // directly every frame; hides itself the instant it's off-screen (same behind-camera test as damage numbers)
    // and as a safety net if .alive ever goes false without despawnFriendly having run.
    if (this._guide) {
      const gd = this._guide;
      if (!gd.alive) this.hideGuide();
      else {
        const v = this._v.copy(gd.center).project(cam);
        const vis = v.z > -1 && v.z < 1;
        if (vis !== this._guideVis) { this._guideVis = vis; this.guideEl.style.opacity = vis ? 1 : 0; }
        if (vis) {
          const x = (v.x * 0.5 + 0.5) * W, y = (0.5 - v.y * 0.5) * H - 44;
          this.guideEl.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%)`;
          setX(this.guideFill, gd.maxHealth ? gd.health / gd.maxHealth : 1);
        }
      }
    }

    // loot markers (see marker()'s doc-comment): N independent world-projected plates, same
    // technique as the guide frame above, just keyed by a Map instead of one `this._guide`. Text
    // content never changes here — only the transform/opacity a moving drop needs every frame.
    if (this._markers.size) {
      // COLLISION-AWARE STACKING. loot.js's own PLATE_FROM comment says rare-and-below get no plate
      // because "five plates in one clearing overlap into mush" — but a plate is three lines tall now
      // (name + verdict + stat), so the mush starts at TWO: measured with a legendary and an exotic 3 m
      // apart, the left plate's third line vanished behind the right one. A boss drop or a cleared camp
      // routinely puts four on the floor together.
      // Rule: the NEAREST plate stays full; the rest compact to name + verdict (the verdict must survive
      // compaction — scanning a floor full of loot is the entire point of the feature), and anything
      // still overlapping is pushed up so they read as a list rather than a pile.
      const shown = this._mkScratch ??= [];
      shown.length = 0;
      for (const rec of this._markers.values()) {
        const v = this._v.copy(rec.pos);
        if (rec.yOff) v.y += rec.yOff;          // over-the-head anchor for quest glyphs (see marker())
        v.project(cam);
        const vis = v.z > -1 && v.z < 1;
        rec.vis = vis;
        rec._d = rec.pos.distanceToSquared(cam.position);
        // nearFade: a continuous opacity ramp (e.g. the quest-giver icon fading out before the [E]
        // prompt takes over) rather than the old binary on/off-screen toggle. Threshold-gated like every
        // other setter here — a fading marker still shouldn't touch the DOM every single frame.
        const op = !vis ? 0 : rec.nearFade ? clamp01((Math.sqrt(rec._d) - rec.nearFade[0]) / (rec.nearFade[1] - rec.nearFade[0])) : 1;
        if (Math.abs(rec._op - op) > 0.02) { rec._op = op; rec.el.style.opacity = op; }
        if (!vis) continue;
        rec._x = (v.x * 0.5 + 0.5) * W;
        rec._y = (0.5 - v.y * 0.5) * H - 40;
        shown.push(rec);
      }
      if (shown.length > 1) shown.sort((a, b) => a._d - b._d);
      for (let i = 0; i < shown.length; i++) {
        const rec = shown[i];
        const compact = i > 0;                       // only the nearest keeps its detail line
        if (compact !== rec._compact) { rec._compact = compact; if (rec.detailEl) rec.detailEl.style.display = compact ? 'none' : ''; }
        // push later plates up until they clear the ones already placed (screen space, cheap: N is <= 12)
        for (let j = 0; j < i; j++) {
          const o = shown[j];
          if (Math.abs(rec._x - o._x) < MK_W && Math.abs(rec._y - o._y) < MK_H) rec._y = o._y - MK_H;
        }
        rec.el.style.transform = `translate3d(${rec._x.toFixed(1)}px,${rec._y.toFixed(1)}px,0) translate(-50%,-100%)`;
      }
    }

    // boss bar (computed before the target nameplate below, which suppresses itself for whatever the boss
    // bar is already showing — two plates reading the same name is a bug, not emphasis)
    if (this._bossFn) {
      const r = this._bossFn(); const hpv = typeof r === 'number' ? r : r?.hp ?? 0;
      setX(this.bossFill, hpv); setX(this.bossSh, typeof r === 'object' ? r?.shield ?? 0 : 0);
    } else if (this._boss) {
      const b = this._boss;
      // engaged, not merely nearby: an idle Warden 40 m away kept the bar pinned for whole
      // sessions (feel audit). chase/attack/stagger/flee raise it; leashing back to idle/patrol
      // or death drops it. The distance check stays as the leash-of-last-resort.
      const near = b.alive && b.state !== 'idle' && b.state !== 'patrol'
        && b.position.distanceToSquared(p.position) < 90 * 90;
      if (near !== this._bossShown) { this._bossShown = near; this.bossEl.style.opacity = near ? 1 : 0; if (near) this.bossName.textContent = b.name; }
      if (near) { setX(this.bossFill, b.health / b.maxHealth); setX(this.bossSh, b.maxShield ? b.shield / b.maxShield : 0); }
    }
    const bossActive = !!(this._bossFn || (this._boss && this._bossShown));

    // target nameplate (20 Hz search, per-frame bars)
    this._slow += dt;
    if (this._slow >= 0.05) {
      this._slow = 0;
      // the home-camp boss spawns during Enemies.init — BEFORE _bindEvents ran — so the
      // enemy:spawn listener alone never sees it. Lazy 20 Hz re-find catches it (and any
      // boss recycled back in by camp streaming) without a per-frame scan.
      if (!this._boss || !this._boss.alive) {
        const all = this.game.enemies?.all;
        if (all) for (let i = 0; i < all.length; i++) if (all[i].alive && all[i].def?.boss) { this._boss = all[i]; break; }
      }
      const tg = this._findTarget();
      if (tg) { this._tgt = tg; this._tgtUntil = t + 0.6; }
    }
    // suppressed for whatever currently has the boss frame raised — "Warden of the Spire" over the boss bar
    // AND "Warden of the Spire Lv 6" floating under it is the same name twice; one plate per target, always.
    const showTgt = this._tgt && t < this._tgtUntil && this._tgt.alive && p.alive
      && !(bossActive && this._tgt.name === this.bossName.textContent);
    if (showTgt !== this._tgtVis) { this._tgtVis = showTgt; this.tgtEl.style.opacity = showTgt ? 1 : 0; }
    if (showTgt) {
      const tg = this._tgt;
      setCls(this.tgtEl, 'rare', isRare(tg));   // gold frame + "◆ Rare" tag; see #tgt.rare in ui.css
      setT(this.tgtName, tg.name ?? 'Enemy'); setT(this.tgtLvl, 'Lv ' + (tg.level ?? 1));
      const thp = tg.maxHealth ? tg.health / tg.maxHealth : 1;
      setX(this.tgtFill, thp); setX(this.tgtSh, tg.maxShield ? tg.shield / tg.maxShield : 0);
      this.tgtGhost._g = Math.max(thp, (this.tgtGhost._g ?? thp) - dt * 0.7); setX(this.tgtGhost, this.tgtGhost._g);
    } else this.tgtGhost._g = undefined;

    // interaction prompt (external wins; else aetheryte proximity)
    this._acc += dt;
    if (this._acc >= 0.25) {
      this._acc = 0;
      const ae = g.terrain?.POI?.aetheryte;
      this._proxPrompt = (ae && p.position.distanceToSquared(ae) < 144) ? 'Attune to the Aetheryte' : null;
      const txt = this._extPrompt ?? this._proxPrompt;
      if (txt !== this._promptShown) { this._promptShown = txt; this.promptEl.style.opacity = txt ? 1 : 0; if (txt) setT(this.promptTxt, txt); }
      // wallet balance (4 Hz sync — covers the save-loaded value from before the event wiring; the
      // rpg:currency listener handles the instant tick on change)
      if (this.glimNum) setT(this.glimNum, String((g.rpg?.ctx?.rpg?.currencies?.glimmer ?? 0) | 0));
      // second action row — only the caller that owns _extPrompt (never the aetheryte fallback) may set it
      const o = this._extPrompt ? this._extPrompt2 : null;
      const k2 = o?.key2 || '';
      if (k2 !== this._k2Shown) {
        this._k2Shown = k2;
        if (this.promptEl2) this.promptEl2.style.display = k2 ? '' : 'none';
        if (k2) setT(this.promptKey2, k2);
      }
      if (k2) setT(this.promptTxt2, o.text2 || '');
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
