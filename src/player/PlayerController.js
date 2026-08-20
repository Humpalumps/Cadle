import * as THREE from 'three';

/**
 * PlayerController: first-person kinematic character controller. Destiny 2 Hunter feel is the target:
 * snappy-but-weighty acceleration, sprint (forward-ish input, cancelled by fire/ADS), crouch, slide (momentum boost, slope-aware,
 * slide-jump keeps speed), double jump with directional boost + brief float while Space is held, air control, coyote time,
 * jump buffering, landing impact + hard-landing slow, step-up/ledge forgiveness on box colliders, downhill ground snapping,
 * steep-slope (> 50°) sliding, wading/swimming, cadenced footsteps. Frame-rate independent (exp-approach blends, kinematic y, substeps).
 *
 * Reads:   game.input, game.terrain.heightAt/normalAt/waterLevel, game.world.colliders.query, game.world.water?.submergedDepth(x,y,z)|heightAt(x,z)|level,
 *          game.player.view.yaw (move direction), game.player.weapons?.current?.{firing,ads} (sprint cancel)
 * Exposes: position (feet, Vector3), velocity (Vector3), wishDir (Vector3, camera-relative unit or zero), speed (horizontal m/s), grounded,
 *          state ('idle'|'walk'|'sprint'|'crouch'|'slide'|'air'|'swim'), sliding, crouched, wading, swimming, steep, jumpsLeft, airTime, landImpact,
 *          groundSurface ('grass'|'rock'), sprintBlocked (writable by weapons/abilities: true = can't sprint; resumes ~0.3 s after it clears),
 *          currentHeight, teleport(pos), pressJump() (programmatic jump press — critics verify coyote/buffer live), debugTimers()
 * Swimming: Space = ascend/surface swim (spring-held ~1.1 m depth, never breaches, state stays 'swim'); crouch = sink; exit water via shore/step-up or standing depth.
 * Events:  'player:jump' {n:1|2, slide}, 'player:land' {impact, hard}, 'player:slide' {speed}, 'player:footstep' {surface:'grass'|'rock'|'water', speed, crouched, sprint}
 */
const approach = (k, dt) => 1 - Math.exp(-k * dt);          // frame-rate independent exponential blend factor
const STEEP = Math.cos(THREE.MathUtils.degToRad(50));        // ground normal.y below this = no traction, slide down
const { clamp, lerp } = THREE.MathUtils;
const STAND = 0.7;                                           // (fraction of r²) how far our center may hang past a box edge and still stand on it

export class PlayerController {
  constructor(game, player) {
    this.game = game; this.player = player;
    this.position = new THREE.Vector3(0, 20, 0);
    this.velocity = new THREE.Vector3();
    this.wishDir = new THREE.Vector3();
    this.radius = 0.4; this.height = 1.8; this.crouchHeight = 1.2; this.stepHeight = 0.6;
    // --- tuning (m, m/s, s) ---
    this.walkSpeed = 6.5; this.sprintSpeed = 10; this.crouchSpeed = 3.5; this.swimSpeed = 4;
    this.accelK = 15;      // 95% of target in ~0.2 s
    this.decelK = 20;      // stop in ~0.15 s
    this.airAccel = 22;    // m/s² along wish, capped at the cap's projection (Quake-style) -> strong air control, slide-jump keeps speed
    this.gravity = 20; this.jumpSpeed = 8.0; this.jump2Speed = 7.2; this.jump2Boost = 4.5; this.floatTime = 0.55; this.floatGravity = 0.3;
    this.maxJumps = 2; this.coyoteTime = 0.12; this.jumpBufferTime = 0.15;
    this.slideBoost = 1.25; this.slideDecel = 8; this.slideDuration = 1.05; this.slideMinSpeed = 5.5; this.slideCooldown = 0.25;
    this.hardLanding = 13; this.landSlowTime = 0.35; this.sprintResume = 0.2;
    this.wadeDepth = 0.35; this.swimDepth = 1.45;
    // --- state (read by HUD/camera/weapons/vfx) ---
    this.grounded = false; this.state = 'idle'; this.speed = 0;
    this.crouched = false; this.sliding = false; this.wading = false; this.swimming = false; this.steep = false;
    this.sprintBlocked = false; this.jumpsLeft = this.maxJumps; this.airTime = 0; this.landImpact = 0; this.groundSurface = 'grass';
    // internals
    this._coyote = 0; this._jumpBuf = 0; this._slideT = 0; this._slideCd = 0; this._landSlow = 0; this._float = 0; this._sprintBlockT = 0; this._wadeMul = 1;
    this._landSlowDur = 0.35; this._landStr = 0.45; this._turnRate = 0;
    this._stride = 0; this._wasGrounded = false; this._jumped = false; this._floorY = -Infinity; this._waterH = -Infinity; this._airCap = this.walkSpeed;
    this._standOnCollider = false;
    this._groundN = new THREE.Vector3(0, 1, 0); this._hv = new THREE.Vector3(); this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._c = new THREE.Vector3();
    this._near = [];
  }
  init() { this.position.y = this.game.terrain.heightAt(this.position.x, this.position.z) + 0.1; }
  teleport(pos) { this.position.copy(pos); this.velocity.set(0, 0, 0); this.grounded = false; this.sliding = false; this._float = 0; this._jumpBuf = 0; this._landSlow = 0; this._wadeMul = 1; }
  pressJump() { this._jumpBuf = this.jumpBufferTime; }   // programmatic jump press — same path as Space (verifies coyote/buffer/ledge forgiveness live)
  debugTimers() { return { coyote: this._coyote, jumpBuf: this._jumpBuf, jumpsLeft: this.jumpsLeft, airTime: this.airTime, float: this._float, landSlow: this._landSlow, wadeMul: this._wadeMul }; }
  get currentHeight() { return this.crouched || this.sliding || this.swimming ? this.crouchHeight : this.height; }

  update(dt) {
    if (!(dt > 0)) return;
    const { input, terrain } = this.game;
    const yaw = this.player.view.yaw;
    const p = this.position, v = this.velocity;

    // ---------------- input -> wish direction (camera-relative, horizontal) ----------------
    let fx = 0, fz = 0, wantSprint = false, wantCrouch = false, crouchPressed = false, jumpPressed = false, spaceHeld = false;
    if (input.active) {
      if (input.down('KeyW')) fz -= 1; if (input.down('KeyS')) fz += 1;
      if (input.down('KeyA')) fx -= 1; if (input.down('KeyD')) fx += 1;
      wantSprint = input.down('ShiftLeft') || input.down('ShiftRight');
      wantCrouch = input.down('ControlLeft') || input.down('KeyC');
      crouchPressed = input.justPressed('ControlLeft') || input.justPressed('KeyC');
      jumpPressed = input.justPressed('Space'); spaceHeld = input.down('Space');
    }
    const len = Math.hypot(fx, fz), moving = len > 0;
    if (moving) { fx /= len; fz /= len; }
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const wish = this.wishDir.set(fx * cos + fz * sin, 0, -fx * sin + fz * cos);

    // ---------------- water (hysteresis so the buoyancy spring can't flicker swim on/off) ----------------
    this._waterH = this._waterHeight(p.x, p.z);
    const depth = this._submerged(p.x, p.y, p.z);                          // feet below surface in m (≤0 dry)
    this.wading = depth > this.wadeDepth;
    // exit swim only when actually clear of the water: launched upward fast (external impulse), feet fully out, or shallow enough to stand.
    // Rising toward the surface stays 'swim' (spring holds depth) — no swim/air state thrash, no porpoising.
    const wasSwim = this.swimming;
    if (this.swimming) {
      const standing = p.y - this._floorY < 0.25;
      if ((depth < 0.5 && v.y > 3) || depth < 0.05 || (depth < this.swimDepth - 0.3 && standing)) this.swimming = false;
    } else if (depth > this.swimDepth) this.swimming = true;
    if (this.swimming && !wasSwim) v.y = Math.max(v.y, -3);   // water catches a plunge — no deep sink before the buoyancy spring wins

    // ---------------- sprint gating: forward-ish input, not blocked by fire/ADS (short delay before resuming), not swimming/deep ----------------
    const weapon = this.player.weapons?.current;
    const blocked = this.sprintBlocked || !!weapon?.firing || (weapon?.ads ?? 0) > 0.3 || (input.active && (input.mouseDown(0) || input.mouseDown(2)));
    this._sprintBlockT = blocked ? this.sprintResume : Math.max(0, this._sprintBlockT - dt);
    const sprinting = wantSprint && moving && fz < -0.45 && this._sprintBlockT <= 0 && !this.swimming && depth < 0.9;

    // ---------------- timers ----------------
    this._slideCd = Math.max(0, this._slideCd - dt); this._landSlow = Math.max(0, this._landSlow - dt); this._jumpBuf = Math.max(0, this._jumpBuf - dt);
    if (this.grounded) { this._coyote = this.coyoteTime; this.airTime = 0; } else { this._coyote = Math.max(0, this._coyote - dt); this.airTime += dt; }
    this.steep = this.grounded && this._groundN.y < STEEP && !this._standOnCollider;

    // ---------------- horizontal velocity ----------------
    const hv = this._hv.set(v.x, 0, v.z); let hs = hv.length();
    const pvx = hv.x, pvz = hv.z, ps = hs;                     // pre-update momentum (turn-rate measurement)
    // slide start: crouch pressed while sprinting on the ground (or land with crouch held while sprinting)
    const justLanded = this.grounded && !this._wasGrounded;
    if (!this.sliding && this.grounded && !this.swimming && this._slideCd <= 0 && sprinting && hs > this.slideMinSpeed && (crouchPressed || (justLanded && wantCrouch))) {
      this.sliding = true; this._slideT = 0; this.crouched = false;
      hv.setLength(Math.max(hs, this.sprintSpeed) * this.slideBoost); hs = hv.length();      // momentum boost
      this.game.events.emit('player:slide', { speed: hs });
    }
    if (this.sliding) {
      this._slideT += dt;
      const n = this._groundN;
      hv.x += n.x * this.gravity * 1.3 * dt; hv.z += n.z * this.gravity * 1.3 * dt;        // slope: n.xz = sin(slope) downhill -> faster down, brakes up
      const sp = hv.length(), ns = Math.max(0, sp - this.slideDecel * dt);                  // linear drag = weight
      if (sp > 0.1) { if (moving) hv.addScaledVector(wish, 5 * dt); hv.setLength(ns); } else hv.set(0, 0, 0);   // gentle steer, never adds speed
      hs = hv.length();
      const over = this._slideT > this.slideDuration && !(hs > this.sprintSpeed && this._slideT < 2.5);   // downhill: keep sliding while fast
      if (over || hs < this.crouchSpeed || !wantCrouch || !this.grounded || this.swimming) { this.sliding = false; this._slideCd = this.slideCooldown; }
    }
    if (!this.sliding) this.crouched = (wantCrouch && !this.swimming) || (this.crouched && this._headBlocked());   // hold to crouch; can't stand under a ceiling

    let cap = this.swimming ? this.swimSpeed : this.crouched ? this.crouchSpeed : sprinting ? this.sprintSpeed : this.walkSpeed;
    // wade slowdown smoothed (~0.4 s time constant) so an undulating lakebed can't pump the cap into visible speed wobble
    const wadeT = (this.wading && !this.swimming) ? lerp(1, 0.45, clamp((depth - this.wadeDepth) / 1.0, 0, 1)) : 1;
    this._wadeMul = lerp(this._wadeMul, wadeT, approach(2.5, dt));
    if (!this.swimming) cap *= this._wadeMul;
    if (this._landSlow > 0) cap *= lerp(1, this._landStr, this._landSlow / this._landSlowDur);
    // hard-turn scrub: carving your momentum heading > ~50°/s can't hold sprint speed (kills the frictionless 180° skate)
    const carve = clamp((this._turnRate - 0.9) / 2.0, 0, 1);
    if (carve > 0 && cap > this.walkSpeed && this.grounded && !this.sliding) cap = lerp(cap, this.walkSpeed * 0.85, carve);
    if (this.grounded) this._airCap = Math.max(this.walkSpeed, cap);        // can't start sprinting mid-air
    else if (this.swimming) this._airCap = this.swimSpeed;                  // breach-hop can't inherit a stale sprint cap (no speed surge out of water)
    else cap = this._airCap;

    if (this.swimming) {
      this._a.copy(wish).multiplyScalar(moving ? cap : 0); hv.lerp(this._a, approach(moving ? 4 : 3, dt));
    } else if (this.sliding) {
      /* handled above */
    } else if (this.grounded && !this.steep) {
      if (moving && hs > 1.5 && hv.dot(wish) < -0.4 * hs) {
        // hard reversal: plant-and-turn — scrub momentum over ~0.2-0.25 s before accelerating the other way (Destiny weight, not an arcade stop)
        hv.multiplyScalar(1 - approach(9, dt));
      } else {
        // exp approach toward wish*cap: quick start with slight weight (accelK), faster braking/turning (decelK)
        this._a.copy(wish).multiplyScalar(moving ? cap : 0);
        hv.lerp(this._a, approach(moving && hv.dot(wish) < cap - 0.05 ? this.accelK : this.decelK, dt));
      }
    } else if (this.grounded) {
      // steep: gravity pulls downhill, weak control, light scrape friction
      const n = this._groundN;
      hv.x += n.x * this.gravity * 1.1 * dt; hv.z += n.z * this.gravity * 1.1 * dt;
      if (moving) { const cur = hv.dot(wish); hv.addScaledVector(wish, Math.min(this.airAccel * 0.5 * dt, Math.max(this.crouchSpeed - cur, 0))); }
      hv.multiplyScalar(1 - approach(0.8, dt));
    } else if (moving) {
      // air control (Quake-style): push along wish, never beyond cap along wish -> keeps slide-jump momentum, allows redirects;
      // total speed may not grow past max(current, cap) (no strafe-jump speed gain)
      const before = Math.max(hv.length(), cap), cur = hv.dot(wish);
      hv.addScaledVector(wish, Math.min(this.airAccel * dt, Math.max(cap - cur, 0))); if (hv.length() > before) hv.setLength(before);
    }
    // measured swing rate of the momentum heading (rad/s), feeds next frame's carve scrub; smooth turns are dt-invariant
    const nsp = hv.length();
    this._turnRate = (this.grounded && !this.sliding && ps > 2 && nsp > 2)
      ? Math.acos(clamp((hv.x * pvx + hv.z * pvz) / (nsp * ps), -1, 1)) / dt : 0;
    v.x = hv.x; v.z = hv.z;

    // ---------------- jump / double jump / buffer / coyote ----------------
    this._jumped = false;
    if (jumpPressed) this._jumpBuf = this.jumpBufferTime;
    if (this.grounded || this.swimming) this.jumpsLeft = this.maxJumps;
    if (this._jumpBuf > 0) {
      const canGround = this.grounded || this._coyote > 0;
      if (this.swimming) {
        this._jumpBuf = 0;   // Space in water = ascend/surface swim (buoyancy below) — no breach impulse, no porpoising; exit onto land via shore/step-up
      } else if (canGround && this.jumpsLeft === this.maxJumps) {
        v.y = this.jumpSpeed; this.jumpsLeft--; this._jumpBuf = 0; this._coyote = 0; this._jumped = true; this.grounded = false;
        const fromSlide = this.sliding; this.sliding = false; if (fromSlide) this._slideCd = this.slideCooldown;   // slide-jump: hv untouched
        this.game.events.emit('player:jump', { n: 1, slide: fromSlide });
      } else if (!canGround && this.jumpsLeft > 0 && this.jumpsLeft < this.maxJumps) {
        // second jump: reset the fall, directional boost (never above the speed you had), float while Space is held
        v.y = Math.max(v.y * 0.25, 0) + this.jump2Speed; this.jumpsLeft--; this._jumpBuf = 0; this._jumped = true; this._float = this.floatTime;
        if (moving) { const before = Math.max(hv.length(), this.sprintSpeed); hv.addScaledVector(wish, this.jump2Boost); if (hv.length() > before) hv.setLength(before); v.x = hv.x; v.z = hv.z; }
        this.game.events.emit('player:jump', { n: 2, slide: false });
      } else if (!canGround && this.jumpsLeft === this.maxJumps) {
        this.jumpsLeft = 1;   // walked off a ledge past coyote time: you still get your air jump (fires next frame via the buffer)
      }
    }

    // ---------------- vertical velocity ----------------
    let g = this.gravity;
    if (this.swimming) {
      // buoyancy spring toward a target depth; Space held = surface swim (held just under the surface, never breaches), crouch = sink
      let targetY = this._waterH - this.swimDepth + 0.1;
      if (spaceHeld && !this._jumped) targetY = this._waterH - (this.swimDepth - 0.35);
      let want = (targetY - p.y) * 6 - v.y * 3;
      if (wantCrouch && !spaceHeld) want = (-2.5 - v.y) * 6;
      v.y += clamp(want, -g, g) * dt; g = 0;
    } else if (!this.grounded) {
      if (this._float > 0 && spaceHeld && v.y < 2.5) { this._float -= dt; g *= this.floatGravity; } else if (!spaceHeld) this._float = 0;
    } else v.y = Math.min(v.y, 0);

    // ---------------- integrate with substeps (no tunneling at clamped dt / high speed) ----------------
    const wasGrounded = this.grounded; this._wasGrounded = wasGrounded;
    const steps = clamp(Math.ceil(Math.hypot(v.x, Math.abs(v.y) + g * dt, v.z) * dt / 0.25), 1, 6), h = dt / steps;
    let landed = false, impact = 0;
    for (let i = 0; i < steps; i++) {
      const x0 = p.x, z0 = p.z;
      p.x += v.x * h; p.z += v.z * h;
      if (this.swimming || this.grounded) p.y += v.y * h; else { p.y += (v.y - 0.5 * g * h) * h; v.y = Math.max(v.y - g * h, -60); }   // exact kinematic y, terminal 60 m/s
      // --- terrain floor; walls = rise > step, or any rise on a steep slope (impassable) ---
      let floorY = terrain.heightAt(p.x, p.z); terrain.normalAt(p.x, p.z, this._groundN);
      const rise = floorY - p.y;
      if (rise > this.stepHeight || (rise > 0.03 && this._groundN.y < STEEP)) {
        p.x = x0; p.z = z0; floorY = terrain.heightAt(p.x, p.z); terrain.normalAt(p.x, p.z, this._groundN);
        const n = this._a.set(this._groundN.x, 0, this._groundN.z), nl = n.length();
        if (nl > 1e-6) { n.divideScalar(nl); const into = v.x * n.x + v.z * n.z; if (into < 0) { v.x -= n.x * into; v.z -= n.z * into; } }   // slide along
      }
      this._standOnCollider = false; this.groundSurface = this._groundN.y < 0.7 ? 'rock' : 'grass';
      // --- colliders (boxes: cylinder vs AABB with step-up; spheres/capsules: two sample points) ---
      floorY = this._collide(floorY);
      this._floorY = floorY;
      // --- ground resolution ---
      if (p.y <= floorY + 1e-4) {
        if (!this.grounded) { landed = true; impact = Math.max(impact, -v.y); }
        const gap = floorY - p.y;
        // smooth step-up: a floor rise while walking (stairs, box tops) blends up over ~90 ms instead of snapping (Destiny stair feel)
        if (gap > 0.02 && wasGrounded && !landed) p.y += gap * approach(33, h); else p.y = floorY;
        this.grounded = true; if (v.y < 0) v.y = 0;
      } else if (wasGrounded && !this._jumped && !this.swimming && v.y <= 0.01 && p.y - floorY <= this.stepHeight + Math.hypot(v.x, v.z) * h * 1.6 + (this.steep ? 0.4 : 0)) {
        p.y = floorY; this.grounded = true; v.y = 0;       // downhill / stair-down snap: no hopping
      } else this.grounded = false;
    }
    if (landed) {
      this._float = 0; this._stride = 0;
      const hard = impact > this.hardLanding;
      if (hard) {
        // hard landings scale with impact: threshold fall = brief 45% cap, terminal-velocity fall = ~0.5 s stumble to 25% (Destiny-length)
        const k = clamp((impact - this.hardLanding) / 35, 0, 1);
        this._landSlowDur = lerp(this.landSlowTime, 0.5, k); this._landStr = lerp(0.45, 0.25, k); this._landSlow = this._landSlowDur;
      }
      // micro-hops from step geometry (airTime < 0.1 s) don't count as landings — no camera dip while climbing stairs
      if (this.airTime > 0.1 || hard) { this.landImpact = impact; this.game.events.emit('player:land', { impact, hard }); }
    }
    const lim = terrain.size * 0.5 - 5;
    p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);

    // ---------------- state + footsteps ----------------
    hs = Math.hypot(v.x, v.z); this.speed = hs;
    this.state = this.swimming ? 'swim' : !this.grounded ? 'air' : this.sliding ? 'slide' : this.crouched ? 'crouch' : (hs < 0.3 && !moving) ? 'idle'
      : (sprinting && hs > this.walkSpeed * 0.8) ? 'sprint' : 'walk';   // pushing a wall with input held reads 'walk', not 'idle' (anim/audio cue)
    if (this.grounded && !this.sliding && !this.swimming && hs > 0.8) {
      this._stride += hs * dt;
      const stride = (1.6 + hs * 0.15) * (this.crouched ? 0.85 : 1);          // ~2.5 steps/s walk, ~3.2 sprint
      if (this._stride >= stride) {
        this._stride -= stride;
        this.game.events.emit('player:footstep', { surface: this.wading ? 'water' : this.groundSurface, speed: hs, crouched: this.crouched, sprint: this.state === 'sprint' });
      }
    } else this._stride = this.grounded ? 1.0 : 0;   // from rest the first step comes early (~1.6 m)
  }

  // ---- helpers ----
  _waterHeight(x, z) {
    const w = this.game.world?.water;
    return w?.heightAt?.(x, z) ?? w?.level ?? w?.waterLevel ?? this.game.terrain.waterLevel ?? -Infinity;
  }
  _submerged(x, y, z) {
    const w = this.game.world?.water;
    if (typeof w?.submergedDepth === 'function') return w.submergedDepth(x, y, z) ?? 0;
    if (typeof w?.submergedDepth === 'number') return w.submergedDepth;
    return this._waterH - y;   // ponytail: flat water plane at terrain.waterLevel until the water builder exposes submergedDepth(x,y,z)
  }
  _headBlocked() {
    // a box whose underside sits between crouch height and standing height over our feet -> stay crouched
    const col = this.game.world?.colliders; if (!col) return false;
    const p = this.position, r = this.radius;
    for (const c of col.query(p.x, p.z, r, this._near)) {
      if (c.type !== 'box') continue; const b = c.box;
      const dx = p.x - clamp(p.x, b.min.x, b.max.x), dz = p.z - clamp(p.z, b.min.z, b.max.z);
      if (dx * dx + dz * dz < r * r && b.min.y < p.y + this.height && b.min.y > p.y + this.crouchHeight - 0.05) return true;
    }
    return false;
  }
  _collide(floorY) {
    const col = this.game.world?.colliders; if (!col) return floorY;
    const p = this.position, v = this.velocity, r = this.radius, hgt = this.currentHeight;
    const near = col.query(p.x, p.z, r + this.stepHeight, this._near);
    if (near.length === 0) return floorY;
    const n = this._a, q = this._b, ab = this._c;
    for (const c of near) {
      if (c.type === 'box') {
        const b = c.box;
        const cx = clamp(p.x, b.min.x, b.max.x), cz = clamp(p.z, b.min.z, b.max.z);
        const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        const top = b.max.y, bot = b.min.y, feet = p.y, head = p.y + hgt, climb = top - feet;
        // floor beneath us, or a step-up (stairs) / ledge forgiveness (airborne near apex, slightly shorter reach): the top is floor once our
        // center is within STAND of the footprint; never a wall in between (so we can walk into the step-up window)
        if (climb <= 1e-3 || (climb <= (this.grounded ? this.stepHeight : this.stepHeight * 0.85) && v.y <= 1.5)) {
          if (d2 < r * r * STAND && top > floorY) { floorY = top; this._standOnCollider = true; } continue;
        }
        if (bot >= head - 1e-3) continue;                                                   // entirely above us
        if (head - bot < 0.25 && v.y >= 0) { p.y = bot - hgt; v.y = 0; continue; }          // ceiling bump from below (small poke); deeper overlap = wall
        // wall: push out horizontally, kill velocity into it
        let nx, nz;
        if (d2 > 1e-8) { const d = Math.sqrt(d2); nx = dx / d; nz = dz / d; p.x += nx * (r - d); p.z += nz * (r - d); }
        else {  // center inside the footprint: exit along the cheapest axis
          const ex0 = p.x - b.min.x + r, ex1 = b.max.x - p.x + r, ez0 = p.z - b.min.z + r, ez1 = b.max.z - p.z + r, m = Math.min(ex0, ex1, ez0, ez1);
          if (m === ex0) { p.x -= ex0; nx = -1; nz = 0; } else if (m === ex1) { p.x += ex1; nx = 1; nz = 0; } else if (m === ez0) { p.z -= ez0; nx = 0; nz = -1; } else { p.z += ez1; nx = 0; nz = 1; }
        }
        const into = v.x * nx + v.z * nz; if (into < 0) { v.x -= nx * into; v.z -= nz * into; }
      } else {
        // small rock (sphere within step height): its enlarged surface is walkable floor, not a wall — no micro-snags at walk speed
        if (c.type === 'sphere' && c.r <= this.stepHeight && v.y <= 1.5) {
          const R = r + c.r, ddx = p.x - c.pos.x, ddz = p.z - c.pos.z, dd2 = ddx * ddx + ddz * ddz;
          if (dd2 < R * R) {
            const fy = c.pos.y + Math.sqrt(R * R - dd2) - r;   // feet height resting on it at this xz
            if (fy > floorY && fy - p.y <= this.stepHeight) { floorY = fy; this._standOnCollider = true; this.groundSurface = 'rock'; continue; }
          }
        }
        // sphere / capsule vs two sample points (low: feet+r, high: head-r)
        for (let s = 0; s < 2; s++) {
          q.set(p.x, s === 0 ? p.y + r + 0.02 : p.y + hgt - r, p.z);
          if (c.type === 'sphere') n.subVectors(q, c.pos);
          else { ab.subVectors(c.b, c.a); const t = clamp(n.subVectors(q, c.a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1); n.copy(c.a).addScaledVector(ab, t); n.subVectors(q, n); }
          const d = n.length(), min = r + c.r;
          if (d >= min + 0.02 || d < 1e-6) continue;          // 2 cm skin so standing on a rock top stays 'in contact' (no grounded flicker)
          n.divideScalar(d); const pen = Math.max(0, min - d);
          p.x += n.x * pen; p.z += n.z * pen;
          if (n.y > 0.7 && s === 0) { p.y += n.y * pen; if (v.y < 0) v.y = 0; if (p.y > floorY) floorY = p.y; this._standOnCollider = true; this.groundSurface = 'rock'; }
          else if (n.y < -0.7 && s === 1) { p.y += n.y * pen; if (v.y > 0) v.y = 0; }
          const into = v.x * n.x + v.z * n.z; if (into < 0) { v.x -= n.x * into; v.z -= n.z * into; }
        }
      }
    }
    return floorY;
  }
}
