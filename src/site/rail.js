/**
 * cadle.gg - the region rail.   (orchestrator)
 *
 * Ten cards on a shallow cylinder. Drag it, flick it, wheel it, or arrow-key it; it snaps to the card in
 * the middle, and whichever card is in the middle is the place the whole page's backdrop cross-fades to.
 * That coupling is the point: the rail is not a widget on top of the art, it is the steering wheel for
 * it - the same idea as beUI's Cylinder Carousel, rebuilt here in plain DOM because this page, like the
 * game, ships no framework.
 *
 * HOW IT IS CHEAP:
 *  - ONE float of state (`pos`, in card-index space). Everything visible is a pure function of it.
 *  - Every card is a single `transform` + `opacity` write per frame - compositor work, no layout.
 *  - The frame loop only runs while the rail is actually moving. At rest it costs nothing.
 *  - Card images are `loading="lazy"`, and the two neighbours of the centre are hinted eager so a drag
 *    never uncovers an empty frame.
 */
import { onFrame, approach, reduced } from './ui.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function rail(root, { onCentre } = {}) {
  const track = root.querySelector('.rail-track');
  const cards = [...track.children];
  const n = cards.length;
  if (!n) return null;

  // The chrome (name, band, dots, arrows) lives OUTSIDE .rail - the rail itself is full-bleed and
  // clipped, its chrome is inside the page's normal column - so look it up on the section, not on the
  // rail. Querying `root` here silently returned null for all of it: the arrows did nothing and the
  // caption under the cards never changed, while the backdrop behind the page changed correctly.
  const scope = root.closest('section') || document;
  const dots = scope.querySelector('.rail-dots');
  const prev = scope.querySelector('[data-rail="prev"]');
  const next = scope.querySelector('[data-rail="next"]');
  const blurbEl = scope.querySelector('.rail-blurb');
  const bandEl = scope.querySelector('.rail-band');
  // the foe line was the one field nothing wrote, so nine of the ten regions were labelled with the
  // Vale's bestiary under their own name
  const foeEl = scope.querySelector('.rail-foe');

  let pos = 0, target = 0, vel = 0, dragging = false, running = false, centre = -1;
  let step = 0, seen = false;
  // "has the rail ever been on screen" - the gate for eager image promotion below
  new IntersectionObserver((es, io) => {
    if (!es.some((e) => e.isIntersecting)) return;
    seen = true; io.disconnect();
    for (const k of [centre - 1, centre, centre + 1]) cards[mod(k)]?.querySelector('img')?.setAttribute('loading', 'eager');
  }, { rootMargin: '200px 0px' }).observe(root);

  // Spacing between card centres. `offsetWidth`, not a bounding rect: the cards are absolutely
  // positioned and carry a 3D transform, so their rects are the SCALED, ROTATED boxes and measuring one
  // would make the spacing depend on where the rail happens to be sitting.
  const GAP = 26;
  const measure = () => { step = cards[0].offsetWidth + GAP; };

  // The rail WRAPS. Without it the first card sits in the middle with nine to its right and an empty
  // half-screen to its left, which reads as a broken layout rather than a carousel. `wrap` folds the
  // index distance into [-n/2, n/2), so every card is always somewhere on the cylinder and there is no
  // beginning or end to run into.
  const wrap = (d) => ((d % n) + n + n / 2) % n - n / 2;
  const mod = (i) => ((i % n) + n) % n;

  const layout = () => {
    for (let i = 0; i < n; i++) {
      const d = wrap(i - pos);              // signed distance from the middle, in cards
      const a = Math.abs(d);
      const x = d * step;
      // a shallow cylinder: cards turn away and fall back as they leave the middle
      const rot = clamp(-d * 8, -34, 34);
      const z = -Math.min(a, 4) * 90;
      const s = 1 - Math.min(a, 4) * 0.045;
      // Depth used to be sold with opacity - the page's own backdrop showed straight through every
      // card but the centre one. Cards now stay OPAQUE through the whole visible arc; distance reads
      // through the veil (a dark overlay painted by CSS off this custom property, see index.html) plus
      // the rotation/scale above. Opacity only drops, and only to 0, past 3.4 cards out - the point
      // where a card has to vanish for the cylinder to wrap around unseen.
      const o = a > 3.4 ? 0 : 1;
      const veil = Math.min(a, 3.4) / 3.4 * 0.82;
      const el = cards[i];
      el.style.transform = `translate3d(${x.toFixed(1)}px,0,${z.toFixed(1)}px) rotateY(${rot.toFixed(2)}deg) scale(${s.toFixed(3)})`;
      el.style.opacity = o.toFixed(3);
      el.style.setProperty('--veil', veil.toFixed(3));
      el.style.zIndex = String(100 - Math.round(a * 10));
      el.style.pointerEvents = a < 0.6 ? 'auto' : a > 3.4 ? 'none' : 'auto';
      // Keyboard focus should only land on cards actually facing the viewer - same cutoff as
      // pointer-events above, so Tab can never reach one of the invisible cards round the back.
      // If the card that currently HAS focus is the one rotating out (arrow-key nav can do this),
      // hand focus to the rail itself rather than strand a focus ring on a card nobody can see -
      // the rail already owns the same arrow-key handler, so keyboard nav carries on uninterrupted.
      if (a > 3.4 && el === document.activeElement) root.focus();
      el.tabIndex = a > 3.4 ? -1 : 0;
      el.classList.toggle('mid', a < 0.5);
    }
    const c = mod(Math.round(pos));
    if (c !== centre) {
      centre = c;
      const el = cards[c];
      if (blurbEl) blurbEl.textContent = el.dataset.blurb || '';
      if (bandEl) bandEl.textContent = el.dataset.band || '';
      if (foeEl) foeEl.textContent = el.dataset.foe || '';
      if (dots) for (let i = 0; i < dots.children.length; i++) {
        const on = i === c;
        dots.children[i].classList.toggle('on', on);
        // aria-current tells AT which region is active; a plain class does nothing for it
        if (on) dots.children[i].setAttribute('aria-current', 'true');
        else dots.children[i].removeAttribute('aria-current');
      }
      // The centre and its two neighbours stop being lazy, so a flick never lands on a blank card -
      // but ONLY once the rail has actually been on screen. layout() runs at init, and promoting there
      // pulled 378 KB of card art into the page's very first load for a section two viewports down.
      if (seen) for (const k of [c - 1, c, c + 1]) cards[mod(k)]?.querySelector('img')?.setAttribute('loading', 'eager');
      onCentre?.(el.dataset.id, c, el);
    }
  };

  const run = () => {
    if (running) return;
    running = true;
    onFrame((dt) => {
      if (!dragging) {
        // inertia, then a spring to the nearest card. Two behaviours, one line each, and the snap only
        // takes over once the flick has run out - which is what makes it feel thrown rather than dragged.
        if (Math.abs(vel) > 0.02) {
          pos += vel * dt;
          vel *= Math.exp(-4.5 * dt);
          target = Math.round(pos);
        } else {
          vel = 0;
          pos = approach(pos, target, dt, 9);
        }
      }
      layout();
      const still = !dragging && Math.abs(vel) < 0.02 && Math.abs(pos - target) < 0.0015;
      if (still) { pos = target; layout(); running = false; return false; }
      return true;
    });
  };

  /** step by cards, or jump to an absolute index by the SHORT way round the cylinder */
  const step_ = (d) => { target = Math.round(target) + d; vel = 0; run(); };
  const goTo = (i) => { target = Math.round(pos) + wrap(i - mod(Math.round(pos))); vel = 0; run(); };

  // ---- pointer drag, with a real flick velocity ------------------------------------------------
  let px = 0, pt = 0, moved = 0;
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = 0; vel = 0;
    px = e.clientX; pt = performance.now();
    // NO pointer capture yet. Capturing on pointerdown retargets the whole gesture to the rail, so the
    // click never reaches the card and every "Enter →" link in this section was dead to a mouse. Capture
    // only once the pointer has actually travelled far enough to be a drag rather than a click.
    root.classList.add('grabbing');
    run();
  });
  root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - px;
    const now = performance.now();
    const dt = Math.max(1, now - pt) / 1000;
    px = e.clientX; pt = now;
    moved += Math.abs(dx);
    // 8, the same threshold the click guard uses. At 5 there was a 3 px band where the gesture captured
    // (so the click never reached the card) but the guard still called it a click.
    if (moved > 8 && !root.hasPointerCapture?.(e.pointerId)) {
      try { root.setPointerCapture(e.pointerId); } catch (err) { /* not a real drag then */ }
    }
    pos -= dx / step;
    vel = -(dx / step) / dt * 0.35;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('grabbing');
    try { root.releasePointerCapture(e.pointerId); } catch (err) {}
    if (Math.abs(vel) < 0.4) { vel = 0; target = Math.round(pos); }
    run();
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  // a drag must not also count as a click on the card underneath it
  root.addEventListener('click', (e) => { if (moved > 8) { e.preventDefault(); e.stopPropagation(); } }, true);

  // ---- wheel: horizontal wheels scroll the rail, vertical ones are left to the page ------------
  root.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;   // vertical intent belongs to the document
    e.preventDefault();
    step_(Math.sign(e.deltaX));
  }, { passive: false });

  // ---- keyboard ---------------------------------------------------------------------------------
  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { step_(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { step_(-1); e.preventDefault(); }
    else if (e.key === 'Home') { goTo(0); e.preventDefault(); }
    else if (e.key === 'End') { goTo(n - 1); e.preventDefault(); }
  });
  prev?.addEventListener('click', () => step_(-1));
  next?.addEventListener('click', () => step_(1));
  if (dots) {
    // index.html hands us <li title="..."> - no role, no keyboard access, only a tooltip.
    // Swap in real buttons here (rail.js owns interaction; index.html's CSS moves from
    // `.rail-dots li` to `.rail-dots button` - same box, same transitions, just the tag).
    [...dots.children].forEach((li, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = li.className;
      b.title = li.title;
      b.setAttribute('aria-label', cards[i]?.dataset.name || li.title || `Region ${i + 1}`);
      b.addEventListener('click', () => goTo(i));
      li.replaceWith(b);
    });
  }

  addEventListener('resize', () => { measure(); layout(); });
  measure();
  if (reduced()) { track.classList.add('static'); }   // CSS turns the rail into a plain scrolling row
  layout();
  run();

  return { goTo, get index() { return centre; } };
}
