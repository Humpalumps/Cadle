import * as THREE from 'three';
import { ParticlePool } from './Particles.js';
import { Brush } from './Brush.js';
import { Tracers, Decals, Sigils } from './Extras.js';
import { Filaments } from './Filaments.js';
import { makeAtlas, makeDecals, makeSigil, TEX } from './Textures.js';
import { BIOMES } from '../world/Biomes.js';
import { mulberry32 } from '../core/Noise.js';

/**
 * VFX: GPU/instanced particle system + decals + tracers + beams + light flashes. FF14 flavor: aether sparkles,
 * glowing sigils/rings, soft additive wisps; Destiny flavor: crisp muzzle flashes, sparks, impact dust, tracers.
 *
 * API (all pooled, zero per-frame allocation, few draw calls total):
 *   vfx.emit(preset, position, opts?)            burst of particles.   presets (minimum): 'muzzle','impact-terrain','impact-rock',
 *        'impact-enemy','sparks','dust','explosion','aether-burst','death','ring','sigil','heal','spark-trail','jump','land','slide','levelup','pickup'
 *        extra: 'impact-prop' (=rock), 'impact-water', 'trail' (projectile trail, for attach), 'aura' (orbiting motes), 'charge' (converging motes),
 *               'heal-motes', 'flash' (glow pop), 'blood' (= impact-enemy)
 *        opts: { dir:Vector3, normal:Vector3, count, color:Color|hex, scale, speed, spread, element, crit, radius, duration }
 *   vfx.tracer(from, to, { color, width=0.05, duration=0.1, element, speed=320, len=7, hdr }) — hdr/width auto-boost with daylight
 *   vfx.beam(from, to, { color, width, duration })            persistent-ish line (fusion/lasers)
 *   vfx.decal(point, normal, { type:'bullet'|'scorch'|'sigil', size })   (capped pool 200, oldest recycled)
 *   vfx.flash(position, { color, intensity=3, distance=8, duration=0.06 })   pooled PointLight flash (max 4 live; 2 on q=low)
 *   vfx.attach(preset, object3d|{position[,velocity,alive]}|Vector3, opts{ rate, duration, until:()=>bool, offset:Vector3, color, element, scale }) -> handle { stop() }
 *   vfx.shockwave(position, { radius, color, duration, normal })
 *   vfx.sigil(position, { normal, color, size, duration })    rotating rune ring mesh
 *   vfx.showcase()   emits every preset in a row in front of the camera (critics / harness);  vfx.stats() -> live counts;  vfx.clear()
 *   vfx.stress(n=5000)   perf validation: n long-lived (8-12 s) particles in a cloud ahead of the camera (then measure a perf window)
 *   ambient (automatic, no API): per-region weather (_weather) + infernal smoke story (_ambient: fumarole
 *   plumes, the Cinder Maw ember column, lava-bank embers) — pooled, distance-gated, deterministic placement
 *
 * Listens (so other systems don't have to call vfx directly):
 *   'combat:hit' -> impact-enemy sparks at point (+ crit variant), 'combat:impact' -> impact-<surface> + decal,
 *   'combat:explosion' -> explosion + shockwave + flash + scorch decal, 'combat:kill'/'enemy:death' -> death dissolve burst (deduped),
 *   'player:land' (impact>8 -> dust), 'player:slide' -> dust trail while sliding,
 *   'player:jump' (2nd jump -> aether puff)
 *
 * Colors per element: kinetic #ffe9c4, solar #ff8a3d, arc #7fd8ff, void #b070ff, stasis #9fd8ff, strand #7cff9c
 * Draw calls: alpha pool 1 + additive pool 1 + tracers 1 + decals 1 + sigils 1 (instanced pool of 6) — all frustumCulled=false, hidden when empty.
 */
export const ELEMENT_COLORS = { kinetic: 0xffe9c4, solar: 0xff8a3d, arc: 0x7fd8ff, void: 0xb070ff, stasis: 0x9fd8ff, strand: 0x7cff9c };
const AETHER = 0x9f7bff, GOLD = 0xffd27a, DUST = 0x857458, DIRT = 0x4a3a28;
const QMUL = { low: 0.5, medium: 0.75, high: 1 };
const EMIT_RATE = { trail: 90, 'spark-trail': 70, slide: 45, aura: 30, charge: 40, 'heal-motes': 22, dust: 6, sparks: 8, 'exp-smoke': 11 };

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _c = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color();
const NOPTS = {};

export class VFX {
  constructor(game) {
    this.game = game; this.brush = new Brush(); this.emitters = []; this._dead = new WeakMap(); this.lights = []; this._lit = [1, 1, 1];
    this.mult = QMUL[game.quality] ?? 1; this.day = 1; // 0 night .. 1 full daylight; boosts gun-feedback HDR/size so it reads at noon
  }
  async init() {
    const { scene, seed } = this.game;
    // The three atlas bakes are canvas work and the pools below allocate big buffers; as one block this
    // was ~1.7 s of frozen loading screen. Game._init awaits init(), so yielding here is free.
    const atlas = this.atlas = makeAtlas(seed);
    await new Promise((r) => requestAnimationFrame(r));
    this.decalAtlas = makeDecals(seed);
    await new Promise((r) => requestAnimationFrame(r));
    this.sigilTex = makeSigil(seed);
    await new Promise((r) => requestAnimationFrame(r));
    const cap = Math.round(this.mult * 16384);
    this.add = new ParticlePool(scene, atlas, { capacity: cap, additive: true, renderOrder: 11 });
    this.alpha = new ParticlePool(scene, atlas, { capacity: Math.round(cap * 0.3), additive: false, renderOrder: 10 });
    this.tracers = new Tracers(scene, 256);
    this.decals = new Decals(scene, this.decalAtlas, this.mult < 1 ? 100 : 200);
    this.sigils = new Sigils(scene, this.sigilTex, 6);
    // GPU ribbon filaments (flame trails, breath plumes, bolts): every live strand in ONE instanced draw pair
    this.filaments = new Filaments(scene, this.mult < 0.75 ? 48 : 96);
    // pooled flash lights: always in the scene (intensity 0) so shader programs never recompile on light count changes
    const nl = this.mult < 0.75 ? 2 : 4;
    for (let i = 0; i < nl; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 2); l.castShadow = false; l.position.set(0, -1000, 0); l.name = 'vfx-flash';
      scene.add(l); this.lights.push({ light: l, t: 1, dur: 1, i0: 0 });
    }
    for (let i = 0; i < 48; i++) this.emitters.push({ live: false, preset: '', obj: null, opts: null, pos: new THREE.Vector3(), prev: new THREE.Vector3(), dir: new THREE.Vector3(), acc: 0, t: 0, rate: 30, handle: null });
    this._anchors = []; this._ai = 0; for (let i = 0; i < 48; i++) this._anchors.push(new THREE.Vector3()); // pooled static positions for attach() (event vectors get reused by combat; 48 = emitter pool size)
    this._bind();
  }

  // ------------------------------------------------------------------ frame
  /**
   * Regional weather. One emitter that follows the camera and spawns whatever falls (or rises) in the
   * region the player is standing in — snow in Frostveil, ash over the Wastes, rain in the fen, motes in
   * the Void and over the Isles. Particles are spawned in a box AROUND the camera and given the fall
   * velocity directly, so there is no simulation to own and no cost anywhere the region is quiet.
   * Budget: <= ~40 live particles, one burst every 1/RATE s, inside the existing pooled systems.
   */
  _weather(dt) {
    const T = this.game.terrain, cam = this.game.camera;
    const b = T?.biomeBlend?.(cam.position.x, cam.position.z, this._wb ??= {});
    const W = b && b.w > 0.25 ? WEATHER[b.id] : null;
    if (!W) { this._wT = 0; return; }
    this._wT = (this._wT ?? 0) + dt * W.rate * b.w;
    if (this._wT < 1) return;
    const n = Math.min(6, Math.floor(this._wT)); this._wT -= n;
    const p = this._wp ??= new THREE.Vector3();
    p.copy(cam.position); p.y += W.up;
    const B = this.brush;
    B.reset(W.add ? this.add : this.alpha, p)
      .jitter(0)
      .axisUp().spread(0)
      .speed(0, 0).life(W.life[0], W.life[1])
      .size(W.size[0], W.size[1], W.grow ?? 1)
      .tex(W.tex).color(W.c0, W.c1).hdr(W.hdr, W.hdr * 0.6).alpha(W.alpha)
      .vel(W.vel[0], W.vel[1], W.vel[2]).drag(W.drag ?? 0.1).gravity(0)
      .fade(0.12, 0.55).vary(0.35);
    // spawn box around the camera: the emitter follows you, so a region always looks like itself
    B.jitter(0); B.px = p.x; B.py = p.y; B.pz = p.z;
    for (let i = 0; i < n; i++) {
      B.px = p.x + (Math.random() - 0.5) * W.box; B.pz = p.z + (Math.random() - 0.5) * W.box;
      B.py = p.y + (Math.random() - 0.5) * W.box * 0.35;
      B.burst(1);
    }
  }

  /**
   * Persistent regional emitters — the Infernal Wastes' smoke story (wave-2 verdict: "zero smoke anywhere,
   * no vent/cone/maw plume", plus props-A's ask for a vertical draw at the pit).
   *  - FUMAROLES: ~20 deterministic vents across the region breathing dark matte plumes (~30 m tall,
   *    alpha pool, lit by the scene) — the midday "vents breathing smoke" read at every distance.
   *  - THE CINDER MAW EMBER COLUMN at the landmark: a ~70 m leaning smoke-and-ember updraft with a
   *    saturated orange base shimmer over the pit lip — the 300 m approach draw the monolith ring never
   *    had. A wide low-alpha "body" layer is spawned ONLY from beyond 120 m: at range it welds the puffs
   *    into one silhouette (they read as a dashed dotted line otherwise) and up close it costs nothing.
   *  - LAVA-BANK EMBERS: sparse saturated sparks + heat wisps sampled over live lava surface near the
   *    camera (pairs with Water's bank light).
   * All in the existing pooled sprites (ZERO new draw calls), distance-gated so a quiet region costs
   * nothing, and blob-law-shaped: smoke is matte + scene-lit, embers are deep saturated ember hues at
   * hdr <= 2 (hue survives ACES — nothing here can white-clip).
   */
  _initAmbient() {
    const T = this.game.terrain, B = BIOMES.infernal, rng = mulberry32((this.game.seed ?? 1) + 7717);
    const WL = T.waterLevel ?? 4, bb = {};
    this.fumaroles = [];
    for (let i = 0; i < 200 && this.fumaroles.length < 20; i++) {
      const a = rng() * 6.2832, r = 30 + Math.sqrt(rng()) * 205;
      const x = B.cx + Math.cos(a) * r, z = B.cz + Math.sin(a) * r;
      const w = T.biomeBlend?.(x, z, bb);
      if (!w || w.id !== 'infernal' || w.w < 0.55) continue;
      const y = T.heightAt(x, z);
      if (y < WL + 0.6) continue;                                     // inside a lava channel — the banks get embers instead
      this.fumaroles.push({ x, y, z, acc: rng(), rate: 0.62 + rng() * 0.5, dx: (rng() - 0.5) * 1.6, dz: (rng() - 0.5) * 1.6 });
    }
    if (this.fumaroles.length < 5) { this.fumaroles = null; return; }   // bake not ready yet (heights read flat) — retry next frame
    this._mawAcc = { smoke: 0, ember: 0, big: 0, glow: 0, body: 0 }; this._lavaAcc = 0;
    // pre-warm: smoke lives 11-17 s, so a fresh page (or the first approach) would otherwise show beheaded
    // stubble plumes for the first quarter minute. Seed each column with already-risen, already-grown puffs.
    const lm = this.game.world?.props?.landmarks?.infernal, br = this.brush, lit = this._lit;
    if (lm) for (let i = 0; i < 30; i++) {
      const h01 = (i + 0.5) / 30, s0 = 4 + 13 * h01, tl = (1 - h01) * 13 + 2;
      br.reset(this.alpha, lm).jitter(4 + 5 * h01).axisUp().spread(0.07).speed(4.2, 6).life(tl, tl + 2)
        .size(s0, s0 + 1.6, Math.max(1, 21 / s0)).tex(TEX.SMOKE).color(0x2c221c, 0x100d0c).lit(lit)
        .vary(0.35).alpha(0.6 - 0.28 * h01).rot().spin(0.25).vel(1.1, 0, 0.4).drag(0.05).gravity(-0.2).fade(0.05, 0.6);
      br.px = lm.x + 14 * h01; br.py = lm.y + 3 + 68 * h01; br.pz = lm.z + 5 * h01;
      br.burst(1);
    }
    for (const f of this.fumaroles) for (let i = 0; i < 5; i++) {
      const h01 = (i + 0.5) / 5, s0 = 2.0 + 9 * h01, tl = (1 - h01) * 13 + 2;
      br.reset(this.alpha, f).jitter(0.8 + 2.2 * h01).axisUp().spread(0.12).speed(1.8, 2.8).life(tl, tl + 1.5)
        .size(s0, s0 + 1.0, Math.max(1, 13 / s0)).tex(TEX.SMOKE).color(0x3a322c, 0x16120f).lit(lit)
        .vary(0.35).alpha(0.52 - 0.24 * h01).rot().spin(0.3).vel(f.dx, 0, f.dz).drag(0.1).gravity(-0.18).fade(0.05, 0.55);
      br.px = f.x + f.dx * 7 * h01; br.py = f.y + 0.9 + 30 * h01; br.pz = f.z + f.dz * 7 * h01;
      br.burst(1);
    }
  }
  _ambient(dt) {
    const g = this.game, T = g.terrain, cam = g.camera;
    // init only once the props landmarks exist: props builds AFTER the terrain bake, so heights are real by
    // then (an early run rejected every vent candidate against the flat pre-bake heightfield and locked in 0)
    if (!this.fumaroles) { if (g.world?.props?.landmarks?.infernal && T?.heightAt && T.biomeBlend) this._initAmbient(); if (!this.fumaroles) return; }
    const B = this.brush, cx = cam.position.x, cz = cam.position.z, M = this.mult, lit = this._lit;
    // 1) fumarole plumes — slow, matte, huge; life 11-16 s so the column is standing long before you arrive
    for (const f of this.fumaroles) {
      const d2 = (f.x - cx) * (f.x - cx) + (f.z - cz) * (f.z - cz);
      if (d2 > 490000) { f.acc = Math.min(f.acc, 1); continue; }      // 700 m gate: beyond that a puff is sub-pixel
      f.acc += f.rate * M * dt;
      const n = f.acc | 0; if (!n) continue; f.acc -= n;
      B.reset(this.alpha, f).jitter(0.8).axisUp().spread(0.14).speed(1.8, 2.8).life(11, 16)
        .size(2.0, 3.0, 4.6).tex(TEX.SMOKE).color(0x3a322c, 0x16120f).lit(lit).vary(0.35).alpha(0.52)
        .rot().spin(0.3).vel(f.dx, 0, f.dz).drag(0.1).gravity(-0.18).fade(0.14, 0.55);
      B.py = f.y + 0.9;                                               // mouth height, clear of the cone lip
      B.burst(n);
    }
    // 2) the Cinder Maw ember column — the landmark's 300 m vertical draw
    const lm = g.world?.props?.landmarks?.infernal;
    if (lm) {
      const d2 = (lm.x - cx) * (lm.x - cx) + (lm.z - cz) * (lm.z - cz);
      if (d2 < 640000) {                                              // 800 m gate
        const A = this._mawAcc, far = d2 > 14400;                     // >120 m: the approach silhouette, not the pit interior
        A.smoke += 4.2 * M * dt; A.ember += 24 * M * dt; A.big += 3.5 * M * dt; A.glow += 1.3 * M * dt;
        if (far) A.body += 1.15 * M * dt;                             // wide slow column mass — closes the "dashed dotted line" gaps at range
        let n = A.smoke | 0; A.smoke -= n;
        if (n) B.reset(this.alpha, lm).jitter(4).axisUp().spread(0.07).speed(4.2, 6).life(12, 17)
          .size(4, 5.6, 3.8).tex(TEX.SMOKE).color(0x2c221c, 0x100d0c).lit(lit).vary(0.35).alpha(0.6)
          .rot().spin(0.25).vel(1.1, 0, 0.4).drag(0.05).gravity(-0.2).fade(0.18, 0.6).burst(n);
        n = A.body | 0; A.body -= n;                                  // only spawned from >120 m out, so it never fogs the pit up close
        if (n) B.reset(this.alpha, lm).jitter(7).axisUp().spread(0.05).speed(2.6, 3.8).life(17, 23)
          .size(9, 13, 2.6).tex(TEX.SMOKE).color(0x33281f, 0x131010).lit(lit).vary(0.3).alpha(0.3)
          .rot().spin(0.12).vel(1.1, 0, 0.4).drag(0.04).gravity(-0.12).fade(0.2, 0.55).burst(n);
        n = A.ember | 0; A.ember -= n;                                // fast small sparks riding the updraft
        if (n) B.reset(this.add, lm).jitter(4.5).axisUp().spread(0.22).speed(7, 13).life(2.6, 4.5)
          .size(0.055, 0.11, 0.5).tex(TEX.STAR).color(0xff6a18, 0x8a2404).hdr(1.9, 0.6).alpha(0.9)
          .rot().spin(3).swirl(0.6, 1.4, true).drag(0.15).gravity(-1.1).fade(0.05, 0.5).burst(n);
        n = A.big | 0; A.big -= n;                                    // sparse big motes: what actually reads at 250-300 m
        if (n) B.reset(this.add, lm).jitter(3.5).axisUp().spread(0.12).speed(5, 9).life(4, 6.5)
          .size(0.45, 0.8, 0.55).tex(TEX.GLOW).color(0xff5a14, 0x701c00).hdr(1.5, 0.5).alpha(0.8)
          .swirl(0.4, 1, true).drag(0.1).gravity(-0.8).fade(0.08, 0.55).burst(n);
        n = A.glow | 0; A.glow -= n;
        if (n) {
          // Saturated heat shimmer at the COLUMN BASE. The landmark anchor sits on the pit floor, so at ground
          // level the lip ate it (wave-2: "rune ring hidden below the pit lip"): +9 m puts it over the rim, where
          // it becomes the warm foot of the smoke column — the thing that says "fire" from 250 m. Deep ember hue
          // at hdr <= 1.15: even stacked 3 deep it tone-maps orange, never a white ball.
          B.reset(this.add, lm).jitter(4).axisUp().spread(0.3).speed(0.8, 1.8).life(2.0, 2.8)
            .size(5, 8, 1.3).tex(TEX.GLOW).color(0xff5a14, 0x58180a).hdr(1.15, 0.4).alpha(0.5)
            .rot().fade(0.2, 0.55);
          B.py = lm.y + 9;
          B.burst(n);
        }
      }
    }
    // 3) lava-bank embers: sample the live lava surface (infernal water) in a box around the camera
    const W = g.world?.water, wb = this._ab ??= {};
    const b = T?.biomeBlend?.(cx, cz, wb);
    if (W?.isWater && b && b.id === 'infernal' && b.w > 0.15) {
      // 55 rejection samples/s over a 64 m box: a lava river is a narrow ribbon, so most samples miss on
      // purpose — the wide box is what puts embers over the channel you are LOOKING at, not just the one you
      // are standing in, and each hit spawns a small cluster so the hit rate (not the sample rate) sets the
      // cost. `isWater` is two noise lookups; 55/s is free. Embers must also RISE clear of the flow (~10 m):
      // over the molten surface they are invisible, it is against the dark bank and the sky that they read.
      this._lavaAcc += 70 * b.w * M * dt;
      let n = this._lavaAcc | 0; this._lavaAcc -= n;
      const p = this._wp ??= new THREE.Vector3();
      for (; n > 0; n--) {
        const x = cx + (Math.random() - 0.5) * 64, z = cz + (Math.random() - 0.5) * 64;
        if (!W.isWater(x, z)) continue;                               // attempts over dry ground are free misses
        p.set(x, (W.level ?? 4) + 0.25, z);
        if (Math.random() < 0.75)                                     // drifting ember sparks (deep saturated orange, hdr 1.7 — hue survives ACES over the white-hot flow)
          B.reset(this.add, p).jitter(1.8).axisUp().spread(0.45).speed(1.8, 3.4).life(3.5, 6.5).size(0.1, 0.19, 0.55)
            .tex(TEX.STAR).color(0xff7a20, 0x481304).hdr(1.7, 0.5).alpha(0.9).rot().spin(2).swirl(0.5, 1.2, true)
            .vel(0.3, 0, 0.15).drag(0.35).gravity(-0.5).fade(0.06, 0.55).burst(4);
        else                                                          // heat wisp off the crust
          B.reset(this.alpha, p).jitter(1.2).axisUp().spread(0.25).speed(1.2, 2.2).life(4, 6.5).size(0.5, 0.9, 2.8)
            .tex(TEX.SMOKE).color(0x241b16, 0x110d0b).lit(lit).vary(0.3).alpha(0.34).rot().spin(0.5)
            .drag(0.25).gravity(-0.35).fade(0.15, 0.5).burst(2);
      }
    }
  }

  update(dt, t) {
    const { camera, renderer, sky } = this.game;
    // min screen width for thin sparks/tracers (1.5 px), in world m per m depth
    const minW = 1.5 * 2 * Math.tan(camera.fov * 0.00872665) / (renderer.domElement.height || 1080);
    this.add.material.uniforms.uMinW.value = minW; this.alpha.material.uniforms.uMinW.value = minW;
    this.tracers.material.uniforms.uMinW.value = minW * (2.2 + 2.0 * this.day); // ~3.3px at night, ~6.3px at noon: a head-on tracer is a short screen segment, width is all it has
    // approximate scene light for dust/smoke tint: ambient + sun
    if (sky) {
      const si = sky.sunIntensity ?? 1, sc = sky.sunColor, ac = sky.ambientColor;
      this.day = Math.max(0, Math.min(1, si));
      this.tracers.material.uniforms.uDark.value = 0.85 * this.day; // dark tracer rim only in daylight (night additive is already hot)
      const L = this._lit;
      L[0] = Math.min(1.6, 0.18 + (ac ? ac.r * 0.35 : 0.2) + (sc ? sc.r : 1) * si * 0.85);
      L[1] = Math.min(1.6, 0.18 + (ac ? ac.g * 0.35 : 0.2) + (sc ? sc.g : 1) * si * 0.85);
      L[2] = Math.min(1.6, 0.18 + (ac ? ac.b * 0.35 : 0.25) + (sc ? sc.b : 1) * si * 0.85);
    }
    this._updateEmitters(dt);
    this._weather(dt);
    this._ambient(dt);
    this.add.update(dt); this.alpha.update(dt); this.tracers.update(dt); this.decals.update(dt); this.sigils.update(dt);
    this.filaments.update(dt, t);
    for (const f of this.lights) {
      if (f.t >= f.dur) continue;
      f.t += dt; const k = Math.max(0, 1 - f.t / f.dur);
      f.light.intensity = f.i0 * k * k;
      if (f.t >= f.dur) { f.light.intensity = 0; f.light.position.y = -1000; }
    }
  }
  _updateEmitters(dt) {
    for (const e of this.emitters) {
      if (!e.live) continue;
      const o = e.obj;
      if (o.alive === false || (e.opts.until && !e.opts.until()) || (e.opts.duration && e.t >= e.opts.duration)) { e.live = false; continue; }
      e.t += dt;
      e.prev.copy(e.pos);
      if (o.isObject3D) o.getWorldPosition(e.pos); else if (o.isVector3) e.pos.copy(o); else if (o.position) e.pos.copy(o.position); else e.pos.set(0, 0, 0);
      if (e.opts.offset) e.pos.add(e.opts.offset);
      if (e.t === dt) e.prev.copy(e.pos);
      if (o.velocity && o.velocity.lengthSq() > 1e-4) e.dir.copy(o.velocity).normalize().negate();
      else if (e.prev.distanceToSquared(e.pos) > 1e-6) e.dir.subVectors(e.prev, e.pos).normalize();
      else e.dir.set(0, 1, 0);
      e.acc += e.rate * dt;
      const n = e.acc | 0; e.acc -= n;
      for (let i = 0; i < n; i++) { _v3.lerpVectors(e.prev, e.pos, (i + 1) / n); e.opts.dir = e.dir; this._emit(e.preset, _v3, e.opts); }
    }
  }

  // ------------------------------------------------------------------ public API
  emit(preset, p, opts = NOPTS) { this._emit(preset, p, opts); }
  _emit(preset, p, o) {
    const fn = PRESETS[preset]; if (!fn) return;
    const base = BASE_COUNT[preset] ?? 1;
    const k = (o.count ? o.count / base : 1) * this.mult, s = o.scale ?? 1;
    fn(this, p, o, k, s, this._col(o, PRESET_COLOR[preset] ?? AETHER));
  }
  _col(o, fallback) { return _c.set(o.color ?? (o.element && ELEMENT_COLORS[o.element]) ?? fallback); }
  _anchor(p) { const a = this._anchors[this._ai = (this._ai + 1) % this._anchors.length]; a.copy(p); return a; }
  tracer(from, to, o = NOPTS) {
    // Shots fly along the view axis, so a tracer projects to a SHORT screen segment near the muzzle: length + width + on-screen
    // time are the only things that make it read. Noon: ~17x HDR core, ~2.4x width, 20+ m bolt, >= 0.22 s alive (hand cannon
    // cadence is 0.33 s — anything shorter and half the frames of real firing footage show nothing at all).
    const c = this._col(o, 0xffe9c4), h = o.hdr ?? (7 + 10 * this.day), len = o.len ?? (11 + 10 * this.day);
    const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const spd = Math.min(o.speed ?? 320, (dist + len) / 0.22);
    this.tracers.add(from, to, c.r * h, c.g * h, c.b * h, (o.width ?? 0.05) * (1 + 1.4 * this.day), o.duration ?? 0.14, spd, len, o.alpha ?? 1, o.core ?? 0.55, false);
  }
  beam(from, to, o = NOPTS) { const c = this._col(o, 0x7fd8ff), h = o.hdr ?? 4; this.tracers.add(from, to, c.r * h, c.g * h, c.b * h, o.width ?? 0.08, o.duration ?? 0.25, 0, 0, o.alpha ?? 1, o.core ?? 0.7, true); }
  decal(p, n, o = NOPTS) {
    const type = o.type ?? 'bullet';
    if (type === 'sigil') return this.sigil(p, { normal: n, color: o.color, size: o.size ?? 2.5, duration: o.duration ?? 10 });
    if (type === 'scorch') this.decals.add(p, n, o.size ?? 2.5, 1, o.life ?? 60, 0.12, 0.1, 0.09, o.rot);
    else this.decals.add(p, n, o.size ?? 0.16, 0, o.life ?? 45, 0.28, 0.26, 0.24, o.rot);
  }
  flash(p, o = NOPTS) {
    let f = null; for (const x of this.lights) if (x.t >= x.dur) { f = x; break; }
    if (!f) { f = this.lights[0]; for (const x of this.lights) if (x.t / x.dur > f.t / f.dur) f = x; }
    if (!f) return;
    const c = this._col(o, 0xffe2b0);
    f.t = 0; f.dur = o.duration ?? 0.06; f.i0 = (o.intensity ?? 3) * 9 * (0.5 + 0.5 * this.day); // candela-ish, halved at night (night exposure is high: full power blows out to a structureless orb)
    f.light.color.copy(c); f.light.distance = o.distance ?? 8; f.light.intensity = f.i0; f.light.position.copy(p);
  }
  attach(preset, obj, o = NOPTS) {
    let e = null; for (const x of this.emitters) if (!x.live) { e = x; break; }
    if (!e) return { stop() {} };
    e.live = true; e.preset = preset; e.obj = obj; e.opts = Object.assign({}, o); e.t = 0; e.acc = 0; e.rate = o.rate ?? EMIT_RATE[preset] ?? 20;
    if (obj.isObject3D) obj.getWorldPosition(e.pos); else if (obj.isVector3) e.pos.copy(obj); else if (obj.position) e.pos.copy(obj.position);
    if (e.opts.offset) e.pos.add(e.opts.offset);
    e.prev.copy(e.pos);
    e.handle = { stop: () => { e.live = false; }, get alive() { return e.live; } };
    return e.handle;
  }
  shockwave(p, o = NOPTS) {
    const r = o.radius ?? 3, c = this._col(o, 0xffffff), b = this.brush;
    if (o.normal) { _v3.set(p.x + o.normal.x * 0.95, p.y + o.normal.y * 0.95, p.z + o.normal.z * 0.95); b.reset(this.add, _v3).axis(o.normal).flat(); } // lift clear of 1 m meadow grass
    else b.reset(this.add, p).rot();
    b.tex(TEX.RING).size(r * 0.16, r * 0.16, 2 / 0.16).life(o.duration ?? 0.5).color(0xffffff, c).hdr(3.5 + 1.5 * this.day, 1.8).alpha(0.95).fade(0, 0.15).burst(1);
  }
  sigil(p, o = NOPTS) { return this.sigils.add(p, o.normal, { color: this._col(o, GOLD), size: o.size ?? 3, duration: o.duration ?? 1.5, spin: o.spin ?? 1.2, hdr: o.hdr ?? 2.2 }); }
  stats() { return { additive: this.add.n, alpha: this.alpha.n, tracers: this.tracers.n, decals: this.decals.n, sigils: this.sigils.items.filter((s) => s.live).length, emitters: this.emitters.filter((e) => e.live).length, day: this.day }; }
  // Perf validation: spawn n long-lived (8-12 s) particles in a cloud ahead of the camera, then measure with a perfWindow.
  stress(n = 5000) {
    const cam = this.game.camera, b = this.brush;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), p = new THREE.Vector3().copy(cam.position).addScaledVector(fwd, 12); // debug path: allocations fine
    b.reset(this.add, p).jitter(7).spread(3.14).speed(0.4, 2.5).life(8, 12).size(0.05, 0.12, 0.6).tex(TEX.STAR).color(0xffffff, AETHER).hdr(2, 1).rot().spin(2).swirl(0.5, 1.5, true).gravity(-0.2).drag(0.3).fade(0.05, 0.8).burst(Math.round(n * 0.7));
    b.reset(this.alpha, p).jitter(7).spread(3.14).speed(0.3, 1.5).life(8, 12).size(0.2, 0.4, 1.5).tex(TEX.SMOKE).color(0x555048).lit(this._lit).alpha(0.4).rot().spin(1).gravity(-0.1).drag(0.3).fade(0.05, 0.8).burst(n - Math.round(n * 0.7));
    return this.stats();
  }
  clear() { this.add.clear(); this.alpha.clear(); this.tracers.n = 0; this.decals.clear(); for (const e of this.emitters) e.live = false; this.sigils.clear(); }
  // Critics / harness: every preset in a row 6 m ahead of the camera, 2 m apart (left -> right), plus a tracer + beam + decals.
  showcase(names = SHOWCASE, spacing = 2.2, dist = 6) {
    const cam = this.game.camera, T = this.game.terrain;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); fwd.y = 0; fwd.normalize();   // (debug path: allocations fine)
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x), p = new THREE.Vector3(); // right = screen-right, so the list reads left -> right
    const list = typeof names === 'string' ? names.split(',') : names;
    for (let i = 0; i < list.length; i++) {
      p.copy(cam.position).addScaledVector(fwd, dist).addScaledVector(right, (i - (list.length - 1) / 2) * spacing);
      p.y = (T?.heightAt ? T.heightAt(p.x, p.z) : p.y - 1.6) + 0.05;
      const nm = list[i].trim(); const n = this._up;
      if (nm === 'tracer') this.tracer(p.clone().addScaledVector(right, -1.5).setY(p.y + 1.2), p.clone().addScaledVector(right, 1.5).addScaledVector(fwd, 3).setY(p.y + 1.4), { element: 'kinetic', speed: 40, len: 1.5 });
      else if (nm === 'beam') this.beam(p.clone().addScaledVector(right, -1.5).setY(p.y + 1), p.clone().addScaledVector(right, 1.5).addScaledVector(fwd, 3).setY(p.y + 1.6), { element: 'arc', duration: 1.2 });
      else if (nm === 'decal') { this.decal(p, n, { type: 'bullet', size: 0.3 }); this.decal(p.clone().addScaledVector(right, 0.8), n, { type: 'scorch', size: 1.4 }); }
      else if (nm === 'flash') { this.flash(p.clone().setY(p.y + 1), { color: 0xff8a3d, intensity: 1.4, distance: 6, duration: 0.18 }); this.emit('flash', p.clone().setY(p.y + 1), { color: 0xff8a3d, scale: 1.6 }); } // was intensity 6/0.4 s: blew out to a giant white orb at night
      else this.emit(nm, GROUNDED.has(nm) ? p : p.setY(p.y + 1.0), { normal: n, dir: fwd, element: nm === 'impact-enemy' ? 'arc' : undefined });
    }
    return list.length;
  }

  // ------------------------------------------------------------------ events
  _bind() {
    const ev = this.game.events, T = this.game.terrain;
    ev.on('combat:hit', (e) => {
      if (!e?.point || e.target?.kind === 'player') return;
      const n = e.normal ?? (e.dir ? _v.copy(e.dir).negate() : this._up);
      this._emit('impact-enemy', e.point, { normal: n, element: e.element, crit: e.crit, scale: e.crit ? 1.35 : 1 });
    });
    ev.on('combat:impact', (e) => {
      if (!e?.point) return;
      const n = e.normal ?? this._up, s = e.surface;
      const preset = s === 'water' ? 'impact-water' : (s === 'prop' || s === 'rock') ? 'impact-rock' : 'impact-terrain';
      this._emit(preset, e.point, { normal: n, element: e.element });
      if (s !== 'water') this.decal(e.point, n, { type: 'bullet', size: 0.16 + Math.random() * 0.1 }); // wave-1 feel audit: 0.12-0.2 m decals read as thin — one notch bigger
    });
    ev.on('combat:explosion', (e) => {
      if (!e?.point) return;
      const r = e.radius ?? 3, p = e.point;
      const gy = T?.heightAt ? T.heightAt(p.x, p.z) : -1e9, onGround = p.y - gy < r * 0.6;
      const n = onGround && T?.normalAt ? T.normalAt(p.x, p.z, _v) : null;
      this._emit('explosion', p, { radius: r, element: e.element, normal: n });
      if (onGround) { _v2.set(p.x, gy, p.z); this.decal(_v2, n, { type: 'scorch', size: r * 1.4 }); } // bigger so it peeks through 1 m grass
    });
    ev.on('combat:kill', (e) => { const t = e?.target; if (!t?.position || t.kind === 'player') return; this._dead.set(t, this.game.time); this._death(e.point ?? t.position, t.element ?? t.def?.element, t.radius ?? 0.5); });
    ev.on('enemy:death', (e) => {
      const en = e?.enemy; if (!en) return; if (en.target && this.game.time - (this._dead.get(en.target) ?? -9) < 0.5) return; // already handled via combat:kill
      this._death(en.center ?? en.position, en.def?.element ?? en.element, en.target?.radius ?? 0.5);
    });
    ev.on('weapon:fire', (e) => {
      // weapons draws tracers only when the shot hit something; misses into the sky/haze got zero feedback -> draw one to ~70 m
      if (!e || e.hit?.point || !e.origin || !e.dir) return;
      _v.copy(e.origin).addScaledVector(e.dir, 70);
      this.tracer(this.game.player?.weapons?.muzzleWorld ?? e.origin, _v, { element: e.weapon?.element, width: 0.04, len: 8 });
    });
    const P = this.game.player;
    ev.on('player:land', (e) => { const imp = e?.impact ?? 0; if (imp > 8) this._emit('land', P.position, { scale: Math.min(2.5, imp / 9) }); });
    ev.on('player:jump', (e) => { if ((e?.n ?? 1) >= 2) this._emit('jump', P.position, NOPTS); });
    ev.on('player:slide', () => { const c = P.controller; this.attach('slide', c, { until: () => c.sliding, rate: 40 }); });
  }
  _death(p, element, radius) { this._emit('death', p, { element, scale: Math.max(0.6, Math.min(3, radius / 0.5)) }); }
  get _up() { return UP; }
}
const UP = new THREE.Vector3(0, 1, 0);
const GROUNDED = new Set(['impact-terrain', 'impact-rock', 'impact-water', 'sparks', 'dust', 'ring', 'sigil', 'heal', 'levelup', 'jump', 'land']);
const SHOWCASE = ['muzzle', 'impact-terrain', 'impact-rock', 'impact-enemy', 'explosion', 'aether-burst', 'death', 'sigil', 'heal', 'levelup', 'pickup', 'jump', 'land', 'ring', 'tracer', 'beam', 'decal', 'flash'];

// ====================================================================================================================
// PRESETS — art direction lives here. fn(vfx, p, opts, k=count mult, s=scale, c=element/override color)
// ====================================================================================================================
const BASE_COUNT = { muzzle: 8, 'impact-terrain': 10, 'impact-rock': 14, 'impact-enemy': 12, sparks: 14, dust: 6, explosion: 30, 'aether-burst': 40, death: 36, pickup: 10, jump: 14, land: 8, levelup: 40 };
/**
 * Per-region weather. `rate` = particles/second at full region weight; `vel` is the fall (or drift) vector;
 * `up` lifts the spawn box above the camera so it falls INTO frame. Colours stay saturated and hdr stays
 * low — a bright mote is the same washed-white blob risk as anything else (project decree).
 */
const WEATHER = {
  tundra:    { rate: 48, box: 26, up: 9,  vel: [0.5, -1.5, 0.2], life: [5, 9],  size: [0.035, 0.075], tex: TEX.GLOW,  c0: 0xdfeeff, c1: 0xbcd8f0, hdr: 0.55, alpha: 0.75, add: false, drag: 0.5 },
  infernal:  { rate: 30, box: 26, up: 11, vel: [0.9, -0.8, 0.4], life: [6, 11], size: [0.03, 0.07],   tex: TEX.GLOW,  c0: 0xff6a14, c1: 0x3a2018, hdr: 0.85, alpha: 0.7,  add: true,  drag: 0.35 },
  shadowfen: { rate: 65, box: 22, up: 10, vel: [0.3, -7.5, 0.1], life: [1.4, 2.2], size: [0.012, 0.03], tex: TEX.SPARK, c0: 0x9fc8b0, c1: 0x6f9080, hdr: 0.5, alpha: 0.55, add: false, drag: 0.02 },
  void:      { rate: 14, box: 30, up: 4,  vel: [0.2, 0.9, 0.1],  life: [7, 13], size: [0.04, 0.09],   tex: TEX.STAR,  c0: 0xb070ff, c1: 0x4a2a80, hdr: 0.9,  alpha: 0.7,  add: true,  drag: 0.4 },
  celestial: { rate: 12, box: 30, up: 6,  vel: [0.3, 0.5, 0.2],  life: [8, 14], size: [0.035, 0.08],  tex: TEX.STAR,  c0: 0xffd27a, c1: 0xfff0c8, hdr: 0.8,  alpha: 0.6,  add: true,  drag: 0.4 },
  forest:    { rate: 9,  box: 24, up: 8,  vel: [0.6, -0.9, 0.3], life: [6, 10], size: [0.03, 0.06],   tex: TEX.GLOW,  c0: 0x9fff9c, c1: 0x2f5a3a, hdr: 0.7,  alpha: 0.55, add: true,  drag: 0.4 },
  dragon:    { rate: 24, box: 28, up: 10, vel: [1.6, -1.2, 0.6], life: [4, 8],  size: [0.03, 0.06],   tex: TEX.GLOW,  c0: 0xe8e4dc, c1: 0xb8b0a4, hdr: 0.5,  alpha: 0.6,  add: false, drag: 0.4 },
  lost:      { rate: 10, box: 28, up: 7,  vel: [0.3, 0.6, 0.2],  life: [7, 12], size: [0.035, 0.075], tex: TEX.STAR,  c0: 0xd8a0ff, c1: 0x6a4aa0, hdr: 0.8,  alpha: 0.6,  add: true,  drag: 0.4 },
};

const PRESET_COLOR = { muzzle: 0xffe9c4, 'impact-enemy': 0xb070ff, 'aether-burst': AETHER, death: AETHER, ring: 0xffffff, sigil: GOLD, heal: 0x9fffc0, 'heal-motes': 0x9fffc0, levelup: GOLD, pickup: 0xfff0a0, jump: 0x9fd8ff, trail: 0xffe9c4, 'spark-trail': 0xffe9c4, aura: AETHER, charge: AETHER, blood: 0xb070ff, 'impact-water': 0xcfe9ff };
const L = (v) => v._lit;
const axisOf = (o, def) => o.normal ?? o.dir ?? def;

const PRESETS = {
  // ---- Destiny: guns -----------------------------------------------------------------------------------------------
  muzzle(v, p, o, k, s, c) {
    // A hand cannon fires every ~0.33 s. A 0.1 s flash means 2 of 3 frames of real firing footage show NOTHING — which is
    // exactly what the noon critique found. So the flash is layered by lifetime: 0.16 s crisp petal -> 0.34 s saturated
    // ember afterglow -> ~0.9 s lit smoke wisp. Something readable is on screen for the whole firing cycle.
    // Wave-1 critique: the old 34x-noon petal cross tone-mapped to a pure white ball on both guns. Same recipe as
    // impact-enemy now: the hue lives in big saturated low-HDR layers (fringe petal, halo, afterglow), the hot core is
    // SMALL and capped ~12x, and every white start fades into the deep 'ember' hue (HOT_TINT pulls the start 55% toward
    // it) — warm ember for kinetic, violet for aether. Noon readability comes from size + the dark backing puff, not HDR.
    const b = v.brush, d = o.dir ?? UP, A = v.add, day = v.day, ds = s * (1 + 0.6 * day); // daylight: bigger or the flash vanishes against a noon sky
    const sat = _c2.copy(c).offsetHSL(0, 0.45, -0.07);        // bright saturated element hue
    const ember = _c3.copy(c).offsetHSL(0, 0.5, -0.2);        // deep ember of the same hue: the fringe/fade-out colour
    // dark backing puff (alpha, 1-2 frames): gives the additive petal contrast at high sun; ~invisible at night
    if (day > 0.15) b.reset(v.alpha, p).jitter(0.06 * ds).spread(3.14).speed(0.2, 0.6).life(0.17).size(0.85 * ds, 1.1 * ds, 1.6).tex(TEX.SMOKE).color(0x241d14).vary(0.25).alpha(0.46 * day).rot().fade(0, 0.4).burst(2);
    b.reset(A, p).tex(TEX.FLARE).size(1.02 * ds, 1.22 * ds, 1.3).life(0.16).color(ember, ember).hdr(2.4 + 1.4 * day, 0.9).alpha(0.9).rot().fade(0, 0.25).burst(1);  // ember fringe petal: low HDR keeps the hue through ACES — this is the colour read
    b.reset(A, p).tex(TEX.FLARE).size(0.58 * ds, 0.70 * ds, 1.4).life(0.15).color(0xffffff, ember).hdr(6 + 2.5 * day, 2.5).rot().fade(0, 0.3).burst(1); // crisp petal cross: capped at impact-enemy's praised core level so it reads as fire, not a white ball
    b.reset(A, p).tex(TEX.STAR).size(0.34 * ds, 0.42 * ds, 1.3).life(0.13).color(0xffffff, ember).hdr(5 + 2 * day, 2).rot().fade(0, 0.3).burst(1);      // warm ember core
    b.reset(A, p).tex(TEX.GLOW).size(0.30 * ds, 0.40 * ds, 1.4).life(0.12).color(sat, ember).hdr(3 + 1.5 * day, 1.2).alpha(0.7).fade(0, 0.3).burst(1); // small halo (support layer only)
    b.reset(A, p).tex(TEX.GLOW).size(0.34 * ds, 0.42 * ds, 0.35).life(0.34).color(ember, ember).hdr(1.6 + 1.2 * day).alpha(0.8).fade(0.02, 0.12).burst(1);  // hot-barrel afterglow, shrinking: the between-shots evidence
    b.reset(A, p).axis(d).spread(0.24).speed(18 * s, 36 * s).life(0.14, 0.34).size(0.02, 0.042, 0.4).tex(TEX.SPARK).color(0xffffff, ember).hdr(5 + 3 * day, 2).stretch(0.028).gravity(12).drag(2.5).fade(0, 0.5).burst(8 * k);
    b.reset(v.alpha, p).axis(d).spread(0.55).speed(1.4, 3.0).life(0.55, 0.95).size(0.22 * ds, 0.34 * ds, 3).tex(TEX.SMOKE).color(0x8c8c90).lit(L(v)).alpha(0.15 + 0.11 * day).rot().spin(2).drag(3).gravity(-0.8).fade(0.12, 0.3).burst(2 * k); // wisp lingers between shots
  },
  'spark-trail'(v, p, o, k, s, c) {
    if (o.size) s *= o.size / 0.15;  // projectile radius -> scale
    const b = v.brush;
    b.reset(v.add, p).jitter(0.02 * s).spread(3.14).speed(0, 0.3).life(0.18, 0.3).size(0.09 * s, 0.14 * s, 0.15).tex(TEX.GLOW).color(0xffffff, c).hdr(2.2, 1.6).alpha(0.7).fade(0, 0.25).burst(1);
    b.reset(v.add, p).axis(o.dir ?? UP).spread(0.35).speed(0.5, 2.2).life(0.2, 0.4).size(0.02 * s, 0.04 * s, 0.2).tex(TEX.SPARK).color(0xffffff, c).hdr(3.5, 2).stretch(0.03).gravity(3).drag(1).fade(0, 0.5).burst(1 + k);
  },
  trail(v, p, o, k, s, c) {
    if (o.size) s *= o.size / 0.15;
    const b = v.brush, day = v.day;
    // user decree: wisps attach this trail 24/7 at grass height across the meadow — it must NEVER read as
    // white balls. Saturate the color (hue survives ACES), cap the intensity at the wisp glow ceiling (1.1,
    // barely over the day bloom threshold). White at hdr 2.5 was the drifting white/purple flashing blobs.
    // Wave-2 (crit2-vale/crop-streak): at noon the additive stream STACKED to a pastel near-white slash
    // (~6% saturation core) — additive over sunlit grass can only wash toward white. So daylight (a) deepens
    // + saturates the hue so what accumulates is chroma, not lightness, (b) drops hdr/alpha (still <= 1.1),
    // and (c) slips a dim dark backing puff under the glow — the muzzle-flash contrast trick — so the violet
    // reads AGAINST the meadow instead of adding on top of it.
    const sat = _c2.copy(c).offsetHSL(0, 0.45 * day, -0.16 * day);
    if (day > 0.2) b.reset(v.alpha, p).jitter(0.05 * s).spread(3.14).speed(0, 0.25).life(0.3, 0.5).size(0.13 * s, 0.2 * s, 1.3).tex(TEX.SMOKE).color(0x140b22).vary(0.2).alpha(0.28 * day).rot().fade(0.05, 0.4).burst(1);
    b.reset(v.add, p).jitter(0.03 * s).spread(3.14).speed(0, 0.3).life(0.25, 0.45).size(0.1 * s, 0.16 * s, 0.1).tex(TEX.GLOW).color(sat, sat).hdr(1.1 - 0.5 * day, 0.8 - 0.35 * day).alpha(0.85 - 0.25 * day).fade(0, 0.3).burst(2);
    if (Math.random() < 0.35) b.tex(TEX.STAR).size(0.06 * s, 0.1 * s, 0.3).life(0.3, 0.5).rot().spin(4).burst(1);
  },
  // ---- impacts -----------------------------------------------------------------------------------------------------
  'impact-terrain'(v, p, o, k, s, c) {
    const b = v.brush, n = axisOf(o, UP), fl = n.y > 0.5 ? p.y - 0.01 : -1e9;
    _v2.set(p.x + n.x * 0.25, p.y + n.y * 0.25, p.z + n.z * 0.25);   // lift the puff off the surface so it clears meadow grass blades
    b.reset(v.add, p).tex(TEX.GLOW).size(0.16 * s, 0.22 * s, 1.6).life(0.08).color(0xfff0d0, 0xd8b070).hdr(3, 1.2).fade(0, 0.3).burst(1);            // brief pop so the shot visibly lands even in grass
    b.reset(v.alpha, _v2).axis(n).spread(0.9).speed(1.4 * s, 3.2 * s).life(0.9, 1.5).size(0.22 * s, 0.38 * s, 3.2).tex(TEX.SMOKE).color(DUST).lit(L(v)).vary(0.3).alpha(0.6).rot().spin(1.5).drag(2.5).gravity(-0.3).fade(0.08, 0.4).burst(6 * k);
    b.reset(v.alpha, p).axis(n).spread(0.8).speed(3 * s, 7 * s).life(0.5, 1.0).size(0.025 * s, 0.06 * s, 0.8).tex(TEX.DIRT).color(DIRT).lit(L(v)).vary(0.5).rot().spin(12).gravity(20).drag(0.5).floor(fl, 0.35).fade(0, 0.7).burst(10 * k);
    b.reset(v.add, p).axis(n).spread(0.7).speed(3 * s, 6 * s).life(0.15, 0.35).size(0.012, 0.022, 0.3).tex(TEX.SPARK).color(0xfff0c0, 0xffa040).hdr(2.5, 1).stretch(0.025).gravity(14).drag(1).fade(0, 0.5).burst(2 * k);
  },
  dust(v, p, o, k, s, c) { PRESETS['impact-terrain'](v, p, o, k * 0.6, s, c); },
  'impact-rock'(v, p, o, k, s, c) {
    const b = v.brush, n = axisOf(o, UP), fl = n.y > 0.5 ? p.y - 0.01 : -1e9;
    // at 9 m a 2 cm spark is sub-pixel: chips and dust carry the read, the sparks are the sizzle on top
    b.reset(v.alpha, p).jitter(0.05 * s).spread(3.14).speed(0.3, 0.8).life(0.3, 0.5).size(0.22 * s, 0.34 * s, 1.8).tex(TEX.SMOKE).color(0x1a1512).vary(0.3).alpha(0.5 * v.day).rot().fade(0.02, 0.3).burst(2 * k);   // dark backing so the flash pops off a bright cliff
    b.reset(v.add, p).tex(TEX.GLOW).size(0.34 * s, 0.46 * s, 1.5).life(0.11).color(0xfff0c0, 0xff9040).hdr(4.5, 1.8).fade(0, 0.3).burst(1);
    b.reset(v.add, p).axis(n).spread(1.0).speed(5 * s, 14 * s).life(0.35, 0.8).size(0.03, 0.058, 0.5).tex(TEX.SPARK).color(0xfff0b0, 0xff8030).hdr(5, 2.4).stretch(0.05).gravity(18).drag(1.2).floor(fl, 0.5).fade(0, 0.55).burst(14 * k);
    b.reset(v.alpha, p).axis(n).spread(0.9).speed(2 * s, 6 * s).life(0.5, 0.9).size(0.035 * s, 0.07 * s, 0.8).tex(TEX.DIRT).color(0x8a8684).lit(L(v)).vary(0.5).rot().spin(14).gravity(18).drag(0.4).floor(fl, 0.4).fade(0, 0.7).burst(8 * k);
    b.reset(v.alpha, p).axis(n).spread(0.8).speed(1 * s, 2.4 * s).life(0.5, 0.95).size(0.18 * s, 0.32 * s, 2.6).tex(TEX.SMOKE).color(0x9a9490).lit(L(v)).vary(0.3).alpha(0.45).rot().spin(2).drag(3).gravity(-0.3).fade(0.08, 0.35).burst(4 * k);
  },
  'impact-prop'(v, p, o, k, s, c) { PRESETS['impact-rock'](v, p, o, k, s, c); },
  sparks(v, p, o, k, s, c) {
    v.brush.reset(v.add, p).axis(axisOf(o, UP)).spread(o.spread ?? 1.0).speed(5 * s, 14 * s).life(0.3, 0.7).size(0.018, 0.034, 0.5).tex(TEX.SPARK).color(0xfff0b0, o.color != null || o.element ? c : 0xff8030).hdr(4, 2).stretch(0.03).gravity(18).drag(1.2).floor(p.y - 0.01, 0.5).fade(0, 0.55).burst(14 * k);
  },
  'impact-water'(v, p, o, k, s, c) {
    const b = v.brush;
    b.reset(v.alpha, p).axisUp().spread(0.5).speed(2 * s, 5 * s).life(0.5, 0.9).size(0.03, 0.06, 0.6).tex(TEX.GLOW).color(0xd8ecff).lit(L(v)).alpha(0.9).gravity(14).drag(0.5).fade(0, 0.6).burst(14 * k);
    b.reset(v.alpha, p).axisUp().spread(0.7).speed(0.8, 1.8).life(0.5, 0.8).size(0.15 * s, 0.25 * s, 2.5).tex(TEX.SMOKE).color(0xe8f4ff).lit(L(v)).alpha(0.35).rot().drag(3).fade(0.05, 0.3).burst(3 * k);
    b.reset(v.add, p).axisUp().flat().tex(TEX.RING).size(0.1 * s, 0.1 * s, 8).life(0.6).color(0xffffff, 0x9fd8ff).hdr(1.5, 0.6).alpha(0.7).fade(0, 0.2).burst(1);
  },
  'impact-enemy'(v, p, o, k, s, c) {
    const b = v.brush, n = axisOf(o, UP), crit = !!o.crit, day = v.day;
    // Element identity survives ACES only at MODERATE HDR: anything above ~3x clips to white. So the hue lives in big,
    // saturated, low-HDR layers (halo, ring, motes) and only a small core is allowed to go white-hot.
    const sat = _c2.copy(c).offsetHSL(0, 0.45, -0.08);
    // dark aether backing puff (normal blend, un-lit): gives the additive pop contrast against bright noon grass/sky
    b.reset(v.alpha, p).jitter(0.09 * s).spread(3.14).speed(0.3, 0.9).life(0.45, 0.7).size(0.4 * s, 0.6 * s, 2.2).tex(TEX.SMOKE).color(0x120a1e).vary(0.3).alpha(0.78).rot().spin(2).drag(2).fade(0.05, 0.35).burst(5 * k);
    b.reset(v.add, p).tex(TEX.GLOW).size(0.85 * s, 1.15 * s, 1.5).life(0.3).color(sat, sat).hdr(1.5 + 0.5 * day, 0.5).alpha(0.95).fade(0, 0.28).burst(1); // big saturated colored halo = THE element read
    b.reset(v.add, p).tex(TEX.GLOW).size(0.4 * s, 0.55 * s, 1.6).life(0.2).color(sat, sat).hdr(2.6 + 1.0 * day, 1.1).alpha(0.9).fade(0, 0.3).burst(1);
    b.reset(v.add, p).tex(TEX.STAR).size(0.26 * s, 0.34 * s, 1.4).life(0.13).color(0xffffff, c).hdr(6 + 3 * day, 3).rot().fade(0, 0.3).burst(1);          // small white-hot core only
    b.reset(v.add, p).axis(n).spread(1.1).speed(4 * s, 11 * s).life(0.28, 0.6).size(0.04, 0.075, 0.3).tex(TEX.SPARK).color(sat, sat).hdr(4.5 + 1.5 * day, 2).stretch(0.06).gravity(7).drag(2.5).fade(0, 0.5).burst(16 * k);
    // ember flecks: brief saturated chunks that arc out and die fast — the physical "something broke off" presence the
    // wave-1 feel audit asked for. Saturated colour at moderate HDR (blob law: hue survives ACES, value never clips).
    b.reset(v.add, p).axis(n).spread(1.4).speed(2 * s, 6 * s).life(0.25, 0.5).size(0.05, 0.09, 0.5).tex(TEX.STAR).color(sat, sat).hdr(3 + 1 * day, 1.5).rot().spin(6).gravity(10).drag(1.5).fade(0, 0.5).burst(6 * k);
    b.reset(v.add, p).spread(3.14).speed(0.6, 2).life(0.5, 0.9).size(0.1 * s, 0.18 * s, 0.4).tex(TEX.STAR).color(sat, sat).hdr(2.6 + 0.9 * day).rot().spin(3).gravity(-1).drag(2).fade(0.05, 0.5).burst(6 * k);
    b.reset(v.add, p).axis(n).flat().tex(TEX.RING).size(0.42 * s, 0.42 * s, 7).life(0.45).color(sat, sat).hdr(2.4 + 1.0 * day, 0.9).alpha(1).fade(0, 0.18).burst(1);   // saturated ring, big enough to read at 8 m
    if (crit) { b.reset(v.add, p).tex(TEX.STAR).size(0.34 * s, 0.46 * s, 1.8).life(0.22).color(0xffffff, sat).hdr(5 + 2 * day, 2.5).rot().spin(2).fade(0, 0.3).burst(2);
      b.reset(v.add, p).axis(n).flat().tex(TEX.RING).size(0.28 * s, 0.28 * s, 11).life(0.6).color(sat, sat).hdr(2.2 + 0.8 * day, 0.7).alpha(0.9).fade(0.04, 0.25).burst(1);  // crit: second wider ring
      b.reset(v.add, p).axis(n).spread(3.14).speed(4, 10).life(0.35, 0.7).size(0.026, 0.05, 0.3).tex(TEX.SPARK).color(0xffffff, sat).hdr(4.5 + 1.5 * day, 2.5).stretch(0.04).gravity(6).drag(2).fade(0, 0.5).burst(10 * k); }
  },
  blood(v, p, o, k, s, c) { PRESETS['impact-enemy'](v, p, o, k, s, c); },
  // ---- big ---------------------------------------------------------------------------------------------------------
  explosion(v, p, o, k, s, c) {
    // Destiny grenade cadence: fireball ~0.3s, then an aftermath that HOLDS at the site 2.5-4s:
    // slow dark smoke ball + a pumped smoke column (attach emitter ~1.8s), a low dust ring that lingers, embers that stay local.
    const b = v.brush, r = (o.radius ?? 3) * s, n = o.normal, A = v.add, AL = v.alpha;
    const fire = o.element === 'arc' || o.element === 'void' || o.element === 'stasis' || o.element === 'strand' ? c : _c2.set(0xff5a18);
    const fl = n ? p.y - 0.02 : -1e9;
    b.reset(A, p).tex(TEX.GLOW).size(0.5 * r, 0.65 * r, 1.9).life(0.16).color(0xffffff, fire).hdr(8, 3).fade(0, 0.25).burst(1);                        // core flash
    b.reset(A, p).tex(TEX.GLOW).size(1.1 * r, 1.3 * r, 1.5).life(0.28).color(fire, 0x7a1800).hdr(1.6, 0.3).alpha(0.85).fade(0, 0.25).burst(1);            // warm halo
    b.reset(A, p).tex(TEX.FLARE).size(1.4 * r, 1.7 * r, 1.5).life(0.11).color(0xfff4d8, fire).hdr(4, 2).rot().fade(0, 0.2).burst(1);
    b.reset(A, p).jitter(0.3 * r).spread(3.14).speed(1.6 * r, 4 * r).life(0.5, 1.0).size(0.18 * r, 0.36 * r, 2.6).tex(TEX.SMOKE).color(0xfff0b8, 0x8a1a00).hdr(3.2, 0.25).vary(0.5).rot().spin(3).drag(3.2).gravity(-2.5).fade(0.0, 0.3).burst(22 * k); // fire tongues (outlive the flash so the smoke ball never swallows the fire phase)
    // smoke ball: Destiny grenade gradient — fire-lit orange-brown -> mid grey-brown -> dark. Starts SMALL and semi-transparent
    // and grows (endMul 3.4), so 0.2-1.0 s reads as a churning fireball, not an instant ink blob.
    b.reset(AL, p).jitter(0.25 * r).spread(3.14).speed(0.35 * r, 0.85 * r).life(2.2, 3.4).size(0.26 * r, 0.42 * r, 3.4).tex(TEX.SMOKE).color(0xb06a2e, 0x272119).hdr(1.7, 1).lit(L(v)).vary(0.35).alpha(0.62).rot().spin(0.6).drag(1.0).gravity(-0.7).fade(0.16, 0.55).burst(14 * k);
    v.attach('exp-smoke', v._anchor(p), { duration: 1.8, rate: Math.max(6, 11 * v.mult), scale: r / 3 });                                              // smoke column keeps pumping from the site
    _v3.set(p.x, p.y + (n ? 0.95 : 0), p.z);                                                                                                          // grounded ring lifts clear of 1 m meadow grass
    if (n) b.reset(A, _v3).axis(n).flat(); else b.reset(A, _v3).rot();
    b.tex(TEX.RING).size(0.42 * r, 0.42 * r, 9).life(0.55).color(0xffffff, c).hdr(5, 2.2).alpha(0.95).fade(0, 0.18).burst(1);                          // shockwave
    if (n) { _v3.set(p.x, p.y + 1.05, p.z);                                                                                                            // dust ring rides above the grass tops
      b.reset(AL, _v3).axis(n).ring(0.35 * r, 0.6 * r, 0.2).speed(1.3, 2.4).life(2.4, 3.8).size(0.3 * r, 0.5 * r, 2.4).tex(TEX.SMOKE).color(0x9c8760, 0x7a6a4e).lit(L(v)).vary(0.3).alpha(0.55).rot().spin(0.8).drag(1.0).gravity(-0.15).fade(0.05, 0.6).burst(14 * k);   // lingering TAN dust ring: light against green grass, dark against sky
      _v3.set(p.x, p.y + 0.9, p.z);                                                                                                                    // scorch "haze" discs: the decal itself is buried under 1 m grass, this is the visible char
      b.reset(AL, _v3).axis(n).flat().ring(0, 0.5 * r).tex(TEX.SMOKE).size(0.75 * r, 1.05 * r, 1.15).life(7, 10).color(0x241d16, 0x2b241b).vary(0.3).alpha(0.5).rot().fade(0.06, 0.45).burst(5); }
    b.reset(A, p).axisUp().spread(3.14).speed(1.2 * r, 3.2 * r).life(1.4, 2.6).size(0.022, 0.05, 0.35).tex(TEX.SPARK).color(0xffd080, fire).hdr(3.5, 0.7).stretch(0.03).gravity(8).drag(1.0).floor(fl, 0.3).fade(0, 0.6).burst(30 * k);       // lingering embers (local: capped speed so they don't pile 10 m away)
    b.reset(A, p).jitter(0.4 * r).axisUp().spread(1.2).speed(0.4, 1.2).life(1.4, 2.4).size(0.05 * r, 0.09 * r, 0.4).tex(TEX.GLOW).color(fire, 0xff3000).hdr(1.8, 0.5).alpha(0.55).gravity(-0.5).drag(1.5).fade(0.1, 0.5).burst(10 * k);       // floating hot motes
    b.reset(AL, p).axisUp().spread(2.2).speed(1.2 * r, 3 * r).life(0.8, 1.5).size(0.04 * s, 0.1 * s, 0.9).tex(TEX.DIRT).color(DIRT).lit(L(v)).vary(0.5).rot().spin(15).gravity(22).drag(0.3).floor(fl, 0.3).fade(0, 0.75).burst(14 * k);    // debris
    v.flash(p, { color: fire, intensity: 6 * s, distance: 6 * r, duration: 0.3 });
  },
  'exp-smoke'(v, p, o, k, s, c) {
    // one column puff per emitter tick: slow rise (~1-1.5 m/s), long life, dark and thick so it reads on grass at noon
    v.brush.reset(v.alpha, p).jitter(0.5 * s).axisUp().spread(0.4).speed(0.8, 1.6).life(2.0, 3.0).size(0.7 * s, 1.2 * s, 2.9).tex(TEX.SMOKE)
      .color(0x5a4e40, 0x241f1a).lit(L(v)).vary(0.35).alpha(0.7).rot().spin(0.5).drag(0.5).gravity(-0.45).fade(0.14, 0.6).burst(1);
  },
  'aether-burst'(v, p, o, k, s, c) {
    const b = v.brush, A = v.add, day = v.day;
    const sat = _c2.copy(c).offsetHSL(0, 0.5, 0);      // saturated violet-blue so it reads as magic, not a shadow artifact
    // dark aether veil: TINY and sparse — at noon it used to dominate and the whole burst read as a shadow smudge
    b.reset(v.alpha, p).jitter(0.16 * s).axisUp().spread(1.4).speed(0.5, 1.4).life(0.7, 1.2).size(0.16 * s, 0.26 * s, 2.0).tex(TEX.SMOKE).color(0x140b24, 0x1d1230).vary(0.3).alpha(0.3).rot().spin(1.5).drag(1.5).gravity(-0.8).fade(0.06, 0.35).burst(4 * k);
    b.reset(A, p).tex(TEX.GLOW).size(0.7 * s, 0.95 * s, 2.2).life(0.45).color(sat, sat).hdr(1.6 + 0.6 * day, 0.5).alpha(0.95).fade(0, 0.3).burst(1);   // big saturated violet bloom = the magic read
    b.reset(A, p).tex(TEX.GLOW).size(0.36 * s, 0.46 * s, 2.6).life(0.3).color(0xffffff, sat).hdr(4 + 2 * day, 1.8).alpha(0.9).fade(0, 0.3).burst(1);
    b.reset(A, p).jitter(0.1 * s).axisUp().spread(1.2).speed(2 * s, 4 * s).life(1.0, 1.8).size(0.18 * s, 0.3 * s, 0.4).tex(TEX.STAR).color(sat, sat).hdr(3.2 + 1.2 * day, 2).rot().spin(4).swirl(4, 7, true).gravity(-1.5).drag(1.0).fade(0.05, 0.5).burst(90 * k);   // 2x mote size, saturated (was white-hot dots that clipped to grey specks)
    b.reset(A, p).jitter(0.1 * s).axisUp().spread(1.3).speed(1.5 * s, 3 * s).life(0.9, 1.6).size(0.24 * s, 0.42 * s, 0.5).tex(TEX.GLOW).color(sat, sat).hdr(2.2 + 0.8 * day).alpha(0.7).swirl(3, 6, true).gravity(-1.2).drag(1.2).fade(0.05, 0.5).burst(42 * k);
    b.reset(A, p).axisUp().flat().tex(TEX.RING).size(0.42 * s, 0.42 * s, 6).life(0.6).color(sat, sat).hdr(2.4 + 1.0 * day, 0.9).alpha(0.95).fade(0, 0.2).burst(1);
  },
  death(v, p, o, k, s, c) {
    // the kill reward: dark void veil first, then a white-hot pop + double ring + rising motes — most readable vfx in the game
    const b = v.brush, A = v.add, day = v.day;
    b.reset(v.alpha, p).jitter(0.35 * s).spread(3.14).speed(0.4, 1.2).life(1.5, 2.4).size(0.35 * s, 0.6 * s, 2.4).tex(TEX.SMOKE).color(0x0e0817, 0x1a1026).vary(0.3).alpha(0.72).rot().spin(1).drag(2).gravity(-0.6).fade(0.04, 0.45).burst(10 * k);
    b.reset(A, p).tex(TEX.GLOW).size(0.42 * s, 0.55 * s, 2.2).life(0.28).color(0xffffff, c).hdr(5, 2).fade(0, 0.3).burst(1);
    b.reset(A, p).tex(TEX.STAR).size(0.55 * s, 0.7 * s, 2).life(0.24).color(0xffffff, c).hdr(7, 3).rot().fade(0, 0.3).burst(1);
    b.reset(A, p).axisUp().flat().tex(TEX.RING).size(0.3 * s, 0.3 * s, 9).life(0.55).color(0xffffff, c).hdr(5, 2).alpha(0.9).fade(0, 0.2).burst(1);
    b.reset(A, p).axisUp().flat().tex(TEX.RING).size(0.15 * s, 0.15 * s, 12).life(0.75).color(c).hdr(3, 1.2).alpha(0.7).fade(0.1, 0.3).burst(1);
    // afterglow motes: at 8 m the old 0.11 m stars were sub-pixel and the kill tail vanished by 0.75 s. 2x size, longer life,
    // saturated at moderate HDR so the element colour holds through noon exposure — the payoff now reads for ~2.5 s.
    const dsat = _c2.copy(c).offsetHSL(0, 0.35, 0);
    b.reset(A, p).jitter(0.5 * s).axisUp().spread(0.5).speed(1.0, 2.8).life(1.8, 3.0).size(0.22 * s, 0.36 * s, 0.4).tex(TEX.STAR).color(0xffffff, dsat).hdr(3.6 + 1.6 * day, 1.8).rot().spin(3).swirl(1.5, 3, true).gravity(-1.5).drag(0.8).fade(0.08, 0.6).burst(36 * k);
    b.reset(A, p).jitter(0.5 * s).axisUp().spread(0.7).speed(0.5, 1.6).life(1.6, 2.6).size(0.42 * s, 0.75 * s, 0.4).tex(TEX.GLOW).color(dsat, dsat).hdr(1.7 + 0.5 * day).alpha(0.7).gravity(-0.8).drag(1).fade(0.1, 0.55).burst(14 * k);
    b.reset(A, p).jitter(0.3 * s).spread(3.14).speed(3, 7).life(0.4, 0.8).size(0.02, 0.04, 0.3).tex(TEX.SPARK).color(0xffffff, c).hdr(5, 3).stretch(0.03).gravity(8).drag(2).fade(0, 0.5).burst(16 * k);
    v.flash(p, { color: c, intensity: 4 * s, distance: 10, duration: 0.4 });
  },
  // ---- rings / sigils / FF14 magic ----------------------------------------------------------------------------------
  ring(v, p, o, k, s, c) {
    const n = o.normal ?? UP;
    _v2.set(p.x + n.x * 1.0, p.y + n.y * 1.0, p.z + n.z * 1.0);   // lift clear of grass blades (~1 m meadow)
    const b = v.brush.reset(v.add, _v2).axis(n).flat();
    b.tex(TEX.RING).size(0.2 * s, 0.2 * s, (o.radius ?? 2) * s / 0.1).life(o.duration ?? 0.5).color(0xffffff, c).hdr(3.5, 1.8).alpha(0.9).fade(0, 0.2).burst(1);
  },
  sigil(v, p, o, k, s, c) {
    const size = o.size ?? (o.radius ? o.radius * 2 : 2.4 * s);
    const dur = o.duration ?? 1.5;
    const fresh = v.sigils.add(p, o.normal, { color: c, size, duration: dur, spin: o.spin ?? 1.2, hdr: o.hdr ?? 2.2 }).t === 0;
    if (!fresh) return;
    const b = v.brush, n = o.normal ?? UP;
    // vertical presence so the glyph reads from standing height in 1 m grass: light pillar + edge ring pulse + dense rising runes
    _v2.set(p.x + n.x * 0.1, p.y + n.y * 0.1, p.z + n.z * 0.1); _v3.set(p.x + n.x * size * 0.85, p.y + n.y * size * 0.85, p.z + n.z * size * 0.85);
    v.beam(_v2, _v3, { color: c, width: 0.16 * size, duration: Math.min(dur, 4), alpha: 0.45, core: 0.25, hdr: 3 });
    b.reset(v.add, p).axis(n).flat().tex(TEX.RING).size(0.2 * size, 0.2 * size, 5.2).life(0.5).color(0xffffff, c).hdr(5, 2.5).alpha(0.9).fade(0, 0.2).burst(1);
    b.reset(v.add, p).ring(0.15 * size, 0.45 * size, 1, 0.15).speed(0.6, 1.2).life(1.0, 1.8).size(0.09 * size, 0.15 * size, 0.5).tex(TEX.RUNE).color(0xffffff, c).hdr(5, 2.6).rot().spin(1.5).gravity(-0.7).drag(0.8).fade(0.1, 0.5).burst(Math.max(8, 18 * k));
    b.reset(v.add, p).ring(0.3 * size, 0.48 * size, 1, 0.1).speed(0.3, 0.8).life(1.0, 1.6).size(0.1 * size, 0.18 * size, 0.6).tex(TEX.GLOW).color(c).hdr(1.8).alpha(0.5).gravity(-0.5).drag(1).fade(0.1, 0.5).burst(Math.max(4, 8 * k));
  },
  heal(v, p, o, k, s, c) {
    const fresh = v.sigils.add(p, o.normal, { color: c, size: o.size ?? (o.radius ? o.radius * 2 : 3 * s), duration: o.duration ?? 3, spin: 0.8 }).t === 0;
    if (fresh) v.brush.reset(v.add, p).axisUp().flat().tex(TEX.RING).size(0.3 * s, 0.3 * s, 10).life(0.6).color(0xffffff, c).hdr(2.5, 1).alpha(0.8).fade(0, 0.2).burst(1);
    PRESETS['heal-motes'](v, p, o, 14 * k, s, c);   // callers re-emit 'heal' (count ~8) every ~0.5 s while the rift lives -> sigil refreshes, motes keep rising
  },
  'heal-motes'(v, p, o, k, s, c) {
    v.brush.reset(v.add, p).ring(0.2 * s, 1.3 * s, 1.0, 0.4).speed(0.8, 1.8).life(1.0, 1.8).size(0.04 * s, 0.09 * s, 0.3).tex(TEX.STAR).color(0xffffff, c).hdr(2.5, 1.5).rot().spin(3).gravity(-1.2).drag(0.8).swirl(1, 2, true).fade(0.15, 0.5).burst(Math.max(1, k));
  },
  levelup(v, p, o, k, s, c) {
    const b = v.brush, A = v.add;
    v.sigils.add(p, o.normal, { color: c, size: 3.5 * s, duration: 2.5, spin: 1.5, hdr: 2 });
    b.reset(A, p).axisUp().flat().tex(TEX.RING).size(0.3 * s, 0.3 * s, 12).life(0.7).color(0xffffff, c).hdr(3, 1.2).alpha(0.9).fade(0, 0.2).burst(1);
    b.reset(A, p).tex(TEX.GLOW).size(0.6 * s, 0.8 * s, 3).life(0.4).color(0xffffff, c).hdr(3, 1.5).fade(0, 0.3).burst(1);
    b.reset(A, p).ring(0.3 * s, 1.2 * s, 1.0, 0.5).speed(2.5, 4.5).life(1.5, 2.5).size(0.05 * s, 0.1 * s, 0.3).tex(TEX.STAR).color(0xffffff, c).hdr(3, 2).rot().spin(4).swirl(2, 4, true).gravity(-2.5).drag(0.8).fade(0.1, 0.5).burst(40 * k);
    b.reset(A, p).ring(0.2 * s, 0.8 * s, 1.0, 0.2).speed(2, 3.5).life(1.2, 2.2).size(0.12 * s, 0.22 * s, 0.4).tex(TEX.GLOW).color(c).hdr(1.5).alpha(0.5).gravity(-2).drag(1).fade(0.1, 0.5).burst(20 * k);
    b.reset(A, p).jitter(0.5 * s).spread(3.14).speed(1, 3).life(1.0, 1.8).size(0.08 * s, 0.14 * s, 0.5).tex(TEX.RUNE).color(c).hdr(2.2).rot().spin(2).gravity(-1.5).drag(1.5).fade(0.1, 0.5).burst(10 * k);
    v.flash(_v2.copy(p).setY(p.y + 1.2), { color: c, intensity: 4, distance: 10, duration: 0.5 });
  },
  pickup(v, p, o, k, s, c) {
    const b = v.brush;
    b.reset(v.add, p).tex(TEX.GLOW).size(0.3 * s, 0.4 * s, 2).life(0.3).color(0xffffff, c).hdr(3, 1.5).fade(0, 0.3).burst(1);
    b.reset(v.add, p).jitter(0.1).spread(3.14).speed(1 * s, 2.5 * s).life(0.4, 0.8).size(0.04 * s, 0.08 * s, 0.3).tex(TEX.STAR).color(0xffffff, c).hdr(3, 2).rot().spin(4).gravity(-1).drag(2).fade(0, 0.5).burst(10 * k);
  },
  flash(v, p, o, k, s, c) {
    // a single big GLOW at hdr 4 became a structureless white orb at night (night exposure is ~2x): cap HDR by daylight and
    // give it structure — saturated halo + small hot star core + a ring edge, so it reads as a spark pop, not a render error.
    const b = v.brush, A = v.add, e = 0.45 + 0.55 * v.day, dur = o.duration ?? 0.15, sat = _c2.copy(c).offsetHSL(0, 0.35, -0.05);
    b.reset(A, p).tex(TEX.GLOW).size(0.42 * s, 0.62 * s, 1.8).life(dur * 1.4).color(sat, sat).hdr(1.5 * e, 0.5 * e).alpha(0.9).fade(0, 0.25).burst(1);
    b.reset(A, p).tex(TEX.STAR).size(0.2 * s, 0.26 * s, 1.6).life(dur).color(0xffffff, c).hdr(5 * e, 2 * e).rot().fade(0, 0.3).burst(1);
    b.reset(A, p).rot().tex(TEX.RING).size(0.18 * s, 0.18 * s, 5).life(dur * 2).color(sat, sat).hdr(2.2 * e, 0.8 * e).alpha(0.85).fade(0, 0.2).burst(1);
  },
  aura(v, p, o, k, s, c) {
    v.brush.reset(v.add, p).ring(0.45 * s, 0.6 * s, 0, 1).speed(1.5 * s).swirl(2.5 / s).life(0.8, 1.4).size(0.04 * s, 0.08 * s, 0.3).tex(TEX.STAR).color(0xffffff, c).hdr(2.5, 1.5).rot().spin(3).gravity(-0.4).fade(0.15, 0.5).burst(Math.max(1, k));
  },
  charge(v, p, o, k, s, c) {
    v.brush.reset(v.add, p).ring(0.7 * s, 1.1 * s, 0, 0).speed(-2.2 * s, -2.8 * s).life(0.35, 0.4).size(0.03 * s, 0.07 * s, 0.2).tex(TEX.SPARK).color(c, 0xffffff).hdr(2, 3.5).stretch(0.04).fade(0.2, 0.7).burst(Math.max(1, k));
  },
  // ---- movement ----------------------------------------------------------------------------------------------------
  jump(v, p, o, k, s, c) {
    const b = v.brush, A = v.add;
    b.reset(A, p).axisUp().flat().tex(TEX.RING).size(0.3 * s, 0.3 * s, 4.5).life(0.35).color(0xffffff, c).hdr(2.5, 1.2).alpha(0.8).fade(0, 0.2).burst(1);
    b.reset(A, p).tex(TEX.GLOW).size(0.5 * s, 0.6 * s, 2).life(0.25).color(c).hdr(2).alpha(0.7).fade(0, 0.3).burst(1);
    b.reset(A, p).ring(0.1 * s, 0.35 * s, 0.25, 0.1).speed(2, 4).life(0.4, 0.7).size(0.04 * s, 0.07 * s, 0.3).tex(TEX.STAR).color(0xffffff, c).hdr(3, 2).rot().spin(3).gravity(4).drag(2).fade(0, 0.4).burst(14 * k);
  },
  land(v, p, o, k, s, c) {
    const b = v.brush;
    b.reset(v.alpha, p).ring(0.1 * s, 0.3 * s, 0.25, 0).speed(2 * s, 4 * s).life(0.6, 1.0).size(0.2 * s, 0.32 * s, 3).tex(TEX.SMOKE).color(DUST).lit(L(v)).vary(0.3).alpha(0.45).rot().spin(1.5).drag(3).gravity(-0.3).fade(0.08, 0.35).burst(8 * k);
    b.reset(v.alpha, p).ring(0.05 * s, 0.2 * s, 0.6, 0).speed(2 * s, 4 * s).life(0.4, 0.8).size(0.02, 0.045, 0.8).tex(TEX.DIRT).color(DIRT).lit(L(v)).vary(0.5).rot().spin(10).gravity(18).drag(0.5).floor(p.y, 0.3).fade(0, 0.7).burst(6 * k);
  },
  slide(v, p, o, k, s, c) {
    const b = v.brush, d = o.dir ?? UP;
    _v.set(d.x, d.y + 0.35, d.z);
    b.reset(v.alpha, p).axis(_v).spread(0.45).speed(1 * s, 2.5 * s).life(0.5, 0.9).size(0.12 * s, 0.2 * s, 2.5).tex(TEX.SMOKE).color(DUST).lit(L(v)).vary(0.3).alpha(0.3).rot().spin(1.5).drag(2).gravity(-0.4).fade(0.1, 0.35).burst(1);
    if (Math.random() < 0.6) b.reset(v.alpha, p).axis(_v).spread(0.5).speed(2, 4).life(0.4, 0.7).size(0.02, 0.04, 0.8).tex(TEX.DIRT).color(DIRT).lit(L(v)).vary(0.5).rot().spin(10).gravity(18).drag(0.5).floor(p.y, 0.3).fade(0, 0.7).burst(1);
  },
};
