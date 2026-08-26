// Dragon Peaks (dragon) — levels 24-32. Roster: wyvern, forgeknight, golem.
// XP subtotal: 43,490.  6 quests: 3 chain + 3 side.
// The chain is one story: Kharaz-Dun did not fall to the wyverns. It bricked itself in, from the inside.
export default [
  {
    id: 'peak-01', region: 'dragon', level: 24, next: 'peak-02',
    name: 'The Ledges Are Not Ledges',
    giver: 'stele:dragon',
    text: {
      offer: 'Everybody calls them nest ledges. Get close and they are stairs — cut stairs, dwarf-width, going up the north face to a door nobody has opened in an age. The wyverns nest on them because nothing has used them. Clear enough of the face that I can send a survey up it, and we will see where the dwarves were going in such a hurry.',
      progress: 'Peak Wyverns, on the north face. Fight them off the stone, not on it.',
      done: 'Stairs. Eleven flights of them, and the top three were cut in a panic — the tool marks get worse the higher you go.',
    },
    objectives: [{ type: 'kill', enemy: 'wyvern', name: 'Peak Wyverns', count: 12, where: 'dragon' }],
    reward: { xp: 7800, glimmer: 820, tier: 'rare', kind: 'weapon',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'sniper', element: 'solar' },
        { tier: 'rare', kind: 'weapon', archetype: 'handcannon', element: 'solar' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'wyrmsworn' },
      ] },
  },
  {
    id: 'peak-02', region: 'dragon', level: 28, next: 'peak-03',
    name: 'The Watch That Never Stood Down',
    giver: 'stele:dragon',
    text: {
      offer: 'The forgeknights at the Gate are still on their posts and their rotation is still perfect, which is remarkable for men who have been dead since before the Vale had a name. They are not guarding the Gate from the outside. Look at which way they are facing. Break the line and bring me a rivet from one — the maker mark will date the order.',
      progress: 'Forgeknights, at the Gate. They will not break formation, so break it for them.',
      done: 'The rivets are the same wrong alloy the Wastes were smelting. Kharaz-Dun ordered that door. Kharaz-Dun shut it on themselves.',
    },
    objectives: [
      { type: 'kill', enemy: 'forgeknight', name: 'Kharaz Forgeknights', count: 10, where: 'dragon' },
      { type: 'collect', item: 'kharaz-rivet', name: 'Maker-Marked Rivets', count: 6, from: ['forgeknight'], chance: 0.5 },
    ],
    reward: { xp: 8700, glimmer: 940, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'pulse', element: 'solar' },
        { tier: 'rare', kind: 'weapon', archetype: 'shotgun', element: 'solar' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'emberward' },
      ] },
  },
  {
    id: 'peak-03', region: 'dragon', level: 32, next: 'sky-01',
    name: 'What the Gate Was Holding',
    giver: 'stele:dragon',
    text: {
      offer: 'Something has been walking the halls behind the Gate for an age with nobody to walk toward. It is stone the mountain did not make and it is the reason eleven flights of stairs were cut in a panic. Go in and finish what the dwarves would not. Then go east and up — the Empyrean Gate is the same door, built by people who thought they were better at it.',
      progress: 'Behind the Gate. Whatever it is, it does not need the light and neither does it need the air.',
      done: 'The halls are empty for the first time since they were sealed. Now go and look at the Isles, and count how many gates that makes.',
    },
    objectives: [
      { type: 'slay', enemy: 'golem', name: 'the thing behind the Gate', tag: 'peak-warden', where: 'dragon' },
      { type: 'reach', poi: 'The Empyrean Gate', r: 90, text: 'Travel north to the Empyrean Gate' },
    ],
    reward: { xp: 12400, glimmer: 1400, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'fusion', element: 'solar' },
        { tier: 'legendary', kind: 'weapon', archetype: 'scout', element: 'solar' },
        { tier: 'legendary', kind: 'armour', slot: 'head', set: 'wyrmsworn' },
      ] },
  },

  // ---- side ----
  {
    id: 'peak-s1', region: 'dragon', level: 26,
    name: 'Quarry Rights',
    giver: 'stele:dragon',
    text: {
      offer: 'Stone golems are coming up out of the old quarry faster than the quarry can have been making them, and they are walking downhill — toward the passes, toward the Vale. Nobody in the Peaks is steering them. Something below is simply out of room. Put down the ones already loose before the first of them reaches a road.',
      progress: 'Golems on the quarry road. They do not stop, so you will have to.',
      done: 'The road is clear as far as the second switchback. Someone should go into that quarry. It should not be you, today.',
    },
    objectives: [{ type: 'kill', enemy: 'golem', name: 'Stone Golems', count: 10, where: 'dragon' }],
    reward: { xp: 5300, glimmer: 560, tier: 'rare', kind: 'armour',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'autorifle', element: 'solar' },
        { tier: 'rare', kind: 'armour', slot: 'cloak', set: 'emberward' },
      ] },
  },
  {
    id: 'peak-s2', region: 'dragon', level: 30,
    name: 'A Nest Worth the Climb',
    giver: 'stele:dragon',
    text: {
      offer: 'One wyvern has built above the treeline out of things it did not find on this mountain — sea-glass, court silver, a rib of the wrong alloy. It has been flying somewhere none of the others go. Kill it, climb to the nest, and bring me whatever it thought was worth the distance.',
      progress: 'The high nest, above the treeline. The climb is the fight; the wyvern is the easy part.',
      done: 'Sea-glass from the Sunken shelf and slag from the Maw, in one nest, on one mountain. Everything in this world is pointing at the same door.',
    },
    objectives: [
      { type: 'slay', enemy: 'wyvern', name: 'the far-flying wyvern', tag: 'peak-hoarder', where: 'dragon' },
      { type: 'collect', item: 'hoard-shard', name: 'Pieces of the Hoard', count: 5, from: ['wyvern'], chance: 0.55 },
    ],
    reward: { xp: 5090, glimmer: 560, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'beam', element: 'solar' },
        { tier: 'rare', kind: 'armour', slot: 'arms', set: 'wyrmsworn' },
      ] },
  },
  {
    // the nest ENCOUNTER's quest hook (Enemies.js _updateNests): walking up to a nest wakes a guardian
    // pair and gives up an egg while this is active; wyvern kills can also shake one loose.
    id: 'peak-s3', region: 'dragon', level: 27,
    name: 'A Clutch Held Warm',
    giver: 'stele:dragon',
    text: {
      offer: 'The nests on the benches are not abandoned — put a boot within ten paces of one and you will meet what warms it. The eggs run hot enough to fog a lens, which means they are alive, which means somebody is FEEDING this mountain a new generation. Bring me three. The brood will object; the brood is the point.',
      progress: 'Eggs off the bench nests. The guardians come with them, and they come first.',
      done: 'Warm through, all three, and each shell carries the same maker mark as the rivets. The wyverns are not nesting here. They are being ISSUED.',
    },
    objectives: [{ type: 'collect', item: 'drake-egg', name: 'Speckled Drake Eggs', count: 3, from: ['wyvern'], chance: 0.25 }],
    reward: { xp: 4200, glimmer: 480, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'scout', element: 'solar' },
        { tier: 'rare', kind: 'armour', slot: 'head', set: 'emberward' },
      ] },
  },
];
