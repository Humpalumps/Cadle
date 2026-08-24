// Shadowfen (shadowfen) — levels 15-22. Roster: wraith, bogwitch, hound.
// XP subtotal: 25,364 (60% of the 42,273 the band costs).  5 quests: 3 chain + 2 side.
// The chain is one story: the fen is not haunted, it is being farmed, and the Hagstone is the ledger.
export default [
  {
    id: 'fen-01', region: 'shadowfen', level: 15, next: 'fen-02',
    name: 'Nobody Drowns Twice',
    giver: 'stele:shadowfen',
    text: {
      offer: 'Count the wraiths. Then count the graves — there are two hundred graves and there have been two hundred wraiths every single season since I started keeping the tally. That is not a haunting. A haunting thins out. Something here is putting them back. Cut down enough of them that the number moves, and we will know whether I am right.',
      progress: 'Wraiths, out over the peat. Watch the count, not the kill.',
      done: 'The number moved. It will be back to two hundred by the new moon, and now we both know why that matters.',
    },
    objectives: [{ type: 'kill', enemy: 'wraith', name: 'Fen Wraiths', count: 14, where: 'shadowfen' }],
    reward: { xp: 5000, glimmer: 520, tier: 'rare', kind: 'weapon',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'shotgun', element: 'void' },
        { tier: 'rare', kind: 'weapon', archetype: 'fusion', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'chorus' },
      ] },
  },
  {
    id: 'fen-02', region: 'shadowfen', level: 18, next: 'fen-03',
    name: 'The Witches Keep Accounts',
    giver: 'stele:shadowfen',
    text: {
      offer: 'The bog witches are not casting anything. They are auditing — walking the peat, opening the drowned, writing the count on their own arms in reed-ink. Take those arms off them and bring me the tallies. Whoever they report to has been reading them for a very long time.',
      progress: 'Tallies, off the witches. They will not surrender them and you should not expect them to.',
      done: 'Same hand on every tally. Same hand as the marks cut into the Hagstone. She has been counting her own stock.',
    },
    objectives: [
      { type: 'kill', enemy: 'bogwitch', name: 'Bog Witches', count: 6, where: 'shadowfen' },
      { type: 'collect', item: 'reed-tally', name: 'Reed Tallies', count: 6, from: ['bogwitch'], chance: 0.55 },
    ],
    reward: { xp: 5600, glimmer: 600, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'sniper', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'arms', set: 'glasswright' },
        { tier: 'rare', kind: 'armour', slot: 'legs', set: 'chorus' },
      ] },
  },
  {
    id: 'fen-03', region: 'shadowfen', level: 22, next: 'ash-01',
    name: 'The Hagstone Ledger',
    giver: 'stele:shadowfen',
    text: {
      offer: 'She is under the Hagstone, and she has been under it since before the stone had a name. Two hundred souls is not an army — it is a float, held to pay for something she has not bought yet. Go down and close the account. Then walk east into the Wastes: whatever she was saving up for, the Cinder Maw has been quoting the price.',
      progress: 'Under the Hagstone. Bring the peat with you; she is used to fighting the fen, not somebody who came through it.',
      done: 'The ledger burned green and every wraith on the peat went out at once. Two hundred people finished dying today. Go east, and find out what they were being spent on.',
    },
    objectives: [
      { type: 'slay', enemy: 'bogwitch', name: 'the Hag beneath the stone', tag: 'fen-hag', where: 'shadowfen' },
      { type: 'reach', poi: 'The Cinder Maw', r: 90, text: 'Travel east to the Cinder Maw' },
    ],
    reward: { xp: 8000, glimmer: 860, tier: 'legendary', kind: 'weapon',
      choices: [
        { tier: 'legendary', kind: 'weapon', archetype: 'pulse', element: 'void' },
        { tier: 'legendary', kind: 'weapon', archetype: 'beam', element: 'void' },
        { tier: 'legendary', kind: 'armour', slot: 'cloak', set: 'glasswright' },
      ] },
  },

  // ---- side ----
  {
    id: 'fen-s1', region: 'shadowfen', level: 16,
    name: 'Hounds in the Reeds',
    giver: 'stele:shadowfen',
    text: {
      offer: 'Aether hounds came down the pass and found a fen full of things that do not stay dead, which for a hound is an unlimited larder. They have learned to hunt in the murk faster than anything native to it. Cut the pack down before they teach the next pack.',
      progress: 'Hounds in the reeds. You will hear them before the water tells you anything.',
      done: 'They will be back — but not this generation, and this generation was the clever one.',
    },
    objectives: [{ type: 'kill', enemy: 'hound', name: 'Aether Hounds', count: 12, where: 'shadowfen' }],
    reward: { xp: 3400, glimmer: 340, tier: 'rare', kind: 'armour',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'scout', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'head', set: 'chorus' },
      ] },
  },
  {
    id: 'fen-s2', region: 'shadowfen', level: 20,
    name: 'A Light That Wants Out',
    giver: 'stele:shadowfen',
    text: {
      offer: 'One wisp came into the fen behind you and the peat will not let it leave — the murk drinks light and it has been drinking this one for three days. It cannot find the Hagstone road on its own. Walk it out. Everything in the water will object, which is precisely why nobody has done it yet.',
      progress: 'Keep the light with you and keep moving toward the Hagstone. It follows what it can see.',
      done: 'It cleared the reeds and went straight up like it had been holding its breath. Something in the fen resented that very much.',
    },
    objectives: [{ type: 'escort', from: 'shadowfen', to: 'The Hagstone', r: 60, text: 'Walk the trapped wisp out to the Hagstone' }],
    reward: { xp: 3364, glimmer: 360, tier: 'rare',
      choices: [
        { tier: 'rare', kind: 'weapon', archetype: 'handcannon', element: 'void' },
        { tier: 'rare', kind: 'armour', slot: 'chest', set: 'glasswright' },
      ] },
  },
];
