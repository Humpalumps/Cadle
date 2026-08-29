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
const EMIT_RATE = { trail: 90, 'spark-trail': 45, slide: 45, aura: 30, charge: 40, 'heal-motes': 22, dust: 6, sparks: 8, 'exp-smoke': 11 };   // spark-trail 45 not 70: riftling+voidhorror volleys sustained ~375 live additive particles and the stack washed the void out

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _c = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color(), _hsl2 = { h: 0, s: 0, l: 0 };
const _c4 = new THREE.Color(), _c5 = new THREE.Color();   // impact spark pair (see elemental() / the void-amber note)
const _PS = new THREE.Vector3();   // _plume/_preheat spawn point (px/py/pz are set explicitly right after reset)
/**
 * Peak of the tracer/beam fragment profile at the segment's centre line (Extras.js TR_FRAG:
 * `mix(glow + core*0.6, core*1.4 + glow*0.3, vCore)` with glow 0.75 and core 1.0 at x = 0).
 * The min-channel caps in tracer()/beam() are the whole reason those two bright streaks cannot go white —
 * but they were capping the STORED colour while the shader then multiplied it by ~1.5 on the hot line, so
 * a noon bolt landed on screen at min channel 1.08, i.e. clipped in every channel. The combat gate
 * photographs that as a cream beam leaving the muzzle (cb-fix1 burst-cvfx-pfire-a-7, 674 px at rgb
 * 253,247,222). Divide the cap by the gain the shader is about to apply, so the cap means what it says.
 */
const TR_PROF = (core) => 1.35 + 0.275 * core;
const NOPTS = {};

/**
 * Smoke-column recipes for VFX#_plume. cw* = sun-side start/end colour, cd* = shadow side; a puff starts
 * at the DARK vent colour and ends at the risen/lit one, so a column reads dark-stem -> bright-crown.
 * Deliberately many small puffs at low alpha rather than a few big opaque ones: overlap is what makes
 * smoke look like volume, and one 13 m quad at alpha 0.6 is what made wave-3's read "a smudge on the lens".
 * `fo` (fade-out start, fraction of life) is early on purpose — that is the column DISPERSING instead of
 * ending on a hard cut. `off` is how far the two lit sides are pushed apart along the sun's horizontal.
 */
const PLUME_VENT = { jit: 0.75, spr: 0.17, sp0: 2.2, sp1: 3.4, l0: 8.5, l1: 12.5, z0: 1.0, z1: 1.9, grow: 4.8, a: 0.30,
  cw0: 0x4a3d33, cw1: 0x7d6e5e, cd0: 0x2a231e, cd1: 0x4e443b, spin: 0.35, drag: 0.08, buoy: -0.16, fi: 0.10, fo: 0.38, off: 1.1 };
const PLUME_MAW = { jit: 3.2, spr: 0.10, sp0: 5.0, sp1: 7.2, l0: 13, l1: 18, z0: 2.4, z1: 3.8, grow: 4.4, a: 0.34,
  cw0: 0x453830, cw1: 0x8d7d6b, cd0: 0x241d19, cd1: 0x4e433a, spin: 0.22, drag: 0.05, buoy: -0.22, fi: 0.12, fo: 0.40, off: 4.5 };
const PLUME_MAW_BODY = { jit: 6.5, spr: 0.06, sp0: 3.0, sp1: 4.4, l0: 18, l1: 24, z0: 6.5, z1: 9.5, grow: 3.0, a: 0.21,
  cw0: 0x3d3229, cw1: 0x7b6c5c, cd0: 0x201a16, cd1: 0x453a32, spin: 0.10, drag: 0.04, buoy: -0.14, fi: 0.16, fo: 0.42, off: 7 };
const PLUME_LAVA = { jit: 1.3, spr: 0.28, sp0: 1.4, sp1: 2.6, l0: 4, l1: 7, z0: 0.45, z1: 0.85, grow: 3.4, a: 0.22,
  cw0: 0x2e241d, cw1: 0x6a5a4c, cd0: 0x1a1512, cd1: 0x3a3129, spin: 0.6, drag: 0.25, buoy: -0.35, fi: 0.14, fo: 0.45, off: 0.5 };
// The Maw's column is lit from BELOW by the pit, so its smoke never falls to flat black at night the way a
// fumarole does. Deep ember floor, red-dominant: it tints the stem, it cannot brighten it into a blob.
const MAW_FLOOR = [0.34, 0.15, 0.07];

export class VFX {
  constructor(game) {
    this.game = game; this.brush = new Brush(); this.emitters = []; this._dead = new WeakMap(); this.lights = []; this._lit = [1, 1, 1];
    this.mult = QMUL[game.quality] ?? 1; this.day = 1; // 0 night .. 1 full daylight; boosts gun-feedback HDR/size so it reads at noon
    // smoke lighting (see _plume): sun side, shadow side, and the two the Cinder Maw uses — its column is
    // lit from below by the pit even at midnight, so its floor never falls to black.
    this._litWarm = [1, 1, 1]; this._litDim = [0.4, 0.4, 0.5]; this._mawLit = [1, 1, 1]; this._mawDim = [0.4, 0.4, 0.5];
    this._sunH = [0.7, 0.7]; this._pi = 0;
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
   * ONE smoke puff burst, lit on two sides. The particle pool has no normals and no lighting, so every
   * plume in the game used to be ONE flat value — which is exactly what the wave-3 infernal verdict called
   * "flat blurry grey sprite-quads ... smudges on the lens". Cheapest honest fix: spawn half the puffs
   * offset toward `sky.sunDir`'s horizontal with a sun-lit ash colour and half on the far side with a cool
   * dark one, alternate the two smoke silhouettes, and let each puff START dark at the vent and LIGHTEN as
   * it rises (colour is interpolated over life). Dark stem, bright churning crown, per-puff value jitter —
   * that reads as volume without a single extra draw call.
   * `C` is a recipe from the PLUME table; `k` scales the whole thing (distance LOD).
   */
  _plume(x, y, z, n, C, dx, dz, k = 1, LW = this._litWarm, LD = this._litDim) {
    const B = this.brush, s = this._sunH, warm = ((this._pi = (this._pi + 1) | 0) & 1) === 0;
    const o = C.off * k * (warm ? 1 : -1);
    B.reset(this.alpha, _PS)
      .jitter(C.jit * k).axisUp().spread(C.spr).speed(C.sp0, C.sp1).life(C.l0, C.l1)
      .size(C.z0 * k, C.z1 * k, C.grow).tex(this._pi & 2 ? TEX.SMOKE : TEX.SMOKE2)
      .color(warm ? C.cw0 : C.cd0, warm ? C.cw1 : C.cd1).lit(warm ? LW : LD)
      .vary(0.55).alpha(C.a).rot().spin(C.spin).vel(dx, 0, dz).drag(C.drag).gravity(C.buoy).fade(C.fi, C.fo);
    B.px = x + s[0] * o; B.py = y; B.pz = z + s[1] * o;
    B.burst(n);
  }

  /**
   * Persistent regional emitters — the Infernal Wastes' smoke story (wave-2: "zero smoke anywhere";
   * wave-3: "smudges on the lens", "the Cinder Maw has zero landmark draw at 250/150/60 m or at night",
   * "an open lava river throws no embers, no heat shimmer and no smoke even at 2 m").
   *  - FUMAROLES: ~20 deterministic vents breathing two-sided ash plumes (~35 m). Many small puffs, not a
   *    few big ones: a plume is only "billowing" if neighbouring puffs differ in value and silhouette.
   *  - THE CINDER MAW COLUMN at the landmark: core + (beyond 120 m) a wide body layer that welds the puffs
   *    into one silhouette, plus embers. At NIGHT the smoke is invisible against a dark sky, so the column
   *    swaps to fire: a saturated-orange ember/glow shaft up the first ~40 m carries the landmark read.
   *  - LAVA: embers that climb clear of the flow (over the molten surface an orange spark is invisible —
   *    it reads against the dark bank and the sky), warm heat haze and low crust smoke on the BANKS.
   * All in the existing pooled sprites (ZERO new draw calls), distance-gated so a quiet region costs
   * nothing, and blob-law-shaped: smoke is matte + scene-lit, fire is deep saturated ember hue at
   * hdr <= 1.9 (red-dominant by ~4:1 — hue survives ACES, nothing here can white-clip).
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
      this.fumaroles.push({ x, y, z, acc: rng(), rate: 2.6 + rng() * 1.6, dx: (rng() - 0.5) * 1.6, dz: (rng() - 0.5) * 1.6 });
    }
    if (this.fumaroles.length < 5) { this.fumaroles = null; return; }   // bake not ready yet (heights read flat) — retry next frame
    this._mawAcc = { smoke: 0, ember: 0, big: 0, glow: 0, body: 0, fire: 0 }; this._lavaAcc = 0;
    // (columns pre-warm themselves the frame they come into range — see _ambient)
  }
  /** One already-risen puff at height fraction `h` of a column: mid-life size, mid-life colour, short remaining life. */
  _preheat(x, y, z, C, h, dx, dz) {
    const B = this.brush, warm = ((this._pi = (this._pi + 1) | 0) & 1) === 0, g = 1 + (C.grow - 1) * h;
    B.reset(this.alpha, _PS)
      .jitter(C.jit * (1 + 3 * h)).axisUp().spread(C.spr).speed(C.sp0, C.sp1).life((1 - h) * (C.l0 + C.l1) * 0.5 + 1.5)
      .size(C.z0 * g, C.z1 * g, Math.max(1, C.grow * (1 - h * 0.8))).tex(this._pi & 2 ? TEX.SMOKE : TEX.SMOKE2)
      .color(warm ? C.cw1 : C.cd1).lit(warm ? this._litWarm : this._litDim)
      .vary(0.55).alpha(C.a * (1 - 0.6 * h)).rot().spin(C.spin).vel(dx, 0, dz).drag(C.drag).gravity(C.buoy).fade(0.03, Math.max(0.1, C.fo - h * 0.3));
    B.px = x; B.py = y; B.pz = z;
    B.burst(1);
  }
  _ambient(dt) {
    const g = this.game, T = g.terrain, cam = g.camera;
    // init only once the props landmarks exist: props builds AFTER the terrain bake, so heights are real by
    // then (an early run rejected every vent candidate against the flat pre-bake heightfield and locked in 0)
    if (!this.fumaroles) { if (g.world?.props?.landmarks?.infernal && T?.heightAt && T.biomeBlend) this._initAmbient(); if (!this.fumaroles) return; }
    const B = this.brush, cx = cam.position.x, cz = cam.position.z, M = this.mult, night = 1 - this.day;
    // 1) fumarole plumes. Past 260 m nobody can see churn, only the silhouette: a third of the puffs, 1.3x each.
    for (const f of this.fumaroles) {
      const d2 = (f.x - cx) * (f.x - cx) + (f.z - cz) * (f.z - cz);
      if (d2 > 490000) { f.acc = Math.min(f.acc, 1); f.warm = false; continue; }   // 700 m gate: beyond that a puff is sub-pixel
      // A column takes ~15 s to build. Fast travel puts you 250 m from the Maw in one frame, so a vent that
      // just came into range would show a beheaded stub for a quarter minute: re-seed it already standing.
      if (!f.warm) { f.warm = true; for (let i = 0; i < 13; i++) { const h = (i + 0.5) / 13; this._preheat(f.x + f.dx * 8 * h, f.y + 0.9 + 34 * h, f.z + f.dz * 8 * h, PLUME_VENT, h, f.dx, f.dz); } }
      const far = d2 > 67600;
      f.acc += f.rate * (far ? 0.30 : 1) * M * dt;
      const n = f.acc | 0; if (!n) continue; f.acc -= n;
      this._plume(f.x, f.y + 0.9, f.z, n, PLUME_VENT, f.dx, f.dz, far ? 1.3 : 1);   // +0.9 = mouth height, clear of the cone lip
    }
    // 2) the Cinder Maw column — the landmark's 300 m vertical draw, day AND night
    const lm = g.world?.props?.landmarks?.infernal;
    if (lm) {
      const d2 = (lm.x - cx) * (lm.x - cx) + (lm.z - cz) * (lm.z - cz);
      if (d2 >= 640000) this._mawWarm = false;                        // 800 m gate
      else {
        if (!this._mawWarm) { this._mawWarm = true; for (let i = 0; i < 60; i++) { const h = (i + 0.5) / 60; this._preheat(lm.x + 16 * h, lm.y + 3 + 76 * h, lm.z + 6 * h, i % 3 ? PLUME_MAW : PLUME_MAW_BODY, h, 1.1, 0.4); } }
        const A = this._mawAcc, far = d2 > 14400;                     // >120 m: the approach silhouette, not the pit interior
        A.smoke += 8.5 * M * dt; A.big += 4.5 * M * dt; A.glow += (1.3 + 2.2 * night) * M * dt;
        A.ember += (24 + 22 * night) * M * dt;
        A.fire += 11 * night * M * dt;                               // the night beacon: smoke is invisible after dark
        if (far) A.body += 2.2 * M * dt;                              // wide slow column mass — closes the "dashed dotted line" gaps at range
        let n = A.smoke | 0; A.smoke -= n;
        if (n) this._plume(lm.x, lm.y + 3, lm.z, n, PLUME_MAW, 1.1, 0.4, 1, this._mawLit, this._mawDim);
        n = A.body | 0; A.body -= n;                                  // only spawned from >120 m out, so it never fogs the pit up close
        if (n) this._plume(lm.x, lm.y + 3, lm.z, n, PLUME_MAW_BODY, 1.1, 0.4, 1, this._mawLit, this._mawDim);
        n = A.ember | 0; A.ember -= n;                                // sparks riding the updraft (uMinW floors them at ~1.5 px, so they read at 300 m)
        if (n) B.reset(this.add, lm).jitter(4.5).axisUp().spread(0.22).speed(8, 15).life(3.2, 5.5)
          .size(0.09, 0.17, 0.5).tex(TEX.STAR).color(0xff6a18, 0x8a2404).hdr(1.9, 0.6).alpha(0.9)
          .rot().spin(3).swirl(0.6, 1.4, true).drag(0.12).gravity(-1.3).fade(0.05, 0.5).burst(n);
        n = A.big | 0; A.big -= n;                                    // sparse big motes: what actually reads at 250-300 m
        if (n) B.reset(this.add, lm).jitter(3.5).axisUp().spread(0.12).speed(5, 9).life(4, 6.5)
          .size(0.5, 0.95, 0.55).tex(TEX.GLOW).color(0xff5a14, 0x701c00).hdr(1.5, 0.5).alpha(0.8)
          .swirl(0.4, 1, true).drag(0.1).gravity(-0.8).fade(0.08, 0.55).burst(n);
        n = A.fire | 0; A.fire -= n;
        if (n) {
          // NIGHT BEACON (wave-3: "at 60 m at NIGHT the hero landmark is two dark rocks ... the smoke column
          // is invisible against a dark sky, so the region has no landmark for half the day cycle"). A soft
          // ember SHAFT climbing the first ~45 m of the column, so the Maw is a warm vertical light from the
          // pass. hdr 0.85 on a 4:1 red:green ember — three of these stacked still tone-map orange, and the
          // whole layer switches off at sunrise when the smoke can carry the read on its own.
          B.reset(this.add, lm).jitter(5).axisUp().spread(0.13).speed(4.5, 7.5).life(6, 10)
            .size(4.5, 7.0, 0.55).tex(++this._pi & 1 ? TEX.GLOW : TEX.SMOKE)   // a gaussian every time = a row of balls
            .color(0xff5a12, 0x6a1c02).hdr(0.85, 0.25).alpha(0.42).vary(0.45)
            .rot().spin(0.4).drag(0.06).gravity(-0.55).fade(0.14, 0.38);
          B.py = lm.y + 10;
          B.burst(n);
        }
        n = A.glow | 0; A.glow -= n;
        if (n) {
          // Saturated heat shimmer at the COLUMN BASE. The landmark anchor sits on the pit floor, so at ground
          // level the lip ate it (wave-2: "rune ring hidden below the pit lip"): +9 m puts it over the rim, where
          // it becomes the warm foot of the smoke column — the thing that says "fire" from 250 m. Deep ember hue
          // at hdr <= 1.15: even stacked 3 deep it tone-maps orange, never a white ball.
          B.reset(this.add, lm).jitter(4).axisUp().spread(0.3).speed(0.8, 1.8).life(2.0, 2.8)
            .size(5 + 3 * night, 8 + 4 * night, 1.3).tex(TEX.GLOW).color(0xff5a14, 0x58180a).hdr(1.15, 0.4).alpha(0.5)
            .rot().fade(0.2, 0.55);
          B.py = lm.y + 9;
          B.burst(n);
        }
      }
    }
    // 3) lava: embers off the flow, heat haze + crust smoke on the banks
    const W = g.world?.water, wb = this._ab ??= {};
    const b = T?.biomeBlend?.(cx, cz, wb);
    if (W?.isWater && b && b.id === 'infernal' && b.w > 0.15) {
      // Rejection samples over a 64 m box: a lava river is a narrow ribbon, so most samples miss on purpose —
      // the wide box is what puts embers over the channel you are LOOKING at, not just the one you are
      // standing in, and the HIT rate (measured: ~4% of the box even standing on a bank) sets the cost, not
      // the sample rate. `isWater` is two cheap lookups, so 200/s is free and 4% of it is ~8 clusters/s.
      // A "bank" is a hit with dry ground within 3 m. Every hit gets embers — an earlier cut only emitted
      // them AWAY from banks and measured 24 hits out of 600, all 24 of them banks: an infernal channel is
      // narrower than the probe, so the ember branch was structurally dead and the lava threw nothing.
      this._lavaAcc += 200 * b.w * M * dt;
      let n = this._lavaAcc | 0; this._lavaAcc -= n;
      const p = this._wp ??= new THREE.Vector3(), L = W.level ?? 4;
      for (; n > 0; n--) {
        const x = cx + (Math.random() - 0.5) * 64, z = cz + (Math.random() - 0.5) * 64;
        if (!W.isWater(x, z)) continue;                               // attempts over dry ground are free misses
        p.set(x, L + 0.2, z);
        // Embers must CLIMB clear of the flow: a deep-orange spark over white-hot lava is invisible, it
        // reads against the dark bank, the ash sky and the smoke. Low drag + buoyancy = ~25 m of rise.
        B.reset(this.add, p).jitter(2.2).axisUp().spread(0.32).speed(3.4, 6.5).life(4.5, 8).size(0.13, 0.26, 0.5)
          .tex(TEX.STAR).color(0xff7a20, 0x481304).hdr(1.7, 0.5).alpha(0.9).rot().spin(2).swirl(0.5, 1.2, true)
          .vel(0.3, 0, 0.15).drag(0.12).gravity(-0.9).fade(0.06, 0.55).burst(4);
        if (!W.isWater(x + 3, z) || !W.isWater(x - 3, z) || !W.isWater(x, z + 3) || !W.isWater(x, z - 3)) {
          if (Math.random() < 0.6)
            // heat haze on the BANK: warm ADDITIVE wisps hugging the crust, fast rise + hard spin. Small and
            // many, not few and big — a handful of 2 m discs reads as orange balls, which is the wrong half of
            // "saturate the colour, cap the value". hdr 0.42 on a deep ember hue: a stack is a shimmer.
            B.reset(this.add, p).jitter(1.6).axisUp().spread(0.2).speed(2.6, 4.4).life(1.2, 2.0).size(0.22, 0.42, 2.6)
              .tex(TEX.SMOKE).color(0xff7418, 0x3a0e02).hdr(0.42, 0.12).alpha(0.30).rot().spin(1.6)
              .drag(0.5).gravity(-0.6).fade(0.18, 0.36).burst(3);
          else                                                        // crust smoke, low and lazy
            this._plume(x, L + 0.2, z, 1, PLUME_LAVA, 0.4, 0.2);
        } else if (Math.random() < 0.5) {
          // OVER the flow, contrast is the only thing that reads: the surface is the brightest thing in the
          // frame, so a bright particle disappears into it and a DARK one pops. Low, half-size crust smoke —
          // which is also what makes a look straight down into a channel stop being bare geometry.
          this._plume(x, L + 0.2, z, 1, PLUME_LAVA, 0.5, 0.25, 0.6);
        }
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
      // Smoke lighting (see _plume): sun side, shadow side (darker + cooler, sky-lit only), and the Maw's
      // pair. `ns` is why a plume is not a pale grey ball at midnight: the night hemisphere is bright enough
      // (hemiNight 1.05) that raw ambient x an ash albedo out-values a near-black landscape.
      const ns = 0.40 + 0.60 * this.day;
      const SW = this._litWarm, D = this._litDim, ML = this._mawLit, MD = this._mawDim;
      SW[0] = L[0] * ns; SW[1] = L[1] * ns; SW[2] = L[2] * ns;
      D[0] = L[0] * 0.42 * ns; D[1] = L[1] * 0.46 * ns; D[2] = L[2] * 0.58 * ns;
      for (let i = 0; i < 3; i++) { ML[i] = Math.max(SW[i], MAW_FLOOR[i]); MD[i] = Math.max(D[i], MAW_FLOOR[i] * 0.55); }
      const sd = sky.sunDir, hl = Math.hypot(sd.x, sd.z) || 1;   // sun's horizontal bearing: which side of a plume is lit
      this._sunH[0] = sd.x / hl; this._sunH[1] = sd.z / hl;
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
  /**
   * Pale-ground damp (blob decree, last mile). Over a near-WHITE floor (tundra snow, celestial marble)
   * ACES compresses base+additive to the top of the curve, so ANY meaningful additive collapses to a
   * desaturated wash — the combat gate's stubborn tundra sparkle fields were healthy deep-cyan stars whose
   * sum with snow tone-mapped white. There is no per-pixel fix in a particle system: the honest move is
   * less additive VALUE on those grounds, with the dark veils carrying the contrast read instead.
   * One biome lookup per burst, deterministic.
   */
  _paleK(p) {
    const b = this.game.terrain?.biomeAt?.(p.x, p.z);
    // lost 0.6 (added): the Convergence plaza is bright violet marble in a region that is one hue at one
    // value, so an additive cloud there starts from an already-high base in EVERY channel - the kill
    // bursts measured 1145 px at rgb (204,236,238) on it (cvfx-w7 burst-cvfx-lost-k-7). Same physics as
    // tundra snow and celestial marble; it was only ever off the list because its hue is violet, not white.
    return b === 'tundra' || b === 'celestial' ? 0.5 : b === 'sunken' || b === 'lost' ? 0.6 : b === 'dragon' ? 0.75 : 1;   // sunken 0.6 (was 0.75): the Drowned Court's pink-pale marble washed a deep-pink bolt halo at 0.75 (gate mix5)
  }
  _anchor(p) { const a = this._anchors[this._ai = (this._ai + 1) % this._anchors.length]; a.copy(p); return a; }
  tracer(from, to, o = NOPTS) {
    // Shots fly along the view axis, so a tracer projects to a SHORT screen segment near the muzzle: length + width + on-screen
    // time are the only things that make it read. Noon: ~17x HDR core, ~2.4x width, 20+ m bolt, >= 0.22 s alive (hand cannon
    // cadence is 0.33 s — anything shorter and half the frames of real firing footage show nothing at all).
    // MIN-CHANNEL DISCIPLINE — the tracer was the last bright element in the game with NO cap of any kind.
    // hdr rides to 17 at noon so the bolt reads against a bright sky, and 17 x a PASTEL weapon colour
    // (kinetic is 0xffe9c4) puts all three channels far past clip: the streak tone-mapped to pure white
    // and the combat gate flagged it at 4225 px, mean rgb (246,242,229), over a hound at point-blank
    // (tools/out/cvfx-w7 burst-cvfx-pfire-a-7.png). Same two-step every other author here uses: deepen the
    // hue first (a pastel has no hue left to survive ACES), then cap the SMALLEST channel just under clip
    // so the dominant one keeps the full noon heat and the bolt reads as a hot GOLD dart, not a white bar.
    const c = deepen(this._col(o, 0xffe9c4)), h = o.hdr ?? (7 + 10 * this.day), len = o.len ?? (11 + 10 * this.day);
    // Cap at 0.72, not the usual 0.98. A tracer is born AT the muzzle, on the same pixels as the flash's
    // own core, and two elements each sitting exactly at clip sum to twice clip: the pair tone-mapped to
    // rgb (254,249,228) at the barrel even after both were hue-corrected. A thin bright line does not need
    // to ride the clip point to read — its dominant channel is still 7x here.
    let tr = c.r * h, tg = c.g * h, tb = c.b * h;
    // 0.58, not 0.72: the tracer is born ON the muzzle flash's own pixels and the pair still summed to a
    // 49 px cream sliver at the barrel after both were budgeted separately (cb-fix4 burst-cvfx-pfire-a-3).
    { const m = Math.min(tr, tg, tb), cap = 0.58 / TR_PROF(o.core ?? 0.55); if (m > cap) { const s = cap / m; tr *= s; tg *= s; tb *= s; } }
    const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const spd = Math.min(o.speed ?? 320, (dist + len) / 0.22);
    this.tracers.add(from, to, tr, tg, tb, (o.width ?? 0.05) * (1 + 1.4 * this.day), o.duration ?? 0.14, spd, len, o.alpha ?? 1, o.core ?? 0.55, false);
  }
  beam(from, to, o = NOPTS) {
    const c = deepen(this._col(o, 0x7fd8ff)), h = o.hdr ?? 4;                       // same law as tracer(), TR_PROF included
    let r = c.r * h, g = c.g * h, b = c.b * h;
    const cap = 0.98 / TR_PROF(o.core ?? 0.7);
    const m = Math.min(r, g, b); if (m > cap) { const s = cap / m; r *= s; g *= s; b *= s; }
    this.tracers.add(from, to, r, g, b, o.width ?? 0.08, o.duration ?? 0.25, 0, 0, o.alpha ?? 1, o.core ?? 0.7, true);
  }
  decal(p, n, o = NOPTS) {
    const type = o.type ?? 'bullet';
    if (type === 'sigil') return this.sigil(p, { normal: n, color: o.color, size: o.size ?? 2.5, duration: o.duration ?? 10 });
    if (type === 'scorch') this.decals.add(p, n, o.size ?? 2.5, 1, o.life ?? 60, 0.22, 0.19, 0.17, o.rot);
    // Bullet tint 0.52 (was 0.34, was 0.28). These are MULTIPLY decals, so the tint is what the surface is
    // multiplied BY: 0.34 is a 66% darkening, which on anything but bright stone reads as a hole punched in
    // the world — wave-6 vale, verbatim and unchanged: "the impact decal is still a black smear (now a
    // black spiked circle on gold)", plus the coherence pass's "black scribble decals" over the meadow.
    // At 0.52 the mark is a SCUFF: the crater tile's pit/lip/cracks still carry the read by structure,
    // which is where a bullet hole's read is supposed to come from. Scorch lifted for the same reason.
    else this.decals.add(p, n, o.size ?? 0.14, 0, o.life ?? 45, 0.52, 0.49, 0.45, o.rot);
  }
  flash(p, o = NOPTS) {
    let f = null; for (const x of this.lights) if (x.t >= x.dur) { f = x; break; }
    if (!f) { f = this.lights[0]; for (const x of this.lights) if (x.t / x.dur > f.t / f.dur) f = x; }
    if (!f) return;
    // deepen the light's hue too: half the callers pass a pastel (death: raw glowColor, enemy muzzle
    // flashes) and a pale-cyan light pool on snow IS the wash — same law as the sprites, the ground a
    // light touches should read as coloured light, not as lifted white. Intensity is untouched.
    const c = deepen(this._col(o, 0xffe2b0));
    // NEAR-CAMERA FADE — the blob decree, and it belongs HERE rather than in each preset because every
    // caller has the same failure. An enemy explosive bolt detonates ON the player, so `explosion` put a
    // PointLight 0.5-1.2 m from the eye with a ~10 m falloff and an effective intensity of ~52 after the
    // multiplier below: it floods every pixel and the raw scene clips before postfx ever runs.
    // Measured by the creatures-1 diagnosis: 48 near-camera calls in 12 s, peak 52.7 at 0.51 m; zeroing
    // these lights alone took washed frames 3/5 -> 0/7 (tools/out/c1-diag4..6).
    // A light that close is never a lighting cue anyway — you cannot see what it lights, only the wash.
    const cam = this.game?.camera;
    let nearK = 1;
    if (cam) { const d = cam.position.distanceTo(p); nearK = d <= 2.5 ? 0 : Math.min(1, (d - 2.5) / 5.5); }   // 0 inside 2.5 m, full past 8 m: a flash at 3-5 m still floods a body-sized mesh filling the frame
    if (nearK <= 0) return;
    f.t = 0; f.dur = o.duration ?? 0.06; f.i0 = (o.intensity ?? 3) * 7 * (0.5 + 0.5 * this.day) * nearK; // candela-ish (was x9 — the creatures-1 bisect: these lights co-author the combat wash), halved at night (night exposure is high: full power blows out to a structureless orb)
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
    // Normal-less callers (enemy slam/phase, super pop) are GROUND slams: ground the ring on the terrain
    // normal instead of falling back to a camera-facing quad. A view-facing RING at slam range sweeps the
    // whole frame as a huge pale dome over snow/marble — the combat gate's tundra 4.7k-px "half-dome with
    // a straight bottom edge" was exactly this (Abilities.js knew: "at chest height it renders as a big
    // camera-facing white donut"). rot() remains only for genuinely airborne detonations.
    let n = o.normal;
    if (!n) { const T = this.game.terrain, gy = T?.heightAt?.(p.x, p.z); if (gy != null && p.y - gy < 3) n = T.normalAt?.(p.x, p.z, _v2) ?? UP; }
    if (n) { _v3.set(p.x + n.x * 0.95, p.y + n.y * 0.95, p.z + n.z * 0.95); b.reset(this.add, _v3).axis(n).flat(); } // lift clear of 1 m meadow grass
    else b.reset(this.add, p).rot();
    // deepened start, not white: an icegiant slam's 6 m expanding ring at hdr ~5 was a thick WHITE
    // annulus across the whole ground (combat gate r8, tundra 7.3k px). The ring reads by its sweep
    // and size; the colour is the element's.
    const dc = deepen(_c.copy(c));
    // hdr 1.5+0.5*day, not 2.4+0.8: a deep CYAN at x3.2 still clips its two high channels (min-channel cap
    // only engages on near-white), and the grounded slam annulus bloomed into a fat white ellipse at the
    // giant's feet (combat gate probe t2). At x2 the ring blooms in its own hue — cyan ring, not white.
    // x paleK: over sunlit snow/marble the base is already near clip, so the annulus sum washes at any hue
    // (probe t3) — on pale ground the ring reads by contrast against the bright floor, not by value.
    const swk = this._paleK(p);
    b.tex(TEX.RING).size(r * 0.16, r * 0.16, 2 / 0.16).life(o.duration ?? 0.5).color(dc, dc).hdr((1.5 + 0.5 * this.day) * swk, 0.8 * swk).alpha(0.95).fade(0, 0.15).burst(1);
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
      if (s !== 'water') this.decal(e.point, n, { type: 'bullet', size: 0.12 + Math.random() * 0.06 }); // honest 0.12-0.18 m: at 0.16-0.26 the old soft-blob tile read as a ~200 px hole in the world at 2 m
    });
    ev.on('combat:explosion', (e) => {
      if (!e?.point) return;
      const r = e.radius ?? 3, p = e.point;
      // OVERLAP GOVERNOR (energy share). A volley (bogwitch/skyserpent/voidhorror: 3 bolts, 0.12-0.18 s
      // apart) detonates 3+ full explosion stacks on the same spot; two casters make it 6. Each stack is
      // hue-capped, but N capped stacks still SUM — the shadowfen green screen-wash and the celestial
      // pale-cyan cloud in the combat gate (cvfx-r2) were exactly this. Recent explosions within 6 m share
      // the energy: the k-th concurrent one emits at 1/sqrt(k+1).
      const tNow = this.game.time;
      this._recentExp = this._recentExp?.filter((x) => tNow - x.t < 0.8) ?? [];
      const near = this._recentExp.filter((x) => (x.x - p.x) ** 2 + (x.y - p.y) ** 2 + (x.z - p.z) ** 2 < 36).length;
      this._recentExp.push({ t: tNow, x: p.x, y: p.y, z: p.z });
      const gy = T?.heightAt ? T.heightAt(p.x, p.z) : -1e9, onGround = p.y - gy < r * 0.6;
      const n = onGround && T?.normalAt ? T.normalAt(p.x, p.z, _v) : null;
      this._emit('explosion', p, { radius: r, element: e.element, normal: n, dampen: 1 / Math.sqrt(1 + near) });
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
  infernal:  { rate: 30, box: 26, up: 11, vel: [0.9, -0.8, 0.4], life: [6, 11], size: [0.03, 0.07],   tex: TEX.GLOW,  c0: 0xff6a14, c1: 0x3a2018, hdr: 0.7,  alpha: 0.7,  add: true,  drag: 0.35 },
  shadowfen: { rate: 65, box: 22, up: 10, vel: [0.3, -7.5, 0.1], life: [1.4, 2.2], size: [0.012, 0.03], tex: TEX.SPARK, c0: 0x9fc8b0, c1: 0x6f9080, hdr: 0.5, alpha: 0.55, add: false, drag: 0.02 },
  void:      { rate: 14, box: 30, up: 4,  vel: [0.2, 0.9, 0.1],  life: [7, 13], size: [0.04, 0.09],   tex: TEX.STAR,  c0: 0xb070ff, c1: 0x4a2a80, hdr: 0.6,  alpha: 0.7,  add: true,  drag: 0.4 },   // hdr x alpha <= ~0.42: TWO overlapping motes stay under the 1.05 day bloom threshold (~140 live at once)
  celestial: { rate: 12, box: 30, up: 6,  vel: [0.3, 0.5, 0.2],  life: [8, 14], size: [0.035, 0.08],  tex: TEX.STAR,  c0: 0xffd27a, c1: 0xffe8b0, hdr: 0.6,  alpha: 0.6,  add: true,  drag: 0.4 },
  forest:    { rate: 9,  box: 24, up: 8,  vel: [0.6, -0.9, 0.3], life: [6, 10], size: [0.03, 0.06],   tex: TEX.GLOW,  c0: 0x9fff9c, c1: 0x2f5a3a, hdr: 0.7,  alpha: 0.55, add: true,  drag: 0.4 },
  dragon:    { rate: 24, box: 28, up: 10, vel: [1.6, -1.2, 0.6], life: [4, 8],  size: [0.03, 0.06],   tex: TEX.GLOW,  c0: 0xe8e4dc, c1: 0xb8b0a4, hdr: 0.5,  alpha: 0.6,  add: false, drag: 0.4 },
  lost:      { rate: 10, box: 28, up: 7,  vel: [0.3, 0.6, 0.2],  life: [7, 12], size: [0.035, 0.075], tex: TEX.STAR,  c0: 0xd8a0ff, c1: 0x6a4aa0, hdr: 0.6,  alpha: 0.6,  add: true,  drag: 0.4 },
};

const PRESET_COLOR = { muzzle: 0xffe9c4, 'impact-enemy': 0xb070ff, 'aether-burst': AETHER, death: AETHER, ring: 0xffffff, sigil: GOLD, heal: 0x9fffc0, 'heal-motes': 0x9fffc0, levelup: GOLD, pickup: 0xfff0a0, jump: 0x9fd8ff, trail: 0xffe9c4, 'spark-trail': 0xffe9c4, aura: AETHER, charge: AETHER, blood: 0xb070ff, 'impact-water': 0xcfe9ff };
const L = (v) => v._lit;
const axisOf = (o, def) => o.normal ?? o.dir ?? def;
// deepen(): force a preset's working colour DEEP whatever the source. offsetHSL saturation does
// nothing to a near-white input (HSL: saturating at L~0.9 stays near-white), and half the bestiary
// feeds presets a PASTEL glowColor (frost 0x9fd8ff, seraph 0xffd27a) — the combat gate's residual
// pale pops (r5: tundra death ball, sunken/lost/celestial glints) were all pastel survivors.
// A colour only reads as magic through ACES if it starts deep: S >= 0.7, L <= 0.55.
/**
 * ELEMENTAL IMPACT COLOUR. Every impact preset used to spark, flash and glow GOLD/ORANGE whatever had
 * been hit by whatever — so a void bolt landing on voidstone painted warm amber over a violet region.
 * The void verdict measured 52.8% of the frame warm with the player never firing and named these exact
 * literals as the cause. Physical warm sparks belong to KINETIC (steel on stone); an aether bolt
 * shatters in ITS OWN hue, which is also what makes an element readable at a glance.
 * Writes the hot start colour into _c4 and the cool end colour into _c5 and returns _c4; callers pass
 * `.color(_c4, _c5)` immediately (Brush copies both out, so the temps are free again on return).
 */
const elemental = (o, c, warmHot, warmCool) => {
  if ((o.element && o.element !== 'kinetic') || o.color != null) {
    _c4.copy(c).offsetHSL(0, 0.45, 0.02);
    deepen(_c5.copy(c));
  } else { _c4.set(warmHot); _c5.set(warmCool); }
  return _c4;
};
/**
 * CO-LOCATED STACK BUDGET. Brush's BRUSH_MINCH_CAP is per PARTICLE and cannot see a stack — but a preset
 * that lays N additive layers on the SAME pixel sums N smallest-channels, and once that sum passes clip
 * ACES hands back white however deep each individual layer's hue is. That is the muzzle flash's barrel
 * core (5 co-located hot layers, measured rgb 254,249,224) and the kill pop's centre (4 co-located hot
 * layers, 248,242,223) — both flagged by the combat gate with every layer already in-hue and in-budget.
 * Given the recipe's working colour and the SUM of the hdr values that land on one point, return the
 * scalar that keeps that sum's smallest channel under STACK_MINCH_CAP. Zero alloc, one call per burst.
 * The dominant channel is untouched by the ratio, so the effect stays as hot as its hue allows.
 */
const STACK_MINCH_CAP = 0.70;   // well under the 1.05 day bloom threshold: these stacks land ON lit grass/marble, which supplies the rest
const stackK = (col, hdrSum) => {
  const m = Math.min(col.r, col.g, col.b) * hdrSum;
  return m > STACK_MINCH_CAP ? STACK_MINCH_CAP / m : 1;
};
/**
 * MEASURED, DO NOT "IMPROVE" (2026-08-29). Deepening this further — (S 0.85, L 0.52) was tried, which
 * takes a gold's smallest channel from 0.10 to 0.04 linear — makes every stackK below engage 2.5x LESS,
 * and the energy it lets through lands on the two channels the min-channel law does not watch: the
 * muzzle came back at rgb (254,250,226), a 229 px cream flare (tools/out/cb-s1 burst-cvfx-pfire-a-0).
 * The min channel is the tripwire, not the budget; making the hue deeper buys headroom the real overlap
 * immediately spends. Keep (0.7, 0.55) and spend the budget explicitly in the stackK lists instead.
 */
const deepen = (col) => {
  col.getHSL(_hsl2);
  if (_hsl2.s < 0.05) { col.set(0x8a5cff); col.getHSL(_hsl2); }   // a grey/white input has NO hue to deepen — clamping would invent red (hue 0); fall back to the house aether violet
  if (_hsl2.l > 0.55 || _hsl2.s < 0.7) col.setHSL(_hsl2.h, Math.max(_hsl2.s, 0.7), Math.min(_hsl2.l, 0.55));
  return col;
};

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
    // DOUBLE-DRAWN AT THE LENS. In first person the flash is drawn TWICE at the same place: Weapons.js has
    // its own viewmodel flash mesh (3 petals + star + a white core, models.js `mats.flash`), and this world
    // burst lands on the same pixels 0.6 m from the eye. Their sum is what the combat gate still flags on
    // burst-cvfx-pfire-a-* after both were hue-corrected. The viewmodel mesh owns the first-person read;
    // this burst owns the world read (distance, other angles, reflections), so damp it — and only it —
    // where the two overlap. 0.45 floor: still clearly a flash in first person, no longer a second full stack.
    // 0.45 -> 0.28 at the lens (2026-08-29). The floor is the share of the WORLD burst that still fires
    // when the barrel is 0.4 m from the eye, and it is set against a viewmodel flash mesh that is NOT in
    // the stackK budget below — three additive petals + a star + a core, all on the same pixels. The gate
    // has now flagged this exact frame across four separate fixes (burst-cvfx-pfire-a-0, last measured
    // 105 px at rgb 254,249,224 inside an otherwise correctly gold flare), each time after the hues were
    // corrected, which is the signature of a SUM rather than a colour. The viewmodel mesh owns the
    // first-person read by design, so the lever is this floor: past ~2.6 m nothing changes at all.
    const mk0 = 0.28 + 0.72 * Math.min(1, Math.max(0, (v.game.camera.position.distanceTo(p) - 0.4) / 2.2));
    // deepen(), not offsetHSL alone. The weapon colours are PALE by authoring (kinetic is 0xffe9c4, HSL
    // lightness 0.88) and `offsetHSL(0, +0.45, -0.07)` cannot deepen a near-white — saturating at L 0.81
    // leaves (1.00, 0.87, 0.62), whose smallest channel is 0.62. At hdr 6 BRUSH_MINCH_CAP then pins that
    // to 0.98 with the other two at 1.4-1.6, and the muzzle core tone-maps to rgb (252,247,225): a cream
    // flashbulb, flagged at 1204 px by the combat gate. This is the exact trap deepen() was written for
    // (see its comment) and every other preset already routes through it — the muzzle was the last one
    // that did not. Deepened, the min channel lands near 0.10, nothing caps, and the flash blooms GOLD.
    const sat = deepen(_c2.copy(c).offsetHSL(0, 0.45, -0.07));   // saturated element hue, forced deep
    const ember = deepen(_c3.copy(c).offsetHSL(0, 0.5, -0.3));   // deeper ember of the same hue: the fringe/fade-out colour
    // CO-LOCATED STACK (see stackK): the fringe petal, crisp petal, ember core, halo and afterglow are five
    // additive layers on the SAME pixel at the barrel — 20.7x summed hdr at noon. Each is deep and each
    // passes BRUSH_MINCH_CAP on its own; their SUM is what tone-mapped to the cream six-point flare the
    // combat gate flags (burst-cvfx-pfire-a-0/3/4). Budget the recipe as a whole, then let mk damp it again
    // for the double-drawn first-person case. Keep the hdr list below in sync with the five layers.
    // ...and the 8 SPARKS are born at the same point too, so their first frames pile on the same pixel as
    // the five quads (they are the residual white pinhead in cb-fix2 burst-cvfx-pfire-a-0, 174 px at rgb
    // 254,249,223, inside an otherwise correctly gold flare). Half weight: they leave at 18-36 m/s, so only
    // the first frame or two actually overlaps the core.
    const hot = (2.4 + 1.4 * day) + (4.5 + 1.8 * day) + (3.8 + 1.4 * day) + (3 + 1.5 * day) * 0.7 + (1.6 + 1.2 * day) * 0.8 + (5 + 3 * day) * 0.5;
    const mk = mk0 * stackK(sat, hot * mk0);
    // dark backing puff (alpha, 1-2 frames): gives the additive petal contrast at high sun; ~invisible at night
    if (day > 0.15) b.reset(v.alpha, p).jitter(0.06 * ds).spread(3.14).speed(0.2, 0.6).life(0.17).size(0.85 * ds, 1.1 * ds, 1.6).tex(TEX.SMOKE).color(0x241d14).vary(0.25).alpha(0.46 * day).rot().fade(0, 0.4).burst(2);
    b.reset(A, p).tex(TEX.FLARE).size(1.02 * ds, 1.22 * ds, 1.3).life(0.16).color(ember, ember).hdr((2.4 + 1.4 * day) * mk, (0.9) * mk).alpha(0.9).rot().fade(0, 0.25).burst(1);  // ember fringe petal: low HDR keeps the hue through ACES — this is the colour read
    // The two hot cores start SATURATED, not white. A white start is HOT_TINTed 55% toward the ember, which
    // leaves its smallest channel at ~0.52 of the colour — and at hdr 7-8 BRUSH_MINCH_CAP then pins that
    // smallest channel to exactly 0.98 while the other two ride 1.3-1.7. That is a bright CREAM, not a hue:
    // rgb (246,242,229) measured, a 4225 px six-point flare at the muzzle (combat gate burst-cvfx-pfire-a-7).
    // The cap can stop a value CLIPPING; it cannot invent chroma that the start colour never had. Starting
    // from `sat` puts the min channel near 0.12, so nothing caps, the dominant channel keeps the full noon
    // heat, and the flash blooms as fire in the weapon's own element — saturate the COLOUR, cap the VALUE.
    // ...and the two of them plus the halo and the afterglow all sit on the SAME pixel at the barrel, so
    // even in-hue they summed to a 487 px cream centre. Petal 8.5 -> 6.3, core 7 -> 5.2: the flash still
    // blooms hard, its centre now stays gold. Size and the ember fringe carry the punch.
    b.reset(A, p).tex(TEX.FLARE).size(0.58 * ds, 0.70 * ds, 1.4).life(0.15).color(sat, ember).hdr((4.5 + 1.8 * day) * mk, (2) * mk).rot().fade(0, 0.3).burst(1); // crisp petal cross
    b.reset(A, p).tex(TEX.STAR).size(0.34 * ds, 0.42 * ds, 1.3).life(0.13).color(sat, ember).hdr((3.8 + 1.4 * day) * mk, (1.6) * mk).rot().fade(0, 0.3).burst(1);      // warm ember core
    b.reset(A, p).tex(TEX.GLOW).size(0.30 * ds, 0.40 * ds, 1.4).life(0.12).color(sat, ember).hdr((3 + 1.5 * day) * mk, (1.2) * mk).alpha(0.7).fade(0, 0.3).burst(1); // small halo (support layer only)
    b.reset(A, p).tex(TEX.GLOW).size(0.34 * ds, 0.42 * ds, 0.35).life(0.34).color(ember, ember).hdr((1.6 + 1.2 * day) * mk).alpha(0.8).fade(0.02, 0.12).burst(1);  // hot-barrel afterglow, shrinking: the between-shots evidence
    b.reset(A, p).axis(d).spread(0.24).speed(18 * s, 36 * s).life(0.14, 0.34).size(0.02, 0.042, 0.4).tex(TEX.SPARK).color(0xffffff, ember).hdr((5 + 3 * day) * mk, (2) * mk).stretch(0.028).gravity(12).drag(2.5).fade(0, 0.5).burst(8 * k);
    b.reset(v.alpha, p).axis(d).spread(0.55).speed(1.4, 3.0).life(0.55, 0.95).size(0.22 * ds, 0.34 * ds, 3).tex(TEX.SMOKE).color(0x8c8c90).lit(L(v)).alpha(0.15 + 0.11 * day).rot().spin(2).drag(3).gravity(-0.8).fade(0.12, 0.3).burst(2 * k); // wisp lingers between shots
  },
  'spark-trail'(v, p, o, k, s, c) {
    if (o.size) s *= o.size / 0.15;  // projectile radius -> scale
    const b = v.brush;
    // Same range-fade as 'trail' (see its comment for the mechanism): the uMinW ~1.5 px floor means distant
    // motes stop shrinking while 70/s of them stack along the same few pixels — additive + overlapping +
    // not shrinking = a pale near-white streak, whatever hue we start from. Riftling + voidhorror sustained
    // ~375 live additive particles this way. Thin with range; saturated hue + low hdr carries the read.
    const cp = v.game.camera.position, dd = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z) || 1;
    // near-LENS damp on top of the range fade: an enemy bolt ends its flight AT the camera, and the last
    // ~45 mist quads of its trail overlap over most of the frame there — the white fill behind the dart in
    // the mix4 vale/shadowfen crops. The bolt's own core + halo carry the point-blank read.
    let near = (1 - 0.72 * Math.min(1, Math.max(0, (dd - 22) / 40))) * v._paleK(p) * Math.min(1, Math.max(0, (dd - 1.2) / 3));
    // HEAD-ON damp: a bolt flying at (or away from) the camera projects its whole trail onto a few dozen
    // pixels, so the mist quads stack into a white band whatever their per-quad value (probe vale1 c-4;
    // the r9 sunken smalls were the same geometry). o.dir is unit, opposite travel; ho ~ 1 when head-on.
    if (o.dir) { const ho = Math.abs(((cp.x - p.x) * o.dir.x + (cp.y - p.y) * o.dir.y + (cp.z - p.z) * o.dir.z) / dd);
      near *= 1 - 0.75 * Math.min(1, Math.max(0, (ho - 0.35) / 0.45)); }
    const sat = _c2.copy(c).offsetHSL(0, 0.35, -0.05);
    b.reset(v.add, p).jitter(0.02 * s).spread(3.14).speed(0, 0.3).life(0.18, 0.3).size(0.09 * s, 0.14 * s, 0.15).tex(TEX.GLOW).color(sat, sat).hdr(1.1 * near, 0.8 * near).alpha(0.38 * near).fade(0, 0.25).burst(1);   // alpha 0.5->0.38, hdr 1.4->1.1: the mist over the bolt's own core sphere is what bleached it to a pale egg (gate r3 vale, and again as the white trail streak in probe mix2) — the spark line + halo carry the trail read
    b.reset(v.add, p).axis(o.dir ?? UP).spread(0.35).speed(0.5, 2.2).life(0.2, 0.4).size(0.02 * s, 0.04 * s, 0.2).tex(TEX.SPARK).color(sat, sat).hdr(1.6 * near, 1.2 * near).stretch(0.03).gravity(3).drag(1).fade(0, 0.5).burst(1 + k);
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
    // Wave-3 vale: "meadow wisps still tone-map toward pale cyan-white at distance". Mechanism the pool
    // forces on us — Particles.js floors every sprite at uMinW (~1.5 px) so it never vanishes, which means
    // that past ~30 m these motes STOP shrinking while the emitter keeps laying 18/s of them along the same
    // few pixels. Additive + overlapping + not shrinking = a stacked pale core, whatever hue we start from.
    // So the trail thins out with range instead: the wisp's own body carries it from there.
    const cp = v.game.camera.position, dd = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z);
    const near = 1 - 0.72 * Math.min(1, Math.max(0, (dd - 22) / 40));
    const sat = _c2.copy(c).offsetHSL(0, 0.45 * day, -0.16 * day);
    if (day > 0.2) b.reset(v.alpha, p).jitter(0.05 * s).spread(3.14).speed(0, 0.25).life(0.3, 0.5).size(0.13 * s, 0.2 * s, 1.3).tex(TEX.SMOKE).color(0x140b22).vary(0.2).alpha(0.28 * day).rot().fade(0.05, 0.4).burst(1);
    b.reset(v.add, p).jitter(0.03 * s).spread(3.14).speed(0, 0.3).life(0.25, 0.45).size(0.1 * s, 0.16 * s, 0.1).tex(TEX.GLOW).color(sat, sat).hdr((1.1 - 0.5 * day) * near, (0.8 - 0.35 * day) * near).alpha((0.85 - 0.25 * day) * near).fade(0, 0.3).burst(2);
    if (Math.random() < 0.35) b.tex(TEX.STAR).size(0.06 * s, 0.1 * s, 0.3).life(0.3, 0.5).rot().spin(4).burst(1);
  },
  // ---- impacts -----------------------------------------------------------------------------------------------------
  'impact-terrain'(v, p, o, k, s, c) {
    const b = v.brush, n = axisOf(o, UP), fl = n.y > 0.5 ? p.y - 0.01 : -1e9;
    _v2.set(p.x + n.x * 0.25, p.y + n.y * 0.25, p.z + n.z * 0.25);   // lift the puff off the surface so it clears meadow grass blades
    // brief pop so the shot visibly lands even in grass. The old 0xfff0d0 x hdr 3 DISCARDED the element
    // colour and bypassed HOT_TINT (not exact white) — the vale "wisp bolt impact = hard white core on the
    // meadow". Elemental shots pop in their own saturated hue; plain kinetic stays a warm dust flash.
    // ...and the FADE-OUT colour is elemental too (see elemental()): a violet pop that ends warm-tan is
    // still a warm pixel on screen for most of its life — the void-amber finding was the sum of these tails.
    b.reset(v.add, p).tex(TEX.GLOW).size(0.16 * s, 0.22 * s, 1.6).life(0.08).color(elemental(o, c, 0xffc060, 0xd8b070), _c5).hdr(2, 1).fade(0, 0.3).burst(1);
    b.reset(v.alpha, _v2).axis(n).spread(0.9).speed(1.4 * s, 3.2 * s).life(0.9, 1.5).size(0.22 * s, 0.38 * s, 3.2).tex(TEX.SMOKE).color(DUST).lit(L(v)).vary(0.3).alpha(0.6).rot().spin(1.5).drag(2.5).gravity(-0.3).fade(0.08, 0.4).burst(6 * k);
    b.reset(v.alpha, p).axis(n).spread(0.8).speed(3 * s, 7 * s).life(0.5, 1.0).size(0.025 * s, 0.06 * s, 0.8).tex(TEX.DIRT).color(DIRT).lit(L(v)).vary(0.5).rot().spin(12).gravity(20).drag(0.5).floor(fl, 0.35).fade(0, 0.7).burst(10 * k);
    b.reset(v.add, p).axis(n).spread(0.7).speed(3 * s, 6 * s).life(0.15, 0.35).size(0.012, 0.022, 0.3).tex(TEX.SPARK).color(elemental(o, c, 0xffd070, 0xffa040), _c5).hdr(2.5, 1).stretch(0.025).gravity(14).drag(1).fade(0, 0.5).burst(2 * k);
  },
  dust(v, p, o, k, s, c) { PRESETS['impact-terrain'](v, p, o, k * 0.6, s, c); },
  'impact-rock'(v, p, o, k, s, c) {
    const b = v.brush, n = axisOf(o, UP), fl = n.y > 0.5 ? p.y - 0.01 : -1e9;
    // at 9 m a 2 cm spark is sub-pixel: chips and dust carry the read, the sparks are the sizzle on top
    b.reset(v.alpha, p).jitter(0.05 * s).spread(3.14).speed(0.3, 0.8).life(0.3, 0.5).size(0.22 * s, 0.34 * s, 1.8).tex(TEX.SMOKE).color(0x1a1512).vary(0.3).alpha(0.5 * v.day).rot().fade(0.02, 0.3).burst(2 * k);   // dark backing so the flash pops off a bright cliff
    // deep gold at x2.4, not cream 0xfff0c0 at x4.5: a low-saturation cream at 4.5x clips all three channels
    // and the 0.11 s pop lands as a small cream-white ball beside its own gold sparks (combat gate final9,
    // vale a-8: a bolt hitting a lamppost, 47 px at rgb 243,231,210). The sparks + chips + dark backing puff
    // ARE the rock-hit punch; the glow's job is warm colour, and a deep gold survives ACES as gold.
    b.reset(v.add, p).tex(TEX.GLOW).size(0.34 * s, 0.46 * s, 1.5).life(0.11).color(elemental(o, c, 0xe89a20, 0xff9040), _c5).hdr(2.4, 1.4).fade(0, 0.3).burst(1);   // 0xe89a20: S 0.76 / L 0.52 — inside the deepen() discipline; elemental() so a void bolt on voidstone does not flash gold
    b.reset(v.add, p).axis(n).spread(1.0).speed(5 * s, 14 * s).life(0.35, 0.8).size(0.03, 0.058, 0.5).tex(TEX.SPARK).color(elemental(o, c, 0xffcf5a, 0xff8030), _c5).hdr(5, 2.4).stretch(0.05).gravity(18).drag(1.2).floor(fl, 0.5).fade(0, 0.55).burst(14 * k);
    b.reset(v.alpha, p).axis(n).spread(0.9).speed(2 * s, 6 * s).life(0.5, 0.9).size(0.035 * s, 0.07 * s, 0.8).tex(TEX.DIRT).color(0x8a8684).lit(L(v)).vary(0.5).rot().spin(14).gravity(18).drag(0.4).floor(fl, 0.4).fade(0, 0.7).burst(8 * k);
    b.reset(v.alpha, p).axis(n).spread(0.8).speed(1 * s, 2.4 * s).life(0.5, 0.95).size(0.18 * s, 0.32 * s, 2.6).tex(TEX.SMOKE).color(0x9a9490).lit(L(v)).vary(0.3).alpha(0.45).rot().spin(2).drag(3).gravity(-0.3).fade(0.08, 0.35).burst(4 * k);
  },
  'impact-prop'(v, p, o, k, s, c) { PRESETS['impact-rock'](v, p, o, k, s, c); },
  sparks(v, p, o, k, s, c) {
    v.brush.reset(v.add, p).axis(axisOf(o, UP)).spread(o.spread ?? 1.0).speed(5 * s, 14 * s).life(0.3, 0.7).size(0.018, 0.034, 0.5).tex(TEX.SPARK).color(elemental(o, c, 0xffcf5a, 0xff8030), _c5).hdr(4, 2).stretch(0.03).gravity(18).drag(1.2).floor(p.y - 0.01, 0.5).fade(0, 0.55).burst(14 * k);
  },
  'impact-water'(v, p, o, k, s, c) {
    const b = v.brush;
    // spray/mist tinted toward ice-blue, not white: enemy bolts detonating on a frozen pond made a
    // near-white mist patch + sparkle that the combat gate flagged (r6 tundra crop). Water spray still
    // reads as spray at this tint; it just can't sit in the detector's desaturated-bright band.
    b.reset(v.alpha, p).axisUp().spread(0.5).speed(2 * s, 5 * s).life(0.5, 0.9).size(0.03, 0.06, 0.6).tex(TEX.GLOW).color(0xaaccec).lit(L(v)).alpha(0.7).gravity(14).drag(0.5).fade(0, 0.6).burst(14 * k);
    b.reset(v.alpha, p).axisUp().spread(0.7).speed(0.8, 1.8).life(0.5, 0.8).size(0.15 * s, 0.25 * s, 2.5).tex(TEX.SMOKE).color(0xb6d4e6).lit(L(v)).alpha(0.35).rot().drag(3).fade(0.05, 0.3).burst(3 * k);
    b.reset(v.add, p).axisUp().flat().tex(TEX.RING).size(0.1 * s, 0.1 * s, 8).life(0.6).color(0xffffff, 0x9fd8ff).hdr(1.5, 0.6).alpha(0.7).fade(0, 0.2).burst(1);
  },
  'impact-enemy'(v, p, o, k, s, c) {
    const b = v.brush, n = axisOf(o, UP), crit = !!o.crit, day = v.day;
    // OVERLAP GOVERNOR (energy share) — the same law 'explosion' carries, and the reason the extended
    // combat gate's player-fire burst failed: a hand cannon lands ~3 hits/s and every layer here lives
    // 0.13-0.45 s, so holding the trigger keeps 3-4 full stacks alive ON THE SAME PIXELS of the same
    // creature. Each stack is min-channel capped, but N capped stacks SUM past clip and ACES returns a
    // white ball (tools/out/cvfx-w7-base burst-cvfx-pfire-a-3.png: 11234 px at mean rgb 241,239,236 on a
    // hound's shoulder). The k-th concurrent impact within 1.6 m emits at 1/sqrt(k+1).
    // ...times a near-lens damp: a hound attacking fills 40% of the screen, and its hit flash at 1.5 m is
    // a sheet, not a spark (coherence: "you cannot tell what is hitting you"). ...times the pale-ground damp.
    const tNow = v.game.time, cp = v.game.camera.position;
    v._recentHit = v._recentHit?.filter((x) => tNow - x.t < 0.45) ?? [];
    const near = v._recentHit.filter((x) => (x.x - p.x) ** 2 + (x.y - p.y) ** 2 + (x.z - p.z) ** 2 < 2.56).length;
    v._recentHit.push({ t: tNow, x: p.x, y: p.y, z: p.z });
    const dd = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z);
    let hk = (1 / Math.sqrt(1 + near)) * (0.35 + 0.65 * Math.min(1, Math.max(0, (dd - 1.0) / 4.0))) * v._paleK(p);
    const k0 = k;                       // the DARK backing puff is the contrast the additive reads against — never thinned
    k *= Math.max(0.4, hk);             // thin the additive counts: overlap is what sums
    // Element identity survives ACES only at MODERATE HDR: anything above ~3x clips to white. So the hue lives in big,
    // saturated, low-HDR layers (halo, ring, motes) and only a small core is allowed to go white-hot.
    const sat = deepen(_c2.copy(c).offsetHSL(0, 0.45, -0.08));
    // CO-LOCATED STACK (see stackK): halo + tight halo + hot star + ring all start on the SAME pixel of the
    // creature — 9.1x summed hdr at noon on top of everything hk already damps. The overlap governor above
    // counts SEPARATE hits; this counts the layers of ONE hit, which nothing could see before (cb-fix1
    // burst-cvfx-pfire-nade-2, a 423 px cyan-white ring core at rgb 211,239,239). Keep the list in sync.
    // ...and the three SWARM layers below are born at p too, which nothing was counting: the 16 sparks
    // leave at 4-11 m/s (only their first frame overlaps, weight 0.35), the 6 ember flecks at 2-6 m/s
    // (0.6), but the 6 drifting stars crawl at 0.6-2 m/s under drag 2 and LIVE 0.5-0.9 s — they hover
    // on the impact pixel and complete each other to white. That is the white core with white star
    // flares inside an otherwise correct gold ring (cb-mask burst-cvfx-pfire-a-3, 139 px at rgb
    // 228,234,233): the quads were budgeted, the swarm that sits on top of them was not.
    // ...and the CRIT layers were never in this list, though the comment above says to keep it in sync.
    // A crit adds TWO more hot stars at hdr 3.5-5.0 plus a second ring, on the same pixel, at scale 1.35 —
    // about a third more summed energy than the budget this line computes, which is why the one frame the
    // gate photographed as a 2249 px white star (burst-cvfx-pfire-a-7, rgb 246,233,228, inside an
    // otherwise correct gold ring) was a critical hit. Every other damp here counts hits or distance;
    // none of them can see a branch that fires extra quads.
    hk *= stackK(sat, ((1.5 + 0.5 * day) + (2.6 + 1.0 * day) + (2.6 + 1.0 * day) + (2.4 + 1.0 * day)
      + (4.5 + 1.5 * day) * 0.35 + (3 + 1 * day) * 0.6 + (2.6 + 0.9 * day) * 1.5
      + (crit ? (3.5 + 1.5 * day) * 2 + (2.2 + 0.8 * day) : 0)) * hk);
    // dark aether backing puff (normal blend, un-lit): gives the additive pop contrast against bright noon grass/sky
    b.reset(v.alpha, p).jitter(0.09 * s).spread(3.14).speed(0.3, 0.9).life(0.45, 0.7).size(0.4 * s, 0.6 * s, 2.2).tex(TEX.SMOKE).color(0x120a1e).vary(0.3).alpha(0.78).rot().spin(2).drag(2).fade(0.05, 0.35).burst(5 * k0);
    b.reset(v.add, p).tex(TEX.GLOW).size(0.85 * s, 1.15 * s, 1.5).life(0.3).color(sat, sat).hdr((1.5 + 0.5 * day) * hk, 0.5 * hk).alpha(0.95).fade(0, 0.28).burst(1); // big saturated colored halo = THE element read
    b.reset(v.add, p).tex(TEX.GLOW).size(0.4 * s, 0.55 * s, 1.6).life(0.2).color(sat, sat).hdr((2.6 + 1.0 * day) * hk, 1.1 * hk).alpha(0.9).fade(0, 0.3).burst(1);
    b.reset(v.add, p).tex(TEX.STAR).size(0.26 * s, 0.34 * s, 1.4).life(0.13).color(deepen(_c3.copy(sat)), c).hdr((2.6 + 1.0 * day) * hk, 1.6 * hk).rot().fade(0, 0.3).burst(1);           // small hot core only, in the saturated hue (was white at hdr 9: the lost-region "near-white egg over the golem chest")
    b.reset(v.add, p).axis(n).spread(1.1).speed(4 * s, 11 * s).life(0.28, 0.6).size(0.04, 0.075, 0.3).tex(TEX.SPARK).color(sat, sat).hdr((4.5 + 1.5 * day) * hk, 2 * hk).stretch(0.06).gravity(7).drag(2.5).fade(0, 0.5).burst(16 * k);
    // ember flecks: brief saturated chunks that arc out and die fast — the physical "something broke off" presence the
    // wave-1 feel audit asked for. Saturated colour at moderate HDR (blob law: hue survives ACES, value never clips).
    b.reset(v.add, p).axis(n).spread(1.4).speed(2 * s, 6 * s).life(0.25, 0.5).size(0.05, 0.09, 0.5).tex(TEX.STAR).color(sat, sat).hdr((3 + 1 * day) * hk, 1.5 * hk).rot().spin(6).gravity(10).drag(1.5).fade(0, 0.5).burst(6 * k);
    b.reset(v.add, p).spread(3.14).speed(0.6, 2).life(0.5, 0.9).size(0.1 * s, 0.18 * s, 0.4).tex(TEX.STAR).color(sat, sat).hdr((2.6 + 0.9 * day) * hk).rot().spin(3).gravity(-1).drag(2).fade(0.05, 0.5).burst(6 * k);
    b.reset(v.add, p).axis(n).flat().tex(TEX.RING).size(0.42 * s, 0.42 * s, 7).life(0.45).color(sat, sat).hdr((2.4 + 1.0 * day) * hk, 0.9 * hk).alpha(1).fade(0, 0.18).burst(1);   // saturated ring, big enough to read at 8 m
    if (crit) { b.reset(v.add, p).tex(TEX.STAR).size(0.34 * s, 0.46 * s, 1.8).life(0.22).color(sat, sat).hdr((3.5 + 1.5 * day) * hk, 2 * hk).rot().spin(2).fade(0, 0.3).burst(2);
      b.reset(v.add, p).axis(n).flat().tex(TEX.RING).size(0.28 * s, 0.28 * s, 11).life(0.6).color(sat, sat).hdr((2.2 + 0.8 * day) * hk, 0.7 * hk).alpha(0.9).fade(0.04, 0.25).burst(1);  // crit: second wider ring
      b.reset(v.add, p).axis(n).spread(3.14).speed(4, 10).life(0.35, 0.7).size(0.026, 0.05, 0.3).tex(TEX.SPARK).color(0xffffff, sat).hdr((4.5 + 1.5 * day) * hk, 2.5 * hk).stretch(0.04).gravity(6).drag(2).fade(0, 0.5).burst(10 * k); }
  },
  blood(v, p, o, k, s, c) { PRESETS['impact-enemy'](v, p, o, k, s, c); },
  // ---- big ---------------------------------------------------------------------------------------------------------
  explosion(v, p, o, k, s, c) {
    // Destiny grenade cadence: fireball ~0.3s, then an aftermath that HOLDS at the site 2.5-4s:
    // slow dark smoke ball + a pumped smoke column (attach emitter ~1.8s), a low dust ring that lingers, embers that stay local.
    const b = v.brush, r = (o.radius ?? 3) * s, n = o.normal, A = v.add, AL = v.alpha;
    // Elemental explosions take the ELEMENT_COLORS pastel (arc/stasis 0x*d8ff, strand 0x7cff9c) — as a tracer
    // tint that is fine, but as the BODY colour of a whole fireball a pastel IS near-white: stasis/arc/strand
    // detonations were flagged as cream clouds in tundra/celestial/shadowfen. Deep-saturate it first.
    const fire = o.element === 'arc' || o.element === 'void' || o.element === 'stasis' || o.element === 'strand' ? _c2.copy(c).offsetHSL(0, 0.55, -0.18) : _c2.set(0xff5a18);
    const fl = n ? p.y - 0.02 : -1e9;
    // Blob decree re-author (wave-5: enemy bolts detonate AT the camera and this preset washed 8 of 10
    // regions near-white): every near-white literal is gone — the punch is a SATURATED fire hue at hdr low
    // enough that BRUSH_MINCH_CAP barely engages. An explosion reads as FIRE, not as a flashbulb.
    // Range fade (same mechanism note as 'trail'): past ~20 m the whole layer stack projects onto the same
    // few dozen pixels and adds up cream whatever the hue — thin the additive layers with distance.
    const cp = v.game.camera.position, dd = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z);
    // near-lens damping: a detonation 2-4 m out puts ~6 additive layers each covering 20-60% of the frame —
    // under the per-quad coverage fade, but their SUM is the celestial 36k-px cream sheet (cvfx-vfx4 a-4,
    // 9.1% wash). Point-blank punch is carried by shake/flash/kick, not by stacked value.
    // Floor 0.25, not 0.55: a stasis r=3 giant-throw detonating 1-3 m from the eye still washed the whole
    // frame at 0.55 on snow (combat gate r9 tundra; reproduced frozen at 0.13 s in the live tab) — ~6
    // additive layers each cover most of the frame there, so their SUM needs to fall much further. The
    // point-blank read is unchanged in kind: dark flash-front, smoke, ring sweep, PointLight, shake.
    const nf = 0.25 + 0.75 * Math.min(1, dd / 8);
    // ...and the SAME structural fade for the ALPHA layers, which had none of any kind. `nf`/`fr` only
    // ever reached the additive stack, so a detonation at your feet still spawned 14 smoke-ball quads +
    // 14 dust-ring quads + 5 scorch discs + the exp-smoke column, each 2-4 m across at 1-2 m from the
    // eye. Particles.js's coverage governor floors a single quad at 0.18 of its alpha — correct per quad,
    // but 33 of them at 0.18 still composite to an opaque film, and an ALPHA film does not clip to white
    // so no hue test can see it. That is a grenade repainting the world for a frame (cb-mask
    // burst-cvfx-pfire-nade-0: grass 122,102,147 under the blast against 90,87,105 once it clears).
    // Coverage is count x area, so thin the COUNT as well as the alpha — the aftermath still holds the
    // site, it just cannot own the viewport. Past 6 m nothing changes.
    const an = 0.34 + 0.66 * Math.min(1, dd / 6);
    const fr = (1 - 0.6 * Math.min(1, Math.max(0, (dd - 20) / 40))) * (o.dampen ?? 1) * nf * v._paleK(p);   // range fade × volley-overlap share × near-lens damp × pale-ground damp
    // Energy conservation for BIG detonations (icegiant throw r=3.0, skyserpent 1.5): the halo/ring quads
    // scale with r, so per-pixel additive intensity must fall as the area grows or a 5-m soft disc lands on
    // pale ground (snow, marble, sand) and lifts an already-bright surface into the detector's cream band —
    // combat gate r4's tundra/celestial residuals were exactly this, not a clipped element.
    const er = Math.min(1, 2.2 / Math.max(1e-3, r));
    // INSTANT dark backing (the muzzle/impact-enemy contrast trick at fireball scale). Combat gate r4's
    // remaining residuals were all "additive element hue over a PALE floor" (tundra snow, celestial marble,
    // sunken sand): the sum starts from an already-bright base, so even a capped additive stack lifts it
    // into the detector's cream band. A same-frame dark flash-front under the fireball makes the additive
    // layers read against DARK — the punch comes from contrast, not from more value.
    b.reset(AL, p).jitter(0.22 * r).spread(3.14).speed(0.3 * r, 0.8 * r).life(0.32, 0.5).size(0.42 * r, 0.6 * r, 2.1).tex(TEX.SMOKE).color(0x1a1109, 0x261b10).vary(0.3).alpha(0.58 * (o.dampen ?? 1)).rot().spin(1.5).drag(1.5).fade(0, 0.35).burst(3);
    b.reset(A, p).tex(TEX.GLOW).size(0.38 * r, 0.5 * r, 1.9).life(0.16).color(fire, fire).hdr(3 * fr * er, 1.5 * fr * er).fade(0, 0.25).burst(1);                // hot core in the FIRE hue itself (er: the core quad scales with r too — a big detonation's per-pixel energy must fall as its area grows)
    b.reset(A, p).tex(TEX.GLOW).size(1.1 * r, 1.3 * r, 1.5).life(0.28).color(fire, 0x7a1800).hdr(1.2 * fr * er, 0.3).alpha(0.85).fade(0, 0.25).burst(1);        // warm halo (er: per-pixel energy falls as the disc grows)
    b.reset(A, p).tex(TEX.FLARE).size(1.4 * r, 1.7 * r, 1.5).life(0.11).color(fire, 0x8a2000).hdr(2.2 * fr * er, 1).rot().fade(0, 0.2).burst(1);           // flare petals in the element hue, not cream-white
    b.reset(A, p).jitter(0.3 * r).spread(3.14).speed(1.6 * r, 4 * r).life(0.5, 1.0).size(0.18 * r, 0.36 * r, 2.6).tex(TEX.SMOKE).color(fire, 0x8a1a00).hdr(1.2 * fr * er, 0.25).vary(0.5).alpha(0.85).rot().spin(3).drag(3.2).gravity(-2.5).fade(0.0, 0.3).burst(Math.max(4, Math.round(12 * k * fr))); // fire tongues (12 not 22 at hdr 1.2: a stack of tongues clips its BLUE channel first and the whole pile goes cream — fewer, dimmer, still fire)
    // smoke ball: Destiny grenade gradient — fire-lit orange-brown -> mid grey-brown -> dark. Starts SMALL and semi-transparent
    // and grows (endMul 3.4), so 0.2-1.0 s reads as a churning fireball, not an instant ink blob.
    // Smoke lit by THIS detonation, not always by a fire-orange one. At 0xb06a2e x hdr 1.7 the start colour
    // was (1.17, 0.71, 0.31) — over clip on red — on a 2-7 m ALPHA quad, 14 of them, with no range/near
    // fade of any kind on the alpha layers: a detonation 2-4 m from the eye painted the whole viewport a
    // flat rust-orange for a full second in a GREEN region (shadowfen, tools/out/sf-fight/burst-fight2-0.png)
    // and read as an orange curtain in dragon/infernal/celestial. Hue follows the element, value under clip,
    // and Particles.js's coverage governor now owns the near-camera case for every layer at once.
    const smk = _c3.copy(fire).offsetHSL(0, -0.15, -0.30);
    b.reset(AL, p).jitter(0.25 * r).spread(3.14).speed(0.35 * r, 0.85 * r).life(2.2, 3.4).size(0.26 * r, 0.42 * r, 3.4).tex(TEX.SMOKE).color(smk, 0x272119).hdr(1.15, 0.8).lit(L(v)).vary(0.35).alpha(0.55 * an).rot().spin(0.6).drag(1.0).gravity(-0.7).fade(0.16, 0.55).burst(Math.max(4, Math.round(14 * k * an)));
    v.attach('exp-smoke', v._anchor(p), { duration: 1.8, rate: Math.max(4, 11 * v.mult * an), scale: r / 3 });                                            // smoke column keeps pumping from the site
    _v3.set(p.x, p.y + (n ? 0.95 : 0), p.z);                                                                                                          // grounded ring lifts clear of 1 m meadow grass
    if (n) b.reset(A, _v3).axis(n).flat(); else b.reset(A, _v3).rot();
    // hdr 1.15 / alpha 0.78, not 1.8 / 0.95. This annulus GROWS 9x while its colour is fixed at spawn, so
    // unlike every other layer here its per-pixel energy cannot fall with its area — at full extent it is a
    // ~11 m band lying across sunlit grass, and the gate photographs it as a pale lavender stripe with a
    // second one under it (cb-s2 burst-cvfx-pfire-nade-4, rgb 244,222,242). A shockwave reads by its SWEEP
    // and its size; `shockwave()` and the `ring` preset both already learned this exact lesson (2.4 -> 1.5,
    // 2.6 -> 1.7). Deep fire hue at 1.15 still blooms in its own colour over grass.
    b.tex(TEX.RING).size(0.42 * r, 0.42 * r, 9).life(0.55).color(fire, fire).hdr(1.15 * fr * er, 0.6 * fr * er).alpha(0.78).fade(0, 0.18).burst(1);                        // shockwave — SATURATED start: this ring grows to ~4r and a detonation at the lens fills the frame bottom with it; a white start (even min-channel-capped) is a large near-white sheet
    if (n) { _v3.set(p.x, p.y + 1.05, p.z);                                                                                                            // dust ring rides above the grass tops
      b.reset(AL, _v3).axis(n).ring(0.35 * r, 0.6 * r, 0.2).speed(1.3, 2.4).life(2.4, 3.8).size(0.3 * r, 0.5 * r, 2.4).tex(TEX.SMOKE).color(0x9c8760, 0x7a6a4e).lit(L(v)).vary(0.3).alpha(0.55 * an).rot().spin(0.8).drag(1.0).gravity(-0.15).fade(0.05, 0.6).burst(Math.max(4, Math.round(14 * k * an)));   // lingering TAN dust ring: light against green grass, dark against sky
      _v3.set(p.x, p.y + 0.9, p.z);                                                                                                                    // scorch "haze" discs: the decal itself is buried under 1 m grass, this is the visible char
      b.reset(AL, _v3).axis(n).flat().ring(0, 0.5 * r).tex(TEX.SMOKE).size(0.75 * r, 1.05 * r, 1.15).life(7, 10).color(0x241d16, 0x2b241b).vary(0.3).alpha(0.5 * an).rot().fade(0.06, 0.45).burst(Math.max(2, Math.round(5 * an))); }
    b.reset(A, p).axisUp().spread(3.14).speed(1.2 * r, 3.2 * r).life(1.4, 2.6).size(0.022, 0.05, 0.35).tex(TEX.SPARK).color(_c4.copy(fire).offsetHSL(0, 0, 0.1), fire).hdr(2.0 * fr, 0.7)   // was the raw literal 0xffb050 (min channel 0.078 linear, and WARM whatever the element: a void grenade threw amber embers). A lift of the detonation's own hue instead — hotter-looking, still deep, still the element.stretch(0.03).gravity(8).drag(1.0).floor(fl, 0.3).fade(0, 0.6).burst(Math.round(30 * k * fr));       // lingering embers (local: capped speed so they don't pile 10 m away)
    b.reset(A, p).jitter(0.4 * r).axisUp().spread(1.2).speed(0.4, 1.2).life(1.4, 2.4).size(0.05 * r, 0.09 * r, 0.4).tex(TEX.GLOW).color(fire, 0xff3000).hdr(1.8 * fr * er, 0.5).alpha(0.55).gravity(-0.5).drag(1.5).fade(0.1, 0.5).burst(Math.round(10 * k * fr));       // floating hot motes
    b.reset(AL, p).axisUp().spread(2.2).speed(1.2 * r, 3 * r).life(0.8, 1.5).size(0.04 * s, 0.1 * s, 0.9).tex(TEX.DIRT).color(DIRT).lit(L(v)).vary(0.5).rot().spin(15).gravity(22).drag(0.3).floor(fl, 0.3).fade(0, 0.75).burst(14 * k);    // debris
    v.flash(p, { color: fire, intensity: 1.2 * s, distance: 6 * r, duration: 0.3 });   // was 6*s: the creatures-1 bisect showed these lights co-author the wash — at 14+ they still lit a melee golem's boulder arm to cream at 1 m
  },
  'exp-smoke'(v, p, o, k, s, c) {
    // one column puff per emitter tick: slow rise (~1-1.5 m/s), long life, dark and thick so it reads on grass at noon
    v.brush.reset(v.alpha, p).jitter(0.5 * s).axisUp().spread(0.4).speed(0.8, 1.6).life(2.0, 3.0).size(0.7 * s, 1.2 * s, 2.9).tex(TEX.SMOKE)
      .color(0x5a4e40, 0x241f1a).lit(L(v)).vary(0.35).alpha(0.7).rot().spin(0.5).drag(0.5).gravity(-0.45).fade(0.14, 0.6).burst(1);
  },
  'aether-burst'(v, p, o, k, s, c) {
    const b = v.brush, A = v.add, day = v.day;
    // DEEP-saturate — drop lightness too, exactly like 'explosion' does. Enemies feed this preset their
    // glowColor on every stagger/shield-break/hit react, and half the bestiary's glow is a PASTEL
    // (icegiant 0x9fd8ff->white, seraph 0xffd27a, bogwitch 0x7cff9c): saturating without deepening left
    // the burst near-white, which was the combat gate's tundra star-sparkle cluster, the celestial warm
    // cream patches and the shadowfen green cores (cvfx-vfx3 run). Hue survives ACES iff it starts DEEP.
    const sat = _c2.copy(c).offsetHSL(0, 0.55, -0.16);
    // A NEAR-WHITE glowColor is still near-white after +0.55 saturation at L~0.9 (HSL: saturating white
    // does nothing). Force the burst DEEP regardless of the source pastel: L clamped to <=0.55, S floored
    // at 0.7 — the frostwolf/icegiant pale-cyan dome on snow (cvfx-vfx6 tundra crop) was this survivor.
    sat.getHSL(_hsl2);
    if (_hsl2.l > 0.55 || _hsl2.s < 0.7) sat.setHSL(_hsl2.h, Math.max(_hsl2.s, 0.7), Math.min(_hsl2.l, 0.55));   // same pair as deepen() — see its note
    const pg = v._paleK(p), day2 = day * pg;   // pale-ground damp scales every additive layer below; the veil strengthens to carry the read
    const mk = o.tick ? 0.3 : 1;
    // CO-LOCATED STACK BUDGET (see stackK) — this preset was the LAST big one with none, and it is the
    // hottest additive in the game: 90 star motes at hdr up to 3.7 and 42 glow motes at 3.0, all born
    // inside one 0.1-0.3 m ball, on top of two halos and a ring. Each mote passes BRUSH_MINCH_CAP alone
    // (a deepened cyan's smallest channel is 0.235 linear, and 0.235 x 3.7 = 0.87); TWO of them overlapping
    // is already past clip, and 90 of them overlap by construction. That is the hard white core inside the
    // otherwise-correct cyan starburst on a dying Lost sentinel (tools/out/cb-s2 burst-cvfx-lost-k-1, and
    // the 1871 px warm one on the gold sentinel in lost-k-0). Every enemy stagger, shield break and hit
    // react fires this, so it is in nearly every frame the gate has ever flagged. Weights = how many of a
    // swarm actually land on one pixel: 2.5 of the 90 stars, 1.5 of the 42 glows. Keep in sync below.
    // `pk` (additive) is the ground damp TIMES the stack budget; `pg` (the veil) stays on the raw ground
    // damp, so damping the burst never turns the dark backing puff into an ink blob.
    const pk = pg * stackK(sat, ((o.tick ? 0 : (1.6 + 0.6 * day2) + (1.8 + 0.6 * day2) + (2.4 + 1.0 * day2))
      + (2.7 + 1.0 * day2) * 2.5 * mk + (2.2 + 0.8 * day2) * 1.5 * mk) * pg);
    // dark aether veil. Widened from 0.16-0.26 (cvfx-vfx4): enemies pour this preset onto PALE ground —
    // the icegiant's frost-hazard fountain re-emits it every 0.4 s on snow — and additive cyan over a white
    // base washes at ANY strength; the veil is the dark the burst reads against. Still brief and violet-dark,
    // so at noon it reads as roiled aether shadow, not an ink blob.
    b.reset(v.alpha, p).jitter(0.16 * s).axisUp().spread(1.4).speed(0.5, 1.4).life(0.7, 1.2).size(0.3 * s, 0.44 * s, 1.8).tex(TEX.SMOKE).color(0x140b24, 0x1d1230).vary(0.3).alpha(0.42 * (2 - pg)).rot().spin(1.5).drag(1.5).gravity(-0.8).fade(0.06, 0.35).burst(4 * k);
    // o.tick = a PERIODIC caller (the hazard fountain re-fires this every 0.4 s at ONE spot). The big
    // halo layers have 0.3-0.45 s lives, so ticks keep 2+ of them overlapping at the same pixels forever
    // — even a deep hue stacks pale that way (combat gate r7: the tundra 7.3k / shadowfen 3.1k patches
    // at the hazard site). A tick gets veil + a modest mote plume only; the one-shot burst keeps its pop.
    if (!o.tick) {
      b.reset(A, p).tex(TEX.GLOW).size(0.7 * s, 0.95 * s, 2.2).life(0.45).color(sat, sat).hdr((1.6 + 0.6 * day2) * pk, 0.5 * pk).alpha(0.95).fade(0, 0.3).burst(1);   // big saturated violet bloom = the magic read
      b.reset(A, p).tex(TEX.GLOW).size(0.36 * s, 0.46 * s, 2.6).life(0.3).color(sat, sat).hdr((1.8 + 0.6 * day2) * pk, 1.1 * pk).alpha(0.9).fade(0, 0.3).burst(1);   // x1.8+0.6 (was 4+2): a deep green at x5 clips ALL channels, and even deep gold at x3.6 clipped its top two into a warm-white muzzle core (probe vale1 a-8) — the big halo + ring + motes carry the pop
    }
    b.reset(A, p).jitter(0.1 * s).axisUp().spread(1.2).speed(2 * s, 4 * s).life(1.0, 1.8).size(0.18 * s, 0.3 * s, 0.4).tex(TEX.STAR).color(sat, sat).hdr((2.7 + 1.0 * day2) * pk * mk, 1.8 * pk * mk).rot().spin(4).swirl(4, 7, true).gravity(-1.5).drag(1.0).fade(0.05, 0.5).burst(Math.max(3, Math.round(90 * k * mk)));   // 2x mote size, saturated; hdr 2.7 not 3.2 — swirling stars over snow were the tundra 21-cluster sparkle field
    b.reset(A, p).jitter(0.1 * s).axisUp().spread(1.3).speed(1.5 * s, 3 * s).life(0.9, 1.6).size(0.24 * s, 0.42 * s, 0.5).tex(TEX.GLOW).color(sat, sat).hdr((2.2 + 0.8 * day2) * pk * mk).alpha(0.7).swirl(3, 6, true).gravity(-1.2).drag(1.2).fade(0.05, 0.5).burst(Math.max(2, Math.round(42 * k * mk)));
    if (!o.tick) b.reset(A, p).axisUp().flat().tex(TEX.RING).size(0.42 * s, 0.42 * s, 6).life(0.6).color(sat, sat).hdr((2.4 + 1.0 * day2) * pk, 0.9 * pk).alpha(0.95).fade(0, 0.2).burst(1);
  },
  death(v, p, o, k, s, c) {
    // the kill reward: dark void veil first, then a saturated pop + double ring + rising motes — most readable vfx in the game
    const b = v.brush, A = v.add, day = v.day;
    // ENERGY CONSERVATION BY CREATURE SIZE (wave-6 forest BLOB, tools/out/F6-fight/burst-treantfight-0.png:
    // killing an Elder Treant at 16 m produced 8978 px of near-white pale-cyan bloom with hard 8-point star
    // flares). `s` is radius/0.5, so a treant/golem kills at s = 3 — every layer below was 3x LONGER, i.e.
    // 9x the screen AREA, at the SAME per-pixel additive value, and the counts did not drop either. 36
    // stars of 1.1 m each at hdr 5.2, overlapping inside one 3 m ball: BRUSH_MINCH_CAP is per particle, so
    // N capped particles still SUM past clip and ACES hands back a white mass with star flares.
    // Same three laws `explosion` already carries, which `death` never got: area-conserving energy (er),
    // range + near-lens fade, pale-ground damp. A big creature's death is BIGGER, not BRIGHTER.
    const er = Math.min(1, 1.35 / Math.max(1, s));                       // s=1 untouched; s=3 -> 0.45 (area grew 9x)
    const cp = v.game.camera.position, dd = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z);
    const nk = 0.3 + 0.7 * Math.min(1, dd / 7);                          // a kill AT the lens must not fill the frame
    // Range fade from 8 m, not 20 (measured: tools/out/cvfx-w7 burst-cvfx-vale-k-1, a 12 m sentinel kill,
    // 1606 px at mean rgb 214,238,236). The mote cloud is ~2 m across, so by ~12 m all 36 stars project
    // onto the same few hundred pixels and their SMALLEST channel accumulates until the sum is white —
    // BRUSH_MINCH_CAP is per particle and cannot see a stack. Same mechanism note as 'trail'/'explosion'.
    const rk = 1 - 0.55 * Math.min(1, Math.max(0, (dd - 8) / 32));
    let fk = er * nk * rk * v._paleK(p);
    const ck = Math.max(0.35, er);                                        // and thin the COUNTS too: overlap is what sums
    b.reset(v.alpha, p).jitter(0.35 * s).spread(3.14).speed(0.4, 1.2).life(1.5, 2.4).size(0.35 * s, 0.6 * s, 2.4).tex(TEX.SMOKE).color(0x0e0817, 0x1a1026).vary(0.3).alpha(0.72).rot().spin(1).drag(2).gravity(-0.6).fade(0.04, 0.45).burst(10 * k);
    const dsat0 = deepen(_c3.copy(c).offsetHSL(0, 0.4, -0.06));   // rings grow LARGE (2.7 m): pastel glowColors must go DEEP or the pop is a pale ball (gate r5 tundra)
    // CO-LOCATED STACK (see stackK): pop glow 3 + pop star 3.5 + ring 3.5 + ring 3 all start on the SAME
    // pixel at the corpse. Each is deep, each passes BRUSH_MINCH_CAP, and their 13x summed hdr is what the
    // combat gate photographs as the kill-pop white core (burst-cvfx-lost-k-0 at rgb 248,242,223, and the
    // vale sentinel kills at 219,237,234). fk already carries size/range/lens/pale damping; this closes the
    // one thing none of those can see. Keep the 13 in sync with the four layers below.
    // ...plus the MOTE SWARM, which is the layer the gate was actually photographing (cb-mask
    // burst-cvfx-lost-k-1: 178 px at rgb 209,239,238, a large cyan-white cloud full of hard star
    // flares around a dying golem — see the crop). 24 stars at hdr 2.6 and 6 glow motes at 1.2 are all
    // born inside one 0.6-0.95*s ball and drift at 0.5-2.8 m/s for 1.6-3.0 s: ~3 of the stars and
    // ~1.5 of the glows sit on any given pixel, and each one's smallest channel adds. The four pop
    // quads were budgeted; the thirty particles piled on them were not. Sparks leave fast (0.4).
    fk *= stackK(dsat0, (13 + (1.9 + 0.7 * day) * 3 + (0.9 + 0.3 * day) * 1.5 + 4 * 0.4) * fk);
    // pop in the creature's own hue, not white: at hdr 5-7 the HOT_TINTed white still landed as a pale
    // ball post-cap (combat gate r3: tundra 22k-px cluster at rgb 232,234,233 was exactly this pop over
    // a dead wisp). The punch is the SIZE + double ring + flash; the colour is the element.
    b.reset(A, p).tex(TEX.GLOW).size(0.42 * s, 0.55 * s, 2.2).life(0.28).color(dsat0, dsat0).hdr(3 * fk, 1.5 * fk).fade(0, 0.3).burst(1);
    b.reset(A, p).tex(TEX.STAR).size(0.55 * s, 0.7 * s, 2).life(0.24).color(dsat0, dsat0).hdr(3.5 * fk, 1.8 * fk).rot().fade(0, 0.3).burst(1);
    b.reset(A, p).axisUp().flat().tex(TEX.RING).size(0.3 * s, 0.3 * s, 9).life(0.55).color(dsat0, dsat0).hdr(3.5 * fk, 1.5 * fk).alpha(0.9).fade(0, 0.2).burst(1);
    b.reset(A, p).axisUp().flat().tex(TEX.RING).size(0.15 * s, 0.15 * s, 12).life(0.75).color(dsat0).hdr(3 * fk, 1.2 * fk).alpha(0.7).fade(0.1, 0.3).burst(1);
    // afterglow motes: at 8 m the old 0.11 m stars were sub-pixel and the kill tail vanished by 0.75 s. 2x size, longer life,
    // saturated at moderate HDR so the element colour holds through noon exposure — the payoff now reads for ~2.5 s.
    // The star sprite is an 8-POINT FLARE: at s=3 it is a metre across, and 36 of them at hdr 5.2 is exactly
    // the "hard 8-point star flares" the forest critic photographed. Size no longer scales linearly with s.
    const ss = Math.sqrt(s);                                             // 3x creature -> 1.7x mote, not 3x
    const dsat = deepen(_c2.copy(c).offsetHSL(0, 0.35, 0));
    // 24 stars at hdr 1.9, not 36 at 5.2. The kill tail's read comes from HOW LONG it lives (1.8-3.0 s) and
    // from the double ring, not from per-mote value: 36 overlapping stars whose smallest channel is 0.36
    // linear complete each other to white after ~6 of them overlap, whatever hue each one started from.
    b.reset(A, p).jitter(0.6 * s).axisUp().spread(0.5).speed(1.0, 2.8).life(1.8, 3.0).size(0.22 * ss, 0.36 * ss, 0.4).tex(TEX.STAR).color(dsat, dsat).hdr((1.9 + 0.7 * day) * fk, 1.0 * fk).rot().spin(3).swirl(1.5, 3, true).gravity(-1.5).drag(0.8).fade(0.08, 0.6).burst(Math.max(8, Math.round(24 * k * ck)));
    // The soft GLOW motes are the layer that actually clipped: dsat for arc is (0.10, 0.65, 1.00), so its
    // SMALLEST channel is 0.10 and BRUSH_MINCH_CAP never engages — but 10 of them piled inside one 1 m ball
    // sum that 0.10 ten times over and the cloud completes to pale cyan (measured 540 px at rgb 212,238,236
    // on a dying hound, burst-cvfx-vale-k-1). Fewer, dimmer, spread wider: overlap is the whole mechanism.
    b.reset(A, p).jitter(0.95 * s).axisUp().spread(0.9).speed(0.5, 1.6).life(1.6, 2.6).size(0.42 * ss, 0.75 * ss, 0.4).tex(TEX.GLOW).color(dsat, dsat).hdr((0.9 + 0.3 * day) * fk).alpha(0.6).gravity(-0.8).drag(1).fade(0.1, 0.55).burst(Math.max(3, Math.round(6 * k * ck)));
    b.reset(A, p).jitter(0.3 * s).spread(3.14).speed(3, 7).life(0.4, 0.8).size(0.02, 0.04, 0.3).tex(TEX.SPARK).color(dsat0, dsat0).hdr(4 * fk, 2 * fk).stretch(0.03).gravity(8).drag(2).fade(0, 0.5).burst(16 * k);
    v.flash(p, { color: c, intensity: 2 * Math.min(s, 1.6), distance: 10, duration: 0.4 });   // was 2*s: a treant's 6.0 lit the whole clearing to cream
  },
  // ---- rings / sigils / FF14 magic ----------------------------------------------------------------------------------
  ring(v, p, o, k, s, c) {
    const n = o.normal ?? UP;
    _v2.set(p.x + n.x * 1.0, p.y + n.y * 1.0, p.z + n.z * 1.0);   // lift clear of grass blades (~1 m meadow)
    const b = v.brush.reset(v.add, _v2).axis(n).flat();
    const rc = deepen(_c.copy(c));   // shield-break/telegraph rings grow large — a white start is a white annulus (same law as shockwave)
    const rk = v._paleK(p);          // and over snow/marble even a deep hue sums pale — same damp as shockwave
    b.tex(TEX.RING).size(0.2 * s, 0.2 * s, (o.radius ?? 2) * s / 0.1).life(o.duration ?? 0.5).color(rc, rc).hdr(1.7 * rk, 0.9 * rk).alpha(0.9).fade(0, 0.2).burst(1);   // x1.7 not x2.6: a deep cyan/teal at x2.6 clips two channels and blooms white (same lesson as shockwave)
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
    v.brush.reset(v.add, p).ring(0.7 * s, 1.1 * s, 0, 0).speed(-2.2 * s, -2.8 * s).life(0.35, 0.4).size(0.03 * s, 0.07 * s, 0.2).tex(TEX.SPARK).color(c, c).hdr(2, 3.2).stretch(0.04).fade(0.2, 0.7).burst(Math.max(1, k));   // converge brightens via hdr, not toward white (telegraph windups fill the frame with these)
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
