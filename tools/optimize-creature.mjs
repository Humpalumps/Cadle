#!/usr/bin/env node
// Optimise a rigged creature GLB for shipping.  node tools/optimize-creature.mjs <in.glb> <out.glb> [--tris N]
//
// Runs the SAME open codecs the online GLB optimisers use (they are gltf-transform front-ends), locally:
// no asset upload, reproducible in the build, and identical ratios because the compression is meshopt /
// KTX2-Basis, not anything proprietary.
//
// Choices, and why:
//   meshopt (not Draco) — decodes far faster and download size is not a constraint for us (assets come
//     down behind the loading screen or ship in a Steam package). Boot time is the thing we are short of.
//   textures resized to 1024 — Tripo emits 4096, which is ~16x the texels for a creature that is rarely
//     more than a few hundred pixels tall on screen.
//   simplify to the tier budget — see docs/CREATURE-PIPELINE.md (4k small / 10k standard / 15k complex).
//   weld+dedup+prune+flatten+join — these are what collapse a multi-mesh export into few draw calls,
//     which is the axis that actually binds us at 72 enemies alive (draw calls, not triangles).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, join, flatten, simplify, textureCompress, resample, quantize } from '@gltf-transform/functions';
import { pruneJoints } from './creature-joints.mjs';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const [, , inPath, outPath, ...rest] = process.argv;
if (!inPath || !outPath) { console.error('usage: optimize-creature.mjs <in.glb> <out.glb> [--tris N] [--joints N]'); process.exit(2); }
const arg = (name, dflt) => Number((rest.find((a) => a.startsWith(name)) || '').split('=')[1] || rest[rest.indexOf(name) + 1] || dflt);
const targetTris = arg('--tris', 10000);
// Crowd skeletons run 20-40 joints in a shipped game; Tripo hands back 34-101. See tools/creature-joints.mjs.
const targetJoints = arg('--joints', 32);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inPath);

const count = () => doc.getRoot().listMeshes().reduce((t, m) => t + m.listPrimitives().reduce((s, p) => {
  const idx = p.getIndices(); const pos = p.getAttribute('POSITION');
  return s + ((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
}, 0), 0);
const meshCount = () => doc.getRoot().listMeshes().length;
const before = { tris: Math.round(count()), meshes: meshCount(), bytes: readFileSync(inPath).length };
const beforeJoints = doc.getRoot().listSkins().map((s) => s.listJoints().length);

// Order matters: clean up first, then WELD IN ITS OWN PASS (the simplify ratio has to be computed against
// the welded triangle count — computing it from the pre-weld count is what left every model in batch 1
// sitting 1.3-5x over its tier target: a Tripo export is non-indexed, so count() before weld reads roughly
// double the real figure and the ratio comes out roughly half as aggressive as asked for).
await doc.transform(dedup(), prune({ keepAttributes: false, keepLeaves: false }), weld());

// Simplify to the tier budget, iterating: meshopt's ratio is a request, not a guarantee (it stops early
// when further collapses would exceed `error`), so one pass regularly lands over target on a dense mesh.
for (let pass = 0; pass < 3; pass++) {
  const now = count();
  if (now <= targetTris * 1.05) break;
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, targetTris / Math.max(1, now)), error: 0.0015 + pass * 0.0015, lockBorder: false }));
  if (Math.abs(count() - now) < now * 0.01) break;             // converged: further passes are no-ops
}

const jointLog = [];
await doc.transform(
  pruneJoints(targetJoints, 0.012, (m) => jointLog.push(m)),   // BEFORE quantize: JOINTS_0/WEIGHTS_0 are rewritten in place
  flatten(),
  join({ keepNamed: false }),
  resample(),                                   // drop redundant animation keyframes
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
  quantize({ pattern: /^(POSITION|TEXCOORD|NORMAL|COLOR)(_\d+)?$/ }),
);

await io.write(outPath, doc);
const after = { tris: Math.round(count()), meshes: meshCount(), bytes: readFileSync(outPath).length };
const skins = doc.getRoot().listSkins().map((s) => s.listJoints().length);
console.log(JSON.stringify({
  in: inPath.split(/[\\/]/).pop(), out: outPath.split(/[\\/]/).pop(),
  tris: `${before.tris} -> ${after.tris}`,
  meshes: `${before.meshes} -> ${after.meshes}`,
  MB: `${(before.bytes / 1048576).toFixed(2)} -> ${(after.bytes / 1048576).toFixed(2)}`,
  joints: `${beforeJoints} -> ${skins}`, jointLog, animations: doc.getRoot().listAnimations().map((a) => a.getName()),
}, null, 1));
