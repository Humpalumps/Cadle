import * as THREE from 'three';
import { TEX } from './Textures.js';

const _c = new THREE.Color();
const _c2 = new THREE.Color();
// how far a pure-white hot core is pulled toward its element hue (see color()). 0 = white, 1 = fully tinted.
const HOT_TINT = 0.55;
const UP = { x: 0, y: 1, z: 0 };

/**
 * Brush: a reusable (singleton, zero-alloc) spawn description. Presets chain setters then call burst(n).
 *   reset(pool, pos) -> defaults; axis(v) cone/ring/flat axis; spread(rad); jitter(r) sphere; ring(r0, r1, up=0, tangent=0)
 *   speed(a,b) (negative = inward); life(a,b); size(a,b,endMul=1); color(c0, c1=c0) hex|Color; hdr(h0,h1=h0); vary(v) brightness jitter;
 *   alpha(a); tex(id); rot(rand=true); spin(a,b); gravity(g); drag(d); stretch(s); flat() quad in plane ⟂ axis; fade(in,outStart);
 *   floor(y, bounce); swirl(a,b,sym) rad/s (sym: random sign); vel(x,y,z) added base velocity; lit([r,g,b]) multiply colors (sun/ambient tint for dust/smoke)
 */
export class Brush {
  constructor() { this.reset(null, UP); }
  reset(pool, p) {
    this.pool = pool; this.px = p.x; this.py = p.y; this.pz = p.z;
    this.ax = 0; this.ay = 1; this.az = 0; this.spr = 0; this.jit = 0; this.r0 = 0; this.r1 = 0; this.rUp = 0; this.rTan = 0;
    this.s0 = 0; this.s1 = 0; this.l0 = 1; this.l1 = 1; this.z0 = 0.1; this.z1 = 0.1; this.zEnd = 1;
    this.c0r = this.c0g = this.c0b = 1; this.c1r = this.c1g = this.c1b = 1; this.h0 = 1; this.h1 = 1; this.var = 0; this.a = 1;
    this.t = TEX.GLOW; this.rotR = false; this.sp0 = 0; this.sp1 = 0; this.g = 0; this.d = 0; this.st = 0; this.fi = 0.02; this.fo = 0.6;
    this.fl = -1e9; this.bn = 0; this.sw0 = 0; this.sw1 = 0; this.swSym = false; this.vx = this.vy = this.vz = 0;
    return this;
  }
  at(p) { this.px = p.x; this.py = p.y; this.pz = p.z; return this; }
  axis(v, sign = 1) { const l = Math.hypot(v.x, v.y, v.z) || 1; this.ax = v.x / l * sign; this.ay = v.y / l * sign; this.az = v.z / l * sign; return this; }
  axisUp() { this.ax = 0; this.ay = 1; this.az = 0; return this; }
  spread(r) { this.spr = r; return this; }
  jitter(r) { this.jit = r; return this; }
  ring(r0, r1 = r0, up = 0, tangent = 0) { this.r0 = r0; this.r1 = r1; this.rUp = up; this.rTan = tangent; return this; }
  speed(a, b = a) { this.s0 = a; this.s1 = b; return this; }
  life(a, b = a) { this.l0 = a; this.l1 = b; return this; }
  size(a, b = a, endMul = 1) { this.z0 = a; this.z1 = b; this.zEnd = endMul; return this; }
  /**
   * Start colour, end colour. Nearly every preset asks for a WHITE hot core fading to its element hue —
   * but an additive white core at hdr 4-7 tone-maps to a white ball, which is the washed-white blob the
   * project decree forbids ("saturate the COLOUR, cap the INTENSITY"). So a pure-white start is pulled
   * HOT_TINT of the way toward the element hue: the core still reads as the hottest part of the effect
   * (it keeps its full hdr multiplier) but it now reads as white-hot ARC or white-hot SOLAR rather than
   * as an anonymous white blob. Presets that genuinely want neutral white pass a near-white like 0xfffefe.
   */
  color(c0, c1 = c0) {
    _c.set(c0);
    if (c0 === 0xffffff && c1 !== 0xffffff) {
      const t = _c2.set(c1);
      this.c0r = 1 + (t.r - 1) * HOT_TINT; this.c0g = 1 + (t.g - 1) * HOT_TINT; this.c0b = 1 + (t.b - 1) * HOT_TINT;
    } else { this.c0r = _c.r; this.c0g = _c.g; this.c0b = _c.b; }
    _c.set(c1); this.c1r = _c.r; this.c1g = _c.g; this.c1b = _c.b; return this;
  }
  hdr(h0, h1 = h0) { this.h0 = h0; this.h1 = h1; return this; }
  vary(v) { this.var = v; return this; }
  alpha(a) { this.a = a; return this; }
  tex(t) { this.t = t; return this; }
  rot(r = true) { this.rotR = r; return this; }
  spin(a, b = -a) { this.sp0 = Math.min(a, b); this.sp1 = Math.max(a, b); return this; }
  gravity(g) { this.g = g; return this; }
  drag(d) { this.d = d; return this; }
  stretch(s) { this.st = s; return this; }
  flat() { this.st = -1; return this; }
  fade(i, o) { this.fi = i; this.fo = o; return this; }
  floor(y, bounce = 0.3) { this.fl = y; this.bn = bounce; return this; }
  swirl(a, b = a, sym = false) { this.sw0 = a; this.sw1 = b; this.swSym = sym; return this; }
  vel(x, y, z) { this.vx = x; this.vy = y; this.vz = z; return this; }
  lit(L) { this.c0r *= L[0]; this.c0g *= L[1]; this.c0b *= L[2]; this.c1r *= L[0]; this.c1g *= L[1]; this.c1b *= L[2]; return this; }

  burst(n) {
    n = n | 0; if (n <= 0 || !this.pool) return;
    const P = this.pool, d = P.data;
    const ax = this.ax, ay = this.ay, az = this.az;
    // orthonormal basis (b, c) perpendicular to axis
    let bx, by = 0, bz;
    if (Math.abs(ay) < 0.99) { bx = az; bz = -ax; const l = Math.hypot(bx, bz) || 1; bx /= l; bz /= l; } else { bx = 1; bz = 0; }
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const cosS = Math.cos(this.spr);
    const flat = this.st < 0;
    for (let i = 0; i < n; i++) {
      const o = P.alloc();
      // direction: random within cone around axis
      const u = Math.random(), phi = Math.random() * 6.2832, cosT = 1 - u * (1 - cosS), sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const cp = Math.cos(phi), sp = Math.sin(phi);
      let dx = ax * cosT + (bx * cp + cx * sp) * sinT, dy = ay * cosT + (by * cp + cy * sp) * sinT, dz = az * cosT + (bz * cp + cz * sp) * sinT;
      let px = this.px, py = this.py, pz = this.pz;
      if (this.jit > 0) {
        const r = this.jit * Math.cbrt(Math.random()), th = Math.random() * 6.2832, zz = Math.random() * 2 - 1, rr = Math.sqrt(1 - zz * zz);
        px += r * rr * Math.cos(th); py += r * zz; pz += r * rr * Math.sin(th);
      }
      if (this.r1 > 0) {
        const r = this.r0 + Math.random() * (this.r1 - this.r0), th = Math.random() * 6.2832, ct = Math.cos(th), st = Math.sin(th);
        const rx = bx * ct + cx * st, ry = by * ct + cy * st, rz = bz * ct + cz * st;     // radial
        px += rx * r; py += ry * r; pz += rz * r;
        const tx = -bx * st + cx * ct, ty = -by * st + cy * ct, tz = -bz * st + cz * ct; // tangential
        const k = this.rTan;
        dx = rx * (1 - k) + tx * k + ax * this.rUp; dy = ry * (1 - k) + ty * k + ay * this.rUp; dz = rz * (1 - k) + tz * k + az * this.rUp;
        const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      }
      const spd = this.s0 + Math.random() * (this.s1 - this.s0);
      const life = this.l0 + Math.random() * (this.l1 - this.l0);
      const sz = this.z0 + Math.random() * (this.z1 - this.z0);
      const v = this.var > 0 ? 1 - this.var * 0.5 + this.var * Math.random() : 1;
      d[o] = px; d[o + 1] = py; d[o + 2] = pz;
      if (flat) { d[o + 3] = ax; d[o + 4] = ay; d[o + 5] = az; }
      else { d[o + 3] = dx * spd + this.vx; d[o + 4] = dy * spd + this.vy; d[o + 5] = dz * spd + this.vz; }
      d[o + 6] = 0; d[o + 7] = 1 / life; d[o + 8] = sz; d[o + 9] = sz * this.zEnd;
      const h0 = this.h0 * v, h1 = this.h1 * v;
      d[o + 10] = this.c0r * h0; d[o + 11] = this.c0g * h0; d[o + 12] = this.c0b * h0;
      d[o + 13] = this.c1r * h1; d[o + 14] = this.c1g * h1; d[o + 15] = this.c1b * h1;
      d[o + 16] = this.a; d[o + 17] = this.rotR ? Math.random() * 6.2832 : 0;
      d[o + 18] = this.sp0 + Math.random() * (this.sp1 - this.sp0);
      d[o + 19] = this.g; d[o + 20] = this.d; d[o + 21] = this.t; d[o + 22] = this.st; d[o + 23] = this.fi; d[o + 24] = this.fo;
      d[o + 25] = this.fl; d[o + 26] = this.bn;
      const sw = this.sw0 + Math.random() * (this.sw1 - this.sw0); d[o + 27] = this.swSym && Math.random() < 0.5 ? -sw : sw;
    }
  }
}
