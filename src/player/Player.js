import * as THREE from 'three';
import { PlayerController } from './PlayerController.js';
import { PlayerCamera } from './PlayerCamera.js';
import { Weapons } from './Weapons.js';
import { Abilities } from './Abilities.js';

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
    this.shield = 100; this.maxShield = 100;
    this.alive = true;
    this.level = 1;
    this.lastHit = -99;
    // combat target (enemies damage the player through game.combat)
    this.target = { kind: 'player', team: 'player', position: new THREE.Vector3(), radius: 0.45, height: 1.8, alive: true, object: null,
      takeDamage: (info) => this.damage(info.amount, info.owner, info) };
  }
  get position() { return this.controller.position; }
  get eye() { return this.view.eye; }
  get yaw() { return this.view.yaw; }
  get pitch() { return this.view.pitch; }
  async init() { for (const p of this.parts) await p.init?.(this.game); this.game.combat.register(this.target); }
  update(dt, t) {
    for (const p of this.parts) p.update?.(dt, t);
    const pos = this.controller.position;
    this.target.position.set(pos.x, pos.y + 0.9, pos.z); this.target.alive = this.alive;
    // Destiny-style recovery: shield then health regen after 4s out of combat
    if (this.alive && t - this.lastHit > 4) {
      if (this.shield < this.maxShield) this.shield = Math.min(this.maxShield, this.shield + dt * this.maxShield / 2.5);
      else if (this.health < this.maxHealth) this.health = Math.min(this.maxHealth, this.health + dt * this.maxHealth / 4);
    }
  }
  resize(w, h) { for (const p of this.parts) p.resize?.(w, h); }
  damage(amount, source, info) {
    if (!this.alive || amount <= 0 || this.god) return;
    const total = amount; // incoming damage before shield — flinch/flash scale on the hit, not the hp loss
    const s = Math.min(this.shield, amount); this.shield -= s; amount -= s;
    this.health = Math.max(0, this.health - amount);
    this.lastHit = this.game.time;
    this.game.events.emit('player:damaged', { amount: total, hpLoss: amount, shieldLoss: s, source, info });
    if (this.health <= 0) { this.alive = false; this.game.events.emit('player:died', { source }); }
  }
  respawn(pos) { this.health = this.maxHealth; this.shield = this.maxShield; this.alive = true; if (pos) this.controller.teleport(pos); this.game.events.emit('player:respawn'); }
}
