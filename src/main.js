import { Game } from './core/Game.js';
import { Intro } from './ui/Intro.js';

// ?fresh=1: clean slate for demo recording — new character, quest from the top
if (new URLSearchParams(location.search).get('fresh')) {
  try { localStorage.removeItem('cadle.save'); localStorage.removeItem('cadle.quest'); } catch (e) {}
}

const canvas = document.getElementById('game');

// The cinematic intro IS the loading screen, so it has to be on screen before the world build begins —
// its own setup (textures, room, character) is only ~350 ms, but a system init that blocks the thread for
// 800 ms will happily run first and leave the plain boot splash up for the whole load. The gate below
// holds Game._init until the intro has drawn a frame (or 3 s has passed, so a broken intro never blocks).
const PARAMS = new URLSearchParams(location.search);
const USE_INTRO = PARAMS.get('auto') !== '1' || PARAMS.get('intro') === '1';
let releaseGate = () => {};
const gate = USE_INTRO ? new Promise((r) => { releaseGate = r; }) : null;
if (gate) setTimeout(releaseGate, 3000);

const game = new Game(canvas, gate ? { gate } : {});

// Automation / debug API used by tools/inspect.mjs and critics. Keep stable.
const P = () => game.player;
window.__game = {
  game,
  ready: game.ready.then(() => true),
  stats: () => game.perf.stats(),
  resetStats: () => game.perf.reset(),
  input: game.input,                               // .press(code) .release(code) .move(dx,dy) .button(b,down)
  teleport: (x, y, z) => P().controller.teleport({ x, y: y ?? game.terrain.heightAt(x, z) + 0.1, z }),
  look: (yaw, pitch) => P().view.look(yaw, pitch),
  setHour: (h) => { game.sky.dayLength = 0; game.sky.setHour(h); },
  setQuality: (q) => { location.search = `?auto=1&q=${q}`; },
  state: () => ({ pos: P().position.toArray().map((v) => +v.toFixed(2)), yaw: +P().yaw.toFixed(3), pitch: +P().pitch.toFixed(3), state: P().controller.state, speed: +(P().controller.speed ?? 0).toFixed(2), grounded: P().controller.grounded,
    hp: Math.round(P().health), shield: Math.round(P().shield), alive: P().alive, hour: +game.sky.hour.toFixed(2), fov: +game.camera.fov.toFixed(1),
    weapon: P().weapons.current ? { name: P().weapons.current.name, archetype: P().weapons.current.archetype, ammo: P().weapons.current.ammo, reserve: P().weapons.current.reserve, ads: +(P().weapons.current.ads ?? 0).toFixed(2), reloading: !!P().weapons.current.reloading } : null,
    abilities: P().abilities.list?.map((a) => ({ id: a.id, ready: a.ready, charge: +(a.charge ?? 0).toFixed(2) })), superActive: P().abilities.superActive,
    enemies: game.enemies.list.length, vfx: game.vfx.stats?.(), audio: game.audio.debugCounts }),
  // --- world / time ---
  poi: () => game.terrain.POI,
  // --- combat & enemies ---
  spawn: (type, x, z, opts) => game.enemies.spawn(type, { x, z }, opts),          // e.g. spawn('hound', 5, -10)
  spawnNear: (type, dist = 10, opts) => { const p = P().position, y = P().yaw; return game.enemies.spawn(type, { x: p.x - Math.sin(y) * dist, z: p.z - Math.cos(y) * dist }, opts); },
  lineup: () => game.enemies.lineup?.(),                                           // one of each type in front of the player, passive
  passive: (v = true) => { game.enemies.passive = v; },
  killAll: () => game.enemies.killAll?.(),
  clearEnemies: () => game.enemies.clear?.(),
  dummy: (dist = 10, opts) => { const p = P().position, y = P().yaw; return game.combat.spawnDummy?.({ x: p.x - Math.sin(y) * dist, z: p.z - Math.cos(y) * dist }, opts); },
  // --- player kit ---
  give: (id, slot) => P().weapons.give?.(id, slot),                               // handcannon|autorifle|pulse|shotgun|sniper|fusion
  swap: (i) => P().weapons.swap?.(i),
  reload: () => P().weapons.reload?.(),
  ads: (on) => P().weapons.setAds?.(on),
  ability: (id) => { P().abilities.charge?.(id); return P().abilities.use?.(id); }, // grenade|melee|class|super
  damagePlayer: (n = 30) => P().damage(n, null),
  respawn: () => P().respawn(),
  god: (v = true) => { P().god = v; },
  // --- vfx / postfx / audio ---
  vfxShowcase: () => game.vfx.showcase?.(),
  flash: (c = 0xffffff, s = 0.8, d = 0.3) => game.postfx.flash?.(c, s, d),
  kick: (s = 1) => game.postfx.kick?.(s),
  bypassPostfx: (v = true) => game.postfx.setBypass?.(v),
  audioSelfTest: () => game.audio.selfTest?.(),
  errors: [],
};
window.addEventListener('error', (e) => window.__game.errors.push(String(e.error?.stack || e.message)));
window.addEventListener('unhandledrejection', (e) => window.__game.errors.push(String(e.reason)));

// ---------------------------------------------------------------------------------------------
// Boot. Two paths:
//   players  -> the cinematic intro (src/ui/Intro.js): a guy at his computer, the game on his monitor
//               with the load bar on it, and he gets pulled into the screen when you click.
//   ?auto=1  -> no intro at all (the harness and critics must see exactly what they saw before).
//               ?auto=1&intro=1 runs it anyway and auto-plays the transition 4 s after load, so the
//               intro itself can be inspected; __game.intro.hold() freezes it for screenshots.
const intro = USE_INTRO ? new Intro(game) : null;
window.__game.intro = intro;

if (intro) {
  // the bar: assets fill the first 55 %, the world build the rest. Labels name what is actually happening.
  const BOOT_LABEL = {
    Assets: 'GATHERING AETHER', Sky: 'HANGING THE SKY', Lighting: 'KINDLING THE SUN', Terrain: 'RAISING THE VALE',
    World: 'SEEDING THE MEADOW', Player: 'FORGING YOUR ARMS', Combat: 'FORGING YOUR ARMS', Enemies: 'STIRRING THE WILDS',
    VFX: 'BINDING THE AETHER', Audio: 'TUNING THE WINDS', RPG: 'WRITING YOUR TALE', HUD: 'WRITING YOUR TALE', PostFX: 'THE VALE AWAITS',
  };
  let boot = 0;
  game.events.on('assets:progress', (e) => intro.setProgress(Math.max(boot, 0.55 * (e.loaded ?? e.done ?? 0) / (e.total || 1))));
  game.events.on('boot:progress', (e) => {
    boot = 0.55 + 0.45 * (e.done / e.total);
    intro.setProgress(boot, BOOT_LABEL[e.system] || null);
  });
  intro.init().then(() => intro.firstFrame).then(releaseGate).catch((e) => { console.warn('[intro] disabled:', e?.message || e); intro.skip(); releaseGate(); });
  game.ready.then(() => intro.arm()).catch((e) => { console.error('[boot] world build failed:', e); intro.skip(); });
  // the intro hands the canvas over itself; this only covers the skip/failure path (start() is idempotent)
  intro.finished.then(() => game.ready.then(() => game.start()));
} else {
  // No intro: the boot splash (fed above) stays up until the frame time settles, then fades.
  const splash = document.getElementById('splash');
  game.ready.then(() => {
    // hold the splash until the frame time actually STABILIZES: shader compiles, impostor bakes
    // and texture uploads all land under it instead of as jank in the player's first seconds.
    // (5 consecutive sub-25ms frames, or an 8 s cap so a contended GPU can't hold boot hostage.)
    const t0 = performance.now(); let last = t0, good = 0;
    const settle = () => {
      const now = performance.now(), d = now - last; last = now;
      good = d < 25 ? good + 1 : 0;
      if (good >= 5 || now - t0 > 8000) {
        splash?.classList.add('gone');
        setTimeout(() => splash?.remove(), 900);
      } else requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  });
}

game.ready.catch((e) => { console.error(e); window.__game.errors.push(String(e?.stack || e)); });
if (!intro) game.ready.then(() => game.start());
