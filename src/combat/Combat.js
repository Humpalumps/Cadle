import * as THREE from 'three';

/**
 * Combat: damage model + hit resolution. THE shared contract between weapons, enemies, abilities, vfx, hud, audio.
 *
 * Targets (damageable things) register here:
 *   combat.register(target) / combat.unregister(target)
 *   target = { kind:'enemy'|'player'|'prop'|'boss', position:Vector3 (center of body, world, kept updated by owner),
 *              radius:number, height?:number (capsule from position-height/2 to +height/2; omit -> sphere),
 *              alive:boolean, takeDamage(info) -> void,
 *              weakPoints?: [{ position:Vector3 (world, owner updates), radius:number, mult:number }],
 *              object?: Object3D (optional, for reference), team?: 'player'|'enemy' (default: kind player->'player', prop->neutral, else 'enemy'),
 *              shieldElement?: element (Destiny "match game": damage of the same element does 2x while target.shield > 0 / shield undefined),
 *              health?/shield? (if present, health<=0 after takeDamage also counts as a kill),
 *              velocity?:Vector3 or knockback?(dir, strength) (used by explosion knockback) }
 *   info = { amount, element:'kinetic'|'solar'|'arc'|'void'|'stasis'|'strand', crit:boolean, point:Vector3, normal:Vector3, dir:Vector3, owner:any, source?:string, target }
 *
 * Queries / actions:
 *   combat.hitscan({ origin, dir, range=300, damage, element='kinetic', critMult=1.6, owner, team='player', spread=0 (radians cone half-angle), pierce=false,
 *                    falloffStart?, falloffEnd=range, falloffMin=0.5  (damage falloff: 1 until falloffStart, linear down to falloffMin at falloffEnd)
 *                    | falloff:[start,end] | falloff:(dist)=>mult   (all three forms accepted; combat.testFalloff() self-checks them),
 *                    dry=false (dry: resolve only, no damage/events — HUD target-under-reticle, AI LOS), source? })
 *       -> { point, normal, distance, target|null, crit, damage, surface:'enemy'|'player'|'terrain'|'rock'|'prop'|'water'|'none', killed, weakPoint|null }
 *       (always returns an object; point = end of ray if nothing hit). Result objects are a ring of 32 — copy what you keep.
 *       Tests: targets of the opposing team (capsule/sphere + weak points -> crit = weapon critMult * weakPoint.mult; first-struck hitbox wins:
 *       a torso hit that only clips a weak point deeper along the ray is NOT a crit), world colliders (exact sphere/capsule/box),
 *       terrain (adaptive ray-march of heightAt + bisection). Applies damage, emits events. Collider hits report collider.surface ?? 'rock'.
 *       Rays crossing the lake surface (game.world.water.level, inside water) stop there with surface 'water' (splash vfx/audio hook) instead of marching submerged ground.
 *   combat.projectile({ origin, dir, speed, damage, element, owner, team, radius=0.15, gravity=0, life=6, homing?:target, turn=5 (rad/s), critMult=1,
 *                       explode?:{ radius, damage=projectile damage, falloff=true, knockback=0, direct=0 (extra damage to the directly hit target) },
 *                       visual?:{ color, size, trail=true, stretch=3.5, mesh?:Object3D } })
 *       -> handle { alive, position, velocity, kill() }   (pooled; handle is reused after death)
 *   combat.explode({ point, radius, damage, element, owner, team, falloff=true, knockback=0 }) -> hit count
 *       (line-of-sight occlusion: a world collider/terrain ray from the blast point to each target's centre — blocked = no damage, no knockback)
 *   combat.damage(target, info)                  direct damage (melee, DoT, boss mechanics). Returns the amount actually applied.
 *   combat.targetsInRadius(point, r, team?, out=[]) -> out   (team = team of the targets to return; omit for all)
 *   combat.nearest(point, maxDist, team?) -> target|null
 *   combat.rayWorld(origin, dir, range) -> { point, normal, distance, surface, collider } | null   (terrain + colliders only; ring of 8)
 *   combat.spawnDummy(pos?, { health=300, shield=0, shieldElement, level, respawn=3 }) -> dummy   debug target (mannequin + head weak point, regenerates)
 *   combat.aimBallistic(origin, target, speed, gravity, hi=true) -> unit dir Vector3 | null   exact lob solution for gravity projectiles
 *   combat.testMortar(dist=25) -> { dummy, proj, eta } | null   deterministic mortar acceptance test: lobs a solar mortar exactly onto a fresh
 *       dummy `dist` m ahead of the player; eval it, wait > eta s (~2.2), dummy.health < dummy.maxHealth proves splash-on-target.
 *   combat.clearDummies();  combat.stats = { shots, hits, crits, kills, damage, projectiles, explosions }
 *   URL: ?dummies=N spawns N training dummies 12 m in front of spawn.
 *
 * Events (game.events):
 *   'combat:hit'       { target, amount, crit, point, normal, element, owner, killed:boolean, source }   (vfx/hud/audio listen)
 *   'combat:impact'    { point, normal, surface, element, owner }                              (world hit, no target)
 *   'combat:explosion' { point, radius, element, owner }
 *   'combat:kill'      { target, owner, point }
 *   'combat:projectile' { handle } on spawn
 *   Payload objects (and their Vector3s) come from small rings (hit: 64) — copy what you keep past the callback.
 *
 * Rules: damage numbers are NOT drawn here (HUD does). No per-frame allocation in hot paths. Projectiles pooled
 * (one InstancedMesh for bolt cores + one instanced stretched-billboard quad draw for glow halos, any count).
 */

export const ELEMENT_COLORS = { kinetic: 0xffe9c4, solar: 0xff8a3d, arc: 0x7fd8ff, void: 0xb070ff, stasis: 0x9fd8ff, strand: 0x7cff9c };
// bolt visuals use a deeper, fully saturated palette so element colour survives daylight tone mapping (arc=blue, void=violet...)
const BOLT_COLORS = { kinetic: 0xffe3b0, solar: 0xff5a10, arc: 0x1e9bff, void: 0x9a35ff, stasis: 0x4a55ff, strand: 0x17e05f };
const UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, 1), WHITE = new THREE.Color(1, 1, 1);
const _hsl = { h: 0, s: 0, l: 0 };
const POOL = 128, RING = 32, HIT_RING = 64, MAX_HITS = 16;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------- zero-alloc ray tests (module temps never escape) ----------
const _ab = new THREE.Vector3(), _oa = new THREE.Vector3(), _oc = new THREE.Vector3();
/** ray (o, unit d) vs sphere: t >= 0 or -1. origin inside -> 0 */
function raySphere(o, d, c, r) {
  _oc.subVectors(o, c);
  const b = _oc.dot(d), cc = _oc.lengthSq() - r * r;
  if (cc <= 0) return 0;
  if (b > 0) return -1;
  const h = b * b - cc;
  return h < 0 ? -1 : -b - Math.sqrt(h);
}
/** ray vs capsule (segment a-b, radius r): t >= 0 or -1. origin inside -> 0 */
function rayCapsule(o, d, a, b, r) {
  _ab.subVectors(b, a); _oa.subVectors(o, a);
  const baba = _ab.lengthSq();
  if (baba < 1e-8) return raySphere(o, d, a, r);
  const baoa = _ab.dot(_oa);
  const s = clamp01(baoa / baba);
  const dx = _oa.x - _ab.x * s, dy = _oa.y - _ab.y * s, dz = _oa.z - _ab.z * s;
  if (dx * dx + dy * dy + dz * dz <= r * r) return 0;
  const bard = _ab.dot(d), rdoa = d.dot(_oa), oaoa = _oa.lengthSq();
  const A = baba - bard * bard, B = baba * rdoa - baoa * bard, C = baba * oaoa - baoa * baoa - r * r * baba;
  if (A > 1e-6) {
    const h = B * B - A * C;
    if (h < 0) return -1;                                  // misses the infinite cylinder -> misses caps too
    const t = (-B - Math.sqrt(h)) / A, y = baoa + t * bard;
    if (t >= 0 && y > 0 && y < baba) return t;
  }
  const ta = raySphere(o, d, a, r), tb = raySphere(o, d, b, r);
  return ta < 0 ? tb : tb < 0 ? ta : Math.min(ta, tb);
}
/** closest point on segment a-b to p -> out */
function segClosest(p, a, b, out) {
  _ab.subVectors(b, a); const l2 = _ab.lengthSq();
  const s = l2 < 1e-8 ? 0 : clamp01(_oa.subVectors(p, a).dot(_ab) / l2);
  return out.copy(a).addScaledVector(_ab, s);
}
function boxNormal(box, p, out) {
  const hx = (box.max.x - box.min.x) * 0.5 || 1e-6, hy = (box.max.y - box.min.y) * 0.5 || 1e-6, hz = (box.max.z - box.min.z) * 0.5 || 1e-6;
  const fx = (p.x - (box.min.x + hx)) / hx, fy = (p.y - (box.min.y + hy)) / hy, fz = (p.z - (box.min.z + hz)) / hz;
  const ax = Math.abs(fx), ay = Math.abs(fy), az = Math.abs(fz);
  if (ax >= ay && ax >= az) return out.set(Math.sign(fx) || 1, 0, 0);
  if (ay >= az) return out.set(0, Math.sign(fy) || 1, 0);
  return out.set(0, 0, Math.sign(fz) || 1);
}
const mkRes = () => ({ point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), distance: 0, target: null, crit: false, damage: 0, surface: 'none', killed: false, weakPoint: null });
const mkInfo = () => ({ amount: 0, element: 'kinetic', crit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(0, 0, -1), owner: null, source: null, target: null });
const mkHitEv = () => ({ target: null, amount: 0, crit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), element: 'kinetic', owner: null, killed: false, source: null });
const mkImpEv = () => ({ point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), surface: 'terrain', element: 'kinetic', owner: null });
const mkWorld = () => ({ point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), distance: 0, surface: 'none', collider: null });

// ---------- projectile pool entry (also the public handle) ----------
class Projectile {
  constructor(index) {
    this.index = index; this.alive = false; this.combat = null;
    this.position = new THREE.Vector3(); this.velocity = new THREE.Vector3(); this.prev = new THREE.Vector3();
    this.node = new THREE.Object3D(); this.node.name = 'projectile';   // followed by vfx trails / custom meshes
    this.color = new THREE.Color(); this.coreColor = new THREE.Color(); this.size = 0.12; this.stretch = 2.5; this.glow = 1;
    this.radius = 0.15; this.gravity = 0; this.life = 6; this.age = 0; this.damage = 0; this.element = 'kinetic';
    this.owner = null; this.team = 'player'; this.homing = null; this.turn = 5; this.explode = null; this.critMult = 1;
    this.trail = null; this.mesh = null; this.source = null; this.hasCore = true; this._li = -1;
  }
  kill() { if (this.alive) this.combat._despawn(this); }
}

// halo = view-oriented quad stretched along the screen-space velocity (Destiny "hot dart": white-hot core + saturated tail)
const HALO_VERT = /* glsl */`
attribute vec3 aPos; attribute vec3 aVel; attribute vec3 aColor; attribute float aSize;
varying vec2 vUv; varying vec3 vColor; varying float vFade;
#include <fog_pars_vertex>
void main() {
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(aPos, 1.0);
  // near-camera coverage fade: a bolt detonating at the lens projects its halo over much of the frame,
  // and several volley halos additively summed there was the celestial "41k-px pale disc" gate finding.
  // Fade by projected coverage (size/depth) — same discipline as the particle pool's wash guard.
  vFade = 1.0 - smoothstep(1.2, 2.4, aSize / max(-mvPosition.z, 0.05));
  vec3 vv = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
  vec2 sd = vv.xy; float sl = length(sd);
  vec2 axis = sl > 1e-4 ? sd / sl : vec2(1.0, 0.0);
  float e = clamp(sl * 0.06, 0.0, 1.0) * 3.0;                 // up to 4x elongation; head-on bolts stay round (correct)
  float w = 1.0 - e * 0.11;                                   // darts get thinner as they stretch (Destiny needle, not a plate)
  mvPosition.xy += (axis * position.x * (1.0 + e) + vec2(-axis.y, axis.x) * position.y * w) * aSize;
  vUv = position.xy;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const HALO_FRAG = /* glsl */`
varying vec2 vUv; varying vec3 vColor; varying float vFade;
#include <fog_pars_fragment>
void main() {
  float d2 = dot(vUv, vUv);
  if (d2 > 1.0) discard;
  // two lobes + a pinhead core. The lobes stay CHROMATIC (peak ~1.5x the element colour): additive HDR much above that
  // clips every channel and ACES hands back a white balloon in daylight — the whole point is the bolt keeps its hue.
  float t = 1.0 - d2;
  float wide = t * t;                                          // broad soft glow, exactly 0 at the rim -> no visible disc edge on bright sky
  float tight = (exp(-9.0 * d2) - 1.2341e-4) * 1.000123;
  float core = exp(-58.0 * d2);                                // only this pinhead goes white-hot (bloom turns it into the sizzle)
  vec3 col = (vColor * (wide * 0.55 + tight) + mix(vColor, vec3(1.0), 0.65) * core * 1.35) * vFade;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float ff = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float ff = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col *= 1.0 - ff;
  #endif
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------- debug training dummy (implements the target interface itself) ----------
class Dummy {
  constructor(combat, x, y, z, opts = {}) {
    this.combat = combat; this.kind = 'enemy'; this.team = 'enemy'; this.name = opts.name ?? 'Training Dummy'; this.level = opts.level ?? 1;
    this.radius = 0.45; this.height = 1.5; this.alive = true;   // body capsule ends at the neck so the head weak point is first-struck on headshots
    this.maxHealth = opts.health ?? 300; this.health = this.maxHealth;
    this.maxShield = opts.shield ?? 0; this.shield = this.maxShield; this.shieldElement = opts.shieldElement ?? null;
    this.respawnTime = opts.respawn ?? 3; this.deadAt = -1; this._flash = 0; this._fall = 0; this.lastHit = -99;
    this.feet = new THREE.Vector3(x, y, z);
    this.position = new THREE.Vector3(x, y + 0.9, z);
    this.weakPoints = [{ position: new THREE.Vector3(x, y + 1.64, z), radius: 0.26, mult: 1 }];
    // look: slate-blue training mannequin — torso on a post, shoulders + arms, gold collar and chest target ring, head sphere (the weak point), stone plinth.
    const g = this.object = new THREE.Group(); g.position.copy(this.feet);
    const bodyMat = this.bodyMat = new THREE.MeshStandardMaterial({ color: 0x55627a, roughness: 0.55, metalness: 0.35, emissive: 0x000000 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.35, metalness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.5, 6, 14), bodyMat); body.position.y = 0.95; body.scale.z = 0.72; body.castShadow = true; body.receiveShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), bodyMat); head.position.y = 1.64; head.scale.set(0.88, 1.05, 0.92); head.castShadow = true;
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.045, 8, 24), gold); collar.rotation.x = Math.PI / 2; collar.position.y = 1.4;
    const armG = new THREE.CapsuleGeometry(0.085, 0.46, 4, 10);
    const armL = new THREE.Mesh(armG, bodyMat); armL.position.set(0.46, 0.98, 0); armL.rotation.z = 0.3; armL.castShadow = true;
    const armR = new THREE.Mesh(armG, bodyMat); armR.position.set(-0.46, 0.98, 0); armR.rotation.z = -0.3; armR.castShadow = true;
    const shoulderG = new THREE.SphereGeometry(0.13, 10, 8);
    const shL = new THREE.Mesh(shoulderG, gold); shL.position.set(0.38, 1.28, 0);
    const shR = new THREE.Mesh(shoulderG, gold); shR.position.set(-0.38, 1.28, 0);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.022, 8, 24), gold); ring.position.set(0, 1.02, 0.28);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.55, 10), new THREE.MeshStandardMaterial({ color: 0x3c3a36, roughness: 0.8, metalness: 0.3 })); post.position.y = 0.3; post.castShadow = true;
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.12, 18), new THREE.MeshStandardMaterial({ color: 0x8d8a80, roughness: 0.9 })); plinth.position.y = 0.06; plinth.receiveShadow = true;
    const pivot = this.pivot = new THREE.Group(); pivot.add(body, head, collar, armL, armR, shL, shR, ring, post); g.add(pivot, plinth);
    if (this.shieldElement) { bodyMat.emissive.set(ELEMENT_COLORS[this.shieldElement] ?? 0xffffff); bodyMat.emissiveIntensity = 0.45; }
    combat.game.scene.add(g);
  }
  takeDamage(info) {
    let a = info.amount; const s = Math.min(this.shield, a); this.shield -= s; a -= s;
    this.health = Math.max(0, this.health - a); this._flash = 1; this.lastHit = this.combat.time;
    if (this.health <= 0 && this.alive) { this.alive = false; this.deadAt = this.combat.time; }
  }
  update(dt, t) {
    const m = this.bodyMat;
    this._flash = Math.max(0, this._flash - dt * 2.8);                              // ~0.35 s hold so hits register on screen
    const base = this.shieldElement && this.shield > 0 ? 0.45 : 0;
    m.emissiveIntensity = base + this._flash * 2.5;
    if (!this.shieldElement) m.emissive.setScalar(this._flash * 0.6);                 // white hit flash
    // death: topple over, then stand back up after respawnTime (regen for testing)
    const goal = this.alive ? 0 : 1;
    this._fall += (goal - this._fall) * Math.min(1, dt * 8);
    this.pivot.rotation.x = this._fall * 1.45;
    if (!this.alive && t - this.deadAt > this.respawnTime) { this.alive = true; this.health = this.maxHealth; this.shield = this.maxShield; this._flash = 1; }
    else if (this.alive && this.maxShield > 0 && t - this.lastHit > 4 && this.shield < this.maxShield) this.shield = Math.min(this.maxShield, this.shield + dt * this.maxShield / 3);
  }
  dispose() { this.combat.game.scene.remove(this.object); this.object.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
}

export class Combat {
  constructor(game) {
    this.game = game;
    this.targets = new Set(); this.list = [];            // list mirrors the set for allocation-free iteration
    this.projectiles = [];                               // live projectiles (read-only for others)
    this.dummies = [];
    this.stats = { shots: 0, hits: 0, crits: 0, kills: 0, damage: 0, projectiles: 0, explosions: 0 };
    this.time = 0;
    // temps
    this._o = new THREE.Vector3(); this._d = new THREE.Vector3(); this._p = new THREE.Vector3(); this._n = new THREE.Vector3();
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._t1 = new THREE.Vector3(); this._t2 = new THREE.Vector3();
    this._cN = new THREE.Vector3(); this._cHit = null; this._kb = new THREE.Vector3(); this._pd = new THREE.Vector3(); this._sc = new THREE.Vector3(); this._hp = new THREE.Vector3();
    this._tmpColor = new THREE.Color();
    this._ray = new THREE.Ray(); this._q = []; this._seen = new Set(); this._mat = new THREE.Matrix4(); this._quat = new THREE.Quaternion(); this._scl = new THREE.Vector3();
    this._hits = Array.from({ length: MAX_HITS }, () => ({ t: 0, target: null, wp: null, body: -1 }));
    this._results = Array.from({ length: RING }, mkRes); this._ri = 0;
    this._infos = Array.from({ length: 16 }, mkInfo); this._ii = 0;
    this._hitEvs = Array.from({ length: HIT_RING }, mkHitEv); this._hi = 0;
    this._impEvs = Array.from({ length: 16 }, mkImpEv); this._imi = 0;
    this._worldRes = Array.from({ length: 8 }, mkWorld); this._wi = 0;
    this._explEv = { point: new THREE.Vector3(), radius: 0, element: 'kinetic', owner: null };
    this._killEv = { target: null, owner: null, point: new THREE.Vector3() };
    this._projEv = { handle: null };
    this._terrainMaxY = 260;                             // rays above this and rising can't hit terrain (mountains top out ~150)
    this._pool = Array.from({ length: POOL }, (_, i) => { const p = new Projectile(i); p.combat = this; return p; });
    this._free = this._pool.slice().reverse();
    this._dirty = false;
  }

  init() {
    const scene = this.game.scene;
    // bolt cores: one instanced low-poly sphere, HDR instance colors (bloom does the glow)
    const geo = new THREE.SphereGeometry(1, 10, 7);
    this.coreMesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), POOL);
    this.coreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coreMesh.frustumCulled = false; this.coreMesh.castShadow = false; this.coreMesh.receiveShadow = false; this.coreMesh.name = 'projectile-cores';
    this.coreMesh.setColorAt(0, WHITE); this.coreMesh.count = 0; this.coreMesh.visible = false;
    scene.add(this.coreMesh);
    // glow halos: one instanced quad draw, view-oriented + velocity-stretched, additive, fog-aware
    const quad = new THREE.PlaneGeometry(2, 2);
    const pg = new THREE.InstancedBufferGeometry();
    pg.index = quad.index; pg.setAttribute('position', quad.getAttribute('position'));
    this._gPos = new Float32Array(POOL * 3).fill(-1e4); this._gVel = new Float32Array(POOL * 3); this._gCol = new Float32Array(POOL * 3); this._gSize = new Float32Array(POOL);
    pg.setAttribute('aPos', new THREE.InstancedBufferAttribute(this._gPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aVel', new THREE.InstancedBufferAttribute(this._gVel, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aColor', new THREE.InstancedBufferAttribute(this._gCol, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aSize', new THREE.InstancedBufferAttribute(this._gSize, 1).setUsage(THREE.DynamicDrawUsage));
    pg.instanceCount = 0;
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: HALO_VERT, fragmentShader: HALO_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    });
    this.glowMesh = new THREE.Mesh(pg, this.glowMat); this.glowMesh.frustumCulled = false; this.glowMesh.name = 'projectile-glow'; this.glowMesh.visible = false;
    scene.add(this.glowMesh);
    const n = Number(this.game.params?.get('dummies') || 0);
    for (let i = 0; i < n; i++) { const a = (i - (n - 1) / 2) * 0.35; this.spawnDummy({ x: Math.sin(a) * 12, z: -Math.cos(a) * 12 }, { shieldElement: i % 3 === 1 ? 'arc' : i % 3 === 2 ? 'solar' : null, shield: i % 3 ? 150 : 0 }); }
  }

  // ---------- registry ----------
  register(t) { if (!this.targets.has(t)) { this.targets.add(t); this.list.push(t); } return t; }
  unregister(t) { if (this.targets.delete(t)) { const i = this.list.indexOf(t); if (i >= 0) this.list.splice(i, 1); } }
  teamOf(t) { return t.team ?? (t.kind === 'player' ? 'player' : t.kind === 'prop' ? null : 'enemy'); }
  _hostile(t, team) { const tt = this.teamOf(t); return tt === null || tt !== team; }
  /** distance from point to the target's surface (<= 0 inside) */
  _surfDist(t, p) {
    if (t.height) { const h = Math.max(0, t.height * 0.5 - t.radius); this._a.copy(t.position); this._a.y -= h; this._b.copy(t.position); this._b.y += h; return segClosest(p, this._a, this._b, this._sc).distanceTo(p) - t.radius; }
    return t.position.distanceTo(p) - t.radius;
  }

  // ---------- queries ----------
  targetsInRadius(point, r, team, out = []) {
    out.length = 0;
    for (let i = 0; i < this.list.length; i++) { const t = this.list[i]; if (t.alive && (!team || this.teamOf(t) === team) && this._surfDist(t, point) <= r) out.push(t); }
    return out;
  }
  nearest(point, maxDist = 1e9, team) {
    let best = null, bd = maxDist;
    for (let i = 0; i < this.list.length; i++) { const t = this.list[i]; if (!t.alive || (team && this.teamOf(t) !== team)) continue; const d = this._surfDist(t, point); if (d < bd) { bd = d; best = t; } }
    return best;
  }
  rayWorld(origin, dir, range = 300) {
    const o = this._o.copy(origin), d = this._d.copy(dir).normalize();
    // terrain first: most rays end on the ground, which caps the pricier segmented collider search
    let t = this._terrainRay(o, d, range), surface = 'none', col = null;
    if (t >= 0) { surface = 'terrain'; this.game.terrain.normalAt(o.x + d.x * t, o.z + d.z * t, this._n); }
    const ct = this._rayColliders(o, d, t >= 0 ? t : range);
    if (ct >= 0) { t = ct; surface = this._cHit.surface ?? 'rock'; col = this._cHit; this._n.copy(this._cN); }
    const wt = this._waterCross(o, d, t >= 0 ? t : range);
    if (wt >= 0) { t = wt; surface = 'water'; col = null; this._n.copy(UP); }
    if (t < 0) return null;
    const r = this._worldRes[this._wi = (this._wi + 1) % this._worldRes.length];
    r.point.copy(o).addScaledVector(d, t); r.normal.copy(this._n); r.distance = t; r.surface = surface; r.collider = col;
    return r;
  }

  // ---------- hitscan ----------
  hitscan(opts) {
    const { origin, dir, range = 300, damage = 0, element = 'kinetic', critMult = 1.6, owner = null, team = 'player', spread = 0, pierce = false, dry = false, source = null } = opts;
    const res = this._results[this._ri = (this._ri + 1) % RING];
    const o = this._o.copy(origin), d = this._d.copy(dir).normalize();
    if (spread > 0) this._applySpread(d, spread);
    if (!dry) this.stats.shots++;
    // 1. targets (sorted by entry distance), 2. world (limited to the first target), 3. terrain (limited to the closest so far)
    const n = this._castTargets(o, d, range, team, 0);
    let tMax = n && !pierce ? this._hits[0].t : range, surface = 'none';           // pierce: world can still block targets further along
    const tt = this._terrainRay(o, d, tMax);                                       // terrain first: caps the pricier collider search for the common ground-hit ray
    if (tt >= 0) { tMax = tt; surface = 'terrain'; this.game.terrain.normalAt(o.x + d.x * tt, o.z + d.z * tt, this._n); }
    const ct = this._rayColliders(o, d, tMax);
    if (ct >= 0) { tMax = ct; surface = this._cHit.surface ?? 'rock'; this._n.copy(this._cN); }
    const wt = this._waterCross(o, d, tMax);
    if (wt >= 0) { tMax = wt; surface = 'water'; this._n.copy(UP); }                // lake surface stops the ray (splash hook), never march submerged ground
    res.target = null; res.crit = false; res.damage = 0; res.killed = false; res.weakPoint = null; res.surface = surface;
    res.point.copy(o).addScaledVector(d, tMax); res.distance = tMax;
    if (n && this._hits[0].t <= tMax + 1e-6) {
      for (let i = 0; i < n; i++) {
        const h = this._hits[i]; if (h.t > tMax + 1e-6) break;
        const tg = h.target, wp = h.wp, crit = !!wp, ht = h.t;
        const amount = damage * this._falloff(opts, h.t) * (crit ? critMult * (wp.mult ?? 1) : 1);
        this._p.copy(o).addScaledVector(d, ht); this._targetNormal(h, this._p, this._n, d);
        // fill the result before applying damage: 'combat:hit' listeners may re-enter hitscan and clobber the temps
        if (i === 0) { res.target = tg; res.crit = crit; res.damage = amount; res.killed = false; res.weakPoint = wp; res.surface = tg.kind ?? 'enemy'; res.point.copy(this._p); res.normal.copy(this._n); res.distance = ht; }
        if (!dry) { const applied = this._applyHit(tg, amount, element, crit, this._p, this._n, d, owner, source); if (i === 0) { res.damage = applied; res.killed = !tg.alive; } }
        if (!pierce) break;
      }
    } else if (surface !== 'none') {
      res.normal.copy(this._n);
      if (!dry) this._impact(res.point, this._n, surface, element, owner);
    } else res.normal.copy(UP);
    return res;
  }
  _applySpread(d, spread) {
    const a = spread * Math.sqrt(Math.random()), phi = Math.random() * Math.PI * 2;   // uniform over the cone's disc
    const t1 = this._t1, t2 = this._t2;
    (Math.abs(d.y) < 0.99 ? t1.set(0, 1, 0) : t1.set(1, 0, 0)).cross(d).normalize(); t2.crossVectors(d, t1);
    const s = Math.sin(a);
    d.multiplyScalar(Math.cos(a)).addScaledVector(t1, s * Math.cos(phi)).addScaledVector(t2, s * Math.sin(phi)).normalize();
  }
  _falloff(opts, dist) {
    const f = opts.falloff;
    if (typeof f === 'function') return f(dist);
    let s, e;
    if (Array.isArray(f)) { s = f[0]; e = f[1]; } else { s = opts.falloffStart; e = opts.falloffEnd; }
    if (s === undefined || s === null || dist <= s) return 1;
    e = e ?? opts.range ?? 300; const min = opts.falloffMin ?? 0.5;
    return 1 - (1 - min) * Math.min(1, (dist - s) / Math.max(1e-3, e - s));
  }
  /** eval-able self-test: falloff multiplier x100 at the given distances for all three accepted forms (fields / array / function) */
  testFalloff(dists = [5, 30, 70]) {
    const forms = {
      fields: { falloffStart: 10, falloffEnd: 60, falloffMin: 0.5 },
      array: { falloff: [10, 60], falloffMin: 0.5 },
      fn: { falloff: (d) => Math.max(0.5, 1 - Math.max(0, d - 10) / 100) },
    };
    const out = {};
    for (const k in forms) out[k] = dists.map((d) => Math.round(this._falloff(forms[k], d) * 1000) / 10);
    return out;
  }
  /** all hostile targets along the ray within maxT, sorted by entry t into this._hits; returns count. pad = projectile radius */
  _castTargets(o, d, maxT, team, pad) {
    let n = 0; const list = this.list, hits = this._hits;
    for (let i = 0; i < list.length; i++) {
      const tg = list[i];
      if (!tg.alive || !this._hostile(tg, team)) continue;
      const R = tg.radius + (tg.height ? tg.height * 0.5 : 0) + pad + 0.5;      // broad sphere (0.5 covers weak points poking out)
      _oc.subVectors(tg.position, o); const proj = _oc.dot(d);
      if (proj < -R || proj > maxT + R || _oc.lengthSq() - proj * proj > R * R) continue;
      let body;
      if (tg.height) { const h = Math.max(0, tg.height * 0.5 - tg.radius); this._a.copy(tg.position); this._a.y -= h; this._b.copy(tg.position); this._b.y += h; body = rayCapsule(o, d, this._a, this._b, tg.radius + pad); }
      else body = raySphere(o, d, tg.position, tg.radius + pad);
      if (body > maxT) body = -1;
      let wp = null, wt = Infinity;
      const wps = tg.weakPoints;
      if (wps) for (let k = 0; k < wps.length; k++) { const w = wps[k]; const t = raySphere(o, d, w.position, w.radius + pad); if (t >= 0 && t <= maxT && t < wt) { wt = t; wp = w; } }
      // first-struck hitbox wins (D2): if the ray enters the body volume before the weak-point sphere, it's no crit.
      if (wp && body >= 0 && wt > body + 1e-3) wp = null;
      if (body < 0 && !wp) continue;
      const t = wp ? (body >= 0 ? Math.min(body, wt) : wt) : body;
      if (wp && (body < 0 || wt <= body)) body = -1;                                 // surface normal comes from the weak point sphere
      // insertion sort (few hits)
      if (n === MAX_HITS) { if (t >= hits[n - 1].t) continue; n--; }
      let j = n; while (j > 0 && hits[j - 1].t > t) { const tmp = hits[j]; hits[j] = hits[j - 1]; hits[j - 1] = tmp; j--; }
      const h = hits[j]; h.t = t; h.target = tg; h.wp = wp; h.body = body; n++;
      // keep hits[j..n] consistent: the swapped-down element at hits[n] is a free slot now
    }
    return n;
  }
  _targetNormal(h, p, out, d) {
    const tg = h.target;
    if (h.body < 0 && h.wp) out.subVectors(p, h.wp.position);
    else if (tg.height) { const hh = Math.max(0, tg.height * 0.5 - tg.radius); this._a.copy(tg.position); this._a.y -= hh; this._b.copy(tg.position); this._b.y += hh; segClosest(p, this._a, this._b, this._t1); out.subVectors(p, this._t1); }
    else out.subVectors(p, tg.position);
    if (out.lengthSq() < 1e-8) out.copy(d).negate(); else out.normalize();
    return out;
  }
  /** exact test of one collider against the current ray; updates best/_cHit */
  _colHit(c, o, d, maxT, best) {
    let t = -1;
    if (c.type === 'sphere') t = raySphere(o, d, c.pos, c.r);
    else if (c.type === 'capsule') t = rayCapsule(o, d, c.a, c.b, c.r);
    else if (c.type === 'box') { this._ray.set(o, d); if (this._ray.intersectBox(c.box, this._p)) t = this._p.distanceTo(o); }
    if (t >= 0 && t <= maxT && (best < 0 || t < best)) { this._cHit = c; return t; }
    return best;
  }
  /** closest collider hit along the ray; writes _cN/_cHit; returns t or -1.
   *  Amanatides-Woo DDA straight over the collider grid: visits only the cells the ray actually crosses and stops at the
   *  first cell that can still contain a nearer hit. (colliders.query's radius sweep re-tested overlapping cells segment
   *  after segment and deduped with an O(n^2) includes — that was ~60% of a rifle ray's CPU in a forest.) */
  _rayColliders(o, d, maxT) {
    const cols = this.game.world?.colliders; if (!cols || maxT <= 0) return -1;
    const grid = cols.grid, cs = cols.cell;
    let best = -1; const seen = this._seen; seen.clear();
    if (!grid || !cs) {                                       // fallback: whatever broadphase the registry offers
      const q = cols.query?.(o.x + d.x * maxT * 0.5, o.z + d.z * maxT * 0.5, maxT * 0.5 + 0.05, this._q);
      if (q) for (let i = 0; i < q.length; i++) best = this._colHit(q[i], o, d, maxT, best);
    } else {
      let cx = Math.floor(o.x / cs), cz = Math.floor(o.z / cs);
      const sx = d.x > 0 ? 1 : d.x < 0 ? -1 : 0, sz = d.z > 0 ? 1 : d.z < 0 ? -1 : 0;
      let tx = sx ? ((cx + (sx > 0 ? 1 : 0)) * cs - o.x) / d.x : Infinity;
      let tz = sz ? ((cz + (sz > 0 ? 1 : 0)) * cs - o.z) / d.z : Infinity;
      const dx = sx ? cs / Math.abs(d.x) : Infinity, dz = sz ? cs / Math.abs(d.z) : Infinity;
      for (let guard = 0; guard < 256; guard++) {
        const s = grid.get(cx * 73856093 ^ cz * 19349663);
        if (s) for (const c of s) { if (seen.has(c)) continue; seen.add(c); best = this._colHit(c, o, d, maxT, best); }
        const next = tx < tz ? tx : tz;                        // t where the ray leaves this cell
        if (next > maxT || (best >= 0 && best <= next)) break;
        if (tx < tz) { cx += sx; tx += dx; } else { cz += sz; tz += dz; }
      }
    }
    if (best >= 0) {
      const c = this._cHit, p = this._p.copy(o).addScaledVector(d, best), n = this._cN;
      if (c.type === 'sphere') n.subVectors(p, c.pos);
      else if (c.type === 'capsule') { segClosest(p, c.a, c.b, this._t1); n.subVectors(p, this._t1); }
      else boxNormal(c.box, p, n);
      if (n.lengthSq() < 1e-8) n.copy(d).negate(); else n.normalize();
    }
    return best;
  }
  /** t where the ray crosses the lake surface plane inside actual water, or -1 (either direction) */
  _waterCross(o, d, maxT) {
    const w = this.game.world?.water; if (!w || !d.y) return -1;
    const t = ((w.level ?? 0) - o.y) / d.y;
    if (t < 1e-4 || t > maxT) return -1;
    return w.isWater?.(o.x + d.x * t, o.z + d.z * t) ? t : -1;
  }
  /** terrain ray-march: adaptive steps (height above ground + distance) then bisection. returns t or -1 */
  _terrainRay(o, d, maxT) {
    const T = this.game.terrain; if (!T?.heightAt || maxT <= 0) return -1;
    let prevT = 0, prevY = o.y - T.heightAt(o.x, o.z);
    while (prevT < maxT) {
      const step = Math.min(14, Math.max(0.5, Math.abs(prevY) * 0.8, prevT * 0.05));   // ponytail: ~5% distance step far out; ridges thinner than the step between far samples can be clipped — bisection still nails the entry point
      const t = Math.min(maxT, prevT + step);
      const py = o.y + d.y * t;
      if (d.y > 0 && py > this._terrainMaxY) return -1;
      const y = py - T.heightAt(o.x + d.x * t, o.z + d.z * t);
      if (y <= 0 && prevY > 0) {
        let lo = prevT, hi = t;
        for (let i = 0; i < 7; i++) { const m = (lo + hi) * 0.5; if (o.y + d.y * m - T.heightAt(o.x + d.x * m, o.z + d.z * m) > 0) lo = m; else hi = m; }
        return (lo + hi) * 0.5;
      }
      prevT = t; prevY = y;
    }
    return -1;
  }

  // ---------- damage ----------
  damage(target, info) {
    if (!target || !target.alive) return 0;
    let amount = info.amount ?? 0;
    const element = info.element ?? 'kinetic';
    if (target.shieldElement && target.shieldElement === element && (target.shield === undefined || target.shield > 0)) amount *= 2;   // match game
    const inf = this._infos[this._ii = (this._ii + 1) % this._infos.length];
    inf.amount = amount; inf.element = element; inf.crit = !!info.crit; inf.owner = info.owner ?? null; inf.source = info.source ?? null; inf.target = target;
    inf.point.copy(info.point ?? target.position); inf.normal.copy(info.normal ?? UP); if (info.dir) inf.dir.copy(info.dir); else inf.dir.set(0, -1, 0);
    target.takeDamage?.(inf);
    const killed = !target.alive || (target.health !== undefined && target.health <= 0);
    if (killed) target.alive = false;
    const st = this.stats; st.hits++; st.damage += amount; if (inf.crit) st.crits++;
    const ev = this._hitEvs[this._hi = (this._hi + 1) % HIT_RING];
    ev.target = target; ev.amount = amount; ev.crit = inf.crit; ev.point.copy(inf.point); ev.normal.copy(inf.normal); ev.element = element; ev.owner = inf.owner; ev.killed = killed; ev.source = inf.source;
    this.game.events.emit('combat:hit', ev);
    if (killed) { st.kills++; const k = this._killEv; k.target = target; k.owner = inf.owner; k.point.copy(inf.point); this.game.events.emit('combat:kill', k); }
    return amount;
  }
  _applyHit(target, amount, element, crit, point, normal, dir, owner, source) {
    const inf = this._infos[this._ii = (this._ii + 1) % this._infos.length];
    inf.amount = amount; inf.element = element; inf.crit = crit; inf.point.copy(point); inf.normal.copy(normal); inf.dir.copy(dir); inf.owner = owner; inf.source = source;
    return this.damage(target, inf);
  }
  _impact(point, normal, surface, element, owner) {
    const ev = this._impEvs[this._imi = (this._imi + 1) % this._impEvs.length];
    ev.point.copy(point); ev.normal.copy(normal); ev.surface = surface; ev.element = element; ev.owner = owner;
    this.game.events.emit('combat:impact', ev);
  }
  /** line-of-sight from a blast point to a target's centre: any world collider/terrain in between blocks it */
  _occluded(point, tg) {
    const d = this._d.subVectors(tg.position, point), dist = d.length();
    if (dist < 1e-3) return false;
    d.divideScalar(dist);
    const need = dist - tg.radius - 0.25; if (need <= 0) return false;
    const o = this._o.copy(point).addScaledVector(d, 0.1); o.y += 0.15;   // lift off the surface the blast sits on
    if (this._rayColliders(o, d, need) >= 0) return true;
    return this._terrainRay(o, d, need) >= 0;
  }
  explode({ point, radius = 3, damage = 0, element = 'kinetic', owner = null, team = 'player', falloff = true, knockback = 0, source = null }) {
    let count = 0; const list = this.list, kb = this._kb, pd = this._pd;
    this.stats.explosions++;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]; if (!t.alive || !this._hostile(t, team)) continue;
      const dist = Math.max(0, this._surfDist(t, point)); if (dist > radius) continue;
      if (this._occluded(point, t)) continue;                                     // behind a wall/rock/hill -> no damage, no knockback
      const k = falloff ? 1 - 0.7 * (dist / radius) : 1;                            // 100% at the centre -> 30% at the edge
      kb.subVectors(t.position, point); if (kb.lengthSq() < 1e-6) kb.set(0, 1, 0); else kb.normalize();
      pd.copy(t.position).addScaledVector(kb, -t.radius);                           // point on the target's surface facing the blast
      this._n.copy(kb);
      if (damage > 0) this._applyHit(t, damage * k, element, false, pd, this._n, kb, owner, source);
      if (knockback > 0) { const s = knockback * k; kb.y += 0.35; kb.normalize(); if (t.knockback) t.knockback(kb, s); else t.velocity?.addScaledVector(kb, s); }
      count++;
    }
    const ev = this._explEv; ev.point.copy(point); ev.radius = radius; ev.element = element; ev.owner = owner;
    this.game.events.emit('combat:explosion', ev);
    return count;
  }

  // ---------- projectiles ----------
  projectile(opts) {
    const { origin, dir, speed = 40, damage = 0, element = 'kinetic', owner = null, team = 'player', radius = 0.15, gravity = 0, life = 6, homing = null, turn = 5, explode = null, critMult = 1, visual = null, source = null } = opts;
    let p = this._free.pop();
    if (!p) { p = this.projectiles[0]; this._despawn(p); this._free.pop(); }   // ponytail: pool full -> recycle the oldest
    p.alive = true; p.age = 0; p.radius = radius; p.gravity = gravity; p.life = life; p.damage = damage; p.element = element; p.owner = owner; p.team = team;
    p.homing = homing; p.turn = turn; p.explode = explode; p.critMult = critMult; p.source = source;
    p.position.copy(origin); p.prev.copy(origin); p.velocity.copy(dir).normalize().multiplyScalar(speed);
    p.node.position.copy(origin); p.node.quaternion.identity();
    p.color.set(visual?.color ?? BOLT_COLORS[element] ?? ELEMENT_COLORS[element] ?? 0xffffff);
    p.size = visual?.size ?? Math.max(0.06, radius * 0.8); p.stretch = visual?.stretch ?? 3.5; p.glow = visual?.glow ?? 1;
    p.hasCore = !visual?.mesh;
    // core: solid dart body, hue-locked. The old `.lerp(WHITE, 0.3)` then ×1.9 put every channel over
    // clip, so every enemy bolt tone-mapped to the exact cream the combat gate flags (rgb ~225,238,233 —
    // the wave-5 vale finding) and the velocity-stretched instance read as a pale pillar. Min-channel
    // discipline instead (same rule as Brush's BRUSH_MINCH_CAP): the dominant channel keeps the ×1.9
    // heat, the smallest stays under clip so the hue survives ACES.
    p.color.getHSL(_hsl);
    p.coreColor.setHSL(_hsl.h, Math.min(1, _hsl.s * 1.3), Math.min(0.58, _hsl.l)).multiplyScalar(1.9);
    { const m = Math.min(p.coreColor.r, p.coreColor.g, p.coreColor.b); if (m > 0.98) p.coreColor.multiplyScalar(0.98 / m); }
    if (visual?.mesh) { p.mesh = visual.mesh; p.node.add(visual.mesh); }
    this.game.scene.add(p.node);
    if (visual?.trail ?? true) p.trail = this.game.vfx?.attach?.('spark-trail', p.node, { color: p.color.getHex(), element, size: p.size }) ?? null;
    p._li = this.projectiles.length; this.projectiles.push(p);
    this.stats.projectiles++; this._dirty = true;
    this._projEv.handle = p; this.game.events.emit('combat:projectile', this._projEv);
    return p;
  }
  _despawn(p) {
    if (!p.alive) return;
    p.alive = false; p.homing = null; p.owner = null;
    if (p.trail) { p.trail.stop?.(); p.trail = null; }
    if (p.mesh) { p.node.remove(p.mesh); p.mesh = null; }
    this.game.scene.remove(p.node);
    const last = this.projectiles.pop();
    if (last !== p) { this.projectiles[p._li] = last; last._li = p._li; }
    p._li = -1; this._free.push(p); this._dirty = true;
  }
  _projectileHit(p, t, d, target, crit, wp, surface) {
    const point = this._hp.copy(p.prev).addScaledVector(d, t), n = this._n;
    if (target) { const h = this._hits[0]; h.target = target; h.wp = wp; h.body = wp ? -1 : 0; this._targetNormal(h, point, n, d); }
    const ex = p.explode;
    if (ex) {
      if (target && ex.direct > 0) this._applyHit(target, ex.direct * (crit ? p.critMult * (wp?.mult ?? 1) : 1), p.element, crit, point, n, d, p.owner, p.source);
      this.explode({ point, radius: ex.radius ?? 3, damage: ex.damage ?? p.damage, element: p.element, owner: p.owner, team: p.team, falloff: ex.falloff ?? true, knockback: ex.knockback ?? 0, source: p.source });
    } else if (target) this._applyHit(target, p.damage * (crit ? p.critMult * (wp?.mult ?? 1) : 1), p.element, crit, point, n, d, p.owner, p.source);
    else this._impact(point, n, surface, p.element, p.owner);
    p.position.copy(point);
    this._despawn(p);
  }
  _stepProjectiles(dt) {
    const live = this.projectiles;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      p.age += dt;
      const hm = p.homing;
      if (hm && hm.alive && hm.position) {                                       // rotate velocity toward the target, keep speed
        const v = p.velocity, sp = v.length(), want = this._t2.subVectors(hm.position, p.position).normalize();
        const cur = this._t1.copy(v).divideScalar(sp || 1), maxA = p.turn * dt;
        const ang = Math.acos(THREE.MathUtils.clamp(cur.dot(want), -1, 1));
        if (ang > 1e-4) { cur.lerp(want, Math.min(1, maxA / ang)).normalize(); v.copy(cur).multiplyScalar(sp); }
      }
      if (p.gravity) p.velocity.y -= p.gravity * dt;
      p.prev.copy(p.position); p.position.addScaledVector(p.velocity, dt);
      const L = p.prev.distanceTo(p.position);
      if (L > 1e-6) {
        const d = this._d.subVectors(p.position, p.prev).divideScalar(L), o = p.prev;
        const n = this._castTargets(o, d, L, p.team, p.radius);
        let t = n ? this._hits[0].t : -1, target = n ? this._hits[0].target : null, wp = n ? this._hits[0].wp : null, surface = target ? (target.kind ?? 'enemy') : 'none';
        const lim = t >= 0 ? t : L;
        const ct = this._rayColliders(o, d, lim);
        if (ct >= 0) { t = ct; target = null; wp = null; surface = this._cHit.surface ?? 'rock'; this._n.copy(this._cN); }
        let lim2 = ct >= 0 ? ct : lim;
        const wt = this._waterCross(o, d, lim2);
        if (wt >= 0) { t = wt; target = null; wp = null; surface = 'water'; this._n.copy(UP); lim2 = wt; }
        // terrain: one heightAt at the segment end, bisect only when below ground. ponytail: ridges thinner than one frame's travel are skipped
        const T = this.game.terrain;
        if (T?.heightAt) {
          const ex = o.x + d.x * lim2, ey = o.y + d.y * lim2, ez = o.z + d.z * lim2;
          if (ey - p.radius * 0.5 <= T.heightAt(ex, ez)) {
            let lo = 0, hi = lim2;
            for (let k = 0; k < 5; k++) { const m = (lo + hi) * 0.5; if (o.y + d.y * m - p.radius * 0.5 > T.heightAt(o.x + d.x * m, o.z + d.z * m)) lo = m; else hi = m; }
            t = lo; target = null; wp = null; surface = 'terrain'; T.normalAt(o.x + d.x * t, o.z + d.z * t, this._n);
          }
        }
        if (t >= 0) { this._projectileHit(p, t, d, target, !!wp, wp, surface); continue; }
      }
      if (p.age >= p.life) {
        if (p.explode) { const ex = p.explode; this.explode({ point: p.position, radius: ex.radius ?? 3, damage: ex.damage ?? p.damage, element: p.element, owner: p.owner, team: p.team, falloff: ex.falloff ?? true, knockback: ex.knockback ?? 0, source: p.source }); }
        this._despawn(p); continue;
      }
      p.node.position.copy(p.position);
      const sp = p.velocity.length();
      if (sp > 1e-4) { this._t1.copy(p.velocity).divideScalar(sp); p.node.quaternion.setFromUnitVectors(FWD, this._t1); }
    }
    // visuals: compact live projectiles into instance slots 0..n-1 (count = n -> zero cost when idle)
    let ci = 0;
    for (let i = 0; i < live.length; i++) {
      const p = live[i], gi = i * 3;
      if (p.hasCore) { const s = p.size * 0.45; this.coreMesh.setMatrixAt(ci, this._mat.compose(p.position, p.node.quaternion, this._scl.set(s, s, s * p.stretch * 1.35))); this.coreMesh.setColorAt(ci, p.coreColor); ci++; }
      this._gPos[gi] = p.position.x; this._gPos[gi + 1] = p.position.y; this._gPos[gi + 2] = p.position.z;
      this._gVel[gi] = p.velocity.x; this._gVel[gi + 1] = p.velocity.y; this._gVel[gi + 2] = p.velocity.z;
      this._gSize[i] = p.size * 1.3 * p.glow;
      // halo colour: ×1.5×glow, min-channel-capped at 0.98 — N stacked volley halos sum additively, and
      // a pale element colour (kinetic 0xffe3b0) at 1.5x already clips all three channels on its own.
      let gr = p.color.r * 1.5 * p.glow, gg = p.color.g * 1.5 * p.glow, gb = p.color.b * 1.5 * p.glow;
      const gm = Math.min(gr, gg, gb);
      if (gm > 0.98) { const gs = 0.98 / gm; gr *= gs; gg *= gs; gb *= gs; }
      this._gCol[gi] = gr; this._gCol[gi + 1] = gg; this._gCol[gi + 2] = gb;
    }
    this.coreMesh.count = ci; this.coreMesh.visible = ci > 0;
    this.glowMesh.visible = live.length > 0; this.glowMesh.geometry.instanceCount = live.length;
    if (ci) { this.coreMesh.instanceMatrix.needsUpdate = true; this.coreMesh.instanceColor.needsUpdate = true; }
    if (live.length) { const a = this.glowMesh.geometry.attributes; a.aPos.needsUpdate = true; a.aVel.needsUpdate = true; a.aColor.needsUpdate = true; a.aSize.needsUpdate = true; }
    this._dirty = false;
  }

  // ---------- debug dummies ----------
  spawnDummy(pos, opts = {}) {
    let x, y, z;
    if (!pos) { const pl = this.game.player; const yaw = pl?.yaw ?? 0; x = (pl?.position.x ?? 0) - Math.sin(yaw) * 10; z = (pl?.position.z ?? 0) - Math.cos(yaw) * 10; }
    else if (Array.isArray(pos)) [x, , z] = pos; else { x = pos.x; z = pos.z; }
    y = this.game.terrain?.heightAt?.(x, z) ?? (pos?.y ?? 0);
    const d = new Dummy(this, x, y, z, opts);
    this.dummies.push(d); this.register(d);
    return d;
  }
  clearDummies() { for (const d of this.dummies) { this.unregister(d); d.dispose(); } this.dummies.length = 0; }

  /** exact ballistic lob: unit dir from origin onto target point at `speed` under `gravity`; hi=true high arc; null if out of range */
  aimBallistic(origin, target, speed, gravity, hi = true, out = new THREE.Vector3()) {
    const dx = target.x - origin.x, dz = target.z - origin.z, x = Math.hypot(dx, dz), y = target.y - origin.y;
    if (x < 1e-6 || gravity <= 0) return null;
    const v2 = speed * speed, disc = v2 * v2 - gravity * (gravity * x * x + 2 * y * v2);
    if (disc < 0) return null;
    const tan = (v2 + (hi ? Math.sqrt(disc) : -Math.sqrt(disc))) / (gravity * x);
    return out.set(dx / x, tan, dz / x).normalize();
  }
  /** deterministic mortar acceptance test: spawns a dummy `dist` m ahead, lobs a solar mortar exactly onto its chest.
   *  eval `game.combat.testMortar(25)` -> { dummy, proj, eta } ; wait > eta seconds, then dummy.health < dummy.maxHealth
   *  proves splash-on-target (gravity + ballistic aim + explode + occlusion all agreeing). ~2.2 s at the defaults. */
  testMortar(dist = 25, speed = 34, gravity = 30) {
    const pl = this.game.player, yaw = pl?.yaw ?? 0, px = pl?.position.x ?? 0, pz = pl?.position.z ?? 0;
    const dummy = this.spawnDummy({ x: px - Math.sin(yaw) * dist, z: pz - Math.cos(yaw) * dist });
    const oy = (this.game.terrain?.heightAt?.(px, pz) ?? 0) + 1.6;
    const org = this._t2.set(px, oy, pz);
    const dir = this.aimBallistic(org, dummy.position, speed, gravity, true);
    if (!dir) return null;
    const proj = this.projectile({ origin: org, dir, speed, gravity, damage: 90, element: 'solar',
      explode: { radius: 4.5, damage: 90 }, life: 15, source: 'mortar-test', visual: { size: 0.22 } });
    const hz = Math.hypot(dir.x, dir.z) * speed;                       // ground speed -> flight time to the target
    return { dummy, proj, eta: +(Math.hypot(dummy.position.x - px, dummy.position.z - pz) / Math.max(1e-3, hz)).toFixed(2) };
  }

  update(dt, t) {
    this.time = t;
    if (this.projectiles.length || this._dirty) this._stepProjectiles(dt);
    for (let i = 0; i < this.dummies.length; i++) this.dummies[i].update(dt, t);
  }
  dispose() { this.clearDummies(); for (const p of this.projectiles.slice()) this._despawn(p); this.game.scene.remove(this.coreMesh, this.glowMesh); }
}
