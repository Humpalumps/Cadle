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

  /** villager marker anchor. USER REPORT: "the exclamation mark isn't directly above their head —
   *  it's slightly off." Two causes closed here: (1) npcAt() returns the npc RECORD {id,name,
   *  position,object}, and the old code read `.x` off the record, silently falling back to the
   *  quest's AUTHORED [x,z] — a marker floating at the placement coordinate while the body idles a
   *  step away; (2) the spawn-root position is not the visual centre of a posed body. The anchor is
   *  now the model's world bounding box: centre x/z, top y + margin — directly over the head. */
  _npcPos(rec) {
    const props = this.game.world?.props ?? this.game.props;
    const ent = props?.npcAt?.(rec.id)
      ?? props?.npcs?.find?.((n) => n && (n.id === rec.id || n.id === 'npc-' + rec.id || n.name === rec.id));
    const obj = ent?.object;
    if (obj?.isObject3D) {
      _box.setFromObject(obj);
      if (Number.isFinite(_box.max.y) && _box.max.y > _box.min.y) {
        return { x: (_box.min.x + _box.max.x) / 2, y: _box.max.y + 0.45, z: (_box.min.z + _box.max.z) / 2, top: true };
      }
    }
    const pos = ent?.position ?? (ent?.x != null ? ent : null);
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
      if (s) sites.push({ x: at.x, y: at.top ? at.y : at.y + 2.4, z: at.z, state: s, ref: at });
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
      m.position.set(s.x, s.y, s.z); m.userData.baseY = s.y; m.userData.ref = s.ref ?? null;
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
      if (ref) { m.position.x = ref.x; m.position.z = ref.z; m.userData.baseY = ref.top ? ref.y : ref.y + 2.4; }   // glued to the resolved head anchor
      const dx = m.position.x - p.x, dz = m.position.z - p.z;
      const near = dx * dx + dz * dz < RANGE2;
      m.visible = near;
      if (!near) continue;
      m.position.y = m.userData.baseY + Math.sin(t * 2.1 + m.userData.seed) * 0.12;   // the gentle bob
      m.quaternion.copy(cam.quaternion);                                              // billboard
      // shrink inside talk range so the glyph never fills the screen in a conversation (full size by 6 m)
      m.scale.setScalar(Math.min(1, 0.3 + Math.sqrt(dx * dx + dz * dz) / 8));
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
