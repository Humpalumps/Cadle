/**
 * music.js — game music. Primary path: the AI-composed themes (audio.buffers['field-theme'|'night-theme']) played as seamless loops with a 1.6 s
 * equal-power-ish crossfade at the seam and a 2 s fade between themes ('combat' rides the current theme; the sfx-side bus duck handles intensity).
 * Fallback (buffers not decoded yet / missing): generative FF14-style field music — slow chords in D dorian with a lydian colour chord, detuned-saw
 * pads through a breathing lowpass + soft sub root, and an FM-bell lead playing a recurring 2-bar MOTIF that cadences at phrase ends.
 * Everything is booked a few hundred ms ahead from schedule(now); nodes self-clean on `onended`. Tracks: 'field' | 'night' | 'combat' | null. `mode` = 'buffer'|'synth'.
 *
 * REGION THEMES (`music.region`, set by Audio from BIOMES[id].music). Every region has its OWN recorded
 * piece — `<music>-theme` in the manifest — and crossing a border cross-fades to it over 2 s. That swap is
 * the point: you should be able to tell which region you are in with your eyes shut. A region theme plays
 * at every hour; only the home bowl still swaps day/night. The REGION table below is the fallback colouring
 * (playback rate + tilt filter + reverb send) for a region whose buffer is missing or still decoding, and
 * the reverb send is used in both cases — that one describes the space, not the tune.
 */
import { mtof, rnd } from './synth.js';

const CHORDS = [
  { n: [50, 57, 60, 64], next: [1, 2, 3, 4] },      // Dm9 (home)
  { n: [55, 59, 62, 64], next: [0, 2, 5] },         // G6/9
  { n: [57, 60, 64, 67], next: [3, 0, 4] },         // Am7
  { n: [48, 55, 59, 62], next: [0, 1, 5] },         // Cmaj9
  { n: [53, 60, 64, 71], next: [1, 0, 3] },         // Fmaj7#11 (lydian)
  { n: [52, 59, 62, 67], next: [0, 2, 1] },         // Em7
];
const PHRASE = [0.7, 0.9, 1.15, 0.8];               // 4-chord intensity arc: rise into bar 3, relax
const MOTIF = [0, 2, 3, 2, 1, 3, 2, 0, 0, 2, 3, 1, 2, 1, 0, 0];   // hummable 2-bar contour (chord-tone indices), ends home = cadence
const pick = (a) => a[(Math.random() * a.length) | 0];

// per-region: [playbackRate, tilt cutoff Hz, reverb send]. rate 1 / 20000 / 0.5 == the Vale, unchanged.
const REGION = {
  field:       [1.00, 20000, 0.50],
  wood:        [0.97,  5200, 0.62],   // Whisperwood Deep: close, damp, everything under a canopy
  frost:       [0.94,  9000, 0.78],   // Frostveil: thin and far, long tail off the ice
  choir:       [1.05, 20000, 0.85],   // Celestial: lifted a semitone-ish, cathedral tail
  drums:       [0.96,  6500, 0.55],   // Dragon Peaks: heavier, drier
  forge:       [0.91,  3400, 0.35],   // Infernal: airless, muffled, hot
  convergence: [1.02, 14000, 0.80],   // Lost Realm: wide and ceremonial
  fen:         [0.90,  2600, 0.45],   // Shadowfen: sunk, choked
  deep:        [0.86,  1900, 0.90],   // Sunken Kingdom: heard through water
  void:        [0.80,  2200, 0.70],   // The Void: dragging, wrong
};

export class Music {
  constructor(audio) { this.audio = audio; this.region = 'field'; this._rate = 1; this._tilt = null;
    this.track = 'field'; this.playing = false; this.chord = 0; this.notes = CHORDS[0].n; this.nextChord = 0; this.nextArp = 0; this.arpNote = 2; this.step = 60 / 72 / 2; this.nextPulse = 0; this.live = 0; this.phraseI = 0; this.inten = 1; this.mode = 'synth'; this._cur = null; }
  start(ctx, bus, rev) {
    this.ctx = ctx; this.rev = rev; this.playing = true; this._cur = null;
    this.gain = ctx.createGain(); this.gain.gain.value = 1; this.gain.connect(bus);
    const now = ctx.currentTime; this.nextChord = now + 0.05; this.nextArp = now + 1.6; this.nextPulse = now + 0.5; this.chord = 0; this.live = 0; this.phraseI = 0; this.inten = 1;
  }
  stop(fade = 2.5) {
    if (!this.playing) return; this.playing = false;
    const g = this.gain, now = this.ctx.currentTime; g.gain.setTargetAtTime(0, now, fade / 4); setTimeout(() => g.disconnect(), fade * 1000 + 200);
    if (this._cur) { try { this._cur.src.stop(now + fade + 0.2); } catch {} this._cur = null; }
  }
  /** Book music until now + ahead. Buffer mode (AI themes decoded): looping theme with crossfades; else generative synth fallback. */
  schedule(now, ahead = 0.4) {
    if (!this.playing) return;
    const key = this._themeKey(), buf = this.audio.buffers?.[key];                                          // 'combat' rides the current theme (bus duck + pulse layer)
    if (buf) {
      this.mode = 'buffer'; this._buffer(now, key, buf);
      this.nextChord = this.nextArp = now + ahead;                                                          // keep the synth clock pinned so a fallback re-entry can't burst-schedule
      if (this.track === 'combat') { while (this.nextPulse < now + ahead) this._pulse(this.nextPulse); } else this.nextPulse = now + ahead;
      return;
    }
    this.mode = 'synth';
    while (this.nextChord < now + ahead) this._chord(this.nextChord);
    while (this.nextArp < now + ahead) this._arp(this.nextArp);
    if (this.track === 'combat') while (this.nextPulse < now + ahead) this._pulse(this.nextPulse);
    else this.nextPulse = now + ahead;
  }
  _buffer(now, key, buf) {
    const XF = 1.6;                                                                                         // loop-seam crossfade
    let c = this._cur;
    if (c && c.key !== key) {                                                                               // theme switch (field <-> night): fade old out over 2 s
      const g = c.g.gain; g.cancelScheduledValues(now); g.setValueAtTime(Math.max(0.0001, g.value), now); g.linearRampToValueAtTime(0.0001, now + 2);
      try { c.src.stop(now + 2.1); } catch {}
      this._cur = c = null;
    }
    if (!c) this._cur = this._playBuf(key, buf, now + 0.03, XF);
    else if (now + 0.6 > c.xfadeAt) this._cur = this._playBuf(key, buf, c.xfadeAt, XF);                     // book the next pass; the old one fades itself out
  }
  /**
   * Which piece is playing. A region with its own theme plays it at every hour — that is the whole point
   * of the border crossing: the music you hear IS the place. Only the home bowl still swaps day/night.
   * Falls back to the Vale theme (and then to the synth) whenever a region's buffer has not decoded yet.
   */
  _themeKey() {
    const r = this.region;
    if (r && r !== 'field' && this.audio.buffers?.[`${r}-theme`]) return `${r}-theme`;
    return (this.track === 'night' ? 'night' : 'field') + '-theme';
  }

  /** Region tilt: one shared lowpass between the music and its bus, retuned on a slow ramp. */
  _regionNode() {
    if (!this._tilt) {
      this._tilt = this.ctx.createBiquadFilter();
      this._tilt.type = 'lowpass'; this._tilt.frequency.value = 20000; this._tilt.Q.value = 0.4;
      this._tilt.connect(this.gain);
    }
    return this._tilt;
  }
  /** Called by Audio when the player's region changes. Ramps, never cuts. */
  setRegion(id) {
    // A region with its own recorded theme is played STRAIGHT (rate 1, filter open): the tilt/tempo
    // colouring below only ever existed to fake a different piece out of the Vale's. Its reverb send is
    // kept either way — that one is about the space you are standing in, not about the tune.
    const own = id && id !== 'field' && this.audio.buffers?.[`${id}-theme`];
    const R = REGION[id] ?? REGION.field;
    this.region = id; this._rate = own ? 1 : R[0]; this._revSend = R[2];
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this._regionNode().frequency.setTargetAtTime(own ? 20000 : R[1], now, 1.2);
    if (this._cur?.src) this._cur.src.playbackRate.setTargetAtTime(this._rate, now, 2.0);   // tempo/pitch drift, not a jump
  }
  _playBuf(key, buf, t, XF) {
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    const rate = this._rate || 1, end = t + buf.duration / rate;
    src.buffer = buf; src.playbackRate.value = rate;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(1, t + XF);
    g.gain.setValueAtTime(1, end - XF); g.gain.linearRampToValueAtTime(0.0001, end);
    src.connect(g); g.connect(this._regionNode());
    if (this.rev && this._revSend) { const s = ctx.createGain(); s.gain.value = this._revSend * 0.5; g.connect(s); s.connect(this.rev); src.onended = () => s.disconnect(); }
    src.start(t); src.stop(end + 0.05);
    src.addEventListener?.('ended', () => { src.disconnect(); g.disconnect(); });
    return { src, g, key, xfadeAt: end - XF };
  }
  _pan(t) {   // stereo panner helper (offline ctx has it too; guard anyway)
    if (!this.ctx.createStereoPanner) return null; const p = this.ctx.createStereoPanner(); p.pan.value = t; return p;
  }
  _chord(t) {
    const ctx = this.ctx, C = CHORDS[this.chord], night = this.track === 'night';
    this.chord = pick(C.next); this.notes = C.n;
    const inten = this.inten = PHRASE[this.phraseI] * (0.95 + rnd(0.1)); this.phraseI = (this.phraseI + 1) % PHRASE.length;
    const dur = (night ? 9 : 7) + rnd(4), att = 2.4, rel = 3.2, end = t + dur + rel;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(inten, t + att); g.gain.setValueAtTime(inten, t + dur); g.gain.linearRampToValueAtTime(0, end);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = (night ? 1250 : 1650) * (0.8 + 0.35 * inten); lp.Q.value = 0.9;   // open enough that the pad has presence, not a dark drone
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 210; hp.Q.value = 0.7;   // thin the pad's low end: the melody owns the mix, the pad is colour
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.06 + rnd(0.04); lg.gain.value = night ? 380 : 520; lfo.connect(lg); lg.connect(lp.frequency); lfo.start(t); lfo.stop(end + 0.1);
    lp.connect(hp); hp.connect(g); g.connect(this.gain); if (this.rev) { const s = ctx.createGain(); s.gain.value = 0.55; g.connect(s); s.connect(this.rev); }
    const nodes = [g, lp, hp, lfo, lg];
    const osc = (type, m, det, vol, pan = 0, to = lp) => {
      const o = ctx.createOscillator(), og = ctx.createGain(); o.type = type; o.frequency.value = mtof(m); o.detune.value = det; og.gain.value = vol;
      const p = pan ? this._pan(pan) : null;
      o.connect(og); if (p) { og.connect(p); p.connect(to); } else og.connect(to);
      o.start(t); o.stop(end + 0.1); nodes.push(o, og); if (p) nodes.push(p); return o;
    };
    let i = 0;
    for (const m of C.n) { osc('sawtooth', m, -9 + rnd(-3, 3), 0.05, -0.95); osc('sawtooth', m, 9 + rnd(-3, 3), 0.05, 0.95); osc('triangle', m + 12, rnd(-4, 4), night ? 0.055 : 0.07, (i++ % 2 ? 0.75 : -0.75) + rnd(-0.15, 0.15)); }   // detuned saws hard L/R = wide pad; octave triangles alternate sides
    const sub = osc('sine', C.n[0] - 12, 0, 0.055, 0, g);                                           // small centered sub root, bypasses the filters
    sub.onended = () => { for (const n of nodes) n.disconnect(); this.live--; };
    this.live++; this.nextChord = t + dur;
  }
  _arp(t) {
    const night = this.track === 'night', rest = (night ? 0.42 : 0.34) / this.inten;                // busier when the phrase swells
    this.nextArp = t + this.step * (Math.random() < 0.15 ? 2 : 1);
    if (Math.random() < rest) return;
    const n = this.notes;
    this.motifI = ((this.motifI ?? -1) + 1) % MOTIF.length;                                          // recurring 2-bar motif over chord tones, cadences home at phrase end (not a random walk)
    this.arpNote = MOTIF[this.motifI] % n.length;
    const oct = this.motifI >= 8 && MOTIF[this.motifI] >= 2 ? 24 : 12, f = mtof(n[this.arpNote] + oct);   // second half answers the phrase an octave up
    this._side = -(this._side || 1);                                                                // lead alternates sides = wide, decorrelated melody
    this._bell(t, f, (night ? 0.36 : 0.42) * (0.8 + 0.3 * this.inten), 0.9 + rnd(0.5), this._side * (0.5 + rnd(0.4)));
    if (Math.random() < 0.12) this._bell(t + this.step * 0.5, f * 1.5, 0.2, 0.7, -this._side * (0.5 + rnd(0.4)));   // ornament a fifth up, answered from the other side
  }
  _bell(t, f, vol, dur, pan = 0) {
    const ctx = this.ctx, c = ctx.createOscillator(), m = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain();
    c.frequency.value = f; m.frequency.value = f * 2; mg.gain.setValueAtTime(f * 2.8, t); mg.gain.exponentialRampToValueAtTime(1, t + dur * 0.6);   // brighter strike, decays to pure tone
    const p = pan ? this._pan(pan) : null;
    m.connect(mg); mg.connect(c.frequency); c.connect(g); if (p) { g.connect(p); p.connect(this.gain); } else g.connect(this.gain);
    const h = ctx.createOscillator(), hg = ctx.createGain(); h.frequency.value = f * 2; hg.gain.setValueAtTime(0, t); hg.gain.linearRampToValueAtTime(vol * 0.6, t + 0.008); hg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.7);
    h.connect(hg); hg.connect(p ?? this.gain); h.start(t); h.stop(t + dur * 0.7 + 0.05);            // octave partial: gives the bell air >900 Hz
    const h2 = ctx.createOscillator(), h2g = ctx.createGain(); h2.frequency.value = f * 3.01; h2g.gain.setValueAtTime(0, t); h2g.gain.linearRampToValueAtTime(vol * 0.28, t + 0.006); h2g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.45);
    h2.connect(h2g); h2g.connect(p ?? this.gain); h2.start(t); h2.stop(t + dur * 0.45 + 0.05);      // 12th partial: shimmer strike
    let s = null; if (this.rev) { s = ctx.createGain(); s.gain.value = 0.7; g.connect(s); s.connect(this.rev); }
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    c.start(t); m.start(t); c.stop(t + dur + 0.05); m.stop(t + dur + 0.05);
    c.onended = () => { c.disconnect(); m.disconnect(); mg.disconnect(); g.disconnect(); s?.disconnect(); p?.disconnect(); h.disconnect(); hg.disconnect(); h2.disconnect(); h2g.disconnect(); };
  }
  _pulse(t) {                                                                                      // combat: soft low pulse on the root, 8ths
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), f = mtof(this.notes[0] - 12);
    o.type = 'triangle'; o.frequency.value = f; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g); g.connect(this.gain); o.start(t); o.stop(t + 0.3); o.onended = () => { o.disconnect(); g.disconnect(); };
    this.nextPulse = t + this.step;
  }
}
