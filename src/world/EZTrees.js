// Tree system built on @dgreenheck/ez-tree (MIT, textures embedded — no external fetch).
// DEFAULT since v0.3 (?eztrees=0 restores the legacy card trees).
//
// Two tiers per variant, owned here (no InstLOD interplay):
//   near  (< 190 m): real low-poly-tuned geometry, instanced, canopy wind sway
//   far   (190-540 m): two crossed quads with the variant's baked albedo — the whole far
//         forest costs a few thousand triangles instead of millions
// Instances rebucket between tiers when the camera has moved 6 m (throttled, typed-array
// rewrite, ~2k instances — well under a millisecond).
import * as THREE from 'three';
import { compileForComposer } from '../render/Renderer.js';   // compile with a target bound — see its doc comment
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Tree } from '@dgreenheck/ez-tree';
import { patchMaterial, mergePatch, normalFromLuma, instTintPatch } from './Vegetation.js';

// PER-CARD IDENTITY. ez-tree's leaf geometry carries nothing that varies per CARD — every quad's uv is the
// same 0..1 and position varies per vertex — so under direct sun every card in a crown landed on the same
// value and each one read as "a flat pale-green parallelogram with a hard straight edge, pasted across the
// leaf mass" (crit3-forest-c/shot-west-band-canopy.png, the wave-2 'shredded plastic strips' defect).
// A leaf card is 6 indices (2 tris) and no two cards share a vertex, so walking the INDEX in sixes gives a
// card ordinal per vertex without duplicating anything — a hash of it rides along as an attribute and the
// fragment breaks value, hue and (on the huge old-growth crown cards) the texture WINDOW per card. One
// float per vertex, no extra vertices, no triangles, no draw calls. (Deliberately not toNonIndexed(): that
// would be +50% vertices on the heaviest vertex load in the forest for the same information.)
function withCardIds(geo) {
  const n = geo.attributes.position?.count ?? 0, a = new Float32Array(n), idx = geo.index;
  const h = (q) => { const s = Math.sin(q * 12.9898 + 4.1) * 43758.5453; return s - Math.floor(s); };
  if (idx) { for (let i = 0; i + 5 < idx.count; i += 6) { const v = h(i / 6); for (let k = 0; k < 6; k++) a[idx.getX(i + k)] = v; } }
  else for (let i = 0; i < n; i++) a[i] = h((i / 6) | 0);
  geo.setAttribute('aCard', new THREE.BufferAttribute(a, 1));
  return geo;
}

// species mapping: 0 slender birch-alike, 1 gnarled broadleaf, 2 shore willow (closest: droopy ash)
const POOLS = [
  ['Aspen Medium', 'Ash Medium', 'Aspen Large'],
  ['Oak Medium', 'Oak Large'],
  ['Ash Large'],
  ['Pine Medium', 'Pine Large'],      // 3: snow-laden conifer — Frostveil Tundra (card_conifer_snow boughs)
  ['Oak Large', 'Ash Large'],         // 4: charred snag — Infernal: LEAFLESS ("never a living tree, never green")
  ['Oak Large', 'Ash Large'],         // 5: old-growth canopy giant — Whisperwood Deep (27 m, few huge crown cards)
  ['Pine Medium', 'Pine Large'],      // 6: dark alpine pine — Dragon Peaks low ledges
  ['Oak Large', 'Ash Large'],         // 7: drowned dead husk — Shadowfen (the old sparse-leaf dead look)
  ['Oak Medium', 'Ash Medium', 'Oak Small'],   // 8: enchanted broadleaf — Whisperwood understory. NO aspen: the
                                      // Aspen presets carry a yellow leaf tint (0xfcff26/0xfffa62) baked into the
                                      // material, and no per-instance teal can undo a per-variant gold — they are
                                      // the "random ochre autumn trees" the critic called out. The Vale keeps them.
];
const TARGET_H = { 0: 13, 1: 12, 2: 11, 3: 16, 4: 10, 5: 27, 6: 13, 7: 10, 8: 13 };   // metres; instance scale multiplies on top
// per-species option overrides applied after loadPreset+tune (see makeVariant)
const SPECIES_TUNE = {
  // fully leafless: count kills the along-branch leaves, size 0 kills the one leaf ez-tree ALWAYS puts on
  // every terminal branch tip of a deciduous tree regardless of count (build line ~1987) — those tip leaves
  // were the "living green trees all over the wastes" that survived the first count=0 fix. The impostor
  // bake inherits it, so the hazy treeline goes bare too.
  4: (o) => { if (o.leaves) { o.leaves.count = 0; o.leaves.size = 0; o.leaves.sizeVariance = 0; } },
  // old-growth: same skeleton as the oaks, but the crown is FEWER, MUCH BIGGER cards (canopy paid for in
  // texture area, not triangles) and a thinned branch set — a 27 m tree that costs less than a 12 m one.
  // Tuned against the south-view tri budget (2026-08-25): children x0.65 + sections x0.8 cut the giant from
  // ~2.2k to ~1.5k tris; card size 2.6 -> 3.1 holds crown COVERAGE neutral against the fewer tip leaves
  // (176 cards x 3.1^2 ~= 264 x 2.6^2), so the canopy-closure acceptance shot does not reopen.
  // 2026-08-26: 0.55 x 3.1 -> 0.62 x 2.92. Crown COVERAGE is held exactly (0.62*2.92^2 = 5.29 vs
  // 0.55*3.1^2 = 5.29) while each card drops from ~10 m to ~9 m and there are 13% more of them. The first
  // attempt at this went to 1.0 x 2.4 and MEASURED 5.04 M tris at the Whisperwood heart looking south
  // (tools/out/veg4-perf) against a 4 M budget — that view is entirely leaf-bound, so card COUNT is the
  // dial and it has almost no slack. The card's hard rectangular edge, which is what the critic actually
  // photographed, is killed by the radial alpha mask in the leaf shader, not by making cards smaller.
  5: (o) => {
    if (o.leaves) { o.leaves.count = Math.max(10, Math.round((o.leaves.count ?? 20) * 0.62)); o.leaves.size = (o.leaves.size ?? 2) * 2.92; }
    if (o.branch?.children) { for (const k in o.branch.children) o.branch.children[k] = Math.max(1, Math.round(o.branch.children[k] * 0.65)); }
    if (o.branch?.sections) { for (const k in o.branch.sections) o.branch.sections[k] = Math.max(3, Math.round(o.branch.sections[k] * 0.8)); }
  },
  7: (o) => { if (o.leaves) { o.leaves.count = Math.max(1, Math.round((o.leaves.count ?? 10) * 0.08)); o.leaves.size = (o.leaves.size ?? 2) * 0.65; } },
};
// per-species leaf/needle tint fallback (region-owned trees carry their own tr.c from Vegetation._place)
const LEAF_TINT = { 3: [0.90, 0.96, 1.06], 4: [0.52, 0.40, 0.30], 6: [0.30, 0.40, 0.35], 7: [0.52, 0.40, 0.30] };
// bark colour over the gnarled bark map. Default darker than the old white-on-pale-ez-bark: trunks were
// reading as utility poles. 4 = matte charcoal (charred, NOT winter birch), 7 = wet peat-stained.
const BARK_TINT = { default: 0xa6988a, 3: 0x8e857b, 4: 0x38322e, 6: 0x776e64, 7: 0x63564a };
// per-species leaf MATERIAL colour override (multiplies the texture, under the per-instance tint).
// 6: ez's Pine presets carry a bright spring green in the material — beside the Kharaz-Dun gate they read
// as lime saplings (crit2-dragon-b/shot-gate-22). A grey-sage override kills the summer read at the source.
const LEAF_COL = { 6: 0x8fa397 };
// mip-dilution edge tint for the impostor bake clear colour (RGB only, alpha stays 0): with mipmaps on,
// crown-edge texels blend toward this instead of toward whatever the renderer's global clear colour was.
const CLEAR_COL = { 3: [0.72, 0.78, 0.85], 4: [0.16, 0.14, 0.13], 5: [0.15, 0.24, 0.13], 7: [0.24, 0.26, 0.16], default: [0.19, 0.28, 0.14] };
const LEAF_MAP = {
  3: 'card_conifer_snow',   // painted snow bough replaces the oak-lobed summer cards
  // 5: the old-growth crown is a few HUGE (~10 m) cards. With ez-tree's single-leaf texture stretched
  // across them, every card rendered as one solid green slab — from the void border the whole Whisperwood
  // canopy read as stacked "Minecraft" cubes (crit2-void-b/crop-cubetrees). A 10 m crown card must carry a
  // whole painterly CLUSTER (leaves at ~40 cm, ragged bush silhouette), which is exactly what the painted
  // leaf_card asset is. Tri-neutral: same cards, different texture.
  5: 'leaf_card',
};
// NEAR was 190 when only Whisperwood was wooded. A closed canopy there plus Frostveil-as-forest measured
// 4.19 M / 3.88 M tris, trees being 2.17 M of it. The near tier is area-scaled, so this is the dial: 175 m
// holds the frame around 3.6 M against the 4 M budget, and the impostor tier — what you are actually looking
// at past ~140 m — carries the treeline unchanged out to 780 m.
// 2026-08-26: 175 -> 163. Measured at the Whisperwood heart looking SOUTH (the heaviest view in the world,
// tools/out/veg3-runB): 4.65 M tris against a 4 M budget, while the same camera facing NORTH is 3.48 M — the
// view is entirely near-tier-bound. The near tier is area-scaled, so 163/175 squared is ~13% fewer real
// trees, and the band it gives up (163-175 m) is well past the ~140 m where the 3-quad impostor is already
// what you are looking at. No visual change, ~0.5 M tris back.
// 2026-08-26: 163 -> 152. Measured at the same camera (Whisperwood heart, facing SOUTH, hour 13,
// tools/out/veg4-perf2): 4.44 M tris against the 4 M budget — and the leaf-count arithmetic in that run
// puts the pre-existing frame at ~4.33 M, i.e. this view has been over budget on its own for a while and
// the leaf work only moved it 2.5%. The near tier is area-scaled, so 152/163 squared is ~13% fewer real
// trees; the band it gives up (152-163 m) is a full 25 m past the ~128 m where the 3-quad impostor is
// already what you are looking at, and the impostor tier still carries the treeline to 780 m unchanged.
const NEAR = 152, FAR = 780;              // tier split / hard cull (far tier is 6 tris an instance, so the treeline runs to the mountains instead of stopping at 540 m)
const BAND = 24;                            // cross-fade band inside NEAR: real tree dissolves into its impostor
const REBUCKET = 2.25;                      // metres of camera travel between rebuckets (was 6: too coarse once the
                                            // band fade rides on distance — the fade stepped instead of gliding)
// Trunks only cast shadows inside this radius. Measured at Whisperwood: 887 near trees are ~1.5 M tris,
// and every one of them was re-rasterised into all three CSM cascades — the forest's triangle count was
// mostly shadow re-draws, not the visible canopy. Past ~75 m a 13 m trunk's shadow is a thin smudge under
// a canopy that is already shadowing the ground, so the read is identical and the cascades get 3x lighter.
// Same pattern Enemies.js already uses for its skinned meshes (castShadow gated on distance).
// Well inside NEAR - BAND, so a shadow-caster is never mid-cross-fade.
const SHADOW_CAST = 68;   // most of a dense canopy's tri count is shadow re-draws (one trunk rasterised into every cascade); past ~68 m a trunk shadow under a canopy reads the same and costs three draws

export function buildEZTrees(game, trees, vegetation) {
  const t0 = performance.now();
  const cache = {};
  const seedBase = (game.seed | 0) || 1;
  const renderer = game.renderer;
  const windT = { value: 0 };

  // canopy wind sway: displace by height above the roots, phased per instance — one vertex term.
  // Plus a near-camera dissolve on the leaves: walking (especially BACKWARDS, where you cannot see what you
  // are reversing into) puts the eye inside a canopy, and leaf quads a few centimetres from the near plane
  // rasterise as huge unlit black polygons slamming across the frame. Trunks have colliders; canopies do not
  // and cannot without making forests unwalkable, so the geometry dissolves instead of being pushed away.
  // `key` matters: patchMaterial uses it as customProgramCacheKey, and a patch without one keys as
  // "undefined" — i.e. shares a cache slot with every other keyless patched material.
  const sway = {
    key: 'eztree-sway',
    uniforms: { uWindT: windT },
    vHead: 'uniform float uWindT;',
    vBegin: `{
      #ifdef USE_INSTANCING
      vec3 swayI = vec3(instanceMatrix[3]);
      #else
      vec3 swayI = vec3(0.0);
      #endif
      float swayPh = dot(swayI.xz, vec2(0.13, 0.11));
      float swayA = smoothstep(1.5, 9.0, transformed.y);
      // Fade the sway out with distance. A leaf quad past ~50 m is 1-3 px wide, so a 22 cm swing moves it
      // several pixels per frame: every one of those pixels toggles between dark leaf and bright sky, and
      // with no TAA that reads as the whole tree line crawling with black flecks (measured: a STATIC camera
      // sees a mean frame-to-frame luminance delta of 18.7 over the tree line with sway on, 1.8 with it off).
      // Near canopies keep the full motion, which is the only place the sway is actually legible.
      float swayFade = 1.0 - smoothstep(40.0, 120.0, distance(cameraPosition, swayI));
      swayA *= swayFade;
      transformed.x += sin(uWindT * 1.5 + swayPh) * 0.22 * swayA;
      transformed.z += cos(uWindT * 1.2 + swayPh * 1.3) * 0.16 * swayA;
    }`,
  };

  // Leaf fade: the LOD cross-fade AND the walked-into-canopy dissolve, both as ALPHA EROSION (the cutout
  // threshold rises, leaves shrink away one by one). The old near dissolve was a screen-door dither, and a
  // STATIC camera a few metres from a bough held the half-resolved stipple forever — the tundra critic's
  // "dense white screen-door stipple that never resolves" crop. Erosion has no pattern to hold: a
  // half-faded bough is simply a thinner bough. Window 1.5-4.6 m unchanged (see the sway comment history:
  // tighter windows put black slab quads across the frame when reversing into a canopy).
  const erodeNear = {
    vHead: 'attribute float aFade; varying float vFade;',
    vBegin: 'vFade = aFade;',
    fHead: 'varying float vFade;',
    fAlpha: 'float ezF = min(clamp(vFade, 0.0, 1.0), smoothstep(1.5, 4.6, length(vViewPosition))); if (diffuseColor.a < mix(1.01, 0.4, ezF)) discard;',
  };
  // Impostor fade: ALPHA EROSION, complementary to the leaves' erodeNear — NOT a screen door.
  // This was the tundra blocker, twice: "LOD-crossfade dither stipple is BACK on every mid-distance
  // conifer ... a hard diagonal checkerboard screen-door pattern, not foliage" (crit3-tundra-b/
  // crop-dither.png, and the same stipple in every frame with trees at 40-120 m). A dither is invisible
  // on a busy background and maximally visible against a snowfield, and a camera that stops moving holds
  // the half-resolved pattern forever. Erosion has no pattern to hold: the near canopy thins out leaf by
  // leaf while the impostor's own alpha climbs in, so a mid-band tree is simply a slightly sparser tree.
  // The two do not need to tile to exact coverage — they overlap, which is what the eye wants anyway.
  const impFade = {
    vHead: 'attribute float aFade; varying float vFade;',
    vBegin: 'vFade = aFade;',
    fHead: 'varying float vFade;',
    fAlpha: 'if (diffuseColor.a < mix(1.01, 0.35, clamp(vFade, 0.0, 1.0))) discard;',
  };
  // Trunks do NOT cross-fade at all any more. Bark is opaque, so its only option was the screen door, and
  // a stippled trunk is the other half of what the tundra critic photographed. At the band's outer edge
  // (163 m) a 13 m trunk is under 2 px wide and is already covered by its own impostor card, so a hard
  // cut there is not visible — the pop the fade was added for was the CANOPY's, and that still cross-fades.
  const barkNoFade = { key: 'eztree-bark' };
  // The leaf and impostor materials below both carry `instTintPatch` (Vegetation.js): without it three
  // r185 silently drops instanceColor before the fragment stage, and every `tr.c` region leaf colour
  // Vegetation._place computes (BTREE[].col — Whisperwood's deep teal-green, the enchanted blue-teal
  // accent, the Frostveil cool cast) is uploaded and discarded. That is why the canopy read as flat
  // spring lime. See the patch's doc comment for the mechanism and why `vertexColors: true` is not it.

  // Low-poly tune: raw presets are ~50-100k tris per tree (148M in frame, 29 fps measured).
  const tune = (o) => {
    const b = o.branch, l = o.leaves;
    for (const k in b.children) b.children[k] = Math.max(1, Math.round(b.children[k] * 0.4));
    for (const k in b.sections) b.sections[k] = Math.max(3, Math.round(b.sections[k] * 0.55));
    for (const k in b.segments) b.segments[k] = Math.max(3, Math.round(b.segments[k] * 0.55));
    l.count = Math.max(8, Math.round(l.count * 0.55));
    l.size *= 1.7;
  };

  // the painted gnarled bark (ASSETS.md) — one map + one derived normal shared by every variant.
  // Null-safe: without the asset the variants keep ez-tree's embedded bark, just darker-tinted.
  const gnBark = game.assets?.tex?.('bark_gnarled') ?? null;
  const gnNormal = gnBark?.image ? normalFromLuma(gnBark.image, 512, 4) : null;

  // Root-flare skirt merged into the trunk: an 8-lobe cone from just below grade up the first ~1.4 m,
  // ~2.4x the trunk radius at the ground. 20 tris a variant kills the "dowel stuck in a lawn" read.
  function withRootFlare(geo) {
    const pos = geo.attributes.position; let r0 = 0.1;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); if (y > 0.05 && y < 0.6) { const rr = Math.hypot(pos.getX(i), pos.getZ(i)); if (rr < 1.6 && rr > r0) r0 = rr; } }
    const SEG = 10, P = [], N = [], U = [];
    const lobe = (a) => 1 + 0.42 * Math.sin(a * 4 + 1.7) + 0.22 * Math.sin(a * 7 + 0.4);
    const v = (a, rr, y) => [Math.cos(a) * rr, y, Math.sin(a) * rr];
    for (let s = 0; s < SEG; s++) {
      const A0 = s / SEG * Math.PI * 2, A1 = (s + 1) / SEG * Math.PI * 2;
      const p00 = v(A0, r0 * 2.4 * lobe(A0), -0.3), p10 = v(A1, r0 * 2.4 * lobe(A1), -0.3);
      const p01 = v(A0, r0 * 1.04, 1.4), p11 = v(A1, r0 * 1.04, 1.4);
      for (const p of [p00, p10, p11, p00, p11, p01]) {
        P.push(...p); const l = Math.hypot(p[0], 0.7, p[2]); N.push(p[0] / l, 0.7 / l, p[2] / l);
        U.push(Math.atan2(p[2], p[0]) * 0.5 + 1.0, p[1] * 0.4);
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(P), 3));
    fg.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(N), 3));
    fg.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(U), 2));
    const bg = geo.index ? geo.toNonIndexed() : geo;
    for (const k in bg.attributes) if (!fg.attributes[k]) { const src = bg.attributes[k]; fg.setAttribute(k, new THREE.BufferAttribute(new Float32Array((P.length / 3) * src.itemSize), src.itemSize)); }
    const merged = mergeGeometries([bg, fg]);
    return merged ?? geo;   // attribute mismatch -> keep the plain trunk rather than lose the tree
  }

  // bake a variant's unlit albedo side view for the far impostor, from its FINAL near-tier materials
  // (gnarled bark tint, snow cards, leaflessness all carry to the treeline). Positive-near ortho pulled
  // back (a negative-near frustum rejects everything and bakes pure transparency — learned the hard way).
  const bakeScene = new THREE.Scene();
  function bakeImpostor(v) {
    const res = 192;
    const w = v.w, h = v.h;
    // Mipmapped: the old un-mipped RT point-sampled the 192px bake at treeline distances, which read as
    // crawling noise; with mips + aniso the far canopy resolves like the legacy Vegetation impostors.
    const rt = new THREE.WebGLRenderTarget(res, res, { format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    const clones = [[v.branchGeo, v.barkMat], [v.leafGeo, v.leafMat]].map(([g, m]) => new THREE.Mesh(g,
      new THREE.MeshBasicMaterial({ map: m.map ?? null, alphaTest: 0.4, side: THREE.DoubleSide, color: m.color?.clone() ?? 0xffffff })));
    for (const c of clones) { c.frustumCulled = false; bakeScene.add(c); }
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h, 0, 0.1, w * 4);
    cam.position.set(0, 0, w * 2); cam.lookAt(0, 0, 0);
    const prevTone = renderer.toneMapping, prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearAlpha();
    const prevCC = new THREE.Color(); renderer.getClearColor(prevCC);
    const cc = CLEAR_COL[v.species] ?? CLEAR_COL.default;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(rt); renderer.setClearColor(new THREE.Color(cc[0], cc[1], cc[2]), 0); renderer.clear();
    renderer.render(bakeScene, cam);
    renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevCC, prevClear); renderer.toneMapping = prevTone;
    for (const c of clones) { bakeScene.remove(c); c.material.dispose(); }
    rt.texture.colorSpace = THREE.SRGBColorSpace; rt.texture.anisotropy = 8;
    return rt.texture;
  }

  const makeVariant = (preset, seed, species = 0) => {
    const key = preset + seed + ':' + species;
    if (cache[key]) return cache[key];
    const t = new Tree();
    t.loadPreset(preset);
    t.options.seed = seed;
    tune(t.options);
    SPECIES_TUNE[species]?.(t.options);
    t.generate();
    // Bounds: leaf bbox CLAMPED to branch bbox + 2.3x leaf size. Branch-only + a size*0.6 margin (the old
    // form) clipped the big crown cards at the texture border — a leaf card anchors at its BASE and extends
    // a full `size` past the branch tip (ez-tree generateLeaf), so old-growth crowns baked with flat-chopped
    // tops/sides and the treeline read as rectangles. The clamp still rejects the stray far-out leaf verts
    // that blew a raw leaf-bbox measurement to ~186 m.
    t.branchesMesh.geometry.computeBoundingBox();
    const b1 = t.branchesMesh.geometry.boundingBox;
    const lsz = (t.options.leaves?.size ?? 2) * (1 + (t.options.leaves?.sizeVariance ?? 0));
    const lg = t.leavesMesh.geometry; let lb = null;
    if (lg.getAttribute('position')?.count) { lg.computeBoundingBox(); lb = lg.boundingBox; }
    const bHalf = Math.max(b1.max.x, -b1.min.x, b1.max.z, -b1.min.z);
    const lHalf = lb ? Math.max(lb.max.x, -lb.min.x, lb.max.z, -lb.min.z) : 0;
    const h = Math.max(1, Math.min(Math.max(b1.max.y, lb ? lb.max.y : 0), b1.max.y + 2.3 * lsz) + 0.4);
    const w = Math.max(2, 2 * (Math.min(Math.max(bHalf, lHalf), bHalf + 2.3 * lsz) + 0.4));
    const barkMat = patchMaterial(new THREE.MeshStandardMaterial({
      map: gnBark ?? t.branchesMesh.material.map ?? null, normalMap: gnNormal, normalScale: gnNormal ? new THREE.Vector2(1.6, 1.6) : undefined,
      roughness: 0.94, metalness: 0, color: BARK_TINT[species] ?? BARK_TINT.default,
    }), barkNoFade);
    const assetLeaf = LEAF_MAP[species] ? game.assets?.tex?.(LEAF_MAP[species]) : null;
    const leafGeo = withCardIds(t.leavesMesh.geometry);
    // Crop the painted CLUSTER asset per card. It is one dense round bush: stretched whole across a 6-10 m
    // old-growth crown card every leaf is a metre wide, which mips to a filled quad — the critic's "no leaf
    // alpha detail ... a filled quad". A ~1/3 window puts leaves at a real ~40 cm and, because every window
    // straddles the bush's edge, hands each card a ragged silhouette. Same trick Vegetation.LEAF_CROPS uses.
    // Only for leaf_card: ez-tree's own map and card_conifer_snow are single-motif textures, not atlases.
    const crop = LEAF_MAP[species] === 'leaf_card' && assetLeaf ? `
        float cs = 0.30 + 0.14 * fract(vCard * 5.17);
        float ca = vCard * 6.2831853;
        vec2 co = clamp(vec2(0.5) + vec2(cos(ca), sin(ca)) * (0.5 - cs * 0.46) - cs * 0.5, vec2(0.0), vec2(1.0 - cs));
        luv = co + fract(luv) * cs;` : '';
    // instTintPatch's own fMap re-includes <map_fragment>; this material samples the map itself (for the
    // crop), so only its declarations are borrowed and the tint multiply is folded in below.
    const instTintDecl = { vHead: instTintPatch.vHead, vBegin: instTintPatch.vBegin, fHead: instTintPatch.fHead };
    const leafMat = patchMaterial(new THREE.MeshStandardMaterial({
      map: assetLeaf ?? t.leavesMesh.material.map ?? null, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.95, metalness: 0,
      color: assetLeaf ? 0xffffff : (LEAF_COL[species] ?? t.leavesMesh.material.color?.clone() ?? 0xffffff),   // the painted card carries its own colour — ez's preset green would re-summer the snow
    }), mergePatch(erodeNear, sway, instTintDecl, {
      // The leaf shader SOURCE now differs by species (only leaf_card gets the crop), so the program cache
      // key has to differ too — patchMaterial hands `key` straight to customProgramCacheKey, and one shared
      // key across variants with different source is how a material silently renders someone else's shader.
      key: crop ? 'eztree-leaf-crop' : 'eztree-leaf',
      fMap: `
        #ifdef USE_MAP
        { vec2 luv = vMapUv;${crop}
          diffuseColor *= texture2D(map, luv);
          // RADIAL CARD MASK. The crop alone was not enough: a window that lands in the dense middle of the
          // painted bush is fully opaque, so the card still rendered as a hard-edged parallelogram slab
          // (tools/out/veg4-after/shot-f-crown.png, before this line). Fading a card's alpha out toward its
          // own border makes every card a ragged blob whatever texel it happened to sample — the card
          // RECTANGLE stops existing. Corners go first, which is where the straight-edge read comes from.
          float cardR = length(fract(vMapUv) - 0.5) * 2.0;
          diffuseColor.a *= 1.0 - smoothstep(0.70, 1.28, cardR); }
        #endif
        diffuseColor.rgb *= vITint;
        // per-card value + hue drift: the highlight is broken by card IDENTITY, not by anything
        // screen-aligned or linear, so it holds still when the camera moves and never forms a pattern
        diffuseColor.rgb *= mix(0.68, 1.08, fract(vCard * 7.31));
        diffuseColor.rgb *= vec3(1.0 + (fract(vCard * 3.71) - 0.5) * 0.18, 1.0, 1.0 + (fract(vCard * 11.37) - 0.5) * 0.22);`,
      // Canopy-sphere shading: raw card normals point wherever the card faces, so a sun-aligned 10 m card
      // lit uniformly bright next to a dark neighbour read as long two-tone "plastic strip" slashes across
      // the crown (crit2-forest-b/shot-heart-side). Pulling normals toward up shades the canopy like a
      // volume — same trick Vegetation.cards() uses spherical normals for.
      vNormal: 'vec3 objectNormal = normalize(mix(normal, vec3(0.0, 1.0, 0.0), 0.68));',
      // GRAZING-ANGLE EROSION — the other half of the plastic-strip bug, and the half the shading fix
      // could not reach. A 6-10 m old-growth crown card seen near edge-on projects to a long thin WEDGE:
      // a hard-edged bright slash lying across the canopy (crit2-forest verdict "shredded plastic strips";
      // reproduced at tools/out/veg3-before/shot-forest-south.png, crop-crown). No amount of normal
      // blending fixes it, because the artefact is the card's SILHOUETTE, not its shading.
      // So a card dissolves as it turns edge-on: the alpha cutout climbs toward 1 as |N.V| -> 0, and the
      // neighbouring cards (3 random orientations per crown) cover the hole. Zero triangles, zero draw
      // calls, and it is the raw GEOMETRIC card normal that drives it — vNormal above is already bent
      // toward up, which is why this carries its own varying.
      vHead: 'varying vec3 vCardN; attribute float aCard; varying float vCard;',
      vBegin: `{ vec3 cardN0 = normal;
        #ifdef USE_INSTANCING
        cardN0 = mat3(instanceMatrix) * cardN0;
        #endif
        vCardN = normalMatrix * cardN0; }
        vCard = aCard;`,
      fHead: 'varying vec3 vCardN; varying float vCard;',
      fAlpha: 'if (diffuseColor.a < mix(1.01, 0.42, smoothstep(0.09, 0.34, abs(dot(normalize(vCardN), normalize(vViewPosition)))))) discard;',
    }));
    // Impostor: three quads at 60 degrees, not two at 90. A 2-quad cross has two viewing azimuths per
    // rotation where one card is edge-on and the silhouette collapses to a single flat plane — the
    // "cardboard tree" tell when you strafe past the treeline. A third quad costs 2 triangles per instance
    // and keeps at least two cards near-facing from every angle.
    const q0 = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0);
    const q1 = q0.clone().rotateY(Math.PI / 3);
    const q2 = q0.clone().rotateY(Math.PI * 2 / 3);
    const cross = mergeGeometries([q0, q1, q2]);
    const nrm = cross.getAttribute('normal');
    for (let n = 0; n < nrm.count; n++) nrm.setXYZ(n, 0, 1, 0);   // light like ground: no dark backside quad
    const v = { tree: t, species, branchGeo: withRootFlare(t.branchesMesh.geometry), leafGeo, barkMat, leafMat, cross, impMat: null, w, h };
    cache[key] = v;
    return v;
  };

  // bucket trees per variant
  const buckets = new Map();
  for (const tr of trees) {
    const pool = POOLS[tr.species] ?? POOLS[0];
    const preset = pool[(Math.abs((tr.x * 7 + tr.z * 13) | 0)) % pool.length];
    const v = makeVariant(preset, seedBase + (tr.species + 1) * 37, tr.species);
    let b = buckets.get(v); if (!b) buckets.set(v, b = []);
    b.push(tr);
  }

  const tVar = performance.now();   // boot timing split (see the summary log at the end of this build)
  // ez-tree's embedded data-URI textures decode async — bake only after they are actually loaded
  const maps = [...new Set([...buckets.keys()].flatMap((v) => [v.barkMat.map, v.leafMat.map].filter(Boolean)))];
  // `m.image` is NULL until the data URI decodes -- TextureLoader assigns it on load. The old gate read
  // `if (!img || img.complete) return null`, i.e. it treated "no image yet" as "ready", so it resolved
  // immediately for precisely the textures it existed to wait for: all 9 of them logged
  // `THREE.WebGLRenderer: Texture marked for update but no image data found` in every capture, and the
  // first impostor albedos were baked from an unbound (black) map. Poll for the image instead.
  // ponytail: rAF poll, 1-2 frames in practice; upgrade path = patch ez-tree to expose its load promises.
  const ready = Promise.all(maps.map((m) => new Promise((res) => {
    let tries = 0;
    const tick = () => ((m.image && m.image.complete) || ++tries > 600) ? res() : requestAnimationFrame(tick);
    tick();
  })));

  ready.then(async () => {
    const tReady = performance.now();
    const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler();
    const C = new THREE.Color();
    const sets = [];
    let count = 0;
    for (const m of maps) { m.needsUpdate = true; renderer.initTexture(m); }   // decoded image -> GPU before the bake samples it
    let bi = 0;
    for (const [v, list] of buckets) {
      // ONE BAKE PER FRAME cost this block 7.9 s of wall clock (measured 2026-08-29 by splitting its own
      // log: variants 729 ms · texwait 62 ms · build 7883 ms · compile 25 ms -> after: build 293 ms). The
      // rule came from the 2026-08-20 perf audit, where a burst of six RT renders read as a boot hitch —
      // but a rAF yield here does not cost one frame, it costs one BOOT frame, and boot frames run
      // 150-400 ms because terrain, props and vegetation are all building on the same thread.
      // HONEST SCOPE, measured: this does NOT shorten the total boot. The time was spent YIELDING to that
      // other boot work, which has to happen regardless, so the wall clock is unchanged (~28 s either
      // way) — what changes is that the impostor tier is ready ~6.5 s earlier inside it, instead of being
      // the last thing to land. Yield every 6th: the bakes still spread over 4 frames, so whatever hitch
      // the audit saw cannot come back.
      if ((bi++ % 6) === 0) await new Promise((res) => requestAnimationFrame(res));
      v.impMat = patchMaterial(new THREE.MeshStandardMaterial({ map: bakeImpostor(v), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 }),
        mergePatch(impFade, instTintPatch, { key: 'eztree-impostor' }));
      const n = list.length;
      // static per-instance data, written once; rebucketing rewrites the mesh instance buffers from it
      const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3), xz = new Float32Array(n * 2);
      list.forEach((tr, k) => {
        const s = ((TARGET_H[tr.species] ?? 13) / v.h) * tr.scale;
        E.set(0, ((tr.x * 31 + tr.z * 17) % 628) / 100, 0); Q.setFromEuler(E);
        P.set(tr.x, tr.y - 0.15 * s, tr.z); S.setScalar(s); M.compose(P, Q, S);
        mats.set(M.elements, k * 16);
        const tint = 0.82 + ((tr.x * 13 + tr.z * 7) % 10) * 0.03;
        const lt = LEAF_TINT[tr.species];
        if (tr.c) C.setRGB(tr.c[0], tr.c[1], tr.c[2]);              // region-owned: Vegetation._place computed the biome leaf tint (BTREE col x jitter)
        else if (lt) C.setRGB(tint * lt[0], tint * lt[1], tint * lt[2]);
        else C.setRGB(tint * 0.95, tint, tint * 0.9);
        cols.set([C.r, C.g, C.b], k * 3);
        xz[k * 2] = tr.x; xz[k * 2 + 1] = tr.z;
      });
      // LOD cross-fade: a tree crossing NEAR used to swap its whole silhouette in one frame, and the
      // rebucket flips a BATCH of them at once — measured as a visible pop of dark canopies whenever you
      // move (worst walking backwards, where the trees that flip are the ones filling the screen). Same
      // dithered aFade the Vegetation InstLOD sets use: near dissolves out while the impostor dissolves in.
      const nearFade = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
      const farFade = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
      v.branchGeo.setAttribute('aFade', nearFade); v.leafGeo.setAttribute('aFade', nearFade); v.cross.setAttribute('aFade', farFade);
      // trunkNS draws a different slice of the near tier than trunk, and an InstancedMesh always reads its
      // attributes from index 0 — so it needs its own instanceMatrix AND its own aFade. Alias the branch
      // geometry instead of cloning it: same position/normal/uv/index buffers, one extra fade stream.
      const nsFade = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
      const branchGeoNS = new THREE.BufferGeometry();
      for (const k in v.branchGeo.attributes) branchGeoNS.setAttribute(k, v.branchGeo.attributes[k]);
      branchGeoNS.setIndex(v.branchGeo.index); branchGeoNS.boundingSphere = v.branchGeo.boundingSphere;
      branchGeoNS.setAttribute('aFade', nsFade);
      const trunk = new THREE.InstancedMesh(v.branchGeo, v.barkMat, n);      // < SHADOW_CAST m: casts
      const trunkNS = new THREE.InstancedMesh(branchGeoNS, v.barkMat, n);    // SHADOW_CAST..NEAR: drawn, never rasterised into a cascade
      const leaves = new THREE.InstancedMesh(v.leafGeo, v.leafMat, n);
      const imp = new THREE.InstancedMesh(v.cross, v.impMat, n);
      trunk.castShadow = trunk.receiveShadow = true;
      trunkNS.castShadow = false; trunkNS.receiveShadow = true;
      leaves.castShadow = false; leaves.receiveShadow = false;   // leaf shadow pass cost >> its read
      if (v.species === 5) {
        // old-growth is the exception: its crown IS the forest ceiling, and a closed canopy with a sunlit
        // floor reads broken. The crown is a few dozen huge cards, so all three cascades together cost
        // ~100k tris — nothing next to what the sapling canopies would have cost (why leaves stay off elsewhere).
        leaves.castShadow = true;
        leaves.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: v.leafMat.map, alphaTest: 0.5, side: THREE.DoubleSide });
      }
      imp.castShadow = imp.receiveShadow = false;
      trunk.frustumCulled = trunkNS.frustumCulled = leaves.frustumCulled = imp.frustumCulled = false;   // rebucketing is the culling
      trunk.name = 'eztree-trunk'; trunkNS.name = 'eztree-trunk-ns'; leaves.name = 'eztree-leaves'; imp.name = 'eztree-impostor';
      for (const m of [trunk, trunkNS, leaves, imp]) { m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }
      leaves.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
      // impostors carry the same per-tree leaf tint: without it the baked albedo snapped back to the
      // preset's summer green at 175 m and the region palettes (forest teal, charred infernal) ended at the near tier
      imp.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
      game.scene.add(trunk, trunkNS, leaves, imp);
      sets.push({ mats, cols, xz, n, trunk, trunkNS, leaves, imp, nearFade, farFade, nsFade,
        colNS: new Float32Array(n * 3), fadeNS: new Float32Array(n) });
      count += n;
    }

    // rebucket near/far on movement; hooked into the render loop via one probe object
    const up = (a, len) => { a.needsUpdate = true; if (len > 0 && a.clearUpdateRanges) { a.clearUpdateRanges(); a.addUpdateRange(0, len); } };
    const last = new THREE.Vector3(1e9, 0, 0);
    // must be a RENDERABLE object: onBeforeRender never fires for a bare Object3D
    const probe = new THREE.Mesh(new THREE.PlaneGeometry(0.001, 0.001),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
    probe.frustumCulled = false; probe.renderOrder = -999; game.scene.add(probe);
    // Wind clock: our own accumulator, NOT performance.now(). A wall-clock wind keeps the canopy moving
    // while game.paused, which is why the frozen-world jitter probe saw the trees (and only the trees)
    // change frame to frame -- tools/gate.mjs rule 2.
    let windClock = 0, lastNow = performance.now();
    probe.onBeforeRender = (r, sc, cam) => {
      // MAIN CAMERA ONLY. This probe renders in every scene pass, including the water's planar-reflection
      // pass, whose camera is mirrored under the lake surface and tens of metres from the player. Letting
      // that position drive the rebucket reassigned near/far tiers for the whole forest on the reflection
      // frame and back again on the next one: trees a few metres away popped to their 2-quad far impostor,
      // which reads as flat black cards flashing in your face (the "black tree shapes flicker when you
      // walk backwards" report -- backwards is simply when the lake spends most time in frustum).
      if (cam !== game.camera) return;
      const now = performance.now();
      if (!game.paused) windClock += (now - lastNow) * 0.001;
      lastNow = now;
      windT.value = windClock;
      const p = cam.position;
      if (p.distanceToSquared(last) < REBUCKET * REBUCKET) return;
      last.copy(p);
      const N2 = NEAR * NEAR, F2 = FAR * FAR, B2 = (NEAR - BAND) * (NEAR - BAND), S2 = SHADOW_CAST * SHADOW_CAST;
      for (const s of sets) {
        let nS = 0, nNS = 0, nf = 0;
        const tm = s.trunk.instanceMatrix.array, tn = s.trunkNS.instanceMatrix.array;
        const im = s.imp.instanceMatrix.array, lc = s.leaves.instanceColor.array, ic = s.imp.instanceColor.array;
        const nfa = s.nearFade.array, ffa = s.farFade.array, nsf = s.nsFade.array;
        // Shadow casters fill tm from the front, the rest fill tn; afterwards tn is appended onto tm so the
        // leaves (drawn for the whole near tier, never casting) can share one contiguous buffer with trunk.
        for (let i = 0; i < s.n; i++) {
          const dx = s.xz[i * 2] - p.x, dz = s.xz[i * 2 + 1] - p.z, d2 = dx * dx + dz * dz;
          const src = s.mats.subarray(i * 16, i * 16 + 16);
          // inside the band both tiers draw, dithered against each other; outside it only one does
          const t = d2 <= B2 ? 0 : d2 >= N2 ? 1 : (Math.sqrt(d2) - (NEAR - BAND)) / BAND;
          if (d2 < S2) { tm.set(src, nS * 16); lc.set(s.cols.subarray(i * 3, i * 3 + 3), nS * 3); nfa[nS] = 1; nS++; }   // casters are far inside the band: always fully solid
          else if (d2 < N2) { tn.set(src, nNS * 16); s.colNS.set(s.cols.subarray(i * 3, i * 3 + 3), nNS * 3); s.fadeNS[nNS] = 1 - t; nsf[nNS] = 1 - t; nNS++; }
          if (d2 >= B2 && d2 < F2) { im.set(src, nf * 16); ic.set(s.cols.subarray(i * 3, i * 3 + 3), nf * 3); ffa[nf] = t; nf++; }
        }
        tm.set(tn.subarray(0, nNS * 16), nS * 16);                      // near non-casters after the casters
        lc.set(s.colNS.subarray(0, nNS * 3), nS * 3);                   // and their per-instance leaf tints, in the same order
        nfa.set(s.fadeNS.subarray(0, nNS), nS);                         // ...and their fades, so the leaves cross-fade with them
        const nn = nS + nNS;
        s.leaves.instanceMatrix.array.set(tm.subarray(0, nn * 16));
        s.trunk.count = nS; s.trunkNS.count = nNS; s.leaves.count = nn; s.imp.count = nf;
        // Upload only the LIVE range. needsUpdate on its own re-uploads the whole attribute, which is sized
        // to the variant's total tree count, not to .count -- a rebucket was pushing every tree's matrix
        // over the bus every REBUCKET metres. Same idiom as Vegetation.InstLOD.refresh().
        up(s.trunk.instanceMatrix, nS * 16); up(s.trunkNS.instanceMatrix, nNS * 16);
        up(s.leaves.instanceMatrix, nn * 16); up(s.imp.instanceMatrix, nf * 16);
        up(s.leaves.instanceColor, nn * 3); up(s.imp.instanceColor, nf * 3);
        up(s.nearFade, nn); up(s.farFade, nf); up(s.nsFade, nNS);   // nearFade is shared by trunk (nS) and leaves (nn); nn covers both
      }
    };
    // compile every new tree/impostor program NOW, while the boot splash still covers the screen —
    // first-use compiles were landing as multi-hundred-ms hitches in the player's first seconds.
    const tBuilt = performance.now();
    try { compileForComposer(renderer, game.scene, game.camera); } catch (e) {}
    // Split the total: this block is the single biggest line item in the boot log and "impostors baked"
    // was never what it measured. variants = 19x ez-tree generate(); texwait = the rAF poll for ez-tree's
    // embedded data-URI textures to decode; build = bake + instancing; compile = shader precompile.
    console.log(`[eztrees] ${count} trees, ${buckets.size} variants in ${(performance.now() - t0).toFixed(0)} ms `
      + `(variants ${(tVar - t0).toFixed(0)} · texwait ${(tReady - tVar).toFixed(0)} · build ${(tBuilt - tReady).toFixed(0)} · compile ${(performance.now() - tBuilt).toFixed(0)})`);
  });
}
