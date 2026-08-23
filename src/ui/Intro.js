import * as THREE from 'three';
import { makeCanvas } from './intro/env.js';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, VignetteEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, NoiseEffect, BlendFunction, Effect } from 'postprocessing';
import { buildStage, SCREEN } from './intro/stage.js';

/**
 * Intro: the cinematic loading screen.   (orchestrator)
 *
 * A guy sits at his computer in a dark bedroom at night. The game is on his monitor — first its title
 * screen with the load bar (the load bar is diegetic: it IS the thing on his screen), then, once the
 * world is built, the LIVE game rendered into a render target. He clicks, the screen opens, and he is
 * pulled head-first into the monitor; the camera follows him through and comes out inside the game.
 *
 * Design decisions worth knowing before editing:
 *  - It uses the GAME's renderer and the GAME's canvas. Not a second WebGL context: sharing the renderer
 *    is the only way to put the real, live game on the monitor (a render target), and it means there is
 *    no second GPU context competing with the load.
 *  - The handover is hidden by a DOM flash element, not by a cross-fade. The intro composer stops and
 *    game.start() takes the canvas during a full-screen violet-white flash, so there is nothing to align.
 *  - It never blocks boot. Any failure in here disposes and starts the game.
 *  - ?auto=1 (the harness) skips it entirely unless ?intro=1 is also given — automation must be unchanged.
 *
 * Wiring (src/main.js): new Intro(game) -> intro.setProgress() from 'assets:progress' -> intro.arm() when
 * game.ready resolves -> the player's click runs intro.play() -> resolves -> game.start().
 */

// radial swirl + pinch + chromatic aberration, centred on the monitor. 0 = off.
const WARP_FRAG = /* glsl */`
uniform float uAmount;
uniform vec2 uCenter;
vec2 warpUv(vec2 uv, float k) {
  vec2 d = uv - uCenter;
  d.x *= uAspect;
  float r = length(d);
  float ang = k * 2.2 * exp(-r * 2.6);
  float s = sin(ang), c = cos(ang);
  d = vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  d *= 1.0 - k * 0.45 * exp(-r * 1.7);
  d.x /= uAspect;
  return uCenter + d;
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uAmount < 0.001) { outputColor = inputColor; return; }
  vec2 w = warpUv(uv, uAmount);
  vec2 dir = normalize(uv - uCenter + vec2(1e-5));
  float ca = uAmount * 0.005 * smoothstep(0.12, 0.55, length((uv - uCenter) * vec2(uAspect, 1.0)));
  outputColor = vec4(
    texture2D(inputBuffer, w + dir * ca).r,
    texture2D(inputBuffer, w).g,
    texture2D(inputBuffer, w - dir * ca).b,
    inputColor.a);
}`;

class WarpEffect extends Effect {
  constructor() {
    super('IntroWarp', 'uniform float uAspect;\n' + WARP_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['uAmount', new THREE.Uniform(0)],
        ['uCenter', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['uAspect', new THREE.Uniform(1.777)],
      ]),
    });
  }
  set amount(v) { this.uniforms.get('uAmount').value = v; }
  set aspect(v) { this.uniforms.get('uAspect').value = v; }
  setCenter(x, y) { this.uniforms.get('uCenter').value.set(x, y); }
}

const CSS = `
#introui{position:fixed;inset:0;z-index:120;font-family:Georgia,'Palatino Linotype',serif;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:16px;padding-bottom:6vh;background:transparent}
/* The call to action has to be unmissable — it is the only instruction on the page. Gold on a soft
   dark plate, wide tracking, breathing, with a rule either side so it reads as a title-screen prompt
   rather than a caption. */
#introui .cta{margin:0 0 2vh;font-size:clamp(19px,2.35vw,34px);letter-spacing:.5em;text-indent:.5em;
  font-variant:small-caps;color:#f7eed6;padding:.62em 1.5em;border-radius:2px;
  background:linear-gradient(90deg,rgba(9,6,20,0),rgba(9,6,20,.72) 18%,rgba(9,6,20,.72) 82%,rgba(9,6,20,0));
  text-shadow:0 0 26px rgba(211,165,72,.85),0 0 6px rgba(211,165,72,.6),0 2px 10px #000;
  opacity:0;transition:opacity 1s ease;animation:introPulse 2.4s ease-in-out infinite}
#introui .cta::before,#introui .cta::after{content:'';position:absolute;top:50%;width:clamp(40px,7vw,120px);height:1px;
  background:linear-gradient(90deg,rgba(211,165,72,0),rgba(211,165,72,.9))}
#introui .cta::before{right:calc(100% + 10px)}
#introui .cta::after{left:calc(100% + 10px);transform:scaleX(-1)}
#introui.armed .cta{opacity:1}
@keyframes introPulse{0%,100%{filter:brightness(.8)}50%{filter:brightness(1.35)}}
#introflash{position:fixed;inset:0;z-index:130;pointer-events:none;opacity:0;transition:opacity .16s ease-in;
  background:radial-gradient(58% 58% at 50% 50%,#efe9ff 0%,#b9a2ff 34%,#6b4fd0 62%,#160f30 100%)}
#introflash.on{opacity:1}
#introflash.off{opacity:0;transition:opacity .7s cubic-bezier(.2,.7,.3,1)}`;

export class Intro {
  /** `host` is a minimal boot context — { canvas, renderer, seed, auto, params } — NOT the Game. The
   *  Game's module graph is the entire game; the intro must be able to render before it exists.
   *  main.js calls attach(game) once it has been downloaded and constructed. */
  constructor(host) {
    this.game = host;
    this.active = false;
    this.done = false;
    this._t = 0;
    this._last = 0;
    this._progress = 0;
    this._pShown = 0;                    // eased follower — what the bar actually draws
    this._label = 'GATHERING AETHER';
    this._live = false;
    this._raf = 0;
    this._resolve = null;
    this.finished = new Promise((r) => { this._resolve = r; });
    // resolves the moment the room is actually on screen — main.js gates the world build on this
    this.firstFrame = new Promise((r) => { this._resolveFirst = r; });
    // The intro renders in a worker (see intro/introWorker.js) so the game's world build cannot stall it.
    // A worker has no document and no window.innerWidth, so both are treated as optional here and the
    // main-thread controller feeds size/input in. Everything still runs unchanged with a DOM present.
    this._dom = typeof document !== 'undefined' && !!document.body;
    this.w = host?.size?.w ?? (typeof innerWidth !== 'undefined' ? innerWidth : 1280);
    this.h = host?.size?.h ?? (typeof innerHeight !== 'undefined' ? innerHeight : 720);
  }

  /** hand over the real Game once its chunk has loaded; everything after arm() needs it */
  attach(game) {
    this.game = game;
    if (this._pendingReady) { this._pendingReady = false; }
    return this;
  }

  // ---------------------------------------------------------------- boot
  async init() {
    const T0 = performance.now(); this._boot = []; const mark = (k) => this._boot.push([k, Math.round(performance.now() - T0)]);
    this._mark = mark;
    const g = this.game;
    if (this._dom) {
      const style = document.createElement('style'); style.id = 'introcss'; style.textContent = CSS;
      document.head.appendChild(style); this._style = style;
      // the game's own HUD is built during init and would sit on top of the room — hide it until we're done
      this._ui = document.getElementById('ui');
      if (this._ui) this._ui.style.display = 'none';
    }

    this._buildDom();                                  // BEFORE the awaits below: the bar has to exist at t=0
    mark('dom');
    this.stage = await buildStage({ seed: g.seed, guyBuf: g.guyBuf || null });
    mark('stage');
    this._makeScreenCanvas();
    this.stage.setScreenTexture(this.screenTex);
    this.stage.setScreenUITexture(this.uiTex);

    const r = g.renderer;
    this._prevShadow = r.shadowMap.enabled;
    // (No render-scale trick here. Dropping the loading screen to 0.8x did save the world build some
    // GPU, but the loading screen is the thing on show for 20 seconds and the softness was visible.)
    r.shadowMap.enabled = true;
    this._prevClip = r.localClippingEnabled;
    r.localClippingEnabled = true;          // stage.js clips the body against the panel during the dive
    // NoToneMapping and it STAYS that way: PostFX's composer tone-maps, so this is exactly the state the
    // game wants after handover. Do not "restore" a captured value here — the value captured at boot is
    // the renderer default from Renderer.js, and restoring it double-tone-maps the entire session.
    r.toneMapping = THREE.NoToneMapping;

    this.warp = new WarpEffect();

    this._onResize = () => this.resize();
    if (this._dom) window.addEventListener('resize', this._onResize);
    this.resize();

    this.active = true;
    this._last = performance.now();
    const loop = () => { this._raf = requestAnimationFrame(loop); this._frame(); };
    loop();
    return this;
  }

  /** Build the effect chain AFTER the room is already on screen.
   *  Bloom (mipmap blur), SMAA, tone mapping, grain and the warp are a dozen shader programs, and
   *  compiling them in the same frame as the room's own materials made the first frame a ~6.8 s stall —
   *  a blank page while the browser had every asset it needed. The first frames render plain (ACES on
   *  the renderer, no bloom/AA); the composer takes over as soon as it is ready, a beat later. */
  _buildComposer() {
    if (this.composer || !this.active || !this.stage) return;
    const r = this.game.renderer;
    const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
    grain.blendMode.opacity.value = 0.045;                                        // film grain, barely there
    const composer = new EffectComposer(r, { frameBufferType: THREE.HalfFloatType });
    composer.autoRenderToScreen = true;
    composer.addPass(new RenderPass(this.stage.scene, this.stage.camera));
    composer.addPass(new EffectPass(this.stage.camera,
      new BloomEffect({ luminanceThreshold: 0.68, luminanceSmoothing: 0.32, intensity: 1.25, mipmapBlur: true, radius: 0.75 }),
      this.warp,
      new VignetteEffect({ offset: 0.58, darkness: 0.16 }),
      new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
      grain,
      new SMAAEffect(),
    ));
    composer.setSize(this.w, this.h);
    this.composer = composer;
    r.toneMapping = THREE.NoToneMapping;              // the composer tone-maps from here on
    this._mark?.('composer');
    // and only now the full light rig — a third separate compile, with the room already on screen
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.stage?.setLightsFull(true);
      this._mark?.('lights');
      if (this._boot) console.log('[intro] boot ms:', JSON.stringify(Object.fromEntries(this._boot)));
    }));
  }

  /** the click layer + the screen-space load bar. Built first, before any await. */
  _buildDom() {
    if (!this._dom) return;              // the controller owns the prompt/flash on the main thread
    const ui = document.createElement('div'); ui.id = 'introui';
    // No screen-space load bar: the monitor in the scene carries it diegetically, and two bars for one
    // download is the kind of seam a real title screen never shows. The tab title still reports progress.
    ui.innerHTML = '<p class="cta">click or press any key</p>';
    document.body.appendChild(ui); this._clickUI = ui;
    // The overlay is pointer-events:none and the listener lives on window, so the canvas's OWN
    // mousedown -> Input.lock path (src/core/Input.js) still runs on every click. A full-screen div that
    // swallowed the click is how the gate's "re-acquire after exit" leg started failing.
    this._onWinClick = () => this._onClick();
    window.addEventListener('click', this._onWinClick);
    // "click anywhere" means any key too — a keydown is a valid user gesture for pointer lock, and a
    // player who reaches for the keyboard first should not be met with nothing happening.
    this._onWinKey = (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (['Tab', 'Escape', 'F5', 'F11', 'F12'].includes(e.key)) return;   // leave the browser's own keys alone
      this._onClick();
    };
    window.addEventListener('keydown', this._onWinKey);
    const flash = document.createElement('div'); flash.id = 'introflash';
    document.body.appendChild(flash); this._flash = flash;
    this.setProgress(this._progress, this._label);
  }

  resize(w = this.w, h = this.h) {
    this.w = w; this.h = h;
    this.game.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    if (this.stage) { this.stage.camera.aspect = w / h; this.stage.camera.updateProjectionMatrix(); }
    if (this.warp) this.warp.aspect = w / h;
  }

  // ---------------------------------------------------------------- the monitor's own screen
  // Two layers, exactly like a real game's title screen:
  //   backdrop  an in-game vista (before the world exists: a painted menu background)
  //   ui        the title treatment, the load bar and the prompt, with alpha, over the top
  _makeScreenCanvas() {
    const mk = (w, h) => makeCanvas(w, h);
    this.bdCv = mk(1024, 576); this.bdCtx = this.bdCv.getContext('2d');
    this.screenTex = new THREE.CanvasTexture(this.bdCv);
    this.screenTex.colorSpace = THREE.SRGBColorSpace; this.screenTex.anisotropy = 8;
    this._drawBackdrop();

    this.uiCv = mk(1024, 576); this.uiCtx = this.uiCv.getContext('2d');
    this.uiTex = new THREE.CanvasTexture(this.uiCv);
    this.uiTex.colorSpace = THREE.SRGBColorSpace; this.uiTex.anisotropy = 8;
    this._drawScreen(0);
  }

  /** the menu background that stands in until the real world can be rendered behind the title */
  _drawBackdrop() {
    const x = this.bdCtx, W = 1024, H = 576;
    const sky = x.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#241a4a'); sky.addColorStop(0.42, '#3b2f6d'); sky.addColorStop(0.62, '#6a4f7e'); sky.addColorStop(1, '#1a1130');
    x.fillStyle = sky; x.fillRect(0, 0, W, H);
    const haze = x.createRadialGradient(W * 0.5, H * 0.62, 10, W * 0.5, H * 0.62, W * 0.5);
    haze.addColorStop(0, 'rgba(163,132,255,.35)'); haze.addColorStop(1, 'rgba(163,132,255,0)');
    x.fillStyle = haze; x.fillRect(0, 0, W, H);
    x.fillStyle = '#221a3f'; x.beginPath(); x.moveTo(0, H * 0.66);
    for (let i = 0; i <= 12; i++) x.lineTo(i * W / 12, H * (0.66 - 0.09 * Math.abs(Math.sin(i * 1.7))));
    x.lineTo(W, H); x.lineTo(0, H); x.fill();
    x.fillStyle = '#140f26'; x.beginPath(); x.moveTo(0, H * 0.80);
    for (let i = 0; i <= 8; i++) x.lineTo(i * W / 8, H * (0.80 - 0.05 * Math.abs(Math.cos(i * 2.1))));
    x.lineTo(W, H); x.lineTo(0, H); x.fill();
    this.screenTex.needsUpdate = true;
  }

  /** THE GAME'S START SCREEN — wordmark, aether sigil, load bar, prompt. Alpha, over the backdrop. */
  _drawScreen(t) {
    const x = this.uiCtx, W = 1024, H = 576;
    x.clearRect(0, 0, W, H);
    x.save();
    x.textAlign = 'center'; x.textBaseline = 'middle';

    // scrims: the title and the bar have to stay readable over a bright meadow
    const top = x.createLinearGradient(0, 0, 0, H * 0.60);
    top.addColorStop(0, 'rgba(8,5,18,.92)'); top.addColorStop(0.62, 'rgba(8,5,18,.55)'); top.addColorStop(1, 'rgba(8,5,18,0)');
    x.fillStyle = top; x.fillRect(0, 0, W, H * 0.60);
    const bot = x.createLinearGradient(0, H, 0, H * 0.34);
    bot.addColorStop(0, 'rgba(8,5,18,.94)'); bot.addColorStop(0.45, 'rgba(8,5,18,.80)'); bot.addColorStop(1, 'rgba(8,5,18,0)');
    x.fillStyle = bot; x.fillRect(0, H * 0.34, W, H * 0.66);
    // and a soft pool right behind the wordmark — a bright meadow otherwise eats the gold
    const pool = x.createRadialGradient(W / 2, H * 0.26, 20, W / 2, H * 0.26, W * 0.55);
    pool.addColorStop(0, 'rgba(8,5,18,.80)'); pool.addColorStop(0.55, 'rgba(8,5,18,.5)'); pool.addColorStop(1, 'rgba(8,5,18,0)');
    x.fillStyle = pool; x.fillRect(0, 0, W, H * 0.66);

    // aether sigil above the wordmark
    x.save();
    x.translate(W / 2, H * 0.115 + Math.sin(t * 1.9) * 3);
    for (const [size, col, dir] of [[30, '#7c5bd6', 1], [21, '#d3a548', -1]]) {
      x.save(); x.rotate(t * 0.9 * dir + Math.PI / 4);
      x.strokeStyle = col; x.lineWidth = 2.2; x.shadowColor = col; x.shadowBlur = 14;
      x.strokeRect(-size / 2, -size / 2, size, size);
      x.restore();
    }
    const gg = x.createRadialGradient(0, 0, 0, 0, 0, 14);
    gg.addColorStop(0, 'rgba(214,196,255,.95)'); gg.addColorStop(0.55, 'rgba(124,91,214,.5)'); gg.addColorStop(1, 'rgba(124,91,214,0)');
    x.fillStyle = gg; x.beginPath(); x.arc(0, 0, 14, 0, 7); x.fill();
    x.restore();

    // wordmark with a slow gold sheen
    x.font = '400 82px Georgia, serif';
    const sweep = (t * 0.3) % 1;
    const grad = x.createLinearGradient(W / 2 - 250, 0, W / 2 + 250, 0);
    grad.addColorStop(0, '#8a6119');
    grad.addColorStop(Math.max(0.001, sweep - 0.16), '#d3a548');
    grad.addColorStop(sweep, '#fdf3cd');
    grad.addColorStop(Math.min(0.999, sweep + 0.16), '#d3a548');
    grad.addColorStop(1, '#8a6119');
    x.fillStyle = grad; x.letterSpacing = '28px';
    x.shadowColor = 'rgba(0,0,0,.75)'; x.shadowBlur = 18;
    x.fillText('CADLE', W / 2 + 14, H * 0.265);
    x.shadowBlur = 0; x.letterSpacing = '0px';

    // rule + subtitle
    const rw = 330;
    const rule = x.createLinearGradient(W / 2 - rw / 2, 0, W / 2 + rw / 2, 0);
    rule.addColorStop(0, 'rgba(211,165,72,0)'); rule.addColorStop(0.5, 'rgba(211,165,72,.85)'); rule.addColorStop(1, 'rgba(211,165,72,0)');
    x.fillStyle = rule; x.fillRect(W / 2 - rw / 2, H * 0.325, rw, 1.6);
    x.font = '400 30px Georgia, serif'; x.letterSpacing = '15px';
    x.fillStyle = 'rgba(232,220,192,.86)';
    x.shadowColor = 'rgba(0,0,0,.8)'; x.shadowBlur = 12;
    x.fillText('THE SUNDERED VALE', W / 2 + 7, H * 0.385);
    x.shadowBlur = 0;
    x.letterSpacing = '0px';

    // load bar / ready prompt
    const p = Math.max(0, Math.min(1, this._pShown ?? this._progress));
    const bw = 820, bh = 17, bx = (W - bw) / 2, by = H * 0.715;
    if (!this._armed) {
      x.font = '400 29px Georgia, serif'; x.letterSpacing = '9px';
      x.textAlign = 'left'; x.fillStyle = 'rgba(244,234,208,.92)';
      x.fillText(this._label, bx + 2, by - 30);
      x.textAlign = 'right'; x.fillStyle = '#e8b95a';
      x.fillText(Math.round(p * 100) + '%', bx + bw, by - 30);
      x.letterSpacing = '0px';

      // an empty track has to read as a track: a visible stroke, so 0% is still obviously a load bar
      x.fillStyle = 'rgba(211,165,72,.20)'; x.fillRect(bx, by, bw, bh);
      x.strokeStyle = 'rgba(211,165,72,.72)'; x.lineWidth = 2;
      x.strokeRect(bx - 3, by - 3, bw + 6, bh + 6);
      if (p > 0) {
        const fg = x.createLinearGradient(bx, 0, bx + bw * p, 0);
        fg.addColorStop(0, '#8a6119'); fg.addColorStop(0.72, '#d3a548'); fg.addColorStop(1, '#fdf3cd');
        x.fillStyle = fg; x.shadowColor = 'rgba(253,243,205,.85)'; x.shadowBlur = 16;
        x.fillRect(bx, by, bw * p, bh);
        x.shadowBlur = 0;
        // leading edge highlight so the bar is obviously ALIVE, not a static graphic
        x.fillStyle = 'rgba(255,250,230,.9)';
        x.fillRect(bx + bw * p - 3, by - 4, 4, bh + 8);
      }
    } else {
      // one small tracked line, the way a real title screen asks you to start — the wordmark owns the frame
      const pulse = 0.55 + 0.45 * Math.sin(t * 3.0);
      x.font = '400 22px Georgia, serif'; x.letterSpacing = '13px'; x.textAlign = 'center';
      x.fillStyle = 'rgba(247,238,214,' + (0.5 + 0.45 * pulse).toFixed(3) + ')';
      x.shadowColor = 'rgba(211,165,72,.85)'; x.shadowBlur = 10 + 14 * pulse;
      x.fillText('PRESS ANY KEY TO ENTER', W / 2 + 7, by + 14);
      x.shadowBlur = 0; x.letterSpacing = '0px';
    }

    // build tag, bottom-right — the kind of detail a real title screen has
    x.font = '400 13px Georgia, serif'; x.textAlign = 'right';
    x.fillStyle = 'rgba(226,213,183,.28)';
    x.fillText('v0.1.0', W - 26, H - 22);

    // it has to read as a SCREEN, not a poster: scanlines + vignette
    x.globalAlpha = 0.05; x.fillStyle = '#000';
    for (let y = 12; y < H - 12; y += 3) x.fillRect(12, y, W - 24, 1);
    x.globalAlpha = 1;
    const vg = x.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, H * 0.86);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.45)');
    x.fillStyle = vg; x.fillRect(0, 0, W, H);
    x.restore();
    // NOTE: do NOT clear a transparent border here. The layer darkens the panel, so a transparent rim
    // reads as a bright frame instead. The dashed "white edges" came from the SCANLINES reaching the
    // canvas edge — the rim alternated opaque row / transparent row and the bright game showed through
    // between them. The scanlines are inset by 12 px above; that is the whole fix.
    this.uiTex.needsUpdate = true;
  }

  /** worker path: a frame of the REAL game, shipped from the main thread, goes onto his monitor */
  setMonitorFrame(bitmap) {
    if (!this.stage || !bitmap) { bitmap?.close?.(); return; }
    const prev = this._monTex;
    const t = new THREE.Texture(bitmap);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;                    // the bitmap is shipped pre-flipped (imageOrientation), see IntroHost
    t.needsUpdate = true;
    this._monTex = t;
    this.stage.setScreenTexture(t);
    this._live = true;
    if (prev) { try { prev.image?.close?.(); prev.dispose(); } catch {} }
  }

  setProgress(p, label) {
    this._progress = p;
    if (label) this._label = label;
    // the tab title is the one loading cue a visitor sees even when the page is in a background tab
    if (!this._armed && this._dom) document.title = `CADLE — loading ${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
  }

  // ---------------------------------------------------------------- live game on the monitor
  /** called when game.ready resolves: swap the monitor to the real game and invite the click */
  arm() {
    if (!this.active || this._armed) return;
    try { this._arm(); }
    catch (e) { console.error('[intro] arm failed, skipping to the game:', e); this.skip(); }
  }

  _arm() {
    const g = this.game;
    this._armed = true;
    this._progress = 1; this._pShown = 1; this._label = 'THE VALE AWAITS';
    if (this._dom) document.title = 'CADLE';
    this._drawScreen(this._t);
    if (!this.game.stepInto) {          // worker: no game in this context, frames arrive by message
      this._live = false;
      this.stage?.setScreenBoost?.(1);
      this.onArmed?.();
      return;
    }
    try {
      // 1536x864 with full anisotropy: the panel is 1.4x bigger than it was and sits at an angle, so a
      // 1024-wide target sampled anisotropy-1 read as a blurry screen.
      this.gameRT = new THREE.WebGLRenderTarget(1536, 864, {
        type: THREE.UnsignedByteType, depthBuffer: true, samples: 0,
      });
      this.gameRT.texture.colorSpace = THREE.SRGBColorSpace;
      this.gameRT.texture.minFilter = THREE.LinearFilter;
      this.gameRT.texture.magFilter = THREE.LinearFilter;
      this.gameRT.texture.anisotropy = g.renderer.capabilities.getMaxAnisotropy();
      this.gameRT.texture.generateMipmaps = false;
      // A menu backdrop is not gameplay: 95 deg crammed into a small target throws away detail and reads
      // as a fisheye. Same position and orientation as the game camera, narrower lens.
      this._menuCam = new THREE.PerspectiveCamera(58, 16 / 9, 0.05, 4000);
      this._menuCam.rotation.order = 'YXZ';
      // step only what makes the world LOOK alive on his monitor: sky, lighting, terrain LOD, grass wind,
      // water, vfx, and the player (whose update places the camera). Not rpg/audio/hud/enemies/combat —
      // the opening quest and its voice lines must fire when the player is actually in the game.
      this._liveSystems = [g.sky, g.lighting, g.terrain, g.world, g.player, g.vfx].filter(Boolean);
      // draw one frame into it BEFORE the monitor starts showing it: an unrendered target is black, and
      // the panel would blink to black for a frame at the exact moment the player is asked to press a key
      this._menuCam.position.copy(g.camera.position); this._menuCam.quaternion.copy(g.camera.quaternion);
      this.game.stepInto(1 / 60, this.gameRT, this._liveSystems, this._menuCam);
      this._live = true;
      // 0.92: graded down just enough that the title reads over it. At 0.5 the meadow was mud and the
      // start screen stopped looking like a game worth clicking into.
      this.stage.setScreenTexture(this.gameRT.texture, 0.92);
    } catch (e) {
      console.warn('[intro] live monitor unavailable, keeping the title card:', e?.message);
      this._live = false;
    }
    this._clickUI?.classList?.add?.('armed');
    if (this._wantsPlay) { this._whoosh(); this.play(); return; }   // they already clicked; go now
    // harness: nobody is there to click, so play by itself shortly after arming (hold() cancels it)
    if (this.game.auto && this.game.params.get('introhold') !== '1') this._autoAt = performance.now() + 4000;
  }

  /** harness: stop the auto-play so the room can be inspected for as long as the critic wants */
  hold() { this._autoAt = 0; return true; }

  // ---------------------------------------------------------------- frame
  _frame() {
    if (!this.active) return;
    const now = performance.now();
    const dt = Math.min((now - this._last) / 1000, 0.05);
    this._last = now; this._t += dt;

    // The monitor's live backdrop costs a full world update + a 1024x576 render every frame. Freeze it
    // for the dive: the screen is a portal by then, and the two seconds of the transition are the one
    // moment that must not drop frames.
    this._n = (this._n | 0) + 1;
    // 30 Hz for the monitor's backdrop: it is a slow ambient vista at ~550 px across, and the other half
    // of those milliseconds belongs to the world build happening on the same thread.
    if (this._live && this.gameRT && !this._trans && (this._n & 1)) {
      try {
        if (this._menuCam) {
          this._menuCam.position.copy(this.game.camera.position);
          this._menuCam.quaternion.copy(this.game.camera.quaternion);
        }
        this.game.stepInto(dt, this.gameRT, this._liveSystems, this._menuCam || undefined);
      } catch (e) { this._live = false; console.warn('[intro] live step failed:', e?.message); }
    }
    // 8 fps for the title layer, and only when something actually changed: a full 1024x576 canvas repaint
    // plus a 2.4 MB texture upload is real money while the world is still building.
    // Ease the DRAWN value toward the real one. Progress arrives in lumps — one asset finishing can jump
    // the bar several percent — and a bar that teleports and then sits still reads as a stall even when
    // nothing is wrong. Chasing it at ~6/s covers a lump in a few frames and keeps the line moving.
    // Time-based, not per-frame, so a long stall is caught up in one step rather than crawling afterwards.
    this._pShown = this._pShown ?? 0;
    if (this._pShown < this._progress) this._pShown = Math.min(this._progress, this._pShown + Math.max(dt * 0.6, dt * (this._progress - this._pShown) * 6));
    else this._pShown = this._progress;
    const chasing = Math.abs(this._progress - this._pShown) > 0.0015;
    if (!this._trans && this._t - (this._lastDraw ?? -1) > 1 / 8
        && (this._armed || chasing || Math.abs(this._pShown - (this._drawnAt ?? -1)) > 0.004 || this._t - (this._lastDraw ?? -1) > 0.5)) {
      this._lastDraw = this._t; this._drawnAt = this._pShown;
      this._drawScreen(this._t);
    }

    if (this._autoAt && !this._trans && now > this._autoAt) this.play();
    if (this._trans) this._stepTransition(dt);
    if (!this.active) return;                          // the handover happened mid-frame; the game owns the canvas now
    this.stage.update(this._t, dt);
    // Lighting.js sets renderer.shadowMap.autoUpdate = false (it drives CSM updates itself). Sharing the
    // renderer means the intro's own moon/monitor shadow maps then never render and every surface comes
    // back fully shadowed — the room goes black the moment Lighting.init() runs. Ask for one update per
    // intro frame; it is two small maps of a one-room scene.
    // Every 4th frame is plenty: nothing in this room moves but a 6 mm breathe. Always during the dive,
    // where the body is travelling. (Lighting.update sets its own needsUpdate for the game's CSM.)
    if (this._trans || (this._n & 3) === 0) this.game.renderer.shadowMap.needsUpdate = true;
    if (this.composer) {
      this.composer.render(dt);
    } else {
      // pre-composer frames: plain render, renderer-side ACES so the grade is roughly right
      const r = this.game.renderer;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.render(this.stage.scene, this.stage.camera);
    }

    if (!this._firstFrame) {                            // the boot splash can go: we have a picture
      this._firstFrame = true;
      const sp = this._dom ? document.getElementById('splash') : null;
      // snap it off rather than the stock .8 s fade: the splash's own CADLE lettering sits right over the
      // monitor's, and the two overlapping wordmarks look like a mistake for the whole crossfade
      // remove it outright rather than fading: for the whole fade the splash's own CADLE lettering sat
      // ghosted over the monitor's, which reads as a rendering bug
      if (sp) sp.remove();
      this._mark?.('firstFrame');
      this._resolveFirst?.();
      // two frames later, so this paint is on screen before the compile stall
      requestAnimationFrame(() => requestAnimationFrame(() => this._buildComposer()));
    }
  }

  // ---------------------------------------------------------------- the transition
  _onClick() {
    const g = this.game;
    // ALWAYS take the lock on a click, in every state including mid-transition. Returning early here is
    // how "pointer lock does not re-acquire after exit" came back: the player pressed Esc during the
    // intro, clicked to resume, and nothing asked for the lock.
    // g.input only exists once the Game chunk has landed; before that the click just records intent and
    // the canvas's own mousedown -> Input.lock picks up the next one.
    if (this._dom && !g.auto && !document.pointerLockElement && g.input) g.input.constructor.lock(g.canvas);
    if (this._trans) return;
    if (!this._armed) {                                 // clicked while the world is still building
      this._wantsPlay = true;
      const cta = this._clickUI?.querySelector('.cta');
      if (cta) cta.textContent = 'the vale is waking';
      return;
    }
    this._whoosh();
    this.play();
  }

  /** run the suck-in. Resolves (and resolves `finished`) once the game owns the canvas. */
  play() {
    if (this._trans) return this.finished;
    this._trans = { t: 0, t0: performance.now() };
    this._clickUI?.remove(); this._clickUI = null;
    const cam = this.stage.camera;
    this.stage.setCameraFree(true);
    this._cam0 = { pos: cam.position.clone(), quat: cam.quaternion.clone() };
    // where the camera is looking right now — the dive blends this target toward the monitor, so the
    // monitor is always centred on the way in (slerping to a fixed quaternion swings past it instead)
    this._look0 = cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(2.2).add(cam.position);
    this._lookT = new THREE.Vector3();
    const fit = this.stage.fitCameraToScreen(this.w / this.h);
    this._cam1 = { pos: fit.pos };
    // where the monitor is on screen right now — the warp and the pull centre on it
    const s = SCREEN.pos.clone().project(cam);
    this.warp.setCenter(s.x * 0.5 + 0.5, s.y * 0.5 + 0.5);
    return this.finished;
  }

  _stepTransition(dt) {
    const T = this._trans;
    // wall clock, not accumulated dt: the world build (impostor bakes) can still be hogging the thread,
    // and a dt-driven timeline turns the 2 s dive into 5 s of slow motion when frames get long
    if (!T.frozen) T.t = (performance.now() - T.t0) / 1000;
    const t = T.t;
    const ease = (a, b, x) => { x = Math.max(0, Math.min(1, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
    const cam = this.stage.camera;

    // Beats. The point of the whole shot is watching HIM get pulled in, so the camera holds while that
    // happens and only follows once he is gone. An early camera dive hides the one thing worth seeing.
    //   0.00-0.30  he notices; camera eases back a touch (anticipation)
    //   0.08-1.23  the pull: he is dragged out of the chair and clipped through the panel plane
    //   0.40-1.45  the camera follows him in, accelerating
    //   0.60-1.50  the warp winds up; the title layer fades so the portal is the live world, not a scrim
    //   1.40       flash          1.58  handover
    // Nearly linear, not smoothstep: smoothstep races through the middle of the curve, which is exactly
    // the band (k 0.35-0.8) where he is visibly being dragged out of the chair. Front-load it slightly so
    // the flight is the longest beat instead of the shortest.
    const kx = Math.max(0, Math.min(1, (t - 0.08) / 1.15));
    this.stage.setSuck(Math.pow(kx, 0.85));

    const push = Math.pow(ease(0.40, 1.45, t), 1.30);
    cam.position.lerpVectors(this._cam0.pos, this._cam1.pos, Math.min(push * 1.04, 1));
    // anticipation: a small drift back before the plunge, plus a rising handheld shake
    const back = 0.055 * Math.sin(Math.min(t / 0.42, 1) * Math.PI) * (1 - ease(0.5, 0.8, t));
    const shake = 0.006 * ease(0.1, 1.0, t) * (1 - ease(1.4, 1.8, t));
    cam.position.z += back;
    cam.position.x += Math.sin(t * 41) * shake;
    cam.position.y += Math.sin(t * 53 + 1.3) * shake;
    this._lookT.lerpVectors(this._look0, SCREEN.pos, ease(0.10, 0.90, t));
    cam.lookAt(this._lookT);

    this.stage.setScreenBoost(1 + 1.6 * Math.pow(ease(0.55, 1.45, t), 1.5));   // capped in stage.setScreenBoost too
    // ungrade the backdrop and dissolve the title layer as the screen becomes a doorway
    this.stage.setScreenGrade(0.92 + 0.08 * ease(0.5, 1.2, t), 1 - ease(0.40, 0.95, t));
    this.warp.amount = 1.2 * Math.pow(ease(0.60, 1.50, t), 1.8);

    if (t > 1.40 && !T.flashed) { T.flashed = true; if (this._flash) this._flash.classList.add('on'); else this.onFlash?.(); }
    if (t > 1.58 && !T.handed && !T.frozen) { T.handed = true; this._handover(); }
  }

  /** debug/critique hook: jump the transition to an absolute time and hold it there (no handover) */
  seek(t) {
    if (!this._trans) {
      this.play();
      this._trans.frozen = true;
    }
    this._trans.frozen = true;
    this._trans.t = t;
    this._stepTransition(0);
    return t;
  }

  /** the game takes the canvas behind the flash, then the flash burns off */
  _handover() {
    const g = this.game;
    this.active = false;
    cancelAnimationFrame(this._raf);
    this._teardownGL();
    if (!this._dom) {                   // worker: the controller swaps the canvases and starts the game
      this.done = true;
      this.onHandover?.();
      this._resolve?.(true);
      return;
    }
    // ease the HUD in rather than slamming four UI elements onto the frame the instant the flash lifts
    if (this._ui) {
      this._ui.style.display = '';
      this._ui.style.opacity = '0';
      this._ui.style.transition = 'opacity .9s ease';
      setTimeout(() => { if (this._ui) { this._ui.style.opacity = '1'; setTimeout(() => { this._ui.style.transition = ''; }, 1000); } }, 260);
    }
    // If the player took the lock during the intro and then dropped it (Esc), the HUD has already flipped
    // to "started + paused" and its pause menu is sitting over the canvas — which, once we hand the canvas
    // back, swallows the next click and the mouse can never be recaptured. Hand over into the same state
    // the game boots into instead: running, unpaused, next click on the canvas takes the lock.
    if (!document.pointerLockElement) {
      g.paused = false;
      try { g.hud?.settings?.hide?.(); } catch {}
    }
    try { g.start(); } catch (e) { console.error(e); }
    // two frames of game on the canvas before the flash lifts, so it never uncovers a black screen
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._flash?.classList.remove('on');
      this._flash?.classList.add('off');
      setTimeout(() => { this._flash?.remove(); this._flash = null; }, 900);
    }));
    this.done = true;
    this._resolve?.(true);
  }

  /** abandon the intro immediately (failure path / ?auto=1 / skip) and let the game have the canvas */
  skip() {
    if (this.done) return;
    this.active = false;
    cancelAnimationFrame(this._raf);
    this._teardownGL();
    this._clickUI?.remove?.(); this._clickUI = null;
    this._flash?.remove?.(); this._flash = null;
    if (this._ui) this._ui.style.display = '';
    this.onSkip?.();
    this.done = true;
    this._resolve?.(false);
    this._resolveFirst?.();
  }

  _teardownGL() {
    if (this._dom) {
      window.removeEventListener('resize', this._onResize);
      if (this._onWinClick) window.removeEventListener('click', this._onWinClick);
      if (this._onWinKey) window.removeEventListener('keydown', this._onWinKey);
    }
    try { this.composer?.dispose(); } catch {}
    try { this.stage?.dispose(); } catch {}
    try { this.gameRT?.dispose(); } catch {}
    try { this.screenTex?.dispose(); this.uiTex?.dispose(); } catch {}
    this._style?.remove?.();
    const r = this.game.renderer;
    r.shadowMap.enabled = this._prevShadow ?? true;
    r.localClippingEnabled = this._prevClip ?? false;
    r.setRenderTarget(null);
    r.info.reset();
    this.composer = null; this.stage = null; this.gameRT = null;
  }

  /** a short synthesized whoosh on the click — the transition needs a sound and Audio isn't up yet */
  _whoosh() {
    if (!this._dom) { this.onWhoosh?.(); return; }     // controller plays it; no AudioContext in a worker
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      const t0 = ac.currentTime;
      // noise sweep
      const n = ac.createBufferSource();
      const buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
      n.buffer = buf;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(180, t0); bp.frequency.exponentialRampToValueAtTime(4200, t0 + 1.35);
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.34, t0 + 1.25);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.75);
      n.connect(bp).connect(ng).connect(ac.destination);
      n.start(t0); n.stop(t0 + 1.9);
      // rising aether tone underneath
      const o = ac.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(70, t0); o.frequency.exponentialRampToValueAtTime(660, t0 + 1.4);
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
      const og = ac.createGain();
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.16, t0 + 1.3);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.7);
      o.connect(lp).connect(og).connect(ac.destination);
      o.start(t0); o.stop(t0 + 1.8);
      setTimeout(() => ac.close().catch(() => {}), 2600);
    } catch {}
  }
}
