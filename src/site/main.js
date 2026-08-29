/**
 * cadle.gg - the entry point.   (orchestrator)
 *
 * The page is already complete and readable before this file runs: index.html carries the markup and
 * every style it needs, so the site works with JavaScript switched off. This module only adds motion
 * the world behind the page (scene.js), the region rail (rail.js), and the house component behaviours
 * (ui.js). Nothing here is load-bearing for the content.
 *
 * It also deliberately does NOT touch the game. `/` never constructs a renderer, never imports three,
 * never preloads a game asset. The Play button is a link to `/play?start`, which is the only thing on
 * the whole site that starts a world.
 */
import {
  reveals, tickers, tilt, segmented, panes, lightbox, parallax, press, splitWords,
  lazyGroups, reticle, imgFade, sound, progress, reduced,
} from './ui.js';
import { startScene } from './scene.js';
import { rail } from './rail.js';
import { range } from './range.js';

// ---- text: split the hero and the section titles into words so they can cascade in ---------------
for (const el of document.querySelectorAll('.split')) splitWords(el);

// ---- sound. Nothing is fetched and no AudioContext exists until the visitor asks. ------------------
const sfx = sound();

// ---- the world behind the page. The ambient track follows wherever the art travels to. ------------
const scene = startScene(document.getElementById('scene'), (id) => sfx.setPlace(id));

// ---- house components ------------------------------------------------------------------------------
press();
reveals();
lazyGroups();
imgFade();
tickers();
parallax();
reticle(() => sfx.shot());     // click = a shot, with the report if the sound is on
// ...and the shot lands: controls spin, pictures keep the hole, creatures come off their perch.
// Nothing here gates a real interaction - see the note at the top of range.js.
range(sfx);
progress(document.querySelector('#bar .prog'));
for (const el of document.querySelectorAll('.tiltcard')) tilt(el);

// ---- the sound toggle ------------------------------------------------------------------------------
const spk = document.getElementById('spk');
if (spk) {
  spk.addEventListener('click', () => {
    const on = sfx.toggle();
    spk.classList.toggle('on', on);
    spk.setAttribute('aria-pressed', String(on));
    spk.title = on ? 'Sound on' : 'Sound off';
  });
}

// ---- the game's menu blips, on the page's own controls ---------------------------------------------
for (const el of document.querySelectorAll('#bar nav a, .seg button, .rail-card, .btn, .railnav button')) {
  el.addEventListener('pointerenter', () => sfx.move(), { passive: true });
  el.addEventListener('click', () => sfx.select(), { passive: true });
}

// ---- what you do: the game's own segmented control, driving a blur cross-fade ---------------------
const seg = document.querySelector('#do .seg');
if (seg) {
  const body = document.querySelector('#do .segbody');
  segmented(seg, (k) => panes(body, k));
}

// ---- the region rail steers the backdrop ------------------------------------------------------------
const railRoot = document.querySelector('.rail');
if (railRoot) {
  rail(railRoot, {
    onCentre: (id) => { if (id) scene?.preview(id); },
  });
}

// ---- gallery -> centre-morph lightbox, arrowable ----------------------------------------------------
const figs = [...document.querySelectorAll('#gallery figure')];
if (figs.length) {
  const lb = lightbox(figs.map((f) => ({
    src: f.querySelector('img').getAttribute('src'),
    caption: f.querySelector('figcaption')?.textContent,
  })));
  // The gallery is both the most obviously shootable thing on the page and the thing that opens a modal,
  // and the modal used to land on top of the bullet hole in the same frame you made it. 260 ms is long
  // enough to watch the hole punch in and short enough that nobody perceives a delay - the shot happens,
  // THEN the picture expands. Under reduced motion there is no shot, so there is nothing to wait for.
  // 260 was measured as still too quick to read: the scrim was already up while the decal was scaling in.
  const hold = reduced() ? 0 : 520;
  figs.forEach((fig, i) => {
    fig.tabIndex = 0;
    fig.addEventListener('click', () => { sfx.select(); setTimeout(() => lb.open(i, fig), hold); });
    fig.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lb.open(i, fig); }
    });
  });
}

// ---- the top bar earns its background once you have left the hero -------------------------------
const bar = document.getElementById('bar');
const heroWrap = document.querySelector('#hero .wrap');
if (bar && heroWrap) {
  new IntersectionObserver(([e]) => {
    bar.classList.toggle('stuck', !e.isIntersecting);
    // ...and the range's hint belongs to the first screen only. Fixed, it used to follow the reader down
    // and sit across the left copy column of the next two sections for its whole life.
    document.documentElement.classList.toggle('past-hero', !e.isIntersecting);
  }, { rootMargin: '-72px 0px 0px 0px' }).observe(heroWrap);
}

// ---- the nav marks the section you are in ------------------------------------------------------------
const links = [...document.querySelectorAll('#bar nav a[href^="#"]')];
if (links.length) {
  const map = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) {
      for (const a of links) a.classList.toggle('on', map.get(e.target.id) === a);
    }
  }, { rootMargin: '-48% 0px -48% 0px' });
  for (const id of map.keys()) { const s = document.getElementById(id); if (s) io.observe(s); }
}

// ---- Play: hand over to /play with the art still on screen ----------------------------------------
// Both pages draw the SAME vista on the SAME shader, so the only thing that visibly changes across the
// navigation is the type. Fading the type out first (and leaving the canvas alone) turns a page load
// into a dissolve - the loading screen appears to have been under the landing page the whole time.
// 240 ms, and the navigation happens on a timer rather than on transitionend so a missed event can
// never strand someone on a faded-out page.
for (const a of document.querySelectorAll('a[href^="/play"]')) {
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || reduced()) return;
    e.preventDefault();
    document.documentElement.classList.add('leaving');
    setTimeout(() => { location.href = a.getAttribute('href'); }, 240);
  });
}

// ---- Play: warm the game's document the moment the pointer is anywhere near it -------------------
// A prefetch, not a boot. The engine chunk is fetched by /play/ itself; this only means the document
// and its module graph are already in the HTTP cache when the click lands.
let warmed = false;
const warm = () => {
  if (warmed) return;
  warmed = true;
  for (const href of ['/play/', '/assets/ui/menu_vista.jpg']) {
    const l = document.createElement('link');
    l.rel = 'prefetch'; l.href = href;
    document.head.append(l);
  }
};
for (const a of document.querySelectorAll('a[href^="/play"]')) {
  a.addEventListener('pointerenter', warm, { once: true, passive: true });
  a.addEventListener('focus', warm, { once: true, passive: true });
}
addEventListener('load', () => setTimeout(warm, 2500), { once: true });

// ---- reduced motion: say so in the DOM so the CSS can stop everything at once --------------------
if (reduced()) document.documentElement.classList.add('rm');
