import * as THREE from 'three';
import { noise2 } from '../core/Noise.js';

/**
 * PlayerCamera: Destiny-2-feel first-person camera. Mouse look, FOV (sprint/slide/ADS), head bob, landing spring,
 * slide/strafe roll, trauma shake, recoil, damage flinch, breathing, jump-apex float, eye-height blends.
 * Reads: game.input (mouse dx/dy in raw counts), controller (position/velocity/grounded/state/speed), weapons.current?.zoom
 * Writes: game.camera position/quaternion/fov each frame. Camera position is NOT lagged (instant response).
 * Exposes:
 *   yaw, pitch (rad, the player's aim — recoil/shake are additive visual offsets, recoil still moves the shot dir since weapons read the camera)
 *   eye (Vector3, final camera position), fov (current deg, HORIZONTAL — Destiny's fov slider is horizontal; the vertical
 *   fov actually written to camera.fov is exposed as vFov = 2·atan(tan(fov/2)/aspect), ~64.5° at fov 100 / 16:9),
 *   baseFov, ads (0..1 eased), roll (rad), eyeHeight (m)
 *   sens (Destiny scale, default 5 ≈ 13.6 in/360 @800dpi) / sensitivity (rad per mouse count), pitchLimit
 *   look(yaw, pitch) setAds(bool|0..1) kick(pitch, yaw) shake(strength) flinch(strength=1)
 *   sway {x,y} lagged look velocity (rad, for viewmodel look-lag), bobOffset (Vector3 camera-space m), bobPhase, bobAmt,
 *   recoil {pitch,yaw} current offsets (rad), landDip (m, >0 when dipping), trauma (0..1)
 * Weapon zoom: weapons.current.zoom is magnification (1.3 = 1.3×, tan-space). Values > 8 are treated as Destiny stat/10.
 * ADS: setAds() is authoritative once anything has called it; until then RMB drives ADS so the camera works with stub weapons.
 * Recoil: kick() lands fully in ≤2 frames; recovery is rate-capped (~1.2°/s) while kicks keep arriving so automatics climb
 * the pattern, then exponential (10/s) after ~120 ms of silence. 20% of every kick's pitch is PERMANENT aim displacement
 * (Destiny: you pull the gun down yourself); each kick also punches a small alternating roll. Chained shots (<0.25 s apart,
 * i.e. automatics/pulses) hit 25% harder and get a seeded smooth horizontal wander (value-noise walk per shot index).
 * Slide holds a flat sprint+3 FOV. Bob is phase-locked to 'player:footstep'. Flinch uses total incoming damage (pre-shield)
 * with a 0.3 floor. Trauma decay is amplitude-dependent: big shakes linger ~0.95 s, taps snap off in ~0.2 s.
 */
const DEG = Math.PI / 180;
const SENS_UNIT = 0.0066 * DEG;                   // Destiny 2: 0.0066° per count per sensitivity point
const approach = (rate, dt) => 1 - Math.exp(-rate * dt); // frame-rate independent lerp factor
// damped spring (semi-implicit Euler), substepped so a 20 fps hitch doesn't over-damp the impulse. s = [x, v]
function spring(s, k, c, dt) {
  const n = Math.ceil(dt / 0.008), h = dt / n; let x = s[0], v = s[1];
  for (let i = 0; i < n; i++) { v += (-k * x - c * v) * h; x += v * h; }
  s[0] = x; s[1] = v;
}

export class PlayerCamera {
  constructor(game, player) {
    this.game = game; this.player = player;
    this.yaw = 0; this.pitch = 0; this.pitchLimit = 89 * DEG;
    this.sens = 5;
    // settings knobs (src/ui/settings.js writes these): invert pitch, and scales for the two things
    // players most often want dialled down for comfort. 1 = shipped feel, 0 = off.
    this.invertY = 0; this.shakeScale = 1; this.bobScale = 1;
    this.baseFov = 100; this.fov = this.baseFov; this.vFov = 64.5;   // fov is horizontal; vFov is what camera.fov gets
    this.sprintKick = 8; this.slideKick = 3;                 // slideKick = extra FOV over the sprint kick, held flat for the slide
    this.adsIn = 0.18; this.adsOut = 0.24;
    this.eye = new THREE.Vector3();
    this.ads = 0; this._adsT = 0; this._adsTarget = 0; this._adsExt = false;
    this.roll = 0; this.eyeHeight = 1.65;
    this.sway = { x: 0, y: 0 };
    this.bobOffset = new THREE.Vector3(); this.bobPhase = 0; this.bobAmt = 0;
    this.recoil = { pitch: 0, yaw: 0 }; this._rPT = 0; this._rYT = 0; this._sinceKick = 9; this._shotN = 0;
    this._kR = [0, 0]; this._kickSide = 1;               // per-shot roll punch spring + alternator
    this.landDip = 0; this._dip = [0, 0];                // [y, v] landing spring
    this.trauma = 0; this._shakeT = 0;
    this._flP = [0, 0]; this._flR = [0, 0];              // flinch springs (pitch, roll)
    this._sprint = 0; this._airSprint = false; this._slideF = 0; this._apex = 0; this._strafeRoll = 0; this._slideRoll = 0; this._bobSync = 0;
    this._prevYaw = 0; this._prevPitch = 0; this._lastSH = 200;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._right = new THREE.Vector3();
  }
  get sensitivity() { return this.sens * SENS_UNIT; }
  set sensitivity(v) { this.sens = v / SENS_UNIT; }

  init() {
    const ev = this.game.events;
    ev.on('player:land', ({ impact } = {}) => { this._dip[1] -= Math.min(22, Math.max(0, impact ?? 6)) * 0.25; });
    ev.on('player:jump', () => { this._dip[1] += 0.35; });
    // flinch on total INCOMING damage, not post-shield hp loss: info.amount when combat provides it, else the
    // shield+health drop since our last update (covers damage(n) calls without info) — Destiny flinches on every hit
    ev.on('player:damaged', ({ amount, info } = {}) => {
      const drop = this._lastSH - (this.player.shield + this.player.health);
      const total = info?.amount ?? Math.max(amount ?? 0, drop);
      if (total > 0) this.flinch(THREE.MathUtils.clamp(total / 40, 0.3, 1));
    });
    // lock bob phase to the actual foot plant (bob bottom: sin(2φ)=-1 at φ=3π/4 mod π); bled in over ~0.1 s in update
    ev.on('player:footstep', () => {
      let err = ((0.75 * Math.PI - this.bobPhase) % Math.PI + Math.PI) % Math.PI;
      if (err > Math.PI / 2) err -= Math.PI;
      this._bobSync = err;
    });
  }
  look(yaw, pitch) { this.yaw = yaw; this.pitch = THREE.MathUtils.clamp(pitch, -this.pitchLimit, this.pitchLimit); }
  setAds(t) { this._adsExt = true; this._adsTarget = typeof t === 'number' ? THREE.MathUtils.clamp(t, 0, 1) : t ? 1 : 0; }
  // trauma-based: shake amount = trauma^2, so small hits barely register and big ones land hard
  shake(strength = 0.5) { this.trauma = Math.min(1, this.trauma + strength * this.shakeScale); }
  kick(pitch, yaw = 0) {
    this._shotN++;
    if (this._sinceKick < 0.25) {                 // chained shot (automatic/pulse cadence):
      pitch *= 1.55;                              //   punch reads ~55% harder so a 2 s burst climbs like a Destiny 600 rpm auto (~5-6° on screen)
      // seeded horizontal wander: smooth value-noise walk over the burst (~2-3 lobes across a 20-shot mag), not white noise.
      // 0.13 per shot index keeps it slow enough to read as a pattern instead of averaging out.
      yaw += noise2(this._shotN * 0.13, 9.17) * 1.1 * Math.abs(pitch);
    }
    const perm = pitch * 0.2;                     // Destiny leaves ~20% of the climb: recoil control is on the player
    this.pitch = THREE.MathUtils.clamp(this.pitch + perm, -this.pitchLimit, this.pitchLimit);
    this._rPT += pitch - perm; this._rYT += yaw; this._sinceKick = 0;
    this._kickSide = -this._kickSide;             // alternating roll punch per shot → visible per-shot snap on hand cannons
    this._kR[1] += this._kickSide * Math.abs(pitch) * 11 + yaw * 6;
  }
  _recover(x, dt) {
    if (this._sinceKick < 0.12) return x - Math.sign(x) * Math.min(Math.min(3 * Math.abs(x), 0.021) * dt, Math.abs(x));
    return x * Math.exp(-10 * dt);
  }
  flinch(strength = 1) {
    this._flP[1] += 0.9 * strength; this._flR[1] += (Math.random() < 0.5 ? -1 : 1) * 0.7 * strength;
    this.shake(0.25 * strength);
  }

  update(dt, t) {
    const { input, camera } = this.game;
    const c = this.player.controller;
    const m = THREE.MathUtils;

    // --- ADS blend (fast in, slower out), eased ---
    if (!this._adsExt) this._adsTarget = input.active && input.mouseDown(2) ? 1 : 0;
    const adsDir = this._adsTarget > this._adsT ? dt / this.adsIn : -dt / this.adsOut;
    this._adsT = m.clamp(this._adsT + adsDir, Math.min(this._adsT, this._adsTarget), Math.max(this._adsT, this._adsTarget));
    this.ads = m.smoothstep(this._adsT, 0, 1);

    // --- look: sens scales with zoom (focal-length scaling = Destiny's default ADS modifier) ---
    if (input.active) {
      const s = this.sensitivity * Math.tan(this.fov * 0.5 * DEG) / Math.tan(this.baseFov * 0.5 * DEG);
      this.yaw -= input.mouse.dx * s;
      this.pitch = m.clamp(this.pitch - input.mouse.dy * s * (this.invertY ? -1 : 1), -this.pitchLimit, this.pitchLimit);
    }

    // --- recoil: kicks land fully in ≤2 frames (follow 140/s → 95% in 25 ms). Recovery is rate-capped while kicks keep
    // arriving (≤1.2°/s → automatics CLIMB the pattern, ~+1.4°/s for the 600 rpm AR) and exponential (10/s) after ~120 ms silence.
    this._sinceKick += dt;
    this._rPT = this._recover(this._rPT, dt); this._rYT = this._recover(this._rYT, dt);
    const rFollow = approach(140, dt);
    this.recoil.pitch += (this._rPT - this.recoil.pitch) * rFollow;
    this.recoil.yaw += (this._rYT - this.recoil.yaw) * rFollow;

    // --- movement-derived blends ---
    const sprintNow = c.state === 'sprint';
    if (sprintNow) this._airSprint = true; else if (c.grounded) this._airSprint = false;
    const sprinting = sprintNow || (c.state === 'air' && this._airSprint && c.speed > c.walkSpeed);
    this._sprint += ((sprinting ? 1 : 0) - this._sprint) * approach(sprinting ? 9 : 6, dt);
    const sliding = c.state === 'slide';
    this._slideF += ((sliding ? 1 : 0) - this._slideF) * approach(sliding ? 14 : 5, dt);
    const apexTarget = c.state === 'air' ? m.clamp(1 - Math.abs(c.velocity.y) / 4, 0, 1) : 0;   // jump apex only (not swim)
    this._apex += (apexTarget - this._apex) * approach(12, dt);

    // --- FOV: hip (sprint kick; slide HOLDS sprint+3 flat for the whole slide, no pump; apex float) → ADS zoom in tan space ---
    const slideFov = this.sprintKick + this.slideKick;
    const hip = this.baseFov + this.sprintKick * this._sprint * (1 - this._slideF) + slideFov * this._slideF + 2.2 * this._apex;
    const w = this.player.weapons?.current; let zoom = w?.zoom ?? 1.3; if (zoom > 8) zoom /= 10; zoom = m.clamp(zoom, 1, 12);
    const adsFov = 2 * Math.atan(Math.tan(hip * 0.5 * DEG) / zoom) / DEG;
    this.fov = hip + (adsFov - hip) * this.ads;
    // fov is HORIZONTAL (Destiny 95-105 horizontal); three.js camera.fov is vertical → convert via aspect (~64.5 @16:9).
    // Comparing against the converted value auto-catches aspect changes from window resizes.
    const vf = 2 * Math.atan(Math.tan(this.fov * 0.5 * DEG) / (camera.aspect || 16 / 9)) / DEG;
    this.vFov = vf;
    if (Math.abs(camera.fov - vf) > 0.005) { camera.fov = vf; camera.updateProjectionMatrix(); }

    // --- head bob: lateral 1×/cycle, vertical 2×/cycle (one bump per step), speed-scaled, damped in ADS ---
    const moving = c.grounded && c.speed > 0.5 && c.state !== 'slide' && c.state !== 'swim';
    const adsDamp = 1 - this.ads * 0.7;
    this.bobAmt += ((moving ? m.clamp(c.speed / c.sprintSpeed, 0, 1.15) : 0) - this.bobAmt) * approach(moving ? 7 : 5, dt);
    if (moving) {
      // frequency from the controller's stride formula → bumps land exactly at the footstep rate (no drift vs. step sounds)
      const stride = (1.6 + c.speed * 0.15) * (c.crouched ? 0.85 : 1);
      this.bobPhase += dt * Math.PI * c.speed / stride;
      const adj = this._bobSync * approach(10, dt); this.bobPhase += adj; this._bobSync -= adj;   // phase-lock to footstep events
    }
    const sp = Math.sin(this.bobPhase), s2p = Math.sin(this.bobPhase * 2);
    const bobK = this.bobAmt * adsDamp * this.bobScale, bs = this._sprint;   // sprint: ~2× roll so the run visibly rocks; vertical actually DROPS ~30%
    // (Destiny keeps the camera itself calm at a run and puts the energy into the viewmodel + roll — a bouncing eye reads as nausea, not speed)
    this.bobOffset.set(sp * 0.012 * bobK * (1 + 0.5 * bs), s2p * 0.022 * bobK * (1 - 0.06 * bs), 0);
    const bobPitch = s2p * 0.2 * DEG * bobK * (1 + 0.6 * bs), bobRoll = sp * 0.35 * DEG * bobK * (1 + 1.0 * bs);

    // --- landing dip: damped spring (ω≈13, ζ≈0.6 → dip with a small overshoot), impact-scaled impulse from the event ---
    spring(this._dip, 180, 16, dt);
    const dipY = this._dip[0]; this.landDip = Math.max(0, -dipY);

    // --- flinch springs (pitch + roll) + per-shot kick-roll punch ---
    spring(this._flP, 320, 18, dt); spring(this._flR, 320, 18, dt); spring(this._kR, 420, 21, dt);

    // --- eye height: stand / crouch / slide ---
    const eyeTarget = c.state === 'slide' ? 0.85 : c.crouched ? 1.1 : 1.65;
    this.eyeHeight += (eyeTarget - this.eyeHeight) * approach(12, dt);

    // --- roll: lean into strafe (from lateral velocity), slide tilt ---
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const lateral = c.velocity.x * cy - c.velocity.z * sy;           // + = moving right
    this._strafeRoll += ((-lateral / c.sprintSpeed) * 1.2 * DEG - this._strafeRoll) * approach(8, dt);
    this._slideRoll += ((c.state === 'slide' ? -2.5 * DEG : 0) - this._slideRoll) * approach(10, dt);

    // --- trauma shake: shake = trauma², smooth value-noise channels (no random jitter) ---
    this.trauma = Math.max(0, this.trauma - dt * (1.5 - 0.8 * this.trauma));   // heavy hits linger (~0.95 s from trauma 1), light hits still snap off (~0.2 s)
    const shk = this.trauma * this.trauma;
    this._shakeT += dt;
    let shY = 0, shP = 0, shR = 0, shX = 0, shZ = 0, shV = 0;
    if (shk > 0.0005) {
      const ts = this._shakeT * 13;   // noise2 RMS ≈ 0.4, so peak angles ≈ 0.6 × scale: trauma 1 rocks the horizon ~±3-4°
      shY = noise2(ts, 3.37) * 6 * DEG * shk; shP = noise2(ts, 17.91) * 6 * DEG * shk; shR = noise2(ts, 31.13) * 5 * DEG * shk;
      shX = noise2(ts * 0.7, 47.71) * 0.05 * shk; shZ = noise2(ts * 0.7, 59.29) * 0.05 * shk;
      shV = noise2(ts * 1.3, 83.13) * 0.035 * shk;   // vertical thump — explosions bounce the view, not just tilt it
    }

    // --- idle breathing (fades as bob takes over; halved in ADS) ---
    const idle = (1 - Math.min(1, this.bobAmt * 1.5)) * (1 - this.ads * 0.5);
    const brP = Math.sin(t * 1.1) * 0.12 * DEG * idle, brR = Math.sin(t * 0.73 + 1.3) * 0.08 * DEG * idle, brY = noise2(t * 0.35, 71.3) * 0.06 * DEG * idle;

    // --- compose ---
    // dip → visible landing nod. Clamped: the eye may drop 25 cm off a 20 m fall, but nodding 15° with it is a face-plant.
    const dipPitch = m.clamp(dipY * 0.85, -0.13, 0.13);         // ~4.5° on a normal jump landing, saturating at 7.4° on a big drop
    this.roll = this._strafeRoll + this._slideRoll + shR + this._flR[0] + this._kR[0] + bobRoll + brR;
    const vYaw = this.yaw + this.recoil.yaw + shY + brY;
    const vPitch = this.pitch + this.recoil.pitch + shP + this._flP[0] + dipPitch + bobPitch + brP - 0.7 * DEG * this._sprint;   // small forward lean into the sprint
    this._euler.set(vPitch, vYaw, this.roll);
    camera.quaternion.setFromEuler(this._euler);
    this.eye.set(c.position.x, c.position.y + this.eyeHeight + dipY + shV + this.bobOffset.y + 0.02 * this._apex, c.position.z);
    // camera-space lateral offsets (bob sway + shake), rotated by yaw only so they never leak into eye height
    this._right.set(cy, 0, -sy);
    this.eye.addScaledVector(this._right, this.bobOffset.x + shX);
    this.eye.x += -sy * shZ; this.eye.z += -cy * shZ;
    camera.position.copy(this.eye);

    this._lastSH = this.player.shield + this.player.health;   // pre-damage snapshot for the flinch fallback

    // --- look-lag for viewmodels: smoothed visual angular velocity (rad) ---
    const ivdt = dt > 0 ? 1 / dt : 0;
    const velY = (vYaw - this._prevYaw) * ivdt, velP = (vPitch - this._prevPitch) * ivdt;
    this._prevYaw = vYaw; this._prevPitch = vPitch;
    const sw = approach(14, dt);
    this.sway.x += (m.clamp(velY * 0.02, -0.1, 0.1) - this.sway.x) * sw;
    this.sway.y += (m.clamp(velP * 0.02, -0.1, 0.1) - this.sway.y) * sw;
  }
}
