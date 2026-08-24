// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Cadle via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: UI agent. Character sheet, inventory and skill tree bodies.
// Pure render + one action dispatcher; screens.js owns the shell, focus and keys.
// Everything here reads the live ctx.rpg surface and calls its real functions.
import { C, clamp } from './theme.js';
import { BIOMES } from '../world/Biomes.js';
// Read-only content lookup (same pattern as the BIOMES import above) — src/rpg/quests/* is the quest
// engine builder's data, never edited here. BY_ID carries the full authored text/giver/reward/chain
// links that game.rpg.quest.state() intentionally omits (it only returns live progress, scalars-only
// per its own automation contract). Merging the two gives the log real content with zero API surface
// the quest engine has to add just for us.
import { BY_ID as QUEST_BY_ID } from '../rpg/quests/index.js';

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
// Slot names are read off ctx.rpg.equipped at runtime (the RPG side is growing a SECOND weapon slot
// so the two live guns each get one) — this is only the label lookup, with a title-case fallback so
// an unknown key still prints as a word instead of vanishing.
const SLOT_LABEL = {
  weapon: 'Armament', weaponA: 'Armament I', weaponB: 'Armament II',
  primary: 'Armament I', secondary: 'Armament II', kinetic: 'Armament I', energy: 'Armament II',
  head: 'Helm', arms: 'Gauntlets', chest: 'Cuirass', legs: 'Greaves', cloak: 'Mantle',
};
// progression owns the real captions (ctx.rpg.slotLabels) so the doll and the compare panel say the
// same words; the table above is the fallback for a build where it is not there yet.
const slotLabel = (ctx, s) => (ctx && ctx.rpg && ctx.rpg.slotLabels && ctx.rpg.slotLabels[s])
  || SLOT_LABEL[s] || (s ? String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()) : '');
const isWeaponSlot = (s) => /^(weapon|primary|secondary|kinetic|energy)/i.test(String(s || ''));
// what an EMPTY slot draws: the armour silhouettes are keyed by slot, a weapon slot borrows a gun
const ghostKey = (slot) => (isWeaponSlot(slot) ? 'autorifle' : slot);

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
  if (ART.has(k)) return `<img src="/assets/ui/items/${k}.png" alt="${esc(alt)}" draggable="false">`;
  return isvg(ITEM_ICON[k] || ITEM_ICON.chest);
}
/** Same, for an empty equipment slot: always the silhouette, and always dimmed by CSS. */
const slotGhost = (slot) => isvg(ITEM_ICON[ghostKey(slot)] || ITEM_ICON.chest);

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
  // whichever weapon slot is filled — 'weapon' today, weaponA/weaponB once both guns are modelled
  const wm = (ctx.rpg && ctx.rpg.equipped) || {};
  const eq = weaponSlots(ctx).map((k) => wm[k]).find(Boolean) || null;
  if (eq) return { it: eq, s: eq.stats || {}, src: 'loot' };
  const roll = ctx.weapon && ctx.weapon.roll;
  if (roll) return { it: roll, s: roll, src: 'roll' };
  const w = ctx.weapon || {};
  return { it: { name: w.name || 'Bare hands', rarity: 'common', archetypeLabel: w.archetype || w.kind, element: 'kinetic', perks: [] }, s: w, src: 'combat' };
}

// A slot on the sheet is a BUTTON that swaps what is in it: it opens the bag filtered to this
// slot with the best candidate already picked and compared. The ▲ badge is the sheet answering
// "what should I put on" without the player opening anything at all.
function dollSlot(ctx, slot, it) {
  const r = it ? rarOf(ctx, it.rarity) : null;
  const g = slotGain(ctx, slot);
  return `<button class="dslot ${it ? '' : 'empty'} ${g > 0 ? 'has' : ''}" ${r ? `style="--r:${rarCss(r.color)}"` : ''}
    data-act="slotjump" data-id="${slot}" data-nav="doll"
    title="${esc(g > 0 ? `the bag holds a +${g} for this slot — click to swap`
      : it ? it.name + ' — click for what else fits' : 'nothing in this slot — click for what fits')}">
    <span class="ic">${it ? art(it, it.name) : slotGhost(slot)}</span>
    <span class="sl">${slotLabel(ctx, slot)}</span>
    <span class="nm">${it ? esc(it.name) : 'empty'}</span>
    <span class="pw">${it ? n0(it.power) : ''}${g > 0 ? `<b class="dl up">▲${g}</b>` : ''}</span></button>`;
}

export function renderChar(ctx, body) {
  const { it, s } = equippedWeapon(ctx);
  const st = ctx.rpg.stats || {};
  const p = ctx.player;
  const r = rarOf(ctx, it.rarity);
  const el = elOf(ctx, it.element);
  const dps = s.damage && s.rpm ? Math.round(s.damage * s.rpm / 60) : null;
  const eq = ctx.rpg.equipped || {};
  const ups = upgradeCount(ctx);

  const meta = [it.archetypeLabel || it.archetype, el && el.label, it.power ? 'Power ' + it.power : null,
    it.upgrades ? '+' + it.upgrades : null].filter(Boolean).join(' · ');

  // The loadout, as pictures, in slot order — what every AAA sheet leads with. A two-column table
  // of names is a spreadsheet. An empty slot is a button: it opens the bag filtered to that slot.
  const doll = `
    <div class="card doll">
      <h3>Loadout</h3>
      <div class="btnrow"><button class="btn ${ups ? 'gold' : ''}" data-act="upsjump" data-nav="char"
        title="${esc(ups ? 'opens the bag sorted by what beats your gear' : 'opens the bag')}"
        >${ups ? upsLabel(ups) : 'Open the bag'} <kbd>I</kbd></button></div>
      <div class="dgrid">
        ${eqSlots(ctx).map(sl => dollSlot(ctx, sl,
          eq[sl] || (isWeaponSlot(sl) && !weaponSlots(ctx).some(k => eq[k]) && it && it.id ? it : null))).join('')}
      </div>
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
const inv = { sel: null, hover: null, filter: 'all', armed: null, sort: 'power' };
const RANK = { common: 0, uncommon: 1, rare: 2, legendary: 3, exotic: 4 };

const FALLBACK_SLOTS = ['weaponA', 'weaponB', 'head', 'arms', 'chest', 'legs', 'cloak'];
/**
 * The equipment slots, READ OFF ctx.rpg.equipped rather than hardcoded: the RPG side is growing a
 * second weapon slot (one per live gun) and this screen has to work either way. Order is whatever
 * progression declares; the paper doll places by NAME, not by index, so order never matters to it.
 */
function eqSlots(ctx) {
  const eq = (ctx && ctx.rpg && ctx.rpg.equipped) || null;
  // Object.keys deliberately: `equipped.weapon` is a non-enumerable accessor for the gun in hand,
  // so enumerating gives the SEVEN real slots — both hands, not just the held one.
  const keys = eq ? Object.keys(eq) : [];
  return keys.length ? keys : FALLBACK_SLOTS;
}
const weaponSlots = (ctx) => {
  const ws = ctx && ctx.rpg && ctx.rpg.weaponSlots;
  return Array.isArray(ws) && ws.length ? ws : eqSlots(ctx).filter(isWeaponSlot);
};

/**
 * Every slot `it` could legally go into — one for armour, TWO for a weapon once progression models
 * both guns. This is the single answer used by the equip guard, the drag-and-drop validity test,
 * the click-a-slot path and the loadout comparison, so all four agree by construction.
 */
function slotsFor(ctx, it) {
  if (!it || it.kind === 'quest' || it.equippable === false) return [];
  if (it.kind === 'weapon') return weaponSlots(ctx);          // BOTH hands: either is legal
  return eqSlots(ctx).includes(it.slot) ? [it.slot] : [];
}
/** Exported so Screens.js can light up valid drop targets the instant a drag starts, or the
 *  instant the mouse crosses a tile. Second entry is the one a bare equip would actually take. */
export function dropSlots(ctx, id) {
  const it = (ctx.rpg.inventory || []).find((x) => x.id === id);
  return slotsFor(ctx, it);
}
export function pickSlot(ctx, id) {
  return bestSlotFor(ctx, (ctx.rpg.inventory || []).find((x) => x.id === id));
}

/** Where `it` should go if the player does not say: the slot it gains the most in (an empty slot
 *  wins outright), which is also the gun a new drop should replace — the weaker one. */
function bestSlotFor(ctx, it) {
  const slots = slotsFor(ctx, it);
  if (slots.length < 2) return slots[0] || null;
  // progression.slotFor IS equip()'s own choice — asking it means the highlighted button and the
  // slot a bare `equip()` picks can never disagree. Local sort is the fallback, same rule.
  try { const s = ctx.rpg.slotFor && ctx.rpg.slotFor(it); if (s && slots.includes(s)) return s; } catch (e) {}
  const eq = ctx.rpg.equipped || {};
  return slots.slice().sort((a, b) =>
    (n0(it.power) - n0((eq[b] || {}).power)) - (n0(it.power) - n0((eq[a] || {}).power)))[0];
}

/**
 * Why `it` cannot go on, in plain words — '' when it can. Mirrors progression.equip's own guards
 * (quest token / equippable:false / no such slot) so the button is DISABLED WITH A REASON instead
 * of clicking into a silent no-op. One function, used by the button, the E key and act().
 */
function equipBlock(ctx, it, worn) {
  if (!it) return 'nothing picked';
  if (worn) return 'already on you';
  if (it.kind === 'quest' || it.equippable === false) return 'a quest token — nothing wears it';
  if (!slotsFor(ctx, it).length) return 'nothing on you takes this';
  return '';
}

/** The best thing in the BAG for one slot — the whole "what should I put on" question, answered
 *  once and reused by the paper doll, the tile badges and the Upgrades sort. */
function bestFor(ctx, slot) {
  const wantWeapon = isWeaponSlot(slot);
  let best = null;
  for (const it of ctx.rpg.inventory || []) {
    if (wantWeapon ? it.kind !== 'weapon' : (it.kind !== 'armour' || it.slot !== slot)) continue;
    if (!best || (it.power || 0) > (best.power || 0)) best = it;
  }
  return best;
}
/** Power the bag's best candidate for `slot` would gain you. <= 0 means nothing better is held. */
function slotGain(ctx, slot) {
  const b = bestFor(ctx, slot);
  if (!b) return 0;
  const cur = (ctx.rpg.equipped || {})[slot];
  return n0(b.power) - (cur ? n0(cur.power) : 0);
}
const upgradeCount = (ctx) => eqSlots(ctx).filter(s => slotGain(ctx, s) > 0).length;
const upsLabel = (n) => (n ? `${n} upgrade${n > 1 ? 's' : ''} waiting` : 'nothing better in the bag');

// The bag is what you CARRY. What you are wearing is the loadout strip above it — five "EQUIPPED"
// captions scattered through one grid is how you end up unable to see what you have on.
function allItems(ctx) {
  return (ctx.rpg.inventory || []).map((i, k) => ({ it: i, worn: false, idx: k }));
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
  return keep.sort((a, b) => (
    by === 'rarity' ? ((RANK[b.it.rarity] || 0) - (RANK[a.it.rarity] || 0)) || ((b.it.power || 0) - (a.it.power || 0))
      : by === 'new' ? b.idx - a.idx
      // 'up' is the sort a player actually wants: everything that beats what you are wearing, best first.
      : by === 'up' ? (powerDelta(ctx, b) - powerDelta(ctx, a)) || ((b.it.power || 0) - (a.it.power || 0))
      : (b.it.power || 0) - (a.it.power || 0)));
}

// power against what you already have on, for the corner badge on a tile. An empty slot is worth
// the item's whole power — reporting 0 there ("no change") is the opposite of true.
function powerDelta(ctx, e) {
  const it = e.it;
  if (e.worn || !slotsFor(ctx, it).length) return 0;
  const cmp = compareTo(ctx, it);
  return n0(it.power) - (cmp ? n0(cmp.power) : 0);
}

const WSTAT = [['damage', 'Impact', 140], ['rpm', 'Rounds / min', 700], ['mag', 'Magazine', 60],
  ['range', 'Range', 100], ['stability', 'Stability', 100], ['handling', 'Handling', 100]];
const ASTAT = [['mobility', 'Mobility', 40], ['resilience', 'Resilience', 40], ['recovery', 'Recovery', 40],
  ['discipline', 'Discipline', 40], ['strength', 'Strength', 40]];

// The ONE thing this item would displace if you equipped it without saying where — the piece in the
// slot it gains the most in. With two guns that is the weaker one, which is the gun a player means.
function compareTo(ctx, it) {
  const eq = ctx.rpg.equipped || {};
  const s = bestSlotFor(ctx, it);
  return s && eq[s] && eq[s].id !== it.id ? eq[s] : null;
}

/**
 * The item against EVERYTHING it could replace — one row per candidate slot, so a new sniper is
 * shown against BOTH equipped guns at once instead of whichever one the code picked. That is the
 * decision the player is actually making ("which of my two does this beat?"), and showing half of
 * it is what made the old single-comparison useless.
 *
 * Prefers ctx.rpg.compare (progression owns the verdict maths and returns one entry per valid slot
 * — two for a weapon); falls back to the same arithmetic locally so this screen never depends on
 * it. Shape checked, not assumed, and the older compareAgainstLoadout name is still accepted.
 */
function loadoutCompare(ctx, it) {
  const slots = slotsFor(ctx, it);
  if (!slots.length) return [];
  const eq = ctx.rpg.equipped || {};
  const fn = ctx.rpg.compare || ctx.rpg.compareAgainstLoadout;
  let api = null;
  if (typeof fn === 'function') {
    try {
      const r = fn.call(ctx.rpg, it, eq);
      if (Array.isArray(r) && r.every((e) => e && typeof e.slot === 'string')) api = r;
    } catch (e) { api = null; }
  }
  return slots.map((s) => {
    const from = api && api.find((e) => e.slot === s);
    const cur = eq[s] || null;
    return {
      slot: s,
      label: (from && from.slotLabel) || slotLabel(ctx, s),
      cur,
      d: from && from.powerDelta != null ? n0(from.powerDelta) : n0(it.power) - (cur ? n0(cur.power) : 0),
      lines: (from && Array.isArray(from.lines) && from.lines.length ? from.lines : statMovers(it, cur)).slice(0, 3),
    };
  });
}

// top movers between two rolls, biggest absolute swing first — the same two-line summary
// src/rpg/compare.js prints on a pickup, computed here when the API is not there yet.
function statMovers(it, cur) {
  const table = it.kind === 'weapon' ? WSTAT : ASTAT;
  const s = it.stats || {}, cs = (cur && cur.stats) || {};
  return table.map(([k, label]) => ({ key: k, label, delta: n0(s[k]) - n0(cs[k]) }))
    .filter((l) => l.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/**
 * The comparison, printed where the decision happens. Selecting an item used to show absolute
 * stats only — the deltas the bag tiles carry vanished at exactly the moment you were choosing.
 * This is the headline (what is in that slot now, its power, and the swing); the per-stat deltas
 * and the ghost ticks on the meters below carry the detail.
 */
function cmpBlock(ctx, it, worn) {
  const wornSlot = wornAt(ctx, it);
  if (worn) return `<div class="cmpbar on"><span class="lb"><u>Worn</u>${esc(slotLabel(ctx, wornSlot) || 'equipped')}</span>
    <span class="to">${n0(it.power)}</span></div>`;
  const rows = loadoutCompare(ctx, it);
  if (!rows.length) return '';
  const best = bestSlotFor(ctx, it);
  return `<div class="cmpset">${rows.length > 1
    ? `<div class="cmphd">Against both of your ${it.kind === 'weapon' ? 'guns' : 'pieces'} — pick where it goes</div>` : ''}
    ${rows.map((row) => {
      const d = row.d, dcls = d > 0 ? 'up' : d < 0 ? 'dn' : '';
      const dtxt = d > 0 ? '▲' + d : d < 0 ? '▼' + Math.abs(d) : '—';
      const r = row.cur ? rarOf(ctx, row.cur.rarity) : null;
      const moved = (row.lines || []).map((l) =>
        `<b class="${l.delta > 0 ? 'up' : 'dn'}">${esc(l.label)} ${l.delta > 0 ? '▲' : '▼'}${Math.abs(l.delta)}</b>`).join('');
      return `<div class="cmpbar ${row.slot === best ? 'pick' : ''}" ${r ? `style="--r:${rarCss(r.color)}"` : ''}>
        <span class="ic">${row.cur ? art(row.cur, row.cur.name) : slotGhost(row.slot)}</span>
        <span class="lb"><u>${esc(row.label)}${row.slot === heldSlot(ctx) ? ' · in hand' : ''}</u>${row.cur ? esc(row.cur.name) : 'empty — nothing in it'}</span>
        <span class="to">${row.cur ? n0(row.cur.power) : '—'} → ${n0(it.power)}</span>
        <span class="d ${dcls}">${dtxt}</span>
        ${moved ? `<span class="mv">${moved}</span>` : ''}</div>`;
    }).join('')}</div>`;
}

/** which gun is drawn right now ('weaponA'|'weaponB'), or null. Optional on the RPG side. */
function heldSlot(ctx) {
  try { return (ctx.rpg.heldSlot && ctx.rpg.heldSlot()) || null; } catch (e) { return null; }
}

/** the slot an item is currently worn in, or null — used for the "Worn" headline and the guards */
function wornAt(ctx, it) {
  const eq = ctx.rpg.equipped || {};
  return eqSlots(ctx).find((k) => eq[k] && it && eq[k].id === it.id) || null;
}

function detail(ctx, entry, preview) {
  if (!entry) return `<div class="detail"><div class="empty">Nothing picked.<br>Drag onto the figure · Arrows move · Enter or E equips · Delete dismantles.</div></div>`;
  const it = entry.it, worn = entry.worn;
  const r = rarOf(ctx, it.rarity);
  const el = elOf(ctx, it.element);
  const cmp = compareTo(ctx, it);
  const cs = cmp && (cmp.stats || {});
  const s = it.stats || {};

  // a quest token has no stats — printing "MOBILITY 0 / RESILIENCE 0" for one is noise pretending
  // to be information, so it gets its flavour line and nothing else
  const rows = it.kind !== 'weapon' && it.kind !== 'armour' ? ''
    : it.kind === 'weapon'
    ? WSTAT.map(([k, label, max]) => stat(label, n0(s[k]), {
        max, bar: s[k], cmp: cs ? cs[k] : null, delta: delta(n0(s[k]), cs ? n0(cs[k]) : null),
      })).join('') + stat('Crit', '×' + (+(s.critMul || 2)).toFixed(2), {
        bar: (s.critMul || 2) - 2, max: 0.6, delta: delta(+(s.critMul || 2).toFixed(2), cs ? +(cs.critMul || 2).toFixed(2) : null),
      })
    : ASTAT.map(([k, label, max]) => stat(label, n0(s[k]), {
        max, bar: s[k], cmp: cs ? cs[k] : null, delta: delta(n0(s[k]), cs ? n0(cs[k]) : null),
      })).join('');

  const meta = [it.archetypeLabel || slotLabel(ctx, it.slot), el && el.label,
    it.setLabel, it.upgrades ? '+' + it.upgrades : null,
    it.masterwork ? 'Masterwork' : null].filter(Boolean).join(' · ');

  // The one action this screen exists for, sized like it. Disabled carries the reason —
  // progression.js refuses quest tokens, so the player must be told, not silently ignored.
  // With two candidate slots there is no single "Equip": the button becomes one per slot, because
  // "equip" that silently overwrote whichever gun was in hand is the bug this replaces.
  const block = equipBlock(ctx, it, worn);
  const slots = block ? [] : slotsFor(ctx, it);
  const best = bestSlotFor(ctx, it);
  const primary = block || slots.length < 2
    ? `<div class="btnrow prime">
      <button class="btn gold equip" data-act="equip" data-id="${it.id}" data-nav="act"
        ${block ? 'aria-disabled="true" disabled' : ''} title="${esc(block || 'put this on')}">
        ${block ? (worn ? 'Already worn' : 'Cannot be worn') : 'Equip <kbd>E</kbd>'}</button>
    </div>${block && !worn ? `<div class="blocked">${esc(block)}</div>` : ''}`
    : `<div class="btnrow prime split">${slots.map((s) => {
        const cur = (ctx.rpg.equipped || {})[s];
        const d = n0(it.power) - (cur ? n0(cur.power) : 0);
        return `<button class="btn equip ${s === best ? 'gold' : ''}" data-act="equipslot"
          data-id="${it.id}" data-slot="${s}" data-nav="act"
          title="${esc(cur ? 'replaces ' + cur.name : 'that slot is empty')}">
          <span>${esc(slotLabel(ctx, s))}</span>${d ? `<b class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</b>` : ''}
          </button>`;
      }).join('')}</div><div class="blocked ok"><kbd>E</kbd> takes the highlighted one · or drag it onto a hand</div>`;

  const gear = it.kind === 'weapon' || it.kind === 'armour';
  const noDis = it.kind === 'quest' || it.noDismantle;
  const acts = [];
  if (gear) {
    acts.push(`<button class="btn" data-act="upgrade" data-id="${it.id}" data-nav="act">Upgrade${it.upgrades ? ' (+' + it.upgrades + ')' : ''}</button>`);
    acts.push(`<button class="btn" data-act="infuse" data-id="${it.id}" data-nav="act">Infuse</button>`);
  }
  if (!worn) acts.push(`<button class="btn warn" data-act="dismantle" data-id="${it.id}" data-nav="act"
    ${noDis ? 'aria-disabled="true" disabled' : ''}
    title="${esc(noDis ? 'a quest token — it is not yours to break' : 'break it down for parts')}"
    >${noDis ? 'Cannot dismantle' : inv.armed === it.id ? 'Sure? Break it' : 'Dismantle'}</button>`);

  return `<div class="detail ${preview ? 'preview' : ''}" style="--r:${rarCss(r.color)}">
    ${preview ? '<div class="pvtag">Hovering — click the tile to keep it here</div>' : ''}
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
    ${cmpBlock(ctx, it, worn)}
    ${primary}
    ${rows ? `<div class="rows">
      ${stat('Power', n0(it.power), { max: 400, delta: delta(n0(it.power), cmp ? n0(cmp.power) : null) })}
      ${rows}
    </div>` : ''}
    ${cmp ? `<div class="cmpn">every ▲▼ above is against ${esc(cmp.name)} — the ghost tick on each bar is where it sits</div>` : ''}
    ${gear ? `<div class="rows">${perkList(it)}</div>` : ''}
    ${acts.length ? `<div class="btnrow">${acts.join('')}</div>` : ''}
  </div>`;
}

// One bag tile: picture, power, and how it stacks against what is already on you. The name sits
// under the icon so the grid still reads as a list when you are hunting one specific roll.
function tile(ctx, e) {
  const it = e.it, r = rarOf(ctx, it.rarity), d = powerDelta(ctx, e);
  const dl = d ? `<span class="dl ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>` : '';
  // a quest token is not draggable at all — nothing wears it, so it must not read as a thing you
  // could pick up and place. Everything wearable is, and says so in its tooltip.
  const fits = slotsFor(ctx, it).length;
  return `<button class="tile ${it.id === inv.sel ? 'sel' : ''}" draggable="${fits ? 'true' : 'false'}"
    style="--r:${rarCss(r.color)}" data-act="pick" data-id="${it.id}" data-nav="list"
    data-equip="${it.id}" aria-pressed="${it.id === inv.sel}"
    title="${esc(it.name)} — ${esc(r.label)}${fits ? ' — drag onto the figure to wear it' : ''}">
    <span class="ic">${art(it, it.name)}</span>
    <span class="pw">${n0(it.power)}</span>${dl}
    <span class="nm">${esc(it.name)}</span></button>`;
}

const FILTERS = [['all', 'All'], ['weapons', 'Arms'], ['armour', 'Raiment'],
  ['head', 'Helm'], ['arms', 'Gauntlets'], ['chest', 'Cuirass'], ['legs', 'Greaves'], ['cloak', 'Mantle']];
// 'up' is deliberately NOT in here: the gold "N upgrades waiting" pill next to this segment is
// that control, and two adjacent things saying "Upgrades" is noise. inv.sort === 'up' simply
// leaves every chip unlit and lights the pill instead.
const SORTS = [['power', 'Power'], ['rarity', 'Rarity'], ['new', 'Newest']];
const seg = (items, cur, act) => `<div class="seg">${items.map(([k, l]) =>
  `<button class="${cur === k ? 'on' : ''}" data-act="${act}" data-id="${k}" data-nav="filter"
    aria-pressed="${cur === k}">${l}</button>`).join('')}</div>`;

/**
 * THE PAPER DOLL — a hooded wayfarer, drawn not fetched (inline SVG: filled cloth and gold-edged
 * plate, in the house style). Decoration only: it sits BEHIND the slots at pointer-events:none so it can never
 * eat a drop, and the slots stay big enough to hit. viewBox is fixed and the SVG stretches, so the
 * figure tracks whatever height the doll column ends up with on a short viewport.
 */
// The viewBox is authored at the grid's own proportions (4 rows of slots) and stretched with
// preserveAspectRatio="none" ON PURPOSE: the head has to land inside the helm cell and the hands
// inside the weapon cells at every window size, and a figure that keeps its aspect ratio would
// drift off the slots the moment the column changed width. Every limb is placed against a row:
// head ~row 1, shoulders/cloak row 2, hands row 3 (the two weapon cells), shins row 4.
// The viewBox is authored at the grid's own proportions and stretched with preserveAspectRatio
// ="none" ON PURPOSE: the head has to land in the helm cell and the hands in the weapon cells at
// every window size, and a figure that kept its aspect ratio would slide off them the moment the
// column changed width. The grid reserves a strip above row 1 and below row 4 that holds no slot,
// which is where the crown of the hood and the boots live — a figure whose every part is behind an
// opaque plate is not a figure, it is wallpaper.
// The wayfarer is drawn as SOLID FORM, not line-work: filled cloth with gradients, gold-edged
// armour over it, a face lost in the hood with two aether glints. A 1px outline of a person reads
// as an engineering schematic next to painted item icons — volume is the whole difference.
//
// The horizontal stretch is real and it is not constant: the doll column is a fixed ~267 px at
// every window, while the grid's HEIGHT rides --pdi (≈419 px at 1080p, ≈302 px at 720p). So the
// same viewBox is squashed ~1.45x at 1080p and ~2.0x at 720p. The figure is therefore authored
// NARROW — the body spans ~76 of the 210 units — so it lands slim at 1080p and stocky at 720p
// instead of being a mushroom at one of them. The CLOAK is the part allowed to flare to the full
// width: a cloak that sweeps wide is a cloak, so the stretch reads as drama rather than damage,
// and it is what puts painted colour under the outer slot columns.
// ponytail: one authored width split between two aspect ratios, upgrade path is a second nested
// <svg preserveAspectRatio="meet"> for the body if a third breakpoint ever lands between them.
const FIGURE = `<svg class="pdfig" viewBox="0 0 210 477" preserveAspectRatio="none" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="pdCk" x1=".08" y1="0" x2=".92" y2=".62">
      <stop offset="0" stop-color="#3b3180"/><stop offset=".34" stop-color="#2c2366"/>
      <stop offset=".72" stop-color="#282054"/><stop offset="1" stop-color="#241c4c"/></linearGradient>
    <linearGradient id="pdLn" x1=".1" y1="0" x2=".9" y2="1">
      <stop offset="0" stop-color="#5b3a86"/><stop offset=".6" stop-color="#331d55"/>
      <stop offset="1" stop-color="#150a26"/></linearGradient>
    <linearGradient id="pdRb" x1=".1" y1="0" x2=".92" y2=".9">
      <stop offset="0" stop-color="#7e6ccb"/><stop offset=".42" stop-color="#4b3b92"/>
      <stop offset="1" stop-color="#241a52"/></linearGradient>
    <linearGradient id="pdAr" x1=".18" y1="0" x2=".85" y2="1">
      <stop offset="0" stop-color="#241b4e"/><stop offset=".5" stop-color="#120d2c"/>
      <stop offset="1" stop-color="#06040d"/></linearGradient>
    <linearGradient id="pdHo" x1=".12" y1="0" x2=".92" y2=".9">
      <stop offset="0" stop-color="#7c69cf"/><stop offset=".36" stop-color="#3a2c7c"/>
      <stop offset="1" stop-color="#120c30"/></linearGradient>
    <linearGradient id="pdAu" x1=".06" y1="0" x2=".82" y2="1">
      <stop offset="0" stop-color="#fdf3d2"/><stop offset=".24" stop-color="#dcc281"/>
      <stop offset=".6" stop-color="#966c1f"/><stop offset="1" stop-color="#4a340f"/></linearGradient>
    <linearGradient id="pdAd" x1=".2" y1="0" x2=".85" y2="1">
      <stop offset="0" stop-color="#a98d52"/><stop offset=".48" stop-color="#6d4a15"/>
      <stop offset="1" stop-color="#2e1f08"/></linearGradient>
    <radialGradient id="pdFc" cx=".5" cy=".32" r=".72">
      <stop offset="0" stop-color="#030208"/><stop offset=".62" stop-color="#070513"/>
      <stop offset="1" stop-color="#1c1246"/></radialGradient>
    <!-- eyes: a glint, not a headlamp. Two hot dots in a black cowl is a wraith; this is the guy
         the player IS. Peak is roughly a third of what it was and it never reaches white. -->
    <radialGradient id="pdEy" cx=".5" cy=".45" r=".55">
      <stop offset="0" stop-color="#cfeaff" stop-opacity=".52"/>
      <stop offset=".45" stop-color="#8fd8ff" stop-opacity=".28"/>
      <stop offset="1" stop-color="#7c5bd6" stop-opacity="0"/></radialGradient>
    <!-- skin under the cowl: enough to say "a face is in there", not enough to leave the shadow -->
    <radialGradient id="pdSk" cx=".5" cy=".44" r=".62">
      <stop offset="0" stop-color="#c39a76" stop-opacity=".30"/>
      <stop offset=".58" stop-color="#6d4c3b" stop-opacity=".16"/>
      <stop offset="1" stop-color="#6d4c3b" stop-opacity="0"/></radialGradient>
    <radialGradient id="pdGm" cx=".4" cy=".32" r=".72">
      <stop offset="0" stop-color="#e8f8ff"/><stop offset=".42" stop-color="#8fd8ff"/>
      <stop offset="1" stop-color="#4b2fa2"/></radialGradient>
    <radialGradient id="pdSh" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#000" stop-opacity=".62"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
  </defs>
  <g stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="105" cy="470" rx="58" ry="9" fill="url(#pdSh)"/>
    <!-- CLOAK. An A-line: narrow at the shoulders, wide at the hem. That taper IS the silhouette —
         a cloak with parallel sides reads as a slab, which is exactly how the wireframe failed.
         Open at the front so the robe stands in the parting; the darkest value in the figure. -->
    <path fill="url(#pdCk)" d="M105 82c-19 0-33 8-37 26-8 62-16 154-20 248-2 38-3 68-2 92l32 4c0-48 1-114 3-174 2-70 4-140 6-170l18-14 18 14c2 30 4 100 6 170 2 60 3 126 3 174l32-4c1-24 0-54-2-92-4-94-12-186-20-248-4-18-18-26-37-26Z"/>
    <path fill="url(#pdLn)" d="M87 110c-2 30-4 100-6 170-2 60-3 126-3 174l11 1c0-48 1-114 3-174 2-69 4-138 6-168ZM123 110c2 30 4 100 6 170 2 60 3 126 3 174l-11 1c0-48-1-114-3-174-2-69-4-138-6-168Z"/>
    <path fill="rgba(250,236,196,.14)" d="M68 108c-8 62-16 154-20 248-2 38-3 68-2 92l7 1c-1-24 0-54 2-92 4-93 12-184 20-245Z"/>
    <path fill="none" stroke="rgba(216,189,122,.32)" stroke-width="1.5" d="M68 108c-8 62-16 154-20 248-2 38-3 68-2 92M142 108c8 62 16 154 20 248 2 38 3 68 2 92"/>
    <path fill="none" stroke="rgba(0,0,0,.34)" stroke-width="1.5" d="M62 168c-6 62-11 154-13 232-1 26-1 46 0 62M148 168c6 62 11 154 13 232 1 26 1 46 0 62"/>
    <path fill="none" stroke="rgba(216,189,122,.42)" stroke-width="2" d="m46 444 32 4M164 444l-32 4"/>
    <path fill="none" stroke="rgba(143,216,255,.24)" stroke-width="2.4" d="M142 108c8 62 16 154 20 248 2 38 3 68 2 92"/>
    <!-- LEGS + GREAVES + BOOTS. The boots live in the foot-room row, the one band below every plate. -->
    <path fill="url(#pdAr)" d="M89 322c-2 36-3 82-2 122h16c1-40 1-86 1-122ZM121 322c2 36 3 82 2 122h-16c-1-40-1-86-1-122Z"/>
    <path fill="url(#pdAd)" d="M88 372h15l-1 52H88ZM122 372h-15l1 52h14Z"/>
    <path fill="none" stroke="rgba(250,236,196,.28)" stroke-width="1.2" d="M89 386h13M108 386h13"/>
    <path fill="url(#pdAu)" d="M85 438h19v24c0 7-4 10-11 10H77c-5 0-6-5-3-9l11-9ZM125 438h-19v24c0 7 4 10 11 10h16c5 0 6-5 3-9l-11-9Z"/>
    <path fill="none" stroke="rgba(58,38,11,.55)" stroke-width="1.3" d="M85 452h19M106 452h19"/>
    <!-- ARMS -> VAMBRACE -> FIST CLOSED ON A HAFT. This is the idea the whole doll exists to
         express, so it is placed by arithmetic, not by eye. Measured cell bands (viewBox units,
         both window sizes at once — the union is what has to be clear):
             row 3 outer  y 166..256   cloak / gauntlet plates   -> forearm passes BEHIND them
             row 4 outer  y 263..351   NOTHING (HAND_CELL moved down to row 5)
             row 4 middle x 62..148    cuirass plate             -> stay outboard of x 62
             row 5 outer  y 359..448   the two weapon plates
         So the hand band is y 263..351 at x < 62: eighty-four units of unobstructed drawing,
         against the ten-unit row-gap the hands used to share with the weapon plate's own glass.
         That is why the weapon cells moved instead of the plate going transparent — and it is
         also where hands actually hang, at the hip, with the weapon at the thigh below them.
         Read, top to bottom: sleeve -> dark vambrace -> lit gold cuff -> a wrapped haft whose
         POMMEL shows above the fist and whose shaft runs out below it into the weapon plate,
         with the fist painted over the middle of it. A hand with a haft through it is a grip;
         a hand next to a box is two buttons and a bell.
         Front-facing and symmetric on purpose — preserveAspectRatio="none" over two aspect
         ratios means an asymmetric stance walks off its own slots. -->
    <path fill="url(#pdRb)" stroke="rgba(0,0,0,.5)" stroke-width="1.3" d="M84 96C74 95 66 99 63 106 57 122 53 136 50 150 46 168 44 185 43 200 41 216 40 231 39 243L53 244C54 231 55 216 57 200 58 185 61 168 65 150 68 136 72 122 78 108 81 101 87 97 92 96ZM126 96C136 95 144 99 147 106 153 122 157 136 160 150 164 168 166 185 167 200 169 216 170 231 171 243L157 244C156 231 155 216 153 200 152 185 149 168 145 150 142 136 138 122 132 108 129 101 123 97 118 96Z"/>
    <path fill="rgba(250,236,196,.15)" d="M84 96c-10-1-18 3-21 10-5 14-9 28-12 42l5 1c3-14 7-27 12-40 3-7 8-11 15-12ZM126 96c10-1 18 3 21 10 5 14 9 28 12 42l-5 1c-3-14-7-27-12-40-3-7-8-11-15-12Z"/>
    <!-- vambrace: dark leather over the forearm, ending at the wrist above the belt line -->
    <path fill="url(#pdAr)" d="M38 230h16l-2 30H36ZM172 230h-16l2 30h16Z"/>
    <path fill="rgba(250,236,196,.13)" d="M38 230h6l-1 30h-6ZM172 230h-6l1 30h6Z"/>
    <!-- gold cuff: the brightest thing on the limb, and the eye's handrail from shoulder to fist -->
    <path fill="url(#pdAd)" d="M34 234h26l-1 8H35ZM176 234h-26l1 8h25Z"/>
    <path fill="url(#pdAu)" d="M33 238h28l-1 20H34ZM177 238h-28l1 20h26Z"/>
    <path fill="none" stroke="rgba(46,30,8,.55)" stroke-width="1.2" d="M35 249h24M175 249h-24"/>
    <circle cx="47" cy="248" r="2.4" fill="#8fd8ff" opacity=".7"/>
    <circle cx="163" cy="248" r="2.4" fill="#8fd8ff" opacity=".7"/>
    <!-- THE HAFT, drawn BEFORE the hand so the hand closes over it. It is the LIGHT value here and
         the glove is the dark one: four near-black fingers banded across a lit bronze shaft is what
         makes this read as a grip rather than as a gold brick. Pommel above the knuckles, ferrule
         below the little finger, and the shaft runs past y 351 into the weapon plate — the thing
         and its slot are one object. -->
    <path fill="url(#pdAd)" d="M37 258h18l-1 14H38ZM173 258h-18l1 14h16Z"/>
    <path fill="url(#pdAu)" d="M37 258h18l-1 5H38ZM173 258h-18l1 5h16Z"/>
    <path fill="none" stroke="rgba(22,14,4,.6)" stroke-width="1.2" d="M38 271h16M172 271h-16"/>
    <path fill="url(#pdAd)" d="M39 268h14l-3 98h-8ZM171 268h-14l3 98h8Z"/>
    <path fill="rgba(250,236,196,.22)" d="M39 268h4l-2 98h-3ZM171 268h-4l2 98h3Z"/>
    <path fill="rgba(20,12,3,.45)" d="M49 268h4l-2 98h-3ZM161 268h-4l2 98h3Z"/>
    <path fill="url(#pdAu)" d="M36 322h20l-1 10H37ZM174 322h-20l1 10h18Z"/>
    <path fill="none" stroke="rgba(46,30,8,.5)" stroke-width="1.2" d="M39 342h13M39 352h12M171 342h-13M171 352h-12"/>
    <!-- THE FIST: four fingers wrapped round the shaft, thumb laid diagonally over them. Bars, not
         one block — the 1.5-unit gaps let the lit shaft through and that is what reads as knuckles.
         x 27..61 keeps the hand clear of the cuirass plate (x 62) at BOTH window sizes; y 274..321
         sits it mid-band with room above for the pommel and below for the ferrule. -->
    <g fill="url(#pdAr)" stroke="url(#pdAu)" stroke-width="1.2">
      <rect x="27" y="274" width="34" height="12" rx="5"/><rect x="149" y="274" width="34" height="12" rx="5"/>
      <rect x="28" y="287.5" width="33" height="11" rx="5"/><rect x="149" y="287.5" width="33" height="11" rx="5"/>
      <rect x="29" y="300" width="32" height="11" rx="5"/><rect x="149" y="300" width="32" height="11" rx="5"/>
      <rect x="30" y="312.5" width="30" height="10" rx="5"/><rect x="150" y="312.5" width="30" height="10" rx="5"/>
      <path d="M57 275c3 0 5 2 4 5l-3 15c-1 3-3 5-6 4l-5-1c-3-1-4-3-3-6l4-13c1-3 3-4 6-4Z"/>
      <path d="M153 275c-3 0-5 2-4 5l3 15c1 3 3 5 6 4l5-1c3-1 4-3 3-6l-4-13c-1-3-3-4-6-4Z"/>
    </g>
    <path fill="rgba(250,236,196,.16)" d="M29 275h30v3H29ZM181 275h-30v3h30Z"/>
    <!-- ROBE. Two full values lighter than the cloak: value, not outline, separates the layers. -->
    <path fill="url(#pdRb)" stroke="rgba(0,0,0,.55)" stroke-width="1.6" d="M105 74c-11 0-17 7-19 19l-4 74c-2 28-1 54 3 76h40c4-22 5-48 3-76l-4-74c-2-12-8-19-19-19Z"/>
    <!-- CUIRASS: darkest plate, brightest edge. The one place the eye lands on the torso. -->
    <path fill="url(#pdAr)" stroke="url(#pdAu)" stroke-width="1.7" d="M105 88c-7 0-12 5-14 14l-3 60c-1 24 1 44 5 56h24c4-12 6-32 5-56l-3-60c-2-9-7-14-14-14Z"/>
    <path fill="none" stroke="url(#pdAu)" stroke-width="1.8" d="m92 162 13 15 13-15"/>
    <path fill="none" stroke="rgba(216,189,122,.5)" stroke-width="1.3" d="M90 199c5 4 10 6 15 6s10-2 15-6M91 216c5 4 9 5 14 5s9-1 14-5"/>
    <circle cx="105" cy="185" r="6.6" fill="url(#pdGm)"/>
    <circle cx="105" cy="185" r="6.6" fill="none" stroke="url(#pdAu)" stroke-width="1.4"/>
    <path fill="none" stroke="rgba(216,189,122,.55)" stroke-width="1.2" d="M105 175v-6M105 201v-6M95 185h-6M121 185h-6"/>
    <!-- MANTLE across the shoulders, then FACETED PAULDRONS on top: angular plates with a lit
         top facet and a dark under-edge. Rounded blobs read as fruit, not armour. -->
    <path fill="url(#pdCk)" d="M105 66c-15 0-27 7-32 18-2 5 2 9 7 7 8-4 16-6 25-6s17 2 25 6c5 2 9-2 7-7-5-11-17-18-32-18Z"/>
    <path fill="none" stroke="rgba(216,189,122,.45)" stroke-width="1.3" d="M75 87c9-5 19-8 30-8s21 3 30 8"/>
    <path fill="url(#pdAd)" d="M84 74 64 79l-8 17 4 11 20-7 10-11Z"/>
    <path fill="url(#pdAu)" d="M84 74 64 79l-5 13 20-6 9-8Z"/>
    <path fill="url(#pdAd)" d="m126 74 20 5 8 17-4 11-20-7-10-11Z"/>
    <path fill="url(#pdAd)" d="m126 74 20 5 5 13-20-6-9-8Z" opacity=".55"/>
    <path fill="none" stroke="rgba(22,14,4,.6)" stroke-width="1.4" d="m56 96 4 11 20-7M154 96l-4 11-20-7"/>
    <!-- BELT + BUCKLE: they land in the gap between the arm row and the weapon row, one of the four
         bands where nothing is on top of the figure, so they are drawn to be seen. -->
    <path fill="url(#pdAu)" d="M82 240h46l-2 24H84Z"/>
    <path fill="none" stroke="rgba(46,30,8,.5)" stroke-width="1.2" d="M84 252h42"/>
    <path fill="#0e0922" stroke="url(#pdAu)" stroke-width="1.5" d="m105 242 10 10-10 10-10-10Z"/>
    <circle cx="105" cy="252" r="2.8" fill="#8fd8ff" opacity=".85"/>
    <!-- TABARD, hem pointed into the next open band -->
    <path fill="url(#pdCk)" stroke="rgba(0,0,0,.45)" stroke-width="1.2" d="M85 262h40l5 68-25 18-25-18Z"/>
    <path fill="none" stroke="url(#pdAu)" stroke-width="2" d="m80 330 25 18 25-18"/>
    <path fill="rgba(216,189,122,.32)" d="M105 276c-5 9-5 21 0 30 5-9 5-21 0-30Z"/>
    <!-- HOOD last: the crown row is the ONLY band with no plate over it, so this is the part that
         has to carry the character. Face in shadow, two aether glints, a lit cowl edge. -->
    <path fill="url(#pdHo)" d="M105 4c-9 0-14 6-16 16-2 10-2 19-4 29-2 12-4 22-7 31 8 5 17 7 27 7s19-2 27-7c-3-9-5-19-7-31-2-10-2-19-4-29-2-10-7-16-16-16Z"/>
    <path fill="none" stroke="rgba(0,0,0,.34)" stroke-width="1.4" d="M89 44c-1 12-3 22-6 31M121 44c1 12 3 22 6 31"/>
    <path fill="url(#pdFc)" d="M105 16c-8 0-13 7-13 18 0 12 6 21 13 21s13-9 13-21c0-11-5-18-13-18Z"/>
    <path fill="none" stroke="rgba(0,0,0,.42)" stroke-width="2.4" d="M88 27c6-6 11-9 17-9s11 3 17 9"/>
    <path fill="none" stroke="rgba(250,236,196,.66)" stroke-width="1.7" d="M92 34c0-11 5-18 13-18s13 7 13 18"/>
    <path fill="none" stroke="rgba(250,236,196,.38)" stroke-width="2" d="M105 6c-9 1-14 11-15 24-1 14-3 30-6 44"/>
    <path fill="none" stroke="rgba(143,216,255,.26)" stroke-width="2" d="M105 6c9 1 14 11 15 24 1 14 3 30 6 44"/>
    <!-- a face, dimly: cheek/jaw plane, brows, two soft glints, nose, mouth. Order matters — the
         skin plane goes UNDER the features so the features are shadow on skin, not marks on void. -->
    <ellipse cx="105" cy="38" rx="12.5" ry="15" fill="url(#pdSk)"/>
    <path fill="none" stroke="rgba(9,6,20,.45)" stroke-width="1.6" d="M96.5 30c2.4-1.5 4.6-1.5 7 0M113.5 30c-2.4-1.5-4.6-1.5-7 0"/>
    <ellipse cx="99.8" cy="35" rx="2.9" ry="2.5" fill="url(#pdEy)"/>
    <ellipse cx="110.2" cy="35" rx="2.9" ry="2.5" fill="url(#pdEy)"/>
    <path fill="none" stroke="rgba(9,6,20,.4)" stroke-width="1.2" d="M96.9 34.4c1.9-1.7 3.9-1.7 5.8 0M113.1 34.4c-1.9-1.7-3.9-1.7-5.8 0"/>
    <path fill="none" stroke="rgba(9,6,20,.32)" stroke-width="1.2" d="M105 35v6l-2.4 2"/>
    <path fill="none" stroke="rgba(9,6,20,.30)" stroke-width="1.3" d="M101.4 48c2.4 1.3 4.8 1.3 7.2 0"/>
  </g></svg>`;

// Where each slot sits ON THE BODY. Named cells, not indices — the slot LIST comes from
// progression and may gain a second weapon; anything not named here lands in the spare row, so a
// new slot appears on the doll instead of disappearing from it. Rows 1 and 6 hold no slot: they
// are the head-room and the foot-room the drawing needs.
// The two weapon cells sit in ROW 5, not row 4, and that is load-bearing rather than cosmetic:
// row 4's outer columns then hold no plate at all, which is the only place on this grid where a
// hand can be drawn at full strength at BOTH window sizes (see the arm comment in FIGURE for the
// measured bands). It also puts them where a person's hands and weapons actually are — hip and
// thigh — instead of beside the ribs. Row 4 outer is now deliberately empty; do not fill it.
const DOLL_CELL = { head: '2/2/3/3', cloak: '3/1/4/2', arms: '3/3/4/4', chest: '4/2/5/3', legs: '5/2/6/3' };
const HAND_CELL = ['5/1/6/2', '5/3/6/4'];

function dollCells(ctx) {
  const hands = weaponSlots(ctx);
  const cells = {};
  hands.forEach((s, i) => { cells[s] = HAND_CELL[i] || null; });
  for (const s of eqSlots(ctx)) if (!(s in cells)) cells[s] = DOLL_CELL[s] || null;
  return cells;
}

/**
 * One body slot. It is BOTH a drop target (data-slot, wired in Screens.js) and a button: clicking
 * it equips the picked item when that item fits, and otherwise filters the bag to this slot —
 * which keeps the old one-click "show me what else goes here" flow and makes click-then-click-a-slot
 * work without a second hit target crammed into 60 px.
 */
function dollBodySlot(ctx, sl, cell) {
  const eq = ctx.rpg.equipped || {};
  const it = eq[sl], r = it ? rarOf(ctx, it.rarity) : null, g = slotGain(ctx, sl);
  // "where does this go" is answered BEFORE any drag: whatever the bag is showing you — the
  // hovered tile, or the arrow-key selection when there is no mouse — lights the slots that take
  // it. A gun lights BOTH hands (either is legal); a helm lights the head and nothing else; a
  // quest token lights nothing. An empty slot is called out separately: it is a free win, not a
  // trade. Screens.js re-applies the same two classes on hover so a mouse never needs a re-render.
  const sel = findItem(ctx, inv.hover || inv.sel);
  const ok = !!(sel && (ctx.rpg.inventory || []).some((x) => x.id === sel.id) && slotsFor(ctx, sel).includes(sl));
  const on = inv.filter === (isWeaponSlot(sl) ? 'weapons' : sl);
  const held = sl === heldSlot(ctx);   // which gun is actually in your hands right now
  // the slot a bare equip (E, right-click, the one big button) would actually choose, lit harder
  // than the other legal one — "here are your options, here is the one I would take"
  const pick = ok && bestSlotFor(ctx, sel) === sl;
  return `<button class="pdslot ${it ? '' : 'empty'} ${on ? 'on' : ''} ${held ? 'held' : ''} ${ok ? (it ? 'ok' : 'okfree') : ''} ${pick ? 'okpick' : ''}"
    style="grid-area:${cell};${r ? `--r:${rarCss(r.color)}` : ''}"
    data-act="slotjump" data-id="${sl}" data-slot="${sl}" data-nav="worn" aria-pressed="${on}"
    title="${esc(ok ? 'put ' + sel.name + ' here' : it ? it.name + (held ? ' — in your hands now' : '') + ' — click for what else fits' : 'empty — click for what fits')}">
    ${held ? '<span class="hd">in hand</span>' : ''}
    <span class="ic">${it ? art(it, it.name) : slotGhost(sl)}</span>
    <span class="sl">${esc(slotLabel(ctx, sl))}</span>
    <span class="nm">${it ? esc(it.name) : 'empty'}</span>
    <span class="pw">${it ? n0(it.power) : '—'}</span>
    ${g > 0 ? `<span class="dl up">▲${g}</span>` : ''}</button>`;
}

function paperDoll(ctx) {
  const cells = dollCells(ctx);
  const placed = Object.keys(cells).filter((s) => cells[s]);
  const spare = Object.keys(cells).filter((s) => !cells[s]);
  const st = ctx.rpg.stats || {};
  return `<div class="pdoll" role="group" aria-label="What you are wearing">
    <div class="pdhd"><span>Worn</span><b>${n0(st.power)}<u>power</u></b></div>
    <div class="pdgrid">${FIGURE}${placed.map((s) => dollBodySlot(ctx, s, cells[s])).join('')}</div>
    ${spare.length ? `<div class="pdspare">${spare.map((s) => dollBodySlot(ctx, s, 'auto')).join('')}</div>` : ''}
    <p class="pdhint">Drag a find from the bag onto the figure — or pick it and click a slot.</p>
  </div>`;
}

/** The entry the detail column is showing: the hovered tile wins while the mouse is over the bag,
 *  otherwise the selection. Hovering must never move the selection — the click owns that. */
function shownEntry(ctx, list) {
  const hov = inv.hover && list.find((e) => e.it.id === inv.hover);
  if (hov) return { entry: hov, preview: hov.it.id !== inv.sel };
  return { entry: list.find((e) => e.it.id === inv.sel) || wornEntry(ctx, inv.sel) || list[0] || null, preview: false };
}
function wornEntry(ctx, id) {
  const eq = ctx.rpg.equipped || {};
  const w = id && eqSlots(ctx).map((k) => eq[k]).find((x) => x && x.id === id);
  return w ? { it: w, worn: true, idx: -1 } : null;
}

/** The detail column on its own, so a hover can repaint just that one card instead of the screen. */
export function detailHTML(ctx) {
  const list = filtered(ctx);
  const { entry, preview } = shownEntry(ctx, list);
  return detail(ctx, entry, preview);
}
/** What detailHTML currently depends on — Screens.js skips the repaint when this has not moved. */
export const detailKey = () => (inv.hover || '') + '|' + (inv.sel || '');

export function renderInv(ctx, body) {
  const list = filtered(ctx);
  // the selection may be a WORN item (picked from a body slot when the bag holds nothing that
  // fits) — it is no longer in the grid, so look there before falling back to the first tile
  const sel = list.find(e => e.it.id === inv.sel) || wornEntry(ctx, inv.sel) || list[0] || null;
  inv.sel = sel ? sel.it.id : null;
  if (inv.hover && !list.some((e) => e.it.id === inv.hover)) inv.hover = null;
  const held = (ctx.rpg.inventory || []).length;
  const ups = upgradeCount(ctx);

  // Empty sockets pad the grid out to a full bag. Every loot game does this: a half-empty grid of
  // sockets reads as "room for more", four floating cards read as an unfinished list.
  const SOCKETS = 24;
  const ghosts = Math.max(0, SOCKETS - list.length);
  const grid = `<div class="bag" role="list">${list.map(e => tile(ctx, e)).join('')}` +
    `<span class="tile ghost" aria-hidden="true"></span>`.repeat(ghosts) + '</div>' +
    (list.length ? '' : `<div class="empty">${inv.filter === 'all'
      ? 'Nothing carried. The Vale is generous to those who go looking.'
      : 'Nothing carried fits that slot — what you are wearing is the only one you have.'}</div>`);

  body.innerHTML = currencyStrip(ctx, true) + `
    <div class="invtop">
      ${seg(FILTERS, inv.filter, 'filter')}
      <span class="spacer"></span>
      <button class="btn ${ups || inv.sort === 'up' ? 'gold' : ''} upsbadge" data-act="sort" data-id="up"
        data-nav="filter" aria-pressed="${inv.sort === 'up'}"
        title="sort the bag by what beats what you are wearing">${upsLabel(ups)}</button>
      ${seg(SORTS, inv.sort, 'sort')}
      <span class="cap">${held} / 120 carried</span>
    </div>
    <div class="invcols">
      ${paperDoll(ctx)}
      <div class="bagwrap">${grid}</div>
      ${detailHTML(ctx)}
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

// ---------------------------------------------------------------- quest log
// Primary source: the live engine, game.rpg.quest (src/rpg/quest.js — a `Quests` instance).
// Its state() is scalars-only by design (automation contract): { active:[{id,name,region,level,
// tracked,ready,objectives:[{type,text,have,need,done}],xp}], completed:[id,...], tracked, region }.
// That has everything for LIVE progress but none of the authored prose/giver/full reward/chain
// links — those live in the read-only catalogue (QUEST_BY_ID, from src/rpg/quests/index.js, the
// same file quest.js itself reads). Each active/completed id is enriched by merging the two: catalogue
// first (name/giver/region/level/text/reward/next/req), live state second so it wins on anything both
// carry (objectives with real have/need/done, tracked/ready flags).
// A quest counts as "The Chain" when the catalogue links it to a neighbour (`next` or its derived
// reverse `req`); everything else still active is a side quest.
//
// Fallback (kept in case the engine ends up wired through ctx instead, or isn't present yet):
// ctx.rpg.quests as an array of quest-shaped objects, or an object with active/side/completed buckets.
function questLists(game, ctx) {
  const engine = game?.rpg?.quest;
  if (engine?.state) {
    let st; try { st = engine.state(); } catch (e) { st = null; }
    if (st) {
      const isMain = (id) => { const q = QUEST_BY_ID[id]; return !!(q && (q.next != null || q.req != null)); };
      const active = (st.active || []).map((a) => ({ ...(QUEST_BY_ID[a.id] || {}), ...a }));
      const completed = (st.completed || []).map((id) => {
        const q = QUEST_BY_ID[id]; if (!q) return null;
        // a finished quest satisfied every objective — show the log as fully checked off, not empty
        return { ...q, objectives: (q.objectives || []).map((o) => ({ ...o, have: o.count ?? 1, need: o.count ?? 1, done: true })) };
      }).filter(Boolean);
      return { active: active.filter((q) => isMain(q.id)), side: active.filter((q) => !isMain(q.id)), completed };
    }
  }
  const src = ctx.rpg.quests;
  if (!src) return { active: [], side: [], completed: [] };
  if (!Array.isArray(src)) {
    const active = (src.active || src.chain || []).slice();
    const side = (src.side || src.sideQuests || []).slice();
    const completed = (src.completed || src.done || []).slice();
    return { active, side, completed };
  }
  const isDone = (q) => q.state === 'done' || q.state === 'complete' || q.done === true;
  const isMain = (q) => q.next != null || q.main === true || q.chain === true;
  const live = src.filter((q) => !isDone(q));
  return { active: live.filter(isMain), side: live.filter((q) => !isMain(q)), completed: src.filter(isDone) };
}

function giverLabel(g) {
  if (!g) return '';
  const s = String(g);
  const m = /^stele:(.+)$/.exec(s);
  if (m) return `${regionLabel(m[1])} Wayfinder Stele`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function regionLabel(id) { return (BIOMES && BIOMES[id] && BIOMES[id].name) || (id ? id.charAt(0).toUpperCase() + id.slice(1) : ''); }

// src/rpg/quest.js bakes "— h / n" (or a trailing "✓") into `text` for an old string-only HUD's
// benefit (see its doc-comment). This screen renders its own counter/check column, so strip it back off.
const stripObjCount = (s) => String(s == null ? '' : s).replace(/\s*(?:[—-]\s*\d+\s*\/\s*\d+|✓)\s*$/, '');

function objText(o) {
  if (o.text || o.label) return stripObjCount(o.text || o.label);
  const n = o.count ?? o.need ?? 1;
  switch (o.type) {
    case 'kill': return `Slay ${n} ${o.enemy || 'enemies'}${o.where ? ' in ' + regionLabel(o.where) : ''}`;
    case 'collect': return `Recover ${n} ${o.item || 'items'}`;
    case 'slay': return `Defeat ${o.enemy || o.name || 'the target'}`;
    case 'reach': return `Discover ${o.poi || (o.where ? regionLabel(o.where) : 'the location')}`;
    case 'escort': return `Escort ${o.name || 'the guide'} home`;
    default: return 'Objective';
  }
}

// Reaching a place (or walking a guide there) is not a countable thing — a "0 / 1" next to
// "Reach the ruins" reads as a bug, not progress. The live distance-to-go already lives on the
// minimap waypoint readout (HUD._minimap's mmWpd) while the quest is tracked; this screen just
// stays quiet instead of faking a second, stale copy of that number.
const NO_COUNTER = new Set(['reach', 'escort']);

function questObjectives(q) {
  const objs = q.objectives || [];
  if (!objs.length) return '';
  return `<div class="qobjs">${objs.map((o) => {
    const have = o.have ?? o.progress; const need = o.need ?? o.count;
    const done = o.done === true || (have != null && need != null && have >= need);
    const counter = (!NO_COUNTER.has(o.type) && have != null && need != null) ? `<span class="oc">${have} / ${need}</span>` : '';
    return `<div class="qobj ${done ? 'done' : ''}"><i>${done ? '✓' : '▸'}</i><span class="ot">${esc(objText(o))}</span>${counter}</div>`;
  }).join('')}</div>`;
}

// Where a quest sits in the region-scoped run of "The Chain" it belongs to (consecutive same-
// region links only — a run resets at the region border, so "III of IV" always means "three
// quests into this region's four", never a raw index into the whole 55-quest game).
function chainInfo(q) {
  if (!q || (q.next == null && q.req == null)) return null;
  let start = q;
  while (start.req && QUEST_BY_ID[start.req] && QUEST_BY_ID[start.req].region === q.region) start = QUEST_BY_ID[start.req];
  let idx = 1, node = start;
  while (node.id !== q.id && node.next && QUEST_BY_ID[node.next]) { node = QUEST_BY_ID[node.next]; idx++; }
  let total = idx, tail = node;
  while (tail.next && QUEST_BY_ID[tail.next] && QUEST_BY_ID[tail.next].region === q.region) { tail = QUEST_BY_ID[tail.next]; total++; }
  return { idx, total };
}

// `nChoice` is how many candidates this quest is actually offering right now. "Uncommon item" next
// to a rack of three of them is a lie the player can see, so say what the transaction really is.
function questReward(ctx, r, nChoice) {
  if (!r) return '';
  const bits = [];
  if (r.xp) bits.push(`${n0(r.xp).toLocaleString()} xp`);
  if (r.glimmer) bits.push(`${n0(r.glimmer).toLocaleString()} glimmer`);
  if (nChoice > 1) bits.push(`your pick of ${nChoice} ${rarOf(ctx, r.tier).label.toLowerCase()} rewards`);
  else if (r.tier) bits.push(rarOf(ctx, r.tier).label + ' item');
  return bits.length ? `<div class="qreward">Reward — ${bits.join(' · ')}</div>` : '';
}

// The full written text an accepted quest carries — offer, in-the-field progress, and the return
// line — laid out as a short journal so nothing the writer wrote is hidden behind quest state.
// The stage that matches where the quest actually is gets highlighted; the others sit quieter.
function questText(text, done) {
  if (!text) return '';
  const stage = done ? 'done' : 'progress';
  const rows = [['offer', 'Offered'], ['progress', 'In the field'], ['done', 'Return']]
    .filter(([k]) => text[k])
    .map(([k, label]) => `<p class="qstage${k === stage ? ' cur' : ''}"><b>${label}</b>${esc(text[k])}</p>`);
  return rows.length ? `<div class="qtext">${rows.join('')}</div>` : '';
}

// ---------------------------------------------------------------- reward choice
// The WoW transaction: two or three rewards are shown when you ACCEPT, you think about them while
// you play, and you take one at turn-in. src/rpg/quest.js pre-rolls the candidates and persists
// them; everything here only reads (they arrive on state().active[].choices as plain items).
// Each candidate is a REAL rolled item, so it goes through the same compareTo/delta the inventory
// detail pane uses — being able to read it against what you have on is what makes it a choice
// rather than a menu.
const RHEAD = {
  weapon: [['damage', 'Impact'], ['rpm', 'Rounds / min'], ['mag', 'Magazine']],
  armour: [['mobility', 'Mobility'], ['resilience', 'Resilience'], ['recovery', 'Recovery'],
           ['discipline', 'Discipline'], ['strength', 'Strength']],
};

function rewardCard(ctx, it, opts = {}) {
  if (!it) return '';
  const r = rarOf(ctx, it.rarity), el = elOf(ctx, it.element), cmp = compareTo(ctx, it);
  const s = it.stats || {}, cs = (cmp && cmp.stats) || null;
  // armour rolls a lopsided stat spread on purpose, so show the three it actually leans on
  const keys = it.kind === 'armour'
    ? RHEAD.armour.filter(([k]) => n0(s[k]) > 0).sort((a, b) => n0(s[b[0]]) - n0(s[a[0]])).slice(0, 3)
    : RHEAD.weapon;
  const rows = keys.map(([k, label]) => stat(label, n0(s[k]), { delta: delta(n0(s[k]), cs ? n0(cs[k]) : null) })).join('');
  const meta = [it.archetypeLabel || slotLabel(ctx, it.slot), el && el.label, it.setLabel].filter(Boolean).join(' · ');
  const pd = cmp ? n0(it.power) - n0(cmp.power) : 0;
  const act = opts.pick != null
    ? `<button class="btn gold" data-act="takereward" data-i="${opts.pick}" data-nav="act">Take this</button>` : '';
  return `<div class="rcard" style="--r:${rarCss(r.color)}">
    <div class="rhead"><span class="ic">${art(it, it.name)}</span>
      <span class="rh"><span class="rn">${esc(it.name)}</span>
        <span class="rr"><i></i>${esc(r.label)}</span>
        <span class="rm">${esc(meta)}</span></span>
      <span class="rpw">${n0(it.power)}<u>power</u>${pd ? `<b class="${pd > 0 ? 'up' : 'dn'}">${pd > 0 ? '▲' : '▼'}${Math.abs(pd)}</b>` : ''}</span>
    </div>
    <div class="rows">${rows}</div>
    <div class="cmpn">${cmp ? 'against ' + esc(cmp.name) + ' — what you have on' : 'nothing equipped there yet'}</div>
    ${act}
  </div>`;
}

/** the choice block that hangs under an active quest in the log */
function questChoices(ctx, list, ready) {
  if (!Array.isArray(list) || !list.length) return '';
  return `<div class="qchoice"><h4>${ready ? 'Your reward — take one at the stele' : 'Choose one on turn-in'}</h4>
    <div class="rgrid">${list.map((it) => rewardCard(ctx, it)).join('')}</div></div>`;
}

/**
 * The turn-in picker. Screens.js raises this the moment a quest with an unclaimed choice is handed
 * in; the button carries the index back through the one act dispatcher. Closing without picking
 * takes the first candidate (quest.js `claim`) — never nothing.
 */
export function renderRewardPicker(ctx, r, body) {
  const list = (r && r.cands) || [];
  if (!list.length) { body.innerHTML = `<div class="qlog"><div class="empty">Nothing left to choose.</div></div>`; return; }
  body.innerHTML = `<div class="rpick">
    <div class="rpq">${esc(r.name || '')}</div>
    <p class="rpn">Only one of these comes with you.</p>
    <div class="rgrid big">${list.map((it, i) => rewardCard(ctx, it, { pick: i })).join('')}</div>
  </div>`;
}

function questCard(ctx, q, done) {
  const giver = q.giver ? giverLabel(q.giver) : null;
  const region = q.region ? regionLabel(q.region) : null;
  // a stele's own name already names its region ("Frostveil Tundra Wayfinder Stele") — repeating
  // the region right after it is noise, not information, so it only earns its own spot when it adds one
  const meta = [giver, q.level ? 'Level ' + n0(q.level) : null, (region && !(giver && giver.startsWith(region))) ? region : null]
    .filter(Boolean).join(' · ');

  // The offer/progress/return prose reads best at a comfortable measure (~62ch, capped in CSS) —
  // but a 1200 px card left the other two-thirds of the row empty next to it, which reads as a
  // layout bug rather than a typographic choice. Give that space a job: chain position + reward,
  // the two facts a WoW-style log always racks beside the quest text instead of under it.
  const chain = chainInfo(q);
  const chainHtml = chain ? `<div class="qchain"><span class="k">Chapter</span>
      <span class="v">${chain.idx}<i>of</i>${chain.total}</span><span class="rgn">${esc(region || '')}</span></div>` : '';
  const rewardHtml = questReward(ctx, q.reward, done ? 0 : (q.choices || []).length);
  const side = chainHtml + rewardHtml;
  const textHtml = questText(q.text, done);
  const body = (textHtml || side) ? `<div class="qbody">
      <div class="qmain">${textHtml}</div>${side ? `<aside class="qside">${side}</aside>` : ''}
    </div>` : '';

  return `<div class="qcard ${done ? 'qdone' : ''}">
    <div class="qhead"><span class="qname">${esc(q.name || q.id || 'Unknown quest')}</span>${done ? '<span class="qtick">✓ complete</span>' : ''}</div>
    ${meta ? `<div class="qmeta">${esc(meta)}</div>` : ''}
    ${questObjectives(q)}
    ${done ? '' : questChoices(ctx, q.choices, q.ready)}
    ${body}
  </div>`;
}

function questSection(ctx, title, list, alwaysShow, done) {
  if (!list.length && !alwaysShow) return '';
  return `<div class="qsec"><h3>${esc(title)}</h3>${
    list.length ? list.map((q) => questCard(ctx, q, done)).join('') : '<div class="empty">Nothing here yet.</div>'
  }</div>`;
}

// "The Chain" is one continuous route through the ten regions (each region's finale points its
// `next` at the following region's head — see quests/index.js), so with the 6-quest active cap a
// level-1 Vale quest and a level-15 Frostveil one sitting active at once is the NORMAL case, not
// an edge case. A flat list mixes them with no signal of why they are so far apart; group by
// region (ordered by the region's own level band, low to high) and label each group with its
// level range so the jump reads as "you are in two places on the route", not as a bug.
function chainSection(ctx, list) {
  if (!list.length) return `<div class="qsec"><h3>The Chain</h3><div class="empty">Nothing here yet.</div></div>`;
  const byRegion = new Map();
  for (const q of list) { const k = q.region || ''; if (!byRegion.has(k)) byRegion.set(k, []); byRegion.get(k).push(q); }
  const groups = [...byRegion.entries()].sort((a, b) =>
    Math.min(...a[1].map((q) => q.level || 0)) - Math.min(...b[1].map((q) => q.level || 0)));
  return `<div class="qsec"><h3>The Chain</h3>${groups.map(([rid, qs]) => {
    qs.sort((a, b) => (a.level || 0) - (b.level || 0));
    const lv = qs.map((q) => q.level || 0).filter(Boolean);
    const band = lv.length ? ` · Level ${Math.min(...lv)}${Math.max(...lv) !== Math.min(...lv) ? '–' + Math.max(...lv) : ''}` : '';
    return `<div class="qgroup"><h4>${esc(regionLabel(rid) || 'Unknown region')}${band}</h4>${
      qs.map((q) => questCard(ctx, q, false)).join('')}</div>`;
  }).join('')}</div>`;
}

export function renderQuestLog(game, ctx, body) {
  const { active, side, completed } = questLists(game, ctx);
  if (!active.length && !side.length && !completed.length) {
    body.innerHTML = `<div class="qlog"><div class="empty">No quests accepted yet. Find a Wayfinder Stele and press <kbd>E</kbd> to read what it has to say.</div></div>`;
    return;
  }
  body.innerHTML = `<div class="qlog">${
    chainSection(ctx, active) +
    questSection(ctx, 'Side Quests', side, false, false) +
    questSection(ctx, 'Completed', completed, false, true)
  }</div>`;
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
    // A body slot does one of two things, and which one is visible before you click (a slot that
    // will take what you picked is lit): if the picked item FITS, this is the drop — put it there.
    // Otherwise it is the swap: filter the bag to what fits AND pre-pick the best candidate, so the
    // detail panel opens already comparing. Two clicks on the same slot is therefore pick + wear.
    case 'slotjump': {
      const sel = findItem(ctx, inv.sel);
      const inBag = sel && (ctx.rpg.inventory || []).some(x => x.id === sel.id);
      if (inBag && slotsFor(ctx, sel).includes(id)) return doEquip(ctx, sel.id, id, say);
      inv.filter = isWeaponSlot(id) ? 'weapons' : id;
      inv.armed = null;
      const b = bestFor(ctx, id), worn = (ctx.rpg.equipped || {})[id];
      inv.sel = (b && b.id) || (worn && worn.id) || null;
      return 'inv';
    }
    case 'upsjump': inv.filter = 'all'; inv.sort = 'up'; inv.armed = null; inv.sel = null; return 'inv';
    case 'equip': return doEquip(ctx, id, null, say);
    case 'equipslot': return doEquip(ctx, id, el.getAttribute('data-slot'), say);
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
      say(ok ? 'broken down — materials added' : 'that one is not yours to break', ok ? 'good' : 'bad');
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

/**
 * The ONE equip path — the button, the E key, a double-click, a click on a body slot and a drop all
 * come through here, so the guard, the target slot and the message are decided once.
 * `slot` null means "you did not say": take the slot it gains most in (an empty hand first, then
 * the weaker gun) rather than silently overwriting whatever happened to be in hand.
 * ctx.rpg.equip's second argument is the explicit target; a progression that ignores it still works.
 */
function doEquip(ctx, id, slot, say) {
  const it = findItem(ctx, id);
  const worn = !!wornAt(ctx, it);
  const why = it ? equipBlock(ctx, it, worn) : 'that is not in your bag';
  if (why) { say(why, 'bad'); return 'inv'; }
  const eq = ctx.rpg.equipped || {};
  const before = {};
  for (const s of slotsFor(ctx, it)) before[s] = eq[s];
  // No slot named (right-click, E, the single EQUIP button) -> call equip WITHOUT one and let
  // progression apply its own rule: empty slot first, else the weaker of the two, a tie keeps the
  // gun in your hands. That rule lives in exactly one place; this only reports where it landed —
  // which right-click needs, because an instant invisible action has to say what it did.
  const target = slot && slotsFor(ctx, it).includes(slot) ? slot : null;
  const ok = target ? ctx.rpg.equip(id, target) : ctx.rpg.equip(id);
  if (!ok) { say('that would not go on', 'bad'); return 'inv'; }
  inv.sel = null;
  const landed = wornAt(ctx, it) || target;
  const had = before[landed];
  say(`${slotLabel(ctx, landed)} — ${it.name}${had ? ' replaces ' + had.name : ''}`, 'good');
  return 'inv';
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
