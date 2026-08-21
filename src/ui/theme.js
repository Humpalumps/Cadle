// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Cadle via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: UI agent. Shared visual language: palette, generated parchment, canvas primitives.
// Nothing external — every texture and every glyph here is code or an inline SVG data URI.

export const C = {
  ink: '#241c12',
  ink2: '#4b3a26',
  inkSoft: 'rgba(36,28,18,.55)',
  // One value for "empty vessel", everywhere. Dark ink under gold leaf: manuscript-authentic
  // and, unlike beige-on-beige, it survives greyscale and deuteranopia.
  hollow: '#0a0805',
  hollowA: 'rgba(10,8,5,.94)',
  vellum: '#efe1bd',
  vellum2: '#ddc99c',
  vellumDk: '#c3a877',
  gold: '#d3a548',
  goldLt: '#f7e6ae',
  goldDk: '#8a6119',
  // vermilion, the pigment that sat beside gold leaf in real manuscripts. Bright enough
  // that a full heart clears 5:1 against the hollow.
  blood: '#ef6b4a',
  bloodLt: '#ffa98c',
  bloodDk: '#c03b26',
  spirit: '#bfe6f0',
  spiritDk: '#3f7d90',
  ember: '#e0642c',
  cream: '#f6ecd0',
};

// Element palette. Four weapons and three abilities each carry one of these; spending it
// is free discrimination that costs no extra pixels.
export const EL = {
  ember: { col: '#ffb057', ink: '#7a3208', mark: 'flame', label: 'Ember' },
  solar: { col: '#ffb057', ink: '#7a3208', mark: 'flame', label: 'Solar' },
  fire: { col: '#ffb057', ink: '#7a3208', mark: 'flame', label: 'Fire' },
  flame: { col: '#ffb057', ink: '#7a3208', mark: 'flame', label: 'Flame' },
  frost: { col: '#9fd8ee', ink: '#123a4c', mark: 'frost', label: 'Frost' },
  stasis: { col: '#9fd8ee', ink: '#123a4c', mark: 'frost', label: 'Stasis' },
  ice: { col: '#9fd8ee', ink: '#123a4c', mark: 'frost', label: 'Ice' },
  water: { col: '#9fd8ee', ink: '#123a4c', mark: 'frost', label: 'Water' },
  storm: { col: '#cbb9ff', ink: '#2b1f52', mark: 'bolt', label: 'Storm' },
  arc: { col: '#cbb9ff', ink: '#2b1f52', mark: 'bolt', label: 'Arc' },
  spark: { col: '#cbb9ff', ink: '#2b1f52', mark: 'bolt', label: 'Spark' },
  lightning: { col: '#cbb9ff', ink: '#2b1f52', mark: 'bolt', label: 'Lightning' },
  gloom: { col: '#b98fd6', ink: '#33184a', mark: 'moon', label: 'Gloom' },
  void: { col: '#b98fd6', ink: '#33184a', mark: 'moon', label: 'Void' },
  shadow: { col: '#b98fd6', ink: '#33184a', mark: 'moon', label: 'Shadow' },
  verdant: { col: '#a9d98a', ink: '#1f3d16', mark: 'leaf', label: 'Verdant' },
  nature: { col: '#a9d98a', ink: '#1f3d16', mark: 'leaf', label: 'Nature' },
  wild: { col: '#a9d98a', ink: '#1f3d16', mark: 'leaf', label: 'Wild' },
  kinetic: { col: '#e8dcc0', ink: '#3a2f1c', mark: 'rune', label: 'Kinetic' },
};
export const elementOf = (k) => EL[String(k || '').toLowerCase()] || null;

// fractal-noise grain, generated as an inline SVG filter (no image files)
export const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E" +
  "%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E" +
  "%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E" +
  "%3Crect width='160' height='160' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E\")";

// The prose face. No external assets are allowed, so this has to survive a machine with no
// Georgia: the stack walks Georgia → Iowan → Palatino → Charter → Times → generic serif, all
// of which are old-style/transitional serifs that keep the voice. Numerals never rely on it
// (see `figures` below), which is the part that actually broke.
export const SERIF = "Georgia,'Iowan Old Style','Palatino Linotype','Book Antiqua',Palatino," +
  "Charter,'Bitstream Charter','Times New Roman',Times,serif";
export const FONT = SERIF;

// Is the first choice actually installed? Compare a string set in `Georgia,monospace`
// against the same string in plain `monospace`: identical widths mean Georgia never loaded.
// ponytail: one boolean and one tracking knob. A real embedded subset would need a TTF
// builder; this is the calibration screw for the same problem at 1% of the code.
export const FONT_OK = (() => {
  try {
    const g = document.createElement('canvas').getContext('2d');
    const probe = 'MWQ@1590mwq';
    g.font = '72px monospace'; const base = g.measureText(probe).width;
    g.font = '72px Georgia,monospace'; const test = g.measureText(probe).width;
    return Math.abs(base - test) > 0.5;
  } catch (e) { return true; }
})();
// Fallback serifs run narrower and lighter than Georgia; open the tracking a touch so the
// letterspaced display type keeps the same colour on the page.
export const TRACK = FONT_OK ? 1 : 1.22;

// ---------------------------------------------------------------- canvas bits

export function heartPath(g, x, y, w) {
  const h = w * 0.94;
  g.beginPath();
  g.moveTo(x, y + h * 0.40);
  g.bezierCurveTo(x - w * 0.56, y - h * 0.22, x - w * 0.50, y - h * 0.66, x - w * 0.23, y - h * 0.62);
  g.bezierCurveTo(x - w * 0.09, y - h * 0.60, x - w * 0.01, y - h * 0.46, x, y - h * 0.33);
  g.bezierCurveTo(x + w * 0.01, y - h * 0.46, x + w * 0.09, y - h * 0.60, x + w * 0.23, y - h * 0.62);
  g.bezierCurveTo(x + w * 0.50, y - h * 0.66, x + w * 0.56, y - h * 0.22, x, y + h * 0.40);
  g.closePath();
}

// tapered "brush" line — thick in the middle, thin at the ends. Reads hand-drawn.
export function brush(g, x1, y1, x2, y2, w) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L * w * 0.5, ny = dx / L * w * 0.5;
  g.beginPath();
  g.moveTo(x1, y1);
  g.quadraticCurveTo((x1 + x2) / 2 + nx, (y1 + y2) / 2 + ny, x2, y2);
  g.quadraticCurveTo((x1 + x2) / 2 - nx, (y1 + y2) / 2 - ny, x1, y1);
  g.closePath();
}

export function goldGrad(g, x, y, w, h) {
  const gr = g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, C.goldDk);
  gr.addColorStop(0.34, C.gold);
  gr.addColorStop(0.5, C.goldLt);
  gr.addColorStop(0.7, C.gold);
  gr.addColorStop(1, C.goldDk);
  return gr;
}

export function setFont(g, size, weight = 400, family = SERIF, letter = 0) {
  g.font = `${weight} ${size}px ${family}`;
  if ('letterSpacing' in g) g.letterSpacing = (letter * TRACK) + 'px';
}

// text with an ink shadow so it survives any background
export function inkText(g, txt, x, y, fill, blur = 6) {
  g.save();
  g.shadowColor = 'rgba(0,0,0,.75)'; g.shadowBlur = blur; g.shadowOffsetY = 1;
  g.fillStyle = fill; g.fillText(txt, x, y);
  g.shadowBlur = 0; g.fillText(txt, x, y);
  g.restore();
}

// Knocked-out text: a real dark stroke around the letterforms, not a blur. A shadow fails
// over bright terrain because it has no hard edge; a stroke cannot fail.
export function koText(g, txt, x, y, fill, o = {}) {
  const w = o.weight != null ? o.weight : 3;
  g.save();
  g.lineJoin = 'round'; g.miterLimit = 2;
  g.strokeStyle = o.ko || 'rgba(8,6,3,.92)'; g.lineWidth = w;
  g.strokeText(txt, x, y);
  if (o.glow) { g.shadowColor = o.glow; g.shadowBlur = o.glowBlur || 10; }
  g.fillStyle = fill; g.fillText(txt, x, y);
  g.restore();
}

// A dark plate to knock world-overlaid type out of the terrain. Returns nothing; call
// before the text. `a` is how opaque the plate is over whatever is behind it.
export function plate(g, x, y, w, h, o = {}) {
  const r = o.r != null ? o.r : Math.min(6, h * 0.34);
  g.save();
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
  g.fillStyle = o.fill || 'rgba(9,7,4,.86)';
  g.fill();
  if (o.rule !== false) {
    g.strokeStyle = o.rule || 'rgba(211,165,72,.42)';
    g.lineWidth = 1;
    g.stroke();
  }
  g.restore();
}

// small parchment tag with torn-ish corners, used for prompts and marker labels
export function tag(g, x, y, w, h, a = 1) {
  const r = 3;
  g.save();
  g.globalAlpha *= a;
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w + 2, y + h * 0.5);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x - 2, y + h * 0.5);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
  const gr = g.createLinearGradient(x, y, x, y + h);
  gr.addColorStop(0, 'rgba(242,229,199,.94)');
  gr.addColorStop(1, 'rgba(206,184,141,.90)');
  g.fillStyle = gr; g.fill();
  g.strokeStyle = 'rgba(90,68,32,.75)'; g.lineWidth = 1.2; g.stroke();
  g.restore();
}

// ---------------------------------------------------------------- figures
// Lining, tabular, pen-drawn numerals. Georgia ships old-style text figures — the 3 and 9
// hang below the baseline and the 1 is short — which is correct for running prose and wrong
// for a number you read at 60fps. These are drawn, so they are lining by construction,
// tabular by construction (every digit shares one advance), knocked out by construction,
// and they do not care whether any font is installed.
//
// Coordinates are em units on a 1.0 cap height: baseline y=0, cap top y=-1.
const AW = 0.62;                       // one advance for every digit — tabular
const M = (x, y) => ['M', x, y];
const L = (x, y) => ['L', x, y];
const Q = (cx, cy, x, y) => ['Q', cx, cy, x, y];
const O = (cx, cy, rx, ry) => ['O', cx, cy, rx, ry];

const GLY = {
  '0': [AW, [[O(0.31, -0.50, 0.235, 0.50)]]],
  '1': [AW, [[M(0.12, -0.79), L(0.32, -1.00), L(0.32, 0)], [M(0.12, 0), L(0.52, 0)]]],
  '2': [AW, [[M(0.07, -0.78), Q(0.08, -1.02, 0.31, -1.02), Q(0.56, -1.02, 0.56, -0.76),
              Q(0.56, -0.55, 0.30, -0.33), L(0.06, -0.02), L(0.58, -0.02)]]],
  '3': [AW, [[M(0.08, -0.84), Q(0.14, -1.03, 0.35, -1.03), Q(0.57, -1.03, 0.57, -0.83), Q(0.57, -0.62, 0.31, -0.58)],
             [M(0.27, -0.58), Q(0.60, -0.58, 0.60, -0.30), Q(0.60, -0.02, 0.31, -0.02), Q(0.13, -0.02, 0.05, -0.15)]]],
  '4': [AW, [[M(0.45, -1.00), L(0.04, -0.27), L(0.60, -0.27)], [M(0.45, -1.00), L(0.45, 0)]]],
  '5': [AW, [[M(0.55, -1.00), L(0.15, -1.00), L(0.10, -0.61), Q(0.23, -0.68, 0.34, -0.68),
              Q(0.59, -0.68, 0.59, -0.35), Q(0.59, -0.02, 0.29, -0.02), Q(0.13, -0.02, 0.05, -0.14)]]],
  '6': [AW, [[M(0.53, -0.95), Q(0.36, -1.05, 0.22, -0.90), Q(0.07, -0.74, 0.07, -0.40)],
             [O(0.31, -0.29, 0.245, 0.275)]]],
  '7': [AW, [[M(0.05, -1.00), L(0.58, -1.00), Q(0.44, -0.62, 0.30, -0.02)]]],
  '8': [AW, [[O(0.31, -0.745, 0.205, 0.255)], [O(0.31, -0.255, 0.245, 0.255)]]],
  '9': [AW, [[O(0.31, -0.715, 0.245, 0.275)],
             [M(0.555, -0.66), Q(0.555, -0.28, 0.44, -0.12), Q(0.33, -0.01, 0.12, -0.05)]]],
  '/': [0.52, [[M(0.05, 0.07), L(0.47, -1.05)]]],
  '.': [0.28, [[M(0.14, -0.02), L(0.15, -0.02)]]],
  ',': [0.28, [[M(0.16, -0.04), L(0.10, 0.14)]]],
  '-': [0.44, [[M(0.07, -0.42), L(0.37, -0.42)]]],
  '+': [0.54, [[M(0.08, -0.42), L(0.46, -0.42)], [M(0.27, -0.61), L(0.27, -0.23)]]],
  '%': [0.86, [[O(0.19, -0.79, 0.15, 0.19)], [O(0.66, -0.21, 0.15, 0.19)], [M(0.76, -1.00), L(0.09, -0.02)]]],
  'm': [0.80, [[M(0.06, -0.62), L(0.06, 0)],
               [M(0.06, -0.45), Q(0.10, -0.64, 0.24, -0.64), Q(0.39, -0.64, 0.39, -0.45), L(0.39, 0)],
               [M(0.39, -0.45), Q(0.43, -0.64, 0.57, -0.64), Q(0.72, -0.64, 0.72, -0.45), L(0.72, 0)]]],
  '×': [0.58, [[M(0.11, -0.60), L(0.47, -0.24)], [M(0.47, -0.60), L(0.11, -0.24)]]],
  ' ': [0.34, []],
};

// serif fallback for anything not drawn above (letters inside a number string, mostly).
// Georgia's cap height is ~0.7em, so a cap-height-of-`size` match wants size/0.7.
const FB = 1.42;

function traceSub(g, sub) {
  g.beginPath();
  for (const s of sub) {
    if (s[0] === 'M') g.moveTo(s[1], s[2]);
    else if (s[0] === 'L') g.lineTo(s[1], s[2]);
    else if (s[0] === 'Q') g.quadraticCurveTo(s[1], s[2], s[3], s[4]);
    else g.ellipse(s[1], s[2], s[3], s[4], 0, 0, Math.PI * 2);
  }
}

export function measureFigures(g, str, size) {
  let w = 0;
  for (const ch of String(str)) {
    const gl = GLY[ch];
    if (gl) { w += gl[0] * size; continue; }
    setFont(g, size * FB, 400);
    w += g.measureText(ch).width;
  }
  return w;
}

// Draw a numeric string. `align` left|center|right, `col` fill, `ko` knockout stroke colour
// (pass ko:null to skip the knockout), `weight` pen width in em.
export function figures(g, str, x, y, size, o = {}) {
  str = String(str);
  const total = measureFigures(g, str, size);
  const align = o.align || 'left';
  let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  const pen = o.weight != null ? o.weight : 0.145;
  const ko = o.ko === undefined ? 'rgba(8,6,3,.94)' : o.ko;
  // The knockout has to be proportional AND bounded: a 0.075em skirt is right at 40px and
  // swallows the counters at 6px, where the figure is only a few pixels wide to begin with.
  const koW = (o.koWeight != null ? o.koWeight : (size < 12 ? 0.045 : 0.075)) * 2;

  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const ch of str) {
    const gl = GLY[ch];
    if (!gl) {
      setFont(g, size * FB, 400);
      const tw = g.measureText(ch).width;
      const pa = g.textAlign, pb = g.textBaseline;
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      if (ko) { g.strokeStyle = ko; g.lineWidth = pen * size + koW * size; g.strokeText(ch, cx, y); }
      g.fillStyle = o.col || C.cream; g.fillText(ch, cx, y);
      g.textAlign = pa; g.textBaseline = pb;
      cx += tw;
      continue;
    }
    g.save();
    g.translate(cx, y); g.scale(size, size);
    if (ko) {
      g.strokeStyle = ko; g.lineWidth = pen + koW;
      for (const sub of gl[1]) { traceSub(g, sub); g.stroke(); }
    }
    g.strokeStyle = o.col || C.cream; g.lineWidth = pen;
    if (o.glow) { g.shadowColor = o.glow; g.shadowBlur = (o.glowBlur || 8) / size; }
    for (const sub of gl[1]) { traceSub(g, sub); g.stroke(); }
    g.restore();
    cx += gl[0] * size;
  }
  g.restore();
  return total;
}

export const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  in: (t) => t * t * t,
  back: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
};

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

// mid-word truncation with a real ellipsis, for the compass strip
export function ellipsize(g, txt, max) {
  if (g.measureText(txt).width <= max) return txt;
  let s = txt;
  while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s.replace(/[\s·]+$/, '') + '…';
}

// --------------------------------------------------------------------- styles

export const CSS = `
#ui{font-family:${SERIF};}
#ui .layer{position:absolute;inset:0;pointer-events:none}
#ui canvas.hudc{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}

/* --- ambient screen effects --- */
#ui .vig{position:absolute;inset:0;box-shadow:inset 0 0 240px rgba(8,6,3,.62),inset 0 0 60px rgba(8,6,3,.28)}
#ui .hurt{position:absolute;inset:0;opacity:0;transition:opacity .3s ease-out;
  background:radial-gradient(ellipse at center,#0000 38%,rgba(140,28,22,.82) 100%)}
#ui .lowhp{position:absolute;inset:0;opacity:0;
  background:radial-gradient(ellipse at center,#0000 44%,rgba(150,34,26,.55) 100%)}
#ui .lowhp.on{animation:beat 1.15s infinite ease-in-out}
@keyframes beat{0%,100%{opacity:.10}18%{opacity:.46}34%{opacity:.16}48%{opacity:.34}62%{opacity:.10}}
#ui .heal{position:absolute;inset:0;opacity:0;mix-blend-mode:screen;
  background:radial-gradient(ellipse at 50% 120%,rgba(255,226,150,.5),#0000 60%)}
#ui .heal.on{animation:healf 1.1s ease-out}
@keyframes healf{0%{opacity:0}25%{opacity:.9}100%{opacity:0}}

/* --- the notification lane -------------------------------------------------
   ONE column, bottom-left, out of the sightline. Toasts and the discovery card are
   siblings in the same flow, so they physically cannot stack on top of each other or
   on the reticle the way four centred cream texts used to. */
#ui .lane{position:absolute;left:clamp(18px,2.2vw,40px);bottom:23%;width:min(430px,32vw);
  display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;gap:12px;
  pointer-events:none}
#ui .lane.dim{opacity:.25;transition:opacity .2s}

#ui .toast{position:relative;padding:8px 16px 9px;color:${C.cream};text-align:left;
  font:400 19px/1.25 ${SERIF};letter-spacing:.2em;text-indent:.2em;white-space:nowrap;
  max-width:100%;overflow:hidden;text-overflow:ellipsis;
  background:linear-gradient(90deg,rgba(9,7,4,.9),rgba(9,7,4,.5) 78%,rgba(9,7,4,0));
  text-shadow:0 1px 3px #000;animation:tf 2.8s forwards}
#ui .toast::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;
  background:linear-gradient(180deg,#0000,${C.gold},#0000)}
#ui .toast::after{content:'';position:absolute;left:0;right:14%;bottom:0;height:1px;
  background:linear-gradient(90deg,${C.gold},#0000)}
#ui .toast .sub{display:block;font-size:11px;letter-spacing:.3em;opacity:.78;margin-top:4px}
#ui .toast.big{font-size:25px;color:#fff4d2}
#ui .toast.rare{color:#e9c9ff}
#ui .toast.rare::before{background:linear-gradient(180deg,#0000,#c79bff,#0000)}
#ui .toast.rare::after{background:linear-gradient(90deg,#c79bff,#0000)}
@keyframes tf{0%{opacity:0;transform:translateX(-14px);filter:blur(3px)}
  12%{opacity:1;transform:none;filter:none}78%{opacity:1}100%{opacity:0;transform:translateX(-8px)}}

/* the discovery card keeps its typography — kicker, gold rule, footnote — but it lives in
   the lane now instead of across the middle of the screen */
#ui .discover{position:relative;text-align:left;opacity:0;padding:10px 18px 12px;max-width:100%;
  background:linear-gradient(90deg,rgba(9,7,4,.92),rgba(9,7,4,.55) 80%,rgba(9,7,4,0))}
#ui .discover.go{animation:disc 5s ease-out forwards}
#ui .discover .k{font:400 11px/1 ${SERIF};letter-spacing:.56em;text-indent:.56em;color:${C.gold};
  text-transform:uppercase;text-shadow:0 1px 4px #000}
#ui .discover .n{margin-top:9px;font:400 clamp(24px,2.4vw,38px)/1.1 ${SERIF};color:#fdf3d6;
  letter-spacing:.12em;text-indent:.12em;text-shadow:0 2px 10px #000,0 0 26px rgba(255,205,110,.45)}
#ui .discover .r{margin:10px 0 0;height:2px;width:0;background:linear-gradient(90deg,${C.goldLt},#0000);
  animation:rule 5s ease-out forwards}
#ui .discover .f{margin-top:7px;font:400 12px/1 ${SERIF};letter-spacing:.32em;color:#e6d3a4;opacity:.88}
@keyframes disc{0%{opacity:0;transform:translateX(-18px) scale(.98)}
  9%{opacity:1;transform:none}82%{opacity:1}100%{opacity:0;transform:translateX(-10px)}}
@keyframes rule{0%{width:0}20%{width:100%}82%{width:100%}100%{width:0}}

#ui .subs{position:absolute;left:50%;transform:translateX(-50%);bottom:15.5%;width:min(760px,60vw);
  text-align:center}
#ui .sub{color:#f2e6c6;font:400 19px/1.5 ${SERIF};letter-spacing:.05em;
  text-shadow:0 2px 12px #000,0 0 3px #000;margin-top:6px;opacity:0;animation:sf var(--d,5s) forwards}
#ui .sub i{color:${C.goldLt};font-style:italic}
@keyframes sf{0%{opacity:0;transform:translateY(7px)}9%{opacity:1;transform:none}
  84%{opacity:1}100%{opacity:0}}

/* --- screens --- */
/* two-step visibility: .on mounts it, .shown fades it in. Transitions, not animations,
   so a fast reopen can never leave a mounted screen stuck at opacity 0. */
#ui .scr{position:absolute;inset:0;display:none;place-items:center;pointer-events:auto;opacity:0;
  transition:opacity .24s ease;
  background:radial-gradient(ellipse at 50% 45%,rgba(12,10,7,.55),rgba(6,5,3,.88));
  -webkit-backdrop-filter:blur(7px) saturate(.55) sepia(.3);backdrop-filter:blur(7px) saturate(.55) sepia(.3)}
#ui .scr.on{display:grid}
#ui .scr.shown{opacity:1}
#ui .scr>*{transform:translateY(12px) scale(.985);transition:transform .3s cubic-bezier(.2,.85,.3,1)}
#ui .scr.shown>*{transform:none}

#ui .parch{position:relative;background:
  radial-gradient(ellipse at 22% 12%,rgba(255,247,224,.95),#0000 55%),
  radial-gradient(ellipse at 82% 88%,rgba(206,178,126,.75),#0000 52%),
  linear-gradient(160deg,${C.vellum},${C.vellum2} 62%,${C.vellumDk});
  color:${C.ink};box-shadow:0 26px 70px rgba(0,0,0,.7),0 0 0 1px rgba(80,58,24,.5),
  inset 0 0 70px rgba(120,88,38,.28);border-radius:5px}
#ui .parch::after{content:'';position:absolute;inset:0;background-image:${GRAIN};
  mix-blend-mode:multiply;opacity:.15;border-radius:5px;pointer-events:none}
#ui .parch::before{content:'';position:absolute;inset:9px;border:1px solid rgba(138,97,25,.5);
  border-radius:2px;pointer-events:none;
  box-shadow:inset 0 0 0 3px rgba(211,165,72,.14)}

#ui .ttl{font:400 clamp(22px,2.1vw,30px)/1 ${SERIF};letter-spacing:.42em;text-indent:.42em;
  color:${C.goldDk};text-transform:uppercase;text-align:center}
#ui .rule{height:1px;background:linear-gradient(90deg,#0000,rgba(138,97,25,.75),#0000);margin:12px 0 18px}

#ui .menu{list-style:none;margin:0;padding:0}
#ui .menu li{position:relative;padding:11px 26px;font:400 22px/1 ${SERIF};letter-spacing:.2em;
  color:#5a441f;cursor:pointer;transition:color .16s,transform .16s;text-align:center}
#ui .menu li.sel{color:${C.ink}}

#ui .hint{margin-top:16px;text-align:center;font:400 11px/1.7 ${SERIF};letter-spacing:.28em;
  color:rgba(60,45,20,.62);text-transform:uppercase}
#ui kbd{display:inline-block;min-width:15px;padding:1px 5px;margin:0 3px;border-radius:3px;
  border:1px solid rgba(90,68,32,.55);background:rgba(255,247,225,.6);font:400 11px/1.4 ${SERIF};
  letter-spacing:.1em;color:${C.ink}}

/* title */
#ui #s-title{background:radial-gradient(ellipse at 50% 42%,rgba(20,26,40,.30),rgba(4,5,9,.86))}
#ui .tcard{text-align:center;padding:0 40px}
#ui .tcard h1{margin:0;font:400 clamp(46px,8vw,116px)/1 ${SERIF};letter-spacing:.34em;text-indent:.34em;
  color:#f7e9c3;text-shadow:0 0 60px rgba(255,206,120,.5),0 6px 30px #000;
  animation:tglow 6s infinite ease-in-out}
@keyframes tglow{0%,100%{text-shadow:0 0 46px rgba(255,206,120,.36),0 6px 30px #000}
  50%{text-shadow:0 0 82px rgba(255,214,140,.66),0 6px 30px #000}}
#ui .tcard .fil{margin:20px auto;width:min(560px,70vw);height:22px;position:relative}
#ui .tcard .fil i{position:absolute;top:10px;height:1px;background:linear-gradient(90deg,#0000,${C.gold},#0000);
  left:0;right:0}
#ui .tcard .fil b{position:absolute;left:50%;top:2px;width:16px;height:16px;margin-left:-8px;
  background:${C.goldLt};transform:rotate(45deg);box-shadow:0 0 22px rgba(255,206,120,.85)}
#ui .tcard .sub{font:400 13px/1.9 ${SERIF};letter-spacing:.5em;text-indent:.5em;color:#cbb489}
#ui .tcard .go{margin-top:34px;font:400 15px/1 ${SERIF};letter-spacing:.42em;text-indent:.42em;
  color:#f0dfae;animation:blip 2.2s infinite ease-in-out}
@keyframes blip{0%,100%{opacity:.35}50%{opacity:1}}

/* character sheet + map layout */
#ui .sheet{width:min(940px,88vw);padding:30px 34px 26px}
#ui .cols{display:grid;grid-template-columns:1.05fr 1fr;gap:26px}
#ui .card{border:1px solid rgba(138,97,25,.35);padding:14px 16px;background:rgba(255,248,228,.22)}
#ui .card h3{margin:0 0 8px;font:400 12px/1 ${SERIF};letter-spacing:.34em;color:${C.goldDk};
  text-transform:uppercase}
#ui .wname{font:400 27px/1.15 ${SERIF};letter-spacing:.06em;color:${C.ink}}
#ui .wel{font:400 11px/1 ${SERIF};letter-spacing:.4em;text-transform:uppercase;color:#7a5a1d;margin-top:5px}
#ui .rows{margin-top:10px}
#ui .row{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;
  border-bottom:1px dotted rgba(90,68,32,.28);font:400 14px/1.5 ${SERIF}}
#ui .row b{font-weight:600;letter-spacing:.04em;font-variant-numeric:lining-nums tabular-nums}
#ui .row span{color:#5d4620;letter-spacing:.18em;font-size:11px;text-transform:uppercase}
#ui .xp{height:7px;background:rgba(90,68,32,.22);border:1px solid rgba(90,68,32,.4);overflow:hidden;margin-top:6px}
#ui .xp i{display:block;height:100%;background:linear-gradient(90deg,${C.goldDk},${C.goldLt});
  box-shadow:0 0 12px rgba(211,165,72,.8);transition:width .6s ease-out}
#ui .mapwrap{position:relative;width:min(760px,84vw,64vh);padding:24px 24px 16px}
#ui .mapwrap canvas{display:block;width:100%;height:auto;border:1px solid rgba(138,97,25,.5);
  box-shadow:inset 0 0 40px rgba(120,88,38,.35)}
#ui .legend{display:flex;gap:22px;justify-content:center;margin-top:12px;font:400 11px/1 ${SERIF};
  letter-spacing:.24em;color:#6a5124;text-transform:uppercase}
#ui .legend i{display:inline-block;width:8px;height:8px;margin-right:6px;transform:rotate(45deg)}

/* every number in a DOM screen is lining and tabular too */
#ui .num,#ui .xp+*,#ui b{font-variant-numeric:lining-nums tabular-nums}
`;
