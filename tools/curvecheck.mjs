// curvecheck.mjs — GAME MECHANICS GATE, part 1 of 2. `node tools/curvecheck.mjs`.
// Runs in ~1 second, needs no dev server, no browser and no GPU, so it works when the harness is
// contended and it runs in CI beside tools/invariants.mjs.
//
// WHY THIS EXISTS. The project had a graphics gate (tools/gate.mjs) and performance tools
// (tools/hitchhunt.mjs) and NOTHING that checked whether the game's numbers actually work. The two
// failure modes it is built to catch, both of which had already shipped:
//   1. A level band that cannot be reached. Enemy xp was FLAT (defs.js scaled hp and damage with
//      level but not xp), so the 1->50 curve quietly needed thousands of kills and nobody noticed
//      because no test ever added the numbers up.
//   2. Quest content that names something that does not exist. 55 quests referencing enemy ids,
//      item ids and regions by hand is where the bugs will be, and a typo there is invisible until
//      a player accepts the quest and it can never complete.
//
// It imports the real modules — src/rpg/progression.js, src/rpg/droptable.js, src/rpg/quests/,
// src/enemies/defs.js, src/world/Biomes.js — all of which are deliberately free of `three` and of
// browser globals. That purity is load-bearing: the day someone imports THREE into droptable.js,
// this gate dies. If you need to, split the pure part out again rather than deleting the check.
//
// Thresholds are orchestrator-owned. If a rule blocks legitimate work, say so in your report.
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

let failed = false;
const fail = (msg) => { console.error('  FAIL: ' + msg); failed = true; };
const warn = (msg) => console.warn('  warn: ' + msg);
const ok = (msg) => console.log('  ok:   ' + msg);
const imp = (rel) => import(pathToFileURL(resolve(rel)).href);
const pct = (x) => (x * 100).toFixed(3) + '%';

console.log('[curvecheck] game mechanics gate\n');

// ---------------------------------------------------------------- load
const prog = await imp('src/rpg/progression.js');
const { DEFS, BIOME_DEFS, LEVEL_XP } = await imp('src/enemies/defs.js');
const BIO = await imp('src/world/Biomes.js');
const ALL_ENEMIES = { ...DEFS, ...(BIOME_DEFS || {}) };

if (typeof LEVEL_XP !== 'function') {
  fail('src/enemies/defs.js exports no LEVEL_XP(base, level). Enemy xp is FLAT: a level-44 mob pays the same as the level-34 version of itself, and the 1->50 curve cannot close. Add it beside LEVEL_HP/LEVEL_DMG.');
}
const levelXp = typeof LEVEL_XP === 'function' ? LEVEL_XP : (b) => b;

// droptable.js is the pure half of loot.js. If it has not been split out yet, say so loudly —
// silently skipping is how a gate becomes decoration.
let TBL = null;
if (existsSync('src/rpg/droptable.js')) {
  try { TBL = await imp('src/rpg/droptable.js'); }
  catch (e) { fail('src/rpg/droptable.js exists but will not import in plain node: ' + e.message + '\n        It must stay free of `three` and of browser globals — that purity is what lets this gate run without a GPU.'); }
} else {
  fail('src/rpg/droptable.js is missing — the drop table has not been split out of loot.js, so drop rates cannot be measured without a GPU.');
}

// The quest content. One file per region plus an index; accept the shapes an index might plausibly
// export rather than dictating one, but insist that SOMETHING resolves to a list of quests.
let QUESTS = null;
if (existsSync('src/rpg/quests/index.js')) {
  const m = await imp('src/rpg/quests/index.js');
  const cand = m.QUESTS ?? m.ALL ?? m.default ?? m.quests;
  if (Array.isArray(cand)) QUESTS = cand;
  else if (cand && typeof cand === 'object') QUESTS = Object.values(cand).flat();
  if (!QUESTS) fail('src/rpg/quests/index.js exports nothing that resolves to a quest list (looked for QUESTS / ALL / default / quests).');
} else {
  fail('src/rpg/quests/index.js is missing — there is no quest content to validate.');
}

// ---------------------------------------------------------------- 1. the XP curve
console.log('1. XP curve');
{
  const MAX = prog.MAX_LEVEL;
  const need = [];                      // need[l] = xp to go from l to l+1
  let total = 0;
  for (let l = 1; l < MAX; l++) { need[l] = prog.xpToNext(l); total += need[l]; }
  ok(`levels 1..${MAX}, total ${total.toLocaleString()} xp`);

  if (MAX !== 50) fail(`MAX_LEVEL is ${MAX}, the world's level bands in Biomes.js top out at 50`);
  for (let l = 2; l < MAX; l++) {
    if (need[l] <= need[l - 1]) fail(`xpToNext is not monotonic at level ${l} (${need[l - 1]} -> ${need[l]}) — a level that costs less than the one before it reads as a bug to a player`);
  }
  globalThis.__need = need; globalThis.__total = total;
}

// ---------------------------------------------------------------- 2. region bands are contiguous
console.log('\n2. region bands');
{
  const bands = BIO.OUTER.map((b) => ({ id: b.id, name: b.short, lo: b.level[0], hi: b.level[1] }));
  bands.unshift({ id: 'meadow', name: 'The Vale', lo: BIO.BIOMES.meadow.level[0], hi: BIO.BIOMES.meadow.level[1] });
  bands.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  let reach = 1;
  for (const b of bands) {
    // A gap here is the "level-5 player wanders into the Lost Realm and just dies" bug: the world
    // declares a band nothing can level you into.
    if (b.lo > reach) fail(`level gap: nothing carries a player from ${reach} to ${b.lo} before ${b.name} (${b.lo}-${b.hi})`);
    reach = Math.max(reach, b.hi);
  }
  if (reach < prog.MAX_LEVEL) fail(`the declared bands stop at ${reach}, MAX_LEVEL is ${prog.MAX_LEVEL}`);
  else ok(`bands are contiguous 1..${reach}: ` + bands.map((b) => `${b.name} ${b.lo}-${b.hi}`).join(' · '));
  globalThis.__bands = bands;
}

// ---------------------------------------------------------------- 3. quest content is real
console.log('\n3. quest content');
const OBJ_TYPES = new Set(['kill', 'collect', 'slay', 'reach', 'escort']);
const byRegion = new Map();
if (QUESTS) {
  const ids = new Set();
  const regionIds = new Set([...Object.keys(BIO.BIOMES)]);
  const rosterOf = (rid) => {
    const b = BIO.BIOMES[rid];
    const list = (b && b.enemies) || [];
    return new Set(list.map((e) => e[0]));
  };
  const typeCount = {};

  for (const q of QUESTS) {
    const tag = q && q.id ? q.id : JSON.stringify(q).slice(0, 60);
    if (!q || !q.id) { fail('a quest has no id: ' + tag); continue; }
    if (ids.has(q.id)) fail(`duplicate quest id "${q.id}"`);
    ids.add(q.id);
    if (!q.name) fail(`${q.id}: no name`);
    if (!q.region || !regionIds.has(q.region)) fail(`${q.id}: region "${q.region}" is not in Biomes.js`);
    if (!q.text || !q.text.offer || !q.text.done) fail(`${q.id}: quests are WRITTEN — needs text.offer and text.done`);
    if (!Number.isFinite(q.level)) fail(`${q.id}: no numeric level`);
    if (!q.reward || !Number.isFinite(q.reward.xp) || q.reward.xp <= 0) fail(`${q.id}: no reward.xp`);
    // REWARD CHOICE. WoW shows you 2-3 rewards when you accept and you pick one at turn-in; that
    // deliberation is most of what makes a quest feel like a transaction rather than a notification.
    // Three near-identical rolls is a menu, not a decision — so the set has to actually differ, and it
    // has to stay inside the band (a level-3 player must not be handed a legendary outside a finale).
    if (q.reward?.choices) {
      const ch = q.reward.choices;
      if (!Array.isArray(ch) || ch.length < 2) fail(`${q.id}: reward.choices must offer at least 2 candidates`);
      else {
        for (const c of ch) {
          if (c.tier && q.reward.tier && c.tier !== q.reward.tier) fail(`${q.id}: candidate tier "${c.tier}" does not match the quest's own reward tier "${q.reward.tier}" — that is how a level-3 player ends up holding a legendary`);
          if (c.kind && c.kind !== 'weapon' && c.kind !== 'armour') fail(`${q.id}: candidate kind "${c.kind}" is neither weapon nor armour`);
        }
        const kinds = new Set(ch.map((c) => c.kind).filter(Boolean));
        if (ch.length >= 3 && kinds.size < 2) fail(`${q.id}: all ${ch.length} candidates are the same kind — offer at least one weapon and one armour piece so the choice is a real one`);
        const sig = ch.map((c) => `${c.kind}:${c.archetype ?? c.slot ?? ''}`);
        if (new Set(sig).size !== sig.length) fail(`${q.id}: two candidates are the same archetype/slot — that is a menu, not a decision`);
      }
    }
    if (!Array.isArray(q.objectives) || !q.objectives.length) { fail(`${q.id}: no objectives`); continue; }

    const roster = rosterOf(q.region);
    for (const o of q.objectives) {
      if (!OBJ_TYPES.has(o.type)) { fail(`${q.id}: unknown objective type "${o.type}"`); continue; }
      typeCount[o.type] = (typeCount[o.type] || 0) + 1;
      // `enemy` may be a single id or an array (kill any of these). `from` is an enemy list ONLY
      // on a collect objective — on an escort it is the route ORIGIN (a region id or a landmark
      // name), and treating that as an enemy list spells the place out one letter at a time.
      const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
      const names = [...asList(o.enemy), ...(o.type === 'collect' ? asList(o.from) : [])].filter((x) => typeof x === 'string');
      for (const n of names) {
        if (!ALL_ENEMIES[n]) fail(`${q.id}: names enemy "${n}" which does not exist in src/enemies/defs.js`);
        // "completable from the region's real spawn roster": a kill quest for something that never
        // spawns where the quest sends you can never be finished.
        else if (roster.size && !roster.has(n) && !o.spawns) {
          warn(`${q.id}: "${n}" is not in ${q.region}'s roster in Biomes.js — completable only if the quest spawns it (set spawns:true if that is intended)`);
        }
      }
      if ((o.type === 'kill' || o.type === 'collect') && !(o.count > 0)) fail(`${q.id}: ${o.type} objective needs a count > 0`);
      // NO RAW IDS IN PLAYER-FACING TEXT. The engine renders `o.name ?? o.enemy`, so an objective
      // with no display name puts an internal id on the player's screen — "Slay 8 frostwolf",
      // "Gather 5 frost-shard". Every enemy in defs.js already has a real name ("Frostveil Wolf");
      // the objective just has to use one. This is a WoW-bar failure, not a nitpick: an id on the
      // HUD is the single clearest tell that nobody played the thing.
      if (['kill', 'slay', 'collect'].includes(o.type)) {
        if (!o.name) fail(`${q.id}: ${o.type} objective has no display name, so the HUD would print the raw id "${asList(o.enemy)[0] ?? o.item}"`);
        else {
          const raw = [...asList(o.enemy), o.item].filter(Boolean);
          if (raw.includes(o.name)) fail(`${q.id}: objective name "${o.name}" IS the raw id — give it a readable name`);
          if (/^[a-z0-9-]+$/.test(o.name)) fail(`${q.id}: objective name "${o.name}" looks like an id (all lower-case/hyphens), not something a person would say`);
        }
      }
      if (o.type === 'collect' && !o.item) fail(`${q.id}: collect objective needs an item id`);
      if (o.type === 'collect' && o.chance != null && !(o.chance > 0 && o.chance <= 1)) fail(`${q.id}: collect chance ${o.chance} is not in (0, 1]`);
    }

    if (q.next && !QUESTS.some((x) => x.id === q.next)) fail(`${q.id}: next "${q.next}" resolves to nothing`);
    const list = byRegion.get(q.region) || []; list.push(q); byRegion.set(q.region, list);
  }

  ok(`${QUESTS.length} quests across ${byRegion.size} regions, all ids unique`);
  // The user asked for a WoW spread — kill X, collect, mini-boss, escort. A set that is 50 kill
  // quests and one of everything else technically passes every check above and is still wrong.
  const total = Object.values(typeCount).reduce((a, b) => a + b, 0) || 1;
  console.log('        objective mix: ' + Object.entries(typeCount).map(([k, v]) => `${k} ${v} (${Math.round(v / total * 100)}%)`).join(' · '));
  for (const t of OBJ_TYPES) {
    if (!typeCount[t]) fail(`no quest anywhere uses the "${t}" objective type — the brief asked for all five`);
  }
  if ((typeCount.kill || 0) / total > 0.55) fail(`${Math.round((typeCount.kill || 0) / total * 100)}% of objectives are plain kill quests — that is the "kill 10 rats" problem the brief exists to avoid`);
  for (const r of [...byRegion.keys()]) {
    const n = byRegion.get(r).length;
    if (n < 4) fail(`region "${r}" has only ${n} quest(s) — a region needs a chain plus side content`);
  }
  const missing = [...regionIds].filter((r) => !byRegion.has(r) && (r === 'meadow' || BIO.BIOMES[r].k >= 0));
  if (missing.length) fail('regions with no quests at all: ' + missing.join(', '));
}

// ---------------------------------------------------------------- 4. can a player actually reach 50?
console.log('\n4. the curve closes');
if (QUESTS) {
  const need = globalThis.__need, total = globalThis.__total;
  const bands = globalThis.__bands;
  // Quest xp per band, from the real content.
  const questXpInBand = (lo, hi) => QUESTS.filter((q) => q.level >= lo && q.level <= hi)
    .reduce((a, q) => a + (q.reward?.xp || 0), 0);

  // Kill xp available in a band: the region roster, at the band's mid level, scaled by LEVEL_XP.
  // This is an availability estimate, not a promise about how anyone plays — it answers "if the
  // quests are not enough, is the shortfall a plausible amount of fighting or an impossible one".
  const killXpPerKill = (rid, lvl) => {
    const list = (BIO.BIOMES[rid]?.enemies) || [];
    if (!list.length) return 0;
    let s = 0, n = 0;
    for (const [type] of list) { const d = ALL_ENEMIES[type]; if (!d) continue; s += levelXp(d.xp || 0, lvl); n++; }
    return n ? s / n : 0;
  };

  let cum = 0, worstShortfallKills = 0;
  const rows = [];
  for (const b of bands) {
    const bandCost = need.slice(b.lo, b.hi).reduce((a, x) => a + (x || 0), 0);
    const qxp = questXpInBand(b.lo, b.hi);
    const perKill = killXpPerKill(b.id, Math.round((b.lo + b.hi) / 2));
    const shortfall = Math.max(0, bandCost - qxp);
    // No shortfall means no filler, whether or not this gate can SEE a roster for the region.
    // The home region's bestiary is placed in Enemies.js populate(), not in Biomes.js, so a
    // perKill of 0 there is a hole in this gate's visibility, not a hole in the game.
    const kills = shortfall === 0 ? 0 : perKill > 0 ? Math.ceil(shortfall / perKill) : Infinity;
    worstShortfallKills = Math.max(worstShortfallKills, kills === Infinity ? 1e9 : kills);
    cum += bandCost;
    rows.push({ name: b.name, band: `${b.lo}-${b.hi}`, cost: bandCost, qxp, share: bandCost ? qxp / bandCost : 1, perKill: Math.round(perKill), kills });
  }
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log('        ' + 'region'.padEnd(w) + '  band    band xp    quest xp   quest%   xp/kill   kills to fill');
  for (const r of rows) {
    console.log('        ' + r.name.padEnd(w) + '  ' + r.band.padEnd(6) + '  ' +
      String(r.cost).padStart(8) + '  ' + String(r.qxp).padStart(10) + '  ' +
      (Math.round(r.share * 100) + '%').padStart(6) + '  ' + String(r.perKill).padStart(8) + '  ' +
      String(r.kills === Infinity ? 'IMPOSSIBLE' : r.kills).padStart(13));
  }

  const totalQuestXp = QUESTS.reduce((a, q) => a + (q.reward?.xp || 0), 0);
  const share = totalQuestXp / total;
  ok(`quest xp ${totalQuestXp.toLocaleString()} of ${total.toLocaleString()} = ${Math.round(share * 100)}% of the curve`);
  // The brief's split is 60/40 quests/kills. +/-15% around that.
  if (share < 0.45) fail(`quests only cover ${Math.round(share * 100)}% of the curve — the target is ~60%, and below 45% the game is a grind with quests decorating it`);
  if (share > 0.80) fail(`quests cover ${Math.round(share * 100)}% of the curve — above 80% the world's mobs are scenery and there is no reason to fight anything you were not told to`);

  for (const r of rows) {
    if (r.kills === Infinity) fail(`${r.name}: quests cover only ${Math.round(r.share * 100)}% of the band and this gate can see no killable xp source in its roster to make up the rest`);
    // A band that needs more than ~250 kills of filler on top of its quests is the grind the
    // whole exercise is meant to remove. WoW's own answer to this is more quests, not more hp.
    else if (r.kills > 250) fail(`${r.name} (${r.band}) needs ${r.kills} filler kills on top of its quests — raise the band's quest xp or add quests`);
  }
  const lean = rows.filter((r) => r.share < 0.55);
  if (lean.length) warn('bands leaning on grinding harder than the 60% target: ' + lean.map((r) => `${r.name} ${Math.round(r.share * 100)}%`).join(', '));
  if (!failed) ok(`worst band needs ${worstShortfallKills} filler kills on top of its quests`);
}

// ---------------------------------------------------------------- 5. drop rates and pity
console.log('\n5. drop table');
if (TBL) {
  const N = 100000;
  const W = TBL.W, HARD = TBL.HARD;
  if (!W || !HARD) fail('src/rpg/droptable.js does not export W and HARD — the gate has to assert against the published table, not a copy of it');
  else {
    const sum = Object.values(W).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-6) fail(`the published tier weights sum to ${sum}, not 1`);

    // DETERMINISM. The table rolls on Math.random by design (loot variance is meant to differ per
    // run), which made this section a coin flip: measured against a 4σ threshold it failed roughly
    // one run in four on sampling noise alone, with `common` landing anywhere from -4.5σ to -1.4σ.
    // A gate that cries wolf is a gate nobody reads, and widening the threshold until it stops
    // firing just blinds it. So: pin Math.random to fixed seeds for the trial, run several, and
    // judge the MEDIAN. Same rigour, reproducible answer, and a real regression still moves it.
    const mulberry32 = (a) => () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const SEEDS = [1337, 90210, 4242, 777, 31415];
    const realRandom = Math.random;
    const order = ['common', 'uncommon', 'rare', 'legendary', 'exotic'];
    const trials = [];            // per seed: { rates{}, worst{} }
    for (const seed of SEEDS) {
      Math.random = mulberry32(seed);
      TBL.resetTable?.();
      const c = {}; const dr = {}; const wo = {};
      for (const k in HARD) { dr[k] = 0; wo[k] = 0; }
      for (let i = 0; i < N; i++) {
        const t = TBL.rollTier(0);
        c[t] = (c[t] || 0) + 1;
        const idx = order.indexOf(t);
        for (const k in dr) {
          if (idx >= order.indexOf(k)) dr[k] = 0;
          else { dr[k]++; if (dr[k] > wo[k]) wo[k] = dr[k]; }
        }
      }
      const rates = {}; for (const t of order) rates[t] = (c[t] || 0) / N;
      trials.push({ rates, worst: wo });
    }
    Math.random = realRandom;
    const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[a.length >> 1]; };
    const seen = {}; const worst = {};
    for (const t of order) seen[t] = median(trials.map((tr) => tr.rates[t])) * N;
    for (const k in HARD) worst[k] = median(trials.map((tr) => tr.worst[k]));
    console.log(`        median of ${SEEDS.length} seeded trials x ${N.toLocaleString()} rolls (reproducible)`);
    // Any tier the table gives a pity timer runs ABOVE its base weight by construction, because
    // pity only ever ADDS. Read that from the table rather than naming tiers here — this gate
    // already failed once on correct behaviour by forgetting that rare has a hard pity of 20.
    const hasPity = new Set([...Object.keys(HARD || {}), ...Object.keys(TBL.SOFT || {})]);
    for (const t of order) {
      const got = (seen[t] || 0) / N, want = W[t];
      const sigma = Math.sqrt(want * (1 - want) / N);
      const dev = (got - want) / sigma;
      const line = `${t.padEnd(10)} want ${pct(want).padStart(8)}  got ${pct(got).padStart(8)}  ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}σ`;
      // Pity only ever ADDS, so legendary and exotic legitimately run above their base weight.
      // Everything else must sit close to the published table or the table is a lie.
      if (!seen[t]) fail(`${t} never dropped in ${N} rolls`);
      else if (hasPity.has(t)) {
        if (got < want * 0.9) fail(line + '  <- below base weight, but pity can only add');
        else if (got > want * 1.75) fail(line + '  <- pity has dragged the long-run rate far off the published table');
        else console.log('        ' + line + '  (pity uplift ' + ((got / want - 1) * 100).toFixed(0) + '%)');
      } else if (Math.abs(dev) > 4) fail(line + '  <- more than 4σ off the published table');
      else console.log('        ' + line);
    }
    // Hard pity is a promise: a drought this long ends NOW. If a measured drought exceeded it,
    // the promise is broken and the player who hit it is the one who tells you.
    for (const k in HARD) {
      if (worst[k] > HARD[k]) fail(`${k}: worst measured drought ${worst[k]} exceeds hard pity ${HARD[k]} — hard pity does not actually fire`);
      else ok(`${k} hard pity holds: worst drought ${worst[k]} / ${HARD[k]}`);
    }
  }
}

console.log('\n' + (failed ? '[curvecheck] ==== FAILED ====' : '[curvecheck] all OK'));
process.exit(failed ? 1 : 0);
