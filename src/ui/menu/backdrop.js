/**
 * Backdrop: the title screen's animated background.   (orchestrator)
 *
 * One WebGL2 context, one program, one full-screen triangle. **No three.js, no assets of its own.**
 * That is the whole point: this is the first thing on screen, so it has to be able to draw before the
 * engine has been downloaded — importing three here would put a 600 KB parse on the critical path (and a
 * second one in the worker, which has its own module graph).
 *
 * Three states, one shader, cross-faded:
 *   1. `still`  a vista captured from the real game (public/assets/ui/menu_vista.jpg, preloaded from
 *               index.html). Until it lands, a procedural sky in the same palette — never a black frame.
 *   2. `live`   once the world has actually been built, main.js ships frames of the REAL game across as
 *               ImageBitmaps and the painting comes alive. Same view as the still, so the swap reads as
 *               the picture starting to breathe rather than a cut.
 *   3. always   the animated layer on top: sun shafts, drifting aether motes, haze drift, parallax,
 *               grain and vignette. This is what makes a still image a title screen.
 *
 * Runs in a Web Worker on an OffscreenCanvas (see backdropWorker.js) whenever the browser allows it, so
 * the world build — seconds of blocking main-thread work — cannot stutter it. The class itself does not
 * care: give it a canvas or an OffscreenCanvas.
 *
 * COLOUR DISCIPLINE (CLAUDE.md decree): the motes and shafts are SATURATED and DIM, never bright and
 * white. There is no bloom pass here, but the same rule applies for the same reason — a small bright
 * additive element that clips reads as a washed-out blob instead of magic.
 */

const VERT = `#version 300 es
void main(){
  // full-screen triangle from gl_VertexID — no buffers, no VAO, nothing to bind
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uStill;
uniform sampler2D uLive;
uniform vec2  uRes;         // canvas size in device px
uniform vec2  uImg;         // aspect of the source image (w,h) for cover-fit
uniform float uTime;
uniform float uMix;         // 0 still .. 1 live
uniform float uHas;         // 0 = no image yet: draw the procedural sky instead
uniform vec2  uMouse;       // -1..1 parallax
uniform float uPush;        // 0..1 slow dolly-in once loading starts
uniform float uWarp;        // 0..1 the dive at hand-off
uniform float uCalm;        // 1 while idle, ->0 as the live game (which has its own vfx) takes over
uniform float uDim;         // global exposure, dips under the loading UI

// Where the light is in the vista. At the menu's hour that is not the sun — it is the waystone, so the
// shafts radiate out of the crystal. Move this if the still is ever re-shot from a different pose.
const vec2 SUN = vec2(0.600, 0.740);

// ---- cheap value noise -----------------------------------------------------------------------
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), f.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){ return 0.58 * vnoise(p) + 0.30 * vnoise(p * 2.07) + 0.12 * vnoise(p * 4.13); }

// ---- the stand-in sky, for the frames before the vista has decoded --------------------------
// Matched to the vista it stands in for: a violet night, a rose band on the mountain ring, an aether
// glow where the waystone is, and a dark field underneath. Never a black frame, and never a wrong one.
vec3 proceduralSky(vec2 uv){
  vec3 c = mix(vec3(0.055, 0.048, 0.115), vec3(0.145, 0.105, 0.255), pow(uv.y, 0.85));
  c = mix(c, vec3(0.42, 0.26, 0.35), pow(max(0.0, 1.0 - abs(uv.y - 0.66) * 4.2), 2.0));   // rose ridge band
  c += vec3(0.30, 0.24, 0.62) * pow(max(0.0, 1.0 - length((uv - SUN) * vec2(1.7, 1.0)) * 2.4), 3.0);
  float ridge = 0.545 + 0.055 * fbm(vec2(uv.x * 3.1 + 4.0, 0.5));
  c = mix(c, vec3(0.052, 0.075, 0.055), smoothstep(ridge + 0.012, ridge - 0.012, uv.y));   // the meadow
  return c;
}

// ---- the source picture, cover-fitted, with parallax + dolly --------------------------------
vec2 sourceUv(vec2 uv){
  float sa = uRes.x / uRes.y, ia = uImg.x / uImg.y;
  // COVER, and the direction matters: a screen WIDER than the picture keeps all of u and crops v; a
  // narrower one keeps all of v and crops u. Getting this backwards samples outside [0,1] and
  // CLAMP_TO_EDGE smears the border pixels across a third of the frame.
  vec2 f = sa > ia ? vec2(1.0, ia / sa) : vec2(sa / ia, 1.0);
  vec2 c = (uv - 0.5) * f;
  c *= 1.0 / (1.0 + 0.055 * uPush + 0.022);                     // a hair of headroom so parallax never samples off-image
  c += uMouse * vec2(0.011, 0.007) + vec2(0.0, -0.004 * uPush);
  c += vec2(sin(uTime * 0.045) * 0.0035, cos(uTime * 0.037) * 0.0026);   // never perfectly still
  return c + 0.5;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;

  // the dive: radial swirl + pinch toward the middle, only in the last second before hand-off
  if (uWarp > 0.001) {
    vec2 d = uv - 0.5; d.x *= uRes.x / uRes.y;
    float r = length(d);
    float a = uWarp * 2.0 * exp(-r * 2.4);
    d = mat2(cos(a), -sin(a), sin(a), cos(a)) * d;
    d *= 1.0 - uWarp * 0.42 * exp(-r * 1.6);
    d.x /= uRes.x / uRes.y;
    uv = d + 0.5;
  }

  vec2 su = sourceUv(uv);
  vec3 still = uHas > 0.5 ? texture(uStill, su).rgb : proceduralSky(uv);
  vec3 col = mix(still, texture(uLive, su).rgb, uMix);

  // ---- sun shafts. A 6-tap radial smear of whatever is already bright, which is what a god ray IS.
  // Costs 6 samples of the layer that is on screen; skipped entirely on the far side of the frame.
  float shaft = 0.0;
  vec2 toSun = SUN - uv;
  float sunFall = exp(-length(toSun * vec2(uRes.x / uRes.y, 1.0)) * 1.35);
  if (sunFall > 0.012) {
    vec2 step6 = toSun * 0.14;
    vec2 p = uv;
    for (int i = 0; i < 6; i++) {
      p += step6;
      vec3 s = uHas > 0.5 ? texture(uStill, sourceUv(p)).rgb : proceduralSky(p);
      s = mix(s, texture(uLive, sourceUv(p)).rgb, uMix);
      shaft += max(0.0, dot(s, vec3(0.30, 0.42, 0.22)) - 0.44);
    }
    // striated, drifting — a clean radial gradient reads as a lens flare, not as light through air
    float stri = 0.55 + 0.45 * fbm(vec2(atan(toSun.y, toSun.x) * 5.2, uTime * 0.06));
    shaft *= sunFall * stri * 0.085;
  }
  col += vec3(1.00, 0.80, 0.52) * shaft * (0.55 + 0.45 * uCalm);

  // ---- drifting aether motes: 3 parallax layers of a hashed grid. Saturated violet-gold, DIM.
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  float motes = 0.0;
  for (int L = 0; L < 3; L++) {
    float fl = float(L);
    float sc = 9.0 + fl * 7.0;
    vec2 q = (uv * asp + uMouse * (0.006 + 0.010 * fl)) * sc;
    q.y -= uTime * (0.055 + 0.045 * fl);              // they rise
    q.x += sin(uTime * 0.13 + fl * 2.1 + q.y * 0.4) * 0.16;
    vec2 gi = floor(q), gf = fract(q) - 0.5;
    float rnd = h21(gi + fl * 37.0);
    if (rnd > 0.90) {                                  // ~10% of cells carry a mote
      float tw = 0.55 + 0.45 * sin(uTime * (1.1 + rnd * 2.0) + rnd * 30.0);
      motes += smoothstep(0.16, 0.0, length(gf)) * tw * (0.30 - 0.07 * fl);
    }
  }
  col += mix(vec3(0.42, 0.33, 0.95), vec3(0.95, 0.74, 0.34), 0.35) * motes * 0.55 * uCalm;

  // ---- haze drift across the lower third: the air moves even when the picture cannot
  float band = smoothstep(0.62, 0.18, uv.y) * smoothstep(0.02, 0.20, uv.y);
  float haze = fbm(vec2(uv.x * 2.6 - uTime * 0.014, uv.y * 4.0 + uTime * 0.008));
  col = mix(col, col * vec3(1.06, 1.00, 1.10) + vec3(0.055, 0.044, 0.085), band * haze * 0.30 * uCalm);

  // ---- grade: a touch of contrast and saturation, then vignette + grain, then the loading dip
  col = (col - 0.5) * 1.045 + 0.5;
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.10);
  float vig = smoothstep(1.28, 0.34, length((uv - vec2(0.5, 0.48)) * vec2(1.05, 1.0)));
  col *= mix(0.52, 1.0, vig);
  col *= uDim;
  col += (h21(gl_FragCoord.xy + fract(uTime) * 71.3) - 0.5) * 0.022;   // film grain

  fragColor = vec4(max(col, 0.0), 1.0);
}`;

const IMG_W = 1920, IMG_H = 1080;   // the vista's aspect; also the fallback for a live frame
// how fast each state ramp travels, in units per second (see Backdrop.set)
const RATE = { push: 1 / 7.0, dim: 1 / 0.8, calm: 1 / 2.0, warp: 1 / 0.85 };

export class Backdrop {
  /** @param {HTMLCanvasElement|OffscreenCanvas} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.t = 0;
    this.state = { mix: 0, has: 0, mouse: [0, 0], push: 0, warp: 0, calm: 1, dim: 1 };
    this._to = { push: 0, warp: 0, calm: 1, dim: 1 };
    this._mixTarget = 0;
    this._mouseTarget = [0, 0];

    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', desynchronized: true, preserveDrawingBuffer: false,
    });
    if (!gl) return;                                  // caller falls back to the CSS gradient underneath
    this.gl = gl;

    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    try {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
      this.prog = p;
      gl.useProgram(p);
      this.u = {};
      for (const n of ['uStill', 'uLive', 'uRes', 'uImg', 'uTime', 'uMix', 'uHas', 'uMouse', 'uPush', 'uWarp', 'uCalm', 'uDim'])
        this.u[n] = gl.getUniformLocation(p, n);
      gl.uniform1i(this.u.uStill, 0);
      gl.uniform1i(this.u.uLive, 1);
      gl.uniform2f(this.u.uImg, IMG_W, IMG_H);
      this.texStill = this._makeTex(gl);
      this.texLive = this._makeTex(gl);
      this.vao = gl.createVertexArray();              // WebGL2 requires a bound VAO even with no attributes
      gl.bindVertexArray(this.vao);
      this.ok = true;
    } catch (e) {
      this.error = String(e?.message || e);
    }
  }

  _makeTex(gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([26, 20, 48]));
    return t;
  }

  setSize(w, h) {
    if (!this.ok) return;
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w; this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  /**
   * Upload one layer. EVERY bitmap that reaches here was made with `imageOrientation: 'flipY'`, and
   * UNPACK_FLIP_Y_WEBGL stays off — the two together would cancel out, and relying on the GL flag alone
   * is what put the world on the menu upside down: Chrome does not apply it consistently to ImageBitmap
   * sources. Flip once, at creation, on every path (Menu._shipFrame and backdropWorker's fetch).
   */
  _upload(tex, bitmap) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bitmap);
    // both layers are the same 16:9 view, so whichever arrived last is the right aspect for cover-fit
    gl.uniform2f(this.u.uImg, bitmap.width || IMG_W, bitmap.height || IMG_H);
  }

  /** the captured vista (an ImageBitmap). Snaps into place — it replaces the stand-in sky. */
  setStill(bitmap) {
    if (!this.ok || !bitmap) { bitmap?.close?.(); return; }
    this._upload(this.texStill, bitmap);
    this.state.has = 1;
    bitmap.close?.();
  }

  /** a frame of the REAL game. The first one starts the cross-fade; after that they just refresh it. */
  setLive(bitmap) {
    if (!this.ok || !bitmap) { bitmap?.close?.(); return; }
    this._upload(this.texLive, bitmap);
    this._mixTarget = 1;
    bitmap.close?.();
  }

  /**
   * Cross-fade to a new picture (cadle.gg walks the whole world this way as you scroll).
   *
   * The two textures are not "still" and "live" here, they are just A and B: upload into whichever one
   * is currently HIDDEN and then send the mix to it. That is the entire trick, and it means an
   * arbitrarily long chain of images costs two textures and one uniform, with no reallocation and no
   * frame where the screen is empty.
   */
  crossTo(bitmap) {
    if (!this.ok || !bitmap) { bitmap?.close?.(); return; }
    const toB = this._mixTarget < 0.5;
    this._upload(toB ? this.texLive : this.texStill, bitmap);
    this._mixTarget = toB ? 1 : 0;
    this.state.has = 1;
    bitmap.close?.();
  }

  /**
   * Every one of these is a TARGET, not a value: the ramps run here, on this thread, at a fixed rate
   * per second. That is deliberate — if the menu drove them frame by frame from the main thread, the
   * dolly and the dive would stutter through exactly the multi-second stalls this worker exists to
   * survive. The menu sends one message per state change and never has to be alive again.
   */
  set(s) {
    if (s.mouse) this._mouseTarget = s.mouse;
    for (const k of ['push', 'warp', 'dim', 'calm']) if (s[k] !== undefined) this._to[k] = s[k];
  }

  frame(dt) {
    if (!this.ok) return;
    const gl = this.gl, S = this.state;
    this.t += dt;
    // cross-fade rate: 2.4 s for the title screen's "the painting wakes up", faster once the landing
    // page is stepping through regions and the fade is a transition rather than a reveal
    S.mix += Math.min(1, dt / (this.fadeSecs || 2.4)) * (this._mixTarget - S.mix);
    S.mouse[0] += (this._mouseTarget[0] - S.mouse[0]) * Math.min(1, dt * 3.2);
    S.mouse[1] += (this._mouseTarget[1] - S.mouse[1]) * Math.min(1, dt * 3.2);
    for (const k in RATE) {
      const d = this._to[k] - S[k], step = RATE[k] * dt;
      S[k] = Math.abs(d) <= step ? this._to[k] : S[k] + Math.sign(d) * step;
    }
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texStill);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texLive);
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uTime, this.t);
    gl.uniform1f(this.u.uMix, S.mix);
    gl.uniform1f(this.u.uHas, S.has);
    gl.uniform2f(this.u.uMouse, S.mouse[0], S.mouse[1]);
    gl.uniform1f(this.u.uPush, S.push);
    // the dive accelerates rather than ramping linearly — a constant-rate swirl reads as a slow zoom
    gl.uniform1f(this.u.uWarp, Math.pow(S.warp, 1.8) * 1.2);
    // once the live world is on screen it brings its own motes, wind and haze — ours would double them
    gl.uniform1f(this.u.uCalm, S.calm * (1 - 0.72 * S.mix));
    gl.uniform1f(this.u.uDim, S.dim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    const gl = this.gl; if (!gl) return;
    try {
      gl.deleteTexture(this.texStill); gl.deleteTexture(this.texLive);
      gl.deleteVertexArray(this.vao); gl.deleteProgram(this.prog);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch (e) { /* teardown is best-effort */ }
    this.ok = false;
  }
}
