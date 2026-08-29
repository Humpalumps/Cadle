# ASSETS.md — generated asset manifest

AI-generated (Magnific MCP), committed locally, loaded at runtime with relative paths only.
Policy: see CLAUDE.md "Non-negotiable conventions". Need something? Put `ASSET ASK: <what>` in your report.

## Payload — 45.0 MB (compression pass 2026-08-29; was 69.9 MB)

| category | before | after | what was done |
|---|---|---|---|
| `tex/` | 30.11 | 17.21 | terrain-only albedos → 512 (Terrain resamples to `_R`=512 anyway); props/vegetation → 1024 q92; other JPG mozjpeg q90 4:2:0; alpha cards alpha-bled + **lossless** PNG; 3 dead files deleted |
| `creatures/` | 17.27 | 13.39 | `WEIGHTS_0` float32→normalized ubyte, `NORMAL` int16→int8, ORM maps 1024→512, redundant keyframes resampled. **No re-mesh, no re-rig, no decimation** |
| `music/` | 18.55 | 12.37 | 192 → 128 kbps CBR, 48 kHz joint stereo (unchanged sample rate/channels/length) |
| `ui/` | 0.92 | 0.86 | alpha-bled + lossless PNG (bit-exact) |
| `sfx/` | 0.94 | 0.94 | untouched — short transient-critical takes, already 128 kbps |
| `intro/` | 0.28 | 0.28 | untouched — it is on the critical path before `game.assets` exists |
| `concepts/` | 1.86 | 0 | **moved to `docs/concepts/`** — source concept art, no runtime consumer; it was shipping to every player |

Everything above is either bit-exact or measured: alpha cards and UI icons are byte-identical in every
pixel with `alpha > 0`; terrain albedos preserve mean luma to <0.05/255 and their dark-decile luma (which
`Terrain.js` glow bands key off) to <0.002; JPEG re-encodes sit at 42–53 dB PSNR.

**The `_R` rule — do not "restore" the terrain albedos to 2k.** `Terrain.js` does
`createImageBitmap(blob, {resizeWidth: R, resizeHeight: R})` with `R = this._R` (512 at q≥medium, 256 at
q=low) on every `ASSET_LAYERS` entry, so anything above 512 in those files is decoded and thrown away
before it reaches the GPU. If `_R` is ever raised, re-export those eight files at the new `_R` first.

Deleted 2026-08-29 (no code path anywhere in `src/` or `index.html`, and not in `Assets.js` `TEX`):
`tex/ash.jpg`, `tex/fen_muck.jpg`, `tex/glacier_ice.jpg` — all three were superseded by
`ash_basalt` / `peat_muck` / `ice_glacial` and left behind. `tex/vale_portrait.jpg` is deliberately kept
(see the Voice cast section).

## Textures — `public/assets/tex/` (seamless-tileable, verified by wrap-shift test)

| file | for | notes |
|---|---|---|
| `grass_albedo.jpg` | Terrain grass splat + Grass.js far-blade/ground color | painterly lush green, top-down |
| `cliff_strata.jpg` | Terrain rock/cliff splat (mountain ring, plateau skirts) | grey strata bands, frontal — use triplanar |
| `forest_soil.jpg` | Terrain forest floor splat | dark soil, roots, moss, leaf bits |
| `beach_sand.jpg` | Terrain shoreline splat | pale golden, subtle ripples, low contrast |
| `snow.jpg` | Terrain mountain-top splat | soft drifts, slight blue recesses |
| `ruins_stone.jpg` | Props ruins / arena / plinth material | sandstone bricks, moss mortar |

### Batch 4 — Destiny-2-polish wave (2026-08-25, all 1536&times;1536 JPG/PNG, seamless via periodic decomposition, wrap-shift verified)

| file | for | notes |
|---|---|---|
| `bark_gnarled.jpg` | Elderheart + Vegetation trunk bark | deep-ridged grey-brown gnarled bark |
| `granite_moss.jpg` | forest elven ruin kit (Props) | grey granite blocks, moss joints — replaces ruins_stone in the forest |
| `marble_strata.jpg` | celestial isle undersides / boulders / colonnade | ivory strata, gold veining |
| `granite_carved.jpg` | Kharaz-Dun dwarven gate (Props) | monumental cool-grey ashlar, chisel detail |
| `basalt_columnar.jpg` | infernal cliffs / cinder cones (Terrain triplanar, Props) | matte black columnar fracture |
| `flagstone_violet.jpg` | Lost Realm ground splat (Terrain layer) | worn dark-violet slabs, faint gold inlay |
| `megalith_violet.jpg` | Convergence spire + 16 monoliths + Hagstone (Props) | violet-slate chiseled face |
| `voidstone.jpg` | void isles / crater walls (Props, Terrain) | near-black purple strata, pale veins |
| `ice_glacial.jpg` | tundra frozen lake sheet (Water/Terrain) | pale blue ice, pressure cracks |
| `snow_sastrugi.jpg` | tundra ground splat (Terrain layer 9 upgrade) | fine wind-streaked snow |
| `peat_muck.jpg` | shadowfen bed + shorelines (Terrain layer 10 upgrade) | near-black olive muck, twigs |
| `seabed_ripple.jpg` | sunken seabed (Terrain layer 4 tint base) | pale golden ripple ridges |
| `lava_crust.jpg` | Water lava surface | orange glow through dark crust — cap emissive per invariants |
| `ash_basalt.jpg` | infernal ground splat (Terrain layer 8 replacement) | black cracked basalt plates + grey ash; mean luma 39/255 — re-tune the cB.a glow bands |
| `egg_speckle.jpg` | dragon nest eggs (Props) | cream + dark speckle |
| `glove_leather.jpg` | first-person viewmodel hands/sleeves (Weapons) | quilted charcoal leather, gold stitch |
| `card_conifer_snow.png` | tundra snow-laden needle cards (Vegetation) | RGBA cutout 1536², snow on boughs |
| `card_fern.png` | forest floor fern clumps (Grass/Vegetation) | RGBA cutout 1536² |
| `card_reed.png` | shadowfen reed clumps (Props/Grass) | RGBA cutout 1248×1872, 2:3 |
| `card_moss.png` | hanging moss drapes on fen snags (Props) | RGBA cutout 1248×1872, 2:3 |

**The alpha cards are alpha-BLED**: every fully-transparent pixel carries the colour of the nearest opaque
one instead of black. This is what stops bilinear filtering and mipmapping from pulling black in around a
cutout edge (dark fringing), and it compresses better for free. Regenerate it with
`alphaBleed()` in `tools/out/assetgen/lib.mjs` after any edit — a card whose transparent region is flat
black will fringe.

**They are LOSSLESS PNG on purpose, and that is why they are 9.4 MB of the 17.2 MB `tex/` budget.**
`sharp`'s `png({effort})`, `png({colours})` and `png({dither})` all silently imply `palette: true`, i.e.
a lossy 256-colour quantisation — that trap cost these cards a real quality regression once already
(33 dB RGB, 44 dB alpha, visible banding + edge fringing on foliage). Lossless PNG here means
`png({compressionLevel: 9, adaptiveFiltering: true})` and nothing else. See the OPEN ASK below for the
fix that makes them both smaller *and* higher quality.

## ~~OPEN ASK~~ — APPLIED 2026-08-29 by the orchestrator. **Payload is 38.05 MB, under the 40 MB budget.**

Both changes are in. Measured after, by walking the tree in bytes (not `du`, which rounds per directory
and reported 44):

| category | MB |
|---|---|
| creatures | 13.39 |
| music | 12.37 |
| tex | 10.22 |
| sfx | 0.94 |
| ui | 0.86 |
| intro | 0.28 |
| **total** | **38.05** |

(a) The five foliage cards now load `.webp` — **9.37 MB of PNG → 2.40 MB**, and quality goes UP (lossless
alpha at 38-41 dB, against 33-39 dB for the palette PNG that was the best same-format option). Keys are
unchanged, so no consumer in Grass/Vegetation/EZTrees/Props/Water was touched. The replaced PNGs are
deleted; originals for reverting are in `tools/out/assetgen/tex-orig/`.
(b) `forest_soil`, `glyph1` and `glyph2` are out of `TEX` — fetched, decoded and GPU-uploaded on every
boot with `assets.tex()` never called for any of them anywhere in `src/` (verified by grep before the
edit). The FILES stay on disk: the rune rings and sigils below still want them, so wiring one up is
re-adding a key, not re-generating art.

VERIFIED after applying, on the running game: `progress 1.0`, `loadMs 5610`, **zero** missing-asset
warnings in the console, zero page errors, and all five cards decode at full resolution
(leaf_card 1024², card_fern 1536², card_reed 1248x1872, card_moss 1248x1872, card_conifer_snow 1536²).
Forest foliage inspected on screen at close range: clean alpha edges, no fringing
(`tools/out/assetboot/shot-forest-cards.png`).

STILL AVAILABLE, NOT TAKEN — a real decision rather than a free win: `EXT_meshopt_compression` would take
`creatures/` from 13.4 MB to ~6 MB, but it needs `setMeshoptDecoder`, which contradicts the standing
"do not add a meshopt decoder or a KTX2Loader" comment in Assets.js. Worth revisiting only if the payload
budget tightens.

**(a) Serve the five alpha cards as WebP — smaller AND better than the PNGs they replace.**
Measured against the originals: WebP q92/alphaQuality 100 gives 38–41 dB RGB PSNR with a *lossless*
alpha channel, where 256-colour PNG gives 33–39 dB with a lossy one. It is 2.38 MB against 9.38 MB
(**−7.0 MB**). Three r185's `TextureLoader` decodes WebP through the normal `<img>` path — no new loader,
no decoder, and the creature GLBs already ship `EXT_texture_webp`, so WebP support is assumed here anyway.

Files are ready in `tools/out/assetgen/cards-webp/`. To apply:
`cp tools/out/assetgen/cards-webp/*.webp public/assets/tex/ && rm public/assets/tex/card_*.png public/assets/tex/leaf_card.png`
then change five URLs (the KEYS do not change, so no consumer in `Grass.js`/`Vegetation.js`/`EZTrees.js`/`Props.js`/`Water.js` needs touching):

```
-  leaf_card:         { url: '/assets/tex/leaf_card.png',         repeat: false },
+  leaf_card:         { url: '/assets/tex/leaf_card.webp',        repeat: false },
-  card_conifer_snow: { url: '/assets/tex/card_conifer_snow.png', repeat: false },
+  card_conifer_snow: { url: '/assets/tex/card_conifer_snow.webp',repeat: false },
-  card_fern:         { url: '/assets/tex/card_fern.png',         repeat: false },
+  card_fern:         { url: '/assets/tex/card_fern.webp',        repeat: false },
-  card_reed:         { url: '/assets/tex/card_reed.png',         repeat: false },
+  card_reed:         { url: '/assets/tex/card_reed.webp',        repeat: false },
-  card_moss:         { url: '/assets/tex/card_moss.png',         repeat: false },
+  card_moss:         { url: '/assets/tex/card_moss.webp',        repeat: false },
```

**(b) Drop three preloaded textures that nothing renders (−2.3 MB).** `forest_soil` (0.95 MB),
`glyph1` (0.68 MB) and `glyph2` (0.63 MB) are fetched, decoded and GPU-uploaded on every boot, and
`game.assets.tex()` is never called with any of those three keys anywhere in `src/` or `index.html`
(`forest_soil` was superseded when the forest floor became a procedural splat layer; the glyph rings were
generated for Props rune rings / VFX sigils and never wired up). They were NOT deleted, because deleting
them while they are still in `TEX` would print `[assets] tex missing:` warnings — remove the three lines
from `TEX` first, then `rm public/assets/tex/{forest_soil.jpg,glyph-ring-1.jpg,glyph-ring-2.jpg}`.
Keep the source art if the rune rings are still wanted; move it to `docs/concepts/` like the rest.

**Not asked for, but the biggest single lever left (−7 MB):** `EXT_meshopt_compression` on the creature
GLBs. Mesh + animation buffers are 9 MB of the 13.4 MB and are currently raw; meshopt would take
`creatures/` to roughly 6 MB. It needs one line — `gltfLoader.setMeshoptDecoder(MeshoptDecoder)` from
`three/addons/libs/meshopt_decoder.module.js` — which contradicts the "do not add a meshopt decoder"
comment in `Assets.js`, so it is a deliberate orchestrator decision, not a builder's call.

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

**All music is now 128 kbps CBR, 48 kHz joint stereo** (was 192 kbps): 0.94 MB per 60 s theme,
12.37 MB total. Sample rate, channel count and duration are unchanged — only the bitrate moved.

There is still no ffmpeg/lame on this machine. The re-encode runs through
`tools/out/assetgen/mp3reenc.mjs`, which uses what *is* installed: Playwright's Chromium decodes the mp3
with `OfflineAudioContext.decodeAudioData` and posts Int16 PCM back to a tiny local node server, and
`@breezystack/lamejs` (pure-JS LAME, a dev-only `--no-save` install) re-encodes it. Use that script rather
than re-deriving the trick; run it against the originals in git, never against an already-re-encoded file
(mp3→mp3 generation loss compounds).

Loop with a short crossfade; duck under combat.

## Batch 3 ground albedos (2026-08-22) — the five procedural floors

`Terrain.ASSET_LAYERS` maps these onto the splat layers that used to be procedural noise, which is why the Isles
read as flat tan with a lattice in it and the Void and the fen read as coloured mud. Each one had its
low-frequency lighting divided out (Pillow) so the tile repeat does not read as a checkerboard of light.
Terrain-only layers now ship at **512² JPG q94** — see "the `_R` rule" at the top: `Terrain.js` resamples
every one of them to `_R` (512) on load, so a bigger file is decoded and discarded.

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

## Creature / NPC GLBs — `public/assets/creatures/` (22 files, 13.39 MB)

Rigged GLBs from the Tripo pipeline (`docs/CREATURE-PIPELINE.md`), consumed by `src/enemies/glbBody.js`
and `Props.js` via `game.assets.model(name)` / `game.assets.clips(name)`. One mesh, one material, one
primitive each. Extensions: `EXT_texture_webp` + `KHR_mesh_quantization`, both native to three r185.

Vertex layout after the 2026-08-29 compression pass — **geometry, topology and rigs are untouched**
(same tri counts, same joints, same clips); only attribute *precision* and the ORM map changed:

| attribute | was | now | why it is safe |
|---|---|---|---|
| `POSITION` | int16 norm | unchanged | already quantised |
| `NORMAL` | int16 norm (6 B) | **int8 norm (3 B)** | ~0.4° max angular error; 8-bit normals are the engine default |
| `TEXCOORD_0` / `JOINTS_0` | uint16 / uint8 | unchanged | already quantised |
| `WEIGHTS_0` | **float32 ×4 (16 B)** | **uint8 norm ×4 (4 B)** | core glTF 2.0 allows it, no extension needed. Largest-remainder rounding keeps each vertex's four weights summing to exactly 255 — an unnormalised set is what makes a skin visibly deflate at a joint, so `tools/out/assetgen/integrity.mjs` asserts the sum |
| ORM map | webp 1024² | webp 512² | occlusion/roughness/metalness is low-frequency and these are seen from ≥3 m. Colour and normal maps stay 1024² |

`WEIGHTS_0` alone was 3.4 MB — 22% of the whole creature payload — because it was the one attribute the
original export left unquantised. Animations were also keyframe-resampled at tolerance 1e-4 (drops keys
that already lie on the interpolation line).

Scripts: `tools/out/assetgen/glb-pass.mjs` (weights + resample), `glb-orm.mjs` (ORM), `glb-normals.mjs`.
**They are three separate processes on purpose** — importing `@gltf-transform/functions` pulls in
`ndarray-pixels`, which reconfigures libvips so that every later `sharp` decode in the same process dies
with `colourspace: parameter space not set`. Do not merge them.

## Batch 2 — vegetation / glyphs / concepts

| file | for | notes |
|---|---|---|
| `tex/bark.jpg` | Vegetation trunk material | 2k seamless, vertical ridges + moss |
| `tex/leaf_card.png` | Vegetation canopy leaf cards | 1024 RGBA alpha cutout, lush painterly cluster |
| `tex/glyph-ring-1.jpg`, `tex/glyph-ring-2.jpg` | Props rune rings, VFX sigils, abilities rift | pale-gold line art on black — load as additive map (black = transparent with AdditiveBlending). **Preloaded but never consumed — see OPEN ASK (b)** |

Concept art for this batch (`waystone.jpg`, `column.jpg`, `handcannon.jpg`, `leaf-card-raw.jpg`) moved
from `public/assets/concepts/` to **`docs/concepts/`** on 2026-08-29. It is pipeline reference, nothing
loads it, and `public/` ships verbatim — it was 1.9 MB of concept art downloaded by every player.
Same rule as `docs/intro-ref/`: art references live in `docs/`, never in `public/`.

## Models — the only mesh assets are the rigged creature GLBs above; world geometry is 100% procedural.

Three GLBs (`waystone` 38k tris / `column` 31k / `handcannon` 57k, 7.9 MB) were generated in the first
asset batch and **never wired up** — every system had already built the same object procedurally
(`Props.js` `_buildWaystone`, `weapons/models.js` `BUILDERS`), so `game.assets.model()` was never called
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

