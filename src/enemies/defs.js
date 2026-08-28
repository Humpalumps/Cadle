/**
 * Enemy type definitions: stats at level 1 (scaled by level in Enemy), AI role/ranges, look (tint/emissive palette
 * per instance, deterministic per seed), combat target shape. Everything in meters / seconds / hp.
 *  role: 'melee' (close, wind-up, strike) | 'ranged' (keeps a distance band, strafes, bolts) | 'slam' (heavy AoE) | 'dive' (flyer swoops)
 * Damage tuning: Destiny trash chips and pressures (player 100 hp + regen) — a full engagement vs 2-3 enemies should
 * take ~25-45 hp before they die, never one-shot below the boss tier.
 * standoff: hard minimum distance (m, horizontal to the player; flyers: 3D to the eye) — enemies NEVER get closer
 * (Destiny melee dance: stop at attack range, telegraph, strike, circle; never fill the camera).
 */
export const DEFS = {
  wisp: {
    name: 'Aether Wisp', element: 'arc', role: 'ranged', flying: true, hover: 1.9, scale: 1.15,
    health: 45, shield: 0, damage: 5, speed: 5.5, turn: 6, accel: 10,
    // perception 38 let wandering meadow wisps drift inside notice range and perma-aggro an idle
    // spawn player (seen live twice; decree: spawn meadow stays peaceful). 26 keeps them curious
    // fireflies until you walk at them or shoot.
    perception: 26, fov: 3.2, attackRange: 22, band: [11, 19], attackWindup: 0.55, attackCooldown: 1.9, attackRecover: 0.2, standoff: 2.5,
    projectile: { speed: 24, radius: 0.2, element: 'arc', life: 4 },
    fleeAt: 0.35, fleeTime: 3.2, strafe: 1, stagger: 0.3, staggerTime: 0.35,
    radius: 0.45, height: 0, center: 0, weakPoints: null,
    palette: [[0x66d9ff, 0x2a3348], [0xb070ff, 0x2a2640], [0x7cffd8, 0x243838], [0x9fd8ff, 0x2c3250]], glow: 0.85, rim: 0.6, bump: 0, // user decree: wisps must not read as white blobs across the meadow (1.1 x the night dayGlow multiplier still tone-mapped to a near-white 211,224,226 ball at 23:00 -- blobcheck caught it; hue kept, intensity cut) — keep hue, no ACES white-clip
    deathTime: 1.1, xp: 8,
  },
  hound: {
    name: 'Aether Hound', element: 'arc', role: 'melee', flying: false, scale: 1.45,
    health: 140, shield: 0, damage: 8, speed: 8.5, turn: 5, accel: 22,
    // attackRange (3.2) > standoff (2.2) by design: the bite starts from inside the dance band, so a circling hound
    // commits several lunges per 10 s instead of orbiting forever. Pack rate is throttled by Enemies.meleeToken.
    perception: 34, fov: 2.4, attackRange: 3.2, attackWindup: 0.38, attackCooldown: 1.35, attackRecover: 0.28, lungeSpeed: 7, standoff: 2.2,
    stagger: 0.16, staggerTime: 0.45, pack: true,
    radius: 0.55, height: 1.25, center: 1.08, weakPoints: [{ bone: 'head', radius: 0.27, mult: 2.0, off: [0, 0.02, 0.1] }],
    palette: [[0x66d9ff, 0xffffff], [0x7fd8ff, 0xdfe6f0], [0xb070ff, 0xe8dcff]], glow: 1.9, rim: 0.65, bump: 0.045,
    deathTime: 1.4, xp: 20,
  },
  sentinel: {
    name: 'Spire Sentinel', element: 'arc', role: 'ranged', flying: false, scale: 1.12,
    health: 260, shield: 140, shieldElement: 'arc', damage: 7, speed: 3.6, turn: 3.5, accel: 10,
    perception: 45, fov: 2.6, attackRange: 30, band: [13, 24], attackWindup: 0.75, attackCooldown: 2.6, attackRecover: 0.4, volley: 3, volleyGap: 0.16, standoff: 2.2,
    projectile: { speed: 32, radius: 0.22, element: 'arc', life: 4 },
    // shieldRadius 1.05 -> 0.96 (and the same ~9% trim on every other sentinel-body humanoid): the wave-6
    // verdict called the bubbles "twice the body width". The model's shoulders are ~0.55 m half-width at this
    // scale, so 0.96 still stands the shell well clear of the body and the weapon.
    strafe: 1, stagger: 0.22, staggerTime: 0.5, shieldRadius: 0.96,
    radius: 0.55, height: 2.7, center: 1.74, weakPoints: [{ bone: 'head', radius: 0.3, mult: 2.0, off: [0, 0.17, 0] }],
    palette: [[0x7fd8ff, 0xffffff], [0xffd27a, 0xfff1d6]], glow: 1.9, rim: 0.55, bump: 0.05,
    deathTime: 1.6, xp: 45,
  },
  golem: {
    name: 'Stone Golem', element: 'void', role: 'slam', flying: false,
    health: 620, shield: 0, damage: 24, speed: 2.4, turn: 2.2, accel: 6,
    perception: 40, fov: 2.4, attackRange: 4.2, attackWindup: 0.9, attackCooldown: 2.8, attackRecover: 0.6, slamRadius: 5, knockback: 9, standoff: 3.9,
    throwRange: [9, 24], throw: { speed: 22, radius: 0.45, gravity: 14, element: 'kinetic', life: 5, damage: 14, explodeRadius: 2.5 },
    stagger: 0.3, staggerTime: 0.6,
    radius: 0.95, height: 3.3, center: 1.8, weakPoints: [{ bone: 'core', radius: 0.36, mult: 3.0, off: [0, 0, 0.07] }],
    palette: [[0xb070ff, 0xffffff], [0x66d9ff, 0xffffff]], glow: 2.4, rim: 0.45, bump: 0.075,
    deathTime: 2.0, xp: 90,
  },
  drake: {
    name: 'Ember Drake', element: 'solar', role: 'dive', flying: true, hover: 11,
    health: 420, shield: 90, shieldElement: 'solar', damage: 10, speed: 13, turn: 2.4, accel: 9,
    perception: 70, fov: 6.3, attackRange: 40, orbit: 16, attackWindup: 0.5, attackCooldown: 4.0, attackRecover: 0.8, volley: 3, volleyGap: 0.12, standoff: 2.6,
    projectile: { speed: 34, radius: 0.25, element: 'solar', life: 3.5, explodeRadius: 1.6 },
    stagger: 0.25, staggerTime: 0.5,
    radius: 0.65, height: 1.2, center: 0, weakPoints: [{ bone: 'head', radius: 0.3, mult: 2.0, off: [0, 0.02, 0.12] }],
    palette: [[0xff8a3d, 0xffffff], [0xffb04a, 0xffffff]], glow: 2.3, rim: 0.5, bump: 0.04,
    // GPU ribbon fire (vfx.filaments). Colours stay DEEP saturated orange: an additive ribbon that tone-maps to
    // white is the washed-white blob bug, so the heat comes from hue and taper, never from raising the value.
    flame: { color: 0xff6a14, width: 0.42, spread: 0.16, strands: 3, lag: 0.085 },
    breath: { color: 0xff5c0e, width: 0.40, spread: 0.20, strands: 3, length: 6.0, standoff: 6.0, alpha: 0.85, near: 11, far: 20 },
    // near/far: the jet only plays on the APPROACH. A dive ends with the drake passing within a few metres, and a
    // 6 m jet aimed at the eye from there fills the whole frame — dramatic for one frame, then auto-exposure drags
    // the world dark behind it. Off inside 11 m, full beyond 20 m; the strafing run is where it reads anyway.
    deathTime: 1.6, xp: 120,
  },
  warden: {
    name: 'Warden of the Spire', element: 'void', role: 'slam', flying: false, boss: true,
    health: 1800, shield: 500, shieldElement: 'void', damage: 32, speed: 3.4, turn: 2.8, accel: 8,
    perception: 60, fov: 6.3, attackRange: 4.6, attackWindup: 0.8, attackCooldown: 2.4, attackRecover: 0.6, slamRadius: 6, knockback: 11, standoff: 4.1,
    volleyRange: [8, 30], volley: 5, volleyGap: 0.1, volleySpread: 0.35, projectile: { speed: 30, radius: 0.28, element: 'void', life: 4, damage: 11 },
    stagger: 0.4, staggerTime: 0.5, shieldRadius: 1.85, phases: [0.66, 0.33],
    radius: 1.1, height: 3.9, center: 2.1, weakPoints: [{ bone: 'head', radius: 0.42, mult: 1.6, off: [0, 0.26, 0] }, { bone: 'torso', radius: 0.38, mult: 2.2, off: [0, 0.67, 0.39] }],
    palette: [[0xb070ff, 0xffffff]], glow: 2.4, rim: 0.55, bump: 0.055,
    deathTime: 2.6, xp: 400,
  },
  // -------------------------------------------------- Gloamtide Corsairs (pirate camps, mountain-ring roads)
  // Humanoid raiders with AETHER FLINTLOCKS: a slow heavy solar bolt fired in a 2-shot brace with a long
  // reload — a musket cadence, not a sentinel's arc volley. `sit: true` = at camp, unaggroed, they SIT on
  // their log seats and drink (glbAnim sit pose, gated on e.camp so a bare spawn behaves normally);
  // `handProps: true` = Enemy parents a tankard + flintlock to the hand bones (tankard while seated, gun up
  // on aggro). `meleeRange` is the ranged-role melee fallback: inside it they pistol-whip ('bite' path)
  // instead of shooting their own feet. Colours obey the blob law: saturated ember/aether hues, capped glow.
  raider: {
    name: 'Gloamtide Corsair', element: 'solar', role: 'ranged', flying: false, scale: 1.0,
    sit: true, handProps: true,
    health: 190, shield: 0, damage: 8, speed: 4.6, turn: 3.6, accel: 11,
    // perception 20: modest on purpose — a stealthy player can crouch the ridge and watch the camp drink.
    perception: 20, fov: 2.4, attackRange: 26, band: [9, 18], attackWindup: 0.7, attackCooldown: 2.6, attackRecover: 0.4, volley: 2, volleyGap: 0.45, standoff: 2.2,
    meleeRange: 3.4, lungeSpeed: 4,
    projectile: { speed: 22, radius: 0.24, element: 'solar', life: 4 },
    strafe: 0.8, stagger: 0.22, staggerTime: 0.5,
    radius: 0.5, height: 1.85, center: 1.0, weakPoints: [{ bone: 'head', radius: 0.24, mult: 2.0, off: [0, 0.1, 0] }],
    palette: [[0xffa03a, 0x6a5a4a], [0xff8a3d, 0x5a5460], [0xffb95e, 0x4c5566]], glow: 1.5, rim: 0.45, bump: 0.05,
    deathTime: 1.5, xp: 34,
  },
  'raider-captain': {
    name: 'Corsair Captain', body: 'captain', element: 'solar', role: 'ranged', flying: false, scale: 1.2,
    sit: true, handProps: true,
    health: 560, shield: 200, shieldElement: 'solar', damage: 10, speed: 4.2, turn: 3.4, accel: 10,
    perception: 24, fov: 2.6, attackRange: 30, band: [10, 20], attackWindup: 0.75, attackCooldown: 2.4, attackRecover: 0.45, volley: 3, volleyGap: 0.35, standoff: 2.4,
    meleeRange: 3.8, lungeSpeed: 4,
    // NO explodeRadius: an explosive solar volley that ends its life AT the camera is the exact wave-3
    // dragon full-frame blowout recipe (see Enemy._fireBolt's ribbon note); with six crew already firing,
    // the captain's weight comes from per-bolt damage, not from painting the lens orange.
    projectile: { speed: 24, radius: 0.28, element: 'solar', life: 4 },
    strafe: 0.7, stagger: 0.26, staggerTime: 0.5, shieldRadius: 1.06,
    radius: 0.56, height: 2.2, center: 1.18, weakPoints: [{ bone: 'head', radius: 0.26, mult: 2.0, off: [0, 0.1, 0] }],
    // violet emissive: the captain's glowing aether amulet is the tell that this one is the mini-boss
    palette: [[0xb070ff, 0x6a5a72]], glow: 1.7, rim: 0.5, bump: 0.05,
    deathTime: 1.8, xp: 150,
  },
};
/**
 * Biome bestiary (Biomes.js roster). Each entry names the procedural `body` it wears — bodies are silhouettes,
 * defs are the creature: palette, element, role, stats, ranges. A frost wolf is a hound built from ice; a
 * treant is a golem grown from bark. Bone names referenced by weakPoints must exist in that body.
 * Colours obey the architectural law: saturate the HUE, cap the VALUE (glow stays in the 0.8-2.5 band the
 * existing bestiary uses, and no palette entry is a white that ACES will clip into a blob).
 */
// SIGNATURE MOVES. A re-skin with different numbers is still the same fight; one move that changes what
// YOU have to do is what makes a region's bestiary its own. Each is a small hook in Enemy.js, not a new AI:
//   breath   {..}  a held ribbon jet during the wind-up (already supported; frost is the drake's fire, cold)
//   blink    {cd, dist}       teleports sideways when hurt — you cannot just hold the crosshair on it
//   pull     {force}          its strike drags you IN, so backing off is not free
//   chill    {secs, mul}      its hit slows you, which is what makes an ice region feel like one
//   ground   {r, dps, secs, colour}  leaves a burning patch where it slams — the arena shrinks as you fight
//   mend     {cd, r, frac}    heals its neighbours on a timer — kill the healer first or kill nothing
const BIOME_DEFS = {
  // -------------------------------------------------- Whisperwood Deep (forest)
  sprite: {
    name: 'Wood Sprite', body: 'sprite', element: 'strand', role: 'ranged', flying: true, hover: 1.7, scale: 1.0,
    // ethereal: see the uGhost block in materials.js. `hem` = [solidY, goneY] in the body's BIND-pose root space;
    // a fae is only half here, so its under-fluff frays into drifting light instead of ending on a hard edge.
    ghost: 0.45, hem: [-0.10, -0.46],
    health: 55, shield: 0, damage: 5, speed: 6.4, turn: 7, accel: 12,
    perception: 30, fov: 3.2, attackRange: 20, band: [9, 17], attackWindup: 0.45, attackCooldown: 1.7, attackRecover: 0.2, standoff: 2.4,
    projectile: { speed: 26, radius: 0.19, element: 'strand', life: 4 },
    fleeAt: 0.3, fleeTime: 2.8, strafe: 1, stagger: 0.28, staggerTime: 0.35,
    radius: 0.42, height: 0, center: 0, weakPoints: null,
    palette: [[0x7cff9c, 0xcfe4c6], [0xc8ff7a, 0xdae6bc], [0x5effc8, 0xc6e8da]], glow: 0.9, rim: 0.6, bump: 0.03,
    deathTime: 1.0, xp: 14,
  },
  treant: {
    name: 'Elder Treant', body: 'treant', element: 'strand', role: 'slam', flying: false, scale: 1.15,
    health: 700, shield: 0, damage: 24, speed: 2.2, turn: 2.0, accel: 5.5,
    perception: 38, fov: 2.3, attackRange: 4.6, attackWindup: 1.0, attackCooldown: 2.9, attackRecover: 0.65, slamRadius: 5.4, knockback: 9, standoff: 4.1,
    throwRange: [10, 26], throw: { speed: 21, radius: 0.5, gravity: 14, element: 'strand', life: 5, damage: 15, explodeRadius: 2.8 },
    stagger: 0.34, staggerTime: 0.6,
    radius: 1.0, height: 3.6, center: 1.9, weakPoints: [{ bone: 'core', radius: 0.38, mult: 3.0, off: [0, 0, 0.07] }],
    // palette is [EMISSIVE, TINT] (Enemy.spawn: uEmissive = pal[0], uTint = pal[1]) — this entry had the pair
    // reversed, so the bark took the bright green as a body tint and the heartwood glowed dull brown.
    // rim 0.40 -> 0.14 and a deeper sap green: `rim` multiplies the emissive at every grazing angle, and a
    // creature built out of vine cords and leaf plates is nearly ALL grazing angle — at 0.40 the trunk came
    // out as lime pinstripes (tools/out/c2-tt/shot-treant-close.png). Sap-light belongs in the heartwood.
    palette: [[0x5fd06a, 0xe4dac2], [0x86dc72, 0xd8cfb6]], glow: 1.6, rim: 0.14, bump: 0.085,
    deathTime: 2.1, xp: 110,
  },
  // -------------------------------------------------- Frostveil Tundra
  frostwolf: {
    name: 'Frostveil Wolf', body: 'frostwolf', element: 'stasis', role: 'melee', flying: false, scale: 1.5,
    health: 175, shield: 0, damage: 9, speed: 9.2, turn: 5.5, accel: 24,
    perception: 36, fov: 2.5, attackRange: 3.3, attackWindup: 0.34, attackCooldown: 1.25, attackRecover: 0.26, lungeSpeed: 8, standoff: 2.2,
    stagger: 0.16, staggerTime: 0.45, pack: true,
    radius: 0.58, height: 1.3, center: 1.12, weakPoints: [{ bone: 'head', radius: 0.28, mult: 2.0, off: [0, 0.02, 0.1] }],
    palette: [[0x9fd8ff, 0xffffff], [0xcfe6ff, 0xeef6ff], [0x7fbfff, 0xdfeaff]], glow: 1.7, rim: 0.7, bump: 0.05,
    // deep saturated ice-blue, value well under 1: a white jet would be the washed-white blob bug
    breath: { color: 0x2f9dff, width: 0.30, spread: 0.16, strands: 3, length: 4.4, standoff: 2.6, alpha: 0.7, near: 2, far: 9 },
    signature: { chill: { secs: 2.2, mul: 0.55 } },
    deathTime: 1.4, xp: 34,
  },
  icegiant: {
    name: 'Frostveil Giant', body: 'giant', element: 'stasis', role: 'slam', flying: false, scale: 1.0,
    health: 950, shield: 180, shieldElement: 'stasis', damage: 28, speed: 3.0, turn: 2.3, accel: 7,
    perception: 46, fov: 2.5, attackRange: 5.2, attackWindup: 0.85, attackCooldown: 2.7, attackRecover: 0.6, slamRadius: 6.2, knockback: 12, standoff: 4.5,
    throwRange: [11, 30], throw: { speed: 24, radius: 0.5, gravity: 14, element: 'stasis', life: 5, damage: 17, explodeRadius: 3.0 },
    stagger: 0.36, staggerTime: 0.6, shieldRadius: 1.9,
    radius: 1.05, height: 4.6, center: 2.5, weakPoints: [{ bone: 'head', radius: 0.42, mult: 2.2, off: [0, 0.1, 0.1] }],
    palette: [[0x9fd8ff, 0xffffff], [0xbfe4ff, 0xeaf4ff]], glow: 1.8, rim: 0.6, bump: 0.07,
    signature: { chill: { secs: 3.0, mul: 0.45 }, ground: { r: 5.5, dps: 7, secs: 6, color: 0x6fc8ff, element: 'stasis' } },
    deathTime: 2.3, xp: 190,
  },
  // -------------------------------------------------- Celestial Isles
  seraph: {
    name: 'Empyrean Seraph', body: 'sentinel', element: 'solar', role: 'ranged', flying: false, scale: 1.2,
    health: 520, shield: 300, shieldElement: 'solar', damage: 12, speed: 4.0, turn: 3.8, accel: 11,
    perception: 52, fov: 2.8, attackRange: 34, band: [15, 27], attackWindup: 0.7, attackCooldown: 2.4, attackRecover: 0.4, volley: 4, volleyGap: 0.14, standoff: 2.4,
    projectile: { speed: 36, radius: 0.22, element: 'solar', life: 4 },
    strafe: 1, stagger: 0.22, staggerTime: 0.5, shieldRadius: 1.02,
    radius: 0.58, height: 2.9, center: 1.86, weakPoints: [{ bone: 'head', radius: 0.3, mult: 2.0, off: [0, 0.17, 0] }],
    // WAVE-6 BLOCKER: "the signature creature is the wrong creature — a rust-bronze plate brute, identical to
    // the Infernal/Dragon forgeknight". Both wear the sentinel GLB, and a near-white tint on a GLB is a no-op
    // (see the TINT ON A TEXTURED BODY block in materials.js), so the only thing that ever differed between
    // them was a warm rim colour. The tint is now saturated enough to trip the repaint: the plate is remapped
    // to COOL MARBLE at its own value range x2.6 (the Tripo bake is lit dark), while the albedo's bright
    // saturated texels — the gold filigree and the gem inlays — are held out of the repaint by the ornament
    // gate, so what is left is white-blue marble with gold. rim 0.6 -> 0.34 for the same reason as the treant:
    // a rim multiplies the emissive at every grazing angle, and a warm rim at 0.6 IS the bronze read.
    palette: [[0x5aa8ff, 0x40d8ff], [0x74b8ff, 0x55dcff]], glow: 2.1, rim: 0.34, bump: 0.05,
    deathTime: 1.7, xp: 260,
  },
  skyserpent: {
    name: 'Sky Serpent', body: 'serpent', element: 'arc', role: 'dive', flying: true, hover: 9, scale: 1.75,
    health: 620, shield: 140, shieldElement: 'arc', damage: 13, speed: 15, turn: 2.6, accel: 10,
    perception: 74, fov: 6.3, attackRange: 42, orbit: 18, attackWindup: 0.45, attackCooldown: 3.6, attackRecover: 0.7, volley: 3, volleyGap: 0.12, standoff: 3.0,
    projectile: { speed: 36, radius: 0.24, element: 'arc', life: 3.5, explodeRadius: 1.5 },
    stagger: 0.26, staggerTime: 0.5,
    radius: 0.7, height: 1.2, center: 0, weakPoints: [{ bone: 'head', radius: 0.3, mult: 2.0, off: [0, 0.02, 0.85] }],
    palette: [[0x7fd8ff, 0xffffff], [0x9fe8ff, 0xe8f6ff]], glow: 2.0, rim: 0.55, bump: 0.04,
    deathTime: 1.7, xp: 300,
  },
  // -------------------------------------------------- Dragon Peaks
  wyvern: {
    name: 'Peak Wyvern', body: 'drake', element: 'solar', role: 'dive', flying: true, hover: 13, scale: 1.35,
    health: 700, shield: 160, shieldElement: 'solar', damage: 14, speed: 14, turn: 2.3, accel: 9,
    perception: 78, fov: 6.3, attackRange: 44, orbit: 18, attackWindup: 0.5, attackCooldown: 3.8, attackRecover: 0.8, volley: 3, volleyGap: 0.12, standoff: 3.0,
    projectile: { speed: 34, radius: 0.27, element: 'solar', life: 3.5, explodeRadius: 1.8 },
    stagger: 0.26, staggerTime: 0.5,
    radius: 0.8, height: 1.3, center: 0, weakPoints: [{ bone: 'head', radius: 0.32, mult: 2.0, off: [0, 0.02, 0.12] }],
    // WAVE-6: "a uniformly saturated vermillion mass whose outline resolves as neither head, neck nor wing at
    // any of the three distances". Looked at it (tools/out/before-dra): the body is BLACK — drake.glb's albedo
    // is linear luminance ~0.036 — and every visible pixel was the solar rim, which at 0.5 fires on every
    // grazing angle. A wyvern is wings, neck, tail and horns: it is nearly ALL grazing angle, so the rim drew
    // an orange wireframe around a void. Exactly the treant lime-pinstripe failure one creature over.
    // Fix is the same shape as the treant's: the light belongs in the BODY, not on its edges. rim 0.5 -> 0.16,
    // and the tint is saturated enough to trip the repaint, which remaps the bake's own value structure
    // (dark membrane vs lighter bone plate) across a 2.6x range instead of leaving it all at black.
    palette: [[0xff5a14, 0xff5a1e], [0xe0641c, 0xff8c3a]], glow: 2.2, rim: 0.16, bump: 0.045,
    flame: { color: 0xff6a14, width: 0.46, spread: 0.17, strands: 3, lag: 0.085 },
    breath: { color: 0xff5c0e, width: 0.44, spread: 0.21, strands: 3, length: 6.5, standoff: 6.0, alpha: 0.85, near: 11, far: 20 },
    deathTime: 1.8, xp: 320,
  },
  forgeknight: {
    name: 'Kharaz Forgeknight', body: 'sentinel', element: 'solar', role: 'ranged', flying: false, scale: 1.05,
    health: 480, shield: 240, shieldElement: 'solar', damage: 11, speed: 3.4, turn: 3.2, accel: 9,
    perception: 44, fov: 2.6, attackRange: 28, band: [11, 21], attackWindup: 0.8, attackCooldown: 2.5, attackRecover: 0.45, volley: 3, volleyGap: 0.15, standoff: 2.2,
    projectile: { speed: 30, radius: 0.24, element: 'solar', life: 4 },
    strafe: 0.7, stagger: 0.2, staggerTime: 0.5, shieldRadius: 0.96,
    radius: 0.56, height: 2.6, center: 1.68, weakPoints: [{ bone: 'head', radius: 0.3, mult: 2.0, off: [0, 0.17, 0] }],
    palette: [[0xffb44a, 0xffe8b0], [0xd89a3c, 0xffdca0]], glow: 1.9, rim: 0.5, bump: 0.06,
    deathTime: 1.7, xp: 230,
  },
  // -------------------------------------------------- Infernal Wastes
  imp: {
    name: 'Cinder Imp', body: 'wisp', element: 'solar', role: 'ranged', flying: true, hover: 1.8, scale: 1.0,
    health: 80, shield: 0, damage: 7, speed: 7.2, turn: 7.5, accel: 13,
    perception: 32, fov: 3.4, attackRange: 22, band: [8, 16], attackWindup: 0.4, attackCooldown: 1.5, attackRecover: 0.18, standoff: 2.4,
    projectile: { speed: 28, radius: 0.2, element: 'solar', life: 3.5, explodeRadius: 1.2 },
    fleeAt: 0.2, fleeTime: 2.0, strafe: 1, stagger: 0.26, staggerTime: 0.32,
    radius: 0.42, height: 0, center: 0, weakPoints: null,
    palette: [[0xff8a3d, 0x3a1a10], [0xffb04a, 0x40200e], [0xff5c1e, 0x351610]], glow: 1.0, rim: 0.6, bump: 0,
    deathTime: 1.0, xp: 40,
  },
  magmagolem: {
    name: 'Magma Golem', body: 'golem', element: 'solar', role: 'slam', flying: false, scale: 1.1,
    health: 820, shield: 0, damage: 27, speed: 2.5, turn: 2.2, accel: 6,
    perception: 42, fov: 2.4, attackRange: 4.4, attackWindup: 0.9, attackCooldown: 2.7, attackRecover: 0.6, slamRadius: 5.6, knockback: 10, standoff: 4.0,
    throwRange: [9, 26], throw: { speed: 23, radius: 0.46, gravity: 14, element: 'solar', life: 5, damage: 16, explodeRadius: 2.8 },
    stagger: 0.32, staggerTime: 0.6,
    radius: 0.98, height: 3.4, center: 1.85, weakPoints: [{ bone: 'core', radius: 0.36, mult: 3.0, off: [0, 0, 0.07] }],
    palette: [[0x3a2018, 0xff6a14], [0x2e1a12, 0xff8a2a]], glow: 2.3, rim: 0.45, bump: 0.08,
    signature: { ground: { r: 6.0, dps: 12, secs: 8, color: 0xff5c10, element: 'solar' } },
    deathTime: 2.0, xp: 160,
  },
  // -------------------------------------------------- Shadowfen
  wraith: {
    name: 'Fen Wraith', body: 'wraith', element: 'void', role: 'ranged', flying: true, hover: 1.6, scale: 1.15,
    health: 210, shield: 60, shieldElement: 'void', damage: 9, speed: 5.4, turn: 5, accel: 10,
    perception: 34, fov: 3.0, attackRange: 24, band: [8, 18], attackWindup: 0.6, attackCooldown: 2.0, attackRecover: 0.3, standoff: 2.6,
    projectile: { speed: 24, radius: 0.22, element: 'void', life: 4 },
    strafe: 1, stagger: 0.24, staggerTime: 0.45, shieldRadius: 1.0,
    // off was [0, 0.55, 0.05], which put the crit sphere 0.55 m ABOVE the `head` bone and therefore half a metre
    // over the hood, in empty air: headshots on a wraith could not land. The bone sits at root y 0.52 and the
    // hood volume is centred at 0.62, so the offset is 0.10. Same radius, same multiplier, same bone.
    radius: 0.5, height: 0, center: 0, weakPoints: [{ bone: 'head', radius: 0.26, mult: 2.2, off: [0, 0.10, 0.02] }],
    palette: [[0xb070ff, 0xe6d8ff], [0x8a7cff, 0xd8d0ff], [0x7cffd8, 0xd0fff0]], glow: 1.5, rim: 0.7, bump: 0.03,
    ghost: 0.68, hem: [-0.30, -1.32],
    deathTime: 1.5, xp: 70,
  },
  bogwitch: {
    name: 'Bog Witch', body: 'sentinel', element: 'strand', role: 'ranged', flying: false, scale: 1.02,
    health: 340, shield: 120, shieldElement: 'strand', damage: 10, speed: 3.8, turn: 3.6, accel: 10,
    perception: 42, fov: 2.7, attackRange: 30, band: [12, 23], attackWindup: 0.75, attackCooldown: 2.4, attackRecover: 0.4, volley: 3, volleyGap: 0.18, standoff: 2.2,
    projectile: { speed: 26, radius: 0.26, element: 'strand', life: 4.5, explodeRadius: 1.8 },
    strafe: 1, stagger: 0.22, staggerTime: 0.5, shieldRadius: 0.96,
    radius: 0.54, height: 2.6, center: 1.68, weakPoints: [{ bone: 'head', radius: 0.3, mult: 2.0, off: [0, 0.17, 0] }],
    palette: [[0x7cff9c, 0x1f3324], [0xa8ff6a, 0x263320]], glow: 1.7, rim: 0.6, bump: 0.05,
    signature: { mend: { cd: 7.0, r: 22, frac: 0.11 } },
    deathTime: 1.6, xp: 95,
  },
  // -------------------------------------------------- The Sunken Kingdom
  drowned: {
    name: 'Drowned Courtier', body: 'sentinel', element: 'arc', role: 'ranged', flying: false, scale: 1.05,
    health: 400, shield: 160, shieldElement: 'arc', damage: 10, speed: 3.4, turn: 3.4, accel: 9,
    perception: 40, fov: 2.6, attackRange: 26, band: [10, 20], attackWindup: 0.8, attackCooldown: 2.5, attackRecover: 0.45, volley: 3, volleyGap: 0.16, standoff: 2.2,
    projectile: { speed: 28, radius: 0.23, element: 'arc', life: 4 },
    strafe: 0.8, stagger: 0.22, staggerTime: 0.5, shieldRadius: 0.96,
    radius: 0.56, height: 2.7, center: 1.72, weakPoints: [{ bone: 'head', radius: 0.3, mult: 2.0, off: [0, 0.17, 0] }],
    // WAVE-6: "the generic sentinel GLB re-tinted infernal RED". Measured cause: the second palette entry was
    // [0xff7a9c, 0xffe0e8] — a hot pink EMISSIVE behind rim 0.65, and on a GLB the emissive rim is the only
    // channel a palette had, so half of all spawns came up as a red-outlined courtier in a teal kingdom.
    // Drowned teal / verdigris now, with the tint saturated enough to repaint the plate itself instead of
    // outlining it, and bone/gold ornament preserved by the ornament gate in materials.js.
    palette: [[0x2fd8c0, 0x00ffd0], [0x46e0b4, 0x2affc0]], glow: 1.6, rim: 0.34, bump: 0.055,
    deathTime: 1.7, xp: 130,
  },
  leviathan: {
    name: 'Court Leviathan', body: 'serpent', element: 'arc', role: 'dive', flying: true, hover: 6, scale: 2.3,
    health: 900, shield: 200, shieldElement: 'arc', damage: 16, speed: 12, turn: 2.2, accel: 8,
    perception: 70, fov: 6.3, attackRange: 40, orbit: 17, attackWindup: 0.55, attackCooldown: 3.8, attackRecover: 0.8, volley: 3, volleyGap: 0.13, standoff: 3.4,
    projectile: { speed: 32, radius: 0.28, element: 'arc', life: 3.5, explodeRadius: 1.8 },
    stagger: 0.3, staggerTime: 0.55,
    radius: 0.85, height: 1.4, center: 0, weakPoints: [{ bone: 'head', radius: 0.34, mult: 2.0, off: [0, 0.02, 0.85] }],
    palette: [[0x2f8a9c, 0xd8fff6], [0x3f9fb0, 0xe8fffa]], glow: 1.9, rim: 0.6, bump: 0.045,
    signature: { pull: { force: 16 } },
    deathTime: 2.0, xp: 240,
  },
  // -------------------------------------------------- The Void
  riftling: {
    // body 'riftling' (was 'wisp'): the Void's trash mob was the Vale's glowing orb re-tinted, which is what the
    // wave-3 void verdict measured as "a chunky flat pale-pink body with three flat pink ribbon loops". It is a
    // rift beast now. hover unchanged, so the AI is untouched — the body just hangs its mass below the root.
    // hover 2.1 -> 1.4 and scale 1.05 -> 0.85: an ORB can float at head height, a 1.9 m armoured quadruped
    // cannot — at 2.1 m its paws hung level with the player's eyes. 1.4 puts the paws ~0.8 m off the ground,
    // which is a beast prowling the air. AI, ranges, projectile and standoff are untouched.
    name: 'Riftling', body: 'riftling', element: 'void', role: 'ranged', flying: true, hover: 1.4, scale: 1.0,
    health: 140, shield: 40, shieldElement: 'void', damage: 9, speed: 7.8, turn: 8, accel: 15,
    perception: 34, fov: 3.4, attackRange: 24, band: [10, 19], attackWindup: 0.4, attackCooldown: 1.6, attackRecover: 0.2, standoff: 2.6,
    projectile: { speed: 30, radius: 0.21, element: 'void', life: 4 },
    fleeAt: 0.18, fleeTime: 1.8, strafe: 1, stagger: 0.26, staggerTime: 0.32,
    radius: 0.45, height: 0, center: 0, weakPoints: null,
    palette: [[0xb070ff, 0x8a7ba8], [0x8a3dff, 0x7d6fa0], [0xd070ff, 0x9484ae]], glow: 1.05, rim: 0.7, bump: 0.05,
    ghost: 0.40, hem: [-0.62, -0.82],
    signature: { blink: { cd: 3.2, dist: 9 } },
    deathTime: 1.1, xp: 90,
  },
  voidhorror: {
    name: 'Void Horror', body: 'wraith', element: 'void', role: 'ranged', flying: true, hover: 2.4, scale: 1.75,
    health: 780, shield: 320, shieldElement: 'void', damage: 15, speed: 5.0, turn: 4, accel: 9,
    perception: 44, fov: 3.0, attackRange: 30, band: [10, 22], attackWindup: 0.7, attackCooldown: 2.2, attackRecover: 0.35, volley: 3, volleyGap: 0.15, standoff: 3.0,
    projectile: { speed: 27, radius: 0.28, element: 'void', life: 4.5, explodeRadius: 1.9 },
    strafe: 1, stagger: 0.3, staggerTime: 0.5, shieldRadius: 1.5,
    radius: 0.72, height: 0, center: 0, weakPoints: [{ bone: 'head', radius: 0.34, mult: 2.2, off: [0, 0.10, 0.02] }],
    palette: [[0x8a3dff, 0xd8b0ff], [0x6a2ce0, 0xc8a0ff]], glow: 1.7, rim: 0.75, bump: 0.04,
    ghost: 0.86, hem: [-0.30, -1.32],
    signature: { pull: { force: 13 }, blink: { cd: 6.0, dist: 7 } },
    deathTime: 1.9, xp: 280,
  },
  // -------------------------------------------------- The Lost Realm (endgame)
  archon: {
    name: 'Archon of the Convergence', body: 'warden', element: 'void', role: 'slam', flying: false, boss: true, scale: 1.15,
    health: 3200, shield: 900, shieldElement: 'void', damage: 38, speed: 3.6, turn: 2.9, accel: 8,
    perception: 66, fov: 6.3, attackRange: 5.0, attackWindup: 0.78, attackCooldown: 2.2, attackRecover: 0.55, slamRadius: 7, knockback: 13, standoff: 4.3,
    volleyRange: [8, 34], volley: 6, volleyGap: 0.1, volleySpread: 0.35, projectile: { speed: 32, radius: 0.3, element: 'void', life: 4, damage: 13 },
    stagger: 0.42, staggerTime: 0.5, shieldRadius: 2.1, phases: [0.7, 0.4],
    radius: 1.15, height: 4.2, center: 2.3, weakPoints: [{ bone: 'head', radius: 0.44, mult: 1.6, off: [0, 0.26, 0] }, { bone: 'torso', radius: 0.4, mult: 2.2, off: [0, 0.67, 0.39] }],
    // WAVE-6: "the same body as the Stone Golem reskinned darker" — a level-50 boss that was a dark violet
    // mass standing in a violet world, i.e. camouflaged by its own region. Two changes, both mechanism:
    // the tint is saturated royal violet so the warden bake is REPAINTED (and value-expanded) rather than
    // multiplied into mud, and the emissive — which on a GLB is only the rim — is GOLD, so the endgame boss
    // is the one silhouette in the Lost Realm outlined in a colour the Lost Realm does not own.
    palette: [[0xffc65a, 0xa040ff]], glow: 2.4, rim: 0.45, bump: 0.06,
    deathTime: 2.8, xp: 900,
  },
};
Object.assign(DEFS, BIOME_DEFS);
export { BIOME_DEFS };

export const LEVEL_HP = (base, level) => Math.round(base * (1 + 0.22 * (level - 1)));
export const LEVEL_DMG = (base, level) => Math.round(base * (1 + 0.12 * (level - 1)));
export const LEVEL_XP = (base, level) => Math.round(base * (1 + 0.16 * (level - 1)));
