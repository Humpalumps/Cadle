/**
 * cadle.gg - the interaction layer.   (orchestrator)
 *
 * THE HOUSE COMPONENT SET, ON THE WEB SIDE.
 *
 * The game's menus already speak one motion vocabulary - beUI's (beui.dev/components/motion): segmented
 * tabs with a spring "layoutId" indicator that glides between items, spring-pressed buttons, cards with
 * a cursor-tracked glare, blur cross-fades between panes, a centre-morph modal
 * with gold corner studs, text that reveals in a cascade, numbers that roll. It is implemented in
 * `src/ui/settings.js` + the UI KIT block of `src/ui/ui.css`, in plain DOM and CSS, because the game has
 * neither React nor motion and takes no new deps.
 *
 * The landing page uses the SAME vocabulary, rebuilt the same way and driven by the SAME spring token,
 * so the site and the game read as one product rather than a marketing page bolted onto a game.
 *
 * PERFORMANCE RULES, which are not negotiable on a page whose whole claim is that the game is fast:
 *  - Exactly ONE rAF loop, and it only runs while something actually needs it.
 *  - Scroll work reads `scrollY` once per frame and writes custom properties. No layout reads in
 *    handlers, no `getBoundingClientRect` per scroll event.
 *  - Everything that animates animates `transform`, `opacity` or `filter`. Nothing animates layout.
 *  - Where the browser has native scroll-driven animations (`animation-timeline`), the CSS owns the
 *    effect and this file does nothing at all - see `supportsScrollTimeline`.
 *  - `prefers-reduced-motion` turns all of it off and leaves a static, complete page.
 */

const RM = matchMedia('(prefers-reduced-motion: reduce)');
export const reduced = () => RM.matches;

/** Native scroll-driven animations: when present, the CSS does the parallax on the compositor and the
 *  JS fallback below never runs. */
export const supportsScrollTimeline = CSS.supports('animation-timeline: view()');

// ---------------------------------------------------------------------------------------------
// One frame loop for the whole page. Subscribers are called with (dt, t); returning false unsubscribes.
// It stops itself when the last subscriber leaves, so an idle page costs nothing.
const subs = new Set();
let raf = 0, last = 0;
function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  for (const fn of subs) { try { if (fn(dt, now) === false) subs.delete(fn); } catch (e) { subs.delete(fn); } }
  raf = subs.size ? requestAnimationFrame(tick) : 0;
}
export function onFrame(fn) {
  subs.add(fn);
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  return () => subs.delete(fn);
}

/** critically-damped-ish follower: the one easing helper everything here shares */
export const approach = (cur, target, dt, rate = 8) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------------------------------------
// REVEAL - the entrance. Elements fade and rise as they enter, staggered by their position in a group.
// One observer for the page; each element is unobserved the moment it fires, so this costs nothing
// after the first scroll through.
export function reveals(root = document) {
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      const g = e.target.closest('[data-stagger]');
      if (g) {
        const kids = [...g.querySelectorAll('.reveal')];
        kids.forEach((k, i) => { k.style.transitionDelay = `${Math.min(i, 8) * 70}ms`; k.classList.add('in'); io.unobserve(k); });
      } else { e.target.classList.add('in'); }
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });
  for (const el of root.querySelectorAll('.reveal')) io.observe(el);
  return io;
}

// ---------------------------------------------------------------------------------------------
// SPLIT TEXT - beUI's letter cascade. Each word is wrapped so it can rise and un-blur on its own beat,
// and words never break mid-line because the wrapper is inline-block with the space kept outside.
export function splitWords(el, perWord = 42) {
  if (el.dataset.split) return;
  el.dataset.split = '1';
  const src = el.textContent.trim();
  el.textContent = '';
  src.split(/\s+/).forEach((w, i) => {
    const outer = document.createElement('span');
    outer.className = 'w';
    const inner = document.createElement('span');
    inner.textContent = w;
    inner.style.transitionDelay = `${i * perWord}ms`;
    outer.append(inner);
    el.append(outer, document.createTextNode(' '));
  });
}

// ---------------------------------------------------------------------------------------------
// LAZY GROUPS - `loading="lazy"` is not enough for two shapes on this page, both measured on the
// production build over a throttled connection:
//   - an image inside a `display:none` pane (the Feel section's inactive tabs) can never intersect
//     anything, so Chrome gives up and loads it immediately;
//   - the rail's cards are transformed and stacked, and the heuristic pulled them in too.
// Together that was 378 KB of below-the-fold art on every first load. So: those images ship with
// `data-src` and no `src` at all, and the whole GROUP is loaded when the group approaches the viewport.
// The gallery is deliberately left on plain `loading="lazy"` - it defers correctly and its frames are
// the page's actual evidence, so they should survive with JavaScript off.
/** load every deferred image inside `el` that is actually going to be rendered */
export function loadIn(el) {
  if (!el) return;
  for (const img of el.querySelectorAll('img[data-src]')) {
    if (img.offsetParent === null && getComputedStyle(img).position !== 'fixed') continue;
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
  }
}

export function lazyGroups(root = document) {
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      // ...but NOT the panes nobody is looking at. `.segbody` holds all four tab panes and three of them
      // are `display:none`, so the group heuristic pulled 271 KB of images that render at 0x0. A hidden
      // pane's images load when its tab is selected (see `panes()`).
      loadIn(e.target);
    }
    // 600px, not 400: at 400 a fast scroll reached the weapon strip before its images did and drew six
    // hollow outlines. 1200 was too far the other way - from the hero it already reaches `#do`, which put
    // 348 KB of weapon photographs back above the fold, which is the thing `data-src` exists to prevent.
  }, { rootMargin: '600px 0px' });
  for (const g of root.querySelectorAll('[data-lazygroup]')) io.observe(g);
  return io;
}

// ---------------------------------------------------------------------------------------------
// NUMBER TICKER - beUI's count-up. Fires once, on reveal, and eases out so the last digits settle.
export function tickers(root = document) {
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const el = e.target;
      const to = parseFloat(el.dataset.to || '0');
      const dp = parseInt(el.dataset.dp || '0', 10);
      const pre = el.dataset.pre || '', post = el.dataset.post || '';
      if (reduced()) { el.textContent = pre + to.toFixed(dp) + post; continue; }
      let t = 0;
      const dur = 1.15;
      onFrame((dt) => {
        t += dt;
        const k = clamp(t / dur);
        const v = to * (1 - Math.pow(1 - k, 3));
        el.textContent = pre + v.toFixed(dp) + post;
        return k < 1;
      });
    }
  }, { threshold: 0.6 });
  for (const el of root.querySelectorAll('[data-to]')) io.observe(el);
}

// MAGNETIC BUTTONS: REMOVED (user, 2026-08-29).
// It listened on the window and translated a button toward the cursor from 120 px away, so the Play
// buttons drifted about as you approached them. A control that moves while you are aiming at it is a
// control that is harder to hit, and on a page whose whole conceit is aiming at things that is the
// wrong trade. Nothing on this page may move in response to cursor PROXIMITY; the reticle is the only
// thing that follows the pointer.


// ---------------------------------------------------------------------------------------------
// GLARE CARD - this was beUI's TiltCard. The tilt is GONE (user, 2026-08-29, the same call that took
// out the magnetic buttons): a card that tips under the pointer is one more surface moving because the
// cursor arrived, and these cards are shootable, so the thing you were aiming at rolled away from the
// shot. What survives is the half of the effect that reads as LIGHT rather than motion - a radial glare
// tracked to the cursor through two custom properties. Nothing here writes a transform, so hovering
// costs one compositor repaint and the card's box never moves a pixel.
export function tilt(el) {
  if (reduced()) return;
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--gx', (((e.clientX - r.left) / r.width) * 100).toFixed(1) + '%');
    el.style.setProperty('--gy', (((e.clientY - r.top) / r.height) * 100).toFixed(1) + '%');
  }, { passive: true });
  el.addEventListener('pointerenter', () => el.style.setProperty('--glare', '1'));
  el.addEventListener('pointerleave', () => el.style.setProperty('--glare', '0'));
}

// ---------------------------------------------------------------------------------------------
// SEGMENTED CONTROL - the game's own component (src/ui/settings.js `_segmented`): one pill glides under
// the active item. That glide is a FLIP, which is what beUI gets from motion's shared `layoutId`: read
// the two boxes, set the pill to the old one, then animate to the new one on the spring token.
// Panes cross-fade through a blur, exactly like the settings modal's tab bodies.
export function segmented(root, onChange) {
  const pill = root.querySelector('.pill');
  const btns = [...root.querySelectorAll('button')];
  // The panes live in the sibling container (root's parent holds both `.seg` and the pane body) - wire
  // each tab to its pane both ways so the tablist contract (aria-selected/-controls, tabpanel) is real,
  // not just the role attribute the markup already had.
  const panes = [...(root.parentElement?.querySelectorAll('[data-pane]') || [])];
  btns.forEach((b) => {
    const k = b.dataset.k;
    if (!b.id) b.id = `tab-${k}`;
    const p = panes.find((pn) => pn.dataset.pane === k);
    if (p) {
      if (!p.id) p.id = `panel-${k}`;
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', b.id);
      b.setAttribute('aria-controls', p.id);
    }
    b.setAttribute('aria-selected', 'false');
    b.tabIndex = -1;
  });
  // Both axes, and the height too: on a narrow screen the control wraps to two rows, and a pill that
  // only knows about x slides along row one while the label it is meant to be under sits on row two.
  const move = (btn, animate = true) => {
    const rb = root.getBoundingClientRect(), r = btn.getBoundingClientRect();
    pill.style.transition = animate && !reduced() ? '' : 'none';
    pill.style.width = r.width + 'px';
    pill.style.height = r.height + 'px';
    pill.style.transform = `translate3d(${r.left - rb.left - 4}px,${r.top - rb.top - 4}px,0)`;
    if (!animate) requestAnimationFrame(() => { pill.style.transition = ''; });
  };
  const select = (btn, animate = true) => {
    btns.forEach((b) => {
      const on = b === btn;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;   // roving tabindex: only the selected tab is in the Tab order
    });
    move(btn, animate);
    onChange?.(btn.dataset.k, btn);
  };
  btns.forEach((b) => b.addEventListener('click', () => select(b)));
  // ArrowLeft/Right/Home/End move focus AND selection, per the tablist pattern (this isn't a plain
  // button row a screen reader user tabs through one at a time).
  root.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let n;
    if (e.key === 'ArrowRight') n = (i + 1) % btns.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + btns.length) % btns.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = btns.length - 1;
    else return;
    e.preventDefault();
    btns[n].focus();
    select(btns[n]);
  });
  // the first placement must not animate in from x=0, and it has to wait for fonts/layout
  const init = () => select(root.querySelector('button.on') || btns[0], false);
  if (document.fonts?.ready) document.fonts.ready.then(init); else init();
  addEventListener('resize', () => move(root.querySelector('button.on') || btns[0], false));
  return { select };
}

// ---------------------------------------------------------------------------------------------
// PANES - the blur cross-fade the settings modal uses between tab bodies.
export function panes(root, key) {
  for (const p of root.querySelectorAll('[data-pane]')) p.classList.toggle('on', p.dataset.pane === key);
  // The pane that just became visible is the one whose images are worth fetching - but only once this
  // section is somewhere near the screen. `segmented()` calls this on init too, and without the distance
  // check that pulled the six weapon photographs (348 KB) into the first load from the top of the page,
  // which is the whole thing `data-src` exists to prevent.
  const pane = root.querySelector(`[data-pane="${key}"]`);
  const r = root.getBoundingClientRect();
  if (r.top < innerHeight * 1.6 && r.bottom > -innerHeight * 0.6) loadIn(pane);
}

// ---------------------------------------------------------------------------------------------
// CENTRE-MORPH MODAL - the game's `.ui-modal`: scale + blur in from the middle behind a blurred scrim,
// gold corner studs, Escape and click-outside to close, and focus put back where it came from.
export function lightbox(items = []) {
  const scrim = document.createElement('div');
  scrim.className = 'lb-scrim';
  scrim.inert = true;                 // it starts closed, so it starts out of the tab order
  scrim.innerHTML = `<figure class="lb" role="dialog" aria-modal="true" aria-label="Screenshot viewer">
    <button class="lb-close icon-btn veiled" aria-label="Close">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.9 4.3 12 10.4 18.1 4.3 19.7 5.9 13.6 12 19.7 18.1 18.1 19.7 12 13.6 5.9 19.7 4.3 18.1 10.4 12 4.3 5.9Z"/></svg></button>
    <img alt=""><figcaption></figcaption>
    <button class="lb-nav icon-btn lg veiled prev" aria-label="Previous">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 3.6 17.9 5.9 11 12 17.9 18.1 15.4 20.4 6.1 12Z"/></svg></button>
    <button class="lb-nav icon-btn lg veiled next" aria-label="Next">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 3.6 17.9 12 8.6 20.4 6.1 18.1 13 12 6.1 5.9Z"/></svg></button>
    <span class="lb-count"></span></figure>`;
  document.body.append(scrim);
  const fig = scrim.querySelector('.lb');
  const img = scrim.querySelector('img');
  const cap = scrim.querySelector('figcaption');
  const count = scrim.querySelector('.lb-count');
  const closeBtn = scrim.querySelector('.lb-close');
  // fixed order for the trap, not DOM order - close is first so it's always the way out, touch included
  const trap = [closeBtn, scrim.querySelector('.prev'), scrim.querySelector('.next')];
  let from = null, i = 0;

  const show = (n) => {
    if (!items.length) return;
    i = (n % items.length + items.length) % items.length;
    const it = items[i];
    img.classList.remove('shown');
    img.src = it.src; cap.textContent = it.caption || '';
    count.textContent = `${i + 1} / ${items.length}`;
    img.decode?.().catch(() => {}).finally(() => img.classList.add('shown'));
  };
  const close = () => {
    scrim.classList.remove('on');
    // `opacity:0; pointer-events:none` is not hidden: the closed dialog's three buttons stayed in the tab
    // order as phantom stops 40, 41 and 42, each drawing a focus ring on nothing, and Enter on the
    // invisible "Next" silently advanced an image nobody could see.
    scrim.inert = true;
    document.documentElement.style.overflow = '';
    from?.focus?.(); from = null;
    setTimeout(() => { if (!scrim.classList.contains('on')) img.src = ''; }, 420);
  };
  const open = (n, opener) => {
    from = opener || null;
    scrim.inert = false;
    show(n);
    document.documentElement.style.overflow = 'hidden';
    scrim.classList.add('on');
    closeBtn.focus();   // the way out gets focus first - touch users have no Escape key at all
  };
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
  scrim.querySelector('.prev').addEventListener('click', (e) => { e.stopPropagation(); show(i - 1); });
  scrim.querySelector('.next').addEventListener('click', (e) => { e.stopPropagation(); show(i + 1); });
  scrim.addEventListener('click', (e) => { if (!fig.contains(e.target)) close(); });
  // a gallery you cannot arrow through is a gallery people look at one frame of
  addEventListener('keydown', (e) => {
    if (!scrim.classList.contains('on')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') { e.preventDefault(); show(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(i - 1); }
    else if (e.key === 'Tab') {
      // focus trap: close/prev/next is the whole dialog, so Tab cycles those three and nothing behind them
      e.preventDefault();
      const cur = trap.indexOf(document.activeElement);
      const n = e.shiftKey ? (cur - 1 + trap.length) % trap.length : (cur + 1) % trap.length;
      trap[n < 0 ? 0 : n].focus();
    }
  });
  return { open, close };
}

// ---------------------------------------------------------------------------------------------
// PARALLAX - the JS fallback for browsers without `animation-timeline`. One scroll listener for the
// page; it only records a number. All the work happens in the frame loop, and only while the page is
// actually moving.
export function parallax(root = document) {
  if (supportsScrollTimeline || reduced()) return;      // the CSS already does it, on the compositor
  const items = [...root.querySelectorAll('[data-par]')].map((el) => ({
    el, k: parseFloat(el.dataset.par) || 0.2, top: 0, h: 0,
  }));
  if (!items.length) return;
  const measure = () => {
    const sy = scrollY;
    for (const it of items) {
      const r = it.el.getBoundingClientRect();
      it.top = r.top + sy; it.h = r.height;
    }
  };
  measure();
  addEventListener('resize', measure);
  let dirty = true, y = -1;
  addEventListener('scroll', () => { dirty = true; }, { passive: true });
  onFrame(() => {
    if (!dirty && y === scrollY) return true;
    dirty = false; y = scrollY;
    const vh = innerHeight;
    for (const it of items) {
      const centre = it.top + it.h / 2 - (y + vh / 2);
      it.el.style.setProperty('--py', (-centre * it.k).toFixed(1) + 'px');
    }
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// RETICLE - the page is advertising a shooter, so the pointer is a reticle.
//
// The native cursor is hidden and this replaces it, which is only safe because the ring is drawn AT the
// pointer with no lag on the crosshair itself (the soft outer ring trails, the centre dot does not) and
// because it never runs where a pointer is not the input device: no fine pointer, no reticle, native
// cursor untouched. Same for reduced motion.
//
// USER DECREE: one reticle, identical everywhere, always - it never changes over links/buttons/tabs.
// What differs is the REACTION to being shot (the target flashes), never the crosshair itself.
export function reticle(onShot) {
  if (reduced() || !matchMedia('(pointer: fine)').matches) return;
  const el = document.createElement('div');
  el.id = 'reticle';
  el.innerHTML = '<i class="ring"></i><i class="dot"></i>';
  document.body.append(el);
  const hits = document.createElement('div');
  hits.id = 'hits';                    // impacts live in their own layer so they never affect the page
  document.body.append(hits);
  // NOT added here. `has-reticle` sets `cursor:none` on everything, and the reticle is parked off-screen
  // until the first pointer move - so adding it at setup gave a visitor who had not moved the mouse yet
  // no pointer at all. It goes on with the first move, below.
  // A keyboard user who never touches the mouse has the same problem the other way: tabbing hands the
  // native cursor back, and the next pointer move takes the reticle again.
  addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab') document.documentElement.classList.remove('has-reticle');
  });
  const ring = el.querySelector('.ring'), dot = el.querySelector('.dot');
  let x = innerWidth / 2, y = innerHeight / 2, rx = x, ry = y, live = false;

  addEventListener('pointermove', (e) => {
    x = e.clientX; y = e.clientY;
    dot.style.transform = `translate3d(${x}px,${y}px,0)`;
    document.documentElement.classList.add('has-reticle');
    if (!live) { live = true; onFrame(loop); }
  }, { passive: true });

  /**
   * You click, it shoots.
   *
   * The shot is decoration ONLY: this handler never calls preventDefault and never delays anything, so
   * the link still navigates and the button still presses on the same event it always did. All it adds
   * is an impact at the point of the click and a flash on whatever was under it - the page reacts like
   * something that was hit rather than something that was clicked.
   */
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.classList.add('fire');
    // NOT on a creature. range.js throws its own violet impact there, and two sparks in two colours on
    // the same pixel is why shooting a creature looked exactly like shooting the sky.
    if (e.target.closest?.('.beast')) { onShot?.(); return; }
    const b = document.createElement('i');
    b.className = 'hit';
    b.style.left = e.clientX + 'px';
    b.style.top = e.clientY + 'px';
    // four sparks on fixed angles, jittered - random enough to read as debris, cheap enough to be free
    const a0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < 4; i++) {
      const s = document.createElement('u');
      const a = a0 + i * (Math.PI / 2) + (Math.random() - 0.5) * 0.7;
      const d = 16 + Math.random() * 16;
      s.style.setProperty('--dx', (Math.cos(a) * d).toFixed(1) + 'px');
      s.style.setProperty('--dy', (Math.sin(a) * d).toFixed(1) + 'px');
      b.append(s);
    }
    hits.append(b);
    setTimeout(() => b.remove(), 620);
    const target = e.target.closest?.('a,button,figure,[role="tab"]');
    if (target) {
      // 'hitflash', not 'shot' - '.shot' already means something else (#foes .shot is a bestiary
      // layout class) and the collision was firing this flash on that image once on load.
      target.classList.add('hitflash');
      setTimeout(() => target.classList.remove('hitflash'), 380);
    }
    onShot?.();
  }, { passive: true });

  addEventListener('pointerup', () => el.classList.remove('fire'), { passive: true });
  addEventListener('pointerleave', () => el.classList.add('out'));
  addEventListener('pointerenter', () => el.classList.remove('out'));
  const loop = (dt) => {
    rx = approach(rx, x, dt, 22); ry = approach(ry, y, dt, 22);
    ring.style.transform = `translate3d(${rx.toFixed(1)}px,${ry.toFixed(1)}px,0)`;
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// IMAGE FADE - every screenshot on this page arrives late by design (lazy, or lazy-group). Popping in
// at full opacity is the single loudest "this is a web page" tell there is; a 500 ms fade off `decode()`
// reads as the image being revealed rather than snapping into place.
export function imgFade(root = document) {
  const done = (img) => img.classList.add('shown');
  const watch = (img) => {
    if (img.complete && img.naturalWidth) return done(img);
    img.addEventListener('load', () => done(img), { once: true });
    img.addEventListener('error', () => done(img), { once: true });   // never leave a hole
  };
  for (const img of root.querySelectorAll('img')) { img.classList.add('fadein'); watch(img); }
  // images whose src is set later (lazyGroups, the rail) are caught by watching the attribute
  new MutationObserver((ms) => {
    for (const m of ms) if (m.target.tagName === 'IMG') watch(m.target);
  }).observe(root.body || root, { subtree: true, attributes: true, attributeFilter: ['src'] });
}

// ---------------------------------------------------------------------------------------------
// SOUND - the same two blips the game's own menus use, and the game's own music.
//
// Nothing is fetched, and no AudioContext exists, until the visitor does something. The blips are
// synthesized (no asset at all). The ambient track is the REAL region theme from the game, streamed on
// demand and cross-faded when the backdrop travels somewhere else - so the page sounds like the place
// it is currently showing. Off by default, because a site that makes noise at you is a site people close.
const THEME = {
  vale: 'field', hero: 'night', combat: 'field', creatures: 'field',
  forest: 'wood', tundra: 'frost', celestial: 'choir', dragon: 'drums', infernal: 'forge',
  lost: 'convergence', shadowfen: 'fen', sunken: 'deep', void: 'void',
};

export function sound() {
  let ac = null, on = false, cur = null, curKey = null, place = 'hero', placeTimer = 0;

  const ctx = () => {
    if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ac = new AC(); }
    if (ac?.state === 'suspended') ac.resume();
    return ac;
  };

  /** the game's menu blip: triangle, quick downward glide, tiny */
  const blip = (freq, dur, gain) => {
    const a = ctx(); if (!a) return;
    try {
      const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.62, t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* audio is a garnish */ }
  };

  const fade = (el, to, ms, then) => {
    const from = el.volume, t0 = performance.now();
    onFrame(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      try { el.volume = from + (to - from) * k; } catch (e) { return false; }
      if (k < 1) return true;
      then?.(); return false;
    });
  };

  const playTheme = (key) => {
    if (!on || key === curKey) return;
    curKey = key;
    const next = new Audio(`/assets/music/${key}-theme.mp3`);
    next.loop = true; next.preload = 'none'; next.volume = 0;
    // in the DOM rather than a floating Audio object: the browser manages it with the document (it
    // stops on navigation, it shows in the tab's media controls) and it is inspectable from a test
    next.hidden = true; next.dataset.theme = key;
    document.body.append(next);
    next.play().then(() => {
      fade(next, 0.34, 1400);
      if (cur) { const old = cur; fade(old, 0, 1200, () => { old.pause(); old.removeAttribute('src'); old.load(); old.remove(); }); }
      cur = next;
    }).catch(() => { curKey = null; });
  };

  /** the shot the reticle makes: a short noise burst with a fast decay, shaped like a report */
  const shot = () => {
    const a = ctx(); if (!a || !on) return;
    try {
      const t = a.currentTime, n = 0.09;
      const buf = a.createBuffer(1, Math.ceil(a.sampleRate * n), a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
      const src = a.createBufferSource(); src.buffer = buf;
      const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.7;
      const g = a.createGain();
      g.gain.setValueAtTime(0.09, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + n);
      src.connect(bp).connect(g).connect(a.destination);
      src.start(t);
    } catch (e) { /* garnish */ }
  };

  return {
    move: () => on && blip(880, 0.035, 0.026),
    select: () => on && blip(300, 0.20, 0.045),
    shot,
    /** the hit marker. A shooter never omits this channel - a hit that makes no sound is half a hit. */
    hit: (kill) => { if (!on) return; blip(kill ? 520 : 1320, 0.05, kill ? 0.05 : 0.03);
      if (kill) setTimeout(() => blip(300, 0.16, 0.05), 70); },
    get on() { return on; },
    /** the backdrop moved; follow it if the sound is on. Debounced: the rail fires this once per card
     *  crossed while dragging, and each theme is 1.4-3.4 MB, so only the place you actually settle on
     *  should ever start a fetch. */
    setPlace(id) {
      place = id;
      clearTimeout(placeTimer);
      placeTimer = setTimeout(() => playTheme(THEME[id] || 'field'), 700);
    },
    toggle() {
      on = !on;
      if (on) { ctx(); playTheme(THEME[place] || 'field'); blip(660, 0.06, 0.03); }
      else if (cur) { const old = cur; cur = null; curKey = null; fade(old, 0, 350, () => { old.pause(); old.removeAttribute('src'); old.load(); old.remove(); }); }
      return on;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// SCROLL PROGRESS - a hairline under the top bar. One transform, driven by the same scroll listener
// everything else uses.
export function progress(el) {
  if (!el) return;
  let last = -1;
  const upd = () => {
    const h = document.documentElement.scrollHeight - innerHeight;
    const k = h > 0 ? clamp(scrollY / h) : 0;
    if (Math.abs(k - last) < 0.002) return;
    last = k;
    el.style.transform = `scaleX(${k.toFixed(4)})`;
  };
  addEventListener('scroll', upd, { passive: true });
  addEventListener('resize', upd);
  upd();
}

// ---------------------------------------------------------------------------------------------
// PRESS - the spring squash every control in the game gets on pointerdown. Delegated once for the page.
export function press(selector = '.press') {
  addEventListener('pointerdown', (e) => {
    const t = e.target.closest(selector);
    if (t) t.classList.add('down');
  }, { passive: true });
  const up = () => { for (const el of document.querySelectorAll(selector + '.down')) el.classList.remove('down'); };
  addEventListener('pointerup', up, { passive: true });
  addEventListener('pointercancel', up, { passive: true });
}
