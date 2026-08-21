/**
 * Weapon archetype definitions (Destiny 2 numbers as the reference). Units: seconds, radians, meters, damage per hit.
 *  fireMode: 'auto' (hold = rpm cadence; semi-autos also repeat when held so the harness can test them), 'burst' (3-round), 'charge' (fusion)
 *  spread: hip/ads base cone, bloom per shot, decay per second. kick: camera kick (view.kick) + viewmodel recoil spring impulses.
 *  hip/sprint: viewmodel pose (camera space, gun origin = grip top). adsZ: distance of the sight from the eye when aiming.
 */
export const ELEMENT_COLORS = { kinetic: 0xffe9c4, solar: 0xff8a3d, arc: 0x7fd8ff, void: 0xb070ff, stasis: 0x9fd8ff, strand: 0x7cff9c };

export const DEFS = {
  handcannon: {
    id: 'handcannon', name: 'Dawnbreak Verdict', archetype: 'handcannon', element: 'kinetic', rarity: 'legendary',
    fireMode: 'auto', rpm: 140, damage: 70, critMult: 1.8, range: 40, magSize: 10, reserve: 60, maxReserve: 110, reloadTime: 1.9, reloadStyle: 'cylinder',
    spread: { hip: 0.008, ads: 0.0015, bloom: 0.010, decay: 5 },
    kick: { pitch: 0.026, yaw: 0.006, vz: 1.6, vx: 9.0, roll: 3.0, yawV: 1.2, k: 190, c: 16 }, shake: 0.35,
    hip: { pos: [0.16, -0.13, -0.31], rot: [0.02, 0.08, 0.03] }, sprint: { pos: [0.17, -0.17, -0.33], rot: [-0.45, 0.32, 0.25] }, adsZ: 0.50, zoom: 1.3,
    bob: 1.0, swapTime: 0.36,
  },
  autorifle: {
    id: 'autorifle', name: 'Stormwright', archetype: 'autorifle', element: 'arc', rarity: 'legendary',
    fireMode: 'auto', rpm: 600, damage: 16, critMult: 1.6, range: 30, magSize: 36, reserve: 216, maxReserve: 300, reloadTime: 1.7, reloadStyle: 'mag',
    spread: { hip: 0.014, ads: 0.004, bloom: 0.0025, decay: 9 },
    kick: { pitch: 0.0045, yaw: 0.0035, vz: 0.45, vx: 2.2, roll: 1.0, yawV: 0.6, k: 320, c: 24, pattern: true }, shake: 0.08,
    hip: { pos: [0.17, -0.15, -0.36], rot: [0.02, 0.08, 0.02] }, sprint: { pos: [0.17, -0.19, -0.36], rot: [-0.45, 0.35, 0.3] }, adsZ: 0.36, zoom: 1.25,
    bob: 1.0, swapTime: 0.42,
  },
  pulse: {
    id: 'pulse', name: 'Triune Litany', archetype: 'pulse', element: 'void', rarity: 'legendary',
    fireMode: 'burst', rpm: 340, burst: 3, burstInterval: 0.06, damage: 22, critMult: 1.7, range: 45, magSize: 33, reserve: 165, maxReserve: 264, reloadTime: 1.8, reloadStyle: 'mag',
    spread: { hip: 0.011, ads: 0.003, bloom: 0.003, decay: 8 },
    kick: { pitch: 0.0055, yaw: 0.003, vz: 0.5, vx: 2.6, roll: 1.0, yawV: 0.5, k: 330, c: 24 }, shake: 0.1,
    hip: { pos: [0.17, -0.15, -0.38], rot: [0.02, 0.08, 0.02] }, sprint: { pos: [0.17, -0.19, -0.38], rot: [-0.45, 0.35, 0.3] }, adsZ: 0.36, zoom: 1.4,
    bob: 1.0, swapTime: 0.42,
  },
  shotgun: {
    id: 'shotgun', name: 'Hollow Crown Cantor', archetype: 'shotgun', element: 'solar', rarity: 'legendary',
    fireMode: 'auto', rpm: 65, pellets: 12, damage: 14, critMult: 1.3, range: 12, magSize: 6, reserve: 24, maxReserve: 42, reloadTime: 2.4, reloadStyle: 'pump',
    spread: { hip: 0.045, ads: 0.035, bloom: 0.0, decay: 5 },
    kick: { pitch: 0.04, yaw: 0.008, vz: 2.4, vx: 12.0, roll: 4.0, yawV: 1.5, k: 170, c: 15 }, shake: 0.6,
    hip: { pos: [0.18, -0.15, -0.35], rot: [0.02, 0.08, 0.02] }, sprint: { pos: [0.18, -0.19, -0.35], rot: [-0.45, 0.35, 0.3] }, adsZ: 0.46, zoom: 1.15,
    bob: 1.1, swapTime: 0.45,
  },
  sniper: {
    id: 'sniper', name: 'Aetherlance', archetype: 'sniper', element: 'solar', rarity: 'legendary',
    fireMode: 'auto', rpm: 72, damage: 165, critMult: 2.6, range: 200, magSize: 4, reserve: 20, maxReserve: 28, reloadTime: 2.3, reloadStyle: 'bolt',
    spread: { hip: 0.03, ads: 0.0, bloom: 0.0, decay: 5 },
    kick: { pitch: 0.032, yaw: 0.01, vz: 2.0, vx: 10.0, roll: 3.0, yawV: 1.2, k: 150, c: 14 }, shake: 0.5,
    hip: { pos: [0.18, -0.16, -0.38], rot: [0.02, 0.08, 0.02] }, sprint: { pos: [0.18, -0.2, -0.38], rot: [-0.45, 0.35, 0.3] }, adsZ: 0.30, zoom: 4.0, hideOnAds: true,
    bob: 1.1, swapTime: 0.5,
  },
  fusion: {
    id: 'fusion', name: 'Coil of Halone', archetype: 'fusion', element: 'void', rarity: 'legendary',
    fireMode: 'charge', chargeTime: 0.74, bolts: 7, boltInterval: 0.034, rpm: 0, damage: 36, critMult: 1.4, range: 28, magSize: 5, reserve: 25, maxReserve: 30, reloadTime: 2.0, reloadStyle: 'cell',
    spread: { hip: 0.016, ads: 0.010, bloom: 0.002, decay: 8 },
    kick: { pitch: 0.006, yaw: 0.004, vz: 0.5, vx: 2.5, roll: 1.5, yawV: 0.8, k: 260, c: 20 }, shake: 0.12,
    hip: { pos: [0.17, -0.15, -0.36], rot: [0.02, 0.08, 0.02] }, sprint: { pos: [0.17, -0.19, -0.36], rot: [-0.45, 0.35, 0.3] }, adsZ: 0.42, zoom: 1.3,
    bob: 1.0, swapTime: 0.45,
  },
  // ---- imported from the Aurelen build (C:/Users/ianca/Desktop/FPS, src/combat/defs.js). Those two
  // archetypes had no counterpart here, so they are the ones worth carrying over; the tuning is the
  // original's intent (scout = 200 rpm 2.0x precision marksman, beam = 0.55 s charge piercing lance)
  // restated in this file's schema, and the models are rebuilt from scratch in the house language.
  scout: {
    id: 'scout', name: 'Pale Verse', archetype: 'scout', element: 'void', rarity: 'legendary',
    fireMode: 'auto', rpm: 200, damage: 30, critMult: 2.0, range: 80, magSize: 14, reserve: 126, maxReserve: 182, reloadTime: 1.9, reloadStyle: 'mag',
    spread: { hip: 0.0105, ads: 0.0012, bloom: 0.0055, decay: 7 },
    kick: { pitch: 0.016, yaw: 0.0042, vz: 1.05, vx: 5.6, roll: 1.8, yawV: 0.8, k: 245, c: 19 }, shake: 0.20,
    hip: { pos: [0.17, -0.15, -0.38], rot: [0.02, 0.08, 0.02] }, sprint: { pos: [0.17, -0.19, -0.38], rot: [-0.45, 0.35, 0.3] }, adsZ: 0.34, zoom: 1.9,
    bob: 1.0, swapTime: 0.44,
  },
  beam: {
    id: 'beam', name: 'Rimecaller', archetype: 'beam', element: 'stasis', rarity: 'legendary',
    fireMode: 'charge', chargeTime: 0.55, bolts: 1, boltInterval: 0, rpm: 0, damage: 132, critMult: 1.9, range: 120, magSize: 5, reserve: 18, maxReserve: 26, reloadTime: 2.6, reloadStyle: 'cell',
    pierce: true,                                    // the lance goes THROUGH the line (Combat.hitscan supports it)
    spread: { hip: 0.014, ads: 0.0, bloom: 0.0, decay: 8 },
    kick: { pitch: 0.038, yaw: 0.008, vz: 2.6, vx: 11.0, roll: 3.2, yawV: 1.2, k: 160, c: 14 }, shake: 0.55,
    hip: { pos: [0.18, -0.16, -0.36], rot: [0.02, 0.08, 0.02] }, sprint: { pos: [0.18, -0.20, -0.36], rot: [-0.45, 0.35, 0.3] }, adsZ: 0.40, zoom: 1.6,
    bob: 1.1, swapTime: 0.50,
  },
};
export const DEFAULT_SLOTS = ['handcannon', 'autorifle', 'sniper'];   // starting kit: pistol, rifle, sniper (user call)
