/**
 * synth.js — shared WebAudio primitives (pure: no game refs; usable on OfflineAudioContext for self-tests).
 * A "synth frame" S = { ctx, t (start time, ctx seconds), out (destination GainNode), noise (white AudioBuffer), p (pitch mult), nodes[] }.
 * Every helper registers the nodes it creates in S.nodes so the owner can disconnect them when the voice is released.
 */
export const EPS = 0.0001;
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const rnd = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));

export function makeNoise(ctx, secs = 2, pink = false) {
  const n = Math.floor(ctx.sampleRate * secs), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  if (!pink) { for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; return buf; }
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;                  // Paul Kellet pink-noise filter
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
  }
  return buf;
}

/** Procedural hall impulse: pre-delay + early reflections + exponentially decaying noise that gets darker over time. */
export function makeImpulse(ctx, secs = 1.8, decay = 3.2) {
  const sr = ctx.sampleRate, n = Math.floor(sr * secs), buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c); let lp = 0; const pre = Math.floor(sr * 0.014);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr, env = Math.exp(-decay * t);
      const k = 0.25 + 0.7 * Math.min(1, t / secs);                               // one-pole lowpass that closes as the tail decays
      lp += ((Math.random() * 2 - 1) - lp) * (1 - k);
      d[i] = lp * env * 1.6;
    }
    for (const [ms, g] of [[19, 0.55], [31, 0.4], [47, 0.3], [63, 0.22]]) { const i = pre + Math.floor(sr * ms / 1000 * (c ? 1.07 : 1)); if (i < n) d[i] += g * (c ? -1 : 1); }
  }
  return buf;
}

export function mk(S, node) { S.nodes.push(node); return node; }
/** Gain with attack/hold/decay envelope (exponential decay) connected to `to`. */
export function genv(S, t0, peak, att, dec, hold = 0, to = S.out, curve = 'exp') {
  const g = mk(S, S.ctx.createGain()), p = g.gain;
  p.setValueAtTime(EPS, t0); p.linearRampToValueAtTime(Math.max(EPS, peak), t0 + att);
  if (hold > 0) p.setValueAtTime(Math.max(EPS, peak), t0 + att + hold);
  if (curve === 'exp') p.exponentialRampToValueAtTime(EPS, t0 + att + hold + dec); else p.linearRampToValueAtTime(0, t0 + att + hold + dec);
  g.connect(to); return g;
}
export function filt(S, type, f, q = 1) { const b = mk(S, S.ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }

/** Noise burst through a swept filter. f0->f1 over dur (exp), gain env att/hold/dec. */
export function noise(S, { t = 0, dur = 0.1, att = 0.002, hold = 0, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, gain = 1, rate = 1, to = S.out, curve = 'exp' } = {}) {
  const t0 = S.t + t, src = mk(S, S.ctx.createBufferSource()); src.buffer = S.noise; src.loop = true; src.playbackRate.value = rate * (0.9 + S.p * 0.1);
  src.loopStart = Math.random() * 1.0;                                              // decorrelate simultaneous bursts
  const f = filt(S, type, f0 * S.p, q); if (f1 !== f0) { f.frequency.setValueAtTime(f0 * S.p, t0); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * S.p), t0 + att + hold + dur); }
  const g = genv(S, t0, gain, att, dur, hold, to, curve);
  src.connect(f); f.connect(g); src.start(t0, src.loopStart); src.stop(t0 + att + hold + dur + 0.03);
  return g;
}
/** Oscillator with frequency sweep f0->f1 and gain env. */
export function tone(S, { t = 0, type = 'sine', f0 = 440, f1 = f0, dur = 0.2, att = 0.003, hold = 0, gain = 0.5, detune = 0, to = S.out, curve = 'exp', sweep = 'exp', sweepDur } = {}) {
  const t0 = S.t + t, o = mk(S, S.ctx.createOscillator()); o.type = type; o.detune.value = detune;
  o.frequency.setValueAtTime(f0 * S.p, t0);
  if (f1 !== f0) { const te = t0 + (sweepDur ?? att + hold + dur); if (sweep === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(10, f1 * S.p), te); else o.frequency.linearRampToValueAtTime(f1 * S.p, te); }
  const g = genv(S, t0, gain, att, dur, hold, to, curve);
  o.connect(g); o.start(t0); o.stop(t0 + att + hold + dur + 0.03);
  return g;
}
/** FM bell/blip: sine carrier fc, modulator at fc*ratio with index decaying over dur. Sparkles, chimes, birds. */
export function fm(S, { t = 0, fc = 880, f1 = fc, ratio = 2, index = 3, idx1 = 0, dur = 0.3, att = 0.004, gain = 0.3, to = S.out, sweep = 'exp' } = {}) {
  const t0 = S.t + t, c = mk(S, S.ctx.createOscillator()), m = mk(S, S.ctx.createOscillator()), mg = mk(S, S.ctx.createGain());
  c.frequency.setValueAtTime(fc * S.p, t0); m.frequency.setValueAtTime(fc * S.p * ratio, t0);
  if (f1 !== fc) { const te = t0 + att + dur; if (sweep === 'exp') { c.frequency.exponentialRampToValueAtTime(f1 * S.p, te); m.frequency.exponentialRampToValueAtTime(f1 * S.p * ratio, te); } else { c.frequency.linearRampToValueAtTime(f1 * S.p, te); m.frequency.linearRampToValueAtTime(f1 * S.p * ratio, te); } }
  mg.gain.setValueAtTime(index * fc * S.p, t0); mg.gain.exponentialRampToValueAtTime(Math.max(1, idx1 * fc * S.p), t0 + att + dur);
  m.connect(mg); mg.connect(c.frequency);
  const g = genv(S, t0, gain, att, dur, 0, to);
  c.connect(g); c.start(t0); m.start(t0); c.stop(t0 + att + dur + 0.03); m.stop(t0 + att + dur + 0.03);
  return g;
}
/** Mechanical click: very short highpassed noise + optional metallic ring. */
export function click(S, { t = 0, gain = 0.4, f = 3000, dur = 0.004, ring = 0, ringF = 2800, to = S.out } = {}) {
  noise(S, { t, dur, att: 0.0005, type: 'highpass', f0: f, q: 0.7, gain, to });
  if (ring > 0) tone(S, { t, type: 'sine', f0: ringF, f1: ringF * 0.9, dur: 0.035, att: 0.001, gain: ring, to });
}
/** Play a decoded AudioBuffer (asset take). Honors buf._onset (leading-silence/charge trim). dec>0 = exponential decay envelope (shortens the take). */
export function sample(S, buf, { t = 0, rate = 1, gain = 1, dec = 0, to = S.out } = {}) {
  const t0 = S.t + t, off = buf._onset ?? 0, src = mk(S, S.ctx.createBufferSource());
  src.buffer = buf; src.playbackRate.value = rate;
  const full = (buf.duration - off) / rate, d = dec > 0 ? Math.min(dec, full) : full;
  let g;
  if (dec > 0) g = genv(S, t0, gain, 0.003, d, 0, to);
  else { g = mk(S, S.ctx.createGain()); g.gain.value = gain; g.connect(to); }
  src.connect(g); src.start(t0, off); src.stop(t0 + d + 0.1);
  return d;
}
/** tanh waveshaper saturation stage -> gain -> to. Returns the shaper (route layers into it). Curves cached per amount. */
const _driveCurves = new Map();
export function drive(S, { amount = 3, gain = 1, to = S.out } = {}) {
  let c = _driveCurves.get(amount);
  if (!c) { c = new Float32Array(257); const k = Math.tanh(amount); for (let i = 0; i < 257; i++) { const x = i / 128 - 1; c[i] = Math.tanh(amount * x) / k; } _driveCurves.set(amount, c); }
  const ws = mk(S, S.ctx.createWaveShaper()); ws.curve = c; ws.oversample = '2x';
  const g = mk(S, S.ctx.createGain()); g.gain.value = gain; ws.connect(g); g.connect(to);
  return ws;
}
/** Short inharmonic metallic ring: 3 detuned partials at bell-like non-integer ratios (1 / 1.83 / 2.76). */
export function metal(S, { t = 0, f = 1900, dur = 0.08, gain = 0.2, to = S.out } = {}) {
  for (const [m, g] of [[1, 1], [1.83, 0.62], [2.76, 0.38]])
    tone(S, { t, type: 'square', f0: f * m * (1 + rnd(-0.025, 0.025)), f1: f * m * 0.93, dur: dur * (1 - 0.12 * m), att: 0.0008, gain: gain * g, to });
}
/** Feedback echo bus: returns an input GainNode; whatever connects to it repeats every `time` s with `fb` decay through a lowpass. */
export function echo(S, { time = 0.18, fb = 0.35, lp = 1800, gain = 0.6, to = S.out } = {}) {
  const inp = mk(S, S.ctx.createGain()), d = mk(S, S.ctx.createDelay(1)), f = filt(S, 'lowpass', lp, 0.7), fbg = mk(S, S.ctx.createGain()), outg = mk(S, S.ctx.createGain());
  d.delayTime.value = time; fbg.gain.value = fb; outg.gain.value = gain;
  inp.connect(d); d.connect(f); f.connect(fbg); fbg.connect(d); f.connect(outg); outg.connect(to);
  return inp;
}
/** Sustained looping noise through a filter with optional LFOs on cutoff and on a unity modulation stage (so `g` stays a clean level control).
 * wide=true builds two decorrelated chains hard-panned L/R (D2/FF14-style wide beds); f2/m2 are the right-side filter/mod stage (null when mono). */
export function bed(S, { type = 'bandpass', f0 = 500, q = 1, gain = 0.1, pink = null, lfoF = 0, lfoA = 0, lfoGainF = 0, lfoGainA = 0, wide = false, to = S.out } = {}) {
  const ctx = S.ctx, g = mk(S, ctx.createGain()); g.gain.value = gain; g.connect(to);
  const chain = (pan) => {
    const src = mk(S, ctx.createBufferSource()); src.buffer = pink ?? S.noise; src.loop = true; src.loopStart = Math.random();
    const f = filt(S, type, f0, q), m = mk(S, ctx.createGain()); m.gain.value = 1;
    src.connect(f); f.connect(m);
    if (pan && ctx.createStereoPanner) { const p = mk(S, ctx.createStereoPanner()); p.pan.value = pan; m.connect(p); p.connect(g); } else m.connect(g);
    src.start(S.t, src.loopStart); return { src, f, m };
  };
  const A = chain(wide ? -1 : 0), B = wide ? chain(1) : null;   // hard-pan: each chain is its own noise read position -> truly decorrelated L/R
  if (lfoF > 0) lfo(S, lfoF, lfoA, B ? [A.f.frequency, B.f.frequency] : A.f.frequency);
  if (lfoGainF > 0) { lfo(S, lfoGainF, lfoGainA, A.m.gain); if (B) lfo(S, lfoGainF * 1.13, lfoGainA, B.m.gain); }   // slightly offset gust rate per side
  return { src: A.src, f: A.f, m: A.m, f2: B?.f ?? null, m2: B?.m ?? null, g };
}
/** Oscillator LFO -> gain(amp) -> AudioParam (or array of params). */
export function lfo(S, freq, amp, param, type = 'sine') {
  const l = mk(S, S.ctx.createOscillator()), lg = mk(S, S.ctx.createGain()); l.type = type; l.frequency.value = freq; lg.gain.value = amp; l.connect(lg);
  for (const p of Array.isArray(param) ? param : [param]) lg.connect(p);
  l.start(S.t); return l;
}
