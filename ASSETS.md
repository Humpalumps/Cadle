# ASSETS.md — generated asset manifest

AI-generated (Magnific MCP), committed locally, loaded at runtime with relative paths only.
Policy: see CLAUDE.md "Non-negotiable conventions". Need something? Put `ASSET ASK: <what>` in your report.

## Textures — `public/assets/tex/` (all 2048×2048 JPG, seamless-tileable, verified by wrap-shift test)

| file | for | notes |
|---|---|---|
| `grass_albedo.jpg` | Terrain grass splat + Grass.js far-blade/ground color | painterly lush green, top-down |
| `cliff_strata.jpg` | Terrain rock/cliff splat (mountain ring, plateau skirts) | grey strata bands, frontal — use triplanar |
| `forest_soil.jpg` | Terrain forest floor splat | dark soil, roots, moss, leaf bits |
| `beach_sand.jpg` | Terrain shoreline splat | pale golden, subtle ripples, low contrast |
| `snow.jpg` | Terrain mountain-top splat | soft drifts, slight blue recesses |
| `ruins_stone.jpg` | Props ruins / arena / plinth material | sandstone bricks, moss mortar |

**Usage: `game.assets.tex('<key>')`** (keys = filename without extension; glyphs = `glyph1`/`glyph2`). Preloaded + GPU-uploaded before any system init — never load asset files yourself. sRGB, repeat-wrap, aniso 8 already set (leaf_card/glyphs are clamped). Derive normal/roughness procedurally (height-from-luma or noise) — only albedo is generated. Blend with your procedural detail/macro variation; do not drop macro variation.

## Intro loading screen — `public/assets/intro/` (790 KB total: 7 x 512 px JPG + one model)

The ONE set that does **not** go through `game.assets`: the intro (`src/ui/Intro.js` / `src/ui/intro/stage.js`) is
on screen *while* `game.assets` is still preloading the 29 MB main set, so it loads these itself, in
`stage.js` `loadIntroTextures()`, and hands them to `room.js` / `character.js` as `tex`. Keep the set tiny —
every kilobyte here is dead time before the loading screen can appear — and keep every material's procedural
fallback working, because `tex.<name>` is `null` when a file is missing.

| file | `tex` key | for |
|---|---|---|
| `hoodie_knit.jpg` | `hoodie` | the character's hoodie (map + low-scale bumpMap); charcoal brushed fleece, seamless |
| `chair_leather.jpg` | `leather` | gaming chair upholstery; black quilted leather, violet stitching, seamless |
| `wall_plaster.jpg` | `plaster` | bedroom walls/ceiling; dark grey-violet painted plaster, seamless |
| `wood_floor.jpg` | `wood` | floor planks and the desk top; dark walnut, seamless |
| `rug_indigo.jpg` | `rug` | the rug; deep indigo wool with a gold geometric motif, seamless |
| `poster_crystal.jpg` | `posterCrystal` | portrait wall print (352×528) — aether crystal on a plinth, gold filigree border |
| `poster_ruins.jpg` | `posterRuins` | landscape wall print (528×352) — ruins under an aurora |
| `guy.glb` | — | **the seated character himself** (495 KB, 21k tris). Generated: Magnific `images_generate` (isolated back view, seated, arms forward) -> `models3d_generate` **trellis-2 at resolution 1536** (tripo auto-rigs people into a T-pose and loses the seated pose — trellis keeps it). Then, offline: textures downscaled 2048 -> 896 WebP q78 with `scratchpad/shrink_glb.py` (gltf-transform's own image pipeline is broken on this machine — vips 'colourspace: parameter space not set'), then `npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --simplify true --simplify-error 0.003 --texture-compress false`. 4.53 MB -> 495 KB. Loaded in `stage.js` with `GLTFLoader` + `MeshoptDecoder` (a ~30 KB module bundled from `three/addons`, no side files to host), and `<link rel="preload">`ed from index.html so the fetch starts during HTML parse. |

Tiling textures arrive with `RepeatWrapping`, sRGB and aniso 8 set. They are **shared between modules** —
`clone()` before touching `.repeat`, and dispose your clones.

`guy.glb` IS awaited before the first frame, but with a 900 ms deadline (`Promise.race`): at 495 KB and
preloaded he lands in well under that, and whichever body wins the race is the only one the player ever
sees. Showing the procedural stand-in first and cross-fading read as two different characters popping
between poses. If he misses the deadline the procedural body in `character.js` is used instead. Placement is
`GUY_FIT` in `stage.js` (height/x/y/z/rotY), live-tunable from the harness with `__intro.stage.fitGuy({...})`.
`character.js` still owns the **chair**, the idle timing and the `setSuck` pose hooks.

Art reference (not shipped, dev only): `docs/intro-ref/hoodie-back-ref.jpg` (the character, clean back view),
`docs/intro-ref/desk-back-{1,2}.jpg` (the full shot). Builders judge their work against these.

## SFX — `public/assets/sfx/` (mp3, 4 distinct takes each — round-robin them per shot for natural variation)

| files | event |
|---|---|
| `shot-handcannon-{1..4}.mp3` (2 s) | hand cannon fire — mechanical transient + bark + thump + field tail |
| `shot-autorifle-{1..4}.mp3` (1 s) | auto rifle fire, chains at 600 rpm |
| `shot-sniper-{1..4}.mp3` (3 s) | sniper crack + valley echo |
| `shot-shotgun-{1..4}.mp3` (2 s) | shotgun boom + pump |
| `shot-pulse-{1..4}.mp3` (1 s) | energy rifle arc snap |
| `shot-fusion-{1..4}.mp3` (3 s) | charge whine ~1 s → plasma burst (align discharge with weapon timing) |
| `explosion-{1..4}.mp3` (3 s) | grenade explosion, scale gain by event radius |

Usage (Audio.js): `await game.assets.audioBuffer(ctx, 'shot-handcannon-1')` (decoded + cached; raw bytes preloaded), play through the existing bus/panner chain (reverb send, 3D pan, per-shot ±3% playbackRate jitter on top of the takes). Layer with synthesis where it helps (extra sub-thump, tail). Keep the synth versions as fallback if a buffer hasn't loaded.

## Music — `public/assets/music/`

| file | use |
|---|---|
| `night-theme.mp3` (~2 min) | night ambience music (fade in at night hours) |
| `field-theme.mp3` (~2.5 min) | day exploration theme (regenerating — check file exists) |

Loop with a short crossfade; duck under combat.

## Batch 2 — vegetation / glyphs / concepts

| file | for | notes |
|---|---|---|
| `tex/bark.jpg` | Vegetation trunk material | 2k seamless, vertical ridges + moss |
| `tex/leaf_card.png` | Vegetation canopy leaf cards | 1024 RGBA alpha cutout, lush painterly cluster |
| `tex/glyph-ring-1.jpg`, `tex/glyph-ring-2.jpg` | Props rune rings, VFX sigils, abilities rift | pale-gold line art on black — load as additive map (black = transparent with AdditiveBlending) |
| `concepts/aetheryte.jpg` | source concept | floating crystal + gold filigree (GLB generating) |
| `concepts/column.jpg` | source concept | broken rune column (GLB generating) |
| `concepts/handcannon.jpg` | source concept | ornate gunmetal+gold revolver (GLB generating) |

## Models — `public/assets/models/` (GLB, ~3 MB each, decimated + quantized: handcannon 57k / aetheryte 38k / column 31k tris)

| file | for | notes |
|---|---|---|
| `aetheryte.glb` | Props: THE aetheryte landmark crystal (replace/augment procedural one at (0,-28)) | floating faceted crystal + gold filigree band + orbiting shards; scale to ~12 m tall; add your own emissive boost + rune rings + plinth |
| `column.glb` | Props: Sundered Spire ruins columns (instance several, vary rotation/scale/burial) | broken rune column with gold inlay; register colliders |
| `handcannon.glb` | Weapons: hand cannon viewmodel base | 57k tris, ornate gunmetal+gold revolver; attach muzzle/sight nodes yourself, add emissive accents |

Usage: `game.assets.model('aetheryte')` (already loaded + textures GPU-uploaded) — **clone the scene AND its materials** before mutating (`scene.clone(true)` + clone materials); never edit the cached original. Materials arrive as MeshStandardMaterial — patch with your onBeforeCompile (CSM/fog) as usual; textures are large (up to 4k) — set `texture.anisotropy = 8` and consider `renderer.initTexture` at load to avoid first-view hitch.

## Requested / planned next batch
- Tree impostor sheets (octahedral bake happens in-engine — see TECHNIQUES.md #6)
- HUD filigree corners/frames
- Footsteps per surface, reload foley, ability whooshes, ambient wind/bird/cricket loops
- More GLBs on ASSET ASK (enemy statues, lanterns, monoliths...)


## Voice cast (opening quest — VOICE CONSISTENCY IS BINDING)

**The rule (user decree): a character's voice NEVER changes.** Each speaking character below is
pinned to exactly one ElevenLabs voice. Every line for that character — now and in any future
quest — is generated with the SAME voice id, same model, same stability/style settings, ideally in
one batch. Never regenerate a single line with different settings; if a voice must change,
regenerate EVERY line the character has ever spoken and replace them together.

| Character | Voice (pin on first generation) | Delivery | Files |
|---|---|---|---|
| The Vale (narrator) | **PINNED: Magnific voice id 364 — "Sophia Morgan" (ElevenLabs), model eleven_v3, stability 0.6, speed 0.95, similarityBoost default.** Generated 2026-08-20 in one batch. Every future Vale line uses exactly these settings. | ethereal, unhurried, low female register, slight reverb feel; painterly-fantasy narrator, never name trademarked games in prompts | `public/assets/voice/vale-01..04.mp3`, `vale-01b.mp3` |

Portrait: `public/assets/tex/vale_portrait.jpg` (Magnific text-to-image, 512px, shown on the dialogue card — regenerate only together with a deliberate redesign of the character). Registered in `src/core/Assets.js` as `voice-vale-01..04` + `voice-vale-01b`; `src/rpg/quest.js` plays them at the
quest beats and shows the subtitle regardless, so missing files degrade gracefully.

Line scripts (generate verbatim, one batch):
1. `vale-01` — "Wake, Wayfarer. The Vale remembers you — even if the world does not."
1b. `vale-01b` — "Follow the rising sun — east, across the meadow, until broken stone climbs the sky. The Sundered Spire is where you begin, Wayfarer." (the marching order: the greeting alone left a new player with a tracker and no idea what it meant. Same pinned voice/settings, generated 2026-08-20.)
2. `vale-02` — "The Sundered Spire. Aether bleeds where the stone was broken — and something feeds on the wound."
3. `vale-03` — "The wound breathes easier. Take up the arm the Spire kept for you — you have earned its name."
4. `vale-04` — "So armed, so named. Walk the Vale, Wayfarer — it has more to remember."

Generation (Magnific MCP, when connected): `audio_tts` per line with the pinned voice →
`creations_wait` → download IMMEDIATELY (URL tokens expire) → mp3 into `public/assets/voice/` →
fill the voice id into the table above → commit the mp3s.

## UI item art — `public/assets/ui/items/` (256×256 RGBA PNG, ~720 KB total)

Painted inventory thumbnails, one per weapon archetype and armour slot. Generated 1536² on a flat
studio grey, background cut locally with an edge-connected flood fill (the grey never touches the item
interior), trimmed, padded 5% and packed to 256².

| files | for |
|---|---|
| `handcannon.png`, `autorifle.png`, `pulse.png`, `scout.png`, `shotgun.png`, `sniper.png`, `fusion.png`, `beam.png` | weapon tiles — filename = `item.archetype` |
| `head.png`, `arms.png`, `chest.png`, `legs.png`, `cloak.png` | armour tiles — filename = `item.slot` |

Usage: DOM only (inventory / character screens), `<img src="/assets/ui/items/<key>.png">` via
`art()` in `src/ui/rpgscreens.js`; `Screens._build()` warms them once with `new Image()`. Same
relative-path rule as everything else. A missing file falls back to the drawn SVG silhouette in
`ITEM_ICON`, so the screens never break. Style: dark gunmetal + gold filigree + blue-violet aether,
even diffuse lighting — the house look.
