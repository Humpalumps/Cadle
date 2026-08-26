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
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const [, , inPath, outPath, ...rest] = process.argv;
if (!inPath || !outPath) { console.error('usage: optimize-creature.mjs <in.glb> <out.glb> [--tris N]'); process.exit(2); }
const targetTris = Number((rest.find((a) => a.startsWith('--tris')) || '').split('=')[1] || rest[rest.indexOf('--tris') + 1] || 10000);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inPath);

const count = () => doc.getRoot().listMeshes().reduce((t, m) => t + m.listPrimitives().reduce((s, p) => {
  const idx = p.getIndices(); const pos = p.getAttribute('POSITION');
  return s + ((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
}, 0), 0);
const meshCount = () => doc.getRoot().listMeshes().length;
const before = { tris: Math.round(count()), meshes: meshCount(), bytes: readFileSync(inPath).length };

// Order matters: clean up first, then weld (so simplify has shared vertices to collapse across), then
// simplify, then join/flatten to cut draw calls, then compress.
await doc.transform(
  dedup(),
  prune({ keepAttributes: false, keepLeaves: false }),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, targetTris / Math.max(1, count())), error: 0.0015, lockBorder: false }),
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
  joints: skins, animations: doc.getRoot().listAnimations().map((a) => a.getName()),
}, null, 1));
