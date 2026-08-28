import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------------------------------
// Tracers + beams: instanced camera-facing quads between tail and head (1 draw call, additive premultiplied).
// Tracer = short bright segment travelling from->to (Destiny style), beam = full-length line held for `duration`.
// ---------------------------------------------------------------------------------------------------------------------
const TR_STRIDE = 12; // 0-2 tail, 3-5 head, 6-8 color, 9 width, 10 alpha, 11 core (0 soft glow .. 1 hard core)
const TR_VERT = /* glsl */`
  attribute vec3 iA; attribute vec3 iB; attribute vec3 iCol; attribute vec3 iW;
  uniform float fogDensity; uniform float uMinW;
  varying vec2 vUv; varying vec4 vCol; varying float vFog; varying float vCore;
  void main() {
    vec3 a = (modelViewMatrix * vec4(iA, 1.0)).xyz, b = (modelViewMatrix * vec4(iB, 1.0)).xyz;
    vec3 p = mix(a, b, uv.y);
    // NEAR-PLANE CLIP (infernal firing wedge): a tracer/beam endpoint behind the eye (the muzzle can cross
    // the near plane under FOV kick / steep pitch) mirror-projects, and the quad becomes a hard-edged
    // polygon spanning the frame corner-to-corner. Slide the vertex along its own segment back to just in
    // front of the plane; the existing depth fade (smoothstep below) then takes its alpha to ~0.
    const float NEARP = 0.07;
    // ...and if the WHOLE segment is behind the eye, no slide along it can help: the clamp lands on an
    // endpoint that is still behind, and forcing p.z leaves x/y at their behind-the-camera values, which
    // project to a hard-edged band running clean across the frame — the shadowfen "perfectly straight
    // screen-wide horizontal green beam spanning the full 1920 px, depth-tested"
    // (tools/out/sf-fight/burst-approach-3.png). A segment with no visible part must draw nothing.
    // Written as a flag, NOT an early return: returning before the varyings are assigned leaves vUv/vCol/
    // vFog/vCore undefined for those vertices, which is UB and can interpolate to NaN in the fragment.
    // (And no backticks in here, ever: this comment lives inside a JS template literal.)
    float gone = step(-NEARP, a.z) * step(-NEARP, b.z);
    if (p.z > -NEARP) {
      vec3 seg = b - a;
      if (abs(seg.z) > 1e-5) p = a + seg * clamp((-NEARP - a.z) / seg.z, 0.0, 1.0);
      p.z = min(p.z, -NEARP);
    }
    vec2 ax = (b - a).xy; float l = length(ax);
    vec2 perp = l > 1e-5 ? vec2(-ax.y, ax.x) / l : vec2(1.0, 0.0);
    float depth = max(0.05, -p.z);
    float w = max(iW.x, uMinW * depth);
    p.xy += perp * (uv.x - 0.5) * w;
    vUv = uv; vCore = iW.z;
    vCol = vec4(iCol, iW.y * smoothstep(0.05, 0.4, depth));
    vFog = 1.0 - exp(-fogDensity * fogDensity * depth * depth);
    vCol.a *= 1.0 - gone;
    gl_Position = mix(projectionMatrix * vec4(p, 1.0), vec4(2.0, 2.0, 2.0, 1.0), gone);   // wholly behind the eye -> outside the clip volume
  }`;
const TR_FRAG = /* glsl */`
  uniform float uDark;
  varying vec2 vUv; varying vec4 vCol; varying float vFog; varying float vCore;
  void main() {
    float x = abs(vUv.x * 2.0 - 1.0);
    float glow = exp(-x * x * 5.0) * 0.75;
    float core = exp(-x * x * 28.0);
    float prof = mix(glow + core * 0.6, core * 1.4 + glow * 0.3, vCore);
    float along = mix(pow(vUv.y, 1.6), 1.0, vCore) ;       // tracers: bright head, fading tail; beams: uniform
    float a = prof * along * vCol.a * (1.0 - vFog);
    // dark-edged contrast: premultiplied alpha darkens the background under/around the hot core so it reads at noon
    float dark = exp(-x * x * 3.0) * along * min(1.0, vCol.a) * uDark * (1.0 - vFog);
    gl_FragColor = vec4(vCol.rgb * a, dark);
  }`;

export class Tracers {
  constructor(scene, capacity = 256) {
    this.cap = capacity; this.n = 0;
    this.data = new Float32Array(capacity * TR_STRIDE);
    // sim state (not uploaded): from(3) dir(3) dist len speed age life color(3) width alpha core beam(0/1)
    this.sim = new Float32Array(capacity * 18); this.SS = 18;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ib = this.ib = new THREE.InstancedInterleavedBuffer(this.data, TR_STRIDE, 1); ib.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    geo.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    geo.setAttribute('iCol', new THREE.InterleavedBufferAttribute(ib, 3, 6));
    geo.setAttribute('iW', new THREE.InterleavedBufferAttribute(ib, 3, 9));
    geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMinW: { value: 0.002 }, uDark: { value: 0 } }]),
      vertexShader: TR_VERT, fragmentShader: TR_FRAG, fog: true, transparent: true, depthWrite: false, blending: THREE.NormalBlending, premultipliedAlpha: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material); this.mesh.frustumCulled = false; this.mesh.renderOrder = 12; this.mesh.matrixAutoUpdate = false; this.mesh.name = 'vfx-tracers';
    this._range = { start: 0, count: 0 };
    scene.add(this.mesh);
  }
  // speed: m/s of the travelling segment (Infinity for beams); len: segment length; core: 0 soft..1 hard
  add(from, to, r, g, b, width = 0.03, duration = 0.08, speed = 320, len = 7, alpha = 1, core = 0.3, beam = false) {
    const i = this.n < this.cap ? this.n++ : (Math.random() * this.cap) | 0;
    const s = this.sim, o = i * this.SS;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, dist = Math.hypot(dx, dy, dz) || 1e-4;
    s[o] = from.x; s[o + 1] = from.y; s[o + 2] = from.z; s[o + 3] = dx / dist; s[o + 4] = dy / dist; s[o + 5] = dz / dist;
    s[o + 6] = dist; s[o + 7] = beam ? dist : len; s[o + 8] = beam ? 1e9 : speed; s[o + 9] = 0;
    s[o + 10] = beam ? duration : Math.max(duration, (dist + len) / speed);
    s[o + 11] = r; s[o + 12] = g; s[o + 13] = b; s[o + 14] = width; s[o + 15] = alpha; s[o + 16] = core; s[o + 17] = beam ? 1 : 0;
  }
  update(dt) {
    const s = this.sim, d = this.data, SS = this.SS; let n = this.n, i = 0;
    while (i < n) {
      const o = i * SS;
      const age = s[o + 9] + dt, life = s[o + 10];
      if (age >= life) { n--; if (i !== n) s.copyWithin(o, n * SS, n * SS + SS); continue; }
      s[o + 9] = age;
      const dist = s[o + 6], beam = s[o + 17] > 0.5;
      let head = beam ? dist : Math.min(dist, s[o + 8] * age), tail = Math.max(0, head - s[o + 7]);
      if (!beam && tail >= dist) { n--; if (i !== n) s.copyWithin(o, n * SS, n * SS + SS); continue; }
      const k = i * TR_STRIDE;
      d[k] = s[o] + s[o + 3] * tail; d[k + 1] = s[o + 1] + s[o + 4] * tail; d[k + 2] = s[o + 2] + s[o + 5] * tail;
      d[k + 3] = s[o] + s[o + 3] * head; d[k + 4] = s[o + 1] + s[o + 4] * head; d[k + 5] = s[o + 2] + s[o + 5] * head;
      const t = age / life;
      const fade = beam ? Math.min(1, t * 12) * (1 - t * t) * (0.85 + 0.15 * Math.sin(age * 60)) : (1 - t * 0.7);
      d[k + 6] = s[o + 11]; d[k + 7] = s[o + 12]; d[k + 8] = s[o + 13];
      d[k + 9] = s[o + 14] * (beam ? (0.8 + 0.2 * Math.sin(age * 40)) : 1); d[k + 10] = s[o + 15] * fade; d[k + 11] = s[o + 16];
      i++;
    }
    this.n = n; this.mesh.geometry.instanceCount = n; this.mesh.visible = n > 0;
    if (n > 0) { this._range.count = n * TR_STRIDE; if (!this.ib.updateRanges.length) this.ib.updateRanges.push(this._range); this.ib.needsUpdate = true; }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Decals: instanced quads oriented by surface normal, multiply-blended (darken whatever lighting is there). Ring buffer:
// oldest recycled. GPU computes fade from spawn time; CPU cost per frame = one uniform.
// ---------------------------------------------------------------------------------------------------------------------
const DC_STRIDE = 14; // 0-2 pos, 3-5 normal, 6 size, 7 rot, 8 t0, 9 life, 10 tex, 11-13 tint
const DC_VERT = /* glsl */`
  attribute vec3 iPos; attribute vec3 iN; attribute vec4 iM; attribute vec4 iT;
  uniform float fogDensity; uniform float uTime; uniform vec2 uAtlas;
  varying vec2 vUv; varying vec4 vCol; varying float vFog;
  void main() {
    vec3 n = normalize(iN);
    vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(n, t1);
    float cr = cos(iM.y), sr = sin(iM.y);
    vec2 c = position.xy; vec2 rc = vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * iM.x;
    vec3 wp = iPos + t1 * rc.x + t2 * rc.y + n * 0.015;
    vec4 vp = modelViewMatrix * vec4(wp, 1.0);
    float age = uTime - iM.z;
    float a = (age < 0.0 || age > iM.w) ? 0.0 : (1.0 - smoothstep(iM.w - 1.5, iM.w, age)) * min(1.0, age * 20.0);
    float depth = -vp.z;
    vFog = 1.0 - exp(-fogDensity * fogDensity * depth * depth);
    vCol = vec4(iT.yzw, a);
    vUv = (uv + vec2(mod(iT.x, uAtlas.x), floor(iT.x / uAtlas.x))) / uAtlas;
    gl_Position = projectionMatrix * vp;
  }`;
const DC_FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying vec2 vUv; varying vec4 vCol; varying float vFog;
  void main() {
    float m = texture2D(uMap, vUv).a * vCol.a * (1.0 - vFog);
    if (m < 0.003) discard;
    gl_FragColor = vec4(mix(vec3(1.0), vCol.rgb, m), 1.0);   // multiply blend: dst * mix(1, tint, m); alpha 1 preserves dst.a
  }`;

export class Decals {
  constructor(scene, atlas, capacity = 200) {
    this.cap = capacity; this.n = 0; this.head = 0; this.time = 0;
    this.data = new Float32Array(capacity * DC_STRIDE);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ib = this.ib = new THREE.InstancedInterleavedBuffer(this.data, DC_STRIDE, 1); ib.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    geo.setAttribute('iN', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    geo.setAttribute('iM', new THREE.InterleavedBufferAttribute(ib, 4, 6));
    geo.setAttribute('iT', new THREE.InterleavedBufferAttribute(ib, 4, 10));
    geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: atlas.texture }, uTime: { value: 0 }, uAtlas: { value: new THREE.Vector2(atlas.cols, atlas.rows) } }]),
      vertexShader: DC_VERT, fragmentShader: DC_FRAG, fog: true, transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    });
    this.material.uniforms.uMap.value = atlas.texture;
    this.mesh = new THREE.Mesh(geo, this.material); this.mesh.frustumCulled = false; this.mesh.renderOrder = 2; this.mesh.matrixAutoUpdate = false; this.mesh.name = 'vfx-decals';
    this._range = { start: 0, count: 0 };
    scene.add(this.mesh);
  }
  add(p, nrm, size, tex, life, r, g, b, rot = Math.random() * 6.283) {
    const i = this.head; this.head = (this.head + 1) % this.cap; this.n = Math.min(this.n + 1, this.cap);
    const d = this.data, o = i * DC_STRIDE;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; d[o + 3] = nrm.x; d[o + 4] = nrm.y; d[o + 5] = nrm.z;
    d[o + 6] = size; d[o + 7] = rot; d[o + 8] = this.time; d[o + 9] = life; d[o + 10] = tex;
    d[o + 11] = r; d[o + 12] = g; d[o + 13] = b;
    this._range.count = this.n * DC_STRIDE; if (!this.ib.updateRanges.length) this.ib.updateRanges.push(this._range); this.ib.needsUpdate = true;
    this.mesh.geometry.instanceCount = this.n; this.mesh.visible = true;
  }
  update(dt) { this.time += dt; this.material.uniforms.uTime.value = this.time; }
  clear() { this.n = 0; this.head = 0; this.mesh.geometry.instanceCount = 0; this.mesh.visible = false; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Sigils: ONE instanced quad mesh (1 draw call) of pooled rune circles, oriented by normal, counter-rotating bands,
// scale-in + fade. Grazing-angle alpha boost (up to ~4.5x edge-on) so glyphs still read from standing eye height, and
// HDR lives in the color (not alpha) so the ring/rune detail keeps its contrast instead of washing to a light pool.
// ---------------------------------------------------------------------------------------------------------------------
const SG_STRIDE = 12; // 0-2 pos, 3-5 normal, 6 size, 7 rot, 8 alpha, 9-11 color (HDR)
const SG_VERT = /* glsl */`
  attribute vec3 iPos; attribute vec3 iN; attribute vec3 iM; attribute vec3 iCol;
  uniform float fogDensity;
  varying vec2 vUv; varying vec3 vCol; varying vec2 vAR; varying float vFog;
  void main() {
    vec3 n = normalize(iN);
    vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(n, t1);
    vec2 c = position.xy * iM.x;
    vec3 wp = iPos + t1 * c.x + t2 * c.y + n * 0.03;
    float g = abs(dot(n, normalize(cameraPosition - iPos)));
    float boost = 1.0 + 3.5 * (1.0 - g) * (1.0 - g);          // edge-on: brighter, so the glyph reads at eye height
    vec4 vp = modelViewMatrix * vec4(wp, 1.0);
    float d = -vp.z;
    vUv = uv; vCol = iCol; vAR = vec2(iM.z * boost, iM.y);
    vFog = 1.0 - exp(-fogDensity * fogDensity * d * d);
    gl_Position = projectionMatrix * vp;
  }`;
const SG_FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying vec2 vUv; varying vec3 vCol; varying vec2 vAR; varying float vFog;
  vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(p.x * c - p.y * s, p.x * s + p.y * c); }
  void main() {
    vec2 p = vUv - 0.5; float r = length(p) * 2.0;
    float ang = r > 0.62 ? vAR.y : -vAR.y * 1.6;               // outer band spins one way, inner the other
    float m = texture2D(uMap, rot(p, ang) + 0.5).a;
    float pulse = 0.85 + 0.15 * sin(vAR.y * 6.0 + r * 9.0);
    float a = m * vAR.x * pulse * (1.0 - vFog);
    if (a < 0.003) discard;
    gl_FragColor = vec4(vCol * a, 0.0);
  }`;
export class Sigils {
  constructor(scene, texture, count = 6) {
    this.items = []; this.cap = count;
    this.data = new Float32Array(count * SG_STRIDE);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ib = this.ib = new THREE.InstancedInterleavedBuffer(this.data, SG_STRIDE, 1); ib.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    geo.setAttribute('iN', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    geo.setAttribute('iM', new THREE.InterleavedBufferAttribute(ib, 3, 6));
    geo.setAttribute('iCol', new THREE.InterleavedBufferAttribute(ib, 3, 9));
    geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: texture } }]),
      vertexShader: SG_VERT, fragmentShader: SG_FRAG, fog: true, transparent: true, depthWrite: false, blending: THREE.NormalBlending, premultipliedAlpha: true, side: THREE.DoubleSide,
    });
    this.material.uniforms.uMap.value = texture;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.visible = false; this.mesh.renderOrder = 9; this.mesh.frustumCulled = false; this.mesh.matrixAutoUpdate = false; this.mesh.name = 'vfx-sigils';
    scene.add(this.mesh);
    this._c = new THREE.Color();
    for (let i = 0; i < count; i++) this.items.push({ live: false, t: 0, dur: 0, size: 1, spin: 1, hdr: 1, rot: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, r: 1, g: 1, b: 1 });
  }
  add(p, nrm, { color = 0xffd27a, size = 3, duration = 1.5, spin = 1.2, hdr = 2.2 } = {}) {
    for (const x of this.items) { const dx = x.px - p.x, dy = x.py - p.y, dz = x.pz - p.z; if (x.live && dx * dx + dy * dy + dz * dz < 0.36) { x.t = Math.min(x.t, 0.3); x.dur = duration; x.size = size; return x; } } // same spot: refresh, don't stack
    let s = this.items.find((x) => !x.live);
    if (!s) { s = this.items[0]; for (const x of this.items) if (x.t > s.t) s = x; } // recycle the oldest
    const c = this._c.set(color);
    s.live = true; s.t = 0; s.dur = duration; s.size = size; s.spin = spin * (Math.random() < 0.5 ? 1 : -1); s.hdr = hdr; s.rot = Math.random() * 6.283;
    s.r = c.r; s.g = c.g; s.b = c.b;
    let nx = nrm?.x ?? 0, ny = nrm?.y ?? 1, nz = nrm?.z ?? 0; const l = Math.hypot(nx, ny, nz); if (l < 0.5) { nx = 0; ny = 1; nz = 0; } else { nx /= l; ny /= l; nz /= l; }
    // lift 0.55 m along the normal so ground glyphs ride above meadow grass (~1 m blades occlude a flat disc)
    s.nx = nx; s.ny = ny; s.nz = nz; s.px = p.x + nx * 0.55; s.py = p.y + ny * 0.55; s.pz = p.z + nz * 0.55;
    return s;
  }
  update(dt) {
    const d = this.data; let m = 0;
    for (const s of this.items) {
      if (!s.live) continue;
      s.t += dt;
      if (s.t >= s.dur) { s.live = false; continue; }
      const tin = Math.min(1, s.t / 0.3), e = 1 - tin, ease = 1 - e * e * e;
      const fade = 1 - Math.max(0, (s.t - (s.dur - 0.5)) / 0.5);
      s.rot += dt * s.spin;
      const o = m++ * SG_STRIDE;
      d[o] = s.px; d[o + 1] = s.py; d[o + 2] = s.pz; d[o + 3] = s.nx; d[o + 4] = s.ny; d[o + 5] = s.nz;
      d[o + 6] = s.size * (0.2 + 0.8 * ease); d[o + 7] = s.rot; d[o + 8] = Math.min(1, s.t / 0.12) * fade;
      d[o + 9] = s.r * s.hdr; d[o + 10] = s.g * s.hdr; d[o + 11] = s.b * s.hdr;
    }
    this.mesh.geometry.instanceCount = m; this.mesh.visible = m > 0;
    if (m > 0) this.ib.needsUpdate = true;
  }
  clear() { for (const s of this.items) s.live = false; this.mesh.geometry.instanceCount = 0; this.mesh.visible = false; }
}
