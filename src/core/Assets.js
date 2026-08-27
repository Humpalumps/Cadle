import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Assets: central preloader for the generated assets in public/assets/ (see ASSETS.md).   (orchestrator)
 * Everything loads in parallel during Game.init (behind the start screen) so NOTHING streams in mid-game —
 * zero first-use hitches: textures are GPU-uploaded (renderer.initTexture) before play starts.
 *
 * API (all safe when an asset is missing — returns null and the caller keeps its procedural fallback):
 *   game.assets.tex(name)            -> THREE.Texture (sRGB; terrain/bark repeat-wrapped, aniso 8) | null
 *   game.assets.model(name)          -> THREE.Object3D (the loaded gltf.scene, NOT cloned) | null
 *   game.assets.sfxData(name)        -> ArrayBuffer | null   (raw mp3 bytes; decode via audioBuffer())
 *   game.assets.audioBuffer(ctx, n)  -> Promise<AudioBuffer> (decoded + cached per name)
 *   game.assets.deferred[name]       -> Promise, resolved when a DEFERRED (region-theme) fetch has landed in this.audio
 *   game.assets.progress             -> 0..1;  event 'assets:progress' {loaded, total, item} for the HUD load bar
 *   game.assets.loadMs               -> total preload wall time
 * Texture keys: grass_albedo cliff_strata forest_soil beach_sand snow ruins_stone bark leaf_card glyph1 glyph2
 * Model keys (rigged creature GLBs, see docs/CREATURE-PIPELINE.md): hound frostwolf drake treant golem
 *   sentinel sprite wraith riftling warden serpent giant   — src/enemies/glbBody.js consumes these.
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
  // Destiny-2-polish wave batch (2026-08-25): per-region architecture/ground albedos + foliage cards.
  // All seamless (Moisan periodic decomposition, wrap-shift verified). See ASSETS.md batch 4.
  bark_gnarled: { url: '/assets/tex/bark_gnarled.jpg', repeat: true },
  granite_moss: { url: '/assets/tex/granite_moss.jpg', repeat: true },
  marble_strata: { url: '/assets/tex/marble_strata.jpg', repeat: true },
  granite_carved: { url: '/assets/tex/granite_carved.jpg', repeat: true },
  basalt_columnar: { url: '/assets/tex/basalt_columnar.jpg', repeat: true },
  flagstone_violet: { url: '/assets/tex/flagstone_violet.jpg', repeat: true },
  megalith_violet: { url: '/assets/tex/megalith_violet.jpg', repeat: true },
  voidstone: { url: '/assets/tex/voidstone.jpg', repeat: true },
  ice_glacial: { url: '/assets/tex/ice_glacial.jpg', repeat: true },
  snow_sastrugi: { url: '/assets/tex/snow_sastrugi.jpg', repeat: true },
  peat_muck: { url: '/assets/tex/peat_muck.jpg', repeat: true },
  seabed_ripple: { url: '/assets/tex/seabed_ripple.jpg', repeat: true },
  lava_crust: { url: '/assets/tex/lava_crust.jpg', repeat: true },
  ash_basalt: { url: '/assets/tex/ash_basalt.jpg', repeat: true },
  egg_speckle: { url: '/assets/tex/egg_speckle.jpg', repeat: true },
  glove_leather: { url: '/assets/tex/glove_leather.jpg', repeat: true },
  card_conifer_snow: { url: '/assets/tex/card_conifer_snow.png', repeat: false },
  card_fern: { url: '/assets/tex/card_fern.png', repeat: false },
  card_reed: { url: '/assets/tex/card_reed.png', repeat: false },
  card_moss: { url: '/assets/tex/card_moss.png', repeat: false },
  granite_detail: { url: '/assets/tex/granite_detail.jpg', repeat: true },
};
// Rigged creature GLBs (concept -> Tripo generate+animate_rig -> local gltf-transform meshopt/webp -> here;
// docs/CREATURE-PIPELINE.md). One mesh, one material, one primitive each = one draw call; rig-only, no clips.
// Extensions used are EXT_texture_webp + KHR_mesh_quantization, BOTH native to three r185's GLTFLoader —
// do not add a meshopt decoder or a KTX2Loader, nothing here needs one.
// The URLs are spelled out rather than built from the key because tools/invariants.mjs rule (n) matches the
// literal '/assets/creatures/<name>.glb' in code; a template would read as `${name}.glb` and fail the build.
// warden/serpent/giant may not be on disk in every checkout — a missing one warns and stays null, exactly
// like a missing texture, and src/enemies/ keeps its procedural body for that type.
const MODEL = Object.fromEntries([
  '/assets/creatures/hound.glb', '/assets/creatures/frostwolf.glb', '/assets/creatures/drake.glb',
  '/assets/creatures/treant.glb', '/assets/creatures/golem.glb', '/assets/creatures/sentinel.glb',
  '/assets/creatures/sprite.glb', '/assets/creatures/wraith.glb', '/assets/creatures/riftling.glb',
  '/assets/creatures/warden.glb', '/assets/creatures/serpent.glb', '/assets/creatures/giant.glb',
].map((u) => [u.split('/').pop().split('.')[0], u]));

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
    const total = Object.keys(TEX).length + Object.keys(MODEL).length + Object.keys(AUDIO).length;
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
    const grabAudio = (name, url) => fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((b) => { this.audio[name] = b; })
      .catch((e) => console.warn('[assets] audio missing:', name, e?.message));
    for (const [name, url] of Object.entries(AUDIO)) jobs.push(grabAudio(name, url).finally(() => tick(name)));
    // Creature GLBs queued LAST for the same reason the region themes were pushed off the front (below):
    // vite dev is HTTP/1.1, so 12 requests x ~700 KB issued first would sit on the six connections the
    // loading screen's own textures are waiting for. Same total bytes either way — this just keeps the bar
    // moving. They ARE in the critical set (nothing streams mid-game), so init still awaits them.
    for (const [name, url] of Object.entries(MODEL)) jobs.push(
      gltfLoader.loadAsync(url).then((g) => { this.models[name] = g.scene; })
        .catch((e) => console.warn('[assets] model missing:', name, e?.message)).finally(() => tick(name)));
    await Promise.all(jobs);
    // Region themes start only NOW, after the critical set has landed. Firing them on the same tick still
    // took the boot off the critical path, but it left 13 MB competing for the same six connections as the
    // textures that the loading screen is actually waiting on. Nothing awaits these; they are out
    // of the progress total (the bar must reach 1) and Audio._decodeAssets chains each decode onto them.
    for (const [name, url] of Object.entries(AUDIO_DEFER)) this.deferred[name] = grabAudio(name, url);

    // GPU warmup: upload every texture now so first sight of an asset never hitches.
    // Batched with a frame between batches: this is ~6 MB of texture upload and as one unbroken loop it
    // was a single visible freeze right at the end of the asset phase, which is where the bar appeared
    // to hang. The awaits are all still inside init(), so nothing starts playing before the upload is done.
    const R = this.game.renderer;
    // The creature GLBs go through the SAME batched loop, not a loop of their own: 12 models x 3 textures
    // (Color / NormalGL / ORM) is more upload than the whole 2D set, and that is precisely the freeze this
    // batching exists to prevent. A Set because the ORM map is bound twice per material (roughness AND
    // metalness, the standard glTF packing) — uploading it once is enough.
    const warmSet = new Set(Object.values(this.textures));
    for (const scene of Object.values(this.models)) scene.traverse((o) => {
      for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!mat) continue;
        for (const v of Object.values(mat)) if (v?.isTexture) { v.anisotropy = 8; warmSet.add(v); }
      }
    });
    const warm = [...warmSet];
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
  /** the loaded gltf.scene, NOT cloned — clone the scene AND its materials before mutating (ASSETS.md) */
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
