/**
 * RPG: loot drops + pickup, inventory/equipment, levels + skill tree, save/load, and the
 * full-screen map/character/inventory/skills overlays (M / C / I / K).
 *
 * The item/loot/progression modules and the screen renderers are ported from the sibling
 * FPS (Aurelen) project and were written against its `ctx` surface — this file builds that
 * ctx as a thin adapter over the Cadle `game` object, so the ported files stay close
 * to their source. Adapt HERE, not in the ported files.
 *
 * API: game.rpg.ctx.rpg.* (full ported surface), game.rpg.screens, and mirrors:
 *   game.rpg.addXp(n), .dropLoot(pos, tier?), .pickup(), .equip(itemOrId), .stats
 * Hooks: 'enemy:death' -> xp + drop rolls; combat.hitscan/explode player damage × gear multiplier;
 *   player maxHealth/maxShield/shield-regen follow armour + level (progression.derive).
 */
import * as prog from './progression.js';
import * as loot from './loot.js';
import * as save from './save.js';
import { RARITY, TIERS, ARMOUR_SETS, ELEMENTS, CONSUMABLES, EXOTICS, EXOTIC_ARMOUR, describe, shortLabel, ARMOUR_SLOTS } from './items.js';
import { reserveNames } from './names.js';
import { Screens } from '../ui/Screens.js';
import { OpeningQuest } from './quest.js';

const AR_LABEL = { handcannon: 'Hand Cannon', autorifle: 'Auto Rifle', pulse: 'Pulse Rifle', shotgun: 'Shotgun', sniper: 'Sniper Rifle', fusion: 'Fusion Rifle' };

// world layout from CLAUDE.md — the map's landmark set
const LANDMARKS = [
  { name: 'Aetheryte Plaza', position: { x: 0, z: -28 } },
  { name: 'Mirrormere', position: { x: -170, z: -70 } },
  { name: 'The Sundered Spire', position: { x: 140, z: 60 } },
  { name: 'Whisperwood', position: { x: 0, z: -220 } },
  { name: 'The Crystal Fields', position: { x: 250, z: 30 } },
  { name: 'The Hollow Crown', position: { x: -60, z: 260 } },
];

export class RPG {
  constructor(game) { this.game = game; this._dirty = false; this._nextSave = 0; this._promptWas = false; }

  init() {
    const g = this.game;
    const self = this;

    // ---------- ctx adapter (the surface the ported modules expect) ----------
    const player = {
      get position() { return g.player.position; },
      get velocity() { return g.player.controller?.velocity; },
      get grounded() { return g.player.controller?.grounded ?? true; },
      get yaw() { return g.player.view?.yaw ?? 0; },
      get dead() { return !g.player.alive; },
      set dead(v) { if (!v && !g.player.alive) g.player.respawn?.(); },
      get health() { return g.player.health; }, set health(v) { g.player.health = v; },
      get shield() { return g.player.shield; }, set shield(v) { g.player.shield = v; },
      get maxHealth() { return g.player.maxHealth; }, set maxHealth(v) { g.player.maxHealth = v; },
      get maxShield() { return g.player.maxShield; }, set maxShield(v) { g.player.maxShield = v; },
      set moveSpeedMul(v) { if (g.player.controller) g.player.controller.moveSpeedMul = v; }, // advisory: controller may not read it
      set jumpMul(v) { if (g.player.controller) g.player.controller.jumpMul = v; },
      get fovBoost() { return 0; }, set fovBoost(v) {},
      get shake() { return 0; }, set shake(v) { g.player.view?.addShake?.(v); },
      tune: null,   // Cadle's controller owns traversal tuning; ported applyTuning() no-ops on null
    };
    const KEYMAP = { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD' };
    const input = {
      get locked() { return g.input.active; },
      hit: (c) => g.input.justPressed(c),
      actionHit: (a) => a === 'interact' ? g.input.justPressed('KeyE') : a === 'sprint' ? g.input.justPressed('ShiftLeft') : false,
      action: (a) => KEYMAP[a] ? g.input.down(KEYMAP[a]) : false,
    };
    const hud = {
      toast: (t, o) => g.hud?.toast?.(t, o),
      prompt: (t) => { self._promptSet = true; g.hud?.prompt?.(t); },
    };
    const world = {
      get size() { return g.terrain?.size ?? 1024; },
      get waterLevel() { return g.terrain?.waterLevel ?? 0; },
      heightAt: (x, z) => g.terrain?.heightAt?.(x, z) ?? 0,
      landmarks: LANDMARKS,
    };
    const ai = { get enemies() { return (g.enemies?.all ?? []).filter((e) => e.alive); } };
    // the armoury the loot rolls against: real Cadle weapon defs, so an equipped roll
    // always names a gun that exists ("nothing here may name a gun that does not exist")
    const defs = g.player?.weapons?.defs ?? {};
    const archetypes = Object.keys(AR_LABEL).filter((id) => defs[id]).map((id) => ({
      id, label: AR_LABEL[id],
      damage: defs[id].damage, rpm: defs[id].rpm, mag: defs[id].magSize,
      range: defs[id].range ?? 60, stability: 60, handling: 60,
    }));
    const weapon = { archetypes };
    const combat = {
      weapons: archetypes,
      // equipping a rolled weapon hands you that gun WITH the roll's numbers on it: damage, rpm,
      // magazine, crit and reload come from the item, so two drops of the same archetype feel
      // different in the hands (the "loot matters" contract). weaponMul stays 1 — stats are
      // applied directly instead of as a hidden multiplier, so the HUD ammo/sheet agree.
      equip: (i) => {
        const a = archetypes[i]; if (!a) return;
        const w = g.player.weapons?.give?.(a.id);
        const roll = ctx.weapon.roll;
        if (w && roll && roll.archetype === a.id) {
          w.damage = roll.damage;
          w.rpm = roll.rpm;
          w.magSize = Math.max(1, Math.round(roll.mag));
          if (w.ammo > w.magSize) w.ammo = w.magSize;
          w.critMult = roll.critMul ?? w.critMult;
          if (w.def?.reloadTime) w.reloadTime = +(w.def.reloadTime * (1 - Math.min(0.4, (roll.item?.stats?.reload ?? 0) / 100))).toFixed(2);
          ctx.rpg.weaponMul = 1;
        }
      },
    };
    const ctx = this.ctx = {
      events: g.events, scene: g.scene,
      get time() { return g.time; },
      player, input, hud, world, ai, weapon, combat, rpg: {},
    };

    // ---------- compose the ported surface (mirrors the source project's rpg/index.js) ----------
    const R = ctx.rpg;
    R.stats = {};
    R.addXp = (n) => prog.addXp(ctx, n);
    R.equip = (item) => prog.equip(ctx, item);
    R.dropLoot = (position, tier, opts) => loot.dropLoot(ctx, position, tier, opts);
    R.rollTier = (luck) => loot.rollTier(luck != null ? luck : (R.stats.luck || 0));
    R.pickup = (d) => loot.pickupNearest(ctx, d);
    R.activeDrops = loot.activeDrops; R.clearDrops = loot.clearDrops; R.lootCounts = loot.counts; R.pity = loot.pity;
    R.skillTree = prog.skillTree;
    R.spendPoint = (id) => prog.spendPoint(ctx, id);
    R.upgrade = (id) => prog.upgrade(ctx, id);
    R.infuse = (t, s) => prog.infuse(ctx, t, s);
    R.use = (id) => prog.useConsumable(ctx, id);
    R.dismantle = (id) => prog.dismantle(ctx, id);
    R.xpToNext = prog.xpToNext; R.maxLevel = prog.MAX_LEVEL;
    R.describe = describe; R.label = shortLabel;
    R.data = { RARITY, TIERS, ARMOUR_SETS, ELEMENTS, CONSUMABLES, EXOTICS, EXOTIC_ARMOUR, SKILLS: prog.SKILLS };
    R.landmarks = LANDMARKS;
    R.save = () => { this._dirty = false; return save.write({ p: prog.serialize() }); };
    R.wipe = () => { save.wipe(); return true; };

    prog.init(ctx);
    loot.init(ctx);

    // ---------- load ----------
    const d = save.read();
    let loaded = false;
    if (d) {
      try { prog.deserialize(ctx, d.p); loaded = true; }
      catch (e) { console.warn('[rpg] save rejected, starting fresh:', e?.message); }
    }
    if (loaded) {
      const eq = prog.state.equipped;
      reserveNames([...prog.state.inventory, eq.weapon, ...ARMOUR_SLOTS.map((s) => eq[s])].filter(Boolean).map((x) => x.name));
    }
    if (!loaded || !prog.state.equipped.weapon) ctx.rpg._giveStarter();
    prog.refresh(ctx);

    // ---------- hooks into the rest of the game ----------
    g.events.on('enemy:death', (e) => { R.addXp(e?.enemy?.def?.xp ?? 10); });
    // player-outgoing damage rides gear quality: wrap the two combat entry points once
    const mul = () => (R.stats.damageMul || 1) * (R.weaponMul || 1);
    for (const fn of ['hitscan', 'explode']) {
      const orig = g.combat?.[fn]?.bind(g.combat);
      if (orig) g.combat[fn] = (o) => orig(o && o.team !== 'enemy' && typeof o.damage === 'number' ? { ...o, damage: o.damage * mul() } : o);
    }
    // HUD level chip reads player.level
    const mirror = () => { g.player.level = R.level; };
    g.events.on('rpg:levelup', mirror); mirror();
    for (const ev of ['rpg:levelup', 'loot:picked', 'rpg:skill', 'rpg:equipped', 'rpg:currency']) {
      g.events.on(ev, () => { this._dirty = true; });
    }
    const flush = () => { if (this._dirty) R.save(); };
    addEventListener('beforeunload', flush);
    addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

    // ---------- convenience mirrors on game.rpg ----------
    this.stats = R.stats;
    this.addXp = R.addXp; this.dropLoot = R.dropLoot; this.pickup = R.pickup; this.equip = R.equip;

    this.screens = new Screens(g, ctx);
    this.quest = new OpeningQuest(g, R);
    this.quest.init();
  }

  update(dt, t) {
    const ctx = this.ctx; if (!ctx) return;
    this._promptSet = false;
    prog.update(ctx, dt);
    loot.update(ctx, dt);
    // the loot prompt is re-asserted every frame it applies; clear the HUD line when it stops
    if (!this._promptSet && this._promptWas) this.game.hud?.prompt?.(null);
    this._promptWas = this._promptSet;
    this.screens.frame(dt);
    this.quest.update(dt, this.game.time);
    if (this._dirty && this.game.time > this._nextSave) { this._nextSave = this.game.time + 6; this.ctx.rpg.save(); }
  }
}
