import { BODIES } from './src/enemies/bodies.js';
const rows = [];
for (const [k, b] of Object.entries(BODIES)) {
  const a = b.build();
  const g = a.geometry, n = g.index ? g.index.count : g.attributes.position.count;
  const bb = g.boundingBox ?? (g.computeBoundingBox(), g.boundingBox);
  rows.push([k, n / 3, a.boneNames.length, `y ${bb.min.y.toFixed(2)}..${bb.max.y.toFixed(2)} x±${Math.max(-bb.min.x,bb.max.x).toFixed(2)} z ${bb.min.z.toFixed(2)}..${bb.max.z.toFixed(2)}`]);
}
rows.sort((a,b)=>b[1]-a[1]);
for (const r of rows) console.log(String(r[0]).padEnd(10), String(r[1]).padStart(6), 'tris', String(r[2]).padStart(3), 'bones ', r[3]);
