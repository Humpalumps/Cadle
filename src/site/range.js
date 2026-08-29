/**
 * cadle.gg - the range.   (orchestrator)
 *
 * The page advertises a shooter, so the page IS one. The cursor is a reticle, a click is a shot, and
 * EVERYTHING on the page knows how it is supposed to react to being hit. There is no such thing here as
 * a click that lands nowhere:
 *
 *   CONTROLS   take the hit and spin a full turn, then do exactly what they were always going to do.
 *   CREATURES  flinch AWAY from the shot, and enough hits knock them clean off whatever they sat on.
 *   TYPE       takes the shock through the line it is set in.
 *   ANYTHING   else keeps the bullet hole, where you put it, until you leave the page.
 *
 * THE ONE RULE THIS FILE MAY NOT BREAK: **the site still has to be a website.** Nothing here ever calls
 * preventDefault on a real interaction, nothing gates a link behind a hit, and every effect is additive.
 * A visitor who does not notice any of it clicks a link and it works, at the speed it always did. Not
 * one line of this file calls preventDefault: the only delay on the page is the 240 ms leave-fade that
 * main.js already had before /play, and the spin simply plays inside it.
 *
 * PERFORMANCE
 *  - Decals are pooled per target AND capped across the page (MAX_HOLES / MAX_TOTAL). "Shoot anything"
 *    means a bored visitor can hold the button down for a minute, so the node count has to be bounded by
 *    a constant rather than by their patience - the oldest hole on the page is always the next to go.
 *  - Every effect is a CSS animation on transform/opacity/filter, cleaned up by its own timer.
 *  - Creatures are ordinary lazy <img>. They animate only while idling in view or while being hit.
 *  - `prefers-reduced-motion` disables the whole file. The page keeps working; it just stops playing.
 */
import { reduced } from './ui.js';

const MAX_HOLES = 8;          // per target; beyond this the target's oldest is recycled
const MAX_TOTAL = 48;         // and across the whole page, so a held trigger cannot grow the DOM
const FLIP_MS = 380;          // how long a shot control spins

/**
 * What a shot lands on when it is not a creature and not a control. Ordered most specific first: the
 * hole belongs to the smallest thing that owns the pixel, so it scales and scrolls with it. `section`
 * is the backstop - which is why a shot into the sky leaves a hole in the sky, and why there is no
 * pixel on this page that swallows a click.
 */
// NOT `.plate`, `.pane` or `.card`. Those are the reading panels, and a permanent 56 px decal over 15 px
// body copy makes the site worse at being a site - three shots into one paragraph left "aetheryte" and
// "Nine other places" unreadable for the rest of the visit. A shot there falls through to the section, so
// the hole lands in the art behind the panel and the words survive.
const SURFACE = 'figure, .tiltcard, .rail-card, .stat, .railclip, #bar, footer, section';
/** the controls, which spin instead of taking a hole - they are the thing you hit, not a wall behind it */
// NOT `.rail-card`, even though it is a link. `.spun` animates a transform, and rail.js writes an inline
// transform to every card on every frame - measured, the spin threw "The Void" 885 px across the screen
// and out of the cylinder before it snapped back. It stays in SURFACE and takes a hole like the art it
// is; `punch()` already skips the `.jolt` on rail cards for exactly the same reason.
const CONTROL = '.btn, #bar nav a, .seg button, .railnav button, .rail-dots button, #spk, .lb-nav, '
              + '.lb-close';
/** a line of type takes the shock through the line, so a shot into a paragraph is not a dead click */
const TYPE = 'h1, h2, h3, h4, p, li, blockquote, figcaption, .lede, .eyebrow';

/**
 * The hole. One inline SVG - no request, scales with the picture, and legible on ANY frame because it
 * carries its own darkening AND its own bright chipped rim: a purely dark decal disappears into the
 * Void's night shots, a purely bright one disappears into the meadow.
 *
 * Drawn at 64 units and displayed at 56 px. The first version was 34 px with hairline cracks and read
 * as a speck of dust on a screenshot - checked on the actual page, which is the only way to know.
 */
// NO <defs><radialGradient id="..."> - every hole is a copy of this markup, so a fixed id meant N
// elements in the document sharing one id, and every hole's fill resolving to the FIRST one. Recycle
// that first hole (MAX_HOLES is 8, MAX_TOTAL is 48 - it gets recycled constantly) and the gradient it
// owned leaves the document, and every remaining hole on the page loses its darkening at once. The
// darkening is a plain <circle> stack now: no ids, nothing shared, nothing to lose.
const HOLE_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="32" r="31" fill="rgba(4,3,10,.16)"/>
  <circle cx="32" cy="32" r="24" fill="rgba(4,3,10,.26)"/>
  <circle cx="32" cy="32" r="17" fill="rgba(2,1,7,.42)"/>
  <circle cx="32" cy="32" r="11" fill="rgba(0,0,0,.62)"/>
  <g class="cracks" stroke="rgba(6,5,12,.9)" stroke-linecap="round" fill="none">
    <path d="M32 32 L57 18" stroke-width="3"/><path d="M32 32 L50 55" stroke-width="2.4"/>
    <path d="M32 32 L9 47" stroke-width="2.8"/><path d="M32 32 L5 26" stroke-width="2.2"/>
    <path d="M32 32 L36 4" stroke-width="2.6"/><path d="M32 32 L18 12" stroke-width="1.8"/>
    <path d="M32 32 L60 38" stroke-width="1.8"/>
  </g>
  <g class="rim" stroke="rgba(244,232,205,.3)" fill="none">
    <path d="M32 32 L57 18" stroke-width="1"/><path d="M32 32 L9 47" stroke-width="1"/>
    <path d="M32 32 L36 4" stroke-width="1"/>
  </g>
  <circle cx="32" cy="32" r="10.5" fill="rgba(3,2,8,.96)"/>
  <!-- a ONE-SIDED lip, not a ring. Two complete bright annuli read as a brass grommet sitting on top of
       the picture rather than a hole in it, and a radially symmetric shape made the per-hole --rot
       rotation invisible. A ~140 deg crescent is a chipped edge, and it now points somewhere. -->
  <circle cx="32" cy="32" r="10.5" fill="none" stroke="rgba(248,238,214,.55)" stroke-width="1.4"
          stroke-dasharray="26 40" stroke-linecap="round"/>
  <circle cx="30.5" cy="30" r="3.2" fill="rgba(255,255,255,.12)"/>
</svg>`;

export function range(sfx) {
  // Same gate as the reticle, and for the same reason: without a reticle there is no shot, the creatures
  // are hidden under 900px anyway, and a hint that says "left click" is wrong on a phone. On touch this
  // is simply an ordinary website.
  if (reduced() || !matchMedia('(pointer: fine)').matches) return { kills: 0 };
  const state = { kills: 0, beasts: 0, holes: 0 };

  // ------------------------------------------------------------------ decals
  /** the layer a target keeps its holes in: inside the element, above the image, ignored by the pointer */
  const layerFor = (el) => {
    let l = el.querySelector(':scope > .holes');
    if (!l) {
      // A hole is positioned against its host, so a static host would fling every decal out to whatever
      // ancestor happens not to be. These are block containers whose children are already in flow, so
      // promoting one costs no layout but gives the decal something to hold on to.
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      l = document.createElement('div');
      l.className = 'holes';
      el.append(l);
    }
    return l;
  };

  // Every hole on the page, oldest first. Now that anything can be shot, this queue is the only thing
  // between a held trigger and a thousand DOM nodes.
  const allHoles = [];
  const drop = (h) => {
    const i = allHoles.indexOf(h);
    if (i >= 0) allHoles.splice(i, 1);
    h.remove();
  };

  const punch = (el, clientX, clientY) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const l = layerFor(el);
    const h = document.createElement('i');
    h.className = 'hole';
    // percentages, not pixels: the picture scales on hover and the hole has to stay in the same place
    h.style.left = (((clientX - r.left) / r.width) * 100).toFixed(2) + '%';
    h.style.top = (((clientY - r.top) / r.height) * 100).toFixed(2) + '%';
    h.style.setProperty('--rot', (Math.random() * 360).toFixed(0) + 'deg');
    h.style.setProperty('--sz', (0.82 + Math.random() * 0.42).toFixed(2));
    h.innerHTML = HOLE_SVG;
    l.append(h);
    allHoles.push(h);
    while (l.children.length > MAX_HOLES) drop(l.firstElementChild);
    while (allHoles.length > MAX_TOTAL) drop(allHoles[0]);
    state.holes = allHoles.length;
    // The shake is a `transform` animation, and a rail card already has one written to it every frame by
    // rail.js. Running both means the card snaps out of the cylinder for 300 ms. The hole still lands;
    // the card just does not jump. A section is excluded for a different reason: shaking a whole
    // viewport of content because someone clicked the background is nausea, not feedback.
    if (el.closest('.rail') || el.matches('section, #bar, footer, .plate, .pane, .card')) return;
    el.classList.remove('jolt');
    void el.offsetWidth;                       // restart the shake even on a rapid second hit
    el.classList.add('jolt');
  };

  // ------------------------------------------------------------------ creatures
  /**
   * Every `.beast` in the markup is a creature sitting on the page. They idle, they flinch when hit, and
   * when their hit points run out they come off whatever they were on and fall out of the document.
   * They come back after a while, because a toy you can only use once is not a toy.
   */
  const beasts = [...document.querySelectorAll('.beast')];
  state.beasts = beasts.length;
  for (const b of beasts) {
    b.dataset.hpMax = b.dataset.hp || '3';
    b.dataset.hpLeft = b.dataset.hpMax;
  }
  // Only the creatures you can actually see are allowed to move. Six idle animations running the whole
  // page long is six compositor animations for nothing; this keeps it to the one or two on screen.
  const idleIO = new IntersectionObserver((es) => {
    for (const e of es) e.target.classList.toggle('idle', e.isIntersecting);
  }, { rootMargin: '10% 0px' });
  for (const b of beasts) idleIO.observe(b);

  /**
   * A HIT HAS TO READ. The first version decremented hit points, played a 14 px flinch and threw a small
   * spark, and a real person shot a creature three times and reported that "it doesn't get shot" - which
   * is a feedback failure, not a logic one. A shooter answers a hit on four channels at once, and this
   * now does the same: the body takes the blow (a hard punch away, briefly blown out white), the impact
   * makes a mark (spark plus an expanding ring), the damage is NUMBERED, and the creature's remaining
   * health is drawn over it so the third shot is visibly the last one.
   */
  const hitBeast = (b, x, y) => {
    if (b.classList.contains('dead')) return;
    const max = +b.dataset.hpMax || 3;
    const left = Math.max(0, (+b.dataset.hpLeft || 1) - 1);
    b.dataset.hpLeft = String(left);
    spark(x, y, left ? 'flesh' : 'kill');
    shock(x, y, !left);
    // Damage that means something: the same 100 spread over however many hits this one takes, so the
    // number on the last hit is the number that finished it.
    damage(x, y, left ? Math.round(100 / max) : 'DOWN', !left);
    pips(b, left, max);
    sfx?.hit?.(!left);
    // HIT-STOP. The cheapest weight a hit can have: freeze the body at the top of the flinch for a beat
    // before it recovers. Without it the whole thing is one uninterrupted 380 ms ease and lands soft.
    // 80 ms, not 34: at 34 the freeze landed INSIDE the flinch's colour blowout and held the creature as
    // a flat silhouette for 136 ms of wall clock. At 80 the flash is over and what it holds is the
    // displaced pose, which is the thing worth holding.
    clearTimeout(b._stopT);
    b._stopT = setTimeout(() => {
      b.style.animationPlayState = 'paused';
      b._stopT = setTimeout(() => { b.style.animationPlayState = ''; }, left ? 60 : 120);
    }, 80);
    // Which side did it come from: a creature shot in the near flank goes over the OTHER way. Random
    // read fine until you shot the same one twice and watched it fall towards the bullet.
    const r = b.getBoundingClientRect();
    const away = x < r.left + r.width / 2 ? 1 : -1;
    b.style.setProperty('--away', String(away));
    if (left) {
      b.classList.remove('flinch'); void b.offsetWidth; b.classList.add('flinch');
      // ...and it has to come OFF again. `.beast.grounded.idle.flinch` out-specifies the idle, so a
      // creature that keeps the class after one hit never moves again - measured 0.00 px over 1.2 s.
      b.addEventListener('animationend', () => b.classList.remove('flinch'), { once: true });
      return;
    }
    // down it goes: off the perch in the direction the shot pushed it, then out of the layout entirely
    b.classList.add('dead');
    b.style.setProperty('--fall-x', (away * (70 + Math.random() * 110)).toFixed(0) + 'px');
    b.style.setProperty('--fall-r', (away * (60 + Math.random() * 160)).toFixed(0) + 'deg');
    state.kills++;
    tally();
    setTimeout(() => {                          // back on its perch a while later
      b.classList.remove('dead', 'flinch');
      b.dataset.hpLeft = b.dataset.hpMax;
      b.classList.add('respawn');
      setTimeout(() => b.classList.remove('respawn'), 900);
    }, 26000);
  };

  // ------------------------------------------------------------------ the hint
  /**
   * Nobody discovers a toy nobody mentions. The reticle is a cue, but it is a quiet one, and a visitor
   * who never left-clicks a picture never finds out the page is a range at all.
   *
   * So: one line, once, a few seconds in, in the corner the tally will later occupy - and it deletes
   * itself the instant you fire, which for anyone who already got it is before they ever read it.
   */
  let hintEl = null, fired = false;
  const hint = setTimeout(() => {
    if (fired) return;
    hintEl = document.createElement('div');
    hintEl.id = 'hint';
    hintEl.innerHTML = '<b>&#8982;</b><span>Left click anything. It shoots.</span>';
    document.body.append(hintEl);
    requestAnimationFrame(() => hintEl.classList.add('on'));
    setTimeout(() => dropHint(), 11000);
  }, 2600);
  const dropHint = () => {
    clearTimeout(hint);
    if (!hintEl) return;
    hintEl.classList.remove('on');
    const el = hintEl; hintEl = null;
    setTimeout(() => el.remove(), 500);
  };

  // ------------------------------------------------------------------ the tally
  let tallyEl = null;
  const tally = () => {
    if (!state.beasts) return;
    if (!tallyEl) {
      tallyEl = document.createElement('div');
      tallyEl.id = 'tally';
      // "downed", not "cleared": the count is cumulative and they respawn after 26 s, so "cleared" would
      // be a lie the moment one comes back
      tallyEl.innerHTML = '<b></b><span>downed</span>';
      document.body.append(tallyEl);
    }
    tallyEl.querySelector('b').textContent = `${state.kills} / ${state.beasts}`;
    tallyEl.classList.add('on', 'pop');
    setTimeout(() => tallyEl.classList.remove('pop'), 500);
    if (state.kills >= state.beasts) tallyEl.classList.add('all');
  };

  // ------------------------------------------------------------------ sparks (shared with the reticle)
  const sparkLayer = document.getElementById('hits') || document.body;
  const spark = (x, y, kind) => {
    const b = document.createElement('i');
    b.className = 'hit ' + kind;
    b.style.left = x + 'px'; b.style.top = y + 'px';
    for (let i = 0; i < 5; i++) {
      const s = document.createElement('u');
      const a = Math.random() * Math.PI * 2, d = 18 + Math.random() * 22;
      s.style.setProperty('--dx', (Math.cos(a) * d).toFixed(1) + 'px');
      s.style.setProperty('--dy', (Math.sin(a) * d).toFixed(1) + 'px');
      b.append(s);
    }
    sparkLayer.append(b);
    setTimeout(() => b.remove(), 700);
  };

  /** the shockwave: one expanding ring at the impact, so the hit has a size and not just a position */
  const shock = (x, y, big) => {
    const e = document.createElement('i');
    e.className = 'shock' + (big ? ' big' : '');
    e.style.left = x + 'px'; e.style.top = y + 'px';
    sparkLayer.append(e);
    setTimeout(() => e.remove(), 620);
  };

  /** the damage number. The single most legible "that landed" signal a shooter has. */
  let dmgSeq = 0;
  const damage = (x, y, n, big) => {
    const e = document.createElement('b');
    e.className = 'dmg' + (big ? ' big' : '');
    e.textContent = n;
    // spawned up and to the left of the impact, because the reticle is sitting exactly on the impact and
    // a number underneath a crosshair is a number nobody reads
    e.style.left = (x - 26) + 'px'; e.style.top = (y - 30) + 'px';
    // Scatter on BOTH axes. Horizontal-only was sized for a 900 ms life; at 1250 ms three fast hits
    // coexist for most of a second and stacked into "2ϩ5/25" - an illegible knot at the impact point.
    e.style.setProperty('--dx', (Math.random() * 44 - 22).toFixed(0) + 'px');
    e.style.setProperty('--dy', (dmgSeq++ % 3) * -22 + 'px');
    sparkLayer.append(e);
    setTimeout(() => e.remove(), 900);
  };

  /**
   * The health pips, drawn over the creature on every hit and gone again a second and a half later. They
   * exist so the third shot is visibly the last one - without them a creature with four hit points reads
   * as an invulnerable decoration for its first three.
   */
  const pips = (b, left, max) => {
    let e = b._pips;
    if (!e || !e.isConnected) {
      e = document.createElement('div');
      e.className = 'pips';
      // The creature's OWN parent, not the fixed overlay. In the overlay the bar was written once in
      // viewport coordinates and then stranded by the next scroll - measured 245 px adrift from its
      // creature, at full opacity, floating in the gap between two sections.
      (b.offsetParent || b.parentElement || sparkLayer).append(e);
      b._pips = e;
    }
    e.innerHTML = Array.from({ length: max },
      (_, i) => `<u class="${i < left ? 'on' : ''}"></u>`).join('');
    e.style.left = (b.offsetLeft + b.offsetWidth / 2) + 'px';
    e.style.top = (b.offsetTop - 16) + 'px';
    e.classList.remove('on'); void e.offsetWidth; e.classList.add('on');
    clearTimeout(b._pipT);
    // a WOUNDED creature keeps its bar up: "one more" has to be visible before you fire it
    if (left > 0 && left < max) return;
    b._pipT = setTimeout(() => e.classList.remove('on'), 1500);
  };

  /**
   * A sprite is a rectangle with a creature somewhere inside it. 39-56% of every one of these boxes is
   * transparent air, and a click into that air was counting as a hit - you could shoot 8% into the
   * drake's box, where there is nothing, and take a point off it. One cached alpha map each; a shot that
   * misses falls through to the surface behind, which is better feedback than a free hit.
   */
  const ALPHA = new Map();
  const alphaAt = (img, fx, fy) => {
    let m = ALPHA.get(img.src);
    if (m === undefined) {
      m = null;
      try {
        const W = 96, H = Math.max(1, Math.round(96 * (img.naturalHeight / img.naturalWidth || 1)));
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, W, H);
        m = { W, H, d: g.getImageData(0, 0, W, H).data };
      } catch (e) { m = null; }        // a tainted canvas must never cost anyone a shot
      ALPHA.set(img.src, m);
    }
    if (!m) return 255;
    const x = Math.min(m.W - 1, Math.max(0, Math.round(fx * m.W)));
    const y = Math.min(m.H - 1, Math.max(0, Math.round(fy * m.H)));
    return m.d[(y * m.W + x) * 4 + 3];
  };

  // ------------------------------------------------------------------ the shot
  // ONE listener, in the capture phase so it sees the event before anything else, and PASSIVE so it
  // cannot stop or delay a single thing the page was going to do.
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    fired = true; dropHint();
    const t = e.target;
    if (!t?.closest) return;

    // 1. a creature - but only where there is actually a creature. The box is 39-56% transparent air.
    const beast = t.closest('.beast');
    if (beast) {
      const r = beast.getBoundingClientRect();
      const a = alphaAt(beast, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      if (a > 24) { hitBeast(beast, e.clientX, e.clientY); return; }
      // A MISS. It falls through to the surface behind - but it also has to LOOK like a miss rather than
      // like a click that did not register. ui.js suppresses its own spark over a creature (two sparks
      // on one pixel is why a hit used to look like a shot into the sky), and it cannot know about the
      // alpha test, so the miss throws the ordinary impact itself. Measured before this: a miss changed
      // 1.3% of the pixels around it against 8.2% for shooting empty sky.
      spark(e.clientX, e.clientY, '');
    }

    // 2. a control. It takes the hit itself and spins - you shot the button, not the wall behind it.
    const ctrl = t.closest(CONTROL);
    if (ctrl) {
      ctrl.classList.remove('spun'); void ctrl.offsetWidth;
      ctrl.classList.add('spun');
      setTimeout(() => ctrl.classList.remove('spun'), FLIP_MS + 40);
      return;
    }

    // 3. everything else keeps the hole, on the smallest surface that owns the pixel...
    const pic = t.closest(SURFACE);
    if (pic) punch(pic, e.clientX, e.clientY);

    // ...and if it was a line of type, the line takes the shock as well. A shot into a paragraph used to
    // be the one click on this page with no answer.
    const line = t.closest(TYPE);
    if (line) {
      line.classList.remove('struck'); void line.offsetWidth;
      line.classList.add('struck');
      setTimeout(() => line.classList.remove('struck'), 440);
    }
  }, { capture: true, passive: true });

  // NOTE: nothing here intercepts a click. Every internal link on this page points at /play, and
  // main.js already holds those for 240 ms while the type fades out - which is exactly the window the
  // spin needs, so the two effects share one delay instead of stacking two. Tabs, the lightbox and the
  // rail fire on their own click as normal and simply spin underneath.

  return state;
}
