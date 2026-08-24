import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Assets: central preloader for the generated assets in public/assets/ (see ASSETS.md).   (orchestrator)
 * Everything loads in parallel during Game.init (behind the start screen) so NOTHING streams in mid-game —
 * zero first-use hitches: textures are GPU-uploaded (renderer.initTexture) before play starts.
 *
 * API (all safe when an asset is missing — returns null and the caller keeps its procedural fallback):
 *   game.assets.tex(name)            -> THREE.Texture (sRGB; terrain/bark repeat-wrapped, aniso 8) | null
 *   game.assets.model(name)          -> gltf object {scene, ...} | null. Callers .clone(true) the scene; never mutate the cached original's materials — clone materials too.
 *   game.assets.sfxData(name)        -> ArrayBuffer | null   (raw mp3 bytes; decode via audioBuffer())
 *   game.assets.audioBuffer(ctx, n)  -> Promise<AudioBuffer> (decoded + cached per name)
 *   game.assets.deferred[name]       -> Promise, resolved when a DEFERRED (region-theme) fetch has landed in this.audio
 *   game.assets.progress             -> 0..1;  event 'assets:progress' {loaded, total, item} for the HUD load bar
 *   game.assets.loadMs               -> total preload wall time
 * Texture keys: grass_albedo cliff_strata forest_soil beach_sand snow ruins_stone bark leaf_card glyph1 glyph2
 * Model keys: aetheryte column handcannon
 * SFX keys: shot-handcannon-1..4 shot-autorifle-1..4 shot-sniper-1..4 shot-shotgun-1..4 shot-pulse-1..4 shot-fusion-1..4 explosion-1..4
 * Music keys: field-theme night-theme + one per region: wood frost choir drums forge convergence fen deep void
 */

const TEX = {
  grass_albedo: { url: '/assets/tex/grass_albedo.jpg', repeat: true },
  cliff_strata: { url: '/assets/tex/cliff_strata.jpg', repeat: true },
  forest_soil: { url: '/assets/tex/forest_soil.jpg', repeat: true },
  beach_sand: { url: '/assets/tex/beach_sand.jpg', repeat: true },
  snow: { url: '/assets/tex/snow.jpg', repeat: true },
  ruins_stone: { url: '/assets/tex/ruins_stone.jpg', repeat: true },
  bark: { url: '/assets/tex/bark.jpg', repeat: true },
  leaf_card: { url: '/assets/tex/leaf_card.png', repeat: false },
  glyph1: { url: '/assets/tex/glyph-ring-1.jpg', repeat: false },
  glyph2: { url: '/assets/tex/glyph-ring-2.jpg', repeat: false },
};
const MODELS = {
  aetheryte: '/assets/models/aetheryte.glb',
  column: '/assets/models/column.glb',
  handcannon: '/assets/models/handcannon.glb',
};
const AUDIO = {};
for (const a of ['handcannon', 'autorifle', 'sniper', 'shotgun', 'pulse', 'fusion']) for (let i = 1; i <= 4; i++) AUDIO[`shot-${a}-${i}`] = `/assets/sfx/shot-${a}-${i}.mp3`;
for (let i = 1; i <= 4; i++) AUDIO[`explosion-${i}`] = `/assets/sfx/explosion-${i}.mp3`;
// NO SPOKEN LINES ARE PRELOADED. Quests are written, never spoken (user decision 2026-08-23):
// the five opening-quest narration clips and their mp3s were deleted with the voiced opener, and
// tools/invariants.mjs now fails if anything re-adds them. Story-mode NPC narration may be
// green-lit later; if it is, re-read ASSETS.md "Voice cast" first — a character is pinned to one
// generated performance and every line for them is regenerated together or not at all.
AUDIO['field-theme'] = '/assets/music/field-theme.mp3';
AUDIO['night-theme'] = '/assets/music/night-theme.mp3';
// One theme per region (BIOMES[id].music -> `<music>-theme`). A region does not get the Vale's tune
// re-EQ'd any more — crossing a border swaps the piece, WoW-style. See audio/music.js _themeKey.
// DEFERRED: 1.44 MB apiece = 13 MB of the 44 MB payload, and the nearest of these regions is minutes of
// walking away. They start downloading with everything else (warm long before you need one) but init()
// does NOT await them, so the other 12 systems no longer queue behind music for a place you can't see.
// Safe by construction: music.js _themeKey() plays the Vale theme while a region buffer is absent.
const AUDIO_DEFER = {};
for (const m of ['wood', 'frost', 'choir', 'drums', 'forge', 'convergence', 'fen', 'deep', 'void']) AUDIO_DEFER[`${m}-theme`] = `/assets/music/${m}-theme.mp3`;

export class Assets {
  constructor(game) {
    this.game = game;
    this.textures = {}; this.models = {}; this.audio = {}; this._decoded = {};
    this.deferred = {};   // name -> in-flight fetch for the region themes (not awaited by init; see AUDIO_DEFER)
    this.progress = 0; this.loadMs = 0;
  }

  async init() {
    const t0 = performance.now();
    // one rendered frame — the intro's loading screen is driving rAF, so this is what lets the bar move
    const frame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
    const total = Object.keys(TEX).length + Object.keys(MODELS).length + Object.keys(AUDIO).length;
    let loaded = 0;
    const tick = (item) => { loaded++; this.progress = loaded / total; this.game.events.emit('assets:progress', { loaded, total, item }); };
    const texLoader = new THREE.TextureLoader();
    const gltfLoader = new GLTFLoader();

    const jobs = [];
    for (const [name, cfg] of Object.entries(TEX)) jobs.push(
      texLoader.loadAsync(cfg.url).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
        if (cfg.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
        this.textures[name] = t;
      }).catch((e) => console.warn('[assets] tex missing:', name, e?.message)).finally(() => tick(name)));
    // Models are DOWNLOADED in parallel but PARSED one at a time, with a frame between each.
    // GLTFLoader.parse is synchronous and these are 2.1-2.6 MB apiece; when three of them finished
    // downloading together their parses ran back to back with no frame in between, and the loading bar
    // froze solid for the length of all three. Same total work, but the intro keeps painting through it.
    const modelBytes = Object.entries(MODELS).map(([name, url]) =>
      fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then((buf) => ({ name, buf }))
        .catch((e) => { console.warn('[assets] model missing:', name, e?.message); return { name, buf: null }; }));
    jobs.push((async () => {
      for (const job of modelBytes) {
        const { name, buf } = await job;
        if (buf) {
          await frame();                                  // let the bar move before the next stall
          try { this.models[name] = await gltfLoader.parseAsync(buf, ''); }
          catch (e) { console.warn('[assets] model parse failed:', name, e?.message); }
        }
        tick(name);
      }
    })());
    const grabAudio = (name, url) => fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((b) => { this.audio[name] = b; })
      .catch((e) => console.warn('[assets] audio missing:', name, e?.message));
    for (const [name, url] of Object.entries(AUDIO)) jobs.push(grabAudio(name, url).finally(() => tick(name)));
    await Promise.all(jobs);
    // Region themes start only NOW, after the critical set has landed. Firing them on the same tick still
    // took the boot off the critical path, but it left 13 MB competing for the same six connections as the
    // textures and GLBs that the loading screen is actually waiting on. Nothing awaits these; they are out
    // of the progress total (the bar must reach 1) and Audio._decodeAssets chains each decode onto them.
    for (const [name, url] of Object.entries(AUDIO_DEFER)) this.deferred[name] = grabAudio(name, url);

    // GPU warmup: upload every texture (incl. GLB-embedded) now so first sight of an asset never hitches.
    // Batched with a frame between batches: this is ~11 MB of texture upload and as one unbroken loop it
    // was a single visible freeze right at the end of the asset phase, which is where the bar appeared
    // to hang. The awaits are all still inside init(), so nothing starts playing before the upload is done.
    const R = this.game.renderer;
    const warm = [...Object.values(this.textures)];
    for (const g of Object.values(this.models)) g.scene.traverse((o) => { const m = o.material; if (m?.map) warm.push(m.map); });
    // Sub-progress too: assets:progress is already pegged at 100% by the time the uploads start, so the
    // bar sat at exactly 55% through the whole warmup while hitching. Assets is the first system, so its
    // slot on the bar is done 0 -> 1; reporting a fraction of that keeps the line moving.
    const G = this.game, idx = G.systems ? G.systems.indexOf(this) : -1;
    for (let i = 0; i < warm.length; i += 4) {
      for (let k = i; k < Math.min(i + 4, warm.length); k++) R.initTexture(warm[k]);
      if (idx >= 0) G.events.emit('boot:progress', { done: idx + Math.min(1, (i + 4) / warm.length), total: G.systems.length, system: 'Assets' });
      if (i + 4 < warm.length) await frame();
    }
    this.loadMs = performance.now() - t0;
    if (this.game.debug) console.log(`[assets] ${loaded}/${total} preloaded in ${this.loadMs.toFixed(0)} ms`);
  }

  tex(name) { return this.textures[name] ?? null; }
  model(name) { return this.models[name] ?? null; }
  sfxData(name) { return this.audio[name] ?? null; }
  /** decode (once) into an AudioBuffer; decodeAudioData detaches its input, so feed it a copy */
  audioBuffer(ctx, name) {
    if (this._decoded[name]) return this._decoded[name];
    const raw = this.audio[name];
    if (!raw) return Promise.resolve(null);
    return this._decoded[name] = ctx.decodeAudioData(raw.slice(0)).catch((e) => { console.warn('[assets] decode failed:', name, e?.message); return null; });
  }
}
