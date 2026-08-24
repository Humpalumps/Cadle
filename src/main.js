import { WebGLRenderTarget } from 'three';   // scratch target for the boot warm frames
import { createRenderer, compileForComposer, renderForComposer } from './render/Renderer.js';
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
// (it calls the synchronous compile() internally; measured 2x worse, see 43f2837).
//
// THE RENDER TARGET IS NOT OPTIONAL — it is the whole reason this used to warm nothing.
// `outputColorSpace` is the SECOND field of the program cache key (WebGLPrograms.getProgramCacheKeyParameters),
// and getParameters reads it as `currentRenderTarget === null ? renderer.outputColorSpace : workingColorSpace`.
// The game draws through composer.render(), i.e. always INTO a target, so every program it actually uses is
// keyed `srgb-linear`. A compile() with nothing bound builds the `srgb` twin — a real, linked, never-used
// program. Measured 2026-08-23: warming this way left the count 41 HIGHER than not warming at all while the
// real programs still linked during play, worst frame 6502 ms with the page's own CPU idle at 35 ms (an
// ANGLE/D3D11 link blocks inside the GPU process, where neither cpuMs nor gpuMs can see it).
//
// Two further things this must NOT do, both because game.start() is chained on game.ready SEPARATELY from
// this (see below), so the game loop is ALREADY RUNNING and its frames interleave with ours:
//   - never hold a bound target across an `await` — the game's own frame would render into it;
//   - never borrow the composer's buffers — a 4x4 scratch target costs nothing and cannot corrupt them.
// Visibility is restored exactly as found (and note it does not gate compilation at all: three r185 gathers
// LIGHTS with traverseVisible but MATERIALS with a plain scene.traverse — the chunking buys paint time
// between calls, nothing more).
async function warmScene(renderer, scene, camera, perChunk = 6, onProgress = null) {
  const objs = [];
  scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine || o.isSprite) objs.push(o); });
  if (!objs.length) return 0;
  const was = objs.map((o) => o.visible);
  try {
    for (let i = 0; i < objs.length; i += perChunk) {
      for (let k = 0; k < objs.length; k++) objs[k].visible = was[k] && k >= i && k < i + perChunk;
      compileForComposer(renderer, scene, camera);
      onProgress?.(Math.min(1, (i + perChunk) / objs.length));
      await new Promise((r) => requestAnimationFrame(r));
    }
  } finally {
    for (let k = 0; k < objs.length; k++) objs[k].visible = was[k];   // never leave the scene half-hidden
  }
  // One real render, shadows forced. compile() cannot build depth/distance programs AT ALL — getDepthMaterial
  // is only reachable from WebGLShadowMap.render(), which only runs inside renderer.render() — so without
  // this the shadow variants link on the first frame that casts one. Enemies.warm() parks a sleeping spare of
  // every type on the spawn point precisely so this pass has them in frame and inside cascade 0.
  try {
    for (let k = 0; k < objs.length; k++) objs[k].visible = true;
    renderForComposer(renderer, scene, camera);
  } catch (e) { console.warn('[boot] shadow warm skipped:', e?.message); }
  finally {
    for (let k = 0; k < objs.length; k++) objs[k].visible = was[k];
  }
  return objs.length;
}

// Render a few REAL game frames into a scratch target while the loading bar is still moving.
//
// Only the intro path needs this, and it needs it badly. With the intro, game.start() does not run until
// intro.finished, so NOTHING has ever rendered the world when _arm() finally calls stepInto -- and that one
// call linked 35 programs in a MEASURED 6.95 s (introprobe: prog 99 -> 134, arm:enter -> arm:done), with the
// bar sitting pinned at 100% the whole time. That is the "swap happens too late and looks clunky".
// It has to be stepInto and not renderer.compile(): Lighting drives its own shadow cascades from update(),
// so the depth programs only exist once something has actually rendered a shadowed frame (Renderer.js says
// why compile() can never build them). ?auto=1 without the intro does not need this -- there the loop starts
// immediately and ordinary frames do the same work.
async function warmFrames(game, n, onProgress) {
  const rt = new WebGLRenderTarget(320, 180, { depthBuffer: true });
  const sys = [game.sky, game.lighting, game.terrain, game.world, game.player, game.vfx].filter(Boolean);
  try {
    for (let i = 0; i < n; i++) {
      try { game.stepInto(1 / 60, rt, sys, game.camera); }
      catch (e) { console.warn('[boot] warm frame failed:', e?.message); break; }
      onProgress?.((i + 1) / n);
      await new Promise((r) => requestAnimationFrame(r));   // let the loading screen paint between them
    }
  } finally { rt.dispose(); }
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
  // --- rpg: quests, loot, ammo ---
  // EVERY call here returns a SCALAR or plain JSON. Handing a live Enemy/Object3D back to
  // Playwright serialises the whole Three.js graph over CDP and manufactures a phantom multi-second
  // stall that looks exactly like a driver hang (HANDOVER 5.5). tools/questgate.mjs depends on this.
  quest: {
    accept: (id) => !!game.rpg?.quest?.accept?.(id),
    abandon: (id) => !!game.rpg?.quest?.abandon?.(id),
    complete: (id) => !!game.rpg?.quest?.complete?.(id),
    turnIn: (id) => !!game.rpg?.quest?.turnIn?.(id),
    fail: (id) => !!game.rpg?.quest?.fail?.(id),          // escort death path; a failed quest is re-acceptable
    debugTick: (id) => !!game.rpg?.quest?.debugTick?.(id),
    all: () => game.rpg?.quest?.all?.() ?? [],
    offersAt: (region) => game.rpg?.quest?.offersAt?.(region) ?? [],
    state: () => game.rpg?.quest?.state?.() ?? { active: [], completed: [] },
  },
  ammo: () => P().weapons.slots.map((w) => ({ id: w.id, archetype: w.archetype, ammo: w.ammo, magSize: w.magSize, reserve: w.reserve, maxReserve: w.maxReserve })),
  drain: () => { for (const w of P().weapons.slots) { w.ammo = 0; w.reserve = 0; } return true; },   // run every gun dry: the dry-guard test
  loot: () => game.rpg?.activeDrops?.() ?? [],
  dropLoot: (tier, opts) => { game.rpg?.dropLoot?.(P().position, tier, opts); return true; },
  rpgState: () => { const R = game.rpg?.ctx?.rpg; return R ? { level: R.level, xp: R.xp, next: R.next, points: R.points, power: R.stats?.power, currencies: { ...R.currencies } } : null; },
  addXp: (n) => { game.rpg?.addXp?.(n); return game.rpg?.ctx?.rpg?.level ?? 0; },
  setLevel: (n) => {   // jump the curve for band testing; xp-only, never touches gear
    const R = game.rpg?.ctx?.rpg; if (!R) return 0;
    let guard = 0;
    while ((R.level ?? 1) < n && guard++ < 200) game.rpg.addXp(R.next ?? 1000);
    return R.level;
  },
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
  // The bar's last slice is the SHADER WARM, not the system build. It used to read 100% the moment the
  // systems were up and then sit there for a measured 9.6 s while warmScene and _arm() linked 79 more
  // programs. A bar that finishes and then does nothing for ten seconds is the clunk.
  game.events.on('assets:progress', (e) => intro.setProgress(Math.max(boot, 0.50 * (e.loaded ?? e.done ?? 0) / (e.total || 1))));
  game.events.on('boot:progress', (e) => {
    boot = 0.50 + 0.38 * (e.done / e.total);          // systems end at 0.88; 0.88-1.0 is the warm
    intro.setProgress(boot, BOOT_LABEL[e.system] || null);
  });
  // NO compileAsync warmup here. It was tried and measured WORSE, twice: three's compileAsync calls the
  // SYNCHRONOUS compile() internally and only defers the link-completion poll, so it blocks for the whole
  // compile and the first render still compiles whatever it missed. On ?auto=1 q=low it took the boot from
  // 18 stalls / 13.1 s blocked to 26 stalls / 27.9 s, worst single stall 5.5 s -> 13.7 s. Do not re-add it.
  game.ready.then(async () => {
    if (PARAMS.get('nowarm') !== '1') {
      const t0 = performance.now();
      // ORDER MATTERS. warmScene FIRST, then intro.prewarm(): prewarm renders one frame through the menu
      // lens and is the FIRST time the world is ever drawn (nothing draws it before game.start(), which
      // waits for the hand-off), so running it cold links everything itself -- MEASURED 9.5 s cold versus
      // 6.3 s after warmScene, i.e. ~8 s added to the whole boot for nothing. It is a single render, so it
      // cannot be sliced: the loading screen stops for it either way. What this ordering buys is that it
      // stops at ~95% and then finishes, instead of stopping AFTER the bar already read 100% -- which is
      // what made the swap feel late (a full bar sitting there for a measured 9.6 s).
      // prewarm draws to the CANVAS (target null), so it needs the `srgb` program variants -- a different
      // set from the composer's `srgb-linear` ones, which is why warming the game's own path never covered
      // it. See Renderer.js. arm() afterwards costs ~10 ms.
      try { const n = await warmScene(game.renderer, game.scene, game.camera, 6, (f) => intro.setProgress(0.88 + 0.06 * f, 'THE VALE AWAITS'));
        if (game.debug) console.info(`[boot] warmScene ${n} objects in ${Math.round(performance.now() - t0)} ms`); }
      catch (e) { console.warn('[boot] warmScene skipped:', e?.message); }
      await new Promise((r) => requestAnimationFrame(r));
      try { intro.prewarm?.(); } catch (e) { console.warn('[boot] intro prewarm skipped:', e?.message); }
      await warmFrames(game, 2, (f) => intro.setProgress(0.95 + 0.05 * f, 'THE VALE AWAITS'));
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
