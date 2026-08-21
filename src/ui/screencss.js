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
#ui .invcols{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(320px,.95fr);gap:16px;align-items:start}
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
#ui .tile.worn::after{content:"EQUIPPED";left:0;right:0;top:auto;height:auto;background:rgba(216,189,122,.9)}
#ui .tile.sel{border-color:var(--gold);background:rgba(216,189,122,.10);
  box-shadow:0 0 0 1px rgba(216,189,122,.35),0 0 26px rgba(216,189,122,.16)}
#ui .tile.worn::after{content:"EQUIPPED";position:absolute;left:0;right:0;bottom:-1px;padding:2px 0;
  border-radius:0 0 9px 9px;background:rgba(216,189,122,.9);color:#241b06;
  font:400 8px/1.4 var(--serif);letter-spacing:.16em;text-align:center}
#ui .tile.worn{padding-bottom:18px}
#ui .detail{position:sticky;top:0;border:1px solid var(--line);border-radius:10px;padding:14px 16px;
  background:linear-gradient(160deg,rgba(255,255,255,.05),rgba(255,255,255,.015))}

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
