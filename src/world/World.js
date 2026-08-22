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
    for (const p of this.parts) {
      await p.init?.(this.game);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }
  update(dt, t) { for (const p of this.parts) p.update?.(dt, t); }
  resize(w, h) { for (const p of this.parts) p.resize?.(w, h); }
}
