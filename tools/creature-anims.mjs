#!/usr/bin/env node
// Baked locomotion for the rigged creatures.   node tools/creature-anims.mjs fetch|merge [name...]
//
// WHY THIS EXISTS: docs/CREATURE-PIPELINE.md's route is "locomotion (idle/walk/run) from Tripo
// presets, attacks/stagger/death procedural" — a baked clip cannot be cut off mid-swing when the
// enemy is staggered and attack timing has to line up with damage windows, but a walk cycle is
// periodic, needs no combat sync, and a retargeted one reads far better than a rotation gait.
// Only the hound ever got a clip, so the other eight were left on the fallback path.
//
//   fetch  submits animate_retarget for every (creature, clip) pair against the RECORDED rig task
//          ids in tools/out/assetgen/creatures/rig-tasks.txt, polls, and downloads each result to
//          tools/out/assetgen/tripo/anim/<name>-<clip>.glb
//   merge  copies those clips' animation channels onto <name>-rigged.glb by NODE NAME (same rig
//          task => same skeleton => exact match) and writes <name>-animated.glb, which is then the
//          input to optimize-creature.mjs. Merging BEFORE the optimiser is deliberate: the joint
//          prune is animation-aware (see tools/creature-joints.mjs) and can only stay correct if
//          it can see the clips.
//
// Preset names are NOT free-form. Tested on a quadruped rig: preset:{slash,hurt,idle,run,walk,jump,
// shoot} all accept, and the quadruped: namespace has ONLY preset:quadruped:walk — quadruped:run,
// quadruped:idle and quadruped:attack are rejected as invalid names.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const KEY = process.env.TRIPO_API_KEY;
const API = 'https://api.tripo3d.ai/v2/openapi';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const TRIPO_DIR = `${ROOT}/tools/out/assetgen/tripo`;
const ANIM_DIR = `${TRIPO_DIR}/anim`;

// Clip sets by rig type. Keep them SHORT: three locomotion states is what the game blends between,
// and every extra clip is another ~25 credits and another track in the shipped payload.
const CLIPS = {
  quadruped: ['preset:quadruped:walk', 'preset:idle', 'preset:run'],
  biped: ['preset:walk', 'preset:idle', 'preset:run'],
  avian: ['preset:idle', 'preset:walk'],
  serpentine: ['preset:idle', 'preset:walk'],
  others: ['preset:idle', 'preset:walk'],
};
const slug = (c) => c.replace('preset:', '').replace(/:/g, '-');

function rigTasks() {
  const f = `${ROOT}/tools/out/assetgen/creatures/rig-tasks.txt`;
  return readFileSync(f, 'utf8').trim().split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => {
    const [name, rig, id] = l.trim().split(/\s+/);
    return { name, rig, id };
  });
}
const post = async (body) => (await fetch(`${API}/task`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (id) => (await fetch(`${API}/task/${id}`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAll(only) {
  if (!KEY) { console.error('TRIPO_API_KEY not set'); process.exit(2); }
  mkdirSync(ANIM_DIR, { recursive: true });
  const jobs = [];
  for (const { name, rig, id } of rigTasks()) {
    if (only.length && !only.includes(name)) continue;
    for (const clip of (CLIPS[rig] ?? CLIPS.others)) {
      const out = `${ANIM_DIR}/${name}-${slug(clip)}.glb`;
      if (existsSync(out)) { console.log(`skip ${name} ${clip} (already downloaded)`); continue; }
      const r = await post({ type: 'animate_retarget', original_model_task_id: id, animation: clip, out_format: 'glb', bake_animation: true });
      if (r.code !== 0) { console.log(`FAIL submit ${name} ${clip}: ${JSON.stringify(r)}`); continue; }
      jobs.push({ name, clip, out, task: r.data.task_id });
      console.log(`submitted ${name} ${clip} -> ${r.data.task_id}`);
      await sleep(1200);                          // a burst of ~10 is fine; beyond that it returns code 2000
    }
  }
  const done = [];
  for (let round = 0; jobs.length && round < 90; round++) {
    await sleep(20000);
    for (const j of [...jobs]) {
      const s = await get(j.task);
      const st = s?.data?.status;
      if (st === 'success') {
        const o = s.data.output ?? {};
        const url = o.model ?? o.pbr_model ?? o.rigged_model ?? o.animated_model
          ?? Object.values(o).find((v) => typeof v === 'string' && v.includes('.glb'));
        if (!url) { console.log(`? ${j.name} ${j.clip}: success but no glb in ${JSON.stringify(o)}`); jobs.splice(jobs.indexOf(j), 1); continue; }
        writeFileSync(j.out, Buffer.from(await (await fetch(url)).arrayBuffer()));
        console.log(`OK ${j.name} ${j.clip} -> ${j.out}`);
        done.push(j); jobs.splice(jobs.indexOf(j), 1);
      } else if (st === 'failed' || st === 'banned' || st === 'cancelled') {
        console.log(`FAIL ${j.name} ${j.clip}: ${JSON.stringify(s.data)}`);
        jobs.splice(jobs.indexOf(j), 1);
      }
    }
  }
  console.log(`\ndownloaded ${done.length} clips; ${jobs.length} still pending after the poll window`);
}

async function mergeAll(only) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  for (const { name, rig } of rigTasks()) {
    if (only.length && !only.includes(name)) continue;
    const base = `${TRIPO_DIR}/${name}-rigged.glb`;
    if (!existsSync(base)) { console.log(`skip ${name}: no rigged source`); continue; }
    const doc = await io.read(base);
    const buf = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
    const byName = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));
    let added = 0;
    for (const clip of (CLIPS[rig] ?? CLIPS.others)) {
      const f = `${ANIM_DIR}/${name}-${slug(clip)}.glb`;
      if (!existsSync(f)) continue;
      const src = await io.read(f);
      for (const anim of src.getRoot().listAnimations()) {
        const dst = doc.createAnimation(slug(clip));       // name it by CLIP, not by whatever Tripo called it
        let kept = 0;
        for (const ch of anim.listChannels()) {
          const target = byName.get(ch.getTargetNode()?.getName());
          const s = ch.getSampler();
          if (!target || !s) continue;
          const cp = (acc) => doc.createAccessor().setArray(acc.getArray().slice()).setType(acc.getType()).setBuffer(buf);
          const ns = doc.createAnimationSampler().setInterpolation(s.getInterpolation()).setInput(cp(s.getInput())).setOutput(cp(s.getOutput()));
          dst.addSampler(ns);
          dst.addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(ch.getTargetPath()).setSampler(ns));
          kept++;
        }
        if (kept) { added++; console.log(`  ${name}: +${slug(clip)} (${kept} channels)`); } else dst.dispose();
        break;                                             // one clip per retarget task
      }
    }
    if (!added) { console.log(`${name}: no clips found, nothing merged`); continue; }
    const out = `${TRIPO_DIR}/${name}-animated.glb`;
    await io.write(out, doc);
    console.log(`${name}: ${added} clip(s) -> ${out}`);
  }
}

const [, , cmd, ...only] = process.argv;
if (cmd === 'fetch') await fetchAll(only);
else if (cmd === 'merge') await mergeAll(only);
else { console.error('usage: creature-anims.mjs fetch|merge [name...]'); process.exit(2); }
