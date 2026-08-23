// Frame-time tracking for the HUD overlay and the automation harness (window.__game.stats()).
export class Perf {
  constructor() {
    this.samples = new Float32Array(600); this.i = 0; this.n = 0; this._t0 = 0;
    this.ms = 0; this.last = { calls: 0, tris: 0, geometries: 0, textures: 0, programs: 0 };   // filled in place every frame; stats() spreads it, so no caller holds this object
    this.frameTimes = new Float32Array(600); this._lastFrame = 0; // wall-clock rAF deltas
    this.systems = {};  // per-system CPU ms EMA, filled by Game.frame
  }
  // GPU frame time via EXT_disjoint_timer_query_webgl2 (Chrome desktop). One query in flight per frame, results polled later.
  _gpuInit(renderer) {
    this._gpuTried = true; const gl = renderer.getContext(); const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return; this._gl = gl; this._ext = ext; this._queries = []; this.gpuSamples = new Float32Array(600); this._gi = 0; this._gn = 0;
  }
  // Cap 32, not 8: under ANGLE/D3D11 a TIME_ELAPSED result takes ~10-20 frames to become available, so a
  // shallow queue starves -- at 8 we sampled ~4 frames a second and the survivors were all post-stall
  // frames, reading 19 ms against an 11 ms true mean. At 32 the sample rate is ~25/s and the GPU mean lands
  // on the frame mean in every region, which is how you know the number is real.
  // `gpuPaused`: WebGL2 allows exactly ONE query per target, and PostFX.profile() opens its own TIME_ELAPSED
  // query inside the frame. While this timer was dead that collision was invisible; now it would make both
  // readings garbage (its beginQuery fails, then its endQuery closes OUR query). Anything that wants the
  // target to itself sets perf.gpuPaused = true for the duration; we simply stop sampling. The CURRENT_QUERY
  // check is the backstop for any caller that forgets.
  _gpuBegin() {
    if (!this._ext || this.gpuPaused || this._queries.length > 31) return;
    const gl = this._gl; if (gl.getQuery(this._ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return;
    const q = gl.createQuery(); gl.beginQuery(this._ext.TIME_ELAPSED_EXT, q); this._qActive = q;
  }
  // The drain must NOT sit behind an `!this._qActive` early return, which is what it used to do: boot frames
  // are slow enough to back the queue up to the _gpuBegin cap (9), after which no query is active, so the
  // drain was skipped, the queue never emptied, _gpuBegin never resumed, and gpuMs read 0 for the rest of
  // the session (measured: 35 samples, then frozen forever).
  _gpuEnd() {
    if (!this._ext) return; const gl = this._gl;
    // Close ours only if it is still the active query — if someone else's endQuery already closed it, ending
    // again would close THEIR query instead and the corruption would spread.
    if (this._qActive) {
      if (gl.getQuery(this._ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) === this._qActive) { gl.endQuery(this._ext.TIME_ELAPSED_EXT); this._queries.push(this._qActive); }
      else gl.deleteQuery(this._qActive);
      this._qActive = null;
    }
    while (this._queries.length) { const q = this._queries[0]; if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break; this._queries.shift();
      if (!gl.getParameter(this._ext.GPU_DISJOINT_EXT)) { this.gpuSamples[this._gi] = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; this._gi = (this._gi + 1) % 600; this._gn = Math.min(this._gn + 1, 600); }
      gl.deleteQuery(q); }
  }
  begin() {
    if (this._renderer) this._gpuBegin();
    const now = performance.now();
    if (this._lastFrame) { this.frameTimes[this.i] = now - this._lastFrame; }
    this._lastFrame = now; this._t0 = now;
    this._renderer?.info.reset();
  }
  end(renderer) {
    if (!this._gpuTried) this._gpuInit(renderer);
    this._renderer = renderer; this._gpuEnd();
    this.ms = performance.now() - this._t0;
    this.samples[this.i] = this.ms;
    this.i = (this.i + 1) % this.samples.length; this.n = Math.min(this.n + 1, this.samples.length);
    const info = renderer.info;
    const L = this.last;   // assigned in place: a fresh object literal here was one allocation every frame
    L.calls = info.render.calls; L.tris = info.render.triangles; L.geometries = info.memory.geometries; L.textures = info.memory.textures; L.programs = info.programs?.length ?? 0;
  }
  _q(arr, n = this.n) {
    const a = Array.from(arr.subarray(0, n)).sort((x, y) => x - y);
    const q = (p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
    const mean = a.reduce((x, y) => x + y, 0) / (a.length || 1);
    return { mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +(a.at(-1) ?? 0).toFixed(2) };
  }
  // Stats over the recent window (last ~600 frames).
  stats() {
    const cpu = this._q(this.samples), frame = this._q(this.frameTimes);
    const gpu = this.gpuSamples ? this._q(this.gpuSamples, this._gn) : null;
    return { fps: +(1000 / (frame.mean || 16.7)).toFixed(1), frameMs: frame, cpuMs: cpu, gpuMs: gpu, ...this.last, memMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      systems: Object.fromEntries(Object.entries(this.systems).map(([k, v]) => [k, +v.toFixed(2)])) };
  }
  reset() { this.i = 0; this.n = 0; if (this.gpuSamples) { this._gi = 0; this._gn = 0; } }
}
