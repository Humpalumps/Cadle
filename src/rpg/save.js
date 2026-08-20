// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Aetherfall via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: rpg agent. Versioned localStorage persistence. Never throws, never blocks boot.
const KEY = 'aetherfall.save';
// v2: the quest chain gained a step and binds landmarks by id, and rolled weapons now carry
// archetype ids from combat's armoury. A v1 payload would resume mid-chain on the wrong step
// holding guns that do not exist, so v1 is deliberately not migrated — read() starts fresh.
export const VERSION = 1;

export function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return null;
    if (d.v !== VERSION) { console.info('[rpg] save v' + d.v + ' is not v' + VERSION + ', starting fresh'); return null; }
    return d;
  } catch (e) {
    console.warn('[rpg] unreadable save, starting fresh:', e && e.message);
    try { localStorage.removeItem(KEY); } catch (e2) {}
    return null;
  }
}

export function write(payload) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, t: Date.now(), ...payload }));
    return true;
  } catch (e) {
    return false; // quota / private mode / no storage. Playing without a save is fine.
  }
}

export function wipe() { try { localStorage.removeItem(KEY); return true; } catch (e) { return false; } }
