// Experimental tree replacement using @dgreenheck/ez-tree (MIT, textures embedded in the build —
// no external fetch). Enabled with ?eztrees=1: generates a handful of preset variants at init,
// merges each into two instanced geometries (branches + leaves) and places them at the exact
// positions the normal tree system rolled, replacing it wholesale.
//
// Status: EVALUATION build. Full geometry at every distance — no impostor LOD, no wind sway yet.
// If the fps holds, the follow-up is wiring these geometries through Vegetation's InstLOD +
// impostor bake so far trees stay cheap; if it doesn't, that wiring is mandatory before default-on.
import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';

// species mapping: 0 slender birch-alike, 1 gnarled broadleaf, 2 shore willow (closest: droopy ash)
const POOLS = [
  ['Aspen Medium', 'Ash Medium', 'Aspen Large'],
  ['Oak Medium', 'Oak Large'],
  ['Ash Large'],
];
const TARGET_H = { 0: 13, 1: 12, 2: 11 };   // metres; instance scale multiplies on top

export function buildEZTrees(game, trees) {
  const t0 = performance.now();
  const variants = [];   // per unique preset: { branchGeo, leafGeo, barkMat, leafMat, h }
  const cache = {};
  const seedBase = (game.seed | 0) || 1;

  const makeVariant = (preset, seed) => {
    const key = preset + seed;
    if (cache[key]) return cache[key];
    const t = new Tree();
    t.loadPreset(preset);
    t.options.seed = seed;
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
    const seed = seedBase + (tr.species + 1) * 37 + ((Math.abs(tr.x + tr.z * 3) | 0) % 3) * 101;
    const v = makeVariant(preset, seed);
    let b = buckets.get(v); if (!b) buckets.set(v, b = []);
    b.push(tr); i++;
  }

  const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler();
  const C = new THREE.Color();
  let draws = 0;
  for (const [v, list] of buckets) {
    const trunk = new THREE.InstancedMesh(v.branchGeo, v.barkMat, list.length);
    const leaves = new THREE.InstancedMesh(v.leafGeo, v.leafMat, list.length);
    trunk.castShadow = trunk.receiveShadow = true;
    leaves.castShadow = true; leaves.receiveShadow = false;
    trunk.frustumCulled = leaves.frustumCulled = false;
    trunk.name = 'eztree-trunk'; leaves.name = 'eztree-leaves';
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
    draws += 2;
  }
  console.log(`[eztrees] ${i} trees, ${variants.length} variants, ${draws} draw calls, generated in ${(performance.now() - t0).toFixed(0)} ms`);
}
