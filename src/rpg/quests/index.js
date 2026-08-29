/**
 * Quest content index. Ten region files, one array each, assembled here. Plain objects only — no
 * assets, no imports of game systems, nothing that costs boot time. `quest.js` is the only reader.
 *
 * AUTHORING CONTRACT
 *   id        unique string, '<region-slug>-NN' / '-sNN' for side quests
 *   region    a Biomes.js region id: meadow forest tundra shadowfen infernal sunken dragon celestial void lost
 *   level     the level the quest is written for (inside that region's band in Biomes.js)
 *   name      the title on the tracker
 *   giver     'stele:<region>' — abstract; with no stele in the world the region auto-offers on entry.
 *             OR 'npc:<id>' — a named villager. npc quests are offered/turned in only at that giver
 *             (quest.readGiver); they also carry giverName (the prompt line) and giverPos [x,z] (the
 *             authored anchor QuestMarkers falls back to until the NPC body exists in Props).
 *   next      the id that is auto-accepted on turn-in. Each region's chain finale points at the NEXT
 *             region's chain head; that is the whole of "the route goes through the areas in order".
 *   text      { offer, progress, done } — written, never spoken.
 *   objectives[]
 *      kill    { enemy, name?, count, where? }         enemy id must exist in enemies/defs.js AND be in
 *      slay    { enemy, name?, tag?, where? }          that region's roster in Biomes.js
 *      collect { item, name, count, from[], chance }   from[] are enemy ids that drop it
 *      reach   { poi, r? }                             poi: a POIS key, a Biomes landmark name, or a region id
 *      escort  { from, to, r? }                        same anchor vocabulary
 *   reward    { xp, glimmer, tier?, kind? }
 *
 * XP: the 1->50 curve is 706,299 XP. Quests carry 60% of it (423,778 across 55 quests), split per band
 * at 60% of that band's own cost. Each file states its subtotal in a header comment.
 */
import meadow from './meadow.js';
import forest from './forest.js';
import tundra from './tundra.js';
import shadowfen from './shadowfen.js';
import infernal from './infernal.js';
import sunken from './sunken.js';
import dragon from './dragon.js';
import celestial from './celestial.js';
import theVoid from './void.js';
import lost from './lost.js';

/** named points inside the home bowl — the outer nine resolve through Biomes' LANDMARKS/centres */
export const POIS = {
  'Waystone Plaza': { x: 0, z: -28 },
  'Mirrormere': { x: -170, z: -70 },
  'The Sundered Spire': { x: 140, z: 60 },
  'Whisperwood': { x: 0, z: -220 },
  'The Crystal Fields': { x: 250, z: 30 },
  'The Hollow Crown': { x: -60, z: 260 },
  // Gloamtide Corsair camps (fixed anchors; Props._buildPirateCamps pitches each camp within ~22 m of
  // its anchor, so `reach` radii on these stay >= 25)
  'Driftfire Hollow': { x: -10, z: -396 },
  'The Cinder Tithe': { x: 142, z: 375 },
  'The Salt-Grin Camp': { x: -396, z: -62 },
};

export const QUESTS = [...meadow, ...forest, ...tundra, ...shadowfen, ...infernal, ...sunken, ...dragon, ...celestial, ...theVoid, ...lost];

export const BY_ID = {};
for (const q of QUESTS) BY_ID[q.id] = q;
// `req` is derived, not authored: whatever a quest is the `next` of has to be finished first.
for (const q of QUESTS) if (q.next && BY_ID[q.next]) BY_ID[q.next].req = q.id;
