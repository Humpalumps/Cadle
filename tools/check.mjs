// Syntax-check every src file (node --check) + ensure all relative imports resolve. Fast (< 2 s). Run before finishing any edit.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const files = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : /\.(m?js)$/.test(f) && files.push(p); } })('src');
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.log(`SYNTAX ${f}\n${String(e.stderr).split('\n').slice(0, 6).join('\n')}`); continue; }
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) { const t = path.resolve(path.dirname(f), m[1]); if (!fs.existsSync(t)) { bad++; console.log(`MISSING IMPORT ${f}: ${m[1]}`); } }
}
console.log(bad ? `${bad} problem(s)` : `OK ${files.length} files`);
process.exit(bad ? 1 : 0);
