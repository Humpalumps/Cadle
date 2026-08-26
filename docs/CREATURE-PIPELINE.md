# Creature pipeline — concept → Tripo GLB → img2threejs → procedural Three.js

**User directives (binding).** (1) A GLB never enters the game at runtime; it is a *structural
reference* that the `img2threejs` skill converts into procedural Three.js code, which is what ships.
(2) The bestiary and the NPCs are the game's weakest art, so **every** monster and NPC goes through
this pipeline, and every future creature is created this way from the start.

## ROUTE CHANGE 2026-08-26 — MONSTERS ARE RIGGED GLBs, ARCHITECTURE STAYS PROCEDURAL

The user's call, after seeing what procedural reconstruction actually produced ("those models are
terrible ... they aren't even close to the glb sample"). Both halves of this are deliberate:

**Monsters: concept -> Tripo GLB -> Tripo RIG -> local optimize -> load through `game.assets`.**
**Architecture: unchanged, procedural** — parametric mouldings, exact repetition and the ornament
library genuinely win across ten landmarks, and there is no reference mesh for most of them anyway.

### Why the old "no GLB at runtime" rule did not survive contact

It was written after `guy.glb` shipped with `skinCount 0` — one rigid mesh, so the intro's two-bone
IK arms and breathing idle were dead code while it was on screen. That is an **animation** failure,
not a performance one. Once a vertex buffer is on the GPU it costs exactly what procedurally
generated geometry costs; the GPU cannot tell how it was authored. `tools/invariants.mjs` rule (n) is
therefore amended rather than deleted: rigged creature GLBs under `/assets/creatures/` referenced
from `Assets.js` or `src/enemies/` are allowed, everything else still fails the build.

### The route, with the gotchas that cost real time

1. **Generate** — `image_to_model`, `model_version: v3.1-20260211`, `geometry_quality: detailed`,
   `texture_quality: detailed`, `face_limit` 60000. (Concept rules unchanged, see above.)
2. **Pre-rig check** — `type: animate_prerigcheck`. Returns `riggable` and a `rig_type`. The hound
   came back `{riggable: true, rig_type: quadruped, topology: quadruped}`.
3. **Rig** — `type: animate_rig`, `rig_type` from step 2, `out_format: glb`, and
   **`model_version: v2.0-20250506` or newer**. **THE DEFAULT RIG VERSION FAILS.** Omitting
   `model_version` selects `v1.0-20240301`, which returns `error_code 1004` with zero credits
   consumed — it looks like the model is unriggable when it is not. Passing a newer version resolves
   to `v2.5-20260210` and succeeds. Result: 103 nodes, an `Armature` skin, **101 joints**, no warnings.
4. **Optimize locally — never a web service.** `@gltf-transform/cli` (v4.4.2) is the same library the
   online GLB optimisers are built on; the compression comes from open codecs (meshopt, Draco, KTX2/
   Basis), so the ratios are identical and a third-party upload buys nothing. Use **meshopt** for
   geometry (decodes far faster than Draco, and download size is not a constraint — the user ships
   via a loading screen or a Steam package) and **KTX2/Basis** for textures, which is the real win:
   GPU-compressed textures stay compressed in VRAM, ~4-8x smaller than a decoded JPEG. Three already
   ships `meshopt_decoder`, `meshopt_simplifier`, `DRACOLoader` and `KTX2Loader`.
5. **Load through `game.assets`** like every other asset — preloaded behind the start screen, never
   streamed mid-game.

### The bone plan — keeping 101 joints from becoming a crowd problem

Tripo rigs to ~101 joints. A shipped crowd enemy usually runs 20-40. What actually costs, in order:

1. **CPU: `Skeleton.update()` + the bone hierarchy's `updateMatrixWorld`.** This is the dominant term
   and it is per-bone, per-skeleton, per-frame: 50 monsters x 101 joints is ~5,000 matrix
   compositions a frame before a single triangle is drawn.
2. **Draw calls.** Three cannot GPU-instance skinned meshes, so 50 animated monsters is 50 calls
   minimum (plus shadow casters). Affordable inside 350 — but it means one material per creature,
   not three.
3. **Bone texture uploads.** 101 joints is 404 texels, a 32x32 DataTexture per mesh. Genuinely minor;
   do not optimise this first.

**The plan, in the order it should be done:**

- **Prune the skeleton to ~30 joints.** Fingers, toes and facial bones drive nothing readable on a
  crowd enemy at combat range. Collapse each removed joint's skin weights into its parent (a
  `gltf-transform` script, not a manual edit) and keep: root, hips, spine x2-3, neck, head, jaw if it
  is used, and per-limb shoulder/elbow/wrist + hip/knee/ankle, plus the tail chain the silhouette
  actually needs. **Target 25-35.** This is a ~3x cut in term 1 for zero visible loss.
- **Rate-limit skeleton updates by distance.** Near enemies pose every frame; mid every 2nd; far
  every 4th-6th. The pose is interpolated by the existing animate hooks, so a stale frame is
  invisible past ~25 m. This is the single cheapest large win and it compounds with the prune.
- **Rigid LOD past the point skinning stops reading.** Beyond ~40 m an enemy does not need skinning
  at all — a rigid posed mesh (or the existing impostor tier) removes the skeleton from the budget
  entirely. Our LOD ladder already exists; this is a tier assignment, not new machinery.
- **One material per creature** so the 50-call floor does not become 150.

**Then measure, do not assume.** The acceptance run is 50 alive in a real camp fight, reporting draw
calls, `cpuMs`, and the per-system Enemies slice — not a meadow with three wisps. That is the same
`hitchhunt --route combat` the deferred perf pass owes; the bone work is the one part of that pass
worth doing early, because it is cheaper to prune a skeleton once at conversion time than to retrofit
13 creatures later.

### What this does NOT change

Tri budgets, the draw-call rules, the blob decree, `Enemies.warm()`, and the three-distance
acceptance test (200 m silhouette / 40 m ornament / 8 m material) all still apply. A rigged GLB that
reads as plastic at 8 m is just as dead as a procedural one.

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

### What the triangle budget buys you, and what it never will

A recurring misunderstanding, and the direct cause of the greybox landmarks and slab creatures:
**the budget is a ceiling and a tier selector. It does not create form.**

**Automatic — do NOT hand-tune these.** `performanceBudget.targetTriangles` selects the generator's
tessellation tier, which sets radial/height segment counts on every primitive that has them. Declaring
10000/15000 puts you in the *standard* tier and limbs stop faceting on their own. Writing "16 radial
segments" into a spec by hand is redundant at best and fights the tier at worst.

**Never automatic — these must be authored as components, or they simply will not exist:**

| the thing | why tessellation cannot produce it |
|---|---|
| **chamfers / bevels on hard edges** | subdividing a box gives you a box with more triangles on flat faces; the 90 deg edge stays razor-sharp at any tier. This is the loudest greybox tell and it is a *modelling* decision, full stop. |
| carved relief, flutes, dentils, coffers | these are geometry that is not in the base primitive at all |
| silhouette parts — horns, claws, jaw, ears, spines, cloth folds | a smoother cylinder is still a cylinder |
| where the detail concentrates | tiers tessellate fairly evenly; a creature wants its triangles on the head and hands, which is a per-component decision |
| `flatShading` and normal handling | `flatShading: true` makes a 20k model look like a 2k one. Smooth-shade organic forms; reserve flat shading for genuinely faceted crystal |
| material truth — veining, roughness break-up, dirt in recesses, metal that is metal | not geometry at all |

This is exactly why the pipeline has a **detail inventory** and why it refuses prose: every
identity-defining feature must resolve to a `component.localFeatures` or `material.localOverrides`
entry. If a feature is not in the inventory, no triangle budget will conjure it.

**The practical rule:** declare the budget, let the tier handle smoothness, and spend your actual
effort enumerating the inventory — then check the 8 m frame, which is where missing chamfers and
missing material announce themselves.

### AAA *and* cheap — the cost model, measured on this build

**Measured 2026-08-26, live:** empty meadow 179 draw calls / 1.85 M tris. Spawn **ten treants** and it
goes to **338 calls** — about **16 draw calls per creature**, for a body whose geometry is only ~2,300
triangles. Ten creatures ate 45% of the entire 350-call budget while contributing almost nothing in
vertex cost.

That is the whole lesson: **our creatures are currently optimised in exactly the wrong direction.**
They are starved of triangles and extravagant with meshes.

**What actually costs, worst first**

1. **Draw calls.** Every separate mesh, and every extra material on a mesh, is a call. This is the
   binding constraint at 72 alive.
2. **Shader programs.** Each new material links on first draw, inside the driver, where neither
   `cpuMs` nor `gpuMs` can see it — that is the 514 ms frame in `tools/out/props2-hitch`.
   `Enemies.warm()` building one of every type at boot is what keeps those links out of gameplay.
3. **Transparency and alpha-test.** Blended shells (wraith, wisp) and alpha-tested cards (treant
   foliage) break early-Z and overdraw each other. An ethereal creature can cost more than a solid
   15k one.
4. **Triangles — nearly free.** This project measured terrain as NEGATIVE cost (HANDOVER 4i): hiding
   it makes the frame slower because it is the primary depth occluder. We are fragment-bound, not
   vertex-bound. A dozen near bodies at 15k adds ~140k tris against a 4 M budget.
   *Caveat:* GPUs shade in 2x2 quads, so a 15k body 20 px tall wastes enormous coverage — which is
   what the LOD ladder is for, and why LOD1/LOD2 matter more than LOD0.
5. **Chamfers are free, arguably a win.** A few dozen triangles, no extra call, no texture fetch, and
   they replace a hard normal discontinuity with a lit transition — cheaper than faking it with a
   normal map.

**The rules that follow**

- **Spend triangles freely; spend meshes and materials carefully.** A 15k single-mesh creature with
  chamfered edges is cheaper to render than today's 2.3k sixteen-piece treant.
- **Merge per animated group, not globally.** A rig poses sub-objects, so everything that moves
  together is one mesh: merge each bone's static parts with `BufferGeometryUtils.mergeGeometries`.
  A limb is one mesh, not eleven plates.
- **Cap materials per creature at ~3** — body, accent/metal, glow. Use **vertex colours** for colour
  variation instead of another material; that is free and costs no call.
- **At most ONE transparent element per creature**, and keep it small on screen. The shield shell
  already learned this the hard way (screen-coverage cull in `Enemy.js`).
- **Share geometry and materials across every instance of a type**, and keep the LOD ladder falling
  hard: LOD1 should drop material count as well as triangles, not just decimate.
- **Warm it.** A new material that is not built at boot links during play. Confirm your type still
  appears in `Enemies.warm()`.

**Acceptance — report calls, not just triangles.** Before reporting done, measure per-creature cost
the way it was measured above and put the numbers in your report:

```
{"eval":"(()=>{const s=window.__game.stats();return 'calls='+s.calls+' tris='+s.tris;})()"}
```
empty scene → spawn 10 of your type → read again → divide the delta by 10.
**Target: <= 4 draw calls per creature at LOD0.** Sixteen is a failure however good it looks.

## Step 3 — img2threejs → procedural code

Invoke the `img2threejs` skill on the GLB (its GLB-mediated track: the mesh is a structural baseline,
its topology and materials are never copied). Requirements for a converted creature:

- **CREATURE TRIANGLE BUDGET - TIERED BY FORM COMPLEXITY (user, 2026-08-26).** Triangles were never
  why our creatures looked bad: the sentinel read as stacked slabs at 4k and would read as stacked
  slabs at 50k. What costs triangles and actually earns them is smooth curvature (12-16 radial
  segments, or a limb facets at 3 m), silhouette detail (horns, spines, claws, jaw, cloth folds), and
  **chamfered edges** - a sharp 90 deg edge is the single loudest greybox tell there is.

  | tier | LOD0 target | bodies |
  |---|---|---|
  | small / ethereal | **~4k** | wisp, sprite |
  | standard creature | **~10k** | hound, frostwolf, drake, serpent, riftling, wraith |
  | complex / armoured | **~15k** | sentinel, golem, treant, warden, giant |

  That is roughly where Destiny 2's own rank-and-file combatants sit, so it is a benchmark rather
  than an indulgence.

  **THE TRAP: never declare `performanceBudget.targetTriangles` at or below 6000.** That value selects
  the img2threejs generator's *low* tessellation tier and coarsens every primitive's segment count, so
  asking for a 4k budget is exactly how a small creature comes out faceted. **Always declare 10000 (or
  15000 for the complex tier)** to stay in the *standard* tier and let a simple form land naturally
  under its target; reach for `geometryDescriptor.decimate` only on a component that overshoots.

  The LOD ladder must still fall away hard past LOD0 - up to 72 enemies are alive at once, so LOD0 is
  for the near few, never the crowd. Share geometry across instances and report LOD1/LOD2 counts.
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
