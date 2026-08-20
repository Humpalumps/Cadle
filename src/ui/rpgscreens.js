// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Aetherfall via the ctx
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

export function renderChar(ctx, body) {
  const { it, s } = equippedWeapon(ctx);
  const st = ctx.rpg.stats || {};
  const p = ctx.player;
  const r = rarOf(ctx, it.rarity);
  const el = elOf(ctx, it.element);
  const dps = s.damage && s.rpm ? Math.round(s.damage * s.rpm / 60) : null;

  const meta = [it.archetypeLabel || it.archetype, el && el.label, it.power ? 'Power ' + it.power : null,
    it.upgrades ? '+' + it.upgrades : null].filter(Boolean).join(' · ');

  const wcard = `
    <div class="card">
      <h3>Armament</h3>
      <div class="wname">${esc(it.name)}</div>
      <div class="rar" style="--r:${rarCss(r.color)}"><i></i>${esc(r.label)}</div>
      <div class="wel">${esc(meta)}</div>
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
      <div class="row"><b>Rank ${ctx.rpg.level || 1}</b><span>${n0(xp)} / ${n0(next)} xp</span></div>
      <div class="xp"><i style="width:${clamp(xp / Math.max(1, next), 0, 1) * 100}%"></i></div>
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
          ${pts ? '' : 'aria-disabled="true"'}>${pts ? 'Spend them' : 'Open skill tree'}</button>
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
      <div class="rows">
        ${Object.keys(MEAN).map(k => stat(k, n0(st[k]), {
          max: 100, pips: tiers[k] || 0, note: MEAN[k](),
        })).join('')}
      </div>
    </div>`;

  const eq = ctx.rpg.equipped || {};
  const slots = ['head', 'arms', 'chest', 'legs', 'cloak'];
  const raiment = `
    <div class="card wide">
      <h3>Raiment</h3>
      <div class="rows">
        ${slots.map(sl => {
          const a = eq[sl];
          if (!a) return `<div class="stat"><span class="k">${sl}</span><span class="v">empty</span><span class="d"></span><span class="n">nothing worn — look in your inventory</span></div>`;
          const ar = rarOf(ctx, a.rarity);
          const best = Object.keys(a.stats || {}).sort((x, y) => a.stats[y] - a.stats[x])[0];
          return `<div class="stat"><span class="k">${sl}</span>
            <span class="v">${esc(a.name)}</span>
            <span class="d"><span class="rar" style="--r:${rarCss(ar.color)}"><i></i></span> ${n0(a.power)}</span>
            <span class="n">${esc(a.setLabel || '')}${best ? ' · best stat ' + best + ' +' + a.stats[best] : ''}</span></div>`;
        }).join('')}
      </div>
      <div class="btnrow"><button class="btn" data-act="goinv" data-nav="char">Open inventory</button></div>
    </div>`;

  body.innerHTML = currencyStrip(ctx, false) + `<div class="cols">${wcard}${rank}${standing}${raiment}</div>`;
}

// ---------------------------------------------------------------- inventory
const inv = { sel: null, filter: 'all', armed: null };

function allItems(ctx) {
  const eq = ctx.rpg.equipped || {};
  const worn = ['weapon', 'head', 'arms', 'chest', 'legs', 'cloak'].map(k => eq[k]).filter(Boolean);
  const bag = (ctx.rpg.inventory || []).slice();
  return worn.map(i => ({ it: i, worn: true })).concat(bag.map(i => ({ it: i, worn: false })));
}

function filtered(ctx) {
  const all = allItems(ctx);
  const f = inv.filter;
  const keep = f === 'all' ? all : all.filter(e => e.it.kind === (f === 'weapons' ? 'weapon' : 'armour'));
  return keep.sort((a, b) => (b.worn - a.worn) || ((b.it.power || 0) - (a.it.power || 0)));
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
  if (!entry) return `<div class="detail"><div class="empty">Choose something from the list.<br>Arrow keys move, Enter picks.</div></div>`;
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

  const meta = [r.label, it.archetypeLabel || it.slot, el && el.label,
    it.setLabel, it.upgrades ? '+' + it.upgrades : null,
    it.masterwork ? 'Masterwork' : null].filter(Boolean).join(' · ');

  const acts = [];
  if (!worn) acts.push(`<button class="btn gold" data-act="equip" data-id="${it.id}" data-nav="act">Equip</button>`);
  acts.push(`<button class="btn" data-act="upgrade" data-id="${it.id}" data-nav="act">Upgrade${it.upgrades ? ' (+' + it.upgrades + ')' : ''}</button>`);
  acts.push(`<button class="btn" data-act="infuse" data-id="${it.id}" data-nav="act">Infuse</button>`);
  if (!worn) acts.push(`<button class="btn warn" data-act="dismantle" data-id="${it.id}" data-nav="act">${inv.armed === it.id ? 'Sure? Break it' : 'Dismantle'}</button>`);

  return `<div class="detail">
    <div class="wname">${esc(it.name)}</div>
    <div class="rar" style="--r:${rarCss(r.color)}"><i></i>${esc(meta)}</div>
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

export function renderInv(ctx, body) {
  const list = filtered(ctx);
  if (!list.some(e => e.it.id === inv.sel)) inv.sel = list.length ? list[0].it.id : null;
  const entry = list.find(e => e.it.id === inv.sel) || null;

  const chips = [['all', 'Everything'], ['weapons', 'Weapons'], ['armour', 'Raiment']]
    .map(([k, l]) => `<button class="btn ${inv.filter === k ? 'on' : ''}" data-act="filter" data-id="${k}"
        data-nav="filter" aria-pressed="${inv.filter === k}">${l}</button>`).join('');

  const items = list.length ? list.map(e => {
    const it = e.it, r = rarOf(ctx, it.rarity), el = elOf(ctx, it.element);
    const meta = [r.label, it.archetypeLabel || it.slot, el && el.label].filter(Boolean).join(' · ');
    return `<button class="it ${e.worn ? 'worn' : ''} ${it.id === inv.sel ? 'sel' : ''}"
      style="--r:${rarCss(r.color)}" data-act="pick" data-id="${it.id}" data-nav="list"
      aria-pressed="${it.id === inv.sel}">
      <span class="eq" aria-hidden="true"></span>
      <span class="nm">${esc(it.name)}</span>
      <span class="mt">${esc(meta)}</span>
      <span class="pw">${n0(it.power)}</span></button>`;
  }).join('') : '<div class="empty">Your bag is empty. Aurelen is not.</div>';

  body.innerHTML = currencyStrip(ctx, true) + `
    <div class="invcols">
      <div>
        <div class="filters">${chips}<span style="flex:1"></span>
          <span class="rar" style="align-self:center">${list.length} item${list.length === 1 ? '' : 's'}</span></div>
        <div class="ilist" role="list">${items}</div>
      </div>
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
