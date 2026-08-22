import * as THREE from 'three';
import { DEFS, DEFAULT_SLOTS, ELEMENT_COLORS } from './weapons/defs.js';
import { makeMaterials, buildGun, makeFlash, buildAbilityHand } from './weapons/models.js';

/**
 * Weapons: definitions, first-person viewmodel, firing, recoil, ADS, reload, swap. Destiny 2 feel is THE bar: archetypes that feel
 * distinct (rpm, recoil pattern, damage falloff, handling), punchy audio/visual feedback, snappy ADS, reload with weight.
 *
 * Archetypes: handcannon (140rpm, heavy recoil, crisp), autorifle (600rpm, controllable), pulse (3-burst), shotgun (pellets, short range),
 *   sniper (high zoom, bolt, huge crit), fusion (charge then 7 bolts). Slots: [kinetic, energy] (two, user call). Keys 1/2 + wheel swap, R reload, LMB fire, RMB ADS (hold; tap = toggle).
 * Viewmodel: procedurally modeled guns (src/player/weapons/models.js) rendered in an OVERLAY scene (own PerspectiveCamera fov 55) via game.postfx.setOverlay(scene, camera),
 *   lit by own sun/hemi mirroring game.sky + a muzzle point light + a small PMREM env for the metals. Procedural animation layers: idle sway/breath, walk/sprint bob
 *   (reads controller), sprint lowered pose, ADS blend (sight marker on the camera axis; view.setAds), recoil springs (per-archetype), reload (per style: mag/cylinder/pump/bolt/cell
 *   with visible moving parts), swap (lower/raise ~0.4 s), landing dip, look-lag sway (view.sway if present, else from mouse velocity), moving parts on fire (bolt/hammer/pump/bolt-cycle).
 * Firing: rpm-accurate cadence, game.combat.hitscan per shot/pellet, hip spread + bloom, camera kick via view.kick, ammo/reserve/reload, empty click + auto-reload,
 *   muzzle flash mesh (petals+star, ~2 frames) + vfx.emit('muzzle') + vfx.tracer + vfx.flash + audio.play('shot-<archetype>').
 * Exposes: game.player.weapons.current = { id, name, archetype, element, ammo, magSize, reserve, damage, rpm, range, zoom, ads:0..1, reloading, firing, rarity, spread(rad), charge(0..1, fusion) }
 *          slots[2], index, swap(i), reload(), addAmmo(slotIndex, n), muzzleWorld (Vector3), fireCount, give(id, slot) (any of DEFS keys), defs, setAds(bool),
 *          setHidden(bool) (stow/hide the viewmodel + block firing — Abilities takes the hands over during the super)
 * Events: 'weapon:fire' {weapon, hit, origin, dir}, 'weapon:reload' {weapon}, 'weapon:reloaded' {weapon}, 'weapon:swap' {weapon}, 'weapon:empty' {weapon}
 */

const VM_SCALE = 0.85; // Destiny-style: viewmodel a bit smaller than world scale so it blocks less of the screen
class Spring { constructor(k, c) { this.x = 0; this.v = 0; this.k = k; this.c = c; } update(dt) { const n = Math.max(1, Math.ceil(dt / 0.008)); const h = dt / n; for (let i = 0; i < n; i++) { this.v += (-this.k * this.x - this.c * this.v) * h; this.x += this.v * h; } return this.x; } }
// piecewise smoothstep keyframes: keys = [[t, v], ...]
function kf(p, keys) {
  if (p <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (p <= keys[i][0]) { const a = keys[i - 1], b = keys[i]; const u = (p - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * u * u * (3 - 2 * u); }
  return keys[keys.length - 1][1];
}
const bump = (x) => (x > 0 && x < 1) ? Math.sin(x * Math.PI) : 0;
const smooth = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
const K = { // reload keyframes per style (p = 0..1 of reload duration). Mag choreography kept WIDE (0.3..0.6 out) so it reads on camera.
  magRoll: [[0, 0], [0.12, 0.7], [0.82, 0.6], [1, 0]], magTilt: [[0, 0], [0.12, 0.34], [0.5, 0.26], [0.82, 0.32], [1, 0]], magDip: [[0, 0], [0.12, 0.02], [0.85, 0.015], [1, 0]],
  magOutY: [[0, 0], [0.16, 0], [0.30, -0.15], [0.60, -0.15], [0.76, 0], [1, 0]], magOutRx: [[0, 0], [0.16, 0], [0.30, 0.55], [0.60, 0.55], [0.76, 0], [1, 0]],
  boltZ: [[0.78, 0], [0.85, 0.035], [0.92, 0.035], [0.96, 0], [1, 0]], jolt: [[0.9, 0], [0.94, -0.012], [1, 0]],
  snBoltRz: [[0, 0], [0.1, -1.1], [0.84, -1.1], [0.95, 0], [1, 0]], snBoltZ: [[0.1, 0], [0.2, 0.07], [0.76, 0.07], [0.86, 0], [1, 0]],
  snMagY: [[0.22, 0], [0.36, -0.13], [0.55, -0.13], [0.7, 0], [1, 0]],
  // tempered so the gun stays ON SCREEN and the crane-out cylinder reads; yaw shows the open cylinder to the camera
  cylRoll: [[0, 0], [0.12, 0.30], [0.8, 0.26], [0.9, -0.08], [1, 0]], cylTilt: [[0, 0], [0.1, 0.28], [0.35, 0.32], [0.5, -0.16], [0.75, -0.16], [0.9, 0.04], [1, 0]],
  cylYaw: [[0, 0], [0.15, -0.42], [0.78, -0.38], [0.92, 0], [1, 0]],
  cylX: [[0, 0], [0.12, 0], [0.24, -0.045], [0.78, -0.045], [0.9, 0], [1, 0]], cylSpin: [[0.24, 0], [0.5, 9.4], [0.78, 12.57], [1, 12.57]],
  pumpRoll: [[0, 0], [0.12, -0.4], [0.85, -0.35], [1, 0]], pumpTilt: [[0, 0], [0.12, 0.28], [0.85, 0.22], [1, 0]], pumpZ: [[0, 0], [0.08, 0.07], [0.88, 0.07], [0.96, 0], [1, 0]],
  cellTilt: [[0, 0], [0.12, -0.32], [0.8, -0.3], [1, 0]], cellY: [[0, 0], [0.08, 0], [0.26, -0.14], [0.62, -0.14], [0.78, 0], [1, 0]], cellSpin: [[0.08, 0], [0.72, 6.28], [1, 6.28]],
  cellGlow: [[0, 1], [0.24, 0.08], [0.66, 0.08], [0.78, 2.2], [1, 1]],
  // support-hand reach weights (0 = at its idle grip, 1 = on the mag/cell/loader)
  lReachMag: [[0, 0], [0.05, 0], [0.17, 1], [0.74, 1], [0.90, 0], [1, 0]],
  lReachBolt: [[0.04, 0], [0.18, 1], [0.62, 1], [0.78, 0], [1, 0]],
  lReachCyl: [[0.06, 0], [0.26, 1], [0.72, 1], [0.88, 0], [1, 0]],
  lReachCell: [[0, 0], [0.12, 1], [0.80, 1], [0.94, 0], [1, 0]],
  lReachPump: [[0.02, 0], [0.12, 1], [0.86, 1], [0.96, 0], [1, 0]],
  hcInsert: [[0.5, 0], [0.58, -0.022], [0.66, -0.022], [0.74, 0], [1, 0]],
  swapOut: [[0, 0], [1, 1]],
};
// Ability gestures. throw/grapple: the gun dips aside so the off-hand owns the screen (peak-hold pose, `hold` = the
// [in, out] fractions of p). melee: no hand at all — you BASH with the weapon you are holding, so the gun itself is
// the animation and it needs explicit per-channel keys (cock back -> drive across the screen -> settle).
// Impact lands at p ~= 0.31, matching the 0.14 s strike timer in Abilities.
const GEST = {
  throw:   { dur: 0.62, pos: [0.05, -0.10, 0.04], rot: [-0.34, 0.21, 0.36], hold: [0.16, 0.52] },
  grapple: { dur: 0.50, pos: [0.06, -0.07, 0.03], rot: [-0.22, 0.26, 0.32], hold: [0.12, 0.42] },
  melee: { dur: 0.45, keys: {
    x:  [[0, 0], [0.16, 0.10], [0.33, -0.20], [0.55, -0.10], [1, 0]],
    y:  [[0, 0], [0.16, -0.05], [0.33, 0.03], [0.55, -0.02], [1, 0]],
    z:  [[0, 0], [0.16, 0.11], [0.33, -0.26], [0.55, -0.06], [1, 0]],
    rx: [[0, 0], [0.16, 0.30], [0.33, -0.18], [0.55, 0.06], [1, 0]],
    ry: [[0, 0], [0.16, -0.42], [0.33, 0.62], [0.55, 0.16], [1, 0]],
    rz: [[0, 0], [0.16, 0.55], [0.33, -0.70], [0.55, -0.15], [1, 0]],
  } },
};

export class Weapons {
  constructor(game, player) {
    this.game = game; this.player = player;
    this.slots = []; this.index = 0; this.current = null;
    this.muzzleWorld = new THREE.Vector3(); this.fireCount = 0; this.defs = DEFS;
    this.ads = 0; this.adsOn = false;
    this._models = new Map(); this._overlaySet = false;
    this._rec = { z: new Spring(250, 20), rx: new Spring(250, 20), roll: new Spring(200, 16), yaw: new Spring(220, 18) };
    this._land = new Spring(220, 18);
    this._swapSt = { phase: 0, t: 0, to: 0 }; this._rel = { on: false, t: 0, dur: 1 };
    this._cd = 0; this._queue = 0; this._qT = 0; this._qInt = 0; this._charge = 0; this._bloom = 0; this._trigPrev = false; this._emptyT = 0;
    this._gestSt = null;
    this._lastFire = -9; this._flashT = 0; this._lastLightT = -9; this._bobPhase = 0; this._bobAmt = 0; this._sprintW = 0; this._cylAngle = 0; this._cylTarget = 0;
    this._lag = new THREE.Vector2(); this._adsPressT = 0; this._adsToggled = false; this._chargeSound = null;
    this._fwd = new THREE.Vector3(); this._right = new THREE.Vector3(); this._up = new THREE.Vector3(); this._dir = new THREE.Vector3();
    this._pos = new THREE.Vector3(); this._rot = new THREE.Vector3(); this._tmp = new THREE.Vector3(); this._tmp2 = new THREE.Vector3(); this._q = new THREE.Quaternion();
    this._hitscanArgs = { origin: null, dir: null, range: 300, damage: 0, element: 'kinetic', critMult: 1.6, owner: null, team: 'player', spread: 0, pierce: false, falloff: [20, 60], source: '' };
    this._vfxOpts = { dir: this._fwd, element: 'kinetic', color: 0xffffff, scale: 1 }; this._trOpts = { element: 'kinetic', color: 0xffffff, width: 0.03, duration: 0.08 };
    this._flOpts = { color: 0xffffff, intensity: 3, distance: 7, duration: 0.06 }; this._sndOpts = { pitch: 1, vol: 1 };
  }

  async init() {
    const { renderer, sky } = this.game;
    // overlay scene + camera (camera-local space: the rig is positioned relative to the eye)
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 8); this.cam.updateMatrixWorld();
    this.sun = new THREE.DirectionalLight(0xffffff, 3); this.sun.position.set(1, 2, 1); this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(sky.skyColor, sky.groundColor, 0.7); this.scene.add(this.hemi);
    this.fill = new THREE.DirectionalLight(0xbfd4ff, 0.35); this.fill.position.set(0.4, 0.8, 1); this.scene.add(this.fill, this.fill.target); // always-on screen light (night readability)
    this.flashLight = new THREE.PointLight(0xffffff, 0, 1.2, 2);
    this.scene.environment = this._makeEnv(renderer);   // PMREM bake
    await new Promise((r) => requestAnimationFrame(r));
    this.mats = makeMaterials();
    await new Promise((r) => requestAnimationFrame(r));
    this.rig = new THREE.Group(); this.scene.add(this.rig);
    this.flash = makeFlash(this.mats);
    // ejected brass casings (pooled, fly in camera space). Bright brass + emissive so they read against the world.
    const cg = new THREE.CylinderGeometry(0.0046, 0.0046, 0.019, 8); cg.rotateZ(Math.PI / 2);
    this._casings = []; this._casingI = 0;
    for (let i = 0; i < 10; i++) { const mesh = new THREE.Mesh(cg, this.mats.brass); mesh.visible = false; mesh.frustumCulled = false; this.scene.add(mesh); this._casings.push({ mesh, v: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 }); }
    this._buildScope();
    this.slots = DEFAULT_SLOTS.map((id) => this._make(id));
    // compile all shader variants now (all models visible), then show only the equipped gun
    for (const m of this._models.values()) m.group.visible = true;
    this.flash.visible = true; this.rig.add(this.flash, this.flashLight); renderer.compile(this.scene, this.cam); this.flash.visible = false;
    this._equip(0, true);
    this.game.events.on('player:land', ({ impact }) => { this._land.v -= Math.min(14, impact) * 0.045; });
    this.game.events.on('player:respawn', () => { for (const w of this.slots) { w.ammo = w.magSize; w.reserve = w.def.reserve; } });
  }
  resize(w, h) { if (this.cam) { this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); } }

  // tiny sky-gradient env so the metals have something to reflect (regenerated never; intensity scaled with daylight)
  _makeEnv(renderer) {
    const sc = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({ side: THREE.BackSide, uniforms: { top: { value: new THREE.Color(0.30, 0.50, 0.95) }, hor: { value: new THREE.Color(0.9, 0.88, 0.92) }, bot: { value: new THREE.Color(0.22, 0.19, 0.15) }, sun: { value: new THREE.Vector3(0.4, 0.5, -0.6).normalize() } },
      vertexShader: 'varying vec3 vW; void main(){ vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 top, hor, bot, sun; varying vec3 vW; void main(){ vec3 d = normalize(vW); float y = d.y; vec3 c = y > 0.0 ? mix(hor, top, pow(y, 0.55)) : mix(hor, bot, pow(-y, 0.5)); c += vec3(1.0, 0.9, 0.7) * 2.6 * pow(max(dot(d, sun), 0.0), 90.0); gl_FragColor = vec4(c, 1.0); }' });
    sc.add(new THREE.Mesh(new THREE.SphereGeometry(5, 24, 12), mat));
    const pm = new THREE.PMREMGenerator(renderer); const rt = pm.fromScene(sc, 0.02); pm.dispose(); mat.dispose();
    return rt.texture;
  }
  // sniper scope picture (D2-style): black lens mask + gold rim + solar reticle, drawn in the vm scene at screen center.
  // The gun model hides at full ADS (hideOnAds) and this fades in on top of the zoomed world.
  _buildScope() {
    const g = this.scope = new THREE.Group(); g.visible = false; g.renderOrder = 20;
    const Z = -0.4, S = 1.4, R = 0.19; // quad size / scope circle radius at z=-0.4 (screen half-height there = 0.206)
    const cnv = document.createElement('canvas'); cnv.width = cnv.height = 1024; const ctx = cnv.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1024, 1024);
    const r = (R / S) * 1024; // circle radius in px
    ctx.globalCompositeOperation = 'destination-out';
    const gr = ctx.createRadialGradient(512, 512, r * 0.9, 512, 512, r); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(512, 512, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over'; // lens-edge shading ring inside the circle
    const sh = ctx.createRadialGradient(512, 512, r * 0.62, 512, 512, r * 0.92); sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,10,0.55)');
    ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(512, 512, r * 0.93, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.CanvasTexture(cnv);
    const M = (o) => { const m = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, ...o }); this._scopeMats.push(m); return m; };
    this._scopeMats = [];
    const add = (geo, mat, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.z = Z + z; m.renderOrder = 20 + this._scopeMats.length; m.frustumCulled = false; g.add(m); return m; };
    add(new THREE.PlaneGeometry(S, S), M({ map: tex, color: 0x05060a }));                                   // mask + vignette
    add(new THREE.RingGeometry(R * 0.965, R * 1.0, 64), M({ color: 0x8a7440 }), 0.001);                     // gold rim
    const ret = M({ color: 0xffb066, opacity: 0.9 });
    add(new THREE.PlaneGeometry(R * 1.9, 0.0014), ret, 0.002); add(new THREE.PlaneGeometry(0.0014, R * 1.9), ret, 0.002); // crosshair
    for (const s of [-1, 1]) { add(new THREE.PlaneGeometry(0.02, 0.0022), ret, 0.002).position.x = s * R * 0.55; add(new THREE.PlaneGeometry(0.0022, 0.02), ret, 0.002).position.y = s * R * 0.55; } // mil ticks
    add(new THREE.RingGeometry(0.0035, 0.0055, 24), M({ color: 0xff8a3d, opacity: 0.95 }), 0.003);          // center dot ring
    this.scene.add(g);
  }
  _model(id) {
    if (this._models.has(id)) return this._models.get(id);
    const d = DEFS[id]; const m = buildGun(d.archetype, this.mats, d.element);
    m.group.scale.setScalar(VM_SCALE); const sp = m.sight.position;
    m.adsPos = new THREE.Vector3(-sp.x * VM_SCALE, -sp.y * VM_SCALE, -d.adsZ - sp.z * VM_SCALE);
    // support-hand reload targets: gun-space deltas from the lhand pivot to the parts it grabs
    if (m.pivots?.has('lhand')) {
      const lp = m.pivots.get('lhand').p; m.lTo = {};
      for (const k of ['mag', 'cyl', 'cell']) if (m.pivots.has(k)) m.lTo[k] = m.pivots.get(k).p.clone().sub(lp);
      if (m.lSaddle) m.lTo.saddle = new THREE.Vector3(...m.lSaddle).sub(lp);
      if (m.lPort) m.lTo.port = new THREE.Vector3(...m.lPort).sub(lp);
    }
    m.group.visible = false; this.rig.add(m.group); this._models.set(id, m); return m;
  }
  _make(id) {
    const d = DEFS[id];
    return { id, name: d.name, archetype: d.archetype, element: d.element, rarity: d.rarity, ammo: d.magSize, magSize: d.magSize, reserve: d.reserve, maxReserve: d.maxReserve,
      damage: d.damage, rpm: d.rpm, range: d.range, zoom: d.zoom, ads: 0, reloading: false, firing: false, spread: 0, charge: 0, fireCount: 0, def: d, model: this._model(id) };
  }
  _equip(i, silent = false) {
    const prev = this.current;
    this.index = i; const w = this.current = this.slots[i]; const m = w.model;
    for (const mm of this._models.values()) mm.group.visible = mm === m;
    m.muzzle.add(this.flash, this.flashLight);
    const fm = this.mats.flash[w.element] || this.mats.flash.kinetic;
    for (const p of this.flash.userData.petals) p.material = fm.petal; this.flash.userData.star.material = fm.star;
    this.flashLight.color.setHex(ELEMENT_COLORS[w.element] || 0xffffff);
    this._cd = 0.1; this._queue = 0; this._charge = 0; this._bloom = 0; this._flashT = 0; this._rel.on = false; w.reloading = false;
    if (prev && prev !== w) prev.reloading = false;
    if (!silent || prev !== w) this.game.events.emit('weapon:swap', { weapon: w });
    if (!silent) this.game.audio?.play?.('swap');
  }

  // ---------- public API ----------
  swap(i) {
    i = ((i % this.slots.length) + this.slots.length) % this.slots.length;
    if (i === this.index || !this.slots[i] || this._swapSt.phase) return;
    this._swapSt.phase = 1; this._swapSt.t = 0; this._swapSt.to = i;
    this._rel.on = false; this.current.reloading = false; this._charge = 0; this._queue = 0; this._stopCharge();
  }
  reload() {
    const w = this.current; if (!w || this._rel.on || this._swapSt.phase || w.ammo >= w.magSize || w.reserve <= 0) return;
    this._rel.on = true; this._rel.t = 0; this._rel.dur = w.def.reloadTime; w.reloading = true; this._charge = 0; this._queue = 0; this._stopCharge();
    this.game.audio?.play?.('reload'); this.game.events.emit('weapon:reload', { weapon: w });
  }
  addAmmo(slot, n) { const w = this.slots[slot]; if (w) w.reserve = Math.min(w.maxReserve, w.reserve + n); }
  give(id, slot = this.index) { if (!DEFS[id]) return null; const w = this._make(id); this.slots[slot] = w; if (slot === this.index) this._equip(slot, true); return w; }
  setAds(on) { this.adsOn = !!on; this._adsToggled = !!on; }
  // stow/hide the whole viewmodel (Abilities takes over the hands during the super). Also blocks firing while hidden.
  /** Armored gauntlet for the ability gestures — same parts + materials as the weapon hands. { group, open, fist } */
  abilityHand() { return buildAbilityHand(this.mats); }
  /** Abilities call this so the gun clears frame for a throw / grapple / punch. Returns the gesture duration (s). */
  gesture(kind) { const g = GEST[kind]; if (!g) return 0; this._gestSt = { g, t: 0 }; return g.dur; }

  setHidden(on) {
    this._hidden = !!on; this.rig.visible = !this._hidden;
    if (this._hidden) { if (this.scope) this.scope.visible = false; this.flash.visible = false; this.flashLight.intensity = 0; for (const c of this._casings) { c.life = 0; c.mesh.visible = false; } }
  }

  // ---------- frame ----------
  update(dt, t) {
    const t0 = performance.now();
    if (!this._overlaySet && this.game.postfx?.composer) { this.game.postfx.setOverlay(this.scene, this.cam); this._overlaySet = true; }
    const w = this.current; if (!w) return;
    const { input } = this.game; const view = this.player.view; const c = this.player.controller;
    const active = input.active && this.player.alive && !this.game.paused;
    let trigger = false, trigJust = false;
    if (active) {
      if (input.justPressed('Digit1')) this.swap(0); else if (input.justPressed('Digit2')) this.swap(1);
      if (input.mouse.wheel) this.swap(this.index + (input.mouse.wheel > 0 ? 1 : -1));
      if (input.justPressed('KeyR')) this.reload();
      trigger = input.mouseDown(0); trigJust = input.mouseJustPressed(0);
      // ADS: hold = ads; quick tap = toggle
      if (input.mouseJustPressed(2)) { if (this.adsOn && this._adsToggled) { this.adsOn = false; this._adsToggled = false; } else { this.adsOn = true; this._adsToggled = false; this._adsPressT = t; } }
      if (input.mouseJustReleased(2) && this.adsOn && !this._adsToggled) { if (t - this._adsPressT > 0.22) this.adsOn = false; else this._adsToggled = true; }
    } else if (this.adsOn && !this._adsToggled) this.adsOn = false;

    // swap state machine (lower -> switch model -> raise)
    const sw = this._swapSt;
    if (sw.phase) {
      sw.t += dt; const half = w.def.swapTime * 0.45;
      if (sw.phase === 1 && sw.t >= half) { this._equip(sw.to); sw.phase = 2; sw.t = 0; }
      else if (sw.phase === 2 && sw.t >= this.current.def.swapTime * 0.55) sw.phase = 0;
    }
    const cur = this.current; // may have changed in _equip
    // reload progress
    if (this._rel.on) {
      this._rel.t += dt;
      if (this._rel.t >= this._rel.dur) { this._rel.on = false; cur.reloading = false; this._cylTarget = this._cylAngle; const take = Math.min(cur.magSize - cur.ammo, cur.reserve); cur.ammo += take; cur.reserve -= take; this.game.events.emit('weapon:reloaded', { weapon: cur }); }
    }
    // ADS blend (~0.18 s) + camera fov
    const adsTarget = (this.adsOn && !this._rel.on && !sw.phase && this.player.alive) ? 1 : 0;
    if (this._adsPrev !== adsTarget) { this._adsPrev = adsTarget; view.adsZoom = cur.def.zoom; view.setAds?.(!!adsTarget, cur.def.zoom); }
    this.ads += (adsTarget - this.ads) * Math.min(1, dt * 13);
    if (Math.abs(this.ads - adsTarget) < 0.002) this.ads = adsTarget;

    this._updateFire(dt, t, cur, trigger, trigJust);
    this._animate(dt, t, cur); this._updateCasings(dt);
    this._lights();
    this._muzzle();
    // published fields
    cur.ads = this.ads; cur.firing = trigger && cur.ammo > 0 && !cur.reloading; cur.charge = this._charge; cur.spread = this._spreadNow(cur);
    cur.reloading = this._rel.on;
    this._trigPrev = trigger;
    this.cpuMs = (this.cpuMs || 0) * 0.98 + (performance.now() - t0) * 0.02; // smoothed update cost (ms)
  }

  _spreadNow(w) {
    const d = w.def.spread; const c = this.player.controller;
    const move = Math.min(1, (c.speed || 0) / (c.sprintSpeed || 9)) * 0.006 + (c.grounded ? 0 : 0.012);
    return THREE.MathUtils.lerp(d.hip + move, d.ads, this.ads) + this._bloom;
  }
  _stopCharge() { if (this._chargeSound) { this._chargeSound.stop?.(); this._chargeSound = null; } }
  _empty(w) {
    if (this._emptyT > 0) return; this._emptyT = 0.3;
    this.game.audio?.play?.('empty'); this.game.events.emit('weapon:empty', { weapon: w });
    if (w.reserve > 0) this.reload();
  }

  _updateFire(dt, t, w, trigger, trigJust) {
    const d = w.def;
    this._cd = Math.max(this._cd - dt, -1); this._emptyT -= dt; this._bloom *= Math.exp(-dt * d.spread.decay);
    const canFire = !this._rel.on && !this._swapSt.phase && this.player.alive && !this._hidden;
    // queued rounds (pulse burst / fusion bolts) keep going even if the trigger is released
    if (this._queue > 0) {
      this._qT -= dt;
      while (this._queue > 0 && this._qT <= 0) {
        const consume = d.fireMode !== 'charge';
        if (consume && w.ammo <= 0) { this._queue = 0; break; }
        this._shoot(w, t, consume); this._queue--; this._qT += this._qInt;
      }
    }
    if (!canFire) { if (this._charge > 0) { this._charge = 0; this._stopCharge(); } return; }
    if (d.fireMode === 'charge') {
      if (trigger && w.ammo > 0 && this._cd <= 0 && this._queue === 0) {
        if (this._charge === 0) this._chargeSound = this.game.audio?.play?.('fusion-charge');
        this._charge = Math.min(1, this._charge + dt / d.chargeTime);
        if (this._charge >= 1) { w.ammo--; this._queue = d.bolts; this._qT = 0; this._qInt = d.boltInterval; this._charge = 0; this._cd = 0.5; this._chargeSound = null; }
      } else if (this._charge > 0) { this._charge = Math.max(0, this._charge - dt * 4); if (this._charge === 0) this._stopCharge(); }
      if (trigger && w.ammo <= 0 && this._cd <= 0) this._empty(w);
      return;
    }
    if (this._queue > 0) return;
    if (trigger && this._cd <= 0) {
      if (w.ammo <= 0) { this._empty(w); this._cd = 0.2; return; }
      const interval = 60 / d.rpm;
      if (d.fireMode === 'burst') { this._queue = d.burst; this._qT = 0; this._qInt = d.burstInterval; this._cd = interval * d.burst; }
      else { this._shoot(w, t, true); this._cd = this._trigPrev && this._cd > -dt ? this._cd + interval : interval; } // carry the residual for rpm-accurate cadence
    }
  }

  _shoot(w, t, consume) {
    const d = w.def; const { camera, combat, vfx, audio, events } = this.game; const view = this.player.view;
    if (consume) w.ammo--;
    this.fireCount++; w.fireCount++; this._lastFire = t;
    camera.getWorldDirection(this._fwd);
    this._right.set(1, 0, 0).applyQuaternion(camera.quaternion); this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const spread = this._spreadNow(w); const n = d.pellets || 1; const col = ELEMENT_COLORS[w.element] || 0xffffff;
    const a = this._hitscanArgs; a.origin = camera.position; a.damage = d.damage; a.element = w.element; a.critMult = d.critMult; a.owner = this.player; a.range = Math.max(300, d.range * 8);
    a.falloff[0] = d.range * 0.65; a.falloff[1] = d.range * 1.6; a.source = d.id; a.pierce = !!d.pierce;
    let hit = null;
    for (let i = 0; i < n; i++) {
      this._dir.copy(this._fwd);
      if (spread > 0) { const r = Math.sqrt(Math.random()) * spread, ang = Math.random() * Math.PI * 2; this._dir.addScaledVector(this._right, Math.cos(ang) * r).addScaledVector(this._up, Math.sin(ang) * r).normalize(); }
      a.dir = this._dir;
      const h = combat?.hitscan?.(a); if (!hit) hit = h;
      if (i < 3) { // always draw the tracer — misses fly to max range (a fusion volley into open air must be visible)
        const end = h?.point ?? this._tmp2.copy(a.origin).addScaledVector(this._dir, Math.min(150, a.range));
        this._trOpts.element = w.element; this._trOpts.color = col; this._trOpts.width = i === 0 ? 0.03 : 0.02;
        vfx?.tracer?.(this.muzzleWorld, end, this._trOpts);
      }
    }
    this._bloom = Math.min(this._bloom + d.spread.bloom, d.spread.hip * 2.5);
    // camera kick (+ pattern for autos) and viewmodel recoil springs
    const adsMul = 1 - this.ads * 0.3; const k = d.kick;
    const yaw = k.pattern ? Math.sin(w.fireCount * 0.55) * k.yaw : (Math.random() - 0.5) * 2 * k.yaw;
    view.kick?.(k.pitch * (0.85 + Math.random() * 0.3) * adsMul, yaw * adsMul); view.shake?.(d.shake * (this.ads ? 0.7 : 1), 0.12);
    this._rec.z.v += k.vz * adsMul; this._rec.rx.v += k.vx * adsMul; this._rec.roll.v += (Math.random() - 0.5) * k.roll; this._rec.yaw.v += (Math.random() - 0.5) * k.yawV;
    for (const s of [this._rec.z, this._rec.rx, this._rec.roll, this._rec.yaw]) { s.k = k.k; s.c = k.c; }
    // muzzle flash (viewmodel, 1-2 frames) + world vfx + audio + events
    this._flashT = 0.03; this._fireAnimT = 0; this._cylTarget += Math.PI / 3;
    if (w.model.port && (d.pellets ? true : d.fireMode !== 'charge')) this._eject(w.model.port);
    // Shrink hard while aiming: ADS puts the muzzle directly behind the reticle, so the same flash that reads as
    // punch from the hip is the thing standing between you and the target you are trying to track.
    const fs = (w.model.flashScale || 1) * (0.8 + Math.random() * 0.45) * (1 - 0.45 * this.ads);
    this.flash.scale.set(fs, fs, fs * (0.8 + Math.random() * 0.5)); this.flash.rotation.z = Math.random() * Math.PI * 2;
    // world muzzle sprites: TIGHT (the VFX preset is authored ~0.3 m; x0.15 keeps it a crisp petal pop, not a screen-filling bloom blob)
    this._vfxOpts.element = w.element; this._vfxOpts.color = col; this._vfxOpts.scale = (w.model.flashScale || 1) * 0.15 * (1 - 0.35 * this.ads);
    vfx?.emit?.('muzzle', this.muzzleWorld, this._vfxOpts);
    // dynamic light flashes are expensive in the forward renderer: throttle to <=11/s regardless of rpm
    if (t - this._lastLightT > 0.09) { this._lastLightT = t; this._flOpts.color = col; this._flOpts.intensity = 0.5 + 0.35 * (w.model.flashScale || 1); vfx?.flash?.(this.muzzleWorld, this._flOpts); }
    this._sndOpts.pitch = 0.96 + Math.random() * 0.08; audio?.play?.('shot-' + d.archetype, this._sndOpts);
    events.emit('weapon:fire', { weapon: w, hit, origin: camera.position, dir: this._fwd });
  }

  _eject(port) {
    const c = this._casings[this._casingI++ % this._casings.length];
    port.getWorldPosition(c.mesh.position);
    c.v.set(1.15 + Math.random() * 0.7, 1.15 + Math.random() * 0.6, 0.25 + Math.random() * 0.3); c.spin.set(Math.random() * 24, Math.random() * 24, Math.random() * 24);
    c.life = 0.9; c.mesh.visible = true; c.mesh.rotation.set(0, 0, 0);
  }
  _updateCasings(dt) {
    for (const c of this._casings) {
      if (c.life <= 0) continue; c.life -= dt; if (c.life <= 0) { c.mesh.visible = false; continue; }
      c.mesh.position.addScaledVector(c.v, dt); c.v.y -= 7 * dt; c.v.x *= (1 - dt * 2);
      c.mesh.rotation.x += c.spin.x * dt; c.mesh.rotation.y += c.spin.y * dt; c.mesh.rotation.z += c.spin.z * dt;
    }
  }

  // ---------- animation ----------
  _animate(dt, t, w) {
    const d = w.def; const m = w.model; const c = this.player.controller; const view = this.player.view; const input = this.game.input;
    const pos = this._pos, rot = this._rot; const a = this.ads; const aInv = 1 - a * 0.85;
    const sinceFire = t - this._lastFire;
    // sprint pose weight (no sprint pose while aiming / just fired / reloading)
    const sprint = c.state === 'sprint' && !this.adsOn && sinceFire > 0.35 && !this._rel.on ? 1 : 0;
    this._sprintW += (sprint - this._sprintW) * Math.min(1, dt * 9);
    // base pose: hip -> ads -> sprint
    pos.set(d.hip.pos[0], d.hip.pos[1], d.hip.pos[2]); rot.set(d.hip.rot[0], d.hip.rot[1], d.hip.rot[2]);
    pos.lerp(m.adsPos, a); rot.multiplyScalar(1 - a);
    // ADS is an ARC, not a straight lerp: the gun swings inboard and lifts through the middle of the transition and
    // settles on the sight, instead of sliding there on a rail. Zero at both ends, so the settled poses are untouched.
    const arc = a * (1 - a) * 4;
    pos.x += 0.020 * arc; pos.y += 0.014 * arc; pos.z -= 0.012 * arc;
    rot.z -= 0.085 * arc; rot.y += 0.045 * arc; rot.x -= 0.030 * arc;
    const s = this._sprintW; pos.x += (d.sprint.pos[0] - pos.x) * s; pos.y += (d.sprint.pos[1] - pos.y) * s; pos.z += (d.sprint.pos[2] - pos.z) * s;
    rot.x += (d.sprint.rot[0] - rot.x) * s; rot.y += (d.sprint.rot[1] - rot.y) * s; rot.z += (d.sprint.rot[2] - rot.z) * s;
    // walk / sprint bob (figure-8), reads controller
    const moving = c.grounded && c.speed > 0.4 && c.state !== 'slide';
    const bobT = moving ? Math.min(1, c.speed / (c.sprintSpeed || 9.5)) : 0;
    this._bobAmt += (bobT - this._bobAmt) * Math.min(1, dt * 8);
    if (moving) this._bobPhase += dt * (c.state === 'sprint' ? 11.5 : 8.5);
    const bAmp = this._bobAmt * d.bob * aInv * (1 + s * 0.8);
    const ph = this._bobPhase;
    pos.x += Math.cos(ph) * 0.011 * bAmp; pos.y += Math.sin(ph * 2) * 0.008 * bAmp - Math.abs(Math.sin(ph)) * 0.004 * bAmp;
    rot.z += Math.cos(ph) * 0.022 * bAmp; rot.x += Math.sin(ph * 2) * 0.01 * bAmp; rot.y += Math.cos(ph) * 0.008 * bAmp;
    // breath / idle sway
    pos.y += Math.sin(t * 1.4) * 0.0025 * aInv; pos.x += Math.sin(t * 0.9 + 1.3) * 0.0015 * aInv; rot.z += Math.sin(t * 1.1) * 0.004 * aInv; rot.x += Math.sin(t * 1.4) * 0.003 * aInv;
    // look lag (view.sway if the camera provides it, else mouse velocity rad/s)
    let vx, vy; const sw = view.sway;
    if (sw && typeof sw.x === 'number') { vx = sw.x; vy = sw.y; } else { const sens = view.sensitivity || 0.0022; vx = input.active ? -input.mouse.dx * sens / Math.max(dt, 1e-3) : 0; vy = input.active ? -input.mouse.dy * sens / Math.max(dt, 1e-3) : 0; }
    const lk = 1 - Math.exp(-dt * 11);
    this._lag.x += (THREE.MathUtils.clamp(vx, -8, 8) - this._lag.x) * lk; this._lag.y += (THREE.MathUtils.clamp(vy, -8, 8) - this._lag.y) * lk;
    rot.y += -this._lag.x * 0.012 * aInv; rot.x += -this._lag.y * 0.010 * aInv; rot.z += this._lag.x * 0.006 * aInv;
    pos.x += this._lag.x * 0.0025 * aInv; pos.y += -this._lag.y * 0.002 * aInv;
    // recoil springs
    const R = this._rec; R.z.update(dt); R.rx.update(dt); R.roll.update(dt); R.yaw.update(dt);
    pos.z += Math.min(0.12, R.z.x); rot.x += R.rx.x; rot.z += R.roll.x; rot.y += R.yaw.x;
    // landing dip + airborne lag (gun floats up when falling, drops on jump) + slide cant
    this._land.update(dt); pos.y += this._land.x; rot.x += this._land.x * 1.2;
    const airT = c.grounded ? 0 : THREE.MathUtils.clamp(-(c.velocity?.y || 0) * 0.003, -0.02, 0.02);
    this._airLag = (this._airLag || 0) + (airT - (this._airLag || 0)) * Math.min(1, dt * 6); pos.y -= this._airLag * aInv; rot.x += this._airLag * 0.8 * aInv;
    const slideT = c.state === 'slide' ? 1 : 0; this._slideW = (this._slideW || 0) + (slideT - (this._slideW || 0)) * Math.min(1, dt * 8);
    rot.z += this._slideW * 0.18 * aInv; pos.y -= this._slideW * 0.025 * aInv; pos.x += this._slideW * 0.02 * aInv;
    // moving parts: reset to base then apply reload / fire animation
    const P = m.parts; for (const k in P) { const p = P[k]; p.position.copy(p.userData.basePos); p.rotation.copy(p.userData.baseRot); }
    if (P.litem) P.litem.visible = false;                                // held reload item (speedloader/shell) only shows mid-reload
    if (P.lhand) P.lhand.visible = m.lhandIdle !== false;                // hc's left hand only exists during the reload performance
    if (m.coreMat) m.coreMat.emissiveIntensity = (m.coreBase ?? 2.4) * (1 + this._charge * 2.5 + (this._queue > 0 ? 2 : 0));
    if (this._rel.on) this._reloadAnim(this._rel.t / this._rel.dur, d.reloadStyle, P, pos, rot, m);
    this._fireAnim(t, d.reloadStyle, P, pos, rot, dt);
    if (this._charge > 0) { const j = this._charge * this._charge; pos.x += (Math.random() - 0.5) * 0.003 * j; pos.y += (Math.random() - 0.5) * 0.003 * j; rot.z += (Math.random() - 0.5) * 0.01 * j; }
    // swap: lower / raise
    const S = this._swapSt;
    if (S.phase) {
      const dur = S.phase === 1 ? d.swapTime * 0.45 : d.swapTime * 0.55;
      const u = Math.min(1, S.t / dur); const e = S.phase === 1 ? u * u : 1 - (1 - (1 - u) * (1 - u)); // ease-in down, ease-out up
      pos.y -= 0.22 * e; pos.x += 0.04 * e; rot.x -= 0.75 * e; rot.z += 0.3 * e;
    }
    // ability gesture: swing the gun out of the way and back (see GEST)
    const G = this._gestSt;
    if (G) {
      G.t += dt;
      const p = G.t / G.g.dur;
      if (p >= 1) this._gestSt = null;
      else {
        const K2 = G.g.keys;
        if (K2) {                                            // melee bash: explicit swing, the gun IS the weapon
          pos.x += kf(p, K2.x); pos.y += kf(p, K2.y); pos.z += kf(p, K2.z);
          rot.x += kf(p, K2.rx); rot.y += kf(p, K2.ry); rot.z += kf(p, K2.rz);
        } else {
          const w = kf(p, [[0, 0], [G.g.hold[0], 1], [G.g.hold[1], 1], [1, 0]]);
          pos.x += G.g.pos[0] * w; pos.y += G.g.pos[1] * w; pos.z += G.g.pos[2] * w;
          rot.x += G.g.rot[0] * w; rot.y += G.g.rot[1] * w; rot.z += G.g.rot[2] * w;
        }
      }
    }
    this.rig.position.copy(pos); this.rig.rotation.set(rot.x, rot.y, rot.z);
    // sniper: hide the gun when fully scoped; our scope picture (mask+reticle) fades in on top
    const scoped = d.hideOnAds ? THREE.MathUtils.clamp((this.ads - 0.6) / 0.35, 0, 1) : 0;
    m.group.visible = !(d.hideOnAds && this.ads > 0.85);
    this.scope.visible = scoped > 0.01 && !this._hidden;
    if (this.scope.visible) {
      for (const sm of this._scopeMats) sm.opacity = scoped * (sm.userData.o ?? (sm.userData.o = sm.opacity));
      this.scope.position.set(-this._lag.x * 0.004, -this._lag.y * 0.003 - R.rx.x * 0.02, 0); // subtle sway + recoil bump
    }
    // muzzle flash (1-2 frames). The viewmodel point light sits ~30 cm from the camera, so it lights the gun
    // itself far more than anything in the world — 2.6 was blowing the barrel and hands to white every shot.
    this._flashT -= dt; const fl = this._flashT > 0 && !this._hidden;
    this.flash.visible = fl; this.flashLight.intensity = fl ? 0.7 * (1 - 0.4 * this.ads) : 0;
  }
  // Destiny reloads are HAND performances: the support hand (P.lhand) leaves its grip, grabs the moving part and
  // drives it. P.litem = the thing in the hand (speedloader/shell), pivot-identical to lhand so it just copies it.
  _reloadAnim(p, style, P, pos, rot, m) {
    const L = P.lhand, I = P.litem, T = m.lTo || {};
    if (style === 'mag' || style === 'bolt') {
      rot.z += kf(p, K.magRoll); rot.x += kf(p, K.magTilt); pos.y += kf(p, K.magDip) + kf(p, K.jolt); pos.x -= kf(p, K.magRoll) * 0.1; pos.z += kf(p, K.magRoll) * 0.06;
      let my = 0, mrx = 0;
      if (style === 'mag') {
        my = kf(p, K.magOutY); mrx = kf(p, K.magOutRx);
        if (P.mag) { P.mag.position.y += my; P.mag.rotation.x += mrx; }
        if (P.bolt) P.bolt.position.z += kf(p, K.boltZ);
      } else {
        my = kf(p, K.snMagY);
        if (P.mag) P.mag.position.y += my;
        if (P.bolt) { P.bolt.rotation.z += kf(p, K.snBoltRz); P.bolt.position.z += kf(p, K.snBoltZ); }
      }
      if (L && T.mag) { // hand leaves the handguard, grips the mag, rides it out and slams it back
        const r = kf(p, style === 'mag' ? K.lReachMag : K.lReachBolt);
        L.position.x += T.mag.x * r; L.position.y += (T.mag.y - 0.02) * r + my; L.position.z += (T.mag.z + 0.012) * r;
        L.rotation.x += mrx * 0.6 + r * 0.5; L.rotation.z += r * -0.15;
      }
    } else if (style === 'cylinder') {
      rot.z += kf(p, K.cylRoll); rot.x += kf(p, K.cylTilt); rot.y += kf(p, K.cylYaw);
      pos.y -= kf(p, K.cylRoll) * 0.05; pos.x -= kf(p, K.cylRoll) * 0.25;
      if (P.cyl) { P.cyl.position.x += kf(p, K.cylX); P.cyl.rotation.y += kf(p, K.cylX) * -10; this._cylAngle = this._cylTarget + kf(p, K.cylSpin); }
      if (P.hammer) P.hammer.rotation.x += kf(p, [[0.88, 0], [0.94, -0.6], [1, 0]]);
      if (L) { // left hand rises in from below-right with the speedloader, pushes rounds home, drops away
        L.visible = true;
        const r = kf(p, K.lReachCyl), ins = kf(p, K.hcInsert);
        L.position.x += 0.07 * (1 - r); L.position.y += -0.27 * (1 - r); L.position.z += 0.13 * (1 - r) + ins;
        L.rotation.x += 0.6 * (1 - r);
        if (I) { I.visible = p > 0.2 && p < 0.66; I.position.copy(L.position); I.rotation.copy(L.rotation); }
      }
    } else if (style === 'pump') {
      rot.z += kf(p, K.pumpRoll); rot.x += kf(p, K.pumpTilt); pos.y -= 0.03 * kf(p, K.pumpTilt) / 0.28;
      if (P.pump) P.pump.position.z += kf(p, K.pumpZ);
      if (p > 0.18 && p < 0.82) { const sh = Math.max(0, Math.sin(((p - 0.18) / 0.64) * Math.PI * 4)); pos.y += sh * 0.008; rot.x += sh * 0.03; }
      if (L && T.saddle && T.port) { // hand shuttles shells from the side saddle to the loading port, 3 trips
        const r = kf(p, K.lReachPump);
        const u = (Math.min(0.9999, Math.max(0, (p - 0.10) / 0.74)) * 3) % 1;
        const w = u < 0.14 ? 1 : u < 0.58 ? 1 - smooth((u - 0.14) / 0.44) : u < 0.70 ? 0 : smooth((u - 0.70) / 0.30); // 1=saddle 0=port
        const lift = (1 - w) * w * 4 * 0.02;
        L.position.x += (T.saddle.x * w + T.port.x * (1 - w)) * r;
        L.position.y += (T.saddle.y * w + T.port.y * (1 - w) + lift - 0.01) * r;
        L.position.z += (T.saddle.z * w + T.port.z * (1 - w)) * r;
        L.rotation.x += r * (0.45 + 0.5 * (1 - w)); L.rotation.z += r * 0.35 * w;
        if (I) { I.visible = r > 0.5 && u > 0.16 && u < 0.62; I.position.copy(L.position); I.rotation.copy(L.rotation); }
      }
    } else if (style === 'cell') {
      rot.x += kf(p, K.cellTilt); pos.y += kf(p, K.cellTilt) * 0.12; rot.z += kf(p, K.cellTilt) * -0.6;
      const cy = kf(p, K.cellY);
      if (P.cell) { P.cell.position.y += cy; P.cell.rotation.y += kf(p, K.cellSpin); }
      if (m.coreMat) m.coreMat.emissiveIntensity = (m.coreBase ?? 2.4) * kf(p, K.cellGlow);
      if (L && T.cell) { // support hand drops off the foregrip to pull/spin/seat the cell
        const r = kf(p, K.lReachCell);
        L.position.x += T.cell.x * r; L.position.y += (T.cell.y - 0.055) * r + cy; L.position.z += T.cell.z * r;
        L.rotation.x += r * 0.55;
      }
    }
  }
  _fireAnim(t, style, P, pos, rot, dt) {
    const ft = t - this._lastFire;
    if (style === 'mag') { if (P.bolt) P.bolt.position.z += 0.022 * bump(ft / 0.09); }
    else if (style === 'cylinder') {
      if (!this._rel.on) this._cylAngle += (this._cylTarget - this._cylAngle) * Math.min(1, dt * 22);
      if (P.cyl) P.cyl.rotation.z += this._cylAngle;
      if (P.hammer) P.hammer.rotation.x += -0.7 * bump(ft / 0.14);
    } else if (style === 'pump') {
      if (!this._rel.on && P.pump) { const u = (ft - 0.14) / 0.3; const bp = 0.07 * bump(u); P.pump.position.z += bp; if (P.lhand) P.lhand.position.z += bp; rot.x -= 0.05 * bump(u); pos.z += 0.01 * bump(u); }
    } else if (style === 'bolt') {
      if (!this._rel.on && P.bolt && ft < 0.75) { P.bolt.rotation.z += kf(ft, [[0.12, 0], [0.22, -1.1], [0.56, -1.1], [0.68, 0]]); P.bolt.position.z += kf(ft, [[0.22, 0], [0.34, 0.07], [0.46, 0.07], [0.56, 0]]); rot.z += kf(ft, [[0.12, 0], [0.22, 0.08], [0.56, 0.08], [0.68, 0]]); }
    }
  }

  _lights() {
    const { sky, camera } = this.game;
    this._q.copy(camera.quaternion).invert();
    this._tmp.copy(sky.sunDir).applyQuaternion(this._q); this.sun.position.copy(this._tmp).multiplyScalar(4);
    this.sun.color.copy(sky.sunColor); this.sun.intensity = 3.0 * Math.max(0, sky.sunDir.y * 1.5 + 0.1);
    this._tmp.set(0, 1, 0).applyQuaternion(this._q); this.hemi.position.copy(this._tmp);
    this.hemi.color.copy(sky.skyColor); this.hemi.groundColor.copy(sky.groundColor); this.hemi.intensity = 0.35 + 0.5 * (sky.sunIntensity ?? 1);
    this.scene.environmentRotation.setFromQuaternion(this._q);
    const env = 0.3 + 0.7 * (sky.sunIntensity ?? 1);
    const hot = this._hotMats ??= new Set([this.mats.gold, this.mats.brass, this.mats.filigree0, this.mats.filigree1, this.mats.filigree2]);
    for (const mt of this.mats.all) mt.envMapIntensity = env * (hot.has(mt) ? 1.2 : 0.9);
  }
  // world-space muzzle position that projects to the same screen point as the viewmodel muzzle
  _muzzle() {
    const m = this.current.model; const cam = this.game.camera;
    this.rig.updateMatrixWorld(true);
    this._tmp.setFromMatrixPosition(m.muzzle.matrixWorld); const dist = Math.max(0.3, this._tmp.length());
    this._tmp.project(this.cam); this._tmp.z = 0.5;
    cam.updateMatrixWorld(); this._tmp.unproject(cam).sub(cam.position).normalize();
    this.muzzleWorld.copy(cam.position).addScaledVector(this._tmp, dist);
  }
}
