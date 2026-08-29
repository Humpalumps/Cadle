#!/usr/bin/env node
// Merge the Tripo idle+walk retarget clips onto each NPC's rigged GLB, BEFORE the optimiser
// (docs/CREATURE-PIPELINE.md: the joint prune is animation-aware and must see the clips).
// Same mechanism as tools/creature-anims.mjs mergeAll: same rig task => same skeleton => channel
// copy by NODE NAME is an exact match. Run from repo root:
//   node tools/out/assetgen/npcs/merge-npc-anims.mjs
import { existsSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const DIR = 'tools/out/assetgen/npcs';
// herbwife-a, not -b: herbwife-b generated twice and prerigchecked riggable:false both times (the
// long-skirt silhouette defeats Tripo's limb detection); herbwife-a is the same character from the
// same approved concept sheet and rigs riggable:true.
const NAMES = ['herbwife-a', 'merchant', 'mason', 'raider', 'captain'];
const CLIPS = ['idle', 'walk'];
// CHANNEL SURGERY for the two rigs whose retargets mangle the upper body: Tripo labeled the SPINE
// as an arm chain (mason: Spine_0 -> "0_Right_Limb_0/1" -> Head_0; herbwife-a: Root ->
// "0_Left_Limb_0" -> ... -> Head_0), so the preset retarget drives the torso/neck with arm-raise
// motion — the head buries itself and one arm flies up. Verified fix (rendered): drop every channel
// targeting that subtree; the upper body holds bind pose while Root + both leg chains keep their
// tracks — legs step, head stays on. Runtime procedural hooks animate upper-body bones anyway.
const DROP_SUBTREE = { mason: 'tripo::0_Right_Limb_0', 'herbwife-a': 'tripo::0_Left_Limb_0' };

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const name of NAMES) {
  const base = `${DIR}/${name}-rigged.glb`;
  if (!existsSync(base)) { console.log(`skip ${name}: no rigged source`); continue; }
  const doc = await io.read(base);
  const buf = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const byName = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));
  const bad = new Set();
  if (DROP_SUBTREE[name]) {
    const mark = (n) => { if (!n) return; bad.add(n); for (const c of n.listChildren()) mark(c); };
    mark(byName.get(DROP_SUBTREE[name]));
    console.log(`  ${name}: dropping channels for ${bad.size} joints under ${DROP_SUBTREE[name]}`);
  }
  let added = 0;
  for (const clip of CLIPS) {
    const f = `${DIR}/${name}-${clip}.glb`;
    if (!existsSync(f)) { console.log(`  ${name}: MISSING ${clip} clip file`); continue; }
    const src = await io.read(f);
    for (const anim of src.getRoot().listAnimations()) {
      const dst = doc.createAnimation(clip);            // name it by CLIP, not whatever Tripo called it
      let kept = 0, dropped = 0;
      for (const ch of anim.listChannels()) {
        const target = byName.get(ch.getTargetNode()?.getName());
        const s = ch.getSampler();
        if (!target || !s || bad.has(target)) { dropped++; continue; }
        const cp = (acc) => doc.createAccessor().setArray(acc.getArray().slice()).setType(acc.getType()).setBuffer(buf);
        const ns = doc.createAnimationSampler().setInterpolation(s.getInterpolation()).setInput(cp(s.getInput())).setOutput(cp(s.getOutput()));
        dst.addSampler(ns);
        dst.addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(ch.getTargetPath()).setSampler(ns));
        kept++;
      }
      if (kept) {
        // IN-PLACE FIX: unlike the quadruped presets, biped preset:walk TRAVELS (tripo::Root moves
        // ~1.7 m on z per cycle). A traveling clip fights the AI-driven root.position, so detrend
        // the skeleton root's ground-plane translation: subtract the linear first->last component
        // per axis (x,z). Gait oscillation survives; both ends map to the same value, so the loop
        // stays seamless. Y (bob) is untouched.
        const skelRoot = doc.getRoot().listSkins()[0]?.listJoints()[0];
        for (const ch of dst.listChannels()) {
          if (ch.getTargetPath() !== 'translation' || ch.getTargetNode() !== skelRoot) continue;
          const s = ch.getSampler();
          const t = s.getInput().getArray(), o = s.getOutput().getArray().slice();
          const n = t.length, span = t[n - 1] - t[0] || 1;
          for (const ax of [0, 2]) {
            const drift = o[(n - 1) * 3 + ax] - o[ax];
            if (Math.abs(drift) < 0.02) continue;
            for (let i = 0; i < n; i++) o[i * 3 + ax] -= ((t[i] - t[0]) / span) * drift;
            console.log(`    ${name}/${clip}: detrended root ${ax === 0 ? 'x' : 'z'} drift ${drift.toFixed(3)} m`);
          }
          s.getOutput().setArray(o);
        }
        added++; console.log(`  ${name}: +${clip} (${kept} channels, ${dropped} unmatched)`);
      } else dst.dispose();
      break;                                            // one clip per retarget task
    }
  }
  if (!added) { console.log(`${name}: no clips merged`); continue; }
  const out = `${DIR}/${name}-animated.glb`;
  await io.write(out, doc);
  console.log(`${name}: ${added} clip(s) -> ${out}`);
}
