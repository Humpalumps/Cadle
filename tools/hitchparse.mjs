#!/usr/bin/env node
// TEMP DIAGNOSTIC: stream tools/out/hitchprobe/trace.json (hundreds of MB) and report the long slices.
// Chrome writes one trace event per line, so a line reader is enough.
//   node tools/hitchparse.mjs <trace.json> <minUs> [nameFilterRegex]
import fs from 'node:fs';
import readline from 'node:readline';
const file = process.argv[2] || 'tools/out/hitchprobe/trace.json';
const MIN = +(process.argv[3] || 15000);
const FILT = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;

const long = [], names = new Map(), pn = new Map(), tn = new Map();
let total = 0;
const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 22 }), crlfDelay: Infinity });
for await (const line of rl) {
  let s = line.trim();
  const i = s.indexOf('{'); if (i < 0) continue; s = s.slice(i).replace(/,$/, '').replace(/\]\}$/, '');
  let e; try { e = JSON.parse(s); } catch { continue; }
  total++;
  if (e.ph === 'M') { if (e.name === 'process_name') pn.set(e.pid, e.args?.name); if (e.name === 'thread_name') tn.set(e.pid + '/' + e.tid, e.args?.name); continue; }
  if (e.ph !== 'X' || !e.dur) continue;
  if (FILT && !FILT.test(e.name)) continue;
  if (e.dur >= MIN) long.push(e);
  if (e.dur > 500) names.set(e.name, (names.get(e.name) || 0) + e.dur);
}
long.sort((a, b) => b.dur - a.dur);
console.log('events', total, 'long', long.length);
console.log('--- top long slices (>= ' + MIN / 1000 + ' ms) ---');
for (const l of long.slice(0, 45)) console.log(`${(l.dur / 1000).toFixed(1)}ms ts=${l.ts} [${pn.get(l.pid) || l.pid}/${tn.get(l.pid + '/' + l.tid) || l.tid}] ${l.name} <${l.cat}> ${JSON.stringify(l.args || {}).slice(0, 200)}`);
console.log('--- total time by slice name (top 25) ---');
for (const [k, v] of [...names].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log((v / 1000).toFixed(0) + 'ms', k);
