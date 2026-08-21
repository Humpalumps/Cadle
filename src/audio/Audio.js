/**
 * Audio: WebAudio. All SFX procedurally synthesized (no asset downloads): layered noise bursts + tonal bodies for gunshots
 * (distinct per archetype: hand cannon = heavy crack + long tail, auto rifle = tight snappy, shotgun = deep boom, sniper = sharp crack + echo,
 * pulse = 3-round burst, fusion = charge whine + release), footsteps per surface, impacts, ability whooshes, UI ticks.
 * Ambient: wind + birds/insects layered by time of day + zone; music: generative pad/arpeggio in FF14-ish modal key (soft, mystical).
 *
 * API:
 *   audio.play(name, { pos?:Vector3, vol=1, pitch=1, loop=false, at?:ctxTime, bus?:'sfx'|'ambient'|'music' }) -> handle { stop(), setPos(v) }
 *   names (minimum): 'shot-handcannon','shot-autorifle','shot-pulse','shot-shotgun','shot-sniper','shot-fusion','fusion-charge','reload','empty','swap',
 *     'hit','crit','kill','impact-terrain','impact-rock','impact-enemy','explosion','footstep-grass','footstep-rock','footstep-water','jump','land','slide',
 *     'ability-grenade','ability-melee','ability-class','ability-super','enemy-hurt','enemy-death','ui-click','ui-hover','pickup','levelup'
 *     extra: 'enemy-shot','enemy-attack','shield-break','player-hurt','player-died','ability-ready','bird','insect','cricket','owl','wisp'  (audio.names = all)
 *   audio.music(track|null)  ('field' | 'night' | 'combat'), audio.ambient(zone|null) (zone override: meadow|forest|lake|ruins|crystal|arena|mountain; null = auto from position),
 *   audio.setMaster(v), audio.setSfxVol(v), audio.setMusicVol(v), audio.setAmbientVol(v), audio.volumes
 *   Listens to events itself: 'combat:hit','combat:impact','combat:explosion','combat:kill','weapon:fire/reload/empty/swap','player:jump/land/slide/footstep/died',
 *     'enemy:death/attack/shieldbreak','ability:use/ready','rpg:levelup','rpg:pickup'. Same-name plays within 8 ms are deduped, so systems that call
 *     audio.play() directly AND emit the event don't double-trigger.
 *   Must resume AudioContext on first user gesture (click/keydown). In auto mode (game.auto) stays silent (no AudioContext) but still tracks state:
 *     audio.debugLastPlayed (last 64 {name,t,pos}), audio.debugCounts, audio.state(). audio.unlock(true) forces a live context even in auto mode.
 *   Self-checks (OfflineAudioContext, no speakers needed): audio.selfTest(names?) -> { ok, results:{name:{rms,peak,dur,ok}} },
 *     audio.render(name, secs) / renderMusic(secs, track) / renderAmbient(secs, zone) -> { sr, data:Float32Array } for offline inspection.
 * Graph: voices (pre gain -> [PannerNode equalpower, inverse rolloff -> distance lowpass (air absorption)] -> post gain -> bus, post -> reverb send)
 *   -> sfx/ambient/music/fb buses -> master -> compressor -> limiter -> destination; reverb = ConvolverNode with a procedural hall impulse (ambient bus
 *   also sends 0.16). 'fb' = feedback ticks (hit/crit/kill) that briefly duck the sfx bus so they read under autofire. Shots get ±3% per-play pitch/level
 *   round-robin (rec.vary); 'explosion' scales duration/sub content by the event radius and is rate-limited (rec.gap). Ambient beds + music pads are
 *   wide stereo (decorrelated L/R chains / panned saw pairs). Voices are pooled (32, 16 on q=low) with oldest-steal.
 */
import * as THREE from 'three';
import { makeNoise, makeImpulse, EPS } from './synth.js';
import { SFX, SFX_NAMES } from './sfx.js';
import { Ambient } from './ambient.js';
import { Music } from './music.js';
import { BIOMES } from '../world/Biomes.js';

const NOOP = Object.freeze({ stop() {}, setPos() {} });
const EMPTY = Object.freeze({});
const MAX_LOG = 64, MAX_PER_FRAME = 14, DEDUPE = 0.008;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Audio {
  constructor(game) {
    this.game = game; this.ctx = null; this.unlocked = false; this.names = SFX_NAMES;
    this.volumes = { master: 0.9, sfx: 1, music: 0.3, ambient: 0.55 };
    this.panningModel = 'equalpower';                         // 'HRTF' is ~4x the panner cost; equalpower + inverse rolloff reads fine for an FPS
    this.maxVoices = game.quality === 'low' ? 16 : 32;
    this.voices = []; this._last = new Map(); this._perFrame = 0; this._gen = 0;
    this._vo = null; this._voGen = 0; this._voQueue = [];   // dialogue is a SINGLE channel, and lines QUEUE rather than cut each other off
    this.debugLastPlayed = []; this.debugCounts = {};
    this.musicTrack = 'field'; this.ambientZone = null; this.zone = 'meadow';
    this.buffers = {};                                      // decoded AI takes (shot-*-1..4, explosion-1..4, field/night-theme); recipes read them via S.bufs
    this._musicAuto = true; this._musicDuck = 1; this._voiceDuck = 1; this._inCombat = false; this._combatT = -1e9; this._musicT = 0;
    this.ambientSys = new Ambient(this); this.musicSys = new Music(this);
    this._tmpPos = new THREE.Vector3(); this._fwd = new THREE.Vector3(); this._up = new THREE.Vector3(); this._zoneT = 0; this._lastPX = null; this._lastPZ = 0; this._zoneFast = false;
  }

  init() {
    const g = this.game, ev = g.events, P = () => g.player;
    const fromPlayer = (o) => o == null || o === P() || o === P()?.target || o?.kind === 'player';
    const combat = () => { this._combatT = g.time; };                                                // drives the music combat duck (see _trackTick)
    ev.on('weapon:fire', (e) => { combat(); this.play('shot-' + (e?.weapon?.archetype ?? e?.weapon?.def?.archetype ?? 'handcannon')); });
    ev.on('weapon:reload', (e) => this.play('reload', { arch: e?.weapon?.archetype })); ev.on('weapon:empty', () => this.play('empty')); ev.on('weapon:swap', () => this.play('swap'));
    ev.on('combat:hit', (e) => {
      if (!e) return; combat();
      if (e.target?.kind === 'player') { this.play('player-hurt', { vol: clamp(0.5 + (e.amount || 0) / 40, 0.5, 1.2) }); return; }
      if (!fromPlayer(e.owner)) return;
      if (!e.killed) this.play(e.crit ? 'crit' : 'hit');
      this.play('impact-enemy', { pos: e.point, vol: 0.7 });
    });
    ev.on('combat:kill', (e) => { if (fromPlayer(e?.owner)) this.play('kill'); });
    ev.on('combat:impact', (e) => { if (e) this.play(e.surface === 'rock' || e.surface === 'prop' ? 'impact-rock' : 'impact-terrain', { pos: e.point }); });
    ev.on('combat:explosion', (e) => { if (e) this.play('explosion', { pos: e.point, vol: clamp(0.3 + (e.radius ?? 3) / 7, 0.35, 1.25), radius: e.radius }); });   // recipe scales duration/sub by radius
    ev.on('player:jump', (e) => this.play('jump', { vol: e?.n === 2 ? 0.8 : 1 }));
    ev.on('player:land', (e) => { const imp = e?.impact ?? 5; this.play('land', { vol: clamp(imp / 9, 0.35, 1.5), hard: !!e?.hard }); });
    ev.on('player:slide', () => this.play('slide'));
    ev.on('player:footstep', (e) => this.play('footstep-' + (e?.surface === 'water' ? 'water' : e?.surface === 'rock' ? 'rock' : 'grass'), { vol: e?.crouched ? 0.45 : e?.sprint ? 1.1 : 0.8, pitch: 0.94 + Math.random() * 0.12 }));
    ev.on('player:died', () => this.play('player-died'));
    ev.on('enemy:death', (e) => this.play('enemy-death', { pos: e?.enemy?.center ?? e?.enemy?.position }));
    ev.on('enemy:attack', (e) => { this._combatT = g.time; if (e?.kind === 'bite' || e?.kind === 'slam') this.play('enemy-attack', { pos: e.enemy?.center ?? e.enemy?.position }); });   // ranged kinds already play 'enemy-shot'
    ev.on('enemy:shieldbreak', (e) => this.play('shield-break', { pos: e?.enemy?.center ?? e?.enemy?.position }));
    ev.on('ability:use', (e) => { if (e?.id) this.play('ability-' + e.id); });
    ev.on('ability:ready', () => this.play('ability-ready'));
    ev.on('rpg:levelup', () => this.play('levelup')); ev.on('rpg:pickup', () => this.play('pickup'));
    ev.on('ui:click', () => this.play('ui-click')); ev.on('ui:hover', () => this.play('ui-hover'));
    if (!g.auto) {
      this._createCtx();
      const un = () => this.unlock();
      for (const t of ['pointerdown', 'keydown', 'click', 'touchstart']) window.addEventListener(t, un, { capture: true, passive: true });
    }
    this._decodeAssets();                                                                            // fire-and-forget; synth fallback covers until decoded (auto mode decodes via OfflineAudioContext so selfTest/render measure the real takes)
  }

  /** Decode the AI-generated takes (Assets preloads raw bytes) into this.buffers. Shot/explosion takes get onset-trimmed (mp3 priming silence; fusion also skips the baked charge whine — Weapons plays its own synth charge). */
  async _decodeAssets() {
    const A = this.game.assets; if (!A?.audioBuffer) return;
    const dctx = this.ctx ?? new OfflineAudioContext(1, 1, 48000);
    const names = ['field-theme', 'night-theme'];
    for (const a of ['handcannon', 'autorifle', 'sniper', 'shotgun', 'pulse', 'fusion']) for (let i = 1; i <= 4; i++) names.push(`shot-${a}-${i}`);
    for (let i = 1; i <= 4; i++) names.push(`explosion-${i}`);
    await Promise.all(names.map(async (n) => {
      const b = await A.audioBuffer(dctx, n); if (!b) return;
      if (n.startsWith('shot-') || n.startsWith('explosion-')) b._onset = this._onset(b, n.startsWith('shot-fusion') ? 0.5 : 0.18);
      this.buffers[n] = b;
    }));
  }
  _onset(buf, frac) {
    const d = buf.getChannelData(0); let peak = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    const th = peak * frac;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > th) return Math.max(0, i / buf.sampleRate - 0.01);
    return 0;
  }

  // ---------- context / graph ----------
  _createCtx() {
    if (this.ctx) return true;
    let ctx; try { ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }); } catch (e) { console.warn('audio: no AudioContext', e); return false; }
    this.ctx = ctx; const v = this.volumes;
    this.master = ctx.createGain(); this.master.gain.value = v.master;
    this.comp = ctx.createDynamicsCompressor(); const c = this.comp; c.threshold.value = -10; c.knee.value = 12; c.ratio.value = 2.5; c.attack.value = 0.004; c.release.value = 0.18;   // gentle glue; shots duck the beds a little (Destiny-style)
    this.limiter = ctx.createDynamicsCompressor(); const l = this.limiter; l.threshold.value = -1.5; l.knee.value = 0; l.ratio.value = 20; l.attack.value = 0.001; l.release.value = 0.06;
    this.master.connect(c); c.connect(l); l.connect(ctx.destination);
    this.buses = { sfx: ctx.createGain(), music: ctx.createGain(), ambient: ctx.createGain(), fb: ctx.createGain() };   // fb: feedback ticks (hit/crit/kill), bypasses the sfx duck
    this.buses.sfx.gain.value = v.sfx; this.buses.music.gain.value = v.music; this.buses.ambient.gain.value = v.ambient; this.buses.fb.gain.value = v.sfx;
    for (const b of Object.values(this.buses)) b.connect(this.master);
    this.reverbSend = ctx.createGain(); this.convolver = ctx.createConvolver(); this.convolver.buffer = makeImpulse(ctx, this.game.quality === 'low' ? 1.2 : 1.9, 3.2);
    this.reverbReturn = ctx.createGain(); this.reverbReturn.gain.value = 0.7;
    this.reverbSend.connect(this.convolver); this.convolver.connect(this.reverbReturn); this.reverbReturn.connect(this.master);
    const ambSend = ctx.createGain(); ambSend.gain.value = 0.16; this.buses.ambient.connect(ambSend); ambSend.connect(this.reverbSend);   // beds get a touch of hall
    this.noise = makeNoise(ctx, 2);
    return true;
  }
  /** Resume the context (call from a user gesture). force=true also creates the context in auto mode. */
  unlock(force = false) {
    if (!this.ctx && (force || !this.game.auto)) this._createCtx();
    if (!this.ctx) return;
    if (this.ctx.state === 'running') { this._onRunning(); return; }
    this.ctx.resume().then(() => { if (this.ctx.state === 'running') this._onRunning(); }).catch(() => {});
  }
  _onRunning() {
    if (this.unlocked) return; this.unlocked = true;
    this.ambientSys.zone = this.zone; this.ambientSys.start(this.ctx, this.buses.ambient);
    if (this.musicTrack) { this.musicSys.track = this.musicTrack; this.musicSys.start(this.ctx, this.buses.music, this.reverbSend); }
  }

  // ---------- public controls ----------
  setMaster(v) { this._setVol('master', v, this.master); }
  setSfxVol(v) { this._setVol('sfx', v, this.buses?.sfx); if (this.buses?.fb && this.ctx) this.buses.fb.gain.setTargetAtTime(this.volumes.sfx, this.ctx.currentTime, 0.05); }
  setMusicVol(v) { v = clamp(+v || 0, 0, 1.5); this.volumes.music = v; this._applyMusicGain(0.05); }
  /** Single writer for the music bus: volume x combat duck x dialogue duck. The dialogue duck used to write the
   *  gain node directly, which fought _trackTick — whichever ran last won, so the music could sit at the wrong
   *  level indefinitely. */
  _applyMusicGain(tau) {
    if (!this.buses?.music || !this.ctx) return;
    this.buses.music.gain.setTargetAtTime(this.volumes.music * this._musicDuck * this._voiceDuck, this.ctx.currentTime, tau);
  }
  setAmbientVol(v) { this._setVol('ambient', v, this.buses?.ambient); }
  _setVol(k, v, node) { v = clamp(+v || 0, 0, 1.5); this.volumes[k] = v; if (node && this.ctx) node.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  music(track) {
    this._musicAuto = track === 'auto';                                                              // explicit track pins it; 'auto' re-enables hour-driven field/night selection (the default)
    if (track === 'auto') { const h = this.game.sky?.hour ?? 12; track = h >= 19.5 || h < 5.5 ? 'night' : 'field'; }
    this.musicTrack = track || null; const m = this.musicSys;
    if (!this.unlocked) return;
    if (!track) m.stop(); else if (m.playing) m.track = track; else { m.track = track; m.start(this.ctx, this.buses.music, this.reverbSend); }
  }
  ambient(zone) { this.ambientZone = zone || null; this._zoneT = 9; }
  state() {
    let busy = 0; for (const v of this.voices) if (v.busy) busy++;
    return { ctx: this.ctx ? this.ctx.state : 'none', unlocked: this.unlocked, auto: this.game.auto, volumes: { ...this.volumes }, musicTrack: this.musicTrack, musicPlaying: this.musicSys.playing, musicLiveChords: this.musicSys.live,
      musicMode: this.musicSys.mode, musicAuto: this._musicAuto, combat: this._inCombat, buffers: Object.keys(this.buffers).length,
      zone: this.zone, zoneOverride: this.ambientZone, ambientRunning: this.ambientSys.running, voices: this.voices.length, busy, played: this.debugLastPlayed.length, counts: { ...this.debugCounts } };
  }

  // ---------- play ----------
  // Voice lines (quest dialogue): not in the SFX registry, decoded straight from game.assets.
  // Ducks music briefly so the Vale reads over the field theme.
  /** Stop whatever line is talking. Short ramp instead of a hard stop so cutting her off does not click. */
  stopVoice(fade = 0.12, keepDuck = false) {
    const vo = this._vo; this._vo = null;
    if (!keepDuck) this._voQueue.length = 0;
    if (!vo) return;
    const ctx = this.ctx, now = ctx.currentTime;
    try {
      vo.g.gain.cancelScheduledValues(now);
      vo.g.gain.setValueAtTime(vo.g.gain.value, now);
      vo.g.gain.linearRampToValueAtTime(0, now + fade);
      vo.src.stop(now + fade + 0.02);
    } catch (e) {}
    // keepDuck: a replacement line is starting immediately. Un-ducking here and re-ducking a millisecond later
    // captured the mid-ramp (already ducked) gain as the new base, and the music never came back up.
    if (!keepDuck) this._duckMusic(false);
  }
  /** Dialogue duck: a factor the single music-gain writer composes, so it stacks correctly with the combat duck. */
  _duckMusic(on) {
    this._voiceDuck = on ? 0.35 : 1;
    this._applyMusicGain(on ? 0.12 : 0.4);
  }
  /**
   * Play one dialogue line. The Vale is a SINGLE voice channel — starting a line stops the one before it.
   * Previously every call made its own BufferSource with nothing stopping the last, so two beats landing
   * close together (the opening quest's directive vs. arriving at the ruins) had her talking over herself.
   */
  playVoice(name, vol = 1, opts = EMPTY) {
    const ctx = this.ctx; if (!ctx || ctx.state !== 'running') return;
    // She is mid-sentence: wait her out rather than cutting her off. Clobbering the playing line stopped the
    // overlap but simply truncated it instead — the opening quest's marching order lost half its words to the
    // arrival line. Cap the backlog so a burst of beats cannot queue a monologue.
    if (this._vo && !opts.interrupt) {
      this._voQueue.push({ name, vol });
      if (this._voQueue.length > 2) this._voQueue.shift();
      return;
    }
    this._startVoice(name, vol);
  }
  _startVoice(name, vol) {
    const ctx = this.ctx;
    const gen = ++this._voGen;
    this.game.assets.audioBuffer(ctx, name).then((buf) => {
      if (!buf || gen !== this._voGen) return;          // a newer line was asked for while this one decoded
      this.stopVoice(0.10, true);          // hand the duck straight over to the incoming line
      const src = ctx.createBufferSource(); src.buffer = buf;
      const g = ctx.createGain(); g.gain.value = vol;
      src.connect(g); g.connect(this.buses?.sfx ?? ctx.destination);
      src.start();
      this._vo = { src, g, gen, name };
      src.onended = () => {
        if (!this._vo || this._vo.gen !== gen) return;
        this._vo = null;
        const nxt = this._voQueue.shift();
        if (nxt) this._startVoice(nxt.name, nxt.vol);      // keep the duck: the channel is still busy
        else this._duckMusic(false);
      };
      this._duckMusic(true);
    }).catch(() => {});
  }
  /** true while a dialogue line is talking (quest/debug). */
  get voiceBusy() { return !!this._vo; }
  get voiceQueued() { return this._voQueue.length; }

  play(name, o = EMPTY) {
    const rec = SFX[name]; if (!rec) { if (this.game.debug) console.warn('audio: unknown sfx', name); return NOOP; }
    if (name === 'reload' && o.arch === undefined) { const a = this.game.player?.weapons?.current?.archetype; if (a) o = { ...o, arch: a }; }   // Weapons plays 'reload' directly (no payload); look the archetype up for the per-arch foley variant
    const pn = performance.now() / 1000, last = this._last.get(name);
    if (last !== undefined && pn - last < (rec.gap ?? DEDUPE) && !o.force) return NOOP;   // same-frame duplicate + per-name rate limit (rec.gap)
    this._last.set(name, pn);
    let dist = 0;
    if (o.pos && rec.dist > 0) { dist = o.pos.distanceTo(this.game.camera.position); if (dist > rec.dist) return NOOP; }
    this._log(name, o);
    const ctx = this.ctx; if (!ctx || !this.unlocked || ctx.state !== 'running') return NOOP;
    if (this._perFrame++ >= MAX_PER_FRAME) return NOOP;
    const now = ctx.currentTime, at = Math.max(now, o.at ?? now), v = this._acquire(now);
    if (!v) return NOOP;
    const spatial = !!(o.pos && rec.dist > 0), bus = this.buses[o.bus ?? rec.bus] ?? this.buses.sfx;
    const vary = rec.vary ?? 0, rr = vary ? Math.random() * 2 - 1 : 0;                                        // round-robin: shared roll for pitch+level
    v.busy = true; v.name = name; v.loop = o.loop ? { rec, o } : null; const gen = v.gen = ++this._gen;
    v.pre.gain.cancelScheduledValues(now); v.pre.gain.setValueAtTime(clamp((o.vol ?? 1) * (1 + rr * vary * 2.5), 0, 4), now);
    if (spatial !== v.spatial) { v.pre.disconnect(); v.pre.connect(spatial ? this._panner(v) : v.post); v.spatial = spatial; }
    if (spatial) {
      const p = v.panner; p.refDistance = rec.ref ?? 3; this._setPos(p, o.pos);
      v.lpf.frequency.setValueAtTime(clamp(20000 * Math.pow(0.5, dist / 70), 500, 20000), now);               // air absorption: far sounds get dull, not just quiet
    }
    if (bus !== v.bus) { v.post.disconnect(v.bus); v.post.connect(bus); v.bus = bus; }
    v.send.gain.value = rec.rev;
    if (rec.duck && this.buses.sfx) {                                                                          // brief sfx-bus dip so feedback ticks read under autofire
      const g = this.buses.sfx.gain, v0 = this.volumes.sfx;
      g.cancelScheduledValues(at); g.setTargetAtTime(v0 * 0.45, at, 0.006); g.setTargetAtTime(v0, at + 0.07, 0.045);
    }
    const S = v.S; S.t = at; S.p = clamp((o.pitch ?? 1) * (1 + rr * vary), 0.25, 4); S.dist = dist; S.nodes.length = 0;   // recipes read S.dist for near/far layer crossfades
    const dur = rec.f(S, o); v.end = at + dur + 0.06; v.dur = dur;
    const self = this;
    return {
      stop() { if (v.gen !== gen || !v.busy) return; const t = self.ctx.currentTime; v.pre.gain.cancelScheduledValues(t); v.pre.gain.setTargetAtTime(0, t, 0.012); v.end = Math.min(v.end, t + 0.08); v.loop = null; },
      setPos(p) { if (v.gen === gen && v.busy && v.panner && p) self._setPos(v.panner, p); },
    };
  }
  _log(name, o) {
    const e = { name, t: +this.game.time.toFixed(2), pos: o.pos ? [+o.pos.x.toFixed(1), +o.pos.y.toFixed(1), +o.pos.z.toFixed(1)] : null, vol: +(o.vol ?? 1).toFixed(2) };
    const L = this.debugLastPlayed; L.push(e); if (L.length > MAX_LOG) L.shift();
    this.debugCounts[name] = (this.debugCounts[name] || 0) + 1;
  }
  _setPos(p, pos) { if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z); }
  _panner(v) {
    if (v.panner) return v.panner;
    const p = this.ctx.createPanner(); p.panningModel = this.panningModel; p.distanceModel = 'inverse'; p.refDistance = 3; p.maxDistance = 500; p.rolloffFactor = 1.1;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000; lp.Q.value = 0.5;   // distance air-absorption filter, retuned per play
    p.connect(lp); lp.connect(v.post); v.lpf = lp; return (v.panner = p);
  }
  _acquire(now) {
    let best = null;
    for (const v of this.voices) { if (!v.busy) return v; if (!best || v.end < best.end) best = v; }
    if (this.voices.length < this.maxVoices) {
      const ctx = this.ctx, v = { pre: ctx.createGain(), post: ctx.createGain(), send: ctx.createGain(), panner: null, spatial: false, bus: this.buses.sfx, busy: false, end: 0, dur: 0, gen: 0, name: '', loop: null, S: null };
      v.pre.connect(v.post); v.post.connect(v.bus); v.post.connect(v.send); v.send.connect(this.reverbSend);
      v.S = { ctx, t: 0, out: v.pre, noise: this.noise, p: 1, nodes: [], bufs: this.buffers };
      this.voices.push(v); return v;
    }
    if (best) { this._release(best); return best; }                                    // steal the voice closest to finishing
    return null;
  }
  _release(v) {
    for (const n of v.S.nodes) { try { n.stop?.(0); } catch {} try { n.disconnect(); } catch {} }
    v.S.nodes.length = 0; v.busy = false; v.loop = null; v.gen++;
  }

  // ---------- frame ----------
  update(dt, t) {
    this._perFrame = 0;
    this._trackTick(dt);                                       // music track auto-select + combat duck: state is tracked even without a live ctx (auto mode)
    const ctx = this.ctx; if (!ctx) return;
    if (!this.unlocked) { if (ctx.state === 'running') this._onRunning(); else return; }
    const now = ctx.currentTime, cam = this.game.camera;
    // listener = camera
    const L = ctx.listener, p = cam.position; cam.getWorldDirection(this._fwd); this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    if (L.positionX) { L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z; L.forwardX.value = this._fwd.x; L.forwardY.value = this._fwd.y; L.forwardZ.value = this._fwd.z; L.upX.value = this._up.x; L.upY.value = this._up.y; L.upZ.value = this._up.z; }
    else { L.setPosition(p.x, p.y, p.z); L.setOrientation(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z); }
    // voice sweep: release finished voices, re-fire loops
    for (const v of this.voices) {
      if (!v.busy || now < v.end) continue;
      if (v.loop) { const { rec, o } = v.loop; v.S.t = v.end - 0.06; v.S.nodes.length = 0; const d = rec.f(v.S, o); v.end = v.S.t + d + 0.06; }   // ponytail: loop = retrigger; fine for sustained whines/beds
      else this._release(v);
    }
    // zone (every 0.5 s; immediately on fast travel) + ambient creatures + music
    const pp = this.game.player?.position ?? p;
    if (this._lastPX !== null && Math.abs(pp.x - this._lastPX) + Math.abs(pp.z - this._lastPZ) > 25) { this._zoneT = 9; this._zoneFast = true; }   // teleport: re-poll now, settle the beds fast
    this._lastPX = pp.x; this._lastPZ = pp.z;
    this._zoneT += dt;
    if (this._zoneT > 0.5) { this._zoneT = 0; this.zone = this.ambientZone ?? this._zoneAt(pp.x, pp.z); this.ambientSys.setZone(this.zone, this._zoneFast ? 0.4 : 1.5); this._zoneFast = false; }
    const hour = this.game.sky?.hour ?? 12;
    this.ambientSys.update(now, p.x, p.y, p.z, hour);
    if (this.musicSys.playing) this.musicSys.schedule(now);
  }
  /** Every 0.5 s: hour drives field/night (unless a track was pinned via music()); recent combat events duck the music bus Destiny-style. */
  _trackTick(dt) {
    this._musicT += dt; if (this._musicT < 0.5) return; this._musicT = 0;
    if (this._musicAuto && this.musicTrack) {
      const h = this.game.sky?.hour ?? 12, want = h >= 19.5 || h < 5.5 ? 'night' : 'field';
      if (want !== this.musicTrack) { this.musicTrack = want; this.musicSys.track = want; }
    }
    const inCombat = this.game.time - this._combatT < 6;
    if (inCombat === this._inCombat) return;
    this._inCombat = inCombat; this._musicDuck = inCombat ? 0.35 : 1;
    this._applyMusicGain(inCombat ? 0.5 : 2.2);
  }
  _zoneAt(x, z) {
    const r = Math.hypot(x, z);
    if (r > 330) {                                    // outside the home bowl: the region's own bed
      const b = this.game.terrain?.biomeBlend?.(x, z, this._zb ??= {});
      if (b && b.w > 0.25) return BIOMES[b.id]?.zone ?? 'wilds';
      return r > 600 ? 'wilds' : 'mountain';
    }
    if (r > 380) return 'mountain';
    if (Math.hypot(x + 60, z - 260) < 60) return 'arena';
    if (Math.hypot(x + 170, z + 70) < 110) return 'lake';
    if (Math.hypot(x - 140, z - 60) < 75) return 'ruins';
    if (z < -180) return 'forest';
    if (x > 220) return 'crystal';
    return 'meadow';
  }
  dispose() { this.ambientSys.stop(); this.musicSys.stop(0.1); this.ctx?.close(); this.ctx = null; }

  // ---------- offline self-checks ----------
  /** Render one SFX through a bare gain into an OfflineAudioContext. -> { sr, data } */
  async render(name, secs = 2.5, o = EMPTY) {
    const rec = SFX[name]; if (!rec) throw new Error('unknown sfx ' + name);
    const sr = 48000, oc = new OfflineAudioContext(2, Math.ceil(sr * secs), sr), g = oc.createGain(); g.connect(oc.destination);
    const S = { ctx: oc, t: 0.02, out: g, noise: makeNoise(oc, 1), p: clamp(o.pitch ?? 1, 0.25, 4), dist: o.dist ?? 0, nodes: [], bufs: o.synth ? null : this.buffers };   // o.synth = force the synth-fallback path
    const dur = rec.f(S, o); const buf = await oc.startRendering();
    return { sr, dur, data: buf.getChannelData(0) };
  }
  async renderMusic(secs = 12, track = 'field') {
    const sr = 48000, oc = new OfflineAudioContext(2, Math.ceil(sr * secs), sr), g = oc.createGain(); g.connect(oc.destination);
    const m = new Music(this); m.track = track; m.start(oc, g, null); for (let t = 0; t < secs; t += 0.25) m.schedule(t, 0.5);
    const buf = await oc.startRendering(); return { sr, data: buf.getChannelData(0), dataR: buf.getChannelData(1) };
  }
  async renderAmbient(secs = 6, zone = 'meadow') {
    const sr = 48000, oc = new OfflineAudioContext(2, Math.ceil(sr * secs), sr), g = oc.createGain(); g.connect(oc.destination);
    const a = new Ambient(this); a.zone = zone; a.start(oc, g);
    const buf = await oc.startRendering(); return { sr, data: buf.getChannelData(0), dataR: buf.getChannelData(1) };
  }
  /** Offline render each name and assert it is audible (non-silent RMS, finite peak). Default: the hand cannon. */
  async selfTest(names = ['shot-handcannon'], secs = 2.5) {
    const results = {}; let ok = true;
    for (const name of names) {
      try {
        const { sr, dur, data } = await this.render(name, secs);
        let sum = 0, peak = 0, lastNZ = 0; for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); sum += data[i] * data[i]; if (a > peak) peak = a; if (a > 0.002) lastNZ = i; }
        const rms = Math.sqrt(sum / data.length);
        const r = { rms: +rms.toFixed(4), peak: +peak.toFixed(3), dur: +dur.toFixed(2), tail: +(lastNZ / sr).toFixed(2), ok: rms > 0.0008 && peak > 0.02 && Number.isFinite(peak) && peak < 6 };
        if (!r.ok) ok = false; results[name] = r;
      } catch (e) { ok = false; results[name] = { ok: false, err: String(e?.message || e) }; }
    }
    return { ok, results };
  }
}
