// Real Vite module worker for the terrain bake. Nothing but the kernel goes in this chunk (no three).
import { bakeKernel } from './terrainKernel.js';
self.onmessage = (e) => {
  const r = bakeKernel(e.data);
  postMessage(r, [r.hgt.buffer, r.nrm.buffer, ...r.layers.map((x) => x.data.buffer)]);
};
