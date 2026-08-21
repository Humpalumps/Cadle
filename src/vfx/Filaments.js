import * as THREE from 'three';

/**
 * Filaments: instanced ribbon strips whose PATH IS EVALUATED IN THE VERTEX SHADER.
 *
 * Technique adapted from majidmanzarpour/threejs-vfx (MIT, (c) mohamedachrefelouafi) — `src/vfx/FilamentPaths.js`.
 * The idea there: a vertex arrives as `(t, side)` — how far along its filament it is and which edge of the ribbon it
 * is on — and leaves as a world position, so no path ever exists on the CPU to go stale, and raising the strand count
 * is nearly free. The glow is drawn as a second, wider ribbon rather than left to bloom, which is what keeps it
 * attached to every kink instead of smearing into a ball.
 *
 * What is different here: their bolt is one effect per draw pair. Ours packs EVERY live filament in the game into one
 * instanced draw by moving the endpoints into instanced attributes, so N concurrent trails, plumes and bolts still
 * cost exactly 2 draw calls. Live instances are kept packed at the front of the buffers and `instanceCount` is set to
 * the live total, so an idle frame uploads nothing and draws nothing.
 *
 * Colour rule (project decree): flame is SATURATED and intensity-capped. An additive ribbon that tone-maps to white
 * is the "washed-white blob" bug — the hot core is a deep gold, never a white one.
 *
 *   const h = vfx.filaments.spawn({ color, width, spread, strands, life });
 *   h.set(a, b);            // world endpoints, any frame
 *   h.follow(target, lag);  // B tracks target.position, A lags behind it (projectile trails)
 *   h.stop();
 */

const NODES = 20;                       // samples along a ribbon: 19 quads = 38 tris per strand
const MAX_STRANDS = 96;                 // hard ceiling on live strands across the whole game

const VERT = /* glsl */`
attribute vec3 aA;       // start, world
attribute vec3 aB;       // end, world
attribute vec3 aCol;
attribute vec4 aP;       // x width, y spread, z seed, w alpha
varying float vT; varying float vSide; varying vec3 vCol; varying float vA; varying float vDist;

float fh(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float fn(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic: C2, so the ribbon's curvature is smooth
  return mix(mix(mix(fh(i), fh(i + vec3(1,0,0)), f.x), mix(fh(i + vec3(0,1,0)), fh(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(fh(i + vec3(0,0,1)), fh(i + vec3(1,0,1)), f.x), mix(fh(i + vec3(0,1,1)), fh(i + vec3(1,1,1)), f.x), f.y), f.z);
}

uniform float uTime;
uniform float uWidthMul;
uniform float uAlphaMul;

void main() {
  float t = position.x, side = position.y;
  vT = t; vSide = side; vCol = aCol; vA = aP.w * uAlphaMul;

  vec3 base = mix(aA, aB, t);
  vec3 seg = aB - aA;
  float len = max(length(seg), 1e-4);
  vec3 dir = seg / len;
  vec3 up = abs(dir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 rgt = normalize(cross(dir, up));
  vec3 upv = normalize(cross(rgt, dir));

  // turbulence: widest in the middle, pinned at both ends so a trail stays welded to its projectile
  float env = sin(t * 3.14159265);
  vec3 q = vec3(t * 3.2, aP.z, uTime * 2.3);
  float nx = fn(q) - 0.5, ny = fn(q + 11.3) - 0.5;
  nx += (fn(q * 2.9) - 0.5) * 0.45;  ny += (fn(q * 2.9 + 4.1) - 0.5) * 0.45;
  base += (rgt * nx + upv * ny) * aP.y * env * len;

  // face the camera: offset across the segment, perpendicular to the eye ray
  vec3 toEye = normalize(cameraPosition - base);   // three declares cameraPosition in the ShaderMaterial prefix
  vec3 across = normalize(cross(dir, toEye));
  // flame silhouette: fat at the head, tapering to nothing at the tail
  float w = aP.x * uWidthMul * (0.20 + 0.80 * t) * (0.55 + 0.45 * env);
  vec3 wp = base + across * side * w;
  vDist = length(cameraPosition - wp);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */`
varying float vT; varying float vSide; varying vec3 vCol; varying float vA; varying float vDist;
uniform float uCore;    // 0 = soft halo, 1 = hot core
void main() {
  float edge = 1.0 - abs(vSide);
  // tail fades out, head burns; the halo is broader and softer than the core
  float shape = pow(edge, mix(1.3, 2.6, uCore)) * smoothstep(0.0, 0.35, vT) * (0.35 + 0.65 * vT);
  // Near-camera fade. A camera-facing additive ribbon that passes within arm's reach covers the whole frame — an
  // incoming bolt trail arriving at your face washed the screen orange and then dragged scene auto-exposure down
  // behind it. Every filament fades out inside ~4 m, so nothing on this system can ever become a screen wash.
  float a = shape * vA * smoothstep(0.9, 4.5, vDist);
  if (a < 0.004) discard;
  // hue-locked: the core brightens toward the filament's own colour, never toward white
  vec3 c = vCol * mix(0.55, 1.35, uCore * vT);
  gl_FragColor = vec4(c * a, a);
}`;

export class Filaments {
  constructor(scene, capacity = MAX_STRANDS) {
    this.cap = capacity;
    this.live = [];                      // packed list of active strand records
    this._pool = [];
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();

    const pos = new Float32Array(NODES * 2 * 3);
    for (let i = 0; i < NODES; i++) {
      const t = i / (NODES - 1), o = i * 6;
      pos[o] = t; pos[o + 1] = -1; pos[o + 3] = t; pos[o + 4] = 1;
    }
    const idx = new Uint16Array((NODES - 1) * 6);
    for (let i = 0; i < NODES - 1; i++) {
      const a = i * 2, o = i * 6;
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
      idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
    }
    this.aA = new Float32Array(capacity * 3);
    this.aB = new Float32Array(capacity * 3);
    this.aCol = new Float32Array(capacity * 3);
    this.aP = new Float32Array(capacity * 4);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const ia = (arr, n) => { const a = new THREE.InstancedBufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('aA', ia(this.aA, 3)); g.setAttribute('aB', ia(this.aB, 3));
    g.setAttribute('aCol', ia(this.aCol, 3)); g.setAttribute('aP', ia(this.aP, 4));
    g.instanceCount = 0;
    // built in world space in the vertex shader, so its own bounds are meaningless
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geo = g;

    const mk = (core, widthMul, alphaMul, order) => {
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uCore: { value: core }, uWidthMul: { value: widthMul }, uAlphaMul: { value: alphaMul } },
        vertexShader: VERT, fragmentShader: FRAG,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
        side: THREE.DoubleSide, fog: false,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false; mesh.renderOrder = order; mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    // halo under, core on top — drawing the glow as real ribbon is what keeps it attached to every kink
    this.halo = mk(0.0, 2.6, 0.22, 11);
    this.core = mk(1.0, 1.0, 0.55, 12);   // overlapping additive strands accumulate; scene auto-exposure reads the sum
  }

  /** spawn(opts) -> handle. opts: { color, width, spread, strands, life (s, <=0 = manual), seed } */
  spawn(o = {}) {
    const n = Math.max(1, Math.min(6, o.strands ?? 3));
    const col = new THREE.Color(o.color ?? 0xff8a3d);
    const rec = {
      alive: true, t: 0, life: o.life ?? 0, n,
      a: new THREE.Vector3(), b: new THREE.Vector3(),
      col, width: o.width ?? 0.35, spread: o.spread ?? 0.10,
      seed: o.seed ?? Math.random() * 100, alpha: o.alpha ?? 1,
      target: null, lag: 0.12, tail: new THREE.Vector3(), started: false, lastAge: -1,
    };
    if (this.live.length + n > this.cap) return NULL_HANDLE;   // full: drop silently rather than evict a live effect
    rec.handle = {
      set: (a, b) => { rec.a.copy(a); rec.b.copy(b); rec.started = true; return rec.handle; },
      follow: (target, lag = 0.12) => { rec.target = target; rec.lag = lag; return rec.handle; },
      fade: (v) => { rec.alpha = v; return rec.handle; },
      stop: () => { rec.alive = false; },
      get alive() { return rec.alive; },
    };
    this.live.push(rec);
    return rec.handle;
  }

  update(dt, time) {
    const live = this.live;
    let w = 0;
    for (let i = 0; i < live.length; i++) {
      const r = live[i];
      if (r.alive) {
        r.t += dt;
        if (r.life > 0 && r.t >= r.life) r.alive = false;
        const tg = r.target;
        if (tg) {
          // projectiles are pooled: age running backwards means the slot was recycled under us
          if (tg.alive === false || (tg.age !== undefined && tg.age < r.lastAge)) r.alive = false;
          else {
            if (tg.age !== undefined) r.lastAge = tg.age;
            const p = tg.position ?? tg;
            if (!r.started) { r.tail.copy(p); r.started = true; }
            // the tail chases the head with lag: gives the trail its length and its curve for free
            r.tail.lerp(p, 1 - Math.exp(-dt / Math.max(0.01, r.lag)));
            r.a.copy(r.tail); r.b.copy(p);
          }
        }
      }
      if (r.alive) { if (w !== i) live[w] = r; w++; }
    }
    live.length = w;

    let inst = 0;
    for (const r of live) {
      if (!r.started) continue;
      const fade = r.life > 0 ? Math.min(1, (1 - r.t / r.life) * 2.2) : 1;
      for (let s = 0; s < r.n && inst < this.cap; s++, inst++) {
        const o3 = inst * 3, o4 = inst * 4;
        this.aA[o3] = r.a.x; this.aA[o3 + 1] = r.a.y; this.aA[o3 + 2] = r.a.z;
        this.aB[o3] = r.b.x; this.aB[o3 + 1] = r.b.y; this.aB[o3 + 2] = r.b.z;
        this.aCol[o3] = r.col.r; this.aCol[o3 + 1] = r.col.g; this.aCol[o3 + 2] = r.col.b;
        this.aP[o4] = r.width * (0.72 + 0.28 * (s / r.n));
        this.aP[o4 + 1] = r.spread * (s === 0 ? 0.45 : 1);      // one tight strand down the middle, the rest flare
        this.aP[o4 + 2] = r.seed + s * 13.7;
        this.aP[o4 + 3] = r.alpha * fade;
      }
    }
    const on = inst > 0;
    this.halo.visible = this.core.visible = on;
    this.geo.instanceCount = inst;
    if (on) {
      for (const k of ['aA', 'aB', 'aCol', 'aP']) this.geo.getAttribute(k).needsUpdate = true;
      this.halo.material.uniforms.uTime.value = time;
      this.core.material.uniforms.uTime.value = time;
    }
  }

  clear() { this.live.length = 0; this.geo.instanceCount = 0; this.halo.visible = this.core.visible = false; }
  get count() { return this.live.length; }
}

const NULL_HANDLE = { set: () => NULL_HANDLE, follow: () => NULL_HANDLE, fade: () => NULL_HANDLE, stop() {}, alive: false };
