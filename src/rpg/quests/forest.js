// Whisperwood Deep (forest) — levels 5-11. Roster: sprite, treant, hound.
// XP subtotal: 7,768 (60% of the 12,947 the band costs).  6 quests: 4 chain + 2 side.
export default [
  {
    id: 'wood-01', region: 'forest', level: 5, next: 'wood-02',
    name: 'The Canopy Closed',
    giver: 'stele:forest',
    text: {
      offer: 'There was a road through here once. You can still walk it for about forty paces before the wood decides otherwise. The sprites did the closing — they are only lights, but they are lights with an opinion, and lately the opinion is that nobody leaves. Make them reconsider.',
      progress: 'Wood Sprites, between the trunks. They scatter, then they come back braver.',
      done: 'The road is forty paces longer than it was. Do not mistake that for a welcome.',
    },
    objectives: [{ type: 'kill', enemy: 'sprite', name: 'Wood Sprites', count: 8, where: 'forest' }],
    reward: { xp: 900, glimmer: 90, tier: 'uncommon', kind: 'weapon',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'handcannon', element: 'verdant' },
        { tier: 'uncommon', kind: 'weapon', archetype: 'sniper', element: 'verdant' },
        { tier: 'uncommon', kind: 'armour', slot: 'chest', set: 'pilgrim' },
      ] },
  },
  {
    id: 'wood-02', region: 'forest', level: 7, next: 'wood-03',
    name: 'Bark and Bone',
    giver: 'stele:forest',
    text: {
      offer: 'A treant is a grave with a grain to it — every one of them grew up out of something that stopped walking. Split a few and bring me the splinters from the core. I can read the year in them, and I want to know whether the wood started taking the dead before the Spire broke or after.',
      progress: 'Heartwood, from the core of a treant. Nowhere else in the splinter.',
      done: 'After. Always after. The Vale bleeds and everything downhill of it drinks.',
    },
    objectives: [{ type: 'collect', item: 'heartwood-splinter', name: 'Heartwood Splinters', count: 6, from: ['treant'], chance: 0.55 }],
    reward: { xp: 1100, glimmer: 120, tier: 'uncommon', kind: 'armour',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'shotgun', element: 'verdant' },
        { tier: 'uncommon', kind: 'armour', slot: 'arms', set: 'chorus' },
        { tier: 'uncommon', kind: 'armour', slot: 'legs', set: 'pilgrim' },
      ] },
  },
  {
    id: 'wood-03', region: 'forest', level: 9, next: 'wood-04',
    name: 'The Hounds That Came With You',
    giver: 'stele:forest',
    text: {
      offer: 'The hounds are not from here. They followed the aether up out of the Vale and now they den under the roots, and the wood is furious about it in the slow way wood is furious. One of the elders has stopped sleeping over it. Kill the pack, and put the elder down before it decides the whole forest is complicit.',
      progress: 'The pack under the roots, then the elder that stopped sleeping.',
      done: 'Both quiet. The forest will not thank you; it will simply stop watching you.',
    },
    objectives: [
      { type: 'kill', enemy: 'hound', name: 'Aether Hounds', count: 10, where: 'forest' },
      { type: 'slay', enemy: 'treant', name: 'the sleepless elder', tag: 'wood-elder', where: 'forest' },
    ],
    reward: { xp: 1300, glimmer: 160, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'fusion', element: 'verdant' },
        { tier: 'rare', kind: 'weapon', archetype: 'scout', element: 'verdant' },
        { tier: 'rare', kind: 'armour', slot: 'cloak', set: 'chorus' },
      ] },
  },
  {
    id: 'wood-04', region: 'forest', level: 11, next: 'frost-01',
    name: 'The Road North',
    giver: 'stele:forest',
    text: {
      offer: 'The Elderheart has given its answer and it is a direction. North, past the last of the trunks, the ground goes white and stops arguing — Frostveil, and the Glacier Throne standing in the middle of it. Take the stolen warmth off the sprites before you go; you will want something of this forest with you up there, and the cold takes everything else.',
      progress: 'Motes off the sprites, then north out of the canopy to the Glacier Throne.',
      done: 'Behind you the canopy closed again. Ahead of you nothing has been warm in four hundred years. The Throne is expecting a visitor and it has been expecting one for a while.',
    },
    objectives: [
      { type: 'collect', item: 'witchlight-mote', name: 'Stolen Motes', count: 5, from: ['sprite'], chance: 0.5 },
      { type: 'reach', poi: 'The Glacier Throne', r: 90, text: 'Travel north to the Glacier Throne' },
    ],
    reward: { xp: 2100, glimmer: 240, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'pulse', element: 'verdant' },
        { tier: 'legendary', kind: 'weapon', archetype: 'beam', element: 'verdant' },
        { tier: 'legendary', kind: 'armour', slot: 'head', set: 'pilgrim' },
      ] },
  },

  // ---- side ----
  {
    id: 'wood-s1', region: 'forest', level: 8,
    name: 'A Light to Carry North',
    giver: 'stele:forest',
    text: {
      offer: 'The Elderheart has cut off a piece of itself — a wisp, no bigger than a lantern — and it wants that piece taken north to the Glacier Throne. It cannot make the pass alone; the cold eats small lights first and there is a great deal of pass. Walk with it, and keep whatever comes down out of the ice off it. If it goes out, it does not come back.',
      progress: 'The light is following you north. Keep it alive; it cannot defend itself and it will not run.',
      done: 'It went out the moment it touched the Throne — not dead. Delivered. The ice is holding a piece of the forest now, and Frostveil has noticed.',
    },
    objectives: [{ type: 'escort', from: 'The Elderheart', to: 'The Glacier Throne', r: 80, text: 'See the Elderheart light safely to the Glacier Throne' }],
    reward: { xp: 1150, glimmer: 130, tier: 'rare', kind: 'weapon',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'autorifle', element: 'verdant' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'chorus' },
      ] },
  },
  {
    id: 'wood-s2', region: 'forest', level: 10,
    name: 'The Grievance of Old Wood',
    giver: 'stele:forest',
    text: {
      offer: 'One treant has walked out of the deep grove and will not go back. It stands where the druid stones are and it strikes anything that comes near them, sprites included. I have no idea whether it is guarding the stones or trying to get in. Settle it either way, and thin the lights that have gathered to watch.',
      progress: 'The treant at the druid stones, and the crowd it drew.',
      done: 'Guarding, I think. It fell facing the stones. That is worth remembering.',
    },
    objectives: [
      { type: 'slay', enemy: 'treant', name: 'the treant at the druid stones', tag: 'wood-stones', where: 'forest' },
      { type: 'kill', enemy: 'sprite', name: 'the gathered lights', count: 6, where: 'forest' },
    ],
    reward: { xp: 1218, glimmer: 140, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'handcannon', element: 'verdant' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'chorus' },
      ] },
  },
];
