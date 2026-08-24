// OWNER: hud builder. Every style the full-screen menus need (map M / character C / inventory I / skills K).
//
// House style, one house: these screens used to be cream parchment while the ESC settings menu was the
// dark aether-glass "UI KIT" in ui.css. Two different games. This file is now the same kit — glass panel,
// gold hairline, corner studs, gold-gradient display type, segmented tabs, spring press — reskinned for
// the bigger surfaces a loot screen needs (bag grid, item tiles, paper-doll slots, compare deltas).
//
// theme.js still owns the shared shell (.scr/.parch/.card/...) and is edited concurrently, so nothing here
// touches it: Screens.js appends this <style> AFTER theme's, and these selectors carry one extra class
// (#ui .scr .parch beats #ui .parch), so the overrides win without touching the other file.
//
// Tokens come from the UI KIT block in ui.css (--glass, --line, --gold, --spring, ...). The only local
// colours are the ones a screen needs and the kit does not define.

export const SCREEN_CSS = `
#ui .scr,#ui .scr *{box-sizing:border-box}
#ui .scr{--r:var(--gold);--sink:#07060f;--srule:rgba(216,189,122,.20)}

/* ------------------------------------------------------------------ fit or scroll
   Every screen is a padded grid cell. Cards may never exceed it; anything taller
   scrolls inside its own body. 'safe center' stops a too-tall card losing its top. */
#ui .scr.on{display:grid;place-content:safe center;justify-items:center;padding:12px;overflow:hidden}
#ui .scr>*{max-width:100%;max-height:100%}

/* ------------------------------------------------------------------ the panel
   Same object as the settings modal: glass, one gold hairline, a stud top and bottom. */
#ui .scr .parch{background:radial-gradient(ellipse at 50% -8%,rgba(143,216,255,.09),transparent 58%),var(--glass);
  color:var(--text);border:1px solid var(--line);border-radius:10px;
  box-shadow:0 30px 90px rgba(0,0,0,.72),inset 0 1px 0 rgba(255,240,205,.10),0 0 60px rgba(124,91,214,.10)}
#ui .scr .parch::after{content:none}
#ui .scr .parch::before{content:"";position:absolute;inset:auto;top:-5px;left:50%;margin-left:-5px;
  width:9px;height:9px;border:1.5px solid var(--gold);transform:rotate(45deg);background:#0b0a1a;
  border-radius:0;box-shadow:none}
#ui .scr .parch>.sfoot::after{content:"";position:absolute;bottom:-19px;left:50%;margin-left:-5px;
  width:9px;height:9px;border:1.5px solid var(--gold);transform:rotate(45deg);background:#0b0a1a}
#ui .parch.pane{display:flex;flex-direction:column;min-height:0}
#ui .pane>.shead,#ui .pane>.sfoot,#ui .pane>.say,#ui .pane>.curr{flex:0 0 auto}
#ui .pscroll{position:relative;flex:1 1 auto;min-height:0;display:flex}
#ui .pbody{flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;
  overscroll-behavior:contain;scrollbar-gutter:stable;padding:1px 10px 2px 1px;
  scrollbar-color:rgba(216,189,122,.5) rgba(255,255,255,.05);scrollbar-width:thin}
#ui .pbody::-webkit-scrollbar{width:9px}
#ui .pbody::-webkit-scrollbar-track{background:rgba(255,255,255,.04);border-radius:6px}
#ui .pbody::-webkit-scrollbar-thumb{border-radius:6px;border:1px solid rgba(216,189,122,.35);
  background:linear-gradient(180deg,rgba(216,189,122,.55),rgba(138,97,25,.55))}
#ui .pbody::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,var(--gold-hi),var(--gold))}
/* scroll affordance: a fade + caret, only while there is more below */
#ui .pscroll::after{content:'▾';position:absolute;left:0;right:9px;bottom:0;height:30px;
  display:grid;align-items:end;justify-items:center;pointer-events:none;opacity:0;
  transition:opacity .18s;color:var(--gold-dim);font:400 13px/1 var(--serif);
  background:linear-gradient(180deg,rgba(9,8,20,0),rgba(9,8,20,.92))}
#ui .pscroll::before{content:'';position:absolute;left:0;right:9px;top:0;height:20px;z-index:1;
  pointer-events:none;opacity:0;transition:opacity .18s;
  background:linear-gradient(0deg,rgba(9,8,20,0),rgba(9,8,20,.85))}
#ui .pscroll.more::after{opacity:1}
#ui .pscroll.off::before{opacity:1}

/* ------------------------------------------------------------------ header + tabs */
#ui .shead{padding:16px 4px 0;text-align:center}
#ui .scr .ttl{margin:0;font:300 clamp(22px,2.4vw,32px)/1 var(--serif);font-variant:small-caps;
  letter-spacing:.3em;text-indent:.3em;text-transform:none;color:var(--gold-hi);
  background:linear-gradient(100deg,#8a6119 18%,#d8bd7a 40%,#fdf3cd 50%,#d8bd7a 60%,#8a6119 82%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
#ui .shead .kick{margin:3px 0 0;font:400 10px/1 var(--serif);font-variant:small-caps;
  letter-spacing:.36em;text-indent:.36em;color:var(--aether);opacity:.75}
#ui .shead .mflourish{height:1px;margin:12px auto 0;width:74%;position:relative;
  background:linear-gradient(90deg,transparent,var(--gold-dim),transparent)}
#ui .shead .mflourish::after{content:"\\2756";position:absolute;left:50%;top:-8px;transform:translateX(-50%);
  color:var(--gold);font-size:10px}
#ui .stabs{display:flex;gap:2px;justify-content:center;margin:14px auto 12px;padding:3px;
  border:1px solid var(--line);border-radius:9px;background:rgba(5,4,12,.5);width:fit-content}
#ui .stabs button{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;gap:7px;
  padding:7px 18px;border:0;border-radius:7px;background:none;cursor:pointer;color:var(--textdim);
  font:400 12px/1 var(--serif);font-variant:small-caps;letter-spacing:.18em;
  transition:color .18s var(--ease),background .28s var(--spring)}
#ui .stabs button:hover{color:var(--text)}
#ui .stabs button.on{color:#0d0b18;background:linear-gradient(180deg,var(--gold-hi),var(--gold));
  box-shadow:0 2px 10px rgba(216,189,122,.28)}
#ui .stabs kbd{min-width:16px;height:15px;padding:0 4px;margin:0;font-size:9px;opacity:.72}
#ui .stabs button.on kbd{background:rgba(11,10,26,.22);border-color:rgba(11,10,26,.4);color:#221a06;
  box-shadow:none;text-shadow:none}

/* ------------------------------------------------------------------ focus
   Arrow-key roving moves focus programmatically, which Chrome does not always classify as
   :focus-visible — so plain :focus carries the ring too. A menu with an invisible ring is not a menu. */
#ui .scr :focus{outline:2px solid var(--gold);outline-offset:2px;border-radius:4px;
  box-shadow:0 0 0 4px rgba(216,189,122,.22),0 0 18px rgba(216,189,122,.35)}
#ui .scr :focus-visible{outline-color:var(--gold-hi);
  box-shadow:0 0 0 4px rgba(216,189,122,.34),0 0 22px rgba(216,189,122,.5)}
#ui .pbody:focus,#ui .pbody:focus-visible{outline-offset:-2px}

/* ------------------------------------------------------------------ controls */
#ui .scr .btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;gap:7px;
  padding:8px 15px;margin:0;border:1px solid var(--line);border-radius:7px;cursor:pointer;
  background:rgba(255,255,255,.04);color:var(--text);
  font:400 11px/1.2 var(--serif);letter-spacing:.17em;text-transform:uppercase;text-align:center;
  transition:background .16s var(--ease),box-shadow .16s var(--ease),transform .18s var(--spring),color .16s}
#ui .scr .btn:hover{background:rgba(255,255,255,.09);border-color:var(--gold-dim);color:#fff6e0}
#ui .scr .btn:active{transform:translateY(1px) scale(.985)}
#ui .scr .btn.gold{background:linear-gradient(180deg,var(--gold-hi),var(--gold));border-color:var(--gold);
  color:#241b06;box-shadow:0 2px 14px rgba(216,189,122,.3)}
#ui .scr .btn.gold:hover{background:linear-gradient(180deg,#fff3ce,var(--gold-hi));color:#241b06}
#ui .scr .btn.warn{color:#ff9a86;border-color:rgba(224,85,52,.45)}
#ui .scr .btn.warn:hover{background:rgba(224,85,52,.16);color:#ffc3b4}
#ui .scr .btn.on{background:linear-gradient(180deg,var(--gold-hi),var(--gold));border-color:var(--gold);color:#241b06}
#ui .scr .btn[aria-disabled="true"],#ui .scr .btn:disabled{opacity:.38;cursor:default;box-shadow:none}
#ui .btnrow{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}

/* segmented control — the settings-menu tabs at list scale (filters, sort) */
#ui .seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--line);border-radius:8px;
  background:rgba(5,4,12,.45)}
#ui .seg button{appearance:none;-webkit-appearance:none;border:0;border-radius:6px;background:none;
  cursor:pointer;padding:6px 11px;color:var(--textdim);font:400 10px/1 var(--serif);
  font-variant:small-caps;letter-spacing:.16em;
  transition:color .16s var(--ease),background .26s var(--spring)}
#ui .seg button:hover{color:var(--text)}
#ui .seg button.on{color:#241b06;background:linear-gradient(180deg,var(--gold-hi),var(--gold))}

#ui .scr kbd{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:17px;
  padding:0 5px;margin:0 2px;border-radius:5px;vertical-align:middle;
  border:1px solid rgba(216,189,122,.4);background:rgba(9,8,20,.7);
  box-shadow:inset 0 1px 0 rgba(255,240,205,.12);
  font:400 10px/1 var(--serif);letter-spacing:.04em;text-transform:none;color:var(--gold-hi);text-shadow:none}

/* ------------------------------------------------------------------ shared bits */
#ui .say,#ui .cmpn{margin-top:9px;min-height:16px;text-align:center;font:400 11px/1.45 var(--serif);
  letter-spacing:.16em;text-transform:uppercase;color:var(--textdim)}
#ui .say[data-kind="bad"]{color:#ff9a86}
#ui .say[data-kind="good"]{color:#a8e08a}
#ui .cmpn{margin:8px 0 2px;text-align:left;letter-spacing:.12em;color:var(--textdim)}
#ui .sfoot{position:relative;display:flex;align-items:center;gap:16px;justify-content:space-between;
  margin-top:11px;padding-top:11px;border-top:1px solid rgba(216,189,122,.14)}
#ui .scr .hint{flex:1 1 auto;margin:0;text-align:left;color:rgba(232,222,196,.45);
  font:400 10px/1.7 var(--serif);letter-spacing:.24em;text-transform:uppercase}
#ui .sfoot .btn{flex:0 0 auto}
/* the corner ✕ — the thing every player's mouse goes to first */
#ui .sclose{position:absolute;right:13px;top:13px;z-index:3;width:34px;height:34px;padding:0;
  display:grid;place-items:center;cursor:pointer;border:1px solid var(--line);border-radius:9px;
  background:rgba(5,4,12,.5);color:var(--textdim);font:400 15px/1 var(--serif);
  transition:color .16s var(--ease),background .16s var(--ease),transform .2s var(--spring)}
#ui .sclose:hover{color:#fff6e0;background:rgba(224,85,52,.22);border-color:rgba(224,85,52,.5);transform:scale(1.06)}

#ui .curr{display:flex;flex-wrap:wrap;gap:6px 10px;justify-content:center;align-items:center;
  padding:7px 10px;margin-bottom:12px;border:1px solid var(--line);border-radius:8px;
  background:rgba(5,4,12,.4);font:400 12px/1 var(--serif);color:var(--text)}
#ui .curr .c{display:inline-flex;align-items:center;gap:6px;letter-spacing:.06em;padding:0 6px}
#ui .curr .c u{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--textdim);text-decoration:none}
#ui .curr .c svg{display:block}
#ui .curr .sep{width:1px;align-self:stretch;background:var(--line)}
#ui .curr .btn{padding:5px 11px;font-size:10px}

#ui .stat{display:grid;grid-template-columns:1fr auto auto;gap:1px 9px;align-items:baseline;
  padding:6px 0 5px;border-bottom:1px solid rgba(216,189,122,.10)}
#ui .stat .k{font:400 10px/1.5 var(--serif);letter-spacing:.2em;text-transform:uppercase;color:var(--textdim)}
#ui .stat .v{font:400 15px/1.2 var(--serif);letter-spacing:.03em;color:#fdf6e6;text-align:right;
  font-variant-numeric:lining-nums tabular-nums}
#ui .stat .d{font:400 11px/1.2 var(--serif);letter-spacing:.04em;min-width:44px;text-align:right;color:var(--textdim)}
#ui .stat .d.up{color:#8fdc8a}
#ui .stat .d.dn{color:#ff9a86}
#ui .stat .n{grid-column:1/-1;font:italic 400 11px/1.45 var(--serif);color:rgba(232,222,196,.5);letter-spacing:.02em}
#ui .meter{grid-column:1/-1;position:relative;height:5px;margin:5px 0 1px;border-radius:3px;
  background:rgba(255,255,255,.07);border:1px solid rgba(216,189,122,.16);overflow:visible}
#ui .meter i{display:block;height:100%;border-radius:2px;
  background:linear-gradient(90deg,#8a6119,var(--gold) 70%,var(--gold-hi));
  box-shadow:0 0 9px rgba(216,189,122,.4);transition:width .35s ease-out}
#ui .meter u{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;
  background:#ff9a86;box-shadow:0 0 5px rgba(224,85,52,.7)}
#ui .pips{display:inline-flex;gap:2px;vertical-align:middle;margin-left:7px}
#ui .pips b{width:5px;height:5px;background:rgba(255,255,255,.16);transform:rotate(45deg)}
#ui .pips b.on{background:var(--gold);box-shadow:0 0 5px rgba(216,189,122,.7)}

#ui .perk{display:flex;gap:9px;align-items:flex-start;padding:7px 0;
  border-bottom:1px solid rgba(216,189,122,.10)}
#ui .perk .g{flex:0 0 auto;margin-top:2px}
#ui .perk .t{font:400 13px/1.25 var(--serif);letter-spacing:.04em;color:#fdf6e6}
#ui .perk .s{font:400 9px/1.4 var(--serif);letter-spacing:.24em;text-transform:uppercase;color:var(--gold)}
#ui .perk .dsc{font:italic 400 12px/1.45 var(--serif);color:rgba(232,222,196,.55)}
#ui .perk.exo .t{color:var(--gold-hi)}

#ui .rar{display:inline-flex;align-items:center;gap:6px;font:400 10px/1 var(--serif);
  letter-spacing:.24em;text-transform:uppercase;color:var(--textdim)}
#ui .rar i{width:8px;height:8px;transform:rotate(45deg);background:var(--r,var(--gold));
  box-shadow:0 0 8px var(--r,var(--gold))}

#ui .scr .card{border:1px solid var(--line);border-radius:9px;padding:13px 15px;
  background:rgba(255,255,255,.028)}
#ui .scr .card h3,#ui .scr .detail h3,#ui .scr .rows h3{margin:12px 0 8px;font:400 11px/1 var(--serif);
  letter-spacing:.32em;text-transform:uppercase;color:var(--gold)}
#ui .scr .card>h3:first-child{margin-top:0}
#ui .scr .row{border-bottom:0;padding:2px 0;color:var(--text)}
#ui .scr .row span{color:var(--textdim)}
#ui .scr .xp{height:6px;border-radius:3px;background:rgba(255,255,255,.08);border:1px solid rgba(216,189,122,.2)}
#ui .scr .xp i{background:linear-gradient(90deg,#8a6119,var(--gold-hi));box-shadow:0 0 10px rgba(216,189,122,.5)}
#ui .empty{padding:22px 4px;text-align:center;font:italic 400 13px/1.7 var(--serif);color:rgba(232,222,196,.45)}

/* ------------------------------------------------------------------ item icon plate
   One plate, three sizes: bag tile, doll slot, detail header. Rarity drives the tint. */
#ui .ic{position:relative;display:grid;place-items:center;border-radius:9px;overflow:hidden;
  color:var(--r,var(--gold));
  background:rgba(6,5,14,.86);
  background:radial-gradient(ellipse at 50% 18%,color-mix(in srgb,var(--r,#d8bd7a) 20%,transparent),rgba(5,4,12,.92) 74%);
  border:1px solid rgba(216,189,122,.35);border-color:color-mix(in srgb,var(--r,#d8bd7a) 45%,transparent);
  box-shadow:inset 0 1px 0 rgba(255,240,205,.10),inset 0 -12px 20px -12px rgba(0,0,0,.9)}
#ui .ic img{width:100%;height:100%;object-fit:contain;padding:5%;
  filter:drop-shadow(0 2px 5px rgba(0,0,0,.75));-webkit-user-drag:none}
#ui .ic svg{width:62%;height:62%;filter:drop-shadow(0 1px 3px rgba(0,0,0,.8))}
#ui .ic.big{width:78px;height:78px}
#ui .ic.big svg{width:58%;height:58%}
/* empty slot: the silhouette only, pushed back so a filled slot always wins the eye */
#ui .dslot.empty .ic{background:rgba(255,255,255,.03);border-color:rgba(216,189,122,.14)}
#ui .dslot.empty .ic svg{opacity:.34}

/* ------------------------------------------------------------------ character sheet */
#ui .sheet.pane{width:min(1180px,96vw);padding:0 22px 14px}
/* character sheet: loadout | rank | armament across, Standing full width under them. Three columns is
   what a sheet this dense needs — two left half the screen empty under the loadout card. */
#ui .scr .cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}
@media (max-width:1180px){#ui .scr .cols{grid-template-columns:repeat(2,minmax(0,1fr))}}
#ui .wide{grid-column:1/-1}
#ui .wname{display:block;font:400 clamp(18px,1.9vw,24px)/1.15 var(--serif);letter-spacing:.03em;color:#fdf6e6}
#ui .wel{display:block;margin-top:4px;font:400 10px/1.4 var(--serif);letter-spacing:.24em;
  text-transform:uppercase;color:var(--textdim)}
#ui .rows.cols2{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0 22px}

#ui .dhead{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;
  padding-bottom:11px;border-bottom:1px solid rgba(216,189,122,.14)}
#ui .dhead .dh{min-width:0}
#ui .dhead .rar{margin-top:5px}
#ui .pwbig{text-align:right;font:300 30px/1 var(--serif);color:var(--gold-hi);
  font-variant-numeric:lining-nums tabular-nums}
#ui .pwbig u{display:block;margin-top:3px;font:400 9px/1 var(--serif);letter-spacing:.26em;
  text-transform:uppercase;color:var(--textdim);text-decoration:none}

/* one slot per row: in a three-column sheet a two-up grid truncates every name to three letters */
#ui .dgrid{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
#ui .dslot{appearance:none;-webkit-appearance:none;cursor:pointer;text-align:left;position:relative;
  display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-rows:auto auto;gap:1px 10px;
  align-items:center;
  padding:9px 11px;border:1px solid var(--line);border-radius:9px;color:var(--text);
  background:linear-gradient(150deg,rgba(255,255,255,.05),rgba(255,255,255,.015));
  border-left:3px solid var(--r,rgba(216,189,122,.35));
  transition:background .16s var(--ease),border-color .16s var(--ease),transform .2s var(--spring)}
#ui .dslot:hover{background:rgba(255,255,255,.09);transform:translateY(-2px)}
#ui .dslot .ic{grid-row:1/3;grid-column:1;width:50px;height:50px}
#ui .dslot .sl{grid-column:2;font:400 9px/1.3 var(--serif);letter-spacing:.24em;text-transform:uppercase;color:var(--gold);align-self:end}
#ui .dslot .nm{grid-column:2;font:400 13px/1.3 var(--serif);color:#fdf6e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;align-self:start}
#ui .dslot .pw{grid-row:1/3;grid-column:3;align-self:center;font:400 15px/1 var(--serif);color:var(--textdim);
  font-variant-numeric:lining-nums tabular-nums}
#ui .dslot.empty{opacity:.55;border-left-color:rgba(216,189,122,.18)}
#ui .dslot.empty .nm{font-style:italic;color:var(--textdim)}
#ui .dgrid .dslot:first-child{grid-column:1/-1}
#ui .dgrid .dslot:first-child .ic{width:62px;height:62px}
#ui .dgrid .dslot:first-child .nm{font-size:16px}

#ui .rankhead{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center;
  margin-bottom:10px}
#ui .rankhead .lvl{width:46px;height:46px;display:grid;place-items:center;transform:rotate(45deg);
  border:1.5px solid var(--gold);background:rgba(5,4,12,.6);color:var(--gold-hi);
  font:400 19px/1 var(--serif);box-shadow:0 0 16px rgba(216,189,122,.18)}
#ui .rankhead .lvl{font-variant-numeric:lining-nums tabular-nums}
#ui .rankhead .lvl::first-letter{display:inline-block}
#ui .rankhead .rk{display:block;min-width:0}
#ui .rankhead .rk .row{display:flex;justify-content:space-between;align-items:baseline;
  font:400 14px/1.5 var(--serif);color:var(--text)}
#ui .rankhead .rk .xp{display:block;margin-top:5px;overflow:hidden}
#ui .rankhead .rk .xp i{display:block;height:100%}
#ui .rankhead .lvl{rotate:none}

/* rotate the diamond, not the digit */
#ui .rankhead .lvl{position:relative;transform:rotate(45deg)}
#ui .rankhead .lvl>*{transform:rotate(-45deg)}

/* ------------------------------------------------------------------ inventory */
#ui .invwrap{width:min(1240px,97vw);padding:0 20px 12px}
#ui .invtop{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:11px}
#ui .invtop .spacer{flex:1 1 auto}
#ui .invtop .cap{font:400 10px/1 var(--serif);letter-spacing:.2em;text-transform:uppercase;color:var(--textdim)}
/* three columns, left to right: the figure you are dressing, the bag you are dressing it from,
   and the card that argues for the swap. The doll is a fixed-ish rail so the body slots never
   shrink below a comfortable drop target; the bag takes whatever is left. */
#ui .invcols{display:grid;grid-template-columns:minmax(244px,286px) minmax(0,1.15fr) minmax(286px,.9fr);
  gap:14px;align-items:start}
#ui .bag{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px;align-content:start}
#ui .tile.ghost{min-height:112px;border-style:dashed;border-color:rgba(216,189,122,.13);
  background:rgba(255,255,255,.012);cursor:default;pointer-events:none;box-shadow:none}
#ui .tile.ghost::before,#ui .tile.ghost::after{content:none}
#ui .tile{position:relative;appearance:none;-webkit-appearance:none;cursor:pointer;
  display:grid;justify-items:center;gap:6px;padding:10px 7px 8px;
  border:1px solid var(--line);border-radius:10px;color:var(--text);
  background:linear-gradient(160deg,rgba(255,255,255,.055),rgba(255,255,255,.012));
  transition:background .16s var(--ease),border-color .16s var(--ease),transform .2s var(--spring),
    box-shadow .18s var(--ease)}
#ui .tile::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;border-radius:10px 10px 0 0;
  background:var(--r,var(--gold));opacity:.85}
#ui .tile .ic{width:58px;height:58px}
#ui .tile .nm{font:400 12px/1.32 var(--serif);letter-spacing:.02em;color:var(--text);text-align:center;
  max-width:100%;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#ui .tile .pw{position:absolute;left:8px;top:7px;font:400 11px/1 var(--serif);color:var(--textdim);
  font-variant-numeric:lining-nums tabular-nums}
#ui .tile .dl{position:absolute;right:7px;top:6px;font:400 10px/1 var(--serif);letter-spacing:.02em}
#ui .tile .dl.up{color:#8fdc8a}
#ui .tile .dl.dn{color:#ff9a86}
#ui .tile:hover{background:rgba(255,255,255,.10);transform:translateY(-3px);
  box-shadow:0 10px 26px rgba(0,0,0,.45)}
/* the rarity colour bleeds up from the plate, so a legendary reads from across the grid */
#ui .tile::after{content:"";position:absolute;left:12%;right:12%;top:0;height:34px;pointer-events:none;
  background:radial-gradient(ellipse at 50% 0%,color-mix(in srgb,var(--r,#d8bd7a) 30%,transparent),transparent 72%);
  opacity:.75}
#ui .tile.sel{border-color:var(--gold);background:rgba(216,189,122,.10);
  box-shadow:0 0 0 1px rgba(216,189,122,.35),0 0 26px rgba(216,189,122,.16)}
#ui .detail{position:sticky;top:0;border:1px solid var(--line);border-radius:10px;padding:14px 16px;
  background:linear-gradient(160deg,rgba(255,255,255,.05),rgba(255,255,255,.015))}

/* ---- THE PAPER DOLL -----------------------------------------------------------------------
   A plain mannequin figure with the slots sitting ON the body: helm on the head,
   mantle and gauntlets at the shoulders, cuirass on the torso, greaves on the shins, and a weapon
   at each hip with a fist closed on its haft above it. The figure is behind the slots and
   pointer-events:none — the SLOTS are the interface, the drawing is the room they stand in.
   Layout runs bottom-heavy on purpose: the row the hands live in carries no plate. */
#ui .pdoll{position:relative;border:1px solid var(--line);border-radius:10px;padding:9px 9px 8px;
  background:radial-gradient(ellipse at 50% 20%,rgba(216,189,122,.10),rgba(255,255,255,.014) 68%)}
#ui .pdhd{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:7px;
  padding-bottom:6px;border-bottom:1px solid rgba(216,189,122,.14)}
#ui .pdhd span{font:400 9px/1 var(--serif);letter-spacing:.3em;text-transform:uppercase;color:var(--gold)}
#ui .pdhd b{font:400 17px/1 var(--serif);color:var(--gold-hi);font-variant-numeric:lining-nums tabular-nums}
#ui .pdhd b u{margin-left:5px;text-decoration:none;font:400 8px/1 var(--serif);letter-spacing:.24em;
  text-transform:uppercase;color:var(--textdim)}
/* row-gap is doing real work: it is the space the drawn figure shows THROUGH. Close the rows up
   and the slots tile over the figure and it vanishes, which is how this reads as six buttons
   in a box instead of a person you are dressing. */
/* ONE knob: --pdi (the icon plate) drives the plate art and, through --pdh, the whole figure box. */
/* sized off the VIEWPORT height, not off breakpoints: the panel is 93vh, so the doll has to be
   too or it hangs below the fold at every size the tiers did not name (1600x900 was exactly
   that). One clamp replaces three guesses. */
#ui .pdoll{--pdi:clamp(21px,3.1vh,29px)}
/* THE FIGURE BOX. No rows any more: slots are absolutely positioned from points in the figure's
   own viewBox (DOLL_POS in rpgscreens.js), so the plate and the body part it equips scale together
   and cannot drift apart at a different window size — which is what a uniform grid behind a
   separately-stretched SVG could only ever get right by luck, and did not.
   --pdh reproduces EXACTLY the height the old six-row grid computed (pdi*3.73 of gaps and head/
   foot room + four 84-px plate rows; 220px becomes 138.8px below 900 where the item name is
   dropped and a plate is 57 tall). Same fit at every viewport, so nothing new can fall past the
   fold. --pdw is derived from --pdh, never from the column width: that is what keeps the figure's
   PROPORTIONS constant instead of squashing him 1.33x at 1080p and 1.44x at 720p. */
#ui .pdgrid{position:relative;
  --pdh:calc(var(--pdi)*7.73 + 220px);
  --pdw:min(100%,calc(var(--pdh)*0.385));   /* 386/1003 - the supplied silhouette's true aspect */
  --pdsw:calc((100% - 12px)/3);
  height:var(--pdh);
  /* the room he stands in: aether rising off the floor, a cold key behind the shoulders, and a
     vignette that pushes the corners back so the lit slot plates come forward. Stretch-proof
     because it is all soft radials — this is why the backdrop is CSS and not more SVG. */
  background:
    /* a dark plate right where the body stands: the figure is a flat mid-violet, so the gaps in it
       (arm-to-ribs, between the legs) only read against something DARKER than the fill. */
    radial-gradient(33% 54% at 50% 46%,rgba(3,2,10,.52),transparent 72%),
    radial-gradient(62% 26% at 50% 100%,rgba(124,91,214,.26),transparent 74%),
    radial-gradient(46% 15% at 50% 101%,rgba(143,216,255,.15),transparent 76%),
    radial-gradient(60% 44% at 50% 20%,rgba(143,216,255,.13),transparent 78%),
    radial-gradient(118% 92% at 50% 44%,transparent 54%,rgba(4,3,11,.34))}
/* The figure fills the box's HEIGHT and takes its width from that height, so it keeps one shape at
   every window size. Every slot is placed from this same box (see --pdw above), which is the whole
   reason the plates now land on the anatomy instead of near it. */
/* The silhouette is the user's own PNG (public/assets/ui/doll.png), applied as a MASK so the alpha
   gives the shape and the gradient below gives the colour. The source is pure black; an <img> would
   stay black or need a filter chain to fake a tint, whereas a mask keeps one asset usable in any
   palette and costs nothing. -webkit- prefix stays for Safari, which still needs it. */
#ui .pdfig{position:absolute;top:0;left:50%;transform:translateX(-50%);
  width:var(--pdw);height:100%;
  background:linear-gradient(163deg,#6353c4 0%,#5546a6 46%,#453889 78%,#3a2f74 100%);
  -webkit-mask:url('/assets/ui/doll.png') no-repeat center/contain;
  mask:url('/assets/ui/doll.png') no-repeat center/contain;
  z-index:0;pointer-events:none;overflow:visible;
  /* TIGHT shadows only. A 14-px aether glow used to fill the wedge between arm and ribs and the gap
     between the legs, which flattened the whole silhouette into one slab — the contour IS the
     drawing here, so nothing may bleed across a gap narrower than the gap itself. */
  filter:drop-shadow(0 2px 4px rgba(0,0,0,.7))}
/* The leader from an outboard plate to the body part it names — a shoulder and a forearm are too
   narrow to carry an 84-px plate without vanishing under it, so the plate steps aside and points.
   Width is computed in the markup and clamps to zero when the anchor already falls inside the
   plate, so this draws only where it is actually needed. */
#ui .pdlk{position:absolute;height:1.5px;transform:translateY(-50%);z-index:0;pointer-events:none;
  background:linear-gradient(90deg,rgba(216,189,122,.62),rgba(216,189,122,.22))}
#ui .pdlk.r{background:linear-gradient(90deg,rgba(216,189,122,.22),rgba(216,189,122,.62))}
/* the dot is the half that does the work: a bare line reads as a stray rule, a line ending in a
   pip reads as "this plate, that body part". It sits on the BODY end, never on the plate end. */
#ui .pdlk::after{content:'';position:absolute;top:50%;right:-2px;width:5px;height:5px;
  margin-top:-2.5px;border-radius:50%;background:rgba(216,189,122,.75);
  box-shadow:0 0 6px rgba(216,189,122,.45)}
#ui .pdlk.r::after{right:auto;left:-2px}
/* On the figure a slot is placed by its ANCHOR, not by a cell: left/right/centre column comes from
   DOLL_POS.col and the vertical centre from the anchor's viewBox y. --ty:-50% is what makes the top
   offset mean "the plate's centre sits here", so the plate lands on the body part rather than beside it. */
#ui .pdgrid .pdslot{position:absolute;--ty:-50%;width:var(--pdsw);max-width:none}
#ui .pdspare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:6px}
#ui .pdhint{margin:8px 0 0;text-align:center;font:italic 400 10.5px/1.45 var(--serif);
  color:rgba(232,222,196,.45)}

/* ---- the slot BEZEL ------------------------------------------------------------------------
   Every state paints through two custom properties — --plate (the glass) and --brk (the filigree)
   — never through the background shorthand, because the shorthand would wipe the eight gradient
   layers that draw the corner brackets. Gold corner brackets in CSS, no image, no pseudo-element:
   ::before and ::after are already spent on the "▸ goes here" chip and the legality ring.
   The plate is deliberately TRANSLUCENT: the figure is behind it, and a plate you cannot see
   it through is the reason he used to read as wallpaper. */
#ui .pdslot{position:relative;z-index:1;min-width:0;width:100%;max-width:84px;justify-self:center;appearance:none;-webkit-appearance:none;cursor:pointer;
  /* --ty is the slot's own resting transform: 0 in the spare row, -50% on the figure where the
     plate is centred on its anchor point. --lift is the hover/drag nudge, subtracted so the
     hover rules never have to restate the whole transform (and never fight the anchor). */
  --ty:0px;--lift:0px;transform:translateY(calc(var(--ty) - var(--lift)));
  /* .74 is the most glass this can give up before the item name stops sitting cleanly on it;
     hover/on/drag states still go opaque on top of it. The figure reads through it: the head, the
     sternum and the shins are DIRECTLY behind their plates now, and that is deliberate — the parts
     too narrow to survive it (shoulder, forearm) sit outboard with a leader instead. Lowering it
     further would only buy a ghost, and would cost the one thing every slot has to keep: its name. */
  --plate:rgba(11,9,24,.74);--plate2:rgba(7,5,17,.55);--brk:rgba(216,189,122,.44);
  display:grid;justify-items:center;align-content:start;gap:2px;padding:6px 4px 5px;
  border:1px solid color-mix(in srgb,var(--r,#d8bd7a) 30%,rgba(216,189,122,.20));
  border-radius:9px;color:var(--text);
  background:
    linear-gradient(var(--brk),var(--brk)) left 4px top 4px/10px 1.4px no-repeat,
    linear-gradient(var(--brk),var(--brk)) left 4px top 4px/1.4px 10px no-repeat,
    linear-gradient(var(--brk),var(--brk)) right 4px top 4px/10px 1.4px no-repeat,
    linear-gradient(var(--brk),var(--brk)) right 4px top 4px/1.4px 10px no-repeat,
    linear-gradient(var(--brk),var(--brk)) left 4px bottom 4px/10px 1.4px no-repeat,
    linear-gradient(var(--brk),var(--brk)) left 4px bottom 4px/1.4px 10px no-repeat,
    linear-gradient(var(--brk),var(--brk)) right 4px bottom 4px/10px 1.4px no-repeat,
    linear-gradient(var(--brk),var(--brk)) right 4px bottom 4px/1.4px 10px no-repeat,
    radial-gradient(128% 92% at 50% 0%,color-mix(in srgb,var(--r,#d8bd7a) 16%,transparent),transparent 66%),
    linear-gradient(168deg,var(--plate),var(--plate2));
  border-bottom:2px solid var(--r,rgba(216,189,122,.3));
  box-shadow:inset 0 1px 0 rgba(255,240,205,.10),0 3px 10px rgba(0,0,0,.45);
  transition:background-color .16s var(--ease),border-color .16s var(--ease),transform .2s var(--spring),
    box-shadow .18s var(--ease)}
#ui .pdslot:hover{--plate:rgba(34,27,64,.88);--plate2:rgba(18,14,38,.72);--brk:var(--gold-hi);
  --lift:2px;box-shadow:inset 0 1px 0 rgba(255,240,205,.16),0 6px 16px rgba(0,0,0,.55)}
#ui .pdslot.on{--plate:rgba(52,40,20,.86);--plate2:rgba(28,21,12,.70);--brk:var(--gold-hi);
  border-color:var(--gold);box-shadow:0 0 0 1px rgba(216,189,122,.3)}
#ui .pdslot .ic{width:var(--pdi);height:var(--pdi)}
#ui .pdslot .sl,#ui .pdslot .nm{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ui .pdslot .sl{font:400 8px/1.3 var(--serif);letter-spacing:.18em;text-transform:uppercase;color:var(--gold)}
#ui .pdslot .nm{font:400 10.5px/1.25 var(--serif);color:#fdf6e6}
#ui .pdslot.empty .nm{font-style:italic;color:var(--textdim)}
#ui .pdslot .pw{font:400 11px/1 var(--serif);color:var(--textdim);
  font-variant-numeric:lining-nums tabular-nums}
/* an empty slot is a SOCKET, not a dimmer copy of a full one: recessed, cold, no filigree lit.
   Filled slots are frames with the light on. Two different objects, one glance apart. */
#ui .pdslot.empty{--plate:rgba(5,4,13,.74);--plate2:rgba(3,2,9,.62);--brk:rgba(216,189,122,.13);
  opacity:.8;border-color:rgba(216,189,122,.13);border-bottom-color:rgba(216,189,122,.16);
  box-shadow:inset 0 4px 10px rgba(0,0,0,.8),inset 0 -1px 0 rgba(255,255,255,.03)}
#ui .pdslot.empty:hover{--brk:rgba(216,189,122,.5)}
#ui .pdslot.empty .ic{background:rgba(255,255,255,.03);border-color:rgba(216,189,122,.16);
  box-shadow:inset 0 2px 6px rgba(0,0,0,.7)}
#ui .pdslot.empty .ic svg{opacity:.34}
#ui .pdslot .dl{position:absolute;right:3px;top:3px;font:400 10px/1 var(--serif);color:#8fdc8a;
  text-shadow:0 0 8px rgba(143,220,138,.5)}
/* the gun actually in your hands right now — the one fact a single-slot loadout could not express */
#ui .pdslot.held{border-color:rgba(216,189,122,.55)}
#ui .pdslot .hd{position:absolute;left:50%;top:-7px;transform:translateX(-50%);z-index:2;
  padding:1px 5px;border-radius:5px;background:#0b0a1a;border:1px solid rgba(216,189,122,.55);
  font:400 7.5px/1.4 var(--serif);letter-spacing:.16em;text-transform:uppercase;color:var(--gold-hi);
  white-space:nowrap;pointer-events:none}
#ui .pdslot.okfree .hd{display:none}

/* ---- "where does this go" — three strengths of ONE language, never two treatments -----------
   1. .ok / .okfree  — the standing answer for whatever the bag is SHOWING you (hovered tile, or
      the arrow-key pick when there is no mouse). Warm gold, a soft ring: could go here.
      .okfree is the empty-slot case: nothing to give up, so it reads as a win, not a trade.
   2. .dragok        — you have actually picked it up. Same gold, solid and brighter: still legal.
   3. .over          — the pointer is on it. Filled: let go and it lands here.
   .dragno is the refusal. This is DOM, not the scene — glow is free here and cannot bloom. */
#ui .pdslot.ok,#ui .pdslot.okfree{opacity:1;border-color:rgba(216,189,122,.7);--brk:var(--gold-hi);
  box-shadow:0 0 0 1px rgba(216,189,122,.35),0 0 18px rgba(216,189,122,.22)}
#ui .pdslot.ok::after,#ui .pdslot.okfree::after{content:'';position:absolute;inset:-3px;border-radius:11px;
  border:1px dashed rgba(216,189,122,.6);pointer-events:none}
/* an empty slot is a free upgrade — say so in the same ▲ green the tiles already use for a gain */
#ui .pdslot.okfree{border-color:#8fdc8a;--brk:#a8e6a2;
  box-shadow:0 0 0 1px rgba(143,220,138,.4),0 0 22px rgba(143,220,138,.26)}
#ui .pdslot.okfree::after{border-color:rgba(143,220,138,.65)}
/* the slot a bare equip (E, right-click, the one big button) would take — lit harder than the
   other legal one, and labelled, because right-click is instant and otherwise unexplained */
#ui .pdslot.okpick{border-color:var(--gold-hi);
  box-shadow:0 0 0 2px rgba(216,189,122,.45),0 0 24px rgba(216,189,122,.3)}
#ui .pdslot.okpick::after{border-color:rgba(216,189,122,.8)}
#ui .pdslot.ok.okpick::before,#ui .pdslot.okfree::before{position:absolute;left:50%;top:-8px;
  transform:translateX(-50%);z-index:2;padding:1px 5px;border-radius:5px;background:#0b0a1a;
  font:400 8px/1.3 var(--serif);letter-spacing:.14em;text-transform:uppercase;pointer-events:none;
  white-space:nowrap}
#ui .pdslot.ok.okpick::before{content:'▸ goes here';border:1px solid rgba(216,189,122,.6);color:var(--gold-hi)}
#ui .pdslot.okfree::before{content:'▲ free';border:1px solid rgba(143,220,138,.5);color:#8fdc8a}
#ui .pdslot.dragok{opacity:1;border-color:var(--gold-hi);--brk:var(--gold-hi);
  box-shadow:0 0 0 2px rgba(216,189,122,.6),0 0 26px rgba(216,189,122,.34)}
#ui .pdslot.dragok::after{content:'';position:absolute;inset:-3px;border-radius:11px;
  border:1px solid rgba(216,189,122,.75);pointer-events:none}
#ui .pdslot.dragok.over{--plate:rgba(216,189,122,.34);--plate2:rgba(216,189,122,.14);
  --lift:3px;transform:translateY(calc(var(--ty) - var(--lift))) scale(1.04);
  box-shadow:0 0 0 2px var(--gold-hi),0 0 34px rgba(216,189,122,.5)}
/* the refusal has to be READABLE — fading the whole slot fades the ✕ with it, which is how a
   "you cannot put it there" ends up looking like nothing happened. Dim the CONTENTS, mark the box. */
#ui .scr.dragging .pdslot.dragno{border-color:rgba(224,85,52,.4);--brk:rgba(224,85,52,.3);
  --plate:rgba(48,13,8,.55);--plate2:rgba(30,8,5,.5);cursor:not-allowed;box-shadow:none}
#ui .scr.dragging .pdslot.dragno>*{opacity:.2;filter:grayscale(1)}
#ui .scr.dragging .pdslot.dragno::after{content:'✕';position:absolute;inset:0;display:grid;place-items:center;
  font:400 22px/1 var(--serif);color:rgba(255,154,134,.85);pointer-events:none;
  text-shadow:0 1px 6px rgba(0,0,0,.9)}
#ui .scr.dragging .tile:not(.ghost){opacity:.55}
#ui .scr.dragging .pdfig,#ui .scr.dragging .pdlk{opacity:.35}
/* the sheet's paper doll carries the same badge, under the power number */
#ui .dslot .pw .dl{display:block;margin-top:4px;font:400 10px/1 var(--serif);color:#8fdc8a}
#ui .dslot.has{border-left-color:#8fdc8a}

/* ---- the comparison, printed where the decision is made -------------------------------- */
/* every slot the item could go into, racked — a new gun against BOTH of yours at once, which is
   the decision. One row is the armour case and reads exactly as it did before. */
#ui .cmpset{margin-top:11px}
#ui .cmphd{margin-bottom:5px;font:400 9px/1.4 var(--serif);letter-spacing:.24em;text-transform:uppercase;
  color:var(--gold)}
#ui .cmpset .cmpbar+.cmpbar{margin-top:6px}
#ui .cmpbar.pick{border-color:rgba(216,189,122,.5);background:rgba(216,189,122,.09)}
#ui .cmpbar .mv{grid-column:2/-1;display:flex;flex-wrap:wrap;gap:3px 10px;margin-top:2px;
  font:400 10px/1.3 var(--serif);letter-spacing:.03em}
#ui .cmpbar .mv b{font-weight:400}
#ui .cmpbar .mv b.up{color:#8fdc8a}
#ui .cmpbar .mv b.dn{color:#ff9a86}
#ui .cmpbar{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:2px 10px;align-items:center;
  margin:11px 0 0;padding:7px 10px;border:1px solid var(--srule);border-radius:9px;
  border-left:3px solid var(--r,rgba(216,189,122,.35));background:rgba(6,5,14,.5)}
#ui .cmpbar .ic{width:34px;height:34px}
#ui .cmpbar .lb{min-width:0;font:400 13px/1.25 var(--serif);color:#fdf6e6;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ui .cmpbar .lb u{display:block;font:400 8.5px/1.4 var(--serif);letter-spacing:.24em;
  text-transform:uppercase;color:var(--textdim);text-decoration:none}
#ui .cmpbar .to{font:400 14px/1 var(--serif);color:var(--gold-hi);white-space:nowrap;
  font-variant-numeric:lining-nums tabular-nums}
#ui .cmpbar .d{font:400 13px/1 var(--serif);min-width:34px;text-align:right;color:var(--textdim)}
#ui .cmpbar .d.up{color:#8fdc8a}
#ui .cmpbar .d.dn{color:#ff9a86}
#ui .cmpbar.on{grid-template-columns:minmax(0,1fr) auto;opacity:.75}

/* ---- EQUIP: the most common action in the screen, sized like it ------------------------ */
#ui .btnrow.prime{margin:10px 0 0}
#ui .scr .btn.equip{flex:1 1 100%;justify-content:center;padding:11px 18px;
  font-size:12px;letter-spacing:.26em;
  box-shadow:0 6px 20px rgba(216,189,122,.22),inset 0 1px 0 rgba(255,246,220,.5)}
#ui .scr .btn.equip[disabled]{box-shadow:none}
#ui .blocked{margin-top:6px;text-align:center;font:italic 400 11px/1.5 var(--serif);
  color:rgba(255,154,134,.75)}
#ui .blocked.ok{color:rgba(232,222,196,.5)}
/* two guns = two buttons: "Equip" that silently overwrote whichever one was in hand is the bug
   this replaces, so the player names the hand. The gold one is the slot it gains most in. */
#ui .btnrow.prime.split{gap:7px}
#ui .btnrow.prime.split .btn.equip{flex:1 1 0;min-width:0;flex-direction:column;gap:3px;
  padding:9px 8px;letter-spacing:.16em}
#ui .btnrow.prime.split .btn.equip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
#ui .btnrow.prime.split .btn.equip b{font:400 12px/1 var(--serif);letter-spacing:.04em}
#ui .btnrow.prime.split .btn.equip b.up{color:#3f7a2f}
#ui .btnrow.prime.split .btn.equip b.dn{color:#ff9a86}
#ui .btnrow.prime.split .btn.equip:not(.gold) b.up{color:#8fdc8a}
/* the hover preview: same card, one caption, so it can never be mistaken for the picked item */
#ui .detail.preview{border-color:rgba(143,216,255,.4);box-shadow:0 0 0 1px rgba(143,216,255,.18)}
#ui .pvtag{margin:-4px 0 8px;text-align:center;font:400 9px/1.4 var(--serif);letter-spacing:.22em;
  text-transform:uppercase;color:var(--aether)}
#ui .scr .btn.upsbadge{padding:6px 12px;font-size:9.5px;letter-spacing:.18em}

/* Any window shorter than a tall desktop: EQUIP has to be reachable WITHOUT scrolling — it is the
   action the screen exists for — and the paper doll has to fit whole, greaves included. Everything
   in the detail column gives up height first, and the doll drops its one line of prose. 900, not
   800: at 810 the doll still hung past the fold, and a rule that only covers the sizes you happened
   to screenshot is not a rule. */
@media (max-height:900px){
  #ui .curr{margin-bottom:7px}
  #ui .invtop{margin-bottom:7px}
  /* 720p: the doll is the tall thing on this screen, so it gives up height first — smaller
     plates, tighter rows, no hint line. Nothing is removed and every slot stays a real target. */
  #ui .pdoll{padding:5px 6px 4px}
  #ui .pdslot{padding:3px 3px 4px}
  /* the item NAME is the line that goes: at 720p the doll would otherwise be taller than the
     panel body and the greaves would sit below the fold — which is the exact bug the character
     sheet's Loadout card already has. Art + slot + power + the upgrade badge still identify a
     slot (this is what every paper doll shows); the full name is on hover and in the card. */
  #ui .pdslot .nm{display:none}
  #ui .pdgrid{--pdh:calc(var(--pdi)*7.73 + 138.8px)}
  #ui .pdslot .pw{font-size:11px}
  #ui .pdslot .sl{font-size:7.5px}
  #ui .pdhd{margin-bottom:4px;padding-bottom:3px}
  #ui .pdhd b{font-size:14px}
  #ui .pdhint{display:none}
  #ui .cmpset{margin-top:8px}
  #ui .cmpbar .mv{font-size:9.5px}
  #ui .detail{padding:11px 14px}
  #ui .detail .ic.big{width:56px;height:56px}
  #ui .detail .dhead{padding-bottom:8px}
  #ui .detail .wname{font-size:19px}
  #ui .cmpbar{margin-top:8px;padding:5px 9px}
  /* the character sheet's Loadout is SEVEN rows now that both guns are modelled — at 720p that
     card scrolled, so it pairs up into two columns instead (the weapon no longer eats a full row
     on its own; the two hands sit side by side, which is also how the doll reads them). */
  #ui .dgrid{grid-template-columns:repeat(2,minmax(0,1fr))}
  #ui .dgrid .dslot:first-child{grid-column:auto}
  #ui .dgrid .dslot{padding:6px 8px}
  #ui .dgrid .dslot .ic,#ui .dgrid .dslot:first-child .ic{width:34px;height:34px}
  /* half the width means the name has to wrap instead of eliding to "Daw…" */
  #ui .dgrid .dslot .nm,#ui .dgrid .dslot:first-child .nm{white-space:normal;font-size:12px;
    line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  #ui .dgrid .dslot .pw{font-size:13px}
  #ui .dslot{padding:6px 10px}
  #ui .dslot .ic{width:42px;height:42px}
  #ui .dslot .pw .dl{display:inline;margin:0 0 0 6px}
  #ui .scr .card h3,#ui .scr .detail h3,#ui .scr .rows h3{margin:9px 0 6px}
  #ui .btnrow{margin-top:8px}
  #ui .cmpbar .ic{width:28px;height:28px}
  #ui .btnrow.prime{margin-top:8px}
  #ui .scr .btn.equip{padding:9px 14px}
}
/* Below a laptop's height the two compare rows are what pushes EQUIP under the fold — the per-stat
   movers go first (the power swing on each row still says which gun loses), never the rows. */
@media (max-height:700px){
  #ui .cmpbar .mv{display:none}
  #ui .cmpset .cmpbar+.cmpbar{margin-top:4px}
  #ui .cmpbar{padding:4px 9px}
  #ui .cmphd{margin-bottom:3px}
}
@media (max-height:620px){
  #ui .cmpbar .ic{width:28px;height:28px}
  #ui .scr .btn.equip{padding:9px 14px}
}
/* narrow: the three columns stack, so the figure goes wide and the slots spread across it */
@media (max-width:900px){
  #ui .invcols{grid-template-columns:minmax(0,1fr)}
  #ui .pdgrid{max-width:320px;margin:0 auto}
}

/* ------------------------------------------------------------------ skills */
#ui .skillwrap{width:min(1180px,96vw);padding:0 20px 12px}
#ui .branches{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}
#ui .branch{border:1px solid var(--line);border-radius:10px;padding:12px 13px 13px;
  background:rgba(255,255,255,.028)}
#ui .branch>h3{margin:0 0 3px;font:400 11px/1.3 var(--serif);letter-spacing:.3em;text-transform:uppercase;color:var(--gold)}
#ui .branch>p{margin:0 0 11px;font:italic 400 11px/1.5 var(--serif);color:rgba(232,222,196,.5)}
#ui .node{position:relative;border:1px solid var(--line);border-radius:8px;padding:9px 11px;margin-bottom:8px;
  background:rgba(255,255,255,.03)}
#ui .node .nh{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
#ui .node .nn{font:400 15px/1.2 var(--serif);letter-spacing:.03em;color:#fdf6e6}
#ui .node .nc{font:400 9px/1.3 var(--serif);letter-spacing:.2em;text-transform:uppercase;color:var(--textdim);white-space:nowrap}
#ui .node .nd{margin-top:4px;font:italic 400 12px/1.5 var(--serif);color:rgba(232,222,196,.6)}
#ui .node.own{background:linear-gradient(180deg,rgba(216,189,122,.20),rgba(216,189,122,.06));
  border-color:var(--gold-dim);box-shadow:inset 0 0 26px rgba(216,189,122,.12)}
#ui .node.own .nn::after{content:' ✦';color:var(--gold)}
#ui .node.can{border-color:var(--gold-dim);box-shadow:0 0 0 1px rgba(216,189,122,.18),0 0 20px rgba(216,189,122,.14)}
#ui .node.lock{opacity:.6}
#ui .node.gone{opacity:.4}
#ui .node.gone .nn{text-decoration:line-through}
#ui .why{margin-top:7px;font:400 10px/1.4 var(--serif);letter-spacing:.14em;text-transform:uppercase;color:#ff9a86}
#ui .node.own .why{color:#a8e08a}
#ui .fork{position:relative;border:1px dashed rgba(216,189,122,.4);border-radius:8px;
  padding:17px 8px 4px;margin:15px 0 8px}
#ui .fork::before{content:'EITHER / OR — CHOOSE ONE';position:absolute;top:-8px;left:10px;
  padding:0 7px;background:#0d0b1c;font:400 9px/1.6 var(--serif);letter-spacing:.24em;color:#ff9a86}
#ui .fork .node{margin-bottom:8px}
#ui .ptbanner{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;
  padding:9px 12px;margin:12px 0 0;border:1px solid var(--line);border-radius:9px;
  background:linear-gradient(180deg,rgba(216,189,122,.13),rgba(255,255,255,.02));
  font:400 11px/1.3 var(--serif);letter-spacing:.2em;text-transform:uppercase;color:var(--text)}
#ui .ptbanner b{font-weight:400;font-size:20px;letter-spacing:.04em;color:var(--gold-hi);
  font-variant-numeric:lining-nums tabular-nums}
#ui .skillwrap .ptbanner{margin:0 0 12px}

/* ------------------------------------------------------------------ quest log (J)
   A read screen, not a list screen: the whole point (CLAUDE.md decree, quests are read never
   spoken) is that the written text has to be pleasant at length. Comfortable measure (~62ch),
   the house serif, tabular-nums counters so a run of "3 / 8" stacks lines up like a ledger. */
#ui .qlog{display:flex;flex-direction:column;gap:16px}
#ui .qsec>h3{margin:0 0 9px}
#ui .qsec+.qsec{margin-top:2px;padding-top:14px;border-top:1px solid rgba(216,189,122,.14)}
/* a region group inside "The Chain" — the label is why two very-different-level cards are
   allowed to sit next to each other (see chainSection's doc-comment) */
#ui .qgroup+.qgroup{margin-top:16px}
#ui .qgroup>h4{display:flex;align-items:center;gap:10px;margin:0 0 8px;
  font:400 10px/1 var(--serif);letter-spacing:.28em;text-transform:uppercase;color:var(--textdim)}
#ui .qgroup>h4::after{content:'';flex:1 1 auto;height:1px;background:linear-gradient(90deg,rgba(216,189,122,.35),transparent)}
#ui .qcard{border:1px solid var(--line);border-radius:9px;padding:13px 16px 14px;margin-bottom:10px;
  background:rgba(255,255,255,.028);border-left:3px solid var(--gold-dim)}
#ui .qcard:last-child{margin-bottom:0}
#ui .qcard.qdone{border-left-color:var(--aether);opacity:.82}
#ui .qhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
#ui .qname{font:400 18px/1.3 var(--serif);letter-spacing:.03em;color:#fdf6e6}
#ui .qtick{flex:none;font:400 10px/1 var(--serif);letter-spacing:.16em;text-transform:uppercase;color:var(--aether)}
#ui .qmeta{margin-top:3px;font:400 10.5px/1.5 var(--serif);letter-spacing:.16em;text-transform:uppercase;color:var(--textdim)}
#ui .qobjs{margin-top:10px;display:flex;flex-direction:column;gap:4px}
#ui .qobj{display:flex;align-items:baseline;gap:8px;font:400 13.5px/1.4 var(--serif);color:var(--text)}
#ui .qobj i{flex:none;width:12px;text-align:center;font-style:normal;color:var(--gold)}
#ui .qobj .ot{flex:1;min-width:0}
#ui .qobj .oc{flex:none;font-variant-numeric:lining-nums tabular-nums;color:var(--gold-hi);font-size:12.5px}
#ui .qobj.done{opacity:.6}
#ui .qobj.done i{color:var(--aether)}
#ui .qobj.done .ot{text-decoration:line-through}
/* prose (left) + a facts rail (right) — the rail is what used to be dead space beside a ~62ch
   paragraph in a ~1170px card; giving it chain position + reward makes the measure read as a
   deliberate column instead of a wrapping bug. Collapses to one column on a narrow viewport. */
#ui .qbody{display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:20px;align-items:start;
  margin-top:11px;padding-top:10px;border-top:1px solid rgba(216,189,122,.10)}
#ui .qmain{min-width:0}
#ui .qside{display:flex;flex-direction:column;gap:12px;padding-left:18px;border-left:1px solid rgba(216,189,122,.14)}
#ui .qchain{display:flex;flex-direction:column;gap:2px}
#ui .qchain .k{font:400 9px/1 var(--serif);letter-spacing:.28em;text-transform:uppercase;color:var(--textdim)}
#ui .qchain .v{font:400 21px/1.2 var(--serif);color:var(--gold-hi);font-variant-numeric:lining-nums tabular-nums}
#ui .qchain .v i{margin:0 4px;font:italic 400 12px/1 var(--serif);color:var(--textdim)}
#ui .qchain .rgn{margin-top:2px;font:400 10px/1.4 var(--serif);letter-spacing:.1em;color:var(--textdim)}
#ui .qtext{margin-top:0}
#ui .qmain:empty{display:none}
#ui .qstage{max-width:62ch;margin:0 0 8px;font:400 14px/1.65 var(--serif);color:rgba(232,222,196,.55);letter-spacing:.01em}
#ui .qstage:last-child{margin-bottom:0}
#ui .qstage b{display:block;margin-bottom:2px;font:400 9.5px/1 var(--serif);letter-spacing:.28em;text-transform:uppercase;color:var(--textdim)}
#ui .qstage.cur{color:var(--text)}
#ui .qstage.cur b{color:var(--gold)}
#ui .qside .qreward{margin-top:0;padding-top:10px;border-top:1px solid rgba(216,189,122,.10)}
#ui .qreward{margin-top:10px;font:400 11.5px/1.4 var(--serif);letter-spacing:.06em;color:var(--gold-hi)}
@media (max-width:760px){
  #ui .qbody{grid-template-columns:minmax(0,1fr)}
  #ui .qside{flex-direction:row;flex-wrap:wrap;gap:16px;padding-left:0;padding-top:10px;
    border-left:0;border-top:1px solid rgba(216,189,122,.14)}
}
@media (max-height:620px){#ui .qname{font-size:15px}#ui .qstage{font-size:12.5px}}

/* ------------------------------------------------------------------ reward choice
   Two or three real rolled items, racked side by side with their deltas against what is already
   on you. Same card in two places — under an accepted quest in the log, and blown up in the
   turn-in picker — because the thing you were deciding on has to be the thing you are handed. */
#ui .qchoice{margin-top:12px;padding-top:10px;border-top:1px solid rgba(216,189,122,.10)}
#ui .qchoice>h4{display:flex;align-items:center;gap:10px;margin:0 0 8px;
  font:400 9.5px/1 var(--serif);letter-spacing:.28em;text-transform:uppercase;color:var(--gold)}
#ui .qchoice>h4::after{content:'';flex:1 1 auto;height:1px;background:linear-gradient(90deg,rgba(216,189,122,.30),transparent)}
#ui .rgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;align-items:start}
#ui .rgrid.big{grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
#ui .rcard{position:relative;border:1px solid var(--line);border-top:2px solid var(--r);border-radius:9px;
  padding:10px 12px 12px;background:rgba(255,255,255,.035);display:flex;flex-direction:column;gap:8px}
#ui .rgrid.big .rcard{padding:16px 18px 18px;gap:12px}
#ui .rhead{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center}
#ui .rcard .ic{width:46px;height:46px;color:var(--r)}
#ui .rgrid.big .rcard .ic{width:66px;height:66px}
#ui .rh{display:flex;flex-direction:column;gap:2px;min-width:0}
#ui .rn{font:400 14.5px/1.25 var(--serif);letter-spacing:.02em;color:#fdf6e6;overflow-wrap:anywhere}
#ui .rgrid.big .rn{font-size:17px}
#ui .rr{display:flex;align-items:center;gap:5px;font:400 9.5px/1 var(--serif);letter-spacing:.2em;
  text-transform:uppercase;color:var(--r)}
#ui .rr i{width:6px;height:6px;border-radius:50%;background:var(--r);box-shadow:0 0 6px var(--r)}
#ui .rm{font:400 10.5px/1.4 var(--serif);letter-spacing:.06em;color:var(--textdim)}
#ui .rpw{display:flex;flex-direction:column;align-items:flex-end;font:400 21px/1 var(--serif);
  color:var(--gold-hi);font-variant-numeric:lining-nums tabular-nums}
#ui .rpw u{text-decoration:none;font:400 8.5px/1 var(--serif);letter-spacing:.24em;text-transform:uppercase;
  color:var(--textdim);margin-top:3px}
#ui .rpw b{font:400 10.5px/1 var(--serif);letter-spacing:.04em;margin-top:4px}
#ui .rpw b.up{color:#8fdc8a}
#ui .rpw b.dn{color:#ff9a86}
#ui .rcard .cmpn{font:italic 400 10.5px/1.4 var(--serif);color:rgba(232,222,196,.5)}
#ui .rcard .btn{align-self:stretch;justify-content:center}
/* the picker itself: one question, three answers, nothing else on the page */
#ui .rpick{display:flex;flex-direction:column;gap:4px;padding:4px 2px 8px}
#ui .rpq{font:400 22px/1.3 var(--serif);letter-spacing:.03em;color:#fdf6e6}
#ui .rpn{margin:0 0 12px;font:italic 400 13px/1.6 var(--serif);color:rgba(232,222,196,.62)}
@media (max-width:760px){#ui .rgrid,#ui .rgrid.big{grid-template-columns:minmax(0,1fr)}}

/* ------------------------------------------------------------------ map
   A square sheet that fills whatever height the viewport actually has. The parchment stays
   parchment — it is a map on a table inside a dark frame, the same read as the HUD minimap. */
#ui .mapwrap{position:relative;padding:0 16px 10px;overflow:hidden;
  height:calc(100vh - 24px);width:min(96vw,calc(100vh - 24px));
  height:calc(100dvh - 24px);width:min(96vw,calc(100dvh - 24px))}
#ui .mapbox{position:relative;flex:1 1 auto;min-height:0}
#ui .mapbox canvas{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:block;
  border:1px solid var(--gold-dim);border-radius:6px;
  box-shadow:inset 0 0 60px rgba(120,88,38,.4),0 8px 30px rgba(0,0,0,.55);
  cursor:grab;touch-action:none}
#ui .mapbox canvas:active{cursor:grabbing}
#ui .legend{display:flex;gap:8px 18px;flex-wrap:wrap;justify-content:center;align-items:center;margin-top:9px;
  font:400 10px/1 var(--serif);letter-spacing:.2em;text-transform:uppercase;color:var(--textdim)}
#ui .legend span{display:inline-flex;align-items:center;gap:6px}
#ui .legend i{display:none}
#ui .legend svg{display:block;flex:0 0 auto}

/* ------------------------------------------------------------------ tight viewports */
@media (max-height:820px){
  #ui .sheet.pane,#ui .invwrap,#ui .skillwrap{padding:0 16px 10px}
  #ui .shead{padding-top:12px}
  #ui .stabs{margin:10px auto 9px}
  #ui .scr .card{padding:10px 12px}
  #ui .scr .hint{margin-top:9px}
}
@media (max-width:620px){
  #ui .sfoot{flex-wrap:wrap;gap:8px}
}
@media (max-height:620px){
  #ui .sclose{width:28px;height:28px;right:9px;top:9px}
  #ui .scr .ttl{font-size:18px;letter-spacing:.26em;text-indent:.26em}
  #ui .shead .mflourish{margin-top:8px}
  #ui .shead .kick{display:none}
  #ui .sheet.pane,#ui .invwrap,#ui .skillwrap,#ui .mapwrap{padding:0 12px 7px}
  #ui .scr .hint{margin-top:6px;line-height:1.5}
  #ui .curr{margin-bottom:8px;padding:5px 8px}
  #ui .scr .cols,#ui .invcols,#ui .branches{gap:10px}
  #ui .say{margin-top:6px}
  #ui .tile .ic{width:42px;height:42px}
  #ui .bag{grid-template-columns:repeat(auto-fill,minmax(92px,1fr))}
}
@media (max-height:470px){
  #ui .scr .ttl{font-size:15px}
  #ui .scr .hint{font-size:9px;letter-spacing:.18em}
  #ui .wname{font-size:16px}
}
@media (max-height:640px){
  #ui .mapwrap>.legend{gap:2px 12px;margin-top:5px;font-size:9px;letter-spacing:.12em}
  #ui .mapwrap>.legend svg{width:11px;height:11px}
  #ui .mapwrap>.say{margin-top:3px;min-height:12px;font-size:9px;letter-spacing:.1em}
  #ui .mapwrap>.hint{margin-top:3px;font-size:9px;letter-spacing:.14em;line-height:1.5}
  #ui .mapwrap kbd{height:15px;min-width:16px;padding:0 4px;margin:0 2px;font-size:9px}
}
@media (max-width:1000px){
  #ui .invcols{grid-template-columns:minmax(0,1fr)}
  #ui .branches{grid-template-columns:minmax(0,1fr)}
  #ui .scr .cols{grid-template-columns:minmax(0,1fr)}
  #ui .detail{position:static}
  #ui .dgrid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (prefers-reduced-motion:reduce){
  #ui .meter i{transition:none}
  #ui .tile,#ui .dslot,#ui .scr .btn{transition:none}
}
`;
