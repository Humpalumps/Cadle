# Creature pipeline — concept → Tripo GLB → img2threejs → procedural Three.js

**User directives (binding).** (1) A GLB never enters the game at runtime; it is a *structural
reference* that the `img2threejs` skill converts into procedural Three.js code, which is what ships.
(2) The bestiary and the NPCs are the game's weakest art, so **every** monster and NPC goes through
this pipeline, and every future creature is created this way from the start.

## Step 1 — concept image (Magnific `images_generate`)

The concept decides the final style far more than any Tripo setting. A drifted concept produces a
drifted model, and it was caught exactly once by eye (the first drake came out a glossy copper
collectible figurine that clashed with the whole batch), so the recipe below is mandatory.

**Prompt skeleton:**

```
A <creature>, full body, MATTE painterly <base material/colour, DARK where possible>,
<ornate gold filigree / crystal / aether accent on the dark material>,
<one glowing feature, saturated hue, small area>, <silhouette specifics: horns, ruff,
wings, tail, limbs>, three-quarter view, <pose> pose, isolated on a plain flat light-grey
background, painterly-realistic fantasy MMO style, even diffuse lighting, matte surface,
no glossy specular highlights, not a shiny figurine
```

Non-negotiable clauses and why each one is there:

| clause | why |
|---|---|
| `MATTE painterly` + `matte surface` + `no glossy specular highlights` + `not a shiny figurine` | without all four, the model renders as a display-case collectible: mirror sheen, no readable form |
| a **dark** base material | the house style is "ornate gold filigree accents **on dark materials**"; a mid-tone body has nothing for the accent to read against |
| gold filigree / crystal / aether accent | the single strongest style tell shared by every asset in the game |
| one small glowing feature | saturate the COLOUR, cap the AREA — same blob-law logic as the world art |
| `three-quarter view`, `full body`, `isolated on a plain flat light-grey background` | Tripo reconstructs a single view; a cropped, posed or busy-background image loses limbs |
| `floating free with nothing beneath it, NO pedestal, NO plinth, NO base, NO rock, NO stand` — on any creature that hovers, and worth carrying on all of them | the word "statue" (see the ethereal note below) invites a display base, and Tripo models whatever the concept shows: the first fae sprite came back welded to a stone cube. Geometry that is not the creature has to be deleted by hand later, so keep it out of the concept |
| `painterly-realistic fantasy MMO style, even diffuse lighting` | the repo-wide suffix from CLAUDE.md |

Generate `count: 2` and pick by eye against the rest of the batch — one prompt does not reliably
land the style, and the second candidate is cheap.

**Content filter:** slender humanoid figures can trip Tripo's policy check (the fae sprite did).
Re-describe as clearly non-human (round-bodied moth-fae, etc.) rather than fighting the filter.

## Step 2 — Tripo (REST, `$TRIPO_API_KEY`)

Quality settings matter more than expected: the first pass used v3.0 at standard quality and the
result was too coarse to be a useful reference (2.1 MB for a hero landmark). Use:

```
model_version: "v3.1-20260211"
geometry_quality: "detailed"
texture_quality: "detailed"
face_limit: 150000 (hero landmark) | 60000 (creature)
pbr: true, texture: true
```

Same gate re-run at those settings came back 7.2 MB with real fluting and frieze relief. Flow:
`POST /v2/openapi/upload` (multipart) → `POST /v2/openapi/task` (`type: image_to_model`) →
poll `GET /v2/openapi/task/<id>` → download `output.pbr_model` (GLB) and `output.rendered_image`
(preview). Rate limit: a burst of ~10 submissions is fine; beyond that it returns code 2000 with a
`Retry-After`. **Look at every model before converting** — that is where style drift is caught. Do NOT judge it by
`output.rendered_image`: those previews are 12-34 KB thumbnails and upscaling one makes a 58k-tri,
4096-texture asset look like blocky Minecraft geometry. Render the GLB itself:

```
CADLE_SKIP_TREECHECK=1 node tools/inspect.mjs --nolock --name glbshot-<m> --noready   --url "http://127.0.0.1:<port>/tools/out/assetgen/glbview.html?m=<m>&w=1100&h=1100"   --w 1100 --h 1100 --steps '[{"wait":7},{"shot":"m"}]'
```

`tools/out/assetgen/glbview.html` is a dev-only three.js inspector (ACES, PBR environment, soft
shadow catcher, auto-framed camera; `yaw`/`pitch` params to orbit). Geometry can also be checked
without rendering by parsing the GLB's JSON chunk for accessor counts and embedded texture sizes —
a good creature reference lands around 55-60k tris with 4096 maps.

## Step 3 — img2threejs → procedural code

Invoke the `img2threejs` skill on the GLB (its GLB-mediated track: the mesh is a structural baseline,
its topology and materials are never copied). Requirements for a converted creature:

- **Tri budget: 15k at LOD0** (user, 2026-08-26; was 3.5k). 15000 sits inside the skill's "standard"
  tessellation tier (<=60k), so `performanceBudget.targetTriangles: 15000` buys real segment counts
  rather than the low tier. Reach for `geometryDescriptor.decimate` only on a component that is
  genuinely wasteful. The LOD ladder must still fall away hard past LOD0 — 72 enemies can be alive,
  so LOD0 is for the near few.
- keeps the existing `Enemy` contract in `src/enemies/` — per-type procedural poses, walk/attack/
  stagger animation hooks, the same update signature; AI and combat must not change.
- respects the intensity ceilings that `tools/invariants.mjs` greps (enemy emissive is capped; the
  hue-preserving aether cap lives in `src/enemies/materials.js`).
- instanced/pooled as the existing bestiary is; `Enemies.warm()` must still build one of each at boot
  or the first spawn of a type links shaders mid-play.

**Ethereal types are not exceptions.** Tripo has no hologram mode (its only stylize options are lego,
voxel, voronoi, minecraft), so wisp/sprite/wraith/riftling are authored as **opaque statues** —
a robe frozen mid-drift, a jagged void quadruped — and the translucency, rim glow and dissolve are
applied at the material stage in the converted code. The mesh supplies the silhouette; the shader
supplies the ghost. **Caveat learned the hard way:** the words "carved as a statue" also invite a
carved *plinth*. Always pair that framing with the anti-base clause above.

## Batch 1 (2026-08-26)

`wayfinder` (NPC quest giver), `hound`, `sentinel`, `golem`, `drake`, `treant`, `frostwolf`,
`wraith`, `riftling`, `sprite` — GLBs + previews in `tools/out/assetgen/tripo/*-hq.{glb,webp}`,
concepts in `tools/out/assetgen/creatures/`. Remaining solid types for later batches: warden,
skyserpent, wyvern, forgeknight, imp, magmagolem, bogwitch, drowned, leviathan, voidhorror, archon,
icegiant, seraph.

## Machine setup — why every earlier "conversion" was hand-rolled (fixed 2026-08-26)

The img2threejs skill is a **gated, multi-stage pipeline**, not a prompt: local state gate
(`forge/next.py`), pre-spec assessment + quality contract, a **detail inventory** where every
identity-defining detail must map to a `component.localFeatures` or `material.localOverrides` entry
(prose does not count), staged build passes (blockout → structure → form → material → lighting →
interaction → optimization), then review gates — turntable from four azimuths (never one frame),
self-intersection, attachment-anchor, interior-difference, and per-feature fidelity scores with a
bounded correction loop.

**None of that had ever been run.** Builders wrote "img2threejs GLB-mediated track" in a code comment
and hand-assembled primitives, which is why the results captured ~15-20% of their references.

The mechanical cause: **every command in the skill's docs starts with `python3`, and this machine had
no `python3`** — the name resolved to the Microsoft Store stub, which prints "Python was not found"
and exits. The first command a builder copied failed instantly, so they improvised.

Fixed by shimming, not installing (the skill is stdlib-only, Python 3.12.13 was already present as
`python`):

```
C:\Users\ianca\bin\python3.cmd   ->  @echo off / python %*        (cmd + PowerShell)
C:\Users\ianca\bin\python3       ->  #!/bin/sh / exec python "$@"  (Git Bash — .cmd is not executable there)
```
with `C:\Users\ianca\bin` prepended to the **user** PATH. `python` is untouched. Verified: `next.py`,
`new_pre_spec_assessment.py`, `build_detail_inventory.py`, `generate_threejs_factory.py`,
`turntable_gate.py` and `diagnose_render.py` all run, and PIL + numpy are importable for the
optional helpers.

Run skill scripts **from the skill root** (`C:/Users/ianca/.claude/skills/img2threejs`), writing
artifacts into the game repo. `probe_glb.py` on a Tripo GLB returns `referenceReadiness: pass` with
the expected warning that a merged single-mesh asset carries no semantic part boundaries — so
per-region claims need browser ID-mask evidence rather than metadata.
