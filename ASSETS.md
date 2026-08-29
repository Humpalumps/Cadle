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

## Title screen — `public/assets/ui/menu_vista.jpg` (one 1920x1080 JPG)

The ONE asset that does **not** go through `game.assets`: the title screen (`src/ui/Menu.js`) is on screen
*while* `game.assets` is still preloading the 29 MB main set, so it cannot wait for it. It is preloaded from
`index.html` (`<link rel="preload" as="image" fetchpriority="high">`) and fetched inside the backdrop worker,
so it never queues behind the main thread's world build.

It is **not** generated art. It is a frame of the real game, captured through the same menu camera the live
backdrop later uses (`CAM` in `Menu.js`), which is why the cross-fade from still to live world reads as the
picture waking up instead of a cut. Re-capture it whenever the Vale's look changes:

```
node tools/inspect.mjs --nolock --noready --name vistapose --script tools/scripts/menu-vista.json   --w 1920 --h 1080 --q high --params "menu=1&hold=1"
```

then save the chosen frame as `public/assets/ui/menu_vista.jpg` at quality 88. Capture at 1920x1080 and no
higher: the menu backdrop draws through PostFX, so the frame is already SMAA'd and already graded — it needs
no supersampling, and a 4K pass takes minutes per shot for nothing. Budget: **<= 320 KB**; it is the only
image on the first-load critical path.

Missing or 404? The backdrop draws a procedural sky in the same palette instead and nothing breaks — the
still is an upgrade, never a dependency.

## Landing page — `public/assets/site/` (~2.0 MB, all lazy-loaded)

Screenshots of the running game for cadle.gg. Captured by `tools/scripts/site-gallery.json` (which uses
the per-region camera poses from `tools/scripts/fin/*.json` — those are perpendicular to each region's
bearing on purpose; on the bearing you are standing in the pass road) and converted by the pipeline
documented in `tools/out/_siteimg.py`:

* `<id>-c.jpg` — 900 px, q76. The ten region cards on the rail, shown at ~440 px: covers 2x DPR.
* `<id>-b.jpg` — 1280 px, q72. The full-page BACKDROP the site cross-fades to as you scroll. It is drawn
  behind a scrim, under grain and a vignette, parallaxed and pushed, so detail past this is bandwidth
  rather than quality.
* `<id>.jpg` — 1600 px, q78. The six gallery frames only; these open full-screen in the lightbox.

**None of it is on the critical path**: every one is `loading="lazy"` with explicit width/height. The
only image the landing page blocks on is the hero, which is `assets/ui/menu_vista.jpg` — the same file
the title screen uses, so a visitor who presses Play already has it.

Re-capture whenever the world's look changes:

```
node tools/inspect.mjs --nolock --name sitegal --script tools/scripts/site-gallery.json --w 1920 --h 1080 --q high
python tools/out/_siteimg.py
```

## The brand mark - `public/assets/ui/mark/` (2026-08-29)

The old mark was counter-rotating nested squares and a dot, drawn in inline SVG, and it read as amateur.
The new one is an emblem: an engraved gold double ring with fleur points at the cardinals, four long
tapered spikes on the diagonals, and a cut amethyst at the centre. It reads as a reticle and a crystal at
once, which is what the game is.

Pipeline: `images_generate` (seedream-5-pro, four concepts, picked by eye) -> `images_upscale` 2x
(`VideoGameAssets`, subtle, resemblance 8, creativity -6) for a 4000 px master ->
`images_remove_background` -> `tools/out/logosplit.py`.

`logosplit.py` splits the master into the three layers the animation needs, by RADIUS and HUE - gold has
r > b, the aether violet has b > r, so one test plus two radii is the whole split:

* `ring.webp` the gold ringwork and spikes, `ticks.webp` the four crosshair lozenges, `gem.webp` the
  stone. **All three are cut from ONE square centred on the mark** - cropping each to its own bounding
  box scales them independently, and the stone came out three times too big in the composite.
* `mark-512.webp` / `mark-180.webp` - the whole mark, flat.
* `icon-16/32/48/96/180.png` - **the favicon is the mark itself, downscaled.** A redrawn "simplified
  flat-vector sibling" for 16 px was tried and was exactly the clip art the mark exists to replace. At
  16 px a downscale of the real art still reads as gold points around a violet stone.

The animated build is `.mark3` in `index.html`: the three layers stacked with `position:absolute;inset:0`,
ringwork turning one way, ticks the other, the stone still and breathing. Transform and opacity only.
Use it where the mark is LARGE - the marketing site's top bar takes the flat `icon-96.png`, because at
24 px a rotation is invisible and the three layers are 91 KB for nothing.

## Landing page creatures — `public/assets/site/beasts/` (6 WebP, 295 KB total)

Six creature sprites sit around cadle.gg as props you can shoot off the page (see HANDOVER 6.2). They
are **not** game screenshots and **not** generated art: they are the Tripo studio renders of the real
rigged creature models, the ones on `progress.html` under "creatures", with the background removed.

Pipeline, in order:

1. The renders live in the creature worktree at `tools/out/assetgen/tripo/<name>-hq-render.jpg`, and the
   progress page serves them, so a plain HTTP GET off that dev server is the fastest way to fetch them.
2. **Background removal via Magnific** (`images_remove_background`). A local flood-fill key off the grey
   card gets the silhouette right but leaves the studio contact shadow behind as a grey smear; the tool
   removes both cleanly in one pass.
3. **RE-POSE each one** (`images_generate`, model `seedream-5-pro`, the cut PNG passed as an `image`
   reference, count 2, pick by eye). The Tripo renders are all neutral standing turntable poses, and six
   creatures standing to attention in the margins read as clip art. Each one is re-posed for the thing it
   is going to sit on — the hound SITTING on its haunches looking down over an edge, the golem SITTING
   with its legs hanging over a ledge, the sentinel LEANING its shoulder on an unseen wall with the
   greatsword point-down, the drake PERCHED with its claws over a lip and its head craned down, the moth
   HOVERING tilted forward, the wraith LEANING OUT from behind a corner. The prompt names the pose and
   then forbids the prop: "no ledge, no wall, no ground, no cast shadow, isolated on a plain flat neutral
   mid-grey background". **The prop must never be generated** — the page itself has to be the ledge, or
   the sprite arrives carrying a rock that belongs to no section. Re-run `images_remove_background` on the
   pick.
4. Bake the separation in, and it is NOT the same for all six. Grounded creatures (hound, golem, sentinel,
   drake) get a real contact shadow — silhouette, offset 20 px, blurred 16, alpha 0.55. Airborne ones
   (moth, wraith) get a soft dark HALO instead — same silhouette, no offset, blur 22, alpha 0.62. An
   offset contact shadow under a creature that is hovering is a shadow with no floor, which is exactly the
   defect the art critic caught on the old golem. Tone is baked here too: brightness, saturation, and for
   the two creatures that arrive with no colour of their own (median HSV saturation 0.03 and 0.05 against
   0.23-0.50 for the other four) a 62% blend toward `--aether` #b9a2ff. A blend, never a flat multiply —
   multiplying all the way turns a painted creature into one violet silhouette. A bone-white moth beside a
   heading wins every time otherwise. Save WebP q84.
   **The shadow must be baked, never a CSS `filter: drop-shadow`** — these sprites animate continuously,
   and a filter on an animating element is re-run every frame: six of them took the page's scroll from
   p99 18.5 ms to p99 112 ms with 116 frames over 33 ms. Measured. For the same reason nothing in the
   `.beast` CSS may carry a `filter`; if a creature is too bright, it is re-baked, not filtered.
5. Give every `<img class="beast">` its real `width`/`height`. Without them an absolutely-positioned
   sprite that has not loaded yet has no aspect ratio, and the wraith rendered 1601 px wide across the
   gallery heading.

WebP, not PNG, and each one is exported at its OWN size — that creature's largest rendered
CSS height x 2 for a 2x display, no more (300 px for the hound, 660 for the sentinel). One flat
440 px for all six was simultaneously soft on the two big ones and 60% wasted bytes on the two
that sit above the fold.

An earlier attempt cut creatures straight out of the game using `PostFX._renderSkyMask` (geometry green,
sky magenta — the blob gate's mask, so the alpha is exact). It works and is worth remembering for a
creature with no Tripo render, but it only works for something silhouetted against SKY: on the ground the
terrain is green too, and the flood fill takes the hillside with it.

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

### Region themes (batch 3, 2026-08-22) — one per outer biome, 60 s, ElevenLabs music v2

Named after `BIOMES[id].music`, which is what `audio/music.js` `_themeKey()` looks up (`<music>-theme`). A region
plays its own piece at every hour; only the home bowl still swaps day/night. Crossing a border cross-fades over 2 s.

| file | region | the read |
|---|---|---|
| `wood-theme.mp3` | Whisperwood Deep | celtic harp, low flute, wordless voice, 6/8 |
| `frost-theme.mp3` | Frostveil Tundra | glass bells, sparse piano, cold strings, long tail |
| `choir-theme.mp3` | Celestial Isles | cathedral choir, harp, glass harmonica, majestic |
| `drums-theme.mp3` | Dragon Peaks | taiko, low brass, heroic horn, dry and heavy |
| `forge-theme.mp3` | Infernal Wastes | low toms, struck anvil, brooding brass, airless |
| `convergence-theme.mp3` | The Lost Realm | ceremonial strings, choir, bells, organ pedal |
| `fen-theme.mp3` | Shadowfen | bass clarinet, detuned strings, prepared piano |
| `deep-theme.mp3` | The Sunken Kingdom | muffled strings, harp, soprano, heard through water |
| `void-theme.mp3` | The Void | detuned cello drone, reversed harp, no pulse |

All 192 kbps CBR, 1.44 MB each (~13 MB total). **They put `public/assets/` at ~41 MB, just over the 40 MB
target** — re-encoding to 128 kbps would recover ~4 MB but there is no mp3 encoder on this machine (no ffmpeg;
Pillow only does images). Flagged rather than hidden.

Loop with a short crossfade; duck under combat.

## Batch 3 ground albedos (2026-08-22) — the five procedural floors

`Terrain.ASSET_LAYERS` maps these onto the splat layers that used to be procedural noise, which is why the Isles
read as flat tan with a lattice in it and the Void and the fen read as coloured mud. 1024², JPG q88, and each one
had its low-frequency lighting divided out (Pillow) so the tile repeat does not read as a checkerboard of light.

| file | layer | region |
|---|---|---|
| `tex/celestial_marble.jpg` | 6 stone | Celestial Isles (also the Lost Realm's flagstone, tinted violet) |
| `tex/ash.jpg` | 8 ash | Infernal Wastes |
| `tex/glacier_ice.jpg` | 9 ice | Frostveil Tundra |
| `tex/fen_muck.jpg` | 10 muck | Shadowfen |
| `tex/voidstone.jpg` | 11 voidstone | The Void |

**Calibration note:** the ground-glow masks in `Terrain.js` (`tEmis`, lava fissures / void veins) key off `cB.a`,
the FLOOR TEXTURE'S LUMA. Ash and voidstone sit at median 0.11, so the old 0.30..0.06 ramp lit every pixel and the
Wastes rendered as one flat orange sheet. The bands are now 0.075..0.025 and 0.085..0.032 (the darkest ~10%, i.e.
the cracks between plates). **Re-measure if either texture is replaced.**

## Batch 2 — vegetation / glyphs / concepts

| file | for | notes |
|---|---|---|
| `tex/bark.jpg` | Vegetation trunk material | 2k seamless, vertical ridges + moss |
| `tex/leaf_card.png` | Vegetation canopy leaf cards | 1024 RGBA alpha cutout, lush painterly cluster |
| `tex/glyph-ring-1.jpg`, `tex/glyph-ring-2.jpg` | Props rune rings, VFX sigils, abilities rift | pale-gold line art on black — load as additive map (black = transparent with AdditiveBlending) |

## Models — none. The game is 100% procedural geometry.

Three GLBs (`aetheryte` 38k tris / `column` 31k / `handcannon` 57k, 7.9 MB) were generated in the first
asset batch and **never wired up** — every system had already built the same object procedurally
(`Props.js` `_buildAetheryte`, `weapons/models.js` `BUILDERS`), so `game.assets.model()` was never called
by anything. They still cost a fetch, a synchronous `GLTFLoader.parse` and 5.4 MB of GPU texture upload on
every boot: **688 ms, 52% of the whole asset preload phase, for zero draw calls.** Deleted 2026-08-24
along with `Assets.MODELS`, the model-parse loop and the `model()` accessor.

**If you want a GLB, the bar is: it must be in the frame, and it must beat what code can build.**
There is currently **no GLB in the build at all** — the last one (the old intro character) went when the
cinematic intro was replaced by the title screen. Before asking for a mesh asset, build it procedurally
first; that is the house style (`Props.js` and `weapons/models.js` are both zero-asset).

## Requested / planned next batch
- Tree impostor sheets (octahedral bake happens in-engine — see TECHNIQUES.md #6)
- HUD filigree corners/frames
- Footsteps per surface, reload foley, ability whooshes, ambient wind/bird/cricket loops


## Voice cast — RETIRED 2026-08-23 (quests are written, never spoken)

**Status: no voice assets ship.** The opening quest's five narration clips were deleted along with
the voiced opener when the user decided that quests are READ, not heard. `src/core/Assets.js`
preloads no narration, `src/rpg/` may not call `playVoice`, and `tools/invariants.mjs` fails the
build if either comes back. The words now live in the quest text and the quest log
(`src/rpg/quests/`, `src/ui/Screens.js`).

`public/assets/tex/vale_portrait.jpg` is KEPT — it is a 57 KB character portrait that the written
quest card can still use. Nothing else from the cast survived.

**The rule below is retained deliberately, because it is the expensive lesson, not the feature.**
If voiced story-mode NPCs are ever green-lit: a character's performance NEVER changes. Pin each
speaking character to exactly one generated voice — one voice id, one model, one stability/style
setting — and generate every line for that character in a single batch. Never regenerate one line
with different settings; if a character's voice must change, regenerate EVERY line they have ever
spoken and replace them together. A character whose voice drifts between lines reads as two
characters, and the fix is always a full re-generation, so pinning up front is the cheap path.

Delivery notes worth keeping for that day: ethereal narrators want a low register and an unhurried
read; generate with `audio_tts`, `creations_wait`, then download IMMEDIATELY because the URL tokens
expire; never name trademarked games in an audio prompt.

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

