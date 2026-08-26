// Infernal Wastes (infernal) — levels 18-25. Roster: imp, magmagolem, drake.
// XP subtotal: 20,246 (60% of the 33,743 the band costs).  5 quests: 3 chain + 2 side.
// The chain is one story: the Wastes are not a volcano, they are a foundry, and it has a shift pattern.
export default [
  {
    id: 'ash-01', region: 'infernal', level: 18, next: 'ash-02',
    name: 'Somebody Is Working These Flows',
    giver: 'stele:infernal',
    text: {
      offer: 'Lava does not braid itself. Stand on the black rock long enough and you will see the channels get cut, straightened, and cut again — and the imps doing the cutting stop at the same hour every day. This is a shift, not a wildfire. Break enough of them off the flow that I can watch what the flow does unattended.',
      progress: 'Cinder Imps, along the channels. They come off the work reluctantly.',
      done: 'Unattended, the flow drifts west within the hour. Somebody wants it going somewhere specific.',
    },
    objectives: [{ type: 'kill', enemy: 'imp', name: 'Cinder Imps', count: 14, where: 'infernal' }],
    reward: { xp: 4000, glimmer: 460, tier: 'rare', kind: 'weapon',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'autorifle', element: 'solar' },
        { tier: 'rare', kind: 'weapon', archetype: 'fusion', element: 'solar' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'emberward' },
      ] },
  },
  {
    id: 'ash-02', region: 'infernal', level: 21, next: 'ash-03',
    name: 'The Slag Has a Recipe',
    giver: 'stele:infernal',
    text: {
      offer: 'When a magma golem dies it leaves a lump of slag that has no business existing — the wrong metals, in the wrong ratio, for anything that ever came out of this mountain. It is an alloy, and somebody is smelting it here because here is the only place hot enough. Bring me eight and I will tell you what it is for.',
      progress: 'Slag, off the golems. The lump is in the chest cavity and it stays hot for about a minute.',
      done: 'It is for a door. A very large one, and the hinge side is under the Cinder Maw.',
    },
    objectives: [
      { type: 'kill', enemy: 'magmagolem', name: 'Magma Golems', count: 5, where: 'infernal' },
      { type: 'collect', item: 'wrong-slag', name: 'Slag of the Wrong Alloy', count: 8, from: ['magmagolem', 'imp'], chance: 0.42 },
    ],
    reward: { xp: 4500, glimmer: 520, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'shotgun', element: 'solar' },
        { tier: 'rare', kind: 'armour', slot: 'arms', set: 'wyrmsworn' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'emberward' },
      ] },
  },
  {
    id: 'ash-03', region: 'infernal', level: 25, next: 'deep-01',
    name: 'The Foreman of the Maw',
    giver: 'stele:infernal',
    text: {
      offer: 'The drakes are not wildlife here. One of them keeps the shift, and it is the reason the channels get recut every dawn — the imps are only its hands. Kill it and the foundry stops. Then go west and get wet: the alloy went out of here by water, and the Drowned Court took delivery.',
      progress: 'The drake that keeps the shift, over the Cinder Maw. Then west, to the Drowned Court.',
      done: 'The flows are already going crooked. Whatever door that alloy was for, it is going to be finished somewhere else — follow it down the falls.',
    },
    objectives: [
      { type: 'slay', enemy: 'drake', name: 'the Foreman of the Maw', tag: 'ash-foreman', where: 'infernal' },
      { type: 'reach', poi: 'The Drowned Court', r: 90, text: 'Travel west to the Drowned Court' },
    ],
    reward: { xp: 6400, glimmer: 760, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'sniper', element: 'solar' },
        { tier: 'legendary', kind: 'weapon', archetype: 'beam', element: 'solar' },
        { tier: 'legendary', kind: 'armour', slot: 'head', set: 'wyrmsworn' },
      ] },
  },

  // ---- side ----
  {
    id: 'ash-s1', region: 'infernal', level: 19,
    name: 'Nothing Should Nest Here',
    giver: 'stele:infernal',
    text: {
      offer: 'Ember drakes lay in the vent throats where the updraft is hottest, and every clutch that hatches this close to the Maw comes out wrong — bigger, and utterly indifferent to fire. If you would like the Wastes to still be crossable next season, thin them now while thinning is a fight and not a war.',
      progress: 'Drakes over the vents. They will see you long before you see them.',
      done: 'Three clutches short of a very bad summer. That is the whole reward and it is a real one.',
    },
    objectives: [{ type: 'kill', enemy: 'drake', name: 'Ember Drakes', count: 8, where: 'infernal' }],
    reward: { xp: 2700, glimmer: 300, tier: 'rare', kind: 'armour',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'pulse', element: 'solar' },
        { tier: 'rare', kind: 'armour', slot: 'cloak', set: 'emberward' },
      ] },
  },
  {
    id: 'ash-s2', region: 'infernal', level: 23,
    name: 'The Ash Remembers Rain',
    giver: 'stele:infernal',
    text: {
      offer: 'There is a stripe of grey in the black rock about a hand deep — one season, a long time ago, when this place had weather instead of a schedule. I want a core sample from the far side of the caldera, where the stripe is thickest, and I want it brought back by somebody who can survive the walk. That is the whole job. The imps are simply in the way.',
      progress: 'Cross the caldera to the grey stripe. Take what tries to stop you off the board first.',
      done: 'One hand deep, and under it, farmland soil. Somebody lived here. Somebody decided they would not.',
    },
    objectives: [
      { type: 'reach', poi: 'The Cinder Maw', r: 70, text: 'Cross the caldera to the Cinder Maw' },
      { type: 'collect', item: 'ashfall-core', name: 'Ashfall Cores', count: 5, from: ['imp', 'magmagolem'], chance: 0.5 },
    ],
    reward: { xp: 2646, glimmer: 300, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'scout', element: 'solar' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'wyrmsworn' },
      ] },
  },
];
