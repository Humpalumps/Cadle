import os
os.chdir(r'C:\Users\ianca\Desktop\fps4')

def edit(path, pairs):
    s = open(path, encoding='utf-8').read()
    for a, b in pairs:
        assert s.count(a) == 1, (path, a[:70], s.count(a))
        s = s.replace(a, b)
    open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('ok', path)

# ---------------------------------------------------------------- Terrain: dragon wears its own stone; underwater caustics
edit('src/world/Terrain.js', [
 ("else if (k < 3.5) { layer = 3.0;  scl = 6.0; cov = 0.88; tint = vec3(0.84, 0.88, 1.02); }                  // dragon rock",
  "else if (k < 3.5) { layer = 3.0;  scl = 6.0; cov = 0.88; rockCut = 0.55; tint = vec3(0.84, 0.88, 1.02); }   // dragon rock: rockCut 0 meant the CLIFFS were the generic warm-macro strata, so the Peaks read as a sandstone mesa no matter what the floor was tinted"),
 ("""  // shoreline wetness: wide gradient + saturated dark waterline band, like an FF14 shore
  float wet = lakeM * smoothstep(uWater + 6.5, uWater + 0.2, P.y + (det2.b - 0.5) * 0.7);""",
  """  // Underwater CAUSTICS. The Sunken Kingdom's whole identity is being under the sea, and below the surface
  // the only thing that changed was the fog colour. Two counter-drifting sine lattices sharpened with a
  // power curve give the moving light net; it MULTIPLIES the albedo (never emissive), so it respects the
  // sun, the shadows and the tone map, and it cannot bloom. Fades out with depth like the real thing.
  float sub = smoothstep(0.0, -1.0, P.y - uWater);
  if (sub > 0.002) {
    vec2 cq = P.xz * 0.55;
    float w1 = sin(cq.x + uTime * 0.75) * sin(cq.y * 1.07 - uTime * 0.62);
    float w2 = sin((cq.x + cq.y) * 0.71 - uTime * 0.48) * sin((cq.x - cq.y) * 0.63 + uTime * 0.39);
    float cst = pow(clamp(w1 * 0.5 + w2 * 0.5 + 0.5, 0.0, 1.0), 5.0);
    alb *= 1.0 + cst * 1.5 * sub * (1.0 - smoothstep(0.0, 22.0, uWater - P.y));
  }
  // shoreline wetness: wide gradient + saturated dark waterline band, like an FF14 shore
  float wet = lakeM * smoothstep(uWater + 6.5, uWater + 0.2, P.y + (det2.b - 0.5) * 0.7);"""),
])

# ---------------------------------------------------------------- Props: isle furniture + bridges you can read edge-on
edit('src/world/Props.js', [
 ("isles.push({ x: CX + 70, z: CZ - 55, y0: CY + 58, n: 7, spread: 95, tint: [0.86, 0.84, 0.78] });",
  "isles.push({ x: CX + 70, z: CZ - 55, y0: CY + 58, n: 7, spread: 95, tint: [0.86, 0.84, 0.78], kind: 'celestial' });"),
 ("isles.push({ x: CX + 60, z: CZ + 62, y0: CY + 52, n: 8, spread: 105, tint: [0.32, 0.27, 0.42] });",
  "isles.push({ x: CX + 60, z: CZ + 62, y0: CY + 52, n: 8, spread: 105, tint: [0.32, 0.27, 0.42], kind: 'void' });"),
 ("""        isles.push({ x, y: y + R * 0.2, z, R });
        if (i % 3 === 0) this.updrafts.push({ x, z, r: i === 0 ? 13 : 8, top: y + 26 });   // a way back up from most of the ring""",
  """        isles.push({ x, y: y + R * 0.2, z, R });
        if (i % 3 === 0) this.updrafts.push({ x, z, r: i === 0 ? 13 : 8, top: y + 26 });   // a way back up from most of the ring
        // SOMETHING ON THE ISLE. An archipelago you can walk to and find nothing on is a platforming test,
        // not a place — both float regions shipped as bare rock caps. Each isle now carries the region's own
        // ruin, and the biggest one carries a focal piece you can see from the ground below.
        const ty = y + R * 0.2, hero = R > 18;
        if (s.kind === 'celestial') {
          const ring = hero ? 8 : 4, rr = R * 0.52;
          for (let c = 0; c < ring; c++) {                                  // a peristyle, half of it fallen
            const ca2 = (c / ring) * Math.PI * 2, px = x + Math.cos(ca2) * rr, pz = z + Math.sin(ca2) * rr;
            if (c % 3 === 2) { parts.push(new THREE.CylinderGeometry(0.52, 0.55, 3.4, 10).rotateZ(Math.PI / 2).rotateY(ca2).translate(px, ty + 0.3, pz)); tints.push([1.02, 0.98, 0.86]); continue; }
            const ph = hero ? 5.6 : 3.4;
            parts.push(new THREE.CylinderGeometry(0.46, 0.56, ph, 10).translate(px, ty + ph / 2, pz)); tints.push([1.06, 1.02, 0.90]);
            col.add({ type: 'capsule', a: V3(px, ty, pz), b: V3(px, ty + ph, pz), r: 0.7 });
          }
          if (hero) {                                                       // the altar: a gilded drum on a stepped dais
            parts.push(new THREE.CylinderGeometry(4.2, 4.8, 0.5, 12).translate(x, ty + 0.25, z)); tints.push([1.04, 1.00, 0.88]);
            parts.push(new THREE.CylinderGeometry(3.2, 3.6, 0.5, 12).translate(x, ty + 0.72, z)); tints.push([1.06, 1.02, 0.90]);
            parts.push(new THREE.CylinderGeometry(1.5, 1.8, 1.6, 10).translate(x, ty + 1.75, z)); tints.push([1.20, 0.94, 0.44]);
            col.add({ type: 'capsule', a: V3(x, ty, z), b: V3(x, ty + 2.6, z), r: 2.0 });
          }
        } else if (s.kind === 'void') {
          const n2 = hero ? 5 : 3;
          for (let c = 0; c < n2; c++) {                                    // snapped pillars, leaning the wrong way
            const ca2 = rng() * Math.PI * 2, rr = R * (0.2 + rng() * 0.45), ph = 2.4 + rng() * (hero ? 7 : 3.5);
            const px = x + Math.cos(ca2) * rr, pz = z + Math.sin(ca2) * rr;
            parts.push(new THREE.BoxGeometry(0.85, ph, 0.85).rotateY(rng()).rotateZ((rng() - 0.5) * 0.55).translate(px, ty + ph / 2, pz));
            tints.push([0.36, 0.30, 0.52]);
            col.add({ type: 'capsule', a: V3(px, ty, pz), b: V3(px, ty + ph * 0.8, pz), r: 0.7 });
          }
          for (let c = 0; c < 4; c++) {                                     // rubble that never landed, orbiting the cap
            const ca2 = rng() * Math.PI * 2, rr = R * (0.5 + rng() * 0.6), sc = 0.5 + rng() * 1.2;
            const g2 = makeRockGeometry(1, (rng() * 1e6) | 0);
            g2.scale(sc, sc * 0.7, sc); g2.rotateX(rng() * 3); g2.rotateZ(rng() * 3);
            g2.translate(x + Math.cos(ca2) * rr, ty + 2.5 + rng() * 6, z + Math.sin(ca2) * rr);
            parts.push(g2); tints.push([0.40, 0.33, 0.56]);
          }
        }"""),
 ("""          const g = new THREE.BoxGeometry(2.6, 0.55, L).rotateY(ry).translate(px, py, pz);
          parts.push(g); tints.push([s.tint[0] * 0.92, s.tint[1] * 0.92, s.tint[2] * 0.92]);
          col.add({ type: 'box', box: new THREE.Box3(V3(px - 1.6, py - 0.3, pz - 1.6), V3(px + 1.6, py + 0.28, pz + 1.6)), walkable: true });""",
  """          const g = new THREE.BoxGeometry(2.6, 0.55, L).rotateY(ry).translate(px, py, pz);
          parts.push(g); tints.push([s.tint[0] * 0.92, s.tint[1] * 0.92, s.tint[2] * 0.92]);
          // Kerbs and posts. A 2.6 x 0.55 slab seen from the side is a plank hanging in the air — which is
          // exactly how the spans read from the ground below, the angle you spend the most time at. A raised
          // edge and a post at each joint give it a profile, and read as a bridge from any angle.
          for (const sd of [-1, 1]) {
            const ox = -uz * sd * 1.15, oz = ux * sd * 1.15;
            const gk2 = new THREE.BoxGeometry(0.32, 0.46, L).rotateY(ry).translate(px + ox, py + 0.34, pz + oz);
            parts.push(gk2); tints.push([s.tint[0] * 1.02, s.tint[1] * 1.02, s.tint[2] * 1.02]);
            const gp = new THREE.BoxGeometry(0.42, 1.05, 0.42).rotateY(ry).translate(px + ox - ux * (L * 0.5 - 0.3), py + 0.6, pz + oz - uz * (L * 0.5 - 0.3));
            parts.push(gp); tints.push([s.tint[0] * 0.98, s.tint[1] * 0.98, s.tint[2] * 0.98]);
          }
          col.add({ type: 'box', box: new THREE.Box3(V3(px - 1.6, py - 0.3, pz - 1.6), V3(px + 1.6, py + 0.28, pz + 1.6)), walkable: true });"""),
 # --- The Drowned Court: something worth holding your breath for
 ("""        slab(CX, top + 2.6, CZ - 4, 8, 5.2, 1.4, 0, [0.68, 0.78, 0.76]);        // the throne nobody sits on""",
  """        slab(CX, top + 2.6, CZ - 4, 8, 5.2, 1.4, 0, [0.68, 0.78, 0.76]);        // the throne nobody sits on
        // The hoard at the foot of the throne. The Sunken Kingdom is the one region you have to hold your
        // breath to reach the bottom of and there was nothing down there to find — so: spilled coin, a
        // broken chest, and the crown, all in gold that is saturated but nowhere near the bloom threshold.
        for (let i = 0; i < 26; i++) {
          const a = rng() * 6.2832, d = rng() * 5.5;
          P(new THREE.CylinderGeometry(0.22 + rng() * 0.18, 0.24 + rng() * 0.2, 0.10, 10)
            .rotateZ((rng() - 0.5) * 0.9).translate(CX + Math.cos(a) * d, top + 0.1 + rng() * 0.35, CZ + 2.5 + Math.sin(a) * d), [1.06, 0.78, 0.24]);
        }
        for (const sd of [-1, 1]) P(new THREE.BoxGeometry(2.2, 1.1, 1.4).rotateY(0.3 * sd).translate(CX + sd * 4.5, top + 0.55, CZ + 3.2), [0.42, 0.30, 0.20]);
        P(new THREE.TorusGeometry(0.62, 0.10, 6, 16).rotateX(Math.PI / 2).translate(CX, top + 0.14, CZ + 2.2), [1.10, 0.84, 0.30]);
        for (let i = 0; i < 6; i++) P(new THREE.ConeGeometry(0.13, 0.42, 5).translate(CX + Math.cos(i / 6 * 6.2832) * 0.62, top + 0.36, CZ + 2.2 + Math.sin(i / 6 * 6.2832) * 0.62), [1.10, 0.84, 0.30]);"""),
])
print('all patched')
