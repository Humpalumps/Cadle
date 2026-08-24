// OWNER: rpg agent. The ammo economy.
//
// THE BUG THIS FIXES: `Weapons.addAmmo(slot, n)` has existed since the weapons wave and
// NOTHING in the codebase ever called it. The only refill in the game was on respawn, so a
// gun that ran dry stayed dry until you died. That is the whole of the user's complaint.
//
// Two brick types, because the reserves demand it: sniper maxReserve is 28 against auto rifle
// 300, so one universal brick either starves the auto or deletes the sniper economy.
//   light   — ~35% of any kill, 12% of maxReserve on BOTH slots
//   special — ~7% trash / ~40% elite / 100% boss, 25% of maxReserve, special archetypes only
// Refills are PERCENTAGES of maxReserve, so they stay correct per archetype without a second
// tuning table to keep in sync with weapons/defs.js.
//
// THE DRY-GUARD IS THE ACTUAL FIX: if every slot is at ammo 0 AND reserve 0, the next kill
// drops a guaranteed light brick. Melee and abilities still work while dry, so the brick is
// always earnable. Without this rule the economy has a terminal state and the complaint stands.
//
// BLOB LAW (CLAUDE.md ARCHITECTURAL LAW): up to 24 of these sit on the ground at once — the
// densest emissive population the world has. So: saturate the COLOUR, cap the INTENSITY.
// emissiveIntensity 0.5 (hard ceiling 0.6), roughness 0.7 (never below 0.6, or the facets
// throw drifting point-glints), metalness low, and deliberately NO beacon column and NO
// additive halo — a walk-over pickup does not need a light shaft, and 24 of them would be
// exactly the flashing-white-blobs bug wearing a new hat.
//
// "MAKE THEM EASIER TO SEE" (user, 2026-08-23), WITHOUT touching brightness: the Vale's grass
// got denser/finer and the bricks (rest height 0.22 m, grass blades ~0.62 m) were sitting under
// it. Fixed with the levers CLAUDE.md ranks ABOVE brightness — silhouette, height, a ground
// decal, hue — none of which touch emissiveIntensity: HOVER_H lifts the rest height to 0.48 m,
// brickRingGeometry()/brickRingMaterial() draw an unlit albedo ring under each brick (cannot
// bloom — no emissive, no toneMapped:false), and `special`'s hue moved off blue-violet (it
// fought both the aether crystals and two of loot's own beam colours) onto a teal nothing else
// in the palette claims. That work stands, unchanged, below.
//
// "MAKE THEM LOOK LIKE AMMUNITION, NOT CARDBOARD BOXES" (user, 2026-08-24): the brick used to be
// four flat boxes (body/spine/two caps) in ONE flat-emissive material — a toy block. Same rule
// applies here as everywhere else in this file: get the richness from silhouette and material
// CONTRAST, not from brightness.
//   * caseGeometry() is now a chamfered (octagonal-prism) case with gold end-brackets, a gold
//     strap and a 3-prong gold claw socket, vertex-coloured so dark body and gold trim are ONE
//     draw call. It carries NO emissive at all — the glow budget moved entirely onto the core,
//     which is smaller than the old whole-crate glow, not bigger.
//   * lightCoreGeometry()/specialCoreGeometry() are the "contents" nested in the claw socket —
//     a fanned bundle of shell casings for light, one faceted crystal for special. Same family
//     (same case, same socket), different contents, which is also the whole point of the two
//     kinds existing. Both still use the exact emissiveIntensity (0.5) and colours the old single
//     material used — visibility is unchanged, only the area carrying it shrank.
//   * The ground ring used to be one continuous RingGeometry, which reads as a broken arc once
//     dense grass occludes part of it. Replaced with 4 short reticle arcs with deliberate gaps
//     (brickRingGeometry()) — a target-lock mark that is SUPPOSED to be segmented, so grass
//     occlusion can no longer make it look "broken".
//   * Body is now ONE shared InstancedMesh for both kinds (same case for light and special —
//     only the core differs), so the geometry got richer but draw calls only went 4 -> 5.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { enemyTier } from './droptable.js';

// Which archetypes eat special ammo. Keyed by archetype id so weapons/defs.js (another
// owner's file) needs no edit — Weapons publishes `archetype` on every live slot.
const SPECIAL_ARCH = new Set(['shotgun', 'sniper', 'fusion', 'beam']);

const RESCUE_R = 14;           // m: a dry-guard brick already this close counts as the rescue
const HOVER_H = 0.48;           // m above ground the brick settles at — grass is 0.62 m before per-blade
                                // scale (see dropmesh.js), so the old 0.22 m rest height buried it; this
                                // clears most blade tips without floating like a loot beacon
const LIGHT_PCT = 0.12;        // of maxReserve, both slots
const SPECIAL_PCT = 0.25;      // of maxReserve, special slots only
const P_LIGHT = 0.35;          // any kill
const P_SPECIAL = { trash: 0.07, elite: 0.40, boss: 1 };

// Bricks live in their OWN pool with their OWN cap and lifetime. They are NOT in loot.js's
// `drops` array, so they cannot be evicted by MAX_DROPS (12) and cannot evict a weapon or
// armour drop, and they do not despawn on loot's 150 s clock. That eviction collision is the
// bug the opening quest papered over with a 5-second re-drop poll; this is the fix instead.
const MAX_BRICKS = 24;
const BRICK_LIFE = 60;         // s — longer than a fight, shorter than a loot drop
const PICK_R = 1.6;            // m — walk over it, no E press, no nameplate
const TOAST_GAP = 4;           // s between HUD pickup lines, so a firefight is not a wall of text

// ------------------------------------------------------------------ mesh
// ONE shared "case" InstancedMesh for both kinds (light and special are the same case, only
// the contents in the claw socket differ) + one emissive "core" InstancedMesh per kind + one
// ground-ring InstancedMesh per kind. 5 draw calls total for up to 24 bricks (was 4), zero
// per-drop allocation — geometry got richer, draw-call count barely moved.
let group = null, bodyInst = null, coreInst = null, ringInst = null;
let caseGeo = null, ringGeo = null, lightCoreGeo = null, specialCoreGeo = null;

// geometry helpers — same tiny transform-then-build pattern dropmesh.js uses for its item
// shapes, scoped locally since ammo.js and dropmesh.js are different owners.
function xf(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  return g;
}
const boxg = (w, h, d, ...a) => xf(new THREE.BoxGeometry(w, h, d), ...a);
const cylg = (rt, rb, h, s, ...a) => xf(new THREE.CylinderGeometry(rt, rb, h, s), ...a);
const coneg = (r, h, s, ...a) => xf(new THREE.ConeGeometry(r, h, s), ...a);
const torg = (r, t, ...a) => xf(new THREE.TorusGeometry(r, t, 4, 10), ...a);

// paints a flat per-vertex albedo onto a geometry so several parts with different colours can
// merge into ONE draw call (MeshStandardMaterial multiplies base colour by vertex colour; base
// colour is left white so the vertex colour IS the final albedo, unmodulated).
function tint(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

const CASE_DARK = 0x241d17;   // dark leather/gunmetal body
const CASE_GOLD = 0xcf9a3d;   // ornate gold trim, per the house style

// The shared case: a chamfered (octagonal-prism) body instead of a sharp-edged crate, gold end
// brackets (like case latches), a gold strap across the top, and a 3-prong claw socket the
// contents nest in. No emissive anywhere in this geometry — the glow budget lives entirely in
// the core (below), which is the CLAUDE.md-mandated move: richness from silhouette and material
// contrast (dark body vs gold trim, vertex-coloured), never from brightness.
function caseGeometry() {
  if (caseGeo) return caseGeo;
  const slab = new THREE.CylinderGeometry(0.20, 0.20, 0.18, 8);
  slab.rotateY(Math.PI / 8);              // flats to the cardinal sides, not a vertex — reads
  slab.scale(1.2, 1, 0.78);               // as a chamfered box, not a diamond. ~0.48x0.18x0.31,
  tint(slab, CASE_DARK);                  // the same footprint the old box crate had.

  const bracketA = boxg(0.07, 0.17, 0.33, 0.235, 0, 0); tint(bracketA, CASE_GOLD);
  const bracketB = boxg(0.07, 0.17, 0.33, -0.235, 0, 0); tint(bracketB, CASE_GOLD);
  const strap = boxg(0.30, 0.05, 0.17, 0, 0.115, 0); tint(strap, CASE_GOLD);
  const socket = torg(0.085, 0.016, 0, 0.135, 0, -Math.PI / 2); tint(socket, CASE_GOLD);

  const claws = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const claw = boxg(0.018, 0.10, 0.018, 0, 0.05, 0, 0.35, a, 0);
    claw.translate(Math.sin(a) * 0.075, 0.135, Math.cos(a) * 0.075);
    tint(claw, CASE_GOLD);
    claws.push(claw);
  }

  caseGeo = mergeGeometries([slab, bracketA, bracketB, strap, socket, ...claws], false);
  caseGeo.computeVertexNormals();
  return caseGeo;
}

// light "contents": a fanned bundle of 3 shell casings sitting in the claw socket — reads as
// ammunition at a glance, distinct from the crystal below while sharing the same case/socket.
function lightCoreGeometry() {
  if (lightCoreGeo) return lightCoreGeo;
  const R = 0.045, baseY = 0.14, dy = [0, 0.014, -0.008];
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.3;
    const x = Math.sin(a) * R, z = Math.cos(a) * R;
    parts.push(cylg(0.026, 0.026, 0.12, 6, x, baseY + 0.06 + dy[i], z));
    parts.push(coneg(0.026, 0.045, 6, x, baseY + 0.1425 + dy[i], z));
  }
  lightCoreGeo = mergeGeometries(parts, false);
  lightCoreGeo.computeVertexNormals();
  return lightCoreGeo;
}

// special "contents": one faceted crystal in the same socket — same family (same case), a
// different, single, saturated payload instead of a bundle.
function specialCoreGeometry() {
  if (specialCoreGeo) return specialCoreGeo;
  specialCoreGeo = new THREE.OctahedronGeometry(0.078, 0);
  specialCoreGeo.scale(1, 1.4, 1);
  specialCoreGeo.translate(0, 0.14 + 0.09, 0);
  return specialCoreGeo;
}

// Ground decal ring — the classic "findable without a brighter blob" fix (CLAUDE.md's ARCHITECTURAL
// LAW): flat, unlit, on the terrain, never above the item, so it cannot bloom no matter how it is
// tuned. Was one continuous ring, which dense Vale grass chops into a "broken arc" look from most
// angles; now it is 4 short reticle arcs with DELIBERATE gaps, so grass occlusion reads as the
// mark's own design instead of a rendering artefact. Same InstancedMesh pair as before (2 draw
// calls for both kinds combined).
function brickRingGeometry() {
  if (ringGeo) return ringGeo;
  const gap = 0.55, seg = Math.PI / 2 - gap;
  const arcs = [];
  for (let i = 0; i < 4; i++) {
    arcs.push(new THREE.RingGeometry(0.30, 0.44, 6, 1, i * (Math.PI / 2) + gap / 2, seg));
  }
  ringGeo = mergeGeometries(arcs, false).rotateX(-Math.PI / 2);
  return ringGeo;
}

// special used to be blue-violet (0x7b2dff), which fights BOTH the aether crystals AND two of
// loot's own beam colours (rare 0x2f7dff, legendary 0x9b2dff — see dropmesh.js BEAM_COLOR). Moved
// to a saturated teal nothing else in the palette claims: still reads as "the other ammo" at a
// glance, no longer competes with a legendary drop for your eye. Hue only — emissiveIntensity is
// untouched (still 0.5, ceiling 0.6): visibility comes from colour/silhouette/decal, never brightness.
const MATS = {
  light: { color: 0x4a3410, emissive: 0xffa018 },   // warm saturated gold — never neutral-bright
  special: { color: 0x123a34, emissive: 0x2fe0c0 }, // saturated teal — clear of every other hue in play
};
// ground decal accent, one shade lighter than the brick's own emissive so ring and crate read as one object
const RING_COL = { light: 0xffb238, special: 0x4becd6 };

// The shared case body: vertex-coloured (dark/gold), no emissive at all — a plain PBR surface
// whose only job is silhouette and material contrast.
function caseMaterial() {
  return new THREE.MeshStandardMaterial({
    vertexColors: true, color: 0xffffff, roughness: 0.62, metalness: 0.28, flatShading: true,
  });
}

// The core (contents): same colours/intensity the old single whole-crate material used, just
// applied to a much smaller area now that the case itself carries none of the glow.
function coreMaterial(kind) {
  const m = MATS[kind];
  return new THREE.MeshStandardMaterial({
    color: m.color, emissive: m.emissive,
    emissiveIntensity: 0.5,   // BLOB LAW: hard ceiling 0.6 — do not raise
    roughness: 0.7,           // BLOB LAW: never below 0.6 — low roughness = drifting sun glints
    metalness: 0.2, flatShading: true,
  });
}

// Unlit and modest: cannot bloom (no emissive, no toneMapped:false, no additive), and stays
// visible at night same as noon because it does not depend on scene lighting to read as "a mark
// on the ground" — the same trick dropmesh.js's ground rune and loot's beacon rings already use.
function brickRingMaterial(kind) {
  return new THREE.MeshBasicMaterial({
    color: RING_COL[kind] ?? RING_COL.light, transparent: true, opacity: 0.4,
    side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: true,
  });
}

// ------------------------------------------------------------------ pool
// Preallocated: a fight must not allocate. Free slots are marked `live = false`.
const pool = [];
for (let i = 0; i < MAX_BRICKS; i++) {
  pool.push({
    live: false, kind: 'light', age: 0, grounded: false, spin: 0, phase: 0, gh: 0,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
  });
}
let lastToast = -99;

// scratch — module scope so the frame loop allocates nothing
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _qid = new THREE.Quaternion();   // identity — the ring geometry is pre-rotated flat, never spun
const KINDS = ['light', 'special'];
let _nb = 0;                           // combined body cursor — one shared InstancedMesh, both kinds
const _n = { light: 0, special: 0 };   // per-kind core instance cursor, reused every frame
const _rn = { light: 0, special: 0 };  // same, for the ground-ring instances

// ------------------------------------------------------------------ weapons access
// ctx (built in RPG.js) does not publish the live Weapons system today, so resolve it
// defensively and fall back to nothing rather than throwing. See "API ASK" in the report:
// one line in the ctx adapter (`get weapons() { return g.player.weapons; }`) retires this.
function weaponsOf(ctx) {
  return (ctx && (ctx.weapons
    || (ctx.game && ctx.game.player && ctx.game.player.weapons)
    || (ctx.player && ctx.player.weapons))) || null;
}
const slotsOf = (ctx) => { const w = weaponsOf(ctx); return (w && w.slots) || []; };

/** true when EVERY slot is at ammo 0 and reserve 0 — the terminal state the guard exists for. */
export function isDry(ctx) {
  const s = slotsOf(ctx);
  if (!s.length) return false;
  for (const w of s) if (w && ((w.ammo | 0) > 0 || (w.reserve | 0) > 0)) return false;
  return true;
}

const hasSpecial = (ctx) => slotsOf(ctx).some((w) => w && SPECIAL_ARCH.has(w.archetype));

function refill(ctx, kind) {
  const wp = weaponsOf(ctx);
  const s = slotsOf(ctx);
  if (!wp || !wp.addAmmo || !s.length) return 0;
  let given = 0;
  for (let i = 0; i < s.length; i++) {
    const w = s[i];
    if (!w) continue;
    if (kind === 'special' && !SPECIAL_ARCH.has(w.archetype)) continue;
    const n = Math.max(1, Math.ceil((w.maxReserve || 0) * (kind === 'special' ? SPECIAL_PCT : LIGHT_PCT)));
    const was = w.reserve | 0;
    wp.addAmmo(i, n);
    given += (w.reserve | 0) - was;
  }
  // Picking ammo up with an empty magazine must not leave the gun still clicking. Destiny reloads
  // for you on a brick, and the whole point of this system is that running dry is a lull rather
  // than a dead end — making the player pull a dead trigger once to discover they are armed again
  // spends that moment badly. Weapons.reload() no-ops when the mag is full or the reserve is empty,
  // so this is safe to call unconditionally.
  if (given > 0 && wp.current && (wp.current.ammo | 0) <= 0) { try { wp.reload(); } catch (e) {} }
  return given;
}

// ------------------------------------------------------------------ dropping
/** Put a brick on the ground. Silently no-ops when the pool is full — bricks never evict. */
export function drop(ctx, kind, position) {
  const b = pool.find((x) => !x.live);
  if (!b) return null;                       // capped, not carpeted; no eviction either way
  const p = position || (ctx.player && ctx.player.position);
  let gh = 0;
  try { gh = ctx.world.heightAt(p.x, p.z) || 0; } catch (e) {}
  b.live = true; b.kind = kind === 'special' ? 'special' : 'light';
  b.age = 0; b.grounded = false;
  b.spin = 1.2 + Math.random() * 0.8;
  b.phase = Math.random() * 6.28;
  b.pos.set(p.x, Math.max(p.y || 0, gh) + 0.9, p.z);
  b.vel.set((Math.random() - 0.5) * 2.2, 3.0, (Math.random() - 0.5) * 2.2);
  return b;
}

/** The kill payout. Exported so a gate can drive it without faking an event. */
export function rollDrop(ctx, enemy, position) {
  // THE DRY-GUARD. It lands at YOUR FEET, not on the corpse — measured live: a guaranteed
  // brick 30 m away across a firefight is not a rescue, it is a scavenger hunt you have to
  // already know about. Dropping it on the player is what makes "you can never be stranded"
  // literally true, and it is the only case that gets this treatment.
  // ONE brick, not one per kill. `enemy:death` fires once per corpse and a grenade or a killAll
  // resolves a whole pack in the same tick, so the guard used to drop a brick for EVERY one of
  // them — all at your feet, all auto-collected on the next update. Measured: draining both slots
  // and clearing a camp took the reserves from 0/0 straight to 110/300, i.e. full maximum, which
  // is not an economy, it is an ammo faucet that happens to be spelled "run out first".
  // Re-arming is implicit: once a brick is on the ground the guard is satisfied, and once you are
  // no longer dry it stops applying at all.
  if (isDry(ctx)) {
    // One brick, but only one WITHIN REACH. The first version of this check was world-wide, so a light
    // brick still ticking down 200 m away — dropped by an earlier fight and never collected — suppressed
    // the rescue entirely and left the player stranded with nothing, which is the exact failure the
    // guard exists to prevent. RESCUE_R is generous: it only has to mean "there is already one here".
    const p = ctx.player && ctx.player.position;
    const near = p && pool.some((b) => {
      if (!b.live || b.kind !== 'light') return false;
      const dx = b.pos.x - p.x, dz = b.pos.z - p.z;
      return dx * dx + dz * dz < RESCUE_R * RESCUE_R;
    });
    if (!near) drop(ctx, 'light', p);
    return 'light';
  }

  let got = null;
  // A special brick with no special gun in either hand is a wasted drop and a wasted beacon.
  if (hasSpecial(ctx) && Math.random() < (P_SPECIAL[enemyTier(enemy)] || P_SPECIAL.trash)) {
    drop(ctx, 'special', position); got = 'special';
  }
  if (Math.random() < P_LIGHT) { drop(ctx, 'light', position); got = got || 'light'; }
  return got;
}

// ------------------------------------------------------------------ lifecycle
export function init(ctx) {
  group = new THREE.Group();
  group.name = 'rpg-ammo';
  ctx.scene.add(group);

  // shared case body — ONE InstancedMesh for both kinds, capacity MAX_BRICKS since it carries
  // every live brick regardless of kind (per-instance positions move every frame, so the shared
  // bounding sphere would be a lie; 24 sub-metre cases are not worth a re-fit each frame)
  bodyInst = new THREE.InstancedMesh(caseGeometry(), caseMaterial(), MAX_BRICKS);
  bodyInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodyInst.frustumCulled = false;
  bodyInst.castShadow = false; bodyInst.receiveShadow = false;
  bodyInst.count = 0;
  group.add(bodyInst);

  const coreGeoOf = { light: lightCoreGeometry(), special: specialCoreGeometry() };
  const rg = brickRingGeometry();
  coreInst = {}; ringInst = {};
  for (const kind of KINDS) {
    const cm = new THREE.InstancedMesh(coreGeoOf[kind], coreMaterial(kind), MAX_BRICKS);
    cm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cm.frustumCulled = false;
    cm.castShadow = false; cm.receiveShadow = false;
    cm.count = 0;
    group.add(cm);
    coreInst[kind] = cm;

    // ground decal ring, same pool/cap, its own draw call (flat + unlit, cannot fight the brick's
    // depth or z-fight the terrain the way stacking it INTO the brick material would)
    const rim = new THREE.InstancedMesh(rg, brickRingMaterial(kind), MAX_BRICKS);
    rim.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    rim.frustumCulled = false;
    rim.castShadow = false; rim.receiveShadow = false;
    rim.renderOrder = 2;
    rim.count = 0;
    group.add(rim);
    ringInst[kind] = rim;
  }

  ctx.events.on('enemy:death', (e) => {
    const en = (e && e.enemy) || e || {};
    const pos = en.position || (en.mesh && en.mesh.position) || ctx.player.position;
    rollDrop(ctx, en, pos);
  });
}

export function update(ctx, dt) {
  if (!coreInst) return;
  const p = ctx.player.position;
  const t = ctx.time;
  _nb = 0;                       // hoisted: update() must not allocate
  _n.light = _n.special = 0;
  _rn.light = _rn.special = 0;

  for (let i = 0; i < pool.length; i++) {
    const b = pool[i];
    if (!b.live) continue;
    b.age += dt;

    if (!b.grounded) {
      b.vel.y -= 22 * dt;
      b.pos.addScaledVector(b.vel, dt);
      let gh = 0;
      try { gh = ctx.world.heightAt(b.pos.x, b.pos.z) || 0; } catch (e) {}
      if (b.pos.y <= gh + HOVER_H) { b.pos.y = gh + HOVER_H; b.grounded = true; b.gh = gh; }
    }

    if (b.age > BRICK_LIFE) { b.live = false; continue; }

    const dx = b.pos.x - p.x, dy = b.pos.y - (p.y + 0.9), dz = b.pos.z - p.z;
    if (dx * dx + dy * dy + dz * dz < PICK_R * PICK_R) {
      const given = refill(ctx, b.kind);
      b.live = false;
      if (given > 0 && t - lastToast > TOAST_GAP) {
        lastToast = t;
        try { ctx.hud.toast && ctx.hud.toast(b.kind === 'special' ? 'SPECIAL AMMO' : 'AMMO'); } catch (e) {}
      }
      // Picking ammo up in Destiny makes a noise. Ours was silent, which made the single most
      // frequent reward in the game feel like nothing happened. Special is pitched down so the two
      // brick types are distinguishable without looking. `force` bypasses the per-name rate limit —
      // walking through a pile should read as several pickups, not one.
      if (given > 0) { try { ctx.audio?.play?.('pickup', { pitch: b.kind === 'special' ? 0.72 : 1.14, vol: 0.5, force: true }); } catch (e) {} }
      ctx.events.emit('ammo:picked', { kind: b.kind, given });
      continue;
    }

    // spin + bob, written straight into the instance matrix — no per-brick Object3D. The case
    // and its core share this exact transform (the core is rigidly nested in the claw socket).
    _e.set(0.2, b.spin * t + b.phase, 0.12);
    _q.setFromEuler(_e);
    _p.set(b.pos.x, b.pos.y + Math.sin(t * 2.2 + b.phase) * 0.06, b.pos.z);
    _m4.compose(_p, _q, _one);
    bodyInst.setMatrixAt(_nb++, _m4);
    coreInst[b.kind].setMatrixAt(_n[b.kind]++, _m4);

    // ground ring, flat at the cached landing height — only once grounded (freefall is a few
    // frames and a ring tracking a falling brick would just be visual noise)
    if (b.grounded) {
      _p.set(b.pos.x, b.gh + 0.03, b.pos.z);
      _m4.compose(_p, _qid, _one);
      ringInst[b.kind].setMatrixAt(_rn[b.kind]++, _m4);
    }
  }

  if (bodyInst.count !== _nb) bodyInst.count = _nb;
  bodyInst.instanceMatrix.needsUpdate = true;
  for (const kind of KINDS) {
    const cm = coreInst[kind];
    if (cm.count !== _n[kind]) cm.count = _n[kind];
    cm.instanceMatrix.needsUpdate = true;
    const rim = ringInst[kind];
    if (rim.count !== _rn[kind]) rim.count = _rn[kind];
    rim.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Automation surface. SCALARS ONLY — HANDOVER §5.5: an eval that returns a live Three.js
 * object serialises the whole scene graph over CDP and manufactures a phantom 6.5 s stall.
 * Nothing in here is a live object, and it must stay that way.
 */
export function state(ctx) {
  let light = 0, special = 0;
  for (const b of pool) if (b.live) { if (b.kind === 'special') special++; else light++; }
  const reserves = slotsOf(ctx).map((w) => (w ? (w.reserve | 0) : 0));
  return { light, special, reserves, dry: isDry(ctx) };
}

/** Clear the field — respawn, fast travel, a gate resetting between passes. */
export function clearBricks() {
  for (const b of pool) b.live = false;
  if (bodyInst) bodyInst.count = 0;
  if (coreInst) for (const kind of KINDS) { coreInst[kind].count = 0; ringInst[kind].count = 0; }
}

// One runnable check for the branch that matters: the dry-guard must fire, and a special
// brick must only ever touch a special-class slot.
export function selfTest() {
  const mk = (arch, ammo, reserve, maxReserve) => ({ archetype: arch, ammo, reserve, maxReserve });
  const wp = {
    slots: [mk('autorifle', 0, 0, 300), mk('sniper', 0, 0, 28)],
    addAmmo(i, n) { const w = this.slots[i]; if (w) w.reserve = Math.min(w.maxReserve, w.reserve + n); },
  };
  const ctx = { weapons: wp };
  if (!isDry(ctx)) throw new Error('dry-guard blind to an all-zero loadout');
  if (refill(ctx, 'light') !== 36 + 4) throw new Error('light brick did not refill both slots');
  if (isDry(ctx)) throw new Error('still reads dry after a refill');
  wp.slots[0].reserve = 0; wp.slots[1].reserve = 0;
  refill(ctx, 'special');
  if (wp.slots[0].reserve !== 0) throw new Error('special brick fed a primary');
  if (wp.slots[1].reserve !== 7) throw new Error('special brick did not feed the sniper');

  // geometry sanity — mergeGeometries() returns null (not a throw) on an attribute mismatch, and
  // a null .computeVertexNormals() call throws a TypeError far from the actual cause; this catches
  // it here with a clear message instead of a stack trace from inside three's merge helper.
  const parts = {
    case: caseGeometry(), lightCore: lightCoreGeometry(),
    specialCore: specialCoreGeometry(), ring: brickRingGeometry(),
  };
  for (const [name, g] of Object.entries(parts)) {
    if (!g || !g.attributes.position || g.attributes.position.count < 8) {
      throw new Error(`ammo geometry '${name}' failed to build (merge attribute mismatch?)`);
    }
  }
  return true;
}
