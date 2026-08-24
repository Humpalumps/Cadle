// Frostveil Tundra (tundra) — levels 11-17. Roster: frostwolf, icegiant, wisp.
// XP subtotal: 18,325 (60% of the 30,542 the band costs).  6 quests: 4 chain + 2 side.
export default [
  {
    id: 'frost-01', region: 'tundra', level: 11, next: 'frost-02',
    name: 'What the Ice Kept',
    giver: 'stele:tundra',
    text: {
      offer: 'The glacier gave up more than water when it cracked. There are shelves out there with a season laid down in every hand-width, and something froze in one of them that the wolves can smell and I cannot. Kill enough of them to walk the shelf, and bring back the shards they carry — the cold in those is older than the ice.',
      progress: 'Frostveil Wolves guard the shelves. They always have.',
      done: 'Cold iron, and older than the Vale. Keep it. I have written down what it means and I do not like the sentence.',
    },
    objectives: [
      { type: 'kill', enemy: 'frostwolf', name: 'Frostveil Wolves', count: 8, where: 'tundra' },
      { type: 'collect', item: 'frost-shard', name: 'Frost Shards', count: 5, from: ['frostwolf'], chance: 0.45 },
    ],
    reward: { xp: 2400, glimmer: 260, tier: 'rare', kind: 'weapon',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'sniper', element: 'arc' },
        { tier: 'rare', kind: 'weapon', archetype: 'fusion', element: 'arc' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'emberward' },
      ] },
  },
  {
    id: 'frost-02', region: 'tundra', level: 13, next: 'frost-03',
    name: 'The Throne Is Cold',
    giver: 'stele:tundra',
    text: {
      offer: 'Whatever sat on the Glacier Throne left it a long time before the ice came, and the giants have been arguing over the empty seat ever since. Go up. Look at it — properly, close enough to see the arms — and put down the three that will not let you.',
      progress: 'Up the shelves to the Throne. The giants will make the last hundred metres expensive.',
      done: 'It was never a chair. It is a doorway lying on its back, and it is still faintly warm.',
    },
    objectives: [
      { type: 'reach', poi: 'The Glacier Throne', r: 60, text: 'Climb to the Glacier Throne' },
      { type: 'kill', enemy: 'icegiant', name: 'Frostveil Giants', count: 3, where: 'tundra' },
    ],
    reward: { xp: 2700, glimmer: 300, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'shotgun', element: 'arc' },
        { tier: 'rare', kind: 'armour', slot: 'arms', set: 'glasswright' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'emberward' },
      ] },
  },
  {
    id: 'frost-03', region: 'tundra', level: 15, next: 'frost-04',
    name: 'The Long Hunger',
    giver: 'stele:tundra',
    text: {
      offer: 'The packs have stopped hunting each other, which sounds like peace and is not. Something has told them there is easier meat coming up the pass, and the something is right — it is you, and everyone who follows you. Break the packs while they are still packs.',
      progress: 'Wolves across the shelves. They hunt in twelves now, not fours.',
      done: 'Broken back into fours. That is as close to peace as this place trades in.',
    },
    objectives: [{ type: 'kill', enemy: 'frostwolf', name: 'Frostveil Wolves', count: 12, where: 'tundra' }],
    reward: { xp: 3000, glimmer: 330, tier: 'rare', kind: 'armour',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'pulse', element: 'arc' },
        { tier: 'rare', kind: 'weapon', archetype: 'scout', element: 'arc' },
        { tier: 'rare', kind: 'armour', slot: 'cloak', set: 'glasswright' },
      ] },
  },
  {
    id: 'frost-04', region: 'tundra', level: 17, next: 'fen-01',
    name: 'The Giant That Would Not Melt',
    giver: 'stele:tundra',
    text: {
      offer: 'One of them is not made of this glacier. It came down with the old ice, it does not thaw in the sun, and the aurora bends around it like the sky is embarrassed. Kill it and I can close the Throne. Then go south-west, into the fen — the Hagstone has been calling and I have run out of reasons to pretend otherwise.',
      progress: 'The giant that casts no shadow. Then south-west, to the Hagstone.',
      done: 'It did not melt. It simply stopped being upright. Take the road to Shadowfen and try not to drink anything.',
    },
    objectives: [
      { type: 'slay', enemy: 'icegiant', name: 'the giant that would not melt', tag: 'frost-elder', where: 'tundra' },
      { type: 'reach', poi: 'The Hagstone', r: 90, text: 'Travel south-west to the Hagstone' },
    ],
    reward: { xp: 4600, glimmer: 480, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'beam', element: 'arc' },
        { tier: 'legendary', kind: 'weapon', archetype: 'autorifle', element: 'arc' },
        { tier: 'legendary', kind: 'armour', slot: 'head', set: 'emberward' },
      ] },
  },

  // ---- side ----
  {
    id: 'frost-s1', region: 'tundra', level: 12,
    name: 'Lights Under the Aurora',
    giver: 'stele:tundra',
    text: {
      offer: 'Wisps came north with the aether and they have not adapted; they burn twice as hard here just to stay lit, and everything they pass over thaws and refreezes wrong. The shelves are turning to rotten ice under them. Put them out before the ground under the camp does something regrettable.',
      progress: 'Wisps over the shelves. They glow brightest where the ice is thinnest.',
      done: 'The shelves will hold another winter. Say what you like about wisps — they are honest about where the danger is.',
    },
    objectives: [{ type: 'kill', enemy: 'wisp', name: 'Aether Wisps', count: 10, where: 'tundra' }],
    reward: { xp: 2800, glimmer: 290, tier: 'uncommon', kind: 'armour',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'handcannon', element: 'arc' },
        { tier: 'uncommon', kind: 'armour', slot: 'chest', set: 'glasswright' },
      ] },
  },
  {
    id: 'frost-s2', region: 'tundra', level: 16,
    name: 'Ninefold Cold',
    giver: 'stele:tundra',
    text: {
      offer: 'A giant carries its cold in a core behind the breastbone, and no two are the same temperature. I want nine of them — enough to plot the curve. If the curve bends the way I think it does, the cold in this region is not weather. It is being made, and something is making it on purpose.',
      progress: 'Rime cores, from the giants and the biggest of the wolves.',
      done: 'The curve bends. Nine points, one line, and it points down into the ground. Somebody is running this glacier.',
    },
    objectives: [{ type: 'collect', item: 'rime-core', name: 'Rime Cores', count: 9, from: ['icegiant', 'frostwolf'], chance: 0.4 }],
    reward: { xp: 2825, glimmer: 300, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'sniper', element: 'arc' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'emberward' },
      ] },
  },
];
