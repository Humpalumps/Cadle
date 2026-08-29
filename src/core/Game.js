import * as THREE from 'three';
import { Input } from './Input.js';
import { events } from './Events.js';
import { Perf } from './Perf.js';
import { Assets } from './Assets.js';
import { createRenderer } from '../render/Renderer.js';
import { Sky } from '../render/Sky.js';
import { Lighting } from '../render/Lighting.js';
import { PostFX } from '../render/PostFX.js';
import { Terrain } from '../world/Terrain.js';
import { World } from '../world/World.js';
import { Player } from '../player/Player.js';
import { Enemies } from '../enemies/Enemies.js';
import { Combat } from '../combat/Combat.js';
import { VFX } from '../vfx/VFX.js';
import { Audio } from '../audio/Audio.js';
import { HUD } from '../ui/HUD.js';
import { RPG } from '../rpg/RPG.js';

/**
 * Game: owns renderer/scene/camera, the system list, and the frame loop.
 * Systems are plain objects with optional: init(game) (may be async), update(dt, t), resize(w,h), dispose().
 * Update order (fixed): sky, lighting, terrain, world, player, combat, enemies, vfx, audio, rpg, hud, postfx.
 * PostFX.render(dt) draws the frame.
 */
export class Game {
  /** opts.renderer: an already-created WebGLRenderer to adopt. main.js builds the renderer up front so
   *  the intro loading screen can paint with it before this module has even been downloaded — Game's
   *  import graph is the whole game, and waiting for it is what used to leave the page dark for seconds. */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.params = new URLSearchParams(location.search);
    this.auto = this.params.get('auto') === '1';      // automation harness: no click-to-start, synthetic input allowed
    // ultra removed (2026-08-21): high IS the top preset. opts.quality is what main.js already built the
    // renderer with (?q= if given, else the menu's saved preset) — taking it here keeps the two in step.
    this.quality = opts.quality || (['low', 'medium', 'high'].includes(this.params.get('q')) ? this.params.get('q') : 'high');
    this.seed = Number(this.params.get('seed') || 1337);
    this.debug = this.params.get('debug') === '1';

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(95, 1, 0.05, 4000);
    this.camera.rotation.order = 'YXZ';
    this.renderer = opts.renderer || createRenderer(canvas, this.quality);
    this.input = new Input(canvas);
    if (this.auto) this.input.synthetic = true;
    this.events = events;
    this.clock = new THREE.Clock();
    this.time = 0;          // game seconds since start
    this.paused = false;
    this.perf = new Perf();

    // Core systems, fixed order. Each is owned by one module (see CLAUDE.md).
    this.assets = new Assets(this);   // first: preloads public/assets/* so every other init() can use game.assets
    this.sky = new Sky(this);
    this.lighting = new Lighting(this);
    this.terrain = new Terrain(this);
    this.world = new World(this);
    this.player = new Player(this);
    this.combat = new Combat(this);
    this.enemies = new Enemies(this);
    this.vfx = new VFX(this);
    this.audio = new Audio(this);
    this.rpg = new RPG(this);
    this.hud = new HUD(this);
    this.postfx = new PostFX(this);
    this.systems = [this.assets, this.sky, this.lighting, this.terrain, this.world, this.player, this.combat, this.enemies, this.vfx, this.audio, this.rpg, this.hud, this.postfx];
    this.ready = this._init();
  }

  addSystem(sys, before = null) {
    const i = before ? this.systems.indexOf(before) : -1;
    if (i >= 0) this.systems.splice(i, 0, sys); else this.systems.push(sys);
    const r = sys.init?.(this);
    return r instanceof Promise ? r.then(() => sys) : sys;
  }
  removeSystem(sys) { const i = this.systems.indexOf(sys); if (i >= 0) this.systems.splice(i, 1); sys.dispose?.(); }

  async _init() {
    // yield a frame between systems: terrain/grass/vegetation builds are long synchronous blocks, and the
    // loading screen (src/ui/Menu.js) is animating on the same thread. Costs ~1 frame per system.
    const bootT = [];                                  // ?debug=1 prints how long each system BLOCKED for
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i];
      const t0 = performance.now();
      await s.init?.(this);
      bootT.push([s.constructor.name, Math.round(performance.now() - t0)]);
      // loading screens need to know about the WORLD build, not just the asset download (which is the
      // first system and only ~half the wall time). 'boot:progress' is what the intro's bar rides on.
      this.events.emit('boot:progress', { done: i + 1, total: this.systems.length, system: s.constructor.name });
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (this.debug) console.info('[boot] per-system ms:', JSON.stringify(Object.fromEntries(bootT)));
    this._onResize();
    window.addEventListener('resize', () => this._onResize());
    this.events.emit('ready', this);
    return this;
  }

  _onResize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    for (const s of this.systems) s.resize?.(w, h);
  }

  start() {
    if (this._running) return; this._running = true;
    const loop = () => { this._raf = requestAnimationFrame(loop); this.frame(); };
    loop();
  }
  stop() { this._running = false; cancelAnimationFrame(this._raf); }

  /** Advance the simulation one step and draw the world into `target` (no post-processing).
   *  Used by the intro loading screen to put the LIVE game on the character's monitor before the game
   *  itself owns the canvas. Not part of the normal loop. Pass `systems` to step only part of the world —
   *  the intro leaves rpg/audio/hud/enemies/combat alone so the opening quest does not play to nobody.
   *  Pass `camera` to draw the same world through a different lens — the intro uses a narrower one so the
   *  monitor is not showing a 95-degree gameplay FOV squeezed into a small render target. */
  stepInto(dt, target, systems = this.systems, camera = this.camera) {
    this.time += dt;
    for (const s of systems) s.update?.(dt, this.time);
    this.input.endFrame();
    const r = this.renderer, tm = r.toneMapping;
    r.toneMapping = THREE.ACESFilmicToneMapping;      // the composer normally does this; here we draw direct
    r.setRenderTarget(target);
    r.clear();
    r.render(this.scene, camera);
    r.setRenderTarget(null);
    r.toneMapping = tm;
  }

  frame() {
    const raw = this.clock.getDelta();
    const dt = Math.min(raw, 1 / 20); // clamp: no tunneling after a hitch/tab switch
    this.time += dt;
    this.perf.begin();
    if (!this.paused) {
      const prof = this.perf.systems;
      for (const s of this.systems) {
        const t0 = performance.now(); s.update?.(dt, this.time);
        const k = s.constructor.name; prof[k] = (prof[k] ?? 0) * 0.95 + (performance.now() - t0) * 0.05; // EMA per system (CPU ms)
      }
    }
    const tr = performance.now(); this.postfx.render(dt);
    this.perf.systems.render = (this.perf.systems.render ?? 0) * 0.95 + (performance.now() - tr) * 0.05;
    this.input.endFrame();
    this.perf.end(this.renderer);
  }
}
