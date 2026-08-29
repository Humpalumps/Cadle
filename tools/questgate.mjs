// questgate.mjs — GAME MECHANICS GATE, part 2 of 2. `node tools/questgate.mjs [--url http://...]`
// Drives the running game through window.__game and asserts that the loops actually close:
// ammo comes back, every objective type ticks, a quest turns in and pays.
//
// tools/curvecheck.mjs is the cheap half (pure node, no GPU, validates the numbers and the content).
// This is the expensive half: it needs the dev server, because the only way to know a quest completes
// is to complete one.
//
// SCOPE, deliberately: one pass per objective TYPE, not per quest. Fifty-five passes would take an
// hour and tell you nothing curvecheck did not already prove — content correctness is curvecheck's
// job, and this is the engine's.
//
// TWO RULES THAT ARE NOT NEGOTIABLE, both learned the hard way (HANDOVER §5.5):
//   1. NEVER let an evaluate() return a live game object. `lineup()` returns Enemy instances and
//      Playwright dutifully serialised the entire Three.js graph back over CDP — 6.5 s of wall time,
//      page cpu ~20 ms, GPU idle, which looked exactly like a monstrous driver stall for a week.
//      ev() below wraps every call so the page hands back a scalar. Add tests through ev(), not
//      through raw page.evaluate.
//   2. A failure here is a real failure, but a TIMEOUT may not be. Orphaned chrome-headless-shell
//      processes starve the GPU (HANDOVER §4b). If this errors rather than fails, check for orphans
//      before you believe it.
import { chromium } from 'playwright';
import { gameUrl } from './gameurl.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = gameUrl(arg('--url', process.env.CADLE_URL)).replace(/\/$/, '');
const URL = BASE + '/?auto=1&q=low&seed=1337';

let failed = false;
const fail = (m) => { console.error('  FAIL: ' + m); failed = true; };
const ok = (m) => console.log('  ok:   ' + m);

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => fail('page error: ' + e.message));

/** Evaluate in the page and return ONLY a scalar/plain-JSON value. See rule 1 above. */
const ev = async (fn, arg) => page.evaluate(
  ([src, a]) => { const r = (0, eval)('(' + src + ')')(a); return r === undefined ? null : JSON.parse(JSON.stringify(r)); },
  [fn.toString(), arg ?? null],
);
const wait = (ms) => page.waitForTimeout(ms);

try {
  console.log('[questgate] booting ' + URL);
  await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => !!window.__game, { timeout: 60000 });
  await page.evaluate(() => window.__game?.intro?.skip?.());
  // Boot is 13-17 s on a production build and the harness boot wait exists for that reason.
  await page.waitForFunction(() => !!window.__game?.game?.rpg && !!window.__game.state, { timeout: 180000 });
  // The weapon slots are built inside Weapons.init(); a flat sleep raced it and the drain step
  // then "passed" against an empty array. Wait for the thing being tested to actually exist.
  await page.waitForFunction(() => (window.__game?.ammo?.() || []).length >= 2, { timeout: 120000 });
  await wait(2000);
  const errs = await ev(() => (window.__game.errors || []).length);
  if (errs) fail(`${errs} uncaught page error(s) during boot: ` + JSON.stringify(await ev(() => (window.__game.errors || []).slice(0, 3))));
  ok('booted');

  await ev(() => { window.__game.god(true); window.__game.passive?.(false); });

  // ---------------------------------------------------------------- 1. AMMO: the dry-guard
  // This is the test the whole exercise exists for. "Guns are just wasted once they run out" was the
  // complaint; the contract is that running dry is a lull, never a dead end.
  console.log('\n1. ammo');
  {
    const before = await ev(() => { window.__game.drain(); return window.__game.ammo(); });
    if (!before.length) fail('__game.ammo() returned no slots — the weapons system is not up, so nothing below means anything');
    else if (before.some((s) => s.ammo || s.reserve)) fail('could not drain the weapons for the test: ' + JSON.stringify(before));
    else ok('both slots drained: ' + before.map((s) => `${s.id} 0/0`).join(', '));

    // kill three mobs on top of the player so the bricks land inside pickup range
    for (let i = 0; i < 3; i++) {
      await ev(() => {
        const g = window.__game, p = g.game.player.position;
        g.spawn('hound', p.x + 2.5, p.z + 0.5, { level: 3 });
        return 1;
      });
      await wait(350);
      await ev(() => { window.__game.killAll(); return 1; });
      await wait(900);
      // stand on the drop
      await ev(() => { const p = window.__game.game.player.position; window.__game.teleport(p.x + 2.5, null, p.z + 0.5); return 1; });
      await wait(700);
    }
    await wait(600);

    const after = await ev(() => window.__game.ammo());
    const got = after.reduce((a, s) => a + s.reserve + s.ammo, 0);
    if (got <= 0) fail('DRY-GUARD BROKEN: three kills after running completely dry produced no ammo at all — ' + JSON.stringify(after) + '. This is the exact complaint the ammo system exists to fix.');
    else ok('ammo returned after running dry: ' + after.map((s) => `${s.id} ${s.ammo}/${s.reserve}`).join(', '));

    // A RESCUE IS NOT A REFILL. This is the assertion that caught the real bug: the dry-guard fired
    // once per corpse, every brick landed at the player's feet and auto-collected, so clearing one
    // camp took both reserves from 0 to maximum. "You can never be stranded" must not become
    // "running dry is free ammo". Anything at or near full after a handful of kills is that bug.
    for (const s of after) {
      if (s.reserve > (s.maxReserve ?? 1e9)) fail(`${s.id}: a brick pushed the reserve past maxReserve`);
      else if (s.reserve >= (s.maxReserve ?? 1e9) * 0.9) fail(`${s.id}: reserve went to ${s.reserve}/${s.maxReserve} off a few kills — that is an ammo faucet, not a rescue`);
    }
    // The gun you are holding must be usable again, not still clicking empty.
    const held = after[0];
    if (held && held.reserve > 0 && held.ammo <= 0) fail(`${held.id}: picked ammo up with an empty magazine and did not reload — the gun still clicks`);
  }

  // ---------------------------------------------------------------- 1b. EQUIPPING MUST NOT EAT A GUN
  // The RPG modelled ONE weapon while the game has TWO live slots, and progression.equip() routed a
  // weapon through weapons.give(id) whose `slot` DEFAULTS to the held index. So equipping anything from
  // the inventory silently destroyed whichever gun happened to be in your hands - no warning, no undo,
  // and the UI could not even express the loss. It survived because every test equipped into an EMPTY
  // slot. This asserts the case that actually broke: equip with NO slot argument while holding a gun,
  // and require the OTHER gun to come through untouched, same archetype and same reserve.
  console.log('');
  console.log('1b. loadout');
  {
    const before = await ev(() => {
      const g = window.__game, R = g.game.rpg;
      g.give('autorifle', 1); g.swap(1);
      const eq = R.ctx && R.ctx.rpg && R.ctx.rpg.equipped ? R.ctx.rpg.equipped : {};
      return { held: g.game.player.weapons.index, slots: g.ammo(), hasTwo: 'weaponB' in eq };
    });
    if (!before.hasTwo) fail('ctx.rpg.equipped has no weaponB - the RPG models one weapon while the game has two, so equipping can silently destroy the gun in your hands');
    else {
      const after = await ev(() => {
        const g = window.__game, R = g.game.rpg;
        const it = R.ctx.rpg.rollItem ? R.ctx.rpg.rollItem('rare', { kind: 'weapon', archetype: 'sniper' }) : null;
        if (!it) return { skipped: true };
        R.equip(it);
        return { skipped: false, slots: g.ammo(), held: g.game.player.weapons.index };
      });
      if (after.skipped) fail('ctx.rpg.rollItem is unavailable, so the gun-eating path cannot be exercised');
      else {
        const k = before.held, b = before.slots[k], a = after.slots[k];
        if (!b || !a) fail('could not read the held weapon slot before/after');
        else if (a.archetype !== b.archetype) fail(`equipping with no slot argument REPLACED the gun in your hands (${b.archetype} -> ${a.archetype}) - it must fill the empty slot or the weaker one, never the held one`);
        else if (a.reserve !== b.reserve) fail(`the held gun survived but its reserve changed ${b.reserve} -> ${a.reserve} - give() is resetting ammo on an unrelated swap`);
        else ok(`equipping with no slot left the held gun intact: ${a.archetype} ${a.ammo}/${a.reserve}`);
      }
    }
  }

  // ---------------------------------------------------------------- 2. QUESTS: the engine surface
  console.log('\n2. quest engine');
  const hasQuests = await ev(() => !!(window.__game.quest && window.__game.quest.state));
  if (!hasQuests) fail('window.__game.quest.state() is not exposed — the quest engine cannot be tested');
  else {
    const st = await ev(() => window.__game.quest.state());
    if (typeof st !== 'object' || st === null) fail('quest.state() did not return a plain object');
    else ok('quest.state() returns a plain object: ' + JSON.stringify(st).slice(0, 160));

    const catalogue = await ev(() => {
      const q = window.__game.quest;
      const all = q.all ? q.all() : null;
      if (!Array.isArray(all)) return null;
      // one representative quest per objective type, as ids only (scalars!)
      const pick = {};
      for (const x of all) for (const t of (x.types || [])) if (!pick[t]) pick[t] = x.id;
      return pick;
    });
    if (!catalogue) fail('window.__game.quest.all() is not exposed (must return plain {id, types[]} records) — cannot pick one quest per objective type');
    else {
      console.log('        representatives: ' + JSON.stringify(catalogue));
      for (const type of ['kill', 'collect', 'slay', 'reach', 'escort']) {
        const id = catalogue[type];
        if (!id) { fail(`no quest exposes a "${type}" objective — all five types must be reachable`); continue; }
        const r = await runObjective(id, type);
        if (r.ok) ok(`${type}: ${id} accepted, ticked and turned in (+${r.xp} xp)`);
        else fail(`${type}: ${id} — ${r.why}`);
      }
    }
  }

  // ---------------------------------------------------------------- 3. no leak, no error
  console.log('\n3. hygiene');
  {
    const errs = await ev(() => (window.__game.errors || []).slice(0, 5));
    if (errs.length) fail('uncaught page errors during the run: ' + JSON.stringify(errs));
    else ok('no uncaught page errors');
    const m0 = await ev(() => window.__game.stats().memMB);
    await wait(12000);
    const m1 = await ev(() => window.__game.stats().memMB);
    // Quest state, listeners and drop records are all new long-lived allocations; 55 quests with
    // per-quest event subscriptions is the leak this catches.
    if (m1 - m0 > 40) fail(`memMB grew ${(m1 - m0).toFixed(1)} MB in 12 s idle (${m0} -> ${m1}) — check for per-quest event subscriptions`);
    else ok(`memMB stable: ${m0} -> ${m1}`);
  }
} catch (e) {
  fail('errored: ' + e.message + '\n        (a TIMEOUT here may be GPU contention, not the game — check for orphaned chrome-headless-shell first, HANDOVER §4b)');
} finally {
  await browser.close().catch(() => {});
}

/**
 * Accept a quest, force-satisfy every objective through the engine's own progress path, assert the
 * tracker ticked, turn it in, assert the reward landed. Force-satisfying is deliberate: this proves
 * the ENGINE closes the loop. Whether a frostwolf can be found in the tundra is curvecheck's job.
 */
async function runObjective(id, type) {
  const start = await ev((qid) => {
    const g = window.__game;
    g.quest.abandon?.(qid);
    const okAccept = g.quest.accept(qid);
    const s = g.quest.state();
    return { okAccept: !!okAccept, xp: g.game.rpg?.ctx?.rpg?.xp ?? 0, level: g.game.rpg?.ctx?.rpg?.level ?? 0, active: (s.active || []).length };
  }, id);
  if (!start.okAccept) return { ok: false, why: 'accept() returned false' };
  if (!start.active) return { ok: false, why: 'accepted but state().active is empty' };

  const ticked = await ev((qid) => {
    const g = window.__game;
    if (!g.quest.debugTick) return null;
    g.quest.debugTick(qid);                       // advance every objective by one step
    const q = (g.quest.state().active || []).find((x) => x.id === qid);
    return q ? q.objectives.map((o) => ({ have: o.have, need: o.need })) : null;
  }, id);
  if (ticked === null) return { ok: false, why: 'quest.debugTick(id) is not exposed — an objective cannot be advanced without playing the whole quest' };
  if (!ticked.some((o) => o.have > 0)) return { ok: false, why: 'debugTick advanced nothing: ' + JSON.stringify(ticked) };

  const done = await ev((qid) => {
    const g = window.__game;
    g.quest.complete(qid);
    const s = g.quest.state();
    return {
      stillActive: (s.active || []).some((x) => x.id === qid),
      completed: (s.completed || []).includes(qid),
      xp: g.game.rpg?.ctx?.rpg?.xp ?? 0, level: g.game.rpg?.ctx?.rpg?.level ?? 0,
    };
  }, id);
  if (done.stillActive) return { ok: false, why: 'complete() left the quest active' };
  if (!done.completed) return { ok: false, why: 'complete() did not record the quest as completed' };
  // xp resets on level-up, so a level change also counts as "the reward landed"
  const paid = done.level > start.level || done.xp > start.xp;
  if (!paid) return { ok: false, why: 'completed but no xp was awarded' };
  return { ok: true, xp: done.level > start.level ? '(level up)' : done.xp - start.xp };
}

console.log('\n' + (failed ? '[questgate] ==== FAILED ====' : '[questgate] all OK'));
process.exit(failed ? 1 : 0);
