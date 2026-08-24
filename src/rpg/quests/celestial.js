// Celestial Isles (celestial) — levels 30-38. Roster: seraph, skyserpent, wisp.
// XP subtotal: 74,706 (60% of the 124,510 the band costs).  6 quests: 4 chain + 2 side.
// The chain is one story: the Isles are not floating. They are the last thing still being HELD up.
export default [
  {
    id: 'sky-01', region: 'celestial', level: 30, next: 'sky-02',
    name: 'Nothing Up Here Is Falling',
    giver: 'stele:celestial',
    text: {
      offer: 'Drop a stone off the edge of an isle and it does not fall — it drifts to the next isle and settles. That is not flight, that is somebody carrying. The seraphim will not discuss it and they will not let you near the anchor stones. Make room, and I will get a measurement while you have their attention.',
      progress: 'Empyrean Seraphim, around the anchor stones. They fight in threes; do not let them.',
      done: 'The measurement is absurd. The Isles weigh what a mountain weighs and something is holding all of it up by hand.',
    },
    objectives: [{ type: 'kill', enemy: 'seraph', name: 'Empyrean Seraphim', count: 12, where: 'celestial' }],
    reward: { xp: 11000, glimmer: 1200, tier: 'rare', kind: 'weapon',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'sniper', element: 'arc' },
        { tier: 'rare', kind: 'weapon', archetype: 'pulse', element: 'kinetic' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'glasswright' },
      ] },
  },
  {
    id: 'sky-02', region: 'celestial', level: 32, next: 'sky-03',
    name: 'The Serpents Swim a Current',
    giver: 'stele:celestial',
    text: {
      offer: 'The sky serpents do not fly at random. They ride something — a current, a seam, a line of force that runs isle to isle and always ends at the Gate. Cut a few of them out of it and bring me the scale from behind the jaw; a scale that has been in that current for a century has the shape of it written on the underside.',
      progress: 'Sky Serpents, along the seam. Take them where the current turns, not where it runs straight.',
      done: 'Every scale reads the same line, and the line does not end at the Gate. It goes THROUGH it, and out the far side into nothing.',
    },
    objectives: [
      { type: 'kill', enemy: 'skyserpent', name: 'Sky Serpents', count: 8, where: 'celestial' },
      { type: 'collect', item: 'current-scale', name: 'Current Scales', count: 6, from: ['skyserpent'], chance: 0.45 },
    ],
    reward: { xp: 12000, glimmer: 1300, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'scout', element: 'arc' },
        { tier: 'rare', kind: 'weapon', archetype: 'handcannon', element: 'kinetic' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'chorus' },
      ] },
  },
  {
    id: 'sky-03', region: 'celestial', level: 35, next: 'sky-04',
    name: 'Ride the Updraft to the High Isle',
    giver: 'stele:celestial',
    text: {
      offer: 'There is one isle above all the others and no seraph has been on it in living memory — the columns at the Gate will carry you if you can survive the ascent, and everything with wings up here knows what the columns are for. Get to the top. Look at what the anchor is tied to. That is all I need; you will understand why the moment you see it.',
      progress: 'Take the updraft columns at the Gate. Everything with wings will contest the climb.',
      done: 'It is tied to a hand. An enormous, patient, open hand of marble, and the fingers have started to close.',
    },
    objectives: [
      { type: 'reach', poi: 'The Empyrean Gate', r: 55, text: 'Ride the updraft to the high isle' },
      { type: 'kill', enemy: ['seraph', 'skyserpent'], name: 'the wings that contest the climb', count: 10, where: 'celestial' },
    ],
    reward: { xp: 13000, glimmer: 1400, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'shotgun', element: 'arc' },
        { tier: 'rare', kind: 'weapon', archetype: 'fusion', element: 'kinetic' },
        { tier: 'rare', kind: 'armour', slot: 'head', set: 'glasswright' },
      ] },
  },
  {
    id: 'sky-04', region: 'celestial', level: 38, next: 'void-01',
    name: 'The Hand Is Closing',
    giver: 'stele:celestial',
    text: {
      offer: 'The first of the seraphim stands at the wrist and it has been arguing with that hand for a very long time — it thinks letting go is mercy. Perhaps it is right. It is certainly not entitled to decide. Put it down. Then go north-west and step off the edge of the world: the Unmaking is what the hand is holding the Isles ABOVE.',
      progress: 'The Seraph of the Wrist, at the anchor. Then north-west, into the Void.',
      done: 'The fingers stopped moving. Not opened — stopped. You have bought the Isles some years and spent every one of them on the walk you are about to take.',
    },
    objectives: [
      { type: 'slay', enemy: 'seraph', name: 'the Seraph of the Wrist', tag: 'sky-wrist', where: 'celestial' },
      { type: 'reach', poi: 'The Unmaking', r: 90, text: 'Travel north-west to the Unmaking' },
    ],
    reward: { xp: 18000, glimmer: 2000, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'beam', element: 'arc' },
        { tier: 'legendary', kind: 'weapon', archetype: 'autorifle', element: 'kinetic' },
        { tier: 'legendary', kind: 'armour', slot: 'cloak', set: 'chorus' },
      ] },
  },

  // ---- side ----
  {
    id: 'sky-s1', region: 'celestial', level: 33,
    name: 'The Lamplighter',
    giver: 'stele:celestial',
    text: {
      offer: 'One wisp got up here on a current and has been drifting between isles ever since, and the seraphim will not touch it — it is the only warm thing on the Isles and they have decided it is a sign. It is not a sign, it is lost. Walk it to the Gate before somebody builds a religion on it.',
      progress: 'Keep the little light with you and get it to the Empyrean Gate.',
      done: 'It went out of the Gate on the current and every seraph on the isle turned to watch. Well. They may build the religion anyway.',
    },
    objectives: [{ type: 'escort', from: 'celestial', to: 'The Empyrean Gate', r: 55, text: 'Walk the lost wisp to the Empyrean Gate' }],
    reward: { xp: 10000, glimmer: 1100, tier: 'rare', kind: 'armour',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'sniper', element: 'kinetic' },
        { tier: 'rare', kind: 'armour', slot: 'arms', set: 'glasswright' },
      ] },
  },
  {
    id: 'sky-s2', region: 'celestial', level: 36,
    name: 'Marble That Bleeds',
    giver: 'stele:celestial',
    text: {
      offer: 'The ruins on the lower isles have started weeping aether from the joints — not cracks, joints, as though the buildings were made of something that could get tired. Bring me the wept stone before it dries. If marble up here can bleed, then everything I have written about what the Isles ARE is one word wrong, and it is an important word.',
      progress: 'Wept stone, from the lower ruins. The serpents nest in the same joints, so expect company.',
      done: "It is not marble and it never was. It is bone, and it is somebody's, and they are still using it.",
    },
    objectives: [{ type: 'collect', item: 'wept-stone', name: 'Wept Stone', count: 8, from: ['seraph', 'skyserpent', 'wisp'], chance: 0.4 }],
    reward: { xp: 10706, glimmer: 1150, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'scout', element: 'arc' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'chorus' },
      ] },
  },
];
