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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Tree } from '@dgreenheck/ez-tree';
import { patchMaterial } from './Vegetation.js';

// species mapping: 0 slender birch-alike, 1 gnarled broadleaf, 2 shore willow (closest: droopy ash)
const POOLS = [
  ['Aspen Medium', 'Ash Medium', 'Aspen Large'],
  ['Oak Medium', 'Oak Large'],
  ['Ash Large'],
];
const TARGET_H = { 0: 13, 1: 12, 2: 11 };   // metres; instance scale multiplies on top
const NEAR = 190, FAR = 540;                // tier split / hard cull (far tier is cheap, so see further than the old 420 m cull)

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
    fAlpha: 'float ezD = length(vViewPosition); if (ezD < 2.6 && smoothstep(1.0, 2.6, ezD) < ezNearT(gl_FragCoord.xy)) discard;',
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

  const makeVariant = (preset, seed) => {
    const key = preset + seed;
    if (cache[key]) return cache[key];
    const t = new Tree();
    t.loadPreset(preset);
    t.options.seed = seed;
    tune(t.options);
    t.generate();
    // measure from the BRANCH geometry only: the leaf buffer carries stray far-out vertices that
    // blew the measured height to ~186 m (instances shrank to 1 m, bake framed a transparent speck)
    t.branchesMesh.geometry.computeBoundingBox();
    const b1 = t.branchesMesh.geometry.boundingBox;
    const margin = (t.options.leaves?.size ?? 2) * 1.2;
    const h = Math.max(1, b1.max.y + margin * 0.5);
    const w = Math.max(2, Math.max(b1.max.x - b1.min.x, b1.max.z - b1.min.z) + margin);
    const barkMat = new THREE.MeshStandardMaterial({ map: t.branchesMesh.material.map ?? null, roughness: 0.92, metalness: 0 });
    const leafMat = patchMaterial(new THREE.MeshStandardMaterial({
      map: t.leavesMesh.material.map ?? null, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
      color: t.leavesMesh.material.color?.clone() ?? 0xffffff,
    }), sway);
    const q0 = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0);
    const q1 = q0.clone().rotateY(Math.PI / 2);
    const cross = mergeGeometries([q0, q1]);
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
    const v = makeVariant(preset, seedBase + (tr.species + 1) * 37);
    let b = buckets.get(v); if (!b) buckets.set(v, b = []);
    b.push(tr);
  }

  // ez-tree's embedded data-URI textures decode async — bake only after they are actually loaded
  const maps = [...new Set([...buckets.keys()].flatMap((v) => [v.barkMat.map, v.leafMat.map].filter(Boolean)))];
  const ready = Promise.all(maps.map((m) => {
    const img = m.image;
    if (!img || img.complete) return null;
    return new Promise((res) => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); });
  }));

  ready.then(async () => {
    const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler();
    const C = new THREE.Color();
    const sets = [];
    let count = 0;
    for (const m of maps) { m.needsUpdate = true; renderer.initTexture(m); }   // decoded image -> GPU before the bake samples it
    for (const [v, list] of buckets) {
      // one bake per frame: a burst of six RT renders was a visible boot hitch (perf audit 2026-08-20)
      await new Promise((res) => requestAnimationFrame(res));
      v.impMat = new THREE.MeshStandardMaterial({ map: bakeImpostor(v.tree, v.w, v.h), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
      const n = list.length;
      // static per-instance data, written once; rebucketing rewrites the mesh instance buffers from it
      const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3), xz = new Float32Array(n * 2);
      list.forEach((tr, k) => {
        const s = ((TARGET_H[tr.species] ?? 13) / v.h) * tr.scale;
        E.set(0, ((tr.x * 31 + tr.z * 17) % 628) / 100, 0); Q.setFromEuler(E);
        P.set(tr.x, tr.y - 0.15 * s, tr.z); S.setScalar(s); M.compose(P, Q, S);
        mats.set(M.elements, k * 16);
        const tint = 0.82 + ((tr.x * 13 + tr.z * 7) % 10) * 0.03;
        C.setRGB(tint * 0.95, tint, tint * 0.9);
        cols.set([C.r, C.g, C.b], k * 3);
        xz[k * 2] = tr.x; xz[k * 2 + 1] = tr.z;
      });
      const trunk = new THREE.InstancedMesh(v.branchGeo, v.barkMat, n);
      const leaves = new THREE.InstancedMesh(v.leafGeo, v.leafMat, n);
      const imp = new THREE.InstancedMesh(v.cross, v.impMat, n);
      trunk.castShadow = trunk.receiveShadow = true;
      leaves.castShadow = false; leaves.receiveShadow = false;   // leaf shadow pass cost >> its read
      imp.castShadow = imp.receiveShadow = false;
      trunk.frustumCulled = leaves.frustumCulled = imp.frustumCulled = false;   // rebucketing is the culling
      trunk.name = 'eztree-trunk'; leaves.name = 'eztree-leaves'; imp.name = 'eztree-impostor';
      for (const m of [trunk, leaves, imp]) { m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }
      leaves.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
      game.scene.add(trunk, leaves, imp);
      sets.push({ mats, cols, xz, n, trunk, leaves, imp });
      count += n;
    }

    // rebucket near/far on movement; hooked into the render loop via one probe object
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
      if (p.distanceToSquared(last) < 36) return;
      last.copy(p);
      const N2 = NEAR * NEAR, F2 = FAR * FAR;
      for (const s of sets) {
        let nn = 0, nf = 0;
        const tm = s.trunk.instanceMatrix.array, im = s.imp.instanceMatrix.array, lc = s.leaves.instanceColor.array;
        for (let i = 0; i < s.n; i++) {
          const dx = s.xz[i * 2] - p.x, dz = s.xz[i * 2 + 1] - p.z, d2 = dx * dx + dz * dz;
          if (d2 < N2) { tm.set(s.mats.subarray(i * 16, i * 16 + 16), nn * 16); lc.set(s.cols.subarray(i * 3, i * 3 + 3), nn * 3); nn++; }
          else if (d2 < F2) { im.set(s.mats.subarray(i * 16, i * 16 + 16), nf * 16); nf++; }
        }
        s.leaves.instanceMatrix.array.set(tm.subarray(0, nn * 16));
        s.trunk.count = s.leaves.count = nn; s.imp.count = nf;
        s.trunk.instanceMatrix.needsUpdate = s.leaves.instanceMatrix.needsUpdate = s.imp.instanceMatrix.needsUpdate = true;
        s.leaves.instanceColor.needsUpdate = true;
      }
    };
    // compile every new tree/impostor program NOW, while the boot splash still covers the screen —
    // first-use compiles were landing as multi-hundred-ms hitches in the player's first seconds.
    try { renderer.compile(game.scene, game.camera); } catch (e) {}
    console.log(`[eztrees] ${count} trees, ${buckets.size} variants, impostors baked in ${(performance.now() - t0).toFixed(0)} ms`);
  });
}
