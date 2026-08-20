// The opening quest: "The Sundered Spire" — three beats, voiced by the Vale.
//   0 wake   : aetheryte flares, the Vale speaks, tracker points east
//   1 arrive : within 70 m of the ruins — the Vale names the wound
//   2 clear  : 4 kills at the camp — a guaranteed legendary weapon drops as the reward
//   3 claim  : pick it up — quest complete, xp, the Vale signs off
//
// VOICE CONSISTENCY CONTRACT (binding on every future line): each speaking character is pinned to
// ONE voice in ASSETS.md ("Voice cast"). Every line for that character is generated with the SAME
// voice id, model and settings, in one batch where possible. A character's voice never changes
// between lines, sessions, or regenerations — regenerate the whole character or nothing.
// Audio files land in /assets/voice/ (registered in core/Assets.js); until they exist the quest
// plays subtitle-only, so the flow is fully testable before a single credit is spent.
const RUINS = { x: 140, z: 60, r: 70 };
const AETHERYTE = { x: 0, z: -28 };
const KILLS_NEEDED = 4;
const SAVE_KEY = 'cadle.quest';
const PORTRAIT = '/assets/tex/vale_portrait.jpg';
import { setWaypoint, clearWaypoint } from '../ui/mapscreen.js';

// speaker: 'vale' — the narrator. Subtitle prefix + audio name prefix stay in lockstep.
const LINES = [
  { id: 'voice-vale-01', text: 'Wake, Wayfarer. The Vale remembers you — even if the world does not.' },
  { id: 'voice-vale-02', text: 'The Sundered Spire. Aether bleeds where the stone was broken — and something feeds on the wound.' },
  { id: 'voice-vale-03', text: 'The wound breathes easier. Take up the arm the Spire kept for you — you have earned its name.' },
  { id: 'voice-vale-04', text: 'So armed, so named. Walk the Vale, Wayfarer — it has more to remember.' },
];

export class OpeningQuest {
  constructor(game, rpg) {
    this.game = game; this.rpg = rpg;
    this.beat = -1; this.kills = 0; this._t0 = -1; this._said = -1;
    try { const d = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); if (d && d.beat >= 0) { this.beat = d.beat; this.kills = d.kills | 0; } } catch (e) {}
  }

  _save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ beat: this.beat, kills: this.kills })); } catch (e) {} }

  _card() {
    if (this._cardEl) return this._cardEl;
    const root = this.game.hud?.root ?? document.body;
    const st = document.createElement('style');
    st.textContent = `
#valecard{position:absolute;left:50%;bottom:12vh;transform:translateX(-50%);display:flex;align-items:center;gap:14px;
  max-width:min(680px,86vw);padding:12px 20px 12px 12px;pointer-events:none;opacity:0;transition:opacity .45s ease;
  background:linear-gradient(120deg,rgba(12,9,26,.88),rgba(22,16,44,.82));border:1px solid rgba(211,165,72,.45);
  border-radius:6px;box-shadow:0 6px 30px rgba(0,0,0,.5),inset 0 0 30px rgba(124,91,214,.12)}
#valecard.on{opacity:1}
#valecard img{width:74px;height:74px;border-radius:4px;border:1px solid rgba(211,165,72,.6);object-fit:cover;
  box-shadow:0 0 16px rgba(124,91,214,.45)}
#valecard .vn{font:400 12px Georgia,serif;letter-spacing:.3em;color:#d3a548;margin-bottom:4px}
#valecard .vt{font:italic 400 16px Georgia,serif;color:#efe6cf;line-height:1.45;text-shadow:0 1px 3px rgba(0,0,0,.8)}`;
    root.appendChild(st);
    const el = document.createElement('div');
    el.id = 'valecard';
    el.innerHTML = `<img src="${PORTRAIT}" alt=""><div><div class="vn">THE VALE</div><div class="vt"></div></div>`;
    root.appendChild(el);
    return (this._cardEl = el);
  }

  _speak(i) {
    if (this._said >= i) return;
    this._said = i;
    const L = LINES[i]; if (!L) return;
    const g = this.game;
    // one voice, always: the audio file is generated under the pinned voice in ASSETS.md.
    // Missing file -> assets accessor is null-safe -> the card alone carries the line.
    g.audio?.play?.(L.id, { vol: 1.1, bus: 'sfx' });
    const el = this._card();
    el.querySelector('.vt').textContent = L.text;
    el.classList.add('on');
    clearTimeout(this._cardT);
    this._cardT = setTimeout(() => el.classList.remove('on'), 5200 + L.text.length * 55);
  }

  init() {
    const g = this.game;
    g.events.on('enemy:death', (e) => {
      if (this.beat !== 2) return;
      const p = e?.enemy?.position; if (!p) return;
      const dx = p.x - RUINS.x, dz = p.z - RUINS.z;
      if (dx * dx + dz * dz > RUINS.r * RUINS.r) return;
      this.kills++;
      if (this.kills < KILLS_NEEDED) {
        g.hud?.setQuest?.('The Sundered Spire', `Clear the camp — ${this.kills} / ${KILLS_NEEDED}`);
        this._save();
      } else this._advance(3);
    });
    g.events.on('loot:picked', (e) => {
      if (this.beat === 3 && (e?.tier === 'legendary' || e?.tier === 'exotic')) this._advance(4);
    });
  }

  _advance(beat) {
    const g = this.game, R = this.rpg;
    this.beat = beat; this._save();
    if (beat === 1) {          // wake: flare + first words + tracker
      const y = g.terrain?.heightAt?.(AETHERYTE.x, AETHERYTE.z) ?? 0;
      g.vfx?.emit?.('aether-burst', { x: AETHERYTE.x, y: y + 6, z: AETHERYTE.z }, { color: 0xb070ff, count: 36, scale: 2 });
      g.postfx?.flash?.(0xb08cff, 0.35, 0.5);
      this._speak(0);
      g.hud?.notify?.('The Shattered Meadow', 'Cadle');
      g.hud?.setQuest?.('The Sundered Spire', 'Reach the ruins to the east');
      try { setWaypoint(null, { x: RUINS.x, z: RUINS.z }); } catch (e) {}   // marked on the map (M)
    } else if (beat === 2) {   // arrived at the ruins
      this._speak(1);
      g.hud?.notify?.('The Sundered Spire', 'something feeds on the wound');
      g.hud?.setQuest?.('The Sundered Spire', `Clear the camp — 0 / ${KILLS_NEEDED}`);
    } else if (beat === 3) {   // camp cleared: the reward drops at the player's feet
      this._speak(2);
      R?.dropLoot?.(g.player.position, 'legendary', { kind: 'weapon' });
      g.hud?.setQuest?.('The Sundered Spire', "Claim the Wayfarer's arm");
    } else if (beat === 4) {   // claimed: done
      this._speak(3);
      R?.addXp?.(250);
      g.hud?.notify?.('Quest complete', 'The Sundered Spire');
      try { clearWaypoint(); } catch (e) {}
      setTimeout(() => { if (this.beat === 4) g.hud?.setQuest?.('', null); }, 6000);
    }
  }

  update(dt, t) {
    if (this.beat >= 4) return;
    const g = this.game, p = g.player?.position; if (!p) return;
    if (this.beat === -1) {                       // arm the intro once the player is actually IN (first lock)
      if (!g.auto && !g.input?.locked) { this._t0 = -1; return; }   // pre-click: audio is muted and nobody is looking
      if (this._t0 < 0) this._t0 = t + (g.auto ? 2.5 : 1.2);
      if (t >= this._t0) this._advance(1);
      return;
    }
    if (this.beat === 3) {
      // the reward can be evicted by the world loot cap (oldest drop despawns past 12) — if no
      // legendary-or-better exists anywhere on the ground, put the Wayfarer's arm back down.
      if (t >= (this._redrop ?? 0)) {
        this._redrop = t + 5;
        const drops = this.rpg?.activeDrops?.() ?? [];
        const near = (d) => (d.tier === 'legendary' || d.tier === 'exotic') && Math.hypot(d.x - p.x, d.z - p.z) < 90;
        if (!drops.some(near)) this.rpg?.dropLoot?.(p, 'legendary', { kind: 'weapon' });
      }
    }
    if (this.beat === 1) {
      const dx = p.x - RUINS.x, dz = p.z - RUINS.z, d = Math.hypot(dx, dz);
      if (t >= (this._disT ?? 0)) { this._disT = t + 0.5; g.hud?.setQuest?.('The Sundered Spire', `Reach the ruins to the east — ${Math.max(0, Math.round(d - RUINS.r))} m`); }
      if (d < RUINS.r) this._advance(2);
    } else if (this.beat >= 2 && this._said < this.beat - 1) {
      this._said = this.beat - 1;                 // resumed mid-quest from a save: restore the tracker line silently
      if (this.beat === 2) g.hud?.setQuest?.('The Sundered Spire', `Clear the camp — ${this.kills} / ${KILLS_NEEDED}`);
      if (this.beat === 3) g.hud?.setQuest?.('The Sundered Spire', "Claim the Wayfarer's arm");
    }
  }
}
