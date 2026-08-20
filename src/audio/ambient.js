/**
 * ambient.js — wind bed (pink noise through LFO-swept lowpass + gust LFOs), zone layers (leaf rustle, lake lapping, crystal hum, ruin whistle),
 * and creature one-shots scheduled ahead of time by time of day: birds (FM chirp trills, dawn chorus), insects (cicada buzz), night crickets, owls, wisps.
 * Everything runs on the audio thread (LFOs are OscillatorNodes -> AudioParams); the main thread only retargets gains on zone change and books creatures.
 */
import { bed, lfo, makeNoise, rnd } from './synth.js';

// per-zone targets: wind level, wind cutoff, rustle, lake lap, crystal hum, stone whistle, creature rate multipliers
const ZONES = {
  meadow:   { wind: 0.22, windF: 420, rustle: 0.02, lap: 0,    hum: 0,    whistle: 0,    birds: 1.0, insects: 1.0, wisps: 0.25 },
  forest:   { wind: 0.14, windF: 300, rustle: 0.07, lap: 0,    hum: 0,    whistle: 0,    birds: 1.9, insects: 1.2, wisps: 0.7 },
  lake:     { wind: 0.20, windF: 520, rustle: 0.01, lap: 0.11, hum: 0,    whistle: 0,    birds: 0.8, insects: 0.6, wisps: 0.3 },
  ruins:    { wind: 0.26, windF: 620, rustle: 0.01, lap: 0,    hum: 0,    whistle: 0.05, birds: 0.5, insects: 0.5, wisps: 0.25 },
  crystal:  { wind: 0.18, windF: 460, rustle: 0,    lap: 0,    hum: 0.07, whistle: 0,    birds: 0.3, insects: 0.3, wisps: 1.6 },
  arena:    { wind: 0.30, windF: 700, rustle: 0,    lap: 0,    hum: 0.03, whistle: 0.06, birds: 0.2, insects: 0.2, wisps: 0.5 },
  mountain: { wind: 0.42, windF: 900, rustle: 0,    lap: 0,    hum: 0,    whistle: 0.08, birds: 0.2, insects: 0,   wisps: 0.1 },
};
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Ambient {
  constructor(audio) {
    this.audio = audio; this.zone = 'meadow'; this.running = false; this.hour = 12;
    this.next = { bird: 0, insect: 0, owl: 0, wisp: 0 }; this.crickets = [];
    for (let i = 0; i < 3; i++) this.crickets.push({ t: 0, reroll: 0, x: 0, y: 0, z: 0, gap: 0.6 + rnd(0.5) });
    this.layers = null;
  }
  /** Build the persistent beds on ctx, output to bus. (Also used on an OfflineAudioContext by Audio.renderAmbient.) */
  start(ctx, bus) {
    this.ctx = ctx; this.running = true;
    const S = { ctx, t: ctx.currentTime, out: bus, noise: makeNoise(ctx, 2), p: 1, nodes: [] };
    const pink = makeNoise(ctx, 4, true);
    const L = this.layers = {};
    // wind: pink -> lowpass (LFO sweeps cutoff) -> gust stage (two LFOs) -> level. wide = two decorrelated chains hard-panned L/R (FF14/D2-wide beds)
    L.wind = bed(S, { type: 'lowpass', f0: 420, q: 0.8, gain: 0, pink, lfoF: 0.05, lfoA: 230, lfoGainF: 0.17, lfoGainA: 0.38, wide: true });
    lfo(S, 0.31, 0.2, [L.wind.m.gain, L.wind.m2.gain]);
    L.rustle = bed(S, { type: 'bandpass', f0: 2600, q: 0.7, gain: 0, lfoGainF: 0.4, lfoGainA: 0.5, wide: true });                                  // leaves
    L.lap = bed(S, { type: 'bandpass', f0: 450, q: 1.2, gain: 0, lfoGainF: 0.35, lfoGainA: 0.8, lfoF: 0.23, lfoA: 120, wide: true });             // water lapping
    L.whistle = bed(S, { type: 'bandpass', f0: 950, q: 14, gain: 0, pink, lfoF: 0.09, lfoA: 120, lfoGainF: 0.13, lfoGainA: 0.7, wide: true });   // wind through stone
    // crystal hum: detuned sine cluster (each partial panned to its own spot) -> tremolo (unity stage) -> level
    const hum = ctx.createGain(), humM = ctx.createGain(); hum.gain.value = 0; humM.gain.value = 1; humM.connect(hum); hum.connect(bus); lfo(S, 0.6, 0.3, humM.gain);
    for (const [f, d, pn] of [[110, 0, -0.9], [165, 4, 0.9], [220.5, -3, -0.7], [330, 6, 0.75]]) {   // partials hard-split L/R: wide, decorrelated hum
      const o = ctx.createOscillator(); o.frequency.value = f; o.detune.value = d; const og = ctx.createGain(); og.gain.value = f > 200 ? 0.5 : 1; o.connect(og);
      if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pn; og.connect(p); p.connect(humM); S.nodes.push(p); } else og.connect(humM);
      o.start(); S.nodes.push(o, og);
    }
    L.humLevel = hum; S.nodes.push(hum, humM);
    this.nodes = S.nodes;
    this._apply(this.zone, 0.01);
    const now = ctx.currentTime; this.next.bird = now + 1 + rnd(2); this.next.insect = now + 4 + rnd(4); this.next.owl = now + 6 + rnd(10); this.next.wisp = now + 3 + rnd(4);
  }
  stop() { this.running = false; for (const n of this.nodes ?? []) { try { n.stop?.(); } catch {} n.disconnect(); } this.nodes = null; this.layers = null; }
  setZone(z, tau = 1.5) { if (!ZONES[z] || z === this.zone) return; this.zone = z; if (this.layers) this._apply(z, tau); }   // tau 0.4 on fast travel (teleport) so the bed doesn't lag the new zone
  _apply(z, tau) {
    const P = ZONES[z], L = this.layers, now = this.ctx.currentTime, set = (param, v) => param.setTargetAtTime(v, now, tau);
    set(L.wind.g.gain, P.wind); set(L.wind.f.frequency, P.windF); if (L.wind.f2) set(L.wind.f2.frequency, P.windF);
    set(L.rustle.g.gain, P.rustle); set(L.lap.g.gain, P.lap); set(L.whistle.g.gain, P.whistle); set(L.humLevel.gain, P.hum);
  }
  /** Book creature one-shots up to `ahead` seconds into the future. now = ctx.currentTime, listener pos (x,y,z), hour 0..24. */
  update(now, x, y, z, hour, ahead = 0.5) {
    if (!this.running) return;
    const P = ZONES[this.zone], day = smooth(5, 6.5, hour) * (1 - smooth(18.5, 20, hour)), night = 1 - day;
    const dawn = 1 + 1.2 * (smooth(4.8, 5.6, hour) * (1 - smooth(7.5, 9, hour)));                         // dawn chorus
    const N = this.next, A = this.audio;
    const spawn = (name, at, minD, maxD, hMin, hMax, vol) => {
      const a = rnd(Math.PI * 2), d = rnd(minD, maxD), p = A._tmpPos; p.set(x + Math.sin(a) * d, y + rnd(hMin, hMax), z + Math.cos(a) * d);
      A.play(name, { pos: p, vol, at, bus: 'ambient', pitch: 0.92 + rnd(0.16) });
    };
    const birdRate = P.birds * day * dawn;
    if (now + ahead > N.bird) { if (birdRate > 0.03) spawn('bird', N.bird, 12, 45, 3, 12, 0.9); N.bird = Math.max(N.bird, now) + (birdRate > 0.03 ? (1.2 + rnd(4)) / birdRate : 3); }
    const insRate = P.insects * day * smooth(9, 11, hour) * (1 - smooth(16, 18, hour));
    if (now + ahead > N.insect) { if (insRate > 0.03) spawn('insect', N.insect, 6, 25, 0, 2, 0.8); N.insect = Math.max(N.insect, now) + (insRate > 0.03 ? (6 + rnd(12)) / insRate : 4); }
    if (now + ahead > N.owl) { if (night > 0.5 && P.birds > 0.15) spawn('owl', N.owl, 30, 90, 4, 15, 0.8); N.owl = Math.max(N.owl, now) + 14 + rnd(26); }
    const wispRate = P.wisps * (0.5 + night);
    if (now + ahead > N.wisp) { if (wispRate > 0.1) spawn('wisp', N.wisp, 5, 30, 1, 6, 0.7); N.wisp = Math.max(N.wisp, now) + (wispRate > 0.1 ? (5 + rnd(10)) / wispRate : 4); }
    if (night > 0.05 && P.insects > 0) for (const c of this.crickets) {                                       // crickets: fixed spots, rerolled now and then
      if (now > c.reroll) { const a = rnd(Math.PI * 2), d = rnd(6, 20); c.x = x + Math.sin(a) * d; c.z = z + Math.cos(a) * d; c.y = y; c.reroll = now + 20 + rnd(20); c.t = Math.max(c.t, now + rnd(1)); }
      if (now + ahead > c.t) { A._tmpPos.set(c.x, c.y, c.z); A.play('cricket', { pos: A._tmpPos, vol: 0.75 * night * Math.min(1, P.insects), at: c.t, bus: 'ambient', pitch: 0.95 + rnd(0.1) }); c.t += c.gap * (0.9 + rnd(0.2)); }
    }
  }
}
export const ZONE_NAMES = Object.keys(ZONES);
