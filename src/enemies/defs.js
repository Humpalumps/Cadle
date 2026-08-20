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
    palette: [[0x66d9ff, 0x2a3348], [0xb070ff, 0x2a2640], [0x7cffd8, 0x243838], [0x9fd8ff, 0x2c3250]], glow: 1.1, rim: 0.6, // user decree: wisps must not read as white blobs across the meadow — keep hue, no ACES white-clip
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
    palette: [[0x66d9ff, 0xffffff], [0x7fd8ff, 0xdfe6f0], [0xb070ff, 0xe8dcff]], glow: 1.9, rim: 0.65,
    deathTime: 1.4, xp: 20,
  },
  sentinel: {
    name: 'Spire Sentinel', element: 'arc', role: 'ranged', flying: false, scale: 1.12,
    health: 260, shield: 140, shieldElement: 'arc', damage: 7, speed: 3.6, turn: 3.5, accel: 10,
    perception: 45, fov: 2.6, attackRange: 30, band: [13, 24], attackWindup: 0.75, attackCooldown: 2.6, attackRecover: 0.4, volley: 3, volleyGap: 0.16, standoff: 2.2,
    projectile: { speed: 32, radius: 0.22, element: 'arc', life: 4 },
    strafe: 1, stagger: 0.22, staggerTime: 0.5, shieldRadius: 1.05,
    radius: 0.55, height: 2.7, center: 1.74, weakPoints: [{ bone: 'head', radius: 0.3, mult: 2.0, off: [0, 0.17, 0] }],
    palette: [[0x7fd8ff, 0xffffff], [0xffd27a, 0xfff1d6]], glow: 1.9, rim: 0.55,
    deathTime: 1.6, xp: 45,
  },
  golem: {
    name: 'Stone Golem', element: 'void', role: 'slam', flying: false,
    health: 620, shield: 0, damage: 24, speed: 2.4, turn: 2.2, accel: 6,
    perception: 40, fov: 2.4, attackRange: 4.2, attackWindup: 0.9, attackCooldown: 2.8, attackRecover: 0.6, slamRadius: 5, knockback: 9, standoff: 3.0,
    throwRange: [9, 24], throw: { speed: 22, radius: 0.45, gravity: 14, element: 'kinetic', life: 5, damage: 14, explodeRadius: 2.5 },
    stagger: 0.3, staggerTime: 0.6,
    radius: 0.95, height: 3.3, center: 1.8, weakPoints: [{ bone: 'core', radius: 0.36, mult: 3.0, off: [0, 0, 0.07] }],
    palette: [[0xb070ff, 0xffffff], [0x66d9ff, 0xffffff]], glow: 2.4, rim: 0.45,
    deathTime: 2.0, xp: 90,
  },
  drake: {
    name: 'Ember Drake', element: 'solar', role: 'dive', flying: true, hover: 11,
    health: 420, shield: 90, shieldElement: 'solar', damage: 10, speed: 13, turn: 2.4, accel: 9,
    perception: 70, fov: 6.3, attackRange: 40, orbit: 16, attackWindup: 0.5, attackCooldown: 4.0, attackRecover: 0.8, volley: 3, volleyGap: 0.12, standoff: 2.6,
    projectile: { speed: 34, radius: 0.25, element: 'solar', life: 3.5, explodeRadius: 1.6 },
    stagger: 0.25, staggerTime: 0.5,
    radius: 0.65, height: 1.2, center: 0, weakPoints: [{ bone: 'head', radius: 0.3, mult: 2.0, off: [0, 0.02, 0.12] }],
    palette: [[0xff8a3d, 0xffffff], [0xffb04a, 0xffffff]], glow: 2.3, rim: 0.5,
    deathTime: 1.6, xp: 120,
  },
  warden: {
    name: 'Warden of the Spire', element: 'void', role: 'slam', flying: false, boss: true,
    health: 1800, shield: 500, shieldElement: 'void', damage: 32, speed: 3.4, turn: 2.8, accel: 8,
    perception: 60, fov: 6.3, attackRange: 4.6, attackWindup: 0.8, attackCooldown: 2.4, attackRecover: 0.6, slamRadius: 6, knockback: 11, standoff: 3.2,
    volleyRange: [8, 30], volley: 5, volleyGap: 0.1, volleySpread: 0.35, projectile: { speed: 30, radius: 0.28, element: 'void', life: 4, damage: 11 },
    stagger: 0.4, staggerTime: 0.5, shieldRadius: 1.85, phases: [0.66, 0.33],
    radius: 1.1, height: 3.9, center: 2.1, weakPoints: [{ bone: 'head', radius: 0.42, mult: 1.6, off: [0, 0.26, 0] }, { bone: 'torso', radius: 0.38, mult: 2.2, off: [0, 0.67, 0.39] }],
    palette: [[0xb070ff, 0xffffff]], glow: 2.4, rim: 0.55,
    deathTime: 2.6, xp: 400,
  },
};
export const LEVEL_HP = (base, level) => Math.round(base * (1 + 0.22 * (level - 1)));
export const LEVEL_DMG = (base, level) => Math.round(base * (1 + 0.12 * (level - 1)));
