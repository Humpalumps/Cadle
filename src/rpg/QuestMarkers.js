/**
 * QuestMarkers — the MMO ! / ? floating over quest givers, as WORLD OBJECTS (the HUD glyph Props
 * raises is screen-space; this is the in-world read that occludes behind terrain and trees).
 *
 *   gold !  — this giver has a quest for you            (state 'offer')
 *   gold ?  — a quest of theirs is finished: turn in    (state 'ready')
 *   grey ?  — you carry their quest, not done yet       (state 'progress')
 *
 * State comes from ONE call, quests.giverStates() (quest.js owns the priority). Positions:
 *   - stele givers: props._steleList (the Wayfinder's feet), read defensively.
 *   - npc givers ('npc:<id>'): the villager body when Props publishes one (npcAt(id), or a
 *     villagers/npcs list with {id|name, position|pos}) — re-resolved every poll, so NPCs that appear
 *     AFTER init get their marker on the next poll — else the quest's authored giverPos [x,z].
 *
 * BLOB DECREE compliance: MeshBasicMaterial, colour <= 1.0/channel (gold 1.0/0.78/0.30 — a hue, not
 * a white ball), tone-mapped, fogged, depthTest ON, no emissive stacking, nothing near the bloom
 * threshold. The read comes from shape + the dark outline baked into the glyph texture, not from glow.
 *
 * PERF: state + sites rebuilt at 2 Hz; per frame only billboard + bob for meshes inside 120 m
 * (a handful — givers are ~100s of metres apart). Zero per-frame allocation.
 *
 * Also the villager INTERACTION (until an NPC-dialogue system exists): inside 3.2 m of an npc giver,
 * "[E] Speak to <name>" -> quests.readGiver('npc:<id>') — same one-exchange-per-press as the stele.
 *
 * API: update(dt, t); pips() -> cached [{x, z, state}] for the HUD minimap (rebuilt at poll rate).
 */
import * as THREE from 'three';
import { QUESTS } from './quests/index.js';
import { isVendor } from './shop.js';

const RANGE2 = 120 * 120;       // marker draw distance (readable well past 40 m; fog owns the far fade)
const TALK2 = 3.2 * 3.2;        // [E] radius at a villager — matches the stele's own 4 m feel
const GOLD = 0xffc84d;
const _box = new THREE.Box3();   // scratch for the head-anchor bbox (2 Hz rebuild only)          // <= 1.0/channel: tone-maps to gold, never white (blob decree)
const GREY = 0x9aa0a8;
const SKULL = 0.26;             // head BONE (skull base, where every humanoid rig puts it) -> crown of the head
const GLYPH_H = 1.44;           // must match the PlaneGeometry below
const GAP = 0.16;               // clear air between the crown and the bottom edge of the glyph

/** highest bone whose name says head; a neck joint is the fallback for rigs with no head joint. */
function findHeadBone(obj) {
  let head = null, neck = null, hy = -Infinity, ny = -Infinity;
  obj.traverse((c) => {
    if (!c.isBone) return;
    c.updateWorldMatrix(true, false);
    const y = c.matrixWorld.elements[13];
    if (/head/i.test(c.name)) { if (y > hy) { hy = y; head = c; } }
    else if (/neck/i.test(c.name)) { if (y > ny) { ny = y; neck = c; } }
  });
  return head ?? neck ?? null;
}

function glyphTexture(ch) {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 256;
  const c = cv.getContext('2d');
  c.font = '900 190px Georgia, "Times New Roman", serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineJoin = 'round';
  // dark outline first, white core after: the material COLOUR supplies the hue, the outline supplies
  // the 40 m contrast against sky and grass alike (a naked gold glyph vanishes against golden hour).
  c.lineWidth = 30; c.strokeStyle = 'rgba(24,14,4,0.95)'; c.strokeText(ch, 64, 134);
  c.fillStyle = '#ffffff'; c.fillText(ch, 64, 134);
  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class QuestMarkers {
  constructor(game, quests) {
    this.game = game; this.quests = quests;
    this._pool = []; this._live = 0; this._poll = 0; this._pips = [];
    this._promptOwned = false; this._talkTarget = null;
    // the npc giver roster comes straight from the quest DATA — one entry per unique 'npc:' giver
    this._npcs = new Map();
    for (const q of QUESTS) {
      const g = q.giver;
      if (typeof g === 'string' && g.startsWith('npc:') && !this._npcs.has(g)) {
        this._npcs.set(g, { id: g.slice(4), name: q.giverName ?? 'the villager', fx: q.giverPos?.[0] ?? 0, fz: q.giverPos?.[1] ?? 0 });
      }
    }
  }

  _ensure() {
    if (this._geo) return true;
    const scene = this.game.scene; if (!scene) return false;
    this._geo = new THREE.PlaneGeometry(0.72, 1.44);
    const mat = (map, color) => new THREE.MeshBasicMaterial({
      map, color, transparent: true, depthWrite: false, depthTest: true,   // depthTest ON: it is a world object and hides behind the world
      side: THREE.DoubleSide,
    });
    const bang = glyphTexture('!'), quest = glyphTexture('?');
    this._mats = { offer: mat(bang, GOLD), ready: mat(quest, GOLD), progress: mat(quest, GREY) };
    this._group = new THREE.Group(); this._group.name = 'quest-markers';
    scene.add(this._group);
    return true;
  }

  /** villager marker anchor. USER REPORT, twice: "the exclamation mark isn't directly above their
   *  head — it's slightly off."
   *  Round 1 closed two causes: (1) npcAt() returns the npc RECORD {id,name,position,object} and the
   *  old code read `.x` off the record, silently falling back to the quest's AUTHORED [x,z]; (2) the
   *  spawn-root position is not the visual centre of a posed body. It anchored on the model's world
   *  bounding box top instead.
   *  ROUND 2 (this): THE BOUNDING BOX IS NOT THE HEAD. Measured live on all seven villagers, the box
   *  top overshoots the head bone by 1.07-1.31 m (serel 1.09, cole 1.31) — Box3.setFromObject reads
   *  the geometry's BIND-pose box, and these Tripo rigs bind with the arms up, so the box top is a
   *  raised wrist, not a skull. The glyph therefore floated ~0.8 m clear of the crown: "not directly
   *  above their head" exactly. Anchor on the HEAD BONE (cached per giver, the rigs name it Head_*),
   *  and only trust the box top when it is within a skull's height of that bone. */
  _npcPos(rec) {
    const props = this.game.world?.props ?? this.game.props;
    // RESOLVE THE BODY FROM THE ROSTER, NOT FROM npcAt(). `props.npcAt(id)` returns a **Vector3** (the
    // villager's spawn position) — see its doc-comment in Props.js — not the {id,name,position,object}
    // record this file's previous author assumed. So `ent.object` was always undefined, the head-anchor
    // branch below never executed once, and every marker silently took the old fixed `root + 2.4 m`
    // path: measured live as `crown:false, boneName:null` on all three givers, with the glyph ~0.9 m
    // over the skull. That is the user's "it isn't directly above their head", reported twice, with a
    // fix in between that could not have worked. Take the object from the roster; keep npcAt as the
    // POSITION fallback it actually is.
    const ent = props?.npcs?.find?.((n) => n && (n.id === rec.id || n.id === 'npc-' + rec.id || n.name === rec.id));
    const obj = ent?.object ?? (ent?.isObject3D ? ent : null);
    if (obj?.isObject3D) {
      _box.setFromObject(obj);
      if (Number.isFinite(_box.max.y) && _box.max.y > _box.min.y) {
        // crown = head bone + a skull's worth, and NOTHING ELSE when we have the bone. Do not clamp it
        // against the box top: measured live, `Box3.setFromObject` returns the POSED box for a skinned
        // mesh, so the same villager reports a box 1.09 m over the head bone in the first frames (bind
        // pose, arms up) and 0.01 m UNDER it once the idle settles with the arms down. Taking the min of
        // the two put the glyph a metre in the air at spawn and buried it in the hair a second later —
        // one anchor drifting between two wrong answers. The bone is the only stable landmark; the box
        // stays as the fallback for a body that has no head joint at all.
        if (rec.headBone === undefined || rec.headBone?.parent === null || rec.headOwner !== obj) {
          rec.headBone = findHeadBone(obj); rec.headOwner = obj;   // re-resolve if Props rebuilt the body
        }
        const hb = rec.headBone;
        if (hb) hb.updateWorldMatrix(true, false);
        const y = hb ? hb.matrixWorld.elements[13] + SKULL : _box.max.y;
        // `bone` rides along so update() can re-read the head EVERY FRAME. A 2 Hz snapshot is not good
        // enough for a living body: the idle clip and the breath move the head, and the villager turns to
        // face you when you walk up, so a marker pinned to a half-second-old head Y drifts visibly at
        // conversation range — measured as a 0.6 m spread across three villagers standing still.
        return { x: (_box.min.x + _box.max.x) / 2, y, z: (_box.min.z + _box.max.z) / 2, top: true, bone: hb };
      }
    }
    const pos = ent?.position ?? props?.npcAt?.(rec.id) ?? (ent?.x != null ? ent : null);
    if (pos?.x != null) return { x: pos.x, y: pos.y ?? this._groundY(pos.x, pos.z), z: pos.z };
    return { x: rec.fx, y: this._groundY(rec.fx, rec.fz), z: rec.fz };
  }
  _groundY(x, z) { return this.game.terrain?.heightAt?.(x, z) ?? 0; }

  /** 2 Hz: read giver states once, lay one pooled mesh per marked site. Allocation happens here only. */
  _rebuild() {
    const props = this.game.world?.props ?? this.game.props;
    const states = this.quests.giverStates?.() ?? {};
    const sites = [];
    for (const st of props?._steleList ?? []) {
      const s = states['stele:' + st.region];
      if (s) sites.push({ x: st.pos.x, y: st.pos.y + 2.7, z: st.pos.z, state: s });   // above the Wayfinder's head
    }
    let talk = null; const p = this.game.player?.position;
    for (const [key, rec] of this._npcs) {
      const s = states[key];
      const vendor = isVendor(rec.id);   // shopkeepers (src/rpg/shop.js) are speakable with no quest pending
      if (!s && !vendor) continue;
      const at = this._npcPos(rec);
      // keep the LIVE position ref: walkers move between the 0.5 s polls, and a marker placed from a
      // snapshot visibly lags behind them (user report). update() tracks refs per frame.
      if (s) sites.push({ x: at.x, y: at.top ? at.y : at.y + 2.4, z: at.z, state: s, ref: at, crown: !!at.top });
      if (p) {
        const dx = p.x - at.x, dz = p.z - at.z;
        // quests-first rule: a pending exchange (turn-in or a fresh offer) takes the press; a vendor
        // with nothing to say (or only an in-progress quest) trades instead.
        if (dx * dx + dz * dz < TALK2) talk = { key, id: rec.id, name: rec.name, quest: s === 'ready' || s === 'offer', vendor };
      }
    }
    this._talkTarget = talk;
    for (let i = 0; i < sites.length; i++) {
      let m = this._pool[i];
      if (!m) { m = new THREE.Mesh(this._geo, this._mats.offer); m.userData.seed = i * 2.4; this._group.add(m); this._pool[i] = m; }
      const s = sites[i];
      m.material = this._mats[s.state];
      m.position.set(s.x, s.y, s.z); m.userData.baseY = s.y; m.userData.ref = s.ref ?? null; m.userData.crown = !!s.crown;
      m.visible = true;
    }
    for (let i = sites.length; i < this._pool.length; i++) this._pool[i].visible = false;
    this._live = sites.length;
    this._pips = sites.map((s) => ({ x: s.x, z: s.z, state: s.state }));   // minimap cache — HUD reads, never rebuilds
  }

  /** cached minimap pips: [{x, z, state: 'offer'|'ready'|'progress'}] */
  pips() { return this._pips; }

  update(dt, t) {
    const g = this.game; if (!this._ensure()) return;
    if (t >= this._poll) { this._poll = t + 0.5; this._rebuild(); }
    const p = g.player?.position, cam = g.camera; if (!p || !cam) return;
    for (let i = 0; i < this._live; i++) {
      const m = this._pool[i];
      const ref = m.userData.ref;
      if (ref) {
        const b = ref.bone;
        if (b) {   // live head track: the bone's world matrix is this frame's, so the glyph cannot drift off the skull
          const e = b.matrixWorld.elements;
          m.position.x = e[12]; m.position.z = e[14]; m.userData.baseY = e[13] + SKULL;
        } else { m.position.x = ref.x; m.position.z = ref.z; m.userData.baseY = ref.top ? ref.y : ref.y + 2.4; }
      }
      const dx = m.position.x - p.x, dz = m.position.z - p.z;
      const near = dx * dx + dz * dz < RANGE2;
      m.visible = near;
      if (!near) continue;
      m.quaternion.copy(cam.quaternion);                                              // billboard
      // shrink inside talk range so the glyph never fills the screen in a conversation (full size by 6 m)
      const sc = Math.min(1, 0.3 + Math.sqrt(dx * dx + dz * dz) / 8);
      m.scale.setScalar(sc);
      // A HEAD ANCHOR HAS TO BE SCALE-AWARE. baseY is the CROWN, and the glyph is centre-pivoted, so
      // parking its centre at a fixed height leaves a gap that grows as the glyph shrinks — which is
      // the close-range half of "it's not directly above their head". Sit the glyph's BOTTOM EDGE a
      // constant GAP over the crown at every distance instead. Steles keep their authored height.
      const lift = m.userData.crown ? GAP + GLYPH_H * 0.5 * sc : 0;
      m.position.y = m.userData.baseY + lift + Math.sin(t * 2.1 + m.userData.seed) * 0.12;   // the gentle bob
    }
    // villager talk prompt — same ownership rule as Props' stele prompt: whoever raises it lowers it.
    // Vendors (shop.js): quests-first-then-shop — a pending turn-in/offer takes the E press through
    // readGiver (which now raises the offer card); with nothing quest-shaped to do, E opens the shop.
    if (this._talkTarget) {
      const tt = this._talkTarget;
      this._promptOwned = true;
      g.hud?.prompt?.((tt.vendor && !tt.quest ? 'Trade with ' : 'Speak to ') + tt.name);
      if (g.input?.justPressed?.('KeyE')) {
        if (tt.quest || !tt.vendor) this.quests.readGiver?.(tt.key);            // key IS 'npc:<id>'
        else g.rpg?.screens?.showShop?.(tt.id);
      }
    } else if (this._promptOwned) { this._promptOwned = false; g.hud?.prompt?.(null); }
  }
}
