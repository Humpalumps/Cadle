// Ported from the FPS (Aurelen) project rpg/ui modules — adapted for Aetherfall via the ctx
// adapter in src/rpg/RPG.js. Keep diffs vs the source minimal; adaptation lives in RPG.js.
// OWNER: UI agent. Every style the full-screen menus need.
// theme.js owns the shared CSS string and is edited concurrently, so nothing here touches it —
// screens.js appends this into #ui as its own <style> after index.js has written theme's.
// Later in document order, same specificity: our rules win the few overrides we need.
import * as T from './theme.js';

const C = T.C;
const SERIF = T.SERIF || "Georgia,'Palatino Linotype',serif";
const F = T.FONT || SERIF;          // theme may publish FONT; fall back to the serif stack

export const SCREEN_CSS = `
#ui .scr,#ui .scr *{box-sizing:border-box}

/* ------------------------------------------------------------------ fit or scroll
   Every screen is a padded grid cell. Cards may never exceed it; anything taller
   scrolls inside its own body. 'safe center' stops a too-tall card losing its top. */
#ui .scr.on{display:grid;place-content:safe center;justify-items:center;padding:12px;overflow:hidden}
#ui .scr>*{max-width:100%;max-height:100%}

#ui .parch.pane{display:flex;flex-direction:column;min-height:0}
#ui .pane>.ttl,#ui .pane>.rule,#ui .pane>.hint,#ui .pane>.say,#ui .pane>.curr{flex:0 0 auto}
#ui .pscroll{position:relative;flex:1 1 auto;min-height:0;display:flex}
#ui .pbody{flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;
  overscroll-behavior:contain;scrollbar-gutter:stable;padding:1px 10px 2px 1px;
  scrollbar-color:${C.goldDk} rgba(90,68,32,.16);scrollbar-width:thin}
#ui .pbody::-webkit-scrollbar{width:10px}
#ui .pbody::-webkit-scrollbar-track{background:rgba(90,68,32,.14);border-radius:6px}
#ui .pbody::-webkit-scrollbar-thumb{border-radius:6px;border:1px solid rgba(70,50,16,.55);
  background:linear-gradient(180deg,#c8a052,#8a6119)}
#ui .pbody::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,${C.goldLt},${C.gold})}
/* scroll affordance: a vellum fade + a caret, only while there is more below */
#ui .pscroll::after{content:'▾';position:absolute;left:0;right:10px;bottom:0;height:30px;
  display:grid;align-items:end;justify-items:center;pointer-events:none;opacity:0;
  transition:opacity .18s;color:rgba(80,60,26,.85);font:400 13px/1 ${F};
  background:linear-gradient(180deg,rgba(222,200,152,0),rgba(216,192,140,.97))}
#ui .pscroll::before{content:'';position:absolute;left:0;right:10px;top:0;height:20px;z-index:1;
  pointer-events:none;opacity:0;transition:opacity .18s;
  background:linear-gradient(0deg,rgba(228,208,162,0),rgba(226,205,158,.92))}
#ui .pscroll.more::after{opacity:1}
#ui .pscroll.off::before{opacity:1}

/* ------------------------------------------------------------------ focus
   Arrow-key roving and post-render restore move focus programmatically, which Chrome
   does not always classify as :focus-visible — so plain :focus carries the ring too,
   and :focus-visible only brightens it. A menu with an invisible ring is not a menu. */
#ui .scr :focus{outline:2px solid ${C.gold};outline-offset:2px;border-radius:3px;
  box-shadow:0 0 0 4px rgba(211,165,72,.28),0 0 18px rgba(211,165,72,.45)}
#ui .scr :focus-visible{outline-color:${C.goldLt};
  box-shadow:0 0 0 4px rgba(211,165,72,.42),0 0 22px rgba(211,165,72,.6)}
#ui .pbody:focus,#ui .pbody:focus-visible{outline-offset:-2px}

/* ------------------------------------------------------------------ controls */
#ui .btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;gap:6px;
  padding:6px 13px;margin:0;border:1px solid rgba(138,97,25,.62);border-radius:3px;cursor:pointer;
  background:linear-gradient(180deg,rgba(255,250,232,.8),rgba(214,192,144,.8));color:${C.ink};
  font:400 11px/1.25 ${F};letter-spacing:.17em;text-transform:uppercase;text-align:center;
  transition:background .16s,box-shadow .16s,transform .12s}
#ui .btn:hover{background:linear-gradient(180deg,rgba(255,252,240,.98),rgba(228,208,160,.98));
  box-shadow:0 0 15px rgba(211,165,72,.4)}
#ui .btn:active{transform:translateY(1px)}
#ui .btn.gold{background:linear-gradient(180deg,${C.goldLt},${C.gold});border-color:${C.goldDk}}
#ui .btn.warn{color:#6d1a13;border-color:rgba(109,26,19,.55)}
#ui .btn.on{background:linear-gradient(180deg,${C.goldLt},${C.gold});border-color:${C.goldDk}}
#ui .btn[aria-disabled="true"],#ui .btn:disabled{opacity:.4;cursor:default;box-shadow:none}
#ui .btnrow{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}

/* real keycaps — no browser default, no synthesised bold */
#ui kbd{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:19px;
  padding:0 6px;margin:0 4px;border-radius:4px;vertical-align:middle;
  border:1px solid rgba(92,68,30,.65);border-bottom:2px solid rgba(76,55,22,.8);
  background:linear-gradient(180deg,#fdf6df 0%,#f0e3c0 52%,#dcc899 100%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.75),0 1px 1px rgba(58,42,16,.35);
  font:400 10px/1 ${F};letter-spacing:.04em;text-transform:none;color:#3a2b12;text-shadow:none}

/* ------------------------------------------------------------------ pause menu
   marker + label are one object: a centred flex row, underline sized to the word. */
#ui .menu{display:flex;flex-direction:column;align-items:center;gap:2px}
#ui .menu li{list-style:none;padding:0;margin:0;display:block;text-align:center}
#ui .menu li::before,#ui .menu li::after,#ui .menu li.sel::before,#ui .menu li.sel::after{content:none;display:none;animation:none}
#ui .mi{appearance:none;-webkit-appearance:none;background:none;border:0;cursor:pointer;
  display:inline-flex;align-items:center;gap:11px;padding:9px 16px;color:#5a441f;
  font:400 clamp(16px,1.6vw,21px)/1 ${F};letter-spacing:.2em;transition:color .16s,transform .16s}
#ui .mi::before{content:'';flex:0 0 auto;width:8px;height:8px;background:${C.gold};
  transform:rotate(45deg) scale(.35);opacity:0;transition:opacity .18s,transform .18s;
  box-shadow:0 0 9px rgba(211,165,72,.9)}
#ui .mi .lb{position:relative;display:inline-block;padding-bottom:3px}
#ui .mi .lb::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;
  background:linear-gradient(90deg,rgba(138,97,25,.15),${C.goldDk},rgba(138,97,25,.15));
  transform:scaleX(0);transform-origin:50%;transition:transform .22s}
#ui .mi.sel,#ui .mi:hover{color:${C.ink};transform:translateX(2px)}
#ui .mi.sel::before{opacity:1;transform:rotate(45deg) scale(1);animation:pip 1.4s infinite ease-in-out}
#ui .mi.sel .lb::after{transform:scaleX(1)}

/* ------------------------------------------------------------------ shared bits */
#ui .say,#ui .cmpn{margin-top:9px;min-height:16px;text-align:center;font:400 11px/1.45 ${F};
  letter-spacing:.16em;text-transform:uppercase;color:#6b5223}
#ui .say.bad{color:#8a2f28}
#ui .say.good{color:#43682f}
#ui .cmpn{margin:8px 0 2px;text-align:left;letter-spacing:.12em;color:#7b6234}

#ui .curr{display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:center;align-items:center;
  padding:7px 10px;margin-bottom:12px;border:1px solid rgba(138,97,25,.34);
  background:rgba(255,248,228,.24);font:400 12px/1 ${F};color:#4b3a26}
#ui .curr .c{display:inline-flex;align-items:center;gap:6px;letter-spacing:.06em}
#ui .curr .c u{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#6b5223;text-decoration:none}
#ui .curr .c svg{display:block}
#ui .curr .sep{width:1px;align-self:stretch;background:rgba(138,97,25,.34)}

#ui .stat{display:grid;grid-template-columns:1fr auto auto;gap:1px 9px;align-items:baseline;
  padding:5px 0 4px;border-bottom:1px dotted rgba(90,68,32,.26)}
#ui .stat .k{font:400 10px/1.5 ${F};letter-spacing:.2em;text-transform:uppercase;color:#5d4620}
#ui .stat .v{font:400 14px/1.2 ${F};letter-spacing:.03em;color:${C.ink};text-align:right}
#ui .stat .d{font:400 11px/1.2 ${F};letter-spacing:.04em;min-width:44px;text-align:right}
#ui .stat .d.up{color:#3f6b2e}
#ui .stat .d.dn{color:#8a2f28}
#ui .stat .n{grid-column:1/-1;font:italic 400 11px/1.45 ${F};color:#7b6234;letter-spacing:.02em}
#ui .meter{grid-column:1/-1;position:relative;height:6px;margin:4px 0 1px;border-radius:2px;
  background:rgba(90,68,32,.18);border:1px solid rgba(90,68,32,.32);overflow:visible}
#ui .meter i{display:block;height:100%;border-radius:1px;
  background:linear-gradient(90deg,${C.goldDk},${C.gold} 70%,${C.goldLt});
  box-shadow:0 0 9px rgba(211,165,72,.55);transition:width .35s ease-out}
#ui .meter u{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;
  background:${C.blood};box-shadow:0 0 5px rgba(174,50,39,.7)}
#ui .pips{display:inline-flex;gap:2px;vertical-align:middle;margin-left:7px}
#ui .pips b{width:5px;height:5px;background:rgba(90,68,32,.26);transform:rotate(45deg)}
#ui .pips b.on{background:${C.gold};box-shadow:0 0 5px rgba(211,165,72,.8)}

#ui .perk{display:flex;gap:9px;align-items:flex-start;padding:6px 0;
  border-bottom:1px dotted rgba(90,68,32,.22)}
#ui .perk .g{flex:0 0 auto;margin-top:2px}
#ui .perk .t{font:400 13px/1.25 ${F};letter-spacing:.04em;color:${C.ink}}
#ui .perk .s{font:400 9px/1.4 ${F};letter-spacing:.24em;text-transform:uppercase;color:#8a6119}
#ui .perk .dsc{font:italic 400 12px/1.4 ${F};color:#6b5528}
#ui .perk.exo .t{color:#8a5a10}

#ui .rar{display:inline-flex;align-items:center;gap:6px;font:400 10px/1 ${F};
  letter-spacing:.24em;text-transform:uppercase;color:#6b5223}
#ui .rar i{width:8px;height:8px;transform:rotate(45deg);background:var(--r,${C.gold});
  border:1px solid rgba(50,36,14,.55)}

/* ------------------------------------------------------------------ character */
#ui .sheet.pane{width:min(1000px,94vw);padding:18px 22px 14px}
#ui .sheet .cols{gap:16px}
#ui .card h3{margin:0 0 7px}
#ui .wide{grid-column:1/-1}
#ui .wname{font:400 clamp(19px,2vw,26px)/1.15 ${F}}

/* ------------------------------------------------------------------ inventory */
#ui .invwrap{width:min(1180px,96vw);padding:16px 20px 12px}
#ui .invcols{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:16px;align-items:start}
#ui .filters{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px}
#ui .ilist{display:flex;flex-direction:column;gap:5px}
#ui .it{appearance:none;-webkit-appearance:none;width:100%;text-align:left;cursor:pointer;
  display:grid;grid-template-columns:auto 1fr auto;gap:3px 10px;align-items:center;
  padding:7px 10px 7px 8px;border:1px solid rgba(138,97,25,.3);border-left:4px solid var(--r,${C.gold});
  background:rgba(255,248,228,.2);color:${C.ink};font:400 13px/1.25 ${F};
  transition:background .14s,border-color .14s}
#ui .it:hover{background:rgba(255,250,234,.5)}
#ui .it.sel{background:rgba(255,250,236,.72);border-color:rgba(138,97,25,.7);
  box-shadow:inset 0 0 0 1px rgba(211,165,72,.45)}
#ui .it .nm{letter-spacing:.03em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ui .it .mt{grid-column:2;font:400 9px/1.3 ${F};letter-spacing:.2em;text-transform:uppercase;color:#7a5f2a}
#ui .it .pw{grid-row:1/3;grid-column:3;text-align:right;font:400 15px/1 ${F};color:#5d4620}
#ui .it .eq{grid-row:1/3;grid-column:1;width:9px;height:9px;transform:rotate(45deg);
  background:var(--r,${C.gold});border:1px solid rgba(50,36,14,.5)}
#ui .it.worn .eq{box-shadow:0 0 0 3px rgba(211,165,72,.45)}
#ui .it.worn .nm::after{content:' · WORN';font-size:9px;letter-spacing:.2em;color:#8a6119}
#ui .detail{position:sticky;top:0;border:1px solid rgba(138,97,25,.4);padding:12px 14px;
  background:rgba(255,248,228,.26)}
#ui .empty{padding:18px 4px;text-align:center;font:italic 400 13px/1.6 ${F};color:#7b6234}

/* ------------------------------------------------------------------ skills */
#ui .skillwrap{width:min(1180px,96vw);padding:16px 20px 12px}
#ui .branches{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}
#ui .branch{border:1px solid rgba(138,97,25,.35);padding:10px 12px 12px;background:rgba(255,248,228,.18)}
#ui .branch>h3{margin:0 0 3px;font:400 12px/1.3 ${F};letter-spacing:.3em;text-transform:uppercase;color:${C.goldDk}}
#ui .branch>p{margin:0 0 10px;font:italic 400 11px/1.45 ${F};color:#7b6234}
#ui .node{position:relative;border:1px solid rgba(138,97,25,.32);padding:8px 10px;margin-bottom:8px;
  background:rgba(255,250,232,.3)}
#ui .node .nh{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
#ui .node .nn{font:400 15px/1.2 ${F};letter-spacing:.03em;color:${C.ink}}
#ui .node .nc{font:400 9px/1.3 ${F};letter-spacing:.2em;text-transform:uppercase;color:#7a5f2a;white-space:nowrap}
#ui .node .nd{margin-top:3px;font:italic 400 12px/1.45 ${F};color:#6b5528}
#ui .node.own{background:linear-gradient(180deg,rgba(247,230,174,.62),rgba(211,165,72,.3));
  border-color:${C.goldDk};box-shadow:inset 0 0 22px rgba(211,165,72,.3)}
#ui .node.own .nn::after{content:' ✦';color:${C.goldDk}}
#ui .node.can{border-color:rgba(138,97,25,.75);box-shadow:0 0 0 1px rgba(211,165,72,.3),0 0 16px rgba(211,165,72,.22)}
#ui .node.lock{opacity:.62}
#ui .node.gone{opacity:.42}
#ui .node.gone .nn{text-decoration:line-through}
#ui .why{margin-top:6px;font:400 10px/1.4 ${F};letter-spacing:.14em;text-transform:uppercase;color:#8a2f28}
#ui .node.own .why{color:#4f6a2c}
#ui .fork{position:relative;border:1px dashed rgba(138,97,25,.6);border-radius:3px;
  padding:16px 8px 4px;margin:14px 0 8px}
#ui .fork::before{content:'EITHER / OR — CHOOSE ONE';position:absolute;top:-8px;left:9px;
  padding:0 7px;background:${C.vellum2};font:400 9px/1.5 ${F};letter-spacing:.24em;color:#8a2f28}
#ui .fork .node{margin-bottom:8px}
#ui .ptbanner{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;
  padding:8px 12px;margin-bottom:12px;border:1px solid rgba(138,97,25,.45);
  background:linear-gradient(180deg,rgba(247,230,174,.5),rgba(255,248,228,.25));
  font:400 12px/1.3 ${F};letter-spacing:.2em;text-transform:uppercase;color:#5d4620}
#ui .ptbanner b{font-weight:400;font-size:20px;letter-spacing:.04em;color:${C.goldDk}}

/* ------------------------------------------------------------------ map */
/* a square sheet that fills whatever height the viewport actually has.
   24px is the .scr padding; max-height:100% above is the safety net. */
#ui .mapwrap{position:relative;padding:14px 16px 10px;overflow:hidden;
  height:calc(100vh - 24px);width:min(96vw,calc(100vh - 24px));
  height:calc(100dvh - 24px);width:min(96vw,calc(100dvh - 24px))}
/* The canvas is absolutely placed so it can never push the legend or hint out of the card;
   mapscreen.draw() sets its square CSS size from the measured box every frame. */
#ui .mapbox{position:relative;flex:1 1 auto;min-height:0}
#ui .mapbox canvas{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:block;
  border:1px solid rgba(138,97,25,.6);box-shadow:inset 0 0 60px rgba(120,88,38,.4),0 2px 14px rgba(0,0,0,.3);
  cursor:grab;touch-action:none}
#ui .mapbox canvas:active{cursor:grabbing}
#ui .maptools{position:absolute;left:8px;top:8px;display:flex;flex-direction:column;gap:5px;z-index:2}
#ui .maptools .btn{padding:3px 8px;min-width:28px;justify-content:center}
#ui .legend{gap:8px 18px;flex-wrap:wrap;margin-top:9px;align-items:center}
#ui .legend span{display:inline-flex;align-items:center;gap:6px}
#ui .legend i{display:none}
#ui .legend svg{display:block;flex:0 0 auto}

/* ------------------------------------------------------------------ death */
#ui #s-death .dcard{width:min(520px,92vw);padding:26px 30px 22px;text-align:center;overflow-y:auto}
#ui .tcard{overflow-y:auto}
#ui #s-death .dcard h2{margin:0;font:400 clamp(22px,3.4vw,42px)/1.1 ${F};letter-spacing:.3em;
  text-indent:.3em;color:#6d1a13;text-shadow:none;animation:fall 1.6s ease-out both}
#ui #s-death .dcard .q{margin-top:14px;color:#6b5528;font:italic 400 14px/1.6 ${F};letter-spacing:.06em}
#ui #s-death .dcard .stats{margin:16px auto 4px;max-width:340px;text-align:left}
#ui #s-death .dcard .again{margin-top:18px;display:inline-flex;align-self:center;padding:11px 30px;
  font-size:13px;letter-spacing:.3em}

/* ------------------------------------------------------------------ tight viewports */
@media (max-height:820px){
  #ui .sheet.pane,#ui .invwrap,#ui .skillwrap{padding:12px 16px 10px}
  #ui .rule{margin:8px 0 12px}
  #ui .card{padding:10px 12px}
  #ui .hint{margin-top:10px}
}
@media (max-height:620px){
  #ui .ttl{font-size:17px;letter-spacing:.3em;text-indent:.3em}
  #ui .rule{margin:6px 0 9px}
  #ui .sheet.pane,#ui .invwrap,#ui .skillwrap,#ui .mapwrap{padding:9px 12px 7px}
  #ui .parch::before{inset:5px}
  #ui .hint{margin-top:7px;line-height:1.5}
  #ui .curr{margin-bottom:8px;padding:5px 8px}
  #ui .mi{padding:6px 14px;font-size:16px}
  #ui .sheet .cols,#ui .invcols,#ui .branches{gap:10px}
  #ui .say{margin-top:6px}
}
@media (max-height:470px){
  #ui .ttl{font-size:14px}
  #ui .hint{font-size:9px;letter-spacing:.18em}
  #ui .wname{font-size:17px}
}

/* Short viewports: give the sheet back every pixel the chrome can spare. The card stays
   square, so the canvas is bound by height — the only lever is the height of the chrome. */
@media (max-height:640px){
  #ui .mapwrap{padding:8px 10px 6px}
  #ui .mapwrap>.rule{margin:5px 0 7px}
  #ui .mapwrap>.legend{gap:2px 12px;margin-top:5px;font-size:9px;letter-spacing:.12em}
  #ui .mapwrap>.legend svg{width:11px;height:11px}
  #ui .mapwrap>.say{margin-top:3px;min-height:12px;font-size:9px;letter-spacing:.1em}
  #ui .mapwrap>.hint{margin-top:3px;font-size:9px;letter-spacing:.14em;line-height:1.5}
  #ui .mapwrap kbd{height:15px;min-width:16px;padding:0 4px;margin:0 2px;font-size:9px}
}
@media (max-width:900px){
  #ui .invcols{grid-template-columns:minmax(0,1fr)}
  #ui .branches{grid-template-columns:minmax(0,1fr)}
  #ui .sheet .cols{grid-template-columns:minmax(0,1fr)}
  #ui .detail{position:static}
}
@media (prefers-reduced-motion:reduce){
  #ui .mi.sel::before{animation:none}
  #ui .meter i{transition:none}
}
`;
