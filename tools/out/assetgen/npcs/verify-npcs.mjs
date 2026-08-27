#!/usr/bin/env node
// Verify the staged NPC GLBs: clips present, root motion ~0, one mesh/material, tris/joints on tier.
import { readFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const name of ['herbwife', 'merchant', 'mason', 'raider', 'captain']) {
  const path = `public/assets/creatures/${name}.glb`;
  const doc = await io.read(path);
  const root = doc.getRoot();
  const tris = Math.round(root.listMeshes().reduce((t, m) => t + m.listPrimitives().reduce((s, p) => {
    const idx = p.getIndices(); const pos = p.getAttribute('POSITION');
    return s + ((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
  }, 0), 0));
  const joints = root.listSkins().map((s) => s.listJoints().length);
  const skel = root.listSkins()[0]?.listJoints()[0];        // skeleton root joint
  const clips = root.listAnimations().map((a) => {
    let dur = 0, rootRange = 0;
    for (const ch of a.listChannels()) {
      const s = ch.getSampler(); if (!s) continue;
      const inp = s.getInput().getArray();
      dur = Math.max(dur, inp[inp.length - 1]);
      if (ch.getTargetPath() === 'translation' && (ch.getTargetNode() === skel || /root/i.test(ch.getTargetNode()?.getName() ?? ''))) {
        const o = s.getOutput().getArray();
        for (const axis of [0, 2]) {                        // x,z ground-plane drift only (y bobs)
          let mn = Infinity, mx = -Infinity;
          for (let i = axis; i < o.length; i += 3) { mn = Math.min(mn, o[i]); mx = Math.max(mx, o[i]); }
          rootRange = Math.max(rootRange, mx - mn);
        }
      }
    }
    return `${a.getName()}: ${dur.toFixed(2)}s ${a.listChannels().length}ch rootXZ=${rootRange.toFixed(3)}`;
  });
  console.log(JSON.stringify({
    name, tris, joints,
    meshes: root.listMeshes().length, materials: root.listMaterials().length,
    MB: (readFileSync(path).length / 1048576).toFixed(2), clips,
  }));
}
