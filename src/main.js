import { Game } from './core/Game.js';

// ?fresh=1: clean slate for demo recording — new character, quest from the top
if (new URLSearchParams(location.search).get('fresh')) {
  try { localStorage.removeItem('cadle.save'); localStorage.removeItem('cadle.quest'); } catch (e) {}
}

const canvas = document.getElementById('game');
const game = new Game(canvas);

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
  biomes: () => Object.fromEntries(Object.entries(game.terrain.biomePOI ?? {}).map(([k, v]) => [k, v.toArray().map((n) => +n.toFixed(1))])),
  biomeAt: (x, z) => game.terrain.biomeAt(x ?? P().position.x, z ?? P().position.z),
  goto: (id, off = 0) => { const p = game.terrain.biomePOI?.[id] ?? game.terrain.POI?.[id]; if (!p) return null; const k = 1 - off / Math.max(1, Math.hypot(p.x, p.z)); const x = p.x * k, z = p.z * k; P().controller.teleport({ x, y: game.terrain.heightAt(x, z) + 0.6, z }); return [x, z]; },
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
  skyMask: (v = true) => game.postfx.skyMask?.(v),          // gate: magenta = sky (tools/blobcheck.py ignores those pixels)
  audioSelfTest: () => game.audio.selfTest?.(),
  errors: [],
};
window.addEventListener('error', (e) => window.__game.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__game.errors.push(String(e.reason)));

// Boot splash (markup lives inline in index.html so it paints before any JS): feed it asset
// progress, then fade it once the game is running and has actually put frames on screen.
{
  const bar = document.getElementById('splashbar'), msg = document.getElementById('splashmsg'), splash = document.getElementById('splash');
  game.events.on('assets:progress', (e) => {
    if (bar && e?.total) bar.style.width = Math.round((e.done ?? e.loaded ?? 0) / e.total * 100) + '%';
  });
  game.ready.then(() => {
    if (bar) bar.style.width = '100%';
    if (msg) msg.textContent = 'ENTERING THE VALE';
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

// ?at=<biome>[&back=N][&hour=H]: spawn straight into a region instead of the Vale, so a border or a biome can
// be checked from a link. Runs once the world is up, before the first frame, and works with or without auto=1.
// Names are the Biomes.js ids (forest tundra celestial dragon infernal lost shadowfen sunken void) — plus
// 'meadow' for the Vale. `back` is metres short of the landmark (default 150: the landmark in view, not on top
// of you). Unknown name => you simply start where you always did.
function spawnParam() {
  const q = new URLSearchParams(location.search);
  const at = q.get('at'); if (!at) return;
  const hour = q.get('hour'); if (hour != null) window.__game.setHour(+hour);
  if (at === 'meadow' || at === 'vale') return;
  const back = q.get('back') != null ? +q.get('back') : 150;
  const r = window.__game.goto(at, back);
  if (!r) { console.warn(`[main] ?at=${at} is not a biome id`); return; }
  const p = P();
  p.view.look(Math.atan2(-(0 - r[0]), -(0 - r[1])) + Math.PI, -0.03);   // face the region's heart, not the Vale
  game.audio?.update?.(0.5, 0);                                          // settle the bed/theme on the first frame
}

game.ready.then(() => { game.start(); try { spawnParam(); } catch (e) { console.warn('[main] ?at failed', e); } })
  .catch((e) => { console.error(e); window.__game.errors.push(String(e?.stack || e)); });
