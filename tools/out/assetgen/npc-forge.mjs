// npc-forge.mjs — batch 3: villagers + corsairs. concept jpg -> Tripo image_to_model -> rig -> download.
//   node tools/out/assetgen/npc-forge.mjs gen      submit the 5 image_to_model tasks (records npc-gen-tasks.txt)
//   node tools/out/assetgen/npc-forge.mjs poll     poll gen tasks; download <name>-hq.glb when done
//   node tools/out/assetgen/npc-forge.mjs rig      submit animate_rig for each downloaded hq glb (records npc-rig-tasks.txt)
//   node tools/out/assetgen/npc-forge.mjs rigpoll  poll rig tasks; download <name>-rigged.glb
// Versions per docs/CREATURE-PIPELINE.md audit: model_version v3.1-20260211 (gen), v2.0-20250506 (rig —
// MUST be passed or animate_rig returns error 1004 with zero credits). ALWAYS records <name>-rig.json.
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.TRIPO_API_KEY;
if (!KEY) { console.error('TRIPO_API_KEY missing'); process.exit(1); }
const API = 'https://api.tripo3d.ai/v2/openapi';
const DIR = path.resolve('tools/out/assetgen/npcs');
const post = async (body) => (await fetch(`${API}/task`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (id) => (await fetch(`${API}/task/${id}`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
const upload = async (file) => {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), path.basename(file));
  const r = await (await fetch(`${API}/upload/sts`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: fd })).json();
  return r?.data?.image_token;
};

const NPCS = ['herbwife-b', 'merchant', 'mason', 'raider', 'captain'];
const tasksFile = (n) => path.join(DIR, n);
const readTasks = (f) => fs.existsSync(tasksFile(f)) ? Object.fromEntries(fs.readFileSync(tasksFile(f), 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' '))) : {};
const writeTask = (f, name, id) => fs.appendFileSync(tasksFile(f), `${name} ${id}\n`);

const cmd = process.argv[2];
if (cmd === 'gen') {
  for (const n of NPCS) {
    const tok = await upload(path.join(DIR, `${n}.jpg`));
    if (!tok) { console.error(`${n}: upload failed`); continue; }
    const r = await post({ type: 'image_to_model', model_version: 'v3.1-20260211', file: { type: 'jpg', file_token: tok }, geometry_quality: 'detailed', texture_quality: 'detailed', face_limit: 60000, pbr: true });
    const id = r?.data?.task_id;
    console.log(n, id ?? JSON.stringify(r));
    if (id) writeTask('npc-gen-tasks.txt', n, id);
  }
} else if (cmd === 'poll' || cmd === 'rigpoll') {
  const rig = cmd === 'rigpoll';
  const tasks = readTasks(rig ? 'npc-rig-tasks.txt' : 'npc-gen-tasks.txt');
  let pending = 0;
  for (const [n, id] of Object.entries(tasks)) {
    const out = path.join(DIR, `${n}${rig ? '-rigged' : '-hq'}.glb`);
    if (fs.existsSync(out)) { console.log(n, 'done (on disk)'); continue; }
    const r = await get(id);
    const st = r?.data?.status;
    if (st === 'success') {
      const url = r.data.output?.pbr_model ?? r.data.output?.model ?? r.data.result?.pbr_model?.url ?? r.data.result?.model?.url;
      if (!url) { console.log(n, 'success but no model url', JSON.stringify(r.data.output ?? r.data.result)); continue; }
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      fs.writeFileSync(out, buf);
      if (rig) fs.writeFileSync(path.join(DIR, `${n}-rig.json`), JSON.stringify({ name: n, rigTask: id }, null, 1));
      console.log(n, st, `-> ${out} (${(buf.length / 1048576).toFixed(2)} MB)`);
    } else { console.log(n, st, r?.data?.progress ?? ''); if (st !== 'failed' && st !== 'banned') pending++; }
  }
  process.exit(pending ? 2 : 0);
} else if (cmd === 'rig') {
  const gens = readTasks('npc-gen-tasks.txt');
  for (const [n, genId] of Object.entries(gens)) {
    const r = await post({ type: 'animate_rig', model_version: 'v2.0-20250506', original_model_task_id: genId, out_format: 'glb', rig_type: 'biped' });
    const id = r?.data?.task_id;
    console.log(n, id ?? JSON.stringify(r));
    if (id) writeTask('npc-rig-tasks.txt', n, id);
  }
} else console.error('usage: gen | poll | rig | rigpoll');

// appended: clips stage — animate_retarget idle+walk per rigged NPC (biped presets)
if (cmd === 'clips') {
  const rigs = readTasks('npc-rig-tasks.txt');
  for (const [n, rigId] of Object.entries(rigs)) {
    for (const clip of ['preset:idle', 'preset:walk']) {
      const r = await post({ type: 'animate_retarget', original_model_task_id: rigId, animation: clip, out_format: 'glb', bake_animation: true });
      const id = r?.data?.task_id;
      console.log(n, clip, id ?? JSON.stringify(r));
      if (id) writeTask('npc-clip-tasks.txt', `${n}|${clip.replace('preset:', '')}`, id);
      await new Promise((r2) => setTimeout(r2, 1200));
    }
  }
} else if (cmd === 'clipspoll') {
  const tasks = readTasks('npc-clip-tasks.txt');
  let pending = 0;
  for (const [key, id] of Object.entries(tasks)) {
    const [n, clip] = key.split('|');
    const out = path.join(DIR, `${n}-${clip}.glb`);
    if (fs.existsSync(out)) { console.log(key, 'done (on disk)'); continue; }
    const r = await get(id);
    const st = r?.data?.status;
    if (st === 'success') {
      const o = r.data.output ?? {};
      const url = o.model ?? o.pbr_model ?? o.animated_model ?? Object.values(o).find((v) => typeof v === 'string' && v.includes('.glb'));
      if (!url) { console.log(key, 'success but no url'); continue; }
      fs.writeFileSync(out, Buffer.from(await (await fetch(url)).arrayBuffer()));
      console.log(key, '->', out);
    } else { console.log(key, st); if (st !== 'failed' && st !== 'banned') pending++; }
  }
  process.exit(pending ? 2 : 0);
}
