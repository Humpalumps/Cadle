// Renders progress.html from progress/state.json (orchestrator only). node tools/progress.mjs
import fs from 'node:fs';
const st = JSON.parse(fs.readFileSync('progress/state.json', 'utf8'));
const cls = (s) => ({ todo: 'todo', later: 'todo', building: 'wip', critic: 'crit', WIN: 'pass', TOSSUP: 'fail', LOSE: 'fail', fixing: 'wip' })[s] ?? 'todo';
const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const rows = st.pieces.map((p) => `<tr><td>${esc(p.name)}</td><td><code>${esc(p.files)}</code></td><td><span class="s ${cls(p.status)}">${esc(p.status)}</span>${p.round ? ` <small>r${p.round}</small>` : ''}</td><td class="score">${p.score != null ? `${p.score}/10 ${esc(p.verdict ?? '')}` : '—'}</td><td class="gap">${esc(p.gap)}</td></tr>`).join('\n');
const shots = (st.shots ?? []).map((s) => `<a href="${s.src}" target="_blank"><img src="${s.src}" title="${esc(s.label)}" loading="lazy"></a>`).join('');
const gallery = (st.assets ?? []).map((s) => `<figure><a href="${s.src}" target="_blank"><img src="${s.src}" title="${esc(s.label)}" loading="lazy"></a><figcaption>${esc(s.label)}</figcaption></figure>`).join('');
const log = (st.log ?? []).map((l) => `<li>${esc(l)}</li>`).join('\n');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta http-equiv="refresh" content="30"/><title>Aetherfall — Build Progress</title>
<style>
:root{color-scheme:dark}body{margin:0;padding:24px 32px;background:#0b0e17;color:#e6e1d3;font:15px/1.5 'Segoe UI',system-ui,sans-serif;max-width:1280px}
h1{font-weight:300;letter-spacing:.25em;margin:0 0 4px;color:#f3ebd6}.sub{opacity:.6;margin-bottom:24px;font-size:13px}
h2{font-size:14px;letter-spacing:.18em;text-transform:uppercase;color:#9fb8ff;margin:28px 0 10px;border-bottom:1px solid #1f2740;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:6px 10px;border-bottom:1px solid #161c2e;text-align:left;vertical-align:top}
th{color:#8893ad;font-weight:500;font-size:12px;letter-spacing:.08em;text-transform:uppercase}code{font-size:12px;opacity:.8}
.s{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600}.todo{background:#2a2f3f;color:#aab}.wip{background:#3b3210;color:#f5c542}.crit{background:#3a1f4a;color:#d9a6ff}.pass{background:#123a22;color:#5ee08f}.fail{background:#4a1a1a;color:#ff8a8a}
.score{font-variant-numeric:tabular-nums;color:#ffd58a;white-space:nowrap}.log{font-size:13px;opacity:.85}.log li{margin:2px 0}.gap{color:#ffb3b3;font-size:13px}a{color:#9fb8ff}
.shots{display:flex;flex-wrap:wrap;gap:8px}.shots img{width:300px;border-radius:4px;border:1px solid #222a44}
.gallery figure{margin:0;width:180px}.gallery img{width:180px;height:180px;object-fit:cover}.gallery figcaption{font-size:11px;opacity:.75;margin-top:2px;line-height:1.3}.kpi{display:flex;gap:24px;flex-wrap:wrap;margin:8px 0}.kpi div{background:#121829;border:1px solid #1f2740;border-radius:6px;padding:8px 14px;min-width:120px}.kpi b{display:block;font-size:20px;color:#ffd58a}.kpi span{font-size:12px;opacity:.7}
</style></head><body>
<h1>AETHERFALL</h1>
<div class="sub">Browser FPS-RPG · Three.js · Destiny 2 mechanics × FF14 look · auto-refreshes every 30 s · <a href="/?">play the current build</a> (click to begin; WASD/Shift/Space/Ctrl, LMB/RMB, R, 1-3, G/F/Q/X) · updated ${esc(st.updated)}</div>
<h2>Status</h2><p>${st.status}</p>
<div class="kpi">${(st.kpis ?? []).map((k) => `<div><b>${esc(k.value)}</b><span>${esc(k.label)}</span></div>`).join('')}</div>
<h2>Pieces</h2>
<table><tr><th>Piece</th><th>Owner module</th><th>Status</th><th>Critic score (vs D2 / FF14)</th><th>Biggest gap named by critic</th></tr>
${rows}
</table>
<h2>Latest screenshots (live build)</h2><div class="shots">${shots || '<i>none yet</i>'}</div>
<h2>Generated assets (AI pipeline: image gen &rarr; seamless textures; Tripo GLB &rarr; image2threejs models as they land)</h2><div class="shots gallery">${gallery || '<i>none yet</i>'}</div>
<h2>Log</h2><ul class="log">${log}</ul>
</body></html>`;
fs.writeFileSync('progress.html', html);
console.log('progress.html written');
