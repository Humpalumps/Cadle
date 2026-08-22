import io, sys, os
os.chdir(r'C:\Users\ianca\Desktop\fps4')

def edit(path, pairs):
    s = open(path, encoding='utf-8').read()
    for a, b in pairs:
        assert s.count(a) == 1, (path, a[:70], s.count(a))
        s = s.replace(a, b)
    open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('ok', path)

# ---------------------------------------------------------------- Biomes: forest floor is not a lawn
edit('src/world/Biomes.js', [
 ("ground: 'forest', grass: { d: 0.85, tint: 0x9fd4a8 }, music: 'wood',",
  "ground: 'forest', grass: { d: 0.40, tint: 0x6f9c7a }, music: 'wood',   // 0.85 was a knee-high LAWN under the canopy; a forest floor is litter, moss and fern (Props KIT.forest), with grass only in the gaps"),
])

# ---------------------------------------------------------------- Terrain: darker Whisperwood floor, colder Dragon rock
edit('src/world/Terrain.js', [
 ("if (k < 0.5)      { layer = 1.0;  scl = 3.4; cov = 0.86; tint = vec3(0.52, 0.74, 0.60); }",
  "if (k < 0.5)      { layer = 1.0;  scl = 3.4; cov = 0.92; tint = vec3(0.42, 0.60, 0.50); }"),
 ("else if (k < 3.5) { layer = 3.0;  scl = 6.0; cov = 0.70; tint = vec3(0.90, 0.92, 1.00); }",
  "else if (k < 3.5) { layer = 3.0;  scl = 6.0; cov = 0.88; tint = vec3(0.84, 0.88, 1.02); }"),
 ("const BALB = [[0.061, 0.091, 0.038],",
  "const BALB = [[0.049, 0.074, 0.032],"),
 ("[0.20, 0.20, 0.19], [0.055, 0.042, 0.038]",
  "[0.185, 0.192, 0.196], [0.055, 0.042, 0.038]"),
])

# ---------------------------------------------------------------- Vegetation: close the Whisperwood canopy
edit('src/world/Vegetation.js', [
 ("forest:    { p: 0.52, sp: [0, 1], col: [0.72, 1.12, 0.94], gv: 0.62 },",
  "forest:    { p: 0.66, sp: [0, 1], col: [0.62, 1.02, 0.86], gv: 0.86 },   // Ashenvale is a CLOSED canopy: gv 0.62 left grove-shaped clearings the size of a football pitch at the region's heart"),
])

# ---------------------------------------------------------------- Props: region kits
edit('src/world/Props.js', [
 # --- Whisperwood Deep: fern undergrowth + elven ruins going under the moss
 ("""      forest: { mat: 'stone', n: 120, tint: [0.60, 0.56, 0.44], build: (x, y, z, P) => {
        if (rng() < 0.5) {                                                  // fallen log, mossed on the up side""",
  """      forest: { mat: 'stone', n: 340, tint: [0.60, 0.56, 0.44], build: (x, y, z, P) => {
        const kf = rng();
        if (kf < 0.42) {                                                    // FERN clump: the forest floor, instead of meadow grass
          const cnt = 5 + ((rng() * 6) | 0), tc = [0.16 + rng() * 0.08, 0.34 + rng() * 0.12, 0.20 + rng() * 0.08];
          for (let i = 0; i < cnt; i++) {
            const a = (i / cnt) * 6.2832 + rng() * 0.6, len = 0.55 + rng() * 0.85;
            P(box(0.06, len, 0.30).rotateZ(0.85 + (rng() - 0.5) * 0.35).rotateY(a)
              .translate(x + Math.cos(a) * len * 0.34, y + 0.12 + len * 0.30, z + Math.sin(a) * len * 0.34), tc);
          }
          return;
        }
        if (kf < 0.62) {                                                    // elven ruin going under the moss: a step, a jamb, a fallen lintel
          const a = rng() * Math.PI, ca = Math.cos(a), sa = Math.sin(a), mc = [0.40, 0.50, 0.36];
          const kind = rng();
          if (kind < 0.4) {                                                 // half-buried stair block, moss on the tread
            for (let i = 0; i < 3; i++) P(box(3.2 - i * 0.5, 0.42, 1.1).rotateY(a).translate(x - sa * i * 0.9, y + 0.1 + i * 0.34, z + ca * i * 0.9), i ? mc : [0.46, 0.44, 0.36]);
            col.add({ type: 'sphere', pos: V3(x, y + 0.5, z), r: 1.7 });
          } else if (kind < 0.78) {                                         // a jamb still standing, its arch snapped off
            const hh = 2.4 + rng() * 2.6;
            P(box(0.62, hh, 0.62).rotateY(a).translate(x, y + hh / 2 - 0.2, z), [0.44, 0.46, 0.36]);
            P(box(0.78, 0.34, 0.78).rotateY(a).translate(x, y + hh - 0.3, z), mc);
            col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 0.4, z), r: 0.55 });
          } else {                                                          // the lintel that came off it, in the leaf litter
            P(box(2.6 + rng() * 1.4, 0.5, 0.7).rotateY(a).rotateZ((rng() - 0.5) * 0.25).translate(x, y + 0.22, z), mc);
          }
          return;
        }
        if (rng() < 0.5) {                                                  // fallen log, mossed on the up side"""),
 # --- Shadowfen: witchlight fungus shelves + hanging moss on the dead wood
 ("""      shadowfen: { mat: 'stone', n: 220, tint: [0.52, 0.60, 0.40], build: (x, y, z, P) => {
        if (rng() < 0.62) {                                                 // reed clump""",
  """      shadowfen: { mat: 'stone', n: 300, tint: [0.52, 0.60, 0.40], build: (x, y, z, P) => {
        const ks = rng();
        if (ks < 0.20) {                                                    // a drowned snag hung with moss: the fen's vertical, and what makes it feel roofed
          const hh = 3.0 + rng() * 3.4, a = rng() * 6.2832;
          P(cyl(0.14, 0.30, hh, 6).rotateZ((rng() - 0.5) * 0.30).rotateY(a).translate(x, y + hh / 2 - 0.2, z), [0.24, 0.23, 0.19]);
          const drapes = 3 + ((rng() * 4) | 0);
          for (let i = 0; i < drapes; i++) {                                // hanging moss: thin ragged sheets off the limbs
            const da = rng() * 6.2832, dd = 0.35 + rng() * 0.9, dl = 0.9 + rng() * 1.8;
            P(box(0.05, dl, 0.34 + rng() * 0.3).rotateY(da).translate(x + Math.cos(da) * dd, y + hh * (0.55 + rng() * 0.35) - dl * 0.5, z + Math.sin(da) * dd),
              [0.30 + rng() * 0.10, 0.40 + rng() * 0.12, 0.22]);
          }
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: 0.45 });
          return;
        }
        if (rng() < 0.62) {                                                 // reed clump"""),
 # --- Dragon Peaks: gold ore in the rock, and a nest with something in it
 ("""      dragon: { mat: 'basalt', n: 130, tint: [0.86, 0.84, 0.80], build: (x, y, z, P) => {
        if (rng() < 0.34) {                                                // ribcage""",
  """      dragon: { mat: 'basalt', n: 210, tint: [0.86, 0.84, 0.80], build: (x, y, z, P) => {
        const kd = rng();
        if (kd < 0.24) {                                                   // dwarven ore working: a gold seam cut open, with the spoil under it
          const a = rng() * Math.PI, ca = Math.cos(a), sa = Math.sin(a), seg = 2 + ((rng() * 3) | 0);
          for (let i = 0; i < seg; i++) {
            const t = (i - seg / 2) * 1.1;
            P(box(1.0 + rng() * 0.6, 0.26, 0.34).rotateY(a).rotateZ(0.18 + (rng() - 0.5) * 0.3)
              .translate(x + ca * t, y + 0.5 + i * 0.26 + rng() * 0.6, z + sa * t), [1.10, 0.80, 0.24]);   // gold: saturated hue, ordinary value — it catches the sun, it does not bloom
          }
          for (let i = 0; i < 3; i++) { const g = rock(2); const sc = 0.3 + rng() * 0.5; g.scale(sc, sc * 0.6, sc); g.translate(x + (rng() - 0.5) * 2.4, y + 0.1, z + (rng() - 0.5) * 2.4); P(g, [0.58, 0.54, 0.50]); }
          return;
        }
        if (kd < 0.36) {                                                   // a nest: a bowl of splintered wood with eggs still in it
          const cnt = 11;
          for (let i = 0; i < cnt; i++) {
            const a = (i / cnt) * 6.2832;
            P(cyl(0.09, 0.13, 1.5, 4).rotateZ(1.05).rotateY(a).translate(x + Math.cos(a) * 1.5, y + 0.32, z + Math.sin(a) * 1.5), [0.36, 0.30, 0.24]);
          }
          for (let i = 0; i < 3; i++) {
            const a = rng() * 6.2832, d = rng() * 0.7;
            P(new THREE.SphereGeometry(0.42, 10, 8).scale(0.78, 1.0, 0.78).rotateZ((rng() - 0.5) * 0.5)
              .translate(x + Math.cos(a) * d, y + 0.42, z + Math.sin(a) * d), [0.72, 0.66, 0.54]);
          }
          col.add({ type: 'sphere', pos: V3(x, y + 0.4, z), r: 1.8 });
          return;
        }
        if (rng() < 0.34) {                                                // ribcage"""),
 # --- Frostveil: icicle curtains and pressure-ice pillars
 ("""      tundra: { mat: 'ice', n: 130, tint: [0.92, 0.96, 1.04], build: (x, y, z, P) => {
        if (rng() < 0.6) {                                                  // wind-carved drift""",
  """      tundra: { mat: 'ice', n: 190, tint: [0.92, 0.96, 1.04], build: (x, y, z, P) => {
        const kt = rng();
        if (kt < 0.22) {                                                    // pressure-ice pillar hung with icicles — Winterspring's vertical
          const hh = 2.6 + rng() * 3.8, r0 = 0.5 + rng() * 0.5;
          P(cyl(r0 * 0.55, r0, hh, 6).rotateY(rng()).translate(x, y + hh / 2 - 0.2, z), [0.86, 0.94, 1.06]);
          const ic = 5 + ((rng() * 6) | 0);
          for (let i = 0; i < ic; i++) {
            const a = (i / ic) * 6.2832 + rng() * 0.5, il = 0.5 + rng() * 1.3;
            P(cone(0.09 + rng() * 0.05, il, 5).rotateX(Math.PI).translate(x + Math.cos(a) * r0 * 1.05, y + hh - il * 0.5, z + Math.sin(a) * r0 * 1.05), [0.92, 0.98, 1.10]);
          }
          col.add({ type: 'capsule', a: V3(x, y - 1, z), b: V3(x, y + hh - 1, z), r: r0 + 0.2 });
          return;
        }
        if (rng() < 0.6) {                                                  // wind-carved drift"""),
])
print('all patched')
