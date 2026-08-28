import * as THREE from 'three';
import { compileForComposer, renderForComposer } from '../render/Renderer.js';   // compile/render with a target bound — see their doc comments
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/Noise.js';

/**
 * Abilities: Destiny-style kit. Keys: G grenade, F melee (charged), Q class ability, X super (needs full meter). Cooldowns in seconds; super charges from damage/kills.
 * Abilities use game.combat (explode/projectile/damage), game.vfx, game.audio, game.player.view (kick/shake), game.hud (toasts).
 * Minimum kit ("Aetherweaver"): grenade = aether orb (lob, explode, lingering sigil DoT); melee = arc weapon bash (lunge + shockwave + a swing of the equipped gun);
 *   class = grapple hook (Q: hook any scenery under the crosshair, get flung up and past it); super = "Starfall": 6s of rapid homing star bolts + glowing viewmodel, big VFX.
 * Exposes: game.player.abilities.list = [{ id:'grenade'|'melee'|'class'|'super', name, key, cooldown, remaining, ready:boolean, charge:0..1 (1 = ready / super meter), use() }]
 *          game.player.abilities.superActive:boolean, .superMeter (0..1), .use(id) -> bool, .charge(id) (instantly ready; tests), .superTimeLeft
 * Events: 'ability:use' {id}, 'ability:ready' {id}, 'ability:end' {id:'super'}
 *
 * Cooldowns: grenade 25 s, melee 15 s, class 40 s. Super meter: passive 1/150 per s + combat:hit damage/1800 (+0.04 per kill) when owner === player.
 * COLOR RULE (critic-driven): every emissive core stays SATURATED — hue from the color, brightness multipliers <= ~1.0 so ACES+bloom
 *   never wash the kit to white in daylight. Deep gold 0xffa018/0xffb433 for solar, deep arc 0x35b5ff, void 0xb070ff, green 0x7cf5b0.
 * Own visuals (pooled): glowing grenade orb + dotted arc trail, ornate FF14 sigil rings (1024px canvas texture, DEPTH-TESTED so they sit in the
 *   world instead of smearing over grass, + dark contrast disc for daylight), glow-sprite bursts + instanced ground shockwave rings, orbiting star motes.
 * Super viewmodel: gun stowed via weapons.setHidden(true) (rig.visible fallback), replaced by gradient-lit energy hands (vertex-color ramp wrist->fingertips,
 *   orbiting palm wisps) in the weapons overlay scene + golden vignette + baseFov +6. Falls back to world-space hand glows if the overlay scene is missing.
 * Melee viewmodel: a 0.45 s bash with the EQUIPPED WEAPON (weapons.gesture('melee')) — no ability hand.
 * While the super is active: weapons.locked = weapons.suppressed = true, weapons.canFire = false (restored after), and superActive = true (weapons/HUD read it).
 * Super bolts: hand bolts (combat.projectile homing, DIRECT damage — no explode, so no smoke spam) + star bolts falling FROM THE SKY every 0.4 s;
 *   sky-bolt landings are resolved here (tracked handles) with a saturated gold burst + small AoE instead of combat.explode's sooty explosion.
 */
const UP = new THREE.Vector3(0, 1, 0);
const COL = { grenade: 0xb070ff, melee: 0x53c7ff, class: 0x7cf5b0, super: 0xffb433 };
const GOLD_CORE = 0xffa018; // saturated solar core for bolts/hands (survives ACES at noon)
const ADD = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false };
const CD = { grenade: 25, melee: 15, class: 20 };  // class = grapple: traversal ability, paced like a real pick
// Ability hand gestures (right hand, camera space: +X right, +Y up, -Z forward). p = 0..1 of `dur`.
// The gun swings clear via weapons.gesture(kind) at the same time, so the hand owns the frame.
// `rel` = the p at which the ability's payload actually leaves the hand (grenade orb spawn).
const GK = {
  // Overhand lob: rise in from low-right -> cock HIGH beside the head -> whip forward, orb leaves at rel ->
  // follow through down-left -> drop out. Authored from measured NDC, not guessed: the overlay camera is fov 55, so
  // on-screen means |y| <= 0.52*|z| and |x| <= 0.93*|z|. The first version sat at y -0.62..-0.34 and was therefore
  // BELOW the frame for 73% of its run — the throw played almost entirely off-camera.
  throw: { dur: 0.66, rel: 0.45, glow: 0xb070ff,
    // z stays <= -0.34 the whole way: anything nearer than that is on the lens and reads as a flat giant mitten
    x: [[0, 0.35], [0.16, 0.35], [0.30, 0.29], [0.45, 0.09], [0.62, -0.21], [0.80, -0.06], [1, 0.35]],
    y: [[0, -0.28], [0.16, -0.16], [0.30, 0.07], [0.45, 0.02], [0.62, -0.16], [0.80, -0.27], [1, -0.28]],
    z: [[0, -0.34], [0.16, -0.40], [0.30, -0.44], [0.45, -0.62], [0.62, -0.50], [0.80, -0.42], [1, -0.34]],
    rx: [[0, -1.0], [0.30, -0.90], [0.45, 0.60], [0.62, 1.00], [1, -1.0]],
    ry: [[0, -0.55], [0.30, -0.35], [0.45, -0.05], [0.62, 0.25], [1, -0.55]],
    rz: [[0, -0.5], [0.30, -0.60], [0.45, 0.15], [0.62, 0.40], [1, -0.5]] },
  // hook launch: flat palm punched forward, held open while the rope flies out, then dropped
  grapple: { dur: 0.50, rel: 0.20, glow: 0x7cf5b0,
    x: [[0, 0.34], [0.20, 0.15], [0.55, 0.15], [1, 0.34]],
    y: [[0, -0.58], [0.20, -0.19], [0.55, -0.21], [1, -0.58]],
    z: [[0, -0.38], [0.20, -0.62], [0.55, -0.60], [1, -0.38]],
    rx: [[0, -0.6], [0.20, -0.15], [0.55, -0.2], [1, -0.6]], ry: [[0, -0.45], [0.20, 0.05], [1, -0.45]], rz: [[0, -0.4], [0.20, -0.05], [1, -0.4]] },
};
// piecewise smoothstep keyframes (same idiom as Weapons): keys = [[t, v], ...]
function kf(p, keys) {
  if (p <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (p <= keys[i][0]) { const a = keys[i - 1], b = keys[i]; const u = (p - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * u * u * (3 - 2 * u); }
  return keys[keys.length - 1][1];
}

// Ornate FF14-style sigil: runic ring band, hexagram, petals, centre glyph. White on alpha; material color tints it. 1024px so it stays crisp from inside the ring.
function sigilTexture(seed) {
  const S = 1024, R = S / 2, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), rnd = mulberry32(seed);
  g.translate(R, R); g.strokeStyle = g.fillStyle = '#fff'; g.lineCap = 'round'; g.shadowColor = '#fff'; g.shadowBlur = 6;
  const circle = (r, w, dash) => { g.lineWidth = w; g.setLineDash(dash || []); g.beginPath(); g.arc(0, 0, r * R, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); };
  const poly = (n, r, rot, w) => { g.lineWidth = w; g.beginPath(); for (let i = 0; i <= n; i++) { const a = rot + i / n * Math.PI * 2; g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r * R, Math.sin(a) * r * R); } g.stroke(); };
  circle(0.97, 6); circle(0.90, 4); circle(0.80, 3, [12, 20]); circle(0.62, 4); circle(0.34, 5); circle(0.28, 3);
  for (let i = 0; i < 48; i++) { // rune band
    g.save(); g.rotate(i / 48 * Math.PI * 2); g.lineWidth = 4; g.beginPath();
    const n = 2 + (rnd() * 3 | 0); for (let k = 0; k < n; k++) { g.moveTo((rnd() - 0.5) * 18, -(0.905 + rnd() * 0.06) * R); g.lineTo((rnd() - 0.5) * 18, -(0.905 + rnd() * 0.06) * R); }
    g.stroke(); g.restore();
  }
  poly(3, 0.62, -Math.PI / 2, 5); poly(3, 0.62, Math.PI / 2, 5); poly(6, 0.62, -Math.PI / 2, 3);
  for (let i = 0; i < 6; i++) { const a = -Math.PI / 2 + i / 6 * Math.PI * 2; g.lineWidth = 4; g.beginPath(); g.arc(Math.cos(a) * 0.62 * R, Math.sin(a) * 0.62 * R, 0.05 * R, 0, Math.PI * 2); g.stroke(); }
  g.lineWidth = 3; for (let i = 0; i < 12; i++) { // petals
    const a = i / 12 * Math.PI * 2, b = (i + 1) / 12 * Math.PI * 2, m = (a + b) / 2;
    g.beginPath(); g.moveTo(Math.cos(a) * 0.34 * R, Math.sin(a) * 0.34 * R); g.quadraticCurveTo(Math.cos(m) * 0.72 * R, Math.sin(m) * 0.72 * R, Math.cos(b) * 0.34 * R, Math.sin(b) * 0.34 * R); g.stroke();
  }
  poly(4, 0.16, 0, 5); poly(4, 0.10, Math.PI / 4, 3); g.beginPath(); g.arc(0, 0, 0.03 * R, 0, Math.PI * 2); g.fill();
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, R); grd.addColorStop(0, 'rgba(255,255,255,0.08)'); grd.addColorStop(0.85, 'rgba(255,255,255,0.04)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.shadowBlur = 0; g.fillStyle = grd; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 8; return tex;
}

// Soft radial glow for bursts/flashes. Peak alpha 0.8 + steep falloff: overlapping additive sprites stay tinted instead of summing to white.
function glowTexture() {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,0.8)'); grd.addColorStop(0.3, 'rgba(255,255,255,0.4)'); grd.addColorStop(0.65, 'rgba(255,255,255,0.1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, S, S); return new THREE.CanvasTexture(c);
}

// Screen-edge vignette: transparent centre, solid edge. Tinted by material color (super = gold).
function vignetteTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.16, S / 2, S / 2, S * 0.54);
  grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.6, 'rgba(255,255,255,0.25)'); grd.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = grd; g.fillRect(0, 0, S, S); return new THREE.CanvasTexture(c);
}

// Stylized energy hand + forearm (right hand; left mirrors with group.scale.x = -1). One merged geometry = 1 draw call per layer.
// Vertex-color brightness ramp (dark wrist -> bright fingertips) so the hand reads as an energy gradient, not a flat cream mitt.
function handGeo() {
  const parts = [];
  const arm = new THREE.CylinderGeometry(0.055, 0.030, 0.42, 10); // thick end = elbow (+Y pre-rotation)
  arm.rotateX(2.25);                                              // +Y axis -> down & toward the camera
  arm.translate(0, -0.128, 0.182);                                // wrist lands just behind the palm
  parts.push(arm);
  const palm = new THREE.SphereGeometry(0.055, 12, 10); palm.scale(1.15, 0.68, 1.3); parts.push(palm);
  for (let i = 0; i < 4; i++) { // fingers: forward + tilted up (channeling pose)
    const f = new THREE.CapsuleGeometry(0.0115, 0.062, 3, 6);
    f.rotateX(-Math.PI / 2 + 0.38); f.translate(-0.036 + i * 0.024, 0.012, -0.078); parts.push(f);
  }
  const th = new THREE.CapsuleGeometry(0.012, 0.05, 3, 6); th.rotateX(-1.0); th.rotateZ(0.7); th.translate(-0.06, 0.005, -0.028); parts.push(th);
  const geo = mergeGeometries(parts);
  const p = geo.attributes.position, cols = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(0, Math.min(1, (0.28 - p.getZ(i)) / 0.42)), b = 0.15 + 0.85 * t * t;
    cols[i * 3] = cols[i * 3 + 1] = cols[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return geo;
}

// Fresnel-shaded energy-hand material. The old unlit MeshBasic + additive shell was the wave-6 verdict's
// "two enormous flat solid-yellow cartoon hands": no shading terms exist in the overlay scene, so the hand
// has to model itself — deep-amber-to-gold ramp along the arm (vertex colour), a fixed key-light lambert so
// the fingers turn, and a pale-gold fresnel rim that replaces the shell. Channels capped at 1.15 with the
// blue channel structurally tiny: saturated gold through ACES, never white (blob decree).
function handMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uDeep: { value: new THREE.Color(0x6b3407) }, uGold: { value: new THREE.Color(GOLD_CORE) }, uRim: { value: new THREE.Color(0xffd27a) } },
    vertexShader: /* glsl */`
      varying float vRamp; varying vec3 vN; varying vec3 vV;
      void main() {
        vRamp = color.r;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalMatrix * normal; vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uDeep; uniform vec3 uGold; uniform vec3 uRim;
      varying float vRamp; varying vec3 vN; varying vec3 vV;
      void main() {
        vec3 n = normalize(vN), v = normalize(vV);
        float fr = pow(1.0 - abs(dot(n, v)), 2.0);
        float lam = 0.32 + 0.68 * max(0.0, dot(n, normalize(vec3(0.4, 0.75, 0.5))));   // hard-ish key: the fingers have to TURN, or the hand is a flat orange cutout again
        vec3 c = mix(uDeep, uGold, pow(vRamp, 1.5)) * lam + uRim * fr * 0.9;           // ramp biased deep: only the fingertips reach full gold
        gl_FragColor = vec4(min(c, vec3(1.15)), 1.0);
      }`,
    vertexColors: true, side: THREE.DoubleSide, fog: false,
  });
}

export class Abilities {
  constructor(game, player) {
    this.game = game; this.player = player;
    this.superActive = false; this.superMeter = 0; this.superTimeLeft = 0;
    const mk = (id, name, key, cooldown) => ({ id, name, key, cooldown, remaining: 0, ready: true, charge: 1, use: () => this.use(id) });
    this.list = [mk('grenade', 'Aether Orb', 'G', CD.grenade), mk('melee', 'Arc Strike', 'F', CD.melee), mk('class', 'Grapple Hook', 'Q', CD.class), mk('super', 'Starfall', 'X', 6)];
    this.byId = Object.fromEntries(this.list.map((a) => [a.id, a]));
    this.byId.super.ready = false; this.byId.super.charge = 0;
    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3(); this._fwd = new THREE.Vector3(); this._right = new THREE.Vector3(); this._n = new THREE.Vector3();
    this._m4 = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._c = new THREE.Color(); this._out = [];
    this._res = { hit: false, normal: new THREE.Vector3() };
    this._info = { amount: 0, element: 'void', crit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(0, -1, 0), owner: player, source: '' };
    this._meleeAt = -1; this._grenAt = -1; this._superFire = 0; this._skyT = 0; this._superHand = 0; this._superWasReady = false;
    this._vm = null; this._vmT = 0; this._pulse = [0, 0]; this._fovDelta = 0; this._mvPulse = 0;
    this._stars = Array.from({ length: 12 }, () => ({ h: null, age: 0, pos: new THREE.Vector3() })); // tracked sky-bolt handles (landing burst + AoE resolved here)
    this._landFlashT = 0;
  }

  init() {
    const { scene, events } = this.game;
    this.root = new THREE.Group(); this.root.name = 'abilities'; scene.add(this.root);
    this._tex = sigilTexture(this.game.seed + 911); this._glow = glowTexture();
    // grapple rope + hook head (pooled, hidden when idle)
    this._rope = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0),
      new THREE.MeshBasicMaterial({ color: COL.class, transparent: true, opacity: 0.85, fog: false }));
    this._hook = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: COL.class, fog: false }));
    this._rope.visible = this._hook.visible = false; this._rope.frustumCulled = this._hook.frustumCulled = false;
    this.root.add(this._rope, this._hook);
    this._grap = { t: 0, active: false, anchor: new THREE.Vector3() };
    // sigils: rift / grenade DoT / super aura
    this.sigils = []; for (let i = 0; i < 4; i++) this.sigils.push(this._makeSigil());
    // grenade orbs
    this.orbs = []; for (let i = 0; i < 3; i++) this.orbs.push(this._makeOrb());
    // instanced bursts (spheres) + ground rings; color*alpha via instanceColor (additive => fades)
    const im = (geo, n, side) => { const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(side === undefined ? { ...ADD } : { ...ADD, side }), n); m.frustumCulled = false; m.visible = false; for (let i = 0; i < n; i++) { m.setMatrixAt(i, this._m4.makeScale(0, 0, 0)); m.setColorAt(i, this._c.setHex(0)); } m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.instanceColor.setUsage(THREE.DynamicDrawUsage); this.root.add(m); return m; };
    this.bursts = Array.from({ length: 10 }, () => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ ...ADD, map: this._glow })); sp.visible = false; this.root.add(sp); return { sp, alive: false, t: 0, dur: 0, r: 1, col: new THREE.Color() }; });
    this.ringMesh = im(new THREE.RingGeometry(0.8, 1, 64).rotateX(-Math.PI / 2), 8, THREE.DoubleSide); this.rings = Array.from({ length: 8 }, () => ({ alive: false, t: 0, dur: 0, r: 1, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), col: new THREE.Color() }));
    // grenade arc telegraph: dotted trail puffs (1 instanced draw)
    this.puffMesh = im(new THREE.SphereGeometry(0.07, 8, 6), 16);
    this.puffs = Array.from({ length: 16 }, () => ({ alive: false, t: 0, pos: new THREE.Vector3() }));
    // star motes orbiting the player while the super is up (bolts themselves are combat.projectile visuals)
    this.motes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.13, 1), new THREE.MeshBasicMaterial({ ...ADD, color: new THREE.Color(COL.super) }), 10);
    this.motes.frustumCulled = false; this.motes.visible = false; this.motes.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.root.add(this.motes);
    // fallback super hand glows (world-space, camera-anchored) — used only when the weapons overlay scene isn't available
    const hm = new THREE.MeshBasicMaterial({ ...ADD, color: new THREE.Color(COL.super), opacity: 0.5 });
    this.hands = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), hm); m.visible = false; this.root.add(m); return m; });

    // pre-warm shaders so the first ability use doesn't hitch (~3 ms compile otherwise)
    const hidden = []; this.root.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    compileForComposer(this.game.renderer, scene, this.game.camera); for (const o of hidden) o.visible = false;
    // compile() links programs but never uploads MAPS: the 1024² sigil glyph and the glow sprite would
    // otherwise be uploaded on the first grenade/burst, mid-play. Push them to the GPU here instead.
    for (const t of [this._tex, this._glow]) this.game.renderer.initTexture(t);
    this._ensureVM(); // builds + pre-warms the super hands if weapons is already up (retried at super start otherwise)

    events.on('combat:hit', (e) => { if (e?.owner === this.player && !this.superActive) this._addMeter((e.amount || 0) / 1800 + (e.killed ? 0.04 : 0)); });
    events.on('player:died', () => { if (this.superActive) this._endSuper(); });
  }

  // ---------- super viewmodel (energy hands in the weapons overlay scene) ----------
  _ensureVM() {
    if (this._vm) return true;
    const w = this.player.weapons; if (!w?.scene || !w?.cam) return false;
    // fresnel-shaded energy core (see handMaterial): shading + rim live in the shader, no additive shell
    const core = handMaterial();
    const geo = this._handGeo = handGeo();
    this._vm = { group: new THREE.Group(), hands: [], glows: [], wisps: [], vig: null };
    for (let i = 0; i < 2; i++) { // 0 = left, 1 = right
      const h = new THREE.Group();
      const c = new THREE.Mesh(geo, core);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ ...ADD, map: this._glow, color: new THREE.Color(GOLD_CORE), opacity: 0.4 }));
      glow.scale.set(0.19, 0.19, 1); glow.position.set(0, 0.03, -0.055);   // small palm ember, not a flat yellow disc over the hand
      h.add(c, glow);
      for (let k = 0; k < 3; k++) { // orbiting palm wisps: small saturated embers circling each palm
        const wsp = new THREE.Sprite(new THREE.SpriteMaterial({ ...ADD, map: this._glow, color: new THREE.Color(0xffc14d).multiplyScalar(0.9), opacity: 0.85 }));
        wsp.scale.set(0.05, 0.05, 1); h.add(wsp); this._vm.wisps.push({ sp: wsp, hand: i, k });
      }
      h.position.set(i ? 0.27 : -0.27, -0.24, i ? -0.50 : -0.52); h.rotation.set(0, i ? -0.14 : 0.14, i ? -0.08 : 0.08);
      h.scale.setScalar(0.88);                       // wave-6 "enormous": a touch smaller so the frame corners stay world, not mitten
      if (!i) h.scale.x = -0.88;
      this._vm.group.add(h); this._vm.hands.push(h); this._vm.glows.push(glow);
    }
    // golden screen vignette (persistent super-state feedback)
    const vigTex = vignetteTexture(); this.game.renderer.initTexture(vigTex);   // upload now, not on the first super (compile() does programs only)
    const vig = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ ...ADD, map: vigTex, color: new THREE.Color(0xdd8a10), opacity: 0, depthTest: false }));
    vig.position.z = -1.5; vig.renderOrder = 10; this._vm.vig = vig; this._vm.group.add(vig);
    this._vm.group.visible = false; w.scene.add(this._vm.group);
    // Ability gesture hand: the SAME armored gauntlet the guns are held with (weapons.abilityHand()) in the same
    // materials, NOT an energy mitten — the glowing hands belong to the super, where you are literally channelling
    // Starfall. Throwing a grenade and palm-striking are done with the character's actual hand; the element shows as
    // a small glow in the palm (the orb being cradled / the arc gathering), not as a see-through limb.
    const mg = new THREE.Group();
    const hand = w.abilityHand?.() ?? null;
    // 1.2x (the gesture reaches ~2x further from the eye than the gun grip) and yawed a quarter turn so the camera
    // sees the knuckles + bracer rather than the palm edge — tuned against frames, not guessed.
    if (hand) { hand.group.scale.setScalar(1.3); hand.group.rotation.set(0, Math.PI / 2, 0); mg.add(hand.group); }
    const mglow = new THREE.Sprite(new THREE.SpriteMaterial({ ...ADD, map: this._glow, color: new THREE.Color(COL.grenade), opacity: 0.45 }));
    mglow.scale.set(0.17, 0.17, 1); mglow.position.set(0, 0.01, -0.035);
    // the actual grenade, sitting in the fist until release — you could previously never see the thing being thrown
    const orb = new THREE.Group();
    const oc = new THREE.Color(COL.grenade);
    orb.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.052, 1), new THREE.MeshStandardMaterial({ color: 0x3a1060, emissive: oc, emissiveIntensity: 1.8, roughness: 0.3, metalness: 0 })));
    orb.add(new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.006, 6, 24), new THREE.MeshBasicMaterial({ ...ADD, color: oc, opacity: 0.85 })));
    orb.add(new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.005, 6, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ ...ADD, color: oc, opacity: 0.7 })));
    orb.position.set(0, 0.03, -0.055); orb.visible = false;
    for (const o of orb.children) o.frustumCulled = false;
    mg.add(mglow, orb); mg.visible = false; w.scene.add(mg);
    this._mv = { group: mg, glow: mglow, orb, hand, t: -1, k: GK.throw };
    // pre-warm — compile AND one real 4x4-target render. MEASURED (perf pass 2026-08-28, tools/out/perf-vmtest):
    // compile(w.scene, w.cam) with a target bound builds programs whose keys do NOT match what the composer's
    // overlay RenderPass asks for when these first draw — re-running the exact compile added 0 programs, yet
    // the first super cast still linked 5 (hand ShaderMaterial, palm/wisp sprites, vignette basic) for a
    // 78-303 ms frozen frame (hitchhunt perf-combat, c-super). Same lesson as HANDOVER 4l: warm what you
    // will actually DRAW — one real render while visible builds the render-path programs exactly.
    this._vm.group.visible = true; mg.visible = true;
    compileForComposer(this.game.renderer, w.scene, w.cam);
    renderForComposer(this.game.renderer, w.scene, w.cam);
    this._vm.group.visible = false; mg.visible = false;
    return true;
  }
  _updateVM(dt, t) {
    const vm = this._vm; if (!vm || !vm.group.visible) return;
    this._vmT = Math.min(1, this._vmT + dt / 0.3);
    const ease = 1 - Math.pow(1 - this._vmT, 3), sway = this.player.view?.sway;
    const out = this.superTimeLeft < 0.4 ? this.superTimeLeft / 0.4 : 1; // sink away at the end
    for (let i = 0; i < 2; i++) {
      this._pulse[i] *= Math.exp(-8 * dt);
      const h = vm.hands[i], base = -0.24;
      h.position.y = base - 0.35 * (1 - ease) - 0.3 * (1 - out) + 0.008 * Math.sin(t * 2.2 + i * 2.4);
      h.rotation.x = -0.7 * (1 - ease) + 0.05 * Math.sin(t * 1.7 + i);
      if (sway) { h.position.x = (i ? 0.27 : -0.27) - sway.x * 0.4; h.position.y += sway.y * 0.25; }
      // every bolt punches the hand forward and snaps the wrist — the super used to fire with the hands
      // perfectly still, so 6 s of bolts read as a static prop with particles coming off it
      const pu = this._pulse[i];
      h.position.z = (i ? -0.50 : -0.52) - 0.13 * pu + 0.05 * pu * pu;
      h.rotation.x += -0.38 * pu; h.rotation.z = (i ? -1 : 1) * 0.14 * pu;
      const sc = 0.88 * (1 + 0.22 * pu); h.scale.set(i ? sc : -sc, sc, sc);   // 0.88: base size, see _ensureVM
      vm.glows[i].material.opacity = 0.2 + 0.3 * this._pulse[i] + 0.04 * Math.sin(t * 9 + i * 3);
    }
    for (const w of vm.wisps) { // palm wisps: tilted orbits, tighter + brighter on fire pulse
      const a = t * (3.2 + w.k * 0.8) + w.k * 2.1 + w.hand * 3.14, r = 0.085 + 0.02 * Math.sin(t * 2.3 + w.k);
      w.sp.position.set(Math.cos(a) * r, 0.02 + 0.03 * Math.sin(a * 1.7 + w.k), -0.05 + Math.sin(a) * r * 0.7);
      const s = 0.04 + 0.02 * this._pulse[w.hand] + 0.012 * Math.sin(t * 7 + w.k * 2); w.sp.scale.set(s, s, 1);
    }
    const cam = this.player.weapons.cam, hgt = 1.8;
    vm.vig.scale.set(hgt * (cam?.aspect || 1.78) * 1.06, hgt, 1);
    vm.vig.material.opacity = (0.17 + 0.05 * Math.sin(t * 5) + 0.1 * Math.max(this._pulse[0], this._pulse[1])) * out * ease;
  }
  /** Start an ability hand gesture (melee punch / grenade lob / grapple launch) and clear the gun out of frame. */
  _gesture(kind) {
    if (this.superActive || !this._ensureVM() || !this._mv) return 0;
    const k = GK[kind]; if (!k) return 0;
    const mv = this._mv; mv.k = k; mv.t = 0; mv.group.visible = true; this._mvPulse = 0;
    mv.glow.material.color.setHex(k.glow);              // only the palm glow is elemental; the hand itself is armour
    this.player.weapons?.gesture?.(kind);
    return k.dur;
  }
  _updateGestureVM(dt) {
    const mv = this._mv; if (!mv || mv.t < 0) return;
    const k = mv.k; mv.t += dt; const p = mv.t / k.dur;
    if (p >= 1) { mv.t = -1; mv.group.visible = false; if (mv.orb) mv.orb.visible = false; return; }
    this._mvPulse *= Math.exp(-9 * dt);
    const g = mv.group;
    g.position.set(kf(p, k.x), kf(p, k.y), kf(p, k.z));
    g.rotation.set(kf(p, k.rx), kf(p, k.ry), kf(p, k.rz));
    const sc = 1 + 0.2 * this._mvPulse; g.scale.setScalar(sc);
    // grenade: the orb sits in the fist, charges as it is cocked, and leaves the hand at `rel`
    const isThrow = k === GK.throw;
    const held = isThrow ? (p < k.rel ? 0.25 + 1.5 * (p / k.rel) : Math.max(0, 1.4 - (p - k.rel) * 9)) : 0;
    if (mv.orb) {
      mv.orb.visible = isThrow && p < k.rel;
      if (mv.orb.visible) { const sc = 0.75 + 0.35 * (p / k.rel); mv.orb.scale.setScalar(sc); mv.orb.rotation.set(p * 7, p * 5, 0); }
    }
    mv.glow.material.opacity = Math.min(0.9, 0.28 + 0.45 * this._mvPulse + held * 0.4);   // capped: an additive sprite over 1.0 tone-maps to white, not to its hue
    mv.glow.scale.setScalar(0.15 + held * 0.09);
  }

  // ---------- pools ----------
  _makeSigil() {
    const grp = new THREE.Group(); grp.visible = false;
    // dark contrast disc under the glyph so the additive sigil reads in bright daylight (normal blending)
    const baseMat = new THREE.MeshBasicMaterial({ color: 0x140b20, transparent: true, opacity: 0, depthWrite: false, fog: false });
    const base = new THREE.Mesh(new THREE.CircleGeometry(0.97, 48).rotateX(-Math.PI / 2), baseMat); base.position.y = 0.04; base.renderOrder = 0;
    // depth-tested: the sigil is a ground marker IN the world; painting over foreground grass (depthTest:false) smeared it across the whole meadow
    const mat = new THREE.MeshBasicMaterial({ ...ADD, map: this._tex, side: THREE.DoubleSide });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); plane.rotation.x = -Math.PI / 2; plane.position.y = 0.1; plane.renderOrder = 2;
    const ringMat = new THREE.MeshBasicMaterial({ ...ADD });
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 6, 72), ringMat); ring1.rotation.x = Math.PI / 2; ring1.position.y = 0.12; ring1.renderOrder = 2;
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.015, 6, 64), ringMat); ring2.rotation.x = Math.PI / 2; ring2.position.y = 0.12; ring2.renderOrder = 2; // ankle height — a ground ring, not an eye-height band
    const cg = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true).translate(0, 0.5, 0);
    const p = cg.attributes.position, cols = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const k = (1 - p.getY(i)) ** 3; cols[i * 3] = cols[i * 3 + 1] = cols[i * 3 + 2] = k; }
    cg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const beamMat = new THREE.MeshBasicMaterial({ ...ADD, vertexColors: true, opacity: 0.22, side: THREE.DoubleSide });
    const beam = new THREE.Mesh(cg, beamMat); beam.scale.set(0.985, 0.7, 0.985); beam.renderOrder = 1;
    grp.add(base, plane, ring1, ring2, beam); this.root.add(grp);
    return { grp, plane, ring2, mat, ringMat, beamMat, baseMat, col: new THREE.Color(), alive: false, t: 0, dur: 0, radius: 1, kind: '', tick: 0, follow: false, id: 0 };
  }
  _makeOrb() {
    const grp = new THREE.Group(); grp.visible = false;
    const c = new THREE.Color(COL.grenade);
    grp.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 2), new THREE.MeshStandardMaterial({ color: 0x3a1060, emissive: c, emissiveIntensity: 3, roughness: 0.3, metalness: 0 })));
    grp.add(new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), new THREE.MeshBasicMaterial({ ...ADD, color: c, opacity: 0.3 })));
    grp.add(new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.014, 6, 40), new THREE.MeshBasicMaterial({ ...ADD, color: new THREE.Color(c).multiplyScalar(1.1), opacity: 0.9 })));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ ...ADD, map: this._glow, color: new THREE.Color(c), opacity: 0.8 })); glow.scale.set(2.4, 2.4, 1); grp.add(glow);
    this.root.add(grp);
    return { grp, alive: false, t: 0, bounces: 0, bounceT: 0, puffT: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), trail: null };
  }
  _oldest(pool) { let b = pool[0]; for (const p of pool) { if (!p.alive) return p; if (p.t > b.t) b = p; } return b; }
  _burst(pos, color, r, dur = 0.4) { const b = this._oldest(this.bursts); b.alive = true; b.t = 0; b.dur = dur; b.r = r; b.sp.position.copy(pos); b.col.setHex(color); b.sp.visible = true; }
  _ring(pos, color, r, dur = 0.5) {
    const g = this._oldest(this.rings); g.alive = true; g.t = 0; g.dur = dur; g.r = r; g.col.setHex(color);
    g.pos.set(pos.x, this.game.terrain.heightAt(pos.x, pos.z) + 0.2, pos.z); g.quat.setFromUnitVectors(UP, this.game.terrain.normalAt(pos.x, pos.z, this._n)); this.ringMesh.visible = true;
  }
  _puff(pos) { const p = this._oldest(this.puffs); p.alive = true; p.t = 0; p.pos.copy(pos); this.puffMesh.visible = true; }
  _sigil(kind, pos, color, radius, dur, follow = false) {
    const s = this._oldest(this.sigils); const { terrain } = this.game;
    s.alive = true; s.t = 0; s.dur = dur; s.radius = radius; s.kind = kind; s.tick = 0; s.follow = follow; s.id = (this._sigilId = (this._sigilId || 0) + 1);
    s.grp.position.set(pos.x, terrain.heightAt(pos.x, pos.z) + 0.22, pos.z); s.grp.quaternion.setFromUnitVectors(UP, terrain.normalAt(pos.x, pos.z, this._n)); s.grp.visible = true; s.grp.scale.setScalar(0.01);
    s.col.setHex(color);
    const c = this._c.setHex(color); s.mat.color.copy(c); s.ringMat.color.copy(c).multiplyScalar(1.15); s.beamMat.color.copy(c);
    return s;
  }
  _setInst(im, i, pos, quat, sx, sy, sz, col) { im.setMatrixAt(i, this._m4.compose(pos, quat, this._s.set(sx, sy, sz))); if (col) im.setColorAt(i, col); }
  _enemiesNear(point, r) { // unambiguous regardless of combat.targetsInRadius team semantics
    const out = this.game.combat.targetsInRadius?.(point, r, undefined, this._out) || [];
    let n = 0; for (const t of out) if (t && t.alive !== false && t.team !== 'player' && t.kind !== 'player') out[n++] = t;
    out.length = n; return out;
  }
  _hit(target, amount, element, source, dir) {
    const i = this._info; i.amount = amount; i.element = element; i.source = source; i.point.copy(target.position); if (dir) i.dir.copy(dir); else i.dir.set(0, -1, 0);
    this.game.combat.damage?.(target, i);
  }
  _addMeter(v) { this.superMeter = Math.min(1, this.superMeter + v); }

  // ---------- public ----------
  charge(id) { const a = this.byId[id]; if (!a) return; if (id === 'super') this.superMeter = 1; else a.remaining = 0; }
  use(id) {
    const a = this.byId[id], p = this.player; if (!a || !p.alive) return false;
    if (id === 'super') { if (this.superActive || this.superMeter < 1) return false; this._startSuper(); }
    else {
      if (a.remaining > 0 || this.superActive) return false;
      if (id === 'grenade') this._throwGrenade(); else if (id === 'melee') this._melee();
      else if (!this._grapple()) return false;   // no anchor in range: no cooldown, no toast
      a.remaining = a.cooldown;
    }
    this.game.events.emit('ability:use', { id, name: a.name });
    this.game.hud?.toast?.(a.name, { ms: 1200, kind: 'ability' });
    return true;
  }

  // ---------- grenade ----------
  _throwGrenade() {
    // the orb leaves the HAND, not the eye: play the lob and release at GK.throw.rel (the arm-extended keyframe)
    const dur = this._gesture('throw');
    this.game.audio?.play?.('ability-grenade');
    if (!dur) { this._release(); return; }
    this._grenAt = this.game.time + GK.throw.rel * dur;
  }
  _release() {
    if (!this.player.alive) return;                       // died mid-throw: the orb never leaves the hand
    const { camera, vfx } = this.game; const o = this._oldest(this.orbs);
    camera.getWorldDirection(this._fwd); this._right.crossVectors(this._fwd, UP).normalize();
    o.alive = true; o.t = 0; o.bounces = 0; o.bounceT = 0; o.puffT = 0; o.grp.visible = true;
    o.pos.copy(this.player.eye).addScaledVector(this._fwd, 0.7).addScaledVector(this._right, 0.16).addScaledVector(UP, -0.05);
    o.vel.copy(this._fwd).addScaledVector(UP, 0.22).normalize().multiplyScalar(20); o.grp.position.copy(o.pos);
    o.trail?.stop?.(); o.trail = vfx?.attach?.('spark-trail', o.grp, { color: COL.grenade, element: 'void' }) || null;
    this._mvPulse = 1;
    this.player.view.kick?.(0.018, -0.006);
  }
  _updateOrbs(dt, t) {
    const { terrain, world } = this.game;
    for (const o of this.orbs) {
      if (!o.alive) continue;
      o.t += dt; o.vel.y -= 18 * dt; o.pos.addScaledVector(o.vel, dt);
      o.puffT -= dt; if (o.puffT <= 0) { o.puffT = 0.04; this._puff(o.pos); } // dotted arc telegraph
      const gy = terrain.heightAt(o.pos.x, o.pos.z) + 0.16; let bounced = false;
      if (o.pos.y < gy) { o.pos.y = gy; terrain.normalAt(o.pos.x, o.pos.z, this._n); bounced = true; }
      else if (world?.colliders?.resolveSphere?.(o.pos, 0.16, this._res)?.hit) { this._n.copy(this._res.normal); bounced = true; }
      if (bounced) { const vn = o.vel.dot(this._n); if (vn < 0) o.vel.addScaledVector(this._n, -1.5 * vn); o.vel.multiplyScalar(0.72); if (!o.bounces) o.bounceT = o.t; o.bounces++; this.game.vfx?.emit?.('sparks', o.pos, { count: 6, color: COL.grenade }); }
      o.grp.position.copy(o.pos); o.grp.children[2].rotation.set(t * 4, t * 2.5, 0); o.grp.children[1].scale.setScalar(1 + 0.15 * Math.sin(t * 18));
      const near = this._enemiesNear(o.pos, 1.3).length > 0;
      if (o.t > 2.4 || (o.bounces && o.t > o.bounceT + 0.7) || near) { o.alive = false; o.grp.visible = false; o.trail?.stop?.(); o.trail = null; this._explode(o.pos); }
    }
  }
  _explode(p) {
    const { combat, vfx, audio, postfx } = this.game, c = COL.grenade;
    combat.explode?.({ point: p, radius: 5, damage: 110, element: 'void', owner: this.player, team: 'player', falloff: true, knockback: 5 });
    vfx?.shockwave?.(p, { radius: 5, color: c, duration: 0.45 }); vfx?.flash?.(p, { color: c, intensity: 8, distance: 14, duration: 0.1 });
    this._burst(p, 0xcf9bff, 2.4, 0.16); this._burst(p, c, 5, 0.6); this._ring(p, c, 5.5, 0.5); this._ring(p, 0xc08bff, 3, 0.3);
    this._sigil('dot', p, c, 3.2, 5);
    const d = p.distanceTo(this.player.eye), k = 1 / (1 + d / 6);
    this.player.view.shake?.(1.2 * k, 0.35); postfx?.kick?.(0.6 * k); audio?.play?.('explosion', { pos: p });
  }

  // ---------- melee ----------
  _melee() {
    const { camera, audio } = this.game, c = this.player.controller;
    camera.getWorldDirection(this._fwd); this._v1.set(this._fwd.x, 0, this._fwd.z).normalize();
    c.velocity.addScaledVector(this._v1, 7.5); if (c.grounded) c.velocity.y = Math.max(c.velocity.y, 1.2); // small lunge
    this._meleeAt = this.game.time + 0.14; audio?.play?.('ability-melee'); this.player.view.kick?.(-0.02, 0.01);
    this.player.weapons?.gesture?.('melee');   // bash with the equipped weapon — no ability hand for melee
  }
  _strike() {
    const { camera, vfx, postfx } = this.game, c = COL.melee;
    camera.getWorldDirection(this._fwd); const p = this._v1.copy(this.player.eye).addScaledVector(this._fwd, 1.9); p.y -= 0.4;
    // direct hits (not combat.explode): a palm strike is a crisp arc shockwave, not a smoke explosion
    for (const e of this._enemiesNear(p, 3.4)) { this._hit(e, 95, 'arc', 'melee', this._fwd); if (e.velocity?.isVector3) e.velocity.addScaledVector(this._fwd, 6); }
    // no vfx.shockwave here: at chest height it renders as a big camera-facing white donut; our tinted ground rings carry the hit
    vfx?.emit?.('sparks', p, { element: 'arc', color: 0x2fa8e8, count: 14, dir: this._fwd }); vfx?.flash?.(p, { color: c, intensity: 5, distance: 8, duration: 0.08 });
    this._burst(p, 0x2fa8e8, 1.7, 0.28); this._burst(p, c, 0.7, 0.12); this._ring(p, c, 4, 0.4); this._ring(p, 0x2fa8e8, 2, 0.25);
    this._mvPulse = 1;
    this.player.view.shake?.(0.7, 0.22); this.player.view.kick?.(0.03, -0.012); postfx?.kick?.(0.35);
  }

  // ---------- class: grapple hook ----------
  // Q fires a hook at whatever scenery the crosshair is on (terrain, rocks, trees, ruins — anything
  // combat's dry hitscan resolves) and flings the player toward and PAST the anchor, upward-biased,
  // like the hooks in Titanfall/Apex: one impulse, air control does the rest. Misses cost nothing.
  _grapple() {
    const g = this.game, p = this.player, view = p.view;
    const eye = p.eye ?? p.position;
    const dir = g.camera.getWorldDirection(this._grapDir ?? (this._grapDir = new THREE.Vector3()));
    const res = g.combat?.hitscan?.({ origin: eye, dir, range: 58, dry: true, team: 'player' });
    if (!res || res.surface === 'none' || res.distance < 3.5) { g.hud?.toast?.('NO ANCHOR', { ms: 700 }); return false; }
    const ctrl = p.controller, v = ctrl?.velocity;
    if (!v) return false;
    const dx = res.point.x - p.position.x, dy = res.point.y - p.position.y, dz = res.point.z - p.position.z;
    const dist = Math.max(1, Math.hypot(dx, dy, dz));
    const t = Math.min(2.1, Math.max(0.85, dist / 16));      // rough flight time: far anchors = faster yank
    v.x = dx / t * 1.12; v.z = dz / t * 1.12;
    v.y = Math.max(v.y, dy / t + 8.5 + dist * 0.1);          // upward fling carries you past the anchor lip
    ctrl.grounded = false;
    view.shake?.(0.25, 0.15);
    p.fovBoost = (p.fovBoost || 0) + 6;
    this._gesture('grapple');
    this._grap.active = true; this._grap.t = 0; this._grap.anchor.copy(res.point);
    this._rope.visible = this._hook.visible = true;
    this._hook.position.copy(res.point);
    g.vfx?.emit?.('ring', res.point, { color: COL.class, scale: 1.1 });
    g.vfx?.emit?.('aether-burst', res.point, { color: COL.class, count: 10, scale: 0.7 });
    g.audio?.play?.('ability-class');
    return true;
  }

  _rift() {
    const p = this.player.position; const s = this._sigil('heal', p, COL.class, 3.5, 10);
    this._burst(s.grp.position, COL.class, 2.5, 0.5); this._ring(p, COL.class, 4.5, 0.6); this._ring(p, 0x4fdc92, 3, 0.35);
    this.game.vfx?.emit?.('heal', s.grp.position, { color: COL.class, count: 40 }); this.game.audio?.play?.('ability-class'); this.player.view.shake?.(0.3, 0.2);
  }
  _updateSigils(dt, t) {
    const p = this.player;
    const day = Math.max(0, Math.min(1, (this.game.sky?.sunDir?.y ?? 0) * 2.2)); // daylight boost: additive glyphs dim at noon — but CAPPED so they never hit white
    const boost = 1 + day * 0.8;
    for (const s of this.sigils) {
      if (!s.alive) continue;
      s.t += dt; const life = s.dur - s.t;
      if (life <= 0) { s.alive = false; s.grp.visible = false; continue; }
      if (s.follow) { const pos = p.position; s.grp.position.set(pos.x, this.game.terrain.heightAt(pos.x, pos.z) + 0.22, pos.z); s.grp.quaternion.setFromUnitVectors(UP, this.game.terrain.normalAt(pos.x, pos.z, this._n)); }
      const a = Math.min(1, s.t / 0.35); // cubic ease-out bloom-in + gentle breathing
      s.grp.scale.setScalar(s.radius * (0.2 + 0.8 * (1 - Math.pow(1 - a, 3))) * (1 + 0.015 * Math.sin(t * 3 + s.id)));
      const fade = Math.min(1, life / 0.6), pulse = 0.85 + 0.15 * Math.sin(t * 5 + s.id);
      s.mat.opacity = fade * pulse; s.ringMat.opacity = fade; s.beamMat.opacity = (s.kind === 'aura' ? 0.05 : s.kind === 'dot' ? 0.08 : 0.12) * fade * pulse;
      s.mat.color.copy(s.col).multiplyScalar(Math.min(1.5, boost)); s.ringMat.color.copy(s.col).multiplyScalar(Math.min(1.6, 1.15 * boost)); s.beamMat.color.copy(s.col).multiplyScalar(0.9 + 0.4 * day);
      s.baseMat.opacity = 0.3 * fade * (0.3 + 0.7 * day); // contrast shadow, mostly a daytime tool
      s.plane.rotation.z = t * (s.kind === 'dot' ? -0.3 : 0.16) + s.id; s.ring2.position.y = 0.12 + 0.04 * Math.sin(t * 2 + s.id); // slow spin: a rune circle, not a whirlpool
      s.tick += dt;
      if (s.kind === 'heal') {
        const d = Math.hypot(p.position.x - s.grp.position.x, p.position.z - s.grp.position.z);
        if (d < s.radius && p.alive) {
          if (p.health < p.maxHealth) p.health = Math.min(p.maxHealth, p.health + dt * 15); else p.shield = Math.min(p.maxShield, p.shield + dt * 25);
          if (s.tick > 0.5) { s.tick = 0; this.game.vfx?.emit?.('heal', p.position, { color: COL.class, count: 8 }); }
        }
      } else if (s.kind === 'dot' && s.tick > 0.5) {
        s.tick = 0; for (const e of this._enemiesNear(s.grp.position, s.radius)) this._hit(e, 12, 'void', 'grenade-sigil');
      }
    }
  }

  // ---------- super: Starfall ----------
  _startSuper() {
    const { postfx, vfx, audio, hud } = this.game, w = this.player.weapons, c = COL.super;
    this.superActive = true; this.superMeter = 0; this.superTimeLeft = 6; this._superFire = 0; this._skyT = 0.5; this._superWasReady = false;
    this._wPrev = { locked: w.locked, suppressed: w.suppressed, canFire: w.canFire }; w.locked = true; w.suppressed = true; w.canFire = false; this.player.view.setAds?.(false);
    // viewmodel takeover: stow the gun (weapons.setHidden if present, rig fallback), raise glowing energy hands, golden vignette, +6 FOV
    if (typeof w.setHidden === 'function') { w.setHidden(true); this._hidApi = true; }
    else if (w.rig) { this._rigVis = w.rig.visible; w.rig.visible = false; }
    if (this._grenAt >= 0) { this._grenAt = -1; this._release(); }   // super interrupted a throw: the orb still leaves the hand
    if (this._ensureVM()) { this._vm.group.visible = true; this._vmT = 0; this._pulse[0] = this._pulse[1] = 1; if (this._mv) { this._mv.t = -1; this._mv.group.visible = false; } }
    else for (const h of this.hands) h.visible = true; // fallback: world-space hand glows
    const view = this.player.view; if (view && typeof view.baseFov === 'number') { this._fovDelta = 6; view.baseFov += this._fovDelta; }
    // no postfx.kick here (wave-6: "screen-wide barrel warp ... violet/red garbage at the frame edges" —
    // a 1.0-strength chromatic-aberration pulse IS a radial warp; the flash + shake carry the super pop)
    postfx?.flash?.(c, 0.9, 0.5); view.shake?.(1.4, 0.5);
    const p = this.player.position; this._burst(this._v1.set(p.x, p.y + 1, p.z), c, 3, 0.5); this._burst(this._v1, GOLD_CORE, 1.4, 0.2); this._ring(p, c, 9, 0.7); this._ring(p, GOLD_CORE, 5, 0.4);
    this._sigil('aura', p, c, 2.2, 6, true);
    vfx?.emit?.('aether-burst', this._v1, { color: c, count: 80, scale: 1 }); vfx?.flash?.(this._v1, { color: c, intensity: 12, distance: 20, duration: 0.25 });
    audio?.play?.('ability-super'); hud?.notify?.('STARFALL', 'Aetherweaver Super');
  }
  _endSuper() {
    this.superActive = false; this.superTimeLeft = 0; const w = this.player.weapons;
    if (this._wPrev) Object.assign(w, this._wPrev); this._wPrev = null;
    if (this._hidApi) { w.setHidden?.(false); this._hidApi = false; }
    else if (w?.rig && this._rigVis !== undefined) { w.rig.visible = this._rigVis; this._rigVis = undefined; }
    if (this._vm) this._vm.group.visible = false;
    for (const h of this.hands) h.visible = false;
    const view = this.player.view; if (this._fovDelta && view) { view.baseFov -= this._fovDelta; this._fovDelta = 0; }
    for (const s of this.sigils) if (s.kind === 'aura' && s.alive) s.dur = Math.min(s.dur, s.t + 0.5);
    this.game.events.emit('ability:end', { id: 'super' });
  }
  _fireBolt() {
    const { camera, combat } = this.game;
    camera.getWorldDirection(this._fwd); this._right.crossVectors(this._fwd, UP).normalize();
    const hand = this._superHand = 1 - this._superHand; this._pulse[hand] = 1;
    // spawn 1.7 m out with a modest tracer: at 1.1 m / size 0.42 the stretched core billboard rendered as a screen-filling white slab
    const o = this._v1.copy(this.player.eye).addScaledVector(this._fwd, 1.7).addScaledVector(this._right, hand ? 0.28 : -0.28).addScaledVector(UP, -0.18);
    const d = this._v3.copy(this._fwd).addScaledVector(this._right, (Math.random() - 0.5) * 0.1).addScaledVector(UP, (Math.random() - 0.5) * 0.1 + 0.04).normalize();
    // home on the nearest enemy roughly in front of the reticle
    let best = null, bd = 1e9;
    for (const e of this._enemiesNear(this.player.eye, 90)) { const dd = this._v2.subVectors(e.position, this.player.eye).length(); if (dd < bd && this._v2.normalize().dot(this._fwd) > 0.2) { bd = dd; best = e; } }
    combat.projectile?.({ origin: o, dir: d, speed: 55, damage: 65, element: 'solar', owner: this.player, team: 'player', radius: 0.3, gravity: 0, life: 3, homing: best, turn: 9,
      visual: { color: GOLD_CORE, size: 0.18, stretch: 3.5, glow: 0.8, trail: true }, source: 'starfall' }); // direct damage only: no explode = no black-smoke spam; glow 0.8 — at 1.2 the spawn glow read as a flat yellow disc at the reticle
  }
  _skyBolt() { // stars falling FROM the sky — the "Starfall" framing + finishes what the hand bolts start
    const { camera, combat, terrain } = this.game;
    camera.getWorldDirection(this._fwd);
    let best = null, bd = 1e9;
    for (const e of this._enemiesNear(this.player.eye, 70)) { const dd = this._v2.subVectors(e.position, this.player.eye).length(); if (dd < bd) { bd = dd; best = e; } }
    if (best) this._v1.copy(best.position);
    else { this._v1.copy(this.player.eye).addScaledVector(this._fwd, 18); this._v1.y = terrain.heightAt(this._v1.x, this._v1.z); } // no target: still rain stars ahead
    const o = this._v2.set(this._v1.x + (Math.random() - 0.5) * 7, this._v1.y + 13 + Math.random() * 5, this._v1.z + (Math.random() - 0.5) * 7);
    const d = this._v3.subVectors(this._v1, o).normalize();
    const h = combat.projectile?.({ origin: o, dir: d, speed: 60, damage: 100, element: 'solar', owner: this.player, team: 'player', radius: 0.4, gravity: 0, life: 4, homing: best, turn: 12,
      visual: { color: GOLD_CORE, size: 0.5, stretch: 7, glow: 1.5, trail: true }, source: 'starfall-sky' }); // thick golden streak from the sky
    if (h) { let s = this._stars.find((x) => !x.h) || this._stars[0]; s.h = h; s.age = 0; s.pos.copy(o); } // track for the landing burst + AoE
  }
  _starLand(p) { // our own landing: saturated gold burst + small AoE — combat.explode's vfx is a sooty smoke column that fights the solar fantasy
    for (const e of this._enemiesNear(p, 3)) { this._hit(e, 40, 'solar', 'starfall-sky'); if (e.velocity?.isVector3) { this._v3.subVectors(e.position, p).normalize(); e.velocity.addScaledVector(this._v3, 3); } }
    this._burst(p, GOLD_CORE, 2.4, 0.3); this._burst(p, COL.super, 1.1, 0.14); this._ring(p, COL.super, 3.4, 0.4);
    this.game.vfx?.emit?.('sparks', p, { element: 'solar', color: COL.super, count: 12 });
    if (this.game.time - this._landFlashT > 0.25) { this._landFlashT = this.game.time; this.game.vfx?.flash?.(p, { color: GOLD_CORE, intensity: 6, distance: 10, duration: 0.12 }); }
  }
  _updateStars() { // watch tracked sky bolts; when one dies (or its pooled handle is reused: age went backwards), land it at its last known position
    for (const s of this._stars) {
      const h = s.h; if (!h) continue;
      if (h.alive && h.source === 'starfall-sky' && h.age >= s.age) { s.age = h.age; s.pos.copy(h.position); }
      else { s.h = null; this._starLand(s.pos); }
    }
  }
  // grapple rope: anchored line from the hand while the fling plays out, then a quick reel-back.
  _updateGrapple(dt) {
    const G = this._grap; if (!G || !G.active) return;
    G.t += dt;
    const LIFE = 0.55, RETRACT = 0.18, OUT = 0.10;
    const cam = this.game.camera;
    // hand offset: tracks the grapple gesture hand (right, below the eye) so the rope reads as thrown, not eye-lasered
    this._v2.set(0.20, -0.24, -0.28).applyQuaternion(cam.quaternion).add(this.player.eye ?? this.player.position);
    const end = this._v3.copy(G.anchor);
    if (G.t < OUT) { const r = G.t / OUT; end.lerp(this._v2, 1 - r * r * (3 - 2 * r)); }  // hook FLIES out (it used to teleport full-length)
    else if (G.t > LIFE - RETRACT) end.lerp(this._v2, (G.t - (LIFE - RETRACT)) / RETRACT);   // reel the hook back in
    if (G.t >= LIFE) { G.active = false; this._rope.visible = this._hook.visible = false; return; }
    const len = Math.max(0.1, end.distanceTo(this._v2));
    this._rope.position.copy(this._v2);
    this._rope.quaternion.setFromUnitVectors(UP, this._n.copy(end).sub(this._v2).divideScalar(len));
    this._rope.scale.set(0.03, len, 0.03);
    this._hook.position.copy(end);
    const k = 1 - G.t / LIFE;
    this._rope.material.opacity = 0.85 * Math.min(1, k * 3);
  }

  _updateMotes() {
    this.motes.visible = this.superActive; if (!this.superActive) return;
    const e = this.player.eye, tt = this.game.time;
    for (let k = 0; k < 10; k++) {
      const a = tt * (1.6 + k * 0.13) + k * 2.1, r = 1.1 + 0.3 * Math.sin(tt * 2 + k), sc = 0.45 + 0.2 * Math.sin(tt * 9 + k);
      this._v2.set(e.x + Math.cos(a) * r, e.y - 0.4 + 0.5 * Math.sin(tt * 1.3 + k * 1.7), e.z + Math.sin(a) * r);
      this._setInst(this.motes, k, this._v2, this._q.identity(), sc, sc, sc);
    }
    this.motes.instanceMatrix.needsUpdate = true;
  }
  _updateSuper(dt, t) {
    if (!this.superActive) return;
    this.superTimeLeft -= dt; this._superFire -= dt; this._skyT -= dt; this.byId.super.remaining = Math.max(0, this.superTimeLeft);
    if (this._superFire <= 0) { this._superFire += 0.16; this._fireBolt(); }
    if (this._skyT <= 0) { this._skyT += 0.4; this._skyBolt(); }
    if (!this._vm) { // fallback world-space glows only
      const { camera } = this.game; camera.getWorldDirection(this._fwd); this._right.crossVectors(this._fwd, UP).normalize();
      this.hands.forEach((h, i) => { h.position.copy(this.player.eye).addScaledVector(this._fwd, 0.6).addScaledVector(this._right, i ? 0.3 : -0.3).addScaledVector(UP, -0.22); h.scale.setScalar(1 + 0.3 * Math.sin(t * 14 + i * 2)); });
    }
    if (this.superTimeLeft <= 0) this._endSuper();
  }

  // ---------- frame ----------
  update(dt, t) {
    const { input, events } = this.game;
    if (input.active && this.player.alive) {
      if (input.justPressed('KeyG')) this.use('grenade'); if (input.justPressed('KeyF')) this.use('melee');
      if (input.justPressed('KeyQ')) this.use('class'); if (input.justPressed('KeyX')) this.use('super');
    }
    if (this._meleeAt >= 0 && t >= this._meleeAt) { this._meleeAt = -1; this._strike(); }
    if (this._grenAt >= 0 && t >= this._grenAt) { this._grenAt = -1; this._release(); }
    this._updateGrapple(dt);
    // cooldowns + super meter
    for (const a of this.list) {
      if (a.id === 'super') continue;
      if (a.remaining > 0) { a.remaining = Math.max(0, a.remaining - dt); if (a.remaining === 0) events.emit('ability:ready', { id: a.id }); }
      a.ready = a.remaining === 0; a.charge = 1 - a.remaining / a.cooldown;
    }
    if (!this.superActive) { this._addMeter(dt / 150); const s = this.byId.super; s.charge = this.superMeter; s.ready = this.superMeter >= 1; s.remaining = 0;
      if (s.ready && !this._superWasReady) { this._superWasReady = true; events.emit('ability:ready', { id: 'super' }); this.game.hud?.toast?.('Super ready', { ms: 1500, kind: 'super' }); } }
    else { const s = this.byId.super; s.charge = this.superTimeLeft / 6; s.ready = false; }
    this._updateOrbs(dt, t); this._updateSigils(dt, t); this._updateSuper(dt, t); this._updateStars(); this._updateMotes(); this._updateVM(dt, t); this._updateGestureVM(dt);
    // bursts + rings (instanced, additive: fade by colour). Colour multipliers <= ~1: hue survives ACES/bloom in daylight
    let anyR = false;
    for (const b of this.bursts) {
      if (!b.alive) continue;
      b.t += dt; if (b.t >= b.dur) { b.alive = false; b.sp.visible = false; continue; }
      const k = b.t / b.dur, sc = b.r * 2 * (0.35 + 0.65 * Math.sqrt(k)); b.sp.scale.set(sc, sc, 1); b.sp.material.opacity = (1 - k) * (1 - k); b.sp.material.color.copy(b.col).multiplyScalar(0.85);
    }
    for (let i = 0; i < this.rings.length; i++) {
      const g = this.rings[i]; if (g.alive) { g.t += dt; if (g.t >= g.dur) g.alive = false; }
      if (!g.alive) { this._setInst(this.ringMesh, i, g.pos, g.quat, 0, 0, 0); continue; }
      anyR = true; const k = g.t / g.dur, sc = g.r * (0.15 + 0.85 * (1 - Math.pow(1 - k, 2))); this._setInst(this.ringMesh, i, g.pos, g.quat, sc, 1, sc, this._c.copy(g.col).multiplyScalar(1 - k));
    }
    this.ringMesh.instanceMatrix.needsUpdate = this.ringMesh.instanceColor.needsUpdate = true; this.ringMesh.visible = anyR;
    // grenade trail puffs
    let anyP = false;
    for (let i = 0; i < this.puffs.length; i++) {
      const p = this.puffs[i]; if (p.alive) { p.t += dt; if (p.t >= 0.5) p.alive = false; }
      if (!p.alive) { this._setInst(this.puffMesh, i, p.pos, this._q.identity(), 0, 0, 0); continue; }
      anyP = true; const k = p.t / 0.5, sc = 1 - 0.55 * k;
      this._setInst(this.puffMesh, i, p.pos, this._q.identity(), sc, sc, sc, this._c.setHex(COL.grenade).multiplyScalar(1.1 * (1 - k)));
    }
    this.puffMesh.instanceMatrix.needsUpdate = this.puffMesh.instanceColor.needsUpdate = true; this.puffMesh.visible = anyP;
  }
}
