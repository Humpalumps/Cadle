// The Vale (meadow) — levels 1-5. Roster: wisp, hound, sentinel, golem, drake, warden.
// XP subtotal: 1,103 (60% of the 1,839 the band costs).  6 quests: 4 chain + 2 side.
export default [
  {
    id: 'vale-01', region: 'meadow', level: 1, next: 'vale-02',
    name: 'The Vale Remembers',
    giver: 'stele:meadow',
    // the old voiced opener, rewritten: same staging — aetheryte flare, zone card, waypoint east
    intro: { flare: [0, 6, -28], card: ['The Shattered Meadow', 'Cadle'] },
    text: {
      offer: 'You woke in the grass with no name the world will answer to. The Aetheryte flared when you stood — it knows you, even if nothing else does. East, past the meadow, broken stone climbs where a spire used to stand. Start there; the Vale keeps its wounds where you can find them.',
      progress: 'East. Follow the rising sun until the stone climbs.',
      done: 'The Sundered Spire. Aether bleeds out of it like a held breath finally let go.',
    },
    objectives: [{ type: 'reach', poi: 'The Sundered Spire', r: 70, text: 'Reach the ruins to the east' }],
    reward: { xp: 120, glimmer: 40, tier: 'uncommon', kind: 'weapon',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'handcannon', element: 'kinetic' },
        { tier: 'uncommon', kind: 'weapon', archetype: 'scout', element: 'verdant' },
        { tier: 'uncommon', kind: 'armour', slot: 'chest', set: 'pilgrim' },
      ] },
  },
  {
    id: 'vale-02', region: 'meadow', level: 2, next: 'vale-03',
    name: 'Something Feeds on the Wound',
    giver: 'stele:meadow',
    text: {
      offer: 'The Spire did not break yesterday, but the aether still runs from it, and things have come down out of the grass to drink. Hounds first, then the sentinels that used to keep them out. Clear the camp before the wound learns to like the company.',
      progress: 'The camp at the Spire. Hounds, wisps, and whatever the sentinels have become.',
      done: 'Quieter. The bleeding has not stopped, but nothing is lapping at it now.',
    },
    objectives: [
      { type: 'kill', enemy: ['hound', 'wisp'], name: 'the scavengers at the Spire', count: 5, where: 'meadow' },
      { type: 'kill', enemy: 'sentinel', name: 'Spire Sentinels', count: 2, where: 'meadow' },
    ],
    reward: { xp: 150, glimmer: 60, tier: 'uncommon',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'pulse', element: 'kinetic' },
        { tier: 'uncommon', kind: 'armour', slot: 'arms', set: 'pilgrim' },
        { tier: 'uncommon', kind: 'armour', slot: 'legs', set: 'pilgrim' },
      ] },
  },
  {
    id: 'vale-03', region: 'meadow', level: 3, next: 'vale-04',
    name: 'Ashes of the Watch',
    giver: 'stele:meadow',
    text: {
      offer: 'Every sentinel here carries a coal in its chest — the last of the flame the watch was lit with. Bring me those embers. Cold, they are only stone; together they will tell me how long ago this place was still being defended.',
      progress: 'Break the sentinels. The ember is in the chest, and it does not burn once it is out.',
      done: 'Four hundred years, give or take a winter. They held longer than anyone came back to see.',
    },
    objectives: [{ type: 'collect', item: 'spire-ember', name: 'Watch Embers', count: 5, from: ['sentinel', 'golem'], chance: 0.5 }],
    reward: { xp: 180, glimmer: 70, tier: 'uncommon', kind: 'armour',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'shotgun', element: 'kinetic' },
        { tier: 'uncommon', kind: 'weapon', archetype: 'sniper', element: 'verdant' },
        { tier: 'uncommon', kind: 'armour', slot: 'cloak', set: 'pilgrim' },
      ] },
  },
  {
    id: 'vale-04', region: 'meadow', level: 5, next: 'wood-01',
    name: "The Warden's Long Watch",
    giver: 'stele:meadow',
    text: {
      offer: 'The thing standing in the shattered tower was a Warden once, and it has not stopped being one — it is simply guarding a door that no longer opens onto anywhere. End it, and it can put the weight down. Then go north, into Whisperwood; the trees there have been talking about you.',
      progress: 'The Warden holds the tower. Whisperwood waits after.',
      done: 'It knelt before it fell. Take the arm it kept for you, and walk north — the Elderheart is expecting a visitor.',
    },
    objectives: [
      { type: 'slay', enemy: 'warden', name: 'the Warden of the Spire', tag: 'vale-warden', where: 'meadow', at: 'The Sundered Spire' },   // `at` is mandatory here: `where: 'meadow'` anchors to the ORIGIN, and the spawn meadow stays peaceful (user decree)
      { type: 'reach', poi: 'The Elderheart', r: 90, text: 'Travel north to the Elderheart' },
    ],
    reward: { xp: 300, glimmer: 140, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'fusion', element: 'kinetic' },
        { tier: 'legendary', kind: 'weapon', archetype: 'autorifle', element: 'verdant' },
        { tier: 'legendary', kind: 'armour', slot: 'head', set: 'pilgrim' },
      ] },
  },

  // ---- side ----
  {
    id: 'vale-s1', region: 'meadow', level: 3,
    name: 'Still Water, Long Memory',
    giver: 'stele:meadow',
    text: {
      offer: 'Mirrormere shows you the sky as it was, not as it is — that is not a kindness, it is a symptom. Wisps have been circling the island since the Spire cracked, and the lake has stopped reflecting anything at all on that side. Go and thin them, and tell me what the water does after.',
      progress: 'Wisps over Mirrormere. The island is the worst of it.',
      done: 'It reflects again. Badly, and a little late — but it reflects.',
    },
    objectives: [
      { type: 'reach', poi: 'Mirrormere', r: 90, text: 'Walk the shore of Mirrormere' },
      { type: 'kill', enemy: 'wisp', name: 'Aether Wisps', count: 6, where: 'meadow' },
    ],
    reward: { xp: 170, glimmer: 60, tier: 'uncommon', kind: 'armour',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'beam', element: 'kinetic' },
        { tier: 'uncommon', kind: 'armour', slot: 'chest', set: 'pilgrim' },
      ] },
  },
  {
    id: 'vale-s2', region: 'meadow', level: 4,
    name: 'What the Fields Grew',
    giver: 'stele:meadow',
    text: {
      offer: 'Nobody planted the crystals east of the meadow. They came up the year the Spire fell, and something in the ground has been shaping golems out of the seams ever since. Break a few open — I want to know whether what is inside is aether or something wearing it.',
      progress: 'The Crystal Fields, east. Golems first; the hounds will find you on their own.',
      done: 'Aether, and something else underneath. I would rather not have been right.',
    },
    objectives: [
      { type: 'kill', enemy: 'hound', name: 'Aether Hounds', count: 4, where: 'meadow' },
      { type: 'collect', item: 'crystal-bloom', name: 'Crystal Blooms', count: 4, from: ['golem'], chance: 0.6 },
    ],
    reward: { xp: 183, glimmer: 80, tier: 'uncommon', kind: 'armour',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'scout', element: 'verdant' },
        { tier: 'uncommon', kind: 'armour', slot: 'arms', set: 'pilgrim' },
      ] },
  },
];
