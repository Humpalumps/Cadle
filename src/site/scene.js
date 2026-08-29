/**
 * cadle.gg - the world behind the page.   (orchestrator)
 *
 * ONE fixed full-viewport canvas sits behind every section, and the whole site scrolls over it. It is
 * the SAME renderer the title screen uses (`src/ui/menu/backdrop.js`, on the same worker), so `/` and
 * `/play/` are visibly the same object: the same shafts, the same drifting aether, the same grade.
 *
 * What it does that a background image cannot:
 *  - **it travels.** Each section names a place, and the canvas cross-fades to that place's frame as
 *    the section takes the viewport. Scrolling the page is flying across the map.
 *  - **it has depth.** Pointer parallax and a scroll-linked dolly, both eased on the worker's own clock
 *    so a busy main thread cannot stutter them.
 *  - **it costs one draw call.** No per-section <img>, no stacked layers, no scroll-jacking.
 *
 * Everything about it is optional. No OffscreenCanvas, no WebGL2, a worker that fails to load, or
 * `prefers-reduced-motion`: the canvas hides itself and the CSS gradient underneath carries the page.
 */
import { onFrame, reduced } from './ui.js';

// the 1280 px "backdrop" cut, not the 1600 px gallery frame: this is drawn behind a scrim, under grain
// and a vignette, parallaxed and pushed - detail nobody can see is only bandwidth. See ASSETS.md.
const SHOT = (id) => `/assets/site/${id}-b.jpg`;
const HERO = '/assets/ui/menu_vista.jpg';       // shared with the title screen, so Play is a cache hit

export function startScene(canvas, onPlace) {
  if (!canvas) return null;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  // A soft graded painting behind type does not need more than ~1440p of real pixels, and the machine
  // this runs on might be a laptop that also has a page to composite.
  const px = () => {
    const s = Math.min(1, 2560 / Math.max(1, innerWidth * dpr));
    return [Math.round(innerWidth * dpr * s), Math.round(innerHeight * dpr * s)];
  };

  let worker = null, bd = null, ok = false;
  // re-paint the place we are already on, once we know the canvas is not going to draw it
  let refresh = null;
  const fail = () => {
    if (!worker) return;
    canvas.classList.remove('on');
    try { worker.terminate(); } catch (e) { /* already gone */ }
    worker = null;
    refresh?.();                      // and put the still up NOW, not at the next region change
  };
  const [w, h] = px();

  const post = (m, t) => { if (worker) worker.postMessage(m, t); };
  const set = (m) => { if (worker) post({ type: 'set', ...m }); else bd?.set(m); };

  if (!reduced()) {
    try {
      if (typeof OffscreenCanvas !== 'undefined' && canvas.transferControlToOffscreen
          && !new URLSearchParams(location.search).has('noworker')) {
        canvas.width = w; canvas.height = h;
        const off = canvas.transferControlToOffscreen();
        worker = new Worker(new URL('../ui/menu/backdropWorker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
          if (e.data?.type === 'firstFrame') { ok = true; canvas.classList.add('on'); }
          else if (e.data?.type === 'error') { fail(); }
        };
        // EVERY way this can go wrong ends in the same place. `new Worker()` resolves even when the
        // script 404s, so without this `worker` stayed truthy forever, every `go()` posted into the void
        // and the still-image fallback never ran: all ten region vistas gone, replaced by a flat
        // gradient, with nothing in the console. The three ways it fails are a load error, a runtime
        // error reported by the worker itself, and a worker that simply never draws - and the last one
        // needs a clock, because nothing will ever tell us about it.
        worker.onerror = fail;
        worker.onmessageerror = fail;
        setTimeout(() => { if (!ok) fail(); }, 3000);
        post({ type: 'init', canvas: off, size: { w, h }, still: HERO }, [off]);
      }
    } catch (e) { worker = null; }
  }

  // in-thread fallback: same class, same shader, one rAF subscriber
  if (!worker && !reduced()) {
    import('../ui/menu/backdrop.js').then(({ Backdrop }) => {
      bd = new Backdrop(canvas);
      if (!bd.ok) { bd = null; return; }
      bd.setSize(w, h);
      fetch(HERO, { cache: 'force-cache' }).then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
        .then((b) => createImageBitmap(b, { imageOrientation: 'flipY' }))
        .then((b) => { bd.setStill(b); ok = true; canvas.classList.add('on'); }).catch(() => {});
      onFrame((dt) => { bd?.frame(dt); return !!bd; });
    }).catch(() => {});
  }

  addEventListener('resize', () => {
    const [W, H] = px();
    if (worker) post({ type: 'size', w: W, h: H });
    else bd?.setSize(W, H);
  });

  // ---- pointer parallax. The worker eases toward the target, so a fast mouse costs one postMessage.
  let pmx = 0, pmy = 0;
  addEventListener('pointermove', (e) => {
    const x = Math.round(((e.clientX / innerWidth - 0.5) * 2) * 50) / 50;
    const y = Math.round(((e.clientY / innerHeight - 0.5) * 2) * 50) / 50;
    if (x === pmx && y === pmy) return;
    pmx = x; pmy = y;
    set({ mouse: [x, y] });
  }, { passive: true });

  // ---- the travel. Sections carry data-place; whichever one owns the middle of the screen wins.
  // `#ground` is the gradient that lives under the canvas; with no canvas it is the only thing there is,
  // so it carries the art instead.
  const ground = document.getElementById('ground') || document.body;
  let place = null, pending = null;
  const go = (id) => {
    if (id === place) return;
    place = id;
    onPlace?.(id);              // the ambient track follows the art, if the visitor asked for sound
    const url = id === 'hero' ? HERO : SHOT(id);
    // Reduced motion is a vestibular setting, not "ship me less product". Without this the ten region
    // vistas simply do not exist for that visitor and every section falls back to a flat purple
    // gradient. A still cross-fade of the SAME frame the canvas would have drawn has no motion in it.
    if (!worker && !bd) {
      ground.style.backgroundImage = `url("${url}")`;
      ground.classList.add('still');
      return;
    }
    if (worker) post({ type: 'layer', url, fade: 1.1 });
    else {
      const seq = ++pending;
      fetch(url, { cache: 'force-cache' }).then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
        .then((b) => createImageBitmap(b, { imageOrientation: 'flipY' }))
        .then((b) => { if (seq === pending && bd) { bd.fadeSecs = 1.1; bd.crossTo(b); } else b.close(); })
        .catch(() => {});
    }
  };

  refresh = () => { const id = place; place = null; if (id) go(id); };

  const places = [...document.querySelectorAll('[data-place]')];
  if (places.length) {
    // A rootMargin band across the middle of the viewport: the section that owns the middle is the one
    // you are looking at. Cheaper and steadier than measuring every section on every scroll event.
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) go(e.target.dataset.place);
    }, { rootMargin: '-45% 0px -45% 0px' });
    for (const s of places) io.observe(s);
  }

  // ---- scroll-linked dolly + exposure. One listener that records a number; the ramp is the worker's.
  let lastStep = -1;
  const onScroll = () => {
    const k = Math.min(1, scrollY / Math.max(1, innerHeight));
    const step = Math.round(k * 8) / 8;
    if (step === lastStep) return;
    lastStep = step;
    // dim under the content, and push in a little so the hero art recedes rather than just scrolling off
    set({ push: 0.15 + 0.85 * step, dim: 1 - 0.34 * step });
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  document.addEventListener('visibilitychange', () => post({ type: document.hidden ? 'pause' : 'resume' }));

  return {
    go,
    /** the region rail steers the canvas directly while you drag it */
    preview: (id) => go(id),
    get ready() { return ok; },
  };
}
