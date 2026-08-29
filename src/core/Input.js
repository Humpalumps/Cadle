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
    //
    // TWO THINGS THE FIRST VERSION OF THIS GOT WRONG, both measured 2026-08-24 against a reproduction
    // (3 of 8 fresh-profile runs failed with the browser's own
    // "NotAllowedError: A user gesture is required to request Pointer Lock"):
    //
    //   1. The refusal is a property of the MACHINE, not of the page load, but the flag only lived in
    //      memory - so EVERY reload paid the first-click failure again. It is persisted now, and a
    //      machine that has ever refused asks plain from the very first click forever after.
    //   2. The retry was a setTimeout, which by construction runs with no transient activation and so
    //      is rejected 100% of the time - a retry that cannot ever succeed. It now re-arms on the next
    //      REAL pointerdown instead, which is a genuine gesture, so the recovery actually recovers.
    if (Input._noUnadjusted === undefined) {
      try { Input._noUnadjusted = localStorage.getItem('cadle.noUnadjusted') === '1'; }
      catch { Input._noUnadjusted = false; }        // storage blocked (privacy mode): behave as before
    }
    if (Input._noUnadjusted) { plain(); return; }
    const refused = () => {
      Input._noUnadjusted = true;
      try { localStorage.setItem('cadle.noUnadjusted', '1'); } catch {}
      plain();                                       // may still be inside the gesture; free to try
      // and if it was not, take the next real one. once:true so this can never pile up.
      if (!document.pointerLockElement) {
        window.addEventListener('pointerdown', () => {
          setTimeout(() => { if (!document.pointerLockElement) plain(); }, 0);
        }, { once: true, capture: true });
      }
    };
    try {
      const p = c.requestPointerLock?.({ unadjustedMovement: true });
      p?.catch?.(refused);
    } catch { refused(); }
  }
  _bind() {
    const c = this.canvas;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      // These keys are swallowed so the PAGE does not act on them while you are playing - Space
      // scrolls, Tab walks the browser's focus ring, arrows scroll. But only while you are playing.
      // Unconditionally, this line killed keyboard navigation across the entire product: with a screen
      // or the settings modal open, Tab moved focus nowhere at all (measured - `document.activeElement`
      // stayed on <body> after ten real Tab presses in the inventory), so every focus ring in the game
      // was unreachable by the people who need it most. If the pointer is not locked, the player is in
      // a menu and the keys belong to the browser.
      if (!this.locked && !this.synthetic) return;
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
