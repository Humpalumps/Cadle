/**
 * Quests — a data-driven engine. All content lives in ./quests/*.js as plain objects; this file only
 * RUNS them. Adding a quest means adding an object, never writing a function.
 *
 * Quests are WRITTEN, never spoken (user decision 2026-08-23). No voice, no portrait card — the Vale's
 * opening beat survives as `vale-01` with the same staging (aetheryte flare, zone card, waypoint east).
 *
 * Objective types (see ./quests/index.js for the authoring contract):
 *   kill    { enemy, count, where? }            — enemy:death, optionally scoped to a region
 *   collect { item, name, count, from[], chance } — quest-item drops off tagged mobs (loot:picked)
 *   slay    { enemy, name, where? }             — one named elite / mini-boss
 *   reach   { poi, r? }                         — get within r of a POI / landmark / region heart
 *   escort  { from, to, r? }                    — walk a guide home (degrades to `reach to`)
 *
 * ONE listener each for 'enemy:death', 'loot:picked', 'quest:guide' and 'props:stele'. 55 quests
 * with a subscription each is a leak, and memMB flat over 30 s is a hard gate.
 *
 * API (RPG.js wires these onto window.__game.quest):
 *   init(), update(dt, t)
 *   accept(id) -> bool, abandon(id) -> bool, complete(id) -> bool (debug force turn-in),
 *   turnIn(id, pick?) -> bool, fail(id) -> bool (escort death path; a failed quest is re-acceptable),
 *   rewards(id) -> [item] (the pre-rolled candidates, plain JSON), rewardIds(id) -> [id],
 *   claim(id, i) -> bool (take candidate i of a turned-in quest), pendingClaim() -> id | '',
 *   readStele(region) -> id acted on | '' (what 'props:stele' calls; safe to call directly),
 *   offersAt(region) -> [id], all() -> catalogue, debugTick(id) -> bool,
 *   state() -> { active:[{id,name,region,objectives:[{text,have,need,done}]}], completed:[id] } — scalars only
 * HUD calls emitted: hud.setQuest(name, objectives[], otherActiveTitles[]) where each objective is
 *   { type, text, done, toString() -> text } plus { have, need } for the COUNTABLE types only —
 *   reach/escort ship no counter, their text carries a live distance readout instead.
 */
import { regionAt, BIOMES, LANDMARKS } from '../world/Biomes.js';
import { setWaypoint, clearWaypoint } from '../ui/mapscreen.js';
import { QUESTS, BY_ID, POIS } from './quests/index.js';
// READ-ONLY use of the loot builder's generators (same pattern as the Biomes import above), and only
// as the fallback roller: `ctx.rpg.rollItem` is preferred whenever it exists. Without this the whole
// reward-choice feature would sit dark until another agent's file lands, and a quest would silently
// go back to a single fixed drop.
import { makeWeapon, makeArmour } from './items.js';

const SAVE_KEY = 'cadle.quest';   // main.js clears this under ?fresh=1 — keep the name
const MAX_ACTIVE = 6;
const CHOICE_MAX = 3;             // WoW offers 2-3; more than three is a shop, not a decision
const POWER_PER_LEVEL = 8;        // mirrors loot.js / progression.powerLevel()'s gearless fallback

/** world {x,z} for an anchor: an explicit point, a POI name, a landmark name, or a region id */
function anchor(a) {
  if (!a) return null;
  if (typeof a === 'object') return a.x != null ? a : null;
  if (POIS[a]) return POIS[a];
  const b = BIOMES[a]; if (b && b.cx != null) return { x: b.cx, z: b.cz };
  return LANDMARKS.find((l) => l.name === a)?.position ?? null;
}
const need = (o) => o.count ?? 1;
const hit = (want, got) => (Array.isArray(want) ? want.includes(got) : want === got);

// ---------------------------------------------------------------- objective handlers
// death(o, ev) -> how much to add; tick(o, p) -> same, polled at 2 Hz; at(o) -> waypoint anchor
const H = {
  kill: {
    death: (o, ev) => (hit(o.enemy, ev.enemy.type) && (!o.where || regionAt(ev.enemy.position.x, ev.enemy.position.z) === o.where) ? 1 : 0),
    at: (o) => anchor(o.at ?? o.where),
  },
  slay: {
    // `exact` is on whenever the elite runtime exists — the engine spawns the named elite itself, so the
    // tag is guaranteed and a random trash mob of the same type must NOT count. Without that runtime the
    // match stays loose so the chain is still finishable.
    death: (o, ev, exact) => (hit(o.enemy, ev.enemy.type) && (o.tag && exact ? ev.enemy.questTag === o.tag : true) ? 1 : 0),
    at: (o) => anchor(o.at ?? o.where),
  },
  collect: { at: (o) => anchor(o.at ?? o.where) },   // fed by the drop roll below + loot:picked
  reach: {
    tick: (o, p) => { const a = anchor(o.poi); return a && Math.hypot(p.x - a.x, p.z - a.z) <= (o.r ?? 45) ? 1 : 0; },
    at: (o) => anchor(o.poi),
  },
  // A real escort: the GUIDE walks the route, the guide can die, and dying FAILS the quest. There is no
  // tick() on purpose — the objective is driven entirely by the 'quest:guide' event, so walking to the
  // destination yourself does nothing. Needs enemies.spawnFriendly; without it the quest is not offered.
  escort: { at: (o) => anchor(o.to), counter: false },
};
H.reach.counter = false;   // reaching a place is not a count — no "0 / 1" on the tracker

export class Quests {
  constructor(game, rpg) {
    this.game = game; this.rpg = rpg;
    this.done = new Set(); this.active = new Map(); this.tracked = null;
    this._region = null; this._poll = 0; this._hudKey = ''; this._p = null;
    this._elites = new Map(); this._bossShown = false;
    this._guides = new Map();   // `questId#objectiveIndex` -> guide handle. Never persisted: a guide dies with the session.
    // The WoW loop: candidates are rolled ONCE at accept and carried around while you play, so they
    // are persisted with the quest. `choices` = still being decided on; `_pending` = turned in, not
    // yet claimed (the picker is open, or the tab was closed while it was).
    this.choices = new Map(); this._pending = new Map();
    this._load();
  }

  // ---------------------------------------------------------------- persistence
  _load() {
    try {
      const d = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); if (!d) return;
      for (const id of d.done ?? []) if (BY_ID[id]) this.done.add(id);
      for (const id in d.active ?? {}) if (BY_ID[id]) this.active.set(id, (d.active[id] || []).map((n) => n | 0));
      this.tracked = BY_ID[d.tracked] ? d.tracked : null;
      this._region = d.region ?? null;
      // THE POINT of persisting these: a player who logs back in must get the same three rewards
      // they were deliberating over, not a fresh roll. Items are plain JSON by construction
      // (items.js: "Everything here returns plain JSON-safe objects"), so this is a straight restore.
      const ok = (a) => Array.isArray(a) && a.length && a.every((x) => x && x.id && x.kind);
      for (const id in d.choices ?? {}) if (this.active.has(id) && ok(d.choices[id])) this.choices.set(id, d.choices[id]);
      for (const id in d.pending ?? {}) if (BY_ID[id] && ok(d.pending[id])) this._pending.set(id, d.pending[id]);
    } catch (e) {}
  }
  _save() {
    try {
      const active = {}; for (const [id, c] of this.active) active[id] = c;
      const choices = {}; for (const [id, c] of this.choices) choices[id] = c;
      const pending = {}; for (const [id, c] of this._pending) pending[id] = c;
      localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, done: [...this.done], active, choices, pending, tracked: this.tracked, region: this._region }));
    } catch (e) {}
  }

  // ---------------------------------------------------------------- lifecycle
  init() {
    const g = this.game;
    g.events.on('enemy:death', (ev) => {
      if (!ev?.enemy?.position || !this.active.size) return;
      // SNAPSHOT. Completing an objective here can reach turnIn(), which calls accept(q.next) and
      // INSERTS into this.active — and a Map iterator visits entries added during iteration. The
      // freshly accepted quest was then credited for the very kill that finished its predecessor:
      // finish vale-02 on a sentinel and vale-03's "gather from sentinels" objective banked that same
      // corpse, and a count-1 chain link could complete and chain again inside one event.
      for (const [id, c] of [...this.active]) {
        if (!this.active.has(id)) continue;                 // turned in or failed earlier in this same event
        const q = BY_ID[id];
        for (let i = 0; i < q.objectives.length; i++) {
          const o = q.objectives[i]; if (c[i] >= need(o)) continue;
          if (o.type === 'collect') { this._collectRoll(o, i, id, c, ev); continue; }
          const n = H[o.type]?.death?.(o, ev, this._canElite()) ?? 0;
          if (n) this._bump(id, c, i, n);
        }
      }
    });
    // the escort guide. `tag` is the key WE handed spawnFriendly, so it survives whatever id scheme the
    // enemies side settles on; `id` is the fallback when only that comes back.
    g.events.on('quest:guide', (ev) => {
      const key = ev?.tag ?? this._guideKey(ev?.id); if (!key) return;
      const cut = key.lastIndexOf('#'), id = key.slice(0, cut), i = +key.slice(cut + 1);
      const c = this.active.get(id);
      // a stale or malformed event (a guide from an abandoned quest, an index that no longer exists)
      // must never throw inside the bus — every other listener on 'quest:guide' is behind us.
      if (!c || BY_ID[id]?.objectives[i]?.type !== 'escort') { this._guides.delete(key); return; }
      if (ev.arrived) { this._guides.delete(key); this._bump(id, c, i, 1); }
      else if (ev.alive === false) { this._guides.delete(key); this._fail(id, 'The guide did not survive'); }
    });
    g.events.on('loot:picked', (ev) => {
      const it = ev?.item; if (!it || it.kind !== 'quest' || !this.active.size) return;
      for (const [id, c] of [...this.active]) {              // same reason as enemy:death above
        if (!this.active.has(id)) continue;
        const q = BY_ID[id];
        for (let i = 0; i < q.objectives.length; i++) {
          const o = q.objectives[i];
          if (o.type === 'collect' && o.item === (it.questItem ?? it.id) && c[i] < need(o)) this._bump(id, c, i, it.count ?? 1);
        }
      }
    });
    // the Wayfinder Stele. Props owns the prompt, the range test and the debounce and emits one event
    // per press; all we do is decide what this press is worth.
    g.events.on('props:stele', (ev) => this.readStele(ev?.region));

    // A save written before reward choice existed (or one whose roll failed because the item module
    // was not up yet) has active quests with no candidates. Roll them now rather than dropping the
    // player back into the old single-fixed-reward path for the rest of that quest.
    for (const id of this.active.keys()) if (!this.choices.has(id)) {
      const c = this._rollChoices(BY_ID[id]); if (c) this.choices.set(id, c);
    }
    // Reloaded with the picker still open. The candidates survived, but re-opening a modal during
    // boot would fight the intro and pause the game under the harness, so take the first one — the
    // deliberate "never nothing" rule, same as an abandoned dialog.
    for (const id of [...this._pending.keys()]) this.claim(id, 0);
    this._save();
  }

  /**
   * ONE exchange per press, the way a real giver works: hand back what is finished, otherwise take the
   * next thing to read. Doing a whole region on a single press is the stacked-toast wall that was just
   * removed from the region-entry fallback — this way every quest gets its own card and its own authored
   * text, and the player chooses when to take the next. Turn-ins come first so a finished chain always
   * pays out before it offers more. Returns the id it acted on, or '' if the press did nothing.
   * A stele IS a deliberate visit, so unlike the fallback it offers side quests too.
   */
  readStele(region) {
    if (!region) return '';
    for (const id of this.active.keys()) {           // safe: turnIn mutates `active`, but we return at once
      if (BY_ID[id].region === region && this._ready(id)) { this.turnIn(id); return id; }
    }
    const id = this.offersAt(region)[0];             // QUESTS order = chain first, then sides
    if (!id) { this.game.hud?.toast?.('THE STELE HAS NOTHING MORE FOR YOU', { ms: 2200 }); return ''; }
    if (this.active.size >= MAX_ACTIVE) { this.game.hud?.toast?.('YOUR QUEST LOG IS FULL', { ms: 2600 }); return ''; }
    return this.accept(id) ? id : '';
  }

  /** a collect objective rolls its own drop off a tagged mob; with no quest-item runtime it self-credits */
  _collectRoll(o, i, id, c, ev) {
    if (!hit(o.from ?? o.enemy, ev.enemy.type)) return;
    if (Math.random() > (o.chance ?? 0.4)) return;
    // API ASK: rpg.dropQuestItem(position, itemId, displayName) -> truthy when a physical drop was made.
    const dropped = this.rpg?.dropQuestItem?.(ev.enemy.position, o.item, o.name ?? o.item);
    if (!dropped) this._bump(id, c, i, 1);   // graceful degrade: the pickup step is skipped, the quest still finishes
  }

  _bump(id, c, i, n) {
    const q = BY_ID[id], o = q.objectives[i];
    const was = c[i] | 0;
    c[i] = Math.min(need(o), was + n);
    this._save(); this._hud();
    // Only when the count actually moved — a re-entrant bump that changes nothing must stay silent,
    // or a pack dying at once machine-guns the tick.
    if (c[i] > was) this._sfx(c[i] >= need(o) ? 'accept' : 'step');
    if (c[i] >= need(o) && q.objectives.length > 1) this.game.hud?.toast?.(this._line(o, c[i]).toUpperCase(), { ms: 2000, kind: 'ability' });
    if (this._ready(id)) this._onReady(id);
  }

  _guideKey(gid) { if (gid == null) return null; for (const [k, v] of this._guides) if (v === gid) return k; return null; }
  /** escort needs a friendly body; with no runtime for it the quest is not offered at all (see offersAt) */
  _canEscort() { return typeof this.game.enemies?.spawnFriendly === 'function'; }
  _canElite() { return typeof this.game.enemies?.spawn === 'function'; }

  /**
   * A `slay` target is a real named elite that WE place, at the objective's anchor, once the player is
   * close enough for it to be the fight they walked there for — and it gets a boss frame, because a
   * mini-boss without one is just a bigger trash mob. HUD.js only auto-frames `def.boss`, and an elite
   * is a modifier on a non-boss def, so the frame is ours to raise and ours to take down.
   */
  _ensureElite(id, i, o) {
    const key = id + '#' + i; if (this._elites.has(key) || !this._canElite() || !o.tag) return;
    const a = H.slay.at(o), p = this._p; if (!a || !p) return;
    if (Math.hypot(p.x - a.x, p.z - a.z) > (o.spawnR ?? 260)) return;      // not there yet
    const e = this.game.enemies.spawn(Array.isArray(o.enemy) ? o.enemy[0] : o.enemy, { x: a.x, z: a.z },
      { elite: true, name: o.name, questTag: o.tag, level: BY_ID[id].level });
    if (!e) return;
    this._elites.set(key, e);
    this._bossShown = true;
    this.game.hud?.showBoss?.(e.name, () => ({ hp: e.health / (e.maxHealth || 1), shield: e.maxShield ? e.shield / e.maxShield : 0 }));
    this.game.hud?.toast?.(String(e.name).toUpperCase(), { ms: 3000, kind: 'super' });
  }

  /** the bar comes down with the quest — a frame for a mob that no longer exists is worse than no frame */
  _clearElites(id) {
    for (const [k] of [...this._elites]) if (k.startsWith(id + '#')) this._elites.delete(k);
    this._hideBoss();
  }
  _hideBoss() { if (this._bossShown && !this._elites.size) { this._bossShown = false; this.game.hud?.hideBoss?.(); } }
  _clearGuides(id) {
    for (const [k, v] of [...this._guides]) if (k.startsWith(id + '#')) { this.game.enemies?.despawnFriendly?.(v); this._guides.delete(k); }
  }
  /** put the guide on the road once its objective is the CURRENT one — not at accept, so it walks with you */
  _ensureGuide(id, i, o) {
    const key = id + '#' + i; if (this._guides.has(key) || !this._canEscort()) return;
    const to = anchor(o.to), from = anchor(o.from) ?? this.game.player.position; if (!to) return;
    // API: spawnFriendly(bodyType, from, { to, hp, tag }) -> a handle with an `id`, or a bare id.
    const h = this.game.enemies.spawnFriendly(o.body ?? 'wisp', from, { to, hp: o.hp ?? 400, tag: key });
    if (h == null) return;
    this._guides.set(key, h.id ?? h);
    this.game.hud?.toast?.('THE GUIDE IS WITH YOU — KEEP IT ALIVE', { ms: 2800, kind: 'ability' });
  }

  /** a failed quest is NOT completed: it leaves `active`, never enters `done`, and can be accepted again */
  _fail(id, why) {
    if (!this.active.delete(id)) return false;
    this._clearGuides(id); this._clearElites(id); this.choices.delete(id);
    if (this.tracked === id) this.tracked = this.active.keys().next().value ?? null;
    this._sfx('fail');
    this.game.hud?.notify?.('Quest failed', BY_ID[id].name);
    this.game.hud?.toast?.(String(why).toUpperCase(), { ms: 3400, kind: 'ability' });
    this._save(); this._hud(true);
    return true;
  }
  fail(id) { return this._fail(id, 'Abandoned'); }

  _ready(id) { const c = this.active.get(id); return !!c && BY_ID[id].objectives.every((o, i) => (c[i] | 0) >= need(o)); }

  _onReady(id) {
    const q = BY_ID[id];
    this.game.hud?.notify?.('Objective complete', q.name);
    // no stele in the world yet -> the quest turns itself in, so content is playable now (brief §4c fallback)
    if (!this._steleFor(q.region)) this.turnIn(id);
  }
  // Props lives at game.world.props (World.js owns it) — NOT game.props. Reading the wrong one returned
  // undefined for every region, which silently pinned the auto-offer fallback ON and made the stele path
  // untestable. `game.props` is kept as a second chance in case it is ever aliased up.
  _props() { return this.game.world?.props ?? this.game.props ?? null; }
  _steleFor(region) { return this._props()?.steleAt?.(region) ?? null; }

  /** Quest beats made no sound at all. In WoW, accept and complete are iconic stings; a quest that
   *  advances in silence reads as a HUD glitch rather than progress. These reuse sfx that already
   *  exist (see src/audio/sfx.js) at distinct pitches — no new assets, no voice (quests are written). */
  _sfx(beat) {
    const a = this.game.audio; if (!a?.play) return;
    try {
      if (beat === 'accept') a.play('ui-click', { pitch: 1.25, vol: 0.6, force: true });
      else if (beat === 'step') a.play('ui-click', { pitch: 1.6, vol: 0.32, force: true });
      else if (beat === 'done') a.play('levelup', { pitch: 1.12, vol: 0.55, force: true });
      else if (beat === 'fail') a.play('shield-break', { pitch: 0.8, vol: 0.5, force: true });
    } catch (e) {}
  }

  // ---------------------------------------------------------------- reward choice (WoW-style)
  /**
   * Pre-roll the candidates AT ACCEPT. That is the whole mechanic: you are shown two or three
   * rewards when you take the quest, you think about them while you play, and you pick one at
   * turn-in. Rolling at turn-in instead would make the log a promise it had not made yet.
   *
   * Content is DATA: `reward.choices[]` in src/rpg/quests/*.js, each entry
   *   { tier, kind:'weapon'|'armour', archetype?, element?, slot?, set? }.
   * A quest with no `choices` keeps today's single fixed `dropLoot` at turn-in, so nothing is ever
   * unfinishable and no quest has to be rewritten to keep working.
   */
  _rollChoices(q) {
    const specs = q?.reward?.choices; if (!Array.isArray(specs) || !specs.length) return null;
    const power = Math.max(8, (q.level | 0) * POWER_PER_LEVEL);
    const out = [];
    for (const s of specs.slice(0, CHOICE_MAX)) {
      const it = this._roll1(s.tier ?? q.reward.tier ?? 'common', s, power, q.level | 0);
      if (it && it.id) out.push(it);
    }
    return out.length ? out : null;
  }

  /** one candidate. The loot builder's `ctx.rpg.rollItem(tier, opts)` when it exists, the generators
   *  it is built on when it does not — either way a plain JSON item with no world side effects. */
  _roll1(tier, s, power, level) {
    const opts = { kind: s.kind ?? 'weapon', slot: s.slot, set: s.set, archetype: s.archetype, element: s.element, power, level };
    if (typeof this.rpg?.rollItem === 'function') {
      try { const it = this.rpg.rollItem(tier, opts); if (it && it.id) return it; } catch (e) {}
    }
    try {
      return s.kind === 'armour'
        ? makeArmour(tier, power, { slot: s.slot, set: s.set })
        : makeWeapon(tier, power, { archetypes: this.game.rpg?.ctx?.weapon?.archetypes, archetype: s.archetype, element: s.element });
    } catch (e) { return null; }
  }

  /** the candidates a quest is offering right now — plain JSON items, safe to hand back through an eval */
  rewards(id) { return (this.choices.get(id) ?? this._pending.get(id) ?? []).map((it) => ({ ...it })); }
  /** ids only: the cheapest thing a persistence check can diff across a page reload */
  rewardIds(id) { return (this.choices.get(id) ?? this._pending.get(id) ?? []).map((it) => it.id); }
  /** '' or the one quest that has been turned in and is still waiting on a pick */
  pendingClaim() { return this._pending.keys().next().value ?? ''; }

  /**
   * Take candidate `i` of a quest that has been turned in but not yet claimed.
   * i out of range — an abandoned dialog, a reload mid-picker, a debug force-complete — takes the
   * FIRST candidate on purpose: a player who closed the window still walks away with gear, because
   * "you turned in a quest and got nothing" is the one outcome that is never acceptable.
   */
  claim(id, i) {
    const c = this._pending.get(id); if (!c || !c.length) return false;
    this._pending.delete(id);
    this._grant(c[i] ?? c[0]);
    this._save();
    return true;
  }

  /** the picked item goes straight into the bag — a reward you chose is not something to go hunt for */
  _grant(it) {
    if (!it) return;
    // API ASK (rpg owner): mirror progression.addItem onto ctx.rpg as `addItem(item)`. It exists in
    // progression.js but is not published, and `ctx.rpg.inventory` IS progression's live array
    // (refresh() assigns the array itself, not a copy), so pushing lands it in the bag and in the
    // save. Prefer addItem the day it appears.
    if (typeof this.rpg?.addItem === 'function') this.rpg.addItem(it);
    else if (Array.isArray(this.rpg?.inventory)) this.rpg.inventory.push(it);
    else { this.rpg?.dropLoot?.(this.game.player.position, it.rarity, { kind: it.kind }); return; }
    this.rpg?.save?.();
    this.game.hud?.notify?.('Reward claimed', it.name);
    this.game.hud?.toast?.(String(it.name).toUpperCase(), { ms: 2800, kind: 'super' });
  }

  /**
   * Turn-in with an unclaimed choice must NOT silently grant a default: the picker comes up and the
   * player takes one. Two deliberate exceptions:
   *   - an explicit `pick` (the picker calling back, or complete()'s debug force) grants that one;
   *   - under ?auto=1 there is nobody to click and a modal would pause the game under the mechanics
   *     gate, so the first candidate is granted immediately.
   */
  _offerChoice(id, q, cands, pick) {
    if (typeof pick === 'number' && cands[pick]) { this._grant(cands[pick]); return; }
    this._pending.set(id, cands);
    const screens = this.game.rpg?.screens;
    if (this.game.auto || typeof screens?.showReward !== 'function') { this.claim(id, 0); return; }
    screens.showReward(id, q.name, cands);
  }

  // ---------------------------------------------------------------- accept / turn in
  offersAt(region) {
    const out = [];
    for (const q of QUESTS) {
      if (q.region !== region || this.done.has(q.id) || this.active.has(q.id)) continue;
      if (q.req && BY_ID[q.req].region === region && !this.done.has(q.req)) continue;   // cross-region links order the ROUTE, they do not lock a region you walked into early
      if (!this._canEscort() && q.objectives.some((o) => o.type === 'escort')) continue;  // no guide runtime -> unavailable. Every escort is a SIDE quest, so no chain ever stalls on this.
      out.push(q.id);
    }
    return out;
  }

  accept(id) {
    const q = BY_ID[id]; if (!q || this.done.has(id) || this.active.has(id) || this.active.size >= MAX_ACTIVE) return false;
    this.active.set(id, q.objectives.map(() => 0));
    this.tracked ??= id;
    const cands = this._rollChoices(q); if (cands) this.choices.set(id, cands);
    const g = this.game;
    if (q.intro) {   // the Vale's opening beat: staged, written, no audio
      const [x, y, z] = q.intro.flare ?? [0, 0, 0];
      g.hud?.notify?.(q.intro.card?.[0] ?? '', q.intro.card?.[1] ?? '');
      setTimeout(() => {
        g.vfx?.emit?.('aether-burst', { x, y: (g.terrain?.heightAt?.(x, z) ?? 0) + y, z }, { color: 0xb070ff, count: 36, scale: 2 });
        g.postfx?.flash?.(0xb08cff, 0.35, 0.5);
      }, 2200);
    }
    this._sfx('accept');
    g.hud?.notify?.('New Quest', q.name);
    g.hud?.toast?.(`QUEST ACCEPTED — ${q.name.toUpperCase()}`, { ms: 3200, kind: 'ability' });
    g.hud?.questText?.(q.name, q.text?.offer ?? '');   // quest-log builder's hook; ignored if absent
    this._save(); this._hud(true);
    return true;
  }

  abandon(id) {
    if (!this.active.delete(id)) return false;
    this._clearGuides(id); this._clearElites(id); this.choices.delete(id);
    if (this.tracked === id) this.tracked = this.active.keys().next().value ?? null;
    this._save(); this._hud(true);
    return true;
  }

  /** `pick` is the index of the chosen reward. Omit it and the picker decides — see _offerChoice. */
  turnIn(id, pick) {
    const q = BY_ID[id]; if (!q || !this.active.has(id)) return false;
    this.active.delete(id); this.done.add(id); this._clearGuides(id); this._clearElites(id);
    if (this.tracked === id) this.tracked = this.active.keys().next().value ?? null;
    const cands = this.choices.get(id); this.choices.delete(id);
    const g = this.game, r = q.reward ?? {};
    this._sfx('done');
    this.rpg?.addXp?.(r.xp ?? 0);
    if (r.glimmer) this.rpg?.grant?.({ glimmer: r.glimmer });          // API ASK: expose prog.grant on ctx.rpg
    if (cands?.length) this._offerChoice(id, q, cands, pick);
    else if (r.tier) this.rpg?.dropLoot?.(g.player.position, r.tier, { kind: r.kind ?? 'weapon' });
    g.hud?.notify?.('Quest complete', q.name);
    g.hud?.toast?.(`+${r.xp ?? 0} XP`, { ms: 2600, kind: 'super' });
    g.hud?.questText?.(q.name, q.text?.done ?? '');
    if (q.next && BY_ID[q.next] && !this.done.has(q.next)) this.accept(q.next);
    this._save(); this._hud(true);
    return true;
  }

  /** debug force: satisfy every objective and turn in. Takes candidate 0 rather than raising a modal
   *  the harness has no way to answer — the "never nothing" rule, applied to a force-complete. */
  complete(id) {
    if (!this.active.has(id) && !this.accept(id)) return false;
    const c = this.active.get(id); BY_ID[id].objectives.forEach((o, i) => { c[i] = need(o); });
    return this.turnIn(id, 0);
  }

  // ---------------------------------------------------------------- frame
  update(dt, t) {
    const p = this.game.player?.position; if (!p || t < this._poll) return;
    this._poll = t + 0.5; this._p = p;
    // region entry: auto-offer the chain where no stele stands yet
    const reg = regionAt(p.x, p.z);
    if (reg !== this._region) { this._region = reg; this._save(); }
    // No stele here yet: the region hands out its OWN chain, one quest at a time, the way a giver would,
    // and the next link arrives on turn-in. Side quests are NOT pushed — they wait at the stele. (Dumping
    // three at once was toast spam and it spent the active cap before the player had chosen anything.)
    if (!this._steleFor(reg) && ![...this.active.keys()].some((k) => BY_ID[k].region === reg)) {
      const head = this.offersAt(reg).find((qid) => BY_ID[qid].next || BY_ID[qid].req);
      if (head) this.accept(head);
    }
    for (const [id, c] of this.active) {
      const q = BY_ID[id];
      for (let i = 0; i < q.objectives.length; i++) {
        const o = q.objectives[i]; if (c[i] >= need(o)) continue;
        const n = H[o.type]?.tick?.(o, p) ?? 0;
        if (n) this._bump(id, c, i, n);
      }
    }
    // Bodies in the world belong to the objective you are actually TRACKING: one guide, one named elite,
    // one boss frame. Spawning a guide for every accepted escort would put four wisps on four routes you
    // are nowhere near, and each of them could die and fail a quest you had not started walking.
    const tid = this.tracked, tc = tid && this.active.get(tid);
    if (tc) {
      const q = BY_ID[tid], i = q.objectives.findIndex((o, j) => tc[j] < need(o));
      const o = i >= 0 ? q.objectives[i] : null;
      if (o?.type === 'escort') this._ensureGuide(tid, i, o);
      else if (o?.type === 'slay') this._ensureElite(tid, i, o);
    }
    for (const [k, e] of this._elites) if (!e.alive) this._elites.delete(k);   // killed, or recycled by the cap
    this._hideBoss();
    this._hud();
  }

  // ---------------------------------------------------------------- presentation
  _line(o, have) {
    const n = need(o), h = Math.min(n, have | 0);
    const base = o.text ?? ({
      kill: `Slay ${o.name ?? o.enemy}`, slay: `Slay ${o.name ?? o.enemy}`,
      collect: `Gather ${o.name ?? o.item}`, reach: `Reach ${o.poi}`, escort: `Escort the wisp to ${o.to}`,
    })[o.type] ?? o.type;
    if (H[o.type]?.counter === false) {                  // a place is not a count: show how far, not "0 / 1"
      if (h >= n) return `${base} ✓`;
      const a = anchor(o.poi ?? o.to), d = a && this._p ? Math.round(Math.hypot(this._p.x - a.x, this._p.z - a.z) - (o.r ?? 45)) : 0;
      return d > 0 ? `${base} — ${d} m` : base;
    }
    return n > 1 ? `${base} — ${h} / ${n}` : `${base}${h >= n ? ' ✓' : ''}`;
  }

  _hud(force) {
    const id = this.tracked; const g = this.game;
    if (!id || !this.active.has(id)) { if (this._hudKey) { this._hudKey = ''; g.hud?.setQuest?.('', null); try { clearWaypoint(); } catch (e) {} } return; }
    const q = BY_ID[id], c = this.active.get(id);
    const objs = q.objectives.map((o, i) => {
      const text = this._line(o, c[i]), done = (c[i] | 0) >= need(o);
      // have/need are what the HUD turns into a counter chip — reach/escort deliberately ship without
      // them, so the tracker shows "Reach the Glacier Throne — 240 m" and never "0 / 1".
      return H[o.type]?.counter === false
        ? { type: o.type, text, done, toString: () => text }
        : { type: o.type, text, have: Math.min(need(o), c[i] | 0), need: need(o), done, toString: () => text };
    });
    // the other open quests, so a six-quest log is not invisible behind the one tracked line
    const others = []; for (const k of this.active.keys()) if (k !== id) others.push(BY_ID[k].name);
    const key = id + ':' + objs.map((o) => o.text).join('|') + ':' + others.join('|');
    if (key === this._hudKey && !force) return;
    this._hudKey = key;
    g.hud?.setQuest?.(q.name, objs, others);
    const nx = q.objectives.findIndex((o, i) => c[i] < need(o));
    const a = nx >= 0 ? H[q.objectives[nx].type]?.at?.(q.objectives[nx]) : anchor(q.region);
    if (a) { try { setWaypoint(null, a); } catch (e) {} }
  }

  // ---------------------------------------------------------------- automation (scalars only)
  /** the whole catalogue, for the mechanics gate to pick one representative quest per objective type */
  all() {
    return QUESTS.map((q) => ({ id: q.id, name: q.name, region: q.region, level: q.level, types: [...new Set(q.objectives.map((o) => o.type))] }));
  }

  /** debug: advance every unfinished objective of an ACTIVE quest by one step. No-op if it is not active. */
  debugTick(id) {
    const c = this.active.get(id); if (!c) return false;
    const q = BY_ID[id];
    for (let i = 0; i < q.objectives.length; i++) {
      if (c[i] >= need(q.objectives[i])) continue;
      this._bump(id, c, i, 1);
      if (!this.active.has(id)) break;         // the last bump turned it in — `c` is no longer live
    }
    return true;
  }

  state() {
    const active = [];
    for (const [id, c] of this.active) {
      const q = BY_ID[id];
      active.push({
        id, name: q.name, region: q.region, level: q.level, tracked: id === this.tracked, ready: this._ready(id),
        objectives: q.objectives.map((o, i) => {
          const ob = { type: o.type, text: this._line(o, c[i]), have: Math.min(need(o), c[i] | 0), need: need(o), done: (c[i] | 0) >= need(o) };
          if (o.type === 'escort') ob.guide = !this._canEscort() ? 'unavailable' : this._guides.has(id + '#' + i) ? 'alive' : 'waiting';
          if (o.type === 'slay') ob.elite = !this._canElite() ? 'unavailable' : this._elites.has(id + '#' + i) ? 'alive' : 'waiting';
          return ob;
        }),
        xp: q.reward?.xp ?? 0,
        // the pre-rolled reward candidates. Plain JSON items (items.js guarantees it), never a live
        // game object — the quest log reads them straight out of here to render the choice.
        choices: this.rewards(id),
      });
    }
    return {
      active, completed: [...this.done], tracked: this.tracked ?? '', region: this._region ?? '',
      total: QUESTS.length, pending: this.pendingClaim(),
    };
  }
}

// RPG.js still imports the old name; keep it resolving so the wiring change is optional, not required.
export { Quests as OpeningQuest };
