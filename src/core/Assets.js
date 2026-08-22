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
// opening-quest voice lines (see ASSETS.md "Voice cast" — ONE pinned voice per character, always)
for (let i = 1; i <= 4; i++) AUDIO[`voice-vale-0${i}`] = `/assets/voice/vale-0${i}.mp3`;
AUDIO['voice-vale-01b'] = '/assets/voice/vale-01b.mp3';   // the marching order that follows the wake line
AUDIO['field-theme'] = '/assets/music/field-theme.mp3';
AUDIO['night-theme'] = '/assets/music/night-theme.mp3';
// One theme per region (BIOMES[id].music -> `<music>-theme`). A region does not get the Vale's tune
// re-EQ'd any more — crossing a border swaps the piece, WoW-style. See audio/music.js _themeKey.
for (const m of ['wood', 'frost', 'choir', 'drums', 'forge', 'convergence', 'fen', 'deep', 'void']) AUDIO[`${m}-theme`] = `/assets/music/${m}-theme.mp3`;

export class Assets {
  constructor(game) {
    this.game = game;
    this.textures = {}; this.models = {}; this.audio = {}; this._decoded = {};
    this.progress = 0; this.loadMs = 0;
  }

  async init() {
    const t0 = performance.now();
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
    for (const [name, url] of Object.entries(MODELS)) jobs.push(
      gltfLoader.loadAsync(url).then((g) => { this.models[name] = g; })
        .catch((e) => console.warn('[assets] model missing:', name, e?.message)).finally(() => tick(name)));
    for (const [name, url] of Object.entries(AUDIO)) jobs.push(
      fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then((b) => { this.audio[name] = b; })
        .catch((e) => console.warn('[assets] audio missing:', name, e?.message)).finally(() => tick(name)));
    await Promise.all(jobs);

    // GPU warmup: upload every texture (incl. GLB-embedded) now so first sight of an asset never hitches
    const R = this.game.renderer;
    for (const t of Object.values(this.textures)) R.initTexture(t);
    for (const g of Object.values(this.models)) g.scene.traverse((o) => { const m = o.material; if (m?.map) R.initTexture(m.map); });
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
