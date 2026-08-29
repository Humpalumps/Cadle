# The ornament standard — why our architecture reads as greybox, and the bar that fixes it

**User verdict, 2026-08-26, on the freshly converted Empyrean Gate: "quality on this isn't that
impressive."** Correct. Compare `tools/out/w4-gate/ref-vs-game.png`: the Tripo reference carries
fluted columns, a dentilled cornice, a sculpted relief cartouche, delicate gold scroll tracery and
weathered veined marble. What shipped is smooth cylinders, flat bands, an orange decal sun, concentric
orange rings for the archivolt, and pristine untextured cream.

The gate's *massing* is good — real podium courses, an entablature that breaks forward over each
column, sightline maths done against the height field. The **surface craft is missing entirely**, and
that is a systemic problem, not one landmark: nearly every prop in this game is `BoxGeometry` plus a
flat vertex tint. That is what "greybox with paint on it" means, and it is why landmarks keep scoring
4-6 no matter how many times their proportions are re-tuned.

## The rule

**Massing is not detail.** A landmark passes when it holds up at THREE distances:

| distance | what must read | failure mode we keep shipping |
|---|---|---|
| 200 m+ | silhouette against sky, value separation from the backdrop | a shape that dissolves into the ridge |
| 40 m | ornament HIERARCHY — you can see that the cornice is carved, the columns are fluted, the panel holds a relief | flat bands that read as painted stripes |
| 8 m | material truth — stone has veining, depth and dirt; metal is metal; edges are chipped and old | crisp untextured primitives, uniform colour |

A builder who fixes only the 200 m read (three waves running on this gate) has fixed one third of the
problem.

## The ornament library (build it once in Props.js, use it everywhere)

None of this needs new assets — it is all procedural geometry plus the textures already preloaded.

- **`flute(r, h, n)`** — a fluted column shaft: `LatheGeometry` whose profile radius is modulated by
  `cos(n*theta)`, or a shaft ringed by n half-round grooves. Doric/Ionic capitals are two more lathes.
  A smooth cylinder is never a classical column.
- **`moulding(profile, len)`** — sweep a real profile (ovolo, cavetto, cyma recta, fillet) along an
  edge. Cornices, string courses, plinth caps and archivolts are all this one helper. A `BoxGeometry`
  with a thinner `BoxGeometry` on top is not a moulding.
- **`dentils(len, n)` / `coffer(w, d, n)`** — repeated small blocks under a cornice; sunken panels in
  a soffit or vault. Cheap, instanced, and they are what makes stone read as *carved* at 40 m.
- **`relief(w, h, motif)`** — a displaced plane for tympanum and frieze panels. Generate the height
  from a procedural motif (figures, acanthus, sunburst) and displace vertices; a flat quad with an
  emissive decal on it reads as a sticker, which is exactly what the gate's sun currently is.
- **`trace(path, r)`** — gold scrollwork as thin `TubeGeometry` swept along a curve, RAISED off the
  surface. The house style is "ornate gold filigree on dark materials"; a flat orange rectangle is not
  filigree. Gold must be a metal MATERIAL (metalness ~1.0, roughness 0.2-0.35, warm albedo), never an
  emissive band — emissive gold is also how the blob bug gets back in.
- **`weather(geo, amount)`** — the single highest-value helper. Bake vertex AO into crevices (darken
  verts by local concavity), chip edges with noise displacement, and add grime in recesses. New,
  perfectly sharp stone is the strongest "greybox" tell there is, and every ruin in this world is
  supposed to be ancient.

## Materials

Stone must carry its texture. `marble_strata`, `granite_carved`, `megalith_violet`, `granite_moss`
and friends are preloaded and were generated exactly for this — a flat tint array (`MARB = [1.22,
1.19, 1.15]`) is not a material. Derive a normal map from texture luma so the veining catches light,
give recesses a roughness lift, and keep the triplanar scale honest (~1 m features on a 40 m
monument, not 3 m sedimentary courses).

## Acceptance, per landmark

Before reporting done, capture 200 m / 40 m / 8 m plus one night frame, put them beside the region's
Tripo reference render if it has one, and ask the question the critics ask: *would this ship in a
Destiny 2 destination?* If the answer at 8 m is "it is a clean box", it is not done.

## Scope

This applies to all ten landmarks, the biome clutter kits and the ruin sets — the Elderheart (crown
currently reads as flat-shaded boulders), Kharaz-Dun, the Convergence, the Glacier Throne, the
Hagstone, the Drowned Court, the Unmaking, the Cinder Maw, the Aetheryte and Hearthfall. Build the
library first, then sweep the landmarks with it; do not hand-roll ornament per landmark.
