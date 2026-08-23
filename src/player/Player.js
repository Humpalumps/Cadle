import * as THREE from 'three';
import { PlayerController } from './PlayerController.js';
import { PlayerCamera } from './PlayerCamera.js';
import { Weapons } from './Weapons.js';
import { Abilities } from './Abilities.js';
import { BIOMES } from '../world/Biomes.js';

/**
 * Player: container for the first-person player. Sub-systems (each its own file/owner):
 *   controller (movement/physics)  -> game.player.controller   position/velocity/grounded/state
 *   view (camera: look, fov, bob, shake, recoil) -> game.player.view
 *   weapons (viewmodel, firing, ammo)  -> game.player.weapons
 *   abilities (grenade, melee, class, super) -> game.player.abilities
 * Shared player state lives here: health/shields/stats (read by HUD, combat).
 * Exposes: game.player.position (Vector3, feet), game.player.eye (Vector3, camera pos), game.player.yaw/pitch
 */
export class Player {
  constructor(game) {
    this.game = game;
    this.controller = new PlayerController(game, this);
    this.view = new PlayerCamera(game, this);
    this.weapons = new Weapons(game, this);
    this.abilities = new Abilities(game, this);
    this.parts = [this.controller, this.view, this.weapons, this.abilities];
    this.health = 100; this.maxHealth = 100;
    // shield removed (user decision 2026-08-20): health-only, WoW-style regen — a small trickle
    // always, fast recovery once out of combat for a few seconds. Kept as inert 0s so older
    // readers (HUD ghosts, rpg sheet) never see undefined.
    this.shield = 0; this.maxShield = 0;
    this.alive = true;
    this.level = 1;
    this.lastHit = -99; this.lastCombat = -99;
    // combat target (enemies damage the player through game.combat)
    this.target = { kind: 'player', team: 'player', position: new THREE.Vector3(), radius: 0.45, height: 1.8, alive: true, object: null,
      takeDamage: (info) => this.damage(info.amount, info.owner, info) };
  }
  get position() { return this.controller.position; }
  get eye() { return this.view.eye; }
  get yaw() { return this.view.yaw; }
  get pitch() { return this.view.pitch; }
  async init() {
    // A frame between parts, same as World.init: these build the viewmodels and ability rigs and ran as
    // one 3.4 s synchronous block, which the loading screen cannot paint through.
    const g = this.game, idx = g.systems ? g.systems.indexOf(this) : -1;
    for (let k = 0; k < this.parts.length; k++) {
      await this.parts[k].init?.(g);
      if (idx >= 0) g.events.emit('boot:progress', { done: idx + (k + 1) / this.parts.length, total: g.systems.length, system: 'Player' });
      await new Promise((r) => requestAnimationFrame(r));
    }
    this.game.combat.register(this.target);
    this.game.events.on('combat:hit', (e) => { if (e?.owner === this || e?.owner === this.target || e?.team === 'player') this.lastCombat = this.game.time; });
  }
  update(dt, t) {
    for (const p of this.parts) p.update?.(dt, t);
    const pos = this.controller.position;
    this.target.position.set(pos.x, pos.y + 0.9, pos.z); this.target.alive = this.alive;
    // Lava burns. The Infernal channels are the world's water surface wearing a molten skin, so "am I in
    // lava" is "am I in water, in a region flagged lava" — one biome lookup, no second physics volume.
    if (this.alive) {
      const c = this.controller, T = this.game.terrain, W = this.game.world?.water;
      if (W && c.position.y < W.level + 0.6 && (c.wading || c.swimming)) {
        const b = T?.biomeBlend?.(c.position.x, c.position.z, this._lb ??= {});
        if (b && b.w > 0.3 && BIOMES[b.id]?.lava) {
          this.damage(dt * 26, null, { element: 'solar', source: 'lava' });
          if (t - (this._lavaFx ?? 0) > 0.45) {
            this._lavaFx = t;
            this.game.postfx?.flash?.(0xff4a10, 0.35, 0.35);
            // 'aether-burst' is the STAR-textured magic pop: recoloured orange it read as bright star flares
            // coming off the player, which is a spell effect, not standing in lava. Embers instead.
            this.game.vfx?.emit?.('sparks', c.position, { color: 0xff6a14, count: 10, scale: 0.6 });
            this.game.audio?.play?.('explosion', { pos: c.position, vol: 0.25 });
          }
        }
      }
    }
    // BREATH. The Sunken Kingdom's passive is that past the shelf the sea is over your head; without a
    // clock on it, "swim down and look" has no stakes and no reason to come back up. 22 s under, then it
    // starts costing health; a lungful comes back fast at the surface.
    {
      const c = this.controller, W = this.game.world?.water;
      const head = c.position.y + 1.5;
      const under = W?.level != null && head < W.level && (W.isWater?.(c.position.x, c.position.z) ?? true);
      this.maxBreath = 22;
      this.breath = this.breath == null ? this.maxBreath : this.breath;
      if (under && this.alive) {
        this.breath = Math.max(0, this.breath - dt);
        if (this.breath <= 0) this.damage(dt * 14, null, { element: 'void', source: 'drowning' });
      } else this.breath = Math.min(this.maxBreath, this.breath + dt * 6);
      this.submerged = under;
    }
    // WoW-style recovery: ~1%/s trickle in combat, ~9%/s once out of combat for 6 s
    // (taking OR dealing damage counts as combat — weapons/abilities stamp lastCombat too)
    if (this.alive && this.health < this.maxHealth) {
      const rate = (t - Math.max(this.lastHit, this.lastCombat) > 6) ? 0.09 : 0.01;
      this.health = Math.min(this.maxHealth, this.health + dt * this.maxHealth * rate);
    }
  }
  resize(w, h) { for (const p of this.parts) p.resize?.(w, h); }
  damage(amount, source, info) {
    if (!this.alive || amount <= 0 || this.god) return;
    this.health = Math.max(0, this.health - amount);
    this.lastHit = this.game.time;
    this.game.events.emit('player:damaged', { amount, hpLoss: amount, shieldLoss: 0, source, info });
    if (this.health <= 0) { this.alive = false; this.game.events.emit('player:died', { source }); }
  }
  respawn(pos) { this.health = this.maxHealth; this.alive = true; if (pos) this.controller.teleport(pos); this.game.events.emit('player:respawn'); }
}
