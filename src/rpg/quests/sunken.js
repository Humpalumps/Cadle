// The Sunken Kingdom (sunken) — levels 20-28. Roster: drowned, leviathan, wisp.
// XP subtotal: 24,349 (60% of the 40,582 the band costs).  5 quests: 3 chain + 2 side.
// The chain is one story: the court did not drown, it signed for the water — and it is still holding court.
export default [
  {
    id: 'deep-01', region: 'sunken', level: 20, next: 'deep-02',
    name: 'They Are Still Dressed for It',
    giver: 'stele:sunken',
    text: {
      offer: 'Look at what comes off the shelf at you. Court dress, sashes, seals of office — three hundred years under salt and every one of them still turned out for an audience. Nobody drowns in their good coat by accident. Put a dozen of them down and bring me a seal, and we will find out whose audience it is.',
      progress: 'Drowned Courtiers, off the shelf. Do not let the depth decide the fight for you.',
      done: 'The seal is not a court seal. It is a receipt — and the goods listed on it are people.',
    },
    objectives: [
      { type: 'kill', enemy: 'drowned', name: 'Drowned Courtiers', count: 12, where: 'sunken' },
      { type: 'collect', item: 'court-seal', name: 'Court Seals', count: 4, from: ['drowned'], chance: 0.5 },
    ],
    reward: { xp: 4800, glimmer: 520, tier: 'rare', kind: 'weapon',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'handcannon', element: 'arc' },
        { tier: 'rare', kind: 'weapon', archetype: 'shotgun', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'glasswright' },
      ] },
  },
  {
    id: 'deep-02', region: 'sunken', level: 24, next: 'deep-03',
    name: 'What Swam In With the Tide',
    giver: 'stele:sunken',
    text: {
      offer: 'The leviathans are not native either. They arrived with the water, on the same day, in the same hour — the court did not get flooded, it took delivery of an ocean and everything in it. Kill the biggest of them and look at what it has swallowed. I am told they keep the paperwork.',
      progress: 'Court Leviathans, over the deep basin. Fight them where you can still see the bottom.',
      done: 'A signet, a lung full of parchment, and a name I hoped never to write down again.',
    },
    objectives: [{ type: 'kill', enemy: 'leviathan', name: 'Court Leviathans', count: 5, where: 'sunken' }],
    reward: { xp: 5400, glimmer: 600, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'pulse', element: 'arc' },
        { tier: 'rare', kind: 'weapon', archetype: 'scout', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'chorus' },
      ] },
  },
  {
    id: 'deep-03', region: 'sunken', level: 28, next: 'peak-01',
    name: 'The Court Will See You',
    giver: 'stele:sunken',
    text: {
      offer: 'The throne room still holds an hour of air, and the one sitting in it still holds an opinion. He signed for the sea to keep his kingdom from something worse, and the something worse is what the Wastes were forging that door for. End the audience. Then climb: the Peaks have the last of the alloy, and Kharaz-Dun never signed anything.',
      progress: 'Into the throne room. Coral has taken most of it; he has taken the rest.',
      done: 'He thanked you before he came apart. Go up to the Gate — whatever he bought the sea to hold back, the dwarves tried to wall it in instead.',
    },
    objectives: [
      { type: 'slay', enemy: 'drowned', name: 'the King of the Drowned Court', tag: 'deep-king', where: 'sunken' },
      { type: 'reach', poi: 'Kharaz-Dun Gate', r: 90, text: 'Climb north-east to Kharaz-Dun Gate' },
    ],
    reward: { xp: 7700, glimmer: 880, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'sniper', element: 'arc' },
        { tier: 'legendary', kind: 'weapon', archetype: 'fusion', element: 'void' },
        { tier: 'legendary', kind: 'armour', slot: 'head', set: 'glasswright' },
      ] },
  },

  // ---- side ----
  {
    id: 'deep-s1', region: 'sunken', level: 22,
    name: 'Lamps for the Shelf Road',
    giver: 'stele:sunken',
    text: {
      offer: 'One wisp is trying to get from the shallows down to the Court and cannot cross the drop — past the shelf the water is over your head and a light that size goes out in the dark. Take it down. It is the only thing that has ever wanted to visit those people voluntarily and I would like to see what happens when it arrives.',
      progress: 'Keep the light with you across the shelf and down to the Court.',
      done: 'It hung over the throne room and the whole court turned to look. Three hundred years and that is the first new thing to happen to them.',
    },
    objectives: [{ type: 'escort', from: 'sunken', to: 'The Drowned Court', r: 60, text: 'Guide the wisp down to the Drowned Court' }],
    reward: { xp: 3300, glimmer: 360, tier: 'rare', kind: 'armour',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'autorifle', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'cloak', set: 'chorus' },
      ] },
  },
  {
    id: 'deep-s2', region: 'sunken', level: 26,
    name: 'Salt in the Aether',
    giver: 'stele:sunken',
    text: {
      offer: 'Wisps that come down here take on salt and stop behaving — they cling to the coral heads and burn cold, and the coral dies in a ring around every one of them. That ring is spreading across the reef that keeps the shelf standing. I am not asking for a study. I am asking you to put them out.',
      progress: 'Salted wisps on the coral heads. The dead ring will show you where the next one is.',
      done: 'The reef will scar but it will hold. The shelf road stays walkable, which is the only reason any of this was worth doing.',
    },
    objectives: [{ type: 'kill', enemy: 'wisp', name: 'salted Aether Wisps', count: 14, where: 'sunken' }],
    reward: { xp: 3149, glimmer: 340, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'beam', element: 'arc' },
        { tier: 'rare', kind: 'armour', slot: 'arms', set: 'glasswright' },
      ] },
  },
];
