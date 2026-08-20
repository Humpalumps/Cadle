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
| The Vale (narrator) | **PINNED: Magnific voice id 364 — "Sophia Morgan" (ElevenLabs), model eleven_v3, stability 0.6, speed 0.95, similarityBoost default.** Generated 2026-08-20 in one batch. Every future Vale line uses exactly these settings. | ethereal, unhurried, low female register, slight reverb feel; painterly-fantasy narrator, never name trademarked games in prompts | `public/assets/voice/vale-01..04.mp3` |

Registered in `src/core/Assets.js` as `voice-vale-01..04`; `src/rpg/quest.js` plays them at the
quest beats and shows the subtitle regardless, so missing files degrade gracefully.

Line scripts (generate verbatim, one batch):
1. `vale-01` — "Wake, Wayfarer. The Vale remembers you — even if the world does not."
2. `vale-02` — "The Sundered Spire. Aether bleeds where the stone was broken — and something feeds on the wound."
3. `vale-03` — "The wound breathes easier. Take up the arm the Spire kept for you — you have earned its name."
4. `vale-04` — "So armed, so named. Walk the Vale, Wayfarer — it has more to remember."

Generation (Magnific MCP, when connected): `audio_tts` per line with the pinned voice →
`creations_wait` → download IMMEDIATELY (URL tokens expire) → mp3 into `public/assets/voice/` →
fill the voice id into the table above → commit the mp3s.
