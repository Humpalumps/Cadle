// The Vale (meadow) — levels 1-5. Roster: wisp, hound, sentinel, golem, drake, warden.
// XP subtotal: 1,713.  12 quests: 4 chain + 2 side + 6 town quests (5 Hearthfall villagers + the plaza guard).
// Town quests carry giver 'npc:<id>' + giverPos [x,z]; <id> matches a Props named villager
// ('npc:elder' -> props.npcs id 'npc-elder' — see Props._buildVillagers). They are offered and turned
// in AT the villager (quest.readGiver), never at the stele. giverPos is only the fallback anchor for
// when the NPC body is absent (missing GLB); QuestMarkers prefers the live props.npcs position.
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

  // ---- Hearthfall town quests (villager givers) ----
  {
    id: 'vale-t1', region: 'meadow', level: 2,
    name: 'Petals That Will Not Be Picked',
    giver: 'npc:maren', giverName: 'Maren the Herbwife', giverPos: [113, -88],
    text: {
      offer: 'Moonpetal only opens where the wisps drift — the light coaxes it, or frightens it, I have never settled which. Either way the wisps hang over every patch worth cutting, and my knees are past arguing with them. Bring me four blooms with the shine still on them.',
      progress: 'Follow the wisps at dusk-light. Where they linger, the moonpetal opens.',
      done: 'Still warm. You can tell my customers the salve works because somebody else did the walking.',
    },
    objectives: [{ type: 'collect', item: 'moonpetal', name: 'Moonpetal Blooms', count: 4, from: ['wisp'], chance: 0.55 }],
    reward: { xp: 90, glimmer: 30, tier: 'common',
      choices: [
        { tier: 'common', kind: 'weapon', archetype: 'scout', element: 'verdant' },
        { tier: 'common', kind: 'armour', slot: 'arms', set: 'pilgrim' },
      ] },
  },
  {
    id: 'vale-t2', region: 'meadow', level: 2,
    name: 'Wolves Wearing Light',
    giver: 'npc:tam', giverName: 'Old Tam the Shepherd', giverPos: [130, -104],
    text: {
      offer: 'Hounds took two ewes this week, and these are not honest wolves — they glow, and honest wolves have the decency not to. My dog will not go near them and my throwing arm went with my hair. Thin them out before the flock decides the far hills are safer than my field.',
      progress: 'They come up out of the tall grass between here and the Spire. You will see them before you hear them — that is the wrong way round, and it never stops being unsettling.',
      done: 'The flock came back to the near field on its own. Sheep know. That is the whole of what sheep know, but they know it.',
    },
    objectives: [{ type: 'kill', enemy: 'hound', name: 'Aether Hounds', count: 6, where: 'meadow' }],
    reward: { xp: 100, glimmer: 30, tier: 'common',
      choices: [
        { tier: 'common', kind: 'weapon', archetype: 'shotgun', element: 'kinetic' },
        { tier: 'common', kind: 'armour', slot: 'legs', set: 'pilgrim' },
      ] },
  },
  {
    id: 'vale-t3', region: 'meadow', level: 2,
    name: 'The Water Tastes of Weather',
    giver: 'npc:serel', giverName: 'Serel the Well-Keeper', giverPos: [116, -99],
    text: {
      offer: 'Our well drinks from the same seam as Mirrormere, and this month the water has come up tasting of weather — storms that have not happened yet, if you ask me, which nobody does. Walk to the lake and look at it. I do not need a hero; I need eyes younger than mine to tell me whether the shore has moved.',
      progress: 'West past the Aetheryte, then follow the ground downhill. Water knows the way better than the road does.',
      done: 'The shore held, you say. Then it is the seam itself that is restless. I will sleep better knowing the lake is where I left it — that is more than most people get from a well.',
    },
    objectives: [{ type: 'reach', poi: 'Mirrormere', r: 60, text: 'Look upon Mirrormere for Serel' }],
    reward: { xp: 80, glimmer: 25, tier: 'common',
      choices: [
        { tier: 'common', kind: 'weapon', archetype: 'handcannon', element: 'kinetic' },
        { tier: 'common', kind: 'armour', slot: 'chest', set: 'pilgrim' },
      ] },
  },
  {
    id: 'vale-t4', region: 'meadow', level: 3,
    name: 'Coals for the Cold Nights',
    giver: 'npc:wick', giverName: 'Wick the Lamplighter', giverPos: [125.4, -88.4],
    text: {
      offer: 'Every lamp in Hearthfall burns on a watch ember — coal out of a sentinel’s chest, cold to the touch and bright all night. The Spire camp is the only place they are still to be had, and I am a lamplighter, not a soldier. Three embers keeps the village lit through the dark of the month.',
      progress: 'The embers sit where the heart would be. They do not burn once they are out — carry them in your pocket, I do.',
      done: 'Three. The lane will be lit tonight, and the children can stop pretending they are not afraid of the dark. So can I.',
    },
    objectives: [{ type: 'collect', item: 'spire-ember', name: 'Watch Embers', count: 3, from: ['sentinel', 'golem'], chance: 0.5 }],
    reward: { xp: 110, glimmer: 40, tier: 'uncommon',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'pulse', element: 'kinetic' },
        { tier: 'uncommon', kind: 'armour', slot: 'cloak', set: 'pilgrim' },
      ] },
  },
  {
    id: 'vale-t5', region: 'meadow', level: 4,
    name: 'Stone That Walked Off',
    giver: 'npc:bram', giverName: 'Bram the Mason', giverPos: [110, -105],
    text: {
      offer: 'I quarried the field-wall stone myself, and I know my own dressing when I see it — and I have seen it, walking. The sentinels are shoring themselves up with our masonry, and the golems are worse: whole courses gone into their shoulders. Break a few apart before my wall ends up guarding the Spire instead of the village.',
      progress: 'Look at their joints when they square up to you. That is Hearthfall stone, and I want it back in a pile where it belongs.',
      done: 'I will cart the pieces home and no one will ever know the wall spent a season fighting you. Masonry keeps its secrets. So do I, for what you have done.',
    },
    objectives: [
      { type: 'kill', enemy: 'sentinel', name: 'Spire Sentinels', count: 3, where: 'meadow' },
      { type: 'kill', enemy: 'golem', name: 'Crystal Golems', count: 2, where: 'meadow' },
    ],
    reward: { xp: 120, glimmer: 45, tier: 'uncommon',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'sniper', element: 'verdant' },
        { tier: 'uncommon', kind: 'armour', slot: 'head', set: 'pilgrim' },
      ] },
  },
  {
    id: 'vale-t6', region: 'meadow', level: 4,
    name: 'The Post That Cannot Move',
    giver: 'npc:warden-guard', giverName: 'Warden Aldric', giverPos: [11.4, -19.6],
    text: {
      offer: 'I stand this post so the plaza never learns what the Spire road knows. But the drakes are riding the warm air further west each week, and a guard who chases one leaves the Aetheryte unwatched — which is what a clever thing would want. I cannot leave. You can. Bring the sky back down for me.',
      progress: 'They circle high over the crystal fields and stoop when your back is turned. Watch your shadow — theirs crosses it first.',
      done: 'Quiet air. Nobody in the plaza knows this week was any different from last week, and that is the whole job, stranger — nobody knowing. I will remember that you do.',
    },
    objectives: [{ type: 'kill', enemy: 'drake', name: 'Meadow Drakes', count: 2, where: 'meadow' }],
    reward: { xp: 110, glimmer: 40, tier: 'uncommon',
      choices: [
        { tier: 'uncommon', kind: 'weapon', archetype: 'autorifle', element: 'kinetic' },
        { tier: 'uncommon', kind: 'armour', slot: 'legs', set: 'pilgrim' },
      ] },
  },
];
