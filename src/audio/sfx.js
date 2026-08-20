/**
 * sfx.js — every SFX recipe. Shots + explosions play the AI-generated takes (S.bufs, 4 round-robin takes each, ±vary rate jitter, synth sub layered
 * under; fusion takes are onset-trimmed past the baked charge) and fall back to full synthesis (waveshaper-saturated crack/bark + inharmonic metal
 * partials) when a buffer hasn't decoded. Entry: { rev (reverb send 0..1), dist (max audible distance m), ref (panner refDistance),
 *   vary (per-play round-robin: ±vary pitch, ±2.5*vary level), gap (min secs between repeats, rate limit), bus ('fb' = feedback bus, bypasses sfx duck),
 *   duck (dip the sfx bus briefly so the tick cuts through autofire), f(S, o) -> duration s }.
 * Mix reference: gunshots peak ~1.0 pre-limiter, feedback ticks ~0.55, movement ~0.2, ambient blips ~0.1. Recipes read o.pitch via S.p; o.* extra hints (radius, impact, speed...).
 */
import { noise, tone, fm, click, echo, rnd, sample, drive, metal } from './synth.js';

// Round-robin over the 4 AI-generated takes per asset base (S.bufs = Audio.buffers, decoded at init). null -> caller uses its synth fallback.
const RR = {};
const takeBuf = (S, base) => {
  const B = S.bufs; if (!B) return null;
  const i = RR[base] = ((RR[base] ?? (Math.random() * 4) | 0) + 1) & 3;
  return B[base + '-' + (i + 1)] ?? B[base + '-1'] ?? null;
};
// Buffer-backed shot: mp3 take at S.p rate (take round-robin + ±vary jitter) + synth sub reinforcement; distance dulls/softens the take.
const bufShot = (S, base, { gain = 1, subF = 0, subG = 0, subDur = 0.2 } = {}) => {
  const b = takeBuf(S, base); if (!b) return 0;
  const far = Math.min(1, (S.dist ?? 0) / 130);
  const d = sample(S, b, { rate: S.p, gain: gain * (1 - 0.3 * far) });
  if (subG > 0) tone(S, { f0: subF, f1: subF * 0.25, dur: subDur, gain: subG * (1 + 0.35 * far), att: 0.003 });   // chest thump under the take
  return d;
};
// Loose-parts rattle: clustered micro clicks + a body knock (Destiny mag/receiver foley)
const rattle = (S, t, g = 0.13, n = 5) => {
  for (let i = 0; i < n; i++) click(S, { t: t + i * 0.017 + rnd(0.012), gain: g * (0.6 + rnd(0.7)), f: 1400 + rnd(1900), dur: 0.003 });
  noise(S, { t, dur: 0.09, type: 'lowpass', f0: 800, gain: g * 0.8 });
};

const gun = (S, { crackF0, crackF1, crackDur, crackQ = 0.7, crackG = 1, thumpF0, thumpF1, thumpDur, thumpG = 0.8,
  barkG = 0.7, barkDur = 0.16, barkF0 = 1400, barkF1 = 550, roomG = 0.3, roomDur = 0.4, tailDur, tailG = 0.4, tailF = 800, clickG = 0.8 }) => {
  const far = Math.min(1, (S.dist ?? 0) / 130), nf = 1 - 0.8 * far;                                   // distance mix: near = crack+click, far = soft rolling boom (Destiny-style), on top of level/air rolloff
  const ws = drive(S, { amount: 3.4, gain: 0.72 });                                                   // saturation stage: click/crack/bark clip through tanh -> recorded-report grain, not clean filtered noise
  click(S, { gain: clickG * nf * 1.25, f: 2500, dur: 0.004, to: ws });                                // transient
  noise(S, { dur: crackDur, f0: crackF0, f1: crackF1, q: crackQ, gain: crackG * nf * 1.3, to: ws }); // crack: bandpass sweeping down
  metal(S, { f: barkF0 * 1.35, dur: 0.055, gain: clickG * 0.3, to: ws });                             // inharmonic metallic partials in the crack
  tone(S, { f0: thumpF0, f1: thumpF1, dur: thumpDur * (1 + 0.5 * far), gain: thumpG * (1 + 0.25 * far), att: 0.002 + 0.01 * far });   // low thump (clean)
  noise(S, { t: 0.002, dur: barkDur, hold: 0.025, f0: barkF0, f1: barkF1, q: 1.1, gain: barkG * 1.3 * (1 - 0.45 * far), to: ws });    // mid "bark": the 500-1500 Hz report body, saturated
  noise(S, { t: 0.005, dur: barkDur * 0.85, hold: 0.02, f0: barkF0 * 0.6, f1: barkF1 * 0.9, q: 1.7, gain: barkG * 0.85, to: ws });    // lower formant of the bark
  noise(S, { t: 0.004, dur: tailDur * (1 + 0.4 * far), type: 'lowpass', f0: tailF, f1: 140, gain: tailG * (1 + 0.5 * far) });   // body tail
  noise(S, { t: 0.015, dur: roomDur * (1 + 0.6 * far), att: 0.03 + 0.06 * far, f0: 1100, f1: 280, q: 0.8, gain: roomG * (1 + 0.8 * far) });   // room reflections: long dur = slow decay, keeps the report alive 400+ ms
};

export const SFX = {
  // ---------- weapons (vary = per-shot round-robin: ±vary pitch, ±2.5*vary level; AI take round-robin via bufShot, synth fallback below it) ----------
  'shot-handcannon': { rev: 0.5, dist: 160, vary: 0.03, f: (S) => {
    const d = bufShot(S, 'shot-handcannon', { gain: 1.0, subF: 170, subG: 0.5, subDur: 0.22 }); if (d) return d;
    gun(S, { crackF0: 2600, crackF1: 320, crackDur: 0.12, crackG: 1.1, thumpF0: 175, thumpF1: 40, thumpDur: 0.24, thumpG: 1.0,
    barkG: 1.05, barkDur: 0.32, barkF0: 1350, barkF1: 480, roomG: 1.0, roomDur: 1.5, tailDur: 0.5, tailG: 0.55, tailF: 900, clickG: 1 });
    tone(S, { type: 'triangle', f0: 1400, f1: 180, dur: 0.05, gain: 0.35 }); tone(S, { type: 'square', f0: 620, f1: 210, dur: 0.12, gain: 0.2 }); return 1.6; } },   // mechanical growl under the bark
  'shot-autorifle': { rev: 0.3, dist: 120, vary: 0.035, f: (S) => {
    const d = bufShot(S, 'shot-autorifle', { gain: 0.85, subF: 150, subG: 0.3, subDur: 0.1 }); if (d) return d;
    gun(S, { crackF0: 3600, crackF1: 900, crackDur: 0.055, crackQ: 0.8, crackG: 0.85, thumpF0: 150, thumpF1: 60, thumpDur: 0.09, thumpG: 0.6,
    barkG: 0.7, barkDur: 0.14, barkF0: 1500, barkF1: 650, roomG: 0.62, roomDur: 1.1, tailDur: 0.3, tailG: 0.38, tailF: 1000, clickG: 0.7 }); return 1.15; } },
  'shot-pulse': { rev: 0.3, dist: 120, vary: 0.03, f: (S) => {
    const d = bufShot(S, 'shot-pulse', { gain: 0.85, subF: 210, subG: 0.25, subDur: 0.08 });
    if (d) { tone(S, { type: 'sine', f0: 2200, f1: 900, dur: 0.03, gain: 0.15 }); return d; }
    gun(S, { crackF0: 4400, crackF1: 1200, crackDur: 0.045, crackQ: 1.0, crackG: 0.8, thumpF0: 210, thumpF1: 70, thumpDur: 0.07, thumpG: 0.5,
    barkG: 0.6, barkDur: 0.12, barkF0: 1650, barkF1: 750, roomG: 0.55, roomDur: 1.0, tailDur: 0.25, tailG: 0.32, tailF: 1200, clickG: 0.7 });
    tone(S, { type: 'sine', f0: 2200, f1: 900, dur: 0.03, gain: 0.25 }); return 1.05; } },                                                              // void "zip"
  'shot-shotgun': { rev: 0.6, dist: 180, vary: 0.03, f: (S) => {
    const d = bufShot(S, 'shot-shotgun', { gain: 1.1, subF: 105, subG: 0.6, subDur: 0.26 }); if (d) return d;
    gun(S, { crackF0: 1350, crackF1: 340, crackDur: 0.14, crackQ: 0.5, crackG: 1.25, thumpF0: 110, thumpF1: 34, thumpDur: 0.26, thumpG: 0.78,
    barkG: 1.5, barkDur: 0.36, barkF0: 1200, barkF1: 470, roomG: 1.2, roomDur: 1.6, tailDur: 0.5, tailG: 0.42, tailF: 750, clickG: 0.95 });
    noise(S, { dur: 0.02, f0: 5500, q: 0.6, gain: 0.6 }); return 1.8; } },                                                                               // high crack layer
  'shot-sniper': { rev: 0.7, dist: 260, vary: 0.032, f: (S) => {
    const d = bufShot(S, 'shot-sniper', { gain: 1.05, subF: 200, subG: 0.55, subDur: 0.15 }); if (d) return d;
    click(S, { gain: 1, f: 3000, dur: 0.003 });
    const e = echo(S, { time: 0.17, fb: 0.42, lp: 1600, gain: 0.5 });
    noise(S, { dur: 0.035, f0: 6500, f1: 1400, q: 0.8, gain: 1.2 }); noise(S, { dur: 0.035, f0: 6500, f1: 1400, q: 0.8, gain: 1.0, to: e });         // sharp crack (+ into echo)
    noise(S, { t: 0.002, dur: 0.25, hold: 0.02, f0: 1450, f1: 500, q: 1.1, gain: 0.9 }); noise(S, { t: 0.005, dur: 0.2, hold: 0.02, f0: 850, f1: 450, q: 1.7, gain: 0.65 });  // bark
    tone(S, { f0: 210, f1: 48, dur: 0.14, gain: 0.8, att: 0.002 }); tone(S, { f0: 210, f1: 48, dur: 0.14, gain: 0.4, to: e });
    noise(S, { t: 0.015, dur: 1.6, att: 0.03, f0: 1100, f1: 280, q: 0.8, gain: 0.9 });                                                                // room report
    noise(S, { t: 0.006, dur: 0.35, type: 'lowpass', f0: 1100, f1: 160, gain: 0.4 }); return 1.7; } },
  'shot-fusion': { rev: 0.35, dist: 110, vary: 0.04, f: (S) => {                                                                                             // per bolt: void zap (buffer take is onset-trimmed past the baked charge whine)
    const d = bufShot(S, 'shot-fusion', { gain: 0.8, subF: 130, subG: 0.3, subDur: 0.08 }); if (d) return d;
    tone(S, { type: 'sawtooth', f0: 950, f1: 280, dur: 0.07, gain: 0.35 }); tone(S, { type: 'sine', f0: 1900, f1: 500, dur: 0.04, gain: 0.25 });
    noise(S, { dur: 0.035, f0: 3200, f1: 700, q: 1.2, gain: 0.45 }); noise(S, { t: 0.004, dur: 0.16, f0: 1200, f1: 500, q: 1.2, gain: 0.32 });
    tone(S, { f0: 120, f1: 55, dur: 0.06, gain: 0.35 }); return 0.3; } },
  'fusion-charge': { rev: 0.25, dist: 40, f: (S) => {                                                                                                        // rising whine 0.78 s, snaps at the top
    tone(S, { type: 'sawtooth', f0: 180, f1: 1500, att: 0.7, dur: 0.1, gain: 0.16, detune: -7, sweepDur: 0.78 });
    tone(S, { type: 'triangle', f0: 180, f1: 1500, att: 0.7, dur: 0.1, gain: 0.16, detune: 8, sweepDur: 0.78 });
    tone(S, { type: 'sine', f0: 360, f1: 3000, att: 0.72, dur: 0.08, gain: 0.08, sweepDur: 0.78 });
    noise(S, { att: 0.7, dur: 0.1, f0: 800, f1: 5000, q: 2, gain: 0.12 });
    return 0.85; } },
  'reload': { rev: 0.15, dist: 20, f: (S, o) => {                                                                                                            // dense mag-scrape/rattle/bolt foley, per-archetype variants (o.arch)
    const a = o.arch;
    if (a === 'handcannon') {                                                                                                                                // cylinder swing-out, ratchet spin, snap shut
      click(S, { gain: 0.42, f: 2000, ring: 0.1, ringF: 2900 }); rattle(S, 0.03, 0.1, 3);
      noise(S, { t: 0.1, dur: 0.12, f0: 500, f1: 900, q: 1.6, gain: 0.16, att: 0.02 });
      for (let i = 0; i < 7; i++) click(S, { t: 0.3 + i * 0.045 + rnd(0.008), gain: 0.2 + i * 0.02, f: 2400, ring: 0.05, ringF: 3300 + i * 120 });
      rattle(S, 0.66, 0.12, 4); metal(S, { t: 0.68, f: 2600, dur: 0.04, gain: 0.07 });
      click(S, { t: 0.96, gain: 0.55, f: 1400, ring: 0.16, ringF: 2000 }); noise(S, { t: 0.96, dur: 0.07, type: 'lowpass', f0: 600, gain: 0.32 });
      return 1.15;
    }
    if (a === 'shotgun') {                                                                                                                                   // two shell inserts + pump back/forward
      for (const t of [0.1, 0.42]) { click(S, { t, gain: 0.4, f: 1300, ring: 0.08, ringF: 1800 }); noise(S, { t: t + 0.01, dur: 0.09, f0: 700, f1: 380, q: 1.3, gain: 0.24 }); rattle(S, t + 0.04, 0.09, 3); }
      noise(S, { t: 0.78, dur: 0.11, f0: 420, f1: 900, q: 1.8, gain: 0.3, att: 0.02 }); click(S, { t: 0.88, gain: 0.55, f: 1100, ring: 0.14, ringF: 1500 });   // pump back
      noise(S, { t: 1.0, dur: 0.1, f0: 900, f1: 420, q: 1.8, gain: 0.3, att: 0.015 }); click(S, { t: 1.08, gain: 0.6, f: 1000, ring: 0.16, ringF: 1400 }); noise(S, { t: 1.08, dur: 0.08, type: 'lowpass', f0: 550, gain: 0.35 });   // slam forward
      return 1.25;
    }
    if (a === 'sniper') {                                                                                                                                    // heavy bolt up/back, mag, bolt forward/down
      click(S, { gain: 0.5, f: 1200, ring: 0.15, ringF: 1700 }); metal(S, { t: 0.005, f: 1900, dur: 0.06, gain: 0.1 });                                       // bolt up
      noise(S, { t: 0.12, dur: 0.13, f0: 500, f1: 950, q: 2, gain: 0.28, att: 0.02 }); click(S, { t: 0.24, gain: 0.4, f: 1500 });                             // bolt back scrape
      click(S, { t: 0.5, gain: 0.45, f: 1700, ring: 0.1, ringF: 2400 }); rattle(S, 0.53, 0.13, 5); noise(S, { t: 0.5, dur: 0.14, f0: 380, f1: 800, q: 1.7, gain: 0.22 });   // mag seat + rattle
      noise(S, { t: 0.92, dur: 0.12, f0: 950, f1: 480, q: 2, gain: 0.3, att: 0.015 }); click(S, { t: 1.02, gain: 0.62, f: 1100, ring: 0.18, ringF: 1500 }); noise(S, { t: 1.02, dur: 0.09, type: 'lowpass', f0: 500, gain: 0.4 });   // bolt forward + down
      return 1.25;
    }
    click(S, { gain: 0.42, f: 2200, ring: 0.09, ringF: 3100 }); noise(S, { t: 0.01, dur: 0.1, type: 'lowpass', f0: 650, gain: 0.28 }); rattle(S, 0.05, 0.13, 5);   // mag release + body knock + loose rounds
    noise(S, { t: 0.16, dur: 0.16, f0: 380, f1: 950, q: 2, gain: 0.22, att: 0.03 });                                                                          // mag scrape out
    click(S, { t: 0.5 + rnd(0.04), gain: 0.45, f: 1800, ring: 0.11, ringF: 2600 }); rattle(S, 0.53, 0.12, 4); noise(S, { t: 0.5, dur: 0.13, f0: 900, f1: 420, q: 1.4, gain: 0.2 });   // mag in: seat + rattle + scrape
    click(S, { t: 0.63, gain: 0.25, f: 2600 });
    click(S, { t: 0.95 + rnd(0.03), gain: 0.6, f: 1500, ring: 0.17, ringF: 2100 }); noise(S, { t: 0.96, dur: 0.08, type: 'lowpass', f0: 750, gain: 0.35 }); metal(S, { t: 0.955, f: 2300, dur: 0.05, gain: 0.09 });   // bolt release
    return 1.15; } },
  'empty': { rev: 0.05, dist: 10, f: (S) => { click(S, { gain: 0.35, f: 2400, ring: 0.06, ringF: 1900 }); return 0.08; } },
  'swap': { rev: 0.1, dist: 10, f: (S) => { noise(S, { dur: 0.3, f0: 500, f1: 1500, q: 0.9, gain: 0.1, att: 0.08 }); click(S, { t: 0.3, gain: 0.3, f: 1800, ring: 0.08 }); return 0.42; } },
  'enemy-shot': { rev: 0.3, dist: 120, f: (S) => { tone(S, { type: 'square', f0: 720, f1: 260, dur: 0.08, gain: 0.22 }); noise(S, { dur: 0.05, f0: 2500, f1: 600, q: 1.5, gain: 0.35 }); tone(S, { f0: 140, f1: 60, dur: 0.08, gain: 0.3 }); return 0.16; } },

  // ---------- feedback (non-positional, the player's HUD language; bus:'fb' bypasses the sfx duck so ticks cut through autofire) ----------
  'hit': { rev: 0.05, dist: 0, bus: 'fb', duck: 1, f: (S) => { tone(S, { f0: 1900, f1: 1300, dur: 0.035, att: 0.001, gain: 0.55 }); click(S, { gain: 0.25, f: 3500, dur: 0.003 }); noise(S, { dur: 0.012, type: 'highpass', f0: 4000, gain: 0.22 }); return 0.07; } },
  'crit': { rev: 0.08, dist: 0, bus: 'fb', duck: 1, f: (S) => { tone(S, { f0: 2700, f1: 2000, dur: 0.05, att: 0.001, gain: 0.58 }); tone(S, { f0: 4050, f1: 3000, dur: 0.035, att: 0.001, gain: 0.22 }); noise(S, { dur: 0.014, type: 'highpass', f0: 6000, gain: 0.26 }); return 0.09; } },
  'kill': { rev: 0.35, dist: 0, bus: 'fb', duck: 1, f: (S) => { fm(S, { fc: 880, ratio: 2, index: 1.5, dur: 0.32, gain: 0.3 }); fm(S, { t: 0.04, fc: 1320, ratio: 2, index: 1.2, dur: 0.38, gain: 0.24 }); fm(S, { t: 0.09, fc: 1760, ratio: 3, index: 1, dur: 0.45, gain: 0.16 }); return 0.6; } },
  'player-hurt': { rev: 0.2, dist: 0, f: (S) => { tone(S, { f0: 140, f1: 55, dur: 0.18, gain: 0.6 }); noise(S, { dur: 0.12, type: 'lowpass', f0: 700, f1: 200, gain: 0.35 }); tone(S, { type: 'square', f0: 900, f1: 400, dur: 0.05, gain: 0.08 }); return 0.25; } },
  'player-died': { rev: 0.7, dist: 0, f: (S) => { tone(S, { f0: 110, f1: 28, dur: 1.2, gain: 0.8 }); noise(S, { dur: 0.9, type: 'lowpass', f0: 1500, f1: 80, gain: 0.5 }); tone(S, { type: 'triangle', f0: 440, f1: 110, dur: 1.4, gain: 0.12 }); return 1.6; } },
  'shield-break': { rev: 0.4, dist: 60, f: (S) => { noise(S, { dur: 0.2, type: 'highpass', f0: 2500, gain: 0.4 }); for (let i = 0; i < 5; i++) fm(S, { t: 0.02 + i * 0.035, fc: 3200 - i * 420, f1: 1800 - i * 250, ratio: 2.7, index: 1.5, dur: 0.18, gain: 0.12 }); return 0.45; } },
  'ability-ready': { rev: 0.4, dist: 0, f: (S) => { fm(S, { fc: 1046, ratio: 2, index: 1.2, dur: 0.3, gain: 0.14 }); fm(S, { t: 0.1, fc: 1568, ratio: 2, index: 1.2, dur: 0.4, gain: 0.12 }); return 0.55; } },

  // ---------- impacts / world ----------
  'impact-terrain': { rev: 0.25, dist: 60, f: (S) => { noise(S, { dur: 0.12, type: 'lowpass', f0: 650, f1: 200, gain: 0.5 }); tone(S, { f0: 130, f1: 55, dur: 0.08, gain: 0.35 }); return 0.16; } },
  'impact-rock': { rev: 0.35, dist: 70, f: (S) => { click(S, { gain: 0.5, f: 2000, dur: 0.003 }); noise(S, { dur: 0.07, f0: 1900, f1: 900, q: 1.2, gain: 0.55 }); noise(S, { dur: 0.15, type: 'lowpass', f0: 900, f1: 200, gain: 0.25 });
    if (Math.random() < 0.3) tone(S, { t: 0.01, f0: 3400, f1: 2300, dur: 0.09, gain: 0.12 }); return 0.2; } },                                       // occasional ricochet ping
  'impact-enemy': { rev: 0.25, dist: 60, f: (S) => { noise(S, { dur: 0.06, f0: 900, f1: 300, q: 1, gain: 0.5 }); tone(S, { f0: 320, f1: 110, dur: 0.07, gain: 0.3 }); fm(S, { fc: 2400, ratio: 1.5, index: 2, dur: 0.05, gain: 0.08 }); return 0.12; } },
  'explosion': { rev: 0.8, dist: 320, ref: 8, gap: 0.12, vary: 0.04, f: (S, o) => {                                                                          // scales with event radius: super bolts (r~1.6) = short mid pop, grenades (r>=5) = full 1.5s+ sub-boom
    const rad = o.radius ?? 4.5, r = Math.min(1.6, Math.max(0.28, rad / 5)), big = rad >= 5;
    const L = 1.15 / (0.9 + 0.55 * r);                                                                                                                     // pre-scale: big blasts stay ~unity peak instead of pumping the master comp/limiter
    const far = Math.min(1, (S.dist ?? 0) / 180), nf = 1 - 0.8 * far;
    const b = takeBuf(S, 'explosion');
    if (b) {                                                                                                                                               // AI take: radius -> playback rate (big = slower/deeper) + envelope (small = short crack), sub layer guarantees the 1.5s+ boom
      const rate = Math.min(1.3, Math.max(0.72, 1.35 - 0.45 * r)) * S.p;
      const d = sample(S, b, { rate, gain: (0.45 + 0.45 * r) * (1 - 0.25 * far), dec: big ? 0 : 0.35 + 1.0 * r });
      if (big) { tone(S, { t: 0.04, f0: 48, f1: 24, dur: 2.2, gain: 0.7 * L, att: 0.05 }); noise(S, { t: 0.1, dur: 2.4, type: 'lowpass', f0: 300, f1: 50, gain: 0.35 * L, att: 0.1 }); }
      return big ? d : 0.4 + 1.0 * r;
    }
    click(S, { gain: (0.6 + 0.4 * r) * L * nf, f: 1500, dur: 0.006 });
    tone(S, { f0: 75, f1: 26, dur: 0.15 + 0.6 * r, gain: Math.min(1.5, 1.2 * r * r) * L, att: 0.004 });                                                    // sub boom (tiny blasts get almost none)
    noise(S, { dur: 0.25 + 0.7 * r, type: 'lowpass', f0: 1400, f1: 110, gain: (0.45 + 0.55 * r) * L, att: 0.003 });                                        // blast body
    noise(S, { dur: 0.12, f0: 2800, f1: 600, q: 0.6, gain: 0.7 * L * nf });                                                                                // crack
    noise(S, { t: 0.01, dur: 0.1 + 0.25 * r, f0: 1200, f1: 400, q: 1, gain: 0.55 * L });                                                                   // mid bark
    if (big) { tone(S, { t: 0.08, f0: 46, f1: 24, dur: 2.3, gain: 0.9 * L, att: 0.06 }); noise(S, { t: 0.12, dur: 2.8, type: 'lowpass', f0: 320, f1: 55, gain: 0.55 * L, att: 0.1 }); }   // rolling sub tail: real blasts stay audible >= 1.5 s
    const nd = Math.round(2 + 7 * r);
    for (let i = 0; i < nd; i++) click(S, { t: 0.08 + Math.random() * 0.7 * r, gain: (0.25 + Math.random() * 0.25) * L, f: 800 + Math.random() * 2500, dur: 0.006 + Math.random() * 0.01 });   // debris crackle
    return 0.4 + 1.1 * r + (big ? 1.6 : 0); } },

  // ---------- movement (player's own; non-positional) ----------
  'footstep-grass': { rev: 0.05, dist: 0, f: (S) => { noise(S, { dur: 0.07, f0: 800 + rnd(300), q: 0.7, gain: 0.22, att: 0.004 }); noise(S, { dur: 0.05, type: 'lowpass', f0: 300, gain: 0.2  }); return 0.12; } },
  'footstep-rock': { rev: 0.15, dist: 0, f: (S) => { click(S, { gain: 0.25, f: 1800, dur: 0.003 }); noise(S, { dur: 0.05, f0: 1400 + rnd(400), q: 1.4, gain: 0.28, att: 0.002 }); tone(S, { f0: 230 + rnd(40), f1: 150, dur: 0.04, gain: 0.12  }); return 0.1; } },
  'footstep-water': { rev: 0.15, dist: 0, f: (S) => { noise(S, { dur: 0.16, f0: 2300, f1: 650, q: 0.9, gain: 0.3, att: 0.01 }); fm(S, { t: 0.03, fc: 700 + rnd(300), f1: 1400, ratio: 1.3, index: 1, dur: 0.06, gain: 0.06  }); fm(S, { t: 0.09, fc: 500 + rnd(200), f1: 1100, ratio: 1.3, index: 1, dur: 0.05, gain: 0.05  }); return 0.25; } },
  'jump': { rev: 0.05, dist: 0, f: (S) => { noise(S, { dur: 0.14, f0: 420, f1: 1300, q: 0.8, gain: 0.34, att: 0.015 }); noise(S, { dur: 0.09, type: 'highpass', f0: 1800, gain: 0.12, att: 0.01 }); tone(S, { f0: 150, f1: 90, dur: 0.07, gain: 0.16, att: 0.005 }); return 0.2; } },   // cloth/exhale whoosh + push-off
  'land': { rev: 0.1, dist: 0, f: (S, o) => { tone(S, { f0: 110, f1: 48, dur: 0.12, gain: 0.45 }); noise(S, { dur: 0.09, type: 'lowpass', f0: 550, f1: 200, gain: 0.3 }); if (o.hard) click(S, { gain: 0.3, f: 1200, dur: 0.005 }); return 0.16; } },
  'slide': { rev: 0.1, dist: 0, f: (S) => { noise(S, { dur: 0.55, f0: 800, f1: 450, q: 0.5, gain: 0.22, att: 0.02 }); noise(S, { dur: 0.4, type: 'highpass', f0: 2500, gain: 0.05, att: 0.02 }); return 0.62; } },

  // ---------- abilities ----------
  'ability-grenade': { rev: 0.3, dist: 0, f: (S) => { noise(S, { dur: 0.26, f0: 500, f1: 2100, q: 1, gain: 0.2, att: 0.03 }); tone(S, { type: 'sawtooth', f0: 110, f1: 240, dur: 0.3, gain: 0.08, att: 0.05 }); fm(S, { t: 0.2, fc: 1800, f1: 2600, ratio: 2.5, index: 2, dur: 0.2, gain: 0.08 }); return 0.45; } },
  'ability-melee': { rev: 0.25, dist: 0, f: (S) => { noise(S, { dur: 0.13, f0: 300, f1: 1600, q: 0.9, gain: 0.35, att: 0.01 }); tone(S, { t: 0.1, f0: 160, f1: 55, dur: 0.14, gain: 0.5 }); noise(S, { t: 0.1, dur: 0.08, type: 'highpass', f0: 3000, gain: 0.2 }); for (let i = 0; i < 3; i++) fm(S, { t: 0.11 + i * 0.03, fc: 2000 + rnd(1500), ratio: 1.7, index: 3, dur: 0.05, gain: 0.06 }); return 0.32; } },
  'ability-class': { rev: 0.6, dist: 0, f: (S) => { tone(S, { type: 'sawtooth', f0: 220, dur: 0.7, att: 0.3, gain: 0.06 }); tone(S, { type: 'sawtooth', f0: 330, dur: 0.7, att: 0.3, gain: 0.05, detune: 6 }); noise(S, { dur: 0.6, type: 'highpass', f0: 5000, gain: 0.05, att: 0.2 });
    [523, 659, 784, 1047, 1319].forEach((f, i) => fm(S, { t: 0.05 + i * 0.09, fc: f, ratio: 2, index: 1.5, dur: 0.45, gain: 0.1 })); return 1.05; } },
  'ability-super': { rev: 0.85, dist: 0, f: (S) => {
    tone(S, { type: 'sawtooth', f0: 70, f1: 560, att: 0.65, dur: 0.25, gain: 0.2, sweepDur: 0.8 }); noise(S, { dur: 0.85, f0: 400, f1: 4000, q: 1.2, gain: 0.2, att: 0.1 });
    [440, 554, 659, 880].forEach((f, i) => { tone(S, { t: 0.1, type: 'sawtooth', f0: f, dur: 1.3, att: 0.5, gain: 0.05, detune: -6 + i * 3 }); tone(S, { t: 0.1, type: 'triangle', f0: f, dur: 1.3, att: 0.5, gain: 0.05, detune: 5 }); });
    tone(S, { t: 0.82, f0: 90, f1: 30, dur: 0.7, gain: 1.0 }); noise(S, { t: 0.82, dur: 0.7, type: 'lowpass', f0: 1800, f1: 150, gain: 0.8 }); click(S, { t: 0.82, gain: 0.8, f: 1200, dur: 0.006 });
    for (let i = 0; i < 8; i++) fm(S, { t: 0.85 + i * 0.07, fc: 1500 + rnd(2000), ratio: 2.2, index: 2, dur: 0.3, gain: 0.07 }); return 2.2; } },

  // ---------- enemies (positional) ----------
  'enemy-hurt': { rev: 0.2, dist: 60, f: (S) => { tone(S, { type: 'sawtooth', f0: 190 + rnd(40), f1: 120, dur: 0.09, gain: 0.2, att: 0.005 }); noise(S, { dur: 0.07, f0: 500, f1: 250, q: 1, gain: 0.25 }); return 0.14; } },
  'enemy-attack': { rev: 0.3, dist: 60, f: (S) => { tone(S, { type: 'sawtooth', f0: 95, f1: 65, dur: 0.32, gain: 0.22, att: 0.04 }); noise(S, { dur: 0.3, f0: 250, f1: 600, q: 0.8, gain: 0.15, att: 0.06 }); return 0.4; } },
  'enemy-death': { rev: 0.5, dist: 90, f: (S) => { tone(S, { f0: 480, f1: 90, dur: 0.5, gain: 0.3 }); noise(S, { dur: 0.6, type: 'lowpass', f0: 2200, f1: 180, gain: 0.4 }); tone(S, { f0: 120, f1: 45, dur: 0.25, gain: 0.5 });
    for (let i = 0; i < 5; i++) fm(S, { t: 0.05 + i * 0.06, fc: 1200 + rnd(1800), f1: 2400, ratio: 2.3, index: 2, dur: 0.25, gain: 0.06 }); return 0.75; } },

  // ---------- ui / rpg ----------
  'ui-click': { rev: 0.05, dist: 0, f: (S) => { tone(S, { f0: 1500, f1: 1300, dur: 0.02, att: 0.001, gain: 0.2 }); noise(S, { dur: 0.01, type: 'highpass', f0: 3000, gain: 0.1 }); return 0.05; } },
  'ui-hover': { rev: 0.05, dist: 0, f: (S) => { tone(S, { f0: 1100, dur: 0.012, att: 0.001, gain: 0.1 }); return 0.03; } },
  'pickup': { rev: 0.3, dist: 0, f: (S) => { fm(S, { fc: 660, ratio: 2, index: 1, dur: 0.12, gain: 0.15 }); fm(S, { t: 0.07, fc: 990, ratio: 2, index: 1, dur: 0.2, gain: 0.15 }); return 0.32; } },
  'levelup': { rev: 0.7, dist: 0, f: (S) => { [523, 659, 784, 1047].forEach((f, i) => { fm(S, { t: i * 0.11, fc: f, ratio: 2, index: 1.5, dur: 0.7, gain: 0.16 }); fm(S, { t: i * 0.11, fc: f * 2, ratio: 3, index: 1, dur: 0.4, gain: 0.05 }); });
    noise(S, { t: 0.3, dur: 0.8, type: 'highpass', f0: 6000, gain: 0.06, att: 0.2 }); return 1.4; } },

  // ---------- ambient creatures (scheduled by ambient.js; positional, low gain) ----------
  'bird': { rev: 0.3, dist: 80, ref: 6, f: (S) => { const n = 2 + (Math.random() * 3 | 0), f = 2400 + rnd(1500), gap = 0.06 + rnd(0.08);
    for (let i = 0; i < n; i++) fm(S, { t: i * gap, fc: f * (1 + rnd(-0.08, 0.08)), f1: f * (1 + rnd(0.05, 0.35)), ratio: 1.01, index: 0.6, dur: 0.045 + rnd(0.05), att: 0.008, gain: 0.07, sweep: 'lin' }); return n * gap + 0.15; } },
  'insect': { rev: 0.1, dist: 40, ref: 4, f: (S) => { noise(S, { dur: 1.2, att: 0.4, f0: 5200 + rnd(1200), q: 12, gain: 0.06, curve: 'lin' }); tone(S, { type: 'square', f0: 130, dur: 1.2, att: 0.4, gain: 0.004, curve: 'lin' }); return 1.7; } },
  'cricket': { rev: 0.15, dist: 50, ref: 4, f: (S) => { const f = 4100 + rnd(600); for (let i = 0; i < 3; i++) fm(S, { t: i * 0.07, fc: f, ratio: 1, index: 0.15, dur: 0.04, att: 0.006, gain: 0.05 }); return 0.3; } },
  'owl': { rev: 0.5, dist: 120, ref: 10, f: (S) => { tone(S, { f0: 380, f1: 340, dur: 0.25, att: 0.05, gain: 0.1 }); tone(S, { t: 0.35, f0: 360, f1: 310, dur: 0.4, att: 0.06, gain: 0.1 }); return 0.9; } },
  'wisp': { rev: 0.5, dist: 60, ref: 5, f: (S) => { for (let i = 0; i < 4; i++) fm(S, { t: i * 0.09, fc: 1600 + rnd(1400), f1: 2600, ratio: 2.4, index: 1.5, dur: 0.3, gain: 0.04 }); return 0.7; } },
};
export const SFX_NAMES = Object.keys(SFX);
