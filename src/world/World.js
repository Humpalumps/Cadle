import { Water } from './Water.js';
import { Grass } from './Grass.js';
import { Vegetation } from './Vegetation.js';
import { Props } from './Props.js';
import { Colliders } from './Colliders.js';

/**
 * World: container for the environment sub-systems. Each sub-system is its own file/owner.
 * Order: colliders (registry) -> water -> grass -> vegetation -> props.
 * Exposes: game.world.water / grass / vegetation / props / colliders
 */
export class World {
  constructor(game) {
    this.game = game;
    this.colliders = new Colliders(game);
    this.water = new Water(game);
    this.grass = new Grass(game);
    this.vegetation = new Vegetation(game);
    this.props = new Props(game);
    this.parts = [this.colliders, this.water, this.grass, this.vegetation, this.props];
  }
  // A frame between parts. These five (colliders, water, grass, vegetation, props) are long synchronous
  // builds and together they were one 3.9 s freeze on the loading screen — the single worst block of the
  // world boot. Game._init already yields between SYSTEMS; this is the same trick one level down, and it
  // costs ~4 frames of wall clock to stop the intro locking up.
  async init() {
    // Sub-progress, not just a yield. Yielding alone gave the intro frames to paint, but it repainted an
    // IDENTICAL bar: boot:progress fires once per SYSTEM, so the bar sat frozen at 68.8% for the whole
    // ~6.4 s of this build while hitching a dozen times. A frozen bar reads as a hang no matter how short
    // the individual blocks are. Reporting a fraction of this system's own slot keeps the line climbing.
    const g = this.game, idx = g.systems ? g.systems.indexOf(this) : -1;
    for (let k = 0; k < this.parts.length; k++) {
      await this.parts[k].init?.(g);
      if (idx >= 0) g.events.emit('boot:progress', { done: idx + (k + 1) / this.parts.length, total: g.systems.length, system: 'World' });
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
  update(dt, t) { for (const p of this.parts) p.update?.(dt, t); }
  resize(w, h) { for (const p of this.parts) p.resize?.(w, h); }
}
