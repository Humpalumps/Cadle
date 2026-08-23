import { createRenderer } from './render/Renderer.js';
import { Intro } from './ui/Intro.js';
import { IntroHost, canUseIntroWorker } from './ui/IntroHost.js';

// ?fresh=1: clean slate for demo recording — new character, quest from the top
if (new URLSearchParams(location.search).get('fresh')) {
  try { localStorage.removeItem('cadle.save'); localStorage.removeItem('cadle.quest'); } catch (e) {}
}

const canvas = document.getElementById('game');

// LOAD ORDER IS THE WHOLE POINT HERE.
// `Game.js` statically imports the entire game (~530 KB gzipped); importing it at the top of this file
// meant nothing could paint until all of it had downloaded and parsed — on a real connection that is the
// page sitting dark for seconds while the tab title counts to 40%. So: build the renderer here, put the
// intro on screen with it, and only THEN dynamically import Game so its chunk downloads behind the
// loading screen it is supposed to be loading behind.
const PARAMS = new URLSearchParams(location.search);
const USE_INTRO = PARAMS.get('auto') !== '1' || PARAMS.get('intro') === '1';
const QUALITY = ['low', 'medium', 'high'].includes(PARAMS.get('q')) ? PARAMS.get('q') : 'high';

window.__game = { errors: [] };          // exists from the first line so early failures are still reported
window.addEventListener('error', (e) => window.__game.errors.push(String(e.error?.stack || e.message)));
window.addEventListener('unhandledrejection', (e) => window.__game.errors.push(String(e.reason)));

const renderer = createRenderer(canvas, QUALITY);
// The intro runs OFF the main thread when the browser allows it (IntroHost -> intro/introWorker.js), so
// the world build below — seconds of blocking work — cannot stutter the loading screen. Same public API
// either way; ?worker=0 (or a browser without OffscreenCanvas) falls back to the in-thread Intro.
const introOpts = {
  canvas, renderer, params: PARAMS,
  introCanvas: document.getElementById('introcanvas'),
  seed: Number(PARAMS.get('seed') || 1337),
  auto: PARAMS.get('auto') === '1',
};
const USE_WORKER = USE_INTRO && !!introOpts.introCanvas && canUseIntroWorker(PARAMS);
const intro = USE_INTRO ? (USE_WORKER ? new IntroHost(introOpts) : new Intro(introOpts)) : null;
if (!USE_WORKER) introOpts.introCanvas?.remove();

// Compile the world's shader programs a few objects at a time, with a frame between chunks.
//
// The first render of the game scene compiles EVERY program in one blocking call — measured on cadle.gg
// at 16.0 s of frozen page, at the exact moment the bar reads 100%. renderer.compileAsync does not help
// (it calls the synchronous compile() internally; measured 2x worse, see 43f2837). But compile() only
// walks VISIBLE objects, so hiding all but a slice and calling it repeatedly does the same total work in
// slices the loading screen can paint between. Visibility is restored exactly as found.
async function warmScene(renderer, scene, camera, perChunk = 6) {
  const objs = [];
  scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine || o.isSprite) objs.push(o); });
  if (!objs.length) return 0;
  const was = objs.map((o) => o.visible);
  try {
    for (let i = 0; i < objs.length; i += perChunk) {
      for (let k = 0; k < objs.length; k++) objs[k].visible = was[k] && k >= i && k < i + perChunk;
      renderer.compile(scene, camera);
      await new Promise((r) => requestAnimationFrame(r));
    }
  } finally {
    for (let k = 0; k < objs.length; k++) objs[k].visible = was[k];   // never leave the scene half-hidden
  }
  return objs.length;
}

if (intro) {
  intro.init().catch((e) => { console.warn('[intro] disabled:', e?.message || e); intro.skip(); });
  // 8 s cap so a broken intro can never hold the game hostage
  await Promise.race([intro.firstFrame, new Promise((r) => setTimeout(r, 8000))]);
}

const { Game } = await import('./core/Game.js');
const game = new Game(canvas, { renderer });
intro?.attach(game);

// Automation / debug API used by tools/inspect.mjs and critics. Keep stable.
const P = () => game.player;
Object.assign(window.__game, {
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
});

// ---------------------------------------------------------------------------------------------
// Boot. Two paths:
//   players  -> the cinematic intro (src/ui/Intro.js): a guy at his computer, the game on his monitor
//               with the load bar on it, and he gets pulled into the screen when you click.
//   ?auto=1  -> no intro at all (the harness and critics must see exactly what they saw before).
//               ?auto=1&intro=1 runs it anyway and auto-plays the transition 4 s after load, so the
//               intro itself can be inspected; __game.intro.hold() freezes it for screenshots.
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
  // NO compileAsync warmup here. It was tried and measured WORSE, twice: three's compileAsync calls the
  // SYNCHRONOUS compile() internally and only defers the link-completion poll, so it blocks for the whole
  // compile and the first render still compiles whatever it missed. On ?auto=1 q=low it took the boot from
  // 18 stalls / 13.1 s blocked to 26 stalls / 27.9 s, worst single stall 5.5 s -> 13.7 s. Do not re-add it.
  // The monitor shows the REAL game: once terrain and sky exist there is something worth looking at, so
  // start shipping frames of the game canvas onto his screen. Off-thread intro means this cannot stutter
  // the room; when the main thread blocks, the monitor just holds its last frame.
  if (intro.startMonitor) {
    game.events.on('boot:progress', (e) => { if (e.done >= 4) intro.startMonitor(120); });
  }
  game.ready.then(async () => {
    if (PARAMS.get('nowarm') !== '1') {
      const t0 = performance.now();
      try { const n = await warmScene(game.renderer, game.scene, game.camera);
        if (game.debug) console.info(`[boot] warmScene ${n} objects in ${Math.round(performance.now() - t0)} ms`); }
      catch (e) { console.warn('[boot] warmScene skipped:', e?.message); }
    }
    intro.arm();
  }).catch((e) => { console.error('[boot] world build failed:', e); intro.skip(); });
  // the intro hands the canvas over itself; this only covers the skip/failure path (start() is idempotent)
  intro.finished.then(() => game.ready.then(() => game.start()));
} else {
  // No intro: the boot splash (fed above) stays up until the frame time settles, then fades.
  const splash = document.getElementById('splash');
  game.ready.then(async () => {
    if (PARAMS.get('nowarm') !== '1') {
      const t0 = performance.now();
      try { const n = await warmScene(game.renderer, game.scene, game.camera);
        if (game.debug) console.info(`[boot] warmScene ${n} objects in ${Math.round(performance.now() - t0)} ms`); }
      catch (e) { console.warn('[boot] warmScene skipped:', e?.message); }
    }
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


// Runs off `ready`, not off `start`: with the cinematic intro the game starts later (intro.finished), and a
// ?at= link should already be standing in the right region by the time the monitor hands over.
game.ready.then(() => { try { spawnParam(); } catch (e) { console.warn('[main] ?at failed', e); } })
  .catch((e) => { console.error(e); window.__game.errors.push(String(e?.stack || e)); });
if (!intro) game.ready.then(() => game.start());
