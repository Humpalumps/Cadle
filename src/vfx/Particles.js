import * as THREE from 'three';

/**
 * ParticlePool: one instanced quad mesh (1 draw call) per blend mode. CPU integrates pos/vel/age in a single interleaved
 * Float32Array that doubles as the instanced vertex buffer (no second copy); the GPU does size/color/alpha-over-life,
 * billboarding, velocity stretch and fog. Live particles are kept contiguous [0, n) via swap-remove; only that range uploads.
 *
 * Per-particle layout (STRIDE floats):
 *   0-2 pos | 3-5 vel (or plane normal when stretch<0 = flat quad) | 6 age | 7 1/life | 8 size0 | 9 size1 | 10-12 col0 | 13-15 col1
 *   16 alpha | 17 rot | 18 rotVel | 19 gravity | 20 drag | 21 tex | 22 stretch (0 billboard, >0 velocity-stretched, <0 flat) |
 *   23 fadeIn (0..1 of life) | 24 fadeOut start (0..1) | 25 floor y | 26 bounce | 27 swirl (rad/s)
 */
export const STRIDE = 28;

const VERT = /* glsl */`
  attribute vec3 iPos; attribute vec3 iVel; attribute vec2 iLife; attribute vec2 iSize; attribute vec3 iCol0; attribute vec3 iCol1;
  attribute vec2 iAR; attribute vec2 iTS; attribute vec2 iFade;
  uniform float fogDensity; uniform vec2 uAtlas; uniform float uMinW;
  varying vec2 vUv; varying vec4 vCol; varying float vFog; varying vec2 vLoc;
  void main() {
    vLoc = position.xy * 2.0;
    float t = clamp(iLife.x * iLife.y, 0.0, 1.0);
    float size = mix(iSize.x, iSize.y, t);
    float env = smoothstep(0.0, max(iFade.x, 1e-4), t) * (1.0 - smoothstep(iFade.y, 1.0, t));
    vec3 vp = (modelViewMatrix * vec4(iPos, 1.0)).xyz;
    vec2 c = position.xy; float st = iTS.y;
    float cr = cos(iAR.y), sr = sin(iAR.y);
    vec2 rc = vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr);
    if (st < 0.0) {                               // flat quad in the plane perpendicular to iVel (world normal)
      vec3 n = normalize(iVel);
      vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 t2 = cross(n, t1);
      vp = (modelViewMatrix * vec4(iPos + (t1 * rc.x + t2 * rc.y) * size, 1.0)).xyz;
    } else if (st > 0.0) {                        // stretched along screen-space velocity
      vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
      float sp = length(vv.xy);
      vec2 up = sp > 1e-4 ? vv.xy / sp : vec2(0.0, 1.0);
      vec2 right = vec2(up.y, -up.x);
      float depthA = max(0.05, -vp.z);
      float w = max(size, uMinW * depthA);      // never thinner than ~1.5px
      vp.xy += right * c.x * w + up * c.y * (size + st * length(vv));
    } else {
      float depthA = max(0.05, -vp.z);
      vp.xy += rc * max(size, uMinW * depthA);
    }
    float depth = -vp.z;
    env *= smoothstep(0.12, 0.55, depth);         // fade particles crossing the camera
    // near-camera wash guard (blob decree): an enemy bolt detonates AT the player, so explosion quads used
    // to sit 0.5 m from the eye and fill the whole frame. Fade by projected COVERAGE (size/depth): a quad
    // spanning ~2/3 of the frame starts fading, past ~1.3 frames it is gone. Muzzle sprites (~0.3 m at the
    // barrel) stay under the threshold; a 3 m fireball 10 m away is untouched.
    env *= 1.0 - smoothstep(1.2, 2.4, size / max(depth, 0.05));
    vFog = 1.0 - exp(-fogDensity * fogDensity * depth * depth);
    vCol = vec4(mix(iCol0, iCol1, t), iAR.x * env);
    float tex = iTS.x;
    vUv = (uv + vec2(mod(tex, uAtlas.x), floor(tex / uAtlas.x))) / uAtlas;
    gl_Position = projectionMatrix * vec4(vp, 1.0);
  }`;
const FRAG = /* glsl */`
  uniform sampler2D uMap; uniform vec3 fogColor; uniform float uAdd;
  varying vec2 vUv; varying vec4 vCol; varying float vFog; varying vec2 vLoc;
  void main() {
    float m = texture2D(uMap, vUv).a;
    m *= 1.0 - smoothstep(0.95, 1.42, length(vLoc));   // round the silhouette: distant quads hit deep mips where atlas tiles blur into squares
    float a = m * vCol.a; if (a < 0.002) discard;
    vec3 c = vCol.rgb * a;
    c = mix(mix(c, fogColor * a, vFog), c * (1.0 - vFog), uAdd);   // alpha: tint to fog; additive: darken with fog
    gl_FragColor = vec4(c, a * (1.0 - uAdd));                       // premultiplied; additive writes alpha 0
  }`;

export class ParticlePool {
  constructor(scene, atlas, { capacity = 8192, additive = true, renderOrder = 10 } = {}) {
    this.cap = capacity; this.n = 0; this._over = 0;
    this.data = new Float32Array(capacity * STRIDE);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ib = this.ib = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1); ib.setUsage(THREE.DynamicDrawUsage);
    const A = (name, size, off) => geo.setAttribute(name, new THREE.InterleavedBufferAttribute(ib, size, off));
    A('iPos', 3, 0); A('iVel', 3, 3); A('iLife', 2, 6); A('iSize', 2, 8); A('iCol0', 3, 10); A('iCol1', 3, 13); A('iAR', 2, 16); A('iTS', 2, 21); A('iFade', 2, 23);
    geo.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: null }, uAtlas: { value: new THREE.Vector2(atlas.cols, atlas.rows) }, uAdd: { value: additive ? 1 : 0 }, uMinW: { value: 0.002 } }]),
      vertexShader: VERT, fragmentShader: FRAG, fog: true, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.NormalBlending, premultipliedAlpha: true, side: THREE.DoubleSide,
    });
    this.material.uniforms.uMap.value = atlas.texture;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = renderOrder; this.mesh.matrixAutoUpdate = false; this.mesh.name = additive ? 'vfx-additive' : 'vfx-alpha';
    this._range = { start: 0, count: 0 };
    scene.add(this.mesh);
  }
  // Returns the float offset of a fresh slot (caller fills all STRIDE fields). Pool full -> recycle round-robin.
  alloc() {
    let i;
    if (this.n < this.cap) i = this.n++;
    else { i = this._over++ % this.cap; }
    return i * STRIDE;
  }
  update(dt) {
    const a = this.data, S = STRIDE; let n = this.n, i = 0;
    while (i < n) {
      const o = i * S;
      const age = a[o + 6] + dt;
      if (age * a[o + 7] >= 1) { n--; if (i !== n) a.copyWithin(o, n * S, n * S + S); continue; }
      a[o + 6] = age;
      if (a[o + 22] >= 0) {
        let vx = a[o + 3], vy = a[o + 4] - a[o + 19] * dt, vz = a[o + 5];
        const dr = a[o + 20]; if (dr !== 0) { const f = 1 - dr * dt; if (f > 0) { vx *= f; vy *= f; vz *= f; } else vx = vy = vz = 0; }
        const sw = a[o + 27]; if (sw !== 0) { const cs = Math.cos(sw * dt), sn = Math.sin(sw * dt); const nx = vx * cs - vz * sn; vz = vx * sn + vz * cs; vx = nx; }
        let py = a[o + 1] + vy * dt;
        const fl = a[o + 25]; if (py < fl) { py = fl; const b = a[o + 26]; vy = -vy * b; vx *= 0.5 + 0.4 * b; vz *= 0.5 + 0.4 * b; }
        a[o] += vx * dt; a[o + 1] = py; a[o + 2] += vz * dt; a[o + 3] = vx; a[o + 4] = vy; a[o + 5] = vz;
      }
      a[o + 17] += a[o + 18] * dt;
      i++;
    }
    this.n = n;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) { this._range.count = n * S; if (!this.ib.updateRanges.length) this.ib.updateRanges.push(this._range); this.ib.needsUpdate = true; }
  }
  clear() { this.n = 0; this.mesh.geometry.instanceCount = 0; this.mesh.visible = false; }
}
