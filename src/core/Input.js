// Keyboard/mouse state. Supports pointer lock and a synthetic mode for automation (window.__game.input.*).
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();        // currently held KeyboardEvent.code values
    this.pressed = new Set();     // codes pressed this frame
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, buttons: 0, wheel: 0, pressed: 0, released: 0 };
    this.locked = false;
    this.synthetic = false;       // when true, ignore real pointer lock requirement
    this._bind();
  }
  /** The ONE way to request pointer lock (HUD start/resume must use this too).
   *  unadjustedMovement can REJECT on some mice/drivers — then retry plain; Chrome also refuses re-lock
   *  within ~1.3 s of an exit, so retry once after the cooldown. Regression-gated by tools/gate.mjs. */
  static lock(c) {
    const plain = () => { try { c.requestPointerLock?.(); } catch {} };
    // Once unadjustedMovement has been refused on this machine, never ask for it again: the refusal
    // arrives asynchronously, by which time the click's transient activation is gone, so the fallback
    // request is rejected with "a user gesture is required" and the mouse stays free. Asking plain the
    // second time keeps the retry inside the gesture. (This is what made re-lock after Esc flaky.)
    if (Input._noUnadjusted) { plain(); return; }
    try {
      const p = c.requestPointerLock?.({ unadjustedMovement: true });
      p?.catch?.(() => { Input._noUnadjusted = true; plain(); setTimeout(() => { if (!document.pointerLockElement) plain(); }, 1400); });
    } catch { Input._noUnadjusted = true; plain(); }
  }
  _bind() {
    const c = this.canvas;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'Tab', 'KeyF', 'KeyR', 'KeyE'].includes(e.code) || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); this.released.add(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.buttons = 0; });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === c; });
    c.addEventListener('mousemove', (e) => {
      if (!this.locked && !this.synthetic) return;
      this.mouse.dx += e.movementX; this.mouse.dy += e.movementY;
    });
    c.addEventListener('mousedown', (e) => {
      if (!this.locked && !this.synthetic) { Input.lock(c); return; }
      this.mouse.buttons |= (1 << e.button); this.mouse.pressed |= (1 << e.button);
    });
    window.addEventListener('mouseup', (e) => { this.mouse.buttons &= ~(1 << e.button); this.mouse.released |= (1 << e.button); });
    c.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  // --- synthetic control (automation / tests) ---
  press(code) { if (!this.keys.has(code)) this.pressed.add(code); this.keys.add(code); }
  release(code) { this.keys.delete(code); this.released.add(code); }
  move(dx, dy) { this.mouse.dx += dx; this.mouse.dy += dy; }
  button(b, down) { if (down) { this.mouse.buttons |= (1 << b); this.mouse.pressed |= (1 << b); } else { this.mouse.buttons &= ~(1 << b); this.mouse.released |= (1 << b); } }
  // --- queries ---
  down(code) { return this.keys.has(code); }
  justPressed(code) { return this.pressed.has(code); }
  justReleased(code) { return this.released.has(code); }
  mouseDown(b = 0) { return (this.mouse.buttons & (1 << b)) !== 0; }
  mouseJustPressed(b = 0) { return (this.mouse.pressed & (1 << b)) !== 0; }
  mouseJustReleased(b = 0) { return (this.mouse.released & (1 << b)) !== 0; }
  get active() { return this.locked || this.synthetic; }
  // call at END of frame
  endFrame() { this.pressed.clear(); this.released.clear(); this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0; this.mouse.pressed = 0; this.mouse.released = 0; }
}
