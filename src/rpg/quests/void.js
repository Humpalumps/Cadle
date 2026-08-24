// The Void (void) — levels 34-44. Roster: riftling, voidhorror, wraith.
// XP subtotal: 95,219 (60% of the 158,699 the band costs).  5 quests: 3 chain + 2 side.
// The chain is one story: the Void is not empty. It is a room with the furniture taken out, and it is filling back up.
export default [
  {
    id: 'void-01', region: 'void', level: 34, next: 'void-02',
    name: 'Count the Shelves',
    giver: 'stele:void',
    text: {
      offer: 'Reality gave up here, and the manner of the giving up is the whole story: it did not shatter, it was DISASSEMBLED, shelf by shelf, and the shelves are still hanging in the order they were taken down in. The riftlings nest along the cut edges. Clear enough of them that I can walk the sequence, and we will learn which end whoever did this started from.',
      progress: 'Riftlings, along the cut edges of the shelves. Mind the gravity; it will not mind you.',
      done: 'They started at the middle and worked outward, which means the middle is where they are standing.',
    },
    objectives: [{ type: 'kill', enemy: 'riftling', name: 'Riftlings', count: 16, where: 'void' }],
    reward: { xp: 18000, glimmer: 1900, tier: 'rare', kind: 'weapon',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'handcannon', element: 'void' },
        { tier: 'rare', kind: 'weapon', archetype: 'pulse', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'chorus' },
      ] },
  },
  {
    id: 'void-02', region: 'void', level: 39, next: 'void-03',
    name: 'The Furniture of a Missing Room',
    giver: 'stele:void',
    text: {
      offer: 'A void horror is not a creature. Cut one open and it is an inventory — a doorframe, a stair rail, half a window, all folded into a shape that can chase you. These are the pieces of whatever was taken apart, walking around inside the things that took it. Bring me enough of the folded pieces to lay one room back out flat.',
      progress: 'Void Horrors, over the abyss. The pieces come out of them intact; nothing in the Void has learned to break yet.',
      done: 'A room. A nursery, by the height of the rail. Somebody unmade a house and left the family in the walls of what unmade it.',
    },
    objectives: [
      { type: 'kill', enemy: 'voidhorror', name: 'Void Horrors', count: 9, where: 'void' },
      { type: 'collect', item: 'folded-thing', name: 'Folded Things', count: 8, from: ['voidhorror', 'wraith'], chance: 0.42 },
    ],
    reward: { xp: 20000, glimmer: 2200, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'shotgun', element: 'void' },
        { tier: 'rare', kind: 'weapon', archetype: 'sniper', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'glasswright' },
      ] },
  },
  {
    id: 'void-03', region: 'void', level: 44, next: 'lost-01',
    name: 'The Unmaking Is a Verb',
    giver: 'stele:void',
    text: {
      offer: 'At the middle of the shelves there is one horror that is larger than the others because it is further along — it has been folded more times, out of more rooms, and it is still going. It is not the one doing this. It is the TOOL. End it, and then go south: whoever picked the tool up is at the Convergence, and it is the last place left to look.',
      progress: 'The middle of the shelves, where the disassembly started. Then south, to the Convergence.',
      done: 'It came apart into rooms — dozens of them, all at once, all somebody\'s. The Lost Realm is the last door. Walk through it.',
    },
    objectives: [
      { type: 'slay', enemy: 'voidhorror', name: 'the Unmaking', tag: 'void-tool', where: 'void' },
      { type: 'reach', poi: 'The Convergence', r: 90, text: 'Travel south to the Convergence' },
    ],
    reward: { xp: 27000, glimmer: 3000, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'fusion', element: 'void' },
        { tier: 'legendary', kind: 'weapon', archetype: 'scout', element: 'void' },
        { tier: 'legendary', kind: 'armour', slot: 'head', set: 'chorus' },
      ] },
  },

  // ---- side ----
  {
    id: 'void-s1', region: 'void', level: 36,
    name: 'They Followed You In',
    giver: 'stele:void',
    text: {
      offer: 'The wraiths here did not come out of the Void — they came out of the fen, and out of the Court, and out of every place you have been. They are following the same road you are, one death behind. I would very much like to know whether they are chasing you or being herded after you. Break enough of them and we will see which way the rest run.',
      progress: 'Wraiths on the shelves. Watch where the survivors go, not where they came from.',
      done: 'They ran toward the middle. Herded, then. Something is collecting your leftovers.',
    },
    objectives: [{ type: 'kill', enemy: 'wraith', name: 'Fen Wraiths', count: 14, where: 'void' }],
    reward: { xp: 15000, glimmer: 1600, tier: 'rare', kind: 'armour',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'autorifle', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'cloak', set: 'glasswright' },
      ] },
  },
  {
    id: 'void-s2', region: 'void', level: 42,
    name: 'The Long Fall Home',
    giver: 'stele:void',
    text: {
      offer: 'There is an isle out past the last shelf that still has weather on it — an acre of somewhere else, with grass, that has not noticed yet. Get to it and bring back a handful of the soil. If it is Vale soil then this place is not the end of the world, it is the inside of one, and I need to be sitting down when I write that.',
      progress: 'Out past the last shelf. The updrafts at the Unmaking are the only way across.',
      done: 'Vale soil. Meadow flowers, still trying. We are standing inside the thing we thought we were standing on.',
    },
    objectives: [
      { type: 'reach', poi: 'The Unmaking', r: 60, text: 'Cross to the last shelf beyond the Unmaking' },
      { type: 'collect', item: 'vale-soil', name: 'Handfuls of Vale Soil', count: 4, from: ['riftling', 'voidhorror'], chance: 0.5 },
    ],
    reward: { xp: 15219, glimmer: 1650, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'beam', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'arms', set: 'chorus' },
      ] },
  },
];
