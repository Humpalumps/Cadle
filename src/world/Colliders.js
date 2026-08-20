import * as THREE from 'three';

/**
 * Colliders: simple registry of static world colliders (spheres, capsules, AABBs) for player/enemy/projectile collision.
 * Terrain is handled separately via terrain.heightAt. Props/vegetation register here.
 * API:
 *   add({ type:'sphere', pos:Vector3, r })  | add({ type:'capsule', a:Vector3, b:Vector3, r }) | add({ type:'box', box:Box3 })
 *   remove(c)
 *   resolveSphere(center:Vector3, radius) -> pushes center out of overlaps, returns true if any hit
 *   raycast(origin, dir, maxDist) -> { t, point, normal, collider } | null   (closest hit among colliders)
 *   groundAt(x, z, y, maxStep=0.6) -> highest top of a `walkable:true` box under (x,z) within [y-1.5, y+maxStep], else -Infinity
 *                               (steps, plinths, daises: movement can use max(terrain.heightAt, colliders.groundAt) as floor)
 *   add({ type:'box', box, walkable:true }) — low walkable boxes resolve the sphere UP (stand on top) instead of pushing sideways
 * Uses a uniform grid for broadphase. Owned by the world/props builder.
 */
export class Colliders {
  constructor(game) { this.game = game; this.items = new Set(); this.cell = 16; this.grid = new Map(); }
  _key(x, z) { return ((x / this.cell) | 0) * 73856093 ^ ((z / this.cell) | 0) * 19349663; }
  _bounds(c) {
    if (c.type === 'sphere') return [c.pos.x - c.r, c.pos.z - c.r, c.pos.x + c.r, c.pos.z + c.r];
    if (c.type === 'capsule') return [Math.min(c.a.x, c.b.x) - c.r, Math.min(c.a.z, c.b.z) - c.r, Math.max(c.a.x, c.b.x) + c.r, Math.max(c.a.z, c.b.z) + c.r];
    return [c.box.min.x, c.box.min.z, c.box.max.x, c.box.max.z];
  }
  add(c) {
    this.items.add(c);
    const [x0, z0, x1, z1] = this._bounds(c); c._cells = [];
    for (let x = Math.floor(x0 / this.cell); x <= Math.floor(x1 / this.cell); x++) for (let z = Math.floor(z0 / this.cell); z <= Math.floor(z1 / this.cell); z++) {
      const k = x * 73856093 ^ z * 19349663; (this.grid.get(k) ?? this.grid.set(k, new Set()).get(k)).add(c); c._cells.push(k);
    }
    return c;
  }
  remove(c) { this.items.delete(c); for (const k of c._cells ?? []) this.grid.get(k)?.delete(c); }
  query(x, z, r, out = []) {
    out.length = 0;
    for (let cx = Math.floor((x - r) / this.cell); cx <= Math.floor((x + r) / this.cell); cx++) for (let cz = Math.floor((z - r) / this.cell); cz <= Math.floor((z + r) / this.cell); cz++) {
      const s = this.grid.get(cx * 73856093 ^ cz * 19349663); if (s) for (const c of s) if (!out.includes(c)) out.push(c);
    }
    return out;
  }
  resolveSphere(center, radius, out = { hit: false, normal: new THREE.Vector3() }) {
    out.hit = false;
    const near = this.query(center.x, center.z, radius + 2, this._q ??= []);
    const tmp = this._t ??= new THREE.Vector3();
    for (const c of near) {
      if (c.type === 'sphere') {
        tmp.subVectors(center, c.pos); const d = tmp.length(), min = radius + c.r;
        if (d < min && d > 1e-6) { center.addScaledVector(tmp.normalize(), min - d); out.hit = true; out.normal.copy(tmp); }
      } else if (c.type === 'capsule') {
        const ab = this._ab ??= new THREE.Vector3(); ab.subVectors(c.b, c.a);
        const t = THREE.MathUtils.clamp(tmp.subVectors(center, c.a).dot(ab) / ab.lengthSq(), 0, 1);
        tmp.copy(c.a).addScaledVector(ab, t); tmp.subVectors(center, tmp);
        const d = tmp.length(), min = radius + c.r;
        if (d < min && d > 1e-6) { center.addScaledVector(tmp.normalize(), min - d); out.hit = true; out.normal.copy(tmp); }
      } else if (c.type === 'box') {
        c.box.clampPoint(center, tmp); tmp.subVectors(center, tmp); const d = tmp.length();
        if (d < radius && c.walkable && c.box.max.y - (center.y - radius) < 0.6) {
          center.y = c.box.max.y + radius; out.hit = true; out.normal.set(0, 1, 0); continue; // low step: stand on it
        }
        if (d < radius) {
          if (d > 1e-6) { center.addScaledVector(tmp.normalize(), radius - d); out.normal.copy(tmp); }
          else { center.y = c.box.max.y + radius; out.normal.set(0, 1, 0); }
          out.hit = true;
        }
      }
    }
    return out;
  }
  groundAt(x, z, y, maxStep = 0.6) {
    let best = -Infinity;
    for (const c of this.query(x, z, 0.01, this._g ??= [])) {
      if (c.type !== 'box' || !c.walkable) continue; const b = c.box;
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      if (b.max.y <= y + maxStep && b.max.y >= y - 1.5 && b.max.y > best) best = b.max.y;
    }
    return best;
  }
  raycast(origin, dir, maxDist = 1000) {
    let best = null; const ray = this._ray ??= new THREE.Ray(); ray.set(origin, dir); const p = this._p ??= new THREE.Vector3();
    for (const c of this.items) {
      let hit = null;
      if (c.type === 'sphere') { const s = this._s ??= new THREE.Sphere(); s.set(c.pos, c.r); hit = ray.intersectSphere(s, p); }
      else if (c.type === 'box') hit = ray.intersectBox(c.box, p);
      else if (c.type === 'capsule') { const s = this._s ??= new THREE.Sphere(); s.set(c.a, c.r); hit = ray.intersectSphere(s, p); if (!hit) { s.set(c.b, c.r); hit = ray.intersectSphere(s, p); } }
      if (hit) { const t = hit.distanceTo(origin); if (t <= maxDist && (!best || t < best.t)) best = { t, point: hit.clone(), collider: c }; }
    }
    return best;
  }
}
