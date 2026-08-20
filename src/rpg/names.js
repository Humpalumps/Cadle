// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Aetherfall via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: rpg agent. Name grammar. Pure data + string work — no THREE, no ctx.
//
// A name has to *tell you something*. So the pools are keyed by what the item actually is:
// the element picks the imagery, the archetype picks the noun, the trait perk can take over
// the whole name. Nothing here is a blind prefix+suffix slot machine, and a name that already
// dropped this session never drops again.

// ---------------------------------------------------------------- element palettes
// what the element looks like when it hits something
const EL_PRE = {
  kinetic: ['Iron', 'Rune', 'Grave', 'Stone', 'Old', 'Plain', 'Quiet'],
  solar:   ['Dawn', 'Ember', 'Cinder', 'Sun', 'Bright', 'Kindle', 'Pyre'],
  arc:     ['Storm', 'Gale', 'Levin', 'Quick', 'Bright', 'Skysung', 'Rime'],
  void:    ['Sable', 'Hollow', 'Night', 'Umbral', 'Mourn', 'Grave', 'Ashen'],
  verdant: ['Moss', 'Thorn', 'Verdant', 'Vale', 'Briar', 'Bloom', 'Green'],
};
const EL_SUF = {
  kinetic: ['wrought', 'fall', 'bearer', 'ward', 'reach', 'grasp'],
  solar:   ['light', 'wake', 'crown', 'fall', 'gale', 'wrought'],
  arc:     ['gale', 'wake', 'spire', 'song', 'reach', 'lash'],
  void:    ['veil', 'mourn', 'grasp', 'wane', 'shroud', 'bind'],
  verdant: ['thread', 'sworn', 'song', 'bind', 'bloom', 'tide'],
};

// ---------------------------------------------------------------- archetype palettes
// what the gun *sounds* like: an auto rifle is many small voices, a hand cannon is one
// loud statement, a scout waits, a charge beam is the last word on the subject.
const AR_NOUN = {
  auto:       ['Litany', 'Refrain', 'Chorus', 'Prattle', 'Cadence', 'Hymn'],
  handcannon: ['Verdict', 'Quarrel', 'Answer', 'Mercy', 'Sentence', 'Rebuttal'],
  scout:      ['Vigil', 'Patience', 'Ledger', 'Aubade', 'Reverie', 'Watch'],
  beam:       ['Requiem', 'Threnody', 'Reckoning', 'Covenant', 'Peal', 'Oath'],
  _:          ['Promise', 'Echo', 'Bell', 'Oath', 'Lament'],
};
const AR_ADJ = {
  auto:       ['Restless', 'Unbroken', 'Talkative', 'Long', 'Eager'],
  handcannon: ['Last', 'Kindly', 'Faithless', 'Unbroken', 'Blunt'],
  scout:      ['Patient', 'Quiet', 'Nameless', 'Wandering', 'Sorrowed'],
  beam:       ['Radiant', 'Hollow', 'Gentle', 'Final', 'Slow'],
  _:          ['Nameless', 'Quiet', 'Last'],
};

// the trait you keep the gun for, as a name
const TAG_NOUN = {
  rampage:    'Appetite',
  killclip:   'Reprise',
  outlaw:     'Amnesty',
  firefly:    'Tinder',
  valesong:   'Mercy',
  headseeker: 'Certainty',
  lastbreath: 'Last Word',
  unwavering: 'Anchor',
};

const PLACE = ['Aurelen', 'the Sable Vale', 'Emberfen', 'Kaltmere', 'the Sunken Choir', 'Windrest',
  'the Glass Reach', 'Old Thrynn', 'Hallowmere', 'the Verdant Deep', 'the Nine', 'Broken Arch'];
const WHO = ['Kalari', 'Sorren', 'Ysolde', 'Marrow', 'Vashti', 'Elowen', 'Threnn', 'Ovid', 'Aurek', 'Nima',
  'Bel', 'Corvain', 'Isk', 'Rhosyn'];

// Aetherfall armoury ids share the closest palette
for (const T of [AR_NOUN, AR_ADJ]) { T.autorifle = T.auto; T.pulse = T.auto; T.sniper = T.scout; T.fusion = T.beam; T.shotgun = T.handcannon; }

const pick = (a, rand) => a[(rand() * a.length) | 0];
const at = (map, k) => map[k] || map._ || map.kinetic;

// Raw concat is what shipped "Mosssworn". Two guards: never pick a suffix that starts with the
// letter the prefix ends on, and collapse any run of 3+ identical letters that slips through.
function join(pre, sufPool, rand) {
  const last = pre[pre.length - 1].toLowerCase();
  const ok = sufPool.filter((s) => s[0].toLowerCase() !== last);
  const suf = pick(ok.length ? ok : sufPool, rand);
  return (pre + suf).replace(/(.)\1{2,}/g, '$1$1');
}

// ---------------------------------------------------------------- session memory
// One session should not hand you Threnody three times. Names are checked against everything
// already generated this run and re-rolled; the pools are wide enough that this is cheap.
const used = new Set();
export function resetNames() { used.clear(); }
export const namesUsed = () => used.size;
// a loaded save already owns its names — reserve them so nothing rolls a duplicate
export function reserveNames(list) { for (const n of list || []) if (typeof n === 'string') used.add(n); }

function unique(gen, rand) {
  for (let i = 0; i < 14; i++) {
    const n = gen(rand);
    if (!used.has(n)) { used.add(n); return n; }
  }
  // pools exhausted for this shape — walk an ordinal until it cannot collide
  const base = gen(rand);
  for (let k = 2; ; k++) {
    const n = base + ' ' + roman(k);
    if (!used.has(n)) { used.add(n); return n; }
  }
}

const R1 = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
const R10 = ['', 'X', 'XX', 'XXX', 'XL', 'L', 'LX', 'LXX', 'LXXX', 'XC'];
const roman = (n) => (n >= 100 ? 'C'.repeat((n / 100) | 0) : '') + R10[((n / 10) | 0) % 10] + R1[n % 10];

// ---------------------------------------------------------------- weapons
// w: { element, archetype, perks:[{tag}] }
export function weaponName(w = {}, rand = Math.random) {
  const el = EL_PRE[w.element] ? w.element : 'kinetic';
  const pre = EL_PRE[el], suf = EL_SUF[el];
  const noun = at(AR_NOUN, w.archetype), adj = at(AR_ADJ, w.archetype);
  const tags = (w.perks || []).map((p) => p.tag).filter((t) => TAG_NOUN[t]);
  const tagNoun = tags.length ? TAG_NOUN[pick(tags, rand)] : null;

  return unique((r) => {
    // weights, not a flat 1-in-5. "X of <place>" fired 5 times in 26 rolls before; it is
    // now the rarest template, and the tag template only exists when there is a tag.
    const roll = r() * (tagNoun ? 1 : 0.86);
    if (roll < 0.26) return join(pick(pre, r), suf, r);                       // Emberfall
    if (roll < 0.50) return 'The ' + pick(adj, r) + ' ' + pick(noun, r);      // The Patient Vigil
    if (roll < 0.66) return pick(WHO, r) + '’s ' + pick(noun, r);        // Ysolde's Verdict
    if (roll < 0.78) return join(pick(pre, r), suf, r) + ' ' + pick(noun, r); // Sablewake Verdict
    if (roll < 0.86) return pick(noun, r) + ' of ' + pick(PLACE, r);          // Threnody of Kaltmere
    return r() < 0.5 ? 'The ' + tagNoun : pick(pre, r) + '’s ' + tagNoun; // The Amnesty
  }, rand);
}

// ---------------------------------------------------------------- armour
// Old rule was set.label + SLOT_LABEL[slot]: 25 names for the lifetime of the game. Now the
// dominant stat picks the epithet, so a piece's name tells you what it is built for.
const SLOT_NOUN = {
  head:  ['Helm', 'Crown', 'Mask'],
  arms:  ['Gauntlets', 'Grips', 'Bracers'],
  chest: ['Plate', 'Mantle', 'Harness'],
  legs:  ['Greaves', 'Striders', 'Boots'],
  cloak: ['Cloak', 'Shroud', 'Mantlewrap'],
};
const STAT_ADJ = {
  mobility:   ['Fleet', 'Longstride', 'Swift', 'Unhurried', 'Wind-cut'],
  resilience: ['Banked', 'Stalwart', 'Barrow', 'Unyielding', 'Deep-set'],
  recovery:   ['Mending', 'Clear', 'Quickening', 'Kindly', 'Second-breath'],
  discipline: ['Measured', 'Tempered', 'Kept', 'Patient', 'Sworn'],
  strength:   ['Heavy', 'Grasping', 'Ironhand', 'Bracing', 'Bull'],
};
const SET_WORD = {
  pilgrim:    ['Pilgrim', 'Wayfare', 'Roadworn'],
  emberward:  ['Emberward', 'Hearth', 'Coalkeep'],
  glasswright:['Glasswright', 'Facet', 'Paneglass'],
  chorus:     ['Chorus', 'Antiphon', 'Choirkeep'],
  wyrmsworn:  ['Wyrmsworn', 'Scalebound', 'Hoardward'],
};

export function armourName(slot, setKey, rand = Math.random, stats = null) {
  const nouns = SLOT_NOUN[slot] || SLOT_NOUN.chest;
  const setw = SET_WORD[setKey] || SET_WORD.pilgrim;
  // dominant stat = what the piece is actually for
  let dom = 'resilience', best = -1;
  for (const k in (stats || {})) if (stats[k] > best) { best = stats[k]; dom = k; }
  const adj = STAT_ADJ[dom] || STAT_ADJ.resilience;

  return unique((r) => {
    const noun = pick(nouns, r), s = pick(setw, r);
    const roll = r();
    if (roll < 0.40) return pick(adj, r) + ' ' + noun + ' of the ' + s;   // Fleet Greaves of the Pilgrim
    if (roll < 0.72) return s + ' ' + noun;                              // Emberward Plate
    return 'The ' + pick(adj, r) + ' ' + noun;                           // The Mending Cloak
  }, rand);
}

// One runnable check: names must never carry a concat artifact and must not repeat.
export function selfTest(n = 1200) {
  resetNames();
  const els = Object.keys(EL_PRE), arches = ['auto', 'handcannon', 'scout', 'beam'];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const nm = weaponName({ element: els[i % els.length], archetype: arches[i % 4], perks: [] });
    if (/(.)\1{2,}/.test(nm)) throw new Error('concat artifact: ' + nm);
    if (seen.has(nm)) throw new Error('duplicate in session: ' + nm);
    seen.add(nm);
  }
  return seen.size;
}
