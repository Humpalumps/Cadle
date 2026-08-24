// The Lost Realm (lost) — levels 40-50. Roster: archon, sentinel, golem, wraith.
// XP subtotal: 117,408 (60% of the 195,680 the band costs).  6 quests: 4 chain + 2 side.
// The chain is one story: every magic in the world meets here, and the Archon has been holding the argument open.
export default [
  {
    id: 'lost-01', region: 'lost', level: 40, next: 'lost-02',
    name: 'Sixteen Monoliths, One Argument',
    giver: 'stele:lost',
    text: {
      offer: 'Sixteen stones in a ring, and every one of them is a magic that lost. They are not monuments — they are held positions, and they have been held so long that the sentinels standing at them have forgotten there was ever anything to decide. Break the ring open. Whatever is being argued about at the centre has been given four ages of quiet to prepare its answer.',
      progress: 'Spire Sentinels, one to a monolith. The ring will close behind you if you are slow.',
      done: 'Four stones down and the ring is already leaning. Whatever this was voting on, it is about to be decided by attrition.',
    },
    objectives: [{ type: 'kill', enemy: 'sentinel', name: 'the sentinels of the ring', count: 16, where: 'lost' }],
    reward: { xp: 18000, glimmer: 2000, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'sniper', element: 'void' },
        { tier: 'legendary', kind: 'weapon', archetype: 'handcannon', element: 'kinetic' },
        { tier: 'legendary', kind: 'armour', slot: 'chest', set: 'wyrmsworn' },
      ] },
  },
  {
    id: 'lost-02', region: 'lost', level: 43, next: 'lost-03',
    name: 'The Rampart Was Built Inward',
    giver: 'stele:lost',
    text: {
      offer: 'Walk the rampart and read the stonework. Every arrow slot, every murder hole, every buttress faces the CENTRE. This wall was never built to keep anyone out of the Convergence — it was built to keep the Convergence in, by people who then had to live inside their own siege. Bring me a keystone from each quarter and I will tell you how long they lasted.',
      progress: 'Keystones, off the golems that were the wall. Four quarters, four stones.',
      done: 'Eleven years. Eleven years inside their own wall, and then they opened it themselves. They always do.',
    },
    objectives: [
      { type: 'kill', enemy: 'golem', name: 'the wall that walks', count: 10, where: 'lost' },
      { type: 'collect', item: 'rampart-keystone', name: 'Rampart Keystones', count: 4, from: ['golem'], chance: 0.5 },
    ],
    reward: { xp: 19000, glimmer: 2100, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'pulse', element: 'void' },
        { tier: 'rare', kind: 'weapon', archetype: 'shotgun', element: 'kinetic' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'glasswright' },
      ] },
  },
  {
    id: 'lost-03', region: 'lost', level: 46, next: 'lost-04',
    name: 'Everyone Who Came Before',
    giver: 'stele:lost',
    text: {
      offer: 'The wraiths at the Convergence are the ones who walked this exact road — every band that got as far as you have, standing where they stopped. You will recognise the kit. Some of it will be better than yours. They cannot be spoken to and they cannot be spared, and the only respect available to them is to be the one who does not join the line.',
      progress: 'The wraiths inside the rampart. They will fight the way you fight; they learned it the same way.',
      done: 'The line is shorter. You are still outside it. That is the entire achievement and it is not a small one.',
    },
    objectives: [{ type: 'kill', enemy: 'wraith', name: 'the ones who came before', count: 18, where: 'lost' }],
    reward: { xp: 21000, glimmer: 2300, tier: 'legendary', kind: 'armour',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'fusion', element: 'void' },
        { tier: 'legendary', kind: 'weapon', archetype: 'scout', element: 'kinetic' },
        { tier: 'legendary', kind: 'armour', slot: 'head', set: 'wyrmsworn' },
      ] },
  },
  {
    id: 'lost-04', region: 'lost', level: 50,
    name: 'The Convergence',
    giver: 'stele:lost',
    text: {
      offer: 'The Archon has been holding the argument open for four ages because as long as nothing is decided, nothing is finished, and as long as nothing is finished it does not have to be wrong. That is why the Vale bleeds, why the fen is farmed, why a nursery is folded inside a horror. Go to the centre and end the argument. There is no next stele. This is the road you were pointed down the morning the Aetheryte flared, and it stops here.',
      progress: 'The centre of the ring. Everything you have walked past is standing behind it.',
      done: 'It let go. The sixteen stones went out one after another like lamps at dawn, and somewhere behind you the Vale stopped bleeding. Go home, Wayfarer. It remembers you.',
    },
    objectives: [
      { type: 'reach', poi: 'The Convergence', r: 50, text: 'Enter the ring at the Convergence' },
      { type: 'slay', enemy: 'archon', name: 'the Archon of the Convergence', tag: 'lost-archon', where: 'lost' },
    ],
    reward: { xp: 28000, glimmer: 4000, tier: 'exotic', kind: 'weapon',
      choices: [
        { tier: 'exotic', kind: 'weapon', archetype: 'beam', element: 'void' },
        { tier: 'exotic', kind: 'weapon', archetype: 'autorifle', element: 'kinetic' },
        { tier: 'exotic', kind: 'armour', slot: 'cloak', set: 'wyrmsworn' },
      ] },
  },

  // ---- side ----
  {
    id: 'lost-s1', region: 'lost', level: 42,
    name: 'What the Ring Ate',
    giver: 'stele:lost',
    text: {
      offer: 'Four ages of magics losing arguments leaves residue, and the residue has settled into the flagstones as shards that are still faintly of their original school — arc, solar, stasis, strand, void, and two I cannot name. Collect the unnamed ones. If there are schools here that never reached the outside world, then this ring did not just settle arguments. It ended lineages.',
      progress: 'Unnamed shards, out of the flagstones. Whatever is standing on them will have an opinion.',
      done: 'Two schools that never got out of this ring. Nobody living knows their names. Now two of us do.',
    },
    objectives: [{ type: 'collect', item: 'unnamed-shard', name: 'Shards of an Unnamed School', count: 10, from: ['sentinel', 'wraith', 'golem'], chance: 0.4 }],
    reward: { xp: 15500, glimmer: 1700, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'sniper', element: 'kinetic' },
        { tier: 'rare', kind: 'armour', slot: 'arms', set: 'glasswright' },
      ] },
  },
  {
    id: 'lost-s2', region: 'lost', level: 48,
    name: 'One Last Light',
    giver: 'stele:lost',
    text: {
      offer: 'The Elderheart sent a light after you. It has come the whole way — forest, ice, fen, fire, sea, stone, sky, and the Void — and it is guttering out on the rampart because nothing here will let it through to the centre. Take it in. Whatever happens at the Convergence, the wood that started you off deserves to have something of itself standing there when it does.',
      progress: 'Walk the guttering light in from the rampart to the Convergence.',
      done: 'It made it to the stones and steadied. Small, stubborn, and further from home than anything else in this ring.',
    },
    objectives: [{ type: 'escort', from: 'lost', to: 'The Convergence', r: 50, text: 'Walk the Elderheart light in to the Convergence' }],
    reward: { xp: 15908, glimmer: 1750, tier: 'legendary', kind: 'armour',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'pulse', element: 'void' },
        { tier: 'legendary', kind: 'armour', slot: 'chest', set: 'wyrmsworn' },
      ] },
  },
];
