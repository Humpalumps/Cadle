// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Cadle via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: UI agent. Character sheet, inventory and skill tree bodies.
// Pure render + one action dispatcher; screens.js owns the shell, focus and keys.
// Everything here reads the live ctx.rpg surface and calls its real functions.
import { C, clamp } from './theme.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n0 = (v) => Math.round(+v || 0);
const pct = (v) => Math.round((+v || 0) * 100);

// rarity hue, pulled a little toward ink so it sits in the manuscript palette
function rarCss(color) {
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  const m = (v, ink) => Math.round(v * 0.78 + ink * 0.22);
  return `rgb(${m(r, 36)},${m(g, 28)},${m(b, 18)})`;
}
const rarOf = (ctx, k) => (ctx.rpg.data && ctx.rpg.data.RARITY && ctx.rpg.data.RARITY[k]) || { label: 'Common', color: 0xb8c0c8 };
const elOf = (ctx, k) => (ctx.rpg.data && ctx.rpg.data.ELEMENTS && ctx.rpg.data.ELEMENTS[k]) || null;

// ---------------------------------------------------------------- small parts
function meter(v, max, cmp) {
  const w = clamp(v / (max || 1), 0, 1) * 100;
  const tick = cmp != null ? `<u style="left:${clamp(cmp / (max || 1), 0, 1) * 100}%"></u>` : '';
  return `<div class="meter"><i style="width:${w.toFixed(1)}%"></i>${tick}</div>`;
}

function delta(a, b, unit = '') {
  if (b == null || a == null) return '';
  const d = +(a - b).toFixed(2);
  if (Math.abs(d) < 0.005) return `<span class="d">—</span>`;
  const up = d > 0;
  return `<span class="d ${up ? 'up' : 'dn'}">${up ? '▲' : '▼'}${Math.abs(d) % 1 ? Math.abs(d).toFixed(1) : Math.abs(d)}${unit}</span>`;
}

// one stat line: label, value, optional delta, optional bar, optional plain-words note
function stat(k, v, o = {}) {
  return `<div class="stat"><span class="k">${esc(k)}${o.pips != null ? pips(o.pips) : ''}</span>` +
    `<span class="v">${esc(v)}</span>${o.delta || '<span class="d"></span>'}` +
    (o.max ? meter(o.bar != null ? o.bar : parseFloat(v), o.max, o.cmp) : '') +
    (o.note ? `<span class="n">${esc(o.note)}</span>` : '') + `</div>`;
}

function pips(t) {
  let s = '<span class="pips" aria-hidden="true">';
  for (let i = 0; i < 10; i++) s += `<b class="${i < t ? 'on' : ''}"></b>`;
  return s + '</span>';
}

function perkList(item, title = 'Perks') {
  const ps = (item && item.perks) || [];
  if (!ps.length) return `<h3>${title}</h3><div class="empty">no perks rolled on this one</div>`;
  return `<h3>${title}</h3>` + ps.map(p => `
    <div class="perk ${p.slot === 'exotic' ? 'exo' : ''}">
      <span class="g" aria-hidden="true">${p.slot === 'exotic' ? gem() : lozenge()}</span>
      <span><span class="t">${esc(p.name)}</span>
      ${p.slot ? `<span class="s"> ${esc(p.slot)}</span>` : ''}
      <div class="dsc">${esc(p.desc || '')}</div></span>
    </div>`).join('');
}

// ---------------------------------------------------------------- item icons
// Every AAA loot screen puts a picture on the item; a wall of names is a spreadsheet, not a bag.
// These are inline SVG on a 24 box, currentColor so the rarity tint drives them, and drawn as
// silhouettes so they still read at the 34 px they render in a grid tile.
const ITEM_ICON = {
  // Guns are drawn as one silhouette on a shared skeleton — receiver on the middle band, grip down and
  // right — so a bag of twelve reads as twelve guns at 52 px, and each keeps one feature that names it:
  // the cylinder, the magazine, the pump, the scope, the coil, the emitter.
  handcannon: '<path d="M5.4 8.2h10.2v4.4H5.4Z"/><path d="M15.6 9.3h6.1v2.4h-6.1Z"/><circle cx="8.6" cy="10.4" r="3.4"/><circle cx="8.6" cy="10.4" r="1.2" fill="#0b0a16"/><path d="M11.4 12.6h3.6l-2.1 7.2H8.6Z"/><path d="M5.4 12.6h4.2v1.5H5.4Z" opacity=".6"/>',
  autorifle: '<path d="M1.2 8.6h15.4v4.1H1.2Z"/><path d="M16.6 9.5h6.2v2.3h-6.2Z"/><path d="M8.2 12.7h3.5l-1 5.8H6.9Z"/><path d="M12.6 12.7h3.4l-2 7.1h-3.3Z"/><path d="M1.2 12.7h3v3.1h-3Z" opacity=".65"/>',
  pulse: '<path d="M1.6 8.8h14.6v4H1.6Z"/><path d="M16.2 9.6h6.2v2.3h-6.2Z"/><path d="M8.4 12.9h3.4l-.9 5.4H7.2Z"/><path d="M12.4 12.9h3.4l-2 7h-3.3Z"/><circle cx="18" cy="6.4" r="1.1"/><circle cx="20.2" cy="6.4" r="1.1"/><circle cx="22.4" cy="6.4" r="1.1"/>',
  scout: '<path d="M1.6 9h13.6v3.8H1.6Z"/><path d="M15.2 9.8h7.4v2.2h-7.4Z"/><path d="M11.6 12.9h3.3l-2 6.9h-3.2Z"/><path d="M7.6 12.9h3.2l-.9 4.6H6.6Z"/><rect x="6.2" y="5.4" width="7.4" height="2.6" rx="1.2"/><path d="M8.4 8h1.4v1.2H8.4Z" opacity=".55"/>',
  shotgun: '<path d="M1.2 8h18.2v2.6H1.2Z"/><path d="M1.2 10.9h13.4v2.1H1.2Z" opacity=".62"/><path d="M6.4 13.2h4.4l-.7 3.4H5.7Z" opacity=".85"/><path d="M11.6 13h3.4l-2 6.8H9.6Z"/><path d="M19.4 8h3.2v2.6h-3.2Z" opacity=".7"/>',
  sniper: '<path d="M0.8 10.2h20.9v2.3H0.8Z"/><rect x="7.4" y="5.4" width="9.4" height="3.2" rx="1.3"/><path d="M9.4 8.6h1.3v1.6H9.4ZM14.2 8.6h1.3v1.6h-1.3Z" opacity=".6"/><path d="M11.4 12.7h3.3l-2 7.1H9.4Z"/><path d="M0.8 12.5h4.6v3.3H0.8Z" opacity=".62"/>',
  fusion: '<path d="M2.4 7.8h10.4v7.4H2.4Z"/><path d="M13.6 8.6h2.2v5.8h-2.2ZM16.6 8.6h2.2v5.8h-2.2ZM19.6 8.6h2.2v5.8h-2.2Z" opacity=".8"/><path d="M6.4 15.4h3.4l-1.9 4.6H4.6Z"/><path d="M12.8 10.4h9.6v1.4h-9.6Z" opacity=".45"/>',
  beam: '<path d="M2.2 8.4h10.2v6.4H2.2Z"/><path d="M12.6 9.6h2.8v4h-2.8Z" opacity=".85"/><path d="M15.6 8.4 22.8 11.6 15.6 14.8Z"/><path d="M6.2 15h3.4l-1.8 4.8H4.4Z"/>',
  head: '<path d="M12 2c4.6 0 7.4 2.9 7.4 7.2v4.2c0 3.6-2.4 6-4.6 6.6l-.6 3H9.8l-.6-3c-2.2-.6-4.6-3-4.6-6.6V9.2C4.6 4.9 7.4 2 12 2Z"/><path d="M7.6 9.6h8.8v3.2H7.6Z" fill="#0b0a16"/>',
  arms: '<path d="M8.6 2.6h11.2l1.4 5-2.2 1.6.9 3.4-2 1.2.7 3-1.9 1.1.5 3.4-4.6 1.8-4.6-1.8.5-3.4-1.9-1.1.7-3-2-1.2.9-3.4-2.2-1.6Z"/>',
  chest: '<path d="M8.4 2.4 12 4.6l3.6-2.2 5.4 2.6-1.4 5.4 1 1.6-1.8 9.6H5.2L3.4 12l1-1.6L3 5Z"/><path d="M12 6.6 13.8 21h-3.6Z" fill="#0b0a16" opacity=".55"/>',
  legs: '<path d="M4.8 2.4h14.4l-.8 5.4-1.4 14h-4l-.9-9.2h-.2L11 21.8H7l-1.4-14Z"/>',
  cloak: '<path d="M12 2.2 16.6 5l4.6 3.4-2.6 2 2 10.4h-6.2l-.8-9h-1.2l-.8 9H3.4l2-10.4-2.6-2L7.4 5Z"/>',
};
const SLOT_LABEL = { weapon: 'Armament', head: 'Helm', arms: 'Gauntlets', chest: 'Cuirass', legs: 'Greaves', cloak: 'Mantle' };

// Painted item art (ASSETS.md → public/assets/ui/items/, 256 px RGBA cut-outs, one per archetype and
// armour slot). The SVG silhouettes above stay as the fallback: if a file is missing the screens still
// render, exactly like every other generated asset in this project.
const ART = new Set(['handcannon', 'autorifle', 'pulse', 'scout', 'shotgun', 'sniper', 'fusion', 'beam',
  'head', 'arms', 'chest', 'legs', 'cloak']);
export const ART_URLS = [...ART].map((k) => `/assets/ui/items/${k}.png`);
const artKey = (it) => (!it ? '' : it.kind === 'weapon' ? it.archetype : it.slot);
const isvg = (inner) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${inner}</svg>`;

/** The picture for an item: painted art when we have it, the drawn silhouette when we do not. */
function art(it, alt = '') {
  const k = artKey(it);
  if (ART.has(k)) return `<img src="/assets/ui/items/${k}.png" alt="${esc(alt)}" draggable="false" loading="lazy">`;
  return isvg(ITEM_ICON[k] || ITEM_ICON.chest);
}
/** Same, for an empty equipment slot: always the silhouette, and always dimmed by CSS. */
const slotGhost = (slot) => isvg(ITEM_ICON[slot] || ITEM_ICON.chest);

const lozenge = () => `<svg width="9" height="9" viewBox="0 0 9 9"><path d="M4.5 0 9 4.5 4.5 9 0 4.5Z" fill="${C.gold}" stroke="rgba(50,36,14,.6)"/></svg>`;
const gem = () => `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 0 10 3.4 8 10H2L0 3.4Z" fill="${C.goldLt}" stroke="${C.goldDk}"/></svg>`;

// ---------------------------------------------------------------- currencies
const CUR = [
  ['glimmer', 'Glimmer', `<svg width="11" height="11" viewBox="0 0 11 11"><path d="M5.5 0 11 5.5 5.5 11 0 5.5Z" fill="${C.gold}" stroke="${C.goldDk}"/></svg>`],
  ['emberdust', 'Emberdust', `<svg width="11" height="11" viewBox="0 0 11 11"><path d="M5.5 0C7 3 9 4 9 6.7A3.5 3.5 0 0 1 2 6.7C2 4 4 3 5.5 0Z" fill="${C.ember}" stroke="rgba(70,30,10,.6)"/></svg>`],
  ['relicShard', 'Relic Shard', `<svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 0h7l-2 6 1 5-6-4Z" fill="${C.spirit}" stroke="${C.spiritDk}"/></svg>`],
];

export function currencyStrip(ctx, withConsumables) {
  const cur = ctx.rpg.currencies || {};
  let h = '<div class="curr" role="status" aria-label="Purse">';
  h += CUR.map(([k, label, ico]) =>
    `<span class="c">${ico}<u>${label}</u> ${n0(cur[k])}</span>`).join('<span class="sep"></span>');
  if (withConsumables) {
    const cs = ctx.rpg.consumables || {};
    const defs = (ctx.rpg.data && ctx.rpg.data.CONSUMABLES) || {};
    const any = Object.keys(cs).filter(k => cs[k] > 0);
    h += '<span class="sep"></span>';
    h += any.length
      ? any.map(k => `<button class="btn" data-act="use" data-id="${k}" data-nav="cons"
          title="${esc((defs[k] && defs[k].desc) || '')}">${esc((defs[k] && defs[k].name) || k)} ×${cs[k]}</button>`).join(' ')
      : '<span class="c"><u>no draughts</u></span>';
  }
  return h + '</div>';
}

// ---------------------------------------------------------------- character
// The sheet must show the player's *equipped loot*, not combat's live gun.
export function equippedWeapon(ctx) {
  const eq = (ctx.rpg && ctx.rpg.equipped && ctx.rpg.equipped.weapon) || null;
  if (eq) return { it: eq, s: eq.stats || {}, src: 'loot' };
  const roll = ctx.weapon && ctx.weapon.roll;
  if (roll) return { it: roll, s: roll, src: 'roll' };
  const w = ctx.weapon || {};
  return { it: { name: w.name || 'Bare hands', rarity: 'common', archetypeLabel: w.archetype || w.kind, element: 'kinetic', perks: [] }, s: w, src: 'combat' };
}

function dollSlot(ctx, slot, it) {
  const r = it ? rarOf(ctx, it.rarity) : null;
  return `<button class="dslot ${it ? '' : 'empty'}" ${r ? `style="--r:${rarCss(r.color)}"` : ''}
    data-act="slotjump" data-id="${slot}" data-nav="doll"
    title="${esc(it ? it.name : 'nothing in this slot — opens the bag showing what fits')}">
    <span class="ic">${it ? art(it, it.name) : slotGhost(slot)}</span>
    <span class="sl">${SLOT_LABEL[slot] || slot}</span>
    <span class="nm">${it ? esc(it.name) : 'empty'}</span>
    <span class="pw">${it ? n0(it.power) : ''}</span></button>`;
}

export function renderChar(ctx, body) {
  const { it, s } = equippedWeapon(ctx);
  const st = ctx.rpg.stats || {};
  const p = ctx.player;
  const r = rarOf(ctx, it.rarity);
  const el = elOf(ctx, it.element);
  const dps = s.damage && s.rpm ? Math.round(s.damage * s.rpm / 60) : null;
  const eq = ctx.rpg.equipped || {};

  const meta = [it.archetypeLabel || it.archetype, el && el.label, it.power ? 'Power ' + it.power : null,
    it.upgrades ? '+' + it.upgrades : null].filter(Boolean).join(' · ');

  // The loadout, as pictures, in slot order — what every AAA sheet leads with. A two-column table
  // of names is a spreadsheet. An empty slot is a button: it opens the bag filtered to that slot.
  const doll = `
    <div class="card doll">
      <h3>Loadout</h3>
      <div class="dgrid">
        ${dollSlot(ctx, 'weapon', eq.weapon || (it && it.id ? it : null))}
        ${['head', 'arms', 'chest', 'legs', 'cloak'].map(sl => dollSlot(ctx, sl, eq[sl])).join('')}
      </div>
      <div class="btnrow"><button class="btn" data-act="goinv" data-nav="char">Open the bag <kbd>I</kbd></button></div>
    </div>`;

  const wcard = `
    <div class="card">
      <h3>Armament</h3>
      <div class="dhead" style="--r:${rarCss(r.color)}">
        <span class="ic big">${art(it, it.name)}</span>
        <span class="dh">
          <span class="wname">${esc(it.name)}</span>
          <span class="rar"><i></i>${esc(r.label)}</span>
          <span class="wel">${esc(meta)}</span>
        </span>
      </div>
      ${el ? `<div class="stat"><span class="n">${esc(el.note)}</span></div>` : ''}
      <div class="rows">
        ${stat('Impact', n0(s.damage), { max: 140, note: 'damage a single shot lands, before crits' })}
        ${stat('Rounds / min', n0(s.rpm), { max: 700 })}
        ${dps ? stat('Sustained', dps + ' dps', { bar: dps, max: 900, note: 'impact × fire rate — what it actually does per second' }) : ''}
        ${stat('Magazine', n0(s.mag), { max: 60 })}
        ${stat('Range', n0(s.range), { max: 100, note: 'metres before damage starts falling away' })}
        ${stat('Stability', n0(s.stability), { max: 100 })}
        ${stat('Handling', n0(s.handling), { max: 100 })}
        ${stat('Crit', '×' + (+(s.critMul || 2)).toFixed(2), { bar: (s.critMul || 2) - 2, max: 0.6, note: 'headshot multiplier' })}
      </div>
      <div class="rows">${perkList(it)}</div>
    </div>`;

  const xp = ctx.rpg.xp || 0, next = ctx.rpg.next || 100;
  const pts = ctx.rpg.points || 0;
  const rank = `
    <div class="card">
      <h3>Wayfarer</h3>
      <div class="rankhead">
        <b class="lvl"><span>${ctx.rpg.level || 1}</span></b>
        <span class="rk">
          <span class="row"><b>Rank ${ctx.rpg.level || 1}</b><span>${n0(xp)} / ${n0(next)} xp</span></span>
          <span class="xp"><i style="width:${clamp(xp / Math.max(1, next), 0, 1) * 100}%"></i></span>
        </span>
      </div>
      <div class="rows">
        ${stat('Power', n0(st.power), { max: 400, note: 'average power of the six things you are wearing' })}
        ${stat('Vitality', n0(p.maxHealth), { max: 220, note: 'health before the ward is gone' })}
        ${stat('Ward', n0(p.maxShield), { max: 220, note: 'shield that comes back on its own' })}
        ${stat('Damage bonus', (st.damageMul > 1 ? '+' + pct(st.damageMul - 1) + '%' : 'none'), {
          bar: (st.damageMul || 1) - 1, max: 0.6,
          note: st.damageMul > 1 ? 'from armour sets and skills' : 'set bonuses and Ember Rounds raise this',
        })}
        ${stat('Luck', (st.luck ? '+' + pct(st.luck) + '%' : 'none'), {
          bar: st.luck || 0, max: 1.2,
          note: st.luck ? 'better rarity on every drop' : 'Fortune, a full Chorus set or a Wyrm Charm raise this',
        })}
      </div>
      <div class="ptbanner">Points to spend <b>${pts}</b>
        <button class="btn ${pts ? 'gold' : ''}" data-act="goskills" data-nav="char"
          ${pts ? '' : 'aria-disabled="true"'}>${pts ? 'Spend them' : 'Skill tree'} <kbd>K</kbd></button>
      </div>
      ${(st.setBonuses || []).length ? `<div class="rows"><h3>Set bonuses</h3>${(st.setBonuses || [])
        .map(b => `<div class="perk"><span class="g">${lozenge()}</span><span class="t">${esc(b)}</span></div>`).join('')}</div>` : ''}
    </div>`;

  const tiers = st.tiers || {};
  const MEAN = {
    mobility: () => `+${pct((st.moveSpeedMul || 1) - 1)}% move speed, +${pct((st.jumpMul || 1) - 1)}% jump`,
    resilience: () => `${n0(st.maxHealth)} health and ${n0(st.maxShield)} ward`,
    recovery: () => `ward returns after ${st.shieldDelay}s, at ${n0(st.shieldRegen)}/s`,
    discipline: () => `ability cooldowns ×${st.cooldownMul} · Windstep every ${(st.dashCooldown || 5).toFixed(1)}s`,
    strength: () => `melee ×${st.meleeMul}`,
  };
  const standing = `
    <div class="card wide">
      <h3>Standing</h3>
      <div class="rows cols2">
        ${Object.keys(MEAN).map(k => stat(k, n0(st[k]), {
          max: 100, pips: tiers[k] || 0, note: MEAN[k](),
        })).join('')}
      </div>
    </div>`;

  body.innerHTML = currencyStrip(ctx, false) + `<div class="cols">${doll}${rank}${wcard}${standing}</div>`;
}

// ---------------------------------------------------------------- inventory
const inv = { sel: null, filter: 'all', armed: null, sort: 'power' };
const RANK = { common: 0, uncommon: 1, rare: 2, legendary: 3, exotic: 4 };

function allItems(ctx) {
  const eq = ctx.rpg.equipped || {};
  const worn = ['weapon', 'head', 'arms', 'chest', 'legs', 'cloak'].map(k => eq[k]).filter(Boolean);
  const bag = (ctx.rpg.inventory || []).slice();
  return worn.map((i, k) => ({ it: i, worn: true, idx: -1 - k }))
    .concat(bag.map((i, k) => ({ it: i, worn: false, idx: k })));
}

// filter is 'all' | 'weapons' | 'armour' | an armour slot ('head'...): clicking an empty slot on the
// character sheet drops you straight into the bag showing only what can go in it.
function filtered(ctx) {
  const all = allItems(ctx);
  const f = inv.filter;
  const keep = f === 'all' ? all
    : f === 'weapons' ? all.filter(e => e.it.kind === 'weapon')
    : f === 'armour' ? all.filter(e => e.it.kind === 'armour')
    : all.filter(e => e.it.slot === f);
  const by = inv.sort;
  return keep.sort((a, b) => (b.worn - a.worn) || (
    by === 'rarity' ? ((RANK[b.it.rarity] || 0) - (RANK[a.it.rarity] || 0)) || ((b.it.power || 0) - (a.it.power || 0))
      : by === 'new' ? b.idx - a.idx
      : (b.it.power || 0) - (a.it.power || 0)));
}

// power against what you already have on, for the corner badge on a tile
function powerDelta(ctx, e) {
  if (e.worn) return 0;
  const cmp = compareTo(ctx, e.it);
  return cmp ? n0(e.it.power) - n0(cmp.power) : 0;
}

const WSTAT = [['damage', 'Impact', 140], ['rpm', 'Rounds / min', 700], ['mag', 'Magazine', 60],
  ['range', 'Range', 100], ['stability', 'Stability', 100], ['handling', 'Handling', 100]];
const ASTAT = [['mobility', 'Mobility', 40], ['resilience', 'Resilience', 40], ['recovery', 'Recovery', 40],
  ['discipline', 'Discipline', 40], ['strength', 'Strength', 40]];

function compareTo(ctx, it) {
  const eq = ctx.rpg.equipped || {};
  if (it.kind === 'weapon') return eq.weapon && eq.weapon.id !== it.id ? eq.weapon : null;
  return eq[it.slot] && eq[it.slot].id !== it.id ? eq[it.slot] : null;
}

function detail(ctx, entry) {
  if (!entry) return `<div class="detail"><div class="empty">Nothing picked.<br>Arrows move · Enter or E equips · Delete dismantles.</div></div>`;
  const it = entry.it, worn = entry.worn;
  const r = rarOf(ctx, it.rarity);
  const el = elOf(ctx, it.element);
  const cmp = compareTo(ctx, it);
  const cs = cmp && (cmp.stats || {});
  const s = it.stats || {};

  const rows = it.kind === 'weapon'
    ? WSTAT.map(([k, label, max]) => stat(label, n0(s[k]), {
        max, bar: s[k], cmp: cs ? cs[k] : null, delta: delta(n0(s[k]), cs ? n0(cs[k]) : null),
      })).join('') + stat('Crit', '×' + (+(s.critMul || 2)).toFixed(2), {
        bar: (s.critMul || 2) - 2, max: 0.6, delta: delta(+(s.critMul || 2).toFixed(2), cs ? +(cs.critMul || 2).toFixed(2) : null),
      })
    : ASTAT.map(([k, label, max]) => stat(label, n0(s[k]), {
        max, bar: s[k], cmp: cs ? cs[k] : null, delta: delta(n0(s[k]), cs ? n0(cs[k]) : null),
      })).join('');

  const meta = [it.archetypeLabel || SLOT_LABEL[it.slot] || it.slot, el && el.label,
    it.setLabel, it.upgrades ? '+' + it.upgrades : null,
    it.masterwork ? 'Masterwork' : null].filter(Boolean).join(' · ');

  const acts = [];
  if (!worn) acts.push(`<button class="btn gold" data-act="equip" data-id="${it.id}" data-nav="act">Equip <kbd>E</kbd></button>`);
  acts.push(`<button class="btn" data-act="upgrade" data-id="${it.id}" data-nav="act">Upgrade${it.upgrades ? ' (+' + it.upgrades + ')' : ''}</button>`);
  acts.push(`<button class="btn" data-act="infuse" data-id="${it.id}" data-nav="act">Infuse</button>`);
  if (!worn) acts.push(`<button class="btn warn" data-act="dismantle" data-id="${it.id}" data-nav="act">${inv.armed === it.id ? 'Sure? Break it' : 'Dismantle'}</button>`);

  return `<div class="detail" style="--r:${rarCss(r.color)}">
    <div class="dhead">
      <span class="ic big">${art(it, it.name)}</span>
      <span class="dh">
        <span class="wname">${esc(it.name)}</span>
        <span class="rar"><i></i>${esc(r.label)}${worn ? ' · equipped' : ''}</span>
        <span class="wel">${esc(meta)}</span>
      </span>
      <span class="pwbig">${n0(it.power)}<u>power</u></span>
    </div>
    ${it.flavour ? `<div class="stat"><span class="n">${esc(it.flavour)}</span></div>` : ''}
    <div class="rows">
      ${stat('Power', n0(it.power), { max: 400, delta: delta(n0(it.power), cmp ? n0(cmp.power) : null) })}
      ${rows}
    </div>
    ${cmp ? `<div class="cmpn">compared against ${esc(cmp.name)} — what you have on</div>` : ''}
    <div class="rows">${perkList(it)}</div>
    <div class="btnrow">${acts.join('')}</div>
  </div>`;
}

// One bag tile: picture, power, and how it stacks against what is already on you. The name sits
// under the icon so the grid still reads as a list when you are hunting one specific roll.
function tile(ctx, e) {
  const it = e.it, r = rarOf(ctx, it.rarity), d = powerDelta(ctx, e);
  const dl = d ? `<span class="dl ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>` : '';
  return `<button class="tile ${e.worn ? 'worn' : ''} ${it.id === inv.sel ? 'sel' : ''}"
    style="--r:${rarCss(r.color)}" data-act="pick" data-id="${it.id}" data-nav="list"
    data-equip="${e.worn ? '' : it.id}" aria-pressed="${it.id === inv.sel}"
    title="${esc(it.name)} — ${esc(r.label)}">
    <span class="ic">${art(it, it.name)}</span>
    <span class="pw">${n0(it.power)}</span>${dl}
    <span class="nm">${esc(it.name)}</span></button>`;
}

const FILTERS = [['all', 'All'], ['weapons', 'Arms'], ['armour', 'Raiment'],
  ['head', 'Helm'], ['arms', 'Gauntlets'], ['chest', 'Cuirass'], ['legs', 'Greaves'], ['cloak', 'Mantle']];
const SORTS = [['power', 'Power'], ['rarity', 'Rarity'], ['new', 'Newest']];
const seg = (items, cur, act) => `<div class="seg">${items.map(([k, l]) =>
  `<button class="${cur === k ? 'on' : ''}" data-act="${act}" data-id="${k}" data-nav="filter"
    aria-pressed="${cur === k}">${l}</button>`).join('')}</div>`;

export function renderInv(ctx, body) {
  const list = filtered(ctx);
  if (!list.some(e => e.it.id === inv.sel)) inv.sel = list.length ? list[0].it.id : null;
  const entry = list.find(e => e.it.id === inv.sel) || null;
  const held = (ctx.rpg.inventory || []).length;

  // Empty sockets pad the grid out to a full bag. Every loot game does this: a half-empty grid of
  // sockets reads as "room for more", four floating cards read as an unfinished list.
  const SOCKETS = 24;
  const ghosts = Math.max(0, SOCKETS - list.length);
  const grid = `<div class="bag" role="list">${list.map(e => tile(ctx, e)).join('')}` +
    `<span class="tile ghost" aria-hidden="true"></span>`.repeat(ghosts) + '</div>' +
    (list.length ? '' : '<div class="empty">Nothing here yet. The Vale is generous to those who go looking.</div>');

  body.innerHTML = currencyStrip(ctx, true) + `
    <div class="invtop">
      ${seg(FILTERS, inv.filter, 'filter')}
      <span class="spacer"></span>
      ${seg(SORTS, inv.sort, 'sort')}
      <span class="cap">${held} / 120 held</span>
    </div>
    <div class="invcols">
      <div class="bagwrap">${grid}</div>
      ${detail(ctx, entry)}
    </div>`;
}

// ---------------------------------------------------------------- skill tree
const BRANCH = {
  wayfarer: ['Wayfarer', 'how far you can get, and how fast'],
  emberward: ['Emberward', 'staying up, and hitting harder'],
  loreseeker: ['Loreseeker', 'what the land gives back'],
};

function nodeHTML(n, pts) {
  const owned = n.owned;
  const gone = !owned && /^you chose/.test(n.blocked || '');
  const can = !owned && !n.blocked;
  const cls = owned ? 'own' : gone ? 'gone' : can ? 'can' : 'lock';
  const why = owned ? 'learned' : n.blocked || `costs ${n.cost} point${n.cost > 1 ? 's' : ''} — you have ${pts}`;
  return `<div class="node ${cls}">
    <div class="nh"><span class="nn">${esc(n.name)}</span>
      <span class="nc">Rank ${n.lvl} · ${n.cost} pt${n.cost > 1 ? 's' : ''}</span></div>
    <div class="nd">${esc(n.desc)}</div>
    <div class="why">${esc(why)}</div>
    ${can ? `<div class="btnrow"><button class="btn gold" data-act="spend" data-id="${n.id}" data-nav="skill">Spend ${n.cost} point${n.cost > 1 ? 's' : ''}</button></div>` : ''}
  </div>`;
}

export function renderSkills(ctx, body) {
  const tree = ctx.rpg.skillTree ? ctx.rpg.skillTree() : {};
  const pts = ctx.rpg.points || 0;

  const cols = Object.keys(BRANCH).map(b => {
    const nodes = (tree[b] || []).slice().sort((a, z) => a.lvl - z.lvl);
    const used = new Set();
    let h = '';
    for (const n of nodes) {
      if (used.has(n.id)) continue;
      const twin = n.excl ? nodes.find(m => m.id === n.excl) : null;
      if (twin) {
        used.add(n.id); used.add(twin.id);
        h += `<div class="fork">${nodeHTML(n, pts)}${nodeHTML(twin, pts)}</div>`;
      } else {
        used.add(n.id);
        h += nodeHTML(n, pts);
      }
    }
    return `<div class="branch"><h3>${BRANCH[b][0]}</h3><p>${BRANCH[b][1]}</p>${h}</div>`;
  }).join('');

  body.innerHTML = `<div class="ptbanner" role="status">Points to spend <b>${pts}</b>
      <span>·</span> Rank ${ctx.rpg.level || 1}
      ${pts ? '' : '<span>· next point at the next rank</span>'}</div>
    <div class="branches">${cols}</div>`;
}

// ---------------------------------------------------------------- actions
// One dispatcher. Every branch calls a real ctx.rpg function and reports what it said.
export function act(ctx, el, say) {
  const a = el.getAttribute('data-act');
  const id = el.getAttribute('data-id');
  switch (a) {
    case 'pick': inv.sel = id; inv.armed = null; return 'inv';
    case 'filter': inv.filter = id; inv.armed = null; return 'inv';
    case 'sort': inv.sort = id; return 'inv';
    case 'slotjump': inv.filter = id === 'weapon' ? 'weapons' : id; inv.sel = null; inv.armed = null; return 'inv';
    case 'equip': {
      const ok = ctx.rpg.equip(id);
      say(ok ? 'equipped' : 'that would not go on', ok ? 'good' : 'bad');
      return 'inv';
    }
    case 'upgrade': {
      const r = ctx.rpg.upgrade(id) || {};
      say(r.ok ? 'upgraded' : (r.reason || 'cannot upgrade') + (r.cost ? ' — needs ' + costText(r.cost) : ''), r.ok ? 'good' : 'bad');
      return 'inv';
    }
    case 'infuse': {
      const t = findItem(ctx, id);
      const src = (ctx.rpg.inventory || [])
        .filter(x => t && x.kind === t.kind && x.id !== id && (x.power || 0) > (t.power || 0))
        .sort((a2, b2) => (b2.power || 0) - (a2.power || 0))[0];
      if (!src) { say('nothing in the bag is higher power than this', 'bad'); return 'inv'; }
      const r = ctx.rpg.infuse(id, src.id) || {};
      say(r.ok ? 'infused from ' + src.name : (r.reason || 'cannot infuse') + (r.cost ? ' — needs ' + costText(r.cost) : ''), r.ok ? 'good' : 'bad');
      return 'inv';
    }
    case 'dismantle': {
      if (inv.armed !== id) { inv.armed = id; say('press again to break it down for parts', 'bad'); return 'inv'; }
      inv.armed = null;
      const ok = ctx.rpg.dismantle(id);
      say(ok ? 'broken down — materials added' : 'that one cannot be dismantled', ok ? 'good' : 'bad');
      inv.sel = null;
      return 'inv';
    }
    case 'use': {
      const r = ctx.rpg.use(id) || {};
      say(r.ok ? 'used' : (r.reason || 'none left'), r.ok ? 'good' : 'bad');
      return 'inv';
    }
    case 'spend': {
      const named = (ctx.rpg.data && ctx.rpg.data.SKILLS && ctx.rpg.data.SKILLS[id]) || {};
      const r = ctx.rpg.spendPoint(id) || {};
      say(r.ok ? 'learned — ' + (named.name || id) + ' · ' + (ctx.rpg.points || 0) + ' left'
        : (r.reason || 'cannot spend that'), r.ok ? 'good' : 'bad');
      return 'skills';
    }
    default: return null;
  }
}

function costText(c) {
  return Object.keys(c).filter(k => c[k]).map(k => c[k] + ' ' + k).join(', ');
}

function findItem(ctx, id) {
  const eq = ctx.rpg.equipped || {};
  return (ctx.rpg.inventory || []).find(x => x.id === id)
    || Object.keys(eq).map(k => eq[k]).find(x => x && x.id === id);
}

export const invState = inv;
