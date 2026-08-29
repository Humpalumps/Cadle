import { Menu } from './ui/Menu.js';   // ~9 KB and imports NOTHING but its own backdrop — see below

// ?fresh=1: clean slate for demo recording — new character, quest from the top
if (new URLSearchParams(location.search).get('fresh')) {
  try { localStorage.removeItem('cadle.save'); localStorage.removeItem('cadle.quest'); } catch (e) {}
}

const canvas = document.getElementById('game');

// LOAD ORDER IS THE WHOLE POINT HERE, AND IT IS STRICTER THAN IT LOOKS.
//
// `Game.js` statically imports the entire game and three itself is ~600 KB to parse. Anything this file
// imports STATICALLY has to be downloaded and parsed before a single line of it runs. The old boot
// imported three and Renderer.js at the top — so even though the intro was "first", it could not start
// until the whole engine had parsed, and the intro then needed its own scene, its own textures and its
// own composer before it drew anything at all.
//
// Now: index.html paints the finished title screen during HTML parse (markup + inline CSS, no JS at
// all), this file's only static import is the menu, which imports nothing heavier than a 200-line
// WebGL2 backdrop, and the engine is pulled in dynamically AFTER the menu is live. The player sees the
// menu essentially at first paint; three, the renderer and the world download behind it.
const PARAMS = new URLSearchParams(location.search);
const USE_MENU = PARAMS.get('auto') !== '1' || PARAMS.get('menu') === '1' || PARAMS.get('intro') === '1';
// ?q= wins; otherwise whatever the player chose in the menu's Settings panel last time.
const QUALITY = ['low', 'medium', 'high'].includes(PARAMS.get('q')) ? PARAMS.get('q')
  : (() => { try { const q = localStorage.getItem('cadle.q'); return ['low', 'medium', 'high'].includes(q) ? q : 'high'; } catch (e) { return 'high'; } })();

window.__game = { errors: [] };          // exists from the first line so early failures are still reported
window.addEventListener('error', (e) => window.__game.errors.push(String(e.error?.stack || e.message)));
window.addEventListener('unhandledrejection', (e) => window.__game.errors.push(String(e.reason)));

// --- 0. start the engine CODE downloading, and do NOT build anything with it -----------------------
// These fetches begin the moment this line runs, on the network thread, while the menu below is wired
// up — so having the code ready costs nothing in wall time and makes Play snappier. It is a download,
// not a boot: no renderer, no Game, no asset preload, no world. (User decision 2026-08-28: landing on
// the page must not start the game loading. Nothing but Play does that — see boot().)
// It also must not be a STATIC import: that would make the engine's parse a precondition for this file
// running at all, which is exactly what used to leave the page dark.
const engine = Promise.all([import('three'), import('./render/Renderer.js'), import('./core/Game.js')]);
engine.catch(() => {});                  // the real handling is inside boot(); this only stops a spurious unhandledrejection

// The engine bindings boot() fills in, and the two things it owns. DECLARED HERE, above the menu:
// `?start` makes menu.init() call play() -> boot() synchronously, and a `let` further down the file is
// still in its temporal dead zone at that point ("Cannot access 'booting' before initialization").
let WebGLRenderTarget, compileForComposer, renderForComposer;
let game = null, booting = null;

// --- 1. the title screen, before the engine exists ------------------------------------------------
// Its backdrop runs in a Web Worker on an OffscreenCanvas, so the world build below — seconds of
// blocking main-thread work — cannot stutter it. ?worker=0 or no OffscreenCanvas falls back in-thread.
const menu = USE_MENU ? new Menu({
  canvas, params: PARAMS,
  seed: Number(PARAMS.get('seed') || 1337),
  auto: PARAMS.get('auto') === '1',
}) : null;
// published here rather than with the rest of the automation API below, which cannot exist until the
// engine has been constructed: tools/gate.mjs calls __game.intro.skip() as soon as the page has a canvas
window.__game.menu = menu;
window.__game.intro = menu;              // alias: the harness has always called it `intro`
if (menu) {
  // BEFORE init(), not after: ?start makes init() call play() synchronously, and play() is what boots.
  // Wiring this afterwards left that path with no handler at all — the loading bar came up and nothing
  // behind it ever started.
  menu.onPlay = () => boot();
  try { await menu.init(); }
  catch (e) { console.warn('[menu] disabled:', e?.message || e); menu.skip(); }
} else {
  document.getElementById('menu')?.remove();          // the harness sees exactly what it always saw
  document.getElementById('menucanvas')?.remove();
}


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
// Only the menu path needs this, and it needs it badly. With the menu, game.start() does not run until
// the hand-off, so NOTHING has ever rendered the world when arm() finally calls stepInto -- and that one
// call linked 35 programs in a MEASURED 6.95 s (introprobe: prog 99 -> 134, arm:enter -> arm:done), with the
// bar sitting pinned at 100% the whole time. That is the "swap happens too late and looks clunky".
// It has to be stepInto and not renderer.compile(): Lighting drives its own shadow cascades from update(),
// so the depth programs only exist once something has actually rendered a shadowed frame (Renderer.js says
// why compile() can never build them). ?auto=1 without the menu does not need this -- there the loop starts
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

// ---------------------------------------------------------------------------------------------
// BOOT — the only thing that builds the world, and the only thing that may.
//
// USER DECISION 2026-08-28: landing on the page must not start the game loading. The title screen is
// idle: no renderer, no Game, no 29 MB asset preload, no terrain bake. All of that begins here, and
// this runs on exactly three triggers:
//   - the player presses Play               (menu.onPlay, below)
//   - the menu is skipped or fails          (menu.finished, below — this is the harness's path)
//   - there is no menu at all (?auto=1)     (called immediately, below)
// Idempotent: every caller gets the same promise.
async function boot() {
  if (booting) return booting;
  booting = (async () => {
  const [THREE, RENDER, GAME] = await engine;
  WebGLRenderTarget = THREE.WebGLRenderTarget;                        // scratch target for the warm frames
  ({ compileForComposer, renderForComposer } = RENDER);
  const renderer = RENDER.createRenderer(canvas, QUALITY);
  game = new GAME.Game(canvas, { renderer, quality: QUALITY });
  menu?.attach(game);

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

if (menu) {
  // the bar: assets fill the first 55 %, the world build the rest. Labels name what is actually happening.
  // One label per system, all thirteen distinct. Two pairs used to share a line (Player/Combat, RPG/HUD),
  // so the phase text stood still through two whole systems and read as a stall. And PostFX no longer
  // says THE VALE AWAITS: that was set at 0.88 and then held through the entire shader warm — a measured
  // 11.6 s of a 36.6 s load, 45 s of 156 s at 4x CPU — so the screen announced the destination during the
  // single longest wait of the load. The warm has its own labels now, below.
  const BOOT_LABEL = {
    Assets: 'GATHERING AETHER', Sky: 'HANGING THE SKY', Lighting: 'KINDLING THE SUN', Terrain: 'RAISING THE VALE',
    World: 'SEEDING THE MEADOW', Player: 'FORGING YOUR ARMS', Combat: 'SIGHTING THE IRONS', Enemies: 'STIRRING THE WILDS',
    VFX: 'BINDING THE AETHER', Audio: 'TUNING THE WINDS', RPG: 'WRITING YOUR TALE', HUD: 'DRAWING THE GLASS',
    PostFX: 'GRADING THE LIGHT',
  };
  // WEIGHTED, NOT EVENLY DIVIDED. The old split was three fixed slabs -- assets 0..0.50, the thirteen
  // systems 0.50..0.88, the shader warm 0.88..1.0 -- so every system was worth the same 2.9 points
  // whatever it cost. Measured, that made 10%->20% take 1 ms and 60%->70% take 12.8 s: half the bar was
  // 15% of the wait. Menu.phases() spends the bar by what each phase cost on the LAST load (persisted to
  // localStorage), so the second launch onwards the bar moves at something close to a constant rate.
  // First-ever load has no record and falls back to equal weights, i.e. exactly where we started.
  // The warm is three phases of its own, not a tail: it is a measured third of the load.
  const SYS = Object.keys(BOOT_LABEL);                      // declaration order IS the boot order
  const PHASES = [...SYS, 'warm', 'prewarm', 'frames'];
  menu.phases(PHASES);
  const WARM_LABEL = { warm: 'COMPILING THE VALE', prewarm: 'COMPILING THE VALE', frames: 'THE VALE AWAITS' };
  const label = (id) => BOOT_LABEL[id] || WARM_LABEL[id] || null;

  game.events.on('assets:progress', (e) =>
    menu.phase('Assets', BOOT_LABEL.Assets, (e.loaded ?? e.done ?? 0) / (e.total || 1)));
  // Game.js emits this AFTER a system's init() resolved, so `e.system` names what just FINISHED. Open the
  // next phase rather than that one: the label then says what is building now instead of what already
  // built, and the phase clock starts at the instant the work does, which is what makes the timings the
  // next load spends the bar by honest.
  game.events.on('boot:progress', (e) => {
    const i = SYS.indexOf(e.system);
    const id = PHASES[i < 0 ? e.done : i + 1] || 'warm';
    menu.phase(id, label(id), 0);
  });
  // NO compileAsync warmup here. It was tried and measured WORSE, twice: three's compileAsync calls the
  // SYNCHRONOUS compile() internally and only defers the link-completion poll, so it blocks for the whole
  // compile and the first render still compiles whatever it missed. On ?auto=1 q=low it took the boot from
  // 18 stalls / 13.1 s blocked to 26 stalls / 27.9 s, worst single stall 5.5 s -> 13.7 s. Do not re-add it.
  game.ready.then(async () => {
    if (PARAMS.get('nowarm') !== '1') {
      const t0 = performance.now();
      // ORDER MATTERS. warmScene FIRST, then menu.prewarm(): prewarm renders one frame through the menu
      // lens and is the FIRST time the world is ever drawn (nothing draws it before game.start(), which
      // waits for the hand-off), so running it cold links everything itself -- MEASURED 9.5 s cold versus
      // 6.3 s after warmScene, i.e. ~8 s added to the whole boot for nothing. It is a single render, so it
      // cannot be sliced: the loading screen stops for it either way. What this ordering buys is that it
      // stops at ~95% and then finishes, instead of stopping AFTER the bar already read 100% -- which is
      // what made the swap feel late (a full bar sitting there for a measured 9.6 s).
      // prewarm draws to the CANVAS (target null), so it needs the `srgb` program variants -- a different
      // set from the composer's `srgb-linear` ones, which is why warming the game's own path never covered
      // it. See Renderer.js. arm() afterwards costs ~10 ms.
      // the warm is a THIRD of the load; it says what it is doing rather than announcing the destination
      try { const n = await warmScene(game.renderer, game.scene, game.camera, 6, (f) => menu.phase('warm', WARM_LABEL.warm, f));
        if (game.debug) console.info(`[boot] warmScene ${n} objects in ${Math.round(performance.now() - t0)} ms`); }
      catch (e) { console.warn('[boot] warmScene skipped:', e?.message); }
      await new Promise((r) => requestAnimationFrame(r));
      // its own phase because it is one synchronous render that measured 6.3 s even after warmScene --
      // announced BEFORE it runs, since nothing can report progress from inside a single draw call
      menu.phase('prewarm', WARM_LABEL.prewarm, 0);
      await new Promise((r) => requestAnimationFrame(r));
      try { menu.prewarm?.(); } catch (e) { console.warn('[boot] menu prewarm skipped:', e?.message); }
      await warmFrames(game, 2, (f) => menu.phase('frames', WARM_LABEL.frames, f));   // now it is true
    }
    menu.arm();
  // fail(), not skip(). A world build that threw leaves nothing to skip INTO -- the old path dropped the
  // player into a dead canvas with no explanation. fail() says so and offers a reload.
  }).catch((e) => { console.error('[boot] world build failed:', e); menu.fail(e); });
} else {
  // No menu (?auto=1): the boot splash stays up until the frame time settles, then fades.
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


// Runs off `ready`, not off `start`: with the title screen the game starts later (at the hand-off), and
// a ?at= link should already be standing in the right region by the time the screen swaps.
game.ready.then(() => { try { spawnParam(); } catch (e) { console.warn('[main] ?at failed', e); } })
  .catch((e) => { console.error(e); window.__game.errors.push(String(e?.stack || e)); });
if (!menu) game.ready.then(() => game.start());
    return game;
  })();
  return booting;
}

// ---------------------------------------------------------------------------------------------
// The three triggers.
//   players  -> the title screen (src/ui/Menu.js). Play builds the world; nothing before it does.
//   ?auto=1  -> no menu at all (the harness and critics must see exactly what they saw before), so boot
//               immediately. ?auto=1&menu=1 runs the menu anyway and auto-plays 4 s in, so the menu
//               itself can be inspected; &hold=1 (or __game.menu.hold()) freezes it for screenshots.
//               ?intro=1 and __game.intro are kept as aliases: tools/gate.mjs and tools/questgate.mjs
//               call __game.intro.skip(), which lands on menu.finished below and boots.
if (menu) {
  // menu.onPlay is wired far above, before init() — see the note there.
  // skip() and the hand-off both resolve `finished`. On the hand-off the menu has already called
  // start(); on skip nothing has, so cover both here — boot() and start() are each idempotent.
  menu.finished.then(() => boot().then((g) => g.ready.then(() => g.start())))
    .catch((e) => console.error('[boot] failed:', e));
} else {
  boot().catch((e) => { console.error('[boot] failed:', e); window.__game.errors.push(String(e?.stack || e)); });
}
