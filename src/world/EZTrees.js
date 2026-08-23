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
import { patchMaterial, mergePatch, fadePatch, erodeFade } from './Vegetation.js';

// species mapping: 0 slender birch-alike, 1 gnarled broadleaf, 2 shore willow (closest: droopy ash)
const POOLS = [
  ['Aspen Medium', 'Ash Medium', 'Aspen Large'],
  ['Oak Medium', 'Oak Large'],
  ['Ash Large'],
  ['Pine Medium', 'Pine Large'],      // 3: conifer — Frostveil Tundra, Dragon Peaks
  ['Oak Large', 'Ash Large'],         // 4: dead — same skeleton, leaves stripped in SPECIES_TUNE
];
const TARGET_H = { 0: 13, 1: 12, 2: 11, 3: 16, 4: 10 };   // metres; instance scale multiplies on top
// per-species option overrides applied after loadPreset (see makeVariant)
const SPECIES_TUNE = {
  4: (o) => { if (o.leaves) { o.leaves.count = Math.max(1, Math.round((o.leaves.count ?? 10) * 0.08)); o.leaves.size = (o.leaves.size ?? 2) * 0.65; } },
};
// per-species leaf/needle tint (multiplies the per-instance jitter). Dead trees keep a bark-brown husk.
const LEAF_TINT = { 3: [0.60, 0.80, 0.68], 4: [0.52, 0.40, 0.30] };
// NEAR was 190 when only Whisperwood was wooded. A closed canopy there plus Frostveil-as-forest measured
// 4.19 M / 3.88 M tris, trees being 2.17 M of it. The near tier is area-scaled, so this is the dial: 175 m
// holds the frame around 3.6 M against the 4 M budget, and the impostor tier — what you are actually looking
// at past ~140 m — carries the treeline unchanged out to 780 m.
const NEAR = 175, FAR = 780;                // tier split / hard cull (far tier is 6 tris an instance, so the treeline runs to the mountains instead of stopping at 540 m)
const BAND = 26;                            // cross-fade band inside NEAR: real tree dissolves into its impostor
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
    fHead: 'float ezNearT(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }',
    // Dissolve window: 2.6 m was measured too tight. A leaf card is ~1 m across, so at 2.6 m it still spans
    // a fifth of a 95-degree-FOV screen and reads as a black slab slamming past. Fully gone under 1.5 m,
    // fully solid past 4.6 m — long enough that the dither creeps instead of strobing, and canopies you
    // merely walk PAST (their leaves 4.6 m away or more) are untouched.
    fAlpha: 'float ezD = length(vViewPosition); if (ezD < 4.6 && smoothstep(1.5, 4.6, ezD) < ezNearT(gl_FragCoord.xy)) discard;',
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

  // Low-poly tune: raw presets are ~50-100k tris per tree (148M in frame, 29 fps measured).
  const tune = (o) => {
    const b = o.branch, l = o.leaves;
    for (const k in b.children) b.children[k] = Math.max(1, Math.round(b.children[k] * 0.4));
    for (const k in b.sections) b.sections[k] = Math.max(3, Math.round(b.sections[k] * 0.55));
    for (const k in b.segments) b.segments[k] = Math.max(3, Math.round(b.segments[k] * 0.55));
    l.count = Math.max(8, Math.round(l.count * 0.55));
    l.size *= 1.7;
  };

  // bake a variant's unlit albedo side view for the far impostor. Positive-near ortho pulled back
  // (a negative-near frustum rejects everything and bakes pure transparency — learned the hard way).
  const bakeScene = new THREE.Scene();
  function bakeImpostor(t, w, h) {
    const res = 192;
    const rt = new THREE.WebGLRenderTarget(res, res, { format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false });
    const clones = [t.branchesMesh, t.leavesMesh].map((m) => new THREE.Mesh(m.geometry,
      new THREE.MeshBasicMaterial({ map: m.material.map ?? null, alphaTest: 0.4, side: THREE.DoubleSide, color: m.material.color?.clone() ?? 0xffffff })));
    for (const c of clones) { c.frustumCulled = false; bakeScene.add(c); }
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h, 0, 0.1, w * 4);
    cam.position.set(0, 0, w * 2); cam.lookAt(0, 0, 0);
    const prevTone = renderer.toneMapping, prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearAlpha();
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(rt); renderer.setClearAlpha(0); renderer.clear();
    renderer.render(bakeScene, cam);
    renderer.setRenderTarget(prevTarget); renderer.setClearAlpha(prevClear); renderer.toneMapping = prevTone;
    for (const c of clones) { bakeScene.remove(c); c.material.dispose(); }
    rt.texture.colorSpace = THREE.SRGBColorSpace;
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
    // measure from the BRANCH geometry only: the leaf buffer carries stray far-out vertices that
    // blew the measured height to ~186 m (instances shrank to 1 m, bake framed a transparent speck)
    t.branchesMesh.geometry.computeBoundingBox();
    const b1 = t.branchesMesh.geometry.boundingBox;
    const margin = (t.options.leaves?.size ?? 2) * 1.2;
    const h = Math.max(1, b1.max.y + margin * 0.5);
    const w = Math.max(2, Math.max(b1.max.x - b1.min.x, b1.max.z - b1.min.z) + margin);
    const barkMat = patchMaterial(new THREE.MeshStandardMaterial({ map: t.branchesMesh.material.map ?? null, roughness: 0.92, metalness: 0 }),
      { ...fadePatch, key: 'eztree-bark' });
    const leafMat = patchMaterial(new THREE.MeshStandardMaterial({
      map: t.leavesMesh.material.map ?? null, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
      color: t.leavesMesh.material.color?.clone() ?? 0xffffff,
    }), mergePatch(erodeFade(0.4), sway));
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
    const v = { tree: t, branchGeo: t.branchesMesh.geometry, leafGeo: t.leavesMesh.geometry, barkMat, leafMat, cross, impMat: null, w, h };
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
    const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler();
    const C = new THREE.Color();
    const sets = [];
    let count = 0;
    for (const m of maps) { m.needsUpdate = true; renderer.initTexture(m); }   // decoded image -> GPU before the bake samples it
    for (const [v, list] of buckets) {
      // one bake per frame: a burst of six RT renders was a visible boot hitch (perf audit 2026-08-20)
      await new Promise((res) => requestAnimationFrame(res));
      v.impMat = patchMaterial(new THREE.MeshStandardMaterial({ map: bakeImpostor(v.tree, v.w, v.h), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 }),
        { ...erodeFade(0.35), key: 'eztree-impostor' });
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
        if (lt) C.setRGB(tint * lt[0], tint * lt[1], tint * lt[2]);
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
      imp.castShadow = imp.receiveShadow = false;
      trunk.frustumCulled = trunkNS.frustumCulled = leaves.frustumCulled = imp.frustumCulled = false;   // rebucketing is the culling
      trunk.name = 'eztree-trunk'; trunkNS.name = 'eztree-trunk-ns'; leaves.name = 'eztree-leaves'; imp.name = 'eztree-impostor';
      for (const m of [trunk, trunkNS, leaves, imp]) { m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }
      leaves.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
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
        const im = s.imp.instanceMatrix.array, lc = s.leaves.instanceColor.array;
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
          if (d2 >= B2 && d2 < F2) { im.set(src, nf * 16); ffa[nf] = t; nf++; }
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
        up(s.leaves.instanceColor, nn * 3);
        up(s.nearFade, nn); up(s.farFade, nf); up(s.nsFade, nNS);   // nearFade is shared by trunk (nS) and leaves (nn); nn covers both
      }
    };
    // compile every new tree/impostor program NOW, while the boot splash still covers the screen —
    // first-use compiles were landing as multi-hundred-ms hitches in the player's first seconds.
    try { compileForComposer(renderer, game.scene, game.camera); } catch (e) {}
    console.log(`[eztrees] ${count} trees, ${buckets.size} variants, impostors baked in ${(performance.now() - t0).toFixed(0)} ms`);
  });
}
