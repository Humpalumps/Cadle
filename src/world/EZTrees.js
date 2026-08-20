// Experimental tree replacement using @dgreenheck/ez-tree (MIT, textures embedded in the build —
// no external fetch). Enabled with ?eztrees=1: generates a handful of preset variants at init,
// merges each into two instanced geometries (branches + leaves) and places them at the exact
// positions the normal tree system rolled, replacing it wholesale.
//
// DEFAULT tree system (?eztrees=0 restores the legacy card trees). Full geometry with chunked
// frustum culling and a 420 m distance cull — the far forest sits behind the haze anyway.
// ponytail: a baked far-impostor tier would buy the last few fps; the InstLOD wiring attempt hit a
// placement bug under the usage deadline — worth revisiting with time to debug visually.
import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';

// species mapping: 0 slender birch-alike, 1 gnarled broadleaf, 2 shore willow (closest: droopy ash)
const POOLS = [
  ['Aspen Medium', 'Ash Medium', 'Aspen Large'],
  ['Oak Medium', 'Oak Large'],
  ['Ash Large'],
];
const TARGET_H = { 0: 13, 1: 12, 2: 11 };   // metres; instance scale multiplies on top

export function buildEZTrees(game, trees, vegetation) {
  const t0 = performance.now();
  const variants = [];   // per unique preset: { branchGeo, leafGeo, barkMat, leafMat, h }
  const cache = {};
  const seedBase = (game.seed | 0) || 1;

  // Low-poly tune: the raw presets are ~50-100k tris per tree (148M in frame, 29 fps measured).
  // Fewer child branches and coarser tubes cut ~70% of the geometry; slightly larger leaves keep
  // the canopy coverage with fewer quads. Target ~5-8k tris per tree.
  const tune = (o) => {
    const b = o.branch, l = o.leaves;
    for (const k in b.children) b.children[k] = Math.max(1, Math.round(b.children[k] * 0.4));
    for (const k in b.sections) b.sections[k] = Math.max(3, Math.round(b.sections[k] * 0.55));
    for (const k in b.segments) b.segments[k] = Math.max(3, Math.round(b.segments[k] * 0.55));
    l.count = Math.max(8, Math.round(l.count * 0.55));
    l.size *= 1.7;
  };

  const makeVariant = (preset, seed) => {
    const key = preset + seed;
    if (cache[key]) return cache[key];
    const t = new Tree();
    t.loadPreset(preset);
    t.options.seed = seed;
    tune(t.options);
    t.generate();
    const bb = new THREE.Box3().setFromObject(t);
    const h = Math.max(1, bb.max.y);
    const barkMap = t.branchesMesh.material.map ?? null;
    const leafMap = t.leavesMesh.material.map ?? null;
    const barkMat = new THREE.MeshStandardMaterial({ map: barkMap, roughness: 0.92, metalness: 0 });
    const leafMat = new THREE.MeshStandardMaterial({
      map: leafMap, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
      color: t.leavesMesh.material.color?.clone() ?? 0xffffff,
    });
    game.lighting?.csm?.setupMaterial?.(barkMat);
    game.lighting?.csm?.setupMaterial?.(leafMat);
    const v = { branchGeo: t.branchesMesh.geometry, leafGeo: t.leavesMesh.geometry, barkMat, leafMat, h };
    cache[key] = v; variants.push(v);
    return v;
  };

  // bucket instances per variant
  const buckets = new Map();
  let i = 0;
  for (const tr of trees) {
    const pool = POOLS[tr.species] ?? POOLS[0];
    const preset = pool[(Math.abs((tr.x * 7 + tr.z * 13) | 0)) % pool.length];
    const seed = seedBase + (tr.species + 1) * 37;   // one seed per preset: every extra variant multiplies chunked draw calls
    const v = makeVariant(preset, seed);
    let b = buckets.get(v); if (!b) buckets.set(v, b = []);
    b.push(tr); i++;
  }

  const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler();
  const C = new THREE.Color();
  let draws = 0;
  // split each variant's instances into a coarse world grid so off-screen chunks frustum-cull
  // (one world-spanning InstancedMesh can never be culled; behind-the-camera trees were free tris)
  const CHUNK = 256;
  const chunks = [];
  const chunked = new Map();
  for (const [v, list] of buckets) for (const tr of list) {
    const key = ((tr.x + 512) / CHUNK | 0) + '_' + ((tr.z + 512) / CHUNK | 0);
    let m = chunked.get(v); if (!m) chunked.set(v, m = new Map());
    let arr = m.get(key); if (!arr) m.set(key, arr = []);
    arr.push(tr);
  }
  for (const [v, cells] of chunked) for (const list of cells.values()) {
    const trunk = new THREE.InstancedMesh(v.branchGeo, v.barkMat, list.length);
    const leaves = new THREE.InstancedMesh(v.leafGeo, v.leafMat, list.length);
    trunk.castShadow = trunk.receiveShadow = true;
    leaves.castShadow = false; leaves.receiveShadow = false;   // leaf shadow pass cost >> its read; trunks still ground the trees
    trunk.name = 'eztree-trunk'; leaves.name = 'eztree-leaves';
    let cx = 0, cz = 0; for (const tr of list) { cx += tr.x; cz += tr.z; } cx /= list.length; cz /= list.length;
    let rr = 0; for (const tr of list) rr = Math.max(rr, Math.hypot(tr.x - cx, tr.z - cz));
    const bs = new THREE.Sphere(new THREE.Vector3(cx, 10, cz), rr + 24);
    trunk.geometry = v.branchGeo.clone(); trunk.geometry.boundingSphere = bs;
    leaves.geometry = v.leafGeo.clone(); leaves.geometry.boundingSphere = bs;
    list.forEach((tr, k) => {
      const norm = (TARGET_H[tr.species] ?? 13) / v.h;
      const s = norm * tr.scale;
      E.set(0, ((tr.x * 31 + tr.z * 17) % 628) / 100, 0); Q.setFromEuler(E);
      P.set(tr.x, tr.y - 0.15 * s, tr.z); S.setScalar(s); M.compose(P, Q, S);
      trunk.setMatrixAt(k, M); leaves.setMatrixAt(k, M);
      const tint = 0.82 + ((tr.x * 13 + tr.z * 7) % 10) * 0.03;
      C.setRGB(tint * 0.95, tint, tint * 0.9);
      leaves.setColorAt(k, C);
    });
    trunk.instanceMatrix.needsUpdate = true; leaves.instanceMatrix.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    game.scene.add(trunk, leaves);
    chunks.push({ cx, cz, meshes: [trunk, leaves] });
    draws += 2;
  }
  // distance cull: chunks fully beyond the haze line contribute tris nobody can read.
  // piggyback on the render loop via one onBeforeRender hook (no system wiring needed).
  const CULL = 420;
  const probe = new THREE.Object3D(); probe.frustumCulled = false; game.scene.add(probe);
  probe.onBeforeRender = (r, sc, cam) => {
    const p = cam.position;
    for (const c of chunks) {
      const vis = Math.hypot(c.cx - p.x, c.cz - p.z) < CULL;
      if (c.meshes[0].visible !== vis) { c.meshes[0].visible = vis; c.meshes[1].visible = vis; }
    }
  };
  console.log(`[eztrees] ${i} trees, ${variants.length} variants, ${draws} draw calls, generated in ${(performance.now() - t0).toFixed(0)} ms`);
}
