import * as THREE from 'three';

/**
 * glbBody: turn a rigged Tripo GLB into exactly the asset shape Rig.build() returns, so Enemy.js can consume
 * a generated creature with no special-casing beyond the material.
 *
 * THE ONE RULE THAT KEEPS GAMEPLAY IDENTICAL: the GLB is yawed, uniformly scaled and translated so its
 * BIND-POSE BOUNDING BOX matches the procedural body's bounding box for the same type. def.radius/height/
 * center, the standoff ring, hover height, weak-point offsets and def.scale were all tuned against that box,
 * so matching it is a zero-regression swap. Height decides the scale (that is what the combat capsule is
 * keyed to); X/Z centre and the box FLOOR are matched for placement.
 *
 * WHY THE BIND POSE IS LOAD-BEARING: a Tripo joint's local rotation is NOT identity — every bone frame is
 * aimed along its own chain. Skin weights are relative to that pose, so it cannot be normalised away (the
 * inverse-bind matrices would have to change with it, which re-deforms the mesh). Every animation therefore
 * composes ONTO the bind quaternion, which is why `bindQuat` is in the asset and why `boneAxes` (below)
 * exists: it maps world X/Y/Z into each bone's own parent frame so "swing this leg about the lateral axis"
 * is a correct sentence on all twelve skeletons instead of a per-model guess.
 *
 * Returns { geometry, bonesTemplate, boneInverses, boneNames, bindPos, bindQuat, glb:true, tex, ...extras }.
 * Extras (read only by glbAnim.js, additive — nothing else needs to know): boneAxes, chains, auxChains.
 */

// ---------------------------------------------------------------------------------------------------
// PER-TYPE CONFIG — derived by reading every skeleton (see the joint inventory in the wave report), NOT
// guessed. Every value here is a one-number correction knob for the integrate pass:
//   profile    which animator in glbAnim.js drives it
//   yaw        radians about Y applied to the GLB before the box match. Our convention is +Z FORWARD,
//              +X LEFT. Tripo emitted the quadrupeds/serpents facing +Z and every upright facing +X,
//              except the frostwolf which is a quadruped facing +X. VERIFIED per model from the joint
//              positions (head chain / toe direction vs the lateral axis the legs are mirrored across).
//   scale      multiplier on the height-matched uniform scale. 1 = exactly the procedural body's height.
//   lift       metres (in ref space) added to the Y placement. Feet-contact correction; +up.
//   walkGroup  null = classify legs geometrically (a chain whose tip sits at the bottom of the skeleton).
//              0|1 forces that Tripo limb group to be the legs. The auto path is the DEFAULT on purpose:
//              Tripo's group/side labels are wrong on 5 of the 12 rigs (drake, golem, sentinel, giant,
//              warden all have one leg filed under "0_Left" and the other under "1_Right"), so geometry
//              is a more reliable classifier than the name. Set this only if a screenshot proves otherwise.
//   headIndex  which Head_ joint carries the 'head' alias. -1 = the last (skull tip).
//   headBone   post-rename bone name to alias as 'head' when the rig has NO Head_ chain at all
//              (golem and warden do not — Tripo filed their neck under a limb group).
// ---------------------------------------------------------------------------------------------------
const Y90 = -Math.PI / 2;   // maps the model's +X onto our +Z; also puts Tripo-Left on our +X

export const GLB_CFG = {
  // ---- quadrupeds: four chains reaching the ground, spine + head + tail
  hound:     { profile: 'quadruped', yaw: 0,   scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
  riftling:  { profile: 'quadruped', yaw: 0,   scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
  frostwolf: { profile: 'quadruped', yaw: Y90, scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
  // ---- flyers: wings are chains hanging off the spine (drake's are unnamed filler, sprite's are limb group 0)
  drake:     { profile: 'flyer',     yaw: 0,   scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
  sprite:    { profile: 'flyer',     yaw: Y90, scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
  // ---- serpent: no spine and no limbs at all, just Head_0..4 and a 9-joint coiling Tail
  serpent:   { profile: 'serpent',   yaw: 0,   scale: 1, lift: 0, walkGroup: null, headIndex: 0,  headBone: null },
  // ---- hover: nothing reaches the ground; robe/tendril chains instead of legs
  wraith:    { profile: 'hover',     yaw: Y90, scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
  // ---- bipeds: two chains to the ground, arms above
  sentinel:  { profile: 'biped',     yaw: Y90, scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
  treant:    { profile: 'biped',     yaw: Y90, scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
  golem:     { profile: 'biped',     yaw: Y90, scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: 'L1L_2' },
  giant:     { profile: 'biped',     yaw: Y90, scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
  warden:    { profile: 'biped',     yaw: Y90, scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: 'L1R_3' },
  // NPC quest giver, not in DEFS — here so it is drivable the moment someone wires it up
  wayfinder: { profile: 'biped',     yaw: Y90, scale: 1, lift: 0, walkGroup: null, headIndex: -1, headBone: null },
};

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const AX = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/** Replace a normalized-integer attribute with a plain Float32 one, in place. No-op when already float. */
function dequantize(geo, name) {
  const a = geo.attributes[name];
  if (!a || (!a.normalized && a.array instanceof Float32Array)) return;
  const f = new Float32Array(a.count * a.itemSize);
  for (let i = 0, k = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) f[k++] = a.getComponent(i, c);
  geo.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
}

/** @param {THREE.Object3D} scene gltf.scene from game.assets.model()  @param cfg one GLB_CFG entry  @param refAsset the procedural asset for the same type */
export function buildGlbBody(scene, cfg, refAsset) {
  if (!scene || !refAsset) return null;
  if (scene.userData.__glbAsset) return scene.userData.__glbAsset;   // two enemy types can share one body: bake once
  let mesh = null;
  scene.updateMatrixWorld(true);
  scene.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
  if (!mesh || !mesh.skeleton) return null;

  const bones = mesh.skeleton.bones.slice(), n = bones.length;
  // Bind world matrices, in the GLB's world space. Taken from the INVERSE BIND MATRICES rather than the node
  // poses: the IBMs are what the skin weights are actually relative to, so if a rig's node pose ever drifts
  // from its bind pose the mesh still binds undeformed.
  const W = mesh.skeleton.boneInverses.map((ib) => new THREE.Matrix4().copy(ib).invert());
  const bindMatrix = mesh.bindMatrix ?? mesh.matrixWorld;

  // ---- the normalising transform A = T(p) * S(s) * RotY(yaw), matched against the procedural body's box
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  if (!refAsset.geometry.boundingBox) refAsset.geometry.computeBoundingBox();
  const ref = refAsset.geometry.boundingBox;
  const pre = new THREE.Matrix4().makeRotationY(cfg.yaw ?? 0).multiply(bindMatrix);
  const box = geo.boundingBox.clone().applyMatrix4(pre);
  const s = ((ref.max.y - ref.min.y) / Math.max(1e-6, box.max.y - box.min.y)) * (cfg.scale ?? 1);
  const p = new THREE.Vector3(
    (ref.max.x + ref.min.x) * 0.5 - s * (box.max.x + box.min.x) * 0.5,
    ref.min.y + (cfg.lift ?? 0) - s * box.min.y,
    (ref.max.z + ref.min.z) * 0.5 - s * (box.max.z + box.min.z) * 0.5,
  );
  const qYaw = new THREE.Quaternion().setFromAxisAngle(AX[1], cfg.yaw ?? 0);

  // ---- geometry: bake A * bindMatrix into positions (applyMatrix4 fixes normals via the normal matrix too)
  const A = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeScale(s, s, s));
  // DEQUANTIZE FIRST. KHR_mesh_quantization stores POSITION as NORMALIZED int16, i.e. the array can only
  // represent [-1, 1]. BufferAttribute.applyMatrix4 denormalizes, transforms, then RE-normalizes — so every
  // coordinate our metre-space transform pushes past 1.0 wraps around the Int16 range and the mesh renders as
  // flat slabs. Severity scaled with the creature's size (a 4 m treant collapsed to a card, a 1 m drake only
  // grew slabs), which is what made it look like a per-bone bind-matrix problem. Positions must be float
  // before ANY bake. Normals stay quantized: applyNormalMatrix re-normalizes them to unit length, in range.
  dequantize(geo, 'position');
  geo.applyMatrix4(_m.copy(A).multiply(pre));
  const vc = geo.attributes.position.count;
  // the shared creature program reads both of these; a GLB has neither. White base colour = the texture's
  // own albedo survives untouched, aGlow 0 = no aether channel (per-creature glow comes from the material).
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vc * 3).fill(1), 3));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(vc), 1));
  geo.computeBoundingSphere(); geo.boundingSphere.radius *= 1.5;   // animation slack, same as Rig.build

  // ---- target bind world per bone: rigid (scale 1). The uniform scale s rides in the bone POSITIONS instead
  // of a bone scale, because Enemy.spawn() resets every bone scale to 1 on respawn and would undo it.
  const Wt = W.map((w) => {
    w.decompose(_p, _q, _s);
    return new THREE.Matrix4().compose(
      _p.applyQuaternion(qYaw).multiplyScalar(s).add(p),
      _q.premultiply(qYaw),
      _s.set(1, 1, 1),
    );
  });

  // ---- hierarchy: parent = nearest ancestor that is also a skeleton bone. Locals derived from Wt, so the
  // pose is exact no matter what the source node transforms said.
  const idx = new Map(bones.map((b, i) => [b, i]));
  const parentOf = bones.map((b) => { let q2 = b.parent; while (q2 && !idx.has(q2)) q2 = q2.parent; return q2 ? idx.get(q2) : -1; });
  let rootI = parentOf.indexOf(-1);
  if (rootI < 0) rootI = 0;
  for (let i = 0; i < n; i++) {
    const b = bones[i];
    for (const c of b.children.slice()) if (!idx.has(c)) b.remove(c);   // keep the template a pure bone tree
    if (parentOf[i] < 0 && i !== rootI) parentOf[i] = rootI;            // stray roots ride under the real one
  }
  for (let i = 0; i < n; i++) {
    const b = bones[i], pi = parentOf[i];
    _m.copy(Wt[i]); if (pi >= 0) _m.premultiply(_m2.copy(Wt[pi]).invert());
    _m.decompose(b.position, b.quaternion, b.scale); b.scale.set(1, 1, 1);
    b.userData.index = i; b.userData.alias = [];
    if (pi >= 0 && b.parent !== bones[pi]) bones[pi].add(b);
    b.updateMatrix();
  }
  const boneInverses = Wt.map((w) => new THREE.Matrix4().copy(w).invert());

  // ---- per-bone axis map: world X/Y/Z expressed in each bone's PARENT frame. Rotating a bone by angle a
  // about boneAxes[i][k] is exactly "rotate this joint about world axis k", on any skeleton.
  const boneAxes = bones.map((b, i) => {
    const pi = parentOf[i];
    _q.identity(); if (pi >= 0) Wt[pi].decompose(_p, _q, _s);
    _q.invert();
    return AX.map((a) => a.clone().applyQuaternion(_q));
  });

  // ---- per-bone forward: unit vector in the bone's PARENT frame pointing down its own chain. This is what
  // an aim/flap has to rotate, since a Tripo joint's "forward" is its own chain direction, never +Z.
  const boneFwd = bones.map((b, i) => {
    const kid = b.children.find((c) => idx.has(c));
    const v = kid ? kid.position.clone() : new THREE.Vector3(0, 1, 0).applyQuaternion(b.quaternion);
    if (kid) v.applyQuaternion(b.quaternion);
    return v.lengthSq() > 1e-12 ? v.normalize() : new THREE.Vector3(0, 1, 0);
  });

  // ---- classify + rename ----------------------------------------------------------------------------
  const pick = (re) => bones.map((b, i) => [re.exec(b.name), i]).filter(([m2]) => m2).sort((a2, b2) => +a2[0][1] - +b2[0][1]).map(([, i]) => i);
  const spine = pick(/Spine_(\d+)$/), neck = pick(/Head_(\d+)$/), tail = pick(/Tail_(\d+)$/);

  // Tripo limb chains, keyed "<group><side>"
  const limb = new Map();
  bones.forEach((b, i) => {
    // NO `::` IN THE PATTERN. GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName,
    // which STRIPS `[ ] . : /` — so `tripo::0_Left_Limb_3` reaches us as `tripo0_Left_Limb_3`. Anchoring on
    // the colons matched nothing on any of the twelve rigs: no chain was ever classified, so `legs` and
    // `arms` came back empty and glbAnim posed a mannequin with frozen limbs. The Spine_/Head_/Tail_ picks
    // above never anchored on the prefix, which is exactly why those three worked and the limbs did not.
    const m3 = /(\d)_(Left|Right)_Limb_(\d+)$/.exec(b.name);
    if (m3) { const k = m3[1] + m3[2][0]; (limb.get(k) ?? limb.set(k, []).get(k)).push([+m3[3], i]); }
  });
  for (const arr of limb.values()) arr.sort((a2, b2) => a2[0] - b2[0]);
  const chainsRaw = [...limb.entries()].map(([k, arr]) => ({ key: k, group: +k[0], side: k[1], ids: arr.map(([, i]) => i) }));

  // legs = the chains whose TIP sits at the bottom of the skeleton. Frame-independent (bones vs bones only),
  // which is what makes it survive Tripo's mislabeled Left/Right groups.
  const ty = (i) => Wt[i].elements[13], tx = (i) => Wt[i].elements[12], tz = (i) => Wt[i].elements[14];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, ty(i)); hi = Math.max(hi, ty(i)); }
  // the floor is the bottom of the SKELETON, not the lowest chain tip: on a creature whose only chains are
  // wings (sprite) the lowest tip is the wing itself, and a relative test would call the wings legs.
  const thresh = lo + (hi - lo) * 0.15;
  for (const c of chainsRaw) {
    c.tip = c.ids[c.ids.length - 1];
    c.leg = cfg.walkGroup == null ? ty(c.tip) <= thresh && c.ids.length >= 2 : c.group === cfg.walkGroup;
  }
  const legs = chainsRaw.filter((c) => c.leg), arms = chainsRaw.filter((c) => !c.leg);
  // A rig with limb-shaped joints but no classified chain animates as a frozen mannequin and says nothing.
  // That shipped once (the name-sanitising bug above); one line makes the next occurrence self-reporting.
  if (!chainsRaw.length && bones.some((b) => /Limb_\d+$/.test(b.name))) console.warn('[glbBody] limb joints present but no chain classified —', bones.find((b) => /Limb_\d+$/.test(b.name)).name);

  // FL/FR/HL/HR from the ACTUAL bind position (left = +X, front = +Z after the yaw), not from Tripo's labels
  if (legs.length) {
    const midZ = legs.reduce((a2, c) => a2 + tz(c.ids[0]), 0) / legs.length;
    for (const c of legs) { c.left = tx(c.ids[0]) >= 0; c.front = legs.length > 2 ? tz(c.ids[0]) > midZ : true; }
  }
  // `lat` = how far outboard the chain TIP reaches. It is what tells a wing from a neck: on the wraith,
  // Tripo filed spine+arm+fingers as one 16-joint "limb", which beats every real limb on length but sits on
  // the midline, so ranking candidates by reach instead of length is what stops it being flapped as a wing.
  for (const c of chainsRaw) c.lat = Math.abs(tx(c.ids[c.ids.length - 1]));
  for (const c of arms) c.left = tx(c.ids[0]) >= 0;

  const alias = (i, ...a) => { if (i != null && i >= 0) bones[i].userData.alias.push(...a); };
  const rename = (i, nm) => { bones[i].name = nm; };

  rename(rootI, 'root');
  spine.forEach((i, k) => rename(i, 'spine' + k));
  // a rig with no Spine_ chain at all (the serpent is head + tail and nothing else) still has to answer
  // Enemy._fBody, or the hit-flinch/turn-bank layer silently does nothing for that whole species.
  if (spine.length) { alias(spine[0], 'body', 'torso', 'core'); alias(spine[spine.length - 1], 'chest'); }
  else alias(rootI, 'body', 'torso', 'core');
  neck.forEach((i, k) => rename(i, 'neck' + k));
  if (neck.length) {
    alias(neck[0], 'neck');
    const hi2 = cfg.headIndex == null || cfg.headIndex < 0 ? neck.length - 1 : Math.min(cfg.headIndex, neck.length - 1);
    alias(neck[hi2], 'head');
  }
  tail.forEach((i, k) => rename(i, 'tail' + k));
  for (const c of chainsRaw) {
    c.ids.forEach((i, k) => rename(i, `L${c.group}${c.side}_${k}`));
    const tag = c.leg ? (legs.length > 2 ? (c.front ? 'F' : 'H') : '') + (c.left ? 'L' : 'R') : (c.left ? 'L' : 'R');
    if (c.leg) {
      alias(c.ids[0], 'hip' + tag); alias(c.ids[1], 'knee' + tag); alias(c.ids[c.ids.length - 1], 'foot' + tag);
    } else {
      // both the long and the short procedural spellings, so anything that looked bones up by either keeps working
      alias(c.ids[0], 'shoulder' + tag, 'sh' + tag); alias(c.ids[1], 'elbow' + tag, 'el' + tag); alias(c.ids[c.ids.length - 1], 'hand' + tag, 'hd' + tag);
    }
  }
  if (!neck.length && cfg.headBone) { const i = bones.findIndex((b) => b.name === cfg.headBone); alias(i, 'head'); }

  // ---- leftover chains (Tripo's `bone_N` filler): wings, robes, horns, mandibles. They carry real weight,
  // so they get names and secondary motion instead of being frozen.
  const auxChains = [];
  for (let i = 0; i < n; i++) {
    if (!/^bone_/.test(bones[i].name)) continue;
    const pi = parentOf[i];
    if (pi >= 0 && /^bone_/.test(bones[pi].name)) continue;             // mid-chain, not a chain head
    const ids = []; let cur = i;
    for (;;) { ids.push(cur); const kid = bones[cur].children.find((c) => idx.has(c) && /^bone_/.test(c.name)); if (!kid) break; cur = idx.get(kid); }
    const c = auxChains.length;
    ids.forEach((j, k) => rename(j, `aux${c}_${k}`));
    auxChains.push({ ids, left: tx(ids[0]) >= 0, lat: Math.abs(tx(ids[ids.length - 1])) });
  }

  // ---- material textures. ORM is the standard glTF packing, so the SAME map is roughness and metalness.
  const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const tex = { map: src?.map ?? null, normalMap: src?.normalMap ?? null, roughnessMap: src?.roughnessMap ?? null, metalnessMap: src?.metalnessMap ?? src?.roughnessMap ?? null };

  const asset = {
    geometry: geo,
    bonesTemplate: bones[rootI],
    boneInverses,
    boneNames: bones.map((b) => b.name),
    bindPos: bones.map((b) => b.position.clone()),
    bindQuat: bones.map((b) => b.quaternion.clone()),
    glb: true, tex,
    // extras for glbAnim.js only — additive, nothing else needs to know they exist
    boneAxes, boneFwd,
    chains: { spine, neck, tail, legs, arms, root: rootI },
    auxChains,
  };
  scene.userData.__glbAsset = asset;
  return asset;
}
