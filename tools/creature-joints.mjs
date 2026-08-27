// Skeleton prune for Tripo-rigged creature GLBs.  Used by tools/optimize-creature.mjs.
//
// WHY: Tripo rigs to 34-101 joints. Skeleton.update() + the bone hierarchy's updateMatrixWorld is the
// dominant per-frame CPU cost of a crowd of skinned enemies (per-bone, per-skeleton, per-frame:
// 50 monsters x 101 joints is ~5,000 matrix compositions before a triangle is drawn). Fingers, toes and
// facial bones drive nothing readable on a crowd enemy at combat range. See docs/CREATURE-PIPELINE.md
// "The bone plan". Doing this at CONVERSION time is the whole point — retrofitting 13 creatures later
// is miserable, and the pruned skeleton is also what stabilises the semantic bone map the game animates
// against (Tripo names the joints it considers structural `tripo::*` and the filler `bone_N`).
//
// WHAT IT DOES, exactly:
//   keep  = joint 0 (root) + every `tripo::`-named joint + every joint carrying >= massFloor of the
//           total skin weight + every joint-ancestor of a kept joint (so no chain is ever broken).
//   drop  = the rest. Each dropped joint's skin weights are folded into its nearest KEPT ancestor
//           (never deleted), and its children are re-parented to its own parent with their local
//           matrix pre-multiplied by the dropped joint's, so every surviving bone's WORLD bind pose is
//           bit-identical. Inverse bind matrices are therefore just a row subset — no recompute.
// Deformation loss is limited to the removed joints' own motion, which for `bone_N` filler is sub-pixel
// at combat range. Nothing else about the asset changes.

/** column-major 4x4 (glTF order) multiply: out = a * b */
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

/**
 * @param {number} target   soft joint ceiling; below it the skin is left alone entirely
 * @param {number} massFloor fraction of total skin weight below which an unnamed joint is filler
 * @param {(s:string)=>void} log
 */
export function pruneJoints(target = 32, massFloor = 0.012, log = () => {}) {
  return (doc) => {
    for (const skin of doc.getRoot().listSkins()) {
      const joints = skin.listJoints();
      const n = joints.length;
      if (n <= target) { log(`joints ${n} <= ${target}, left alone`); continue; }

      // ANIMATION SAFETY. Dropping an interior joint folds its rest transform into its children's
      // LOCAL transforms - which silently invalidates any animation channel that writes an absolute
      // local T/R/S to one of those children (glTF has no matrix track to compose into). So when the
      // document carries baked clips, only ever drop joints that have no kept descendant: nothing is
      // folded into a survivor, so every surviving channel stays exactly as authored. The iterative
      // leaf shed below already peels filler chains one ring per round, so this costs little.
      const leafOnly = doc.getRoot().listAnimations().length > 0;

      // ---- primitives skinned by THIS skin
      const prims = [];
      for (const node of doc.getRoot().listNodes()) {
        if (node.getSkin() !== skin) continue;
        const mesh = node.getMesh(); if (!mesh) continue;
        for (const p of mesh.listPrimitives()) prims.push(p);
      }

      // ---- weight mass per joint
      const mass = new Float64Array(n); let total = 0;
      for (const p of prims) {
        const J = p.getAttribute('JOINTS_0'), W = p.getAttribute('WEIGHTS_0');
        if (!J || !W) continue;
        const j = [0, 0, 0, 0], w = [0, 0, 0, 0];
        for (let i = 0; i < J.getCount(); i++) {
          J.getElement(i, j); W.getElement(i, w);
          for (let k = 0; k < 4; k++) { if (w[k] > 0 && j[k] < n) { mass[j[k]] += w[k]; total += w[k]; } }
        }
      }
      if (total <= 0) { log('no skin weights found — skipping prune'); continue; }

      // ---- parent map, in JOINT-INDEX space (a joint's parent may be a non-joint node: then -1)
      const idxOf = new Map(joints.map((jn, i) => [jn, i]));
      const parent = new Int32Array(n).fill(-1);
      for (let i = 0; i < n; i++) { const p = joints[i].getParentNode(); if (p && idxOf.has(p)) parent[i] = idxOf.get(p); }

      // ---- keep set
      const keep = new Uint8Array(n);
      keep[0] = 1;
      for (let i = 0; i < n; i++) {
        const name = joints[i].getName() || '';
        if (name.startsWith('tripo::') || mass[i] / total >= massFloor) keep[i] = 1;
      }
      if (leafOnly) {
        // rebuild the drop set as "leaves only": a joint may go only if every one of its descendants
        // is also going. Walk children-last so the decision propagates up the chain.
        const hasChild = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (parent[i] >= 0) hasChild[parent[i]] = 1;
        for (let i = n - 1; i >= 0; i--) if (!keep[i] && hasChild[i]) {
          for (let k = 0; k < n; k++) if (parent[k] === i && keep[k]) { keep[i] = 1; break; }
        }
      }
      // never break a chain: every joint-ancestor of a kept joint stays
      for (let i = 0; i < n; i++) if (keep[i]) for (let p = parent[i]; p >= 0 && !keep[p]; p = parent[p]) keep[p] = 1;

      // ---- if the structural set alone still busts the ceiling, shed the lightest LEAF joints
      // (a leaf carries no chain below it, so removing it cannot change any other bone's pose).
      // Iterative, because shedding a tip promotes its parent to a leaf: a 6-long tail chain of filler
      // tips comes off one ring per round. Guarded by mass — a joint carrying real deformation
      // (shoulder, hip, jaw) is never shed however leaf-like it is, so a limb can lose its finger tip
      // but never its wrist.
      let kept = keep.reduce((s, v) => s + v, 0);
      const SHED_MAX_MASS = 0.02;
      while (kept > target) {
        const isLeaf = new Uint8Array(n).fill(1);
        for (let i = 0; i < n; i++) if (keep[i] && parent[i] >= 0) isLeaf[parent[i]] = 0;
        const cands = [];
        for (let i = 1; i < n; i++) if (keep[i] && isLeaf[i] && mass[i] / total < SHED_MAX_MASS && !(leafOnly && joints[i].getName()?.startsWith('tripo::'))) cands.push(i);
        if (!cands.length) break;
        cands.sort((a, b) => mass[a] - mass[b]);
        for (const i of cands) { if (kept <= target) break; keep[i] = 0; kept--; }
      }

      // ---- nearest kept ancestor for every dropped joint (computed on the ORIGINAL hierarchy)
      const remap = new Int32Array(n);
      for (let i = 0; i < n; i++) { let a = i; while (a >= 0 && !keep[a]) a = parent[a]; remap[i] = a < 0 ? 0 : a; }
      // old joint index -> new joint index (kept joints keep their relative order)
      const newIdx = new Int32Array(n).fill(-1);
      let c = 0; for (let i = 0; i < n; i++) if (keep[i]) newIdx[i] = c++;

      // ---- rewrite skin weights: fold dropped influences into the kept ancestor, merge duplicates
      for (const p of prims) {
        const J = p.getAttribute('JOINTS_0'), W = p.getAttribute('WEIGHTS_0');
        if (!J || !W) continue;
        const j = [0, 0, 0, 0], w = [0, 0, 0, 0], oj = [0, 0, 0, 0], ow = [0, 0, 0, 0];
        for (let i = 0; i < J.getCount(); i++) {
          J.getElement(i, j); W.getElement(i, w);
          oj[0] = oj[1] = oj[2] = oj[3] = 0; ow[0] = ow[1] = ow[2] = ow[3] = 0;
          let m = 0;
          for (let k = 0; k < 4; k++) {
            if (!(w[k] > 0)) continue;
            const nj = newIdx[remap[Math.min(j[k], n - 1)]];
            let hit = -1; for (let q = 0; q < m; q++) if (oj[q] === nj) { hit = q; break; }
            if (hit >= 0) ow[hit] += w[k];
            else if (m < 4) { oj[m] = nj; ow[m] = w[k]; m++; }
            else { let lo = 0; for (let q = 1; q < 4; q++) if (ow[q] < ow[lo]) lo = q; ow[lo] += w[k]; }  // >4 collapsed influences: give the weight to the smallest slot rather than losing it
          }
          const s = ow[0] + ow[1] + ow[2] + ow[3];
          if (s > 0) for (let k = 0; k < 4; k++) ow[k] /= s;
          J.setElement(i, oj); W.setElement(i, ow);
        }
      }

      // ---- inverse bind matrices: a row subset, kept joints unchanged (their world bind pose is preserved)
      const ibm = skin.getInverseBindMatrices();
      if (ibm) {
        const out = new Float32Array(c * 16), row = new Array(16);
        for (let i = 0; i < n; i++) if (keep[i]) { ibm.getElement(i, row); out.set(row, newIdx[i] * 16); }
        ibm.setArray(out);
      }

      // ---- hierarchy surgery: fold each dropped joint's local matrix into its children, then delete it
      const dropped = []; for (let i = 0; i < n; i++) if (!keep[i]) dropped.push(joints[i]);
      const gone = new Set(dropped);
      for (const anim of doc.getRoot().listAnimations()) {
        for (const ch of anim.listChannels()) if (gone.has(ch.getTargetNode())) { anim.removeChannel(ch); ch.dispose(); }
      }
      for (const d of dropped) {
        const P = d.getParentNode();
        const M = d.getMatrix();
        for (const ch of d.listChildren()) { ch.setMatrix(mul(M, ch.getMatrix())); d.removeChild(ch); if (P) P.addChild(ch); }
        skin.removeJoint(d);
        if (P) P.removeChild(d);
        d.dispose();
      }
      log(`joints ${n} -> ${c} (dropped ${dropped.length}; kept every tripo::* + >=${(massFloor * 100).toFixed(1)}% mass + their ancestors)`);
    }
  };
}
